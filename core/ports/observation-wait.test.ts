/**
 * Story 2-7c — the shared bounded wait, on its own.
 *
 * Every row here uses a CONTROLLED DEFERRED PROMISE and a tiny deadline. None
 * compares elapsed time against a threshold: a timing comparison passes on a
 * loaded machine for the wrong reason and fails on one for no reason, and what
 * is under test is which branch runs, not how fast.
 */

import { describe, expect, test } from "bun:test"

import {
  awaitObservationWrite,
  OBSERVATION_WRITE_TIMEOUT_MS,
  observationTimeoutReason,
} from "./observation-wait.ts"

/** A promise this file settles by hand, so ordering is stated rather than raced. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, no) => {
    resolve = ok
    reject = no
  })
  return { promise, resolve, reject }
}

describe("awaitObservationWrite", () => {
  test("a write that settles is SETTLED, and the generous deadline never fires", async () => {
    // THE NON-VACUOUS SIBLING. Without it every row below passes on an
    // implementation that timed out unconditionally.
    const outcome = await awaitObservationWrite(async () => undefined, 30_000)
    expect(outcome).toEqual({ kind: "settled" })
  })

  test("a write that rejects is REJECTED, and carries what it rejected with", async () => {
    const boom = new Error("the sink is full")
    const outcome = await awaitObservationWrite(() => Promise.reject(boom), 30_000)
    expect(outcome).toEqual({ kind: "rejected", error: boom })
  })

  test("a write that THROWS SYNCHRONOUSLY is a rejection, not a hang", async () => {
    // A sink that throws before returning its promise has answered. Answering
    // badly is not the same failure as never answering, and folding the two
    // together would report a broken sink as an unresolved one — which is the
    // reading that quarantines a bundle.
    const boom = new Error("no promise for you")
    const outcome = await awaitObservationWrite(() => {
      throw boom
    }, 30_000)
    expect(outcome).toEqual({ kind: "rejected", error: boom })
  })

  test("A WRITE THAT NEVER SETTLES IS TIMED-OUT, which is its own outcome", async () => {
    const outcome = await awaitObservationWrite(() => new Promise<void>(() => {}), 5)
    expect(outcome).toEqual({ kind: "timed-out", ms: 5 })
  })

  test("A LATE RESOLUTION CHANGES NOTHING — the value never comes back", async () => {
    const gate = deferred<void>()
    const outcome = await awaitObservationWrite(() => gate.promise, 5)
    expect(outcome.kind).toBe("timed-out")

    gate.resolve()
    await gate.promise
    // The outcome is a value that was already returned; there is no channel a
    // late settlement could arrive on, which is the property that keeps an
    // abandoned observation incomplete for the run.
    expect(outcome).toEqual({ kind: "timed-out", ms: 5 })
  })

  test("A LATE REJECTION IS CONSUMED — it never surfaces as an unhandled rejection", async () => {
    const seen: unknown[] = []
    const onUnhandled = (event: Event & { reason?: unknown }): void => {
      seen.push(event.reason)
      event.preventDefault()
    }
    globalThis.addEventListener("unhandledrejection", onUnhandled as EventListener)
    try {
      const gate = deferred<void>()
      const outcome = await awaitObservationWrite(() => gate.promise, 5)
      expect(outcome.kind).toBe("timed-out")

      gate.reject(new Error("the sink failed, eventually"))
      // Two microtask drains plus a macrotask: an unhandled rejection is
      // reported at the end of a turn, so it would have landed by here.
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(seen).toEqual([])
    } finally {
      globalThis.removeEventListener("unhandledrejection", onUnhandled as EventListener)
    }
  })

  test("THE TIMER IS CLEARED ON EVERY PATH, including the rejecting one", async () => {
    // Asserted by counting live timers rather than by waiting: an uncleared
    // five-second timer per write would hold the loop open past the end of a
    // run, which no elapsed-time assertion can see.
    const cleared: unknown[] = []
    const realClear = globalThis.clearTimeout
    globalThis.clearTimeout = ((id: never) => {
      cleared.push(id)
      return realClear(id)
    }) as typeof clearTimeout
    try {
      await awaitObservationWrite(async () => undefined, 30_000)
      await awaitObservationWrite(() => Promise.reject(new Error("no")), 30_000)
      await awaitObservationWrite(() => new Promise<void>(() => {}), 5)
      expect(cleared).toHaveLength(3)
    } finally {
      globalThis.clearTimeout = realClear
    }
  })

  test("the shipped bound is five seconds and is the default", async () => {
    expect(OBSERVATION_WRITE_TIMEOUT_MS).toBe(5_000)
  })

  test("the reason names the write, the duration, and what is NOT claimed", () => {
    const reason = observationTimeoutReason("request", 5_000)
    expect(reason).toContain("request")
    expect(reason).toContain("5000ms")
    // The two sentences a reader has to be able to rely on: incomplete, and the
    // physical write may still be running.
    expect(reason).toContain("INCOMPLETE")
    expect(reason).toContain("may still be running")
    expect(reason).toContain("never recorded as having succeeded")
  })
})
