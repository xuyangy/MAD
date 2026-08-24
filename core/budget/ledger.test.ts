import { describe, expect, test } from "bun:test"

import { emptyLedger, recordTurn } from "../domain/run-record.ts"
import { tokens } from "../test-support/fakes.ts"
import { clampTokenCap, mayISpend, spent, spentTokens, type BudgetLedger } from "./ledger.ts"

/** `tokens(input, output)` bills `input + output` and nothing else. */
function ledgerAt(spend: number, cap: number | null): BudgetLedger {
  const ledger = emptyLedger(cap) as BudgetLedger
  if (spend > 0) {
    recordTurn(ledger, { slot: "discovery-1", stage: "discover", attempt: 1, tokens: tokens(spend, 0) })
  }
  return ledger
}

describe("the gate — at, below, and above the ceiling", () => {
  test("BELOW the ceiling permits", () => {
    expect(mayISpend(ledgerAt(99, 100))).toBe(true)
  })

  test("AT the ceiling REFUSES — a ceiling that permits one more turn is not a ceiling", () => {
    // The alternative rule (`spent <= cap`) makes `cap` a number the run is
    // guaranteed to exceed by exactly one turn, every time it is reached.
    expect(mayISpend(ledgerAt(100, 100))).toBe(false)
  })

  test("ABOVE the ceiling refuses", () => {
    expect(mayISpend(ledgerAt(101, 100))).toBe(false)
  })

  test("an untouched ledger under a positive cap permits", () => {
    expect(mayISpend(emptyLedger(100) as BudgetLedger)).toBe(true)
  })

  test("a cap of ZERO refuses immediately — it is a real ceiling, not an absent one", () => {
    // `0` and `null` must not be two ways of saying the same thing. A caller
    // that asks for a zero budget gets a run that spends nothing, which is a
    // strange request and an honest answer to it.
    expect(mayISpend(emptyLedger(0) as BudgetLedger)).toBe(false)
  })
})

describe("cap: null — no ceiling, and the default", () => {
  test("NEVER refuses, at any spend", () => {
    expect(mayISpend(emptyLedger(null) as BudgetLedger)).toBe(true)
    expect(mayISpend(ledgerAt(1_000_000, null))).toBe(true)
  })

  test("`emptyLedger()` with no argument is uncapped, so every pre-story-5 caller is unchanged", () => {
    const ledger = emptyLedger()
    expect(ledger.cap).toBeNull()
    expect(mayISpend(ledger as BudgetLedger)).toBe(true)
  })
})

describe("what is counted", () => {
  test("every reported integer is counted, cache included — MAD budgets in tokens (AD-15)", () => {
    expect(
      spentTokens({ input: 1, output: 2, reasoning: 4, cacheRead: 8, cacheWrite: 16 }),
    ).toBe(31)
  })

  test("`spent` reads the ledger's own total, so it cannot drift from the TOKENS line output prints", () => {
    const ledger = emptyLedger(null)
    recordTurn(ledger, { slot: "discovery-1", stage: "discover", attempt: 1, tokens: tokens(10, 20) })
    recordTurn(ledger, { slot: "discovery-2", stage: "debate", attempt: 1, tokens: tokens(5, 5) })
    expect(spent(ledger)).toBe(40)
    expect(spent(ledger)).toBe(spentTokens(ledger.total))
  })
})

describe("what the budget must NOT do", () => {
  test("EXHAUSTION IS NOT AN ERROR — a refusal is a `false`, never a throw (AD-15, AD-6d)", () => {
    // A budget that threw would make a run that ran out of money look like a run
    // that crashed. `cost-model.md`: the tool starts, spends what it has, and
    // says where it stopped.
    const ledger = ledgerAt(500, 10)
    expect(() => mayISpend(ledger)).not.toThrow()
    expect(mayISpend(ledger)).toBe(false)
  })

  test("asking does not spend, and does not mutate the ledger", () => {
    const ledger = ledgerAt(10, 100)
    const before = { entries: ledger.entries.length, total: { ...ledger.total } }
    mayISpend(ledger)
    mayISpend(ledger)
    expect(ledger.entries).toHaveLength(before.entries)
    expect(ledger.total).toEqual(before.total)
  })

  test("recording still records everything, refused or not — the ledger is not the gate", () => {
    // Recording and permitting are different jobs. `recordTurn` has no opinion
    // about the cap and must not grow one: a turn that was billed is a fact.
    const ledger = emptyLedger(1)
    recordTurn(ledger, { slot: "discovery-1", stage: "debate", attempt: 1, tokens: tokens(10, 20) })
    recordTurn(ledger, { slot: "discovery-1", stage: "debate", attempt: 2, tokens: tokens(10, 20) })
    expect(ledger.entries).toHaveLength(2)
    expect(spent(ledger)).toBe(60)
    expect(ledger.cap).toBe(1)
  })
})

describe("clampTokenCap — the ceiling is bounded too", () => {
  test("NaN IS NO CEILING, not a ceiling of NaN", () => {
    // `spent < NaN` is false for every spend, so an unclamped NaN refuses the
    // first turn and the run then blames a budget nobody set.
    expect(clampTokenCap(Number.NaN)).toBeNull()
    expect(clampTokenCap(undefined)).toBeNull()
    expect(clampTokenCap("500" as unknown as number)).toBeNull()
  })

  test("negative is ZERO, never unlimited", () => {
    // The caller who most clearly asked to spend nothing must not be handed an
    // unlimited budget.
    expect(clampTokenCap(-5)).toBe(0)
    expect(clampTokenCap(0)).toBe(0)
  })

  test("fractions floor, because tokens are integers", () => {
    expect(clampTokenCap(10.9)).toBe(10)
    expect(clampTokenCap(1)).toBe(1)
  })
})
