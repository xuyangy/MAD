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
