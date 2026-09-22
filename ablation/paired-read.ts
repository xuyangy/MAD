/**
 * FR8 (story 2-5d) — THE PAIRED READER.
 *
 * Story 2-5c writes a paired bundle: a sealed schedule, six arm manifests each
 * carrying an `experiment` block, one prefix evidence file per block, and a slot
 * status line per planned slot. Nothing read any of it as PAIRS. `readBundle`
 * never dereferenced `manifest.experiment`, and `renderBundle` closed by saying
 * no finding had been compared across arms — which was true, and was the whole
 * of what the evaluation could report.
 *
 * This module reads it. It bills nothing, runs no model, and calls neither
 * `runPairedBlocks` nor `createSchedule` nor `verifySchedule`.
 *
 * ## THE COHORT IS THE PREFIX, AND IT IS NOT A FIFTH COMPARABILITY FIELD
 *
 * `read-bundle.ts`'s cohort is a PLURALITY over four fields, and a tie yields no
 * cohort at all. Adding `prefixRunId` to `COMPARABILITY_FIELDS` would split six
 * paired arms into three groups of two, tie three ways, and leave `readBundle`
 * with no cohort and no table. So the four-field cohort stays exactly as it is —
 * it answers *did these arms review the same thing?* — and the BLOCK cohort
 * lives here, one level above it: the arm rows of one block that name one
 * `experiment.prefixRunId`, which each row's `run.forkedFrom` must equal,
 * exactly two of them, one `on` and one `off`, both finished, over a prefix that
 * says it forked. Anything else is kept, named, and excluded with its reason.
 *
 * ## PAIRING IS A JOIN ON `Finding.id`, AND NO ALIGNER TOUCHES IT
 *
 * Within a block, discovery runs ONCE and `forkPreparedReview` clones one
 * prepared review, so `cloneCheckpoint`'s `structuredClone` carries every
 * `Finding.id` into both arms unchanged (`core/run/review.ts`). The two arms
 * therefore join directly and `alignArms` is not used
 * (`evaluation-protocol.md:116-119`) — the matcher's measured error would enter
 * a difference count that has no matching error in it.
 *
 * THE IDS ARE COMPARABLE ONLY WITHIN ONE BLOCK. Across blocks discovery is
 * re-sampled from different clocks, so an equal id string in block 1 and block 3
 * names two different candidates. Blocks are joined independently and never
 * pooled; a cross-block id match is never a pair. That is the collision
 * `ablation/align.ts` namespaces `armId::originalId` against, met here by never
 * crossing the boundary in the first place.
 *
 * ## WHAT IT REPORTS, AND WHAT IT REFUSES TO
 *
 * Label-free quantities only: paired candidates, verdict-state differences as
 * `differing of n`, undecided transitions counted on their own, `only in` counts
 * per arm, and the treatment opportunity READ from the OFF arm's own
 * `status.routeCounts.intervention` (`RouteCounts` in
 * `core/domain/run-record.ts`) rather than re-derived. The four labelled verdict
 * transitions and the per-arm false positives need truth labels, so they are
 * `ablation/adjudication-read.ts`'s, read from the human truth sheet bound to
 * this bundle's schedule and prefix runs. `differences` below says only THAT two
 * arms decided a candidate differently; which way, and whether that was the
 * right way, is that reader's. Precision, recall and every earned /
 * did-not-earn reading belong to story 2.8.
 *
 * Every rate names its numerator and its denominator as `x of y`. There is no
 * float, no percentage and no fused score, and a zero denominator reads
 * `not measurable (0 cases)` and never `0 of 0`.
 *
 * AVAILABILITY IS `n/3` PER QUANTITY, AND A ZERO DENOMINATOR IS NOT AVAILABLE.
 * A block whose two arms share no candidate id yields no verdict-state
 * difference, and counting it as available published `3/3` over three block
 * bodies that each read `not measurable (0 cases)` — an availability table
 * disagreeing with every result under it. Each quantity is judged on ITS OWN
 * denominator, so a block can supply four of them and not the fifth.
 *
 * ## FAILURES STAY PER-ARM AND PER-BLOCK
 *
 * Every entry point returns a typed result and nothing throws. A refused block
 * keeps its reason and never voids the others, and a refused schedule still
 * lists the arms and still folds the slot file — `paired-slots.jsonl` is written
 * independently of the schedule, so what it records survives the schedule's
 * refusal and is the only account left of what was attempted.
 *
 * AD-1: this tree may import from `core/`. Nothing under `core/` imports it.
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"

import type { Finding } from "../core/domain/finding.ts"
import { armDirectory, PREFIX_DIRECTORY, PREFIX_EVIDENCE_VERSION, PREFIX_FILE, type PrefixEvidence } from "./bundle.ts"
import { decided, verdictState, type VerdictState } from "./compare.ts"
import { countText } from "./cross-arm-rates.ts"
import { HALT_MARKER_FILE } from "./governor.ts"
import type { Completion, ExperimentBinding, Maybe, RunManifest } from "./manifest.ts"
import { disclosures, readBundle, type ArmRow, type BundleReadOutcome, type BundleReadResult } from "./read-bundle.ts"
import { ADJUDICATION_READER_MODULE, INHERITED_SUM_RULE, LABELLED_READER_MODULE } from "./report.ts"
import {
  PAIRED_BLOCKS,
  readSchedule,
  readSlotStatuses,
  SLOT_STATUS_FILE,
  type Arm,
  type ArmPosition,
  type PairedSchedule,
  type ScheduleRead,
  type SlotStatus,
  type SlotStatusLine,
} from "./schedule.ts"

// ---------------------------------------------------------------------------
// What the reader produces
// ---------------------------------------------------------------------------

/**
 * The five quantities availability is tracked for, SEPARATELY.
 *
 * One `n/3` for the whole report would be a lie in both directions: a block that
 * paired its candidates but whose OFF arm never routed yields four of these and
 * not the fifth, and a single figure would either hide the gap or discard the
 * four.
 */
export const PAIRED_QUANTITIES = [
  "paired candidates",
  "verdict-state differences",
  "undecided transitions",
  "only-in counts",
  "treatment opportunity",
] as const
export type PairedQuantity = (typeof PAIRED_QUANTITIES)[number]

/** One slot the evaluation planned, named before anything is known about it. */
export interface SlotPlan {
  block: number
  arm: Arm
  /** The sealed position, or `unknown` when no readable schedule says. */
  position: ArmPosition | "unknown"
}

/** One planned slot, folded to ONE terminal status and reason. */
export interface SlotReport extends SlotPlan {
  /**
   * The terminal status the slot's lines fold to, or why it has none.
   * `unfinished` is a slot that started and never recorded how it ended;
   * `unrecorded` is a slot with no line at all.
   */
  status: SlotStatus | "unfinished" | "unrecorded"
  reason: string
  /** How many well-formed status lines the file carried for this slot. */
  lines: number
  /** The run id the terminal line named, when it named one. */
  runId?: string
}

/**
 * A line of `paired-slots.jsonl` that parsed as JSON and is not a slot status.
 *
 * COUNTED AND NAMED, NEVER DROPPED. Silently discarding it made every slot it
 * should have covered report `carries lines, but none for this planned slot`,
 * which names the wrong cause: the file DID carry that slot's line, and this
 * reader could not read it.
 */
export interface MalformedSlotLine {
  /** 1-based line number in the file. */
  line: number
  reason: string
}

