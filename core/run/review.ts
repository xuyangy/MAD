/**
 * Pipeline assembly — the one seam a caller drives (AD-1: the entrypoint
 * injects the adapters' port implementations; the core knows no harness).
 *
 * Story 6 runs all six filters: discover -> cluster -> route -> debate -> judge ->
 * output. The judge was inserted between the last two WITHOUT changing this
 * signature, exactly as story 5 predicted it would be, and story 9's ablation
 * calls this function directly as the single-model control arm — no second code
 * path.
 */

import type { Roster } from "../domain/roster.ts"
import { clampTokenCap } from "../budget/ledger.ts"
import { emptyLedger, type RunRecord } from "../domain/run-record.ts"
import type { Warning } from "../domain/warning.ts"
import { resolveInstructions } from "../instructions/registry.ts"
import type { InstructionSet } from "../instructions/types.ts"
import type { Clock } from "../ports/clock.ts"
import type { ModelBackend } from "../ports/model-backend.ts"
import type { ChangeSet } from "../ports/repo.ts"
import { fenceFor, listCell, material, oneLine } from "../prompt/material.ts"
import { cluster } from "../stages/cluster.ts"
import { clampMaxRounds, debate } from "../stages/debate.ts"
import { discover } from "../stages/discover.ts"
import { judge } from "../stages/judge.ts"
import { output } from "../stages/output.ts"
import { clampThreshold, route } from "../stages/route.ts"

export interface ReviewDeps {
  roster: Roster
  backend: ModelBackend
  clock: Clock
  /** The change under review, already read through the `Repo` port. */
  change: ChangeSet
  /** Warnings raised before the pipeline started — the roster's (AD-6c). */
  priorWarnings?: Warning[]
  /** AD-11 — versioned instruction set; defaulted, never inlined at a call site. */
  instructions?: InstructionSet
  /**
   * CAP-3 — the co-discovery threshold, the paranoia dial (`cost-model.md`).
   * Defaulted and clamped by the route stage. This seam is deliberately the only
   * way to move it in story 4: `cost-model.md` puts ONE budget number and a
   * `quick | normal | paranoid` preset in front of the user, and story 8 owns
   * that surface. Story 9's ablation drives `review()` directly, so nothing that
   * needs the dial today is missing it.
   */
  threshold?: number
  /**
   * CAP-4 — the debate round cap. Defaulted and clamped by the debate stage.
   *
   * This seam is deliberately the only way to move it, for the reason story 4
   * recorded for `threshold`: `cost-model.md` puts ONE budget number and a
   * `quick | normal | paranoid` preset in front of the user, and story 8 owns
   * that surface. Exposing a raw round dial on `mad_review` now would ship the
   * eleventh dial the preset exists to hide and then need deprecating.
   */
  maxRounds?: number
  /**
   * AD-15 — a token ceiling in tokens, defaulted and clamped by
   * `clampTokenCap`. Absent means NO ceiling, which is what every caller before
   * story 5 got.
   *
   * **IT IS MEASURED OVER THE WHOLE RUN BUT ONLY GATES DEBATE.** The ledger
   * records every stage's turns, so `spent` includes discovery — but debate is
   * the only stage that asks `mayISpend` before spending, because it is the only
   * stage story 5 gave a gate. The consequence is worth stating rather than
   * discovering: a cap smaller than discovery's own spend leaves nothing for
   * debate, so the first gate check refuses and EVERY contested finding is
   * marked `unresolved { diedAtStage: "debate" }` without a single debate turn
   * having run. That is honest — the run says exactly where it stopped (AD-6d) —
   * but it is not "the budget was too small for the debate", it is "the budget
   * was already gone". Story 8 owns the user-facing budget number and is where
   * metering the earlier stages belongs.
   *
   * It lives on the LEDGER rather than beside it, so "may I spend?" is
   * answerable from one object (`core/budget/ledger.ts`). Same `Ask First` as
   * `maxRounds`: this seam, never the `mad_review` tool surface.
   */
  tokenCap?: number
}

export interface ReviewResult {
  /** AD-16 — in memory. Nothing is written to the user's repo. */
  record: RunRecord
  /** The rendered run (spine, Observability: the rendered run IS the trace). */
  rendered: string
}

/**
 * The change under review, as ONE labelled material span (AD-18, story 5A).
 *
 * `description`, `files` and `diff` are all attacker-influenced in v1's one use
 * case — a pull request — so all three go inside the span rather than only the
 * diff. AD-18 names "the change under review" as one span, and one fence around
 * the section is both faithful to that and the cheapest in tokens; a selection
 * label and a list of repo paths are not worth a label each.
 *
 * The framing is built HERE, in the envelope, and never in the registry's
 * instruction text: that text is pinned byte-for-byte, is story 2's recall
 * baseline and is story 9's control arm (see `core/prompt/material.ts`).
 *
 * This one function feeds BOTH stages that talk to a model — `discover` and
 * `debate` — so neither can be framed and the other not.
 */
