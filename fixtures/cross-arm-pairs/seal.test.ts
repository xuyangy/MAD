/**
 * The cross-arm case set is sealed against drift, and it is the set the header
 * says it is.
 *
 * **What to do when this test fails.** Do not paste the new hash in. Decide
 * first whether the set was supposed to change. If it was, bump
 * `CROSS_ARM_PAIRS_SEAL.version` and update the literal below in the same
 * commit, and re-measure the rates on the new version. If it was not, the edit
 * that moved the bytes is the bug. A label is never edited to move a rate.
 */

import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"

import { SEEDED_CHANGE } from "../seeded-defects/material.ts"
import { CROSS_ARM_CASES, CROSS_ARM_LABELS, type CrossArmCase } from "./cases.ts"
import { CANONICAL_FINDING_FIELDS, CROSS_ARM_PAIRS_SEAL, canonicalCases, datasetHashOf } from "./seal.ts"

/** Sealed 2026-09-11, story 2.5, before the aligner was first scored on this set. */
const SEALED_DATASET_HASH = "sha256:9d07db2dcd532642290f41c7d1ca38a2592caaa9fc7ad5c27873b1665e503786"
/** `SEEDED_CHANGE.diff` as it stood when the cases were labelled (`labelled-change-1`). */
const SEALED_SOURCE_DIFF_HASH = "sha256:cea5679939f5cb4ccd90230a4eddde861119f375ced04cad474fc2b0ec57e213"

