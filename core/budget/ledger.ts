/**
 * AD-15 — the one accountant, and the ONE thing that answers "may I spend?".
 *
 * `core/domain/run-record.ts` has recorded every turn's tokens since story 1.
 * What it never did was PERMIT one. Recording and permitting are different jobs
 * and this module is the second: a ceiling beside the spend, and a gate a stage
 * asks before it starts a turn. Story 5 shipped exactly that much, because that
 * is exactly what CAP-4's `cap` exit and AD-6d's exhaustion path consume.
 *
 * STORY 8 EXTENDED THIS GATE RATHER THAN GROWING A SECOND ONE BESIDE IT — two
 * authorities on "may I spend?" is the failure AD-15's single accountant exists
 * to prevent. `mayISpend` now takes the stage doing the asking and compares the
 * run's ONE total against that stage's cumulative share of the ONE cap
 * (`core/budget/presets.ts`). The stage passes a string naming itself and gets a
 * boolean back; it holds no allowance, computes no ceiling, and does not phrase
 * its own refusal — `ceilingClause` and `ceilingNamed` come from here too, so
 * the two stranding stages cannot drift apart in what they tell the user. That
 * a stage never does budget arithmetic is enforced in
 * `scripts/lint-dependency-direction.ts` rather than promised here.
 *
 * **Exhaustion is not an error** (AD-15, AD-6d). Nothing here throws. A refusal
 * is a `false`, and the stage that got it marks its undecided findings
 * `unresolved { diedAtStage }` and reports where it stopped. A budget that
 * threw would make a run that ran out of money look like a run that crashed,
 * which is the same class of dishonesty as making it look like one that
 * finished.
 *
 * Imports nothing but the domain (AD-1). No port, no stage, no adapter.
 */

import {
  recordTurn,
  type LedgerEntry,
  type TokenLedger,
  type TokenUsage,
} from "../domain/run-record.ts"
import { CUMULATIVE_SHARE, type SpendStage } from "./presets.ts"

/**
 * The ledger, seen from the side that DECIDES rather than the side that
 * records.
 *
 * It is the same object `RunRecord.ledger` holds — `cap` is restated here so
 * this module's contract does not depend on a reader following the field back
 * to the domain type, and so a future caller can type a parameter as "a ledger
 * with a ceiling" without importing the whole run record. Structurally
 * identical on purpose: a `TokenLedger` IS a `BudgetLedger`, so no stage has to
 * convert between two shapes of one fact.
 */
export interface BudgetLedger extends TokenLedger {
  /** Tokens. `null` means no ceiling — never `0`, never `Infinity`. */
  cap: number | null
}

/**
 * Every integer the host reported, summed.
 *
 * Cache reads and writes are counted because they are tokens and MAD budgets in
 * tokens (AD-15). Leaving them out would make the ceiling a ceiling on part of
 * the bill, which is a number nobody asked for and one that drifts from the
 * `TOKENS` line output already prints from the same object.
 */
export function spentTokens(usage: TokenUsage): number {
  return usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite
}

/** What this ledger has spent so far, in the same unit `cap` is stated in. */
export function spent(ledger: TokenLedger): number {
  return spentTokens(ledger.total)
}

/**
 * The ceiling, clamped — exported so the bound is TESTED rather than trusted,
 * the pattern `clampThreshold` and `clampMaxRounds` both set.
 *
 * `review()` is an exported seam and TypeScript does not police a JavaScript
 * caller, so every failure mode here is reachable from outside:
 *
 * - **Not a number, or NaN, is NO CEILING.** `NaN` is the dangerous one:
 *   `spent < NaN` is `false` for every spend, so an unclamped `NaN` refuses the
 *   very first turn and the run then reports "the token budget (NaN) ran out" —
 *   a run that spent nothing, blamed a budget nobody set, and marked every
 *   contested finding unresolved. Absent and unusable are the same request, and
 *   the answer to both is the default: no ceiling.
 * - **Negative is ZERO, not no-ceiling.** `-5` is a caller asking to spend
 *   nothing; turning it into `null` would grant an unlimited budget to the one
 *   caller who most clearly asked for none.
 * - **Infinity is NO CEILING, spelled the one way this module spells it.**
 *   `spent < Infinity` already behaves exactly like the uncapped state, so this
 *   is a canonical-representation rule rather than a behaviour fix: `null` is
 *   how absence is written here, and letting a second spelling through means
 *   diagnostics that read "the token budget (Infinity) ran out" and a ledger
 *   whose `cap` contradicts its own field comment. `Number.isFinite` covers it
 *   and NaN in one check (code review 2026-08-26).
 * - **Fractional floors.** Tokens are integers, and 10.9 tokens is 10 you can
 *   afford. Rounding up hands out a token nobody granted.
 */
export function clampTokenCap(cap: number | undefined | null): number | null {
  if (typeof cap !== "number" || !Number.isFinite(cap)) return null
  return Math.max(Math.floor(cap), 0)
}

