import { describe, expect, test } from "bun:test"

import type { Finding, Severity } from "../domain/finding.ts"
import {
  emptyLedger,
  type DebateCounts,
  type RouteCounts,
  type RunRecord,
} from "../domain/run-record.ts"
import { selectRoster } from "../roster/select.ts"
import { candidate } from "../test-support/fakes.ts"
import { output, rankFindings } from "./output.ts"
import { DEFAULT_MAX_ROUNDS } from "./debate.ts"
import { DEFAULT_CO_DISCOVERY_THRESHOLD } from "./route.ts"

function finding(partial: Partial<Finding> & { severity: Severity; file: string }): Finding {
  return {
    id: partial.id ?? `finding-${partial.file}-${partial.severity}`,
    claim: partial.claim ?? "something is wrong",
    reasoning: partial.reasoning ?? "because of this",
    locus: partial.locus ?? { file: partial.file, startLine: 1, endLine: 1 },
    severity: partial.severity,
    author: partial.author ?? "discovery-1",
    source: partial.source ?? "pool",
    lens: partial.lens,
    clusterId: partial.clusterId,
    coDiscovery: partial.coDiscovery,
    route: partial.route,
    routeReason: partial.routeReason,
    unresolved: partial.unresolved,
    history: [],
  }
}

/** A lens-sourced finding — `source` and `lens` together, never one alone. */
function lensFinding(
  partial: Partial<Finding> & { severity: Severity; file: string; lens: string },
): Finding {
  return finding({
    ...partial,
    author: partial.author ?? `discovery-lens-${partial.lens}`,
    source: "lens",
  })
}

function record(
  findings: Finding[],
  answered = 1,
  lenses: readonly string[] = [],
  threshold = DEFAULT_CO_DISCOVERY_THRESHOLD,
  // Absent by default, because absent MEANS "routing has not run" — the property
  // that keeps `output()` callable mid-pipeline. A test that wants the summary
  // supplies the stage's counts, exactly as `review()` does.
  routeCounts?: RouteCounts,
  // Absent by default for exactly `routeCounts`' reason: absent MEANS "debate has
  // not run", which is the property that keeps `output()` callable mid-pipeline
  // and is a different fact from "debate ran and contested nothing".
  debateCounts?: DebateCounts,
  maxRounds = DEFAULT_MAX_ROUNDS,
): RunRecord {
  const { roster, warnings } = selectRoster([candidate("openai", "gpt-5")], {
    slots: 1,
    lenses,
    providerConfigKey: "provider",
  })
  return {
    runId: "run-1",
    startedAt: "2026-08-13T00:00:00.000Z",
    roster,
    answered,
    findings,
    // These records are built by hand and never clustered, so the pool IS the
    // finding set — which is exactly the pre-cluster state this block asserts on.
    pool: findings,
    lensInstructions: roster.lensSlots.map((slot) => ({ lens: slot.lens, origin: "shipped" as const })),
    threshold,
    routeCounts,
    maxRounds,
    debateCounts,
    warnings,
    ledger: emptyLedger(),
  }
}

describe("ranking (AD-9: order, never fuse)", () => {
  test("severity leads, carried unchanged from discovery (AD-10)", () => {
    const ranked = rankFindings([
      finding({ severity: "low", file: "a.ts" }),
      finding({ severity: "critical", file: "b.ts" }),
      finding({ severity: "medium", file: "c.ts" }),
    ])
    expect(ranked.map((f) => f.severity)).toEqual(["critical", "medium", "low"])
    expect(ranked.map((f) => f.rank)).toEqual([1, 2, 3])
  })

  test("co-discovery breaks severity ties without being fused into a score", () => {
    const ranked = rankFindings([
      finding({ severity: "high", file: "a.ts", coDiscovery: { raised: 1, answered: 3 } }),
      finding({ severity: "high", file: "b.ts", coDiscovery: { raised: 3, answered: 3 } }),
    ])
    expect(ranked[0]!.locus.file).toBe("b.ts")
    // Nothing was stored beyond the pair and the rank.
    expect(ranked[0]!.coDiscovery).toEqual({ raised: 3, answered: 3 })
    expect(Object.keys(ranked[0]!)).not.toContain("confidence")
    expect(Object.keys(ranked[0]!)).not.toContain("score")
  })

  test("a ratio, not a raw count: 1/1 outranks 2/9", () => {
    // Raw `raised` would put 2/9 first. Latent in story 1 (everything is 1/1),
    // wrong from story 2 on, and it inverts the signal co-discovery exists for.
    const ranked = rankFindings([
      finding({ severity: "high", file: "wide.ts", coDiscovery: { raised: 2, answered: 9 } }),
      finding({ severity: "high", file: "unanimous.ts", coDiscovery: { raised: 1, answered: 1 } }),
    ])
    expect(ranked.map((f) => f.locus.file)).toEqual(["unanimous.ts", "wide.ts"])
  })

  test("a zero denominator is not evidence and never sorts first", () => {
    const ranked = rankFindings([
      finding({ severity: "high", file: "nobody.ts", coDiscovery: { raised: 1, answered: 0 } }),
      finding({ severity: "high", file: "someone.ts", coDiscovery: { raised: 1, answered: 3 } }),
    ])
    expect(ranked[0]!.locus.file).toBe("someone.ts")
  })

  test("ranking is stable for identical inputs", () => {
    const build = () => [
      finding({ severity: "high", file: "b.ts" }),
      finding({ severity: "high", file: "a.ts" }),
    ]
    expect(rankFindings(build()).map((f) => f.locus.file)).toEqual(
      rankFindings(build()).map((f) => f.locus.file),
    )
  })
})

