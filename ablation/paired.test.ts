/**
 * Story 2-5c — `runPairedBlocks` end to end, through the real `prepareReview`,
 * `forkPreparedReview` and `continueReview`, the journal, the schedule and the
 * manifest writer. Fakes only: this proves the runner's semantics over port
 * calls and nothing about a real host.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, unlinkSync } from "node:fs"
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ZodType } from "zod"

import { spentTokens, usageByOrigin } from "../core/budget/ledger.ts"
import { emptyTokenUsage, type RunRecord, type TokenUsage } from "../core/domain/run-record.ts"
import { CODING_DISCOVERY_GENERALIST } from "../core/instructions/coding/discovery.ts"
import { CODING_LENS_INSTRUCTIONS } from "../core/instructions/coding/lenses.ts"
import type { Clock } from "../core/ports/clock.ts"
import type { LateUsageReporter } from "../core/ports/late-usage.ts"
import { cancelledTurn, type BackendCapabilities, type Envelope, type ModelBackend } from "../core/ports/model-backend.ts"
import { selectRoster } from "../core/roster/select.ts"
import { candidate, DEFAULT_JUDGE_ANSWERS, fakeChange, fakeClock, judgeRoleOf } from "../core/test-support/fakes.ts"
import { LABELLED_CHANGE_SEAL } from "../fixtures/seeded-defects/seal.ts"
import { PREFIX_FILE } from "./bundle.ts"
import { HALT_MARKER_FILE } from "./governor.ts"
import { JOURNAL_FILE, LOCK_FILE } from "./journal.ts"
import { known, MANIFEST_FILE, type RunManifest } from "./manifest.ts"
import { bindingProblem, deniedWork, runPairedBlocks, type PairedPhaseContext, type RunPairedBlocksInput } from "./paired.ts"
import type { RefusedAdmission } from "./journal.ts"
import { parseManifest } from "./read-bundle.ts"
import { readAdjudicationBundle } from "./adjudication-read.ts"
import { readEvaluationReport, renderEvaluationReport, settle } from "./evaluation-report.ts"
import { readPersistedJournal } from "./journal-read.ts"
import { readLabelledBundle } from "./labelled-read.ts"
import { readPairedBundle, renderPairedBundle } from "./paired-read.ts"
import { main as evalReadMain } from "../scripts/eval-read.ts"
import {
  createSchedule,
  readSlotStatuses,
  SCHEDULE_FILE,
  START_MARKER_FILE,
  sha256,
  type CoinFace,
  type PairedConfig,
  type PairedSchedule,
} from "./schedule.ts"

const PROTOCOL_FILE = new URL("../_bmad-output/specs/spec-mad-orchestrator/evaluation-protocol.md", import.meta.url).pathname
const WORKTREE = new URL("..", import.meta.url).pathname

const scratch: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-paired-"))
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

type Stage = "discover" | "debate" | "judge"

interface Call extends PairedPhaseContext {
  stage: Stage
  slot: string
}

/** What one call answers with, beyond its payload. */
type Usage = TokenUsage | { unknown: string; abandoned?: true } | "throw"

interface Script {
  usage?: (call: Call, index: number) => Usage
  /** Runs after the answer is decided, before it is returned. */
  after?: (call: Call, index: number) => void
  /** Runs before anything else, with the phase reporter. */
  before?: (call: Call, index: number, reporter: LateUsageReporter) => void
}

/**
 * A role-aware backend: discovery raises one critical finding, debate abstains,
 * and each judge role gives the shared defaults. Every call is logged across all
 * phases, and execution ids are unique across the whole invocation.
 */
function scripted(script: Script = {}) {
  const calls: Call[] = []
  let executions = 0
  const backendFor = (context: PairedPhaseContext, reporter: LateUsageReporter): ModelBackend => ({
    capabilities: (): BackendCapabilities => ({ tools: true }),
    async runTurn<T>(slot: string, instructions: string, _input: string, schema: ZodType<T>, signal?: AbortSignal): Promise<Envelope<T>> {
      if (signal?.aborted) return cancelledTurn<T>(slot)
      const role = judgeRoleOf(instructions)
      const discovery = instructions === CODING_DISCOVERY_GENERALIST.text || LENS_TEXTS.has(instructions)
      const stage: Stage = role !== undefined ? "judge" : discovery ? "discover" : "debate"
      const call: Call = { ...context, stage, slot }
      const index = calls.length
      calls.push(call)
      script.before?.(call, index, reporter)
      const usage = script.usage?.(call, index) ?? { ...emptyTokenUsage(), input: 10, output: 20 }
      if (usage === "throw") throw new Error("socket closed")
      const payload = role !== undefined ? DEFAULT_JUDGE_ANSWERS[role] : stage === "discover" ? CRITICAL : { turns: [] }
      const parsed = schema.safeParse(payload)
      if (!parsed.success) throw new Error(`fake payload for ${stage} did not parse`)
      const billing =
        "unknown" in usage
          ? {
              usageUnknown: {
                executionId: `exec-${(executions += 1)}`,
                why: usage.unknown,
                ...(usage.abandoned === true ? { abandoned: true as const } : {}),
              },
            }
          : { tokens: usage }
      script.after?.(call, index)
      return { ok: true, slot, value: parsed.data, ...billing }
    },
  })
  return { calls, backendFor }
}

const LENS_TEXTS = new Set([...CODING_LENS_INSTRUCTIONS.values()].map((set) => set.text))

function rosterOf(count: number, lenses: readonly string[] = []) {
  return selectRoster(
    [candidate("anthropic", "claude-sonnet-4-5"), candidate("openai", "gpt-5"), candidate("google", "gemini-2.5-pro")].slice(0, count),
    { slots: count, providerConfigKey: "provider", ...(lenses.length === 0 ? {} : { lenses }) },
  )
}

/** A frozen version-2 protocol, hashed by `readFrozenProtocol`'s own rule, in a temp dir of its own. */
async function frozenV2Protocol(): Promise<string> {
  const dir = await tempDir()
  const pending = "---\nid: PROTOCOL-test-v2\nstatus: frozen\nversion: 2\nfrozen_hash: PENDING\n---\n\n# A test protocol, version 2\n"
  const file = join(dir, "protocol-v2.md")
  await writeFile(file, pending.replace("frozen_hash: PENDING", `frozen_hash: ${sha256(pending)}`))
  return file
}

