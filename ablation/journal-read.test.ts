/**
 * Story 2-8c3a — the persisted-journal reader replays and validates the whole
 * file, and refuses rather than tallies a journal that is not a finished bill.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { emptyTokenUsage } from "../core/domain/run-record.ts"
import { JOURNAL_FILE, type JournalLine } from "./journal.ts"
import { ATTEMPT_ALLOWANCES } from "./governor.ts"
import { readPairedAttemptJournal, readPersistedJournal } from "./journal-read.ts"
import type { PairedSchedule } from "./schedule.ts"

const scratch: string[] = []

async function rootWith(lines: readonly JournalLine[] | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-journal-read-"))
  scratch.push(dir)
  if (lines !== null) await writeFile(join(dir, JOURNAL_FILE), lines.map((line) => `${JSON.stringify(line)}\n`).join(""))
  return dir
}

afterEach(async () => {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})

const issued = (id: string, over: Partial<Extract<JournalLine, { type: "issued" }>> = {}): JournalLine => ({
  type: "issued",
  physicalId: id,
  category: "blocks",
  block: 1,
  phase: "on",
  stage: "debate",
  slot: "discovery-1",
  attempt: 1,
  runId: "run-on",
  mode: "attempts",
  ...over,
})
const usage = (id: string, input = 1): JournalLine => ({ type: "settled", physicalId: id, settlement: { kind: "usage", tokens: { ...emptyTokenUsage(), input } } })

describe("readPersistedJournal", () => {
  test("a finished attempt-mode journal reads with its mode and its bill", async () => {
    const root = await rootWith([
      issued("a"),
      usage("a"),
      issued("b", { attempt: 2 }),
      { type: "settled", physicalId: "b", settlement: { kind: "unknown", why: "none", abandoned: true } },
      issued("c"),
      { type: "settled", physicalId: "c", settlement: { kind: "not-issued" } },
    ])
    const read = await readPersistedJournal(root, "attempts")
    if (!read.ok) throw new Error(read.reason)
    expect(read.mode).toBe("attempts")
    expect(read.bill.requests.filter((request) => request.state !== "not-issued")).toHaveLength(2)
    expect(read.bill.byPhase[0]!.requests).toBe(2)
  })

  test("a token-mode journal reads as tokens", async () => {
    const root = await rootWith([issued("a", { mode: undefined }), usage("a")])
    const read = await readPersistedJournal(root)
    expect(read.ok && read.mode).toBe("tokens")
  })

  test("an absent journal refuses", async () => {
    const read = await readPersistedJournal(await rootWith(null))
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.reason).toContain("does not exist")
  })

  test("an incomplete journal refuses: an attempt issued and never settled is not counted as final", async () => {
    const read = await readPersistedJournal(await rootWith([issued("a"), usage("a"), issued("b")]))
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.reason).toContain("is incomplete: 1 request(s) were issued and never settled")
  })

  test("a conflicted journal refuses", async () => {
    const read = await readPersistedJournal(await rootWith([issued("a"), usage("a", 1), usage("a", 2)]))
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.reason).toContain("integrity failure")
  })

  test("a mixed-mode journal refuses, and so does one recording another mode than expected", async () => {
    const mixed = await readPersistedJournal(await rootWith([issued("a"), usage("a"), issued("b", { mode: undefined }), usage("b")]))
    expect(mixed.ok).toBe(false)
    if (!mixed.ok) expect(mixed.reason).toContain("mixes accounting modes")
    const other = await readPersistedJournal(await rootWith([issued("a", { mode: undefined }), usage("a")]), "attempts")
    expect(other.ok).toBe(false)
    if (!other.ok) expect(other.reason).toContain("records tokens")
  })

  test("an unreadable journal, not a missing one, refuses", async () => {
    const root = await rootWith(null)
    await mkdir(join(root, JOURNAL_FILE))
    const read = await readPersistedJournal(root, "attempts")
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.reason).toContain("could not be read")
  })

  test("with attempts expected, an existing journal with no issued line reads as attempts with zero counts", async () => {
    const read = await readPersistedJournal(await rootWith([]), "attempts")
    if (!read.ok) throw new Error(read.reason)
    expect(read.mode).toBe("attempts")
    expect(read.bill.requests).toEqual([])
    expect(read.bill.mode).toBe("attempts")
  })

  test("a line that does not validate refuses", async () => {
    const root = await rootWith([issued("a")])
    await writeFile(join(root, JOURNAL_FILE), `${JSON.stringify(issued("a"))}\n{"type":"settled"`)
    const read = await readPersistedJournal(root)
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.reason).toContain("line 2")
  })

  test("a journal whose lines declare the adversarial suite's scope is refused; a paired journal with no scope reads", async () => {
    const suite = (id: string): JournalLine => issued(id, { category: "adversarial", block: null, phase: null, scope: "adversarial" })
    const refused = await readPersistedJournal(await rootWith([suite("a"), usage("a")]), "attempts")
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toContain("records the adversarial scope, and it was opened in the paired scope")
    // With no expected mode either: the scope is pinned whatever the mode.
    expect((await readPersistedJournal(await rootWith([suite("a"), usage("a")]))).ok).toBe(false)

    const paired = await readPersistedJournal(await rootWith([issued("a"), usage("a")]), "attempts")
    if (!paired.ok) throw new Error(paired.reason)
    expect(paired.mode).toBe("attempts")
    expect(paired.bill.scope).toBeUndefined()
    expect(paired.bill.overshoot.global.limit).toBe(300)
  })
})

describe("readPairedAttemptJournal", () => {
  /** A schedule read whose only field this reader looks at is `config`. */
  const scheduleWith = (config: Record<string, unknown>) => ({ ok: true as const, file: "s", schedule: { config } as unknown as PairedSchedule })
  const lines = Array.from({ length: 7 }, (_unused, index) => [issued(`p${index}`, { phase: "prefix" }), usage(`p${index}`)]).flat()

  test("the journal is read against the sealed allowances", async () => {
    const read = await readPairedAttemptJournal(await rootWith(lines), scheduleWith({ accounting: "attempts", attemptAllowances: { ...ATTEMPT_ALLOWANCES, prefix: 5 } }))
    if (!read.ok) throw new Error(read.reason)
    expect(read.bill.overshoot.phases).toEqual([{ block: 1, phase: "prefix", limit: 5, spent: 7, overshoot: 2 }])
  })

  test("missing or malformed sealed allowances refuse, naming the field, and the constants are never used", async () => {
    const variants: [unknown, string][] = [
      [undefined, "the sealed `config.attemptAllowances` is absent"],
      [{ ...ATTEMPT_ALLOWANCES, prefix: 1.5 }, "`config.attemptAllowances.prefix` is 1.5, not a positive integer"],
      [{ ...ATTEMPT_ALLOWANCES, global: 0 }, "`config.attemptAllowances.global` is 0, not a positive integer"],
      [{ global: 300, blocks: 300, block: 100, continuation: 45 }, "the sealed `config.attemptAllowances.prefix` is absent"],
      [{ ...ATTEMPT_ALLOWANCES, suite: 480 }, "carries `suite`, which it never holds"],
      [{ ...ATTEMPT_ALLOWANCES, block: 2 ** 53 }, "`config.attemptAllowances.block` is 9007199254740992, not a positive integer"],
      [null, "the sealed `config.attemptAllowances` is null, not an object"],
    ]
    for (const [allowances, why] of variants) {
      const config = allowances === undefined ? { accounting: "attempts" } : { accounting: "attempts", attemptAllowances: allowances }
      const read = await readPairedAttemptJournal(await rootWith(lines), scheduleWith(config))
      expect(read.ok, why).toBe(false)
      if (!read.ok) {
        expect(read.reason, why).toStartWith("the attempt thresholds are unavailable: the sealed `config.attemptAllowances")
        expect(read.reason, why).toContain(why)
      }
    }
  })

  test("a refused schedule refuses the journal, citing the schedule", async () => {
    const read = await readPairedAttemptJournal(await rootWith(lines), { ok: false, reason: "it does not match its own scheduleHash" })
    expect(read.ok).toBe(false)
    if (!read.ok) {
      expect(read.reason).toBe(
        "the attempt thresholds are unavailable: the sealed schedule is refused, so its attempt allowances cannot be read: it does not match its own scheduleHash",
      )
    }
  })
})
