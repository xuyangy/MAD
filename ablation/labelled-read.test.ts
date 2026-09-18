/**
 * Story 2-6 — the labelled reader, one matrix row at a time, over PERSISTED
 * bundles.
 *
 * Every prefix record here is a real `review()` record from the scripted
 * seeded-defect fixture (`seededArm`), written to disk as `record.json` beside a
 * sealed schedule and six arm manifests, and read back through
 * `readPairedBundle`. One group writes the prefix through the runner's own
 * `writePrefixEvidence`, so the reader is held to what the writer produces. The
 * four CI controls in `fixtures/seeded-defects/recall.test.ts` hold the scoring
 * functions; this file holds the READER to the same four controls — positive,
 * zero-gain, overlap-exclusion and injected negative matcher — plus every
 * refusal and withholding rule.
 *
 * Nothing bills and no model runs: the backend is `FakeBackend`.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Roster } from "../core/domain/roster.ts"
import type { SlotScript } from "../core/test-support/fakes.ts"
import type { Finding } from "../core/domain/finding.ts"
import type { RunRecord } from "../core/domain/run-record.ts"
import { lensRecallGain, lexicalDefectMatcher, missedDefects, pooledOnly } from "../fixtures/recall.ts"
import { adjudicate } from "../fixtures/seeded-defects/adjudicate.ts"
import { LENSES, REFUND, seededArm } from "../fixtures/seeded-defects/arms.ts"
import { SEEDED_DEFECTS } from "../fixtures/seeded-defects/labels.ts"
import { SEEDED_CHANGE } from "../fixtures/seeded-defects/material.ts"
import { LABELLED_CHANGE_SEAL } from "../fixtures/seeded-defects/seal.ts"
import { main as evalReadMain } from "../scripts/eval-read.ts"
import { PREFIX_DIRECTORY, writePrefixEvidence } from "./bundle.ts"
import {
  FALSE_POSITIVES_TEXT,
  PROTOCOL_V2_DRAFT,
  readLabelledBundle,
  renderLabelledBundle,
  type LabelledBlock,
  type LabelledReadOptions,
  type LabelledReadResult,
  type LabelledQuantity,
} from "./labelled-read.ts"
import { known } from "./manifest.ts"
import { readPairedBundle, renderPairedBundle, type PairedReadResult } from "./paired-read.ts"
import { pairedBundleAt, PROTOCOL_FILE, WORKTREE, type ArmSpec, type PairedBundleOptions } from "./paired-read.fixture.ts"
import { readBundle, renderBundle } from "./read-bundle.ts"
import { ADJUDICATION_READER_MODULE, LABELLED_READER_MODULE } from "./report.ts"
import { writeBundle } from "./read-bundle.fixture.ts"
import { readFrozenProtocol, SCHEDULE_FILE } from "./schedule.ts"

const scratch: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-labelled-read-"))
  scratch.push(dir)
  return dir
}

afterEach(async () => {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})

let lensed: RunRecord
let plain: RunRecord
let protocolHash: string

beforeAll(async () => {
  lensed = (await seededArm({ slots: 3, lenses: LENSES })).record
  plain = (await seededArm({ slots: 3 })).record
  const protocol = await readFrozenProtocol(PROTOCOL_FILE)
  if (!protocol.ok) throw new Error(protocol.reason)
  protocolHash = protocol.hash
})

type RecordJson = Record<string, unknown> & { pool: Record<string, unknown>[]; warnings: Record<string, unknown>[] }

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

interface LabelledOptions {
  lenses?: boolean
  /** Change the roster sealed in the schedule AND carried by every prefix record. */
  roster?: (roster: Roster) => void
  /** Mutate one block's prefix record before it is written. */
  record?: (record: RecordJson, block: number) => void
  /** `null` writes `dump: null`; a string writes that dump path. */
  dump?: Record<number, string | null>
  /** Skip writing `record.json` for these blocks. */
  noRecord?: number[]
  arms?: (spec: ArmSpec) => ArmSpec
  /** Anything else for the paired fixture. `roster` and `arms` belong to this helper and are refused here. */
  paired?: PairedBundleOptions
  fixtureHash?: unknown
  /** Write each prefix through `writePrefixEvidence`, the runner's own writer. */
  realWriter?: boolean
}

function dumpDir(root: string, block: number, runId = `run-prefix-${block}`): string {
  return join(root, PREFIX_DIRECTORY, String(block - 1), runId)
}

/** The canonical findings each arm upheld: ON as the run left them, OFF with one verdict turned over. */
function armFindings(base: RunRecord, arm: "on" | "off"): unknown {
  const pool = clone(base.pool) as unknown as Record<string, unknown>[]
  const canonicalIds = base.findings.map((finding) => finding.id)
  if (arm === "off") {
    const first = pool.find((finding) => finding.id === canonicalIds[0])!
    first.verdict = "judge-ruled-invalid"
  }
  return { pool, canonicalIds, lensInstructions: [] }
}

async function labelledBundle(options: LabelledOptions = {}): Promise<{ root: string }> {
  if (options.paired !== undefined && ("roster" in options.paired || "arms" in options.paired)) {
    throw new Error("`paired.roster` and `paired.arms` would replace the helper's own; use `roster` and `arms`")
  }
  const base = clone(options.lenses === false ? plain : lensed)
  options.roster?.(base.roster)
  const root = await tempDir()
  const arms: ArmSpec[] = []
  for (const block of [1, 2, 3]) {
    for (const arm of ["on", "off"] as const) {
      const spec: ArmSpec = {
        block,
        arm,
        over: {
          fixtureHash: options.fixtureHash ?? known(LABELLED_CHANGE_SEAL.materialHash),
          protocolHash: known(protocolHash),
          findings: armFindings(base, arm),
        },
      }
      arms.push(options.arms?.(spec) ?? spec)
    }
  }
  const prefixOver: Record<number, Record<string, unknown>> = {}
  for (const block of [1, 2, 3]) {
    const dump = options.dump !== undefined && block in options.dump ? options.dump[block]! : dumpDir(root, block)
    prefixOver[block] = { dump, ...(options.paired?.prefixOver?.[block] ?? {}) }
  }
  const schedule = await pairedBundleAt(root, {
    ...options.paired,
    roster: base.roster,
    arms,
    prefixOver,
    ...(options.realWriter === true ? { prefixes: [] } : {}),
  })
  for (const block of [1, 2, 3]) {
    if (options.noRecord?.includes(block)) continue
    const record = clone(base) as unknown as RecordJson
    record.runId = `run-prefix-${block}`
    for (const finding of record.pool) delete finding.verdict
    options.record?.(record, block)
    if (options.realWriter === true) {
      const written = await writePrefixEvidence({
        bundleRoot: root,
        worktree: WORKTREE,
        change: SEEDED_CHANGE,
        scheduleHash: schedule.scheduleHash,
        block,
        record: record as unknown as RunRecord,
        forked: true,
        reason: "forked into the scheduled ON and OFF continuations",
      })
      if (!written.ok) throw new Error(written.reason)
      continue
    }
    // A record whose `runId` is not a string is one of the malformed classes
    // below, and it still has to be WRITTEN somewhere the reader looks.
    const directory = dumpDir(root, block, typeof record.runId === "string" ? record.runId : `run-prefix-${block}`)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "record.json"), JSON.stringify(record))
  }
  return { root }
}

async function pairedOf(root: string): Promise<PairedReadResult> {
  const paired = await readPairedBundle(root)
  if ("error" in paired) throw new Error(paired.error)
  return paired
}

async function labelled(root: string, options: LabelledReadOptions = {}): Promise<LabelledReadResult> {
  const outcome = await readLabelledBundle(await pairedOf(root), options)
  if (outcome.kind !== "read") throw new Error(`expected a read, got ${JSON.stringify(outcome)}`)
  return outcome
}

function blockOf(result: LabelledReadResult, block: number): LabelledBlock {
  return result.blocks.find((entry) => entry.block === block)!
}

function summaryOf(result: LabelledReadResult, quantity: LabelledQuantity) {
  return result.summaries.find((entry) => entry.quantity === quantity)!
}

async function captured(run: () => Promise<number>): Promise<{ code: number; text: string }> {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "))
  }
  try {
    const code = await run()
    return { code, text: lines.join("\n") }
  } finally {
    console.log = original
  }
}

function withoutAuthors(record: RecordJson, authors: readonly string[]): void {
  record.pool = record.pool.filter((finding) => !authors.includes(finding.author as string))
}

function dropOut(record: RecordJson, slot: string | undefined): void {
  record.warnings.push({
    code: "model-dropped-out",
    stage: "discover",
    message: `MODEL DROPPED OUT: slot ${slot}`,
    detail: { ...(slot === undefined ? {} : { slot }), model: "x/y", attempts: 2, failure: "schema-invalid", error: "bad" },
  })
}

