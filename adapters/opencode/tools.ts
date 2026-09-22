/**
 * The `Tools` port over the host's repository — AD-13's FIRST route, driven for
 * the first time by story 10. Read-only: MAD never writes to the user's repo
 * (AD-16), and `adapters/opencode/tools.test.ts` asserts that structurally
 * rather than trusting this sentence.
 *
 * ## Why this file exists at all
 *
 * Story 6 took AD-13's SECOND route — the out-of-process backend brings its own
 * agent's tools — and that route works and stays. What it cannot do is PROVE a
 * check happened: `core/stages/judge.ts` computed `factVerified` from the slot's
 * DECLARED capability and the checker's SELF-REPORTED `checks` list, so a model
 * that said it ran `git blame` and did not was indistinguishable from one that
 * did. This adapter is what lets MAD run the check itself, so at least one class
 * of evidence in the record is executed rather than claimed (CAP-8).
 *
 * ## Only `blame` is driven
 *
 * `readFile`, `list`, `grep` and `runTest` throw `NotDrivenError`. Scope
 * discipline: `blame` alone satisfies CAP-8's success clause and is the one with
 * a natural contradiction shape. `runTest` is the expensive one and the one with
 * a real permission surface (`host-integration.md`: tool execution is the
 * host's) — it is left for a later story. A loud throw beats a silent stub: an
 * accidental call is a crash a test catches, not a wrong answer a reader
 * believes.
 *
 * ## The path is a model's free string
 *
 * `Finding.locus.file` is validated only as a non-empty string, so it may not
 * exist, may escape the worktree, may contain a newline or a shell metacharacter.
 * It goes to git as its OWN argv element after `--`, and the launcher hands argv
 * to the OS element for element — there is no command line to be syntax in.
 *
 * ## This file builds no material span
 *
 * It returns raw repository text. `git blame` output is material under AD-18 —
 * a commit message is written by whoever wrote the commit and can carry text
 * addressed to a reviewer — but the SPAN is the core's to build
 * (`core/prompt/material.ts` is the single emitter, and
 * `scripts/lint-material-spans.ts` proves it). That split is also the AD-1
 * correct one: the adapter executes, the core frames.
 *
 * ## WHAT THE LAUNCHER ESTABLISHES, AND WHAT IT DOES NOT (story 2-7c)
 *
 * `blame` runs through `./blame-exec.ts`, not through the host shell. That file
 * is where the deadline, the kill and the cleanup budget live; what matters here
 * is what each of its four outcomes proves, because those readings become a
 * measured execution count.
 *
 * A LAUNCH FAILURE IS OBSERVED, NOT INFERRED FROM TEXT, AND IT IS PRE-LAUNCH
 * ONLY. The launcher sees `Bun.spawn` refuse for itself — a missing git, an
 * unreadable working directory — and says so. NOTHING ABOUT THE LAUNCH IS READ
 * OUT OF THE CHILD'S OWN OUTPUT, and that is the load-bearing part: the host
 * shell's only launch signal was a `bun: command not found: ` line on stderr,
 * and git echoes a model-supplied path verbatim into `fatal: no such path
 * '<path>' in HEAD` — so a path carrying that phrase would be untrusted text
 * deciding an execution count. Observing the spawn removes the exposure instead
 * of hardening a match against it.
 *
 * A FAILURE AFTER THE SPAWN IS A DIFFERENT FACT AND TAKES A DIFFERENT BRANCH.
 * `launch: "failed"` is read by `core/judge/blame.ts` as a PROVED non-execution,
 * so it may only ever describe a program the OS refused to start. Once a spawn
 * handle exists, a rejected exit read or an unreadable stdout establishes
 * nothing about whether the git executable ran — holding a handle is not proof
 * of execution — so those come back as `observation-failed` and are classified
 * `unproved` with no exit code, which is `unknown`. Whether they QUARANTINE
 * depends on the cleanup state and not on the error's class.
 *
 * A ZERO EXIT STILL MEANS THE PROGRAM RAN TO COMPLETION, and a NON-ZERO EXIT
 * still establishes nothing about whether git started — `git blame` over a bad
 * path exits 128 with its own `fatal:` text, which is a git failure, and the
 * number alone cannot be told from a program that never ran. So a non-zero exit
 * reads `unproved` exactly as before.
 *
 * A TIMEOUT IS NOT AN EXIT. A blame MAD stopped waiting for carries NO exit code
 * into the evidence — not a real one, and certainly not a synthesized `124`.
 * Whatever the OS reported about the killed process is preserved in the failure
 * TEXT, where a reader can use it, and never in the structured evidence, where
 * `core/judge/blame.ts` would have to decide what it meant. The reading is
 * `unknown`, which is what it is.
 *
 * AN UNCONFIRMED CLEANUP QUARANTINES THIS INSTANCE. See `onCleanupUnresolved`
 * below.
 */

