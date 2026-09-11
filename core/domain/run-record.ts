/**
 * AD-16 — the run record is a first-class in-memory object.
 *
 * A run produces one `RunRecord` holding the finding set, the roster, the
 * degradation warnings, and the token ledger. Output renders it; the ablation
 * (story 9) reads two of them. v1 keeps it in memory and writes NOTHING — no
 * file is created in the user's repo. Serializing it is an adapter-side concern
 * that may be added behind a flag without touching a stage.
 *
 * AMENDED 2026-08-30 (story 7A): "writes NOTHING" above is the DEFAULT, and it
 * is still what a fresh install does. AD-16's optional, additive persistence now
 * exists — off unless the user turns it on, adapter-side, and never inside the
 * user's repo. Nothing in this module knows about it.
 */

import { DEFAULT_MAX_CONCURRENCY } from "../budget/limiter.ts"
import { CUMULATIVE_SHARE, type Preset, type SpendShares } from "../budget/presets.ts"
import type { InstructionOrigin } from "../instructions/types.ts"
import type { Finding, Stage } from "./finding.ts"
import type { Roster } from "./roster.ts"
import type { Warning } from "./warning.ts"

/**
 * AD-11 amended / AD-17e — one lens slot's instruction provenance.
 *
 * `InstructionOrigin` is imported as a TYPE ONLY: this records what the run got,
 * it does not reach into the instruction layer to get it. The alternative was a
 * second declaration of the same two-member union, which is one rename away from
 * a record that disagrees with the registry it describes.
 */
export interface LensInstructionRecord {
  lens: string
  origin: InstructionOrigin
}

/**
 * AD-15 — MAD budgets in tokens, never currency. These are the integers the
 * host reports per assistant message; `cost` is deliberately not carried,
 * because its unit is undocumented.
 */
export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export function emptyTokenUsage(): TokenUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

export function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

/**
 * AD-15 — the unit of allocation is one turn, the same unit
 * `ModelBackend.runTurn` bills. Story 5 grows this into the `BudgetLedger` that
 * answers "may I spend?"; story 1 only records.
 */
export interface LedgerEntry {
  slot: string
  stage: string
  attempt: number
  tokens: TokenUsage
}

/**
 * FR10 / AC1 (story 2.3) — ONE TURN WHOSE COST MAD DOES NOT KNOW.
 *
 * Three real states produce one of these: a turn cancelled while in flight, a
 * turn MAD stopped waiting on at its deadline, and a turn that SETTLED
 * SUCCESSFULLY with the host reporting no `tokens` field at all. All three
 * billed whatever the provider billed. None of them told MAD the number.
 *
 * ## Why this is a separate type and not a nullable `tokens` on `LedgerEntry`
 *
 * Decided 2026-09-10 by the human, from two options. `tokens: TokenUsage | null`
 * on `LedgerEntry` puts every turn in one collection — which is tidier to read
 * and changes what `entries` and `total` MEAN for every existing reader
 * (`core/stages/output.ts:1621` prints `entries.length` as billed turns,
 * `ablation/compare.ts:143` compares it across arms, `ablation/manifest.ts:206`
 * records it). It also needs the dated AD-15 semantic amendment
 * `evaluation-protocol.md:500-509` describes.
 *
 * A second collection leaves `TokenUsage`, `LedgerEntry`, `addTokens` and
 * `recordTurn` byte-identical, and buys one property that the tidier option
 * cannot: **there is no code path by which an unknown becomes a number.** Not a
 * zero, not a `NaN`, not an interpolation — the type system has nowhere to put
 * one. AC1's "no unknown value is ever estimated or interpolated" is then a
 * structural fact rather than a discipline somebody has to keep.
 *
 * The cost is stated rather than hidden: a reader wanting "how many turns did
 * this run bill?" has to read TWO collections, which is why every renderer this
 * story touches says *observed* where it used to say nothing.
 *
 * ## `executionId`, and why it is not `stage + slot + attempt`
 *
 * Those three are NOT a unique id (`evaluation-protocol.md:504-507`): debate
 * rounds and different judge findings reuse all three. `executionId` names ONE
 * physical model request, minted by the backend at the call site where the
 * physical execution happens, so a late usage report can be matched back to the
 * turn that incurred it (`reconcileLateUsage`) and so the identities AC4's stop
 * rule requires MAD to record are identities of something real.
 *
 * ## `why` is mandatory and NON-EMPTY
 *
 * The same rule `ablation/manifest.ts:87` applies to `unknownValue`, restated
 * here rather than imported, because `core/` may not import `ablation/`. The
 * reasoning is the same as it is there: `?` says "this may be missing" and stays
 * silent about the cause, and "cancelled in flight", "timed out" and "the host
 * reported nothing" are three different facts that a reader — and story 2.3's
 * governor — act on differently. What enforces non-emptiness is
 * `recordUnknownTurn`, by SUBSTITUTION and never by throwing; see its own
 * comment for why losing the unknown is the one unacceptable outcome.
 */
export interface UnknownUsageEntry {
  slot: string
  stage: string
  attempt: number
  /** ONE physical model request. See the header: not `stage + slot + attempt`. */
  executionId: string
  /** Non-empty, always. Which of the three states this is, in words. */
  why: string
}

