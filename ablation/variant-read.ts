/**
 * THE DEBATE-VARIANTS READER, part one: the measures `ablation/DEBATE-VARIANTS.md`
 * defines, read from a bundle `runVariantBlocks` wrote, per block and per
 * continuation, and which variant-to-baseline contrasts each block supports.
 *
 * It bills nothing, runs no model, writes nothing and never throws. It
 * computes no precision and applies no promotion gate; those read these
 * measures later.
 *
 * ## THE FRAME IS THE NINE SEALED SLOTS
 *
 * The sealed schedule (`readVariantSchedule`, its own self-check) names nine
 * slots. Every slot is reported, whatever the bundle holds for it: a slot
 * with no manifest, an unreadable one, or one bound to another slot is
 * reported with the reason, never dropped.
 *
 * ## BINDING
 *
 * An arm's evidence counts for its slot only when all of it agrees: the
 * manifest's `variant` binding names this schedule, block, arm and position;
 * its prefix is the block's prefix evidence's run id, and the prefix evidence
 * is this schedule's, this block's, and records a fork; its protocol, fixture,
 * code revision, change and roster are the schedule's. The arm's `record.json`
 * must name the manifest's run. Anything else is a binding problem, and an
 * unbound arm has no measures.
 *
 * ## THREE KINDS OF RESULT
 *
 * Each measure is `measured`, `missing` (it could not be read; never filled in,
 * never carried from another block) or `not-applicable` (it does not exist for
 * this arm, or its denominator is zero). Measures are read for every bound arm,
 * whether or not it completed, so they can be reported as observed.
 *
 * - **Planted-defect recall**: `scoreUpheld` on the arm's upheld findings,
 *   only once the schedule and the arm are bound to the committed labelled
 *   change (`LABELLED_CHANGE_SEAL`).
 * - **Unresolved findings and verdict counts**, by `verdictState`.
 * - **Observed tokens**: `spentTokens(usageByOrigin(ledger).executedHere.tokens)`
 *   from the arm's own `record.json`, never `ledger.total`, which includes the
 *   inherited prefix. With any unknown-usage turn, or an unaudited ledger, the
 *   figure is a floor.
 * - **Turns with unknown usage**: `executedHere.unknown`, only when
 *   `usageIsAudited`; otherwise missing.
 * - **Newly issued attempts**: from the continuation's own journal rows, the
 *   Blocks rows of its block and phase with no `step` (a step is a further
 *   physical request inside one attempt) and not settled `not-issued`. Every
 *   such row must name the arm's run; a row naming another run makes the
 *   measure missing rather than filtering it away. A journal that does not
 *   replay in the debate-variants scope, or holds an integrity failure or an
 *   uncertain request, makes it missing for every slot.
 * - **The shared prefix** is reported once per block, with its own tokens and
 *   attempts by the same rules, and is never part of a continuation's figures.
 * - **references arm**: position changes, those citing at least one valid
 *   entry, those flagged `shiftWithoutValidReference`, and the cited share,
 *   not applicable when no position changed.
 * - **open-questions arm**: questions recorded. Questions that reached a
 *   Fact-Checker prompt are missing: the bundle holds no issued-prompt
 *   evidence, and a recorded question does not establish delivery.
 *
 * ## CONTRASTS
 *
 * Each variant is compared only with the baseline of its own block. A block
 * supports a variant's contrast when both continuations are bound and
 * completed: their slot's terminal status is `completed` and the manifest
 * reads as finished. A baseline that did not complete withholds both of its
 * block's contrasts; a variant that did not complete withholds only its own.
 *
 * AD-1: this tree may import from `core/` and `fixtures/`. Nothing under `core/`
 * imports it.
 */

import { readFile, realpath } from "node:fs/promises"
import { join, sep } from "node:path"

