/**
 * Story 2-6 — THE LABELLED READER: CAP-1 recall and CAP-11 lens gain, read from
 * each paired block's shared discovery prefix, and each arm's upheld findings
 * scored against the planted labels.
 *
 * It consumes a `PairedReadResult` and adds nothing to it. It bills nothing,
 * runs no model, and calls neither `runPairedBlocks` nor `createSchedule`.
 *
 * ## WHERE THE POOL COMES FROM
 *
 * The prefix's `record.json` holds the only unmutated discovery pool. Each arm's
 * `manifest.findings.pool` is a clone that debate and judge touched after the
 * fork, so it is never scored for CAP-1 or CAP-11.
 *
 * The record is located from the bundle root and the block's known prefix run id,
 * at `<root>/prefix/<block-1>/<prefixRunId>/record.json`, so a copied or moved
 * bundle still reads. `PrefixEvidence.dump` is an absolute path written where
 * the bundle was made; it serves only as a cross-check, and its basename must be
 * the prefix run id. The block directory must resolve, by REAL path, inside the
 * real bundle root, and the dump directory and `record.json` inside the real
 * block directory. The record must name the block's prefix run id and carry the
 * sealed schedule's roster.
 *
 * ## WHAT THE NUMBERS ESTIMATE
 *
 * CAP-1 is WITHIN-PREFIX ATTRIBUTION: the union of the answered pool slots'
 * findings against the best single answered pool slot of the same discovery
 * pass. It is not an independently executed single-model run. CAP-11 is the
 * planted defects that answered lens slots raised and no answered pool slot
 * raised in that pass. It is not a causal run effect. Both are nonnegative by
 * construction, and neither says anything about precision.
 *
 * ## ANSWERED SLOTS ARE DERIVED AND CHECKED BY IDENTITY
 *
 * `RunRecord` carries `answered` as a count; the slot ids live only on
 * `PreparedReview.answeredSlots`, which is not persisted. So the answered pool
 * is derived — pool slots minus discover-stage `model-dropped-out` slots minus
 * `skippedForBudget` — and checked: its size against `record.answered`, every
 * finding's `author` against the answered slots of its own source, and the slot
 * evidence against itself. A disagreement withholds the quantity it affects,
 * naming both sides.
 *
 * A cancelled discovery turn leaves no drop-out and no skip entry
 * (`core/stages/discover.ts`), so a record cancelled at `discover` has UNKNOWN
 * lens coverage and CAP-11 is withheld. A cancelled pool slot is caught by the
 * answered-count check instead.
 *
 * ## WHAT IT REFUSES, AND WHAT IT LEAVES ALONE
 *
 * A bundle with no sealed schedule is not a labelled bundle: nothing is printed.
 * A schedule the paired reader refused keeps that refusal. A sealed schedule
 * whose fixture is not `LABELLED_CHANGE_SEAL`, a bound arm whose
 * `identity.fixtureHash` is not the sealed material hash, or a bound arm whose
 * protocol identity is not the schedule's, is refused visibly with the field
 * named. An arm the paired reader did not bind is listed as excluded with the
 * paired reader's reason and refuses nothing.
 *
 * Verdict-direction labels and false-positive counts are adjudication and belong
 * to story 2-6b. Precision and cost contrasts belong to story 2.8.
 *
 * Every entry point returns a typed result and nothing throws.
 */

import { realpath, readFile } from "node:fs/promises"
import { basename, join, sep } from "node:path"

import type { Finding } from "../core/domain/finding.ts"
import type { Roster } from "../core/domain/roster.ts"
import { adjudicate } from "../fixtures/seeded-defects/adjudicate.ts"
import { SEEDED_DEFECTS } from "../fixtures/seeded-defects/labels.ts"
import { LABELLED_CHANGE_SEAL } from "../fixtures/seeded-defects/seal.ts"
import {
  lensOnly,
  lensRecallGain,
  lexicalDefectMatcher,
  missedDefects,
  pooledOnly,
  pooledRecallBeatsBestMember,
  type DefectMatcher,
  type SeededDefect,
} from "../fixtures/recall.ts"
import { PREFIX_DIRECTORY } from "./bundle.ts"
import { verdictState } from "./compare.ts"
import { countText } from "./cross-arm-rates.ts"
import { allExcluded, type PairedBlock, type PairedReadResult } from "./paired-read.ts"
import { LABELLED_READER_MODULE } from "./report.ts"
import { canonicalJson, PAIRED_BLOCKS, type Arm, type ArmPosition, type PairedSchedule } from "./schedule.ts"

/** The draft protocol that proposes the endpoints this reader prints. */
export const PROTOCOL_V2_DRAFT = "_bmad-output/specs/spec-mad-orchestrator/evaluation-protocol-v2.md"
/** What every false-positive line reads. */
export const FALSE_POSITIVES_TEXT = "not established — adjudication is story 2-6b"
/** The file a prefix dump holds its record in. */
export const PREFIX_RECORD_FILE = "record.json"

/** What a summarised quantity reads, as data rather than as its label's wording. */
export type QuantityDescriptor =
  | { label: string; source: "prefix"; field: "pool-union" | "best-member" | "union-minus-best" | "lens-only" }
  | { label: string; source: "arm"; arm: Arm; field: "matches" | "unlabelled" }

/**
 * The quantities summarised across blocks, each on its own.
 *
 * The `prefix` quantities are read from the prefix record: a block with a
 * dropped or skipped slot is a partial diagnostic outside their summary, and
 * one prefix is one observation. The `arm` quantities are read from each arm's
 * manifest and count every block the paired reader measured.
 */
export const LABELLED_QUANTITIES = [
  { label: "CAP-1 pool union", source: "prefix", field: "pool-union" },
  { label: "CAP-1 best answered pool slot", source: "prefix", field: "best-member" },
  { label: "CAP-1 union minus best", source: "prefix", field: "union-minus-best" },
  { label: "CAP-11 lens-only defects", source: "prefix", field: "lens-only" },
  { label: "on upheld planted-label matches", source: "arm", arm: "on", field: "matches" },
  { label: "on upheld unlabelled (U)", source: "arm", arm: "on", field: "unlabelled" },
  { label: "off upheld planted-label matches", source: "arm", arm: "off", field: "matches" },
  { label: "off upheld unlabelled (U)", source: "arm", arm: "off", field: "unlabelled" },
] as const satisfies readonly QuantityDescriptor[]
export type LabelledQuantity = (typeof LABELLED_QUANTITIES)[number]["label"]

// ---------------------------------------------------------------------------
// What the reader produces
// ---------------------------------------------------------------------------

/** One identity field that is not what the labelled report requires. */
export interface SealProblem {
  /** `schedule`, `arms`, or `<armId>/<repeatId>`. */
  subject: string
  field: string
  expected: string
  actual: string
}

