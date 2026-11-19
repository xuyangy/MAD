/**
 * The debate-variants design's sealed schedule and allowances
 * (`ablation/DEBATE-VARIANTS.md`): the three-arm order, the seal, the
 * self-check and the binding, the routing entry points' refusal of it, and the
 * design's gate.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { lstat, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { selectRoster } from "../core/roster/select.ts"
import { candidate, fakeChange } from "../core/test-support/fakes.ts"
import { LABELLED_CHANGE_SEAL } from "../fixtures/seeded-defects/seal.ts"
import {
  ATTEMPT_ALLOWANCES,
  PAIRED_ALLOWANCES,
  requestGate,
  VARIANT_ALLOWANCES,
  VARIANT_ATTEMPT_ALLOWANCES,
  variantRequestGate,
  type RequestGateView,
  type VariantPhase,
} from "./governor.ts"
import { known } from "./manifest.ts"
import {
  canonicalJson,
  configDigestOf,
  createSchedule,
  pairedRunConfig,
  readSchedule,
  SCHEDULE_FILE,
  scheduleHashOf,
  sha256,
  verifySchedule,
  type CreateScheduleInput,
  type PairedSchedule,
} from "./schedule.ts"
import {
  createVariantSchedule,
  cryptoVariantDraw,
  plannedVariantSlots,
  readVariantSchedule,
  VARIANT_DRAWS,
  variantOrderFor,
  variantRunConfig,
  variantScheduleHashOf,
  verifyVariantSchedule,
  type CreateVariantScheduleInput,
  type VariantSchedule,
} from "./variant-schedule.ts"
import { VARIANT_ARM_OPTIONS, VARIANT_ARMS, VARIANT_PROTOCOL_ID } from "./variants.ts"

const ROUTING_PROTOCOL = new URL("../_bmad-output/specs/spec-mad-orchestrator/evaluation-protocol.md", import.meta.url).pathname

const scratch: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-variant-schedule-"))
  scratch.push(dir)
  return dir
}
afterEach(async () => {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})

/** A frozen protocol file with this id and version, hashed by `readFrozenProtocol`'s rule. */
async function frozenProtocol(id: string, version = 1): Promise<string> {
  const dir = await tempDir()
  const pending = `---\nid: ${id}\nstatus: frozen\nversion: ${version}\nfrozen_hash: PENDING\n---\n\n# test\n`
  const file = join(dir, `${id}.md`)
  await writeFile(file, pending.replace("frozen_hash: PENDING", `frozen_hash: ${sha256(pending)}`))
  return file
}

const roster = () =>
  selectRoster([candidate("anthropic", "claude-sonnet-4-5"), candidate("openai", "gpt-5")], { slots: 2, providerConfigKey: "provider" })
    .roster

async function inputFor(root: string, over: Partial<CreateVariantScheduleInput> = {}): Promise<CreateVariantScheduleInput> {
  return {
    bundleRoot: root,
    protocolFile: await frozenProtocol(VARIANT_PROTOCOL_ID),
    fixture: LABELLED_CHANGE_SEAL,
    codeRevision: known({ commit: "abc123", dirty: false }),
    roster: roster(),
    change: fakeChange(),
    config: { provenance: "scripted" },
    createdAt: "2026-11-19T00:00:00.000Z",
    draw: () => 7,
    ...over,
  }
}

/** Rewrite the published document with `edit` applied, rehashed so only the edited field can refuse it. */
async function rehashed(root: string, edit: (schedule: VariantSchedule) => void): Promise<void> {
  const file = join(root, SCHEDULE_FILE)
  const schedule = JSON.parse(await readFile(file, "utf8")) as VariantSchedule
  edit(schedule)
  schedule.scheduleHash = variantScheduleHashOf(schedule)
  await writeFile(file, JSON.stringify(schedule))
}