/**
 * AC2 (story 2.3) — a token payload a provider supplied AFTER MAD stopped
 * waiting for it, keyed to the physical execution it belongs to.
 *
 * IT IS DECLARED HERE, IN THE DOMAIN, AND RE-EXPORTED BY
 * `core/ports/late-usage.ts`, which is where a caller imports it from. The split
 * is deliberate and it is not a duplication: the DOMAIN owns the vocabulary of
 * what usage is (`TokenUsage` has lived here since story 1, and
 * `reconcileLateUsage` below is the one function that consumes a report), while
 * the PORT owns the mechanism by which one is delivered. Declaring it in the
 * port instead would mean `core/domain/` importing `core/ports/` — and
 * `core/ports/model-backend.ts` already imports `TokenUsage` from this file, so
 * that arrow is a module cycle. Restating the shape in both places was the other
 * option and was rejected: two structurally identical types with two names is
 * one field edit away from a reconciler that silently accepts a payload it
 * cannot read.
 *
 * It carries the id and the tokens and NOTHING ELSE. The provider knows what it
 * billed; MAD knows which slot, stage and attempt asked for it. A report that
 * also carried provenance would let an adapter decide what a ledger row says
 * about the pipeline, which is a fact an adapter does not hold.
 */
export interface LateUsageReport {
  executionId: string
  tokens: TokenUsage
}

/**
 * `evaluation-protocol.md:504-507` — "Disagreeing token payloads for one
 * physical execution are an **integrity error**, not something to deduplicate by
 * first-seen."
 *
 * So it is reported, and BOTH payloads ride along, because the useful question
 * for a human reading it is *how far apart are they* — and because a summary
 * that recorded only "there was a conflict" would leave the reader unable to
 * tell a rounding disagreement from a factor of ten.
 */
export interface UsageIntegrityConflict {
  executionId: string
  /** Every DISTINCT payload reported for this execution, in arrival order. */
  payloads: TokenUsage[]
}

/**
 * What one `reconcileLateUsage` pass did — returned rather than logged, and
 * returned rather than thrown.
 *
 * The caller (`core/run/review.ts`, story 2.3 task 11) uses it to raise the
 * warnings that describe the pass; nothing here decides whether the run is
 * degraded, because that is AD-6's question and this module only records.
 */
export interface LateUsageReconciliation {
  /** The unknowns this pass turned into counted spend. */
  recovered: UnknownUsageEntry[]
  /** Reports naming an execution this ledger holds no unknown for. */
  unmatched: LateUsageReport[]
  /** One execution, two payloads that do not agree. */
  conflicts: UsageIntegrityConflict[]
  /** How many unknowns are STILL unknown when the pass ends. */
  stillUnknown: number
}

