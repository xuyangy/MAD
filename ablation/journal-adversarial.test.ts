/**
 * Story 2-7b — the journal's two admission paths through the one shared
 * `admitWith`: the adversarial path directly, and the Blocks path re-covered so
 * the refactor cannot have moved it. Plus `publishExclusive`'s caller-worded
 * refusals.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { emptyTokenUsage } from "../core/domain/run-record.ts"
import type { AdmissionDecision } from "../core/ports/admission.ts"
import { ADVERSARIAL_ATTEMPT_ALLOWANCES, HALT_MARKER_FILE } from "./governor.ts"
import {
  acquireLock,
  ATTEMPT_MODE_STOP_PREFIX,
  JOURNAL_FILE,
  openJournal,
  replayPersistedJournal,
  type JournalIo,
  type JournalLine,
  type PairedJournal,
} from "./journal.ts"
import { publishExclusive } from "./schedule.ts"

const scratch: string[] = []
afterEach(async () => {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-journal-adv-"))
  scratch.push(dir)
  return dir
}

const now = () => "2026-09-18T00:00:00.000Z"
const discover = { stage: "discover" as const, slot: "discovery-1", attempt: 1 }

async function opened(root: string, io?: JournalIo): Promise<PairedJournal> {
  const lock = await acquireLock(root, now())
  if (!lock.ok) throw new Error(lock.reason)
  const journal = await openJournal(root, lock.lock, now, io)
  if (!journal.ok) throw new Error(journal.reason)
  return journal.journal
}

async function rows(root: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(root, JOURNAL_FILE), "utf8")
  return text.split("\n").filter((row) => row.length > 0).map((row) => JSON.parse(row) as Record<string, unknown>)
}

describe("adversarialAdmission", () => {
  test("an admitted request is journaled as Adversarial, with no block or phase, and settles into the category", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    const decision = await journal.adversarialAdmission({ label: "adv-01 clean", runId: () => "run-1" }).admit(discover)
    expect(decision.ok).toBe(true)
    if (decision.ok) await decision.settle({ kind: "usage", tokens: { ...emptyTokenUsage(), input: 7 } })
    expect((await rows(root))[0]).toMatchObject({ type: "issued", category: "adversarial", block: null, phase: null, runId: "run-1" })
    expect(journal.bill().byCategory.adversarial?.input).toBe(7)
    await journal.close()
  })

  test("a malformed request stops the runner, named as the adversarial runner", async () => {
    const journal = await opened(await tempDir())
    const decision = await journal.adversarialAdmission({ label: "adv-01 clean", runId: () => "run-1" }).admit({ stage: "bogus" as never, slot: "s", attempt: 1 })
    expect(decision).toMatchObject({ ok: false, cause: "runner-stop" })
    if (!decision.ok) expect(decision.reason).toContain("the adversarial runner stopped admitting")
    expect(journal.bill().stop).toContain("adversarial run adv-01 clean asked to admit a malformed request")
    expect(journal.bill().refusedAdversarial).toHaveLength(1)
    await journal.close()
  })

  test("a request before the run id exists is refused and journals nothing", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    const decision = await journal.adversarialAdmission({ label: "adv-02 attack", runId: () => undefined }).admit(discover)
    expect(decision.ok).toBe(false)
    expect(journal.bill().stop).toContain("before its run id existed")
    expect(journal.bill().requests).toHaveLength(0)
    await journal.close()
  })

  test("an admission after close() is refused, named as the adversarial runner, and is not a stop", async () => {
    const journal = await opened(await tempDir())
    const admission = journal.adversarialAdmission({ label: "adv-01 clean", runId: () => "run-1" })
    const { handle } = await journal.close()
    const decision = await admission.admit(discover)
    expect(decision).toMatchObject({ ok: false, cause: "runner-stop" })
    if (!decision.ok) expect(decision.reason).toContain("the adversarial runner stopped admitting: the invocation has completed")
    expect(handle.bill().stop).toBeNull()
  })

  test("a failed journal write refuses as a runner stop", async () => {
    const io: JournalIo = {
      async appendLine() {
        throw new Error("disk full")
      },
    }
    const journal = await opened(await tempDir(), io)
    const decision = await journal.adversarialAdmission({ label: "adv-01 clean", runId: () => "run-1" }).admit(discover)
    expect(decision).toMatchObject({ ok: false, cause: "runner-stop" })
    expect(journal.bill().stop).toContain("could not record an admission: disk full")
    await journal.close()
  })

  test("a halt marker written after the journal opened refuses the next request as halted", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    await writeFile(join(root, HALT_MARKER_FILE), "{}\n")
    const decision = await journal.adversarialAdmission({ label: "adv-01 clean", runId: () => "run-1" }).admit(discover)
    expect(decision).toMatchObject({ ok: false, cause: "halted" })
    await journal.close()
  })

  test("a halt-marker read failing with something other than ENOENT latches the halt", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    await mkdir(join(root, HALT_MARKER_FILE))
    const decision = await journal.adversarialAdmission({ label: "adv-01 clean", runId: () => "run-1" }).admit(discover)
    expect(decision).toMatchObject({ ok: false, cause: "halted" })
    expect(journal.bill().halt).toContain("could not be established")
    await journal.close()
  })
})

// ---------------------------------------------------------------------------
// Story 2-7e — the adversarial suite's own attempt-mode journal (protocol v3 B2, B3, B5, B6)
// ---------------------------------------------------------------------------

const USAGE = { kind: "usage" as const, tokens: { ...emptyTokenUsage(), input: 1 } }

async function suiteJournal(root: string, io?: JournalIo): Promise<PairedJournal> {
  const lock = await acquireLock(root, now())
  if (!lock.ok) throw new Error(lock.reason)
  const journal = await openJournal(root, lock.lock, now, io, "attempts", "adversarial")
  if (!journal.ok) throw new Error(journal.reason)
  return journal.journal
}

const runOf = (journal: PairedJournal, runId: string, label = `case ${runId}`) => journal.adversarialAdmission({ label, runId: () => runId })

/** Admit `count` attempts for one run and settle each with usage. */
async function spend(journal: PairedJournal, runId: string, count: number): Promise<void> {
  const admission = runOf(journal, runId)
  for (let index = 0; index < count; index += 1) {
    const decision = await admission.admit(discover)
    if (!decision.ok) throw new Error(`attempt ${index + 1} of ${runId} was refused: ${decision.reason}`)
    await decision.settle(USAGE)
  }
}

