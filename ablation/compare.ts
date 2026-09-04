/**
 * CAP-9's arithmetic. Pure: it prints nothing, asserts nothing, and touches no
 * filesystem.
 *
 * ## Four numbers, four objects, and nothing divides one by another
 *
 * AD-9's whole content is that separately-derived facts stay separate fields.
 * The verdict difference is a count of findings; the token cost is a count of
 * tokens; the lens recall gain is a count of defects; the lens token cost is a
 * count of tokens. A single "was debate worth it?" score would need to fuse a
 * defect count with a token count, and the exchange rate between them is the
 * READER's judgement and not this module's. `compare.test.ts` asserts that no
 * key anywhere in the report object is named `score`, `rate`, `efficiency`,
 * `ratio` or `perToken`, the same way `rates.test.ts` already asserts it for
 * CAP-2.
 *
 * ## `undefined` is not a verdict, and it has TWO causes
 *
 * `Finding.verdict` is optional and its absence means one of two different
 * things: the finding was left `unresolved` because the money or the user ran
 * out (AD-6d), or it never reached the judge at all. Folding either into a
 * verdict bucket would restate *undecided* as *decided-not-adjudicated*, which
 * is the coercion AD-9's amendment forbids one level down. `verdictState` is
 * total over six values so the two absences can never collapse, and a matched
 * pair where either side is undecided enters NEITHER half of the fraction.
 */

import { spentTokens } from "../core/budget/ledger.ts"
import type { LensGain } from "../fixtures/recall.ts"
import { measurePairs } from "../core/clustering/fixtures/rates.ts"
import type { Finding } from "../core/domain/finding.ts"
import type { RunRecord } from "../core/domain/run-record.ts"
import type { Warning } from "../core/domain/warning.ts"
import type { Alignment } from "./align.ts"
import type { ArmRun } from "./arms.ts"

/**
 * What one finding's adjudication came to — TOTAL over six values, so no absence
 * is ever coerced into a decision.
 *
 * The four `Verdict` members are decisions. `unresolved` is AD-6d: the money or
 * the user ran out before this finding was decided. `unjudged` is a finding the
 * judge never reached — routed away, or the stage never ran. They are three
 * different facts and this function keeps them three.
 */
export type VerdictState =
  | "upheld"
  | "withdrawn-by-author"
  | "judge-ruled-invalid"
  | "not-adjudicated"
  | "unresolved"
  | "unjudged"

export function verdictState(finding: Finding): VerdictState {
  if (finding.verdict !== undefined) return finding.verdict
  if (finding.unresolved !== undefined) return "unresolved"
  return "unjudged"
}

/** Whether a state is a DECISION rather than an absence of one. */
function decided(state: VerdictState): boolean {
  return state !== "unresolved" && state !== "unjudged"
}

export interface VerdictDifference {
  /** Matched pairs whose two sides carry DIFFERENT decisions. */
  differing: number
  /**
   * The denominator: matched pairs where BOTH sides carry a decision. Named `of`
   * rather than `total` because it is the second half of a fraction and never a
   * population — `report.ts` renders every rate as `differing of N`, never as a
   * percentage, so a reader cannot lose the denominator on the way to a number.
   */
  of: number
  /** Matched pairs where at least one side was undecided. In neither half. */
  undecided: number
  /** Findings only one arm raised. Never in the denominator. */
  onlyIn: { a: number; b: number }
  /** Groups with no 1:1 correspondence. Excluded, and COUNTED so the exclusion is visible. */
  ambiguous: number
  /** The pairs, for a report that wants to name them. */
  differences: { a: Finding; b: Finding; aState: VerdictState; bState: VerdictState }[]
}

export function verdictDifference(alignment: Alignment): VerdictDifference {
  let differing = 0
  let of = 0
  let undecided = 0
  let onlyA = 0
  let onlyB = 0
  let ambiguous = 0
  const differences: VerdictDifference["differences"] = []

  for (const group of alignment.groups) {
    if (group.kind === "only-a") {
      onlyA += group.a.length
      continue
    }
    if (group.kind === "only-b") {
      onlyB += group.b.length
      continue
    }
    if (group.kind === "ambiguous") {
      ambiguous += 1
      continue
    }
    const a = group.a[0]!
    const b = group.b[0]!
    const aState = verdictState(a)
    const bState = verdictState(b)
    if (!decided(aState) || !decided(bState)) {
      undecided += 1
      continue
    }
    of += 1
    if (aState !== bState) {
      differing += 1
      differences.push({ a, b, aState, bState })
    }
  }

  return { differing, of, undecided, onlyIn: { a: onlyA, b: onlyB }, ambiguous, differences }
}

