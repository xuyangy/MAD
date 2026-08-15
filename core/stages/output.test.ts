import { describe, expect, test } from "bun:test"

import type { Finding, Severity } from "../domain/finding.ts"
import { emptyLedger, type RunRecord } from "../domain/run-record.ts"
import { selectRoster } from "../roster/select.ts"
import { candidate } from "../test-support/fakes.ts"
import { output, rankFindings } from "./output.ts"

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

function record(findings: Finding[], answered = 1, lenses: readonly string[] = []): RunRecord {
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
    lensInstructions: roster.lensSlots.map((slot) => ({ lens: slot.lens, origin: "shipped" as const })),
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
