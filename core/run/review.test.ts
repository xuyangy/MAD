import { describe, expect, test } from "bun:test"

import { selectRoster } from "../roster/select.ts"
import { DEFAULT_MAX_ROUNDS } from "../stages/debate.ts"
import { DEFAULT_CO_DISCOVERY_THRESHOLD } from "../stages/route.ts"
import type { ModelBackend } from "../ports/model-backend.ts"
import {
  candidate,
  fakeChange,
  fakeClock,
  FakeBackend,
  tokens,
  type SlotScript,
  type SlotStep,
} from "../test-support/fakes.ts"
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

/**
 * A VALID debate envelope stating no position — "I said nothing this round".
 *
 * `FakeBackend` repeats a script's last step, so a slot scripted only for
 * discovery is handed its discovery envelope on its debate turn, fails
 * validation twice, and drops out (AD-12). That is correct behaviour and exactly
 * the wrong thing to have happen inside a test about some other stage. Silence
 * is abstention: appending this step lets a debate happen and end without
 * anybody in it having claimed anything.
 */
const DEBATE_ABSTENTION: SlotStep = { kind: "ok", value: { turns: [] } }

function abstainingInDebate(scripts: Record<string, SlotScript>): Record<string, SlotScript> {
  return Object.fromEntries(
    Object.entries(scripts).map(([slot, script]) => [slot, [...script, DEBATE_ABSTENTION]]),
  )
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

// ---------------------------------------------------------------------------
// CAP-3 — SEVERITY-AWARE THRESHOLD ROUTING, END TO END (story 4)
//
// CAP-3's success criterion is a claim about a DIFFERENCE between two runs:
// "changing the threshold alone demonstrably changes which findings enter
// debate". A unit test over `route()` cannot make that claim, because the
// interesting input — a real co-discovery pair produced by real clustering over
// real discovery — is exactly what the pipeline assembles. These run it.
// ---------------------------------------------------------------------------

const CAP3_MODELS = [
  ["anthropic", "claude-sonnet-4-5"],
  ["openai", "gpt-5"],
  ["google", "gemini-2.5-pro"],
] as [string, string][]

/**
 * Two models describe ONE defect in `src/pay.ts` and the third describes a
 * different one in `src/ledger.ts`. After clustering that is a 2/3 finding and a
 * 1/3 finding — the two sides of any threshold between them.
 */
function cap3Backend(severity: "high" | "critical" = "high") {
  const shared = { ...ENVELOPE.findings[0]!, severity, file: "src/pay.ts", startLine: 12, endLine: 14 }
  return new FakeBackend({
    "discovery-1": [{ kind: "ok" as const, value: { findings: [{ ...shared, claim: "The rate is never validated." }] } }],
    "discovery-2": [{ kind: "ok" as const, value: { findings: [{ ...shared, claim: "The rate is not validated before use." }] } }],
    "discovery-3": [
      {
        kind: "ok" as const,
        value: {
          findings: [
            { ...ENVELOPE.findings[0]!, severity, claim: "The ledger write is not awaited.", file: "src/ledger.ts", startLine: 90, endLine: 90 },
          ],
        },
      },
    ],
  })
}

async function cap3Run(threshold: number, severity: "high" | "critical" = "high") {
  const resolved = setup(CAP3_MODELS, 3)
  return review({
    roster: resolved.roster,
    backend: cap3Backend(severity),
    clock: fakeClock(),
    change: fakeChange(),
    priorWarnings: resolved.warnings,
    threshold,
  })
}

const debated = (record: { findings: { id: string; route?: string }[] }) =>
  record.findings.filter((f) => f.route === "debate").map((f) => f.id).sort()

describe("review — CAP-3 threshold routing, through the whole pipeline", () => {
  test("CHANGING THE THRESHOLD ALONE CHANGES WHICH FINDINGS ENTER DEBATE", async () => {
    const paranoid = await cap3Run(1)
    const quick = await cap3Run(0.5)

    // At 1.0 nothing short of unanimity is settled, so both findings are argued.
    expect(debated(paranoid.record)).toHaveLength(2)
    // At 0.5 the 2/3 finding clears the bar and only the 1/3 one is argued.
    expect(debated(quick.record)).toHaveLength(1)

    // The IDS, not only the counts. "Two became one" is satisfied by any finding
    // dropping out; CAP-3's claim is that the debate set SHRANK BY THE FINDING
    // THAT CLEARED THE DIAL and kept the one that did not.
    const cleared = paranoid.record.findings.find((f) => f.coDiscovery?.raised === 2)!
    const stillContested = paranoid.record.findings.find((f) => f.coDiscovery?.raised === 1)!
    expect(debated(paranoid.record)).toEqual([cleared.id, stillContested.id].sort())
    expect(debated(quick.record)).toEqual([stillContested.id])

    // The thing that differed is the DIAL, and nothing else about the findings.
    const fractions = (r: typeof paranoid.record) =>
      r.findings.map((f) => `${f.coDiscovery?.raised}/${f.coDiscovery?.answered}`).sort()
    expect(fractions(paranoid.record)).toEqual(fractions(quick.record))
    expect(paranoid.record.findings.map((f) => f.severity)).toEqual(
      quick.record.findings.map((f) => f.severity),
    )
    expect(paranoid.record.threshold).toBe(1)
    expect(quick.record.threshold).toBe(0.5)
  })

  test("a CRITICAL finding at full co-discovery is still debated (CAP-3)", async () => {
    // The assertion that carries this test is about the 2/3 finding SPECIFICALLY.
    // It clears a 0.5 threshold comfortably, so it is the one the override
    // actually rescues from the judge path; the 1/3 finding would be debated
    // anyway and proves nothing. Asserting `every(...)` alone would pass even if
    // the override did nothing.
    const { record, rendered } = await cap3Run(0.5, "critical")

    const cleared = record.findings.find((f) => f.coDiscovery?.raised === 2)!
    expect(cleared).toBeDefined()
    expect(cleared.coDiscovery).toEqual({ raised: 2, answered: 3 })
    expect(cleared.route).toBe("debate")
    expect(cleared.routeReason).toContain("critical severity overrides the threshold")
    // ...and its reason names the override rather than the fraction it beat.
    expect(cleared.routeReason).not.toContain("2/3")

    expect(record.findings.every((f) => f.route === "debate")).toBe(true)
    expect(record.routeCounts).toEqual({
      toDebate: 2,
      toJudge: 0,
      toJudgeAtThreshold: 0,
      toJudgeNoPrior: 0,
    })
    expect(rendered).toContain("critical severity overrides the threshold")
  })

  test("AN OUT-OF-RANGE THRESHOLD IS CLAMPED AT THE SEAM, and the record reports what ran", async () => {
    // `RunRecord.threshold` says it is "the threshold this run actually routed
    // against, already clamped". Nothing used to hold `review()` to that: every
    // value any test passed was a fixpoint of `clampThreshold`, so replacing the
    // stamp with `deps.threshold ?? DEFAULT` kept the whole suite green while the
    // record announced `900%` for a run that routed at `100%`.
    const { record, rendered } = await cap3Run(9)

    expect(record.threshold).toBe(1)
    expect(rendered).toContain("ROUTING (co-discovery threshold 100%)")
    // At 1.0 nothing short of unanimity settles, and neither finding is unanimous.
    expect(debated(record)).toHaveLength(2)
  })

  test("a NaN threshold falls back to the default rather than poisoning the render", async () => {
    const { record, rendered } = await cap3Run(Number.NaN)

    expect(record.threshold).toBe(DEFAULT_CO_DISCOVERY_THRESHOLD)
    expect(rendered).toContain("ROUTING (co-discovery threshold 80%)")
    // Scoped to the lines routing wrote — the seeded change's own prose talks
    // about a NaN total, so a whole-render check would pass for the wrong reason.
    for (const finding of record.findings) {
      expect(finding.routeReason).not.toContain("NaN")
    }
    expect(rendered.split("\n").find((l) => l.startsWith("ROUTING"))).not.toContain("NaN")
  })

  test("a LENS finding is judged verify-independently, and still carries no prior", async () => {
    // ALL THREE POOL SLOTS ARE SCRIPTED. An unscripted slot returns
    // `empty-response` from `FakeBackend` and drops out, which would leave
    // `answered === 1`, put every pool finding at `1/1`, and make the
    // `threshold: 0.8` below play no part in the run — a degraded roster reading
    // as a clean three-model-plus-lens one. The two shared claims give the pool a
    // real 2/3 that the dial actually bites on.
    const resolved = setup(CAP3_MODELS, 3, ["security"])
    const { record, rendered } = await review({
      roster: resolved.roster,
      // Story 5 put a debate stage between routing and output, so every slot in
      // a contested finding's room is asked a SECOND time. This test is about
      // ROUTING, so its slots ABSTAIN in debate rather than being scripted for
      // an argument nobody here asserts on — otherwise the debate turn would be
      // handed the discovery envelope, fail validation twice, and decorate a
      // routing assertion with drop-out warnings.
      backend: new FakeBackend(abstainingInDebate({
        "discovery-1": [
          {
            kind: "ok" as const,
            value: {
              findings: [
                { ...ENVELOPE.findings[0]!, claim: "The rate is never validated.", file: "src/pay.ts", startLine: 12, endLine: 14 },
              ],
            },
          },
        ],
        "discovery-2": [
          {
            kind: "ok" as const,
            value: {
              findings: [
                { ...ENVELOPE.findings[0]!, claim: "The rate is not validated before use.", file: "src/pay.ts", startLine: 12, endLine: 14 },
              ],
            },
          },
        ],
        "discovery-3": [
          {
            kind: "ok" as const,
            value: {
              findings: [
                { ...ENVELOPE.findings[0]!, claim: "The ledger write is not awaited.", file: "src/ledger.ts", startLine: 90, endLine: 90 },
              ],
            },
          },
        ],
        "discovery-lens-security": [
          {
            kind: "ok" as const,
            value: {
              findings: [
                { ...ENVELOPE.findings[0]!, claim: "Tokens are logged in cleartext.", file: "src/auth.ts", startLine: 8, endLine: 8 },
              ],
            },
          },
        ],
      })),
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
      threshold: 0.8,
    })

    // The roster is NOT degraded — pin it, because a silent drop-out would make
    // every assertion below hold for the wrong reason.
    expect(record.answered).toBe(3)
    expect(record.warnings.some((w) => w.code === "model-dropped-out")).toBe(false)

    const lensFinding = record.findings.find((f) => f.source === "lens")!
    expect(lensFinding.route).toBe("judge")
    expect(lensFinding.coDiscovery).toBeUndefined()
    // AD-17d — the reason names the absence, never the threshold it was not
    // compared against. 2A's invariant, now surviving a third stage.
    expect(lensFinding.routeReason).toContain("no co-discovery prior")
    expect(lensFinding.routeReason).not.toContain("threshold")
    expect(rendered).toContain("route: judge (verify-independently)")

    // The dial really did bite: the 2/3 pool finding is below 0.8 and debated,
    // which is what makes the lens finding's judge route a DIFFERENT fact rather
    // than the same one arrived at by accident.
    const merged = record.findings.find((f) => f.coDiscovery?.raised === 2)!
    expect(merged.coDiscovery).toEqual({ raised: 2, answered: 3 })
    expect(merged.route).toBe("debate")

    // And the summary keeps the two judge reasons apart (AD-17d).
    expect(record.routeCounts?.toJudgeNoPrior).toBe(1)
    expect(record.routeCounts?.toJudgeAtThreshold).toBe(0)
    expect(rendered).toContain("1 of those is lens-sourced and was never compared against the")
  })

  test("with no threshold given the run uses the shipped default and says so", async () => {
    const resolved = setup(CAP3_MODELS, 3)
    const { record, rendered } = await review({
      roster: resolved.roster,
      backend: cap3Backend(),
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
    })

    expect(record.threshold).toBe(DEFAULT_CO_DISCOVERY_THRESHOLD)
    expect(rendered).toContain("ROUTING (co-discovery threshold 80%)")
    // Every finding leaves routed — routing partitions, it never filters.
    expect(record.findings.every((f) => f.route !== undefined)).toBe(true)
  })
})

describe("review — CAP-4 per-finding debate, through the whole pipeline", () => {
  /**
   * Two models, two DISTINCT findings, so each reads 1/2 and lands below the
   * default 0.8 threshold — both contested, and neither is contested by accident.
   *
   * Ids are `fakeClock`'s: `run-1`, then one `finding-N` per raised finding in
   * roster order. `finding-2` is discovery-1's, `finding-3` is discovery-2's.
   */
  const DEBATE_MODELS: [string, string][] = [
    ["anthropic", "claude-sonnet-4-5"],
    ["openai", "gpt-5"],
  ]

  const raised = (claim: string, file: string) => ({
    kind: "ok" as const,
    value: { findings: [{ ...ENVELOPE.findings[0]!, claim, file, startLine: 1, endLine: 1 }] },
  })

  const position = (
    ...turns: { findingId: string; position: string; concession?: string }[]
  ) => ({
    kind: "ok" as const,
    value: {
      turns: turns.map((turn) => ({
        findingId: turn.findingId,
        position: turn.position,
        argument: `${turn.position} on ${turn.findingId}`,
        ...(turn.concession === undefined ? {} : { concession: turn.concession }),
        citations: ["src/pay.ts:12"],
      })),
    },
  })

  test("AC: A CONTESTED FINDING DEBATES THROUGH THE REAL PIPELINE; A JUDGE-ROUTED ONE DOES NOT", async () => {
    // discovery-1 and discovery-2 raise the SAME defect at the same locus, so it
    // clusters to 2/2 and clears the dial — judge, never debated. discovery-2
    // also raises a lone one at 1/2, which is contested.
    const shared = { ...ENVELOPE.findings[0]!, claim: "The rate is never validated.", file: "src/pay.ts", startLine: 12, endLine: 14 }
    const resolved = setup(DEBATE_MODELS, 2)
    const { record, rendered } = await review({
      roster: resolved.roster,
      backend: new FakeBackend({
        "discovery-1": [
          { kind: "ok", value: { findings: [shared] } },
          position({ findingId: "finding-4", position: "denies" }),
        ],
        "discovery-2": [
          {
            kind: "ok",
            value: {
              findings: [
                shared,
                { ...ENVELOPE.findings[0]!, claim: "The ledger write is not awaited.", file: "src/ledger.ts", startLine: 90, endLine: 90 },
              ],
            },
          },
          position({ findingId: "finding-4", position: "upholds" }),
        ],
      }),
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
    })

    const cleared = record.findings.find((f) => f.coDiscovery?.raised === 2)!
    const contested = record.findings.find((f) => f.locus.file === "src/ledger.ts")!

    // The contested one carries EXACTLY ONE exit and at least one debate entry.
    expect(contested.route).toBe("debate")
    expect(contested.exit).toBeDefined()
    expect(contested.history.filter((e) => e.kind.startsWith("debate-exit-"))).toHaveLength(1)
    expect(contested.history.some((e) => e.stage === "debate" && e.round === 1)).toBe(true)

    // The threshold-skipped one carries NEITHER. Its absence of an exit is the
    // fact "this was never argued", not "this was argued to no conclusion".
    expect(cleared.route).toBe("judge")
    expect(cleared.exit).toBeUndefined()
    expect(cleared.history.some((e) => e.stage === "debate")).toBe(false)

    // The record and the render agree about the partition.
    expect(record.debateCounts?.debated).toBe(1)
    expect(record.maxRounds).toBe(DEFAULT_MAX_ROUNDS)
    expect(rendered).toContain("DEBATE (round cap 3, no token cap)")
    expect(rendered).toContain("debate: ")
  })

  test("a debate that CONVERGES on a concession is on the record end to end", async () => {
    const resolved = setup(DEBATE_MODELS, 2)
    const { record, rendered } = await review({
      roster: resolved.roster,
      backend: new FakeBackend({
        "discovery-1": [
          raised("The rate is never validated.", "src/pay.ts"),
          position({ findingId: "finding-2", position: "upholds" }, { findingId: "finding-3", position: "denies" }),
          position({ findingId: "finding-2", position: "upholds" }, { findingId: "finding-3", position: "upholds", concession: "I had the guard on the wrong line." }),
        ],
        "discovery-2": [
          raised("The ledger write is not awaited.", "src/ledger.ts"),
          position({ findingId: "finding-2", position: "upholds" }, { findingId: "finding-3", position: "upholds" }),
        ],
      }),
      clock: fakeClock(),
      change: fakeChange(),
    })

    const ledgerFinding = record.findings.find((f) => f.locus.file === "src/ledger.ts")!
    expect(ledgerFinding.exit).toBe("converged")
    const flip = ledgerFinding.history.find((e) => e.round === 2 && e.actor === "discovery-1")!
    expect(flip.positionChanged).toBe(true)
    expect(flip.concession).toContain("guard")
    // AD-8 — the withdrawal/verdict boundary holds through the real pipeline.
    expect(ledgerFinding.verdict).toBeUndefined()
    expect(rendered).toContain("debate: converged")
    expect(record.debateCounts?.converged).toBe(2)
  })

  test("AC: A TOKEN CAP THE SECOND ROUND WOULD EXCEED LEAVES FINDINGS UNRESOLVED, NOT DROPPED", async () => {
    // `tokens()` bills 30 per turn: discovery spends 60, so a cap of 100 permits
    // round 1 (60 < 100) and refuses round 2 (120 >= 100).
    const resolved = setup(DEBATE_MODELS, 2)
    const { record, rendered } = await review({
      roster: resolved.roster,
      backend: new FakeBackend({
        "discovery-1": [
          raised("The rate is never validated.", "src/pay.ts"),
          position({ findingId: "finding-2", position: "upholds" }, { findingId: "finding-3", position: "denies" }),
        ],
        "discovery-2": [
          raised("The ledger write is not awaited.", "src/ledger.ts"),
          position({ findingId: "finding-2", position: "denies" }, { findingId: "finding-3", position: "upholds" }),
        ],
      }),
      clock: fakeClock(),
      change: fakeChange(),
      tokenCap: 100,
    })

    expect(record.findings).toHaveLength(2)
    for (const finding of record.findings) {
      expect(finding.unresolved).toEqual({
        diedAtStage: "debate",
        reason: expect.stringContaining("token budget"),
      })
      expect(finding.exit).toBeUndefined()
    }
    // The run REPORTS where it stopped, and nothing was silently shed.
    expect(record.warnings.some((w) => w.code === "unresolved-findings")).toBe(true)
    expect(rendered).toContain("UNRESOLVED — YOU DECIDE (2)")
    expect(rendered).toContain("FINDINGS (0)")
    expect(record.debateCounts?.unresolved).toBe(2)
  })

  test("AC: A PARTICIPANT THAT FAILS EVERY ATTEMPT DOES NOT STALL THE RUN", async () => {
    const resolved = setup(DEBATE_MODELS, 2)
    const { record, rendered } = await review({
      roster: resolved.roster,
      backend: new FakeBackend({
        "discovery-1": [
          raised("The rate is never validated.", "src/pay.ts"),
          position({ findingId: "finding-2", position: "upholds" }, { findingId: "finding-3", position: "upholds" }),
        ],
        "discovery-2": [
          raised("The ledger write is not awaited.", "src/ledger.ts"),
          { kind: "fail", failure: "model-error", message: "overloaded" },
        ],
      }),
      clock: fakeClock(),
      change: fakeChange(),
    })

    // Both models ANSWERED discovery, so the denominator is intact...
    expect(record.answered).toBe(2)
    // ...and the drop-out is debate's, named, and does not stop the run.
    const dropped = record.warnings.filter((w) => w.code === "model-dropped-out" && w.stage === "debate")
    expect(dropped).toHaveLength(1)
    expect(dropped[0]!.message).toContain("discovery-2")
    for (const finding of record.findings) expect(finding.exit).toBeDefined()
    expect(rendered).toContain("MODEL DROPPED OUT OF DEBATE")
  })

  test("the same run at a LOWER round cap changes the exit and nothing else", async () => {
    const scripts = () => ({
      "discovery-1": [
        raised("The rate is never validated.", "src/pay.ts"),
        position({ findingId: "finding-2", position: "upholds" }, { findingId: "finding-3", position: "denies" }),
        position({ findingId: "finding-2", position: "upholds" }, { findingId: "finding-3", position: "unsure" }),
        position({ findingId: "finding-2", position: "upholds" }, { findingId: "finding-3", position: "upholds" }),
      ],
      "discovery-2": [
        raised("The ledger write is not awaited.", "src/ledger.ts"),
        position({ findingId: "finding-2", position: "upholds" }, { findingId: "finding-3", position: "upholds" }),
      ],
    })
    const at = async (maxRounds: number) => {
      const resolved = setup(DEBATE_MODELS, 2)
      return review({
        roster: resolved.roster,
        backend: new FakeBackend(scripts()),
        clock: fakeClock(),
        change: fakeChange(),
        maxRounds,
      })
    }

    const long = await at(3)
    const short = await at(2)
    const ledgerOf = (r: Awaited<ReturnType<typeof at>>) =>
      r.record.findings.find((f) => f.locus.file === "src/ledger.ts")!

    expect(ledgerOf(long).exit).toBe("converged")
    expect(ledgerOf(short).exit).toBe("cap")
    expect(long.record.maxRounds).toBe(3)
    expect(short.record.maxRounds).toBe(2)
    // Everything the exit is not.
    const shape = (f: (typeof long)["record"]["findings"][number]) => ({
      claim: f.claim,
      severity: f.severity,
      coDiscovery: f.coDiscovery,
      route: f.route,
      routeReason: f.routeReason,
      verdict: f.verdict,
      unresolved: f.unresolved,
    })
    expect(shape(ledgerOf(short))).toEqual(shape(ledgerOf(long)))
  })

  test("SEAM: A SLOT THAT DROPPED OUT OF DISCOVERY IS NEVER GIVEN A DEBATE TURN", async () => {
    // Deleting `review()`'s `.filter(slot => !discovered.droppedOut.includes(slot))`
    // left the whole suite green (mutation check, code review 2026-08-24). That
    // argument decides WHO argues, and `adapters/opencode/plugin.ts` is the
    // caller that would ship it.
    const resolved = setup(
      [
        ["anthropic", "claude-sonnet-4-5"],
        ["openai", "gpt-5"],
        ["google", "gemini-2.5-pro"],
      ],
      3,
    )
    const backend = new FakeBackend({
      "discovery-1": [
        raised("The rate is never validated.", "src/pay.ts"),
        position({ findingId: "finding-2", position: "upholds" }),
      ],
      // Fails BOTH discovery attempts: it never answers, so it is not a seat.
      "discovery-2": [{ kind: "fail", failure: "model-error", message: "gone" }],
      "discovery-3": [
        raised("The ledger write is not awaited.", "src/ledger.ts"),
        position({ findingId: "finding-2", position: "denies" }),
      ],
    })
    const { record } = await review({
      roster: resolved.roster,
      backend,
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
    })

    // The run is degraded and says so, and a contested finding still exists.
    expect(record.answered).toBe(2)
    expect(record.findings.some((f) => f.route === "debate")).toBe(true)
    expect(record.debateCounts!.debated).toBeGreaterThan(0)

    // The dead slot was asked exactly twice — its discovery turn and its one
    // retry — and never once for debate.
    expect(backend.calls.filter((call) => call.slot === "discovery-2")).toHaveLength(2)
    // ...while the live slots were asked more than their discovery turn.
    expect(backend.calls.filter((call) => call.slot === "discovery-1").length).toBeGreaterThan(1)
  })

  test("SEAM: AN ABSORBED MEMBER'S AUTHOR IS SEATED IN THE CANONICAL'S ROOM", async () => {
    // Deleting `pool: record.pool` left the suite green (mutation check, code
    // review 2026-08-24). That argument decides WITH WHOM a finding is argued:
    // without the pre-cluster union there is nowhere to resolve `mergedIds` back
    // to a second author, and every merged cluster silently loses its
    // co-finder's seat.
    //
    // FOUR slots, deliberately. The cluster is raised by discovery-2 and
    // discovery-3, and the ONE extra seat goes to discovery-1 (first in roster
    // order). So without the pool the room would be {discovery-2, discovery-1} —
    // and discovery-3's absence is the whole assertion. At two or three slots
    // the co-finder happens to coincide with the extra seat and the test would
    // pass either way.
    const sharedLocus = { file: "src/pay.ts", startLine: 12, endLine: 14 }
    const raisedAt = (claim: string, locus: { file: string; startLine: number; endLine: number }) => ({
      kind: "ok" as const,
      value: { findings: [{ ...ENVELOPE.findings[0]!, claim, ...locus }] },
    })
    // One debate step answering every id in the run; the stage discards answers
    // about findings a slot was not seated for (asserted in `debate.test.ts`).
    const answersAll = position(
      ...["finding-2", "finding-3", "finding-4", "finding-5"].map((findingId) => ({
        findingId,
        position: "upholds",
      })),
    )
    const resolved = setup(
      [
        ["anthropic", "claude-sonnet-4-5"],
        ["openai", "gpt-5"],
        ["google", "gemini-2.5-pro"],
        ["meta", "llama-4-scout"],
      ],
      4,
    )
    const { record } = await review({
      roster: resolved.roster,
      backend: new FakeBackend({
        "discovery-1": [raisedAt("Retries are unbounded.", { file: "src/retry.ts", startLine: 4, endLine: 4 }), answersAll],
        "discovery-2": [raisedAt("The rate is never validated.", sharedLocus), answersAll],
        "discovery-3": [raisedAt("The rate is not validated before use.", sharedLocus), answersAll],
        "discovery-4": [raisedAt("The ledger write is not awaited.", { file: "src/ledger.ts", startLine: 90, endLine: 90 }), answersAll],
      }),
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
      // 2/4 clears neither 0.8 nor 1, so the merged cluster stays contested.
      maxRounds: 1,
    })

    const canonical = record.findings.find((f) => (f.mergedIds?.length ?? 0) > 0)!
    expect(canonical.mergedIds).toHaveLength(1)
    expect(canonical.author).toBe("discovery-2")
    expect(canonical.route).toBe("debate")

    // The co-finder argued, and it is seated ONLY because the pool was passed.
    const spoke = new Set(
      canonical.history.filter((e) => e.kind === "debate-round").map((e) => e.actor),
    )
    expect(spoke.has("discovery-3")).toBe(true)
    // Sparse room: the author, the co-finder, and exactly one extra seat.
    expect([...spoke].sort()).toEqual(["discovery-1", "discovery-2", "discovery-3"])
    expect(spoke.has("discovery-4")).toBe(false)
  })

  test("SEAM: THE DEBATE PROMPT CARRIES THE CHANGE UNDER REVIEW", async () => {
    // Replacing `input: buildInput(change)` with `""` left the suite green. That
    // argument decides what EVIDENCE the debate is about — a debate over a diff
    // nobody was shown is rhetoric, which is the thing this design exists to
    // replace.
    const prompts: string[] = []
    const resolved = setup(DEBATE_MODELS, 2)
    const recording: ModelBackend = {
      capabilities: () => ({ tools: false }),
      async runTurn(slot, _instructions, input, schema) {
        prompts.push(input)
        const payload = input.includes("Debate round")
          ? { turns: [{ findingId: "finding-2", position: "upholds", argument: "a", citations: [] }] }
          : { findings: [{ ...ENVELOPE.findings[0]!, claim: `${slot} found it`, file: `src/${slot}.ts`, startLine: 1, endLine: 1 }] }
        const parsed = schema.safeParse(payload)
        return parsed.success
          ? { ok: true, slot, value: parsed.data, tokens: tokens() }
          : { ok: false, slot, failure: "schema-invalid", message: "n/a", tokens: tokens() }
      },
    }
    await review({
      roster: resolved.roster,
      backend: recording,
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
      maxRounds: 1,
    })

    const debatePrompts = prompts.filter((prompt) => prompt.includes("Debate round"))
    expect(debatePrompts.length).toBeGreaterThan(0)
    for (const prompt of debatePrompts) {
      // `fakeChange()`'s actual diff text, not merely a heading.
      expect(prompt).toContain("const fee = total * rate")
      expect(prompt).toContain("src/pay.ts")
    }
  })

  test("SEAM: a NaN token cap is clamped rather than refusing every turn", async () => {
    // Unclamped, `spent < NaN` is false for every spend: the run would debate
    // nothing, mark every contested finding unresolved, and report "the token
    // budget (NaN) ran out".
    const resolved = setup(DEBATE_MODELS, 2)
    const { record, rendered } = await review({
      roster: resolved.roster,
      backend: new FakeBackend({
        "discovery-1": [
          raised("The rate is never validated.", "src/pay.ts"),
          position({ findingId: "finding-2", position: "upholds" }, { findingId: "finding-3", position: "upholds" }),
        ],
        "discovery-2": [
          raised("The ledger write is not awaited.", "src/ledger.ts"),
          position({ findingId: "finding-2", position: "upholds" }, { findingId: "finding-3", position: "upholds" }),
        ],
      }),
      clock: fakeClock(),
      change: fakeChange(),
      tokenCap: Number.NaN,
    })

    expect(record.ledger.cap).toBeNull()
    expect(record.debateCounts!.unresolved).toBe(0)
    expect(record.findings.every((f) => f.unresolved === undefined)).toBe(true)
    expect(rendered).toContain("no token cap")
    // The fixture's own reasoning prose mentions NaN; what must not appear is a
    // BUDGET reported as NaN.
    expect(rendered).not.toContain("token budget (NaN)")
    expect(rendered).not.toContain("token cap NaN")
  })

  test("an out-of-range round cap is clamped at the seam and the record reports what ran", async () => {
    const resolved = setup(DEBATE_MODELS, 2)
    const { record } = await review({
      roster: resolved.roster,
      backend: new FakeBackend(abstainingInDebate({
        "discovery-1": [raised("The rate is never validated.", "src/pay.ts")],
        "discovery-2": [raised("The ledger write is not awaited.", "src/ledger.ts")],
      })),
      clock: fakeClock(),
      change: fakeChange(),
      maxRounds: 99,
    })
    expect(record.maxRounds).toBe(6)
  })
})