/** One block's `prefix/<block-1>/prefix.json`, read and cross-checked. */
export interface PrefixReport {
  block: number
  file: string
  evidence: PrefixEvidence | null
  /** The reason this evidence does not support a paired result, or `null`. */
  problem: string | null
}

/** One arm of a block, bound to its planned slot. */
export interface PairedArm {
  arm: Arm
  position: ArmPosition
  row: ArmRow
  experiment: ExperimentBinding
}

/** An arm kept, named, and out of every pair. */
export interface ExcludedArm {
  armId: string
  repeatId: number
  /** The block its slot implies, or `null` when nothing implies one. */
  block: number | null
  reason: string
}

/** The label-free contrast between the two arms of one block. */
export interface BlockDifference {
  /** Candidate ids raised in BOTH arms. The join. */
  paired: number
  /** Distinct candidate ids across the two arms — the denominator for `onlyIn`. */
  distinct: number
  /** Paired candidates whose two sides carry DIFFERENT decisions. */
  differing: number
  /** The denominator for `differing`: paired candidates where BOTH sides decided. */
  of: number
  /** Paired candidates where at least one side was undecided. In neither half. */
  undecided: number
  /** Candidates only one arm raised. Never in the `differing` denominator. */
  onlyIn: { on: number; off: number }
  /** The differing pairs, for a report that wants to name them. */
  differences: { id: string; on: VerdictState; off: VerdictState }[]
}

/** One arm's own counts, all of them label-free. */
export interface ArmSummary {
  arm: Arm
  runId: string
  position: ArmPosition
  completion: Completion
  canonical: number
  upheld: number
  unresolved: number
  unjudged: number
}

/** `status.routeCounts.intervention`, read and never re-derived. */
export type TreatmentOpportunity =
  | { kind: "known"; toJudge: number; wouldHaveDebated: number }
  | { kind: "unknown"; why: string }

export interface BlockMeasurement {
  kind: "measured"
  prefixRunId: string
  difference: BlockDifference
  arms: ArmSummary[]
  treatment: TreatmentOpportunity
}

export interface BlockWithheld {
  kind: "withheld"
  /** Every reason this block yields no paired quantity. All of them, not the first. */
  reasons: string[]
}

export interface PairedBlock {
  block: number
  /** The two slots planned for this block, in order. */
  planned: SlotPlan[]
  /** The arms that bound to this block, in the schedule's order. */
  arms: PairedArm[]
  excluded: ExcludedArm[]
  prefix: PrefixReport
  result: BlockMeasurement | BlockWithheld
  /** Each arm's prefix, named, and whether the inherited-sum rule is offered. */
  inheritedSum: { offered: boolean; prefixes: string[]; why: string }
}

export interface Availability {
  quantity: PairedQuantity
  available: number
  of: number
  missing: { block: number; reason: string }[]
}

/**
 * The halt at the bundle root, as THREE states.
 *
 * `halted` and `none` are the two the marker answers directly. `unestablished`
 * is the third and it is not either of them: a read that failed with anything
 * but `ENOENT` leaves the question open, and folding it into `halted` printed a
 * banner asserting a halt above a line saying the halt could not be established,
 * while folding it into `none` would assert there is no halt on the strength of
 * not having looked.
 */
export type HaltReport =
  | { kind: "none" }
  | { kind: "halted"; file: string; reason: string }
  | { kind: "unestablished"; file: string; reason: string }

export interface PairedReadResult {
  root: string
  bundle: BundleReadResult
  schedule: ScheduleRead
  halt: HaltReport
  /** All six planned slots, ALWAYS — the slot file does not depend on the schedule. */
  slots: SlotReport[]
  malformedSlotLines: MalformedSlotLine[]
  blocks: PairedBlock[]
  availability: Availability[]
  /**
   * Excluded arms whose slot implies NO block, so no block's listing names them.
   * Every other excluded arm is on its own block's `excluded`; `allExcluded`
   * returns both together.
   */
  unbound: ExcludedArm[]
}

export type PairedReadOutcome = PairedReadResult | { error: string }

/**
 * Reads this caller already has, so one invocation opens one file once.
 *
 * `scripts/eval-read.ts` renders the arm table before the paired report, so it
 * has already read the bundle and the schedule by the time it gets here. Without
 * this seam the paired reader read both again — the same bytes, parsed twice,
 * with a window in between in which they could differ, so the two reports could
 * describe two states of one directory.
 */
