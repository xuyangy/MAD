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
import {
  inputReason,
  lineSafeName,
  parseNulNames,
  precheckUntracked,
  type InputFs,
  type InputProblem,
} from "./change-input.ts"
import {
  configuredFilters,
  FILTER_PREFLIGHT,
  filterRefusalReason,
  readOnlyGitArgv,
  readOnlyGitEnv,
  unsupportedTargetReason,
  usesReadOnlyPolicy,
  type GitReadPolicy,
} from "./git-read-policy.ts"

/** The total execution budget of one `change()`. An operational limit, not a measured latency. */
export const DEFAULT_CHANGE_READ_BUDGET_MS = 60_000

/** The cleanup budget after the one read that stops. An operational limit, not a measured latency. */
export const DEFAULT_CHANGE_READ_CLEANUP_MS = 5_000

export interface OpencodeRepoOptions {
  worktree: string
  /** `"read-only"` unless given; see `GitReadPolicy`. */
  gitReadPolicy?: GitReadPolicy
  /** CAP-4 — the precheck's file-system calls. Test seam; the default is `node:fs`. */
  inputFs?: InputFs
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
  /** What git said, trimmed, or a fixed phrase when it said nothing. */
  readonly detail: string
  constructor(command: string, stderr: string) {
    const detail = stderr.trim() || "git reported no detail"
    super(`${command} failed: ${detail}`)
    this.name = "GitError"
    this.detail = detail
  }
}

/**
 * The read refused its input before running anything that could act on it: a
 * target git would parse as an option, or a repository whose config defines
 * executable filters (`./git-read-policy.ts`). Neither is a git failure, and
 * neither is a stopped read.
 */
export class ChangeReadRefused extends Error {
  constructor(
    readonly refusal: "unsupported-target" | "unsupported-config" | "unsupported-input",
    /** The reason, as one clause with no closing full stop. */
    readonly why: string,
  ) {
    super(`MAD refused to read this change: ${why}.`)
    this.name = "ChangeReadRefused"
  }
}

/**
 * The filter preflight returned, but not with an answer: git could not read
 * the config (a malformed config file, say), or printed something that is not
 * a list of config keys. No content was read. A `GitError`, so a caller that
 * only knows `GitError` still sees a failed git read.
 */