import { spentTokens, usageByOrigin, usageIsAudited } from "../core/budget/ledger.ts"
import type { Finding } from "../core/domain/finding.ts"
import type { TokenLedger } from "../core/domain/run-record.ts"
import { SEEDED_DEFECTS } from "../fixtures/seeded-defects/labels.ts"
import { SEEDED_CHANGE } from "../fixtures/seeded-defects/material.ts"
import { LABELLED_CHANGE_SEAL } from "../fixtures/seeded-defects/seal.ts"
import { lexicalDefectMatcher, type DefectMatcher } from "../fixtures/recall.ts"
import { verdictState, type VerdictState } from "./compare.ts"
import { sealedVariantAllowances } from "./governor.ts"
import { JOURNAL_FILE, replayPersistedJournal, type BilledRequest } from "./journal.ts"
import { changeIdFor } from "./manifest.ts"
import { loadPrefixRecord, scoreUpheld } from "./labelled-read.ts"
import { readPrefixEvidence, type PrefixReport } from "./paired-read.ts"
import { readBundle, type ArmRow } from "./read-bundle.ts"
import { canonicalJson, readStatusLines, SLOT_STATUS_FILE, type SlotStatus } from "./schedule.ts"
import { readVariantSchedule, type VariantSchedule, type VariantSlot } from "./variant-schedule.ts"
import type { VariantArm } from "./variants.ts"

export type Measure<T> =
  | { kind: "measured"; value: T }
  | { kind: "missing"; reason: string }
  | { kind: "not-applicable"; reason: string }

export interface ContinuationMeasures {
  recall: Measure<{ found: number; of: number; defectIds: string[] }>
  unresolved: Measure<number>
  verdicts: Measure<Record<VerdictState, number>>
  /** `floor` is true when the turns' usage is not completely known. */
  tokens: Measure<{ executedHere: number; floor: boolean }>
  unknownTurns: Measure<number>
  attempts: Measure<number>
  references: Measure<{ changes: number; withValidCitation: number; flagged: number; citedShare: Measure<number> }>
  openQuestions: Measure<number>
  questionsDelivered: Measure<number>
}

export interface ContinuationRead {
  slot: VariantSlot
  /** The slot's last terminal status line, or why none could be read. */
  status: { kind: "read"; status: SlotStatus; reason: string; runId?: string } | { kind: "missing"; reason: string }
  /** The run id of the bound manifest. */
  runId?: string
  /** Every reason this slot's evidence is not bound to it; empty when bound. */
  problems: string[]
  /** Bound, its slot `completed`, and its manifest finished. */
  completed: boolean
  /** Present only for a bound slot. */
  measures?: ContinuationMeasures
}

export interface PrefixRead {
  block: number
  evidence: PrefixReport
  runId?: string
  tokens: Measure<{ executedHere: number; floor: boolean }>
  unknownTurns: Measure<number>
  attempts: Measure<number>
}

export type Contrast =
  | { variant: "references" | "open-questions"; eligible: true }
  | { variant: "references" | "open-questions"; eligible: false; reason: string }

export interface VariantBlockRead {
  block: number
  prefix: PrefixRead
  /** The three slots, in scheduled order. */
  continuations: ContinuationRead[]
  contrasts: Contrast[]
}

export type VariantReadOutcome =
  | {
      kind: "read"
      root: string
      schedule: VariantSchedule
      /** Why planted-defect recall is missing everywhere, or `null` when the schedule binds the labelled change. */
      sealProblem: string | null
      /** Why the journal gave no attempt counts, or `null`. */
      journalProblem: string | null
      blocks: VariantBlockRead[]
    }
  | { kind: "refused"; reason: string }

export interface VariantReadOptions {
  /** Defaults to the shipped lexical matcher. */
  matcher?: DefectMatcher
}

/** The record file every run dump holds beside its manifest. */
const RECORD_FILE = "record.json"

const missing = (reason: string) => ({ kind: "missing" as const, reason })
const notApplicable = (reason: string) => ({ kind: "not-applicable" as const, reason })
const measured = <T>(value: T) => ({ kind: "measured" as const, value })

export async function readVariantBundle(root: string, options: VariantReadOptions = {}): Promise<VariantReadOutcome> {
  try {
    return await read(root, options.matcher ?? lexicalDefectMatcher)
  } catch (error) {
    return { kind: "refused", reason: `the debate-variants reader failed: ${messageOf(error)}` }
  }
}

