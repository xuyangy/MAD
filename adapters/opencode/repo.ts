/**
 * The `Repo` port over git. Read-only: MAD never writes to the user's repo
 * (AD-16).
 *
 * ## Every read is bounded, and the bound is ONE budget for the whole change
 *
 * `change()` runs `git diff`, `git diff --name-only`, `git ls-files` and one
 * `git diff --no-index` per untracked file. Each goes through the bounded
 * launcher in `./blame-exec.ts` — a pid, a forcible kill at the deadline and a
 * separate cleanup budget — rather than through the host shell, which has none
 * of the three. A read that hangs therefore cannot hold a review before it
 * starts with nothing MAD can stop.
 *
 * THE BUDGET IS SHARED, NOT PER CALL. A per-call deadline multiplies by the
 * number of untracked files; here each read's deadline is whatever remains of
 * one `readBudgetMs` for the whole sequence, so 3+N individually fast reads
 * cannot exceed it. Under 1 ms remaining, the next read is not launched. After
 * every accepted read, the last one included, the elapsed time is checked again:
 * a read that returned after the budget had passed yields no `ChangeSet` and no
 * partial result. At most one `cleanupMs` is added, after the one read that
 * stops, because the sequence ends there.
 *
 * NOMINAL, LIKE THE LAUNCHER'S OWN CONTRACT. Both limits are operational limits
 * measured on an event loop a synchronous caller can block and by an OS that
 * owes no schedule. What is promised is that MAD stops waiting and says which
 * outcome it got, not a hard wall-clock bound.
 *
 * ## Two kinds of failure, kept apart
 *
 * - `GitError` — git ran, returned without a signal, and refused: a bad ref, a
 *   repository with no commits, "not a git repository". Its text is git's.
 * - `ChangeReadStopped` — the read did not return cleanly: it could not be
 *   launched, it was killed at the deadline, its output or diagnostics could not
 *   be read, it was signalled, the budget ran out, or the worktree is
 *   quarantined. Its text is MAD's, and it never invents an exit code.
 *
 * ## The per-worktree quarantine
 *
 * A read whose cleanup the launcher reports as unresolved MAY STILL BE RUNNING.
 * The worktree is then latched in this module's memory, first reason wins, and
 * every later spawn for it — from this `change()`, another one in flight, or a
 * fresh `opencodeRepo` — is refused until the host restarts. The latch is
 * checked immediately before every spawn, not only when `change()` starts. It is
 * separate from `git blame`'s latch in `plugin.ts`, and neither reads the other.
 */

import type { ChangeSet, Repo } from "../../core/ports/repo.ts"
import { deadlineProblem } from "../../core/ports/observation-wait.ts"

import { runBoundedBlame, type BlameExecOutcome, type SpawnBlame } from "./blame-exec.ts"

/** The total execution budget of one `change()`. An operational limit, not a measured latency. */
export const DEFAULT_CHANGE_READ_BUDGET_MS = 60_000

/** The cleanup budget after the one read that stops. An operational limit, not a measured latency. */
export const DEFAULT_CHANGE_READ_CLEANUP_MS = 5_000

