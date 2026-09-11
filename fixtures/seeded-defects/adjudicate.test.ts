/**
 * AC3 asserted rather than promised: an unlabelled finding is never a false
 * positive.
 *
 * The negative tests are the load-bearing ones. `expect(result.unlabelled)` is
 * easy to satisfy; what has to stay true is that NOTHING ELSE appears — no
 * count, no rate, no residual bucket that a later reader could mistake for a
 * false-positive tally (`evaluation-protocol.md:130`).
 */

import { describe, expect, test } from "bun:test"

import { adjudicate } from "./adjudicate.ts"
import { SEEDED_DEFECTS } from "./labels.ts"
import type { DefectMatcher, SeededDefect } from "../recall.ts"
import type { Finding } from "../../core/domain/finding.ts"

function finding(id: string, over: Partial<Finding> = {}): Finding {
  return {
    id,
    claim: "something is wrong",
    reasoning: "because of a reason",
    locus: { file: "src/billing/refund.ts", startLine: 20, endLine: 22 },
    severity: "high",
    author: "discovery-1",
    source: "pool",
    history: [],
    ...over,
  }
}

/** Two planted defects, far enough apart that neither matcher rule is ambiguous. */
const DEFECTS: SeededDefect[] = [
  {
    id: "alpha",
    dimension: "security",
    locus: { file: "src/billing/refund.ts", startLine: 20, endLine: 22 },
    summary: "the alpha defect",
    markers: ["alpha-marker"],
  },
  {
    id: "beta",
    dimension: "correctness",
    locus: { file: "src/billing/refund.ts", startLine: 60, endLine: 62 },
    summary: "the beta defect",
    markers: ["beta-marker"],
  },
]

const alphaFinding = () => finding("f-alpha", { claim: "an alpha-marker problem" })
const betaFinding = () =>
  finding("f-beta", {
    claim: "a beta-marker problem",
    locus: { file: "src/billing/refund.ts", startLine: 60, endLine: 62 },
  })

describe("adjudicate partitions findings; it scores nothing", () => {
  test("every finding matched — nothing is left unlabelled", () => {
    const result = adjudicate(DEFECTS, [alphaFinding(), betaFinding()])

    expect(result.matched.map((row) => row.defectId)).toEqual(["alpha", "beta"])
    expect(result.unlabelled).toEqual([])
  })

  test("no finding matched — every one is UNLABELLED, and nothing is invented", () => {
    const findings = [finding("f-1"), finding("f-2", { claim: "an unrelated observation" })]

    const result = adjudicate(DEFECTS, findings)

    expect(result.matched).toEqual([])
    expect(result.unlabelled.map((f) => f.id)).toEqual(["f-1", "f-2"])
    // AC3 IN ONE ASSERTION. `unlabelled` is a queue for a human worksheet, and
    // the partition is the whole return value: no `falsePositives`, no
    // `precision`, no count, no verdict. A field like that added later is a
    // module that answered a question story 2.8 owns.
    expect(Object.keys(result).sort()).toEqual(["matched", "unlabelled"])
  })

  test("a mix — the matched and the unlabelled are separated, not merged", () => {
    const stray = finding("f-stray", { claim: "an observation nothing planted covers" })

    const result = adjudicate(DEFECTS, [alphaFinding(), stray, betaFinding()])

    expect(result.matched.map((row) => row.defectId)).toEqual(["alpha", "beta"])
    expect(result.unlabelled.map((f) => f.id)).toEqual(["f-stray"])
  })

  test("input order is preserved in `unlabelled`, so a worksheet row is stable", () => {
    const a = finding("f-a", { claim: "no marker here" })
    const b = finding("f-b", { claim: "none here either" })

    expect(adjudicate(DEFECTS, [a, b]).unlabelled.map((f) => f.id)).toEqual(["f-a", "f-b"])
    expect(adjudicate(DEFECTS, [b, a]).unlabelled.map((f) => f.id)).toEqual(["f-b", "f-a"])
  })
})