async function read(root: string, matcher: DefectMatcher): Promise<VariantReadOutcome> {
  const scheduled = await readVariantSchedule(root)
  if (!scheduled.ok) return { kind: "refused", reason: scheduled.reason }
  const schedule = scheduled.schedule

  const sealProblem = sealProblemOf(schedule)
  const statuses = await slotStatuses(root, schedule)
  const journal = await journalRows(root, schedule)
  const bundle = await readBundle(root)
  const rows = "error" in bundle ? null : bundle
  const bundleProblem = "error" in bundle ? `the bundle could not be read: ${bundle.error}` : null

  const blocks: VariantBlockRead[] = []
  for (const [index, order] of schedule.order.entries()) {
    const block = index + 1
    const evidence = await readPrefixEvidence(root, schedule, block)
    // Identity and fork are two questions. The evidence is this schedule's and
    // this block's when it parsed and names both; only then are the prefix's own
    // figures read. Only a prefix that also forked binds a continuation
    // (`bindingProblems` refuses any arm while the evidence has a problem).
    const own = evidence.evidence !== null && evidence.evidence.scheduleHash === schedule.scheduleHash && evidence.evidence.block === block
    const prefixRunId = own && evidence.evidence!.prefixRunId.kind === "known" ? evidence.evidence!.prefixRunId.value : undefined
    const prefix = await readPrefix(root, schedule, block, evidence, own, prefixRunId, journal)

    const continuations: ContinuationRead[] = []
    for (const arm of order) {
      const slot = schedule.slots.find((entry) => entry.block === block && entry.arm === arm)!
      const status = statuses.get(`${block}:${arm}`) ?? missing("no slot status line names this slot")
      continuations.push(await readContinuation(slot, status, schedule, evidence, prefixRunId, rows, bundleProblem, journal, sealProblem, matcher))
    }
    blocks.push({ block, prefix, continuations, contrasts: contrastsOf(continuations) })
  }
  return { kind: "read", root, schedule, sealProblem, journalProblem: journal.ok ? null : journal.reason, blocks }
}

// ---------------------------------------------------------------------------
// The labelled change, slot statuses and the journal
// ---------------------------------------------------------------------------

/**
 * Why the schedule is not bound to the committed labelled change, or `null`.
 * The fixture's seal fields and the change are checked apart: the seal is what
 * the schedule claims, and the change's diff hash is what was reviewed, which
 * must be the shipped seeded change's.
 */
function sealProblemOf(schedule: VariantSchedule): string | null {
  const fixture = schedule.fixture as unknown as Record<string, unknown> | null
  for (const field of ["version", "materialHash", "labelsHash"] as const) {
    if (fixture === null || typeof fixture !== "object" || fixture[field] !== LABELLED_CHANGE_SEAL[field]) {
      return (
        `the schedule's fixture.${field} is ${JSON.stringify(fixture?.[field] ?? null)}, not the committed labelled ` +
        `change's ${JSON.stringify(LABELLED_CHANGE_SEAL[field])}, so its findings are not scored against the planted labels`
      )
    }
  }
  const seeded = changeIdFor(SEEDED_CHANGE).diffHash
  if (schedule.config.changeDiffHash !== seeded) {
    return (
      `the schedule's change has diff hash ${JSON.stringify(schedule.config.changeDiffHash)}, not the shipped seeded ` +
      `change's ${seeded}, so its findings are not scored against the planted labels`
    )
  }
  return null
}

const SLOT_STATUSES: readonly SlotStatus[] = ["started", "completed", "cancelled", "failed", "not-attempted"]

/**
 * Each planned slot's last terminal status line. A line that names no planned
 * slot, or names one at another position, or carries an unknown status, makes
 * the slot it names (or every slot, when it names none) missing.
 */
