/**
 * B1 — the progress snapshots a review hands its sink, driven through the real
 * `review()` seam.
 */

import { describe, expect, test } from "bun:test"

import { spentTokens, unknownUsageCount } from "../budget/ledger.ts"
import type { Clock } from "../ports/clock.ts"
import { createLateUsageSink } from "../ports/late-usage.ts"
import { reportProgress, type ProgressSink, type ProgressSnapshot } from "../ports/progress.ts"
import { selectRoster } from "../roster/select.ts"
import { candidate, fakeChange, fakeClock, FakeBackend, tokens, type SlotStep } from "../test-support/fakes.ts"
import { continueReview, prepareReview, review } from "./review.ts"

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

const DEBATE_ABSTENTION: SlotStep = { kind: "ok", value: { turns: [] } }

function run(discovery: SlotStep = { kind: "ok", value: ENVELOPE }) {
  const resolved = selectRoster([candidate("anthropic", "claude-sonnet-4-5")], {
    slots: 1,
    lenses: [],
    providerConfigKey: "provider",
  })
  return {
    roster: resolved.roster,
    backend: new FakeBackend({ "discovery-1": [discovery, DEBATE_ABSTENTION] }),
    clock: fakeClock(),
    change: fakeChange(),
    priorWarnings: resolved.warnings,
  }
}

function collecting(): { sink: ProgressSink; seen: ProgressSnapshot[] } {
  const seen: ProgressSnapshot[] = []
  return { sink: { report: (snapshot) => seen.push(snapshot) }, seen }
}

/** A clock that moves one second on every read, so elapsed time is visible. */
function steppingClock(): Clock {
  let reads = 0
  let ids = 0
  return {
    now: () => new Date(Date.UTC(2026, 10, 18, 0, 0, reads++)).toISOString(),
    id: (prefix) => `${prefix}-${(ids += 1)}`,
  }
}

describe("B1 — progress snapshots from review()", () => {
  test("one running snapshot per stage, in order, then one final snapshot", async () => {
    const { sink, seen } = collecting()
    const { record } = await review({ ...run(), progress: sink })

    expect(seen.map((s) => `${s.stage}:${s.state}`)).toEqual([
      "discover:running",
      "cluster:running",
      "route:running",
      "debate:running",
      "judge:running",
      "output:running",
      "output:finished",
    ])
    expect(new Set(seen.map((s) => s.runId))).toEqual(new Set([record.runId]))
  })

  test("the final snapshot carries the record's totals and its elapsed time ends at finishedAt", async () => {
    const { sink, seen } = collecting()
    const { record } = await review({ ...run(), clock: steppingClock(), progress: sink })

    const last = seen.at(-1)!
    expect(last.observedTokens).toBe(spentTokens(record.ledger.total))
    expect(last.observedTokens).toBeGreaterThan(0)
    expect(last.unknownUsageTurns).toBe(unknownUsageCount(record.ledger))
    expect(last.cap).toBe(record.ledger.cap)
    expect(last.elapsedMs).toBe(Date.parse(record.finishedAt!) - Date.parse(record.startedAt))

    // The first snapshot is taken before any turn, so it has spent nothing.
    expect(seen[0]!.observedTokens).toBe(0)
    // Running snapshots read the clock themselves, so elapsed time grows.
    const running = seen.filter((s) => s.state === "running").map((s) => s.elapsedMs!)
    expect(running).toEqual([...running].sort((a, b) => a - b))
    expect(running.at(-1)!).toBeGreaterThan(running[0]!)
  })

  test("the final snapshot is taken after late usage is reconciled", async () => {
    const lateUsage = createLateUsageSink()
    lateUsage.report({ executionId: "exec-1", tokens: tokens(7, 11) })
    const { sink, seen } = collecting()
    const { record } = await review({
      ...run({ kind: "ok", value: ENVELOPE, usageUnknown: "the host reported no usage" }),
      lateUsage,
      progress: sink,
    })

    const outputRunning = seen.find((s) => s.stage === "output" && s.state === "running")!
    const last = seen.at(-1)!
    // Before the drain the discovery turn was unknown; after it, it is counted.
    expect(outputRunning.unknownUsageTurns).toBe(1)
    expect(last.unknownUsageTurns).toBe(0)
    expect(record.ledger.unknownUsage).toEqual([])
    expect(last.observedTokens).toBe(spentTokens(record.ledger.total))
    expect(last.observedTokens).toBe(outputRunning.observedTokens + spentTokens(tokens(7, 11)))
  })

  test("a stopped run ends with a stopped snapshot", async () => {
    const controller = new AbortController()
    controller.abort()
    const { sink, seen } = collecting()
    const { record } = await review({ ...run(), signal: controller.signal, progress: sink })

    expect(record.cancelled).toBeDefined()
    expect(seen.at(-1)).toMatchObject({ stage: "output", state: "stopped", observedTokens: 0 })
    expect(seen.filter((s) => s.state !== "running")).toHaveLength(1)
  })

  test("a sink that throws changes nothing in the record or the report", async () => {
    const plain = await review(run())
    let calls = 0
    const throwing: ProgressSink = {
      report: () => {
        calls += 1
        throw new Error("host gone")
      },
    }
    const observed = await review({ ...run(), progress: throwing })

    expect(calls).toBe(7)
    expect(observed.rendered).toBe(plain.rendered)
    expect(observed.record).toEqual(plain.record)
  })

  test("an unparsable clock gives a null elapsed time, not a number", async () => {
    const { sink, seen } = collecting()
    const clock: Clock = { now: () => "not a time", id: (prefix) => `${prefix}-1` }
    await review({ ...run(), clock, progress: sink })

    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((s) => s.elapsedMs === null)).toBe(true)
  })

  test("a prepared review continued separately takes the sink from each half's deps", async () => {
    const first = collecting()
    const second = collecting()
    const prepared = await prepareReview({ ...run(), progress: first.sink })
    await continueReview(prepared, { ...run(), progress: second.sink })

    expect(first.seen.map((s) => s.stage)).toEqual(["discover", "cluster"])
    expect(second.seen.map((s) => `${s.stage}:${s.state}`)).toEqual([
      "route:running",
      "debate:running",
      "judge:running",
      "output:running",
      "output:finished",
    ])
  })
})

describe("B1 — reportProgress", () => {
  test("no sink is a no-op, and a throwing sink is swallowed", () => {
    const snapshot: ProgressSnapshot = {
      runId: "run-1",
      stage: "discover",
      state: "running",
      elapsedMs: 0,
      observedTokens: 0,
      unknownUsageTurns: 0,
      cap: null,
    }
    expect(() => reportProgress(undefined, snapshot)).not.toThrow()
    expect(() =>
      reportProgress(
        {
          report: () => {
            throw new Error("boom")
          },
        },
        snapshot,
      ),
    ).not.toThrow()
  })
})