/** A protocol identity exactly as one file recorded it. */
export interface ProtocolIdentity {
  subject: string
  version: string
  hash: string
}

/** An arm kept out of this report, with the paired reader's reason. */
export interface LabelledExclusion {
  armId: string
  repeatId: number
  reason: string
}

/** One roster slot of the prefix, and whether it answered. */
export interface SlotAccount {
  slot: string
  kind: "pool" | "lens"
  lens?: string
  state: "answered" | "dropped" | "skipped-for-budget" | "unknown"
  /** Why it did not answer, or the salvage disclosure of an answered slot. */
  note?: string
  /** Findings the record attributes to this slot. */
  findings: number
}

export interface DefectCount {
  found: number
  total: number
  ids: string[]
}

export interface MemberRecall extends DefectCount {
  slot: string
}

export interface Coverage {
  answered: number
  of: number
}

export type Cap1Result =
  | {
      kind: "measured"
      pooled: DefectCount
      members: MemberRecall[]
      /** Every answered pool slot tied at the best count, in roster order. */
      best: { slots: string[]; found: number; total: number }
      difference: number
      pool: Coverage
      /** Pool coverage is full. */
      complete: boolean
    }
  | { kind: "unavailable"; reasons: string[] }

export interface LensRecall extends DefectCount {
  slot: string
  lens: string
  lensOnlyIds: string[]
}

export type Cap11Result =
  | {
      kind: "measured"
      lensOnly: DefectCount
      perLens: LensRecall[]
      lens: Coverage
      pool: Coverage
      /** Pool and lens coverage are both full. */
      complete: boolean
    }
  | { kind: "unavailable"; reasons: string[] }

export type ArmLabelResult =
  | {
      kind: "measured"
      upheld: number
      matches: { defectId: string; findingId: string }[]
      /** Upheld findings no planted label claimed, unmatched duplicates included. */
      unlabelled: string[]
    }
  | { kind: "unavailable"; reason: string }

export interface ArmLabelRead {
  arm: Arm
  position: ArmPosition
  runId: string
  protocolVersion: string
  protocolHash: string
  result: ArmLabelResult
}

export type PrefixRecordRead =
  | { kind: "read"; file: string; prefixRunId: string; slots: SlotAccount[]; cancelledAt?: string }
  | { kind: "unavailable" | "refused"; reasons: string[] }

export interface LabelledBlock {
  block: number
  record: PrefixRecordRead
  cap1: Cap1Result
  cap11: Cap11Result
  arms: ArmLabelRead[]
}

export interface LabelledSummary {
  quantity: LabelledQuantity
  observed: number
  of: number
  missing: { block: number; reason: string }[]
  values: number[]
}

export interface ScheduleProtocol {
  id: string
  version: string
  hash: string
}

export interface LabelledReadResult {
  kind: "read"
  root: string
  schedule: ScheduleProtocol
  protocol: ProtocolIdentity[]
  seal: { version: string; materialHash: string }
  excluded: LabelledExclusion[]
  blocks: LabelledBlock[]
  summaries: LabelledSummary[]
}

export type LabelledReadOutcome =
  | { kind: "not-applicable"; why: string }
  | { kind: "schedule-refused"; reason: string }
  | {
      kind: "refused"
      root: string
      schedule: ScheduleProtocol
      problems: SealProblem[]
      protocol: ProtocolIdentity[]
      excluded: LabelledExclusion[]
    }
  | LabelledReadResult