import type { PluginInput } from "@opencode-ai/plugin"

import type { Clock } from "../../core/ports/clock.ts"
import { systemClock } from "../../core/ports/clock.ts"
import {
  awaitObservationWrite,
  deadlineProblem,
  OBSERVATION_WRITE_TIMEOUT_MS,
  observationTimeoutReason,
} from "../../core/ports/observation-wait.ts"
import type {
  BlameArguments,
  LaunchEvidence,
  ToolFailureEvidence,
  ToolObservation,
  ToolObservationWrite,
} from "../../core/ports/tool-observation.ts"
import {
  MAX_STDERR_CHARS,
  STDERR_CLIPPED,
  TOOL_FAILURE_EVIDENCE,
} from "../../core/ports/tool-observation.ts"
import type { CommandResult, GrepHit, Tools } from "../../core/ports/tools.ts"
import type { SpawnBlame } from "./blame-exec.ts"
import { runBoundedBlame } from "./blame-exec.ts"
import { GitError } from "./repo.ts"

type Shell = PluginInput["$"]

/**
 * SIXTY SECONDS OF NOMINAL EXECUTION for one `git blame` over at most
 * `MAX_BLAME_ROWS` lines.
 *
 * The same number `ablation/adversarial-materialize.ts` names for the git calls
 * that write each worktree, so the two halves of one evaluation do not disagree
 * about how long a git may take. (That file's own termination is a separate,
 * still-unverified matter — see `ablation/LIVE-RUN.md`.) Far outside the range a
 * healthy blame answers in over the at most `MAX_BLAME_ROWS` lines
 * `core/stages/judge.ts` asks for, and inside the range a cold, very large or
 * network-backed repository can legitimately need. Fixed, with no user-facing
 * dial: CAP-7 froze the tool's dials at the preset and the budget.
 */
export const DEFAULT_BLAME_TIMEOUT_MS = 60_000

/**
 * FIVE SECONDS TO ESTABLISH THAT THE KILLED CHILD REALLY WENT, separate from the
 * sixty above and much shorter, on `model-backend.ts`'s precedent.
 *
 * The two bound different things. The first bounds git doing work; this bounds
 * the operating system reaping a process that has already been sent SIGKILL,
 * which is not work and does not get quicker with waiting. What it buys is the
 * difference between "terminated" and "termination is unconfirmed", and those
 * are the two facts the whole quarantine hangs on.
 */
export const DEFAULT_BLAME_CLEANUP_TIMEOUT_MS = 5_000

/**
 * Story 2-7c — an unconfirmed process cleanup, as the host is told about it.
 *
 * SMALL AND STRUCTURED, carrying only what was actually established: which
 * operation, why it is unresolved, and the process identity where one is known.
 * It carries no exit code and no launch evidence, because there is none — that
 * is what "unconfirmed" means, and a field invented to fill the shape would be
 * the exact fabrication this story forbids.
 */
export interface BlameCleanupUnresolved {
  /** The operation whose cleanup is unresolved, in MAD's own words. */
  operation: string
  /** Why termination could not be confirmed, including both deadlines. */
  why: string
  /** The process MAD launched and cannot account for. */
  pid: number
}

