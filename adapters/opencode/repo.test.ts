/**
 * Adapter tests for the `Repo` port.
 *
 * Two kinds of test, for two kinds of claim:
 *
 * - REAL TEMP GIT REPOSITORIES for what git itself says: the change a healthy
 *   repository holds, a genuinely empty one, and a bad ref. A git FAILURE and a
 *   genuinely EMPTY diff look identical downstream unless this layer separates
 *   them, and "nothing to review" is the message a bad ref used to produce.
 * - THE `spawn` SEAM, with fake handles or controlled `sleep`/`sh` children, for
 *   what the bounded read does when git does not return cleanly: the one total
 *   budget, the outcome mapping, and the per-worktree quarantine.
 *
 * Every controlled child is killed and reaped by the launcher, and a descendant
 * started to hold a pipe open is killed and waited for before its test ends.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { SpawnBlame, SpawnedBlame } from "./blame-exec.ts"
import { FILTER_PREFLIGHT, readOnlyGitArgv } from "./git-read-policy.ts"
import { answeringPreflight } from "./test-support/preflight.ts"
import type { InputFs } from "./change-input.ts"
import {
  ChangeReadRefused,
  ChangeReadStopped,
  changeReadQuarantineFor,
  FilterPreflightFailed,
  clearChangeReadQuarantineForTests,
  DEFAULT_CHANGE_READ_BUDGET_MS,
  DEFAULT_CHANGE_READ_CLEANUP_MS,
  GitError,
  opencodeRepo,
} from "./repo.ts"
import { isolateGitHome } from "./test-support/git-home.ts"

isolateGitHome()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const scratch: string[] = []

async function tempDir(prefix = "mad-repo-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true })
})

/** Run git in `cwd` for fixture setup, and fail loudly if it fails. */
async function setupGit(cwd: string, argv: string[]): Promise<void> {
  const child = Bun.spawn({ cmd: ["git", ...argv], cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`fixture git ${argv.join(" ")} failed: ${stderr}`)
}

/**
 * A real repository with one commit of `src/pay.ts`. The setup commit runs with
 * automatic maintenance off, so no detached writer races the directory's removal
 * (#138). That is this fixture's config only, never production's.
 */
async function realRepo(): Promise<string> {
  const dir = await tempDir()
  await setupGit(dir, ["init", "-q"])
  await mkdir(join(dir, "src"))
  await writeFile(join(dir, "src", "pay.ts"), "const a = 1\n")
  await setupGit(dir, ["add", "src/pay.ts"])
  await setupGit(dir, [
    "-c", "user.name=MAD test",
    "-c", "user.email=mad@example.invalid",
    "-c", "commit.gpgsign=false",
    "-c", "maintenance.auto=false",
    "-c", "gc.auto=0",
    "commit", "-q", "-m", "base",
  ])
  return dir
}

/** A stream that yields its text and closes, as a healthy pipe does. */
function closedStream(text = ""): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (text.length > 0) controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

/** A stream that yields a prefix and then ERRORS, as a torn read does. */
function tornStream(prefix: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(prefix))
      controller.error(new Error("the pipe broke"))
    },
  })
}

interface Reply {
  stdout?: SpawnedBlame["stdout"] | string
  stderr?: SpawnedBlame["stderr"] | string
  status?: number
  signal?: string | null
  /** A handle that never exits and survives the kill: cleanup is unresolved. */
  unkillable?: boolean
  /** Held until this promise resolves, then exits normally. */
  holdUntil?: Promise<void>
  pid?: number
}

/**
 * A fake handle per spawn, chosen by a substring of the argv. Records every
 * argv it was asked to start, so a test can count spawns.
 */