export interface PairedReadOptions {
  bundle?: BundleReadOutcome
  schedule?: ScheduleRead
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

/**
 * Read one paired bundle. The ONLY failure that stops it is the one that stops
 * `readBundle`: a bundle index that is missing or unreadable, without which no
 * arm can be named as absent. A refused schedule, a refused block and an
 * excluded arm are all reported, never thrown, and never fatal to each other.
 */
export async function readPairedBundle(root: string, options: PairedReadOptions = {}): Promise<PairedReadOutcome> {
  const bundle = options.bundle ?? (await readBundle(root))
  if ("error" in bundle) return { error: bundle.error }

  const halt = await readHalt(root)
  const schedule = options.schedule ?? (await readSchedule(root))

  // THE SLOT FILE IS FOLDED EITHER WAY. `paired-slots.jsonl` is appended by the
  // runner without consulting the schedule, so a schedule that does not verify
  // says nothing about what it recorded — and on a bundle whose schedule is
  // refused it is the ONLY account left of what was attempted. Without a
  // schedule the planned set falls back to the protocol's own three blocks by
  // two arms, and each slot's position reads `unknown` rather than being guessed.
  const planned = schedule.ok ? schedule.schedule.slots.map((slot) => ({ ...slot })) : fallbackPlan()
  const folded = await readSlots(root, planned)

  if (!schedule.ok) {
    // THE ARMS ARE STILL LISTED. A schedule that does not hash to itself refuses
    // the paired result as a whole, and a reader still has to be able to see what
    // ran — refusing the report outright would hide the evidence that the refusal
    // is about.
    return {
      root,
      bundle,
      schedule,
      halt,
      slots: folded.slots,
      malformedSlotLines: folded.malformed,
      blocks: [],
      availability: PAIRED_QUANTITIES.map((quantity) => ({
        quantity,
        available: 0,
        of: PAIRED_BLOCKS.length,
        missing: PAIRED_BLOCKS.map((block) => ({ block, reason: schedule.reason })),
      })),
      unbound: [
        // EVERY ARM THE BUNDLE LOADED, INCLUDING THE COMPARABLE ONES. They were
        // cross-checked against nothing, because there is no schedule to check
        // them against — which is a fact about the schedule, not about them, and
        // leaving them off the list would hide the evidence the refusal is about.
        ...bundle.comparable.map((row) => ({
          armId: row.armId,
          repeatId: row.repeatId,
          block: blockOfSlot(row.armId, row.repeatId),
          reason: "the sealed schedule is refused, so this arm was cross-checked against nothing",
        })),
        ...loadedExclusions(bundle),
        ...absentExclusions(bundle),
      ],
    }
  }

  const prefixes = new Map<number, PrefixReport>()
  for (const block of PAIRED_BLOCKS) {
    prefixes.set(block, await readPrefixEvidence(root, schedule.schedule, block))
  }

  // Every arm the four-field cohort admitted, cross-checked against the schedule
  // one at a time. A segregated, missing or unreadable arm never reaches this:
  // it is excluded with the reason `readBundle` already gave it.
  const bound = new Map<number, PairedArm[]>()
  const excluded: ExcludedArm[] = [...loadedExclusions(bundle), ...absentExclusions(bundle)]
  for (const row of bundle.comparable) {
    const outcome = bindArm(schedule.schedule, row)
    if (outcome.kind === "excluded") {
      excluded.push(outcome.excluded)
      continue
    }
    const list = bound.get(outcome.arm.experiment.block) ?? []
    list.push(outcome.arm)
    bound.set(outcome.arm.experiment.block, list)
  }

  const blocks = PAIRED_BLOCKS.map((block) =>
    buildBlock(block, planned, bound.get(block) ?? [], excluded, prefixes.get(block)!, folded.slots),
  )

  return {
    root,
    bundle,
    schedule,
    halt,
    slots: folded.slots,
    malformedSlotLines: folded.malformed,
    blocks,
    availability: availabilityOf(blocks),
    unbound: excluded.filter((entry) => entry.block === null),
  }
}

/** Every arm this reader kept out of a pair, block-attributed ones included. */
export function allExcluded(result: PairedReadResult): ExcludedArm[] {
  return [...result.blocks.flatMap((block) => block.excluded), ...result.unbound]
}

/** The three blocks by two arms the protocol fixes, with no schedule to order them. */
function fallbackPlan(): SlotPlan[] {
  return PAIRED_BLOCKS.flatMap((block) => [
    { block, arm: "on" as Arm, position: "unknown" as const },
    { block, arm: "off" as Arm, position: "unknown" as const },
  ])
}

/** The halt marker, and the reason it records. Never throws. */
async function readHalt(root: string): Promise<HaltReport> {
  const file = join(root, HALT_MARKER_FILE)
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" }
    return {
      kind: "unestablished",
      file,
      reason: `it could not be read (${messageOf(error)}), which is not evidence that it does not exist`,
    }
  }
  // THE PRESENCE IS THE SIGNAL, and the contents are the record. A marker this
  // reader cannot parse still halted the experiment, exactly as the experiment
  // governor's `admit` treats it (`ablation/governor.ts`).
  let recorded: unknown
  try {
    recorded = JSON.parse(text)
  } catch (error) {
    return { kind: "halted", file, reason: `the marker is present but did not parse (${messageOf(error)}); its presence is the halt` }
  }
  const reason = isRecord(recorded) ? recorded.haltReason : undefined
  const named =
    typeof reason === "string" && reason.trim().length > 0 ? reason : "the marker records no `haltReason`; its presence is the halt"
  // BOTH REASONS, WHERE THE MARKER HOLDS BOTH (story 2-7c). `haltReason` is
  // written once and never overwritten, so on a run where an accounting halt
  // landed first it names the money and only `operational` names the process or
  // the append nobody could account for. They need different recovery steps, and
  // a reader that showed the first and dropped the second would send an operator
  // to the wrong file. Absent on markers written before this story, and on every
  // ordinary run.
  const operational = isRecord(recorded) ? recorded.operational : undefined
  const extra = Array.isArray(operational) ? operational.filter((entry): entry is string => typeof entry === "string") : []
  return {
    kind: "halted",
    file,
    reason: extra.length === 0 ? named : `${named}; also ${extra.join("; also ")}`,
  }
}

/**
 * All six planned slots, each folded to ONE terminal status.
 *
 * `paired-slots.jsonl` is append-only and a slot's start and end are two lines,
 * so a status is a fold rather than a lookup. The LAST terminal line wins: an
 * invocation that recorded a second terminal status recorded it later, and
 * taking the first would report a slot by a status something later overwrote.
 * A slot with a start and no terminal line is `unfinished` and says so; a slot
 * with no line at all is `unrecorded`. Neither is quietly dropped, because a
 * planned slot the file forgot is the one a reader most needs named.
 */
async function readSlots(
  root: string,
  planned: readonly SlotPlan[],
): Promise<{ slots: SlotReport[]; malformed: MalformedSlotLine[] }> {
  const file = join(root, SLOT_STATUS_FILE)
  let read: SlotStatusLine[]
  try {
    read = await readSlotStatuses(root)
  } catch (error) {
    // A torn last line throws out of `JSON.parse`. Every planned slot is still
    // reported, with the reason none of them could be folded.
    const why = `\`${file}\` could not be read (${messageOf(error)})`
    return { slots: planned.map((slot) => ({ ...slot, status: "unrecorded" as const, reason: why, lines: 0 })), malformed: [] }
  }

  const lines: SlotStatusLine[] = []
  const malformed: MalformedSlotLine[] = []
  for (const [position, line] of read.entries()) {
    if (isSlotLine(line)) lines.push(line)
    else malformed.push({ line: position + 1, reason: "it parsed as JSON and is not a `{ block, arm, position, status, reason, at }` slot status" })
  }
  const unreadable =
    malformed.length === 0
      ? ""
      : `; ${malformed.length} line(s) in the file could not be read as slot statuses and cover no slot`

  const absent = read.length === 0
  return {
    slots: planned.map((slot) => {
      const mine = lines.filter((line) => line.block === slot.block && line.arm === slot.arm)
      const terminal = mine.filter((line) => line.status !== "started")
      const last = terminal[terminal.length - 1]
      if (last !== undefined) {
        const multiple =
          terminal.length > 1
            ? ` (${terminal.length} terminal lines; the LAST one stands, and the earlier one(s) read ${terminal
                .slice(0, -1)
                .map((line) => line.status)
                .join(", ")})`
            : ""
        return {
          ...slot,
          status: last.status,
          reason: `${last.reason}${multiple}`,
          lines: mine.length,
          ...(typeof last.runId === "string" ? { runId: last.runId } : {}),
        }
      }
      if (mine.length > 0) {
        return {
          ...slot,
          status: "unfinished" as const,
          reason:
            `\`${SLOT_STATUS_FILE}\` records this slot as started at ${mine[mine.length - 1]!.at} and carries no ` +
            `terminal line for it, so how it ended was never recorded${unreadable}`,
          lines: mine.length,
        }
      }
      return {
        ...slot,
        status: "unrecorded" as const,
        reason: absent
          ? `\`${file}\` carries no slot status lines at all, so this planned slot has none`
          : `\`${SLOT_STATUS_FILE}\` carries lines, but none this reader could read for this planned slot${unreadable}`,
        lines: 0,
      }
    }),
    malformed,
  }
}

/** A slot line whose every field this reader touches is what it claims to be. */
function isSlotLine(value: unknown): value is SlotStatusLine {
  if (!isRecord(value)) return false
  const statuses: SlotStatus[] = ["started", "completed", "cancelled", "failed", "not-attempted"]
  return (
    typeof value.block === "number" &&
    (value.arm === "on" || value.arm === "off") &&
    (value.position === "first" || value.position === "second") &&
    statuses.some((status) => status === value.status) &&
    typeof value.reason === "string" &&
    typeof value.at === "string"
  )
}

