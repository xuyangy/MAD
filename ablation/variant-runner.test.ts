/**
 * `runVariantBlocks` end to end, through the real `prepareReview`,
 * `forkPreparedReview` and `continueReview`, the debate-variants journal, the
 * sealed schedule and the manifest writer. Fakes only: this proves the
 * runner's semantics over port calls and nothing about a real host.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ZodType } from "zod"

import { emptyTokenUsage } from "../core/domain/run-record.ts"
import type { Clock } from "../core/ports/clock.ts"
import { CODING_DISCOVERY_GENERALIST } from "../core/instructions/coding/discovery.ts"
import type { LateUsageReporter } from "../core/ports/late-usage.ts"
import type { BackendCapabilities, Envelope, ModelBackend } from "../core/ports/model-backend.ts"
import { selectRoster } from "../core/roster/select.ts"
import { candidate, DEFAULT_JUDGE_ANSWERS, fakeChange, fakeClock, judgeRoleOf } from "../core/test-support/fakes.ts"
import { LABELLED_CHANGE_SEAL } from "../fixtures/seeded-defects/seal.ts"
import { JOURNAL_FILE } from "./journal.ts"
import { writeArmDump } from "./bundle.ts"
import { buildManifest, known, MANIFEST_FILE, type RunManifest } from "./manifest.ts"
import { identityOf, runPairedBlocks, type PairedPhaseContext } from "./paired.ts"
import { parseManifest } from "./read-bundle.ts"
import { configDigestOf, readSlotStatuses, SCHEDULE_FILE, sha256, START_MARKER_FILE } from "./schedule.ts"
import { variantBindingProblem, runVariantBlocks, type RunVariantBlocksInput } from "./variant-runner.ts"
import { createVariantSchedule, variantScheduleHashOf, type VariantSchedule } from "./variant-schedule.ts"
import { VARIANT_ARM_OPTIONS, VARIANT_PROTOCOL_ID } from "./variants.ts"

const WORKTREE = new URL("..", import.meta.url).pathname
const ROUTING_PROTOCOL = new URL("../_bmad-output/specs/spec-mad-orchestrator/evaluation-protocol.md", import.meta.url).pathname

const scratch: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-variant-runner-"))
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
  prompt: string
}

/**
 * Discovery raises one critical finding (debated at any threshold), debate
 * abstains, each judge role gives the shared defaults. Every call is logged
 * with its phase and prompt.
 */
function scripted(fail?: (call: Call) => boolean) {
  const calls: Call[] = []
  const backendFor = (context: PairedPhaseContext, _reporter: LateUsageReporter): ModelBackend => ({
    capabilities: (): BackendCapabilities => ({ tools: true }),
    async runTurn<T>(slot: string, instructions: string, prompt: string, schema: ZodType<T>): Promise<Envelope<T>> {
      const role = judgeRoleOf(instructions)
      const stage: Stage = role !== undefined ? "judge" : instructions === CODING_DISCOVERY_GENERALIST.text ? "discover" : "debate"
      const call: Call = { ...context, stage, slot, prompt }
      calls.push(call)
      if (fail?.(call) === true) throw new Error("socket closed")
      const payload = role !== undefined ? DEFAULT_JUDGE_ANSWERS[role] : stage === "discover" ? CRITICAL : { turns: [] }
      const parsed = schema.safeParse(payload)
      if (!parsed.success) throw new Error(`fake payload for ${stage} did not parse`)
      return { ok: true, slot, value: parsed.data, tokens: { ...emptyTokenUsage(), input: 10, output: 20 } }
    },
  })
  return { calls, backendFor }
}

async function variantProtocol(): Promise<string> {
  const dir = await tempDir()
  const pending = `---\nid: ${VARIANT_PROTOCOL_ID}\nstatus: frozen\nversion: 1\nfrozen_hash: PENDING\n---\n\n# test\n`
  const file = join(dir, "protocol.md")
  await writeFile(file, pending.replace("frozen_hash: PENDING", `frozen_hash: ${sha256(pending)}`))
  return file
}

async function sealed(options: { draw?: number; fail?: (call: Call) => boolean; clock?: Clock } = {}) {
  const root = await tempDir()
  const resolved = selectRoster([candidate("anthropic", "claude-sonnet-4-5"), candidate("openai", "gpt-5")], {
    slots: 2,
    providerConfigKey: "provider",
  })
  const base = {
    bundleRoot: root,
    protocolFile: await variantProtocol(),
    fixture: LABELLED_CHANGE_SEAL,
    codeRevision: known({ commit: "abc123", dirty: false }),
    roster: resolved.roster,
    change: fakeChange(),
    config: { provenance: "scripted" as const },
  }
  const created = await createVariantSchedule({ ...base, createdAt: "2026-11-19T00:00:00.000Z", draw: () => options.draw ?? 5 })
  if (!created.ok) throw new Error(created.reason)
  const backend = scripted(options.fail)
  const input: RunVariantBlocksInput = {
    ...base,
    worktree: WORKTREE,
    priorWarnings: resolved.warnings,
    clock: options.clock ?? fakeClock(),
    backendFor: backend.backendFor,
  }
  return { root, input, calls: backend.calls, schedule: created.schedule }
}

