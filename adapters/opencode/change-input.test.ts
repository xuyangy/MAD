/**
 * CAP-4 — honest change input (`./change-input.ts`, `./repo.ts`), with real git
 * where git is the point and seams where a race has to be made to happen.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, open, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { SpawnBlame, SpawnedBlame } from "./blame-exec.ts"
import {
  inputReason,
  lineSafeName,
  nodeInputFs,
  parseNulNames,
  precheckUntracked,
  type InputFs,
} from "./change-input.ts"
import { LINE_BREAKS } from "../../core/prompt/material.ts"
import { readOnlyGitArgv } from "./git-read-policy.ts"
import { ChangeReadRefused, ChangeReadStopped, clearChangeReadQuarantineForTests, opencodeRepo } from "./repo.ts"
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
  const dir = await mkdtemp(join(tmpdir(), "mad-input-"))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  clearChangeReadQuarantineForTests(dir)
  await setupGit(dir, ["init", "-q"])
  await writeFile(join(dir, "base.txt"), "base\n")
  await setupGit(dir, ["add", "base.txt"])
  await setupGit(dir, [...COMMIT, "commit", "-q", "--no-verify", "-m", "base"])
  return dir
}

async function commitAll(dir: string, message: string): Promise<void> {
  await setupGit(dir, ["add", "-A"])
  await setupGit(dir, [...COMMIT, "commit", "-q", "--no-verify", "-m", message])
}

/** The launcher's own spawn, with `after` run once a matching read has exited. */
function spawnThen(match: (cmd: string[]) => boolean, after: () => Promise<void>): { spawn: SpawnBlame; launched: string[][] } {
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
    if (!match(request.cmd)) return child as unknown as SpawnedBlame
    const exited = child.exited.then(async (code) => {
      await after()
      return code
    })
    return {
      pid: child.pid,
      stdout: child.stdout,
      stderr: child.stderr,
      exited,
      get exitCode() {
        return child.exitCode
      },
      get signalCode() {
        return child.signalCode
      },
      kill: (signal?: number) => child.kill(signal),
    } as unknown as SpawnedBlame
  }
  return { spawn, launched }
}

const isListing = (cmd: string[]) => cmd.includes("ls-files")
const refused = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a refusal")
    },
    (error: unknown) => error,
  )

