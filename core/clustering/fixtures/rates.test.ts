import { describe, expect, test } from "bun:test"

import { EXPECTED_WRONG, PAIRS } from "./pairs.ts"
import { measurePairs } from "./rates.ts"

describe("CAP-2's measurement — two rates, never one number (AD-14)", () => {
  test("OVER-MERGE AND UNDER-MERGE ARE TWO SEPARATE COUNTS, ASSERTED SEPARATELY", async () => {
    // They fail in opposite directions and cost opposite things
    // (`pipeline-stages.md` §2), so they are never fused into one accuracy
    // number — not in the report, and not in this assertion.
    const report = await measurePairs()

    const distinct = PAIRS.filter((row) => row.label === "distinct").length
    const equivalent = PAIRS.filter((row) => row.label === "equivalent").length

    expect(report.overMerge).toEqual({ merged: 1, of: distinct })
    expect(report.underMerge).toEqual({ unmerged: 1, of: equivalent })

    // Counts, never pre-divided floats (spine, Dates & numbers).
    expect(Number.isInteger(report.overMerge.merged)).toBe(true)
    expect(Number.isInteger(report.underMerge.unmerged)).toBe(true)
    expect(Object.keys(report)).not.toContain("accuracy")
    expect(Object.keys(report)).not.toContain("score")
  })

  test("the fixture carries both directions, so neither rate is structurally zero", async () => {
    const report = await measurePairs()
    expect(report.overMerge.of).toBeGreaterThan(0)
    expect(report.underMerge.of).toBeGreaterThan(0)
  })

  test("THE DELIBERATELY-HARD ROWS ARE ACCOUNTED FOR, NOT QUIETLY PASSING", async () => {
    // A perfect score is not on offer. If one of these starts passing, this test
    // fails and the expectation is updated deliberately rather than the fixture
    // silently getting easier.
    const report = await measurePairs()
    const wrong = report.outcomes.filter((outcome) => !outcome.correct).map((o) => o.id)
    expect(wrong.sort()).toEqual([...EXPECTED_WRONG].sort())

    // And each one fails in the direction its `why` claims.
    const chain = report.outcomes.find((o) => o.id === "rounding-chain")!
    expect(chain.label).toBe("distinct")
    expect(chain.merged).toBe(true) // single linkage, counted as an over-merge

    const symptom = report.outcomes.find((o) => o.id === "symptom-vs-root-cause")!
    expect(symptom.label).toBe("equivalent")
    expect(symptom.merged).toBe(false) // lexical miss, counted as an under-merge
  })

  test("A MATCHER THAT SAYS `true` TO EVERYTHING SCORES A FULL OVER-MERGE RATE", async () => {
    // The harness bug this guards against: a measurement that reports a healthy
    // number because it never actually ran the engine over the pair.
    const report = await measurePairs(PAIRS, () => true)
    const distinct = PAIRS.filter((row) => row.label === "distinct").length

    expect(report.overMerge).toEqual({ merged: distinct, of: distinct })
    expect(report.underMerge.unmerged).toBe(0)
  })

  test("a matcher that says `false` to everything scores a full under-merge rate", async () => {
    const report = await measurePairs(PAIRS, () => false)
    const equivalent = PAIRS.filter((row) => row.label === "equivalent").length

    expect(report.underMerge).toEqual({ unmerged: equivalent, of: equivalent })
    expect(report.overMerge.merged).toBe(0)
  })

  test("every row is reported, with its label and its reason for a human", async () => {
    const report = await measurePairs()
    expect(report.outcomes.map((o) => o.id)).toEqual(PAIRS.map((row) => row.id))
    for (const outcome of report.outcomes) expect(outcome.why.length).toBeGreaterThan(0)
  })

  test("the matcher is a parameter, so a model-backed one is scored by the same harness", async () => {
    // AD-14's seam, asserted rather than assumed: untested, `measurePairs` could
    // have reached for the shipped matcher directly and nothing would have said so.
    const asked: string[] = []
    await measurePairs(PAIRS, async (a, b) => {
      asked.push(`${a.id}|${b.id}`)
      return false
    })
    expect(asked.length).toBeGreaterThan(0)
  })

  test("the chain row is measured over three items; every other row over its two", async () => {
    const report = await measurePairs()
    const chain = report.outcomes.find((o) => o.id === "rounding-chain")!
    expect(chain.items).toBe(3)
    for (const outcome of report.outcomes) {
      if (outcome.id !== "rounding-chain") expect(outcome.items).toBe(2)
    }
  })

  test("the pair set covers every shape the story requires", async () => {
    const ids = PAIRS.map((row) => row.id)
    for (const required of [
      "same-defect-different-words",
      "line-cites-a-few-apart",
      "adjacent-but-different-defects",
      "same-wording-different-files",
      "pool-and-lens-one-defect",
      "same-author-twice",
      "symptom-vs-root-cause",
      "rounding-chain",
    ]) {
      expect(ids).toContain(required)
    }
    // The mixed row is genuinely mixed, not two pool findings with a label.
    const mixed = PAIRS.find((row) => row.id === "pool-and-lens-one-defect")!
    expect(mixed.a.source).toBe("pool")
    expect(mixed.b.source).toBe("lens")
    expect(mixed.b.lens).toBe("security")
    // The same-author row is genuinely one author.
    const sameAuthor = PAIRS.find((row) => row.id === "same-author-twice")!
    expect(sameAuthor.a.author).toBe(sameAuthor.b.author)
  })
})
