/**
 * Story 2-8a — THE EVALUATION REPORT: the frozen protocol's reporting contract
 * (`evaluation-protocol.md` v1 §3, §4 and §6), composed from the three readers
 * that already ran.
 *
 * It takes the paired, labelled and adjudication results, each as a result or as
 * the error its reader threw, and adds the arithmetic none of them does:
 * execution coverage, per-pair precision as a point, a bound or undefined, the
 * pair-difference bound, the observed spread over the three pairs, planted-defect
 * matcher recall with the lost true candidates named, the per-block cost
 * contrast, and the treatment opportunity.
 *
 * It bills nothing, runs no model, and calls none of `runPairedBlocks`,
 * `createSchedule` or `openJournal`. It opens no file: everything it reports was
 * already read by the upstream readers, and it re-derives none of their counts.
 * It prints and never gates; `eval-read` still returns 0. Every entry point
 * returns a typed result and nothing throws.
 *
 * ## COMPOSE, NEVER RE-DERIVE
 *
 * Per arm, TP, FP and U come from the adjudication reader's `ArmFalsePositives`:
 * TP is `trueDefects`, FP is `falsePositives`, and U is `truthUnresolved +
 * labelMissing + outsidePool`, over N = `upheld`. An upheld id outside the
 * prefix pool has no label slot, so it is unlabelled: never true, and never
 * dropped from N.
 *
 * ## PRECISION: A POINT, A BOUND, OR UNDEFINED
 *
 * A point `TP/(TP+FP)` prints only when U = 0. Otherwise the arm's precision
 * lies in `[TP/N, (TP+U)/N]`. N = 0 is UNDEFINED — not 100%, not a clean list —
 * and no interval formula repairs it (`evaluation-protocol.md:133-162`).
 *
 * ## THE PAIR BOUND: SHARED-LABEL PRIMARY, OUTER SECONDARY
 *
 * A candidate both arms upheld has ONE truth label. The primary bound is
 * `[K + Σmin(0,a_i), K + Σmax(0,a_i)]` over the DISTINCT unlabelled ids upheld
 * in either arm, with `K = TP_on/N_on − TP_off/N_off` and
 * `a_i = 1[i upheld ON]/N_on − 1[i upheld OFF]/N_off`
 * (`evaluation-protocol.md:137-146`). `[L_on − U_off, U_on − L_off]` is printed
 * too, labelled OUTER: it lets one claim carry two labels, so it can span zero
 * where the difference is identically 0. Both are identification bounds, never
 * confidence intervals. The sign statement reads the primary bound only.
 *
 * ## COST IS OBSERVED PER BLOCK, AND IT IS NOT THE EXPERIMENT'S BILL
 *
 * Each block prints its shared prefix once and each continuation's newly
 * executed tokens and turns. The prefix cancels in ON − OFF only when both arms
 * are established to have inherited ONE execution. An unknown in a continuation
 * never cancels and is never subtracted. The unique-execution bill is the
 * journal's (`paired-journal.jsonl`), and no block figure here is summed into an
 * experiment total.
 *
 * ## ATTEMPT MODE (story 2-8c3a)
 *
 * A bundle whose sealed schedule and arm manifests say `accounting: "attempts"`
 * reports protocol v2's draft cost endpoint instead: *newly issued MAD attempts*,
 * shared prefix + ON continuation + OFF continuation, with ON − OFF over the
 * continuations, split by stage and slot, the model named from the manifest
 * roster and retries (`attempt > 1`) shown apart. The counts come from the
 * persisted journal, handed in already replayed and validated by
 * `ablation/journal-read.ts`; this module still opens no file. It is a
 * workflow-use contrast: never token cost, money, subscription quota or a
 * physical request count, and host-reported tokens enter no figure. A bundle
 * whose schedule and arms disagree about the mode, whose mode cannot be
 * established (no evidence, or an attempt-mode seal under a protocol that is not
 * version 2), or whose journal was refused, gets no cost figure. A token-mode bundle keeps the token endpoint above.
 *
 * ## WHAT IT DOES NOT DO
 *
 * No significance claim, no pooled precision across blocks, and no product-value
 * reading (`evaluation-protocol.md` §6).
 */

import { SEEDED_DEFECTS } from "../fixtures/seeded-defects/labels.ts"
import type { AdjudicationReadOutcome, ArmFalsePositives, BlockRead, VerdictBucket } from "./adjudication-read.ts"
import { countText } from "./cross-arm-rates.ts"
import {
  add,
  average,
  compare,
  fraction,
  fractionText,
  maxOf,
  minOf,
  subtract,
  ZERO,
  type Fraction,
} from "./fraction.ts"
import { ATTEMPT_ALLOWANCES, type PairedPhase } from "./governor.ts"
import { JOURNAL_FILE, type UniqueExecutionBill } from "./journal.ts"
import type { JournalReadOutcome } from "./journal-read.ts"
import type { LabelledReadOutcome } from "./labelled-read.ts"
import { allExcluded, type HaltReport, type PairedArm, type PairedBlock, type PairedReadOutcome, type TreatmentOpportunity } from "./paired-read.ts"
import { ADJUDICATION_READER_MODULE, JOURNAL_READER_MODULE, LABELLED_READER_MODULE, PAIRED_READER_MODULE } from "./report.ts"
import { PAIRED_BLOCKS, SLOT_STATUS_FILE, type Arm } from "./schedule.ts"

// ---------------------------------------------------------------------------
// Upstream results
// ---------------------------------------------------------------------------

/** An upstream reader's result, or the message it threw. */
export type Upstream<T> = { kind: "read"; value: T } | { kind: "threw"; message: string }

/** Run one reader once and keep either its result or its error. Never throws. */
export async function settle<T>(read: () => Promise<T>): Promise<Upstream<T>> {
  try {
    return { kind: "read", value: await read() }
  } catch (error) {
    return { kind: "threw", message: error instanceof Error ? error.message : String(error) }
  }
}

/** The milestone the scripted evidence may support, and nothing more. */
export const REPORTING_MILESTONE = "reporting implementation complete; live evidence pending"

/** The sign statement for a primary bound spanning both signs. */
export const DIRECTION_UNRESOLVED = "this bound does not resolve direction"

/** The treatment statement when normal policy would have debated nothing. */
export const NO_TREATMENT_OPPORTUNITY = "no treatment opportunity — demonstrates neither benefit nor failure"

/** The heading printed in place of the report when no report can be composed at all. */
export const NOT_COMPOSED = "MAD EVALUATION REPORT — NOT COMPOSED"

/** Why a block repeating an earlier block's prefix contributes no per-block quantity. */
export const ONE_PREFIX_ONE_PAIR = "one shared prefix is one pair"

/** The quantities availability is tracked for, each on its own `n/3`. */
export const EVALUATION_QUANTITIES = [
  "precision difference",
  "planted-defect matcher recall change",
  "lost true candidates",
  "cost contrast",
  "treatment opportunity",
] as const
export type EvaluationQuantity = (typeof EVALUATION_QUANTITIES)[number]

// ---------------------------------------------------------------------------
// What the report produces
// ---------------------------------------------------------------------------

export type ProvenanceRead = { kind: "scripted" } | { kind: "live" } | { kind: "unestablished"; reason: string }

export interface Bound {
  lower: Fraction
  upper: Fraction
}

/** One arm's precision. `point` has `lower` equal to `upper`. */
export type ArmPrecision =
  | {
      kind: "point" | "interval"
      arm: Arm
      runId: string
      tp: number
      fp: number
      u: number
      n: number
      /** The unlabelled upheld ids: truth unresolved, label missing, outside the pool. */
      unlabelled: string[]
      bound: Bound
    }
  | { kind: "undefined"; arm: Arm; runId: string; reason: string }
  | { kind: "unavailable"; arm: Arm; runId: string; reason: string }

export type PairDifference =
  | {
      kind: "bounded"
      /** The shared-label bound. A point when `lower` equals `upper`. */
      primary: Bound
      /** `[L_on − U_off, U_on − L_off]`. */
      outer: Bound
      k: Fraction
      /** Distinct unlabelled ids upheld in either arm. */
      sharedUnlabelled: string[]
    }
  | { kind: "undefined"; reason: string }
  | { kind: "unavailable"; reason: string }

export type BlockPrecision =
  | { kind: "read"; on: ArmPrecision; off: ArmPrecision; difference: PairDifference }
  | { kind: "unavailable"; reasons: string[] }

export type Spread =
  | { kind: "points"; values: Fraction[]; mean: Fraction; min: Fraction; max: Fraction }
  | { kind: "bounded"; bounds: Bound[]; mean: Bound; min: Bound; max: Bound }
  | { kind: "unavailable"; missing: { block: number; reason: string }[] }

export type ArmMatcherRecall =
  | { kind: "measured"; arm: Arm; runId: string; found: number; of: number; defectIds: string[] }
  | { kind: "unavailable"; arm: Arm; reason: string }

export interface LostCandidate {
  id: string
  bucket: Exclude<VerdictBucket, "upheld"> | "missing"
}

export type LostTrue =
  | { kind: "read"; trueLabelled: number; on: LostCandidate[]; off: LostCandidate[] }
  | { kind: "unavailable"; reasons: string[] }

export interface BlockRecall {
  on: ArmMatcherRecall
  off: ArmMatcherRecall
  change: { kind: "measured"; delta: number; of: number } | { kind: "unavailable"; reason: string }
  lost: LostTrue
}

/** One slice of a ledger split, with its tokens summed. */
export interface Slice {
  tokens: number
  turns: number
  unknown: number
}

export type ArmCost =
  | {
      kind: "read"
      arm: Arm
      runId: string
      completion: string
      /** Why this arm's spend is incomplete (it threw or stopped part way), or `null`. */
      stopped: string | null
      usageCompleteness: string
      exposure: string
      attributed: Slice
      executedHere: Slice
      inherited: Slice
      /** The inherited tokens by kind, so one shared execution is compared field by field and not by its sum. */
      inheritedKinds: string
      /** Whether the continuation's own usage is complete. */
      continuation: "exact" | "lower-bound"
      /** Why it is only a lower bound. */
      why: string | null
      prefixRunId: string
      forkedFrom: string | null
      inheritedUnknownIds: string[]
    }
  | { kind: "unavailable"; arm: Arm; runId: string | null; reason: string }

export type PrefixCost =
  | { kind: "established"; runId: string; slice: Slice; unknownIds: string[]; audited: boolean }
  | { kind: "not-established"; reasons: string[] }

export type CostContrast =
  | { kind: "exact"; tokens: number; turns: number }
  | { kind: "at-least" | "at-most"; tokens: number; turns: number; reason: string }
  | { kind: "unavailable"; reason: string }

