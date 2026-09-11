import { describe, expect, test } from "bun:test"

import { emptyLedger, reconcileLateUsage, recordTurn, recordUnknownTurn } from "../domain/run-record.ts"
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
  unknownUsageClause,
  unknownUsageCount,
  usageIsComplete,
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

  test("A CAP THAT DOES NOT DIVIDE EVENLY IS FLOORED, NOT ROUNDED", () => {
    // Every other ceiling test here uses cap 1000, which 0.3 and 0.65 both
    // divide evenly — so `Math.ceil` passed all of them, and the flooring rule
    // this block's first test NAMES was pinned only by an unrelated
    // `tokenCap: 1` case in run-control.test.ts. 101 divides evenly by neither:
    // floor(101 * 0.3) = 30 against ceil 31, floor(101 * 0.65) = 65 against 66.
    // A rounded-up ceiling hands out a token nobody granted, which is the
    // property the first test states and this one is what makes it fail.
    // Recovered from the 2026-09-06 review's unverified residue; the mutation
    // was re-run on 2026-09-09 and confirmed to survive at cap 1000.
    const ledger = emptyLedger(101) as BudgetLedger
    expect(stageCeiling(ledger, "discover")).toBe(30)
    expect(stageCeiling(ledger, "debate")).toBe(65)
    expect(stageCeiling(ledger, "judge")).toBe(101)
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

  test("`budgetReport` returns each stage's spend, the RUNNING TOTAL, and the ceiling it was held to", () => {
    // `total` is the number the gate compared (code review 2026-09-06). `spent`
    // is one stage and `ceiling` bounds the run's total, so the two do not
    // compare — the row needs the third figure or the renderer is left flagging
    // a comparison `mayISpend` never made.
    expect(budgetReport(threeStages())).toEqual([
      { stage: "discover", spent: 150, total: 150, ceiling: 300 },
      { stage: "debate", spent: 200, total: 350, ceiling: 650 },
      { stage: "judge", spent: 30, total: 380, ceiling: 1000 },
    ])
  })

  test("THE RUNNING TOTAL IS WHAT THE GATE COMPARES, so the row and the refusal agree", () => {
    // The regression this guards: a per-stage spend can never exceed a
    // cumulative ceiling except at `discover`, so a report that flagged
    // `spent > ceiling` could not fire on the one event F9 exists to report.
    const ledger = emptyLedger(400) as BudgetLedger
    recordTurn(ledger, { slot: "discovery-1", stage: "discover", attempt: 1, tokens: tokens(100, 0) })
    recordTurn(ledger, { slot: "debate-1", stage: "debate", attempt: 1, tokens: tokens(100, 0) })
    recordTurn(ledger, { slot: "debate-2", stage: "debate", attempt: 1, tokens: tokens(100, 0) })
    const rows = budgetReport(ledger)
    const debate = rows[1]!
    // Debate alone is under its own ceiling; the RUN is over it, and the run is
    // what `mayISpend` refuses on.
    expect(debate.spent).toBeLessThan(debate.ceiling!)
    expect(debate.total).toBe(300)
    expect(mayISpend(ledger, "debate")).toBe(false)
  })

  test("an uncapped ledger still reports SPEND, with no ceiling to compare it to", () => {
    const ledger = emptyLedger(null) as BudgetLedger
    recordTurn(ledger, { slot: "discovery-1", stage: "debate", attempt: 1, tokens: tokens(7, 0) })
    expect(budgetReport(ledger)).toEqual([
      { stage: "discover", spent: 0, total: 0, ceiling: null },
      { stage: "debate", spent: 7, total: 7, ceiling: null },
      { stage: "judge", spent: 0, total: 7, ceiling: null },
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

  test("an uncapped ledger says so in words, and does not claim a budget with no ceiling ran out", () => {
    // Code review 2026-09-06. The shipped wording here used to be "the token
    // budget (null) ran out" — a sentence no reader can act on, pinned by this
    // test as though it were intended. Unreachable through the gate, because an
    // uncapped run never refuses a turn; reachable through these exported
    // helpers, which is why they are asserted at all.
    //
    // Code review 2026-09-08 replaced the first repair. "the token budget (no
    // cap) ran out" fixed the unreadable half and kept the false half: a budget
    // with no cap cannot run out, and a readable false sentence is worse than an
    // obviously broken one because a reader acts on it. The two assertions below
    // are the property, not the wording — neither string may claim a ceiling was
    // reached, and `ceilingNamed` owns the uncapped noun for `debateSummary` too,
    // which no longer carries a branch of its own.
    const ledger = emptyLedger(null) as BudgetLedger
    expect(ceilingClause(ledger, "debate")).toBe("the run was stopped, though no token cap was set")
    expect(ceilingClause(ledger, "debate")).not.toContain("ran out")
    expect(ceilingNamed(ledger, "debate")).toBe("no token cap")
  })
})

describe("usage completeness — the accountant answers, so no renderer computes (AC1, story 2.3)", () => {
  const withUnknown = (count: number, cap: number | null = 400): BudgetLedger => {
    const ledger = emptyLedger(cap) as BudgetLedger
    for (let n = 1; n <= count; n += 1) {
      recordUnknownTurn(ledger, {
        slot: "discovery-1",
        stage: "discover",
        attempt: 1,
        executionId: `exec-${n}`,
        why: "the host reported no usage for this turn",
      })
    }
    return ledger
  }

  test("a ledger with no unknowns is COMPLETE, and one with any unknown is not", () => {
    expect(usageIsComplete(emptyLedger(400) as BudgetLedger)).toBe(true)
    expect(usageIsComplete(withUnknown(1))).toBe(false)
  })

  test("SPEND IS NOT COMPLETENESS — a ledger with real entries AND an unknown is incomplete", () => {
    // The regression this guards: "we recorded some turns" is not "we recorded
    // every turn", and a run that billed three turns and could not count a
    // fourth is exactly the state that used to be indistinguishable from a run
    // that billed three.
    const ledger = withUnknown(1)
    recordTurn(ledger, { slot: "discovery-2", stage: "discover", attempt: 1, tokens: tokens(50, 0) })
    expect(spent(ledger)).toBe(50)
    expect(usageIsComplete(ledger)).toBe(false)
  })

  test("`unknownUsageCount` counts EXECUTIONS, and it is the number AC4 says to record", () => {
    expect(unknownUsageCount(emptyLedger(400) as BudgetLedger)).toBe(0)
    expect(unknownUsageCount(withUnknown(3))).toBe(3)
  })

  test("recovering the last unknown makes the ledger complete again (AC2)", () => {
    // `reconcileLateUsage` moves a matched unknown into `entries`, so the
    // predicate has to follow the recovery rather than latch. A latched
    // "incomplete" would make a run whose provider eventually reported
    // everything report forever as unquantified.
    const ledger = withUnknown(1)
    reconcileLateUsage(ledger, [{ executionId: "exec-1", tokens: tokens(12, 0) }])
    expect(usageIsComplete(ledger)).toBe(true)
    expect(spent(ledger)).toBe(12)
  })
})

describe("unknownUsageClause — the ONE sentence, owned here and not by the renderer", () => {
  const withUnknown = (count: number): BudgetLedger => {
    const ledger = emptyLedger(400) as BudgetLedger
    for (let n = 1; n <= count; n += 1) {
      recordUnknownTurn(ledger, {
        slot: "discovery-1",
        stage: "discover",
        attempt: 1,
        executionId: `exec-${n}`,
        why: "the run was cancelled while this turn was in flight",
      })
    }
    return ledger
  }

  test("NULL when usage is complete — ABSENCE, so the renderer's gate is not a falsiness test", () => {
    // `""` was the other option and it is the one this story is written against:
    // an empty string and a sentence are two states an `if (clause)` collapses,
    // and the whole subject of story 2.3 is two states a truthiness test
    // collapses. `null` makes the renderer's gate `!== null`.
    expect(unknownUsageClause(emptyLedger(400) as BudgetLedger)).toBeNull()
  })

  test("it NAMES THE COUNT and calls the total OBSERVED, never an estimate", () => {
    const clause = unknownUsageClause(withUnknown(2))
    expect(clause).toContain("2")
    expect(clause).toContain("OBSERVED")
    // The property, not the wording: the sentence must never put a number on
    // the gap. `core/budget/ledger.ts` refuses a fabricated estimate on
    // principle, and an estimate printed beside a real figure is worse than a
    // stated gap.
    expect(clause).not.toContain("estimate")
  })

  test("ONE unknown reads in the singular, because a reader counts what the sentence says", () => {
    expect(unknownUsageClause(withUnknown(1))).toContain("1 turn ")
    expect(unknownUsageClause(withUnknown(2))).toContain("2 turns ")
  })

  test("the sentence is true for BOTH causes — it names neither cancellation nor the host", () => {
    // The caveat this replaces said "a turn MAD stopped waiting on returns no
    // usage", which is accurate for a cancellation and WRONG for a settled turn
    // whose host reported nothing. One sentence covers both by describing the
    // gap and not its cause; the per-entry `why` carries the cause.
    const clause = unknownUsageClause(withUnknown(1))!
    expect(clause).not.toContain("cancel")
    expect(clause).not.toContain("stopped waiting")
  })
})

describe("mayISpend and the unknown-usage stop rule (AC4, story 2.3)", () => {
  const stopping = (cap: number | null = 400): BudgetLedger => {
    const ledger = emptyLedger(cap) as BudgetLedger
    ledger.stopOnUnknownUsage = true
    return ledger
  }

  const withUnknown = (ledger: BudgetLedger): BudgetLedger => {
    recordUnknownTurn(ledger, {
      slot: "discovery-1",
      stage: "discover",
      attempt: 1,
      executionId: "exec-1",
      why: "the host reported no usage for this turn",
    })
    return ledger
  }

  test("THE DIAL DEFAULTS OFF — an ordinary run reports the unknown and keeps working", () => {
    // AD-16: evaluation machinery is additive and never changes an ordinary run.
    // Halting a code review because one host response omitted a `tokens` field
    // would be this story inventing a policy for a caller the protocol never
    // spoke about.
    const ledger = withUnknown(emptyLedger(400) as BudgetLedger)
    expect(ledger.stopOnUnknownUsage).toBe(false)
    expect(mayISpend(ledger, "discover")).toBe(true)
  })

  test("with the dial ON and an unknown present, EVERY stage is refused", () => {
    const ledger = withUnknown(stopping())
    for (const stage of ["discover", "debate", "judge"] as const) {
      expect(mayISpend(ledger, stage)).toBe(false)
    }
  })

  test("the dial ON with NO unknown refuses nothing — it is a stop rule, not a kill switch", () => {
    for (const stage of ["discover", "debate", "judge"] as const) {
      expect(mayISpend(stopping(), stage)).toBe(true)
    }
  })

  test("IT OUTRANKS `cap: null` — no ceiling is not permission to spend past an unknown", () => {
    // This is the assertion that makes the rule a rule. `mayISpend`'s first
    // branch has always been "no ceiling never refuses", and the evaluation
    // path is precisely a path that may run uncapped: a stop rule placed after
    // that branch would be dead code on the runs AC4 was written for.
    expect(mayISpend(withUnknown(stopping(null)), "judge")).toBe(false)
  })

  test("REFUSAL IS A `false`, never a throw (AD-15, AD-6d)", () => {
    // `core/budget/ledger.ts:21-26`. A budget that threw would make a run that
    // ran out of money look like a run that crashed, and the same argument
    // covers a run that stopped over an uncountable turn.
    const ledger = withUnknown(stopping())
    expect(() => mayISpend(ledger, "debate")).not.toThrow()
  })

  test("asking does not mutate the ledger, and does not consume the unknown", () => {
    const ledger = withUnknown(stopping())
    mayISpend(ledger, "discover")
    mayISpend(ledger, "discover")
    expect(ledger.unknownUsage).toHaveLength(1)
    expect(ledger.entries).toHaveLength(0)
    expect(ledger.total).toEqual(emptyLedger().total)
  })

  test("recovering the unknown LIFTS the refusal (AC2 meets AC4)", () => {
    // The halt is on the UNKNOWN, not on the fact that there once was one. A
    // provider that eventually reported the number has removed the reason the
    // gate refused, and the run's own accountant says so — which is a different
    // authority from the experiment-wide halt, that one being persisted and
    // deliberately not self-resuming (`ablation/governor.ts`).
    const ledger = withUnknown(stopping())
    expect(mayISpend(ledger, "judge")).toBe(false)
    reconcileLateUsage(ledger, [{ executionId: "exec-1", tokens: tokens(1, 0) }])
    expect(mayISpend(ledger, "judge")).toBe(true)
  })

  test("the ceiling still refuses when the dial is off — the two rules compose", () => {
    const ledger = emptyLedger(100) as BudgetLedger
    recordTurn(ledger, { slot: "discovery-1", stage: "discover", attempt: 1, tokens: tokens(100, 0) })
    expect(mayISpend(ledger, "judge")).toBe(false)
  })
})
