/**
 * Story 2-7b — the sealed sixteen-slot schedule of the adversarial suite, its
 * verification, its start marker and its slot-status file
 * (`evaluation-protocol.md` §5, *Schedule*).
 *
 * ## The §5 rule, exactly
 *
 * Cases run in the sealed manifest order. For each consecutive pair of cases
 * (1-2, 3-4, 5-6, 7-8) one fair coin (`cryptoCoin`) decides which case runs
 * clean first and which attack first: heads runs the pair's first case clean
 * first and its second case attack first; tails the reverse. Four coins, so four
 * cases are clean-first and four attack-first, whatever the coins say. Each case
 * runs its two sides back to back.
 *
 * ## Files, all under `<experiment root>/adversarial/`, none overwritten
 *
 *   adversarial-schedule.json   the sealed schedule; published with `wx` + `link`
 *   adversarial-start.json      written once before the first billable action
 *   adversarial-slots.jsonl     append-only started/terminal status per slot,
 *                               with each attack run's delivery evidence
 *
 * The journal, the lock and the halt marker are the EXPERIMENT ROOT's, shared
 * with every category (`ablation/journal.ts`). Nothing here touches the paired
 * schedule, start marker or `bundle.json` at the root.
 *
 * AD-1: this tree may import from `core/` and `fixtures/`. Nothing under `core/`
 * imports it.
 */

import { mkdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { CUMULATIVE_SHARE } from "../core/budget/presets.ts"
import type { Roster } from "../core/domain/roster.ts"
import { ADVERSARIAL_ASSERTIONS, type AdversarialAssertion } from "../fixtures/adversarial/assertions.ts"
import { ADVERSARIAL_CASES, type AdversarialMaterial, type AdversarialSurface, type PayloadCarrier } from "../fixtures/adversarial/material.ts"
import { ADVERSARIAL_SEAL, adversarialSealProblem, type AdversarialSeal } from "../fixtures/adversarial/seal.ts"
import type { Provenance } from "./arms.ts"
import { ADVERSARIAL_ALLOWANCES } from "./governor.ts"
import { acquireLock } from "./journal.ts"
import type { CodeRevision, Maybe } from "./manifest.ts"
import {
  appendStatusLine,
  canonicalJson,
  cryptoCoin,
  instructionsDigestOf,
  publishExclusive,
  readFrozenProtocol,
  readStatusLines,
  sha256,
  writeStartMarker,
  type CoinFace,
  type SlotStatus,
  type Started,
} from "./schedule.ts"

export const ADVERSARIAL_DIRECTORY = "adversarial"
export const ADVERSARIAL_SCHEDULE_FILE = "adversarial-schedule.json"
export const ADVERSARIAL_START_MARKER_FILE = "adversarial-start.json"
export const ADVERSARIAL_SLOT_STATUS_FILE = "adversarial-slots.jsonl"

/** Bumped by hand when the schedule document's shape changes. */
export const ADVERSARIAL_SCHEDULE_VERSION = 1

export type Side = "clean" | "attack"
export type SideOrder = "first" | "second"

/** One of the sixteen planned runs. */
export interface AdversarialSlot {
  /** 1-based execution position, 1..16. */
  position: number
  caseId: string
  /** 0-based index in the sealed case order. */
  caseIndex: number
  side: Side
  /** Whether this side runs first or second within its case. */
  order: SideOrder
}

/** `<experiment root>/adversarial`. */
export function adversarialDirectory(experimentRoot: string): string {
  return join(resolve(experimentRoot), ADVERSARIAL_DIRECTORY)
}

/** The side each case runs first, from one coin per consecutive pair of cases. */
export function firstSidesFor(coins: readonly CoinFace[], caseCount: number): Side[] {
  const sides: Side[] = []
  for (let index = 0; index < caseCount; index += 1) {
    const coin = coins[Math.floor(index / 2)]!
    const leading = index % 2 === 0
    sides.push((coin === "heads") === leading ? "clean" : "attack")
  }
  return sides
}

export function adversarialSlots(caseIds: readonly string[], coins: readonly CoinFace[]): AdversarialSlot[] {
  const first = firstSidesFor(coins, caseIds.length)
  return caseIds.flatMap((caseId, caseIndex) => {
    const lead = first[caseIndex]!
    const other: Side = lead === "clean" ? "attack" : "clean"
    return [
      { position: caseIndex * 2 + 1, caseId, caseIndex, side: lead, order: "first" as const },
      { position: caseIndex * 2 + 2, caseId, caseIndex, side: other, order: "second" as const },
    ]
  })
}

/** The settings every adversarial run receives. The `Tools` identity is required: tools are the observed route. */
export interface AdversarialConfig {
  provenance: Provenance
  maxConcurrency?: number
  /** The identity of the `Tools` configuration every run gets (the adapter and how its worktree is chosen). */
  tools: string
}

/** Every setting the runs receive, as the schedule binds it. The run cap and shares are fixed here. */
export function adversarialRunConfig(config: AdversarialConfig, roster: Roster): Record<string, unknown> {
  return {
    provenance: config.provenance,
    tokenCap: ADVERSARIAL_ALLOWANCES.runCap,
    spendShares: { ...CUMULATIVE_SHARE },
    stopOnUnknownUsage: true,
    maxConcurrency: config.maxConcurrency,
    allowances: { ...ADVERSARIAL_ALLOWANCES },
    instructionsDigest: instructionsDigestOf(roster),
    tools: config.tools,
  }
}

export interface AdversarialSchedule {
  scheduleVersion: number
  createdAt: string
  /** One coin per consecutive pair of cases. */
  coins: CoinFace[]
  firstSides: { caseId: string; first: Side }[]
  slots: AdversarialSlot[]
  protocol: { id: string; version: number; hash: string }
  cases: AdversarialSeal & { caseIds: string[] }
  codeRevision: Maybe<CodeRevision>
  roster: Roster
  config: Record<string, unknown>
  configDigest: string
  /** `sha256:` over the canonical JSON of every other field. */
  scheduleHash: string
}

export function adversarialScheduleHashOf(schedule: Omit<AdversarialSchedule, "scheduleHash"> & { scheduleHash?: string }): string {
  const { scheduleHash: _excluded, ...sealed } = schedule
  return sha256(canonicalJson(sealed))
}

/**
 * Why a `maxConcurrency` is refused, or `null`. The roster has one slot, and
 * every run rebinds one shared Bun `$` to its own worktree, so more than one
 * turn in flight buys nothing and a concurrent blame could run in the wrong
 * worktree.
 */
export function concurrencyProblem(config: Pick<AdversarialConfig, "maxConcurrency">): string | null {
  if (config.maxConcurrency !== undefined && config.maxConcurrency > 1) {
    return (
      `maxConcurrency ${config.maxConcurrency} is refused: the adversarial runs use a one-slot roster over a shared ` +
      "Bun `$` that each run rebinds to its own worktree, so at most one turn may be in flight"
    )
  }
  return null
}

/** Why a roster is not the protocol's one-slot roster, or `null`. */
export function oneSlotProblem(roster: Roster): string | null {
  if (roster.slots.length !== 1 || roster.lensSlots.length !== 0) {
    return (
      `the adversarial runs use a ONE-SLOT roster (human decision, 2026-09-10); this roster has ` +
      `${roster.slots.length} slot(s) and ${roster.lensSlots.length} lens slot(s)`
    )
  }
  return null
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateAdversarialScheduleInput {
  experimentRoot: string
  protocolFile: string
  codeRevision: Maybe<CodeRevision>
  roster: Roster
  config: AdversarialConfig
  createdAt: string
  /** Injected for tests. Defaults to `cryptoCoin`. Called once per pair of cases. */
  coin?: () => CoinFace
  /** Seams for a drift test; default to the sealed fixture. */
  cases?: readonly AdversarialMaterial[]
  assertions?: readonly AdversarialAssertion[]
}

export type AdversarialScheduleCreated =
  | { ok: true; schedule: AdversarialSchedule; file: string }
  | { ok: false; reason: string }

/**
 * Toss the four coins and publish the schedule, under the experiment root's
 * lock. Refuses, and tosses nothing, when a schedule exists, the seal does not
 * verify, the protocol does not verify or the roster is not one slot. Bills
 * nothing.
 */
export async function createAdversarialSchedule(input: CreateAdversarialScheduleInput): Promise<AdversarialScheduleCreated> {
  const root = resolve(input.experimentRoot)
  const lock = await acquireLock(root, input.createdAt)
  if (!lock.ok) return { ok: false, reason: lock.reason }
  let created: AdversarialScheduleCreated
  try {
    created = await publishAdversarialSchedule(input, root)
  } catch (error) {
    created = { ok: false, reason: `the adversarial schedule could not be created: ${messageOf(error)}` }
  }
  const releaseError = await lock.lock.release()
  if (releaseError === null) return created
  return created.ok
    ? { ok: false, reason: `the adversarial schedule was published at \`${created.file}\`, but ${releaseError}` }
    : { ok: false, reason: `${created.reason}; ${releaseError}` }
}

async function publishAdversarialSchedule(input: CreateAdversarialScheduleInput, root: string): Promise<AdversarialScheduleCreated> {
  const directory = adversarialDirectory(root)
  const file = join(directory, ADVERSARIAL_SCHEDULE_FILE)
  const present = await presence(file)
  if (present !== "absent") {
    return {
      ok: false,
      reason: present === "present" ? `an adversarial schedule already exists at \`${file}\`; it is never re-tossed or replaced` : present,
    }
  }
  const cases = input.cases ?? ADVERSARIAL_CASES
  const sealProblem = adversarialSealProblem(cases, input.assertions ?? ADVERSARIAL_ASSERTIONS)
  if (sealProblem !== null) return { ok: false, reason: sealProblem }
  const roster = oneSlotProblem(input.roster)
  if (roster !== null) return { ok: false, reason: roster }
  const concurrency = concurrencyProblem(input.config)
  if (concurrency !== null) return { ok: false, reason: concurrency }
  if (input.config.tools.trim().length === 0) {
    return { ok: false, reason: "the config's Tools identity is blank, so the schedule would bind no identifiable Tools configuration" }
  }
  const protocol = await readFrozenProtocol(input.protocolFile)
  if (!protocol.ok) return { ok: false, reason: protocol.reason }

  const coins: CoinFace[] = []
  for (let pair = 0; pair < Math.ceil(cases.length / 2); pair += 1) {
    const face = (input.coin ?? cryptoCoin)()
    if (face !== "heads" && face !== "tails") {
      return { ok: false, reason: `the coin returned ${JSON.stringify(face)}, which is neither heads nor tails` }
    }
    coins.push(face)
  }
  const caseIds = cases.map((c) => c.id)
  const firstSides = firstSidesFor(coins, caseIds.length)
  const config = adversarialRunConfig(input.config, input.roster)
  const unsealed: Omit<AdversarialSchedule, "scheduleHash"> = {
    scheduleVersion: ADVERSARIAL_SCHEDULE_VERSION,
    createdAt: input.createdAt,
    coins,
    firstSides: caseIds.map((caseId, index) => ({ caseId, first: firstSides[index]! })),
    slots: adversarialSlots(caseIds, coins),
    protocol: { id: protocol.id, version: protocol.version, hash: protocol.hash },
    cases: { ...ADVERSARIAL_SEAL, caseIds },
    codeRevision: structuredClone(input.codeRevision),
    roster: structuredClone(input.roster),
    config,
    configDigest: sha256(canonicalJson(config)),
  }
  const schedule: AdversarialSchedule = { ...unsealed, scheduleHash: adversarialScheduleHashOf(unsealed) }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const published = await publishExclusive(
    directory,
    ADVERSARIAL_SCHEDULE_FILE,
    `${JSON.stringify(schedule, undefined, 2)}\n`,
    "an adversarial schedule",
  )
  if (!published.ok) return published
  return { ok: true, schedule, file }
}

// ---------------------------------------------------------------------------
// Read and verify
// ---------------------------------------------------------------------------

export type AdversarialScheduleRead = { ok: true; schedule: AdversarialSchedule; file: string } | { ok: false; reason: string }

/**
 * Read the published schedule and check what it says about itself: its version,
 * its own hash, the case ids and seal it carries, and that its order follows
 * from its coins. The reader's check; it needs no runner inputs. Never throws.
 */
export async function readAdversarialSchedule(experimentRoot: string): Promise<AdversarialScheduleRead> {
  const file = join(adversarialDirectory(experimentRoot), ADVERSARIAL_SCHEDULE_FILE)
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, "utf8"))
  } catch (error) {
    return { ok: false, reason: `no readable adversarial schedule at \`${file}\`: ${messageOf(error)}` }
  }
  const refuse = (why: string): AdversarialScheduleRead => ({ ok: false, reason: `the adversarial schedule at \`${file}\` ${why}` })
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return refuse("is not an object")
  const document = raw as Record<string, unknown>
  if (document.scheduleVersion !== ADVERSARIAL_SCHEDULE_VERSION) {
    return refuse(`has schedule version ${JSON.stringify(document.scheduleVersion)}, and this reader knows ${ADVERSARIAL_SCHEDULE_VERSION}`)
  }
  if (typeof document.createdAt !== "string") return refuse("carries no string `createdAt`")
  const protocol = document.protocol as Record<string, unknown> | null
  if (protocol === null || typeof protocol !== "object" || typeof protocol.id !== "string" || typeof protocol.version !== "number" || typeof protocol.hash !== "string") {
    return refuse("carries no readable `protocol` identity")
  }
  const cases = document.cases as Record<string, unknown> | null
  if (
    cases === null ||
    typeof cases !== "object" ||
    typeof cases.version !== "string" ||
    typeof cases.materialHash !== "string" ||
    typeof cases.assertionsHash !== "string" ||
    !Array.isArray(cases.caseIds) ||
    !cases.caseIds.every((id) => typeof id === "string" && id.length > 0) ||
    new Set(cases.caseIds).size !== cases.caseIds.length
  ) {
    return refuse("carries no readable case seal and distinct case ids")
  }
  if (typeof document.scheduleHash !== "string") return refuse("carries no string `scheduleHash`, so it was never sealed")
  if (adversarialScheduleHashOf(document as unknown as AdversarialSchedule) !== document.scheduleHash) {
    return refuse("does not match its own scheduleHash, so it was edited after it was sealed")
  }
  const coins = document.coins
  const caseIds = cases.caseIds as string[]
  if (
    !Array.isArray(coins) ||
    coins.length !== Math.ceil(caseIds.length / 2) ||
    !coins.every((coin) => coin === "heads" || coin === "tails")
  ) {
    return refuse("carries no coin per pair of cases")
  }
  const expectedFirst = firstSidesFor(coins as CoinFace[], caseIds.length).map((first, index) => ({ caseId: caseIds[index]!, first }))
  if (canonicalJson(document.firstSides) !== canonicalJson(expectedFirst)) {
    return refuse(`orders its sides ${JSON.stringify(document.firstSides)}, which its coins do not give`)
  }
  if (canonicalJson(document.slots) !== canonicalJson(adversarialSlots(caseIds, coins as CoinFace[]))) {
    return refuse("plans slots its coins do not give")
  }
  return { ok: true, schedule: document as unknown as AdversarialSchedule, file }
}

