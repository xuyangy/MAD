import { describe, expect, test } from "bun:test"

import { clusterItems, type Similar } from "./engine.ts"

interface Item {
  id: string
  group?: string
}

const item = (id: string, group?: string): Item => ({ id, group })

/** Pairwise relation from an explicit edge list, so each test states its own graph. */
function edges(...pairs: [string, string][]): Similar<Item> {
  const set = new Set(pairs.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]))
  return (a, b) => set.has(`${a.id}|${b.id}`)
}

describe("clusterItems — the pure engine (AD-14)", () => {
  test("an empty list yields zero clusters and never divides by anything", async () => {
    const result = await clusterItems([], () => true)
    expect(result.clusters).toEqual([])
    expect(result.comparisons).toBe(0)
    expect(result.failures).toBe(0)
  })

  test("a one-item list yields ONE singleton cluster, not zero", async () => {
    // A singleton is a cluster. `clusterId` on every finding is what tells output
    // that clustering ran at all (AD-14 amended 2), so an engine that returned
    // nothing here would make a run of one finding look unclustered.
    const result = await clusterItems([item("a")], () => true)
    expect(result.clusters).toEqual([{ id: "cluster-1", memberIds: ["a"] }])
    expect(result.comparisons).toBe(0)
  })

  test("nothing similar means every item is its own cluster", async () => {
    const result = await clusterItems([item("a"), item("b"), item("c")], () => false)
    expect(result.clusters).toEqual([
      { id: "cluster-1", memberIds: ["a"] },
      { id: "cluster-2", memberIds: ["b"] },
      { id: "cluster-3", memberIds: ["c"] },
    ])
  })

  test("SINGLE LINKAGE: A~B, B~C, A≁C yields ONE cluster of three", async () => {
    // The documented over-merge failure mode, asserted deliberately rather than
    // discovered later. It is real, it is fixtured, and it is counted in the
    // over-merge rate — never hidden behind a cleverer default.
    const result = await clusterItems(
      [item("a"), item("b"), item("c")],
      edges(["a", "b"], ["b", "c"]),
    )
    expect(result.clusters).toEqual([{ id: "cluster-1", memberIds: ["a", "b", "c"] }])
  })

  test("clusters come back in order of their earliest member, members in input order", async () => {
    const result = await clusterItems(
      [item("a"), item("b"), item("c"), item("d")],
      edges(["b", "d"]),
    )
    expect(result.clusters).toEqual([
      { id: "cluster-1", memberIds: ["a"] },
      { id: "cluster-2", memberIds: ["b", "d"] },
      { id: "cluster-3", memberIds: ["c"] },
    ])
  })

  test("two runs over one input are identical — ids, order and membership", async () => {
    const items = [item("a"), item("b"), item("c"), item("d")]
    const relation = edges(["a", "c"], ["b", "d"])
    const first = await clusterItems(items, relation)
    const second = await clusterItems(items, relation)
    expect(second).toEqual(first)
  })

  test("an async matcher and a sync matcher give the same answer", async () => {
    const items = [item("a"), item("b"), item("c")]
    const sync = edges(["a", "c"])
    const async: Similar<Item> = async (a, b) => sync(a, b)
    expect(await clusterItems(items, async)).toEqual(await clusterItems(items, sync))
  })

  test("a matcher whose promises settle out of order changes nothing", async () => {
    // The engine's determinism must not rest on how fast a matcher answers. A
    // model-backed matcher answers at wildly different speeds per pair.
    const items = [item("a"), item("b"), item("c"), item("d")]
    const sync = edges(["a", "b"], ["c", "d"])
    let n = 0
    const jittered: Similar<Item> = (a, b) => {
      const delay = [7, 1, 5, 0, 3, 2][n++ % 6]!
      return new Promise((resolve) => setTimeout(() => resolve(sync(a, b)), delay))
    }
    expect(await clusterItems(items, jittered)).toEqual(await clusterItems(items, sync))
  })

  test("A REJECTING MATCHER IS `false` FOR THAT PAIR, COUNTED, AND NEVER ABORTS", async () => {
    // Model failures are domain outcomes, not exceptions (spine, Errors). The
    // run continues and the failure is visible on the result rather than
    // surfacing as a thrown error two stages away.
    const relation: Similar<Item> = async (a, b) => {
      if (a.id === "a" && b.id === "b") throw new Error("matcher exploded")
      return edges(["c", "d"])(a, b)
    }
    const result = await clusterItems([item("a"), item("b"), item("c"), item("d")], relation)

    expect(result.failures).toBe(1)
    expect(result.clusters).toEqual([
      { id: "cluster-1", memberIds: ["a"] },
      { id: "cluster-2", memberIds: ["b"] },
      { id: "cluster-3", memberIds: ["c", "d"] },
    ])
  })

  test("a synchronously throwing matcher is handled the same way", async () => {
    const relation: Similar<Item> = () => {
      throw new Error("matcher exploded")
    }
    const result = await clusterItems([item("a"), item("b")], relation)
    expect(result.failures).toBe(1)
    expect(result.clusters).toHaveLength(2)
  })

  test("the blocking key keeps candidates that cannot be the same site uncompared", async () => {
    // The comparison budget is honest rather than hidden: `comparisons` is what a
    // model-backed matcher would actually have been billed for.
    const items = [item("a", "x"), item("b", "y"), item("c", "x")]
    const result = await clusterItems(items, () => true, (i) => i.group ?? "")

    expect(result.comparisons).toBe(1)
    expect(result.clusters).toEqual([
      { id: "cluster-1", memberIds: ["a", "c"] },
      { id: "cluster-2", memberIds: ["b"] },
    ])
  })

  test("the default block is permissive — everything is a candidate", async () => {
    const items = [item("a", "x"), item("b", "y"), item("c", "z")]
    const result = await clusterItems(items, () => true)
    expect(result.comparisons).toBe(2) // a~b merges, then a~c; b~c is already joined
    expect(result.clusters).toEqual([{ id: "cluster-1", memberIds: ["a", "b", "c"] }])
  })

  test("AD-14: THE ENGINE IMPORTS NOTHING AT ALL", async () => {
    // The lint proves `core/` never reaches an adapter or the top-level
    // fixtures; AD-14 is stricter than that for this one file — no port, no
    // stage, no run state, no host type, and no `Finding` either. Asserted by
    // reading the import list, because "it happens to have none today" and "it
    // is not allowed to grow one" are different claims and only one is a test.
    const source = await Bun.file(new URL("./engine.ts", import.meta.url)).text()
    const imports = source.match(/^\s*(?:import|export)\s[^\n]*\sfrom\s/gm) ?? []
    expect(imports).toEqual([])
  })

  test("the engine mutates nothing it was given", async () => {
    const items = [item("a"), item("b")]
    const snapshot = JSON.stringify(items)
    await clusterItems(items, () => true)
    expect(JSON.stringify(items)).toBe(snapshot)
  })
})