export interface ArmCost {
  /** From the accountant's own total. This module never re-sums a ledger. */
  tokens: number
  billedTurns: number
  /** The five components, carried individually — a total is not a breakdown. */
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  /** `null` means no ceiling. Rendered as `none`, NEVER as `0`. */
  cap: number | null
}

export function armCost(record: RunRecord): ArmCost {
  const t = record.ledger.total
  return {
    tokens: spentTokens(t),
    billedTurns: record.ledger.entries.length,
    input: t.input,
    output: t.output,
    reasoning: t.reasoning,
    cacheRead: t.cacheRead,
    cacheWrite: t.cacheWrite,
    cap: record.ledger.cap,
  }
}

/**
 * What the lens pass COST, as tokens and turns — and it carries no defect field,
 * deliberately.
 *
 * The lens recall GAIN is a count of defects and comes from
 * `fixtures/recall.ts`'s `lensRecallGain`, untouched. Putting the two in one
 * object would be the first step toward dividing them, and whether three defects
 * are worth sixty thousand tokens is the reader's call.
 */
export interface LensTokenCost {
  tokens: number
  billedTurns: number
}

export function lensTokenCost(withLenses: RunRecord, without: RunRecord): LensTokenCost {
  return {
    tokens: spentTokens(withLenses.ledger.total) - spentTokens(without.ledger.total),
    billedTurns: withLenses.ledger.entries.length - without.ledger.entries.length,
  }
}

/**
 * Findings citing a file but no line.
 *
 * Reported per arm because of a specific silent veto: the shipped block key is
 * the file's basename and `lexicalSimilarity` requires line ranges within
 * tolerance, so a file-level finding can never align with a line-cited one for
 * the same defect however similar their claims. Every such finding is a pair the
 * aligner was structurally unable to make, and a reader comparing arms deserves
 * the count.
 */
export function fileLevelFindings(record: RunRecord): number {
  return record.findings.filter(
    (finding) => finding.locus.startLine === undefined || finding.locus.endLine === undefined,
  ).length
}

/**
 * Whether this arm's own run was degraded, and how — AD-6.
 *
 * An arm that lost half its roster, ran out of budget, or was cancelled is not a
 * clean measurement of anything, and `report.ts` refuses to draw an experimental
 * line from one. The three causes stay three: a degraded arm is not
 * interchangeable with a cancelled one or a truncated one.
 */
export interface Degradation {
  degraded: boolean
  warnings: Warning[]
  budgetSkipped: number
  cancelledAt?: string
}

export function degradation(record: RunRecord): Degradation {
  const warnings = record.warnings.filter((warning) => warning.code !== "provider-fan-out")
  const budgetSkipped = record.skippedForBudget?.length ?? 0
  return {
    degraded: warnings.length > 0 || budgetSkipped > 0 || record.cancelled !== undefined,
    warnings,
    budgetSkipped,
    ...(record.cancelled === undefined ? {} : { cancelledAt: record.cancelled.stage }),
  }
}

/**
 * Everything about a PAIR of arms that is not one of the four numbers — the
 * reasons a difference between them might not mean what it looks like.
 *
 * They are computed rather than written down so they cannot go stale, and they
 * are printed BESIDE the numbers rather than in a footnote.
 */
export interface Confounders {
  /** True when either arm's own run was degraded. */
  eitherDegraded: boolean
  /**
   * At `answered: 1` the co-discovery threshold cannot route anything to debate
   * on its own — a lone finding has a 1/1 fraction, which meets every threshold.
   * It is NOT true that nothing debates: `route.ts` overrides the threshold for
   * `critical` severity at any setting, so a critical finding still routes.
   * Stating the vacuity narrowly is the difference between a caveat and a
   * falsehood.
   */
  thresholdVacuousExceptCritical: boolean
  /** Arms whose rosters differ in more than the one variable under test. */
  dialsDiffer: string[]
}

