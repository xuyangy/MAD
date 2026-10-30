/**
 * CAP-3 — a run MAD stopped itself says so (`core/domain/stop-cause.ts`).
 *
 * The plugin aborts the run with a `MadStop` when a review session's
 * permission rules come back different. Every MAD-authored sentence about the
 * stop then says MAD stopped the run; a stop with any other reason keeps the
 * user's wording byte for byte.
 */

import { describe, expect, test } from "bun:test"

import { MadStop, stopCauseOf } from "../domain/stop-cause.ts"
import { selectRoster } from "../roster/select.ts"
import { candidate, fakeChange, fakeClock, FakeBackend, type SlotScript, type SlotStep } from "../test-support/fakes.ts"
import { ISSUED_TURNS_MAY_BILL, review } from "./review.ts"

const FINDING = {
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
const OTHER = {
  findings: [
    { claim: "The retry loop has no ceiling.", reasoning: "It can spin forever.", severity: "critical", file: "src/retry.ts", startLine: 30 },
  ],
}
const ABSTAIN: SlotStep = { kind: "ok", value: { turns: [] } }
const MAD_STOPPED_THIS = "MAD stopped this run (a review session's permission rules could not be verified)"
const MAD_STOPPED_THE = "MAD stopped the run (a review session's permission rules could not be verified)"

function roster() {
  return selectRoster(
    [candidate("anthropic", "claude-sonnet-4-5"), candidate("openai", "gpt-5"), candidate("google", "gemini-2.5-pro")],
    { slots: 3, lenses: [], providerConfigKey: "provider" },
  )
}

function scripts(...envelopes: unknown[]): Record<string, SlotScript> {
  return Object.fromEntries(envelopes.map((value, i) => [`discovery-${i + 1}`, [{ kind: "ok", value }, ABSTAIN] as SlotScript]))
}

async function run(backend: FakeBackend, signal: AbortSignal, extra: Record<string, unknown> = {}) {
  const resolved = roster()
  return review({
    roster: resolved.roster,
    backend,
    clock: fakeClock(),
    change: fakeChange(),
    priorWarnings: resolved.warnings,
    maxConcurrency: 1,
    signal,
    ...extra,
  })
}

describe("stopCauseOf", () => {
  test("only a MadStop reason is MAD's stop; any other reason, or none, is the user's", () => {
    const mad = new AbortController()
    mad.abort(new MadStop("session-policy"))
    expect(stopCauseOf(mad.signal)).toBe("session-policy")
    const user = new AbortController()
    user.abort()
    expect(stopCauseOf(user.signal)).toBe("user")
    const host = new AbortController()
    host.abort({ cause: "session-policy" })
    expect(stopCauseOf(host.signal)).toBe("user")
    expect(stopCauseOf(undefined)).toBe("user")
  })
})

describe("a run MAD stopped (CAP-3)", () => {
  test("BEFORE ANY TURN: the record carries the cause, and no sentence says the user stopped it", async () => {
    const controller = new AbortController()
    controller.abort(new MadStop("session-policy"))
    const backend = new FakeBackend(scripts(FINDING, FINDING, FINDING))

    const { record, rendered } = await run(backend, controller.signal)

    expect(backend.calls).toHaveLength(0)
    expect(record.cancelled).toEqual({ stage: "discover", cause: "session-policy" })
    expect(rendered).toContain(`RUN CANCELLED — ${MAD_STOPPED_THIS} during the discover stage.`)
    expect(rendered).toContain(`NOTHING WAS EXAMINED — ${MAD_STOPPED_THIS} before any model answered.`)
    expect(rendered).not.toContain("you stopped")
    const warning = record.warnings.find((w) => w.code === "run-cancelled")!
    // MAD's own stop keeps its message, byte for byte.
    expect(warning.message).toBe(
      `RUN CANCELLED: ${MAD_STOPPED_THIS} during the discover stage. It is NOT a finished review — the findings ` +
        "below are what MAD had at that moment, and anything left undecided is in the UNRESOLVED section with the " +
        "stage it stopped at. MAD never prompted the session whose rules differed, started no turn after the stop " +
        "and retried no model. Turns already issued may still have run and been billed.",
    )
    expect(warning.message).not.toContain("No model failed")
    expect(warning.message).not.toContain(ISSUED_TURNS_MAY_BILL)
  })

  test("MID-DISCOVERY: the slots never asked say MAD stopped the run", async () => {
    const controller = new AbortController()
    let started = 0
    const backend = new FakeBackend(scripts(FINDING, FINDING, FINDING), {}, {}, () => {
      started += 1
      if (started === 1) controller.abort(new MadStop("session-policy"))
    })

    const { record, rendered } = await run(backend, controller.signal)

    expect(record.cancelled).toEqual({ stage: "discover", cause: "session-policy" })
    expect(rendered).toContain(`were never asked: ${MAD_STOPPED_THE}.`)
    expect(rendered).not.toContain("you stopped")
  })

  test("IN DEBATE: the stranded rooms say MAD stopped the run", async () => {
    const controller = new AbortController()
    let debateTurns = 0
    const speak: SlotStep = { kind: "ok", value: { turns: [{ findingId: "f1", position: "upholds", argument: "The cited line says so." }] } }
    const backend = new FakeBackend(
      {
        "discovery-1": [{ kind: "ok", value: FINDING }, speak, speak],
        "discovery-2": [{ kind: "ok", value: OTHER }, speak, speak],
        "discovery-3": [{ kind: "ok", value: FINDING }, speak, speak],
      },
      {},
      {},
      (call) => {
        if (call.role !== undefined) return
        debateTurns += 1
        if (debateTurns === 4) controller.abort(new MadStop("session-policy"))
      },
    )

    const { record, rendered } = await run(backend, controller.signal, { threshold: 0.99, maxRounds: 3 })

    expect(record.cancelled).toEqual({ stage: "debate", cause: "session-policy" })
    expect(rendered).toContain(`undecided when ${MAD_STOPPED_THE}`)
    expect(rendered).not.toContain("you stopped")
  })

  test("IN JUDGING: the undecided findings say MAD stopped the run", async () => {
    const controller = new AbortController()
    let judgeTurns = 0
    const backend = new FakeBackend(scripts(FINDING, FINDING, FINDING), {}, {}, (call) => {
      if (call.role === undefined) return
      judgeTurns += 1
      if (judgeTurns === 1) controller.abort(new MadStop("session-policy"))
    })

    const { record, rendered } = await run(backend, controller.signal, { threshold: 0.5 })

    expect(record.cancelled).toEqual({ stage: "judge", cause: "session-policy" })
    expect(rendered).toContain(`left undecided when ${MAD_STOPPED_THE}`)
    expect(rendered).toContain(`were still undecided when ${MAD_STOPPED_THE}.`)
    expect(rendered).not.toContain("you stopped")
  })

  test("A FAILED FIRST ATTEMPT WHOSE RETRY THE STOP CANCELLED: the whole report claims no model failed nowhere", async () => {
    const controller = new AbortController()
    let calls = 0
    const backend = new FakeBackend(
      {
        "discovery-1": [{ kind: "fail", failure: "model-error", message: "provider error" }, { kind: "ok", value: FINDING }],
        "discovery-2": [{ kind: "ok", value: FINDING }],
        "discovery-3": [{ kind: "ok", value: FINDING }],
      },
      {},
      {},
      () => {
        calls += 1
        // The first turn fails; MAD stops the run before the retry.
        if (calls === 1) queueMicrotask(() => controller.abort(new MadStop("session-policy")))
      },
    )

    const { record, rendered } = await run(backend, controller.signal)

    expect(record.answered).toBe(0)
    expect(record.cancelled).toEqual({ stage: "discover", cause: "session-policy" })
    expect(rendered).toContain(`NOTHING WAS EXAMINED — ${MAD_STOPPED_THIS} before any model answered.`)
    expect(rendered).toContain("  The run stopped during the discover stage.")
    expect(rendered).not.toContain("No model failed")
    expect(rendered).not.toContain("you stopped")
  })

  test("THE USER'S STOP: a plain abort keeps the user's wording and records no cause", async () => {
    const controller = new AbortController()
    controller.abort()
    const { record, rendered } = await run(new FakeBackend(scripts(FINDING, FINDING, FINDING)), controller.signal)
    expect(record.cancelled).toEqual({ stage: "discover" })
    expect(rendered).toContain("RUN CANCELLED — you stopped this run during the discover stage.")
    expect(rendered).not.toContain("MAD stopped")
    expect(record.warnings.find((w) => w.code === "run-cancelled")!.message).toContain(
      "MAD started no turn and retried no model after it observed the stop.",
    )
  })

  test("CAP-5 (#160) — THE USER'S STOP AFTER A FAILED FIRST ATTEMPT: no 'No model failed', no exhaustive-warnings claim", async () => {
    const controller = new AbortController()
    let calls = 0
    const backend = new FakeBackend(
      {
        "discovery-1": [{ kind: "fail", failure: "model-error", message: "provider error" }, { kind: "ok", value: FINDING }],
        "discovery-2": [{ kind: "ok", value: FINDING }],
        "discovery-3": [{ kind: "ok", value: FINDING }],
      },
      {},
      {},
      () => {
        calls += 1
        // The first turn fails; the user stops the run before the retry.
        if (calls === 1) queueMicrotask(() => controller.abort())
      },
    )

    const { record, rendered } = await run(backend, controller.signal)

    expect(calls).toBe(1)
    expect(record.answered).toBe(0)
    expect(record.cancelled).toEqual({ stage: "discover" })
    // The failed attempt left no drop-out behind.
    expect(record.warnings.some((w) => w.code === "model-dropped-out")).toBe(false)
    const message = record.warnings.find((w) => w.code === "run-cancelled")!.message
    expect(message).toBe(
      "RUN CANCELLED: you stopped this run during the discover stage. It is NOT a finished review — the findings " +
        "below are what MAD had at that moment, and anything left undecided is in the UNRESOLVED section with the " +
        "stage it stopped at. MAD started no turn and retried no model after it observed the stop. The warnings " +
        "report the model failures MAD recorded; a model whose first attempt failed and whose retry the stop " +
        `cancelled may not be among them. ${ISSUED_TURNS_MAY_BILL}`,
    )
    expect(ISSUED_TURNS_MAY_BILL).toBe("Turns already issued may continue on the host and may be billed.")
    for (const claim of [
      "No model failed",
      "no model failed",
      "every failure",
      "all failures",
      "turns were aborted",
      "were cancelled on the host",
      "stops waiting",
    ]) {
      expect(rendered).not.toContain(claim)
    }
    expect(rendered).toContain("  The run stopped during the discover stage; MAD started no turn and retried no model after it observed the stop.")
  })
})