export class FilterPreflightFailed extends GitError {
  constructor(detail: string) {
    super("git config (filter preflight)", detail)
    this.name = "FilterPreflightFailed"
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
   * CAP-5 — the caller's stop. Nothing was started after it was seen; a read
   * it caught running was killed under the bounded cleanup, whose outcome
   * `cleanup` reports.
   */
  | "cancelled"
  /**
   * CAP-4 — the file-system check of an untracked entry did not answer within
   * the budget. No process ran; the check may still complete, and anything it
   * opens is closed.
   */
  | "check-unanswered"

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
  /** Git reads that returned cleanly before this one, the filter preflight included. */
  readsCompleted: number
  cleanup: ChangeReadCleanup
  pid?: number
  status?: number
  signal?: string
  /** Present when the stop is `quarantined`: the fact that latched it. */
  quarantine?: ChangeReadQuarantine
  /**
   * How much of the change's text MAD had read when this read stopped: `some`
   * once `git diff` was accepted, `possibly` once it was launched but not
   * accepted (its output may have been read and not used). Absent: none.
   */
  contentRead?: "some" | "possibly"
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
        `Cleanup: ${cleanupWords(facts.cleanup, facts.status !== undefined || facts.signal !== undefined)}. ${
          facts.operation === "change read"
            ? "The change was read, but none of it was returned for review."
            : facts.contentRead === "some"
              ? "Part of the change was read, but none of it was returned for review."
              : facts.contentRead === "possibly"
                ? "Some of the change may have been read, but none of it was returned for review."
                : "No change was read."
        }`,
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

function cleanupWords(cleanup: ChangeReadCleanup, exitObserved: boolean): string {
  switch (cleanup) {
    case "confirmed":
      return "confirmed — the process and its pipes were accounted for"
    case "unresolved":
      // An observed exit or signal says the process ended; it does not confirm
      // its cleanup, and does not say which part of it is outstanding.
      return exitObserved
        ? "UNRESOLVED — the process was seen to end, but MAD could not confirm its cleanup, so something it " +
            "started may still be running"
        : "UNRESOLVED — the process may still be running"
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
  const readOnly = usesReadOnlyPolicy(options.gitReadPolicy)
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

    async change(target?: string, signal?: AbortSignal): Promise<ChangeSet> {
      const start = now()
      let readsCompleted = 0
      let contentRead: ChangeReadStoppedFacts["contentRead"]

      const stopped = (
        operation: string,
        facts: Omit<ChangeReadStoppedFacts, "operation" | "readsCompleted" | "contentRead">,
      ) =>
        new ChangeReadStopped({ operation, readsCompleted, ...(contentRead === undefined ? {} : { contentRead }), ...facts })

      // CAP-5 — A STOP THAT LANDED AS THE LAST READ FINISHED is not hidden
      // behind the result, under either read policy: the change was read, and
      // nothing reviews it.
      const unlessStopped = (change: ChangeSet): ChangeSet => {
        if (signal?.aborted) {
          throw stopped("change read", {
            stop: "cancelled",
            cleanup: "not-applicable",
            why: "the review was stopped as the change read finished, so the change was read but nothing reviews it",
          })
        }
        return change
      }

      /**
       * One bounded git read under the read policy (`./git-read-policy.ts`).
       * `acceptOne` is for `--no-index`, which exits 1 whenever the files
       * differ, and for the filter preflight, which exits 1 when nothing
       * matches. `argv` is the subcommand; the policy supplies `git` and its
       * overrides.
       */
      async function git(operation: string, argv: string[], acceptOne = false): Promise<string> {
        return (await read(operation, argv, acceptOne)).stdout
      }

      async function read(
        operation: string,
        argv: string[],
        acceptOne: boolean,
        keepLeadingBom = false,
      ): Promise<{ stdout: string; exitCode: number }> {
        // CAP-5 — THE CALLER'S STOP, before anything else: nothing starts after it.
        if (signal?.aborted) {
          throw stopped(operation, {
            stop: "cancelled",
            cleanup: "not-applicable",
            why: `the review was stopped before ${operation}, so nothing was launched`,
          })
        }

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
          ...(readOnly ? { argv: readOnlyGitArgv(argv), env: readOnlyGitEnv(process.env) } : { argv: ["git", ...argv] }),
          cwd: worktree,
          deadlineMs: remaining,
          cleanupMs,
          ...(keepLeadingBom ? { keepLeadingBom } : {}),
          ...(signal === undefined ? {} : { signal }),
          ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
        })
        // A LAUNCHED `git diff` MAY HAVE PASSED CHANGE TEXT TO MAD before it
        // stopped or failed, so from here "No change was read" is not claimed.
        const launched =
          outcome.kind !== "refused" && outcome.kind !== "launch-failed" && !(outcome.kind === "stopped" && !outcome.launched)
        if (operation === "git diff" && launched) contentRead ??= "possibly"
        const accepted = accept(operation, outcome, acceptOne)

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
        return accepted
      }

      /** Map one launcher outcome to stdout, or throw. Checked in the documented order. */
      function accept(
        operation: string,
        outcome: BlameExecOutcome,
        acceptOne: boolean,
      ): { stdout: string; exitCode: number } {
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
          case "stopped":
            // CAP-5 — the caller's stop, before or during this read.
            if (!outcome.launched) {
              throw stopped(operation, {
                stop: "cancelled",
                cleanup: "not-applicable",
                why: `the review was stopped before ${operation}, so nothing was launched`,
              })
            }
            if (outcome.cleanup.kind === "unresolved") {
              latch(worktree, { operation, why: outcome.why, ...pidOf(outcome.pid) })
              throw stopped(operation, {
                stop: "cancelled",
                cleanup: "unresolved",
                why: outcome.why,
                ...pidOf(outcome.pid),
                ...(outcome.cleanup.observed === undefined ? {} : observedOf(outcome.cleanup.observed)),
              })
            }
            throw stopped(operation, {
              stop: "cancelled",
              cleanup: "confirmed",
              why: outcome.why,
              ...pidOf(outcome.pid),
              ...observedOf(outcome.cleanup.observed),
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
        return { stdout: outcome.stdout, exitCode: outcome.exitCode }
      }

      /** CAP-4 — an input refusal, naming the entry line-safely with a fixed reason. */
      const refuseInput = (problem: InputProblem, name?: string): ChangeReadRefused =>
        new ChangeReadRefused(
          "unsupported-input",
          name === undefined ? inputReason(problem) : `the untracked entry ${lineSafeName(name)}: ${inputReason(problem)}`,
        )

      /**
       * CAP-4 — the names and the untracked files under the read-only policy:
       * `-z` names parsed strictly, each untracked entry checked before git
       * reads it, and every read validated. Anything that fails refuses the
       * whole change; nothing is skipped.
       */
      async function readInputStrictly(diff: string): Promise<{ files: string[]; untrackedDiff: string }> {
        // A name may start with U+FEFF, which the default decoding drops, so
        // both listings keep it.
        const listed = parseNulNames(
          (await read("git diff --name-only", ["diff", "--name-only", "-z", ...range], false, true)).stdout,
        )
        if ("problem" in listed) throw refuseInput(listed.problem)
        const files = listed.names
        // LISTED BUT EMPTY is missing material, never "nothing to review".
        if (files.length > 0 && diff.length === 0) throw refuseInput("no-change-text")

        // `git diff` cannot see untracked files, so a change made entirely of
        // new files would otherwise review as empty. An explicit ref range is
        // history and has none.
        let untrackedDiff = ""
        if (target) return { files, untrackedDiff }
        const others = parseNulNames(
          (await read("git ls-files", ["ls-files", "-z", "--others", "--exclude-standard"], false, true)).stdout,
        )
        if ("problem" in others) throw refuseInput(others.problem)

        for (const file of others.names) {
          const operation = `check of untracked entry ${lineSafeName(file)}`
          const waitMs = Math.floor(budgetMs - (now() - start))
          if (waitMs < 1) {
            throw stopped(operation, {
              stop: "budget-exhausted",
              cleanup: "not-applicable",
              why: `budget exhausted before ${operation}: the ${budgetMs}ms change read budget was spent, so nothing was checked`,
            })
          }
          if (signal?.aborted) {
            throw stopped(operation, {
              stop: "cancelled",
              cleanup: "not-applicable",
              why: `the review was stopped before ${operation}, so nothing was checked`,
            })
          }
          const checked = await precheckUntracked(worktree, file, waitMs, options.inputFs, signal)
          if ("stopped" in checked) {
            throw stopped(operation, {
              stop: "cancelled",
              cleanup: "not-applicable",
              why:
                `the review was stopped during ${operation}. MAD stopped waiting and started nothing further; ` +
                `an operation already started may still complete, and MAD attempts to close any file it opened`,
            })
          }
          if ("unanswered" in checked) {
            throw stopped(operation, {
              stop: "check-unanswered",
              cleanup: "not-applicable",
              why:
                `the file system did not answer within the ${waitMs}ms left of the ${budgetMs}ms change read ` +
                `budget. MAD stopped waiting and started nothing further; an operation already started may still ` +
                `complete, and MAD attempts to close any file it opened`,
            })
          }
          if ("problem" in checked) throw refuseInput(checked.problem, file)

          let read: { stdout: string; exitCode: number }
          try {
            read = await readNoIndex(file)
          } catch (error) {
            // Git refused this one file: its read, not a bad ref. A stopped
            // read stays a stopped read.
            if (error instanceof GitError) throw refuseInput("git-unread", file)
            throw error
          }
          // A listed entry with no output vanished or changed after its
          // check: an empty file still has a header.
          if (read.stdout.length === 0) throw refuseInput("changed", file)
          untrackedDiff += read.stdout
          files.push(file)
        }
        return { files, untrackedDiff }
      }

      /** `--no-index` against /dev/null, which exits 1 whenever the files differ. */
      const readNoIndex = (file: string) =>
        read(
          `git diff --no-index -- /dev/null ${lineSafeName(file)}`,
          ["diff", "--unified=8", "--no-index", "--", "/dev/null", file],
          true,
        )

      // A target git would parse as an option is refused before anything runs:
      // the target sits before `--`, where git still reads options, and
      // `--output=<path>` would write a file.
      const targetProblem = unsupportedTargetReason(target)
      if (targetProblem !== undefined) throw new ChangeReadRefused("unsupported-target", targetProblem)

      // THE FILTER PREFLIGHT, before any read of content. Exit 1 is "none
      // configured"; anything that is neither that nor a parsable match is an
      // error, never "none".
      // A preflight that STOPPED is a stopped read like any other.
      if (readOnly) {
        let preflight: { stdout: string; exitCode: number }
        try {
          preflight = await read("git config (filter preflight)", [...FILTER_PREFLIGHT], true)
        } catch (error) {
          if (error instanceof GitError) throw new FilterPreflightFailed(error.detail)
          throw error
        }
        const filters = configuredFilters(preflight.exitCode, preflight.stdout)
        if (filters.kind === "configured") {
          throw new ChangeReadRefused("unsupported-config", filterRefusalReason(filters.drivers))
        }
        if (filters.kind === "unknown") {
          throw new FilterPreflightFailed("its output could not be read as config keys")
        }
      }

      const range = target ? [target, "--"] : ["HEAD", "--"]
      // Under the read policy a submodule is read as its commit pointer only,
      // and the description says so, because "no change" and a review both
      // repeat it to the user.
      const submodules = "submodules as commit pointers only, their uncommitted contents not read"
      const description = target
        ? `git diff ${target}${readOnly ? ` (${submodules})` : ""}`
        : `working tree (git diff HEAD, plus untracked files${readOnly ? `; ${submodules}` : ""})`

      const diff = await git("git diff", ["diff", "--unified=8", ...range])
      contentRead = "some"
      if (readOnly) {
        const { files, untrackedDiff } = await readInputStrictly(diff)
        return unlessStopped({ description, files, diff: diff + untrackedDiff })
      }

      // UNDER `inherit`, the historical parse, byte for byte: the harness
      // keeps what it measured (CAP-4 applies to the read-only policy only).
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

      return unlessStopped({ description, files, diff: diff + untrackedDiff })
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
