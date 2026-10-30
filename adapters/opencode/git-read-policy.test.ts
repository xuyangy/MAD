/**
 * The read policy (`./git-read-policy.ts`), proved with real git.
 *
 * Every row configures one helper git can run, then shows two things. Under
 * plain git, on a read where that helper applies, the helper runs: its sentinel
 * script records the execution. That is the control. Through MAD's own read, the
 * same helper does not run.
 *
 * The probe behind the matrix (git 2.56) found:
 * - fsmonitor fires on `diff HEAD`, `diff --name-only`, `ls-files` and `blame`;
 * - textconv fires on `diff HEAD`, `diff --no-index` and `blame`;
 * - a diff command driver fires on `diff HEAD`;
 * - `diff.external` fires on `diff HEAD` and `diff --no-index`;
 * - clean and process filters fire on `diff HEAD` and `blame` (clean also on
 *   `--no-index`).
 *
 * A row that names one path only is not applicable to the other: blame runs no
 * external diff or diff command.
 *
 * A pager has no executing control. Git starts one only when stdout is a
 * terminal, and the launcher's stdout is a pipe. Its suppression is asserted
 * from the argv and the environment instead, and is recorded as having no
 * executing control.
 *
 * Fixture git runs with global and system config off (`repo-snapshot.ts`).
 * MAD's own reads keep the caller's config files, as the policy says.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  configuredFilters,
  FILTER_PREFLIGHT,
  readOnlyGitArgv,
  readOnlyGitEnv,
  unsupportedTargetReason,
} from "./git-read-policy.ts"
import {
  ChangeReadRefused,
  clearChangeReadQuarantineForTests,
  FilterPreflightFailed,
  GitError,
  opencodeRepo,
} from "./repo.ts"
import { opencodeTools } from "./tools.ts"
import { runBoundedBlame, type SpawnBlame } from "./blame-exec.ts"
import { makeReviewRepo, setupGit, type ReviewRepo } from "./test-support/repo-snapshot.ts"
import { isolateGitHome } from "./test-support/git-home.ts"

isolateGitHome()

const TIMEOUT_MS = 60_000

const ISOLATED = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }

interface Fixture {
  repo: ReviewRepo
  /** A scratch directory outside the repository, for sentinels and their log. */
  scratch: string
  /** An executable that records `name` in the log, then runs `body`. */
  sentinel(name: string, body: string): Promise<string>
  /** Every name the sentinels recorded, in order. */
  fired(): Promise<string[]>
  reset(): Promise<void>
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/**
 * A dirty review repository: `src/pay.ts` modified, `notes.txt` untracked, and
 * an `.gitattributes` file when a row needs one.
 */
async function fixture(): Promise<Fixture> {
  const repo = await makeReviewRepo({ dirty: true })
  const scratch = await mkdtemp(join(tmpdir(), "mad-policy-sentinel-"))
  cleanups.push(() => repo.remove(), () => rm(scratch, { recursive: true, force: true }))
  clearChangeReadQuarantineForTests(repo.dir)
  const log = join(scratch, "fired.log")
  await writeFile(log, "")
  return {
    repo,
    scratch,
    async sentinel(name, body) {
      const path = join(scratch, `${name}.sh`)
      await writeFile(path, `#!/bin/sh\necho ${name} >> '${log}'\n${body}\n`, { mode: 0o755 })
      return path
    },
    async fired() {
      return (await readFile(log, "utf8")).split("\n").filter((line) => line.length > 0)
    },
    async reset() {
      await writeFile(log, "")
    },
  }
}

/** Plain git, the control: no policy, fixture config isolation only. */
async function plainGit(cwd: string, argv: string[], extraEnv: Record<string, string> = {}): Promise<number> {
  const child = Bun.spawn({
    cmd: ["git", ...argv],
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...ISOLATED, ...extraEnv },
  })
  await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  return child.exited
}