async function manifestOf(directory: string): Promise<RunManifest> {
  const parsed = parseManifest(JSON.parse(await readFile(join(directory, MANIFEST_FILE), "utf8")))
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.value
}

const REFERENCES_REQUEST = "list in `references`"
const OPEN_QUESTIONS_REQUEST = "list it in `missingEvidence`"

describe("runVariantBlocks — the happy path", () => {
  test("nine slots in the sealed order, one shared prefix per block, each arm with its own options", async () => {
    const { root, input, calls, schedule } = await sealed({ draw: 5 })
    const outcome = await runVariantBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)

    expect(outcome.slots.map((slot) => `${slot.block}:${slot.arm}:${slot.position}:${slot.status}`)).toEqual(
      schedule.slots.map((slot) => `${slot.block}:${slot.arm}:${slot.position}:completed`),
    )
    expect(outcome.complete).toBe(true)

    // Scheduled order is execution order: each block's prefix, then its arms first to third.
    const phases = calls.map((call) => `${call.block}:${call.phase}`).filter((value, index, all) => all[index - 1] !== value)
    expect(phases).toEqual(schedule.order.flatMap((arms, index) => [`${index + 1}:prefix`, ...arms.map((arm) => `${index + 1}:${arm}`)]))

    // Each arm's debate requests carry exactly its options' instructions.
    for (const arm of ["baseline", "references", "open-questions"] as const) {
      const debate = calls.filter((call) => call.phase === arm && call.stage === "debate")
      expect(debate.length).toBeGreaterThan(0)
      const options = VARIANT_ARM_OPTIONS[arm]
      for (const call of debate) {
        expect(call.prompt.includes(REFERENCES_REQUEST)).toBe(options.debateReferences)
        expect(call.prompt.includes(OPEN_QUESTIONS_REQUEST)).toBe(options.debateMissingEvidence)
      }
    }

    // One prefix per block, forked, and every arm of the block names it.
    expect(outcome.prefixes.map((prefix) => [prefix.block, prefix.forked])).toEqual([
      [1, true],
      [2, true],
      [3, true],
    ])
    for (const slot of outcome.slots) {
      if (slot.manifest?.kind !== "written") throw new Error(`no manifest for ${slot.block} ${slot.arm}`)
      const manifest = await manifestOf(slot.manifest.directory)
      const prefix = outcome.prefixes.find((entry) => entry.block === slot.block)!
      expect(manifest.variant).toEqual({
        scheduleHash: schedule.scheduleHash,
        block: slot.block,
        arm: slot.arm,
        position: slot.position,
        prefixRunId: prefix.runId!,
        options: VARIANT_ARM_OPTIONS[slot.arm],
      })
      expect("experiment" in manifest).toBe(false)
      expect(manifest.dials.routingPolicy).toBe("shipped")
      expect(manifest.identity.armId).toBe(slot.arm)
    }

    // The journal is the debate-variants scope's, every issued line marked.
    const lines = (await readFile(join(root, JOURNAL_FILE), "utf8")).split("\n").filter(Boolean).map((row) => JSON.parse(row))
    const issued = lines.filter((line) => line.type === "issued")
    expect(issued.every((line) => line.scope === "debate-variants")).toBe(true)
    expect(new Set(issued.map((line) => line.phase))).toEqual(new Set(["prefix", "baseline", "references", "open-questions"]))
    expect(outcome.bill.scope).toBe("debate-variants")
    expect((await readSlotStatuses(root)).filter((line) => line.status === "completed")).toHaveLength(9)
  })
})

