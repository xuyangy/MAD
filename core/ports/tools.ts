/**
 * AD-13 / CAP-8 — the `Tools` port: repo and git-history evidence, executed by
 * the HOST (host-integration.md: tool execution is the host's).
 *
 * Interfaces only (AD-1), and STILL UNDRIVEN after story 6 (code review
 * 2026-08-28). Story 6 shipped the fact-checker and took AD-13's SECOND route:
 * `adapters/opencode/model-backend.ts` is out-of-process and declares
 * `tools: true` to say it has its own, so nothing imports this port beyond
 * `hasTools` / `factCheckTooled`. The header used to point the reader at story 6
 * as the story that would drive it. The shape is still fixed here so no stage
 * invents its own tool surface, and the consequence of the route taken —
 * that MAD reads a declared capability rather than proving a check happened — is
 * filed in `deferred-work.md`, not hidden here.
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