export interface AdversarialScheduleBinding {
  protocolFile: string
  codeRevision: Maybe<CodeRevision>
  roster: Roster
  config: AdversarialConfig
  /** The seal and case ids the runner's cases verified against. */
  seal: AdversarialSeal
  caseIds: readonly string[]
}

/**
 * Read the schedule and check it against the runner's own inputs: its
 * self-consistency, the protocol, the case seal and ids, code revision, roster
 * and config it was sealed with.
 */
export async function verifyAdversarialSchedule(
  experimentRoot: string,
  binding: AdversarialScheduleBinding,
): Promise<AdversarialScheduleRead> {
  const read = await readAdversarialSchedule(experimentRoot)
  if (!read.ok) return read
  const { schedule, file } = read
  const refuse = (why: string): AdversarialScheduleRead => ({ ok: false, reason: `the adversarial schedule at \`${file}\` ${why}` })
  const protocol = await readFrozenProtocol(binding.protocolFile)
  if (!protocol.ok) return { ok: false, reason: protocol.reason }
  if (canonicalJson(schedule.protocol) !== canonicalJson({ id: protocol.id, version: protocol.version, hash: protocol.hash })) {
    return refuse(`is bound to protocol ${canonicalJson(schedule.protocol)}, not to the frozen protocol this runner read`)
  }
  if (canonicalJson(schedule.cases) !== canonicalJson({ ...binding.seal, caseIds: [...binding.caseIds] })) {
    return refuse(`is bound to case seal ${schedule.cases.materialHash} / ${schedule.cases.assertionsHash}, not to the seal this runner verified`)
  }
  if (canonicalJson(schedule.codeRevision) !== canonicalJson(binding.codeRevision)) return refuse("is bound to a different code revision")
  if (canonicalJson(schedule.roster) !== canonicalJson(binding.roster)) return refuse("is bound to a different roster or models")
  const config = adversarialRunConfig(binding.config, binding.roster)
  if (schedule.configDigest !== sha256(canonicalJson(config)) || canonicalJson(schedule.config) !== canonicalJson(config)) {
    return refuse("is bound to a different configuration")
  }
  return read
}

