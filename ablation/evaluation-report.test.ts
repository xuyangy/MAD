/**
 * Story 2-8a — the evaluation report, one matrix row at a time.
 *
 * The arithmetic is proved on hand-computed inputs first (the shared-label
 * bound, the outer bound, the observed spread, the cost contrast), because a
 * rendered report cannot tell a correct bound from a permuted one. Every matrix
 * row is then proved over a REAL sealed paired bundle on disk, read back through
 * the paired, labelled and adjudication readers exactly as `eval-read` reads it.
 * Nothing bills and no model runs; every bundle here is scripted.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SEEDED_DEFECTS } from "../fixtures/seeded-defects/labels.ts"
import { LABELLED_CHANGE_SEAL } from "../fixtures/seeded-defects/seal.ts"
import { main as evalReadMain } from "../scripts/eval-read.ts"
import {
  readAdjudicationBundle,
  type AdjudicationReadOutcome,
  type ArmFalsePositives,
  type TruthLabel,
} from "./adjudication-read.ts"
import { pageFor, sheetFor, writeSheet } from "./adjudication-read.fixture.ts"
import { PREFIX_DIRECTORY } from "./bundle.ts"
import {
  armCost,
  blockCost,
  costContrast,
  DIRECTION_UNRESOLVED,
  NO_TREATMENT_OPPORTUNITY,
  observedSpread,
  pairDifference,
  readEvaluationReport,
  renderEvaluationReport,
  REPORTING_MILESTONE,
  settle,
  type EvaluationReport,
  type PairDifference,
} from "./evaluation-report.ts"
import { fraction, fractionText, meanText } from "./fraction.ts"
import { HALT_MARKER_FILE } from "./governor.ts"
import { JOURNAL_FILE } from "./journal.ts"
import { readLabelledBundle } from "./labelled-read.ts"
import { known, unknownValue } from "./manifest.ts"
import { readPairedBundle, type PairedReadResult } from "./paired-read.ts"
import { pairedBundleAt, pairedFake, PROTOCOL_FILE, type ArmSpec, type PairedBundleOptions } from "./paired-read.fixture.ts"
import { writeBundle, type Fake } from "./read-bundle.fixture.ts"
import { appendSlotStatus, readFrozenProtocol, SCHEDULE_FILE, type PairedSchedule } from "./schedule.ts"

const scratch: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-evaluation-report-"))
  scratch.push(dir)
  return dir
}

afterEach(async () => {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})

let protocolHash: string

beforeAll(async () => {
  const protocol = await readFrozenProtocol(PROTOCOL_FILE)
  if (!protocol.ok) throw new Error(protocol.reason)
  protocolHash = protocol.hash
})

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

type ArmVerdict = "upheld" | "judge-ruled-invalid" | "not-adjudicated" | "unresolved" | "unjudged"

interface Candidate {
  id: string
  /** A planted defect whose locus and marker this candidate's prose carries. */
  defect?: string
  on: ArmVerdict | null
  off: ArmVerdict | null
  /** The sheet's label; `null` writes no row. */
  label: TruthLabel | null
}

/**
 * The default block. ON upholds `c1`, `c3`, `c4` — three true defects, so its
 * precision is the point 1. OFF upholds `c1`, `c2`, `c4` — two true and one
 * false, so its precision is the point 2/3. The pair difference is 1/3.
 */
const BLOCK: Candidate[] = [
  { id: "c1", on: "upheld", off: "upheld", label: "true-defect" },
  { id: "c2", on: "judge-ruled-invalid", off: "upheld", label: "not-a-defect" },
  { id: "c3", on: "upheld", off: "judge-ruled-invalid", label: "true-defect" },
  { id: "c4", defect: "sql-injection", on: "upheld", off: "upheld", label: "true-defect" },
  { id: "c5", on: "not-adjudicated", off: "judge-ruled-invalid", label: "true-defect" },
]

function findingOf(candidate: Candidate, verdict?: ArmVerdict): Record<string, unknown> {
  const defect = candidate.defect === undefined ? undefined : SEEDED_DEFECTS.find((entry) => entry.id === candidate.defect)
  if (candidate.defect !== undefined && defect === undefined) throw new Error(`no planted defect \`${candidate.defect}\``)
  return {
    id: candidate.id,
    claim: defect === undefined ? `an ordinary claim about \`${candidate.id}\`` : `this query is built by string ${defect.markers[0]}`,
    reasoning: `reasoning for \`${candidate.id}\``,
    locus: defect === undefined ? { file: "src/other/thing.ts", startLine: 3, endLine: 4 } : { ...defect.locus },
    source: "pool",
    author: "slot-1",
    ...(verdict === undefined || verdict === "unjudged" || verdict === "unresolved" ? {} : { verdict }),
    ...(verdict === "unresolved" ? { unresolved: { why: "the budget refused it before it was decided" } } : {}),
  }
}

function armFindings(candidates: readonly Candidate[], arm: "on" | "off"): unknown {
  const pool = candidates.flatMap((candidate) => {
    const verdict = candidate[arm]
    return verdict === null ? [] : [findingOf(candidate, verdict)]
  })
  return { pool, canonicalIds: pool.map((finding) => finding.id), lensInstructions: [] }
}

const TOKENS = (input: number) => ({ input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })

interface SpendSpec {
  prefix: { tokens: number; turns: number; unknown?: string[] }
  here: { tokens: number; turns: number; unknown?: string[] }
  completeness?: "complete" | "incomplete" | "unaudited"
}

/** The spend fields of a forked arm, conserved the way `provenanceProblem` checks them. */
function spendOf(spec: SpendSpec, prefixRunId: string): Partial<Fake> {
  const inheritedIds = spec.prefix.unknown ?? []
  const hereIds = spec.here.unknown ?? []
  const entry = (executionId: string) => ({ slot: "slot-1", stage: "judge", attempt: 1, executionId, why: "cancelled in flight" })
  const unknownUsage = [
    ...inheritedIds.map((id) => ({ ...entry(id), origin: { runId: prefixRunId } })),
    ...hereIds.map(entry),
  ]
  const total = TOKENS(spec.prefix.tokens + spec.here.tokens)
  const completeness = spec.completeness ?? (unknownUsage.length === 0 ? "complete" : "incomplete")
  return {
    total,
    unknownUsage,
    unknownUsageCount: unknownUsage.length,
    usageCompleteness: completeness,
    exposure: completeness === "complete" ? "quantified" : "unquantified",
    origin: {
      attributed: { tokens: total, turns: spec.prefix.turns + spec.here.turns, unknown: unknownUsage.length },
      executedHere: { tokens: TOKENS(spec.here.tokens), turns: spec.here.turns, unknown: hereIds.length },
      inherited: { tokens: TOKENS(spec.prefix.tokens), turns: spec.prefix.turns, unknown: inheritedIds.length },
    },
  }
}

const DEFAULT_SPEND: Record<"on" | "off", SpendSpec> = {
  on: { prefix: { tokens: 100, turns: 2 }, here: { tokens: 300, turns: 5 } },
  off: { prefix: { tokens: 100, turns: 2 }, here: { tokens: 120, turns: 3 } },
}

