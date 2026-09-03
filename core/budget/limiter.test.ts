/**
 * AD-15 amended — the accountant's PEAK half.
 *
 * The assertions that matter here MEASURE concurrency rather than asking the
 * limiter what it thinks its limit is: a semaphore that returns the right `max`
 * and admits everyone is exactly the bug this module exists to not have, and it
 * would pass every test that only read a field.
 */

import { describe, expect, test } from "bun:test"

import {
  clampConcurrency,
  createLimiter,
  DEFAULT_MAX_CONCURRENCY,
  MAX_CONCURRENCY,
} from "./limiter.ts"

/** A promise plus the function that settles it, so a test can hold turns open. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe("clampConcurrency — the bound is tested, not trusted", () => {
  test("absent and NaN take the DEFAULT, never 'unlimited'", () => {
    // The difference from `clampTokenCap`, and the reason this is written out
    // rather than pointed at: absence of a token budget is a coherent request,
    // absence of a concurrency limit is the twenty-simultaneous-sessions state
    // this module exists to remove.
    expect(clampConcurrency(undefined)).toBe(DEFAULT_MAX_CONCURRENCY)
    expect(clampConcurrency(null)).toBe(DEFAULT_MAX_CONCURRENCY)
    expect(clampConcurrency(Number.NaN)).toBe(DEFAULT_MAX_CONCURRENCY)
    expect(clampConcurrency("4" as unknown as number)).toBe(DEFAULT_MAX_CONCURRENCY)
  })

  test("ZERO AND NEGATIVE BECOME ONE — a limit of zero would deadlock the run", () => {
    // Not the default, and above all not zero: zero permits no turn ever, which
    // is the one answer that turns a resource bound into a hang.
    expect(clampConcurrency(0)).toBe(1)
    expect(clampConcurrency(-1)).toBe(1)
    expect(clampConcurrency(-Infinity)).toBe(1)
  })

  test("Infinity lands on the MAXIMUM, not on the default", () => {
    // An explicit request for more is honoured up to the ceiling, rather than
    // quietly becoming the default — the same call `clampDiscoverySlots` makes.
    expect(clampConcurrency(Infinity)).toBe(MAX_CONCURRENCY)
    expect(clampConcurrency(10_000)).toBe(MAX_CONCURRENCY)
  })

  test("fractions floor — 2.9 turns in flight is 2", () => {
    expect(clampConcurrency(2.9)).toBe(2)
    expect(clampConcurrency(1.5)).toBe(1)
  })

  test("a limiter clamps its own construction argument", () => {
    // So a caller cannot route around the clamp by constructing directly.
    expect(createLimiter(0).max).toBe(1)
    expect(createLimiter(Number.NaN).max).toBe(DEFAULT_MAX_CONCURRENCY)
    expect(createLimiter(10_000).max).toBe(MAX_CONCURRENCY)
  })
})

describe("createLimiter — `inFlight` is the limiter's own count, not an observer's", () => {
  test("the limiter's own `inFlight` never exceeds `max`, and settles at zero", async () => {
    // Added by the code review of 2026-08-31. Every peak-concurrency assertion in
    // `core/run/run-control.test.ts` reads `FakeBackend.peakInFlight` — a SECOND,
    // independent notion of "in flight", incremented after `calls.push` and
    // decremented in a `finally` around the fake's own hook. It agrees with the
    // limiter's slot only by coincidence of the current call graph, and could
    // drift from it with no test noticing, which would leave the story's central
    // bound measured by something that is not the bound.
    const limiter = createLimiter(3)
    let observed = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const running = Array.from({ length: 12 }, () =>
      limiter.run(async () => {
        // Sampled from INSIDE a running task, which is the only moment the
        // number is meaningful.
        observed = Math.max(observed, limiter.inFlight)
        await gate
      }),
    )

    // Let the first batch reach the sampling line before anything is released.
    await Promise.resolve()
    expect(limiter.inFlight).toBeLessThanOrEqual(3)
    expect(limiter.inFlight).toBeGreaterThan(0)

    release!()
    await Promise.all(running)

    expect(observed).toBeLessThanOrEqual(3)
    // Nothing is leaked: a slot not returned would strand the next fan-out
    // forever, and that is a hang rather than a failed assertion in production.
    expect(limiter.inFlight).toBe(0)
  })
})

describe("createLimiter — what is actually in flight", () => {
  test("NEVER MORE THAN `max` RUN AT ONCE, measured", async () => {
    const limiter = createLimiter(2)
    const gates = [deferred(), deferred(), deferred(), deferred(), deferred()]
    let inFlight = 0
    let peak = 0

    const all = Promise.all(
      gates.map((gate) =>
        limiter.run(async () => {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          await gate.promise
          inFlight -= 1
        }),
      ),
    )

    // Nothing is released yet, so whatever got in is the whole first wave. Two
    // turns of the microtask queue is more than `acquire`'s fast path needs, and
    // an unbounded limiter would already have admitted all five.
    await Promise.resolve()
    await Promise.resolve()
    expect(peak).toBe(2)

    for (const gate of gates) gate.resolve()
    await all
    expect(peak).toBe(2)
    expect(limiter.inFlight).toBe(0)
  })

  test("THE SLOT IS TRANSFERRED, so a fresh caller cannot slip in past the bound", async () => {
    // The hole in the obvious implementation: release decrements, the woken
    // waiter resumes on a LATER microtask, and a caller arriving in between
    // takes the slot the waiter is about to take too. The bound is then exceeded
    // by one per hand-off — silently, and only under load.
    const limiter = createLimiter(1)
    const first = deferred()
    const second = deferred()
    let peak = 0
    let inFlight = 0

    const track = async (gate: Promise<void>): Promise<void> => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await gate
      inFlight -= 1
    }

    const a = limiter.run(() => track(first.promise))
    const waiter = limiter.run(() => track(second.promise))
    await Promise.resolve()

    // Release the first, then IMMEDIATELY queue a third before the woken waiter
    // has had its microtask.
    first.resolve()
    const late = limiter.run(() => track(second.promise))
    await Promise.resolve()
    await Promise.resolve()

    expect(peak).toBe(1)
    second.resolve()
    await Promise.all([a, waiter, late])
    expect(peak).toBe(1)
  })

  test("A REJECTION RELEASES THE SLOT — a limiter never becomes why a run stopped", async () => {
    const limiter = createLimiter(1)
    await expect(
      limiter.run(() => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom")
    // If the slot leaked, this would hang rather than fail — which is why the
    // assertion is that the NEXT call completes at all.
    await expect(limiter.run(async () => "fine")).resolves.toBe("fine")
    expect(limiter.inFlight).toBe(0)
  })

  test("results are returned to their own callers, in their own order", async () => {
    // The limiter is wrapped around individual turns inside a `Promise.all`, and
    // every stage's "resolves POSITIONALLY" contract depends on this staying
    // true: waiting changes WHEN a turn runs, never WHOSE result it is.
    const limiter = createLimiter(2)
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        limiter.run(async () => {
          await new Promise((r) => setTimeout(r, (6 - n) % 3))
          return n
        }),
      ),
    )
    expect(results).toEqual([1, 2, 3, 4, 5])
  })

  test("a limit at or above the fan-out is the same as no limit", async () => {
    // The property that lets every pre-story-7A test keep its behaviour: the
    // limiter only ever costs wall-clock, and only when it binds.
    const limiter = createLimiter(MAX_CONCURRENCY)
    const gates = [deferred(), deferred(), deferred()]
    let started = 0
    const all = Promise.all(
      gates.map((gate) =>
        limiter.run(async () => {
          started += 1
          await gate.promise
        }),
      ),
    )
    await Promise.resolve()
    expect(started).toBe(3)
    for (const gate of gates) gate.resolve()
    await all
  })
})
