/**
 * The offline acceptance suite (spec-mad-v1-readiness CAP-1).
 *
 * Each scenario drives `mad_review` through the SHIPPED plugin entry: it calls
 * `MadPlugin(...)` and then `tool.mad_review.execute`. Real `@opencode-ai/sdk`
 * clients talk real HTTP to a loopback fake host (`test-support/fake-host.ts`).
 * The v1 client serves as the plugin's host `client`, and the backend builds its
 * own v2 client from `serverUrl`. The fake host answers with schema-valid fake
 * provider replies.
 *
 * Five checks follow every scenario (`expectClean`):
 *
 * - the reviewed repository's snapshot (`test-support/repo-snapshot.ts`) is
 *   unchanged: every path's bytes and permission bits, `.git` included, plus
 *   the staged index, HEAD and refs;
 * - the network guard (`test-support/network-guard.ts`) rejected nothing;
 * - the fake host recorded no request it could not answer honestly;
 * - every session the fake host created was deleted;
 * - the host shell handed to the plugin was never touched.
 *
 * LIMITS, stated rather than implied:
 *
 * - The guard blocks the `fetch` transport. It is not an OS network sandbox;
 *   raw sockets, `WebSocket` and child processes are outside it. The child
 *   processes on this path are git's, and CAP-2 owns what git's configuration
 *   may start.
 * - The fake host shows what MAD sends and how it handles the answers. It does
 *   not show how a real host enforces a tool policy, and the fake's answers,
 *   the fact-check's included, are scripted rather than computed.
 * - The snapshot covers the reviewed repository only, not every filesystem
 *   effect a run could have; ownership, hard links, extended attributes and
 *   timestamps are not recorded.
 *
 * The global `fetch` is replaced for the duration of each guarded test. Tests in
 * this file run serially (bun's default within a file), and
 * `installNetworkGuard` throws if a guard is already active, so an overlap fails
 * loudly instead of stacking guards.
 */

import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createOpencodeClient } from "@opencode-ai/sdk"

import { ISSUED_TURNS_MAY_BILL } from "../../core/run/review.ts"
import { fenceOf, materialSpans } from "../../core/test-support/fakes.ts"
import { clearBlameQuarantineForTests, ISSUED_TURNS_NOTE, MadPlugin, SUBMODULE_SCOPE_NOTE } from "./plugin.ts"
import { clearChangeReadQuarantineForTests } from "./repo.ts"
import { READ_ONLY_SESSION_NOTICE, REVIEW_SESSION_PERMISSION } from "./session-policy.ts"
import { OMIT, startFakeHost, type FakeHost, type FakeHostOptions, type FakePrompt } from "./test-support/fake-host.ts"
import {
  initiationRecorder,
  isModelAllocation,
  spawnCmdOf,
  type Initiated,
  type InitiationRecorder,
} from "./test-support/initiation-recorder.ts"
import { installNetworkGuard, type NetworkGuard } from "./test-support/network-guard.ts"
import {
  differences,
  makeReviewRepo,
  readGit,
  setupGit,
  snapshot,
  worktreeDifferences,
  type ReviewRepo,
} from "./test-support/repo-snapshot.ts"
import { isolateGitHome } from "./test-support/git-home.ts"

isolateGitHome()

/** Runs over real HTTP and real git; far under this on an idle machine (see d7c0a15). */
const TIMEOUT_MS = 60_000

interface ToolResult {
  title: string
  output: string
  metadata?: { requested?: number; answered?: number; warnings?: string[]; cancelled?: string }
}

/**
 * The host shell the plugin is handed. Nothing on these paths may use it: the
 * change and blame reads run through MAD's own bounded launcher. Every access,
 * whether a call or a property read, is recorded.
 */
function refusingShell(problems: string[]) {
  const target = () => undefined
  const shell: unknown = new Proxy(target, {
    apply() {
      problems.push("the host shell was called")
      return Promise.reject(new Error("the host shell is not available in the acceptance suite"))
    },
    get(_target, property) {
      problems.push(`the host shell's ${String(property)} was read`)
      return shell
    },
  })
  return shell as never
}

interface Run {
  result: ToolResult
  host: FakeHost
  /** The plugin's `tool.execute.before` hook (CAP-3), callable after the run. */
  beforeTool: (input: { tool: string; sessionID: string; callID: string }) => Promise<void>
  guard: NetworkGuard
  changed: string[]
  shellProblems: string[]
}

/**
 * One scenario: start the fake host, install the guard, snapshot the repository,
 * run the shipped entry, snapshot again. Every step after the host starts is
 * inside `try`, so the guard comes off and the host stops whatever throws. The
 * guard is removed only after `execute` has settled, so no started work
 * outlives it.
 */
interface ScenarioOptions {
  /** The `mad_review` arguments. Default none. */
  args?: Record<string, unknown>
  /** Defaults to the fake host; the guard test points it elsewhere. */
  serverUrl?: string
  /** Wraps `execute` only, so the snapshots run outside it. */
  aroundExecute?: <T>(body: () => Promise<T>) => Promise<T>
  /** The tool context's stop signal. Default one that never fires. */
  abort?: AbortSignal
  /**
   * CAP-5 — handed every request the guard sees and wrapped outside
   * `aroundExecute`. It logs from `execute`'s start until the guard comes off,
   * so work that outlives `execute` is logged too; the after-snapshot's own git
   * reads are exempt.
   */
  recorder?: InitiationRecorder
}

async function runScenario(repo: ReviewRepo, hostOptions: FakeHostOptions, options: ScenarioOptions = {}): Promise<Run> {
  const { args = {}, serverUrl, aroundExecute = (body) => body(), abort = new AbortController().signal, recorder } = options
  const host = startFakeHost(hostOptions)
  let guard: NetworkGuard | undefined
  try {
    recorder?.attach(host.url)
    guard = installNetworkGuard([host.origin], recorder?.onRequest)
    const shellProblems: string[] = []
    clearChangeReadQuarantineForTests(repo.dir)
    clearBlameQuarantineForTests(repo.dir)
    const before = await snapshot(repo.dir)
    const client = createOpencodeClient({ baseUrl: host.url, directory: repo.dir })
    const plugin = await MadPlugin({
      client,
      directory: repo.dir,
      worktree: repo.dir,
      serverUrl: new URL(serverUrl ?? host.url),
      $: refusingShell(shellProblems),
    } as never)
    const tool = (plugin as {
      tool?: Record<string, { execute: (a: never, c: never) => Promise<ToolResult> }>
    }).tool
    const execute = () => aroundExecute(() => tool!.mad_review!.execute(args as never, { abort } as never))
    const result = recorder === undefined ? await execute() : await recorder.around(execute)
    const after = recorder === undefined ? await snapshot(repo.dir) : await recorder.exempt(() => snapshot(repo.dir))
    const beforeTool = (plugin as { "tool.execute.before": Run["beforeTool"] })["tool.execute.before"]
    return { result, host, beforeTool, guard, changed: differences(before, after), shellProblems }
  } finally {
    recorder?.dispose()
    guard?.restore()
    await host.stop()
  }
}

type Child = ReturnType<typeof Bun.spawn>

/**
 * Replaces `Bun.spawn` for `body`'s span with one that passes every argument,
 * in either call form, to the spawn it replaced, then hands `hook` the call's
 * `cmd` and the child. `hook` may return a stand-in for the child. The spawn it
 * replaced is restored whatever `body` throws.
 */
function spawnHook(hook: (cmd: string[], child: Child) => Child | void) {
  return async <T>(body: () => Promise<T>): Promise<T> => {
    const realSpawn = Bun.spawn
    ;(Bun as { spawn: unknown }).spawn = (...args: unknown[]) => {
      const child = (realSpawn as unknown as (...a: unknown[]) => Child)(...args)
      return hook(spawnCmdOf(args), child) ?? child
    }
    try {
      return await body()
    } finally {
      ;(Bun as { spawn: unknown }).spawn = realSpawn
    }
  }
}