describe("rendering (AD-6, AD-9)", () => {
  test("co-discovery renders as a fraction with its denominator, never a float", () => {
    const rendered = output(
      record([finding({ severity: "high", file: "a.ts", coDiscovery: { raised: 1, answered: 1 } })]),
    )
    expect(rendered).toContain("co-discovery: 1/1")
    expect(rendered).not.toContain("0.33")
    expect(rendered).not.toMatch(/confidence:\s*\d/i)
  })

  test("verdict and evidence are their own columns and are honestly empty in story 1", () => {
    const rendered = output(
      record([finding({ severity: "high", file: "a.ts", coDiscovery: { raised: 1, answered: 1 } })]),
    )
    expect(rendered).toContain("verdict: not adjudicated")
    expect(rendered).toContain("evidence: assertion only")
  })

  test("severity and locus are shown", () => {
    const rendered = output(
      record([
        finding({
          severity: "critical",
          file: "src/pay.ts",
          locus: { file: "src/pay.ts", startLine: 12, endLine: 14 },
        }),
      ]),
    )
    expect(rendered).toContain("[critical]")
    expect(rendered).toContain("src/pay.ts:12-14")
  })

  test("a clean run says so; a degraded run is unmistakably different (AD-6)", () => {
    const clean = output(record([finding({ severity: "low", file: "a.ts" })]))
    expect(clean).toContain("WARNINGS: none — this run is clean.")

    const degraded = record([finding({ severity: "low", file: "a.ts" })], 0)
    degraded.warnings.push({
      code: "model-dropped-out",
      stage: "discover",
      message: "MODEL DROPPED OUT: `openai/gpt-5` failed twice",
      detail: {},
    })
    const renderedDegraded = output(degraded)
    expect(renderedDegraded).toContain("this run is degraded")
    expect(renderedDegraded).toContain("openai/gpt-5")
    expect(renderedDegraded).not.toContain("this run is clean")
  })

  test("the roster, its lineages and the deduped duplicates are visible", () => {
    const rec = record([])
    rec.roster.slots[0]!.alsoAvailableVia = ["bedrock"]
    const rendered = output(rec)
    expect(rendered).toContain("openai/gpt-5")
    expect(rendered).toContain("GPT (OpenAI)")
    expect(rendered).toContain("also reachable via bedrock")
    expect(rendered).toContain("answered: 1")
  })

  test("AD-6d: the unresolved section is always present and never drops a finding", () => {
    const rec = record([
      finding({
        severity: "high",
        file: "a.ts",
        unresolved: { diedAtStage: "debate", reason: "budget exhausted" },
      }),
    ])
    const rendered = output(rec)
    expect(rendered).toContain("UNRESOLVED — YOU DECIDE (1)")
    expect(rendered).toContain("died at stage debate")
    expect(rendered).toContain("budget exhausted")
    // and it is not double-counted among the resolved findings
    expect(rendered).toContain("FINDINGS (0)")
  })

  test("AD-17e reaches the UNRESOLVED section too — a lens finding is disclosed there", () => {
    // The section is output, and clause (e) has no exception for a finding the
    // budget ran out on. A reader deciding an undecided finding by hand needs to
    // know it carries no prior BECAUSE it was prompted, not because judging
    // never reached it (code review 2026-08-15; latent until story 8).
    const rec = record(
      [
        lensFinding({
          severity: "high",
          file: "a.ts",
          lens: "security",
          unresolved: { diedAtStage: "judge", reason: "budget exhausted" },
        }),
      ],
      1,
      ["security"],
    )
    const rendered = output(rec)
    const section = rendered.slice(rendered.indexOf("UNRESOLVED — YOU DECIDE"))

    expect(section).toContain("raised by: discovery-lens-security")
    expect(section).toContain("lens-sourced: `security`")
    // ...and it never shows a prior it was not entitled to (AD-17d, AD-9).
    expect(section).toContain("not applicable — lens-sourced")
    expect(section).not.toContain("1/1")
  })

  test("a POOL finding in the UNRESOLVED section is disclosed without a lens label", () => {
    const rec = record([
      finding({
        severity: "high",
        file: "a.ts",
        coDiscovery: { raised: 1, answered: 1 },
        unresolved: { diedAtStage: "debate", reason: "budget exhausted" },
      }),
    ])
    const section = output(rec).slice(0)
    const unresolvedBlock = section.slice(section.indexOf("UNRESOLVED — YOU DECIDE"))

    expect(unresolvedBlock).toContain("raised by: discovery-1")
    expect(unresolvedBlock).not.toContain("lens-sourced")
    expect(unresolvedBlock).toContain("co-discovery: 1/1")
  })

  test("AD-6: zero findings because nobody answered never reads as a clean review", () => {
    const rec = record([], 0)
    rec.warnings.push({
      code: "model-dropped-out",
      stage: "discover",
      message: "MODEL DROPPED OUT: `openai/gpt-5` failed twice",
      detail: {},
    })
    const rendered = output(rec)

    expect(rendered).toContain("NO MODEL ANSWERED")
    expect(rendered).toContain("this is not a clean review")
    expect(rendered).not.toContain("No findings were raised")
  })

  test("zero findings after models DID answer says who answered", () => {
    const rendered = output(record([], 2))
    expect(rendered).toContain("No findings were raised by the 2 model(s) that answered")
    expect(rendered).not.toContain("NO MODEL ANSWERED")
  })

  test("a zero denominator never renders as a fraction", () => {
    const rendered = output(
      record([finding({ severity: "high", file: "a.ts", coDiscovery: { raised: 1, answered: 0 } })], 0),
    )
    expect(rendered).not.toContain("1/0")
    expect(rendered).toContain("no model answered")
  })

  test("AD-6: at N>1 before clustering, the pool is declared unmerged", () => {
    const rendered = output(
      record(
        [
          finding({ severity: "high", file: "a.ts", coDiscovery: { raised: 1, answered: 3 } }),
          finding({ severity: "high", file: "b.ts", coDiscovery: { raised: 1, answered: 3 } }),
        ],
        3,
      ),
    )
    expect(rendered).toContain("POOL — NOT YET MERGED")
    expect(rendered).toContain("ONE DEFECT MAY APPEAR ONCE PER MODEL")
    // It names the denominator every fraction below is over (AD-6a).
    expect(rendered).toContain("1/3")
  })

  test("the notice says nothing at N=1, where a union of one IS a merged set", () => {
    const rendered = output(
      record([finding({ severity: "high", file: "a.ts", coDiscovery: { raised: 1, answered: 1 } })], 1),
    )
    expect(rendered).not.toContain("NOT YET MERGED")
  })

  test("the notice self-deletes as soon as a clusterId exists (story 3)", () => {
    // `clusterId` is clustering's field (AD-8), so its presence is the
    // discriminator — nobody has to remember to delete this notice.
    const rendered = output(
      record(
        [
          finding({
            severity: "high",
            file: "a.ts",
            clusterId: "cluster-1",
            coDiscovery: { raised: 2, answered: 3 },
          }),
          finding({ severity: "low", file: "b.ts", coDiscovery: { raised: 1, answered: 3 } }),
        ],
        3,
      ),
    )
    expect(rendered).not.toContain("NOT YET MERGED")
  })

  test("the notice does not claim a fraction the rows below do not show", () => {
    // `output` is exported and callable on a record whose findings carry no
    // coDiscovery — the pair is stamped in `core/run/review.ts`, outside this
    // stage. Those rows render `—`, so an unconditional "every fraction reads
    // 1/N" would be a false sentence in the one place AD-6 exists to keep
    // honest. The notice itself still appears; only the claim it cannot support
    // is withheld.
    const rendered = output(
      record([finding({ severity: "high", file: "a.ts" }), finding({ severity: "low", file: "b.ts" })], 3),
    )
    expect(rendered).toContain("POOL — NOT YET MERGED")
    expect(rendered).toContain("ONE DEFECT MAY APPEAR ONCE PER MODEL")
    expect(rendered).not.toContain("Every co-discovery fraction below reads")
  })

  test("a mixed pool — one finding already credited to two models — makes no blanket claim", () => {
    const rendered = output(
      record(
        [
          finding({ severity: "high", file: "a.ts", coDiscovery: { raised: 2, answered: 3 } }),
          finding({ severity: "low", file: "b.ts", coDiscovery: { raised: 1, answered: 3 } }),
        ],
        3,
      ),
    )
    expect(rendered).toContain("POOL — NOT YET MERGED")
    expect(rendered).not.toContain("Every co-discovery fraction below reads")
  })

  test("the notice does not appear when there is nothing pooled to describe", () => {
    expect(output(record([], 3))).not.toContain("NOT YET MERGED")
  })

  test("AD-3: the provider fan-out is disclosed, not filed as a degradation", () => {
    const rendered = output(record([]))
    expect(rendered).toContain("DISCLOSURE:")
    expect(rendered).toContain("WARNINGS: none")
  })
})

