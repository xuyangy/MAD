/**
 * Precision from the blind sheet over a real scripted bundle, and the pure
 * promotion gates over constructed reads at and just past every limit.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ZodType } from "zod"

import { emptyTokenUsage } from "../core/domain/run-record.ts"
import { CODING_DISCOVERY_GENERALIST } from "../core/instructions/coding/discovery.ts"
import type { BackendCapabilities, Envelope, ModelBackend } from "../core/ports/model-backend.ts"
import { selectRoster } from "../core/roster/select.ts"
import { candidate, DEFAULT_JUDGE_ANSWERS, fakeClock, judgeRoleOf } from "../core/test-support/fakes.ts"
import { SEEDED_CHANGE } from "../fixtures/seeded-defects/material.ts"
import { LABELLED_CHANGE_SEAL } from "../fixtures/seeded-defects/seal.ts"
import { ADJUDICATION_SHEET_FILE, ADJUDICATION_SHEET_VERSION } from "./adjudication-read.ts"
import { known } from "./manifest.ts"
import { sha256 } from "./schedule.ts"
import { runVariantBlocks } from "./variant-runner.ts"
import { evaluatePromotion, readVariantPrecision, type GateName, type PrecisionInterval, type PrecisionRead } from "./variant-promotion.ts"
import { readVariantBundle, type ContinuationMeasures, type ContinuationRead, type Measure, type VariantReadOutcome } from "./variant-read.ts"
import { createVariantSchedule } from "./variant-schedule.ts"
import { VARIANT_PROTOCOL_ID } from "./variants.ts"

const WORKTREE = new URL("..", import.meta.url).pathname

const scratch: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-variant-promotion-"))
  scratch.push(dir)
  return dir
}
afterEach(async () => {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Precision over a real bundle
// ---------------------------------------------------------------------------

const FINDINGS = {
  findings: [
    { claim: "The fee is applied before the rate is validated.", reasoning: "NaN total.", severity: "critical", file: "src/pay.ts", startLine: 1, endLine: 1 },
    { claim: "The retry loop never stops.", reasoning: "No ceiling.", severity: "high", file: "src/retry.ts", startLine: 3, endLine: 3 },
  ],
}

async function bundle() {
  const root = await tempDir()
  const dir = await tempDir()
  const pending = `---\nid: ${VARIANT_PROTOCOL_ID}\nstatus: frozen\nversion: 1\nfrozen_hash: PENDING\n---\n\n# test\n`
  const protocolFile = join(dir, "protocol.md")
  await writeFile(protocolFile, pending.replace("frozen_hash: PENDING", `frozen_hash: ${sha256(pending)}`))
  const resolved = selectRoster([candidate("anthropic", "claude-sonnet-4-5"), candidate("openai", "gpt-5")], { slots: 2, providerConfigKey: "provider" })
  const base = {
    bundleRoot: root,
    protocolFile,
    fixture: LABELLED_CHANGE_SEAL,
    codeRevision: known({ commit: "abc123", dirty: false }),
    roster: resolved.roster,
    change: SEEDED_CHANGE,
    config: { provenance: "scripted" as const },
  }
  const created = await createVariantSchedule({ ...base, createdAt: "2026-11-19T00:00:00.000Z", draw: () => 0 })
  if (!created.ok) throw new Error(created.reason)
  const outcome = await runVariantBlocks({
    ...base,
    worktree: WORKTREE,
    priorWarnings: resolved.warnings,
    clock: fakeClock(),
    backendFor: (): ModelBackend => ({
      capabilities: (): BackendCapabilities => ({ tools: true }),
      async runTurn<T>(slot: string, instructions: string, _prompt: string, schema: ZodType<T>): Promise<Envelope<T>> {
        const role = judgeRoleOf(instructions)
        const payload = role !== undefined ? DEFAULT_JUDGE_ANSWERS[role] : instructions === CODING_DISCOVERY_GENERALIST.text ? FINDINGS : { turns: [] }
        return { ok: true, slot, value: schema.parse(payload), tokens: { ...emptyTokenUsage(), input: 10, output: 20 } }
      },
    }),
  })
  if (!outcome.ok) throw new Error(outcome.reason)
  const read = await readVariantBundle(root)
  if (read.kind !== "read") throw new Error(read.reason)
  return { root, read, outcome }
}

/** The canonical ids of each block's prefix pool, from the prefix records. */
async function pools(root: string, read: Extract<VariantReadOutcome, { kind: "read" }>) {
  const result = new Map<number, { prefixRunId: string; ids: string[] }>()
  for (const block of read.blocks) {
    const runId = block.prefix.runId!
    const record = JSON.parse(await readFile(join(root, "prefix", String(block.block - 1), runId, "record.json"), "utf8"))
    result.set(block.block, { prefixRunId: runId, ids: record.findings.map((finding: { id: string }) => finding.id) })
  }
  return result
}