/**
 * The block's execution, prefix once plus both continuations. `observed` names
 * every reason it is not a quantified whole: unknown or unaudited usage, and a
 * continuation that stopped part way.
 */
export type BlockTotal =
  | { kind: "quantified"; tokens: number; turns: number }
  | { kind: "observed"; tokens: number; turns: number; unquantified: string[]; stopped: string[] }
  | { kind: "unavailable"; reason: string }

export type BlockCost =
  | { kind: "unavailable"; reasons: string[]; arms: ArmCost[] }
  | { kind: "read"; on: ArmCost & { kind: "read" }; off: ArmCost & { kind: "read" }; prefix: PrefixCost; contrast: CostContrast; total: BlockTotal }

/** Story 2-8c3a — one phase's newly issued attempts: first attempts and retries apart. */
export interface AttemptCount {
  first: number
  retries: number
  total: number
}

/** Story 2-8c3a — one realised count against its admission threshold. */
export interface AttemptThreshold {
  limit: number
  spent: number
  overshoot: number
}

/** Story 2-8c3a — one stage and slot of one phase, with the model its manifest roster names. */
export interface AttemptRow {
  phase: PairedPhase
  stage: string
  slot: string
  model: string
  /** Where `model` was read from. */
  modelSource: string
  first: number
  retries: number
}

/**
 * Story 2-8c3a — one block's newly issued MAD attempts, from the persisted
 * journal. `not-issued` settlements are excluded, and counted apart.
 */
export type BlockAttempts =
  | {
      kind: "read"
      /** Where the counts were read from. */
      source: string
      prefix: AttemptCount
      on: AttemptCount
      off: AttemptCount
      /**
       * ON − OFF over the two continuations. `differentCaps` is set when either
       * continuation overshot its threshold, so the two arms ran under different
       * realised caps.
       */
      contrast: { kind: "exact"; attempts: number; differentCaps?: string } | { kind: "unavailable"; reason: string }
      /** Each phase's realised count against its threshold, and the block's against 100, from the bill's overshoot. */
      thresholds: { prefix: AttemptThreshold; on: AttemptThreshold; off: AttemptThreshold; block: AttemptThreshold }
      /** Prefix once + ON + OFF. */
      total: number
      rows: AttemptRow[]
      notIssued: number
      /** Attempts that settled with no host-reported usage: a diagnostic, counted in full above. */
      noHostUsage: number
    }
  | { kind: "unavailable"; reason: string }

/** Story 2-8c3a — what a bundle's cost is counted in, read from its sealed schedule and every bound arm. */
export type BundleAccounting =
  | { kind: "tokens" }
  | { kind: "attempts" }
  | { kind: "mixed"; reason: string }
  | { kind: "unestablished"; reason: string }

/** Story 2-8c3a — why an attempt-mode block prints no token cost. */
export const ATTEMPT_MODE_COST =
  "an attempt-mode bundle: its cost endpoint is newly issued MAD attempts (below); host-reported tokens are unverified " +
  "diagnostics and never a cost contrast"

export type DebateRan = { kind: "ran"; debated: number } | { kind: "did-not-run" } | { kind: "unknown"; why: string }

export interface BlockTreatment {
  opportunity: TreatmentOpportunity
  offRunId: string | null
  debate: DebateRan
  onRunId: string | null
}

export interface BlockCoverage {
  block: number
  /** `duplicate` is a measured block repeating an earlier block's prefix; it is not counted completed. */
  state: "measured" | "withheld" | "duplicate" | "absent"
  reasons: string[]
  arms: { arm: Arm; runId: string; completion: string }[]
}

export interface Coverage {
  scheduled: number
  completed: number
  blocks: BlockCoverage[]
  /** Every planned slot that did not complete, with its status and reason. */
  slots: { block: number; arm: Arm; status: string; reason: string }[]
  /** Every arm the paired reader kept out of a pair. */
  excluded: { armId: string; repeatId: number; reason: string }[]
  halt: HaltReport
}

export interface EvaluationBlock {
  block: number
  prefixRunId: string | null
  precision: BlockPrecision
  recall: BlockRecall
  cost: BlockCost
  /** Story 2-8c3a — present only for an attempt-mode bundle. */
  attempts?: BlockAttempts
  treatment: BlockTreatment
}

export interface Availability {
  quantity: EvaluationQuantity
  available: number
  of: number
  missing: { block: number; reason: string }[]
}

export interface EvaluationReport {
  kind: "read"
  root: string
  scheduleHash: string | null
  provenance: ProvenanceRead
  coverage: Coverage
  blocks: EvaluationBlock[]
  spread: Spread
  availability: Availability[]
  /** Upstream readers that threw or refused, named once at the top. */
  upstream: string[]
  /** Story 2-8c3a — present only when the bundle is not a plain token-mode bundle. */
  accounting?: "attempts" | "mixed" | "unestablished"
}

export type EvaluationReportOutcome =
  | { kind: "not-applicable"; why: string }
  | { kind: "unavailable"; reason: string }
  | EvaluationReport

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

/**
 * `journal` is the persisted-journal reader's result (story 2-8c3a). It is read
 * only for an attempt-mode bundle, where it is the source of the cost endpoint;
 * absent there, the endpoint is unavailable.
 */
export function readEvaluationReport(
  paired: Upstream<PairedReadOutcome>,
  labelled: Upstream<LabelledReadOutcome>,
  adjudication: Upstream<AdjudicationReadOutcome>,
  journal?: Upstream<JournalReadOutcome>,
): EvaluationReportOutcome {
  try {
    return compose(paired, labelled, adjudication, journal)
  } catch (error) {
    // Nothing below is expected to throw. If something does, the report still
    // says so rather than taking `eval-read` down with it.
    return { kind: "unavailable", reason: `the evaluation report could not be composed: ${messageOf(error)}` }
  }
}

function compose(
  pairedUp: Upstream<PairedReadOutcome>,
  labelledUp: Upstream<LabelledReadOutcome>,
  adjudicationUp: Upstream<AdjudicationReadOutcome>,
  journalUp: Upstream<JournalReadOutcome> | undefined,
): EvaluationReportOutcome {
  if (pairedUp.kind === "threw") return { kind: "unavailable", reason: `the paired reader threw: ${pairedUp.message}` }
  if ("error" in pairedUp.value) return { kind: "unavailable", reason: `the paired reader refused the bundle: ${pairedUp.value.error}` }
  const paired = pairedUp.value
  if (!paired.bundle.sealedSchedule) return { kind: "not-applicable", why: "the bundle carries no sealed paired schedule" }

  const upstream: string[] = []
  const labelledWhy = labelledProblem(labelledUp)
  if (labelledWhy !== null) upstream.push(`labelled report (\`${LABELLED_READER_MODULE}\`): ${labelledWhy}`)
  const adjudicationWhy = adjudicationProblem(adjudicationUp)
  if (adjudicationWhy !== null) upstream.push(`adjudication report (\`${ADJUDICATION_READER_MODULE}\`): ${adjudicationWhy}`)

  const labelled = labelledUp.kind === "read" && labelledUp.value.kind === "read" ? labelledUp.value : null
  const adjudication = adjudicationUp.kind === "read" && adjudicationUp.value.kind === "read" ? adjudicationUp.value : null
  const scheduleWhy = paired.schedule.ok ? null : `the sealed schedule is refused: ${paired.schedule.reason}`

  const accounting = bundleAccounting(paired)
  let attemptSource: { bill: UniqueExecutionBill; source: string } | { why: string } | null = null
  if (accounting.kind !== "tokens") {
    const journalWhy =
      accounting.kind === "mixed" || accounting.kind === "unestablished"
        ? accounting.reason
        : journalUp === undefined
          ? `the persisted journal was not read (\`${JOURNAL_READER_MODULE}\`)`
          : journalUp.kind === "threw"
            ? `the journal reader threw: ${journalUp.message}`
            : !journalUp.value.ok
              ? `the journal reader refused the journal: ${journalUp.value.reason}`
              : journalUp.value.mode !== "attempts"
                ? `the journal records ${journalUp.value.mode}, not attempts`
                : null
    if (journalWhy !== null) {
      upstream.push(`attempt counts (\`${JOURNAL_READER_MODULE}\`): ${journalWhy}`)
      attemptSource = { why: journalWhy }
    } else if (journalUp?.kind === "read" && journalUp.value.ok) {
      attemptSource = {
        bill: journalUp.value.bill,
        source:
          `\`${JOURNAL_FILE}\`, replayed and validated by \`${JOURNAL_READER_MODULE}\`: each admitted attempt once, under ` +
          "the block and phase its admission was bound to, with `not-issued` settlements excluded",
      }
    }
  }

  const labels = labelled?.seal.labels ?? SEEDED_DEFECTS.length
  const blocks: EvaluationBlock[] = []
  const coverageBlocks: BlockCoverage[] = []
  const prefixSeen = new Map<string, number>()
  for (const number of PAIRED_BLOCKS) {
    const block = paired.blocks.find((entry) => entry.block === number)
    const absent = scheduleWhy ?? `the paired reader returned no block ${number}`

    const prefixRunId = block === undefined ? null : prefixOf(block)
    let duplicate: string | null = null
    // Only a measured block supplies its prefix's one pair. A withheld block is
    // still checked against the prefixes already supplied, but supplies none.
    if (prefixRunId !== null) {
      const earlier = prefixSeen.get(prefixRunId)
      if (earlier !== undefined) {
        duplicate = `it continues prefix \`${prefixRunId}\`, which block ${earlier} already supplied; ${ONE_PREFIX_ONE_PAIR}`
      } else if (block?.result.kind === "measured") {
        prefixSeen.set(prefixRunId, number)
      }
    }
    coverageBlocks.push(coverageOf(number, block, absent, duplicate))

    const adjudicationBlock = adjudication?.blocks.find((entry) => entry.block === number)?.result
    const truthWhy = adjudicationWhy ?? (adjudicationBlock === undefined ? `the adjudication reader returned no block ${number}` : null)
    const labelledBlock = labelled?.blocks.find((entry) => entry.block === number)
    const labelledMissing = labelledWhy ?? (labelledBlock === undefined ? `the labelled reader returned no block ${number}` : null)

    // ONE BLOCK'S FAILURE STAYS IN THAT BLOCK. An unexpected exception while
    // composing one block makes that block's quantities unavailable with the
    // message, and the other blocks still read.
    try {
      blocks.push(
        composeBlock({
          number,
          block,
          absent,
          prefixRunId,
          duplicate,
          labelledArms: labelledBlock?.arms ?? [],
          labelledWhy: labelledMissing,
          labels,
          adjudicationBlock,
          truthWhy,
          ...(attemptSource === null
            ? {}
            : {
                attempts:
                  "why" in attemptSource
                    ? { kind: "unavailable" as const, reason: attemptSource.why }
                    : blockAttempts(attemptSource.bill, attemptSource.source, number, block, paired.slots),
              }),
        }),
      )
    } catch (error) {
      blocks.push(failedBlock(number, prefixRunId, `block ${number} could not be composed: ${messageOf(error)}`))
    }
  }

  const slots = paired.slots
    .filter((slot) => slot.status !== "completed")
    .map((slot) => ({ block: slot.block, arm: slot.arm, status: slot.status, reason: slot.reason }))

  return {
    kind: "read",
    root: paired.root,
    scheduleHash: paired.schedule.ok ? paired.schedule.schedule.scheduleHash : null,
    provenance: provenanceOf(paired),
    coverage: {
      scheduled: PAIRED_BLOCKS.length,
      completed: coverageBlocks.filter((entry) => entry.state === "measured").length,
      blocks: coverageBlocks,
      slots,
      excluded: allExcluded(paired).map((entry) => ({ armId: entry.armId, repeatId: entry.repeatId, reason: entry.reason })),
      halt: paired.halt,
    },
    blocks,
    spread: spreadOf(blocks),
    availability: availabilityOf(blocks),
    upstream,
    ...(accounting.kind === "tokens" ? {} : { accounting: accounting.kind }),
  }
}