async function slotStatuses(root: string, schedule: VariantSchedule): Promise<Map<string, ContinuationRead["status"]>> {
  const result = new Map<string, ContinuationRead["status"]>()
  let lines: unknown[]
  try {
    lines = await readStatusLines<unknown>(join(root, SLOT_STATUS_FILE))
  } catch (error) {
    const why = missing(`the slot status file could not be read (${messageOf(error)})`)
    for (const slot of schedule.slots) result.set(`${slot.block}:${slot.arm}`, why)
    return result
  }
  const broken = new Set<string>()
  const last = new Map<string, { status: SlotStatus; reason: string; runId?: string }>()
  for (const [index, line] of lines.entries()) {
    const value = line as Record<string, unknown> | null
    const planned =
      value !== null && typeof value === "object"
        ? schedule.slots.find((slot) => slot.block === value.block && slot.arm === value.arm)
        : undefined
    if (planned === undefined) {
      const why = missing(`slot status line ${index + 1} names no planned slot`)
      for (const slot of schedule.slots) result.set(`${slot.block}:${slot.arm}`, why)
      return result
    }
    const key = `${planned.block}:${planned.arm}`
    if (value!.position !== planned.position || !SLOT_STATUSES.includes(value!.status as SlotStatus) || typeof value!.reason !== "string") {
      broken.add(key)
      result.set(key, missing(`slot status line ${index + 1} for this slot is malformed or names another position`))
      continue
    }
    if (value!.runId !== undefined && typeof value!.runId !== "string") {
      broken.add(key)
      result.set(key, missing(`slot status line ${index + 1} for this slot carries a run id that is not a string`))
      continue
    }
    if (value!.status !== "started") {
      last.set(key, {
        status: value!.status as SlotStatus,
        reason: value!.reason as string,
        ...(typeof value!.runId === "string" ? { runId: value!.runId } : {}),
      })
    } else last.delete(key)
  }
  for (const slot of schedule.slots) {
    const key = `${slot.block}:${slot.arm}`
    if (broken.has(key)) continue
    const terminal = last.get(key)
    result.set(key, terminal === undefined ? missing("no terminal status line names this slot") : { kind: "read", ...terminal })
  }
  return result
}

type JournalRows = { ok: true; requests: BilledRequest[] } | { ok: false; reason: string }

/** The journal replayed in the debate-variants scope against the sealed allowances, or why its rows cannot be counted. */
async function journalRows(root: string, schedule: VariantSchedule): Promise<JournalRows> {
  const limits = sealedVariantAllowances(schedule.config.allowances)
  if (!limits.ok) return { ok: false, reason: `the schedule's allowances cannot be read: ${limits.reason}` }
  const replayed = await replayPersistedJournal(join(root, JOURNAL_FILE), "tokens", "debate-variants", limits.allowances)
  if (!replayed.ok) return { ok: false, reason: `the journal does not replay: ${replayed.reason}` }
  if (!replayed.existed) return { ok: false, reason: "the journal does not exist" }
  const bill = replayed.bill
  if (bill.integrity.length > 0) return { ok: false, reason: `the journal records ${bill.integrity.length} integrity failure(s): ${bill.integrity[0]!.reason}` }
  if (bill.uncertain.length > 0) {
    return { ok: false, reason: `the journal holds ${bill.uncertain.length} request(s) issued and never settled, so no count is final` }
  }
  return { ok: true, requests: bill.requests }
}

/** One phase's newly issued attempts: its Blocks rows with no step and not `not-issued`, every row naming `runId`. */
function attemptsOf(journal: JournalRows, block: number, phase: string, runId: string | undefined): Measure<number> {
  if (!journal.ok) return missing(journal.reason)
  if (runId === undefined) return missing("no run id is bound to this phase")
  const rows = journal.requests.filter((request) => request.category === "blocks" && request.block === block && request.phase === phase)
  const foreign = rows.find((request) => request.runId !== runId)
  if (foreign !== undefined) {
    return missing(`journal row \`${foreign.physicalId}\` of block ${block} ${phase} names run \`${foreign.runId}\`, not \`${runId}\``)
  }
  return measured(rows.filter((request) => request.step === undefined && request.state !== "not-issued").length)
}

// ---------------------------------------------------------------------------
// Ledgers
// ---------------------------------------------------------------------------

/** `child` is a strict descendant of `parent`. Both are real paths. */
function inside(parent: string, child: string): boolean {
  const base = parent.endsWith(sep) ? parent : `${parent}${sep}`
  return child !== parent && child.startsWith(base)
}

