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
 *   adversarial-bill.json       the journal's bill as the runner left it, written
 *                               once when the runner ends
 *
 * The journal, the lock and the halt marker are the EXPERIMENT ROOT's, shared
 * with every category (`ablation/journal.ts`). Nothing here touches the paired
 * schedule, start marker or `bundle.json` at the root.
 *
 * ## Attempt mode (story 2-7e)
 *
 * `AdversarialConfig.accounting: "attempts"` with `route: "oauth"` seals a
 * schedule for protocol v3: it binds a frozen version-3 protocol, its config
 * carries no token cap, no stop on unknown usage and
 * `ADVERSARIAL_ATTEMPT_ALLOWANCES`, and the suite then has a root of its own
 * (v3 B5). That root carries `adversarial-root.json`, written before the coins
 * are tossed, and `isolatedRootProblem` refuses it while any v1 or v2 experiment
 * file sits at it, above it or below it. A config naming neither field is the
 * token-mode config, and its digest does not depend on them.
 *
 * AD-1: this tree may import from `core/` and `fixtures/`. Nothing under `core/`
 * imports it.
 */

import { lstat, mkdir, readdir, readFile, realpath, stat } from "node:fs/promises"
import { basename, dirname, join, resolve, sep } from "node:path"

import { CUMULATIVE_SHARE } from "../core/budget/presets.ts"
import type { Roster } from "../core/domain/roster.ts"
import { ADVERSARIAL_ASSERTIONS, type AdversarialAssertion } from "../fixtures/adversarial/assertions.ts"
import { ADVERSARIAL_CASES, type AdversarialMaterial, type AdversarialSurface, type PayloadCarrier } from "../fixtures/adversarial/material.ts"
import { ADVERSARIAL_SEAL, adversarialSealProblem, type AdversarialSeal } from "../fixtures/adversarial/seal.ts"
import type { Provenance } from "./arms.ts"
import { ADVERSARIAL_ALLOWANCES, ADVERSARIAL_ATTEMPT_ALLOWANCES, HALT_MARKER_FILE } from "./governor.ts"
import { acquireLock, JOURNAL_FILE, LOCK_FILE } from "./journal.ts"
import type { CodeRevision, Maybe } from "./manifest.ts"
import type { GateRoute } from "./paired-gates.ts"
import {
  appendStatusLine,
  canonicalJson,
  cryptoCoin,
  instructionsDigestOf,
  publishExclusive,
  readFrozenProtocol,
  readStatusLines,
  SCHEDULE_FILE,
  sha256,
  START_MARKER_FILE,
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
  /**
   * What the suite's journal counts. Absent means ledger tokens (protocol v1).
   * `attempts` is protocol v3's unit for the OAuth route.
   */
  accounting?: "attempts"
  /** How the host reaches its providers. Absent means `api-key`. */
  route?: GateRoute
  /**
   * Story 2-7f — the host tools every turn is offered, as opencode's per-call
   * allowlist (protocol v3 B8). Absent: the config declares no offer.
   */
  hostTools?: Readonly<Record<string, boolean>>
  /**
   * Story 2-7f — `fresh-per-run`: each run gets a managed host and an OAuth data
   * directory of its own, started after every worktree is written and stopped
   * before the next run (protocol v3 B9). The runner refuses it without a
   * `lifecycle`, and a `lifecycle` without it.
   */
  hostIsolation?: "fresh-per-run"
}

/** The one host isolation a config can declare. */
export const FRESH_PER_RUN = "fresh-per-run"

/** Protocol v3 B8 — the one host offer a config can declare: `StructuredOutput` only, every other tool name refused. */
export const ADVERSARIAL_HOST_OFFER: Readonly<Record<string, boolean>> = Object.freeze({ "*": false, StructuredOutput: true })

