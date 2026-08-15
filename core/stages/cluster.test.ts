import { describe, expect, test } from "bun:test"

import type { Similar } from "../clustering/engine.ts"
import { effectiveSeverity, type Finding, type Severity } from "../domain/finding.ts"
import { fakeClock } from "../test-support/fakes.ts"
import { cluster } from "./cluster.ts"

interface Draft {
  id: string
  claim?: string
  severity?: Severity
  author?: string
  lens?: string
  file?: string
  startLine?: number
}

function pool(draft: Draft): Finding {
  return {
    id: draft.id,
    claim: draft.claim ?? `${draft.id} claim`,
    reasoning: "",
    locus: { file: draft.file ?? "src/pay.ts", startLine: draft.startLine ?? 12, endLine: draft.startLine ?? 12 },
    severity: draft.severity ?? "high",
    author: draft.author ?? "discovery-1",
    source: "pool",
    history: [],
  }
}

function lens(draft: Draft & { lens: string }): Finding {
  return { ...pool(draft), source: "lens", lens: draft.lens, author: draft.author ?? `discovery-lens-${draft.lens}` }
}

/** An explicit edge list, so every test states the merges it is reasoning about. */
function edges(...pairs: [string, string][]): Similar<Finding> {
  const set = new Set(pairs.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]))
  return (a, b) => set.has(`${a.id}|${b.id}`)
}

const ALL: Similar<Finding> = () => true
const NONE: Similar<Finding> = () => false

const run = (findings: Finding[], answered: number, similar: Similar<Finding>) =>
  cluster({ findings, answered, similar, clock: fakeClock() })

