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
import {
  clampConcurrency,
  clampPreset,
  clampSpendShares,
  clampTokenCap,
  createLimiter,
  PRESET_DIALS,
  type Preset,
  type SpendShares,
} from "../budget/ledger.ts"
import type { Stage } from "../domain/finding.ts"
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
   * **IT IS MEASURED OVER THE WHOLE RUN, AND EVERY BILLING STAGE ASKS BEFORE IT
   * SPENDS** (story 8). Each of the three is held to a CUMULATIVE SHARE of this
   * one number — discovery may take the run to 30% of it, debate to 65%, the
   * judge to all of it — so a cheap stage rolls its remainder forward and an
   * expensive one cannot eat the whole cap before the next stage starts.
   * `spendShares` below is the dial; `core/budget/presets.ts` holds the numbers
   * and the reasoning.
   *
   * This paragraph used to say debate was the only gated stage, and to document
   * the consequence: a cap smaller than discovery's own spend left nothing for
   * debate, so its first gate refused and EVERY contested finding was marked
   * `unresolved { diedAtStage: "debate" }` without a single debate turn having
   * run — honest about where it stopped, but blaming the wrong stage. That state
   * is what the shares close, and a test pins it closed.
   *
   * It lives on the LEDGER rather than beside it, so "may I spend?" is
   * answerable from one object (`core/budget/ledger.ts`). Same `Ask First` as
   * `maxRounds`: this seam, never the `mad_review` tool surface.
   */
  tokenCap?: number
  /**
   * AD-15 amended (story 7A) — the PEAK: how many billed turns this run may have
   * in flight at once. Defaulted and clamped by `clampConcurrency`; there is no
   * "unlimited" value, because unlimited is the state this exists to remove.
   *
   * **IT BOUNDS RATE, NEVER TOTAL**, and the distinction is the one `tokenCap`'s
   * note above makes in the other direction. A limiter refuses nothing and
   * strands nothing: a turn that has to wait still runs, still bills, and still
   * produces its finding. What changes is that twenty simultaneous sessions
   * against one user's credentials become `maxConcurrency` at a time, so provider
   * rate limiting arrives as wall-clock rather than as a `model-dropped-out`
   * warning naming a model that was working fine.
   *
   * ONE LIMITER FOR THE WHOLE RUN, created here. A limiter per stage would give a
   * peak of `stages × limit`, which is not a peak — and stages overlap only
   * inside themselves today, so the single object costs nothing and stays true
   * if that ever changes.
   *
   * Story 8 puts the user-facing number in front of it: `preset` moves this
   * default, and `paranoid` raises it to 6 because it adds three discovery slots.
   * The MECHANISM is still story 7A's and is still constructed here and nowhere
   * else.
   */
  maxConcurrency?: number
  /**
   * CAP-7 (story 8) — ONE WORD that resolves to a table of dial values:
   * `quick`, `normal` or `paranoid`. Clamped by `clampPreset`, which answers
   * `normal` for anything it does not recognise.
   *
   * **AN EXPLICIT DIAL ALWAYS BEATS THE PRESET**, and that precedence is the
   * whole contract of this field. A caller who passes `preset: "quick"` and
   * `threshold: 0.9` gets 0.9 — the preset is a set of DEFAULTS for dials the
   * caller did not state, never an override of ones they did. The alternative
   * would make the two arguments fight, with the winner depending on the order
   * they happen to be read in.
   *
   * `normal` is the IDENTITY preset: every value it carries is the shipped
   * default verbatim, so `preset: "normal"` and passing nothing are the same run
   * (AD-3). A test pins it, so a table edit cannot quietly break it.
   *
   * It does NOT move `maxRounds` (`cost-model.md`: the dial is which lenses, not
   * how many rounds) and it does not move the slot count (AD-3: the roster is
   * the host's configured models, not a word's decision). What it moves is
   * `threshold`, which lenses run, and `maxConcurrency`.
   */
  preset?: Preset
  /**
   * AD-15 / CAP-7 (story 8) — how far into `tokenCap` each stage may take the
   * run's total, as fractions. Clamped by `clampSpendShares`; absent means
   * `CUMULATIVE_SHARE`, which is what every caller before this story got in
   * effect, since no stage but debate and the judge was gated at all.
   *
   * Two of these are dials and the third is not: `judge` is forced to 1, because
   * a judge share below 1 makes part of the stated cap unreachable — a ceiling
   * that lies to the reader.
   *
   * Same `Ask First` as `maxRounds`: this seam, never the `mad_review` tool
   * surface. The tool surface gets `budget` and `preset` and nothing else.
   */
  spendShares?: Partial<SpendShares>
  /**
   * AD-2 amended / AD-6f (story 7A) — the user's stop.
   *
   * Optional, and its absence is a run that cannot be cancelled — which is every
   * caller before this story and every test that does not care. When it is
   * present and fires, the core stops ISSUING turns; whether a turn already in
   * flight is aborted is up to the backend and is deliberately not required
   * (AD-2 amended), because requiring it would make an out-of-process backend
   * unimplementable.
   *
   * A cancelled run still RENDERS. It reports where it stopped, keeps every
   * finding it had, and is distinguishable at a glance from a finished one
   * (AD-6f) — which is the entire reason cancellation is handled here rather
   * than by letting the caller throw the result away.
   */
  signal?: AbortSignal
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

