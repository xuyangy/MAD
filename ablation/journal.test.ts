import { afterEach, describe, expect, test } from "bun:test"
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { emptyTokenUsage, type TokenUsage } from "../core/domain/run-record.ts"
import { createLateUsageSink } from "../core/ports/late-usage.ts"
import { acquireLock, ATTEMPT_MODE_STOP_PREFIX, JOURNAL_FILE, LOCK_FILE, openJournal, type JournalIo, type JournalLine, type PairedJournal } from "./journal.ts"
import { existsSync } from "node:fs"
import { createExperimentGovernor, HALT_MARKER_FILE } from "./governor.ts"

const scratch: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-journal-"))
  scratch.push(dir)
  return dir
}

afterEach(async () => {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})

const now = () => "2026-09-14T00:00:00.000Z"

function usage(input: number, output = 0): TokenUsage {
  return { ...emptyTokenUsage(), input, output }
}

async function opened(root: string): Promise<PairedJournal> {
  const lock = await acquireLock(root, now())
  if (!lock.ok) throw new Error(lock.reason)
  const journal = await openJournal(root, lock.lock, now)
  if (!journal.ok) throw new Error(journal.reason)
  return journal.journal
}

async function lines(root: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(root, JOURNAL_FILE), "utf8")
  return text.split("\n").filter((row) => row.length > 0).map((row) => JSON.parse(row) as Record<string, unknown>)
}

const discover = (slot = "discovery-1", attempt = 1) => ({ stage: "discover" as const, slot, attempt })

describe("the lock — one writer per bundle root", () => {
  test("a present lock refuses, and releasing it lets the next writer in", async () => {
    const root = await tempDir()
    const first = await acquireLock(root, now())
    expect(first.ok).toBe(true)
    const second = await acquireLock(root, now())
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toContain("another writer holds")
    if (first.ok) expect(await first.lock.release()).toBeNull()
    expect((await acquireLock(root, now())).ok).toBe(true)
  })

  test("an I/O error fails closed", async () => {
    const root = await tempDir()
    const file = join(root, "not-a-directory")
    await writeFile(file, "x")
    const outcome = await acquireLock(file, now())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain("could not be created")
  })
})

describe("admission and settlement", () => {
  test("`issued` is durable before `ok`, and settlement is recorded once", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    const admission = journal.admission({ block: 1, phase: "prefix", runId: () => "run-1" })
    const decision = await admission.admit(discover())
    expect(decision.ok).toBe(true)
    expect(await lines(root)).toEqual([
      {
        type: "issued",
        physicalId: "request-1",
        category: "blocks",
        block: 1,
        phase: "prefix",
        stage: "discover",
        slot: "discovery-1",
        attempt: 1,
        runId: "run-1",
      },
    ])
    if (!decision.ok) return
    await decision.settle({ kind: "usage", tokens: usage(100, 20) })
    await decision.settle({ kind: "usage", tokens: usage(100, 20) })
    expect((await lines(root)).filter((line) => line.type === "settled")).toHaveLength(1)
    const bill = journal.bill()
    expect(bill.known).toEqual(usage(100, 20))
    expect(bill.halt).toBeNull()
    await journal.close()
  })

  test("a conflicting repeat settlement is an integrity failure that halts", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    const admission = journal.admission({ block: 1, phase: "on", runId: () => "run-2" })
    const decision = await admission.admit(discover())
    if (!decision.ok) throw new Error("refused")
    await decision.settle({ kind: "usage", tokens: usage(10) })
    await decision.settle({ kind: "usage", tokens: usage(11) })
    const bill = journal.bill()
    expect(bill.integrity).toHaveLength(1)
    expect(bill.halt).toContain("integrity failure")
    const later = await admission.admit(discover("discovery-2"))
    expect(later).toMatchObject({ ok: false, cause: "halted" })
    await journal.close()
  })

  test("in-flight work latches nothing; later admissions stay eligible", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    const admission = journal.admission({ block: 1, phase: "prefix", runId: () => "run-1" })
    const first = await admission.admit(discover("discovery-1"))
    const second = await admission.admit(discover("discovery-2"))
    expect(first.ok && second.ok).toBe(true)
    const bill = journal.bill()
    expect(bill.inFlight).toHaveLength(2)
    expect(bill.halt).toBeNull()
    await journal.close()
  })

  test("an unknown settlement latches the halt, and no later request is admitted", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    const admission = journal.admission({ block: 2, phase: "off", runId: () => "run-3" })
    const decision = await admission.admit(discover())
    if (!decision.ok) throw new Error("refused")
    await decision.settle({ kind: "unknown", why: "host reported nothing" })
    const later = await journal.admission({ block: 3, phase: "prefix", runId: () => "run-4" }).admit(discover())
    expect(later).toMatchObject({ ok: false, cause: "halted" })
    expect(journal.bill().unknown).toHaveLength(1)
    await journal.close()
  })

  test("not-issued bills nothing and halts nothing", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    const decision = await journal.admission({ block: 1, phase: "prefix", runId: () => "r" }).admit(discover())
    if (!decision.ok) throw new Error("refused")
    await decision.settle({ kind: "not-issued" })
    const bill = journal.bill()
    expect(bill.halt).toBeNull()
    expect(bill.known).toEqual(emptyTokenUsage())
    expect(bill.byPhase[0]!.requests).toBe(0)
    await journal.close()
  })

  test("a write failure in admit is a runner stop, never a model failure", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    await mkdir(join(root, JOURNAL_FILE))
    const decision = await journal.admission({ block: 1, phase: "prefix", runId: () => "r" }).admit(discover())
    expect(decision).toMatchObject({ ok: false, cause: "runner-stop" })
    expect(journal.bill().stop).toContain("could not record an admission")
    await journal.close()
  })

  test("a write failure in settle stops every later admission", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    const admission = journal.admission({ block: 1, phase: "prefix", runId: () => "r" })
    const decision = await admission.admit(discover())
    if (!decision.ok) throw new Error("refused")
    await unlink(join(root, JOURNAL_FILE))
    await mkdir(join(root, JOURNAL_FILE))
    await decision.settle({ kind: "usage", tokens: usage(5) })
    expect(await admission.admit(discover("discovery-2"))).toMatchObject({ ok: false, cause: "runner-stop" })
    await journal.close()
  })

  test("spend persisted by another category counts toward the global cap", async () => {
    const root = await tempDir()
    await writeFile(
      join(root, JOURNAL_FILE),
      [
        { type: "issued", physicalId: "request-1", category: "calibration", block: null, phase: null, stage: "discover", slot: "s", attempt: 1, runId: "cal" },
        { type: "settled", physicalId: "request-1", settlement: { kind: "usage", tokens: usage(2_000_000) } },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    )
    const journal = await opened(root)
    const decision = await journal.admission({ block: 1, phase: "prefix", runId: () => "r" }).admit(discover())
    expect(decision).toMatchObject({ ok: false, cause: "budget" })
    if (!decision.ok) expect(decision.reason).toContain("global cap")
    await journal.close()
  })

  test("a journal reopened with an issued, unsettled request reads it uncertain and refuses", async () => {
    const root = await tempDir()
    const first = await opened(root)
    const decision = await first.admission({ block: 1, phase: "prefix", runId: () => "r" }).admit(discover())
    expect(decision.ok).toBe(true)
    await first.close()

    const second = await opened(root)
    const bill = second.bill()
    expect(bill.uncertain.map((request) => request.physicalId)).toEqual(["request-1"])
    expect(bill.halt).toContain("uncertain")
    expect(await second.admission({ block: 1, phase: "prefix", runId: () => "r" }).admit(discover("discovery-2"))).toMatchObject({
      ok: false,
      cause: "halted",
    })
    await second.close()
  })

  test("an unreadable journal line refuses to open", async () => {
    const root = await tempDir()
    await writeFile(join(root, JOURNAL_FILE), "not json\n")
    const lock = await acquireLock(root, now())
    if (!lock.ok) throw new Error(lock.reason)
    const outcome = await openJournal(root, lock.lock, now)
    expect(outcome.ok).toBe(false)
    await lock.lock.release()
  })
})

