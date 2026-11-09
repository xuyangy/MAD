/**
 * A content snapshot of a git repository, and the differences between two.
 *
 * The snapshot is what "the repository is unchanged" means, both in the offline
 * acceptance suite (`adapters/opencode/test-support/repo-snapshot.ts`) and in a
 * live run's before/after check (`scripts/live-check.ts`). Porcelain status is
 * not enough: a file that is already modified keeps the status ` M` when its
 * bytes change again. So the snapshot records:
 *
 * - every path in the repository, `.git` included, by its exact name bytes
 *   (directory entries are read as `Buffer`s, never decoded or trimmed), and a
 *   file by the SHA-256 of its exact content bytes. Inside `.git` that covers
 *   config, hooks, `info/`, pseudo-refs, reflogs and objects;
 * - a file or directory's permission bits, so an executable bit set on a
 *   tracked file is a mutation even though its bytes are unchanged;
 * - a symlink by its target, never followed;
 * - the staged index by its content, not its bytes: `git ls-files -s -z` (mode,
 *   object, stage, path) plus `git ls-files -v -z` (assume-unchanged and
 *   skip-worktree flags). `.git/index` itself is left out of the byte
 *   comparison, so git's stat-cache bookkeeping is not a mutation;
 * - `HEAD`, symbolic and resolved, and every ref.
 *
 * Not recorded: ownership, hard-link identity, extended attributes and
 * timestamps.
 *
 * The index is also kept path by path (`indexEntries`), so a caller can name
 * which staged paths changed; `differences` reports only that the index
 * changed, as the acceptance suite asserts.
 *
 * The git reads go through a `GitReader`. The default, `readGit`, switches the
 * user's global and system config off and sets `GIT_OPTIONAL_LOCKS=0`, which
 * makes a temporary fixture the same on every machine. It does not neutralise
 * a repository's own config or inherited `GIT_*` variables, so a check of a
 * real repository passes a reader under the review's read-only git policy
 * (`scripts/live-check.ts`).
 */

import { createHash } from "node:crypto"
import { lstat, readdir, readFile, readlink } from "node:fs/promises"

/** No global or system config, no terminal prompt: git reads are the same on every machine. */
export const ISOLATED_GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
}

/** A read-only git call whose stdout is kept as bytes. */
export async function readGit(cwd: string, argv: string[], allowStatus: readonly number[] = [0]): Promise<Buffer> {
  const child = Bun.spawn({
    cmd: ["git", ...argv],
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...ISOLATED_GIT_ENV, GIT_OPTIONAL_LOCKS: "0" },
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ])
  if (!allowStatus.includes(code)) throw new Error(`snapshot git ${argv.join(" ")} exited ${code}: ${stderr}`)
  return Buffer.from(stdout)
}

/** Runs one read-only git subcommand in `cwd` and returns its stdout bytes; any other exit status throws. */
export type GitReader = (cwd: string, argv: string[], allowStatus?: readonly number[]) => Promise<Buffer>

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex")

/** One recorded path: its kind and what identifies its content. */
export type Entry =
  | { kind: "file"; mode: number; sha256: string }
  | { kind: "symlink"; target: string }
  | { kind: "dir"; mode: number }
  | { kind: "other"; mode: number }

/** Permission bits only (`0o7777`): what can change what runs, without stat-cache noise. */
const PERMISSIONS = 0o7777

export interface Snapshot {
  /** Keyed by the path's raw name bytes, hex-encoded, relative to the repository. */
  readonly paths: ReadonlyMap<string, Entry>
  /** SHA-256 of the staged index's content. */
  readonly index: string
  /**
   * The index path by path: keyed like `paths`, each value the entry's
   * `mode object stage` lines and its `ls-files -v` tag.
   */
  readonly indexEntries: ReadonlyMap<string, string>
  /** SHA-256 of HEAD, symbolic and resolved. */
  readonly head: string
  /** SHA-256 of every ref and its object. */
  readonly refs: string
}

const SLASH = Buffer.from("/")
/** The one path compared by content rather than bytes; see the header. */
const INDEX_FILE = Buffer.from(".git/index")

async function walk(root: Buffer, rel: Buffer, into: Map<string, Entry>): Promise<void> {
  const here = rel.length === 0 ? root : Buffer.concat([root, SLASH, rel])
  const names = await readdir(here, { encoding: "buffer" })
  for (const name of names) {
    if (!Buffer.isBuffer(name)) {
      throw new TypeError(
        `snapshot: readdir returned a ${typeof name} name, not raw name bytes; ` +
          "this Bun does not support the snapshot, use the Bun version the README names",
      )
    }
    const childRel = rel.length === 0 ? name : Buffer.concat([rel, SLASH, name])
    if (childRel.equals(INDEX_FILE)) continue
    const full = Buffer.concat([root, SLASH, childRel])
    const stat = await lstat(full)
    const key = childRel.toString("hex")
    if (stat.isSymbolicLink()) into.set(key, { kind: "symlink", target: (await readlink(full, { encoding: "buffer" })).toString("hex") })
    else if (stat.isDirectory()) {
      into.set(key, { kind: "dir", mode: stat.mode & PERMISSIONS })
      await walk(root, childRel, into)
    } else if (stat.isFile()) into.set(key, { kind: "file", mode: stat.mode & PERMISSIONS, sha256: sha256(await readFile(full)) })
    // The full mode, type bits included: a FIFO replaced by a socket is a change.
    else into.set(key, { kind: "other", mode: stat.mode })
  }
}

