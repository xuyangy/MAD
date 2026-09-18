/**
 * Story 2-7b — the sealed sixteen-slot schedule: the §5 coin rule, publish-once,
 * and verification against the runner's inputs.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { ADVERSARIAL_ASSERTIONS } from "../fixtures/adversarial/assertions.ts"
import { ADVERSARIAL_CASES } from "../fixtures/adversarial/material.ts"
import { ADVERSARIAL_SEAL } from "../fixtures/adversarial/seal.ts"
import { experimentRoot, oneSlotRoster, PROTOCOL_FILE, SCRIPTED_CONFIG } from "./adversarial-read.fixture.ts"
import {
  ADVERSARIAL_SCHEDULE_FILE,
  adversarialDirectory,
  adversarialSlots,
  createAdversarialSchedule,
  firstSidesFor,
  hasAdversarialSchedule,
  readAdversarialSchedule,
  verifyAdversarialSchedule,
} from "./adversarial-schedule.ts"
import { known } from "./manifest.ts"
import { selectRoster } from "../core/roster/select.ts"
import { candidate } from "../core/test-support/fakes.ts"
import type { CoinFace } from "./schedule.ts"

const twoSlotRoster = () =>
  selectRoster([candidate("anthropic", "claude-sonnet-4-5"), candidate("openai", "gpt-5")], { slots: 2, providerConfigKey: "provider" }).roster

const scratch: string[] = []
afterEach(async () => {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})

const CASE_IDS = ADVERSARIAL_CASES.map((c) => c.id)

function input(root: string, coins: CoinFace[] = ["heads", "heads", "tails", "tails"]) {
  const queue = [...coins]
  return {
    experimentRoot: root,
    protocolFile: PROTOCOL_FILE,
    codeRevision: known({ commit: "abc123", dirty: false }),
    roster: oneSlotRoster().roster,
    config: SCRIPTED_CONFIG,
    createdAt: "2026-09-18T00:00:00.000Z",
    coin: () => queue.shift()!,
  }
}

const binding = (root: string) => ({
  protocolFile: PROTOCOL_FILE,
  codeRevision: known({ commit: "abc123", dirty: false }),
  roster: oneSlotRoster().roster,
  config: SCRIPTED_CONFIG,
  seal: ADVERSARIAL_SEAL,
  caseIds: CASE_IDS,
  root,
})

describe("the §5 schedule rule", () => {
  test("each coin gives its pair of cases opposite side orders, so four are clean-first and four attack-first", () => {
    for (const coins of [
      ["heads", "heads", "heads", "heads"],
      ["tails", "tails", "tails", "tails"],
      ["heads", "tails", "tails", "heads"],
    ] as CoinFace[][]) {
      const sides = firstSidesFor(coins, 8)
      expect(sides.filter((side) => side === "clean")).toHaveLength(4)
      for (let pair = 0; pair < 4; pair += 1) expect(sides[pair * 2]).not.toBe(sides[pair * 2 + 1])
      expect(sides[0]).toBe(coins[0] === "heads" ? "clean" : "attack")
    }
  })

  test("cases run in manifest order, each case's two sides back to back", () => {
    const slots = adversarialSlots(CASE_IDS, ["heads", "tails", "heads", "tails"])
    expect(slots.map((slot) => slot.position)).toEqual(Array.from({ length: 16 }, (_, index) => index + 1))
    expect(slots.map((slot) => slot.caseId)).toEqual(CASE_IDS.flatMap((id) => [id, id]))
    expect(slots.slice(0, 4).map((slot) => `${slot.side}:${slot.order}`)).toEqual([
      "clean:first",
      "attack:second",
      "attack:first",
      "clean:second",
    ])
  })
})

describe("createAdversarialSchedule", () => {
  test("publishes under <root>/adversarial, bound to the seal, the protocol and a 25,000 run cap", async () => {
    const root = await experimentRoot(scratch)
    const created = await createAdversarialSchedule(input(root))
    if (!created.ok) throw new Error(created.reason)
    expect(created.file).toBe(join(adversarialDirectory(root), ADVERSARIAL_SCHEDULE_FILE))
    expect(created.schedule.coins).toEqual(["heads", "heads", "tails", "tails"])
    expect(created.schedule.cases).toEqual({ ...ADVERSARIAL_SEAL, caseIds: CASE_IDS })
    expect(created.schedule.config.tokenCap).toBe(25_000)
    expect(created.schedule.slots).toHaveLength(16)
    expect(await hasAdversarialSchedule(root)).toBe(true)
    expect((await readAdversarialSchedule(root)).ok).toBe(true)
    expect((await verifyAdversarialSchedule(root, binding(root))).ok).toBe(true)
  })

  test("a second schedule is refused by file name, and the first stays untouched", async () => {
    const root = await experimentRoot(scratch)
    const created = await createAdversarialSchedule(input(root))
    if (!created.ok) throw new Error(created.reason)
    const before = await readFile(created.file, "utf8")
    const again = await createAdversarialSchedule(input(root, ["tails", "tails", "tails", "tails"]))
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.reason).toContain(created.file)
    expect(await readFile(created.file, "utf8")).toBe(before)
  })

  test("a drifted case, a wider roster or a blank tools identity is refused before any coin is tossed", async () => {
    const root = await experimentRoot(scratch)
    let tossed = 0
    const counting = { ...input(root), coin: () => ((tossed += 1), "heads" as const) }
    const drifted = ADVERSARIAL_CASES.map((c, index) => (index === 0 ? { ...c, payload: `${c.payload} ` } : c))
    const refusals = [
      await createAdversarialSchedule({ ...counting, cases: drifted }),
      await createAdversarialSchedule({ ...counting, assertions: ADVERSARIAL_ASSERTIONS.slice(1) }),
      await createAdversarialSchedule({ ...counting, config: { ...SCRIPTED_CONFIG, tools: " " } }),
      await createAdversarialSchedule({ ...counting, roster: twoSlotRoster() }),
      await createAdversarialSchedule({ ...counting, config: { ...SCRIPTED_CONFIG, maxConcurrency: 2 } }),
    ]
    for (const refusal of refusals) expect(refusal.ok).toBe(false)
    const wider = refusals[3]!
    if (!wider.ok) expect(wider.reason).toContain("ONE-SLOT roster")
    const first = refusals[0]!
    if (!first.ok) expect(first.reason).toContain(ADVERSARIAL_SEAL.materialHash)
    expect(tossed).toBe(0)
    expect(await hasAdversarialSchedule(root)).toBe(false)
  })

  test("verification refuses a different roster, config or code revision, and an edited file", async () => {
    const root = await experimentRoot(scratch)
    const created = await createAdversarialSchedule(input(root))
    if (!created.ok) throw new Error(created.reason)
    expect((await verifyAdversarialSchedule(root, { ...binding(root), codeRevision: known({ commit: "def", dirty: false }) })).ok).toBe(false)
    const otherModel = selectRoster([candidate("openai", "gpt-5")], { slots: 1, providerConfigKey: "provider" }).roster
    const roster = await verifyAdversarialSchedule(root, { ...binding(root), roster: otherModel })
    expect(roster.ok).toBe(false)
    if (!roster.ok) expect(roster.reason).toContain("different roster or models")
    expect((await verifyAdversarialSchedule(root, { ...binding(root), config: { ...SCRIPTED_CONFIG, maxConcurrency: 3 } })).ok).toBe(false)
    const edited = JSON.parse(await readFile(created.file, "utf8"))
    edited.coins[0] = edited.coins[0] === "heads" ? "tails" : "heads"
    await writeFile(created.file, JSON.stringify(edited))
    const read = await readAdversarialSchedule(root)
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.reason).toContain("scheduleHash")
  })
})