describe("names", () => {
  test("strict -z parsing: empty is none; a missing final NUL or an empty name is malformed; U+FFFD is unrepresentable", () => {
    expect(parseNulNames("")).toEqual({ names: [] })
    expect(parseNulNames(" lead\0new\nline\0")).toEqual({ names: [" lead", "new\nline"] })
    expect(parseNulNames("a")).toEqual({ problem: "malformed" })
    expect(parseNulNames("a\0\0b\0")).toEqual({ problem: "malformed" })
    expect(parseNulNames("\0")).toEqual({ problem: "malformed" })
    expect(parseNulNames("bad�name\0")).toEqual({ problem: "unrepresentable" })
  })

  test("a name is one quoted line whatever it holds", () => {
    for (const name of ["new\nline", "cr\rx", "nel\u0085x", "ls\u2028x", "ps\u2029x", 'q"uote', "tab\tname"]) {
      const safe = lineSafeName(name)
      expect(safe).toMatch(/^".*"$/)
      expect(LINE_BREAKS.some((ch) => safe.includes(ch))).toBe(false)
    }
    expect(lineSafeName("ls\u2028x")).toBe('"ls\\u2028x"')
  })

  test(
    "WHITESPACE-EDGED, QUOTED, TAB, NEWLINE AND NON-ASCII NAMES are reviewed under their exact names, tracked and untracked",
    async () => {
      const dir = await repo()
      const names = [" lead", "trail ", "tab\tname", "new\nline", 'q"uote', "naïve.ts"]
      for (const name of names) await writeFile(join(dir, name), `old ${JSON.stringify(name)}\n`)
      await writeFile(join(dir, "to-rename.txt"), "rename me\n")
      await commitAll(dir, "names")
      for (const name of names) await writeFile(join(dir, name), `new ${JSON.stringify(name)}\n`)
      await setupGit(dir, ["mv", "to-rename.txt", " renamed lead"])
      const untracked = names.map((name) => `u${name}`)
      for (const name of untracked) await writeFile(join(dir, name), `fresh ${JSON.stringify(name)}\n`)

      const change = await opencodeRepo({ worktree: dir }).change()

      for (const name of [...names, " renamed lead", ...untracked]) expect(change.files).toContain(name)
      for (const name of names) expect(change.diff).toContain(`+new ${JSON.stringify(name)}`)
      for (const name of untracked) expect(change.diff).toContain(`+fresh ${JSON.stringify(name)}`)
      expect(change.files).not.toContain("lead")
    },
    TIMEOUT_MS,
  )

  test(
    "A NAME STARTING WITH U+FEFF keeps it, tracked and untracked, and is never read as a same-named file without it",
    async () => {
      const tracked = await repo()
      await writeFile(join(tracked, "\uFEFFhidden.ts"), "bom old\n")
      await writeFile(join(tracked, "hidden.ts"), "plain old\n")
      await commitAll(tracked, "bom")
      await writeFile(join(tracked, "\uFEFFhidden.ts"), "bom new\n")
      const trackedChange = await opencodeRepo({ worktree: tracked }).change()
      expect(trackedChange.files).toEqual(["\uFEFFhidden.ts"])
      expect(trackedChange.diff).toContain("+bom new")

      // Untracked: the BOM-named file is listed first, and a different file
      // named without it exists, tracked and unchanged.
      const untracked = await repo()
      await writeFile(join(untracked, "hidden.ts"), "plain content\n")
      await commitAll(untracked, "plain")
      await writeFile(join(untracked, "\uFEFFhidden.ts"), "bom content\n")
      const untrackedChange = await opencodeRepo({ worktree: untracked }).change()
      expect(untrackedChange.files).toEqual(["\uFEFFhidden.ts"])
      expect(untrackedChange.diff).toContain("+bom content")
      expect(untrackedChange.diff).not.toContain("plain content")
    },
    TIMEOUT_MS,
  )

  test(
    "MALFORMED OR UNREPRESENTABLE LISTINGS are refused, and an empty listing is not",
    async () => {
      const dir = await repo()
      for (const [listing, problem] of [
        ["a.ts", "malformed"],
        ["a.ts\0\0b.ts\0", "malformed"],
        ["bad�.ts\0", "unrepresentable"],
      ] as const) {
        const spawn: SpawnBlame = (request) =>
          request.cmd.includes("--name-only") ? fakeChild(listing) : (Bun.spawn({ cmd: request.cmd, cwd: request.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...request.env, PWD: request.cwd } }) as never)
        const error = await refused(opencodeRepo({ worktree: dir, spawn }).change())
        expect(error).toBeInstanceOf(ChangeReadRefused)
        expect((error as ChangeReadRefused).why).toBe(inputReason(problem))
      }
    },
    TIMEOUT_MS,
  )

  test(
    "LISTED TRACKED NAMES WITH NO CHANGE TEXT are refused, never 'nothing to review'",
    async () => {
      const dir = await repo()
      const spawn: SpawnBlame = (request) => {
        if (request.cmd.includes("--name-only")) return fakeChild("base.txt\0")
        if (request.cmd.includes("--unified=8")) return fakeChild("")
        return Bun.spawn({ cmd: request.cmd, cwd: request.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...request.env, PWD: request.cwd } }) as never
      }
      const error = await refused(opencodeRepo({ worktree: dir, spawn }).change())
      expect((error as ChangeReadRefused).why).toBe(inputReason("no-change-text"))
    },
    TIMEOUT_MS,
  )
})

/** A child that already exited with `status` and `stdout`. */
function fakeExit(stdout: string, status: number): SpawnedBlame {
  return { ...fakeChild(stdout), exited: Promise.resolve(status), exitCode: status }
}

/** A child that already exited 0 with `stdout`. */
function fakeChild(stdout: string): SpawnedBlame {
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        if (text.length > 0) c.enqueue(new TextEncoder().encode(text))
        c.close()
      },
    })
  return { pid: 1, stdout: stream(stdout), stderr: stream(""), exited: Promise.resolve(0), exitCode: 0, signalCode: null, kill: () => undefined }
}

