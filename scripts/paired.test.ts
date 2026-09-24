/**
 * Story 2-8b — `bun run paired`, the gated paired launcher, driven through its
 * `main(argv, overrides)` seam over real git in temp directories.
 *
 * Every model backend here is scripted, every managed host is a scripted stand-in
 * that starts no process, and every roster comes from an injected candidate list:
 * no test starts an opencode host, creates a client that reaches a server, holds a
 * credential, starts a model session or sends a model request. The run path behind
 * the checks is exercised only with injected CLOSED gates; the shipped
 * `PAIRED_GATES` refuses.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { appendFile, chmod, link, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import type { ZodType } from "zod"

import type { BlameExecOutcome, SpawnBlame, SpawnedBlame } from "../adapters/opencode/blame-exec.ts"
import type { OpencodeBackendOptions } from "../adapters/opencode/model-backend.ts"
import type { OpencodeToolsOptions } from "../adapters/opencode/tools.ts"
import { known } from "../ablation/manifest.ts"
import {
  hostConfig,
  MEASURED_HOST,
  OPENAI_COMPATIBLE_NPM,
  startManagedHost,
  type ManagedHostOptions,
  type ManagedHostStart,
  type StopOutcome,
} from "../ablation/managed-host.ts"
import type { PairedPhaseContext } from "../ablation/paired.ts"
import { PAIRED_GATES, type PairedGate } from "../ablation/paired-gates.ts"
import { SCHEDULE_FILE, SLOT_STATUS_FILE, START_MARKER_FILE, type PairedSchedule } from "../ablation/schedule.ts"
import { emptyTokenUsage } from "../core/domain/run-record.ts"
import { CODING_DISCOVERY_GENERALIST } from "../core/instructions/coding/discovery.ts"
import type { LateUsageReporter } from "../core/ports/late-usage.ts"
import { cancelledTurn, type BackendCapabilities, type Envelope, type ModelBackend } from "../core/ports/model-backend.ts"
import { candidate, DEFAULT_JUDGE_ANSWERS, fakeClock, judgeRoleOf } from "../core/test-support/fakes.ts"
import { LABELLED_CHANGE_SEAL } from "../fixtures/seeded-defects/seal.ts"
import { main as evalReadMain } from "./eval-read.ts"
import { main as materializeMain } from "./materialize-labelled-change.ts"
import {
  GATE_TABLE_FILE,
  gatesIdentity,
  gateTableState,
  guarded,
  main,
  nonReturnedReason,
  PREFLIGHT_GIT_SETTINGS,
  preflightGitEnv,
  preflightSpawn,
  productionTools,
  toolsIdentity,
  type PairedOverrides,
  type SignalSource,
  type ToolsFactory,
} from "./paired.ts"

const REPO_ROOT = resolve(import.meta.dir, "..")
const scratch: string[] = []

afterEach(async () => {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-paired-cli-"))
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

async function git(cwd: string, args: string[]): Promise<string> {
  const spawned = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([new Response(spawned.stdout).text(), new Response(spawned.stderr).text()])
  if ((await spawned.exited) !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
  return stdout
}

/** A fresh materialized worktree, a fresh bundle root and an empty scratch parent. */
async function setup() {
  const parent = await tempDir()
  const directory = join(parent, "worktree")
  const materialized = await captured(() => materializeMain(["bun", "materialize", "--out", directory]))
  if (materialized.code !== 0) throw new Error(materialized.text)
  const out = join(parent, "bundle")
  const scratchParent = join(parent, "scratch")
  await mkdir(scratchParent)
  return { parent, directory, out, scratchParent }
}

/** The credential variable the launcher reads, and a marker value that is no provider's key. */
const KEY_ENV = "MAD_TEST_PROVIDER_KEY"
const KEY = "test-marker-not-a-credential"
const PROVIDER_URL = "http://127.0.0.1:1/v1"
const MODELS = ["claude-sonnet-4-5", "gpt-5", "gemini-2.5-pro"]

const argvFor = (directory: string, out: string, extra: string[] = []) => [
  "bun",
  "scripts/paired.ts",
  "--live",
  "--pin",
  "anthropic/claude-sonnet-4-5",
  "--provider-url",
  PROVIDER_URL,
  "--provider-key-env",
  KEY_ENV,
  ...MODELS.flatMap((model) => ["--provider-model", model]),
  "--directory",
  directory,
  "--out",
  out,
  ...extra,
]

const HOST_URL = "http://127.0.0.1:47001"
const GATES_BLOB = "0123456789abcdef0123456789abcdef01234567"

/** A managed host that starts no process: it records what it was asked to start and how often it was stopped. */
function scriptedHost(
  options: { stop?: StopOutcome; refuse?: string; refusedStop?: StopOutcome; whileStarting?: () => void; stopRejects?: boolean } = {},
) {
  const started: ManagedHostOptions[] = []
  let stops = 0
  const stop = async (): Promise<StopOutcome> => {
    stops += 1
    if (options.stopRejects) throw new Error("the stop exploded")
    return options.stop ?? { confirmed: true, pid: 777, how: "exited (status 143) after SIGTERM" }
  }
  const startHost = async (asked: ManagedHostOptions): Promise<ManagedHostStart> => {
    started.push(asked)
    asked.onSpawn?.({ pid: 777, stop })
    options.whileStarting?.()
    if (options.refuse !== undefined) {
      return { ok: false, reason: options.refuse, stopped: options.refusedStop ?? { confirmed: true, pid: 777, how: "exited (status 143) after SIGTERM" } }
    }
    return {
      ok: true,
      host: {
        url: HOST_URL,
        pid: 777,
        binary: "/opt/opencode",
        sha256: MEASURED_HOST.sha256,
        version: MEASURED_HOST.version,
        config: hostConfig(asked.block),
        reportedConfig: {},
        environmentKeys: [],
        pluginInstall: async () => ({ installed: true, version: "1.18.32" }),
        stop,
      },
    }
  }
  return { startHost, started, stops: () => stops }
}

const closedGates: readonly PairedGate[] = PAIRED_GATES.map((gate) => ({
  ...gate,
  status: "CLOSED" as const,
  evidence: gate.evidence ?? "injected by scripts/paired.test.ts",
}))

const CRITICAL = {
  findings: [
    {
      claim: "The ledger entry is appended without awaiting the connection.",
      reasoning: "A failed append is silently dropped.",
      severity: "critical",
      file: "src/billing/ledger.ts",
      startLine: 9,
      endLine: 9,
    },
  ],
}

/** A role-aware scripted backend with unique execution ids across every phase. */
function scripted(before?: (context: PairedPhaseContext) => void) {
  const calls: PairedPhaseContext[] = []
  const backendFor = (context: PairedPhaseContext, _lateUsage: LateUsageReporter): ModelBackend => ({
    capabilities: (): BackendCapabilities => ({ tools: true }),
    async runTurn<T>(slot: string, instructions: string, _input: string, schema: ZodType<T>, signal?: AbortSignal): Promise<Envelope<T>> {
      if (signal?.aborted) return cancelledTurn<T>(slot)
      calls.push(context)
      before?.(context)
      if (signal?.aborted) return cancelledTurn<T>(slot)
      const role = judgeRoleOf(instructions)
      const payload =
        role !== undefined ? DEFAULT_JUDGE_ANSWERS[role] : instructions === CODING_DISCOVERY_GENERALIST.text ? CRITICAL : { turns: [] }
      const parsed = schema.safeParse(payload)
      if (!parsed.success) throw new Error("fake payload did not parse")
      return { ok: true, slot, value: parsed.data, tokens: { ...emptyTokenUsage(), input: 10, output: 20 } }
    },
  })
  return { calls, backendFor }
}