/**
 * One block's prefix evidence, parsed field by field and cross-checked against
 * the sealed schedule.
 *
 * `prefix.json` is what says the two arms of this block came from ONE forked
 * prefix, and THE FORK IS WHAT MAKES THE JOIN LEGITIMATE. So this file does not
 * only have to exist and be bound to the right schedule and block: it has to
 * record that the fork HAPPENED. A `forked: false` prefix, or one carrying a
 * `failure`, or one that minted no run id, describes two arms whose shared
 * discovery is exactly what did not happen — and printing `NOT forked` directly
 * above numbers justified by the fork is the report contradicting itself in
 * eight lines. Each of those withholds the block with its reason.
 *
 * `prefixEvidenceVersion` is compared before any other field, for the reason
 * `readSchedule` compares `scheduleVersion` first: a document whose shape this
 * reader does not know is refused for that, not for the first field it fails.
 */
async function readPrefixEvidence(root: string, schedule: PairedSchedule, block: number): Promise<PrefixReport> {
  const file = join(armDirectory(root, PREFIX_DIRECTORY, block - 1), PREFIX_FILE)
  const at = `its prefix evidence \`${file}\``
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, "utf8"))
  } catch (error) {
    return { block, file, evidence: null, problem: `${at} could not be read (${messageOf(error)})` }
  }
  if (!isRecord(raw)) return { block, file, evidence: null, problem: `${at} is not a JSON object` }
  if (raw.prefixEvidenceVersion !== PREFIX_EVIDENCE_VERSION) {
    return {
      block,
      file,
      evidence: null,
      problem: `${at} has prefix evidence version ${JSON.stringify(raw.prefixEvidenceVersion)}, and this reader knows ${PREFIX_EVIDENCE_VERSION}`,
    }
  }
  if (
    typeof raw.scheduleHash !== "string" ||
    typeof raw.block !== "number" ||
    typeof raw.forked !== "boolean" ||
    typeof raw.reason !== "string" ||
    !(raw.dump === null || typeof raw.dump === "string") ||
    !isMaybeText(raw.prefixRunId) ||
    ("failure" in raw && typeof raw.failure !== "string")
  ) {
    return { block, file, evidence: null, problem: `${at} is malformed` }
  }
  const evidence = raw as unknown as PrefixEvidence
  const refuse = (why: string): PrefixReport => ({ block, file, evidence, problem: why })

  if (evidence.scheduleHash !== schedule.scheduleHash) {
    return refuse(`${at} names schedule \`${evidence.scheduleHash}\`, which is not the sealed schedule \`${schedule.scheduleHash}\``)
  }
  if (evidence.block !== block) {
    return refuse(`${at} is filed under block ${block} but says it is block ${evidence.block}`)
  }
  if (evidence.failure !== undefined) {
    return refuse(`its prefix FAILED (${evidence.failure}), so no shared prepared review reached either arm — ${evidence.reason}`)
  }
  if (!evidence.forked) {
    return refuse(
      `its prefix records \`forked: false\` (${evidence.reason}), so the two arms did not continue ONE prepared review and ` +
        `their \`Finding.id\`s are not the same candidates`,
    )
  }
  if (evidence.prefixRunId.kind !== "known") {
    return refuse(`its prefix minted no run id (${evidence.prefixRunId.why}), so nothing can be reconciled against the arms' prefix`)
  }
  return { block, file, evidence, problem: null }
}

/** A `Maybe<string>` whose `known` really carries a string. */
function isMaybeText(value: unknown): value is Maybe<string> {
  if (!isRecord(value)) return false
  if (value.kind === "known") return typeof value.value === "string"
  return value.kind === "unknown" && typeof value.why === "string"
}

type BindOutcome = { kind: "bound"; arm: PairedArm } | { kind: "excluded"; excluded: ExcludedArm }

/**
 * One arm, checked against the sealed schedule and against the slot it was filed
 * in. `parseManifest` already refused a malformed `experiment`, an arm whose
 * `dials.routingPolicy` contradicts it, and a `prefixRunId` that is not the
 * run's own `forkedFrom`; what is left is everything that needs the SCHEDULE to
 * decide.
 *
 * Whether the arm FINISHED is not decided here. A thrown or cancelled arm is a
 * real arm of its block and is listed as one; what it cannot do is supply half a
 * pair, and that is `buildBlock`'s judgement because it is a fact about the
 * block.
 */
function bindArm(schedule: PairedSchedule, row: ArmRow): BindOutcome {
  const at = { armId: row.armId, repeatId: row.repeatId }
  const experiment = row.manifest.experiment
  // ABSENCE NEVER QUALIFIES A MANIFEST AS PAIRED. An ordinary arm in a paired
  // bundle is not half a block; it is not a block at all.
  if (experiment === undefined) {
    return {
      kind: "excluded",
      excluded: {
        ...at,
        block: null,
        reason: "its manifest carries no `experiment` block, so it is NOT a paired arm; absence never qualifies one as paired",
      },
    }
  }
  // THE SLOT IS THE BLOCK, NOT THE CLAIM. An excluded arm is named against the
  // block whose directory it sits in, because that is the block a reader finds
  // one arm short; `experiment.block` is the contested value and cannot decide
  // where its own disagreement is reported. It stands in only where the slot
  // implies no block at all, and `parseManifest` has already refused a block
  // outside the planned range, so it is always one of the three.
  const block = blockOfSlot(row.armId, row.repeatId) ?? experiment.block
  const excluded = (reason: string): BindOutcome => ({ kind: "excluded", excluded: { ...at, block, reason } })

  if (experiment.scheduleHash !== schedule.scheduleHash) {
    return excluded(
      `its \`experiment.scheduleHash\` is \`${experiment.scheduleHash}\`, which is not the sealed schedule \`${schedule.scheduleHash}\``,
    )
  }
  // THE SLOT CONVENTION IS `repeatId = block - 1` (`runPairedBlocks` in
  // `ablation/paired.ts`). A manifest whose block disagrees with the directory
  // it was filed in is two claims about which block ran it, and this reader
  // resolves neither.
  if (experiment.block !== row.repeatId + 1) {
    return excluded(
      `it is filed at repeat ${row.repeatId}, so the slot convention makes it block ${row.repeatId + 1}, ` +
        `but its \`experiment.block\` is ${experiment.block}`,
    )
  }
  if (row.armId !== experiment.arm) {
    return excluded(`it is filed under arm \`${row.armId}\` but its \`experiment.arm\` is \`${experiment.arm}\``)
  }
  const planned = schedule.slots.some(
    (slot) => slot.block === experiment.block && slot.arm === experiment.arm && slot.position === experiment.position,
  )
  if (!planned) {
    return excluded(
      `block ${experiment.block} ${experiment.arm} ${experiment.position} is not a slot the sealed schedule planned`,
    )
  }
  return { kind: "bound", arm: { arm: experiment.arm, position: experiment.position, row, experiment } }
}

/** The arms `readBundle` loaded and kept out of its own table, with its reasons. */
function loadedExclusions(bundle: BundleReadResult): ExcludedArm[] {
  return bundle.segregated.map((row) => ({
    armId: row.armId,
    repeatId: row.repeatId,
    block: blockOfSlot(row.armId, row.repeatId),
    reason: `segregated by the bundle reader and out of every comparison: ${row.reason}`,
  }))
}

/** The arms the bundle declared and has no manifest for. Half a block is still a named half. */
function absentExclusions(bundle: BundleReadResult): ExcludedArm[] {
  return [
    ...bundle.missing.map((row) => ({ ...row, kind: "missing" as const })),
    ...bundle.unreadable.map((row) => ({ ...row, kind: "unreadable" as const })),
  ].map((row) => ({
    armId: row.armId,
    repeatId: row.repeatId,
    block: blockOfSlot(row.armId, row.repeatId),
    reason: `${row.kind} — ${row.reason}`,
  }))
}

