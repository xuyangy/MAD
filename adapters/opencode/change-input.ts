/**
 * Reading the change's file names, and checking an untracked entry before git
 * reads it (spec-mad-v1-readiness CAP-4). Used by `./repo.ts` under the
 * read-only policy only.
 *
 * NAMES come from `-z` output, parsed strictly. Nothing is trimmed, C-unquoted
 * or passed through a shell. The launcher decodes stdout as UTF-8 with
 * replacement, so a name holding U+FFFD is refused: MAD cannot tell an
 * invalid byte from a literal U+FFFD, and reviewing the replacement would
 * review a different name. That refuses a file whose name really contains
 * U+FFFD too, an intentional restriction.
 *
 * THE PRECHECK never reads content and never opens a symlink's target. A
 * regular file is opened with `O_RDONLY | O_NONBLOCK | O_NOFOLLOW` and checked
 * with `fstat` on the handle, which is then closed. `O_NONBLOCK` keeps a FIFO
 * swapped in from stalling the open; it does not bound how long a file
 * system takes to answer, so the caller bounds its own wait, and a handle that
 * arrives after MAD stopped waiting is closed by a continuation. A bounded
 * wait does not cancel the operation itself. The check is not a snapshot:
 * git's read is validated separately.
 */

import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { join } from "node:path"

import { LINE_BREAKS } from "../../core/prompt/material.ts"

/** Why an input is refused. Each is a fact MAD observed. */
export type InputProblem =
  | "vanished"
  | "unreadable"
  | "directory"
  | "special"
  | "changed"
  | "unrepresentable"
  | "malformed"
  | "no-change-text"
  | "platform"
  | "check-failed"
  | "git-unread"

const REASONS: Record<InputProblem, string> = {
  vanished: "it no longer exists",
  unreadable: "it cannot be read",
  directory: "it is a directory or a nested repository, which MAD does not review",
  special: "it is a special file (a FIFO, socket or device), which MAD does not read",
  changed: "it changed while MAD was checking or reading it",
  unrepresentable: "its name is not text MAD can represent exactly (it holds U+FFFD, possibly for bytes that are not UTF-8)",
  malformed: "git's list of names was not in the form MAD reads",
  "no-change-text": "git listed changed files but returned no change text for them",
  platform: "this platform cannot check an untracked file without a blocking open",
  "check-failed": "MAD's file-system check of it failed with an error",
  "git-unread": "git could not read it",
}

/** The fixed reason for a problem. */
export function inputReason(problem: InputProblem): string {
  return REASONS[problem]
}

/**
 * A name as one quoted, line-safe token: `JSON.stringify` escapes quotes and
 * control characters, and every other line break MAD knows of (U+0085,
 * U+2028, U+2029) is escaped as `\uXXXX`, so no name can start a line.
 */