describe("late usage during an invocation", () => {
  /** An admitted request whose settlement, given by the caller, binds the execution id. */
  async function admitted(journal: PairedJournal, slot = "discovery-1") {
    const decision = await journal.admission({ block: 1, phase: "on", runId: () => "run-on" }).admit(discover(slot))
    if (!decision.ok) throw new Error(decision.reason)
    return decision
  }

  test("the tee gives the run's sink its own copy; draining it does not consume the journal's", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    const sink = createLateUsageSink()
    const reporter = journal.reporter(sink)
    const decision = await admitted(journal)
    await decision.settle({ kind: "unknown", why: "timed out", executionId: "exec-1" })
    reporter.report({ executionId: "exec-1", tokens: usage(40) })
    expect(sink.drain()).toEqual([{ executionId: "exec-1", tokens: usage(40) }])
    await journal.settled()
    expect(journal.bill().known).toEqual(usage(40))
    expect((await lines(root)).filter((line) => line.type === "late")).toHaveLength(1)
    expect(journal.bill().halt).not.toBeNull()
    await journal.close()
  })

  test("a report before its execution id is mapped is held, then matched once mapped", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    const reporter = journal.reporter()
    const decision = await admitted(journal)
    reporter.report({ executionId: "exec-7", tokens: usage(9) })
    expect(journal.bill().unappliedLate).toHaveLength(1)
    await decision.settle({ kind: "unknown", why: "abandoned", executionId: "exec-7" })
    await journal.settled()
    const bill = journal.bill()
    expect(bill.unappliedLate).toHaveLength(0)
    expect(bill.known).toEqual(usage(9))
    await journal.close()
  })

  test("an equal repeat is idempotent; a disagreeing one, in a later batch, is an integrity halt", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    const reporter = journal.reporter()
    const decision = await admitted(journal)
    await decision.settle({ kind: "unknown", why: "abandoned", executionId: "exec-2" })
    reporter.report({ executionId: "exec-2", tokens: usage(5) })
    reporter.report({ executionId: "exec-2", tokens: usage(5) })
    await journal.settled()
    expect(journal.bill().integrity).toHaveLength(0)
    reporter.report({ executionId: "exec-2", tokens: usage(6) })
    await journal.settled()
    const bill = journal.bill()
    expect(bill.integrity).toHaveLength(1)
    expect(bill.integrity[0]!.payloads).toEqual([usage(5), usage(6)])
    expect(bill.known).toEqual(usage(5))
    await journal.close()
  })

  test("an unmatched report stays visible", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    journal.reporter().report({ executionId: "nobody", tokens: usage(1) })
    expect(journal.bill().unappliedLate).toEqual([{ executionId: "nobody", tokens: usage(1) }])
    await journal.close()
  })

  test("one execution id bound to two requests is an integrity failure", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    const admission = journal.admission({ block: 1, phase: "prefix", runId: () => "r" })
    const first = await admission.admit(discover("discovery-1"))
    const second = await admission.admit(discover("discovery-2"))
    if (!first.ok || !second.ok) throw new Error("refused")
    await first.settle({ kind: "unknown", why: "a", executionId: "exec-1" })
    await second.settle({ kind: "unknown", why: "b", executionId: "exec-1" })
    expect(journal.bill().integrity.map((failure) => failure.reason).join()).toContain("bound to both")
    await journal.close()
  })
})

describe("after completion — the reconciliation handle", () => {
  async function completedWithUnknown(root: string) {
    const journal = await opened(root)
    const reporter = journal.reporter()
    const decision = await journal.admission({ block: 1, phase: "prefix", runId: () => "r" }).admit(discover())
    if (!decision.ok) throw new Error("refused")
    await decision.settle({ kind: "unknown", why: "abandoned", executionId: "exec-1" })
    const { handle, releaseError } = await journal.close()
    expect(releaseError).toBeNull()
    return { handle, reporter, journal }
  }

  test("a late report is held until flush, persisted once, and a conflict is retained; the halt stays", async () => {
    const root = await tempDir()
    const { handle, reporter, journal } = await completedWithUnknown(root)
    reporter.report({ executionId: "exec-1", tokens: usage(30) })
    expect((await lines(root)).filter((line) => line.type === "late")).toHaveLength(0)
    expect(handle.held()).toHaveLength(1)

    const first = await handle.flush()
    expect(first).toMatchObject({ ok: true, persisted: 1, conflicts: [], unmatched: [], failed: null })
    expect((await lines(root)).filter((line) => line.type === "late")).toHaveLength(1)
    expect(await handle.flush()).toMatchObject({ persisted: 0 })

    reporter.report({ executionId: "exec-1", tokens: usage(31) })
    const second = await handle.flush()
    expect(second.persisted).toBe(0)
    expect(second.conflicts).toHaveLength(1)
    const bill = handle.bill()
    expect(bill.halt).not.toBeNull()
    expect(bill.known).toEqual(usage(30))
    expect(await journal.admission({ block: 2, phase: "prefix", runId: () => "x" }).admit(discover())).toMatchObject({ ok: false })
    // The lock is released after every flush.
    expect((await acquireLock(root, now())).ok).toBe(true)
  })

  test("the mapping survives reopening: a flush reads it back from disk", async () => {
    const root = await tempDir()
    const { handle, reporter } = await completedWithUnknown(root)
    reporter.report({ executionId: "exec-1", tokens: usage(12) })
    expect((await handle.flush()).persisted).toBe(1)
    const reopened = await opened(root)
    const request = reopened.bill().requests[0]!
    expect(request.late).toEqual(usage(12))
    await reopened.close()
  })

  test("a flush that cannot take the lock, or cannot append, fails visibly and keeps the payload", async () => {
    const root = await tempDir()
    const { handle, reporter } = await completedWithUnknown(root)
    reporter.report({ executionId: "exec-1", tokens: usage(8) })

    await writeFile(join(root, LOCK_FILE), "someone else\n")
    const locked = await handle.flush()
    expect(locked.ok).toBe(false)
    expect(locked.failed).toContain("another writer holds")
    expect(handle.held()).toHaveLength(1)
    await unlink(join(root, LOCK_FILE))

    const text = await readFile(join(root, JOURNAL_FILE), "utf8")
    await unlink(join(root, JOURNAL_FILE))
    await mkdir(join(root, JOURNAL_FILE))
    const unwritable = await handle.flush()
    expect(unwritable.ok).toBe(false)
    expect(handle.held()).toHaveLength(1)

    await rm(join(root, JOURNAL_FILE), { recursive: true })
    await appendFile(join(root, JOURNAL_FILE), text)
    expect(await handle.flush()).toMatchObject({ ok: true, persisted: 1 })
    expect(handle.held()).toHaveLength(0)
  })
})

describe("the journal never rejects, and keeps its disk order (story 2-5c review)", () => {
  test("a throw while deciding an admission becomes a runner stop, not a rejection", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    const decision = await journal
      .admission({
        block: 1,
        phase: "prefix",
        runId: () => {
          throw new Error("no run id source")
        },
      })
      .admit(discover())
    expect(decision).toMatchObject({ ok: false, cause: "runner-stop" })
    expect(journal.bill().stop).toContain("no run id source")
    await journal.close()
  })

  test("a throw inside settle becomes a runner stop, not a rejection", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    const decision = await journal.admission({ block: 1, phase: "prefix", runId: () => "r" }).admit(discover())
    if (!decision.ok) throw new Error("refused")
    const unreadable = {
      kind: "unknown",
      get why(): string {
        throw new Error("no reason readable")
      },
    } as never
    await expect(decision.settle(unreadable)).resolves.toBeUndefined()
    expect(journal.bill().stop).toContain("settlement could not be recorded")
    await journal.close()
  })

  test("an admission with no run id yet is refused as a runner stop and never journaled", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    const decision = await journal.admission({ block: 1, phase: "prefix", runId: () => undefined }).admit(discover())
    expect(decision).toMatchObject({ ok: false, cause: "runner-stop" })
    expect(existsSync(join(root, JOURNAL_FILE))).toBe(false)
    await journal.close()
  })

  test("a settlement after close is held and appended by flush, never through the released lock", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    const decision = await journal.admission({ block: 1, phase: "prefix", runId: () => "r" }).admit(discover())
    if (!decision.ok) throw new Error("refused")
    const { handle } = await journal.close()
    await decision.settle({ kind: "usage", tokens: usage(3) })
    expect((await lines(root)).filter((line) => line.type === "settled")).toHaveLength(0)
    expect(await handle.flush()).toMatchObject({ ok: true, persisted: 1 })
    expect((await lines(root)).filter((line) => line.type === "settled")).toHaveLength(1)
    const reopened = await opened(root)
    expect(reopened.bill().uncertain).toHaveLength(0)
    expect(reopened.bill().known).toEqual(usage(3))
    await reopened.close()
  })

  test("a late report bound by its settlement is written after that settlement; replay finds no integrity failure", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    const reporter = journal.reporter()
    const decision = await journal.admission({ block: 1, phase: "on", runId: () => "r" }).admit(discover())
    if (!decision.ok) throw new Error("refused")
    reporter.report({ executionId: "exec-1", tokens: usage(4) })
    await decision.settle({ kind: "unknown", why: "abandoned", executionId: "exec-1" })
    await journal.settled()
    expect((await lines(root)).map((line) => line.type)).toEqual(["issued", "settled", "late"])
    await journal.close()
    const reopened = await opened(root)
    expect(reopened.bill().integrity).toHaveLength(0)
    await reopened.close()
  })

  test("physical ids never collide with ids already in a replayed journal", async () => {
    const root = await tempDir()
    await writeFile(
      join(root, JOURNAL_FILE),
      [
        { type: "issued", physicalId: "request-2", category: "pilot", block: null, phase: null, stage: "discover", slot: "s", attempt: 1, runId: "p" },
        { type: "settled", physicalId: "request-2", settlement: { kind: "usage", tokens: usage(1) } },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    )
    const journal = await opened(root)
    const admission = journal.admission({ block: 1, phase: "prefix", runId: () => "r" })
    for (const slot of ["a", "b"]) {
      const decision = await admission.admit(discover(slot))
      if (!decision.ok) throw new Error(decision.reason)
      await decision.settle({ kind: "usage", tokens: usage(1) })
    }
    const bill = journal.bill()
    expect(bill.integrity).toHaveLength(0)
    expect(bill.requests.map((request) => request.physicalId)).toEqual(["request-2", "request-1", "request-3"])
    await journal.close()
  })

  test("a late report no settlement ever binds stays visible, and flush reports it unmatched", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    const decision = await journal.admission({ block: 1, phase: "on", runId: () => "r" }).admit(discover())
    if (!decision.ok) throw new Error("refused")
    journal.reporter().report({ executionId: "exec-9", tokens: usage(2) })
    await decision.settle({ kind: "usage", tokens: usage(5) })
    expect(journal.bill().unappliedLate).toHaveLength(1)
    const { handle } = await journal.close()
    const flushed = await handle.flush()
    expect(flushed.unmatched).toEqual([{ executionId: "exec-9", tokens: usage(2) }])
    expect(handle.held()).toHaveLength(1)
  })
})

