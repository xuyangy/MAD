/**
 * Story 2-8c4 — the OAuth data directory's store guard.
 *
 * The OAuth host's data directory is persistent: opencode keeps its database,
 * `<data-dir>/opencode/opencode.db`, across blocks and runs. A stored permission,
 * a leftover session or a sign-in moved into that database would reach every later
 * run and both arms unseen, so every OAuth host start (before the spawn), every
 * OAuth stop (after the exit) and the launcher's stage 1 count what it holds.
 *
 * ## What it reads, and how
 *
 * Only `SELECT COUNT(*)` on each of `STORE_TABLES`, on a read-only connection. It
 * never reads a row, never opens `auth.json`, and returns table names and counts
 * only. The files are examined by `lstat` first: `<data-dir>/opencode` must be a
 * real directory, and `opencode.db`, `opencode.db-wal` and `opencode.db-shm`, where
 * present, regular files (a symlink refuses).
 *
 * - **Rollback journal mode** (no `-wal` or `-shm`, and the database header does
 *   not name WAL): the connection is opened on `opencode.db` itself, which a
 *   read-only reader in that mode never writes.
 * - **WAL mode**, as opencode keeps it: a WAL reader writes the `-shm` index even on
 *   a read-only connection, and creates it when it is absent. So `opencode.db` and
 *   its `-wal` are copied into a private temporary directory (an empty `-wal`
 *   stands in for a database closed cleanly, which has none), the connection is
 *   opened on the copy, and the copy is removed. The three files are `lstat`ed
 *   before and after the copy; any change refuses, since the copy may then be torn.
 *   No byte of `opencode.db`, `-wal` or `-shm` changes.
 *
 * It fails closed:
 *
 * - no `opencode.db` yet reads as empty, and says so, unless a `-wal` or `-shm`
 *   file is there without it;
 * - a database that cannot be opened, is locked or corrupt, changed while it was
 *   copied, or lacks one of the named tables, refuses;
 * - a connection that cannot be closed, or a private copy that cannot be removed,
 *   refuses whatever the counts were, naming the leftover directory;
 * - any count other than 0 refuses. The host API's directory-scoped session list
 *   is not a substitute: it sees one directory's sessions and none of the other
 *   tables.
 *
 * ## An allowlist tied to one schema
 *
 * `STORE_TABLES` names tables of the pinned opencode 1.18.32 schema (`MEASURED_HOST`
 * in `ablation/managed-host.ts`). Every other table of that schema (`project`,
 * `event` and the rest) is unguarded, and a table a newer schema adds goes unseen.
 * The binary pin is what makes a version change visible: the managed host refuses
 * any other build before the spawn.
 *
 * ## The probe's placeholder stores
 *
 * The zero-bill probe's attempt scenarios leave their session in a fresh,
 * probe-owned placeholder data directory. `probeStoreAfterRun` records those counts
 * as the probe's expected state, never as an empty store. It runs only in the
 * post-stop checks of a host started by `startProbePlaceholderHost`
 * (`ablation/managed-host.ts`), which first proves the route is such a directory;
 * every other stop runs `storeGuard`.
 *
 * AD-1: this tree may import from `core/`; nothing under `core/` imports it.
 */

