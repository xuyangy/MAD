import { describe, expect, test } from "bun:test"

import type { CoDiscovery, Finding, Severity } from "../domain/finding.ts"
import { fakeClock } from "../test-support/fakes.ts"
import { formatThreshold } from "../domain/run-record.ts"
import { clampThreshold, DEFAULT_CO_DISCOVERY_THRESHOLD, route } from "./route.ts"

interface Draft {
  id?: string
  severity?: Severity
  clusterSeverity?: Severity
  coDiscovery?: CoDiscovery
  author?: string
  lens?: string
}

function pool(draft: Draft = {}): Finding {
  return {
    id: draft.id ?? "f-1",
    claim: "fee is computed before the rate is validated",
    reasoning: "",
    locus: { file: "src/pay.ts", startLine: 12, endLine: 14 },
    severity: draft.severity ?? "high",
    clusterSeverity: draft.clusterSeverity,
    author: draft.author ?? "discovery-1",
    source: "pool",
    coDiscovery: draft.coDiscovery ?? { raised: 1, answered: 3 },
    history: [],
  }
}

/** A lens finding never carries a prior — that is the whole point of it (AD-17d). */
function lens(draft: Draft & { lens: string }): Finding {
  return {
    ...pool(draft),
    source: "lens",
    lens: draft.lens,
    author: draft.author ?? `discovery-lens-${draft.lens}`,
    coDiscovery: draft.coDiscovery,
  }
}

const run = (findings: Finding[], threshold?: number) =>
  route({ findings, threshold, clock: fakeClock() })

