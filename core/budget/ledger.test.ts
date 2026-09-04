import { describe, expect, test } from "bun:test"

import { emptyLedger, recordTurn } from "../domain/run-record.ts"
import { tokens } from "../test-support/fakes.ts"
import {
  budgetReport,
  ceilingClause,
  ceilingNamed,
  clampTokenCap,
  mayISpend,
  spent,
  spentInStage,
  spentTokens,
  stageCeiling,
  type BudgetLedger,
} from "./ledger.ts"

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
    expect(mayISpend(ledgerAt(99, 100), "judge")).toBe(true)
  })

  test("AT the ceiling REFUSES — a ceiling that permits one more turn is not a ceiling", () => {
    // The alternative rule (`spent <= cap`) makes `cap` a number the run is
    // guaranteed to exceed by exactly one turn, every time it is reached.
    expect(mayISpend(ledgerAt(100, 100), "judge")).toBe(false)
  })

  test("ABOVE the ceiling refuses", () => {
    expect(mayISpend(ledgerAt(101, 100), "judge")).toBe(false)
  })

  test("an untouched ledger under a positive cap permits", () => {
    expect(mayISpend(emptyLedger(100) as BudgetLedger, "judge")).toBe(true)
  })

  test("a cap of ZERO refuses immediately — it is a real ceiling, not an absent one", () => {
    // `0` and `null` must not be two ways of saying the same thing. A caller
    // that asks for a zero budget gets a run that spends nothing, which is a
    // strange request and an honest answer to it.
    expect(mayISpend(emptyLedger(0) as BudgetLedger, "judge")).toBe(false)
  })
})