export interface LabelledReadOptions {
  /** Injected, with the shipped lexical default, exactly as `fixtures/recall.ts` injects it. */
  matcher?: DefectMatcher
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

export async function readLabelledBundle(
  paired: PairedReadResult,
  options: LabelledReadOptions = {},
): Promise<LabelledReadOutcome> {
  const matcher = options.matcher ?? lexicalDefectMatcher
  if (!paired.bundle.sealedSchedule) {
    return { kind: "not-applicable", why: "the bundle carries no sealed paired schedule" }
  }
  if (!paired.schedule.ok) return { kind: "schedule-refused", reason: paired.schedule.reason }
  const schedule = paired.schedule.schedule

  const scheduleProtocol = protocolOf(schedule)
  const protocol = protocolIdentities(paired, schedule)
  const excluded = allExcluded(paired).map((entry) => ({
    armId: entry.armId,
    repeatId: entry.repeatId,
    reason: entry.reason,
  }))
  const problems = identityProblems(paired, schedule)
  if (problems.length > 0) {
    return { kind: "refused", root: paired.root, schedule: scheduleProtocol, problems, protocol, excluded }
  }

  const blocks: LabelledBlock[] = []
  for (const block of paired.blocks) {
    blocks.push(await readBlock(paired.root, schedule, block, matcher))
  }
  return {
    kind: "read",
    root: paired.root,
    schedule: scheduleProtocol,
    protocol,
    seal: { version: LABELLED_CHANGE_SEAL.version, materialHash: LABELLED_CHANGE_SEAL.materialHash },
    excluded,
    blocks,
    summaries: summarize(blocks),
  }
}

/**
 * One value format for every identity field, schedule and arm alike: a string
 * as itself, a `Maybe` as its known value or `unknown (why)`, a missing field
 * as `absent`, anything else as its JSON.
 */
function fieldText(value: unknown): string {
  if (value === undefined || value === null) return "absent"
  if (typeof value === "string") return value
  if (typeof value === "number") return String(value)
  if (isRecord(value) && value.kind === "known" && "value" in value) return fieldText(value.value)
  if (isRecord(value) && value.kind === "unknown") return `unknown (${fieldText(value.why)})`
  return JSON.stringify(value) ?? "absent"
}

function protocolOf(schedule: PairedSchedule): ScheduleProtocol {
  const protocol = (isRecord(schedule.protocol) ? schedule.protocol : {}) as Record<string, unknown>
  return { id: fieldText(protocol.id), version: fieldText(protocol.version), hash: fieldText(protocol.hash) }
}

function boundArms(paired: PairedReadResult) {
  return paired.blocks.flatMap((block) => block.arms)
}

function protocolIdentities(paired: PairedReadResult, schedule: PairedSchedule): ProtocolIdentity[] {
  const own = protocolOf(schedule)
  return [
    { subject: "schedule", version: own.version, hash: own.hash },
    ...boundArms(paired).map((arm) => ({
      subject: `${arm.row.armId}/${arm.row.repeatId}`,
      version: fieldText(arm.row.manifest.identity.protocolVersion),
      hash: fieldText(arm.row.manifest.identity.protocolHash),
    })),
  ]
}

/**
 * The seal and the protocol, by explicit equality on each field.
 * `LabelledChangeSeal.version` is a plain `string`, so nothing about its type
 * says a fixture is the labelled one. Only arms the paired reader BOUND are
 * checked; with none bound, no arm confirms the labelled change and the report
 * refuses rather than passing on an empty check.
 */
function identityProblems(paired: PairedReadResult, schedule: PairedSchedule): SealProblem[] {
  const problems: SealProblem[] = []
  const fixture = (isRecord(schedule.fixture) ? schedule.fixture : {}) as Record<string, unknown>
  for (const field of ["version", "materialHash", "labelsHash"] as const) {
    if (fixture[field] !== LABELLED_CHANGE_SEAL[field]) {
      problems.push({
        subject: "schedule",
        field: `fixture.${field}`,
        expected: LABELLED_CHANGE_SEAL[field],
        actual: fieldText(fixture[field]),
      })
    }
  }

  const arms = boundArms(paired)
  if (arms.length === 0) {
    problems.push({
      subject: "arms",
      field: "identity.fixtureHash",
      expected: LABELLED_CHANGE_SEAL.materialHash,
      actual: "absent (the paired reader bound no arm in any block)",
    })
  }
  const own = protocolOf(schedule)
  for (const arm of arms) {
    const subject = `${arm.row.armId}/${arm.row.repeatId}`
    const identity = arm.row.manifest.identity
    const hash = identity.fixtureHash
    if (!(hash?.kind === "known" && hash.value === LABELLED_CHANGE_SEAL.materialHash)) {
      problems.push({
        subject,
        field: "identity.fixtureHash",
        expected: LABELLED_CHANGE_SEAL.materialHash,
        actual: fieldText(hash),
      })
    }
    const version = identity.protocolVersion
    if (!(version?.kind === "known" && fieldText(version.value) === own.version)) {
      problems.push({ subject, field: "identity.protocolVersion", expected: own.version, actual: fieldText(version) })
    }
    const protocolHash = identity.protocolHash
    if (!(protocolHash?.kind === "known" && protocolHash.value === own.hash)) {
      problems.push({ subject, field: "identity.protocolHash", expected: own.hash, actual: fieldText(protocolHash) })
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// One block
// ---------------------------------------------------------------------------

async function readBlock(
  root: string,
  schedule: PairedSchedule,
  block: PairedBlock,
  matcher: DefectMatcher,
): Promise<LabelledBlock> {
  const arms = readArms(block, matcher)
  const loaded = await loadPrefixRecord(root, schedule, block)
  if (loaded.kind !== "loaded") {
    const reasons = loaded.reasons.map((reason) => `the prefix record is ${loaded.kind}: ${reason}`)
    return {
      block: block.block,
      record: loaded,
      cap1: { kind: "unavailable", reasons },
      cap11: { kind: "unavailable", reasons },
      arms,
    }
  }

  const { record, file } = loaded
  const identity = accountSlots(record)
  return {
    block: block.block,
    record: {
      kind: "read",
      file,
      prefixRunId: record.runId,
      slots: identity.slots,
      ...(record.cancelled === undefined ? {} : { cancelledAt: record.cancelled.stage }),
    },
    cap1: measureCap1(record, identity, matcher),
    cap11: measureCap11(record, identity, matcher),
    arms,
  }
}

/** The parts of a prefix `record.json` this reader touches, validated. */
interface PrefixRecord {
  runId: string
  roster: Roster
  answered: number
  pool: Finding[]
  warnings: { code: string; stage: string; detail?: Record<string, unknown> }[]
  cancelled?: { stage: string }
  skippedForBudget: string[]
}

type Loaded =
  | { kind: "loaded"; record: PrefixRecord; file: string }
  | { kind: "unavailable" | "refused"; reasons: string[] }

async function resolved(path: string): Promise<{ ok: true; real: string } | { ok: false; why: string }> {
  try {
    return { ok: true, real: await realpath(path) }
  } catch (error) {
    return { ok: false, why: messageOf(error) }
  }
}

async function loadPrefixRecord(root: string, schedule: PairedSchedule, block: PairedBlock): Promise<Loaded> {
  const prefix = block.prefix
  if (prefix.problem !== null) return { kind: "unavailable", reasons: [prefix.problem] }
  const evidence = prefix.evidence
  if (evidence === null) return { kind: "unavailable", reasons: ["the paired reader returned no prefix evidence"] }
  if (evidence.prefixRunId.kind !== "known") {
    return { kind: "unavailable", reasons: [`its prefix minted no run id (${fieldText(evidence.prefixRunId.why)})`] }
  }
  const prefixRunId = evidence.prefixRunId.value
  if (evidence.dump === null) {
    return {
      kind: "unavailable",
      reasons: [
        `its prefix evidence records \`dump: null\`, so no prefix record exists to score (${evidence.reason ?? "no reason recorded"})`,
      ],
    }
  }
  if (prefixRunId === "" || prefixRunId === "." || prefixRunId === ".." || basename(prefixRunId) !== prefixRunId) {
    return { kind: "refused", reasons: [`its prefix run id \`${prefixRunId}\` is not a single directory name`] }
  }
  if (basename(evidence.dump) !== prefixRunId) {
    return {
      kind: "refused",
      reasons: [
        `its prefix evidence names dump \`${evidence.dump}\`, whose directory name \`${basename(evidence.dump)}\` is not ` +
          `the prefix run id \`${prefixRunId}\``,
      ],
    }
  }

  const realRoot = await resolved(root)
  if (!realRoot.ok) return { kind: "unavailable", reasons: [`the bundle root \`${root}\` could not be resolved (${realRoot.why})`] }
  const directory = join(root, PREFIX_DIRECTORY, String(block.block - 1))
  const realDirectory = await resolved(directory)
  if (!realDirectory.ok) {
    return { kind: "unavailable", reasons: [`the block directory \`${directory}\` could not be resolved (${realDirectory.why})`] }
  }
  if (!inside(realRoot.real, realDirectory.real)) {
    return {
      kind: "refused",
      reasons: [
        `the block directory \`${directory}\` resolves to the real path \`${realDirectory.real}\`, which is not inside ` +
          `the bundle root \`${realRoot.real}\``,
      ],
    }
  }

  const dump = join(directory, prefixRunId)
  const realDump = await resolved(dump)
  if (!realDump.ok) return { kind: "unavailable", reasons: [`the prefix dump \`${dump}\` could not be resolved (${realDump.why})`] }
  if (!inside(realDirectory.real, realDump.real)) {
    return {
      kind: "refused",
      reasons: [
        `the prefix dump \`${dump}\` resolves to the real path \`${realDump.real}\`, which is not inside the ` +
          `block directory \`${realDirectory.real}\``,
      ],
    }
  }

  const recordPath = join(realDump.real, PREFIX_RECORD_FILE)
  const realRecord = await resolved(recordPath)
  if (!realRecord.ok) {
    return { kind: "unavailable", reasons: [`the prefix record \`${recordPath}\` could not be resolved (${realRecord.why})`] }
  }
  if (!inside(realDirectory.real, realRecord.real)) {
    return {
      kind: "refused",
      reasons: [
        `the prefix record \`${recordPath}\` resolves to the real path \`${realRecord.real}\`, which is not inside the ` +
          `block directory \`${realDirectory.real}\``,
      ],
    }
  }

  let raw: unknown
  try {
    raw = JSON.parse(await readFile(realRecord.real, "utf8"))
  } catch (error) {
    return { kind: "unavailable", reasons: [`the prefix record \`${realRecord.real}\` could not be read (${messageOf(error)})`] }
  }
  const parsed = parsePrefixRecord(raw)
  if (typeof parsed === "string") {
    return { kind: "unavailable", reasons: [`the prefix record \`${realRecord.real}\` is malformed: ${parsed}`] }
  }

  const reasons: string[] = []
  if (parsed.runId !== prefixRunId) {
    reasons.push(
      `the prefix record \`${realRecord.real}\` has \`runId\` \`${parsed.runId}\`, but this block's prefix run is ` +
        `\`${prefixRunId}\``,
    )
  }
  if (canonicalJson(parsed.roster) !== canonicalJson(schedule.roster)) {
    reasons.push(
      `the prefix record's \`roster\` (pool ${slotList(parsed.roster.slots)}, lens ${slotList(parsed.roster.lensSlots)}) ` +
        `is not the sealed schedule's \`roster\` (pool ${slotList(schedule.roster?.slots)}, lens ` +
        `${slotList(schedule.roster?.lensSlots)}); their canonical JSON differs`,
    )
  }
  if (reasons.length > 0) return { kind: "refused", reasons }
  return { kind: "loaded", record: parsed, file: realRecord.real }
}

function slotList(slots: readonly { slot: string }[] | undefined): string {
  if (!Array.isArray(slots)) return "absent"
  return slots.length === 0 ? "[]" : `[${slots.map((slot) => `\`${slot.slot}\``).join(", ")}]`
}

/** `child` is a strict descendant of `parent`. Both are real paths. */
function inside(parent: string, child: string): boolean {
  const base = parent.endsWith(sep) ? parent : `${parent}${sep}`
  return child !== parent && child.startsWith(base)
}

/** The record, or the first field that is not what it claims to be. */
function parsePrefixRecord(raw: unknown): PrefixRecord | string {
  if (!isRecord(raw)) return "it is not a JSON object"
  if (typeof raw.runId !== "string") return "`runId` is not a string"
  const roster = raw.roster
  if (!isRecord(roster)) return "`roster` is not an object"
  if (!Array.isArray(roster.slots) || !roster.slots.every((slot) => isRecord(slot) && typeof slot.slot === "string")) {
    return "`roster.slots` is not a list of slots with string `slot` ids"
  }
  if (
    !Array.isArray(roster.lensSlots) ||
    !roster.lensSlots.every((slot) => isRecord(slot) && typeof slot.slot === "string" && typeof slot.lens === "string")
  ) {
    return "`roster.lensSlots` is not a list of lens slots with string `slot` and `lens`"
  }
  if (!isCount(raw.answered)) return "`answered` is not a nonnegative integer"
  if (!Array.isArray(raw.pool)) return "`pool` is not a list"
  for (const [index, finding] of raw.pool.entries()) {
    const problem = findingProblem(finding)
    if (problem !== null) return `\`pool[${index}]\` ${problem}`
    const entry = finding as Record<string, unknown>
    if (entry.source !== "pool" && entry.source !== "lens") return `\`pool[${index}].source\` is neither \`pool\` nor \`lens\``
    if (typeof entry.author !== "string") return `\`pool[${index}].author\` is not a string`
  }
  if (!Array.isArray(raw.warnings)) return "`warnings` is not a list"
  for (const [index, warning] of raw.warnings.entries()) {
    if (!isRecord(warning) || typeof warning.code !== "string" || typeof warning.stage !== "string") {
      return `\`warnings[${index}]\` has no string \`code\` and \`stage\``
    }
    if (warning.detail !== undefined && !isRecord(warning.detail)) return `\`warnings[${index}].detail\` is not an object`
  }
  if (raw.cancelled !== undefined && !(isRecord(raw.cancelled) && typeof raw.cancelled.stage === "string")) {
    return "`cancelled` is present and has no string `stage`"
  }
  const skipped = raw.skippedForBudget
  if (skipped !== undefined && !(Array.isArray(skipped) && skipped.every((slot) => typeof slot === "string"))) {
    return "`skippedForBudget` is present and is not a list of strings"
  }
  return {
    runId: raw.runId,
    roster: roster as unknown as Roster,
    answered: raw.answered,
    pool: raw.pool as Finding[],
    warnings: raw.warnings as PrefixRecord["warnings"],
    ...(raw.cancelled === undefined ? {} : { cancelled: raw.cancelled as { stage: string } }),
    skippedForBudget: (skipped as string[] | undefined) ?? [],
  }
}

