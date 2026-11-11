/**
 * The host's own record of MAD's session policy for a live attempt: the
 * `created` lines opencode logs for the sessions titled `MAD …`.
 *
 *   bun run v8-capture baseline --log <abs file> --out <abs file>
 *   bun run v8-capture after    --log <abs file> --baseline <abs file> --out <abs file>
 *
 * `baseline`, taken before an attempt, records the log's identity (device and
 * inode), its size as the start offset B, the SHA-256 of its first B bytes, and
 * whether B ends a line. A log that does not exist is a valid baseline with
 * B = 0, recorded as absent. `after`, taken once the attempt has ended, reads
 * exactly the bytes from B to the log's size at that moment, E, and keeps from
 * them only what the capture method allows.
 *
 * CONTINUITY. A path that is not a regular file is refused before it is opened,
 * and the log is opened read-only and non-blocking. The reads use one handle. The path's identity is
 * compared with the handle's before and after the reads, the handle's size is
 * checked again, and the first B bytes are hashed again from the handle and
 * compared with the baseline. A replacement or truncation that persists until
 * the second check is detected; one undone between the checks is not: the
 * checks are not an atomic snapshot. Appends after E are allowed and are not
 * captured. The first B bytes are hashed in bounded chunks; only the B-to-E
 * range is held in memory, and a range larger than the limit is refused.
 *
 * PARSING. Every complete line is decoded as strict UTF-8 and split into logfmt
 * fields before any filter; a line that is not valid UTF-8 is unparsed. Fields
 * are separated by single spaces, and an unquoted value holds no whitespace,
 * control character, `"`, `=` or `\`.
 * A quoted value is a JSON string token: it ends at the first `"` preceded by an
 * even number of backslashes, and is decoded as JSON. A line that does not split
 * is counted as unparsed and nothing of it is kept. Of the lines that split,
 * those whose `message` is `created` and whose `title` starts with `MAD ` are
 * candidates. A repeated `message` or `title`, a missing or repeated
 * `timestamp`, `run`, `id` or `directory` or `permission`, or a `permission`
 * that is not valid JSON makes a candidate unreadable, and only its `id` is
 * kept when it has exactly one. A trailing line without a newline is counted
 * as incomplete.
 *
 * WHAT IS KEPT. For each readable candidate: `timestamp`, `run`, `id`, `title`,
 * `directory` and the decoded `permission`, and whether that permission equals
 * `REVIEW_SESSION_PERMISSION` exactly (same rules, same order, no other key):
 * `expected` or `different`. Valid JSON of another shape is `different`. Nothing
 * else from the log is written, and no temporary file is made. The permission
 * value is kept raw: it is the host's record and is reviewed for credentials
 * before the evidence is shared.
 *
 * WHAT THIS IS NOT. A `created` line records the rules in the host's creation
 * object, logged before the session is published. An `expected` row is not an
 * observation that MAD accepted the echo before a prompt, and a `different` row
 * is not by itself a policy failure: both are diagnosed with the rest of the
 * evidence. The tool does not attribute lines to an attempt: the time window,
 * the reviewed repository and the operator's statement that no other MAD call
 * ran do that. `run` tokens are the logger's, not process ids. Coverage is what
 * was observed, never a complete census of MAD's sessions.
 *
 * EVIDENCE. Each record keeps the path's and the handle's device, inode and
 * size, each with the time it was observed, before and after the reads, and
 * the capture keeps E, the bytes read and expected, and the recomputed hash.
 * A failed read or stat of the opened log gives an unavailable record.
 *
 * EXIT. 0: a usable record was written (it may still contain `different` rows or
 * coverage gaps, which it flags). 1: a record was written whose status is
 * `unavailable`, with the reason; nothing in it is usable as a capture. 2: a
 * usage error, an invalid baseline, or an output that could not be created;
 * nothing usable is written. The output path must be absolute and must not
 * exist. Choosing an output outside the reviewed repository is the caller's
 * job: this tool does not know the repository.
 *
 * It reads only. It never runs `opencode`, starts a host or calls a provider.
 */

