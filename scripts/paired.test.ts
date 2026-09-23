/**
 * Story 2-8b — `bun run paired`, the gated paired launcher, driven through its
 * `main(argv, overrides)` seam over real git in temp directories.
 *
 * Every model backend here is scripted and every roster comes from an injected
 * candidate list: no test creates an opencode client that reaches a server, starts
 * a model session or sends a model request. The run path behind the checks is
 * exercised only with injected CLOSED gates; the shipped `PAIRED_GATES` refuses.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { appendFile, chmod, link, mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import type { ZodType } from "zod"

import type { BlameExecOutcome, SpawnBlame, SpawnedBlame } from "../adapters/opencode/blame-exec.ts"
import type { OpencodeToolsOptions } from "../adapters/opencode/tools.ts"
import { known } from "../ablation/manifest.ts"
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

const argvFor = (directory: string, out: string, extra: string[] = []) => [
  "bun",
  "scripts/paired.ts",
  "--live",
  "--pin",
  "anthropic/claude-sonnet-4-5",
  "--directory",
  directory,
  "--out",
  out,
  ...extra,
]

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
): { overrides: PairedOverrides; clientCalls: unknown[]; backend: ReturnType<typeof scripted> } {
  const clientCalls: unknown[] = []
  const backend = scripted()
  return {
    clientCalls,
    backend,
    overrides: {
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
    const { overrides, clientCalls, backend } = overridesFor(env)
    // No `gates` override: `main` reads the shipped table itself.
    expect("gates" in overrides).toBe(false)
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))

    expect(result.code).toBe(1)
    expect(result.text).toContain("FAIL  paired gates (ablation/paired-gates.ts, phase evaluation)")
    for (const number of [1, 2, 4]) {
      const gate = PAIRED_GATES.find((entry) => entry.number === number)!
      expect(result.text).toContain(`REFUSED: gate ${number} (${gate.name}) is OPEN; owner: ${gate.owner}`)
    }
    expect(result.text).toContain(
      "gate 3 — accounting-probe spend authorization — authorization, required for accounting-probe (not consulted for evaluation), owner the human budget owner — OPEN",
    )
    for (const gate of PAIRED_GATES) {
      expect(result.text).toContain(`gate ${gate.number} — ${gate.name}`)
      expect(result.text).toContain(`owner ${gate.owner} — ${gate.status}`)
    }
    for (const number of [1, 2, 3, 4]) {
      const gate = PAIRED_GATES.find((entry) => entry.number === number)!
      expect(gate.status).toBe("OPEN")
      expect(result.text).toContain(`gate ${number} — ${gate.name}`)
    }
    // Every other offline check still ran and passed: only the gates refuse.
    expect(result.text).toContain("PASS  worktree identity (first comparison)")
    expect(result.text).toContain("PASS  production Tools wiring")
    expect(result.text).toContain("REFUSED at stage 1 (offline checks)")
    expect(clientCalls).toEqual([])
    expect(backend.calls).toEqual([])
    expect(existsSync(env.out)).toBe(false)
    await nothingScheduled(env.out, env.scratchParent)
  })
})

describe("all checks pass (injected CLOSED gates, scripted backends)", () => {
  test("the schedule is sealed, three blocks run, exit 0, and eval-read reads the bundle", async () => {
    const env = await setup()
    const { overrides, clientCalls } = overridesFor(env, { gates: closedGates })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(result.code, result.text).toBe(0)
    expect(clientCalls).toEqual([{ baseUrl: "http://localhost:4096", directory: env.directory }])
    expect(result.text).toContain(`bun run eval-read --bundle ${env.out}`)
    expect(await readdir(env.scratchParent)).toEqual([])

    const schedule = JSON.parse(await readFile(join(env.out, SCHEDULE_FILE), "utf8")) as PairedSchedule
    expect(schedule.config.provenance).toBe("live")
    expect(schedule.fixture).toEqual(LABELLED_CHANGE_SEAL)
    expect(schedule.roster.slots.map((slot) => `${slot.providerId}/${slot.modelId}`)[0]).toBe("anthropic/claude-sonnet-4-5")
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
      "// ---- STAGE 2: client and roster ----",
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
    let scratchAfter: string[] | undefined
    const { overrides } = overridesFor(env, {
      gates: closedGates,
      signals: signals.source,
      exit: (code) => {
        exits.push(code)
      },
      beforeRecheck: async () => {
        expect((await readdir(env.scratchParent)).length).toBe(1)
        signals.fire("SIGTERM")
        scratchAfter = await readdir(env.scratchParent)
      },
    })
    const result = await captured(() => main(argvFor(env.directory, env.out), overrides))
    expect(exits).toEqual([130])
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
    const { overrides, clientCalls } = overridesFor(env, { gates: closedGates })
    const result = await captured(() => main(extra(env), overrides))
    expect(result.code).toBe(1)
    expect(clientCalls).toEqual([])
    await nothingScheduled(env.out, env.scratchParent)
    return { text: result.text, env }
  }

  test("a bad --server is refused", async () => {
    const { text } = await refusal((env) => argvFor(env.directory, env.out, ["--server", "ftp://host"]))
    expect(text).toContain("--server must be an http(s) URL. It received `ftp://host`.")
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