export interface TokenLedger {
  entries: LedgerEntry[]
  total: TokenUsage
  /**
   * FR10 / AC1 (story 2.3) — every turn whose cost is NOT KNOWN.
   *
   * REQUIRED AND NEVER OPTIONAL, for exactly the reason `cap` is required:
   * absent and none must not be two ways of saying the same thing. An optional
   * field would let a ledger built before this question existed read as "this
   * run's usage is complete" — the flattering answer — at the one site that
   * matters most, since `core/budget/ledger.ts`'s gate refuses to spend past a
   * non-empty one and `ablation/manifest.ts` writes its audit verdict from it.
   *
   * It sits BESIDE `entries` and never inside it. `UnknownUsageEntry`'s header
   * carries the whole argument and the rejected alternative; the short version
   * is that `entries.length` means "billed turns" to three existing readers and
   * `total` means "the bill", and an unknown in either would put a number where
   * there is none.
   *
   * Nothing in this module enforces anything about it, because recording and
   * permitting are different jobs — the same division `cap` and `shares` are
   * documented under. `core/budget/ledger.ts` answers `usageIsComplete`.
   */
  unknownUsage: UnknownUsageEntry[]
  /**
   * AC4 (story 2.3, `evaluation-protocol.md:332-339`) — WHETHER AN UNKNOWN
   * SHOULD STOP THE SPENDING.
   *
   * REQUIRED, and `emptyLedger` defaults it `false`, which means an ordinary
   * code review REPORTS an unknown honestly and then keeps working.
   *
   * IT IS A DIAL AND NOT A CONSTANT, and that is a decision rather than an
   * oversight. The protocol's stop rule is about the EXPERIMENT: on any billed
   * execution whose usage is missing, stop admitting new billable requests
   * experiment-wide, retries and calibration and pilots included. Halting an
   * ordinary review because one host response omitted a `tokens` field would be
   * this story inventing a policy for a caller the protocol never spoke about,
   * and AD-16's rule that evaluation machinery is additive and never changes an
   * ordinary run cuts the same way.
   *
   * The evaluation path sets it `true`, and then the run's OWN accountant
   * refuses the next turn. That keeps the within-run gate in the one place that
   * answers "may I spend?" (`core/budget/ledger.ts:10-19`) instead of adding a
   * second authority beside it — the experiment-wide half is a separate level
   * with a separate authority (`ablation/governor.ts`), never a second gate on
   * the same question.
   *
   * A BOOLEAN AND NOT A THRESHOLD, deliberately. An earlier draft of the
   * protocol capped unquantified exposure at 10% of the cap and the protocol
   * itself struck it out: "that is not an observable predicate — an unknown
   * amount cannot be compared with a number". One unknown is the trigger,
   * because one unknown is all it takes for the comparison to be impossible.
   */
  stopOnUnknownUsage: boolean
  /**
   * AD-15 — the ceiling, in tokens, and `null` MEANS "no ceiling". Required and
   * never optional, for the same reason `RunRecord.threshold` is: absent and
   * unlimited must not be two ways of saying the same thing, and story 8's
   * presets resolve to exactly this field.
   *
   * It lives HERE, beside the spend, rather than as a second dial on
   * `RunRecord`, so "may I spend?" is answerable from ONE object. Two fields
   * that can disagree is the failure AD-15's single accountant exists to
   * prevent. The gate that reads it is `core/budget/ledger.ts`; nothing in this
   * module enforces it, because recording and permitting are different jobs and
   * story 1 only ever did the first.
   */
  cap: number | null
  /**
   * AD-15 amended (story 7A) — the PEAK the run was held to: how many billed
   * turns could be in flight at once. Already clamped; there is no "unlimited"
   * value and `0` is not reachable (`core/budget/limiter.ts`).
   *
   * IT IS A NUMBER AND NOT THE LIMITER ITSELF, deliberately. This record is what
   * story 7A's artifact dump serializes, and `JSON.stringify` drops a function
   * field silently — a dumped ledger whose peak was invisible would be a record
   * that quietly disagrees with the run that produced it. The number lives here,
   * beside the total it is the second time scale of; the semaphore is created
   * from it by `core/budget/limiter.ts` and held only for the length of the run.
   */
  maxConcurrency: number
  /**
   * CAP-7 (story 8) — how far into `cap` each stage may take the run's total,
   * as FRACTIONS of it.
   *
   * It rides here beside `cap` for the reason `cap` itself does: "may I spend?"
   * must be answerable from ONE object, and two fields that can disagree is the
   * failure AD-15's single accountant exists to prevent.
   *
   * FRACTIONS AND NOT TOKEN NUMBERS, and that is the whole point. Three stored
   * token ceilings would be three values derived from `cap` that can stop
   * agreeing with it — precisely the disagreement the paragraph above forbids.
   * A fraction is re-derived at every ask, from whatever cap is actually in
   * force, so it cannot go stale.
   *
   * CUMULATIVE, not a per-stage pot: `shares.debate` is "debate may take the run
   * to 65% of the cap", counting everything discovery already spent. The stages
   * run strictly in sequence, so this is arithmetically a per-stage allowance
   * with no per-stage counter to drift — and unspent budget rolls forward for
   * free. `core/budget/presets.ts` carries the numbers and the reasoning; the
   * gate that reads them is `core/budget/ledger.ts`. Nothing in this module
   * enforces them, because recording and permitting are different jobs.
   */
  shares: SpendShares
}