describe("route — stage 3, the only writer of its two fields (AD-8)", () => {
  test("AT or ABOVE the threshold skips debate and is judged verify-independently", () => {
    const f = pool({ coDiscovery: { raised: 3, answered: 3 } })
    const result = run([f], 0.8)

    expect(f.route).toBe("judge")
    expect(f.routeReason).toContain("3/3")
    expect(f.routeReason).toContain("80%")
    expect(f.routeReason).toContain("verify-independently")
    expect(result.toJudge).toBe(1)
    expect(result.toDebate).toBe(0)
  })

  test("BELOW the threshold is contested and goes to debate", () => {
    const f = pool({ coDiscovery: { raised: 1, answered: 3 } })
    run([f], 0.8)

    expect(f.route).toBe("debate")
    expect(f.routeReason).toContain("1/3")
    expect(f.routeReason).toContain("below threshold 80%")
  })

  test("THE EXACT BOUNDARY: a fraction equal to the threshold skips debate", () => {
    const f = pool({ coDiscovery: { raised: 4, answered: 5 } })
    run([f], 0.8)
    expect(f.route).toBe("judge")
  })

  test("the boundary case that separates DIVISION from CROSS-MULTIPLICATION", () => {
    // The two forms are equal in arithmetic and unequal in doubles, and they
    // disagree exactly AT the boundary — the one place CAP-3's criterion lives.
    // This pins the pair of values that catches the wrong rewrite; every other
    // test in this file passes under either form.
    expect(7 / 25 >= 0.28).toBe(true)
    expect(7 >= 0.28 * 25).toBe(false)

    const f = pool({ coDiscovery: { raised: 7, answered: 25 } })
    run([f], 0.28)
    expect(f.route).toBe("judge")
  })

  test("CRITICAL overrides the threshold at full co-discovery (CAP-3)", () => {
    const f = pool({ severity: "critical", coDiscovery: { raised: 3, answered: 3 } })
    run([f], 0.8)

    expect(f.route).toBe("debate")
    expect(f.routeReason).toContain("critical severity overrides the threshold")
    // The reason names the OVERRIDE, not the fraction — nothing was compared.
    expect(f.routeReason).not.toContain("3/3")
  })

  test("critical still overrides at a threshold of 0, where everything else skips", () => {
    const critical = pool({ id: "a", severity: "critical" })
    const low = pool({ id: "b", severity: "low" })
    const result = run([critical, low], 0)

    expect(critical.route).toBe("debate")
    expect(low.route).toBe("judge")
    expect(result.toDebate).toBe(1)
  })

  test("CRITICAL FROM A MERGE — read through effectiveSeverity, never the raw field (AD-10)", () => {
    // A canonical `high` that absorbed a member's `critical`. Story 3 writes the
    // cluster's severity to `clusterSeverity` precisely so `severity` stays
    // unwritten; routing that read the raw field would debate the wrong thing.
    const f = pool({ severity: "high", clusterSeverity: "critical", coDiscovery: { raised: 3, answered: 3 } })
    run([f], 0.8)

    expect(f.route).toBe("debate")
    expect(f.routeReason).toContain("critical severity overrides")
    expect(f.severity).toBe("high")
  })

  test("A LENS FINDING is judged verify-independently and its reason NEVER names the threshold", () => {
    // AD-17d — it was PROMPTED for its dimension, so there was never an
    // unprompted signal to have. Nothing was placed against the threshold, so
    // saying "below threshold" would be a false claim about what was measured.
    const f = lens({ lens: "security" })
    run([f], 0.8)

    expect(f.route).toBe("judge")
    expect(f.routeReason).toContain("no co-discovery prior")
    expect(f.routeReason).toContain("lens-sourced")
    expect(f.routeReason).toContain("security")
    expect(f.routeReason).not.toContain("threshold")
    expect(f.routeReason).not.toContain("below")
  })

  test("a CRITICAL lens finding is debated — severity outranks the lens rule", () => {
    const f = lens({ lens: "security", severity: "critical" })
    run([f], 0.8)

    expect(f.route).toBe("debate")
    expect(f.routeReason).toContain("critical severity overrides")
  })

  test("a threshold of 1.0 debates everything short of unanimity", () => {
    const unanimous = pool({ id: "a", coDiscovery: { raised: 3, answered: 3 } })
    const partial = pool({ id: "b", coDiscovery: { raised: 2, answered: 3 } })
    run([unanimous, partial], 1)

    expect(unanimous.route).toBe("judge")
    expect(partial.route).toBe("debate")
  })

  test("A POOL FINDING WITH NO PRIOR is contested, and says the prior is MISSING", () => {
    // Not "below threshold". Clustering did not run, which means something failed
    // or was skipped — the opposite fact from a lens finding's absence, and the
    // opposite answer: more scrutiny, not less. Coercing it to a below-threshold
    // route is the zero-coercion AD-9 forbids, changing a DECISION this time.
    const f = pool()
    f.coDiscovery = undefined
    run([f], 0.8)

    expect(f.route).toBe("debate")
    expect(f.routeReason).toContain("no co-discovery prior recorded")
    expect(f.routeReason).toContain("clustering did not run")
    expect(f.routeReason).not.toContain("below threshold")
  })

  test("a ZERO DENOMINATOR is not a fraction — no division by zero, and it says so", () => {
    const f = pool({ coDiscovery: { raised: 1, answered: 0 } })
    run([f], 0.8)

    expect(f.route).toBe("debate")
    expect(f.routeReason).toContain("no model answered")
    expect(f.routeReason).not.toContain("Infinity")
    expect(f.routeReason).not.toContain("NaN")
  })

  test("an empty finding set routes nothing and does not throw", () => {
    const result = run([])
    expect(result.findings).toEqual([])
    expect(result.toDebate).toBe(0)
    expect(result.toJudge).toBe(0)
    expect(result.threshold).toBe(DEFAULT_CO_DISCOVERY_THRESHOLD)
  })

  test("two runs over one input produce identical routes AND identical reason strings", () => {
    const build = () => [
      pool({ id: "a", coDiscovery: { raised: 3, answered: 3 } }),
      pool({ id: "b", coDiscovery: { raised: 1, answered: 3 } }),
      pool({ id: "c", severity: "critical" }),
      lens({ id: "d", lens: "performance" }),
    ]
    const first = build()
    const second = build()
    run(first, 0.8)
    run(second, 0.8)

    expect(first.map((f) => [f.route, f.routeReason])).toEqual(
      second.map((f) => [f.route, f.routeReason]),
    )
  })
})

