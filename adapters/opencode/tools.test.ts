/**
 * Adapter gates for the `Tools` port (story 10, CAP-8, AD-13's first route).
 *
 * Driven through the `options.$` seam with the same hand-written shell fake
 * `repo.test.ts` uses, and the distinction that matters is the same one: a git
 * FAILURE and a genuinely empty result look identical downstream unless this
 * layer separates them. `.nothrow()` is what makes them identical, and reading
 * `exitCode` is what pulls them apart — so a failed blame reaches the judge as a
 * throw it reports under AD-6, never as an empty string the judge would read as
 * "the history contradicts nothing".
 */

import { describe, expect, test } from "bun:test"

import { GitError } from "./repo.ts"
import { NotDrivenError, opencodeTools } from "./tools.ts"

interface ShellReply {
  stdout?: string
  stderr?: string
  exitCode?: number
}

/** Matches on a substring of the assembled command, first match wins. */
function fakeShell(replies: { match: string; reply: ShellReply }[]) {
  const commands: string[] = []

  const $: any = (strings: TemplateStringsArray, ...expressions: unknown[]) => {
    const command = strings.raw
      .map((chunk, index) => chunk + (index < expressions.length ? renderArg(expressions[index]) : ""))
      .join("")
    commands.push(command)

    const hit = replies.find((r) => command.includes(r.match))
    const reply = hit?.reply ?? { stdout: "", exitCode: 0 }
    return Promise.resolve({
      stdout: Buffer.from(reply.stdout ?? ""),
      stderr: Buffer.from(reply.stderr ?? ""),
      exitCode: reply.exitCode ?? 0,
    })
  }
  $.cwd = () => $
  $.nothrow = () => $
  $.env = () => $

  /**
   * ARGV IS JOINED WITH A SEPARATOR NO ARGUMENT CAN CONTAIN.
   *
   * `repo.test.ts` joins on a space, which is right for its assertions and wrong
   * for this file's: the whole point here is that a path with a space in it is
   * ONE argv element, and a space-joined render cannot tell that apart from two
   * elements. `\0` cannot appear in an argv element at all, so a split on it
   * recovers the real boundaries.
   */
  function renderArg(value: unknown): string {
    return Array.isArray(value) ? value.join("\0") : String(value)
  }

  return { $, commands }
}

/**
 * The rejection a call produced, as an `Error`.
 *
 * `.catch((e) => e as Error)` types the result as `string | Error` — the union
 * of the resolved value and the caught one — so reading `.message` off it does
 * not compile. Rethrowing on RESOLUTION also keeps the test honest: a `blame`
 * that unexpectedly succeeds fails here rather than reading `.message` off a
 * string and reporting a confusing mismatch two lines later.
 */
function rejection(call: Promise<unknown>): Promise<Error> {
  return call.then(
    () => {
      throw new Error("expected a rejection, but the call resolved")
    },
    (error: unknown) => error as Error,
  )
}

/** The argv the one recorded `git` call was given, boundaries intact. */
function argvOf(command: string): string[] {
  return command.replace(/^git /, "").split("\0")
}

const PORCELAIN =
  "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 12 12 1\n" +
  "author Ada Lovelace\n" +
  "author-mail <ada@example.com>\n" +
  "author-time 1709337600\n" +
  "author-tz +0000\n" +
  "summary handle the empty-cart case\n" +
  "filename src/pay.ts\n" +
  "\tif (items.length === 0) return 0\n"

