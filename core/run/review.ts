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
import {
  emptyLedger,
  reconcileLateUsage,
  ROUTING_POLICIES,
  type RoutingPolicy,
  type RunRecord,
} from "../domain/run-record.ts"
import type { Warning } from "../domain/warning.ts"
import { resolveInstructions } from "../instructions/registry.ts"
import type { InstructionSet } from "../instructions/types.ts"
import type { Clock } from "../ports/clock.ts"
import type { LateUsageSink } from "../ports/late-usage.ts"
import type { ModelBackend } from "../ports/model-backend.ts"
import type { ChangeSet } from "../ports/repo.ts"
import type { Tools } from "../ports/tools.ts"
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
  /**
   * CAP-8 / AD-13's FIRST route (story 10) — the OTHER repo-facing port, which
   * is why it sits beside `change`.
   *
   * OPTIONAL, and its absence is not a degradation: without it the judge falls
   * back to AD-13's second route, where the fact-checking backend's own agent
   * has the tools, and the run record says which route ran. Every existing
   * `ReviewDeps` construction site therefore keeps working unchanged.
   *
   * The core DRIVES it and never constructs one (AD-1) — `adapters/opencode/`
   * builds the implementation and passes it in here.
   */
  tools?: Tools
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
   *
   * AT THIS SEAM THE LENS HALF IS ALREADY SETTLED (code review 2026-09-06).
   * Lens slots are resolved into the `Roster` before `review()` is called and
   * `ReviewDeps` has no lens input, so a direct core caller — the ablation
   * harness, a test — passing `preset: "paranoid"` gets the threshold and the
   * concurrency and no lens slots at all. That is not a `paranoid` run. The
   * adapter resolves the lens half before building the roster; a core caller
   * that wants it must put the lens slots on the `Roster` itself.
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
   * AC2 (story 2.3) — WHERE USAGE THAT ARRIVED TOO LATE IS COLLECTED.
   *
   * A provider MAD stopped waiting on keeps working and eventually reports what
   * the request cost. `adapters/opencode/model-backend.ts` hands that figure to
   * the WRITE half of this object from a non-awaited continuation on the
   * abandoned prompt promise; the run holds the read half and folds whatever has
   * arrived back into the ledger as the record closes
   * (`reconcileLateUsage`), turning a turn MAD could not count into a turn MAD
   * counted.
   *
   * OPTIONAL, AND ITS ABSENCE IS THE ORDINARY RUN — every `ReviewDeps`
   * construction site in this tree passes none today, and a run without one
   * behaves exactly as it did before this story: unknown usage is still
   * recorded, still reported, and simply never recovered. That is AD-16's rule
   * that evaluation machinery is additive, applied to the recovery half of
   * story 2.3 rather than only to the recording half.
   *
   * A SINK AND NOT A REPORTER, and the narrowing runs the other way for the
   * adapter: the run needs `drain()` and the backend must not have it, because a
   * backend that could drain would silently take usage this record was about to
   * recover (`core/ports/late-usage.ts`).
   */
  lateUsage?: LateUsageSink

  /**
   * AC4 (story 2.3) — THE WITHIN-RUN HALF OF THE UNKNOWN-USAGE STOP RULE, and
   * the reason it is a caller's dial rather than always-on.
   *
   * Set, the run's accountant refuses the next turn once any turn's usage has
   * gone unknown: `mayISpend` answers `false` and every stage strands what it
   * had, exactly as it does for an exhausted budget. Absent — the default, and
   * every ordinary review — the run REPORTS the unknown and keeps working.
   *
   * The split is not squeamishness about halting. The stop rule comes from
   * `evaluation-protocol.md:332-339` and it is a rule about the EXPERIMENT: an
   * evaluation that cannot count a turn must not buy another one, because its
   * whole output is a number about spend. An ordinary code review's output is a
   * list of findings, and abandoning it because one host response omitted a
   * `tokens` field would be this story inventing a policy for a caller the
   * protocol never spoke about — and AD-16's rule that evaluation machinery is
   * additive and never changes an ordinary run cuts the same way.
   *
   * WITHOUT THIS FIELD THE RULE HAD NO PRODUCTION CALLER AT ALL (found by the
   * wave-5 review, 2026-09-11). `mayISpend`'s refusal and its tests were
   * correct, the ledger carried the flag, and nothing outside a test ever set
   * it — so `ablation/` armed the arm-level governor while the turn-level gate
   * stayed off, and the protocol's "unquantified usage never authorizes a retry"
   * was enforced by no path an evaluation runs. A dial nothing can turn is not a
   * dial; this is the knob.
   */
  stopOnUnknownUsage?: boolean
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
function clampedDials(
  deps: ReviewDeps,
  record: RunRecord,
  preset: Preset,
  priorDials: readonly { dial: string; requested: unknown; inForce: unknown }[] = [],
): Warning[] {
  // ONE `dial-clamped` PER RUN, INCLUDING THE ADAPTER'S (code review
  // 2026-09-06). A layer below this one can clamp a dial of its own — the
  // opencode adapter bounds the `models` and `lenses` lists before the core
  // sees them — and it hands those in through `priorWarnings`. Folding them
  // into this one warning is what makes `core/domain/warning.ts`'s "Raised ONCE
  // per run" true; two blocks saying the same kind of thing is the noise that
  // gets a warning section skipped, which is the one outcome AD-6 cannot afford.
  const moved: { dial: string; requested: unknown; inForce: unknown }[] = [...priorDials]
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
  // THE THREE NAMED SHARES, never `Object.entries` (code review 2026-09-06). A
  // JavaScript caller passing `{ discovery: 0.5 }` would otherwise have the
  // warning announce a dial that does not exist, clamped to `undefined`.
  for (const share of ["discover", "debate", "judge"] as const) {
    note(`spendShares.${share}`, deps.spendShares?.[share], record.ledger.shares[share])
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
function recordCancellation(record: RunRecord, stage: Stage): void {
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

/**
 * A run carried through clustering and not yet routed — the PREPARE half of
 * `review()` (story 2.5A, `evaluation-protocol.md` §8 "Seam shape").
 *
 * IT OWNS EVERY INPUT THE CONTINUATION DECIDES WITH. The resolved roster sits on
 * `record.roster`, the clamped dials on `record` and `record.ledger`, the
 * cancellation on `record.cancelled`. The change reaches the continuation only
 * as `framedChange`, and discovery eligibility only as `answeredSlots`. A
 * continuation cannot be handed a second roster, change, instruction set or
 * dial, so findings prepared against one change cannot be judged against
 * another while the record still describes the first.
 *
 * IT CARRIES NO RUNTIME SERVICE. The backend, clock, limiter, `Tools`, signal
 * and late-usage sink stay with the caller and arrive through `ContinueDeps`.
 * Opaque evidence is kept exactly as it came: a caller's `warning.detail` may
 * hold anything, and nothing here strips or rejects it. Cloning, persisting and
 * forking this value are not supported yet, and a value `structuredClone`
 * cannot copy is refused at that boundary, not here.
 *
 * SINGLE-USE. `continueReview` mutates `record` and the findings in place
 * (AD-7), so a second continuation of the same value would route findings that
 * already carry a route and would double their history. It is refused.
 */
export interface PreparedReview {
  record: RunRecord
  /** AD-11 — the pool's instruction set discovery used. Recorded, not re-read. */
  instructions: InstructionSet
  /** `buildInput(change)`, built once: the same span discovery saw. */
  framedChange: string
  /**
   * Slots still able to be seated or asked after discovery — neither dropped
   * out nor refused by the budget. Derived from discovery's own lists, because
   * discovery is the only stage that knows who answered.
   */
  answeredSlots: string[]
  /**
   * The caller's signal had fired by the time preparation returned.
   *
   * NOT THE SAME FACT AS `record.cancelled`. Discovery records a stop only when
   * one of its own turns was refused or cancelled, so a stop that lands after
   * its last turn answered leaves `record.cancelled` unset; in an uninterrupted
   * `review()` the next stage to see the aborted signal names itself. This flag
   * carries that stop across the seam, so a continuation handed no signal, or a
   * fresh one, still issues nothing.
   */
  stopRequested: boolean
}

/**
 * What a continuation needs from its caller: runtime ports only. See
 * `PreparedReview` for why nothing that decides the review is in this list.
 */
export type ContinueDeps = Pick<ReviewDeps, "backend" | "clock" | "tools" | "signal" | "lateUsage">

/**
 * Records already continued. Keyed on the RECORD rather than the prepared
 * wrapper, because the record is what a continuation mutates: a shallow copy of
 * the wrapper shares it and must be refused too. A WeakSet, so a finished run
 * is not kept alive.
 */
const continued = new WeakSet<RunRecord>()

export async function prepareReview(deps: ReviewDeps): Promise<PreparedReview> {
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
    // AC4 (story 2.3) — the stop dial is SPREAD ON rather than passed as a
    // fourth positional parameter. `withShares` exists because `shares` being
    // third already forced a caller to name a `maxConcurrency` it did not care
    // about; a fourth would make that worse for the one flag most callers never
    // set. `=== true` and not `??`, so any non-boolean a JavaScript caller
    // supplies lands on the safe default rather than on `truthy`.
    ledger: {
      ...emptyLedger(
        clampTokenCap(deps.tokenCap),
        clampConcurrency(deps.maxConcurrency ?? dials.maxConcurrency),
        clampSpendShares(deps.spendShares),
      ),
      stopOnUnknownUsage: deps.stopOnUnknownUsage === true,
    },
  }

  // AD-6 / `dial-clamped` (epic-1 retrospective) — raised HERE, once, because
  // this is the first point at which both halves of the comparison exist: the
  // caller's request in `deps`, and the clamped value on `record`.
  //
  // A `dial-clamped` that arrived in `priorWarnings` is LIFTED OUT and folded in
  // rather than left to ride beside this one (code review 2026-09-06), so the
  // code stays what its own header says it is: one per run.
  //
  // FOLDING IS NOT DELETING (code review 2026-09-08). A prior `dial-clamped`
  // whose `detail.dials` is absent, or is not an array of dial entries, carries
  // nothing this function can re-emit — so it is left standing where it is
  // rather than filtered away. Dropping it lost the adapter's clamp warning
  // outright, and folding its junk rendered `undefined undefined → undefined` in
  // the block AD-6 needs a reader to trust. Only a warning that actually
  // surrenders its dials is replaced.
  const isDial = (value: unknown): value is { dial: string; requested: unknown; inForce: unknown } =>
    typeof value === "object" && value !== null && typeof (value as { dial?: unknown }).dial === "string"
  const dialsOf = (warning: { detail?: Record<string, unknown> }): { dial: string; requested: unknown; inForce: unknown }[] => {
    const dials = warning.detail?.["dials"]
    return Array.isArray(dials) ? dials.filter(isDial) : []
  }
  const priorDials = record.warnings
    .filter((warning) => warning.code === "dial-clamped")
    .flatMap(dialsOf)
  record.warnings = record.warnings.filter(
    (warning) => warning.code !== "dial-clamped" || dialsOf(warning).length === 0,
  )
  record.warnings.push(...clampedDials(deps, record, preset, priorDials))

  // AD-15 amended — ONE limiter, created once, from the number the record now
  // carries. Every stage's fan-out passes through this object, so "peak
  // concurrency" is a property of the run rather than of whichever stage happens
  // to be widest. Created from `record.ledger.maxConcurrency` and not from
  // `deps` directly, so the number in force and the number reported are the same
  // number — the fixpoint discipline `threshold` and `maxRounds` already follow.
  const limiter = createLimiter(record.ledger.maxConcurrency)
  const { signal } = deps

  // ONE BUILD (code review 2026-08-28). The framed change span is the largest
  // string in the pipeline, and discovery, debate and the judge all need the
  // same one. `buildInput` is pure, so building it once here is the same span
  // every stage saw before, and the continuation can only ever see this one.
  const framedChange = buildInput(change)

  // ---- stage 1: discover ----
  const discovered = await discover({
    roster,
    backend,
    instructions,
    input: framedChange,
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
  if (discovered.cancelled) recordCancellation(record, "discover")

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

  return {
    record,
    instructions,
    framedChange,
    answeredSlots,
    stopRequested: deps.signal?.aborted === true,
  }
}

/**
 * The CONTINUE half of `review()`: route once under `policy`, then the same
 * shipped debate, judge and output assembly.
 *
 * `policy` is an argument here and deliberately not a `ReviewDeps` field, so no
 * existing entry point (the `mad_review` tool, `scripts/ablation.ts`,
 * `ablation/live.ts`) can select `debate-off`. That is a statement about those
 * entry points only: this function bills whatever backend it is handed.
 *
 * A STOP SEEN IN PREPARATION IS TERMINAL, whether discovery recorded it
 * (`record.cancelled`) or it landed after discovery's last turn
 * (`stopRequested`). The stages stop issuing turns on an aborted signal, so they
 * are handed one in either case, whatever signal the caller passed. That is the
 * signal an in-process run already had at this point, so the stranding and its
 * reasons are the ones an uninterrupted `review()` produces.
 *
 * Throws, before consuming anything, on a policy that is not a known
 * `RoutingPolicy`.
 *
 * The limiter is built again from `record.ledger.maxConcurrency`. The two
 * halves run one after the other, so the peak is unchanged. Rebuilding it says
 * nothing about whether a turn that timed out in discovery has stopped at the
 * provider.
 *
 * Throws if `prepared` was already continued (see `PreparedReview`).
 */
export async function continueReview(
  prepared: PreparedReview,
  deps: ContinueDeps,
  policy: RoutingPolicy = "shipped",
): Promise<ReviewResult> {
  // CHECKED BEFORE ANYTHING IS CONSUMED. `route()` treats anything but
  // `debate-off` as shipped, so an unrecognised value from a JavaScript caller
  // would otherwise run and bill the opposite pathway and record it as shipped.
  if (!ROUTING_POLICIES.includes(policy)) {
    throw new Error(
      `unknown routing policy ${JSON.stringify(policy)} (expected one of ${ROUTING_POLICIES.join(", ")}). ` +
        `Nothing was routed and the prepared review is still unused.`,
    )
  }
  if (continued.has(prepared.record)) {
    throw new Error(
      "this prepared review was already continued. A continuation mutates the record and its " +
        "findings in place, so a second one would route findings that are already routed.",
    )
  }
  continued.add(prepared.record)

  const { record, framedChange, answeredSlots } = prepared
  const { roster } = record
  const { backend, clock } = deps
  const limiter = createLimiter(record.ledger.maxConcurrency)
  const signal = record.cancelled || prepared.stopRequested ? AbortSignal.abort() : deps.signal
  const noteCancelled = (stage: Stage): void => recordCancellation(record, stage)

  // ---- stage 3: route ----
  //
  // The CANONICAL set, never `record.pool`: an absorbed member is not a finding
  // the pipeline decides about, and routing one would produce a decision nothing
  // downstream ever reads.
  const routed = route({ findings: record.findings, threshold: record.threshold, clock, policy })
  if (policy === "debate-off") record.routingPolicy = policy
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
    ...(routed.intervention === undefined ? {} : { intervention: routed.intervention }),
  }

  // ---- stage 4: debate ----
  //
  // The CANONICAL set again, and the whole of it: `debate()` picks out its own
  // `route: "debate"` partition rather than being handed a filtered array, so
  // the one place that decides what is contested stays `route`, and the stage
  // returns the same array it was given (it never filters).
  //
  // `answeredSlots` and `framedChange` come from `prepared`: discovery decided
  // who is still eligible, and the span is the one discovery saw.
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
    // CAP-8 (story 10) — the judge is the only stage that drives it, and this is
    // the seam that hands it over. `undefined` is a supported value, not a hole.
    tools: deps.tools,
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
    factChecksMadExecuted: judged.factChecksMadExecuted,
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

  // AC2 (story 2.3) — DRAIN AND RECONCILE, SYNCHRONOUSLY, IN THE LAST MOMENT
  // THE RECORD IS STILL OPEN.
  //
  // ## Why exactly here
  //
  // Every turn-issuing stage has returned, so every unknown this run can produce
  // is already on the ledger and a late report has something to match against.
  // And `finishedAt` has not been stamped, so a figure recovered here is inside
  // the record rather than an amendment to a run that already claimed to be
  // finished. One line later would be a record closed over a total that then
  // changed; one stage earlier would drain before the turns that produce most of
  // the unknowns had run.
  //
  // ## Why nothing is awaited, and what that costs
  //
  // `drain()` is synchronous BY TYPE (`core/ports/late-usage.ts`), so "the run
  // waits for no completion it cannot guarantee" is a property of the port and
  // not of this call site's discipline. The cost is stated rather than hidden:
  // usage that arrives after this line is NOT in this run's record. The sink
  // still holds it and nothing throws it away, and no part of this story
  // pretends the record is closed over a number that had not arrived.
  //
  // ## What is deliberately NOT done here
  //
  // A recovery does not retract the `usage-unquantified` warning the stage
  // raised when it observed the gap. That warning is a true statement about what
  // the stage saw, and rewriting a stage's honest observation from the assembly
  // is a worse property than a run that reports a degradation it later recovered
  // from — over-reporting a degradation is noise, under-reporting one is the
  // failure AD-6 exists to prevent (`core/domain/warning.ts`). The
  // MACHINE-READABLE answer follows the recovery either way, because
  // `usageIsComplete` reads the collection rather than a flag.
  if (deps.lateUsage) {
    const reconciled = reconcileLateUsage(record.ledger, deps.lateUsage.drain())
    // `evaluation-protocol.md:504-507` — disagreeing payloads for ONE physical
    // execution are an integrity error, not something to deduplicate by
    // first-seen. `reconcileLateUsage` therefore leaves the unknown UNKNOWN, and
    // this is the sentence that says so: without it the only trace of the
    // disagreement would be a number that never appeared.
    if (reconciled.conflicts.length > 0) {
      record.warnings.push({
        code: "usage-unquantified",
        // NOT a turn-issuing stage. The reconciliation runs as the record
        // closes, and naming `judge` — the last stage that actually spent — would
        // put a fact the judge never saw in the judge's name.
        stage: "output",
        message:
          `USAGE REPORTS DISAGREE: ${reconciled.conflicts.length} execution(s) were reported with ` +
          `two or more DIFFERENT token payloads, so MAD cannot say what they cost and has left ` +
          `them UNKNOWN. Every payload is in the detail — nothing was deduplicated by first-seen, ` +
          `and no figure was chosen between them.`,
        detail: {
          conflicts: reconciled.conflicts.length,
          executions: reconciled.conflicts,
          recovered: reconciled.recovered.length,
          unmatched: reconciled.unmatched.length,
          stillUnknown: reconciled.stillUnknown,
        },
      })
    }
  }

  record.finishedAt = clock.now()
  const rendered = output(record)

  return { record, rendered }
}

/**
 * The whole review: prepare, then continue under the shipped policy, with the
 * caller's own ports. One run identity and one late-usage sink across both
 * halves, drained once as the record closes.
 */
export async function review(deps: ReviewDeps): Promise<ReviewResult> {
  return continueReview(await prepareReview(deps), deps)
}
