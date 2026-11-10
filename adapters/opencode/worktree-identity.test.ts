/**
 * Ledger #150 — both per-worktree quarantines are keyed by the worktree's
 * identity (`./worktree-identity.ts`), so a symlinked, trailing-separator or
 * relative spelling of the same directory is the same worktree, and a worktree
 * MAD cannot identify launches nothing.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"

import type { SpawnBlame, SpawnedBlame } from "./blame-exec.ts"
import { changeReadStopGuidance } from "./change-read-guidance.ts"
import { blameQuarantineFor, clearBlameQuarantineForTests, latchBlameQuarantine } from "./plugin.ts"
import { ChangeReadStopped, changeReadQuarantineFor, clearChangeReadQuarantineForTests, opencodeRepo } from "./repo.ts"
import { isolateGitHome } from "./test-support/git-home.ts"
import { setupGit } from "./test-support/repo-snapshot.ts"
import { worktreeIdentity, WorktreeIdentityUnresolved, type RealpathOf } from "./worktree-identity.ts"

isolateGitHome()

const COMMIT = ["-c", "user.name=MAD test", "-c", "user.email=mad@example.invalid", "-c", "commit.gpgsign=false"]
const TIMEOUT_MS = 60_000
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A committed repository with one modified file, and the spellings of it a quarantine must treat as one. */
async function spelled() {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "mad-identity-")))
  cleanups.push(() => rm(scratch, { recursive: true, force: true }))
  const dir = join(scratch, "repo")
  await mkdir(dir)
  await setupGit(dir, ["init", "-q"])
  await writeFile(join(dir, "a.txt"), "a\n")
  await setupGit(dir, ["add", "a.txt"])
  await setupGit(dir, [...COMMIT, "commit", "-q", "--no-verify", "-m", "base"])
  await writeFile(join(dir, "a.txt"), "b\n")
  const link = join(scratch, "link")
  await symlink(dir, link)
  const other = join(scratch, "other")
  await mkdir(other)
  cleanups.push(() => {
    for (const path of [dir, other]) {
      clearChangeReadQuarantineForTests(path)
      clearBlameQuarantineForTests(path)
    }
  })
  return {
    dir,
    other,
    aliases: { symlink: link, "trailing separator": `${dir}/`, relative: relative(process.cwd(), dir) },
  }
}

/** A read that never exits and ignores the kill, so its cleanup is unresolved and the worktree is latched. */
function unkillableChild(): SpawnedBlame {
  return {
    pid: 7171,
    stdout: new ReadableStream<Uint8Array>({ start: () => undefined }),
    stderr: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
    exited: new Promise<number>(() => undefined),
    exitCode: null,
    signalCode: null,
    kill() {},
  }
}

function counting(make: (cmd: string[]) => SpawnedBlame | undefined) {
  const launched: string[][] = []
  const spawn: SpawnBlame = (request) => {
    launched.push(request.cmd)
    const made = make(request.cmd)
    if (made !== undefined) return made
    return Bun.spawn({
      cmd: request.cmd,
      cwd: request.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(request.env === undefined ? {} : { env: { ...request.env, PWD: request.cwd } }),
    }) as unknown as SpawnedBlame
  }
  return { spawn, launched }
}

const stoppedBy = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a stop")
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(ChangeReadStopped)
      return error as ChangeReadStopped
    },
  )

const eacces: RealpathOf = (path) => {
  throw Object.assign(new Error(`EACCES: permission denied, realpath '${path}'`), { code: "EACCES" })
}

describe("worktreeIdentity", () => {
  test("an existing directory is its realpath under every spelling", async () => {
    const { dir, aliases } = await spelled()
    for (const [name, alias] of Object.entries(aliases)) expect(worktreeIdentity(alias), name).toEqual({ key: dir })
  })

  test("a missing path falls back to its lexical absolute form; the root stays the root", () => {
    expect(worktreeIdentity("/nonexistent/mad-identity/wt/")).toEqual({ key: "/nonexistent/mad-identity/wt" })
    expect(worktreeIdentity("rel/missing/./wt")).toEqual({ key: resolve("rel/missing/wt") })
    expect(worktreeIdentity("/")).toEqual({ key: "/" })
    expect(worktreeIdentity("/nonexistent", () => {
      throw Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR" })
    })).toEqual({ key: "/nonexistent" })
  })

  test("any other failure is unresolved, naming the code and the path, never a fallback key", () => {
    const identity = worktreeIdentity("/some/worktree", eacces)
    expect("unresolved" in identity && identity.unresolved).toContain("(EACCES)")
    expect("unresolved" in identity && identity.unresolved).toContain('"/some/worktree"')
  })
})

