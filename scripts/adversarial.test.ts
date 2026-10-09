/**
 * Story 2-7f — `bun run adversarial`, the OAuth adversarial launcher, driven
 * through its `main(argv, overrides)` seam over real git in temp directories.
 *
 * Every managed host here is a scripted stand-in that starts no process, every
 * backend is the scripted adversarial backend, and every roster check reads an
 * injected candidate list: no test starts opencode, reads a credential, opens a
 * model session or sends a provider request. The run path behind the checks is
 * reached only with injected CLOSED gates, an injected run whose pin is chosen
 * and a temporary frozen copy of protocol v3; the shipped table refuses.
 */

import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import type { OpencodeBackendOptions } from "../adapters/opencode/model-backend.ts"
import { worktreeFor } from "../ablation/adversarial.ts"
import { spawnGit, type RunGit } from "../ablation/adversarial-materialize.ts"
import { frozenV3Copy, scriptedAdversarialBackend, type ScriptedAdversarial } from "../ablation/adversarial-read.fixture.ts"
import {
  ADVERSARIAL_BILL_FILE,
  ADVERSARIAL_START_MARKER_FILE,
  adversarialDirectory,
  adversarialSlots,
  readAdversarialSlotStatuses,
} from "../ablation/adversarial-schedule.ts"
import { MEASURED_HOST, type ManagedHostOptions, type ManagedHostStart, type StopOutcome } from "../ablation/managed-host.ts"
import { fakeAuthLink, fakePrepared } from "../ablation/oauth-payload.fixture.ts"
import { ADVERSARIAL_RUN, PAIRED_GATES, type PairedGate } from "../ablation/paired-gates.ts"
import type { CoinFace } from "../ablation/schedule.ts"
import { candidate, fakeClock } from "../core/test-support/fakes.ts"
import { ADVERSARIAL_CASES } from "../fixtures/adversarial/material.ts"
import {
  ADVERSARIAL_HOST_TOOLS,
  ADVERSARIAL_HOSTS_FILE,
  adversarialRoster,
  gitReservationSeam,
  hostRosterProblems,
  main,
  oauthHostLifecycle,
  parseAdversarialFlags,
  rootRecheckProblems,
  stopEstablished,
  type AdversarialOverrides,
  type HostRecord,
} from "./adversarial.ts"
import { boundedGit, preflightSpawn, type SignalSource } from "./paired.ts"

const REPO_ROOT = resolve(import.meta.dir, "..")
const HERE = process.cwd()
const scratch: string[] = []
afterEach(async () => {
  // `opencodeTools` rebinds Bun's shared `$` to each worktree; restore it.
  $.cwd(HERE)
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-adversarial-cli-"))
  scratch.push(dir)
  return dir
}

async function captured(run: () => Promise<number>): Promise<{ code: number; text: string }> {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "))
  }
  try {
    return { code: await run(), text: lines.join("\n") }
  } finally {
    console.log = original
  }
}

const PIN = "anthropic/claude-sonnet-5"
const COINS: CoinFace[] = ["heads", "tails", "heads", "tails"]
const SLOTS = adversarialSlots(
  ADVERSARIAL_CASES.map((material) => material.id),
  COINS,
)

const argvFor = (env: { prepared: string; dataRoot: string; out: string }, extra: string[] = []) => [
  "bun",
  "scripts/adversarial.ts",
  "--live",
  "--provider-mode",
  "oauth",
  "--oauth-provider",
  "anthropic",
  "--pin",
  PIN,
  "--oauth-prepared",
  env.prepared,
  "--oauth-data-root",
  env.dataRoot,
  "--out",
  env.out,
  ...extra,
]

async function setup() {
  const parent = await tempDir()
  const { prepared, pins } = await fakePrepared(parent)
  const { home, target } = await fakeAuthLink(parent)
  return { parent, prepared, pins, home, target, out: join(parent, "experiment"), dataRoot: join(parent, "data-root"), reservationRoot: join(parent, "reservation-root") }
}

const closedGates: readonly PairedGate[] = PAIRED_GATES.map((gate) => ({
  ...gate,
  status: "CLOSED" as const,
  evidence: gate.evidence ?? "injected by scripts/adversarial.test.ts",
}))

/** A managed host that starts no process: each start records its options, each stop its count, and `postStop` is scripted. */
function scriptedHosts(
  script: {
    /** A refusal before anything is spawned: `onSpawn` is never called. */
    preSpawn?: (position: number) => ManagedHostStart | "throw" | undefined
    start?: (position: number, asked: ManagedHostOptions) => ManagedHostStart | "throw" | undefined | Promise<ManagedHostStart | "throw" | undefined>
    stop?: (position: number) => StopOutcome | "throw" | undefined
    whileStopping?: (position: number) => void
  } = {},
) {
  const started: ManagedHostOptions[] = []
  const stops = new Map<number, number>()
  const positionOf = (asked: ManagedHostOptions) => (asked.mode === "oauth" ? Number(/run-(\d+)$/.exec(asked.oauth.dataDir)![1]) : 0)
  const startHost = async (asked: ManagedHostOptions): Promise<ManagedHostStart> => {
    started.push(asked)
    const position = positionOf(asked)
    const pid = 9000 + position
    const stop = async (): Promise<StopOutcome> => {
      stops.set(position, (stops.get(position) ?? 0) + 1)
      script.whileStopping?.(position)
      const scripted = script.stop?.(position)
      if (scripted === "throw") throw new Error("the scripted stop exploded")
      return scripted ?? { confirmed: true, pid, how: "exited (status 143) after SIGTERM", postStop: { held: ["the auth symlink is intact"], problems: [] } }
    }
    const refused = script.preSpawn?.(position)
    if (refused === "throw") throw new Error("the scripted start exploded before any spawn")
    if (refused !== undefined) return refused
    asked.onSpawn?.({ pid, stop })
    const scripted = await script.start?.(position, asked)
    if (scripted === "throw") throw new Error("the scripted start exploded")
    if (scripted !== undefined) return scripted
    return {
      ok: true,
      host: {
        url: `http://127.0.0.1:${47100 + position}`,
        pid,
        binary: "/opt/opencode",
        sha256: MEASURED_HOST.sha256,
        version: MEASURED_HOST.version,
        config: {},
        reportedConfig: {},
        environmentKeys: [],
        pluginInstall: async () => ({ installed: true, version: "1.18.5" }),
        stop,
      },
    }
  }
  return { startHost, started, stops }
}

function signalSource(): SignalSource & { emit(signal: "SIGINT" | "SIGTERM"): void; listening(): number } {
  const handlers = new Set<() => void>()
  return {
    on: (_signal, handler) => handlers.add(handler),
    off: (_signal, handler) => handlers.delete(handler),
    emit: () => {
      for (const handler of [...handlers]) handler()
    },
    listening: () => handlers.size,
  }
}

