import { describe, expect, test } from "bun:test"

import { emptyLedger } from "../domain/run-record.ts"
import { DISCOVERY_INSTRUCTIONS } from "../instructions/discovery.ts"
import { selectRoster } from "../roster/select.ts"
import { candidate, fakeClock, FakeBackend, type SlotScript } from "../test-support/fakes.ts"
import { discover } from "./discover.ts"

function rosterOf(slots: number, models: [string, string][]) {
  return selectRoster(
    models.map(([provider, model]) => candidate(provider, model)),
    { slots, providerConfigKey: "provider" },
  ).roster
}

const ONE_FINDING = {
  findings: [
    {
      claim: "Fee is computed before the rate is validated.",
      reasoning: "If `rate` is NaN the total silently becomes NaN and is written to the ledger.",
      severity: "high",
      file: "src/pay.ts",
      startLine: 12,
      endLine: 14,
    },
  ],
}

function run(roster: ReturnType<typeof rosterOf>, script: Record<string, SlotScript>) {
  const backend = new FakeBackend(script)
  const ledger = emptyLedger()
  return {
    backend,
    ledger,
    result: discover({
      roster,
      backend,
      instructions: DISCOVERY_INSTRUCTIONS,
      input: "diff",
      clock: fakeClock(),
      ledger,
    }),
  }
}

describe("discover — happy path", () => {
  test("a single model answering yields findings and a denominator of 1", async () => {
    const roster = rosterOf(1, [["anthropic", "claude-sonnet-4-5"]])
    const { result, backend, ledger } = run(roster, {
      "discovery-1": [{ kind: "ok", value: ONE_FINDING }],
    })
    const discovered = await result

    expect(discovered.answered).toBe(1)
    expect(discovered.findings).toHaveLength(1)
    expect(discovered.warnings).toHaveLength(0)
    expect(backend.calls).toHaveLength(1) // no retry when the first turn works
    expect(ledger.entries).toHaveLength(1)
    expect(ledger.total.input).toBeGreaterThan(0)
  })

  test("discovery writes only the fields it owns (AD-8)", async () => {
    const roster = rosterOf(1, [["openai", "gpt-5"]])
    const discovered = await run(roster, { "discovery-1": [{ kind: "ok", value: ONE_FINDING }] })
      .result
    const finding = discovered.findings[0]!

    expect(finding.claim).toBe(ONE_FINDING.findings[0]!.claim)
    expect(finding.severity).toBe("high")
    expect(finding.locus).toEqual({ file: "src/pay.ts", startLine: 12, endLine: 14 })
    expect(finding.author).toBe("discovery-1")
    // fields owned by later stages stay unset
    expect(finding.coDiscovery).toBeUndefined()
    expect(finding.clusterId).toBeUndefined()
    expect(finding.verdict).toBeUndefined()
    expect(finding.rank).toBeUndefined()
    // AD-7 — history got its first, appended, entry
    expect(finding.history).toHaveLength(1)
    expect(finding.history[0]!.stage).toBe("discover")
  })

  test("prose passes through unparsed (AD-11)", async () => {
    const prose = "Line 12 does `total * rate`; see the JSON blob {not: parsed} — verbatim."
    const roster = rosterOf(1, [["openai", "gpt-5"]])
    const discovered = await run(roster, {
      "discovery-1": [
        {
          kind: "ok",
          value: { findings: [{ ...ONE_FINDING.findings[0]!, reasoning: prose }] },
        },
      ],
    }).result
    expect(discovered.findings[0]!.reasoning).toBe(prose)
  })

  test("locus normalizes to the spine convention", async () => {
    const roster = rosterOf(1, [["openai", "gpt-5"]])
    const discovered = await run(roster, {
      "discovery-1": [
        {
          kind: "ok",
          value: {
            findings: [
              // single line: endLine omitted
              { ...ONE_FINDING.findings[0]!, file: "./src\\pay.ts", startLine: 7, endLine: undefined },
              // architectural claim: no site at all
              {
                ...ONE_FINDING.findings[0]!,
                file: "src/pay.ts",
                startLine: undefined,
                endLine: undefined,
              },
            ],
          },
        },
      ],
    }).result

    expect(discovered.findings[0]!.locus).toEqual({ file: "src/pay.ts", startLine: 7, endLine: 7 })
    expect(discovered.findings[1]!.locus).toEqual({ file: "src/pay.ts" })
  })

  test("an empty findings list is a valid answer and still counts in the denominator", async () => {
    const roster = rosterOf(1, [["openai", "gpt-5"]])
    const discovered = await run(roster, {
      "discovery-1": [{ kind: "ok", value: { findings: [] } }],
    }).result
    expect(discovered.answered).toBe(1)
    expect(discovered.findings).toHaveLength(0)
  })
})

