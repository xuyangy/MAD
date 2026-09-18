/**
 * Story 2-7b — write one side of one adversarial case onto disk as a real git
 * worktree: the case's base tree committed once, then the side's diff applied
 * and left UNCOMMITTED, the shape `scripts/materialize-labelled-change.ts`
 * writes for the labelled change.
 *
 * ## The import list is the argument
 *
 * This module imports no fixture at all. The runner hands it a base tree and a
 * `ChangeSet`; it never sees `fixtures/adversarial/assertions.ts` or the seal
 * that reads it. `adversarial-materialize.test.ts` checks the import list and
 * that a written worktree holds no label id, summary or predicate.
 *
 * ## Git is isolated from the operator's configuration
 *
 * Every git call runs with the operator's global and system config switched
 * off, with no hooks, no line-ending conversion and no template, and with every
 * `GIT_*` variable removed from its environment (`GIT_DIR`, `GIT_WORK_TREE`,
 * `GIT_INDEX_FILE` and the rest can redirect a command into another
 * repository). The commit skips hooks. A base-tree key under `.git/` is
 * refused, so the tree can never write git's own files.
 *
 * ## Containment is not decided here
 *
 * The runner checks every worktree against the adversarial bundle root with the
 * shared AD-16 checks (`refusalFor`, `realRefusalFor`) before and after this
 * writes it, so the directory layout is never taken as proof of containment.
 */

import { mkdir, readdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"

import type { ChangeSet } from "../core/ports/repo.ts"

export interface GitResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** Injected so a test can observe the calls; defaults to real `git`. */
export type RunGit = (cwd: string, args: readonly string[], stdin?: string) => Promise<GitResult>

/** A deterministic author and no signing, so a base commit never depends on the operator's config. */
const GIT_IDENTITY = ["-c", "user.name=MAD fixture", "-c", "user.email=fixture@mad.invalid", "-c", "commit.gpgsign=false"]

/** Options every git call gets: no hooks, no line-ending conversion. */
export const GIT_ISOLATION = ["-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false"]

/**
 * The environment every git call gets: the caller's, with every `GIT_*`
 * variable removed, and the global and system config switched off.
 */
export function isolatedGitEnv(base: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !key.startsWith("GIT_")) env[key] = value
  }
  env.GIT_CONFIG_NOSYSTEM = "1"
  env.GIT_CONFIG_GLOBAL = "/dev/null"
  return env
}

export const spawnGit: RunGit = async (cwd, args, stdin) => {
  try {
    const spawned = Bun.spawn(["git", ...GIT_ISOLATION, ...args], {
      cwd,
      env: isolatedGitEnv(),
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([new Response(spawned.stdout).text(), new Response(spawned.stderr).text()])
    return { exitCode: await spawned.exited, stdout, stderr }
  } catch (error) {
    return { exitCode: 127, stdout: "", stderr: `\`git\` could not be run: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export interface MaterializeSideInput {
  /** Absolute; must not exist yet, or be an empty directory. */
  directory: string
  baseTree: Readonly<Record<string, string>>
  change: ChangeSet
  git?: RunGit
}

export type Materialized = { ok: true; directory: string } | { ok: false; reason: string }

/** Write the base tree, commit it, apply the change uncommitted. Never throws. */
export async function materializeSide(input: MaterializeSideInput): Promise<Materialized> {
  const git = input.git ?? spawnGit
  try {
    if (!isAbsolute(input.directory)) return { ok: false, reason: `the worktree \`${input.directory}\` is not an absolute path` }
    const root = resolve(input.directory)
    for (const path of Object.keys(input.baseTree)) {
      const target = resolve(root, path)
      if (isAbsolute(path) || !target.startsWith(root + sep)) {
        return { ok: false, reason: `the base tree path \`${path}\` resolves outside \`${root}\`` }
      }
      if (target.slice(root.length + 1).split(sep)[0]!.toLowerCase() === ".git") {
        return { ok: false, reason: `the base tree path \`${path}\` lies under \`.git/\`, which only git writes` }
      }
    }
    const existing = await readdir(root).catch(() => undefined)
    if (existing !== undefined && existing.length > 0) {
      return { ok: false, reason: `\`${root}\` already exists and is not empty; a worktree is written fresh, never merged into` }
    }
    await mkdir(root, { recursive: true, mode: 0o700 })
    for (const [path, contents] of Object.entries(input.baseTree)) {
      const file = join(root, path)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, contents, "utf8")
    }
    const steps: { label: string; args: string[]; stdin?: string }[] = [
      { label: "git init", args: ["init", "--quiet", "--template=", "--initial-branch=base"] },
      // The operator's global excludes must not hide a file of the change.
      { label: "git config core.excludesFile", args: ["config", "core.excludesFile", join(root, ".git", "no-global-excludes")] },
      { label: "git add", args: ["add", "--all"] },
      { label: "git commit", args: [...GIT_IDENTITY, "commit", "--quiet", "--no-verify", "--message", "base tree, before the change"] },
      { label: "git apply", args: ["apply", "--whitespace=nowarn", "-"], stdin: input.change.diff },
    ]
    for (const step of steps) {
      const result = await git(root, step.args, step.stdin)
      if (result.exitCode !== 0) {
        return {
          ok: false,
          reason: `\`${step.label}\` failed in \`${root}\`: ${result.stderr.trim() || result.stdout.trim() || "git reported no detail"}`,
        }
      }
    }
    return { ok: true, directory: root }
  } catch (error) {
    return { ok: false, reason: `the worktree could not be written: ${error instanceof Error ? error.message : String(error)}` }
  }
}
