/**
 * The debate-variants reader over bundles written by `runVariantBlocks` with a
 * scripted backend: the nine-slot frame, binding, the three kinds of result,
 * the journal and ledger rules, and within-block contrast eligibility.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ZodType } from "zod"

import { spentTokens } from "../core/budget/ledger.ts"
import type { Entry, Finding } from "../core/domain/finding.ts"
import { emptyTokenUsage } from "../core/domain/run-record.ts"
import { CODING_DISCOVERY_GENERALIST } from "../core/instructions/coding/discovery.ts"
import type { BackendCapabilities, Envelope, ModelBackend } from "../core/ports/model-backend.ts"
import { selectRoster } from "../core/roster/select.ts"
import { forkPreparedReview } from "../core/run/review.ts"
import { candidate, DEFAULT_JUDGE_ANSWERS, fakeChange, fakeClock, judgeRoleOf } from "../core/test-support/fakes.ts"
import type { DefectMatcher } from "../fixtures/recall.ts"
import { SEEDED_DEFECTS } from "../fixtures/seeded-defects/labels.ts"
import { SEEDED_CHANGE } from "../fixtures/seeded-defects/material.ts"
import { LABELLED_CHANGE_SEAL } from "../fixtures/seeded-defects/seal.ts"
import { JOURNAL_FILE } from "./journal.ts"
import { known, MANIFEST_FILE } from "./manifest.ts"
import type { PairedPhaseContext } from "./paired.ts"
import { createSchedule, SCHEDULE_FILE, sha256, SLOT_STATUS_FILE } from "./schedule.ts"
import { runVariantBlocks } from "./variant-runner.ts"
import { readVariantBundle, referencesOf, type ContinuationRead } from "./variant-read.ts"
import { createVariantSchedule } from "./variant-schedule.ts"
import { VARIANT_PROTOCOL_ID } from "./variants.ts"

const WORKTREE = new URL("..", import.meta.url).pathname
const ROUTING_PROTOCOL = new URL("../_bmad-output/specs/spec-mad-orchestrator/evaluation-protocol.md", import.meta.url).pathname

const scratch: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-variant-read-"))
  scratch.push(dir)
  return dir
}
afterEach(async () => {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})

const CRITICAL = {
  findings: [
    {
      claim: "The fee is applied before the rate is validated.",
      reasoning: "A NaN rate silently yields a NaN total.",
      severity: "critical",
      file: "src/pay.ts",
      startLine: 1,
      endLine: 1,
    },
  ],
}

interface Call extends PairedPhaseContext {
  stage: "discover" | "debate" | "judge"
}

/** The first planted defect matches any finding: recall is 1 of the labels for an arm that upheld a finding. */
const MATCH_FIRST: DefectMatcher = (defect) => defect.id === SEEDED_DEFECTS[0]!.id

async function bundle(
  options: {
    draw?: number
    fail?: (call: Call) => boolean
    fixture?: typeof LABELLED_CHANGE_SEAL
    change?: ReturnType<typeof fakeChange>
    fork?: Parameters<typeof runVariantBlocks>[0]["fork"]
  } = {},
) {
  const root = await tempDir()
  const dir = await tempDir()
  const pending = `---\nid: ${VARIANT_PROTOCOL_ID}\nstatus: frozen\nversion: 1\nfrozen_hash: PENDING\n---\n\n# test\n`
  const protocolFile = join(dir, "protocol.md")
  await writeFile(protocolFile, pending.replace("frozen_hash: PENDING", `frozen_hash: ${sha256(pending)}`))
  const resolved = selectRoster([candidate("anthropic", "claude-sonnet-4-5"), candidate("openai", "gpt-5")], { slots: 2, providerConfigKey: "provider" })
  const base = {
    bundleRoot: root,
    protocolFile,
    fixture: options.fixture ?? LABELLED_CHANGE_SEAL,
    codeRevision: known({ commit: "abc123", dirty: false }),
    roster: resolved.roster,
    change: options.change ?? SEEDED_CHANGE,
    config: { provenance: "scripted" as const },
  }
  const created = await createVariantSchedule({ ...base, createdAt: "2026-11-19T00:00:00.000Z", draw: () => options.draw ?? 0 })
  if (!created.ok) throw new Error(created.reason)
  const calls: Call[] = []
  const outcome = await runVariantBlocks({
    ...base,
    worktree: WORKTREE,
    priorWarnings: resolved.warnings,
    clock: fakeClock(),
    ...(options.fork === undefined ? {} : { fork: options.fork }),
    backendFor: (context): ModelBackend => ({
      capabilities: (): BackendCapabilities => ({ tools: true }),
      async runTurn<T>(slot: string, instructions: string, _prompt: string, schema: ZodType<T>): Promise<Envelope<T>> {
        const role = judgeRoleOf(instructions)
        const stage = role !== undefined ? "judge" : instructions === CODING_DISCOVERY_GENERALIST.text ? "discover" : "debate"
        const call: Call = { ...context, stage }
        calls.push(call)
        if (options.fail?.(call) === true) throw new Error("socket closed")
        const payload = role !== undefined ? DEFAULT_JUDGE_ANSWERS[role] : stage === "discover" ? CRITICAL : { turns: [] }
        return { ok: true, slot, value: schema.parse(payload), tokens: { ...emptyTokenUsage(), input: 10, output: 20 } }
      },
    }),
  })
  if (!outcome.ok) throw new Error(outcome.reason)
  return { root, calls, outcome, schedule: created.schedule }
}

