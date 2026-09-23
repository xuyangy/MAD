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

import { ADVERSARIAL_SEAL } from "../fixtures/adversarial/seal.ts"
import { CROSS_ARM_PAIRS_SEAL } from "../fixtures/cross-arm-pairs/seal.ts"
import { LABELLED_CHANGE_SEAL } from "../fixtures/seeded-defects/seal.ts"
import { PREFIX_FILE } from "./bundle.ts"
import { ADVERSARIAL_ALLOWANCES, HALT_MARKER_FILE } from "./governor.ts"
import {
  ADJUDICATION_QUANTITIES,
  ADJUDICATION_SHEET_FILE,
  ADJUDICATION_SHEET_VERSION,
  NO_SHEET_REASON,
  TRUTH_LABELS,
} from "./adjudication-read.ts"
import { PAIRED_QUANTITIES } from "./paired-read.ts"
import { ADVERSARIAL_QUANTITIES, BOUNDED_EVIDENCE } from "./adversarial-read.ts"
import {
  ADVERSARIAL_SCHEDULE_FILE,
  ADVERSARIAL_SLOT_STATUS_FILE,
  ADVERSARIAL_START_MARKER_FILE,
} from "./adversarial-schedule.ts"
import { JOURNAL_FILE, LOCK_FILE } from "./journal.ts"
import {
  ADJUDICATION_READER_MODULE,
  ADVERSARIAL_READER_MODULE,
  EVALUATION_REPORT_MODULE,
  LABELLED_READER_MODULE,
  PAIRED_READER_MODULE,
} from "./report.ts"
import {
  DIRECTION_UNRESOLVED,
  EVALUATION_QUANTITIES,
  NO_TREATMENT_OPPORTUNITY,
  NOT_COMPOSED,
  ONE_PREFIX_ONE_PAIR,
  REPORTING_MILESTONE,
} from "./evaluation-report.ts"
import { TOOL_TRACE_FILE } from "./tool-trace.ts"
import { PAIRED_GATES, PAIRED_NON_GATES } from "./paired-gates.ts"
import { DEFAULT_SERVER } from "../scripts/paired.ts"
import { PAIRED_BLOCKS, SCHEDULE_FILE, SLOT_STATUS_FILE, START_MARKER_FILE } from "./schedule.ts"

const liveRunDoc = () => Bun.file(new URL("./LIVE-RUN.md", import.meta.url)).text()

/** The text from `start` up to (not including) `end`, or a clear error naming what is missing. */
function between(doc: string, start: string, end: string, what: string): string {
  const from = doc.indexOf(start)
  if (from < 0) throw new Error(`LIVE-RUN.md carries no ${what}: \`${start}\` was not found`)
  const to = doc.indexOf(end, from + start.length)
  if (to < 0) throw new Error(`LIVE-RUN.md's ${what} has no end: \`${end}\` was not found after it`)
  return doc.slice(from, to)
}

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
      ADVERSARIAL_SEAL.materialHash,
      ADVERSARIAL_SEAL.assertionsHash,
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

  /**
   * THE QUANTITY LIST IS READ INSIDE ITS OWN SECTION.
   *
   * Over the whole document, `unchanged` and `undecided transitions` are
   * satisfied by the paired report's prose hundreds of lines above, so the
   * adjudication summary could lose either line and this guard would stay green
   * — a drift check that passes on unrelated text checks nothing.
   */
  const adjudicationSection = async (): Promise<string> => {
    const doc = await liveRunDoc()
    const start = doc.indexOf("### The adjudication report")
    const end = doc.indexOf("### What the fake-backed tests do not establish", start)
    if (start < 0 || end < 0) throw new Error("LIVE-RUN.md carries no adjudication section to read")
    return doc.slice(start, end).replace(/\s+/g, " ")
  }

  test("every quantity the reader summarises is named in LIVE-RUN.md's own adjudication section", async () => {
    const section = await adjudicationSection()
    for (const quantity of ADJUDICATION_QUANTITIES) {
      // The summary labels carry their own parenthetical gloss; the document
      // names the quantity, which is the label up to it.
      const named = quantity.label.replace(/ \(.*\)$/, "")
      expect(section, named).toContain(named)
    }
  })

  test("the reason a truth quantity reads with no sheet is the constant the reader prints", async () => {
    expect(await adjudicationSection()).toContain(NO_SHEET_REASON)
  })

  /**
   * A FILLED SHEET MUST NOT BE COMMITTABLE. `.gitignore` is the only thing
   * keeping human truth labels out of this repository and off every
   * model-reachable path, and nothing bound it to the name the reader opens —
   * renaming the constant would have made a filled sheet committable again with
   * the suite green. This is the bug class `labelled-read.test.ts` already
   * records for the draft protocol.
   */
  test("`.gitignore` ignores the sheet file the reader opens, at every depth", async () => {
    const ignore = await Bun.file(new URL("../.gitignore", import.meta.url)).text()
    expect(ignore.split("\n").map((line) => line.trim())).toContain(ADJUDICATION_SHEET_FILE)

    // THE PATTERN IS ASKED WHAT IT ACTUALLY IGNORES. A bare name matches at
    // every depth, and a future edit anchoring it (`/adjudication.json`) would
    // still satisfy the line check above while leaving a sheet inside a nested
    // bundle committable — which is the only place a sheet is ever written.
    const nested = `_bmad-output/run/bundle/${ADJUDICATION_SHEET_FILE}`
    const checked = Bun.spawnSync(["git", "check-ignore", nested], {
      cwd: new URL("..", import.meta.url).pathname,
    })
    expect(checked.exitCode, `git does not ignore ${nested}`).toBe(0)
  })

  test("the `Maybe` trap in `prefixRunId` is called out where an operator would hit it", async () => {
    const doc = (await adjudicationDoc()).replace(/\s+/g, " ")
    expect(doc).toContain("Copy `prefixRunId.value`, not `prefixRunId`.")
  })
})