/** Lines an earlier invocation of the suite would have left: `count` settled attempts of one run. */
function seededLines(runId: string, count: number, from = 0): string {
  let text = ""
  for (let index = 0; index < count; index += 1) {
    const physicalId = `seed-${from + index}`
    text += `${JSON.stringify({ type: "issued", physicalId, category: "adversarial", block: null, phase: null, stage: "discover", slot: "discovery-1", attempt: 1, runId, mode: "attempts", scope: "adversarial" })}\n`
    text += `${JSON.stringify({ type: "settled", physicalId, settlement: USAGE })}\n`
  }
  return text
}

describe("the adversarial suite's attempt journal: admission and allowances", () => {
  test("the allowances are protocol v3 B3's: 30 per run, 480 for the suite and for the root, over 16 runs", () => {
    expect(ADVERSARIAL_ATTEMPT_ALLOWANCES).toEqual({ run: 30, suite: 480, global: 480, runs: 16 })
    expect(ADVERSARIAL_ATTEMPT_ALLOWANCES.runs * ADVERSARIAL_ATTEMPT_ALLOWANCES.run).toBe(ADVERSARIAL_ATTEMPT_ALLOWANCES.suite)
  })

  test("an admitted attempt is durable before it is answered, and its line declares the mode and the scope", async () => {
    const root = await tempDir()
    const journal = await suiteJournal(root)
    const decision = await runOf(journal, "run-1").admit(discover)
    expect(decision.ok).toBe(true)
    // Read before any settlement: the `issued` line is already on disk.
    expect(await rows(root)).toEqual([
      { type: "issued", physicalId: "request-1", category: "adversarial", block: null, phase: null, stage: "discover", slot: "discovery-1", attempt: 1, runId: "run-1", mode: "attempts", scope: "adversarial" },
    ])
    if (decision.ok) await decision.settle(USAGE)
    const bill = journal.bill()
    expect(bill.mode).toBe("attempts")
    expect(bill.scope).toBe("adversarial")
    await journal.close()
  })

  test("overshoot reads per run against 30, and the suite and the root against 480", async () => {
    const journal = await suiteJournal(await tempDir())
    await spend(journal, "run-1", 3)
    await spend(journal, "run-2", 2)
    expect(journal.bill().overshoot).toEqual({
      global: { limit: 480, spent: 5, overshoot: 0 },
      blocks: { limit: 0, spent: 0, overshoot: 0 },
      adversarial: { limit: 480, spent: 5, overshoot: 0 },
      phases: [],
      unit: "attempts",
      runTotals: [
        { runId: "run-1", limit: 30, spent: 3, overshoot: 0 },
        { runId: "run-2", limit: 30, spent: 2, overshoot: 0 },
      ],
    })
    await journal.close()
  })

  test("the run cap counts pending work: 29 settled and 1 in flight refuse the next for budget, and another run proceeds", async () => {
    const root = await tempDir()
    const journal = await suiteJournal(root)
    await spend(journal, "run-1", 29)
    const pending = await runOf(journal, "run-1").admit(discover)
    expect(pending.ok).toBe(true)
    const before = (await rows(root)).length
    const refused = await runOf(journal, "run-1", "adv-01 clean").admit({ ...discover, attempt: 2 })
    expect(refused).toEqual({
      ok: false,
      cause: "budget",
      reason: "the adv-01 clean run's allowance is exhausted: 30 of 30 admitted attempts",
    })
    // No line, no stop, no halt: the run fails and the suite goes on.
    expect((await rows(root)).length).toBe(before)
    expect(journal.bill().stop).toBeNull()
    expect(journal.bill().halt).toBeNull()
    expect(journal.bill().refusedAdversarial).toEqual([
      { label: "adv-01 clean", runId: "run-1", stage: "discover", slot: "discovery-1", attempt: 2, cause: "budget", reason: refused.ok ? "" : refused.reason },
    ])
    const other = await runOf(journal, "run-2").admit(discover)
    expect(other.ok).toBe(true)
    if (other.ok) await other.settle(USAGE)
    if (pending.ok) await pending.settle(USAGE)
    expect(journal.bill().overshoot.runTotals).toEqual([
      { runId: "run-1", limit: 30, spent: 30, overshoot: 0 },
      { runId: "run-2", limit: 30, spent: 1, overshoot: 0 },
    ])
    await journal.close()
  })

  test("the global cap counts pending work: 479 settled and 1 in flight refuse the next as a runner stop, and nothing follows", async () => {
    const root = await tempDir()
    await mkdir(root, { recursive: true })
    // Fifteen full runs and 29 of the sixteenth, as an earlier part of the suite left them.
    let seed = ""
    for (let run = 1; run <= 15; run += 1) seed += seededLines(`run-${run}`, 30, run * 100)
    seed += seededLines("run-16", 29, 1600)
    await writeFile(join(root, JOURNAL_FILE), seed)
    const journal = await suiteJournal(root)
    expect(journal.bill().overshoot.global).toEqual({ limit: 480, spent: 479, overshoot: 0 })
    const pending = await runOf(journal, "run-16").admit(discover)
    expect(pending.ok).toBe(true)
    const before = (await rows(root)).length
    const refused = await runOf(journal, "run-17", "adv-08 attack").admit(discover)
    expect(refused).toEqual({
      ok: false,
      cause: "runner-stop",
      reason: "the adversarial runner stopped admitting: the suite root's global allowance is exhausted: 480 of 480 admitted attempts. No model failed.",
    })
    expect(journal.bill().stop).toBe("the suite root's global allowance is exhausted: 480 of 480 admitted attempts")
    expect((await rows(root)).length).toBe(before)
    // The stop is latched: a run with allowance of its own is refused too.
    const later = await runOf(journal, "run-18").admit(discover)
    expect(later).toMatchObject({ ok: false, cause: "runner-stop" })
    expect((await rows(root)).length).toBe(before)
    expect(journal.bill().refusedAdversarial.map((refusal) => refusal.cause)).toEqual(["runner-stop", "runner-stop"])
    if (pending.ok) await pending.settle(USAGE)
    expect(journal.bill().overshoot.global).toEqual({ limit: 480, spent: 480, overshoot: 0 })
    await journal.close()
  })

  test("no admission exceeds a cap when forty are asked at once: exactly thirty are admitted, each durable", async () => {
    const root = await tempDir()
    const journal = await suiteJournal(root)
    const admission = runOf(journal, "run-1")
    const decisions = await Promise.all(Array.from({ length: 40 }, (_unused, index) => admission.admit({ ...discover, attempt: index + 1 })))
    const admitted = decisions.filter((decision): decision is AdmissionDecision & { ok: true } => decision.ok)
    expect(admitted).toHaveLength(30)
    expect(decisions.filter((decision) => !decision.ok).every((decision) => !decision.ok && decision.cause === "budget")).toBe(true)
    // All thirty are outstanding, none settled, and the cap already holds.
    expect((await rows(root)).filter((row) => row.type === "issued")).toHaveLength(30)
    expect(journal.bill().inFlight).toHaveLength(30)
    expect(journal.bill().overshoot.runTotals).toEqual([{ runId: "run-1", limit: 30, spent: 30, overshoot: 0 }])
    for (const decision of admitted) await decision.settle(USAGE)
    expect(journal.bill().overshoot.global.overshoot).toBe(0)
    await journal.close()
  })

  test("a not-issued settlement releases its reservation exactly once", async () => {
    const journal = await suiteJournal(await tempDir())
    await spend(journal, "run-1", 29)
    const last = await runOf(journal, "run-1").admit(discover)
    expect(last.ok).toBe(true)
    expect((await runOf(journal, "run-1").admit(discover)).ok).toBe(false)
    if (last.ok) {
      await last.settle({ kind: "not-issued" })
      // Settled again: the same outcome, and no second release.
      await last.settle({ kind: "not-issued" })
    }
    expect(journal.bill().overshoot.runTotals).toEqual([{ runId: "run-1", limit: 30, spent: 29, overshoot: 0 }])
    expect(journal.bill().integrity).toEqual([])
    const again = await runOf(journal, "run-1").admit(discover)
    expect(again.ok).toBe(true)
    // One released unit admits one attempt, not two.
    expect((await runOf(journal, "run-1").admit(discover)).ok).toBe(false)
    if (again.ok) await again.settle(USAGE)
    expect(journal.bill().requests.filter((request) => request.state === "not-issued")).toHaveLength(1)
    await journal.close()
  })

  test("an attempt settled with no host usage counts once and halts nothing", async () => {
    const journal = await suiteJournal(await tempDir())
    const decision = await runOf(journal, "run-1").admit(discover)
    if (decision.ok) await decision.settle({ kind: "unknown", why: "the host reported no usage" })
    const bill = journal.bill()
    expect(bill.halt).toBeNull()
    expect(bill.stop).toBeNull()
    expect(bill.unknown).toHaveLength(1)
    expect(bill.overshoot.adversarial.spent).toBe(1)
    expect((await runOf(journal, "run-1").admit(discover)).ok).toBe(true)
    await journal.close()
  })
})