describe("untracked entries that cannot be read honestly are refused by name", () => {
  const expectRefusal = (error: unknown, name: string, problem: Parameters<typeof inputReason>[0]) => {
    expect(error).toBeInstanceOf(ChangeReadRefused)
    expect((error as ChangeReadRefused).refusal).toBe("unsupported-input")
    expect((error as ChangeReadRefused).why).toBe(`the untracked entry ${lineSafeName(name)}: ${inputReason(problem)}`)
  }

  test(
    "VANISHED after listing: refused, and git never reads it",
    async () => {
      const dir = await repo()
      await writeFile(join(dir, "gone.ts"), "x\n")
      const { spawn, launched } = spawnThen(isListing, () => unlink(join(dir, "gone.ts")))
      expectRefusal(await refused(opencodeRepo({ worktree: dir, spawn }).change()), "gone.ts", "vanished")
      expect(launched.some((cmd) => cmd.includes("--no-index"))).toBe(false)
    },
    TIMEOUT_MS,
  )

  test(
    "UNREADABLE: refused — when this account really cannot read a mode-000 file",
    async () => {
      const dir = await repo()
      const secret = join(dir, "secret.ts")
      await writeFile(secret, "x\n")
      await chmod(secret, 0o000)
      cleanups.unshift(() => chmod(secret, 0o644).catch(() => undefined))
      const readable = await open(secret, "r").then(
        async (handle) => (await handle.close(), true),
        () => false,
      )
      if (readable) {
        console.warn("skipped: this account can read a mode-000 file, so the unreadable case cannot be made here")
        return
      }
      expectRefusal(await refused(opencodeRepo({ worktree: dir }).change()), "secret.ts", "unreadable")
    },
    TIMEOUT_MS,
  )

  test(
    "A NESTED REPOSITORY, and an entry replaced by a directory after listing: refused",
    async () => {
      const nested = await repo()
      await mkdir(join(nested, "inner"))
      await setupGit(join(nested, "inner"), ["init", "-q"])
      await writeFile(join(nested, "inner", "f"), "x\n")
      expectRefusal(await refused(opencodeRepo({ worktree: nested }).change()), "inner/", "directory")

      const swapped = await repo()
      await writeFile(join(swapped, "d"), "x\n")
      const { spawn } = spawnThen(isListing, async () => {
        await unlink(join(swapped, "d"))
        await mkdir(join(swapped, "d"))
      })
      expectRefusal(await refused(opencodeRepo({ worktree: swapped, spawn }).change()), "d", "directory")
    },
    TIMEOUT_MS,
  )

  test(
    "A FIFO SWAPPED IN after listing: refused before any read of it is launched",
    async () => {
      const dir = await repo()
      await writeFile(join(dir, "pipe"), "x\n")
      const { spawn, launched } = spawnThen(isListing, async () => {
        await unlink(join(dir, "pipe"))
        await setupGit(dir, ["--version"]) // a no-op; the FIFO is made below
        const made = Bun.spawnSync({ cmd: ["mkfifo", join(dir, "pipe")] })
        if (made.exitCode !== 0) throw new Error("mkfifo failed")
      })
      expectRefusal(await refused(opencodeRepo({ worktree: dir, spawn }).change()), "pipe", "special")
      expect(launched.some((cmd) => cmd.includes("--no-index"))).toBe(false)
    },
    TIMEOUT_MS,
  )

  test(
    "A SYMLINK SWAPPED IN between lstat and open, and a vanish between the check and git: changed while being read",
    async () => {
      const dir = await repo()
      await writeFile(join(dir, "racy.ts"), "x\n")
      const swapped: InputFs = {
        supported: true,
        lstat: async () => "file",
        openNoFollow: async () => {
          throw Object.assign(new Error("loop"), { code: "ELOOP" })
        },
      }
      expectRefusal(await refused(opencodeRepo({ worktree: dir, inputFs: swapped }).change()), "racy.ts", "changed")

      const vanishing: InputFs = {
        ...nodeInputFs,
        supported: true,
        openNoFollow: async (path) => {
          const opened = await nodeInputFs.openNoFollow(path)
          await opened.close()
          await unlink(path)
          return { kind: async () => "file" as const, close: async () => undefined }
        },
      }
      expectRefusal(await refused(opencodeRepo({ worktree: dir, inputFs: vanishing }).change()), "racy.ts", "changed")
    },
    TIMEOUT_MS,
  )

  test("A PLATFORM WITHOUT NON-BLOCKING NO-FOLLOW OPENS refuses every untracked entry rather than open one blocking", async () => {
    const outcome = await precheckUntracked("/repo", "a.ts", 1_000, { ...nodeInputFs, supported: false })
    expect(outcome).toEqual({ problem: "platform" })
  })
})