/**
 * Story 2-7b — the adversarial suite's procedure, tied to the code it documents:
 * the seal it prints, the files it names, the gate figures, the reader module and
 * the statement the report opens with.
 */
describe("LIVE-RUN.md documents the adversarial suite that is actually shipped", () => {
  const section = async (): Promise<string> => {
    const doc = await liveRunDoc()
    const start = doc.indexOf("## The adversarial suite (story 2-7b)")
    const end = doc.indexOf("## What would falsify the design", start)
    if (start < 0 || end < 0) throw new Error("LIVE-RUN.md carries no adversarial section")
    return doc.slice(start, end)
  }

  test("the sealed case identity in force is printed: version and both hashes", async () => {
    const text = await section()
    expect(text).toContain(ADVERSARIAL_SEAL.version)
    expect(text).toContain(ADVERSARIAL_SEAL.materialHash)
    expect(text).toContain(ADVERSARIAL_SEAL.assertionsHash)
  })

  test("the files it names are the files the code writes", async () => {
    const text = await section()
    for (const file of [
      ADVERSARIAL_SCHEDULE_FILE,
      ADVERSARIAL_START_MARKER_FILE,
      ADVERSARIAL_SLOT_STATUS_FILE,
      TOOL_TRACE_FILE,
      JOURNAL_FILE,
      LOCK_FILE,
      HALT_MARKER_FILE,
    ]) {
      expect(text, file).toContain(file)
    }
  })

  test("the gate figures are the governor's", async () => {
    const text = (await section()).replace(/\s+/g, " ")
    const figure = (n: number) => n.toLocaleString("en-US")
    expect(text).toContain(`ordinary ${figure(ADVERSARIAL_ALLOWANCES.runCap)} \`tokenCap\``)
    expect(text).toContain(`the global ${figure(ADVERSARIAL_ALLOWANCES.global)}`)
    expect(text).toContain(`the Adversarial ${figure(ADVERSARIAL_ALLOWANCES.adversarial)}`)
  })

  test("the reader module, its quantities and its bounded-evidence statement are named", async () => {
    const text = (await section()).replace(/\s+/g, " ")
    expect(text).toContain(ADVERSARIAL_READER_MODULE)
    for (const quantity of ADVERSARIAL_QUANTITIES) expect(text, quantity).toContain(`\`${quantity}\``)
    expect(text).toContain(BOUNDED_EVIDENCE)
  })

  test("the live execution stays open, with its prerequisites named", async () => {
    const text = (await section()).replace(/\s+/g, " ")
    expect(text).toContain("the sixteen live runs have not been executed")
    // EACH PREREQUISITE WITH ITS STATUS, not just its name. Story 2-7c closed
    // one and half of another, and a list that only checked the five headings
    // would read the same whether they were all open or all closed — which is
    // the one thing a readiness document must not be ambiguous about.
    for (const [prerequisite, status] of [
      ["Host accounting", "OPEN"],
      ["Billing authorization", "OPEN"],
      ["Verified shared gates", "OPEN"],
      ["Bounded tool termination", "PARTLY CLOSED"],
      ["Bounded observer writes", "CLOSED"],
      // Promoted out of the prose (review of 2-7c): a blocker a reader counting
      // the numbered list does not count is one nobody schedules.
      ["Bounded materializer termination", "OPEN"],
      ["Bounded review-path reads", "OPEN"],
    ] as const) {
      expect(text, prerequisite).toContain(`${prerequisite} — ${status}`)
    }
    // The list is the whole list — the property that makes counting it safe.
    expect(text).toContain("THE NUMBERED LIST ABOVE IS THE WHOLE LIST")
    // And the honest headline: this patch did not close every hang.
    expect(text).toContain("The live execution is still blocked")
    expect(text).toContain("materializer termination remains unverified")
    expect(text).toContain("This patch does not close every hang")
    // Billing authorization is a decision with a named owner, not a task.
    expect(text).toContain("Owner: the human who owns the budget")
  })

  test("the preflight checks are listed in the order the runner makes them", async () => {
    const text = (await section()).replace(/\s+/g, " ")
    const steps = [
      "no start marker exists",
      "the root is not nested in another experiment root",
      "the Tools identity is not blank",
      "`maxConcurrency` is not above 1",
      "the roster is one slot",
      "the seal",
      "the schedule against the runner's own inputs",
      "the journal opens and is not halted or stopped",
      "every planned worktree passes the shared AD-16 checks",
    ]
    const at = steps.map((step) => text.indexOf(step))
    for (const [index, position] of at.entries()) expect(position, steps[index]).toBeGreaterThan(-1)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  test("the runner's preflight code makes the checks in that order", async () => {
    const source = await Bun.file(new URL("./adversarial.ts", import.meta.url)).text()
    const body = source.slice(source.indexOf("export async function runAdversarialSuite"))
    const markers = [
      "ADVERSARIAL_START_MARKER_FILE",
      "sharedLedgerProblem(root)",
      "config.tools.trim()",
      "concurrencyProblem(input.config)",
      "oneSlotProblem(input.roster)",
      "adversarialSealProblem(",
      "verifyAdversarialSchedule(",
      "openJournal(",
      "containmentProblem(directory",
      "writeBundleIndex(",
      "writeAdversarialStartMarker(",
    ]
    const at = markers.map((marker) => body.indexOf(marker))
    for (const [index, position] of at.entries()) expect(position, markers[index]).toBeGreaterThan(-1)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })
})

describe("LIVE-RUN.md documents the evaluation report that is actually shipped", () => {
  const section = async () => {
    const doc = await liveRunDoc()
    const start = doc.indexOf("### The evaluation report (story 2-8a)")
    expect(start, "no evaluation report section").toBeGreaterThan(-1)
    const end = doc.indexOf("\n### ", start + 1)
    return (end < 0 ? doc.slice(start) : doc.slice(start, end)).replace(/\s+/g, " ")
  }

  test("it names the module, and every quantity it tracks availability for", async () => {
    const text = await section()
    expect(text).toContain(EVALUATION_REPORT_MODULE)
    for (const quantity of EVALUATION_QUANTITIES) expect(text, quantity).toContain(`\`${quantity}\``)
  })

  test("the statements the report prints are the ones the document quotes", async () => {
    const text = await section()
    expect(text).toContain(REPORTING_MILESTONE)
    expect(text).toContain(DIRECTION_UNRESOLVED)
    expect(text).toContain(NO_TREATMENT_OPPORTUNITY)
    expect(text).toContain("SYNTHETIC")
  })

  test("the cost is observed per-block cost, and the bill and its gaps belong to the journal", async () => {
    const text = await section()
    expect(text).toContain("The manifest cost is observed per-block cost, not the experiment bill.")
    expect(text).toContain(`\`${JOURNAL_FILE}\``)
    expect(text).toContain("A failed prefix has no arm manifests, so its spend stays a gap here")
    expect(text).toContain("A missing arm manifest is also a gap with its reason, never a zero.")
  })

  test("the unavailable cases are documented with the words the report prints", async () => {
    const text = await section()
    expect(text).toContain(NOT_COMPOSED)
    expect(text).toContain(`*${ONE_PREFIX_ONE_PAIR}*`)
    expect(text).toContain("A withheld or absent block makes its treatment opportunity unknown")
    expect(text).toContain("makes the block execution incomplete")
  })

  test("what stories 2-8c and 2-8d still own is stated, and nothing here closes 2.8", async () => {
    const text = await section()
    expect(text).toContain("What stories 2-8c and 2-8d still own.")
    expect(text).not.toContain("What story 2-8b still owns.")
    expect(text).toContain("Story 2-8c owns the real-host request-accounting check")
    expect(text).toContain("Story 2-8d owns the three blocks over a real change")
    expect(text).toContain("it closes neither story 2.8, FR11 nor the epic")
  })
})

/**
 * Story 2-8b — the launcher's procedure, tied to the gate table and the command.
 * The numbered gate list is the operator's readiness picture, so it is pinned
 * against `PAIRED_GATES` entry for entry: a gate closed in the table and still
 * OPEN here, or one added to the table and missing here, fails.
 */
describe("LIVE-RUN.md documents the paired launcher that is actually shipped", () => {
  const section = async (): Promise<string> =>
    between(await liveRunDoc(), "## The paired launcher (story 2-8b)", "\n## ", "the paired launcher section")

  test("the numbered gate list mirrors PAIRED_GATES: number, name, status, kind, phase and owner", async () => {
    const text = await section()
    const items = [...text.matchAll(/^(\d+)\. \*\*(.+?) — (OPEN|CLOSED)\.\*\*([\s\S]*?)(?=^\d+\. |^\*\*THE NUMBERED)/gm)]
    expect(items.map((item) => [Number(item[1]), item[2], item[3]])).toEqual(
      PAIRED_GATES.map((gate) => [gate.number, gate.name, gate.status]),
    )
    for (const [index, item] of items.entries()) {
      const gate = PAIRED_GATES[index]!
      const body = item[4]!.replace(/\s+/g, " ")
      expect(body.toLowerCase(), gate.name).toContain(`${gate.kind}, required for ${gate.phase}`)
      expect(body, gate.name).toContain(`Owner: ${gate.owner}.`)
      expect(body, `${gate.name} requires`).toContain(`Requires: ${gate.requires.replace(/\s+/g, " ")}.`)
      if (gate.status === "CLOSED") expect(body, `${gate.name} evidence`).toContain(`Evidence: ${gate.evidence!.replace(/\s+/g, " ")}.`)
      else expect(body, `${gate.name} carries no evidence`).not.toContain("Evidence:")
    }
    expect(text).toContain("**THE NUMBERED LIST ABOVE IS THE WHOLE LIST.**")
  })

  test("the command, its stages and its refusals are documented", async () => {
    const text = (await section()).replace(/\s+/g, " ")
    expect(text).toContain("bun run paired --live")
    for (const stage of ["Stage 1 — offline checks.", "Stage 2 — client and roster.", "Stage 3 — the recheck**, immediately before the schedule: the worktree identity, the `--out` containment and the bundle root", "Stage 4 — `createSchedule`, then `runPairedBlocks`"]) {
      expect(text, stage).toContain(stage)
    }
    expect(text).toContain("`not evaluated: <prerequisite>`")
    expect(text).toContain("**`--target`**, as a second authority on what is reviewed")
    expect(text).toContain("Authority lives only in the repository.")
    expect(text).toContain("A change made after the stage-3 recheck, during the paid run, is not detected.")
    expect(text).toContain(SCHEDULE_FILE)
    expect(text).toContain(START_MARKER_FILE)
  })

  test("the \"Checked, and not a gate\" paragraph is PAIRED_NON_GATES", async () => {
    const text = (await section()).replace(/\s+/g, " ")
    expect(PAIRED_NON_GATES.length).toBeGreaterThan(0)
    for (const entry of PAIRED_NON_GATES) {
      const paragraph = between(text, `**Checked, and not a gate: ${entry.name}.**`, " ### ", `the non-gate paragraph for ${entry.name}`)
      expect(paragraph).toContain(`Evidence: ${entry.evidence.replace(/\s+/g, " ")}.`)
      expect(paragraph).toContain(`It becomes a gate when ${entry.reopensWhen.replace(/\s+/g, " ")}.`)
    }
  })

  test("the opening summary names gates 1, 2 and 4 as the refusal, and gate 3 as not consulted", async () => {
    const text = (await section()).replace(/\s+/g, " ")
    expect(text).toContain("gates 1, 2 and 4 below are OPEN and are required for the evaluation")
    expect(text).toContain("Gate 3 is OPEN too; it is printed and not consulted for the evaluation.")
    const required = PAIRED_GATES.filter((gate) => gate.phase === "evaluation" && gate.status === "OPEN").map((gate) => gate.number)
    expect(required).toEqual([1, 2, 4])
  })

  test("--server and its default are documented", async () => {
    const text = (await section()).replace(/\s+/g, " ")
    expect(text).toContain(`\`--server <url>\` names the opencode server; its default is \`${DEFAULT_SERVER}\``)
  })

  test("the runner section points at the command", async () => {
    const runner = between(await liveRunDoc(), "## The paired block runner (story 2-5c)", "### Reading a paired bundle", "the paired runner section")
    expect(runner).toContain("`bun run paired`")
    expect(runner).not.toContain("a library, not a command")
  })
})
