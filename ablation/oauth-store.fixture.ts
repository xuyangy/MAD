/**
 * Story 2-8c4 — a test's own opencode database under a temporary data directory.
 * Nothing here opens the user's stores.
 */

import { Database } from "bun:sqlite"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"

import { STORE_TABLES, storeDatabasePath, type StoreTable } from "./oauth-store.ts"

/** The marker every fake row holds; no output may carry it. */
export const ROW_CONTENT_MARKER = "mad-test-row-content-never-read"

/** Writes `<dataDir>/opencode/opencode.db` with every named table (less `omit`) and `rows[table]` rows in each. */
export async function fakeStore(dataDir: string, rows: Partial<Record<StoreTable, number>> = {}, omit: readonly StoreTable[] = []): Promise<string> {
  await mkdir(join(dataDir, "opencode"), { recursive: true })
  const path = storeDatabasePath(dataDir)
  const db = new Database(path, { create: true })
  try {
    for (const table of STORE_TABLES) {
      if (omit.includes(table)) continue
      db.run(`CREATE TABLE IF NOT EXISTS "${table}" (id TEXT, secret TEXT)`)
      db.run(`DELETE FROM "${table}"`)
      for (let index = 0; index < (rows[table] ?? 0); index += 1) db.run(`INSERT INTO "${table}" VALUES (?, ?)`, [`${table}-${index}`, ROW_CONTENT_MARKER])
    }
  } finally {
    db.close()
  }
  return path
}
