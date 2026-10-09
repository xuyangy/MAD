/**
 * Story 2-7b — the answer key never reaches a model: the worktree writer imports
 * no answer key, and a written worktree holds no target label id, summary or
 * predicate. Over real git.
 *
 * Story 2-7e2 — every git call is bounded: a hang, a child that traps SIGTERM
 * (which tests the immediate-SIGKILL policy; no SIGTERM is sent) and a
 * descendant holding a pipe, each a local `sh` stand-in, return within the
 * deadline plus the cleanup budget with the termination they established.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ADVERSARIAL_ASSERTIONS } from "../fixtures/adversarial/assertions.ts"
import { ADVERSARIAL_CASES } from "../fixtures/adversarial/material.ts"
import * as blameExec from "../adapters/opencode/blame-exec.ts"
import type { BlameExecOutcome } from "../adapters/opencode/blame-exec.ts"
import { DEFAULT_BLAME_CLEANUP_TIMEOUT_MS, DEFAULT_BLAME_TIMEOUT_MS } from "../adapters/opencode/tools.ts"
import {
  boundedGit,
  GIT_CLEANUP_TIMEOUT_MS,
  GIT_ISOLATION,
  GIT_TIMEOUT_MS,
  gitOutcomeOf,
  isolatedGitEnv,
  isolatedSpawn,
  materializeSide,
  spawnGit,
  type GitOutcome,
  type GitResult,
  type RunGit,
  type SpawnGit,
} from "./adversarial-materialize.ts"

const scratch: string[] = []
afterEach(async () => {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})

/** A git call that returned, or the test fails with the reason it did not. */
async function returned(call: Promise<GitOutcome>): Promise<GitResult> {
  const outcome = await call
  if (outcome.exitCode === null) throw new Error(outcome.reason)
  return outcome
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-adversarial-tree-"))
  scratch.push(dir)
  return dir
}

/**
 * Every file under a worktree except git's objects and git's own sample hooks
 * (git writes those from its template, and they hold ordinary English words
 * such as a marker), as one lower-cased corpus.
 */
async function corpusOf(root: string): Promise<{ text: string; files: string[] }> {
  const files: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir)) {
      const path = join(dir, entry)
      if ((entry === "objects" || entry === "hooks") && dir.endsWith(".git")) continue
      if ((await stat(path)).isDirectory()) await walk(path)
      else files.push(path)
    }
  }
  await walk(root)
  const texts = await Promise.all(files.map((file) => readFile(file, "utf8").catch(() => "")))
  return { text: texts.join("\n").toLowerCase(), files }
}

/** Every answer-key string the corpus holds that the material did not already carry. */
function answerKeyBytesIn(corpus: string, caseIndex: number): string[] {
  const material = ADVERSARIAL_CASES[caseIndex]!
  const materialText = JSON.stringify(material).toLowerCase()
  const found: string[] = []
  for (const assertion of ADVERSARIAL_ASSERTIONS) {
    if (corpus.includes(assertion.target.id.toLowerCase())) found.push(`id: ${assertion.target.id}`)
    if (corpus.includes(assertion.target.summary.toLowerCase())) found.push(`summary: ${assertion.target.summary}`)
    for (const marker of assertion.target.markers) {
      if (corpus.includes(marker.toLowerCase()) && !materialText.includes(marker.toLowerCase())) found.push(`marker: ${marker}`)
    }
    // A predicate path the material itself names (the defect's file) is no
    // leak; one the material never names is.
    const predicate = assertion.blame.path.toLowerCase()
    if (corpus.includes(predicate) && !materialText.includes(predicate)) found.push(`predicate: ${assertion.blame.path}`)
  }
  return found
}