describe("the adversarial suite's attempt journal: run identity", () => {
  test("a missing, empty or unreadable run id stops the runner before the gate and appends nothing", async () => {
    for (const [runId, why] of [
      [() => undefined, "its run id did not exist"],
      [() => "", "its run id did not exist"],
      [
        () => {
          throw new Error("no clock")
        },
        "its run id could not be read (no clock)",
      ],
    ] as const) {
      const root = await tempDir()
      const journal = await suiteJournal(root)
      const decision = await journal.adversarialAdmission({ label: "adv-02 attack", runId }).admit(discover)
      expect(decision).toMatchObject({ ok: false, cause: "runner-stop" })
      expect(journal.bill().stop).toBe(`adversarial run adv-02 attack asked to admit a request, and ${why}`)
      expect(journal.bill().requests).toHaveLength(0)
      expect(await readFile(join(root, JOURNAL_FILE), "utf8").catch(() => "absent")).toBe("absent")
      // Nothing further is admitted, even with a good id.
      expect((await runOf(journal, "run-1").admit(discover)).ok).toBe(false)
      await journal.close()
    }
  })

  test("a run id that reads differently after the gate stops the runner and appends nothing", async () => {
    const root = await tempDir()
    const journal = await suiteJournal(root)
    const ids = ["run-1", "run-2"]
    const decision = await journal.adversarialAdmission({ label: "adv-03 clean", runId: () => ids.shift() }).admit(discover)
    expect(decision).toMatchObject({ ok: false, cause: "runner-stop" })
    expect(journal.bill().stop).toBe(
      "adversarial run adv-03 clean asked to admit a request whose run id changed between the gate and the journal line (`run-1`, then `run-2`)",
    )
    expect(journal.bill().requests).toHaveLength(0)
    expect(await readFile(join(root, JOURNAL_FILE), "utf8").catch(() => "absent")).toBe("absent")
    await journal.close()
  })

  test("the identity the gate counted is the one on the line", async () => {
    const root = await tempDir()
    const journal = await suiteJournal(root)
    await spend(journal, "run-1", 30)
    // run-1 is full, run-2 is not: each request is gated and journaled under its own id.
    expect((await runOf(journal, "run-1").admit(discover)).ok).toBe(false)
    const decision = await runOf(journal, "run-2").admit(discover)
    expect(decision.ok).toBe(true)
    expect((await rows(root)).filter((row) => row.type === "issued").at(-1)).toMatchObject({ runId: "run-2" })
    await journal.close()
  })
})