/** What the lexical matcher reads off a finding, or `null` when all of it is there. */
function findingProblem(finding: unknown): string | null {
  if (!isRecord(finding)) return "is not an object"
  if (typeof finding.id !== "string") return "has no string `id`"
  if (typeof finding.claim !== "string") return "has no string `claim`"
  if (typeof finding.reasoning !== "string") return "has no string `reasoning`"
  const locus = finding.locus
  if (!isRecord(locus) || typeof locus.file !== "string") return "has no `locus.file`"
  for (const line of ["startLine", "endLine"] as const) {
    if (locus[line] !== undefined && typeof locus[line] !== "number") return `has a non-numeric \`locus.${line}\``
  }
  return null
}

// ---------------------------------------------------------------------------
// Slot identity
// ---------------------------------------------------------------------------

interface SlotIdentity {
  slots: SlotAccount[]
  answeredPool: string[]
  answeredLens: { slot: string; lens: string }[]
  poolSlots: number
  lensSlots: number
  /** Problems that withhold both quantities. */
  both: string[]
  /** Problems that withhold CAP-11 only. */
  lensOnly: string[]
}

function quoted(ids: Iterable<string>): string {
  const list = [...ids]
  return list.length === 0 ? "none" : list.map((id) => `\`${id}\``).join(", ")
}

