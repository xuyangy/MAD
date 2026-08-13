/**
 * Adapter tests for the `Repo` port, driven through the `options.$` seam with a
 * hand-written shell fake. The distinction that matters: a git FAILURE and a
 * genuinely EMPTY diff look identical downstream unless this layer separates
 * them, and "nothing to review" is the message a bad ref used to produce.
 */

import { describe, expect, test } from "bun:test"

import { GitError, opencodeRepo } from "./repo.ts"

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

  function renderArg(value: unknown): string {
    return Array.isArray(value) ? value.join(" ") : String(value)
  }

  return { $, commands }
}

const DIFF = "--- a/src/pay.ts\n+++ b/src/pay.ts\n@@ -1 +1 @@\n-a\n+b\n"

describe("opencodeRepo.change", () => {
  test("reads the working-tree diff and the files it touches", async () => {
    const { $, commands } = fakeShell([
      { match: "--name-only", reply: { stdout: "src/pay.ts\nsrc/fee.ts\n" } },
      { match: "ls-files", reply: { stdout: "" } },
      { match: "diff", reply: { stdout: DIFF } },
    ])

    const change = await opencodeRepo({ $, worktree: "/repo" }).change()
    expect(change.diff).toContain("+b")
    expect(change.files).toEqual(["src/pay.ts", "src/fee.ts"])
    expect(commands.some((c) => c.includes("HEAD"))).toBe(true)
  })

  test("a git FAILURE is an error, not an empty diff", async () => {
    // Before this, a bad ref exited non-zero, `.nothrow()` swallowed it, and the
    // plugin reported "nothing to review" — a silent pass for a broken command.
    const { $ } = fakeShell([
      {
        match: "diff",
        reply: { exitCode: 128, stderr: "fatal: bad revision 'nope...HEAD'\n" },
      },
    ])

    const change = opencodeRepo({ $, worktree: "/repo" }).change("nope...HEAD")
    await expect(change).rejects.toThrow(GitError)
    await expect(change).rejects.toThrow("bad revision")
  })

  test("a genuinely empty diff is empty, and is NOT an error", async () => {
    const { $ } = fakeShell([{ match: "git", reply: { stdout: "", exitCode: 0 } }])
    const change = await opencodeRepo({ $, worktree: "/repo" }).change()
    expect(change.diff).toBe("")
    expect(change.files).toEqual([])
  })

  test("untracked files are included — `git diff HEAD` cannot see them", async () => {
    // A change made entirely of new files would otherwise review as empty, the
    // worst possible silent failure for a review tool.
    const { $ } = fakeShell([
      { match: "--name-only", reply: { stdout: "" } },
      { match: "ls-files", reply: { stdout: "src/brand-new.ts\n" } },
      { match: "--no-index", reply: { stdout: "+++ b/src/brand-new.ts\n+new file body\n", exitCode: 1 } },
      { match: "diff", reply: { stdout: "" } },
    ])

    const change = await opencodeRepo({ $, worktree: "/repo" }).change()
    expect(change.diff).toContain("brand-new.ts")
    expect(change.files).toEqual(["src/brand-new.ts"])
  })

  test("an explicit ref range does not go looking for untracked files", async () => {
    const { $, commands } = fakeShell([
      { match: "--name-only", reply: { stdout: "src/pay.ts\n" } },
      { match: "diff", reply: { stdout: DIFF } },
    ])

    const change = await opencodeRepo({ $, worktree: "/repo" }).change("main...HEAD")
    expect(change.description).toContain("main...HEAD")
    expect(commands.some((c) => c.includes("ls-files"))).toBe(false)
  })

  test("the target is passed as a revision, terminated so it cannot be read as a flag", async () => {
    const { $, commands } = fakeShell([{ match: "git", reply: { stdout: DIFF } }])
    await opencodeRepo({ $, worktree: "/repo" }).change("--output=/tmp/pwned")

    const diffCommand = commands.find((c) => c.includes("--output=/tmp/pwned"))!
    expect(diffCommand).toContain("--")
    // The value lands before the `--` terminator, i.e. in revision position.
    expect(diffCommand.indexOf("--output=/tmp/pwned")).toBeLessThan(diffCommand.lastIndexOf("--"))
  })

  test("root() is the worktree the loci are relative to", () => {
    const { $ } = fakeShell([])
    expect(opencodeRepo({ $, worktree: "/repo" }).root()).toBe("/repo")
  })
})
