/**
 * Story 2-8c4 — the store guard, against SQLite files built here in temporary
 * directories. No test opens the user's `~/.local/share/mad-opencode-oauth`.
 */

import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { probeStoreAfterRun, readStoreCounts, STORE_TABLES, storeDatabasePath, storeGuard, type StoreTable } from "./oauth-store.ts"
import { fakeStore, ROW_CONTENT_MARKER } from "./oauth-store.fixture.ts"

const scratch: string[] = []
afterEach(async () => {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})

async function dataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mad-oauth-store-test-"))
  scratch.push(root)
  await mkdir(join(root, "opencode"), { recursive: true })
  return root
}

/** A data directory holding a database with every named table (less `omit`) and `rows[table]` rows in each. */
async function store(rows: Partial<Record<StoreTable, number>> = {}, omit: StoreTable[] = []): Promise<string> {
  const dir = await dataDir()
  await fakeStore(dir, rows, omit)
  return dir
}

describe("the ordinary guard", () => {
  test("a fresh store with no database passes and says so", async () => {
    const dir = await dataDir()
    expect(await storeGuard(dir)).toEqual({ ok: true, line: `\`${storeDatabasePath(dir)}\`: no database yet, so the store is empty` })
  })

  test("every named table empty passes, naming each count", async () => {
    const dir = await store()
    const guard = await storeGuard(dir)
    expect(guard.ok).toBe(true)
    if (guard.ok) expect(guard.line).toContain("session=0, message=0, part=0, permission=0, credential=0, account=0, account_state=0, control_account=0")
  })

  test.each([
    ["a leftover session", { session: 3, message: 6 }, "session=3, message=6"],
    ["a leftover message part", { part: 2 }, "part=2"],
    ["a stored permission", { permission: 1 }, "permission=1"],
    ["a sign-in in the database", { credential: 1 }, "credential=1"],
    ["an account", { account: 1, account_state: 1, control_account: 1 }, "account=1, account_state=1, control_account=1"],
  ] as const)("%s is refused with table names and counts only", async (_, rows, named) => {
    const dir = await store(rows)
    const guard = await storeGuard(dir)
    expect(guard.ok).toBe(false)
    const text = guard.ok ? "" : guard.problems.join("\n")
    expect(text).toContain(`holds ${named}`)
    expect(text).toContain("every named table must be empty")
    expect(text).not.toContain(ROW_CONTENT_MARKER)
    expect(text).not.toContain("session-0")
  })

  test("a missing named table refuses: the schema changed", async () => {
    const dir = await store({}, ["permission"])
    const guard = await storeGuard(dir)
    expect(guard.ok ? "" : guard.problems.join("\n")).toContain("has no table `permission` (its schema changed)")
  })

  test("a corrupt database refuses", async () => {
    const dir = await dataDir()
    await writeFile(storeDatabasePath(dir), "this is not a SQLite database, and it is long enough to have a header".repeat(20))
    const guard = await storeGuard(dir)
    expect(guard.ok).toBe(false)
    expect(guard.ok ? "" : guard.problems.join("\n")).toContain("could not be read")
  })

  test("a locked database refuses", async () => {
    const dir = await store({})
    const writer = new Database(storeDatabasePath(dir))
    writer.run("PRAGMA journal_mode = DELETE")
    writer.run("BEGIN EXCLUSIVE")
    try {
      const guard = await storeGuard(dir)
      expect(guard.ok).toBe(false)
      expect(guard.ok ? "" : guard.problems.join("\n")).toContain("could not be read")
    } finally {
      writer.run("ROLLBACK")
      writer.close()
    }
  })

  test("a database that is a symlink, or a WAL file without its database, refuses", async () => {
    const real = await store()
    const linked = await dataDir()
    await symlink(storeDatabasePath(real), storeDatabasePath(linked))
    expect((await readStoreCounts(linked)).kind).toBe("unreadable")
    const walOnly = await dataDir()
    await writeFile(`${storeDatabasePath(walOnly)}-wal`, "")
    const reading = await readStoreCounts(walOnly)
    expect(reading.kind === "unreadable" ? reading.reason : "").toContain("is missing but")
  })

  test("a symlinked `opencode` directory, -wal or -shm refuses before any database is opened", async () => {
    const real = await store()
    const linkedParent = await mkdtemp(join(tmpdir(), "mad-oauth-store-test-"))
    scratch.push(linkedParent)
    await symlink(join(real, "opencode"), join(linkedParent, "opencode"))
    const parent = await readStoreCounts(linkedParent)
    expect(parent.kind === "unreadable" ? parent.reason : "").toContain("opencode` is a symlink; it must be a real directory")
    for (const suffix of ["-wal", "-shm"]) {
      const dir = await store()
      const elsewhere = join(await dataDir(), "elsewhere")
      await writeFile(elsewhere, "")
      await symlink(elsewhere, `${storeDatabasePath(dir)}${suffix}`)
      const reading = await readStoreCounts(dir)
      expect(reading.kind === "unreadable" ? reading.reason : "").toContain(`opencode.db${suffix}\` is a symlink`)
    }
  })

  test("a WAL-mode database, as opencode keeps it, is counted with a writer open, and no byte of .db, -wal or -shm changes", async () => {
    const dir = await store()
    const path = storeDatabasePath(dir)
    const writer = new Database(path)
    writer.run("PRAGMA journal_mode = WAL")
    writer.run("PRAGMA wal_autocheckpoint = 0")
    writer.run(`INSERT INTO "session" VALUES ('s', 'x')`)
    try {
      const bytes = () => Promise.all(["", "-wal", "-shm"].map((suffix) => readFile(`${path}${suffix}`)))
      const before = await bytes()
      expect(before[1]!.length).toBeGreaterThan(0)
      const guard = await storeGuard(dir)
      expect(guard.ok ? "" : guard.problems.join("\n")).toContain("holds session=1")
      const after = await bytes()
      for (const [index, suffix] of ["opencode.db", "opencode.db-wal", "opencode.db-shm"].entries()) {
        expect(Buffer.compare(before[index]!, after[index]!), suffix).toBe(0)
      }
    } finally {
      writer.close()
    }
  })

  test("a WAL-mode database closed cleanly, with no -wal or -shm left, is counted, and neither file appears beside it", async () => {
    const dir = await store({ session: 2 })
    const path = storeDatabasePath(dir)
    const writer = new Database(path)
    writer.run("PRAGMA journal_mode = WAL")
    writer.close()
    expect(await Bun.file(`${path}-wal`).exists()).toBe(false)
    const dbBytes = await readFile(path)
    const guard = await storeGuard(dir)
    expect(guard.ok ? "" : guard.problems.join("\n")).toContain("holds session=2")
    expect(Buffer.compare(dbBytes, await readFile(path))).toBe(0)
    expect(await Bun.file(`${path}-wal`).exists()).toBe(false)
    expect(await Bun.file(`${path}-shm`).exists()).toBe(false)
  })

  test("a WAL database whose -shm is absent is counted from its -wal, and no -shm is created", async () => {
    // A WAL database whose committed row is still in its -wal, as a writer that stopped without a checkpoint leaves it.
    const source = await store()
    const writer = new Database(storeDatabasePath(source))
    writer.run("PRAGMA journal_mode = WAL")
    writer.run("PRAGMA wal_autocheckpoint = 0")
    writer.run(`INSERT INTO "session" VALUES ('s', 'x')`)
    const dir = await dataDir()
    const path = storeDatabasePath(dir)
    try {
      await copyFile(storeDatabasePath(source), path)
      await copyFile(`${storeDatabasePath(source)}-wal`, `${path}-wal`)
    } finally {
      writer.close()
    }
    const walBytes = await readFile(`${path}-wal`)
    expect(walBytes.length).toBeGreaterThan(0)
    const dbBytes = await readFile(path)
    const guard = await storeGuard(dir)
    expect(guard.ok ? "" : guard.problems.join("\n")).toContain("holds session=1")
    expect(Buffer.compare(dbBytes, await readFile(path))).toBe(0)
    expect(Buffer.compare(walBytes, await readFile(`${path}-wal`))).toBe(0)
    expect(await Bun.file(`${path}-shm`).exists()).toBe(false)
  })

  test("the connection is read-only: the guard changes no byte of the database", async () => {
    const dir = await store({ session: 1 })
    const before = await Bun.file(storeDatabasePath(dir)).arrayBuffer()
    await storeGuard(dir)
    expect(Buffer.compare(Buffer.from(before), Buffer.from(await Bun.file(storeDatabasePath(dir)).arrayBuffer()))).toBe(0)
  })
})

