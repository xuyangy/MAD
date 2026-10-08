/**
 * Story 2-7b — the sealed sixteen-slot schedule: the §5 coin rule, publish-once,
 * and verification against the runner's inputs.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { ADVERSARIAL_ASSERTIONS } from "../fixtures/adversarial/assertions.ts"
import { ADVERSARIAL_CASES } from "../fixtures/adversarial/material.ts"
import { ADVERSARIAL_SEAL } from "../fixtures/adversarial/seal.ts"
import { ATTEMPT_CONFIG, experimentRoot, frozenV3Copy, oneSlotRoster, PROTOCOL_FILE, PROTOCOL_V3_FILE, SCRIPTED_CONFIG } from "./adversarial-read.fixture.ts"
import {
  ADVERSARIAL_ROOT_MARKER_FILE,
  ADVERSARIAL_SCHEDULE_FILE,
  ADVERSARIAL_START_MARKER_FILE,
  adversarialAccountingProblem,
  adversarialDirectory,
  adversarialProtocolProblem,
  adversarialRunConfig,
  isolatedRootProblem,
  readAdversarialBill,
  ADVERSARIAL_BILL_FILE,
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
import { canonicalJson, SCHEDULE_FILE, sha256, START_MARKER_FILE, type CoinFace } from "./schedule.ts"
import { CUMULATIVE_SHARE } from "../core/budget/presets.ts"
import { HALT_MARKER_FILE } from "./governor.ts"
import { acquireLock, JOURNAL_FILE, LOCK_FILE } from "./journal.ts"
import { instructionsDigestOf } from "./schedule.ts"

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

// ---------------------------------------------------------------------------
// Story 2-7e — the attempt-mode schedule (protocol v3) and the suite's own root
// ---------------------------------------------------------------------------

const PROTOCOL_V2_FILE = new URL("../_bmad-output/specs/spec-mad-orchestrator/evaluation-protocol-v2.md", import.meta.url).pathname

async function attemptInput(root: string, protocolFile?: string) {
  return { ...input(root), protocolFile: protocolFile ?? (await frozenV3Copy(scratch)).file, config: ATTEMPT_CONFIG }
}

describe("the adversarial config: token mode by default, attempt mode opt-in", () => {
  test("a config naming no accounting and no route seals exactly the token-mode settings", () => {
    const roster = oneSlotRoster().roster
    const config = adversarialRunConfig(SCRIPTED_CONFIG, roster)
    expect(config).toEqual({
      provenance: "scripted",
      tokenCap: 25_000,
      spendShares: { ...CUMULATIVE_SHARE },
      stopOnUnknownUsage: true,
      maxConcurrency: undefined,
      allowances: { global: 2_000_000, adversarial: 400_000, runCap: 25_000, runs: 16 },
      instructionsDigest: instructionsDigestOf(roster),
      tools: SCRIPTED_CONFIG.tools,
    })
    // No attempt field is present, so the digest cannot depend on one; the api-key default adds nothing either.
    expect(Object.keys(config).some((key) => ["accounting", "attemptAllowances", "route"].includes(key))).toBe(false)
    expect(sha256(canonicalJson(adversarialRunConfig({ ...SCRIPTED_CONFIG, route: "api-key" }, roster)))).toBe(sha256(canonicalJson(config)))
  })

  test("an attempt-mode config seals no token cap, no unknown-usage stop, and the attempt allowances", () => {
    const config = adversarialRunConfig(ATTEMPT_CONFIG, oneSlotRoster().roster)
    expect(config).toMatchObject({
      tokenCap: null,
      stopOnUnknownUsage: false,
      accounting: "attempts",
      route: "oauth",
      attemptAllowances: { run: 30, suite: 480, global: 480, runs: 16 },
    })
    expect("allowances" in config).toBe(false)
    expect(JSON.stringify(config)).not.toContain("400000")
  })

  test("oauth and attempts are one choice, and any other value of either is refused", () => {
    expect(adversarialAccountingProblem(SCRIPTED_CONFIG)).toBeNull()
    expect(adversarialAccountingProblem({ route: "api-key" })).toBeNull()
    expect(adversarialAccountingProblem(ATTEMPT_CONFIG)).toBeNull()
    expect(adversarialAccountingProblem({ route: "oauth" })).toContain("runs only with accounting `attempts`")
    expect(adversarialAccountingProblem({ accounting: "attempts" })).toContain("belongs to the oauth route")
    expect(adversarialAccountingProblem({ accounting: "attempts", route: "api-key" })).toContain("belongs to the oauth route")
    expect(adversarialAccountingProblem({ accounting: "tokens" as never })).toContain('accounting "tokens" is not `attempts`')
    expect(adversarialAccountingProblem({ accounting: "requests" as never, route: "oauth" })).toContain('accounting "requests" is not `attempts`')
    expect(adversarialAccountingProblem({ accounting: "attempts", route: "wifi" as never })).toContain('route "wifi" is neither api-key nor oauth')
  })

  test("attempt accounting needs protocol version 3, and token mode asks nothing of the version", () => {
    expect(adversarialProtocolProblem(ATTEMPT_CONFIG, { id: "PROTOCOL-mad-evaluation-v3", version: 3 })).toBeNull()
    expect(adversarialProtocolProblem(ATTEMPT_CONFIG, { id: "PROTOCOL-mad-evaluation-v2", version: 2 })).toBe(
      "accounting `attempts` needs a frozen version-3 protocol, and the protocol handed in is PROTOCOL-mad-evaluation-v2 version 2",
    )
    expect(adversarialProtocolProblem(SCRIPTED_CONFIG, { id: "PROTOCOL-mad-evaluation-v1", version: 1 })).toBeNull()
  })
})

describe("createAdversarialSchedule in attempt mode", () => {
  test("over a frozen copy of v3 it seals the attempt config and writes the root marker", async () => {
    const draft = await readFile(PROTOCOL_V3_FILE)
    const root = await experimentRoot(scratch)
    const given = await attemptInput(root)
    const created = await createAdversarialSchedule(given)
    if (!created.ok) throw new Error(created.reason)
    expect(created.schedule.protocol).toMatchObject({ id: "PROTOCOL-mad-evaluation-v3", version: 3 })
    expect(created.schedule.config).toMatchObject({ tokenCap: null, stopOnUnknownUsage: false, accounting: "attempts", route: "oauth" })
    expect(JSON.parse(await readFile(join(root, ADVERSARIAL_ROOT_MARKER_FILE), "utf8"))).toEqual({
      kind: "mad-adversarial-suite-root",
      version: 1,
      accounting: "attempts",
      scope: "adversarial",
      createdAt: "2026-09-18T00:00:00.000Z",
    })
    expect((await verifyAdversarialSchedule(root, { ...binding(root), protocolFile: given.protocolFile, config: ATTEMPT_CONFIG })).ok).toBe(true)
    // The root, as its own, passes the isolation check with the marker required.
    expect(await isolatedRootProblem(root, { marker: "required" })).toBeNull()
    // The protocol file holds the same bytes as before the copy was frozen and sealed against.
    expect((await readFile(PROTOCOL_V3_FILE)).equals(draft)).toBe(true)
  })

  test("the v3 draft, v2 and v1 are each refused by name, with nothing tossed and nothing written", async () => {
    const draft = await readFile(PROTOCOL_V3_FILE, "utf8")
    for (const [protocolFile, why] of [
      ...(/^status: draft$/m.test(draft) ? [[PROTOCOL_V3_FILE, "is not a frozen protocol"] as const] : []),
      [PROTOCOL_V2_FILE, "the protocol handed in is PROTOCOL-mad-evaluation-v2 version 2"],
      [PROTOCOL_FILE, "the protocol handed in is PROTOCOL-mad-evaluation-v1 version 1"],
    ] as const) {
      const root = await experimentRoot(scratch)
      let tossed = 0
      const refused = await createAdversarialSchedule({ ...(await attemptInput(root, protocolFile)), coin: () => ((tossed += 1), "heads") })
      expect(refused.ok, protocolFile).toBe(false)
      if (!refused.ok) expect(refused.reason, protocolFile).toContain(why)
      expect(tossed).toBe(0)
      expect(await hasAdversarialSchedule(root)).toBe(false)
      expect(await readFile(join(root, ADVERSARIAL_ROOT_MARKER_FILE), "utf8").catch(() => "absent")).toBe("absent")
    }
  })

  test("a route and accounting that disagree are refused before the protocol is read", async () => {
    const root = await experimentRoot(scratch)
    const refused = await createAdversarialSchedule({ ...input(root), protocolFile: "/nonexistent/protocol.md", config: { ...SCRIPTED_CONFIG, route: "oauth" } })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toBe("the oauth route measures no tokens, so it runs only with accounting `attempts`; nothing was tossed")
  })

  test("verification refuses an attempt schedule read against another protocol, and a token schedule read as attempts", async () => {
    const root = await experimentRoot(scratch)
    const given = await attemptInput(root)
    const created = await createAdversarialSchedule(given)
    if (!created.ok) throw new Error(created.reason)
    const attempt = { ...binding(root), protocolFile: given.protocolFile, config: ATTEMPT_CONFIG }
    const v2 = await verifyAdversarialSchedule(root, { ...attempt, protocolFile: PROTOCOL_V2_FILE })
    expect(v2.ok).toBe(false)
    if (!v2.ok) expect(v2.reason).toContain("needs a frozen version-3 protocol")
    const asTokens = await verifyAdversarialSchedule(root, { ...attempt, config: SCRIPTED_CONFIG })
    expect(asTokens.ok).toBe(false)
    if (!asTokens.ok) expect(asTokens.reason).toContain("is bound to a different configuration")

    const tokenRoot = await experimentRoot(scratch)
    const token = await createAdversarialSchedule(input(tokenRoot))
    if (!token.ok) throw new Error(token.reason)
    // The token-mode schedule writes no root marker: v1's shared-root rule is its rule.
    expect(await readFile(join(tokenRoot, ADVERSARIAL_ROOT_MARKER_FILE), "utf8").catch(() => "absent")).toBe("absent")
    const asAttempts = await verifyAdversarialSchedule(tokenRoot, { ...binding(tokenRoot), protocolFile: given.protocolFile, config: ATTEMPT_CONFIG })
    expect(asAttempts.ok).toBe(false)
  })
})

describe("isolatedRootProblem: the suite's root is its own (protocol v3 B5)", () => {
  /** A root that carries a valid marker, as `createAdversarialSchedule` leaves it. */
  async function ownRoot(): Promise<string> {
    const root = await experimentRoot(scratch)
    const created = await createAdversarialSchedule(await attemptInput(root))
    if (!created.ok) throw new Error(created.reason)
    return root
  }

  test("the suite's own files at a marked root are accepted: journal, lock, halt marker and everything under adversarial/", async () => {
    const root = await ownRoot()
    await writeFile(join(root, JOURNAL_FILE), "")
    await writeFile(join(root, HALT_MARKER_FILE), "{}\n")
    await writeFile(join(adversarialDirectory(root), ADVERSARIAL_START_MARKER_FILE), "{}\n")
    await mkdir(join(adversarialDirectory(root), "worktrees", "adv-01-clean", ".git"), { recursive: true })
    await writeFile(join(adversarialDirectory(root), "worktrees", "adv-01-clean", "src.ts"), "x\n")
    const lock = await acquireLock(root, "t")
    if (!lock.ok) throw new Error(lock.reason)
    expect(await isolatedRootProblem(root, { marker: "required" })).toBeNull()
    await lock.lock.release()
  })

  test("a foreign file AT the root refuses, naming it: a paired schedule always, a journal or a schedule when no marker owns it", async () => {
    for (const name of [SCHEDULE_FILE, START_MARKER_FILE]) {
      const root = await ownRoot()
      await writeFile(join(root, name), "{}\n")
      const problem = await isolatedRootProblem(root, { marker: "required" })
      expect(problem, name).toContain(name)
      expect(problem, name).toContain("this is a paired experiment's root")
    }
    for (const name of [JOURNAL_FILE, HALT_MARKER_FILE, join("adversarial", ADVERSARIAL_SCHEDULE_FILE), join("adversarial", ADVERSARIAL_START_MARKER_FILE)]) {
      const root = await experimentRoot(scratch)
      await mkdir(join(root, "adversarial"), { recursive: true })
      await writeFile(join(root, name), "")
      const problem = await isolatedRootProblem(root, { marker: "optional" })
      expect(problem, name).toContain(name)
      expect(problem, name).toContain("belongs to another experiment")
    }
  })

  test("a root with no marker is refused when the marker is required, and a malformed marker always", async () => {
    const bare = await experimentRoot(scratch)
    await mkdir(bare, { recursive: true })
    expect(await isolatedRootProblem(bare, { marker: "optional" })).toBeNull()
    expect(await isolatedRootProblem(bare, { marker: "required" })).toContain(`it carries no \`${ADVERSARIAL_ROOT_MARKER_FILE}\``)
    for (const text of ["not json", "{}", JSON.stringify({ kind: "mad-adversarial-suite-root", version: 2, accounting: "attempts", scope: "adversarial", createdAt: "t" })]) {
      await writeFile(join(bare, ADVERSARIAL_ROOT_MARKER_FILE), text)
      for (const marker of ["optional", "required"] as const) {
        expect(await isolatedRootProblem(bare, { marker }), text).toContain("is not a version-1 suite root marker")
      }
    }
  })

  test("a foreign marker ABOVE the root refuses, naming it", async () => {
    for (const name of [JOURNAL_FILE, LOCK_FILE, HALT_MARKER_FILE, SCHEDULE_FILE, START_MARKER_FILE, ADVERSARIAL_ROOT_MARKER_FILE, join("adversarial", ADVERSARIAL_SCHEDULE_FILE)]) {
      const outer = await experimentRoot(scratch)
      await mkdir(join(outer, "adversarial"), { recursive: true })
      await writeFile(join(outer, name), "{}\n")
      const inner = join(outer, "deeper", "inner")
      await mkdir(inner, { recursive: true })
      const problem = await isolatedRootProblem(inner, { marker: "optional" })
      expect(problem, name).toContain(join(outer, name))
      expect(problem, name).toContain("exists above it, so it is nested inside another experiment root")
    }
  })

  test("a marker-named symlink at or above the root that does not resolve is neither present nor absent, and refuses", async () => {
    // Above: a dangling symlink, and one that loops on itself.
    for (const target of ["nowhere", JOURNAL_FILE]) {
      const outer = await experimentRoot(scratch)
      const inner = join(outer, "inner")
      await mkdir(inner, { recursive: true })
      await symlink(join(outer, target), join(outer, JOURNAL_FILE))
      const problem = await isolatedRootProblem(inner, { marker: "optional" })
      expect(problem, target).toContain(`\`${join(outer, JOURNAL_FILE)}\` is a symlink that does not resolve`)
      expect(problem, target).toContain("so whether an experiment file stands there is not established")
    }
    // At: a paired schedule name that dangles.
    const root = await experimentRoot(scratch)
    await mkdir(root, { recursive: true })
    await symlink(join(root, "nowhere"), join(root, SCHEDULE_FILE))
    expect(await isolatedRootProblem(root, { marker: "optional" })).toContain("is a symlink that does not resolve")
  })

  test("the root's own marker, journal, halt marker and adversarial/ entry may not be symlinks", async () => {
    const elsewhere = await experimentRoot(scratch)
    await mkdir(join(elsewhere, "adversarial"), { recursive: true })
    await writeFile(join(elsewhere, JOURNAL_FILE), "")
    for (const [name, target] of [
      [JOURNAL_FILE, join(elsewhere, JOURNAL_FILE)],
      [JOURNAL_FILE, join(elsewhere, "dangling")],
      [HALT_MARKER_FILE, join(elsewhere, "dangling")],
      ["adversarial", join(elsewhere, "adversarial")],
    ] as const) {
      // A marked root, built by hand so that `adversarial/` can be the link.
      const root = await experimentRoot(scratch)
      await mkdir(root, { recursive: true })
      await writeFile(
        join(root, ADVERSARIAL_ROOT_MARKER_FILE),
        JSON.stringify({ kind: "mad-adversarial-suite-root", version: 1, accounting: "attempts", scope: "adversarial", createdAt: "t" }),
      )
      expect(await isolatedRootProblem(root, { marker: "required" })).toBeNull()
      await symlink(target, join(root, name))
      const problem = await isolatedRootProblem(root, { marker: "required" })
      expect(problem, `${name} -> ${target}`).toContain(`${name}\` is a symlink, so whose file it reaches is not established`)
    }
    // The marker itself, linked from another suite's root.
    const own = await ownRoot()
    const other = await experimentRoot(scratch)
    await mkdir(other, { recursive: true })
    await symlink(join(own, ADVERSARIAL_ROOT_MARKER_FILE), join(other, ADVERSARIAL_ROOT_MARKER_FILE))
    expect(await isolatedRootProblem(other, { marker: "required" })).toContain(`${ADVERSARIAL_ROOT_MARKER_FILE}\` is a symlink`)
  })

  test("a foreign marker BELOW the root refuses, naming it, at any depth", async () => {
    for (const name of [JOURNAL_FILE, LOCK_FILE, HALT_MARKER_FILE, SCHEDULE_FILE, START_MARKER_FILE, ADVERSARIAL_ROOT_MARKER_FILE, join("adversarial", ADVERSARIAL_SCHEDULE_FILE)]) {
      const root = await ownRoot()
      const below = join(root, "adversarial", "worktrees", "nested")
      await mkdir(join(below, "adversarial"), { recursive: true })
      await writeFile(join(below, name), "{}\n")
      const problem = await isolatedRootProblem(root, { marker: "required" })
      expect(problem, name).toContain(name)
      expect(problem, name).toContain("exists below it, so another experiment root is nested inside it")
    }
    // The adversarial subtree keeps no ledger of its own either.
    const root = await ownRoot()
    await writeFile(join(adversarialDirectory(root), JOURNAL_FILE), "")
    expect(await isolatedRootProblem(root, { marker: "required" })).toContain("exists below it")
  })

  test("a symlinked alias of a nested root is refused on its canonical path", async () => {
    const outer = await experimentRoot(scratch)
    const real = join(outer, "inner")
    await mkdir(real, { recursive: true })
    await writeFile(join(outer, JOURNAL_FILE), "")
    // The alias sits in a clean directory: only the canonical path is nested.
    const elsewhere = await experimentRoot(scratch)
    await mkdir(dirname(elsewhere), { recursive: true })
    await symlink(real, elsewhere)
    const problem = await isolatedRootProblem(elsewhere, { marker: "optional" })
    expect(problem).toContain(JOURNAL_FILE)
    expect(problem).toContain("exists above it")
  })

  test("a symlink below the root that reaches a directory outside it refuses, whatever its name and whatever that directory holds", async () => {
    // Another suite, with its schedule under its own adversarial/.
    const foreign = await ownRoot()
    const cases: [string, (root: string) => Promise<string>][] = [
      ["the link's name is not `adversarial`, and its target is another suite's adversarial/", async () => join(foreign, "adversarial")],
      [
        "a foreign root sits one level beneath the target",
        async () => {
          const outside = await experimentRoot(scratch)
          await mkdir(join(outside, "holder", "paired-root"), { recursive: true })
          await writeFile(join(outside, "holder", "paired-root", SCHEDULE_FILE), "{}\n")
          return join(outside, "holder")
        },
      ],
      [
        "the target holds nothing at all",
        async () => {
          const outside = await experimentRoot(scratch)
          await mkdir(outside, { recursive: true })
          return outside
        },
      ],
    ]
    for (const [name, targetOf] of cases) {
      const root = await ownRoot()
      const link = join(adversarialDirectory(root), "linked")
      await symlink(await targetOf(root), link)
      const problem = await isolatedRootProblem(root, { marker: "required" })
      expect(problem, name).toContain(`the symlink \`${join(await realpath(adversarialDirectory(root)), "linked")}\` below it reaches the directory`)
      expect(problem, name).toContain("outside the root, so what the root holds is not established")
    }
  })

  test("a symlink below the root that stays inside it, reaches a file, or reaches nothing does not refuse", async () => {
    const root = await ownRoot()
    const inside = join(adversarialDirectory(root), "worktrees", "adv-01-clean")
    await mkdir(join(inside, "src"), { recursive: true })
    await writeFile(join(inside, "src", "a.ts"), "x\n")
    await symlink(join(inside, "src"), join(inside, "alias"))
    await symlink(join(inside, "src", "a.ts"), join(inside, "a-link.ts"))
    await symlink(join(inside, "gone"), join(inside, "dangling"))
    expect(await isolatedRootProblem(root, { marker: "required" })).toBeNull()
  })

  test("evidence it cannot read refuses: an unlistable directory below, an unsearchable ancestor, an unresolvable root", async () => {
    const root = await ownRoot()
    const closed = join(adversarialDirectory(root), "closed")
    await mkdir(closed)
    await chmod(closed, 0o000)
    try {
      expect(await isolatedRootProblem(root, { marker: "required" })).toContain("could not be listed")
    } finally {
      await chmod(closed, 0o700)
    }

    // An ancestor this process may not search: the token rule stops quietly there, and this one refuses.
    const outer = await experimentRoot(scratch)
    const inner = join(outer, "inner")
    await mkdir(inner, { recursive: true })
    await chmod(outer, 0o000)
    try {
      const problem = await isolatedRootProblem(inner, { marker: "optional" })
      expect(problem).not.toBeNull()
      expect(problem).toContain("is not established")
    } finally {
      await chmod(outer, 0o700)
    }

    expect(await isolatedRootProblem(join(await experimentRoot(scratch), "never-made"), { marker: "optional" })).toContain(
      "its canonical path could not be resolved",
    )
  })

  test("an attempt-mode schedule is refused on a root that is not isolated, with nothing tossed", async () => {
    const outer = await experimentRoot(scratch)
    await mkdir(outer, { recursive: true })
    await writeFile(join(outer, SCHEDULE_FILE), "{}\n")
    let tossed = 0
    const refused = await createAdversarialSchedule({ ...(await attemptInput(join(outer, "inner"))), coin: () => ((tossed += 1), "heads") })
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.reason).toContain("cannot be the adversarial suite's own root (protocol v3 B5)")
      expect(refused.reason).toContain("nothing was tossed")
    }
    expect(tossed).toBe(0)
    // The token-mode schedule keeps v1's rule and is not checked against this one.
    const shared = await experimentRoot(scratch)
    await mkdir(shared, { recursive: true })
    await writeFile(join(shared, SCHEDULE_FILE), "{}\n")
    expect((await createAdversarialSchedule(input(shared))).ok).toBe(true)
  })
})