/**
 * The block a declared slot implies, or `null`.
 *
 * `runPairedBlocks` writes the index as `armId = slot.arm, repeatId = block - 1`,
 * so a MISSING arm — which has no manifest and therefore no `experiment` — can
 * still be named against its block. Anything outside that convention gets
 * `null` rather than a guessed block.
 */
function blockOfSlot(armId: string, repeatId: number): number | null {
  if (armId !== "on" && armId !== "off") return null
  const block = repeatId + 1
  return PAIRED_BLOCKS.some((planned) => planned === block) ? block : null
}

// ---------------------------------------------------------------------------
// One block
// ---------------------------------------------------------------------------

/**
 * The completions that mean the arm's finding set is what it HELD, not what it
 * produced. `degraded` is deliberately not one of them: see `buildBlock`.
 */
const PARTIAL_COMPLETIONS: Completion[] = ["unfinished", "cancelled"]

function buildBlock(
  block: number,
  plan: readonly SlotPlan[],
  bound: readonly PairedArm[],
  excluded: readonly ExcludedArm[],
  prefix: PrefixReport,
  slots: readonly SlotReport[],
): PairedBlock {
  const planned = plan.filter((slot) => slot.block === block)
  const order = new Map<ArmPosition, number>([
    ["first", 0],
    ["second", 1],
  ])
  const arms = [...bound].sort((a, b) => order.get(a.position)! - order.get(b.position)!)
  const mine = excluded.filter((entry) => entry.block === block)

  const on = arms.find((arm) => arm.arm === "on")
  const off = arms.find((arm) => arm.arm === "off")
  const prefixes = arms.map((arm) => `${arm.arm} → \`${arm.experiment.prefixRunId}\``)

  const reasons: string[] = []
  if (prefix.problem !== null) reasons.push(prefix.problem)
  // A PARTIAL OR CRASHED ARM IS NOT HALF A PAIR. A DEGRADED ARM IS.
  //
  // `experiment.failure` is the exception a continuation threw, and `unfinished`
  // or `cancelled` means the finding set on that side is whatever the run HELD
  // when it stopped. Joining a truncated set against a whole one reports the
  // truncation as a difference between the arms, which is the one reading this
  // contrast must not produce.
  //
  // `degraded` IS A DIFFERENT FACT AND IS NOT WITHHELD. The arm ran to the end
  // and something reduced it; its warnings say what. AD-6's rule is that a
  // degraded run must never LOOK like a good one — naming it satisfies that, and
  // discarding it is not what the rule asks for. 2-5c already established that a
  // budget-truncated or degraded discovery still forks, with its warnings carried
  // as data. Withholding every degraded block would discard PLANNED data, which
  // the protocol forbids, so the block measures and `confounds` names the
  // degradation beside the result.
  for (const arm of arms) {
    const failure = arm.experiment.failure
    const completion = arm.row.manifest.status.completion
    if (failure !== undefined) {
      reasons.push(
        `its \`${arm.arm}\` arm THREW (\`experiment.failure\`: ${failure}) and its completion reads ` +
          `\`${completion}\`, so its findings are what the branch held when it stopped`,
      )
      continue
    }
    if (PARTIAL_COMPLETIONS.some((partial) => partial === completion)) {
      reasons.push(
        `its \`${arm.arm}\` arm STOPPED PART WAY (\`status.completion\` is \`${completion}\`), so its findings ` +
          `are what the run held when it stopped and are not joined against a whole arm's`,
      )
    }
  }
  if (arms.length !== 2 || on === undefined || off === undefined) {
    // HALF A BLOCK IS REPORTED AS HALF A BLOCK. The arm that did run is kept and
    // named; what it cannot do is stand in for a pair.
    const listed = arms.length === 0 ? "no arm" : arms.map((arm) => `${arm.arm} (${arm.position})`).join(" and ")
    const unfinished = slots
      .filter((slot) => slot.block === block && slot.status !== "completed")
      .map((slot) => `${slot.arm} ${slot.status}: ${slot.reason}`)
    reasons.push(
      `this block bound ${listed} — a paired quantity needs exactly two arms, one \`on\` and one \`off\`` +
        (unfinished.length === 0 ? "" : `; its slots read ${unfinished.join("; ")}`),
    )
  } else if (on.experiment.prefixRunId !== off.experiment.prefixRunId) {
    // TWO PREFIXES ARE TWO POPULATIONS. The join on `Finding.id` is safe only
    // because ONE prepared review was cloned into both arms; arms forked from
    // different prefixes saw different discovery, and equal id strings across
    // them name different candidates.
    reasons.push(
      `its two arms name DIFFERENT prefixes (on \`${on.experiment.prefixRunId}\`, off ` +
        `\`${off.experiment.prefixRunId}\`), so they were not forked from one prepared review and their ` +
        `\`Finding.id\`s are not comparable`,
    )
  } else if (prefix.evidence !== null && prefix.problem === null && prefix.evidence.prefixRunId.kind === "known") {
    // THE EVIDENCE AND THE ARMS NAME THE SAME PREFIX, OR THEY DISAGREE ABOUT
    // WHICH RUN THIS BLOCK CONTINUED. Both files are written by the same
    // invocation and either could be the stale one, so neither is preferred:
    // the block is withheld and both values are printed.
    const recorded = prefix.evidence.prefixRunId.value
    if (recorded !== on.experiment.prefixRunId) {
      reasons.push(
        `its prefix evidence records prefix run \`${recorded}\`, but both arms name \`${on.experiment.prefixRunId}\`; ` +
          `two files disagree about which run this block continued and neither is preferred`,
      )
    }
  }

  const sameParent = on !== undefined && off !== undefined && on.experiment.prefixRunId === off.experiment.prefixRunId
  const inheritedSum = sameParent
    ? {
        offered: true,
        prefixes,
        why: `both arms were forked from \`${on.experiment.prefixRunId}\`, so its inherited part is one prefix, counted once`,
      }
    : {
        offered: false,
        prefixes,
        why:
          arms.length < 2
            ? "this block has no pair, so there is no shared prefix and no cancellation to offer"
            : "its arms name different prefixes, so no inherited part cancels between them; add each prefix once, on its own",
      }

  const result: BlockMeasurement | BlockWithheld = reasons.length > 0 ? { kind: "withheld", reasons } : measure(on!, off!)

  return { block, planned, arms, excluded: mine, prefix, result, inheritedSum }
}

/**
 * The label-free contrast, by direct id join.
 *
 * The denominator rules are `verdictDifference`'s, deliberately: a pair counts
 * toward `differing of n` only when BOTH sides carry a decision, an undecided
 * side is counted on its own and never folded into the difference, and a
 * candidate only one arm raised is never in the denominator. What changes is
 * only where the pairs come from — an id join instead of an `Alignment` — so the
 * two reports use one vocabulary for one quantity.
 */