/**
 * A run's `record.json`, read only when the directory and the file resolve,
 * by real path, inside the real bundle root: its run id, and its ledger or why
 * the ledger cannot be used. `inheritFrom` is the run whose rows the ledger may
 * hold as inherited: the block's prefix for a continuation, none for a prefix.
 */
type RecordRead =
  | { ok: true; runId: string; ledger: { ok: true; ledger: TokenLedger } | { ok: false; reason: string } }
  | { ok: false; reason: string }

async function readRecord(root: string, directory: string, inheritFrom: string | null): Promise<RecordRead> {
  let realRoot: string
  let realFile: string
  const file = join(directory, RECORD_FILE)
  try {
    realRoot = await realpath(root)
    const realDirectory = await realpath(directory)
    realFile = await realpath(file)
    if (!inside(realRoot, realDirectory) || !inside(realDirectory, realFile)) {
      return { ok: false, reason: `\`${file}\` resolves to \`${realFile}\`, which is not inside the bundle root \`${realRoot}\`` }
    }
  } catch (error) {
    return { ok: false, reason: `\`${file}\` could not be resolved (${messageOf(error)})` }
  }
  return parseRecordFile(realFile, inheritFrom)
}

/** The record at exactly `file`, already resolved and contained by the caller: its run id and its ledger, or why not. */
async function parseRecordFile(file: string, inheritFrom: string | null): Promise<RecordRead> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, "utf8"))
  } catch (error) {
    return { ok: false, reason: `\`${file}\` could not be read (${messageOf(error)})` }
  }
  const record = raw as Record<string, unknown> | null
  if (record === null || typeof record !== "object" || typeof record.runId !== "string" || record.runId.length === 0) {
    return { ok: false, reason: `\`${file}\` names no run` }
  }
  const problem = ledgerProblem(record.ledger, inheritFrom)
  return {
    ok: true,
    runId: record.runId,
    ledger: problem === null ? { ok: true, ledger: record.ledger as TokenLedger } : { ok: false, reason: `\`${file}\`'s ledger ${problem}` },
  }
}

function isTokens(value: unknown): boolean {
  const tokens = value as Record<string, unknown> | null
  return (
    tokens !== null &&
    typeof tokens === "object" &&
    ["input", "output", "reasoning", "cacheRead", "cacheWrite"].every(
      (key) => typeof tokens[key] === "number" && Number.isFinite(tokens[key]) && (tokens[key] as number) >= 0,
    )
  )
}

/**
 * Why a ledger cannot be counted, or `null`. Every field `usageByOrigin` and
 * `usageIsAudited` read is checked: each entry's tokens, and each origin,
 * which may only name `inheritFrom` (a prefix inherits nothing); an
 * unknown-usage collection, when present, must hold well-formed rows with the
 * same origin rule. An absent collection is an unaudited ledger, not an error.
 */
function ledgerProblem(value: unknown, inheritFrom: string | null): string | null {
  const ledger = value as Record<string, unknown> | null | undefined
  if (ledger === null || typeof ledger !== "object" || !Array.isArray(ledger.entries)) return "is not a ledger with an entries list"
  const originProblem = (origin: unknown, at: string, kind: "entry" | "unknown"): string | null => {
    if (origin === undefined) return null
    if (inheritFrom === null) return `${at} carries an origin, and a prefix inherits nothing`
    const value = origin as Record<string, unknown> | null
    if (value === null || typeof value !== "object" || value.runId !== inheritFrom) {
      return `${at} carries origin ${JSON.stringify(origin)}, which does not name the block's prefix \`${inheritFrom}\``
    }
    const keys = Object.keys(value).sort().join(",")
    const shaped =
      kind === "unknown"
        ? keys === "runId"
        : (keys === "entry,runId" && Number.isSafeInteger(value.entry) && (value.entry as number) >= 0) ||
          (keys === "executionId,runId" && typeof value.executionId === "string" && value.executionId.length > 0)
    return shaped ? null : `${at} carries a malformed origin ${JSON.stringify(origin)}`
  }
  for (const [index, entry] of ledger.entries.entries()) {
    const row = entry as Record<string, unknown> | null
    if (row === null || typeof row !== "object" || !isTokens(row.tokens)) return `entry ${index} carries no countable tokens`
    const problem = originProblem(row.origin, `entry ${index}`, "entry")
    if (problem !== null) return problem
  }
  if (ledger.unknownUsage === undefined) return null
  if (!Array.isArray(ledger.unknownUsage)) return "has an unknown-usage collection that is not a list"
  for (const [index, entry] of ledger.unknownUsage.entries()) {
    const row = entry as Record<string, unknown> | null
    if (
      row === null ||
      typeof row !== "object" ||
      typeof row.slot !== "string" ||
      typeof row.stage !== "string" ||
      !Number.isSafeInteger(row.attempt) ||
      (row.attempt as number) < 1 ||
      typeof row.executionId !== "string" ||
      typeof row.why !== "string"
    ) {
      return `unknown-usage row ${index} is malformed`
    }
    const problem = originProblem(row.origin, `unknown-usage row ${index}`, "unknown")
    if (problem !== null) return problem
  }
  return null
}

