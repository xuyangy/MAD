/**
 * Story 2-7b — `runAdversarialSuite` end to end over a scripted backend and real
 * git: the healthy sixteen runs, the one observer value, every preflight
 * refusal, the shared experiment ledger and the adversarial gate. Scripted only:
 * nothing here says anything about a live model.
 */

import { $ } from "bun"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
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
import { ATTEMPT_CONFIG, experimentRoot, frozenV3Copy, sealedSuite, targetFinding } from "./adversarial-read.fixture.ts"
import { ADVERSARIAL_ROOT_MARKER_FILE, isolatedRootProblem } from "./adversarial-schedule.ts"
import { ATTEMPT_MODE_STOP_PREFIX } from "./journal.ts"
import * as journalModule from "./journal.ts"
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

// ---------------------------------------------------------------------------
// Story 2-7e — the suite in attempt mode (protocol v3 B2 to B6), scripted
// ---------------------------------------------------------------------------

const PROTOCOL_V2_FILE = new URL("../_bmad-output/specs/spec-mad-orchestrator/evaluation-protocol-v2.md", import.meta.url).pathname

/** Settled attempts an earlier part of the suite would have left in its own journal. */
function settledAttempts(runId: string, count: number, from: number): string {
  let text = ""
  for (let index = 0; index < count; index += 1) {
    const physicalId = `seed-${from + index}`
    text += `${JSON.stringify({ type: "issued", physicalId, category: "adversarial", block: null, phase: null, stage: "discover", slot: "discovery-1", attempt: 1, runId, mode: "attempts", scope: "adversarial" })}\n`
    text += `${JSON.stringify({ type: "settled", physicalId, settlement: { kind: "usage", tokens: { ...emptyTokenUsage(), input: 1 } } })}\n`
  }
  return text
}

async function journalRows(root: string): Promise<Record<string, unknown>[]> {
  return (await readFile(join(root, JOURNAL_FILE), "utf8"))
    .split("\n")
    .filter((row) => row.length > 0)
    .map((row) => JSON.parse(row) as Record<string, unknown>)
}

