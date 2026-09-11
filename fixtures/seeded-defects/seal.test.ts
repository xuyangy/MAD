/**
 * The seal, frozen against drift (story 2.4, Task 4).
 *
 * `evaluation-protocol.md:465` requires the fixture "sealed with content hashes
 * **before** 2.4's first live run", and `:73-79` requires the change and the
 * true-defect reference set identified by **immutable** content hashes. A
 * constant computed at import time is not immutable by itself — it recomputes
 * happily over whatever the files now say. The two literals below are what make
 * it immutable: editing a diff line, a marker, a locus or a summary without
 * bumping `LABELLED_CHANGE_SEAL.version` turns CI red here.
 *
 * **What to do when this test fails.** Do not paste the new hash in. Decide
 * first whether the set was supposed to change. If it was, bump `version` in
 * `seal.ts` AND update the literal beside it in the same commit, so the manifest
 * of every past run still names a set that can be told apart from this one. If it
 * was not, the edit that moved the bytes is the bug.
 *
 * The hashes are pinned SEPARATELY on purpose: a material edit and a label edit
 * are different events with different consequences — the first changes what the
 * models see, the second changes what they are scored against — and one fused
 * hash could not tell an operator which had happened.
 */

import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"

import { BASE_TREE, SEEDED_CHANGE } from "./material.ts"
import { LABELLED_CHANGE_SEAL, canonicalLabels, canonicalMaterial } from "./seal.ts"

/** Sealed 2026-09-11, story 2.4, before this fixture's first live run. */
const SEALED_MATERIAL_HASH = "sha256:76523deb36aee41eb6ce9aaf1f9a51efbde5b404f839b1b20483016968fd848d"
const SEALED_LABELS_HASH = "sha256:8e95a53afd7ef9216715f90e9a6f28b34c6b60ecca3bff1882eefb83b8a75105"

describe("the labelled change is sealed", () => {
  test("the material hash is the sealed literal", () => {
    expect(LABELLED_CHANGE_SEAL.materialHash).toBe(SEALED_MATERIAL_HASH)
  })

  test("the labels hash is the sealed literal", () => {
    expect(LABELLED_CHANGE_SEAL.labelsHash).toBe(SEALED_LABELS_HASH)
  })

  test("the version is a hand-written non-empty literal", () => {
    expect(LABELLED_CHANGE_SEAL.version).toBe("labelled-change-1")
    expect(LABELLED_CHANGE_SEAL.version.trim().length).toBeGreaterThan(0)
  })

  test("both hashes carry the `sha256:` shape the manifest already uses", () => {
    expect(LABELLED_CHANGE_SEAL.materialHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(LABELLED_CHANGE_SEAL.labelsHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  test("the two hashes are different, so one cannot stand in for the other", () => {
    expect(LABELLED_CHANGE_SEAL.materialHash).not.toBe(LABELLED_CHANGE_SEAL.labelsHash)
  })
})

/**
 * The canonical serializations are the CONTRACT, not an implementation detail:
 * anyone re-deriving a published fixture hash has to reproduce them from the
 * module header alone. These re-hash them independently, so a change to how
 * `seal.ts` computes its digest (a different encoding, a different primitive)
 * fails here rather than silently producing a number nobody else can reproduce.
 */
describe("the canonical serializations are reproducible from the header", () => {
  const hash = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`

  test("the material hash is sha256 over the canonical material text", () => {
    expect(hash(canonicalMaterial())).toBe(SEALED_MATERIAL_HASH)
  })

  test("the labels hash is sha256 over the canonical labels text", () => {
    expect(hash(canonicalLabels())).toBe(SEALED_LABELS_HASH)
  })

  test("the canonical texts name their fields, so two shapes cannot collide", () => {
    expect(canonicalMaterial()).toContain('"description"')
    expect(canonicalMaterial()).toContain('"files"')
    expect(canonicalMaterial()).toContain('"diff"')
    expect(canonicalMaterial()).toContain('"baseTree"')
    expect(canonicalLabels()).toContain('"markers"')
    expect(canonicalLabels()).toContain('"locus"')
  })

  /**
   * THE BASE TREE IS INSIDE THE MATERIAL HASH (review finding P6, 2026-09-11).
   *
   * `BASE_TREE` is what the materializer writes and commits before the diff is
   * applied, so its bytes are bytes a model opens in the reviewed worktree.
   * While it sat outside `canonicalMaterial()`, editing a base file changed what
   * the models see without moving `materialHash` and without reddening this
   * file — a fixture identity that no longer identified the fixture.
   */
  test("every base-tree path and its contents are inside the material hash", () => {
    for (const [path, contents] of Object.entries(BASE_TREE)) {
      expect(canonicalMaterial()).toContain(JSON.stringify(path))
      expect(canonicalMaterial()).toContain(JSON.stringify(contents))
    }
  })

  test("the inclusion is non-vacuous — one edited base-tree byte moves the hash", () => {
    // The same canonicalization, over a base tree with one character changed.
    // If `BASE_TREE` were still outside the seal this would equal the literal.
    const edited = JSON.stringify([
      "description",
      SEEDED_CHANGE.description,
      "files",
      [...SEEDED_CHANGE.files].sort(),
      "diff",
      SEEDED_CHANGE.diff,
      "baseTree",
      Object.entries(BASE_TREE)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([path, contents], index) => [path, index === 0 ? `${contents} ` : contents]),
    ])

    expect(hash(edited)).not.toBe(SEALED_MATERIAL_HASH)
  })

  test("the assertion is non-vacuous — a changed byte changes the hash", () => {
    expect(hash(`${canonicalMaterial()} `)).not.toBe(SEALED_MATERIAL_HASH)
    expect(hash(`${canonicalLabels()} `)).not.toBe(SEALED_LABELS_HASH)
  })
})