describe("the attempt-mode bill summary", () => {
  const base = {
    scheduleHash: "sha256:x",
    at: "t",
    adversarialKnown: 3,
    globalKnown: 3,
    overshoot: { global: { limit: 480, spent: 3, overshoot: 0 }, adversarial: { limit: 480, spent: 3, overshoot: 0 } },
    unknown: 0,
    uncertain: 0,
    inFlight: 0,
    refused: [],
    halt: null,
    stop: null,
    operational: [],
  }

  async function billAt(document: unknown) {
    const root = await experimentRoot(scratch)
    await mkdir(adversarialDirectory(root), { recursive: true })
    await writeFile(join(adversarialDirectory(root), ADVERSARIAL_BILL_FILE), typeof document === "string" ? document : JSON.stringify(document))
    return readAdversarialBill(root)
  }

  test("an attempt bill carries its per-run rows and its not-issued count; one without them, or naming another accounting, is unreadable", async () => {
    const attempt = { ...base, accounting: "attempts", runs: [{ runId: "run-1", limit: 30, spent: 3, overshoot: 0 }], notIssued: 0 }
    expect(await billAt(attempt)).toMatchObject({ kind: "read", bill: { accounting: "attempts" } })
    expect(await billAt(base)).toMatchObject({ kind: "read" })
    for (const broken of [{ ...attempt, runs: undefined }, { ...attempt, notIssued: undefined }, { ...base, accounting: "requests" }]) {
      expect(await billAt(broken)).toMatchObject({ kind: "unreadable" })
    }
  })

  test("a malformed `refused` or `runs` entry makes an attempt bill unreadable", async () => {
    const attempt = { ...base, accounting: "attempts", runs: [{ runId: "run-1", limit: 30, spent: 3, overshoot: 0 }], notIssued: 0 }
    const refusal = { label: "adv-01 clean", stage: "judge", cause: "budget", reason: "the run's allowance is exhausted", attempt: 1 }
    expect(await billAt({ ...attempt, refused: [refusal] })).toMatchObject({ kind: "read" })
    expect(await billAt({ ...attempt, refused: [{ ...refusal, attempt: undefined }] })).toMatchObject({ kind: "read" })
    const broken: unknown[] = [
      { ...attempt, refused: [null] },
      { ...attempt, refused: ["adv-01 clean"] },
      { ...attempt, refused: [{ ...refusal, label: undefined }] },
      { ...attempt, refused: [{ ...refusal, stage: 3 }] },
      { ...attempt, refused: [{ ...refusal, cause: null }] },
      { ...attempt, refused: [{ ...refusal, reason: undefined }] },
      { ...attempt, refused: [{ ...refusal, attempt: "1" }] },
      { ...attempt, runs: [null] },
      { ...attempt, runs: [{ runId: "", limit: 30, spent: 3, overshoot: 0 }] },
      { ...attempt, runs: [{ runId: "run-1", limit: "30", spent: 3, overshoot: 0 }] },
      { ...attempt, runs: [{ runId: "run-1", limit: 30, overshoot: 0 }] },
    ]
    for (const document of broken) expect(await billAt(document), JSON.stringify(document)).toMatchObject({ kind: "unreadable" })
  })

  test("a bill with no `refused` list is unreadable, never a bill with no refusals", async () => {
    expect(await billAt({ ...base, refused: undefined })).toMatchObject({ kind: "unreadable" })
    expect(await billAt("{ torn")).toMatchObject({ kind: "unreadable" })
  })
})
