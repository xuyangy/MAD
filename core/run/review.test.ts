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

function setup(models: [string, string][], slots = 1, lenses: readonly string[] = []) {
  return selectRoster(
    models.map(([p, m]) => candidate(p, m)),
    { slots, lenses, providerConfigKey: "provider" },
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

  test("THREE MODELS DESCRIBING ONE DEFECT BECOME ONE FINDING READING 3/3", async () => {
    // The default fan-out of a fresh install, and the case CAP-2 exists for. All
    // three scripted findings share the locus `src/pay.ts:12-14`, so they are
    // three models describing ONE defect. Before story 3 this test asserted the
    // inverse — three findings at 1/3 and no clusterId — and that inversion is
    // the point rather than a regression: it is what clustering was built to do.
    const resolved = setup(
      [
        ["anthropic", "claude-sonnet-4-5"],
        ["openai", "gpt-5"],
        ["google", "gemini-2.5-pro"],
      ],
      3,
    )
    const claimOf = (slot: string) => `${slot} found the fee bug before the rate was validated.`
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
    // The pool is retained in roster order, not completion order — CAP-1's
    // recall arms are derived from it and every finding stays a live object.
    expect(record.pool).toHaveLength(3)
    expect(record.pool.map((f) => f.author)).toEqual([
      "discovery-1",
      "discovery-2",
      "discovery-3",
    ])
    expect(record.pool.map((f) => f.claim)).toEqual([
      claimOf("discovery-1"),
      claimOf("discovery-2"),
      claimOf("discovery-3"),
    ])

    // ONE canonical finding reaches output, credited to three distinct models.
    expect(record.findings).toHaveLength(1)
    const canonical = record.findings[0]!
    expect(canonical.author).toBe("discovery-1")
    expect(canonical.coDiscovery).toEqual({ raised: 3, answered: 3 })
    expect(canonical.mergedIds).toHaveLength(2)

    // AD-14 amended 2 — every finding carries an id, absorbed members included.
    for (const finding of record.pool) expect(finding.clusterId).toBe(canonical.clusterId!)

    expect(rendered).toContain("co-discovery: 3/3")
    expect(rendered).toContain("answered: 3")
    expect(rendered).toContain("WARNINGS: none")
    // Clustering has run, so the union notice is gone (AD-6, AD-14 amended 2).
    expect(rendered).not.toContain("POOL — NOT YET MERGED")
    // AD-17e — the reader learns which models were absorbed into it.
    expect(rendered).toContain("merged: 2 other finding(s)")
    expect(rendered).toContain("discovery-2")
    expect(rendered).toContain("discovery-3")
  })

  test("THREE DISTINCT LOCI STAY THREE SINGLETONS, EACH READING 1/3", async () => {
    // The other direction, and the one the deleted shim used to produce for
    // every run: nothing is equivalent, so nothing merges and every fraction
    // reads 1/3 — byte-for-byte what story 2 rendered, minus the union notice.
    const resolved = setup(
      [
        ["anthropic", "claude-sonnet-4-5"],
        ["openai", "gpt-5"],
        ["google", "gemini-2.5-pro"],
      ],
      3,
    )
    const script = [
      { slot: "discovery-1", file: "src/pay.ts", line: 12, claim: "The rate is never validated." },
      { slot: "discovery-2", file: "src/refund.ts", line: 40, claim: "Money is stored as a float." },
      { slot: "discovery-3", file: "src/ledger.ts", line: 90, claim: "The ledger write is not awaited." },
    ]
    const { record, rendered } = await review({
      roster: resolved.roster,
      backend: new FakeBackend(
        Object.fromEntries(
          script.map((entry) => [
            entry.slot,
            [
              {
                kind: "ok" as const,
                value: {
                  findings: [
                    {
                      ...ENVELOPE.findings[0]!,
                      claim: entry.claim,
                      file: entry.file,
                      startLine: entry.line,
                      endLine: entry.line,
                    },
                  ],
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
    expect(record.pool).toHaveLength(3)
    expect(record.findings).toHaveLength(3)
    for (const finding of record.findings) {
      expect(finding.coDiscovery).toEqual({ raised: 1, answered: 3 })
      // AD-14 amended 2 — a run in which nothing merged is still a clustered run.
      expect(finding.clusterId).toBeDefined()
      expect(finding.mergedIds).toBeUndefined()
    }
    expect(new Set(record.findings.map((f) => f.clusterId)).size).toBe(3)
    expect(rendered).toContain("co-discovery: 1/3")
    expect(rendered).not.toContain("POOL — NOT YET MERGED")
    expect(rendered).not.toContain("merged:")
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

    // AD-6a — the denominator is who answered, so the fraction reads 2/2 and
    // never 2/3 against a slot no model ever filled. Both models raised the same
    // ENVELOPE finding at one locus, so clustering merges them.
    expect(record.answered).toBe(2)
    expect(record.pool).toHaveLength(2)
    expect(record.findings).toHaveLength(1)
    expect(record.findings[0]!.coDiscovery).toEqual({ raised: 2, answered: 2 })
    expect(rendered).toContain("co-discovery: 2/2")
    expect(rendered).toContain("slots requested: 3 | filled: 2")
    // The warning names the real lineage count, whatever its code is called.
    const lineageWarning = record.warnings.find((w) => w.code === "roster-single-lineage")!
    expect(lineageWarning.message).toContain("2")
    // Clustering has run, so the union notice is gone even on a degraded roster.
    expect(rendered).not.toContain("POOL — NOT YET MERGED")
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

// ---------------------------------------------------------------------------
// CAP-11 — the invariant that survived the shim. Until story 3 the guard on
// `source === 'pool'` in `review.ts` was the only thing between a lens finding
// and a co-discovery prior it was never entitled to. The shim is gone and
// clustering owns `coDiscovery` now (AD-8), so the invariant holds for a
// STRONGER reason: `raised` counts distinct POOL authors, so a lens member of a
// pool cluster is recorded and disclosed without ever being counted, and a
// cluster with no pool member at all gets no pair. This is still the assertion
// most likely to catch a regression during stories 4–6.
// ---------------------------------------------------------------------------

const LENSED_SLOTS = ["discovery-1", "discovery-2", "discovery-3"] as const

function lensedBackend(lenses: readonly string[]) {
  const script = Object.fromEntries([
    ...LENSED_SLOTS.map((slot) => [
      slot,
      [{ kind: "ok" as const, value: { findings: [{ ...ENVELOPE.findings[0]!, claim: `${slot} found it.` }] } }],
    ]),
    ...lenses.map((lens) => [
      `discovery-lens-${lens}`,
      [
        {
          kind: "ok" as const,
          value: { findings: [{ ...ENVELOPE.findings[0]!, claim: `the ${lens} lens found it.` }] },
        },
      ],
    ]),
  ])
  return new FakeBackend(script)
}

describe("review — no lens finding carries a co-discovery prior (AD-17d)", () => {
  const THREE = [
    ["anthropic", "claude-sonnet-4-5"],
    ["openai", "gpt-5"],
    ["google", "gemini-2.5-pro"],
  ] as [string, string][]

  test("NO LENS FINDING CARRIES coDiscovery, WHEREVER CLUSTERING PUTS IT", async () => {
    const lenses = ["security", "performance"]
    const resolved = setup(THREE, 3, lenses)
    const { record, rendered } = await review({
      roster: resolved.roster,
      backend: lensedBackend(lenses),
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
    })

    // The pool is retained, so the invariant is checked over EVERY finding the
    // run raised, absorbed members included — which is where a lens finding now
    // ends up when it describes a defect the pool also found.
    const pool = record.pool.filter((f) => f.source === "pool")
    const lens = record.pool.filter((f) => f.source === "lens")
    expect(pool).toHaveLength(3)
    expect(lens).toHaveLength(2)

    for (const finding of lens) {
      // Not `1/1`, not `1/3`, not `0` — ABSENT. A lens was PROMPTED for its
      // dimension, so it has no unprompted signal and no number can stand in for
      // one, whatever the ratio would have read.
      expect(finding.coDiscovery).toBeUndefined()
    }

    // All five describe one defect at one locus, so they form one cluster. Its
    // canonical is a POOL finding credited to the three distinct pool authors —
    // the two lens members raise it not at all (CAP-11).
    expect(record.findings).toHaveLength(1)
    const canonical = record.findings[0]!
    expect(canonical.source).toBe("pool")
    expect(canonical.coDiscovery).toEqual({ raised: 3, answered: 3 })

    // AD-6a — the denominator is the pool's, so lenses neither shrink a fraction
    // nor inflate one.
    expect(record.answered).toBe(3)
    expect(rendered).toContain("co-discovery: 3/3")
    expect(rendered).not.toContain("/5")
    // AD-17e — an absorbed lens member does not vanish; it is named with its lens.
    expect(rendered).toContain("lens-sourced: `security`")
    expect(rendered).toContain("lens-sourced: `performance`")
  })

  test("A CLUSTER OF LENS FINDINGS ALONE RENDERS `not applicable`, AT ANY DENOMINATOR", async () => {
    // The other half of the invariant. A lens finding describing a defect no
    // pool model raised forms its own cluster, and that cluster gets no pair at
    // all — not `1/1` at `answered: 1`, not `1/3` at `answered: 3`. Both are the
    // same defect; only one of them ever looked obviously wrong.
    const resolved = setup([["openai", "gpt-5"]], 1, ["security"])
    const { record, rendered } = await review({
      roster: resolved.roster,
      backend: new FakeBackend({
        "discovery-1": [{ kind: "ok", value: ENVELOPE }],
        "discovery-lens-security": [
          {
            kind: "ok",
            value: {
              findings: [
                {
                  claim: "The order id is interpolated into the SQL string.",
                  reasoning: "",
                  severity: "critical",
                  file: "src/query.ts",
                  startLine: 80,
                  endLine: 80,
                },
              ],
            },
          },
        ],
      }),
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
    })

    expect(record.answered).toBe(1)
    const lens = record.findings.find((f) => f.source === "lens")!
    expect(lens.coDiscovery).toBeUndefined()
    expect(lens.clusterId).toBeDefined() // clustering ran; it simply claims nothing
    expect(rendered).toContain("not applicable — lens-sourced")
    // ...while the pool finding beside it does carry its prior.
    expect(record.findings.find((f) => f.source === "pool")!.coDiscovery).toEqual({
      raised: 1,
      answered: 1,
    })
  })

  test("AD-17c — lens slots reach the run record without touching distinctLineages", async () => {
    const lenses = ["security", "performance", "tests"]
    const resolved = setup(THREE, 3, lenses)
    const { record } = await review({
      roster: resolved.roster,
      backend: lensedBackend(lenses),
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
    })

    expect(record.roster.lensSlots).toHaveLength(3)
    expect(record.roster.distinctLineages).toBe(3)
    // AD-11 amended — provenance survives to the record, and so to output.
    expect(record.lensInstructions).toEqual([
      { lens: "security", origin: "shipped" },
      { lens: "performance", origin: "shipped" },
      { lens: "tests", origin: "shipped" },
    ])
  })

  test("an unregistered lens is recorded as generated, and still reviews", async () => {
    const lenses = ["threat-model"]
    const resolved = setup(THREE, 3, lenses)
    const { record, rendered } = await review({
      roster: resolved.roster,
      backend: lensedBackend(lenses),
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
    })

    expect(record.lensInstructions).toEqual([{ lens: "threat-model", origin: "generated" }])
    // Read from the POOL: the lens finding describes the same defect the pool
    // raised, so clustering absorbs it — and an absorbed member is still a live
    // object on the record (AD-7, `RunRecord.pool`).
    expect(record.pool.some((f) => f.lens === "threat-model")).toBe(true)
    expect(rendered).toContain("GENERATED at run time")
  })

  test("with no lenses the record is exactly what story 2 produced", async () => {
    // AD-3 / AD-15 amended — the fresh-install path, unchanged.
    const resolved = setup(THREE, 3)
    const backend = lensedBackend([])
    const { record } = await review({
      roster: resolved.roster,
      backend,
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
    })

    expect(record.roster.lensSlots).toEqual([])
    expect(record.lensInstructions).toEqual([])
    expect(backend.calls).toHaveLength(3) // one billed turn per pool slot, no more
    expect(record.findings.every((f) => f.source === "pool")).toBe(true)
    expect(record.findings.every((f) => f.coDiscovery?.answered === 3)).toBe(true)
  })
})