/** Everything a run that gets past stage 1 needs, all stand-ins, with the backends each run was given. */
async function runnable(env: Awaited<ReturnType<typeof setup>>, extra: AdversarialOverrides & { script?: ScriptedAdversarial } = {}) {
  const { script, ...rest } = extra
  const scripted = scriptedAdversarialBackend(script)
  const backends: OpencodeBackendOptions[] = []
  const hosts = scriptedHosts()
  const signals = signalSource()
  const overrides: AdversarialOverrides = {
    gates: closedGates,
    adversarialRun: { ...ADVERSARIAL_RUN, pins: [PIN] },
    protocolV3File: (await frozenV3Copy(scratch)).file,
    payloadPins: env.pins,
    home: env.home,
    startHost: hosts.startHost,
    createClient: (init) => ({ fake: init }),
    enumerate: async () => [candidate("anthropic", "claude-sonnet-5")],
    createBackend: (options) => {
      backends.push(options)
      const position = Number(/^run-(\d+)\//.exec(options.executionIdPrefix ?? "")![1])
      const slot = SLOTS.find((entry) => entry.position === position)!
      return scripted.backendFor({ caseId: slot.caseId, side: slot.side, position }, options.lateUsage!)
    },
    clock: fakeClock(),
    coin: (() => {
      const coins = [...COINS]
      return () => coins.shift()!
    })(),
    codeRevision: async () => ({ kind: "known", value: { commit: "abc123", dirty: false } }),
    gateTable: async () => ({ ok: true, blob: "0123456789abcdef0123456789abcdef01234567" }),
    reservation: { root: env.reservationRoot, committed: async () => false },
    signals,
    ...rest,
  }
  return { overrides, hosts, backends, calls: scripted.calls, signals }
}

async function hostRecords(out: string): Promise<HostRecord[]> {
  const file = join(adversarialDirectory(out), ADVERSARIAL_HOSTS_FILE)
  if (!existsSync(file)) return []
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as HostRecord)
}

const startedPositions = (hosts: ReturnType<typeof scriptedHosts>) => hosts.started.map((asked) => (asked.mode === "oauth" ? Number(/run-(\d+)$/.exec(asked.oauth.dataDir)![1]) : 0))

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

describe("the flags", () => {
  const env = { prepared: "/p", dataRoot: "/d", out: "/o" }
  test("valid flags give the provider, the pin and the three absolute paths", () => {
    const parsed = parseAdversarialFlags(argvFor(env))
    expect(parsed.problems).toEqual([])
    expect(parsed).toMatchObject({ provider: "anthropic", pin: { providerId: "anthropic", modelId: "claude-sonnet-5" }, prepared: "/p", dataRoot: "/d", out: "/o" })
  })

  test("api-key, --server, --target and --directory are refused at parse, and so are the api-key credential flags", () => {
    const apiKey = parseAdversarialFlags(argvFor(env).map((arg) => (arg === "oauth" ? "api-key" : arg)))
    expect(apiKey.problems.join("\n")).toContain("--provider-mode api-key is refused: the adversarial suite runs on the OAuth route only")
    for (const [flag, why] of [
      ["--server", "--server is refused"],
      ["--target", "--target is refused"],
      ["--directory", "--directory is refused"],
      ["--provider-url", "--provider-url belongs to the api-key route"],
      ["--oauth-data-dir", "this command takes --oauth-data-root"],
    ] as const) {
      expect(parseAdversarialFlags(argvFor(env, [flag, "/x"])).problems.join("\n"), flag).toContain(why)
    }
  })

  test("one provider, one pin served by it, and absolute paths", () => {
    expect(parseAdversarialFlags(argvFor(env, ["--pin", "anthropic/other"])).problems.join("\n")).toContain("--pin was given 2 times")
    expect(parseAdversarialFlags(argvFor(env, ["--oauth-provider", "openai"])).problems.join("\n")).toContain("--oauth-provider was given 2 times")
    const elsewhere = parseAdversarialFlags(argvFor(env).map((arg) => (arg === PIN ? "openai/gpt-6-sol" : arg)))
    expect(elsewhere.problems.join("\n")).toContain("names a provider that is not the --oauth-provider `anthropic`")
    expect(parseAdversarialFlags(argvFor({ ...env, out: "relative" })).problems.join("\n")).toContain("--out must be an absolute path")
    expect(parseAdversarialFlags(["bun", "x"]).problems.join("\n")).toContain("--live is required")
  })
})

// ---------------------------------------------------------------------------
// Stage 1
// ---------------------------------------------------------------------------

