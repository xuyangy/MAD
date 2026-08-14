import { describe, expect, test } from "bun:test"

import { selectRoster } from "../roster/select.ts"
import { candidate, fakeChange, fakeClock, FakeBackend } from "../test-support/fakes.ts"
import { review } from "./review.ts"

const ENVELOPE = {
  findings: [
    {
      claim: "Fee is computed before the rate is validated.",
      reasoning: "If `rate` is NaN the total silently becomes NaN.",
      severity: "high",
      file: "src/pay.ts",
      startLine: 12,
      endLine: 14,
    },
  ],
}

function setup(models: [string, string][], slots = 1) {
  return selectRoster(
    models.map(([p, m]) => candidate(p, m)),
    { slots, providerConfigKey: "provider" },
  )
}

describe("review — the story 9 control arm seam", () => {
  test("matrix: happy path — one model reviews, findings emit with co-discovery 1/1", async () => {
    const resolved = setup([
      ["anthropic", "claude-sonnet-4-5"],
      ["openai", "gpt-5"],
      ["google", "gemini-2.5-pro"],
    ])
    const { record, rendered } = await review({
      roster: resolved.roster,
      backend: new FakeBackend({ "discovery-1": [{ kind: "ok", value: ENVELOPE }] }),
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
    })

    expect(record.answered).toBe(1)
    expect(record.findings).toHaveLength(1)
    expect(record.findings[0]!.coDiscovery).toEqual({ raised: 1, answered: 1 })
    expect(record.findings[0]!.rank).toBe(1)
    expect(rendered).toContain("co-discovery: 1/1")
    expect(rendered).toContain("[high]")
    expect(rendered).toContain("src/pay.ts:12-14")
  })

  test("three slots pool in roster order, each reading 1/3 over answered: 3", async () => {
    // The default fan-out of a fresh install (story 2). Every model answers, so
    // the denominator is 3 and nothing here is degraded.
    const resolved = setup(
      [
        ["anthropic", "claude-sonnet-4-5"],
        ["openai", "gpt-5"],
        ["google", "gemini-2.5-pro"],
      ],
      3,
    )
    const claimOf = (slot: string) => `${slot} found the fee bug.`
    const { record, rendered } = await review({
      roster: resolved.roster,
      backend: new FakeBackend(
        Object.fromEntries(
          ["discovery-1", "discovery-2", "discovery-3"].map((slot) => [
            slot,
            [
              {
                kind: "ok" as const,
                value: {
                  findings: [{ ...ENVELOPE.findings[0]!, claim: claimOf(slot) }],
                },
              },
            ],
          ]),
        ),
      ),
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
    })

    expect(record.answered).toBe(3)
    expect(record.findings).toHaveLength(3)
    // Pooled in roster order, not completion order, and not merged (AD-14 is
    // story 3's): three models describing one defect are three findings here.
    expect(record.findings.map((f) => f.author)).toEqual([
      "discovery-1",
      "discovery-2",
      "discovery-3",
    ])
    expect(record.findings.map((f) => f.claim)).toEqual([
      claimOf("discovery-1"),
      claimOf("discovery-2"),
      claimOf("discovery-3"),
    ])
    // AD-6a — one denominator, and it is who answered.
    for (const finding of record.findings) {
      expect(finding.coDiscovery).toEqual({ raised: 1, answered: 3 })
      expect(finding.clusterId).toBeUndefined()
    }
    expect(rendered).toContain("co-discovery: 1/3")
    expect(rendered).toContain("answered: 3")
    expect(rendered).toContain("WARNINGS: none")
    // The pool is honest about not being merged yet (AD-6).
    expect(rendered).toContain("POOL — NOT YET MERGED")
  })

  test("two lineages at three slots — the common host, warned honestly and still reviewed", async () => {
    // The shape most real hosts have once the default is 3: two providers, not
    // one and not three. Reviewed and accepted 2026-08-14 — AD-6c says a roster
    // resolving to fewer lineages than slots warns, and a run that quietly
    // pretended two-thirds diversity was full diversity is the degradation this
    // AD exists to make visible. The `roster-single-lineage` CODE NAME reads
    // oddly for a two-lineage roster; its message counts lineages correctly, and
    // renaming the code is deliberately left alone so nothing downstream that
    // matches on it drifts mid-story.
    const resolved = setup(
      [
        ["anthropic", "claude-sonnet-4-5"],
        ["openai", "gpt-5"],
      ],
      3,
    )
    const { record, rendered } = await review({
      roster: resolved.roster,
      backend: new FakeBackend({
        "discovery-1": [{ kind: "ok", value: ENVELOPE }],
        "discovery-2": [{ kind: "ok", value: ENVELOPE }],
      }),
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
    })

    const codes = record.warnings.map((w) => w.code)
    expect(codes).toContain("roster-underfilled")
    expect(codes).toContain("roster-single-lineage")
    // Not a drop-out: the host never offered a third model, so nothing failed.
    expect(codes).not.toContain("model-dropped-out")
    expect(codes).not.toContain("denominator-reduced")

    // AD-6a — the denominator is who answered, so the fraction reads 1/2 and
    // never 1/3 against a slot no model ever filled.
    expect(record.answered).toBe(2)
    expect(record.findings).toHaveLength(2)
    for (const finding of record.findings) {
      expect(finding.coDiscovery).toEqual({ raised: 1, answered: 2 })
    }
    expect(rendered).toContain("co-discovery: 1/2")
    expect(rendered).toContain("slots requested: 3 | filled: 2")
    // The warning names the real lineage count, whatever its code is called.
    const lineageWarning = record.warnings.find((w) => w.code === "roster-single-lineage")!
    expect(lineageWarning.message).toContain("2")
    // Still a pool at N=2, and still said so.
    expect(rendered).toContain("POOL — NOT YET MERGED")
  })

  test("matrix: host smaller than N — runs on what there is, and says what is missing", async () => {
    // The default fan-out is 3 (adapters/opencode/plugin.ts) and this host offers
    // one model. Both roster facts are degradations in their own right and both
    // must survive to the rendered run: "requested 3, filled 1" is a different
    // fact from "one lineage" (AD-6c). What must NOT happen is a refusal — MAD
    // reports a degraded roster and reviews anyway (host-integration.md).
    const resolved = setup([["openai", "gpt-5"]], 3)
    const { record, rendered } = await review({
      roster: resolved.roster,
      backend: new FakeBackend({ "discovery-1": [{ kind: "ok", value: ENVELOPE }] }),
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
    })

    expect(record.findings).toHaveLength(1)
    const codes = record.warnings.map((w) => w.code)
    expect(codes).toContain("roster-underfilled")
    expect(codes).toContain("roster-single-lineage")
    // AD-6a — the denominator is the one model that answered, not the three asked
    // for, and no drop-out is invented for the slots the host could not fill.
    expect(record.answered).toBe(1)
    expect(codes).not.toContain("model-dropped-out")
    expect(codes).not.toContain("denominator-reduced")
    expect(record.findings[0]!.coDiscovery).toEqual({ raised: 1, answered: 1 })

    expect(rendered).toContain("this run is degraded")
    // Both warnings name the host config key, so the warning is actionable.
    expect(rendered).toContain("`provider`")
    expect(rendered).toContain("slots requested: 3 | filled: 1")
    // A union of one is a merged set already, so the pool notice stays quiet.
    expect(rendered).not.toContain("POOL — NOT YET MERGED")
  })

  test("the record is in memory and self-describing (AD-16)", async () => {
    const resolved = setup([["openai", "gpt-5"]])
    const { record } = await review({
      roster: resolved.roster,
      backend: new FakeBackend({ "discovery-1": [{ kind: "ok", value: ENVELOPE }] }),
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
    })

    expect(record.runId).toMatch(/^run-/)
    expect(record.startedAt).toBe("2026-08-13T00:00:00.000Z")
    expect(record.finishedAt).toBeDefined()
    expect(record.roster.slots).toHaveLength(1)
    expect(record.ledger.entries).toHaveLength(1)
    expect(record.ledger.total.output).toBeGreaterThan(0)
  })

  test("the diff reaches the model as the material under review", async () => {
    const resolved = setup([["openai", "gpt-5"]])
    let seen = ""
    const backend = new FakeBackend({ "discovery-1": [{ kind: "ok", value: ENVELOPE }] })
    const wrapped = {
      capabilities: backend.capabilities.bind(backend),
      runTurn: async (slot: string, instructions: string, input: string, schema: never) => {
        seen = input
        return backend.runTurn(slot, instructions, input, schema)
      },
    }
    await review({
      roster: resolved.roster,
      backend: wrapped as never,
      clock: fakeClock(),
      change: fakeChange(),
    })
    expect(seen).toContain("const fee = total * rate")
    expect(seen).toContain("src/pay.ts")
  })

  test("a degraded run stays distinguishable end to end (AD-6)", async () => {
    // Single lineage roster AND a drop-out.
    const resolved = setup(
      [
        ["anthropic", "claude-sonnet-4-5"],
        ["anthropic", "claude-haiku-4-5"],
      ],
      2,
    )
    const { record, rendered } = await review({
      roster: resolved.roster,
      backend: new FakeBackend({
        "discovery-1": [{ kind: "ok", value: ENVELOPE }],
        "discovery-2": [{ kind: "fail", failure: "model-error", message: "overloaded" }],
      }),
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
    })

    const codes = record.warnings.map((w) => w.code)
    expect(codes).toContain("roster-single-lineage")
    expect(codes).toContain("model-dropped-out")
    expect(codes).toContain("denominator-reduced")

    // AD-6a — the denominator is who answered, not who was asked.
    expect(record.findings[0]!.coDiscovery).toEqual({ raised: 1, answered: 1 })
    expect(rendered).toContain("this run is degraded")
    expect(rendered).toContain("anthropic/claude-haiku-4-5")
  })

  test("no model answering still produces a rendered run rather than a crash", async () => {
    const resolved = setup([["openai", "gpt-5"]])
    const { record, rendered } = await review({
      roster: resolved.roster,
      backend: new FakeBackend({
        "discovery-1": [{ kind: "fail", failure: "transport-error", message: "down" }],
      }),
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
    })
    expect(record.answered).toBe(0)
    expect(record.findings).toHaveLength(0)
    expect(rendered).toContain("this run is degraded")
    expect(rendered).toContain("FINDINGS (0)")
  })
})
