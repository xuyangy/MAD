import { afterEach, describe, expect, test } from "bun:test"
import { appendFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { emptyTokenUsage, type TokenUsage } from "../core/domain/run-record.ts"
import { createLateUsageSink } from "../core/ports/late-usage.ts"
import { acquireLock, JOURNAL_FILE, LOCK_FILE, openJournal, type JournalIo, type JournalLine, type PairedJournal } from "./journal.ts"
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