function usageMeasures(ledger: TokenLedger): Pick<ContinuationMeasures, "tokens" | "unknownTurns"> {
  const here = usageByOrigin(ledger).executedHere
  const audited = usageIsAudited(ledger)
  return {
    tokens: measured({ executedHere: spentTokens(here.tokens), floor: !audited || here.unknown > 0 }),
    unknownTurns: audited ? measured(here.unknown) : missing("the ledger carries no unknown-usage collection, so unknown turns were not audited"),
  }
}

// ---------------------------------------------------------------------------
// The prefix
// ---------------------------------------------------------------------------

/**
 * The block's shared prefix, figures read whenever its evidence is this
 * schedule's and this block's, whether or not it forked: a prefix that failed
 * or was not forked still spent what it spent.
 */
async function readPrefix(
  root: string,
  schedule: VariantSchedule,
  block: number,
  evidence: PrefixReport,
  own: boolean,
  runId: string | undefined,
  journal: JournalRows,
): Promise<PrefixRead> {
  const base = { block, evidence, ...(runId === undefined ? {} : { runId }) }
  if (!own) {
    const why = missing(`its prefix evidence is not this schedule's block ${block}: ${evidence.problem ?? "unreadable"}`)
    return { ...base, attempts: why, tokens: why, unknownTurns: why }
  }
  const attempts = attemptsOf(journal, block, "prefix", runId)
  // The fork question is answered above; the record is loaded on identity alone.
  const loaded = await loadPrefixRecord(root, schedule, { block, prefix: { problem: null, evidence: evidence.evidence } })
  if (loaded.kind !== "loaded") {
    const why = missing(`the prefix record is ${loaded.kind}: ${loaded.reasons.join("; ")}`)
    return { ...base, attempts, tokens: why, unknownTurns: why }
  }
  // The very file `loadPrefixRecord` resolved, contained and bound, read once
  // more for its ledger, and held to the same run id.
  const record = await parseRecordFile(loaded.file, null)
  const ledger = !record.ok
    ? record
    : record.runId !== runId
      ? { ok: false as const, reason: `\`${loaded.file}\` names run \`${record.runId}\`, not the prefix \`${runId}\`` }
      : record.ledger
  if (!ledger.ok) return { ...base, attempts, tokens: missing(ledger.reason), unknownTurns: missing(ledger.reason) }
  return { ...base, attempts, ...usageMeasures(ledger.ledger) }
}

// ---------------------------------------------------------------------------
// One continuation
// ---------------------------------------------------------------------------

function rowFor(rows: { root: string; comparable: ArmRow[]; segregated: ArmRow[]; missing: { armId: string; repeatId: number; reason: string }[]; unreadable: { armId: string; repeatId: number; reason: string }[] }, slot: VariantSlot): ArmRow | string {
  const match = (entry: { armId: string; repeatId: number }) => entry.armId === slot.arm && entry.repeatId === slot.block - 1
  const row = [...rows.comparable, ...rows.segregated].find(match)
  if (row !== undefined) return row
  const absent = [...rows.missing, ...rows.unreadable].find(match)
  return absent === undefined ? "the bundle declares no arm for this slot" : absent.reason
}

