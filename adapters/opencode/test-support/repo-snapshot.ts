/**
 * Temporary review repositories for the offline acceptance suite (CAP-1), and
 * the repository snapshot it compares before and after each scenario.
 *
 * The snapshot itself, and what it records, live in `scripts/repo-state.ts`,
 * which the live before/after check (`scripts/live-check.ts`) shares. This
 * module re-exports it and keeps the fixture helpers.
 *
 * Every git call here, fixture setup and snapshot alike, runs with the user's
 * global and system git config switched off, so a developer's hooks, templates
 * or `core.fsmonitor` cannot change what a fixture is. The plugin's own git
 * calls are not isolated this way; what they inherit is CAP-2's concern.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { differences, ISOLATED_GIT_ENV, type Snapshot } from "../../../scripts/repo-state.ts"

export { differences, readGit, snapshot, type Snapshot } from "../../../scripts/repo-state.ts"

/** Run git in `cwd` for fixture setup, and fail loudly if it fails. */
export async function setupGit(cwd: string, argv: string[]): Promise<void> {
  const child = Bun.spawn({
    cmd: ["git", ...argv],
    cwd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, ...ISOLATED_GIT_ENV },
  })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`fixture git ${argv.join(" ")} failed: ${stderr}`)
}

const COMMIT_FLAGS = [
  "-c", "user.name=MAD test",
  "-c", "user.email=mad@example.invalid",
  "-c", "commit.gpgsign=false",
  // No detached maintenance races the directory's removal (#138); fixture only.
  "-c", "maintenance.auto=false",
  "-c", "gc.auto=0",
]

export interface ReviewRepo {
  readonly dir: string
  remove(): Promise<void>
}

/**
 * A committed repository holding `src/pay.ts`. `dirty` adds an uncommitted edit
 * to it and an untracked `notes.txt`; otherwise the tree is clean. A failed
 * setup removes the directory before rethrowing.
 */
export async function makeReviewRepo(options: { dirty: boolean }): Promise<ReviewRepo> {
  const dir = await mkdtemp(join(tmpdir(), "mad-acceptance-repo-"))
  const remove = () => rm(dir, { recursive: true, force: true })
  try {
    await setupGit(dir, ["init", "-q"])
    await mkdir(join(dir, "src"))
    await writeFile(join(dir, "src", "pay.ts"), "export const fee = (total: number) => total * 0.1\n")
    await setupGit(dir, ["add", "src/pay.ts"])
    await setupGit(dir, [...COMMIT_FLAGS, "commit", "-q", "--no-verify", "-m", "base"])
    if (options.dirty) {
      await writeFile(join(dir, "src", "pay.ts"), "export const fee = (total: number) => total * 0.01\n")
      await writeFile(join(dir, "notes.txt"), "untracked scratch\n")
    }
  } catch (error) {
    await remove()
    throw error
  }
  return { dir, remove }
}

/**
 * The differences outside `.git`. For the snapshot's own self-tests, where a
 * fixture step deliberately writes git's bookkeeping (objects, reflogs).
 */
export function worktreeDifferences(before: Snapshot, after: Snapshot): string[] {
  return differences(before, after).filter((line) => !/^(removed|changed|added) "\.git(\/|")/.test(line))
}