function overridesFor(
  env: { scratchParent: string },
  extra: PairedOverrides = {},
): { overrides: PairedOverrides; clientCalls: unknown[]; backend: ReturnType<typeof scripted>; host: ReturnType<typeof scriptedHost> } {
  const clientCalls: unknown[] = []
  const backend = scripted()
  const host = scriptedHost()
  return {
    clientCalls,
    backend,
    host,
    overrides: {
      startHost: host.startHost,
      env: { [KEY_ENV]: KEY },
      createClient: (init) => {
        clientCalls.push(init)
        return { fake: true }
      },
      enumerate: async () => [
        candidate("anthropic", "claude-sonnet-4-5"),
        candidate("openai", "gpt-5"),
        candidate("google", "gemini-2.5-pro"),
      ],
      backendFor: (context, lateUsage) => backend.backendFor(context, lateUsage),
      clock: fakeClock("2026-09-23T00:00:00.000Z"),
      coin: () => "heads",
      codeRevision: async () => known({ commit: "abc123", dirty: false }),
      // The gate table's committed state is tested on its own below; here it reads as committed.
      gateTable: async () => ({ ok: true, blob: GATES_BLOB }),
      scratchParent: env.scratchParent,
      ...extra,
    },
  }
}

async function nothingScheduled(out: string, scratchParent: string): Promise<void> {
  expect(existsSync(join(out, SCHEDULE_FILE))).toBe(false)
  expect(existsSync(join(out, START_MARKER_FILE))).toBe(false)
  expect(await readdir(scratchParent)).toEqual([])
}

describe("the shipped gate table", () => {
  test("prints every gate with its owner and status, names gates 1-4 OPEN, creates no client and writes nothing", async () => {
    const env = await setup()
    const { overrides, clientCalls, backend, host } = overridesFor(env)
    // No `gates` override: `main` reads the shipped table itself.
    expect("gates" in overrides).toBe(false)
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))

    expect(result.code).toBe(1)
    expect(result.text).toContain("FAIL  paired gates (ablation/paired-gates.ts, phase evaluation)")
    for (const number of [1, 4]) {
      const gate = PAIRED_GATES.find((entry) => entry.number === number)!
      expect(result.text).toContain(`REFUSED: gate ${number} (${gate.name}) is OPEN; owner: ${gate.owner}`)
    }
    expect(result.text).not.toContain("REFUSED: gate 2 ")
    expect(result.text).toContain(
      "gate 3 — accounting-probe spend authorization — authorization, required for accounting-probe (not consulted for evaluation), owner the human budget owner — OPEN",
    )
    for (const gate of PAIRED_GATES) {
      expect(result.text).toContain(`gate ${gate.number} — ${gate.name}`)
      expect(result.text).toContain(`owner ${gate.owner} — ${gate.status}`)
    }
    for (const number of [1, 3, 4]) {
      const gate = PAIRED_GATES.find((entry) => entry.number === number)!
      expect(gate.status).toBe("OPEN")
      expect(result.text).toContain(`gate ${number} — ${gate.name}`)
    }
    // Every other offline check still ran and passed: only the gates refuse.
    expect(result.text).toContain("PASS  worktree identity (first comparison)")
    expect(result.text).toContain("PASS  production Tools wiring")
    expect(result.text).toContain("REFUSED at stage 1 (offline checks)")
    expect(host.started).toEqual([])
    expect(clientCalls).toEqual([])
    expect(backend.calls).toEqual([])
    expect(existsSync(env.out)).toBe(false)
    await nothingScheduled(env.out, env.scratchParent)
  })
})

describe("the gate table must be the committed one", () => {
  const repoWithTable = async () => {
    const root = await tempDir()
    await git(root, ["init", "--quiet"])
    await mkdir(join(root, "ablation"))
    await writeFile(join(root, GATE_TABLE_FILE), "export const PAIRED_GATES = []\n")
    await git(root, ["add", "--all"])
    await git(root, [...IDENTITY, "commit", "--quiet", "--message", "table"])
    return root
  }
  const run = (root: string) => gateTableState(async (cwd, args) => {
    const spawned = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr] = await Promise.all([new Response(spawned.stdout).text(), new Response(spawned.stderr).text()])
    return { exitCode: await spawned.exited, stdout, stderr }
  }, root)

  test("a committed table reads as HEAD's blob", async () => {
    const root = await repoWithTable()
    const state = await run(root)
    expect(state).toEqual({ ok: true, blob: (await git(root, ["rev-parse", `HEAD:${GATE_TABLE_FILE}`])).trim() })
  })

  test("an unstaged edit and a staged edit are both refused", async () => {
    const root = await repoWithTable()
    await appendFile(join(root, GATE_TABLE_FILE), "// gate 4 CLOSED\n")
    const unstaged = await run(root)
    expect(unstaged.ok).toBe(false)
    if (!unstaged.ok) expect(unstaged.why).toContain(`${GATE_TABLE_FILE} differs from HEAD`)
    await git(root, ["add", "--all"])
    expect((await run(root)).ok).toBe(false)
  })

  test("a table HEAD does not hold is refused", async () => {
    const root = await tempDir()
    await git(root, ["init", "--quiet"])
    await writeFile(join(root, "README"), "x\n")
    await git(root, ["add", "--all"])
    await git(root, [...IDENTITY, "commit", "--quiet", "--message", "no table"])
    const state = await run(root)
    expect(state.ok).toBe(false)
    if (!state.ok) expect(state.why).toContain(`${GATE_TABLE_FILE} is not in HEAD`)
  })

  test("with every gate CLOSED, an uncommitted table refuses at stage 1 and nothing is scheduled", async () => {
    const env = await setup()
    const { overrides, clientCalls, host } = overridesFor(env, {
      gates: closedGates,
      gateTable: async () => ({ ok: false, why: `${GATE_TABLE_FILE} differs from HEAD (\` M ${GATE_TABLE_FILE}\`)` }),
    })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("FAIL  gate table committed")
    expect(result.text).toContain(`${GATE_TABLE_FILE} differs from HEAD`)
    expect(result.text).toContain("REFUSED at stage 1 (offline checks)")
    expect(host.started).toEqual([])
    expect(clientCalls).toEqual([])
    await nothingScheduled(env.out, env.scratchParent)
  })
})

describe("all checks pass (injected CLOSED gates, scripted backends)", () => {
  test("the schedule is sealed, three blocks run, exit 0, and eval-read reads the bundle", async () => {
    const env = await setup()
    const { overrides, clientCalls, host } = overridesFor(env, { gates: closedGates })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code, result.text).toBe(0)
    expect(host.started.map((asked) => ({ block: asked.block, credential: asked.credential, signals: asked.signals }))).toEqual([
      {
        block: { id: "anthropic", npm: OPENAI_COMPATIBLE_NPM, baseURL: PROVIDER_URL, apiKeyEnv: KEY_ENV, models: MODELS },
        credential: KEY,
        signals: null,
      },
    ])
    expect(clientCalls).toEqual([{ baseUrl: HOST_URL, directory: env.directory }])
    expect(host.stops()).toBe(1)
    expect(result.text).toContain("Managed host stopped: process 777")
    expect(result.text).not.toContain(KEY)
    expect(result.text).toContain(`bun run eval-read --bundle ${env.out}`)
    expect(await readdir(env.scratchParent)).toEqual([])

    const schedule = JSON.parse(await readFile(join(env.out, SCHEDULE_FILE), "utf8")) as PairedSchedule
    expect(schedule.config.provenance).toBe("live")
    expect(schedule.fixture).toEqual(LABELLED_CHANGE_SEAL)
    expect(schedule.roster.slots.map((slot) => `${slot.providerId}/${slot.modelId}`)[0]).toBe("anthropic/claude-sonnet-4-5")
    expect(schedule.config.gates).toBe(gatesIdentity(GATES_BLOB, closedGates))
    expect(String(schedule.config.gates)).toContain("gate 4 CLOSED")
    const identity = String(schedule.config.tools)
    expect(identity).toBe(toolsIdentity(productionTools({ worktree: env.directory })!))
    expect(identity).toContain("opencodeTools")
    expect(identity).toContain("60000 ms")
    expect(identity).toContain("5000 ms")
    expect(existsSync(join(env.out, START_MARKER_FILE))).toBe(true)

    const read = await captured(() => evalReadMain(["bun", "eval-read", "--bundle", env.out]))
    expect(read.code).toBe(0)
    expect(read.text).toContain("MAD PAIRED CONTRAST")
    expect(read.text).toContain("MAD EVALUATION REPORT")
    expect(read.text).not.toContain("MAD EVALUATION REPORT — SYNTHETIC")
  })
})