export interface RunRecord {
  /** Opaque and sortable (spine, Ids). */
  runId: string
  startedAt: string
  finishedAt?: string
  roster: Roster
  /**
   * AD-6a — how many roster models actually answered. Every co-discovery
   * fraction downstream divides by this, never by `roster.requested`.
   */
  answered: number
  /** After clustering, the CANONICAL findings. Before it, the whole pool. */
  findings: Finding[]
  /**
   * The pre-cluster union — every finding discovery raised, in roster order.
   * Required and never optional, for the same reason `lensSlots` and
   * `lensInstructions` are: absent and empty must not be two ways of saying the
   * same thing.
   *
   * THIS IS NOT BOOKKEEPING. Findings are mutated in place (AD-7), so `pool` and
   * `findings` share objects and cannot drift; `findings` is the canonical
   * subset. CAP-1's criterion is a claim about the DISCOVERY POOL, and
   * `fixtures/recall.ts` derives every single-model arm from `finding.author` —
   * measured over a merged set instead, an arm silently loses credit for a
   * finding it really did raise and CAP-1's number degrades with no test failing.
   *
   * AD-16 is unchanged: still in memory, still nothing written to the repo.
   */
  pool: Finding[]
  /**
   * AD-11 amended / AD-17e — the lens slots this run used and whether each one's
   * instruction was shipped or generated at run time. Required and `[]` when no
   * lens ran, for the same reason `Roster.lensSlots` is: absent and empty must
   * not be two ways of saying the same thing.
   */
  lensInstructions: LensInstructionRecord[]
  /**
   * CAP-3 — the co-discovery threshold this run actually routed against, already
   * clamped. Required and never optional, for the same reason `pool` and
   * `lensInstructions` are: absent and defaulted must not be two ways of saying
   * the same thing.
   *
   * It is on the record because a routing summary without its dial is a count
   * nobody can interpret — CAP-3's success criterion is that *changing the
   * threshold alone* changes which findings enter debate, and a reader comparing
   * two runs needs to see the number that differed. Story 8's presets record what
   * they resolved to here.
   */
  threshold: number
  /**
   * CAP-3 — the partition routing produced, as the ROUTE STAGE counted it.
   *
   * Optional, and its ABSENCE is the signal that routing has not run — the same
   * shape `clusterId` uses for clustering (AD-14 amended), and the property that
   * keeps `output()` callable mid-pipeline. It is NOT "absent means zero": a run
   * that routed nothing carries all-zero counts, which is a different fact from a
   * run that never routed.
   *
   * Written here rather than recomputed by the renderer because a partition
   * counted twice is a partition that can disagree with itself. The renderer's
   * copy would necessarily count only the RESOLVED findings it is iterating, so
   * once story 8 writes `unresolved`, a finding that was routed and then died at
   * a later stage would silently drop out of the totals. The stage's own counts
   * cover every finding it decided about, which is what the summary claims to be.
   */
  routeCounts?: RouteCounts
  /**
   * CAP-4 — the round cap this run actually debated under, already clamped.
   * Required and never optional, for exactly the reason `threshold` is: a debate
   * summary without its cap is a count nobody can interpret, and CAP-4's `cap`
   * exit is only readable against the number it hit. Story 8's presets record
   * what they resolved to here.
   */
  maxRounds: number
  /**
   * CAP-4 — the exits debate produced, as the DEBATE STAGE counted them.
   *
   * Optional, and its ABSENCE is the signal that debate has not run — the same
   * shape `routeCounts` uses, and for the same reason: a run that debated
   * nothing carries all-zero counts, which is a different fact from a run that
   * never debated. Counted by the stage that decided them so a renderer cannot
   * produce a second, narrower partition of the same set.
   */
  debateCounts?: DebateCounts
  /**
   * CAP-5 — the verdicts the judge produced, as the JUDGE STAGE counted them.
   *
   * Optional, and its ABSENCE is the signal that judging has not run — the same
   * shape `routeCounts` and `debateCounts` use, and for the same reason: a run
   * that judged nothing carries all-zero counts, which is a different fact from a
   * run that never judged. Counted by the stage that decided them so a renderer
   * cannot produce a second, narrower partition of the same set.
   */
  /**
   * AD-6f (story 7A) — the user stopped the run, and this is the stage it
   * stopped at.
   *
   * Optional, and its ABSENCE means the run was never cancelled — the shape the
   * three `*Counts` fields above already use. It is the FIRST stage to observe
   * the stop, never the last: later stages also see an aborted signal and would
   * each overwrite it with their own name, leaving a record that says the run
   * stopped in `judge` when it actually stopped in `discover` and every stage
   * after that did nothing.
   *
   * It is a fact about the RUN and not about a finding, which is why it lives
   * here and not on `Finding`. A finding left undecided by the stop carries
   * `unresolved` with a cancellation reason, exactly as one stranded by the
   * budget carries `unresolved` with a budget reason (AD-6d, AD-6f: same
   * section, distinct causes).
   */
  cancelled?: { stage: Stage }
  /**
   * CAP-7 (story 8) — the preset this run resolved its dials from, when a caller
   * named one.
   *
   * OPTIONAL, and the absence is a real fact rather than a defaulted one: it
   * says the caller named no preset. It is not "absent means normal" even though
   * `normal` is the identity preset — a reader comparing two reports must be
   * able to tell a run that asked for `normal` from a run that asked for
   * nothing, because the two are the same run today and a table edit is all it
   * would take for them to stop being. The VALUES it resolved to are already on
   * the record separately (`threshold`, `ledger.cap`, `ledger.maxConcurrency`,
   * `lensSlots`), so this field never has to be trusted to reconstruct them.
   */
  preset?: Preset
  /**
   * AD-6a / AD-15 (story 8) — the discovery slots the BUDGET refused, by slot
   * id.
   *
   * A THIRD FACT, and not either of the two beside it. These models did not fail
   * (`roster` / `model-dropped-out`) and the user did not stop the run
   * (`cancelled`): MAD decided not to issue the turn, because issuing it would
   * have taken the run past discovery's share of the cap. Folding it into either
   * neighbour is the false-degradation report this whole tool exists to prevent
   * — one blames a working provider, the other blames the user.
   *
   * It shrinks `answered`, and that is honest: `answered` counts answers, never
   * requests. What must not happen, and does not, is a MODEL being named as the
   * cause.
   *
   * Optional for the reason `cancelled` is optional: absent is the ordinary run.
   */
  skippedForBudget?: string[]
  judgeCounts?: JudgeCounts
  warnings: Warning[]
  ledger: TokenLedger
}

/**
 * CAP-3 — the routed partition, counted once by the stage that decided it.
 *
 * The judge bucket is split by WHY, and that split is load-bearing rather than
 * decorative: a finding reaches the judge either because its fraction cleared the
 * dial or because it never had a fraction at all (AD-17d). Reporting one total
 * and captioning it "at or above the threshold" would state the second case as
 * the first — the exact conflation AD-9's amendment forbids, said in the summary
 * line instead of in the comparator.
 *
 * `toJudge === toJudgeAtThreshold + toJudgeNoPrior`, always.
 */
export interface RouteCounts {
  toDebate: number
  toJudge: number
  /** Judged because `raised / answered >= threshold`. A claim about a comparison. */
  toJudgeAtThreshold: number
  /** Judged because there was no prior to compare — lens-sourced (AD-17d). */
  toJudgeNoPrior: number
}