async function read(root: string) {
  const result = await readVariantBundle(root, { matcher: MATCH_FIRST })
  if (result.kind !== "read") throw new Error(result.reason)
  return result
}

const cont = (result: Awaited<ReturnType<typeof read>>, block: number, arm: string): ContinuationRead =>
  result.blocks[block - 1]!.continuations.find((entry) => entry.slot.arm === arm)!

async function manifestFile(root: string, arm: string, block: number): Promise<string> {
  const slot = join(root, arm, String(block - 1))
  const [run] = await readdir(slot)
  return join(slot, run!, MANIFEST_FILE)
}

describe("a complete bundle", () => {
  test("every slot is bound and measured; each contrast is eligible; tokens, attempts and arm-specific measures agree with the run", async () => {
    const { root, calls, outcome, schedule } = await bundle()
    const result = await read(root)
    expect(result.sealProblem).toBeNull()
    expect(result.journalProblem).toBeNull()
    expect(result.blocks.map((block) => block.continuations.map((entry) => entry.slot.arm))).toEqual(schedule.order)
    for (const block of result.blocks) {
      expect(block.contrasts).toEqual([
        { variant: "references", eligible: true },
        { variant: "open-questions", eligible: true },
      ])
      // The prefix: its own attempts, one per call of its phase, and its own tokens.
      const prefixCalls = calls.filter((call) => call.block === block.block && call.phase === "prefix").length
      expect(block.prefix.attempts).toEqual({ kind: "measured", value: prefixCalls })
      expect(block.prefix.tokens).toEqual({ kind: "measured", value: { executedHere: prefixCalls * 30, floor: false } })
      for (const entry of block.continuations) {
        expect(entry.problems).toEqual([])
        expect(entry.completed).toBe(true)
        const m = entry.measures!
        const own = calls.filter((call) => call.block === block.block && call.phase === entry.slot.arm).length
        expect(m.attempts).toEqual({ kind: "measured", value: own })
        // Executed here only: the inherited prefix is not in it.
        const run = outcome.runs.find((r) => r.slot.block === block.block && r.slot.arm === entry.slot.arm)!
        expect(m.tokens).toEqual({ kind: "measured", value: { executedHere: own * 30, floor: false } })
        expect(spentTokens(run.run.record.ledger.total)).toBeGreaterThan(own * 30)
        expect(m.unknownTurns).toEqual({ kind: "measured", value: 0 })
        expect(m.recall).toEqual({ kind: "measured", value: { found: 1, of: SEEDED_DEFECTS.length, defectIds: [SEEDED_DEFECTS[0]!.id] } })
        expect(m.unresolved).toEqual({ kind: "measured", value: 0 })
        expect(m.references.kind).toBe(entry.slot.arm === "references" ? "measured" : "not-applicable")
        expect(m.openQuestions.kind).toBe(entry.slot.arm === "open-questions" ? "measured" : "not-applicable")
        expect(m.questionsDelivered.kind).toBe(entry.slot.arm === "open-questions" ? "missing" : "not-applicable")
      }
    }
    const references = cont(result, 1, "references").measures!.references
    expect(references).toEqual({
      kind: "measured",
      value: { changes: 0, withValidCitation: 0, flagged: 0, citedShare: { kind: "not-applicable", reason: expect.stringContaining("no denominator") } },
    })
  })
})