describe("the worktree is proved, not trusted", () => {
  const refusedFor = async (tamper: (directory: string) => Promise<void>) => {
    const env = await setup()
    await tamper(env.directory)
    const { overrides, clientCalls } = overridesFor(env, { gates: closedGates })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("FAIL  worktree identity (first comparison)")
    expect(clientCalls).toEqual([])
    await nothingScheduled(env.out, env.scratchParent)
    return result.text
  }

  test("one extra file is refused and named", async () => {
    const text = await refusedFor((directory) => writeFile(join(directory, "src", "extra.ts"), "export {}\n"))
    expect(text).toContain("`src/extra.ts` is not in the sealed tree")
  })

  test("one edited byte is refused and named", async () => {
    const text = await refusedFor(async (directory) => {
      const file = join(directory, "src", "billing", "ledger.ts")
      const bytes = await readFile(file)
      bytes[0] = bytes[0]! ^ 1
      await writeFile(file, bytes)
    })
    expect(text).toContain("`src/billing/ledger.ts` differs in content")
  })

  test("an extra empty commit is refused with the observed commit count", async () => {
    const text = await refusedFor((directory) =>
      git(directory, ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "x"]).then(() => undefined),
    )
    expect(text).toContain("2 commits are reachable from the worktree's refs (expected 1")
  })

  test("a sealed file replaced by a symlink to a byte-equal file elsewhere is refused as a symlink", async () => {
    const elsewhere = await tempDir()
    const text = await refusedFor(async (directory) => {
      const file = join(directory, "src", "billing", "ledger.ts")
      const copy = join(elsewhere, "ledger.ts")
      await writeFile(copy, await readFile(file))
      await unlink(file)
      await symlink(copy, file)
    })
    expect(text).toContain("`src/billing/ledger.ts` is a symlink")
  })

  test("a change after the first comparison fails the stage-3 recheck, with no schedule", async () => {
    const env = await setup()
    const { overrides, clientCalls } = overridesFor(env, {
      gates: closedGates,
      beforeRecheck: () => writeFile(join(env.directory, "late.txt"), "late\n"),
    })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code).toBe(1)
    expect(clientCalls.length).toBe(1)
    expect(result.text).toContain("REFUSED at stage 3 (recheck: worktree identity, --out containment, bundle root)")
    expect(result.text).toContain("`late.txt` is not in the sealed tree")
    await nothingScheduled(env.out, env.scratchParent)
  })
})

/** A child that never exits and whose stdout never ends — a descendant holding the pipe. */
function hangingSpawn(pid: number, dies: boolean) {
  return (): SpawnedBlame => {
    let exit: (code: number) => void = () => undefined
    let close: () => void = () => undefined
    let signalCode: string | null = null
    const held = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (dies) {
            const previous = close
            close = () => {
              previous()
              controller.close()
            }
          }
        },
      })
    const stdout = held()
    const stderr = held()
    return {
      pid,
      stdout,
      stderr,
      exited: new Promise<number>((resolve) => {
        exit = resolve
      }),
      exitCode: null,
      get signalCode() {
        return signalCode
      },
      kill() {
        if (!dies) return
        signalCode = "SIGKILL"
        close()
        exit(137)
      },
    }
  }
}

describe("a hanging git in the preflight", () => {
  test("cleanup that cannot be confirmed is refused within the bound and names the pid", async () => {
    const env = await setup()
    const { overrides, clientCalls } = overridesFor(env, {
      gates: closedGates,
      spawnGit: hangingSpawn(4242, false),
      gitDeadlineMs: 100,
      gitCleanupMs: 100,
    })
    const started = Date.now()
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(result.code).toBe(1)
    expect(result.text).toContain("termination is UNCONFIRMED")
    expect(result.text).toContain("check process 4242")
    expect(clientCalls).toEqual([])
    await nothingScheduled(env.out, env.scratchParent)
  })

  test("a confirmed termination is refused too, and says it was confirmed", async () => {
    const env = await setup()
    const { overrides, clientCalls } = overridesFor(env, {
      gates: closedGates,
      spawnGit: hangingSpawn(4343, true),
      gitDeadlineMs: 100,
      gitCleanupMs: 500,
    })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("termination was confirmed")
    expect(clientCalls).toEqual([])
    await nothingScheduled(env.out, env.scratchParent)
  })
})