export interface OpencodeRepoOptions {
  worktree: string
  /**
   * How each git read is started. Defaults to the launcher's `Bun.spawn`: the
   * inherited environment with `PWD` repaired, piped output and stdin
   * `"ignore"`, so anything that reads stdin gets end-of-file rather than the
   * host's input. A prompt git opens on the terminal itself is not prevented by
   * that; it is bounded by the read budget like any other read that hangs.
   */
  spawn?: SpawnBlame
  /** The total execution budget of one `change()`. Default `DEFAULT_CHANGE_READ_BUDGET_MS`. */
  readBudgetMs?: number
  /** The cleanup budget after a read that stops. Default `DEFAULT_CHANGE_READ_CLEANUP_MS`. */
  cleanupMs?: number
  /** A monotonic clock in milliseconds. Default `performance.now`. */
  now?: () => number
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

/** Why a change read stopped without returning cleanly. */
export type ChangeReadStopKind =
  /** The operating system refused to start git. Nothing ran. */
  | "launch-failed"
  /** The launcher refused the deadline it was given. Nothing ran. */
  | "refused"
  /** A spawn handle came back and watching the process failed, an unread stdout included. */
  | "observation-failed"
  /** The deadline passed and the process and its pipes were accounted for. */
  | "terminated"
  /** The deadline passed and the cleanup could not be confirmed. It may still be running. */
  | "cleanup-unresolved"
  /** Under 1 ms of the budget remained, so the read was not launched. */
  | "budget-exhausted"
  /** The read returned after the budget had passed, so its output is not used. */
  | "budget-passed"
  /** The read returned with a terminating signal, so its output may be a prefix. */
  | "signalled"
  /** The read returned an accepted status, but its stderr could not be read. */
  | "stderr-unread"
  /** The worktree is quarantined, so the read was not launched. */
  | "quarantined"

/**
 * Whether the stopping read's process and pipes were accounted for:
 * `not-applicable` where no cleanup ran — nothing was launched, or the launcher
 * had already accounted for a returned child.
 */
export type ChangeReadCleanup = "confirmed" | "unresolved" | "not-applicable"

/** The fact that latched a worktree's quarantine, exactly as the launcher reported it. */
export interface ChangeReadQuarantine {
  operation: string
  why: string
  /** The pid of the read whose cleanup is unresolved, when the launcher had one. */
  pid?: number
}

export interface ChangeReadStoppedFacts {
  operation: string
  stop: ChangeReadStopKind
  why: string
  readsCompleted: number
  cleanup: ChangeReadCleanup
  pid?: number
  status?: number
  signal?: string
  /** Present when the stop is `quarantined`: the fact that latched it. */
  quarantine?: ChangeReadQuarantine
}

/**
 * A change read that did not return cleanly. NOT a `GitError`: git did not
 * refuse anything here, and the bad-ref hint a `GitError` earns would point the
 * user at the wrong fix.
 *
 * `pid` is present only where the launcher supplied one, and `status` and
 * `signal` only where they were reported; none of the three is ever invented.
 */
export class ChangeReadStopped extends Error {
  readonly operation: string
  readonly stop: ChangeReadStopKind
  readonly readsCompleted: number
  readonly cleanup: ChangeReadCleanup
  readonly pid?: number
  readonly status?: number
  readonly signal?: string
  readonly quarantine?: ChangeReadQuarantine