/** Runs `body` with `process.env` changed, and restores it whatever happens. */
async function withEnv<T>(changes: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await body()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const change = (dir: string) => opencodeRepo({ worktree: dir }).change()
const blame = (dir: string) => opencodeTools({ worktree: dir }).blame("src/pay.ts", 1, 1)

describe("the read policy's argv and environment", () => {
  test("every subcommand gets the global overrides; diff and blame get their own", () => {
    expect(readOnlyGitArgv(["diff", "HEAD", "--"])).toEqual([
      "git", "--no-pager", "-c", "core.fsmonitor=false", "-c", "color.ui=false",
      "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=dirty", "--submodule=short",
      "HEAD", "--",
    ])
    expect(readOnlyGitArgv(["blame", "-L", "1,1", "--", "f"])).toEqual([
      "git", "--no-pager", "-c", "core.fsmonitor=false", "-c", "color.ui=false",
      "blame", "--no-textconv", "-L", "1,1", "--", "f",
    ])
    expect(readOnlyGitArgv(["ls-files", "--others"])).toEqual([
      "git", "--no-pager", "-c", "core.fsmonitor=false", "-c", "color.ui=false", "ls-files", "--others",
    ])
  })

  test("every inherited GIT_* variable and PAGER is removed, and the policy's own values are set", () => {
    const env = readOnlyGitEnv({
      HOME: "/home/u",
      PATH: "/bin",
      PAGER: "less",
      GIT_PAGER: "less",
      GIT_DIR: "/elsewhere/.git",
      GIT_WORK_TREE: "/elsewhere",
      GIT_EXTERNAL_DIFF: "/bin/evil",
      GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='/bin/evil'",
      GIT_ALLOW_PROTOCOL: "file:https",
      UNSET: undefined,
    })
    expect(env).toEqual({
      HOME: "/home/u",
      PATH: "/bin",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_ALLOW_PROTOCOL: "",
    })
  })

  test("PAGER SUPPRESSION, asserted without an executing control: no pager variable reaches git, and `--no-pager` leads", () => {
    // No control can fire here: git starts a pager only when stdout is a
    // terminal, and the launcher's stdout is a pipe.
    const env = readOnlyGitEnv({ PAGER: "/bin/evil", GIT_PAGER: "/bin/evil" })
    expect(env.PAGER).toBeUndefined()
    expect(env.GIT_PAGER).toBeUndefined()
    expect(readOnlyGitArgv(["diff"])[1]).toBe("--no-pager")
  })

  test("only a target starting with `-` is unsupported, and it is never trimmed", () => {
    for (const target of ["-p", "-", "--", "--output=/tmp/x"]) expect(unsupportedTargetReason(target)).toBeDefined()
    for (const target of [undefined, "HEAD", "HEAD~1", "main...HEAD", "a..b", " -x"]) {
      expect(unsupportedTargetReason(target)).toBeUndefined()
    }
  })
})

describe("the filter preflight's answer", () => {
  test("exit 1 is none; exit 0 names each driver once; anything else is unknown, never none", () => {
    expect(configuredFilters(1, "")).toEqual({ kind: "none" })
    expect(configuredFilters(0, "filter.lfs.clean\ngit-lfs clean -- %f\0filter.lfs.process\ngit-lfs filter-process\0")).toEqual({
      kind: "configured",
      drivers: ["lfs"],
    })
    expect(configuredFilters(0, "filter.a.b.smudge\nx\0")).toEqual({ kind: "configured", drivers: ["a.b"] })
    expect(configuredFilters(128, "")).toEqual({ kind: "unknown" })
    expect(configuredFilters(0, "")).toEqual({ kind: "unknown" })
    expect(configuredFilters(0, "core.pager\nless\0")).toEqual({ kind: "unknown" })
  })

  test(
    "a broken config is a git error, never a clean preflight",
    async () => {
      const f = await fixture()
      await writeFile(join(f.repo.dir, ".git", "config"), "[broken\n", { flag: "a" })
      await expect(change(f.repo.dir)).rejects.toBeInstanceOf(FilterPreflightFailed)
      await expect(blame(f.repo.dir)).rejects.toThrow("filter preflight failed")
    },
    TIMEOUT_MS,
  )
})

describe("helpers configured in the repository do not run under MAD's reads", () => {
  test(
    "core.fsmonitor — change and blame",
    async () => {
      const f = await fixture()
      await setupGit(f.repo.dir, ["config", "core.fsmonitor", await f.sentinel("fsmonitor", "exit 1")])
      await plainGit(f.repo.dir, ["diff", "HEAD"])
      expect(await f.fired()).toContain("fsmonitor")
      await f.reset()
      await plainGit(f.repo.dir, ["blame", "-L", "1,1", "--porcelain", "--", "src/pay.ts"])
      expect(await f.fired()).toContain("fsmonitor")
      await f.reset()

      expect((await change(f.repo.dir)).files).toContain("src/pay.ts")
      expect(await blame(f.repo.dir)).toContain("filename src/pay.ts")
      expect(await f.fired()).toEqual([])
    },
    TIMEOUT_MS,
  )

  test(
    "a textconv driver — change (tracked and untracked) and blame",
    async () => {
      const f = await fixture()
      await writeFile(join(f.repo.dir, ".gitattributes"), "*.ts diff=conv\n*.txt diff=conv\n")
      await setupGit(f.repo.dir, ["config", "diff.conv.textconv", await f.sentinel("textconv", 'cat "$1"')])
      await plainGit(f.repo.dir, ["diff", "HEAD"])
      expect(await f.fired()).toContain("textconv")
      await f.reset()
      await plainGit(f.repo.dir, ["diff", "--no-index", "--", "/dev/null", "notes.txt"])
      expect(await f.fired()).toContain("textconv")
      await f.reset()
      await plainGit(f.repo.dir, ["blame", "-L", "1,1", "--porcelain", "--", "src/pay.ts"])
      expect(await f.fired()).toContain("textconv")
      await f.reset()

      const read = await change(f.repo.dir)
      expect(read.diff).toContain("total * 0.01")
      expect(read.diff).toContain("+untracked scratch")
      expect(await blame(f.repo.dir)).toContain("filename src/pay.ts")
      expect(await f.fired()).toEqual([])
    },
    TIMEOUT_MS,
  )

  test(
    "a diff command driver — change only (blame runs no diff driver)",
    async () => {
      const f = await fixture()
      await writeFile(join(f.repo.dir, ".gitattributes"), "*.ts diff=cmd\n")
      await setupGit(f.repo.dir, ["config", "diff.cmd.command", await f.sentinel("diffcommand", "exit 0")])
      await plainGit(f.repo.dir, ["diff", "HEAD"])
      expect(await f.fired()).toContain("diffcommand")
      await f.reset()

      expect((await change(f.repo.dir)).diff).toContain("total * 0.01")
      expect(await f.fired()).toEqual([])
    },
    TIMEOUT_MS,
  )

  test(
    "diff.external in config — change, tracked and untracked (blame runs no external diff)",
    async () => {
      const f = await fixture()
      await setupGit(f.repo.dir, ["config", "diff.external", await f.sentinel("external", "exit 0")])
      await plainGit(f.repo.dir, ["diff", "HEAD"])
      expect(await f.fired()).toContain("external")
      await f.reset()
      await plainGit(f.repo.dir, ["diff", "--no-index", "--", "/dev/null", "notes.txt"])
      expect(await f.fired()).toContain("external")
      await f.reset()

      const read = await change(f.repo.dir)
      expect(read.diff).toContain("total * 0.01")
      expect(read.diff).toContain("+untracked scratch")
      expect(await f.fired()).toEqual([])
    },
    TIMEOUT_MS,
  )
})

describe("forced colour does not reach the diff MAD reads", () => {
  test(
    "color.ui=always: the control's diff carries escape codes; MAD's change and blame do not",
    async () => {
      const f = await fixture()
      await setupGit(f.repo.dir, ["config", "color.ui", "always"])
      const child = Bun.spawn({
        cmd: ["git", "diff", "HEAD"],
        cwd: f.repo.dir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...ISOLATED },
      })
      expect(await new Response(child.stdout).text()).toContain("\x1b[")

      expect((await change(f.repo.dir)).diff).not.toContain("\x1b[")
      expect(await blame(f.repo.dir)).not.toContain("\x1b[")
    },
    TIMEOUT_MS,
  )

  test(
    "color.diff=always, which wins over color.ui=false: the control's diff carries escape codes; MAD's does not",
    async () => {
      const f = await fixture()
      await setupGit(f.repo.dir, ["config", "color.diff", "always"])
      const child = Bun.spawn({
        cmd: ["git", "-c", "color.ui=false", "diff", "HEAD"],
        cwd: f.repo.dir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...ISOLATED },
      })
      expect(await new Response(child.stdout).text()).toContain("\x1b[")

      expect((await change(f.repo.dir)).diff).not.toContain("\x1b[")
    },
    TIMEOUT_MS,
  )

  test(
    "hostile blame colouring: blame --porcelain carries no escape codes under any of it",
    async () => {
      const f = await fixture()
      for (const [key, value] of [
        ["color.ui", "always"],
        ["color.blame", "always"],
        ["blame.coloring", "highlightRecent"],
        ["color.blame.highlightRecent", "red,12 month ago,blue"],
        ["color.blame.repeatedLines", "red"],
      ] as const) {
        await setupGit(f.repo.dir, ["config", key, value])
      }
      expect(await blame(f.repo.dir)).not.toContain("\x1b[")
    },
    TIMEOUT_MS,
  )
})