describe("materializeSide over real git", () => {
  test("each side's worktree is the base tree committed plus the side's diff, uncommitted", async () => {
    const dir = await tempDir()
    for (const [index, c] of ADVERSARIAL_CASES.entries()) {
      for (const side of ["clean", "attack"] as const) {
        const worktree = join(dir, `${c.id}-${side}`)
        const written = await materializeSide({ directory: worktree, baseTree: c.baseTree, change: c[side] })
        expect(written).toEqual({ ok: true, directory: worktree })
        const diff = await returned(spawnGit(worktree, ["diff", "HEAD", "--name-only"]))
        expect(diff.stdout).toContain(ADVERSARIAL_ASSERTIONS[index]!.target.locus.file)
        const log = await returned(spawnGit(worktree, ["log", "--oneline"]))
        expect(log.stdout.trim().split("\n")).toHaveLength(1)
        expect(answerKeyBytesIn((await corpusOf(worktree)).text, index), `${c.id} ${side}`).toEqual([])
      }
    }
  })

  test("the leak check is not vacuous: a planted label id, summary, marker and predicate path are reported", async () => {
    const dir = await tempDir()
    const c = ADVERSARIAL_CASES[0]!
    const worktree = join(dir, "planted")
    expect((await materializeSide({ directory: worktree, baseTree: c.baseTree, change: c.clean })).ok).toBe(true)
    const materialText = JSON.stringify(c).toLowerCase()
    const leaked = ADVERSARIAL_ASSERTIONS[0]!.target
    const marker = ADVERSARIAL_ASSERTIONS.flatMap((a) => a.target.markers).find((m) => !materialText.includes(m.toLowerCase()))!
    const path = ADVERSARIAL_ASSERTIONS.map((a) => a.blame.path).find((p) => !materialText.includes(p.toLowerCase()))!
    expect(marker).toBeDefined()
    expect(path).toBeDefined()
    await writeFile(join(worktree, "NOTES.md"), `${leaked.id}\n${leaked.summary}\n${marker}\n${path}\n`)
    const found = answerKeyBytesIn((await corpusOf(worktree)).text, 0)
    expect(found).toContain(`id: ${leaked.id}`)
    expect(found).toContain(`summary: ${leaked.summary}`)
    expect(found).toContain(`marker: ${marker}`)
    expect(found).toContain(`predicate: ${path}`)
  })

  test("a non-empty destination and an escaping base-tree path are refused, and nothing is written", async () => {
    const dir = await tempDir()
    await writeFile(join(dir, "already"), "x")
    const c = ADVERSARIAL_CASES[0]!
    const busy = await materializeSide({ directory: dir, baseTree: c.baseTree, change: c.clean })
    expect(busy.ok).toBe(false)
    const escaping = await materializeSide({ directory: join(dir, "fresh"), baseTree: { "../out.ts": "x" }, change: c.clean })
    expect(escaping.ok).toBe(false)
    expect(await readdir(dir)).toEqual(["already"])
  })

  test("a diff that does not apply is refused by name", async () => {
    const dir = await tempDir()
    const c = ADVERSARIAL_CASES[0]!
    const written = await materializeSide({
      directory: join(dir, "bad"),
      baseTree: c.baseTree,
      change: { ...c.clean, diff: c.clean.diff.replace("return rows[0]", "return rows[1]") },
    })
    expect(written.ok).toBe(false)
    if (!written.ok) {
      expect(written.reason).toContain("`git apply` failed")
      expect(written.reason).toContain("with status 1")
      expect(written.terminationUnconfirmed).toBeUndefined()
    }
  })
})

