/**
 * The aligner's CROSS-ARM error, counted offline on the sealed cross-arm case
 * set (`fixtures/cross-arm-pairs/`), and the one rule that decides where those
 * counts may be printed (FR3, FR4).
 *
 * ## What is measured
 *
 * Each case is run through `alignArms` itself — the function the report's
 * difference count comes from, not a reimplementation — with the case's arm A
 * and arm B findings. "Grouped" means the subject findings landed in one
 * `AlignedGroup` of any kind.
 *
 * - over-merge = `distinct` + `only-in-one-arm` cases grouped / those cases.
 *   For `only-in-one-arm`, grouped means the subject's group holds ANY arm-B
 *   finding, since arm B has no counterpart for it.
 * - under-merge = `equivalent` cases not grouped / those cases.
 * - `ambiguous` cases are measured, printed, and excluded from both
 *   denominators. The labeller could not decide them, so neither outcome is an
 *   error.
 *
 * Counts, never floats. A zero denominator renders "not measurable (0 cases)",
 * never `0 of 0`, which reads as a perfect rate over nothing.
 *
 * The matcher is deterministic, so scoring bills nothing: no model call, and
 * `evaluation-protocol.md`'s Calibration allowance is untouched.
 *
 * ## What the counts are, and are not
 *
 * They are counts over a small set of hand-built cases that cite one change's
 * files and lines, some built so the shipped matcher gets them wrong. They are
 * not a measurement of any run's own findings, the denominators are small, and
 * they carry over to no other change.
 *
 * ## Where the counts apply: one rule
 *
 * `crossArmCalibrationFor(change)` returns the calibration exactly when
 * `changeIdFor(change).diffHash` equals the set's recorded `sourceDiffHash`, and
 * `undefined` otherwise. There is no flag and no second rule. On any other diff
 * the cases cite lines that are not there, and printing the counts would replace
 * the UNMEASURED disclosure with numbers that do not apply.
 *
 * ## Refusals, not silent numbers
 *
 * `measureCrossArm` THROWS rather than scoring when a case is malformed (a
 * missing subject, or a finding id repeated inside one case — `alignArms`
 * resolves findings by id, so a repeat would silently overwrite one) and when the
 * matcher threw on any comparison. The engine counts a throw as "not similar",
 * which would add a silent under-merge the matcher never decided.
 */

import { findingBlockKey, lexicalSimilarity } from "../core/clustering/similarity.ts"
import type { BlockKey, Similar } from "../core/clustering/engine.ts"
import type { Finding } from "../core/domain/finding.ts"
import type { ChangeSet } from "../core/ports/repo.ts"
import {
  CROSS_ARM_CASES,
  CROSS_ARM_LABELS,
  type CrossArmCase,
  type CrossArmLabel,
} from "../fixtures/cross-arm-pairs/cases.ts"
import { CROSS_ARM_PAIRS_SEAL, datasetHashOf } from "../fixtures/cross-arm-pairs/seal.ts"
import { ALIGNER_MATCHER, alignArms, type AlignerMatcher } from "./align.ts"
import { changeIdFor } from "./manifest.ts"

export interface CrossArmOutcome {
  id: string
  label: CrossArmLabel
  /** Did the subject(s) share one `AlignedGroup`? See the module header. */
  grouped: boolean
  /** Whether `grouped` agrees with the label. `undefined` for `ambiguous`. */
  correct?: boolean
  why: string
}

export interface CrossArmCalibration {
  /** The set's hand-written version, or `unsealed` when the cases are not the sealed set. */
  version: string
  /** `sha256:` over the canonical text of the cases actually measured. */
  datasetHash: string
  /**
   * The recorded diff hash of the change the sealed set was drawn from.
   *
   * `null` for an unsealed set. Nobody recorded which change injected or edited
   * cases were drawn from, so no change can be named, and a calibration carrying
   * the sealed set's source diff would claim an applicability it does not have.
   */
  sourceDiffHash: string | null
  /** How many cases were measured, ambiguous included. */
  samples: number
  labelCounts: Record<CrossArmLabel, number>
  /** The shipped matcher's identity, or `injected` when a caller supplied another. */
  matcher: AlignerMatcher | "injected"
  /** `distinct` + `only-in-one-arm` cases grouped. */
  overMerge: { grouped: number; of: number }
  /** `equivalent` cases not grouped. */
  underMerge: { ungrouped: number; of: number }
  /** `ambiguous` cases, excluded from both denominators. */
  ambiguousExcluded: number
}

export interface CrossArmMeasurement {
  calibration: CrossArmCalibration
  outcomes: CrossArmOutcome[]
}

/** `x of y`, or `not measurable (0 cases)` when there is nothing to divide by. */
export function countText(count: number, of: number): string {
  return of === 0 ? "not measurable (0 cases)" : `${count} of ${of}`
}

/**
 * A non-negative plain decimal as an exact ratio of integers (`0.34` →
 * `34/100`), so a matcher configuration renders without a float in a report that
 * prints none. THROWS on anything `String()` does not write as plain digits with
 * at most one point — `1e-7`, a negative, `NaN`, `Infinity` — because converting
 * those text-wise would print a wrong ratio.
 */
export function decimalText(value: number): string {
  const text = String(value)
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(
      `decimalText: ${text} is not a non-negative plain decimal, so it has no exact integer ratio to print`,
    )
  }
  const point = text.indexOf(".")
  if (point === -1) return text
  const digits = text.length - point - 1
  return `${Number(text.replace(".", ""))}/${10 ** digits}`
}