/**
 * AD-18's EIGHTH SPAN — the rendered run, framed for the host agent (story 7).
 *
 * `adapters/opencode/plugin.ts` returns the rendered run as the `mad_review`
 * tool's `output`, and a tool's output is read by the calling agent, which is a
 * model. The report quotes every `claim`, `reasoning`, debate position and judge
 * report the run produced — model-authored prose, which is exactly the text
 * AD-18 classifies as material everywhere else. Story 5A left this open on
 * purpose and assigned it here.
 *
 * ## Why this lives in `core/` and is not inlined at the adapter
 *
 * Two reasons, and the second is the load-bearing one. AD-18 puts the framing in
 * the envelope a caller builds, and every other span in the pipeline is built in
 * `core/`; a ninth site that spelled a span differently would be exactly the
 * drift `core/prompt/material.ts` exists to prevent. And `fixtures/` may import
 * `core/` while `core/` may not import `fixtures/` (AD-1), so a function here is
 * the only cheap route to a non-vacuous end-to-end test — the prompt-injection
 * fixture drives `review()` and can then frame the same rendered string the
 * adapter would.
 *
 * ## Why it is not applied inside `output()`
 *
 * The same report is shown to a HUMAN, where a notice sentence and a fence are
 * noise (AD-18 amended 2026-08-27). `output()` therefore returns the bare report
 * and this is applied at the ONE boundary where a model reads it.
 */
export function frameForHostAgent(rendered: string): string {
  return material("review report", rendered)
}

/**
 * AD-6 / `dial-clamped` — the dials the run did not honour as asked.
 *
 * Compares what the caller PASSED against what is IN FORCE on the record, after
 * every clamp has run. Reading it off the record rather than re-deriving it is
 * deliberate and is the same rule the ablation's "every dial is equal across
 * arms" test follows: the literal is what was asked for, the record is what
 * happened, and only the record can answer "did this move".
 *
 * A dial the caller did not pass is SKIPPED, never reported. Absence is the
 * caller declining to set it, not a clamp — and a warning that fired on every
 * default run would teach a reader to skip the block AD-6 needs them to read.
 *
 * `spendShares` is compared per share, so a run that asked for a valid discovery
 * share and a rubbish debate share names only the one that moved.
 */
function clampedDials(deps: ReviewDeps, record: RunRecord, preset: Preset): Warning[] {
  const moved: { dial: string; requested: unknown; inForce: unknown }[] = []
  const note = (dial: string, requested: unknown, inForce: unknown) => {
    if (requested !== undefined && !Object.is(requested, inForce)) {
      moved.push({ dial, requested, inForce })
    }
  }

  // `threshold` falls through to the preset when absent, so it is compared only
  // when the CALLER named one — otherwise every preset run would report the
  // preset's own value as a clamp of nothing.
  note("threshold", deps.threshold, record.threshold)
  note("maxRounds", deps.maxRounds, record.maxRounds)
  note("tokenCap", deps.tokenCap, record.ledger.cap)
  note("maxConcurrency", deps.maxConcurrency, record.ledger.maxConcurrency)
  note("preset", deps.preset, preset)
  for (const [share, value] of Object.entries(deps.spendShares ?? {})) {
    note(`spendShares.${share}`, value, record.ledger.shares[share as keyof SpendShares])
  }

  if (moved.length === 0) return []
  return [
    {
      code: "dial-clamped",
      stage: "discover",
      message:
        `A DIAL WAS NOT HONOURED AS ASKED: ` +
        moved.map((m) => `${m.dial} ${JSON.stringify(m.requested)} → ${JSON.stringify(m.inForce)}`).join("; ") +
        `. The run was held to the value(s) on the right, and every number it reports is a ` +
        `number about THAT run — not about the one that was requested.`,
      detail: { dials: moved },
    },
  ]
}

