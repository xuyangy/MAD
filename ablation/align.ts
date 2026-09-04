/**
 * CAP-9's hardest problem: two arms produce DIFFERENT finding sets, so
 * "debate changed this verdict" needs a way to say that a finding in arm A is
 * the same defect as one in arm B.
 *
 * ## The instrument is the one this repo already measured
 *
 * It reuses `clusterItems` from `core/clustering/engine.ts` unchanged, with the
 * shipped `lexicalSimilarity` and `findingBlockKey` as defaults. That is not
 * laziness — it is the only matcher in this tree whose error is a MEASURED
 * number rather than an assumption (`bun run clustering-rates`: over-merge 1/3,
 * under-merge 1/5). A hand-rolled cross-arm matcher would have no measured error
 * at all, and an unmeasured instrument reporting a rate is exactly the
 * overstatement CAP-9 exists to prevent.
 *
 * THE CALIBRATION DOES NOT TRANSFER, AND THE REPORT SAYS SO. Those two rates
 * were measured on an 8-row, single-file, WITHIN-run labelled set
 * (`core/clustering/fixtures/pairs.ts`). No cross-arm labelled set exists in this
 * repo, so the aligner's cross-arm error is UNMEASURED, and it enters the
 * difference count one for one: an over-merge invents a matched pair whose two
 * sides were never the same defect, and an under-merge hides a real pair in
 * `onlyIn`. `report.ts` prints that sentence above the number.
 *
 * ## It calls the ENGINE, never the stage
 *
 * `core/stages/cluster.ts` mutates findings in place (AD-7) and computes
 * single-run co-discovery. Running it over two arms' findings would rewrite the
 * records the report is about to read and stamp a co-discovery fraction whose
 * denominator spans two different rosters — a number that means nothing and
 * looks like it means something. This module copies before it touches anything
 * and returns the ORIGINALS, resolved back by id.
 *
 * ## Ids are namespaced, because both arms start at `finding-1`
 *
 * `fakeClock` numbers findings from 1 per run, so two arms genuinely collide on
 * ids. Namespacing with `armId::originalId` is what stops the union-find from
 * fusing arm A's first finding with arm B's first finding for no reason but
 * their names. An arm id containing `::` is refused rather than silently
 * producing an ambiguous split.
 */

import { clusterItems, type BlockKey, type Similar } from "../core/clustering/engine.ts"
import { findingBlockKey, lexicalSimilarity } from "../core/clustering/similarity.ts"
import type { Finding } from "../core/domain/finding.ts"

const SEPARATOR = "::"

/** One aligned group of findings, classified by which arms reached it. */
export interface AlignedGroup {
  /**
   * `matched` — exactly one finding from each arm. The ONLY kind that enters a
   * verdict-difference denominator.
   * `only-a` / `only-b` — one arm raised it and the other did not.
   * `ambiguous` — the matcher put two or more of ONE arm's findings in the same
   * group, so there is no 1:1 correspondence to compare. Excluded from the
   * denominator and COUNTED, because silently dropping it would shrink the
   * denominator and inflate whatever rate is computed over it.
   */
  kind: "matched" | "ambiguous" | "only-a" | "only-b"
  a: Finding[]
  b: Finding[]
}

export interface Alignment {
  groups: AlignedGroup[]
  /** How many similarity calls the engine actually billed. */
  comparisons: number
  /** How many threw. Each was treated as "not similar"; none aborted the run. */
  failures: number
  /** Every cross-arm pair that existed to be judged. */
  candidatePairs: number
  /**
   * Cross-arm pairs the BLOCK KEY vetoed before the matcher was asked.
   *
   * Counted here rather than read off the engine, which skips an unequal-key
   * pair before it counts a comparison. It is printed because it is a SILENT
   * VETO: the shipped block key is the file's basename, so a file-level finding
   * (no line cited) and a line-cited finding for the same defect can never be
   * compared at all, however similar their claims.
   */
  blockedPairs: number
}

function namespaced(finding: Finding, armId: string): Finding {
  return { ...finding, id: `${armId}${SEPARATOR}${finding.id}` }
}

function armOf(id: string): string {
  return id.slice(0, id.indexOf(SEPARATOR))
}

/**
 * Align two arms' findings.
 *
 * `similar` and `blockKey` are INJECTED with the shipped ones as defaults — the
 * same seam AD-14 gives the clustering engine and `measurePairs` already uses.
 * A model-backed cross-arm matcher, or a locus-only one, drops in here without
 * this file being reopened, and a test can drive a degenerate matcher to prove
 * the classification logic is the aligner's rather than the matcher's.
 *
 * It MUTATES NEITHER RECORD. The findings it clusters are shallow copies; the
 * findings it returns are the originals.
 */
export async function alignArms(
  a: { id: string; findings: readonly Finding[] },
  b: { id: string; findings: readonly Finding[] },
  similar: Similar<Finding> = lexicalSimilarity,
  blockKey: BlockKey<Finding> = findingBlockKey,
): Promise<Alignment> {
  for (const arm of [a, b]) {
    if (arm.id.length === 0 || arm.id.includes(SEPARATOR)) {
      throw new Error(
        `alignArms: an arm id must be non-empty and must not contain "${SEPARATOR}" ` +
          `(got ${JSON.stringify(arm.id)}). Ids are namespaced to keep two arms' ` +
          `identically-numbered findings apart, and an ambiguous id would silently ` +
          `misattribute a finding to the wrong arm.`,
      )
    }
  }
  if (a.id === b.id) throw new Error("alignArms: the two arms must have different ids")

  const byId = new Map<string, Finding>()
  const items: Finding[] = []
  for (const [arm, findings] of [
    [a.id, a.findings],
    [b.id, b.findings],
  ] as const) {
    for (const finding of findings) {
      const copy = namespaced(finding, arm)
      byId.set(copy.id, finding)
      items.push(copy)
    }
  }

  // The block key's silent veto, counted over CROSS-ARM pairs only — a
  // within-arm pair is not something this alignment was ever going to compare.
  let candidatePairs = 0
  let blockedPairs = 0
  for (const left of items) {
    for (const right of items) {
      if (left.id >= right.id) continue
      if (armOf(left.id) === armOf(right.id)) continue
      candidatePairs += 1
      if (blockKey(left) !== blockKey(right)) blockedPairs += 1
    }
  }

  const result = await clusterItems(items, similar, blockKey)

  const groups: AlignedGroup[] = result.clusters.map((cluster) => {
    const inA: Finding[] = []
    const inB: Finding[] = []
    for (const memberId of cluster.memberIds) {
      const original = byId.get(memberId)
      if (!original) continue
      if (armOf(memberId) === a.id) inA.push(original)
      else inB.push(original)
    }
    const kind: AlignedGroup["kind"] =
      inA.length === 1 && inB.length === 1
        ? "matched"
        : inA.length === 0
          ? "only-b"
          : inB.length === 0
            ? "only-a"
            : "ambiguous"
    return { kind, a: inA, b: inB }
  })

  return {
    groups,
    comparisons: result.comparisons,
    failures: result.failures,
    candidatePairs,
    blockedPairs,
  }
}