async function writeSheet(root: string, read: Extract<VariantReadOutcome, { kind: "read" }>, label: (block: number, id: string, index: number) => string | null, extra: Record<string, unknown> = {}) {
  const byBlock = await pools(root, read)
  const blocks = [...byBlock].map(([block, page]) => ({
    block,
    prefixRunId: page.prefixRunId,
    rows: page.ids.flatMap((id, index) => {
      const truth = label(block, id, index)
      return truth === null ? [] : [{ candidateId: id, truth }]
    }),
  }))
  await writeFile(join(root, ADJUDICATION_SHEET_FILE), JSON.stringify({ adjudicationSheetVersion: ADJUDICATION_SHEET_VERSION, scheduleHash: read.schedule.scheduleHash, blocks, ...extra }))
}

describe("precision from the blind sheet", () => {
  test("a filled page gives every bound arm TP, U, N and a filled interval; unresolved labels count in U", async () => {
    const { root, read } = await bundle()
    await writeSheet(root, read, (_block, _id, index) => (index === 0 ? "true-defect" : "unresolved"))
    const precision = await readVariantPrecision(read)
    expect(precision.sheet).toBe("read")
    expect(precision.sheetProblem).toBeNull()
    for (const block of precision.blocks) {
      for (const arm of ["baseline", "references", "open-questions"]) {
        const value = block.arms[arm]!
        if (value.kind !== "measured") throw new Error(`${block.block} ${arm}: ${value.kind}`)
        expect(value.value.filled).toBe(true)
        expect(value.value.tp + value.value.u).toBeLessThanOrEqual(value.value.n)
        expect(value.value.n).toBeGreaterThan(0)
      }
    }
  })

  test("a partial page still gives intervals, marked not filled, and missing labels count in U", async () => {
    const { root, read } = await bundle()
    await writeSheet(root, read, (_block, _id, index) => (index === 0 ? "true-defect" : null))
    const precision = await readVariantPrecision(read)
    const value = precision.blocks[0]!.arms.baseline!
    if (value.kind !== "measured") throw new Error(value.kind)
    expect(value.value.filled).toBe(false)
    expect(value.value.u).toBeGreaterThan(0)
  })

  test("no sheet, a page against another prefix run, and a duplicate row leave precision missing with the reason", async () => {
    const { root, read } = await bundle()
    const absent = await readVariantPrecision(read)
    expect(absent.sheetProblem).toContain("no adjudication sheet")
    expect(absent.blocks[0]!.arms.baseline).toMatchObject({ kind: "missing" })

    const byBlock = await pools(root, read)
    const page1 = byBlock.get(1)!
    await writeFile(
      join(root, ADJUDICATION_SHEET_FILE),
      JSON.stringify({
        adjudicationSheetVersion: ADJUDICATION_SHEET_VERSION,
        scheduleHash: read.schedule.scheduleHash,
        blocks: [
          { block: 1, prefixRunId: "another-run", rows: page1.ids.map((id) => ({ candidateId: id, truth: "true-defect" })) },
          { block: 2, prefixRunId: byBlock.get(2)!.prefixRunId, rows: [byBlock.get(2)!.ids[0]!, byBlock.get(2)!.ids[0]!].map((id) => ({ candidateId: id, truth: "true-defect" })) },
          { block: 3, prefixRunId: byBlock.get(3)!.prefixRunId, rows: byBlock.get(3)!.ids.map((id) => ({ candidateId: id, truth: "true-defect" })) },
        ],
      }),
    )
    const precision = await readVariantPrecision(read)
    expect(precision.blocks[0]!.arms.baseline).toMatchObject({ kind: "missing", reason: expect.stringContaining("another execution") })
    expect(precision.blocks[1]!.arms.references).toMatchObject({ kind: "missing", reason: expect.stringContaining("more than one row") })
    // The valid page of block 3 is kept.
    expect(precision.blocks[2]!.arms["open-questions"]!.kind).toBe("measured")
  })

  test("over a real bundle with every candidate a true defect, both variants pass precision", async () => {
    const { root, read } = await bundle()
    await writeSheet(root, read, () => "true-defect")
    const promotions = evaluatePromotion(read, await readVariantPrecision(read))
    for (const promotion of promotions) expect(promotion.gates.find((gate) => gate.gate === "precision")).toEqual({ gate: "precision", pass: true, reasons: [] })
  })
})

