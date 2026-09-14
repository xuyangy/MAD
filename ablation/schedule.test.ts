import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { selectRoster } from "../core/roster/select.ts"
import { candidate, fakeChange } from "../core/test-support/fakes.ts"
import { LABELLED_CHANGE_SEAL } from "../fixtures/seeded-defects/seal.ts"
import { known } from "./manifest.ts"
import {
  canonicalJson,
  createSchedule,
  cryptoCoin,
  firstArmsFor,
  instructionsDigestOf,
  plannedSlots,
  readFrozenProtocol,
  SCHEDULE_FILE,
  scheduleHashOf,
  verifySchedule,
  writeStartMarker,
  type CreateScheduleInput,
  type PairedSchedule,
} from "./schedule.ts"

const PROTOCOL_FILE = new URL("../_bmad-output/specs/spec-mad-orchestrator/evaluation-protocol.md", import.meta.url).pathname

const scratch: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-schedule-"))
  scratch.push(dir)
  return dir
}

afterEach(async () => {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})

function inputFor(root: string, over: Partial<CreateScheduleInput> = {}): CreateScheduleInput {
  const roster = selectRoster([candidate("anthropic", "claude-sonnet-4-5"), candidate("openai", "gpt-5")], {
    slots: 2,
    providerConfigKey: "provider",
  }).roster
  return {
    bundleRoot: root,
    protocolFile: PROTOCOL_FILE,
    fixture: LABELLED_CHANGE_SEAL,
    codeRevision: known({ commit: "abc123", dirty: false }),
    roster,
    change: fakeChange(),
    config: { provenance: "scripted" },
    createdAt: "2026-09-14T00:00:00.000Z",
    coin: () => "heads",
    ...over,
  }
}

describe("the schedule rule (evaluation-protocol.md §4)", () => {
  test("heads is ON, OFF, ON; tails is OFF, ON, OFF; each block plans both arms", () => {
    expect(firstArmsFor("heads")).toEqual(["on", "off", "on"])
    expect(firstArmsFor("tails")).toEqual(["off", "on", "off"])
    expect(plannedSlots(firstArmsFor("tails"))).toEqual([
      { block: 1, arm: "off", position: "first" },
      { block: 1, arm: "on", position: "second" },
      { block: 2, arm: "on", position: "first" },
      { block: 2, arm: "off", position: "second" },
      { block: 3, arm: "off", position: "first" },
      { block: 3, arm: "on", position: "second" },
    ])
  })

  test("the default coin comes from the cryptographic generator, never Math.random", async () => {
    expect(["heads", "tails"]).toContain(cryptoCoin())
    const source = await readFile(new URL("./schedule.ts", import.meta.url), "utf8")
    expect(source).not.toContain("Math.random")
  })

  test("the protocol hash is computed from the file by its own rule and matches frozen_hash", async () => {
    const protocol = await readFrozenProtocol(PROTOCOL_FILE)
    expect(protocol).toMatchObject({ ok: true, version: 1, hash: "sha256:a572141bc69494d43e04380f9ca83dcdb004ffc31ff630e61e4b67d353a61ac0" })
  })

  test("an edited protocol does not verify", async () => {
    const root = await tempDir()
    const copy = join(root, "protocol.md")
    await writeFile(copy, (await readFile(PROTOCOL_FILE, "utf8")).replace("Three scheduled paired blocks.", "Four scheduled paired blocks."))
    const read = await readFrozenProtocol(copy)
    expect(read.ok).toBe(false)
    const created = await createSchedule(inputFor(root, { protocolFile: copy }))
    expect(created.ok).toBe(false)
  })
})

describe("createSchedule — sealed and published before any billable work", () => {
  test("the seal binds coin, order, slots, protocol, fixture, revision, roster and config, hashed without its own hash", async () => {
    const root = await tempDir()
    const created = await createSchedule(inputFor(root, { coin: () => "tails" }))
    if (!created.ok) throw new Error(created.reason)
    const onDisk = JSON.parse(await readFile(join(root, SCHEDULE_FILE), "utf8")) as PairedSchedule
    expect(onDisk).toEqual(created.schedule)
    expect(onDisk.coin).toBe("tails")
    expect(onDisk.firstArms).toEqual(["off", "on", "off"])
    expect(onDisk.slots).toHaveLength(6)
    expect(onDisk.protocol.hash).toBe("sha256:a572141bc69494d43e04380f9ca83dcdb004ffc31ff630e61e4b67d353a61ac0")
    expect(onDisk.fixture).toEqual(LABELLED_CHANGE_SEAL)
    expect(onDisk.config).toMatchObject({ tokenCap: 255_000, stopOnUnknownUsage: true, provenance: "scripted" })
    expect(onDisk.roster.slots.map((slot) => slot.slot)).toEqual(["discovery-1", "discovery-2"])
    expect(scheduleHashOf(onDisk)).toBe(onDisk.scheduleHash)
    const { scheduleHash: _hash, ...rest } = onDisk
    expect(scheduleHashOf({ ...rest, coin: "heads" })).not.toBe(onDisk.scheduleHash)
  })

  test("an existing schedule refuses, the coin is not tossed again, and the file is unchanged", async () => {
    const root = await tempDir()
    expect((await createSchedule(inputFor(root))).ok).toBe(true)
    const before = await readFile(join(root, SCHEDULE_FILE), "utf8")
    let tossed = 0
    const again = await createSchedule(inputFor(root, { coin: () => ((tossed += 1), "tails") }))
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.reason).toContain("never re-tossed or replaced")
    expect(tossed).toBe(0)
    expect(await readFile(join(root, SCHEDULE_FILE), "utf8")).toBe(before)
  })

  test("an I/O error refuses", async () => {
    const root = await tempDir()
    const file = join(root, "a-file")
    await writeFile(file, "x")
    expect((await createSchedule(inputFor(file))).ok).toBe(false)
  })
})