describe("runVariantBlocks — failures", () => {
  test("a prefix that throws with its requests settled leaves all three of its slots not attempted, and the next block runs", async () => {
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
    const { input, schedule } = await sealed({ clock })
    const outcome = await runVariantBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    const first = outcome.slots.filter((slot) => slot.block === 1)
    expect(first.map((slot) => slot.status)).toEqual(["not-attempted", "not-attempted", "not-attempted"])
    expect(first.map((slot) => slot.arm)).toEqual(schedule.order[0]!)
    expect(first.every((slot) => slot.reason.includes("the clock broke"))).toBe(true)
    expect(outcome.prefixes[0]).toMatchObject({ block: 1, forked: false })
    expect(outcome.slots.filter((slot) => slot.block !== 1).every((slot) => slot.status === "completed")).toBe(true)
    expect(outcome.complete).toBe(false)
  })

  test("a request that throws in one arm halts: that arm fails with its manifest, every later slot is not attempted", async () => {
    const { input, schedule } = await sealed({ fail: (call) => call.block === 2 && call.phase === "references" && call.stage === "judge" })
    const outcome = await runVariantBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    const at = schedule.slots.findIndex((slot) => slot.block === 2 && slot.arm === "references")
    const failed = outcome.slots[at]!
    expect(failed.status).toBe("failed")
    expect(failed.reason).toContain("the references continuation of block 2")
    expect(failed.manifest?.kind).toBe("written")
    expect(outcome.slots.slice(0, at).every((slot) => slot.status === "completed")).toBe(true)
    expect(outcome.slots.slice(at + 1).every((slot) => slot.status === "not-attempted" && slot.reason.includes("halted"))).toBe(true)
  })
})

describe("runVariantBlocks — refusals before the start marker", () => {
  async function refused(input: RunVariantBlocksInput, root: string, reason: string) {
    const outcome = await runVariantBlocks(input)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain(reason)
    await expect(readFile(join(root, START_MARKER_FILE))).rejects.toThrow()
  }

  test("a schedule whose sealed arm options were changed and rehashed", async () => {
    const { root, input } = await sealed()
    const file = join(root, SCHEDULE_FILE)
    const schedule = JSON.parse(await readFile(file, "utf8")) as VariantSchedule
    ;(schedule.config.arms as Record<string, Record<string, unknown>>).baseline!.debateReferences = true
    schedule.configDigest = configDigestOf(schedule.config)
    schedule.scheduleHash = variantScheduleHashOf(schedule)
    await writeFile(file, JSON.stringify(schedule))
    await refused(input, root, "seals arm options")
  })

  test("attempt accounting, and a routing protocol", async () => {
    const one = await sealed()
    await refused({ ...one.input, config: { provenance: "scripted", accounting: "attempts", route: "oauth" } }, one.root, "runs in tokens")
    const two = await sealed()
    await refused({ ...two.input, protocolFile: ROUTING_PROTOCOL }, two.root, "binds the frozen protocol PROTOCOL-mad-debate-variants")
  })

  test("the routing runner refuses a debate-variants schedule, and this runner a routing one", async () => {
    const { root, input } = await sealed()
    const routing = await runPairedBlocks({ ...input, protocolFile: ROUTING_PROTOCOL })
    expect(!routing.ok && routing.reason).toContain("has schedule version 2")
    await expect(readFile(join(root, START_MARKER_FILE))).rejects.toThrow()
  })

  test("a started schedule is never run again", async () => {
    const { input } = await sealed()
    expect((await runVariantBlocks(input)).ok).toBe(true)
    const again = await runVariantBlocks(input)
    expect(!again.ok && again.reason).toContain("already started")
  })
})

describe("runVariantBlocks — what it binds", () => {
  test("arm options sealed with their keys in another order verify, run and write every manifest", async () => {
    const { root, input } = await sealed()
    const file = join(root, SCHEDULE_FILE)
    const schedule = JSON.parse(await readFile(file, "utf8")) as VariantSchedule
    const arms = schedule.config.arms as Record<string, Record<string, unknown>>
    for (const arm of Object.keys(arms)) {
      const { policy, debateReferences, debateMissingEvidence } = arms[arm]!
      arms[arm] = { debateMissingEvidence, debateReferences, policy }
    }
    // Canonical JSON ignores key order, so neither hash changes.
    expect(variantScheduleHashOf(schedule)).toBe(schedule.scheduleHash)
    expect(configDigestOf(schedule.config)).toBe(schedule.configDigest)
    await writeFile(file, JSON.stringify(schedule))
    const outcome = await runVariantBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.slots.every((slot) => slot.status === "completed" && slot.manifest?.kind === "written")).toBe(true)
  })

  test("the caller's objects changed during the run change neither the dials, the run cap nor the manifests", async () => {
    let changed = false
    const holder: { input?: RunVariantBlocksInput } = {}
    const { input } = await sealed({
      fail: () => {
        if (!changed && holder.input !== undefined) {
          changed = true
          const config = holder.input.config as { maxRounds?: number; accounting?: string; route?: string; provenance: string }
          config.maxRounds = 1
          config.accounting = "attempts"
          config.route = "oauth"
          config.provenance = "live"
          ;(holder.input.roster.slots as unknown[]).pop()
        }
        return false
      },
    })
    holder.input = input
    const outcome = await runVariantBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(changed).toBe(true)
    expect(outcome.slots.every((slot) => slot.status === "completed")).toBe(true)
    const manifests = await Promise.all(
      outcome.slots.map((slot) => {
        if (slot.manifest?.kind !== "written") throw new Error("no manifest")
        return manifestOf(slot.manifest.directory)
      }),
    )
    expect(new Set(manifests.map((manifest) => manifest.dials.maxRounds)).size).toBe(1)
    expect(manifests.every((manifest) => manifest.dials.maxRounds !== 1)).toBe(true)
    expect(manifests.every((manifest) => manifest.dials.cap === 255_000)).toBe(true)
    expect(manifests.every((manifest) => manifest.roster.filled === 2)).toBe(true)
  })
})