/** `child` with `overrides` in place of those properties; every other method stays bound to `child`. */
function overriding(child: Child, overrides: Partial<Record<keyof Child, unknown>>): Child {
  return new Proxy(child, {
    get(target, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key as keyof Child]
      const value = Reflect.get(target, key, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

/** Whether `cmd` is the working-tree `git diff --unified=8 HEAD`, the change read's first content read. */
const isWorkingTreeDiff = (cmd: readonly string[]) =>
  cmd.includes("--unified=8") && cmd.includes("HEAD") && !cmd.includes("--no-index")

/** The checks every scenario ends with. */
function expectClean(run: Run): void {
  expect(run.changed).toEqual([])
  expect(run.guard.blocked).toEqual([])
  expect(run.host.problems).toEqual([])
  expect([...run.host.openSessions]).toEqual([])
  expect(run.shellProblems).toEqual([])
}

/**
 * Counts every `git` process started inside `around`, through a wrapper put
 * first on `PATH` for exactly that span. The launcher hands `Bun.spawn` an
 * environment built from `process.env` at spawn time, and `Bun.spawn` resolves
 * `git` through that environment's `PATH`, so the wrapper sees every git MAD
 * starts. It runs the real git, so the reads behave as they would without it.
 * `runScenario` calls `around` for `execute` only, so the snapshot's own git
 * reads are not counted.
 */
async function gitCounter() {
  const real = Bun.which("git")
  if (real === null) throw new Error("git is not on PATH")
  const bin = await mkdtemp(join(tmpdir(), "mad-acceptance-git-"))
  const log = join(bin, "launches.log")
  await writeFile(log, "")
  await writeFile(join(bin, "git"), `#!/bin/sh\necho x >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 })
  return {
    async around<T>(body: () => Promise<T>): Promise<T> {
      const savedPath = process.env.PATH
      process.env.PATH = `${bin}:${savedPath ?? ""}`
      try {
        return await body()
      } finally {
        if (savedPath === undefined) delete process.env.PATH
        else process.env.PATH = savedPath
      }
    },
    async launches(): Promise<number> {
      return (await readFile(log, "utf8")).split("\n").filter((line) => line.length > 0).length
    },
    dispose: () => rm(bin, { recursive: true, force: true }),
  }
}

/** The finding every discovery slot reports, so all three co-discover it. */
const FEE_FINDING = {
  claim: "The fee rate dropped from 10% to 1%, so every payment is under-charged.",
  reasoning: "src/pay.ts multiplies by 0.01 where the committed version used 0.1.",
  severity: "medium" as const,
  file: "src/pay.ts",
  startLine: 1,
  endLine: 1,
}

/** A second finding with a locus, so a later finding exists for a stop to reach. */
const NOTES_FINDING = {
  claim: "notes.txt is scratch left in the tree and will be committed by accident.",
  reasoning: "It is untracked and not ignored.",
  severity: "low" as const,
  file: "notes.txt",
  startLine: 1,
  endLine: 1,
}

/** A fact-check true to the one-line fixture, instead of the generic default. */
const FEE_FACT_CHECK = {
  checks: ["opened src/pay.ts and read line 1"],
  findings: "Line 1 multiplies by 0.01; the committed version multiplied by 0.1.",
  verdict: "upheld",
  evidenceKind: "line-cite",
}

/**
 * CAP-5 — the plugin's OpenCode billing note, without the paragraph break it
 * is appended with. Both helpers below look for this one form.
 */
const OPENCODE_BILLING_NOTE = ISSUED_TURNS_NOTE.trim()

/** CAP-5 — a pre-model stopped answer says nothing about billing at all. */
function expectNoBillingDisclosure(output: string): void {
  expect(output).not.toMatch(/billed/i)
  expect(output).not.toContain(OPENCODE_BILLING_NOTE)
}

/**
 * CAP-5 — THE SNAPSHOT RULE. Exactly one stop marker was logged, and nothing
 * logged after it is a git spawn, a model allocation or a request outside the
 * host (`InitiationRecorder.violations`). Requests started before the marker,
 * and cleanup after it, are allowed.
 */
function expectNothingStartedAfterStop(recorder: InitiationRecorder): void {
  expect(recorder.log.filter((event) => event.kind === "stop")).toHaveLength(1)
  expect(recorder.violations()).toEqual([])
}

/** CAP-5 (#107) — wording that would call a process killed. */
const KILLED_CLAIMS = [/killed process/i, /process was killed/i, /MAD killed/i]

/**
 * CAP-5 — the output claims every stopped answer must make or avoid:
 *
 * - it is never the no-change answer;
 * - it never says that no model failed (#160), in any case;
 * - it never calls a process killed (#107; `KILLED_CLAIMS`);
 * - with `issuedTurns` (the ledger shows an issued turn), the core's portable
 *   billing sentence and the OpenCode note each appear exactly once; without
 *   it, neither appears and nothing mentions billing.
 */
function expectStopClaims(result: ToolResult, issuedTurns: boolean): void {
  expect(result.title).not.toBe("MAD — nothing to review")
  expect(result.output).not.toContain("No change found")
  expect(result.output).not.toMatch(/no model failed/i)
  for (const claim of KILLED_CLAIMS) expect(result.output).not.toMatch(claim)
  if (issuedTurns) {
    expect(result.output.split(ISSUED_TURNS_MAY_BILL)).toHaveLength(2)
    expect(result.output.split(OPENCODE_BILLING_NOTE)).toHaveLength(2)
  } else {
    expectNoBillingDisclosure(result.output)
  }
}

describe("acceptance — the snapshot sees what porcelain status hides", () => {
  test(
    "a second edit to an already-modified file is a difference while its status stays ` M`",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      try {
        const status = async () => (await readGit(repo.dir, ["status", "--porcelain"])).toString("utf8")
        const before = await snapshot(repo.dir)
        const statusBefore = await status()
        expect(statusBefore).toContain(" M src/pay.ts")
        await writeFile(join(repo.dir, "src", "pay.ts"), "export const fee = (total: number) => total * 0.02\n")
        await writeFile(join(repo.dir, "notes.txt"), "untracked scratch, edited\n")
        expect(await status()).toBe(statusBefore)
        expect(differences(before, await snapshot(repo.dir)).sort()).toEqual([
          `changed "notes.txt"`,
          `changed "src/pay.ts"`,
        ])
      } finally {
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )

  test(
    "staging a file changes the index; adding a branch changes the refs",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      try {
        const before = await snapshot(repo.dir)
        await setupGit(repo.dir, ["add", "notes.txt"])
        expect(worktreeDifferences(before, await snapshot(repo.dir))).toEqual(["the staged index changed"])
        const staged = await snapshot(repo.dir)
        await setupGit(repo.dir, ["branch", "side"])
        expect(worktreeDifferences(staged, await snapshot(repo.dir))).toEqual(["refs changed"])
      } finally {
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )

  test(
    "switching HEAD to another branch at the same commit is a difference though refs and index are unchanged",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      try {
        await setupGit(repo.dir, ["branch", "side"])
        const before = await snapshot(repo.dir)
        await setupGit(repo.dir, ["symbolic-ref", "HEAD", "refs/heads/side"])
        expect(worktreeDifferences(before, await snapshot(repo.dir))).toEqual(["HEAD changed"])
      } finally {
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )

  test(
    "a hook or a config line written under .git is a difference",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      try {
        const before = await snapshot(repo.dir)
        await writeFile(join(repo.dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\n")
        await setupGit(repo.dir, ["config", "core.fsmonitor", "true"])
        expect(differences(before, await snapshot(repo.dir)).sort()).toEqual([
          `added ".git/hooks/pre-commit"`,
          `changed ".git/config"`,
        ])
      } finally {
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )
})

describe("acceptance — the snapshot records new, removed, re-moded and re-linked paths", () => {
  test(
    "setting the executable bit on a tracked file is a difference though its bytes are unchanged",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      try {
        const before = await snapshot(repo.dir)
        await chmod(join(repo.dir, "src", "pay.ts"), 0o755)
        expect(differences(before, await snapshot(repo.dir))).toEqual([`changed "src/pay.ts"`])
      } finally {
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )

  test(
    "a new untracked file, a removed one, and a symlink retargeted outside the repository are each a difference",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      try {
        await symlink("src/pay.ts", join(repo.dir, "link"))
        const before = await snapshot(repo.dir)
        await writeFile(join(repo.dir, "new.txt"), "")
        await rm(join(repo.dir, "notes.txt"))
        await rm(join(repo.dir, "link"))
        await symlink(tmpdir(), join(repo.dir, "link"))
        expect(differences(before, await snapshot(repo.dir)).sort()).toEqual([
          `added "new.txt"`,
          `changed "link"`,
          `removed "notes.txt"`,
        ])
      } finally {
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )
})

describe("acceptance — the fake host refuses what it cannot answer honestly", () => {
  test(
    "an unknown route, an unknown session, an unscripted turn and a repeated delete are each recorded and answered with an error",
    async () => {
      const host = startFakeHost({})
      try {
        const post = (path: string, body: unknown) =>
          fetch(`${host.url}${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })
        const turn = { parts: [{ type: "text", text: "x" }], model: { providerID: "p", modelID: "m" } }
        expect((await fetch(`${host.url}/nope`)).status).toBe(404)
        expect((await post("/session/ses_unknown/message", turn)).status).toBe(404)
        const created = (await (await post("/session", {})).json()) as { id: string }
        const discovery = { ...turn, format: { type: "json_schema", schema: { properties: { findings: {} } } } }
        expect((await post(`/session/${created.id}/message`, discovery)).status).toBe(400)
        expect((await post(`/session/${created.id}/message`, "not an object")).status).toBe(400)
        expect((await fetch(`${host.url}/session/${created.id}`, { method: "DELETE" })).status).toBe(200)
        expect((await fetch(`${host.url}/session/${created.id}`, { method: "DELETE" })).status).toBe(404)
        expect(host.problems).toEqual([
          "unexpected route GET /nope",
          "prompt for a session that was not created: ses_unknown",
          "a discovery turn arrived and none is scripted",
          "prompt body lacks parts, format or model",
          `delete for a session that was not created or is already gone: ${created.id}`,
        ])
      } finally {
        await host.stop()
      }
    },
    TIMEOUT_MS,
  )
})