describe("the adversarial suite's attempt journal: stops and halts (B6)", () => {
  test("a failed admission append is a runner stop, and no later admission follows", async () => {
    let appended = 0
    const io: JournalIo = {
      async appendLine() {
        appended += 1
        throw new Error("disk full")
      },
    }
    const journal = await suiteJournal(await tempDir(), io)
    const decision = await runOf(journal, "run-1").admit(discover)
    expect(decision).toMatchObject({ ok: false, cause: "runner-stop" })
    expect(journal.bill().stop).toContain("could not record an admission: disk full")
    expect(journal.bill().halt).toBeNull()
    expect(await runOf(journal, "run-2").admit(discover)).toMatchObject({ ok: false, cause: "runner-stop" })
    expect(appended).toBe(1)
    await journal.close()
  })

  test("a failed settlement append is a runner stop, and no later admission follows", async () => {
    const root = await tempDir()
    const lines: JournalLine[] = []
    const io: JournalIo = {
      async appendLine(_file, line) {
        if (line.type === "settled") throw new Error("disk full")
        lines.push(line)
      },
    }
    const journal = await suiteJournal(root, io)
    const decision = await runOf(journal, "run-1").admit(discover)
    expect(decision.ok).toBe(true)
    if (decision.ok) await decision.settle(USAGE)
    expect(journal.bill().stop).toContain("could not be appended: disk full")
    expect(journal.bill().halt).toBeNull()
    expect(await runOf(journal, "run-1").admit(discover)).toMatchObject({ ok: false, cause: "runner-stop" })
    expect(lines).toHaveLength(1)
    await journal.close()
  })

  test("a settlement is counted the moment it is given: a slow append leaves nothing in flight for a runner to mistake for open work", async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const written: string[] = []
    const io: JournalIo = {
      async appendLine(_file, line) {
        if (line.type === "settled") await held
        written.push(line.type)
      },
    }
    const journal = await suiteJournal(await tempDir(), io)
    const decision = await runOf(journal, "run-1").admit(discover)
    if (!decision.ok) throw new Error(decision.reason)
    const settling = decision.settle(USAGE)
    // The append has not finished, and the bill already shows the attempt settled.
    expect(written).toEqual(["issued"])
    expect(journal.bill().inFlight).toEqual([])
    expect(journal.bill().requests.map((request) => request.state)).toEqual(["usage"])
    expect(journal.bill().halt).toBeNull()
    release()
    await settling
    await journal.settled()
    expect(written).toEqual(["issued", "settled"])
    await journal.close()
  })

  test("an attempt that did not end within its bound halts, writes the marker, and admits nothing more", async () => {
    const root = await tempDir()
    const journal = await suiteJournal(root)
    const decision = await runOf(journal, "run-1").admit(discover)
    if (decision.ok) await decision.settle({ kind: "unknown", why: "the backend threw after the request was issued", abandoned: true })
    await journal.settled()
    const bill = journal.bill()
    expect(bill.halt).toStartWith(ATTEMPT_MODE_STOP_PREFIX)
    expect(bill.halt).toContain("did not end within its bound")
    expect(await runOf(journal, "run-2").admit(discover)).toMatchObject({ ok: false, cause: "halted" })
    const marker = JSON.parse(await readFile(join(root, HALT_MARKER_FILE), "utf8")) as Record<string, unknown>
    expect(marker).toMatchObject({ halted: true, accounting: "attempts", scope: "adversarial" })
    // The attempt is counted, once, and nothing was issued after it.
    expect(bill.overshoot.adversarial.spent).toBe(1)
    await journal.close()
  })

  test("an integrity failure halts", async () => {
    const journal = await suiteJournal(await tempDir())
    const decision = await runOf(journal, "run-1").admit(discover)
    if (decision.ok) {
      await decision.settle(USAGE)
      await decision.settle({ kind: "usage", tokens: { ...emptyTokenUsage(), input: 2 } })
    }
    expect(journal.bill().integrity).toHaveLength(1)
    expect(journal.bill().halt).toStartWith(ATTEMPT_MODE_STOP_PREFIX)
    expect(await runOf(journal, "run-1").admit(discover)).toMatchObject({ ok: false, cause: "halted" })
    await journal.close()
  })

  test("work found unsettled on reopen halts: it is counted, and nothing is admitted", async () => {
    const root = await tempDir()
    const first = await suiteJournal(root)
    const decision = await runOf(first, "run-1").admit(discover)
    expect(decision.ok).toBe(true)
    await first.close()
    const reopened = await suiteJournal(root)
    const bill = reopened.bill()
    expect(bill.uncertain).toHaveLength(1)
    expect(bill.halt).toStartWith(ATTEMPT_MODE_STOP_PREFIX)
    expect(bill.halt).toContain("issued by an earlier invocation and never settled")
    expect(bill.overshoot.adversarial.spent).toBe(1)
    expect(await runOf(reopened, "run-1").admit(discover)).toMatchObject({ ok: false, cause: "halted" })
    await reopened.close()
  })

  test("haltAttempts latches an attempt-mode halt from outside a settlement, with its marker, and releases the lock on close", async () => {
    const root = await tempDir()
    const journal = await suiteJournal(root)
    journal.haltAttempts("the run was cancelled while an attempt of adv-01 clean was in flight")
    expect(journal.bill().halt).toBe(`${ATTEMPT_MODE_STOP_PREFIX}the run was cancelled while an attempt of adv-01 clean was in flight`)
    expect(await runOf(journal, "run-1").admit(discover)).toMatchObject({ ok: false, cause: "halted" })
    const closed = await journal.close()
    expect(closed.lockRetained).toBe(false)
    expect(JSON.parse(await readFile(join(root, HALT_MARKER_FILE), "utf8"))).toMatchObject({ halted: true, scope: "adversarial" })
  })
})