describe("the precheck's own bounds", () => {
  test("A HELD FILE-SYSTEM ANSWER is unanswered within the wait, and a handle that opens later is closed", async () => {
    let release: () => void = () => undefined
    let closed = 0
    const held: InputFs = {
      supported: true,
      lstat: async () => "file",
      openNoFollow: () =>
        new Promise((resolve) => {
          release = () => resolve({ kind: async () => "file" as const, close: async () => void (closed += 1) })
        }),
    }
    expect(await precheckUntracked("/repo", "a.ts", 20, held)).toEqual({ unanswered: true })
    release()
    await Bun.sleep(5)
    expect(closed).toBe(1)
  })

  test("AN LSTAT THAT ANSWERS AFTER THE WAIT starts nothing further: no open happens", async () => {
    let release: () => void = () => undefined
    let opens = 0
    const late: InputFs = {
      supported: true,
      lstat: () => new Promise((resolve) => (release = () => resolve("file"))),
      openNoFollow: async () => {
        opens += 1
        return { kind: async () => "file" as const, close: async () => undefined }
      },
    }
    expect(await precheckUntracked("/repo", "a.ts", 20, late)).toEqual({ unanswered: true })
    release()
    await Bun.sleep(10)
    expect(opens).toBe(0)
  })

  test("A TYPE QUERY HELD PAST THE WAIT: the descriptor's close is attempted at once, without waiting for it, and only once", async () => {
    for (const settleKind of ["resolve", "reject"] as const) {
      let settle: () => void = () => undefined
      let closes = 0
      const stalled: InputFs = {
        supported: true,
        lstat: async () => "file",
        openNoFollow: async () => ({
          kind: () =>
            new Promise((resolve, reject) => {
              settle = () => (settleKind === "resolve" ? resolve("file") : reject(new Error("late fstat")))
            }),
          close: async () => void (closes += 1),
        }),
      }
      expect(await precheckUntracked("/repo", "a.ts", 20, stalled)).toEqual({ unanswered: true })
      // Closed at the wait's end, with the type query still pending.
      expect(closes).toBe(1)
      settle()
      await Bun.sleep(5)
      expect(closes).toBe(1)
    }
  })

  test("A CLOSE THAT FAILS is not reported as closed, and does not throw", async () => {
    const failingClose: InputFs = {
      supported: true,
      lstat: async () => "file",
      openNoFollow: async () => ({ kind: async () => "file" as const, close: async () => Promise.reject(new Error("EBADF")) }),
    }
    expect(await precheckUntracked("/repo", "a.ts", 1_000, failingClose)).toEqual({ ok: true })
  })

  test("A LATE FAILURE after the wait is consumed", async () => {
    let fail: () => void = () => undefined
    const failing: InputFs = {
      supported: true,
      lstat: () =>
        new Promise((_, reject) => {
          fail = () => reject(Object.assign(new Error("io"), { code: "EIO" }))
        }),
      openNoFollow: async () => ({ kind: async () => "file" as const, close: async () => undefined }),
    }
    expect(await precheckUntracked("/repo", "a.ts", 20, failing)).toEqual({ unanswered: true })
    fail()
    await Bun.sleep(5)
  })

  test("an unknown file-system error is its own fixed reason, never vanished or unreadable", async () => {
    const odd: InputFs = {
      supported: true,
      lstat: async () => {
        throw Object.assign(new Error("io"), { code: "EIO" })
      },
      openNoFollow: async () => ({ kind: async () => "file" as const, close: async () => undefined }),
    }
    expect(await precheckUntracked("/repo", "a.ts", 1_000, odd)).toEqual({ problem: "check-failed" })
  })

  test(
    "THROUGH THE CHANGE READ: an unanswered check is a stopped read inside the budget, not an input claim",
    async () => {
      const dir = await repo()
      await writeFile(join(dir, "slow.ts"), "x\n")
      const never: InputFs = { supported: true, lstat: () => new Promise(() => {}), openNoFollow: async () => ({ kind: async () => "file" as const, close: async () => undefined }) }
      const error = await refused(opencodeRepo({ worktree: dir, inputFs: never, readBudgetMs: 2_000 }).change())
      expect(error).toBeInstanceOf(ChangeReadStopped)
      expect((error as ChangeReadStopped).stop).toBe("check-unanswered")
      expect((error as ChangeReadStopped).cleanup).toBe("not-applicable")
    },
    TIMEOUT_MS,
  )
})