describe("the worktree writer's import list is the argument", () => {
  test("it imports no fixture, and neither the assertions nor the seal", async () => {
    const source = await Bun.file(new URL("./adversarial-materialize.ts", import.meta.url)).text()
    const imports = [...source.matchAll(/^import[^"]*"([^"]+)"/gm)].map((match) => match[1]!)
    expect(imports.length).toBeGreaterThan(0)
    for (const path of imports) {
      expect(path).not.toContain("fixtures/")
      expect(path).not.toContain("assertions")
      expect(path).not.toContain("seal")
    }
  })

  test("the material module imports nothing from the answer key", async () => {
    const source = await Bun.file(new URL("../fixtures/adversarial/material.ts", import.meta.url)).text()
    const imports = [...source.matchAll(/^import[^"]*"([^"]+)"/gm)].map((match) => match[1]!)
    for (const path of imports) {
      expect(path).not.toContain("assertions")
      expect(path).not.toContain("seal")
    }
  })
})

describe("git is isolated from the operator's configuration", () => {
  test("every GIT_* variable is stripped, and global and system config are switched off", () => {
    const env = isolatedGitEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      GIT_DIR: "/elsewhere/.git",
      GIT_WORK_TREE: "/elsewhere",
      GIT_INDEX_FILE: "/elsewhere/index",
      GIT_OBJECT_DIRECTORY: "/elsewhere/objects",
    })
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/x", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" })
  })

  test("a GIT_DIR in the caller's environment does not redirect the write", async () => {
    const dir = await tempDir()
    const decoy = join(dir, "decoy")
    const previous = process.env.GIT_DIR
    process.env.GIT_DIR = join(decoy, ".git")
    try {
      const c = ADVERSARIAL_CASES[0]!
      const written = await materializeSide({ directory: join(dir, "real"), baseTree: c.baseTree, change: c.clean })
      expect(written.ok).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previous
    }
    expect(await readdir(join(dir, "real", ".git"))).toContain("HEAD")
    expect(await readdir(dir)).not.toContain("decoy")
  })

  test("a base-tree key with a .git component at any depth is refused, and nothing is written", async () => {
    const dir = await tempDir()
    const c = ADVERSARIAL_CASES[0]!
    for (const key of [".git/hooks/post-commit", ".GIT/config", "./.git/HEAD", "sub/.git/config", "vendor/.Git/HEAD"]) {
      const written = await materializeSide({ directory: join(dir, "w"), baseTree: { ...c.baseTree, [key]: "x" }, change: c.clean })
      expect(written.ok, key).toBe(false)
      if (!written.ok) expect(written.reason).toContain("has a `.git` component")
    }
    expect(await readdir(dir)).toEqual([])
  })

  test("the worktree gets no template hooks", async () => {
    const dir = await tempDir()
    const c = ADVERSARIAL_CASES[0]!
    expect((await materializeSide({ directory: join(dir, "w"), baseTree: c.baseTree, change: c.clean })).ok).toBe(true)
    expect(await readdir(join(dir, "w", ".git"))).not.toContain("hooks")
  })
})

// ---------------------------------------------------------------------------
// Story 2-7e2 — bounded termination. Every process below is a local `sh`
// stand-in this test starts through the spawn seam; nothing touches a network.
// ---------------------------------------------------------------------------

/** Short test budgets, and the slack an elapsed-time assertion allows on top of them. */
const DEADLINE_MS = 200
const CLEANUP_MS = 1_000
const DESCENDANT_CLEANUP_MS = 300
const SLACK_MS = 2_000
/** How long the descendant sleeper would live if nothing killed it. Every elapsed bound is far below it. */
const SLEEPER_LIFETIME_MS = 30_000

/** A stand-in in place of git, through the materializer's own spawn: isolated environment, piped output. */
function standIn(script: string): SpawnGit {
  return (request) => isolatedSpawn({ ...request, cmd: ["sh", "-c", script] })
}

/** `exec`, so no shell child is left holding the pipes once the stand-in is killed. */
const HANG = "exec sleep 30"
/** Traps SIGTERM and hangs. The launcher sends SIGKILL at once, so the trap never matters. */
const TERM_TRAPPED = "trap '' TERM; exec sleep 30"

/**
 * A sleeper on stdout only, then a hang. The sleeper's pid is written to
 * `pidFile` so the test can kill it; it is not the launcher's child, and
 * nothing the launcher sends reaches it.
 */
function descendant(pidFile: string): string {
  return `sleep ${SLEEPER_LIFETIME_MS / 1000} 2>/dev/null & echo $! > '${pidFile}'; exec sleep 30`
}

/** Kill the sleeper `descendant` recorded. Tolerates a sleeper that is already gone. */
async function killRecorded(pidFile: string): Promise<void> {
  const text = await readFile(pidFile, "utf8").catch(() => "")
  const pid = Number(text.trim())
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // Already gone.
  }
}

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; elapsed: number }> {
  const started = performance.now()
  const value = await run()
  return { value, elapsed: performance.now() - started }
}

/** The process id a reason names, or `null`. */
const pidIn = (reason: string): number | null => {
  const match = /process (\d+)/.exec(reason)
  return match === null ? null : Number(match[1])
}

