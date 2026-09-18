/**
 * Story 2-6b — the adjudication reader, one matrix row at a time, over PERSISTED
 * bundles.
 *
 * Every bundle here is a real sealed paired bundle with a real prefix
 * `record.json` on disk, read back through `readPairedBundle`. Nothing bills and
 * no model runs.
 *
 * The four directions are each proved in ISOLATION — one block whose only
 * labelled transition is that one — because a single fixture exercising all four
 * at once cannot tell a correct table from one whose rows are permuted. Every
 * summary rule is proved over blocks whose values DIFFER, because a suite in
 * which every block observes 1 cannot tell a mean from a min.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SEEDED_DEFECTS } from "../fixtures/seeded-defects/labels.ts"
import { lexicalDefectMatcher, type DefectMatcher } from "../fixtures/recall.ts"
import { main as evalReadMain } from "../scripts/eval-read.ts"
import {
  ADJUDICATION_SHEET_FILE,
  ADJUDICATION_SHEET_VERSION,
  DIRECTIONS,
  readAdjudicationBundle,
  renderAdjudicationBundle,
  TRUTH_LABELS,
  verdictBucket,
  type AdjudicationReadResult,
  type BlockRead,
  type DirectionKey,
  type TruthLabel,
} from "./adjudication-read.ts"
import { pageFor, sheetFor, writeSheet, type SheetBlockInput } from "./adjudication-read.fixture.ts"
import { PREFIX_DIRECTORY } from "./bundle.ts"
import { known } from "./manifest.ts"
import { readPairedBundle, type PairedReadResult } from "./paired-read.ts"
import { pairedBundleAt, type ArmSpec, type FindingSpec, type PairedBundleOptions } from "./paired-read.fixture.ts"
import { writeBundle } from "./read-bundle.fixture.ts"
import { SCHEDULE_FILE, type PairedSchedule } from "./schedule.ts"

const scratch: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-adjudication-read-"))
  scratch.push(dir)
  return dir
}

async function clean(): Promise<void> {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
}

afterEach(clean)

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

/** How one arm left a candidate. `null` is the arm never raising it at all. */
type ArmVerdict = "upheld" | "judge-ruled-invalid" | "withdrawn-by-author" | "not-adjudicated" | "unresolved" | "unjudged"

interface Candidate {
  id: string
  /** A planted defect whose locus and marker this candidate's prose carries. */
  defect?: string
  on: ArmVerdict | null
  off: ArmVerdict | null
}

/**
 * The default block: one candidate per outcome the report has a name for, so
 * every bucket is non-empty unless a test empties it.
 *
 * `c1` is a correct removal, `c2` a correct recovery, `c3` a harmful loss, `c4`
 * a harmful addition, `c5` unchanged, `c6` undecided, `c7` raised by ON only.
 */
const BLOCK: Candidate[] = [
  { id: "c1", defect: "sql-injection", on: "judge-ruled-invalid", off: "upheld" },
  { id: "c2", on: "upheld", off: "judge-ruled-invalid" },
  { id: "c3", on: "withdrawn-by-author", off: "upheld" },
  { id: "c4", on: "upheld", off: "judge-ruled-invalid" },
  { id: "c5", on: "upheld", off: "upheld" },
  { id: "c6", on: "not-adjudicated", off: "upheld" },
  { id: "c7", on: "upheld", off: null },
]

/** Which label makes each default candidate land in the bucket its comment names. */
const LABELS: Record<string, TruthLabel> = {
  c1: "not-a-defect",
  c2: "true-defect",
  c3: "true-defect",
  c4: "not-a-defect",
  c5: "true-defect",
  c6: "true-defect",
  c7: "true-defect",
}

function findingSpecs(candidates: readonly Candidate[], arm: "on" | "off", extras: readonly FindingSpec[]): FindingSpec[] {
  const specs: FindingSpec[] = []
  for (const candidate of candidates) {
    const verdict = arm === "on" ? candidate.on : candidate.off
    if (verdict === null) continue
    if (verdict === "unresolved") specs.push({ id: candidate.id, unresolved: true })
    else if (verdict === "unjudged") specs.push({ id: candidate.id })
    else specs.push({ id: candidate.id, verdict })
  }
  return [...specs, ...extras]
}

/** One canonical prefix candidate, with prose the lexical matcher can act on. */
function canonicalFinding(candidate: Candidate): Record<string, unknown> {
  const defect = candidate.defect === undefined ? undefined : SEEDED_DEFECTS.find((entry) => entry.id === candidate.defect)
  if (candidate.defect !== undefined && defect === undefined) throw new Error(`no planted defect \`${candidate.defect}\``)
  return {
    id: candidate.id,
    claim: defect === undefined ? `an ordinary claim about \`${candidate.id}\`` : `this query is built by string ${defect.markers[0]}`,
    reasoning: `reasoning for \`${candidate.id}\``,
    locus: defect === undefined ? { file: "src/other/thing.ts", startLine: 3, endLine: 4 } : { ...defect.locus },
    source: "pool",
    author: "slot-1",
  }
}

interface BundleOptions {
  /** Per block, the candidates that block's prefix and arms carry. */
  blocks?: Record<number, Candidate[]>
  /** Extra overrides handed straight to the paired fixture. */
  paired?: PairedBundleOptions
  /** Skip writing `record.json` for these blocks. */
  noRecord?: number[]
  /** Replace a block's prefix run id — two blocks may name one run. */
  prefixRunIds?: Record<number, string>
  /** Findings both arms carry that the prefix pool does not hold. */
  armExtras?: FindingSpec[]
  /** Mutate a block's prefix record before it is written. */
  recordOver?: (record: Record<string, unknown>, block: number) => void
  /** Rewrite one arm's spec, to break exactly one field of it. */
  armOver?: (spec: ArmSpec) => ArmSpec
}

function candidatesOf(options: BundleOptions, block: number): Candidate[] {
  return options.blocks?.[block] ?? BLOCK
}

function runIdOf(options: BundleOptions, block: number): string {
  return options.prefixRunIds?.[block] ?? `run-prefix-${block}`
}

/** A sealed, healthy paired bundle whose three prefix records hold real canonical pools. */
async function bundleAt(options: BundleOptions = {}): Promise<{ root: string; schedule: PairedSchedule }> {
  const root = await tempDir()
  const arms: ArmSpec[] = []
  const prefixOver: Record<number, Record<string, unknown>> = {}
  for (const block of [1, 2, 3]) {
    const candidates = candidatesOf(options, block)
    const runId = runIdOf(options, block)
    for (const arm of ["on", "off"] as const) {
      arms.push({ block, arm, prefixRunId: runId, findings: findingSpecs(candidates, arm, options.armExtras ?? []) })
    }
    prefixOver[block] = {
      prefixRunId: known(runId),
      dump: join(root, PREFIX_DIRECTORY, String(block - 1), runId),
      ...(options.paired?.prefixOver?.[block] ?? {}),
    }
  }
  // `arms` and `prefixOver` are this helper's own and are applied LAST, so a
  // caller's `paired` cannot silently lose them — and cannot silently be lost.
  const specs = options.armOver === undefined ? arms : arms.map(options.armOver)
  const schedule = await pairedBundleAt(root, { ...options.paired, arms: specs, prefixOver })

  for (const block of [1, 2, 3]) {
    if (options.noRecord?.includes(block)) continue
    const runId = runIdOf(options, block)
    const pool = candidatesOf(options, block).map(canonicalFinding)
    const record: Record<string, unknown> = {
      runId,
      roster: schedule.roster,
      answered: schedule.roster.slots.length,
      pool,
      findings: pool,
      warnings: [],
    }
    options.recordOver?.(record, block)
    const directory = join(root, PREFIX_DIRECTORY, String(block - 1), runId)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "record.json"), JSON.stringify(record))
  }
  return { root, schedule }
}

async function pairedOf(root: string): Promise<PairedReadResult> {
  const paired = await readPairedBundle(root)
  if ("error" in paired) throw new Error(paired.error)
  return paired
}

async function readAt(root: string, matcher?: DefectMatcher): Promise<AdjudicationReadResult> {
  const outcome = await readAdjudicationBundle(await pairedOf(root), matcher === undefined ? {} : { matcher })
  if (outcome.kind !== "read") throw new Error(`expected a read, got \`${outcome.kind}\``)
  return outcome
}

function blockOf(result: AdjudicationReadResult, block: number): BlockRead {
  const found = result.blocks.find((entry) => entry.block === block)
  if (found === undefined) throw new Error(`no block ${block}`)
  return found.result
}

function readBlock(result: AdjudicationReadResult, block: number): Extract<BlockRead, { kind: "read" }> {
  const found = blockOf(result, block)
  if (found.kind !== "read") throw new Error(`block ${block} is ${found.kind}: ${found.reasons.join("; ")}`)
  return found
}

/** The report's sheet-level section: everything above its first block heading. */
function sheetSection(text: string): string {
  const end = text.indexOf("\nBLOCK ")
  return end < 0 ? text : text.slice(0, end)
}

/** Why a block is not `read`, or `""` when it is. */
function reasonOf(result: AdjudicationReadResult, block: number): string {
  const found = blockOf(result, block)
  return found.kind === "read" ? "" : found.reasons.join(" ")
}

function labelledTruth(result: AdjudicationReadResult, block: number) {
  const truth = readBlock(result, block).truth
  if (truth.kind !== "labelled") throw new Error(`block ${block} truth is ${truth.kind}: ${truth.reasons.join("; ")}`)
  return truth
}