// ---------------------------------------------------------------------------
// CAP-11 — AD-17(e) disclosure and the AD-9 comparator. The rendering half is
// straightforward; the ORDERING half is where the conflation actually bites,
// because a missing prior coerced to a ratio ranks a correct lens finding dead
// last as though every model had disagreed with it.
// ---------------------------------------------------------------------------

describe("lens-sourced findings render as lens-sourced (AD-17e, AD-9 amended)", () => {
  test("matrix: co-discovery renders `not applicable — lens-sourced`, never 0, 1/1 or a bare —", () => {
    const rendered = output(record([lensFinding({ severity: "high", file: "a.ts", lens: "security" })]))

    expect(rendered).toContain("co-discovery: not applicable — lens-sourced")
    expect(rendered).not.toContain("co-discovery: —")
    expect(rendered).not.toContain("co-discovery: 0")
    expect(rendered).not.toContain("co-discovery: 1/1")
  })

  test("it discriminates on `source`, not on `coDiscovery === undefined`", () => {
    // The two absences that must never be conflated. A POOL finding with no
    // pair means "clustering has not run" and renders `—`; a LENS finding means
    // "no prior is claimable" and says so in words. Same undefined field.
    const rendered = output(
      record([
        finding({ severity: "high", file: "pool.ts" }),
        lensFinding({ severity: "high", file: "lens.ts", lens: "security" }),
      ], 3),
    )
    expect(rendered).toContain("co-discovery: —")
    expect(rendered).toContain("not applicable — lens-sourced")
  })

  test("a lens finding stamped with a prior anyway STILL renders as lens-sourced", () => {
    // Belt and braces on AD-17d: if some future stage wrongly stamps a pair on a
    // lens finding, the renderer does not launder it into a fraction. `source`
    // is the discriminator, permanently.
    const rogue = lensFinding({ severity: "high", file: "a.ts", lens: "security" })
    rogue.coDiscovery = { raised: 1, answered: 3 }
    expect(output(record([rogue]))).toContain("not applicable — lens-sourced")
  })

  test("the row names WHICH lens found it (AD-17e)", () => {
    const rendered = output(
      record([lensFinding({ severity: "high", file: "a.ts", lens: "privacy-a11y" })]),
    )
    expect(rendered).toContain("raised by: discovery-lens-privacy-a11y")
    expect(rendered).toContain("lens-sourced: `privacy-a11y`")
  })

  test("a pool row is unchanged — no lens note, no extra column", () => {
    const rendered = output(
      record([finding({ severity: "high", file: "a.ts", coDiscovery: { raised: 1, answered: 1 } })]),
    )
    expect(rendered).toContain("raised by: discovery-1")
    expect(rendered).not.toContain("lens-sourced")
  })

  test("the roster block lists lens slots outside the lineage count (AD-17c)", () => {
    const rendered = output(record([], 1, ["security", "tests"]))

    expect(rendered).toContain("discovery-lens-security")
    expect(rendered).toContain("does NOT count toward distinct lineages")
    expect(rendered).toContain("distinct verified lineages: 1")
    expect(rendered).toContain("lens slots: 2 (security, tests)")
  })

  test("a generated lens instruction is distinguishable from a shipped one (AD-11 amended)", () => {
    const rec = record([], 1, ["threat-model"])
    rec.lensInstructions = [{ lens: "threat-model", origin: "generated" }]
    expect(output(rec)).toContain("GENERATED at run time")

    const shipped = record([], 1, ["security"])
    expect(output(shipped)).not.toContain("GENERATED at run time")
  })

  test("no lens slots, no lens lines at all", () => {
    const rendered = output(record([finding({ severity: "high", file: "a.ts" })]))
    expect(rendered).not.toContain("lens slots:")
    expect(rendered).not.toContain("lens-sourced")
  })
})