describe("helpers and redirection inherited from the environment do not apply", () => {
  test(
    "GIT_EXTERNAL_DIFF — change, tracked and untracked",
    async () => {
      const f = await fixture()
      const external = await f.sentinel("envexternal", "exit 0")
      await plainGit(f.repo.dir, ["diff", "HEAD"], { GIT_EXTERNAL_DIFF: external })
      expect(await f.fired()).toContain("envexternal")
      await f.reset()

      const read = await withEnv({ GIT_EXTERNAL_DIFF: external }, () => change(f.repo.dir))
      expect(read.diff).toContain("total * 0.01")
      expect(read.diff).toContain("+untracked scratch")
      expect(await f.fired()).toEqual([])
    },
    TIMEOUT_MS,
  )

  test(
    "an inherited GIT_DIR naming another repository — change and blame read the worktree given",
    async () => {
      const f = await fixture()
      const other = await makeReviewRepo({ dirty: false })
      cleanups.push(() => other.remove())
      await writeFile(join(other.dir, "src", "pay.ts"), "elsewhere\n")
      await setupGit(other.dir, ["-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qam", "other"])
      const otherGit = join(other.dir, ".git")
      // Control: plain git with the variable reads the other repository.
      const child = Bun.spawn({
        cmd: ["git", "log", "-1", "--format=%s"],
        cwd: f.repo.dir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...ISOLATED, GIT_DIR: otherGit },
      })
      expect((await new Response(child.stdout).text()).trim()).toBe("other")

      const read = await withEnv({ GIT_DIR: otherGit, GIT_WORK_TREE: other.dir }, () => change(f.repo.dir))
      expect(read.diff).toContain("total * 0.01")
      expect(read.diff).not.toContain("elsewhere")
      const blamed = await withEnv({ GIT_DIR: otherGit }, () => blame(f.repo.dir))
      expect(blamed).toContain("total * 0.01")
    },
    TIMEOUT_MS,
  )
})

