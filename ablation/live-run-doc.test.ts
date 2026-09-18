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

import { CROSS_ARM_PAIRS_SEAL } from "../fixtures/cross-arm-pairs/seal.ts"
import { LABELLED_CHANGE_SEAL } from "../fixtures/seeded-defects/seal.ts"
import { PREFIX_FILE } from "./bundle.ts"
import { HALT_MARKER_FILE } from "./governor.ts"
import {
  ADJUDICATION_QUANTITIES,
  ADJUDICATION_SHEET_FILE,
  ADJUDICATION_SHEET_VERSION,
  TRUTH_LABELS,
} from "./adjudication-read.ts"
import { PAIRED_QUANTITIES } from "./paired-read.ts"
import { ADJUDICATION_READER_MODULE, LABELLED_READER_MODULE, PAIRED_READER_MODULE } from "./report.ts"
import { PAIRED_BLOCKS, SCHEDULE_FILE, SLOT_STATUS_FILE } from "./schedule.ts"

const liveRunDoc = () => Bun.file(new URL("./LIVE-RUN.md", import.meta.url)).text()

describe("LIVE-RUN.md names the cross-arm case set that is actually in force", () => {
  test("the cross-arm set version in the document is the seal's", async () => {
    expect(await liveRunDoc()).toContain(CROSS_ARM_PAIRS_SEAL.version)
  })

  /**
   * The document names neither cross-arm hash today. If one is ever added, it
   * must be the CURRENT one: every `sha256:` literal in the document has to be an
   * identity in force, so a re-sealed set cannot leave a stale hash behind.
   */
  test("every sha256 in the document is a current seal identity", async () => {
    const current = new Set([
      LABELLED_CHANGE_SEAL.materialHash,
      CROSS_ARM_PAIRS_SEAL.datasetHash,
      CROSS_ARM_PAIRS_SEAL.sourceDiffHash,
    ])
    const named = [...(await liveRunDoc()).matchAll(/sha256:[0-9a-f]{64}/g)].map((match) => match[0])
    expect(named.length).toBeGreaterThan(0)
    for (const hash of named) expect(current.has(hash)).toBe(true)
  })

  test("the scope of the labelled-run counts is stated", async () => {
    const doc = (await liveRunDoc()).replace(/\s+/g, " ")
    expect(doc).toContain("They were NOT measured on the run's own findings.")
    expect(doc).toContain("Some cases were built so the shipped matcher gets them wrong")
    expect(doc).toContain("The denominators are small")
    expect(doc).toContain("They carry over to no other change.")
  })

  test("the unlabelled-change limitation is still stated", async () => {
    expect((await liveRunDoc()).replace(/\s+/g, " ")).toContain(
      "On an unlabelled change no cross-arm labelled set applies, and the cross-arm error is unmeasured.",
    )
  })
})

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

/**
 * FR8 (story 2-5d) — the paired reader's procedure, tied to the reader.
 *
 * This section tells an operator what `bun run eval-read` prints from a paired
 * bundle, and every claim in it is a claim about code in this tree. The file
 * names, the module, the quantity list and the slot count are all values some
 * module exports, so the document is bound to them here for the reason the
 * fixture identity above is bound: a renamed file or a renamed quantity would
 * otherwise leave a confidently wrong procedure behind with the suite green.
 */