describe("the greedy one-finding-per-defect rule is inherited, not reinvented", () => {
  test("one finding carrying two defects' markers credits the FIRST defect only", () => {
    // Both markers in one finding's prose, and its locus is near both defects'
    // lines under `LINE_TOLERANCE`. Declaration order decides, and the finding
    // stays claimed — so it is neither double-counted nor left in `unlabelled`.
    const greedy = finding("f-both", {
      claim: "an alpha-marker and beta-marker problem at once",
      locus: { file: "src/billing/refund.ts", startLine: 20, endLine: 62 },
    })

    const result = adjudicate(DEFECTS, [greedy])

    expect(result.matched).toHaveLength(1)
    expect(result.matched[0]!.defectId).toBe("alpha")
    expect(result.unlabelled).toEqual([])
  })

  test("two findings for one defect leave the second UNLABELLED, never a duplicate hit", () => {
    const first = finding("f-1", { claim: "an alpha-marker problem" })
    const second = finding("f-2", { claim: "also an alpha-marker problem" })

    const result = adjudicate(DEFECTS, [first, second])

    expect(result.matched.map((row) => row.defectId)).toEqual(["alpha"])
    expect(result.matched[0]!.finding.id).toBe("f-1")
    // The duplicate is a candidate for the worksheet, not a false positive and
    // not a second hit. A human decides whether it is the same claim restated.
    expect(result.unlabelled.map((f) => f.id)).toEqual(["f-2"])
  })
})

describe("the matcher is injected, exactly as `recall()` injects it", () => {
  test("an always-false matcher puts EVERYTHING in `unlabelled` and invents nothing", () => {
    const never: DefectMatcher = () => false

    const result = adjudicate(DEFECTS, [alphaFinding(), betaFinding()], never)

    expect(result.matched).toEqual([])
    expect(result.unlabelled).toHaveLength(2)
    expect(Object.keys(result).sort()).toEqual(["matched", "unlabelled"])
  })

  test("an always-true matcher claims one finding PER DEFECT, never more", () => {
    const always: DefectMatcher = () => true
    const findings = [finding("f-1"), finding("f-2"), finding("f-3")]

    const result = adjudicate(DEFECTS, findings, always)

    expect(result.matched.map((row) => row.finding.id)).toEqual(["f-1", "f-2"])
    expect(result.unlabelled.map((f) => f.id)).toEqual(["f-3"])
  })
})

/**
 * THE PARTITION COVERS ITS INPUT (review finding P17, 2026-09-11).
 *
 * `claimed` was a `Set<Finding>` keyed on the object, so the SAME `Finding`
 * object appearing twice in the input — one arm's findings pooled with another's,
 * one bundle read twice — had its second occurrence reported as already claimed
 * and dropped from both lists. A candidate that silently left the record is one
 * no human ever adjudicates, which is the failure this module exists to prevent.
 */
describe("every input finding lands in exactly one side of the partition", () => {
  test("a duplicated finding OBJECT is not lost — the counts still add up", () => {
    const shared = alphaFinding()
    const findings = [shared, shared]

    const result = adjudicate(DEFECTS, findings)

    expect(result.matched).toHaveLength(1)
    expect(result.matched[0]!.defectId).toBe("alpha")
    // The second occurrence is a candidate nothing claimed. It is UNLABELLED —
    // not matched a second time, and above all not gone.
    expect(result.unlabelled).toHaveLength(1)
    expect(result.unlabelled[0]!.id).toBe("f-alpha")
    expect(result.matched.length + result.unlabelled.length).toBe(findings.length)
  })

  test("the coverage property holds over a duplicate-heavy mix", () => {
    const shared = betaFinding()
    const stray = finding("f-stray", { claim: "nothing planted covers this" })
    const findings = [alphaFinding(), shared, shared, stray, stray]

    const result = adjudicate(DEFECTS, findings)

    expect(result.matched.map((row) => row.defectId)).toEqual(["alpha", "beta"])
    expect(result.matched.length + result.unlabelled.length).toBe(findings.length)
    expect(result.unlabelled.map((f) => f.id)).toEqual(["f-beta", "f-stray", "f-stray"])
  })
})

describe("the shipped defect set flows through unchanged", () => {
  test("a real finding against the real labels matches the planted defect", () => {
    const sqlInjection = finding("f-sql", {
      claim: "`req.orderId` is interpolated into the SQL string",
      reasoning: "It should be parameterised; a crafted order id runs arbitrary SQL.",
      locus: { file: "src/billing/refund.ts", startLine: 20, endLine: 22 },
    })

    const result = adjudicate(SEEDED_DEFECTS, [sqlInjection])

    expect(result.matched.map((row) => row.defectId)).toEqual(["sql-injection"])
    expect(result.unlabelled).toEqual([])
  })

  test("a malformed defect set is refused before any partition is derived", () => {
    const duplicated: SeededDefect[] = [DEFECTS[0]!, DEFECTS[0]!]

    expect(() => adjudicate(duplicated, [])).toThrow("duplicate seeded defect id")
  })
})