describe("contrast eligibility", () => {
  test("a baseline that failed withholds both contrasts of its block", async () => {
    // Draw 0: block 1 runs baseline, references, open-questions.
    const { root } = await bundle({ fail: (call) => call.block === 1 && call.phase === "baseline" && call.stage === "judge" })
    const result = await read(root)
    expect(result.blocks[0]!.contrasts).toEqual([
      { variant: "references", eligible: false, reason: expect.stringContaining("the block's baseline did not complete") },
      { variant: "open-questions", eligible: false, reason: expect.stringContaining("the block's baseline did not complete") },
    ])
    // The failed baseline is still bound and measured, as observed.
    expect(cont(result, 1, "baseline").measures).toBeDefined()
    expect(cont(result, 1, "baseline").completed).toBe(false)
  })

  test("a variant that failed withholds only its own contrast", async () => {
    // Draw 2: block 1 runs baseline, open-questions, references.
    const { root } = await bundle({ draw: 2, fail: (call) => call.block === 1 && call.phase === "references" && call.stage === "judge" })
    const result = await read(root)
    expect(result.blocks[0]!.contrasts).toEqual([
      { variant: "references", eligible: false, reason: expect.stringContaining("the references continuation did not complete: it is failed") },
      { variant: "open-questions", eligible: true },
    ])
    // Later blocks were not attempted: no manifest, so not bound.
    expect(cont(result, 2, "baseline").problems[0]).toContain("no readable manifest")
  })

  test("without a slot status file nothing is completed, and the reason says so", async () => {
    const { root } = await bundle()
    await unlink(join(root, SLOT_STATUS_FILE))
    const result = await read(root)
    expect(cont(result, 1, "baseline").status).toEqual({ kind: "missing", reason: "no terminal status line names this slot" })
    expect(result.blocks[0]!.contrasts[0]).toMatchObject({ eligible: false, reason: expect.stringContaining("its status is missing") })
    // Measures are still read for a bound arm.
    expect(cont(result, 1, "baseline").measures?.attempts.kind).toBe("measured")
  })
})

describe("completion is bound to the run", () => {
  test("a later completed status line for another run does not complete the slot", async () => {
    const { root } = await bundle()
    const line = { block: 1, arm: "references", position: "second", status: "completed", reason: "stale", at: "t", runId: "another-run" }
    await appendFile(join(root, SLOT_STATUS_FILE), `${JSON.stringify(line)}\n`)
    const result = await read(root)
    expect(cont(result, 1, "references").completed).toBe(false)
    expect(result.blocks[0]!.contrasts[0]).toMatchObject({ eligible: false, reason: expect.stringContaining("names run \"another-run\"") })
  })

  test("a manifest whose completion is not a finished state, or whose finish time is unknown, does not complete the slot", async () => {
    for (const edit of [
      (manifest: Record<string, any>) => void (manifest.status.completion = "banana"),
      (manifest: Record<string, any>) => void (manifest.run.finishedAt = { kind: "unknown", why: "edited" }),
    ]) {
      const { root } = await bundle()
      const file = await manifestFile(root, "baseline", 1)
      const manifest = JSON.parse(await readFile(file, "utf8"))
      edit(manifest)
      await writeFile(file, JSON.stringify(manifest))
      const result = await read(root)
      const entry = cont(result, 1, "baseline")
      // Still bound and measured, as observed; only completion is withheld.
      expect(entry.problems).toEqual([])
      expect(entry.completed).toBe(false)
      expect(result.blocks[0]!.contrasts.every((contrast) => !contrast.eligible)).toBe(true)
    }
  })
})