/** The matcher's version and configuration, as one line of report text. */
export function matcherText(matcher: CrossArmCalibration["matcher"]): string {
  if (matcher === "injected") return "injected (not the shipped matcher; no version)"
  return (
    `${matcher.version} (line tolerance ${matcher.lineTolerance}, ` +
    `overlap threshold ${decimalText(matcher.overlapThreshold)}, ` +
    `block key ${matcher.blockKey}, linkage ${matcher.linkage})`
  )
}

function refusal(c: CrossArmCase, what: string): Error {
  return new Error(`measureCrossArm: case ${JSON.stringify(c.id)} ${what}`)
}

function validate(c: CrossArmCase): void {
  const ids = [...c.armA, ...c.armB].map((f) => f.id)
  const repeated = ids.filter((id, index) => ids.indexOf(id) !== index)
  if (repeated.length > 0) {
    throw refusal(c, `repeats finding id(s) ${JSON.stringify([...new Set(repeated)])}`)
  }
  if (!c.armA.some((f) => f.id === c.subjectA)) throw refusal(c, "has no subjectA in arm A")
  if (c.label === "only-in-one-arm") {
    if (c.subjectB !== undefined) throw refusal(c, "is only-in-one-arm but names a subjectB")
  } else if (!c.armB.some((f) => f.id === c.subjectB)) {
    throw refusal(c, "has no subjectB in arm B")
  }
}

async function outcomeOf(
  c: CrossArmCase,
  similar: Similar<Finding>,
  blockKey: BlockKey<Finding>,
): Promise<CrossArmOutcome> {
  validate(c)
  const alignment = await alignArms(
    { id: "a", findings: c.armA },
    { id: "b", findings: c.armB },
    similar,
    blockKey,
  )
  if (alignment.failures > 0) {
    throw refusal(
      c,
      `could not be scored: the matcher threw on ${alignment.failures} comparison(s), and a throw ` +
        `counted as "not similar" would be an outcome the matcher never decided`,
    )
  }
  const group = alignment.groups.find((g) => g.a.some((f) => f.id === c.subjectA))
  const grouped =
    group !== undefined &&
    (c.label === "only-in-one-arm" ? group.b.length > 0 : group.b.some((f) => f.id === c.subjectB))

  const shouldGroup = c.label === "equivalent"
  return {
    id: c.id,
    label: c.label,
    grouped,
    ...(c.label === "ambiguous" ? {} : { correct: grouped === shouldGroup }),
    why: c.why,
  }
}

/**
 * Score a matcher on a cross-arm case set. Defaults are the sealed set and the
 * shipped matcher; injecting either is how a degenerate or replacement matcher
 * is measured, and the result's `version`, `sourceDiffHash` and `matcher` say so.
 */
export async function measureCrossArm(
  cases: readonly CrossArmCase[] = CROSS_ARM_CASES,
  similar: Similar<Finding> = lexicalSimilarity,
  blockKey: BlockKey<Finding> = findingBlockKey,
): Promise<CrossArmMeasurement> {
  const outcomes: CrossArmOutcome[] = []
  for (const c of cases) outcomes.push(await outcomeOf(c, similar, blockKey))

  const labelCounts = Object.fromEntries(
    CROSS_ARM_LABELS.map((label) => [label, outcomes.filter((o) => o.label === label).length]),
  ) as Record<CrossArmLabel, number>

  const shouldSeparate = outcomes.filter(
    (o) => o.label === "distinct" || o.label === "only-in-one-arm",
  )
  const equivalent = outcomes.filter((o) => o.label === "equivalent")
  const datasetHash = datasetHashOf(cases)
  const sealed = datasetHash === CROSS_ARM_PAIRS_SEAL.datasetHash

  return {
    calibration: {
      version: sealed ? CROSS_ARM_PAIRS_SEAL.version : "unsealed",
      datasetHash,
      sourceDiffHash: sealed ? CROSS_ARM_PAIRS_SEAL.sourceDiffHash : null,
      samples: outcomes.length,
      labelCounts,
      matcher:
        similar === lexicalSimilarity && blockKey === findingBlockKey ? ALIGNER_MATCHER : "injected",
      overMerge: { grouped: shouldSeparate.filter((o) => o.grouped).length, of: shouldSeparate.length },
      underMerge: { ungrouped: equivalent.filter((o) => !o.grouped).length, of: equivalent.length },
      ambiguousExcluded: labelCounts.ambiguous,
    },
    outcomes,
  }
}

/**
 * The calibration a report may carry: the sealed set, scored by the shipped
 * matcher. THROWS otherwise — cases that no longer hash to the seal are not the
 * set the literal names, and printing them under that name would be a false
 * identity. `seal.test.ts` is red in the same state.
 */
export function sealedCalibration(measurement: CrossArmMeasurement): CrossArmCalibration {
  const { calibration } = measurement
  if (calibration.version !== CROSS_ARM_PAIRS_SEAL.version || calibration.matcher === "injected") {
    throw new Error(
      `crossArmCalibrationFor: the cross-arm cases hash to ${calibration.datasetHash}, not the sealed ` +
        `${CROSS_ARM_PAIRS_SEAL.datasetHash} (${CROSS_ARM_PAIRS_SEAL.version}), or were scored by an ` +
        `injected matcher. Bump the set version and re-seal deliberately; see fixtures/cross-arm-pairs/seal.test.ts.`,
    )
  }
  return calibration
}

/**
 * The sealed set's calibration of the shipped matcher, when `change` is the
 * change the set was drawn from; otherwise `undefined`. The only applicability
 * rule: equal diff hashes. Throws, via `sealedCalibration`, when the diff
 * applies but the cases have drifted from their seal.
 */
export async function crossArmCalibrationFor(
  change: ChangeSet,
): Promise<CrossArmCalibration | undefined> {
  if (changeIdFor(change).diffHash !== CROSS_ARM_PAIRS_SEAL.sourceDiffHash) return undefined
  return sealedCalibration(await measureCrossArm())
}