/** A complete sheet over the default block, with named labels replaced. */
function pages(schedule: PairedSchedule, options: BundleOptions = {}, over: Partial<Record<string, TruthLabel>> = {}) {
  return [1, 2, 3].map((block) =>
    pageFor(
      block,
      candidatesOf(options, block),
      (id) => over[id] ?? LABELS[id] ?? "true-defect",
      runIdOf(options, block),
    ),
  )
}

async function withDefaultSheet(options: BundleOptions = {}): Promise<{ root: string; schedule: PairedSchedule }> {
  const built = await bundleAt(options)
  await writeSheet(built.root, sheetFor(built.schedule, pages(built.schedule, options)))
  return built
}

function summaryOf(result: AdjudicationReadResult, quantity: string) {
  const found = result.summaries.find((entry) => entry.quantity === quantity)
  if (found === undefined) throw new Error(`no summary for \`${quantity}\``)
  return found
}

function directionLabel(key: DirectionKey): string {
  return DIRECTIONS.find((entry) => entry.key === key)!.label
}

async function captured(run: () => Promise<number>): Promise<{ code: number; text: string }> {
  const lines: string[] = []
  const log = console.log
  console.log = (...args: unknown[]) => void lines.push(args.join(" "))
  try {
    return { code: await run(), text: lines.join("\n") }
  } finally {
    console.log = log
  }
}

/** A result whose partition has lost a candidate, for the invariant's failing side. */
function brokenAccounting(): AdjudicationReadResult {
  const arm = (name: "on" | "off") => ({
    arm: name,
    runId: `run-${name}`,
    upheld: 0,
    falsePositives: [],
    trueDefects: [],
    truthUnresolved: [],
    labelMissing: [],
    outsidePool: [],
  })
  return {
    kind: "read",
    root: "/nowhere",
    scheduleHash: "sha256:none",
    sheet: {
      kind: "read",
      file: "/nowhere/adjudication.json",
      scheduleHash: "sha256:none",
      blocks: [],
      strayPages: [],
      rejectedPages: [],
    },
    matcher: "shipped-lexical",
    excluded: [],
    blocks: [
      {
        block: 1,
        result: {
          kind: "read",
          prefixRunId: "run-prefix-1",
          recordFile: "/nowhere/record.json",
          verdicts: { pool: 7, paired: 7, armMissing: [], undecided: [], decided: 7, unchanged: [] },
          truth: {
            kind: "labelled",
            file: "/nowhere/adjudication.json",
            prefixRunId: "run-prefix-1",
            labelCoverage: { rows: 7, of: 7 },
            directions: {
              "false-upheld-to-rejected": [],
              "true-rejected-to-upheld": [],
              "true-upheld-to-rejected": [],
              "false-rejected-to-upheld": [],
            },
            unchanged: ["c1", "c2", "c3", "c4", "c5", "c6"],
            labelMissing: [],
            truthUnresolved: [],
            unclassified: [],
            accounting: { accounted: 6, distinct: 6, pool: 7, agree: false },
            falsePositives: { on: arm("on"), off: arm("off") },
            candidates: [],
          },
        },
      },
    ],
    summaries: [],
  }
}

/**
 * A result holding the branch no shipped label can reach, for the bucket that
 * exists so a fourth truth label could not vanish into `label missing`.
 */