function fakeSpawn(route: (argv: string) => Reply, onSpawn?: (argv: string[]) => void) {
  const spawned: string[][] = []
  const spawn: SpawnBlame = ({ cmd }) => {
    spawned.push(cmd)
    onSpawn?.(cmd)
    const reply = route(cmd.join(" "))
    // `null` is kept as `null`: a handle with no pipe at all is its own case.
    const pipe = (value: Reply["stdout"]) =>
      typeof value === "string" ? closedStream(value) : value === undefined ? closedStream() : value
    if (reply.unkillable) {
      return {
        pid: reply.pid ?? 9191,
        stdout: pipe(reply.stdout),
        stderr: pipe(reply.stderr),
        exited: new Promise<number>(() => {}),
        exitCode: null,
        signalCode: null,
        kill: () => undefined,
      }
    }
    const status = reply.status ?? 0
    return {
      pid: reply.pid ?? 4242,
      stdout: pipe(reply.stdout),
      stderr: pipe(reply.stderr),
      exited: reply.holdUntil === undefined ? Promise.resolve(status) : reply.holdUntil.then(() => status),
      exitCode: status,
      signalCode: reply.signal ?? null,
      kill: () => undefined,
    }
  }
  return {
    spawn: answeringPreflight(spawn),
    /** The same fake with the filter preflight left to `route`, for tests about the preflight. */
    seesPreflight: spawn,
    spawned,
  }
}

/** A healthy working tree: a tracked edit, no untracked files. */
/** CAP-4 — every untracked entry these scripted tests list is a readable regular file. */
const FILES: InputFs = {
  supported: true,
  lstat: async () => "file",
  openNoFollow: async () => ({ kind: async () => "file" as const, close: async () => undefined }),
}

const DIFF = "--- a/src/pay.ts\n+++ b/src/pay.ts\n@@ -1 +1 @@\n-a\n+b\n"
const healthy = (argv: string): Reply => {
  if (argv.includes("--name-only")) return { stdout: "src/pay.ts\0" }
  if (argv.includes("ls-files")) return { stdout: "" }
  return { stdout: DIFF }
}

const stoppedBy = async (promise: Promise<unknown>): Promise<ChangeReadStopped> => {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(ChangeReadStopped)
  expect(error).not.toBeInstanceOf(GitError)
  return error as ChangeReadStopped
}

let worktreeCounter = 0
/** A unique worktree key per test, so one test's latch cannot leak into another. */
const freshWorktree = () => `/fake/worktree-${process.pid}-${++worktreeCounter}`
const touched: string[] = []
const keyed = (worktree: string) => {
  touched.push(worktree)
  return worktree
}

afterEach(() => {
  for (const worktree of touched.splice(0)) clearChangeReadQuarantineForTests(worktree)
})

// ---------------------------------------------------------------------------
// What git says, against real repositories
// ---------------------------------------------------------------------------

describe("opencodeRepo.change — real repositories", () => {
  let repo: string

  beforeAll(async () => {
    repo = await realRepo()
    await writeFile(join(repo, "src", "pay.ts"), "const a = 2\n")
    await writeFile(join(repo, "src", "brand-new.ts"), "export const fresh = true\n")
  })

  test("a tracked edit and an untracked file: both files and the real diffs", async () => {
    const change = await opencodeRepo({ worktree: repo }).change()

    expect(change.description).toContain("working tree")
    expect(change.files).toEqual(["src/pay.ts", "src/brand-new.ts"])
    expect(change.diff).toContain("-const a = 1")
    expect(change.diff).toContain("+const a = 2")
    // `git diff HEAD` cannot see the new file; the `--no-index` read does.
    expect(change.diff).toContain("+export const fresh = true")
    expect(change.diff).toContain("brand-new.ts")
  })

  test("a range target reads the range and does no `ls-files`", async () => {
    const spawned: string[][] = []
    const recording: SpawnBlame = (request) => {
      spawned.push(request.cmd)
      return Bun.spawn({
        cmd: request.cmd,
        cwd: request.cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        ...(request.env === undefined ? {} : { env: { ...request.env, PWD: request.cwd } }),
      }) as unknown as SpawnedBlame
    }
    const change = await opencodeRepo({ worktree: repo, spawn: recording }).change("HEAD")

    expect(change.description).toBe("git diff HEAD (submodules as commit pointers only, their uncommitted contents not read)")
    expect(change.files).toEqual(["src/pay.ts"])
    expect(change.diff).toContain("+const a = 2")
    expect(change.diff).not.toContain("brand-new.ts")
    // The read policy's filter preflight first, then the two reads, each
    // under the policy's argv (`./git-read-policy.ts`).
    expect(spawned).toEqual([
      readOnlyGitArgv(FILTER_PREFLIGHT),
      readOnlyGitArgv(["diff", "--unified=8", "HEAD", "--"]),
      readOnlyGitArgv(["diff", "--name-only", "-z", "HEAD", "--"]),
    ])
  })

  test("a genuinely empty change is empty, and is NOT an error", async () => {
    const clean = await realRepo()
    const change = await opencodeRepo({ worktree: clean }).change()
    expect(change.diff).toBe("")
    expect(change.files).toEqual([])
  })

  test("a bad ref is a GitError with git's stderr, not a stop", async () => {
    const change = opencodeRepo({ worktree: repo }).change("nope...HEAD")
    await expect(change).rejects.toThrow(GitError)
    await expect(change).rejects.not.toBeInstanceOf(ChangeReadStopped)
    await expect(change).rejects.toThrow("nope")
  })
})