const NUL = Buffer.from([0])

/** NUL-terminated records, split as bytes. */
function records(raw: Buffer): Buffer[] {
  const out: Buffer[] = []
  for (let start = 0; start < raw.length; ) {
    const end = raw.indexOf(0, start)
    const stop = end === -1 ? raw.length : end
    if (stop > start) out.push(raw.subarray(start, stop))
    start = stop + 1
  }
  return out
}

/** `ls-files -s -z` (`mode object stage<TAB>path`) and `ls-files -v -z` (`tag path`), keyed by path bytes. */
function indexByPath(stages: Buffer, tags: Buffer): Map<string, string> {
  const byPath = new Map<string, string[]>()
  const add = (path: Buffer, value: string) => {
    const key = path.toString("hex")
    byPath.set(key, [...(byPath.get(key) ?? []), value])
  }
  for (const record of records(stages)) {
    const tab = record.indexOf(9)
    if (tab === -1) throw new Error("snapshot: an `ls-files -s` record has no tab")
    add(record.subarray(tab + 1), record.subarray(0, tab).toString("latin1"))
  }
  for (const record of records(tags)) {
    const space = record.indexOf(32)
    if (space === -1) throw new Error("snapshot: an `ls-files -v` record has no space")
    add(record.subarray(space + 1), `tag ${record.subarray(0, space).toString("latin1")}`)
  }
  return new Map([...byPath].map(([key, values]) => [key, values.join("\n")]))
}

export async function snapshot(dir: string, git: GitReader = readGit): Promise<Snapshot> {
  const paths = new Map<string, Entry>()
  await walk(Buffer.from(dir), Buffer.alloc(0), paths)
  const stages = await git(dir, ["ls-files", "-s", "-z"])
  const tags = await git(dir, ["ls-files", "-v", "-z"])
  const head = Buffer.concat([
    await git(dir, ["symbolic-ref", "-q", "HEAD"], [0, 1]),
    NUL,
    await git(dir, ["rev-parse", "--verify", "-q", "HEAD"], [0, 1]),
  ])
  const refs = await git(dir, ["for-each-ref", "--format=%(refname)%00%(objectname)"])
  return {
    paths,
    index: sha256(Buffer.concat([stages, NUL, tags])),
    indexEntries: indexByPath(stages, tags),
    head: sha256(head),
    refs: sha256(refs),
  }
}

function sameEntry(a: Entry, b: Entry): boolean {
  if (a.kind === "file" && b.kind === "file") return a.mode === b.mode && a.sha256 === b.sha256
  if (a.kind === "symlink" && b.kind === "symlink") return a.target === b.target
  if (a.kind === "dir" && b.kind === "dir") return a.mode === b.mode
  if (a.kind === "other" && b.kind === "other") return a.mode === b.mode
  return false
}

/** A path for a difference message; the raw bytes are added when UTF-8 would not round-trip them. */
function display(key: string): string {
  const raw = Buffer.from(key, "hex")
  const text = raw.toString("utf8")
  return Buffer.from(text, "utf8").equals(raw) ? JSON.stringify(text) : `${JSON.stringify(text)} (bytes ${key})`
}

/** Every difference between two snapshots, in words. Empty means unchanged. */
export function differences(before: Snapshot, after: Snapshot): string[] {
  const out: string[] = []
  for (const [key, entry] of before.paths) {
    const now = after.paths.get(key)
    if (now === undefined) out.push(`removed ${display(key)}`)
    else if (!sameEntry(entry, now)) out.push(`changed ${display(key)}`)
  }
  for (const key of after.paths.keys()) if (!before.paths.has(key)) out.push(`added ${display(key)}`)
  if (before.index !== after.index) out.push("the staged index changed")
  if (before.head !== after.head) out.push("HEAD changed")
  if (before.refs !== after.refs) out.push("refs changed")
  return out
}

/** Each staged path whose index entry was added, removed or changed, by its exact name. */
export function indexDifferences(before: Snapshot, after: Snapshot): string[] {
  const out: string[] = []
  for (const [key, entry] of before.indexEntries) {
    const now = after.indexEntries.get(key)
    if (now === undefined) out.push(`unstaged ${display(key)}`)
    else if (now !== entry) out.push(`staged ${display(key)}`)
  }
  for (const key of after.indexEntries.keys()) if (!before.indexEntries.has(key)) out.push(`staged ${display(key)}`)
  return out
}

/** The snapshot as plain JSON, paths in a stable order. */
export interface SnapshotJson {
  readonly paths: Record<string, Entry>
  readonly index: string
  readonly indexEntries: Record<string, string>
  readonly head: string
  readonly refs: string
}

export function snapshotToJson(snap: Snapshot): SnapshotJson {
  const paths: Record<string, Entry> = {}
  for (const key of [...snap.paths.keys()].sort()) paths[key] = snap.paths.get(key)!
  const indexEntries: Record<string, string> = {}
  for (const key of [...snap.indexEntries.keys()].sort()) indexEntries[key] = snap.indexEntries.get(key)!
  return { paths, index: snap.index, indexEntries, head: snap.head, refs: snap.refs }
}

export function snapshotFromJson(json: SnapshotJson): Snapshot {
  return {
    paths: new Map(Object.entries(json.paths)),
    index: json.index,
    indexEntries: new Map(Object.entries(json.indexEntries)),
    head: json.head,
    refs: json.refs,
  }
}