/**
 * Why the config's host offer or host isolation cannot be sealed, or `null`.
 * Both are declared together or not at all, and only with `accounting:
 * "attempts"` on the oauth route. The offer is exactly `ADVERSARIAL_HOST_OFFER`
 * and the isolation `fresh-per-run`. A config declaring neither is unaffected.
 */
export function adversarialHostProblem(config: Pick<AdversarialConfig, "hostTools" | "hostIsolation" | "accounting" | "route">): string | null {
  const { hostTools, hostIsolation, accounting, route } = config as { hostTools?: unknown; hostIsolation?: unknown; accounting?: unknown; route?: unknown }
  if (hostTools === undefined && hostIsolation === undefined) return null
  if (hostTools === undefined || hostIsolation === undefined) {
    return "the config declares only one of the host offer and the host isolation; they are declared together or not at all"
  }
  if (accounting !== "attempts" || route !== "oauth") {
    return "the host offer and isolation belong to an attempt-mode schedule on the oauth route (protocol v3 B8 and B9)"
  }
  if (hostIsolation !== FRESH_PER_RUN) return `the config's host isolation ${JSON.stringify(hostIsolation)} is not \`${FRESH_PER_RUN}\``
  if (
    hostTools === null ||
    typeof hostTools !== "object" ||
    Array.isArray(hostTools) ||
    canonicalJson(hostTools) !== canonicalJson(ADVERSARIAL_HOST_OFFER)
  ) {
    return `the config's host tool offer ${JSON.stringify(hostTools)} is not ${JSON.stringify(ADVERSARIAL_HOST_OFFER)}: protocol v3 B8 offers StructuredOutput only`
  }
  return null
}

/** Whether the config selects attempt accounting. */
export function adversarialAttemptMode(config: Pick<AdversarialConfig, "accounting">): boolean {
  return config.accounting === "attempts"
}

/**
 * Why the config's accounting and route cannot run together, or `null`. They
 * are one choice: the OAuth route measures no tokens and runs only in attempt
 * mode, and attempt mode belongs to the OAuth route alone. Any other value of
 * either field refuses.
 */
export function adversarialAccountingProblem(config: Pick<AdversarialConfig, "accounting" | "route">): string | null {
  const { accounting, route } = config as { accounting?: unknown; route?: unknown }
  if (accounting !== undefined && accounting !== "attempts") {
    return `the config's accounting ${JSON.stringify(accounting)} is not \`attempts\`; the token mode is selected by leaving it absent`
  }
  if (route !== undefined && route !== "api-key" && route !== "oauth") {
    return `the config's route ${JSON.stringify(route)} is neither api-key nor oauth`
  }
  if (route === "oauth" && accounting !== "attempts") {
    return "the oauth route measures no tokens, so it runs only with accounting `attempts`"
  }
  if (accounting === "attempts" && route !== "oauth") {
    return "accounting `attempts` belongs to the oauth route; the api-key route is measured in tokens"
  }
  return null
}

/**
 * Why an attempt-mode schedule may not bind this protocol, or `null`:
 * adversarial attempt accounting is defined only by a frozen version-3
 * protocol (its sections B2 to B6). `readFrozenProtocol` has already verified
 * status and hash, so a draft never reaches this check.
 */
export function adversarialProtocolProblem(
  config: Pick<AdversarialConfig, "accounting">,
  protocol: { id: string; version: number },
): string | null {
  if (!adversarialAttemptMode(config) || protocol.version === 3) return null
  return (
    `accounting \`attempts\` needs a frozen version-3 protocol, and the protocol handed in is ` +
    `${protocol.id} version ${protocol.version}`
  )
}

/**
 * Every setting the runs receive, as the schedule binds it. The run cap and
 * shares are fixed here.
 *
 * In attempt mode the dials say what the runs receive: no `tokenCap` (`null`),
 * no stop on unknown usage, and the attempt allowances in place of the token
 * ones. A token-mode config carries none of the attempt fields, so its digest
 * does not depend on them. In either mode the host offer and isolation are
 * bound only when the config declares them.
 */