/** Every reason the row's evidence is not this slot's. */
function bindingProblems(row: ArmRow, slot: VariantSlot, schedule: VariantSchedule, evidence: PrefixReport, prefixRunId: string | undefined): string[] {
  const problems: string[] = []
  const manifest = row.manifest
  const variant = manifest.variant
  if (variant === undefined) return ["its manifest carries no `variant` binding, so it is not a debate-variants arm"]
  if (variant.scheduleHash !== schedule.scheduleHash) problems.push(`its \`variant.scheduleHash\` is not the sealed schedule's`)
  if (variant.block !== slot.block || variant.arm !== slot.arm || variant.position !== slot.position) {
    problems.push(`its \`variant\` names block ${variant.block} ${variant.arm} ${variant.position}, not this slot (${slot.block} ${slot.arm} ${slot.position})`)
  }
  if (evidence.problem !== null) problems.push(`its block's prefix evidence does not support it: ${evidence.problem}`)
  else if (variant.prefixRunId !== prefixRunId) problems.push(`its prefix \`${variant.prefixRunId}\` is not the block's prefix \`${prefixRunId}\``)
  const identity = manifest.identity
  const known = (value: { kind: string; value?: unknown } | undefined) => (value?.kind === "known" ? value.value : undefined)
  if (known(identity.protocolHash) !== schedule.protocol.hash || known(identity.protocolVersion) !== schedule.protocol.version) {
    problems.push("its protocol is not the sealed schedule's")
  }
  if (known(identity.fixtureHash) !== schedule.fixture.materialHash) problems.push("its fixture is not the sealed schedule's")
  if (canonicalJson(identity.codeRevision) !== canonicalJson(schedule.codeRevision)) problems.push("its code revision is not the sealed schedule's")
  if (identity.changeId?.diffHash !== schedule.config.changeDiffHash) problems.push("its change is not the sealed schedule's")
  if (
    canonicalJson(manifest.roster.slots) !== canonicalJson(schedule.roster.slots) ||
    canonicalJson(manifest.roster.lensSlots) !== canonicalJson(schedule.roster.lensSlots)
  ) {
    problems.push("its roster is not the sealed schedule's")
  }
  return problems
}

async function readContinuation(
  slot: VariantSlot,
  status: ContinuationRead["status"],
  schedule: VariantSchedule,
  evidence: PrefixReport,
  prefixRunId: string | undefined,
  rows: Parameters<typeof rowFor>[0] | null,
  bundleProblem: string | null,
  journal: JournalRows,
  sealProblem: string | null,
  matcher: DefectMatcher,
): Promise<ContinuationRead> {
  const unbound = (problem: string): ContinuationRead => ({ slot, status, problems: [problem], completed: false })
  if (rows === null) return unbound(bundleProblem!)
  const row = rowFor(rows, slot)
  if (typeof row === "string") return unbound(`no readable manifest: ${row}`)
  const runId = row.manifest.run.runId
  const problems = bindingProblems(row, slot, schedule, evidence, prefixRunId)
  const record = await readRecord(rows.root, row.directory, prefixRunId ?? null)
  if (!record.ok) problems.push(`its record.json is not readable: ${record.reason}`)
  else if (record.runId !== runId) problems.push(`its record.json names run \`${record.runId}\`, not the manifest's \`${runId}\``)
  if (problems.length > 0 || !record.ok) return { slot, status, runId, problems, completed: false }

  // Completed is three agreeing facts: the slot's terminal line says completed
  // for this run, and the manifest reads as a finished run (completed, or
  // degraded by a warning) with a known finish time.
  const completion = row.manifest.status.completion
  const finished = (completion === "completed" || completion === "degraded") && row.manifest.run.finishedAt.kind === "known"
  const completed = status.kind === "read" && status.status === "completed" && status.runId === runId && finished
  return { slot, status, runId, problems, completed, measures: measuresOf(slot.arm, row.findings, record.ledger, journal, slot.block, runId, sealProblem, matcher) }
}

