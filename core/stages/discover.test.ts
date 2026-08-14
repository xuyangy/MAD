import { describe, expect, test } from "bun:test"

import type { ZodType } from "zod"

import { emptyLedger } from "../domain/run-record.ts"
import { DISCOVERY_INSTRUCTIONS } from "../instructions/discovery.ts"
import type { BackendCapabilities, Envelope, ModelBackend } from "../ports/model-backend.ts"
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

// ---------------------------------------------------------------------------
// N > 1 — the pooling contract in the stage header. These only mean anything at
// a fan-out wider than one, which is what story 2 turns on by default.
// ---------------------------------------------------------------------------

const THREE_LINEAGES: [string, string][] = [
  ["anthropic", "claude-sonnet-4-5"],
  ["openai", "gpt-5"],
  ["google", "gemini-2.5-pro"],
]

function findingFor(slot: string, file = `src/${slot}.ts`) {
  return {
    claim: `${slot} says the fee is computed before the rate is validated.`,
    reasoning: `${slot}: if \`rate\` is NaN the total silently becomes NaN.`,
    severity: "high",
    file,
    startLine: 12,
    endLine: 14,
  }
}

function deferred(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

/**
 * Peak concurrency, observed with NO wall-clock at all.
 *
 * `Promise.all` over `roster.slots.map(async …)` starts every callback
 * synchronously, so each turn runs up to its first `await` before any of them
 * resumes. One yield is therefore enough: a parallel stage has all N turns
 * inside `runTurn` at once and peaks at N; a stage that awaited each slot in a
 * loop enters, yields, finishes and decrements before the next begins, and
 * peaks at 1. The earlier version raced a 25 ms fallback timer against the
 * fan-out, which could report 2 instead of 3 on a loaded runner and fail a
 * correct implementation.
 */
class ConcurrencyProbe implements ModelBackend {
  peak = 0
  private inFlight = 0

  constructor(private readonly inner: FakeBackend) {}

  capabilities(slot: string): BackendCapabilities {
    return this.inner.capabilities(slot)
  }

  async runTurn<T>(
    slot: string,
    instructions: string,
    input: string,
    schema: ZodType<T>,
  ): Promise<Envelope<T>> {
    this.inFlight += 1
    this.peak = Math.max(this.peak, this.inFlight)
    try {
      // One yield, so every concurrently-started turn is counted before any
      // completes. A `finally` owns the decrement: a throwing inner turn would
      // otherwise leave `inFlight` permanently inflated and `peak` meaningless.
      await Promise.resolve()
      return await this.inner.runTurn(slot, instructions, input, schema)
    } finally {
      this.inFlight -= 1
    }
  }
}

/**
 * Forces an exact completion order through explicit gates rather than sleeps,
 * so inverting arrival against roster order is deterministic instead of a race
 * between 0/15/30 ms timers that a loaded runner can reorder.
 *
 * Each slot waits for its predecessor in `order` to finish. A stage that ran the
 * roster sequentially would deadlock here rather than fail cleanly — which is
 * why `ConcurrencyProbe` above is the test that diagnoses sequential execution;
 * this one assumes it and pins the ordering instead.
 */
class SequencedBackend implements ModelBackend {
  readonly completed: string[] = []
  private readonly gates: Map<string, { promise: Promise<void>; open: () => void }>

  constructor(
    private readonly inner: FakeBackend,
    private readonly order: readonly string[],
  ) {
    this.gates = new Map(order.map((slot) => [slot, deferred()]))
    this.gates.get(order[0]!)!.open()
  }

  capabilities(slot: string): BackendCapabilities {
    return this.inner.capabilities(slot)
  }

  async runTurn<T>(
    slot: string,
    instructions: string,
    input: string,
    schema: ZodType<T>,
  ): Promise<Envelope<T>> {
    await this.gates.get(slot)!.promise
    this.completed.push(slot)
    const next = this.order[this.order.indexOf(slot) + 1]
    if (next) this.gates.get(next)!.open()
    return this.inner.runTurn(slot, instructions, input, schema)
  }
}

/** Records exactly what each slot was given. */
class RecordingBackend implements ModelBackend {
  readonly seen: { slot: string; instructions: string; input: string }[] = []

  constructor(private readonly inner: FakeBackend) {}

  capabilities(slot: string): BackendCapabilities {
    return this.inner.capabilities(slot)
  }

  async runTurn<T>(
    slot: string,
    instructions: string,
    input: string,
    schema: ZodType<T>,
  ): Promise<Envelope<T>> {
    this.seen.push({ slot, instructions, input })
    return this.inner.runTurn(slot, instructions, input, schema)
  }
}

function threeSlotScript(): Record<string, SlotScript> {
  return {
    "discovery-1": [{ kind: "ok", value: { findings: [findingFor("discovery-1")] } }],
    "discovery-2": [{ kind: "ok", value: { findings: [findingFor("discovery-2")] } }],
    "discovery-3": [{ kind: "ok", value: { findings: [findingFor("discovery-3")] } }],
  }
}

/** The one change every slot reviews. Named so identity can be asserted. */
const THE_INPUT = "the one diff under review"

function discoverWith(backend: ModelBackend, roster: ReturnType<typeof rosterOf>) {
  return discover({
    roster,
    backend,
    instructions: DISCOVERY_INSTRUCTIONS,
    input: THE_INPUT,
    clock: fakeClock(),
    ledger: emptyLedger(),
  })
}

describe("discover — the pooling contract at N>1 (CAP-1)", () => {
  test("matrix: parallel fan-out — peak concurrency equals the slot count", async () => {
    const roster = rosterOf(3, THREE_LINEAGES)
    const backend = new ConcurrencyProbe(new FakeBackend(threeSlotScript()))

    const discovered = await discoverWith(backend, roster)

    // All three turns were in flight at once. A sequential stage peaks at 1.
    expect(backend.peak).toBe(3)
    expect(discovered.answered).toBe(3)
    expect(discovered.findings).toHaveLength(3)
  })

  test("matrix: completion order — the pool is ordered by roster slot, not by arrival", async () => {
    const roster = rosterOf(3, THREE_LINEAGES)
    // Completion order is forced to the exact inverse of roster order, by gates
    // rather than by racing timers.
    const backend = new SequencedBackend(new FakeBackend(threeSlotScript()), [
      "discovery-3",
      "discovery-2",
      "discovery-1",
    ])

    const discovered = await discoverWith(backend, roster)

    // Slot 3 answered first and slot 1 last...
    expect(backend.completed).toEqual(["discovery-3", "discovery-2", "discovery-1"])
    // ...and the pool is in roster order regardless.
    expect(discovered.findings.map((f) => f.author)).toEqual([
      "discovery-1",
      "discovery-2",
      "discovery-3",
    ])
    // Ids are allocated in that same order, so they are a function of the roster
    // and not of the network (spine, Ids).
    expect(discovered.findings.map((f) => f.id)).toEqual(["finding-1", "finding-2", "finding-3"])
  })

  test("matrix: independence — every slot gets the identical input and sees no other's findings", async () => {
    const roster = rosterOf(3, THREE_LINEAGES)
    const backend = new RecordingBackend(new FakeBackend(threeSlotScript()))

    const discovered = await discoverWith(backend, roster)

    expect(backend.seen.map((s) => s.slot).sort()).toEqual([
      "discovery-1",
      "discovery-2",
      "discovery-3",
    ])
    // Every slot got EXACTLY the strings the caller passed — not a per-slot
    // variant, not something augmented on the way through.
    //
    // The previous version of this test looped over `discovered.findings` and
    // asserted no turn's input contained another slot's claim. That could not
    // fail: the claims originate in the FakeBackend script and `input` is a
    // constant built once before any turn, so the two strings were unrelated by
    // construction and the assertion held whatever the stage did. Identity
    // against the caller's own values is falsifiable — a stage that appended a
    // "previously reported" section per slot fails here, and that is the leak
    // this row exists to catch (`pipeline-stages.md` §1).
    for (const turn of backend.seen) {
      expect(turn.input).toBe(THE_INPUT)
      expect(turn.instructions).toBe(DISCOVERY_INSTRUCTIONS.text)
    }
    expect(new Set(backend.seen.map((s) => s.input)).size).toBe(1)
    expect(new Set(backend.seen.map((s) => s.instructions)).size).toBe(1)

    // And the findings really were distinct per author, so "identical input"
    // above is not hiding a stage that simply produced nothing.
    expect(new Set(discovered.findings.map((f) => f.claim)).size).toBe(3)
  })

  test("independence is asserted against a leak the stage could actually make", async () => {
    // A backend that ANSWERS FIRST and then inspects what later slots received.
    // Sequenced so slot 1 completes before slots 2 and 3 are handed their input,
    // which is the only ordering in which a leak is even possible.
    const seen: string[] = []
    const inner = new FakeBackend(threeSlotScript())
    const order = ["discovery-1", "discovery-2", "discovery-3"]
    const backend = new SequencedBackend(inner, order)
    const recorder: ModelBackend = {
      capabilities: (slot: string) => backend.capabilities(slot),
      runTurn: async (slot, instructions, input, schema) => {
        const envelope = await backend.runTurn(slot, instructions, input, schema)
        seen.push(input)
        return envelope
      },
    }

    const discovered = await discoverWith(recorder, rosterOf(3, THREE_LINEAGES))

    // Slot 1's claim exists by the time slots 2 and 3 are read, and it is in
    // none of their inputs.
    const first = discovered.findings.find((f) => f.author === "discovery-1")!
    expect(first.claim.length).toBeGreaterThan(0)
    for (const input of seen) expect(input).not.toContain(first.claim)
  })

  test("finding ids are unique across the whole pool", async () => {
    const roster = rosterOf(3, THREE_LINEAGES)
    const twoEach = (slot: string) => ({
      findings: [findingFor(slot), findingFor(slot, `src/${slot}-other.ts`)],
    })
    const discovered = await discoverWith(
      new FakeBackend({
        "discovery-1": [{ kind: "ok", value: twoEach("discovery-1") }],
        "discovery-2": [{ kind: "ok", value: twoEach("discovery-2") }],
        "discovery-3": [{ kind: "ok", value: twoEach("discovery-3") }],
      }),
      roster,
    )

    const ids = discovered.findings.map((f) => f.id)
    expect(ids).toHaveLength(6)
    expect(new Set(ids).size).toBe(6)
  })

  test("the pool is a UNION, not a merge — one defect appears once per model", async () => {
    const roster = rosterOf(3, THREE_LINEAGES)
    // All three report the SAME defect, at the same locus.
    const same = { findings: [findingFor("shared", "src/pay.ts")] }
    const discovered = await discoverWith(
      new FakeBackend({
        "discovery-1": [{ kind: "ok", value: same }],
        "discovery-2": [{ kind: "ok", value: same }],
        "discovery-3": [{ kind: "ok", value: same }],
      }),
      roster,
    )

    // Nothing merged, nothing deduplicated: that is story 3's job (AD-14).
    expect(discovered.findings).toHaveLength(3)
    expect(discovered.findings.every((f) => f.clusterId === undefined)).toBe(true)
    expect(discovered.findings.every((f) => f.coDiscovery === undefined)).toBe(true)
  })

  test("matrix: mixed degradation at N=3 — one clean, one partial, one dead", async () => {
    const roster = rosterOf(3, THREE_LINEAGES)
    const discovered = await discoverWith(
      new FakeBackend({
        "discovery-1": [{ kind: "ok", value: { findings: [findingFor("discovery-1")] } }],
        // Answers, but one item is off-scale on the AD-10 severity scale.
        "discovery-2": [
          {
            kind: "ok",
            value: {
              findings: [
                findingFor("discovery-2"),
                { ...findingFor("discovery-2", "src/bad.ts"), severity: "blocker" },
              ],
            },
          },
        ],
        "discovery-3": [{ kind: "fail", failure: "model-error", message: "gone" }],
      }),
      roster,
    )

    // AD-6a — the partial answer keeps its place in the denominator; the dead
    // model does not.
    expect(discovered.answered).toBe(2)
    expect(discovered.droppedOut).toEqual(["discovery-3"])
    // The partial model keeps its valid item, and slot 1's findings are untouched
    // by slot 2's defect or slot 3's death (AD-6b).
    expect(discovered.findings.map((f) => f.author)).toEqual(["discovery-1", "discovery-2"])

    const codes = discovered.warnings.map((w) => w.code)
    expect(codes).toContain("partial-envelope")
    expect(codes).toContain("model-dropped-out")
    expect(codes).toContain("denominator-reduced")
    expect(
      discovered.warnings.find((w) => w.code === "denominator-reduced")!.detail,
    ).toMatchObject({ answered: 2, requested: 3 })
  })
})
