/**
 * The aligner's cross-arm error on the sealed set, and where it applies.
 *
 * The pinned rates below are a REGRESSION LITERAL, not a target. They were the
 * first measurement of the shipped matcher on `cross-arm-pairs-1`, taken after
 * the set was sealed. A matcher change that moves them updates the literal
 * deliberately and bumps `ALIGNER_MATCHER.version`; a label is never edited to
 * move them.
 */

import { describe, expect, test } from "bun:test"

import { LINE_TOLERANCE, lexicalSimilarity, OVERLAP_THRESHOLD } from "../core/clustering/similarity.ts"
import { SEEDED_CHANGE } from "../fixtures/seeded-defects/material.ts"
import { CROSS_ARM_CASES } from "../fixtures/cross-arm-pairs/cases.ts"
import { CROSS_ARM_PAIRS_SEAL } from "../fixtures/cross-arm-pairs/seal.ts"
import { ALIGNER_MATCHER } from "./align.ts"
import {
  countText,
  crossArmCalibrationFor,
  decimalText,
  matcherText,
  measureCrossArm,
  sealedCalibration,
} from "./cross-arm-rates.ts"
import { changeIdFor } from "./manifest.ts"

describe("the shipped matcher on cross-arm-pairs-1", () => {
  test("the rates are the pinned regression literal", async () => {
    const { calibration } = await measureCrossArm()
    expect(calibration).toEqual({
      version: "cross-arm-pairs-1",
      datasetHash: CROSS_ARM_PAIRS_SEAL.datasetHash,
      sourceDiffHash: CROSS_ARM_PAIRS_SEAL.sourceDiffHash,
      samples: 20,
      labelCounts: { equivalent: 7, distinct: 5, "only-in-one-arm": 4, ambiguous: 4 },
      matcher: ALIGNER_MATCHER,
      overMerge: { grouped: 3, of: 9 },
      underMerge: { ungrouped: 3, of: 7 },
      ambiguousExcluded: 4,
    })
  })

  test("each case's outcome is the pinned regression literal", async () => {
    const { outcomes } = await measureCrossArm()
    expect(outcomes.map((o) => [o.id, o.grouped, o.correct])).toEqual([
      ["sql-injection-reworded", true, true],
      ["money-float-two-cites", true, true],
      ["swallowed-failure-reworded", true, true],
      ["duplicate-in-one-arm", true, true],
      ["missing-await-cross-file", false, false],
      ["untested-batch-file-level", false, false],
      ["ledger-divergence-two-ends", false, false],
      ["two-defects-one-locus", true, false],
      ["chain-across-arms", true, false],
      ["adjacent-lines-different-defects", false, true],
      ["shared-words-far-apart", false, true],
      ["signature-vs-balance", false, true],
      ["lone-idempotency-finding", false, true],
      ["lone-finding-absorbed-by-neighbour", true, false],
      ["lone-file-level-finding", false, true],
      ["lone-divergence-finding", false, true],
      ["contrast-and-alt", true, undefined],
      ["currency-vs-amount-check", false, undefined],
      ["hidden-failure-two-causes", false, undefined],
      ["per-row-query-vs-unused-charge", false, undefined],
    ])
  })

  test("a perfect score is not on offer: wrong cases exist in BOTH directions", async () => {
    const { calibration } = await measureCrossArm()
    expect(calibration.overMerge.grouped).toBeGreaterThan(0)
    expect(calibration.underMerge.ungrouped).toBeGreaterThan(0)
  })

  test("the matcher identity carries the shipped thresholds", () => {
    expect(ALIGNER_MATCHER.lineTolerance).toBe(LINE_TOLERANCE)
    expect(ALIGNER_MATCHER.overlapThreshold).toBe(OVERLAP_THRESHOLD)
    expect(ALIGNER_MATCHER.version).toBe("lexical-single-linkage-1")
  })
})

describe("degenerate matchers drive the rates to their full denominators", () => {
  test("a matcher that answers `similar` to everything over-merges every case that should stay apart", async () => {
    const { calibration } = await measureCrossArm(CROSS_ARM_CASES, () => true)
    expect(calibration.overMerge.of).toBe(9)
    expect(calibration.overMerge.grouped).toBe(calibration.overMerge.of)
    expect(calibration.matcher).toBe("injected")
  })

  test("a matcher that answers `different` to everything under-merges every equivalent case", async () => {
    const { calibration } = await measureCrossArm(CROSS_ARM_CASES, () => false)
    expect(calibration.underMerge.of).toBe(7)
    expect(calibration.underMerge.ungrouped).toBe(calibration.underMerge.of)
    expect(calibration.overMerge.grouped).toBe(0)
  })
})

describe("ambiguous cases are preserved and excluded", () => {
  test("they sit in neither denominator, and their count is reported", async () => {
    const { calibration, outcomes } = await measureCrossArm()
    expect(calibration.ambiguousExcluded).toBe(4)
    expect(calibration.overMerge.of + calibration.underMerge.of + calibration.ambiguousExcluded).toBe(
      calibration.samples,
    )
    for (const o of outcomes.filter((o) => o.label === "ambiguous")) expect(o.correct).toBeUndefined()
  })

  test("grouping every ambiguous case moves neither rate", async () => {
    const ambiguousIds = new Set(
      CROSS_ARM_CASES.filter((c) => c.label === "ambiguous").flatMap((c) =>
        [...c.armA, ...c.armB].map((f) => f.id),
      ),
    )
    // `alignArms` namespaces ids as `<arm>::<id>`; finding ids are unique across
    // the set (`seal.test.ts`). An id with no separator is taken whole.
    const inAmbiguousCase = (id: string) => {
      const separator = id.indexOf("::")
      return ambiguousIds.has(separator === -1 ? id : id.slice(separator + 2))
    }
    const shipped = await measureCrossArm()
    const lenient = await measureCrossArm(CROSS_ARM_CASES, (a, b) =>
      inAmbiguousCase(a.id) && inAmbiguousCase(b.id) ? true : lexicalSimilarity(a, b),
    )
    expect(lenient.outcomes.filter((o) => o.label === "ambiguous").every((o) => o.grouped)).toBe(true)
    expect(lenient.calibration.overMerge).toEqual(shipped.calibration.overMerge)
    expect(lenient.calibration.underMerge).toEqual(shipped.calibration.underMerge)
  })
})