describe("the journal scope is durable and validated (B5)", () => {
  test("Blocks work is refused by the suite's journal before anything is appended, as a runner stop", async () => {
    const root = await tempDir()
    const journal = await suiteJournal(root)
    const decision = await journal.admission({ block: 1, phase: "prefix", runId: () => "run-1" }).admit(discover)
    expect(decision).toMatchObject({ ok: false, cause: "runner-stop" })
    expect(journal.bill().stop).toBe(
      "a Blocks admission (block 1's prefix) was asked of the adversarial suite's journal, which admits only Adversarial attempts",
    )
    expect(journal.bill().refused).toHaveLength(1)
    expect(await readFile(join(root, JOURNAL_FILE), "utf8").catch(() => "absent")).toBe("absent")
    await journal.close()
  })

  test("the adversarial scope exists only in attempt mode, and an unknown scope is refused", async () => {
    for (const [mode, scope, why] of [
      ["tokens", "adversarial", "counts attempts, and it was opened in tokens mode"],
      ["attempts", "calibration", "is neither paired nor adversarial"],
    ] as const) {
      const root = await tempDir()
      const lock = await acquireLock(root, now())
      if (!lock.ok) throw new Error(lock.reason)
      const refused = await openJournal(root, lock.lock, now, undefined, mode, scope as never)
      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.reason).toContain(why)
      await lock.lock.release()
    }
  })

  async function openAs(root: string, scope: "paired" | "adversarial") {
    const lock = await acquireLock(root, now())
    if (!lock.ok) throw new Error(lock.reason)
    const outcome = await openJournal(root, lock.lock, now, undefined, "attempts", scope)
    if (outcome.ok) await outcome.journal.close()
    else await lock.lock.release()
    return outcome
  }

  test("a suite journal does not open as a paired one, and a paired attempt journal does not open as the suite's", async () => {
    const suiteRoot = await tempDir()
    const suite = await suiteJournal(suiteRoot)
    await spend(suite, "run-1", 1)
    await suite.close()
    const asPaired = await openAs(suiteRoot, "paired")
    expect(asPaired.ok).toBe(false)
    if (!asPaired.ok) expect(asPaired.reason).toContain("records the adversarial scope, and it was opened in the paired scope")

    const pairedRoot = await tempDir()
    const paired = { type: "issued", physicalId: "p-1", category: "blocks", block: 1, phase: "prefix", stage: "discover", slot: "discovery-1", attempt: 1, runId: "run-p", mode: "attempts" }
    await writeFile(join(pairedRoot, JOURNAL_FILE), `${JSON.stringify(paired)}\n${JSON.stringify({ type: "settled", physicalId: "p-1", settlement: USAGE })}\n`)
    const asSuite = await openAs(pairedRoot, "adversarial")
    expect(asSuite.ok).toBe(false)
    if (!asSuite.ok) expect(asSuite.reason).toContain("records the paired scope, and it was opened in the adversarial scope")
  })

  test("a file mixing scopes, a scoped token line, and a scoped line outside the Adversarial category are each refused", async () => {
    const scoped = (physicalId: string, extra: Record<string, unknown> = {}) => ({
      type: "issued", physicalId, category: "adversarial", block: null, phase: null, stage: "discover", slot: "discovery-1", attempt: 1, runId: "run-1", mode: "attempts", scope: "adversarial", ...extra,
    })
    const unscoped = { ...scoped("b"), scope: undefined }
    const cases: [string, unknown[], string][] = [
      ["mixed", [scoped("a"), unscoped], "mixes scopes"],
      ["foreign category", [scoped("a", { category: "pilot" })], "is a pilot request, which the adversarial suite's journal never holds"],
      ["blocks", [scoped("a", { category: "blocks", block: 1, phase: "on" })], "is a blocks request, which the adversarial suite's journal never holds"],
      ["an unknown scope", [scoped("a", { scope: "calibration" })], "is not a valid journal line"],
    ]
    for (const [name, lines, why] of cases) {
      const root = await tempDir()
      const file = join(root, JOURNAL_FILE)
      await writeFile(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(""))
      const replayed = await replayPersistedJournal(file)
      expect(replayed.ok, name).toBe(false)
      if (!replayed.ok) expect(replayed.reason, name).toContain(why)
    }
    // A scoped line with no attempt mode is a scoped file read in token mode.
    const root = await tempDir()
    const file = join(root, JOURNAL_FILE)
    await writeFile(file, `${JSON.stringify({ ...scoped("a"), mode: undefined })}\n`)
    const replayed = await replayPersistedJournal(file)
    expect(replayed.ok).toBe(false)
    if (!replayed.ok) expect(replayed.reason).toContain("is scoped to the adversarial suite, which counts attempts, and it is read in tokens mode")
  })

  test("a paired attempt journal whose lines carry no scope replays as paired, with the paired allowances", async () => {
    const root = await tempDir()
    const file = join(root, JOURNAL_FILE)
    const legacy = { type: "issued", physicalId: "p-1", category: "blocks", block: 1, phase: "prefix", stage: "discover", slot: "discovery-1", attempt: 1, runId: "run-p", mode: "attempts" }
    await writeFile(file, `${JSON.stringify(legacy)}\n${JSON.stringify({ type: "settled", physicalId: "p-1", settlement: USAGE })}\n`)
    for (const scope of [undefined, "paired"] as const) {
      const replayed = await replayPersistedJournal(file, "attempts", scope)
      if (!replayed.ok) throw new Error(replayed.reason)
      expect(replayed.scope).toBe("paired")
      expect(replayed.bill.scope).toBeUndefined()
      expect(replayed.bill.overshoot.global).toEqual({ limit: 300, spent: 1, overshoot: 0 })
      expect(replayed.bill.overshoot.blockTotals).toEqual([{ block: 1, limit: 100, spent: 1, overshoot: 0 }])
      expect(replayed.bill.overshoot.runTotals).toBeUndefined()
    }
    expect((await openAs(root, "paired")).ok).toBe(true)
  })

  test("the suite's persisted journal replays in its own scope, and an empty one takes the scope it is asked for", async () => {
    const root = await tempDir()
    await mkdir(root, { recursive: true })
    await writeFile(join(root, JOURNAL_FILE), seededLines("run-1", 2))
    const replayed = await replayPersistedJournal(join(root, JOURNAL_FILE))
    if (!replayed.ok) throw new Error(replayed.reason)
    expect([replayed.mode, replayed.scope]).toEqual(["attempts", "adversarial"])
    expect(replayed.bill.overshoot.runTotals).toEqual([{ runId: "run-1", limit: 30, spent: 2, overshoot: 0 }])
    const empty = await replayPersistedJournal(join(await tempDir(), JOURNAL_FILE), "attempts", "adversarial")
    if (!empty.ok) throw new Error(empty.reason)
    expect(empty.bill.overshoot.global).toEqual({ limit: 480, spent: 0, overshoot: 0 })
  })

  test("a missing file replayed in the adversarial scope is refused unless the mode is attempts, as an open is", async () => {
    for (const mode of ["tokens", undefined] as const) {
      const file = join(await tempDir(), JOURNAL_FILE)
      const replayed = await replayPersistedJournal(file, mode, "adversarial")
      expect(replayed.ok, String(mode)).toBe(false)
      if (!replayed.ok) expect(replayed.reason).toContain("is scoped to the adversarial suite, which counts attempts, and it is read in tokens mode")
    }
    // The same file in the paired scope, in either mode, is an empty journal.
    for (const mode of ["tokens", "attempts", undefined] as const) {
      expect((await replayPersistedJournal(join(await tempDir(), JOURNAL_FILE), mode, "paired")).ok).toBe(true)
    }
  })
})