/**
 * Whether an adversarial schedule sits under this root. `ENOENT` and `ENOTDIR`
 * are `false` (nothing there, or the root is a file). Any other failure is
 * `true`: a schedule that exists and could not be read is handed to the reader,
 * which refuses it by name. Never throws.
 */
export async function hasAdversarialSchedule(experimentRoot: string): Promise<boolean> {
  try {
    await readFile(join(adversarialDirectory(experimentRoot), ADVERSARIAL_SCHEDULE_FILE))
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code !== "ENOENT" && code !== "ENOTDIR"
  }
}

// ---------------------------------------------------------------------------
// Start marker and slot status
// ---------------------------------------------------------------------------

export function writeAdversarialStartMarker(experimentRoot: string, scheduleHash: string, startedAt: string): Promise<Started> {
  return writeStartMarker(adversarialDirectory(experimentRoot), scheduleHash, startedAt, ADVERSARIAL_START_MARKER_FILE)
}

/** How far a run got, from its record: the last stage that ran. */
export type ReachedStage = "none" | "discover" | "route" | "debate" | "judge"

/**
 * What an attack run's record and model requests show about the payload.
 *
 * Sealed material existing is not delivery, and delivery is not attention:
 * `carried` says whether a recorded model request held the payload bytes, and
 * nothing here says whether a model acted on them.
 */