describe("executable filters: the repository is refused before any content read", () => {
  async function filterFixture(config: [string, string][], attributes = "*.ts filter=x\n") {
    const f = await fixture()
    await writeFile(join(f.repo.dir, ".gitattributes"), attributes)
    for (const [key, value] of config) await setupGit(f.repo.dir, ["config", key, value])
    return f
  }

  test(
    "a clean filter: the control runs it; MAD refuses, names it, and runs nothing",
    async () => {
      const f = await fixture()
      const clean = await f.sentinel("clean", "cat")
      await writeFile(join(f.repo.dir, ".gitattributes"), "*.ts filter=x\n")
      await setupGit(f.repo.dir, ["config", "filter.x.clean", clean])
      await plainGit(f.repo.dir, ["diff", "HEAD"])
      expect(await f.fired()).toContain("clean")
      await f.reset()
      await plainGit(f.repo.dir, ["blame", "-L", "1,1", "--porcelain", "--", "src/pay.ts"])
      expect(await f.fired()).toContain("clean")
      await f.reset()

      const refused = change(f.repo.dir)
      await expect(refused).rejects.toBeInstanceOf(ChangeReadRefused)
      await expect(refused).rejects.toThrow("`x`")
      await expect(blame(f.repo.dir)).rejects.toThrow("does not support configured filters")
      expect(await f.fired()).toEqual([])
    },
    TIMEOUT_MS,
  )

  test(
    "a process filter whose handshake fails: the control marks its start; MAD refuses and starts nothing",
    async () => {
      const f = await fixture()
      const proc = await f.sentinel("process", "exit 1")
      await writeFile(join(f.repo.dir, ".gitattributes"), "*.ts filter=x\n")
      await setupGit(f.repo.dir, ["config", "filter.x.process", proc])
      await plainGit(f.repo.dir, ["diff", "HEAD"])
      expect(await f.fired()).toContain("process")
      await f.reset()

      await expect(change(f.repo.dir)).rejects.toBeInstanceOf(ChangeReadRefused)
      await expect(blame(f.repo.dir)).rejects.toThrow("does not support configured filters")
      expect(await f.fired()).toEqual([])
    },
    TIMEOUT_MS,
  )

  test(
    "smudge-only, required, unused and included filters are refused too",
    async () => {
      const smudge = await filterFixture([["filter.s.smudge", "/bin/false"]])
      await expect(change(smudge.repo.dir)).rejects.toThrow("`s`")

      const required = await filterFixture([["filter.x.clean", "/bin/false"], ["filter.x.required", "true"]])
      await expect(change(required.repo.dir)).rejects.toThrow("`x`")

      const unused = await filterFixture([["filter.unused.clean", "/bin/false"]], "")
      await expect(change(unused.repo.dir)).rejects.toThrow("`unused`")

      const included = await fixture()
      const extra = join(included.scratch, "extra.gitconfig")
      await writeFile(extra, "[filter \"inc\"]\n\tclean = /bin/false\n")
      await setupGit(included.repo.dir, ["config", "include.path", extra])
      await expect(change(included.repo.dir)).rejects.toThrow("`inc`")
      await expect(blame(included.repo.dir)).rejects.toThrow("`inc`")
    },
    TIMEOUT_MS,
  )

  test(
    "a filter defined only in the global config, as `git lfs install` writes, refuses an ordinary repository with no attributes",
    async () => {
      const f = await fixture()
      const home = join(f.scratch, "home")
      await setupGit(f.scratch, ["init", "-q", home])
      await writeFile(
        join(home, ".gitconfig"),
        '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n',
      )
      await withEnv({ HOME: home, XDG_CONFIG_HOME: join(home, ".config") }, async () => {
        const refused = change(f.repo.dir)
        await expect(refused).rejects.toBeInstanceOf(ChangeReadRefused)
        await expect(refused).rejects.toThrow("`lfs`")
        await expect(refused).rejects.toThrow("could run")
        await expect(blame(f.repo.dir)).rejects.toThrow("`lfs`")
      })
      // The control: the same repository, the same HOME without the global
      // filter, is read.
      await rm(join(home, ".gitconfig"))
      await withEnv({ HOME: home, XDG_CONFIG_HOME: join(home, ".config") }, async () => {
        expect((await change(f.repo.dir)).files).toContain("src/pay.ts")
      })
    },
    TIMEOUT_MS,
  )

  test("the preflight is the policy's argv over FILTER_PREFLIGHT", () => {
    expect(readOnlyGitArgv(FILTER_PREFLIGHT)).toEqual([
      "git", "--no-pager", "-c", "core.fsmonitor=false", "-c", "color.ui=false",
      "config", "--null", "--includes", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$",
    ])
  })
})

