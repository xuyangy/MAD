/**
 * Unit tests for the CAP-1 recall harness itself.
 *
 * These exist because the harness had none: the seeded-defect suite scripts its
 * findings at loci IDENTICAL to the planted defects', so `LINE_TOLERANCE = 0`,
 * `nearEnough` deleted outright, and `sameFile` reduced to strict equality all
 * left `bun test fixtures` fully green. The rule that decides what counts as
 * "found" — the thing CAP-1's number rests on — was unverified in every part
 * except its marker check.
 *
 * Every test below is written to FAIL under one of those mutations. If a change
 * to the matcher does not break something here, this file is not doing its job.
 */

import { describe, expect, test } from "bun:test"

import type { Finding, Locus } from "../core/domain/finding.ts"
import {
  LINE_TOLERANCE,
  lexicalDefectMatcher,
  nearEnough,
  recall,
  recallByAuthor,
  sameFile,
  validateSeededDefects,
  type SeededDefect,
} from "./recall.ts"

const FILE = "src/billing/refund.ts"

function defect(partial: Partial<SeededDefect> = {}): SeededDefect {
  return {
    id: partial.id ?? "planted",
    dimension: partial.dimension ?? "correctness",
    locus: partial.locus ?? { file: FILE, startLine: 20, endLine: 22 },
    summary: partial.summary ?? "a planted bug",
    markers: partial.markers ?? ["injection"],
  }
}

function finding(partial: Partial<Finding> & { locus?: Locus } = {}): Finding {
  return {
    id: partial.id ?? "finding-1",
    claim: partial.claim ?? "The order id is interpolated into the query.",
    reasoning: partial.reasoning ?? "A crafted id rewrites the statement.",
    locus: partial.locus ?? { file: FILE, startLine: 20, endLine: 22 },
    severity: partial.severity ?? "high",
    author: partial.author ?? "discovery-1",
    source: partial.source ?? "pool",
    lens: partial.lens,
    history: [],
  }
}

describe("lexicalDefectMatcher — the marker check", () => {
  test("prose carrying no marker is not a match, however close the locus", () => {
    expect(
      lexicalDefectMatcher(
        defect({ markers: ["idempot"] }),
        finding({ claim: "Nothing to do with it.", reasoning: "Style only." }),
      ),
    ).toBe(false)
  })

  test("a marker is found in either the claim or the reasoning, case-insensitively", () => {
    expect(
      lexicalDefectMatcher(
        defect({ markers: ["INTERPOLAT"] }),
        finding({ claim: "no marker here", reasoning: "the id is interpolated into the SQL" }),
      ),
    ).toBe(true)
  })
})

describe("nearEnough — the locus check (kills a deleted or degenerate tolerance)", () => {
  const planted = defect({ locus: { file: FILE, startLine: 20, endLine: 22 } })

  test("the tolerance is real slack, not zero", () => {
    // Pinned as an absolute, because every assertion below that is written
    // RELATIVE to LINE_TOLERANCE stays true when the constant is 0 — which is
    // exactly how a degenerate tolerance survived CI in the first place.
    expect(LINE_TOLERANCE).toBeGreaterThanOrEqual(3)
  })

  test("a cite three lines above the planted start matches (absolute, not relative)", () => {
    // The case the doc comment promises: "a model that reports the right bug two
    // lines above the planted line has found it". Fails at LINE_TOLERANCE < 3.
    expect(nearEnough(planted, finding({ locus: { file: FILE, startLine: 17, endLine: 17 } }))).toBe(
      true,
    )
  })

  test("a cite well past any sane tolerance does not match (absolute)", () => {
    expect(nearEnough(planted, finding({ locus: { file: FILE, startLine: 400, endLine: 400 } }))).toBe(
      false,
    )
  })

  test("an exact line cite matches", () => {
    expect(nearEnough(planted, finding({ locus: { file: FILE, startLine: 20, endLine: 22 } }))).toBe(
      true,
    )
  })

  test("a cite the full tolerance BELOW the planted start still matches", () => {
    // Fails if LINE_TOLERANCE is reduced to 0: this is the whole point of the
    // slack, per its own doc comment ("two lines above the planted line").
    const line = 20 - LINE_TOLERANCE
    expect(nearEnough(planted, finding({ locus: { file: FILE, startLine: line, endLine: line } }))).toBe(
      true,
    )
  })

  test("a cite the full tolerance ABOVE the planted end still matches", () => {
    const line = 22 + LINE_TOLERANCE
    expect(nearEnough(planted, finding({ locus: { file: FILE, startLine: line, endLine: line } }))).toBe(
      true,
    )
  })

  test("a cite one line PAST the tolerance does not match", () => {
    // Fails if nearEnough is deleted or forced true.
    const line = 22 + LINE_TOLERANCE + 1
    expect(nearEnough(planted, finding({ locus: { file: FILE, startLine: line, endLine: line } }))).toBe(
      false,
    )
  })

  test("a cite far below the tolerance does not match", () => {
    const line = 20 - LINE_TOLERANCE - 1
    expect(nearEnough(planted, finding({ locus: { file: FILE, startLine: line, endLine: line } }))).toBe(
      false,
    )
  })

  test("a defect with no line is judged on markers alone", () => {
    const architectural = defect({ locus: { file: FILE } })
    expect(
      nearEnough(architectural, finding({ locus: { file: FILE, startLine: 900, endLine: 900 } })),
    ).toBe(true)
  })

  test("a FINDING with no line cannot claim a line-anchored defect", () => {
    // The asymmetry that stops one vague file-level claim collecting every
    // planted defect in the file whose markers it happens to mention.
    expect(nearEnough(planted, finding({ locus: { file: FILE } }))).toBe(false)
  })
})