function buildInput(change: ChangeSet): string {
  // The INNER fence widens too (code review 2026-08-27). A hardcoded ``` held
  // only because every content line of a unified diff carries a prefix column,
  // so a bare fence cannot start a line there — an unstated, untested assumption
  // about a value the attacker supplies, and `git diff` is not the only producer
  // of a string that arrives through the `Repo` port. `fenceFor` drops the
  // assumption instead of documenting it, at the cost of nothing: for an ordinary
  // diff it returns the same four characters the outer fence gets.
  const inner = fenceFor(change.diff)
  return [
    // MAD-authored: the heading is the envelope's, not the change's, so it sits
    // OUTSIDE the span. Everything the change supplied sits inside it.
    `# Change under review`,
    ``,
    material(
      "change under review",
      [
        // ESCAPED, not merely fenced (code review 2026-08-27, second pass).
        // `Selection:` and `Files touched (N):` are rows MAD formats, and
        // `description` and `files` are cells MAD does not own — the same shape
        // as the debate exchange's entry rows, and the same forgery. A break in
        // `description` printed a SECOND `Files touched (1): …` row and a second
        // `## Diff` heading inside the span, in MAD's own voice; the count is
        // MAD's attestation and content made it false. It also let the
        // description open its own fence, so the real diff rendered inside the
        // attacker's block. The fence cannot stop either, because the forgery
        // impersonates MAD's frame from INSIDE the span rather than escaping it.
        //
        // The files row is QUOTED as well as escaped, for the citation list's
        // reason (`core/stages/debate.ts`): the join is `", "` and a path may
        // contain it, which rendered one path as two files and left the count
        // disagreeing with the visible list. One cell per quoted string, so the
        // two can no longer diverge.
        //
        // `change.diff` is deliberately NOT escaped: it has no MAD-owned line
        // structure to forge and collapsing its lines would make it unreadable
        // (`core/prompt/material.ts`).
        `Selection: ${oneLine(change.description)}`,
        `Files touched (${change.files.length}): ${change.files.map(listCell).join(", ")}`,
        ``,
        `## Diff`,
        ``,
        `${inner}diff`,
        change.diff,
        inner,
      ].join("\n"),
    ),
  ].join("\n")
}