describe("cluster — stage 2, the only writer of its four fields (AD-8)", () => {
  test("EVERY finding gets a clusterId, INCLUDING singletons nothing merged with", async () => {
    // `output.ts:156` reads exactly this as "clustering has run". An id written
    // only on multi-member clusters makes a run in which nothing merged
    // indistinguishable from a run that never clustered (AD-14 amended 2).
    const findings = [pool({ id: "a" }), pool({ id: "b", author: "discovery-2" })]
    const result = await run(findings, 2, NONE)

    expect(result.findings).toHaveLength(2)
    for (const finding of findings) expect(finding.clusterId).toBeDefined()
    expect(new Set(findings.map((f) => f.clusterId)).size).toBe(2)
  })

  test("an ABSORBED member carries the cluster's id too, not just the canonical", async () => {
    const a = pool({ id: "a", author: "discovery-1" })
    const b = pool({ id: "b", author: "discovery-2" })
    const result = await run([a, b], 2, ALL)

    expect(result.findings).toHaveLength(1)
    expect(a.clusterId).toBeDefined()
    expect(b.clusterId).toBe(a.clusterId!)
  })

  test("`raised` counts DISTINCT POOL AUTHORS, never the member count", async () => {
    // Three models describing one defect: the case the whole design divides by.
    const findings = [
      pool({ id: "a", author: "discovery-1" }),
      pool({ id: "b", author: "discovery-2" }),
      pool({ id: "c", author: "discovery-3" }),
    ]
    const result = await run(findings, 3, ALL)

    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]!.coDiscovery).toEqual({ raised: 3, answered: 3 })
  })

  test("TWO FINDINGS FROM ONE MODEL GIVE `raised: 1` — one model, not two", async () => {
    // A verbose model raising the same defect twice would otherwise manufacture
    // agreement out of one model's verbosity, and every story 4 threshold
    // divides by this number.
    const findings = [
      pool({ id: "a", author: "discovery-2" }),
      pool({ id: "b", author: "discovery-2" }),
    ]
    const result = await run(findings, 3, ALL)
    expect(result.findings[0]!.coDiscovery).toEqual({ raised: 1, answered: 3 })
  })

  test("A LENS MEMBER NEVER INCREMENTS `raised` (CAP-11)", async () => {
    const findings = [
      pool({ id: "a", author: "discovery-1" }),
      lens({ id: "b", lens: "security" }),
    ]
    const result = await run(findings, 3, ALL)

    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]!.coDiscovery).toEqual({ raised: 1, answered: 3 })
  })

  test("A CLUSTER OF LENS FINDINGS ALONE CARRIES NO `coDiscovery` AT ALL", async () => {
    // Not `{raised: 0}`, not `{raised: 1}` — absent. `source` stays the
    // discriminator (AD-9 amended); a zero would render as a fraction and claim
    // a prior a prompted persona was never entitled to.
    const findings = [
      lens({ id: "a", lens: "security" }),
      lens({ id: "b", lens: "performance" }),
    ]
    const result = await run(findings, 3, ALL)

    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]!.coDiscovery).toBeUndefined()
    expect(result.findings[0]!.clusterId).toBeDefined()
  })

  test("a lens singleton carries no prior either", async () => {
    const findings = [lens({ id: "a", lens: "security" })]
    const result = await run(findings, 3, NONE)
    expect(result.findings[0]!.coDiscovery).toBeUndefined()
    expect(result.findings[0]!.clusterId).toBeDefined()
  })

  test("THE CANONICAL OF A MIXED CLUSTER IS THE POOL MEMBER", async () => {
    // A lens canonical would render *not applicable — lens-sourced* over a
    // cluster that genuinely carries a prior.
    const poolFinding = pool({ id: "p", author: "discovery-1", severity: "low" })
    const lensFinding = lens({ id: "l", lens: "security", severity: "critical" })
    const result = await run([lensFinding, poolFinding], 3, ALL)

    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]!.id).toBe("p")
    expect(result.findings[0]!.source).toBe("pool")
  })

  test("among pool members the canonical is the most severe, then the earliest", async () => {
    const findings = [
      pool({ id: "a", severity: "medium", author: "discovery-1" }),
      pool({ id: "b", severity: "critical", author: "discovery-2" }),
      pool({ id: "c", severity: "critical", author: "discovery-3" }),
    ]
    const result = await run(findings, 3, ALL)
    expect(result.findings[0]!.id).toBe("b")
  })

  test("clusterSeverity takes the highest across ALL members; no member's severity is written", async () => {
    // AD-10 — a merge never lowers a severity a model actually claimed, and no
    // stage after discovery rewrites `severity` (AD-10, AD-8). Both hold at once
    // only because the cluster's severity is its own field.
    const a = pool({ id: "a", severity: "medium", author: "discovery-1" })
    const b = pool({ id: "b", severity: "critical", author: "discovery-2" })
    const c = lens({ id: "c", lens: "security", severity: "high" })
    const result = await run([a, b, c], 3, ALL)

    // `b` is canonical (highest pool severity), so the cluster severity equals
    // its own and the field is not written redundantly.
    expect(result.findings[0]!.id).toBe("b")
    expect(effectiveSeverity(result.findings[0]!)).toBe("critical")
    expect(a.severity).toBe("medium")
    expect(b.severity).toBe("critical")
    expect(c.severity).toBe("high")
  })

  test("A LENS MEMBER'S CRITICAL RAISES THE CLUSTER, WITHOUT MAKING IT CANONICAL", async () => {
    // The exact collision the story resolved: the lens member cannot be
    // canonical, so its severity would be lost if the cluster had no field of
    // its own.
    const poolFinding = pool({ id: "p", severity: "low", author: "discovery-1" })
    const lensFinding = lens({ id: "l", lens: "security", severity: "critical" })
    const result = await run([poolFinding, lensFinding], 3, ALL)

    const canonical = result.findings[0]!
    expect(canonical.id).toBe("p")
    expect(canonical.severity).toBe("low") // never rewritten
    expect(canonical.clusterSeverity).toBe("critical")
    expect(effectiveSeverity(canonical)).toBe("critical")
  })

  test("a singleton gets no clusterSeverity and no mergedIds", async () => {
    const findings = [pool({ id: "a" })]
    const result = await run(findings, 1, NONE)
    expect(result.findings[0]!.clusterSeverity).toBeUndefined()
    expect(result.findings[0]!.mergedIds).toBeUndefined()
  })

  test("mergedIds names the absorbed members, in input order, and resolves against the input", async () => {
    // The spine's Ids convention: a merged finding keeps a canonical id and
    // records the ids merged into it, so nothing a transcript references becomes
    // unresolvable.
    const findings = [
      pool({ id: "a", author: "discovery-1", severity: "critical" }),
      pool({ id: "b", author: "discovery-2" }),
      pool({ id: "c", author: "discovery-3" }),
    ]
    const result = await run(findings, 3, ALL)
    const canonical = result.findings[0]!

    expect(canonical.id).toBe("a")
    expect(canonical.mergedIds).toEqual(["b", "c"])
    for (const id of canonical.mergedIds!) {
      expect(findings.some((f) => f.id === id)).toBe(true)
    }
  })

  test("AD-7 — one history entry per absorbed member, and nothing is rewritten", async () => {
    const a = pool({ id: "a", author: "discovery-1", severity: "critical", claim: "the fee bug" })
    const b = pool({ id: "b", author: "discovery-2", claim: "same fee bug, other words" })
    a.history.push({ stage: "discover", actor: "discovery-1", at: "t0", kind: "raised", body: "the fee bug" })
    const before = { ...a.history[0]! }

    await run([a, b], 2, ALL)

    // The discovery entry is untouched...
    expect(a.history[0]).toEqual(before)
    // ...and exactly one merge entry was appended, naming the absorbed author.
    const merges = a.history.filter((entry) => entry.stage === "cluster")
    expect(merges).toHaveLength(1)
    expect(merges[0]!.actor).toBe("discovery-2")
    expect(merges[0]!.kind).toBe("merged")
    expect(merges[0]!.body).toBe("same fee bug, other words")

    // The absorbed member records which canonical took it, so it is not orphaned.
    const absorbed = b.history.filter((entry) => entry.stage === "cluster")
    expect(absorbed).toHaveLength(1)
    expect(absorbed[0]!.body).toContain("a")
  })

  test("no finding object is discarded — an absorbed member stays live and complete", async () => {
    const a = pool({ id: "a", author: "discovery-1" })
    const b = lens({ id: "b", lens: "security", claim: "the lens saw it too" })
    await run([a, b], 3, ALL)

    expect(b.claim).toBe("the lens saw it too")
    expect(b.lens).toBe("security")
    expect(b.source).toBe("lens")
    expect(b.coDiscovery).toBeUndefined()
  })

  test("the canonical set comes back in the input's relative order", async () => {
    const findings = [
      pool({ id: "a", author: "discovery-1", file: "a.ts" }),
      pool({ id: "b", author: "discovery-2", file: "b.ts" }),
      pool({ id: "c", author: "discovery-3", file: "a.ts" }),
    ]
    const result = await run(findings, 3, edges(["a", "c"]))
    expect(result.findings.map((f) => f.id)).toEqual(["a", "b"])
  })

  test("a late canonical does not jump a singleton that came before it", async () => {
    // The engine orders CLUSTERS by their earliest member, which is a different
    // thing from the order of the members it chose as canonical.
    const findings = [
      pool({ id: "a", severity: "low", author: "discovery-1", file: "a.ts" }),
      pool({ id: "b", author: "discovery-2", file: "b.ts" }),
      pool({ id: "c", severity: "critical", author: "discovery-3", file: "a.ts" }),
    ]
    const result = await run(findings, 3, edges(["a", "c"]))
    expect(result.findings.map((f) => f.id)).toEqual(["b", "c"])
  })

  test("an empty finding set produces zero clusters and no crash", async () => {
    const result = await cluster({ findings: [], answered: 0, clock: fakeClock() })
    expect(result.findings).toEqual([])
    expect(result.clusters).toEqual([])
  })

  test("a single finding is one singleton cluster reading 1/answered", async () => {
    const findings = [pool({ id: "a" })]
    const result = await run(findings, 1, NONE)
    expect(result.clusters).toHaveLength(1)
    expect(result.findings[0]!.coDiscovery).toEqual({ raised: 1, answered: 1 })
  })

  test("two runs over one input agree on ids, canonicals and order", async () => {
    const build = () => [
      pool({ id: "a", author: "discovery-1" }),
      pool({ id: "b", author: "discovery-2" }),
      pool({ id: "c", author: "discovery-3", file: "other.ts" }),
    ]
    const first = await run(build(), 3, ALL)
    const second = await run(build(), 3, ALL)
    expect(second.clusters).toEqual(first.clusters)
    expect(second.findings.map((f) => f.id)).toEqual(first.findings.map((f) => f.id))
    expect(second.findings.map((f) => f.clusterId)).toEqual(first.findings.map((f) => f.clusterId))
  })

  test("the shipped matcher is the default — the stage is callable without one", async () => {
    const findings = [
      pool({ id: "a", author: "discovery-1", claim: "The fee is computed before the rate is validated." }),
      pool({ id: "b", author: "discovery-2", claim: "Fee computed before validating the rate value." }),
    ]
    const result = await cluster({ findings, answered: 3, clock: fakeClock() })
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]!.coDiscovery).toEqual({ raised: 2, answered: 3 })
  })

  test("clustering writes its four fields and NOTHING else (AD-8)", async () => {
    const a = pool({ id: "a", author: "discovery-1" })
    const b = pool({ id: "b", author: "discovery-2", severity: "critical" })
    await run([a, b], 2, ALL)

    for (const finding of [a, b]) {
      expect(finding.route).toBeUndefined()
      expect(finding.routeReason).toBeUndefined()
      expect(finding.verdict).toBeUndefined()
      expect(finding.evidence).toBeUndefined()
      expect(finding.rank).toBeUndefined()
      expect(finding.unresolved).toBeUndefined()
    }
  })

  test("a failing matcher does not abort the stage — the pair is simply not merged", async () => {
    const findings = [
      pool({ id: "a", author: "discovery-1" }),
      pool({ id: "b", author: "discovery-2" }),
    ]
    const result = await run(findings, 2, () => {
      throw new Error("matcher exploded")
    })
    expect(result.findings).toHaveLength(2)
    expect(findings.every((f) => f.clusterId !== undefined)).toBe(true)
  })
})

describe("effectiveSeverity — the single read path (AD-10)", () => {
  test("it prefers the cluster's severity and falls back to the finding's own", () => {
    const finding = pool({ id: "a", severity: "low" })
    expect(effectiveSeverity(finding)).toBe("low")
    finding.clusterSeverity = "critical"
    expect(effectiveSeverity(finding)).toBe("critical")
  })
})