describe("the order", () => {
  test("every draw gives a Latin square: each arm once per block and once per position, and the twelve squares are distinct", () => {
    const squares = new Set<string>()
    for (let draw = 0; draw < VARIANT_DRAWS; draw++) {
      const order = variantOrderFor(draw)
      expect(order).toHaveLength(3)
      for (const row of order) expect([...row].sort()).toEqual([...VARIANT_ARMS].sort())
      for (let position = 0; position < 3; position++) {
        expect(order.map((row) => row[position]).sort()).toEqual([...VARIANT_ARMS].sort())
      }
      squares.add(canonicalJson(order))
    }
    expect(squares.size).toBe(12)
  })

  test("a draw names block 1's order and a direction", () => {
    expect(variantOrderFor(0)).toEqual([
      ["baseline", "references", "open-questions"],
      ["references", "open-questions", "baseline"],
      ["open-questions", "baseline", "references"],
    ])
    expect(variantOrderFor(1)).toEqual([
      ["baseline", "references", "open-questions"],
      ["open-questions", "baseline", "references"],
      ["references", "open-questions", "baseline"],
    ])
    expect(plannedVariantSlots(variantOrderFor(0)).slice(0, 4)).toEqual([
      { block: 1, arm: "baseline", position: "first" },
      { block: 1, arm: "references", position: "second" },
      { block: 1, arm: "open-questions", position: "third" },
      { block: 2, arm: "references", position: "first" },
    ])
  })

  test("an out-of-range draw throws; the default draw is cryptographic and in range", async () => {
    for (const bad of [-1, 12, 1.5, Number.NaN]) expect(() => variantOrderFor(bad)).toThrow(/integer from 0 to 11/)
    for (let i = 0; i < 50; i++) expect(cryptoVariantDraw()).toBeOneOf([...Array(12).keys()])
    // Bytes 252..255 are discarded, so every draw has 21 of the 252 accepted bytes.
    const bytes = [255, 252, 251]
    expect(cryptoVariantDraw(() => bytes.shift()!)).toBe(251 % 12)
    expect(cryptoVariantDraw(() => 24)).toBe(0)
    const source = await readFile(new URL("./variant-schedule.ts", import.meta.url), "utf8")
    expect(source).not.toContain("Math.random")
  })
})

describe("the sealed config", () => {
  test("it is the routing config with the design, each arm's options and this design's allowances", () => {
    const routing = pairedRunConfig({ provenance: "scripted" }, fakeChange(), roster())
    const variant = variantRunConfig({ provenance: "scripted" }, fakeChange(), roster())
    expect(variant).toEqual({ ...routing, design: "debate-variants", arms: VARIANT_ARM_OPTIONS, allowances: VARIANT_ALLOWANCES })
    expect(VARIANT_ARM_OPTIONS).toEqual({
      baseline: { policy: "shipped", debateReferences: false, debateMissingEvidence: false },
      references: { policy: "shipped", debateReferences: true, debateMissingEvidence: false },
      "open-questions": { policy: "shipped", debateReferences: false, debateMissingEvidence: true },
    })
  })
})