interface BlockInput {
  number: number
  block: PairedBlock | undefined
  absent: string
  prefixRunId: string | null
  /** Why this block repeats an earlier block's discovery pass, or `null`. */
  duplicate: string | null
  labelledArms: readonly LabelledArm[]
  labelledWhy: string | null
  labels: number
  adjudicationBlock: BlockRead | undefined
  truthWhy: string | null
  /** Story 2-8c3a — present only for an attempt-mode bundle, and then it replaces the token cost. */
  attempts?: BlockAttempts
}

type LabelledArm = {
  arm: Arm
  runId: string
  result: { kind: "measured"; matches: { defectId: string }[] } | { kind: "unavailable"; reason: string }
}

/**
 * One block's quantities. A block that repeats an earlier block's prefix is one
 * discovery pass counted twice, so every per-block quantity is unavailable with
 * that reason; its arms' own figures still print.
 */
function composeBlock(input: BlockInput): EvaluationBlock {
  const { number, block, absent, prefixRunId, duplicate } = input
  let precision = precisionOf(input.adjudicationBlock, input.truthWhy)
  let recall = recallOf(input.labelledArms, input.labelledWhy, input.labels, input.adjudicationBlock, input.truthWhy)
  let cost: BlockCost =
    input.attempts !== undefined
      ? { kind: "unavailable", reasons: [ATTEMPT_MODE_COST], arms: [] }
      : block === undefined
        ? { kind: "unavailable", reasons: [absent], arms: [] }
        : blockCost(block)
  let attempts = input.attempts
  let treatment = treatmentOf(block, absent)
  if (duplicate !== null) {
    if (precision.kind === "read") precision = { ...precision, difference: { kind: "unavailable", reason: duplicate } }
    recall = { ...recall, change: { kind: "unavailable", reason: duplicate }, lost: { kind: "unavailable", reasons: [duplicate] } }
    const arms = cost.kind === "read" ? [cost.on, cost.off] : cost.arms
    cost = { kind: "unavailable", reasons: [duplicate, ...(cost.kind === "unavailable" ? cost.reasons : [])], arms }
    if (attempts?.kind === "read") attempts = { ...attempts, contrast: { kind: "unavailable", reason: duplicate } }
    treatment = { ...treatment, opportunity: { kind: "unknown", why: duplicate } }
  }
  return { block: number, prefixRunId, precision, recall, cost, ...(attempts === undefined ? {} : { attempts }), treatment }
}

/** A block whose composition threw: every quantity unavailable with the message. */
function failedBlock(number: number, prefixRunId: string | null, reason: string): EvaluationBlock {
  const missing = (arm: Arm): ArmMatcherRecall => ({ kind: "unavailable", arm, reason })
  return {
    block: number,
    prefixRunId,
    precision: { kind: "unavailable", reasons: [reason] },
    recall: {
      on: missing("on"),
      off: missing("off"),
      change: { kind: "unavailable", reason },
      lost: { kind: "unavailable", reasons: [reason] },
    },
    cost: { kind: "unavailable", reasons: [reason], arms: [] },
    treatment: {
      opportunity: { kind: "unknown", why: reason },
      offRunId: null,
      debate: { kind: "unknown", why: reason },
      onRunId: null,
    },
  }
}

/** The observed spread, or its failure as an unavailable reason for every block. */
function spreadOf(blocks: readonly EvaluationBlock[]): Spread {
  try {
    return observedSpread(blocks.map((entry) => ({ block: entry.block, difference: differenceOf(entry.precision) })))
  } catch (error) {
    const reason = `the observed spread could not be computed: ${messageOf(error)}`
    return { kind: "unavailable", missing: PAIRED_BLOCKS.map((block) => ({ block, reason })) }
  }
}

function labelledProblem(up: Upstream<LabelledReadOutcome>): string | null {
  if (up.kind === "threw") return `the labelled reader threw: ${up.message}`
  const outcome = up.value
  if (outcome.kind === "read") return null
  if (outcome.kind === "not-applicable") return `the labelled reader did not apply: ${outcome.why}`
  if (outcome.kind === "schedule-refused") return `the labelled reader refused the sealed schedule: ${outcome.reason}`
  const problems = outcome.problems.map((problem) => `${problem.subject} ${problem.field} is ${problem.actual}, expected ${problem.expected}`)
  return `the labelled reader refused this bundle as the sealed labelled change: ${problems.join("; ")}`
}

function adjudicationProblem(up: Upstream<AdjudicationReadOutcome>): string | null {
  if (up.kind === "threw") return `the adjudication reader threw: ${up.message}`
  const outcome = up.value
  if (outcome.kind === "read") return null
  if (outcome.kind === "not-applicable") return `the adjudication reader did not apply: ${outcome.why}`
  return `the adjudication reader refused the sealed schedule: ${outcome.reason}`
}

function provenanceOf(paired: Extract<PairedReadOutcome, { root: string }>): ProvenanceRead {
  if (!paired.schedule.ok) return { kind: "unestablished", reason: `the sealed schedule is refused: ${paired.schedule.reason}` }
  const value = paired.schedule.schedule.config.provenance
  if (value === "scripted") return { kind: "scripted" }
  if (value === "live") return { kind: "live" }
  return {
    kind: "unestablished",
    reason: `the sealed schedule's \`config.provenance\` is ${JSON.stringify(value) ?? "absent"}, neither \`scripted\` nor \`live\``,
  }
}

function coverageOf(number: number, block: PairedBlock | undefined, absent: string, duplicate: string | null): BlockCoverage {
  if (block === undefined) return { block: number, state: "absent", reasons: [absent], arms: [] }
  const arms = block.arms.map((arm) => ({
    arm: arm.arm,
    runId: arm.row.manifest.run.runId,
    completion: arm.row.manifest.status.completion,
  }))
  if (block.result.kind === "withheld") return { block: number, state: "withheld", reasons: block.result.reasons, arms }
  if (duplicate !== null) return { block: number, state: "duplicate", reasons: [duplicate], arms }
  return { block: number, state: "measured", reasons: [], arms }
}

/**
 * The block's shared prefix run, from its measurement or else from its arms'
 * `experiment.prefixRunId`. Arms naming different prefixes name no one prefix,
 * so the block has none.
 */
function prefixOf(block: PairedBlock): string | null {
  if (block.result.kind === "measured") return block.result.prefixRunId
  const named = new Set(block.arms.map((arm) => arm.experiment.prefixRunId))
  return named.size === 1 ? [...named][0]! : null
}

// ---------------------------------------------------------------------------
// Precision
// ---------------------------------------------------------------------------

/**
 * One arm's precision from its adjudication counts.
 *
 * U is the DISTINCT ids across truth unresolved, label missing and outside the
 * pool, so the interval and the shared-label bound count one set. Counts that do
 * not partition N (TP + FP + U is not N) are unavailable with that reason, and no
 * division is attempted.
 */
export function armPrecision(counts: ArmFalsePositives): ArmPrecision {
  const unlabelled = [...new Set([...counts.truthUnresolved, ...counts.labelMissing, ...counts.outsidePool])]
  const tp = new Set(counts.trueDefects).size
  const fp = new Set(counts.falsePositives).size
  const u = unlabelled.length
  const n = counts.upheld
  if (!Number.isSafeInteger(n) || n < 0 || tp + fp + u !== n) {
    return {
      kind: "unavailable",
      arm: counts.arm,
      runId: counts.runId,
      reason:
        `arm ${counts.arm}'s adjudication counts do not partition its upheld findings: TP ${tp} + FP ${fp} + U ${u} ` +
        `is not N ${n}, so no precision is read from them`,
    }
  }
  if (n === 0) {
    return {
      kind: "undefined",
      arm: counts.arm,
      runId: counts.runId,
      reason: `arm ${counts.arm} upheld nothing, so its precision is undefined — not a perfect score, and not a clean list`,
    }
  }
  if (u === 0) {
    const point = fraction(tp, n)
    return { kind: "point", arm: counts.arm, runId: counts.runId, tp, fp, u, n, unlabelled, bound: { lower: point, upper: point } }
  }
  return {
    kind: "interval",
    arm: counts.arm,
    runId: counts.runId,
    tp,
    fp,
    u,
    n,
    unlabelled,
    bound: { lower: fraction(tp, n), upper: fraction(tp + u, n) },
  }
}

/**
 * The pair difference ON − OFF, as the shared-label bound and the outer bound.
 * Either arm's counts unavailable makes the difference unavailable; either arm's
 * precision undefined makes it undefined.
 */