describe("opencodeTools.blame", () => {
  test("runs `git blame -L <start>,<end> --porcelain -- <path>` and returns its stdout", async () => {
    const { $, commands } = fakeShell([{ match: "blame", reply: { stdout: PORCELAIN } }])

    const out = await opencodeTools({ $, worktree: "/repo" }).blame("src/pay.ts", 12, 12)

    expect(out).toBe(PORCELAIN)
    expect(commands).toHaveLength(1)
    expect(argvOf(commands[0]!)).toEqual([
      "blame",
      "-L",
      "12,12",
      "--porcelain",
      "--",
      "src/pay.ts",
    ])
  })

  test("THE PATH IS ITS OWN ARGV ELEMENT, after `--`, however hostile it is", async () => {
    // `Finding.locus.file` is validated only as a non-empty string
    // (`core/stages/judge.ts`), so it is a discovery model's free text. It may
    // look like a flag, may carry a space, a quote, a semicolon or a `$(...)`.
    // None of that may reach a shell as syntax, and `--` is what stops the
    // flag-shaped case being consumed as an option.
    const hostile = "src/--output=x; rm -rf $(pwd) 'a b'.ts"
    const { $, commands } = fakeShell([{ match: "blame", reply: { stdout: PORCELAIN } }])

    await opencodeTools({ $, worktree: "/repo" }).blame(hostile, 1, 3)

    const argv = argvOf(commands[0]!)
    // ONE element, byte-for-byte, and it is the LAST one — everything before it
    // is MAD's own literal argv.
    expect(argv.at(-1)).toBe(hostile)
    expect(argv.indexOf("--")).toBe(argv.length - 2)
    expect(argv.filter((part) => part.includes("rm -rf"))).toHaveLength(1)
  })

  test("A NON-ZERO EXIT THROWS — it never degrades into empty output", async () => {
    // The failure this whole file exists for. `.nothrow()` hands back
    // `{ stdout: "", exitCode: 128 }` for a path git has never heard of, and an
    // adapter that returned that empty string would have the judge read "no
    // contradiction found" off a command that never ran. T4.
    const { $ } = fakeShell([
      {
        match: "blame",
        reply: { exitCode: 128, stderr: "fatal: no such path 'nope.ts' in HEAD\n" },
      },
    ])

    const call = opencodeTools({ $, worktree: "/repo" }).blame("nope.ts", 1, 2)
    await expect(call).rejects.toThrow(GitError)
    await expect(call).rejects.toThrow("no such path")
  })

  test("the GitError names the command, so the judge's warning can quote it", async () => {
    const { $ } = fakeShell([{ match: "blame", reply: { exitCode: 128, stderr: "fatal: bad file\n" } }])
    const error = await rejection(opencodeTools({ $, worktree: "/repo" }).blame("x.ts", 1, 1))
    expect(error.message).toStartWith("git blame failed:")
  })

  test("a stderr-less failure still says something (`repo.ts`'s wording, shared)", async () => {
    const { $ } = fakeShell([{ match: "blame", reply: { exitCode: 1 } }])
    const error = await rejection(opencodeTools({ $, worktree: "/repo" }).blame("x.ts", 1, 1))
    expect(error.message).toContain("git reported no detail")
  })

  test("A BAD RANGE IS REFUSED BEFORE THE SHELL, and reads as MAD's fault not the repo's", async () => {
    // Reversed, zero-based, fractional and non-finite ranges are caller bugs.
    // Git would reject most of them in its own wording, which a user reads as a
    // problem with their repository. Same error type either way, so the judge's
    // one catch reports all of them under AD-6.
    const { $, commands } = fakeShell([{ match: "blame", reply: { stdout: PORCELAIN } }])
    const tools = opencodeTools({ $, worktree: "/repo" })

    for (const [start, end] of [
      [5, 2],
      [0, 3],
      [1.5, 3],
      [Number.NaN, 3],
      [1, Number.POSITIVE_INFINITY],
    ] as const) {
      await expect(tools.blame("src/pay.ts", start, end)).rejects.toThrow(GitError)
    }
    // AND NOTHING RAN. A refusal that still spawned git would be a refusal in
    // name only.
    expect(commands).toHaveLength(0)
  })

  test("the shell is scoped to the worktree and to `.nothrow()`, exactly as `repo.ts` does", async () => {
    const calls: string[] = []
    const { $ } = fakeShell([{ match: "blame", reply: { stdout: PORCELAIN } }])
    const inner = $
    const wrapper: any = (...args: unknown[]) => inner(...(args as [TemplateStringsArray]))
    wrapper.cwd = (dir: string) => {
      calls.push(`cwd:${dir}`)
      return wrapper
    }
    wrapper.nothrow = () => {
      calls.push("nothrow")
      return wrapper
    }

    await opencodeTools({ $: wrapper, worktree: "/repo" }).blame("src/pay.ts", 1, 1)
    expect(calls).toEqual(["cwd:/repo", "nothrow"])
  })
})