describe("Blocks admission through the shared admitWith", () => {
  test("an admitted request is journaled as Blocks with its block and phase", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    const decision = await journal.admission({ block: 2, phase: "on", runId: () => "run-2" }).admit(discover)
    expect(decision.ok).toBe(true)
    if (decision.ok) await decision.settle({ kind: "usage", tokens: { ...emptyTokenUsage(), input: 3 } })
    expect((await rows(root))[0]).toMatchObject({ category: "blocks", block: 2, phase: "on", runId: "run-2" })
    await journal.close()
  })

  test("a malformed request keeps its Blocks wording: the block and phase in the stop, the paired runner in the refusal", async () => {
    const journal = await opened(await tempDir())
    const decision = await journal.admission({ block: 1, phase: "prefix", runId: () => "run-1" }).admit({ stage: "bogus" as never, slot: "s", attempt: 1 })
    if (!decision.ok) expect(decision.reason).toContain("the paired runner stopped admitting")
    expect(journal.bill().stop).toContain("block 1's prefix asked to admit a malformed request")
    expect(journal.bill().refused).toHaveLength(1)
    expect(journal.bill().refusedAdversarial).toHaveLength(0)
    await journal.close()
  })

  test("Blocks admission does not re-read a halt marker written after open", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    await writeFile(join(root, HALT_MARKER_FILE), "{}\n")
    const decision = await journal.admission({ block: 1, phase: "prefix", runId: () => "run-1" }).admit(discover)
    expect(decision.ok).toBe(true)
    if (decision.ok) await decision.settle({ kind: "not-issued" })
    await journal.close()
  })
})

describe("publishExclusive", () => {
  test("an existing document refuses in the caller's words, and the existing file is kept", async () => {
    const root = await tempDir()
    const first = await publishExclusive(root, "doc.json", "one\n", "an adversarial schedule")
    expect(first.ok).toBe(true)
    const second = await publishExclusive(root, "doc.json", "two\n", "an adversarial schedule")
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toContain("an adversarial schedule already exists at")
    expect(await readFile(join(root, "doc.json"), "utf8")).toBe("one\n")
  })

  test("a temporary file that cannot be written refuses in the caller's words", async () => {
    const root = join(await tempDir(), "missing")
    const outcome = await publishExclusive(root, "doc.json", "x", "a schedule")
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain("a schedule's temporary file")
  })
})