describe("binding", () => {
  test("a manifest naming another position is not bound and has no measures", async () => {
    const { root } = await bundle()
    const file = await manifestFile(root, "references", 1)
    const manifest = JSON.parse(await readFile(file, "utf8"))
    manifest.variant.position = "third"
    await writeFile(file, JSON.stringify(manifest))
    const entry = cont(await read(root), 1, "references")
    expect(entry.problems.join(" ")).toContain("not this slot")
    expect(entry.measures).toBeUndefined()
    expect(entry.completed).toBe(false)
  })

  test("a manifest whose prefix, change or roster is not the schedule's is not bound", async () => {
    const { root } = await bundle()
    const file = await manifestFile(root, "baseline", 2)
    const manifest = JSON.parse(await readFile(file, "utf8"))
    manifest.identity.changeId.diffHash = "sha256:" + "0".repeat(64)
    await writeFile(file, JSON.stringify(manifest))
    expect(cont(await read(root), 2, "baseline").problems).toContain("its change is not the sealed schedule's")
  })

  test("a record.json naming another run is not bound, even when its ledger is unreadable", async () => {
    const { root } = await bundle()
    const file = (await manifestFile(root, "open-questions", 2)).replace(MANIFEST_FILE, "record.json")
    const record = JSON.parse(await readFile(file, "utf8"))
    record.runId = "someone-else"
    record.ledger = "broken"
    await writeFile(file, JSON.stringify(record))
    expect(cont(await read(root), 2, "open-questions").problems.join(" ")).toContain("names run `someone-else`")
  })

  test("a record.json that resolves outside the bundle is not read", async () => {
    const { root } = await bundle()
    const file = (await manifestFile(root, "baseline", 1)).replace(MANIFEST_FILE, "record.json")
    const outside = join(await tempDir(), "record.json")
    await writeFile(outside, await readFile(file, "utf8"))
    await unlink(file)
    await symlink(outside, file)
    const entry = cont(await read(root), 1, "baseline")
    expect(entry.problems.join(" ")).toContain("not inside the bundle root")
    expect(entry.measures).toBeUndefined()
  })

  test("a record.json naming another run is not bound", async () => {
    const { root } = await bundle()
    const file = (await manifestFile(root, "open-questions", 3)).replace(MANIFEST_FILE, "record.json")
    const record = JSON.parse(await readFile(file, "utf8"))
    record.runId = "someone-else"
    await writeFile(file, JSON.stringify(record))
    expect(cont(await read(root), 3, "open-questions").problems.join(" ")).toContain("names run `someone-else`")
  })
})

