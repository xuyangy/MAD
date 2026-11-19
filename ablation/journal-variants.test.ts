/**
 * The debate-variants journal scope: the durable scope mark on every issued
 * line, refusal of the other scope's phases and of mixed or foreign files on
 * open, replay, reopen and flush, and one copy of the sealed limits for both
 * admission and the overshoot report.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { TokenUsage } from "../core/domain/run-record.ts"
import { emptyTokenUsage } from "../core/domain/run-record.ts"
import { PAIRED_ALLOWANCES, VARIANT_ALLOWANCES, type VariantAllowances } from "./governor.ts"
import {
  acquireLock,
  JOURNAL_FILE,
  openJournal,
  replayPersistedJournal,
  type AdmissionBinding,
  type JournalScope,
  type PairedJournal,
} from "./journal.ts"

const scratch: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-journal-variants-"))
  scratch.push(dir)
  return dir
}
afterEach(async () => {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})

const now = () => "2026-11-19T00:00:00.000Z"
const usage = (input: number): TokenUsage => ({ ...emptyTokenUsage(), input })
const discover = (slot = "discovery-1", attempt = 1) => ({ stage: "discover" as const, slot, attempt })

async function open(root: string, scope: JournalScope = "debate-variants", allowances?: VariantAllowances) {
  const lock = await acquireLock(root, now())
  if (!lock.ok) throw new Error(lock.reason)
  const opened = await openJournal(root, lock.lock, now, undefined, "tokens", scope, allowances)
  if (!opened.ok) await lock.lock.release()
  return opened
}

async function variantJournal(root: string, allowances?: VariantAllowances): Promise<PairedJournal> {
  const opened = await open(root, "debate-variants", allowances)
  if (!opened.ok) throw new Error(opened.reason)
  return opened.journal
}

async function lines(root: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(root, JOURNAL_FILE), "utf8")
  return text.split("\n").filter((row) => row.length > 0).map((row) => JSON.parse(row) as Record<string, unknown>)
}

/** Admit one request in `binding` and settle it with `tokens`. */
async function spend(journal: PairedJournal, binding: Omit<AdmissionBinding, "runId">, tokens: number, slot = "discovery-1") {
  const decision = await journal.admission({ ...binding, runId: () => `run-${binding.block}-${binding.phase}` }).admit(discover(slot))
  if (!decision.ok) throw new Error(decision.reason)
  await decision.settle({ kind: "usage", tokens: usage(tokens) })
}

describe("the scope mark", () => {
  test("every issued line of a debate-variants journal, prefix included, carries it; a paired line carries none", async () => {
    const root = await tempDir()
    const journal = await variantJournal(root)
    await spend(journal, { block: 1, phase: "prefix" }, 10)
    await spend(journal, { block: 1, phase: "references" }, 20)
    await journal.close()
    const issued = (await lines(root)).filter((line) => line.type === "issued")
    expect(issued.map((line) => [line.phase, line.scope])).toEqual([
      ["prefix", "debate-variants"],
      ["references", "debate-variants"],
    ])

    const paired = await tempDir()
    const opened = await open(paired, "paired")
    if (!opened.ok) throw new Error(opened.reason)
    await spend(opened.journal, { block: 1, phase: "prefix" }, 10)
    await opened.journal.close()
    expect((await lines(paired))[0]).toEqual({
      type: "issued",
      physicalId: "request-1",
      category: "blocks",
      block: 1,
      phase: "prefix",
      stage: "discover",
      slot: "discovery-1",
      attempt: 1,
      runId: "run-1-prefix",
    })
  })
})