describe("replay validation refuses a malformed journal (story 2-5c review)", () => {
  const issued = { type: "issued", physicalId: "request-1", category: "blocks", block: 1, phase: "prefix", stage: "discover", slot: "s", attempt: 1, runId: "r" }
  test.each([
    ["an unknown category", { ...issued, category: "research" }],
    ["attempt 0", { ...issued, attempt: 0 }],
    ["a fractional attempt", { ...issued, attempt: 1.5 }],
    ["block 0", { ...issued, block: 0 }],
    ["a Blocks request with no block", { ...issued, block: null }],
    ["a Blocks request with no phase", { ...issued, phase: null }],
    ["an unknown settlement with no why", { type: "settled", physicalId: "request-1", settlement: { kind: "unknown" } }],
    ["a usage settlement with bad tokens", { type: "settled", physicalId: "request-1", settlement: { kind: "usage", tokens: { input: -1 } } }],
    ["another category with a phase", { ...issued, category: "calibration", block: null, phase: "on" }],
    ["an empty run id", { ...issued, runId: "" }],
    ["an empty slot", { ...issued, slot: "" }],
    ["step 1", { ...issued, step: 1 }],
    ["a fractional step", { ...issued, step: 2.5 }],
  ])("%s", async (_name, line) => {
    const root = await tempDir()
    const rows = line.type === "settled" ? [issued, line] : [line]
    await writeFile(join(root, JOURNAL_FILE), rows.map((row) => JSON.stringify(row)).join("\n") + "\n")
    const lock = await acquireLock(root, now())
    if (!lock.ok) throw new Error(lock.reason)
    const outcome = await openJournal(root, lock.lock, now)
    expect(outcome.ok).toBe(false)
    await lock.lock.release()
  })

  test("another category may carry no block", async () => {
    const root = await tempDir()
    await writeFile(join(root, JOURNAL_FILE), `${JSON.stringify({ ...issued, category: "calibration", block: null, phase: null })}\n`)
    const lock = await acquireLock(root, now())
    if (!lock.ok) throw new Error(lock.reason)
    const outcome = await openJournal(root, lock.lock, now)
    expect(outcome.ok).toBe(true)
    await lock.lock.release()
  })
})

describe("overshoot and the halt marker (story 2-5c review)", () => {
  test("known spend past a threshold is reported per limit", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    const admission = journal.admission({ block: 2, phase: "prefix", runId: () => "r" })
    const first = await admission.admit(discover("a"))
    const second = await admission.admit(discover("b"))
    if (!first.ok || !second.ok) throw new Error("refused")
    await first.settle({ kind: "usage", tokens: usage(40_000) })
    await second.settle({ kind: "usage", tokens: usage(30_000) })
    const { overshoot } = journal.bill()
    expect(overshoot.phases).toEqual([{ block: 2, phase: "prefix", limit: 60_000, spent: 70_000, overshoot: 10_000 }])
    expect(overshoot.blocks).toEqual({ limit: 1_400_000, spent: 70_000, overshoot: 0 })
    expect(overshoot.global.overshoot).toBe(0)
    await journal.close()
  })

  test("a latched halt writes the arm governor's marker, so the arm governor refuses too", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    const decision = await journal.admission({ block: 1, phase: "prefix", runId: () => "r" }).admit(discover())
    if (!decision.ok) throw new Error("refused")
    await decision.settle({ kind: "unknown", why: "host reported nothing" })
    await journal.settled()
    expect(existsSync(join(root, HALT_MARKER_FILE))).toBe(true)
    expect(journal.bill().haltMarker.file).toBe(join(root, HALT_MARKER_FILE))
    await journal.close()
    expect(await createExperimentGovernor({ bundleRoot: root }).admit()).toMatchObject({ ok: false })
  })

  test("a marker already at the root latches the journal's halt", async () => {
    const root = await tempDir()
    await writeFile(join(root, HALT_MARKER_FILE), "{}\n")
    const journal = await opened(root)
    expect(journal.bill().halt).toContain("halt marker")
    expect(await journal.admission({ block: 1, phase: "prefix", runId: () => "r" }).admit(discover())).toMatchObject({ ok: false, cause: "halted" })
    await journal.close()
  })
})

