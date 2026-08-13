/**
 * AD-13 / CAP-8 — the `Tools` port: repo and git-history evidence, executed by
 * the HOST (host-integration.md: tool execution is the host's).
 *
 * Interfaces only (AD-1). Story 1 does not drive this port — the fact-checker
 * that needs it is story 6 — but the shape is fixed here so no stage invents
 * its own tool surface. An in-host backend uses this port; an out-of-process
 * backend has no access to it and declares `tools: true` to say it has its own.
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
