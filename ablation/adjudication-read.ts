/**
 * Story 2-6b — THE ADJUDICATION READER: the four labelled verdict directions and
 * the per-arm false positives, read from a human truth sheet bound to this
 * bundle's sealed schedule, block and prefix run.
 *
 * It consumes a `PairedReadResult` and adds nothing to it. It bills nothing,
 * runs no model, and calls neither `runPairedBlocks` nor `createSchedule`. It
 * prints and never gates; `eval-read` still returns 0.
 *
 * ## THE TRUTH POOL IS THE SHARED PREFIX, AND IT IS NOT THE SURVIVORS
 *
 * Every canonical candidate in the block's prefix `record.json` gets one label
 * slot — not the intersection of the two arms, not the upheld ones, and not a
 * per-arm list. A pool defined by what survived would let a candidate's
 * DISAPPEARANCE decide whether it is ever truth-labelled, which is exactly the
 * disappearance trap `evaluation-protocol.md:169-173` names.
 *
 * The prefix record is resolved, contained and bound by `loadPrefixRecord`
 * (`ablation/labelled-read.ts`), reused rather than re-derived: a second
 * resolver would be a second answer to *which file is this block's prefix
 * record?*. Both readers open that file in one `eval-read` invocation, and each
 * prints the path and run id it bound, so a divergence between them is visible
 * rather than silent.
 *
 * ## A PLANTED-LABEL MATCH IS SUGGESTED EVIDENCE, NEVER A TRUTH LABEL
 *
 * `lexicalDefectMatcher` (`fixtures/recall.ts:178-183`) is `sameFile &&
 * nearEnough && marker substring of claim+reasoning`, so a marker sitting inside
 * a NEGATION matches and the claim need not allege the planted mechanism;
 * `adjudicate()` then takes one finding per defect greedily. The key proves a
 * planted DEFECT is real. It never proves that a candidate matched to it makes a
 * true claim.
 *
 * So the matcher's association is carried beside each label as SUGGESTED
 * evidence and enters no count. A human label that disagrees with it is KEPT,
 * the disagreement is printed, and nothing is refused over it. Every number
 * below is identical under an injected matcher; only the suggestion column
 * moves. `ADJUDICATION.md`'s matched-needs-no-row shortcut is a rule about the
 * legacy per-arm worksheet and does not apply here: a matched candidate still
 * needs its own row.
 *
 * ## TWO AXES, NEVER MERGED
 *
 * Truth-`unresolved` and verdict-`unresolved` are different facts and print as
 * such. A transition needs a decided verdict on BOTH sides AND a truth label;
 * the three ways that fails — undecided verdict, missing label, unresolved label
 * — are counted under their own names, because a candidate nobody decided and a
 * candidate ruled real are not the same fact.
 *
 * `not-adjudicated` is NEVER rejected. `core/instructions/coding/judge.ts:97,153`
 * defines it as evidence that does not settle the claim, and
 * `core/stages/judge.ts:1690-1699` also writes it when the aggregator drops out.
 * Reporting `upheld → not-adjudicated` as successful noise removal would count a
 * missing ruling as a ruling.
 *
 * ## DIRECTION READS OFF → ON
 *
 * `evaluation-protocol.md:123-126` defines `d_r = P_on,r − P_off,r`, so OFF is
 * the baseline and ON is the treatment. The randomized first-arm order decides
 * who ran first and changes nothing about which way the arrow points.
 *
 * ## WHAT IT DOES NOT COMPUTE
 *
 * No precision, no precision bounds, no final recall, no cost contrast, and no
 * earned / did-not-earn reading. Those are story 2.8's, under the frozen
 * protocol's bound arithmetic. It never parses `adjudication.md` and never falls
 * back to it.
 *
 * Every entry point returns a typed result and nothing throws.
 */

import { readFile, realpath } from "node:fs/promises"
import { join, sep } from "node:path"

import type { Finding } from "../core/domain/finding.ts"
import { adjudicate } from "../fixtures/seeded-defects/adjudicate.ts"
import { SEEDED_DEFECTS } from "../fixtures/seeded-defects/labels.ts"
import { lexicalDefectMatcher, type DefectMatcher } from "../fixtures/recall.ts"
import { verdictState, type VerdictState } from "./compare.ts"
import { loadPrefixRecord, type FindingList } from "./labelled-read.ts"
import { allExcluded, type PairedBlock, type PairedReadResult } from "./paired-read.ts"
import { PAIRED_BLOCKS, type Arm, type PairedSchedule } from "./schedule.ts"

/** Where the filled sheet lives, beside the evidence it is about. */
export const ADJUDICATION_SHEET_FILE = "adjudication.json"

/**
 * Bumped by hand when the sheet document's shape changes. It is read BEFORE any
 * other field, so a sheet from a shape this reader does not know is named as
 * such rather than being parsed into silence.
 */
export const ADJUDICATION_SHEET_VERSION = 1

/**
 * The three truth labels, exactly `ADJUDICATION.md`'s. `unresolved` is a real
 * outcome and is preserved rather than forced (`evaluation-protocol.md:132,170`).
 */
export const TRUTH_LABELS = ["true-defect", "not-a-defect", "unresolved"] as const
export type TruthLabel = (typeof TRUTH_LABELS)[number]

// ---------------------------------------------------------------------------
// Verdict buckets
// ---------------------------------------------------------------------------

/**
 * What a verdict state comes to for a DIRECTION, with the three non-decisive
 * states kept apart and none of them folded into `rejected`.
 *
 * `compare.ts`'s `verdictState` and `decided` are unchanged and are not
 * redefined here: `decided()` answers *was this settled at all?*, which is the
 * paired report's question, and `not-adjudicated` is settled-enough for that
 * denominator. A DIRECTION needs to know which way, and `not-adjudicated` says
 * no way at all, so it is its own bucket here.
 */
export type VerdictBucket = "upheld" | "rejected" | "not-adjudicated" | "unresolved" | "unjudged"

export function verdictBucket(state: VerdictState): VerdictBucket {
  if (state === "upheld") return "upheld"
  if (state === "withdrawn-by-author" || state === "judge-ruled-invalid") return "rejected"
  return state
}