describe("the private copy of a WAL-mode store", () => {
  /** A WAL-mode store with one session, whose writer is closed again before the guard runs. */
  async function walStore(): Promise<string> {
    const dir = await store({ session: 1 })
    const writer = new Database(storeDatabasePath(dir))
    writer.run("PRAGMA journal_mode = WAL")
    writer.close()
    return dir
  }

  test("is removed after a successful count", async () => {
    const copies: string[] = []
    const reading = await readStoreCounts(await walStore(), { removeCopy: async (dir) => (copies.push(dir), rm(dir, { recursive: true, force: true })) })
    expect(reading.kind).toBe("counted")
    expect(copies).toHaveLength(1)
    expect(await Bun.file(join(copies[0]!, "opencode.db")).exists()).toBe(false)
  })

  test("a copy that cannot be removed turns the count into a refusal naming the leftover directory, with no row content", async () => {
    let left = ""
    const guard = await storeGuard(await walStore(), {
      removeCopy: async (dir) => {
        left = dir
        throw new Error("EACCES: permission denied")
      },
    })
    scratch.push(left)
    expect(guard.ok).toBe(false)
    const text = guard.ok ? "" : guard.problems.join("\n")
    expect(text).toContain(`the private copy of the store \`${left}\` could not be removed (EACCES: permission denied); remove that directory by hand`)
    expect(text).toContain("the count is not used")
    expect(text).not.toContain("session=1")
    expect(text).not.toContain(ROW_CONTENT_MARKER)
  })

  test("a connection that will not close still has its copy removed, and the result is a refusal", async () => {
    const removed: string[] = []
    const guard = await storeGuard(await walStore(), {
      close: (db) => {
        db.close()
        throw new Error("close failed")
      },
      removeCopy: async (dir) => {
        await rm(dir, { recursive: true, force: true })
        removed.push(dir)
      },
    })
    expect(removed).toHaveLength(1)
    expect(await Bun.file(join(removed[0]!, "opencode.db")).exists()).toBe(false)
    expect(guard.ok).toBe(false)
    expect(guard.ok ? "" : guard.problems.join("\n")).toContain("could not be closed (close failed); the count is not used")
  })

  test("a connection that will not close on a rollback-mode store is reported too", async () => {
    const reading = await readStoreCounts(await store(), {
      close: (db) => {
        db.close()
        throw new Error("close failed")
      },
    })
    expect(reading.kind === "unreadable" ? reading.reason : "").toContain("could not be closed (close failed)")
  })
})

describe("the probe's placeholder store after the run", () => {
  test("a nonempty store is recorded as expected probe state, never as an empty store", async () => {
    const guard = await probeStoreAfterRun(await store({ session: 1, message: 2, part: 3 }))
    expect(guard.ok).toBe(true)
    const line = guard.ok ? guard.line : ""
    expect(line).toContain("placeholder store after the run: session=1, message=2, part=3, permission=0")
    expect(line).toContain("expected probe state")
    expect(line).toContain("not an empty-store check")
    expect(line).not.toContain("every named table empty")
    expect(line).not.toContain(ROW_CONTENT_MARKER)
  })

  test("an unreadable store still fails", async () => {
    const guard = await probeStoreAfterRun(await store({}, ["permission"]))
    expect(guard.ok ? "" : guard.problems.join("\n")).toContain("has no table `permission`")
  })
})

test("the guarded tables are the allowlist named in the pinned schema's order", () => {
  expect([...STORE_TABLES]).toEqual(["session", "message", "part", "permission", "credential", "account", "account_state", "control_account"])
})