describe("discover — drop-out (AD-6a, AD-6b, AD-12)", () => {
  test("matrix: model drops out — exactly one retry, then a warning naming it", async () => {
    const roster = rosterOf(1, [["anthropic", "claude-sonnet-4-5"]])
    const { result, backend } = run(roster, {
      "discovery-1": [{ kind: "fail", failure: "model-error", message: "429 overloaded" }],
    })
    const discovered = await result

    expect(backend.calls).toHaveLength(2) // exactly one retry — not zero, not two
    expect(discovered.answered).toBe(0)
    expect(discovered.droppedOut).toEqual(["discovery-1"])

    const dropped = discovered.warnings.find((w) => w.code === "model-dropped-out")
    expect(dropped).toBeDefined()
    expect(dropped!.message).toContain("anthropic/claude-sonnet-4-5")
    expect(dropped!.message).toContain("429 overloaded")
  })

  test("the retry is used and a recovered model counts normally", async () => {
    const roster = rosterOf(1, [["openai", "gpt-5"]])
    const { result, backend } = run(roster, {
      "discovery-1": [
        { kind: "fail", failure: "transport-error", message: "socket hang up" },
        { kind: "ok", value: ONE_FINDING },
      ],
    })
    const discovered = await result

    expect(backend.calls).toHaveLength(2)
    expect(discovered.answered).toBe(1)
    expect(discovered.warnings).toHaveLength(0)
  })

  test("matrix: malformed envelope — retried once, then recorded as a drop-out (AD-12)", async () => {
    const roster = rosterOf(1, [["openai", "gpt-5"]])
    const { result, backend } = run(roster, {
      // Fails the real schema: severity is off-scale (AD-10).
      "discovery-1": [
        {
          kind: "ok",
          value: { findings: [{ ...ONE_FINDING.findings[0]!, severity: "blocker" }] },
        },
      ],
    })
    const discovered = await result

    expect(backend.calls).toHaveLength(2)
    expect(discovered.answered).toBe(0)
    const dropped = discovered.warnings.find((w) => w.code === "model-dropped-out")
    expect(dropped!.detail!.failure).toBe("schema-invalid")
  })

  test("the denominator excludes the drop-out and says so", async () => {
    const roster = rosterOf(3, [
      ["anthropic", "claude-sonnet-4-5"],
      ["openai", "gpt-5"],
      ["google", "gemini-2.5-pro"],
    ])
    const discovered = await run(roster, {
      "discovery-1": [{ kind: "ok", value: ONE_FINDING }],
      "discovery-2": [{ kind: "ok", value: ONE_FINDING }],
      "discovery-3": [{ kind: "fail", failure: "model-error", message: "timeout" }],
    }).result

    expect(discovered.answered).toBe(2) // not 3
    const reduced = discovered.warnings.find((w) => w.code === "denominator-reduced")
    expect(reduced).toBeDefined()
    expect(reduced!.detail).toMatchObject({ answered: 2, requested: 3 })
  })

  test("one bad item does not cost the model, its findings, or the denominator", async () => {
    const roster = rosterOf(1, [["openai", "gpt-5"]])
    const { result, backend } = run(roster, {
      "discovery-1": [
        {
          kind: "ok",
          value: {
            findings: [
              ONE_FINDING.findings[0]!,
              { ...ONE_FINDING.findings[0]!, severity: "blocker" }, // off-scale (AD-10)
              { ...ONE_FINDING.findings[0]!, file: "src/other.ts" },
            ],
          },
        },
      ],
    })
    const discovered = await result

    expect(backend.calls).toHaveLength(2) // AD-12's retry still happens first
    expect(discovered.answered).toBe(1) // the model is NOT dropped
    expect(discovered.droppedOut).toEqual([])
    expect(discovered.findings).toHaveLength(2) // the two valid items survive

    const partial = discovered.warnings.find((w) => w.code === "partial-envelope")
    expect(partial).toBeDefined()
    expect(partial!.detail).toMatchObject({ kept: 2, dropped: 1 })
    expect(partial!.message).toContain("openai/gpt-5")
  })

  test("an envelope with nothing salvageable is still a drop-out", async () => {
    const roster = rosterOf(1, [["openai", "gpt-5"]])
    const discovered = await run(roster, {
      "discovery-1": [
        { kind: "ok", value: { findings: [{ ...ONE_FINDING.findings[0]!, severity: "blocker" }] } },
      ],
    }).result

    expect(discovered.answered).toBe(0)
    expect(discovered.droppedOut).toEqual(["discovery-1"])
    expect(discovered.warnings.some((w) => w.code === "partial-envelope")).toBe(false)
  })

  test("a backend that THROWS takes down its own slot and no other", async () => {
    const roster = rosterOf(2, [
      ["anthropic", "claude-sonnet-4-5"],
      ["openai", "gpt-5"],
    ])
    const inner = new FakeBackend({ "discovery-2": [{ kind: "ok", value: ONE_FINDING }] })
    const exploding = {
      capabilities: () => ({ tools: false }),
      runTurn: async (slot: string, i: string, input: string, schema: never) => {
        if (slot === "discovery-1") throw new Error("backend exploded")
        return inner.runTurn(slot, i, input, schema)
      },
    }

    const discovered = await discover({
      roster,
      backend: exploding as never,
      instructions: DISCOVERY_INSTRUCTIONS,
      input: "diff",
      clock: fakeClock(),
      ledger: emptyLedger(),
    })

    expect(discovered.answered).toBe(1) // slot 2 survived
    expect(discovered.findings).toHaveLength(1)
    expect(discovered.droppedOut).toEqual(["discovery-1"])
    expect(
      discovered.warnings.find((w) => w.code === "model-dropped-out")!.message,
    ).toContain("backend exploded")
  })

  test("every attempt is billed to the ledger, including failed ones (AD-15)", async () => {
    const roster = rosterOf(1, [["openai", "gpt-5"]])
    const { result, ledger } = run(roster, {
      "discovery-1": [{ kind: "fail", failure: "model-error" }],
    })
    await result
    expect(ledger.entries).toHaveLength(2)
    expect(ledger.entries.map((e) => e.attempt)).toEqual([1, 2])
  })
})