  constructor(facts: ChangeReadStoppedFacts) {
    super(
      `${facts.operation} stopped (${facts.stop}) after ${facts.readsCompleted} completed read(s): ${facts.why}. ` +
        `Cleanup: ${cleanupWords(facts.cleanup)}. No change was read.`,
    )
    this.name = "ChangeReadStopped"
    this.operation = facts.operation
    this.stop = facts.stop
    this.readsCompleted = facts.readsCompleted
    this.cleanup = facts.cleanup
    if (facts.pid !== undefined) this.pid = facts.pid
    if (facts.status !== undefined) this.status = facts.status
    if (facts.signal !== undefined) this.signal = facts.signal
    if (facts.quarantine !== undefined) this.quarantine = facts.quarantine
  }
}

function cleanupWords(cleanup: ChangeReadCleanup): string {
  switch (cleanup) {
    case "confirmed":
      return "confirmed — the process and its pipes were accounted for"
    case "unresolved":
      return "UNRESOLVED — the process may still be running"
    case "not-applicable":
      return "not applicable — no cleanup was needed"
  }
}

/**
 * Worktrees where a change read left a process nobody could account for.
 * Keyed by the `worktree` string as given, as blame's latch is. Process-local
 * and not durable: nothing clears it but a host restart.
 */
const UNRESOLVED_CHANGE_READ = new Map<string, ChangeReadQuarantine>()

export function changeReadQuarantineFor(worktree: string): ChangeReadQuarantine | undefined {
  return UNRESOLVED_CHANGE_READ.get(worktree)
}

/** Test-only. Nothing in a run clears a latch; recovery is a restart. */
export function clearChangeReadQuarantineForTests(worktree: string): void {
  UNRESOLVED_CHANGE_READ.delete(worktree)
}

function latch(worktree: string, fact: ChangeReadQuarantine): void {
  if (!UNRESOLVED_CHANGE_READ.has(worktree)) UNRESOLVED_CHANGE_READ.set(worktree, fact)
}

export function opencodeRepo(options: OpencodeRepoOptions): Repo {
  const worktree = options.worktree
  const budgetMs = options.readBudgetMs ?? DEFAULT_CHANGE_READ_BUDGET_MS
  const cleanupMs = options.cleanupMs ?? DEFAULT_CHANGE_READ_CLEANUP_MS
  const now = options.now ?? (() => performance.now())

  // REFUSED WHERE SUPPLIED, before anything could be spawned. Below 1 ms is
  // refused too: a read's deadline is a whole number of milliseconds, and a
  // fraction would floor to a budget no read could start under.
  for (const [name, ms] of [
    ["the change read budget", budgetMs],
    ["the change read cleanup budget", cleanupMs],
  ] as const) {
    const problem =
      deadlineProblem(name, ms) ?? (ms < 1 ? `${name} must be at least 1ms, and ${ms} is not` : null)
    if (problem !== null) throw new RangeError(`opencodeRepo was not built: ${problem}`)
  }

  return {
    root: () => worktree,

    async change(target?: string): Promise<ChangeSet> {
      const start = now()
      let readsCompleted = 0

      const stopped = (operation: string, facts: Omit<ChangeReadStoppedFacts, "operation" | "readsCompleted">) =>
        new ChangeReadStopped({ operation, readsCompleted, ...facts })

      /**
       * One bounded git read. `acceptOne` is for `--no-index`, which exits 1
       * whenever the files differ.
       */
      async function git(operation: string, argv: string[], acceptOne = false): Promise<string> {
        // IMMEDIATELY BEFORE EVERY SPAWN: another invocation may have latched
        // this worktree while this one was between reads.
        const latched = UNRESOLVED_CHANGE_READ.get(worktree)
        if (latched !== undefined) {
          throw stopped(operation, {
            stop: "quarantined",
            cleanup: "not-applicable",
            quarantine: latched,
            why:
              `nothing was launched: an earlier ${latched.operation} in this worktree could not be confirmed ` +
              `terminated${latched.pid === undefined ? "" : ` (process ${latched.pid})`}, so this worktree reads ` +
              `nothing until the host restarts. ${latched.why}`,
          })
        }

        const remaining = Math.floor(budgetMs - (now() - start))
        if (remaining < 1) {
          throw stopped(operation, {
            stop: "budget-exhausted",
            cleanup: "not-applicable",
            why: `budget exhausted before ${operation}: the ${budgetMs}ms change read budget was spent, so nothing was launched`,
          })
        }

        const outcome = await runBoundedBlame({
          argv: ["git", ...argv],
          cwd: worktree,
          deadlineMs: remaining,
          cleanupMs,
          ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
        })
        const stdout = accept(operation, outcome, acceptOne)

        // THE FINAL-READ BOUNDARY. A read that came back after the budget had
        // passed is not used, the last one included. The launcher already
        // accounted for its child and pipes, so no cleanup is claimed and
        // nothing is latched.
        const elapsed = now() - start
        if (elapsed > budgetMs) {
          throw stopped(operation, {
            stop: "budget-passed",
            cleanup: "not-applicable",
            why:
              `${operation} returned after the ${budgetMs}ms change read budget had passed ` +
              `(${Math.round(elapsed)}ms elapsed), so its output is not used and no partial change is returned`,
          })
        }
        readsCompleted += 1
        return stdout
      }

      /** Map one launcher outcome to stdout, or throw. Checked in the documented order. */
      function accept(operation: string, outcome: BlameExecOutcome, acceptOne: boolean): string {
        switch (outcome.kind) {
          case "refused":
          case "launch-failed":
            throw stopped(operation, { stop: outcome.kind, cleanup: "not-applicable", why: outcome.why })
          case "observation-failed": {
            const why =
              outcome.cleanup.kind === "unresolved" ? `${outcome.why}. ${outcome.cleanup.why}` : outcome.why
            if (outcome.cleanup.kind === "unresolved") latch(worktree, { operation, why, ...pidOf(outcome.pid) })
            throw stopped(operation, {
              stop: "observation-failed",
              cleanup: outcome.cleanup.kind,
              why,
              ...pidOf(outcome.pid),
              ...(outcome.cleanup.kind === "confirmed" ? observedOf(outcome.cleanup.observed) : {}),
            })
          }
          case "terminated":
            throw stopped(operation, {
              stop: "terminated",
              cleanup: "confirmed",
              why: outcome.why,
              ...pidOf(outcome.pid),
              ...observedOf(outcome.observed),
            })
          case "cleanup-unresolved":
            latch(worktree, { operation, why: outcome.why, ...pidOf(outcome.pid) })
            throw stopped(operation, {
              stop: "cleanup-unresolved",
              cleanup: "unresolved",
              why: outcome.why,
              ...pidOf(outcome.pid),
            })
          case "returned":
            break
        }

        const unreadStderr =
          outcome.stderrFailure === null ? "" : ` (MAD could not read the command's stderr: ${outcome.stderrFailure})`

        // 1. A SIGNALLED RETURN IS NOT A COMPLETED READ, whatever status came
        //    with it: stdout may be only the prefix flushed before the signal.
        if (outcome.signal !== null) {
          throw stopped(operation, {
            stop: "signalled",
            cleanup: "not-applicable",
            status: outcome.exitCode,
            signal: outcome.signal,
            why:
              `the command was terminated by signal ${outcome.signal} (reported status ${outcome.exitCode}), so ` +
              `its output may be incomplete${unreadStderr}`,
          })
        }

        // 2. GIT REFUSED. A bad ref keeps its own path and its own hint.
        const accepted = outcome.exitCode === 0 || (acceptOne && outcome.exitCode === 1)
        if (!accepted) throw new GitError(operation, `${outcome.stderr}${unreadStderr}`)

        // 3. A CHANGE WHOSE DIAGNOSTICS MAD COULD NOT SEE IS NOT PUBLISHED. An
        //    unread stderr on a returned child is not evidence of a survivor, so
        //    nothing is latched.
        if (outcome.stderrFailure !== null) {
          throw stopped(operation, {
            stop: "stderr-unread",
            cleanup: "not-applicable",
            status: outcome.exitCode,
            why: `the command returned status ${outcome.exitCode}, but MAD could not read its stderr: ${outcome.stderrFailure}`,
          })
        }

        // 4. A clean return.
        return outcome.stdout
      }

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
          // It exits 1 whenever the files differ, which here is always, so 1 is
          // accepted beside 0; 2 or more is git's error.
          untrackedDiff += await git(
            `git diff --no-index -- /dev/null ${file}`,
            ["diff", "--unified=8", "--no-index", "--", "/dev/null", file],
            true,
          )
          files.push(file)
        }
      }

      return { description, files, diff: diff + untrackedDiff }
    },
  }
}

/** The launcher's pid, unless it is the `-1` it reports for a handle that carried none. */
function pidOf(pid: number): { pid?: number } {
  return pid > 0 ? { pid } : {}
}

/** The observed status and signal, each only where it was reported. */
function observedOf(observed: { exitCode: number | null; signal: string | null }): { status?: number; signal?: string } {
  return {
    ...(observed.exitCode === null ? {} : { status: observed.exitCode }),
    ...(observed.signal === null ? {} : { signal: observed.signal }),
  }
}