export async function review(deps: ReviewDeps): Promise<ReviewResult> {
  const { roster, backend, clock, change } = deps
  // AD-11 amended — the pool's set comes from the registry, addressed by task
  // type + role. The lens sets are resolved inside `discover`, per lens slot.
  const instructions =
    deps.instructions ?? resolveInstructions({ taskType: "coding", role: "discovery" })

  const record: RunRecord = {
    runId: clock.id("run"),
    startedAt: clock.now(),
    roster,
    answered: 0,
    findings: [],
    pool: [],
    lensInstructions: [],
    // CAP-3 — clamped once, here, so the record carries the value routing
    // actually used rather than the one the caller asked for.
    threshold: clampThreshold(deps.threshold),
    // CAP-4 — clamped once, here, for exactly `threshold`'s reason: the record
    // carries the value debate actually used, not the one the caller asked for.
    maxRounds: clampMaxRounds(deps.maxRounds),
    warnings: [...(deps.priorWarnings ?? [])],
    // AD-15 — the ceiling rides on the ledger, beside the spend it bounds, and
    // is CLAMPED once here for exactly `threshold`'s and `maxRounds`' reason. An
    // unclamped `NaN` is the one that bites: `spent < NaN` is false for every
    // spend, so it refuses the first turn and the run then blames a budget
    // nobody set (code review 2026-08-24).
    ledger: emptyLedger(clampTokenCap(deps.tokenCap)),
  }

  // ---- stage 1: discover ----
  const discovered = await discover({
    roster,
    backend,
    instructions,
    input: buildInput(change),
    clock,
    ledger: record.ledger,
  })

  record.answered = discovered.answered
  // The pre-cluster union is RETAINED, not reconstructed. CAP-1's recall harness
  // measures the discovery pool, and a merged set is a different set.
  record.pool = discovered.findings
  // AD-11 amended / AD-17e — carried to output so a reader can tell a shipped
  // lens instruction from one generated at run time.
  record.lensInstructions = discovered.lensInstructions
  record.warnings.push(...discovered.warnings)

  // ---- stage 2: cluster ----
  //
  // The `{raised: 1, answered}` shim that stood here until story 3 IS GONE.
  // Clustering owns `coDiscovery` (AD-8) and now writes it — including the rule
  // the shim's guard used to carry, that a lens finding never receives a prior
  // (AD-17d, CAP-11). Do not reintroduce a default here; a stage writing a field
  // it does not own is exactly what AD-8 exists to stop.
  //
  // For a run whose findings are all distinct this is byte-for-byte what the
  // shim produced: every finding is a singleton reading `{raised: 1, answered}`.
  // The only rendering that changes is the one that should — findings that are
  // actually equivalent.
  const clustered = await cluster({ findings: record.pool, answered: discovered.answered, clock })
  record.findings = clustered.findings

  // ---- stage 3: route ----
  //
  // The CANONICAL set, never `record.pool`: an absorbed member is not a finding
  // the pipeline decides about, and routing one would produce a decision nothing
  // downstream ever reads.
  const routed = route({ findings: record.findings, threshold: record.threshold, clock })
  // The record reports what the STAGE did, not what the caller asked for and not
  // what the renderer can reconstruct. Re-stamping `threshold` from the return
  // value costs nothing (both sides call `clampThreshold`, so it is already a
  // fixpoint) and removes the class of bug where the two derivations drift; the
  // counts come across for the reason `RunRecord.routeCounts` documents.
  record.threshold = routed.threshold
  record.routeCounts = {
    toDebate: routed.toDebate,
    toJudge: routed.toJudge,
    toJudgeAtThreshold: routed.toJudgeAtThreshold,
    toJudgeNoPrior: routed.toJudgeNoPrior,
  }

  // ---- stage 4: debate ----
  //
  // The CANONICAL set again, and the whole of it: `debate()` picks out its own
  // `route: "debate"` partition rather than being handed a filtered array, so
  // the one place that decides what is contested stays `route`, and the stage
  // returns the same array it was given (it never filters).
  //
  // `answeredSlots` is derived HERE from discovery's own drop-out list, because
  // discovery is the only stage that knows who answered. The non-author seat in
  // a debate room exists to produce a contest; offering it to a model that
  // already failed twice would buy a warning instead of an argument.
  const answeredSlots = roster.slots
    .map((slot) => slot.slot)
    .concat(roster.lensSlots.map((slot) => slot.slot))
    .filter((slot) => !discovered.droppedOut.includes(slot))

  // ONE BUILD (code review 2026-08-28). The framed change span is the largest
  // string in the pipeline and both remaining stages need the same one. Building
  // it twice cost a second copy for nothing and left two call sites that could
  // drift apart if `buildInput` ever stopped being pure.
  const framedChange = buildInput(change)

  const debated = await debate({
    findings: record.findings,
    // The pre-cluster union, so a cluster's CO-FINDERS are resolvable from
    // `mergedIds` — the only place an absorbed member's author survives.
    pool: record.pool,
    roster,
    answeredSlots,
    backend,
    input: framedChange,
    clock,
    ledger: record.ledger,
    maxRounds: record.maxRounds,
  })
  // Re-stamped from the stage's return for routing's reason exactly: the record
  // reports what the STAGE did. Both sides call `clampMaxRounds`, so this is
  // already a fixpoint, and the counts come across because a partition counted
  // twice is a partition that can disagree with itself.
  record.maxRounds = debated.maxRounds
  record.debateCounts = {
    debated: debated.debated,
    converged: debated.converged,
    convergedUncontested: debated.convergedUncontested,
    convergedUnsure: debated.convergedUnsure,
    stalled: debated.stalled,
    cap: debated.cap,
    unresolved: debated.unresolved,
    rounds: debated.rounds,
    turns: debated.turns,
    attempts: debated.attempts,
  }
  record.warnings.push(...debated.warnings)

  // ---- stage 5: judge ----
  //
  // The CANONICAL set again, and the whole of it, for debate's reason exactly:
  // the stage picks its own partition off `route` rather than being handed a
  // filtered array, so the one place that decides a finding's MODE stays `route`.
  //
  // `answeredSlots` is NARROWED, not recomputed (code review 2026-08-28). The
  // judge's non-author preference and debate's non-author seat answer the same
  // question — who is still alive to be asked — so the set is the same one debate
  // got, minus the slots that died arguing. It used to be passed through
  // unchanged, which made the comment claiming it answers that question false:
  // the judge rediscovered every debate-dead slot by failing it twice, which is
  // exactly the waste `noteDropOut` exists to prevent one stage further down.
  //
  // `runId` seeds the anonymizer's permutation together with each finding's id,
  // so two runs over one input produce one record (AD-17b, and the spine's
  // ordering convention).
  const judged = await judge({
    findings: record.findings,
    roster,
    answeredSlots: answeredSlots.filter((slot) => !debated.droppedOut.includes(slot)),
    backend,
    input: framedChange,
    clock,
    ledger: record.ledger,
    runId: record.runId,
  })
  // Re-stamped from the stage's return for routing's and debate's reason: the
  // record reports what the STAGE did, never a renderer's recount over the
  // narrower set it happens to be iterating.
  record.judgeCounts = {
    judged: judged.judged,
    adjudicated: judged.adjudicated,
    verifiedIndependently: judged.verifiedIndependently,
    factChecksDroppedOut: judged.factChecksDroppedOut,
    notExamined: judged.notExamined,
    withdrawnByAuthor: judged.withdrawnByAuthor,
    upheld: judged.upheld,
    ruledInvalid: judged.ruledInvalid,
    notAdjudicated: judged.notAdjudicated,
    unresolved: judged.unresolved,
    factChecksUnverified: judged.factChecksUnverified,
    turns: judged.turns,
    attempts: judged.attempts,
  }
  record.warnings.push(...judged.warnings)

  // ---- stage 6: output ----
  record.finishedAt = clock.now()
  const rendered = output(record)

  return { record, rendered }
}