describe("route — what it must NOT touch (AD-8, AD-10, AD-7)", () => {
  test("severity, coDiscovery, clusterSeverity and clusterId are byte-identical afterwards", () => {
    const findings = [
      pool({ id: "a", severity: "high", clusterSeverity: "critical", coDiscovery: { raised: 2, answered: 3 } }),
      lens({ id: "b", lens: "tests", severity: "low" }),
    ]
    for (const f of findings) f.clusterId = `cluster-${f.id}`
    const before = findings.map((f) => ({
      severity: f.severity,
      clusterSeverity: f.clusterSeverity,
      coDiscovery: f.coDiscovery,
      clusterId: f.clusterId,
    }))

    run(findings, 0.8)

    expect(
      findings.map((f) => ({
        severity: f.severity,
        clusterSeverity: f.clusterSeverity,
        coDiscovery: f.coDiscovery,
        clusterId: f.clusterId,
      })),
    ).toEqual(before)
  })

  test("AD-7 — exactly one appended entry per finding, and nothing pre-existing is rewritten", () => {
    const f = pool()
    const discovery = { stage: "discover" as const, actor: "discovery-1", at: "t0", kind: "raised", body: "x" }
    f.history = [discovery]

    run([f], 0.8)

    expect(f.history).toHaveLength(2)
    expect(f.history[0]).toEqual(discovery)
    expect(f.history[1]!.stage).toBe("route")
    expect(f.history[1]!.actor).toBe("mad")
    expect(f.history[1]!.kind).toBe("routed")
    expect(f.history[1]!.body).toBe(f.routeReason!)
  })

  test("routing PARTITIONS — every finding leaves with a route and none is dropped", () => {
    const findings = [pool({ id: "a" }), lens({ id: "b", lens: "privacy-and-accessibility" }), pool({ id: "c" })]
    const result = run(findings, 0.8)

    expect(result.findings).toHaveLength(3)
    expect(result.findings).toBe(findings)
    for (const f of findings) expect(f.route).toBeDefined()
    expect(result.toDebate + result.toJudge).toBe(3)
  })

  test("THE JUDGE BUCKET IS COUNTED BY WHY, NOT ONLY BY WHERE", () => {
    // The two reasons a finding reaches the judge are separate claims: one says a
    // fraction cleared the dial, the other says there was never a fraction
    // (AD-17d). A single `toJudge` total is the input to a summary line that then
    // has to caption it, and the only honest caption over a mixed total is no
    // caption at all. So the split is counted here, by the stage that knows.
    const cleared = pool({ id: "a", coDiscovery: { raised: 3, answered: 3 } })
    const lensed = lens({ id: "b", lens: "security" })
    const contested = pool({ id: "c", coDiscovery: { raised: 1, answered: 3 } })
    const result = run([cleared, lensed, contested], 0.8)

    expect(result.toDebate).toBe(1)
    expect(result.toJudgeAtThreshold).toBe(1)
    expect(result.toJudgeNoPrior).toBe(1)
    // The invariant the renderer relies on.
    expect(result.toJudge).toBe(result.toJudgeAtThreshold + result.toJudgeNoPrior)
    expect(result.toDebate + result.toJudge).toBe(3)
  })

  test("a CRITICAL lens finding counts as debate, not as a no-prior judge", () => {
    // Rule 1 fires before rule 2, so the buckets must follow the routes rather
    // than the source. A lens finding that was debated was never "sent to the
    // judge without a prior" and must not be counted as one.
    const result = run([lens({ lens: "security", severity: "critical" })], 0.8)

    expect(result.toDebate).toBe(1)
    expect(result.toJudgeNoPrior).toBe(0)
    expect(result.toJudge).toBe(0)
  })

  test("no ratio or percentage is ever stored on the finding (AD-9)", () => {
    const f = pool({ coDiscovery: { raised: 2, answered: 3 } })
    run([f], 0.8)

    // The pair survives untouched; nothing pre-divided joins it.
    expect(f.coDiscovery).toEqual({ raised: 2, answered: 3 })
    expect(Object.keys(f)).not.toContain("coDiscoveryRatio")
    expect(f.routeReason).not.toContain("0.666")
    expect(f.routeReason).not.toContain("67%")
  })
})

