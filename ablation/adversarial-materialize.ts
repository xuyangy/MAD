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
 * repository). The commit skips hooks. A base-tree key with a `.git`
 * component at any depth is refused, so the tree can never write git's own
 * files or plant a nested repository.
 *
 * ## Every git call is bounded, and a call that did not return says so
 *
 * Every git call runs through `runBoundedBlame` (`adapters/opencode/blame-exec.ts`),
 * the launcher `git blame` uses, so "confirmed" means one thing in this tree,
 * and it is three things: the direct child was reaped, its stdout reached EOF,
 * and its stderr reached EOF. The pipes count because a descendant that
 * inherited one keeps it open after the child is gone. The launcher races the
 * pipes and the exit against the deadline as one; it never awaits a pipe
 * before the exit.
 *
 * - **Deadline.** `GIT_TIMEOUT_MS` of nominal execution, then SIGKILL at once,
 *   with no graceful period: a worktree is disposable and never reused, so a
 *   torn repository only ever fails its own slot.
 * - **Cleanup budget.** `GIT_CLEANUP_TIMEOUT_MS` more to account for the child
 *   and its pipes. Both are event-loop deadlines measured by `setTimeout`, not a
 *   guaranteed wall-clock maximum.
 * - **No status is synthesized.** A call that returned carries git's own exit
 *   code. One that did not is a `GitNotReturned` with `exitCode: null`, a reason
 *   and its `termination`: `not-started` (refused or launch-failed),
 *   `confirmed`, or `unconfirmed` (the process, or something that inherited a
 *   pipe, may still be running). `materializeSide` reports an `unconfirmed`
 *   call as `terminationUnconfirmed`, and the runner quarantines on it.
 * - **Known limit, carried over from the launcher.** A descendant that closed
 *   the inherited pipes is not seen. No process group is killed and no
 *   descendant is hunted.
 *
 * A worktree whose git did not return is left where it is and is never
 * reviewed. Where that git's termination is unconfirmed, it may still be
 * writing there. A later write into the same directory is refused only if the
 * directory is not empty, which this module checks and does not assume.
 *
 * ## Containment is not decided here
 *
 * The runner checks every worktree against the adversarial bundle root with the
 * shared AD-16 checks (`refusalFor`, `realRefusalFor`) before and after this
 * writes it, so the directory layout is never taken as proof of containment.
 */

