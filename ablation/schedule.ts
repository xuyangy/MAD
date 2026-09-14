/**
 * Story 2-5c — the sealed ON/OFF schedule, the start marker and the six slot
 * statuses of one paired evaluation (`evaluation-protocol.md` §4, *Schedule rule*).
 *
 * One fair coin is tossed before any block executes. Heads fixes the first arm of
 * blocks 1-3 as ON, OFF, ON; tails as OFF, ON, OFF. `createSchedule` tosses it
 * and publishes the result, bound to everything the runner will later check
 * against its own inputs: the frozen protocol's hash, the fixture seal, the code
 * revision, the resolved roster and a digest of every non-intervention setting.
 * Creating and executing are separate calls, so the realized order exists on disk
 * before any request is admitted.
 *
 * ## Files, all at the bundle root and none overwritten
 *
 *   paired-schedule.json   the sealed schedule; published by hard link, so an
 *                          existing schedule refuses and a partial file never
 *                          appears under the final name
 *   paired-start.json      written once, before the first billable action; its
 *                          presence refuses every later invocation
 *   paired-slots.jsonl     append-only started/terminal status per arm slot
 *
 * A schedule is never re-tossed or replaced, and a started schedule is never
 * executed by a later invocation. Nothing here deletes any of these files.
 *
 * AD-1: this tree may import from `core/` and `fixtures/`. Nothing under `core/`
 * imports it.
 */

import { createHash, getRandomValues } from "node:crypto"
import { link, open, readFile, unlink } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { CUMULATIVE_SHARE, type Preset } from "../core/budget/presets.ts"
import type { Roster } from "../core/domain/roster.ts"
import type { ChangeSet } from "../core/ports/repo.ts"
import type { LabelledChangeSeal } from "../fixtures/seeded-defects/seal.ts"
import type { Provenance } from "./arms.ts"
import { PAIRED_ALLOWANCES } from "./governor.ts"
import { resolveInstructions } from "../core/instructions/registry.ts"
import { acquireLock, syncDirectory } from "./journal.ts"
import { changeIdFor, type CodeRevision, type Maybe } from "./manifest.ts"

export const SCHEDULE_FILE = "paired-schedule.json"
export const START_MARKER_FILE = "paired-start.json"
export const SLOT_STATUS_FILE = "paired-slots.jsonl"

/** Bumped by hand when the schedule document's shape changes. */
export const SCHEDULE_VERSION = 1

export type CoinFace = "heads" | "tails"
export type Arm = "on" | "off"
export type ArmPosition = "first" | "second"

/** The three blocks the protocol fixes in advance. */
export const PAIRED_BLOCKS = [1, 2, 3] as const

/** One of the six planned arm slots. */
export interface PlannedSlot {
  block: number
  arm: Arm
  position: ArmPosition
}

/**
 * The settings that must be identical across both arms and all blocks — every
 * setting except the routing policy, which is the intervention. The ordinary
 * attributed cap and the stage shares are fixed here and cannot be varied.
 */
export interface PairedConfig {
  /** Whether the backend is scripted or live. Recorded on every manifest. */
  provenance: Provenance
  threshold?: number
  maxRounds?: number
  maxConcurrency?: number
  preset?: Preset
  /**
   * The identity of the `Tools` port configuration every continuation receives
   * (for example the adapter and worktree it drives), or absent when the runs
   * get no `Tools` port. `runPairedBlocks` refuses a `tools` port with no
   * identity here, and an identity with no port.
   */
  tools?: string
}

export interface PairedSchedule {
  scheduleVersion: number
  createdAt: string
  coin: CoinFace
  /** The first arm of blocks 1, 2 and 3. */
  firstArms: Arm[]
  slots: PlannedSlot[]
  protocol: { id: string; version: number; hash: string }
  fixture: LabelledChangeSeal
  codeRevision: Maybe<CodeRevision>
  roster: Roster
  /** Every non-intervention setting, as the runs will receive it. */
  config: Record<string, unknown>
  configDigest: string
  /** `sha256:` over the canonical JSON of every other field. */
  scheduleHash: string
}

/** The fair coin: one bit from the platform's cryptographic generator. */
export function cryptoCoin(): CoinFace {
  const byte = new Uint8Array(1)
  getRandomValues(byte)
  return (byte[0]! & 1) === 1 ? "heads" : "tails"
}

/** Heads → ON, OFF, ON. Tails → OFF, ON, OFF. */
export function firstArmsFor(coin: CoinFace): Arm[] {
  return coin === "heads" ? ["on", "off", "on"] : ["off", "on", "off"]
}