export interface OpencodeToolsOptions {
  /**
   * The host shell, kept on the construction surface and NO LONGER USED BY
   * `blame` (story 2-7c).
   *
   * `blame` moved to `./blame-exec.ts` because a `BunShellPromise` carries no
   * pid, no kill and no abort, so a blame that never returned could not be
   * terminated. `adapters/opencode/repo.ts` still reads the change through this
   * same shell and is deliberately untouched — reading the change IS repository
   * commands, and that is a different story's refactor.
   *
   * IT IS NEVER READ. Nothing in this file touches it, and a construction that
   * omits it runs `blame` identically — `adapters/opencode/tools.test.ts` pins
   * that a shell handed in here is not called at all. It stays on the surface
   * because every existing caller passes one and a later driven method may want
   * it; removing it is a breaking change to the factory's shape and is filed in
   * the deferred-work ledger rather than smuggled in here.
   */
  $?: Shell
  worktree: string
  /**
   * Story 2-7a — the tool-action observer, OPTIONAL and bound by its constructor
   * to the run it observes (`core/ports/tool-observation.ts`).
   *
   * Absent, this adapter runs the same argv and returns the same bytes. Present,
   * the invocation and the shell's return are written as two distinct facts, and
   * a failure carries the evidence the core cannot see for itself.
   */
  toolObservation?: ToolObservation
  /**
   * The clock the trace's timestamps come from. Optional, defaulting to the same
   * `systemClock()` an ordinary run uses.
   *
   * IT EXISTS SO ONE TRACE HAS ONE CLOCK. The judge stamps its request and its
   * terminal reading from `Clock.now()`; if this layer stamped `new Date()`
   * instead, a run driven by a fake clock would produce a trace whose core half
   * and adapter half came from different time sources and could not be ordered
   * by `at` at all. Nothing is observed when no observer is present, so the
   * default costs an unobserved run nothing.
   */
  clock?: Clock
  /**
   * Story 2-7c — the three deadlines, as construction options in the shape
   * `adapters/opencode/model-backend.ts` established for `timeoutMs` and
   * `cleanupTimeoutMs`.
   *
   * NOT DIALS. There is no CLI flag, no config key and no environment variable
   * behind any of them, and `adapters/opencode/plugin.ts` passes none — a
   * shipped run takes the constants above. They are named options rather than
   * positional millisecond numbers for the reason `model-backend.test.ts` pins:
   * two numbers of the same type in a row is a call nobody can read and a swap
   * no compiler catches.
   */
  blameTimeoutMs?: number
  blameCleanupTimeoutMs?: number
  observationTimeoutMs?: number
  /**
   * Story 2-7c — HOW THIS ADAPTER SAYS IT HAS QUARANTINED ITSELF.
   *
   * When a blame's cleanup cannot be confirmed, the process MAD launched may
   * still be running and MAD has no way to find out. This instance then refuses
   * every further launch, and calls this back once with the fact.
   *
   * THE LATCH LANDS BEFORE THE NOTIFICATION, and the notification lands no later
   * than the timed-out call returns. A host that reacts inside the callback
   * therefore already sees an adapter that refuses, and a callback that throws
   * can neither restore launch permission nor turn the blame into a success —
   * both are decided before it is entered.
   *
   * IT EXISTS BECAUSE AN OBSERVATION FAILURE CANNOT CARRY THIS. An ordinary run
   * supplies no observer at all (`adapters/opencode/plugin.ts`), so routing
   * process-cleanup state through `ToolObservation.failed` would make the fact
   * reachable only on an evaluation run — while the hang itself is reachable on
   * every run.
   */
  onCleanupUnresolved?: (fact: BlameCleanupUnresolved) => void
  /**
   * Story 2-7c — BUILD THIS INSTANCE ALREADY QUARANTINED.
   *
   * The same latch `onCleanupUnresolved` sets, carried in from outside. It is
   * how a host that outlives one construction — `adapters/opencode/plugin.ts`
   * serves many invocations from one process — stops a second invocation
   * launching against a worktree where an earlier one left a process it could
   * not account for. Without it every invocation would start clean and a user
   * retrying could multiply unaccounted-for processes one run at a time.
   *
   * It reuses the refusal path rather than adding a second one, so a refused
   * blame lands in the existing `blame-unavailable` warning with this reason
   * inside it — no new warning code, and nothing a reader has to learn.
   */
  quarantinedBy?: BlameCleanupUnresolved
  /** Test seam for the launcher. Defaults to the real one. */
  spawn?: SpawnBlame
}