import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { open, stat, unlink } from "node:fs/promises"
import { isAbsolute } from "node:path"

import { REVIEW_SESSION_PERMISSION, type PermissionRule } from "../adapters/opencode/session-policy.ts"

export const BASELINE_KIND = "mad-v8-capture-baseline"
export const CAPTURE_KIND = "mad-v8-capture"
export const FORMAT_VERSION = 1
/** The largest B-to-E range held in memory. */
export const DEFAULT_RANGE_LIMIT_BYTES = 64 * 1024 * 1024
const HASH_CHUNK_BYTES = 1024 * 1024

/** The part of a file handle the tool uses: a seam for read and stat failures. */
export interface LogHandle {
  stat(): Promise<{ dev: number; ino: number; size: number; isFile(): boolean }>
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  close(): Promise<void>
}

export interface CaptureIo {
  out: (line: string) => void
  err: (line: string) => void
  now: () => Date
  rangeLimitBytes?: number
  /** Test seam: opens the log. Defaults to a non-blocking read-only open. */
  openLog?: (path: string) => Promise<LogHandle>
  /** Test seam: runs after the range is read and before the closing checks. */
  afterRangeRead?: () => Promise<void>
}

class UsageError extends Error {}

/** A failed read or stat of the log, after it was opened. */
class LogIoError extends Error {}

interface Observed {
  device: number
  inode: number
  size: number
  at: string
}

interface Baseline {
  kind: typeof BASELINE_KIND
  version: typeof FORMAT_VERSION
  status: "available" | "unavailable"
  reason?: string
  log: string
  takenAt: string
  absent: boolean
  device: number | null
  inode: number | null
  B: number
  prefixSha256: string | null
  checks?: Record<string, unknown>
}

type Comparison = "expected" | "different"

interface Row {
  timestamp: string
  run: string
  id: string
  title: string
  directory: string
  permission: unknown
  comparison: Comparison
}

interface UnreadableRow {
  id: string | null
  comparison: "unreadable"
}

export interface ParsedRange {
  completeLines: number
  incomplete: number
  unparsed: number
  rows: Row[]
  unreadable: UnreadableRow[]
}

// ---------------------------------------------------------------- parsing

const JSON_STRING = /"(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/y
/** A key or an unquoted value: no whitespace, no control character, no `"`, `=` or `\`. */
const BARE = /[^\s\u0000-\u001f\u007f"=\\]+/y

/** The logfmt fields of one line, in order, or `null` when it does not split. Fields are separated by single spaces. */
export function splitLogfmt(line: string): [string, string][] | null {
  const fields: [string, string][] = []
  let i = 0
  const n = line.length
  while (i < n) {
    if (line[i] === " ") {
      i++
      continue
    }
    BARE.lastIndex = i
    const key = BARE.exec(line)
    if (!key || line[i + key[0].length] !== "=") return null
    i += key[0].length + 1
    let value: string
    if (line[i] === '"') {
      JSON_STRING.lastIndex = i
      const token = JSON_STRING.exec(line)
      if (!token) return null
      try {
        value = JSON.parse(token[0]) as string
      } catch {
        return null
      }
      i += token[0].length
    } else if (i === n || line[i] === " ") {
      value = ""
    } else {
      BARE.lastIndex = i
      const bare = BARE.exec(line)
      if (!bare) return null
      value = bare[0]
      i += value.length
    }
    if (i < n && line[i] !== " ") return null
    fields.push([key[0], value])
  }
  return fields
}

function isExpectedRules(value: unknown, expected: readonly PermissionRule[]): boolean {
  if (!Array.isArray(value) || value.length !== expected.length) return false
  return value.every((rule, k) => {
    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) return false
    const keys = Object.keys(rule)
    const want = expected[k]!
    return (
      keys.length === 3 &&
      keys.every((key) => key === "permission" || key === "pattern" || key === "action") &&
      (rule as Record<string, unknown>).permission === want.permission &&
      (rule as Record<string, unknown>).pattern === want.pattern &&
      (rule as Record<string, unknown>).action === want.action
    )
  })
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true })