import { Database } from "bun:sqlite"
import { copyFile, lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** The tables whose counts are guarded, in the order they are reported: an allowlist of opencode 1.18.32's schema. */
export const STORE_TABLES = ["session", "message", "part", "permission", "credential", "account", "account_state", "control_account"] as const
export type StoreTable = (typeof STORE_TABLES)[number]
export type StoreCounts = Record<StoreTable, number>

const ZERO_COUNTS: StoreCounts = { session: 0, message: 0, part: 0, permission: 0, credential: 0, account: 0, account_state: 0, control_account: 0 }

/** Where opencode keeps its database under an OAuth data directory. */
export function storeDatabasePath(dataDir: string): string {
  return join(dataDir, "opencode", "opencode.db")
}

export type StoreReading =
  | { kind: "no-database"; path: string }
  | { kind: "counted"; path: string; counts: StoreCounts }
  | { kind: "unreadable"; path: string; reason: string }

type Examined = { kind: "absent" } | { kind: "file"; stamp: string } | { kind: "refused"; reason: string }

/** One file by `lstat`: absent, a regular file (with what identifies its bytes), or refused. */
async function examine(path: string): Promise<Examined> {
  try {
    const info = await lstat(path)
    if (!info.isFile()) return { kind: "refused", reason: `\`${path}\` is ${info.isSymbolicLink() ? "a symlink" : "not a regular file"}` }
    return { kind: "file", stamp: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" ? { kind: "absent" } : { kind: "refused", reason: `\`${path}\` could not be examined (${code ?? messageOf(error)})` }
  }
}

/** Whether the database header's read and write versions (bytes 18 and 19) name WAL. */
async function headerNamesWal(path: string): Promise<boolean> {
  const handle = await open(path, "r")
  try {
    const header = Buffer.alloc(20)
    const { bytesRead } = await handle.read(header, 0, 20, 0)
    return bytesRead === 20 && (header[18] === 2 || header[19] === 2)
  } finally {
    await handle.close()
  }
}

/** Test-only: how the connection is closed and the private copy removed. */
export interface StoreReadSeams {
  close?: (db: Database) => void
  removeCopy?: (dir: string) => Promise<void>
}

/**
 * The named tables' counts in `<data-dir>/opencode/opencode.db`, by `SELECT COUNT(*)`
 * alone. Changes no byte of the store. The private copy of a WAL-mode store is
 * removed whether or not the connection closed; a connection that did not close,
 * or a copy that could not be removed, turns any count into a refusal, which names
 * the leftover directory. Never rejects.
 */
export async function readStoreCounts(dataDir: string, seams: StoreReadSeams = {}): Promise<StoreReading> {
  const path = storeDatabasePath(dataDir)
  const parent = join(dataDir, "opencode")
  const unreadable = (reason: string): StoreReading => ({ kind: "unreadable", path, reason })
  const dir = await lstat(parent).catch(() => undefined)
  if (dir === undefined || dir.isSymbolicLink() || !dir.isDirectory()) {
    return unreadable(`\`${parent}\` is ${dir === undefined ? "missing" : dir.isSymbolicLink() ? "a symlink" : "not a directory"}; it must be a real directory`)
  }
  const files = { db: path, wal: `${path}-wal`, shm: `${path}-shm` }
  const examineAll = async () => ({ db: await examine(files.db), wal: await examine(files.wal), shm: await examine(files.shm) })
  const before = await examineAll()
  for (const entry of Object.values(before)) if (entry.kind === "refused") return unreadable(entry.reason)
  if (before.db.kind === "absent") {
    const orphan = before.wal.kind !== "absent" ? files.wal : before.shm.kind !== "absent" ? files.shm : undefined
    return orphan === undefined ? { kind: "no-database", path } : unreadable(`\`${path}\` is missing but \`${orphan}\` exists`)
  }
  let snapshot: string | undefined
  let db: Database | undefined
  const count = async (): Promise<StoreReading> => {
    let target = path
    if (before.wal.kind === "file" || before.shm.kind === "file" || (await headerNamesWal(path))) {
      snapshot = await mkdtemp(join(tmpdir(), "mad-oauth-store-"))
      target = join(snapshot, "opencode.db")
      await copyFile(path, target)
      // A read-only connection cannot create a -wal, so a WAL database closed cleanly (no -wal left) gets an empty one: no frames.
      if (before.wal.kind === "file") await copyFile(files.wal, `${target}-wal`)
      else await writeFile(`${target}-wal`, "")
      const after = await examineAll()
      const moved = (["db", "wal", "shm"] as const).filter((name) => JSON.stringify(after[name]) !== JSON.stringify(before[name]))
      if (moved.length > 0) {
        return unreadable(`${moved.map((name) => `\`${files[name]}\``).join(", ")} changed while the store was copied (is a host writing to it?)`)
      }
    }
    db = new Database(target, { readonly: true })
    const counts = { ...ZERO_COUNTS }
    const missing: string[] = []
    for (const table of STORE_TABLES) {
      let row: { n?: unknown } | null
      try {
        row = db.query<{ n: unknown }, []>(`SELECT COUNT(*) AS n FROM "${table}"`).get()
      } catch (error) {
        if (/no such table/i.test(messageOf(error))) {
          missing.push(table)
          continue
        }
        throw error
      }
      if (typeof row?.n !== "number" || !Number.isInteger(row.n) || row.n < 0) throw new Error(`the count of \`${table}\` is not a whole number`)
      counts[table] = row.n
    }
    if (missing.length > 0) return unreadable(`\`${path}\` has no table ${missing.map((table) => `\`${table}\``).join(", ")} (its schema changed)`)
    return { kind: "counted", path, counts }
  }
  const reading = await count().catch((error: unknown) => unreadable(`\`${path}\` could not be read: ${messageOf(error)}`))
  // Each step runs whatever the one before it did, and neither failure is swallowed.
  const cleanup: string[] = []
  if (db !== undefined) {
    try {
      ;(seams.close ?? ((open) => open.close()))(db)
    } catch (error) {
      cleanup.push(`the read-only connection to \`${snapshot === undefined ? path : join(snapshot, "opencode.db")}\` could not be closed (${messageOf(error)})`)
    }
  }
  if (snapshot !== undefined) {
    try {
      await (seams.removeCopy ?? ((dir) => rm(dir, { recursive: true, force: true })))(snapshot)
    } catch (error) {
      cleanup.push(`the private copy of the store \`${snapshot}\` could not be removed (${messageOf(error)}); remove that directory by hand`)
    }
  }
  if (cleanup.length === 0) return reading
  return unreadable(`${cleanup.join("; ")}${reading.kind === "unreadable" ? `; and before that, ${reading.reason}` : "; the count is not used"}`)
}

