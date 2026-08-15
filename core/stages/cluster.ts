/**
 * Stage 2 — CLUSTER (CAP-2).
 *
 * `pipeline-stages.md` §2 calls this "the weakest link in the design", and the
 * reason is that its two failure modes cost opposite things: over-merge ERASES a
 * distinct bug, under-merge INFLATES three agreements into three lonely
 * findings. Which is why its measurement ships with it — `core/clustering/
 * fixtures/` — rather than in a later story.
 *
 * The DECISION lives in `core/clustering/`, which is pure and knows nothing of
 * findings, stages or runs (AD-14). This file is the filter around it: it calls
 * the engine with an injected similarity function and writes the four fields
 * clustering owns (AD-8) — `clusterId`, `coDiscovery`, `mergedIds`,
 * `clusterSeverity` — and nothing else. It reads everything.
 *
 * Three rules that each look like a detail and are not:
 *
 * 1. `clusterId` on EVERY finding, singletons and absorbed members alike (AD-14
 *    amended 2). It is output's "clustering has run" discriminator.
 * 2. `raised` counts DISTINCT POOL AUTHORS. Not members — a verbose model
 *    raising one defect twice would manufacture agreement out of its own
 *    verbosity, and every story 4 threshold divides by this number. Not lens
 *    members — a lens was PROMPTED for its dimension, so it has no unprompted
 *    signal to contribute (CAP-11, AD-17d). A cluster with no pool member at all
 *    gets NO `coDiscovery`; `source` stays the discriminator (AD-9 amended).
 * 3. Nothing is deleted. An absorbed member is the same object, mutated in
 *    place (AD-7), still reachable from `RunRecord.pool` — which is what AD-17e's
 *    lens disclosure reads and what story 6's Evidence Extractor needs.
 */

import { clusterItems, type Cluster, type Similar } from "../clustering/engine.ts"
import { findingBlockKey, lexicalSimilarity } from "../clustering/similarity.ts"
import { appendEntry, severityRank, type Finding, type Severity } from "../domain/finding.ts"
import type { Clock } from "../ports/clock.ts"

export interface ClusterInput {
  /** The discovery pool, in roster order. Mutated in place (AD-7). */
  findings: Finding[]
  /** AD-6a — the co-discovery denominator: who ANSWERED, never who was asked. */
  answered: number
  /**
   * AD-14 — the similarity function is INJECTED, defaulted to the shipped
   * deterministic one. The model-backed matcher `stories.yaml` anticipates
   * arrives here, and nothing in `core/clustering/` reopens.
   */
  similar?: Similar<Finding>
  /**
   * A stage may hold a port; the ENGINE may not (AD-1, AD-14). This is here
   * because `Entry.at` is required by AD-7 and a stage that reached for
   * `new Date()` would make its own history entries untestable.
   */
  clock: Clock
}

export interface ClusterStageResult {
  /** The canonical findings only, in the input's relative order. */
  findings: Finding[]
  clusters: Cluster[]
}

/** AD-10 — the highest severity any member actually claimed. A merge never lowers one. */
function highestSeverity(members: readonly Finding[]): Severity {
  return members.reduce(
    (highest, member) => (severityRank(member.severity) > severityRank(highest) ? member.severity : highest),
    members[0]!.severity,
  )
}

/**
 * Deterministic by construction, so two runs over one input print alike:
 *
 * 1. A POOL member if the cluster has one. Never a lens member while a pool
 *    member exists — a lens canonical would render *not applicable —
 *    lens-sourced* over a cluster that genuinely carries a prior (AD-9, AD-17d).
 * 2. Then the highest `severity` among those candidates.
 * 3. Then the earliest member in input order, which is roster order.
 */
function chooseCanonical(members: readonly Finding[]): Finding {
  const pool = members.filter((member) => member.source === "pool")
  const candidates = pool.length > 0 ? pool : members
  let canonical = candidates[0]!
  for (const candidate of candidates) {
    if (severityRank(candidate.severity) > severityRank(canonical.severity)) canonical = candidate
  }
  return canonical
}

export async function cluster(input: ClusterInput): Promise<ClusterStageResult> {
  const { findings, answered, clock } = input
  const similar = input.similar ?? lexicalSimilarity

  const result = await clusterItems(findings, similar, findingBlockKey)
  const byId = new Map(findings.map((finding) => [finding.id, finding]))
  const canonicals: Finding[] = []
  const at = clock.now()

  for (const group of result.clusters) {
    const members = group.memberIds.map((id) => byId.get(id)!)
    const canonical = chooseCanonical(members)
    const absorbed = members.filter((member) => member !== canonical)

    // AD-14 amended 2 — on every member, canonical and absorbed alike.
    for (const member of members) member.clusterId = group.id

    // AD-9 — stored as a pair, never pre-divided, and never stamped on a cluster
    // with no pool member to claim it.
    const poolAuthors = new Set(
      members.filter((member) => member.source === "pool").map((member) => member.author),
    )
    if (poolAuthors.size > 0) canonical.coDiscovery = { raised: poolAuthors.size, answered }

    if (absorbed.length > 0) {
      canonical.mergedIds = absorbed.map((member) => member.id)

      // AD-10 — the cluster's severity is its own field. Written only when it
      // says something the canonical's own `severity` does not, so a reader
      // never has to reconcile two fields that agree.
      const highest = highestSeverity(members)
      if (highest !== canonical.severity) canonical.clusterSeverity = highest

      // AD-7 — append-only, both directions. The canonical records what it
      // absorbed and each absorbed member records which canonical took it, so a
      // transcript reference resolves from either end and nothing is orphaned.
      for (const member of absorbed) {
        appendEntry(canonical, {
          stage: "cluster",
          actor: member.author,
          at,
          kind: "merged",
          // Model-authored prose passes through unparsed (AD-11).
          body: member.claim,
        })
        appendEntry(member, {
          stage: "cluster",
          actor: "mad",
          at,
          kind: "merged-into",
          body: `merged into ${canonical.id} (${group.id})`,
        })
      }
    }

    canonicals.push(canonical)
  }

  // The engine orders clusters by their EARLIEST member, which is not the same
  // as the order of the members it chose as canonical: a cluster whose canonical
  // is a late, more severe finding would otherwise jump a singleton that came
  // before it. Sorting by input index makes the returned order the input's own,
  // as promised, and keeps two runs over one input identical.
  const index = new Map(findings.map((finding, position) => [finding.id, position]))
  canonicals.sort((a, b) => index.get(a.id)! - index.get(b.id)!)

  return { findings: canonicals, clusters: result.clusters }
}