export function adversarialRunConfig(config: AdversarialConfig, roster: Roster): Record<string, unknown> {
  if (adversarialAttemptMode(config)) {
    return {
      provenance: config.provenance,
      tokenCap: null,
      spendShares: { ...CUMULATIVE_SHARE },
      stopOnUnknownUsage: false,
      maxConcurrency: config.maxConcurrency,
      accounting: "attempts",
      attemptAllowances: { ...ADVERSARIAL_ATTEMPT_ALLOWANCES },
      route: config.route,
      instructionsDigest: instructionsDigestOf(roster),
      tools: config.tools,
      ...hostFields(config),
    }
  }
  return {
    provenance: config.provenance,
    tokenCap: ADVERSARIAL_ALLOWANCES.runCap,
    spendShares: { ...CUMULATIVE_SHARE },
    stopOnUnknownUsage: true,
    maxConcurrency: config.maxConcurrency,
    allowances: { ...ADVERSARIAL_ALLOWANCES },
    instructionsDigest: instructionsDigestOf(roster),
    tools: config.tools,
    ...hostFields(config),
  }
}

/** The host offer and isolation, each only when the config declares it, so a config declaring neither keeps its digest. */
function hostFields(config: AdversarialConfig): Record<string, unknown> {
  return {
    ...(config.hostTools === undefined ? {} : { hostTools: { ...config.hostTools } }),
    ...(config.hostIsolation === undefined ? {} : { hostIsolation: config.hostIsolation }),
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
 * Why a `maxConcurrency` is refused, or `null`. Only an absent value or exactly
 * 1 is accepted. The roster has one slot, and every run rebinds one shared Bun
 * `$` to its own worktree, so more than one turn in flight buys nothing and a
 * concurrent blame could run in the wrong worktree. A value below 1 or not a
 * whole number admits no turn at all, so it is refused too.
 */
export function concurrencyProblem(config: Pick<AdversarialConfig, "maxConcurrency">): string | null {
  const value = config.maxConcurrency
  if (value === undefined || value === 1) return null
  if (Number.isInteger(value) && value > 1) {
    return (
      `maxConcurrency ${value} is refused: the adversarial runs use a one-slot roster over a shared ` +
      "Bun `$` that each run rebinds to its own worktree, so at most one turn may be in flight"
    )
  }
  return `maxConcurrency ${value} is refused: it must be absent or exactly 1`
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
 * verify, the roster is not one slot, `maxConcurrency` is not absent or 1, the
 * Tools identity is blank or the protocol does not verify. Bills nothing.
 *
 * An attempt-mode config is refused too when its accounting and route disagree,
 * when the protocol is not a frozen version 3, and when the root is not
 * isolated (`isolatedRootProblem`). The root marker is written before the first
 * coin.
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
  const accounting = adversarialAccountingProblem(input.config)
  if (accounting !== null) return { ok: false, reason: `${accounting}; nothing was tossed` }
  const host = adversarialHostProblem(input.config)
  if (host !== null) return { ok: false, reason: `${host}; nothing was tossed` }
  const protocol = await readFrozenProtocol(input.protocolFile)
  if (!protocol.ok) return { ok: false, reason: protocol.reason }
  const protocolProblem = adversarialProtocolProblem(input.config, protocol)
  if (protocolProblem !== null) return { ok: false, reason: `${protocolProblem}; nothing was tossed` }
  if (adversarialAttemptMode(input.config)) {
    const isolation = await isolatedRootProblem(root, { marker: "optional" })
    if (isolation !== null) return { ok: false, reason: `${isolation}; nothing was tossed` }
    const marked = await ensureAdversarialRootMarker(root, input.createdAt)
    if (marked !== null) return { ok: false, reason: `${marked}; nothing was tossed` }
  }

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
  const accounting = adversarialAccountingProblem(binding.config)
  if (accounting !== null) return { ok: false, reason: accounting }
  const host = adversarialHostProblem(binding.config)
  if (host !== null) return { ok: false, reason: host }
  const protocol = await readFrozenProtocol(binding.protocolFile)
  if (!protocol.ok) return { ok: false, reason: protocol.reason }
  const protocolProblem = adversarialProtocolProblem(binding.config, protocol)
  if (protocolProblem !== null) return { ok: false, reason: protocolProblem }
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
// Story 2-7e — the suite's own root (protocol v3 B5), attempt mode only
// ---------------------------------------------------------------------------

export const ADVERSARIAL_ROOT_MARKER_FILE = "adversarial-root.json"
export const ADVERSARIAL_ROOT_MARKER_KIND = "mad-adversarial-suite-root"
/** Bumped by hand when the root marker's shape changes. */
export const ADVERSARIAL_ROOT_MARKER_VERSION = 1

/**
 * The file at an attempt-mode suite's root that says the root is the suite's
 * own. With it, the journal, the lock, the halt marker and everything under
 * `adversarial/` at that root are the suite's files. Without it they are read as
 * another experiment's.
 */
export interface AdversarialRootMarker {
  kind: typeof ADVERSARIAL_ROOT_MARKER_KIND
  version: number
  accounting: "attempts"
  scope: "adversarial"
  createdAt: string
}

type RootMarkerRead = { kind: "absent" } | { kind: "valid" } | { kind: "problem"; reason: string }

async function readAdversarialRootMarker(root: string): Promise<RootMarkerRead> {
  const file = join(root, ADVERSARIAL_ROOT_MARKER_FILE)
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" }
    return { kind: "problem", reason: `the adversarial root marker \`${file}\` could not be read (${messageOf(error)}), so whose files this root holds is not established` }
  }
  try {
    const marker = JSON.parse(text) as Record<string, unknown> | null
    if (
      marker !== null &&
      typeof marker === "object" &&
      marker.kind === ADVERSARIAL_ROOT_MARKER_KIND &&
      marker.version === ADVERSARIAL_ROOT_MARKER_VERSION &&
      marker.accounting === "attempts" &&
      marker.scope === "adversarial" &&
      typeof marker.createdAt === "string"
    ) {
      return { kind: "valid" }
    }
  } catch {
    // Reported below with the same reason as a marker of the wrong shape.
  }
  return { kind: "problem", reason: `the adversarial root marker \`${file}\` is not a version-${ADVERSARIAL_ROOT_MARKER_VERSION} suite root marker, so whose files this root holds is not established` }
}

/** Write the root marker unless a valid one is already there. Returns why it could not, or `null`. */
async function ensureAdversarialRootMarker(root: string, createdAt: string): Promise<string | null> {
  const existing = await readAdversarialRootMarker(root)
  if (existing.kind === "valid") return null
  if (existing.kind === "problem") return existing.reason
  const marker: AdversarialRootMarker = {
    kind: ADVERSARIAL_ROOT_MARKER_KIND,
    version: ADVERSARIAL_ROOT_MARKER_VERSION,
    accounting: "attempts",
    scope: "adversarial",
    createdAt,
  }
  const published = await publishExclusive(root, ADVERSARIAL_ROOT_MARKER_FILE, `${JSON.stringify(marker, undefined, 2)}\n`, "the adversarial root marker")
  return published.ok ? null : published.reason
}

/** The files whose presence in a directory marks it as an experiment root of some protocol. */
const DIRECT_ROOT_MARKERS = [JOURNAL_FILE, LOCK_FILE, HALT_MARKER_FILE, SCHEDULE_FILE, START_MARKER_FILE, ADVERSARIAL_ROOT_MARKER_FILE] as const

/**
 * Why `experimentRoot` cannot be the attempt-mode suite's own root, or `null`
 * (protocol v3 B5): the suite's journal, lock and halt marker must be neither
 * above nor below any v1 or v2 experiment root, nor shared with one.
 *
 * Refused, naming the file found:
 *
 * - **At the root.** A paired schedule or start marker always. Without a valid
 *   root marker, also a journal, a halt marker or anything of the suite's under
 *   `adversarial/`: nothing says those are this suite's. The lock is not
 *   evidence either way, because the caller holds it. `marker: "required"`
 *   refuses a root that carries no marker at all.
 * - **Above it.** Any experiment file, or another suite's root marker, in any
 *   ancestor directory of the root's path as given and of its canonical
 *   (`realpath`) path, so a symlinked alias of a nested root is refused.
 * - **Below it.** Any of those in any descendant directory.
 *
 * FAIL CLOSED. A path that cannot be resolved, a directory that cannot be
 * listed and a file whose presence cannot be established each refuse. Unlike
 * the token-mode rule (`sharedLedgerProblem`), an ancestor this process may not
 * search refuses too: what it holds is not established.
 *
 * SYMLINKS ARE AMBIGUOUS EVIDENCE, AND REFUSE. A write through one lands
 * somewhere this check did not look, so:
 *
 * - the root's own marker, journal, halt marker and `adversarial/` entry may not
 *   be symlinks;
 * - a marker-named path at or above the root that is a symlink which does not
 *   resolve is neither present nor absent, and refuses;
 * - a symlink below the root that resolves to a directory outside the root
 *   refuses, whatever that directory holds. One that resolves inside the root
 *   is reached by its real path, and one that resolves to nothing reaches
 *   nothing.
 */
export async function isolatedRootProblem(experimentRoot: string, options: { marker: "required" | "optional" }): Promise<string | null> {
  const lexical = resolve(experimentRoot)
  const refuse = (why: string): string => `\`${lexical}\` cannot be the adversarial suite's own root (protocol v3 B5): ${why}`
  let real: string
  try {
    real = await realpath(lexical)
  } catch (error) {
    return refuse(`its canonical path could not be resolved (${messageOf(error)}), so its isolation is not established`)
  }
  const gone = (error: unknown): boolean => {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" || code === "ENOTDIR"
  }
  /** `symlink`, `other`, `absent`, or the reason the entry's kind could not be established. */
  const kindOf = async (file: string): Promise<"symlink" | "other" | "absent" | { reason: string }> => {
    try {
      return (await lstat(file)).isSymbolicLink() ? "symlink" : "other"
    } catch (error) {
      if (gone(error)) return "absent"
      return { reason: `whether \`${file}\` exists could not be established (${messageOf(error)}), so isolation is not established` }
    }
  }
  /** `present`, `absent`, or the reason neither is established. A symlink that does not resolve is neither. */
  const probe = async (file: string): Promise<"present" | "absent" | string> => {
    const kind = await kindOf(file)
    if (typeof kind === "object") return kind.reason
    if (kind !== "symlink") return kind === "absent" ? "absent" : "present"
    try {
      await stat(file)
      return "present"
    } catch (error) {
      return `\`${file}\` is a symlink that does not resolve (${messageOf(error)}), so whether an experiment file stands there is not established`
    }
  }

  // At the root. Its own entries are never symlinks: a file reached through one
  // is not shown to be this root's.
  for (const name of [ADVERSARIAL_ROOT_MARKER_FILE, JOURNAL_FILE, HALT_MARKER_FILE, ADVERSARIAL_DIRECTORY]) {
    const kind = await kindOf(join(real, name))
    if (typeof kind === "object") return refuse(kind.reason)
    if (kind === "symlink") return refuse(`\`${join(real, name)}\` is a symlink, so whose file it reaches is not established`)
  }
  const marker = await readAdversarialRootMarker(real)
  if (marker.kind === "problem") return refuse(marker.reason)
  if (marker.kind === "absent" && options.marker === "required") {
    return refuse(
      `it carries no \`${ADVERSARIAL_ROOT_MARKER_FILE}\`, so its journal, lock and halt marker cannot be told apart from ` +
        "another experiment's",
    )
  }
  const suiteFiles = [
    JOURNAL_FILE,
    HALT_MARKER_FILE,
    join(ADVERSARIAL_DIRECTORY, ADVERSARIAL_SCHEDULE_FILE),
    join(ADVERSARIAL_DIRECTORY, ADVERSARIAL_START_MARKER_FILE),
  ]
  for (const name of [SCHEDULE_FILE, START_MARKER_FILE, ...(marker.kind === "valid" ? [] : suiteFiles)]) {
    const file = join(real, name)
    const found = await probe(file)
    if (found === "absent") continue
    if (found !== "present") return refuse(found)
    return refuse(
      name === SCHEDULE_FILE || name === START_MARKER_FILE
        ? `\`${file}\` exists, so this is a paired experiment's root`
        : `\`${file}\` exists and the root carries no \`${ADVERSARIAL_ROOT_MARKER_FILE}\`, so that file belongs to another experiment`,
    )
  }

  // Above it, on the path as given and on the canonical path.
  const ancestorNames = [...DIRECT_ROOT_MARKERS, join(ADVERSARIAL_DIRECTORY, ADVERSARIAL_SCHEDULE_FILE)]
  const checked = new Set<string>()
  for (const start of new Set([lexical, real])) {
    let directory = dirname(start)
    for (;;) {
      if (!checked.has(directory)) {
        checked.add(directory)
        for (const name of ancestorNames) {
          const file = join(directory, name)
          const found = await probe(file)
          if (found === "absent") continue
          if (found !== "present") return refuse(found)
          return refuse(`\`${file}\` exists above it, so it is nested inside another experiment root`)
        }
      }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }

  // Below it.
  const ownAdversarial = join(real, ADVERSARIAL_DIRECTORY)
  const foreignIn = (directory: string, names: readonly string[]): string | null => {
    const direct = DIRECT_ROOT_MARKERS.find((name) => names.includes(name))
    if (direct !== undefined) return join(directory, direct)
    if (basename(directory) === ADVERSARIAL_DIRECTORY && directory !== ownAdversarial && names.includes(ADVERSARIAL_SCHEDULE_FILE)) {
      return join(directory, ADVERSARIAL_SCHEDULE_FILE)
    }
    return null
  }
  const pending: string[] = [real]
  while (pending.length > 0) {
    const directory = pending.pop()!
    let entries: Awaited<ReturnType<typeof listDirectory>>
    try {
      entries = await listDirectory(directory)
    } catch (error) {
      return refuse(`\`${directory}\` below it could not be listed (${messageOf(error)}), so what it holds is not established`)
    }
    if (directory !== real) {
      const foreign = foreignIn(directory, entries.map((entry) => entry.name))
      if (foreign !== null) return refuse(`\`${foreign}\` exists below it, so another experiment root is nested inside it`)
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(path)
        continue
      }
      if (!entry.isSymbolicLink()) continue
      let target: string
      try {
        target = await realpath(path)
        if (!(await stat(target)).isDirectory()) continue
      } catch (error) {
        if (gone(error)) continue
        return refuse(`the symlink \`${path}\` below it could not be resolved (${messageOf(error)}), so what it reaches is not established`)
      }
      if (target === real || target.startsWith(`${real}${sep}`)) continue
      return refuse(
        `the symlink \`${path}\` below it reaches the directory \`${target}\` outside the root, so what the root holds is not established`,
      )
    }
  }
  return null
}

function listDirectory(directory: string) {
  return readdir(directory, { withFileTypes: true })
}

// ---------------------------------------------------------------------------
// Start marker and slot status
// ---------------------------------------------------------------------------

export function writeAdversarialStartMarker(experimentRoot: string, scheduleHash: string, startedAt: string): Promise<Started> {
  return writeStartMarker(adversarialDirectory(experimentRoot), scheduleHash, startedAt, ADVERSARIAL_START_MARKER_FILE)
}

export type StartMarkerRead =
  | { kind: "absent" }
  | { kind: "present"; scheduleHash: string; startedAt: string }
  | { kind: "unreadable"; reason: string }

/** The adversarial start marker, as the reader sees it. Never throws. */
export async function readAdversarialStartMarker(experimentRoot: string): Promise<StartMarkerRead> {
  const file = join(adversarialDirectory(experimentRoot), ADVERSARIAL_START_MARKER_FILE)
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" }
    return { kind: "unreadable", reason: `the start marker \`${file}\` could not be read: ${messageOf(error)}` }
  }
  try {
    const marker = JSON.parse(text) as Record<string, unknown> | null
    if (marker !== null && typeof marker === "object" && typeof marker.scheduleHash === "string" && typeof marker.startedAt === "string") {
      return { kind: "present", scheduleHash: marker.scheduleHash, startedAt: marker.startedAt }
    }
  } catch {
    // Reported below with the same reason as a marker of the wrong shape.
  }
  return { kind: "unreadable", reason: `the start marker \`${file}\` holds no readable schedule hash and start time` }
}

export const ADVERSARIAL_BILL_FILE = "adversarial-bill.json"

/**
 * The experiment journal's bill as the adversarial runner left it, written once
 * when the runner ends. Spend, overshoot and unknown usage live in the journal;
 * this file carries the runner's summary so the durable report can print them.
 */
export interface AdversarialBillSummary {
  scheduleHash: string
  at: string
  /**
   * Known Adversarial and whole-experiment spend, in tokens. In an attempt-mode
   * bill (`accounting`), the suite's and the root's admitted attempts in every
   * issued state, as `overshoot` counts them.
   */
  adversarialKnown: number
  globalKnown: number
  overshoot: { global: { limit: number; spent: number; overshoot: number }; adversarial: { limit: number; spent: number; overshoot: number } }
  /** Requests settled with unknown usage, issued and never settled, and still in flight. */
  unknown: number
  uncertain: number
  inFlight: number
  /**
   * Refused Adversarial admissions, each with its run label and reason. A refused
   * admission writes no journal line, so this list is the only durable record of
   * one. `attempt` is written in an attempt-mode bill.
   */
  refused: { label: string; stage: string; cause: string; reason: string; attempt?: number }[]
  halt: string | null
  stop: string | null
  /**
   * Story 2-7c — every operational quarantine reason, beside `halt` rather than
   * inside it.
   *
   * DURABLE HERE BECAUSE THE HALT MARKER MAY NOT CARRY IT. The marker is written
   * once, without overwrite, the first time a halt latches — so on a run where an
   * accounting halt landed first, the marker names the money and this names the
   * cleanup. The two need different recovery steps and neither may hide the
   * other. Empty on every ordinary run.
   */
  operational: string[]
  /**
   * Story 2-7e — present exactly in an attempt-mode bill. Every count above is
   * then in admitted attempts, `unknown` counts attempts settled with no host
   * figure (a diagnostic, each counted in full), and `runs` is present.
   */
  accounting?: "attempts"
  /** Story 2-7e — attempt mode only: each run's attempts against the per-run allowance, as the runner left them. */
  runs?: { runId: string; limit: number; spent: number; overshoot: number }[]
  /** Story 2-7e — attempt mode only: admissions settled `not-issued`, which count 0 attempts. */
  notIssued?: number
}

/** Write the bill summary with `wx`: a runner ends once. Returns why it failed, or `null`. */
export async function writeAdversarialBill(experimentRoot: string, summary: AdversarialBillSummary): Promise<string | null> {
  const published = await publishExclusive(
    adversarialDirectory(experimentRoot),
    ADVERSARIAL_BILL_FILE,
    `${JSON.stringify(summary, undefined, 2)}\n`,
    "the adversarial bill summary",
  )
  return published.ok ? null : published.reason
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)

/** One refused admission of an attempt-mode bill: its four strings, and a whole-number attempt when it carries one. */
function billRefusalOk(entry: unknown): boolean {
  return (
    isRecord(entry) &&
    typeof entry.label === "string" &&
    typeof entry.stage === "string" &&
    typeof entry.cause === "string" &&
    typeof entry.reason === "string" &&
    (entry.attempt === undefined || (typeof entry.attempt === "number" && Number.isInteger(entry.attempt)))
  )
}

/** One per-run row of an attempt-mode bill. */
function billRunOk(entry: unknown): boolean {
  return (
    isRecord(entry) &&
    typeof entry.runId === "string" &&
    entry.runId.length > 0 &&
    typeof entry.limit === "number" &&
    typeof entry.spent === "number" &&
    typeof entry.overshoot === "number"
  )
}

export type BillRead = { kind: "absent" } | { kind: "read"; bill: AdversarialBillSummary } | { kind: "unreadable"; reason: string }

/** The bill summary, as the reader sees it. Never throws. */
export async function readAdversarialBill(experimentRoot: string): Promise<BillRead> {
  const file = join(adversarialDirectory(experimentRoot), ADVERSARIAL_BILL_FILE)
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" }
    return { kind: "unreadable", reason: `the bill summary \`${file}\` could not be read: ${messageOf(error)}` }
  }
  try {
    const bill = JSON.parse(text) as AdversarialBillSummary
    if (
      bill !== null &&
      typeof bill === "object" &&
      typeof bill.scheduleHash === "string" &&
      typeof bill.adversarialKnown === "number" &&
      typeof bill.globalKnown === "number" &&
      typeof bill.overshoot?.adversarial?.overshoot === "number" &&
      typeof bill.overshoot?.global?.overshoot === "number" &&
      typeof bill.unknown === "number" &&
      typeof bill.uncertain === "number" &&
      typeof bill.inFlight === "number" &&
      Array.isArray(bill.refused) &&
      // STORY 2-7C, AND READ FORWARD-COMPATIBLY. The field is required on the
      // type, so a bill that lacks it would otherwise be handed to a reader as a
      // `string[]` that is `undefined`. A bill written before this story is still
      // readable — it simply recorded no operational quarantine, which is what an
      // empty list says.
      (bill.operational === undefined || Array.isArray(bill.operational)) &&
      // An attempt-mode bill says so and carries its per-run rows, each a whole
      // entry; a bill naming any other accounting is not one this reader knows.
      (bill.accounting === undefined ||
        (bill.accounting === "attempts" &&
          Array.isArray(bill.runs) &&
          bill.runs.every(billRunOk) &&
          bill.refused.every(billRefusalOk) &&
          typeof bill.notIssued === "number"))
    ) {
      return { kind: "read", bill: { ...bill, operational: bill.operational ?? [] } }
    }
  } catch {
    // Reported below with the same reason as a summary of the wrong shape.
  }
  return { kind: "unreadable", reason: `the bill summary \`${file}\` is not a readable bill` }
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

// The number must be followed by the next field or the object's end, so a row
// torn inside `{"position":12` is not read as position 1.
const POSITION_PREFIX = /^\{"position":(\d+)[,}]/

/** Whether a row's `delivery`, when present, has the shape the render reads. */
function deliveryShapeOk(delivery: unknown): boolean {
  if (delivery === undefined) return true
  if (delivery === null || typeof delivery !== "object") return false
  const d = delivery as Record<string, unknown>
  return (
    typeof d.surface === "string" &&
    typeof d.carrier === "string" &&
    typeof d.furthestStage === "string" &&
    typeof d.requests === "number" &&
    typeof d.carrying === "number" &&
    typeof d.uncertain === "number" &&
    (d.carried === "yes" || d.carried === "no" || d.carried === "unshown") &&
    typeof d.reason === "string"
  )
}

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
    if (!deliveryShapeOk(line.delivery)) {
      torn.push({ row: index + 1, position: line.position, why: "a row's delivery evidence is not readable" })
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