describe("the comparator does not coerce a missing prior (AD-9 amended)", () => {
  test("A NO-PRIOR FINDING IS NOT SORTED AS THOUGH ITS RATIO WERE 0", () => {
    // The inversion this pulls forward from story 7. `coDiscoveryRatio` returns
    // 0 for an absent pair, and 0 already means "nobody answered" — a genuinely
    // different fact. Coerced, the lens finding below is forced last as though
    // three models had looked at it and disagreed.
    const ranked = rankFindings([
      finding({ severity: "high", file: "b-pool.ts", coDiscovery: { raised: 1, answered: 9 } }),
      lensFinding({ severity: "high", file: "a-lens.ts", lens: "security" }),
    ])
    // Same severity, one has a very low ratio, the other has no prior at all:
    // co-discovery is skipped and ordering falls through to locus.
    expect(ranked.map((f) => f.locus.file)).toEqual(["a-lens.ts", "b-pool.ts"])
  })

  test("the fall-through is to the NEXT criterion, not to an invented one", () => {
    // Locus today; verdict then evidence then locus from story 6 (story 7 keeps
    // the full treatment). Severity still leads, and a lens finding does not
    // jump a more severe pool finding.
    const ranked = rankFindings([
      lensFinding({ severity: "low", file: "a-lens.ts", lens: "security" }),
      finding({ severity: "critical", file: "z-pool.ts", coDiscovery: { raised: 1, answered: 9 } }),
    ])
    expect(ranked.map((f) => f.locus.file)).toEqual(["z-pool.ts", "a-lens.ts"])
  })

  test("when BOTH carry a prior, co-discovery is still the criterion it always was", () => {
    const ranked = rankFindings([
      finding({ severity: "high", file: "a.ts", coDiscovery: { raised: 1, answered: 3 } }),
      finding({ severity: "high", file: "b.ts", coDiscovery: { raised: 3, answered: 3 } }),
    ])
    expect(ranked[0]!.locus.file).toBe("b.ts")
  })

  test("the predicate is `coDiscovery !== undefined`, NOT `source === 'pool'`", () => {
    // Two POOL findings before clustering runs: neither carries a prior, so the
    // criterion is skipped for both. A `source === 'pool'` predicate would
    // compare their absent priors as ratios and reintroduce the coercion from
    // the other side — which is why the comparator asks a different question
    // from the renderer, and why this test exists to stop a "correction".
    const ranked = rankFindings([
      finding({ severity: "high", file: "b.ts" }),
      finding({ severity: "high", file: "a.ts" }),
    ])
    expect(ranked.map((f) => f.locus.file)).toEqual(["a.ts", "b.ts"])
  })

  test("a real zero ratio is still ranked as a real zero", () => {
    // `1/0` means "nobody answered" — present, and worse than a real fraction.
    // Skipping the criterion for it would be the mirror-image mistake.
    const ranked = rankFindings([
      finding({ severity: "high", file: "a-nobody.ts", coDiscovery: { raised: 1, answered: 0 } }),
      finding({ severity: "high", file: "z-someone.ts", coDiscovery: { raised: 1, answered: 3 } }),
    ])
    expect(ranked.map((f) => f.locus.file)).toEqual(["z-someone.ts", "a-nobody.ts"])
  })
})

// ---------------------------------------------------------------------------
// Story 3 — what a merged canonical must disclose (AD-17e), and the severity it
// must print (AD-10). The pre-cluster blocks above are unchanged on purpose:
// `output()` stays callable on a record clustering never touched.
// ---------------------------------------------------------------------------