describe("settlements the journal cannot count, failed appends and closing (story 2-5c review)", () => {
  /** An I/O that appends normally until `fail` is set, then rejects before or after writing. */
  function flakyIo(): { io: JournalIo; fail: { mode: "before" | "after" | null } } {
    const fail: { mode: "before" | "after" | null } = { mode: null }
    return {
      fail,
      io: {
        async appendLine(file: string, line: JournalLine) {
          if (fail.mode === "before") throw new Error("disk full")
          await appendFile(file, `${JSON.stringify(line)}\n`)
          if (fail.mode === "after") throw new Error("sync failed")
        },
      },
    }
  }

  async function openedWith(root: string, io: JournalIo): Promise<PairedJournal> {
    const lock = await acquireLock(root, now())
    if (!lock.ok) throw new Error(lock.reason)
    const journal = await openJournal(root, lock.lock, now, io)
    if (!journal.ok) throw new Error(journal.reason)
    return journal.journal
  }

  test.each([
    ["a missing field", { input: 1 }],
    ["a NaN field", { ...usage(1), output: Number.NaN }],
  ])("usage with %s is billed unknown, halts, and the journal still reopens", async (_name, tokens) => {
    const root = await tempDir()
    const journal = await opened(root)
    const decision = await journal.admission({ block: 1, phase: "prefix", runId: () => "r" }).admit(discover())
    if (!decision.ok) throw new Error("refused")
    await decision.settle({ kind: "usage", tokens: tokens as TokenUsage })
    // An identical repeat of the same malformed figure is a no-op, not a conflict.
    await decision.settle({ kind: "usage", tokens: tokens as TokenUsage })
    await journal.settled()
    const bill = journal.bill()
    expect(bill.halt).not.toBeNull()
    expect(bill.unknown).toHaveLength(1)
    expect(bill.integrity).toHaveLength(0)
    expect((await lines(root)).filter((line) => line.type === "settled")).toEqual([
      { type: "settled", physicalId: "request-1", settlement: { kind: "unknown", why: "the settled usage figure was not five finite, non-negative numbers" } },
    ])
    const { handle } = await journal.close()
    expect(await handle.flush()).toMatchObject({ ok: true })
    const reopened = await opened(root)
    expect(reopened.bill().unknown).toHaveLength(1)
    expect(reopened.bill().integrity).toHaveLength(0)
    await reopened.close()
  })

  test("an append that fails before writing keeps the settlement for flush, which persists it once", async () => {
    const root = await tempDir()
    const { io, fail } = flakyIo()
    const journal = await openedWith(root, io)
    const admission = journal.admission({ block: 1, phase: "prefix", runId: () => "r" })
    const first = await admission.admit(discover("a"))
    const second = await admission.admit(discover("b"))
    if (!first.ok || !second.ok) throw new Error("refused")
    fail.mode = "before"
    await first.settle({ kind: "usage", tokens: usage(7) })
    fail.mode = null
    // Nothing more is appended during the invocation once an append failed.
    await second.settle({ kind: "usage", tokens: usage(8) })
    expect((await lines(root)).filter((line) => line.type === "settled")).toHaveLength(0)
    expect(journal.bill().stop).toContain("could not be appended")
    expect(journal.bill().known).toEqual(usage(15))
    const { handle } = await journal.close()
    expect(await handle.flush()).toMatchObject({ ok: true, persisted: 2 })
    const reopened = await opened(root)
    expect(reopened.bill().uncertain).toHaveLength(0)
    expect(reopened.bill().known).toEqual(usage(15))
    await reopened.close()
  })

  test("an append that fails after writing is not appended twice by flush", async () => {
    const root = await tempDir()
    const { io, fail } = flakyIo()
    const journal = await openedWith(root, io)
    const decision = await journal.admission({ block: 1, phase: "prefix", runId: () => "r" }).admit(discover())
    if (!decision.ok) throw new Error("refused")
    fail.mode = "after"
    await decision.settle({ kind: "usage", tokens: usage(9) })
    fail.mode = null
    expect(journal.bill().stop).toContain("could not be appended")
    const { handle } = await journal.close()
    expect(await handle.flush()).toMatchObject({ ok: true, persisted: 0 })
    expect((await lines(root)).filter((line) => line.type === "settled")).toHaveLength(1)
  })

  test.each([
    ["before", 1],
    ["after", 0],
  ] as const)("a late line whose append fails %s writing is persisted exactly once by flush", async (mode, persisted) => {
    const root = await tempDir()
    const { io, fail } = flakyIo()
    const journal = await openedWith(root, io)
    const reporter = journal.reporter()
    const decision = await journal.admission({ block: 1, phase: "on", runId: () => "r" }).admit(discover())
    if (!decision.ok) throw new Error("refused")
    await decision.settle({ kind: "unknown", why: "abandoned", executionId: "exec-1" })
    await journal.settled()
    fail.mode = mode
    reporter.report({ executionId: "exec-1", tokens: usage(6) })
    await journal.settled()
    fail.mode = null
    const { handle } = await journal.close()
    expect(await handle.flush()).toMatchObject({ ok: true, persisted })
    expect((await lines(root)).filter((line) => line.type === "late")).toHaveLength(1)
    const reopened = await opened(root)
    expect(reopened.bill().requests[0]!.late).toEqual(usage(6))
    expect(reopened.bill().integrity).toHaveLength(0)
    await reopened.close()
  })

  test.each(["before", "after"] as const)("an issued line whose append fails %s writing never reads back as uncertain after flush", async (mode) => {
    const root = await tempDir()
    const { io, fail } = flakyIo()
    const journal = await openedWith(root, io)
    fail.mode = mode
    const decision = await journal.admission({ block: 1, phase: "prefix", runId: () => "r" }).admit(discover())
    fail.mode = null
    expect(decision).toMatchObject({ ok: false, cause: "runner-stop" })
    const { handle } = await journal.close()
    expect(await handle.flush()).toMatchObject({ ok: true, persisted: mode === "after" ? 1 : 0 })
    const reopened = await opened(root)
    expect(reopened.bill().uncertain).toHaveLength(0)
    expect(reopened.bill().halt).toBeNull()
    await reopened.close()
  })

  test("flush refuses a journal with a torn last line rather than appending to it", async () => {
    const root = await tempDir()
    const { io, fail } = flakyIo()
    const journal = await openedWith(root, io)
    const decision = await journal.admission({ block: 1, phase: "prefix", runId: () => "r" }).admit(discover())
    if (!decision.ok) throw new Error("refused")
    fail.mode = "before"
    await decision.settle({ kind: "usage", tokens: usage(9) })
    const { handle } = await journal.close()
    await appendFile(join(root, JOURNAL_FILE), '{"type":"sett')
    const before = await readFile(join(root, JOURNAL_FILE), "utf8")
    const flushed = await handle.flush()
    expect(flushed.ok).toBe(false)
    expect(flushed.failed).toContain("is not JSON")
    expect(await readFile(join(root, JOURNAL_FILE), "utf8")).toBe(before)
  })

  test("closing latches no stop; a failure in the last drain does", async () => {
    const quiet = await opened(await tempDir())
    const { handle: closed } = await quiet.close()
    expect(closed.bill().stop).toBeNull()
    expect(await quiet.admission({ block: 1, phase: "prefix", runId: () => "r" }).admit(discover())).toMatchObject({
      ok: false,
      cause: "runner-stop",
    })
    expect(closed.bill().stop).toBeNull()
    expect(closed.bill().refused).toEqual([])

    const root = await tempDir()
    const { io, fail } = flakyIo()
    const journal = await openedWith(root, io)
    const reporter = journal.reporter()
    const decision = await journal.admission({ block: 1, phase: "on", runId: () => "r" }).admit(discover())
    if (!decision.ok) throw new Error("refused")
    await decision.settle({ kind: "unknown", why: "abandoned", executionId: "exec-1" })
    await journal.settled()
    fail.mode = "before"
    reporter.report({ executionId: "exec-1", tokens: usage(3) })
    const { handle } = await journal.close()
    expect(handle.bill().stop).toContain("could not be appended")
  })

  test("a malformed admission request is refused as a runner stop and never journaled", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    const admission = journal.admission({ block: 1, phase: "prefix", runId: () => "r" })
    expect(await admission.admit({ stage: "discover", slot: "s", attempt: 0 })).toMatchObject({ ok: false, cause: "runner-stop" })
    expect(journal.bill().stop).toContain("malformed request")
    expect(existsSync(join(root, JOURNAL_FILE))).toBe(false)
    await journal.close()
  })

  test("every refused admission is kept on the bill with its phase and cause", async () => {
    const root = await tempDir()
    await writeFile(
      join(root, JOURNAL_FILE),
      [
        { type: "issued", physicalId: "request-1", category: "blocks", block: 1, phase: "prefix", stage: "discover", slot: "s", attempt: 1, runId: "p" },
        { type: "settled", physicalId: "request-1", settlement: { kind: "usage", tokens: usage(60_000) } },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    )
    const journal = await opened(root)
    await journal.admission({ block: 1, phase: "prefix", runId: () => "p" }).admit(discover("discovery-2", 2))
    expect(journal.bill().refused).toEqual([
      expect.objectContaining({ block: 1, phase: "prefix", runId: "p", stage: "discover", slot: "discovery-2", attempt: 2, cause: "budget" }),
    ])
    await journal.close()
  })
})

describe("the OPERATIONAL halt and the retained lock (story 2-7c)", () => {
  test("it latches, stops admission SYNCHRONOUSLY, and is worded apart from unknown spend", async () => {
    const root = await tempDir()
    const journal = await opened(root)

    journal.haltOperationally("a process MAD launched could not be confirmed terminated")

    // SYNCHRONOUS. The next request is refused from the moment the call returns,
    // which is what lets a runner latch before asking another model rather than
    // at the end of a run.
    const bill = journal.bill()
    expect(bill.halt).toContain("OPERATIONAL HALT")
    // IT MAKES NO CLAIM ABOUT SPEND. The earlier wording asserted the accounting
    // was clean, which is a sentence that becomes false the moment an
    // unknown-usage halt and an unresolved process coexist.
    expect(bill.halt).toContain("makes no claim about spend")
    expect(bill.halt).not.toContain("no spend is unaccounted for")
    expect(bill.halt).toContain("could not be confirmed terminated")
    expect(bill.operational).toHaveLength(1)
    expect(bill.stop).toContain("OPERATIONAL HALT")
    const decision = await journal.adversarialAdmission({ label: "adv-01 attack", runId: () => "run-1" }).admit(discover())
    expect(decision.ok).toBe(false)

    // AND NOTHING WAS INVENTED ON THE BILL. No request, no usage, no unknown.
    expect(bill.unknown).toEqual([])
    expect(bill.uncertain).toEqual([])
    expect(bill.inFlight).toEqual([])

    // THE HALT MARKER CARRIES THE SAME WORDS, so a reader who finds
    // `unknown-usage-halt.json` is not told money is missing when it is not.
    await journal.settled()
    const marker = JSON.parse(await readFile(join(root, HALT_MARKER_FILE), "utf8")) as { haltReason: string }
    expect(marker.haltReason).toContain("OPERATIONAL HALT")

    const closed = await journal.close()
    expect(closed.lockRetained).toBe(true)
  })

  test("THE LOCK IS KEPT, and a second writer is refused", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    journal.haltOperationally("an append to the trace is unconfirmed")

    const { lockRetained, releaseError } = await journal.close()

    expect(lockRetained).toBe(true)
    expect(releaseError).toBeNull()
    expect(existsSync(join(root, LOCK_FILE))).toBe(true)
    const second = await acquireLock(root, now())
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toContain("another writer holds")
  })

  test("AN ORDINARY CLOSE STILL RELEASES — the non-vacuous sibling", async () => {
    // Without this row the two above would pass on a journal that never released
    // the lock at all.
    const root = await tempDir()
    const journal = await opened(root)

    const { lockRetained, releaseError } = await journal.close()

    expect(lockRetained).toBe(false)
    expect(releaseError).toBeNull()
    expect(existsSync(join(root, LOCK_FILE))).toBe(false)
    expect((await acquireLock(root, now())).ok).toBe(true)
  })

  test("A HALT WRITE THAT FAILS COSTS NEITHER THE STOP NOR THE LOCK", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    // THE ROOT IS MADE UNWRITABLE AFTER THE JOURNAL IS OPEN, so the marker write
    // is refused by the filesystem. The durable half is what fails here; the
    // local half must not depend on it.
    await chmod(root, 0o500)
    try {
      journal.haltOperationally("a process MAD launched could not be confirmed terminated")
      await journal.settled()
    } finally {
      await chmod(root, 0o700)
    }

    const bill = journal.bill()
    expect(bill.stop).toContain("OPERATIONAL HALT")
    expect(bill.haltMarker.file).toBeNull()
    expect(bill.haltMarker.error).not.toBeNull()
    const decision = await journal.adversarialAdmission({ label: "adv-01 attack", runId: () => "run-1" }).admit(discover())
    expect(decision.ok).toBe(false)

    const { lockRetained } = await journal.close()
    expect(lockRetained).toBe(true)
  })

  test("A LATE REPORT IS STILL RECORDED, and never discarded by the quarantine", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    const admission = journal.admission({ block: 1, phase: "prefix", runId: () => "run-1" })
    const decision = await admission.admit(discover())
    if (!decision.ok) throw new Error("expected admission")
    await decision.settle({ kind: "unknown", why: "no usage came back", executionId: "exec-1" })

    journal.haltOperationally("a process MAD launched could not be confirmed terminated")
    journal.reporter().report({ executionId: "exec-1", tokens: usage(11, 3) })
    await journal.settled()

    // The recovery landed on the record. Nothing about the quarantine throws
    // usage away, and nothing about it simulates any.
    expect((await lines(root)).some((line) => line.type === "late")).toBe(true)
    await journal.close()
  })
})

