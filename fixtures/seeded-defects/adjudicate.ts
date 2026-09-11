/**
 * The SECOND number: which findings a planted label covers, and which it does
 * not.
 *
 * `evaluation-protocol.md:130`, quoted because it is the entire reason this
 * module exists rather than a branch inside `recall()`:
 *
 * > "Truth labels score claims, not proximity. A finding matching no planted
 * > label is **not** proof of a false positive."
 *
 * Story 2.4's AC3 is that rule made mechanical: a live model's finding that no
 * label covers lands in `unlabelled`, and a human decides its truth label in
 * `ADJUDICATION.md`. It is never a false positive by default, because counting
 * it as one would score the LABEL SET — thirteen deliberately planted bugs in a
 * change that certainly contains others — rather than the model.
 *
 * ## Why this is a new module and not an edit to `fixtures/recall.ts`
 *
 * `recall()` iterates DEFECTS and asks which finding claims each one
 * (`recall.ts:213-229`). A finding matching nothing is simply never visited —
 * correct for a recall count, and exactly the gap AC3 names, because AC3 is a
 * question about FINDINGS. Two questions, two numbers, two modules (AD-9's
 * two-numbers rule applied to measurement rather than to output).
 *
 * `fixtures/recall.ts` is also under story 9's editing freeze
 * (`stories/9-the-ablation-harness.md:748`). This module reads its matcher and
 * changes nothing in it.
 *
 * ## What this module deliberately does NOT compute
 *
 * No precision. No false-positive count. No rate. No verdict. Story 2.8 owns
 * those under the frozen protocol's bound arithmetic
 * (`evaluation-protocol.md:130-140`), where an unlabelled upheld candidate is
 * reported as an INTERVAL rather than resolved one way by this module's
 * convenience. What comes back from here is a partition and nothing else: two
 * lists, both of them raw material for a human worksheet.
 *
 * Adjudication of those unlabelled candidates is **blind to arm outcomes** and an
 * uncertain label is **preserved**, not resolved for tidiness
 * (`evaluation-protocol.md:130-132, 170`). Those two rules stay in the frozen
 * protocol; `ADJUDICATION.md` restates them for the person filling the sheet in.
 */

import type { Finding } from "../../core/domain/finding.ts"
import {
  lexicalDefectMatcher,
  validateSeededDefects,
  type DefectMatcher,
  type SeededDefect,
} from "../recall.ts"

/** One finding a planted defect claims. */
export interface MatchedFinding {
  defectId: string
  finding: Finding
}

/**
 * The partition. Note what is NOT here: no count, no rate, no residual "false
 * positive" bucket. `unlabelled` is a queue for a human, not a score.
 */
export interface Adjudication {
  matched: MatchedFinding[]
  /**
   * Findings no planted defect claims. Each one needs an independent truth
   * label; until it has one it is neither a hit nor a miss, and `U` in the
   * protocol's `[TP/N, (TP+U)/N]` interval is how many of these there were.
   */
  unlabelled: Finding[]
}

/**
 * Partition a finding list against the planted defects.
 *
 * The matcher is INJECTED with the same shipped lexical default `recall()`
 * injects (`recall.ts:178`), for the same reason recorded there: a later story
 * can supply a model-backed matcher without reopening anything.
 *
 * The greedy rule is inherited rather than reinvented: defects are offered in
 * DECLARATION ORDER and each finding may be claimed by at most one of them, so a
 * finding whose prose happens to carry two defects' markers credits the first
 * and stays claimed. That is `foundIds`'s rule (`recall.ts:213-229`), and the
 * two modules must not disagree about which findings are spoken for — a finding
 * counted for recall over there and still sitting in `unlabelled` over here
 * would be one candidate wearing two truth states.
 */
export function adjudicate(
  defects: readonly SeededDefect[],
  findings: readonly Finding[],
  matcher: DefectMatcher = lexicalDefectMatcher,
): Adjudication {
  // The same well-formedness gate `recall()` runs before deriving any number
  // from the set. A duplicate defect id would put two `matched` rows under one
  // id, and an empty `markers` array makes a defect unmatchable by anyone — both
  // fail silently and in the flattering direction if left unchecked.
  validateSeededDefects(defects)

  const matched: MatchedFinding[] = []
  // CLAIMED BY INDEX, NOT BY OBJECT IDENTITY (review finding P17, 2026-09-11).
  //
  // A `Set<Finding>` keyed on the object made the partition stop covering its
  // input the moment the same `Finding` object appeared twice in `findings` —
  // which a caller pooling two arms' findings, or re-reading one bundle twice,
  // produces without doing anything strange. The first occurrence was claimed,
  // the set then reported the SECOND occurrence as claimed too, and it landed in
  // neither `matched` nor `unlabelled`: a candidate that silently left the
  // record. `matched.length + unlabelled.length === findings.length` is the
  // property this module exists to keep, because a dropped candidate is one no
  // human ever adjudicates.
  const claimed = new Set<number>()

  for (const defect of defects) {
    const index = findings.findIndex(
      (finding, at) => !claimed.has(at) && matcher(defect, finding),
    )
    if (index < 0) continue
    claimed.add(index)
    matched.push({ defectId: defect.id, finding: findings[index]! })
  }

  return { matched, unlabelled: findings.filter((_finding, at) => !claimed.has(at)) }
}