interface BundleOptions {
  blocks?: Record<number, Candidate[]>
  /** `false` writes no sheet at all. */
  sheet?: boolean | ((schedule: PairedSchedule) => unknown)
  spend?: (block: number, arm: "on" | "off") => SpendSpec
  arm?: (spec: ArmSpec) => ArmSpec
  /** Replaces the six arms written, after they are built. */
  written?: (fakes: Fake[]) => Fake[]
  paired?: PairedBundleOptions
  /** Replace a block's prefix run id — two blocks may name one run. */
  prefixRunIds?: Record<number, string>
}

function runIdOf(options: BundleOptions, block: number): string {
  return options.prefixRunIds?.[block] ?? `run-prefix-${block}`
}

function candidatesOf(options: BundleOptions, block: number): Candidate[] {
  return options.blocks?.[block] ?? BLOCK
}

/** A sealed, scripted paired bundle with real prefix records and a complete truth sheet. */
async function bundleAt(options: BundleOptions = {}): Promise<{ root: string; schedule: PairedSchedule }> {
  const root = await tempDir()
  const specs: ArmSpec[] = []
  const prefixOver: Record<number, Record<string, unknown>> = {}
  for (const block of [1, 2, 3]) {
    const runId = runIdOf(options, block)
    for (const arm of ["on", "off"] as const) {
      const spec: ArmSpec = {
        block,
        arm,
        prefixRunId: runId,
        over: {
          fixtureHash: known(LABELLED_CHANGE_SEAL.materialHash),
          protocolHash: known(protocolHash),
          findings: armFindings(candidatesOf(options, block), arm),
          ...spendOf(options.spend?.(block, arm) ?? DEFAULT_SPEND[arm], runId),
        },
      }
      specs.push(options.arm?.(spec) ?? spec)
    }
    prefixOver[block] = {
      prefixRunId: known(runId),
      dump: join(root, PREFIX_DIRECTORY, String(block - 1), runId),
      ...(options.paired?.prefixOver?.[block] ?? {}),
    }
  }
  const written = options.written
  const schedule = await pairedBundleAt(root, {
    ...options.paired,
    arms: specs,
    prefixOver,
    ...(written === undefined
      ? {}
      : {
          written: (sealed: PairedSchedule) => written(specs.map((spec) => pairedFake(sealed, spec))),
        }),
  })
  for (const block of [1, 2, 3]) {
    const runId = runIdOf(options, block)
    const pool = candidatesOf(options, block).map((candidate) => findingOf(candidate))
    const directory = join(root, PREFIX_DIRECTORY, String(block - 1), runId)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, "record.json"),
      JSON.stringify({ runId, roster: schedule.roster, answered: schedule.roster.slots.length, pool, findings: pool, warnings: [] }),
    )
  }
  if (typeof options.sheet === "function") {
    await writeSheet(root, options.sheet(schedule))
  } else if (options.sheet !== false) {
    await writeSheet(root, sheetFor(schedule, [1, 2, 3].map((block) => pageOf(options, block))))
  }
  return { root, schedule }
}

function pageOf(options: BundleOptions, block: number) {
  const candidates = candidatesOf(options, block)
  const page = pageFor(
    block,
    candidates,
    (id) => candidates.find((candidate) => candidate.id === id)!.label ?? "true-defect",
    runIdOf(options, block),
  )
  return { ...page, rows: page.rows.filter((row) => candidates.find((candidate) => candidate.id === row.candidateId)!.label !== null) }
}

async function pairedOf(root: string): Promise<PairedReadResult> {
  const paired = await readPairedBundle(root)
  if ("error" in paired) throw new Error(paired.error)
  return paired
}

/** Every upstream reader once, exactly as `eval-read` runs them. */
async function reportOf(
  root: string,
  mutateAdjudication?: (adjudication: AdjudicationReadOutcome) => void,
): Promise<EvaluationReport> {
  const paired = await pairedOf(root)
  const adjudication = await settle(() => readAdjudicationBundle(paired))
  if (adjudication.kind === "read") mutateAdjudication?.(adjudication.value)
  const outcome = readEvaluationReport({ kind: "read", value: paired }, await settle(() => readLabelledBundle(paired)), adjudication)
  if (outcome.kind !== "read") throw new Error(`expected a report, got ${JSON.stringify(outcome)}`)
  return outcome
}

async function textOf(root: string, mutateAdjudication?: (adjudication: AdjudicationReadOutcome) => void): Promise<string> {
  return renderEvaluationReport(await reportOf(root, mutateAdjudication))
}

/** Verdict and recommendation phrases no rendering of this report may carry. */
const BANNED = ["earned", "did not earn", "did-not-earn", "keep or remove", "recommend", "recall gate", "pass/fail", "no effect", "direction unidentified"]

