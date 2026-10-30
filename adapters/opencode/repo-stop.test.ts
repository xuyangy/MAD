/**
 * CAP-5 — the caller's stop reaches the change read (`./repo.ts`) and its
 * untracked precheck (`./change-input.ts`).
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { SpawnBlame, SpawnedBlame } from "./blame-exec.ts"
import type { InputFs } from "./change-input.ts"
import { ChangeReadStopped, changeReadQuarantineFor, clearChangeReadQuarantineForTests, opencodeRepo } from "./repo.ts"
import { isolateGitHome } from "./test-support/git-home.ts"
import { setupGit } from "./test-support/repo-snapshot.ts"

isolateGitHome()

const COMMIT = ["-c", "user.name=MAD test", "-c", "user.email=mad@example.invalid", "-c", "commit.gpgsign=false"]
const TIMEOUT_MS = 60_000
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-stop-"))
  cleanups.push(async () => {
    clearChangeReadQuarantineForTests(dir)
    await rm(dir, { recursive: true, force: true })
  })
  clearChangeReadQuarantineForTests(dir)
  await setupGit(dir, ["init", "-q"])
  await writeFile(join(dir, "a.txt"), "a\n")
  await setupGit(dir, ["add", "a.txt"])
  await setupGit(dir, [...COMMIT, "commit", "-q", "--no-verify", "-m", "base"])
  await writeFile(join(dir, "a.txt"), "b\n")
  return dir
}

/** The launcher's own spawn, recording argv, with an optional hook once a matching read has exited. */
function realSpawn(after?: { match: (cmd: string[]) => boolean; run: () => void }) {
  const launched: string[][] = []
  const spawn: SpawnBlame = (request) => {
    launched.push(request.cmd)
    const child = Bun.spawn({
      cmd: request.cmd,
      cwd: request.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(request.env === undefined ? {} : { env: { ...request.env, PWD: request.cwd } }),
    })
    if (after === undefined || !after.match(request.cmd)) return child as unknown as SpawnedBlame
    const exited = child.exited.then((code) => (after.run(), code))
    return new Proxy(child, { get: (target, key) => (key === "exited" ? exited : Reflect.get(target, key)) }) as never
  }
  return { spawn, launched }
}