/**
 * CAP-4 — the debated partition, counted once by the stage that decided it.
 *
 * `debated === converged + stalled + cap + unresolved`, always. The four buckets
 * are separate claims and are never summed into one "debate finished" number:
 * `stalled` is the exit that SAVED tokens (`cost-model.md` lever 3), `cap` is
 * the one that spent them all, and `unresolved` is not an exit at all — it is
 * AD-6d's budget exhaustion, which leaves a finding with no `exit` on purpose.
 *
 * `rounds` and `turns` are the cost, in the two units that matter: `rounds` is
 * how many batched rounds ran, `turns` is how many ALLOCATIONS were requested
 * (AD-15: one batched turn covering nine findings is one allocation, not nine).
 */
export interface DebateCounts {
  /** Findings that entered debate — the `route: "debate"` partition. */
  debated: number
  converged: number
  /**
   * A SUBSET of `converged` — never added to it. Only ONE participant ever
   * stated a position, so nothing was contested and nothing was agreed.
   *
   * It is counted because AD-6 forbids a degraded review from reading like a
   * good one, and `converged` alone cannot tell them apart: a room where two
   * models examined the claim and settled, and a room where everyone but the
   * author dropped out, land on the same word. `Finding.exit` is three values
   * and this story may not widen it, so the distinction lives here and in the
   * exit entry's `kind` (`debate-exit-converged-uncontested`), which is where
   * story 6's judge reads it.
   */
  convergedUncontested: number
  /**
   * A SUBSET of `converged` — never added to it. Every standing position was
   * `unsure`: the participants agree only that the evidence did not settle it.
   *
   * Counted separately for the same reason as the field above, and it is the one
   * the judge most needs: unanimous uncertainty is precisely the case that must
   * not reach a reader as a settled debate.
   */
  convergedUnsure: number
  stalled: number
  cap: number
  /** AD-6d — undecided when the budget ran out. Not an exit; no `exit` is set. */
  unresolved: number
  /** Batched rounds actually run across the whole stage. */
  rounds: number
  /**
   * Turns REQUESTED — the AD-15 unit of allocation. One batched turn covering
   * nine findings is one allocation, and a turn that needed its one retry is
   * still one allocation.
   */
  turns: number
  /**
   * Turns BILLED — every attempt that reported tokens, which is what reaches the
   * ledger. `attempts >= turns` always, and they differ exactly when a turn was
   * retried. Carried beside `turns` rather than collapsed into it because the
   * rendered run prints the ledger's totals on the same page, and one number
   * captioned as the other is arithmetic a reader has no way to check.
   */
  attempts: number
}

/**
 * CAP-3 — the ONE way the threshold is written for a human, so the routing stage
 * and the renderer cannot disagree about what dial a run used.
 *
 * A percentage, because that is the vocabulary `cost-model.md` states the dial in
 * ("100% debates everything, 50% debates almost nothing"). Rounded to TWO DECIMAL
 * PLACES of a percent with trailing zeros trimmed, so `0.8` reads `80%` and an
 * awkward `0.667` reads `66.7%`.
 *
 * Rounding at that place is a real, if small, loss: `1/3` renders `33.33%` while
 * `meetsThreshold` compares against `0.3333…`. The precision is chosen to keep the
 * printed dial from landing on a NEIGHBOURING round number a reader would take for
 * the setting — `0.667` must not read `67%`, which routes `2/3` the other way —
 * not to reproduce the double. A caller that needs the exact value reads
 * `RunRecord.threshold`.
 */
export function formatThreshold(threshold: number): string {
  return `${Number.parseFloat((threshold * 100).toFixed(2))}%`
}

export function emptyLedger(
  cap: number | null = null,
  maxConcurrency: number = DEFAULT_MAX_CONCURRENCY,
  shares: SpendShares = CUMULATIVE_SHARE,
): TokenLedger {
  return {
    entries: [],
    total: emptyTokenUsage(),
    cap,
    maxConcurrency,
    shares,
    // Story 2.3 — PRESENT AND EMPTY, never absent, and `false` rather than
    // undefined. Both are required fields whose empty value is a real fact; see
    // their comments on `TokenLedger`. They take no positional parameter here
    // because no ordinary caller sets either: unknowns arrive by
    // `recordUnknownTurn` during the run, and the stop dial is set by the
    // evaluation path alone (AD-16 — additive, never changing an ordinary run).
    unknownUsage: [],
    stopOnUnknownUsage: false,
  }
}

/**
 * The same ledger with different stage shares — WITHOUT restating the dials the
 * caller does not care about (ledger triage 2026-09-09).
 *
 * `shares` is `emptyLedger`'s THIRD positional parameter, so setting it meant
 * naming a `maxConcurrency` as well, and the one caller that needed custom
 * shares (`core/stages/debate.test.ts`) worked around that by MUTATING
 * `ledger.shares` after construction — the very field
 * `scripts/lint-dependency-direction.ts` forbids a stage to touch. A copy, not a
 * mutation, so a ledger already handed to something else is unaffected.
 */
export function withShares(ledger: TokenLedger, shares: SpendShares): TokenLedger {
  return { ...ledger, shares }
}

export function recordTurn(ledger: TokenLedger, entry: LedgerEntry): void {
  ledger.entries.push(entry)
  ledger.total = addTokens(ledger.total, entry.tokens)
}