export function pairDifference(on: ArmFalsePositives, off: ArmFalsePositives): PairDifference {
  const onPrecision = armPrecision(on)
  const offPrecision = armPrecision(off)
  const unavailableArms = [onPrecision, offPrecision].filter((entry) => entry.kind === "unavailable")
  if (unavailableArms.length > 0) return { kind: "unavailable", reason: unavailableArms.map((entry) => entry.reason).join("; ") }
  const undefinedArms = [onPrecision, offPrecision].filter((entry) => entry.kind === "undefined")
  if (undefinedArms.length > 0) {
    return {
      kind: "undefined",
      reason: `${undefinedArms.map((entry) => entry.reason).join("; ")}; the pair difference is undefined and no bound repairs it`,
    }
  }
  if (onPrecision.kind !== "point" && onPrecision.kind !== "interval") throw new Error("unreachable")
  if (offPrecision.kind !== "point" && offPrecision.kind !== "interval") throw new Error("unreachable")

  // Both N are above zero here: a partitioned N of 0 is undefined above.
  const k = subtract(fraction(onPrecision.tp, onPrecision.n), fraction(offPrecision.tp, offPrecision.n))
  const onIds = new Set(onPrecision.unlabelled)
  const offIds = new Set(offPrecision.unlabelled)
  const shared = [...new Set([...onPrecision.unlabelled, ...offPrecision.unlabelled])]
  let lower = k
  let upper = k
  for (const id of shared) {
    const a = subtract(onIds.has(id) ? fraction(1, onPrecision.n) : ZERO, offIds.has(id) ? fraction(1, offPrecision.n) : ZERO)
    if (compare(a, ZERO) < 0) lower = add(lower, a)
    else upper = add(upper, a)
  }
  return {
    kind: "bounded",
    primary: { lower, upper },
    outer: {
      lower: subtract(onPrecision.bound.lower, offPrecision.bound.upper),
      upper: subtract(onPrecision.bound.upper, offPrecision.bound.lower),
    },
    k,
    sharedUnlabelled: shared,
  }
}

type LabelledTruth = Extract<Extract<BlockRead, { kind: "read" }>["truth"], { kind: "labelled" }>

/** The block's truth labels, or every reason there are none to read. */
function truthOf(result: BlockRead | undefined, upstreamWhy: string | null): LabelledTruth | { reasons: string[] } {
  if (upstreamWhy !== null) return { reasons: [upstreamWhy] }
  if (result === undefined) return { reasons: ["the adjudication reader returned no block"] }
  if (result.kind !== "read") return { reasons: result.reasons }
  const truth = result.truth
  if (truth.kind !== "labelled") return { reasons: truth.reasons.map((reason) => `truth labels ${truth.kind}: ${reason}`) }
  if (!truth.accounting.agree) {
    return {
      reasons: [
        `the adjudication partition does not cover its pool (${truth.accounting.accounted} accounted over ` +
          `${truth.accounting.distinct} distinct id(s), pool ${truth.accounting.pool}), so its counts are not read`,
      ],
    }
  }
  return truth
}

function precisionOf(result: BlockRead | undefined, upstreamWhy: string | null): BlockPrecision {
  const truth = truthOf(result, upstreamWhy)
  if ("reasons" in truth) return { kind: "unavailable", reasons: truth.reasons }
  const on = truth.falsePositives.on
  const off = truth.falsePositives.off
  return { kind: "read", on: armPrecision(on), off: armPrecision(off), difference: pairDifference(on, off) }
}

function differenceOf(precision: BlockPrecision): PairDifference {
  if (precision.kind === "unavailable") return { kind: "unavailable", reason: precision.reasons.join("; ") }
  return precision.difference
}

/**
 * Every pair difference, then mean, min and max as OBSERVED SPREAD — over all
 * three pairs or not at all. Any pair undefined or unavailable leaves no
 * three-pair summary, and no subset is printed as one.
 */
export function observedSpread(pairs: readonly { block: number; difference: PairDifference }[]): Spread {
  const missing: { block: number; reason: string }[] = []
  const bounds: Bound[] = []
  for (const number of PAIRED_BLOCKS) {
    const pair = pairs.find((entry) => entry.block === number)
    if (pair === undefined) {
      missing.push({ block: number, reason: `no pair difference for block ${number}` })
      continue
    }
    if (pair.difference.kind !== "bounded") {
      missing.push({ block: number, reason: `${pair.difference.kind}: ${pair.difference.reason}` })
      continue
    }
    bounds.push(pair.difference.primary)
  }
  if (missing.length > 0) return { kind: "unavailable", missing }
  if (bounds.every(isPoint)) {
    const values = bounds.map((bound) => bound.lower)
    return { kind: "points", values, mean: average(values), min: minOf(values), max: maxOf(values) }
  }
  const lowers = bounds.map((bound) => bound.lower)
  const uppers = bounds.map((bound) => bound.upper)
  return {
    kind: "bounded",
    bounds,
    mean: { lower: average(lowers), upper: average(uppers) },
    min: { lower: minOf(lowers), upper: minOf(uppers) },
    max: { lower: maxOf(lowers), upper: maxOf(uppers) },
  }
}

function isPoint(bound: Bound): boolean {
  return compare(bound.lower, bound.upper) === 0
}

/** Whether a bound has values strictly on both sides of zero. */
function spansBothSigns(bound: Bound): boolean {
  return compare(bound.lower, ZERO) < 0 && compare(bound.upper, ZERO) > 0
}

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

function recallOf(
  arms: readonly LabelledArm[],
  labelledWhy: string | null,
  labels: number,
  adjudicationBlock: BlockRead | undefined,
  truthWhy: string | null,
): BlockRecall {
  const matcher = (name: Arm): ArmMatcherRecall => {
    if (labelledWhy !== null) return { kind: "unavailable", arm: name, reason: labelledWhy }
    const arm = arms.find((entry) => entry.arm === name)
    if (arm === undefined) return { kind: "unavailable", arm: name, reason: `the labelled reader bound no \`${name}\` arm in this block` }
    if (arm.result.kind === "unavailable") return { kind: "unavailable", arm: name, reason: arm.result.reason }
    const defectIds = [...new Set(arm.result.matches.map((match) => match.defectId))]
    return { kind: "measured", arm: name, runId: arm.runId, found: defectIds.length, of: labels, defectIds }
  }
  const on = matcher("on")
  const off = matcher("off")
  const change: BlockRecall["change"] =
    on.kind === "measured" && off.kind === "measured"
      ? { kind: "measured", delta: on.found - off.found, of: labels }
      : {
          kind: "unavailable",
          reason: [on, off]
            .filter((entry): entry is Extract<ArmMatcherRecall, { kind: "unavailable" }> => entry.kind === "unavailable")
            .map((entry) => `${entry.arm}: ${entry.reason}`)
            .join("; "),
        }
  return { on, off, change, lost: lostOf(adjudicationBlock, truthWhy) }
}

/** Sheet-labelled true prefix candidates each arm did not uphold, with where each went. */
function lostOf(result: BlockRead | undefined, upstreamWhy: string | null): LostTrue {
  const truth = truthOf(result, upstreamWhy)
  if ("reasons" in truth) return { kind: "unavailable", reasons: truth.reasons }
  const trueCandidates = truth.candidates.filter((candidate) => candidate.label === "true-defect")
  const lost = (bucketOf: (candidate: (typeof trueCandidates)[number]) => VerdictBucket | null): LostCandidate[] =>
    trueCandidates.flatMap((candidate) => {
      const bucket = bucketOf(candidate)
      if (bucket === "upheld") return []
      return [{ id: candidate.id, bucket: bucket ?? "missing" }]
    })
  return {
    kind: "read",
    trueLabelled: trueCandidates.length,
    on: lost((candidate) => candidate.on),
    off: lost((candidate) => candidate.off),
  }
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

const STOPPED_COMPLETIONS = ["unfinished", "cancelled"]

/** One arm's observed spend, read defensively off its manifest. */
export function armCost(arm: PairedArm): ArmCost {
  const manifest = arm.row.manifest
  const runId = manifest.run.runId
  const spend: unknown = manifest.spend
  if (!isRecord(spend)) {
    return { kind: "unavailable", arm: arm.arm, runId, reason: "its manifest carries no readable `spend`; its cost is unavailable, never zero" }
  }
  const origin = spend.origin
  if (!isRecord(origin)) {
    return {
      kind: "unavailable",
      arm: arm.arm,
      runId,
      reason:
        "its manifest carries no `spend.origin`, so what it executed and what it inherited cannot be told apart; " +
        "its cost is unavailable, never zero",
    }
  }
  const attributed = sliceOf(origin.attributed)
  const executedHere = sliceOf(origin.executedHere)
  const inherited = sliceOf(origin.inherited)
  if (attributed === null || executedHere === null || inherited === null) {
    return { kind: "unavailable", arm: arm.arm, runId, reason: "its manifest's `spend.origin` is malformed; its cost is unavailable, never zero" }
  }
  const completion = manifest.status.completion
  const failure = arm.experiment.failure
  const stopped =
    failure !== undefined
      ? `it THREW (${failure}); its spend is what it had spent when it stopped`
      : STOPPED_COMPLETIONS.includes(completion)
        ? `it stopped part way (\`${completion}\`); its spend is what it had spent when it stopped`
        : null
  const usageCompleteness = String(spend.usageCompleteness)
  const exposure = String(spend.exposure)
  let continuation: "exact" | "lower-bound" = "exact"
  let why: string | null = null
  if (usageCompleteness === "unaudited") {
    continuation = "lower-bound"
    why = "its usage is `unaudited`, so a zero unknown counter proves nothing and its figure is observed spend only"
  } else if (usageCompleteness !== "complete" && usageCompleteness !== "incomplete") {
    continuation = "lower-bound"
    why = `its \`usageCompleteness\` is ${JSON.stringify(spend.usageCompleteness)}, which this report does not know`
  } else if (executedHere.unknown > 0) {
    continuation = "lower-bound"
    why = `${executedHere.unknown} execution(s) it issued itself have UNKNOWN usage, so its figure is observed spend only`
  }
  const unknownUsage = Array.isArray(spend.unknownUsage) ? spend.unknownUsage : []
  const inheritedUnknownIds = unknownUsage
    .filter((entry): entry is Record<string, unknown> => isRecord(entry) && isRecord(entry.origin))
    .map((entry) => `${String((entry.origin as Record<string, unknown>).runId)}:${String(entry.executionId)}`)
    .sort()
  const forkedFrom = manifest.run.forkedFrom
  return {
    kind: "read",
    arm: arm.arm,
    runId,
    completion,
    stopped,
    usageCompleteness,
    exposure,
    attributed,
    executedHere,
    inherited,
    inheritedKinds: kindsOf((origin.inherited as { tokens: Record<string, unknown> }).tokens),
    continuation,
    why,
    prefixRunId: arm.experiment.prefixRunId,
    forkedFrom: isRecord(forkedFrom) && forkedFrom.kind === "known" && typeof forkedFrom.value === "string" ? forkedFrom.value : null,
    inheritedUnknownIds,
  }
}

const TOKEN_KINDS = ["input", "output", "reasoning", "cacheRead", "cacheWrite"]

/** A slice's tokens by kind, as text. Only called on a slice `sliceOf` accepted. */
function kindsOf(tokens: Record<string, unknown>): string {
  return TOKEN_KINDS.map((field) => `${field} ${String(tokens[field])}`).join(", ")
}

function sliceOf(raw: unknown): Slice | null {
  if (!isRecord(raw) || !isRecord(raw.tokens) || !isCount(raw.turns) || !isCount(raw.unknown)) return null
  let tokens = 0
  for (const field of TOKEN_KINDS) {
    const value = raw.tokens[field]
    if (!isCount(value)) return null
    tokens += value
  }
  return { tokens, turns: raw.turns, unknown: raw.unknown }
}

/**
 * Whether both arms inherited ONE prefix execution, or every reason they are not
 * shown to. The block's prefix evidence counts too: evidence the paired reader
 * refused, or evidence naming another run, establishes no shared prefix.
 */
function prefixIdentity(on: ArmCost & { kind: "read" }, off: ArmCost & { kind: "read" }, evidence: PairedBlock["prefix"]): PrefixCost {
  const reasons: string[] = []
  if (evidence.problem !== null) {
    reasons.push(`the paired reader does not accept this block's prefix evidence: ${evidence.problem}`)
  } else if (evidence.evidence?.prefixRunId.kind === "known" && evidence.evidence.prefixRunId.value !== on.prefixRunId) {
    reasons.push(`the prefix evidence records prefix run \`${evidence.evidence.prefixRunId.value}\`, not the arms' \`${on.prefixRunId}\``)
  }
  if (on.prefixRunId !== off.prefixRunId) {
    reasons.push(`the arms name different prefixes (on \`${on.prefixRunId}\`, off \`${off.prefixRunId}\`)`)
  }
  for (const arm of [on, off]) {
    if (arm.forkedFrom !== arm.prefixRunId) {
      reasons.push(`arm ${arm.arm}'s \`run.forkedFrom\` is ${arm.forkedFrom === null ? "unknown" : `\`${arm.forkedFrom}\``}, not its prefix \`${arm.prefixRunId}\``)
    }
  }
  const a = on.inherited
  const b = off.inherited
  if (a.tokens !== b.tokens || a.turns !== b.turns || a.unknown !== b.unknown) {
    reasons.push(
      `the inherited slices differ (on ${a.tokens} tokens over ${a.turns} turn(s), ${a.unknown} unknown; off ` +
        `${b.tokens} tokens over ${b.turns} turn(s), ${b.unknown} unknown)`,
    )
  } else if (on.inheritedKinds !== off.inheritedKinds) {
    reasons.push(`the inherited tokens differ by kind (on ${on.inheritedKinds}; off ${off.inheritedKinds})`)
  }
  for (const arm of [on, off]) {
    if (arm.inherited.unknown > arm.inheritedUnknownIds.length) {
      reasons.push(
        `arm ${arm.arm} inherited ${arm.inherited.unknown} unknown execution(s) but names only ` +
          `${arm.inheritedUnknownIds.length} inherited \`spend.unknownUsage\` identit(ies)`,
      )
    }
  }
  if (on.inheritedUnknownIds.join("\n") !== off.inheritedUnknownIds.join("\n")) {
    reasons.push("the inherited unknown-usage identities differ between the arms")
  }
  if (reasons.length > 0) return { kind: "not-established", reasons }
  return {
    kind: "established",
    runId: on.prefixRunId,
    slice: { ...a },
    unknownIds: on.inheritedUnknownIds,
    audited: [on, off].every((arm) => arm.usageCompleteness === "complete" || arm.usageCompleteness === "incomplete"),
  }
}