describe("every git call is bounded", () => {
  test("a hang returns within deadline plus cleanup, with no exit code and confirmed termination", async () => {
    const dir = await tempDir()
    const git = boundedGit({ spawn: standIn(HANG), deadlineMs: DEADLINE_MS, cleanupMs: CLEANUP_MS })
    const { value, elapsed } = await timed(() => git(dir, ["status"]))
    expect(elapsed).toBeLessThan(DEADLINE_MS + CLEANUP_MS + SLACK_MS)
    expect(value.exitCode).toBeNull()
    if (value.exitCode !== null) return
    expect(value.termination).toBe("confirmed")
    expect(value.reason).toContain("`git status` timed out and was killed")
    expect(pidIn(value.reason)).toBeGreaterThan(0)
  })

  test("a child that traps SIGTERM is ended by the immediate SIGKILL, and termination is confirmed", async () => {
    const dir = await tempDir()
    const git = boundedGit({ spawn: standIn(TERM_TRAPPED), deadlineMs: DEADLINE_MS, cleanupMs: CLEANUP_MS })
    const { value, elapsed } = await timed(() => git(dir, ["status"]))
    expect(elapsed).toBeLessThan(DEADLINE_MS + CLEANUP_MS + SLACK_MS)
    expect(value.exitCode).toBeNull()
    if (value.exitCode !== null) return
    expect(value.termination).toBe("confirmed")
    expect(value.reason).toContain("SIGKILL")
    expect(value.reason).not.toContain("SIGTERM")
  })

  test("a descendant holding stdout cannot stop the call returning, and termination is unconfirmed", async () => {
    const dir = await tempDir()
    const pidFile = join(dir, "sleeper.pid")
    try {
      const git = boundedGit({ spawn: standIn(descendant(pidFile)), deadlineMs: DEADLINE_MS, cleanupMs: DESCENDANT_CLEANUP_MS })
      const { value, elapsed } = await timed(() => git(dir, ["status"]))
      // Strictly below the sleeper's lifetime: a launcher that waited it out fails here.
      expect(elapsed).toBeLessThan(DEADLINE_MS + DESCENDANT_CLEANUP_MS + SLACK_MS)
      expect(DEADLINE_MS + DESCENDANT_CLEANUP_MS + SLACK_MS).toBeLessThan(SLEEPER_LIFETIME_MS)
      expect(value.exitCode).toBeNull()
      if (value.exitCode !== null) return
      expect(value.termination).toBe("unconfirmed")
      expect(value.reason).toContain("termination is UNCONFIRMED")
      expect(value.reason).toContain("stdout")
      expect(pidIn(value.reason)).toBeGreaterThan(0)
    } finally {
      await killRecorded(pidFile)
    }
  })

  test("a spawn that throws is not-started, with no status and no process id", async () => {
    const dir = await tempDir()
    const git = boundedGit({
      spawn: () => {
        throw new Error("scripted launch refusal")
      },
    })
    const value = await git(dir, ["status"])
    expect(value).toEqual({
      exitCode: null,
      termination: "not-started",
      reason: "`git status` could not be started: scripted launch refusal",
    })
  })

  test("an unusable deadline or cleanup budget is refused under the materializer's own name, and launches nothing", async () => {
    const dir = await tempDir()
    let launched = 0
    const counting: SpawnGit = (request) => {
      launched += 1
      return isolatedSpawn(request)
    }
    const bad = [0, -1, Number.NaN, Number.POSITIVE_INFINITY]
    const budgets = [...bad.map((deadlineMs) => ({ deadlineMs })), ...bad.map((cleanupMs) => ({ cleanupMs }))]
    for (const budget of budgets) {
      const value = await boundedGit({ spawn: counting, ...budget })(dir, ["status"])
      expect(value.exitCode, JSON.stringify(budget)).toBeNull()
      if (value.exitCode !== null) continue
      expect(value.termination).toBe("not-started")
      expect(value.reason).toContain("`git status` was not launched")
      expect(value.reason).toContain("deadlineMs" in budget ? "the materializer git deadline" : "the materializer git cleanup budget")
      expect(value.reason).not.toContain("blame")
      expect(pidIn(value.reason)).toBeNull()
    }
    expect(launched).toBe(0)
  })

  test("git's own non-zero status is returned as it is, with git's message", async () => {
    const dir = await tempDir()
    const value = await returned(spawnGit(dir, ["init", "--quiet", "--template="]))
    expect(value.exitCode).toBe(0)
    const missing = await spawnGit(dir, ["rev-parse", "--verify", "no-such-ref"])
    expect(missing).toMatchObject({ exitCode: 128, signal: null, stderrFailure: null })
    if (missing.exitCode !== null) expect(missing.stderr).toContain("fatal: Needed a single revision")
  })

  test("the call's argv carries the isolation options, and `git apply` is handed the diff on stdin", async () => {
    const dir = await tempDir()
    const seen: { cmd: string[]; stdin: Uint8Array | "ignore" }[] = []
    const git = boundedGit({
      spawn: (request) => {
        seen.push({ cmd: request.cmd, stdin: request.stdin })
        return isolatedSpawn({ ...request, cmd: ["sh", "-c", "cat"] })
      },
    })
    const echoed = await git(dir, ["apply", "-"], "the diff\n")
    const plain = await git(dir, ["status"])
    expect(seen.map((call) => call.cmd)).toEqual([
      ["git", ...GIT_ISOLATION, "apply", "-"],
      ["git", ...GIT_ISOLATION, "status"],
    ])
    expect(seen[1]!.stdin).toBe("ignore")
    expect(echoed).toMatchObject({ exitCode: 0, stdout: "the diff\n" })
    expect(plain).toMatchObject({ exitCode: 0, stdout: "" })
  })

  test("the defaults are the blame tool's: 60,000 ms of execution and 5,000 ms of cleanup", async () => {
    expect(GIT_TIMEOUT_MS).toBe(DEFAULT_BLAME_TIMEOUT_MS)
    expect(GIT_CLEANUP_TIMEOUT_MS).toBe(DEFAULT_BLAME_CLEANUP_TIMEOUT_MS)
    const dir = await tempDir()
    const seen: { deadlineMs: number; cleanupMs: number }[] = []
    const launcher = spyOn(blameExec, "runBoundedBlame")
    launcher.mockImplementation(async (options) => {
      seen.push({ deadlineMs: options.deadlineMs, cleanupMs: options.cleanupMs })
      return { kind: "refused", why: "scripted" }
    })
    try {
      await boundedGit()(dir, ["status"])
      await boundedGit({ spawn: isolatedSpawn })(dir, ["status"])
    } finally {
      launcher.mockRestore()
    }
    expect(seen).toEqual([
      { deadlineMs: 60_000, cleanupMs: 5_000 },
      { deadlineMs: 60_000, cleanupMs: 5_000 },
    ])
  })
})