describe("createVariantSchedule", () => {
  test("seals version 2, the design, the draw, the order, nine slots, the protocol and the config", async () => {
    const root = await tempDir()
    const created = await createVariantSchedule(await inputFor(root))
    if (!created.ok) throw new Error(created.reason)
    const onDisk = JSON.parse(await readFile(join(root, SCHEDULE_FILE), "utf8")) as VariantSchedule
    expect(onDisk).toEqual(created.schedule)
    expect(onDisk).toMatchObject({ scheduleVersion: 2, design: "debate-variants", draw: 7, order: variantOrderFor(7) })
    expect(onDisk.slots).toHaveLength(9)
    expect(onDisk.protocol.id).toBe(VARIANT_PROTOCOL_ID)
    expect(onDisk.configDigest).toBe(configDigestOf(onDisk.config))
    expect(onDisk.scheduleHash).toBe(variantScheduleHashOf(onDisk))
  })

  test("refuses, drawing nothing, a routing protocol, an existing schedule of either design, a bad config and a bad draw", async () => {
    const cases: [string, (root: string) => Promise<Partial<CreateVariantScheduleInput>>][] = [
      ["binds the frozen protocol PROTOCOL-mad-debate-variants", async () => ({ protocolFile: ROUTING_PROTOCOL })],
      ["belongs to the oauth route", async () => ({ config: { provenance: "scripted", accounting: "attempts" } })],
      [
        "attempt accounting is not defined for it yet",
        async () => ({ config: { provenance: "scripted", accounting: "attempts", route: "oauth" } }),
      ],
      [
        "a schedule already exists",
        async (root) => {
          const routing: CreateScheduleInput = { ...(await inputFor(root)), coin: () => "heads", protocolFile: ROUTING_PROTOCOL }
          expect((await createSchedule(routing)).ok).toBe(true)
          return {}
        },
      ],
    ]
    for (const [reason, setUp] of cases) {
      const root = await tempDir()
      const over = await setUp(root)
      let drawn = 0
      const created = await createVariantSchedule(await inputFor(root, { ...over, draw: () => ((drawn += 1), 3) }))
      expect(created.ok, reason).toBe(false)
      if (!created.ok) expect(created.reason).toContain(reason)
      expect(drawn).toBe(0)
    }
    const root = await tempDir()
    const bad = await createVariantSchedule(await inputFor(root, { draw: () => 12 }))
    expect(bad.ok).toBe(false)
    await expect(readFile(join(root, SCHEDULE_FILE))).rejects.toThrow()
  })

  test("any existing entry at the schedule's name is occupied, a dangling symlink included: nothing is drawn and the entry stays", async () => {
    const root = await tempDir()
    const file = join(root, SCHEDULE_FILE)
    await symlink(join(root, "nowhere.json"), file)
    let drawn = 0
    const created = await createVariantSchedule(await inputFor(root, { draw: () => ((drawn += 1), 3) }))
    expect(!created.ok && created.reason).toContain("a schedule already exists")
    expect(drawn).toBe(0)
    expect((await lstat(file)).isSymbolicLink()).toBe(true)
    expect(await readlink(file)).toBe(join(root, "nowhere.json"))
  })

  test("a second variant schedule refuses and leaves the first unchanged", async () => {
    const root = await tempDir()
    expect((await createVariantSchedule(await inputFor(root))).ok).toBe(true)
    const before = await readFile(join(root, SCHEDULE_FILE), "utf8")
    const again = await createVariantSchedule(await inputFor(root, { draw: () => 0 }))
    expect(again.ok).toBe(false)
    expect(await readFile(join(root, SCHEDULE_FILE), "utf8")).toBe(before)
  })
})