describe("LIVE-RUN.md documents the paired reader that is actually shipped", () => {
  test("it names the module that produces the paired report", async () => {
    expect(await liveRunDoc()).toContain(PAIRED_READER_MODULE)
  })

  test("it names the module that produces the labelled report", async () => {
    expect(await liveRunDoc()).toContain(LABELLED_READER_MODULE)
  })

  test("every quantity the reader tracks availability for is named in the procedure", async () => {
    const doc = (await liveRunDoc()).replace(/\s+/g, " ")
    for (const quantity of PAIRED_QUANTITIES) {
      expect(doc, quantity).toContain(quantity)
    }
  })

  test("the files it tells an operator to look at are the files the code writes", async () => {
    const doc = await liveRunDoc()
    for (const file of [SCHEDULE_FILE, SLOT_STATUS_FILE, PREFIX_FILE, HALT_MARKER_FILE]) {
      expect(doc, file).toContain(file)
    }
  })

  test("the slot count it promises is the number of slots the protocol plans", async () => {
    const planned = PAIRED_BLOCKS.length * 2
    expect(planned).toBe(6)
    expect((await liveRunDoc()).replace(/\s+/g, " ")).toContain(`All ${planned === 6 ? "six" : String(planned)} planned slots`)
  })

  /**
   * THE CONFOUND CLAIM IS SCOPED, and it was not. The document said the
   * anonymizer confound is stated beside EVERY block's result while a withheld
   * block gets its reasons and no confounds section — a procedure promising an
   * operator something they would then not find.
   */
  test("the confound claim is scoped to a measured block", async () => {
    const doc = (await liveRunDoc()).replace(/\s+/g, " ")
    expect(doc).toContain("What sits beside every MEASURED result")
    expect(doc).toContain("A **withheld** block has no result to qualify")
  })

  /**
   * THE SPLIT BETWEEN A PARTIAL ARM AND A DEGRADED ONE, both halves. The document
   * said an arm whose completion is anything but `completed` withholds its block,
   * which would have told an operator that a degraded block yields nothing — the
   * opposite of what the reader does, and a reason to discard planned data.
   */
  test("the partial-versus-degraded split is documented in both directions", async () => {
    const doc = (await liveRunDoc()).replace(/\s+/g, " ")
    expect(doc).toContain("`status.completion` is `unfinished` or `cancelled`")
    expect(doc).toContain("**A `degraded` arm is not one of these.**")
    expect(doc).toContain("its block is measured and its degradation")
    // And the ablation report's own opposite rule is scoped to that report.
    expect(doc).toContain("**A degraded arm is not a measurement — in THIS report.**")
  })

  test("the treatment opportunity is documented as the OFF arm's own figure", async () => {
    const doc = (await liveRunDoc()).replace(/\s+/g, " ")
    expect(doc).toContain("read from **the OFF arm's** `status.routeCounts.intervention` and never re-derived")
  })

  test("the halt banner and the arm listing are documented", async () => {
    const doc = (await liveRunDoc()).replace(/\s+/g, " ")
    expect(doc).toContain("THIS EXPERIMENT IS HALTED.")
    expect(doc).toContain("WHETHER THIS EXPERIMENT IS HALTED COULD NOT BE ESTABLISHED.")
    expect(doc).toContain("KEPT, NAMED, AND OUT OF EVERY PAIR")
  })
})

/**
 * Story 2-6b — the adjudication reader's contract, tied to the reader.
 *
 * This is the ONLY reader in the tree that consumes a human-authored file, and
 * the shape of that file is specified nowhere but in prose. Renaming
 * `ADJUDICATION_SHEET_FILE` or bumping `ADJUDICATION_SHEET_VERSION` left the whole
 * suite green while both operator documents went on telling a human to write
 * `adjudication.json` version 1 — a sheet the reader would then refuse, or never
 * look for, with nothing failing anywhere.
 *
 * Both documents are bound, because both instruct: `LIVE-RUN.md` says what the
 * report prints, `ADJUDICATION.md` says what to write.
 */
describe("the adjudication sheet's contract is the one both documents state", () => {
  const adjudicationDoc = () =>
    Bun.file(new URL("../fixtures/seeded-defects/ADJUDICATION.md", import.meta.url)).text()

  test("both documents name the file the reader actually opens", async () => {
    expect(await liveRunDoc()).toContain(ADJUDICATION_SHEET_FILE)
    expect(await adjudicationDoc()).toContain(ADJUDICATION_SHEET_FILE)
  })

  test("the sheet version the worksheet tells an operator to write is the one the reader knows", async () => {
    const doc = await adjudicationDoc()
    expect(doc).toContain(`"adjudicationSheetVersion": ${ADJUDICATION_SHEET_VERSION}`)
    expect(doc).toContain(`adjudicationSheetVersion: ${ADJUDICATION_SHEET_VERSION},`)
  })

  test("LIVE-RUN.md names the module that produces the adjudication report", async () => {
    expect(await liveRunDoc()).toContain(ADJUDICATION_READER_MODULE)
  })

  test("every truth label the parser accepts is documented, and no other", async () => {
    const doc = await adjudicationDoc()
    for (const label of TRUTH_LABELS) expect(doc, label).toContain(`\`${label}\``)
    expect(TRUTH_LABELS).toEqual(["true-defect", "not-a-defect", "unresolved"])
  })

  test("every quantity the reader summarises is named in LIVE-RUN.md", async () => {
    const doc = (await liveRunDoc()).replace(/\s+/g, " ")
    for (const quantity of ADJUDICATION_QUANTITIES) {
      // The summary labels carry their own parenthetical gloss; the document
      // names the quantity, which is the label up to it.
      const named = quantity.label.replace(/ \(.*\)$/, "")
      expect(doc, named).toContain(named)
    }
  })

  test("the `Maybe` trap in `prefixRunId` is called out where an operator would hit it", async () => {
    const doc = (await adjudicationDoc()).replace(/\s+/g, " ")
    expect(doc).toContain("Copy `prefixRunId.value`, not `prefixRunId`.")
  })
})