/**
 * The capture method's reading of the bytes from B to E. Each complete line is
 * decoded as strict UTF-8; one that is not valid UTF-8 is unparsed.
 */
export function parseRange(range: Uint8Array | string, expected: readonly PermissionRule[] = REVIEW_SESSION_PERMISSION): ParsedRange {
  const bytes = typeof range === "string" ? Buffer.from(range, "utf8") : Buffer.from(range.buffer, range.byteOffset, range.byteLength)
  const lines: Buffer[] = []
  let start = 0
  for (let k = 0; k < bytes.length; k++) {
    if (bytes[k] === 0x0a) {
      lines.push(bytes.subarray(start, k))
      start = k + 1
    }
  }
  const result: ParsedRange = { completeLines: lines.length, incomplete: start < bytes.length ? 1 : 0, unparsed: 0, rows: [], unreadable: [] }
  for (const raw of lines) {
    let line: string
    try {
      line = STRICT_UTF8.decode(raw)
    } catch {
      result.unparsed++
      continue
    }
    const fields = splitLogfmt(line)
    if (fields === null) {
      result.unparsed++
      continue
    }
    const byKey = new Map<string, string[]>()
    for (const [key, value] of fields) byKey.set(key, [...(byKey.get(key) ?? []), value])
    const messages = byKey.get("message") ?? []
    const titles = byKey.get("title") ?? []
    if (!messages.includes("created") || !titles.some((t) => t.startsWith("MAD "))) continue
    const ids = byKey.get("id") ?? []
    const single = (key: string) => {
      const values = byKey.get(key) ?? []
      return values.length === 1 ? values[0]! : null
    }
    const unreadable = () => result.unreadable.push({ id: ids.length === 1 ? ids[0]! : null, comparison: "unreadable" })
    if (messages.length !== 1 || titles.length !== 1) {
      unreadable()
      continue
    }
    const timestamp = single("timestamp")
    const run = single("run")
    const id = single("id")
    const directory = single("directory")
    const permissionText = single("permission")
    if (timestamp === null || run === null || id === null || directory === null || permissionText === null) {
      unreadable()
      continue
    }
    let permission: unknown
    try {
      permission = JSON.parse(permissionText)
    } catch {
      unreadable()
      continue
    }
    result.rows.push({
      timestamp,
      run,
      id,
      title: titles[0]!,
      directory,
      permission,
      comparison: isExpectedRules(permission, expected) ? "expected" : "different",
    })
  }
  return result
}

// ---------------------------------------------------------------- files

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined
}

/** Runs a read or stat of the opened log; a file-system failure becomes a `LogIoError`. */
async function logIo<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (errorCode(error) !== undefined) throw new LogIoError("a read or stat of the log failed")
    throw error
  }
}

async function defaultOpenLog(path: string): Promise<LogHandle> {
  return open(path, constants.O_RDONLY | constants.O_NONBLOCK)
}

function observe(s: { dev: number; ino: number; size: number }, io: CaptureIo): Observed {
  return { device: s.dev, inode: s.ino, size: s.size, at: io.now().toISOString() }
}

function sameFile(a: { device: number; inode: number }, b: { device: number; inode: number }): boolean {
  return a.device === b.device && a.inode === b.inode
}

async function readExact(handle: LogHandle, position: number, length: number): Promise<Buffer | null> {
  const buffer = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const { bytesRead } = await logIo(() => handle.read(buffer, done, length - done, position + done))
    if (bytesRead === 0) return null
    done += bytesRead
  }
  return buffer
}

/** SHA-256 of the first `length` bytes, read in bounded chunks, or `null` on a short read. */
async function hashPrefix(handle: LogHandle, length: number): Promise<string | null> {
  const hash = createHash("sha256")
  let position = 0
  while (position < length) {
    const chunk = await readExact(handle, position, Math.min(HASH_CHUNK_BYTES, length - position))
    if (chunk === null) return null
    hash.update(chunk)
    position += chunk.length
  }
  return hash.digest("hex")
}

