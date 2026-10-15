/**
 * Test fixture: a committed one-file git repository, read through a
 * `RunCommand` that ignores the user's and the system's git config. The
 * launcher tests use it to run the real code revision reader on a checkout
 * that starts clean.
 */

import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { RunCommand } from "./bundle.ts"

export interface CleanRepo {
  repo: string
  /** Runs a command in `repo` with no user or system git config. */
  gitIn: RunCommand
  /** Runs git in `repo` and returns its stdout; a non-zero exit throws. */
  sh: (...args: string[]) => Promise<string>
  /** The one commit's id. */
  head: string
}

/** Initializes `repo` (an existing empty directory), commits one file and checks that the status is empty. */
export async function cleanTempRepo(repo: string): Promise<CleanRepo> {
  const gitIn: RunCommand = async (command, args) => {
    const spawned = Bun.spawn([command, ...args], {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([new Response(spawned.stdout).text(), new Response(spawned.stderr).text()])
    return { exitCode: await spawned.exited, stdout, stderr }
  }
  const sh = async (...args: string[]) => {
    const result = await gitIn("git", args)
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
    return result.stdout
  }
  await sh("init", "-q", "-b", "main")
  await writeFile(join(repo, "README"), "clean\n")
  await sh("add", "README")
  await sh("-c", "user.email=test@example.invalid", "-c", "user.name=test", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init")
  const head = (await sh("rev-parse", "HEAD")).trim()
  const status = await sh("status", "--porcelain", "--untracked-files=all")
  if (status !== "") throw new Error(`the new repository is not clean: ${JSON.stringify(status)}`)
  return { repo, gitIn, sh, head }
}
