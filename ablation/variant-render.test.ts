/**
 * The debate-variants report and its `eval-read` entry: the renderer over a
 * scripted bundle, and `main` dispatching a debate-variants bundle, a claimed
 * but invalid one, one with no bundle index, and leaving a routing bundle as it was.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ZodType } from "zod"

import { emptyTokenUsage } from "../core/domain/run-record.ts"
import { CODING_DISCOVERY_GENERALIST } from "../core/instructions/coding/discovery.ts"
import type { BackendCapabilities, Envelope, ModelBackend } from "../core/ports/model-backend.ts"
import { selectRoster } from "../core/roster/select.ts"
import { candidate, DEFAULT_JUDGE_ANSWERS, fakeChange, fakeClock, judgeRoleOf } from "../core/test-support/fakes.ts"
import { SEEDED_CHANGE } from "../fixtures/seeded-defects/material.ts"
import { LABELLED_CHANGE_SEAL } from "../fixtures/seeded-defects/seal.ts"
import { main as evalReadMain } from "../scripts/eval-read.ts"
import { ADJUDICATION_SHEET_FILE, ADJUDICATION_SHEET_VERSION } from "./adjudication-read.ts"
import { ADVERSARIAL_DIRECTORY, ADVERSARIAL_SCHEDULE_FILE } from "./adversarial-schedule.ts"
import { BUNDLE_FILE } from "./bundle.ts"
import { readBundle } from "./read-bundle.ts"
import { known } from "./manifest.ts"
import { createSchedule, SCHEDULE_FILE, sha256 } from "./schedule.ts"
import { runVariantBlocks } from "./variant-runner.ts"
import { evaluatePromotion, precisionUnavailable, readVariantPrecision } from "./variant-promotion.ts"
import { readVariantBundle } from "./variant-read.ts"
import { renderVariantReport } from "./variant-render.ts"
import { createVariantSchedule, variantScheduleHashOf } from "./variant-schedule.ts"
import { VARIANT_PROTOCOL_ID } from "./variants.ts"

const WORKTREE = new URL("..", import.meta.url).pathname
const ROUTING_PROTOCOL = new URL("../_bmad-output/specs/spec-mad-orchestrator/evaluation-protocol.md", import.meta.url).pathname

const scratch: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-variant-render-"))
  scratch.push(dir)
  return dir
}
afterEach(async () => {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})

const CRITICAL = {
  findings: [{ claim: "The fee is applied before the rate is validated.", reasoning: "NaN total.", severity: "critical", file: "src/pay.ts", startLine: 1, endLine: 1 }],
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
        const payload = role !== undefined ? DEFAULT_JUDGE_ANSWERS[role] : instructions === CODING_DISCOVERY_GENERALIST.text ? CRITICAL : { turns: [] }
        return { ok: true, slot, value: schema.parse(payload), tokens: { ...emptyTokenUsage(), input: 10, output: 20 } }
      },
    }),
  })
  if (!outcome.ok) throw new Error(outcome.reason)
  return { root, outcome }
}

async function captured(root: string): Promise<{ code: number; text: string }> {
  const lines: string[] = []
  const log = console.log
  console.log = (...args: unknown[]) => void lines.push(args.join(" "))
  let code: number
  try {
    code = await evalReadMain(["bun", "eval-read", "--bundle", root])
  } finally {
    console.log = log
  }
  return { code, text: lines.join("\n") }
}

describe("renderVariantReport", () => {
  test("blocks and arms in scheduled order, status and binding apart, exact fractions, arm-specific rows only on their arm, every gate", async () => {
    const { root } = await bundle()
    const read = await readVariantBundle(root)
    if (read.kind !== "read") throw new Error(read.reason)
    const precision = await readVariantPrecision(read)
    const text = renderVariantReport(read, precision, evaluatePromotion(read, precision))
    expect(text).toContain("block 1 order: baseline, references, open-questions")
    const order = ["Block 1", "  baseline (first)", "  references (second)", "  open-questions (third)", "Block 2", "Block 3", "Promotion"]
    let at = 0
    for (const marker of order) {
      const next = text.indexOf(marker, at)
      expect(next, marker).toBeGreaterThanOrEqual(at)
      at = next
    }
    expect(text).toContain("    status: completed (run ")
    expect(text).toContain("    binding: bound")
    expect(text).toContain("recall 0/13")
    expect(text).toContain("adjudication sheet: absent (no adjudication sheet")
    expect(text).toContain("precision missing (no adjudication sheet")
    // Arm-specific rows only on their arm.
    expect(text.split("position changes").length - 1).toBe(3)
    expect(text.split("open questions recorded").length - 1).toBe(3)
    expect(text).toContain("cited share not applicable (no position changed")
    expect(text).toContain("reached a Fact-Checker prompt missing (the bundle holds no issued-prompt evidence")
    for (const variant of ["references", "open-questions"]) expect(text).toContain(`  ${variant}: NOT PROMOTED`)
    for (const gate of ["coverage", "recall", "precision", "cost", "unknown-usage"]) expect(text).toContain(`    ${gate}: `)
    expect(text).toContain("      - no readable adjudication sheet")
    expect(text).toContain("This report changes no default.")
  })

  test("a sheet gives exact intervals and the page state; a failed precision reader fails the precision gate with its reason", async () => {
    const { root } = await bundle()
    const read = await readVariantBundle(root)
    if (read.kind !== "read") throw new Error(read.reason)
    const blocks = await Promise.all(
      read.blocks.map(async (block) => {
        const record = JSON.parse(await readFile(join(root, "prefix", String(block.block - 1), block.prefix.runId!, "record.json"), "utf8"))
        return { block: block.block, prefixRunId: block.prefix.runId!, rows: record.findings.map((finding: { id: string }) => ({ candidateId: finding.id, truth: "true-defect" })) }
      }),
    )
    await writeFile(join(root, ADJUDICATION_SHEET_FILE), JSON.stringify({ adjudicationSheetVersion: ADJUDICATION_SHEET_VERSION, scheduleHash: read.schedule.scheduleHash, blocks }))
    const precision = await readVariantPrecision(read)
    const text = renderVariantReport(read, precision, evaluatePromotion(read, precision))
    expect(text).toMatch(/precision \[1\/1, 1\/1\] \(TP 1, U 0, N 1; page filled\)/)
    expect(text).toContain("blind labelling is a procedure this file cannot show")

    const failed = precisionUnavailable(read, "the precision reader failed: boom")
    const failedText = renderVariantReport(read, failed, evaluatePromotion(read, failed))
    expect(failedText).toContain("adjudication sheet: unreadable (the precision reader failed: boom)")
    expect(failedText).toContain("      - no readable adjudication sheet: the precision reader failed: boom")
  })
})

describe("eval-read", () => {
  test("a debate-variants bundle prints the bundle summary and the variant report, not the routing readers' refusals", async () => {
    const { root } = await bundle()
    const { code, text } = await captured(root)
    expect(code).toBe(0)
    expect(text).toContain("MAD debate-variants report")
    expect(text).toContain("Promotion (ablation/DEBATE-VARIANTS.md)")
    expect(text).not.toContain("has schedule version 2")
    expect(text).not.toContain("MAD paired reader")
  })

  test("a document claiming the debate-variants design but invalid gets that design's refusal", async () => {
    const { root } = await bundle()
    const file = join(root, SCHEDULE_FILE)
    const schedule = JSON.parse(await readFile(file, "utf8"))
    schedule.draw = 99
    schedule.scheduleHash = variantScheduleHashOf(schedule)
    await writeFile(file, JSON.stringify(schedule))
    const { code, text } = await captured(root)
    expect(code).toBe(0)
    expect(text).toContain("MAD debate-variants reader — the schedule at")
    expect(text).toContain("carries no draw from 0 to 11")
    expect(text).not.toContain("has schedule version 2")
  })

  test("a version-2 document missing its design marker is still refused by the debate-variants validator", async () => {
    const { root } = await bundle()
    const file = join(root, SCHEDULE_FILE)
    const schedule = JSON.parse(await readFile(file, "utf8"))
    delete schedule.design
    schedule.scheduleHash = variantScheduleHashOf(schedule)
    await writeFile(file, JSON.stringify(schedule))
    const { text } = await captured(root)
    expect(text).toContain("MAD debate-variants reader — the schedule at")
    expect(text).toContain("has design undefined")
    expect(text).not.toContain("MAD paired reader")
  })

  test("with no bundle index, the ordinary refusal prints and the variant report still frames the nine slots", async () => {
    const { root } = await bundle()
    await unlink(join(root, BUNDLE_FILE))
    const { code, text } = await captured(root)
    expect(code).toBe(0)
    expect(text).toContain("MAD evaluation reader — ")
    expect(text).toContain("MAD debate-variants report")
    expect(text.split("    binding: NOT bound").length - 1).toBe(9)
  })

  test("a root with a debate-variants schedule, an adversarial schedule and no bundle index prints both reports", async () => {
    const { root } = await bundle()
    await unlink(join(root, BUNDLE_FILE))
    await mkdir(join(root, ADVERSARIAL_DIRECTORY))
    await writeFile(join(root, ADVERSARIAL_DIRECTORY, ADVERSARIAL_SCHEDULE_FILE), "{}")
    const { code, text } = await captured(root)
    expect(code).toBe(0)
    expect(text).not.toContain("holds no paired or ordinary bundle")
    expect(text).toContain("MAD evaluation reader — ")
    expect(text).toContain("MAD debate-variants report")
    expect(text.split("    binding: NOT bound").length - 1).toBe(9)
    // The independent adversarial report still follows.
    expect(text.indexOf("MAD debate-variants report")).toBeLessThan(text.lastIndexOf("dversarial"))
  })

  test("an unreadable schedule document still gets the routing refusal, and readBundle takes the presence it is given", async () => {
    const { root } = await bundle()
    await unlink(join(root, SCHEDULE_FILE))
    await mkdir(join(root, SCHEDULE_FILE))
    const { code, text } = await captured(root)
    expect(code).toBe(0)
    expect(text).not.toContain("MAD debate-variants")
    expect(text).toContain("no readable schedule at")
    const told = await readBundle(root, { sealedSchedule: false })
    expect("error" in told ? null : told.sealedSchedule).toBe(false)
  })

  test("a routing bundle takes the routing path as before", async () => {
    const root = await tempDir()
    const resolved = selectRoster([candidate("anthropic", "claude-sonnet-4-5")], { slots: 1, providerConfigKey: "provider" })
    const created = await createSchedule({
      bundleRoot: root,
      protocolFile: ROUTING_PROTOCOL,
      fixture: LABELLED_CHANGE_SEAL,
      codeRevision: known({ commit: "abc", dirty: false }),
      roster: resolved.roster,
      change: fakeChange(),
      config: { provenance: "scripted" },
      createdAt: "2026-11-19T00:00:00.000Z",
      coin: () => "heads",
    })
    expect(created.ok).toBe(true)
    await writeFile(join(root, BUNDLE_FILE), JSON.stringify({ schemaVersion: 1, createdAt: "2026-11-19T00:00:00.000Z", arms: [] }))
    const { code, text } = await captured(root)
    expect(code).toBe(0)
    expect(text).not.toContain("MAD debate-variants")
  })
})