/** Opens a regular log without blocking, or says why not. */
async function openRegular(log: string, io: CaptureIo): Promise<{ handle: LogHandle; path: Observed } | { reason: string; absent: boolean }> {
  let pathStat
  try {
    pathStat = await stat(log)
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { reason: "the log does not exist", absent: true } : { reason: "the log could not be examined", absent: false }
  }
  if (!pathStat.isFile()) return { reason: "the log is not a regular file", absent: false }
  const path = observe(pathStat, io)
  try {
    return { handle: await (io.openLog ?? defaultOpenLog)(log), path }
  } catch (error) {
    if (errorCode(error) === undefined) throw error
    return { reason: "the log could not be opened for reading", absent: false }
  }
}

async function writeRecord(path: string, record: unknown): Promise<void> {
  const handle = await open(path, "wx", 0o600)
  let created
  try {
    created = await handle.stat()
    await handle.writeFile(JSON.stringify(record, null, 2) + "\n")
  } catch (error) {
    await handle.close().catch(() => {})
    // Remove the partial record only while the path still names the file this call created.
    const now = await stat(path).catch(() => null)
    if (created && now && now.dev === created.dev && now.ino === created.ino) await unlink(path).catch(() => {})
    throw error
  }
  await handle.close()
}

// ---------------------------------------------------------------- commands