describe("sameFile — the path check (kills a strict-equality or always-true mutation)", () => {
  test("a different file never matches", () => {
    // Fails if sameFile is forced true.
    expect(
      lexicalDefectMatcher(defect(), finding({ locus: { file: "src/billing/ledger.ts", startLine: 20 } })),
    ).toBe(false)
  })

  test("a qualified shorter path matches the fixture's longer one", () => {
    // Fails if sameFile is reduced to strict equality — the tolerance a real
    // model's shorter cite depends on.
    expect(sameFile(defect(), finding({ locus: { file: "billing/refund.ts", startLine: 20 } }))).toBe(
      true,
    )
  })

  test("a bare basename does NOT match, because two files can share one", () => {
    expect(sameFile(defect(), finding({ locus: { file: "refund.ts", startLine: 20 } }))).toBe(false)
  })

  test("separators and a leading ./ are normalized", () => {
    expect(
      sameFile(defect(), finding({ locus: { file: "./src/billing/refund.ts", startLine: 20 } })),
    ).toBe(true)
    expect(
      sameFile(defect(), finding({ locus: { file: "src\\billing\\refund.ts", startLine: 20 } })),
    ).toBe(true)
  })
})

describe("recall — counting", () => {
  test("one finding claims AT MOST ONE defect", () => {
    // Two defects at the same locus whose markers both appear in one finding's
    // prose. Crediting both would overstate what the model actually located.
    const defects = [
      defect({ id: "float", markers: ["/ 100"] }),
      defect({ id: "currency", markers: ["currency"] }),
    ]
    const one = finding({
      claim: "amountCents / 100 ignores charge.currency.",
      reasoning: "Both the rounding and the currency are wrong.",
    })
    expect(recall(defects, [one])).toEqual({ found: 1, total: 2 })
  })

  test("two findings covering two defects count as two", () => {
    const defects = [
      defect({ id: "float", markers: ["/ 100"] }),
      defect({ id: "currency", markers: ["currency"] }),
    ]
    expect(
      recall(defects, [
        finding({ id: "f1", claim: "amountCents / 100 is a float.", reasoning: "rounding" }),
        finding({ id: "f2", claim: "charge.currency is ignored.", reasoning: "zero-decimal" }),
      ]),
    ).toEqual({ found: 2, total: 2 })
  })

  test("`total` is the defect count regardless of how many findings arrive", () => {
    expect(recall([defect()], []).total).toBe(1)
    expect(recall([defect()], [finding(), finding({ id: "f2" })]).total).toBe(1)
  })

  test("an injected matcher fully replaces the default", () => {
    expect(recall([defect()], [finding()], () => false)).toEqual({ found: 0, total: 1 })
    expect(recall([defect({ markers: ["nope"] })], [finding()], () => true).found).toBe(1)
  })
})

describe("validateSeededDefects — a malformed set fails loudly, not quietly", () => {
  test("a duplicate id throws rather than making `found === total` unreachable", () => {
    expect(() => validateSeededDefects([defect({ id: "same" }), defect({ id: "same" })])).toThrow(
      "duplicate seeded defect id: same",
    )
  })

  test("an empty marker list throws rather than silently understating recall", () => {
    expect(() => validateSeededDefects([defect({ id: "mute", markers: [] })])).toThrow(
      "seeded defect mute has no markers",
    )
  })

  test("recall refuses to score a malformed set", () => {
    expect(() => recall([defect({ id: "mute", markers: [] })], [finding()])).toThrow("no markers")
  })

  test("a well-formed set passes", () => {
    expect(() => validateSeededDefects([defect({ id: "a" }), defect({ id: "b" })])).not.toThrow()
  })
})

describe("recallByAuthor — every participating arm, not every vocal one", () => {
  const defects = [defect({ id: "a", markers: ["injection"] })]

  test("a model that answered and raised nothing is an arm with recall 0", () => {
    const arms = recallByAuthor(defects, [finding({ author: "discovery-1" })], lexicalDefectMatcher, [
      "discovery-1",
      "discovery-2",
    ])
    expect(arms.map((a) => a.author)).toEqual(["discovery-1", "discovery-2"])
    expect(arms.find((a) => a.author === "discovery-2")!.recall).toEqual({ found: 0, total: 1 })
  })

  test("without `answered`, only authors present in the findings appear", () => {
    const arms = recallByAuthor(defects, [finding({ author: "discovery-1" })])
    expect(arms.map((a) => a.author)).toEqual(["discovery-1"])
  })

  test("arms are sorted by author, so a rendered comparison is stable", () => {
    const arms = recallByAuthor(
      defects,
      [finding({ author: "discovery-3" }), finding({ id: "f2", author: "discovery-1" })],
      lexicalDefectMatcher,
      ["discovery-2"],
    )
    expect(arms.map((a) => a.author)).toEqual(["discovery-1", "discovery-2", "discovery-3"])
  })
})