function expectNoVerdict(text: string): void {
  const lower = text.toLowerCase()
  for (const phrase of BANNED) expect(lower, phrase).not.toContain(phrase)
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

/** The report section from `heading` to the next top-level heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading)
  if (start < 0) throw new Error(`no section \`${heading}\``)
  const rest = text.slice(start + heading.length)
  const next = rest.search(/\n[A-Z][A-Z ]+ — /)
  return heading + (next < 0 ? rest : rest.slice(0, next))
}

function counts(arm: "on" | "off", over: Partial<ArmFalsePositives>): ArmFalsePositives {
  return {
    arm,
    runId: `run-${arm}`,
    upheld: 0,
    falsePositives: [],
    trueDefects: [],
    truthUnresolved: [],
    labelMissing: [],
    outsidePool: [],
    ...over,
  }
}

function bounded(difference: PairDifference) {
  if (difference.kind !== "bounded") throw new Error(`expected a bound, got ${difference.kind}`)
  return {
    primary: [fractionText(difference.primary.lower), fractionText(difference.primary.upper)],
    outer: [fractionText(difference.outer.lower), fractionText(difference.outer.upper)],
  }
}

// ---------------------------------------------------------------------------
// Exact arithmetic
// ---------------------------------------------------------------------------

describe("exact fractions", () => {
  test("reduce, keep the sign on the numerator, and print no float", () => {
    expect(fractionText(fraction(2, 4))).toBe("1/2")
    expect(fractionText(fraction(3, -6))).toBe("-1/2")
    expect(fractionText(fraction(0, -5))).toBe("0")
    expect(fractionText(fraction(6, 3))).toBe("2")
  })

  test("the shared `meanText` prints what the two readers printed before", () => {
    expect(meanText([1, 2])).toBe("3/2")
    expect(meanText([2, 2, 2])).toBe("2")
    expect(meanText([0, 1, 1])).toBe("2/3")
    expect(meanText([-1, -2])).toBe("-3/2")
  })
})

// ---------------------------------------------------------------------------
// The pair bound, hand-computed
// ---------------------------------------------------------------------------

describe("the pair bound, against hand-computed cases", () => {
  test("U = 0 on both sides: the bound is the point difference, and the outer bound agrees", () => {
    const on = counts("on", { upheld: 4, trueDefects: ["a", "b", "c"], falsePositives: ["d"] })
    const off = counts("off", { upheld: 2, trueDefects: ["a"], falsePositives: ["e"] })
    expect(bounded(pairDifference(on, off))).toEqual({ primary: ["1/4", "1/4"], outer: ["1/4", "1/4"] })
  })

  test("the shared-unlabelled counterexample: primary [0, 0], outer [-1, 1]", () => {
    const on = counts("on", { upheld: 1, truthUnresolved: ["u"] })
    const off = counts("off", { upheld: 1, labelMissing: ["u"] })
    expect(bounded(pairDifference(on, off))).toEqual({ primary: ["0", "0"], outer: ["-1", "1"] })
  })

  test("different unlabelled ids on each side span both signs", () => {
    // K = 1/2 − 1/2 = 0; a_u1 = 1/2, a_u2 = −1/2.
    const on = counts("on", { upheld: 2, trueDefects: ["t"], truthUnresolved: ["u1"] })
    const off = counts("off", { upheld: 2, trueDefects: ["t"], outsidePool: ["u2"] })
    expect(bounded(pairDifference(on, off))).toEqual({ primary: ["-1/2", "1/2"], outer: ["-1/2", "1/2"] })
  })

  test("a shared unlabelled id with unequal N is tighter than the outer bound", () => {
    // K = 1/3 − 0/2 = 1/3; a_u = 1/3 − 1/2 = −1/6; a_v = 0 − 1/2 = −1/2.
    // primary = [1/3 − 1/6 − 1/2, 1/3] = [−1/3, 1/3].
    // outer = [1/3 − 2/2, 2/3 − 0/2] = [−2/3, 2/3].
    const on = counts("on", { upheld: 3, trueDefects: ["t"], falsePositives: ["f"], labelMissing: ["u"] })
    const off = counts("off", { upheld: 2, labelMissing: ["u"], truthUnresolved: ["v"] })
    expect(bounded(pairDifference(on, off))).toEqual({ primary: ["-1/3", "1/3"], outer: ["-2/3", "2/3"] })
  })

  test("an upheld id outside the pool is unlabelled: never true, never dropped from N", () => {
    const on = counts("on", { upheld: 2, trueDefects: ["t"], outsidePool: ["x"] })
    const off = counts("off", { upheld: 1, trueDefects: ["t"] })
    // K = 1/2 − 1 = −1/2; a_x = 1/2 → [−1/2, 0].
    expect(bounded(pairDifference(on, off))).toEqual({ primary: ["-1/2", "0"], outer: ["-1/2", "0"] })
  })

  test("an arm that upheld nothing makes the difference UNDEFINED, and no bound repairs it", () => {
    const difference = pairDifference(counts("on", { upheld: 0 }), counts("off", { upheld: 2, trueDefects: ["a", "b"] }))
    expect(difference.kind).toBe("undefined")
    if (difference.kind === "undefined") expect(difference.reason).toContain("undefined")
  })
})

describe("the observed spread", () => {
  const point = (num: number, den: number) => {
    const value = fraction(num, den)
    return { lower: value, upper: value }
  }
  const bound = (a: [number, number], b: [number, number]) => ({ lower: fraction(...a), upper: fraction(...b) })
  const pair = (block: number, primary: { lower: ReturnType<typeof fraction>; upper: ReturnType<typeof fraction> }): { block: number; difference: PairDifference } => ({
    block,
    difference: { kind: "bounded", primary, outer: primary, k: primary.lower, sharedUnlabelled: [] },
  })

  test("all points: exact mean, min and max", () => {
    const spread = observedSpread([pair(1, point(1, 3)), pair(2, point(0, 1)), pair(3, point(-1, 2))])
    expect(spread.kind).toBe("points")
    if (spread.kind !== "points") return
    // (1/3 + 0 − 1/2) / 3 = −1/18.
    expect([fractionText(spread.mean), fractionText(spread.min), fractionText(spread.max)]).toEqual(["-1/18", "-1/2", "1/3"])
  })

  test("any interval: the mean averages endpoints, min and max are bounded", () => {
    const spread = observedSpread([pair(1, point(1, 3)), pair(2, bound([-1, 2], [1, 2])), pair(3, bound([0, 1], [1, 1]))])
    expect(spread.kind).toBe("bounded")
    if (spread.kind !== "bounded") return
    // lowers 1/3, −1/2, 0 → mean −1/18; uppers 1/3, 1/2, 1 → mean 11/18.
    expect([fractionText(spread.mean.lower), fractionText(spread.mean.upper)]).toEqual(["-1/18", "11/18"])
    expect([fractionText(spread.min.lower), fractionText(spread.min.upper)]).toEqual(["-1/2", "1/3"])
    expect([fractionText(spread.max.lower), fractionText(spread.max.upper)]).toEqual(["1/3", "1"])
  })

  test("one pair undefined: no three-pair summary, and no two-pair one", () => {
    const spread = observedSpread([
      pair(1, point(1, 3)),
      { block: 2, difference: { kind: "undefined", reason: "arm on upheld nothing" } },
      pair(3, point(0, 1)),
    ])
    expect(spread.kind).toBe("unavailable")
    if (spread.kind === "unavailable") expect(spread.missing.map((gap) => gap.block)).toEqual([2])
  })
})

// ---------------------------------------------------------------------------
// The matrix, over persisted bundles
// ---------------------------------------------------------------------------

describe("the happy path", () => {
  test("SYNTHETIC first, 3 of 3 completed, points, bounds, spread, recall, cost and treatment", async () => {
    const { root } = await bundleAt()
    const text = await textOf(root)
    const lines = text.split("\n")
    expect(lines[0]).toBe("MAD EVALUATION REPORT — SYNTHETIC")
    expect(lines[1]).toContain("SYNTHETIC")
    expect(text).toContain(REPORTING_MILESTONE)
    expect(text).toContain("completed: 3 of 3")

    const precision = section(text, "PRECISION — ")
    expect(precision).toContain("arm on, run `run-on-0`: point 1 = TP/(TP+FP) = 3/3 (TP 3, FP 0, U 0 of N 3 upheld)")
    expect(precision).toContain("arm off, run `run-off-0`: point 2/3 = TP/(TP+FP) = 2/3 (TP 2, FP 1, U 0 of N 3 upheld)")
    expect(precision).toContain("shared-label bound (primary): point 1/3")
    expect(precision).toContain("OUTER bound (secondary, labelled outer): [1/3, 1/3]")
    expect(precision).toContain("observed spread: mean 1/3, min 1/3, max 1/3")

    const recall = section(text, "FINAL RECALL — ")
    expect(recall).toContain("arm on, run `run-on-0`, matcher recall: 1 of 13 planted defects (`sql-injection`)")
    expect(recall).toContain("ON − OFF matcher recall change: 0 of 13 planted defects")
    // c3 is true and OFF rejected it; c5 is true and neither arm upheld it.
    expect(recall).toContain("arm off lost true candidates: 2 of 4 sheet-labelled true prefix candidates not upheld (`c3` rejected, `c5` rejected)")
    expect(recall).toContain("arm on lost true candidates: 1 of 4 sheet-labelled true prefix candidates not upheld (`c5` not-adjudicated)")

    const cost = section(text, "COST — ")
    expect(cost).toContain("shared prefix `run-prefix-1`, counted once: 100 tokens over 2 turn(s), 0 unknown")
    expect(cost).toContain("continuation executed here 300 tokens over 5 turn(s), 0 unknown — complete")
    expect(cost).toContain("ON − OFF newly executed: exactly 180 tokens, 2 turn(s)")
    expect(cost).toContain("520 tokens over 10 turn(s), exposure quantified")
    expect(cost).toContain("No experiment total is printed")

    const treatment = section(text, "TREATMENT OPPORTUNITY — ")
    expect(treatment).toContain("normal policy would have debated 3 of 4 candidates sent to the judge")
    expect(treatment).toContain("the debate stage did not run")
  })

  test("every quantity is available 3/3", async () => {
    const { root } = await bundleAt()
    const report = await reportOf(root)
    for (const entry of report.availability) expect(entry.available, entry.quantity).toBe(3)
  })

  test("no verdict wording, no keep/remove recommendation, and no recall gate — in any variant", async () => {
    const variants: BundleOptions[] = [
      {},
      { sheet: false },
      { sheet: (schedule) => sheetFor(schedule, [1, 2, 3].map((block) => pageOf({}, block)), { scheduleHash: "sha256:another" }) },
      { arm: (spec) => (spec.block === 3 && spec.arm === "off" ? { ...spec, over: { ...spec.over, completion: "cancelled" } } : spec) },
    ]
    for (const variant of variants) {
      const { root } = await bundleAt(variant)
      expectNoVerdict(await textOf(root))
    }
  })

  test("ON's `status.debateCounts` says whether debate ran", async () => {
    const { root } = await bundleAt({
      arm: (spec) =>
        spec.arm === "on" ? { ...spec, over: { ...spec.over, debateCounts: { kind: "ran", counts: { debated: 2 } } } } : spec,
    })
    expect(await textOf(root)).toContain("ON run `run-on-0`: the debate stage ran and debated 2 candidate(s)")
  })
})

describe("provenance", () => {
  test("a live schedule sealed on disk prints no SYNTHETIC banner", async () => {
    const { root } = await bundleAt({ paired: { provenance: "live" } })
    const text = await textOf(root)
    expect(text).not.toContain("SYNTHETIC")
    expect(text.split("\n")[0]).toBe("MAD EVALUATION REPORT")
  })

  test("a sealed schedule with an unrecognised provenance prints provenance unestablished", async () => {
    const { root } = await bundleAt({ paired: { provenance: "replayed" } })
    const text = await textOf(root)
    expect(text.split("\n")[0]).toBe("MAD EVALUATION REPORT — PROVENANCE UNESTABLISHED")
    expect(text).toContain('`config.provenance` is "replayed"')
    expect(text).not.toContain("SYNTHETIC")
  })

  test("a refused schedule prints provenance unestablished", async () => {
    const { root } = await bundleAt()
    await writeFile(join(root, SCHEDULE_FILE), "{ not a schedule")
    const text = await textOf(root)
    expect(text.split("\n")[0]).toBe("MAD EVALUATION REPORT — PROVENANCE UNESTABLISHED")
    expect(text).toContain("completed: 0 of 3")
  })
})

describe("not paired", () => {
  test("an ordinary bundle yields no report, and `eval-read` prints none", async () => {
    const root = await tempDir()
    await writeBundle(root, [{ armId: "a", repeatId: 0 }], [{ armId: "a", repeatId: 0 }])
    const paired = await readPairedBundle(root)
    const outcome = readEvaluationReport(
      { kind: "read", value: paired },
      { kind: "threw", message: "unused" },
      { kind: "threw", message: "unused" },
    )
    expect(outcome.kind).toBe("not-applicable")
    expect(renderEvaluationReport(outcome)).toBe("")
    const { code, text } = await captured(() => evalReadMain(["bun", "eval-read", "--bundle", root]))
    expect(code).toBe(0)
    expect(text).not.toContain("MAD EVALUATION REPORT")
  })
})

describe("precision", () => {
  test("U > 0: an interval, a bound, and no point", async () => {
    const block = BLOCK.map((candidate) => (candidate.id === "c3" ? { ...candidate, label: "unresolved" as const } : candidate))
    const { root } = await bundleAt({ blocks: { 1: block } })
    const precision = section(await textOf(root), "PRECISION — ")
    const first = precision.slice(0, precision.indexOf("BLOCK 2"))
    expect(first).toContain("arm on, run `run-on-0`: in [2/3, 1] = [TP/N, (TP+U)/N] = [2/3, 3/3] (TP 2, FP 0, U 1 of N 3 upheld)")
    expect(first).not.toContain("arm on, run `run-on-0`: point")
    expect(first).toContain("shared-label bound (primary): in [0, 1/3]")
  })

  test("upheld nothing: UNDEFINED, never 100%, and no planned mean", async () => {
    const empty = BLOCK.map((candidate) => ({ ...candidate, on: candidate.on === "upheld" ? ("judge-ruled-invalid" as const) : candidate.on }))
    const { root } = await bundleAt({ blocks: { 2: empty } })
    const text = await textOf(root)
    expect(text).toContain("arm on, run `run-on-1`: UNDEFINED")
    expect(text).not.toContain("100%")
    expect(text).toContain("pair difference ON − OFF: UNDEFINED")
    expect(text).toContain("no three-pair summary")
    expect(text).not.toContain("observed spread: mean")
    expect(text).toContain("precision difference: 2/3")
  })

  test("shared unlabelled: primary [0, 0] with no sign statement; outer [-1, 1] with its own limitation", async () => {
    const shared: Candidate[] = [
      { id: "c1", on: "upheld", off: "upheld", label: null },
      { id: "c2", on: "judge-ruled-invalid", off: "judge-ruled-invalid", label: "true-defect" },
    ]
    const { root } = await bundleAt({ blocks: { 1: shared } })
    const precision = section(await textOf(root), "PRECISION — ")
    const first = precision.slice(0, precision.indexOf("BLOCK 2"))
    expect(first).toContain("shared-label bound (primary): point 0")
    expect(first).not.toContain(DIRECTION_UNRESOLVED)
    expect(first).toContain("OUTER bound (secondary, labelled outer): [-1, 1]")
    expect(first).toContain("a limitation of the OUTER bound")
  })

  test("a primary bound spanning both signs does not resolve direction", async () => {
    const spans: Candidate[] = [
      { id: "t", on: "upheld", off: "upheld", label: "true-defect" },
      { id: "u1", on: "upheld", off: "judge-ruled-invalid", label: "unresolved" },
      { id: "u2", on: "judge-ruled-invalid", off: "upheld", label: null },
    ]
    const { root } = await bundleAt({ blocks: { 1: spans } })
    const text = await textOf(root)
    expect(text).toContain("shared-label bound (primary): in [-1/2, 1/2]")
    expect(text).toContain(DIRECTION_UNRESOLVED)
  })

  test("a planned mean's bound spanning both signs does not resolve direction", async () => {
    const spans: Candidate[] = [
      { id: "t", on: "upheld", off: "upheld", label: "true-defect" },
      { id: "u1", on: "upheld", off: "judge-ruled-invalid", label: "unresolved" },
      { id: "u2", on: "judge-ruled-invalid", off: "upheld", label: null },
    ]
    const { root } = await bundleAt({ blocks: { 1: spans, 2: spans, 3: spans } })
    const precision = section(await textOf(root), "PRECISION — ")
    const spread = precision.slice(precision.indexOf("OBSERVED SPREAD"))
    expect(spread).toContain(`the planned mean's bound: ${DIRECTION_UNRESOLVED}`)
  })

  test("all three pairs points: each difference, then exact mean, min and max", async () => {
    const rejectC3: Candidate[] = BLOCK.map((candidate) => (candidate.id === "c3" ? { ...candidate, on: "judge-ruled-invalid" as const } : candidate))
    const offC3: Candidate[] = BLOCK.map((candidate) => (candidate.id === "c3" ? { ...candidate, off: "upheld" as const } : candidate))
    const { root } = await bundleAt({ blocks: { 2: rejectC3, 3: offC3 } })
    const text = await textOf(root)
    // (1/3 + 1/3 + 1/4) / 3 = 11/36.
    expect(text).toContain("pair differences: 1/3, 1/3, 1/4")
    expect(text).toContain("observed spread: mean 11/36, min 1/4, max 1/3")
  })

  test("some intervals: the planned mean is bounded and min and max are labelled bounded", async () => {
    const block = BLOCK.map((candidate) => (candidate.id === "c3" ? { ...candidate, label: "unresolved" as const } : candidate))
    const { root } = await bundleAt({ blocks: { 1: block } })
    const text = await textOf(root)
    // Pairs: [0, 1/3], 1/3, 1/3 → mean [2/9, 1/3].
    expect(text).toContain("pair differences: [0, 1/3], 1/3, 1/3")
    expect(text).toContain("observed spread: planned mean in [2/9, 1/3] (the endpoints averaged); min bounded in [0, 1/3]; max bounded in [1/3, 1/3]")
  })
})

describe("no sheet, a refused sheet, and readers that throw", () => {
  test("no sheet: precision and lost candidates unavailable with the sheet's reason; everything else reads", async () => {
    const { root } = await bundleAt({ sheet: false })
    const text = await textOf(root)
    expect(section(text, "PRECISION — ")).toContain("no adjudication sheet")
    expect(text).toContain("lost true candidates: unavailable")
    expect(text).toContain("matcher recall: 1 of 13")
    expect(text).toContain("ON − OFF newly executed: exactly 180 tokens")
    expect(text).toContain("normal policy would have debated 3 of 4")
    expect(text).toContain("completed: 3 of 3")
  })

  test("a refused sheet: its reason, and nothing else lost", async () => {
    const { root } = await bundleAt({
      sheet: (schedule) => sheetFor(schedule, [1, 2, 3].map((block) => pageOf({}, block)), { scheduleHash: "sha256:another" }),
    })
    const text = await textOf(root)
    expect(section(text, "PRECISION — ")).toContain("refused")
    expect(text).toContain("ON − OFF newly executed: exactly 180 tokens")
  })

  test("a throwing labelled or adjudication reader leaves coverage, cost and treatment printed through `eval-read`", async () => {
    const { root } = await bundleAt()
    const { code, text } = await captured(() =>
      evalReadMain(["bun", "eval-read", "--bundle", root], {
        labelled: () => Promise.reject(new Error("labelled blew up")),
        adjudication: () => Promise.reject(new Error("adjudication blew up")),
      }),
    )
    expect(code).toBe(0)
    const report = text.slice(text.indexOf("MAD EVALUATION REPORT"))
    expect(report).toContain("the labelled reader threw: labelled blew up")
    expect(report).toContain("the adjudication reader threw: adjudication blew up")
    expect(report).toContain("completed: 3 of 3")
    expect(report).toContain("ON − OFF newly executed: exactly 180 tokens")
    expect(report).toContain("normal policy would have debated 3 of 4")
  })

  test("`eval-read` prints the report fifth, after the adjudication report, SYNTHETIC first", async () => {
    const { root } = await bundleAt()
    const { code, text } = await captured(() => evalReadMain(["bun", "eval-read", "--bundle", root]))
    expect(code).toBe(0)
    const order = ["MAD evaluation bundle", "MAD PAIRED CONTRAST", "MAD LABELLED RECALL", "MAD ADJUDICATION", "MAD EVALUATION REPORT — SYNTHETIC"]
    const positions = order.map((heading) => text.indexOf(heading))
    for (const [index, position] of positions.entries()) expect(position, order[index]).toBeGreaterThanOrEqual(0)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })
})

describe("failed and cancelled arms, and a failed prefix", () => {
  test("a failed arm: its block is withheld, its spend is kept and labelled incomplete", async () => {
    const { root } = await bundleAt({
      written: (fakes) =>
        fakes.map((fake) =>
          fake.repeatId === 1 && fake.armId === "on"
            ? {
                ...fake,
                completion: "unfinished",
                finishedAt: unknownValue("the continuation threw"),
                experiment: { ...(fake.experiment as object), failure: "the provider hung up" },
              }
            : fake,
        ),
    })
    const text = await textOf(root)
    expect(text).toContain("completed: 2 of 3")
    expect(text).toContain("block 2: WITHHELD")
    const cost = section(text, "COST — ")
    const block2 = cost.slice(cost.indexOf("BLOCK 2"), cost.indexOf("BLOCK 3"))
    expect(block2).toContain("INCOMPLETE — it THREW (the provider hung up)")
    expect(block2).toContain("continuation executed here 300 tokens")
    expect(block2).toContain("ON − OFF newly executed: unavailable")
    expect(block2).toContain("block execution (prefix once + both continuations): observed 520 tokens over 10 turn(s), INCOMPLETE")
    expect(block2).not.toMatch(/block execution[^\n]*exposure quantified/)
    expect(section(text, "PRECISION — ")).toContain("the paired block is withheld")
    expect(text).toContain("no three-pair summary")
    expect(text).not.toContain("observed spread: mean")
  })

  test("a cancelled arm is read as a failed one", async () => {
    const { root } = await bundleAt({
      arm: (spec) => (spec.block === 3 && spec.arm === "off" ? { ...spec, over: { ...spec.over, completion: "cancelled" } } : spec),
    })
    const text = await textOf(root)
    expect(text).toContain("completed: 2 of 3")
    const cost = section(text, "COST — ")
    const block3 = cost.slice(cost.indexOf("BLOCK 3"))
    expect(block3).toContain("INCOMPLETE — it stopped part way (`cancelled`)")
    expect(block3).toContain("observed 520 tokens over 10 turn(s), INCOMPLETE — a continuation stopped part way")
    expect(block3).not.toMatch(/block execution[^\n]*exposure quantified/)
  })

  test("a failed prefix: not completed, its slots not attempted, and its cost points at the journal", async () => {
    const { root, schedule } = await bundleAt({
      written: (fakes) => fakes.filter((fake) => fake.repeatId !== 0),
      paired: {
        prefixOver: { 1: { failure: "discovery threw", forked: false, prefixRunId: unknownValue("no run was minted") } },
        slots: "absent",
      },
    })
    for (const slot of schedule.slots) {
      await appendSlotStatus(root, {
        ...slot,
        status: slot.block === 1 ? "not-attempted" : "completed",
        reason: slot.block === 1 ? "the prefix failed before this slot" : "the continuation returned a record",
        at: "2026-09-14T00:00:02.000Z",
      })
    }
    const text = await textOf(root)
    expect(text).toContain("completed: 2 of 3")
    const coverage = section(text, "EXECUTION COVERAGE — ")
    expect(coverage).toContain("block 1 on: not-attempted — the prefix failed before this slot")
    expect(coverage).toContain("block 1 off: not-attempted — the prefix failed before this slot")
    const cost = section(text, "COST — ")
    const block1 = cost.slice(cost.indexOf("BLOCK 1"), cost.indexOf("BLOCK 2"))
    expect(block1).toContain("the prefix FAILED (discovery threw)")
    expect(block1).toContain(JOURNAL_FILE)
    expect(block1).not.toMatch(/\b0 tokens\b/)
  })
})

describe("cost", () => {
  test("a failed prefix still names an arm whose cost is unavailable", async () => {
    const { root } = await bundleAt()
    const paired = await pairedOf(root)
    const block = paired.blocks.find((entry) => entry.block === 1)!
    block.prefix = { ...block.prefix, evidence: { ...block.prefix.evidence!, failure: "discovery threw" } }
    delete (block.arms.find((arm) => arm.arm === "on")!.row.manifest.spend as unknown as { origin?: unknown }).origin
    const report = readEvaluationReport(
      { kind: "read", value: paired },
      await settle(() => readLabelledBundle(paired)),
      await settle(() => readAdjudicationBundle(paired)),
    )
    const cost = section(renderEvaluationReport(report), "COST — ")
    const block1 = cost.slice(cost.indexOf("BLOCK 1"), cost.indexOf("BLOCK 2"))
    expect(block1).toContain("the prefix FAILED (discovery threw)")
    expect(block1).toContain("arm on, run `run-on-0`: cost UNAVAILABLE — its manifest carries no `spend.origin`")
    expect(block1).toContain("arm off, run `run-off-0`")
  })

  test("inherited tokens that differ by kind establish no prefix", async () => {
    const byKind = { input: 50, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    const { root } = await bundleAt({
      arm: (spec) => {
        if (spec.block !== 1 || spec.arm !== "off") return spec
        const origin = spec.over!.origin as { attributed: object; executedHere: object; inherited: object }
        const total = { input: 170, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
        return {
          ...spec,
          over: {
            ...spec.over,
            total,
            origin: {
              ...origin,
              attributed: { ...origin.attributed, tokens: total },
              inherited: { ...origin.inherited, tokens: byKind },
            },
          },
        }
      },
    })
    const cost = section(await textOf(root), "COST — ")
    const block1 = cost.slice(cost.indexOf("BLOCK 1"), cost.indexOf("BLOCK 2"))
    expect(block1).toContain("ONE SHARED PREFIX IS NOT ESTABLISHED")
    expect(block1).toContain("the inherited tokens differ by kind (on input 100, output 0")
    expect(block1).not.toContain("ON − OFF newly executed: exactly")
  })

  test("unknown usage in the prefix only: an exact incremental contrast, and an unquantified block", async () => {
    const withPrefixUnknown = (_block: number, arm: "on" | "off"): SpendSpec => ({
      ...DEFAULT_SPEND[arm],
      prefix: { tokens: 100, turns: 2, unknown: ["exec-prefix-1"] },
    })
    const { root } = await bundleAt({ spend: withPrefixUnknown })
    const cost = section(await textOf(root), "COST — ")
    expect(cost).toContain("ON − OFF newly executed: exactly 180 tokens, 2 turn(s)")
    expect(cost).toContain("exposure UNQUANTIFIED")
    expect(cost).toContain("the shared prefix holds 1 execution(s) with UNKNOWN usage")
    expect(cost).toContain("exposure unquantified")
  })

  test("unknown usage in ON only: a one-sided bound, exposure unquantified", async () => {
    const { root } = await bundleAt({
      spend: (_block, arm) => (arm === "on" ? { ...DEFAULT_SPEND.on, here: { tokens: 300, turns: 5, unknown: ["exec-on"] } } : DEFAULT_SPEND.off),
    })
    const cost = section(await textOf(root), "COST — ")
    expect(cost).toContain("ON − OFF newly executed: at least 180 tokens, at least 2 turn(s) — a one-sided bound")
    expect(cost).toContain("OBSERVED LOWER BOUND")
    expect(cost).toContain("exposure UNQUANTIFIED")
    expect(cost).not.toContain("exactly")
  })

  test("unknown usage in OFF only: the bound is an upper one", async () => {
    const { root } = await bundleAt({
      spend: (_block, arm) => (arm === "off" ? { ...DEFAULT_SPEND.off, here: { tokens: 120, turns: 3, unknown: ["exec-off"] } } : DEFAULT_SPEND.on),
    })
    const cost = section(await textOf(root), "COST — ")
    expect(cost).toContain("ON − OFF newly executed: at most 180 tokens, at most 2 turn(s) — a one-sided bound")
    expect(cost).toContain("the OFF continuation is a lower bound: 1 execution(s) it issued itself have UNKNOWN usage")
    expect(cost).toContain("OBSERVED LOWER BOUND")
    expect(cost).not.toContain("exactly")
  })

  test("arms naming different prefixes: nothing cancels, and no contrast is counted", async () => {
    const { root } = await bundleAt({
      arm: (spec) => (spec.block === 2 && spec.arm === "off" ? { ...spec, prefixRunId: "run-prefix-other" } : spec),
    })
    const text = await textOf(root)
    const cost = section(text, "COST — ")
    const block2 = cost.slice(cost.indexOf("BLOCK 2"), cost.indexOf("BLOCK 3"))
    expect(block2).toContain("ONE SHARED PREFIX IS NOT ESTABLISHED")
    expect(block2).toContain("the arms name different prefixes (on `run-prefix-2`, off `run-prefix-other`)")
    expect(block2).not.toContain("ON − OFF newly executed: exactly")
    const report = await reportOf(root)
    expect(report.availability.find((entry) => entry.quantity === "cost contrast")!.available).toBe(2)
  })

  test("prefix evidence the paired reader refuses: nothing cancels, and no contrast is counted", async () => {
    const { root } = await bundleAt({ paired: { prefixOver: { 2: { forked: false } } } })
    const text = await textOf(root)
    expect(text).toContain("block 2: WITHHELD")
    const cost = section(text, "COST — ")
    const block2 = cost.slice(cost.indexOf("BLOCK 2"), cost.indexOf("BLOCK 3"))
    expect(block2).toContain("ONE SHARED PREFIX IS NOT ESTABLISHED")
    expect(block2).toContain("the paired reader does not accept this block's prefix evidence")
    expect(block2).toContain("`forked: false`")
    expect(block2).not.toContain("ON − OFF newly executed: exactly")
    const report = await reportOf(root)
    expect(report.availability.find((entry) => entry.quantity === "cost contrast")!.available).toBe(2)
  })

  test("prefix evidence naming another run: nothing cancels", async () => {
    const { root } = await bundleAt({ paired: { prefixOver: { 3: { prefixRunId: known("run-prefix-elsewhere") } } } })
    const cost = section(await textOf(root), "COST — ")
    const block3 = cost.slice(cost.indexOf("BLOCK 3"))
    expect(block3).toContain("ONE SHARED PREFIX IS NOT ESTABLISHED")
    expect(block3).toContain("the prefix evidence records prefix run `run-prefix-elsewhere`, not the arms' `run-prefix-3`")
    expect(block3).not.toContain("ON − OFF newly executed: exactly")
  })

  test("unknown usage on both sides: no contrast, and nothing subtracted", async () => {
    const { root } = await bundleAt({
      spend: (_block, arm) => ({ ...DEFAULT_SPEND[arm], here: { ...DEFAULT_SPEND[arm].here, unknown: [`exec-${arm}`] } }),
    })
    const cost = section(await textOf(root), "COST — ")
    expect(cost).toContain("ON − OFF newly executed: unavailable — both continuations are lower bounds only")
    expect(cost).not.toContain("180 tokens")
  })

  test("an unaudited branch with a zero counter is an observed lower bound, never exact", async () => {
    const { root } = await bundleAt({
      spend: (_block, arm) => (arm === "on" ? { ...DEFAULT_SPEND.on, completeness: "unaudited" } : DEFAULT_SPEND.off),
    })
    const cost = section(await textOf(root), "COST — ")
    expect(cost).toContain("usage unaudited")
    expect(cost).toContain("OBSERVED LOWER BOUND")
    expect(cost).toContain("at least 180 tokens")
    expect(cost).not.toContain("exactly")
    expect(cost).toContain("— UNAUDITED")
  })

  test("prefixes that disagree: nothing cancels, both attributed views print, the reason is named", async () => {
    const { root } = await bundleAt({
      spend: (_block, arm) => (arm === "on" ? { ...DEFAULT_SPEND.on, prefix: { tokens: 150, turns: 2 } } : DEFAULT_SPEND.off),
    })
    const cost = section(await textOf(root), "COST — ")
    expect(cost).toContain("ONE SHARED PREFIX IS NOT ESTABLISHED — nothing cancels")
    expect(cost).toContain("the inherited slices differ")
    expect(cost).toContain("attributed 450 tokens over 7 turn(s)")
    expect(cost).toContain("attributed 220 tokens over 5 turn(s)")
    expect(cost).toContain("ON − OFF newly executed: unavailable")
  })

  test("differing inherited unknown identities: nothing cancels", async () => {
    const { root } = await bundleAt({
      spend: (_block, arm) => ({ ...DEFAULT_SPEND[arm], prefix: { tokens: 100, turns: 2, unknown: [`exec-${arm}`] } }),
    })
    expect(section(await textOf(root), "COST — ")).toContain("the inherited unknown-usage identities differ")
  })

  test("a manifest with no `spend.origin`: that arm's cost is unavailable with the reason, never zero", async () => {
    const { root } = await bundleAt({
      arm: (spec) => (spec.block === 1 && spec.arm === "off" ? { ...spec, over: { ...spec.over, origin: undefined } } : spec),
    })
    const cost = section(await textOf(root), "COST — ")
    const block1 = cost.slice(cost.indexOf("BLOCK 1"), cost.indexOf("BLOCK 2"))
    expect(block1).toContain("cost UNAVAILABLE")
    expect(block1).toContain("spend.origin")
    expect(block1).toContain("continuation executed here 300 tokens")
  })

  test("`armCost` itself names a missing `spend.origin`", async () => {
    const { root } = await bundleAt()
    const paired = await pairedOf(root)
    const arm = paired.blocks[0]!.arms[0]!
    delete (arm.row.manifest.spend as { origin?: unknown }).origin
    const cost = armCost(arm)
    expect(cost.kind).toBe("unavailable")
    if (cost.kind === "unavailable") expect(cost.reason).toContain("never zero")
    expect(blockCost(paired.blocks[0]!).kind).toBe("unavailable")
  })

  test("`costContrast` never subtracts an unknown", () => {
    const base = {
      kind: "read" as const,
      runId: "r",
      completion: "completed",
      stopped: null,
      usageCompleteness: "incomplete",
      exposure: "unquantified",
      attributed: { tokens: 0, turns: 0, unknown: 0 },
      inherited: { tokens: 0, turns: 0, unknown: 0 },
      prefixRunId: "p",
      forkedFrom: "p",
      inheritedKinds: "",
      inheritedUnknownIds: [],
    }
    const on = { ...base, arm: "on" as const, executedHere: { tokens: 10, turns: 1, unknown: 1 }, continuation: "lower-bound" as const, why: "unknown" }
    const off = { ...base, arm: "off" as const, executedHere: { tokens: 4, turns: 1, unknown: 1 }, continuation: "lower-bound" as const, why: "unknown" }
    expect(costContrast(on, off).kind).toBe("unavailable")
    expect(costContrast(on, { ...off, continuation: "exact", why: null })).toMatchObject({ kind: "at-least", tokens: 6 })
  })
})

describe("treatment opportunity", () => {
  test("zero contested candidates: no treatment opportunity, neither benefit nor failure", async () => {
    const { root } = await bundleAt({
      arm: (spec) => (spec.arm === "off" ? { ...spec, intervention: { toJudge: 4, wouldHaveDebated: 0 } } : spec),
    })
    const text = await textOf(root)
    expect(text).toContain("normal policy would have debated 0 of 4 candidates")
    expect(text).toContain(NO_TREATMENT_OPPORTUNITY)
  })
})

describe("a repeated prefix, coverage lists and missing manifests", () => {
  test("a withheld block supplies no pair, so a later measured block on its prefix is counted", async () => {
    const { root } = await bundleAt({
      prefixRunIds: { 2: "run-prefix-1" },
      written: (fakes) =>
        fakes.map((fake) =>
          fake.repeatId === 0 && fake.armId === "on"
            ? {
                ...fake,
                completion: "unfinished",
                finishedAt: unknownValue("the continuation threw"),
                experiment: { ...(fake.experiment as object), failure: "the provider hung up" },
              }
            : fake,
        ),
    })
    const text = await textOf(root)
    expect(text).toContain("block 1: WITHHELD")
    expect(text).not.toContain("NOT COUNTED")
    expect(text).toContain("completed: 2 of 3")
  })

  test("two blocks continuing one prefix: the second block's quantities are unavailable, and it is not counted", async () => {
    const { root } = await bundleAt({ prefixRunIds: { 2: "run-prefix-1" } })
    const text = await textOf(root)
    const reason = "it continues prefix `run-prefix-1`, which block 1 already supplied; one shared prefix is one pair"
    expect(text).toContain("completed: 2 of 3")
    expect(text).toContain("block 2: NOT COUNTED — a repeated discovery pass")
    expect(text).toContain("precision difference: 2/3")
    expect(text).toContain(`pair difference ON − OFF: UNAVAILABLE — ${reason}`)
    expect(text).toContain("no three-pair summary")
    expect(text).not.toContain("observed spread: mean")
    for (const heading of ["FINAL RECALL — ", "COST — ", "TREATMENT OPPORTUNITY — "]) {
      const part = section(text, heading)
      expect(part.slice(part.indexOf("BLOCK 2"), part.indexOf("BLOCK 3")), heading).toContain(reason)
    }
    const report = await reportOf(root)
    for (const entry of report.availability) {
      expect(entry.available, entry.quantity).toBe(2)
      expect(entry.missing[0]!.reason, entry.quantity).toContain(reason)
    }
  })

  test("a repeated prefix keeps its block's own cost reasons beside the repeat", async () => {
    const { root } = await bundleAt({ prefixRunIds: { 2: "run-prefix-1" } })
    const paired = await pairedOf(root)
    const block = paired.blocks.find((entry) => entry.block === 2)!
    block.prefix = { ...block.prefix, evidence: { ...block.prefix.evidence!, failure: "discovery threw" } }
    const report = readEvaluationReport(
      { kind: "read", value: paired },
      await settle(() => readLabelledBundle(paired)),
      await settle(() => readAdjudicationBundle(paired)),
    )
    const cost = section(renderEvaluationReport(report), "COST — ")
    const block2 = cost.slice(cost.indexOf("BLOCK 2"), cost.indexOf("BLOCK 3"))
    expect(block2).toContain("which block 1 already supplied")
    expect(block2).toContain(`the prefix FAILED (discovery threw); what it spent is recorded in \`${JOURNAL_FILE}\``)
  })

  test("coverage lists unfinished slots, an excluded arm, a withheld block's reasons and the halt marker", async () => {
    const { root } = await bundleAt({
      written: (fakes) => fakes.filter((fake) => !(fake.repeatId === 2 && fake.armId === "off")),
      paired: { slots: "started-only" },
    })
    await writeFile(join(root, HALT_MARKER_FILE), JSON.stringify({ haltReason: "unknown usage on a billed request" }))
    const coverage = section(await textOf(root), "EXECUTION COVERAGE — ")
    expect(coverage).toContain("THE EXPERIMENT HALT is halted")
    expect(coverage).toContain("unknown usage on a billed request")
    expect(coverage).toContain("SLOTS THAT DID NOT COMPLETE")
    expect(coverage).toMatch(/block 1 on: unfinished — `paired-slots\.jsonl` records this slot as started/)
    expect(coverage).toContain("ARMS OUT OF EVERY PAIR")
    expect(coverage).toMatch(/off\/2 — missing — /)
    expect(coverage).toContain("block 3: WITHHELD")
    expect(coverage).toContain("a paired quantity needs exactly two arms")
  })

  test("a missing arm manifest over a healthy prefix: the gap and the journal are named, and no contrast prints", async () => {
    const { root } = await bundleAt({ written: (fakes) => fakes.filter((fake) => !(fake.repeatId === 2 && fake.armId === "off")) })
    const cost = section(await textOf(root), "COST — ")
    const block3 = cost.slice(cost.indexOf("BLOCK 3"), cost.indexOf("No experiment total"))
    expect(block3).toContain("no `off` arm manifest was bound to block 3")
    expect(block3).toContain(`\`${JOURNAL_FILE}\` holds what was issued`)
    expect(block3).not.toContain("ON − OFF newly executed")
    expect(block3).toContain("continuation executed here 300 tokens")
  })
})

describe("upstream results that cannot be read", () => {
  test("an adjudication partition that disagrees: precision and lost candidates unavailable, no point or bound", async () => {
    const { root } = await bundleAt()
    const text = await textOf(root, (adjudication) => {
      if (adjudication.kind !== "read") return
      const block = adjudication.blocks.find((entry) => entry.block === 1)!.result
      if (block.kind === "read" && block.truth.kind === "labelled") block.truth.accounting = { ...block.truth.accounting, agree: false }
    })
    const precision = section(text, "PRECISION — ")
    const block1 = precision.slice(precision.indexOf("BLOCK 1"), precision.indexOf("BLOCK 2"))
    expect(block1).toContain("UNAVAILABLE")
    expect(block1).toContain("the adjudication partition does not cover its pool")
    expect(block1).not.toContain("point")
    expect(block1).not.toContain("shared-label bound")
    const recall = section(text, "FINAL RECALL — ")
    expect(recall.slice(recall.indexOf("BLOCK 1"), recall.indexOf("BLOCK 2"))).toContain(
      "lost true candidates: unavailable — the adjudication partition does not cover its pool",
    )
  })

  test("counts that do not partition N are unavailable, and nothing is divided", () => {
    const on = counts("on", { upheld: 3, trueDefects: ["a"], falsePositives: ["b"] })
    const off = counts("off", { upheld: 1, trueDefects: ["a"] })
    const difference = pairDifference(on, off)
    expect(difference.kind).toBe("unavailable")
    if (difference.kind === "unavailable") expect(difference.reason).toContain("TP 1 + FP 1 + U 0 is not N 3")
  })

  test("one block whose composition throws is unavailable with the message; the others still read", async () => {
    const { root } = await bundleAt()
    const text = await textOf(root, (adjudication) => {
      if (adjudication.kind !== "read") return
      const block = adjudication.blocks.find((entry) => entry.block === 2)!.result
      if (block.kind === "read" && block.truth.kind === "labelled") {
        Object.defineProperty(block.truth, "falsePositives", {
          get() {
            throw new Error("boom")
          },
        })
      }
    })
    expect(text).not.toContain("NOT COMPOSED")
    expect(text).toContain("block 2 could not be composed: boom")
    expect(text).toContain("arm on, run `run-on-0`: point 1")
    expect(text).toContain("arm on, run `run-on-2`: point 1")
  })

  test("a paired reader that threw: the report is NOT COMPOSED, with the message", () => {
    const outcome = readEvaluationReport(
      { kind: "threw", message: "the bundle vanished" },
      { kind: "threw", message: "unused" },
      { kind: "threw", message: "unused" },
    )
    expect(outcome.kind).toBe("unavailable")
    expect(renderEvaluationReport(outcome)).toBe(
      "MAD EVALUATION REPORT — NOT COMPOSED\n  the paired reader threw: the bundle vanished\n",
    )
  })

  test("`eval-read` prints each thrown reader's line in its own position, and the report after them", async () => {
    const { root } = await bundleAt()
    const { text } = await captured(() =>
      evalReadMain(["bun", "eval-read", "--bundle", root], {
        labelled: () => Promise.reject(new Error("labelled blew up")),
        adjudication: () => Promise.reject(new Error("adjudication blew up")),
      }),
    )
    const order = [
      "MAD PAIRED CONTRAST",
      "MAD labelled reader — labelled blew up",
      "MAD adjudication reader — adjudication blew up",
      "MAD EVALUATION REPORT — SYNTHETIC",
    ]
    const positions = order.map((line) => text.indexOf(line))
    for (const [index, position] of positions.entries()) expect(position, order[index]).toBeGreaterThanOrEqual(0)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  test("one reader throwing alone suppresses nothing the other reader supplies", async () => {
    const { root } = await bundleAt()
    const labelledThrew = await captured(() =>
      evalReadMain(["bun", "eval-read", "--bundle", root], { labelled: () => Promise.reject(new Error("labelled blew up")) }),
    )
    const precision = section(labelledThrew.text, "PRECISION — ")
    expect(precision).toContain("arm on, run `run-on-0`: point 1")
    expect(precision).toContain("pair difference ON − OFF")
    expect(section(labelledThrew.text, "FINAL RECALL — ")).toContain("the labelled reader threw: labelled blew up")

    const adjudicationThrew = await captured(() =>
      evalReadMain(["bun", "eval-read", "--bundle", root], { adjudication: () => Promise.reject(new Error("adjudication blew up")) }),
    )
    const recall = section(adjudicationThrew.text, "FINAL RECALL — ")
    expect(recall).not.toContain("the labelled reader threw")
    expect(recall).toMatch(/matcher recall[^\n]*\d+ of \d+/)
    expect(section(adjudicationThrew.text, "PRECISION — ")).toContain("the adjudication reader threw: adjudication blew up")
  })

  test("an explicit `undefined` reader keeps the shipped reader", async () => {
    const { root } = await bundleAt()
    const { text } = await captured(() =>
      evalReadMain(["bun", "eval-read", "--bundle", root], { labelled: undefined, adjudication: undefined }),
    )
    expect(text).toContain("MAD LABELLED RECALL")
    expect(text).toContain("MAD ADJUDICATION")
  })
})

describe("prefix identity", () => {
  test("an inherited unknown count with fewer named identities establishes no prefix", async () => {
    const { root } = await bundleAt()
    const paired = await pairedOf(root)
    const block = paired.blocks[0]!
    for (const arm of block.arms) {
      const origin = (arm.row.manifest.spend as unknown as { origin: { inherited: { unknown: number } } }).origin
      origin.inherited.unknown = 1
    }
    const cost = blockCost(block)
    expect(cost.kind).toBe("read")
    if (cost.kind !== "read") return
    expect(cost.prefix.kind).toBe("not-established")
    if (cost.prefix.kind === "not-established") {
      expect(cost.prefix.reasons.join("; ")).toContain("inherited 1 unknown execution(s) but names only 0")
    }
    expect(cost.contrast.kind).toBe("unavailable")
  })
})
