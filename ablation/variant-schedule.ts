/**
 * The sealed schedule of a debate-variants evaluation (`ablation/DEBATE-VARIANTS.md`):
 * three blocks, each forked into a baseline, a references and an
 * open-questions continuation, run in an order that puts every arm once in
 * each position.
 *
 * ## The order
 *
 * One draw from the platform's cryptographic generator picks one of the twelve
 * 3×3 Latin squares before any block executes. A draw `d` in 0..11 names a
 * permutation of the arms, `VARIANT_PERMUTATIONS[⌊d / 2⌋]`, as block 1's order,
 * and a direction, `d mod 2`: 0 rotates that order one place left for block 2
 * and two for block 3, 1 rotates it two places left for block 2 and one for
 * block 3. Each arm is then once in each block and once in each position. The
 * schedule records the draw, the per-block order and the nine slots, and every
 * reader recomputes the order and the slots from the draw.
 *
 * ## The document
 *
 * It is published as `paired-schedule.json`, the routing schedule's file, so a
 * bundle root holds one schedule of either design and neither creator replaces
 * the other's. It carries `scheduleVersion` 2 and `design: "debate-variants"`.
 * The routing reader and verifier know only version 1 and refuse it before
 * anything is started or admitted.
 *
 * It binds what the routing schedule binds: the frozen protocol, which must be
 * the debate-variants protocol (`VARIANT_PROTOCOL_ID`), the fixture seal, the
 * code revision, the roster and every non-intervention setting. The config
 * additionally seals the design, each arm's options (`VARIANT_ARM_OPTIONS`) and
 * the design's token allowances (`VARIANT_ALLOWANCES`).
 *
 * The design runs in tokens on the api-key route only. Attempt accounting is
 * refused until a frozen debate-variants protocol defines it;
 * `VARIANT_ATTEMPT_ALLOWANCES` and `variantRequestGate` already compute its
 * thresholds.
 *
 * Nothing executes a debate-variants schedule yet.
 *
 * AD-1: this tree may import from `core/` and `fixtures/`. Nothing under `core/`
 * imports it.
 */

import { getRandomValues } from "node:crypto"
import { lstat } from "node:fs/promises"
import { join, resolve } from "node:path"

import type { Roster } from "../core/domain/roster.ts"
import type { ChangeSet } from "../core/ports/repo.ts"
import type { LabelledChangeSeal } from "../fixtures/seeded-defects/seal.ts"
import { VARIANT_ALLOWANCES } from "./governor.ts"
import { acquireLock } from "./journal.ts"
import type { CodeRevision, Maybe } from "./manifest.ts"
import {
  accountingConfigProblem,
  canonicalJson,
  configDigestOf,
  PAIRED_BLOCKS,
  pairedRunConfig,
  publishExclusive,
  readFrozenProtocol,
  readScheduleDocument,
  SCHEDULE_FILE,
  sha256,
  type PairedConfig,
} from "./schedule.ts"
import { VARIANT_ARM_OPTIONS, VARIANT_ARMS, VARIANT_PROTOCOL_ID, variantArmOptions, type VariantArm } from "./variants.ts"

/** The debate-variants schedule document's version. The routing schedule's is 1. */
export const VARIANT_SCHEDULE_VERSION = 2
export const VARIANT_DESIGN = "debate-variants"

export type VariantPosition = "first" | "second" | "third"
const POSITIONS: readonly VariantPosition[] = ["first", "second", "third"]

/** One of the nine planned arm slots. */
export interface VariantSlot {
  block: number
  arm: VariantArm
  position: VariantPosition
}

export interface VariantSchedule {
  scheduleVersion: typeof VARIANT_SCHEDULE_VERSION
  design: typeof VARIANT_DESIGN
  createdAt: string
  /** The draw, 0..11, that fixes the order. */
  draw: number
  /** Each block's arms, first to third. */
  order: VariantArm[][]
  slots: VariantSlot[]
  protocol: { id: string; version: number; hash: string }
  fixture: LabelledChangeSeal
  codeRevision: Maybe<CodeRevision>
  roster: Roster
  /** Every non-intervention setting, the design and each arm's options, as the runs will receive them. */
  config: Record<string, unknown>
  configDigest: string
  /** `sha256:` over the canonical JSON of every other field. */
  scheduleHash: string
}