/** Whether a bucket points a direction. `not-adjudicated` does not. */
function directional(bucket: VerdictBucket): bucket is "upheld" | "rejected" {
  return bucket === "upheld" || bucket === "rejected"
}

// ---------------------------------------------------------------------------
// The four directions
// ---------------------------------------------------------------------------

/**
 * `evaluation-protocol.md:174-176`'s four secondary diagnostics, each counted
 * separately and never summed into a net.
 *
 * The first two are the treatment doing its job; the second two are the
 * treatment doing harm. They are listed as four rows and not as two signed rows
 * because a net figure hides a block that both gained and lost.
 */
export const DIRECTIONS = [
  {
    key: "false-upheld-to-rejected",
    truth: "not-a-defect",
    off: "upheld",
    on: "rejected",
    label: "false upheld → rejected",
    reading: "OFF upheld a candidate the sheet calls not-a-defect and ON rejected it",
    nameAll: false,
  },
  {
    key: "true-rejected-to-upheld",
    truth: "true-defect",
    off: "rejected",
    on: "upheld",
    label: "true rejected → upheld",
    reading: "OFF rejected a real defect and ON upheld it",
    nameAll: false,
  },
  {
    key: "true-upheld-to-rejected",
    truth: "true-defect",
    off: "upheld",
    on: "rejected",
    label: "true upheld → rejected",
    reading: "OFF upheld a real defect and ON rejected it",
    // THE LOST TRUE CANDIDATES ARE NAMED IN FULL, never capped.
    // `evaluation-protocol.md:169-173` asks for exactly that, and a list this
    // report truncated at five would answer *how many* where the protocol asked
    // *which*. Every other direction is capped; this one is not.
    nameAll: true,
  },
  {
    key: "false-rejected-to-upheld",
    truth: "not-a-defect",
    off: "rejected",
    on: "upheld",
    label: "false rejected → upheld",
    reading: "OFF rejected a candidate the sheet calls not-a-defect and ON upheld it",
    nameAll: false,
  },
] as const

export type DirectionKey = (typeof DIRECTIONS)[number]["key"]

