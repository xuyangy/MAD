/**
 * AC2 (story 2.3) — "the run waits for no completion it cannot guarantee",
 * asserted as a property of the TYPE rather than of a caller's discipline.
 *
 * The one thing that could go wrong here is subtle and it is what this file is
 * for: a sink whose `drain()` returned a promise would satisfy every functional
 * test written about it and would quietly reintroduce the unbounded wait AC3
 * forbids, because the only correct way to consume a promise is to await it. So
 * the synchronousness is asserted, twice, and from the outside.
 */

import { describe, expect, test } from "bun:test"

import { emptyTokenUsage, type TokenUsage } from "../domain/run-record.ts"
import { createLateUsageSink, type LateUsageReporter } from "./late-usage.ts"

function usage(input: number): TokenUsage {
  return { ...emptyTokenUsage(), input }
}

describe("createLateUsageSink — the sink nothing awaits", () => {
  test("`drain()` IS SYNCHRONOUS — it returns an array, never a promise", () => {
    // The assertion that makes AC2 structural. `instanceof Promise` and the
    // duck-typed `.then` are both checked because a thenable that is not a
    // `Promise` awaits just the same.
    const sink = createLateUsageSink()
    const drained = sink.drain()
    expect(Array.isArray(drained)).toBe(true)
    expect(drained).not.toBeInstanceOf(Promise)
    expect((drained as { then?: unknown }).then).toBeUndefined()
  })

  test("`report()` returns nothing to await either", () => {
    // The write half is called from a non-awaited continuation on an abandoned
    // prompt promise (story 2.3 task 10). A `report` that returned a promise
    // would put a floating promise on that path, and a floating rejection there
    // is an unhandled rejection in a run that has already finished.
    const sink = createLateUsageSink()
    expect(sink.report({ executionId: "exec-1", tokens: usage(5) })).toBeUndefined()
  })

  test("an empty sink drains to an EMPTY ARRAY, not to undefined", () => {
    // Absence spelled one way. A caller passes the result straight to
    // `reconcileLateUsage`, and `[]` is a pass that reconciles nothing rather
    // than a value it has to guard.
    expect(createLateUsageSink().drain()).toEqual([])
  })

  test("it returns what has arrived SO FAR, in arrival order", () => {
    const sink = createLateUsageSink()
    sink.report({ executionId: "exec-1", tokens: usage(1) })
    sink.report({ executionId: "exec-2", tokens: usage(2) })
    expect(sink.drain().map((r) => r.executionId)).toEqual(["exec-1", "exec-2"])
  })

  test("DRAINING TAKES — a second drain does not re-deliver what the first one gave", () => {
    // `reconcileLateUsage` folds a report into `total`, so a report delivered
    // twice would double a real bill. The sink owning the "taken" state means no
    // caller has to remember a cursor.
    const sink = createLateUsageSink()
    sink.report({ executionId: "exec-1", tokens: usage(1) })
    expect(sink.drain()).toHaveLength(1)
    expect(sink.drain()).toEqual([])
  })

  test("a report that arrives AFTER a drain is delivered by the NEXT drain", () => {
    // This is the honest limit of AC2 rather than a bug: usage arriving after
    // the run stamped `finishedAt` is not in that run's record, and the sink
    // does not pretend otherwise — it simply still holds it.
    const sink = createLateUsageSink()
    sink.drain()
    sink.report({ executionId: "exec-9", tokens: usage(9) })
    expect(sink.drain().map((r) => r.executionId)).toEqual(["exec-9"])
  })

  test("the drained array is a COPY — mutating it cannot reach into the sink", () => {
    const sink = createLateUsageSink()
    sink.report({ executionId: "exec-1", tokens: usage(1) })
    const drained = sink.drain()
    drained.push({ executionId: "forged", tokens: usage(999) })
    sink.report({ executionId: "exec-2", tokens: usage(2) })
    expect(sink.drain().map((r) => r.executionId)).toEqual(["exec-2"])
  })

  test("it duplicates nothing and merges nothing — two payloads for one id both arrive", () => {
    // The sink is a queue and not a judge. Deciding that two payloads for one
    // execution disagree is an INTEGRITY question
    // (`evaluation-protocol.md:504-507`) and it is answered by
    // `reconcileLateUsage`, which holds the ledger; a sink that deduplicated by
    // first-seen would be doing exactly what the protocol forbids, one layer
    // too early and invisibly.
    const sink = createLateUsageSink()
    sink.report({ executionId: "exec-1", tokens: usage(10) })
    sink.report({ executionId: "exec-1", tokens: usage(40) })
    expect(sink.drain()).toHaveLength(2)
  })
})

describe("the reporter/sink split — an adapter gets the WRITE HALF ONLY", () => {
  test("a `LateUsageSink` is a `LateUsageReporter`, so the adapter takes the narrow type", () => {
    const sink = createLateUsageSink()
    const reporter: LateUsageReporter = sink
    reporter.report({ executionId: "exec-1", tokens: usage(3) })
    expect(sink.drain()).toHaveLength(1)
  })

  test("A REPORTER CANNOT DRAIN — the narrowing is real and not a naming convention", () => {
    // The whole reason there are two interfaces. `OpencodeBackendOptions` takes
    // a `LateUsageReporter`, so an adapter cannot read the run's recovered usage
    // and cannot clear it — a backend that drained the sink would silently
    // delete usage the record was about to recover, and nothing downstream would
    // ever know a number had existed.
    // THE ASSERTION IS THE `@ts-expect-error`, not the `expect` under it. The
    // object really does have a `drain` at run time — it is the same sink — so
    // no runtime check can state this property. `bun run typecheck` is what
    // fails if the write half ever grows a read.
    const reporter: LateUsageReporter = createLateUsageSink()
    expect(typeof reporter.report).toBe("function")
    // @ts-expect-error — `drain` is deliberately absent from the write half.
    expect(typeof reporter.drain).toBe("function")
  })
})
