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
 */

import type { PluginInput } from "@opencode-ai/plugin"

import type { CommandResult, GrepHit, Tools } from "../../core/ports/tools.ts"
import { GitError } from "./repo.ts"

type Shell = PluginInput["$"]

export interface OpencodeToolsOptions {
  $: Shell
  worktree: string
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

export function opencodeTools(options: OpencodeToolsOptions): Tools {
  const $ = options.$.cwd(options.worktree).nothrow()

  /**
   * Identical to `repo.ts`'s helper, deliberately: `.nothrow()` gives us control
   * over a non-zero exit, and silence is not control. Read the exit code and say
   * what happened.
   */
  async function git(command: string, argv: string[]): Promise<string> {
    const result = await $`git ${argv}`
    if (result.exitCode !== 0) throw new GitError(command, result.stderr.toString())
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
        throw new GitError(
          "git blame",
          `refusing to blame ${JSON.stringify(path)} over the line range ${startLine},${endLine}: ` +
            `a range must be two whole numbers, 1-indexed, with the end at or after the start`,
        )
      }

      // `--` terminates option parsing, so a path shaped like a flag is treated
      // as a path and rejected by git rather than consumed by it. `--porcelain`
      // because the human-readable format's columns are locale- and
      // width-dependent, and the core has to parse this into a citation.
      return git("git blame", [
        "blame",
        "-L",
        `${startLine},${endLine}`,
        "--porcelain",
        "--",
        path,
      ])
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