describe("a merged canonical discloses what it absorbed (AD-17e)", () => {
  test("THE NOTICE IS ABSENT ONCE clusterId IS SET, INCLUDING WHEN NOTHING MERGED", () => {
    // The case AD-14 amended 2 exists for: a fully-clustered run in which no two
    // findings were equivalent must never re-announce itself as an unmerged pool.
    const rendered = output(
      record(
        [
          finding({ severity: "high", file: "a.ts", clusterId: "cluster-1", coDiscovery: { raised: 1, answered: 3 } }),
          finding({ severity: "high", file: "b.ts", clusterId: "cluster-2", coDiscovery: { raised: 1, answered: 3 } }),
        ],
        3,
      ),
    )
    expect(rendered).not.toContain("NOT YET MERGED")
    expect(rendered).toContain("co-discovery: 1/3")
    // Nothing merged, so nothing is disclosed as merged either.
    expect(rendered).not.toContain("merged:")
  })

  test("the row names how many findings were absorbed and who raised them", () => {
    const canonical = finding({
      id: "f1",
      severity: "high",
      file: "a.ts",
      author: "discovery-1",
      clusterId: "cluster-1",
      coDiscovery: { raised: 2, answered: 3 },
    })
    canonical.mergedIds = ["f2"]
    const absorbed = finding({ id: "f2", severity: "high", file: "a.ts", author: "discovery-2" })
    absorbed.clusterId = "cluster-1"

    const rec = record([canonical], 3)
    rec.pool = [canonical, absorbed]
    const rendered = output(rec)

    expect(rendered).toContain("merged: 1 other finding(s) — discovery-2")
    expect(rendered).toContain("co-discovery: 2/3")
  })

  test("AN ABSORBED LENS MEMBER IS STILL DISCLOSED WITH ITS LENS", () => {
    // Without this the finding disappears from the list entirely, and AD-17e's
    // "the reader always learns a finding was lens-sourced and which lens found
    // it" has no exception for a member that merged.
    const canonical = finding({
      id: "f1",
      severity: "high",
      file: "a.ts",
      author: "discovery-1",
      clusterId: "cluster-1",
      coDiscovery: { raised: 1, answered: 3 },
    })
    canonical.mergedIds = ["f2"]
    const absorbed = lensFinding({ id: "f2", severity: "high", file: "a.ts", lens: "security" })
    absorbed.clusterId = "cluster-1"

    const rec = record([canonical], 3, ["security"])
    rec.pool = [canonical, absorbed]
    const rendered = output(rec)

    expect(rendered).toContain("merged: 1 other finding(s)")
    expect(rendered).toContain("discovery-lens-security")
    expect(rendered).toContain("lens-sourced: `security`")
    // ...and the canonical still renders its own, pool-scoped prior.
    expect(rendered).toContain("co-discovery: 1/3")
  })

  test("an id the pool cannot resolve says so rather than printing a shorter list", () => {
    const canonical = finding({
      id: "f1",
      severity: "high",
      file: "a.ts",
      clusterId: "cluster-1",
      coDiscovery: { raised: 1, answered: 3 },
    })
    canonical.mergedIds = ["ghost"]
    const rec = record([canonical], 3)
    rec.pool = [canonical]

    expect(output(rec)).toContain("ghost (unresolved — not on the run record)")
  })

  test("A CLUSTER THAT TOOK A MEMBER'S `critical` RENDERS `critical` (AD-10)", () => {
    // `severity` is never rewritten (AD-8), so the cell reads through
    // `effectiveSeverity` — otherwise output contradicts the AD it implements.
    const canonical = finding({
      id: "f1",
      severity: "low",
      file: "a.ts",
      clusterId: "cluster-1",
      coDiscovery: { raised: 1, answered: 3 },
    })
    canonical.clusterSeverity = "critical"
    canonical.mergedIds = ["f2"]
    const absorbed = lensFinding({ id: "f2", severity: "critical", file: "a.ts", lens: "security" })

    const rec = record([canonical], 3, ["security"])
    rec.pool = [canonical, absorbed]
    const rendered = output(rec)

    expect(rendered).toContain("[critical]")
    expect(rendered).not.toContain("[low]")
    expect(canonical.severity).toBe("low") // the field itself is untouched
  })

  test("A CLUSTER'S EFFECTIVE SEVERITY ORDERS IT TOO, NOT ONLY PRINTS IT (AD-10)", () => {
    // The regression this pins (code review 2026-08-15): the comparator read the
    // raw `severity` while the cell rendered `effectiveSeverity`, so this run
    // printed `#1 [medium]` above `#2 [critical]` — output contradicting AD-10
    // from the other side. Asserting `[critical]` appears is not enough; the
    // ORDER is the claim.
    const canonical = finding({
      id: "f1",
      severity: "low",
      file: "a.ts",
      clusterId: "cluster-1",
      coDiscovery: { raised: 1, answered: 3 },
    })
    canonical.clusterSeverity = "critical"
    canonical.mergedIds = ["f2"]
    const absorbed = lensFinding({ id: "f2", severity: "critical", file: "a.ts", lens: "security" })
    const other = finding({
      id: "f3",
      severity: "medium",
      file: "b.ts",
      coDiscovery: { raised: 1, answered: 3 },
    })

    const rec = record([canonical, other], 3, ["security"])
    rec.pool = [canonical, absorbed, other]
    const ranked = rankFindings(rec.findings)

    expect(ranked.map((f) => f.id)).toEqual(["f1", "f3"])
    expect(canonical.rank).toBe(1)
    expect(canonical.severity).toBe("low") // still never rewritten (AD-8)

    const rendered = output(rec)
    expect(rendered.indexOf("[critical]")).toBeLessThan(rendered.indexOf("[medium]"))
  })

  test("a finding with no clusterSeverity renders its own severity, as it always did", () => {
    const rendered = output(record([finding({ severity: "medium", file: "a.ts" })]))
    expect(rendered).toContain("[medium]")
  })

  test("AD-17e reaches the UNRESOLVED section too — a merged canonical discloses there", () => {
    // Same clause, same reasoning as the lens label already in that section: a
    // reader deciding an undecided finding by hand needs to know a lens member
    // is folded into it. Latent until story 8 writes `unresolved`.
    const canonical = finding({
      id: "f1",
      severity: "high",
      file: "a.ts",
      clusterId: "cluster-1",
      unresolved: { diedAtStage: "judge", reason: "budget exhausted" },
    })
    canonical.mergedIds = ["f2"]
    const absorbed = lensFinding({ id: "f2", severity: "high", file: "a.ts", lens: "security" })

    const rec = record([canonical], 3, ["security"])
    rec.pool = [canonical, absorbed]
    const section = output(rec).slice(output(rec).indexOf("UNRESOLVED — YOU DECIDE"))

    expect(section).toContain("merged: 1 other finding(s)")
    expect(section).toContain("lens-sourced: `security`")
  })
})

describe("the pool notice stays pool-scoped with a lens finding present (AD-17)", () => {
  test("its count is the POOL's, not the whole finding list", () => {
    const rendered = output(
      record(
        [
          finding({ severity: "high", file: "a.ts", coDiscovery: { raised: 1, answered: 3 } }),
          finding({ severity: "high", file: "b.ts", coDiscovery: { raised: 1, answered: 3 } }),
          lensFinding({ severity: "high", file: "c.ts", lens: "security" }),
        ],
        3,
        ["security"],
      ),
    )
    expect(rendered).toContain("these 2 pool finding(s) are the union of what 3 model(s) reported")
    // The section header still counts everything printed below it.
    expect(rendered).toContain("FINDINGS (3)")
  })

  test("one lens finding does not suppress a true statement about the pool", () => {
    // `uniform` is computed over pool findings only. Over the whole list a lens
    // finding — which never carries a pair — would make it false and silently
    // withhold a sentence that IS true of every fraction rendered.
    const rendered = output(
      record(
        [
          finding({ severity: "high", file: "a.ts", coDiscovery: { raised: 1, answered: 3 } }),
          finding({ severity: "high", file: "b.ts", coDiscovery: { raised: 1, answered: 3 } }),
          lensFinding({ severity: "high", file: "c.ts", lens: "security" }),
        ],
        3,
        ["security"],
      ),
    )
    expect(rendered).toContain("Every co-discovery fraction below reads 1/3")
  })

  test("a run whose only findings are lens-sourced announces no pool", () => {
    // There is no union of pool findings to describe, so the notice says
    // nothing rather than describing an empty one.
    const rendered = output(
      record([lensFinding({ severity: "high", file: "c.ts", lens: "security" })], 3, ["security"]),
    )
    expect(rendered).not.toContain("NOT YET MERGED")
    expect(rendered).toContain("FINDINGS (1)")
  })
})