describe("ACCOUNTING UNCERTAINTY AND OPERATIONAL QUARANTINE COEXIST (story 2-7c)", () => {
  /** Settle a request with unknown usage, which is what latches an accounting halt. */
  async function unknownSpend(journal: PairedJournal): Promise<void> {
    const decision = await journal.admission({ block: 1, phase: "prefix", runId: () => "run-1" }).admit(discover())
    if (!decision.ok) throw new Error("expected admission")
    await decision.settle({ kind: "unknown", why: "no usage came back", executionId: "exec-1" })
  }

  test("MONEY FIRST, THEN CLEANUP: the halt keeps the money reason AND the quarantine is recorded", async () => {
    // `latch` is first-reason-wins, correctly — overwriting would hide why the
    // money is uncertain. So the quarantine has to be recorded BESIDE it, or the
    // ordering silently decides which of two facts the operator gets told.
    const root = await tempDir()
    const journal = await opened(root)

    await unknownSpend(journal)
    journal.haltOperationally("a process MAD launched could not be confirmed terminated")
    await journal.settled()

    const bill = journal.bill()
    expect(bill.halt).toContain("billed an UNKNOWN amount")
    expect(bill.halt).not.toContain("OPERATIONAL HALT")
    // AND THE QUARANTINE SURVIVED ANYWAY.
    expect(bill.operational).toHaveLength(1)
    expect(bill.operational[0]).toContain("could not be confirmed terminated")
    expect(bill.unknown).toHaveLength(1)

    const { lockRetained } = await journal.close()
    expect(lockRetained).toBe(true)
  })

  test("MONEY FIRST AND THE MARKER ALREADY WRITTEN: the marker cannot gain the reason, so the BILL has to carry it", async () => {
    // THE INTERLEAVING THE TWO TESTS AROUND THIS ONE DO NOT REACH. They call
    // `settled()` only after both halts have latched, so the marker's lazy read
    // of `state.operational` saves them. Here the marker write has already RUN
    // before the quarantine happens, and `unknown-usage-halt.json` is opened with
    // `wx` and never rewritten — so the file on disk names the money and nothing
    // else, permanently.
    //
    // That is the deliberate contract of a write-once marker, not a defect. What
    // it MAKES REQUIRED is the durable bill: it is then the only record that says
    // a process MAD launched was never accounted for, and an operator reading
    // only the marker would take an accounting problem for the whole story.
    const root = await tempDir()
    const journal = await opened(root)

    await unknownSpend(journal)
    // The marker is queued and physically written HERE, before the quarantine.
    await journal.settled()
    const beforeQuarantine = JSON.parse(await readFile(join(root, HALT_MARKER_FILE), "utf8")) as {
      haltReason: string
      operational?: string[]
    }
    expect(beforeQuarantine.haltReason).toContain("billed an UNKNOWN amount")
    expect(beforeQuarantine.operational ?? []).toEqual([])

    journal.haltOperationally("a process MAD launched could not be confirmed terminated")
    await journal.settled()

    // THE FILE IS UNCHANGED. Write-once means write-once.
    const afterQuarantine = JSON.parse(await readFile(join(root, HALT_MARKER_FILE), "utf8")) as {
      haltReason: string
      operational?: string[]
    }
    expect(afterQuarantine).toEqual(beforeQuarantine)

    // AND THE BILL CARRIES WHAT THE MARKER CANNOT. This is the assertion that
    // makes the write-once contract safe rather than lossy.
    const bill = journal.bill()
    expect(bill.halt).toContain("billed an UNKNOWN amount")
    expect(bill.operational).toHaveLength(1)
    expect(bill.operational[0]).toContain("could not be confirmed terminated")

    const { lockRetained } = await journal.close()
    expect(lockRetained).toBe(true)
  })

  test("CLEANUP FIRST, THEN MONEY: the halt keeps the cleanup reason AND the unknown still bills", async () => {
    const root = await tempDir()
    const journal = await opened(root)

    journal.haltOperationally("a process MAD launched could not be confirmed terminated")
    // Admission is stopped, so the request is journaled directly rather than
    // through a gate that would now refuse it — the point is the ACCOUNTING, not
    // a second admission.
    const bill = journal.bill()
    expect(bill.halt).toContain("OPERATIONAL HALT")
    expect(bill.operational).toHaveLength(1)

    const { handle, lockRetained } = await journal.close()
    expect(lockRetained).toBe(true)
    // Nothing about the quarantine discards or simulates usage.
    expect(handle.bill().unknown).toEqual([])
    expect(handle.bill().operational).toHaveLength(1)
  })

  test("A SECOND QUARANTINE DOES NOT ERASE THE FIRST, and never renames the halt", async () => {
    const root = await tempDir()
    const journal = await opened(root)

    journal.haltOperationally("a process could not be confirmed terminated")
    const first = journal.bill().halt
    journal.haltOperationally("a trace append is unconfirmed")

    // The halt reason is unchanged — no overwrite, no rename.
    expect(journal.bill().halt).toBe(first)
    // And both causes are on the record.
    expect(journal.bill().operational).toHaveLength(2)
    expect(journal.bill().operational[1]).toContain("trace append")
    await journal.close()
  })

  test("AN ORDINARY RUN CARRIES NONE OF THIS — the non-vacuous sibling", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    const decision = await journal.admission({ block: 1, phase: "prefix", runId: () => "run-1" }).admit(discover())
    if (decision.ok) await decision.settle({ kind: "usage", tokens: usage(10, 2) })

    expect(journal.bill().operational).toEqual([])
    expect(journal.bill().halt).toBeNull()
    const { lockRetained } = await journal.close()
    expect(lockRetained).toBe(false)
  })
})