describe("verifySchedule — the runner checks the seal against its own inputs", () => {
  async function sealed() {
    const root = await tempDir()
    const input = inputFor(root)
    const created = await createSchedule(input)
    if (!created.ok) throw new Error(created.reason)
    return { root, input }
  }

  test("the same inputs verify", async () => {
    const { root, input } = await sealed()
    expect((await verifySchedule(root, input)).ok).toBe(true)
  })

  test.each([
    ["fixture", (input: CreateScheduleInput) => ({ ...input, fixture: { ...input.fixture, version: "labelled-change-2" } }), "fixture"],
    ["config", (input: CreateScheduleInput) => ({ ...input, config: { ...input.config, threshold: 0.9 } }), "configuration"],
    ["change", (input: CreateScheduleInput) => ({ ...input, change: { ...input.change, diff: `${input.change.diff}\n` } }), "configuration"],
    ["code revision", (input: CreateScheduleInput) => ({ ...input, codeRevision: known({ commit: "def456", dirty: false }) }), "code revision"],
    ["roster", (input: CreateScheduleInput) => ({ ...input, roster: { ...input.roster, requested: 3 } }), "roster"],
  ])("a different %s refuses", async (_name, change, expected) => {
    const { root, input } = await sealed()
    const verified = await verifySchedule(root, change(input))
    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.reason).toContain(expected)
  })

  test("a schedule edited on disk no longer matches its hash", async () => {
    const { root, input } = await sealed()
    const file = join(root, SCHEDULE_FILE)
    const schedule = JSON.parse(await readFile(file, "utf8")) as PairedSchedule
    await writeFile(file, JSON.stringify({ ...schedule, coin: "tails", firstArms: firstArmsFor("tails"), slots: plannedSlots(firstArmsFor("tails")) }))
    const verified = await verifySchedule(root, input)
    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.reason).toContain("scheduleHash")
  })

  test("an order its coin does not give refuses even when rehashed", async () => {
    const { root, input } = await sealed()
    const file = join(root, SCHEDULE_FILE)
    const schedule = JSON.parse(await readFile(file, "utf8")) as PairedSchedule
    const { scheduleHash: _hash, ...rest } = schedule
    const forged = { ...rest, firstArms: firstArmsFor("tails") }
    await writeFile(file, JSON.stringify({ ...forged, scheduleHash: scheduleHashOf(forged) }))
    const verified = await verifySchedule(root, input)
    expect(verified.ok).toBe(false)
  })

  test("canonical JSON ignores key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }))
  })
})

describe("the start marker", () => {
  test("is written once; a present marker refuses", async () => {
    const root = await tempDir()
    expect((await writeStartMarker(root, "sha256:x", "t")).ok).toBe(true)
    const again = await writeStartMarker(root, "sha256:x", "t")
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.reason).toContain("already started")
  })
})

describe("the config digest binds instructions and tools (story 2-5c review)", () => {
  test("the digest covers the registry's instruction text for every role and each lens slot", async () => {
    const root = await tempDir()
    const input = inputFor(root)
    const created = await createSchedule(input)
    if (!created.ok) throw new Error(created.reason)
    expect(created.schedule.config["instructionsDigest"]).toBe(instructionsDigestOf(input.roster))
    const lensed = selectRoster([candidate("anthropic", "claude-sonnet-4-5"), candidate("openai", "gpt-5")], {
      slots: 1,
      lenses: ["security"],
      providerConfigKey: "provider",
    }).roster
    expect(instructionsDigestOf(lensed)).not.toBe(instructionsDigestOf(input.roster))
  })

  test("a different tools identity refuses", async () => {
    const root = await tempDir()
    const input = inputFor(root, { config: { provenance: "scripted", tools: "opencode tools @ worktree A" } })
    expect((await createSchedule(input)).ok).toBe(true)
    const verified = await verifySchedule(root, { ...input, config: { ...input.config, tools: "opencode tools @ worktree B" } })
    expect(verified.ok).toBe(false)
  })
})