function salvage(record: RecordJson, slot: string): void {
  record.warnings.push({
    code: "partial-envelope",
    stage: "discover",
    message: "PARTIAL ANSWER",
    detail: { slot, model: "x/y", kept: 4, dropped: 1 },
  })
}

function reasonsOf(result: { kind: string; reasons?: string[] }): string {
  return (result.reasons ?? []).join(" ")
}

// ---------------------------------------------------------------------------
// Happy path and the four controls
// ---------------------------------------------------------------------------

describe("the happy path — three blocks over seeded prefixes", () => {
  test("each block reads pooled 7 of 13 and best member 3 of 13 with the slot named", async () => {
    const { root } = await labelledBundle()
    const result = await labelled(root)
    const text = renderLabelledBundle(result)

    for (const block of result.blocks) {
      expect(block.record.kind).toBe("read")
      const cap1 = block.cap1
      if (cap1.kind !== "measured") throw new Error(JSON.stringify(cap1))
      expect(cap1.pooled).toMatchObject({ found: 7, total: 13 })
      expect(cap1.best.found).toBe(3)
      expect(cap1.best.slots.length).toBeGreaterThan(0)
      expect(cap1.members.map((member) => member.slot)).toEqual(["discovery-1", "discovery-2", "discovery-3"])
      expect(cap1.difference).toBe(4)
      expect(cap1.complete).toBe(true)
    }
    expect(text).toContain("pool union: 7 of 13")
    expect(text).toMatch(/best answered pool slot: `discovery-1`.* with 3 of 13/)
    expect(text).toContain("union minus best: 4")
  })

  test("a tie on the best member names every tied slot and reads `(tied)`", async () => {
    const { root } = await labelledBundle()
    const result = await labelled(root)
    const cap1 = blockOf(result, 1).cap1
    if (cap1.kind !== "measured") throw new Error(JSON.stringify(cap1))
    expect(cap1.best.slots).toEqual(["discovery-1", "discovery-2", "discovery-3"])
    expect(renderLabelledBundle(result)).toContain(
      "best answered pool slot: `discovery-1`, `discovery-2`, `discovery-3` with 3 of 13 (tied)",
    )
  })

  test("the POSITIVE control: CAP-11 names lens-only defects, and they are the harness's own", async () => {
    const { root } = await labelledBundle()
    const result = await labelled(root)
    const expected = lensRecallGain(SEEDED_DEFECTS, lensed.pool).lensOnlyDefects.map((defect) => defect.id)
    expect(expected.length).toBeGreaterThan(0)
    for (const block of result.blocks) {
      const cap11 = block.cap11
      if (cap11.kind !== "measured") throw new Error(JSON.stringify(cap11))
      expect(cap11.lensOnly.ids).toEqual(expected)
      expect(cap11.lens).toEqual({ answered: 4, of: 4 })
      expect(cap11.perLens.map((lens) => lens.lens)).toEqual([...LENSES])
    }
  })

  test("each arm's upheld findings are planted-label matches and U, with false positives not established", async () => {
    const { root } = await labelledBundle()
    const result = await labelled(root)
    const text = renderLabelledBundle(result)

    const upheldOn = lensed.findings.filter((finding) => finding.verdict === "upheld")
    const expectedOn = adjudicate(SEEDED_DEFECTS, upheldOn)
    for (const block of result.blocks) {
      const on = block.arms.find((arm) => arm.arm === "on")!
      if (on.result.kind !== "measured") throw new Error(JSON.stringify(on.result))
      expect(on.result.upheld).toBe(upheldOn.length)
      expect(on.result.matches.map((match) => match.defectId)).toEqual(expectedOn.matched.map((match) => match.defectId))
      expect(on.result.unlabelled).toEqual(expectedOn.unlabelled.map((finding) => finding.id))
      const off = block.arms.find((arm) => arm.arm === "off")!
      if (off.result.kind !== "measured") throw new Error(JSON.stringify(off.result))
      expect(off.result.upheld).toBe(upheldOn.length - 1)
    }
    expect(text).toContain(`false positives: ${FALSE_POSITIVES_TEXT}`)
    // THE SENTENCE, AS A LITERAL. The line above interpolates the constant it is
    // checking, so it passes for any wording at all — including one that promises
    // a count this report never produces.
    expect(text).toContain(
      "false positives: not counted here — the adjudication report below counts them per arm from the human " +
        "truth sheet, or names why it could not",
    )
    expect(text).toContain(`planted-label matches: ${expectedOn.matched.length} of ${upheldOn.length}`)
  })

  test("3/3 per quantity, with a descriptive spread and the estimands, status and protocol identity", async () => {
    const { root } = await labelledBundle()
    const result = await labelled(root)
    const text = renderLabelledBundle(result)
    for (const summary of result.summaries) {
      expect(summary, summary.quantity).toMatchObject({ observed: 3, of: 3, missing: [] })
    }
    expect(text).toContain("CAP-1 pool union: observed 3/3")
    expect(text).toContain("mean 7, min 7, max 7 — descriptive over 3 available observations, not the planned three-block result")
    expect(text).toContain("WITHIN-PREFIX ATTRIBUTION")
    expect(text).toContain("not an independently executed single-model run")
    expect(text).toContain("It is not a causal run effect")
    expect(text).toContain("say nothing about precision")
    expect(text).toContain("implementation: complete")
    expect(text).toContain("protocol v2: a DRAFT that pre-registers nothing")
    // WORDING CHANGED BY A RECORDED DECISION (2026-09-17), not to make a failing
    // assertion pass: the count is over QUANTITIES, so one complete block alone
    // prints `8 of 8`, which read as experiment completeness. The number and the
    // refusal checks are unchanged; the label and the caveat are new.
    expect(text).toContain(
      "bundle observations: 8 of 8 quantities have at least one complete observation in this bundle " +
        "(a count of QUANTITIES; one complete block can supply all of them)",
    )
    expect(text).toContain("planned live evaluation: completion is NOT established by this report")
    expect(text).toContain("matcher: the shipped lexical defect matcher")
    expect(text).toContain(`labelled change ${LABELLED_CHANGE_SEAL.version}, ${SEEDED_DEFECTS.length} planted defects`)
    expect(text).toContain(`labels   ${LABELLED_CHANGE_SEAL.labelsHash}`)
    expect(text).toContain("No number here is v2-preregistered, because v2 is a draft.")
    expect(text).toContain(`this bundle's schedule was sealed under protocol PROTOCOL-mad-evaluation-v1 v1 (${protocolHash})`)
    expect(text).toContain(`on/0: protocolVersion 1, protocolHash ${protocolHash}`)
  })

  test("a summary whose values differ reads a reduced exact mean, with its min and max", async () => {
    const { root } = await labelledBundle({
      record: (record, block) => {
        if (block === 2) withoutAuthors(record, ["discovery-2", "discovery-3"])
      },
    })
    const result = await labelled(root)
    expect(summaryOf(result, "CAP-1 pool union").values).toEqual([7, 3, 7])
    expect(renderLabelledBundle(result)).toContain(
      "mean 17/3, min 3, max 7 — descriptive over 3 available observations, not the planned three-block result",
    )
  })

  test("with nothing observed, the status reads no bundle observation, and the live caveat still prints", async () => {
    const { root } = await labelledBundle({ dump: { 1: null, 2: null, 3: null }, noRecord: [1, 2, 3], lenses: false })
    // No prefix record exists, and a matcher that throws leaves every arm unavailable.
    const text = renderLabelledBundle(
      await labelled(root, {
        matcher: () => {
          throw new Error("the matcher failed")
        },
      }),
    )
    expect(text).toContain("bundle observations: none — no quantity has a complete observation in this bundle")
    // The caveat is unconditional: it is what carries the frozen "measurements
    // pending" meaning once the count itself became a derived number.
    expect(text).toContain("planned live evaluation: completion is NOT established by this report")
    // An injected matcher must not pass as the shipped one the draft proposes.
    expect(text).toContain("matcher: INJECTED")
  })

  test("ONE COMPLETE BLOCK gives every quantity an observation, and the count says so rather than reading as completeness", async () => {
    const { root } = await labelledBundle({ paired: { prefixes: [1] } })
    const result = await labelled(root)
    const text = renderLabelledBundle(result)
    // Eight of eight, off a single block. This is the reading the caveat exists for.
    expect(summaryOf(result, "CAP-1 pool union").observed).toBe(1)
    expect(text).toContain("bundle observations: 8 of 8 quantities have at least one complete observation")
    expect(text).toContain("(a count of QUANTITIES; one complete block can supply all of them)")
    expect(text).toContain("planned live evaluation: completion is NOT established by this report")
    expect(text).toContain("spread unavailable")
  })

  test("the ZERO-GAIN control for CAP-1: one slot carries the pool, and the zero-finding slots read 0 of 13", async () => {
    const { root } = await labelledBundle({
      record: (record) => withoutAuthors(record, ["discovery-2", "discovery-3"]),
    })
    const cap1 = blockOf(await labelled(root), 1).cap1
    if (cap1.kind !== "measured") throw new Error(JSON.stringify(cap1))
    expect(cap1.pooled.found).toBe(cap1.best.found)
    expect(cap1.difference).toBe(0)
    expect(cap1.best.slots).toEqual(["discovery-1"])
    expect(cap1.members.find((member) => member.slot === "discovery-2")).toMatchObject({ found: 0, total: 13 })
    expect(cap1.members).toHaveLength(3)
  })

  test("the ZERO-GAIN and OVERLAP-EXCLUSION controls for CAP-11: a lens that re-finds a pool defect gains nothing", async () => {
    const others = LENSES.filter((lens) => lens !== "security").map((lens) => `discovery-lens-${lens}`)
    const { root } = await labelledBundle({ record: (record) => withoutAuthors(record, others) })
    const cap11 = blockOf(await labelled(root), 1).cap11
    if (cap11.kind !== "measured") throw new Error(JSON.stringify(cap11))
    expect(cap11.lensOnly).toEqual({ found: 0, total: 13, ids: [] })
    const security = cap11.perLens.find((lens) => lens.lens === "security")!
    // The lens found it; the comparison excluded it.
    expect(security.ids).toContain("sql-injection")
    expect(security.lensOnlyIds).toEqual([])
  })

  test("the INJECTED NEGATIVE MATCHER reaches every number the reader prints", async () => {
    const { root } = await labelledBundle()
    const result = await labelled(root, { matcher: () => false })
    for (const block of result.blocks) {
      if (block.cap1.kind !== "measured" || block.cap11.kind !== "measured") throw new Error("expected measured")
      expect(block.cap1.pooled.found).toBe(0)
      expect(block.cap1.best.found).toBe(0)
      expect(block.cap11.lensOnly.found).toBe(0)
      for (const arm of block.arms) {
        if (arm.result.kind !== "measured") throw new Error("expected measured")
        expect(arm.result.matches).toEqual([])
        expect(arm.result.unlabelled).toHaveLength(arm.result.upheld)
      }
    }
    // And the default matcher is not the one that ran: it finds seven.
    expect(SEEDED_DEFECTS.length - missedDefects(SEEDED_DEFECTS, pooledOnly(lensed.pool)).length).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// The runner's writer, and a relocated bundle
// ---------------------------------------------------------------------------

/**
 * Two degraded turns, scripted for the producer contract below.
 *
 * `discovery-3` fails its turn and its one retry, which is what the stage calls a
 * drop-out. `discovery-2` answers with one valid finding and one that carries no
 * `claim`, so the envelope fails schema validation twice and the stage salvages
 * the valid item — a partial envelope, not a drop-out.
 *
 * EACH STEP IS WRITTEN TWICE, and that is load-bearing. A script is read by
 * attempt number, so a one-step script hands the RETRY whatever step comes next —
 * which is the debate abstention `abstainingInDebate` appends. The partial
 * envelope would then arrive as a drop-out, and the test would be about the
 * fixture's step ordering rather than about the stage.
 */
const PARTIAL_ANSWER: SlotScript[number] = {
  kind: "ok",
  value: {
    findings: [
      {
        claim: "The charges lookup interpolates `req.orderId` straight into the SQL text.",
        reasoning: "A crafted order id rewrites the statement. Bind it as a parameterized value instead.",
        severity: "critical",
        file: REFUND,
        startLine: 20,
        endLine: 22,
      },
      { claim: "", reasoning: "an item with no claim at all", severity: "high", file: REFUND },
    ],
  },
}

const DEAD_TURN: SlotScript[number] = { kind: "fail", failure: "transport-error", message: "the socket closed mid-turn" }

const DEGRADED_SCRIPTS: Record<string, SlotScript> = {
  "discovery-3": [DEAD_TURN, DEAD_TURN],
  "discovery-2": [PARTIAL_ANSWER, PARTIAL_ANSWER],
}

describe("the runner-to-reader contract", () => {
  test("THE PRODUCER'S OWN WARNINGS: a real degraded run carries `detail.slot`, and the reader reads it", async () => {
    // WHY A REAL RUN. Every other slot-state test here hands the reader a
    // hand-written warning, so all of them would still pass if the discover stage
    // stopped writing `detail.slot` tomorrow. This one takes the warnings from the
    // stage that emits them.
    const degraded = (await seededArm({ slots: 3, lenses: LENSES, scripts: DEGRADED_SCRIPTS })).record
    const emitted = degraded.warnings.filter(
      (warning) => warning.stage === "discover" && (warning.code === "model-dropped-out" || warning.code === "partial-envelope"),
    )
    expect(emitted.map((warning) => warning.code).sort()).toEqual(["model-dropped-out", "partial-envelope"])
    const rosterIds = new Set([...degraded.roster.slots, ...degraded.roster.lensSlots].map((slot) => slot.slot))
    for (const warning of emitted) {
      expect(typeof warning.detail?.slot).toBe("string")
      expect(rosterIds.has(warning.detail!.slot as string)).toBe(true)
    }
    const partial = emitted.find((warning) => warning.code === "partial-envelope")!
    expect(partial.detail?.slot).toBe("discovery-2")
    expect(partial.detail?.kept).toBe(1)
    expect(partial.detail?.dropped).toBe(1)

    // The same record, read back: the stage's words become the reader's states.
    const { root } = await labelledBundle({
      record: (record, block) => {
        if (block !== 1) return
        record.answered = degraded.answered
        record.pool = clone(degraded.pool) as unknown as RecordJson["pool"]
        for (const finding of record.pool) delete finding.verdict
        record.warnings = clone(degraded.warnings) as unknown as RecordJson["warnings"]
        record.skippedForBudget = [...(degraded.skippedForBudget ?? [])]
      },
    })
    const block = blockOf(await labelled(root), 1)
    if (block.record.kind !== "read") throw new Error(JSON.stringify(block.record))
    expect(block.record.slots.find((slot) => slot.slot === "discovery-3")).toMatchObject({ state: "dropped" })
    const salvaged = block.record.slots.find((slot) => slot.slot === "discovery-2")!
    expect(salvaged.state).toBe("answered")
    expect(salvaged.note).toContain("salvaged answer")
    expect(block.cap1.kind).toBe("measured")
  })

  test("prefixes written by `writePrefixEvidence` read, and every block's CAP-1 is measured", async () => {
    const { root } = await labelledBundle({ realWriter: true })
    const result = await labelled(root)
    for (const block of result.blocks) {
      expect(block.record.kind).toBe("read")
      expect(block.cap1.kind).toBe("measured")
    }
  })

  test("a RELOCATED bundle still reads: the record is found from the root, and `dump` is only a cross-check", async () => {
    const { root } = await labelledBundle({ realWriter: true })
    const moved = join(await tempDir(), "moved")
    await cp(root, moved, { recursive: true })
    await rm(root, { recursive: true, force: true })
    const result = await labelled(moved)
    for (const block of result.blocks) {
      if (block.record.kind !== "read") throw new Error(JSON.stringify(block.record))
      expect(block.record.file).toBe(join(await realpath(moved), PREFIX_DIRECTORY, String(block.block - 1), `run-prefix-${block.block}`, "record.json"))
      expect(block.cap1.kind).toBe("measured")
    }
  })
})

// ---------------------------------------------------------------------------
// Applicability, the seal and the protocol
// ---------------------------------------------------------------------------

describe("applicability, the seal and the protocol", () => {
  test("NOT LABELLED: with no sealed schedule nothing is read, and `eval-read` prints exactly what it did", async () => {
    const root = await tempDir()
    await writeBundle(root, [{ armId: "on", repeatId: 0 }], [{ armId: "on", repeatId: 0 }])
    expect((await readLabelledBundle(await pairedOf(root))).kind).toBe("not-applicable")

    const bundle = await readBundle(root)
    if ("error" in bundle) throw new Error(bundle.error)
    const { code, text } = await captured(() => evalReadMain(["bun", "eval-read", "--bundle", root]))
    expect(code).toBe(0)
    expect(text).toBe(renderBundle(bundle))
  })

  test("a schedule the paired reader refused keeps that refusal", async () => {
    const root = await tempDir()
    await writeBundle(root, [{ armId: "on", repeatId: 0 }], [{ armId: "on", repeatId: 0 }])
    await writeFile(join(root, SCHEDULE_FILE), JSON.stringify({ scheduleVersion: 1 }))
    const outcome = await readLabelledBundle(await pairedOf(root))
    expect(outcome.kind).toBe("schedule-refused")
    expect(renderLabelledBundle(outcome)).toContain("the paired reader refused the sealed schedule")
  })

  for (const field of ["version", "materialHash", "labelsHash"] as const) {
    test(`MISMATCHED SEAL: a schedule fixture whose \`${field}\` differs is refused with the field named`, async () => {
      const fixture = { ...LABELLED_CHANGE_SEAL, [field]: field === "version" ? "labelled-change-0" : `sha256:${"0".repeat(64)}` }
      const { root } = await labelledBundle({ paired: { fixture } })
      const paired = await pairedOf(root)
      const before = renderPairedBundle(paired)
      const outcome = await readLabelledBundle(paired)
      if (outcome.kind !== "refused") throw new Error(JSON.stringify(outcome))
      expect(outcome.problems.map((problem) => problem.field)).toContain(`fixture.${field}`)
      const text = renderLabelledBundle(outcome)
      expect(text).toContain("REFUSED: THIS BUNDLE IS NOT THE SEALED LABELLED CHANGE.")
      expect(text).toContain(`\`fixture.${field}\``)
      expect(text).not.toContain("CAP-1 pool union")
      // The paired report is the same report either way.
      expect(renderPairedBundle(paired)).toBe(before)
      expect(paired.blocks.every((block) => block.result.kind === "measured")).toBe(true)
    })
  }

  test("an arm whose `identity.fixtureHash` differs is refused, naming the arm and the field", async () => {
    const { root } = await labelledBundle({ fixtureHash: known("sha256:fixture") })
    let calls = 0
    const outcome = await readLabelledBundle(await pairedOf(root), {
      matcher: (...args) => {
        calls += 1
        return lexicalDefectMatcher(...args)
      },
    })
    if (outcome.kind !== "refused") throw new Error(JSON.stringify(outcome))
    expect(outcome.problems).toHaveLength(6)
    expect(outcome.problems[0]).toMatchObject({ field: "identity.fixtureHash", actual: "sha256:fixture" })
    const text = renderLabelledBundle(outcome)
    expect(text).toContain("on/0: `identity.fixtureHash` is sha256:fixture")

    // A REFUSED REPORT STILL CARRIES ITS STATUS, and the status has to say which
    // kind of nothing it holds. "none read — this report is refused" is a
    // different fact from "none — no quantity has a complete observation", which
    // a bundle that WAS scored can report.
    expect(text).toContain("bundle observations: none read — this report is refused")
    expect(text).not.toContain("no quantity has a complete observation")
    // The caveat is unconditional, refusal included.
    expect(text).toContain("planned live evaluation: completion is NOT established by this report")
    // NO MATCHER IS NAMED, because none was used. Naming one would claim a
    // number was computed under it, and identity is refused before any scoring —
    // which the call count, not the absent line, is what actually proves.
    expect(text).not.toContain("matcher:")
    expect(calls).toBe(0)
  })

  test("a missing field and an unknown value read in one format, always a string", async () => {
    const { root } = await labelledBundle()
    const paired = await pairedOf(root)
    if (!paired.schedule.ok) throw new Error(paired.schedule.reason)
    delete (paired.schedule.schedule.fixture as Partial<typeof LABELLED_CHANGE_SEAL>).labelsHash
    paired.blocks[0]!.arms[0]!.row.manifest.identity.fixtureHash = { kind: "unknown", why: "the caller named no fixture" }
    const outcome = await readLabelledBundle(paired)
    if (outcome.kind !== "refused") throw new Error(JSON.stringify(outcome))
    for (const problem of outcome.problems) expect(typeof problem.actual).toBe("string")
    expect(outcome.problems.find((problem) => problem.field === "fixture.labelsHash")!.actual).toBe("absent")
    expect(outcome.problems.find((problem) => problem.field === "identity.fixtureHash")!.actual).toBe(
      "unknown (the caller named no fixture)",
    )
  })

  test("an arm whose protocol hash is not the schedule's is refused, naming the arm and the field", async () => {
    const { root } = await labelledBundle()
    const paired = await pairedOf(root)
    const arm = paired.blocks[1]!.arms.find((entry) => entry.arm === "on")!
    arm.row.manifest.identity.protocolHash = known("sha256:other")
    const outcome = await readLabelledBundle(paired)
    if (outcome.kind !== "refused") throw new Error(JSON.stringify(outcome))
    expect(outcome.problems).toEqual([
      { subject: "on/1", field: "identity.protocolHash", expected: protocolHash, actual: "sha256:other" },
    ])
  })

  test("a bound arm's protocol version that differs is refused", async () => {
    const { root } = await labelledBundle()
    const paired = await pairedOf(root)
    const arm = paired.blocks[0]!.arms[0]!
    arm.row.manifest.identity.protocolVersion = known(2)
    const outcome = await readLabelledBundle(paired)
    if (outcome.kind !== "refused") throw new Error(JSON.stringify(outcome))
    expect(outcome.problems).toEqual([
      { subject: `${arm.row.armId}/0`, field: "identity.protocolVersion", expected: "1", actual: "2" },
    ])
    expect(renderLabelledBundle(outcome)).toContain("`identity.protocolVersion` is 2, and this report requires 1")
  })

  test("with no arm bound in any block, the arm check refuses rather than passing empty", async () => {
    const { root } = await labelledBundle()
    const paired = await pairedOf(root)
    for (const block of paired.blocks) block.arms = []
    const outcome = await readLabelledBundle(paired)
    if (outcome.kind !== "refused") throw new Error(JSON.stringify(outcome))
    expect(outcome.problems[0]).toMatchObject({ subject: "arms", field: "identity.fixtureHash" })
  })

  test("an arm the paired reader did not bind is listed as excluded and refuses nothing", async () => {
    const { root } = await labelledBundle({
      arms: (spec) =>
        spec.block === 3 && spec.arm === "off"
          ? { ...spec, over: { ...spec.over, fixtureHash: known("sha256:fixture"), experiment: undefined } }
          : spec,
    })
    const outcome = await readLabelledBundle(await pairedOf(root))
    const excluded = outcome.kind === "read" || outcome.kind === "refused" ? outcome.excluded : []
    expect(outcome.kind).toBe("read")
    expect(excluded.map((entry) => `${entry.armId}/${entry.repeatId}`)).toContain("off/2")
    expect(renderLabelledBundle(outcome)).toContain("ARMS THE PAIRED READER DID NOT BIND")
  })

  test("`eval-read` prints the labelled report after the paired report, and returns 0", async () => {
    const { root } = await labelledBundle()
    const { code, text } = await captured(() => evalReadMain(["bun", "eval-read", "--bundle", root]))
    expect(code).toBe(0)
    expect(text.indexOf("MAD PAIRED CONTRAST")).toBeGreaterThan(-1)
    expect(text.indexOf("MAD LABELLED RECALL")).toBeGreaterThan(text.indexOf("MAD PAIRED CONTRAST"))
    expect(text).toContain("CAP-1 recall and CAP-11 lens gain are the labelled report's")
  })
})

// ---------------------------------------------------------------------------
// Prefix record binding
// ---------------------------------------------------------------------------

describe("prefix record binding", () => {
  test("WRONG RECORD: a contained record naming another block's run id is refused, both values named", async () => {
    const { root } = await labelledBundle({
      noRecord: [1],
      record: (record, block) => {
        if (block === 2) record.runId = "run-prefix-2"
      },
    })
    // Block 1's directory holds block 2's record, under block 1's run id.
    await mkdir(dumpDir(root, 1), { recursive: true })
    await writeFile(join(dumpDir(root, 1), "record.json"), JSON.stringify({ ...clone(lensed), runId: "run-prefix-2" }))
    const result = await labelled(root)
    expect(blockOf(result, 1).record.kind).toBe("refused")
    const text = renderLabelledBundle(result)
    expect(text).toContain("has `runId` `run-prefix-2`, but this block's prefix run is `run-prefix-1`")
    expect(blockOf(result, 2).record.kind).toBe("read")
    expect(summaryOf(result, "CAP-1 pool union").observed).toBe(2)
  })

  test("WRONG RECORD: a roster that is not the schedule's is refused, both rosters named", async () => {
    const { root } = await labelledBundle({
      record: (record, block) => {
        if (block === 1) (record.roster as { lensSlots: unknown[] }).lensSlots = []
      },
    })
    const record = blockOf(await labelled(root), 1).record
    if (record.kind === "read") throw new Error("expected a refusal")
    expect(reasonsOf(record)).toContain("lens []) is not the sealed schedule's `roster`")
    expect(reasonsOf(record)).toContain("`discovery-lens-security`")
  })

  test("a `dump` whose directory name is not the prefix run id is refused, both values named", async () => {
    const { root } = await labelledBundle({ dump: { 1: "/elsewhere/prefix/0/run-prefix-9" } })
    const record = blockOf(await labelled(root), 1).record
    if (record.kind !== "refused") throw new Error(JSON.stringify(record))
    expect(reasonsOf(record)).toContain("whose directory name `run-prefix-9` is not the prefix run id `run-prefix-1`")
  })

  test("a non-null `prefix.problem` leaves the block unavailable with the paired reader's reason", async () => {
    const { root } = await labelledBundle({ paired: { prefixOver: { 1: { block: 2 } } } })
    const block = blockOf(await labelled(root), 1)
    if (block.record.kind === "read") throw new Error("expected unavailable")
    expect(reasonsOf(block.record)).toContain("is filed under block 1 but says it is block 2")
    expect(block.cap1.kind).toBe("unavailable")
  })

  test("PATH ESCAPE: a symlinked dump resolving outside the block directory is refused with its real path", async () => {
    const outside = await tempDir()
    const { root } = await labelledBundle({ noRecord: [1] })
    await writeFile(join(outside, "record.json"), JSON.stringify({ ...clone(lensed), runId: "run-prefix-1" }))
    await mkdir(join(root, PREFIX_DIRECTORY, "0"), { recursive: true })
    await symlink(outside, dumpDir(root, 1))
    const result = await labelled(root)
    const record = blockOf(result, 1).record
    if (record.kind !== "refused") throw new Error(JSON.stringify(record))
    expect(reasonsOf(record)).toContain("resolves to the real path")
    expect(reasonsOf(record)).toContain("not inside the block directory")
    expect(blockOf(result, 1).cap1.kind).toBe("unavailable")
  })

  test("PATH ESCAPE: a symlinked `record.json` resolving outside is refused too", async () => {
    const outside = await tempDir()
    const { root } = await labelledBundle({ noRecord: [1] })
    await writeFile(join(outside, "record.json"), JSON.stringify({ ...clone(lensed), runId: "run-prefix-1" }))
    await mkdir(dumpDir(root, 1), { recursive: true })
    await symlink(join(outside, "record.json"), join(dumpDir(root, 1), "record.json"))
    const record = blockOf(await labelled(root), 1).record
    if (record.kind !== "refused") throw new Error(JSON.stringify(record))
    expect(reasonsOf(record)).toContain("the prefix record")
    expect(reasonsOf(record)).toContain("resolves to the real path")
  })

  test("PATH ESCAPE: a block directory symlinked outside the bundle root is refused", async () => {
    const outside = await tempDir()
    const { root } = await labelledBundle()
    const moved = join(outside, "0")
    await rename(join(root, PREFIX_DIRECTORY, "0"), moved)
    await symlink(moved, join(root, PREFIX_DIRECTORY, "0"))
    const record = blockOf(await labelled(root), 1).record
    if (record.kind !== "refused") throw new Error(JSON.stringify(record))
    expect(reasonsOf(record)).toContain("which is not inside the bundle root")
  })

  // EVERY FIELD THE PARSER GUARDS, one row each. A record the reader accepts is
  // a record every later rule may assume the shape of, so a guard that quietly
  // stopped guarding would not fail anywhere else in this file: the malformed
  // value would simply flow on and be read as a number, an id or a slot state.
  const malformed: { name: string; mutate: (record: RecordJson) => void; reason: string }[] = [
    { name: "`runId`", mutate: (record) => (record.runId = 7), reason: "`runId` is not a string" },
    { name: "`roster`", mutate: (record) => (record.roster = "the roster"), reason: "`roster` is not an object" },
    {
      name: "`roster.slots`",
      mutate: (record) => ((record.roster as { slots: unknown }).slots = [{ slot: 1 }]),
      reason: "`roster.slots` is not a list of slots with string `slot` ids",
    },
    {
      name: "`roster.lensSlots`",
      mutate: (record) => ((record.roster as { lensSlots: unknown }).lensSlots = [{ slot: "discovery-lens-tests" }]),
      reason: "`roster.lensSlots` is not a list of lens slots with string `slot` and `lens`",
    },
    { name: "`answered`", mutate: (record) => (record.answered = -1), reason: "`answered` is not a nonnegative integer" },
    {
      name: "`pool`",
      mutate: (record) => (record.pool = {} as unknown as RecordJson["pool"]),
      reason: "`pool` is not a list",
    },
    {
      name: "a `pool` entry that is not an object",
      mutate: (record) => (record.pool[0] = 5 as unknown as RecordJson["pool"][number]),
      reason: "`pool[0]` is not an object",
    },
    { name: "`pool[].id`", mutate: (record) => delete record.pool[0]!.id, reason: "`pool[0]` has no string `id`" },
    { name: "`pool[].claim`", mutate: (record) => delete record.pool[0]!.claim, reason: "`pool[0]` has no string `claim`" },
    {
      name: "`pool[].reasoning`",
      mutate: (record) => delete record.pool[0]!.reasoning,
      reason: "`pool[0]` has no string `reasoning`",
    },
    { name: "`pool[].locus`", mutate: (record) => delete record.pool[0]!.locus, reason: "`pool[0]` has no `locus.file`" },
    {
      name: "`pool[].locus.startLine`",
      mutate: (record) => ((record.pool[0]!.locus as { startLine: unknown }).startLine = "20"),
      reason: "`pool[0]` has a non-numeric `locus.startLine`",
    },
    {
      name: "`pool[].source`",
      mutate: (record) => (record.pool[0]!.source = "pooled"),
      reason: "`pool[0].source` is neither `pool` nor `lens`",
    },
    {
      name: "`pool[].author`",
      mutate: (record) => delete record.pool[0]!.author,
      reason: "`pool[0].author` is not a string",
    },
    {
      name: "`warnings`",
      mutate: (record) => (record.warnings = "none" as unknown as RecordJson["warnings"]),
      reason: "`warnings` is not a list",
    },
    {
      name: "`warnings[].code` and `warnings[].stage`",
      mutate: (record) => record.warnings.unshift({ message: "a warning that says nothing about itself" }),
      reason: "`warnings[0]` has no string `code` and `stage`",
    },
    {
      name: "`warnings[].detail`",
      mutate: (record) => record.warnings.unshift({ code: "model-dropped-out", stage: "discover", detail: 5 }),
      reason: "`warnings[0].detail` is not an object",
    },
    {
      name: "`cancelled`",
      mutate: (record) => (record.cancelled = {}),
      reason: "`cancelled` is present and has no string `stage`",
    },
    {
      name: "`skippedForBudget`",
      mutate: (record) => (record.skippedForBudget = [7]),
      reason: "`skippedForBudget` is present and is not a list of strings",
    },
  ]
  for (const entry of malformed) {
    test(`MALFORMED RECORD: ${entry.name} leaves the block unavailable, naming the field`, async () => {
      const { root } = await labelledBundle({
        record: (record, block) => {
          if (block === 1) entry.mutate(record)
        },
      })
      const record = blockOf(await labelled(root), 1).record
      if (record.kind !== "unavailable") throw new Error(JSON.stringify(record))
      expect(reasonsOf(record)).toContain(`is malformed: ${entry.reason}`)
    })
  }

  /**
   * THE OTHER HALF OF THE ISOLATION. `record.findings` is the adjudication
   * reader's truth pool and is scored by nothing here, so a `findings` this
   * process cannot parse must leave CAP-1 and CAP-11 exactly where they were.
   * The converse — a malformed `pool` withholding both — is the table above.
   */
  test("a malformed `findings` leaves CAP-1 and CAP-11 whole", async () => {
    const { root } = await labelledBundle({
      record: (record, block) => {
        if (block === 1) (record as Record<string, unknown>).findings = 5
      },
    })
    const block = blockOf(await labelled(root), 1)
    expect(block.record.kind).toBe("read")
    if (block.cap1.kind !== "measured") throw new Error(JSON.stringify(block.cap1))
    expect(block.cap1.pooled.found).toBe(7)
    expect(block.cap11.kind).toBe("measured")
  })

  test("MALFORMED RECORD: a `record.json` holding a JSON array is unavailable", async () => {
    const { root } = await labelledBundle()
    await writeFile(join(dumpDir(root, 1), "record.json"), "[]")
    const record = blockOf(await labelled(root), 1).record
    if (record.kind !== "unavailable") throw new Error(JSON.stringify(record))
    expect(reasonsOf(record)).toContain("is malformed: it is not a JSON object")
  })

  test("a `record.json` that is not JSON is unavailable", async () => {
    const { root } = await labelledBundle()
    await writeFile(join(dumpDir(root, 1), "record.json"), "{ not json")
    const record = blockOf(await labelled(root), 1).record
    if (record.kind !== "unavailable") throw new Error(JSON.stringify(record))
    expect(reasonsOf(record)).toContain("could not be read")
  })

  test("FAILED PREFIX: `dump: null` or an unreadable dump leaves the block unavailable and 2/3 per prefix quantity", async () => {
    const { root } = await labelledBundle({ dump: { 2: null }, noRecord: [2, 3] })
    const result = await labelled(root)
    expect(blockOf(result, 2).record.kind).toBe("unavailable")
    expect(blockOf(result, 3).record.kind).toBe("unavailable")
    const text = renderLabelledBundle(result)
    expect(text).toContain("`dump: null`")
    expect(text).toContain("could not be resolved")

    const { root: two } = await labelledBundle({ dump: { 2: null }, noRecord: [2] })
    const partial = await labelled(two)
    for (const quantity of ["CAP-1 pool union", "CAP-11 lens-only defects"] as const) {
      const summary = summaryOf(partial, quantity)
      expect(summary.observed).toBe(2)
      expect(summary.missing.map((gap) => gap.block)).toEqual([2])
    }
    // The arms are read from their manifests, so a MISSING RECORD does not reach
    // them. That is narrower than "a dead prefix does not reach them": a prefix
    // failure the paired reader itself withholds the block for takes the arms with
    // it, which the `forked: false` test below asserts.
    expect(summaryOf(partial, "on upheld planted-label matches").observed).toBe(3)

    // ONE FACT, PRINTED ONCE. The record's reasons used to repeat verbatim under
    // CAP-1 and CAP-11, with the kind doubled into "the prefix record is
    // unavailable: ...". The structured `reasons` still carry it in full.
    const blockTwo = renderLabelledBundle(partial).split("BLOCK 2")[1]!.split("BLOCK 3")[0]!
    expect(blockTwo).toContain("CAP-1: WITHHELD — the PREFIX RECORD UNAVAILABLE above")
    expect(blockTwo).toContain("CAP-11: UNAVAILABLE — the PREFIX RECORD UNAVAILABLE above")
    expect(blockTwo).not.toContain("the prefix record is unavailable:")
    expect(blockTwo.match(/dump: null/g)).toHaveLength(1)
    const withheld = blockOf(partial, 2).cap1
    if (withheld.kind !== "unavailable") throw new Error("expected unavailable")
    expect(withheld.reasons.join(" ")).toContain("`dump: null`")
  })

  test("CANCELLED PREFIX (runner): a `forked: false` prefix is withheld, CAP-1 included", async () => {
    const { root } = await labelledBundle({
      paired: { prefixOver: { 1: { forked: false, reason: "the run was cancelled during block 1's shared prefix" } } },
    })
    const result = await labelled(root)
    const block = blockOf(result, 1)
    expect(block.record.kind).toBe("unavailable")
    expect(block.cap1.kind).toBe("unavailable")
    expect(block.cap11.kind).toBe("unavailable")
    expect(block.arms.every((arm) => arm.result.kind === "unavailable")).toBe(true)
  })

  test("CANCELLED PREFIX (synthetic record): CAP-11 coverage is unknown and withheld, CAP-1 stands on its own checks", async () => {
    const { root } = await labelledBundle({
      record: (record, block) => {
        if (block === 1) record.cancelled = { stage: "discover" }
      },
    })
    const result = await labelled(root)
    const block = blockOf(result, 1)
    expect(block.cap1.kind).toBe("measured")
    if (block.cap11.kind !== "unavailable") throw new Error("expected CAP-11 withheld")
    expect(block.cap11.reasons.join(" ")).toContain("lens coverage is unknown")

    // UNKNOWN IS NOT UNANSWERED, and the difference is the whole point of the
    // state. A cancelled turn leaves no drop-out and no skip entry, so a lens
    // slot that LOOKS answered is one nothing is known about. Printed as
    // UNANSWERED it would accuse a model of not answering; printed as answered it
    // would credit one that may never have been asked.
    if (block.record.kind !== "read") throw new Error(JSON.stringify(block.record))
    const lens = block.record.slots.find((slot) => slot.slot === "discovery-lens-tests")!
    expect(lens.state).toBe("unknown")
    expect(lens.note).toContain("leaves no trace of a cancelled slot")
    expect(renderLabelledBundle(result)).toContain("lens slot `discovery-lens-tests` lens `tests`: STATE UNKNOWN")
    // Pool slots keep their states: this record's cancellation is read for lens
    // coverage alone, and CAP-1 above still stands on its own checks.
    expect(block.record.slots.find((slot) => slot.slot === "discovery-1")!.state).toBe("answered")
  })

  test("CANCELLED PREFIX: a lens slot with KNOWN evidence keeps its state; only the silent ones go unknown", async () => {
    const { root } = await labelledBundle({
      record: (record, block) => {
        if (block !== 1) return
        withoutAuthors(record, ["discovery-lens-tests", "discovery-lens-privacy-a11y"])
        dropOut(record, "discovery-lens-tests")
        record.skippedForBudget = ["discovery-lens-privacy-a11y"]
        record.cancelled = { stage: "discover" }
      },
    })
    const result = await labelled(root)
    const block = blockOf(result, 1)
    if (block.record.kind !== "read") throw new Error(JSON.stringify(block.record))
    const slots = block.record.slots
    const stateOf = (slot: string) => slots.find((entry) => entry.slot === slot)!.state
    // A drop-out and a budget skip are EVIDENCE. Cancellation does not erase them,
    // and a rule that overwrote every lens slot would throw both away.
    expect(stateOf("discovery-lens-tests")).toBe("dropped")
    expect(stateOf("discovery-lens-privacy-a11y")).toBe("skipped-for-budget")
    expect(stateOf("discovery-lens-performance")).toBe("unknown")
    expect(stateOf("discovery-lens-security")).toBe("unknown")
    const text = renderLabelledBundle(result)
    expect(text).toContain("lens slot `discovery-lens-tests` lens `tests`: UNANSWERED (dropped)")
    expect(text).toContain("lens slot `discovery-lens-performance` lens `performance`: STATE UNKNOWN")
  })

  test("A SHARED PREFIX IS ONE OBSERVATION, even when two blocks name it", async () => {
    const { root } = await labelledBundle({
      arms: (spec) => (spec.block === 2 ? { ...spec, prefixRunId: "run-prefix-1" } : spec),
      dump: { 2: "run-prefix-1" },
      paired: { prefixOver: { 2: { prefixRunId: known("run-prefix-1") } } },
      record: (record, block) => {
        if (block === 2) record.runId = "run-prefix-1"
      },
    })
    const result = await labelled(root)
    expect(blockOf(result, 2).record.kind).toBe("read")
    const summary = summaryOf(result, "CAP-1 pool union")
    expect(summary.observed).toBe(2)
    expect(summary.missing[0]!.reason).toContain("a shared prefix is one observation")
    expect(summaryOf(result, "on upheld planted-label matches").observed).toBe(3)
  })

  test("a block the paired reader did not return is listed as missing, with its reason", async () => {
    const { root } = await labelledBundle()
    const paired = await pairedOf(root)
    paired.blocks = paired.blocks.filter((block) => block.block !== 3)
    const outcome = await readLabelledBundle(paired)
    if (outcome.kind !== "read") throw new Error(JSON.stringify(outcome))
    for (const summary of outcome.summaries) {
      expect(summary.of).toBe(3)
      expect(summary.missing).toContainEqual({ block: 3, reason: "the paired reader returned no block 3" })
    }
  })
})

// ---------------------------------------------------------------------------
// Slot identity, coverage, summaries
// ---------------------------------------------------------------------------

describe("slot identity and coverage", () => {
  test("DROPPED POOL SLOT: listed unanswered with its reason, and a partial diagnostic outside the summary", async () => {
    const { root } = await labelledBundle({
      record: (record, block) => {
        if (block !== 1) return
        withoutAuthors(record, ["discovery-3"])
        dropOut(record, "discovery-3")
        record.answered = 2
      },
    })
    const result = await labelled(root)
    const block = blockOf(result, 1)
    if (block.record.kind !== "read") throw new Error("expected a read")
    expect(block.record.slots.find((slot) => slot.slot === "discovery-3")).toMatchObject({ state: "dropped" })
    if (block.cap1.kind !== "measured") throw new Error(JSON.stringify(block.cap1))
    expect(block.cap1.members.map((member) => member.slot)).toEqual(["discovery-1", "discovery-2"])
    expect(block.cap1.complete).toBe(false)
    const text = renderLabelledBundle(result)
    expect(text).toContain("pool slot `discovery-3`: UNANSWERED (dropped)")
    expect(text).toContain("PARTIAL DIAGNOSTIC, outside the planned summary")
    const summary = summaryOf(result, "CAP-1 pool union")
    expect(summary.observed).toBe(2)
    expect(summary.missing[0]!.reason).toContain("pool coverage 2 of 3")
    expect(summaryOf(result, "CAP-11 lens-only defects").observed).toBe(2)
  })

  test("DROPPED LENS SLOT: CAP-11 reads over 3 of 4 lens slots, outside the summary", async () => {
    const { root } = await labelledBundle({
      record: (record, block) => {
        if (block !== 1) return
        withoutAuthors(record, ["discovery-lens-tests"])
        dropOut(record, "discovery-lens-tests")
      },
    })
    const result = await labelled(root)
    const cap11 = blockOf(result, 1).cap11
    if (cap11.kind !== "measured") throw new Error(JSON.stringify(cap11))
    expect(cap11.lens).toEqual({ answered: 3, of: 4 })
    expect(cap11.complete).toBe(false)
    expect(summaryOf(result, "CAP-11 lens-only defects").missing[0]!.reason).toContain("lens coverage 3 of 4")
  })

  test("IDENTITY MISMATCH: counts agree but a pool finding's author is unanswered — withheld, both sides named", async () => {
    const { root } = await labelledBundle({
      record: (record, block) => {
        if (block !== 1) return
        dropOut(record, "discovery-3")
        record.answered = 2
      },
    })
    const block = blockOf(await labelled(root), 1)
    if (block.cap1.kind !== "unavailable") throw new Error("expected CAP-1 withheld")
    const reasons = block.cap1.reasons.join(" ")
    expect(reasons).toContain("name author `discovery-3`, which is not an answered pool slot")
    expect(reasons).toContain("answered pool slots: `discovery-1`, `discovery-2`")
    expect(block.cap11.kind).toBe("unavailable")
  })

  test("IDENTITY MISMATCH: the derived answered set disagreeing with `record.answered` withholds, naming both", async () => {
    const { root } = await labelledBundle({
      record: (record, block) => {
        if (block === 1) record.answered = 2
      },
    })
    const block = blockOf(await labelled(root), 1)
    if (block.cap1.kind !== "unavailable") throw new Error("expected CAP-1 withheld")
    expect(block.cap1.reasons.join(" ")).toContain("number 3, but `record.answered` is 2")
  })

  test("a lens finding by a budget-skipped lens slot withholds CAP-11 only", async () => {
    const { root } = await labelledBundle({
      record: (record, block) => {
        if (block === 1) record.skippedForBudget = ["discovery-lens-tests"]
      },
    })
    const block = blockOf(await labelled(root), 1)
    expect(block.cap1.kind).toBe("measured")
    if (block.cap11.kind !== "unavailable") throw new Error("expected CAP-11 withheld")
    expect(block.cap11.reasons.join(" ")).toContain("name author `discovery-lens-tests`, which is not an answered lens slot")
  })

  test("a lens finding by a dropped lens slot withholds CAP-11 only", async () => {
    const { root } = await labelledBundle({
      record: (record, block) => {
        if (block === 1) dropOut(record, "discovery-lens-tests")
      },
    })
    const block = blockOf(await labelled(root), 1)
    expect(block.cap1.kind).toBe("measured")
    expect(reasonsOf(block.cap11)).toContain("name author `discovery-lens-tests`, which is not an answered lens slot")
  })

  test("an unknown `skippedForBudget` id withholds both quantities", async () => {
    const { root } = await labelledBundle({
      record: (record, block) => {
        if (block === 1) record.skippedForBudget = ["discovery-9"]
      },
    })
    const block = blockOf(await labelled(root), 1)
    expect(block.cap1.kind).toBe("unavailable")
    expect(block.cap11.kind).toBe("unavailable")
    expect(reasonsOf(block.cap1)).toContain("`discovery-9`")
  })

  test("DUPLICATE pool slot ids withhold both quantities", async () => {
    const { root } = await labelledBundle({
      roster: (roster) => {
        roster.slots[1]!.slot = "discovery-1"
      },
    })
    const block = blockOf(await labelled(root), 1)
    expect(block.record.kind).toBe("read")
    expect(reasonsOf(block.cap1)).toContain("the roster's pool slot ids are not unique: `discovery-1`")
    expect(block.cap11.kind).toBe("unavailable")
  })

  test("OVERLAPPING pool and lens slot ids withhold both quantities", async () => {
    const { root } = await labelledBundle({
      roster: (roster) => {
        roster.lensSlots[0]!.slot = "discovery-1"
      },
    })
    const block = blockOf(await labelled(root), 1)
    expect(reasonsOf(block.cap1)).toContain("the roster's pool and lens slot ids are not disjoint: `discovery-1`")
    expect(block.cap11.kind).toBe("unavailable")
  })

  const contradictions: { name: string; mutate: (record: RecordJson) => void; reason: string; cap1: boolean }[] = [
    {
      name: "a pool slot both dropped and skipped",
      mutate: (record) => {
        withoutAuthors(record, ["discovery-3"])
        dropOut(record, "discovery-3")
        record.skippedForBudget = ["discovery-3"]
        record.answered = 2
      },
      reason: "slot `discovery-3` is both `model-dropped-out` and in `skippedForBudget`",
      cap1: false,
    },
    {
      name: "a pool slot both dropped and salvaged",
      mutate: (record) => {
        withoutAuthors(record, ["discovery-3"])
        dropOut(record, "discovery-3")
        salvage(record, "discovery-3")
        record.answered = 2
      },
      reason: "slot `discovery-3` is both `model-dropped-out` and a `partial-envelope` answer",
      cap1: false,
    },
    {
      name: "a pool slot both skipped and salvaged",
      mutate: (record) => {
        withoutAuthors(record, ["discovery-3"])
        record.skippedForBudget = ["discovery-3"]
        salvage(record, "discovery-3")
        record.answered = 2
      },
      reason: "slot `discovery-3` is both in `skippedForBudget` and a `partial-envelope` answer",
      cap1: false,
    },
    {
      name: "duplicate drop-out warnings for one pool slot",
      mutate: (record) => {
        withoutAuthors(record, ["discovery-3"])
        dropOut(record, "discovery-3")
        dropOut(record, "discovery-3")
        record.answered = 2
      },
      reason: "slot `discovery-3` carries 2 discover-stage `model-dropped-out` warnings",
      cap1: false,
    },
    {
      name: "`skippedForBudget` naming one pool slot twice",
      mutate: (record) => {
        withoutAuthors(record, ["discovery-3"])
        record.skippedForBudget = ["discovery-3", "discovery-3"]
        record.answered = 2
      },
      reason: "`skippedForBudget` names `discovery-3` more than once",
      cap1: false,
    },
    {
      name: "`skippedForBudget` naming one lens slot twice",
      mutate: (record) => {
        withoutAuthors(record, ["discovery-lens-tests"])
        record.skippedForBudget = ["discovery-lens-tests", "discovery-lens-tests"]
      },
      reason: "`skippedForBudget` names `discovery-lens-tests` more than once",
      cap1: true,
    },
    {
      name: "a drop-out warning with no `detail.slot`",
      mutate: (record) => dropOut(record, undefined),
      reason: "a discover-stage `model-dropped-out` warning carries no string `detail.slot`",
      cap1: false,
    },
    {
      name: "a drop-out warning naming an unknown slot",
      mutate: (record) => dropOut(record, "discovery-9"),
      reason: "a discover-stage `model-dropped-out` warning names slot `discovery-9`, which the roster does not hold",
      cap1: false,
    },
    {
      name: "a lens-source finding authored by a pool slot",
      mutate: (record) => {
        const lens = record.pool.find((finding) => finding.source === "lens")!
        lens.author = "discovery-1"
      },
      reason: "name author `discovery-1`, which is a POOL slot",
      cap1: false,
    },
    {
      name: "a lens slot both dropped and skipped",
      mutate: (record) => {
        withoutAuthors(record, ["discovery-lens-tests"])
        dropOut(record, "discovery-lens-tests")
        record.skippedForBudget = ["discovery-lens-tests"]
      },
      reason: "slot `discovery-lens-tests` is both `model-dropped-out` and in `skippedForBudget`",
      cap1: true,
    },
  ]
  for (const contradiction of contradictions) {
    test(`CONTRADICTORY SLOT EVIDENCE: ${contradiction.name} withholds ${contradiction.cap1 ? "CAP-11 only" : "both"}`, async () => {
      const { root } = await labelledBundle({
        record: (record, block) => {
          if (block === 1) contradiction.mutate(record)
        },
      })
      const block = blockOf(await labelled(root), 1)
      expect(block.cap1.kind).toBe(contradiction.cap1 ? "measured" : "unavailable")
      if (!contradiction.cap1) expect(reasonsOf(block.cap1)).toContain(contradiction.reason)
      expect(reasonsOf(block.cap11)).toContain(contradiction.reason)
    })
  }

  test("a BUDGET-SKIPPED lens slot: CAP-11 reads over n of m lens slots, and a zero describes only those", async () => {
    const { root } = await labelledBundle({
      record: (record, block) => {
        if (block !== 1) return
        withoutAuthors(record, ["discovery-lens-tests"])
        record.skippedForBudget = ["discovery-lens-tests"]
      },
    })
    const result = await labelled(root)
    const cap11 = blockOf(result, 1).cap11
    if (cap11.kind !== "measured") throw new Error(JSON.stringify(cap11))
    expect(cap11.lens).toEqual({ answered: 3, of: 4 })
    expect(cap11.complete).toBe(false)
    const text = renderLabelledBundle(result)
    expect(text).toContain("over 3 of 4 lens slots answered")
    expect(text).toContain("a zero here describes only the 3 answered lens slot(s)")
    expect(summaryOf(result, "CAP-11 lens-only defects").missing[0]!.reason).toContain("lens coverage 3 of 4")
  })

  test("NO LENS SLOT: CAP-11 is unavailable with its reason", async () => {
    const { root } = await labelledBundle({ lenses: false })
    const result = await labelled(root)
    for (const block of result.blocks) {
      if (block.cap11.kind !== "unavailable") throw new Error("expected CAP-11 unavailable")
      expect(block.cap11.reasons.join(" ")).toContain("no lens slot")
      expect(block.cap1.kind).toBe("measured")
    }
    expect(summaryOf(result, "CAP-11 lens-only defects").observed).toBe(0)
    expect(renderLabelledBundle(result)).toContain("unavailable — no complete observation")
  })

  test("NO POOL SLOT: CAP-11 has no baseline and is unavailable, never every lens defect", async () => {
    const pool = ["discovery-1", "discovery-2", "discovery-3"]
    const { root } = await labelledBundle({
      roster: (roster) => {
        roster.slots = []
      },
      record: (record) => {
        withoutAuthors(record, pool)
        record.answered = 0
      },
    })
    const block = blockOf(await labelled(root), 1)
    expect(block.record.kind).toBe("read")
    expect(reasonsOf(block.cap11)).toContain("no pool slot, so CAP-11 has no baseline")
  })

  test("ZERO ANSWERED LENS SLOTS: CAP-11 is unavailable, never a zero", async () => {
    const lensSlots = LENSES.map((lens) => `discovery-lens-${lens}`)
    const { root } = await labelledBundle({
      record: (record) => {
        withoutAuthors(record, lensSlots)
        record.skippedForBudget = [...lensSlots]
      },
    })
    const cap11 = blockOf(await labelled(root), 1).cap11
    if (cap11.kind !== "unavailable") throw new Error("expected unavailable")
    expect(cap11.reasons.join(" ")).toContain("no lens slot answered (0 of 4)")
  })

  test("ZERO ANSWERED POOL SLOTS: no best member and no comparison, never a zero best", async () => {
    const pool = ["discovery-1", "discovery-2", "discovery-3"]
    const { root } = await labelledBundle({
      record: (record) => {
        withoutAuthors(record, pool)
        for (const slot of pool) dropOut(record, slot)
        record.answered = 0
      },
    })
    const result = await labelled(root)
    const cap1 = blockOf(result, 1).cap1
    if (cap1.kind !== "unavailable") throw new Error("expected unavailable")
    expect(cap1.reasons.join(" ")).toContain("no best member and no comparison")
    expect(summaryOf(result, "CAP-1 best answered pool slot").observed).toBe(0)
  })

  test("a SALVAGED answer counts as answered, with its `partial-envelope` disclosure shown", async () => {
    const { root } = await labelledBundle({
      record: (record, block) => {
        if (block === 1) salvage(record, "discovery-1")
      },
    })
    const result = await labelled(root)
    const block = blockOf(result, 1)
    if (block.cap1.kind !== "measured") throw new Error(JSON.stringify(block.cap1))
    expect(block.cap1.complete).toBe(true)
    expect(renderLabelledBundle(result)).toContain(
      "pool slot `discovery-1`: answered, 4 finding(s) — salvaged answer — `partial-envelope`: 4 finding(s) kept, 1 dropped",
    )
  })

  test("ONE OBSERVATION: the value, and `spread unavailable`", async () => {
    const { root } = await labelledBundle({ dump: { 2: null, 3: null }, noRecord: [2, 3] })
    const result = await labelled(root)
    const summary = summaryOf(result, "CAP-1 pool union")
    expect(summary.observed).toBe(1)
    expect(summary.values).toEqual([7])
    expect(renderLabelledBundle(result)).toContain("value 7; spread unavailable")
  })

  test("a withheld paired block leaves its arms' upheld findings unavailable, with the paired reason", async () => {
    const { root } = await labelledBundle({
      arms: (spec) => (spec.block === 1 && spec.arm === "off" ? { ...spec, prefixRunId: "run-prefix-other" } : spec),
    })
    const result = await labelled(root)
    const arms = blockOf(result, 1).arms
    expect(arms.length).toBe(2)
    for (const arm of arms) {
      if (arm.result.kind !== "unavailable") throw new Error("expected unavailable")
      expect(arm.result.reason).toContain("the paired block is withheld")
    }
    expect(summaryOf(result, "on upheld planted-label matches").observed).toBe(2)
  })

  test("an upheld finding with no locus leaves that arm unavailable rather than throwing", async () => {
    const { root } = await labelledBundle({
      arms: (spec) => {
        if (spec.block !== 1 || spec.arm !== "on") return spec
        const findings = armFindings(lensed, "on") as { pool: Finding[]; canonicalIds: string[] }
        const upheld = findings.pool.find((finding) => finding.id === findings.canonicalIds[0])!
        delete (upheld as Partial<Finding>).locus
        return { ...spec, over: { ...spec.over, findings } }
      },
    })
    const on = blockOf(await labelled(root), 1).arms.find((arm) => arm.arm === "on")!
    if (on.result.kind !== "unavailable") throw new Error("expected unavailable")
    expect(on.result.reason).toContain("has no `locus.file`")
  })
})

// ---------------------------------------------------------------------------
// The two paths the report prints as provenance
// ---------------------------------------------------------------------------

/**
 * THE POINTERS ARE PINNED TO THEIR FILES, NOT TO THEIR STRINGS, for the reason
 * `read-bundle.test.ts` pins `PAIRED_READER_MODULE`: a renamed file leaves the
 * report pointing at nothing, and a string assertion keeps passing through it.
 *
 * `existsSync` is necessary and not sufficient. A path present in the working
 * tree and absent from the repository resolves here and resolves nowhere else,
 * which is how the draft protocol shipped ignored by `.gitignore` while this
 * suite was green. The packaging half is held by `.gitignore`'s own exception
 * list, one line per cited file.
 */
describe("the closing paragraph says where the counts it does not carry now live", () => {
  /**
   * SCOPED TO THIS REPORT'S OWN CLOSING. `eval-read` prints four reports and the
   * PAIRED one names the adjudication module in its closing too, so an assertion
   * over the whole output is satisfied by the wrong report — the sentence could
   * be deleted from here with nothing failing. The slice is what holds it.
   */
  test("the labelled report's closing names the adjudication reader", async () => {
    const { root } = await labelledBundle()
    const outcome = await readLabelledBundle(await pairedOf(root))
    const text = renderLabelledBundle(outcome)
    const closing = text.slice(text.indexOf("WHAT THIS REPORT DOES NOT MEASURE."))
    expect(closing, "no closing paragraph in the labelled report").not.toBe("")
    expect(closing).toContain(ADJUDICATION_READER_MODULE)
    expect(closing).toContain("U is not a truth label")
  })
})

// ---------------------------------------------------------------------------
// When scoring itself fails
// ---------------------------------------------------------------------------

describe("when scoring itself fails", () => {
  test("A THROWING MATCHER: every quantity is unavailable with the error, and nothing is rendered as zero", async () => {
    // THREE INDEPENDENT HANDLERS, one read. CAP-1, CAP-11 and the arms each
    // catch their own scoring error, so each could fail open on its own — and a
    // quantity that failed open would print `0`, which reads as "the models found
    // nothing" rather than "this reader could not score". The existing
    // throwing-matcher test above writes NO prefix record, so it reaches the arm
    // handler only; this bundle is complete and reaches all three.
    const { root } = await labelledBundle()
    const result = await labelled(root, {
      matcher: () => {
        throw new Error("the matcher failed")
      },
    })
    for (const block of result.blocks) {
      expect(block.record.kind).toBe("read")
      for (const quantity of [block.cap1, block.cap11]) {
        if (quantity.kind !== "unavailable") throw new Error(JSON.stringify(quantity))
        expect(quantity.reasons.join(" ")).toContain("scoring failed: the matcher failed")
      }
      for (const arm of block.arms) {
        if (arm.result.kind !== "unavailable") throw new Error(JSON.stringify(arm.result))
        expect(arm.result.reason).toContain("scoring failed: the matcher failed")
      }
    }
    for (const summary of result.summaries) {
      expect(summary.observed).toBe(0)
      expect(summary.values).toEqual([])
      expect(summary.missing.map((gap) => gap.block)).toEqual([1, 2, 3])
      for (const gap of summary.missing) expect(gap.reason).toContain("scoring failed: the matcher failed")
    }
    const text = renderLabelledBundle(result)
    expect(text).toContain("scoring failed: the matcher failed")
    expect(text).toContain("bundle observations: none — no quantity has a complete observation in this bundle")
  })
})

describe("every path the labelled report prints as provenance resolves", () => {
  test("the module that produces the report", async () => {
    const { root } = await labelledBundle()
    expect(renderLabelledBundle(await labelled(root))).toContain(LABELLED_READER_MODULE)
    expect(existsSync(join(import.meta.dir, "..", LABELLED_READER_MODULE))).toBe(true)
  })

  test("the draft protocol that proposes the endpoints", async () => {
    const { root } = await labelledBundle()
    expect(renderLabelledBundle(await labelled(root))).toContain(PROTOCOL_V2_DRAFT)
    expect(existsSync(join(import.meta.dir, "..", PROTOCOL_V2_DRAFT))).toBe(true)
  })
})
