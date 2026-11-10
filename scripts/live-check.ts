/**
 * The before/after check of a live review under spec-mad-v1-live.
 *
 *   bun run live-check before --repo <abs dir> --out <abs file>
 *   bun run live-check after  --repo <abs dir> --before <abs file> --out <abs file>
 *
 * `before` writes a snapshot of the reviewed repository (`scripts/repo-state.ts`:
 * tracked and untracked bytes by digest, permission bits, symlinks, the staged
 * index path by path, HEAD and refs, every path by its exact name bytes) and a
 * record of this MAD checkout: its full commit id, its `git status` entries,
 * the tracked paths flagged assume-unchanged or skip-worktree, and a digest of
 * its staged content and of every tracked and untracked file as it is on disk. `after` writes
 * the same, compares the repository and the MAD record with the `before` file,
 * prints every difference, naming each staged path that changed and marking a
 * change to the MAD checkout as its own, and exits 1 when there is any. A
 * usage error, a refused repository or a malformed `before` record exits 2,
 * and nothing is written.
 *
 * Every git read here, of the reviewed repository and of the MAD checkout,
 * runs under the review's read-only git policy
 * (`adapters/opencode/git-read-policy.ts`): no pager, external diff, text
 * conversion or file-system monitor, no inherited `GIT_*` variable, no
 * transport. A repository whose effective config defines an executable filter
 * driver is refused before any read, as the review itself refuses it.
 *
 * It reads only. It never runs `opencode`, calls a provider, or writes inside
 * the reviewed repository: `--out` there is refused.
 */