/**
 * ON − OFF over newly executed usage, once the shared prefix cancels.
 *
 * Exact when both continuations are complete. With one side a lower bound only,
 * the contrast is one-sided: `E_on ≥ known_on` gives `≥ known_on − E_off`, and
 * `E_off ≥ known_off` gives `≤ E_on − known_off`. Both sides lower bounds leave
 * nothing; an unknown is never subtracted.
 */
export function costContrast(on: ArmCost & { kind: "read" }, off: ArmCost & { kind: "read" }): CostContrast {
  const tokens = on.executedHere.tokens - off.executedHere.tokens
  const turns = on.executedHere.turns - off.executedHere.turns
  if (on.continuation === "exact" && off.continuation === "exact") return { kind: "exact", tokens, turns }
  if (on.continuation === "lower-bound" && off.continuation === "exact") {
    return { kind: "at-least", tokens, turns, reason: `the ON continuation is a lower bound: ${on.why}` }
  }
  if (on.continuation === "exact" && off.continuation === "lower-bound") {
    return { kind: "at-most", tokens, turns, reason: `the OFF continuation is a lower bound: ${off.why}` }
  }
  return {
    kind: "unavailable",
    reason: `both continuations are lower bounds only (on: ${on.why}; off: ${off.why}), and an unknown is never subtracted`,
  }
}

export function blockCost(block: PairedBlock): BlockCost {
  const failure = block.prefix.evidence?.failure
  const bound = block.arms.map(armCost)
  if (failure !== undefined) {
    return {
      kind: "unavailable",
      reasons: [
        `the prefix FAILED (${failure}); what it spent is recorded in \`${JOURNAL_FILE}\`, which this report does not ` +
          "read — the journal owns the unique-execution bill",
      ],
      arms: bound,
    }
  }
  const pick = (name: Arm): ArmCost => {
    const found = bound.find((entry) => entry.arm === name)
    if (found !== undefined) return found
    const excluded = block.excluded.filter((entry) => entry.armId === name).map((entry) => entry.reason)
    return {
      kind: "unavailable",
      arm: name,
      runId: null,
      reason:
        `no \`${name}\` arm manifest was bound to block ${block.block}` +
        (excluded.length === 0 ? "" : ` (${excluded.join("; ")})`) +
        `; its spend is a gap, and \`${JOURNAL_FILE}\` holds what was issued`,
    }
  }
  const on = pick("on")
  const off = pick("off")
  if (on.kind !== "read" || off.kind !== "read") {
    const reasons = [on, off]
      .filter((entry): entry is Extract<ArmCost, { kind: "unavailable" }> => entry.kind === "unavailable")
      .map((entry) => `arm ${entry.arm}: ${entry.reason}`)
    return { kind: "unavailable", reasons, arms: [on, off] }
  }

  const prefix = prefixIdentity(on, off, block.prefix)
  const stopped = [on, off].filter((arm) => arm.stopped !== null)
  let contrast: CostContrast
  if (prefix.kind !== "established") {
    contrast = { kind: "unavailable", reason: `nothing cancels, because one shared prefix is not established: ${prefix.reasons.join("; ")}` }
  } else if (stopped.length > 0) {
    contrast = {
      kind: "unavailable",
      reason:
        `${stopped.map((arm) => `arm ${arm.arm}: ${arm.stopped}`).join("; ")}; a contrast against a whole continuation ` +
        "would report the truncation as a cost difference",
    }
  } else {
    contrast = costContrast(on, off)
  }

  let total: BlockTotal
  if (prefix.kind !== "established") {
    total = { kind: "unavailable", reason: "one shared prefix is not established, so the prefix cannot be counted once" }
  } else {
    const tokens = prefix.slice.tokens + on.executedHere.tokens + off.executedHere.tokens
    const turns = prefix.slice.turns + on.executedHere.turns + off.executedHere.turns
    const unquantified: string[] = []
    for (const arm of [on, off]) {
      if (arm.usageCompleteness !== "complete" && arm.usageCompleteness !== "incomplete") {
        unquantified.push(`arm ${arm.arm}'s usage is \`${arm.usageCompleteness}\`, so the prefix it inherited is not audited either`)
      }
    }
    if (prefix.slice.unknown > 0) unquantified.push(`the shared prefix holds ${prefix.slice.unknown} execution(s) with UNKNOWN usage`)
    for (const arm of [on, off]) if (arm.continuation === "lower-bound") unquantified.push(`the ${arm.arm} continuation: ${arm.why}`)
    const stoppedReasons = stopped.map((arm) => `arm ${arm.arm}: ${arm.stopped}`)
    total =
      unquantified.length === 0 && stoppedReasons.length === 0
        ? { kind: "quantified", tokens, turns }
        : { kind: "observed", tokens, turns, unquantified, stopped: stoppedReasons }
  }
  return { kind: "read", on, off, prefix, contrast, total }
}

// ---------------------------------------------------------------------------
// Attempt mode (story 2-8c3a)
// ---------------------------------------------------------------------------

/**
 * What the bundle counts cost in. The sealed schedule's `config.accounting` and
 * every bound arm's `experiment.accounting` must agree: all absent is tokens,
 * all `attempts` is attempts, and anything else is mixed, so no cost is read.
 *
 * With the schedule refused and no arm bound there is no evidence either way, so
 * the mode cannot be established and no cost endpoint applies. An attempt-mode
 * bundle must be sealed under a version-2 protocol (the schedule's, or else each
 * arm's recorded protocol version); otherwise its mode is not established either.
 */
export function bundleAccounting(paired: Extract<PairedReadOutcome, { root: string }>): BundleAccounting {
  const sources: { name: string; attempts: boolean }[] = []
  if (paired.schedule.ok) {
    const value = paired.schedule.schedule.config.accounting
    if (value !== undefined && value !== "attempts") {
      return { kind: "mixed", reason: `the sealed schedule's \`config.accounting\` is ${JSON.stringify(value)}, which is not attempts` }
    }
    sources.push({ name: "the sealed schedule", attempts: value === "attempts" })
  }
  const arms = paired.blocks.flatMap((block) => block.arms.map((arm) => ({ block: block.block, arm })))
  for (const { block, arm } of arms) {
    sources.push({ name: `block ${block} ${arm.arm}'s manifest`, attempts: arm.experiment.accounting === "attempts" })
  }
  if (sources.length === 0) {
    return {
      kind: "unestablished",
      reason:
        `the sealed schedule is refused (${paired.schedule.ok ? "" : paired.schedule.reason}) and no arm manifest is bound, ` +
        "so the accounting mode cannot be established",
    }
  }
  const attempts = sources.filter((source) => source.attempts)
  if (attempts.length === 0) return { kind: "tokens" }
  if (attempts.length < sources.length) {
    const tokens = sources.filter((source) => !source.attempts).map((source) => source.name)
    return {
      kind: "mixed",
      reason:
        `the bundle mixes accounting modes: ${attempts.map((source) => source.name).join(", ")} count attempts, and ` +
        `${tokens.join(", ")} count tokens`,
    }
  }
  const versions = paired.schedule.ok
    ? [{ name: "the sealed schedule", version: paired.schedule.schedule.protocol.version as unknown }]
    : arms.map(({ block, arm }) => {
        const recorded = arm.row.manifest.identity.protocolVersion as { kind?: unknown; value?: unknown }
        return { name: `block ${block} ${arm.arm}'s manifest`, version: recorded?.kind === "known" ? recorded.value : undefined }
      })
  const wrong = versions.filter((entry) => entry.version !== 2)
  if (wrong.length > 0) {
    return {
      kind: "unestablished",
      reason:
        "attempt accounting is defined only by a frozen version-2 protocol, and " +
        wrong.map((entry) => `${entry.name} names protocol version ${JSON.stringify(entry.version) ?? "unknown"}`).join(", "),
    }
  }
  return { kind: "attempts" }
}