describe("opencodeRepo.change — argv and selection", () => {
  test("a target git would read as an option is refused before anything is spawned", async () => {
    // `--` does not protect a target placed before it: git still reads options
    // there, and `--output=<path>` writes a file (ledger #156). So it is refused.
    for (const target of ["--output=/tmp/pwned", "-p", "-", "--"]) {
      const seen: string[][] = []
      const spawn: SpawnBlame = (request) => {
        seen.push(request.cmd)
        throw new Error("nothing may be spawned for an option-shaped target")
      }
      const change = opencodeRepo({ worktree: keyed(freshWorktree()), spawn, inputFs: FILES }).change(target)
      await expect(change).rejects.toBeInstanceOf(ChangeReadRefused)
      await expect(change).rejects.toThrow("starts with \"-\"")
      expect(seen).toEqual([])
    }
  })

  test("an ordinary target is passed unchanged as a revision, before the terminating `--`", async () => {
    const { spawn, spawned } = fakeSpawn((argv) => ({ stdout: argv.includes("--name-only") ? "src/pay.ts\0" : DIFF }))
    await opencodeRepo({ worktree: keyed(freshWorktree()), spawn, inputFs: FILES }).change("main...HEAD")

    const argv = spawned.find((cmd) => cmd.includes("main...HEAD"))!
    expect(argv.indexOf("main...HEAD")).toBeLessThan(argv.lastIndexOf("--"))
    expect(argv.at(-1)).toBe("--")
  })

  test("an untracked file is one argv element after `--`, and `--no-index` status 1 is accepted", async () => {
    const odd = "src/a file; rm -rf $HOME.ts"
    const { spawn, spawned } = fakeSpawn((argv) => {
      if (argv.includes("--no-index")) return { stdout: `+++ b/${odd}\n+new\n`, status: 1 }
      if (argv.includes("ls-files")) return { stdout: `${odd}\0` }
      return { stdout: "" }
    })
    const change = await opencodeRepo({ worktree: keyed(freshWorktree()), spawn, inputFs: FILES }).change()

    expect(change.files).toEqual([odd])
    expect(change.diff).toContain("+new")
    expect(spawned.at(-1)).toEqual(readOnlyGitArgv(["diff", "--unified=8", "--no-index", "--", "/dev/null", odd]))
  })

  test("a `--no-index` status of 2 or more refuses that input by name, not as a bad ref and not as an empty diff", async () => {
    const { spawn } = fakeSpawn((argv) => {
      if (argv.includes("--no-index")) return { stderr: "error: could not access\n", status: 2 }
      if (argv.includes("ls-files")) return { stdout: "src/gone.ts\0" }
      return { stdout: "" }
    })
    const change = opencodeRepo({ worktree: keyed(freshWorktree()), spawn, inputFs: FILES }).change()
    await expect(change).rejects.toBeInstanceOf(ChangeReadRefused)
    await expect(change).rejects.toThrow('the untracked entry "src/gone.ts": git could not read it')
    // git's own stderr is not copied into the refusal.
    await expect(change).rejects.not.toThrow("could not access")
  })

  test("root() is the worktree the loci are relative to", () => {
    expect(opencodeRepo({ worktree: "/repo" }).root()).toBe("/repo")
  })
})