/**
 * The sentence a blank `why` becomes. Exported so the substitution is TESTED
 * rather than trusted, the pattern `clampTokenCap` and the three other clamps
 * set — and so a reader who finds it in a record can search for it and land
 * here rather than guessing which layer wrote it.
 */
export const UNKNOWN_USAGE_UNSTATED_REASON = "unknown usage with no reason recorded"

/**
 * FR10 / AC1 (story 2.3) — THE SECOND WRITER, beside `recordTurn`.
 *
 * `recordTurn` says what a turn cost. This says that MAD does not know what a
 * turn cost, which before this story was not sayable at all: a cancelled,
 * timed-out or thrown turn wrote NOTHING — no entry, no marker, no count — so
 * the run total was not merely wrong, it did not know it was wrong.
 *
 * It writes to `unknownUsage` and touches NEITHER `entries` NOR `total`. That is
 * the whole point of the second collection and it is asserted in
 * `run-record.test.ts`, not merely promised here.
 *
 * ## A BLANK `why` IS SUBSTITUTED, NEVER THROWN ON AND NEVER DROPPED
 *
 * `why` is typed mandatory, so TypeScript already rejects the ordinary mistake;
 * this covers the JavaScript caller and the empty string, the way every clamp in
 * `core/budget/ledger.ts` covers the seam TypeScript cannot police. Both
 * alternatives were rejected for the same reason:
 *
 * - **Throwing** would make a programmer's empty string DELETE an unknown from
 *   the record. A lost unknown reads as a free turn, which is the exact lie this
 *   story exists to remove, so the failure mode of the validation would be the
 *   failure mode the validation is for.
 * - **Dropping it silently** is the same outcome with no traceback.
 *
 * A recorded unknown with a weak reason is strictly better than no record, so
 * the reason is replaced and the unknown is kept. `recordTurn`'s neighbour
 * behaviour is unchanged in kind: nothing in this module throws.
 */
export function recordUnknownTurn(ledger: TokenLedger, entry: UnknownUsageEntry): void {
  const why =
    typeof entry.why === "string" && entry.why.trim().length > 0
      ? entry.why
      : UNKNOWN_USAGE_UNSTATED_REASON
  ledger.unknownUsage.push({ ...entry, why })
}

/**
 * Whether a value is a `TokenUsage` MAD may actually ADD — all five fields
 * present, and every one of them a finite number.
 *
 * It is deliberately stricter than "is an object with the right keys". A late
 * usage report reaches `reconcileLateUsage` through an exported seam, so a
 * partial or non-numeric payload is reachable, and the consequence of admitting
 * one is not a wrong row: `addTokens` propagates `NaN` across the run total
 * while the matching unknown entry is removed, so the ledger loses the record
 * that it could not count AND the number it replaced it with is unusable.
 *
 * `Number.isFinite` covers `NaN`, both infinities, `undefined` and every
 * non-number in one check — the same reason `clampTokenCap` reaches for it in
 * `core/budget/ledger.ts` rather than testing `typeof` and `NaN` separately.
 * Negative values are rejected too: a provider reporting `-5` output tokens has
 * reported something MAD cannot interpret, and interpreting it anyway is the
 * estimation AC1 forbids.
 */
function isCountableUsage(value: unknown): value is TokenUsage {
  if (value === null || typeof value !== "object") return false
  const usage = value as Record<string, unknown>
  for (const field of ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const) {
    const n = usage[field]
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return false
  }
  return true
}

/** The five integers, compared field by field. Two payloads or one fact. */
function sameUsage(a: TokenUsage, b: TokenUsage): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.reasoning === b.reasoning &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite
  )
}

/**
 * AC2 (story 2.3) — LATE USAGE, RECOVERED INTO THE RECORD.
 *
 * A provider that answers after MAD stopped waiting for it eventually reports
 * what the request actually cost. `core/ports/late-usage.ts` collects those
 * reports without anything awaiting them, and this is the function that folds a
 * drained batch back into the ledger: a matched unknown MOVES into `entries`
 * with its real tokens and is added to `total`, so a turn MAD could not count
 * at the time becomes a turn MAD counted.
 *
 * ## What it deliberately does NOT do
 *
 * - **It invents nothing.** An unknown nobody reported stays unknown, and a
 *   report naming an execution this ledger holds no unknown for changes nothing
 *   at all — it is returned in `unmatched`. MAD does not learn about a turn from
 *   a bill: an entry created here from an unmatched report would be a ledger row
 *   with no slot, stage or attempt that any stage ever ran.
 * - **It does not deduplicate a disagreement by first-seen.**
 *   `evaluation-protocol.md:504-507` names that an INTEGRITY ERROR, and this
 *   honours it by leaving the unknown UNKNOWN and reporting both payloads. Two
 *   numbers MAD cannot choose between is not one number; picking either would
 *   put an undefendable figure into the column this whole story is about, and
 *   picking the smaller one would do it in the flattering direction.
 * - **It does not treat a repeat delivery as a disagreement.** The protocol's
 *   rule is about disagreement, and a reporter that delivered the same payload
 *   twice has told MAD one thing twice. Counting it twice would double a real
 *   bill — the opposite error, equally wrong.
 * - **It throws nothing**, for the reason `core/budget/ledger.ts:21-26` gives
 *   for the gate: a record that threw would make a run whose provider was slow
 *   with its accounting look like a run that crashed. Every refusal is a value
 *   in the returned summary.
 *
 * ## The honest limit, stated rather than hidden
 *
 * Disagreement is detected WITHIN one batch. Once an unknown has been
 * reconciled its `executionId` is gone from `unknownUsage`, and `LedgerEntry`
 * carries no execution id (it stays byte-identical, which is the story's whole
 * structural argument), so a payload arriving in a LATER batch for an
 * already-reconciled execution comes back as `unmatched` rather than as a
 * conflict. In the shipped wiring that gap is unreachable — `core/run/review.ts`
 * drains once, immediately before `finishedAt` — and it is written down here
 * rather than left for a reader to discover. Carrying the ids on `entries` to
 * close it is story 2.5A's inherited-entry provenance, which is where the AD-15
 * semantic amendment for it belongs.
 *
 * Usage arriving after the drain is not in this run's record, and this story
 * does not pretend otherwise.
 */