export type StoreGuard = { ok: true; line: string } | { ok: false; problems: string[] }

/** The counts as `table=count` pairs, in `STORE_TABLES` order. */
export function formatCounts(counts: StoreCounts): string {
  return STORE_TABLES.map((table) => `${table}=${counts[table]}`).join(", ")
}

/** The store guard: every named count 0, or no database yet. Names and counts only, never a row. Never rejects. */
export async function storeGuard(dataDir: string, seams: StoreReadSeams = {}): Promise<StoreGuard> {
  const reading = await readStoreCounts(dataDir, seams)
  if (reading.kind === "no-database") return { ok: true, line: `\`${reading.path}\`: no database yet, so the store is empty` }
  if (reading.kind === "unreadable") return { ok: false, problems: [`the OAuth store is refused: ${reading.reason}`] }
  const off = STORE_TABLES.filter((table) => reading.counts[table] !== 0)
  return off.length === 0
    ? { ok: true, line: `\`${reading.path}\`: ${formatCounts(reading.counts)} (every named table empty; counted by SELECT COUNT(*) on a read-only connection)` }
    : {
        ok: false,
        problems: [
          `the OAuth store \`${reading.path}\` holds ${off.map((table) => `${table}=${reading.counts[table]}`).join(", ")}; ` +
            `every named table must be empty (${formatCounts(reading.counts)})`,
        ],
      }
}

/**
 * After a probe host on a fresh, probe-owned placeholder data directory exited:
 * its named counts, recorded as the probe's expected state and never as an empty
 * store. An unreadable store still fails. Never rejects.
 */
export async function probeStoreAfterRun(dataDir: string): Promise<StoreGuard> {
  const reading = await readStoreCounts(dataDir)
  if (reading.kind === "unreadable") return { ok: false, problems: [`the placeholder store is refused: ${reading.reason}`] }
  const found = reading.kind === "no-database" ? "no database" : formatCounts(reading.counts)
  return {
    ok: true,
    line:
      `placeholder store after the run: ${found}, expected probe state (\`${reading.path}\`, a fresh probe-owned placeholder ` +
      "data directory; not an empty-store check)",
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