describe("readVariantSchedule — the document's own fields", () => {
  test("a sealed schedule reads", async () => {
    const root = await tempDir()
    expect((await createVariantSchedule(await inputFor(root))).ok).toBe(true)
    expect((await readVariantSchedule(root)).ok).toBe(true)
  })

  const edits: [string, (schedule: VariantSchedule) => void][] = [
    ["does not give", (s) => void (s.order = [s.order[1]!, s.order[0]!, s.order[2]!])],
    ["does not give", (s) => void (s.order[0] = ["baseline", "baseline", "references"])],
    ["does not give", (s) => void (s.order[0] = ["baseline", "references"])],
    ["does not give", (s) => void (s.order[0] = ["baseline", "references", "debate-off" as never])],
    ["plans slots its draw 7 does not give", (s) => void s.slots.pop()],
    ["plans slots its draw 7 does not give", (s) => void (s.slots[0]!.position = "third")],
    ["carries no draw", (s) => void (s.draw = 12)],
    ["seals arm options", (s) => void ((s.config.arms as Record<string, Record<string, unknown>>).references!.debateReferences = false)],
    ["seals arm options", (s) => void ((s.config.arms as Record<string, unknown>).on = { policy: "shipped" })],
    ["seals the design", (s) => void (s.config.design = "routing")],
    ["seals allowances", (s) => void (s.config.allowances = { ...PAIRED_ALLOWANCES })],
    ["seals attempt accounting or a route", (s) => void (s.config.accounting = "attempts")],
    ["seals attempt accounting or a route", (s) => void (s.config.attemptAllowances = { ...VARIANT_ATTEMPT_ALLOWANCES })],
    ["configDigest that is not its config's digest", (s) => void (s.config.maxRounds = 9)],
    ["configDigest that is not its config's digest", (s) => void ((s as { configDigest?: string }).configDigest = undefined)],
    ["has design", (s) => void ((s as { design: string }).design = "routing")],
    ["has schedule version 1", (s) => void ((s as { scheduleVersion: number }).scheduleVersion = 1)],
    ["is bound to the wrong protocol", (s) => void (s.protocol.id = "PROTOCOL-mad-evaluation-v1")],
  ]
  for (const [reason, edit] of edits) {
    test(`a rehashed edit refuses: ${reason}`, async () => {
      const root = await tempDir()
      expect((await createVariantSchedule(await inputFor(root))).ok).toBe(true)
      await rehashed(root, edit)
      const read = await readVariantSchedule(root)
      expect(read.ok).toBe(false)
      if (!read.ok) expect(read.reason).toContain(reason)
    })
  }

  test("an edit without a new hash is refused as edited; no hash at all as never sealed", async () => {
    const root = await tempDir()
    expect((await createVariantSchedule(await inputFor(root))).ok).toBe(true)
    const file = join(root, SCHEDULE_FILE)
    const schedule = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    await writeFile(file, JSON.stringify({ ...schedule, draw: 0 }))
    const edited = await readVariantSchedule(root)
    expect(!edited.ok && edited.reason).toContain("edited after it was sealed")
    delete schedule.scheduleHash
    await writeFile(file, JSON.stringify(schedule))
    const unsealed = await readVariantSchedule(root)
    expect(!unsealed.ok && unsealed.reason).toContain("never sealed")
  })

  test("a routing schedule is not a variant schedule", async () => {
    const root = await tempDir()
    expect((await createSchedule({ ...(await inputFor(root)), coin: () => "heads", protocolFile: ROUTING_PROTOCOL })).ok).toBe(true)
    const read = await readVariantSchedule(root)
    expect(!read.ok && read.reason).toContain("has schedule version 1")
  })
})

describe("verifyVariantSchedule — the schedule against the caller's inputs", () => {
  test("the same inputs verify; each different binding refuses", async () => {
    const root = await tempDir()
    const input = await inputFor(root)
    expect((await createVariantSchedule(input)).ok).toBe(true)
    expect((await verifyVariantSchedule(root, input)).ok).toBe(true)
    const other = await frozenProtocol(VARIANT_PROTOCOL_ID, 2)
    const cases: [Partial<CreateVariantScheduleInput>, string][] = [
      [{ protocolFile: ROUTING_PROTOCOL }, "binds the frozen protocol PROTOCOL-mad-debate-variants"],
      [{ protocolFile: other }, "not to the frozen protocol this runner read"],
      [{ codeRevision: known({ commit: "def456", dirty: false }) }, "different code revision"],
      [{ roster: selectRoster([candidate("google", "gemini-2.5-pro")], { slots: 1, providerConfigKey: "provider" }).roster }, "different roster"],
      [{ config: { provenance: "scripted", maxRounds: 2 } }, "different change or configuration"],
      [{ config: { provenance: "scripted", accounting: "attempts" } }, "belongs to the oauth route"],
    ]
    for (const [over, reason] of cases) {
      const verified = await verifyVariantSchedule(root, { ...input, ...over })
      expect(verified.ok, reason).toBe(false)
      if (!verified.ok) expect(verified.reason).toContain(reason)
    }
  })

  test("a config change with a matching digest and hash still differs from the caller's config", async () => {
    const root = await tempDir()
    const input = await inputFor(root)
    expect((await createVariantSchedule(input)).ok).toBe(true)
    await rehashed(root, (s) => {
      s.config.maxRounds = 9
      s.configDigest = configDigestOf(s.config)
    })
    expect((await readVariantSchedule(root)).ok).toBe(true)
    const verified = await verifyVariantSchedule(root, input)
    expect(!verified.ok && verified.reason).toContain("different change or configuration")
  })

  test("sealed allowances that are not this design's refuse even when the document is rehashed", async () => {
    const root = await tempDir()
    const input = await inputFor(root)
    expect((await createVariantSchedule(input)).ok).toBe(true)
    await rehashed(root, (s) => {
      s.config.allowances = { ...PAIRED_ALLOWANCES }
      s.configDigest = configDigestOf(s.config)
    })
    const verified = await verifyVariantSchedule(root, input)
    expect(!verified.ok && verified.reason).toContain("seals allowances")
  })
})