describe("the variant manifest binding", () => {
  test("the writer refuses, and the builder throws on, a manifest given two bindings", async () => {
    const { input } = await sealed()
    const outcome = await runVariantBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    const run = outcome.runs[0]!
    const variant = {
      scheduleHash: outcome.schedule.scheduleHash,
      block: run.slot.block,
      arm: run.slot.arm,
      position: run.slot.position,
      prefixRunId: run.prefixRunId,
      options: { ...VARIANT_ARM_OPTIONS[run.slot.arm] },
    }
    const experiment = { scheduleHash: variant.scheduleHash, block: 1, arm: "on" as const, position: "first" as const, prefixRunId: run.prefixRunId }
    const root = await tempDir()
    const written = await writeArmDump({
      bundleRoot: root,
      run: run.run,
      change: fakeChange(),
      identity: identityOf(outcome.schedule),
      worktree: WORKTREE,
      variant,
      experiment,
    })
    expect(written).toEqual({ kind: "refused", reason: "a manifest carries at most one binding, and this one was given experiment and variant" })
    expect(() =>
      buildManifest({
        record: run.run.record,
        change: fakeChange(),
        identity: { ...identityOf(outcome.schedule), armId: "a", repeatId: 0 },
        turnFiles: known(0),
        variant,
        adversarial: { scheduleHash: variant.scheduleHash, caseId: "c", side: "clean", position: 1 },
      }),
    ).toThrow("at most one binding")
  })

  test("variantBindingProblem: an unplanned slot, foreign options and a wrong prefix", async () => {
    const { schedule } = await sealed({ draw: 0 })
    const record = { forkedFrom: "prefix-1" } as never
    const ok = {
      scheduleHash: schedule.scheduleHash,
      block: 1,
      arm: "baseline" as const,
      position: "first" as const,
      prefixRunId: "prefix-1",
      options: { ...VARIANT_ARM_OPTIONS.baseline },
    }
    expect(variantBindingProblem(schedule, ok, record)).toBeNull()
    expect(variantBindingProblem(schedule, { ...ok, position: "second" }, record)).toContain("is not a slot")
    expect(variantBindingProblem(schedule, { ...ok, options: { ...ok.options, debateReferences: true } }, record)).toContain("not the ones")
    expect(variantBindingProblem(schedule, { ...ok, prefixRunId: "other" }, record)).toContain("forkedFrom")
  })

  test("parseManifest refuses a variant binding beside an experiment binding, foreign options and a debate-off policy", async () => {
    const { input } = await sealed()
    const outcome = await runVariantBlocks(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    const slot = outcome.slots.find((entry) => entry.arm === "references")!
    if (slot.manifest?.kind !== "written") throw new Error("no manifest")
    const raw = JSON.parse(await readFile(join(slot.manifest.directory, MANIFEST_FILE), "utf8")) as Record<string, unknown>
    expect(parseManifest(raw).ok).toBe(true)
    const variant = raw.variant as Record<string, unknown>
    const cases: [Record<string, unknown>, string][] = [
      [{ ...raw, experiment: { ...variant, arm: "on", position: "first" } }, "beside a paired `experiment`"],
      [{ ...raw, adversarial: {} }, "beside an `adversarial`"],
      [{ ...raw, variant: { ...variant, options: { ...VARIANT_ARM_OPTIONS.baseline } } }, "which are not arm references's"],
      [{ ...raw, variant: { ...variant, arm: "on" } }, "malformed `variant`"],
      [{ ...raw, variant: { ...variant, position: "fourth" } }, "malformed `variant`"],
      [{ ...raw, dials: { ...(raw.dials as object), routingPolicy: "debate-off" } }, "every debate-variants arm runs shipped"],
      [{ ...raw, variant: { ...variant, prefixRunId: "elsewhere" } }, "not its `run.forkedFrom`"],
    ]
    for (const [value, reason] of cases) {
      const parsed = parseManifest(value)
      expect(parsed.ok, reason).toBe(false)
      if (!parsed.ok) expect(parsed.reason).toContain(reason)
    }
  })
})