export function reconcileLateUsage(
  ledger: TokenLedger,
  reports: readonly LateUsageReport[],
): LateUsageReconciliation {
  const recovered: UnknownUsageEntry[] = []
  const unmatched: LateUsageReport[] = []
  const conflicts: UsageIntegrityConflict[] = []

  // Grouped by execution FIRST, so a disagreement is seen before either payload
  // is applied. Applying as we go and detecting afterwards would mean the first
  // payload had already entered `total` by the time the second contradicted it,
  // and unwinding a total is exactly the kind of arithmetic that ends up off by
  // one turn.
  const byExecution = new Map<string, LateUsageReport[]>()
  const order: string[] = []
  for (const report of reports ?? []) {
    // `review()` is an exported seam and a JavaScript caller can reach the sink
    // that feeds this with anything. A malformed report is ignored rather than
    // thrown on, and it is not counted as unmatched either: `unmatched` is a
    // claim about executions, and this is not one.
    if (report === null || typeof report !== "object") continue
    const id = report.executionId
    if (typeof id !== "string" || id.length === 0) continue
    if (report.tokens === null || typeof report.tokens !== "object") continue
    // AND THE FIVE NUMBERS INSIDE IT, not merely the object around them (review
    // 2026-09-10, found by two independent verifiers on the same commit).
    //
    // Checking the wrapper and trusting its contents was the one hole through
    // which an unknown could still become a number: `{ input: 5 }` passed the
    // `typeof` test, `addTokens` summed `5 + undefined` into `NaN` for the other
    // four fields, and the unknown entry was SPLICED OUT while it happened. The
    // ledger then held a `NaN` total, `usageIsComplete` answered `true`, and
    // `mayISpend` stopped applying AC4's stop rule — a run that could not count
    // its own spend reporting itself as fully counted, which is the exact
    // failure this story exists to delete, reintroduced by the recovery path.
    //
    // `isCountableUsage` rather than a cast, because a cast asserts what a
    // JavaScript caller can trivially falsify, and the sink this reads is fed
    // through an exported seam.
    if (!isCountableUsage(report.tokens)) continue
    const group = byExecution.get(id)
    if (group) group.push(report)
    else {
      byExecution.set(id, [report])
      order.push(id)
    }
  }

  for (const id of order) {
    const group = byExecution.get(id)!
    const distinct: TokenUsage[] = []
    for (const report of group) {
      if (!distinct.some((seen) => sameUsage(seen, report.tokens))) distinct.push(report.tokens)
    }

    if (distinct.length > 1) {
      conflicts.push({ executionId: id, payloads: distinct })
      continue
    }

    const at = ledger.unknownUsage.findIndex((entry) => entry.executionId === id)
    if (at === -1) {
      unmatched.push(...group)
      continue
    }

    // The unknown's provenance is what the entry carries, never the report's:
    // the provider knows what it billed and MAD knows which slot, stage and
    // attempt asked for it.
    const entry = ledger.unknownUsage[at]!
    ledger.unknownUsage.splice(at, 1)
    recordTurn(ledger, {
      slot: entry.slot,
      stage: entry.stage,
      attempt: entry.attempt,
      tokens: distinct[0]!,
    })
    recovered.push(entry)
  }

  return { recovered, unmatched, conflicts, stillUnknown: ledger.unknownUsage.length }
}

/**
 * CAP-5 — the judged partition, counted once by the stage that decided it.
 *
 * TWO partitions of one set, and they are deliberately separate rather than one
 * table with more columns:
 *
 *   `judged === adjudicated + verifiedIndependently + withdrawnByAuthor + unresolved`
 *
 * is a claim about HOW each finding was handled, and
 *
 *   `judged === upheld + ruledInvalid + notAdjudicated + withdrawnByAuthor + unresolved`
 *
 * is a claim about WHAT was decided. Both always hold. Fusing them would force a
 * cell like "upheld in verify-independently mode", which is a cross-tab nobody
 * asked for and which grows multiplicatively the moment a mode or a verdict is
 * added.
 *
 * `withdrawnByAuthor` appears in both because it is both: a way of being handled
 * (no model turn was spent) and a verdict. `unresolved` appears in both and is
 * NEITHER a mode nor a verdict — it is AD-6d's budget exhaustion, and a finding
 * carrying it has no verdict at all, on purpose.
 */
