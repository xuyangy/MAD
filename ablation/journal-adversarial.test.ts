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
import { HALT_MARKER_FILE } from "./governor.ts"
import { acquireLock, JOURNAL_FILE, openJournal, type JournalIo, type PairedJournal } from "./journal.ts"
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