// ---------------------------------------------------------------------------
// The gates, over constructed reads
// ---------------------------------------------------------------------------

interface ArmSpec {
  found?: number
  unresolved?: number | null
  tokens?: number
  floor?: boolean
  unknown?: number | null
  attempts?: number | null
  precision?: { tp: number; u?: number; n: number; filled?: boolean } | null
}

const m = <T>(value: T): Measure<T> => ({ kind: "measured", value })
const gone = { kind: "missing" as const, reason: "test: not read" }

function arm(name: string, block: number, spec: ArmSpec): ContinuationRead {
  const measures: ContinuationMeasures = {
    recall: m({ found: spec.found ?? 5, of: 13, defectIds: [] }),
    unresolved: spec.unresolved === null ? gone : m(spec.unresolved ?? 0),
    verdicts: gone,
    tokens: m({ executedHere: spec.tokens ?? 1000, floor: spec.floor ?? false }),
    unknownTurns: spec.unknown === null ? gone : m(spec.unknown ?? 0),
    attempts: spec.attempts === null ? gone : m(spec.attempts ?? 10),
    references: gone,
    openQuestions: gone,
    questionsDelivered: gone,
  }
  return {
    slot: { block, arm: name as "baseline", position: "first" },
    status: { kind: "read", status: "completed", reason: "", runId: `${name}-${block}` },
    runId: `${name}-${block}`,
    problems: [],
    completed: true,
    measures,
  }
}

type BlockSpec = { baseline?: ArmSpec; references?: ArmSpec; "open-questions"?: ArmSpec; withheld?: string }

function constructed(blocks: BlockSpec[]): { read: Extract<VariantReadOutcome, { kind: "read" }>; precision: PrecisionRead } {
  const read = {
    kind: "read" as const,
    root: "/nowhere",
    schedule: { scheduleHash: "sha256:test" } as never,
    sealProblem: null,
    journalProblem: null,
    blocks: blocks.map((spec, index) => {
      const block = index + 1
      const continuations = (["baseline", "references", "open-questions"] as const).map((name) => arm(name, block, spec[name] ?? {}))
      return {
        block,
        prefix: {} as never,
        continuations,
        contrasts: (["references", "open-questions"] as const).map((variant) =>
          spec.withheld === undefined ? { variant, eligible: true as const } : { variant, eligible: false as const, reason: spec.withheld },
        ),
      }
    }),
  }
  const precision: PrecisionRead = {
    scheduleHash: "sha256:test",
    sheet: "read",
    sheetProblem: null,
    blocks: blocks.map((spec, index) => ({
      block: index + 1,
      arms: Object.fromEntries(
        (["baseline", "references", "open-questions"] as const).map((name) => {
          const p = spec[name]?.precision
          const value: Measure<PrecisionInterval> =
            p === null ? { kind: "not-applicable", reason: "test: N = 0" } : m({ tp: p?.tp ?? 4, u: p?.u ?? 0, n: p?.n ?? 5, filled: p?.filled ?? true })
          return [name, value]
        }),
      ),
    })),
  }
  return { read, precision }
}