/**
 * One block's newly issued MAD attempts, from the replayed journal's Blocks
 * requests for that block. A `not-issued` attempt was never handed to a backend,
 * so it counts 0 here and is shown apart. The contrast is ON − OFF over the two
 * continuations; it is unavailable while either continuation's slot did not
 * complete, because a truncated continuation would read as a workflow-use
 * difference.
 */
export function blockAttempts(
  bill: UniqueExecutionBill,
  source: string,
  number: number,
  block: PairedBlock | undefined,
  slots: readonly { block: number; arm: Arm; status: string; reason: string }[],
): BlockAttempts {
  const thresholdOf = (row: { limit: number; spent: number; overshoot: number } | undefined, limit: number): AttemptThreshold =>
    row === undefined ? { limit, spent: 0, overshoot: 0 } : { limit: row.limit, spent: row.spent, overshoot: row.overshoot }
  const phaseRow = (phase: PairedPhase) => bill.overshoot.phases.find((row) => row.block === number && row.phase === phase)
  const thresholds = {
    prefix: thresholdOf(phaseRow("prefix"), ATTEMPT_ALLOWANCES.prefix),
    on: thresholdOf(phaseRow("on"), ATTEMPT_ALLOWANCES.continuation),
    off: thresholdOf(phaseRow("off"), ATTEMPT_ALLOWANCES.continuation),
    block: thresholdOf(bill.overshoot.blockTotals?.find((row) => row.block === number), ATTEMPT_ALLOWANCES.block),
  }
  const mine = bill.requests.filter((request) => request.category === "blocks" && request.block === number)
  const issued = mine.filter((request) => request.state !== "not-issued")
  const countOf = (phase: PairedPhase): AttemptCount => {
    const inPhase = issued.filter((request) => request.phase === phase)
    const first = inPhase.filter((request) => request.attempt === 1).length
    return { first, retries: inPhase.length - first, total: inPhase.length }
  }
  const prefix = countOf("prefix")
  const on = countOf("on")
  const off = countOf("off")

  const armOf = (name: Arm) => block?.arms.find((arm) => arm.arm === name)
  // The shared prefix writes no manifest of its own, so its models are read from
  // a continuation's, which inherited the prefix's roster, and named as such.
  const rosterFor = (phase: PairedPhase) => (phase === "prefix" ? (armOf("on") ?? armOf("off")) : armOf(phase))
  const modelOf = (phase: PairedPhase, slot: string): { model: string; modelSource: string } => {
    const arm = rosterFor(phase)
    if (arm === undefined) return { model: "unattributed", modelSource: `no arm manifest was bound to block ${number}` }
    const manifest = arm.row.manifest
    const roster = manifest.roster as { slots?: unknown; lensSlots?: unknown }
    const entries = [...(Array.isArray(roster.slots) ? roster.slots : []), ...(Array.isArray(roster.lensSlots) ? roster.lensSlots : [])]
    const found = entries.find((entry) => isRecord(entry) && entry.slot === slot) as Record<string, unknown> | undefined
    const modelSource =
      phase === "prefix"
        ? `continuation manifest \`${manifest.run.runId}\`, same roster`
        : `run \`${manifest.run.runId}\`'s manifest roster`
    if (found === undefined || typeof found.providerId !== "string" || typeof found.modelId !== "string") {
      return { model: "not in the manifest roster", modelSource }
    }
    return { model: `${found.providerId}/${found.modelId}`, modelSource }
  }
  const rows = new Map<string, AttemptRow>()
  for (const request of issued) {
    const phase = request.phase!
    const key = `${phase}\0${request.stage}\0${request.slot}`
    let row = rows.get(key)
    if (row === undefined) {
      row = { phase, stage: request.stage, slot: request.slot, ...modelOf(phase, request.slot), first: 0, retries: 0 }
      rows.set(key, row)
    }
    if (request.attempt === 1) row.first += 1
    else row.retries += 1
  }
  const order: PairedPhase[] = ["prefix", "on", "off"]
  const sorted = [...rows.values()].sort(
    (a, b) => order.indexOf(a.phase) - order.indexOf(b.phase) || a.stage.localeCompare(b.stage) || a.slot.localeCompare(b.slot),
  )

  // Both continuations must be recorded completed: a missing status row is not a completed continuation.
  const unfinished = (["on", "off"] as const).flatMap((arm) => {
    const row = slots.find((slot) => slot.block === number && slot.arm === arm)
    if (row === undefined) return [`the ${arm.toUpperCase()} slot has no recorded status`]
    return row.status === "completed" ? [] : [`the ${arm.toUpperCase()} slot is ${row.status}: ${row.reason}`]
  })
  const overshot = (["on", "off"] as const).filter((arm) => thresholds[arm].overshoot > 0)
  const contrast: Extract<BlockAttempts, { kind: "read" }>["contrast"] =
    unfinished.length > 0
      ? {
          kind: "unavailable",
          reason: `${unfinished.join("; ")}; a contrast against a truncated continuation would report the truncation as a workflow-use difference`,
        }
      : {
          kind: "exact",
          attempts: on.total - off.total,
          ...(overshot.length === 0
            ? {}
            : {
                differentCaps:
                  `the arms ran under different realised caps: ${overshot
                    .map((arm) => `${arm.toUpperCase()} realised ${thresholds[arm].spent} of ${thresholds[arm].limit}`)
                    .join(", ")}`,
              }),
        }
  return {
    kind: "read",
    source,
    prefix,
    on,
    off,
    contrast,
    thresholds,
    total: prefix.total + on.total + off.total,
    rows: sorted,
    notIssued: mine.length - issued.length,
    noHostUsage: issued.filter((request) => request.state === "unknown").length,
  }
}

// ---------------------------------------------------------------------------
// Treatment opportunity
// ---------------------------------------------------------------------------

function treatmentOf(block: PairedBlock | undefined, absent: string): BlockTreatment {
  const on = block?.arms.find((arm) => arm.arm === "on")
  const off = block?.arms.find((arm) => arm.arm === "off")
  const opportunity: TreatmentOpportunity =
    block === undefined
      ? { kind: "unknown", why: absent }
      : block.result.kind === "measured"
        ? block.result.treatment
        : { kind: "unknown", why: `the paired block is withheld: ${block.result.reasons.join("; ")}` }
  return {
    opportunity,
    offRunId: off?.row.manifest.run.runId ?? null,
    debate: on === undefined ? { kind: "unknown", why: "no `on` arm manifest was bound to this block" } : debateOf(on),
    onRunId: on?.row.manifest.run.runId ?? null,
  }
}