function directionOf(truth: TruthLabel, on: VerdictBucket, off: VerdictBucket): DirectionKey | null {
  const found = DIRECTIONS.find((entry) => entry.truth === truth && entry.on === on && entry.off === off)
  return found?.key ?? null
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

/** One candidate's row, exactly as the sheet carries it. */
export interface SheetRow {
  candidateId: string
  truth: TruthLabel
  /** What made the label checkable. Carried through and never interpreted. */
  evidence?: string
}

/** One block's page of the sheet, bound to that block's prefix run. */
export interface SheetBlock {
  block: number
  prefixRunId: string
  rows: SheetRow[]
}

/** A page whose `block` is not one the schedule planned. Named, and refusing nothing else. */
export interface StrayPage {
  /** Index in the sheet's `blocks` list. */
  at: number
  /** The `block` value exactly as the sheet carried it, rendered. */
  block: string
}

/**
 * The sheet's states, none of which collapses into another.
 *
 * `absent` is nobody wrote one. `unreadable` is one this process could not open
 * — a permission denial, a directory where the file should be — which is not
 * the same fact and must never print under a banner saying nobody wrote a sheet.
 * `malformed` is somebody wrote something this reader cannot read as a sheet.
 * `refused` is a well-formed sheet about a DIFFERENT bundle. A sheet with no row
 * for one candidate is not a sheet state at all; it is that candidate's, and it
 * reads `label missing`.
 */
export type SheetRead =
  | { kind: "absent"; file: string; why: string }
  | { kind: "unreadable"; file: string; why: string }
  | { kind: "malformed"; file: string; why: string }
  | { kind: "refused"; file: string; why: string }
  | { kind: "read"; file: string; scheduleHash: string; blocks: SheetBlock[]; strayPages: StrayPage[] }

/** What a truth-dependent quantity reads when the sheet gives no labels. */
export const NO_SHEET_REASON = "no adjudication sheet"

async function readSheet(root: string, schedule: PairedSchedule): Promise<SheetRead> {
  const file = join(root, ADJUDICATION_SHEET_FILE)
  // CONTAINED BY REAL PATH, exactly as `loadPrefixRecord` contains everything it
  // opens. The sheet is the one file here a human puts in place by hand, so a
  // symlink pointing out of the bundle is the easy mistake: it would label THIS
  // bundle's candidates from some other bundle's sheet, silently.
  const contained = await containedInBundle(root, file)
  if (contained !== null) return { kind: "refused", file, why: contained }

  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (error) {
    if (isMissing(error)) return { kind: "absent", file, why: `${NO_SHEET_REASON} at \`${file}\`` }
    return { kind: "unreadable", file, why: `\`${file}\` could not be read (${messageOf(error)})` }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { kind: "malformed", file, why: `it is not JSON (${messageOf(error)})` }
  }
  if (!isRecord(raw)) return { kind: "malformed", file, why: "it is not a JSON object" }

  // VERSION FIRST, exactly as `readSchedule` reads `scheduleVersion` first: a
  // document of an unknown shape must be named as one, not field-checked against
  // a shape it never claimed.
  if (raw.adjudicationSheetVersion !== ADJUDICATION_SHEET_VERSION) {
    return {
      kind: "malformed",
      file,
      why:
        `its \`adjudicationSheetVersion\` is ${JSON.stringify(raw.adjudicationSheetVersion) ?? "absent"}, and this reader ` +
        `knows ${ADJUDICATION_SHEET_VERSION}`,
    }
  }
  if (typeof raw.scheduleHash !== "string") return { kind: "malformed", file, why: "it carries no string `scheduleHash`" }
  if (raw.scheduleHash !== schedule.scheduleHash) {
    return {
      kind: "refused",
      file,
      why:
        `its \`scheduleHash\` is \`${raw.scheduleHash}\`, and this bundle's sealed schedule is ` +
        `\`${schedule.scheduleHash}\`; it is a sheet about another plan`,
    }
  }
  if (!Array.isArray(raw.blocks)) return { kind: "malformed", file, why: "it carries no `blocks` list" }

  const blocks: SheetBlock[] = []
  const strayPages: StrayPage[] = []
  const seen = new Map<number, number>()
  for (const [index, entry] of raw.blocks.entries()) {
    if (!isRecord(entry)) return { kind: "malformed", file, why: `\`blocks[${index}]\` is not an object` }
    const block = entry.block
    // A PAGE NAMING NO PLANNED BLOCK REFUSES ITSELF AND NOTHING ELSE. One typo in
    // page 3 used to withdraw the truth labels of blocks 1 and 2 as well, which
    // is a whole-sheet refusal dressed as a field check. The block the typo was
    // meant for now reads `carries no page`, with the stray named beside it.
    if (typeof block !== "number" || !PAIRED_BLOCKS.includes(block as (typeof PAIRED_BLOCKS)[number])) {
      strayPages.push({ at: index, block: JSON.stringify(block) ?? "absent" })
      continue
    }
    const earlier = seen.get(block)
    if (earlier !== undefined) {
      return { kind: "malformed", file, why: `\`blocks[${index}]\` and \`blocks[${earlier}]\` are both block ${block}` }
    }
    seen.set(block, index)
    if (typeof entry.prefixRunId !== "string") {
      return { kind: "malformed", file, why: `\`blocks[${index}].prefixRunId\` is not a string` }
    }
    if (!Array.isArray(entry.rows)) return { kind: "malformed", file, why: `\`blocks[${index}].rows\` is not a list` }
    const rows: SheetRow[] = []
    for (const [at, row] of entry.rows.entries()) {
      if (!isRecord(row)) return { kind: "malformed", file, why: `\`blocks[${index}].rows[${at}]\` is not an object` }
      if (typeof row.candidateId !== "string") {
        return { kind: "malformed", file, why: `\`blocks[${index}].rows[${at}].candidateId\` is not a string` }
      }
      if (!TRUTH_LABELS.includes(row.truth as TruthLabel)) {
        return {
          kind: "malformed",
          file,
          why:
            `\`blocks[${index}].rows[${at}]\` labels candidate \`${row.candidateId}\` ` +
            `${JSON.stringify(row.truth) ?? "absent"}, which is not one of ${TRUTH_LABELS.join(", ")}`,
        }
      }
      if (row.evidence !== undefined && typeof row.evidence !== "string") {
        return { kind: "malformed", file, why: `\`blocks[${index}].rows[${at}].evidence\` is present and is not a string` }
      }
      rows.push({
        candidateId: row.candidateId,
        truth: row.truth as TruthLabel,
        ...(row.evidence === undefined ? {} : { evidence: row.evidence }),
      })
    }
    blocks.push({ block, prefixRunId: entry.prefixRunId, rows })
  }
  return { kind: "read", file, scheduleHash: raw.scheduleHash, blocks, strayPages }
}

/** `null` when `file` resolves inside the real bundle root, or why it does not. */
async function containedInBundle(root: string, file: string): Promise<string | null> {
  let realRoot: string
  try {
    realRoot = await realpath(root)
  } catch (error) {
    return `the bundle root \`${root}\` could not be resolved (${messageOf(error)})`
  }
  let realFile: string
  try {
    realFile = await realpath(file)
  } catch {
    // Missing, or a broken link. `readFile` below reports which, and a path that
    // does not resolve is not a containment failure.
    return null
  }
  const base = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`
  if (realFile !== realRoot && realFile.startsWith(base)) return null
  return `it resolves to the real path \`${realFile}\`, which is not inside the bundle root \`${realRoot}\``
}

// ---------------------------------------------------------------------------
// What the reader produces
// ---------------------------------------------------------------------------

/** One candidate of the truth pool, in exactly one bucket. */
export type CandidateOutcome =
  | { kind: "transition"; direction: DirectionKey }
  | { kind: "unchanged"; state: "upheld" | "rejected" }
  | { kind: "undecided" }
  | { kind: "label-missing" }
  | { kind: "truth-unresolved" }
  | { kind: "arm-missing" }

/**
 * One canonical prefix candidate, accounted for once.
 *
 * The buckets are assigned in a FIXED order — arm-missing, undecided,
 * label-missing, truth-unresolved, then the direction — so every candidate lands
 * in exactly one and the six counts sum to the pool. The order is the order in
 * which a fact disqualifies a candidate from being a direction at all: a
 * candidate one arm never raised has no pair to compare, whatever its label
 * says. `labelCoverage` below reports label rows over the WHOLE pool, so a
 * candidate counted here as arm-missing is not also lost from the coverage line.
 */
export interface CandidateAccount {
  id: string
  outcome: CandidateOutcome
  /** The arms that raised this candidate, in schedule order. */
  present: Arm[]
  on: VerdictBucket | null
  off: VerdictBucket | null
  label: TruthLabel | null
  /** The planted defect the matcher associated with it. SUGGESTED EVIDENCE, never a label. */
  suggested: string | null
  /** The human label contradicts the matcher's suggestion. The label is kept. */
  disagreement: string | null
}

/** The counts that need no truth label, so a bundle with no sheet still reads them. */
export interface VerdictAccount {
  /** Canonical candidates in the block's prefix record. The denominator for everything below. */
  pool: number
  /** Pool candidates both arms raised. */
  paired: number
  /** Pool candidates at least one arm never raised, with the side named. */
  armMissing: { id: string; present: Arm[] }[]
  /** Paired candidates where either side is `not-adjudicated`, `unresolved` or `unjudged`. */
  undecided: { id: string; on: VerdictBucket; off: VerdictBucket }[]
  /** Paired candidates both arms decided as upheld or rejected. The direction denominator. */
  decided: number
}

/** One arm's false positives: upheld findings the sheet calls `not-a-defect`. */
export interface ArmFalsePositives {
  arm: Arm
  runId: string
  /** The denominator, named: every finding this arm upheld. */
  upheld: number
  falsePositives: string[]
  trueDefects: string[]
  truthUnresolved: string[]
  labelMissing: string[]
  /** Upheld ids the prefix record's canonical pool does not hold, so no slot covers them. */
  outsidePool: string[]
}

/**
 * The partition's own arithmetic, CHECKED rather than asserted.
 *
 * The report prints a line saying every candidate is accounted for once. That
 * line was prose over two numbers nothing compared, so a partition that lost a
 * candidate would have printed its own invariant beside the evidence breaking
 * it. `agree` is the comparison; the renderer prints the failure loudly instead
 * of the claim.
 */
export interface Accounting {
  accounted: number
  pool: number
  agree: boolean
}

export type TruthRead =
  | { kind: "unavailable"; reasons: string[] }
  | { kind: "refused"; reasons: string[] }
  | {
      kind: "labelled"
      file: string
      prefixRunId: string
      /** Pool candidates with a row, of the pool. */
      labelCoverage: { rows: number; of: number }
      directions: Record<DirectionKey, string[]>
      unchanged: string[]
      labelMissing: string[]
      truthUnresolved: string[]
      accounting: Accounting
      /** Both arms, by name. `readBlock` returns no `read` block without a pair. */
      falsePositives: { on: ArmFalsePositives; off: ArmFalsePositives }
      candidates: CandidateAccount[]
    }

/**
 * One block, as THREE states.
 *
 * `refused` is `loadPrefixRecord`'s: a record that IS there and is bound to
 * something else — another run id, another roster, a path escaping the bundle.
 * `unavailable` is a record that is not there, or one nothing could parse.
 * Folding them printed a containment escape under the same heading as a missing
 * file, which is the collapse this module argues against one level down.
 */
export type BlockRead =
  | { kind: "unavailable"; reasons: string[] }
  | { kind: "refused"; reasons: string[] }
  | { kind: "read"; prefixRunId: string; recordFile: string; verdicts: VerdictAccount; truth: TruthRead }

export interface AdjudicationBlock {
  block: number
  result: BlockRead
}

/** What a summarised quantity counts, as data rather than as its label's wording. */
export type AdjudicationQuantity = (typeof ADJUDICATION_QUANTITIES)[number]["label"]

/**
 * The quantities summarised across blocks, each on its own.
 *
 * `verdict` quantities need no sheet, so they observe every block whose prefix
 * record and pair read. `truth` quantities need one, so a block with no sheet is
 * missing from them with its reason — which is the whole point of splitting the
 * list: a bundle with no sheet still publishes how many candidates nobody
 * decided, and publishes nothing about who was right.
 */
export const ADJUDICATION_QUANTITIES = [
  ...DIRECTIONS.map((direction) => ({ label: direction.label, source: "truth" as const, direction: direction.key })),
  { label: "unchanged (decided both sides, same way)", source: "truth" as const, field: "unchanged" as const },
  { label: "label missing", source: "truth" as const, field: "label-missing" as const },
  { label: "truth unresolved", source: "truth" as const, field: "truth-unresolved" as const },
  { label: "on false positives", source: "truth" as const, arm: "on" as const },
  { label: "off false positives", source: "truth" as const, arm: "off" as const },
  { label: "undecided transitions", source: "verdict" as const, field: "undecided" as const },
  { label: "candidates missing from an arm", source: "verdict" as const, field: "arm-missing" as const },
] as const

export interface AdjudicationSummary {
  quantity: AdjudicationQuantity
  observed: number
  of: number
  missing: { block: number; reason: string }[]
  values: number[]
}

export interface AdjudicationExclusion {
  armId: string
  repeatId: number
  reason: string
}

export interface AdjudicationReadResult {
  kind: "read"
  root: string
  scheduleHash: string
  sheet: SheetRead
  /**
   * Which matcher produced the SUGGESTIONS below. No count moves with it, and
   * the report says so rather than leaving a reader to assume either way.
   */
  matcher: "shipped-lexical" | "injected"
  excluded: AdjudicationExclusion[]
  blocks: AdjudicationBlock[]
  summaries: AdjudicationSummary[]
}

export type AdjudicationReadOutcome =
  | { kind: "not-applicable"; why: string }
  | { kind: "schedule-refused"; reason: string }
  | AdjudicationReadResult

export interface AdjudicationReadOptions {
  /** Injected, with the shipped lexical default, exactly as `fixtures/recall.ts` injects it. */
  matcher?: DefectMatcher
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

export async function readAdjudicationBundle(
  paired: PairedReadResult,
  options: AdjudicationReadOptions = {},
): Promise<AdjudicationReadOutcome> {
  const matcher = options.matcher ?? lexicalDefectMatcher
  if (!paired.bundle.sealedSchedule) {
    return { kind: "not-applicable", why: "the bundle carries no sealed paired schedule" }
  }
  if (!paired.schedule.ok) return { kind: "schedule-refused", reason: paired.schedule.reason }
  const schedule = paired.schedule.schedule

  const sheet = await readSheet(paired.root, schedule)
  const blocks: AdjudicationBlock[] = []
  for (const block of paired.blocks) {
    blocks.push({ block: block.block, result: await readBlock(paired.root, schedule, block, sheet, matcher) })
  }
  return {
    kind: "read",
    root: paired.root,
    scheduleHash: schedule.scheduleHash,
    sheet,
    matcher: options.matcher === undefined ? "shipped-lexical" : "injected",
    excluded: allExcluded(paired).map((entry) => ({
      armId: entry.armId,
      repeatId: entry.repeatId,
      reason: entry.reason,
    })),
    blocks,
    summaries: summarize(blocks),
  }
}

async function readBlock(
  root: string,
  schedule: PairedSchedule,
  block: PairedBlock,
  sheet: SheetRead,
  matcher: DefectMatcher,
): Promise<BlockRead> {
  if (block.result.kind === "withheld") {
    return { kind: "unavailable", reasons: block.result.reasons.map((reason) => `the paired block is withheld: ${reason}`) }
  }
  const on = block.arms.find((arm) => arm.arm === "on")
  const off = block.arms.find((arm) => arm.arm === "off")
  if (on === undefined || off === undefined) {
    return { kind: "unavailable", reasons: ["the paired reader bound no `on` and `off` pair for this block"] }
  }

  const loaded = await loadPrefixRecord(root, schedule, block)
  if (loaded.kind !== "loaded") {
    // `loadPrefixRecord`'s own two states are carried through, not folded: a
    // record bound to another run is refused, a record that is not there is
    // unavailable.
    return { kind: loaded.kind, reasons: loaded.reasons.map((reason) => `the prefix record is ${loaded.kind}: ${reason}`) }
  }
  const pool = loaded.record.canonical
  if (pool.kind !== "read") {
    return {
      kind: "unavailable",
      reasons: [`the prefix record \`${loaded.file}\` holds no readable canonical pool: ${pool.why}`],
    }
  }

  const onById = byId(on.row.findings)
  const offById = byId(off.row.findings)
  const verdicts = account(pool.findings, onById, offById)
  const truth = labelled(loaded.record.runId, loaded.file, pool, sheet, block.block, verdicts, onById, offById, matcher, {
    on: { arm: "on", runId: on.row.manifest.run.runId, findings: on.row.findings },
    off: { arm: "off", runId: off.row.manifest.run.runId, findings: off.row.findings },
  })
  return { kind: "read", prefixRunId: loaded.record.runId, recordFile: loaded.file, verdicts, truth }
}

function byId(findings: readonly Finding[]): Map<string, Finding> {
  // `fromPersistedFindings` already refused a pool with two findings of one id,
  // so this map loses nothing.
  return new Map(findings.map((finding) => [finding.id, finding]))
}

/** The label-free half: who raised what, and who decided it which way. */
function account(pool: readonly Finding[], onById: Map<string, Finding>, offById: Map<string, Finding>): VerdictAccount {
  const armMissing: VerdictAccount["armMissing"] = []
  const undecided: VerdictAccount["undecided"] = []
  let paired = 0
  let decided = 0
  for (const candidate of pool) {
    const onFinding = onById.get(candidate.id)
    const offFinding = offById.get(candidate.id)
    if (onFinding === undefined || offFinding === undefined) {
      const present: Arm[] = []
      if (onFinding !== undefined) present.push("on")
      if (offFinding !== undefined) present.push("off")
      armMissing.push({ id: candidate.id, present })
      continue
    }
    paired += 1
    const on = verdictBucket(verdictState(onFinding))
    const off = verdictBucket(verdictState(offFinding))
    if (!directional(on) || !directional(off)) {
      undecided.push({ id: candidate.id, on, off })
      continue
    }
    decided += 1
  }
  return { pool: pool.length, paired, armMissing, undecided, decided }
}

// ---------------------------------------------------------------------------
// The truth half
// ---------------------------------------------------------------------------

interface ArmFindings {
  arm: Arm
  runId: string
  findings: readonly Finding[]
}

function labelled(
  prefixRunId: string,
  recordFile: string,
  pool: Extract<FindingList, { kind: "read" }>,
  sheet: SheetRead,
  block: number,
  verdicts: VerdictAccount,
  onById: Map<string, Finding>,
  offById: Map<string, Finding>,
  matcher: DefectMatcher,
  arms: { on: ArmFindings; off: ArmFindings },
): TruthRead {
  if (sheet.kind === "absent") return { kind: "unavailable", reasons: [sheet.why] }
  if (sheet.kind === "unreadable") return { kind: "unavailable", reasons: [sheet.why] }
  if (sheet.kind === "malformed") return { kind: "unavailable", reasons: [`the sheet \`${sheet.file}\` is malformed: ${sheet.why}`] }
  if (sheet.kind === "refused") return { kind: "refused", reasons: [`the sheet \`${sheet.file}\` is refused: ${sheet.why}`] }

  const page = sheet.blocks.find((entry) => entry.block === block)
  if (page === undefined) {
    // A stray page is named here rather than only at the top of the report,
    // because a page that says `block: 9` is usually the page that was meant for
    // this one, and the two facts are only useful together.
    const strays =
      sheet.strayPages.length === 0
        ? ""
        : `; the sheet carries ${sheet.strayPages.length} page(s) naming no planned block ` +
          `(${sheet.strayPages.map((stray) => `\`blocks[${stray.at}].block\` = ${stray.block}`).join(", ")})`
    return { kind: "unavailable", reasons: [`the sheet \`${sheet.file}\` carries no page for block ${block}${strays}`] }
  }
  if (page.prefixRunId !== prefixRunId) {
    return {
      kind: "refused",
      reasons: [
        `the sheet \`${sheet.file}\` labels block ${block} against prefix run \`${page.prefixRunId}\`, and this block's ` +
          `verified prefix record \`${recordFile}\` is run \`${prefixRunId}\`; it is a sheet about another execution`,
      ],
    }
  }

  const poolIds = new Set(pool.findings.map((finding) => finding.id))
  const rows = new Map<string, SheetRow>()
  const duplicates: string[] = []
  const strays: string[] = []
  for (const row of page.rows) {
    // NEITHER OVERWRITTEN NOR DROPPED. A second row for one candidate is two
    // humans disagreeing, or one sheet edited twice, and picking either row
    // would publish a truth label nobody agreed on.
    if (rows.has(row.candidateId)) duplicates.push(row.candidateId)
    else rows.set(row.candidateId, row)
    if (!poolIds.has(row.candidateId)) strays.push(row.candidateId)
  }
  const reasons: string[] = []
  if (duplicates.length > 0) {
    reasons.push(`it carries more than one row for candidate(s) ${quoted(new Set(duplicates))}`)
  }
  if (strays.length > 0) {
    reasons.push(
      `it carries row(s) for ${quoted(new Set(strays))}, which the block's prefix pool of ${poolIds.size} canonical ` +
        `candidate(s) does not hold`,
    )
  }
  if (reasons.length > 0) {
    return { kind: "refused", reasons: reasons.map((reason) => `the sheet \`${sheet.file}\` is refused: ${reason}`) }
  }

  // ONE PASS OF THE MATCHER OVER THE WHOLE CANONICAL POOL, so a candidate's
  // suggestion does not depend on which arm it is read through. It labels
  // nothing; it only says which planted defect a lexical matcher would have
  // associated, for a human to check the sheet against.
  const suggestions = suggest(pool.findings, matcher)

  const directions: Record<DirectionKey, string[]> = {
    "false-upheld-to-rejected": [],
    "true-rejected-to-upheld": [],
    "true-upheld-to-rejected": [],
    "false-rejected-to-upheld": [],
  }
  const unchanged: string[] = []
  const labelMissing: string[] = []
  const truthUnresolved: string[] = []
  const candidates: CandidateAccount[] = []

  for (const finding of pool.findings) {
    const id = finding.id
    const row = rows.get(id)
    const label = row?.truth ?? null
    const suggested = suggestions.get(id) ?? null
    // A CONTRADICTION IS ANY LABEL THAT IS NOT `true-defect`. `not-a-defect`
    // contradicts the association outright; `unresolved` contradicts it too — the
    // matcher says a planted defect claims this candidate and the human could not
    // establish it either way. Both are kept, and both are shown. A candidate
    // with no row at all is not a contradiction: nobody labelled it.
    const disagreement =
      suggested !== null && (label === "not-a-defect" || label === "unresolved")
        ? `the lexical matcher associated planted defect \`${suggested}\`, and the sheet labels it ${label}; ` +
          "the human label is kept and the association is printed for inspection"
        : null
    const onFinding = onById.get(id)
    const offFinding = offById.get(id)
    const on = onFinding === undefined ? null : verdictBucket(verdictState(onFinding))
    const off = offFinding === undefined ? null : verdictBucket(verdictState(offFinding))
    const present: Arm[] = []
    if (onFinding !== undefined) present.push("on")
    if (offFinding !== undefined) present.push("off")
    const base = { id, present, on, off, label, suggested, disagreement }

    let outcome: CandidateOutcome
    if (on === null || off === null) {
      outcome = { kind: "arm-missing" }
    } else if (!directional(on) || !directional(off)) {
      outcome = { kind: "undecided" }
    } else if (label === null) {
      outcome = { kind: "label-missing" }
      labelMissing.push(id)
    } else if (label === "unresolved") {
      outcome = { kind: "truth-unresolved" }
      truthUnresolved.push(id)
    } else if (on === off) {
      outcome = { kind: "unchanged", state: on }
      unchanged.push(id)
    } else {
      const direction = directionOf(label, on, off)
      // Unreachable: `label` is one of the two decisive labels here and both
      // buckets are directional and differ, which is exactly the four rows of
      // `DIRECTIONS`. It is a typed outcome rather than a `!` so a fifth label
      // added to `TRUTH_LABELS` later cannot silently vanish from the table.
      if (direction === null) {
        outcome = { kind: "label-missing" }
        labelMissing.push(id)
      } else {
        outcome = { kind: "transition", direction }
        directions[direction].push(id)
      }
    }
    candidates.push({ ...base, outcome })
  }

  const transitions = DIRECTIONS.reduce((total, direction) => total + directions[direction.key].length, 0)
  const accounted =
    transitions +
    unchanged.length +
    labelMissing.length +
    truthUnresolved.length +
    verdicts.undecided.length +
    verdicts.armMissing.length
  return {
    kind: "labelled",
    file: sheet.file,
    prefixRunId,
    // Every remaining row is in the pool: an out-of-pool row refused the block
    // above, so this is a count of rows, not a filtered one.
    labelCoverage: { rows: rows.size, of: poolIds.size },
    directions,
    unchanged,
    labelMissing,
    truthUnresolved,
    accounting: { accounted, pool: poolIds.size, agree: accounted === poolIds.size },
    falsePositives: {
      on: falsePositivesOf(arms.on, rows, poolIds),
      off: falsePositivesOf(arms.off, rows, poolIds),
    },
    candidates,
  }
}