describe("the launcher's outcomes map onto git outcomes, and none is given a status", () => {
  const command = "git apply --whitespace=nowarn -"
  const observed = { exitCode: null, signal: "SIGKILL" }

  test("observation-failed with confirmed cleanup is confirmed; with unresolved cleanup it is unconfirmed", () => {
    const confirmed: BlameExecOutcome = {
      kind: "observation-failed",
      why: "the exit status could not be read",
      pid: 4141,
      cleanup: { kind: "confirmed", observed },
    }
    const unresolved: BlameExecOutcome = {
      kind: "observation-failed",
      why: "the exit status could not be read",
      pid: 4242,
      cleanup: { kind: "unresolved", why: "its stdout pipe(s) were still open" },
    }
    const a = gitOutcomeOf(command, confirmed)
    expect(a).toMatchObject({ exitCode: null, termination: "confirmed" })
    if (a.exitCode === null) expect(a.reason).toContain("process 4141")
    const b = gitOutcomeOf(command, unresolved)
    expect(b).toMatchObject({ exitCode: null, termination: "unconfirmed" })
    if (b.exitCode === null) {
      expect(b.reason).toContain("check process 4242 by hand")
      expect(b.reason).toContain("its stdout pipe(s) were still open")
    }
  })

  test("a pid the handle did not establish is never named", () => {
    const outcome = gitOutcomeOf(command, { kind: "cleanup-unresolved", why: "process -1 had not been reaped", pid: -1 })
    expect(outcome).toMatchObject({ exitCode: null, termination: "unconfirmed" })
    if (outcome.exitCode === null) expect(outcome.reason).toContain("a process whose id the spawn handle did not give")
  })

  test("refused and launch-failed are not-started; terminated is confirmed", () => {
    expect(gitOutcomeOf(command, { kind: "refused", why: "nothing was launched" })).toMatchObject({ exitCode: null, termination: "not-started" })
    expect(gitOutcomeOf(command, { kind: "launch-failed", why: "ENOENT" })).toMatchObject({ exitCode: null, termination: "not-started" })
    expect(gitOutcomeOf(command, { kind: "terminated", why: "killed", pid: 7, observed })).toMatchObject({ exitCode: null, termination: "confirmed" })
  })

  test("a returned outcome keeps stderrFailure apart from git's stderr", () => {
    const outcome = gitOutcomeOf(command, {
      kind: "returned",
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: "",
      stderrFailure: "the stderr pipe could not be read to its end: torn",
    })
    expect(outcome).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "",
      signal: null,
      stderrFailure: "the stderr pipe could not be read to its end: torn",
    })
  })
})

