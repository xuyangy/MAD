/**
 * FR10 / AC1 (story 2.3) — THE UNKNOWN-USAGE VOCABULARY, PINNED WHERE IT LIVES.
 *
 * `core/domain/run-record.ts` has recorded what a turn COST since story 1, and
 * until this story it had no way at all to record that a turn's cost is not
 * known. A cancelled, timed-out or thrown turn wrote nothing — no entry, no
 * marker, no count — and a settled turn whose host reported no `tokens` field
 * had `emptyTokenUsage()` fabricated for it by the adapter, which is a TRUTHY
 * object, so the three stages' `if (envelope.tokens)` guard fired and an
 * all-zero entry landed in the ledger. A turn that billed money was therefore
 * recorded as a turn that cost nothing.
 *
 * What this file pins is the property that makes AC1's "no unknown value is ever
 * estimated or interpolated" STRUCTURAL rather than a discipline: the unknowns
 * live in a SECOND collection, so there is no code path by which one becomes a
 * number. Not a zero, not a `NaN`, not an interpolation — the type system has
 * nowhere to put one. The assertions below are therefore mostly about ABSENCE,
 * and they are written as `toBeUndefined()` / `toHaveLength(0)` rather than
 * `toBeFalsy()`, because `0` and "not known" are the two states this whole story
 * separates and `toBeFalsy()` passes on both.
 */

import { describe, expect, test } from "bun:test"

import { CUMULATIVE_SHARE } from "../budget/presets.ts"
import {
  addTokens,
  emptyLedger,
  emptyTokenUsage,
  reconcileLateUsage,
  recordTurn,
  recordUnknownTurn,
  withShares,
  type TokenUsage,
  type UnknownUsageEntry,
} from "./run-record.ts"

function usage(input: number, output = 0): TokenUsage {
  return { ...emptyTokenUsage(), input, output }
}

function unknown(over: Partial<UnknownUsageEntry> = {}): UnknownUsageEntry {
  return {
    slot: "discovery-1",
    stage: "discover",
    attempt: 1,
    executionId: "exec-1",
    why: "the run was cancelled while this turn was in flight",
    ...over,
  }
}

describe("emptyLedger — absent and none must not be two ways of saying the same thing", () => {
  test("`unknownUsage` is PRESENT and EMPTY, never absent", () => {
    // The same call `cap` makes: a required field whose empty value is a real
    // fact. An optional `unknownUsage?` would let a ledger built by an older
    // caller read as "no unknowns" when what it actually says is "this ledger
    // predates the question" — and the whole point of the field is to be
    // trusted by a gate that refuses to spend.
    const ledger = emptyLedger()
    expect("unknownUsage" in ledger).toBe(true)
    expect(ledger.unknownUsage).toEqual([])
  })

  test("`stopOnUnknownUsage` defaults to FALSE — an ordinary run reports and keeps working", () => {
    // AC4's stop rule is about the EXPERIMENT (`evaluation-protocol.md:332-339`).
    // Halting an ordinary code review because one host response omitted a
    // `tokens` field would be this story inventing a policy for a caller the
    // protocol never spoke about, and AD-16's rule that evaluation machinery is
    // additive and never changes an ordinary run cuts the same way.
    expect(emptyLedger().stopOnUnknownUsage).toBe(false)
  })

  test("the pre-story-2.3 fields are untouched, at every arity", () => {
    // `emptyLedger`'s three positional parameters keep their meanings, so every
    // caller written before this story gets exactly the ledger it got before.
    expect(emptyLedger()).toMatchObject({ entries: [], cap: null, shares: CUMULATIVE_SHARE })
    expect(emptyLedger(400).cap).toBe(400)
    expect(emptyLedger(400, 2).maxConcurrency).toBe(2)
  })
})

