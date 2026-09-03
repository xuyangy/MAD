/**
 * Story 7A — CANCELLATION AND PEAK CONCURRENCY, driven through the real
 * `review()` seam.
 *
 * These are deliberately pipeline tests rather than stage tests. Both properties
 * are about the RUN: "no further turns are issued" is a claim about every stage
 * after the stop, and "at most N in flight" is a claim about one limiter shared
 * by all of them. A per-stage test can pass on all three stages while the
 * assembly threads the wrong object into one of them, which is the failure mode
 * this file exists to catch.
 *
 * The assertions COUNT BACKEND CALLS rather than reading a message. A run that
 * says "cancelled" in its report while still billing turns is precisely the
 * failure AD-6(f) is about, and only the call count can tell the two apart.
 */

import { describe, expect, test } from "bun:test"

import { DEFAULT_MAX_CONCURRENCY, MAX_CONCURRENCY } from "../budget/limiter.ts"
import { selectRoster } from "../roster/select.ts"
import {
  candidate,
  fakeChange,
  fakeClock,
  FakeBackend,
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

/** A second, different finding, so a run can produce more than one room. */
const OTHER_ENVELOPE = {
  findings: [
    {
      claim: "The retry loop has no ceiling and can spin forever.",
      reasoning: "A transient failure becomes an infinite loop.",
      severity: "critical",
      file: "src/retry.ts",
      startLine: 30,
    },
  ],
}

const DEBATE_ABSTENTION: SlotStep = { kind: "ok", value: { turns: [] } }

function scripts(...envelopes: unknown[]): Record<string, SlotScript> {
  const out: Record<string, SlotScript> = {}
  envelopes.forEach((value, index) => {
    out[`discovery-${index + 1}`] = [{ kind: "ok", value }, DEBATE_ABSTENTION]
  })
  return out
}

function roster(slots: number, lenses: readonly string[] = []) {
  const models: [string, string][] = [
    ["anthropic", "claude-sonnet-4-5"],
    ["openai", "gpt-5"],
    ["google", "gemini-2.5-pro"],
    ["meta", "llama-4"],
    ["mistral", "mistral-large"],
    ["xai", "grok-4"],
  ]
  return selectRoster(
    models.map(([p, m]) => candidate(p, m)),
    { slots, lenses, providerConfigKey: "provider" },
  )
}

describe("AD-6f — a run the user stopped", () => {
  test("ALREADY ABORTED: not one turn is issued, and the run still renders", async () => {
    const resolved = roster(3)
    const backend = new FakeBackend(scripts(ENVELOPE, ENVELOPE, ENVELOPE))
    const controller = new AbortController()
    controller.abort()

    const { record, rendered } = await review({
      roster: resolved.roster,
      backend,
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
      signal: controller.signal,
    })

    // THE ASSERTION THAT MATTERS. Everything else here is about how it is
    // reported; this is whether it happened.
    expect(backend.calls).toHaveLength(0)
    expect(record.ledger.entries).toHaveLength(0)

    // AD-6f — it reports where it stopped, and it is not silent.
    expect(record.cancelled).toEqual({ stage: "discover" })
    expect(record.warnings.some((w) => w.code === "run-cancelled")).toBe(true)

    // AD-6 — and it is not dressed up as a clean review.
    expect(record.answered).toBe(0)
    expect(rendered).toContain("RUN CANCELLED")
    expect(rendered).toContain("PARTIAL review")

    // AD-6f — AND IT DOES NOT BLAME THE MODELS (code review 2026-08-31). This
    // assertion used to read `toContain("NO MODEL ANSWERED")`, and it was the
    // review's single worst finding: story 2's sentence for an empty roster is
    // "Every slot in the roster failed or dropped out; nothing was examined. See
    // the warnings above for which models failed and why." Printed over a run the
    // user stopped, three lines under a `run-cancelled` warning that says in as
    // many words that no model failed, that is the report contradicting itself —
    // and the half a reader reaches later blames three providers that were
    // working and sends them to warnings that name none. It is the exact false
    // degradation report this whole story exists to remove, and the test asserted
    // it rather than catching it. Both halves are pinned now: the true sentence
    // is present and the false one CANNOT come back.
    expect(rendered).toContain("NOTHING WAS EXAMINED — you stopped this run before any model answered.")
    expect(rendered).toContain("No model failed and no model was retried")
    expect(rendered).not.toContain("NO MODEL ANSWERED")
    expect(rendered).not.toContain("failed or dropped out")

    // AD-6f — and the shrunken denominator says WHY it shrank, rather than
    // reading as a roster that under-delivered.
    expect(rendered).toContain("The remaining 3 were never asked: you stopped the run.")
  })

  test("A CANCELLED TURN IS NOT A DROP-OUT: no model is named, and none is retried", async () => {
    const resolved = roster(3)
    const backend = new FakeBackend(scripts(ENVELOPE, ENVELOPE, ENVELOPE))
    const controller = new AbortController()
    controller.abort()

    const { record, rendered } = await review({
      roster: resolved.roster,
      backend,
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
      signal: controller.signal,
    })

    // AD-6b's retry is for a model that FAILED. Retrying a turn the user
    // cancelled spends their money to disobey them — and naming the model in a
    // degradation warning blames a provider that was working fine.
    expect(record.warnings.some((w) => w.code === "model-dropped-out")).toBe(false)
    expect(rendered).not.toContain("MODEL DROPPED OUT")
    for (const slot of resolved.roster.slots) {
      expect(backend.calls.filter((call) => call.slot === slot.slot)).toHaveLength(0)
    }
  })

  test("STOPPED MID-DISCOVERY: the models that answered keep their findings", async () => {
    const resolved = roster(3)
    const controller = new AbortController()
    // Stop while the SECOND slot's turn is in flight, with one turn allowed at a
    // time so the point is deterministic. Slot 1 has already answered; slot 2 is
    // the turn the stop catches; slot 3 is never issued at all.
    let started = 0
    const backend = new FakeBackend(
      scripts(ENVELOPE, OTHER_ENVELOPE, ENVELOPE),
      {},
      {},
      () => {
        started += 1
        if (started === 2) controller.abort()
      },
    )

    const { record } = await review({
      roster: resolved.roster,
      backend,
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
      // One in flight at a time, so the stop lands deterministically after the
      // first turn and before the second is issued.
      maxConcurrency: 1,
      signal: controller.signal,
    })

    // Two turns reached the backend; the third was never issued, which is the
    // core's own refusal doing the work rather than the backend's.
    expect(backend.calls).toHaveLength(2)
    expect(backend.calls.map((c) => c.slot)).toEqual(["discovery-1", "discovery-2"])
    expect(record.answered).toBe(1)
    expect(record.pool).toHaveLength(1)
    // AND NEITHER OF THE TWO WAS RETRIED. A cancelled turn that took AD-6(b)'s
    // retry would show a second attempt for `discovery-2` here.
    expect(backend.calls.filter((c) => c.slot === "discovery-2")).toHaveLength(1)
    expect(record.cancelled).toEqual({ stage: "discover" })
    expect(record.warnings.some((w) => w.code === "model-dropped-out")).toBe(false)
    // AD-6a still fires, and it is honest: fewer models answered. What must NOT
    // happen is a model being named as the cause, and it is not.
    expect(record.warnings.some((w) => w.code === "denominator-reduced")).toBe(true)
  })

  test("THE FIRST STAGE TO STOP IS THE ONE NAMED, not the last", async () => {
    // Every stage after the stop also sees an aborted signal. A last-write-wins
    // field would report `judge` for a run that stopped in `discover` and did
    // nothing at all afterwards.
    const resolved = roster(2)
    const controller = new AbortController()
    controller.abort()

    const { record } = await review({
      roster: resolved.roster,
      backend: new FakeBackend(scripts(ENVELOPE, ENVELOPE)),
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
      signal: controller.signal,
    })

    expect(record.cancelled?.stage).toBe("discover")
    expect(record.warnings.filter((w) => w.code === "run-cancelled")).toHaveLength(1)
  })

  test("STOPPED AFTER DISCOVERY: findings are stranded with a CANCELLATION reason, never a budget one", async () => {
    const resolved = roster(3)
    const controller = new AbortController()
    let started = 0
    const backend = new FakeBackend(
      scripts(ENVELOPE, OTHER_ENVELOPE, ENVELOPE),
      {},
      {},
      () => {
        // Let all three discovery turns answer, then stop on the FIRST turn of
        // whichever stage comes next. One turn at a time, so "the fourth turn"
        // is a place in the pipeline rather than a moment on the clock.
        started += 1
        if (started === 4) controller.abort()
      },
    )

    const { record, rendered } = await review({
      roster: resolved.roster,
      backend,
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
      maxConcurrency: 1,
      signal: controller.signal,
    })

    expect(record.answered).toBe(3)
    // Discovery finished, so it is NOT where the run stopped.
    expect(record.cancelled).toBeDefined()
    expect(record.cancelled!.stage).not.toBe("discover")
    const unresolved = record.findings.filter((f) => f.unresolved)
    expect(unresolved.length).toBeGreaterThan(0)
    for (const finding of unresolved) {
      // AD-6f — "we ran out of money" and "you pressed stop" are different facts,
      // and this is the string a reader actually sees in the UNRESOLVED section.
      expect(finding.unresolved!.reason).toContain("cancelled")
      expect(finding.unresolved!.reason).not.toContain("budget")
    }
    expect(rendered).toContain("UNRESOLVED — YOU DECIDE")
    expect(rendered).not.toContain("BUDGET EXHAUSTED")
  })

  test("STOPPED MID-JUDGE: `stoppedHere` strands the finding and blames no model", async () => {
    // Added by the code review of 2026-08-31. The judge's per-turn cancellation
    // handler `stoppedHere` has FOUR call sites — evidence-extract, fact-check,
    // logic-eval, aggregate — and each guards an `else` that would otherwise call
    // `noteDropOut` and then write a verdict from an interrupted pass.
    // Instrumenting it across all 820 tests gave ZERO hits on that path: the only
    // pipeline cancellation tests stopped in discover or debate, and debate
    // strands every room, so the judge's loop skipped them all before reaching a
    // turn. Remove any one `else if (stoppedHere(...))` and a healthy model is
    // named in a degradation warning while a verdict is written anyway — with
    // every test green. This is the row of the frozen matrix ("Cancel mid-judge")
    // that had no test at all.
    const resolved = roster(3)
    const controller = new AbortController()
    let judgeTurns = 0
    const backend = new FakeBackend(
      // All three agree, so the finding clears the threshold and goes STRAIGHT to
      // the judge rather than to debate — which is how the stop is made to land
      // inside the judge's per-finding loop rather than before it.
      scripts(ENVELOPE, ENVELOPE, ENVELOPE),
      {},
      {},
      (call) => {
        if (call.role === undefined) return
        judgeTurns += 1
        // Let the first judge turn answer, then stop the run mid-finding.
        if (judgeTurns === 1) controller.abort()
      },
    )

    const { record, rendered } = await review({
      roster: resolved.roster,
      backend,
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
      threshold: 0.5,
      maxConcurrency: 1,
      signal: controller.signal,
    })

    expect(record.cancelled).toEqual({ stage: "judge" })
    const unresolved = record.findings.filter((f) => f.unresolved)
    expect(unresolved.length).toBeGreaterThan(0)
    for (const finding of unresolved) {
      expect(finding.unresolved!.reason).toContain("cancelled")
      expect(finding.unresolved!.reason).not.toContain("budget")
      // A finding the stop caught mid-judging has no verdict. A verdict assembled
      // out of an interrupted pass is a DECIDED finding on the page, which is the
      // "renders like a finished one" failure applied one finding at a time.
      expect(finding.verdict).toBeUndefined()
    }
    // AD-2 amended — and the model that was answering when the user stopped is
    // not reported as having dropped out.
    expect(record.warnings.some((w) => w.code === "model-dropped-out")).toBe(false)
    expect(rendered).not.toContain("BUDGET EXHAUSTED")
    // The JUDGE summary splits the two causes rather than calling every
    // undecided finding a budget casualty.
    if (record.judgeCounts !== undefined && record.judgeCounts.unresolved > 0) {
      expect(rendered).toContain("left undecided when you stopped the run")
      expect(rendered).not.toMatch(/\d+ stranded by the budget/)
    }
  })

  test("BUDGET FIRST, THEN STOPPED: the budget keeps the blame — one cause per finding", async () => {
    // The frozen matrix row "One cause per finding", which had no test. A finding
    // already stranded by the budget must KEEP the budget reason; cancellation
    // must never overwrite an existing `unresolved` (AD-7 is append-only). The
    // code review of 2026-08-31 also made the two stages agree on which cause
    // wins when both are true — first to latch, which here is the budget.
    const resolved = roster(3)
    const controller = new AbortController()
    let turns = 0
    const backend = new FakeBackend(scripts(ENVELOPE, OTHER_ENVELOPE, ENVELOPE), {}, {}, () => {
      turns += 1
      // Stop the run well after the tiny cap has already been exhausted.
      if (turns === 4) controller.abort()
    })

    const { record, rendered } = await review({
      roster: resolved.roster,
      backend,
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
      // Small enough that the budget runs out before judging finishes.
      tokenCap: 1,
      maxConcurrency: 1,
      signal: controller.signal,
    })

    const stranded = record.findings.filter((f) => f.unresolved)
    for (const finding of stranded) {
      // Whichever cause claimed it, it claimed it ONCE. The failure this guards
      // is a reason string carrying both, or the later cause overwriting the
      // earlier one.
      const reason = finding.unresolved!.reason
      const namesBudget = reason.includes("budget")
      const namesStop = reason.includes("cancelled")
      expect(namesBudget || namesStop).toBe(true)
      expect(namesBudget && namesStop).toBe(false)
    }
    expect(rendered).toContain("UNRESOLVED — YOU DECIDE")
  })

  test("STOPPED WHERE NO STAGE NEEDS A TURN: it still does not render as finished", async () => {
    // THE BACKSTOP, and the hole it closes (code review 2026-08-31). Until
    // `review()` read the signal itself, `record.cancelled` came only from a
    // stage REPORTING that it had skipped or received a cancelled turn — and a
    // stage can only report a stop it had a turn left to refuse. Here discovery
    // raises NOTHING, so debate breaks on `open.length === 0` before its
    // cancellation gate and the judge's gate sits inside a per-finding loop that
    // never runs. No stage reported anything, `record.cancelled` stayed
    // `undefined`, and a run the user stopped rendered as a clean, finished
    // review with header, warning, title and metadata all silent.
    const resolved = roster(3)
    const controller = new AbortController()
    let turns = 0
    const empty = { findings: [] }
    const backend = new FakeBackend(scripts(empty, empty, empty), {}, {}, () => {
      turns += 1
      // Abort AFTER the last discovery turn has answered, not during it. The
      // hook runs before the answer, so aborting inline would cancel that very
      // turn and let discovery report the stop — which is the path that already
      // has tests. Deferring to a macrotask puts the stop in the gap between
      // discovery finishing and debate starting: exactly where no stage has a
      // turn left to refuse, and exactly where the old code went silent.
      //
      // A few microtask ticks deep, deliberately. A `setTimeout` is a MACROtask
      // and the rest of `review()` is all microtasks, so it would not fire until
      // after the run had already returned — no stop at all. Aborting inline, or
      // one tick deep, lands before the fake re-checks the signal and cancels
      // this very turn instead. Three ticks puts it after discovery's last turn
      // has answered and while the pipeline is still running.
      if (turns === 3) {
        void Promise.resolve()
          .then()
          .then()
          .then(() => controller.abort())
      }
    })

    const { record, rendered } = await review({
      roster: resolved.roster,
      backend,
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
      maxConcurrency: 1,
      signal: controller.signal,
    })

    expect(record.answered).toBe(3)
    expect(record.findings).toHaveLength(0)
    // All three places the story promised, over a stop no stage could report.
    expect(record.cancelled).toBeDefined()
    expect(record.warnings.some((w) => w.code === "run-cancelled")).toBe(true)
    expect(rendered).toContain("RUN CANCELLED")
    // And it does not tell the reader the roster failed.
    expect(rendered).not.toContain("NO MODEL ANSWERED")
  })

  test("THE `run-cancelled` WARNING IS RENDERED, not merely recorded", async () => {
    // "Three places, one fact" — header, warning, title. The header was pinned
    // and the title was pinned; the WARNING, the only one of the three a reader
    // meets in the warnings block, was asserted only as a code on the record
    // (code review 2026-08-31).
    const resolved = roster(3)
    const controller = new AbortController()
    controller.abort()

    const { rendered } = await review({
      roster: resolved.roster,
      backend: new FakeBackend(scripts(ENVELOPE, ENVELOPE, ENVELOPE)),
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
      signal: controller.signal,
    })

    expect(rendered).toContain("WARNINGS — this run is degraded")
    expect(rendered).toContain("[discover/run-cancelled]")
    expect(rendered).toContain("No model failed, and no model was retried after you stopped.")
  })

  test("STOPPED BETWEEN DEBATE ROUNDS: the next round is not issued, and not counted", async () => {
    // Added by the code review of 2026-08-31. `debate.ts`'s round-level gate —
    // `if (signal?.aborted) { cancelled = true; break }`, sitting above
    // `rounds += 1` — got ZERO hits across the whole suite: the existing test's
    // stop lands INSIDE round 1, never between rounds. Delete the gate and a run
    // stopped after round 1 enters round 2, counting a round it never ran and a
    // batch of turns no backend ever saw, and the warning reads "after round 2 of
    // 3" — with every test still green.
    const resolved = roster(3)
    const controller = new AbortController()
    let debateTurns = 0
    // Every slot speaks in round 1 so the room stays open into round 2, which is
    // what makes "between rounds" a real place in this run.
    const speak: SlotStep = {
      kind: "ok",
      value: {
        turns: [{ findingId: "f1", position: "upholds", argument: "The cited line says so." }],
      },
    }
    const backend = new FakeBackend(
      {
        "discovery-1": [{ kind: "ok", value: ENVELOPE }, speak, speak],
        "discovery-2": [{ kind: "ok", value: OTHER_ENVELOPE }, speak, speak],
        "discovery-3": [{ kind: "ok", value: ENVELOPE }, speak, speak],
      },
      {},
      {},
      (call) => {
        // Debate turns carry no judge role, and discovery is the first three.
        if (call.role !== undefined) return
        debateTurns += 1
        // Let all of round 1 run, then stop between rounds.
        if (debateTurns === 6) {
          void Promise.resolve()
            .then()
            .then()
            .then(() => controller.abort())
        }
      },
    )

    const { record, rendered } = await review({
      roster: resolved.roster,
      backend,
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
      threshold: 0.99,
      maxRounds: 3,
      maxConcurrency: 1,
      signal: controller.signal,
    })

    if (record.debateCounts !== undefined) {
      // The gate's whole job: a round the run never issued is never counted, and
      // `turns` counts seats that reached a backend rather than seats that were
      // permitted. The record is what the artifact dump serializes for a human.
      expect(record.debateCounts.rounds).toBeLessThanOrEqual(3)
      expect(record.debateCounts.turns).toBeLessThanOrEqual(record.debateCounts.attempts + 6)
    }
    // AD-2 amended — a stop is never a drop-out, in this stage either.
    expect(record.warnings.some((w) => w.code === "model-dropped-out")).toBe(false)
    expect(rendered).not.toContain("BUDGET EXHAUSTED")
  })

  test("NO CANCELLATION, NO NOISE: an un-cancelled run says nothing about stopping", async () => {
    // The negative row, and the one that keeps every other story's report intact.
    const resolved = roster(3)
    const { record, rendered } = await review({
      roster: resolved.roster,
      backend: new FakeBackend(scripts(ENVELOPE, ENVELOPE, ENVELOPE)),
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
      signal: new AbortController().signal,
    })

    expect(record.cancelled).toBeUndefined()
    expect(record.warnings.some((w) => w.code === "run-cancelled")).toBe(false)
    expect(rendered).not.toContain("RUN CANCELLED")
  })

  test("A DEAF BACKEND STILL STOPS: the core refuses to issue, whatever the backend does", async () => {
    // AD-2 amended — "a backend that cannot abort a request in flight still
    // satisfies the port". This one ignores the signal completely; the core's own
    // refusal is what has to do the work.
    const resolved = roster(3)
    const controller = new AbortController()
    let calls = 0
    const deafBackend = {
      capabilities: () => ({ tools: true }),
      async runTurn(slot: string, _instructions: string, _input: string, schema: never) {
        calls += 1
        controller.abort()
        const parsed = (schema as { safeParse(v: unknown): { success: boolean; data?: unknown } }).safeParse(
          ENVELOPE,
        )
        return parsed.success
          ? { ok: true as const, slot, value: parsed.data as never, tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }
          : { ok: false as const, slot, failure: "schema-invalid" as const, message: "no" }
      },
    }

    const { record } = await review({
      roster: resolved.roster,
      backend: deafBackend as never,
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
      maxConcurrency: 1,
      signal: controller.signal,
    })

    // One turn ran and billed — the window the signal narrows but does not close.
    // Everything after it was never issued, which is the guarantee that does not
    // depend on the backend.
    expect(calls).toBe(1)
    expect(record.cancelled).toEqual({ stage: "discover" })
  })
})

describe("AD-15 amended — peak concurrency", () => {
  test("AT MOST `maxConcurrency` TURNS IN FLIGHT, measured across the whole fan-out", async () => {
    // Six pool slots plus two lenses is eight turns in ONE `Promise.all`
    // (`discover.ts` pooling contract 5) — the shape that reaches twenty at the
    // shipped ceilings.
    const resolved = roster(6, ["security", "performance"])
    const script: Record<string, SlotScript> = {}
    for (const slot of [...resolved.roster.slots, ...resolved.roster.lensSlots]) {
      script[slot.slot] = [{ kind: "ok", value: ENVELOPE }, DEBATE_ABSTENTION]
    }
    // Every turn yields before answering, so they overlap in real time rather
    // than each completing before the next begins.
    const backend = new FakeBackend(script, {}, {}, () => new Promise((r) => setTimeout(r, 1)))

    await review({
      roster: resolved.roster,
      backend,
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
      maxConcurrency: 2,
    })

    expect(backend.calls.length).toBeGreaterThanOrEqual(8)
    expect(backend.peakInFlight).toBe(2)
  })

  test("without the limiter this fan-out really does go wide — the test is not vacuous", async () => {
    const resolved = roster(6, ["security", "performance"])
    const script: Record<string, SlotScript> = {}
    for (const slot of [...resolved.roster.slots, ...resolved.roster.lensSlots]) {
      script[slot.slot] = [{ kind: "ok", value: ENVELOPE }, DEBATE_ABSTENTION]
    }
    const backend = new FakeBackend(script, {}, {}, () => new Promise((r) => setTimeout(r, 1)))

    await review({
      roster: resolved.roster,
      backend,
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
      // At the ceiling the limiter cannot bind, which is the same as not having
      // one — so this measures what the previous test prevents.
      maxConcurrency: MAX_CONCURRENCY,
    })

    expect(backend.peakInFlight).toBe(8)
  })

  test("the limiter changes CONCURRENCY and never ORDER", async () => {
    // Pooling contract 3: findings come out in roster order however the network
    // behaved. A limiter that admitted turns out of order would break it
    // silently, because `Promise.all` would still resolve positionally.
    const resolved = roster(3)
    const script: Record<string, SlotScript> = {
      "discovery-1": [{ kind: "ok", value: ENVELOPE }, DEBATE_ABSTENTION],
      "discovery-2": [{ kind: "ok", value: OTHER_ENVELOPE }, DEBATE_ABSTENTION],
      "discovery-3": [{ kind: "ok", value: ENVELOPE }, DEBATE_ABSTENTION],
    }
    const slow = new FakeBackend(script, {}, {}, ({ slot }) =>
      // The FIRST slot answers slowest, so completion order is the reverse of
      // roster order.
      new Promise((r) => setTimeout(r, slot === "discovery-1" ? 4 : 1)),
    )

    const { record } = await review({
      roster: resolved.roster,
      backend: slow,
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
      maxConcurrency: 3,
    })

    expect(record.pool.map((f) => f.author)).toEqual(["discovery-1", "discovery-2", "discovery-3"])
  })

  test("the number in force is the number REPORTED, clamped once", async () => {
    const resolved = roster(1)
    const { record, rendered } = await review({
      roster: resolved.roster,
      backend: new FakeBackend(scripts(ENVELOPE)),
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
      maxConcurrency: 0,
    })

    // 0 clamps to 1 — a limit of zero would deadlock — and the record carries
    // what the run actually used, never what the caller asked for.
    expect(record.ledger.maxConcurrency).toBe(1)
    expect(rendered).toContain("at most 1 model turn(s) in flight at once")
  })

  test("no `maxConcurrency` means the DEFAULT, and there is no unlimited", async () => {
    const resolved = roster(1)
    const { record } = await review({
      roster: resolved.roster,
      backend: new FakeBackend(scripts(ENVELOPE)),
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
    })

    expect(record.ledger.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY)
  })

  test("DETERMINISM: two runs of one input under a BINDING limiter render alike", async () => {
    // A Boundaries requirement of story 7A that had no test (code review
    // 2026-08-31). `limiter.test.ts` checks order-preservation inside a single
    // `Promise.all`, and the test above checks pool ordering for ONE run —
    // neither runs the same input twice and compares the reports. The limiter
    // changes the number of turns in flight; it must change nothing a reader
    // sees, and "nothing a reader sees" is the whole rendered report, not a
    // findings array.
    const render = async (maxConcurrency: number): Promise<string> => {
      const resolved = roster(6)
      const { rendered } = await review({
        roster: resolved.roster,
        backend: new FakeBackend(
          scripts(ENVELOPE, OTHER_ENVELOPE, ENVELOPE, OTHER_ENVELOPE, ENVELOPE, OTHER_ENVELOPE),
        ),
        clock: fakeClock(),
        change: fakeChange(),
        priorWarnings: resolved.warnings,
        maxConcurrency,
      })
      return rendered
    }

    // Two runs at the same binding limit: byte-identical.
    const [first, second] = await Promise.all([render(2), render(2)])
    expect(first).toBe(second)

    // And the limit itself changes only the PEAK line, which is the one line
    // that is about the limit. Everything else — roster, routing, debate, judge,
    // findings, unresolved, tokens — is the same report.
    const wide = await render(MAX_CONCURRENCY)
    const strip = (text: string): string =>
      text
        .split("\n")
        .filter((line) => !line.startsWith("PEAK —"))
        .join("\n")
    expect(strip(first)).toBe(strip(wide))
  })

  test("THE LIMITER IS NOT A GATE: waiting refuses nothing and strands nothing", async () => {
    // `mayISpend` refuses and that is a degradation; the limiter waits and that
    // is backpressure. Conflating them would produce the false report this whole
    // capability exists to remove.
    const resolved = roster(3)
    const { record } = await review({
      roster: resolved.roster,
      backend: new FakeBackend(scripts(ENVELOPE, ENVELOPE, ENVELOPE)),
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
      maxConcurrency: 1,
    })

    expect(record.answered).toBe(3)
    expect(record.findings.every((f) => !f.unresolved)).toBe(true)
    expect(record.warnings.some((w) => w.code === "unresolved-findings")).toBe(false)
    expect(record.warnings.some((w) => w.code === "model-dropped-out")).toBe(false)
  })
})