// ---------------------------------------------------------------------------
// The order
// ---------------------------------------------------------------------------

/** The six orders of the arms, lexicographic by their index in `VARIANT_ARMS`. */
export const VARIANT_PERMUTATIONS: readonly (readonly VariantArm[])[] = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
].map((indices) => indices.map((index) => VARIANT_ARMS[index]!))

/** The number of distinct draws: six first-block orders × two directions. */
export const VARIANT_DRAWS = 12

/** One byte from the platform's cryptographic generator. */
function cryptoByte(): number {
  const byte = new Uint8Array(1)
  getRandomValues(byte)
  return byte[0]!
}

/**
 * A uniform draw in 0..11 by rejection: bytes from 252, the largest multiple
 * of 12 not above 256, are discarded. `nextByte` is injected for tests and
 * defaults to the cryptographic generator.
 */
export function cryptoVariantDraw(nextByte: () => number = cryptoByte): number {
  for (;;) {
    const byte = nextByte()
    if (byte < 252) return byte % VARIANT_DRAWS
  }
}

function isDraw(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < VARIANT_DRAWS
}

function rotateLeft<T>(items: readonly T[], places: number): T[] {
  return items.map((_, index) => items[(index + places) % items.length]!)
}

/** Each block's arms, first to third, for a draw. */
export function variantOrderFor(draw: number): VariantArm[][] {
  if (!isDraw(draw)) throw new Error(`a debate-variants draw is an integer from 0 to ${VARIANT_DRAWS - 1}, not ${JSON.stringify(draw)}`)
  const first = VARIANT_PERMUTATIONS[Math.floor(draw / 2)]!
  const shifts = draw % 2 === 0 ? [0, 1, 2] : [0, 2, 1]
  return PAIRED_BLOCKS.map((_, index) => rotateLeft(first, shifts[index]!))
}

export function plannedVariantSlots(order: readonly (readonly VariantArm[])[]): VariantSlot[] {
  return PAIRED_BLOCKS.flatMap((block, index) => order[index]!.map((arm, at) => ({ block, arm, position: POSITIONS[at]! })))
}

// ---------------------------------------------------------------------------
// The config and the hash
// ---------------------------------------------------------------------------

/**
 * The settings every debate-variants run receives: the routing design's
 * non-intervention settings, with the design, each arm's options and this
 * design's allowances in place of the routing ones. Only a config
 * `variantConfigProblem` accepts is sealed.
 */
export function variantRunConfig(config: PairedConfig, change: ChangeSet, roster: Roster): Record<string, unknown> {
  return {
    ...pairedRunConfig(config, change, roster),
    design: VARIANT_DESIGN,
    arms: variantArmOptions(),
    allowances: { ...VARIANT_ALLOWANCES },
  }
}

/**
 * Why this config cannot seal a debate-variants schedule, or `null`: the
 * routing design's checks, and attempt accounting or the oauth route, which
 * no frozen debate-variants protocol defines yet.
 */
export function variantConfigProblem(config: PairedConfig): string | null {
  const routing = accountingConfigProblem(config)
  if (routing !== null) return routing
  if (config.accounting === "attempts" || config.route === "oauth") {
    return "the debate-variants design runs in tokens on the api-key route; attempt accounting is not defined for it yet"
  }
  return null
}

export function variantScheduleHashOf(schedule: Omit<VariantSchedule, "scheduleHash"> & { scheduleHash?: string }): string {
  const { scheduleHash: _excluded, ...sealed } = schedule
  return sha256(canonicalJson(sealed))
}