async function sealed(
  options: {
    coin?: CoinFace
    slots?: number
    maxConcurrency?: number
    clock?: Clock
    signal?: AbortSignal
    script?: Script
    config?: Pick<PairedConfig, "accounting" | "route">
  } = {},
) {
  const root = await tempDir()
  // Attempt mode is sized for three pool slots and the security and reliability lenses, under a frozen v2 protocol.
  const attemptMode = options.config?.accounting === "attempts"
  const resolved = attemptMode ? rosterOf(3, ["security", "reliability"]) : rosterOf(options.slots ?? 2)
  const base = {
    bundleRoot: root,
    protocolFile: attemptMode ? await frozenV2Protocol() : PROTOCOL_FILE,
    fixture: LABELLED_CHANGE_SEAL,
    codeRevision: known({ commit: "abc123", dirty: false }),
    roster: resolved.roster,
    change: fakeChange(),
    config: {
      provenance: "scripted" as const,
      ...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
      ...options.config,
    },
  }
  const created = await createSchedule({ ...base, createdAt: "2026-09-14T00:00:00.000Z", coin: () => options.coin ?? "heads" })
  if (!created.ok) throw new Error(created.reason)
  const backend = scripted(options.script)
  const input: RunPairedBlocksInput = {
    ...base,
    worktree: WORKTREE,
    priorWarnings: resolved.warnings,
    clock: options.clock ?? fakeClock(),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    backendFor: backend.backendFor,
  }
  return { root, input, calls: backend.calls, schedule: created.schedule }
}

async function manifestOf(directory: string): Promise<RunManifest> {
  const parsed = parseManifest(JSON.parse(await readFile(join(directory, MANIFEST_FILE), "utf8")))
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.value
}

const tokensOf = (record: RunRecord) => spentTokens(record.ledger.total)

describe("runPairedBlocks — the happy path", () => {
  test("heads: ON/OFF/ON, six manifests with `experiment`, six terminal slots, and the unique-execution bill", async () => {
    const { root, input, calls, schedule } = await sealed({ coin: "heads" })
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)

    expect(outcome.slots.map((slot) => `${slot.block}:${slot.arm}:${slot.status}`)).toEqual([
      "1:on:completed",
      "1:off:completed",
      "2:off:completed",
      "2:on:completed",
      "3:on:completed",
      "3:off:completed",
    ])
    expect(outcome.complete).toBe(true)
    // Scheduled order is execution order: every block's prefix, then its first arm, then its second.
    const phases = calls.map((call) => `${call.block}:${call.phase}`).filter((value, index, all) => all[index - 1] !== value)
    expect(phases).toEqual(["1:prefix", "1:on", "1:off", "2:prefix", "2:off", "2:on", "3:prefix", "3:on", "3:off"])
    // OFF issues no debate request; ON does.
    expect(calls.some((call) => call.phase === "off" && call.stage === "debate")).toBe(false)
    expect(calls.some((call) => call.phase === "on" && call.stage === "debate")).toBe(true)

    for (const slot of outcome.slots) {
      expect(slot.manifest?.kind).toBe("written")
      if (slot.manifest?.kind !== "written") continue
      const manifest = await manifestOf(slot.manifest.directory)
      const prefix = outcome.prefixes.find((entry) => entry.block === slot.block)!
      expect(manifest.experiment).toEqual({
        scheduleHash: schedule.scheduleHash,
        block: slot.block,
        arm: slot.arm,
        position: slot.position,
        prefixRunId: prefix.runId!,
      })
      expect(manifest.dials.routingPolicy).toBe(slot.arm === "on" ? "shipped" : "debate-off")
      expect(manifest.identity.protocolHash).toEqual(known(schedule.protocol.hash))
    }

    const statuses = await readSlotStatuses(root)
    expect(statuses.filter((line) => line.status === "started")).toHaveLength(6)
    expect(statuses.filter((line) => line.status === "completed")).toHaveLength(6)

    // AC1 — sum(attributed arm totals) − Blocks bill = sum(prefix bills).
    const bill = outcome.bill
    const attributed = outcome.runs.reduce((sum, entry) => sum + tokensOf(entry.run.record), 0)
    const prefixBills = bill.byPhase.filter((phase) => phase.phase === "prefix").map((phase) => spentTokens(phase.tokens))
    expect(prefixBills).toHaveLength(3)
    expect(attributed - spentTokens(bill.byCategory.blocks!)).toBe(prefixBills.reduce((a, b) => a + b, 0))
    // Identical inherited-prefix accounting: both branches of a block inherit exactly its prefix bill.
    for (const entry of outcome.runs) {
      const inherited = usageByOrigin(entry.run.record.ledger).inherited
      expect(spentTokens(inherited.tokens)).toBe(prefixBills[entry.slot.block - 1]!)
    }
    // Each distinct execution is counted once: every call the backend answered is one settled request.
    expect(bill.requests.filter((request) => request.state === "usage")).toHaveLength(calls.length)
    const executedHere = outcome.runs.reduce((sum, entry) => sum + usageByOrigin(entry.run.record.ledger).executedHere.turns, 0)
    const prefixTurns = bill.byPhase.filter((phase) => phase.phase === "prefix").reduce((sum, phase) => sum + phase.requests, 0)
    expect(executedHere + prefixTurns).toBe(calls.length)

    // Each forked prefix has its evidence file and its record's dump.
    for (const prefix of outcome.prefixes) {
      expect(prefix.evidence.ok).toBe(true)
      if (!prefix.evidence.ok) continue
      const evidence = JSON.parse(await readFile(prefix.evidence.file, "utf8"))
      expect(evidence).toMatchObject({ prefixEvidenceVersion: 1, scheduleHash: schedule.scheduleHash, block: prefix.block, forked: true })
      expect(evidence.prefixRunId).toEqual(known(prefix.runId!))
      expect(existsSync(join(evidence.dump, "record.json"))).toBe(true)
      expect(existsSync(join(evidence.dump, MANIFEST_FILE))).toBe(false)
    }
    expect(outcome.governor.runnerStop).toBeNull()
    expect(outcome.bill.stop).toBeNull()

    expect(existsSync(join(root, LOCK_FILE))).toBe(false)
  })

  test("tails: OFF/ON/OFF, sealed and started before the first request", async () => {
    let checkedFirst = false
    const { root, input } = await sealed({ coin: "tails" })
    const backendFor = input.backendFor
    input.backendFor = (context, reporter) => {
      if (!checkedFirst) {
        checkedFirst = true
        expect(existsSync(join(root, SCHEDULE_FILE))).toBe(true)
        expect(existsSync(join(root, START_MARKER_FILE))).toBe(true)
      }
      return backendFor(context, reporter)
    }
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(checkedFirst).toBe(true)
    expect(outcome.runs.map((entry) => `${entry.slot.block}:${entry.slot.arm}:${entry.slot.position}`)).toEqual([
      "1:off:first",
      "1:on:second",
      "2:on:first",
      "2:off:second",
      "3:off:first",
      "3:on:second",
    ])
  })
})