describe("A RESTART DOES NOT UNDO THE QUARANTINE (story 2-7c)", () => {
  test("a NEW journal over the same root is refused by the retained lock", async () => {
    // The durable half. `ablation/tool-trace.ts`'s poison map is process memory
    // and is gone on a restart; the LOCK and the HALT MARKER are the things on
    // disk, and this is what a second writer actually meets.
    const root = await tempDir()
    const journal = await opened(root)
    journal.haltOperationally("a process MAD launched could not be confirmed terminated")
    await journal.settled()
    await journal.close()

    const restart = await acquireLock(root, now())
    expect(restart.ok).toBe(false)
    if (!restart.ok) expect(restart.reason).toContain("another writer holds")
  })

  test("AND EVEN WITH THE LOCK GONE, the halt marker refuses the next journal", async () => {
    // Belt and braces, because a human recovering by hand removes the lock. The
    // marker is the second, independent refusal, and nothing auto-clears it.
    const root = await tempDir()
    const journal = await opened(root)
    journal.haltOperationally("a process MAD launched could not be confirmed terminated")
    await journal.settled()
    await journal.close()
    await unlink(join(root, LOCK_FILE))

    const lock = await acquireLock(root, now())
    expect(lock.ok).toBe(true)
    if (!lock.ok) return
    const reopened = await openJournal(root, lock.lock, now)
    expect(reopened.ok).toBe(true)
    if (!reopened.ok) return
    // Halted on open, so nothing is admitted.
    expect(reopened.journal.bill().halt).toContain("halt marker")
    const decision = await reopened.journal
      .adversarialAdmission({ label: "adv-01 attack", runId: () => "run-2" })
      .admit(discover())
    expect(decision.ok).toBe(false)
    await reopened.journal.close()
  })

  test("A FAILED HALT WRITE STILL RETAINS THE LOCK, so a restart is still refused", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    await chmod(root, 0o500)
    try {
      journal.haltOperationally("a process MAD launched could not be confirmed terminated")
      await journal.settled()
    } finally {
      await chmod(root, 0o700)
    }

    expect(journal.bill().haltMarker.file).toBeNull()
    const { lockRetained } = await journal.close()
    expect(lockRetained).toBe(true)
    // No marker on disk, so the LOCK is the only thing standing — and it stands.
    expect(existsSync(join(root, HALT_MARKER_FILE))).toBe(false)
    expect((await acquireLock(root, now())).ok).toBe(false)
  })

  test("AN ORDINARY RUN LETS THE NEXT WRITER IN — the non-vacuous sibling", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    await journal.close()
    const restart = await acquireLock(root, now())
    expect(restart.ok).toBe(true)
  })
})

describe("physical requests inside an admitted attempt (story 2-8c2)", () => {
  async function metered(root: string) {
    const journal = await opened(root)
    const admission = journal.admission({ block: 1, phase: "prefix", runId: () => "run-m" })
    const decision = await admission.admit(discover())
    if (!decision.ok || decision.turn === undefined) throw new Error("expected an admitted attempt with a turn handle")
    return { journal, admission, decision, turn: decision.turn }
  }

  test("a step is its own durable `issued` line, and each request settles with its own figure", async () => {
    const root = await tempDir()
    const { journal, decision, turn } = await metered(root)
    const step = await turn.admitStep()
    expect(step).toMatchObject({ ok: true, step: 2 })
    expect((await lines(root)).filter((line) => line.type === "issued")).toEqual([
      expect.objectContaining({ physicalId: "request-1", attempt: 1 }),
      { type: "issued", physicalId: "request-2", category: "blocks", block: 1, phase: "prefix", stage: "discover", slot: "discovery-1", attempt: 1, step: 2, runId: "run-m" },
    ])
    if (!step.ok) return
    await turn.settleFirst({ kind: "usage", tokens: usage(100, 1) })
    await step.settle({ kind: "usage", tokens: usage(200, 2) })
    // The stage settles the attempt with the sum: a cross-check that writes nothing.
    await decision.settle({ kind: "usage", tokens: usage(300, 3) })
    const settled = (await lines(root)).filter((line) => line.type === "settled")
    expect(settled).toEqual([
      { type: "settled", physicalId: "request-1", settlement: { kind: "usage", tokens: usage(100, 1) } },
      { type: "settled", physicalId: "request-2", settlement: { kind: "usage", tokens: usage(200, 2) } },
    ])
    const bill = journal.bill()
    expect(bill.known).toEqual(usage(300, 3))
    expect(bill.integrity).toHaveLength(0)
    expect(bill.halt).toBeNull()
    await journal.close()
  })

  test("a stage figure that is not the sum is an integrity failure, and it changes no request", async () => {
    const root = await tempDir()
    const { journal, decision, turn } = await metered(root)
    const step = await turn.admitStep()
    if (!step.ok) throw new Error("refused")
    await turn.settleFirst({ kind: "usage", tokens: usage(100, 1) })
    await step.settle({ kind: "usage", tokens: usage(200, 2) })
    // Counting request 1 alone, as the host's last-step figure would.
    await decision.settle({ kind: "usage", tokens: usage(200, 2) })
    const bill = journal.bill()
    expect(bill.integrity).toHaveLength(1)
    expect(bill.integrity[0]!.reason).toContain("not the sum of its 2 physical request(s)")
    expect(bill.known).toEqual(usage(300, 3))
    expect((await lines(root)).filter((line) => line.type === "settled")).toHaveLength(2)
    await journal.close()
  })

  test("an unknown request makes an unknown stage figure the only consistent one", async () => {
    const root = await tempDir()
    const { journal, admission, decision, turn } = await metered(root)
    const step = await turn.admitStep()
    if (!step.ok) throw new Error("refused")
    await turn.settleFirst({ kind: "usage", tokens: usage(100, 1) })
    await step.settle({ kind: "unknown", why: "the provider answered HTTP 500" })
    await decision.settle({ kind: "unknown", why: "the relay has no usage figure" })
    const bill = journal.bill()
    expect(bill.integrity).toHaveLength(0)
    expect(bill.halt).toContain("billed an UNKNOWN amount")
    // The halt latched by the unknown request stays latched.
    expect(await admission.admit(discover("discovery-2"))).toMatchObject({ ok: false, cause: "halted" })
    await journal.close()
  })

  test("a known stage figure over an unknown request is an integrity failure", async () => {
    const root = await tempDir()
    const { journal, decision, turn } = await metered(root)
    await turn.settleFirst({ kind: "unknown", why: "aborted when the attempt ended" })
    await decision.settle({ kind: "usage", tokens: usage(0) })
    expect(journal.bill().integrity).toHaveLength(1)
    await journal.close()
  })

  test("the stage settling while a step is still in flight is an integrity failure", async () => {
    const root = await tempDir()
    const { journal, decision, turn } = await metered(root)
    const step = await turn.admitStep()
    if (!step.ok) throw new Error("refused")
    await turn.settleFirst({ kind: "usage", tokens: usage(100, 1) })
    await decision.settle({ kind: "usage", tokens: usage(100, 1) })
    expect(journal.bill().integrity[0]!.reason).toContain("still in flight")
    await journal.close()
  })

  test("without `settleFirst`, the stage's settlement is the attempt's, as before", async () => {
    const root = await tempDir()
    const { journal, decision } = await metered(root)
    await decision.settle({ kind: "usage", tokens: usage(7) })
    expect(journal.bill().known).toEqual(usage(7))
    await journal.close()
  })

  test("a step passes the same experiment gates as its attempt", async () => {
    const root = await tempDir()
    const { journal, turn } = await metered(root)
    await turn.settleFirst({ kind: "usage", tokens: usage(60_000) })
    // Block 1's prefix allowance is 60,000: the step is refused before any line is written.
    const step = await turn.admitStep()
    expect(step).toMatchObject({ ok: false, cause: "budget" })
    expect((await lines(root)).filter((line) => line.type === "issued")).toHaveLength(1)
    await journal.close()
  })

  test("a step settled not-issued counts for nothing in the cross-check", async () => {
    const root = await tempDir()
    const { journal, decision, turn } = await metered(root)
    const step = await turn.admitStep()
    if (!step.ok) throw new Error("refused")
    await turn.settleFirst({ kind: "usage", tokens: usage(100, 1) })
    await step.settle({ kind: "not-issued" })
    await decision.settle({ kind: "usage", tokens: usage(100, 1) })
    const bill = journal.bill()
    expect(bill.integrity).toHaveLength(0)
    expect(bill.halt).toBeNull()
    await journal.close()
  })

  test("no step is admitted once the stage has settled the attempt", async () => {
    const root = await tempDir()
    const { journal, decision, turn } = await metered(root)
    await turn.settleFirst({ kind: "usage", tokens: usage(1) })
    await decision.settle({ kind: "usage", tokens: usage(1) })
    expect(await turn.admitStep()).toMatchObject({ ok: false, cause: "runner-stop" })
    expect((await lines(root)).filter((line) => line.type === "issued")).toHaveLength(1)
    await journal.close()
  })

  test("steps admitted with no metered first request make the stage's figure a cross-check, which fails", async () => {
    const root = await tempDir()
    const { journal, decision, turn } = await metered(root)
    const step = await turn.admitStep()
    if (!step.ok) throw new Error("refused")
    await step.settle({ kind: "usage", tokens: usage(2) })
    await decision.settle({ kind: "usage", tokens: usage(2) })
    expect(journal.bill().integrity[0]!.reason).toContain("still in flight")
    await journal.close()
  })

  test("a step asked for outside its attempt's handle stops the runner, and nothing is written", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    const admission = journal.admission({ block: 1, phase: "prefix", runId: () => "run-x" })
    const decision = await admission.admit({ ...discover(), step: 2 })
    expect(decision).toMatchObject({ ok: false, cause: "runner-stop" })
    expect(existsSync(join(root, JOURNAL_FILE)) ? await lines(root) : []).toEqual([])
    expect(journal.bill().stop).toContain("outside its attempt's turn handle")
    await journal.close()
  })

  test("a journal with step lines replays", async () => {
    const root = await tempDir()
    const { journal, decision, turn } = await metered(root)
    const step = await turn.admitStep()
    if (!step.ok) throw new Error("refused")
    await turn.settleFirst({ kind: "usage", tokens: usage(100, 1) })
    await step.settle({ kind: "usage", tokens: usage(200, 2) })
    await decision.settle({ kind: "usage", tokens: usage(300, 3) })
    await journal.close()
    const reopened = await opened(root)
    expect(reopened.bill().known).toEqual(usage(300, 3))
    expect(reopened.bill().requests.map((request) => request.step)).toEqual([undefined, 2])
    await reopened.close()
  })
})