import { createHash } from "node:crypto"
import { lstat, readFile, readlink, realpath, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"

import {
  configuredFilters,
  filterRefusalReason,
  FILTER_PREFLIGHT,
  readOnlyGitArgv,
  readOnlyGitEnv,
} from "../adapters/opencode/git-read-policy.ts"
import {
  differences,
  indexDifferences,
  snapshot,
  snapshotFromJson,
  snapshotToJson,
  type GitReader,
  type SnapshotJson,
} from "./repo-state.ts"

/** This MAD checkout, as the record names it. */
export interface MadRecord {
  /** The full commit id of HEAD. */
  readonly revision: string
  /**
   * `git status --porcelain=v1 -z --untracked-files=all` entries, one per
   * change; empty when clean. A rename or copy entry holds its source path
   * after a NUL, as git writes it.
   */
  readonly status: string[]
  /**
   * Tracked paths git is told not to look at (assume-unchanged or
   * skip-worktree): their edits are hidden from `status` and `diff`, so a
   * record with any is never called clean.
   */
  readonly flagged: string[]
  /**
   * SHA-256 over separately framed parts: the staged diff (`--cached`), the
   * index flags (`ls-files -v`), every tracked path's working-copy content
   * read from disk whatever its flags (a symlink by its target, never
   * followed; a missing file as absent), and each untracked path's name with
   * its content.
   */
  readonly uncommittedSha256: string
}

export interface CheckRecord {
  readonly kind: "before" | "after"
  readonly takenAt: string
  readonly repo: string
  readonly mad: MadRecord
  readonly snapshot: SnapshotJson
  /** On `after` only: every difference in the reviewed repository from the `before` record. */
  readonly differences?: string[]
  /** On `after` only: every difference in the MAD checkout from the `before` record (`madDifferences`). */
  readonly madDifferences?: string[]
}

export interface CheckIo {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  /** The MAD checkout to record. Defaults to the one holding this script. */
  readonly madRoot?: string
  readonly now?: () => Date
}

class UsageError extends Error {}

/** One read under the review's read-only git policy. */
export const policyGit: GitReader = async (cwd, argv, allowStatus = [0]) => {
  const child = Bun.spawn({
    cmd: readOnlyGitArgv(argv),
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: readOnlyGitEnv(process.env),
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ])
  if (!allowStatus.includes(code)) throw new Error(`git ${argv.join(" ")} exited ${code}: ${stderr}`)
  return Buffer.from(stdout)
}

/** Refuses a repository whose effective config defines an executable filter driver, before any content read. */
async function filterPreflight(root: string, what: string, git: GitReader): Promise<void> {
  let exit = 0
  let stdout = ""
  try {
    stdout = (await git(root, [...FILTER_PREFLIGHT], [0, 1])).toString("utf8")
    exit = stdout === "" ? 1 : 0
  } catch {
    exit = -1
  }
  const filters = configuredFilters(exit, stdout)
  if (filters.kind === "configured") throw new UsageError(`${what}: ${filterRefusalReason(filters.drivers)}`)
  if (filters.kind === "unknown") throw new UsageError(`${what}: its git config could not be read for filter drivers, so nothing was read`)
}

function nulRecords(raw: Buffer): Buffer[] {
  const out: Buffer[] = []
  for (let start = 0; start < raw.length; ) {
    const end = raw.indexOf(0, start)
    const stop = end === -1 ? raw.length : end
    if (stop > start) out.push(raw.subarray(start, stop))
    start = stop + 1
  }
  return out
}

/**
 * `git status --porcelain=v1 -z` entries, one per change. A rename or copy
 * (`R` or `C` in either status column) is followed by its source path in a
 * field of its own; that field belongs to the same entry and is kept in it
 * after a NUL, exactly as git wrote it, so it is never read as an entry.
 */
function statusEntries(raw: Buffer): Buffer[] {
  const fields = nulRecords(raw)
  const out: Buffer[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!
    const xy = field.subarray(0, 2).toString("latin1")
    const source = /[RC]/.test(xy) ? fields[i + 1] : undefined
    if (source === undefined) out.push(field)
    else {
      out.push(Buffer.concat([field, Buffer.from([0]), source]))
      i++
    }
  }
  return out
}

export async function madRecord(root: string, git: GitReader = policyGit): Promise<MadRecord> {
  await filterPreflight(root, "the MAD checkout", git)
  const revision = (await git(root, ["rev-parse", "--verify", "HEAD"])).toString("utf8").trim()
  // Entries are split as bytes, so an untracked name is read exactly as git listed it.
  const entries = statusEntries(await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
  const hash = createHash("sha256")
  const frame = (label: string, bytes: Buffer | string) => {
    const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    hash.update(`\0${label}\0${body.length}\0`).update(body)
  }
  const pathOf = (name: Buffer) => Buffer.concat([Buffer.from(root), Buffer.from(sep), name])
  /** A path's content as it is on disk, never through git: a symlink by its target, a file by its bytes and mode. */
  const content = async (label: string, name: Buffer) => {
    frame(`${label}-name`, name)
    const info = await lstat(pathOf(name)).catch(() => undefined)
    if (info === undefined) frame(`${label}-absent`, "")
    else if (info.isSymbolicLink()) frame(`${label}-symlink`, await readlink(pathOf(name), { encoding: "buffer" }))
    else if (info.isFile()) {
      frame(`${label}-mode`, String(info.mode & 0o7777))
      frame(`${label}-file`, await readFile(pathOf(name)))
    } else frame(`${label}-other`, String(info.mode))
  }

  frame("staged", await git(root, ["diff", "--binary", "--cached"]))
  const tags = await git(root, ["ls-files", "-v", "-z"])
  frame("flags", tags)
  // `ls-files -v`: a lowercase tag is assume-unchanged, `S` is skip-worktree.
  const flagged: string[] = []
  for (const record of nulRecords(tags)) {
    const space = record.indexOf(32)
    const tag = record.subarray(0, space).toString("latin1")
    if (tag === "S" || (tag !== tag.toUpperCase() && tag === tag.toLowerCase())) flagged.push(record.subarray(space + 1).toString("utf8"))
  }
  // Every tracked path's bytes are read from disk, so a flag that hides an edit from git cannot hide it here.
  for (const name of nulRecords(await git(root, ["ls-files", "-z"]))) await content("tracked", name)
  const UNTRACKED = Buffer.from("?? ")
  for (const entry of entries) if (entry.subarray(0, 3).equals(UNTRACKED)) await content("untracked", entry.subarray(3))
  return {
    revision,
    status: entries.map((entry) => entry.toString("utf8")),
    flagged,
    uncommittedSha256: hash.digest("hex"),
  }
}

function flags(argv: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]!
    const value = argv[i + 1]
    if (!name.startsWith("--") || value === undefined) throw new UsageError(`expected --flag value pairs, got ${JSON.stringify(name)}`)
    if (out.has(name)) throw new UsageError(`${name} given twice`)
    out.set(name, value)
  }
  return out
}

function absolute(given: Map<string, string>, name: string): string {
  const value = given.get(name)
  if (value === undefined) throw new UsageError(`${name} is required`)
  if (!isAbsolute(value)) throw new UsageError(`${name} must be an absolute path, got ${JSON.stringify(value)}`)
  return value
}

async function checkedRepo(path: string): Promise<string> {
  const info = await stat(path).catch(() => undefined)
  if (info === undefined || !info.isDirectory()) throw new UsageError(`--repo is not a directory: ${path}`)
  const real = await realpath(path)
  await filterPreflight(real, "--repo", policyGit)
  const top = (await policyGit(real, ["rev-parse", "--show-toplevel"], [0, 128])).toString("utf8").trim()
  if (top === "" || (await realpath(top)) !== real) throw new UsageError(`--repo is not the top of a git repository: ${path}`)
  return real
}