describe("runPairedBlocks — gates", () => {
  test("the prefix gate refuses the next discovery attempt at 60,000, and the prefix still forks", async () => {
    // One request at a time, so each admission sees the settled spend before it.
    const { input, calls } = await sealed({
      slots: 3,
      maxConcurrency: 1,
      script: { usage: (call) => ({ ...emptyTokenUsage(), input: call.stage === "discover" ? 30_000 : 10 }) },
    })
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(calls.filter((call) => call.block === 1 && call.phase === "prefix")).toHaveLength(2)
    expect(outcome.prefixes.every((prefix) => prefix.forked)).toBe(true)
    const first = outcome.runs[0]!.run.record
    expect(first.skippedForBudget).toEqual(["discovery-3"])
    expect(first.warnings.map((warning) => warning.code)).toContain("discovery-truncated")
    expect(outcome.bill.halt).toBeNull()
    // Both branches inherit the truncated prefix, so both slots of block 1 record the denial.
    expect(outcome.slots.slice(0, 2).map((slot) => slot.status)).toEqual(["failed", "failed"])
    expect(outcome.slots[0]!.reason).toContain("discovery skipped discovery-3 for budget")
    expect(outcome.complete).toBe(false)
  })

  test("persisted spend at the global cap, from another category, refuses every request", async () => {
    const { root, input, calls } = await sealed()
    await writeFile(
      join(root, JOURNAL_FILE),
      [
        { type: "issued", physicalId: "request-1", category: "calibration", block: null, phase: null, stage: "discover", slot: "s", attempt: 1, runId: "cal" },
        { type: "settled", physicalId: "request-1", settlement: { kind: "usage", tokens: { ...emptyTokenUsage(), input: 2_000_000 } } },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    )
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(calls).toHaveLength(0)
    expect(outcome.bill.requests.filter((request) => request.category === "blocks")).toHaveLength(0)
    expect(outcome.runs[0]!.run.record.skippedForBudget).toEqual(["discovery-1", "discovery-2"])
    // Every slot's planned work was refused, so none of them completed.
    expect(outcome.complete).toBe(false)
    expect(outcome.slots.map((slot) => slot.status)).toEqual(Array(6).fill("failed"))
    expect(outcome.slots[0]!.reason).toContain("global cap is exhausted")
    const statuses = await readSlotStatuses(root)
    expect(statuses.filter((line) => line.status === "failed")).toHaveLength(6)
  })

  test("reaching a threshold with nothing refused is not a denial", async () => {
    const { input } = await sealed({
      script: { usage: (call) => ({ ...emptyTokenUsage(), input: call.phase === "prefix" ? 30_000 : 10 }) },
    })
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    // Two discovery slots at 30,000 each reach the 60,000 prefix threshold exactly, and nothing was refused.
    expect(outcome.overshoot.phases.find((row) => row.block === 1 && row.phase === "prefix")!.spent).toBe(60_000)
    expect(outcome.bill.refused).toEqual([])
    expect(outcome.slots.map((slot) => slot.status)).toEqual(Array(6).fill("completed"))
    expect(outcome.complete).toBe(true)
  })
})

describe("runPairedBlocks — incomplete evaluations stay visible", () => {
  function expectEverySlotExplained(slots: readonly { status: string; reason: string }[]) {
    expect(slots).toHaveLength(6)
    for (const slot of slots) expect(slot.reason.length).toBeGreaterThan(0)
  }

  test("an unknown usage latches the halt; later slots are not attempted; the journal keeps every request", async () => {
    let unknownGiven = false
    const { input, calls } = await sealed({
      script: {
        usage: (call) => {
          if (!unknownGiven && call.block === 1 && call.phase === "on" && call.stage === "debate") {
            unknownGiven = true
            return { unknown: "host reported nothing" }
          }
          return { ...emptyTokenUsage(), input: 10 }
        },
      },
    })
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.complete).toBe(false)
    expectEverySlotExplained(outcome.slots)
    // The unknown stops the run's own ledger, so the rest of its work was denied.
    expect(outcome.slots[0]!.status).toBe("failed")
    expect(outcome.slots[0]!.reason).toContain("denied it planned work")
    expect(outcome.slots.slice(1).map((slot) => slot.status)).toEqual(Array(5).fill("not-attempted"))
    expect(outcome.slots[1]!.reason).toContain("halted")
    expect(outcome.bill.unknown).toHaveLength(1)
    expect(outcome.bill.requests.filter((request) => request.state !== "not-issued")).toHaveLength(calls.length)
    expect(calls.some((call) => call.block > 1)).toBe(false)
  })

  test("a throwing request settles unknown and halts before the next fork", async () => {
    const { input } = await sealed({
      script: { usage: (call) => (call.block === 2 && call.phase === "prefix" ? "throw" : { ...emptyTokenUsage(), input: 10 }) },
    })
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.slots.slice(0, 2).map((slot) => slot.status)).toEqual(["completed", "completed"])
    expect(outcome.slots.slice(2).map((slot) => slot.status)).toEqual(Array(4).fill("not-attempted"))
    expect(outcome.prefixes[1]).toMatchObject({ block: 2, forked: false })
    expect(outcome.bill.unknown.every((request) => request.why?.includes("threw"))).toBe(true)
    for (const entry of outcome.runs) {
      expect(entry.run.record.warnings.map((warning) => warning.code)).not.toContain("model-dropped-out")
    }
  })

  test("a cancellation mid-block keeps its bill and marks later slots not attempted", async () => {
    const controller = new AbortController()
    const { input } = await sealed({
      signal: controller.signal,
      script: { after: (call) => (call.block === 1 && call.phase === "on" && call.stage === "judge" ? controller.abort() : undefined) },
    })
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expectEverySlotExplained(outcome.slots)
    expect(outcome.slots[0]!.status).toBe("cancelled")
    expect(outcome.slots.slice(1).map((slot) => slot.status)).toEqual(Array(5).fill("not-attempted"))
    expect(outcome.slots[0]!.manifest?.kind).toBe("written")
    expect(outcome.bill.halt).toBeNull()
    expect(spentTokens(outcome.bill.known)).toBeGreaterThan(0)
    expect(outcome.complete).toBe(false)
  })

  test("a prefix that throws with its requests settled is not forked; the next block runs", async () => {
    const base = fakeClock()
    let broken = false
    const clock: Clock = {
      now: base.now,
      id: (prefix) => {
        if (prefix === "finding" && !broken) {
          broken = true
          throw new Error("the clock broke")
        }
        return base.id(prefix)
      },
    }
    const { input, root } = await sealed({ clock })
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.slots.slice(0, 2).map((slot) => slot.status)).toEqual(["not-attempted", "not-attempted"])
    expect(outcome.slots[0]!.reason).toContain("the clock broke")
    expect(outcome.slots.slice(2).map((slot) => slot.status)).toEqual(Array(4).fill("completed"))
    expect(outcome.runs).toHaveLength(4)
    expect(outcome.prefixes[0]).toMatchObject({ block: 1, forked: false })
    // No manifest for the unforked block: its arm directories were never written.
    expect(existsSync(join(root, "on", "0"))).toBe(false)
    // Its prefix evidence says what happened; no record existed, so none is invented.
    const evidence = JSON.parse(await readFile(join(root, "prefix", "0", PREFIX_FILE), "utf8"))
    expect(evidence).toMatchObject({ block: 1, forked: false, failure: "the clock broke", dump: null })
    expect(evidence.prefixRunId.kind).toBe("known")
    expect(outcome.bill.requests.filter((request) => request.block === 1)).toHaveLength(2)
    expect(outcome.complete).toBe(false)
  })

  test("a journal write failure stops the runner: no retry, no model blamed", async () => {
    let broke = false
    const { input, root, calls } = await sealed({
      script: {
        before: () => {
          if (broke) return
          broke = true
          const file = join(root, JOURNAL_FILE)
          unlinkSync(file)
          mkdirSync(file)
        },
      },
    })
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.slots.every((slot) => slot.status === "not-attempted")).toBe(true)
    expect(outcome.slots[0]!.reason).toContain("runner stopped")
    expect(outcome.bill.stop).not.toBeNull()
    expect(calls.length).toBeLessThanOrEqual(2)
    expect(outcome.runs).toHaveLength(0)
  })
})