export function confounders(a: ArmRun, b: ArmRun): Confounders {
  const dialsDiffer: string[] = []
  const compare = (name: string, left: unknown, right: unknown): void => {
    if (left !== right) dialsDiffer.push(`${name}: ${String(left)} vs ${String(right)}`)
  }
  compare("threshold", a.record.threshold, b.record.threshold)
  compare("maxRounds", a.record.maxRounds, b.record.maxRounds)
  compare("tokenCap", a.record.ledger.cap, b.record.ledger.cap)
  compare("maxConcurrency", a.record.ledger.maxConcurrency, b.record.ledger.maxConcurrency)

  return {
    eitherDegraded: degradation(a.record).degraded || degradation(b.record).degraded,
    thresholdVacuousExceptCritical: a.record.answered === 1 || b.record.answered === 1,
    dialsDiffer,
  }
}

export interface PairingReport {
  a: string
  b: string
  difference: VerdictDifference
  alignment: {
    comparisons: number
    failures: number
    candidatePairs: number
    blockedPairs: number
  }
  confounders: Confounders
}

export interface AblationReport {
  arms: {
    id: string
    label: string
    provenance: string
    slots: number
    lenses: string[]
    pinned: string[]
    answered: number
    findings: number
    pooled: number
    cost: ArmCost
    fileLevel: number
    degradation: Degradation
    routeCounts?: unknown
    debateCounts?: unknown
    judgeCounts?: unknown
  }[]
  pairings: PairingReport[]
  /**
   * The lens numbers, kept apart: a count of DEFECTS from the recall harness,
   * and a count of TOKENS from the ledger. `undefined` when the caller had no
   * seeded defect set — rendered "not applicable", never as `0`.
   */
  lens?: { gain?: LensGain; cost: LensTokenCost }
  /**
   * The matcher's only measured error, computed LIVE by calling `measurePairs()`
   * rather than pasted in as a literal, so it cannot go stale when the matcher
   * or the labelled set changes.
   *
   * Just the two rates: the full outcome list belongs to
   * `bun run clustering-rates`, which is where a reader goes to see WHICH rows
   * the matcher gets wrong. Pasting eight rows of prose into the middle of this
   * report's limitations block buries the one sentence a reader has to read.
   */
  matcherCalibration: { overMerge: { merged: number; of: number }; underMerge: { unmerged: number; of: number } }
  /** True when ANY arm was scripted. Drives a banner that cannot be suppressed. */
  anyScripted: boolean
}

export interface BuildOptions {
  pairings: readonly { a: string; b: string; alignment: Alignment }[]
  lens?: { gain?: LensGain; cost: LensTokenCost }
}

export async function buildReport(
  runs: readonly ArmRun[],
  options: BuildOptions,
): Promise<AblationReport> {
  const byId = new Map(runs.map((run) => [run.spec.id, run]))

  return {
    arms: runs.map((run) => ({
      id: run.spec.id,
      label: run.spec.label,
      provenance: run.spec.provenance,
      slots: run.record.roster.slots.length,
      lenses: run.record.roster.lensSlots.map((slot) => slot.lens),
      pinned: (run.spec.pins ?? []).map((p) => `${p.providerId}/${p.modelId}`),
      answered: run.record.answered,
      findings: run.record.findings.length,
      pooled: run.record.pool.length,
      cost: armCost(run.record),
      fileLevel: fileLevelFindings(run.record),
      degradation: degradation(run.record),
      ...(run.record.routeCounts === undefined ? {} : { routeCounts: run.record.routeCounts }),
      ...(run.record.debateCounts === undefined ? {} : { debateCounts: run.record.debateCounts }),
      ...(run.record.judgeCounts === undefined ? {} : { judgeCounts: run.record.judgeCounts }),
    })),
    pairings: options.pairings.map((pairing) => {
      const a = byId.get(pairing.a)!
      const b = byId.get(pairing.b)!
      return {
        a: pairing.a,
        b: pairing.b,
        difference: verdictDifference(pairing.alignment),
        alignment: {
          comparisons: pairing.alignment.comparisons,
          failures: pairing.alignment.failures,
          candidatePairs: pairing.alignment.candidatePairs,
          blockedPairs: pairing.alignment.blockedPairs,
        },
        confounders: confounders(a, b),
      }
    }),
    ...(options.lens === undefined ? {} : { lens: options.lens }),
    matcherCalibration: (({ overMerge, underMerge }) => ({ overMerge, underMerge }))(
      await measurePairs(),
    ),
    anyScripted: runs.some((run) => run.spec.provenance === "scripted"),
  }
}