describe("the routing entry points refuse the other design", () => {
  test("the routing verifier and reader refuse a variant schedule before anything starts", async () => {
    const root = await tempDir()
    const input = await inputFor(root)
    expect((await createVariantSchedule(input)).ok).toBe(true)
    const routing = { ...input, protocolFile: ROUTING_PROTOCOL }
    const verified = await verifySchedule(root, routing)
    expect(!verified.ok && verified.reason).toContain("has schedule version 2")
    const read = await readSchedule(root)
    expect(!read.ok && read.reason).toContain("has schedule version 2")
    expect((await createSchedule({ ...routing, coin: () => "heads" })).ok).toBe(false)
  })

  test("the routing reader refuses a version-1 document rehashed to name the debate-variants protocol", async () => {
    const root = await tempDir()
    expect((await createSchedule({ ...(await inputFor(root)), coin: () => "heads", protocolFile: ROUTING_PROTOCOL })).ok).toBe(true)
    expect((await readSchedule(root)).ok).toBe(true)
    const file = join(root, SCHEDULE_FILE)
    const schedule = JSON.parse(await readFile(file, "utf8")) as PairedSchedule
    schedule.protocol = { ...schedule.protocol, id: VARIANT_PROTOCOL_ID }
    schedule.scheduleHash = scheduleHashOf(schedule)
    await writeFile(file, JSON.stringify(schedule))
    const read = await readSchedule(root)
    expect(!read.ok && read.reason).toContain("cannot bind PROTOCOL-mad-debate-variants")
  })

  test("a routing schedule cannot bind the debate-variants protocol", async () => {
    const root = await tempDir()
    const variantProtocol = await frozenProtocol(VARIANT_PROTOCOL_ID)
    const routing: CreateScheduleInput = { ...(await inputFor(root)), coin: () => "heads", protocolFile: variantProtocol }
    const created = await createSchedule(routing)
    expect(!created.ok && created.reason).toContain("cannot bind PROTOCOL-mad-debate-variants")
    await expect(readFile(join(root, SCHEDULE_FILE))).rejects.toThrow()
  })
})