describe("an empty denominator is not a rate", () => {
  test("a set with no equivalent cases reports 0 of 0 as data and renders it as not measurable", async () => {
    const degenerate = CROSS_ARM_CASES.filter((c) => c.label !== "equivalent")
    const { calibration } = await measureCrossArm(degenerate)
    expect(calibration.underMerge).toEqual({ ungrouped: 0, of: 0 })
    expect(calibration.version).toBe("unsealed")
    // An unsealed set names no source change, so it claims no applicability.
    expect(calibration.sourceDiffHash).toBeNull()
    expect(countText(calibration.underMerge.ungrouped, calibration.underMerge.of)).toBe(
      "not measurable (0 cases)",
    )
    expect(countText(3, 9)).toBe("3 of 9")
  })
})

describe("a malformed case is refused, not scored", () => {
  test("a missing subject throws", async () => {
    const first = CROSS_ARM_CASES[0]!
    await expect(measureCrossArm([{ ...first, subjectB: "nope" }])).rejects.toThrow("no subjectB")
    await expect(measureCrossArm([{ ...first, subjectA: "nope" }])).rejects.toThrow("no subjectA")
  })

  test("a finding id repeated inside one case throws, before `alignArms` could overwrite one", async () => {
    const first = CROSS_ARM_CASES[0]!
    const clash = { ...first, armB: [{ ...first.armB[0]!, id: first.subjectA }], subjectB: first.subjectA }
    await expect(measureCrossArm([clash])).rejects.toThrow("repeats finding id(s)")
  })

  test("a matcher that throws is refused, not counted as `not similar`", async () => {
    const thrown = measureCrossArm(CROSS_ARM_CASES, () => {
      throw new Error("matcher down")
    })
    await expect(thrown).rejects.toThrow("the matcher threw on")
  })

  test("an only-in-one-arm case that names a counterpart throws", async () => {
    const lone = CROSS_ARM_CASES.find((c) => c.label === "only-in-one-arm")!
    await expect(measureCrossArm([{ ...lone, subjectB: lone.armB[0]!.id }])).rejects.toThrow(
      "names a subjectB",
    )
  })
})

describe("applicability is the reviewed change's diff hash, and nothing else", () => {
  test("the recorded source diff hash is what the manifest writes for SEEDED_CHANGE", () => {
    expect(changeIdFor(SEEDED_CHANGE).diffHash).toBe(CROSS_ARM_PAIRS_SEAL.sourceDiffHash)
  })

  test("a run over SEEDED_CHANGE gets the calibration", async () => {
    const calibration = await crossArmCalibrationFor(SEEDED_CHANGE)
    expect(calibration).toEqual((await measureCrossArm()).calibration)
  })

  test("a run over any other diff gets none", async () => {
    expect(await crossArmCalibrationFor({ ...SEEDED_CHANGE, diff: `${SEEDED_CHANGE.diff} ` })).toBeUndefined()
    expect(
      await crossArmCalibrationFor({ description: "other", files: ["a.ts"], diff: "--- a/a.ts\n+++ b/a.ts\n" }),
    ).toBeUndefined()
  })

  test("description and file list do not decide it — only the diff does", async () => {
    const renamed = { ...SEEDED_CHANGE, description: "a different description", files: ["x.ts"] }
    expect(await crossArmCalibrationFor(renamed)).toBeDefined()
  })
})

describe("only the sealed set, scored by the shipped matcher, may enter a report", () => {
  test("the sealed measurement passes", async () => {
    const measurement = await measureCrossArm()
    expect(sealedCalibration(measurement)).toBe(measurement.calibration)
  })

  test("a drifted set is refused rather than printed under the sealed version", async () => {
    const drifted = await measureCrossArm(CROSS_ARM_CASES.slice(1))
    expect(() => sealedCalibration(drifted)).toThrow("not the sealed")
  })

  test("the sealed cases under an injected matcher are refused", async () => {
    const injected = await measureCrossArm(CROSS_ARM_CASES, () => false)
    expect(() => sealedCalibration(injected)).toThrow("injected matcher")
  })
})

describe("the matcher renders without a float", () => {
  test("decimalText refuses a number that does not print as a plain decimal", () => {
    expect(decimalText(0.34)).toBe("34/100")
    expect(decimalText(8)).toBe("8")
    expect(decimalText(0.05)).toBe("5/100")
    for (const bad of [1e-7, -0.34, Number.NaN, Number.POSITIVE_INFINITY, 1e21]) {
      expect(() => decimalText(bad)).toThrow("not a non-negative plain decimal")
    }
  })

  test("the overlap threshold prints as an exact ratio of integers", () => {
    expect(matcherText(ALIGNER_MATCHER)).toBe(
      "lexical-single-linkage-1 (line tolerance 8, overlap threshold 34/100, block key file-basename, linkage single)",
    )
    expect(matcherText(ALIGNER_MATCHER)).not.toMatch(/\d\.\d/)
  })
})