describe("the journal and the ledger", () => {
  test("a row naming another run makes that slot's attempts missing, and only that slot's", async () => {
    const { root } = await bundle()
    const row = { type: "issued", physicalId: "intruder", category: "blocks", block: 1, phase: "baseline", stage: "judge", slot: "discovery-1", attempt: 1, runId: "other", scope: "debate-variants" }
    await appendFile(join(root, JOURNAL_FILE), `${JSON.stringify(row)}\n${JSON.stringify({ type: "settled", physicalId: "intruder", settlement: { kind: "not-issued" } })}\n`)
    const result = await read(root)
    expect(cont(result, 1, "baseline").measures!.attempts).toEqual({ kind: "missing", reason: expect.stringContaining("names run `other`") })
    expect(cont(result, 1, "references").measures!.attempts.kind).toBe("measured")
  })

  test("a step row and a not-issued row are not attempts", async () => {
    const { root } = await bundle()
    const before = cont(await read(root), 2, "references").measures!.attempts
    if (before.kind !== "measured") throw new Error("not measured")
    const runId = cont(await read(root), 2, "references").runId!
    const rows = [
      { type: "issued", physicalId: "step", category: "blocks", block: 2, phase: "references", stage: "judge", slot: "s", attempt: 1, step: 2, runId, scope: "debate-variants" },
      { type: "settled", physicalId: "step", settlement: { kind: "usage", tokens: emptyTokenUsage() } },
      { type: "issued", physicalId: "never", category: "blocks", block: 2, phase: "references", stage: "judge", slot: "s", attempt: 2, runId, scope: "debate-variants" },
      { type: "settled", physicalId: "never", settlement: { kind: "not-issued" } },
    ]
    await appendFile(join(root, JOURNAL_FILE), rows.map((row) => `${JSON.stringify(row)}\n`).join(""))
    expect(cont(await read(root), 2, "references").measures!.attempts).toEqual(before)
  })

  test("an uncertain request makes every attempt count missing", async () => {
    const { root } = await bundle()
    const row = { type: "issued", physicalId: "dangling", category: "blocks", block: 3, phase: "prefix", stage: "discover", slot: "s", attempt: 9, runId: "x", scope: "debate-variants" }
    await appendFile(join(root, JOURNAL_FILE), `${JSON.stringify(row)}\n`)
    const result = await read(root)
    expect(result.journalProblem).toContain("never settled")
    expect(result.blocks.every((block) => block.prefix.attempts.kind === "missing")).toBe(true)
    expect(cont(result, 1, "baseline").measures!.attempts.kind).toBe("missing")
  })

  test("a ledger row whose origin does not name the block's prefix makes that arm's usage missing", async () => {
    const cases: [string, (ledger: Record<string, any>) => void][] = [
      ["does not name the block's prefix", (ledger) => ledger.unknownUsage.push({ slot: "s", stage: "judge", attempt: 1, executionId: "e", why: "w", origin: { runId: "elsewhere" } })],
      ["does not name the block's prefix", (ledger) => void (ledger.entries[ledger.entries.length - 1].origin = null)],
      ["unknown-usage row 0 is malformed", (ledger) => ledger.unknownUsage.push({ anything: true })],
    ]
    for (const [reason, edit] of cases) {
      const { root } = await bundle()
      const file = (await manifestFile(root, "references", 3)).replace(MANIFEST_FILE, "record.json")
      const record = JSON.parse(await readFile(file, "utf8"))
      edit(record.ledger)
      await writeFile(file, JSON.stringify(record))
      const result = await read(root)
      const m = cont(result, 3, "references").measures!
      expect(m.tokens).toEqual({ kind: "missing", reason: expect.stringContaining(reason) })
      expect(m.unknownTurns.kind).toBe("missing")
      // Only that arm.
      expect(cont(result, 3, "baseline").measures!.tokens.kind).toBe("measured")
    }
  })

  test("an unaudited ledger leaves unknown turns missing and its tokens a floor", async () => {
    const { root } = await bundle()
    const file = (await manifestFile(root, "baseline", 1)).replace(MANIFEST_FILE, "record.json")
    const record = JSON.parse(await readFile(file, "utf8"))
    delete record.ledger.unknownUsage
    await writeFile(file, JSON.stringify(record))
    const m = cont(await read(root), 1, "baseline").measures!
    expect(m.unknownTurns.kind).toBe("missing")
    expect(m.tokens).toMatchObject({ kind: "measured", value: { floor: true } })
  })
})