describe("the design's allowances and gate", () => {
  test("one more continuation per block, everything else the routing design's", () => {
    expect(VARIANT_ALLOWANCES).toEqual({ global: 2_585_000, blocks: 1_985_000, prefix: 60_000, continuation: 195_000, runCap: 255_000 })
    expect(VARIANT_ALLOWANCES.blocks - 3 * (VARIANT_ALLOWANCES.prefix + 3 * VARIANT_ALLOWANCES.continuation)).toBe(
      PAIRED_ALLOWANCES.blocks - 3 * (PAIRED_ALLOWANCES.prefix + 2 * PAIRED_ALLOWANCES.continuation),
    )
    expect(VARIANT_ATTEMPT_ALLOWANCES).toEqual({ global: 435, blocks: 435, block: 145, prefix: 10, continuation: 45 })
    expect(VARIANT_ATTEMPT_ALLOWANCES.block).toBe(ATTEMPT_ALLOWANCES.prefix + 3 * ATTEMPT_ALLOWANCES.continuation)
  })

  function view(over: Partial<RequestGateView<VariantPhase>> & { phases?: Record<string, number>; blocks?: number; perBlock?: number } = {}) {
    const { phases = {}, blocks = 0, perBlock, ...rest } = over
    const base: RequestGateView<VariantPhase> = {
      stop: null,
      halt: null,
      globalSpent: 0,
      categorySpent: (category) => (category === "blocks" ? blocks : 0),
      phaseSpent: (block, phase) => phases[`${block}:${phase}`] ?? 0,
      ...(perBlock === undefined ? {} : { mode: "attempts" as const, blockSpent: () => perBlock }),
    }
    return { ...base, ...rest }
  }

  test("tokens: every arm's continuation has the same limit, refused AT it, named by its arm", () => {
    for (const arm of VARIANT_ARMS) {
      expect(variantRequestGate(view({ phases: { [`2:${arm}`]: 194_999 } }), { block: 2, phase: arm })).toEqual({ ok: true })
      const refused = variantRequestGate(view({ phases: { [`2:${arm}`]: 195_000 } }), { block: 2, phase: arm })
      expect(refused).toEqual({
        ok: false,
        cause: "budget",
        reason: `block 2's ${arm} continuation allowance is exhausted: 195000 of 195000 newly executed tokens`,
      })
    }
    expect(variantRequestGate(view({ phases: { "1:prefix": 60_000 } }), { block: 1, phase: "prefix" })).toMatchObject({
      ok: false,
      reason: "block 1's shared prefix allowance is exhausted: 60000 of 60000 newly executed tokens",
    })
    // The routing Blocks limit admits here; this design's refuses at its own.
    expect(variantRequestGate(view({ blocks: 1_400_000 }), { block: 3, phase: "baseline" })).toEqual({ ok: true })
    expect(variantRequestGate(view({ blocks: 1_985_000 }), { block: 3, phase: "baseline" })).toMatchObject({ ok: false, cause: "budget" })
    expect(variantRequestGate(view({ globalSpent: 2_585_000 }), { block: 1, phase: "baseline" })).toMatchObject({ ok: false, cause: "budget" })
    expect(variantRequestGate(view({ halt: "h" }), { block: 1, phase: "baseline" })).toMatchObject({ ok: false, cause: "halted" })
    expect(variantRequestGate(view({ stop: "s" }), { block: 1, phase: "baseline" })).toMatchObject({ ok: false, cause: "runner-stop" })
  })

  test("attempts: a block admits up to 145, each continuation 45, and the routing gate is unchanged", () => {
    expect(variantRequestGate(view({ perBlock: 144 }), { block: 1, phase: "references" })).toEqual({ ok: true })
    expect(variantRequestGate(view({ perBlock: 145 }), { block: 1, phase: "references" })).toEqual({
      ok: false,
      cause: "budget",
      reason: "block 1's allowance is exhausted: 145 of 145 admitted attempts",
    })
    expect(variantRequestGate(view({ perBlock: 0, phases: { "1:open-questions": 45 } }), { block: 1, phase: "open-questions" })).toEqual({
      ok: false,
      cause: "budget",
      reason: "block 1's open-questions continuation allowance is exhausted: 45 of 45 admitted attempts",
    })
    expect(variantRequestGate(view({ perBlock: 0, blocks: 435 }), { block: 1, phase: "baseline" })).toMatchObject({ ok: false })
    const routing = view({ perBlock: 100 }) as unknown as RequestGateView
    expect(requestGate(routing, { block: 1, phase: "on" })).toEqual({
      ok: false,
      cause: "budget",
      reason: "block 1's allowance is exhausted: 100 of 100 admitted attempts",
    })
    const routingPhase = view({ perBlock: 0, phases: { "1:on": 45 } }) as unknown as RequestGateView
    expect(requestGate(routingPhase, { block: 1, phase: "on" })).toMatchObject({
      reason: "block 1's ON continuation allowance is exhausted: 45 of 45 admitted attempts",
    })
  })
})