export function plannedSlots(firstArms: readonly Arm[]): PlannedSlot[] {
  return PAIRED_BLOCKS.flatMap((block, index) => {
    const first = firstArms[index]!
    const second: Arm = first === "on" ? "off" : "on"
    return [
      { block, arm: first, position: "first" as const },
      { block, arm: second, position: "second" as const },
    ]
  })
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** JSON with object keys sorted at every depth; `undefined` members omitted. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(object)
        .filter((key) => object[key] !== undefined)
        .sort()
        .map((key) => [key, sortKeys(object[key])]),
    )
  }
  return value
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`
}

/** The schedule's hash: canonical JSON with `scheduleHash` excluded. */
export function scheduleHashOf(schedule: Omit<PairedSchedule, "scheduleHash"> & { scheduleHash?: string }): string {
  const { scheduleHash: _excluded, ...sealed } = schedule
  return sha256(canonicalJson(sealed))
}

/**
 * The non-intervention settings every paired run receives, and their digest.
 *
 * The change is bound by its diff hash. `tokenCap`, the shares and the stop dial
 * are fixed rather than read from `config`, so no arm can be given its own.
 */
export function pairedRunConfig(config: PairedConfig, change: ChangeSet, roster: Roster): Record<string, unknown> {
  return {
    provenance: config.provenance,
    changeDiffHash: changeIdFor(change).diffHash,
    tokenCap: PAIRED_ALLOWANCES.runCap,
    spendShares: { ...CUMULATIVE_SHARE },
    stopOnUnknownUsage: true,
    threshold: config.threshold,
    maxRounds: config.maxRounds,
    maxConcurrency: config.maxConcurrency,
    preset: config.preset,
    allowances: { ...PAIRED_ALLOWANCES },
    instructionsDigest: instructionsDigestOf(roster),
    tools: config.tools ?? "no tools port",
  }
}

/** The pipeline roles whose registry instructions every paired run uses. */
const INSTRUCTION_ROLES = ["discovery", "debate", "evidence-extract", "fact-check", "logic-eval", "aggregate"] as const

/**
 * `sha256:` over the registry's instruction sets the runs will use: every
 * pipeline role's generalist, and the discovery set of each lens slot on the
 * roster. Role, lens, version, origin and the full text are hashed, so an edit
 * to any instruction text changes the digest.
 */
export function instructionsDigestOf(roster: Roster): string {
  const sets = [
    ...INSTRUCTION_ROLES.map((role) => resolveInstructions({ taskType: "coding", role })),
    ...roster.lensSlots.map((slot) => resolveInstructions({ taskType: "coding", role: "discovery", lens: slot.lens })),
  ]
  return sha256(canonicalJson(sets.map((set) => [set.role, set.lens ?? null, set.version, set.origin, set.text])))
}

export function configDigestOf(config: Record<string, unknown>): string {
  return sha256(canonicalJson(config))
}

// ---------------------------------------------------------------------------
// The protocol
// ---------------------------------------------------------------------------

export type ProtocolRead =
  | { ok: true; id: string; version: number; hash: string }
  | { ok: false; reason: string }

/**
 * The frozen protocol's identity, computed from the file by its own rule
 * (`evaluation-protocol.md:39-45`): the `frozen_hash:` line is replaced by
 * `frozen_hash: PENDING` and the bytes are hashed. The result must equal the
 * `frozen_hash` the file records, and the file must say `status: frozen`.
 */
export async function readFrozenProtocol(file: string): Promise<ProtocolRead> {
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (error) {
    return { ok: false, reason: `the protocol \`${file}\` could not be read: ${messageOf(error)}` }
  }
  const field = (name: string): string | undefined =>
    new RegExp(`^${name}: (.*)$`, "m").exec(text)?.[1]?.trim()
  const recorded = field("frozen_hash")
  const status = field("status")
  const id = field("id")
  const version = Number(field("version"))
  if (status !== "frozen" || recorded === undefined || id === undefined || !Number.isInteger(version)) {
    return { ok: false, reason: `the protocol \`${file}\` is not a frozen protocol with an id, version and frozen_hash` }
  }
  const computed = sha256(text.replace(/^frozen_hash: .*$/gm, "frozen_hash: PENDING"))
  if (computed !== recorded) {
    return {
      ok: false,
      reason: `the protocol \`${file}\` hashes to ${computed}, but records frozen_hash ${recorded}; the frozen artefact was edited`,
    }
  }
  return { ok: true, id, version, hash: computed }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateScheduleInput {
  bundleRoot: string
  protocolFile: string
  fixture: LabelledChangeSeal
  codeRevision: Maybe<CodeRevision>
  roster: Roster
  change: ChangeSet
  config: PairedConfig
  createdAt: string
  /** Injected for tests. Defaults to `cryptoCoin`; never a non-cryptographic generator. */
  coin?: () => CoinFace
}

