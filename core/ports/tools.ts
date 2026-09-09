/**
 * AD-13 / CAP-8 — the `Tools` port: repo and git-history evidence.
 *
 * Interfaces only (AD-1). The core DRIVES this port; it never constructs one —
 * an implementation lives in `adapters/opencode/`, which is where execution
 * belongs (`host-integration.md`: tool execution is the host's).
 *
 * ## What is driven, as of story 10 (2026-09-08)
 *
 * - `blame` — DRIVEN. `adapters/opencode/tools.ts` implements it and
 *   `core/stages/judge.ts` calls it itself, for a finding whose locus carries a
 *   line range. That is AD-13's FIRST route, and it is what makes a check MAD
 *   executed distinguishable in the record from a check a model reported.
 * - `readFile`, `list`, `grep`, `runTest` — STILL UNDRIVEN. The shipped adapter
 *   throws a named `NotDrivenError` for each, so an accidental call is loud
 *   rather than silently wrong. `runTest` is the one with a real permission
 *   surface and is deliberately last.
 *
 * ## AD-13's two routes are still two
 *
 * Story 6 took the SECOND route — an out-of-process backend relies on its own
 * agent's tools, which is what `adapters/opencode/model-backend.ts` provides —
 * and that route is not removed or deprecated by story 10. A slot whose backend
 * brings its own tools is still a valid fact-check slot; a run with no `Tools`
 * port injected still fact-checks, and the run record says which route ran.
 *
 * ## The shape does not change
 *
 * It has been fixed since story 1 so that no stage invents its own tool surface.
 * Widening it is a spine-level argument, not a story.
 */
export interface GrepHit {
  file: string
  line: number
  text: string
}

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface Tools {
  /** Read a repo-relative POSIX path. */
  readFile(path: string): Promise<string>
  /** List repo-relative paths matching a glob. */
  list(glob: string): Promise<string[]>
  /** Search file contents. */
  grep(pattern: string, glob?: string): Promise<GrepHit[]>
  /** `git blame` for a line range, 1-indexed and inclusive. */
  blame(path: string, startLine: number, endLine: number): Promise<string>
  /** Run the project's tests, or a subset. Where the token budget earns its keep. */
  runTest(selector?: string): Promise<CommandResult>
}