function accountSlots(record: PrefixRecord): SlotIdentity {
  const both: string[] = []
  const lensProblems: string[] = []
  const pool = record.roster.slots.map((slot) => slot.slot)
  const lens = record.roster.lensSlots.map((slot) => ({ slot: slot.slot, lens: slot.lens }))
  const lensIds = lens.map((slot) => slot.slot)
  const poolSet = new Set(pool)
  const lensSet = new Set(lensIds)
  // A contradiction about a pool slot moves CAP-11's baseline too, so it
  // withholds both; one about a lens slot withholds CAP-11 only.
  const contradiction = (slot: string, text: string) => (poolSet.has(slot) ? both : lensProblems).push(text)

  for (const [name, ids] of [
    ["pool", pool],
    ["lens", lensIds],
  ] as const) {
    const repeated = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]
    if (repeated.length > 0) both.push(`the roster's ${name} slot ids are not unique: ${quoted(repeated)}`)
  }
  const shared = pool.filter((id) => lensSet.has(id))
  if (shared.length > 0) both.push(`the roster's pool and lens slot ids are not disjoint: ${quoted(new Set(shared))}`)
  const known = new Set([...pool, ...lensIds])
  const unknownSkipped = record.skippedForBudget.filter((id) => !known.has(id))
  if (unknownSkipped.length > 0) {
    both.push(`\`skippedForBudget\` names ${quoted(unknownSkipped)}, which the roster does not hold (roster slots: ${quoted(known)})`)
  }
  const skipped = new Set(record.skippedForBudget.filter((id) => known.has(id)))
  const repeatedSkips = record.skippedForBudget.filter((id, index) => record.skippedForBudget.indexOf(id) !== index)
  for (const slot of new Set(repeatedSkips)) contradiction(slot, `\`skippedForBudget\` names \`${slot}\` more than once`)

  const dropped = new Map<string, string>()
  const salvaged = new Map<string, string>()
  const dropCounts = new Map<string, number>()
  for (const warning of record.warnings) {
    if (warning.stage !== "discover") continue
    if (warning.code !== "model-dropped-out" && warning.code !== "partial-envelope") continue
    const slot = warning.detail?.slot
    if (typeof slot !== "string") {
      both.push(`a discover-stage \`${warning.code}\` warning carries no string \`detail.slot\``)
      continue
    }
    if (!known.has(slot)) {
      both.push(`a discover-stage \`${warning.code}\` warning names slot \`${slot}\`, which the roster does not hold`)
      continue
    }
    if (warning.code === "model-dropped-out") {
      dropCounts.set(slot, (dropCounts.get(slot) ?? 0) + 1)
      dropped.set(slot, `\`model-dropped-out\` (failure: ${fieldText(warning.detail?.failure)})`)
    } else {
      const kept = warning.detail?.kept
      const lost = warning.detail?.dropped
      salvaged.set(
        slot,
        `salvaged answer — \`partial-envelope\`: ${typeof kept === "number" ? kept : "?"} finding(s) kept, ` +
          `${typeof lost === "number" ? lost : "?"} dropped for failing schema validation`,
      )
    }
  }
  for (const [slot, count] of dropCounts) {
    if (count > 1) contradiction(slot, `slot \`${slot}\` carries ${count} discover-stage \`model-dropped-out\` warnings`)
  }
  for (const slot of dropped.keys()) {
    if (skipped.has(slot)) {
      contradiction(slot, `slot \`${slot}\` is both \`model-dropped-out\` and in \`skippedForBudget\``)
    }
  }
  for (const slot of salvaged.keys()) {
    if (dropped.has(slot)) contradiction(slot, `slot \`${slot}\` is both \`model-dropped-out\` and a \`partial-envelope\` answer`)
    if (skipped.has(slot)) contradiction(slot, `slot \`${slot}\` is both in \`skippedForBudget\` and a \`partial-envelope\` answer`)
  }

  const answeredPool = pool.filter((id) => !dropped.has(id) && !skipped.has(id))
  const answeredLens = lens.filter((slot) => !dropped.has(slot.slot) && !skipped.has(slot.slot))
  if (answeredPool.length !== record.answered) {
    both.push(
      `the derived answered pool slots [${quoted(answeredPool)}] number ${answeredPool.length}, but ` +
        `\`record.answered\` is ${record.answered}`,
    )
  }

  const answeredPoolSet = new Set(answeredPool)
  const answeredLensSet = new Set(answeredLens.map((slot) => slot.slot))
  const poolStrays = new Map<string, string[]>()
  const lensByPoolSlot = new Map<string, string[]>()
  const lensStrays = new Map<string, string[]>()
  const add = (map: Map<string, string[]>, author: string, id: string) => map.set(author, [...(map.get(author) ?? []), id])
  for (const finding of record.pool) {
    if (finding.source === "pool" && !answeredPoolSet.has(finding.author)) add(poolStrays, finding.author, finding.id)
    if (finding.source === "lens" && poolSet.has(finding.author)) add(lensByPoolSlot, finding.author, finding.id)
    else if (finding.source === "lens" && !answeredLensSet.has(finding.author)) add(lensStrays, finding.author, finding.id)
  }
  for (const [author, ids] of poolStrays) {
    both.push(
      `pool finding(s) ${quoted(ids)} name author \`${author}\`, which is not an answered pool slot ` +
        `(answered pool slots: ${quoted(answeredPool)})`,
    )
  }
  for (const [author, ids] of lensByPoolSlot) {
    both.push(`lens finding(s) ${quoted(ids)} name author \`${author}\`, which is a POOL slot`)
  }
  for (const [author, ids] of lensStrays) {
    lensProblems.push(
      `lens finding(s) ${quoted(ids)} name author \`${author}\`, which is not an answered lens slot ` +
        `(answered lens slots: ${quoted(answeredLens.map((slot) => slot.slot))})`,
    )
  }

  const count = (slot: string) => record.pool.filter((finding) => finding.author === slot).length
  const stateOf = (slot: string): Pick<SlotAccount, "state" | "note"> => {
    if (dropped.has(slot)) return { state: "dropped", note: dropped.get(slot)! }
    if (skipped.has(slot)) return { state: "skipped-for-budget", note: "`skippedForBudget`: the budget refused its turn" }
    const note = salvaged.get(slot)
    return { state: "answered", ...(note === undefined ? {} : { note }) }
  }
  const slots: SlotAccount[] = [
    ...pool.map((slot) => ({ slot, kind: "pool" as const, ...stateOf(slot), findings: count(slot) })),
    ...lens.map((slot) => {
      const state = stateOf(slot.slot)
      // A cancelled discovery turn leaves no drop-out and no skip entry, so a
      // lens slot of a record cancelled at `discover` has no knowable state.
      const unknown = record.cancelled?.stage === "discover" && state.state === "answered"
      return {
        slot: slot.slot,
        kind: "lens" as const,
        lens: slot.lens,
        ...(unknown
          ? { state: "unknown" as const, note: "the record was cancelled at `discover`, which leaves no trace of a cancelled slot" }
          : state),
        findings: count(slot.slot),
      }
    }),
  ]

  return {
    slots,
    answeredPool,
    answeredLens,
    poolSlots: pool.length,
    lensSlots: lens.length,
    both,
    lensOnly: lensProblems,
  }
}