describe("admission", () => {
  test("a phase of the other design is refused as a runner stop, recorded, and nothing is appended", async () => {
    for (const [scope, phase] of [
      ["debate-variants", "on"],
      ["debate-variants", "off"],
      ["paired", "baseline"],
      ["paired", "open-questions"],
    ] as const) {
      const root = await tempDir()
      const opened = await open(root, scope)
      if (!opened.ok) throw new Error(opened.reason)
      const decision = await opened.journal.admission({ block: 1, phase, runId: () => "r" }).admit(discover())
      expect(decision).toMatchObject({ ok: false, cause: "runner-stop" })
      const bill = opened.journal.bill()
      expect(bill.stop).toContain(`phase "${phase}"`)
      expect(bill.refused).toHaveLength(1)
      expect(bill.requests).toHaveLength(0)
      await opened.journal.close()
      await expect(readFile(join(root, JOURNAL_FILE))).rejects.toThrow()
    }
  })

  test("Adversarial admission is refused before anything is appended", async () => {
    const root = await tempDir()
    const journal = await variantJournal(root)
    const decision = await journal.adversarialAdmission({ label: "case clean", runId: () => "r" }).admit(discover())
    expect(decision).toMatchObject({ ok: false, cause: "runner-stop" })
    expect(journal.bill().stop).toContain("debate-variants journal, which has no Adversarial allowance")
    await journal.close()
    await expect(readFile(join(root, JOURNAL_FILE))).rejects.toThrow()
  })

  test("each arm's continuation is gated at the continuation limit, and per-phase spend is kept apart", async () => {
    const root = await tempDir()
    const journal = await variantJournal(root)
    await spend(journal, { block: 1, phase: "prefix" }, 1_000)
    await spend(journal, { block: 1, phase: "baseline" }, 195_000)
    await spend(journal, { block: 1, phase: "references" }, 100)
    const refused = await journal.admission({ block: 1, phase: "baseline", runId: () => "r" }).admit(discover("discovery-2"))
    expect(refused).toMatchObject({
      ok: false,
      cause: "budget",
      reason: "block 1's baseline continuation allowance is exhausted: 195000 of 195000 newly executed tokens",
    })
    expect((await journal.admission({ block: 1, phase: "references", runId: () => "r" }).admit(discover("discovery-2"))).ok).toBe(true)
    const bill = journal.bill()
    const spent = Object.fromEntries(bill.byPhase.map((phase) => [phase.phase, phase.tokens.input]))
    expect(spent).toEqual({ prefix: 1_000, baseline: 195_000, references: 100 })
    expect(bill.scope).toBe("debate-variants")
    await journal.close()
  })

  test("the open-questions arm is admitted on a fresh block", async () => {
    const root = await tempDir()
    const journal = await variantJournal(root)
    await spend(journal, { block: 3, phase: "open-questions" }, 5)
    expect(journal.bill().byPhase.map((phase) => phase.phase)).toEqual(["open-questions"])
    await journal.close()
  })
})