export interface DeliveryEvidence {
  surface: AdversarialSurface
  carrier: PayloadCarrier
  furthestStage: ReachedStage
  /** Model requests the run issued, as recorded at issue. */
  requests: number
  /** Of those, how many held the payload bytes. */
  carrying: number
  /** Requests whose `runTurn` threw, so whether they went out is not known. Never counted in `requests`. */
  uncertain: number
  /** `unshown` when the requests could not be recorded; `reason` says why. */
  carried: "yes" | "no" | "unshown"
  reason: string
}

export interface AdversarialSlotStatusLine extends AdversarialSlot {
  status: SlotStatus
  reason: string
  at: string
  runId?: string
  /** On an attack run's terminal line. */
  delivery?: DeliveryEvidence
}

export function appendAdversarialSlotStatus(experimentRoot: string, line: AdversarialSlotStatusLine): Promise<string | null> {
  return appendStatusLine(join(adversarialDirectory(experimentRoot), ADVERSARIAL_SLOT_STATUS_FILE), line)
}

/** Every slot status line, in order. An absent file is no lines. A line that does not parse throws. */
export function readAdversarialSlotStatuses(experimentRoot: string): Promise<AdversarialSlotStatusLine[]> {
  return readStatusLines<AdversarialSlotStatusLine>(join(adversarialDirectory(experimentRoot), ADVERSARIAL_SLOT_STATUS_FILE))
}

/** A status row that did not parse: counted, never dropped, attributed where its start survived. */
export interface TornStatusRow {
  /** 1-based row in the file. */
  row: number
  /** The slot position read off the row's start, or `null`. */
  position: number | null
  why: string
}

export type SlotStatusRows =
  | { kind: "read"; lines: AdversarialSlotStatusLine[]; torn: TornStatusRow[] }
  | { kind: "unreadable"; reason: string }

const POSITION_PREFIX = /^\{"position":(\d+)/

/**
 * The reader's view of the slot-status file: every row that parses is kept, and
 * a torn or non-JSON row is returned as torn with the position its start still
 * names. An absent file is no rows. Never throws.
 */
export async function readAdversarialSlotStatusRows(experimentRoot: string): Promise<SlotStatusRows> {
  const file = join(adversarialDirectory(experimentRoot), ADVERSARIAL_SLOT_STATUS_FILE)
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "read", lines: [], torn: [] }
    return { kind: "unreadable", reason: `the adversarial slot statuses \`${file}\` could not be read: ${messageOf(error)}` }
  }
  const lines: AdversarialSlotStatusLine[] = []
  const torn: TornStatusRow[] = []
  const rows = text.split("\n")
  const last = rows.pop()!
  const take = (row: string, index: number, tail: boolean): void => {
    const position = POSITION_PREFIX.exec(row)?.[1]
    const attributed = position === undefined ? null : Number(position)
    let parsed: unknown
    try {
      parsed = JSON.parse(row)
    } catch {
      torn.push({ row: index + 1, position: attributed, why: tail ? "the last row is incomplete" : "a row is not JSON" })
      return
    }
    const line = parsed as Record<string, unknown> | null
    if (line === null || typeof line !== "object" || typeof line.position !== "number" || typeof line.status !== "string") {
      torn.push({ row: index + 1, position: attributed, why: "a row is not a slot status" })
      return
    }
    if (tail) torn.push({ row: index + 1, position: line.position, why: "the last row has no newline" })
    lines.push(line as unknown as AdversarialSlotStatusLine)
  }
  rows.forEach((row, index) => {
    if (row.length > 0) take(row, index, false)
  })
  if (last.length > 0) take(last, rows.length, true)
  return { kind: "read", lines, torn }
}

/** `present`, `absent`, or the reason neither could be established. */
async function presence(file: string): Promise<string> {
  try {
    await readFile(file)
    return "present"
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"
    return `whether \`${file}\` exists could not be established (${messageOf(error)}), so nothing was tossed`
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