describe("the four undriven methods (scope discipline, story 10)", () => {
  test("each throws a NAMED error rather than returning a plausible empty answer", async () => {
    const { $, commands } = fakeShell([])
    const tools = opencodeTools({ $, worktree: "/repo" })

    // A stub returning `""` / `[]` / `{ exitCode: 0 }` would be a wrong answer a
    // reader believes. A named failure is one a test catches.
    //
    // REJECTIONS, NOT SYNCHRONOUS THROWS (code review 2026-09-09). These methods
    // are declared to return a `Promise`, and a synchronous throw from one skips
    // the caller's `.catch()` entirely — so this test asserted the very shape
    // that made `tools.grep(x).catch(handle)` fail to reach `handle`. Asserting
    // rejection is what pins the fix.
    await expect(tools.readFile("src/pay.ts")).rejects.toThrow(NotDrivenError)
    await expect(tools.list("**/*.ts")).rejects.toThrow(NotDrivenError)
    await expect(tools.grep("fee")).rejects.toThrow(NotDrivenError)
    await expect(tools.runTest()).rejects.toThrow(NotDrivenError)

    // And the promise chain is intact: a caller may handle it the ordinary way.
    const handled = await tools.grep("fee").catch((error: unknown) => error)
    expect(handled).toBeInstanceOf(NotDrivenError)
    // AND NONE OF THEM RAN A COMMAND. `runTest` in particular is the one with a
    // real permission surface (`host-integration.md`), and this is the assertion
    // that it executes nothing at all until a story drives it.
    expect(commands).toEqual([])
  })

  test("the message names the method and says it is a story, not a patch", async () => {
    const { $ } = fakeShell([])
    const tools = opencodeTools({ $, worktree: "/repo" })
    // `rejection`, not a try/catch around a synchronous call — see the note in
    // the test above. The old shape passed only because the method threw before
    // returning its promise, which was the defect.
    const error = await rejection(tools.runTest("pay"))
    expect(error.message).toContain("Tools.runTest")
    expect(error.message).toContain("blame() only")
  })
})

describe("T6 / AD-16 — read-only BY CONSTRUCTION, asserted structurally", () => {
  test("the module contains no write path of any kind", async () => {
    // The same shape `ablation/seeded-defects.test.ts` uses for "the ablation
    // writes nothing": read the module text and assert the absence, because a
    // behavioural test can only prove the paths it happens to exercise. AD-16 is
    // an absolute — MAD never writes to the user's repo — and an absolute is
    // worth a structural assertion.
    const source = await Bun.file(new URL("./tools.ts", import.meta.url)).text()

    for (const writer of ["node:fs", "Bun.write", "writeFile", "mkdir", "rmdir", "rm(", "unlink"]) {
      expect(source, `${writer} is a write path and must not appear`).not.toContain(writer)
    }
    // And no git subcommand that mutates a repository. `git blame` is the only
    // git this file may run.
    for (const mutating of [
      "git add",
      "git commit",
      "git checkout",
      "git apply",
      "git reset",
      "git clean",
      "git stash",
      "git push",
      "git fetch",
      "git merge",
      "git rebase",
      // The quoted forms, because this adapter builds its argv as an ARRAY of
      // string literals rather than as a command line — `["blame", ...]` — so a
      // mutating verb would appear quoted and none of the `git x` probes above
      // would see it.
      '"add"',
      '"commit"',
      '"checkout"',
      '"apply"',
      '"reset"',
      '"restore"',
      '"clean"',
      '"stash"',
      '"push"',
      '"switch"',
      '"worktree"',
    ]) {
      expect(source, `${mutating} mutates a repository and must not appear`).not.toContain(mutating)
    }
  })

  test("the only git subcommand in the argv is `blame`", async () => {
    // Complements the grep above from the other side: rather than listing the
    // verbs that are forbidden, assert the one that is allowed, by running the
    // one driven method and reading what it asked for.
    const { $, commands } = fakeShell([{ match: "blame", reply: { stdout: PORCELAIN } }])
    await opencodeTools({ $, worktree: "/repo" }).blame("src/pay.ts", 1, 4)
    expect(commands).toHaveLength(1)
    expect(argvOf(commands[0]!)[0]).toBe("blame")
  })

  test("it builds no material span — the CORE frames, the adapter executes (AD-1/AD-18)", async () => {
    // `scripts/lint-material-spans.ts` scans `adapters/` and would fail the
    // build on a fence here, so this is belt and braces — but it states the
    // SPLIT, which the lint cannot: this file returns raw repository text and
    // `core/prompt/material.ts` is what wraps it.
    const source = await Bun.file(new URL("./tools.ts", import.meta.url)).text()
    expect(source).not.toContain("material(")
    expect(source).not.toContain("MaterialLabel")
  })

})
