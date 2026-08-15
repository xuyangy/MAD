/**
 * CAP-2's success criterion, mechanically: over-merge and under-merge as TWO
 * SEPARATE COUNTS (AD-14).
 *
 * They are never fused into one accuracy number. `pipeline-stages.md` §2 is
 * explicit that they fail in opposite directions and cost opposite things —
 * over-merge ERASES a distinct bug, under-merge INFLATES one agreement into
 * three lonely findings — and one number would let a matcher trade a defect the
 * reader never sees for a duplicate the reader can ignore.
 *
 * Counts, never pre-divided floats, exactly as `fixtures/recall.ts` states for
 * the recall side and the spine's Dates & numbers convention requires. Both
 * counts share their denominator with the fixture set, so nothing needs dividing
 * to compare two matchers.
 *
 * The matcher is a PARAMETER with the shipped one as its default, so a
 * model-backed matcher is measured by this harness without editing it (AD-14).
 */

import type { Finding } from "../../domain/finding.ts"
import { clusterItems, type BlockKey, type Similar } from "../engine.ts"
import { findingBlockKey, lexicalSimilarity } from "../similarity.ts"
import { PAIRS, type PairLabel, type PairRow } from "./pairs.ts"

export interface PairOutcome {
  id: string
  label: PairLabel
  /** Did `a` and `b` land in one cluster? */
  merged: boolean
  /** Did that agree with the human label? */
  correct: boolean
  /** How many findings the row was measured over — two, or three for a chain. */
  items: number
  why: string
}

export interface RateReport {
  /** Distinct pairs the engine merged anyway. A merge erases a real defect. */
  overMerge: { merged: number; of: number }
  /** Equivalent pairs the engine left apart. A miss inflates one bug into many. */
  underMerge: { unmerged: number; of: number }
  outcomes: PairOutcome[]
}

/**
 * Each row is measured by running the ENGINE over that row's own findings and
 * asking whether `a` and `b` landed in one cluster — the same engine the stage
 * uses, so a row cannot pass against a simplified reimplementation of it.
 *
 * An ordinary row is its two items alone. The chain row carries a third in
 * `context`, because a transitive over-merge does not exist in a pair — it is
 * exactly what a third item creates.
 */
export async function measurePairs(
  pairs: readonly PairRow[] = PAIRS,
  similar: Similar<Finding> = lexicalSimilarity,
  blockKey: BlockKey<Finding> = findingBlockKey,
): Promise<RateReport> {
  const outcomes: PairOutcome[] = []

  for (const row of pairs) {
    const items = [row.a, ...(row.context ?? []), row.b]
    const result = await clusterItems(items, similar, blockKey)
    const cluster = result.clusters.find((c) => c.memberIds.includes(row.a.id))
    const merged = cluster?.memberIds.includes(row.b.id) === true

    outcomes.push({
      id: row.id,
      label: row.label,
      merged,
      correct: merged === (row.label === "equivalent"),
      items: items.length,
      why: row.why,
    })
  }

  const distinct = outcomes.filter((o) => o.label === "distinct")
  const equivalent = outcomes.filter((o) => o.label === "equivalent")

  return {
    overMerge: { merged: distinct.filter((o) => o.merged).length, of: distinct.length },
    underMerge: { unmerged: equivalent.filter((o) => !o.merged).length, of: equivalent.length },
    outcomes,
  }
}