async function takeBaseline(log: string, io: CaptureIo): Promise<Baseline> {
  const takenAt = io.now().toISOString()
  const base = { kind: BASELINE_KIND, version: FORMAT_VERSION, log, takenAt } as const
  const unavailable = (reason: string, checks: Record<string, unknown> = {}): Baseline => ({
    ...base,
    status: "unavailable",
    reason,
    absent: false,
    device: null,
    inode: null,
    B: 0,
    prefixSha256: null,
    checks,
  })
  const opened = await openRegular(log, io)
  if ("reason" in opened) {
    if (opened.absent) return { ...base, status: "available", absent: true, device: null, inode: null, B: 0, prefixSha256: null, checks: { absentAt: takenAt } }
    return unavailable(opened.reason)
  }
  const { handle } = opened
  const checks: Record<string, unknown> = { pathBefore: opened.path }
  try {
    const first = await logIo(() => handle.stat())
    checks.handleBefore = observe(first, io)
    if (!first.isFile()) return unavailable("the log is not a regular file", checks)
    if (!sameFile(checks.handleBefore as Observed, opened.path)) return unavailable("the log was replaced while it was opened", checks)
    const B = first.size
    if (!Number.isSafeInteger(B)) return unavailable("the log's size is not a safe integer", checks)
    const prefixSha256 = await hashPrefix(handle, B)
    if (prefixSha256 === null) return unavailable("the log became shorter while it was hashed", checks)
    if (B > 0) {
      const last = await readExact(handle, B - 1, 1)
      if (last === null) return unavailable("the log became shorter while it was hashed", checks)
      if (last[0] !== 0x0a) return unavailable("the log does not end a line at its current size, so B is not on a line boundary", checks)
    }
    const second = await logIo(() => handle.stat())
    checks.handleAfter = observe(second, io)
    const pathAfter = await stat(log).catch(() => null)
    checks.pathAfter = pathAfter === null ? null : observe(pathAfter, io)
    if (pathAfter === null || !sameFile(checks.pathAfter as Observed, checks.handleBefore as Observed)) return unavailable("the log was replaced while it was hashed", checks)
    if (second.size < B || pathAfter.size < B) return unavailable("the log became shorter while it was hashed", checks)
    return { ...base, status: "available", absent: false, device: first.dev, inode: first.ino, B, prefixSha256, checks }
  } catch (error) {
    if (error instanceof LogIoError) return unavailable(error.message, checks)
    throw error
  } finally {
    await handle.close().catch(() => {})
  }
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function validBaseline(value: unknown, log: string): Baseline {
  if (typeof value !== "object" || value === null) throw new UsageError("the baseline is not a JSON object")
  const b = value as Record<string, unknown>
  const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0
  if (b.kind !== BASELINE_KIND || b.version !== FORMAT_VERSION) throw new UsageError("the baseline is not a v8-capture baseline of this version")
  if (b.status !== "available") throw new UsageError("the baseline's status is not available, so no capture can rest on it")
  if (b.log !== log) throw new UsageError("the baseline names a different log")
  if (typeof b.takenAt !== "string" || !ISO_INSTANT.test(b.takenAt) || Number.isNaN(Date.parse(b.takenAt))) throw new UsageError("the baseline's takenAt is not an ISO instant")
  if (typeof b.absent !== "boolean") throw new UsageError("the baseline's absent field is malformed")
  if (!count(b.B)) throw new UsageError("the baseline's B is not a non-negative safe integer")
  if (b.absent) {
    if (b.B !== 0 || b.device !== null || b.inode !== null || b.prefixSha256 !== null) throw new UsageError("an absent baseline must have B = 0 and no identity or hash")
  } else {
    if (!count(b.device) || !count(b.inode)) throw new UsageError("the baseline's identity is not a pair of non-negative safe integers")
    if (typeof b.prefixSha256 !== "string" || !/^[0-9a-f]{64}$/.test(b.prefixSha256)) throw new UsageError("the baseline's prefix hash is malformed")
  }
  return b as unknown as Baseline
}

async function capture(log: string, baseline: Baseline, baselinePath: string, io: CaptureIo) {
  const limit = io.rangeLimitBytes ?? DEFAULT_RANGE_LIMIT_BYTES
  const startedAt = io.now().toISOString()
  const head = { kind: CAPTURE_KIND, version: FORMAT_VERSION, log, baseline: baselinePath, B: baseline.B, startedAt }
  const notes = [
    "Attribution to an attempt is not performed: it needs the time window, the reviewed repository and the operator's statement that no other MAD call ran.",
    "An expected row is the host's record of the rules at creation, not an observation that MAD accepted the echo before a prompt; a different row is diagnosed, not by itself a failure.",
    "Permission values are kept raw and are reviewed for credentials before the evidence is shared.",
    "Run tokens are the logger's, not process ids; coverage is what was observed, not a census.",
  ]
  const checks: Record<string, unknown> = {}
  const unavailable = (reason: string) => ({ ...head, status: "unavailable" as const, reason, finishedAt: io.now().toISOString(), checks, notes })
  const opened = await openRegular(log, io)
  if ("reason" in opened) return unavailable(opened.reason)
  const { handle } = opened
  checks.pathBefore = opened.path
  try {
    const fdBefore = await logIo(() => handle.stat())
    const handleBefore = observe(fdBefore, io)
    checks.handleBefore = handleBefore
    if (!fdBefore.isFile()) return unavailable("the log is not a regular file")
    if (!sameFile(handleBefore, opened.path)) return unavailable("the log was replaced while it was opened")
    if (!baseline.absent && !sameFile(handleBefore, { device: baseline.device!, inode: baseline.inode! })) return unavailable("the log is not the file the baseline recorded")
    const E = fdBefore.size
    checks.E = E
    if (!Number.isSafeInteger(E)) return unavailable("the log's size is not a safe integer")
    if (E < baseline.B) return unavailable("the log is shorter than the baseline's B")
    if (E - baseline.B > limit) return unavailable(`the range from B to E is larger than the ${limit}-byte limit`)
    checks.expectedBytes = E - baseline.B
    const range = await readExact(handle, baseline.B, E - baseline.B)
    checks.bytesRead = range?.length ?? null
    if (range === null) return unavailable("the range could not be read in full")
    if (io.afterRangeRead) await io.afterRangeRead()
    const prefix = baseline.B === 0 ? null : await hashPrefix(handle, baseline.B)
    checks.recomputedPrefixSha256 = prefix
    if (baseline.B > 0 && prefix !== baseline.prefixSha256) return unavailable("the first B bytes no longer match the baseline")
    const fdAfter = await logIo(() => handle.stat())
    checks.handleAfter = observe(fdAfter, io)
    const pathAfter = await stat(log).catch(() => null)
    checks.pathAfter = pathAfter === null ? null : observe(pathAfter, io)
    if (pathAfter === null || !sameFile(checks.pathAfter as Observed, handleBefore)) return unavailable("the log was replaced during the capture")
    if (fdAfter.size < E || pathAfter.size < E) return unavailable("the log became shorter than E during the capture")
    const parsed = parseRange(range)
    const counts = { completeLines: parsed.completeLines, incomplete: parsed.incomplete, unparsed: parsed.unparsed, unreadable: parsed.unreadable.length, madCreatedRows: parsed.rows.length }
    return {
      ...head,
      status: "available" as const,
      E,
      finishedAt: io.now().toISOString(),
      checks,
      counts,
      coverageLimited: counts.incomplete > 0 || counts.unparsed > 0 || counts.unreadable > 0,
      differentRows: parsed.rows.filter((row) => row.comparison === "different").length,
      observedRunTokens: [...new Set(parsed.rows.map((row) => row.run))].sort(),
      observedDirectories: [...new Set(parsed.rows.map((row) => row.directory))].sort(),
      rows: parsed.rows,
      unreadableRows: parsed.unreadable,
      notes,
    }
  } catch (error) {
    if (error instanceof LogIoError) return unavailable(error.message)
    throw error
  } finally {
    await handle.close().catch(() => {})
  }
}

function options(argv: readonly string[], allowed: readonly string[]): Map<string, string> {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!
    const value = argv[i + 1]
    if (!allowed.includes(flag) || value === undefined || values.has(flag)) throw new UsageError(`unexpected argument ${JSON.stringify(flag)}`)
    if (!isAbsolute(value)) throw new UsageError(`${flag} must be an absolute path`)
    values.set(flag, value)
  }
  for (const flag of allowed) if (!values.has(flag)) throw new UsageError(`${flag} is required`)
  const outPath = values.get("--out")
  for (const [flag, path] of values) if (flag !== "--out" && path === outPath) throw new UsageError(`--out must differ from ${flag}`)
  return values
}