function unclassifiedResult(): AdjudicationReadResult {
  const base = brokenAccounting()
  const block = base.blocks[0]!.result
  if (block.kind !== "read" || block.truth.kind !== "labelled") throw new Error("the sibling fixture changed shape")
  block.verdicts = { pool: 1, paired: 1, armMissing: [], undecided: [], decided: 1, unchanged: [] }
  block.truth.unclassified = ["c1"]
  block.truth.unchanged = []
  block.truth.labelCoverage = { rows: 1, of: 1 }
  block.truth.accounting = { accounted: 1, distinct: 1, pool: 1, agree: true }
  block.truth.candidates = [
    {
      id: "c1",
      outcome: { kind: "unclassified", label: "true-defect" },
      present: ["on", "off"],
      on: "upheld",
      off: "rejected",
      label: "true-defect",
      evidence: null,
      suggested: null,
      disagreement: null,
    },
  ]
  return base
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("a complete sheet over three blocks", () => {
  test("reports the four directions, accounts for every candidate, and summarises 3/3", async () => {
    const { root } = await withDefaultSheet()
    const result = await readAt(root)

    for (const block of [1, 2, 3]) {
      const truth = labelledTruth(result, block)
      const verdicts = readBlock(result, block).verdicts
      expect(truth.directions["false-upheld-to-rejected"]).toEqual(["c1"])
      expect(truth.directions["true-rejected-to-upheld"]).toEqual(["c2"])
      expect(truth.directions["true-upheld-to-rejected"]).toEqual(["c3"])
      expect(truth.directions["false-rejected-to-upheld"]).toEqual(["c4"])
      expect(verdicts.unchanged.map((entry) => entry.id)).toEqual(["c5"])
      expect(truth.labelMissing).toEqual([])
      expect(truth.truthUnresolved).toEqual([])
      expect(verdicts.undecided.map((entry) => entry.id)).toEqual(["c6"])
      expect(verdicts.armMissing.map((entry) => entry.id)).toEqual(["c7"])
      expect(truth.accounting).toEqual({
        accounted: BLOCK.length,
        distinct: BLOCK.length,
        pool: BLOCK.length,
        agree: true,
      })
      expect(truth.candidates).toHaveLength(BLOCK.length)
      expect(new Set(truth.candidates.map((entry) => entry.id)).size).toBe(BLOCK.length)
    }

    for (const direction of DIRECTIONS) {
      const summary = summaryOf(result, direction.label)
      expect(summary.observed).toBe(3)
      expect(summary.values).toEqual([1, 1, 1])
      expect(summary.missing).toEqual([])
    }
  })

  test("names each direction's numerator and denominator, and PRINTS the accounting it checked", async () => {
    const { root } = await withDefaultSheet()
    const text = renderAdjudicationBundle(await readAt(root))
    // THE DENOMINATOR IS THE DIFFERING DECIDED PAIRS: 5 decided less the 1 both
    // arms decided the same way, which is a verdict-axis count printed above.
    expect(text).toContain("the four directions and the two label buckets divide 4 of 5 decided")
    for (const direction of DIRECTIONS) expect(text).toContain(`${direction.label}: 1 of 4`)
    expect(text).toContain("truth pool: 7 canonical candidate(s)")
    expect(text).toContain("mean 1, min 1, max 1 — descriptive over 3 available observations")
    // THE RENDERED INVARIANT, not the recomputed one: the assertions above read
    // the data structure, and the line below is what an operator actually sees.
    expect(text).toContain("unclassified + undecided + arm missing = 7 over 7 distinct id(s),")
    expect(text).toContain("and the truth pool holds 7 — they agree")
    expect(text).not.toContain("ACCOUNTING BROKEN")
  })

  /**
   * THE FAILURE BRANCH OF THE INVARIANT, over a result built by hand.
   *
   * The partition is exhaustive by construction — every candidate takes exactly
   * one branch — so no bundle on disk can make the buckets disagree with the
   * pool. That is what the check is FOR: it guards a future partition bug, and a
   * guard whose failing side nothing renders is a guard nobody would see fire.
   */
  test("a partition that does not cover its pool prints loudly instead of its own claim", () => {
    const text = renderAdjudicationBundle(brokenAccounting())
    expect(text).toContain("ACCOUNTING BROKEN")
    expect(text).toContain("The buckets sum to 6 over 6 distinct id(s), and the truth pool holds 7.")
    expect(text).toContain("Do not read them.")
    expect(text).not.toContain("they agree")
  })

  test("the four directions each hold alone, one block at a time", async () => {
    const only: Record<DirectionKey, Candidate> = {
      "false-upheld-to-rejected": { id: "only", on: "judge-ruled-invalid", off: "upheld" },
      "true-rejected-to-upheld": { id: "only", on: "upheld", off: "judge-ruled-invalid" },
      "true-upheld-to-rejected": { id: "only", on: "judge-ruled-invalid", off: "upheld" },
      "false-rejected-to-upheld": { id: "only", on: "upheld", off: "judge-ruled-invalid" },
    }
    for (const direction of DIRECTIONS) {
      const candidates = [only[direction.key]]
      const options: BundleOptions = { blocks: { 1: candidates, 2: candidates, 3: candidates } }
      const { root, schedule } = await bundleAt(options)
      await writeSheet(
        root,
        sheetFor(
          schedule,
          [1, 2, 3].map((block) => pageFor(block, candidates, () => direction.truth)),
        ),
      )
      const truth = labelledTruth(await readAt(root), 1)
      for (const other of DIRECTIONS) {
        expect(truth.directions[other.key]).toEqual(other.key === direction.key ? ["only"] : [])
      }
      await clean()
    }
  })

  /**
   * THE SUMMARY OVER VALUES THAT DIFFER. With every block observing 1, a mean, a
   * min and a max are the same number and a renderer that printed any of them
   * for all three would pass.
   */
  test("a summary whose values differ reads a reduced exact mean, with its real min and max", async () => {
    const removal = (id: string): Candidate => ({ id, on: "judge-ruled-invalid", off: "upheld" })
    const blocks = {
      1: [removal("a1")],
      2: [removal("a1"), removal("a2")],
      3: [removal("a1"), removal("a2")],
    }
    const options: BundleOptions = { blocks }
    const { root, schedule } = await bundleAt(options)
    await writeSheet(
      root,
      sheetFor(
        schedule,
        [1, 2, 3].map((block) => pageFor(block, blocks[block as 1 | 2 | 3], () => "not-a-defect")),
      ),
    )
    const result = await readAt(root)
    const summary = summaryOf(result, directionLabel("false-upheld-to-rejected"))
    expect(summary.values).toEqual([1, 2, 2])
    // 5/3 is not an integer, so a float renderer and a swapped min/max both show.
    expect(renderAdjudicationBundle(result)).toContain("mean 5/3, min 1, max 2 — descriptive over 3 available observations")
  })

  /**
   * `evaluation-protocol.md:169-173` asks for the LOST TRUE CANDIDATES to be
   * named. A capped list answers *how many* where the protocol asked *which*.
   */
  test("`true upheld → rejected` names every id; the other directions cap at five", async () => {
    const lost = (id: string): Candidate => ({ id, on: "judge-ruled-invalid", off: "upheld" })
    const added = (id: string): Candidate => ({ id, on: "upheld", off: "judge-ruled-invalid" })
    const candidates = [
      ...["t1", "t2", "t3", "t4", "t5", "t6", "t7"].map(lost),
      ...["f1", "f2", "f3", "f4", "f5", "f6", "f7"].map(added),
    ]
    const options: BundleOptions = { blocks: { 1: candidates, 2: candidates, 3: candidates } }
    const { root, schedule } = await bundleAt(options)
    await writeSheet(
      root,
      sheetFor(
        schedule,
        [1, 2, 3].map((block) => pageFor(block, candidates, (id) => (id.startsWith("t") ? "true-defect" : "not-a-defect"))),
      ),
    )
    const text = renderAdjudicationBundle(await readAt(root))
    expect(text).toContain("(`t1`, `t2`, `t3`, `t4`, `t5`, `t6`, `t7`)")
    expect(text).toContain("(`f1`, `f2`, `f3`, `f4`, `f5`, … and 2 more)")
  })
})

// ---------------------------------------------------------------------------
// Applicability
// ---------------------------------------------------------------------------

describe("what the reader is not applicable to", () => {
  test("a paired result with no sealed schedule is not applicable, and renders nothing", async () => {
    const root = await tempDir()
    await writeBundle(root, [{ armId: "pool", repeatId: 0 }], [{ armId: "pool", repeatId: 0 }])
    const paired = await pairedOf(root)
    expect(paired.bundle.sealedSchedule).toBe(false)
    const outcome = await readAdjudicationBundle(paired)
    expect(outcome.kind).toBe("not-applicable")
    expect(renderAdjudicationBundle(outcome)).toBe("")
  })

  /**
   * A SEPARATE MECHANISM, asserted separately. `eval-read` never calls this
   * reader on an ordinary bundle at all — it is inside `if (sealedSchedule)` —
   * so this test would still pass with the reader's own guard deleted, and it
   * does not stand in for the one above.
   */
  test("`eval-read` never reaches this reader on an ordinary bundle", async () => {
    const root = await tempDir()
    await writeBundle(root, [{ armId: "pool", repeatId: 0 }], [{ armId: "pool", repeatId: 0 }])
    const { code, text } = await captured(() => evalReadMain(["bun", "eval-read", "--bundle", root]))
    expect(code).toBe(0)
    expect(text).not.toContain("MAD ADJUDICATION")
  })

  /**
   * A REFUSED SCHEDULE IS NOT AN ABSENT ONE. Returning `not-applicable` here
   * would make the report vanish on a TAMPERED schedule while saying, by this
   * module's own rule, that the bundle carries no sealed schedule at all.
   */
  test("a schedule the paired reader refused keeps that refusal", async () => {
    const root = await tempDir()
    await writeBundle(root, [{ armId: "on", repeatId: 0 }], [{ armId: "on", repeatId: 0 }])
    await writeFile(join(root, SCHEDULE_FILE), JSON.stringify({ scheduleVersion: 1 }))
    const outcome = await readAdjudicationBundle(await pairedOf(root))
    expect(outcome.kind).toBe("schedule-refused")
    expect(renderAdjudicationBundle(outcome)).toContain("the paired reader refused the sealed schedule")
  })
})

// ---------------------------------------------------------------------------
// The sheet's states
// ---------------------------------------------------------------------------

describe("the sheet's states stay distinct", () => {
  test("absent — truth unavailable with `no adjudication sheet`, and the verdict counts still read", async () => {
    const { root } = await bundleAt()
    const result = await readAt(root)
    expect(result.sheet.kind).toBe("absent")
    const block = readBlock(result, 1)
    if (block.truth.kind !== "unavailable") throw new Error("expected unavailable")
    expect(block.truth.reasons.join(" ")).toContain("no adjudication sheet")
    expect(block.verdicts.undecided.map((entry) => entry.id)).toEqual(["c6"])
    expect(block.verdicts.armMissing.map((entry) => entry.id)).toEqual(["c7"])
    expect(summaryOf(result, "undecided transitions").observed).toBe(3)
    expect(summaryOf(result, "candidates missing from an arm").observed).toBe(3)
    for (const direction of DIRECTIONS) expect(summaryOf(result, direction.label).observed).toBe(0)

    const text = renderAdjudicationBundle(result)
    expect(text).toContain("NO TRUTH SHEET")
    expect(text).toContain("unavailable — no complete observation")
  })

  /** A sheet this process could not open is NOT a sheet nobody wrote. */
  test("unreadable — its own state and its own banner, never the absent one", async () => {
    const { root } = await bundleAt()
    await mkdir(join(root, ADJUDICATION_SHEET_FILE), { recursive: true })
    const result = await readAt(root)
    if (result.sheet.kind !== "unreadable") throw new Error(`expected unreadable, got ${result.sheet.kind}`)
    expect(result.sheet.why).toContain("could not be read")
    const text = renderAdjudicationBundle(result)
    expect(text).toContain("THE TRUTH SHEET COULD NOT BE READ")
    expect(text).not.toContain("NO TRUTH SHEET")
  })

  test("malformed — text that is not JSON at all", async () => {
    const { root } = await bundleAt()
    await writeSheet(root, "{ not json")
    const result = await readAt(root)
    if (result.sheet.kind !== "malformed") throw new Error(`expected malformed, got ${result.sheet.kind}`)
    expect(result.sheet.why).toContain("it is not JSON")
  })

  test("malformed — JSON that is not an object, named as such and distinct from absent", async () => {
    const { root } = await bundleAt()
    await writeSheet(root, "[]")
    const result = await readAt(root)
    if (result.sheet.kind !== "malformed") throw new Error(`expected malformed, got ${result.sheet.kind}`)
    expect(result.sheet.why).toContain("not a JSON object")
    expect(renderAdjudicationBundle(result)).toContain("THE TRUTH SHEET IS MALFORMED")
  })

  test("malformed — a version this reader does not know, naming the field", async () => {
    const { root, schedule } = await bundleAt()
    await writeSheet(root, sheetFor(schedule, pages(schedule), { adjudicationSheetVersion: 99 }))
    const result = await readAt(root)
    if (result.sheet.kind !== "malformed") throw new Error(`expected malformed, got ${result.sheet.kind}`)
    expect(result.sheet.why).toContain("`adjudicationSheetVersion` is 99")
    expect(result.sheet.why).toContain(String(ADJUDICATION_SHEET_VERSION))
    expect(readBlock(result, 1).truth.kind).toBe("unavailable")
  })

  /**
   * THE SHEET'S OWN IDENTITY. A document whose schedule binding or `blocks` list
   * cannot be read has no pages to isolate, so these stay whole-sheet.
   */
  const malformed: { name: string; sheet: (schedule: PairedSchedule) => unknown; why: string }[] = [
    {
      name: "no `scheduleHash`",
      sheet: (schedule) => sheetFor(schedule, pages(schedule), { scheduleHash: 7 }),
      why: "no string `scheduleHash`",
    },
    {
      name: "`blocks` is not a list",
      sheet: (schedule) => sheetFor(schedule, pages(schedule), { blocks: {} }),
      why: "no `blocks` list",
    },
  ]
  for (const entry of malformed) {
    test(`malformed — ${entry.name}`, async () => {
      const { root, schedule } = await bundleAt()
      await writeSheet(root, entry.sheet(schedule))
      const result = await readAt(root)
      if (result.sheet.kind !== "malformed") throw new Error(`expected malformed, got ${result.sheet.kind}`)
      expect(result.sheet.why).toContain(entry.why)
      expect(readBlock(result, 1).truth.kind).toBe("unavailable")
    })
  }

  /**
   * ONE BAD PAGE WITHDRAWS ONE BLOCK. Each of these used to return `malformed`
   * for the WHOLE sheet, so a typo in block 1's page took the correctly filled
   * truth labels of blocks 2 and 3 with it. Every case below carries all three
   * pages and asserts that the other two still read their four directions —
   * the isolation is the claim, not just the reason string.
   */
  const rejectedPage: { name: string; sheet: (schedule: PairedSchedule) => unknown; why: string }[] = [
    {
      name: "`blocks[0]` is not an object",
      sheet: (schedule) => sheetFor(schedule, [5 as unknown as SheetBlockInput, ...pages(schedule).slice(1)]),
      why: "`blocks[0]` is not an object",
    },
    {
      name: "`blocks[0].prefixRunId` is not a string",
      sheet: (schedule) =>
        sheetFor(schedule, [
          { ...pages(schedule)[0]!, prefixRunId: 7 as unknown as string },
          ...pages(schedule).slice(1),
        ]),
      why: "`blocks[0].prefixRunId` is not a string",
    },
    {
      name: "`blocks[0].rows` is not a list",
      sheet: (schedule) =>
        sheetFor(schedule, [{ ...pages(schedule)[0]!, rows: "none" as unknown as [] }, ...pages(schedule).slice(1)]),
      why: "`blocks[0].rows` is not a list",
    },
    {
      name: "`blocks[0].rows[0]` is not an object",
      sheet: (schedule) =>
        sheetFor(schedule, [{ ...pages(schedule)[0]!, rows: [null as unknown as never] }, ...pages(schedule).slice(1)]),
      why: "`blocks[0].rows[0]` is not an object",
    },
    {
      name: "`rows[0].candidateId` is not a string",
      sheet: (schedule) =>
        sheetFor(schedule, [
          { ...pages(schedule)[0]!, rows: [{ candidateId: 1 as unknown as string, truth: "true-defect" }] },
          ...pages(schedule).slice(1),
        ]),
      why: "`blocks[0].rows[0].candidateId` is not a string",
    },
    {
      name: "`rows[0].evidence` is present and not a string",
      sheet: (schedule) =>
        sheetFor(schedule, [
          { ...pages(schedule)[0]!, rows: [{ candidateId: "c1", truth: "true-defect", evidence: 3 as unknown as string }] },
          ...pages(schedule).slice(1),
        ]),
      why: "`blocks[0].rows[0].evidence` is present and is not a string",
    },
    {
      name: "a label outside the three, naming the row and the value",
      sheet: (schedule) =>
        sheetFor(schedule, [
          { ...pages(schedule)[0]!, rows: [{ candidateId: "c1", truth: "probably-fine" as TruthLabel }] },
          ...pages(schedule).slice(1),
        ]),
      why: "probably-fine",
    },
    {
      name: "two pages for one block, and neither is chosen",
      sheet: (schedule) => sheetFor(schedule, [pages(schedule)[0]!, ...pages(schedule)]),
      why: "choosing between them would publish labels nobody agreed on",
    },
  ]
  for (const entry of rejectedPage) {
    test(`one page rejected, the others read — ${entry.name}`, async () => {
      const { root, schedule } = await bundleAt()
      await writeSheet(root, entry.sheet(schedule))
      const result = await readAt(root)
      if (result.sheet.kind !== "read") throw new Error(`expected read, got ${result.sheet.kind}`)

      const first = readBlock(result, 1).truth
      if (first.kind !== "unavailable") throw new Error(`expected unavailable, got ${first.kind}`)
      expect(first.reasons.join(" ")).toContain("carries no valid page for block 1")
      expect(first.reasons.join(" ")).toContain(entry.why)

      for (const block of [2, 3]) {
        expect(labelledTruth(result, block).directions["false-upheld-to-rejected"]).toEqual(["c1"])
      }
      for (const direction of DIRECTIONS) expect(summaryOf(result, direction.label).observed).toBe(2)
    })
  }

  test("a candidate with no row is `label missing`, and one labelled `unresolved` is its own bucket", async () => {
    const { root, schedule } = await bundleAt()
    const page = pageFor(1, BLOCK, (id) => (id === "c2" ? "unresolved" : LABELS[id]!))
    await writeSheet(
      root,
      sheetFor(schedule, [{ ...page, rows: page.rows.filter((row) => row.candidateId !== "c1") }, ...pages(schedule).slice(1)]),
    )
    const truth = labelledTruth(await readAt(root), 1)
    expect(truth.labelMissing).toEqual(["c1"])
    expect(truth.truthUnresolved).toEqual(["c2"])
    expect(truth.directions["false-upheld-to-rejected"]).toEqual([])
    expect(truth.directions["true-rejected-to-upheld"]).toEqual([])
    expect(truth.labelCoverage).toEqual({ rows: BLOCK.length - 1, of: BLOCK.length })
    expect(truth.accounting.agree).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

describe("the sheet is bound like evidence", () => {
  test("a `scheduleHash` from another plan refuses the sheet, naming both", async () => {
    const { root, schedule } = await bundleAt()
    await writeSheet(root, sheetFor(schedule, pages(schedule), { scheduleHash: "sha256:someone-elses-plan" }))
    const result = await readAt(root)
    if (result.sheet.kind !== "refused") throw new Error(`expected refused, got ${result.sheet.kind}`)
    expect(result.sheet.why).toContain("sha256:someone-elses-plan")
    expect(result.sheet.why).toContain(schedule.scheduleHash)
    expect(readBlock(result, 1).truth.kind).toBe("refused")
  })

  /** A hand-placed file is where a symlink out of the bundle is the easy mistake. */
  test("a sheet resolving outside the bundle root is refused, naming the real path", async () => {
    const { root, schedule } = await bundleAt()
    const elsewhere = await tempDir()
    const target = join(elsewhere, "someone-elses-sheet.json")
    await writeFile(target, JSON.stringify(sheetFor(schedule, pages(schedule))))
    await symlink(target, join(root, ADJUDICATION_SHEET_FILE))
    const result = await readAt(root)
    if (result.sheet.kind !== "refused") throw new Error(`expected refused, got ${result.sheet.kind}`)
    expect(result.sheet.why).toContain("is not inside the bundle root")
    expect(result.sheet.why).toContain("someone-elses-sheet.json")
    expect(readBlock(result, 1).truth.kind).toBe("refused")
  })

  test("a `prefixRunId` naming another block's prefix run refuses that block, naming both", async () => {
    const { root, schedule } = await bundleAt()
    const page = pageFor(1, BLOCK, (id) => LABELS[id]!, "run-prefix-2")
    await writeSheet(root, sheetFor(schedule, [page, ...pages(schedule).slice(1)]))
    const result = await readAt(root)
    const truth = readBlock(result, 1).truth
    if (truth.kind !== "refused") throw new Error(`expected refused, got ${truth.kind}`)
    expect(truth.reasons.join(" ")).toContain("`run-prefix-2`")
    expect(truth.reasons.join(" ")).toContain("`run-prefix-1`")
    for (const direction of DIRECTIONS) {
      const summary = summaryOf(result, direction.label)
      expect(summary.observed).toBe(2)
      expect(summary.missing.map((gap) => gap.block)).toEqual([1])
    }
    expect(labelledTruth(result, 2).directions["false-upheld-to-rejected"]).toEqual(["c1"])
  })

  /**
   * ONE TYPO WITHDRAWS ONE BLOCK. A page naming an unplanned block used to make
   * the whole sheet malformed, which took the truth labels of the two blocks
   * that were filled in correctly with it.
   */
  test("a page naming no planned block refuses itself, and the other blocks still read", async () => {
    const { root, schedule } = await bundleAt()
    const all = pages(schedule)
    await writeSheet(root, sheetFor(schedule, [all[0]!, all[1]!, { ...all[2]!, block: 9 }]))
    const result = await readAt(root)
    if (result.sheet.kind !== "read") throw new Error(`expected read, got ${result.sheet.kind}`)
    expect(result.sheet.strayPages).toEqual([{ at: 2, block: "9" }])

    expect(labelledTruth(result, 1).directions["false-upheld-to-rejected"]).toEqual(["c1"])
    expect(labelledTruth(result, 2).directions["false-upheld-to-rejected"]).toEqual(["c1"])
    const third = readBlock(result, 3).truth
    if (third.kind !== "unavailable") throw new Error(`expected unavailable, got ${third.kind}`)
    expect(third.reasons.join(" ")).toContain("carries no valid page for block 3")
    expect(third.reasons.join(" ")).toContain("`blocks[2].block` = 9")

    const text = renderAdjudicationBundle(result)
    expect(text).toContain("SHEET PAGES NAMING NO PLANNED BLOCK")
    expect(text).toContain("The schedule plans 1, 2, 3.")
    for (const direction of DIRECTIONS) expect(summaryOf(result, direction.label).observed).toBe(2)
  })

  test("two rows for one candidate refuse the block, naming the id — never overwritten, never dropped", async () => {
    const { root, schedule } = await bundleAt()
    const page = pageFor(1, BLOCK, (id) => LABELS[id]!)
    await writeSheet(
      root,
      sheetFor(schedule, [
        { ...page, rows: [...page.rows, { candidateId: "c3", truth: "not-a-defect" }] },
        ...pages(schedule).slice(1),
      ]),
    )
    const truth = readBlock(await readAt(root), 1).truth
    if (truth.kind !== "refused") throw new Error(`expected refused, got ${truth.kind}`)
    expect(truth.reasons.join(" ")).toContain("`c3`")
    expect(truth.reasons.join(" ")).toContain("more than one row")
  })

  test("a row for an id the prefix pool does not hold refuses the block, naming the id", async () => {
    const { root, schedule } = await bundleAt()
    const page = pageFor(1, BLOCK, (id) => LABELS[id]!)
    await writeSheet(
      root,
      sheetFor(schedule, [
        { ...page, rows: [...page.rows, { candidateId: "not-in-this-pool", truth: "true-defect" }] },
        ...pages(schedule).slice(1),
      ]),
    )
    const truth = readBlock(await readAt(root), 1).truth
    if (truth.kind !== "refused") throw new Error(`expected refused, got ${truth.kind}`)
    expect(truth.reasons.join(" ")).toContain("`not-in-this-pool`")
  })

  test("a label outside the three rejects its page, naming the row, the value and the three it knows", async () => {
    const { root, schedule } = await bundleAt()
    await writeSheet(
      root,
      sheetFor(schedule, [
        { block: 1, prefixRunId: runIdOf({}, 1), rows: [{ candidateId: "c1", truth: "probably-fine" as TruthLabel }] },
        ...pages(schedule).slice(1),
      ]),
    )
    const result = await readAt(root)
    if (result.sheet.kind !== "read") throw new Error(`expected read, got ${result.sheet.kind}`)
    const why = result.sheet.rejectedPages.map((page) => page.why).join(" ")
    expect(why).toContain("`c1`")
    expect(why).toContain("probably-fine")
    for (const label of TRUTH_LABELS) expect(why).toContain(label)
    expect(result.sheet.rejectedPages.map((page) => page.block)).toEqual([1])
  })
})

// ---------------------------------------------------------------------------
// The prefix record the truth pool comes from
// ---------------------------------------------------------------------------

describe("the truth pool is the prefix record's canonical findings", () => {
  const broken: { name: string; mutate: (record: Record<string, unknown>) => void; why: string }[] = [
    { name: "`findings` absent", mutate: (record) => delete record.findings, why: "`findings` is not a list" },
    { name: "`findings` is not a list", mutate: (record) => (record.findings = {}), why: "`findings` is not a list" },
    {
      name: "a `findings` entry with no id",
      mutate: (record) => delete (record.findings as Record<string, unknown>[])[0]!.id,
      why: "`findings[0]` has no string `id`",
    },
    {
      name: "a `findings` entry that is not an object",
      mutate: (record) => ((record.findings as unknown[])[1] = 5),
      why: "`findings[1]` is not an object",
    },
    {
      // WITHOUT THIS REFUSAL one candidate is walked twice and the report prints
      // `2 of 2 decided` for one finding.
      name: "two entries with one id",
      mutate: (record) => {
        const findings = record.findings as Record<string, unknown>[]
        findings.push({ ...findings[0]! })
      },
      why: "`findings` carries two entries with id `c1`",
    },
  ]
  for (const entry of broken) {
    test(`a block whose ${entry.name} is unavailable, naming the field`, async () => {
      const { root, schedule } = await bundleAt({
        recordOver: (record, block) => {
          if (block === 1) entry.mutate(record)
        },
      })
      await writeSheet(root, sheetFor(schedule, pages(schedule)))
      const result = await readAt(root)
      const block = blockOf(result, 1)
      if (block.kind !== "unavailable") throw new Error(`expected unavailable, got ${block.kind}`)
      expect(block.reasons.join(" ")).toContain(entry.why)
      // The other two blocks are untouched.
      expect(labelledTruth(result, 2).directions["false-upheld-to-rejected"]).toEqual(["c1"])
    })
  }

  test("a block with no `record.json` at all is unavailable", async () => {
    const { root, schedule } = await bundleAt({ noRecord: [1] })
    await writeSheet(root, sheetFor(schedule, pages(schedule)))
    const result = await readAt(root)
    const block = blockOf(result, 1)
    if (block.kind !== "unavailable") throw new Error(`expected unavailable, got ${block.kind}`)
    expect(block.reasons.join(" ")).toContain("could not be resolved")
  })

  /**
   * A RECORD BOUND TO SOMETHING ELSE IS REFUSED, not unavailable. Folding the two
   * printed a record bound to another run under the same heading as a missing
   * file — the collapse this module argues against one level down.
   */
  test("a record whose `runId` is another run's refuses the block, distinct from unavailable", async () => {
    const { root, schedule } = await bundleAt({
      recordOver: (record, block) => {
        if (block === 1) record.runId = "run-somewhere-else"
      },
    })
    await writeSheet(root, sheetFor(schedule, pages(schedule)))
    const result = await readAt(root)
    const block = blockOf(result, 1)
    if (block.kind !== "refused") throw new Error(`expected refused, got ${block.kind}`)
    expect(block.reasons.join(" ")).toContain("run-somewhere-else")
    expect(block.reasons.join(" ")).toContain("run-prefix-1")
    expect(renderAdjudicationBundle(result)).toContain("  REFUSED:")
  })

  /**
   * THE ISOLATION RUNS BOTH WAYS. CAP-1 and CAP-11 score `pool`; this report
   * scores `findings`. A malformed `pool` must not take a truth pool down with
   * it, any more than a malformed `findings` withholds CAP-1.
   *
   * The CAP-1 half of the pair lives in `labelled-read.test.ts`, over a bundle
   * that is the sealed labelled change: `MALFORMED RECORD: \`pool\`` holds the
   * withholding, and `a malformed \`findings\` leaves CAP-1 and CAP-11 whole`
   * holds the other direction.
   */
  test("a malformed `pool` leaves the adjudication report whole", async () => {
    const { root, schedule } = await bundleAt({
      recordOver: (record, block) => {
        if (block === 1) record.pool = 5
      },
    })
    await writeSheet(root, sheetFor(schedule, pages(schedule)))
    const truth = labelledTruth(await readAt(root), 1)
    expect(truth.directions["false-upheld-to-rejected"]).toEqual(["c1"])
    expect(truth.accounting.agree).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The undecided axis
// ---------------------------------------------------------------------------

describe("the three non-decisive states are never rejected", () => {
  for (const state of ["not-adjudicated", "unresolved", "unjudged"] as const) {
    test(`\`${state}\` on one side is undecided, counted under its own name`, async () => {
      const candidates: Candidate[] = [{ id: "c1", on: state, off: "upheld" }]
      const options: BundleOptions = { blocks: { 1: candidates, 2: candidates, 3: candidates } }
      const { root, schedule } = await bundleAt(options)
      await writeSheet(
        root,
        sheetFor(
          schedule,
          [1, 2, 3].map((block) => pageFor(block, candidates, () => "not-a-defect")),
        ),
      )
      const result = await readAt(root)
      const block = readBlock(result, 1)
      expect(block.verdicts.undecided).toEqual([{ id: "c1", on: state, off: "upheld" }])
      expect(block.verdicts.decided).toBe(0)
      // The trap: `upheld → not-adjudicated` read as successful noise removal.
      const truth = labelledTruth(result, 1)
      for (const direction of DIRECTIONS) expect(truth.directions[direction.key]).toEqual([])
      expect(truth.unchanged).toEqual([])
      expect(renderAdjudicationBundle(result)).toContain(`on ${state}, off upheld (verdict axis)`)
      await clean()
    })
  }

  test("`verdictBucket` maps the six states to five buckets and never calls an absence rejected", () => {
    expect(verdictBucket("upheld")).toBe("upheld")
    expect(verdictBucket("withdrawn-by-author")).toBe("rejected")
    expect(verdictBucket("judge-ruled-invalid")).toBe("rejected")
    expect(verdictBucket("not-adjudicated")).toBe("not-adjudicated")
    expect(verdictBucket("unresolved")).toBe("unresolved")
    expect(verdictBucket("unjudged")).toBe("unjudged")
  })

  test("`withdrawn-by-author` is a rejection, so an OFF-upheld true defect lost that way is a harmful loss", async () => {
    const truth = labelledTruth(await readAt((await withDefaultSheet()).root), 1)
    expect(truth.directions["true-upheld-to-rejected"]).toEqual(["c3"])
    expect(BLOCK.find((entry) => entry.id === "c3")!.on).toBe("withdrawn-by-author")
  })
})

// ---------------------------------------------------------------------------
// Missing arms, withheld blocks, shared prefixes, spread
// ---------------------------------------------------------------------------

describe("what is not a transition, and what is not an observation", () => {
  test("a candidate only ON raised is missing, with the side named", async () => {
    const result = await readAt((await withDefaultSheet()).root)
    const block = readBlock(result, 1)
    expect(block.verdicts.armMissing).toEqual([{ id: "c7", present: ["on"] }])
    expect(labelledTruth(result, 1).candidates.find((entry) => entry.id === "c7")!.outcome).toEqual({ kind: "arm-missing" })
    expect(renderAdjudicationBundle(result)).toContain("`c7` — raised only by on")
  })

  test("a withheld block contributes nothing, and every quantity reads 2/3 with its reason", async () => {
    const { root, schedule } = await bundleAt()
    await writeSheet(root, sheetFor(schedule, pages(schedule)))
    // Removing block 3's prefix evidence is what the PAIRED reader withholds on.
    await rm(join(root, PREFIX_DIRECTORY, "2"), { recursive: true, force: true })
    const result = await readAt(root)
    const third = blockOf(result, 3)
    if (third.kind !== "unavailable") throw new Error("expected block 3 to be unavailable")
    expect(third.reasons.join(" ")).toContain("the paired block is withheld")
    for (const direction of DIRECTIONS) {
      const summary = summaryOf(result, direction.label)
      expect(summary.observed).toBe(2)
      expect(summary.of).toBe(3)
      expect(summary.missing.map((gap) => gap.block)).toEqual([3])
      expect(summary.missing[0]!.reason).toContain("withheld")
    }
    expect(renderAdjudicationBundle(result)).toContain("descriptive over 2 available observations")
  })

  /**
   * ONE PREFIX RUN IS ONE OBSERVATION. Two blocks over one discovery pass are not
   * two samples of run-to-run variability, and counting them twice would publish
   * a spread over a pass compared with itself.
   */
  test("two blocks naming one prefix run supply one value, and the second names that reason", async () => {
    const options: BundleOptions = { prefixRunIds: { 2: "run-prefix-1" } }
    const { root, schedule } = await bundleAt(options)
    await writeSheet(root, sheetFor(schedule, pages(schedule, options)))
    const result = await readAt(root)
    expect(readBlock(result, 1).prefixRunId).toBe("run-prefix-1")
    expect(readBlock(result, 2).prefixRunId).toBe("run-prefix-1")
    for (const quantity of result.summaries) {
      expect(quantity.observed).toBe(2)
      const gap = quantity.missing.find((entry) => entry.block === 2)
      expect(gap?.reason).toContain("a shared prefix is one observation")
    }
  })

  test("one complete observation reads its value and `spread unavailable`", async () => {
    const { root, schedule } = await bundleAt()
    await writeSheet(root, sheetFor(schedule, [pages(schedule)[0]!]))
    const result = await readAt(root)
    const summary = summaryOf(result, directionLabel("false-upheld-to-rejected"))
    expect(summary.observed).toBe(1)
    expect(summary.values).toEqual([1])
    expect(renderAdjudicationBundle(result)).toContain("value 1; spread unavailable")
  })

  test("zero observations read unavailable and never 0", async () => {
    const { root } = await bundleAt()
    const text = renderAdjudicationBundle(await readAt(root))
    for (const direction of DIRECTIONS) expect(text).toContain(`${direction.label}: observed 0/3`)
    expect(text).toContain("unavailable — no complete observation")
    expect(text).not.toContain("value 0; spread unavailable")
  })
})

// ---------------------------------------------------------------------------
// False positives
// ---------------------------------------------------------------------------

describe("false positives, per arm, with the denominator named", () => {
  test("count only upheld findings the sheet calls not-a-defect", async () => {
    const result = await readAt((await withDefaultSheet()).root)
    const truth = labelledTruth(result, 1)
    // ON upheld c2, c4, c5, c7; only c4 is not-a-defect.
    expect(truth.falsePositives.on.upheld).toBe(4)
    expect(truth.falsePositives.on.falsePositives).toEqual(["c4"])
    // OFF upheld c1, c3, c5, c6; only c1 is not-a-defect.
    expect(truth.falsePositives.off.upheld).toBe(4)
    expect(truth.falsePositives.off.falsePositives).toEqual(["c1"])
    expect(renderAdjudicationBundle(result)).toContain(
      "arm on, run `run-on-0`: 1 of 4 upheld finding(s) are known false positives (`c4`)",
    )
  })

  test("an unlabelled upheld finding is `label missing`, never a false positive by default", async () => {
    const { root, schedule } = await bundleAt()
    const page = pageFor(1, BLOCK, (id) => LABELS[id]!)
    await writeSheet(
      root,
      sheetFor(schedule, [{ ...page, rows: page.rows.filter((row) => row.candidateId !== "c4") }, ...pages(schedule).slice(1)]),
    )
    const on = labelledTruth(await readAt(root), 1).falsePositives.on
    expect(on.falsePositives).toEqual([])
    expect(on.labelMissing).toEqual(["c4"])
    expect(on.upheld).toBe(4)
  })

  test("an upheld finding labelled `unresolved` is truth-unresolved, not a false positive", async () => {
    const { root, schedule } = await bundleAt()
    await writeSheet(root, sheetFor(schedule, pages(schedule, {}, { c4: "unresolved" })))
    const on = labelledTruth(await readAt(root), 1).falsePositives.on
    expect(on.falsePositives).toEqual([])
    expect(on.truthUnresolved).toEqual(["c4"])
  })

  /**
   * An upheld id the prefix pool does not hold has NO LABEL SLOT — the pool is
   * the prefix's and the sheet covers exactly it — so it is counted apart rather
   * than defaulted into either column.
   */
  test("an upheld id the prefix pool does not hold is counted apart and named", async () => {
    const options: BundleOptions = { armExtras: [{ id: "x1", verdict: "upheld" }] }
    const { root, schedule } = await bundleAt(options)
    await writeSheet(root, sheetFor(schedule, pages(schedule, options)))
    const result = await readAt(root)
    const on = labelledTruth(result, 1).falsePositives.on
    expect(on.outsidePool).toEqual(["x1"])
    expect(on.falsePositives).toEqual(["c4"])
    expect(on.labelMissing).toEqual([])
    expect(on.upheld).toBe(5)
    expect(renderAdjudicationBundle(result)).toContain("upheld ids the prefix pool does not hold")
  })
})

// ---------------------------------------------------------------------------
// The matcher suggests and never labels
// ---------------------------------------------------------------------------

describe("a planted-label match is suggested evidence, never a truth label", () => {
  const nothingMatches: DefectMatcher = () => false
  const everythingMatches: DefectMatcher = () => true
  const throws: DefectMatcher = () => {
    throw new Error("the injected matcher threw")
  }

  const strip = (result: AdjudicationReadResult) =>
    result.blocks.map((block) => {
      if (block.result.kind !== "read" || block.result.truth.kind !== "labelled") return null
      const truth = block.result.truth
      return {
        directions: truth.directions,
        unchanged: truth.unchanged,
        labelMissing: truth.labelMissing,
        truthUnresolved: truth.truthUnresolved,
        falsePositives: truth.falsePositives,
        accounting: truth.accounting,
        labels: truth.candidates.map((entry) => [entry.id, entry.label] as const),
      }
    })

  test("an injected negative matcher changes no truth label and no count", async () => {
    const { root } = await withDefaultSheet()
    const shipped = await readAt(root)
    const injected = await readAt(root, nothingMatches)
    expect(injected.matcher).toBe("injected")
    expect(strip(injected)).toEqual(strip(shipped))
    expect(JSON.stringify(injected.summaries)).toBe(JSON.stringify(shipped.summaries))

    const suggested = (result: AdjudicationReadResult) =>
      labelledTruth(result, 1)
        .candidates.filter((entry) => entry.suggested !== null)
        .map((entry) => entry.id)
    expect(suggested(shipped)).toEqual(["c1"])
    expect(suggested(injected)).toEqual([])
  })

  test("a matcher that throws withholds the suggestions and moves no count", async () => {
    const { root } = await withDefaultSheet()
    const shipped = await readAt(root)
    const thrown = await readAt(root, throws)
    expect(strip(thrown)).toEqual(strip(shipped))
    expect(labelledTruth(thrown, 1).candidates.every((entry) => entry.suggested === null)).toBe(true)
  })

  test("a `not-a-defect` label contradicting the matcher is KEPT, and the association is printed", async () => {
    // `c1` carries `sql-injection`'s locus and marker, and the sheet calls it not-a-defect.
    const result = await readAt((await withDefaultSheet()).root)
    const account = labelledTruth(result, 1).candidates.find((entry) => entry.id === "c1")!
    expect(account.label).toBe("not-a-defect")
    expect(account.suggested).toBe("sql-injection")
    expect(account.disagreement).toContain("the human label is kept")
    expect(account.outcome).toEqual({ kind: "transition", direction: "false-upheld-to-rejected" })
    const text = renderAdjudicationBundle(result)
    expect(text).toContain("THE SHEET DISAGREES WITH THE MATCHER")
    expect(text).toContain("sql-injection")
    // The suggestion column exists for the agreeing rows too, which is what makes
    // the contradicting ones checkable against something.
    expect(text).toContain("LABEL, EVIDENCE AND SUGGESTION, PER CANDIDATE")
    expect(text).toContain("`c1`: label not-a-defect, suggestion `sql-injection`")
    expect(text).toContain("`c2`: label true-defect, suggestion none")
  })

  /** `unresolved` against a matched planted defect is a contradiction too. */
  test("an `unresolved` label contradicting the matcher is reported as a disagreement", async () => {
    const { root, schedule } = await bundleAt()
    await writeSheet(root, sheetFor(schedule, pages(schedule, {}, { c1: "unresolved" })))
    const result = await readAt(root)
    const account = labelledTruth(result, 1).candidates.find((entry) => entry.id === "c1")!
    expect(account.label).toBe("unresolved")
    expect(account.suggested).toBe("sql-injection")
    expect(account.disagreement).toContain("labels it unresolved")
    expect(account.outcome).toEqual({ kind: "truth-unresolved" })
    expect(renderAdjudicationBundle(result)).toContain("THE SHEET DISAGREES WITH THE MATCHER")
  })

  test("a candidate with no row is no contradiction — nobody labelled it", async () => {
    const { root, schedule } = await bundleAt()
    const page = pageFor(1, BLOCK, (id) => LABELS[id]!)
    await writeSheet(
      root,
      sheetFor(schedule, [{ ...page, rows: page.rows.filter((row) => row.candidateId !== "c1") }, ...pages(schedule).slice(1)]),
    )
    const account = labelledTruth(await readAt(root), 1).candidates.find((entry) => entry.id === "c1")!
    expect(account.label).toBeNull()
    expect(account.suggested).toBe("sql-injection")
    expect(account.disagreement).toBeNull()
  })

  test("a matcher that claims everything still labels nothing", async () => {
    const { root, schedule } = await bundleAt()
    await writeSheet(root, sheetFor(schedule, pages(schedule, {}, { c1: "not-a-defect", c4: "not-a-defect" })))
    const truth = labelledTruth(await readAt(root, everythingMatches), 1)
    expect(truth.directions["false-upheld-to-rejected"]).toEqual(["c1"])
    expect(truth.directions["false-rejected-to-upheld"]).toEqual(["c4"])
    expect(truth.candidates.every((entry) => entry.label === LABELS[entry.id] || entry.label === "not-a-defect")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

/**
 * What the review of 2026-09-18 changed, each claim with the assertion that
 * would have caught it going the other way.
 */
describe("the report's states and rates say what they mean", () => {
  /**
   * A BROKEN LINK IS NOT AN ABSENT SHEET. `realpath` cannot resolve one and does
   * not call that a containment failure, so without its own check the reader
   * fell through to `ENOENT` and printed the banner saying nobody wrote a sheet.
   * Somebody wrote one; it points at nothing.
   */
  test("a sheet that is a symlink to nothing is unreadable, never absent", async () => {
    const { root } = await bundleAt()
    const elsewhere = await tempDir()
    await symlink(join(elsewhere, "never-written.json"), join(root, ADJUDICATION_SHEET_FILE))
    const result = await readAt(root)
    if (result.sheet.kind !== "unreadable") throw new Error(`expected unreadable, got ${result.sheet.kind}`)
    expect(result.sheet.why).toContain("resolves to nothing")
    const text = renderAdjudicationBundle(result)
    expect(text).toContain("THE TRUTH SHEET COULD NOT BE READ")
    expect(text).not.toContain("NO TRUTH SHEET")
  })

  /** `0 of 0` is not a rate. The house helper says so and this report now uses it. */
  test("a block with nothing to divide by prints `not measurable`, never `0 of 0`", async () => {
    const lonely: Candidate[] = [{ id: "only", on: "upheld", off: null }]
    const { root, schedule } = await bundleAt({ blocks: { 1: lonely, 2: lonely, 3: lonely } })
    await writeSheet(
      root,
      sheetFor(
        schedule,
        [1, 2, 3].map((block) => pageFor(block, lonely, () => "true-defect", `run-prefix-${block}`)),
      ),
    )
    const result = await readAt(root)
    expect(readBlock(result, 1).verdicts.decided).toBe(0)
    const text = renderAdjudicationBundle(result)
    expect(text).toContain("not measurable (0 cases)")
    expect(text).not.toContain(" 0 of 0")
  })

  /** The column `ADJUDICATION.md` calls the one that makes a label checkable. */
  test("a row's `evidence` reaches the report", async () => {
    const { root, schedule } = await bundleAt()
    const page = pageFor(1, BLOCK, (id) => LABELS[id]!)
    await writeSheet(
      root,
      sheetFor(schedule, [
        {
          ...page,
          rows: page.rows.map((row) =>
            row.candidateId === "c1" ? { ...row, evidence: "the rate is validated on line 12" } : row,
          ),
        },
        ...pages(schedule).slice(1),
      ]),
    )
    const result = await readAt(root)
    const account = labelledTruth(result, 1).candidates.find((entry) => entry.id === "c1")!
    expect(account.evidence).toBe("the rate is validated on line 12")
    expect(renderAdjudicationBundle(result)).toContain("evidence: the rate is validated on line 12")
  })

  /**
   * An arm the paired reader refused to bind is named here too. Without it this
   * report prints per-arm counts with no notice that an arm is missing from the
   * comparison, one screen under a labelled report that does say so.
   */
  test("an arm the paired reader did not bind is named in this report", async () => {
    const { root } = await withDefaultSheet({
      armOver: (spec) =>
        spec.block === 3 && spec.arm === "off"
          ? { ...spec, over: { ...spec.over, fixtureHash: known("sha256:not-the-sealed-one") } }
          : spec,
    })
    const result = await readAt(root)
    expect(result.excluded.length).toBeGreaterThan(0)
    expect(renderAdjudicationBundle(result)).toContain("ARMS THE PAIRED READER DID NOT BIND")
  })

  /**
   * A cancelled prefix holds whatever discovery reached, so the truth pool is a
   * partial one. Nothing is withheld — the counts are true of the pool that
   * exists — but a pool the operator believes is complete is the one way these
   * denominators mislead.
   */
  test("a cancelled prefix run is named, and the counts still read", async () => {
    const { root } = await withDefaultSheet({
      recordOver: (record, block) => {
        if (block === 1) record.cancelled = { stage: "discover" }
      },
    })
    const result = await readAt(root)
    const block = readBlock(result, 1)
    if (block.kind !== "read") throw new Error(`expected read, got ${block.kind}`)
    expect(block.cancelledAt).toBe("discover")
    expect(labelledTruth(result, 1).directions["false-upheld-to-rejected"]).toEqual(["c1"])
    expect(renderAdjudicationBundle(result)).toContain("THE PREFIX RUN WAS CANCELLED AT `discover`")
  })

  /**
   * A REJECTED PAGE IS NAMED EVEN WHEN NO BLOCK REPORTS ONE MISSING.
   *
   * A page naming a KNOWN block always leaves that block without one, so its
   * reason renders in the block section only if that block reaches the truth
   * half — and `readBlock` returns before it for a withheld paired block, a
   * missing `on`/`off` pair, a prefix record absent or bound elsewhere, and a
   * record whose canonical pool will not parse. A page carrying NO readable
   * block number leaves no block short of a page at all, so when all three read
   * it reaches nothing anywhere. Each case below would print nothing about the
   * discarded page without the sheet-level section, and each asserts the REASON,
   * not only that some line mentions the index.
   */
  const silent: {
    name: string
    reaches: RegExp
    block: number
    /** The block the rejected page named, or `null` when it carried no readable one. */
    names: number | null
    build: () => Promise<{ root: string; at: number }>
  }[] = [
    {
      name: "the block's prefix record is missing, so the truth half is never reached",
      reaches: /the prefix record is unavailable/,
      block: 1,
      names: 1,
      build: async () => {
        const { root, schedule } = await bundleAt({ noRecord: [1] })
        await writeSheet(
          root,
          sheetFor(schedule, [
            { ...pages(schedule)[0]!, rows: "none" as unknown as [] },
            ...pages(schedule).slice(1),
          ]),
        )
        return { root, at: 0 }
      },
    },
    {
      name: "the paired reader withheld the block",
      reaches: /the paired block is withheld/,
      block: 3,
      names: 3,
      build: async () => {
        const { root, schedule } = await bundleAt()
        await writeSheet(
          root,
          sheetFor(schedule, [
            ...pages(schedule).slice(0, 2),
            { ...pages(schedule)[2]!, rows: "none" as unknown as [] },
          ]),
        )
        await rm(join(root, PREFIX_DIRECTORY, "2"), { recursive: true, force: true })
        return { root, at: 2 }
      },
    },
    {
      name: "an extra page with no readable block number beside three valid ones",
      reaches: /^$/,
      block: 1,
      names: null,
      build: async () => {
        const { root, schedule } = await bundleAt()
        await writeSheet(root, sheetFor(schedule, [...pages(schedule), 5 as unknown as SheetBlockInput]))
        return { root, at: 3 }
      },
    },
  ]
  for (const entry of silent) {
    test(`a rejected page is named when ${entry.name}`, async () => {
      const { root, at } = await entry.build()
      const result = await readAt(root)
      if (result.sheet.kind !== "read") throw new Error(`expected read, got ${result.sheet.kind}`)
      expect(result.sheet.rejectedPages.map((page) => page.at)).toContain(at)

      const rejected = result.sheet.rejectedPages.find((page) => page.at === at)!
      expect(rejected.block).toEqual(entry.names)

      // SCOPED TO THE SHEET SECTION, AND THE REASON IS ASSERTED. Over the whole
      // report a bare index assertion passes on the block sections too, and
      // dropping `why` from the rendered line would leave a heading and an index
      // standing where the repair diagnostic used to be.
      const section = sheetSection(renderAdjudicationBundle(result))
      expect(section).toContain("SHEET PAGES REJECTED")
      const line = section.split("\n").find((entry) => entry.includes(`\`blocks[${at}]\``))
      expect(line, `no sheet-section line for \`blocks[${at}]\``).toBeDefined()
      expect(line!).toContain(entry.names === null ? "no readable block number" : `block ${entry.names}`)
      expect(line!).toContain(rejected.why)

      // Each case must reach a DIFFERENT early return, or the three prove one path.
      expect(reasonOf(result, entry.block), entry.name).toMatch(entry.reaches)
    })
  }

  /** The valid pages are untouched by a rejected one sitting beside them. */
  test("an extra rejected page leaves every valid page's results standing", async () => {
    const { root, schedule } = await bundleAt()
    await writeSheet(root, sheetFor(schedule, [...pages(schedule), 5 as unknown as SheetBlockInput]))
    const result = await readAt(root)
    for (const block of [1, 2, 3]) {
      expect(labelledTruth(result, block).directions["false-upheld-to-rejected"], `block ${block}`).toEqual(["c1"])
    }
    for (const direction of DIRECTIONS) expect(summaryOf(result, direction.label).observed).toBe(3)
  })

  /**
   * THE PROVENANCE LINE COMPARES THE FUNCTION, NOT THE OPTION'S PRESENCE. A
   * caller handing over `lexicalDefectMatcher` explicitly is running the shipped
   * matcher, and the report used to call that run INJECTED — a false sentence
   * about where its own suggestions came from.
   */
  test("an explicitly passed shipped matcher is reported as shipped, not injected", async () => {
    const { root } = await withDefaultSheet()
    const passed = await readAt(root, lexicalDefectMatcher)
    expect(passed.matcher).toBe("shipped-lexical")
    expect(renderAdjudicationBundle(passed)).not.toContain("INJECTED")

    const injected = await readAt(root, () => false)
    expect(injected.matcher).toBe("injected")
    expect(renderAdjudicationBundle(injected)).toContain("INJECTED")
  })

  /**
   * THE THREE NON-DECISIVE STATES ARE NAMED FOR EVERY CANDIDATE. They used to be
   * capped at five, and the per-candidate table that would have carried the rest
   * sits below the no-sheet return — so past the sixth, a bundle with no sheet
   * said how many were undecided and never which of the three states each was in.
   */
  test("every undecided candidate is named, past the five-id cap the other lists keep", async () => {
    const many: Candidate[] = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
      id: `u${n}`,
      on: "not-adjudicated",
      off: "upheld",
    }))
    const { root } = await bundleAt({ blocks: { 1: many, 2: many, 3: many } })
    const result = await readAt(root)
    expect(readBlock(result, 1).verdicts.undecided).toHaveLength(7)
    const text = renderAdjudicationBundle(result)
    for (const candidate of many) expect(text, candidate.id).toContain(`\`${candidate.id}\` — on not-adjudicated, off upheld`)
    expect(text).not.toContain("and 2 more")
  })

  /**
   * A LABELLED CANDIDATE IS NEVER REPORTED AS AN UNLABELLED ONE. The branch is
   * unreachable under the three shipped labels and exists for a fourth; filing
   * it as `label missing` would print a false statement under a passing
   * partition, which is the one shape the accounting cannot catch.
   */
  test("a labelled candidate no direction covers is `unclassified`, never `label missing`", () => {
    const text = renderAdjudicationBundle(unclassifiedResult())
    expect(text).toContain("UNCLASSIFIED: 1 of 1 carry a label no direction row covers")
    expect(text).toContain("unclassified (labelled true-defect, and no direction row covers it)")
    expect(text).not.toContain("label missing: 1")
  })
})

/**
 * `unchanged` is a VERDICT-axis count: both arms deciding a candidate the same
 * way needs no truth label, so it reads with no sheet and in every sheet state.
 */
describe("`unchanged` is a verdict fact and does not wait for the sheet", () => {
  /**
   * TWO UNCHANGED AND ONE ARM-MISSING, so the two counts DIFFER.
   *
   * The default block holds one of each, and `observe()` used to return the
   * arm-missing count for every verdict field that was not `undecided` — a
   * quantity reporting another quantity's number under its own label. Over a
   * fixture where both are 1 that substitution is invisible, so this block makes
   * the two numbers disagree and the summary values are asserted, not just the
   * observation count.
   */
  const SPLIT: Candidate[] = [
    { id: "u1", on: "upheld", off: "upheld" },
    { id: "u2", on: "judge-ruled-invalid", off: "judge-ruled-invalid" },
    { id: "m1", on: "upheld", off: null },
  ]

  const sheetless: { name: string; build: () => Promise<string> }[] = [
    {
      name: "no sheet at all",
      build: async () => (await bundleAt({ blocks: { 1: SPLIT, 2: SPLIT, 3: SPLIT } })).root,
    },
    {
      name: "a sheet refused as being about another plan",
      build: async () => {
        const { root, schedule } = await bundleAt({ blocks: { 1: SPLIT, 2: SPLIT, 3: SPLIT } })
        await writeSheet(root, sheetFor(schedule, pages(schedule), { scheduleHash: "sha256:someone-elses-plan" }))
        return root
      },
    },
  ]
  for (const entry of sheetless) {
    test(`reads with ${entry.name}`, async () => {
      const result = await readAt(await entry.build())
      expect(readBlock(result, 1).verdicts.unchanged.map((row) => row.id)).toEqual(["u1", "u2"])
      const unchanged = summaryOf(result, "unchanged (decided both sides, same way)")
      expect(unchanged.observed).toBe(3)
      expect(unchanged.values).toEqual([2, 2, 2])
      expect(summaryOf(result, "candidates missing from an arm").values).toEqual([1, 1, 1])
      expect(summaryOf(result, "undecided transitions").values).toEqual([0, 0, 0])
      expect(renderAdjudicationBundle(result)).toContain("unchanged (decided both sides, same way): 2 of 2 decided")
    })
  }

  const labelled: { name: string; label: TruthLabel | null }[] = [
    { name: "a decisive label", label: "true-defect" },
    { name: "an `unresolved` label", label: "unresolved" },
    { name: "no row at all", label: null },
  ]
  for (const entry of labelled) {
    test(`an unchanged candidate is unchanged under ${entry.name}`, async () => {
      const { root, schedule } = await bundleAt()
      const page = pageFor(1, BLOCK, (id) => (id === "c5" ? (entry.label ?? "true-defect") : LABELS[id]!))
      const rows = entry.label === null ? page.rows.filter((row) => row.candidateId !== "c5") : page.rows
      await writeSheet(root, sheetFor(schedule, [{ ...page, rows }, ...pages(schedule).slice(1)]))
      const result = await readAt(root)
      const truth = labelledTruth(result, 1)

      expect(readBlock(result, 1).verdicts.unchanged.map((row) => row.id)).toEqual(["c5"])
      expect(truth.labelMissing).not.toContain("c5")
      expect(truth.truthUnresolved).not.toContain("c5")
      const account = truth.candidates.find((candidate) => candidate.id === "c5")!
      expect(account.outcome).toEqual({ kind: "unchanged", state: "upheld" })
      expect(truth.accounting.agree).toBe(true)
    })
  }

  /**
   * THE BUCKETS ARE DISJOINT AND COVER THE POOL, by id and not only by total.
   * A total alone cannot see a candidate filed twice, because the double-count
   * and the candidate it displaced cancel.
   */
  test("every bucket is disjoint and together they cover the pool", async () => {
    const result = await readAt((await withDefaultSheet()).root)
    const truth = labelledTruth(result, 1)
    const verdicts = readBlock(result, 1).verdicts
    const buckets = [
      ...DIRECTIONS.map((direction) => truth.directions[direction.key]),
      truth.labelMissing,
      truth.truthUnresolved,
      truth.unclassified,
      verdicts.unchanged.map((row) => row.id),
      verdicts.undecided.map((row) => row.id),
      verdicts.armMissing.map((row) => row.id),
    ]
    const flat = buckets.flat()
    expect(new Set(flat).size).toBe(flat.length)
    expect(flat.length).toBe(BLOCK.length)
    expect(truth.accounting).toEqual({
      accounted: BLOCK.length,
      distinct: BLOCK.length,
      pool: BLOCK.length,
      agree: true,
    })
  })

  /**
   * THE TRUTH HALF IS WITHDRAWN AND THE VERDICT HALF IS NOT. A sheet page bound
   * to another execution says nothing about whether the two arms decided a
   * candidate, so the verdict quantities keep all three observations while the
   * truth quantities drop to two. Documentation alone would leave this unheld.
   */
  test("a block whose sheet page names another execution keeps its verdict quantities", async () => {
    const { root, schedule } = await bundleAt()
    const page = pageFor(1, BLOCK, (id) => LABELS[id]!, "run-prefix-2")
    await writeSheet(root, sheetFor(schedule, [page, ...pages(schedule).slice(1)]))
    const result = await readAt(root)

    for (const quantity of ["undecided transitions", "candidates missing from an arm", "unchanged (decided both sides, same way)"]) {
      expect(summaryOf(result, quantity).observed, quantity).toBe(3)
    }
    for (const direction of DIRECTIONS) expect(summaryOf(result, direction.label).observed).toBe(2)
    expect(summaryOf(result, "label missing").observed).toBe(2)
  })
})

describe("the `eval-read` seam", () => {
  test("prints the adjudication report fourth and still returns 0", async () => {
    const { root } = await withDefaultSheet()
    const { code, text } = await captured(() => evalReadMain(["bun", "eval-read", "--bundle", root]))
    expect(code).toBe(0)
    const order = ["MAD evaluation bundle", "MAD PAIRED CONTRAST", "MAD LABELLED RECALL", "MAD ADJUDICATION"]
    const positions = order.map((heading) => text.indexOf(heading))
    for (const position of positions) expect(position).toBeGreaterThanOrEqual(0)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    // THE FILE NAME AS A LITERAL, not as the constant under test: interpolating
    // `ADJUDICATION_SHEET_FILE` here would pass for any rename, while both
    // operator documents go on naming `adjudication.json`.
    expect(text).toContain("adjudication.json")
  })

  /**
   * No report promises a count an absent sheet never produced. The positive half
   * — that the labelled report's own closing names THIS module — lives in
   * `labelled-read.test.ts`, over a bundle whose labelled report is not refused.
   * Asserted here it would be satisfied by the paired report's closing instead.
   */
  test("no report promises a count it may not have", async () => {
    const { root } = await withDefaultSheet()
    const { text } = await captured(() => evalReadMain(["bun", "eval-read", "--bundle", root]))
    expect(text).not.toContain("adjudication is story 2-6b")
  })

  /**
   * THE SEAM'S OWN SAFETY NET, exercised through the seam. `eval-read` wraps this
   * reader in its own `try`, and a bundle with a refused schedule is the state
   * that reaches it without a bundle on disk being broken.
   */
  test("a bundle whose sealed schedule is refused prints the reason and still returns 0", async () => {
    const { root } = await withDefaultSheet()
    await writeFile(join(root, SCHEDULE_FILE), "{ not a schedule")
    const { code, text } = await captured(() => evalReadMain(["bun", "eval-read", "--bundle", root]))
    expect(code).toBe(0)
    expect(text).toContain("MAD ADJUDICATION")
    expect(text).not.toContain("THE FOUR DIRECTIONS")
  })
})
