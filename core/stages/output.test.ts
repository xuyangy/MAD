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
    clusterId: partial.clusterId,
    coDiscovery: partial.coDiscovery,
    unresolved: partial.unresolved,
    history: [],
  }
}

function record(findings: Finding[], answered = 1): RunRecord {
  const { roster, warnings } = selectRoster([candidate("openai", "gpt-5")], {
    slots: 1,
    providerConfigKey: "provider",
  })
  return {
    runId: "run-1",
    startedAt: "2026-08-13T00:00:00.000Z",
    roster,
    answered,
    findings,
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
