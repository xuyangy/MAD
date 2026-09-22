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
import { deliveryOf, deliveryProbe, furthestStage, runAdversarialSuite, sharedLedgerProblem, worktreeFor } from "./adversarial.ts"
import { spawnGit, type RunGit } from "./adversarial-materialize.ts"
import { ADVERSARIAL_ALLOWANCES } from "./governor.ts"
import { concurrencyProblem } from "./adversarial-schedule.ts"
import { experimentRoot, sealedSuite } from "./adversarial-read.fixture.ts"
import {
  ADVERSARIAL_BILL_FILE,
  ADVERSARIAL_DIRECTORY,
  ADVERSARIAL_START_MARKER_FILE,
  adversarialDirectory,
  readAdversarialBill,
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
import {
  createToolTraceSink,
  readToolTrace,
  TOOL_TRACE_FILE,
  traceUnresolved,
  TraceUnresolvedError,
} from "./tool-trace.ts"

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

describe("the runner's cancellation, worktree failures and durable bill", () => {
  test("a cancellation mid-suite marks that slot cancelled, later slots not attempted, and the suite incomplete", async () => {
    const { root, input } = await sealedSuite(scratch)
    const controller = new AbortController()
    const backendFor = input.backendFor
    const outcome = await runAdversarialSuite({
      ...input,
      signal: controller.signal,
      backendFor: (context, reporter) => {
        if (context.position === 3) controller.abort()
        return backendFor(context, reporter)
      },
    })
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.slots.slice(0, 2).map((slot) => slot.status)).toEqual(["completed", "completed"])
    expect(outcome.slots[2]!.status).toBe("cancelled")
    expect(outcome.slots.slice(3).every((slot) => slot.status === "not-attempted")).toBe(true)
    expect(outcome.complete).toBe(false)
    const durable = await readAdversarialSlotStatuses(root)
    expect(durable.filter((line) => line.position === 3).at(-1)!.status).toBe("cancelled")
  })

  test("a worktree that cannot be written fails its slot, issues nothing for it, and the suite goes on", async () => {
    const { input, calls } = await sealedSuite(scratch)
    const git: RunGit = (cwd, args, stdin) =>
      cwd.endsWith("adv-02-attack") && args[0] === "apply"
        ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "scripted apply failure" })
        : spawnGit(cwd, args, stdin)
    const outcome = await runAdversarialSuite({ ...input, git })
    if (!outcome.ok) throw new Error(outcome.reason)
    const failed = outcome.slots.find((slot) => slot.caseId === "adv-02" && slot.side === "attack")!
    expect(failed.status).toBe("failed")
    expect(failed.reason).toContain("could not be written, so nothing was issued")
    expect(calls.some((call) => call.position === failed.position)).toBe(false)
    expect(outcome.slots.filter((slot) => slot !== failed).every((slot) => slot.status === "completed")).toBe(true)
  })

  test("a worktree that fails containment after it is written fails its slot and ends the suite", async () => {
    const { root, input, calls } = await sealedSuite(scratch)
    const git: RunGit = async (cwd, args, stdin) => {
      if (cwd.endsWith("adv-01-attack") && args[0] === "apply") {
        // The worktree path becomes a link to a directory holding the bundle root.
        await rm(cwd, { recursive: true, force: true })
        await symlink(join(root, ".."), cwd)
        return { exitCode: 0, stdout: "", stderr: "" }
      }
      return spawnGit(cwd, args, stdin)
    }
    const outcome = await runAdversarialSuite({ ...input, git })
    if (!outcome.ok) throw new Error(outcome.reason)
    const breached = outcome.slots[1]!
    expect(`${breached.caseId} ${breached.side}`).toBe("adv-01 attack")
    expect(breached.status).toBe("failed")
    expect(breached.reason).toContain("failed the AD-16 containment check, so nothing was issued")
    expect(calls.some((call) => call.position === 2)).toBe(false)
    expect(outcome.slots.slice(2).every((slot) => slot.status === "not-attempted")).toBe(true)
  })

  test("a bundle index that cannot be written leaves no start marker, and a retry once it can succeeds", async () => {
    const { root, input } = await sealedSuite(scratch)
    await mkdir(join(adversarialDirectory(root), BUNDLE_FILE), { recursive: true })
    const refused = await runAdversarialSuite(input)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toContain("the adversarial bundle index could not be written")
    expect(await exists(join(adversarialDirectory(root), ADVERSARIAL_START_MARKER_FILE))).toBe(false)
    await rm(join(adversarialDirectory(root), BUNDLE_FILE), { recursive: true })
    const outcome = await runAdversarialSuite(input)
    expect(outcome.ok).toBe(true)
  })

  test("the runner leaves the journal's bill beside the slots, for the reader", async () => {
    const { root, input } = await sealedSuite(scratch)
    const outcome = await runAdversarialSuite(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    const bill = await readAdversarialBill(root)
    if (bill.kind !== "read") throw new Error(bill.kind)
    expect(bill.bill.scheduleHash).toBe(outcome.schedule.scheduleHash)
    expect(bill.bill.overshoot.adversarial).toEqual(outcome.overshoot.adversarial)
    expect(bill.bill.adversarialKnown).toBeGreaterThan(0)
    expect(await exists(join(adversarialDirectory(root), ADVERSARIAL_BILL_FILE))).toBe(true)
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

describe("the runner's preflight, delivery and ledger checks", () => {
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

  test("maxConcurrency of 0, a negative number, NaN or a fraction is refused; exactly 1 is accepted", async () => {
    for (const value of [0, -1, Number.NaN, 1.5]) {
      const { input, calls } = await sealedSuite(scratch)
      const outcome = await runAdversarialSuite({ ...input, config: { ...input.config, maxConcurrency: value } })
      expect(outcome.ok, String(value)).toBe(false)
      if (!outcome.ok) expect(outcome.reason, String(value)).toContain("must be absent or exactly 1")
      expect(calls).toHaveLength(0)
    }
    expect(concurrencyProblem({ maxConcurrency: 1 })).toBeNull()
  })

  test("furthest stage is read off the findings, not the stage counts every record carries", () => {
    const record = (findings: unknown[]) => ({ findings, judgeCounts: {}, debateCounts: {}, routeCounts: {} }) as never
    expect(furthestStage(record([]), 0)).toBe("none")
    expect(furthestStage(record([]), 2)).toBe("discover")
    expect(furthestStage(record([{ id: "f", route: "judge", history: [] }]), 1)).toBe("route")
    expect(furthestStage(record([{ id: "f", route: "debate", history: [{ stage: "debate" }] }]), 1)).toBe("debate")
    expect(furthestStage(record([{ id: "f", verdict: "upheld", history: [] }]), 1)).toBe("judge")
  })

  test("the ancestor walk treats a lock, a halt marker or a start marker above the root as an experiment root", async () => {
    for (const name of [LOCK_FILE, HALT_MARKER_FILE, START_MARKER_FILE]) {
      const outer = await experimentRoot(scratch)
      await mkdir(outer, { recursive: true })
      await writeFile(join(outer, name), "{}\n")
      expect(await sharedLedgerProblem(join(outer, "inner")), name).toContain("nested inside another experiment root")
    }
  })

  test("the ancestor walk refuses at a journal it cannot read, and a marker path through a file is absent for that marker only", async () => {
    const unreadable = await experimentRoot(scratch)
    await mkdir(unreadable, { recursive: true })
    await writeFile(join(unreadable, JOURNAL_FILE), "")
    await chmod(join(unreadable, JOURNAL_FILE), 0o000)
    try {
      expect(await sharedLedgerProblem(join(unreadable, "inner"))).toContain("nested inside another experiment root")
    } finally {
      await chmod(join(unreadable, JOURNAL_FILE), 0o600)
    }

    const notDirectory = await experimentRoot(scratch)
    await mkdir(notDirectory, { recursive: true })
    await writeFile(join(notDirectory, ADVERSARIAL_DIRECTORY), "a file where a directory would be")
    expect(await sharedLedgerProblem(join(notDirectory, "inner"))).toBeNull()
    // The walk goes on past that ancestor: a journal one level further up still refuses.
    await writeFile(join(notDirectory, "..", JOURNAL_FILE), "")
    try {
      expect(await sharedLedgerProblem(join(notDirectory, "inner"))).toContain("nested inside another experiment root")
    } finally {
      await unlink(join(notDirectory, "..", JOURNAL_FILE))
    }
  })

  test("the delivery probe counts only a request that went out, reads the instructions too, and keeps a thrown or unbilled failure uncertain", async () => {
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
    expect(probe.counts()).toEqual({ requests: 1, carrying: 1, uncertain: 2, uncertainCarrying: 2 })
  })

  test("delivery is `no` when requests went out without the payload, and `unshown` when a payload request threw", () => {
    const material = CASES[0]!
    expect(deliveryOf(material, undefined, { requests: 3, carrying: 0, uncertain: 0, uncertainCarrying: 0 }).carried).toBe("no")
    const thrown = deliveryOf(material, undefined, { requests: 2, carrying: 0, uncertain: 1, uncertainCarrying: 1 })
    expect(thrown.carried).toBe("unshown")
    expect(thrown.reason).toContain("threw")
  })
})


describe("the quarantine, end to end (story 2-7c)", () => {
  /**
   * A launcher whose child never exits and ignores the kill, so the cleanup
   * budget is what ends the call. The real deadline is exercised against real
   * processes in `adapters/opencode/tools-observation.test.ts`; here the point is
   * what the SUITE does when the adapter reports one.
   */
  const unkillableSpawn = () => {
    const launches: string[][] = []
    const spawn = (request: { cmd: string[]; cwd: string }) => {
      launches.push([...request.cmd])
      return {
        // REAL, OPENABLE, NEVER-ENDING PIPES. A missing pipe is its own failure
        // and would short-circuit before the deadline; what this row is about is
        // a command that runs past its execution budget and then cannot be
        // confirmed terminated.
        pid: 40404,
        stdout: new ReadableStream<Uint8Array>({ start: () => undefined }),
        stderr: new ReadableStream<Uint8Array>({ start: () => undefined }),
        exited: new Promise<number>(() => {}),
        exitCode: null,
        signalCode: null,
        kill: () => undefined,
      }
    }
    return { spawn, launches }
  }

  test("AN UNCONFIRMED PROCESS CLEANUP stops admission, halts, strands the rest and KEEPS THE LOCK", async () => {
    const { root, input, calls } = await sealedSuite(scratch)
    const { spawn, launches } = unkillableSpawn()

    const outcome = await runAdversarialSuite({
      ...input,
      spawnBlame: spawn,
      blameTimeoutMs: 5,
      blameCleanupTimeoutMs: 5,
    })
    if (!outcome.ok) throw new Error(outcome.reason)

    // The adapter refuses further launches, so exactly one process was started.
    expect(launches).toHaveLength(1)

    // THE HALT IS OPERATIONAL AND SAYS SO. A reader who opens
    // `unknown-usage-halt.json` must not be told money is unaccounted for.
    expect(outcome.bill.halt).toContain("OPERATIONAL HALT")
    expect(outcome.bill.halt).toContain("makes no claim about spend")
    expect(outcome.bill.halt).not.toContain("no spend is unaccounted for")
    expect(outcome.bill.halt).toContain("TERMINATION IS UNCONFIRMED")
    expect(outcome.bill.halt).toContain("40404")
    expect(outcome.bill.operational).toHaveLength(1)
    const marker = JSON.parse(await readFile(join(root, HALT_MARKER_FILE), "utf8")) as { haltReason: string }
    expect(marker.haltReason).toContain("OPERATIONAL HALT")

    // ADMISSION STOPPED AT THAT MOMENT, not at the end of the run. The judge
    // catches the blame failure and goes on to ask its fact-checker, so a
    // refusal has to already be in place — and it is, on the very run that hung.
    // NAMED EXACTLY, not "more than zero". The judge asks its fact-checker and
    // its logic evaluator after a blame failure, so the first run's remaining
    // admissions are the refusals under test, and a count that only had to beat
    // zero would pass on almost any behaviour.
    const refused = outcome.bill.refusedAdversarial
    expect(refused).toHaveLength(1)
    expect(refused[0]!.stage).toBe("judge")
    expect(refused[0]!.attempt).toBe(1)
    expect(refused[0]!.label).toBe(`${outcome.schedule.slots[0]!.caseId} ${outcome.schedule.slots[0]!.side}`)
    // A RUNNER STOP RATHER THAN A BUDGET REFUSAL, and the reason carries the
    // operational wording — so nothing in the refusal record implies the
    // Adversarial allowance ran out.
    expect(refused[0]!.cause).toBe("runner-stop")
    expect(refused[0]!.reason).toContain("OPERATIONAL HALT")

    // LATER SLOTS READ `not-attempted`, and the run's own evidence is kept. The
    // first slot's status is NAMED: `not("completed")` would have passed on
    // `cancelled`, on `not-attempted`, and on a slot that was never written.
    expect(outcome.slots[0]!.status).toBe("failed")
    expect(outcome.slots[0]!.reason).toContain("a gate denied it planned work")
    expect(outcome.slots).toHaveLength(16)
    expect(outcome.slots.slice(1).every((slot) => slot.status === "not-attempted")).toBe(true)
    expect(outcome.complete).toBe(false)
    const statuses = await readAdversarialSlotStatuses(root)
    expect(statuses.some((status) => status.status === "not-attempted")).toBe(true)

    // THE LOCK IS STILL HELD, and the warning says why and that recovery is by
    // hand. No automatic clearing anywhere.
    expect(await exists(join(root, LOCK_FILE))).toBe(true)
    expect(outcome.warnings.some((warning) => warning.includes("lock was NOT released"))).toBe(true)
    expect(outcome.warnings.some((warning) => warning.includes("check process 40404 by hand"))).toBe(true)

    // AND NO FURTHER PAID REQUEST WAS MADE AFTER THE LATCH.
    const positions = new Set(calls.map((call) => call.position))
    expect([...positions]).toEqual([outcome.schedule.slots[0]!.position])
  })

  test("AN UNCONFIRMED TRACE APPEND does the same, and no later run reuses the file", async () => {
    const { root, input } = await sealedSuite(scratch)

    const outcome = await runAdversarialSuite({
      ...input,
      traceTimeoutMs: 5,
      // An IO whose append never settles. The physical write may still be
      // running, so the file is not safe for any later run to touch.
      traceIo: { appendLine: () => new Promise<void>(() => {}) },
    })
    if (!outcome.ok) throw new Error(outcome.reason)

    // "DOES THE SAME" IS NOW ACTUALLY TESTED. Its process-cleanup sibling asserts
    // the cause, the operational wording, the stranded slots, the retained lock
    // and the warning; this row asserted three of those and claimed the rest.
    expect(outcome.bill.halt).toContain("OPERATIONAL HALT")
    expect(outcome.bill.halt).toContain("makes no claim about spend")
    expect(outcome.bill.halt).toContain("UNRESOLVED trace operation")
    expect(outcome.bill.operational).toHaveLength(1)

    const refused = outcome.bill.refusedAdversarial
    expect(refused.length).toBeGreaterThanOrEqual(1)
    expect(refused[0]!.cause).toBe("runner-stop")
    expect(refused[0]!.reason).toContain("OPERATIONAL HALT")
    expect(refused[0]!.label).toBe(`${outcome.schedule.slots[0]!.caseId} ${outcome.schedule.slots[0]!.side}`)

    expect(outcome.slots).toHaveLength(16)
    expect(outcome.slots.slice(1).every((slot) => slot.status === "not-attempted")).toBe(true)
    expect(await exists(join(root, LOCK_FILE))).toBe(true)
    expect(outcome.warnings.some((warning) => warning.includes("lock was NOT released"))).toBe(true)
    expect(outcome.complete).toBe(false)

    // AND NO LATER RUN MAY REUSE THE FILE. The sink refuses to be built over a
    // trace an operation has not let go of, which is the half that outlives this
    // suite's own admission stop.
    const traceFile = join(adversarialDirectory(root), TOOL_TRACE_FILE)
    expect(traceUnresolved(traceFile)).not.toBeNull()
    expect(() =>
      createToolTraceSink({ file: traceFile, binding: { caseId: "adv-01", side: "clean", position: 1 } }),
    ).toThrow(TraceUnresolvedError)
  })

  test("THE HEALTHY SUITE STILL RELEASES ITS LOCK — the non-vacuous sibling", async () => {
    // Without this row both above would pass on a runner that quarantined every
    // run it ever made.
    const { root, input } = await sealedSuite(scratch)
    const outcome = await runAdversarialSuite(input)
    if (!outcome.ok) throw new Error(outcome.reason)

    expect(outcome.complete).toBe(true)
    expect(outcome.bill.halt).toBeNull()
    expect(await exists(join(root, LOCK_FILE))).toBe(false)
    expect(outcome.warnings.some((warning) => warning.includes("lock was NOT released"))).toBe(false)
  })
})