describe("runPairedBlocks — late usage after completion", () => {
  test("flush persists the recovery once, retains a conflict, admits nothing, and leaves the halt", async () => {
    let reporter: LateUsageReporter | undefined
    const { input } = await sealed({
      script: {
        before: (_call, _index, phaseReporter) => {
          reporter ??= phaseReporter
        },
        usage: (_call, index) => (index === 0 ? { unknown: "abandoned in flight" } : { ...emptyTokenUsage(), input: 10 }),
      },
    })
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.bill.halt).not.toBeNull()
    const handle = outcome.reconciliation

    reporter!.report({ executionId: "exec-1", tokens: { ...emptyTokenUsage(), input: 77 } })
    expect(await handle.flush()).toMatchObject({ ok: true, persisted: 1, conflicts: [] })
    reporter!.report({ executionId: "exec-1", tokens: { ...emptyTokenUsage(), input: 78 } })
    const conflict = await handle.flush()
    expect(conflict.persisted).toBe(0)
    expect(conflict.conflicts).toHaveLength(1)

    const bill = handle.bill()
    expect(bill.halt).not.toBeNull()
    expect(bill.unknown[0]!.late).toEqual({ ...emptyTokenUsage(), input: 77 })
    expect(bill.integrity).toHaveLength(1)
    expect(bill.requests.filter((request) => request.state === "in-flight")).toHaveLength(0)
  })

  test("a flush that cannot reacquire the lock reports an unpersisted report and keeps it", async () => {
    let reporter: LateUsageReporter | undefined
    const { input, root } = await sealed({
      script: {
        before: (_call, _index, phaseReporter) => {
          reporter ??= phaseReporter
        },
        usage: (_call, index) => (index === 0 ? { unknown: "abandoned in flight" } : { ...emptyTokenUsage(), input: 10 }),
      },
    })
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    reporter!.report({ executionId: "exec-1", tokens: { ...emptyTokenUsage(), input: 5 } })
    await writeFile(join(root, LOCK_FILE), "held\n")
    const failed = await outcome.reconciliation.flush()
    expect(failed.ok).toBe(false)
    expect(failed.failed).not.toBeNull()
    expect(outcome.reconciliation.held()).toHaveLength(1)
    await unlink(join(root, LOCK_FILE))
    expect(await outcome.reconciliation.flush()).toMatchObject({ ok: true, persisted: 1 })
  })
})