/** Whether debate ran in the ON arm, read defensively: `status.debateCounts` is not validated upstream. */
export function debateOf(arm: PairedArm): DebateRan {
  const counts = (arm.row.manifest.status as { debateCounts?: unknown }).debateCounts
  if (!isRecord(counts)) return { kind: "unknown", why: "its ON arm's manifest carries no readable `status.debateCounts`" }
  if (counts.kind === "did-not-run") return { kind: "did-not-run" }
  if (counts.kind === "ran" && isRecord(counts.counts) && isCount(counts.counts.debated)) {
    return { kind: "ran", debated: counts.counts.debated }
  }
  return { kind: "unknown", why: "its ON arm's `status.debateCounts` is malformed" }
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

function availabilityOf(blocks: readonly EvaluationBlock[]): Availability[] {
  return EVALUATION_QUANTITIES.map((quantity) => {
    const missing: { block: number; reason: string }[] = []
    for (const block of blocks) {
      const why = unavailableWhy(block, quantity)
      if (why !== null) missing.push({ block: block.block, reason: why })
    }
    return { quantity, available: blocks.length - missing.length, of: PAIRED_BLOCKS.length, missing }
  })
}

function unavailableWhy(block: EvaluationBlock, quantity: EvaluationQuantity): string | null {
  switch (quantity) {
    case "precision difference": {
      const difference = differenceOf(block.precision)
      return difference.kind === "bounded" ? null : `${difference.kind}: ${difference.reason}`
    }
    case "planted-defect matcher recall change":
      return block.recall.change.kind === "measured" ? null : block.recall.change.reason
    case "lost true candidates":
      return block.recall.lost.kind === "read" ? null : block.recall.lost.reasons.join("; ")
    case "cost contrast":
      if (block.attempts !== undefined) {
        if (block.attempts.kind === "unavailable") return block.attempts.reason
        return block.attempts.contrast.kind === "unavailable" ? block.attempts.contrast.reason : null
      }
      if (block.cost.kind === "unavailable") return block.cost.reasons.join("; ")
      return block.cost.contrast.kind === "unavailable" ? block.cost.contrast.reason : null
    case "treatment opportunity":
      return block.treatment.opportunity.kind === "known" ? null : block.treatment.opportunity.why
  }
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const ESTIMANDS = [
  "ESTIMANDS — beside every number below",
  "  DIRECTION READS ON − OFF (`evaluation-protocol.md:123-126`). The randomized first-arm order does not change it.",
  "  PRECISION is a point only when U = 0; otherwise it lies in [TP/N, (TP+U)/N]. U counts upheld findings with no",
  "  decisive truth label: truth unresolved, label missing, or outside the prefix pool. N = 0 is UNDEFINED.",
  "  EVERY BOUND IS AN IDENTIFICATION BOUND, never a confidence interval. The SHARED-LABEL bound is primary: a",
  "  candidate both arms upheld has one truth label. The OUTER bound [L_on − U_off, U_on − L_off] lets one claim carry",
  "  two labels, so it is wider and is labelled as such.",
  "  RECALL here is the planted-defect MATCHER's, a preservation diagnostic over the sealed planted defects. It is",
  "  not truth-sheet precision, and it gates nothing.",
  "  COST is OBSERVED per-block execution cost from the arm manifests. It is not the experiment's bill: the journal",
  `  (\`${JOURNAL_FILE}\`) owns the unique-execution bill, and no block figure here is summed into a total.`,
  "  Three blocks are DESCRIPTIVE evidence: no significance claim is available from them (`evaluation-protocol.md` §4).",
  "",
]

/** Story 2-8c3a — the COST estimand for an attempt-mode bundle, in place of the token one. */
const ATTEMPT_COST_ESTIMAND = [
  "  COST is NEWLY ISSUED MAD ATTEMPTS (protocol v2 draft): shared prefix + ON continuation + OFF continuation, each",
  `  admitted attempt once, retries included and shown apart, read from \`${JOURNAL_FILE}\`. ON − OFF compares the`,
  "  continuations only. It is a WORKFLOW-USE CONTRAST: never token cost, money, subscription quota or a physical request",
  "  count. Host-reported tokens are unverified diagnostics and enter no figure.",
]

/** Story 2-8c3a — the COST estimand when no cost endpoint applies. */
const NO_COST_ESTIMAND = [
  "  COST: NO COST ENDPOINT APPLIES. The bundle's accounting mode is mixed or cannot be established, so neither",
  "  the token endpoint nor the attempt endpoint is read, and no cost figure is printed.",
]

/**
 * `base` with its COST estimand replaced: from the line starting `  COST is` to
 * the last continuation line after it (a line whose third character is not an
 * upper-case letter). Throws when there is no COST estimand to replace.
 */
export function spliceCostEstimand(base: readonly string[], replacement: readonly string[]): string[] {
  const at = base.findIndex((line) => line.startsWith("  COST is "))
  if (at < 0) throw new Error("the estimands carry no `  COST is` line to replace")
  let end = at + 1
  while (end < base.length && /^  [^A-Z\s]/.test(base[end]!)) end += 1
  return [...base.slice(0, at), ...replacement, ...base.slice(end)]
}

function estimandLines(accounting: EvaluationReport["accounting"]): string[] {
  if (accounting === undefined) return ESTIMANDS
  return spliceCostEstimand(ESTIMANDS, accounting === "attempts" ? ATTEMPT_COST_ESTIMAND : NO_COST_ESTIMAND)
}

export function renderEvaluationReport(outcome: EvaluationReportOutcome): string {
  if (outcome.kind === "not-applicable") return ""
  if (outcome.kind === "unavailable") return `${NOT_COMPOSED}\n  ${outcome.reason}\n`

  const lines: string[] = [...provenanceLines(outcome.provenance), `bundle ${outcome.root}`]
  lines.push(outcome.scheduleHash === null ? "sealed schedule: refused" : `sealed schedule ${outcome.scheduleHash}`)
  lines.push("")
  if (outcome.upstream.length > 0) {
    lines.push("UPSTREAM READERS THAT GAVE NO RESULT — their quantities are unavailable below, and nothing else is")
    for (const entry of outcome.upstream) lines.push(`  ${entry}`)
    lines.push("")
  }
  lines.push(...estimandLines(outcome.accounting))
  lines.push(...coverageLines(outcome.coverage))
  lines.push(...availabilityLines(outcome.availability))

  lines.push("PRECISION — per pair, from the human truth sheet's labels")
  for (const block of outcome.blocks) lines.push(...precisionLines(block))
  lines.push(...spreadLines(outcome.spread))

  lines.push("FINAL RECALL — planted-defect matcher recall (a preservation diagnostic) and the lost true candidates")
  for (const block of outcome.blocks) lines.push(...recallLines(block))
  lines.push("")

  if (outcome.accounting === undefined) {
    lines.push("COST — observed per-block execution cost, never the experiment's bill")
    for (const block of outcome.blocks) lines.push(...costLines(block))
    lines.push(
      `  No experiment total is printed. The unique-execution bill is \`${JOURNAL_FILE}\`'s, and summing the blocks`,
      "  visible here would leave out every failed prefix and every missing manifest.",
      "",
    )
  } else if (outcome.accounting !== "attempts") {
    lines.push("COST — no cost endpoint applies: the accounting mode is mixed or cannot be established")
    for (const block of outcome.blocks) lines.push(...attemptLines(block))
    lines.push("")
  } else {
    lines.push(
      "COST — newly issued MAD attempts: a workflow-use contrast, never token cost, money, subscription quota or physical requests",
    )
    for (const block of outcome.blocks) lines.push(...attemptLines(block))
    lines.push(
      "  Host-reported tokens on this route are unverified diagnostics and are in no figure above. Token spend and",
      "  subscription quota are not measured; the host's own retries, tool steps and held-open requests are not counted.",
      "",
    )
  }

  lines.push("TREATMENT OPPORTUNITY — how many candidates normal policy would have debated, and whether debate ran")
  for (const block of outcome.blocks) lines.push(...treatmentLines(block))
  lines.push("")

  lines.push(
    "PRODUCT VALUE — not assessed, by design (`evaluation-protocol.md` §6). This report prints; it grades nothing.",
    `Its inputs are the paired (\`${PAIRED_READER_MODULE}\`), labelled (\`${LABELLED_READER_MODULE}\`) and adjudication`,
    `(\`${ADJUDICATION_READER_MODULE}\`) reports above, each read once.`,
  )
  return `${lines.join("\n")}\n`
}

function provenanceLines(provenance: ProvenanceRead): string[] {
  if (provenance.kind === "scripted") {
    return [
      "MAD EVALUATION REPORT — SYNTHETIC",
      "SYNTHETIC — the sealed schedule's provenance is `scripted`. Every number below came from a scripted backend: it",
      `is fixture evidence, not a live measurement. The most it supports is: ${REPORTING_MILESTONE}.`,
    ]
  }
  if (provenance.kind === "unestablished") {
    return [
      "MAD EVALUATION REPORT — PROVENANCE UNESTABLISHED",
      `PROVENANCE UNESTABLISHED — ${provenance.reason}. Nothing below is established as live evidence.`,
    ]
  }
  return ["MAD EVALUATION REPORT", "provenance: `live`, as the sealed schedule records it"]
}

function coverageLines(coverage: Coverage): string[] {
  const lines = ["EXECUTION COVERAGE — every failure retained"]
  if (coverage.halt.kind !== "none") {
    lines.push(
      coverage.halt.kind === "halted" && coverage.halt.accounting === "attempts"
        ? `  THE EXPERIMENT STOPPED IN ATTEMPT MODE, an operational stop and not unknown spend (\`${coverage.halt.file}\`): ${coverage.halt.reason}`
        : `  THE EXPERIMENT HALT is ${coverage.halt.kind} (\`${coverage.halt.file}\`): ${coverage.halt.reason}`,
    )
  }
  lines.push(`  scheduled blocks: ${coverage.scheduled}; completed: ${countText(coverage.completed, coverage.scheduled)}`)
  for (const block of coverage.blocks) {
    const arms = block.arms.map((arm) => `${arm.arm} \`${arm.runId}\` (${arm.completion})`).join(", ")
    const state =
      block.state === "measured"
        ? "completed and measured"
        : block.state === "withheld"
          ? "WITHHELD"
          : block.state === "duplicate"
            ? "NOT COUNTED — a repeated discovery pass"
            : "NOT READ"
    lines.push(`  block ${block.block}: ${state}${arms === "" ? "" : ` — arms ${arms}`}`)
    for (const reason of block.reasons) lines.push(`    ${reason}`)
  }
  if (coverage.slots.length > 0) {
    lines.push(`  SLOTS THAT DID NOT COMPLETE, from \`${SLOT_STATUS_FILE}\``)
    for (const slot of coverage.slots) lines.push(`    block ${slot.block} ${slot.arm}: ${slot.status} — ${slot.reason}`)
  }
  if (coverage.excluded.length > 0) {
    lines.push("  ARMS OUT OF EVERY PAIR")
    for (const entry of coverage.excluded) lines.push(`    ${entry.armId}/${entry.repeatId} — ${entry.reason}`)
  }
  lines.push("")
  return lines
}

function availabilityLines(availability: readonly Availability[]): string[] {
  const lines = ["AVAILABILITY — n/3 separately for each quantity"]
  for (const entry of availability) {
    lines.push(`  ${entry.quantity}: ${entry.available}/${entry.of}`)
    for (const gap of entry.missing) lines.push(`    block ${gap.block} unavailable — ${gap.reason}`)
  }
  lines.push("")
  return lines
}

function boundText(bound: Bound): string {
  return `[${fractionText(bound.lower)}, ${fractionText(bound.upper)}]`
}

function armPrecisionText(precision: ArmPrecision): string {
  if (precision.kind === "undefined") return `arm ${precision.arm}, run \`${precision.runId}\`: UNDEFINED — ${precision.reason}`
  if (precision.kind === "unavailable") return `arm ${precision.arm}, run \`${precision.runId}\`: UNAVAILABLE — ${precision.reason}`
  const counts = `TP ${precision.tp}, FP ${precision.fp}, U ${precision.u} of N ${precision.n} upheld`
  if (precision.kind === "point") {
    return `arm ${precision.arm}, run \`${precision.runId}\`: point ${fractionText(precision.bound.lower)} = TP/(TP+FP) = ${precision.tp}/${precision.tp + precision.fp} (${counts})`
  }
  return (
    `arm ${precision.arm}, run \`${precision.runId}\`: in ${boundText(precision.bound)} = [TP/N, (TP+U)/N] = ` +
    `[${precision.tp}/${precision.n}, ${precision.tp + precision.u}/${precision.n}] (${counts})`
  )
}

function precisionLines(block: EvaluationBlock): string[] {
  const lines = [`  BLOCK ${block.block}${block.prefixRunId === null ? "" : `, prefix \`${block.prefixRunId}\``}`]
  const precision = block.precision
  if (precision.kind === "unavailable") {
    lines.push("    UNAVAILABLE:")
    for (const reason of precision.reasons) lines.push(`      ${reason}`)
    return lines
  }
  lines.push(`    ${armPrecisionText(precision.on)}`, `    ${armPrecisionText(precision.off)}`)
  for (const arm of [precision.on, precision.off]) {
    if ((arm.kind === "point" || arm.kind === "interval") && arm.unlabelled.length > 0) {
      lines.push(`      arm ${arm.arm} unlabelled upheld: ${arm.unlabelled.map((id) => `\`${id}\``).join(", ")}`)
    }
  }
  const difference = precision.difference
  if (difference.kind !== "bounded") {
    lines.push(`    pair difference ON − OFF: ${difference.kind.toUpperCase()} — ${difference.reason}`)
    return lines
  }
  const primary = isPoint(difference.primary)
    ? `point ${fractionText(difference.primary.lower)}`
    : `in ${boundText(difference.primary)}`
  lines.push(
    `    pair difference ON − OFF, shared-label bound (primary): ${primary} — K = ${fractionText(difference.k)}, over ` +
      `${difference.sharedUnlabelled.length} distinct unlabelled id(s) upheld in either arm`,
  )
  if (spansBothSigns(difference.primary)) lines.push(`      ${DIRECTION_UNRESOLVED}`)
  lines.push(`    OUTER bound (secondary, labelled outer): ${boundText(difference.outer)}`)
  if (spansBothSigns(difference.outer)) {
    lines.push(
      "      the outer bound spans zero: a limitation of the OUTER bound, which lets one claim carry two labels. It says",
      "      nothing about the result, which reads the shared-label bound above.",
    )
  }
  return lines
}

function spreadLines(spread: Spread): string[] {
  const lines = ["  OBSERVED SPREAD — every pair difference, then mean, min and max over all three pairs"]
  if (spread.kind === "unavailable") {
    lines.push("    no three-pair summary: a pair is undefined or unavailable, and no subset stands in for the three")
    for (const gap of spread.missing) lines.push(`      block ${gap.block} — ${gap.reason}`)
  } else if (spread.kind === "points") {
    lines.push(
      `    pair differences: ${spread.values.map(fractionText).join(", ")}`,
      `    observed spread: mean ${fractionText(spread.mean)}, min ${fractionText(spread.min)}, max ${fractionText(spread.max)}`,
    )
  } else {
    lines.push(
      `    pair differences: ${spread.bounds.map((bound) => (isPoint(bound) ? fractionText(bound.lower) : boundText(bound))).join(", ")}`,
      `    observed spread: planned mean in ${boundText(spread.mean)} (the endpoints averaged); min bounded in ` +
        `${boundText(spread.min)}; max bounded in ${boundText(spread.max)}`,
    )
    if (spansBothSigns(spread.mean)) lines.push(`      the planned mean's bound: ${DIRECTION_UNRESOLVED}`)
  }
  lines.push("")
  return lines
}

function recallLines(block: EvaluationBlock): string[] {
  const recall = block.recall
  const lines = [`  BLOCK ${block.block}`]
  for (const arm of [recall.on, recall.off]) {
    if (arm.kind === "unavailable") {
      lines.push(`    arm ${arm.arm} matcher recall: unavailable — ${arm.reason}`)
    } else {
      lines.push(
        `    arm ${arm.arm}, run \`${arm.runId}\`, matcher recall: ${countText(arm.found, arm.of)} planted defects` +
          (arm.defectIds.length === 0 ? "" : ` (${arm.defectIds.map((id) => `\`${id}\``).join(", ")})`),
      )
    }
  }
  if (recall.change.kind === "measured") {
    const sign = recall.change.delta > 0 ? "+" : ""
    lines.push(`    ON − OFF matcher recall change: ${sign}${recall.change.delta} of ${recall.change.of} planted defects`)
  } else {
    lines.push(`    ON − OFF matcher recall change: unavailable — ${recall.change.reason}`)
  }
  const lost = recall.lost
  if (lost.kind === "unavailable") {
    lines.push(`    lost true candidates: unavailable — ${lost.reasons.join("; ")}`)
    return lines
  }
  for (const [arm, entries] of [
    ["on", lost.on],
    ["off", lost.off],
  ] as const) {
    lines.push(
      `    arm ${arm} lost true candidates: ${countText(entries.length, lost.trueLabelled)} sheet-labelled true prefix candidates not upheld` +
        (entries.length === 0 ? "" : ` (${entries.map((entry) => `\`${entry.id}\` ${entry.bucket}`).join(", ")})`),
    )
  }
  return lines
}

function sliceText(slice: Slice): string {
  return `${slice.tokens} tokens over ${slice.turns} turn(s), ${slice.unknown} unknown`
}

function armCostLines(arm: ArmCost): string[] {
  if (arm.kind === "unavailable") {
    return [`    arm ${arm.arm}${arm.runId === null ? "" : `, run \`${arm.runId}\``}: cost UNAVAILABLE — ${arm.reason}`]
  }
  const lines = [
    `    arm ${arm.arm}, run \`${arm.runId}\` (${arm.completion}; usage ${arm.usageCompleteness}; exposure ${arm.exposure}): ` +
      `continuation executed here ${sliceText(arm.executedHere)} — ${arm.continuation === "exact" ? "complete" : "OBSERVED LOWER BOUND"}`,
    `      attributed ${sliceText(arm.attributed)}; inherited ${sliceText(arm.inherited)}`,
  ]
  if (arm.why !== null) lines.push(`      ${arm.why}`)
  if (arm.stopped !== null) lines.push(`      INCOMPLETE — ${arm.stopped}`)
  return lines
}

function costLines(block: EvaluationBlock): string[] {
  const cost = block.cost
  const lines = [`  BLOCK ${block.block}`]
  if (cost.kind === "unavailable") {
    lines.push("    cost UNAVAILABLE:")
    for (const reason of cost.reasons) lines.push(`      ${reason}`)
    // An unavailable arm prints unless its reason is already one of the block's.
    for (const arm of cost.arms) {
      if (arm.kind === "read" || !cost.reasons.includes(`arm ${arm.arm}: ${arm.reason}`)) lines.push(...armCostLines(arm))
    }
    return lines
  }
  if (cost.prefix.kind === "established") {
    lines.push(
      `    shared prefix \`${cost.prefix.runId}\`, counted once: ${sliceText(cost.prefix.slice)}` +
        (cost.prefix.audited ? "" : " — UNAUDITED"),
    )
  } else {
    lines.push("    ONE SHARED PREFIX IS NOT ESTABLISHED — nothing cancels; each arm's attributed view is printed on its own:")
    for (const reason of cost.prefix.reasons) lines.push(`      ${reason}`)
  }
  lines.push(...armCostLines(cost.on), ...armCostLines(cost.off))
  const contrast = cost.contrast
  if (contrast.kind === "exact") {
    lines.push(`    ON − OFF newly executed: exactly ${contrast.tokens} tokens, ${contrast.turns} turn(s)`)
  } else if (contrast.kind === "at-least" || contrast.kind === "at-most") {
    const word = contrast.kind === "at-least" ? "at least" : "at most"
    lines.push(
      `    ON − OFF newly executed: ${word} ${contrast.tokens} tokens, ${word} ${contrast.turns} turn(s) — a one-sided bound`,
      `      ${contrast.reason}`,
    )
  } else {
    lines.push(`    ON − OFF newly executed: unavailable — ${contrast.reason}`)
  }
  const total = cost.total
  if (total.kind === "quantified") {
    lines.push(`    block execution (prefix once + both continuations): ${total.tokens} tokens over ${total.turns} turn(s), exposure quantified`)
  } else if (total.kind === "observed") {
    const qualifiers = [
      ...(total.unquantified.length > 0 ? ["exposure UNQUANTIFIED"] : []),
      ...(total.stopped.length > 0 ? ["INCOMPLETE — a continuation stopped part way"] : []),
    ]
    lines.push(
      `    block execution (prefix once + both continuations): observed ${total.tokens} tokens over ${total.turns} turn(s), ` +
        qualifiers.join("; "),
    )
    for (const reason of [...total.unquantified, ...total.stopped]) lines.push(`      ${reason}`)
  } else {
    lines.push(`    block execution: unavailable — ${total.reason}`)
  }
  return lines
}

function attemptCountText(count: AttemptCount, threshold: AttemptThreshold): string {
  return (
    `${count.total} attempt(s) (${count.first} first, ${count.retries} retr${count.retries === 1 ? "y" : "ies"}); ` +
    thresholdText(threshold)
  )
}

function thresholdText(threshold: AttemptThreshold): string {
  return (
    `realised ${threshold.spent} of the ${threshold.limit}-attempt threshold` +
    (threshold.overshoot > 0 ? `, OVERSHOT by ${threshold.overshoot}` : "")
  )
}

function attemptLines(block: EvaluationBlock): string[] {
  const lines = [`  BLOCK ${block.block}`]
  const attempts = block.attempts
  if (attempts === undefined || attempts.kind === "unavailable") {
    lines.push(`    attempts UNAVAILABLE — ${attempts?.reason ?? "no attempt count was composed"}`)
    return lines
  }
  lines.push(
    `    source: ${attempts.source}`,
    `    shared prefix, counted once: ${attemptCountText(attempts.prefix, attempts.thresholds.prefix)}`,
    `    ON continuation: ${attemptCountText(attempts.on, attempts.thresholds.on)}`,
    `    OFF continuation: ${attemptCountText(attempts.off, attempts.thresholds.off)}`,
  )
  if (attempts.contrast.kind === "exact") {
    lines.push(`    ON − OFF continuation attempts: exactly ${attempts.contrast.attempts}`)
    if (attempts.contrast.differentCaps !== undefined) lines.push(`      ${attempts.contrast.differentCaps}`)
  } else {
    lines.push(`    ON − OFF continuation attempts: unavailable — ${attempts.contrast.reason}`)
  }
  lines.push(
    `    block (prefix once + both continuations): ${attempts.total} newly issued attempt(s); ${thresholdText(attempts.thresholds.block)}`,
  )
  if (attempts.rows.length > 0) lines.push("    by stage and slot:")
  for (const row of attempts.rows) {
    lines.push(
      `      ${row.phase} ${row.stage}/${row.slot} — ${row.model} (model from ${row.modelSource}): ${row.first} first, ` +
        `${row.retries} retr${row.retries === 1 ? "y" : "ies"}`,
    )
  }
  if (attempts.noHostUsage > 0) {
    lines.push(`    ${attempts.noHostUsage} attempt(s) settled with no host-reported usage — a diagnostic; each is counted above`)
  }
  if (attempts.notIssued > 0) {
    lines.push(`    ${attempts.notIssued} admitted attempt(s) settled \`not-issued\` never reached a backend and are excluded`)
  }
  return lines
}

function treatmentLines(block: EvaluationBlock): string[] {
  const treatment = block.treatment
  const lines = [`  BLOCK ${block.block}`]
  const opportunity = treatment.opportunity
  if (opportunity.kind === "known") {
    lines.push(
      `    OFF run \`${treatment.offRunId}\`: normal policy would have debated ` +
        `${countText(opportunity.wouldHaveDebated, opportunity.toJudge)} candidates sent to the judge`,
    )
    if (opportunity.wouldHaveDebated === 0) lines.push(`    ${NO_TREATMENT_OPPORTUNITY}`)
  } else {
    lines.push(`    treatment opportunity: unknown — ${opportunity.why}`)
  }
  const debate = treatment.debate
  const on = treatment.onRunId === null ? "ON arm" : `ON run \`${treatment.onRunId}\``
  if (debate.kind === "ran") lines.push(`    ${on}: the debate stage ran and debated ${debate.debated} candidate(s)`)
  else if (debate.kind === "did-not-run") lines.push(`    ${on}: the debate stage did not run`)
  else lines.push(`    ${on}: whether debate ran is unknown — ${debate.why}`)
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
