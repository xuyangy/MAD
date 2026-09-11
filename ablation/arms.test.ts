import { describe, expect, test } from "bun:test"

import { usageIsComplete } from "../core/budget/ledger.ts"
import { createLateUsageSink, type LateUsageSink } from "../core/ports/late-usage.ts"
import { FakeBackend, candidate, fakeChange, fakeClock, tokens } from "../core/test-support/fakes.ts"
import { runAblation, runArm, type ArmSpec } from "./arms.ts"

/**
 * STORY 2.3, AC2 — THE JOIN, WHICH IS THE HALF THAT WAS MISSING.
 *
 * The adapter reports a late bill into a `LateUsageSink` and `review()` drains
 * one. Both ends shipped tested and mutation-verified on 2026-09-11, and NOTHING
 * CONSTRUCTED A SINK outside the two test files that exercise each end alone —
 * `createLateUsageSink` had no production caller, so every late bill in every
 * live arm was dropped and AC2's recovery ran nowhere.
 *
 * That is the third defect of this exact shape in one story (the turn-level stop
 * gate and the in-loop `governor.observe` were the other two), so this file
 * tests the JOIN rather than either end: the object the backend is handed and the
 * object `review()` drains must be one object, and a test that cannot fail when
 * they are two is not a test of anything.
 */

const SPEC: ArmSpec = { id: "a", label: "arm a", provenance: "scripted", slots: 1 }

/** Discovery's turn answers, and the host reports no usage for it. */
function unknownOnDiscovery(): FakeBackend {
  return new FakeBackend({
    "discovery-1": [
      { kind: "fail", failure: "model-error", usageUnknown: "the host reported no usage" },
    ],
  })
}

function deps(over: Record<string, unknown> = {}) {
  return {
    backend: undefined as never,
    clock: fakeClock(),
    change: fakeChange(),
    candidates: [candidate("anthropic", "claude-sonnet-4-5")],
    providerConfigKey: "provider",
    ...over,
  }
}

describe("runArm — the late-usage sink reaches BOTH the backend and review() (AC2)", () => {
  test("A REPORT INTO THE SINK `backendFor` WAS HANDED LANDS IN THE RECORD", async () => {
    // The whole claim, end to end and with nothing planted on the record. The
    // sink is captured from the argument `runArm` passes to `backendFor` — the
    // only place a backend can get one — and the late bill is reported into THAT
    // object. If `runArm` handed `review()` a different sink (or none), the
    // report would sit in a queue nobody drains and the unknown would survive.
    //
    // Reporting at construction rather than mid-turn is faithful, not a
    // shortcut: `createLateUsageSink` queues until the drain, and the drain is
    // the only ordering AC2 fixes. A provider that answers late may answer at any
    // point before the record closes.
    let captured: LateUsageSink | undefined
    const run = await runArm(
      SPEC,
      deps({
        backendFor: (_spec: ArmSpec, lateUsage: LateUsageSink) => {
          captured = lateUsage
          lateUsage.report({ executionId: "exec-1", tokens: tokens(7, 11) })
          return unknownOnDiscovery()
        },
      }),
    )

    expect(captured).toBeDefined()
    // The unknown was recovered into a counted turn, so the run can state its
    // spend instead of disclosing that it cannot.
    expect(run.record.ledger.unknownUsage.some((u) => u.executionId === "exec-1")).toBe(false)
    const recovered = run.record.ledger.entries.find(
      (entry) => entry.tokens.input === 7 && entry.tokens.output === 11,
    )
    expect(recovered).toBeDefined()
  })

  test("THE ASSERTION ABOVE CAN FAIL — a sink of its own recovers nothing", async () => {
    // The non-vacuity proof, and it is the mutation this file exists for. Same
    // run, same report, same execution id — reported into a sink `runArm` never
    // sees, which is precisely the state the tree shipped in. The unknown
    // survives, the run says its usage is incomplete, and no entry carries the
    // late figure.
    const orphan = createLateUsageSink()
    const run = await runArm(
      SPEC,
      deps({
        backendFor: () => {
          orphan.report({ executionId: "exec-1", tokens: tokens(7, 11) })
          return unknownOnDiscovery()
        },
      }),
    )

    expect(run.record.ledger.unknownUsage.some((u) => u.executionId === "exec-1")).toBe(true)
    expect(usageIsComplete(run.record.ledger)).toBe(false)
    expect(
      run.record.ledger.entries.some((entry) => entry.tokens.input === 7 && entry.tokens.output === 11),
    ).toBe(false)
    // And the orphan still holds it, which is what "dropped" looks like from the
    // inside: nothing threw, nothing was logged, the number simply never arrived.
    expect(orphan.drain()).toHaveLength(1)
  })

  test("ONE SINK PER ARM — arm b never drains a report arm a's provider sent", async () => {
    // `reconcileLateUsage` matches on `executionId`, and the real backend mints
    // those from a PER-INSTANCE counter — so two arms both mint `exec-1`. A sink
    // shared across arms would let arm a's late bill be reconciled into arm b's
    // ledger, which is a fabricated number wearing a real one's clothes. Pinned
    // here because the cheap implementation (one sink per experiment, built in
    // `live.ts`) is the one that gets this wrong.
    const sinks: LateUsageSink[] = []
    const runs = await runAblation(
      [SPEC, { id: "b", label: "arm b", provenance: "scripted" as const, slots: 1 }],
      deps({
        backendFor: (spec: ArmSpec, lateUsage: LateUsageSink) => {
          sinks.push(lateUsage)
          // ONLY arm a's provider answers late.
          if (spec.id === "a") lateUsage.report({ executionId: "exec-1", tokens: tokens(7, 11) })
          return unknownOnDiscovery()
        },
      }),
    )

    expect(sinks).toHaveLength(2)
    expect(sinks[0]).not.toBe(sinks[1])

    const [a, b] = runs
    expect(a!.record.ledger.unknownUsage.some((u) => u.executionId === "exec-1")).toBe(false)
    // Arm b minted the same id and nobody reported for it, so it stays unknown.
    expect(b!.record.ledger.unknownUsage.some((u) => u.executionId === "exec-1")).toBe(true)
    expect(
      b!.record.ledger.entries.some((entry) => entry.tokens.input === 7 && entry.tokens.output === 11),
    ).toBe(false)
  })

  test("an arm whose provider never answers late is unchanged — the unknown stays unknown", async () => {
    // AD-16 and AC1 together: wiring the sink must not invent a number for a
    // turn nobody reported. An empty drain reconciles nothing.
    const run = await runArm(SPEC, deps({ backendFor: () => unknownOnDiscovery() }))

    expect(usageIsComplete(run.record.ledger)).toBe(false)
    expect(run.record.ledger.unknownUsage.length).toBeGreaterThan(0)
  })

  test("the `deps.backend` path still works — a fixed backend gets no sink and needs none", async () => {
    // `backendFor` is optional and the scripted path may pass one backend. It
    // was built by somebody else and cannot be handed a per-run sink, so the
    // sink `runArm` mints reaches `review()` and drains empty. Asserted so the
    // branch is not quietly broken by a future change to the signature.
    const run = await runArm(SPEC, deps({ backend: unknownOnDiscovery() }))

    expect(run.record.ledger.unknownUsage.length).toBeGreaterThan(0)
    expect(run.record.runId).toBeDefined()
  })
})
