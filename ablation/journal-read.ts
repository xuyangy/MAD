/**
 * Story 2-8c3a — the persisted-journal reader: `paired-journal.jsonl`, read back
 * for a report.
 *
 * The journal's guarantees (an admission is durable before it goes out, each
 * request settles once, a conflicting payload is an integrity failure) live in
 * its replay, so this reader does not count lines. It replays the whole file
 * through the journal's own line validation and state machine
 * (`replayPersistedJournal`), and refuses rather than tallies when what it
 * replayed is not a finished bill:
 *
 * - an absent or unreadable file, or a line that does not validate;
 * - a file mixing accounting modes, or recording another mode than expected;
 * - any integrity failure;
 * - any request issued and never settled (uncertain), because its ending is not
 *   established and the count would be read as final.
 *
 * It never writes, never takes the lock, and never throws.
 *
 * AD-1: this tree may import from `core/`. Nothing under `core/` imports it.
 */

import { join, resolve } from "node:path"

import type { AccountingMode } from "./governor.ts"
import { JOURNAL_FILE, replayPersistedJournal, type UniqueExecutionBill } from "./journal.ts"

export type JournalReadOutcome =
  | { ok: true; file: string; mode: AccountingMode; bill: UniqueExecutionBill }
  | { ok: false; file: string; reason: string }

/** Read and validate the bundle root's journal. `expected`, when given, is the mode it must record. */
export async function readPersistedJournal(bundleRoot: string, expected?: AccountingMode): Promise<JournalReadOutcome> {
  const file = join(resolve(bundleRoot), JOURNAL_FILE)
  const refuse = (reason: string): JournalReadOutcome => ({ ok: false, file, reason })
  try {
    const replayed = await replayPersistedJournal(file, expected)
    if (!replayed.ok) return refuse(replayed.reason)
    if (!replayed.existed) return refuse(`the journal \`${file}\` does not exist, so nothing it admitted can be read`)
    const bill = replayed.bill
    if (bill.integrity.length > 0) {
      return refuse(
        `the journal \`${file}\` holds ${bill.integrity.length} integrity failure(s), beginning with: ` +
          `${bill.integrity[0]!.reason}; a conflicted journal is not a bill`,
      )
    }
    if (bill.uncertain.length > 0) {
      return refuse(
        `the journal \`${file}\` is incomplete: ${bill.uncertain.length} request(s) were issued and never settled, ` +
          `beginning with \`${bill.uncertain[0]!.physicalId}\`, so no count read from it is final`,
      )
    }
    return { ok: true, file, mode: replayed.mode, bill }
  } catch (error) {
    return refuse(`the journal \`${file}\` could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
}
