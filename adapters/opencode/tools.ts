/**
 * The `Tools` port over opencode's host shell — AD-13's FIRST route, driven for
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
 * ## One git wrapper in this adapter, not two
 *
 * `$`, `.cwd(worktree).nothrow()` and `GitError` all come from `./repo.ts`
 * unchanged, and `GitError` is IMPORTED rather than re-declared. A second,
 * differently-behaved git wrapper in one adapter is the duplication the epic-1
 * retrospective's F11 warns about — and the behaviour that must not diverge is
 * the important one: `.nothrow()` keeps a non-zero exit from throwing, so
 * without reading `exitCode` a failed blame degrades into empty output, which
 * downstream reads as "blame found nothing to contradict". A failure must never
 * read as a pass (AD-6).
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
 * It goes to git as its OWN argv element after `--`, never inside a composed
 * shell string. Bun's `$` interpolates an array as separate, escaped arguments,
 * which is the same property `repo.ts` relies on.
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
 * ## WHAT THE PINNED HOST SHELL ESTABLISHES, AND WHAT IT DOES NOT
 *
 * `options.$` is `PluginInput["$"]` from `@opencode-ai/plugin` 1.18.18, which
 * re-exports Bun's shell. Story 2-7a's tool-action mapping is written against
 * this read of `node_modules/@opencode-ai/plugin/dist/shell.d.ts` and against
 * what pinned Bun 1.3.14 was observed to do, because a mapping written from
 * assumption would report launch failures as git failures.
 *
 * WHAT THE INTERFACE CARRIES. `BunShellOutput` is exactly `stdout`, `stderr`,
 * `exitCode` and decoders over stdout. There is NO pid, NO termination signal
 * and NO launched/not-launched flag. `nothrow()` turns a non-zero exit into a
 * resolved value rather than a rejection. So the pinned interface, on its own,
 * establishes only two things: a ZERO exit means the program ran to completion
 * successfully, and a REJECTION means MAD got no answer at all.
 *
 * WHAT A NON-ZERO EXIT DOES NOT ESTABLISH. Nothing in the type distinguishes
 * "git ran and refused" from "git never started". `git blame` over a bad path or
 * a bad range exits 128 with git's own `fatal:` text on stderr; that is a git
 * failure, and a reader cannot prove it is one from `exitCode` alone.
 *
 * WHERE THE HOST DOES DOCUMENT A DISTINCTION, IT IS USED — AND ONLY WHERE THE
 * HOST ITSELF WROTE IT. A command the shell cannot find is reported BY THE
 * SHELL, not by the program: under `nothrow()` it resolves with `exitCode` **1**
 * and stderr that is exactly `bun: command not found: <name>`. It is NOT the 127
 * a POSIX shell would give, so an exit-code test for 127 would have been wrong.
 * That marker is the one positive launch-failure signal available here, and
 * `launchEvidenceFrom` below is where it is read.
 *
 * THE MARKER IS ANCHORED AT THE START OF STDERR, not at the start of any line,
 * and that distinction is load-bearing rather than tidy. `Finding.locus.file` is
 * a model's free string which may contain a newline (see above), and git echoes
 * the path verbatim into `fatal: no such path '<path>' in HEAD`. A line-anchored
 * marker would therefore let a path carrying `\nbun: command not found: git`
 * turn a `git blame` that really executed into "the command was never found" —
 * untrusted text deciding an execution count, which is the exact inversion this
 * seam exists to prevent. The host writes its own line as the whole of stderr,
 * so the start of stderr is where it is looked for.
 * `adapters/opencode/tools-observation.test.ts` asserts both halves against the
 * real host rather than against a faked exit code.
 *
 * A REJECTION CARRIES NO EXIT CODE. A worktree that does not exist rejects with
 * a plain `Error: No such file or directory` and no `exitCode` field — so an
 * interrupted or exceptional call yields **no** launch evidence, and the
 * execution reading for it is `unknown` rather than false.
 */