function measure(on: PairedArm, off: PairedArm): BlockMeasurement {
  const onById = byId(on.row.findings)
  const offById = byId(off.row.findings)

  let paired = 0
  let differing = 0
  let of = 0
  let undecided = 0
  const differences: BlockMeasurement["difference"]["differences"] = []
  for (const [id, onFinding] of onById) {
    const offFinding = offById.get(id)
    if (offFinding === undefined) continue
    paired += 1
    const onState = verdictState(onFinding)
    const offState = verdictState(offFinding)
    if (!decided(onState) || !decided(offState)) {
      undecided += 1
      continue
    }
    of += 1
    if (onState !== offState) {
      differing += 1
      differences.push({ id, on: onState, off: offState })
    }
  }

  return {
    kind: "measured",
    prefixRunId: on.experiment.prefixRunId,
    difference: {
      paired,
      distinct: onById.size + offById.size - paired,
      differing,
      of,
      undecided,
      onlyIn: { on: onById.size - paired, off: offById.size - paired },
      differences,
    },
    arms: [summarize(on), summarize(off)],
    treatment: treatmentOpportunity(off.row.manifest),
  }
}

function byId(findings: readonly Finding[]): Map<string, Finding> {
  // `fromPersistedFindings` already refused a pool with two findings of one id,
  // so this map loses nothing.
  return new Map(findings.map((finding) => [finding.id, finding]))
}

function summarize(arm: PairedArm): ArmSummary {
  const states = arm.row.findings.map(verdictState)
  return {
    arm: arm.arm,
    runId: arm.row.manifest.run.runId,
    position: arm.position,
    completion: arm.row.manifest.status.completion,
    canonical: states.length,
    upheld: states.filter((state) => state === "upheld").length,
    unresolved: states.filter((state) => state === "unresolved").length,
    unjudged: states.filter((state) => state === "unjudged").length,
  }
}

/**
 * The treatment opportunity, READ off the OFF arm's own record and never
 * re-derived (`RouteCounts.intervention` in `core/domain/run-record.ts`).
 *
 * `wouldHaveDebated` is how many of the candidates the debate-off policy sent
 * straight to the judge the SHIPPED policy would have debated — decided by
 * `core/stages/route.ts` at the time, by the same rule, on the same findings.
 * Recomputing it here would answer a different question with this reader's idea
 * of the threshold rule rather than the run's. It is read from the OFF arm ONLY:
 * the ON arm ran the shipped policy and writes no `intervention` block at all.
 *
 * EVERY FIELD IS CHECKED ON THE WAY IN, INCLUDING THE ARITHMETIC BETWEEN THEM.
 * `parseManifest` validates `status`'s completion, warnings and cancellation and
 * stops there, so a junk `routeCounts` reaches this function intact; and two
 * separately valid counts can still be an impossible pair — `wouldHaveDebated`
 * is a subset of `toJudge` by construction, so a larger one printed `5 of 4`, a
 * rate above one in a report that prints no rate above one.
 */
function treatmentOpportunity(manifest: RunManifest): TreatmentOpportunity {
  const counts = (manifest.status as { routeCounts?: unknown }).routeCounts
  if (!isRecord(counts)) return { kind: "unknown", why: "its OFF arm's manifest carries no readable `status.routeCounts`" }
  if (counts.kind === "did-not-run") {
    return { kind: "unknown", why: "its OFF arm's routing stage did not run, so no treatment opportunity was recorded" }
  }
  if (counts.kind !== "ran" || !isRecord(counts.counts)) {
    return { kind: "unknown", why: "its OFF arm's `status.routeCounts` is neither `did-not-run` nor a readable `ran`" }
  }
  const intervention = counts.counts.intervention
  if (intervention === undefined) {
    return {
      kind: "unknown",
      why:
        "its OFF arm's `status.routeCounts` carries no `intervention` block — it is written only under the " +
        "evaluation-only debate-off policy, so this arm recorded no treatment opportunity",
    }
  }
  if (!isRecord(intervention) || !isCount(intervention.toJudge) || !isCount(intervention.wouldHaveDebated)) {
    return { kind: "unknown", why: "its OFF arm's `status.routeCounts.intervention` is malformed" }
  }
  if (intervention.wouldHaveDebated > intervention.toJudge) {
    return {
      kind: "unknown",
      why:
        `its OFF arm records \`wouldHaveDebated\` ${intervention.wouldHaveDebated} over \`toJudge\` ` +
        `${intervention.toJudge}, and the debated set is a SUBSET of the judged set, so the pair is impossible`,
    }
  }
  return { kind: "known", toJudge: intervention.toJudge, wouldHaveDebated: intervention.wouldHaveDebated }
}

/** What one quantity divides by in one block, and why that is nothing. */
function denominatorOf(quantity: PairedQuantity, measured: BlockMeasurement): { of: number; why: string } {
  const difference = measured.difference
  switch (quantity) {
    case "paired candidates":
    case "only-in counts":
      return {
        of: difference.distinct,
        why: "its two arms raised no canonical candidate at all, so there is no population to count against",
      }
    case "verdict-state differences":
      return {
        of: difference.of,
        why: "no paired candidate carried a decision on BOTH sides, so no verdict-state difference is measurable",
      }
    case "undecided transitions":
      return { of: difference.paired, why: "its two arms share no candidate id, so no pair could be undecided" }
    case "treatment opportunity":
      return measured.treatment.kind === "known"
        ? { of: measured.treatment.toJudge, why: "its OFF arm sent no candidate to the judge, so there is no denominator" }
        : { of: 0, why: measured.treatment.why }
  }
}

/**
 * `n/3` per quantity, each unavailable block naming its EXACT reason.
 *
 * Separately per quantity, because a block can yield the join and not the
 * treatment opportunity: one `2/3` covering both would report the block that
 * paired its candidates as having yielded nothing.
 *
 * A ZERO DENOMINATOR IS NOT AVAILABLE. A measured block still supplies nothing
 * for a quantity it cannot divide, and counting it published `3/3` above three
 * block bodies each reading `not measurable (0 cases)` — an availability table
 * that contradicted every result beneath it.
 */