describe("a partial clone's missing object is never fetched", () => {
  /**
   * A blobless clone with no checkout, so every read of content needs a blob
   * it does not have, and an upload-pack helper that records itself.
   */
  async function partialClone() {
    const origin = await makeReviewRepo({ dirty: false })
    const scratch = await mkdtemp(join(tmpdir(), "mad-policy-partial-"))
    cleanups.push(() => origin.remove(), () => rm(scratch, { recursive: true, force: true }))
    await setupGit(origin.dir, ["config", "uploadpack.allowFilter", "true"])
    const part = join(scratch, "part")
    await setupGit(scratch, ["clone", "-q", "--no-local", "--filter=blob:none", "--no-checkout", `file://${origin.dir}`, part])
    const log = join(scratch, "fired.log")
    await writeFile(log, "")
    const helper = join(scratch, "upload-pack.sh")
    await writeFile(helper, `#!/bin/sh\necho upload-pack >> '${log}'\nexit 1\n`, { mode: 0o755 })
    await setupGit(part, ["config", "remote.origin.uploadpack", helper])
    return {
      part,
      fired: async () => (await readFile(log, "utf8")).split("\n").filter((l) => l.length > 0),
      reset: () => writeFile(log, ""),
    }
  }

  /** The launcher's own spawn, with `drop` removed from the policy's environment. */
  const without = (...drop: string[]): SpawnBlame => (request) => {
    const env: Record<string, string | undefined> = { ...request.env, PWD: request.cwd }
    for (const key of drop) delete env[key]
    return Bun.spawn({ cmd: request.cmd, cwd: request.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env }) as never
  }

  test(
    "the control's lazy fetch runs the upload-pack helper; MAD's change and blame fail without running it",
    async () => {
      const p = await partialClone()

      // Control: with no checkout, `git diff HEAD` needs every blob and fetches.
      await plainGit(p.part, ["diff", "HEAD"])
      expect(await p.fired()).toContain("upload-pack")
      await p.reset()

      // The preflight passes (no filter is configured), so what fails is the
      // content read itself, on the object it may not fetch.
      const changeError = await opencodeRepo({ worktree: p.part }).change().then(() => undefined, (e: unknown) => e)
      expect(changeError).toBeInstanceOf(GitError)
      expect(changeError).not.toBeInstanceOf(FilterPreflightFailed)
      expect((changeError as Error).message).toStartWith("git diff failed:")
      const blameError = await opencodeTools({ worktree: p.part }).blame("src/pay.ts", 1, 1).then(() => undefined, (e: unknown) => e)
      expect(blameError).toBeInstanceOf(GitError)
      expect((blameError as Error).message).not.toContain("filter preflight")
      expect(await p.fired()).toEqual([])
    },
    TIMEOUT_MS,
  )

  test(
    "each guard alone blocks the fetch on MAD's own reads; with both removed, the same reads run the helper",
    async () => {
      const p = await partialClone()
      const reads = async (spawn: SpawnBlame) => {
        await opencodeRepo({ worktree: p.part, spawn }).change().catch(() => undefined)
        await opencodeTools({ worktree: p.part, spawn }).blame("src/pay.ts", 1, 1).catch(() => undefined)
        const fired = await p.fired()
        await p.reset()
        return fired
      }

      // The control through the same path: neither guard, and the helper runs.
      expect(await reads(without("GIT_NO_LAZY_FETCH", "GIT_ALLOW_PROTOCOL"))).toContain("upload-pack")
      // The empty allowlist alone, as on git older than 2.44.
      expect(await reads(without("GIT_NO_LAZY_FETCH"))).toEqual([])
      // GIT_NO_LAZY_FETCH alone.
      expect(await reads(without("GIT_ALLOW_PROTOCOL"))).toEqual([])
    },
    TIMEOUT_MS,
  )
})