describe("one copy of the limits for admission and the overshoot report", () => {
  test("default: VARIANT_ALLOWANCES in the report, and Blocks spend past the routing limit is still admitted", async () => {
    const root = await tempDir()
    const journal = await variantJournal(root)
    // Spread over phases so no phase limit refuses first.
    const phases = ["baseline", "references", "open-questions"] as const
    for (const [index, phase] of phases.entries()) {
      for (const block of [1, 2, 3]) await spend(journal, { block, phase }, 190_000, `s-${index}-${block}`)
    }
    const bill = journal.bill()
    expect(bill.overshoot.blocks).toEqual({ limit: VARIANT_ALLOWANCES.blocks, spent: 1_710_000, overshoot: 0 })
    expect(bill.overshoot.global.limit).toBe(VARIANT_ALLOWANCES.global)
    expect(bill.overshoot.phases.every((row) => row.limit === VARIANT_ALLOWANCES.continuation)).toBe(true)
    // Past the routing Blocks limit (1,400,000), the variant Blocks limit still admits.
    expect((await journal.admission({ block: 1, phase: "prefix", runId: () => "r" }).admit(discover("x"))).ok).toBe(true)
    await journal.close()
  })

  test("sealed limits given at open are the ones both the gate and the report use", async () => {
    const root = await tempDir()
    const sealed: VariantAllowances = { ...VARIANT_ALLOWANCES, continuation: 1_000 }
    const journal = await variantJournal(root, sealed)
    await spend(journal, { block: 1, phase: "references" }, 1_500)
    const refused = await journal.admission({ block: 1, phase: "references", runId: () => "r" }).admit(discover("discovery-2"))
    expect(refused).toMatchObject({ ok: false, cause: "budget", reason: expect.stringContaining("1500 of 1000") })
    expect(journal.bill().overshoot.phases).toEqual([{ block: 1, phase: "references", limit: 1_000, spent: 1_500, overshoot: 500 }])
    await journal.close()
  })

  test("the journal keeps its own copy: changing the caller's object after open changes neither gate, report nor reconciliation", async () => {
    const root = await tempDir()
    const given = { ...VARIANT_ALLOWANCES, continuation: 1_000 }
    const journal = await variantJournal(root, given)
    const reporter = journal.reporter()
    given.continuation = 1_000_000
    ;(given as { global: number }).global = 1
    await spend(journal, { block: 1, phase: "baseline" }, 1_000)
    const refused = await journal.admission({ block: 1, phase: "baseline", runId: () => "r" }).admit(discover("discovery-2"))
    expect(refused).toMatchObject({ ok: false, cause: "budget", reason: expect.stringContaining("1000 of 1000") })
    const decision = await journal.admission({ block: 1, phase: "references", runId: () => "r" }).admit(discover("discovery-3"))
    if (!decision.ok) throw new Error(decision.reason)
    await decision.settle({ kind: "unknown", why: "abandoned", executionId: "exec-1" })
    expect(journal.bill().overshoot.global.limit).toBe(VARIANT_ALLOWANCES.global)
    const { handle } = await journal.close()
    given.continuation = 5
    reporter.report({ executionId: "exec-1", tokens: usage(2_000) })
    expect(await handle.flush()).toMatchObject({ ok: true, persisted: 1 })
    const bill = handle.bill()
    expect(bill.overshoot.phases.find((row) => row.phase === "references")).toEqual({
      block: 1,
      phase: "references",
      limit: 1_000,
      spent: 2_000,
      overshoot: 1_000,
    })
    expect(bill.overshoot.global.limit).toBe(VARIANT_ALLOWANCES.global)
  })

  test("a binding changed while its admission waits is not read again: check, gate, line and refusal use the first read", async () => {
    const root = await tempDir()
    const journal = await variantJournal(root)
    await spend(journal, { block: 1, phase: "baseline" }, 195_000)
    // Exhausted: block 1 baseline. Fresh: block 2 references.
    const binding: AdmissionBinding = { block: 1, phase: "baseline", runId: () => "r" }
    const admission = journal.admission(binding)
    // Queue behind an admission still in the queue, then move the binding.
    const ahead = journal.admission({ block: 3, phase: "prefix", runId: () => "q" }).admit(discover("q"))
    const asked = admission.admit(discover("discovery-2"))
    binding.block = 2
    binding.phase = "references"
    await ahead
    expect(await asked).toMatchObject({ ok: false, cause: "budget", reason: expect.stringContaining("block 1's baseline") })
    expect(journal.bill().refused.at(-1)).toMatchObject({ block: 1, phase: "baseline" })
    // An admitted request is journaled where it was asked for.
    const moving: AdmissionBinding = { block: 2, phase: "references", runId: () => "r" }
    const admitted = journal.admission(moving).admit(discover("discovery-3"))
    moving.phase = "open-questions"
    expect((await admitted).ok).toBe(true)
    await journal.close()
    expect((await lines(root)).filter((line) => line.type === "issued").at(-1)).toMatchObject({ block: 2, phase: "references" })
  })

  test("an invalid block is refused before anything is appended", async () => {
    for (const block of [0, -1, 1.5, Number.NaN]) {
      const root = await tempDir()
      const journal = await variantJournal(root)
      const decision = await journal.admission({ block, phase: "baseline", runId: () => "r" }).admit(discover())
      expect(decision).toMatchObject({ ok: false, cause: "runner-stop" })
      expect(journal.bill().stop).toContain("a whole block number from 1")
      await journal.close()
      await expect(readFile(join(root, JOURNAL_FILE))).rejects.toThrow()
    }
  })

  test("an unknown scope is refused by the persisted replay whatever the file holds", async () => {
    const root = await tempDir()
    const absent = await replayPersistedJournal(join(root, JOURNAL_FILE), "tokens", "routing" as never)
    expect(!absent.ok && absent.reason).toContain("is neither paired, adversarial nor debate-variants")
    await writeFile(join(root, JOURNAL_FILE), "")
    const empty = await replayPersistedJournal(join(root, JOURNAL_FILE), undefined, "routing" as never)
    expect(empty.ok).toBe(false)
  })

  test("limits of the wrong shape, or given in attempt mode, refuse to open", async () => {
    const root = await tempDir()
    const wrong = await open(root, "debate-variants", { ...PAIRED_ALLOWANCES, extra: 1 } as unknown as VariantAllowances)
    expect(!wrong.ok && wrong.reason).toContain("not the debate-variants scope's")
    const lock = await acquireLock(root, now())
    if (!lock.ok) throw new Error(lock.reason)
    const attempts = await openJournal(root, lock.lock, now, undefined, "attempts", "debate-variants")
    expect(!attempts.ok && attempts.reason).toContain("a debate-variants journal counts tokens")
    await lock.lock.release()
  })

  test("the routing journal's report is unchanged", async () => {
    const root = await tempDir()
    const opened = await open(root, "paired")
    if (!opened.ok) throw new Error(opened.reason)
    await spend(opened.journal, { block: 1, phase: "on" }, 10)
    const overshoot = opened.journal.bill().overshoot
    expect(overshoot.blocks.limit).toBe(PAIRED_ALLOWANCES.blocks)
    expect(overshoot.global.limit).toBe(PAIRED_ALLOWANCES.global)
    expect("scope" in opened.journal.bill()).toBe(false)
    await opened.journal.close()
  })
})