/** A child that never exits unless killed; `unkillable` ignores the kill too. */
function hangingChild(unkillable = false): SpawnedBlame {
  let settle: (code: number) => void = () => undefined
  let close: () => void = () => undefined
  return {
    pid: 5151,
    stdout: new ReadableStream<Uint8Array>({ start: (c) => void (close = () => c.close()) }),
    stderr: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
    exited: new Promise<number>((resolve) => (settle = resolve)),
    exitCode: null,
    signalCode: null,
    kill() {
      if (unkillable) return
      close()
      settle(137)
    },
  }
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

describe("the change read stops when the review does (CAP-5)", () => {
  test(
    "BETWEEN READS: the next read is never launched",
    async () => {
      const dir = await repo()
      const stop = new AbortController()
      // The stop lands on the read's own clock check after name-only has
      // returned: between that read and the next, not during either.
      let nameOnlyExited = false
      const { spawn, launched } = realSpawn({ match: (cmd) => cmd.includes("--name-only"), run: () => (nameOnlyExited = true) })
      const now = () => {
        if (nameOnlyExited && !stop.signal.aborted) stop.abort()
        return performance.now()
      }
      const error = await stoppedBy(opencodeRepo({ worktree: dir, spawn, now }).change(undefined, stop.signal))
      expect(error.stop).toBe("cancelled")
      expect(error.cleanup).toBe("not-applicable")
      expect(error.operation).toBe("git ls-files")
      expect(launched.some((cmd) => cmd.includes("ls-files"))).toBe(false)
      // `git diff` had already returned the change's text, so "No change was read" would be false.
      expect(error.message).toEndWith("Part of the change was read, but none of it was returned for review.")
    },
    TIMEOUT_MS,
  )

  test(
    "DURING A RUNNING READ: it is killed, and the confirmed cleanup is reported",
    async () => {
      const dir = await repo()
      const stop = new AbortController()
      const { spawn: real } = realSpawn()
      const spawn: SpawnBlame = (request) => {
        if (request.cmd.includes("--unified=8")) {
          setTimeout(() => stop.abort(), 20)
          return hangingChild()
        }
        return real(request)
      }
      const error = await stoppedBy(opencodeRepo({ worktree: dir, spawn }).change(undefined, stop.signal))
      expect(error.stop).toBe("cancelled")
      expect(error.cleanup).toBe("confirmed")
      expect(error.pid).toBe(5151)
      // `git diff` was running, so change text may have reached MAD before the stop.
      expect(error.message).toEndWith("Some of the change may have been read, but none of it was returned for review.")
      expect(changeReadQuarantineFor(dir)).toBeUndefined()
    },
    TIMEOUT_MS,
  )

  test(
    "DURING A READ THAT SURVIVES THE KILL: unresolved, and the worktree is quarantined",
    async () => {
      const dir = await repo()
      const stop = new AbortController()
      const { spawn: real } = realSpawn()
      const spawn: SpawnBlame = (request) => {
        if (request.cmd.includes("--unified=8")) {
          setTimeout(() => stop.abort(), 20)
          return hangingChild(true)
        }
        return real(request)
      }
      const error = await stoppedBy(opencodeRepo({ worktree: dir, spawn, cleanupMs: 30 }).change(undefined, stop.signal))
      expect(error.stop).toBe("cancelled")
      expect(error.cleanup).toBe("unresolved")
      expect(changeReadQuarantineFor(dir)?.pid).toBe(5151)
    },
    TIMEOUT_MS,
  )

  test(
    "DURING THE PRECHECK, with lstat held: the wait ends, nothing is opened, and it is cancelled",
    async () => {
      const dir = await repo()
      await writeFile(join(dir, "new.ts"), "x\n")
      const stop = new AbortController()
      let release: () => void = () => undefined
      let opens = 0
      const held: InputFs = {
        supported: true,
        lstat: () =>
          new Promise((resolve) => {
            release = () => resolve("file")
            setTimeout(() => stop.abort(), 10)
          }),
        openNoFollow: async () => {
          opens += 1
          return { kind: async () => "file" as const, close: async () => undefined }
        },
      }
      const error = await stoppedBy(opencodeRepo({ worktree: dir, inputFs: held }).change(undefined, stop.signal))
      expect(error.stop).toBe("cancelled")
      expect(error.cleanup).toBe("not-applicable")
      expect(error.message).toContain("an operation already started may still complete")
      expect(error.message).toEndWith("Part of the change was read, but none of it was returned for review.")
      release()
      await Bun.sleep(5)
      expect(opens).toBe(0)
    },
    TIMEOUT_MS,
  )

  test(
    "DURING THE PRECHECK, with a descriptor open and its type query held: one close is attempted at once",
    async () => {
      const dir = await repo()
      await writeFile(join(dir, "new.ts"), "x\n")
      const stop = new AbortController()
      let closes = 0
      const held: InputFs = {
        supported: true,
        lstat: async () => "file",
        openNoFollow: async () => ({
          kind: () => {
            setTimeout(() => stop.abort(), 10)
            return new Promise(() => {})
          },
          close: async () => void (closes += 1),
        }),
      }
      const error = await stoppedBy(opencodeRepo({ worktree: dir, inputFs: held }).change(undefined, stop.signal))
      expect(error.stop).toBe("cancelled")
      expect(closes).toBe(1)
    },
    TIMEOUT_MS,
  )

  test(
    "AS THE LAST READ FINISHES: the read change is not returned, and the stop says the change was read",
    async () => {
      const dir = await repo()
      const stop = new AbortController()
      let lastExited = false
      const { spawn } = realSpawn({ match: (cmd) => cmd.includes("ls-files"), run: () => (lastExited = true) })
      const now = () => {
        if (lastExited && !stop.signal.aborted) stop.abort()
        return performance.now()
      }
      const error = await stoppedBy(opencodeRepo({ worktree: dir, spawn, now }).change(undefined, stop.signal))
      expect(error.stop).toBe("cancelled")
      expect(error.operation).toBe("change read")
      expect(error.message).toContain("the change was read but nothing reviews it")
    },
    TIMEOUT_MS,
  )

  test(
    "AS THE LAST READ FINISHES UNDER `inherit`: the same final check, and no ChangeSet is returned",
    async () => {
      const dir = await repo()
      const stop = new AbortController()
      let lastExited = false
      const { spawn } = realSpawn({ match: (cmd) => cmd.includes("ls-files"), run: () => (lastExited = true) })
      const now = () => {
        if (lastExited && !stop.signal.aborted) stop.abort()
        return performance.now()
      }
      const error = await stoppedBy(
        opencodeRepo({ worktree: dir, spawn, now, gitReadPolicy: "inherit" }).change(undefined, stop.signal),
      )
      expect(error.stop).toBe("cancelled")
      expect(error.operation).toBe("change read")
      expect(error.message).toEndWith("The change was read, but none of it was returned for review.")
    },
    TIMEOUT_MS,
  )

  test(
    "A STOPPED READ WHOSE CHILD EXITED BUT LEFT A PIPE OPEN: unresolved, quarantined, and the observed signal kept",
    async () => {
      const dir = await repo()
      const stop = new AbortController()
      const { spawn: real } = realSpawn()
      const spawn: SpawnBlame = (request) => {
        if (!request.cmd.includes("--unified=8")) return real(request)
        setTimeout(() => stop.abort(), 20)
        let settle: (code: number) => void = () => undefined
        const handle: SpawnedBlame = {
          pid: 5252,
          // stdout never closes: something that inherited it still holds it.
          stdout: new ReadableStream<Uint8Array>({ start: () => undefined }),
          stderr: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
          exited: new Promise<number>((resolve) => (settle = resolve)),
          exitCode: null,
          signalCode: null,
          kill() {
            ;(handle as { signalCode: string | null }).signalCode = "SIGKILL"
            settle(137)
          },
        }
        return handle
      }
      const error = await stoppedBy(opencodeRepo({ worktree: dir, spawn, cleanupMs: 30 }).change(undefined, stop.signal))
      expect(error.stop).toBe("cancelled")
      expect(error.cleanup).toBe("unresolved")
      expect(error.signal).toBe("SIGKILL")
      expect(error.status).toBeUndefined()
      expect(error.message).toContain("process 5252 itself ended")
      expect(error.message).not.toContain("the process may still be running")
      expect(changeReadQuarantineFor(dir)?.pid).toBe(5252)
    },
    TIMEOUT_MS,
  )

  test(
    "ALREADY STOPPED: nothing is launched at all",
    async () => {
      const dir = await repo()
      const stop = new AbortController()
      stop.abort()
      const { spawn, launched } = realSpawn()
      const error = await stoppedBy(opencodeRepo({ worktree: dir, spawn }).change(undefined, stop.signal))
      expect(error.stop).toBe("cancelled")
      expect(error.message).toEndWith("No change was read.")
      expect(launched).toEqual([])
    },
    TIMEOUT_MS,
  )
})