/**
 * "May I spend the next allocation?" — asked BEFORE a turn, never after (AD-15:
 * stages request before a turn and never self-meter).
 *
 * The gate is `spent < cap`, so it refuses AT the ceiling as well as above it.
 * The alternative — permitting one more turn once the ceiling is exactly
 * reached — makes `cap` a number the run is guaranteed to exceed, and a ceiling
 * that is always overshot by one turn is not a ceiling.
 *
 * It is deliberately a question about the ledger's TOTAL and not an estimate of
 * the next turn's cost. MAD cannot know what a turn will bill before it bills
 * it; pretending otherwise would put a fabricated number in front of the one
 * real one. The consequence is stated rather than hidden: the run may exceed
 * `cap` by at most the cost of the turns already in flight when the gate last
 * said yes.
 *
 * `cap: null` NEVER refuses. That is what "no ceiling" means, and it is the
 * default, so a caller that passes no budget gets story 4's behaviour exactly.
 *
 * THE STAGE ARGUMENT IS REQUIRED, and deliberately not optional (story 8). An
 * optional stage makes the widest ceiling the silent default wherever someone
 * forgets it — a quiet loss of the whole point of the shares, at a site
 * TypeScript cannot flag. Five explicit edits the compiler enforces are cheaper
 * than one implicit default nobody can see; it is the same call
 * `clampMaxRounds` makes at `debate.ts` in refusing to let `0` mean "skip
 * debate".
 */
export function mayISpend(ledger: BudgetLedger, stage: SpendStage): boolean {
  const ceiling = stageCeiling(ledger, stage)
  if (ceiling === null) return true
  return spent(ledger) < ceiling
}

/**
 * How far into the cap this stage may take the run's total — the number
 * `mayISpend` actually compares against.
 *
 * Read `mayISpend`'s note above first: this is still a question about the
 * ledger's TOTAL and still not an estimate of the next turn's cost, so the
 * documented overshoot property is unchanged in kind — the run may exceed a
 * ceiling by at most the cost of the turns already in flight when the gate last
 * said yes.
 *
 * - **`cap: null` is `null`**, not `Infinity` and not a large number. No ceiling
 *   is no ceiling at every stage, spelled the one way this module spells it.
 * - **Floored.** Tokens are integers and a fractional ceiling would hand out a
 *   token nobody granted — `clampTokenCap`'s rule, applied to its own product.
 * - **An unrecognised stage PERMITS.** `review()` is an exported seam and a
 *   JavaScript caller can reach this with anything; `undefined * cap` is `NaN`,
 *   and `spent < NaN` is `false` for every spend, so the unclamped answer would
 *   refuse the entire run over a typo. Falling back to no ceiling degrades to
 *   story 5's behaviour, which is the same choice `clampTokenCap` makes for NaN.
 */
export function stageCeiling(ledger: BudgetLedger, stage: SpendStage): number | null {
  if (ledger.cap === null) return null
  const share = (ledger.shares ?? CUMULATIVE_SHARE)[stage]
  if (typeof share !== "number" || !Number.isFinite(share)) return null
  return Math.floor(ledger.cap * share)
}

/**
 * What one stage has spent, folded out of the entries it already wrote.
 *
 * REPORTING ONLY. The gate never calls it: `mayISpend` compares the run's total
 * against a cumulative ceiling, which is why there is no per-stage counter to
 * maintain. Deriving the printed figure from the same `entries` the total is
 * derived from is what stops the number a user reads from drifting away from the
 * number the gate compared — a report that disagrees with its own gate is the
 * failure this whole module is shaped to avoid.
 *
 * `LedgerEntry.stage` is a bare `string` and always has been, so an entry
 * written by something that is not one of the three stages simply lands in no
 * bucket. That is why `budgetReport` prints the run TOTAL beside the three, and
 * why the test asserting the three sum to `spent(ledger)` is a real test rather
 * than a tautology.
 */
export function spentInStage(ledger: TokenLedger, stage: SpendStage): number {
  let total = 0
  for (const entry of ledger.entries) {
    if (entry.stage === stage) total += spentTokens(entry.tokens)
  }
  return total
}

/** One row of `budgetReport`: what a stage spent, and what it was held to. */
export interface StageSpend {
  stage: SpendStage
  spent: number
  /** `null` when there is no cap — the row still carries the spend. */
  ceiling: number | null
}

/**
 * The per-stage figures, ready to print, computed HERE.
 *
 * `core/stages/output.ts` renders the BUDGET block and must not do the
 * arithmetic for it: a stage that reads `ledger.shares` and multiplies is a
 * stage metering itself, which is what AD-15's first sentence forbids and what
 * the lint rule mechanically prevents. So the accountant answers the reporting
 * question too, in one call, and the renderer only formats what comes back.
 * (Story 8's plan named `stageCeiling`/`spentInStage` at the render site and
 * ALSO forbade stages from naming them; this function is how both hold.)
 */