/** Why a protocol may not be bound by a debate-variants schedule, or `null`. */
export function variantProtocolProblem(protocol: { id: string; version: number }): string | null {
  if (protocol.id === VARIANT_PROTOCOL_ID) return null
  return (
    `a debate-variants schedule binds the frozen protocol ${VARIANT_PROTOCOL_ID}, and the protocol handed in is ` +
    `${protocol.id} version ${protocol.version}`
  )
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateVariantScheduleInput {
  bundleRoot: string
  protocolFile: string
  fixture: LabelledChangeSeal
  codeRevision: Maybe<CodeRevision>
  roster: Roster
  change: ChangeSet
  config: PairedConfig
  createdAt: string
  /** Injected for tests. Defaults to `cryptoVariantDraw`; never a non-cryptographic generator. */
  draw?: () => number
  /**
   * The frozen protocol the caller verified. When given, the protocol read here
   * must be exactly it, or nothing is drawn or published.
   */
  expectedProtocol?: { id: string; version: number; hash: string }
}

export type VariantScheduleCreated = { ok: true; schedule: VariantSchedule; file: string } | { ok: false; reason: string }

/**
 * Draw the order and publish the sealed schedule. Refuses, and draws nothing,
 * when a schedule of either design already exists, the config cannot run, or
 * the protocol is not the frozen debate-variants protocol. Bills nothing.
 */
export async function createVariantSchedule(given: CreateVariantScheduleInput): Promise<VariantScheduleCreated> {
  // The caller's expectation is copied before the first await, so what it
  // supplied is what is enforced.
  const input: CreateVariantScheduleInput =
    given.expectedProtocol === undefined ? given : { ...given, expectedProtocol: Object.freeze({ ...given.expectedProtocol }) }
  const root = resolve(input.bundleRoot)
  const lock = await acquireLock(root, input.createdAt)
  if (!lock.ok) return { ok: false, reason: lock.reason }
  let created: VariantScheduleCreated
  try {
    created = await publishVariantSchedule(input, root)
  } catch (error) {
    created = { ok: false, reason: `the schedule could not be created: ${messageOf(error)}` }
  }
  const releaseError = await lock.lock.release()
  if (releaseError === null) return created
  return created.ok
    ? { ok: false, reason: `the schedule was published at \`${created.file}\`, but ${releaseError}` }
    : { ok: false, reason: `${created.reason}; ${releaseError}` }
}

async function publishVariantSchedule(input: CreateVariantScheduleInput, root: string): Promise<VariantScheduleCreated> {
  const file = join(root, SCHEDULE_FILE)
  const present = await presence(file)
  if (present !== "absent") {
    return {
      ok: false,
      reason: present === "present" ? `a schedule already exists at \`${file}\`; a schedule is never redrawn or replaced` : present,
    }
  }
  const configProblem = variantConfigProblem(input.config)
  if (configProblem !== null) return { ok: false, reason: `${configProblem}; nothing was drawn` }
  const protocol = await readFrozenProtocol(input.protocolFile)
  if (!protocol.ok) return { ok: false, reason: protocol.reason }
  const protocolProblem = variantProtocolProblem(protocol)
  if (protocolProblem !== null) return { ok: false, reason: `${protocolProblem}; nothing was drawn` }
  const expected = input.expectedProtocol
  if (expected !== undefined && (protocol.id !== expected.id || protocol.version !== expected.version || protocol.hash !== expected.hash)) {
    return {
      ok: false,
      reason:
        `the protocol read is ${protocol.id} v${protocol.version} ${protocol.hash}, not the expected ${expected.id} ` +
        `v${expected.version} ${expected.hash}; nothing was drawn`,
    }
  }

  const draw = (input.draw ?? cryptoVariantDraw)()
  if (!isDraw(draw)) {
    return { ok: false, reason: `the draw returned ${JSON.stringify(draw)}, which is not an integer from 0 to ${VARIANT_DRAWS - 1}` }
  }
  const order = variantOrderFor(draw)
  const config = variantRunConfig(input.config, input.change, input.roster)
  const unsealed: Omit<VariantSchedule, "scheduleHash"> = {
    scheduleVersion: VARIANT_SCHEDULE_VERSION,
    design: VARIANT_DESIGN,
    createdAt: input.createdAt,
    draw,
    order,
    slots: plannedVariantSlots(order),
    protocol: { id: protocol.id, version: protocol.version, hash: protocol.hash },
    fixture: { ...input.fixture },
    codeRevision: structuredClone(input.codeRevision),
    roster: structuredClone(input.roster),
    config,
    configDigest: configDigestOf(config),
  }
  const schedule: VariantSchedule = { ...unsealed, scheduleHash: variantScheduleHashOf(unsealed) }
  const published = await publishExclusive(root, SCHEDULE_FILE, `${JSON.stringify(schedule, undefined, 2)}\n`, "a schedule")
  if (!published.ok) return published
  return { ok: true, schedule, file }
}

// ---------------------------------------------------------------------------
// Read and verify
// ---------------------------------------------------------------------------

export type VariantScheduleRead = { ok: true; schedule: VariantSchedule; file: string } | { ok: false; reason: string }

/**
 * Read the published schedule and check only what the document says about
 * itself, in this order: its version and design, the fields a report reads
 * (`createdAt`, the protocol identity), its own hash (absent and mismatched
 * are separate refusals), that the protocol is the debate-variants protocol,
 * that `draw → order → slots` follows from the draw, that the design, arm
 * options and allowances its config seals are this design's, with no attempt
 * accounting or route, and that `configDigest` is its config's digest. A document rehashed
 * after an edit to any of those is still refused. Never throws.
 */
export async function readVariantSchedule(bundleRoot: string): Promise<VariantScheduleRead> {
  const document = await readScheduleDocument(bundleRoot)
  return document.kind === "read" ? validateVariantSchedule(document.raw, document.file) : { ok: false, reason: document.reason }
}

/** `readVariantSchedule`'s checks, on a document already parsed from `file`. */
export function validateVariantSchedule(raw: unknown, file: string): VariantScheduleRead {
  const problem = selfProblem(raw)
  if (problem !== null) return { ok: false, reason: `the schedule at \`${file}\` ${problem}` }
  return { ok: true, schedule: raw as VariantSchedule, file }
}

/**
 * Which design a parsed schedule document CLAIMS to be: a debate-variants one
 * when it says schedule version 2 or design `debate-variants`, whatever else
 * it gets wrong, so its refusal comes from this design's validator; anything
 * else is left to the routing validator. A claim is not a validation.
 */
export function claimedDesign(raw: unknown): "debate-variants" | "routing" {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "routing"
  const document = raw as Record<string, unknown>
  return document.scheduleVersion === VARIANT_SCHEDULE_VERSION || document.design === VARIANT_DESIGN ? "debate-variants" : "routing"
}

/** What the document's own fields contradict, or `null`. */
function selfProblem(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "is not an object"
  const document = raw as Record<string, unknown>
  if (document.scheduleVersion !== VARIANT_SCHEDULE_VERSION) {
    return `has schedule version ${JSON.stringify(document.scheduleVersion)}, and this reader knows ${VARIANT_SCHEDULE_VERSION}`
  }
  if (document.design !== VARIANT_DESIGN) return `has design ${JSON.stringify(document.design)}, not ${VARIANT_DESIGN}`
  if (typeof document.createdAt !== "string") return "carries no string `createdAt`"
  const protocol = document.protocol as Record<string, unknown> | null | undefined
  if (
    protocol === null ||
    typeof protocol !== "object" ||
    typeof protocol.id !== "string" ||
    typeof protocol.version !== "number" ||
    typeof protocol.hash !== "string"
  ) {
    return "carries no readable `protocol` identity"
  }
  if (typeof document.scheduleHash !== "string") return "carries no string `scheduleHash`, so it was never sealed"
  if (variantScheduleHashOf(document as unknown as VariantSchedule) !== document.scheduleHash) {
    return "does not match its own scheduleHash, so it was edited after it was sealed"
  }
  const protocolProblem = variantProtocolProblem({ id: protocol.id, version: protocol.version })
  if (protocolProblem !== null) return `is bound to the wrong protocol: ${protocolProblem}`
  if (!isDraw(document.draw)) return `carries no draw from 0 to ${VARIANT_DRAWS - 1} (it says ${JSON.stringify(document.draw)})`
  const order = variantOrderFor(document.draw)
  if (canonicalJson(document.order) !== canonicalJson(order)) {
    return `orders its arms ${JSON.stringify(document.order)}, which the draw ${document.draw} does not give (it gives ${JSON.stringify(order)})`
  }
  if (canonicalJson(document.slots) !== canonicalJson(plannedVariantSlots(order))) {
    return `plans slots its draw ${document.draw} does not give`
  }
  const config = document.config as Record<string, unknown> | null | undefined
  if (config === null || typeof config !== "object" || Array.isArray(config)) return "carries no config object"
  if (config.design !== VARIANT_DESIGN) return `seals the design ${JSON.stringify(config.design)} in its config, not ${VARIANT_DESIGN}`
  if (canonicalJson(config.arms) !== canonicalJson(VARIANT_ARM_OPTIONS)) {
    return `seals arm options ${canonicalJson(config.arms)}, not this design's ${canonicalJson(VARIANT_ARM_OPTIONS)}`
  }
  if (canonicalJson(config.allowances) !== canonicalJson(VARIANT_ALLOWANCES)) {
    return `seals allowances ${canonicalJson(config.allowances)}, not this design's ${canonicalJson(VARIANT_ALLOWANCES)}`
  }
  if (config.accounting !== undefined || config.attemptAllowances !== undefined || config.route !== undefined) {
    return "seals attempt accounting or a route, which this design does not run with"
  }
  if (document.configDigest !== configDigestOf(config)) {
    return "carries a configDigest that is not its config's digest"
  }
  return null
}

export interface VariantScheduleBinding {
  protocolFile: string
  fixture: LabelledChangeSeal
  codeRevision: Maybe<CodeRevision>
  roster: Roster
  change: ChangeSet
  config: PairedConfig
}

export type VariantScheduleVerified = { ok: true; schedule: VariantSchedule } | { ok: false; reason: string }

/**
 * Everything `readVariantSchedule` checks, then the schedule against the
 * caller's own inputs: the frozen protocol it reads, the fixture seal, the
 * code revision, the roster, and the config this design builds from the change
 * and settings, allowances and arm options included.
 */
export async function verifyVariantSchedule(bundleRoot: string, binding: VariantScheduleBinding): Promise<VariantScheduleVerified> {
  const read = await readVariantSchedule(bundleRoot)
  if (!read.ok) return read
  const { schedule, file } = read
  const refuse = (why: string): VariantScheduleVerified => ({ ok: false, reason: `the schedule at \`${file}\` ${why}` })
  const configProblem = variantConfigProblem(binding.config)
  if (configProblem !== null) return { ok: false, reason: configProblem }
  const protocol = await readFrozenProtocol(binding.protocolFile)
  if (!protocol.ok) return { ok: false, reason: protocol.reason }
  const protocolProblem = variantProtocolProblem(protocol)
  if (protocolProblem !== null) return { ok: false, reason: protocolProblem }
  if (canonicalJson(schedule.protocol) !== canonicalJson({ id: protocol.id, version: protocol.version, hash: protocol.hash })) {
    return refuse(`is bound to protocol ${canonicalJson(schedule.protocol)}, not to the frozen protocol this runner read`)
  }
  if (canonicalJson(schedule.fixture) !== canonicalJson(binding.fixture)) return refuse("is bound to a different fixture seal")
  if (canonicalJson(schedule.codeRevision) !== canonicalJson(binding.codeRevision)) return refuse("is bound to a different code revision")
  if (canonicalJson(schedule.roster) !== canonicalJson(binding.roster)) return refuse("is bound to a different roster or models")
  const config = variantRunConfig(binding.config, binding.change, binding.roster)
  if (schedule.configDigest !== configDigestOf(config) || canonicalJson(schedule.config) !== canonicalJson(config)) {
    return refuse("is bound to a different change or configuration")
  }
  return { ok: true, schedule }
}

/**
 * `present`, `absent`, or the reason neither could be established. Only the
 * entry is looked at, never followed or opened: any existing entry, a dangling
 * symlink or a FIFO included, is present; only ENOENT is absent.
 */
async function presence(file: string): Promise<string> {
  try {
    await lstat(file)
    return "present"
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"
    return `whether \`${file}\` exists could not be established (${messageOf(error)}), so nothing was drawn`
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