describe("the route and the dial that produced it are rendered (CAP-3)", () => {
  test("each finding names its route and its reason", () => {
    const rendered = output(
      record([
        finding({
          severity: "high",
          file: "src/pay.ts",
          clusterId: "cluster-1",
          coDiscovery: { raised: 3, answered: 3 },
          route: "judge",
          routeReason: "co-discovery 3/3 at or above threshold 80% — debate skipped, judged verify-independently",
        }),
        finding({
          severity: "medium",
          file: "src/ledger.ts",
          clusterId: "cluster-2",
          coDiscovery: { raised: 1, answered: 3 },
          route: "debate",
          routeReason: "co-discovery 1/3 below threshold 80% — contested",
        }),
      ], 3),
    )

    // `judge` alone would read as though the finding had been DECIDED. The label
    // names the mode, because that is what the route actually means.
    expect(rendered).toContain("route: judge (verify-independently) — co-discovery 3/3 at or above")
    expect(rendered).toContain("route: debate — co-discovery 1/3 below threshold 80%")
  })

  test("THE SUMMARY NAMES THE DIAL AND BOTH COUNTS — this is where CAP-3 is legible", () => {
    const rendered = output(
      record(
        [
          finding({ severity: "high", file: "a.ts", route: "debate", routeReason: "contested" }),
          finding({ severity: "high", file: "b.ts", route: "debate", routeReason: "contested" }),
          finding({ severity: "low", file: "c.ts", route: "judge", routeReason: "settled" }),
        ],
        3,
        [],
        0.5,
        { toDebate: 2, toJudge: 1, toJudgeAtThreshold: 1, toJudgeNoPrior: 0 },
      ),
    )

    expect(rendered).toContain("ROUTING (co-discovery threshold 50%): 2 to debate, 1 straight to the judge.")
    // Skipping debate is not skipping scrutiny, and the reader is told so once.
    expect(rendered).toContain("judged verify-independently instead")
    expect(rendered).toContain("1 of those met or beat the threshold")
    // Nothing was lens-sourced, so that half of the split stays silent rather
    // than printing a zero the reader has to interpret.
    expect(rendered).not.toContain("lens-sourced and was never compared")
  })

  test("THE JUDGE BUCKET IS SPLIT BY WHY — a lens finding is never reported as having cleared the dial", () => {
    // The whole story turns on "an absent prior is not a below-threshold one".
    // A summary that totalled both judge reasons and captioned them "at or above
    // the threshold" would state that conflation in the one line a reader is most
    // likely to read — pointing the other way, but the same false claim.
    const rendered = output(
      record(
        [
          finding({
            severity: "high",
            file: "a.ts",
            route: "judge",
            routeReason: "co-discovery 3/3 at or above threshold 80% — debate skipped",
          }),
          lensFinding({
            lens: "security",
            severity: "high",
            file: "b.ts",
            route: "judge",
            routeReason: "no co-discovery prior — lens-sourced (`security`); judged verify-independently",
          }),
        ],
        3,
        ["security"],
        0.8,
        { toDebate: 0, toJudge: 2, toJudgeAtThreshold: 1, toJudgeNoPrior: 1 },
      ),
    )

    expect(rendered).toContain("0 to debate, 2 straight to the judge.")
    expect(rendered).toContain("1 of those met or beat the threshold")
    expect(rendered).toContain("1 of those is lens-sourced and was never compared against the")
    expect(rendered).toContain("a lens claims no co-discovery prior (AD-17d)")
  })

  test("AD-6 — the summary says debate and judging have not run, so a partial run cannot read as a finished one", () => {
    const rendered = output(
      record(
        [finding({ severity: "high", file: "a.ts", route: "debate", routeReason: "contested" })],
        1,
        [],
        0.8,
        { toDebate: 1, toJudge: 0, toJudgeAtThreshold: 0, toJudgeNoPrior: 0 },
      ),
    )

    expect(rendered).toContain("judging is not implemented yet (story 6)")
    expect(rendered).toContain("Nothing below has been judged")
  })

  test("BOTH ARE SILENT ON A PRE-ROUTE RECORD, so output stays callable mid-pipeline", () => {
    // The same property `pooledNotYetMerged` relies on: `output()` is exported
    // and callable on a record the pipeline has not finished with. The SUMMARY's
    // signal is `routeCounts`, absent here; the per-finding line's is `route`.
    const rendered = output(record([finding({ severity: "high", file: "a.ts" })], 1))

    expect(rendered).not.toContain("ROUTING")
    expect(rendered).not.toContain("route:")
  })

  test("THE SUMMARY REPORTS THE STAGE'S COUNTS, NOT A RECOUNT OF THE RENDERED LIST", () => {
    // This is the drift the record field exists to prevent. Two findings were
    // routed; one of them then died and is rendered in the UNRESOLVED section, so
    // a renderer counting the resolved list would report `1 to debate, 0` and
    // silently shed the other. The stage counted both, and both are reported.
    const died = finding({
      severity: "high",
      file: "b.ts",
      route: "judge",
      routeReason: "co-discovery 3/3 at or above threshold 80% — debate skipped",
    })
    died.unresolved = { diedAtStage: "judge", reason: "budget exhausted" }

    const rendered = output(
      record(
        [finding({ severity: "high", file: "a.ts", route: "debate", routeReason: "contested" }), died],
        3,
        [],
        0.8,
        { toDebate: 1, toJudge: 1, toJudgeAtThreshold: 1, toJudgeNoPrior: 0 },
      ),
    )

    expect(rendered).toContain("1 to debate, 1 straight to the judge.")
    expect(rendered).toContain("FINDINGS (1)")
    expect(rendered).toContain("UNRESOLVED — YOU DECIDE (1)")
  })

  test("THE UNRESOLVED SECTION CARRIES THE ROUTE TOO — the reader deciding by hand needs it", () => {
    // AD-17e's precedent: a reader hand-deciding an undecided finding must not
    // lose the context the resolved list would have given them. "Was this
    // contested, or was it settled enough to skip argument?" is exactly that.
    const died = finding({
      severity: "high",
      file: "a.ts",
      route: "debate",
      routeReason: "co-discovery 1/3 below threshold 80% — contested",
    })
    died.unresolved = { diedAtStage: "debate", reason: "budget exhausted" }

    const rendered = output(
      record([died], 3, [], 0.8, {
        toDebate: 1,
        toJudge: 0,
        toJudgeAtThreshold: 0,
        toJudgeNoPrior: 0,
      }),
    )

    expect(rendered).toContain("UNRESOLVED — YOU DECIDE (1)")
    expect(rendered).toContain("route: debate — co-discovery 1/3 below threshold 80% — contested")
  })

  test("a route with no reason recorded says so rather than rendering a bare dash", () => {
    // `route` and `routeReason` are two independent optionals, so this branch is
    // reachable by type even though `route()` always writes both. Pinned rather
    // than left as a silently dead fallback.
    const rendered = output(
      record([finding({ severity: "high", file: "a.ts", route: "judge" })], 1, [], 0.8, {
        toDebate: 0,
        toJudge: 1,
        toJudgeAtThreshold: 1,
        toJudgeNoPrior: 0,
      }),
    )

    expect(rendered).toContain("route: judge (verify-independently) — no reason recorded")
  })
})