describe("clampThreshold — a fraction, so [0, 1]", () => {
  test("absent and NaN fall back to the default", () => {
    expect(clampThreshold(undefined)).toBe(DEFAULT_CO_DISCOVERY_THRESHOLD)
    expect(clampThreshold(Number.NaN)).toBe(DEFAULT_CO_DISCOVERY_THRESHOLD)
  })

  test("ANYTHING THAT IS NOT A NUMBER IS ABSENT — `null` must not become 0", () => {
    // `review()` is an exported seam and TypeScript does not police a JavaScript
    // caller. `Math.max(null, 0)` is `0`, so a `=== undefined` test would turn
    // "I passed nothing meaningful" into the least conservative dial there is.
    const notNumbers = [null, "0.5", {}, []] as unknown as (number | undefined)[]
    for (const value of notNumbers) {
      expect(clampThreshold(value)).toBe(DEFAULT_CO_DISCOVERY_THRESHOLD)
    }
  })

  test("out of range is CLAMPED, not defaulted — 4 means 'debate everything', so it lands on 1", () => {
    expect(clampThreshold(4)).toBe(1)
    expect(clampThreshold(-1)).toBe(0)
    expect(clampThreshold(Number.POSITIVE_INFINITY)).toBe(1)
    expect(clampThreshold(Number.NEGATIVE_INFINITY)).toBe(0)
  })

  test("in-range values pass through, including both ends", () => {
    expect(clampThreshold(0)).toBe(0)
    expect(clampThreshold(0.5)).toBe(0.5)
    expect(clampThreshold(1)).toBe(1)
  })

  test("the run routes against the CLAMPED value, and reports it", () => {
    const f = pool({ coDiscovery: { raised: 3, answered: 3 } })
    const result = run([f], 9)
    expect(result.threshold).toBe(1)
    expect(f.routeReason).toContain("100%")
  })
})

describe("the threshold reads as the dial it is (CAP-3)", () => {
  test("a percentage, in cost-model.md's own vocabulary, with no rounding into a different dial", () => {
    expect(formatThreshold(0.8)).toBe("80%")
    expect(formatThreshold(0.5)).toBe("50%")
    expect(formatThreshold(1)).toBe("100%")
    expect(formatThreshold(0)).toBe("0%")
    // An awkward dial keeps its precision instead of rounding to `67%`, which is
    // a DIFFERENT threshold and would route 2/3 the other way.
    expect(formatThreshold(0.667)).toBe("66.7%")
    expect(formatThreshold(0.28)).toBe("28%")
  })

  test("routing and rendering read the SAME formatter, so they cannot disagree", () => {
    // Two call sites printing one number is how a run comes to say `0.80` in its
    // summary and `80%` in a reason. One function, imported by both.
    const f = pool({ coDiscovery: { raised: 1, answered: 3 } })
    run([f], 0.667)
    expect(f.routeReason).toContain(formatThreshold(0.667))
  })
})

describe("source is the discriminator, not the presence of a pair (AD-17d, AD-9 amended)", () => {
  test("A LENS FINDING CARRYING A STRAY PRIOR IS STILL ROUTED AS LENS-SOURCED", () => {
    // Clustering cannot produce this — `raised` counts pool authors only — but
    // `source` is the rule, not "whatever coDiscovery happens to hold". A routing
    // stage that tested the pair instead would send a lens finding down the
    // threshold path the moment any upstream stage set one, which is exactly the
    // conflation AD-9's amendment exists to forbid.
    const f = lens({ lens: "security", coDiscovery: { raised: 3, answered: 3 } })
    run([f], 0.8)

    expect(f.route).toBe("judge")
    expect(f.routeReason).toContain("no co-discovery prior")
    expect(f.routeReason).not.toContain("3/3")
  })
})