export type ScheduleCreated = { ok: true; schedule: PairedSchedule; file: string } | { ok: false; reason: string }

/**
 * Toss the coin and publish the sealed schedule. Refuses, and tosses nothing,
 * when a schedule already exists or the protocol does not verify. Bills nothing.
 */
export async function createSchedule(input: CreateScheduleInput): Promise<ScheduleCreated> {
  const root = resolve(input.bundleRoot)
  const lock = await acquireLock(root, input.createdAt)
  if (!lock.ok) return { ok: false, reason: lock.reason }
  let created: ScheduleCreated
  try {
    created = await publishSchedule(input, root)
  } catch (error) {
    created = { ok: false, reason: `the schedule could not be created: ${messageOf(error)}` }
  }
  // A lock left behind refuses every later writer, so its failure is reported
  // even when the schedule itself was published.
  const releaseError = await lock.lock.release()
  if (releaseError === null) return created
  return created.ok
    ? { ok: false, reason: `the schedule was published at \`${created.file}\`, but ${releaseError}` }
    : { ok: false, reason: `${created.reason}; ${releaseError}` }
}

/** Toss and publish, under the lock `createSchedule` holds. */
async function publishSchedule(input: CreateScheduleInput, root: string): Promise<ScheduleCreated> {
  const file = join(root, SCHEDULE_FILE)
  {
    const present = await presence(file)
    if (present !== "absent") {
      return {
        ok: false,
        reason:
          present === "present"
            ? `a schedule already exists at \`${file}\`; a schedule is never re-tossed or replaced`
            : present,
      }
    }
    const protocol = await readFrozenProtocol(input.protocolFile)
    if (!protocol.ok) return { ok: false, reason: protocol.reason }

    const face = (input.coin ?? cryptoCoin)()
    if (face !== "heads" && face !== "tails") {
      return { ok: false, reason: `the coin returned ${JSON.stringify(face)}, which is neither heads nor tails` }
    }
    const firstArms = firstArmsFor(face)
    const config = pairedRunConfig(input.config, input.change, input.roster)
    const unsealed: Omit<PairedSchedule, "scheduleHash"> = {
      scheduleVersion: SCHEDULE_VERSION,
      createdAt: input.createdAt,
      coin: face,
      firstArms,
      slots: plannedSlots(firstArms),
      protocol: { id: protocol.id, version: protocol.version, hash: protocol.hash },
      fixture: { ...input.fixture },
      codeRevision: structuredClone(input.codeRevision),
      roster: structuredClone(input.roster),
      config,
      configDigest: configDigestOf(config),
    }
    const schedule: PairedSchedule = { ...unsealed, scheduleHash: scheduleHashOf(unsealed) }

    const temporary = join(root, `${SCHEDULE_FILE}.${process.pid}.${Date.now()}.tmp`)
    // Only a temporary file THIS call created is removed afterwards, and only an
    // EEXIST from `link` means a schedule already exists.
    let createdTemporary = false
    try {
      try {
        const handle = await open(temporary, "wx", 0o600)
        createdTemporary = true
        try {
          await handle.writeFile(`${JSON.stringify(schedule, undefined, 2)}\n`, "utf8")
          await handle.sync()
        } finally {
          await handle.close()
        }
      } catch (error) {
        return { ok: false, reason: `the schedule's temporary file \`${temporary}\` could not be written: ${messageOf(error)}` }
      }
      try {
        await link(temporary, file)
      } catch (error) {
        return {
          ok: false,
          reason:
            (error as NodeJS.ErrnoException).code === "EEXIST"
              ? `a schedule already exists at \`${file}\`; a schedule is never re-tossed or replaced`
              : `the schedule could not be published: ${messageOf(error)}`,
        }
      }
      try {
        await syncDirectory(root)
      } catch (error) {
        return { ok: false, reason: `the schedule was linked but its directory could not be synced: ${messageOf(error)}` }
      }
    } finally {
      if (createdTemporary) await unlink(temporary).catch(() => undefined)
    }
    return { ok: true, schedule, file }
  }
}

// ---------------------------------------------------------------------------
// Verify, start, slot status
// ---------------------------------------------------------------------------

export interface ScheduleBinding {
  protocolFile: string
  fixture: LabelledChangeSeal
  codeRevision: Maybe<CodeRevision>
  roster: Roster
  change: ChangeSet
  config: PairedConfig
}

export type ScheduleVerified = { ok: true; schedule: PairedSchedule } | { ok: false; reason: string }

/**
 * Read the published schedule and check it against the runner's own inputs:
 * its hash, the protocol, fixture, code revision, roster and config it was sealed
 * with, and that its order follows from its coin.
 */