describe("the change-read quarantine is one entry for every spelling", () => {
  test.each(["symlink", "trailing separator", "relative"] as const)(
    "latched through the %s spelling, a fresh change() under the canonical path is refused and launches nothing — and back",
    async (name) => {
      const { dir, other, aliases } = await spelled()
      const alias = aliases[name]
      const first = counting((cmd) => (cmd.includes("diff") ? unkillableChild() : undefined))
      const latched = await stoppedBy(
        opencodeRepo({ worktree: alias, spawn: first.spawn, readBudgetMs: 300, cleanupMs: 30 }).change(),
      )
      expect(latched.cleanup).toBe("unresolved")
      expect(changeReadQuarantineFor(dir)?.pid).toBe(7171)
      expect(changeReadQuarantineFor(alias)?.pid).toBe(7171)
      expect(changeReadQuarantineFor(other)).toBeUndefined()

      const second = counting(() => undefined)
      const refused = await stoppedBy(opencodeRepo({ worktree: dir, spawn: second.spawn }).change())
      expect(refused.stop).toBe("quarantined")
      expect(refused.quarantine?.pid).toBe(7171)
      expect(second.launched).toEqual([])
      // And the other direction: the canonical latch refuses the alias.
      const third = counting(() => undefined)
      expect((await stoppedBy(opencodeRepo({ worktree: alias, spawn: third.spawn }).change())).stop).toBe("quarantined")
      expect(third.launched).toEqual([])
      // Clearing through the alias clears the same entry.
      clearChangeReadQuarantineForTests(alias)
      expect(changeReadQuarantineFor(dir)).toBeUndefined()
    },
    TIMEOUT_MS,
  )

  test(
    "the first reason wins across spellings: a later read under another spelling is refused, not latched",
    async () => {
      const { dir, aliases } = await spelled()
      const make = (pid: number) => () => ({ ...unkillableChild(), pid })
      await stoppedBy(
        opencodeRepo({ worktree: aliases.symlink, spawn: counting(make(1001)).spawn, readBudgetMs: 300, cleanupMs: 30 }).change(),
      )
      // A second unresolved read cannot even start: the latch refuses it first.
      const second = counting(make(2002))
      expect((await stoppedBy(opencodeRepo({ worktree: aliases.relative, spawn: second.spawn }).change())).stop).toBe("quarantined")
      expect(second.launched).toEqual([])
      expect(changeReadQuarantineFor(dir)?.pid).toBe(1001)
    },
    TIMEOUT_MS,
  )

  test("an unresolved identity: the query and the test clear throw rather than answer", async () => {
    const { dir } = await spelled()
    expect(() => changeReadQuarantineFor(dir, eacces)).toThrow(WorktreeIdentityUnresolved)
    expect(() => clearChangeReadQuarantineForTests(dir, eacces)).toThrow(WorktreeIdentityUnresolved)
  })

  test(
    "an identity that fails before a later read: stopped there, earlier reads kept, nothing new launched",
    async () => {
      const { dir } = await spelled()
      let calls = 0
      let launchedAtFailure = -1
      const reads = counting(() => undefined)
      const flaky: RealpathOf = (path) => {
        calls += 1
        if (calls <= 2) return dir
        if (launchedAtFailure < 0) launchedAtFailure = reads.launched.length
        return eacces(path)
      }
      const error = await stoppedBy(opencodeRepo({ worktree: dir, spawn: reads.spawn, realpath: flaky }).change())
      expect(error.stop).toBe("identity-unresolved")
      expect(error.cleanup).toBe("not-applicable")
      expect(error.readsCompleted).toBe(2)
      expect(error.quarantine).toBeUndefined()
      expect(error.pid).toBeUndefined()
      expect(reads.launched).toHaveLength(2)
      expect(launchedAtFailure).toBe(2)
      expect(error.message).toContain("after 2 completed read(s)")
      expect(error.message).toContain("(EACCES)")
      // The diff was accepted before the failure, so the stop says part of the change was read.
      expect(error.message).toContain("Part of the change was read, but none of it was returned for review.")
      expect(error.message).not.toContain("No change was read.")
      expect(changeReadStopGuidance(error)).toContain("MAD could not identify the worktree, so it did not launch this read")
      expect(changeReadStopGuidance(error)).not.toContain("QUARANTINED")
      expect(changeReadQuarantineFor(dir)).toBeUndefined()
    },
    TIMEOUT_MS,
  )
})

describe("the blame quarantine is one entry for every spelling", () => {
  const fact = (pid: number) => ({ operation: "git blame", why: `deadline ${pid}`, pid })

  test.each(["symlink", "trailing separator", "relative"] as const)(
    "latched under the %s spelling, found under the canonical path, and back; another directory is unaffected",
    async (name) => {
      const { dir, other, aliases } = await spelled()
      const alias = aliases[name]
      latchBlameQuarantine(alias, fact(1))
      expect(blameQuarantineFor(dir)?.pid).toBe(1)
      expect(blameQuarantineFor(other)).toBeUndefined()
      clearBlameQuarantineForTests(dir)
      expect(blameQuarantineFor(alias)).toBeUndefined()
      latchBlameQuarantine(dir, fact(2))
      expect(blameQuarantineFor(alias)?.pid).toBe(2)
      // Clearing through the alias clears the same entry.
      clearBlameQuarantineForTests(alias)
      expect(blameQuarantineFor(dir)).toBeUndefined()
    },
  )

  test("the first reason wins across spellings", async () => {
    const { dir, aliases } = await spelled()
    latchBlameQuarantine(aliases.symlink, fact(1))
    latchBlameQuarantine(aliases.relative, fact(2))
    latchBlameQuarantine(`${dir}/`, fact(3))
    expect(blameQuarantineFor(dir)?.pid).toBe(1)
  })

  test("an unresolved identity: query, latch and test clear throw rather than answer", async () => {
    const { dir } = await spelled()
    expect(() => blameQuarantineFor(dir, eacces)).toThrow(WorktreeIdentityUnresolved)
    expect(() => latchBlameQuarantine(dir, fact(1), eacces)).toThrow(WorktreeIdentityUnresolved)
    expect(() => clearBlameQuarantineForTests(dir, eacces)).toThrow(WorktreeIdentityUnresolved)
    expect(blameQuarantineFor(dir)).toBeUndefined()
  })
})