describe("flags", () => {
  const run = async (argv: string[], extra: PairedOverrides = {}) => {
    const env = await setup()
    const { overrides, clientCalls } = overridesFor(env, { gates: closedGates, ...extra })
    const result = await captured(() => main(argv, overrides))
    expect(result.code).toBe(1)
    expect(clientCalls).toEqual([])
    return { ...result, env }
  }

  test("a missing --directory prints the flag refusal and `not evaluated: --directory`", async () => {
    const env = await setup()
    const { overrides } = overridesFor(env, { gates: closedGates })
    const result = await captured(() =>
      main(["bun", "paired", "--live", "--pin", "anthropic/claude-sonnet-4-5", "--out", env.out], overrides),
    )
    expect(result.code).toBe(1)
    expect(result.text).toContain("--directory is required")
    expect(result.text).toContain("worktree identity (first comparison) — not evaluated: --directory")
    await nothingScheduled(env.out, env.scratchParent)
  })

  test("--target is refused as a second authority", async () => {
    const env = await setup()
    const { overrides } = overridesFor(env, { gates: closedGates })
    const result = await captured(() => main(argvFor(env.directory, env.out, ["--target", "main...HEAD"]), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("--target is refused")
    expect(result.text).toContain("second authority")
  })

  test("each flag problem names its flag", async () => {
    const env = await setup()
    const cases: [string[], string][] = [
      [["bun", "paired", "--pin", "a/b", "--directory", env.directory, "--out", env.out], "--live is required"],
      [["bun", "paired", "--live", "--directory", env.directory, "--out", env.out], "--pin provider/model is required"],
      [["bun", "paired", "--live", "--pin", "a/b", "--directory", env.directory], "--out is required"],
      [["bun", "paired", "--live", "--pin", "a/b", "--directory", env.directory, "--out", "relative/bundle"], "--out must be an absolute path"],
      [argvFor(env.directory, env.out, ["--out", "/tmp/other"]), "--out was given 2 times"],
      [argvFor(env.directory, env.out, ["--cap", "5"]), "`--cap` is not a flag this command knows"],
      ...["anthropic/ ", " /claude-sonnet-4-5", "anthropic"].map((pin): [string[], string] => [
        argvFor(env.directory, env.out).map((arg) => (arg === "anthropic/claude-sonnet-4-5" ? pin : arg)),
        // The flag value arrives trimmed, so the message shows it trimmed.
        `--pin must be provider/model. It received \`${pin.trim()}\`.`,
      ]),
    ]
    for (const [argv, message] of cases) {
      const { overrides, clientCalls } = overridesFor(env, { gates: closedGates })
      const result = await captured(() => main(argv, overrides))
      expect(result.code, message).toBe(1)
      expect(result.text, message).toContain(message)
      expect(clientCalls).toEqual([])
    }
    await nothingScheduled(env.out, env.scratchParent)
  })

  test("a --directory inside MAD is refused, and the identity comparison is not evaluated on it", async () => {
    const env = await setup()
    const { text } = await run(argvFor(join(REPO_ROOT, "fixtures"), env.out))
    expect(text).toContain("FAIL  --directory containment")
    expect(text).toContain("worktree identity (first comparison) — not evaluated: --directory containment")
  })

  test("an --out inside --directory is refused", async () => {
    const env = await setup()
    const { text } = await run(argvFor(env.directory, join(env.directory, "bundle")))
    expect(text).toContain("is inside --directory")
    expect(existsSync(join(env.directory, "bundle"))).toBe(false)
  })
})

describe("the Tools port is the production one", () => {
  const refusedWith = async (factory: ToolsFactory, message: string) => {
    const env = await setup()
    const { overrides, clientCalls } = overridesFor(env, { gates: closedGates, tools: factory })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("FAIL  production Tools wiring")
    expect(result.text).toContain(message)
    expect(clientCalls).toEqual([])
    await nothingScheduled(env.out, env.scratchParent)
  }

  test("a factory that builds no Tools port is refused before the coin toss", async () => {
    await refusedWith(() => undefined, "no Tools port was built")
  })

  test("an overridden blame deadline is refused before the coin toss", async () => {
    await refusedWith(
      (options) => productionTools({ ...options, blameTimeoutMs: 1_000 }),
      "the blame deadline is 1000 ms, not the shipped 60000 ms",
    )
  })

  test("unconfirmed blame cleanup mid-run aborts the run through its signal and prints the process id", async () => {
    const env = await setup()
    let report: OpencodeToolsOptions["onCleanupUnresolved"]
    let reported = false
    const backend = scripted((context) => {
      if (!reported && context.phase === "prefix") {
        reported = true
        report?.({ operation: "git blame", why: "the child did not exit within 5000 ms", pid: 4242 })
      }
    })
    const { overrides } = overridesFor(env, {
      gates: closedGates,
      tools: (options) => {
        report = options.onCleanupUnresolved
        return productionTools(options)
      },
      backendFor: (context, lateUsage) => backend.backendFor(context, lateUsage),
    })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("Check process 4242 by hand")
    expect(result.text).toContain("The run is INCOMPLETE")
    // Evidence is kept: the schedule, the start marker and the slot statuses.
    expect(existsSync(join(env.out, SCHEDULE_FILE))).toBe(true)
    expect(existsSync(join(env.out, START_MARKER_FILE))).toBe(true)
    expect(existsSync(join(env.out, SLOT_STATUS_FILE))).toBe(true)
    expect(backend.calls.some((call) => call.phase !== "prefix" || call.block > 1)).toBe(false)
  })
})

describe("an existing schedule or start marker", () => {
  for (const file of [SCHEDULE_FILE, START_MARKER_FILE]) {
    test(`\`${file}\` already in the bundle root is refused and nothing is re-tossed`, async () => {
      const env = await setup()
      await mkdir(env.out)
      await writeFile(join(env.out, file), "{}\n")
      const { overrides, clientCalls } = overridesFor(env, { gates: closedGates })
      const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
      expect(result.code).toBe(1)
      expect(result.text).toContain(`${file}\` already exists`)
      expect(clientCalls).toEqual([])
      expect((await readdir(env.out)).sort()).toEqual([file])
      expect(await readFile(join(env.out, file), "utf8")).toBe("{}\n")
    })
  }
})

describe("stage 2", () => {
  test("a roster that cannot be resolved exits 1 with no schedule", async () => {
    const env = await setup()
    const { overrides, backend } = overridesFor(env, {
      gates: closedGates,
      enumerate: async () => {
        throw new Error("connection refused")
      },
    })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("REFUSED at stage 2 (client and roster)")
    expect(result.text).toContain("connection refused")
    expect(backend.calls).toEqual([])
    await nothingScheduled(env.out, env.scratchParent)
  })
})

describe("the source keeps the four stages in order", () => {
  test("offline checks, client and roster, recheck, then schedule and runner", async () => {
    const source = await Bun.file(new URL("./paired.ts", import.meta.url)).text()
    const body = source.slice(source.indexOf("export async function main"))
    const markers = [
      "// ---- STAGE 1: offline checks ----",
      "gatePreflight(gates",
      "toolsWiringProblem(wiring)",
      "worktreeIdentity(directory, reference, git)",
      "// ---- STAGE 2: managed host, client and roster ----",
      "startManagedHost)({",
      "defaultCreateClient",
      "selectRoster(",
      "rosterProblemsFor(roster, warnings, flags.pin)",
      "// ---- STAGE 3: worktree identity recheck ----",
      'recheck = interrupted ? ["the preflight was interrupted"] : await worktreeIdentity(directory, reference, git)',
      "const outAgain = await outContainment(out, directory)",
      "const rootAgain = await bundleRoot(out)",
      "// ---- STAGE 4: schedule, then the three blocks ----",
      "createSchedule(",
      "runPairedBlocks(",
    ]
    const at = markers.map((marker) => body.indexOf(marker))
    for (const [index, position] of at.entries()) expect(position, markers[index]).toBeGreaterThan(-1)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  test("the launcher never reads the change through the host shell", async () => {
    const source = await Bun.file(new URL("./paired.ts", import.meta.url)).text()
    expect(source).not.toContain("adapters/opencode/repo.ts")
    expect(source).not.toContain("opencodeRepo")
    expect(source).toContain("change: SEEDED_CHANGE")
    // The source scan PAIRED_NON_GATES cites: the launcher, the runner and the schedule.
    for (const file of ["./paired.ts", "../ablation/paired.ts", "../ablation/schedule.ts"]) {
      const text = await Bun.file(new URL(file, import.meta.url)).text()
      expect(text, file).not.toContain("opencodeRepo")
      expect(text, file).not.toContain("repo.change(")
      expect(text, file).not.toContain("adapters/opencode/repo.ts")
    }
  })

  test("repo.ts reaches the launcher's import closure only for GitError and through plugin.ts's one constant", async () => {
    const transpiler = new Bun.Transpiler({ loader: "ts" })
    const sourceOf = async (file: string) => (await Bun.file(file).text()).replace(/^#!.*\n/, "")
    const launcher = resolve(import.meta.dir, "paired.ts")
    const importers = new Map<string, string[]>()
    const seen = new Set<string>()
    const queue = [launcher]
    while (queue.length > 0) {
      const file = queue.shift()!
      if (seen.has(file)) continue
      seen.add(file)
      for (const found of transpiler.scanImports(await sourceOf(file))) {
        if (!found.path.startsWith(".")) continue
        const target = resolve(dirname(file), found.path)
        importers.set(target, [...(importers.get(target) ?? []), file])
        queue.push(target)
      }
    }
    const repo = resolve(REPO_ROOT, "adapters/opencode/repo.ts")
    const plugin = resolve(REPO_ROOT, "adapters/opencode/plugin.ts")
    const tools = resolve(REPO_ROOT, "adapters/opencode/tools.ts")
    expect([...(importers.get(repo) ?? [])].sort()).toEqual([plugin, tools].sort())
    expect(importers.get(plugin)).toEqual([launcher])
    const named = async (file: string, from: string) =>
      (await sourceOf(file)).match(new RegExp(`import \\{([^}]*)\\} from "${from.replace(/[./]/g, "\\$&")}"`))?.[1]?.trim()
    expect(await named(launcher, "../adapters/opencode/plugin.ts")).toBe("DEFAULT_DISCOVERY_SLOTS")
    expect(await named(tools, "./repo.ts")).toBe("GitError")
  })
})

// ---------------------------------------------------------------------------
// Review patch (2-8b): the identity check's inputs, the roster, stage 4 and flags
// ---------------------------------------------------------------------------

const IDENTITY = ["-c", "user.name=Tamperer", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false"]

/** Tamper with a fresh worktree, run with CLOSED gates, and return the refusal text. */
async function identityRefusal(tamper: (directory: string) => Promise<unknown>): Promise<string> {
  const env = await setup()
  await tamper(env.directory)
  const { overrides, clientCalls } = overridesFor(env, { gates: closedGates })
  const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
  expect(result.code).toBe(1)
  expect(result.text).toContain("FAIL  worktree identity (first comparison)")
  expect(clientCalls).toEqual([])
  await nothingScheduled(env.out, env.scratchParent)
  return result.text
}

describe("the identity check's git runs in a clean environment", () => {
  test("every GIT_* variable is stripped and PWD is the working directory", () => {
    const env = preflightGitEnv({ PATH: "/bin", GIT_DIR: "/x", GIT_WORK_TREE: "/y", git_config_global: "/z", HOME: "/h" }, "/cwd")
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", PWD: "/cwd" })
  })

  test("a GIT_DIR and GIT_INDEX_FILE in the operator's shell do not redirect the comparison", async () => {
    const env = await setup()
    const other = await setup()
    await git(other.directory, [...IDENTITY, "commit", "--allow-empty", "-q", "-m", "other"])
    const saved = { dir: process.env.GIT_DIR, index: process.env.GIT_INDEX_FILE }
    process.env.GIT_DIR = join(other.directory, ".git")
    process.env.GIT_INDEX_FILE = join(other.directory, ".git", "index")
    try {
      const { overrides } = overridesFor(env)
      const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
      expect(result.text).toContain("PASS  worktree identity (first comparison)")
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = saved.dir
      if (saved.index === undefined) delete process.env.GIT_INDEX_FILE
      else process.env.GIT_INDEX_FILE = saved.index
    }
  })

  test("every preflight git call carries core.fsmonitor=false and a hooks path that cannot exist", async () => {
    const env = await setup()
    const recorded: { cmd: string[]; cwd: string }[] = []
    const spawnGit: SpawnBlame = (request) => {
      recorded.push(request)
      return preflightSpawn(request)
    }
    const { overrides } = overridesFor(env, { spawnGit })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.text).toContain("PASS  worktree identity (first comparison)")
    expect(recorded.some((call) => call.cwd === env.directory)).toBe(true)
    for (const call of recorded) expect(call.cmd.slice(1, 1 + PREFLIGHT_GIT_SETTINGS.length)).toEqual([...PREFLIGHT_GIT_SETTINGS])
    expect(PREFLIGHT_GIT_SETTINGS).toContain("core.fsmonitor=false")
    expect(PREFLIGHT_GIT_SETTINGS.join(" ")).toContain("core.hooksPath=/dev/null/")
  })
})

describe("the identity check compares what the model can see inside .git", () => {
  test("a local config line the sealed repository lacks is refused and named", async () => {
    const text = await identityRefusal((directory) => git(directory, ["config", "user.name", "Evil"]))
    expect(text).toContain("`git config --local --list` differs from the sealed repository's; not sealed: user.name=Evil")
  })

  test("a file added under .git/info is refused and named", async () => {
    const text = await identityRefusal((directory) => writeFile(join(directory, ".git", "info", "attributes"), "* -diff\n"))
    expect(text).toContain("`.git/info/attributes` is not in the sealed repository")
  })

  test("a hook that is not a git sample is refused and named", async () => {
    const text = await identityRefusal(async (directory) => {
      await mkdir(join(directory, ".git", "hooks"), { recursive: true })
      await writeFile(join(directory, ".git", "hooks", "post-checkout"), "#!/bin/sh\n")
    })
    expect(text).toContain("`.git/hooks/post-checkout` is a hook that is not a git sample")
  })

  test("the commit's author is compared, and the field is named", async () => {
    const text = await identityRefusal((directory) =>
      git(directory, [...IDENTITY, "commit", "--amend", "--no-edit", "-q", "--author=Evil <evil@x.invalid>"]),
    )
    expect(text).toContain('the commit\'s author name is "Evil"; the sealed commit\'s is "MAD fixture"')
    expect(text).not.toContain("commits are reachable")
  })

  test("the commit's message is compared, and the field is named", async () => {
    const text = await identityRefusal((directory) =>
      git(directory, ["-c", "user.name=MAD fixture", "-c", "user.email=fixture@mad.invalid", "-c", "commit.gpgsign=false", "commit", "--amend", "-q", "-m", "look at src/billing"]),
    )
    expect(text).toContain("the commit's message is")
    expect(text).not.toContain("the commit's author name")
  })
})

describe("the identity check's filesystem rules", () => {
  test("a sealed file replaced by a hard link to a byte-equal copy is refused", async () => {
    const elsewhere = await tempDir()
    const text = await identityRefusal(async (directory) => {
      const file = join(directory, "src", "billing", "ledger.ts")
      const copy = join(elsewhere, "ledger.ts")
      await writeFile(copy, await readFile(file))
      await unlink(file)
      await link(copy, file)
    })
    expect(text).toContain("`src/billing/ledger.ts` has 2 hard links; a sealed file has exactly one")
  })

  test("a .git that is a symlink to a byte-equal repository elsewhere is refused", async () => {
    const elsewhere = await tempDir()
    const text = await identityRefusal(async (directory) => {
      await rename(join(directory, ".git"), join(elsewhere, ".git"))
      await symlink(join(elsewhere, ".git"), join(directory, ".git"))
    })
    expect(text).toContain(".git` is a symlink; the sealed materialization is a repository with its own .git directory")
  })

  test("a .git that is a gitfile (a linked worktree) is refused", async () => {
    const elsewhere = await tempDir()
    const text = await identityRefusal(async (directory) => {
      await rename(join(directory, ".git"), join(elsewhere, ".git"))
      await writeFile(join(directory, ".git"), `gitdir: ${join(elsewhere, ".git")}\n`)
    })
    expect(text).toContain(".git` is not a directory; the sealed materialization is a repository with its own .git directory")
  })

  test("a missing .git is refused", async () => {
    const text = await identityRefusal((directory) => rm(join(directory, ".git"), { recursive: true, force: true }))
    expect(text).toContain(".git` is missing; the sealed materialization is a repository with its own .git directory")
  })

  test("the executable bit is compared on disk", async () => {
    const text = await identityRefusal((directory) => chmod(join(directory, "src", "billing", "ledger.ts"), 0o755))
    expect(text).toContain("`src/billing/ledger.ts`'s executable bit is set; the sealed file's is clear")
  })

  test("a tree with more entries than the sealed one stops the walk and is refused", async () => {
    const text = await identityRefusal(async (directory) => {
      for (let index = 0; index < 20; index += 1) await writeFile(join(directory, `extra-${String(index).padStart(2, "0")}.txt`), "x\n")
    })
    expect(text).toContain("the worktree holds more than 5 entries outside .git, and the sealed tree holds exactly 5")
    expect(text).not.toContain("is missing")
  })

  test("a file larger than its sealed counterpart is refused without being read", async () => {
    const text = await identityRefusal((directory) => appendFile(join(directory, "src", "billing", "ledger.ts"), "// more\n"))
    expect(text).toContain("`src/billing/ledger.ts` is larger than its sealed counterpart")
    expect(text).toContain("not read")
  })

  test("a sealed file deleted is named as missing", async () => {
    const text = await identityRefusal((directory) => unlink(join(directory, "src", "billing", "refund.ts")))
    expect(text).toContain("`src/billing/refund.ts` is missing")
  })
})

describe("the identity check through git", () => {
  test("the change staged with `git add -A` is refused on the porcelain status", async () => {
    const text = await identityRefusal((directory) => git(directory, ["add", "-A"]))
    expect(text).toContain("`git status --porcelain=v1 --untracked-files=all` differs")
    expect(text).not.toContain("HEAD^{tree} is")
    expect(text).not.toContain("differs in content")
  })

  test("the change committed into the one commit is refused on HEAD^{tree}", async () => {
    const text = await identityRefusal(async (directory) => {
      await git(directory, ["add", "-A"])
      await git(directory, ["-c", "user.name=MAD fixture", "-c", "user.email=fixture@mad.invalid", "-c", "commit.gpgsign=false", "commit", "--amend", "--no-edit", "-q"])
    })
    expect(text).toContain("HEAD^{tree} is")
    expect(text).not.toContain("commits are reachable")
    expect(text).not.toContain("differs in content")
  })
})

describe("a hang in the comparison, not only in the reference build", () => {
  test("a git that hangs in the handed directory at stage 1 is refused and names the pid", async () => {
    const env = await setup()
    const hang = hangingSpawn(5151, false)
    const { overrides, clientCalls } = overridesFor(env, {
      gates: closedGates,
      spawnGit: (request) => (request.cwd === env.directory ? hang() : preflightSpawn(request)),
      gitDeadlineMs: 2_000,
      gitCleanupMs: 100,
    })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code).toBe(1)
    expect(result.text).not.toContain("the reference copy could not be built")
    expect(result.text).toContain("termination is UNCONFIRMED")
    expect(result.text).toContain("check process 5151")
    expect(clientCalls).toEqual([])
    await nothingScheduled(env.out, env.scratchParent)
  })

  test("a git that hangs during the stage-3 recheck is refused at stage 3", async () => {
    const env = await setup()
    const hang = hangingSpawn(5252, false)
    let rechecking = false
    const { overrides } = overridesFor(env, {
      gates: closedGates,
      spawnGit: (request) => (rechecking && request.cwd === env.directory ? hang() : preflightSpawn(request)),
      gitDeadlineMs: 2_000,
      gitCleanupMs: 100,
      beforeRecheck: async () => {
        rechecking = true
      },
    })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("REFUSED at stage 3")
    expect(result.text).toContain("check process 5252")
    await nothingScheduled(env.out, env.scratchParent)
  })
})

describe("the Tools report", () => {
  const refused = async (factory: ToolsFactory, message: string) => {
    const env = await setup()
    const { overrides } = overridesFor(env, { gates: closedGates, tools: factory })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("FAIL  production Tools wiring")
    expect(result.text).toContain(message)
    await nothingScheduled(env.out, env.scratchParent)
  }

  test("a cleanup budget override is refused, naming the cleanup budget", async () => {
    await refused((options) => productionTools({ ...options, blameCleanupTimeoutMs: 100 }), "the blame cleanup budget is 100 ms, not the shipped 5000 ms")
  })

  test("an adapter that is not opencodeTools is refused", async () => {
    await refused((options) => ({ ...productionTools(options)!, adapter: "fake" }), "the adapter is `fake`")
  })
})

describe("stage 2 refuses a roster that does not honour the pin", () => {
  const refusedWith = async (candidates: ReturnType<typeof candidate>[], messages: string[]) => {
    const env = await setup()
    const { overrides, backend } = overridesFor(env, { gates: closedGates, enumerate: async () => candidates })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("REFUSED at stage 2 (client and roster)")
    for (const message of messages) expect(result.text).toContain(message)
    expect(backend.calls).toEqual([])
    await nothingScheduled(env.out, env.scratchParent)
  }

  test("a host that does not offer the pinned model", async () => {
    await refusedWith(
      [candidate("openai", "gpt-5"), candidate("google", "gemini-2.5-pro"), candidate("mistral", "mistral-large")],
      ["the pinned model anthropic/claude-sonnet-4-5 holds no slot", "roster-pin-unhonoured"],
    )
  })

  test("a host too narrow to fill the default roster", async () => {
    await refusedWith(
      [candidate("anthropic", "claude-sonnet-4-5"), candidate("openai", "gpt-5")],
      ["the roster holds 2 of the 3 discovery slots it needs", "roster-underfilled"],
    )
  })
})

describe("stage 4 errors", () => {
  test("a throw after the start marker prints INCOMPLETE, the unconfirmed pid and the eval-read pointer", async () => {
    const env = await setup()
    let report: OpencodeToolsOptions["onCleanupUnresolved"]
    const { overrides } = overridesFor(env, {
      gates: closedGates,
      tools: (options) => {
        report = options.onCleanupUnresolved
        return productionTools(options)
      },
      runner: {
        runPairedBlocks: async (input) => {
          await writeFile(join(input.bundleRoot, START_MARKER_FILE), "{}\n")
          report?.({ operation: "git blame", why: "not confirmed", pid: 6161 })
          throw new Error("the runner blew up")
        },
      },
    })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("INCOMPLETE — stage 4 threw: the runner blew up")
    expect(result.text).toContain("BLAME CLEANUP UNCONFIRMED: check process 6161 by hand")
    expect(result.text).toContain(`bun run eval-read --bundle ${env.out}`)
  })

  test("a throw before any start marker says nothing was billed", async () => {
    const env = await setup()
    const { overrides } = overridesFor(env, {
      gates: closedGates,
      runner: {
        createSchedule: async () => {
          throw new Error("disk full")
        },
      },
    })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("INCOMPLETE — stage 4 threw: disk full")
    expect(result.text).toContain("No start marker exists, so nothing was billed.")
    expect(result.text).not.toContain("bun run eval-read --bundle")
  })

  test("a throw when the start marker's presence cannot be read does not claim nothing was billed", async () => {
    const env = await setup()
    const { overrides } = overridesFor(env, {
      gates: closedGates,
      runner: {
        createSchedule: async () => {
          await mkdir(env.out)
          await chmod(env.out, 0o000)
          throw new Error("disk full")
        },
      },
    })
    try {
      const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
      expect(result.code).toBe(1)
      expect(result.text).toContain("could not be established")
      expect(result.text).toContain("so whether anything was billed is unknown")
      expect(result.text).not.toContain("nothing was billed")
    } finally {
      await chmod(env.out, 0o755)
    }
  })

  test("a runPairedBlocks refusal before its start marker exits 1, keeps the schedule and says nothing was billed", async () => {
    const env = await setup()
    const { overrides, backend } = overridesFor(env, {
      gates: closedGates,
      runner: { runPairedBlocks: async () => ({ ok: false, reason: "the schedule does not match its binding" }) },
    })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("REFUSED by runPairedBlocks before its start marker: the schedule does not match its binding")
    expect(result.text).toContain("Nothing was billed.")
    expect(existsSync(join(env.out, SCHEDULE_FILE))).toBe(true)
    expect(existsSync(join(env.out, START_MARKER_FILE))).toBe(false)
    expect(backend.calls).toEqual([])
  })

  test("a createSchedule refusal gets a next step matched to its reason", async () => {
    const env = await setup()
    const { overrides } = overridesFor(env, {
      gates: closedGates,
      runner: { createSchedule: async () => ({ ok: false, reason: "another writer holds `paired.lock`. One writer per bundle root" }) },
    })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("confirm that no runner is active on this bundle root, then remove its paired.lock")
  })
})

/** A signal source that records handlers, so a test can invoke one without sending a real signal. */
function fakeSignals() {
  const handlers = new Map<string, Set<() => void>>()
  const source: SignalSource = {
    on: (signal, handler) => handlers.set(signal, (handlers.get(signal) ?? new Set()).add(handler)),
    off: (signal, handler) => handlers.get(signal)?.delete(handler),
  }
  const fire = (signal: "SIGINT" | "SIGTERM") => {
    for (const handler of [...(handlers.get(signal) ?? [])]) handler()
  }
  const count = () => [...handlers.values()].reduce((total, set) => total + set.size, 0)
  return { source, fire, count }
}

describe("operator interrupts", () => {
  test("SIGINT during the run aborts it through the runner's signal, and the handlers are removed", async () => {
    const env = await setup()
    const signals = fakeSignals()
    let fired = false
    const backend = scripted(() => {
      if (!fired) {
        fired = true
        signals.fire("SIGINT")
      }
    })
    const { overrides } = overridesFor(env, {
      gates: closedGates,
      signals: signals.source,
      backendFor: (context, lateUsage) => backend.backendFor(context, lateUsage),
    })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("INTERRUPTED — aborting the run through its signal")
    expect(result.text).toContain("The run is INCOMPLETE")
    expect(backend.calls.some((call) => call.block > 1)).toBe(false)
    expect(signals.count()).toBe(0)
  })

  test("SIGTERM during the preflight removes the scratch copy and exits 130", async () => {
    const env = await setup()
    const signals = fakeSignals()
    const exits: number[] = []
    const stopsAtExit: number[] = []
    let scratchAfter: string[] | undefined
    const { overrides, host } = overridesFor(env, {
      gates: closedGates,
      signals: signals.source,
      exit: (code) => {
        exits.push(code)
        stopsAtExit.push(host.stops())
      },
      beforeRecheck: async () => {
        expect((await readdir(env.scratchParent)).length).toBe(1)
        signals.fire("SIGTERM")
        scratchAfter = await readdir(env.scratchParent)
      },
    })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(exits).toEqual([130])
    // The managed host was stopped before the process exited.
    expect(stopsAtExit).toEqual([1])
    expect(host.stops()).toBe(1)
    expect(scratchAfter).toEqual([])
    expect(result.text).toContain("INTERRUPTED during the preflight")
    expect(result.code).toBe(1)
    expect(signals.count()).toBe(0)
    await nothingScheduled(env.out, env.scratchParent)
  })
})

describe("stage 3 rechecks --out and the bundle root", () => {
  test("an --out swapped for a symlink into this repository after stage 1 is refused at stage 3", async () => {
    const env = await setup()
    const { overrides } = overridesFor(env, {
      gates: closedGates,
      beforeRecheck: () => symlink(join(REPO_ROOT, "fixtures"), env.out),
    })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("REFUSED at stage 3")
    expect(result.text).toContain("--out containment failed at the recheck")
    expect(existsSync(join(REPO_ROOT, "fixtures", SCHEDULE_FILE))).toBe(false)
  })

  test("a start marker that appears after stage 1 is refused at stage 3 and left untouched", async () => {
    const env = await setup()
    const { overrides } = overridesFor(env, {
      gates: closedGates,
      beforeRecheck: async () => {
        await mkdir(env.out)
        await writeFile(join(env.out, START_MARKER_FILE), "{}\n")
      },
    })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("the bundle root changed after stage 1")
    expect(result.text).toContain(`Already in the bundle root, and left untouched: ${join(env.out, START_MARKER_FILE)}`)
    expect(existsSync(join(env.out, SCHEDULE_FILE))).toBe(false)
  })
})

describe("refusal wording and small guards", () => {
  test("a refusal because a start marker exists does not claim that none exists", async () => {
    const env = await setup()
    await mkdir(env.out)
    await writeFile(join(env.out, START_MARKER_FILE), "{}\n")
    const { overrides } = overridesFor(env, { gates: closedGates })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code).toBe(1)
    expect(result.text).not.toContain("no start marker exists")
    expect(result.text).toContain("wrote no start marker")
    expect(result.text).toContain(`Already in the bundle root, and left untouched: ${join(env.out, START_MARKER_FILE)}`)
  })

  test("a check that throws is recorded as a failed check", async () => {
    const check = await guarded("frozen protocol", async () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
    })
    expect(check).toEqual({ name: "frozen protocol", state: "fail", detail: ["the check could not be made: EACCES: permission denied"] })
  })

  test("an outcome kind the launcher does not know yields a reason, never undefined", () => {
    const reason = nonReturnedReason("git status", { kind: "exploded" } as unknown as BlameExecOutcome)
    expect(reason).toContain("an outcome this launcher does not know")
  })

  test("the default code revision is MAD's own HEAD, not the worktree's", async () => {
    const env = await setup()
    const { overrides } = overridesFor(env, { gates: closedGates })
    delete overrides.codeRevision
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code, result.text).toBe(0)
    const schedule = JSON.parse(await readFile(join(env.out, SCHEDULE_FILE), "utf8")) as PairedSchedule
    const mad = (await git(REPO_ROOT, ["rev-parse", "HEAD"])).trim()
    const worktree = (await git(env.directory, ["rev-parse", "HEAD"])).trim()
    expect(schedule.codeRevision).toMatchObject({ kind: "known", value: { commit: mad } })
    expect(mad).not.toBe(worktree)
  })
})

describe("flag refusals, continued", () => {
  const refusal = async (extra: (env: Awaited<ReturnType<typeof setup>>) => string[]) => {
    const env = await setup()
    const { overrides, clientCalls, host } = overridesFor(env, { gates: closedGates })
    const result = await captured(() => main(extra(env), overrides))
    expect(result.code).toBe(1)
    expect(host.started).toEqual([])
    expect(clientCalls).toEqual([])
    await nothingScheduled(env.out, env.scratchParent)
    return { text: result.text, env }
  }

  test("--server is refused: the launcher trusts no host it did not start", async () => {
    const { text } = await refusal((env) => argvFor(env.directory, env.out, ["--server", "http://localhost:4096"]))
    expect(text).toContain("--server is refused: the launcher starts its own managed host (ablation/managed-host.ts)")
  })

  test("--live=value is refused", async () => {
    const { text } = await refusal((env) => ["bun", "paired", "--live=yes", "--pin", "a/b", "--directory", env.directory, "--out", env.out])
    expect(text).toContain("--live takes no value; it received `--live=yes`.")
  })

  test("a relative --directory makes its dependants print why they were not evaluated", async () => {
    const { text } = await refusal((env) => ["bun", "paired", "--live", "--pin", "a/b", "--directory", "relative/tree", "--out", env.out])
    expect(text).toContain("--directory must be an absolute path")
    expect(text).toContain("worktree identity (first comparison) — not evaluated: --directory (rejected: not absolute)")
    expect(text).toContain("production Tools wiring — not evaluated: --directory (rejected: not absolute)")
  })

  test("a positional argument and a single-dash token are refused", async () => {
    const { text } = await refusal((env) => [...argvFor(env.directory, env.out), "extra", "-v"])
    expect(text).toContain("unexpected argument `extra`")
    expect(text).toContain("unexpected argument `-v`")
  })

  test("an --out inside this repository is refused by the AD-16 check and nothing is created", async () => {
    const out = join(REPO_ROOT, "paired-out-must-not-exist")
    const { text } = await refusal((env) => argvFor(env.directory, out))
    expect(text).toContain(`\`${out}\` is inside this repository (AD-16)`)
    expect(existsSync(out)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Story 2-8c: the managed host
// ---------------------------------------------------------------------------

describe("the managed host (story 2-8c)", () => {
  test("the provider flags are required, and each missing one is named, with no host started", async () => {
    const env = await setup()
    const { overrides, host } = overridesFor(env, { gates: closedGates })
    const argv = ["bun", "paired", "--live", "--pin", "anthropic/claude-sonnet-4-5", "--directory", env.directory, "--out", env.out]
    const result = await captured(() => main(argv, overrides))
    expect(result.code).toBe(1)
    for (const text of ["--provider-url is required", "--provider-key-env is required", "--provider-model is required"]) {
      expect(result.text).toContain(text)
    }
    expect(result.text).toContain("managed host provider block — not evaluated: --pin and the --provider-* flags")
    expect(host.started).toEqual([])
  })

  test("an unset credential variable and a bad provider URL are refused at stage 1, without printing a value", async () => {
    const env = await setup()
    const { overrides, host } = overridesFor(env, { gates: closedGates, env: {} })
    const argv = argvFor(env.directory, env.out).map((arg) => (arg === PROVIDER_URL ? "ftp://router.invalid/v1" : arg))
    const result = await captured(() => main(argv, overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("FAIL  managed host provider block")
    expect(result.text).toContain(`the credential variable \`${KEY_ENV}\` is not set in this environment, or is empty`)
    expect(result.text).toContain("the provider URL `ftp://router.invalid/v1` is not an http(s) URL")
    expect(host.started).toEqual([])
    await nothingScheduled(env.out, env.scratchParent)
  })

  test("a provider that is not openai-compatible is refused at stage 2 with the reason, and no client is created", async () => {
    const env = await setup()
    let spawned = false
    const { overrides, clientCalls, backend } = overridesFor(env, {
      gates: closedGates,
      startHost: (options) =>
        startManagedHost({
          ...options,
          block: { ...options.block, npm: "@ai-sdk/anthropic" },
          spawn: () => {
            spawned = true
            throw new Error("no process may start in this test")
          },
        }),
    })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("REFUSED at stage 2 (managed host)")
    expect(result.text).toContain("accepts only `@ai-sdk/openai-compatible`")
    expect(spawned).toBe(false)
    expect(clientCalls).toEqual([])
    expect(backend.calls).toEqual([])
    await nothingScheduled(env.out, env.scratchParent)
  })

  test("a host the managed-host check refuses is refused at stage 2, and nothing is scheduled", async () => {
    const env = await setup()
    const refusing = scriptedHost({ refuse: "the host is not the measured build (version 1.19.0)" })
    const { overrides, clientCalls } = overridesFor(env, { gates: closedGates, startHost: refusing.startHost })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("the host is not the measured build (version 1.19.0)")
    expect(clientCalls).toEqual([])
    await nothingScheduled(env.out, env.scratchParent)
  })

  test("the host is stopped when stage 2's roster refuses, when stage 3 refuses and when stage 4 throws", async () => {
    const roster = await setup()
    const narrow = overridesFor(roster, { gates: closedGates, enumerate: async () => [candidate("anthropic", "claude-sonnet-4-5")] })
    expect((await captured(() => main(argvFor(roster.directory, roster.out), narrow.overrides))).code).toBe(1)
    expect(narrow.host.stops()).toBe(1)

    const recheck = await setup()
    const tampered = overridesFor(recheck, {
      gates: closedGates,
      beforeRecheck: () => writeFile(join(recheck.directory, "src", "late.ts"), "export {}\n"),
    })
    const third = await captured(() => main(argvFor(recheck.directory, recheck.out), tampered.overrides))
    expect(third.text).toContain("REFUSED at stage 3")
    expect(tampered.host.stops()).toBe(1)

    const thrown = await setup()
    const throwing = overridesFor(thrown, {
      gates: closedGates,
      runner: {
        createSchedule: () => {
          throw new Error("scheduler exploded")
        },
      },
    })
    const fourth = await captured(() => main(argvFor(thrown.directory, thrown.out), throwing.overrides))
    expect(fourth.code).toBe(1)
    expect(fourth.text).toContain("scheduler exploded")
    expect(throwing.host.stops()).toBe(1)
  })

  test("a host stop that cannot be confirmed prints the pid and exits 1, even after a complete run", async () => {
    const env = await setup()
    const stuck = scriptedHost({ stop: { confirmed: false, pid: 777, why: "no exit within 5000 ms of SIGKILL" } })
    const { overrides } = overridesFor(env, { gates: closedGates, startHost: stuck.startHost })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.text).toContain("`complete: true`")
    expect(result.text).toContain("MANAGED HOST STOP UNCONFIRMED — check process 777 by hand")
    expect(result.code).toBe(1)
  })

  test("the stage-4 backend is built against the managed host's URL and the reviewed directory", async () => {
    const env = await setup()
    const built: OpencodeBackendOptions[] = []
    const fake = scripted()
    const { overrides } = overridesFor(env, {
      gates: closedGates,
      createBackend: (options) => {
        built.push(options)
        return fake.backendFor({} as PairedPhaseContext, options.lateUsage!)
      },
    })
    delete overrides.backendFor
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code, result.text).toBe(0)
    expect(built.length).toBeGreaterThan(0)
    for (const options of built) {
      expect(String(options.serverUrl)).toBe(HOST_URL)
      expect(options.directory).toBe(env.directory)
    }
    // One journal holds every phase's execution ids, so no two backends may share a prefix.
    const prefixes = built.map((options) => options.executionIdPrefix)
    expect(prefixes).toContain("block-1-prefix/")
    expect(new Set(prefixes).size).toBe(built.length)
  })

  test("the host's config is verified for the reviewed --directory too", async () => {
    const env = await setup()
    const { overrides, host } = overridesFor(env, { gates: closedGates })
    await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(host.started[0]!.verifyDirectories).toEqual([env.directory])
  })

  test("a signal while the host is still starting stops it, exits 130, and nothing is scheduled", async () => {
    const env = await setup()
    const signals = fakeSignals()
    const exits: number[] = []
    const starting = scriptedHost({ whileStarting: () => signals.fire("SIGINT") })
    const { overrides, clientCalls } = overridesFor(env, {
      gates: closedGates,
      signals: signals.source,
      startHost: starting.startHost,
      exit: (code) => {
        exits.push(code)
      },
    })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(exits).toEqual([130])
    expect(starting.stops()).toBe(1)
    expect(result.code).toBe(1)
    expect(result.text).toContain("the preflight was interrupted while the host was starting")
    expect(clientCalls).toEqual([])
    await nothingScheduled(env.out, env.scratchParent)
  })

  test("a refused start whose host exit is unconfirmed names the pid", async () => {
    const env = await setup()
    const refusing = scriptedHost({ refuse: "the host is not the measured build", refusedStop: { confirmed: false, pid: 4321, why: "no exit within 5000 ms of SIGKILL" } })
    const { overrides } = overridesFor(env, { gates: closedGates, startHost: refusing.startHost })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("the refused host's exit is UNCONFIRMED: check process 4321 by hand")
  })

  test("a startHost that rejects is the stage-2 refusal, with the credential redacted", async () => {
    const env = await setup()
    const { overrides } = overridesFor(env, {
      gates: closedGates,
      startHost: async () => {
        throw new Error(`boom ${KEY}`)
      },
    })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("REFUSED at stage 2 (managed host)")
    expect(result.text).toContain("the managed host could not be started: boom [REDACTED]")
    expect(result.text).not.toContain(KEY)
  })

  test("a rejecting stop is reported UNCONFIRMED, and a launcher throw is still printed", async () => {
    const env = await setup()
    const rejecting = scriptedHost({ stopRejects: true })
    const { overrides } = overridesFor(env, {
      gates: closedGates,
      startHost: rejecting.startHost,
      beforeRecheck: async () => {
        throw new Error("the recheck hook exploded")
      },
    })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("MANAGED HOST STOP UNCONFIRMED — check process 777 by hand before anything else runs: the stop rejected: the stop exploded")
    expect(result.text).toContain("INCOMPLETE — the launcher threw: the recheck hook exploded")
  })

  test("a credential variable that holds only whitespace is refused like an empty one", async () => {
    const env = await setup()
    const { overrides, host } = overridesFor(env, { gates: closedGates, env: { [KEY_ENV]: "  \t " } })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain(`the credential variable \`${KEY_ENV}\` is not set in this environment, or is empty or blank`)
    expect(host.started).toEqual([])
  })

  test("the plugin install the host left is printed before it is stopped", async () => {
    const env = await setup()
    const { overrides } = overridesFor(env, { gates: closedGates })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.text).toContain("The managed host's plugin install left @opencode-ai/plugin 1.18.32 in its config directory.")
  })

  test("with the shipped gates and valid flags, gates 1 and 4 are named OPEN, exit 1, and no host is started", async () => {
    const env = await setup()
    const { overrides, host } = overridesFor(env)
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code).toBe(1)
    expect(result.text).toContain("REFUSED: gate 1 (host request accounting) is OPEN")
    expect(result.text).toContain("REFUSED: gate 4 (evaluation spend authorization) is OPEN")
    expect(result.text).toContain("PASS  managed host provider block")
    expect(host.started).toEqual([])
  })
})