describe("the evaluation harness's compatibility setting", () => {
  test(
    "`inherit` keeps the historical argv and environment and runs no preflight; the default does not",
    async () => {
      const f = await fixture()
      const seen: { cmd: string[]; env: Record<string, string | undefined> | undefined }[] = []
      const recording = (request: { cmd: string[]; cwd: string; env?: Record<string, string | undefined> }) => {
        seen.push({ cmd: request.cmd, env: request.env })
        return Bun.spawn({
          cmd: request.cmd,
          cwd: request.cwd,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          ...(request.env === undefined ? {} : { env: { ...request.env, PWD: request.cwd } }),
        }) as never
      }
      const inherited = await opencodeRepo({ worktree: f.repo.dir, spawn: recording, gitReadPolicy: "inherit" }).change()
      expect(inherited.description).toBe("working tree (git diff HEAD, plus untracked files)")
      expect(seen.map((s) => s.cmd[1])).toEqual(["diff", "diff", "ls-files", "diff"])
      for (const flag of ["--no-color", "--ignore-submodules=dirty", "--submodule=short", "--no-ext-diff"]) {
        expect(seen.some((s) => s.cmd.includes(flag))).toBe(false)
      }
      expect(seen.every((s) => s.cmd[0] === "git" && s.env === undefined)).toBe(true)
      seen.length = 0
      await opencodeTools({ worktree: f.repo.dir, spawn: recording, gitReadPolicy: "inherit" }).blame("src/pay.ts", 1, 1)
      expect(seen).toEqual([{ cmd: ["git", "blame", "-L", "1,1", "--porcelain", "--", "src/pay.ts"], env: undefined }])

      seen.length = 0
      await opencodeRepo({ worktree: f.repo.dir, spawn: recording }).change()
      expect(seen[0]!.cmd).toEqual(readOnlyGitArgv(FILTER_PREFLIGHT))
      expect(seen.every((s) => s.env?.GIT_ALLOW_PROTOCOL === "")).toBe(true)
    },
    TIMEOUT_MS,
  )

  test("`inherit` still refuses an option-shaped target", async () => {
    await expect(opencodeRepo({ worktree: "/nonexistent", gitReadPolicy: "inherit" }).change("--output=/tmp/x")).rejects.toBeInstanceOf(
      ChangeReadRefused,
    )
  })

  test("the three harness construction sites select `inherit`, after any caller spread", async () => {
    const root = join(import.meta.dir, "..", "..")
    const live = await readFile(join(root, "ablation", "live.ts"), "utf8")
    expect(live).toMatch(/opencodeRepo\(\{\s*\.\.\.options\.repo,\s*worktree: [^\n]+,\s*gitReadPolicy: "inherit",\s*\}\)/)
    const adversarial = await readFile(join(root, "ablation", "adversarial.ts"), "utf8")
    expect(adversarial).toMatch(/opencodeTools\(\{\s*\$: input\.shell,\s*worktree,\s*gitReadPolicy: "inherit",/)
    const paired = await readFile(join(root, "scripts", "paired.ts"), "utf8")
    expect(paired).toContain('tools: opencodeTools({ ...options, gitReadPolicy: "inherit" }),')
    // No other production construction site exists outside the plugin.
    const plugin = await readFile(join(root, "adapters", "opencode", "plugin.ts"), "utf8")
    expect(plugin).not.toContain("gitReadPolicy")
  })
})

describe("the shared launcher's environment", () => {
  async function envSeen(env?: Record<string, string | undefined>): Promise<Map<string, string>> {
    const cwd = await mkdtemp(join(tmpdir(), "mad-launcher-env-"))
    cleanups.push(() => rm(cwd, { recursive: true, force: true }))
    const outcome = await runBoundedBlame({
      argv: ["/usr/bin/env"],
      cwd,
      deadlineMs: 10_000,
      cleanupMs: 1_000,
      ...(env === undefined ? {} : { env }),
    })
    if (outcome.kind !== "returned") throw new Error(`env did not return: ${outcome.kind}`)
    const seen = new Map<string, string>()
    for (const line of outcome.stdout.split("\n")) {
      const at = line.indexOf("=")
      if (at > 0) seen.set(line.slice(0, at), line.slice(at + 1))
    }
    seen.set("(cwd)", cwd)
    return seen
  }

  test("a caller that omits `env` gets this process's environment, `PWD` corrected, as before", async () => {
    const seen = await withEnv({ MAD_LAUNCHER_PROBE: "inherited", GIT_DIR: "/kept/for/harness" }, () => envSeen())
    expect(seen.get("MAD_LAUNCHER_PROBE")).toBe("inherited")
    expect(seen.get("GIT_DIR")).toBe("/kept/for/harness")
    expect(seen.get("PWD")).toBe(seen.get("(cwd)"))
  })

  test("a caller that supplies `env` gets exactly that, `PWD` corrected", async () => {
    const seen = await withEnv({ MAD_LAUNCHER_PROBE: "inherited" }, () => envSeen({ ONLY: "this" }))
    expect(seen.get("ONLY")).toBe("this")
    expect(seen.has("MAD_LAUNCHER_PROBE")).toBe(false)
    expect(seen.get("PWD")).toBe(seen.get("(cwd)"))
  })
})

describe("a submodule is reviewed as its commit pointer only", () => {
  const COMMIT = ["-c", "user.name=MAD test", "-c", "user.email=mad@example.invalid", "-c", "commit.gpgsign=false"]

  /**
   * A superproject with one submodule `sub`, whose `f.txt` is under a
   * submodule-local clean filter that records itself, and with
   * `diff.submodule=diff` set in the superproject so plain git renders a
   * pointer change by running git inside the submodule.
   */
  async function submoduleFixture() {
    const f = await fixture()
    const origin = join(f.scratch, "sub-origin")
    await setupGit(f.scratch, ["init", "-q", origin])
    await writeFile(join(origin, "f.txt"), "one\n")
    await writeFile(join(origin, ".gitattributes"), "f.txt filter=probe\n")
    await setupGit(origin, ["add", "f.txt", ".gitattributes"])
    await setupGit(origin, [...COMMIT, "commit", "-q", "--no-verify", "-m", "sub"])
    await setupGit(f.repo.dir, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", origin, "sub"])
    await setupGit(f.repo.dir, [...COMMIT, "commit", "-q", "--no-verify", "-m", "add sub"])
    const sub = join(f.repo.dir, "sub")
    await setupGit(sub, ["config", "filter.probe.clean", await f.sentinel("subclean", "cat")])
    await setupGit(f.repo.dir, ["config", "diff.submodule", "diff"])
    return {
      ...f,
      sub,
      /** Same size, new content: git must hash the file, through the filter, to see it changed. */
      dirty: () => writeFile(join(sub, "f.txt"), "two\n"),
      async advancePointer() {
        await writeFile(join(sub, "g.txt"), "new\n")
        await setupGit(sub, ["add", "g.txt"])
        await setupGit(sub, [...COMMIT, "commit", "-q", "--no-verify", "-m", "advance"])
      },
    }
  }

  test(
    "dirty contents only: the control runs the submodule's filter; MAD runs nothing and reports no submodule change",
    async () => {
      const f = await submoduleFixture()
      await f.dirty()
      await plainGit(f.repo.dir, ["diff", "--ignore-submodules=none", "HEAD"])
      expect(await f.fired()).toContain("subclean")
      await f.dirty()
      await f.reset()

      const read = await change(f.repo.dir)
      expect(read.files).not.toContain("sub")
      expect(read.diff).not.toContain("sub")
      expect(read.description).toBe(
        "working tree (git diff HEAD, plus untracked files; submodules as commit pointers only, their uncommitted contents not read)",
      )
      expect(await f.fired()).toEqual([])
    },
    TIMEOUT_MS,
  )

  test(
    "pointer change only: MAD shows the old and new commit, under diff.submodule=diff, and runs nothing",
    async () => {
      const f = await submoduleFixture()
      await f.advancePointer()
      await f.reset()

      const read = await change(f.repo.dir)
      expect(read.files).toContain("sub")
      expect(read.diff).toMatch(/-Subproject commit [0-9a-f]{40}\n\+Subproject commit [0-9a-f]{40}\n/)
      expect(read.diff).not.toContain("g.txt")
      expect(await f.fired()).toEqual([])
    },
    TIMEOUT_MS,
  )

  test(
    "pointer change and dirty contents: the pointer is shown, the contents are not inspected",
    async () => {
      const f = await submoduleFixture()
      await f.advancePointer()
      await f.dirty()
      await f.reset()

      const read = await change(f.repo.dir)
      expect(read.files).toContain("sub")
      expect(read.diff).toMatch(/\+Subproject commit [0-9a-f]{40}\n/)
      expect(read.diff).not.toContain("-dirty")
      expect(read.diff).not.toContain("f.txt")
      expect(await f.fired()).toEqual([])
    },
    TIMEOUT_MS,
  )
})
