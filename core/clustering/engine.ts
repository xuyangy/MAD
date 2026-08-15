/**
 * The clustering engine — CAP-2's core, and the one module AD-14 keeps sealed.
 *
 * AD-14 — this file imports NO port, NO stage, NO run state and NO host type. It
 * takes a list of id-bearing items plus an injected similarity function and
 * returns clusters. It writes nothing onto the items it was given; the STAGE
 * (`core/stages/cluster.ts`) is what writes fields. That separation is what lets
 * v2's instance memory (`deferred-v2.md`) be this same engine pointed at
 * rejection history rather than a second implementation of the same idea.
 *
 * Generic over `Clusterable` rather than typed to `Finding` for the same reason:
 * `Finding` already satisfies the constraint, so the generality costs one type
 * parameter now and saves a rewrite later.
 *
 * ## Single linkage, and its failure mode stated out loud
 *
 * Membership is the transitive closure of the pairwise relation (union-find). So
 * `A~B, B~C, A≁C` produces ONE cluster of three, even though the engine was
 * never told A and C are the same defect. That is a real OVER-MERGE. It is not a
 * bug to be quietly worked around — it is documented here, fixtured in
 * `fixtures/pairs.ts`, and COUNTED in `fixtures/rates.ts`'s over-merge rate.
 * `pipeline-stages.md` §2 is explicit that over-merge and under-merge cost
 * opposite things; the honest surface for this trade is a measured rate, not a
 * cleverer default nobody can score.
 *
 * ## Determinism
 *
 * Pairs are compared in ascending index order and awaited one at a time, so the
 * result never depends on how fast a matcher answers — which a model-backed
 * matcher varies wildly. Clusters come back ordered by their earliest-appearing
 * member, `memberIds` in input order, and `Cluster.id` is `cluster-<n>` by that
 * same order. The id is allocated here and NOT from a `Clock`: the engine
 * imports no port (AD-14), and a run-scoped id would make two runs over one
 * input print differently.
 */

/** The only thing the engine requires of an item. `Finding` already meets it. */
export interface Clusterable {
  id: string
}

/**
 * The injected relation. May be async, and that is deliberate: a sync-only
 * signature is the single decision that would force this file open again when a
 * model-backed matcher arrives, which is precisely the reopening AD-14 exists to
 * prevent.
 */
export type Similar<T> = (a: T, b: T) => boolean | Promise<boolean>

/**
 * The injected comparison budget. Two items are candidates only when their keys
 * are equal, so a matcher is never billed for a pair that could not be the same
 * site. The default is permissive — everything is a candidate — so a caller that
 * has no blocking notion still gets correct answers.
 */
export type BlockKey<T> = (item: T) => string

export interface Cluster {
  id: string
  memberIds: string[]
}

export interface ClusterResult {
  clusters: Cluster[]
  /**
   * How many similarity calls were actually made. AD-15's ledger does not exist
   * yet (`deferred-work.md`: no accountant), so this is what makes a
   * model-backed matcher's O(n²) cost visible BEFORE it is paid.
   */
  comparisons: number
  /**
   * How many of those calls threw or rejected. Each was treated as "not
   * similar"; none aborted the run.
   */
  failures: number
}

export async function clusterItems<T extends Clusterable>(
  items: readonly T[],
  similar: Similar<T>,
  blockKey: BlockKey<T> = () => "",
): Promise<ClusterResult> {
  const parent = items.map((_, index) => index)

  function find(index: number): number {
    let node = index
    while (parent[node] !== node) {
      parent[node] = parent[parent[node]!]!
      node = parent[node]!
    }
    return node
  }

  /** Union by LOWEST index, so a group's root is always its earliest member. */
  function union(a: number, b: number): void {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA === rootB) return
    if (rootA < rootB) parent[rootB] = rootA
    else parent[rootA] = rootB
  }

  const keys = items.map((item) => blockKey(item))
  let comparisons = 0
  let failures = 0

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (keys[i] !== keys[j]) continue
      // Already transitively joined: under single linkage a further edge between
      // them cannot change the partition, so the call would be paid for nothing.
      if (find(i) === find(j)) continue

      comparisons += 1
      let verdict = false
      try {
        verdict = await similar(items[i]!, items[j]!)
      } catch {
        // A failed comparison is "not similar", not a crashed run (spine,
        // Errors). Counted so a silently broken matcher cannot masquerade as a
        // pool in which nothing happened to match.
        failures += 1
        verdict = false
      }
      if (verdict) union(i, j)
    }
  }

  // Ascending `i` means each root is first seen at its earliest member, so Map
  // insertion order IS the required cluster order and members land in input order.
  const groups = new Map<number, string[]>()
  for (let i = 0; i < items.length; i += 1) {
    const root = find(i)
    const members = groups.get(root)
    if (members) members.push(items[i]!.id)
    else groups.set(root, [items[i]!.id])
  }

  const clusters = [...groups.values()].map((memberIds, index) => ({
    id: `cluster-${index + 1}`,
    memberIds,
  }))

  return { clusters, comparisons, failures }
}