function measuresOf(
  arm: VariantArm,
  findings: readonly Finding[],
  ledger: { ok: true; ledger: TokenLedger } | { ok: false; reason: string },
  journal: JournalRows,
  block: number,
  runId: string,
  sealProblem: string | null,
  matcher: DefectMatcher,
): ContinuationMeasures {
  const verdicts = Object.fromEntries(
    (["upheld", "withdrawn-by-author", "judge-ruled-invalid", "not-adjudicated", "unresolved", "unjudged"] as VerdictState[]).map((state) => [state, 0]),
  ) as Record<VerdictState, number>
  for (const finding of findings) verdicts[verdictState(finding)] += 1
  return {
    recall: recallOf(findings, sealProblem, matcher),
    unresolved: measured(verdicts.unresolved),
    verdicts: measured(verdicts),
    ...(ledger.ok ? usageMeasures(ledger.ledger) : { tokens: missing(ledger.reason), unknownTurns: missing(ledger.reason) }),
    attempts: attemptsOf(journal, block, arm, runId),
    references: arm === "references" ? referencesOf(findings) : notApplicable(`the ${arm} arm records no citations`),
    openQuestions:
      arm === "open-questions"
        ? measured(findings.reduce((total, finding) => total + finding.history.reduce((sum, entry) => sum + (entry.missingEvidence?.length ?? 0), 0), 0))
        : notApplicable(`the ${arm} arm records no open questions`),
    questionsDelivered:
      arm === "open-questions"
        ? missing("the bundle holds no issued-prompt evidence, so delivery to a Fact-Checker prompt is not established")
        : notApplicable(`the ${arm} arm records no open questions`),
  }
}

function recallOf(findings: readonly Finding[], sealProblem: string | null, matcher: DefectMatcher): ContinuationMeasures["recall"] {
  if (sealProblem !== null) return missing(sealProblem)
  const scored = scoreUpheld(findings, matcher)
  if (scored.kind !== "measured") return missing(scored.reason)
  const defectIds = [...new Set(scored.matches.map((match) => match.defectId))].sort()
  return measured({ found: defectIds.length, of: SEEDED_DEFECTS.length, defectIds })
}

/** The references arm's citation counts from its findings' debate entries. Exported for tests. */
export function referencesOf(findings: readonly Finding[]): ContinuationMeasures["references"] {
  let changes = 0
  let withValidCitation = 0
  let flagged = 0
  for (const finding of findings) {
    for (const entry of finding.history) {
      if (entry.kind !== "debate-round" || entry.positionChanged !== true) continue
      changes += 1
      if ((entry.references?.length ?? 0) > 0) withValidCitation += 1
      if (entry.shiftWithoutValidReference === true) flagged += 1
    }
  }
  return measured({
    changes,
    withValidCitation,
    flagged,
    citedShare: changes === 0 ? notApplicable("no position changed, so the cited share has no denominator") : measured(withValidCitation / changes),
  })
}

// ---------------------------------------------------------------------------
// Contrasts
// ---------------------------------------------------------------------------

function contrastsOf(continuations: readonly ContinuationRead[]): Contrast[] {
  const of = (arm: VariantArm) => continuations.find((entry) => entry.slot.arm === arm)!
  const why = (entry: ContinuationRead): string =>
    entry.problems.length > 0
      ? `its evidence is not bound (${entry.problems.join("; ")})`
      : entry.status.kind === "missing"
        ? `its status is missing (${entry.status.reason})`
        : entry.status.status !== "completed"
          ? `it is ${entry.status.status} (${entry.status.reason})`
          : entry.status.runId !== entry.runId
            ? `its completed status line names run ${JSON.stringify(entry.status.runId ?? null)}, not \`${entry.runId}\``
            : "its manifest does not read as a finished run"
  const baseline = of("baseline")
  return (["references", "open-questions"] as const).map((variant) => {
    if (!baseline.completed) return { variant, eligible: false, reason: `the block's baseline did not complete: ${why(baseline)}` }
    const own = of(variant)
    if (!own.completed) return { variant, eligible: false, reason: `the ${variant} continuation did not complete: ${why(own)}` }
    return { variant, eligible: true }
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