// ---------------------------------------------------------------------------
// CAP-1 and CAP-11
// ---------------------------------------------------------------------------

function foundCount(defects: readonly SeededDefect[], findings: readonly Finding[], matcher: DefectMatcher): DefectCount {
  const missed = new Set(missedDefects(defects, findings, matcher).map((defect) => defect.id))
  const ids = defects.filter((defect) => !missed.has(defect.id)).map((defect) => defect.id)
  return { found: ids.length, total: defects.length, ids }
}

function measureCap1(record: PrefixRecord, identity: SlotIdentity, matcher: DefectMatcher): Cap1Result {
  if (identity.both.length > 0) return { kind: "unavailable", reasons: [...identity.both] }
  if (identity.answeredPool.length === 0) {
    return {
      kind: "unavailable",
      reasons: [
        `no pool slot answered (0 of ${identity.poolSlots}), so there is no best member and no comparison — not a zero best`,
      ],
    }
  }
  try {
    const pool = pooledOnly(record.pool)
    const comparison = pooledRecallBeatsBestMember(SEEDED_DEFECTS, pool, matcher, identity.answeredPool)
    const pooled = foundCount(SEEDED_DEFECTS, pool, matcher)
    if (pooled.found !== comparison.pooled.found) {
      return { kind: "unavailable", reasons: ["the matcher gave two different pooled counts over one pool"] }
    }
    const members = identity.answeredPool.map((slot) => ({
      slot,
      ...foundCount(
        SEEDED_DEFECTS,
        pool.filter((finding) => finding.author === slot),
        matcher,
      ),
    }))
    const bestFound = Math.max(...members.map((member) => member.found))
    return {
      kind: "measured",
      pooled,
      members,
      best: {
        slots: members.filter((member) => member.found === bestFound).map((member) => member.slot),
        found: bestFound,
        total: SEEDED_DEFECTS.length,
      },
      difference: pooled.found - bestFound,
      pool: { answered: identity.answeredPool.length, of: identity.poolSlots },
      complete: identity.answeredPool.length === identity.poolSlots,
    }
  } catch (error) {
    return { kind: "unavailable", reasons: [`scoring failed: ${messageOf(error)}`] }
  }
}

function measureCap11(record: PrefixRecord, identity: SlotIdentity, matcher: DefectMatcher): Cap11Result {
  if (identity.both.length > 0 || identity.lensOnly.length > 0) {
    return { kind: "unavailable", reasons: [...identity.both, ...identity.lensOnly] }
  }
  if (record.cancelled?.stage === "discover") {
    return {
      kind: "unavailable",
      reasons: [
        "the prefix record was cancelled at `discover`, and a cancelled slot leaves no drop-out or skip entry, so lens " +
          "coverage is unknown and CAP-11 is withheld",
      ],
    }
  }
  if (identity.lensSlots === 0) {
    return { kind: "unavailable", reasons: ["the sealed roster has no lens slot (`lensSlots` is empty)"] }
  }
  if (identity.poolSlots === 0) {
    return { kind: "unavailable", reasons: ["the sealed roster has no pool slot, so CAP-11 has no baseline"] }
  }
  if (identity.answeredPool.length === 0) {
    return {
      kind: "unavailable",
      reasons: [`no pool slot answered (0 of ${identity.poolSlots}), so CAP-11 has no baseline`],
    }
  }
  if (identity.answeredLens.length === 0) {
    return { kind: "unavailable", reasons: [`no lens slot answered (0 of ${identity.lensSlots})`] }
  }
  try {
    const pool = pooledOnly(record.pool)
    const lens = lensOnly(record.pool)
    const gain = lensRecallGain(SEEDED_DEFECTS, [...pool, ...lens], matcher)
    const perLens = identity.answeredLens.map((slot) => {
      const own = lens.filter((finding) => finding.author === slot.slot)
      const mine = lensRecallGain(SEEDED_DEFECTS, [...pool, ...own], matcher)
      return {
        slot: slot.slot,
        lens: slot.lens,
        ...foundCount(SEEDED_DEFECTS, own, matcher),
        lensOnlyIds: mine.lensOnlyDefects.map((defect) => defect.id),
      }
    })
    return {
      kind: "measured",
      lensOnly: {
        found: gain.lensOnlyDefects.length,
        total: SEEDED_DEFECTS.length,
        ids: gain.lensOnlyDefects.map((defect) => defect.id),
      },
      perLens,
      lens: { answered: identity.answeredLens.length, of: identity.lensSlots },
      pool: { answered: identity.answeredPool.length, of: identity.poolSlots },
      complete: identity.answeredLens.length === identity.lensSlots && identity.answeredPool.length === identity.poolSlots,
    }
  } catch (error) {
    return { kind: "unavailable", reasons: [`scoring failed: ${messageOf(error)}`] }
  }
}

// ---------------------------------------------------------------------------
// Each arm's upheld findings
// ---------------------------------------------------------------------------