/**
 * One arm's false positives: findings it UPHELD that the sheet calls
 * `not-a-defect`.
 *
 * Never derived from the labelled report's `U`, and never a default for an
 * unlabelled finding — `evaluation-protocol.md:130`: a finding matching no
 * planted label is not proof of a false positive. An upheld finding with no row
 * is `label missing` and is counted as such, on its own line, beside the
 * denominator it came out of.
 */
function falsePositivesOf(arm: ArmFindings, rows: Map<string, SheetRow>, poolIds: ReadonlySet<string>): ArmFalsePositives {
  const upheld = arm.findings.filter((finding) => verdictBucket(verdictState(finding)) === "upheld")
  const result: ArmFalsePositives = {
    arm: arm.arm,
    runId: arm.runId,
    upheld: upheld.length,
    falsePositives: [],
    trueDefects: [],
    truthUnresolved: [],
    labelMissing: [],
    outsidePool: [],
  }
  for (const finding of upheld) {
    if (!poolIds.has(finding.id)) {
      result.outsidePool.push(finding.id)
      continue
    }
    const row = rows.get(finding.id)
    if (row === undefined) result.labelMissing.push(finding.id)
    else if (row.truth === "not-a-defect") result.falsePositives.push(finding.id)
    else if (row.truth === "true-defect") result.trueDefects.push(finding.id)
    else result.truthUnresolved.push(finding.id)
  }
  return result
}