/** The named gate's outcome for the references variant. */
function gate(blocks: BlockSpec[], name: GateName, precisionOverride?: (p: PrecisionRead) => PrecisionRead) {
  const { read, precision } = constructed(blocks)
  const promotion = evaluatePromotion(read, precisionOverride ? precisionOverride(precision) : precision).find((entry) => entry.variant === "references")!
  return promotion.gates.find((entry) => entry.gate === name)!
}

const three = (spec: BlockSpec = {}): BlockSpec[] => [spec, spec, spec]

describe("the gates", () => {
  test("recall above the baseline in one block promotes, and needs no unresolved count", () => {
    const { read, precision } = constructed([{ references: { found: 6, unresolved: null } }, {}, {}])
    const references = evaluatePromotion(read, precision).find((entry) => entry.variant === "references")!
    expect(references.gates.every((entry) => entry.pass)).toBe(true)
    expect(references.promote).toBe(true)
  })

  test("recall: below in any block fails; equal everywhere needs fewer unresolved in two blocks and more in none", () => {
    expect(gate([{ references: { found: 6 } }, { references: { found: 4 } }, {}], "recall").pass).toBe(false)
    expect(gate(three(), "recall").reasons[0]).toContain("in 0 block(s), not at least 2")
    expect(gate([{ baseline: { unresolved: 2 } }, { baseline: { unresolved: 1 } }, {}], "recall").pass).toBe(true)
    expect(gate([{ baseline: { unresolved: 2 } }, {}, {}], "recall").pass).toBe(false)
    expect(gate([{ baseline: { unresolved: 2 } }, { baseline: { unresolved: 1 } }, { references: { unresolved: 1 } }], "recall").reasons[0]).toContain("more findings unresolved")
    expect(gate([{ baseline: { unresolved: 2 } }, { baseline: { unresolved: null } }, {}], "recall").reasons[0]).toContain("unresolved count is missing")
  })

  test("precision: lower bound never below; equal passes; not filled, N = 0 and no sheet fail", () => {
    expect(gate(three(), "precision").pass).toBe(true)
    expect(gate([{ references: { precision: { tp: 3, n: 5 } } }, {}, {}], "precision").reasons[0]).toContain("below the baseline's 4/5")
    // The lower bound decides: 3/5 below 4/5 fails even though its upper bound (3+2)/5 is above.
    expect(gate([{ references: { precision: { tp: 3, u: 2, n: 5 } } }, {}, {}], "precision").pass).toBe(false)
    // 8/10 equals 4/5 by cross-product.
    expect(gate([{ references: { precision: { tp: 8, n: 10 } } }, {}, {}], "precision").pass).toBe(true)
    expect(gate([{ baseline: { precision: { tp: 4, n: 5, filled: false } } }, {}, {}], "precision").reasons[0]).toContain("does not label every candidate")
    expect(gate([{ references: { precision: null } }, {}, {}], "precision").reasons[0]).toContain("not-applicable")
    expect(gate(three(), "precision", (p) => ({ ...p, sheet: "absent", sheetProblem: "no adjudication sheet at x" })).reasons[0]).toContain("no readable adjudication sheet")
  })

  test("cost: tokens at 115% pass and just over fail, fractional included; attempts at max(110%, +2) pass and one over fails", () => {
    expect(gate(three({ references: { tokens: 1150 } }), "cost").pass).toBe(true)
    expect(gate(three({ references: { tokens: 1150.5 } }), "cost").pass).toBe(false)
    expect(gate(three({ baseline: { tokens: 0.5 }, references: { tokens: 0.575 } }), "cost").pass).toBe(true)
    // Exactly 115% as recorded decimals, though 0.0345 * 100 < 0.03 * 115 in floating point is false.
    expect(gate(three({ baseline: { tokens: 0.03 }, references: { tokens: 0.0345 } }), "cost").pass).toBe(true)
    expect(gate(three({ baseline: { tokens: 0.03 }, references: { tokens: 0.0345000001 } }), "cost").pass).toBe(false)
    // Both products would overflow to Infinity; the exact comparison still fails ten times the baseline.
    expect(gate(three({ baseline: { tokens: 1e307 }, references: { tokens: 1e308 } }), "cost").pass).toBe(false)
    expect(gate(three({ baseline: { tokens: 1e307 }, references: { tokens: 1.15e307 } }), "cost").pass).toBe(true)
    expect(gate(three({ baseline: { tokens: 0 }, references: { tokens: 0 } }), "cost").pass).toBe(true)
    expect(gate(three({ baseline: { tokens: 0 }, references: { tokens: 1 } }), "cost").pass).toBe(false)
    // Baseline 10: 110% is 11, +2 is 12, the larger allowance holds.
    expect(gate(three({ references: { attempts: 12 } }), "cost").pass).toBe(true)
    expect(gate(three({ references: { attempts: 13 } }), "cost").pass).toBe(false)
    // Baseline 40: 110% is 44.
    expect(gate(three({ baseline: { attempts: 40 }, references: { attempts: 44 } }), "cost").pass).toBe(true)
    expect(gate(three({ baseline: { attempts: 40 }, references: { attempts: 45 } }), "cost").pass).toBe(false)
    // Baseline 0: only +2.
    expect(gate(three({ baseline: { attempts: 0 }, references: { attempts: 2 } }), "cost").pass).toBe(true)
    expect(gate(three({ baseline: { attempts: 0 }, references: { attempts: 3 } }), "cost").pass).toBe(false)
  })

  test("cost: incomplete usage, a missing attempt count and a non-finite figure fail cost only", () => {
    expect(gate(three({ baseline: { floor: true } }), "cost").reasons[0]).toContain("not complete")
    expect(gate(three({ references: { unknown: 1 } }), "cost").reasons[0]).toContain("not complete")
    expect(gate(three({ references: { tokens: Number.POSITIVE_INFINITY } }), "cost").reasons[0]).toContain("not finite")
    const blocks = three({ references: { attempts: null } })
    expect(gate(blocks, "cost").reasons[0]).toContain("newly issued attempts is missing")
    expect(gate(blocks, "recall").reasons).not.toContain(expect.stringContaining("attempts"))
    expect(gate(blocks, "unknown-usage").pass).toBe(true)
  })

  test("unknown usage: more than the baseline fails; equal passes", () => {
    expect(gate(three({ baseline: { unknown: 1 }, references: { unknown: 1 } }), "unknown-usage").pass).toBe(true)
    expect(gate(three({ references: { unknown: 1 } }), "unknown-usage").pass).toBe(false)
    expect(gate(three({ references: { unknown: null } }), "unknown-usage").pass).toBe(false)
  })

  test("a withheld block fails coverage and gives no input to any other gate", () => {
    const blocks: BlockSpec[] = [{ references: { found: 6 } }, { withheld: "the block's baseline did not complete" }, {}]
    for (const name of ["coverage", "recall", "precision", "cost", "unknown-usage"] as const) {
      const result = gate(blocks, name)
      expect(result.pass, name).toBe(false)
      expect(result.reasons.some((reason) => reason.includes("block 2 is withheld")), name).toBe(true)
    }
  })

  test("with no sheet, precision names the sheet once and still names each withheld block", () => {
    const result = gate([{}, { withheld: "the block's baseline did not complete" }, {}], "precision", (p) => ({
      ...p,
      sheet: "absent",
      sheetProblem: "no adjudication sheet at x",
    }))
    expect(result.reasons).toEqual(["no readable adjudication sheet: no adjudication sheet at x", "block 2 is withheld: the block's baseline did not complete"])
  })

  test("precision read for another schedule gives this read no labels", () => {
    const result = gate(three(), "precision", (p) => ({ ...p, scheduleHash: "sha256:other" }))
    expect(result.pass).toBe(false)
    expect(result.reasons[0]).toContain("was read for schedule `sha256:other`")
  })

  test("fewer than three blocks fails coverage", () => {
    expect(gate([{}, {}], "coverage").reasons[0]).toContain("only 2 block(s)")
  })
})