const USAGE = "usage: v8-capture baseline --log <abs file> --out <abs file> | after --log <abs file> --baseline <abs file> --out <abs file>"

export async function runV8Capture(argv: readonly string[], io: CaptureIo): Promise<number> {
  let record: { status: "available" | "unavailable"; reason?: string }
  let out: string
  try {
    if (io.rangeLimitBytes !== undefined && (!Number.isSafeInteger(io.rangeLimitBytes) || io.rangeLimitBytes < 0))
      throw new UsageError("the range limit is not a non-negative safe integer")
    const [command, ...rest] = argv
    if (command === "baseline") {
      const opts = options(rest, ["--log", "--out"])
      out = opts.get("--out")!
      record = await takeBaseline(opts.get("--log")!, io)
    } else if (command === "after") {
      const opts = options(rest, ["--log", "--baseline", "--out"])
      out = opts.get("--out")!
      const log = opts.get("--log")!
      let parsed: unknown
      try {
        parsed = JSON.parse(await Bun.file(opts.get("--baseline")!).text())
      } catch {
        throw new UsageError("the baseline could not be read as JSON")
      }
      record = await capture(log, validBaseline(parsed, log), opts.get("--baseline")!, io)
    } else {
      throw new UsageError(USAGE)
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`v8-capture: ${error.message}`)
      return 2
    }
    throw error
  }
  try {
    await writeRecord(out, record)
  } catch (error) {
    io.err(errorCode(error) === "EEXIST" ? `v8-capture: ${out} already exists; nothing was written` : `v8-capture: the record could not be written to ${out}`)
    return 2
  }
  if (record.status === "unavailable") {
    io.out(`unavailable: ${record.reason}; recorded in ${out}`)
    return 1
  }
  io.out(`recorded in ${out}`)
  return 0
}

if (import.meta.main) {
  const code = await runV8Capture(process.argv.slice(2), {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    now: () => new Date(),
  })
  process.exit(code)
}