describe("runPairedBlocks — refusals before the start marker bill nothing", () => {
  test("a second invocation on a started schedule is refused", async () => {
    const { input, calls } = await sealed()
    const first = await runPairedBlocks(input)
    expect(first.ok).toBe(true)
    const count = calls.length
    const second = await runPairedBlocks(input)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toContain("already started")
    expect(calls).toHaveLength(count)
  })

  test("a present lock refuses", async () => {
    const { input, root, calls } = await sealed()
    await writeFile(join(root, LOCK_FILE), "another runner\n")
    const outcome = await runPairedBlocks(input)
    expect(outcome.ok).toBe(false)
    expect(calls).toHaveLength(0)
    expect(existsSync(join(root, START_MARKER_FILE))).toBe(false)
  })

  test.each([
    ["protocol", async (input: RunPairedBlocksInput, root: string) => {
      const copy = join(root, "edited-protocol.md")
      await writeFile(copy, (await readFile(PROTOCOL_FILE, "utf8")).replace("Three scheduled paired blocks.", "Two."))
      return { ...input, protocolFile: copy }
    }],
    ["fixture", async (input: RunPairedBlocksInput) => ({ ...input, fixture: { ...input.fixture, materialHash: "sha256:0" } })],
    ["config", async (input: RunPairedBlocksInput) => ({ ...input, config: { ...input.config, maxRounds: 5 } })],
    ["schedule", async (input: RunPairedBlocksInput, root: string) => {
      await unlink(join(root, SCHEDULE_FILE))
      return input
    }],
  ])("a %s mismatch is refused before the start marker", async (_name, alter) => {
    const { input, root, calls } = await sealed()
    const outcome = await runPairedBlocks(await alter(input, root))
    expect(outcome.ok).toBe(false)
    expect(calls).toHaveLength(0)
    expect(existsSync(join(root, START_MARKER_FILE))).toBe(false)
    expect(existsSync(join(root, LOCK_FILE))).toBe(false)
  })

  test("an interrupted invocation (start marker present, request issued and unsettled) is refused", async () => {
    const { input, root, calls } = await sealed()
    await writeFile(join(root, START_MARKER_FILE), "{}\n")
    await writeFile(
      join(root, JOURNAL_FILE),
      `${JSON.stringify({ type: "issued", physicalId: "request-1", category: "blocks", block: 1, phase: "prefix", stage: "discover", slot: "discovery-1", attempt: 1, runId: "run-1" })}\n`,
    )
    const outcome = await runPairedBlocks(input)
    expect(outcome.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

describe("the manifest writer's binding check", () => {
  const schedule = { scheduleHash: "sha256:s", slots: [{ block: 1, arm: "on", position: "first" }, { block: 1, arm: "off", position: "second" }] } as unknown as PairedSchedule
  const record = { forkedFrom: "run-1" } as RunRecord
  const binding = { scheduleHash: "sha256:s", block: 1, arm: "on" as const, position: "first" as const, prefixRunId: "run-1" }

  test("a slot the schedule planned, forked from its prefix, passes", () => {
    expect(bindingProblem(schedule, binding, record)).toBeNull()
  })

  test("a slot that contradicts the schedule, or a prefix that is not the parent, is refused", () => {
    expect(bindingProblem(schedule, { ...binding, position: "second" }, record)).toContain("not a slot")
    expect(bindingProblem(schedule, { ...binding, arm: "off" }, record)).toContain("not a slot")
    expect(bindingProblem(schedule, { ...binding, prefixRunId: "run-9" }, record)).toContain("forkedFrom")
    expect(bindingProblem(schedule, { ...binding, scheduleHash: "sha256:t" }, record)).toContain("schedule hash")
  })
})

describe("runPairedBlocks — review patches (story 2-5c review)", () => {
  test("a slot status that cannot be recorded ends admission before the continuation runs", async () => {
    const { input, root, calls } = await sealed()
    mkdirSync(join(root, "paired-slots.jsonl"))
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.slots.map((slot) => slot.status)).toEqual(Array(6).fill("not-attempted"))
    expect(calls.every((call) => call.block === 1 && call.phase === "prefix")).toBe(true)
    expect(outcome.runs).toHaveLength(0)
    expect(outcome.complete).toBe(false)
    expect(existsSync(join(root, LOCK_FILE))).toBe(false)
  })

  test("a manifest that could not be written ends admissions; later slots are not attempted", async () => {
    const { input, root, calls } = await sealed({ coin: "heads" })
    await writeFile(join(root, "on"), "in the way\n")
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.slots[0]!.manifest?.kind).not.toBe("written")
    expect(outcome.slots.slice(1).map((slot) => slot.status)).toEqual(Array(5).fill("not-attempted"))
    expect(outcome.slots[1]!.reason).toContain("manifest")
    expect(calls.some((call) => call.phase === "off" || call.block > 1)).toBe(false)
    expect(outcome.complete).toBe(false)
  })

  test("a backendFor that throws gives the slot a terminal `failed` status and the lock is released", async () => {
    const { input, root } = await sealed({ coin: "heads" })
    const backendFor = input.backendFor
    input.backendFor = (context, reporter) => {
      if (context.block === 1 && context.phase === "on") throw new Error("no backend for on")
      return backendFor(context, reporter)
    }
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.slots[0]).toMatchObject({ status: "failed" })
    expect(outcome.slots[0]!.reason).toContain("no backend for on")
    expect(outcome.slots.slice(1).map((slot) => slot.status)).toEqual(Array(5).fill("completed"))
    expect(existsSync(join(root, LOCK_FILE))).toBe(false)
    expect(outcome.complete).toBe(false)
  })

  test("a continuation that throws after billing is `failed`, keeps its bill, and the next arm still runs", async () => {
    const { input, calls } = await sealed({ coin: "heads" })
    const backendFor = input.backendFor
    input.backendFor = (context, reporter) => {
      const backend = backendFor(context, reporter)
      if (context.block !== 1 || context.phase !== "on") return backend
      return { ...backend, runTurn: backend.runTurn, capabilities: () => { throw new Error("capabilities unavailable") } }
    }
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.slots[0]).toMatchObject({ status: "failed" })
    expect(outcome.slots[0]!.reason).toContain("capabilities unavailable")
    // The partial record is published: the failure is named, and nothing is invented for it.
    expect(outcome.slots[0]!.manifest?.kind).toBe("written")
    if (outcome.slots[0]!.manifest?.kind === "written") {
      const manifest = await manifestOf(outcome.slots[0]!.manifest.directory)
      expect(manifest.experiment?.failure).toContain("capabilities unavailable")
      expect(manifest.status.completion).toBe("unfinished")
      expect(manifest.run.finishedAt.kind).toBe("unknown")
      expect(manifest.dials.routingPolicy).toBe("shipped")
      expect(spentTokens(manifest.spend.origin.executedHere.tokens)).toBeGreaterThan(0)
    }
    expect(outcome.runs.some((entry) => entry.slot.block === 1 && entry.slot.arm === "on")).toBe(false)
    expect(calls.some((call) => call.block === 1 && call.phase === "on" && call.stage === "debate")).toBe(true)
    expect(outcome.bill.requests.some((request) => request.block === 1 && request.phase === "on")).toBe(true)
    expect(outcome.slots[1]).toMatchObject({ status: "completed" })
  })

  test("a continuation that throws while the run is cancelled ends admission as a cancellation", async () => {
    const controller = new AbortController()
    const { input } = await sealed({ coin: "heads", signal: controller.signal })
    const backendFor = input.backendFor
    input.backendFor = (context, reporter) => {
      const backend = backendFor(context, reporter)
      if (context.block !== 1 || context.phase !== "on") return backend
      return {
        ...backend,
        runTurn: backend.runTurn,
        capabilities: () => {
          controller.abort()
          throw new Error("stopped mid-judge")
        },
      }
    }
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.slots[0]).toMatchObject({ status: "failed" })
    expect(outcome.slots.slice(1).map((slot) => slot.status)).toEqual(Array(5).fill("not-attempted"))
    expect(outcome.slots[1]!.reason).toContain("cancelled")
  })

  test("a bundle index that may not be written refuses before the start marker", async () => {
    const { input, root, calls } = await sealed()
    const outcome = await runPairedBlocks({ ...input, worktree: root })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain("bundle index")
    expect(existsSync(join(root, START_MARKER_FILE))).toBe(false)
    expect(existsSync(join(root, LOCK_FILE))).toBe(false)
    expect(calls).toHaveLength(0)
  })

  test("a prefix that cannot be forked leaves both slots not attempted and keeps its bill", async () => {
    const { input } = await sealed()
    const outcome = await runPairedBlocks({
      ...input,
      priorWarnings: [
        ...(input.priorWarnings ?? []),
        { code: "dial-clamped", stage: "discover", message: "uncloneable", detail: { dials: [], fn: () => 1 } },
      ],
    })
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.prefixes.every((prefix) => !prefix.forked)).toBe(true)
    expect(outcome.slots.every((slot) => slot.status === "not-attempted")).toBe(true)
    expect(outcome.slots[0]!.reason).toContain("could not be forked")
    expect(outcome.runs).toHaveLength(0)
    // The unforked prefix's record is still written, with its evidence file.
    const first = outcome.prefixes[0]!
    expect(first.evidence.ok).toBe(true)
    if (first.evidence.ok) {
      expect(first.evidence.dump).not.toBeNull()
      const evidence = JSON.parse(await readFile(first.evidence.file, "utf8"))
      expect(evidence).toMatchObject({ forked: false, prefixRunId: known(first.runId!) })
      expect(evidence.failure).toContain("cannot be copied")
    }
    expect(outcome.bill.requests.filter((request) => request.phase === "prefix").length).toBeGreaterThan(0)
  })

  test("admitted concurrent work overshoots the prefix threshold, and the overshoot is reported", async () => {
    const { input } = await sealed({
      slots: 3,
      maxConcurrency: 4,
      script: { usage: (call) => ({ ...emptyTokenUsage(), input: call.stage === "discover" ? 30_000 : 10 }) },
    })
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    const prefix = outcome.overshoot.phases.find((row) => row.block === 1 && row.phase === "prefix")!
    expect(prefix).toEqual({ block: 1, phase: "prefix", limit: 60_000, spent: 90_000, overshoot: 30_000 })
    expect(outcome.overshoot.phases.find((row) => row.block === 1 && row.phase === "on")!.overshoot).toBe(0)
    expect(outcome.overshoot).toEqual(outcome.bill.overshoot)
  })

  test("the Blocks allowance exhausted in block 1 refuses block 2's requests, and its overshoot is reported", async () => {
    // Both discovery slots of block 1 run at once, so both are admitted before either settles.
    const { input, calls } = await sealed({
      maxConcurrency: 2,
      script: { usage: (call) => ({ ...emptyTokenUsage(), input: call.stage === "discover" ? 750_000 : 10 }) },
    })
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(calls.filter((call) => call.block > 1)).toHaveLength(0)
    const blockTwo = outcome.runs.find((entry) => entry.slot.block === 2)!.run.record
    expect(blockTwo.skippedForBudget).toEqual(["discovery-1", "discovery-2"])
    const truncated = blockTwo.warnings.find((warning) => warning.code === "discovery-truncated")
    expect(truncated?.message).toContain("Blocks allowance is exhausted")
    expect(truncated?.message).not.toContain("taken the run past")
    expect(outcome.overshoot.blocks).toEqual({ limit: 1_400_000, spent: 1_500_000, overshoot: 100_000 })
    expect(outcome.slots.filter((slot) => slot.block > 1).map((slot) => slot.status)).toEqual(Array(4).fill("failed"))
    expect(outcome.complete).toBe(false)
  })

  test("prefix evidence that cannot be written ends admission before any continuation runs", async () => {
    const { input, root, calls } = await sealed()
    await writeFile(join(root, "prefix"), "in the way\n")
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.prefixes[0]!.evidence.ok).toBe(false)
    expect(outcome.slots.map((slot) => slot.status)).toEqual(Array(6).fill("not-attempted"))
    expect(outcome.slots[0]!.reason).toContain("prefix evidence was not written")
    expect(outcome.bill.stop).toContain("prefix evidence was not written")
    expect(outcome.governor.runnerStop).toContain("prefix evidence was not written")
    const statuses = await readSlotStatuses(root)
    expect(statuses.every((line) => line.status === "not-attempted")).toBe(true)
    expect(calls.every((call) => call.block === 1 && call.phase === "prefix")).toBe(true)
    expect(outcome.complete).toBe(false)
  })
})

