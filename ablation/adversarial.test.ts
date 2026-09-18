/**
 * Story 2-7b — `runAdversarialSuite` end to end over a scripted backend and real
 * git: the healthy sixteen runs, the one observer value, every preflight
 * refusal, the shared experiment ledger and the adversarial gate. Scripted only:
 * nothing here says anything about a live model.
 */

import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { chmod, mkdir, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { emptyTokenUsage } from "../core/domain/run-record.ts"
import { ADVERSARIAL_CASES } from "../fixtures/adversarial/material.ts"
import { ADVERSARIAL_SEAL } from "../fixtures/adversarial/seal.ts"
import { deliveryOf, deliveryProbe, runAdversarialSuite, sharedLedgerProblem, worktreeFor } from "./adversarial.ts"
import { ADVERSARIAL_ALLOWANCES } from "./governor.ts"
import { experimentRoot, sealedSuite } from "./adversarial-read.fixture.ts"
import {
  ADVERSARIAL_DIRECTORY,
  ADVERSARIAL_START_MARKER_FILE,
  adversarialDirectory,
  readAdversarialSlotStatuses,
} from "./adversarial-schedule.ts"
import { BUNDLE_FILE } from "./bundle.ts"
import { HALT_MARKER_FILE } from "./governor.ts"
import { JOURNAL_FILE, LOCK_FILE } from "./journal.ts"
import { MANIFEST_FILE } from "./manifest.ts"
import { parseManifest } from "./read-bundle.ts"
import { SCHEDULE_FILE, START_MARKER_FILE } from "./schedule.ts"
import { ADVERSARIAL_CASES as CASES } from "../fixtures/adversarial/material.ts"
import type { ModelBackend } from "../core/ports/model-backend.ts"
import { readToolTrace } from "./tool-trace.ts"

const HERE = process.cwd()
const scratch: string[] = []
afterEach(async () => {
  // `opencodeTools` rebinds Bun's shared `$` to each worktree; restore it.
  $.cwd(HERE)
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})

const exists = (file: string) =>
  readFile(file).then(
    () => true,
    () => false,
  )

/** Journal lines for spend already recorded at the root by another category. */
async function seedJournal(root: string, category: "blocks" | "adversarial", tokens: number): Promise<void> {
  await mkdir(root, { recursive: true })
  const issued = {
    type: "issued",
    physicalId: "request-seed",
    category,
    block: category === "blocks" ? 1 : null,
    phase: category === "blocks" ? "prefix" : null,
    stage: "discover",
    slot: "discovery-1",
    attempt: 1,
    runId: "run-seed",
  }
  const settled = { type: "settled", physicalId: "request-seed", settlement: { kind: "usage", tokens: { ...emptyTokenUsage(), input: tokens } } }
  await writeFile(join(root, JOURNAL_FILE), `${JSON.stringify(issued)}\n${JSON.stringify(settled)}\n`)
}

describe("runAdversarialSuite — sixteen healthy scripted runs over real git", () => {
  test("every slot completes in schedule order, with a manifest, delivery evidence and the adversarial spend", async () => {
    const { root, input, schedule, calls } = await sealedSuite(scratch)
    const outcome = await runAdversarialSuite(input)
    if (!outcome.ok) throw new Error(outcome.reason)

    expect(outcome.complete).toBe(true)
    expect(outcome.slots.map((slot) => `${slot.position}:${slot.caseId}:${slot.side}:${slot.status}`)).toEqual(
      schedule.slots.map((slot) => `${slot.position}:${slot.caseId}:${slot.side}:completed`),
    )
    // Runs execute in schedule order, one at a time.
    const order = calls.map((call) => call.position).filter((position, index, all) => all[index - 1] !== position)
    expect(order).toEqual(schedule.slots.map((slot) => slot.position))

    // All spend is Adversarial, in the root's journal.
    expect(Object.keys(outcome.bill.byCategory)).toEqual(["adversarial"])
    expect(outcome.bill.requests.every((request) => request.category === "adversarial" && request.block === null)).toBe(true)
    expect(outcome.overshoot.adversarial.limit).toBe(400_000)

    for (const slot of outcome.slots) {
      expect(slot.manifest?.kind).toBe("written")
      if (slot.manifest?.kind !== "written") continue
      const parsed = parseManifest(JSON.parse(await readFile(join(slot.manifest.directory, MANIFEST_FILE), "utf8")))
      if (!parsed.ok) throw new Error(parsed.reason)
      expect(parsed.value.adversarial).toEqual({ scheduleHash: schedule.scheduleHash, caseId: slot.caseId, side: slot.side, position: slot.position })
      expect(parsed.value.identity.fixtureHash).toEqual({ kind: "known", value: ADVERSARIAL_SEAL.materialHash })
      expect(parsed.value.dials.cap).toBe(25_000)
      expect(slot.manifest.directory.startsWith(join(adversarialDirectory(root), slot.side, String(slot.caseIndex)))).toBe(true)
      if (slot.side === "attack") {
        expect(slot.delivery?.carried).toBe("yes")
        expect(slot.delivery?.furthestStage).toBe("judge")
      } else {
        expect(slot.delivery).toBeUndefined()
      }
    }

    // The clean side's prompts never held a payload; each attack's did.
    for (const material of ADVERSARIAL_CASES) {
      const clean = calls.filter((call) => call.caseId === material.id && call.side === "clean")
      const attack = calls.filter((call) => call.caseId === material.id && call.side === "attack")
      expect(clean.some((call) => call.input.includes(material.payload))).toBe(false)
      expect(attack.some((call) => call.input.includes(material.payload))).toBe(true)
    }

    // The suite wrote under <root>/adversarial and nothing of the paired runner's at the root.
    for (const name of [SCHEDULE_FILE, START_MARKER_FILE, BUNDLE_FILE]) expect(await exists(join(root, name))).toBe(false)
    expect(await exists(join(root, JOURNAL_FILE))).toBe(true)
    expect(await exists(join(root, LOCK_FILE))).toBe(false)
    expect(await exists(join(adversarialDirectory(root), BUNDLE_FILE))).toBe(true)
    expect((await readAdversarialSlotStatuses(root)).filter((line) => line.status !== "started")).toHaveLength(16)
  })

  test("ONE observer reaches both opencodeTools and review(): every run's trace holds the core's and the adapter's facts", async () => {
    const { root, input } = await sealedSuite(scratch)
    const outcome = await runAdversarialSuite(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    const trace = await readToolTrace(join(adversarialDirectory(root), "tool-trace.jsonl"))
    if (trace.kind !== "read") throw new Error(trace.kind)
    expect(trace.torn).toEqual([])
    for (const slot of outcome.slots) {
      const lines = trace.lines.filter((line) => line.slot === `${slot.caseId}:${slot.side}`)
      // The judge's half, through `review()`'s `toolObservation`.
      expect(lines.filter((line) => line.type === "request").length).toBeGreaterThan(0)
      expect(lines.filter((line) => line.type === "outcome").length).toBeGreaterThan(0)
      // The adapter's half, through `opencodeTools`'s `toolObservation`.
      expect(lines.filter((line) => line.type === "invoked").length).toBeGreaterThan(0)
      expect(lines.filter((line) => line.type === "shellOutcome").length).toBeGreaterThan(0)
      // Run-bound: every core event names this run, and blame ran in this run's worktree.
      for (const line of lines) {
        if (line.type === "request" || line.type === "outcome") expect(line.event.context.runId).toBe(slot.runId!)
      }
      expect(lines.some((line) => line.type === "shellOutcome" && line.fact.launch === "proved")).toBe(true)
    }
  })
})

describe("runAdversarialSuite — preflight refuses before the start marker", () => {
  const marker = (root: string) => join(adversarialDirectory(root), ADVERSARIAL_START_MARKER_FILE)

  test("seal drift: one payload byte refuses before any run, naming the hash", async () => {
    const { root, input, calls } = await sealedSuite(scratch)
    const drifted = ADVERSARIAL_CASES.map((c, index) => (index === 4 ? { ...c, payload: c.payload.replace("1-2", "1-3") } : c))
    const outcome = await runAdversarialSuite({ ...input, cases: drifted })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain(ADVERSARIAL_SEAL.materialHash)
    expect(calls).toHaveLength(0)
    expect(await exists(marker(root))).toBe(false)
  })

  test("a halt at the root refuses; the start marker is not written and the schedule stays usable", async () => {
    const { root, input } = await sealedSuite(scratch)
    await writeFile(join(root, HALT_MARKER_FILE), "{}\n")
    const refused = await runAdversarialSuite(input)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toContain("halted")
    expect(await exists(marker(root))).toBe(false)
    expect(await exists(join(root, LOCK_FILE))).toBe(false)
    // The halt is checked before the first write under `adversarial/`.
    expect(await exists(join(adversarialDirectory(root), BUNDLE_FILE))).toBe(false)

    await unlink(join(root, HALT_MARKER_FILE))
    const outcome = await runAdversarialSuite(input)
    expect(outcome.ok).toBe(true)
  })

  test("an already started schedule is refused", async () => {
    const { root, input, calls } = await sealedSuite(scratch)
    await writeFile(marker(root), "{}\n")
    const outcome = await runAdversarialSuite(input)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain("already started")
    expect(calls).toHaveLength(0)
  })

  test("a competing writer holding the root's lock is refused", async () => {
    const { root, input } = await sealedSuite(scratch)
    await writeFile(join(root, LOCK_FILE), "{}\n")
    const outcome = await runAdversarialSuite(input)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain("another writer")
    expect(await exists(marker(root))).toBe(false)
  })

  test("a fresh ledger elsewhere is refused: a root nested in another experiment, or an adversarial journal", async () => {
    const outer = await experimentRoot(scratch)
    await seedJournal(outer, "blocks", 10)
    const nested = join(outer, "inner")
    expect(await sharedLedgerProblem(nested)).toContain("nested inside another experiment root")

    const { root, input } = await sealedSuite(scratch)
    await writeFile(join(adversarialDirectory(root), JOURNAL_FILE), "")
    const outcome = await runAdversarialSuite(input)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain("must not keep a ledger of its own")
  })

  test("containment is checked on real paths: a worktrees link that puts the bundle root inside a worktree refuses", async () => {
    const base = await experimentRoot(scratch)
    // The experiment root sits inside what the link makes the first worktree's path.
    const root = join(base, "..", "adv-01-clean", "experiment")
    await mkdir(join(root, ADVERSARIAL_DIRECTORY), { recursive: true })
    await symlink(join(base, ".."), join(root, ADVERSARIAL_DIRECTORY, "worktrees"))
    const { input } = await sealedSuite(scratch, { root })
    expect(worktreeFor(root, { caseId: "adv-01", side: "clean" })).toBe(join(root, ADVERSARIAL_DIRECTORY, "worktrees", "adv-01-clean"))
    const outcome = await runAdversarialSuite(input)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain("points inside the repository under review")
    expect(await exists(marker(root))).toBe(false)
  })
})

describe("runAdversarialSuite — one experiment, one ledger", () => {
  test("Blocks spend already at the root counts toward the global cap", async () => {
    const { root, input, calls } = await sealedSuite(scratch)
    await seedJournal(root, "blocks", 2_000_000)
    const outcome = await runAdversarialSuite(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(calls).toHaveLength(0)
    expect(outcome.bill.refusedAdversarial.length).toBeGreaterThan(0)
    expect(outcome.bill.refusedAdversarial[0]!.reason).toContain("global cap is exhausted: 2000000 of 2000000")
    expect(outcome.slots.every((slot) => slot.status === "failed")).toBe(true)
    expect(outcome.complete).toBe(false)
  })

  test("a halt written at the root during the suite refuses the next adversarial request", async () => {
    const { root, input } = await sealedSuite(scratch)
    const backendFor = input.backendFor
    const outcome = await runAdversarialSuite({
      ...input,
      backendFor: (context, reporter) => {
        if (context.position === 2) writeFileSync(join(root, HALT_MARKER_FILE), "{}\n")
        return backendFor(context, reporter)
      },
    })
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.slots[0]!.status).toBe("completed")
    expect(outcome.slots[1]!.status).toBe("failed")
    expect(outcome.bill.refusedAdversarial[0]!.cause).toBe("halted")
    expect(outcome.slots.slice(2).every((slot) => slot.status === "not-attempted")).toBe(true)
  })

  test("the Adversarial allowance spent: each run is refused `budget`, recorded failed, and never replaced", async () => {
    const { root, input, calls } = await sealedSuite(scratch)
    await seedJournal(root, "adversarial", 400_000)
    const outcome = await runAdversarialSuite(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(calls).toHaveLength(0)
    expect(outcome.bill.refusedAdversarial.every((refusal) => refusal.cause === "budget")).toBe(true)
    expect(outcome.bill.refusedAdversarial[0]!.reason).toContain("Adversarial allowance is exhausted: 400000 of 400000")
    expect(outcome.slots).toHaveLength(16)
    for (const slot of outcome.slots) {
      expect(slot.status).toBe("failed")
      expect(slot.reason).toContain("a gate denied it planned work")
    }
    const statuses = await readAdversarialSlotStatuses(root)
    expect(statuses.filter((line) => line.status === "started")).toHaveLength(16)
    // No request went out, so delivery cannot be shown, and the record says why.
    for (const slot of outcome.slots.filter((entry) => entry.side === "attack")) {
      expect(slot.delivery?.carried).toBe("unshown")
      expect(slot.delivery?.requests).toBe(0)
      expect(slot.delivery?.reason).toContain("the run issued no model request")
    }
  })

  test("spend already past the Adversarial allowance is reported as overshoot", async () => {
    const { root, input } = await sealedSuite(scratch)
    await seedJournal(root, "adversarial", 450_000)
    const outcome = await runAdversarialSuite(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.overshoot.adversarial).toEqual({ limit: 400_000, spent: 450_000, overshoot: 50_000 })
  })

  test("unknown usage halts: the marker is written and no later case is admitted", async () => {
    const { root, input } = await sealedSuite(scratch, {
      script: { usage: (context) => (context.position === 1 ? { unknown: "the host reported nothing" } : { ...emptyTokenUsage(), input: 10 }) },
    })
    const outcome = await runAdversarialSuite(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.governor.halted).toBe(true)
    expect(await exists(join(root, HALT_MARKER_FILE))).toBe(true)
    expect(outcome.slots.slice(1).every((slot) => slot.status === "not-attempted")).toBe(true)
    expect(outcome.complete).toBe(false)
    // Not resumed automatically. With the start marker taken away, the halt is
    // what refuses the next invocation.
    await unlink(join(adversarialDirectory(root), ADVERSARIAL_START_MARKER_FILE))
    const again = await runAdversarialSuite(input)
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.reason).toContain("already halted")
  })
})

describe("the dumps sit under the adversarial directory, one per run", () => {
  test("each run's dump directory is <adversarial>/<side>/<caseIndex>/<runId>", async () => {
    const { root, input } = await sealedSuite(scratch)
    const outcome = await runAdversarialSuite(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    for (const side of ["clean", "attack"]) {
      expect((await readdir(join(adversarialDirectory(root), side))).sort()).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"])
    }
  })
})

describe("runner review patches", () => {
  test("the allowance covers the schedule: runs × runCap is the Adversarial allowance, and the schedule plans that many runs", async () => {
    expect(ADVERSARIAL_ALLOWANCES.runs * ADVERSARIAL_ALLOWANCES.runCap).toBe(ADVERSARIAL_ALLOWANCES.adversarial)
    const { schedule } = await sealedSuite(scratch)
    expect(schedule.slots).toHaveLength(ADVERSARIAL_ALLOWANCES.runs)
  })

  test("maxConcurrency above 1 is refused, with the reason", async () => {
    const { input, calls } = await sealedSuite(scratch)
    const outcome = await runAdversarialSuite({ ...input, config: { ...input.config, maxConcurrency: 2 } })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain("one-slot roster over a shared")
    expect(calls).toHaveLength(0)
  })

  test("the ancestor walk treats a lock, a halt marker or a start marker above the root as an experiment root", async () => {
    for (const name of [LOCK_FILE, HALT_MARKER_FILE, START_MARKER_FILE]) {
      const outer = await experimentRoot(scratch)
      await mkdir(outer, { recursive: true })
      await writeFile(join(outer, name), "{}\n")
      expect(await sharedLedgerProblem(join(outer, "inner")), name).toContain("nested inside another experiment root")
    }
  })

  test("the ancestor walk stops, without refusing, at an unreadable marker (EACCES) or a marker path through a file (ENOTDIR)", async () => {
    const unreadable = await experimentRoot(scratch)
    await mkdir(unreadable, { recursive: true })
    await writeFile(join(unreadable, JOURNAL_FILE), "")
    await chmod(join(unreadable, JOURNAL_FILE), 0o000)
    try {
      expect(await sharedLedgerProblem(join(unreadable, "inner"))).toBeNull()
    } finally {
      await chmod(join(unreadable, JOURNAL_FILE), 0o600)
    }

    const notDirectory = await experimentRoot(scratch)
    await mkdir(notDirectory, { recursive: true })
    await writeFile(join(notDirectory, ADVERSARIAL_DIRECTORY), "a file where a directory would be")
    expect(await sharedLedgerProblem(join(notDirectory, "inner"))).toBeNull()
  })

  test("the delivery probe counts only a request that went out, reads the instructions too, and keeps a thrown request uncertain", async () => {
    const payload = CASES[0]!.payload
    const answers: Awaited<ReturnType<ModelBackend["runTurn"]>>[] = [
      { ok: true, slot: "s", value: {} as never, tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
      { ok: false, slot: "s", failure: "cancelled", message: "stopped before it went out" } as never,
    ]
    let call = 0
    const inner: ModelBackend = {
      capabilities: () => ({ tools: true }),
      async runTurn() {
        call += 1
        if (call === 3) throw new Error("socket closed")
        return answers[call - 1] as never
      },
    }
    const probe = deliveryProbe(payload)
    const backend = probe.wrap(inner)
    await backend.runTurn("s", `instructions quoting ${payload}`, "input", {} as never)
    await backend.runTurn("s", "instructions", `input ${payload}`, {} as never)
    await expect(backend.runTurn("s", "instructions", `input ${payload}`, {} as never)).rejects.toThrow("socket closed")
    expect(probe.counts()).toEqual({ requests: 1, carrying: 1, uncertain: 1, uncertainCarrying: 1 })
  })

  test("delivery is `no` when requests went out without the payload, and `unshown` when a payload request threw", () => {
    const material = CASES[0]!
    expect(deliveryOf(material, undefined, { requests: 3, carrying: 0, uncertain: 0, uncertainCarrying: 0 }).carried).toBe("no")
    const thrown = deliveryOf(material, undefined, { requests: 2, carrying: 0, uncertain: 1, uncertainCarrying: 1 })
    expect(thrown.carried).toBe("unshown")
    expect(thrown.reason).toContain("threw")
  })
})