export interface JudgeCounts {
  /**
   * Findings the stage REACHED — everything that arrived routed and undead.
   *
   * "Reached", not "decided" (code review 2026-08-28). `unresolved` and
   * `notExamined` are both counted in here and neither was decided by anybody, so
   * a summary line calling this number "decided" over-counts in the flattering
   * direction (AD-6). The five buckets below sum to it exactly:
   * `adjudicated + verifiedIndependently + withdrawnByAuthor + unresolved +
   * notExamined === judged`.
   */
  judged: number
  /**
   * The MODE, not a completion record (clarified by code review 2026-08-28): a
   * finding that arrived with a transcript and took the four-turn path — extract,
   * then fact-check and logic-eval, then aggregate.
   *
   * It is counted even when the extractor or the fact-checker dropped out,
   * because the mode is what the stage CHOSE and the partition above has to sum.
   * What was actually completed is reported by `factChecksUnverified` and
   * `factChecksDroppedOut`, which is where a reader looks to discount it.
   */
  adjudicated: number
  /**
   * Fact-Checker only, no Logic Evaluator, ONE billed turn
   * (`pipeline-stages.md` §5).
   *
   * The condition is NO TRANSCRIPT, not `route: "judge"` — the two are usually
   * the same and are not always (code review 2026-08-27). A finding routed to
   * debate whose room never produced a position arrives here too: there is no
   * argument to extract and none to evaluate, so it gets the same one-turn path
   * and the Fact-Checker is again its first and only skeptic. Counting it as
   * `adjudicated` would claim an argument was weighed that never existed.
   */
  verifiedIndependently: number
  /**
   * AD-6/AD-12 — fact-check turns that never completed: the slot failed both
   * attempts (code review 2026-08-28).
   *
   * Distinct from `factChecksUnverified`, which counts checks that DID answer
   * while opening nothing. Without this, a verify-independently finding whose one
   * and only check dropped out was still counted in `verifiedIndependently` and
   * printed as "checked independently" — nothing had been checked at all, and no
   * other line said so.
   */
  factChecksDroppedOut: number
  /**
   * AD-6 — findings the stage could not examine because no model was left to
   * judge (code review 2026-08-28).
   *
   * Its own bucket rather than `unresolved`, because the causes are different and
   * a reader acts on them differently: `unresolved` means the money ran out and
   * more budget would decide it, this means every eligible slot is dead. The
   * `judge-unavailable` warning stated it in prose and gave no number to check
   * the prose against.
   */
  notExamined: number
  /** Short-circuited: the author withdrew in debate, so no model turn was spent. */
  withdrawnByAuthor: number
  upheld: number
  ruledInvalid: number
  /**
   * The judge ran and did NOT settle it — an honest undecided, not a failure and
   * not a bucket for anything else. Also where a finding lands when its
   * aggregator turn dropped out, because a missing ruling is not a ruling.
   */
  notAdjudicated: number
  /**
   * AD-6d/AD-6f — the finding was left undecided. TWO CAUSES SHARE THIS FIELD,
   * because the UNRESOLVED section and the partition sum both need the total, and
   * `unresolvedByCancellation` below carries the split rather than a second total
   * that could drift from this one.
   */
  unresolved: number
  /**
   * AD-6f (story 7A, code review 2026-08-31) — HOW MANY OF `unresolved` THE USER
   * CAUSED. The budget's share is `unresolved - unresolvedByCancellation`, which
   * is how the two judge warnings already split it. Carried on the record because
   * the JUDGE summary line prints the same split and used to print the whole of
   * `unresolved` as "stranded by the budget" — telling a reader the token cap
   * stranded findings their own stop stranded, over a run where the budget was
   * fine.
   */
  unresolvedByCancellation: number
  /**
   * AD-13 — fact-checks that ran on a slot with no tools, or whose checker
   * reported using none. A reasoning-only check is not a fact-check, and a run
   * where every one of them was unverified must not read like a run where the
   * files were actually opened.
   */
  factChecksUnverified: number
  /**
   * CAP-8 / AD-13's FIRST route (story 10) — fact-checks where MAD RAN THE CHECK
   * ITSELF.
   *
   * `factVerified` says a fact was established; this says MAD executed the
   * evidence rather than being told about it. Two adjacent facts, two counters,
   * on the `factChecksDroppedOut` vs `factChecksUnverified` precedent — a run
   * where every check was self-reported and a run where MAD ran `git blame`
   * itself both report verified checks, and without this number nothing
   * separates them.
   *
   * Zero is the ordinary value for a run with no `Tools` port injected, which is
   * AD-13's second route and not a degradation.
   */
  factChecksMadExecuted: number
  /**
   * Turns REQUESTED — the AD-15 unit of allocation. The judge does NOT batch
   * across findings, so this is a per-finding count, unlike debate's.
   */
  turns: number
  /**
   * Turns BILLED — every attempt that reported tokens. `attempts >= turns`
   * always, and they differ exactly when a turn needed its one retry.
   */
  attempts: number
}
