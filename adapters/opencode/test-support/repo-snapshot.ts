/**
 * Temporary review repositories, and a content snapshot of one, for the offline
 * acceptance suite (CAP-1).
 *
 * The snapshot is what "the worktree is unchanged" means in the suite. Porcelain
 * status is not enough: a file that is already modified keeps the status ` M`
 * when its bytes change again. So the snapshot records:
 *
 * - every path in the repository, `.git` included, by its exact name bytes
 *   (directory entries are read as `Buffer`s, never decoded or trimmed) and its
 *   exact content bytes. Inside `.git` that covers config, hooks, `info/`,
 *   pseudo-refs, reflogs and objects. A read-only review writes none of them;
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
 * Every git call here, fixture setup and snapshot alike, runs with the user's
 * global and system git config switched off, so a developer's hooks, templates
 * or `core.fsmonitor` cannot change what a fixture is. The snapshot's reads also
 * set `GIT_OPTIONAL_LOCKS=0`, so taking a snapshot does not refresh the index.
 * The plugin's own git calls are not isolated this way; what they inherit is
 * CAP-2's concern.
 */

import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** No global or system config, no terminal prompt: fixture git is the same on every machine. */
const ISOLATED_GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
}

/** Run git in `cwd` for fixture setup, and fail loudly if it fails. */
export async function setupGit(cwd: string, argv: string[]): Promise<void> {
  const child = Bun.spawn({
    cmd: ["git", ...argv],
    cwd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, ...ISOLATED_GIT_ENV },
  })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`fixture git ${argv.join(" ")} failed: ${stderr}`)
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

const COMMIT_FLAGS = [
  "-c", "user.name=MAD test",
  "-c", "user.email=mad@example.invalid",
  "-c", "commit.gpgsign=false",
  // No detached maintenance races the directory's removal (#138); fixture only.
  "-c", "maintenance.auto=false",
  "-c", "gc.auto=0",
]

export interface ReviewRepo {
  readonly dir: string
  remove(): Promise<void>
}

/**
 * A committed repository holding `src/pay.ts`. `dirty` adds an uncommitted edit
 * to it and an untracked `notes.txt`; otherwise the tree is clean. A failed
 * setup removes the directory before rethrowing.
 */
export async function makeReviewRepo(options: { dirty: boolean }): Promise<ReviewRepo> {
  const dir = await mkdtemp(join(tmpdir(), "mad-acceptance-repo-"))
  const remove = () => rm(dir, { recursive: true, force: true })
  try {
    await setupGit(dir, ["init", "-q"])
    await mkdir(join(dir, "src"))
    await writeFile(join(dir, "src", "pay.ts"), "export const fee = (total: number) => total * 0.1\n")
    await setupGit(dir, ["add", "src/pay.ts"])
    await setupGit(dir, [...COMMIT_FLAGS, "commit", "-q", "--no-verify", "-m", "base"])
    if (options.dirty) {
      await writeFile(join(dir, "src", "pay.ts"), "export const fee = (total: number) => total * 0.01\n")
      await writeFile(join(dir, "notes.txt"), "untracked scratch\n")
    }
  } catch (error) {
    await remove()
    throw error
  }
  return { dir, remove }
}

/** One recorded path: its kind and the bytes that identify its content. */
type Entry =
  | { kind: "file"; mode: number; bytes: Buffer }
  | { kind: "symlink"; target: Buffer }
  | { kind: "dir"; mode: number }
  | { kind: "other"; mode: number }

/** Permission bits only (`0o7777`): what can change what runs, without stat-cache noise. */
const PERMISSIONS = 0o7777

export interface Snapshot {
  /** Keyed by the path's raw name bytes, hex-encoded, relative to the repository. */
  readonly paths: ReadonlyMap<string, Entry>
  readonly index: Buffer
  readonly head: Buffer
  readonly refs: Buffer
}

const SLASH = Buffer.from("/")
/** The one path compared by content rather than bytes; see the header. */
const INDEX_FILE = Buffer.from(".git/index")

async function walk(root: Buffer, rel: Buffer, into: Map<string, Entry>): Promise<void> {
  const here = rel.length === 0 ? root : Buffer.concat([root, SLASH, rel])
  const names = await readdir(here, { encoding: "buffer" })
  for (const name of names) {
    const childRel = rel.length === 0 ? name : Buffer.concat([rel, SLASH, name])
    if (childRel.equals(INDEX_FILE)) continue
    const full = Buffer.concat([root, SLASH, childRel])
    const stat = await lstat(full)
    const key = childRel.toString("hex")
    if (stat.isSymbolicLink()) into.set(key, { kind: "symlink", target: await readlink(full, { encoding: "buffer" }) })
    else if (stat.isDirectory()) {
      into.set(key, { kind: "dir", mode: stat.mode & PERMISSIONS })
      await walk(root, childRel, into)
    } else if (stat.isFile()) into.set(key, { kind: "file", mode: stat.mode & PERMISSIONS, bytes: await readFile(full) })
    // The full mode, type bits included: a FIFO replaced by a socket is a change.
    else into.set(key, { kind: "other", mode: stat.mode })
  }
}

const NUL = Buffer.from([0])

export async function snapshot(dir: string): Promise<Snapshot> {
  const paths = new Map<string, Entry>()
  await walk(Buffer.from(dir), Buffer.alloc(0), paths)
  const index = Buffer.concat([
    await readGit(dir, ["ls-files", "-s", "-z"]),
    NUL,
    await readGit(dir, ["ls-files", "-v", "-z"]),
  ])
  const head = Buffer.concat([
    await readGit(dir, ["symbolic-ref", "-q", "HEAD"], [0, 1]),
    NUL,
    await readGit(dir, ["rev-parse", "--verify", "-q", "HEAD"], [0, 1]),
  ])
  const refs = await readGit(dir, ["for-each-ref", "--format=%(refname)%00%(objectname)"])
  return { paths, index, head, refs }
}

function sameEntry(a: Entry, b: Entry): boolean {
  if (a.kind === "file" && b.kind === "file") return a.mode === b.mode && a.bytes.equals(b.bytes)
  if (a.kind === "symlink" && b.kind === "symlink") return a.target.equals(b.target)
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
  if (!before.index.equals(after.index)) out.push("the staged index changed")
  if (!before.head.equals(after.head)) out.push("HEAD changed")
  if (!before.refs.equals(after.refs)) out.push("refs changed")
  return out
}

/**
 * The differences outside `.git`. For the snapshot's own self-tests, where a
 * fixture step deliberately writes git's bookkeeping (objects, reflogs).
 */
export function worktreeDifferences(before: Snapshot, after: Snapshot): string[] {
  return differences(before, after).filter((line) => !/^(removed|changed|added) "\.git(\/|")/.test(line))
}