import { mkdir, readdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"

import { deadlineProblem } from "../core/ports/observation-wait.ts"
import { runBoundedBlame, type BlameExecOutcome, type SpawnBlame, type SpawnedBlame } from "../adapters/opencode/blame-exec.ts"
import type { ChangeSet } from "../core/ports/repo.ts"

/** A git call that returned: its own status, never a synthesized one. */
export interface GitResult {
  exitCode: number
  stdout: string
  stderr: string
  /** The terminating signal the OS reported, when there was one. */
  signal?: string | null
  /** MAD's reason it could not read git's stderr, kept apart from it. Never something git said. */
  stderrFailure?: string | null
}

/**
 * Whether a git call that did not return was accounted for. `not-started`:
 * nothing was launched. `confirmed`: the child was reaped and both pipes reached
 * EOF. `unconfirmed`: it, or something that inherited a pipe, may still be running.
 */
export type GitTermination = "not-started" | "confirmed" | "unconfirmed"

/** A git call that did not return. It has no exit code. */
export interface GitNotReturned {
  exitCode: null
  reason: string
  termination: GitTermination
}

export type GitOutcome = GitResult | GitNotReturned

/** Injected so a test can observe the calls; defaults to real `git`. */
export type RunGit = (cwd: string, args: readonly string[], stdin?: string) => Promise<GitOutcome>

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

/** Nominal execution of one git call. At this point the child is sent SIGKILL. */
export const GIT_TIMEOUT_MS = 60_000

/** How long after the kill MAD waits to account for the child and its pipes. */
export const GIT_CLEANUP_TIMEOUT_MS = 5_000

/** How one git process is started: the launcher's request plus this call's standard input. */
export type SpawnGit = (request: { cmd: string[]; cwd: string; stdin: Uint8Array | "ignore" }) => SpawnedBlame

/**
 * `Bun.spawn` with the isolated environment, `PWD` matching the working
 * directory, and piped output.
 *
 * `PWD` is set because `posix_spawn` sets the working directory without
 * touching `PWD`, so the child would otherwise be handed the parent's `PWD`
 * while running somewhere else; `blame-exec.ts`'s default spawn makes the same
 * repair.
 */
export const isolatedSpawn: SpawnGit = (request) =>
  Bun.spawn({
    cmd: request.cmd,
    cwd: request.cwd,
    env: { ...isolatedGitEnv(), PWD: request.cwd },
    stdin: request.stdin,
    stdout: "pipe",
    stderr: "pipe",
  }) as unknown as SpawnedBlame

export interface BoundedGitOptions {
  /** Test seam. Defaults to `isolatedSpawn`. */
  spawn?: SpawnGit
  /** Defaults to `GIT_TIMEOUT_MS`. */
  deadlineMs?: number
  /** Defaults to `GIT_CLEANUP_TIMEOUT_MS`. */
  cleanupMs?: number
}

/** A `RunGit` over the bounded launcher, with the isolation options on every call. */
export function boundedGit(options: BoundedGitOptions = {}): RunGit {
  const spawn = options.spawn ?? isolatedSpawn
  const deadlineMs = options.deadlineMs ?? GIT_TIMEOUT_MS
  const cleanupMs = options.cleanupMs ?? GIT_CLEANUP_TIMEOUT_MS
  return async (cwd, args, stdin) => {
    const command = `git ${args.join(" ")}`
    // Checked here, under this module's own names, so a refusal never reads as
    // the launcher's. Nothing is launched and no process id exists.
    for (const [name, ms] of [
      ["the materializer git deadline", deadlineMs],
      ["the materializer git cleanup budget", cleanupMs],
    ] as const) {
      const problem = deadlineProblem(name, ms)
      if (problem !== null) return { exitCode: null, termination: "not-started", reason: `\`${command}\` was not launched: ${problem}` }
    }
    const input = stdin === undefined ? ("ignore" as const) : new TextEncoder().encode(stdin)
    const spawnWithInput: SpawnBlame = (request) => spawn({ ...request, stdin: input })
    const outcome = await runBoundedBlame({
      argv: ["git", ...GIT_ISOLATION, ...args],
      cwd,
      deadlineMs,
      cleanupMs,
      spawn: spawnWithInput,
    })
    return gitOutcomeOf(command, outcome)
  }
}

/** Every git call this module makes by default. */
export const spawnGit: RunGit = boundedGit()

/** A process id, named only when the spawn handle established one. */
function processOf(pid: number): string {
  return pid > 0 ? `process ${pid}` : "a process whose id the spawn handle did not give"
}

/** The launcher's outcome as a `GitOutcome`. A call that did not return gets no exit code. */
export function gitOutcomeOf(command: string, outcome: BlameExecOutcome): GitOutcome {
  switch (outcome.kind) {
    case "returned":
      return {
        exitCode: outcome.exitCode,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        signal: outcome.signal,
        stderrFailure: outcome.stderrFailure,
      }
    case "refused":
      return { exitCode: null, termination: "not-started", reason: `\`${command}\` was not launched: ${outcome.why}` }
    case "launch-failed":
      return { exitCode: null, termination: "not-started", reason: `\`${command}\` could not be started: ${outcome.why}` }
    case "observation-failed":
      return outcome.cleanup.kind === "confirmed"
        ? {
            exitCode: null,
            termination: "confirmed",
            reason: `\`${command}\` could not be observed (${outcome.why}); termination of ${processOf(outcome.pid)} was confirmed`,
          }
        : {
            exitCode: null,
            termination: "unconfirmed",
            reason:
              `\`${command}\` could not be observed (${outcome.why}); termination is UNCONFIRMED (${outcome.cleanup.why}) — ` +
              `check ${processOf(outcome.pid)} by hand`,
          }
    case "terminated":
      return {
        exitCode: null,
        termination: "confirmed",
        reason: `\`${command}\` timed out and was killed; termination of ${processOf(outcome.pid)} was confirmed: ${outcome.why}`,
      }
    case "cleanup-unresolved":
      return {
        exitCode: null,
        termination: "unconfirmed",
        reason:
          `\`${command}\` timed out; termination is UNCONFIRMED and the process may still be running — ` +
          `check ${processOf(outcome.pid)} by hand: ${outcome.why}`,
      }
    default: {
      const unhandled: never = outcome
      return {
        exitCode: null,
        termination: "unconfirmed",
        reason: `\`${command}\` ended with an outcome this module does not know: ${JSON.stringify(unhandled)}`,
      }
    }
  }
}

export interface MaterializeSideInput {
  /** Absolute; must not exist yet, or be an empty directory. */
  directory: string
  baseTree: Readonly<Record<string, string>>
  change: ChangeSet
  git?: RunGit
}

/**
 * `terminationUnconfirmed` is set when a git call did not return and its
 * process may still be running; the runner quarantines on it.
 */
export type Materialized = { ok: true; directory: string } | { ok: false; reason: string; terminationUnconfirmed?: true }

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
      if (target.slice(root.length + 1).split(sep).some((segment) => segment.toLowerCase() === ".git")) {
        return { ok: false, reason: `the base tree path \`${path}\` has a \`.git\` component, which only git writes` }
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
      if (result.exitCode === null) {
        // The directory is left as it is, and never removed here.
        const where =
          result.termination === "not-started"
            ? `was not started in \`${root}\`; the directory holds only what the steps before it wrote`
            : result.termination === "confirmed"
              ? `did not return in \`${root}\`; its process was confirmed ended, and it may have written part of its change there`
              : `did not return in \`${root}\`; its process may still be running and still writing there`
        return {
          ok: false,
          reason: `\`${step.label}\` ${where}: ${result.reason}`,
          ...(result.termination === "unconfirmed" ? { terminationUnconfirmed: true as const } : {}),
        }
      }
      // A successful step is judged on its status and signal alone. Its stderr
      // is not read for success, so an unread stderr there is not a failure.
      if (result.exitCode !== 0 || (result.signal ?? null) !== null) {
        const detail = result.stderr.trim() || result.stdout.trim() || "git reported no detail"
        const signal = (result.signal ?? null) === null ? "" : ` (the OS reported signal ${result.signal})`
        const unread = (result.stderrFailure ?? null) === null ? "" : ` [MAD could not read git's stderr: ${result.stderrFailure}]`
        return { ok: false, reason: `\`${step.label}\` failed in \`${root}\` with status ${result.exitCode}${signal}: ${detail}${unread}` }
      }
    }
    return { ok: true, directory: root }
  } catch (error) {
    return { ok: false, reason: `the worktree could not be written: ${error instanceof Error ? error.message : String(error)}` }
  }
}