describe("runAdversarialSuite in attempt mode", () => {
  test("the token-mode suite writes token lines and a token bill, and no root marker", async () => {
    const suite = await sealedSuite(scratch)
    const outcome = await runAdversarialSuite(suite.input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.complete).toBe(true)
    expect(outcome.bill.mode).toBeUndefined()
    expect(outcome.bill.scope).toBeUndefined()
    expect(outcome.overshoot.adversarial.limit).toBe(ADVERSARIAL_ALLOWANCES.adversarial)
    expect(outcome.overshoot.global.limit).toBe(ADVERSARIAL_ALLOWANCES.global)
    expect(outcome.overshoot.runTotals).toBeUndefined()
    for (const row of await journalRows(suite.root)) {
      expect("mode" in row || "scope" in row).toBe(false)
    }
    const bill = await readAdversarialBill(suite.root)
    if (bill.kind !== "read") throw new Error("no bill")
    expect(Object.keys(bill.bill).sort()).toEqual(
      ["adversarialKnown", "at", "globalKnown", "halt", "inFlight", "operational", "overshoot", "refused", "scheduleHash", "stop", "uncertain", "unknown"].sort(),
    )
    expect(await exists(join(suite.root, ADVERSARIAL_ROOT_MARKER_FILE))).toBe(false)
  })

  test("a healthy suite completes all sixteen, and the bill shows actual issued attempts against 30/480/480", async () => {
    const suite = await sealedSuite(scratch, { attempts: true })
    const outcome = await runAdversarialSuite(suite.input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.slots.map((slot) => slot.status)).toEqual(Array.from({ length: 16 }, () => "completed"))
    expect(outcome.complete).toBe(true)
    expect(outcome.bill.mode).toBe("attempts")
    expect(outcome.bill.scope).toBe("adversarial")
    // Every backend call is one issued attempt, journaled with the mode and the scope.
    const issued = (await journalRows(suite.root)).filter((row) => row.type === "issued")
    expect(issued).toHaveLength(suite.calls.length)
    expect(issued.every((row) => row.mode === "attempts" && row.scope === "adversarial" && row.category === "adversarial")).toBe(true)
    expect(outcome.overshoot.global).toEqual({ limit: 480, spent: suite.calls.length, overshoot: 0 })
    expect(outcome.overshoot.adversarial).toEqual({ limit: 480, spent: suite.calls.length, overshoot: 0 })
    expect(outcome.overshoot.runTotals).toHaveLength(16)
    for (const slot of outcome.slots) {
      const row = outcome.overshoot.runTotals!.find((entry) => entry.runId === slot.runId)!
      expect(row).toEqual({ runId: slot.runId!, limit: 30, spent: suite.calls.filter((call) => call.position === slot.position).length, overshoot: 0 })
    }
    expect(outcome.governor).toMatchObject({ accounting: "attempts", admittedAttempts: suite.calls.length, halted: false, runnerStop: null })

    const bill = await readAdversarialBill(suite.root)
    if (bill.kind !== "read") throw new Error("no bill")
    expect(bill.bill).toMatchObject({ accounting: "attempts", adversarialKnown: suite.calls.length, notIssued: 0, refused: [], halt: null, stop: null })
    expect(bill.bill.runs).toHaveLength(16)

    // Each manifest's adversarial binding records the accounting, and its spend is labelled unverified.
    const first = outcome.slots[0]!
    const leaf = join(adversarialDirectory(suite.root), first.side, String(first.caseIndex), first.runId!)
    const manifest = parseManifest(JSON.parse(await readFile(join(leaf, MANIFEST_FILE), "utf8")))
    if (!manifest.ok) throw new Error(manifest.reason)
    expect(manifest.value.adversarial).toMatchObject({ accounting: "attempts", caseId: first.caseId, side: first.side })
    expect(manifest.value.spend).toMatchObject({ source: "host-reported-unverified", usageCompleteness: "unverified", exposure: "unquantified" })
    expect(manifest.value.dials.cap).toBeNull()
  })

  test("unknown host usage is one attempt and a diagnostic: the suite still completes and nothing halts", async () => {
    const suite = await sealedSuite(scratch, { attempts: true, script: { usage: () => ({ unknown: "the host reported no usage" }) } })
    const outcome = await runAdversarialSuite(suite.input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.complete).toBe(true)
    expect(outcome.bill.halt).toBeNull()
    expect(outcome.bill.stop).toBeNull()
    expect(outcome.bill.unknown).toHaveLength(suite.calls.length)
    expect(outcome.overshoot.adversarial.spent).toBe(suite.calls.length)
    expect(await exists(join(suite.root, HALT_MARKER_FILE))).toBe(false)
  })

  test("a run refused on its own 30 fails for budget, and every later run proceeds", async () => {
    // One discovery turn and one judge turn per finding: 31 findings ask for 32 attempts.
    const many = (caseId: string) => ({
      findings: Array.from({ length: 31 }, (_unused, index) => ({
        ...targetFinding(caseId),
        claim: `Distinct defect number ${index} in module ${index}`,
        file: `src/module-${index}.ts`,
        startLine: 10 + index * 50,
        endLine: 12 + index * 50,
      })),
    })
    const suite = await sealedSuite(scratch, {
      attempts: true,
      script: { discovery: (context) => (context.position === 1 ? many(context.caseId) : undefined) },
    })
    const outcome = await runAdversarialSuite(suite.input)
    if (!outcome.ok) throw new Error(outcome.reason)
    const [first, ...rest] = outcome.slots
    expect(first!.status).toBe("failed")
    expect(first!.reason).toContain("a gate denied it planned work")
    expect(first!.reason).toContain("(budget)")
    expect(first!.reason).toContain("run's allowance is exhausted: 30 of 30 admitted attempts")
    expect(rest.map((slot) => slot.status)).toEqual(Array.from({ length: 15 }, () => "completed"))
    // Exactly thirty were issued for it; a refusal reached no backend and wrote no line.
    expect(suite.calls.filter((call) => call.position === 1)).toHaveLength(30)
    expect(outcome.overshoot.runTotals![0]).toEqual({ runId: first!.runId!, limit: 30, spent: 30, overshoot: 0 })
    expect(outcome.bill.refusedAdversarial.length).toBeGreaterThan(0)
    expect(outcome.bill.refusedAdversarial.every((refusal) => refusal.cause === "budget" && refusal.runId === first!.runId)).toBe(true)
    expect(outcome.bill.stop).toBeNull()
    expect(outcome.bill.halt).toBeNull()
    expect(outcome.complete).toBe(false)
    const bill = await readAdversarialBill(suite.root)
    if (bill.kind !== "read") throw new Error("no bill")
    expect(bill.bill.refused.length).toBe(outcome.bill.refusedAdversarial.length)
    expect(bill.bill.refused[0]).toMatchObject({ label: `${first!.caseId} ${first!.side}`, cause: "budget" })
  }, 60_000)

  test("a refusal on the root's 480 is a runner stop: nothing is issued, and every remaining slot is recorded with the reason", async () => {
    const suite = await sealedSuite(scratch, { attempts: true })
    let seed = ""
    for (let run = 1; run <= 16; run += 1) seed += settledAttempts(`earlier-${run}`, 30, run * 100)
    await writeFile(join(suite.root, JOURNAL_FILE), seed)
    const outcome = await runAdversarialSuite(suite.input)
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(suite.calls).toHaveLength(0)
    expect(outcome.bill.stop).toBe("the suite root's global allowance is exhausted: 480 of 480 admitted attempts")
    expect(outcome.slots[0]!.status).toBe("failed")
    expect(outcome.slots.slice(1).map((slot) => slot.status)).toEqual(Array.from({ length: 15 }, () => "not-attempted"))
    for (const slot of outcome.slots.slice(1)) expect(slot.reason).toContain("the suite root's global allowance is exhausted: 480 of 480 admitted attempts")
    expect(outcome.overshoot.global).toEqual({ limit: 480, spent: 480, overshoot: 0 })
    expect(outcome.complete).toBe(false)
    expect(outcome.governor.runnerStop).not.toBeNull()
    // A runner stop is not a halt: no marker is written.
    expect(outcome.bill.halt).toBeNull()
    expect(await exists(join(suite.root, HALT_MARKER_FILE))).toBe(false)
  })

  for (const [name, fault, why] of [
    ["a thrown runTurn", "throw", "did not end within its bound"],
    ["an attempt past its deadline", "abandoned", "did not end within its bound"],
  ] as const) {
    test(`${name} halts the suite: no retry, the marker written, every later slot never attempted`, async () => {
      const suite = await sealedSuite(scratch, {
        attempts: true,
        script: { fault: (context, _stage, index) => (context.position === 3 && index === 0 ? fault : undefined) },
      })
      const outcome = await runAdversarialSuite(suite.input)
      if (!outcome.ok) throw new Error(outcome.reason)
      // The faulted turn was issued once and never again.
      expect(suite.calls.filter((call) => call.position === 3)).toHaveLength(1)
      expect(outcome.bill.halt).toStartWith(ATTEMPT_MODE_STOP_PREFIX)
      expect(outcome.bill.halt).toContain(why)
      expect(outcome.bill.requests.filter((request) => request.abandoned === true)).toHaveLength(1)
      expect(outcome.slots.slice(0, 2).map((slot) => slot.status)).toEqual(["completed", "completed"])
      expect(outcome.slots[2]!.status).not.toBe("completed")
      expect(outcome.slots.slice(3).map((slot) => slot.status)).toEqual(Array.from({ length: 13 }, () => "not-attempted"))
      for (const slot of outcome.slots.slice(3)) expect(slot.reason).toContain("the experiment halted")
      expect(suite.calls.some((call) => call.position > 3)).toBe(false)
      expect(outcome.complete).toBe(false)
      expect(JSON.parse(await readFile(join(suite.root, HALT_MARKER_FILE), "utf8"))).toMatchObject({ halted: true, accounting: "attempts", scope: "adversarial" })
      // The halt is operational: the marker's reason makes no claim about spend.
      expect(outcome.governor.haltReason).toContain("token spend is not measured in this mode")
    })
  }

  test("a cancellation that arrives while an attempt is in flight halts the whole suite", async () => {
    const controller = new AbortController()
    const suite = await sealedSuite(scratch, {
      attempts: true,
      script: {
        onCall: (context, _stage, index) => {
          if (context.position === 2 && index === 0) controller.abort()
        },
      },
    })
    const outcome = await runAdversarialSuite({ ...suite.input, signal: controller.signal })
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.bill.halt).toStartWith(ATTEMPT_MODE_STOP_PREFIX)
    expect(outcome.bill.halt).toContain("was cancelled while an attempt of")
    // The turn answered, so the halt does not say its request is open.
    expect(outcome.bill.halt).toContain("that attempt returned, and a cancellation after issue ends the suite")
    expect(outcome.bill.halt).not.toContain("held open")
    expect(outcome.slots[0]!.status).toBe("completed")
    expect(outcome.slots[1]!.status).not.toBe("completed")
    expect(outcome.slots.slice(2).map((slot) => slot.status)).toEqual(Array.from({ length: 14 }, () => "not-attempted"))
    expect(suite.calls.some((call) => call.position > 2)).toBe(false)
    expect(await exists(join(suite.root, HALT_MARKER_FILE))).toBe(true)
    expect(outcome.complete).toBe(false)
  })

  test("a cancelled attempt that did not answer may still be open, and the halt says so", async () => {
    const controller = new AbortController()
    const suite = await sealedSuite(scratch, {
      attempts: true,
      script: {
        onCall: (context, _stage, index) => {
          if (context.position === 2 && index === 0) controller.abort()
        },
        fault: (context, _stage, index) => (context.position === 2 && index === 0 ? "error" : undefined),
      },
    })
    const outcome = await runAdversarialSuite({ ...suite.input, signal: controller.signal })
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.bill.halt).toStartWith(ATTEMPT_MODE_STOP_PREFIX)
    expect(outcome.bill.halt).toContain("that attempt did not end with an answer, so its request may still be held open")
    expect(outcome.slots.slice(2).map((slot) => slot.status)).toEqual(Array.from({ length: 14 }, () => "not-attempted"))
    expect(await exists(join(suite.root, HALT_MARKER_FILE))).toBe(true)
  })

  test("a turn the backend reports as cancelled before issue is not an attempt in flight: the suite stops and halts nothing", async () => {
    const controller = new AbortController()
    const suite = await sealedSuite(scratch, {
      attempts: true,
      script: {
        onCall: (context, _stage, index) => {
          if (context.position === 2 && index === 0) controller.abort()
        },
        fault: (context, _stage, index) => (context.position === 2 && index === 0 ? "cancelled" : undefined),
      },
    })
    const outcome = await runAdversarialSuite({ ...suite.input, signal: controller.signal })
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.bill.halt).toBeNull()
    expect(await exists(join(suite.root, HALT_MARKER_FILE))).toBe(false)
    // The suite still ends: a cancellation is a runner stop, and nothing later runs.
    expect(outcome.slots[1]!.status).not.toBe("completed")
    expect(outcome.slots.slice(2).map((slot) => slot.status)).toEqual(Array.from({ length: 14 }, () => "not-attempted"))
    expect(suite.calls.some((call) => call.position > 2)).toBe(false)
    expect(outcome.complete).toBe(false)
  })

  test("an admission refused for budget calls no backend, so a cancellation in that run records no attempt in flight", async () => {
    // The root is full: the run's first admission is refused inside the journal and `runTurn` is never entered.
    const controller = new AbortController()
    const suite = await sealedSuite(scratch, { attempts: true })
    let seed = ""
    for (let run = 1; run <= 16; run += 1) seed += settledAttempts(`earlier-${run}`, 30, run * 100)
    await writeFile(join(suite.root, JOURNAL_FILE), seed)
    const real = journalModule.openJournal
    const stop = spyOn(journalModule, "openJournal")
    stop.mockImplementation(async (...args: Parameters<typeof journalModule.openJournal>) => {
      const opened = await real(...args)
      if (!opened.ok) return opened
      const journal = opened.journal
      return {
        ok: true,
        journal: {
          ...journal,
          adversarialAdmission: (binding) => {
            const admission = journal.adversarialAdmission(binding)
            return {
              admit: async (request) => {
                const decision = await admission.admit(request)
                // The cancellation lands once the refusal has been decided.
                if (!decision.ok) controller.abort()
                return decision
              },
            }
          },
        },
      }
    })
    try {
      const outcome = await runAdversarialSuite({ ...suite.input, signal: controller.signal })
      if (!outcome.ok) throw new Error(outcome.reason)
      expect(controller.signal.aborted).toBe(true)
      expect(suite.calls).toHaveLength(0)
      expect(outcome.bill.halt).toBeNull()
      expect(await exists(join(suite.root, HALT_MARKER_FILE))).toBe(false)
    } finally {
      stop.mockRestore()
    }
  })

  test("an attempt left issued and unsettled when its run returns halts the suite, writes the marker, and strands every later slot", async () => {
    const real = journalModule.openJournal
    const spy = spyOn(journalModule, "openJournal")
    let dropped = 0
    spy.mockImplementation(async (...args: Parameters<typeof journalModule.openJournal>) => {
      const opened = await real(...args)
      if (!opened.ok) return opened
      const journal = opened.journal
      return {
        ok: true,
        journal: {
          ...journal,
          adversarialAdmission: (binding) => {
            const admission = journal.adversarialAdmission(binding)
            return {
              admit: async (request) => {
                const decision = await admission.admit(request)
                // The second run's first attempt is admitted and its settlement never reaches the journal.
                if (!decision.ok || !binding.label.startsWith("adv-01") || dropped > 0 || journal.bill().requests.length <= 2) return decision
                dropped += 1
                return { ...decision, settle: async () => undefined }
              },
            }
          },
        },
      }
    })
    try {
      const suite = await sealedSuite(scratch, { attempts: true })
      const outcome = await runAdversarialSuite(suite.input)
      if (!outcome.ok) throw new Error(outcome.reason)
      expect(dropped).toBe(1)
      expect(outcome.slots[0]!.status).toBe("completed")
      expect(outcome.bill.halt).toStartWith(ATTEMPT_MODE_STOP_PREFIX)
      expect(outcome.bill.halt).toContain("left 1 attempt(s) issued and unsettled; each is counted, and whether it ended is not established")
      expect(outcome.bill.inFlight).toHaveLength(1)
      expect(outcome.slots.slice(2).map((slot) => slot.status)).toEqual(Array.from({ length: 14 }, () => "not-attempted"))
      for (const slot of outcome.slots.slice(2)) expect(slot.reason).toContain("the experiment halted")
      expect(suite.calls.some((call) => call.position > 2)).toBe(false)
      expect(JSON.parse(await readFile(join(suite.root, HALT_MARKER_FILE), "utf8"))).toMatchObject({ halted: true, scope: "adversarial" })
      expect(outcome.complete).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  test("a cancellation before any attempt is issued stops the suite and halts nothing", async () => {
    const controller = new AbortController()
    controller.abort()
    const suite = await sealedSuite(scratch, { attempts: true })
    const outcome = await runAdversarialSuite({ ...suite.input, signal: controller.signal })
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(suite.calls).toHaveLength(0)
    expect(outcome.bill.halt).toBeNull()
    expect(outcome.slots.map((slot) => slot.status)).toEqual(Array.from({ length: 16 }, () => "not-attempted"))
    expect(await exists(join(suite.root, HALT_MARKER_FILE))).toBe(false)
  })

  test("work found unsettled on reopen refuses the suite as halted, and the schedule is not spent", async () => {
    const suite = await sealedSuite(scratch, { attempts: true })
    const dangling = { type: "issued", physicalId: "seed-open", category: "adversarial", block: null, phase: null, stage: "discover", slot: "discovery-1", attempt: 1, runId: "earlier", mode: "attempts", scope: "adversarial" }
    await writeFile(join(suite.root, JOURNAL_FILE), `${JSON.stringify(dangling)}\n`)
    const outcome = await runAdversarialSuite(suite.input)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toContain("the experiment is already halted, so the adversarial schedule was not started")
      expect(outcome.reason).toContain("issued by an earlier invocation and never settled")
    }
    expect(suite.calls).toHaveLength(0)
    expect(await exists(join(adversarialDirectory(suite.root), ADVERSARIAL_START_MARKER_FILE))).toBe(false)
    expect(await exists(join(suite.root, LOCK_FILE))).toBe(false)
  })

  test("a valid own root reopened after a start, a stop or a halt passes isolation, and nothing resumes", async () => {
    // After a completed start.
    const done = await sealedSuite(scratch, { attempts: true })
    expect((await runAdversarialSuite(done.input)).ok).toBe(true)
    expect(await isolatedRootProblem(done.root, { marker: "required" })).toBeNull()
    const calls = done.calls.length
    const again = await runAdversarialSuite(done.input)
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.reason).toContain("a started schedule is never executed again")
    expect(done.calls).toHaveLength(calls)

    // After a halt.
    const halted = await sealedSuite(scratch, {
      attempts: true,
      script: { fault: (context, _stage, index) => (context.position === 1 && index === 0 ? "throw" : undefined) },
    })
    const first = await runAdversarialSuite(halted.input)
    if (!first.ok) throw new Error(first.reason)
    expect(first.bill.halt).not.toBeNull()
    expect(await isolatedRootProblem(halted.root, { marker: "required" })).toBeNull()
    const issued = halted.calls.length
    const second = await runAdversarialSuite(halted.input)
    expect(second.ok).toBe(false)
    expect(halted.calls).toHaveLength(issued)
    // The halt marker is still there: clearing it is a human's act, and it starts nothing.
    expect(await exists(join(halted.root, HALT_MARKER_FILE))).toBe(true)

    // After a runner stop.
    const stopped = await sealedSuite(scratch, { attempts: true })
    let seed = ""
    for (let run = 1; run <= 16; run += 1) seed += settledAttempts(`earlier-${run}`, 30, run * 100)
    await writeFile(join(stopped.root, JOURNAL_FILE), seed)
    expect((await runAdversarialSuite(stopped.input)).ok).toBe(true)
    expect(await isolatedRootProblem(stopped.root, { marker: "required" })).toBeNull()
    expect((await runAdversarialSuite(stopped.input)).ok).toBe(false)
    expect(stopped.calls).toHaveLength(0)
  }, 60_000)

  test("the root must be the suite's own: a missing marker, or another experiment at, above or below it, refuses before anything is written", async () => {
    const mutations: [string, (root: string) => Promise<void>, string][] = [
      ["no root marker", (root) => unlink(join(root, ADVERSARIAL_ROOT_MARKER_FILE)), `it carries no \`${ADVERSARIAL_ROOT_MARKER_FILE}\``],
      ["a paired schedule at the root", (root) => writeFile(join(root, SCHEDULE_FILE), "{}\n"), "this is a paired experiment's root"],
      ["a journal above the root", (root) => writeFile(join(root, "..", JOURNAL_FILE), ""), "exists above it"],
      [
        "a ledger below the root",
        async (root) => {
          await mkdir(join(root, "adversarial", "inner"), { recursive: true })
          await writeFile(join(root, "adversarial", "inner", JOURNAL_FILE), "")
        },
        "exists below it",
      ],
    ]
    for (const [name, mutate, why] of mutations) {
      const suite = await sealedSuite(scratch, { attempts: true })
      await mutate(suite.root)
      const outcome = await runAdversarialSuite(suite.input)
      expect(outcome.ok, name).toBe(false)
      if (!outcome.ok) {
        expect(outcome.reason, name).toContain("cannot be the adversarial suite's own root (protocol v3 B5)")
        expect(outcome.reason, name).toContain(why)
      }
      expect(suite.calls, name).toHaveLength(0)
      expect(await exists(join(adversarialDirectory(suite.root), ADVERSARIAL_START_MARKER_FILE)), name).toBe(false)
      expect(await exists(join(suite.root, LOCK_FILE)), name).toBe(false)
    }
  })

  test("the suite's root does not open a paired journal, and the config and the protocol must agree with the schedule", async () => {
    // A v2 paired attempt journal sitting at a marked root is not the suite's.
    const suite = await sealedSuite(scratch, { attempts: true })
    const paired = { type: "issued", physicalId: "p-1", category: "blocks", block: 1, phase: "prefix", stage: "discover", slot: "discovery-1", attempt: 1, runId: "run-p", mode: "attempts" }
    await writeFile(join(suite.root, JOURNAL_FILE), `${JSON.stringify(paired)}\n${JSON.stringify({ type: "settled", physicalId: "p-1", settlement: { kind: "not-issued" } })}\n`)
    const crossed = await runAdversarialSuite(suite.input)
    expect(crossed.ok).toBe(false)
    if (!crossed.ok) expect(crossed.reason).toContain("records the paired scope, and it was opened in the adversarial scope")

    const other = await sealedSuite(scratch, { attempts: true })
    const oauthOnly = await runAdversarialSuite({ ...other.input, config: { ...ATTEMPT_CONFIG, accounting: undefined } })
    expect(oauthOnly.ok).toBe(false)
    if (!oauthOnly.ok) expect(oauthOnly.reason).toContain("runs only with accounting `attempts`")
    const unknown = await runAdversarialSuite({ ...other.input, config: { ...ATTEMPT_CONFIG, accounting: "requests" as never } })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.reason).toContain('accounting "requests" is not `attempts`')
    // A protocol that is not version 3, and a copy of v3 edited after its hash was recorded, are each refused.
    const v2 = await runAdversarialSuite({ ...other.input, protocolFile: PROTOCOL_V2_FILE })
    expect(v2.ok).toBe(false)
    if (!v2.ok) expect(v2.reason).toContain("needs a frozen version-3 protocol, and the protocol handed in is PROTOCOL-mad-evaluation-v2 version 2")
    const refrozen = await frozenV3Copy(scratch)
    await writeFile(refrozen.file, (await readFile(refrozen.file, "utf8")).replace("frozen_on: 2026-10-08", "frozen_on: 2026-10-09"))
    const drifted = await runAdversarialSuite({ ...other.input, protocolFile: refrozen.file })
    expect(drifted.ok).toBe(false)
    if (!drifted.ok) expect(drifted.reason).toContain("the frozen artefact was edited")
    // None of those refusals spent the schedule.
    const ran = await runAdversarialSuite(other.input)
    expect(ran.ok).toBe(true)
  })
})
