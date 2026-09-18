/**
 * The truth sheets `ablation/adjudication-read.test.ts` reads, written beside the
 * labelled paired bundle the labelled reader's own fixtures already build.
 *
 * It sits beside `paired-read.fixture.ts` for that module's reason: one bundle
 * shape, built once. What is new here is only the human-authored file — a sheet
 * builder that starts from a block's canonical prefix pool and labels every
 * candidate in it, so a test names only the row it is about.
 *
 * NOTHING HERE IS AN ANSWER KEY. The labels are whatever a test asks for; the
 * point of the builder is that a COMPLETE sheet is the default, so a test that
 * wants an incomplete one has to say which row it dropped.
 */

import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { ADJUDICATION_SHEET_FILE, ADJUDICATION_SHEET_VERSION, type TruthLabel } from "./adjudication-read.ts"
import type { PairedSchedule } from "./schedule.ts"

export interface SheetRowInput {
  candidateId: string
  truth: TruthLabel
  evidence?: string
}

export interface SheetBlockInput {
  block: number
  prefixRunId: string
  rows: SheetRowInput[]
}

/** The document `<bundle>/adjudication.json` holds, with any field replaceable. */
export interface SheetInput {
  adjudicationSheetVersion?: unknown
  scheduleHash?: unknown
  blocks?: unknown
}

/**
 * A complete page for one block: one row for every candidate in `pool`.
 *
 * `label` decides each row. It defaults to `true-defect` so a test that cares
 * about only one candidate writes one arrow function rather than a whole table.
 */
export function pageFor(
  block: number,
  pool: readonly { id: string }[],
  label: (id: string, index: number) => TruthLabel = () => "true-defect",
  prefixRunId = `run-prefix-${block}`,
): SheetBlockInput {
  return {
    block,
    prefixRunId,
    rows: pool.map((finding, index) => ({
      candidateId: finding.id,
      truth: label(finding.id, index),
      evidence: `line cite for \`${finding.id}\``,
    })),
  }
}

/** The whole sheet, bound to a sealed schedule unless a test overrides the hash. */
export function sheetFor(schedule: PairedSchedule, blocks: readonly SheetBlockInput[], over: SheetInput = {}): unknown {
  return {
    adjudicationSheetVersion: ADJUDICATION_SHEET_VERSION,
    scheduleHash: schedule.scheduleHash,
    blocks,
    ...over,
  }
}

/** Write a sheet — or any JSON at all — to `<root>/adjudication.json`. */
export async function writeSheet(root: string, document: unknown): Promise<string> {
  const file = join(root, ADJUDICATION_SHEET_FILE)
  await writeFile(file, typeof document === "string" ? document : JSON.stringify(document))
  return file
}