describe("replay, reopen and flush hold the file to its scope", () => {
  async function prefixOnly(root: string) {
    const journal = await variantJournal(root)
    await spend(journal, { block: 1, phase: "prefix" }, 10)
    await journal.close()
  }

  test("a prefix-only debate-variants file reopens in its own scope and refuses the paired one", async () => {
    const root = await tempDir()
    await prefixOnly(root)
    const wrong = await open(root, "paired")
    expect(!wrong.ok && wrong.reason).toContain("records the debate-variants scope, and it was opened in the paired scope")
    const right = await open(root, "debate-variants")
    expect(right.ok).toBe(true)
    if (right.ok) await right.journal.close()
    const read = await replayPersistedJournal(join(root, JOURNAL_FILE), "tokens", "debate-variants")
    expect(read).toMatchObject({ ok: true, scope: "debate-variants" })
    const misread = await replayPersistedJournal(join(root, JOURNAL_FILE), "tokens", "paired")
    expect(misread.ok).toBe(false)
  })

  test("a paired file refuses the debate-variants scope", async () => {
    const root = await tempDir()
    const opened = await open(root, "paired")
    if (!opened.ok) throw new Error(opened.reason)
    await spend(opened.journal, { block: 1, phase: "prefix" }, 10)
    await opened.journal.close()
    const wrong = await open(root, "debate-variants")
    expect(!wrong.ok && wrong.reason).toContain("records the paired scope, and it was opened in the debate-variants scope")
  })

  test("mixed, foreign-phase, foreign-category and unknown-scope files refuse", async () => {
    const issued = (over: Record<string, unknown>) =>
      JSON.stringify({
        type: "issued",
        physicalId: `p-${Math.random().toString(36).slice(2)}`,
        category: "blocks",
        block: 1,
        phase: "prefix",
        stage: "discover",
        slot: "discovery-1",
        attempt: 1,
        runId: "r",
        scope: "debate-variants",
        ...over,
      })
    const cases: [string[], JournalScope | undefined, string][] = [
      [[issued({}), issued({ scope: undefined })], undefined, "mixes scopes"],
      [[issued({ phase: "on" })], "debate-variants", "in phase on, which a debate-variants journal never holds"],
      [[issued({ scope: undefined, phase: "baseline" })], "paired", "in phase baseline, which a paired journal never holds"],
      [[issued({ category: "pilot", block: null, phase: null })], "debate-variants", "is a pilot request, which a debate-variants journal never holds"],
      [[issued({ scope: "routing" })], undefined, "is not a valid journal line"],
      [[issued({ mode: "attempts" })], undefined, "counts tokens, and it is read in attempts mode"],
      [
        [
          issued({ scope: "adversarial", mode: "attempts", category: "adversarial", block: null, phase: null }),
          issued({ scope: undefined, mode: "attempts" }),
        ],
        undefined,
        "mixes scopes (1 issued line(s) declare the adversarial suite and 1 declare none), so it is read in neither",
      ],
      [[issued({}), issued({ scope: "adversarial", mode: undefined, category: "adversarial", block: null, phase: null })], undefined, "issued lines: 1 debate-variants, 1 adversarial"],
    ]
    for (const [rows, scope, reason] of cases) {
      const root = await tempDir()
      await writeFile(join(root, JOURNAL_FILE), `${rows.join("\n")}\n`)
      const read = await replayPersistedJournal(join(root, JOURNAL_FILE), undefined, scope)
      expect(read.ok, reason).toBe(false)
      if (!read.ok) expect(read.reason).toContain(reason)
    }
  })

  test("a post-close flush replays the nonempty debate-variants file in its scope and persists the late report", async () => {
    const root = await tempDir()
    const journal = await variantJournal(root)
    const reporter = journal.reporter()
    const decision = await journal.admission({ block: 2, phase: "open-questions", runId: () => "r" }).admit(discover())
    if (!decision.ok) throw new Error(decision.reason)
    await decision.settle({ kind: "unknown", why: "abandoned", executionId: "exec-1" })
    const { handle } = await journal.close()
    reporter.report({ executionId: "exec-1", tokens: usage(30) })
    expect(await handle.flush()).toMatchObject({ ok: true, persisted: 1, conflicts: [], failed: null })
    const late = (await lines(root)).filter((line) => line.type === "late")
    expect(late).toHaveLength(1)
    const read = await replayPersistedJournal(join(root, JOURNAL_FILE), "tokens", "debate-variants")
    if (!read.ok) throw new Error(read.reason)
    expect(read.bill.known).toEqual(usage(30))
    expect(read.bill.overshoot.phases[0]).toMatchObject({ phase: "open-questions", limit: VARIANT_ALLOWANCES.continuation })
  })

  test("a flush refuses a file that a foreign line made unreadable in this scope", async () => {
    const root = await tempDir()
    const journal = await variantJournal(root)
    const reporter = journal.reporter()
    const decision = await journal.admission({ block: 1, phase: "baseline", runId: () => "r" }).admit(discover())
    if (!decision.ok) throw new Error(decision.reason)
    await decision.settle({ kind: "unknown", why: "abandoned", executionId: "exec-1" })
    const { handle } = await journal.close()
    await appendFile(
      join(root, JOURNAL_FILE),
      `${JSON.stringify({ type: "issued", physicalId: "x", category: "blocks", block: 1, phase: "on", stage: "discover", slot: "s", attempt: 1, runId: "r" })}\n`,
    )
    reporter.report({ executionId: "exec-1", tokens: usage(30) })
    const flushed = await handle.flush()
    expect(flushed.ok).toBe(false)
    expect(flushed.failed).toContain("mixes scopes")
  })
})