describe("acceptance — mad_review through the shipped plugin entry", () => {
  test(
    "ordinary findings: three answered slots, a ranked and upheld finding on the changed file, nothing changed",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      try {
        const run = await runScenario(repo, { discovery: [FEE_FINDING], judge: { "fact-check": FEE_FACT_CHECK } })
        expectClean(run)
        expect(run.result.metadata?.requested).toBe(3)
        expect(run.result.metadata?.answered).toBe(3)
        // The fan-out disclosure is the one expected warning: an ordinary review
        // sends the change to three providers and must say so.
        expect(run.result.metadata?.warnings).toEqual(["provider-fan-out"])
        // The session-policy probe, then three discovery turns and one
        // fact-check: a 3/3 co-discovery skips debate. The probe is never prompted.
        expect(run.host.counts.create).toBe(5)
        expect(run.host.counts.prompt).toBe(4)
        // CAP-3 — every session, the probe included, was created with MAD's
        // rules; every prompt carried the read-only notice; and MAD's own blame
        // evidence reached the fact-check, with host tools denied.
        expect(run.host.creates.map((body) => (body as { permission?: unknown }).permission)).toEqual(
          Array(5).fill(REVIEW_SESSION_PERMISSION),
        )
        expect(run.host.prompts.every((p) => p.system.endsWith(`\n\n${READ_ONLY_SESSION_NOTICE}`))).toBe(true)
        expect(run.host.prompts.some((p) => p.text.includes("What `git blame` says about the lines this finding cites"))).toBe(true)
        expect(run.host.counts.delete).toBe(5)
        // The ranked row, its verdict and the route that decided it, in the
        // report's own format.
        const report = run.result.output
        expect(report).toContain("WARNINGS: none — this run is clean.")
        expect(report).toContain("FINDINGS (1)")
        expect(report).toMatch(/#1 {2}\[medium\] {2}src\/pay\.ts:1\n\s+co-discovery: 3\/3 {3}verdict: upheld/)
        expect(report).toContain("route: judge (verify-independently)")
        expect(report).toContain("Verdicts: 1 upheld, 0 ruled invalid, 0 not settled, 0 withdrawn.")
        expect(report).toContain(FEE_FINDING.claim)
        expect(report).toContain(FEE_FACT_CHECK.findings)
        expect(report).toContain("UNRESOLVED — YOU DECIDE (0)\n  Nothing was left undecided.")
        expect(report).not.toContain("This is a PARTIAL review.")
      } finally {
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )

  test(
    "no change: a clean tree is reported as nothing to review, and no model session is opened",
    async () => {
      const repo = await makeReviewRepo({ dirty: false })
      try {
        const run = await runScenario(repo, {})
        expectClean(run)
        expect(run.result.title).toBe("MAD — nothing to review")
        expect(run.host.counts.create).toBe(0)
        expect(run.host.counts.prompt).toBe(0)
      } finally {
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )
})

describe("acceptance — option-shaped targets and configured filters are refused before anything runs (CAP-2)", () => {
  test(
    "an option-shaped target: refused, no file written, no git process, no host request, nothing changed",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      const scratch = await mkdtemp(join(tmpdir(), "mad-acceptance-target-"))
      const written = join(scratch, "written-by-git")
      const control = await gitCounter()
      const counted = await gitCounter()
      try {
        // Control: the same wrapper counts the git an ordinary review starts.
        await runScenario(repo, { discovery: [FEE_FINDING] }, { aroundExecute: control.around })
        expect(await control.launches()).toBeGreaterThan(0)

        const run = await runScenario(repo, { discovery: [FEE_FINDING] }, { args: { target: `--output=${written}` }, aroundExecute: counted.around })
        expectClean(run)
        expect(run.result.title).toBe("MAD — unsupported target")
        expect(run.result.output).toContain('starts with "-"')
        expect(await counted.launches()).toBe(0)
        expect(run.host.counts).toEqual({ providers: 0, create: 0, prompt: 0, delete: 0, abort: 0 })
        await expect(stat(written)).rejects.toThrow()
      } finally {
        await control.dispose()
        await counted.dispose()
        await repo.remove()
        await rm(scratch, { recursive: true, force: true })
      }
    },
    TIMEOUT_MS,
  )

  test(
    "a configured executable filter: refused, no model session, the filter never runs, nothing changed",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      const scratch = await mkdtemp(join(tmpdir(), "mad-acceptance-filter-"))
      const log = join(scratch, "fired.log")
      try {
        await writeFile(log, "")
        const clean = join(scratch, "clean.sh")
        await writeFile(clean, `#!/bin/sh\necho clean >> '${log}'\ncat\n`, { mode: 0o755 })
        await writeFile(join(repo.dir, ".gitattributes"), "*.ts filter=x\n")
        await setupGit(repo.dir, ["config", "filter.x.clean", clean])

        const counted = await gitCounter()
        try {
          const run = await runScenario(repo, { discovery: [FEE_FINDING] }, { aroundExecute: counted.around })
          expectClean(run)
          expect(run.result.title).toBe("MAD — unsupported repository configuration")
          expect(run.result.output).toContain("does not support configured filters")
          expect(run.result.output).toContain("`x`")
          expect(run.host.counts.create).toBe(0)
          expect(run.host.counts.prompt).toBe(0)
          expect(await readFile(log, "utf8")).toBe("")
          // The filter preflight is the one git process started.
          expect(await counted.launches()).toBe(1)
        } finally {
          await counted.dispose()
        }
      } finally {
        await repo.remove()
        await rm(scratch, { recursive: true, force: true })
      }
    },
    TIMEOUT_MS,
  )
})

describe("acceptance — a submodule is reviewed as its commit pointer only (CAP-2)", () => {
  const commit = ["-c", "user.name=MAD test", "-c", "user.email=mad@example.invalid", "-c", "commit.gpgsign=false"]

  /** A committed review repository with one submodule `sub`, whose `f.txt` is then edited. */
  async function withDirtySubmodule(scratch: string) {
    const repo = await makeReviewRepo({ dirty: false })
    const origin = join(scratch, "sub-origin")
    await setupGit(scratch, ["init", "-q", origin])
    await writeFile(join(origin, "f.txt"), "one\n")
    await setupGit(origin, ["add", "f.txt"])
    await setupGit(origin, [...commit, "commit", "-q", "--no-verify", "-m", "sub"])
    await setupGit(repo.dir, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", origin, "sub"])
    await setupGit(repo.dir, [...commit, "commit", "-q", "--no-verify", "-m", "add sub"])
    await writeFile(join(repo.dir, "sub", "f.txt"), "two\n")
    return repo
  }

  test(
    "dirty submodule contents only: nothing to review, and the answer names what was not read",
    async () => {
      const scratch = await mkdtemp(join(tmpdir(), "mad-acceptance-sub-"))
      const repo = await withDirtySubmodule(scratch)
      try {
        const run = await runScenario(repo, { discovery: [FEE_FINDING] })
        expectClean(run)
        expect(run.result.title).toBe("MAD — nothing to review")
        expect(run.result.output).toContain("submodules as commit pointers only, their uncommitted contents not read")
        expect(run.host.counts.create).toBe(0)
      } finally {
        await repo.remove()
        await rm(scratch, { recursive: true, force: true })
      }
    },
    TIMEOUT_MS,
  )

  test(
    "a tracked edit beside dirty submodule contents: a completed review, framed as before, then the scope notice",
    async () => {
      const scratch = await mkdtemp(join(tmpdir(), "mad-acceptance-sub-"))
      const repo = await withDirtySubmodule(scratch)
      try {
        await writeFile(join(repo.dir, "src", "pay.ts"), "export const fee = (total: number) => total * 0.01\n")

        const run = await runScenario(repo, { discovery: [FEE_FINDING], judge: { "fact-check": FEE_FACT_CHECK } })
        expectClean(run)
        expect(run.result.title).toStartWith("MAD review — 1 finding")
        const output = run.result.output
        const spans = materialSpans(output)
        expect(spans).toHaveLength(1)
        expect(spans[0]!.body).toContain("FINDINGS (1)")
        expect(spans[0]!.body).not.toContain(SUBMODULE_SCOPE_NOTE.trim())
        // The framed report ends at its closing fence; the notice follows it.
        expect(output.endsWith(`\n${fenceOf(output, "review report")}${SUBMODULE_SCOPE_NOTE}`)).toBe(true)
        expect(SUBMODULE_SCOPE_NOTE).toContain("submodules as commit pointers only")
        expect(SUBMODULE_SCOPE_NOTE).toContain("uncommitted changes inside a submodule were not read")
      } finally {
        await repo.remove()
        await rm(scratch, { recursive: true, force: true })
      }
    },
    TIMEOUT_MS,
  )
})

describe("acceptance — review sessions run no host tool (CAP-3)", () => {
  const POLICY_STOP_TITLE = "STOPPED BY MAD (unsupported session policy) during discover — partial review"
  const MAD_STOPPED = "MAD stopped this run (a review session's permission rules could not be verified)"

  test(
    "A HOST THAT DOES NOT RECORD THE RULES IS REFUSED with nothing issued: absent, different or unreadable echo",
    async () => {
      for (const [echo, problem] of [
        [() => OMIT, "the host returned no permission rules for the session"],
        [() => [], "the host returned permission rules different from the ones MAD sent"],
        [() => [{ permission: "*", pattern: "*", action: "allow" }], "the host returned permission rules different from the ones MAD sent"],
        [() => "deny", "the host returned permission rules MAD could not read"],
      ] as const) {
        const repo = await makeReviewRepo({ dirty: true })
        try {
          const run = await runScenario(repo, { discovery: [FEE_FINDING], echo })
          expectClean(run)
          expect(run.result.title).toBe("MAD — unsupported session policy")
          expect(run.result.output).toContain(problem)
          expect(run.result.output).toContain("* * deny; StructuredOutput * allow")
          expect(run.result.output).toContain("no model was asked anything")
          expect(run.host.counts).toMatchObject({ create: 1, prompt: 0, delete: 1 })
        } finally {
          await repo.remove()
        }
      }
    },
    TIMEOUT_MS,
  )

  test(
    "A PROBE THAT GETS NO SESSION is refused as unchecked, not as an observed mismatch",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      try {
        const run = await runScenario(repo, { discovery: [FEE_FINDING], failCreate: (i) => i === 0 })
        expectClean(run)
        expect(run.result.title).toBe("MAD — could not check the session policy")
        expect(run.result.output).not.toContain("different from the ones MAD sent")
        expect(run.host.counts).toMatchObject({ create: 1, prompt: 0, delete: 0 })
      } finally {
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )

  test(
    "A LATER SESSION WHOSE RULES DIFFER is never prompted, no turn starts after it, and the partial report says MAD stopped the run",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      // Create 0 is the probe; 1-3 are the discovery sessions. The second
      // discovery session's rules come back different, while the first is held
      // in flight until the run has stopped.
      let release: () => void = () => undefined
      const held = new Promise<void>((resolve) => (release = resolve))
      try {
        let firstDiscovery: string | undefined
        const run = await runScenario(
          repo,
          {
            discovery: [FEE_FINDING],
            echo: (requested, index) => (index === 2 ? [] : requested),
            holdPrompt: (sessionID) => {
              firstDiscovery ??= sessionID
              return sessionID === firstDiscovery ? held : undefined
            },
            failDelete: (sessionID) => sessionID === "ses_fake_3",
          },
          {
            aroundExecute: async (body) => {
              const settled = body()
              // Released after the stop: a turn that answers late changes nothing.
              setTimeout(release, 200)
              return settled
            },
          },
        )
        expect(run.changed).toEqual([])
        const mismatched = run.host.sessionIds[2]!
        expect(mismatched).toBe("ses_fake_3")
        expect(run.host.prompts.some((p) => p.sessionID === mismatched)).toBe(false)
        // No judge or debate turn was issued after the stop.
        expect(run.host.prompts.every((p) => !p.text.includes("What `git blame` says"))).toBe(true)
        expect(run.host.counts.create).toBe(4)
        expect(run.result.title).toStartWith(`MAD review — ${POLICY_STOP_TITLE}`)
        expect(run.result.output).toStartWith("MAD STOPPED THIS RUN:")
        expect(run.result.output).toContain(`RUN CANCELLED — ${MAD_STOPPED} during the discover stage.`)
        expect(run.result.output).not.toContain("you stopped")
        expect(run.result.output).toContain("Turns already issued may still have run and been billed.")
        // A discovery turn was issued before MAD's stop: the OpenCode note sits
        // beside the core's own sentence, outside the span, and nothing was aborted.
        expect(run.result.output).not.toContain(ISSUED_TURNS_MAY_BILL)
        expect(run.result.output).toContain(ISSUED_TURNS_NOTE)
        expect(materialSpans(run.result.output).some((span) => span.body.includes(OPENCODE_BILLING_NOTE))).toBe(false)
        expect(run.host.counts.abort).toBe(0)
        expect(run.result.metadata?.cancelled).toBe("discover")
        expect(run.result.metadata?.warnings).toContain("run-cancelled")
        // The mismatched session's delete failed: it stays guarded.
        expect(run.result.metadata?.warnings).toContain("session-cleanup-unresolved")
        await expect(run.beforeTool({ tool: "bash", sessionID: mismatched, callID: "c" })).rejects.toThrow("MAD refused the tool call")
        // Sessions whose deletion was confirmed are released; a session MAD never made is untouched.
        await expect(run.beforeTool({ tool: "bash", sessionID: run.host.sessionIds[0]!, callID: "c" })).resolves.toBeUndefined()
        await expect(run.beforeTool({ tool: "bash", sessionID: "ses_someone_else", callID: "c" })).resolves.toBeUndefined()
      } finally {
        release()
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )

  test(
    "A POLICY STOP BESIDE A MODEL FAILURE does not claim no model failed",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      try {
        // ses_fake_2 is a discovery session and ses_fake_5 its retry (creates:
        // probe, three discovery sessions, the retry). Both fail, so that slot
        // drops out. The next session, the judge's, comes back with other rules.
        const run = await runScenario(repo, {
          discovery: [FEE_FINDING],
          failPrompt: (sessionID) => sessionID === "ses_fake_2" || sessionID === "ses_fake_5",
          echo: (requested, index) => (index >= 5 ? [] : requested),
        })
        expect(run.changed).toEqual([])
        expect(run.result.title).toContain("STOPPED BY MAD (unsupported session policy) during judge")
        expect(run.result.output).not.toContain("No model failed")
        expect(run.result.output).not.toContain("you stopped")
        expect(run.result.metadata?.warnings).toContain("model-dropped-out")
      } finally {
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )

  test(
    "A USER STOP THAT WINS, then late creates with other rules or no usable id: refused and cleaned up, and the run is the user's stop",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      const stop = new AbortController()
      let release: () => void = () => undefined
      const held = new Promise<void>((resolve) => (release = resolve))
      try {
        const run = await runScenario(
          repo,
          {
            discovery: [FEE_FINDING],
            // Every discovery create is held until the user has stopped.
            holdCreate: (index) => (index >= 1 ? held : undefined),
            echo: (requested, index) => (index === 1 ? [] : requested),
            createAnswer: (answer, index) => (index === 2 ? { ...answer, id: 42 } : answer),
          },
          {
            aroundExecute: async (body) => {
              const settled = body()
              setTimeout(() => {
                stop.abort()
                release()
              }, 50)
              return settled
            },
            abort: stop.signal,
          },
        )
        expect(run.changed).toEqual([])
        expect(run.host.counts.prompt).toBe(0)
        expect(run.result.title).toStartWith("MAD review — CANCELLED during discover — partial review")
        expect(run.result.output).toContain("RUN CANCELLED — you stopped this run during the discover stage.")
        // Cancelled inside review() before any prompt: the core's portable
        // sentence stands, and the OpenCode note about issued turns is absent.
        expect(run.result.output).toContain(ISSUED_TURNS_MAY_BILL)
        expect(run.result.output).not.toContain(OPENCODE_BILLING_NOTE)
        expect(run.result.output).not.toContain("MAD STOPPED THIS RUN")
        expect(run.result.output).not.toContain("MAD stopped")
        // The probe, the mismatched session and the valid one are deleted; the
        // answer with no usable id gave nothing to delete it by.
        expect(run.host.counts.delete).toBe(3)
        await expect(run.beforeTool({ tool: "bash", sessionID: "ses_fake_3", callID: "c" })).resolves.toBeUndefined()
      } finally {
        release()
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )

  test(
    "A POLICY STOP THAT WINS keeps its cause when the user stops afterwards",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      const stop = new AbortController()
      try {
        const run = await runScenario(
          repo,
          {
            discovery: [FEE_FINDING],
            echo: (requested, index) => (index === 1 ? [] : requested),
            failDelete: (id) => {
              // The mismatch callback has already stopped the run before
              // its session is disposed. Stop as the user at that boundary.
              if (id === "ses_fake_2") stop.abort()
              return false
            },
          },
          {
            abort: stop.signal,
          },
        )
        expect(run.changed).toEqual([])
        expect(stop.signal.aborted).toBe(true)
        expect(run.result.title).toContain("STOPPED BY MAD (unsupported session policy) during discover")
        expect(run.result.output).toContain("RUN CANCELLED — MAD stopped this run")
        expect(run.result.output).not.toContain("you stopped")
      } finally {
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )

  test(
    "A USER STOP DURING THE PROBE: the pre-model stopped answer, nothing prompted, and the possible check session disclosed",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      const stop = new AbortController()
      let release: () => void = () => undefined
      const held = new Promise<void>((resolve) => (release = resolve))
      try {
        const run = await runScenario(
          repo,
          { discovery: [FEE_FINDING], holdCreate: (index) => (index === 0 ? held : undefined) },
          {
            aroundExecute: async (body) => {
              const settled = body()
              setTimeout(() => stop.abort(), 50)
              return settled
            },
            abort: stop.signal,
          },
        )
        expect(run.changed).toEqual([])
        expect(run.host.counts.prompt).toBe(0)
        expect(run.result.title).toBe("MAD — review stopped")
        expect(run.result.output).toContain("MAD completed no review and asked no model")
        expect(run.result.output).toContain("a session may exist on the host")
        expect(run.result.output).toContain("that deletion is not confirmed in this answer")
        expectNoBillingDisclosure(run.result.output)
        // A late answer's tracking and failed delete are covered in
        // `session-policy.test.ts`; this host stops with the scenario.
      } finally {
        release()
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )

  test(
    "A PROBE THAT NEVER ANSWERS is refused as unchecked after the cleanup budget, with the possible check session disclosed",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      let release: () => void = () => undefined
      const held = new Promise<void>((resolve) => (release = resolve))
      try {
        const run = await runScenario(repo, { discovery: [FEE_FINDING], holdCreate: (index) => (index === 0 ? held : undefined) })
        expect(run.changed).toEqual([])
        expect(run.result.title).toBe("MAD — could not check the session policy")
        expect(run.result.output).toContain("did not answer within 5000ms")
        expect(run.result.output).toContain("a session may exist on the host")
        expect(run.host.counts.prompt).toBe(0)
      } finally {
        release()
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )

  test(
    "THE HOST'S OWN STOP DURING THE REVIEW is still the user's: the wording is unchanged",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      const stop = new AbortController()
      try {
        // The host's stop lands while the first discovery prompt is in flight.
        const run = await runScenario(
          repo,
          {
            discovery: [FEE_FINDING],
            holdPrompt: () => {
              stop.abort()
              return undefined
            },
          },
          {
            abort: stop.signal,
          },
        )
        expect(run.changed).toEqual([])
        expect(run.result.title).toStartWith("MAD review — CANCELLED during discover — partial review")
        expect(run.result.output).toContain("RUN CANCELLED — you stopped this run during the discover stage.")
        expect(run.result.output).not.toContain("MAD STOPPED THIS RUN")
        expect(run.result.output).not.toContain("MAD stopped")
      } finally {
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )

  test(
    "A USER STOP MID-MODEL: the portable billing warning in the report and the OpenCode note outside the span",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      const stop = new AbortController()
      const recorder = initiationRecorder()
      try {
        const run = await runScenario(
          repo,
          {
            discovery: [FEE_FINDING],
            holdPrompt: () => {
              if (!stop.signal.aborted) recorder.fire(stop)
              return undefined
            },
          },
          {
            abort: stop.signal,
            recorder,
          },
        )
        expectClean(run)
        // CAP-5 snapshot rule: prompts started before the marker are allowed; none after.
        expectNothingStartedAfterStop(recorder)
        expect(recorder.beforeStop().some((event) => event.kind === "host" && /\/message$/.test(event.path ?? ""))).toBe(true)
        expectStopClaims(run.result, true)
        expect(run.result.title).toStartWith("MAD review — CANCELLED during discover")
        expect(run.host.counts.prompt).toBeGreaterThan(0)
        expect(run.result.metadata?.cancelled).toBe("discover")
        const output = run.result.output
        // The portable sentence is the core's, inside the framed report; the
        // OpenCode note is MAD's own, outside it.
        const spans = materialSpans(output)
        expect(spans).toHaveLength(1)
        const report = spans[0]!
        expect(report.body).toContain(ISSUED_TURNS_MAY_BILL)
        expect(report.body).toContain("MAD started no turn and retried no model after it observed the stop.")
        expect(report.body).not.toContain(OPENCODE_BILLING_NOTE)
        const closingFence = output.indexOf(`\n${fenceOf(output, "review report")}`, report.end)
        expect(closingFence).toBeGreaterThanOrEqual(report.end)
        const after = output.slice(closingFence)
        expect(after).toContain(SUBMODULE_SCOPE_NOTE)
        expect(after).toContain(ISSUED_TURNS_NOTE)
        expect(after.indexOf(ISSUED_TURNS_NOTE)).toBeGreaterThan(after.indexOf(SUBMODULE_SCOPE_NOTE))
        expect(output.split(ISSUED_TURNS_NOTE)).toHaveLength(2)
        // MAD stopped waiting; it did not abort the host's request.
        expect(run.host.counts.abort).toBe(0)
        for (const claim of ["No model failed", "killed process", "were cancelled", "not billed"]) {
          expect(output).not.toContain(claim)
        }
      } finally {
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )

  test(
    "A FINISHED REVIEW carries neither billing disclosure",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      try {
        const run = await runScenario(repo, { discovery: [FEE_FINDING] })
        expect(run.result.metadata?.cancelled).toBeUndefined()
        // A finished report counts billed turns, so only the stop disclosures are checked.
        expect(run.result.output).not.toContain(ISSUED_TURNS_MAY_BILL)
        expect(run.result.output).not.toContain("may still have run and been billed")
        expect(run.result.output).not.toContain(OPENCODE_BILLING_NOTE)
      } finally {
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )
})

describe("acceptance — the change input is read exactly or refused (CAP-4)", () => {
  test(
    "AN UNTRACKED FILE THAT VANISHES after listing: refused by name, no session, nothing changed",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      try {
        await unlink(join(repo.dir, "notes.txt")).catch(() => undefined)
        await writeFile(join(repo.dir, "gone.ts"), "x\n")
        // The file is removed once it has been listed, before MAD checks it.
        const run = await runScenario(
          repo,
          { discovery: [FEE_FINDING] },
          {
            aroundExecute: spawnHook((cmd, child) => {
              if (!cmd.includes("ls-files")) return
              const exited = child.exited.then(async (code) => {
                await unlink(join(repo.dir, "gone.ts")).catch(() => undefined)
                return code
              })
              return overriding(child, { exited })
            }),
          },
        )
        // The only change is the one this test made.
        expect(run.changed).toEqual(['removed "gone.ts"'])
        expect(run.result.title).toBe("MAD — could not read the change input")
        expect(run.result.output).toContain('the untracked entry "gone.ts": it no longer exists')
        expect(run.result.output).toContain("MAD reviewed nothing and asked no model")
        expect(run.host.counts.create).toBe(0)
        expect(run.host.counts.prompt).toBe(0)
      } finally {
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )

  test(
    "NAMES WITH A LEADING SPACE AND NON-ASCII LETTERS are reviewed under their exact names",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      try {
        await writeFile(join(repo.dir, " lead.ts"), "export const a = 1\n")
        await writeFile(join(repo.dir, "naïve.ts"), "export const b = 2\n")
        const run = await runScenario(repo, { discovery: [FEE_FINDING], judge: { "fact-check": FEE_FACT_CHECK } })
        expectClean(run)
        expect(run.result.title).toStartWith("MAD review — 1 finding")
        const discovery = run.host.prompts.find((p) => p.text.includes("export const a = 1"))
        expect(discovery).toBeDefined()
        expect(discovery!.text).toContain("export const b = 2")
        expect(discovery!.text).not.toContain('"na\\303\\257ve.ts"')
      } finally {
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )
})

describe("acceptance — the stop reaches MAD's own reads before any model is asked (CAP-5, part 5a)", () => {
  /** Wraps `git` on PATH for `execute` only: a working-tree `git diff --unified=8` sleeps instead. */
  async function slowDiffGit() {
    const real = Bun.which("git")
    if (real === null) throw new Error("git is not on PATH")
    const bin = await mkdtemp(join(tmpdir(), "mad-slow-git-"))
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\ncase " $* " in *" --unified=8 "*" --no-index "*) ;; *" --unified=8 "*) exec sleep 30 ;; esac\nexec '${real}' "$@"\n`,
      { mode: 0o755 },
    )
    return {
      around<T>(body: () => Promise<T>): Promise<T> {
        const saved = process.env.PATH
        process.env.PATH = `${bin}:${saved ?? ""}`
        return body().finally(() => {
          if (saved === undefined) delete process.env.PATH
          else process.env.PATH = saved
        })
      },
      dispose: () => rm(bin, { recursive: true, force: true }),
    }
  }

  test(
    "STOPPED AT ENTRY, even with an option-shaped target: no git, no host request, and the answer says nothing was read",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      const counted = await gitCounter()
      const stop = new AbortController()
      const recorder = initiationRecorder()
      recorder.fire(stop)
      try {
        const run = await runScenario(
          repo,
          { discovery: [FEE_FINDING] },
          {
            args: { target: "--output=/tmp/x" },
            aroundExecute: counted.around,
            abort: stop.signal,
            recorder,
          },
        )
        expectClean(run)
        // CAP-5 snapshot rule: the marker is the whole log.
        expectNothingStartedAfterStop(recorder)
        expect(recorder.log).toEqual([{ kind: "stop" }])
        expectStopClaims(run.result, false)
        expect(run.result.title).toBe("MAD — review stopped")
        expect(run.result.output).toBe("MAD reviewed nothing: the review was stopped before MAD read anything or asked any model.")
        expectNoBillingDisclosure(run.result.output)
        expect(await counted.launches()).toBe(0)
        expect(run.host.counts).toEqual({ providers: 0, create: 0, prompt: 0, delete: 0, abort: 0 })
      } finally {
        await counted.dispose()
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )

  test(
    "STOPPED DURING THE ROSTER READ: no git afterwards, and the answer says no repository content was read",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      const counted = await gitCounter()
      const stop = new AbortController()
      const recorder = initiationRecorder()
      try {
        const run = await runScenario(
          repo,
          { discovery: [FEE_FINDING], holdProviders: () => (recorder.fire(stop), undefined) },
          {
            aroundExecute: counted.around,
            abort: stop.signal,
            recorder,
          },
        )
        expectClean(run)
        // CAP-5 snapshot rule: the roster read was started before the marker; nothing after it.
        expectNothingStartedAfterStop(recorder)
        expect(recorder.beforeStop()).toEqual([expect.objectContaining({ kind: "host", method: "GET", path: "/config/providers" })])
        expectStopClaims(run.result, false)
        expect(run.result.title).toBe("MAD — review stopped")
        expect(run.result.output).toContain("before it read any repository content or asked any model")
        expectNoBillingDisclosure(run.result.output)
        expect(await counted.launches()).toBe(0)
        expect(run.host.counts.create).toBe(0)
      } finally {
        await counted.dispose()
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )

  test(
    "STOPPED WHILE GIT IS RUNNING: the read is killed, its cleanup reported, and it is not 'nothing to review'",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      const slow = await slowDiffGit()
      const stop = new AbortController()
      const recorder = initiationRecorder()
      try {
        // The stop fires, once, on an observed event: the launcher's first read
        // of the slowed working-tree `git diff`'s output. The child has been
        // launched and the launcher is waiting on it, so the stop lands while
        // that read is running. No timer is involved.
        const run = await runScenario(
          repo,
          { discovery: [FEE_FINDING] },
          {
            aroundExecute: (body) =>
              spawnHook((cmd, child) => {
                if (!isWorkingTreeDiff(cmd)) return
                const stdout = child.stdout as unknown as ReadableStream<Uint8Array>
                return overriding(child, {
                  stdout: {
                    getReader() {
                      const reader = stdout.getReader()
                      return new Proxy(reader, {
                        get(target, key) {
                          if (key === "read") {
                            return () => {
                              const pending = target.read()
                              if (!stop.signal.aborted) recorder.fire(stop)
                              return pending
                            }
                          }
                          const value = Reflect.get(target, key, target)
                          return typeof value === "function" ? value.bind(target) : value
                        },
                      })
                    },
                  },
                })
              })(() => slow.around(body)),
            abort: stop.signal,
            recorder,
          },
        )
        expectClean(run)
        expectNothingStartedAfterStop(recorder)
        const before = recorder.beforeStop()
        const gits = before.filter((event) => event.kind === "git")
        // The working-tree diff was the last read started, and it was started once.
        expect(gits.filter((event) => isWorkingTreeDiff(event.cmd))).toHaveLength(1)
        expect(isWorkingTreeDiff(gits.at(-1)!.cmd)).toBe(true)
        expect(before.some((event) => event.kind === "host" && event.path === "/session")).toBe(false)
        expectStopClaims(run.result, false)
        expect(run.result.title).toBe("MAD — review stopped while reading the change")
        expect(run.result.output).toContain("MAD completed no review and asked no model")
        // The diff is reported stopped, not completed.
        expect(run.result.output).toContain("git diff stopped (cancelled)")
        expect(run.result.output).toContain("Cleanup: confirmed")
        expect(run.host.counts.create).toBe(0)
        expectNoBillingDisclosure(run.result.output)
      } finally {
        await slow.dispose()
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )

  test(
    "STOPPED DURING THE UNTRACKED-FILE CHECK: the wait ends, nothing is opened, no model is asked",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      const stop = new AbortController()
      const { nodeInputFs } = await import("./change-input.ts")
      const realLstat = nodeInputFs.lstat
      let opened = false
      const realOpen = nodeInputFs.openNoFollow
      try {
        ;(nodeInputFs as { lstat: typeof realLstat }).lstat = () => {
          stop.abort()
          return new Promise(() => {})
        }
        ;(nodeInputFs as { openNoFollow: typeof realOpen }).openNoFollow = async (path) => {
          opened = true
          return realOpen(path)
        }
        const run = await runScenario(repo, { discovery: [FEE_FINDING] }, { abort: stop.signal })
        expect(run.changed).toEqual([])
        expect(run.result.title).toBe("MAD — review stopped while reading the change")
        expect(run.result.output).toContain("an operation already started may still complete")
        expect(opened).toBe(false)
        expect(run.host.counts.create).toBe(0)
      } finally {
        ;(nodeInputFs as { lstat: typeof realLstat }).lstat = realLstat
        ;(nodeInputFs as { openNoFollow: typeof realOpen }).openNoFollow = realOpen
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )

  test(
    "STOPPED AS AN EMPTY CHANGE READ ENDS: a stopped answer, never 'nothing to review'",
    async () => {
      const repo = await makeReviewRepo({ dirty: false })
      const stop = new AbortController()
      const recorder = initiationRecorder()
      try {
        // The stop lands as the last git read of a clean tree exits. Which
        // check sees it first (the launcher's race or the plugin's check after
        // the read) is not pinned: either way the answer is a stopped one.
        const run = await runScenario(
          repo,
          { discovery: [FEE_FINDING] },
          {
            aroundExecute: spawnHook((cmd, child) => {
              if (cmd.includes("ls-files")) void child.exited.then(() => recorder.fire(stop))
            }),
            abort: stop.signal,
            recorder,
          },
        )
        expectClean(run)
        expectNothingStartedAfterStop(recorder)
        expectStopClaims(run.result, false)
        expect(run.result.title).toStartWith("MAD — review stopped")
        expect(run.result.title).not.toBe("MAD — nothing to review")
        expect(run.host.counts.create).toBe(0)
      } finally {
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )
  test(
    "STOPPED WHILE A FAILING ROSTER READ IS PENDING: the stopped answer, not a roster error",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      const counted = await gitCounter()
      const stop = new AbortController()
      const recorder = initiationRecorder()
      try {
        const run = await runScenario(
          repo,
          {
            discovery: [FEE_FINDING],
            holdProviders: () => (recorder.fire(stop), undefined),
            failProviders: () => true,
          },
          {
            aroundExecute: counted.around,
            abort: stop.signal,
            recorder,
          },
        )
        expectClean(run)
        expectNothingStartedAfterStop(recorder)
        expectStopClaims(run.result, false)
        expect(run.result.title).toBe("MAD — review stopped")
        expect(run.result.output).toContain("before it read any repository content or asked any model")
        expectNoBillingDisclosure(run.result.output)
        expect(await counted.launches()).toBe(0)
        expect(run.host.counts.create).toBe(0)
      } finally {
        await counted.dispose()
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )

  /**
   * Lands the stop after a `git diff` has exited and won its race, before its
   * error reaches the plugin: the launcher cancels the stdout reader only after
   * the race is settled, and the wrapped reader fires the stop there.
   */
  function stopAfterDiffExits(stop: AbortController, stderrUnreadable = false) {
    return spawnHook((cmd, child) => {
      if (!cmd.includes("--unified=8")) return
      const wrap = (stream: ReadableStream<Uint8Array>, onCancel: () => void, failRead: boolean) => ({
        getReader() {
          const reader = stream.getReader()
          return {
            read: () => (failRead ? Promise.reject(new Error("EIO")) : reader.read()),
            cancel: (reason?: unknown) => (onCancel(), reader.cancel(reason)),
            releaseLock: () => reader.releaseLock(),
          }
        },
      })
      const stdout = wrap(child.stdout as unknown as ReadableStream<Uint8Array>, () => stop.abort(), false)
      const stderr = wrap(child.stderr as unknown as ReadableStream<Uint8Array>, () => undefined, stderrUnreadable)
      return overriding(child, { stdout, stderr })
    })
  }

  test(
    "A BAD REF WHOSE ERROR LANDS JUST BEFORE THE STOP: the stop is reported, with git's error, not the bad-ref hint",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      const stop = new AbortController()
      try {
        const run = await runScenario(
          repo,
          { discovery: [FEE_FINDING] },
          {
            args: { target: "no-such-ref" },
            aroundExecute: stopAfterDiffExits(stop),
            abort: stop.signal,
          },
        )
        expect(run.changed).toEqual([])
        expect(run.result.title).toBe("MAD — review stopped while reading the change")
        expect(run.result.output).toContain("after that read had ended without a change to review")
        expect(run.result.output).toContain("git diff failed")
        expect(run.result.output).not.toContain("valid git ref")
        expect(run.host.counts.create).toBe(0)
      } finally {
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )

  test(
    "A STOPPED READ OF ANOTHER KIND JUST BEFORE THE STOP: the stop is reported with that read's facts and guidance",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      const stop = new AbortController()
      try {
        const run = await runScenario(
          repo,
          { discovery: [FEE_FINDING] },
          {
            aroundExecute: stopAfterDiffExits(stop, true),
            abort: stop.signal,
          },
        )
        expect(run.changed).toEqual([])
        expect(run.result.title).toBe("MAD — review stopped while reading the change")
        expect(run.result.output).toContain("git diff stopped (stderr-unread)")
        // git's stdout was read in full before the read was refused, so "No change was read" would be false.
        expect(run.result.output).toContain("Some of the change may have been read, but none of it was returned for review.")
        expect(run.result.output).not.toContain("No change was read.")
        expect(run.result.output).not.toBe("")
        expect(run.host.counts.create).toBe(0)
      } finally {
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )
})

describe("acceptance — a filter preflight that cannot answer (CAP-2)", () => {
  test(
    "a malformed global config: its own guidance, not the bad-ref hint, no model session, nothing changed",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      const home = await mkdtemp(join(tmpdir(), "mad-acceptance-home-"))
      try {
        await writeFile(join(home, ".gitconfig"), "[broken\n")
        // Only MAD's own reads see this HOME: the snapshot's git ignores global config.
        const brokenHome = async <T>(body: () => Promise<T>): Promise<T> => {
          const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
          process.env.HOME = home
          process.env.XDG_CONFIG_HOME = join(home, ".config")
          try {
            return await body()
          } finally {
            for (const [key, value] of Object.entries(saved)) {
              if (value === undefined) delete process.env[key]
              else process.env[key] = value
            }
          }
        }

        const run = await runScenario(repo, { discovery: [FEE_FINDING] }, { aroundExecute: brokenHome })
        expectClean(run)
        expect(run.result.title).toBe("MAD — could not check the repository's git config")
        expect(run.result.output).toContain("git config (filter preflight) failed:")
        expect(run.result.output).toContain("git config --list --show-origin")
        expect(run.result.output).not.toContain("valid git ref")
        expect(run.result.output).not.toContain("git repository with at least one commit")
        expect(run.host.counts.create).toBe(0)
        expect(run.host.counts.prompt).toBe(0)
      } finally {
        await repo.remove()
        await rm(home, { recursive: true, force: true })
      }
    },
    TIMEOUT_MS,
  )
})

describe("acceptance — the network guard rejects what would leave the allowed origin", () => {
  test(
    "a backend pointed away from the fake host has every request rejected before it leaves the process",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      // A loopback origin nothing listens on, never a real provider endpoint.
      // The guard must reject before the real `fetch` is reached, so whether
      // anything listens there does not change the outcome.
      const elsewhere = "http://127.0.0.1:9"
      try {
        const run = await runScenario(repo, { discovery: [FEE_FINDING] }, { serverUrl: elsewhere })
        expect(run.changed).toEqual([])
        expect(run.host.problems).toEqual([])
        expect([...run.host.openSessions]).toEqual([])
        expect(run.shellProblems).toEqual([])
        expect(run.guard.blocked.length).toBeGreaterThan(0)
        expect(run.guard.blocked.every((url) => new URL(url).origin === elsewhere)).toBe(true)
        // Only the roster read went to the fake host; no session was created there.
        expect(run.guard.delegated()).toBe(run.host.counts.providers)
        expect(run.host.counts.create).toBe(0)
        // The first blocked request is the session-policy probe (CAP-3), so the
        // user is told MAD could not check the policy, and no model was asked.
        // It does not read as a clean review or as nothing to review.
        expect(run.result.title).toBe("MAD — could not check the session policy")
        expect(run.result.output).toContain("no model was asked anything")
        expect(run.result.output).not.toContain("permission rules different from")
        expect(run.host.counts.prompt).toBe(0)
      } finally {
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )

  test(
    "AND A HOST THAT FAILS ITS TURNS AFTER THE PROBE gives the degraded report — the guard is not what refused it",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      try {
        // Every prompt fails; the probe, which sends none, succeeds.
        const run = await runScenario(repo, { discovery: [FEE_FINDING], failPrompt: () => true })
        expect(run.changed).toEqual([])
        expect(run.guard.blocked).toEqual([])
        expect(run.host.counts.prompt).toBeGreaterThan(0)
        // The user is told the models did not answer; it does not read as a
        // clean review or as nothing to review.
        expect(run.result.metadata?.answered).toBe(0)
        expect(run.result.metadata?.warnings).toContain("model-dropped-out")
        expect(run.result.title).not.toBe("MAD — nothing to review")
        expect(run.result.output).not.toContain("WARNINGS: none")
      } finally {
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )

  test(
    "a redirect from an allowed origin to another loopback server is rejected, and that server is never reached",
    async () => {
      let reached = 0
      const forbidden = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => (reached++, new Response("forbidden")) })
      let allowed: ReturnType<typeof Bun.serve> | undefined
      let guard: NetworkGuard | undefined
      try {
        allowed = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: () => new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${forbidden.port}/x` } }),
        })
        guard = installNetworkGuard([`http://127.0.0.1:${allowed.port}`])
        // Both shapes a caller can use to ask for redirects to be followed.
        await expect(fetch(`http://127.0.0.1:${allowed.port}/a`, { redirect: "follow" })).rejects.toThrow("network blocked")
        await expect(fetch(new Request(`http://127.0.0.1:${allowed.port}/b`, { redirect: "follow" }))).rejects.toThrow(
          "network blocked",
        )
        expect(guard.blocked).toEqual([`http://127.0.0.1:${forbidden.port}/x`, `http://127.0.0.1:${forbidden.port}/x`])
        expect(reached).toBe(0)
      } finally {
        guard?.restore()
        await allowed?.stop(true)
        await forbidden.stop(true)
      }
    },
    TIMEOUT_MS,
  )

  test("preconnect is blocked, and a second guard cannot be stacked on an active one", () => {
    const guard = installNetworkGuard(["http://127.0.0.1:1"])
    try {
      expect(() => fetch.preconnect("http://127.0.0.1:9")).toThrow("network blocked")
      expect(guard.blocked).toEqual(["http://127.0.0.1:9"])
      expect(() => installNetworkGuard([])).toThrow("already installed")
    } finally {
      guard.restore()
    }
  })
})

describe("acceptance — the stop reaches MAD's own blame evidence reads (CAP-5, part 5b)", () => {
  /**
   * Wraps `git` on PATH for `execute` only: every `git blame` is logged and then
   * sleeps instead of running. With `holdOutput`, it first starts a background
   * process that inherits its output and records that process's pid, so the
   * kill cannot account for the output and cleanup stays unresolved.
   */
  async function heldBlameGit(options: { holdOutput?: boolean } = {}) {
    const real = Bun.which("git")
    if (real === null) throw new Error("git is not on PATH")
    const bin = await mkdtemp(join(tmpdir(), "mad-held-blame-"))
    const log = join(bin, "blames.log")
    const holder = join(bin, "holder.pid")
    await writeFile(log, "")
    const hold = options.holdOutput ? `sleep 30 & echo $! > '${holder}'; ` : ""
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\ncase " $* " in *" blame "*) echo x >> '${log}'; ${hold}exec sleep 30 ;; esac\nexec '${real}' "$@"\n`,
      { mode: 0o755 },
    )
    const blames = async () => (await readFile(log, "utf8")).split("\n").filter((line) => line.length > 0).length
    return {
      blames,
      /** Runs `body` with the wrapper on PATH, and calls `fire` once the first blame is running. */
      around(fire: () => void) {
        return async <T>(body: () => Promise<T>): Promise<T> => {
          const saved = process.env.PATH
          process.env.PATH = `${bin}:${saved ?? ""}`
          let polling = true
          const poll = (async () => {
            while (polling && (await blames()) === 0) await Bun.sleep(10)
            if (polling) fire()
          })()
          try {
            return await body()
          } finally {
            polling = false
            await poll
            if (saved === undefined) delete process.env.PATH
            else process.env.PATH = saved
          }
        }
      },
      async dispose() {
        const pid = Number((await readFile(holder, "utf8").catch(() => "")).trim())
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, "SIGKILL")
          } catch {
            // Already gone.
          }
        }
        await rm(bin, { recursive: true, force: true })
      },
    }
  }

  test(
    "STOPPED WHILE BLAME RUNS: one blame launch, killed; no fact-check prompt; both findings undecided and cancelled",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      const held = await heldBlameGit()
      const stop = new AbortController()
      const recorder = initiationRecorder()
      try {
        const run = await runScenario(
          repo,
          { discovery: [FEE_FINDING, NOTES_FINDING], judge: { "fact-check": FEE_FACT_CHECK } },
          {
            aroundExecute: held.around(() => recorder.fire(stop)),
            abort: stop.signal,
            recorder,
          },
        )
        expectClean(run)
        // CAP-5 snapshot rule: the held blame was started before the marker; nothing after it.
        expectNothingStartedAfterStop(recorder)
        expect(recorder.beforeStop().some((event) => event.kind === "git" && event.cmd.includes("blame"))).toBe(true)
        expectStopClaims(run.result, true)
        expect(await held.blames()).toBe(1)
        // Three discovery prompts and nothing after them: no fact-check was asked.
        expect(run.host.counts.prompt).toBe(3)
        expect(run.host.prompts.every((p) => !p.text.includes("What `git blame` says"))).toBe(true)
        expect(run.result.title).toStartWith("MAD review — CANCELLED during judge")
        const report = run.result.output
        expect(report).toContain("Verdicts: 0 upheld, 0 ruled invalid, 0 not settled, 0 withdrawn.")
        expect(report).toContain("UNRESOLVED — YOU DECIDE (2)")
        expect(report).toContain("`git blame` STOPPED — the run was cancelled, so MAD produced no citation and decided nothing")
        expect(report).not.toContain("GIT BLAME FAILED")
        expect(report).not.toContain("ran out of budget")
        expect(report).toContain("2 finding(s) were left undecided because the run was cancelled")
        expect(report).toContain("MAD produced no `git blame` citation of its own in this run")
        expect(run.result.metadata?.warnings).not.toContain("blame-unavailable")
        expect(report).not.toContain("MAD will launch no further `git blame`")
      } finally {
        await held.dispose()
        clearBlameQuarantineForTests(repo.dir)
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )

  test(
    "STOPPED WHILE BLAME RUNS, cleanup unresolved: the note names the operation, the pid and the reason, and no further blame",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      const held = await heldBlameGit({ holdOutput: true })
      const stop = new AbortController()
      const recorder = initiationRecorder()
      try {
        const run = await runScenario(
          repo,
          { discovery: [FEE_FINDING, NOTES_FINDING], judge: { "fact-check": FEE_FACT_CHECK } },
          {
            aroundExecute: held.around(() => recorder.fire(stop)),
            abort: stop.signal,
            recorder,
          },
        )
        expectClean(run)
        expectNothingStartedAfterStop(recorder)
        expectStopClaims(run.result, true)
        expect(await held.blames()).toBe(1)
        expect(run.host.counts.prompt).toBe(3)
        const note = run.result.output.slice(run.result.output.indexOf("When the review was stopped, MAD sent SIGKILL to its git blame"))
        const pid = /^When the review was stopped, MAD sent SIGKILL to its git blame \(process (\d+)\)\./.exec(note)?.[1]
        expect(pid).toBeDefined()
        // The git MAD sent SIGKILL to was seen to end; a background process still holds its output.
        expect(note).toContain(`Process ${pid} itself was seen to end, but MAD could not confirm its cleanup`)
        expect(note).toContain(
          "MAD will launch no further `git blame` or its filter preflight in this worktree from this opencode process.",
        )
        expect(note).toContain(`Look for processes that process ${pid} started; restarting opencode clears this refusal.`)
        // MAD's voice only: nothing of the launcher's reason or the blamed path.
        expect(note).not.toContain("--porcelain")
        expect(note).not.toContain("CLEANUP IS UNCONFIRMED")
        // The note is MAD's, outside the framed report.
        expect(materialSpans(run.result.output).some((span) => span.body.includes("MAD will launch no further"))).toBe(false)
      } finally {
        await held.dispose()
        clearBlameQuarantineForTests(repo.dir)
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )
})

describe("acceptance — CAP-5 integration: the initiation recorder and the guard's hook", () => {
  test(
    "THE GUARD REPORTS EVERY REQUEST AS IT STARTS: a Request with no init, lowercase methods, string and URL inputs, and a blocked one",
    async () => {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") })
      const origin = `http://127.0.0.1:${server.port}`
      const seen: { method: string; url: string }[] = []
      const guard = installNetworkGuard([origin], (request) => seen.push(request))
      try {
        // The SDK's shape: a Request carrying the method, and no init.
        await (await fetch(new Request(`${origin}/a`, { method: "post", body: "x" }))).text()
        await (await fetch(`${origin}/b`)).text()
        await (await fetch(new URL(`${origin}/c`), { method: "delete" })).text()
        // An init's method wins over the Request's, as it does in `fetch`.
        await (await fetch(new Request(`${origin}/d`), { method: "patch" })).text()
        await expect(fetch("http://127.0.0.1:9/e")).rejects.toThrow("network blocked")
        expect(seen).toEqual([
          { method: "POST", url: `${origin}/a` },
          { method: "GET", url: `${origin}/b` },
          { method: "DELETE", url: `${origin}/c` },
          { method: "PATCH", url: `${origin}/d` },
          { method: "GET", url: "http://127.0.0.1:9/e" },
        ])
        expect(guard.blocked).toEqual(["http://127.0.0.1:9/e"])
      } finally {
        guard.restore()
        await server.stop(true)
      }
    },
    TIMEOUT_MS,
  )

  test("A HOOK THAT THROWS makes that fetch reject rather than throw, and nothing is delegated", async () => {
    const guard = installNetworkGuard(["http://127.0.0.1:1"], () => {
      throw new Error("hook failed")
    })
    try {
      // Checked by hand: bun's `toThrow` would await a returned promise.
      let pending: Promise<Response> | undefined
      let threw = false
      try {
        pending = fetch("http://127.0.0.1:1/x")
      } catch {
        threw = true
      }
      expect(threw).toBe(false)
      await expect(pending!).rejects.toThrow("hook failed")
      expect(guard.delegated()).toBe(0)
    } finally {
      guard.restore()
    }
  })

  test("THE RECORDER LOGS BOTH SPAWN FORMS AND spawnSync, passing every argument on; other programs are not logged", async () => {
    const recorder = initiationRecorder()
    const realSpawn = Bun.spawn
    const realSpawnSync = Bun.spawnSync
    try {
      await recorder.around(async () => {
        // The second argument reaches the real spawn: with stdout ignored there is no stream.
        const array = Bun.spawn(["git", "--version"], { stdout: "ignore", stderr: "ignore" })
        expect(array.stdout).toBeFalsy()
        await array.exited
        const object = Bun.spawn({ cmd: ["git", "--version"], stdout: "pipe", stderr: "ignore" })
        expect(await new Response(object.stdout).text()).toStartWith("git version")
        const sync = Bun.spawnSync(["git", "--version"], { stdout: "ignore" })
        expect(sync.stdout).toBeFalsy()
        await Bun.spawn(["true"]).exited
      })
      expect(recorder.log).toEqual([
        { kind: "git", cmd: ["git", "--version"] },
        { kind: "git", cmd: ["git", "--version"] },
        { kind: "git", cmd: ["git", "--version"] },
      ])
    } finally {
      recorder.dispose()
    }
    expect(Bun.spawn).toBe(realSpawn)
    expect(Bun.spawnSync).toBe(realSpawnSync)
  })

  test("THE RECORDER KEEPS LOGGING AFTER around SETTLES until dispose, exempts only what exempt runs, and refuses reentrance", async () => {
    const recorder = initiationRecorder()
    const realSpawn = Bun.spawn
    try {
      await recorder.around(async () => {
        await recorder.exempt(() => Bun.spawn(["git", "--version"], { stdout: "ignore" }).exited)
      })
      // Detached work after the body has returned is still logged.
      await Bun.spawn(["git", "--version"], { stdout: "ignore" }).exited
      await expect(recorder.around(async () => undefined)).rejects.toThrow("already entered")
      expect(recorder.log).toEqual([{ kind: "git", cmd: ["git", "--version"] }])
      recorder.dispose()
      expect(Bun.spawn).toBe(realSpawn)
      await Bun.spawn(["git", "--version"], { stdout: "ignore" }).exited
      expect(recorder.log).toHaveLength(1)
    } finally {
      recorder.dispose()
    }
  })

  test("THE RECORDER RESTORES THE SPAWN FUNCTIONS AT ONCE when around's body throws", async () => {
    const recorder = initiationRecorder()
    const realSpawn = Bun.spawn
    const realSpawnSync = Bun.spawnSync
    await expect(
      recorder.around(async () => {
        throw new Error("body failed")
      }),
    ).rejects.toThrow("body failed")
    expect(Bun.spawn).toBe(realSpawn)
    expect(Bun.spawnSync).toBe(realSpawnSync)
  })

  test("THE RULE IS READ RELATIVE TO THE HOST'S BASE URL: every model-work route after the marker is a violation, cleanup is not", async () => {
    const recorder = initiationRecorder()
    recorder.attach("http://127.0.0.1:1/base/")
    try {
      await recorder.around(async () => {
        const request = (method: string, path: string) => recorder.onRequest({ method, url: `http://127.0.0.1:1${path}` })
        request("POST", "/base/session")
        recorder.fire(new AbortController())
        request("GET", "/base/session/s")
        request("DELETE", "/base/session/s")
        for (const route of ["message", "prompt_async", "command", "shell", "summarize", "init", "fork"]) {
          request("POST", `/base/session/s/${route}`)
        }
        request("POST", "/base/session")
        // Outside the base URL: not a host route at all, so a violation of its own.
        request("POST", "/session")
      })
      expect(
        recorder.violations().map((event) => (event.kind === "host" ? `${event.method} ${event.path ?? event.url}` : event.kind)),
      ).toEqual([
        "POST /session/s/message",
        "POST /session/s/prompt_async",
        "POST /session/s/command",
        "POST /session/s/shell",
        "POST /session/s/summarize",
        "POST /session/s/init",
        "POST /session/s/fork",
        "POST /session",
        "POST http://127.0.0.1:1/session",
      ])
      expect(recorder.beforeStop()).toEqual([
        { kind: "host", method: "POST", url: "http://127.0.0.1:1/base/session", path: "/session" },
      ])
    } finally {
      recorder.dispose()
    }
  })

  test(
    "THE RECORDER CATCHES WHAT STARTS AFTER THE MARKER through the real entry: a git spawn, and a create and a prompt in the SDK's request shape",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      const stop = new AbortController()
      const recorder = initiationRecorder()
      let injected = false
      const problems: string[] = []
      try {
        const run = await runScenario(
          repo,
          {
            discovery: [FEE_FINDING],
            holdPrompt: async () => {
              if (injected) return
              injected = true
              // The marker alone first, then the injections while the plugin is
              // still waiting, then the stop itself: what follows the marker is
              // caught whenever the abort lands.
              recorder.fire(new AbortController())
              await Bun.spawn({ cmd: ["git", "--version"], stdout: "ignore", stderr: "ignore" }).exited
              const base = recorder.base!.replace(/\/+$/, "")
              // As the SDK sends them: a Request carrying everything, and no init.
              const send = (method: string, path: string, body?: unknown) =>
                fetch(
                  new Request(`${base}${path}?injected=1`, {
                    method,
                    headers: { "content-type": "application/json" },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                  }),
                )
              const created = await send("POST", "/session", {})
              if (!created.ok) problems.push(`the injected create answered ${created.status}`)
              const id = ((await created.json()) as { id?: unknown }).id
              if (typeof id !== "string") {
                problems.push("the injected create carried no session id")
              } else {
                const prompted = await send("POST", `/session/${id}/message`, {
                  parts: [{ type: "text", text: "injected after the marker" }],
                  format: { type: "json_schema", schema: { type: "object", properties: { findings: {} } } },
                  model: { providerID: "injected", modelID: "injected" },
                })
                if (!prompted.ok) problems.push(`the injected prompt answered ${prompted.status}`)
                await prompted.body?.cancel()
                const deleted = await send("DELETE", `/session/${id}`)
                if (!deleted.ok) problems.push(`the injected delete answered ${deleted.status}`)
                await deleted.body?.cancel()
              }
              stop.abort()
            },
          },
          { abort: stop.signal, recorder },
        )
        expectClean(run)
        expect(injected).toBe(true)
        expect(problems).toEqual([])
        // The run itself ends as the user's cancellation, during discovery.
        expect(run.result.metadata?.cancelled).toBe("discover")
        expect(run.result.title).toStartWith("MAD review — CANCELLED during discover")
        const ours = (event: Initiated) =>
          event.kind === "git" ? event.cmd.join(" ") === "git --version" : event.kind === "host" && event.url.includes("injected=1")
        // The spawn, the create and the prompt are caught; the cleanup delete is not.
        const caught = recorder.violations().filter(ours)
        expect(caught.map((event) => (event.kind === "host" ? `${event.method} ${event.path}` : event.kind))).toEqual([
          "git",
          "POST /session",
          expect.stringMatching(/^POST \/session\/[^/]+\/message$/),
        ])
        const afterStop = recorder.afterStop().filter(ours)
        expect(afterStop.filter((event) => event.kind === "host" && event.method === "DELETE")).toHaveLength(1)
        // None of them was started before the marker.
        expect(recorder.beforeStop().some(ours)).toBe(false)
      } finally {
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )
})

describe("acceptance — CAP-5 integration: nothing starts after the stop is observed", () => {
  test(
    "STOPPED BETWEEN GIT READS, once name-only has returned to the read: the next read is never launched, and no model is asked",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      const stop = new AbortController()
      const recorder = initiationRecorder()
      // THE SEAM IS SYNCHRONOUS, AND IT DEPENDS ON repo.ts. The change read
      // reads the clock on every call (`now` defaults to `() =>
      // performance.now()`), and the first such reading after name-only's child
      // has exited is the final-read check that follows `accept` in `read`: the
      // outcome has been accepted and the next read's own stop check has not
      // run. Only a clock reading from repo.ts fires the stop, so no other
      // caller of `performance.now` can fire it early.
      const realNow = performance.now
      let nameOnlyExited = false
      let seamReached = false
      try {
        performance.now = function now(this: Performance) {
          if (nameOnlyExited && !stop.signal.aborted && (new Error().stack ?? "").includes("/adapters/opencode/repo.ts:")) {
            seamReached = true
            recorder.fire(stop)
          }
          return realNow.call(this)
        }
        const run = await runScenario(
          repo,
          { discovery: [FEE_FINDING] },
          {
            aroundExecute: spawnHook((cmd, child) => {
              if (!cmd.includes("--name-only")) return
              return overriding(child, { exited: child.exited.then((code) => ((nameOnlyExited = true), code)) })
            }),
            abort: stop.signal,
            recorder,
          },
        )
        expect(seamReached, "the between-reads seam was not reached: no repo.ts clock reading followed name-only's exit").toBe(
          true,
        )
        expectClean(run)
        expectNothingStartedAfterStop(recorder)
        const last = recorder.beforeStop().filter((event) => event.kind === "git").at(-1)
        expect(last?.kind === "git" && last.cmd.includes("--name-only")).toBe(true)
        expect(recorder.log.some((event) => event.kind === "git" && event.cmd.includes("ls-files"))).toBe(false)
        expect(recorder.log.some((event) => event.kind === "host" && event.path === "/session")).toBe(false)
        expect(run.host.counts.create).toBe(0)
        expect(run.host.counts.prompt).toBe(0)
        expect(run.result.title).toBe("MAD — review stopped while reading the change")
        // The stop was observed before the next read, not during name-only.
        expect(run.result.output).toContain("the review was stopped before git ls-files, so nothing was launched")
        expect(run.result.output).toContain("Part of the change was read, but none of it was returned for review.")
        expectStopClaims(run.result, false)
      } finally {
        performance.now = realNow
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )

  test(
    "STOPPED WHILE A FACT-CHECK IS IN FLIGHT: no later create, prompt or blame; cancelled during judge, with both disclosures",
    async () => {
      const repo = await makeReviewRepo({ dirty: true })
      const stop = new AbortController()
      const recorder = initiationRecorder()
      let release: () => void = () => undefined
      const held = new Promise<void>((resolve) => (release = resolve))
      const factChecks: FakePrompt[] = []
      try {
        const run = await runScenario(
          repo,
          {
            discovery: [FEE_FINDING, NOTES_FINDING],
            judge: { "fact-check": FEE_FACT_CHECK },
            // The fact-check is held, unanswered, while the stop lands.
            holdPrompt: (_sessionID, prompt) => {
              if (prompt.role !== "fact-check") return undefined
              factChecks.push(prompt)
              if (!stop.signal.aborted) recorder.fire(stop)
              return held
            },
          },
          { abort: stop.signal, recorder },
        )
        expectClean(run)
        expectNothingStartedAfterStop(recorder)
        // One fact-check, the first finding's, was in flight when the stop
        // fired, and MAD had run that finding's blame before asking it.
        expect(factChecks).toHaveLength(1)
        expect(factChecks[0]!.text).toContain(FEE_FINDING.claim)
        const before = recorder.beforeStop()
        const blames = recorder.log.filter((event) => event.kind === "git" && event.cmd.includes("blame"))
        expect(blames).toHaveLength(1)
        expect(before).toContain(blames[0]!)
        expect(blames[0]!.kind === "git" && blames[0]!.cmd.includes("src/pay.ts")).toBe(true)
        // The second finding got no blame and no judge turn. (Its file was read
        // once, by the change read's `--no-index` diff, long before the marker.)
        expect(blames.some((event) => event.kind === "git" && event.cmd.includes("notes.txt"))).toBe(false)
        expect(run.host.prompts.filter((p) => p.role !== undefined && p.text.includes(NOTES_FINDING.claim))).toEqual([])
        // Every prompt the host saw was started before the marker: three
        // discovery turns and the fact-check. A verify-independently finding is
        // judged by the fact-check alone, so no logic-eval was started.
        const promptsBefore = before.filter((event) => isModelAllocation(event) && event.kind === "host" && event.path !== "/session")
        expect(promptsBefore).toHaveLength(4)
        expect(run.host.counts.prompt).toBe(4)
        expect(run.host.prompts.map((p) => p.role)).toEqual([undefined, undefined, undefined, "fact-check"])
        expect(run.result.title).toStartWith("MAD review — CANCELLED during judge")
        expect(run.result.metadata?.cancelled).toBe("judge")
        expect(run.result.output).toContain("RUN CANCELLED — you stopped this run during the judge stage.")
        expect(run.result.output).toContain("notes.txt:1 — died at stage judge (the run was cancelled before it could be judged)")
        expect(run.host.counts.abort).toBe(0)
        expectStopClaims(run.result, true)
      } finally {
        release()
        await repo.remove()
      }
    },
    TIMEOUT_MS,
  )
})