const hash = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`

/**
 * Every hunk's post-change line range, per file, in diff order. A header with
 * no `,count` (`@@ -40 +41 @@`) covers one line, as unified diff defines it.
 */
function hunkRanges(diff: string): Map<string, { first: number; last: number }[]> {
  const ranges = new Map<string, { first: number; last: number }[]>()
  let current: string | undefined
  for (const line of diff.split("\n")) {
    const file = /^\+\+\+ b\/(.+)$/.exec(line)
    if (file) {
      current = file[1]!
      if (!ranges.has(current)) ranges.set(current, [])
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk && current !== undefined) {
      const first = Number(hunk[1])
      const count = hunk[2] === undefined ? 1 : Number(hunk[2])
      ranges.get(current)!.push({ first, last: first + count - 1 })
    }
  }
  return ranges
}

describe("the cross-arm case set is sealed", () => {
  test("the dataset hash is the sealed literal", () => {
    expect(CROSS_ARM_PAIRS_SEAL.datasetHash).toBe(SEALED_DATASET_HASH)
  })

  test("the recorded dataset hash is the hash of the cases as they stand", () => {
    // Both sides are literals in source, so this is the check that joins them to
    // the bytes: red when a case moves without a re-seal.
    expect(datasetHashOf(CROSS_ARM_CASES)).toBe(CROSS_ARM_PAIRS_SEAL.datasetHash)
  })

  test("the recorded source diff hash is the sealed literal", () => {
    expect(CROSS_ARM_PAIRS_SEAL.sourceDiffHash).toBe(SEALED_SOURCE_DIFF_HASH)
  })

  test("the recorded source diff is the seeded change as it stands", () => {
    // Red when `SEEDED_CHANGE.diff` moves: the cases cite its lines, so they
    // must be relabelled against the new diff under a new version.
    expect(hash(SEEDED_CHANGE.diff)).toBe(SEALED_SOURCE_DIFF_HASH)
  })

  test("the version is a hand-written non-empty literal", () => {
    expect(CROSS_ARM_PAIRS_SEAL.version).toBe("cross-arm-pairs-1")
  })

  test("both hashes carry the `sha256:` shape the manifest uses", () => {
    expect(CROSS_ARM_PAIRS_SEAL.datasetHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(CROSS_ARM_PAIRS_SEAL.sourceDiffHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

describe("the canonical serialization is reproducible from the header", () => {
  test("the dataset hash is sha256 over the canonical text", () => {
    expect(hash(canonicalCases())).toBe(SEALED_DATASET_HASH)
  })

  test("the canonical text names its fields", () => {
    const text = canonicalCases()
    for (const field of ["id", "label", "armA", "armB", "subjectA", "subjectB", "why"]) {
      expect(text).toContain(JSON.stringify(field))
    }
    for (const field of CANONICAL_FINDING_FIELDS) expect(text).toContain(JSON.stringify(field))
  })

  test("no finding carries a field the canonical text does not cover", () => {
    const covered = new Set<string>(CANONICAL_FINDING_FIELDS)
    for (const c of CROSS_ARM_CASES) {
      for (const finding of [...c.armA, ...c.armB]) {
        for (const key of Object.keys(finding)) expect(covered.has(key)).toBe(true)
        for (const key of Object.keys(finding.locus)) {
          expect(["file", "startLine", "endLine"]).toContain(key)
        }
      }
    }
  })

  test("one changed byte in a case moves the hash", () => {
    const first = CROSS_ARM_CASES[0]!
    const edited: CrossArmCase[] = [
      { ...first, armA: [{ ...first.armA[0]!, claim: `${first.armA[0]!.claim} ` }] },
      ...CROSS_ARM_CASES.slice(1),
    ]
    expect(hash(canonicalCases(edited))).not.toBe(SEALED_DATASET_HASH)
  })

  test("a changed label moves the hash", () => {
    const edited = CROSS_ARM_CASES.map((c, index) =>
      index === 0 ? { ...c, label: "distinct" as const } : c,
    )
    expect(hash(canonicalCases(edited))).not.toBe(SEALED_DATASET_HASH)
  })

  test("a reordering moves the hash", () => {
    expect(hash(canonicalCases([...CROSS_ARM_CASES].reverse()))).not.toBe(SEALED_DATASET_HASH)
  })
})

describe("the set is well formed", () => {
  test("at least four cases carry each of the four labels", () => {
    for (const label of CROSS_ARM_LABELS) {
      expect(CROSS_ARM_CASES.filter((c) => c.label === label).length).toBeGreaterThanOrEqual(4)
    }
  })

  test("case ids are unique, and finding ids are unique across the WHOLE set", () => {
    expect(new Set(CROSS_ARM_CASES.map((c) => c.id)).size).toBe(CROSS_ARM_CASES.length)
    // Across the set, not only inside a case: `ablation/cross-arm-rates.test.ts`
    // identifies a case's findings by id alone.
    const ids = CROSS_ARM_CASES.flatMap((c) => [...c.armA, ...c.armB].map((f) => f.id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("every cited range runs forwards", () => {
    for (const c of CROSS_ARM_CASES) {
      for (const { locus } of [...c.armA, ...c.armB]) {
        if (locus.startLine !== undefined && locus.endLine !== undefined) {
          expect(locus.startLine).toBeLessThanOrEqual(locus.endLine)
        }
      }
    }
  })

  test("subjectA is in arm A; subjectB is in arm B exactly when the label names a counterpart", () => {
    for (const c of CROSS_ARM_CASES) {
      expect(c.armA.some((f) => f.id === c.subjectA)).toBe(true)
      expect(c.armB.length).toBeGreaterThan(0)
      if (c.label === "only-in-one-arm") {
        expect(c.subjectB).toBeUndefined()
      } else {
        expect(c.armB.some((f) => f.id === c.subjectB)).toBe(true)
      }
    }
  })

  test("every `why` is non-empty", () => {
    for (const c of CROSS_ARM_CASES) expect(c.why.trim().length).toBeGreaterThan(0)
  })

  /**
   * The cases are drawn from `SEEDED_CHANGE`, and applicability rests on that:
   * every cited file is one of its files, and every cited line lies inside the
   * post-change lines its hunk writes.
   */
  test("every finding cites a SEEDED_CHANGE file, inside one hunk's post-change lines", () => {
    const ranges = hunkRanges(SEEDED_CHANGE.diff)
    expect([...ranges.keys()].sort()).toEqual([...SEEDED_CHANGE.files].sort())

    for (const c of CROSS_ARM_CASES) {
      for (const finding of [...c.armA, ...c.armB]) {
        const hunks = ranges.get(finding.locus.file)
        expect(hunks).toBeDefined()
        const { startLine, endLine } = finding.locus
        if (startLine === undefined) continue
        const last = endLine ?? startLine
        // The whole cited range inside ONE hunk: a range spanning two hunks
        // covers lines the diff does not show.
        expect(hunks!.some((h) => startLine >= h.first && last <= h.last)).toBe(true)
      }
    }
  })

  test("the hunk reader keeps every hunk, and reads a header with no count as one line", () => {
    const diff = [
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,2 +1,3 @@",
      "@@ -40 +41 @@ fn",
      "--- a/y.ts",
      "+++ b/y.ts",
      "@@ -0,0 +1,5 @@",
    ].join("\n")
    const ranges = hunkRanges(diff)
    expect(ranges.get("x.ts")).toEqual([
      { first: 1, last: 3 },
      { first: 41, last: 41 },
    ])
    expect(ranges.get("y.ts")).toEqual([{ first: 1, last: 5 }])
  })
})