export function budgetReport(ledger: BudgetLedger): StageSpend[] {
  const stages: SpendStage[] = ["discover", "debate", "judge"]
  return stages.map((stage) => ({
    stage,
    spent: spentInStage(ledger, stage),
    ceiling: stageCeiling(ledger, stage),
  }))
}

/**
 * THE ONE PHRASING OF "the money ran out", shared by both stranding stages.
 *
 * `core/stages/debate.ts` and `core/stages/judge.ts` each used to interpolate
 * `ledger.cap` into *"the token budget (N) ran out"*. With a share in force that
 * sentence is FALSE: debate refuses at 65% of the cap, so it names 400000 over a
 * run that has spent 260000 — and the reader can see the TOKENS line. One
 * function owns the sentence so the two stages cannot drift, and it returns
 * today's wording CHARACTER-FOR-CHARACTER whenever the stage ceiling IS the cap,
 * which is every uncapped run, every run with default shares reaching the judge,
 * and every existing test.
 */
export function ceilingClause(ledger: BudgetLedger, stage: SpendStage): string {
  const ceiling = stageCeiling(ledger, stage)
  if (ceiling === null || ceiling === ledger.cap) {
    return `the token budget (${ledger.cap}) ran out`
  }
  return `${stage}'s share of the token budget (${ceiling} of ${ledger.cap}) ran out`
}

/**
 * The same fact as a NOUN, for the sentence that names the ceiling instead of
 * reporting that it was hit — debate's `unresolved-findings` warning reads
 * "...when THE TOKEN CAP OF N was reached".
 *
 * It is here rather than at that warning for `ceilingClause`'s reason exactly: a
 * second site interpolating `ledger.cap` is a second place the share can be
 * forgotten, and this one is the sentence a user sees at the top of a degraded
 * report.
 */
export function ceilingNamed(ledger: BudgetLedger, stage: SpendStage): string {
  const ceiling = stageCeiling(ledger, stage)
  if (ceiling === null || ceiling === ledger.cap) {
    return `the token cap of ${ledger.cap}`
  }
  return `${stage}'s share of the token cap (${ceiling} of ${ledger.cap})`
}

/**
 * Recording is unchanged and re-exported HERE so a stage that holds a budget has
 * one import for both halves of it. `recordTurn` still lives in the domain,
 * because what a turn cost is a fact about the run rather than a decision about
 * it — this module owns only the decision.
 */
export { recordTurn }
export type { LedgerEntry }

/**
 * AD-15 amended (story 7A) — the PEAK half of the same accountant, re-exported
 * HERE for `recordTurn`'s reason exactly: a stage that holds a budget has one
 * import for the whole of it, and there is no seam at which a stage could pick
 * up a total without a peak or the other way round.
 *
 * It lives in its own module because this one is pure data plus two predicates
 * and a semaphore is neither. See `core/budget/limiter.ts` for why the NUMBER
 * rides on the ledger while the MECHANISM does not.
 *
 * WHAT AD-15 ACTUALLY BUYS HERE, STATED ACCURATELY (code review 2026-08-31).
 * Story 7A's spec said the limiter is "created by `core/budget/ledger.ts` and by
 * nothing else". That is not what ships and never was: this file re-exports
 * `createLimiter`, and the one construction site is `core/run/review.ts`, which
 * is the right place for it — one limiter for the whole run, created by the
 * assembly, because a limiter per stage would be a peak of `stages x limit`.
 * The property that actually holds, and the one AD-15 needs, is that NO STAGE
 * CONSTRUCTS ONE. It is enforced in `scripts/lint-dependency-direction.ts`
 * rather than asserted here, so it is tested rather than trusted — the same
 * treatment the three clamps get.
 */
export {
  clampConcurrency,
  createLimiter,
  DEFAULT_MAX_CONCURRENCY,
  MAX_CONCURRENCY,
} from "./limiter.ts"
export type { ConcurrencyLimiter } from "./limiter.ts"

/**
 * AD-15 / CAP-7 (story 8) — the USER-FACING half of the same accountant,
 * re-exported HERE for `recordTurn`'s and `createLimiter`'s reason exactly: a
 * caller that holds a budget has one import for the whole of it.
 *
 * It lives in its own module because that module must import NOTHING —
 * `core/domain/run-record.ts` imports `SpendShares` from it while this file
 * imports from `core/domain/`, and an import-free presets module is the only
 * thing between that and a cycle. Same shape as `limiter.ts`, same reason, and
 * enforced by the same lint rule.
 */
export {
  clampPreset,
  clampSpendShares,
  CUMULATIVE_SHARE,
  DEFAULT_PRESET,
  PRESET_DIALS,
  PRESETS,
  SUGGESTED_BUDGET,
} from "./presets.ts"
export type { Preset, PresetDials, SpendShares, SpendStage } from "./presets.ts"