describe("stage 1 on the shipped tree", () => {
  test("every check prints, it exits 1, and nothing exists under --out, the data root or the reservation root; no host starts", async () => {
    const env = await setup()
    const hosts = scriptedHosts()
    const overrides: AdversarialOverrides = {
      payloadPins: env.pins,
      home: env.home,
      startHost: hosts.startHost,
      reservation: { root: env.reservationRoot, committed: async () => false },
      signals: signalSource(),
    }
    const result = await captured(() => main(argvFor(env), overrides))
    expect(result.code).toBe(1)
    for (const check of [
      "PASS  flags",
      "PASS  --out containment",
      "PASS  --oauth-data-root containment",
      "PASS  experiment root",
      "PASS  OAuth data root",
      "PASS  disjoint directories",
      "FAIL  frozen protocol v3",
      "gate table committed",
      "FAIL  adversarial gates (ablation/paired-gates.ts, phase adversarial, route oauth)",
      "PASS  OAuth route",
      "PASS  OAuth prepared payloads",
      "FAIL  authorized adversarial run",
      "PASS  production Tools wiring",
    ]) {
      expect(result.text, check).toContain(check)
    }
    const diagnostic = result.text.slice(result.text.indexOf("REFUSED at stage 1 (offline checks)."))
    expect(diagnostic).toContain("protocol v3 is not frozen")
    expect(diagnostic).toContain("gate 10 (adversarial spend authorization) is OPEN")
    expect(diagnostic).toContain("gate 11 (adversarial attempt accounting) is OPEN; owner: story 2-7f2")
    expect(diagnostic).toContain("`ADVERSARIAL_RUN.pins` is null")
    // Item 7 is resolved, so it is no refusal.
    expect(diagnostic).not.toContain("candidate non-gate 7")
    expect(hosts.started).toEqual([])
    for (const path of [env.out, env.dataRoot, env.reservationRoot]) expect(existsSync(path), path).toBe(false)
    expect(existsSync(join(REPO_ROOT, ADVERSARIAL_RUN.reservation))).toBe(false)
  })

  test("a reservation that already exists refuses at stage 1, before any host", async () => {
    const env = await setup()
    await mkdir(dirname(join(env.reservationRoot, ADVERSARIAL_RUN.reservation)), { recursive: true })
    await writeFile(join(env.reservationRoot, ADVERSARIAL_RUN.reservation), "{}\n")
    const { overrides, hosts } = await runnable(env)
    const result = await captured(() => main(argvFor(env), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("FAIL  authorized adversarial run")
    expect(result.text).toContain(`the reservation \`${ADVERSARIAL_RUN.reservation}\` already exists`)
    expect(hosts.started).toEqual([])
    expect(existsSync(env.out)).toBe(false)
  })

  test("a reservation committed at HEAD, a missing prior run, a pin that is not the run's, and a non-empty data root each refuse", async () => {
    const env = await setup()
    const { overrides, hosts } = await runnable(env, {
      reservation: { root: env.reservationRoot, committed: async (relative) => relative === ADVERSARIAL_RUN.reservation },
      adversarialRun: { run: 2, pins: ["anthropic/other"], reservation: "ablation/evidence/adversarial-oauth-run-2.reservation", prior: [{ run: 1, reservation: ADVERSARIAL_RUN.reservation, evidence: "ablation/evidence/adversarial-oauth-run-1-x.json" }] },
    })
    await mkdir(join(env.dataRoot, "leftover"), { recursive: true })
    const result = await captured(() => main(argvFor(env), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("is not the roster adversarial run 2 names: anthropic/other")
    expect(result.text).toContain("run 1's evidence `ablation/evidence/adversarial-oauth-run-1-x.json` is not committed at HEAD")
    expect(result.text).toContain("is not empty (1 entries)")
    expect(hosts.started).toEqual([])
  })

  test("the data root may not overlap --out, the prepared directory or the user's own store", async () => {
    const env = await setup()
    const { overrides } = await runnable(env)
    const inside = await captured(() => main(argvFor({ ...env, dataRoot: join(env.out, "data") }), overrides))
    expect(inside.code).toBe(1)
    expect(inside.text).toContain("FAIL  disjoint directories")
    const store = await captured(() => main(argvFor({ ...env, dataRoot: join(env.home, ".local", "share", "opencode", "mad") }), overrides))
    expect(store.text).toContain("inside the user's own opencode data directory")
  })
})

// ---------------------------------------------------------------------------
// The run path, on stand-ins
// ---------------------------------------------------------------------------

describe("the run path: all sixteen worktrees, then one host per run", () => {
  test("happy: sixteen worktrees exist before host 1; sixteen starts and stops in order, each with its own data directory and worktree; the backend is offered StructuredOutput only", async () => {
    const env = await setup()
    let atFirstStart: boolean[] | undefined
    const { overrides, hosts, backends } = await runnable(env)
    const start = hosts.startHost
    overrides.startHost = async (asked) => {
      atFirstStart ??= SLOTS.map((slot) => existsSync(worktreeFor(env.out, slot)))
      return start(asked)
    }
    const result = await captured(() => main(argvFor(env), overrides))
    expect(result.text).toContain("The suite reads `complete: true`")
    expect(result.code).toBe(0)
    expect(atFirstStart).toEqual(Array.from({ length: 16 }, () => true))
    expect(startedPositions(hosts)).toEqual(SLOTS.map((slot) => slot.position))
    for (const [index, asked] of hosts.started.entries()) {
      const slot = SLOTS[index]!
      if (asked.mode !== "oauth") throw new Error("not an OAuth start")
      expect(asked.oauth.dataDir).toBe(join(env.dataRoot, `run-${slot.position}`))
      expect(asked.oauth.providers).toEqual(["anthropic"])
      expect(asked.oauth.models).toEqual([{ providerId: "anthropic", modelId: "claude-sonnet-5" }])
      expect(asked.verifyDirectories).toEqual([worktreeFor(env.out, slot)])
      expect(asked.signals).toBeNull()
      expect(hosts.stops.get(slot.position)).toBe(1)
      // The data directory holds only the auth symlink, pointing at the sign-ins, which were never read.
      expect(await readdir(asked.oauth.dataDir)).toEqual(["opencode"])
      expect(await readdir(join(asked.oauth.dataDir, "opencode"))).toEqual(["auth.json"])
      expect((await lstat(join(asked.oauth.dataDir, "opencode", "auth.json"))).isSymbolicLink()).toBe(true)
      expect(await readlink(join(asked.oauth.dataDir, "opencode", "auth.json"))).toBe(env.target)
    }
    expect(backends).toHaveLength(16)
    // The offer each backend is given is the sealed config's, exactly.
    const sealed = JSON.parse(await readFile(join(adversarialDirectory(env.out), "adversarial-schedule.json"), "utf8")) as { config: { hostTools: unknown } }
    for (const options of backends) expect(options.tools).toEqual(sealed.config.hostTools as Record<string, boolean>)
    expect(sealed.config.hostTools).toEqual({ "*": false, StructuredOutput: true })
    expect(ADVERSARIAL_HOST_TOOLS).toEqual({ "*": false, StructuredOutput: true })
    // One host record per start, verify, stop and post-stop outcome, each naming the schedule and the slot.
    const records = await hostRecords(env.out)
    expect(records.map((line) => `${line.position} ${line.event} ${line.ok}`)).toEqual(
      SLOTS.flatMap((slot) => ["start", "verify", "stop", "postStop"].map((event) => `${slot.position} ${event} true`)),
    )
    const schedule = JSON.parse(await readFile(join(adversarialDirectory(env.out), "adversarial-schedule.json"), "utf8")) as { scheduleHash: string; config: Record<string, unknown> }
    expect(records.every((line) => line.scheduleHash === schedule.scheduleHash)).toBe(true)
    expect(schedule.config).toMatchObject({ accounting: "attempts", route: "oauth", hostTools: { "*": false, StructuredOutput: true }, hostIsolation: "fresh-per-run", provenance: "live" })
    // The reservation is made, in the injected root only.
    expect(existsSync(join(env.reservationRoot, ADVERSARIAL_RUN.reservation))).toBe(true)
  }, 120_000)

  test("a confirmed git failure fails only its slot; the others run, each on its own host", async () => {
    const env = await setup()
    const git: RunGit = (cwd, args, stdin) =>
      cwd.endsWith("adv-02-attack") && args[0] === "apply" ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "scripted apply failure" }) : spawnGit(cwd, args, stdin)
    const { overrides, hosts } = await runnable(env, { materializeGit: git })
    const result = await captured(() => main(argvFor(env), overrides))
    expect(result.code).toBe(1)
    const failed = SLOTS.find((slot) => slot.caseId === "adv-02" && slot.side === "attack")!
    expect(result.text).toContain(`${failed.position} adv-02 attack: failed — the adv-02 attack worktree could not be written`)
    expect(startedPositions(hosts)).toEqual(SLOTS.filter((slot) => slot !== failed).map((slot) => slot.position))
  }, 120_000)

  test("an unconfirmed git quarantines before any host: that slot failed, the rest not attempted, zero starts, the lock retained", async () => {
    const env = await setup()
    const git: RunGit = (cwd, args, stdin) =>
      cwd.endsWith("adv-02-attack") && args[0] === "apply"
        ? Promise.resolve({ exitCode: null, termination: "unconfirmed", reason: "scripted unconfirmed termination — check process 5252 by hand" })
        : spawnGit(cwd, args, stdin)
    const { overrides, hosts } = await runnable(env, { materializeGit: git })
    const result = await captured(() => main(argvFor(env), overrides))
    expect(result.code).toBe(1)
    expect(hosts.started).toEqual([])
    expect(result.text).toContain("lock was NOT released")
    const statuses = await readAdversarialSlotStatuses(env.out)
    expect(statuses.filter((line) => line.status === "failed")).toHaveLength(1)
    expect(statuses.filter((line) => line.status === "not-attempted")).toHaveLength(15)
  }, 60_000)

  // `stops`: how many times the stand-in's own stop was called. A failed start that returns
  // its own stop outcome is not stopped a second time; one that threw after its spawn is.
  for (const [name, spawns, start, why, stops] of [
    ["is refused before its spawn", false, { ok: false, reason: "the prepared directory is refused: scripted", stopped: null } as ManagedHostStart, "its cleanup: no host was started", undefined],
    [
      "throws before any spawn is reported",
      false,
      "throw" as const,
      "ITS CLEANUP IS NOT ESTABLISHED: the start threw before any spawn was reported, so whether it left a process running is not established",
      undefined,
    ],
    ["throws after its spawn", true, "throw" as const, "the managed host could not be started: the scripted start exploded", 1],
    [
      "fails its verification after the spawn",
      true,
      { ok: false, reason: "`GET /config` for the worktree had no answer", stopped: { confirmed: true, pid: 9003, how: "exited (status 143) after SIGKILL", postStop: { held: ["the auth symlink is intact"], problems: [] } } } as ManagedHostStart,
      "its cleanup: process 9003 exited (status 143) after SIGKILL; after the stop: the auth symlink is intact",
      undefined,
    ],
  ] as const) {
    test(`a start that ${name} at run 3: its cleanup is reported, slot 3 fails, the runner stops and no further host starts`, async () => {
      const env = await setup()
      const { overrides, hosts } = await runnable(env)
      const third = SLOTS[2]!.position
      const scripted = spawns
        ? scriptedHosts({ start: (position) => (position === third ? start : undefined) })
        : scriptedHosts({ preSpawn: (position) => (position === third ? (start as ManagedHostStart | "throw") : undefined) })
      overrides.startHost = scripted.startHost
      const result = await captured(() => main(argvFor(env), overrides))
      expect(result.code).toBe(1)
      expect(startedPositions(scripted)).toEqual(SLOTS.slice(0, 3).map((slot) => slot.position))
      expect(result.text).toContain(`${SLOTS[2]!.position} ${SLOTS[2]!.caseId} ${SLOTS[2]!.side}: failed — the ${SLOTS[2]!.caseId} ${SLOTS[2]!.side} host did not start`)
      expect(result.text).toContain(why)
      expect(result.text).toMatch(new RegExp(`${SLOTS[3]!.position} ${SLOTS[3]!.caseId} ${SLOTS[3]!.side}: not-attempted`))
      expect(scripted.stops.get(third)).toBe(stops)
      expect(hosts.started).toEqual([])
      const records = await hostRecords(env.out)
      const third_ = records.filter((line) => line.position === third)
      expect(third_.filter((line) => line.event === "start").map((line) => line.ok)).toEqual([false])
      // No process id is known before a spawn: `null`, never 0.
      expect(third_.find((line) => line.event === "start")!.pid).toBe(spawns ? 9000 + third : null)
      // A spawned host's stop is recorded once, from the outcome its start returned or from the one stop sent.
      expect(third_.map((line) => line.event)).toEqual(spawns ? ["start", "stop", "postStop"] : ["start"])
    }, 60_000)
  }

  test("a host whose roster does not verify is stopped and checked, and the runner stops", async () => {
    const env = await setup()
    let calls = 0
    const { overrides, hosts } = await runnable(env, {
      enumerate: async () => {
        calls += 1
        return calls === 2 ? [candidate("anthropic", "claude-sonnet-5", false)] : [candidate("anthropic", "claude-sonnet-5")]
      },
    })
    const result = await captured(() => main(argvFor(env), overrides))
    expect(result.code).toBe(1)
    expect(startedPositions(hosts)).toEqual(SLOTS.slice(0, 2).map((slot) => slot.position))
    expect(hosts.stops.get(SLOTS[1]!.position)).toBe(1)
    expect(result.text).toContain("failed its verification")
    const records = await hostRecords(env.out)
    expect(records.filter((line) => line.position === SLOTS[1]!.position).map((line) => `${line.event} ${line.ok}`)).toEqual(["start true", "verify false", "stop true", "postStop true"])
  }, 60_000)

  test("a backend factory that throws with the host up: the host is stopped and checked, and the runner stops", async () => {
    const env = await setup()
    const { overrides, hosts } = await runnable(env)
    const create = overrides.createBackend!
    overrides.createBackend = (options) => {
      if (options.executionIdPrefix === `run-${SLOTS[1]!.position}/`) throw new Error("the scripted backend factory exploded")
      return create(options)
    }
    const result = await captured(() => main(argvFor(env), overrides))
    expect(result.code).toBe(1)
    expect(startedPositions(hosts)).toEqual(SLOTS.slice(0, 2).map((slot) => slot.position))
    expect(hosts.stops.get(SLOTS[1]!.position)).toBe(1)
    expect(result.text).toContain("the scripted backend factory exploded")
  }, 60_000)

  for (const [name, stop, why] of [
    ["unconfirmed", { confirmed: false, pid: 9002, why: "it did not exit after SIGKILL" } as StopOutcome, "the stop of process 9002 is UNCONFIRMED"],
    ["thrown", "throw" as const, "the stop rejected: the scripted stop exploded"],
    ["missing its post-stop checks", { confirmed: true, pid: 9002, how: "exited after SIGTERM" } as StopOutcome, "no post-stop checks were returned, so post-stop verification is missing"],
    ["with a post-stop problem", { confirmed: true, pid: 9002, how: "exited after SIGTERM", postStop: { held: [], problems: ["the auth symlink was replaced"] } } as StopOutcome, "a post-stop check failed: the auth symlink was replaced"],
  ] as const) {
    test(`a stop ${name} at run 2: the review evidence is kept, slot 2 fails, the pid and data directory are reported, and no further host starts`, async () => {
      const env = await setup()
      const { overrides } = await runnable(env)
      const scripted = scriptedHosts({ stop: (position) => (position === SLOTS[1]!.position ? stop : undefined) })
      overrides.startHost = scripted.startHost
      const result = await captured(() => main(argvFor(env), overrides))
      expect(result.code).toBe(1)
      expect(startedPositions(scripted)).toEqual(SLOTS.slice(0, 2).map((slot) => slot.position))
      expect(result.text).toContain(why)
      expect(result.text).toContain("HOST STOP NOT ESTABLISHED")
      expect(result.text).toContain(join(env.dataRoot, `run-${SLOTS[1]!.position}`))
      expect(result.text).toContain(`${SLOTS[1]!.position} ${SLOTS[1]!.caseId} ${SLOTS[1]!.side}: failed — the ${SLOTS[1]!.caseId} ${SLOTS[1]!.side} run finished; its evidence is kept`)
      // The data directory is retained.
      expect(existsSync(join(env.dataRoot, `run-${SLOTS[1]!.position}`, "opencode", "auth.json"))).toBe(true)
      const manifests = await readdir(join(adversarialDirectory(env.out), SLOTS[1]!.side, String(SLOTS[1]!.caseIndex)))
      expect(manifests).toHaveLength(1)
    }, 60_000)
  }

  for (const [where, failing] of [
    ["the start record once the host is acquired", (line: HostRecord) => line.event === "start" && line.ok],
    ["a terminal post-stop record", (line: HostRecord) => line.event === "postStop"],
  ] as const) {
    test(`a failed append of ${where}: the host is cleaned up, nothing further starts, the record is named, exit 1`, async () => {
      const env = await setup()
      const target = SLOTS[1]!.position
      const { overrides, hosts } = await runnable(env)
      const { appendHostRecord } = await import("./adversarial.ts")
      overrides.appendHostRecord = async (file, line) =>
        line.position === target && failing(line) ? "the host record could not be appended: scripted ENOSPC" : appendHostRecord(file, line)
      const result = await captured(() => main(argvFor(env), overrides))
      expect(result.code).toBe(1)
      expect(startedPositions(hosts)).toEqual(SLOTS.slice(0, 2).map((slot) => slot.position))
      expect(hosts.stops.get(target)).toBe(1)
      expect(result.text).toContain("HOST RECORD INCOMPLETE")
      expect(result.text).toMatch(new RegExp(`the (start|postStop) record of run ${target} \\(${SLOTS[1]!.caseId} ${SLOTS[1]!.side}\\) was not persisted: the host record could not be appended: scripted ENOSPC`))
      expect(result.text).toContain("not a complete disclosure")
      expect(result.text).not.toContain("complete: true")
    }, 60_000)
  }
})

describe("SIGINT and SIGTERM are the launcher's", () => {
  for (const [during, arrange] of [
    [
      "a host's start",
      (signals: ReturnType<typeof signalSource>) => ({
        startHost: scriptedHosts({
          start: (position) => {
            if (position === SLOTS[1]!.position) signals.emit("SIGINT")
            return undefined
          },
        }),
      }),
    ],
    [
      "a run",
      (signals: ReturnType<typeof signalSource>) => ({
        startHost: scriptedHosts(),
        script: {
          onCall: (context: { position: number }) => {
            if (context.position === SLOTS[1]!.position) signals.emit("SIGTERM")
          },
        },
      }),
    ],
    [
      "a host's cleanup",
      (signals: ReturnType<typeof signalSource>) => ({
        startHost: scriptedHosts({
          whileStopping: (position) => {
            if (position === SLOTS[1]!.position) signals.emit("SIGINT")
          },
        }),
      }),
    ],
  ] as const) {
    test(`an interrupt during ${during}: that host is stopped once, the final records are written, no further host starts, exit 1`, async () => {
      const env = await setup()
      const signals = signalSource()
      const arranged = arrange(signals)
      const { overrides } = await runnable(env, { signals, ...("script" in arranged ? { script: arranged.script as ScriptedAdversarial } : {}) })
      overrides.startHost = arranged.startHost.startHost
      const result = await captured(() => main(argvFor(env), overrides))
      expect(result.code).toBe(1)
      expect(result.text).toContain("INTERRUPTED")
      expect(startedPositions(arranged.startHost)).toEqual(SLOTS.slice(0, 2).map((slot) => slot.position))
      expect(arranged.startHost.stops.get(SLOTS[1]!.position)).toBe(1)
      expect(existsSync(join(adversarialDirectory(env.out), ADVERSARIAL_BILL_FILE))).toBe(true)
      const statuses = await readAdversarialSlotStatuses(env.out)
      expect(statuses.filter((line) => line.status === "not-attempted")).toHaveLength(14)
      const records = await hostRecords(env.out)
      expect(records.filter((line) => line.position === SLOTS[1]!.position && (line.event === "stop" || line.event === "postStop"))).toHaveLength(2)
      expect(signals.listening()).toBe(0)
    }, 60_000)
  }
})

describe("a cancellation around a host's start", () => {
  for (const [timing, arrange] of [
    ["before its spawn", (signals: ReturnType<typeof signalSource>, target: number) => scriptedHosts({ preSpawn: (position) => (position === target ? (signals.emit("SIGINT"), undefined) : undefined) })],
    ["after its spawn, before it returns", (signals: ReturnType<typeof signalSource>, target: number) => scriptedHosts({ start: (position) => (position === target ? (signals.emit("SIGINT"), undefined) : undefined) })],
  ] as const) {
    test(`a signal ${timing}: the host the start returns is stopped once, before any review, and the slot reads cancelled`, async () => {
      const env = await setup()
      const signals = signalSource()
      const target = SLOTS[1]!.position
      const scripted = arrange(signals, target)
      const { overrides, calls } = await runnable(env, { signals })
      overrides.startHost = scripted.startHost
      const result = await captured(() => main(argvFor(env), overrides))
      expect(result.code).toBe(1)
      expect(startedPositions(scripted)).toEqual([SLOTS[0]!.position, target])
      expect(scripted.stops.get(target)).toBe(1)
      expect(calls.some((call) => call.position === target)).toBe(false)
      const statuses = await readAdversarialSlotStatuses(env.out)
      expect(statuses.filter((line) => line.position === target).map((line) => line.status)).toEqual(["started", "cancelled"])
      expect(statuses.filter((line) => line.status === "not-attempted")).toHaveLength(14)
      const records = await hostRecords(env.out)
      expect(records.filter((line) => line.position === target).map((line) => line.event)).toEqual(["start", "stop", "postStop"])
    }, 60_000)
  }

  test("the lifecycle starts nothing once the signal is set", async () => {
    const env = await setup()
    const { overrides } = await runnable(env)
    const hosts = oauthHostLifecycle({
      provider: "anthropic",
      pin: { providerId: "anthropic", modelId: "claude-sonnet-5" },
      prepared: env.prepared,
      dataRoot: env.dataRoot,
      home: env.home,
      payloadPins: env.pins,
      scheduleHash: "sha256:x",
      roster: adversarialRoster({ providerId: "anthropic", modelId: "claude-sonnet-5" }).roster,
      recordFile: join(env.parent, "hosts.jsonl"),
      clock: fakeClock(),
      requestMs: 1000,
      startHost: async () => {
        throw new Error("no host may start")
      },
      createClient: overrides.createClient!,
      enumerate: overrides.enumerate!,
      createBackend: overrides.createBackend!,
      append: async () => null,
    })
    const controller = new AbortController()
    controller.abort()
    const started = await hosts.lifecycle.start({ caseId: "adv-01", side: "clean", position: 1 }, "/w", controller.signal)
    expect(started).toEqual({ ok: false, reason: "the run was cancelled before this host was started", cleanup: { ok: true, detail: "no host was started" } })
    expect(existsSync(env.dataRoot)).toBe(false)
  })
})

describe("the roster read is bounded", () => {
  test("an enumerate that never answers is a verification failure: the host is stopped and checked, and the runner stops", async () => {
    const env = await setup()
    let calls = 0
    const { overrides, hosts } = await runnable(env, {
      hostRequestMs: 50,
      enumerate: (async () => {
        calls += 1
        return calls === 2 ? new Promise<never>(() => {}) : [candidate("anthropic", "claude-sonnet-5")]
      }) as AdversarialOverrides["enumerate"],
    })
    const result = await captured(() => main(argvFor(env), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("the host's roster read gave no answer within 50 ms")
    expect(startedPositions(hosts)).toEqual(SLOTS.slice(0, 2).map((slot) => slot.position))
    expect(hosts.stops.get(SLOTS[1]!.position)).toBe(1)
    const records = await hostRecords(env.out)
    expect(records.filter((line) => line.position === SLOTS[1]!.position).map((line) => `${line.event} ${line.ok}`)).toEqual(["start true", "verify false", "stop true", "postStop true"])
  }, 60_000)
})

describe("an interrupt before the suite", () => {
  test("SIGINT during stage 1, with every gate closed and a run named: exit 130, no reservation, nothing under --out or the data root", async () => {
    const env = await setup()
    const signals = signalSource()
    const { overrides, hosts } = await runnable(env, {
      signals,
      gateTable: async () => {
        signals.emit("SIGINT")
        return { ok: true, blob: "0123456789abcdef0123456789abcdef01234567" }
      },
    })
    const result = await captured(() => main(argvFor(env), overrides))
    expect(result.code).toBe(130)
    expect(existsSync(join(env.reservationRoot, ADVERSARIAL_RUN.reservation))).toBe(false)
    expect(existsSync(env.out)).toBe(false)
    expect(existsSync(env.dataRoot)).toBe(false)
    expect(hosts.started).toEqual([])
  })

  test("SIGINT after the reservation: exit 130, the reservation kept, no schedule, worktree or host", async () => {
    const env = await setup()
    const signals = signalSource()
    const { overrides, hosts } = await runnable(env, {
      signals,
      codeRevision: async () => {
        signals.emit("SIGINT")
        return { kind: "known", value: { commit: "abc123", dirty: false } }
      },
    })
    const result = await captured(() => main(argvFor(env), overrides))
    expect(result.code).toBe(130)
    expect(result.text).toContain("The reservation is kept")
    expect(existsSync(join(env.reservationRoot, ADVERSARIAL_RUN.reservation))).toBe(true)
    expect(existsSync(join(adversarialDirectory(env.out), "adversarial-schedule.json"))).toBe(false)
    expect(existsSync(join(adversarialDirectory(env.out), "worktrees"))).toBe(false)
    expect(hosts.started).toEqual([])
    // The reservation's timestamp is the injected clock's.
    const reservation = JSON.parse(await readFile(join(env.reservationRoot, ADVERSARIAL_RUN.reservation), "utf8")) as { createdAt: string }
    expect(reservation.createdAt).toBe(fakeClock().now())
  })

  test("a root that stops being fresh after stage 1 refuses at stage 3, before any root is created, saying the reservation is spent", async () => {
    const env = await setup()
    const { overrides, hosts } = await runnable(env, {
      codeRevision: async () => {
        await mkdir(join(env.out, "intruder"), { recursive: true })
        return { kind: "known", value: { commit: "abc123", dirty: false } }
      },
    })
    const result = await captured(() => main(argvFor(env), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("REFUSED at stage 3 (recheck of the roots)")
    expect(result.text).toContain("The reservation is already spent")
    expect(existsSync(env.dataRoot)).toBe(false)
    expect(hosts.started).toEqual([])
  })

  test("a root that cannot be created refuses at stage 3, saying the reservation is spent", async () => {
    const env = await setup()
    const locked = join(env.parent, "locked")
    await mkdir(locked)
    const { overrides, hosts } = await runnable(env, {
      codeRevision: async () => {
        // The parent of --out becomes unwritable after stage 1: --out is still absent, and its mkdir fails.
        await chmod(locked, 0o555)
        return { kind: "known", value: { commit: "abc123", dirty: false } }
      },
    })
    try {
      const result = await captured(() => main(argvFor({ ...env, out: join(locked, "experiment") }), overrides))
      expect(result.code).toBe(1)
      expect(result.text).toContain("REFUSED at stage 3: a root could not be created")
      expect(result.text).toContain("The reservation is already spent")
      expect(hosts.started).toEqual([])
    } finally {
      await chmod(locked, 0o755)
    }
  })
})

describe("stage 3's recheck of the roots includes containment (AD-16)", () => {
  /** A stand-in repository and a pointer symlink, all in a temp directory; the pointer starts at a safe directory. */
  async function redirectable() {
    const scratchDir = await tempDir()
    const repoRoot = join(scratchDir, "area", "experiment", "source-repo")
    const safe = join(scratchDir, "safe")
    const pointer = join(scratchDir, "pointer")
    await mkdir(repoRoot, { recursive: true })
    await mkdir(safe)
    await symlink(safe, pointer)
    const redirect = async (to: string) => {
      await unlink(pointer)
      await symlink(to, pointer)
    }
    return { scratchDir, repoRoot, safe, pointer, redirect, prepared: join(scratchDir, "prepared"), userStore: join(scratchDir, "home", ".local", "share", "opencode") }
  }

  for (const root of ["out", "dataRoot"] as const) {
    const flag = root === "out" ? "--out" : "--oauth-data-root"
    test(`${flag} redirected into the repository through an ancestor symlink after stage 1 is refused before any mkdir`, async () => {
      const env = await redirectable()
      const roots = {
        out: join(env.scratchDir, "out"),
        dataRoot: join(env.scratchDir, "data-root"),
        prepared: env.prepared,
        userStore: env.userStore,
        [root]: join(env.pointer, "experiment"),
      }
      // At stage 1 the pointer leads to a safe directory: nothing to refuse.
      expect(await rootRecheckProblems(roots, env.repoRoot)).toEqual([])
      // After stage 1 the ancestor is redirected into the repository.
      await env.redirect(env.repoRoot)
      const inside = await rootRecheckProblems(roots, env.repoRoot)
      expect(inside).toContain(`\`${roots[root]}\` is this repository, is inside it, or contains it (AD-16); name a directory outside it`)
      // And redirected so that the root contains the repository.
      await env.redirect(join(env.scratchDir, "area"))
      const containing = await rootRecheckProblems(roots, env.repoRoot)
      expect(containing).toContain(`\`${roots[root]}\` is this repository, is inside it, or contains it (AD-16); name a directory outside it`)
      // Nothing was created by the checks.
      expect(existsSync(join(env.repoRoot, "experiment"))).toBe(false)
      expect(await readdir(env.repoRoot)).toEqual([])
    })
  }

  test("a check that cannot be made is a problem, never a pass", async () => {
    const env = await redirectable()
    const locked = join(env.scratchDir, "locked")
    await mkdir(join(locked, "out"), { recursive: true })
    await chmod(locked, 0o000)
    try {
      const problems = await rootRecheckProblems({ out: join(locked, "out"), dataRoot: join(env.scratchDir, "data-root"), prepared: env.prepared, userStore: env.userStore }, env.repoRoot)
      expect(problems.some((problem) => problem.includes("could not be established"))).toBe(true)
    } finally {
      await chmod(locked, 0o755)
    }
  })

  test("the launcher's stage-3 refusal names the recheck, creates no root and says the reservation is spent", async () => {
    const env = await setup()
    const { overrides, hosts } = await runnable(env, {
      codeRevision: async () => {
        await mkdir(join(env.dataRoot, "intruder"), { recursive: true })
        return { kind: "known", value: { commit: "abc123", dirty: false } }
      },
    })
    const result = await captured(() => main(argvFor(env), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("REFUSED at stage 3 (recheck of the roots)")
    expect(result.text).toContain("No root, schedule or worktree was created and no host was started. The reservation is already spent")
    expect(existsSync(env.out)).toBe(false)
    expect(hosts.started).toEqual([])
  })
})

describe("the default reservation seam reads HEAD", () => {
  test("a committed file reads true and an absent one false, through the bounded git", async () => {
    const repoDir = await tempDir()
    const run = async (args: string[]) => {
      const spawned = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: repoDir, stdout: "pipe", stderr: "pipe" })
      if ((await spawned.exited) !== 0) throw new Error(await new Response(spawned.stderr).text())
    }
    await run(["init", "--quiet"])
    await mkdir(join(repoDir, "ablation", "evidence"), { recursive: true })
    await writeFile(join(repoDir, "ablation", "evidence", "committed.reservation"), "{}\n")
    await writeFile(join(repoDir, "ablation", "evidence", "untracked.reservation"), "{}\n")
    await run(["add", "ablation/evidence/committed.reservation"])
    await run(["commit", "--quiet", "-m", "one file"])
    const seam = gitReservationSeam(boundedGit({ spawn: preflightSpawn, deadlineMs: 60_000, cleanupMs: 5_000 }), repoDir)
    expect(seam.root).toBe(repoDir)
    expect(await seam.committed("ablation/evidence/committed.reservation")).toBe(true)
    expect(await seam.committed("ablation/evidence/untracked.reservation")).toBe(false)
    expect(await seam.committed("ablation/evidence/absent.reservation")).toBe(false)
    // A git that cannot answer throws rather than reading as "not committed".
    await expect(gitReservationSeam(boundedGit({ spawn: preflightSpawn, deadlineMs: 60_000, cleanupMs: 5_000 }), await tempDir()).committed("x")).rejects.toThrow("`git ls-tree` exited")
  })
})

describe("the lifecycle's helpers", () => {
  test("a stop is established only when confirmed with post-stop checks present and clean", () => {
    expect(stopEstablished(null, false, "/d")).toEqual({ ok: true, detail: "no host was started" })
    expect(stopEstablished(null, true, "/d").ok).toBe(false)
    expect(stopEstablished({ confirmed: true, pid: 1, how: "exited" }, true, "/d")).toMatchObject({ ok: false })
    expect(stopEstablished({ confirmed: false, pid: 1, why: "x" }, true, "/d")).toMatchObject({ ok: false })
    expect(stopEstablished({ confirmed: true, pid: 1, how: "exited", postStop: { held: ["ok"], problems: [] } }, true, "/d")).toMatchObject({ ok: true })
  })

  test("the roster is one slot with the pin, and a host that declares no tool capability does not verify", () => {
    const { roster } = adversarialRoster({ providerId: "anthropic", modelId: "claude-sonnet-5" })
    expect(roster.slots.map((slot) => `${slot.providerId}/${slot.modelId}`)).toEqual([PIN])
    expect(roster.lensSlots).toEqual([])
    const pin = { providerId: "anthropic", modelId: "claude-sonnet-5" }
    expect(hostRosterProblems([candidate("anthropic", "claude-sonnet-5"), candidate("anthropic", "claude-haiku-5")], pin, roster)).toEqual([])
    expect(hostRosterProblems([candidate("anthropic", "claude-sonnet-5", false)], pin, roster).length).toBeGreaterThan(0)
    expect(hostRosterProblems([candidate("anthropic", "claude-haiku-5")], pin, roster).length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Item 7: the review-path reads are not reached by this launcher
// ---------------------------------------------------------------------------

/**
 * `source` as code only: the TypeScript transpiled (comments and types gone),
 * then the text of every string literal, template literal and regular
 * expression literal removed, keeping `${…}` expressions. What remains is what
 * can call or name something.
 *
 * A `/` opens a regular expression where an expression may begin: at the start,
 * after an operator or opening punctuation, or after a keyword that takes an
 * operand. Anywhere else it divides.
 */
function codeOnly(source: string): string {
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source.replace(/^#!.*\n/, ""))
  let out = ""
  const stack: ("template" | "brace")[] = []
  const regexAfter = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|in|of|new|delete|void|throw|yield|await|else|do))\s*$/
  for (let index = 0; index < js.length; index += 1) {
    const char = js[index]!
    const top = stack.at(-1)
    if (top === "template") {
      if (char === "\\") index += 1
      else if (char === "`") {
        stack.pop()
        out += "`"
      } else if (char === "$" && js[index + 1] === "{") {
        stack.push("brace")
        index += 1
        out += "${"
      }
      continue
    }
    if (char === "'" || char === '"') {
      let end = index + 1
      while (end < js.length && js[end] !== char) end += js[end] === "\\" ? 2 : 1
      out += `${char}${char}`
      index = end
      continue
    }
    if (char === "`") {
      stack.push("template")
      out += "`"
      continue
    }
    if (char === "/" && regexAfter.test(out)) {
      let end = index + 1
      let inClass = false
      while (end < js.length && (inClass || js[end] !== "/")) {
        if (js[end] === "\\") end += 1
        else if (js[end] === "[") inClass = true
        else if (js[end] === "]") inClass = false
        end += 1
      }
      end += 1
      while (end < js.length && /[a-z]/i.test(js[end]!)) end += 1
      out += "/ /"
      index = end - 1
      continue
    }
    if (top === "brace" && char === "{") stack.push("brace")
    else if (top === "brace" && char === "}") {
      stack.pop()
      out += "}"
      continue
    }
    out += char
  }
  return out
}

/** Every relative import, static or dynamic, followed from `entry`; every non-relative specifier is listed, never skipped. */
async function importClosure(entry: string) {
  const transpiler = new Bun.Transpiler({ loader: "ts" })
  const sourceOf = async (file: string) => (await Bun.file(file).text()).replace(/^#!.*\n/, "")
  const importers = new Map<string, string[]>()
  const external = new Set<string>()
  const kinds = new Set<string>()
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const found of transpiler.scanImports(await sourceOf(file))) {
      kinds.add(found.kind)
      if (!found.path.startsWith(".")) {
        external.add(found.path)
        continue
      }
      const target = resolve(dirname(file), found.path)
      importers.set(target, [...(importers.get(target) ?? []), file])
      queue.push(target)
    }
  }
  return { seen, importers, external, kinds, sourceOf }
}

/** The index one past the `}` that closes the `{` at `open`, counted over code with every literal removed. */
function blockEnd(code: string, open: number): number {
  let depth = 0
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === "{") depth += 1
    else if (code[index] === "}" && --depth === 0) return index + 1
  }
  return -1
}

describe("item 7: the launcher's full closure never reaches the review-path reads", () => {
  const launcher = resolve(import.meta.dir, "adversarial.ts")
  const repo = resolve(REPO_ROOT, "adapters/opencode/repo.ts")
  const plugin = resolve(REPO_ROOT, "adapters/opencode/plugin.ts")
  const tools = resolve(REPO_ROOT, "adapters/opencode/tools.ts")
  const paired = resolve(import.meta.dir, "paired.ts")

  test("the code stripper keeps calls and drops comments, strings, templates and regular expressions", () => {
    expect(codeOnly('// opencodeRepo()\nconst a = "opencodeRepo"; const b = `x ${opencodeRepo({})} y`; repo.change(1)')).toContain("opencodeRepo({})")
    expect(codeOnly('const a = "opencodeRepo"; /* repo.change( */ const b = `repo.change(`')).not.toMatch(/opencodeRepo|repo\.change\(/)
    // A quote or a backtick inside a regular expression does not open a string.
    const regex = codeOnly('const r = /a"b\'c`d/g; const s = opencodeRepo(); const t = /[/"]/; repo.change(t)')
    expect(regex).toContain("opencodeRepo()")
    expect(regex).toContain("repo.change(t)")
    expect(codeOnly('const r = x.split(/"/); const s = "opencodeRepo"')).not.toContain("opencodeRepo")
    // Division is not a regular expression.
    expect(codeOnly("const q = a / b; const w = opencodeRepo() / 2")).toContain("opencodeRepo()")
    // Templates nest, and their `${}` expressions keep their code and lose their own strings.
    expect(codeOnly('const n = `a ${`b ${"opencodeRepo"} ${opencodeRepo()}`} c`')).toBe("const n = `${`${\"\"}${opencodeRepo()}`}`;\n")
    expect(codeOnly('const m = `${{ k: "repo.change(" }.k}`')).not.toContain("repo.change(")
  })

  test("the walk follows dynamic imports and lists every non-relative specifier", async () => {
    const kinds = new Bun.Transpiler({ loader: "ts" }).scanImports('const m = await import("./x.ts"); import y from "./y.ts"').map((found) => found.kind)
    expect(kinds).toEqual(["dynamic-import", "import-statement"])
    const { external, kinds: seenKinds } = await importClosure(launcher)
    // The launcher's own client import is dynamic, so the walk sees that kind.
    expect(seenKinds.has("dynamic-import")).toBe(true)
    expect([...external].sort()).toEqual(["@opencode-ai/plugin", "@opencode-ai/sdk/v2", "bun", "bun:sqlite", "node:crypto", "node:fs", "node:fs/promises", "node:os", "node:path", "zod"])
    // Nothing outside the repository but the SDKs, zod, Bun and node builtins.
    for (const name of external) expect(name, name).toMatch(/^(?:@opencode-ai\/(?:plugin|sdk(?:\/v2)?)|zod|bun(?::.*)?|node:.+)$/)
  })

  test("in the code of every file in the closure, `opencodeRepo` and `repo.change(` appear only in repo.ts and plugin.ts", async () => {
    const { seen, sourceOf } = await importClosure(launcher)
    expect(seen.has(repo)).toBe(true)
    const naming: string[] = []
    for (const file of seen) {
      const code = codeOnly(await sourceOf(file))
      if (code.includes("opencodeRepo") || code.includes("repo.change(")) naming.push(file)
    }
    expect(naming.sort()).toEqual([plugin, repo].sort())
  })

  test("plugin.ts calls opencodeRepo only inside the mad_review tool's handler, never at module top level", async () => {
    const code = codeOnly(await Bun.file(plugin).text())
    const calls = [...code.matchAll(/opencodeRepo\(/g)].map((match) => match.index!)
    const changes = [...code.matchAll(/repo\.change\(/g)].map((match) => match.index!)
    expect(calls).toHaveLength(1)
    expect(changes).toHaveLength(1)
    const tool = code.indexOf("mad_review: tool(")
    const handler = code.indexOf("execute(args, context) {", tool)
    expect(tool).toBeGreaterThan(-1)
    expect(handler).toBeGreaterThan(tool)
    const open = code.indexOf("{", handler)
    const end = blockEnd(code, open)
    for (const at of [...calls, ...changes]) {
      expect(at).toBeGreaterThan(open)
      expect(at).toBeLessThan(end)
    }
    // The handler belongs to `MadPlugin`, a function the launcher never calls: it imports only `DEFAULT_DISCOVERY_SLOTS`.
    expect(code.indexOf("const MadPlugin = async")).toBeLessThan(tool)
  })

  test("the launcher, the paired helpers, the lifecycle and host modules and every ablation/adversarial*.ts name neither, comments included", async () => {
    const adversarialModules = (await readdir(resolve(REPO_ROOT, "ablation")))
      .filter((name) => name.startsWith("adversarial") && name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.includes(".fixture."))
      .map((name) => resolve(REPO_ROOT, "ablation", name))
    expect(adversarialModules.length).toBeGreaterThanOrEqual(4)
    for (const file of [
      launcher,
      paired,
      resolve(REPO_ROOT, "ablation/managed-host.ts"),
      resolve(REPO_ROOT, "ablation/oauth-payload.ts"),
      resolve(REPO_ROOT, "ablation/oauth-store.ts"),
      resolve(REPO_ROOT, "adapters/opencode/model-backend.ts"),
      resolve(REPO_ROOT, "adapters/opencode/roster.ts"),
      tools,
      ...adversarialModules,
    ]) {
      const text = await Bun.file(file).text()
      expect(text, file).not.toContain("opencodeRepo")
      expect(text, file).not.toContain("repo.change(")
    }
  })

  test("repo.ts's importers are plugin.ts and tools.ts; plugin.ts is reached only through scripts/paired.ts's DEFAULT_DISCOVERY_SLOTS, and tools.ts takes GitError alone", async () => {
    const { importers, sourceOf } = await importClosure(launcher)
    expect([...(importers.get(repo) ?? [])].sort()).toEqual([plugin, tools].sort())
    expect(importers.get(plugin)).toEqual([paired])
    const named = async (file: string, from: string) =>
      (await sourceOf(file)).match(new RegExp(`import \\{([^}]*)\\} from "${from.replace(/[./]/g, "\\$&")}"`))?.[1]?.trim()
    expect(await named(paired, "../adapters/opencode/plugin.ts")).toBe("DEFAULT_DISCOVERY_SLOTS")
    expect(await named(tools, "./repo.ts")).toBe("GitError")
    // The launcher never imports either directly.
    const own = new Bun.Transpiler({ loader: "ts" }).scanImports(await sourceOf(launcher)).map((found) => resolve(dirname(launcher), found.path))
    expect(own).not.toContain(repo)
    expect(own).not.toContain(plugin)
  })

  test("every run's change is the sealed material: the suite hands review() the case's side, never a Repo port", async () => {
    const suite = await Bun.file(resolve(REPO_ROOT, "ablation/adversarial.ts")).text()
    expect(suite).toContain("change: material[slot.side],")
    expect(await Bun.file(launcher).text()).not.toContain("repo:")
  })
})

// The start marker and worktrees are never touched on refusal; `ADVERSARIAL_START_MARKER_FILE` names the file checked.
test("a refused stage 1 leaves no start marker anywhere under --out", async () => {
  const env = await setup()
  const result = await captured(() => main(argvFor(env, ["--server", "http://x"]), { signals: signalSource(), payloadPins: env.pins, home: env.home }))
  expect(result.code).toBe(1)
  expect(existsSync(join(adversarialDirectory(env.out), ADVERSARIAL_START_MARKER_FILE))).toBe(false)
  expect(existsSync(env.out)).toBe(false)
})