describe("attempt mode (story 2-8c3a)", () => {
  async function attemptJournal(root: string): Promise<PairedJournal> {
    const lock = await acquireLock(root, now())
    if (!lock.ok) throw new Error(lock.reason)
    const journal = await openJournal(root, lock.lock, now, undefined, "attempts")
    if (!journal.ok) throw new Error(journal.reason)
    return journal.journal
  }

  /** `count` settled prefix attempts of block 1, written as an earlier invocation would have. */
  async function seeded(root: string, count: number, phase: "prefix" | "on" | "off" = "prefix", from = 1): Promise<void> {
    const rows: JournalLine[] = []
    for (let index = from; index < from + count; index += 1) {
      rows.push({ type: "issued", physicalId: `seed-${phase}-${index}`, category: "blocks", block: 1, phase, stage: "discover", slot: "discovery-1", attempt: 1, runId: "seed", mode: "attempts" })
      rows.push({ type: "settled", physicalId: `seed-${phase}-${index}`, settlement: { kind: "usage", tokens: usage(1) } })
    }
    await appendFile(join(root, JOURNAL_FILE), rows.map((row) => `${JSON.stringify(row)}\n`).join(""))
  }

  test("an attempt admitted at 9 of 10 is journaled with `mode`, and the 11th is refused in attempts with no line", async () => {
    const root = await tempDir()
    await seeded(root, 9)
    const journal = await attemptJournal(root)
    const admission = journal.admission({ block: 1, phase: "prefix", runId: () => "run-a" })
    const tenth = await admission.admit(discover())
    expect(tenth.ok).toBe(true)
    if (tenth.ok) await tenth.settle({ kind: "usage", tokens: usage(5) })
    const written = await lines(root)
    expect(written.at(-2)).toEqual({
      type: "issued",
      physicalId: "request-1",
      category: "blocks",
      block: 1,
      phase: "prefix",
      stage: "discover",
      slot: "discovery-1",
      attempt: 1,
      runId: "run-a",
      mode: "attempts",
    })
    expect(journal.bill().byPhase.find((phase) => phase.phase === "prefix")!.requests).toBe(10)

    const eleventh = await admission.admit(discover("discovery-2"))
    expect(eleventh).toEqual({
      ok: false,
      cause: "budget",
      reason: "block 1's shared prefix allowance is exhausted: 10 of 10 admitted attempts",
    })
    expect(await lines(root)).toHaveLength(written.length)
    expect(journal.bill().refused).toHaveLength(1)
    await journal.close()
  })

  test("an attempt in flight counts at once, so the threshold refuses before it settles", async () => {
    const root = await tempDir()
    await seeded(root, 9)
    const journal = await attemptJournal(root)
    const admission = journal.admission({ block: 1, phase: "prefix", runId: () => "run-a" })
    expect((await admission.admit(discover())).ok).toBe(true)
    expect((await admission.admit(discover("discovery-2"))).ok).toBe(false)
    expect(journal.bill().halt).toBeNull()
    await journal.close()
  })

  test("admitted then not issued: an `issued` + `not-issued` pair, counted 0, no stop, and not an abandoned attempt", async () => {
    const root = await tempDir()
    await seeded(root, 9)
    const journal = await attemptJournal(root)
    const admission = journal.admission({ block: 1, phase: "prefix", runId: () => "run-a" })
    const cancelled = await admission.admit(discover())
    if (!cancelled.ok) throw new Error("refused")
    await cancelled.settle({ kind: "not-issued" })
    expect((await lines(root)).slice(-2)).toEqual([
      expect.objectContaining({ type: "issued", physicalId: "request-1", mode: "attempts" }),
      { type: "settled", physicalId: "request-1", settlement: { kind: "not-issued" } },
    ])
    const bill = journal.bill()
    expect(bill.byPhase.find((phase) => phase.phase === "prefix")!.requests).toBe(9)
    expect(bill.halt).toBeNull()
    expect(bill.stop).toBeNull()
    expect(bill.requests.find((request) => request.physicalId === "request-1")).toMatchObject({ state: "not-issued" })
    expect(bill.requests.find((request) => request.physicalId === "request-1")!.abandoned).toBeUndefined()
    // It counted 0, so the tenth attempt is still admitted.
    expect((await admission.admit(discover("discovery-2"))).ok).toBe(true)
    await journal.close()
  })

  test("an unknown settlement is a diagnostic: no halt, and the next attempt is admitted", async () => {
    const root = await tempDir()
    const journal = await attemptJournal(root)
    const admission = journal.admission({ block: 1, phase: "prefix", runId: () => "run-a" })
    const first = await admission.admit(discover())
    if (!first.ok) throw new Error("refused")
    await first.settle({ kind: "unknown", why: "the host reported nothing", executionId: "exec-1" })
    const bill = journal.bill()
    expect(bill.halt).toBeNull()
    expect(bill.unknown).toHaveLength(1)
    expect(bill.mode).toBe("attempts")
    expect(existsSync(join(root, HALT_MARKER_FILE))).toBe(false)
    expect((await admission.admit(discover("discovery-2"))).ok).toBe(true)
    await journal.close()
  })

  test("an abandoned attempt latches an operational stop, worded apart from spend, and nothing more is admitted", async () => {
    const root = await tempDir()
    const journal = await attemptJournal(root)
    const admission = journal.admission({ block: 1, phase: "on", runId: () => "run-a" })
    const held = await admission.admit({ stage: "debate", slot: "discovery-1", attempt: 1 })
    if (!held.ok) throw new Error("refused")
    await held.settle({ kind: "unknown", why: "timed out", executionId: "exec-1", abandoned: true })
    expect((await lines(root)).at(-1)).toEqual({
      type: "settled",
      physicalId: "request-1",
      settlement: { kind: "unknown", why: "timed out", executionId: "exec-1", abandoned: true },
    })
    const bill = journal.bill()
    expect(bill.halt).toStartWith(ATTEMPT_MODE_STOP_PREFIX)
    expect(bill.halt).toContain("did not end within its bound")
    expect(bill.halt).not.toContain("UNKNOWN amount")
    const next = await admission.admit({ stage: "debate", slot: "discovery-2", attempt: 1 })
    expect(next).toMatchObject({ ok: false, cause: "halted" })
    if (!next.ok) {
      expect(next.reason).not.toContain("Token exposure")
      expect(next.reason).toContain("does not resume automatically")
    }
    await journal.settled()
    expect(JSON.parse(await readFile(join(root, HALT_MARKER_FILE), "utf8"))).toMatchObject({ accounting: "attempts", haltReason: bill.halt })
    await journal.close()
  })

  test("the abandoned stop survives reopening", async () => {
    const root = await tempDir()
    const journal = await attemptJournal(root)
    const held = await journal.admission({ block: 1, phase: "prefix", runId: () => "run-a" }).admit(discover())
    if (!held.ok) throw new Error("refused")
    await held.settle({ kind: "unknown", why: "timed out", abandoned: true })
    await journal.close()
    await unlink(join(root, HALT_MARKER_FILE))
    const reopened = await attemptJournal(root)
    expect(reopened.bill().halt).toContain("did not end within its bound")
    await reopened.close()
  })

  test("an attempt in flight at reopen is uncertain, worded operationally, and stops the run", async () => {
    const root = await tempDir()
    const journal = await attemptJournal(root)
    expect((await journal.admission({ block: 1, phase: "prefix", runId: () => "run-a" }).admit(discover())).ok).toBe(true)
    await journal.close()
    const reopened = await attemptJournal(root)
    const bill = reopened.bill()
    expect(bill.uncertain).toHaveLength(1)
    expect(bill.halt).toStartWith(ATTEMPT_MODE_STOP_PREFIX)
    expect(bill.halt).toContain("whether it ended is not established")
    expect(bill.halt).not.toContain("unquantified")
    expect((await reopened.admission({ block: 1, phase: "prefix", runId: () => "run-b" }).admit(discover())).ok).toBe(false)
    await reopened.close()
  })

  test("a mixed journal refuses to open, and so does a journal opened in the other mode", async () => {
    const mixed = await tempDir()
    await seeded(mixed, 1)
    await appendFile(
      join(mixed, JOURNAL_FILE),
      `${JSON.stringify({ type: "issued", physicalId: "t-1", category: "blocks", block: 1, phase: "prefix", stage: "discover", slot: "s", attempt: 1, runId: "r" })}\n`,
    )
    for (const mode of ["attempts", "tokens"] as const) {
      const lock = await acquireLock(mixed, now())
      if (!lock.ok) throw new Error(lock.reason)
      const outcome = await openJournal(mixed, lock.lock, now, undefined, mode)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.reason).toContain("integrity failure")
      if (!outcome.ok) expect(outcome.reason).toContain("mixes accounting modes")
      await lock.lock.release()
    }

    const attempts = await tempDir()
    await seeded(attempts, 1)
    const lock = await acquireLock(attempts, now())
    if (!lock.ok) throw new Error(lock.reason)
    const asTokens = await openJournal(attempts, lock.lock, now)
    expect(asTokens.ok).toBe(false)
    if (!asTokens.ok) expect(asTokens.reason).toContain("records attempts, and it was opened in tokens mode")
    await lock.lock.release()

    const tokens = await tempDir()
    const journal = await opened(tokens)
    const decision = await journal.admission({ block: 1, phase: "prefix", runId: () => "run" }).admit(discover())
    if (decision.ok) await decision.settle({ kind: "usage", tokens: usage(1) })
    await journal.close()
    const again = await acquireLock(tokens, now())
    if (!again.ok) throw new Error(again.reason)
    const asAttempts = await openJournal(tokens, again.lock, now, undefined, "attempts")
    expect(asAttempts.ok).toBe(false)
    if (!asAttempts.ok) expect(asAttempts.reason).toContain("records tokens, and it was opened in attempts mode")
    await again.lock.release()
  })

  test("token mode ignores `abandoned`: the line is written as before, and the unknown still halts", async () => {
    const root = await tempDir()
    const journal = await opened(root)
    const decision = await journal.admission({ block: 1, phase: "prefix", runId: () => "run" }).admit(discover())
    if (!decision.ok) throw new Error("refused")
    await decision.settle({ kind: "unknown", why: "timed out", executionId: "exec-1", abandoned: true })
    const written = await lines(root)
    expect(written[0]).not.toHaveProperty("mode")
    expect(written[1]).toEqual({ type: "settled", physicalId: "request-1", settlement: { kind: "unknown", why: "timed out", executionId: "exec-1" } })
    expect(journal.bill().halt).toContain("billed an UNKNOWN amount")
    expect(journal.bill().mode).toBeUndefined()
    await journal.close()
  })

  test("a step is refused in attempt mode, and it stops the runner", async () => {
    const root = await tempDir()
    const journal = await attemptJournal(root)
    const decision = await journal.admission({ block: 1, phase: "prefix", runId: () => "run" }).admit(discover())
    if (!decision.ok || decision.turn === undefined) throw new Error("expected a turn handle")
    const step = await decision.turn.admitStep()
    expect(step).toMatchObject({ ok: false, cause: "runner-stop" })
    expect(journal.bill().stop).toContain("admits no steps")
    expect((await lines(root)).filter((line) => line.type === "issued")).toHaveLength(1)
    await decision.settle({ kind: "usage", tokens: usage(1) })
    expect(journal.bill().requests[0]!.state).toBe("usage")
    await journal.close()
  })

  test("a step line in an attempt-mode file refuses to open", async () => {
    const root = await tempDir()
    await appendFile(
      join(root, JOURNAL_FILE),
      `${JSON.stringify({ type: "issued", physicalId: "a", category: "blocks", block: 1, phase: "prefix", stage: "discover", slot: "s", attempt: 1, step: 2, runId: "r", mode: "attempts" })}\n`,
    )
    const lock = await acquireLock(root, now())
    if (!lock.ok) throw new Error(lock.reason)
    const outcome = await openJournal(root, lock.lock, now, undefined, "attempts")
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain("step line")
    await lock.lock.release()
  })

  test("the overshoot is reported in attempts, per phase and per block, against the v2 thresholds", async () => {
    const root = await tempDir()
    await seeded(root, 11)
    await seeded(root, 46, "on")
    await seeded(root, 45, "off")
    const journal = await attemptJournal(root)
    const overshoot = journal.bill().overshoot
    expect(overshoot.unit).toBe("attempts")
    expect(overshoot.global).toEqual({ limit: 300, spent: 102, overshoot: 0 })
    expect(overshoot.phases).toEqual([
      { block: 1, phase: "prefix", limit: 10, spent: 11, overshoot: 1 },
      { block: 1, phase: "on", limit: 45, spent: 46, overshoot: 1 },
      { block: 1, phase: "off", limit: 45, spent: 45, overshoot: 0 },
    ])
    expect(overshoot.blockTotals).toEqual([{ block: 1, limit: 100, spent: 102, overshoot: 2 }])
    await journal.close()
  })

  test("the Adversarial admission refuses in attempt mode, latches the stop it names, and writes nothing", async () => {
    const root = await tempDir()
    const journal = await attemptJournal(root)
    const decision = await journal.adversarialAdmission({ label: "case-1 clean", runId: () => "run" }).admit(discover())
    expect(decision).toMatchObject({ ok: false, cause: "runner-stop" })
    if (!decision.ok) expect(decision.reason).toContain("has no Adversarial allowance")
    expect(journal.bill().stop).toContain("has no Adversarial allowance")
    expect(existsSync(join(root, JOURNAL_FILE))).toBe(false)
    expect(journal.bill().refusedAdversarial).toHaveLength(1)
    await journal.close()
  })

  test("100 settled attempts in block 1 refuse its next continuation on the block total; block 2 is still admitted", async () => {
    const root = await tempDir()
    await seeded(root, 10)
    await seeded(root, 45, "on")
    await seeded(root, 45, "off")
    const journal = await attemptJournal(root)
    const refused = await journal.admission({ block: 1, phase: "on", runId: () => "run" }).admit({ stage: "debate", slot: "discovery-1", attempt: 1 })
    expect(refused).toEqual({ ok: false, cause: "budget", reason: "block 1's allowance is exhausted: 100 of 100 admitted attempts" })
    expect((await journal.admission({ block: 2, phase: "prefix", runId: () => "run-2" }).admit(discover())).ok).toBe(true)
    await journal.close()
  })

  test("at the global 300 the 301st attempt is refused in attempts", async () => {
    const root = await tempDir()
    const rows: JournalLine[] = []
    for (let index = 0; index < 300; index += 1) {
      rows.push({ type: "issued", physicalId: `cal-${index}`, category: "calibration", block: null, phase: null, stage: "discover", slot: "s", attempt: 1, runId: "cal", mode: "attempts" })
      rows.push({ type: "settled", physicalId: `cal-${index}`, settlement: { kind: "usage", tokens: usage(1) } })
    }
    await appendFile(join(root, JOURNAL_FILE), rows.map((row) => `${JSON.stringify(row)}\n`).join(""))
    const journal = await attemptJournal(root)
    expect(await journal.admission({ block: 1, phase: "prefix", runId: () => "run" }).admit(discover())).toEqual({
      ok: false,
      cause: "budget",
      reason: "the experiment's global cap is exhausted: 300 of 300 admitted attempts",
    })
    await journal.close()
  })

  test("a token-mode file carrying an `abandoned` settlement refuses to open", async () => {
    const root = await tempDir()
    await appendFile(
      join(root, JOURNAL_FILE),
      [
        { type: "issued", physicalId: "a", category: "blocks", block: 1, phase: "prefix", stage: "discover", slot: "s", attempt: 1, runId: "r" },
        { type: "settled", physicalId: "a", settlement: { kind: "unknown", why: "timed out", abandoned: true } },
      ]
        .map((row) => `${JSON.stringify(row)}\n`)
        .join(""),
    )
    const lock = await acquireLock(root, now())
    if (!lock.ok) throw new Error(lock.reason)
    const outcome = await openJournal(root, lock.lock, now)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain("carries `abandoned`, which a token-mode journal never holds")
    await lock.lock.release()
  })

  test("a settlement after close is persisted by flush, which replays the file in attempt mode", async () => {
    const root = await tempDir()
    const journal = await attemptJournal(root)
    const decision = await journal.admission({ block: 1, phase: "prefix", runId: () => "run" }).admit(discover())
    if (!decision.ok) throw new Error("refused")
    const { handle } = await journal.close()
    await decision.settle({ kind: "unknown", why: "the host reported nothing" })
    const flushed = await handle.flush()
    expect(flushed).toMatchObject({ ok: true, persisted: 1 })
    expect((await lines(root)).at(-1)).toEqual({ type: "settled", physicalId: "request-1", settlement: { kind: "unknown", why: "the host reported nothing" } })
  })
})