export async function verifySchedule(bundleRoot: string, binding: ScheduleBinding): Promise<ScheduleVerified> {
  const file = join(resolve(bundleRoot), SCHEDULE_FILE)
  let schedule: PairedSchedule
  try {
    schedule = JSON.parse(await readFile(file, "utf8")) as PairedSchedule
  } catch (error) {
    return { ok: false, reason: `no readable schedule at \`${file}\`: ${messageOf(error)}` }
  }
  const refuse = (why: string): ScheduleVerified => ({ ok: false, reason: `the schedule at \`${file}\` ${why}` })
  if (schedule === null || typeof schedule !== "object") return refuse("is not an object")
  if (schedule.scheduleVersion !== SCHEDULE_VERSION) return refuse(`has schedule version ${String(schedule.scheduleVersion)}`)
  if (typeof schedule.scheduleHash !== "string" || scheduleHashOf(schedule) !== schedule.scheduleHash) {
    return refuse("does not match its own scheduleHash")
  }
  if (schedule.coin !== "heads" && schedule.coin !== "tails") return refuse("carries no coin")
  const expectedFirst = firstArmsFor(schedule.coin)
  if (canonicalJson(schedule.firstArms) !== canonicalJson(expectedFirst)) {
    return refuse(`orders its first arms ${JSON.stringify(schedule.firstArms)}, which the coin ${schedule.coin} does not give`)
  }
  if (canonicalJson(schedule.slots) !== canonicalJson(plannedSlots(expectedFirst))) {
    return refuse("plans slots its coin does not give")
  }
  const protocol = await readFrozenProtocol(binding.protocolFile)
  if (!protocol.ok) return { ok: false, reason: protocol.reason }
  if (canonicalJson(schedule.protocol) !== canonicalJson({ id: protocol.id, version: protocol.version, hash: protocol.hash })) {
    return refuse(`is bound to protocol ${canonicalJson(schedule.protocol)}, not to the frozen protocol this runner read`)
  }
  if (canonicalJson(schedule.fixture) !== canonicalJson(binding.fixture)) return refuse("is bound to a different fixture seal")
  if (canonicalJson(schedule.codeRevision) !== canonicalJson(binding.codeRevision)) {
    return refuse("is bound to a different code revision")
  }
  if (canonicalJson(schedule.roster) !== canonicalJson(binding.roster)) return refuse("is bound to a different roster or models")
  const config = pairedRunConfig(binding.config, binding.change, binding.roster)
  if (schedule.configDigest !== configDigestOf(config) || canonicalJson(schedule.config) !== canonicalJson(config)) {
    return refuse("is bound to a different change or configuration")
  }
  return { ok: true, schedule }
}

export type Started = { ok: true; file: string } | { ok: false; reason: string }

/** Write the start marker without overwrite. A present marker refuses. */
export async function writeStartMarker(bundleRoot: string, scheduleHash: string, startedAt: string): Promise<Started> {
  const file = join(resolve(bundleRoot), START_MARKER_FILE)
  try {
    const handle = await open(file, "wx", 0o600)
    try {
      await handle.writeFile(`${JSON.stringify({ scheduleHash, startedAt, pid: process.pid })}\n`, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await syncDirectory(dirname(file))
    return { ok: true, file }
  } catch (error) {
    return {
      ok: false,
      reason:
        (error as NodeJS.ErrnoException).code === "EEXIST"
          ? `the schedule was already started (\`${file}\` exists); a started schedule is never executed again`
          : `the start marker \`${file}\` could not be written: ${messageOf(error)}`,
    }
  }
}

export type SlotStatus = "started" | "completed" | "cancelled" | "failed" | "not-attempted"

export interface SlotStatusLine extends PlannedSlot {
  status: SlotStatus
  reason: string
  at: string
  runId?: string
}

/** Append one slot status. Resolves to a reason when the append failed, else `null`. */
export async function appendSlotStatus(bundleRoot: string, line: SlotStatusLine): Promise<string | null> {
  const file = join(resolve(bundleRoot), SLOT_STATUS_FILE)
  try {
    const handle = await open(file, "a", 0o600)
    try {
      await handle.appendFile(`${JSON.stringify(line)}\n`, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await syncDirectory(dirname(file))
    return null
  } catch (error) {
    return `the slot status file \`${file}\` could not be appended: ${messageOf(error)}`
  }
}

/** Every slot status line, in order. An absent file is no lines. */
export async function readSlotStatuses(bundleRoot: string): Promise<SlotStatusLine[]> {
  const file = join(resolve(bundleRoot), SLOT_STATUS_FILE)
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  return text
    .split("\n")
    .filter((row) => row.length > 0)
    .map((row) => JSON.parse(row) as SlotStatusLine)
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