export async function review(deps: ReviewDeps): Promise<ReviewResult> {
  const { roster, backend, clock, change } = deps
  // AD-11 amended — the pool's set comes from the registry, addressed by task
  // type + role. The lens sets are resolved inside `discover`, per lens slot.
  const instructions =
    deps.instructions ?? resolveInstructions({ taskType: "coding", role: "discovery" })

  // CAP-7 (story 8) — THE PRESET IS RESOLVED ONCE, HERE, and every dial below
  // reads from `dials` rather than re-deriving it. Resolving it twice is how the
  // two halves of one word start to disagree.
  const preset: Preset = clampPreset(deps.preset)
  const dials = PRESET_DIALS[preset]

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
    // CAP-7 (story 8) — AN EXPLICIT DIAL BEATS THE PRESET. `??` and not `||`:
    // `threshold: 0` is a caller asking for 0 and must not fall through to the
    // preset's value. Resolved once, here, so the record carries what routing
    // actually used.
    threshold: clampThreshold(deps.threshold ?? dials.threshold),
    // CAP-7 — recorded ONLY when the caller named one. Absent is a real fact:
    // it says no preset was asked for, which is a different report from a run
    // that asked for `normal` even though the two runs are identical today.
    ...(deps.preset === undefined ? {} : { preset }),
    // CAP-4 — clamped once, here, for exactly `threshold`'s reason: the record
    // carries the value debate actually used, not the one the caller asked for.
    maxRounds: clampMaxRounds(deps.maxRounds),
    // `dial-clamped` is appended AFTER the record is built, below — it compares
    // against the clamped values this object now carries, so it cannot be
    // computed inside the literal that produces them.
    warnings: [...(deps.priorWarnings ?? [])],
    // AD-15 — the ceiling rides on the ledger, beside the spend it bounds, and
    // is CLAMPED once here for exactly `threshold`'s and `maxRounds`' reason. An
    // unclamped `NaN` is the one that bites: `spent < NaN` is false for every
    // spend, so it refuses the first turn and the run then blames a budget
    // nobody set (code review 2026-08-24).
    ledger: emptyLedger(
      clampTokenCap(deps.tokenCap),
      clampConcurrency(deps.maxConcurrency ?? dials.maxConcurrency),
      clampSpendShares(deps.spendShares),
    ),
  }

  // AD-6 / `dial-clamped` (epic-1 retrospective) — raised HERE, once, because
  // this is the first point at which both halves of the comparison exist: the
  // caller's request in `deps`, and the clamped value on `record`.
  record.warnings.push(...clampedDials(deps, record, preset))

  // AD-15 amended — ONE limiter, created once, from the number the record now
  // carries. Every stage's fan-out passes through this object, so "peak
  // concurrency" is a property of the run rather than of whichever stage happens
  // to be widest. Created from `record.ledger.maxConcurrency` and not from
  // `deps` directly, so the number in force and the number reported are the same
  // number — the fixpoint discipline `threshold` and `maxRounds` already follow.
  const limiter = createLimiter(record.ledger.maxConcurrency)
  const { signal } = deps

  /**
   * AD-6f — the ONE place a run records that the user stopped it.
   *
   * FIRST STAGE WINS. Every stage after the stop also sees an aborted signal and
   * would report itself, so a last-write-wins field would say the run stopped in
   * `judge` when it stopped in `discover` and every stage since had done nothing.
   * The warning is raised here rather than by the stage for the same reason: a
   * stage can only say "I stopped", and three stages each saying so truthfully
   * is three warnings for one stop.
   *
   * The findings themselves are marked by the STAGES, not here — `unresolved` is
   * a field they own (AD-8), and only they know which of their findings had been
   * decided before the stop landed.
   */
  const noteCancelled = (stage: Stage): void => {
    if (record.cancelled) return
    record.cancelled = { stage }
    record.warnings.push({
      code: "run-cancelled",
      stage,
      message:
        `RUN CANCELLED: you stopped this run during the ${stage} stage. It is NOT a finished ` +
        `review — the findings below are what MAD had at that moment, and anything left undecided ` +
        `is in the UNRESOLVED section with the stage it stopped at. No model failed, and no model ` +
        `was retried after you stopped.`,
      detail: { stage },
    })
  }

  // ---- stage 1: discover ----
  const discovered = await discover({
    roster,
    backend,
    instructions,
    input: buildInput(change),
    clock,
    ledger: record.ledger,
    limiter,
    signal,
  })

  record.answered = discovered.answered
  // AD-15 (story 8) — recorded only when it happened, for `cancelled`'s reason:
  // absent is the ordinary run, and an always-present empty array would put a
  // budget field on every artifact dump of a run no budget touched.
  if (discovered.skippedForBudget.length > 0) {
    record.skippedForBudget = [...discovered.skippedForBudget]
  }
  // The pre-cluster union is RETAINED, not reconstructed. CAP-1's recall harness
  // measures the discovery pool, and a merged set is a different set.
  record.pool = discovered.findings
  // AD-11 amended / AD-17e — carried to output so a reader can tell a shipped
  // lens instruction from one generated at run time.
  record.lensInstructions = discovered.lensInstructions
  record.warnings.push(...discovered.warnings)
  if (discovered.cancelled) noteCancelled("discover")

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
  //
  // AD-15 (story 8) — AND FROM THE SLOTS THE BUDGET REFUSED, which is the second
  // half of the same rule and was a live defect the moment discovery gained a
  // gate. `droppedOut` alone is not "who did not answer": a slot MAD never asked
  // is in neither list, so it would have been seated as the non-author skeptic
  // in a debate room and BILLED — under the very budget that refused to ask it.
  // A model that never spoke cannot contest a finding, and paying for it out of
  // an exhausted budget is the worst version of that.
  const answeredSlots = roster.slots
    .map((slot) => slot.slot)
    .concat(roster.lensSlots.map((slot) => slot.slot))
    .filter(
      (slot) =>
        !discovered.droppedOut.includes(slot) && !discovered.skippedForBudget.includes(slot),
    )

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
    limiter,
    signal,
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
  if (debated.cancelled) noteCancelled("debate")

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
    limiter,
    signal,
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
    unresolvedByCancellation: judged.unresolvedByCancellation,
    factChecksUnverified: judged.factChecksUnverified,
    turns: judged.turns,
    attempts: judged.attempts,
  }
  record.warnings.push(...judged.warnings)
  if (judged.cancelled) noteCancelled("judge")

  // AD-6f (code review 2026-08-31) — THE BACKSTOP, AND WHY A STAGE REPORT IS NOT
  // ENOUGH ON ITS OWN.
  //
  // Every `noteCancelled` above is driven by a stage REPORTING that it skipped
  // or received a cancelled turn, which is the right primary signal: it is what
  // makes "the FIRST stage to stop" a fact rather than a guess. But a stage only
  // reports a stop it had a turn left to refuse. A run can be stopped where no
  // later stage needs one — discovery raises nothing, or every room is already
  // closed, or every finding was withdrawn, or the stop simply lands after the
  // last judge turn has returned. `debate` breaks on `open.length === 0` before
  // it ever reaches its cancellation gate, and the judge's gate lives inside a
  // per-finding loop that never runs. Nothing anywhere then said the user
  // stopped the run, and the header, the warning, the title and
  // `metadata.cancelled` were all silent — a stopped run rendering as a clean,
  // finished review, which is the one thing AD-6(f) forbids outright.
  //
  // So the signal is read HERE too, once, after every turn-issuing stage. The
  // stage named is the last one that actually issued a turn, because that is the
  // last moment MAD was spending the user's money; naming `judge` unconditionally
  // would put the run's stop in a stage that did nothing.
  if (!record.cancelled && signal?.aborted) {
    const lastActive: Stage =
      judged.turns > 0 ? "judge" : debated.turns > 0 ? "debate" : "discover"
    noteCancelled(lastActive)
  }

  // ---- stage 6: output ----
  //
  // OUTPUT RUNS EVEN WHEN THE RUN WAS CANCELLED, and `finishedAt` is still
  // stamped (AD-6f). A cancelled run finished REPORTING; it did not finish
  // REVIEWING, and the difference is carried by `record.cancelled` — which the
  // header line, the warnings block and the adapter's title all read. Throwing
  // the report away instead would leave the user who stopped the run with
  // nothing to show for the turns they already paid for, which is the opposite
  // of what AD-6 asks for: a partial run is surfaced, never dropped.
  record.finishedAt = clock.now()
  const rendered = output(record)

  return { record, rendered }
}