describe("cap: null — no ceiling, and the default", () => {
  test("NEVER refuses, at any spend", () => {
    expect(mayISpend(emptyLedger(null) as BudgetLedger, "judge")).toBe(true)
    expect(mayISpend(ledgerAt(1_000_000, null), "judge")).toBe(true)
  })

  test("`emptyLedger()` with no argument is uncapped, so every pre-story-5 caller is unchanged", () => {
    const ledger = emptyLedger()
    expect(ledger.cap).toBeNull()
    expect(mayISpend(ledger as BudgetLedger, "judge")).toBe(true)
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
    expect(() => mayISpend(ledger, "judge")).not.toThrow()
    expect(mayISpend(ledger, "judge")).toBe(false)
  })

  test("asking does not spend, and does not mutate the ledger", () => {
    const ledger = ledgerAt(10, 100)
    const before = { entries: ledger.entries.length, total: { ...ledger.total } }
    mayISpend(ledger, "judge")
    mayISpend(ledger, "judge")
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

  test("INFINITY IS NO CEILING, and `null` is the only way to spell that", () => {
    // Behaviourally `spent < Infinity` already matches the uncapped state, so
    // this is about canonical representation (code review 2026-08-26): a second
    // spelling of "no ceiling" produces a `cap` that contradicts its own field
    // comment and diagnostics that read "the token budget (Infinity) ran out".
    expect(clampTokenCap(Number.POSITIVE_INFINITY)).toBeNull()
    expect(clampTokenCap(Number.NEGATIVE_INFINITY)).toBeNull()
    expect(mayISpend(ledgerAt(9_999_999, clampTokenCap(Number.POSITIVE_INFINITY)), "judge")).toBe(true)
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

// ---------------------------------------------------------------------------
// Story 8 — the stage shares.
// ---------------------------------------------------------------------------

describe("stageCeiling — the number the gate actually compares against", () => {
  test("discovery's ceiling is its share of the cap, FLOORED", () => {
    // Tokens are integers, and a fractional ceiling would hand out a token
    // nobody granted. floor(1000 * 0.3) = 300.
    expect(stageCeiling(emptyLedger(1000) as BudgetLedger, "discover")).toBe(300)
  })

  test("the JUDGE's ceiling IS the cap — no part of a stated cap is unreachable", () => {
    expect(stageCeiling(emptyLedger(1000) as BudgetLedger, "judge")).toBe(1000)
  })

  test("the ceilings RISE across the run, so unspent budget rolls forward", () => {
    const ledger = emptyLedger(1000) as BudgetLedger
    expect(stageCeiling(ledger, "discover")).toBe(300)
    expect(stageCeiling(ledger, "debate")).toBe(650)
    expect(stageCeiling(ledger, "judge")).toBe(1000)
  })

  test("`cap: null` is NO CEILING at every stage — never Infinity, never a number", () => {
    for (const stage of ["discover", "debate", "judge"] as const) {
      expect(stageCeiling(emptyLedger(null) as BudgetLedger, stage)).toBeNull()
    }
  })

  test("AN UNRECOGNISED STAGE PERMITS, rather than refusing the entire run", () => {
    // `review()` is an exported seam and a JavaScript caller can reach this with
    // anything. `undefined * cap` is NaN, and `spent < NaN` is false for every
    // spend — so the unclamped answer would refuse every turn of the run over a
    // typo. Degrading to no ceiling is `clampTokenCap`'s choice for NaN.
    const ledger = emptyLedger(1000) as BudgetLedger
    const bogus = "cluster" as unknown as "judge"
    expect(stageCeiling(ledger, bogus)).toBeNull()
    expect(mayISpend(ledgerAt(9_999_999, 1000), bogus)).toBe(true)
  })
})

describe("the gate, per stage", () => {
  test("DEBATE IS REFUSED AT ITS SHARE WHILE THE JUDGE WOULD STILL PERMIT", () => {
    // The whole point of the shares in one assertion: at 700 of a 1000 cap, the
    // run is past debate's 650 ceiling and under the judge's 1000. A single
    // whole-cap gate cannot express this, and a run that spent its cap in
    // discovery is exactly what story 8 exists to stop.
    const ledger = ledgerAt(700, 1000)
    expect(mayISpend(ledger, "debate")).toBe(false)
    expect(mayISpend(ledger, "judge")).toBe(true)
  })

  test("discovery is refused at 30%, long before the cap is reached", () => {
    // Gating discovery is what closes the defect `core/run/review.ts` documented
    // in shipped source: without it, discovery eats the whole cap and every
    // contested finding strands at debate's first gate with no debate turn run.
    const ledger = ledgerAt(300, 1000)
    expect(mayISpend(ledger, "discover")).toBe(false)
    expect(mayISpend(ledger, "debate")).toBe(true)
  })

  test("A CAP OF ZERO REFUSES EVERY STAGE — `budget: 0` asks nobody", () => {
    const ledger = emptyLedger(0) as BudgetLedger
    for (const stage of ["discover", "debate", "judge"] as const) {
      expect(mayISpend(ledger, stage)).toBe(false)
    }
  })

  test("no cap permits every stage, at any spend", () => {
    for (const stage of ["discover", "debate", "judge"] as const) {
      expect(mayISpend(ledgerAt(9_999_999, null), stage)).toBe(true)
    }
  })

  test("asking does not mutate the ledger, for any stage", () => {
    const ledger = ledgerAt(10, 100)
    const before = { entries: ledger.entries.length, total: { ...ledger.total } }
    for (const stage of ["discover", "debate", "judge"] as const) mayISpend(ledger, stage)
    expect(ledger.entries).toHaveLength(before.entries)
    expect(ledger.total).toEqual(before.total)
  })
})

describe("spentInStage and budgetReport — the report cannot drift from the gate", () => {
  const threeStages = (): BudgetLedger => {
    const ledger = emptyLedger(1000) as BudgetLedger
    recordTurn(ledger, { slot: "discovery-1", stage: "discover", attempt: 1, tokens: tokens(100, 0) })
    recordTurn(ledger, { slot: "discovery-2", stage: "discover", attempt: 1, tokens: tokens(50, 0) })
    recordTurn(ledger, { slot: "discovery-1", stage: "debate", attempt: 1, tokens: tokens(200, 0) })
    recordTurn(ledger, { slot: "discovery-1", stage: "judge", attempt: 1, tokens: tokens(30, 0) })
    return ledger
  }

  test("each stage's fold is the sum of its own entries", () => {
    const ledger = threeStages()
    expect(spentInStage(ledger, "discover")).toBe(150)
    expect(spentInStage(ledger, "debate")).toBe(200)
    expect(spentInStage(ledger, "judge")).toBe(30)
  })

  test("THE THREE FIGURES SUM TO `spent(ledger)` — the printed and the compared agree", () => {
    // Both are folded out of the same `entries`, which is why the report cannot
    // drift from the gate. It is not a tautology: `LedgerEntry.stage` is a bare
    // string, so an entry from anything else would land in no bucket and this
    // would fail — which is the point of asserting it.
    const ledger = threeStages()
    const perStage =
      spentInStage(ledger, "discover") + spentInStage(ledger, "debate") + spentInStage(ledger, "judge")
    expect(perStage).toBe(spent(ledger))
  })

  test("`budgetReport` returns each stage's spend beside the ceiling it was held to", () => {
    expect(budgetReport(threeStages())).toEqual([
      { stage: "discover", spent: 150, ceiling: 300 },
      { stage: "debate", spent: 200, ceiling: 650 },
      { stage: "judge", spent: 30, ceiling: 1000 },
    ])
  })

  test("an uncapped ledger still reports SPEND, with no ceiling to compare it to", () => {
    const ledger = emptyLedger(null) as BudgetLedger
    recordTurn(ledger, { slot: "discovery-1", stage: "debate", attempt: 1, tokens: tokens(7, 0) })
    expect(budgetReport(ledger)).toEqual([
      { stage: "discover", spent: 0, ceiling: null },
      { stage: "debate", spent: 7, ceiling: null },
      { stage: "judge", spent: 0, ceiling: null },
    ])
  })
})

describe("ceilingClause / ceilingNamed — ONE phrasing, shared by both stranding stages", () => {
  test("when the ceiling IS the cap it renders TODAY'S SENTENCE, character for character", () => {
    // Every uncapped run, every judge strand, and every test written before
    // story 8 goes through this branch, which is why the shares are not a
    // rewrite of the report.
    const ledger = emptyLedger(400) as BudgetLedger
    expect(ceilingClause(ledger, "judge")).toBe("the token budget (400) ran out")
    expect(ceilingNamed(ledger, "judge")).toBe("the token cap of 400")
  })

  test("when a share is in force it names THE CEILING AND THE CAP, so the reader can check both", () => {
    // "the token budget (400) ran out" over a run that has spent 260 of 400 is
    // a sentence the reader can check against the TOKENS line and find false.
    const ledger = emptyLedger(400) as BudgetLedger
    expect(ceilingClause(ledger, "debate")).toBe(
      "debate's share of the token budget (260 of 400) ran out",
    )
    expect(ceilingNamed(ledger, "debate")).toBe("debate's share of the token cap (260 of 400)")
  })

  test("an uncapped ledger keeps the shipped wording", () => {
    const ledger = emptyLedger(null) as BudgetLedger
    expect(ceilingClause(ledger, "debate")).toBe("the token budget (null) ran out")
  })
})