function availabilityOf(blocks: readonly PairedBlock[]): Availability[] {
  return PAIRED_QUANTITIES.map((quantity) => {
    const missing: { block: number; reason: string }[] = []
    let available = 0
    for (const block of blocks) {
      if (block.result.kind === "withheld") {
        missing.push({ block: block.block, reason: block.result.reasons.join("; ") })
        continue
      }
      const denominator = denominatorOf(quantity, block.result)
      if (denominator.of === 0) {
        missing.push({ block: block.block, reason: denominator.why })
        continue
      }
      available += 1
    }
    return { quantity, available, of: blocks.length, missing }
  })
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** How many differing candidates are named before the rest are counted. */
const NAMED_DIFFERENCES = 5

/**
 * Render the paired reader's result as plain text.
 *
 * ## WHAT IS AT THE TOP, AND WHY
 *
 * A latched halt, a refused schedule, the six slot statuses and the availability
 * table all print ABOVE the first paired number — `read-bundle.ts`'s ordering,
 * for the same reason: a reader must not be able to reach a result without first
 * seeing what is not in it.
 *
 * ## WHAT IS BESIDE EVERY MEASURED RESULT, AND WHY
 *
 * Four things, per measured block, never in a footnote: the run-id/judge-anonymizer
 * confound the fork does not remove, the within-block position order, the
 * sentence saying what this contrast identifies and what it does not, and the
 * dial disclosures `read-bundle.ts` already computes. A confound stated once at
 * the top of a three-block report is a confound a reader carries away from
 * exactly one of the three numbers. A WITHHELD block has no result to qualify,
 * so it gets its reasons and its arms instead.
 */
export function renderPairedBundle(result: PairedReadResult): string {
  const lines: string[] = []

  lines.push(`MAD PAIRED CONTRAST — ${result.root}`)
  if (result.schedule.ok) {
    const schedule = result.schedule.schedule
    lines.push(
      `sealed schedule ${schedule.scheduleHash}, coin ${schedule.coin}, first arms ` +
        `${schedule.firstArms.join(", ")}, sealed ${schedule.createdAt}`,
      `protocol ${schedule.protocol.id} v${schedule.protocol.version} (${schedule.protocol.hash})`,
    )
  }
  lines.push("")

  if (result.halt.kind === "halted") {
    lines.push(
      "THIS EXPERIMENT IS HALTED.",
      `  \`${result.halt.file}\` — ${result.halt.reason}`,
      "  The paired results below are still read from what was written. They describe an evaluation that",
      "  STOPPED, and admission does not resume until a human reads the halt and removes the marker.",
      "",
    )
  } else if (result.halt.kind === "unestablished") {
    lines.push(
      "WHETHER THIS EXPERIMENT IS HALTED COULD NOT BE ESTABLISHED.",
      `  \`${result.halt.file}\` — ${result.halt.reason}`,
      "  Read everything below as an evaluation that MAY have stopped. This reader did not find that it",
      "  had, and it did not find that it had not.",
      "",
    )
  }

  if (!result.schedule.ok) {
    lines.push(
      "NO PAIRED RESULT: THE SCHEDULE IS REFUSED AS A WHOLE.",
      `  ${result.schedule.reason}`,
      "  Every paired quantity rests on the sealed order, so none of them is computed from a schedule that",
      "  does not verify. The arms are listed below, unchanged and uninterpreted, and the slot statuses",
      "  below them are read from `paired-slots.jsonl`, which the runner writes without the schedule.",
      "",
    )
    lines.push(...slotCoverage(result))
    lines.push(...armListing(result))
    return `${lines.join("\n")}\n`
  }

  lines.push(...slotCoverage(result))

  // ---- prefixes ----
  lines.push("PREFIX EVIDENCE — the one forked prefix each block's two arms continue")
  for (const block of result.blocks) {
    const prefix = block.prefix
    if (prefix.problem !== null) {
      lines.push(`  block ${prefix.block}: UNUSABLE — ${prefix.problem}`)
      continue
    }
    const evidence = prefix.evidence!
    const runId = evidence.prefixRunId.kind === "known" ? `\`${evidence.prefixRunId.value}\`` : `unknown (${evidence.prefixRunId.why})`
    lines.push(`  block ${prefix.block}: prefix run ${runId}, forked — ${evidence.reason}`)
  }
  lines.push("")

  lines.push(...armListing(result))

  // ---- availability ----
  lines.push("AVAILABILITY — separately per quantity, and never one figure for all of them")
  for (const entry of result.availability) {
    lines.push(`  ${entry.quantity}: ${entry.available}/${entry.of}`)
    for (const gap of entry.missing) {
      lines.push(`    block ${gap.block} unavailable — ${gap.reason}`)
    }
  }
  lines.push("")

  for (const block of result.blocks) lines.push(...renderBlock(block))

  lines.push(
    "WHAT THIS REPORT DOES NOT MEASURE. No truth label enters it, so it states no precision, no false",
    "positives, no final recall, none of the four labelled verdict transitions, and no earned /",
    "did-not-earn reading. CAP-1 recall and CAP-11 lens gain are the labelled report's",
    `(\`${LABELLED_READER_MODULE}\`), printed after this one. The four labelled verdict transitions and the`,
    `per-arm false positives are the adjudication report's (\`${ADJUDICATION_READER_MODULE}\`), printed after that`,
    "one, from a human truth sheet. Precision, final recall and cost contrasts belong to story 2.8.",
    "Nothing here is a product-value claim, and three blocks were bought as DESCRIPTIVE evidence with no significance",
    "claim available from them (`evaluation-protocol.md` §4).",
  )
  return `${lines.join("\n")}\n`
}

/** All six planned slots, folded, whatever the schedule turned out to be. */
function slotCoverage(result: PairedReadResult): string[] {
  const lines = ["SLOT COVERAGE — all six planned slots, one terminal status each"]
  for (const slot of result.slots) {
    const position = slot.position === "unknown" ? "position unknown" : slot.position
    lines.push(`  block ${slot.block} ${slot.arm} (${position}): ${slot.status} — ${slot.reason}`)
  }
  for (const line of result.malformedSlotLines) {
    lines.push(`  \`${SLOT_STATUS_FILE}\` line ${line.line} was not read: ${line.reason}`)
  }
  lines.push("")
  return lines
}

/** Every arm the bundle declared, and where it landed. */
function armListing(result: PairedReadResult): string[] {
  const index = result.bundle.index
  const lines = [
    "ARMS",
    `  \`bundle.json\` declares ${index.arms.length} arm-repeat(s), created ${index.createdAt}; the bundle reader ` +
      `admitted ${result.bundle.comparable.length} to its cohort`,
  ]
  for (const block of result.blocks) {
    for (const arm of block.arms) {
      lines.push(
        `  ${arm.row.armId}/${arm.row.repeatId} → block ${arm.experiment.block} ${arm.arm} (${arm.position}), ` +
          `run \`${arm.row.manifest.run.runId}\`, prefix \`${arm.experiment.prefixRunId}\``,
      )
    }
  }
  const excluded = allExcluded(result)
  if (excluded.length > 0) {
    lines.push("  KEPT, NAMED, AND OUT OF EVERY PAIR")
    for (const arm of excluded) {
      lines.push(`    ${arm.armId}/${arm.repeatId}${arm.block === null ? "" : ` (block ${arm.block})`} — ${arm.reason}`)
    }
  }
  lines.push("")
  return lines
}

function renderBlock(block: PairedBlock): string[] {
  const lines: string[] = []
  const order = block.planned.map((slot) => `${slot.arm} ${slot.position}`).join(", ")
  lines.push(`BLOCK ${block.block} — planned order: ${order}`)

  if (block.result.kind === "withheld") {
    lines.push("  NO PAIRED QUANTITY FOR THIS BLOCK. It is withheld, and the other blocks are unaffected:")
    for (const reason of block.result.reasons) lines.push(`    ${reason}`)
    for (const arm of block.arms) {
      lines.push(
        `  arm ${arm.arm} (${arm.position}): run \`${arm.row.manifest.run.runId}\`, prefix ` +
          `\`${arm.experiment.prefixRunId}\`, completion \`${arm.row.manifest.status.completion}\`, ` +
          `${arm.row.findings.length} canonical finding(s)`,
      )
    }
    lines.push(...inheritedSumLines(block))
    lines.push("")
    return lines
  }

  const measured = block.result
  const difference = measured.difference
  lines.push(`  both arms forked from \`${measured.prefixRunId}\`; candidates paired by \`Finding.id\`, no aligner`)
  // THE CLAUSE COMES BEFORE THE FIGURE, so the sentence still parses when the
  // figure is `not measurable (0 cases)`. With the figure first it read
  // "not measurable (0 cases) paired candidate(s) where BOTH arms decided",
  // which is a phrase and a clause glued into neither.
  lines.push(
    `  paired candidates, of the distinct candidate id(s) across the two arms: ` +
      `${countText(difference.paired, difference.distinct)}`,
    `  verdict-state differences, over the paired candidates where BOTH arms decided: ` +
      `${countText(difference.differing, difference.of)}`,
    `  undecided transitions, over the paired candidates (counted here and in NEITHER half of the line ` +
      `above): ${countText(difference.undecided, difference.paired)}`,
    `  only in on, of the distinct candidate id(s): ${countText(difference.onlyIn.on, difference.distinct)}`,
    `  only in off, of the distinct candidate id(s): ${countText(difference.onlyIn.off, difference.distinct)}`,
  )
  // THE LIST IS CAPPED, for the reason `usageCompleteness` caps its identities:
  // the confounds and the identification sentence have to sit BESIDE the result,
  // and an uncapped list of differences pushes them off the end of a block a
  // reader is still reading. Every one of them is in the two manifests.
  for (const entry of difference.differences.slice(0, NAMED_DIFFERENCES)) {
    lines.push(`    \`${entry.id}\`: on ${entry.on} → off ${entry.off}`)
  }
  if (difference.differences.length > NAMED_DIFFERENCES) {
    lines.push(
      `    …and ${difference.differences.length - NAMED_DIFFERENCES} more, in this block's two \`manifest.json\` files.`,
    )
  }

  if (measured.treatment.kind === "known") {
    lines.push(
      `  treatment opportunity, of the candidate(s) the OFF arm sent to the judge: ` +
        `${countText(measured.treatment.wouldHaveDebated, measured.treatment.toJudge)} would have been DEBATED by ` +
        `the shipped policy (read from the OFF arm's \`status.routeCounts.intervention\`, never re-derived)`,
    )
  } else {
    lines.push(`  treatment opportunity: UNAVAILABLE — ${measured.treatment.why}`)
  }

  for (const arm of measured.arms) {
    lines.push(
      `  arm ${arm.arm} (${arm.position}), run \`${arm.runId}\`, completion \`${arm.completion}\`: ` +
        `${arm.canonical} canonical finding(s), upheld ${countText(arm.upheld, arm.canonical)}, ` +
        `unresolved ${countText(arm.unresolved, arm.canonical)}, unjudged ${countText(arm.unjudged, arm.canonical)}`,
    )
    if (arm.upheld === 0) {
      // AN ARM THAT UPHELD NOTHING IS UNDEFINED, NOT 100% AND NOT A CLEAN LIST
      // (`evaluation-protocol.md` §3). No interval repairs a zero denominator,
      // so none is invented.
      lines.push(
        `    arm ${arm.arm} UPHELD NOTHING (${countText(arm.upheld, arm.canonical)}). Every rate whose`,
        `    denominator is its upheld set is UNDEFINED for this arm — not 100%, and not a clean list.`,
        "    No interval is invented for it here.",
      )
    }
  }
  lines.push(
    "  UNRESOLVED CANDIDATES STAY VISIBLE. A candidate the budget refused or a cancellation cut short is",
    "  NOT successful noise removal: it was never decided, and it is counted above rather than removed.",
  )

  lines.push(...confounds(block, measured))
  lines.push(...inheritedSumLines(block))
  lines.push("")
  return lines
}

/**
 * The confounds, BESIDE THIS RESULT.
 *
 * The first was documented in `ablation/LIVE-RUN.md` and reported beside nothing
 * — which is the gap this story closes. The second was reported nowhere at all.
 */
function confounds(block: PairedBlock, measured: BlockMeasurement): string[] {
  const lines = [`  CONFOUNDS, BESIDE THIS RESULT — block ${block.block}`]
  const runIds = measured.arms.map((arm) => `${arm.arm} \`${arm.runId}\``).join(", ")
  lines.push(
    "    RUN ID / JUDGE ANONYMIZER. The fork gives each arm a NEW run of its own with its own run id",
    "    (`forkPreparedReview` in `core/run/review.ts`), and the judge's anonymizer seeds its permutation",
    "    from that run id together with each finding's id (the `runId` passed to `judge` in the same",
    "    file's `review`). The two arms of this block can therefore put the SAME exchange in front of the",
    "    judge under DIFFERENT anonymized orders. That difference is inside every number above, the",
    "    checkpoint fork does NOT remove it, and nothing here corrects for it.",
    `      run ids: ${runIds}`,
  )
  const first = measured.arms.find((arm) => arm.position === "first")
  const second = measured.arms.find((arm) => arm.position === "second")
  lines.push(
    "    POSITION ORDER, WITHIN THIS BLOCK. The two arms did not run at the same time:",
    `      ${first === undefined ? "first: unrecorded" : `first: ${first.arm}`}, ` +
      `${second === undefined ? "second: unrecorded" : `second: ${second.arm}`}.`,
    "    The coin counterbalances first-arm order ACROSS the three blocks; it does not remove the order",
    "    inside one. Anything that drifts between the two continuations — a provider's model version, its",
    "    load, its sampling — is confounded with whichever arm ran second HERE.",
  )
  lines.push(
    "    IDENTIFICATION. These are observed differences in the DEPLOYED debate pathway: the shipped",
    "    debate-plus-adjudication route against direct fact-checking of the same candidates, as deployed.",
    "    They do NOT measure the benefit of conversation with the judge pipeline held fixed, and they do",
    "    not say whether the pathway earns its cost.",
  )
  // A DEGRADED ARM IS IN THE RESULT, SO IT IS NAMED IN THE RESULT. AD-6 asks that
  // a degraded run never LOOK like a good one; this is where it stops looking
  // like one, and it is here rather than in a banner at the top because a reader
  // has to meet it beside the numbers it qualifies.
  const degraded = block.arms.filter((arm) => arm.row.manifest.status.completion === "degraded")
  if (degraded.length > 0) {
    lines.push(
      "    A DEGRADED ARM IS IN THIS RESULT, NAMED RATHER THAN DISCARDED. It ran to the end and something",
      "    reduced it, so its findings are a real arm's and the block is measured; a withheld block would",
      "    have discarded PLANNED data instead. Every number above is the degraded arm's:",
    )
    for (const arm of degraded) {
      const warnings = arm.row.manifest.status.warnings
      lines.push(
        `      ${arm.arm} \`${arm.row.manifest.run.runId}\`: completion \`degraded\`; ` +
          (warnings.length === 0
            ? "its manifest records NO warning, so what reduced it is not stated"
            : `${warnings.length} warning(s): ${warnings.map((warning) => warning.code).join(", ")}`),
      )
    }
  }
  // The dial disclosures `read-bundle.ts` computes, over THIS block's two arms.
  // `routingPolicy` stays out of its dial key there because it IS the
  // intervention, which is exactly what makes those lines readable here.
  for (const line of disclosures(block.arms.map((arm) => arm.row))) {
    // An empty separator stays empty: indenting it would leave trailing spaces.
    lines.push(line === "" ? "" : `  ${line}`)
  }
  return lines
}

/** Each arm's prefix, and the inherited-sum rule only where one prefix is shared. */
function inheritedSumLines(block: PairedBlock): string[] {
  const lines = ["  EACH ARM'S PREFIX:"]
  if (block.inheritedSum.prefixes.length === 0) lines.push("    none — this block bound no arm")
  for (const prefix of block.inheritedSum.prefixes) lines.push(`    ${prefix}`)
  if (block.inheritedSum.offered) {
    lines.push(`  ${block.inheritedSum.why}.`)
    lines.push(...INHERITED_SUM_RULE)
    return lines
  }
  lines.push("  THE INHERITED-SUM RULE IS WITHHELD FOR THIS BLOCK:", `    ${block.inheritedSum.why}.`)
  return lines
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
