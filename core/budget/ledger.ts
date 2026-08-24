/**
 * AD-15 — the one accountant, and the ONE thing that answers "may I spend?".
 *
 * `core/domain/run-record.ts` has recorded every turn's tokens since story 1.
 * What it never did was PERMIT one. Recording and permitting are different jobs
 * and this module is the second: a ceiling beside the spend, and a gate a stage
 * asks before it starts a turn. Story 5 ships exactly that much, because that is
 * exactly what CAP-4's `cap` exit and AD-6d's exhaustion path consume. Story 8's
 * presets resolve to `TokenLedger.cap` and extend THIS gate rather than growing
 * a second one beside it — two authorities on "may I spend?" is the failure
 * AD-15's single accountant exists to prevent.
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
 * - **Fractional floors.** Tokens are integers, and 10.9 tokens is 10 you can
 *   afford. Rounding up hands out a token nobody granted.
 */
export function clampTokenCap(cap: number | undefined | null): number | null {
  if (typeof cap !== "number" || Number.isNaN(cap)) return null
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
 */
export function mayISpend(ledger: BudgetLedger): boolean {
  if (ledger.cap === null) return true
  return spent(ledger) < ledger.cap
}

/**
 * Recording is unchanged and re-exported HERE so a stage that holds a budget has
 * one import for both halves of it. `recordTurn` still lives in the domain,
 * because what a turn cost is a fact about the run rather than a decision about
 * it — this module owns only the decision.
 */
export { recordTurn }
export type { LedgerEntry }