describe("supported forms stay honest", () => {
  test(
    "a symlink is reviewed as link text: its target, inside or outside, is never read, and a broken link is reviewed too",
    async () => {
      const dir = await repo()
      const outside = await mkdtemp(join(tmpdir(), "mad-input-outside-"))
      cleanups.push(() => rm(outside, { recursive: true, force: true }))
      await writeFile(join(outside, "secret.txt"), "TOP SECRET CONTENT\n")
      await symlink(join(outside, "secret.txt"), join(dir, "link-out"))
      await symlink(join(dir, "no-such-file"), join(dir, "link-broken"))

      const change = await opencodeRepo({ worktree: dir }).change()

      expect(change.files).toEqual(expect.arrayContaining(["link-out", "link-broken"]))
      expect(change.diff).not.toContain("TOP SECRET CONTENT")
      expect(change.diff).toContain("new file mode 120000")
    },
    TIMEOUT_MS,
  )

  test(
    "an empty untracked file, a staged empty file, mode-only, rename, deletion, binary and staged-plus-unstaged edits",
    async () => {
      const dir = await repo()
      await writeFile(join(dir, "mode.sh"), "echo\n")
      await writeFile(join(dir, "old-name.txt"), "rename\n")
      await writeFile(join(dir, "doomed.txt"), "bye\n")
      await writeFile(join(dir, "both.txt"), "one\n")
      await commitAll(dir, "forms")
      await writeFile(join(dir, "empty-untracked"), "")
      await writeFile(join(dir, "empty-staged"), "")
      await setupGit(dir, ["add", "empty-staged"])
      await chmod(join(dir, "mode.sh"), 0o755)
      await setupGit(dir, ["mv", "old-name.txt", "new-name.txt"])
      await unlink(join(dir, "doomed.txt"))
      await writeFile(join(dir, "blob.bin"), new Uint8Array([0, 1, 2, 0, 255]))
      await writeFile(join(dir, "both.txt"), "two\n")
      await setupGit(dir, ["add", "both.txt"])
      await writeFile(join(dir, "both.txt"), "three\n")

      const change = await opencodeRepo({ worktree: dir }).change()

      for (const name of ["empty-untracked", "empty-staged", "mode.sh", "new-name.txt", "doomed.txt", "blob.bin", "both.txt"]) {
        expect(change.files).toContain(name)
      }
      expect(change.diff).toContain("new mode 100755")
      expect(change.diff).toContain("deleted file mode")
      expect(change.diff).toContain("Binary files")
      expect(change.diff).toContain("+three")
      expect(change.diff).toContain("index 0000000..e69de29")
    },
    TIMEOUT_MS,
  )
})

describe("the harness's inherit path is unchanged", () => {
  test("no -z, no precheck, and the historical newline-and-trim parse, exactly", async () => {
    const seen: string[][] = []
    const scripted: SpawnBlame = (request) => {
      seen.push(request.cmd)
      if (request.cmd.includes("--name-only")) return fakeChild(" spaced.ts \nsrc/pay.ts\n")
      if (request.cmd.includes("ls-files")) return fakeChild("  lead.ts\n")
      if (request.cmd.includes("--no-index")) return fakeExit("+new\n", 1)
      return fakeChild("diff --git a/src/pay.ts b/src/pay.ts\n")
    }
    const failingFs: InputFs = {
      supported: true,
      lstat: async () => {
        throw new Error("inherit must not check")
      },
      openNoFollow: async () => ({ kind: async () => "file" as const, close: async () => undefined }),
    }

    const change = await opencodeRepo({ worktree: "/repo", spawn: scripted, gitReadPolicy: "inherit", inputFs: failingFs }).change()

    // Trimmed, as the harness measured it (#148).
    expect(change.files).toEqual(["spaced.ts", "src/pay.ts", "lead.ts"])
    expect(seen).toEqual([
      ["git", "diff", "--unified=8", "HEAD", "--"],
      ["git", "diff", "--name-only", "HEAD", "--"],
      ["git", "ls-files", "--others", "--exclude-standard"],
      ["git", "diff", "--unified=8", "--no-index", "--", "/dev/null", "lead.ts"],
    ])
  })
})
