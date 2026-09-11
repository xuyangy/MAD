/**
 * Story 2.3, task 1 — THE TEST SEAM, TESTED.
 *
 * This file exists because of a specific way a test suite can lie. The failure
 * mode story 2.3 removes is a FABRICATED ZERO, and a test written against a fake
 * that also fabricates a zero passes while the mechanism it is about is wrong.
 * `FakeBackend` fabricated one on every path until this story: each `fail`
 * variant attached `tokens: tokens()` unconditionally, so a turn with ABSENT
 * usage was not scriptable and nothing downstream of it was testable.
 *
 * So the seam gets its own assertions, and they are about ABSENCE — `"tokens" in
 * envelope`, never `expect(envelope.tokens).toBeFalsy()`, which passes on both of
 * the two states this story separates. Nothing else in the suite can check this:
 * every other test asserts what a STAGE did with the envelope, and a fake that
 * quietly supplied a number would make all of those pass.
 */

import { describe, expect, test } from "bun:test"
import { z } from "zod"

import { FakeBackend } from "./fakes.ts"

const SCHEMA = z.object({ claim: z.string() })
const VALID = { claim: "off-by-one in the retry loop" }

describe("FakeBackend — a turn with ABSENT usage is scriptable at all", () => {
  test("a FAILED step with `usageUnknown` carries the marker and NO `tokens` key", async () => {
    const backend = new FakeBackend({
      "discovery-1": [
        { kind: "fail", failure: "transport-error", usageUnknown: "the turn timed out in flight" },
      ],
    })
    const envelope = await backend.runTurn("discovery-1", "i", "d", SCHEMA)

    expect("tokens" in envelope).toBe(false)
    expect(envelope.ok).toBe(false)
    if (envelope.ok) return
    expect(envelope.usageUnknown).toEqual({
      executionId: "exec-1",
      why: "the turn timed out in flight",
    })
    // The failure classification is the step's, untouched by the marker: a
    // timed-out turn stays a `transport-error` so its AD-6(b) retry
    // classification does not move (story 2.3 does not widen `TurnFailure`).
    expect(envelope.failure).toBe("transport-error")
  })

  test("a SUCCESSFUL step with `usageUnknown` does too — the host reported nothing", async () => {
    // The state that was inexpressible in BOTH the fake and the port: a turn
    // that answered, validated, and told MAD nothing about what it cost. It is
    // the one `adapters/opencode/model-backend.ts:313` used to map to
    // `emptyTokenUsage()`, and it is why the ok branch's `tokens` had to widen.
    const backend = new FakeBackend({
      "discovery-1": [{ kind: "ok", value: VALID, usageUnknown: "the host reported no usage" }],
    })
    const envelope = await backend.runTurn("discovery-1", "i", "d", SCHEMA)

    expect(envelope.ok).toBe(true)
    expect("tokens" in envelope).toBe(false)
    if (!envelope.ok) return
    expect(envelope.value).toEqual(VALID)
    expect(envelope.usageUnknown!.why).toBe("the host reported no usage")
  })

  test("a SCHEMA-INVALID step with `usageUnknown` keeps `raw` and still drops `tokens`", async () => {
    // The salvage path (AD-12) is orthogonal to the usage question, and a fake
    // that dropped `raw` here would silently shrink the AD-6a denominator in
    // any test that combined the two.
    const backend = new FakeBackend({
      "discovery-1": [{ kind: "ok", value: { claim: 7 }, usageUnknown: "cancelled in flight" }],
    })
    const envelope = await backend.runTurn("discovery-1", "i", "d", SCHEMA)

    expect(envelope.ok).toBe(false)
    if (envelope.ok) return
    expect(envelope.failure).toBe("schema-invalid")
    expect(envelope.raw).toEqual({ claim: 7 })
    expect("tokens" in envelope).toBe(false)
    expect(envelope.usageUnknown).toBeDefined()
  })

  test("WITHOUT the modifier nothing moves — every pre-2.3 step still bills `tokens()`", async () => {
    // The property that makes this seam additive: 1299 tests were written
    // against the old behaviour, and none of them opted in.
    const backend = new FakeBackend({
      "discovery-1": [{ kind: "ok", value: VALID }],
      "discovery-2": [{ kind: "fail", failure: "model-error" }],
    })
    const ok = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    const bad = await backend.runTurn("discovery-2", "i", "d", SCHEMA)

    expect(ok.tokens).toEqual({ input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    expect(bad.tokens).toEqual({ input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    expect(ok.usageUnknown).toBeUndefined()
    expect(bad.usageUnknown).toBeUndefined()
  })

  test("execution ids are MINTED IN ORDER and only for the steps that ask", async () => {
    // Deterministic, and stable against an unrelated turn being added: a fake
    // that consumed an id per turn would make these two assertions depend on
    // how many other slots the test happened to script.
    const backend = new FakeBackend({
      "discovery-1": [{ kind: "ok", value: VALID }],
      "discovery-2": [{ kind: "ok", value: VALID, usageUnknown: "the host reported no usage" }],
      "discovery-3": [{ kind: "ok", value: VALID, usageUnknown: "the host reported no usage" }],
    })
    await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    const second = await backend.runTurn("discovery-2", "i", "d", SCHEMA)
    const third = await backend.runTurn("discovery-3", "i", "d", SCHEMA)

    expect(second.usageUnknown!.executionId).toBe("exec-1")
    expect(third.usageUnknown!.executionId).toBe("exec-2")
  })
})

describe("FakeBackend — an unresolved cleanup is scriptable at all", () => {
  test("a SUCCESSFUL turn can carry `cleanupUnresolved`", async () => {
    // AC3's state: the session MAD opened could not be deleted within its
    // deadline, and the turn it rides on succeeded completely. That combination
    // is why `cleanupUnresolved` is a modifier rather than a `kind`, and why
    // `session-cleanup-unresolved` is a DISCLOSURE and not a degradation.
    const backend = new FakeBackend({
      "discovery-1": [
        { kind: "ok", value: VALID, cleanupUnresolved: "session.delete did not answer in 2000ms" },
      ],
    })
    const envelope = await backend.runTurn("discovery-1", "i", "d", SCHEMA)

    expect(envelope.ok).toBe(true)
    expect(envelope.cleanupUnresolved).toEqual({
      why: "session.delete did not answer in 2000ms",
    })
    // The turn still billed, and the cleanup says nothing about that.
    expect(envelope.tokens).toBeDefined()
  })

  test("the two modifiers are INDEPENDENT — a turn can have both, either, or neither", async () => {
    const backend = new FakeBackend({
      "discovery-1": [
        {
          kind: "ok",
          value: VALID,
          usageUnknown: "cancelled in flight",
          cleanupUnresolved: "session.delete threw",
        },
      ],
    })
    const envelope = await backend.runTurn("discovery-1", "i", "d", SCHEMA)

    expect("tokens" in envelope).toBe(false)
    expect(envelope.usageUnknown).toBeDefined()
    expect(envelope.cleanupUnresolved).toBeDefined()
  })

  test("a FAILED turn can carry it too, and it is still not the reason the turn failed", async () => {
    const backend = new FakeBackend({
      "discovery-1": [
        { kind: "fail", failure: "model-error", cleanupUnresolved: "session.delete threw" },
      ],
    })
    const envelope = await backend.runTurn("discovery-1", "i", "d", SCHEMA)

    expect(envelope.ok).toBe(false)
    if (envelope.ok) return
    expect(envelope.failure).toBe("model-error")
    expect(envelope.cleanupUnresolved!.why).toBe("session.delete threw")
  })

  test("WITHOUT the modifier no envelope mentions cleanup at all", async () => {
    const backend = new FakeBackend({ "discovery-1": [{ kind: "ok", value: VALID }] })
    const envelope = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect("cleanupUnresolved" in envelope).toBe(false)
  })
})