describe("runPairedBlocks — a Tools port and a sealed Tools identity come together (story 2-5c review)", () => {
  test("a Tools port with no identity in the config is refused before anything bills", async () => {
    const { input, root, calls } = await sealed()
    const tools = {} as NonNullable<RunPairedBlocksInput["tools"]>
    const outcome = await runPairedBlocks({ ...input, tools })
    expect(outcome.ok).toBe(false)
    expect(calls).toHaveLength(0)
    expect(existsSync(join(root, START_MARKER_FILE))).toBe(false)
  })

  test("an identity with no port, or a blank identity, is refused before anything bills", async () => {
    const tools = {} as NonNullable<RunPairedBlocksInput["tools"]>
    for (const alter of [
      (input: RunPairedBlocksInput) => ({ ...input, config: { ...input.config, tools: "opencode tools in /scratch" } }),
      (input: RunPairedBlocksInput) => ({ ...input, tools, config: { ...input.config, tools: "  " } }),
    ]) {
      const { input, root, calls } = await sealed()
      const outcome = await runPairedBlocks(alter(input))
      expect(outcome.ok).toBe(false)
      expect(calls).toHaveLength(0)
      expect(existsSync(join(root, START_MARKER_FILE))).toBe(false)
      expect(existsSync(join(root, LOCK_FILE))).toBe(false)
    }
  })
})

describe("runPairedBlocks — refusals after the lock release it and spend nothing (story 2-5c review)", () => {
  test("a halt already latched when the journal opens refuses before the start marker", async () => {
    const { input, root, calls } = await sealed()
    await writeFile(join(root, HALT_MARKER_FILE), "{}\n")
    const outcome = await runPairedBlocks(input)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain("already halted")
    expect(calls).toHaveLength(0)
    expect(existsSync(join(root, START_MARKER_FILE))).toBe(false)
    expect(existsSync(join(root, LOCK_FILE))).toBe(false)
  })

  test("a clock that throws after the lock was taken releases the lock", async () => {
    const base = fakeClock()
    let calls = 0
    const clock: Clock = {
      id: base.id,
      now: () => {
        calls += 1
        if (calls === 2) throw new Error("the clock broke")
        return base.now()
      },
    }
    const { input, root } = await sealed({ clock })
    const outcome = await runPairedBlocks(input)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain("the clock broke")
    expect(existsSync(join(root, LOCK_FILE))).toBe(false)
    expect(existsSync(join(root, START_MARKER_FILE))).toBe(false)
  })
})

