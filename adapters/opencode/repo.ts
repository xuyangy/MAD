/**
 * The `Repo` port over opencode's host shell. Read-only: MAD never writes to
 * the user's repo (AD-16).
 */

import type { PluginInput } from "@opencode-ai/plugin"

import type { ChangeSet, Repo } from "../../core/ports/repo.ts"

type Shell = PluginInput["$"]

export interface OpencodeRepoOptions {
  $: Shell
  worktree: string
}

/**
 * `target` is host syntax passed straight to git: a ref range (`main...HEAD`),
 * a commit, or omitted for the working tree plus the index.
 */
export class GitError extends Error {
  constructor(command: string, stderr: string) {
    super(`${command} failed: ${stderr.trim() || "git reported no detail"}`)
    this.name = "GitError"
  }
}

export function opencodeRepo(options: OpencodeRepoOptions): Repo {
  const $ = options.$.cwd(options.worktree).nothrow()

  /**
   * `.nothrow()` keeps a non-zero exit from throwing, which is what we want for
   * control — but silence is not. A bad ref, a repo with no commits, or "not a
   * git repository" must not degrade into an empty diff that the plugin then
   * reports as "nothing to review". Read the exit code and say what happened.
   */
  async function git(command: string, argv: string[]): Promise<string> {
    const result = await $`git ${argv}`
    if (result.exitCode !== 0) throw new GitError(command, result.stderr.toString())
    return result.stdout.toString()
  }

  return {
    root: () => options.worktree,

    async change(target?: string): Promise<ChangeSet> {
      // `--` terminates option parsing, so a target shaped like a flag is
      // treated as a revision and rejected by git rather than consumed by it.
      const range = target ? [target, "--"] : ["HEAD", "--"]
      const description = target
        ? `git diff ${target}`
        : "working tree (git diff HEAD, plus untracked files)"

      const diff = await git("git diff", ["diff", "--unified=8", ...range])
      const nameOnly = await git("git diff --name-only", ["diff", "--name-only", ...range])

      const files = nameOnly
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)

      // `git diff` cannot see untracked files, so a change made entirely of new
      // files would review as empty — the worst possible silent failure for a
      // review tool. Only the working-tree path has untracked files to find; an
      // explicit ref range is history and by definition has none.
      let untrackedDiff = ""
      if (!target) {
        const untracked = (await git("git ls-files", ["ls-files", "--others", "--exclude-standard"]))
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)

        for (const file of untracked) {
          // `--no-index` against /dev/null renders a new file as a normal diff.
          // It exits 1 whenever the files differ, which here is always, so this
          // one call reads stdout directly instead of going through `git()`.
          const result = await $`git diff --unified=8 --no-index -- /dev/null ${file}`
          untrackedDiff += result.stdout.toString()
          files.push(file)
        }
      }

      return { description, files, diff: diff + untrackedDiff }
    },
  }
}