describe("opencodeRepo — limits are validated where they are supplied", () => {
  test("a fraction of a millisecond is refused by name, and 1ms is accepted", () => {
    expect(() => opencodeRepo({ worktree: "/repo", readBudgetMs: 0.5 })).toThrow("must be at least 1ms")
    expect(() => opencodeRepo({ worktree: "/repo", cleanupMs: 0.5 })).toThrow("must be at least 1ms")
    expect(() => opencodeRepo({ worktree: "/repo", readBudgetMs: 1, cleanupMs: 1 })).not.toThrow()
  })

  test("the defaults are the documented operational limits", () => {
    expect(DEFAULT_CHANGE_READ_BUDGET_MS).toBe(60_000)
    expect(DEFAULT_CHANGE_READ_CLEANUP_MS).toBe(5_000)
  })

  test("a bad budget or cleanup is a RangeError at construction, before any spawn", () => {
    for (const bad of [0, -1, 0.5, 0.999, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      const { spawn, spawned } = fakeSpawn(healthy)
      expect(() => opencodeRepo({ worktree: "/repo", spawn, readBudgetMs: bad })).toThrow(RangeError)
      expect(() => opencodeRepo({ worktree: "/repo", spawn, cleanupMs: bad })).toThrow(RangeError)
      expect(spawned).toHaveLength(0)
    }
  })
})

// ---------------------------------------------------------------------------
// The outcome mapping
// ---------------------------------------------------------------------------

describe("opencodeRepo.change — a read that does not return cleanly is a stop", () => {
  test("a hung read is killed at the budget: `terminated`, cleanup confirmed, no quarantine", async () => {
    const worktree = keyed(await tempDir())
    // A real child that never exits on its own, in place of git.
    const hang: SpawnBlame = (request) =>
      Bun.spawn({ cmd: ["sleep", "30"], cwd: request.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" }) as unknown as SpawnedBlame

    const started = performance.now()
    const error = await stoppedBy(
      opencodeRepo({ worktree, spawn: answeringPreflight(hang), readBudgetMs: 200, cleanupMs: 2_000 }).change(),
    )

    expect(performance.now() - started).toBeLessThan(200 + 2_000 + 2_000)
    expect(error.stop).toBe("terminated")
    expect(error.cleanup).toBe("confirmed")
    expect(error.operation).toBe("git diff")
    // The filter preflight is the one completed read.
    expect(error.readsCompleted).toBe(1)
    expect(error.pid).toBeGreaterThan(0)
    expect(error.message).toContain("accounted for")
    expect(error.message).not.toContain("no descendant")
    expect(changeReadQuarantineFor(worktree)).toBeUndefined()
  })

  test("a signalled return with status 0 is a stop carrying that status and signal, and no pid", async () => {
    const worktree = keyed(freshWorktree())
    const { spawn } = fakeSpawn(() => ({ stdout: "a flushed prefix", status: 0, signal: "SIGKILL" }))

    const error = await stoppedBy(opencodeRepo({ worktree, spawn, inputFs: FILES }).change())

    expect(error.stop).toBe("signalled")
    expect(error.status).toBe(0)
    expect(error.signal).toBe("SIGKILL")
    expect(error.pid).toBeUndefined()
    expect(error.cleanup).toBe("not-applicable")
    expect(changeReadQuarantineFor(worktree)).toBeUndefined()
  })

  test("a signalled `--no-index` return with its accepted status 1 is a stop too", async () => {
    const worktree = keyed(freshWorktree())
    const { spawn } = fakeSpawn((argv) => {
      if (argv.includes("--no-index")) return { stdout: "+++ b/src/new.ts\n+par", status: 1, signal: "SIGTERM" }
      if (argv.includes("ls-files")) return { stdout: "src/new.ts\0" }
      return { stdout: "" }
    })

    const error = await stoppedBy(opencodeRepo({ worktree, spawn, inputFs: FILES }).change())

    expect(error.stop).toBe("signalled")
    expect(error.operation).toContain("--no-index")
    expect(error.status).toBe(1)
    expect(error.signal).toBe("SIGTERM")
    expect(error.pid).toBeUndefined()
    // The filter preflight and three reads.
    expect(error.readsCompleted).toBe(4)
    expect(changeReadQuarantineFor(worktree)).toBeUndefined()
  })

  test("an accepted status with an unread stderr is `stderr-unread`, with no quarantine", async () => {
    const worktree = keyed(freshWorktree())
    const held = closedStream()
    const reader = held.getReader()
    try {
      const { spawn } = fakeSpawn(() => ({ stdout: DIFF, stderr: held, status: 0 }))
      const error = await stoppedBy(opencodeRepo({ worktree, spawn, inputFs: FILES }).change())

      expect(error.stop).toBe("stderr-unread")
      expect(error.status).toBe(0)
      expect(error.message).toContain("could not read its stderr")
      expect(changeReadQuarantineFor(worktree)).toBeUndefined()
    } finally {
      reader.releaseLock()
    }
  })

  test("a refused status with an unread stderr stays a GitError, with MAD's reason apart from git's", async () => {
    const held = closedStream()
    const reader = held.getReader()
    try {
      const { spawn } = fakeSpawn(() => ({ stderr: held, status: 128 }))
      const change = opencodeRepo({ worktree: keyed(freshWorktree()), spawn, inputFs: FILES }).change("nope...HEAD")
      await expect(change).rejects.toThrow(GitError)
      await expect(change).rejects.toThrow("MAD could not read the command's stderr")
    } finally {
      reader.releaseLock()
    }
  })

  test("an unread stdout whose cleanup is unresolved stops AND latches the quarantine", async () => {
    const worktree = keyed(freshWorktree())
    const { spawn } = fakeSpawn(() => ({ stdout: tornStream("--- a/src/pay.ts\n") }))

    const error = await stoppedBy(opencodeRepo({ worktree, spawn, inputFs: FILES, cleanupMs: 50 }).change())

    expect(error.stop).toBe("observation-failed")
    expect(error.cleanup).toBe("unresolved")
    expect(error.pid).toBe(4242)
    expect(changeReadQuarantineFor(worktree)?.operation).toBe("git diff")
  })

  test("an unread stdout whose cleanup is confirmed stops WITHOUT latching", async () => {
    const worktree = keyed(freshWorktree())
    // No pipe at all: the read failed, but no inherited write end is left to reason about.
    const { spawn } = fakeSpawn(() => ({ stdout: null }))

    const error = await stoppedBy(opencodeRepo({ worktree, spawn, inputFs: FILES, cleanupMs: 50 }).change())

    expect(error.stop).toBe("observation-failed")
    expect(error.cleanup).toBe("confirmed")
    expect(changeReadQuarantineFor(worktree)).toBeUndefined()
  })

  test("a spawn the OS refused is `launch-failed`, with no pid and no quarantine", async () => {
    const worktree = keyed(freshWorktree())
    const spawn: SpawnBlame = () => {
      throw new Error("No such file or directory")
    }
    const error = await stoppedBy(opencodeRepo({ worktree, spawn, inputFs: FILES }).change())
    expect(error.stop).toBe("launch-failed")
    expect(error.pid).toBeUndefined()
    expect(error.status).toBeUndefined()
    expect(error.message).toContain("No such file or directory")
    expect(changeReadQuarantineFor(worktree)).toBeUndefined()
  })

  test("a child that exits while a grandchild holds stdout: cleanup unresolved, quarantine latched", async () => {
    const dir = await tempDir()
    const worktree = keyed(dir)
    const pidFile = join(dir, "sleeper.pid")
    const exitsLeavingHolder: SpawnBlame = (request) =>
      Bun.spawn({
        cmd: ["sh", "-c", `sleep 30 2>/dev/null & echo $! > '${pidFile}'; exit 0`],
        cwd: request.cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }) as unknown as SpawnedBlame
    try {
      const error = await stoppedBy(
        opencodeRepo({ worktree, spawn: exitsLeavingHolder, readBudgetMs: 300, cleanupMs: 300 }).change(),
      )

      expect(error.stop).toBe("cleanup-unresolved")
      expect(error.cleanup).toBe("unresolved")
      expect(error.pid).toBeGreaterThan(0)
      expect(error.message).toContain("may still be running")
      expect(changeReadQuarantineFor(worktree)?.pid).toBe(error.pid)
    } finally {
      await killAndAwait(pidFile)
    }
  })
})

/** Kill the sleeper whose pid `pidFile` records, and wait until it is gone. */
async function killAndAwait(pidFile: string): Promise<void> {
  const pid = Number((await readFile(pidFile, "utf8").catch(() => "")).trim())
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    return
  }
  const deadline = performance.now() + 5_000
  while (performance.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await Bun.sleep(10)
  }
  throw new Error(`the sleeper ${pid} was not reaped within 5s`)
}

// ---------------------------------------------------------------------------
// The one total budget
// ---------------------------------------------------------------------------

describe("opencodeRepo.change — one budget for the whole read", () => {
  test("the read that would start past the budget is never spawned, and the error names it", async () => {
    // Every read is fast, but the injected clock advances 25ms per spawn
    // against a 100ms budget: four reads use it all, and the fifth never starts.
    let clock = 0
    const { spawn, spawned } = fakeSpawn(
      (argv) => {
        if (argv.includes("--no-index")) return { stdout: "+x\n", status: 1 }
        if (argv.includes("ls-files")) return { stdout: "a.ts\0b.ts\0" }
        return { stdout: "" }
      },
      () => {
        clock += 25
      },
    )

    const error = await stoppedBy(
      opencodeRepo({ worktree: keyed(freshWorktree()), spawn, inputFs: FILES, readBudgetMs: 100, now: () => clock }).change(),
    )

    expect(spawned).toHaveLength(4)
    expect(error.stop).toBe("budget-exhausted")
    // CAP-4 — the next step was b.ts's file-system check, which is not started either.
    expect(error.operation).toBe('check of untracked entry "b.ts"')
    expect(error.message).toContain('budget exhausted before check of untracked entry "b.ts"')
    // The filter preflight and four reads.
    expect(error.readsCompleted).toBe(5)
    expect(error.cleanup).toBe("not-applicable")
  })

  test("each read's deadline is the REMAINING budget, not the whole of it", async () => {
    let clock = 0
    // A hung child on the third read: it must be killed at what remains (40ms),
    // so the injected clock decides the deadline the launcher is handed.
    const { spawn } = fakeSpawn(
      (argv) => (argv.includes("ls-files") ? { unkillable: true } : { stdout: "" }),
      () => {
        clock += 30
      },
    )
    const started = performance.now()
    const error = await stoppedBy(
      opencodeRepo({ worktree: keyed(freshWorktree()), spawn, inputFs: FILES, readBudgetMs: 100, cleanupMs: 20, now: () => clock }).change(),
    )
    expect(error.operation).toBe("git ls-files")
    expect(error.stop).toBe("cleanup-unresolved")
    // The launcher was handed 100 - 60 = 40ms, not the whole 100ms budget.
    expect(error.message).toContain("did not return within 40ms")
    expect(error.message).not.toContain("did not return within 100ms")
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  test("the FINAL read returning after the budget yields no ChangeSet and no partial result", async () => {
    let clock = 0
    let spawns = 0
    const { spawn } = fakeSpawn(healthy, () => {
      spawns += 1
      // The third and last read (`ls-files`) comes back past the 100ms budget.
      clock = spawns === 3 ? 101 : clock + 10
    })
    const worktree = keyed(freshWorktree())

    const error = await stoppedBy(opencodeRepo({ worktree, spawn, inputFs: FILES, readBudgetMs: 100, now: () => clock }).change())

    expect(spawns).toBe(3)
    expect(error.stop).toBe("budget-passed")
    expect(error.operation).toBe("git ls-files")
    // The filter preflight and two reads.
    expect(error.readsCompleted).toBe(3)
    expect(error.cleanup).toBe("not-applicable")
    expect(error.pid).toBeUndefined()
    expect(changeReadQuarantineFor(worktree)).toBeUndefined()
  })

  /**
   * THE DEFAULT ITSELF, not the exported constant. An ordinary `mad_review`
   * omits `readBudgetMs`, so the fallback in `opencodeRepo` is what users get; a
   * test that always supplies the option would stay green if that fallback alone
   * became ten minutes. The clock is injected, so no real minute passes.
   */
  test("with readBudgetMs OMITTED, a read returning past 60,000 ms stops, and one just inside returns", async () => {
    let clock = 0
    let spawns = 0
    const late = fakeSpawn(healthy, () => {
      spawns += 1
      clock = spawns === 3 ? 60_001 : clock + 10
    })
    const error = await stoppedBy(
      opencodeRepo({ worktree: keyed(freshWorktree()), spawn: late.spawn, now: () => clock }).change(),
    )
    expect(spawns).toBe(3)
    expect(error.stop).toBe("budget-passed")
    expect(error.message).toContain("60000ms change read budget")

    clock = 0
    spawns = 0
    const inside = fakeSpawn(healthy, () => {
      spawns += 1
      clock = spawns === 3 ? 60_000 : clock + 10
    })
    const change = await opencodeRepo({ worktree: keyed(freshWorktree()), spawn: inside.spawn, now: () => clock }).change()
    expect(change.files).toEqual(["src/pay.ts"])
  })

  test("AND THE SAME READS INSIDE THE BUDGET DO RETURN — the non-vacuous sibling", async () => {
    let clock = 0
    const { spawn } = fakeSpawn(healthy, () => {
      clock += 10
    })
    const change = await opencodeRepo({ worktree: keyed(freshWorktree()), spawn, inputFs: FILES, readBudgetMs: 100, now: () => clock }).change()
    expect(change.files).toEqual(["src/pay.ts"])
    expect(change.diff).toBe(DIFF)
  })
})

// ---------------------------------------------------------------------------
// The per-worktree quarantine
// ---------------------------------------------------------------------------

describe("opencodeRepo.change — the per-worktree quarantine", () => {
  const latchUnresolved = async (worktree: string) => {
    const { spawn } = fakeSpawn(() => ({ unkillable: true }))
    const error = await stoppedBy(opencodeRepo({ worktree, spawn, inputFs: FILES, readBudgetMs: 20, cleanupMs: 20 }).change())
    expect(error.stop).toBe("cleanup-unresolved")
    expect(error.pid).toBe(9191)
    return error
  }

  test("after an unresolved cleanup, a FRESH repo for the same worktree launches nothing", async () => {
    const worktree = keyed(freshWorktree())
    await latchUnresolved(worktree)
    expect(changeReadQuarantineFor(worktree)?.pid).toBe(9191)

    const { spawn, spawned } = fakeSpawn(healthy)
    const error = await stoppedBy(opencodeRepo({ worktree, spawn, inputFs: FILES }).change())

    expect(spawned).toHaveLength(0)
    expect(error.stop).toBe("quarantined")
    expect(error.readsCompleted).toBe(0)
    expect(error.quarantine?.pid).toBe(9191)
    expect(error.message).toContain("until the host restarts")
  })

  test("another worktree still reads", async () => {
    await latchUnresolved(keyed(freshWorktree()))
    const { spawn, spawned } = fakeSpawn(healthy)
    const change = await opencodeRepo({ worktree: keyed(freshWorktree()), spawn, inputFs: FILES }).change()
    expect(change.files).toEqual(["src/pay.ts"])
    expect(spawned).toHaveLength(3)
  })

  test("the first reason wins", async () => {
    // Two invocations in flight at once on one worktree. Each read's stdout
    // tears, so each ends as an observation failure with unresolved cleanup the
    // moment its exit is released — no timer decides the order, the test does.
    const worktree = keyed(freshWorktree())
    const gate = () => {
      let open: (() => void) | undefined
      const held = new Promise<void>((resolve) => {
        open = resolve
      })
      return { held, open: () => open?.() }
    }
    const first = gate()
    const second = gate()
    const a = fakeSpawn(() => ({ stdout: tornStream("x"), holdUntil: first.held, pid: 1111 }))
    const b = fakeSpawn(() => ({ stdout: tornStream("y"), holdUntil: second.held, pid: 2222 }))
    const runA = stoppedBy(opencodeRepo({ worktree, spawn: a.spawn, cleanupMs: 50 }).change())
    const runB = stoppedBy(opencodeRepo({ worktree, spawn: b.spawn, cleanupMs: 50 }).change())
    // Each first reaches its `git diff` after the filter preflight returns.
    for (let waited = 0; a.spawned.length < 1 || b.spawned.length < 1; waited++) {
      if (waited > 5_000) throw new Error("neither invocation reached its first read")
      await Bun.sleep(1)
    }
    expect(a.spawned).toHaveLength(1)
    expect(b.spawned).toHaveLength(1)

    first.open()
    const errorA = await runA
    expect(errorA.cleanup).toBe("unresolved")
    expect(changeReadQuarantineFor(worktree)?.pid).toBe(1111)

    second.open()
    const errorB = await runB
    expect(errorB.stop).toBe("observation-failed")
    expect(errorB.cleanup).toBe("unresolved")
    expect(errorB.pid).toBe(2222)
    // The second unresolved cleanup did not replace the first.
    expect(changeReadQuarantineFor(worktree)?.pid).toBe(1111)
  })

  test("a latch made BETWEEN two reads of an invocation stops its next spawn", async () => {
    const worktree = keyed(freshWorktree())

    // Invocation A: its first read is held open until B has latched.
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let firstStarted: (() => void) | undefined
    const aStarted = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    let aSpawns = 0
    const { spawn: aSpawn } = fakeSpawn(
      (argv) => (argv.includes("--unified=8") ? { stdout: DIFF, holdUntil: held } : healthy(argv)),
      () => {
        aSpawns += 1
        firstStarted?.()
      },
    )
    const a = opencodeRepo({ worktree, spawn: aSpawn }).change()
    await aStarted
    expect(aSpawns).toBe(1)

    // Invocation B, a fresh repo on the same worktree, latches an unresolved cleanup.
    await latchUnresolved(worktree)

    // A's first read now returns cleanly; its next spawn must not be made.
    release?.()
    const error = await stoppedBy(a)

    expect(aSpawns).toBe(1)
    expect(error.stop).toBe("quarantined")
    expect(error.operation).toBe("git diff --name-only")
    // The filter preflight and the first read.
    expect(error.readsCompleted).toBe(2)
  })
})

describe("the filter preflight before the change read (CAP-2)", () => {
  test("a preflight git fails is FilterPreflightFailed, with git's detail, and nothing else runs", async () => {
    const { seesPreflight, spawned } = fakeSpawn((argv) =>
      argv.includes("--get-regexp") ? { status: 128, stderr: "fatal: bad config line 3" } : {},
    )
    const error = await opencodeRepo({ worktree: keyed(freshWorktree()), spawn: seesPreflight })
      .change()
      .then(
        () => undefined,
        (e: unknown) => e,
      )

    expect(error).toBeInstanceOf(FilterPreflightFailed)
    expect(error).toBeInstanceOf(GitError)
    expect((error as Error).message).toBe("git config (filter preflight) failed: fatal: bad config line 3")
    expect(spawned).toHaveLength(1)
  })

  test("a preflight that prints something other than config keys is FilterPreflightFailed, never none", async () => {
    const { seesPreflight, spawned } = fakeSpawn((argv) =>
      argv.includes("--get-regexp") ? { status: 0, stdout: "not a key" } : {},
    )
    const change = opencodeRepo({ worktree: keyed(freshWorktree()), spawn: seesPreflight }).change()

    await expect(change).rejects.toBeInstanceOf(FilterPreflightFailed)
    await expect(change).rejects.toThrow("its output could not be read as config keys")
    expect(spawned).toHaveLength(1)
  })

  test("an unknown gitReadPolicy is refused at construction, never treated as inherit", () => {
    expect(() => opencodeRepo({ worktree: "/repo", gitReadPolicy: "Inherit" as never })).toThrow(
      'gitReadPolicy must be "read-only" or "inherit"',
    )
  })
})
