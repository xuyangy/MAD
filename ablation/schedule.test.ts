import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { selectRoster } from "../core/roster/select.ts"
import { candidate, fakeChange } from "../core/test-support/fakes.ts"
import { LABELLED_CHANGE_SEAL } from "../fixtures/seeded-defects/seal.ts"
import { known } from "./manifest.ts"
import { ATTEMPT_ALLOWANCES } from "./governor.ts"
import {
  canonicalJson,
  configDigestOf,
  createSchedule,
  cryptoCoin,
  firstArmsFor,
  instructionsDigestOf,
  pairedRunConfig,
  plannedSlots,
  readFrozenProtocol,
  SCHEDULE_FILE,
  scheduleHashOf,
  sha256,
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

describe("the accounting mode and route in the sealed config (story 2-8c3a)", () => {
  const roster = () =>
    selectRoster([candidate("anthropic", "claude-sonnet-4-5"), candidate("openai", "gpt-5")], { slots: 2, providerConfigKey: "provider" }).roster

  test("a token-mode config digests exactly as before this story, with the defaults absent or explicit", () => {
    // Digests computed with the code at 8632d9b, before the accounting mode existed.
    const before = "sha256:b943d2025551aad8d78680ced7e4f47aa8fba5f745ec2526c17dc1ddcde92091"
    expect(configDigestOf(pairedRunConfig({ provenance: "scripted" }, fakeChange(), roster()))).toBe(before)
    expect(configDigestOf(pairedRunConfig({ provenance: "scripted", accounting: "tokens", route: "api-key" }, fakeChange(), roster()))).toBe(before)
    expect(
      configDigestOf(pairedRunConfig({ provenance: "live", tools: "t", gates: "g", maxConcurrency: 2 }, fakeChange(), roster())),
    ).toBe("sha256:3fc842fea8dcd55d0a98b01e9285b1c61e6f579f6d5335b7a27b2182451988e7")
  })

  test("attempt mode seals its unit, its allowances and the dials the runs receive; the oauth route is sealed too", () => {
    const config = pairedRunConfig({ provenance: "scripted", accounting: "attempts", route: "oauth" }, fakeChange(), roster())
    expect(config).toMatchObject({
      accounting: "attempts",
      attemptAllowances: { ...ATTEMPT_ALLOWANCES },
      tokenCap: null,
      stopOnUnknownUsage: false,
      route: "oauth",
    })
    expect(configDigestOf(config)).not.toBe(configDigestOf(pairedRunConfig({ provenance: "scripted" }, fakeChange(), roster())))
  })

  const attemptRoster = () =>
    selectRoster([candidate("anthropic", "claude-sonnet-4-5"), candidate("openai", "gpt-5"), candidate("google", "gemini-2.5-pro")], {
      slots: 3,
      providerConfigKey: "provider",
      lenses: ["security", "reliability"],
    }).roster
  const attemptConfig = { provenance: "scripted" as const, accounting: "attempts" as const, route: "oauth" as const }

  async function frozenProtocol(version: number): Promise<string> {
    const dir = await tempDir()
    const pending = `---\nid: PROTOCOL-test-v${version}\nstatus: frozen\nversion: ${version}\nfrozen_hash: PENDING\n---\n\n# test\n`
    const file = join(dir, `protocol-v${version}.md`)
    await writeFile(file, pending.replace("frozen_hash: PENDING", `frozen_hash: ${sha256(pending)}`))
    return file
  }

  test("an attempt-mode schedule seals under a frozen v2 protocol with three pool slots and the two lenses", async () => {
    const root = await tempDir()
    const created = await createSchedule(inputFor(root, { config: attemptConfig, roster: attemptRoster(), protocolFile: await frozenProtocol(2) }))
    if (!created.ok) throw new Error(created.reason)
    expect(created.schedule.protocol.version).toBe(2)
    expect(created.schedule.config).toMatchObject({ accounting: "attempts", route: "oauth" })
  })

  test("createSchedule refuses, before any toss, every attempt-mode binding the allowances do not fit", async () => {
    const v2 = await frozenProtocol(2)
    const cases: [Partial<CreateScheduleInput>, string][] = [
      [{ config: { provenance: "scripted", accounting: "attempts" }, roster: attemptRoster(), protocolFile: v2 }, "belongs to the oauth route"],
      [{ config: { provenance: "scripted", route: "oauth" }, roster: attemptRoster(), protocolFile: v2 }, "runs only with accounting `attempts`"],
      [{ config: attemptConfig, roster: attemptRoster() }, "needs a frozen version-2 protocol"],
      [{ config: attemptConfig, protocolFile: v2 }, "is sized for 3 pool discovery slots"],
    ]
    for (const [over, reason] of cases) {
      const root = await tempDir()
      let tossed = 0
      const created = await createSchedule(inputFor(root, { ...over, coin: () => ((tossed += 1), "heads") }))
      expect(created.ok, reason).toBe(false)
      if (!created.ok) expect(created.reason).toContain(reason)
      expect(tossed).toBe(0)
    }
  })

  test("the runner binding refuses the same: an attempt-mode schedule under a protocol that is not v2 does not verify", async () => {
    const root = await tempDir()
    const input = inputFor(root, { config: attemptConfig, roster: attemptRoster(), protocolFile: await frozenProtocol(2) })
    expect((await createSchedule(input)).ok).toBe(true)
    const verified = await verifySchedule(root, { ...input, protocolFile: PROTOCOL_FILE })
    expect(verified.ok).toBe(false)
    if (!verified.ok) expect(verified.reason).toContain("needs a frozen version-2 protocol")
    const tokens = await verifySchedule(root, { ...input, config: { provenance: "scripted" } })
    expect(tokens.ok).toBe(false)
  })
})
