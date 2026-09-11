/**
 * The operator-facing procedure, tied to the thing it documents (review finding
 * P16, 2026-09-11).
 *
 * `ablation/LIVE-RUN.md` prints the sealed labelled change's identity so a bundle
 * can be checked after the fact. Nothing connected that printed text to
 * `LABELLED_CHANGE_SEAL`, and the two are designed to move at different times:
 * `fixtures/seeded-defects/seal.test.ts` deliberately turns red when the fixture
 * changes, forcing a hand-written version bump — and that bump would have left
 * the documented hash stale with the whole suite green. An operator checking a
 * bundle against a stale hash concludes the bundle is wrong, which is worse than
 * having no documented hash at all.
 *
 * This is a document test and it asserts exactly two things: that the identity is
 * there, and that it is the CURRENT one.
 */

import { describe, expect, test } from "bun:test"

import { LABELLED_CHANGE_SEAL } from "../fixtures/seeded-defects/seal.ts"

const liveRunDoc = () => Bun.file(new URL("./LIVE-RUN.md", import.meta.url)).text()

describe("LIVE-RUN.md documents the sealed fixture identity that is actually in force", () => {
  test("the material hash in the document is the seal's", async () => {
    expect(await liveRunDoc()).toContain(LABELLED_CHANGE_SEAL.materialHash)
  })

  test("the version in the document is the seal's", async () => {
    expect(await liveRunDoc()).toContain(LABELLED_CHANGE_SEAL.version)
  })

  /**
   * THE LABELS HASH IS NOT AN OPERATOR-FACING NUMBER. It seals the answer key,
   * which no arm reads; a manifest of what was reviewed has no place for it, and
   * a procedure that printed it beside the material hash would invite someone to
   * paste the wrong one into `--fixture-hash`.
   */
  test("the labels hash is NOT in the document", async () => {
    expect(await liveRunDoc()).not.toContain(LABELLED_CHANGE_SEAL.labelsHash)
  })

  /**
   * THE UNLABELLED RECIPE MUST NOT HAND OUT THE SEALED IDENTITY (review finding
   * P2). The bundle example reviews `--directory /path/to/repo` — an unlabelled
   * change — and it used to carry `--fixture-version labelled-change-1` and the
   * sealed material hash on its own command lines. That is a copy-pasteable
   * manifest naming a fixture that was not reviewed.
   */
  test("no --fixture-version or --fixture-hash flag appears on any documented command", async () => {
    const doc = await liveRunDoc()
    const commands = [...doc.matchAll(/```\n([\s\S]*?)```/g)].map((match) => match[1]!)

    expect(commands.length).toBeGreaterThan(0)
    for (const command of commands) {
      expect(command).not.toContain("--fixture-version")
      expect(command).not.toContain("--fixture-hash")
    }
  })
})