export function lineSafeName(name: string): string {
  let quoted = JSON.stringify(name)
  for (const ch of LINE_BREAKS) {
    if (quoted.includes(ch)) quoted = quoted.split(ch).join(`\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)
  }
  return quoted
}

/**
 * `-z` output as names. Empty output is no names; anything else must end in
 * NUL and contain no empty name.
 */
export function parseNulNames(stdout: string): { names: string[] } | { problem: "malformed" | "unrepresentable" } {
  if (stdout.length === 0) return { names: [] }
  if (!stdout.endsWith("\0")) return { problem: "malformed" }
  const names = stdout.slice(0, -1).split("\0")
  if (names.some((name) => name.length === 0)) return { problem: "malformed" }
  if (names.some((name) => name.includes("�"))) return { problem: "unrepresentable" }
  return { names }
}

/** What a regular file's handle says when MAD opened it. */
export type OpenedKind = "file" | "other"

/** An open descriptor: its type on request, and its close. */
export interface OpenedHandle {
  kind(): Promise<OpenedKind>
  close(): Promise<void>
}

/** The file-system calls the precheck makes. A test seam; the default is `node:fs`. */
export interface InputFs {
  /** `lstat`: what the entry itself is, never what a link points to. */
  lstat(path: string): Promise<"file" | "symlink" | "directory" | "other">
  /**
   * Opens without blocking or following. Reads nothing. The handle comes back
   * as soon as the descriptor exists, so the caller owns it before asking its
   * type, and closes it.
   */
  openNoFollow(path: string): Promise<OpenedHandle>
  /** Whether non-blocking, no-follow opens exist on this platform. */
  readonly supported: boolean
}

export const nodeInputFs: InputFs = {
  supported: typeof constants.O_NOFOLLOW === "number" && typeof constants.O_NONBLOCK === "number",
  async lstat(path) {
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) return "symlink"
    if (stats.isDirectory()) return "directory"
    if (stats.isFile()) return "file"
    return "other"
  },
  async openNoFollow(path) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    return {
      kind: async () => ((await handle.stat()).isFile() ? "file" : "other"),
      close: () => handle.close(),
    }
  },
}

/** The error code of a file-system failure, when there is one. */
function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" ? code : undefined
}

/** What the precheck found: fine, a refusal reason, no answer within the wait, or the caller's stop. */
export type PrecheckOutcome = { ok: true } | { problem: InputProblem } | { unanswered: true } | { stopped: true }

/**
 * Checks one untracked entry, waiting at most `waitMs`.
 *
 * ONCE THE WAIT HAS ENDED, NOTHING FURTHER IS STARTED: an `lstat` answering
 * late does not lead to an open. A descriptor is owned from the moment the
 * open returns. When the wait ends while it is open, even with its type query
 * still pending, one close is attempted at once. A close that fails is not
 * proof the descriptor closed, and nothing here claims it did. A late failure
 * is consumed.
 */
export async function precheckUntracked(
  worktree: string,
  name: string,
  waitMs: number,
  fs: InputFs = nodeInputFs,
  signal?: AbortSignal,
): Promise<PrecheckOutcome> {
  // CAP-5 — a stop ends the wait exactly as expiry does, so nothing starts
  // after it, and kernel work already started is not called cancelled.
  if (signal?.aborted) return { stopped: true }
  if (name.endsWith("/")) return { problem: "directory" }
  if (!fs.supported) return { problem: "platform" }
  const path = join(worktree, name)

  let expired = false
  let handle: OpenedHandle | undefined
  let closing: Promise<void> | undefined
  const closeOnce = (): Promise<void> => {
    if (handle === undefined) return Promise.resolve()
    closing ??= handle.close().catch(() => undefined)
    return closing
  }

  const check = (async (): Promise<PrecheckOutcome> => {
    let kind: Awaited<ReturnType<InputFs["lstat"]>>
    try {
      kind = await fs.lstat(path)
    } catch (error) {
      const code = codeOf(error)
      if (code === "ENOENT") return { problem: "vanished" }
      if (code === "EACCES" || code === "EPERM") return { problem: "unreadable" }
      if (code === "ENOTDIR") return { problem: "changed" }
      return { problem: "check-failed" }
    }
    if (kind === "symlink") return { ok: true }
    if (kind === "directory") return { problem: "directory" }
    if (kind === "other") return { problem: "special" }
    if (expired) return { unanswered: true }
    try {
      handle = await fs.openNoFollow(path)
    } catch (error) {
      const code = codeOf(error)
      if (code === "ENOENT") return { problem: "vanished" }
      if (code === "EACCES" || code === "EPERM") return { problem: "unreadable" }
      if (code === "ELOOP" || code === "ENOTDIR") return { problem: "changed" }
      if (code === "ENXIO") return { problem: "special" }
      return { problem: "check-failed" }
    }
    if (expired) {
      await closeOnce()
      return { unanswered: true }
    }
    try {
      return (await handle.kind()) === "file" ? { ok: true } : { problem: "changed" }
    } catch {
      return { problem: "check-failed" }
    } finally {
      await closeOnce()
    }
  })()

  let timer: ReturnType<typeof setTimeout> | undefined
  let onStop: (() => void) | undefined
  const end = (outcome: PrecheckOutcome, resolve: (value: PrecheckOutcome) => void) => {
    expired = true
    // A descriptor already open is closed now, not after its type query.
    void closeOnce()
    resolve(outcome)
  }
  try {
    return await Promise.race<PrecheckOutcome>([
      check,
      new Promise<PrecheckOutcome>((resolve) => {
        timer = setTimeout(() => end({ unanswered: true }, resolve), waitMs)
      }),
      new Promise<PrecheckOutcome>((resolve) => {
        if (signal === undefined) return
        onStop = () => end({ stopped: true }, resolve)
        signal.addEventListener("abort", onStop, { once: true })
        if (signal.aborted) onStop()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (onStop !== undefined) signal?.removeEventListener("abort", onStop)
    check.catch(() => undefined)
  }
}