describe("withShares — the spread carries the new fields", () => {
  test("an unknown recorded before the copy survives it", () => {
    // `withShares` is a COPY and not a mutation, so a field it forgot would
    // silently reset the run's unknown-usage count to zero at the one call site
    // that changes stage shares — which is a ledger that lies in the flattering
    // direction, produced by a helper nobody suspects.
    const ledger = emptyLedger(400)
    recordUnknownTurn(ledger, unknown())
    const copy = withShares(ledger, { discover: 0.5, debate: 0.7, judge: 1 })
    expect(copy.unknownUsage).toHaveLength(1)
    expect(copy.unknownUsage[0]!.executionId).toBe("exec-1")
    expect(copy.shares).toEqual({ discover: 0.5, debate: 0.7, judge: 1 })
  })

  test("`stopOnUnknownUsage` survives it too", () => {
    const ledger = { ...emptyLedger(400), stopOnUnknownUsage: true }
    expect(withShares(ledger, CUMULATIVE_SHARE).stopOnUnknownUsage).toBe(true)
  })
})

describe("recordUnknownTurn — the second writer, beside recordTurn", () => {
  test("it writes to `unknownUsage` and touches NEITHER `entries` NOR `total`", () => {
    // THIS IS THE WHOLE ARGUMENT FOR A SECOND COLLECTION. `entries.length` is
    // read as "billed turns" by `core/stages/output.ts:1621` and
    // `ablation/compare.ts:143`, and `total` is read as the bill. An unknown
    // that landed in either would change what both mean for every existing
    // reader — and, worse, would put a number where there is none.
    const ledger = emptyLedger(400)
    recordUnknownTurn(ledger, unknown())
    expect(ledger.entries).toHaveLength(0)
    expect(ledger.total).toEqual(emptyTokenUsage())
    expect(ledger.unknownUsage).toHaveLength(1)
  })

  test("the entry carries WHO, WHERE, WHICH ATTEMPT, WHICH EXECUTION and WHY", () => {
    const ledger = emptyLedger()
    recordUnknownTurn(ledger, unknown({ stage: "debate", attempt: 2, executionId: "exec-9" }))
    expect(ledger.unknownUsage[0]).toEqual({
      slot: "discovery-1",
      stage: "debate",
      attempt: 2,
      executionId: "exec-9",
      why: "the run was cancelled while this turn was in flight",
    })
  })

  test("two unknowns on one slot are two entries — an unknown is per EXECUTION", () => {
    // `stage + slot + attempt` is explicitly NOT a unique id
    // (`evaluation-protocol.md:504-507`): debate rounds and different judge
    // findings reuse those values. So the collection counts executions, and
    // nothing here deduplicates on the other three fields.
    const ledger = emptyLedger()
    recordUnknownTurn(ledger, unknown({ executionId: "exec-1" }))
    recordUnknownTurn(ledger, unknown({ executionId: "exec-2" }))
    expect(ledger.unknownUsage.map((e) => e.executionId)).toEqual(["exec-1", "exec-2"])
  })

  test("A BLANK REASON IS REPLACED, NOT DROPPED AND NOT THROWN ON", () => {
    // `why` is mandatory and non-empty, the rule `ablation/manifest.ts:87`
    // applies to `unknownValue` — restated here rather than imported, because
    // `core/` may not import `ablation/`.
    //
    // The two rejected alternatives are the point. THROWING would make a
    // programmer's blank string delete an unknown from the record, which is the
    // one outcome this story exists to prevent: recording is what this module
    // does and a lost unknown reads as a free turn. DROPPING it silently is the
    // same failure without the traceback. So the reason is substituted and the
    // unknown is kept.
    const ledger = emptyLedger()
    recordUnknownTurn(ledger, unknown({ why: "   " }))
    expect(ledger.unknownUsage).toHaveLength(1)
    expect(ledger.unknownUsage[0]!.why.trim().length).toBeGreaterThan(0)
  })

  test("recordTurn is UNCHANGED — a known turn still lands in `entries` and `total`", () => {
    const ledger = emptyLedger(400)
    recordTurn(ledger, { slot: "discovery-1", stage: "discover", attempt: 1, tokens: usage(10, 20) })
    expect(ledger.entries).toHaveLength(1)
    expect(ledger.total).toEqual(usage(10, 20))
    expect(ledger.unknownUsage).toHaveLength(0)
  })

  test("`addTokens` and `emptyTokenUsage` are unchanged — five required numbers, no sixth state", () => {
    // Pinned here because the story's whole structural argument rests on
    // `TokenUsage` staying five required numbers with nowhere to put an
    // unknown. A nullable field on it would be the change that lets a `null`
    // reach `addTokens` and come out as a `NaN` total.
    expect(emptyTokenUsage()).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })
    expect(addTokens(usage(1, 2), usage(10, 20))).toEqual(usage(11, 22))
  })
})