describe("the exit and the cap that produced it are rendered (CAP-4)", () => {
  const debateCounts = (partial: Partial<DebateCounts> = {}): DebateCounts => ({
    debated: 1,
    converged: 1,
    convergedUncontested: 0,
    convergedUnsure: 0,
    stalled: 0,
    cap: 0,
    unresolved: 0,
    rounds: 2,
    turns: 4,
    attempts: 4,
    ...partial,
  })

  /** A finding that carries a real round transcript, so the round count is read. */
  function debated(
    exit: "converged" | "stalled" | "cap",
    rounds: number,
    reason = exit === "converged" ? "agreed" : exit === "stalled" ? "restated" : "restated",
    body = "the exit sentence the stage recorded",
  ): Finding {
    const f = finding({ severity: "high", file: "a.ts", route: "debate", routeReason: "contested" })
    f.exit = exit
    for (let round = 1; round <= rounds; round += 1) {
      f.history.push({
        stage: "debate",
        actor: "discovery-1",
        at: "t1",
        kind: "debate-round",
        body: "argument",
        round,
        position: "upholds",
        positionChanged: false,
        citations: [],
      })
    }
    // The renderer reads the exit ENTRY's body, so the fixture must carry one —
    // that is what lets "the room agreed" and "nobody else answered" render
    // differently from one three-value `exit` field.
    f.history.push({
      stage: "debate",
      actor: "mad",
      at: "t2",
      kind: `debate-exit-${exit}-${reason}`,
      body,
    })
    return f
  }

  test("each exit renders WITH ITS MEANING — three words a reader could otherwise conflate", () => {
    const rendered = output(
      record(
        [debated("stalled", 2, "restated", "Stalled in round 2: nobody moved.")],
        1,
        [],
        0.8,
        undefined,
        debateCounts({ converged: 0, stalled: 1 }),
      ),
    )
    expect(rendered).toContain("debate: stalled after 2 round(s)")
    expect(rendered).toContain("nobody moved")
  })

  test("the round count is read from `history`, not from a stored counter", () => {
    const rendered = output(
      record([debated("cap", 3, "restated", "Round cap reached at 3: positions still differ.")], 1, [], 0.8, undefined, debateCounts({ converged: 0, cap: 1, rounds: 3 })),
    )
    expect(rendered).toContain("debate: cap after 3 round(s)")
    expect(rendered).toContain("positions still differ")
  })

  test("ZERO ROUNDS DOES NOT RENDER AS `after 0 round(s)` — no round is not an empty round", () => {
    // A debate that recorded no position spent no round anybody can read.
    // Printing `0` implies rounds that ran and produced nothing, which is a
    // different and more flattering claim than "nothing was ever argued".
    const silent = debated("stalled", 0, "silent", "Stalled in round 0: NO PARTICIPANT STATED A POSITION.")
    const rendered = output(record([silent], 1, [], 0.8, undefined, debateCounts({ converged: 0, stalled: 1, rounds: 1 })))
    expect(rendered).not.toContain("0 round(s)")
    expect(rendered).toContain("debate: stalled with no round on the record")
    expect(rendered).toContain("NO PARTICIPANT STATED A POSITION")
  })

  test("AD-6 — `uncontested` and `unsure` do not render as agreement", () => {
    // The whole reason the reason rides in the exit entry: `Finding.exit` is
    // three values, and "the room agreed" and "nobody else answered" are not one
    // of them.
    const uncontested = debated(
      "converged",
      1,
      "uncontested",
      "Converged in round 1: UNCONTESTED — only one participant ever stated a position, so nothing here is agreement.",
    )
    const rendered = output(record([uncontested], 1, [], 0.8, undefined, debateCounts({ convergedUncontested: 1 })))
    expect(rendered).toContain("debate: converged after 1 round(s)")
    expect(rendered).toContain("UNCONTESTED")
    expect(rendered).toContain("nothing here is agreement")
    expect(rendered).toContain("converged UNCONTESTED — only one participant ever")

    const unsure = debated(
      "converged",
      2,
      "unsure",
      "Converged in round 2: every participant answered UNSURE.",
    )
    const rendered2 = output(record([unsure], 1, [], 0.8, undefined, debateCounts({ convergedUnsure: 1 })))
    expect(rendered2).toContain("UNSURE")
    expect(rendered2).toContain("converged on UNSURE")
    expect(rendered2).toContain("Unresolved by evidence, not upheld.")
  })

  test("THE SUMMARY NAMES THE CAP AND THE EXITS, and reports the STAGE's counts", () => {
    const rendered = output(
      record(
        [debated("converged", 2)],
        3,
        [],
        0.8,
        { toDebate: 1, toJudge: 0, toJudgeAtThreshold: 0, toJudgeNoPrior: 0 },
        debateCounts({ rounds: 2, turns: 4 }),
        3,
      ),
    )
    expect(rendered).toContain(
      "DEBATE (round cap 3, no token cap): 1 contested finding(s), 2 batched round(s), 4 turn(s) spent.",
    )
    expect(rendered).toContain("exits: 1 converged, 0 stalled, 0 hit the round cap.")
    // AD-15 / lever 1 — a turn count under the finding count is batching, not an
    // omission, and the summary says which.
    expect(rendered).toContain("batched one per model per round")
  })

  test("`debated: 0` IS NOT THE SAME FACT AS `debateCounts` being absent", () => {
    // The absent-vs-zero distinction the field exists for, said out loud.
    const ran = output(record([finding({ severity: "high", file: "a.ts", route: "judge" })], 1, [], 0.8, undefined, debateCounts({ debated: 0, converged: 0, rounds: 0, turns: 0, attempts: 0 })))
    expect(ran).toContain("DEBATE (round cap")
    expect(ran).toContain("Nothing was contested, so no debate turn was spent.")

    const didNotRun = output(record([finding({ severity: "high", file: "a.ts", route: "judge" })], 1, [], 0.8))
    expect(didNotRun).not.toContain("DEBATE (round cap")
  })

  test("BOTH ARE SILENT ON A PRE-DEBATE RECORD, so output stays callable mid-pipeline", () => {
    const rendered = output(record([finding({ severity: "high", file: "a.ts", route: "debate" })], 1, [], 0.8))
    expect(rendered).not.toContain("DEBATE (round cap")
    expect(rendered).not.toContain("debate: ")
  })

  test("a `route: 'judge'` finding renders NO debate line — it was never argued", () => {
    const judged = finding({ severity: "high", file: "b.ts", route: "judge", routeReason: "3/3 cleared the dial" })
    const rendered = output(record([judged], 3, [], 0.8, undefined, debateCounts({ debated: 0, converged: 0, rounds: 0, turns: 0, attempts: 0 })))
    expect(rendered).toContain("route: judge (verify-independently)")
    expect(rendered).not.toContain("debate: ")
  })

  test("AD-6d — the unresolved section reports the budget, and the summary counts it", () => {
    const died = finding({ severity: "high", file: "b.ts", route: "debate", routeReason: "contested" })
    died.unresolved = { diedAtStage: "debate", reason: "the token budget (40) ran out after round 1 of 3" }
    const rendered = output(
      record(
        [died],
        3,
        [],
        0.8,
        { toDebate: 1, toJudge: 0, toJudgeAtThreshold: 0, toJudgeNoPrior: 0 },
        debateCounts({ converged: 0, unresolved: 1, rounds: 1, turns: 2 }),
      ),
    )
    expect(rendered).toContain("UNRESOLVED — YOU DECIDE (1)")
    expect(rendered).toContain("died at stage debate")
    expect(rendered).toContain("token budget")
    expect(rendered).toContain("1 finding(s) never reached an exit: the token budget ran out.")
    // Counted by the stage, so a finding that died still appears in the totals.
    expect(rendered).toContain("1 contested finding(s)")
  })

  test("THE STALL SENTENCE IS THE SUMMARY'S, not the per-finding line's", () => {
    // Deleting the summary's `stalled > 0` branch left the suite green, because
    // every stall assertion matched `renderDebate`'s string instead (mutation
    // check, code review 2026-08-24). This one reads the summary.
    const rendered = output(
      record(
        [debated("stalled", 2, "restated", "Stalled in round 2: nobody moved.")],
        3,
        [],
        0.8,
        { toDebate: 1, toJudge: 0, toJudgeAtThreshold: 0, toJudgeNoPrior: 0 },
        debateCounts({ converged: 0, stalled: 1 }),
      ),
    )
    expect(rendered).toContain("A stalled debate is one where nobody moved. It short-circuits to the judge rather than")
    expect(rendered).toContain("burning the remaining rounds — restating is not progress.")
  })

  test("AD-15 — the TOKEN CAP is named beside the round cap, whether or not it was hit", () => {
    // A ceiling that only appears once it has been exceeded is a ceiling the
    // reader cannot check the run against.
    const capped = record([debated("converged", 1)], 1, [], 0.8, undefined, debateCounts())
    capped.ledger.cap = 5000
    expect(output(capped)).toContain("DEBATE (round cap 3, token cap 5000)")
  })

  test("BILLED ATTEMPTS ARE RECONCILED AGAINST ALLOCATIONS when they differ", () => {
    const retried = output(record([debated("converged", 1)], 1, [], 0.8, undefined, debateCounts({ turns: 4, attempts: 5 })))
    expect(retried).toContain("5 turn(s) were BILLED against those 4 allocation(s): 1 needed")
    expect(retried).toContain("The TOKENS line below counts billed attempts, not allocations.")

    // Silent when they agree — "4 turns, 4 attempts" is noise.
    const clean = output(record([debated("converged", 1)], 1, [], 0.8, undefined, debateCounts()))
    expect(clean).not.toContain("were BILLED against")
  })

  test("THE UNRESOLVED SECTION CARRIES NO DEBATE LINE — the two fields cannot co-occur", () => {
    // `unresolved` is written only for a room whose `exit` is undefined (AD-6d),
    // and nothing writes an exit afterwards. The line that used to be emitted
    // here was dead code under a comment claiming otherwise.
    const died = finding({ severity: "high", file: "b.ts", route: "debate", routeReason: "contested" })
    died.unresolved = { diedAtStage: "debate", reason: "the token budget (40) ran out after round 1 of 3" }
    const rendered = output(record([died], 3, [], 0.8, undefined, debateCounts({ converged: 0, unresolved: 1 })))
    expect(rendered).toContain("UNRESOLVED — YOU DECIDE (1)")
    expect(rendered).not.toContain("debate: ")
  })

  test("RANKING IS UNTOUCHED BY THE EXIT — verdict ordering is story 6's", () => {
    // An exit sorted on would put "we argued about this" above "this is bad".
    const stalledCritical = debated("stalled", 2)
    stalledCritical.severity = "critical"
    stalledCritical.locus = { file: "z.ts", startLine: 1, endLine: 1 }
    const convergedLow = debated("converged", 1)
    convergedLow.severity = "low"
    convergedLow.locus = { file: "a.ts", startLine: 1, endLine: 1 }

    const ranked = rankFindings([convergedLow, stalledCritical])
    expect(ranked.map((f) => f.severity)).toEqual(["critical", "low"])
  })
})