async function checkedOut(path: string, repo: string): Promise<string> {
  const parent = await realpath(dirname(path)).catch(() => undefined)
  if (parent === undefined) throw new UsageError(`--out's directory does not exist: ${dirname(path)}`)
  const target = resolve(parent, basename(path))
  const rel = relative(repo, target)
  if (rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw new UsageError(`--out must be outside the reviewed repository: ${path}`)
  }
  // lstat: a symlink at --out, dangling or not, is an existing entry.
  if (await lstat(target).catch(() => undefined)) throw new UsageError(`--out already exists: ${path}`)
  return target
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string")

function isMadRecord(value: unknown): value is MadRecord {
  if (!isRecord(value)) return false
  const { revision, status, flagged, uncommittedSha256 } = value
  return typeof revision === "string" && typeof uncommittedSha256 === "string" && isStrings(status) && isStrings(flagged)
}

/**
 * How the MAD checkout differs between the `before` and `after` records: its
 * commit, its uncommitted content, or the paths git is told not to look at.
 * Any of these means the run may not have used the revision `before` recorded.
 */
export function madDifferences(before: MadRecord, after: MadRecord): string[] {
  const out: string[] = []
  if (before.revision !== after.revision) out.push(`MAD revision ${before.revision} -> ${after.revision}`)
  if (before.uncommittedSha256 !== after.uncommittedSha256) out.push("MAD uncommitted content changed")
  if (JSON.stringify(before.flagged) !== JSON.stringify(after.flagged)) out.push("MAD flagged paths changed")
  return out
}

function isSnapshotJson(value: unknown): value is SnapshotJson {
  if (!isRecord(value)) return false
  const { paths, index, indexEntries, head, refs } = value
  if (!isRecord(paths) || !isRecord(indexEntries)) return false
  if (typeof index !== "string" || typeof head !== "string" || typeof refs !== "string") return false
  if (!Object.values(indexEntries).every((entry) => typeof entry === "string")) return false
  return Object.values(paths).every((entry) => isRecord(entry) && typeof entry.kind === "string")
}

async function readBefore(path: string, repo: string): Promise<CheckRecord> {
  const text = await readFile(path, "utf8").catch(() => undefined)
  if (text === undefined) throw new UsageError(`--before cannot be read: ${path}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new UsageError(`--before is not JSON: ${path}`)
  }
  if (
    !isRecord(parsed) ||
    parsed.kind !== "before" ||
    typeof parsed.repo !== "string" ||
    !isMadRecord(parsed.mad) ||
    !isSnapshotJson(parsed.snapshot)
  ) {
    throw new UsageError(`--before is not a before record: ${path}`)
  }
  if (parsed.repo !== repo) throw new UsageError(`--before records ${JSON.stringify(parsed.repo)}, not ${JSON.stringify(repo)}`)
  return parsed as unknown as CheckRecord
}

export async function runLiveCheck(argv: readonly string[], io: CheckIo): Promise<number> {
  const madRoot = io.madRoot ?? resolve(import.meta.dir, "..")
  const now = io.now ?? (() => new Date())
  try {
    const [command, ...rest] = argv
    if (command !== "before" && command !== "after") throw new UsageError("the first argument is `before` or `after`")
    const given = flags(rest)
    const allowed = command === "before" ? ["--repo", "--out"] : ["--repo", "--before", "--out"]
    for (const name of given.keys()) if (!allowed.includes(name)) throw new UsageError(`unknown flag ${name} for ${command}`)
    const repo = await checkedRepo(absolute(given, "--repo"))
    const out = await checkedOut(absolute(given, "--out"), repo)
    const before = command === "after" ? await readBefore(absolute(given, "--before"), repo) : undefined
    const mad = await madRecord(madRoot)

    const taken = await snapshot(repo, policyGit)
    let found: string[] | undefined
    let madFound: string[] | undefined
    if (before !== undefined) {
      const earlier = snapshotFromJson(before.snapshot)
      found = [...differences(earlier, taken), ...indexDifferences(earlier, taken)]
      madFound = madDifferences(before.mad, mad)
    }
    const record: CheckRecord = {
      kind: command,
      takenAt: now().toISOString(),
      repo,
      mad,
      snapshot: snapshotToJson(taken),
      ...(found === undefined ? {} : { differences: found }),
      ...(madFound === undefined ? {} : { madDifferences: madFound }),
    }
    await writeFile(out, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" })

    const state =
      mad.status.length === 0 && mad.flagged.length === 0
        ? "clean"
        : [
            ...(mad.status.length === 0 ? [] : [`${mad.status.length} uncommitted entries`]),
            ...(mad.flagged.length === 0 ? [] : [`${mad.flagged.length} paths git is told not to look at`]),
          ].join(", ")
    io.out(`MAD ${mad.revision} (${state})`)
    if (found === undefined || madFound === undefined) {
      io.out(`before: ${taken.paths.size} paths recorded in ${out}`)
      return 0
    }
    io.out(
      found.length === 0
        ? `after: the repository is unchanged; recorded in ${out}`
        : `after: the repository CHANGED (${found.length}); recorded in ${out}`,
    )
    for (const line of found) io.out(`  ${line}`)
    if (madFound.length > 0) {
      io.out(`after: the MAD checkout CHANGED since before (${madFound.length})`)
      for (const line of madFound) io.out(`  ${line}`)
    }
    return found.length === 0 && madFound.length === 0 ? 0 : 1
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`live-check: ${error.message}`)
      return 2
    }
    throw error
  }
}

if (import.meta.main) {
  const code = await runLiveCheck(process.argv.slice(2), {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  })
  process.exit(code)
}