/**
 * What a FINISHED run establishes about whether the program launched.
 *
 * Exported so the host semantics behind it are testable. Story 2-7c narrowed it
 * to the one question a completed exit can answer: a zero exit proves the
 * program ran, and anything else proves nothing either way. The launch FAILURE
 * reading does not come from here at all: `./blame-exec.ts` observes a refused
 * spawn directly, which is why nothing in this function reads the child's own
 * output.
 */
export function launchEvidenceFrom(exitCode: number): LaunchEvidence {
  return exitCode === 0 ? "proved" : "unproved"
}

/**
 * Bound the host's diagnostic before it is written to a trace.
 *
 * Untrusted and unbounded: git puts the model's own path inside it, and nothing
 * caps how long that path is. The clip is STATED in the value, because a trace
 * field that silently loses its end is worse than a short one — a reader
 * comparing two failures cannot tell a truncation from a difference.
 */
export function clipStderr(stderr: string): string {
  return stderr.length <= MAX_STDERR_CHARS
    ? stderr
    : `${stderr.slice(0, MAX_STDERR_CHARS)}${STDERR_CLIPPED}`
}

/**
 * A `Tools` method that exists on the interface and is not driven yet.
 *
 * Named, so an accidental call reads as "story 10 drove one method" rather than
 * as a bug in whatever called it. The interface shape is fixed in
 * `core/ports/tools.ts` so no stage invents its own tool surface; that is a
 * reason to keep the methods, not a reason to fake them.
 */
export class NotDrivenError extends Error {
  constructor(method: string) {
    super(
      `Tools.${method} is declared by core/ports/tools.ts and is not driven yet: story 10 drove ` +
        `blame() only. Driving it is a story, not a patch.`,
    )
    this.name = "NotDrivenError"
  }
}

/**
 * Attach the evidence only this layer holds to the error the core will catch.
 *
 * STRUCTURAL, not a subclass: `core/judge/blame.ts` reads a shape and names no
 * adapter type (AD-1), and a `Tools` implementation that attaches nothing yields
 * `unknown` rather than a wrong reading.
 */
function withEvidence(error: GitError, evidence: ToolFailureEvidence): GitError {
  Object.defineProperty(error, TOOL_FAILURE_EVIDENCE, {
    value: evidence,
    enumerable: false,
    writable: false,
  })
  return error
}

