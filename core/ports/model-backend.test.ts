/**
 * AD-2 (story 2.3) — THE TWO ENVELOPE CONSTRUCTORS, and the difference between
 * them, pinned where they live.
 *
 * `core/ports/model-backend.ts` is interfaces plus constructors, so there was
 * nothing to test until story 7A added `cancelledTurn` and nothing that
 * DISTINGUISHED anything until this story added `abandonedTurn`. The two are one
 * character apart in a call site and opposite in what they claim about money:
 * one says nothing was billed, the other says something was billed and the
 * amount is not known. Getting them the wrong way round is the failure story 2.3
 * exists to remove, so the difference is asserted rather than described.
 *
 * Every assertion here is about ABSENCE where absence is the fact —
 * `toBeUndefined()` and `"tokens" in envelope`, never `toBeFalsy()`, because
 * `tokens: emptyTokenUsage()` and no `tokens` field are precisely the two states
 * this story separates and `toBeFalsy()` passes on both.
 */

import { describe, expect, test } from "bun:test"

import { abandonedTurn, cancelledTurn } from "./model-backend.ts"

describe("cancelledTurn — the PRE-ISSUE case, where nothing was billed", () => {
  test("it carries NO `tokens` field at all — the key is absent, not zeroed", () => {
    const envelope = cancelledTurn("discovery-1")
    expect(envelope.ok).toBe(false)
    expect("tokens" in envelope).toBe(false)
  })

  test("and NO usage marker — nothing was issued, so nothing is unknown", () => {
    // The distinction that makes `usageUnknown` mean anything. A turn the core
    // decided not to issue has a KNOWN cost of zero, and marking it unknown
    // would halt an evaluation over a turn that provably cost nothing (AC4's
    // stop rule reads `unknownUsage`).
    const envelope = cancelledTurn("discovery-1")
    expect(envelope.ok).toBe(false)
    if (envelope.ok) return
    expect(envelope.usageUnknown).toBeUndefined()
  })

  test("its message is about the RUN and says PRE-ISSUE, which is what it is true for", () => {
    const envelope = cancelledTurn("discovery-1")
    expect(envelope.ok).toBe(false)
    if (envelope.ok) return
    expect(envelope.message).toBe("the run was cancelled before this turn was issued")
    expect(envelope.failure).toBe("cancelled")
  })
})

describe("abandonedTurn — the IN-FLIGHT case, where tokens ARE billed", () => {
  test("it carries the unknown-usage marker and STILL no `tokens` field", () => {
    // Both halves matter. The marker is what reaches
    // `TokenLedger.unknownUsage`; the absent `tokens` is what keeps the
    // fabricated zero out of `entries` and `total`
    // (`adapters/opencode/model-backend.ts:136-137` — the SDK call keeps
    // running until the provider answers, and its tokens are still billed).
    const envelope = abandonedTurn("discovery-1", "exec-7", "the run was cancelled in flight")
    expect(envelope.ok).toBe(false)
    if (envelope.ok) return
    expect(envelope.usageUnknown).toEqual({
      executionId: "exec-7",
      why: "the run was cancelled in flight",
    })
    expect("tokens" in envelope).toBe(false)
  })

  test("it is still `failure: \"cancelled\"`, so it gets no retry (AD-6b)", () => {
    // `evaluation-protocol.md:311-327` — "Cancellation, budget refusal and
    // unquantified usage never authorize a retry." Retrying a turn the user
    // cancelled spends their money to disobey them, and the fact that the first
    // attempt's cost is unknown makes a second attempt worse, not better.
    // `TurnFailure`'s five members are unchanged by this story precisely so
    // this classification does not move.
    const envelope = abandonedTurn("discovery-1", "exec-7", "why")
    expect(envelope.ok).toBe(false)
    if (envelope.ok) return
    expect(envelope.failure).toBe("cancelled")
  })

  test("its message does NOT claim the turn was never issued", () => {
    // The one thing `cancelledTurn`'s message says that is false here, and the
    // reason a second constructor exists rather than a flag on the first.
    const envelope = abandonedTurn("discovery-1", "exec-7", "why")
    expect(envelope.ok).toBe(false)
    if (envelope.ok) return
    expect(envelope.message).not.toContain("before this turn was issued")
    expect(envelope.message).toContain("in flight")
  })

  test("a blank `why` is SUBSTITUTED, not passed through — `why` is non-empty by rule", () => {
    // The same rule `UnknownUsageEntry` states and `recordUnknownTurn`
    // enforces, applied at the port so a marker cannot be born blank and then
    // be repaired downstream. Substituted rather than thrown on, because losing
    // the marker would turn an uncountable turn back into a free one.
    const envelope = abandonedTurn("discovery-1", "exec-7", "  ")
    expect(envelope.ok).toBe(false)
    if (envelope.ok) return
    expect(envelope.usageUnknown!.why.trim().length).toBeGreaterThan(0)
  })

  test("the slot rides through untouched, so the stage can attribute the abandonment", () => {
    const envelope = abandonedTurn("judge-2", "exec-1", "timed out")
    expect(envelope.slot).toBe("judge-2")
  })
})