function readArms(block: PairedBlock, matcher: DefectMatcher): ArmLabelRead[] {
  return block.arms.map((arm) => {
    const identity = arm.row.manifest.identity
    const base = {
      arm: arm.arm,
      position: arm.position,
      runId: arm.row.manifest.run.runId,
      protocolVersion: fieldText(identity.protocolVersion),
      protocolHash: fieldText(identity.protocolHash),
    }
    if (block.result.kind === "withheld") {
      return {
        ...base,
        result: { kind: "unavailable" as const, reason: `the paired block is withheld: ${block.result.reasons.join("; ")}` },
      }
    }
    const upheld = arm.row.findings.filter((finding) => verdictState(finding) === "upheld")
    for (const finding of upheld) {
      const problem = findingProblem(finding)
      if (problem !== null) {
        return {
          ...base,
          result: { kind: "unavailable" as const, reason: `upheld finding \`${fieldText(finding.id)}\` ${problem}` },
        }
      }
    }
    try {
      const partition = adjudicate(SEEDED_DEFECTS, upheld, matcher)
      return {
        ...base,
        result: {
          kind: "measured" as const,
          upheld: upheld.length,
          matches: partition.matched.map((match) => ({ defectId: match.defectId, findingId: match.finding.id })),
          unlabelled: partition.unlabelled.map((finding) => finding.id),
        },
      }
    } catch (error) {
      return { ...base, result: { kind: "unavailable" as const, reason: `scoring failed: ${messageOf(error)}` } }
    }
  })
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

function summarize(blocks: readonly LabelledBlock[]): LabelledSummary[] {
  return LABELLED_QUANTITIES.map((quantity) => {
    const missing: { block: number; reason: string }[] = []
    const values: number[] = []
    const prefixesSeen = new Map<string, number>()
    for (const number of PAIRED_BLOCKS) {
      const block = blocks.find((entry) => entry.block === number)
      if (block === undefined) {
        missing.push({ block: number, reason: `the paired reader returned no block ${number}` })
        continue
      }
      const observation = observe(block, quantity)
      if (typeof observation === "string") {
        missing.push({ block: number, reason: observation })
        continue
      }
      // Defensive: the two arms of a block already share one prefix observation,
      // and two blocks naming one prefix run must not count it twice.
      if (quantity.source === "prefix" && block.record.kind === "read") {
        const earlier = prefixesSeen.get(block.record.prefixRunId)
        if (earlier !== undefined) {
          missing.push({
            block: number,
            reason: `it reads prefix \`${block.record.prefixRunId}\`, which block ${earlier} already supplied; a shared prefix is one observation`,
          })
          continue
        }
        prefixesSeen.set(block.record.prefixRunId, number)
      }
      values.push(observation)
    }
    return { quantity: quantity.label, observed: values.length, of: PAIRED_BLOCKS.length, missing, values }
  })
}

/** One block's value for one quantity, or why it has none. */
function observe(block: LabelledBlock, quantity: (typeof LABELLED_QUANTITIES)[number]): number | string {
  if (quantity.source === "arm") {
    const arm = block.arms.find((entry) => entry.arm === quantity.arm)
    if (arm === undefined) return `this block bound no \`${quantity.arm}\` arm`
    if (arm.result.kind === "unavailable") return arm.result.reason
    return quantity.field === "matches" ? arm.result.matches.length : arm.result.unlabelled.length
  }
  if (quantity.field === "lens-only") {
    const cap11 = block.cap11
    if (cap11.kind === "unavailable") return cap11.reasons.join("; ")
    if (!cap11.complete) {
      return (
        `partial diagnostic outside the planned summary: pool coverage ${countText(cap11.pool.answered, cap11.pool.of)}, ` +
        `lens coverage ${countText(cap11.lens.answered, cap11.lens.of)} answered`
      )
    }
    return cap11.lensOnly.found
  }
  const cap1 = block.cap1
  if (cap1.kind === "unavailable") return cap1.reasons.join("; ")
  if (!cap1.complete) {
    return `partial diagnostic outside the planned summary: pool coverage ${countText(cap1.pool.answered, cap1.pool.of)} answered`
  }
  if (quantity.field === "pool-union") return cap1.pooled.found
  if (quantity.field === "best-member") return cap1.best.found
  return cap1.difference
}

/** An exact mean: an integer, or a reduced ratio of integers. Never a float. */
function meanText(values: readonly number[]): string {
  const sum = values.reduce((total, value) => total + value, 0)
  const n = values.length
  if (sum % n === 0) return String(sum / n)
  const divisor = gcd(sum, n)
  return `${sum / divisor}/${n / divisor}`
}

function gcd(a: number, b: number): number {
  return b === 0 ? Math.abs(a) : gcd(b, a % b)
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const ESTIMANDS = [
  "ESTIMANDS — beside every number below",
  "  CAP-1 is WITHIN-PREFIX ATTRIBUTION: the union of the answered pool slots' findings against the best single",
  "  answered pool slot of the SAME discovery pass. It is not an independently executed single-model run.",
  "  CAP-11 is the planted defects answered lens slots raised that NO answered pool slot raised in that pass.",
  "  It is not a causal run effect. Both are nonnegative by construction and say nothing about precision.",
  "",
]

/** `observed` is how many quantities have a complete observation, or `null` when the report is refused. */
function statusLines(observed: { quantities: number; of: number } | null): string[] {
  const measurements =
    observed === null
      ? "measurements: none read — this report is refused"
      : observed.quantities === 0
        ? "measurements: pending — no quantity has a complete observation in this bundle"
        : `measurements: ${observed.quantities} of ${observed.of} quantities have at least one complete observation in this bundle`
  return [
    "STATUS, STATED SEPARATELY",
    `  implementation: complete (\`${LABELLED_READER_MODULE}\`)`,
    `  protocol v2: a DRAFT that pre-registers nothing (\`${PROTOCOL_V2_DRAFT}\`); it proposes CAP-1 and CAP-11 as ` +
      "secondary descriptive endpoints",
    `  ${measurements}`,
    "",
  ]
}

function protocolLines(schedule: ScheduleProtocol, protocol: readonly ProtocolIdentity[]): string[] {
  const lines = [
    "PROTOCOL IDENTITY, AS EACH FILE RECORDS IT",
    `  this bundle's schedule was sealed under protocol ${schedule.id} v${schedule.version} (${schedule.hash})`,
  ]
  for (const entry of protocol) lines.push(`  ${entry.subject}: protocolVersion ${entry.version}, protocolHash ${entry.hash}`)
  lines.push(
    "  Every number this reader prints is DESCRIPTIVE. No number here is v2-preregistered, because v2 is a draft.",
    "",
  )
  return lines
}

function exclusionLines(excluded: readonly LabelledExclusion[]): string[] {
  if (excluded.length === 0) return []
  const lines = ["ARMS THE PAIRED READER DID NOT BIND — out of this report, and refusing nothing"]
  for (const entry of excluded) lines.push(`  ${entry.armId}/${entry.repeatId} — ${entry.reason}`)
  lines.push("")
  return lines
}

export function renderLabelledBundle(outcome: LabelledReadOutcome): string {
  if (outcome.kind === "not-applicable") return ""
  if (outcome.kind === "schedule-refused") {
    return (
      "MAD LABELLED RECALL — NOT READ: the paired reader refused the sealed schedule, and that refusal stands.\n" +
      `  ${outcome.reason}\n`
    )
  }
  const lines: string[] = []
  if (outcome.kind === "refused") {
    lines.push(
      `MAD LABELLED RECALL — ${outcome.root}`,
      "",
      "REFUSED: THIS BUNDLE IS NOT THE SEALED LABELLED CHANGE. No CAP-1, CAP-11 or planted-label number is computed.",
    )
    for (const problem of outcome.problems) {
      lines.push(`  ${problem.subject}: \`${problem.field}\` is ${problem.actual}, and this report requires ${problem.expected}`)
    }
    lines.push("  The paired report above is unchanged by this refusal.", "")
    lines.push(...statusLines(null), ...protocolLines(outcome.schedule, outcome.protocol), ...exclusionLines(outcome.excluded))
    return `${lines.join("\n")}\n`
  }

  lines.push(
    `MAD LABELLED RECALL — ${outcome.root}`,
    `labelled change ${outcome.seal.version} (material ${outcome.seal.materialHash}); the schedule's fixture and every ` +
      "bound arm's `identity.fixtureHash` match it",
    "",
  )
  const observed = outcome.summaries.filter((summary) => summary.observed > 0).length
  lines.push(
    ...statusLines({ quantities: observed, of: outcome.summaries.length }),
    ...protocolLines(outcome.schedule, outcome.protocol),
    ...exclusionLines(outcome.excluded),
    ...ESTIMANDS,
  )

  lines.push("SUMMARY — separately per quantity, over complete observations only")
  for (const summary of outcome.summaries) {
    lines.push(`  ${summary.quantity}: observed ${summary.observed}/${summary.of}`)
    for (const gap of summary.missing) lines.push(`    block ${gap.block} missing — ${gap.reason}`)
    if (summary.values.length === 0) {
      lines.push("    unavailable — no complete observation")
    } else if (summary.values.length === 1) {
      lines.push(`    value ${summary.values[0]}; spread unavailable`)
    } else {
      lines.push(
        `    mean ${meanText(summary.values)}, min ${Math.min(...summary.values)}, max ${Math.max(...summary.values)} — ` +
          `descriptive over ${summary.values.length} available observations, not the planned three-block result`,
      )
    }
  }
  lines.push("")

  for (const block of outcome.blocks) lines.push(...renderBlock(block))

  lines.push(
    "WHAT THIS REPORT DOES NOT MEASURE. U is not a truth label: an upheld finding no planted label claimed is",
    `unlabelled, never a false positive. False positives: ${FALSE_POSITIVES_TEXT}, which also owns`,
    "verdict-direction labels. Precision and cost contrasts belong to story 2.8. Nothing here is a product-value claim.",
  )
  return `${lines.join("\n")}\n`
}

function renderBlock(block: LabelledBlock): string[] {
  const lines = [`BLOCK ${block.block}`]
  const record = block.record
  if (record.kind !== "read") {
    lines.push(`  PREFIX RECORD ${record.kind.toUpperCase()}:`)
    for (const reason of record.reasons) lines.push(`    ${reason}`)
  } else {
    lines.push(`  prefix run \`${record.prefixRunId}\`, record \`${record.file}\``)
    if (record.cancelledAt !== undefined) lines.push(`  the prefix record was cancelled at \`${record.cancelledAt}\``)
    for (const slot of record.slots) {
      const lens = slot.lens === undefined ? "" : ` lens \`${slot.lens}\``
      const note = slot.note === undefined ? "" : ` — ${slot.note}`
      const state = slot.state === "answered" ? "answered" : `UNANSWERED (${slot.state})`
      lines.push(`  ${slot.kind} slot \`${slot.slot}\`${lens}: ${state}, ${slot.findings} finding(s)${note}`)
    }
  }

  const cap1 = block.cap1
  if (cap1.kind === "unavailable") {
    lines.push("  CAP-1: WITHHELD")
    for (const reason of cap1.reasons) lines.push(`    ${reason}`)
  } else {
    lines.push(
      `  CAP-1 (within-prefix attribution), pool coverage ${countText(cap1.pool.answered, cap1.pool.of)} answered` +
        (cap1.complete ? "" : " — PARTIAL DIAGNOSTIC, outside the planned summary"),
      `    pool union: ${countText(cap1.pooled.found, cap1.pooled.total)}${idsText(cap1.pooled.ids)}`,
    )
    for (const member of cap1.members) {
      lines.push(`    answered pool slot \`${member.slot}\`: ${countText(member.found, member.total)}${idsText(member.ids)}`)
    }
    lines.push(
      `    best answered pool slot: ${cap1.best.slots.map((slot) => `\`${slot}\``).join(", ")} with ` +
        `${countText(cap1.best.found, cap1.best.total)}${cap1.best.slots.length > 1 ? " (tied)" : ""}`,
      `    union minus best: ${cap1.difference}`,
    )
  }

  const cap11 = block.cap11
  if (cap11.kind === "unavailable") {
    lines.push("  CAP-11: UNAVAILABLE")
    for (const reason of cap11.reasons) lines.push(`    ${reason}`)
  } else {
    lines.push(
      `  CAP-11 (lens-only defects), over ${countText(cap11.lens.answered, cap11.lens.of)} lens slots answered, pool ` +
        `coverage ${countText(cap11.pool.answered, cap11.pool.of)}` +
        (cap11.complete ? "" : " — PARTIAL DIAGNOSTIC, outside the planned summary"),
      `    lens-only defects: ${countText(cap11.lensOnly.found, cap11.lensOnly.total)}${idsText(cap11.lensOnly.ids)}`,
    )
    if (cap11.lens.answered < cap11.lens.of) {
      lines.push(`    a zero here describes only the ${cap11.lens.answered} answered lens slot(s)`)
    }
    for (const lens of cap11.perLens) {
      lines.push(
        `    lens slot \`${lens.slot}\` (\`${lens.lens}\`): ${countText(lens.found, lens.total)}${idsText(lens.ids)}; ` +
          `lens-only ${lens.lensOnlyIds.length}${idsText(lens.lensOnlyIds)}`,
      )
    }
  }

  lines.push("  UPHELD FINDINGS PER ARM — planted-label matches and U, separately, never a truth labelling")
  if (block.arms.length === 0) lines.push("    this block bound no arm")
  for (const arm of block.arms) {
    const head = `    arm ${arm.arm} (${arm.position}), run \`${arm.runId}\`, protocolVersion ${arm.protocolVersion}`
    if (arm.result.kind === "unavailable") {
      lines.push(`${head}: UNAVAILABLE — ${arm.result.reason}`)
      continue
    }
    const result = arm.result
    lines.push(
      `${head}: ${result.upheld} upheld finding(s)`,
      `      planted-label matches: ${countText(result.matches.length, result.upheld)}` +
        (result.matches.length === 0 ? "" : ` (${result.matches.map((match) => `\`${match.defectId}\``).join(", ")})`),
      `      U (no planted label claimed it, unmatched duplicates included): ${countText(result.unlabelled.length, result.upheld)}`,
      `      false positives: ${FALSE_POSITIVES_TEXT}`,
    )
  }
  lines.push("")
  return lines
}

function idsText(ids: readonly string[]): string {
  return ids.length === 0 ? "" : ` (${ids.map((id) => `\`${id}\``).join(", ")})`
}

// ---------------------------------------------------------------------------
// Small shared checks
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