/** Candidate id → the planted defect a lexical matcher would associate. Evidence, not a label. */
function suggest(findings: readonly Finding[], matcher: DefectMatcher): Map<string, string> {
  try {
    const partition = adjudicate(SEEDED_DEFECTS, findings, matcher)
    return new Map(partition.matched.map((match) => [match.finding.id, match.defectId]))
  } catch {
    // A suggestion is a convenience for a human checking the sheet. It decides
    // nothing, so a matcher that threw withholds the column and leaves every
    // count below exactly where it was.
    return new Map()
  }
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

function summarize(blocks: readonly AdjudicationBlock[]): AdjudicationSummary[] {
  return ADJUDICATION_QUANTITIES.map((quantity) => {
    const missing: { block: number; reason: string }[] = []
    const values: number[] = []
    const prefixesSeen = new Map<string, number>()
    for (const number of PAIRED_BLOCKS) {
      const block = blocks.find((entry) => entry.block === number)
      if (block === undefined) {
        missing.push({ block: number, reason: `the paired reader returned no block ${number}` })
        continue
      }
      const observation = observe(block.result, quantity)
      if (typeof observation === "string") {
        missing.push({ block: number, reason: observation })
        continue
      }
      // ONE PREFIX RUN IS ONE OBSERVATION, the labelled reader's rule and for its
      // reason: every quantity here is derived from a block's shared discovery
      // prefix, so two blocks naming one `prefixRunId` would put one pass into a
      // mean, a min and a max twice and report three observations of two.
      if (block.result.kind === "read") {
        const earlier = prefixesSeen.get(block.result.prefixRunId)
        if (earlier !== undefined) {
          missing.push({
            block: number,
            reason: `it reads prefix \`${block.result.prefixRunId}\`, which block ${earlier} already supplied; a shared prefix is one observation`,
          })
          continue
        }
        prefixesSeen.set(block.result.prefixRunId, number)
      }
      values.push(observation)
    }
    return { quantity: quantity.label, observed: values.length, of: PAIRED_BLOCKS.length, missing, values }
  })
}

/** One block's value for one quantity, or why it has none. */
function observe(result: BlockRead, quantity: (typeof ADJUDICATION_QUANTITIES)[number]): number | string {
  if (result.kind !== "read") return result.reasons.join("; ")
  if (quantity.source === "verdict") {
    return quantity.field === "undecided" ? result.verdicts.undecided.length : result.verdicts.armMissing.length
  }
  const truth = result.truth
  if (truth.kind !== "labelled") return truth.reasons.join("; ")
  if ("direction" in quantity) return truth.directions[quantity.direction].length
  if ("arm" in quantity) return truth.falsePositives[quantity.arm].falsePositives.length
  if (quantity.field === "unchanged") return truth.unchanged.length
  if (quantity.field === "label-missing") return truth.labelMissing.length
  return truth.truthUnresolved.length
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

/** How many candidate ids are named per line before the rest are counted. */
const NAMED_IDS = 5

const ESTIMANDS = [
  "ESTIMANDS — beside every number below",
  "  DIRECTION READS OFF → ON, because the protocol defines the pair difference as ON minus OFF",
  "  (`evaluation-protocol.md:123-126`). The randomized first-arm order does not change it.",
  "  A TRUTH LABEL IS A HUMAN'S, from the sheet. The planted-label matcher only SUGGESTS; a suggestion",
  "  enters no count, and a human label that contradicts one is kept with the contradiction printed.",
  "  `not-adjudicated` is NEVER rejected. It is the judge saying the evidence does not settle the claim,",
  "  and the aggregator also writes it on drop-out, so `upheld → not-adjudicated` is not noise removal.",
  "  TRUTH-`unresolved` AND VERDICT-`unresolved` ARE DIFFERENT FACTS and are printed apart.",
  "  Nothing here is a precision, a recall, a cost or a product-value claim.",
  "",
]

export function renderAdjudicationBundle(outcome: AdjudicationReadOutcome): string {
  if (outcome.kind === "not-applicable") return ""
  if (outcome.kind === "schedule-refused") {
    return (
      "MAD ADJUDICATION — NOT READ: the paired reader refused the sealed schedule, and that refusal stands.\n" +
      `  ${outcome.reason}\n`
    )
  }

  const lines: string[] = [`MAD ADJUDICATION — ${outcome.root}`, `sealed schedule ${outcome.scheduleHash}`]
  lines.push(...sheetLines(outcome.sheet), ...ESTIMANDS)

  lines.push(
    "MATCHER — for the SUGGESTION column only, and no count moves with it",
    outcome.matcher === "shipped-lexical"
      ? "  the shipped lexical defect matcher"
      : "  INJECTED — not the shipped lexical matcher. Every count below is unchanged by this; only suggestions are.",
    "",
  )

  if (outcome.excluded.length > 0) {
    lines.push("ARMS THE PAIRED READER DID NOT BIND — out of this report, and refusing nothing")
    for (const entry of outcome.excluded) lines.push(`  ${entry.armId}/${entry.repeatId} — ${entry.reason}`)
    lines.push("")
  }

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
    "WHAT THIS REPORT DOES NOT MEASURE. No precision, no precision bound, no final recall, no cost contrast and no",
    "earned / did-not-earn reading — those are story 2.8's, under the frozen protocol's bound arithmetic. The",
    "labelled report's U is not a truth label and no number here was derived from it. This report prints and gates",
    "nothing.",
  )
  return `${lines.join("\n")}\n`
}

function sheetLines(sheet: SheetRead): string[] {
  if (sheet.kind === "read") {
    const lines = [
      `truth sheet \`${sheet.file}\`, version ${ADJUDICATION_SHEET_VERSION}, bound to this bundle's sealed schedule`,
      `  it carries a page for block(s) ${sheet.blocks.map((entry) => entry.block).join(", ") || "none"}`,
    ]
    if (sheet.strayPages.length > 0) {
      lines.push(
        `  SHEET PAGES NAMING NO PLANNED BLOCK — refused, and refusing nothing else. The schedule plans ` +
          `${PAIRED_BLOCKS.join(", ")}.`,
      )
      for (const stray of sheet.strayPages) lines.push(`    \`blocks[${stray.at}].block\` is ${stray.block}`)
    }
    lines.push("")
    return lines
  }
  const head =
    sheet.kind === "absent"
      ? "NO TRUTH SHEET — every truth-dependent quantity below is unavailable. The verdict-only counts still read."
      : sheet.kind === "unreadable"
        ? "THE TRUTH SHEET COULD NOT BE READ — a sheet may well be there. This is NOT a sheet nobody wrote."
        : sheet.kind === "malformed"
          ? "THE TRUTH SHEET IS MALFORMED — distinct from absent. No truth-dependent quantity is computed from it."
          : "THE TRUTH SHEET IS REFUSED — it is not this bundle's sheet."
  return [head, `  ${sheet.why}`, ""]
}

function renderBlock(block: AdjudicationBlock): string[] {
  const lines = [`BLOCK ${block.block}`]
  const result = block.result
  if (result.kind !== "read") {
    lines.push(`  ${result.kind.toUpperCase()}:`)
    for (const reason of result.reasons) lines.push(`    ${reason}`)
    lines.push("")
    return lines
  }

  const verdicts = result.verdicts
  lines.push(
    `  prefix run \`${result.prefixRunId}\`, record \`${result.recordFile}\``,
    `  truth pool: ${verdicts.pool} canonical candidate(s) of the shared discovery prefix — every one of them gets a slot`,
    `  paired in both arms: ${verdicts.paired} of ${verdicts.pool}`,
    `  candidates missing from an arm: ${verdicts.armMissing.length} of ${verdicts.pool} — never a transition`,
  )
  for (const entry of verdicts.armMissing.slice(0, NAMED_IDS)) {
    const present = entry.present.length === 0 ? "neither arm raised it" : `raised only by ${entry.present.join(", ")}`
    lines.push(`    \`${entry.id}\` — ${present}`)
  }
  if (verdicts.armMissing.length > NAMED_IDS) lines.push(`    … and ${verdicts.armMissing.length - NAMED_IDS} more`)

  lines.push(`  undecided transitions: ${verdicts.undecided.length} of ${verdicts.paired} paired — counted on their own`)
  for (const entry of verdicts.undecided.slice(0, NAMED_IDS)) {
    lines.push(`    \`${entry.id}\` — on ${entry.on}, off ${entry.off} (verdict axis)`)
  }
  if (verdicts.undecided.length > NAMED_IDS) lines.push(`    … and ${verdicts.undecided.length - NAMED_IDS} more`)
  lines.push(`  decided both sides: ${verdicts.decided} of ${verdicts.paired} paired — the direction denominator`)

  const truth = result.truth
  if (truth.kind !== "labelled") {
    lines.push(`  TRUTH LABELS ${truth.kind.toUpperCase()}:`)
    for (const reason of truth.reasons) lines.push(`    ${reason}`)
    lines.push("")
    return lines
  }

  lines.push(
    `  truth sheet \`${truth.file}\`, block page bound to prefix run \`${truth.prefixRunId}\``,
    `  label coverage: ${truth.labelCoverage.rows} of ${truth.labelCoverage.of} pool candidate(s) have a row`,
    "  THE FOUR DIRECTIONS, each counted separately, over the candidates decided both sides",
  )
  for (const direction of DIRECTIONS) {
    const ids = truth.directions[direction.key]
    lines.push(
      `    ${direction.label}: ${ids.length} of ${verdicts.decided} decided — ${direction.reading}` +
        idsText(ids, direction.nameAll),
    )
  }
  lines.push(
    `    unchanged (decided both sides, same way): ${truth.unchanged.length} of ${verdicts.decided} decided`,
    `    label missing: ${truth.labelMissing.length} of ${verdicts.decided} decided — excluded from the four directions`,
    `    truth unresolved (the sheet kept it): ${truth.truthUnresolved.length} of ${verdicts.decided} decided — excluded too`,
    ...accountingLines(truth.accounting),
    "  FALSE POSITIVES PER ARM — upheld findings the sheet calls not-a-defect, never derived from U",
  )
  for (const arm of [truth.falsePositives.on, truth.falsePositives.off]) {
    lines.push(
      `    arm ${arm.arm}, run \`${arm.runId}\`: ${arm.falsePositives.length} of ${arm.upheld} upheld ` +
        `finding(s)${idsText(arm.falsePositives)}`,
      `      true-defect: ${arm.trueDefects.length} of ${arm.upheld}; truth unresolved: ${arm.truthUnresolved.length} ` +
        `of ${arm.upheld}; label missing: ${arm.labelMissing.length} of ${arm.upheld}`,
    )
    if (arm.outsidePool.length > 0) {
      lines.push(
        `      upheld ids the prefix pool does not hold, so no slot covers them: ${arm.outsidePool.length} of ` +
          `${arm.upheld}${idsText(arm.outsidePool)}`,
      )
    }
  }

  // THE SUGGESTION COLUMN, printed in full, because both operator documents say
  // it is there and a column that exists only when it contradicts the sheet is a
  // column a reader cannot check the agreeing rows against.
  lines.push("  LABEL AND SUGGESTION, PER CANDIDATE — the suggestion is the matcher's and enters no count above")
  for (const candidate of truth.candidates) {
    const label = candidate.label === null ? "no row" : candidate.label
    const suggested = candidate.suggested === null ? "none" : `\`${candidate.suggested}\``
    lines.push(`    \`${candidate.id}\`: label ${label}, suggestion ${suggested}, ${outcomeText(candidate)}`)
  }

  const disagreements = truth.candidates.filter((candidate) => candidate.disagreement !== null)
  if (disagreements.length > 0) {
    lines.push("  THE SHEET DISAGREES WITH THE MATCHER — the human label is kept, and the association is here to inspect")
    for (const candidate of disagreements) lines.push(`    \`${candidate.id}\` — ${candidate.disagreement}`)
  }
  lines.push("")
  return lines
}

/** One candidate's bucket, in the words the counts above use. */
function outcomeText(candidate: CandidateAccount): string {
  const outcome = candidate.outcome
  if (outcome.kind === "transition") return DIRECTIONS.find((entry) => entry.key === outcome.direction)!.label
  if (outcome.kind === "unchanged") return `unchanged (${outcome.state} both sides)`
  if (outcome.kind === "undecided") return `undecided (on ${candidate.on}, off ${candidate.off})`
  if (outcome.kind === "arm-missing") {
    return candidate.present.length === 0 ? "missing from both arms" : `missing from an arm (raised only by ${candidate.present.join(", ")})`
  }
  return outcome.kind === "label-missing" ? "label missing" : "truth unresolved"
}

/**
 * The accounting line, or the failure of the invariant it used to assert.
 *
 * The success wording is checked arithmetic and not prose: `agree` compared the
 * two numbers before this ran.
 */
function accountingLines(accounting: Accounting): string[] {
  if (accounting.agree) {
    return [
      "  EVERY CANDIDATE IS ACCOUNTED FOR ONCE: transitions + unchanged + label missing + truth unresolved +",
      `  undecided + arm missing = ${accounting.accounted}, and the truth pool holds ${accounting.pool} — they agree`,
    ]
  }
  return [
    "  ACCOUNTING BROKEN — THIS REPORT'S PARTITION DOES NOT COVER ITS POOL. The buckets sum to " +
      `${accounting.accounted} and the truth pool holds ${accounting.pool}.`,
    "  A candidate in no bucket, or in two, makes every count above unreliable. Do not read them.",
  ]
}

/** `nameAll` prints every id; otherwise the list is capped and the rest counted. */
function idsText(ids: readonly string[], nameAll = false): string {
  if (ids.length === 0) return ""
  if (nameAll || ids.length <= NAMED_IDS) return ` (${ids.map((id) => `\`${id}\``).join(", ")})`
  const named = ids.slice(0, NAMED_IDS).map((id) => `\`${id}\``).join(", ")
  return ` (${named}, … and ${ids.length - NAMED_IDS} more)`
}

function quoted(ids: Iterable<string>): string {
  const list = [...ids]
  return list.length === 0 ? "none" : list.map((id) => `\`${id}\``).join(", ")
}

// ---------------------------------------------------------------------------
// Small shared checks
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT"
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