describe("reconcileLateUsage — AC2, and it throws nothing", () => {
  test("a MATCHED report becomes real spend and stops being unknown", () => {
    const ledger = emptyLedger(400)
    recordUnknownTurn(ledger, unknown({ executionId: "exec-1", stage: "debate", attempt: 2 }))
    const summary = reconcileLateUsage(ledger, [{ executionId: "exec-1", tokens: usage(30, 5) }])

    expect(ledger.unknownUsage).toHaveLength(0)
    expect(ledger.entries).toEqual([
      { slot: "discovery-1", stage: "debate", attempt: 2, tokens: usage(30, 5) },
    ])
    expect(ledger.total).toEqual(usage(30, 5))
    expect(summary.recovered.map((e) => e.executionId)).toEqual(["exec-1"])
    expect(summary.stillUnknown).toBe(0)
  })

  test("the recovered entry keeps the UNKNOWN's provenance, not the report's", () => {
    // `LateUsageReport` carries an `executionId` and a token payload and
    // nothing else, deliberately: the provider knows what it billed, and MAD
    // knows which slot, stage and attempt asked for it. Reconstructing the
    // provenance from the report would mean the adapter deciding what a ledger
    // row says about the pipeline, which is a fact it does not hold.
    const ledger = emptyLedger()
    recordUnknownTurn(ledger, unknown({ slot: "judge-1", stage: "judge", attempt: 1 }))
    reconcileLateUsage(ledger, [{ executionId: "exec-1", tokens: usage(7) }])
    expect(ledger.entries[0]).toMatchObject({ slot: "judge-1", stage: "judge", attempt: 1 })
  })

  test("an UNMATCHED report leaves the ledger alone and is reported back", () => {
    // The run has already closed over its unknowns, or the report names an
    // execution from another run. Either way nothing is invented: no entry, no
    // addition to the total, and no new unknown either — MAD does not learn
    // about a turn from a bill.
    const ledger = emptyLedger(400)
    recordUnknownTurn(ledger, unknown({ executionId: "exec-1" }))
    const summary = reconcileLateUsage(ledger, [{ executionId: "exec-404", tokens: usage(99) }])

    expect(ledger.entries).toHaveLength(0)
    expect(ledger.total).toEqual(emptyTokenUsage())
    expect(ledger.unknownUsage.map((e) => e.executionId)).toEqual(["exec-1"])
    expect(summary.unmatched).toEqual([{ executionId: "exec-404", tokens: usage(99) }])
    expect(summary.recovered).toHaveLength(0)
  })

  test("AN UNMATCHED UNKNOWN STAYS UNKNOWN — it is not zeroed and not reported as recovered", () => {
    const ledger = emptyLedger(400)
    recordUnknownTurn(ledger, unknown({ executionId: "exec-1" }))
    recordUnknownTurn(ledger, unknown({ executionId: "exec-2" }))
    const summary = reconcileLateUsage(ledger, [{ executionId: "exec-2", tokens: usage(4) }])

    expect(ledger.unknownUsage.map((e) => e.executionId)).toEqual(["exec-1"])
    expect(summary.stillUnknown).toBe(1)
    expect(ledger.total).toEqual(usage(4))
  })

  test("TWO DISAGREEING PAYLOADS FOR ONE EXECUTION ARE AN INTEGRITY ERROR, not a first-seen win", () => {
    // `evaluation-protocol.md:504-507`, verbatim in its own words:
    // "Disagreeing token payloads for one physical execution are an integrity
    // error, not something to deduplicate by first-seen." So the unknown stays
    // unknown and NEITHER number enters the total — picking one would put a
    // figure MAD cannot defend into the column the whole story is about, and
    // picking the smaller one would do it in the flattering direction.
    const ledger = emptyLedger(400)
    recordUnknownTurn(ledger, unknown({ executionId: "exec-1" }))
    const summary = reconcileLateUsage(ledger, [
      { executionId: "exec-1", tokens: usage(10) },
      { executionId: "exec-1", tokens: usage(40) },
    ])

    expect(ledger.entries).toHaveLength(0)
    expect(ledger.total).toEqual(emptyTokenUsage())
    expect(ledger.unknownUsage.map((e) => e.executionId)).toEqual(["exec-1"])
    expect(summary.recovered).toHaveLength(0)
    expect(summary.conflicts).toHaveLength(1)
    expect(summary.conflicts[0]!.executionId).toBe("exec-1")
    expect(summary.conflicts[0]!.payloads).toEqual([usage(10), usage(40)])
    expect(summary.stillUnknown).toBe(1)
  })

  test("TWO AGREEING PAYLOADS ARE NOT A CONFLICT — a duplicate delivery is reconciled ONCE", () => {
    // The protocol's rule is about DISAGREEMENT. A reporter that delivered the
    // same number twice has told MAD one thing twice, and counting it twice
    // would double a real bill — the opposite direction from this story's
    // failure, and just as wrong.
    const ledger = emptyLedger(400)
    recordUnknownTurn(ledger, unknown({ executionId: "exec-1" }))
    const summary = reconcileLateUsage(ledger, [
      { executionId: "exec-1", tokens: usage(10) },
      { executionId: "exec-1", tokens: usage(10) },
    ])

    expect(summary.conflicts).toHaveLength(0)
    expect(ledger.entries).toHaveLength(1)
    expect(ledger.total).toEqual(usage(10))
  })

  test("nothing throws, for any input a JavaScript caller can reach this with", () => {
    // The same rule `core/budget/ledger.ts:21-26` states for the gate, for the
    // same reason: a record that threw would make a run whose provider was
    // slow with its accounting look like a run that crashed.
    const ledger = emptyLedger(400)
    expect(() => reconcileLateUsage(ledger, [])).not.toThrow()
    expect(() => reconcileLateUsage(ledger, undefined as never)).not.toThrow()
    expect(() => reconcileLateUsage(ledger, [undefined as never])).not.toThrow()
  })

  test("a report whose tokens are not five finite numbers leaves the unknown unknown", () => {
    // REVIEW 2026-09-10 — the hole two independent verifiers found on the same
    // commit. `{ input: 5 }` is an object, so a `typeof` guard admitted it;
    // `addTokens` then summed `5 + undefined` into `NaN` for the other four
    // fields WHILE the unknown entry was spliced out. The ledger ended up
    // holding a `NaN` total and reporting itself complete, which is this story's
    // own failure mode reintroduced by the path that was supposed to cure it.
    //
    // Each case is checked on its own ledger so one leaking does not mask
    // another, and every case asserts BOTH halves: the total is untouched AND
    // the unknown survives. Asserting only the total would pass on a bug that
    // silently consumed the unknown.
    const malformed: unknown[] = [
      { input: 5 },
      { input: 1, output: 1, reasoning: 1, cacheRead: 1, cacheWrite: Number.NaN },
      { input: 1, output: 1, reasoning: 1, cacheRead: 1, cacheWrite: Number.POSITIVE_INFINITY },
      { input: 1, output: 1, reasoning: 1, cacheRead: 1, cacheWrite: "3" },
      { input: 1, output: 1, reasoning: 1, cacheRead: 1, cacheWrite: -1 },
      {},
    ]

    for (const tokens of malformed) {
      const ledger = emptyLedger(400)
      recordUnknownTurn(ledger, unknown({ executionId: "exec-1" }))
      const summary = reconcileLateUsage(ledger, [
        { executionId: "exec-1", tokens: tokens as never },
      ])

      expect(summary.recovered).toEqual([])
      expect(summary.stillUnknown).toBe(1)
      expect(ledger.entries).toEqual([])
      expect(ledger.total).toEqual(emptyTokenUsage())
      expect(ledger.unknownUsage).toHaveLength(1)
      expect(ledger.unknownUsage[0]?.executionId).toBe("exec-1")
    }
  })

  test("an empty pass is a no-op that still answers the completeness question", () => {
    const ledger = emptyLedger(400)
    recordUnknownTurn(ledger, unknown())
    const summary = reconcileLateUsage(ledger, [])
    expect(summary).toEqual({ recovered: [], unmatched: [], conflicts: [], stillUnknown: 1 })
  })
})