import type { PluginInput } from "@opencode-ai/plugin"

import type { Clock } from "../../core/ports/clock.ts"
import { systemClock } from "../../core/ports/clock.ts"
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
import { GitError } from "./repo.ts"

type Shell = PluginInput["$"]

export interface OpencodeToolsOptions {
  $: Shell
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
}

/**
 * The host's own command-not-found line, which the SHELL writes and a program
 * never does.
 *
 * MATCHED AT THE START OF STDERR, NEVER AT THE START OF A LINE. See this file's
 * header: git echoes a model-supplied path into its own `fatal:` line, so a
 * line-anchored marker hands an attacker a way to turn a real execution into
 * "never launched". The host emits this line as the whole of stderr.
 */
const COMMAND_NOT_FOUND = "bun: command not found: "

/**
 * What a finished shell call establishes about whether the program launched.
 * Exported so the host semantics behind it are testable against the real host.
 * See this file's header for the read it is written from.
 */
export function launchEvidenceFrom(exitCode: number, stderr: string): LaunchEvidence {
  if (exitCode === 0) return "proved"
  return stderr.startsWith(COMMAND_NOT_FOUND) ? "failed" : "unproved"
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
  const $ = options.$.cwd(options.worktree).nothrow()
  const observation = options.toolObservation
  const clock = options.clock ?? systemClock()

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
   * The inner catch exists because a broken observer may break there too; at
   * that point there is no channel left, and a `git blame` must not fail because
   * its trace could not be written.
   */
  async function observe(
    write: ToolObservationWrite,
    send: (sink: ToolObservation) => Promise<void>,
  ): Promise<void> {
    if (observation === undefined) return
    try {
      await send(observation)
    } catch (error) {
      try {
        observation.failed({
          where: "adapter",
          write,
          why: error instanceof Error ? error.message : String(error),
        })
      } catch {
        // The last resort failed too. There is no second channel at this layer.
      }
    }
  }

  /**
   * Identical to `repo.ts`'s helper, deliberately: `.nothrow()` gives us control
   * over a non-zero exit, and silence is not control. Read the exit code and say
   * what happened.
   *
   * THE INVOCATION AND THE RETURN ARE TWO FACTS (story 2-7a). The invocation is
   * written BEFORE the call is awaited, so a call that never comes back still
   * leaves the record that something was launched at; the shell's outcome is
   * written after, with what the pinned interface actually established about the
   * launch. Entering this function is neither fact.
   */
  async function git(command: string, argv: string[], args: BlameArguments): Promise<string> {
    await observe("invoked", (sink) =>
      sink.invoked({ tool: "blame", args, argv: ["git", ...argv], at: clock.now() }),
    )
    // A REJECTION IS NOT OBSERVED AS AN OUTCOME, because there is none: no exit
    // code, so no launch evidence, so the reading is `unknown` and the error
    // carries nothing that would upgrade it.
    const result = await $`git ${argv}`
    const stderr = result.stderr.toString()
    const launch = launchEvidenceFrom(result.exitCode, stderr)
    await observe("shellOutcome", (sink) =>
      sink.shellOutcome({
        tool: "blame",
        args,
        exitCode: result.exitCode,
        launch,
        stderr: clipStderr(stderr),
        at: clock.now(),
      }),
    )
    if (result.exitCode !== 0) {
      throw withEvidence(new GitError(command, stderr), {
        stage: "shell",
        exitCode: result.exitCode,
        launch,
      })
    }
    return result.stdout.toString()
  }

  return {
    async blame(path: string, startLine: number, endLine: number): Promise<string> {
      // A RANGE CHECK BEFORE THE SHELL, not after. `-L` takes `<start>,<end>`
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
        // SEPARABLE FROM EVERY LATER FAILURE (story 2-7a). No shell ran, so this
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
        ["blame", "-L", `${startLine},${endLine}`, "--porcelain", "--", path],
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