describe("deniedWork — which refusals fail which slot (story 2-5c review)", () => {
  const clean = { skippedForBudget: [], findings: [] } as unknown as RunRecord
  const refusal = (over: Partial<RefusedAdmission>): RefusedAdmission => ({
    block: 1,
    phase: "on",
    stage: "judge",
    slot: "discovery-1",
    attempt: 1,
    cause: "budget",
    reason: "allowance exhausted",
    ...over,
  })

  test("a refusal in the other arm, or in another block, is not this slot's denial", () => {
    expect(deniedWork(clean, [refusal({ phase: "on" })], 1, "off")).toBeNull()
    expect(deniedWork(clean, [refusal({ block: 2, phase: "prefix" })], 1, "on")).toBeNull()
  })

  test("a refusal in its own arm or its block's prefix is, whatever the cause", () => {
    expect(deniedWork(clean, [refusal({ phase: "prefix" })], 1, "off")).toContain("(budget)")
    expect(deniedWork(clean, [refusal({ cause: "halted" })], 1, "on")).toContain("(halted)")
    expect(deniedWork(clean, [refusal({ cause: "runner-stop", phase: "off" })], 1, "off")).toContain("(runner-stop)")
  })

  test("a finding left unresolved by a cancellation is not a denial; one stranded by budget is", () => {
    const cancelled = { skippedForBudget: [], findings: [{ unresolved: { diedAtStage: "judge", reason: "the run was cancelled while it was being judged" } }] } as unknown as RunRecord
    const stranded = { skippedForBudget: [], findings: [{ unresolved: { diedAtStage: "judge", reason: "the token budget (255000) ran out" } }] } as unknown as RunRecord
    expect(deniedWork(cancelled, [], 1, "on")).toBeNull()
    expect(deniedWork(stranded, [], 1, "on")).toContain("1 finding(s)")
  })
})

describe("runPairedBlocks — a denial fails only the slot it denied (story 2-5c review)", () => {
  test("block 1's ON continuation over its allowance fails; its OFF arm and later blocks complete", async () => {
    const { input } = await sealed({
      coin: "heads",
      script: {
        usage: (call) => ({ ...emptyTokenUsage(), input: call.block === 1 && call.phase === "on" && call.stage === "debate" ? 196_000 : 10 }),
      },
    })
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.slots.map((slot) => `${slot.block}:${slot.arm}:${slot.status}`)).toEqual([
      "1:on:failed",
      "1:off:completed",
      "2:off:completed",
      "2:on:completed",
      "3:on:completed",
      "3:off:completed",
    ])
    expect(outcome.complete).toBe(false)
  })
})