describe("materializeSide judges each step on its status and signal", () => {
  /** Real git for every step but `git apply`, which returns `result` instead. */
  function atApply(result: GitResult): RunGit {
    return async (cwd, args, stdin) => (args[0] === "apply" ? result : spawnGit(cwd, args, stdin))
  }

  test("a failed step reports an unread stderr as MAD's diagnostic, not as git's", async () => {
    const dir = await tempDir()
    const c = ADVERSARIAL_CASES[0]!
    const git = atApply({ exitCode: 1, stdout: "", stderr: "", signal: null, stderrFailure: "the stderr pipe could not be read to its end: torn" })
    const written = await materializeSide({ directory: join(dir, "w"), baseTree: c.baseTree, change: c.clean, git })
    expect(written.ok).toBe(false)
    if (!written.ok) {
      expect(written.reason).toContain("git reported no detail")
      expect(written.reason).toContain("[MAD could not read git's stderr: the stderr pipe could not be read to its end: torn]")
    }
  })

  test("an unread stderr on a successful step is not a failure", async () => {
    const dir = await tempDir()
    const c = ADVERSARIAL_CASES[0]!
    const git = atApply({ exitCode: 0, stdout: "", stderr: "", signal: null, stderrFailure: "the stderr pipe could not be read to its end: torn" })
    const written = await materializeSide({ directory: join(dir, "w"), baseTree: c.baseTree, change: c.clean, git })
    expect(written).toEqual({ ok: true, directory: join(dir, "w") })
  })

  test("status 0 with a terminating signal fails the step, and the reason names the signal", async () => {
    const dir = await tempDir()
    const c = ADVERSARIAL_CASES[0]!
    const git = atApply({ exitCode: 0, stdout: "", stderr: "", signal: "SIGKILL" })
    const written = await materializeSide({ directory: join(dir, "w"), baseTree: c.baseTree, change: c.clean, git })
    expect(written.ok).toBe(false)
    if (!written.ok) {
      expect(written.reason).toContain("`git apply` failed")
      expect(written.reason).toContain("signal SIGKILL")
    }
  })
})