describe("the prefix", () => {
  test("a prefix that ran but could not be forked still reports its own attempts and tokens, and binds no continuation", async () => {
    let forks = 0
    const { root, calls } = await bundle({
      fork: (...args) => {
        forks += 1
        if (forks === 1) throw new Error("the fork broke")
        return forkPreparedReview(...args)
      },
    })
    const result = await read(root)
    const block = result.blocks[0]!
    const prefixCalls = calls.filter((call) => call.block === 1 && call.phase === "prefix").length
    expect(block.prefix.evidence.problem).toContain("the fork broke")
    expect(block.prefix.attempts).toEqual({ kind: "measured", value: prefixCalls })
    expect(block.prefix.tokens).toEqual({ kind: "measured", value: { executedHere: prefixCalls * 30, floor: false } })
    expect(block.continuations.every((entry) => entry.measures === undefined && !entry.completed)).toBe(true)
    expect(block.contrasts.every((contrast) => !contrast.eligible)).toBe(true)
    expect(result.blocks[1]!.contrasts.every((contrast) => contrast.eligible)).toBe(true)
  })

  test("a prefix ledger row carrying an origin makes the prefix's usage missing: a prefix inherits nothing", async () => {
    const { root, outcome } = await bundle()
    const prefixRunId = outcome.prefixes[0]!.runId!
    const file = join(root, "prefix", "0", prefixRunId, "record.json")
    const record = JSON.parse(await readFile(file, "utf8"))
    record.ledger.entries[0].origin = { runId: "elsewhere", entry: 0 }
    await writeFile(file, JSON.stringify(record))
    const block = (await read(root)).blocks[0]!
    expect(block.prefix.tokens).toEqual({ kind: "missing", reason: expect.stringContaining("a prefix inherits nothing") })
    expect(block.prefix.attempts.kind).toBe("measured")
  })

  test("the prefix ledger is read from the very file the loader bound, not from a record beside its target", async () => {
    const { root, outcome } = await bundle()
    const prefixRunId = outcome.prefixes[0]!.runId!
    const expected = join(root, "prefix", "0", prefixRunId, "record.json")
    const original = JSON.parse(await readFile(expected, "utf8"))
    const sibling = join(root, "prefix", "0", "sibling")
    await mkdir(sibling)
    // The bound target: the right prefix run, with one token per entry.
    const bound = structuredClone(original)
    for (const entry of bound.ledger.entries) entry.tokens = { ...emptyTokenUsage(), input: 1 }
    await writeFile(join(sibling, "bound.json"), JSON.stringify(bound))
    // Beside it, another run's valid record.
    await writeFile(join(sibling, "record.json"), JSON.stringify({ ...original, runId: "another-run" }))
    await unlink(expected)
    await symlink(join(sibling, "bound.json"), expected)
    const block = (await read(root)).blocks[0]!
    expect(block.prefix.tokens).toEqual({ kind: "measured", value: { executedHere: bound.ledger.entries.length, floor: false } })
  })

  test("prefix evidence naming another schedule or block reads no prefix figures", async () => {
    const { root } = await bundle()
    const file = join(root, "prefix", "0", "prefix.json")
    const evidence = JSON.parse(await readFile(file, "utf8"))
    evidence.scheduleHash = "sha256:" + "2".repeat(64)
    await writeFile(file, JSON.stringify(evidence))
    const block = (await read(root)).blocks[0]!
    expect(block.prefix.attempts.kind).toBe("missing")
    expect(block.prefix.tokens.kind).toBe("missing")
    expect(block.continuations.every((entry) => entry.measures === undefined)).toBe(true)
  })
})

describe("the labelled change and the schedule", () => {
  test("the labelled seal with another change leaves recall missing, and every other measure readable", async () => {
    const { root } = await bundle({ change: fakeChange() })
    const result = await read(root)
    expect(result.sealProblem).toContain("not the shipped seeded change's")
    const m = cont(result, 1, "baseline").measures!
    expect(m.recall.kind).toBe("missing")
    expect(m.attempts.kind).toBe("measured")
    expect(m.tokens.kind).toBe("measured")
  })

  test("a schedule not bound to the labelled change leaves recall missing everywhere", async () => {
    const { root } = await bundle({ fixture: { ...LABELLED_CHANGE_SEAL, labelsHash: "sha256:" + "1".repeat(64) } })
    const result = await read(root)
    expect(result.sealProblem).toContain("fixture.labelsHash")
    expect(cont(result, 1, "baseline").measures!.recall).toEqual({ kind: "missing", reason: result.sealProblem! })
  })

  test("a routing bundle is refused, and so is a root with no schedule", async () => {
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
    expect(await readVariantBundle(root)).toMatchObject({ kind: "refused", reason: expect.stringContaining("has schedule version 1") })
    await unlink(join(root, SCHEDULE_FILE))
    expect((await readVariantBundle(root)).kind).toBe("refused")
  })
})

describe("referencesOf", () => {
  const entry = (over: Partial<Entry>): Entry => ({ stage: "debate", actor: "a", at: "t", kind: "debate-round", round: 1, body: "b", ...over })
  test("changes, valid citations, flags and the cited share", () => {
    const finding = {
      history: [
        entry({ positionChanged: true, references: ["R1E1"] }),
        entry({ positionChanged: true, references: [], shiftWithoutValidReference: true }),
        entry({ positionChanged: false, references: ["R1E2"] }),
        entry({ kind: "debate-exit-converged-agreed", positionChanged: true }),
      ],
    } as unknown as Finding
    expect(referencesOf([finding])).toEqual({
      kind: "measured",
      value: { changes: 2, withValidCitation: 1, flagged: 1, citedShare: { kind: "measured", value: 0.5 } },
    })
  })
})