describe("runPairedBlocks in attempt mode (story 2-8c3a)", () => {
  const attempts = { accounting: "attempts" as const, route: "oauth" as const }

  async function journalLines(root: string): Promise<Record<string, unknown>[]> {
    return (await readFile(join(root, JOURNAL_FILE), "utf8"))
      .split("\n")
      .filter((row) => row.length > 0)
      .map((row) => JSON.parse(row) as Record<string, unknown>)
  }

  test("every issued line says `attempts`, every manifest says so, and the runs get no token cap or unknown-usage stop", async () => {
    const { root, input } = await sealed({ config: attempts })
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.complete).toBe(true)
    expect(outcome.bill.mode).toBe("attempts")
    const issued = (await journalLines(root)).filter((line) => line.type === "issued")
    expect(issued.length).toBeGreaterThan(0)
    expect(issued.every((line) => line.mode === "attempts")).toBe(true)
    for (const slot of outcome.slots) {
      if (slot.manifest?.kind !== "written") throw new Error("expected a manifest")
      const manifest = await manifestOf(slot.manifest.directory)
      expect(manifest.experiment?.accounting).toBe("attempts")
      expect(manifest.dials.cap).toBeNull()
    }
    for (const entry of outcome.runs) {
      expect(entry.run.record.ledger.cap).toBeNull()
      expect(entry.run.record.ledger.stopOnUnknownUsage).toBe(false)
    }
    expect(outcome.governor).toMatchObject({ accounting: "attempts", admittedAttempts: issued.length })
    expect(outcome.schedule.config).toMatchObject({ accounting: "attempts", tokenCap: null, stopOnUnknownUsage: false })
  })

  test("an unknown settlement halts nothing: every slot still runs, and the evaluation is complete", async () => {
    let unknownGiven = false
    const { input, calls } = await sealed({
      config: attempts,
      script: {
        usage: (call) => {
          if (!unknownGiven && call.block === 1 && call.phase === "on" && call.stage === "debate") {
            unknownGiven = true
            return { unknown: "host reported nothing" }
          }
          return { ...emptyTokenUsage(), input: 10, output: 20 }
        },
      },
    })
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(unknownGiven).toBe(true)
    expect(outcome.bill.halt).toBeNull()
    expect(outcome.bill.unknown).toHaveLength(1)
    expect(outcome.slots.map((slot) => slot.status)).toEqual(Array(6).fill("completed"))
    expect(outcome.complete).toBe(true)
    expect(calls.some((call) => call.block === 3)).toBe(true)
  })

  test("an abandoned attempt stops the run operationally; later slots are not attempted", async () => {
    let given = false
    const { input } = await sealed({
      config: attempts,
      script: {
        usage: (call) => {
          if (!given && call.block === 1 && call.phase === "on" && call.stage === "debate") {
            given = true
            return { unknown: "timed out", abandoned: true }
          }
          return { ...emptyTokenUsage(), input: 10, output: 20 }
        },
      },
    })
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.bill.halt).toContain("did not end within its bound")
    expect(outcome.bill.halt).not.toContain("UNKNOWN amount")
    expect(outcome.complete).toBe(false)
    expect(outcome.slots.slice(2).map((slot) => slot.status)).toEqual(Array(4).fill("not-attempted"))

    // The paired reader presents the marker as an attempt-mode operational stop, never as unknown spend.
    const paired = await readPairedBundle(input.bundleRoot)
    if ("error" in paired) throw new Error(paired.error)
    expect(paired.halt).toMatchObject({ kind: "halted", accounting: "attempts" })
    const text = renderPairedBundle(paired)
    expect(text).toContain("THIS EXPERIMENT STOPPED IN ATTEMPT MODE — an operational stop, not unknown spend.")
    expect(text).not.toContain("THIS EXPERIMENT IS HALTED.")
  })

  test("a thrown runTurn is settled abandoned, so attempt mode stops", async () => {
    let thrown = false
    const { input } = await sealed({
      config: attempts,
      script: {
        usage: (call) => {
          if (!thrown && call.block === 1 && call.phase === "on" && call.stage === "debate") {
            thrown = true
            return "throw"
          }
          return { ...emptyTokenUsage(), input: 10, output: 20 }
        },
      },
    })
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(thrown).toBe(true)
    expect(outcome.bill.halt).toContain("did not end within its bound")
    expect(outcome.bill.halt).toContain("the backend threw after the request was issued")
    expect(outcome.complete).toBe(false)
  })

  test("`eval-read` reads an attempt-mode bundle's journal and prints the attempt endpoint", async () => {
    const { root, input } = await sealed({ config: attempts })
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    const lines: string[] = []
    const log = console.log
    console.log = (...args: unknown[]) => void lines.push(args.join(" "))
    let code: number
    try {
      code = await evalReadMain(["bun", "eval-read", "--bundle", root])
    } finally {
      console.log = log
    }
    expect(code).toBe(0)
    const text = lines.join("\n")
    expect(text).toContain("COST — newly issued MAD attempts")
    expect(text).toContain("replayed and validated by `ablation/journal-read.ts`")
    expect(text).not.toContain("attempts UNAVAILABLE")
  })

  test("attempts and the oauth route go together, and an unknown value of either refuses", async () => {
    const { input } = await sealed({ config: attempts })
    const cases: [Partial<PairedConfig>, string][] = [
      [{ accounting: undefined, route: "oauth" }, "runs only with accounting `attempts`"],
      [{ accounting: "attempts", route: undefined }, "belongs to the oauth route"],
      [{ accounting: "attempts", route: "api-key" }, "belongs to the oauth route"],
      [{ accounting: "tally" as never }, "neither tokens nor attempts"],
      [{ route: "wifi" as never }, "neither api-key nor oauth"],
    ]
    for (const [over, reason] of cases) {
      const refused = await runPairedBlocks({ ...input, config: { ...input.config, ...over } })
      expect(refused.ok, reason).toBe(false)
      if (!refused.ok) expect(refused.reason).toContain(reason)
    }
  })

  test("the prefix threshold: the realised count and overshoot are in the bill, and the report's attempts equal the journal's, by arm", async () => {
    // One request at a time, so each admission sees the attempts before it.
    const { root, input, calls } = await sealed({ maxConcurrency: 1, config: attempts })
    // Eight settled prefix attempts of block 1 and one admitted-then-not-issued one, as an earlier caller left them.
    const seed = [
      ...Array.from({ length: 8 }, (_, index) => [
        { type: "issued", physicalId: `seed-${index}`, category: "blocks", block: 1, phase: "prefix", stage: "discover", slot: "discovery-1", attempt: 1, runId: "seed", mode: "attempts" },
        { type: "settled", physicalId: `seed-${index}`, settlement: { kind: "usage", tokens: { ...emptyTokenUsage(), input: 1 } } },
      ]).flat(),
      { type: "issued", physicalId: "seed-cancelled", category: "blocks", block: 1, phase: "prefix", stage: "discover", slot: "discovery-1", attempt: 1, runId: "seed", mode: "attempts" },
      { type: "settled", physicalId: "seed-cancelled", settlement: { kind: "not-issued" } },
    ]
    await writeFile(join(root, JOURNAL_FILE), seed.map((line) => `${JSON.stringify(line)}\n`).join(""))
    const outcome = await runPairedBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)

    // 8 counted + 2 admitted reach 10; the third discovery attempt is refused in attempts.
    expect(calls.filter((call) => call.block === 1 && call.phase === "prefix")).toHaveLength(2)
    const prefixRow = outcome.bill.overshoot.phases.find((row) => row.block === 1 && row.phase === "prefix")!
    expect(prefixRow).toEqual({ block: 1, phase: "prefix", limit: 10, spent: 10, overshoot: 0 })
    expect(outcome.bill.overshoot.unit).toBe("attempts")
    expect(outcome.bill.overshoot.blockTotals!.find((row) => row.block === 1)!.limit).toBe(100)
    expect(outcome.bill.refused[0]!.reason).toBe("block 1's shared prefix allowance is exhausted: 10 of 10 admitted attempts")
    expect(outcome.slots.slice(0, 2).map((slot) => slot.status)).toEqual(["failed", "failed"])

    const paired = await readPairedBundle(root)
    if ("error" in paired) throw new Error(paired.error)
    const journal = await readPersistedJournal(root)
    expect(journal.ok).toBe(true)
    const report = readEvaluationReport(
      { kind: "read", value: paired },
      await settle(() => readLabelledBundle(paired)),
      await settle(() => readAdjudicationBundle(paired)),
      { kind: "read", value: journal },
    )
    if (report.kind !== "read") throw new Error(JSON.stringify(report))
    expect(report.accounting).toBe("attempts")
    const issuedOf = (block: number, phase: string) =>
      outcome.bill.requests.filter((request) => request.block === block && request.phase === phase && request.state !== "not-issued").length
    for (const entry of report.blocks) {
      const attemptsOf = entry.attempts
      if (attemptsOf?.kind !== "read") throw new Error(`block ${entry.block}: ${JSON.stringify(attemptsOf)}`)
      expect(attemptsOf.prefix.total).toBe(issuedOf(entry.block, "prefix"))
      expect(attemptsOf.on.total).toBe(issuedOf(entry.block, "on"))
      expect(attemptsOf.off.total).toBe(issuedOf(entry.block, "off"))
      expect(attemptsOf.total).toBe(attemptsOf.prefix.total + attemptsOf.on.total + attemptsOf.off.total)
      expect(entry.cost.kind).toBe("unavailable")
    }
    const block1 = report.blocks[0]!.attempts!
    if (block1.kind !== "read") throw new Error("unreachable")
    expect(block1.prefix.total).toBe(10)
    expect(block1.notIssued).toBe(1)
    // Block 1's slots failed on the refusal, so its contrast is unavailable; block 2's is exact.
    expect(block1.contrast.kind).toBe("unavailable")
    const block2 = report.blocks[1]!.attempts!
    if (block2.kind !== "read") throw new Error("unreachable")
    expect(block2.contrast).toEqual({ kind: "exact", attempts: block2.on.total - block2.off.total })
    expect(block2.rows.find((row) => row.phase === "prefix")!.model).toBe("anthropic/claude-sonnet-4-5")

    const text = renderEvaluationReport(report)
    expect(text).toContain("COST — newly issued MAD attempts: a workflow-use contrast, never token cost, money, subscription quota or physical requests")
    expect(text).toContain("shared prefix, counted once: 10 attempt(s) (10 first, 0 retries)")
    expect(text).toContain("1 admitted attempt(s) settled `not-issued` never reached a backend and are excluded")
    expect(text).not.toContain("COST is OBSERVED per-block execution cost")
    expect(text).not.toMatch(/ON − OFF newly executed: .* tokens/)
  })
})