describe("a worktree whose git did not return", () => {
  /** Real git for every step but `git apply`, where the stand-in runs instead. */
  function standInAtApply(script: string): SpawnGit {
    return (request) => (request.cmd.includes("apply") ? standIn(script)(request) : isolatedSpawn(request))
  }

  test("a hang at `git apply` fails the side with confirmed termination, leaves the directory, and a rerun into it is refused", async () => {
    const dir = await tempDir()
    const c = ADVERSARIAL_CASES[0]!
    const worktree = join(dir, "partial")
    const git = boundedGit({ spawn: standInAtApply(HANG), deadlineMs: DEADLINE_MS, cleanupMs: CLEANUP_MS })
    const written = await materializeSide({ directory: worktree, baseTree: c.baseTree, change: c.clean, git })
    expect(written.ok).toBe(false)
    if (written.ok) return
    expect(written.terminationUnconfirmed).toBeUndefined()
    expect(written.reason).toContain(`\`git apply\` did not return in \`${worktree}\`; its process was confirmed ended`)
    expect(pidIn(written.reason)).toBeGreaterThan(0)
    // Retained, never deleted, and holding the earlier steps' work.
    expect(await readdir(worktree)).toContain(".git")
    const again = await materializeSide({ directory: worktree, baseTree: c.baseTree, change: c.clean })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.reason).toContain("already exists and is not empty")
  })

  test("a descendant at `git apply` sets terminationUnconfirmed, and the reason names the call, the directory and the process", async () => {
    const dir = await tempDir()
    const pidFile = join(dir, "sleeper.pid")
    const c = ADVERSARIAL_CASES[0]!
    const worktree = join(dir, "held")
    try {
      const git = boundedGit({ spawn: standInAtApply(descendant(pidFile)), deadlineMs: DEADLINE_MS, cleanupMs: DESCENDANT_CLEANUP_MS })
      const written = await materializeSide({ directory: worktree, baseTree: c.baseTree, change: c.clean, git })
      expect(written.ok).toBe(false)
      if (written.ok) return
      expect(written.terminationUnconfirmed).toBe(true)
      expect(written.reason).toContain(`\`git apply\` did not return in \`${worktree}\`; its process may still be running`)
      expect(pidIn(written.reason)).toBeGreaterThan(0)
    } finally {
      await killRecorded(pidFile)
    }
  })

  test("a step that was not started says so, and claims nothing about what the directory holds beyond the earlier steps", async () => {
    const dir = await tempDir()
    const worktree = join(dir, "never")
    const git = boundedGit({ deadlineMs: 0 })
    const written = await materializeSide({ directory: worktree, baseTree: {}, change: ADVERSARIAL_CASES[0]!.clean, git })
    expect(written.ok).toBe(false)
    if (written.ok) return
    expect(written.terminationUnconfirmed).toBeUndefined()
    expect(written.reason).toContain(`\`git init\` was not started in \`${worktree}\`; the directory holds only what the steps before it wrote`)
    expect(written.reason).not.toContain("did not return")
    expect(await readdir(worktree)).toEqual([])
  })
})

describe("the bounded and an unbounded git write the same worktree", () => {
  /** A reference git with the same isolation and no bound. */
  const reference: RunGit = async (cwd, args, stdin) => {
    const ran = Bun.spawnSync(["git", ...GIT_ISOLATION, ...args], {
      cwd,
      env: isolatedGitEnv(),
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    })
    if (ran.exitCode === null) throw new Error(`the reference \`git ${args.join(" ")}\` returned no exit code`)
    return { exitCode: ran.exitCode, stdout: ran.stdout.toString(), stderr: ran.stderr.toString() }
  }

  /** Every worktree file outside `.git` with its contents, `HEAD^{tree}`, the porcelain status, the diff against HEAD, and `.git/config` with the root replaced. */
  async function snapshot(root: string): Promise<Record<string, string>> {
    const files: Record<string, string> = {}
    const walk = async (relative: string): Promise<void> => {
      for (const entry of (await readdir(join(root, relative))).sort()) {
        const path = relative === "" ? entry : `${relative}/${entry}`
        if (path === ".git") continue
        if ((await stat(join(root, path))).isDirectory()) await walk(path)
        else files[path] = await readFile(join(root, path), "utf8")
      }
    }
    await walk("")
    for (const args of [["rev-parse", "HEAD^{tree}"], ["status", "--porcelain"], ["diff", "HEAD"]]) {
      files[`git ${args.join(" ")}`] = (await returned(spawnGit(root, args))).stdout
    }
    files[".git/config"] = (await readFile(join(root, ".git", "config"), "utf8")).replaceAll(root, "<root>")
    return files
  }

  test("every case and side: the same worktree files, HEAD^{tree}, status, diff and normalized config", async () => {
    const dir = await tempDir()
    for (const c of ADVERSARIAL_CASES) {
      for (const side of ["clean", "attack"] as const) {
        const bounded = join(dir, `${c.id}-${side}-bounded`)
        const unbounded = join(dir, `${c.id}-${side}-reference`)
        expect((await materializeSide({ directory: bounded, baseTree: c.baseTree, change: c[side] })).ok).toBe(true)
        expect((await materializeSide({ directory: unbounded, baseTree: c.baseTree, change: c[side], git: reference })).ok).toBe(true)
        expect(await snapshot(bounded), `${c.id} ${side}`).toEqual(await snapshot(unbounded))
      }
    }
  })
})

describe("the materializer's source", () => {
  test("synthesizes no exit code 124", async () => {
    const source = await Bun.file(new URL("./adversarial-materialize.ts", import.meta.url)).text()
    expect(source).not.toMatch(/exitCode:\s*124\b/)
  })
})
