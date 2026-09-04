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

export interface TokenLedger {
  entries: LedgerEntry[]
  total: TokenUsage
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
  return { entries: [], total: emptyTokenUsage(), cap, maxConcurrency, shares }
}

export function recordTurn(ledger: TokenLedger, entry: LedgerEntry): void {
  ledger.entries.push(entry)
  ledger.total = addTokens(ledger.total, entry.tokens)
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