export function opencodeTools(options: OpencodeToolsOptions): Tools {
  const observation = options.toolObservation
  const clock = options.clock ?? systemClock()
  const blameTimeoutMs = options.blameTimeoutMs ?? DEFAULT_BLAME_TIMEOUT_MS
  const cleanupTimeoutMs = options.blameCleanupTimeoutMs ?? DEFAULT_BLAME_CLEANUP_TIMEOUT_MS
  const observationTimeoutMs = options.observationTimeoutMs ?? OBSERVATION_WRITE_TIMEOUT_MS
  // REFUSED AT CONSTRUCTION, ALL THREE ALIKE. A zero, a negative, a `NaN` or a
  // value past the timer ceiling all schedule for right now, so an adapter built
  // with one would abandon every call it ever made while looking like it had a
  // bound. A deadline is a construction option, so the construction is where it
  // is judged: leaving the two blame deadlines to the launcher turned a fault in
  // MAD's own wiring into a per-call outcome the judge counted as a measurement.
  // The launcher still refuses one, for the caller that does not come through
  // here, and says there that the refusal is MAD's rather than the host's.
  for (const [name, ms] of [
    ["the observation write deadline", observationTimeoutMs],
    ["the blame execution deadline", blameTimeoutMs],
    ["the blame cleanup budget", cleanupTimeoutMs],
  ] as const) {
    const issue = deadlineProblem(name, ms)
    if (issue !== null) throw new RangeError(`opencodeTools was not built: ${issue}`)
  }

  /**
   * The latched quarantine, or `null`. Per INSTANCE and not per module: two
   * adapters in one process bind two different worktrees, and one unaccounted
   * process is not a reason to refuse a launch nothing connects it to.
   */
  let quarantined: BlameCleanupUnresolved | null = options.quarantinedBy ?? null

  /**
   * AN OBSERVATION FAILURE IS NEVER A TOOL FAILURE, AND IT IS NEVER SILENT.
   *
   * A trace that could not be written must not change what git did or what the
   * caller sees, so every observer call goes through here. This layer holds no
   * run record, so it reports through the observer's own `failed`, which the
   * judge DRAINS with `takeFailures` at the end of the stage and folds into the
   * one `tool-observation-failed` warning. Without that drain a run whose every
   * adapter write failed would render identically to a fully traced one.
   *
   * AND IT IS BOUNDED. An unbounded await here stalls the blame in front of it,
   * one finding at a time. Past the deadline the write is ABANDONED: the
   * observation is incomplete, it is reported as a failure naming the write and
   * the duration, and the value never comes back — a late resolution cannot
   * complete it and a late rejection is consumed inside
   * `awaitObservationWrite`.
   *
   * The inner catch exists because a broken observer may break there too; at
   * that point there is no channel left, and a `git blame` must not fail because
   * its trace could not be written.
   */
  async function observe(
    write: ToolObservationWrite,
    send: (sink: ToolObservation) => Promise<void>,
  ): Promise<void> {
    if (observation === undefined) return
    const outcome = await awaitObservationWrite(() => send(observation), { timeoutMs: observationTimeoutMs })
    if (outcome.kind === "settled") return
    try {
      observation.failed({
        where: "adapter",
        write,
        why:
          outcome.kind === "timed-out"
            ? observationTimeoutReason(write, outcome.ms)
            : outcome.error instanceof Error
              ? outcome.error.message
              : String(outcome.error),
      })
    } catch {
      // The last resort failed too. There is no second channel at this layer.
    }
  }

  /**
   * Latch the quarantine, then tell the host. In that order, and the order is
   * the contract: see `onCleanupUnresolved`.
   */
  function quarantine(fact: BlameCleanupUnresolved): void {
    if (quarantined !== null) return
    quarantined = fact
    try {
      options.onCleanupUnresolved?.(fact)
    } catch {
      // A host that failed to record the fact does not get its launches back,
      // and the blame that produced it stays a failure. There is nothing left
      // to escalate to at this layer.
    }
  }

  /**
   * Run one git command under a deadline, and say what happened.
   *
   * THE INVOCATION AND THE RETURN ARE TWO FACTS (story 2-7a). The invocation is
   * written BEFORE the call is awaited, so a call that never comes back still
   * leaves the record that something was launched at; the outcome is written
   * after, with what the launcher actually established. Entering this function
   * is neither fact.
   *
   * A TIMED-OUT OR UNCONFIRMED CALL WRITES NO OUTCOME FACT, deliberately.
   * `ToolShellOutcome` requires an `exitCode`, and there is no honest number to
   * put there — so the trace carries the invocation with no outcome, which
   * `ablation/adversarial-read.ts` already reads as an incomplete call rather
   * than as a zero.
   */
  async function git(command: string, argv: string[], args: BlameArguments): Promise<string> {
    if (quarantined !== null) {
      // NOTHING IS LAUNCHED WHILE QUARANTINED, and the refusal is proved rather
      // than assumed: `pre-shell` plus `not-attempted` is the one evidence shape
      // that means "no process was started", which is what actually happened.
      throw withEvidence(
        new GitError(
          command,
          `refusing to launch: an earlier ${quarantined.operation} could not be confirmed terminated, ` +
            `so this adapter launches nothing further. ${quarantined.why}`,
        ),
        { stage: "pre-shell", launch: "not-attempted" },
      )
    }

    await observe("invoked", (sink) =>
      sink.invoked({ tool: "blame", args, argv: [...argv], at: clock.now() }),
    )

    const outcome = await runBoundedBlame({
      argv,
      cwd: options.worktree,
      deadlineMs: blameTimeoutMs,
      cleanupMs: cleanupTimeoutMs,
      ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
    })

    if (outcome.kind === "refused") {
      // MAD'S OWN FAULT, BEFORE ANY SHELL. Nothing executed, which `pre-shell`
      // says — and it says it without borrowing the operating system's voice the
      // way `launch: "failed"` would. `core/judge/blame.ts` reads both as
      // `not-executed`; only this one is honest about who refused.
      throw withEvidence(new GitError(command, outcome.why), {
        stage: "pre-shell",
        launch: "not-attempted",
      })
    }

    if (outcome.kind === "launch-failed") {
      // PRE-LAUNCH ONLY. The operating system refused to start the program, so
      // this is a PROVED non-execution — the one thing the old shell could never
      // establish. Nothing post-launch may take this branch: see the header.
      throw withEvidence(new GitError(command, `the command could not be started: ${outcome.why}`), {
        stage: "shell",
        launch: "failed",
      })
    }

    if (outcome.kind === "observation-failed") {
      // POST-LAUNCH. A spawn handle came back and then watching the process
      // failed. A handle is not evidence that git executed, so this is
      // `unproved` with no exit code — `unknown` in `core/judge/blame.ts` — and
      // never the proved non-execution above.
      //
      // THE QUARANTINE TRIGGER IS UNRESOLVED CLEANUP, NOT THE ERROR'S CLASS. An
      // observation that failed while the process and its pipes were accounted
      // for is an ordinary failure; one that leaves them unaccounted for is not.
      if (outcome.cleanup.kind === "unresolved") {
        quarantine({ operation: command, why: `${outcome.why}. ${outcome.cleanup.why}`, pid: outcome.pid })
      }
      throw withEvidence(new GitError(command, outcome.why), { stage: "shell", launch: "unproved" })
    }

    if (outcome.kind === "cleanup-unresolved" || outcome.kind === "terminated") {
      if (outcome.kind === "cleanup-unresolved") {
        quarantine({ operation: command, why: outcome.why, pid: outcome.pid })
      }
      // NO EXIT CODE IN THE EVIDENCE. `unproved` with no number reads as
      // `unknown` in `core/judge/blame.ts`, which is the honest classification
      // for a call MAD stopped waiting for — and it stays a failure even if a
      // racing late exit turns out to be zero.
      throw withEvidence(new GitError(command, outcome.why), {
        stage: "shell",
        launch: "unproved",
      })
    }

    // A SIGNALLED EXIT IS NOT A COMPLETED RUN, whatever number came with it.
    //
    // A child killed from outside — an operator, an OOM killer, a session
    // teardown — can be reported with status 0 and a terminating signal, and its
    // stdout is then whatever it had flushed before it died. A truncated
    // porcelain prefix parses perfectly well, so accepting this would produce a
    // citation over lines git never finished blaming. The exit code is preserved
    // in the evidence because it was really observed; what it does not do is
    // prove the program completed, so the launch reading stays `unproved`.
    // THE TRACE'S `stderr` IS WHAT THE COMMAND PRINTED, AND ONLY THAT. Where the
    // pipe could not be read, the launcher hands back an empty `stderr` and its
    // reason in `stderrFailure`, and the two stay apart here: the field keeps
    // only git's own text, and MAD's account of why it has none travels in the
    // error message, which is MAD's voice by construction. Folding the reason
    // into the field would put a sentence git never wrote where every reader
    // downstream treats the contents as the program's.
    const unreadStderr =
      outcome.stderrFailure === null ? "" : ` (MAD could not read the command's stderr: ${outcome.stderrFailure})`

    const launch = launchEvidenceFrom(outcome.exitCode)
    // RECORDED BEFORE THE THROW, FOR EVERY OUTCOME THAT HAS ONE. A signalled exit
    // carries a real status and a real diagnostic, and the trace is where both
    // belong; the earlier shape threw first and lost facts the evidence already
    // held. The `launch` reading is what separates the two cases, not whether a
    // row was written.
    await observe("shellOutcome", (sink) =>
      sink.shellOutcome({
        tool: "blame",
        args,
        exitCode: outcome.exitCode,
        launch: outcome.signal === null ? launch : "unproved",
        stderr: clipStderr(outcome.stderr),
        at: clock.now(),
      }),
    )

    if (outcome.signal !== null) {
      throw withEvidence(
        new GitError(
          command,
          `the command was terminated by signal ${outcome.signal} (reported status ${outcome.exitCode}), ` +
            `so its output is incomplete and nothing here is evidence that git finished${unreadStderr}`,
        ),
        { stage: "shell", exitCode: outcome.exitCode, launch: "unproved" },
      )
    }

    if (outcome.exitCode !== 0) {
      throw withEvidence(new GitError(command, `${outcome.stderr}${unreadStderr}`), {
        stage: "shell",
        exitCode: outcome.exitCode,
        launch,
      })
    }
    return outcome.stdout
  }

  return {
    async blame(path: string, startLine: number, endLine: number): Promise<string> {
      // A RANGE CHECK BEFORE THE LAUNCH, not after. `-L` takes `<start>,<end>`
      // and a non-integer or reversed range is a caller bug, not repository
      // state — git would reject most of them, but `-L 1,1e9` and `-L 0,5` fail
      // with git's own wording, which reads to a user as though their repo were
      // at fault. Same error type either way, so the judge's one catch handles
      // both and reports under AD-6.
      const bad =
        !Number.isInteger(startLine) ||
        !Number.isInteger(endLine) ||
        startLine < 1 ||
        endLine < startLine
      if (bad) {
        // SEPARABLE FROM EVERY LATER FAILURE (story 2-7a). Nothing ran, so this
        // is "request observed, execution did not occur" and never an
        // invocation: the evidence says `pre-shell` and no invocation fact is
        // written, which is what keeps a refused range out of an execution count.
        throw withEvidence(
          new GitError(
            "git blame",
            `refusing to blame ${JSON.stringify(path)} over the line range ${startLine},${endLine}: ` +
              `a range must be two whole numbers, 1-indexed, with the end at or after the start`,
          ),
          // NOTHING WAS LAUNCHED AT, which `unproved` does not say — that word
          // is defined as a non-zero exit, and there was no exit here at all.
          { stage: "pre-shell", launch: "not-attempted" },
        )
      }

      // `--` terminates option parsing, so a path shaped like a flag is treated
      // as a path and rejected by git rather than consumed by it. `--porcelain`
      // because the human-readable format's columns are locale- and
      // width-dependent, and the core has to parse this into a citation.
      return git(
        "git blame",
        ["git", "blame", "-L", `${startLine},${endLine}`, "--porcelain", "--", path],
        { path, startLine, endLine },
      )
    },

    // REJECT, DO NOT THROW (code review 2026-09-09).
    //
    // These are declared to return a `Promise` and used to throw before
    // returning one, so `tools.grep(x).catch(handle)` never reached `handle` —
    // the throw escaped the promise chain and took the caller down instead. The
    // point of a named error is that an accidental call is LOUD, not that it is
    // fatal in a way the caller cannot intercept. `judge.ts` wraps its `blame`
    // in a `try`/`catch` and would have caught either form; a future caller
    // written the ordinary async way would not have.
    readFile(_path: string): Promise<string> {
      return Promise.reject(new NotDrivenError("readFile"))
    },
    list(_glob: string): Promise<string[]> {
      return Promise.reject(new NotDrivenError("list"))
    },
    grep(_pattern: string, _glob?: string): Promise<GrepHit[]> {
      return Promise.reject(new NotDrivenError("grep"))
    },
    runTest(_selector?: string): Promise<CommandResult> {
      return Promise.reject(new NotDrivenError("runTest"))
    },
  }
}
