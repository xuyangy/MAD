import { describe, expect, test } from "bun:test"

import { z } from "zod"

import { mayISpend, spent, type BudgetLedger } from "../budget/ledger.ts"
import type { CoDiscovery, Entry, Finding, Severity } from "../domain/finding.ts"
import type { LensSlot, Roster, RosterSlot } from "../domain/roster.ts"
import { emptyLedger } from "../domain/run-record.ts"
import { CODING_DEBATE_GENERALIST } from "../instructions/coding/debate.ts"
import { CODING_LENS_INSTRUCTIONS } from "../instructions/coding/lenses.ts"
import type { ModelBackend } from "../ports/model-backend.ts"
import { fakeClock, FakeBackend, tokens, type SlotScript, type SlotStep } from "../test-support/fakes.ts"
import {
  clampMaxRounds,
  debate,
  debateEnvelopeSchema,
  DEFAULT_MAX_ROUNDS,
  MAX_DEBATE_ROUNDS,
  type DebateInput,
} from "./debate.ts"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function slot(id: string): RosterSlot {
  return {
    slot: id,
    providerId: "provider",
    modelId: id,
    identity: id,
    lineage: { lineage: id, label: id, verified: true },
    toolcall: true,
    alsoAvailableVia: [],
  }
}

function lensSlot(lens: string): LensSlot {
  return { ...slot(`discovery-lens-${lens}`), lens }
}

function roster(slotIds: string[], lenses: string[] = []): Roster {
  return {
    slots: slotIds.map(slot),
    lensSlots: lenses.map(lensSlot),
    requested: slotIds.length,
    distinctLineages: slotIds.length,
    providers: ["provider"],
  }
}

interface Draft {
  id?: string
  author?: string
  severity?: Severity
  route?: "debate" | "judge"
  coDiscovery?: CoDiscovery
  mergedIds?: string[]
  source?: "pool" | "lens"
  lens?: string
}

function contested(draft: Draft = {}): Finding {
  return {
    id: draft.id ?? "f-1",
    claim: "the fee is computed before the rate is validated",
    reasoning: "if `rate` is NaN the total silently becomes NaN",
    locus: { file: "src/pay.ts", startLine: 12, endLine: 14 },
    severity: draft.severity ?? "high",
    author: draft.author ?? "discovery-1",
    source: draft.source ?? "pool",
    lens: draft.lens,
    clusterId: `cluster-${draft.id ?? "f-1"}`,
    coDiscovery: draft.coDiscovery ?? { raised: 1, answered: 3 },
    mergedIds: draft.mergedIds,
    route: draft.route ?? "debate",
    routeReason: "co-discovery 1/3 below threshold 80% — contested",
    history: [
      { stage: "discover", actor: draft.author ?? "discovery-1", at: "t0", kind: "raised", body: "x" },
      { stage: "route", actor: "mad", at: "t0", kind: "routed", body: "contested" },
    ],
  }
}

/** One position, as a model would return it, wrapped in a valid envelope. */
function says(
  ...turns: {
    findingId: string
    position: "upholds" | "denies" | "withdraws" | "unsure"
    argument?: string
    concession?: string
    citations?: string[]
  }[]
): SlotStep {
  return {
    kind: "ok",
    value: {
      turns: turns.map((turn) => ({
        findingId: turn.findingId,
        position: turn.position,
        argument: turn.argument ?? `I ${turn.position}.`,
        ...(turn.concession === undefined ? {} : { concession: turn.concession }),
        citations: turn.citations ?? [],
      })),
    },
  }
}

function run(
  findings: Finding[],
  scripts: Record<string, SlotScript>,
  overrides: Partial<DebateInput> = {},
) {
  const slots = overrides.roster ?? roster(["discovery-1", "discovery-2", "discovery-3"])
  const answeredSlots =
    overrides.answeredSlots ??
    [...slots.slots.map((s) => s.slot), ...slots.lensSlots.map((s) => s.slot)]
  return debate({
    findings,
    roster: slots,
    answeredSlots,
    backend: new FakeBackend(scripts),
    input: "# Change under review\n\ndiff goes here",
    clock: fakeClock(),
    ledger: emptyLedger() as BudgetLedger,
    ...overrides,
  })
}

const roundEntries = (finding: Finding): Entry[] =>
  finding.history.filter((entry) => entry.stage === "debate" && entry.round !== undefined)

const exitEntry = (finding: Finding): Entry | undefined =>
  finding.history.findLast((entry) => entry.kind.startsWith("debate-exit-"))

const exitKind = (finding: Finding): string | undefined => exitEntry(finding)?.kind
const exitBody = (finding: Finding): string => exitEntry(finding)?.body ?? ""

// ---------------------------------------------------------------------------
// The I/O matrix, row by row
// ---------------------------------------------------------------------------

describe("debate — the three exits (CAP-4)", () => {
  test("MATRIX: concession — the author holds, the challenger flips in round 2 → converged", async () => {
    // The reference demo's converging exchange, in MAD's shape: one participant
    // is right from the start, the other re-reads the evidence and moves.
    // (`reference/multi_agent_debate_ring.py:250-300` — its SCRIPT, never its
    // aggregator.)
    const finding = contested()
    const result = await run([finding], {
      "discovery-1": [says({ findingId: "f-1", position: "upholds", citations: ["src/pay.ts:12"] })],
      "discovery-2": [
        says({ findingId: "f-1", position: "denies" }),
        says({
          findingId: "f-1",
          position: "upholds",
          argument: "Re-reading line 12, the rate really is used before the guard.",
          concession: "My first reading had the guard on line 11; it is on line 15.",
        }),
      ],
    })

    expect(finding.exit).toBe("converged")
    expect(result.converged).toBe(1)

    const rounds = roundEntries(finding)
    // Both rounds are on the record — round 1's disagreement is not overwritten.
    expect(rounds.map((entry) => [entry.round, entry.actor, entry.position])).toEqual([
      [1, "discovery-1", "upholds"],
      [1, "discovery-2", "denies"],
      [2, "discovery-1", "upholds"],
      [2, "discovery-2", "upholds"],
    ])

    const flipped = rounds.find((entry) => entry.round === 2 && entry.actor === "discovery-2")!
    expect(flipped.positionChanged).toBe(true)
    expect(flipped.concession).toContain("guard")
    // The author restated and did not move — a change flag on a restatement
    // would make the stall test read movement that never happened.
    expect(rounds.find((entry) => entry.round === 2 && entry.actor === "discovery-1")!.positionChanged).toBe(
      false,
    )
  })

  test("MATRIX: stalled — everyone restates in round 2, and NO ROUND 3 TURN IS SPENT", async () => {
    // `cost-model.md` lever 3: this is the only exit that saves tokens by
    // existing. Asserting the exit without asserting the unspent round would
    // leave the saving untested.
    const finding = contested()
    const backend = new FakeBackend({
      "discovery-1": [says({ findingId: "f-1", position: "upholds" })],
      "discovery-2": [says({ findingId: "f-1", position: "denies" })],
    })
    const result = await run([finding], {}, { backend, maxRounds: 3 })

    expect(finding.exit).toBe("stalled")
    expect(result.stalled).toBe(1)
    expect(result.rounds).toBe(2)
    // Two participants x two rounds. A third round would be four calls.
    expect(backend.calls).toHaveLength(4)
  })

  test("ROUND 1 CANNOT STALL — every position in it is new", async () => {
    // "Nobody moved" is trivially true in round 1, so a stall test without the
    // round guard would end every debate before it started.
    const finding = contested()
    const result = await run([finding], {
      "discovery-1": [says({ findingId: "f-1", position: "upholds" })],
      "discovery-2": [says({ findingId: "f-1", position: "denies" })],
    })
    expect(result.rounds).toBe(2)
    expect(finding.exit).toBe("stalled")
  })

  test("MATRIX: cap — positions still disagree at maxRounds → cap", async () => {
    // Every round moves, so `stalled` never fires and the debate runs out of
    // rounds rather than out of things to say.
    const finding = contested()
    const result = await run(
      [finding],
      {
        // Somebody moves in every round, so `stalled` never fires — and they
        // never land on the same position, so `converged` never fires either.
        "discovery-1": [
          says({ findingId: "f-1", position: "upholds" }),
          says({ findingId: "f-1", position: "unsure" }),
          says({ findingId: "f-1", position: "upholds" }),
        ],
        "discovery-2": [says({ findingId: "f-1", position: "denies" })],
      },
      { maxRounds: 3 },
    )

    expect(finding.exit).toBe("cap")
    expect(result.cap).toBe(1)
    expect(result.rounds).toBe(3)
  })

  test("AC: THE SAME DEBATE AT A LOWER CAP EXITS `cap` INSTEAD OF `converged`, AND NOTHING ELSE CHANGES", async () => {
    // CAP-4's dial, demonstrated the way CAP-3's threshold is: replay one
    // scripted exchange at two settings and change exactly one field.
    const script: Record<string, SlotScript> = {
      "discovery-1": [says({ findingId: "f-1", position: "upholds" })],
      "discovery-2": [
        says({ findingId: "f-1", position: "denies" }),
        says({ findingId: "f-1", position: "unsure" }),
        says({ findingId: "f-1", position: "upholds", concession: "The guard is later than I read it." }),
      ],
    }
    const long = contested()
    const short = contested()
    await run([long], script, { maxRounds: 3 })
    await run([short], script, { maxRounds: 2 })

    expect(long.exit).toBe("converged")
    expect(short.exit).toBe("cap")

    const shape = (finding: Finding) => ({
      id: finding.id,
      claim: finding.claim,
      reasoning: finding.reasoning,
      locus: finding.locus,
      severity: finding.severity,
      clusterSeverity: finding.clusterSeverity,
      coDiscovery: finding.coDiscovery,
      route: finding.route,
      routeReason: finding.routeReason,
      verdict: finding.verdict,
      unresolved: finding.unresolved,
    })
    expect(shape(short)).toEqual(shape(long))
  })

  test("MATRIX: the author withdraws → converged, the finding SURVIVES, and no verdict is written", async () => {
    // `withdrawn-by-author` is a `Verdict` value and `verdict` is story 6's
    // field (AD-8). Debate records the withdrawal as a POSITION and exits.
    const finding = contested()
    const result = await run([finding], {
      "discovery-1": [
        says({
          findingId: "f-1",
          position: "withdraws",
          argument: "I misread the guard; there is no defect here.",
        }),
      ],
      "discovery-2": [says({ findingId: "f-1", position: "denies" })],
    })

    expect(finding.exit).toBe("converged")
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toBe(finding)
    expect(finding.verdict).toBeUndefined()
    const withdrawal = roundEntries(finding).find((entry) => entry.actor === "discovery-1")!
    expect(withdrawal.position).toBe("withdraws")
    // Exited in round 1: there is nothing left to argue once the author has gone.
    expect(result.rounds).toBe(1)
  })

  test("A DENIER CANNOT WITHDRAW SOMEONE ELSE'S FINDING", async () => {
    // The one thing `SPEC.md` says a denier cannot do. Recorded as `denies`,
    // and said out loud in the entry rather than silently rewritten.
    const finding = contested({ author: "discovery-1" })
    await run([finding], {
      "discovery-1": [says({ findingId: "f-1", position: "upholds" })],
      "discovery-2": [says({ findingId: "f-1", position: "withdraws" })],
    })

    const usurper = roundEntries(finding).find((entry) => entry.actor === "discovery-2")!
    expect(usurper.position).toBe("denies")
    expect(usurper.body).toContain("only a finding's author can withdraw it")
    expect(finding.exit).not.toBe("converged")
  })

  test("agreement in round 1 converges immediately — agreeing is a real answer", async () => {
    const finding = contested()
    const result = await run([finding], {
      "discovery-1": [says({ findingId: "f-1", position: "upholds" })],
      "discovery-2": [says({ findingId: "f-1", position: "upholds" })],
    })
    expect(finding.exit).toBe("converged")
    expect(exitKind(finding)).toBe("debate-exit-converged-agreed")
    expect(result.rounds).toBe(1)
    expect(result.convergedUncontested).toBe(0)
    expect(result.convergedUnsure).toBe(0)
  })

  test("FRESH DISSENT IN ROUND 2 IS MOVEMENT, even though nothing CHANGED", async () => {
    // The bug this pins: a slot silent in round 1 that arrives in round 2 with a
    // contradicting position has no previous position to differ from, so
    // `positionChanged` is false — and reading only that flag reported `stalled`
    // in the exact round fresh dissent arrived, ending the debate at the moment
    // it finally became one.
    const finding = contested({ author: "discovery-1" })
    const result = await run(
      [finding],
      {
        "discovery-1": [says({ findingId: "f-1", position: "upholds" })],
        // Silent in round 1 (a valid envelope stating nothing), dissenting in 2.
        "discovery-2": [
          { kind: "ok", value: { turns: [] } },
          says({ findingId: "f-1", position: "denies" }),
        ],
      },
      { maxRounds: 3 },
    )

    // Round 2 is where the dissent lands, so the debate must survive PAST it —
    // the bug ended it exactly there.
    expect(result.rounds).toBeGreaterThan(2)
    const dissent = roundEntries(finding).find((entry) => entry.actor === "discovery-2")!
    expect(dissent.round).toBe(2)
    expect(dissent.position).toBe("denies")
    // `positionChanged` stays the honest flag ON THE RECORD: nothing changed,
    // because there was no previous position. The stall test asks the wider
    // question, and the two are deliberately not the same field.
    expect(dissent.positionChanged).toBe(false)
  })

  test("UNANIMOUS `unsure` IS NOT AGREEMENT — it is unresolved by evidence", async () => {
    const finding = contested()
    const result = await run([finding], {
      "discovery-1": [says({ findingId: "f-1", position: "unsure" })],
      "discovery-2": [says({ findingId: "f-1", position: "unsure" })],
    })

    expect(finding.exit).toBe("converged")
    expect(exitKind(finding)).toBe("debate-exit-converged-unsure")
    expect(exitBody(finding)).toContain("UNSURE")
    expect(exitBody(finding)).toContain("not upheld")
    // A SUBSET of converged, never a separate bucket — the identity holds.
    expect(result.converged).toBe(1)
    expect(result.convergedUnsure).toBe(1)
    expect(result.convergedUncontested).toBe(0)
  })

  test("A ROUND IN WHICH NOBODY SPEAKS ENDS THE DEBATE, rather than buying more of it", async () => {
    // If nobody stated a position, an identical prompt next round produces an
    // identical nothing. Spending the remaining rounds to discover that is the
    // exact opposite of `cost-model.md` lever 3.
    const finding = contested()
    const backend = new FakeBackend({
      "discovery-1": [{ kind: "ok", value: { turns: [] } }],
      "discovery-2": [{ kind: "ok", value: { turns: [] } }],
    })
    const result = await run([finding], {}, { backend, maxRounds: 3 })

    expect(result.rounds).toBe(1)
    expect(backend.calls).toHaveLength(2)
    expect(finding.exit).toBe("stalled")
    expect(exitKind(finding)).toBe("debate-exit-stalled-silent")
    expect(exitBody(finding)).toContain("NO PARTICIPANT STATED A POSITION")
    expect(roundEntries(finding)).toHaveLength(0)
  })

  test("a room with NO SEATS exits silent rather than claiming a round cap it never reached", async () => {
    const finding = contested({ author: "discovery-9" })
    const backend = new FakeBackend({})
    const result = await run([finding], {}, { backend, answeredSlots: [], maxRounds: 3 })

    expect(backend.calls).toHaveLength(0)
    expect(result.rounds).toBe(0)
    expect(finding.exit).toBe("stalled")
    expect(exitKind(finding)).toBe("debate-exit-stalled-silent")
  })
})

describe("debate — the proceeding barrier (AD-6b, AD-12)", () => {
  test("MATRIX: a participant that fails EVERY attempt does not stall the round", async () => {
    // The reference ring's failure (`multi_agent_debate_ring.py:173-196` waits
    // for every neighbour to check in). Here the round completes with the rest.
    const finding = contested()
    const backend = new FakeBackend({
      "discovery-1": [says({ findingId: "f-1", position: "upholds" })],
      "discovery-2": [{ kind: "fail", failure: "transport-error", message: "socket closed" }],
    })
    const result = await run([finding], {}, { backend, maxRounds: 2 })

    // One retry, then proceed (AD-6b) — two attempts for the failing slot.
    expect(backend.calls.filter((call) => call.slot === "discovery-2")).toHaveLength(2)
    const dropped = result.warnings.filter((warning) => warning.code === "model-dropped-out")
    expect(dropped).toHaveLength(1)
    expect(dropped[0]!.message).toContain("discovery-2")
    expect(dropped[0]!.stage).toBe("debate")
    // The author's position was still recorded, and the finding still exited.
    expect(roundEntries(finding).map((entry) => entry.actor)).toEqual(["discovery-1"])
    expect(finding.exit).toBeDefined()
  })

  test("MATRIX: a schema-invalid envelope is a drop-out FOR THAT SLOT, and the raw payload is kept", async () => {
    const finding = contested()
    const result = await run([finding], {
      "discovery-1": [says({ findingId: "f-1", position: "upholds" })],
      // A shape the real schema rejects: `position` is not in the vocabulary.
      "discovery-2": [{ kind: "ok", value: { turns: [{ findingId: "f-1", position: "maybe" }] } }],
    })

    const dropped = result.warnings.find((warning) => warning.code === "model-dropped-out")!
    expect(dropped.detail?.failure).toBe("schema-invalid")
    expect(dropped.detail?.raw).toEqual({ turns: [{ findingId: "f-1", position: "maybe" }] })
    // The OTHER slot's round still counts: its position is on the record.
    expect(roundEntries(finding).map((entry) => entry.actor)).toEqual(["discovery-1"])
  })

  test("SILENCE IS ABSTENTION — it never counts as movement and never kills a finding", async () => {
    // A silent denier must not produce a stall (which would read as "we argued
    // and got nowhere") nor a convergence (which would read as agreement).
    const finding = contested()
    await run(
      [finding],
      {
        "discovery-1": [says({ findingId: "f-1", position: "upholds" })],
        "discovery-2": [{ kind: "fail", failure: "model-error", message: "overloaded" }],
      },
      { maxRounds: 2 },
    )

    // The author alone spoke and never moved; nothing the silent slot did was
    // recorded as a position, so no entry carries its name.
    expect(roundEntries(finding).some((entry) => entry.actor === "discovery-2")).toBe(false)
    expect(finding.unresolved).toBeUndefined()
    // AD-6 — AND IT MUST NOT READ AS AGREEMENT. One voice converging is
    // `uncontested`, not `agreed`: nobody disagreed because nobody answered.
    expect(finding.exit).toBe("converged")
    expect(exitKind(finding)).toBe("debate-exit-converged-uncontested")
    expect(exitBody(finding)).toContain("UNCONTESTED")
    expect(exitBody(finding)).toContain("nothing here is agreement")
  })

  test("one slot throwing does not abort the round for the others", async () => {
    const finding = contested()
    const throwing: ModelBackend = {
      capabilities: () => ({ tools: false }),
      async runTurn(slotId, _instructions, _input, schema) {
        if (slotId === "discovery-2") throw new Error("kaboom")
        const parsed = schema.safeParse({
          turns: [{ findingId: "f-1", position: "upholds", argument: "yes", citations: [] }],
        })
        return parsed.success
          ? { ok: true, slot: slotId, value: parsed.data, tokens: tokens() }
          : { ok: false, slot: slotId, failure: "schema-invalid", message: "n/a", tokens: tokens() }
      },
    }
    const result = await run([finding], {}, { backend: throwing, maxRounds: 1 })

    expect(roundEntries(finding).map((entry) => entry.actor)).toEqual(["discovery-1"])
    const dropped = result.warnings.find((warning) => warning.code === "model-dropped-out")!
    expect(dropped.detail?.failure).toBe("transport-error")
    expect(dropped.message).toContain("kaboom")
  })
})

describe("debate — batching is the cost lever (cost-model.md 1, AD-15)", () => {
  test("AC: THREE CONTESTED FINDINGS, ONE MODEL — ONE TURN AND ONE LEDGER ALLOCATION PER ROUND", async () => {
    const findings = [
      contested({ id: "f-1" }),
      contested({ id: "f-2" }),
      contested({ id: "f-3" }),
    ]
    const ledger = emptyLedger() as BudgetLedger
    const backend = new FakeBackend({
      "discovery-1": [
        says(
          { findingId: "f-1", position: "upholds" },
          { findingId: "f-2", position: "upholds" },
          { findingId: "f-3", position: "upholds" },
        ),
      ],
    })
    const result = await run(
      findings,
      {},
      { backend, ledger, roster: roster(["discovery-1"]), answeredSlots: ["discovery-1"], maxRounds: 3 },
    )

    // ONE call for the model, covering all three findings. Nine would be the
    // per-finding shape this design exists to avoid.
    expect(backend.calls).toHaveLength(1)
    expect(ledger.entries.filter((entry) => entry.stage === "debate")).toHaveLength(1)
    expect(result.turns).toBe(1)
    expect(result.rounds).toBe(1)
    // A one-member room agrees with itself, so all three converge in round 1.
    expect(findings.map((finding) => finding.exit)).toEqual(["converged", "converged", "converged"])
  })

  test("the batched prompt carries every open finding, and the change under review ONCE", async () => {
    const prompts: string[] = []
    const recording: ModelBackend = {
      capabilities: () => ({ tools: false }),
      async runTurn(slotId, _instructions, promptInput, schema) {
        prompts.push(promptInput)
        const parsed = schema.safeParse({
          turns: [
            { findingId: "f-1", position: "upholds", argument: "a", citations: [] },
            { findingId: "f-2", position: "upholds", argument: "b", citations: [] },
          ],
        })
        return parsed.success
          ? { ok: true, slot: slotId, value: parsed.data, tokens: tokens() }
          : { ok: false, slot: slotId, failure: "schema-invalid", message: "n/a" }
      },
    }
    await run([contested({ id: "f-1" }), contested({ id: "f-2" })], {}, {
      backend: recording,
      roster: roster(["discovery-1"]),
      answeredSlots: ["discovery-1"],
    })

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("`f-1`")
    expect(prompts[0]).toContain("`f-2`")
    // The diff is the expensive part; batching's whole saving is sending it once.
    expect(prompts[0]!.split("# Change under review")).toHaveLength(2)
  })

  test("a spent round is one allocation per PARTICIPANT, not per finding", async () => {
    const ledger = emptyLedger() as BudgetLedger
    await run(
      [contested({ id: "f-1" }), contested({ id: "f-2" })],
      {
        "discovery-1": [says({ findingId: "f-1", position: "upholds" }, { findingId: "f-2", position: "upholds" })],
        "discovery-2": [says({ findingId: "f-1", position: "denies" }, { findingId: "f-2", position: "denies" })],
      },
      { ledger, maxRounds: 1 },
    )
    // Two participants, two findings, one round: two allocations.
    expect(ledger.entries.filter((entry) => entry.stage === "debate")).toHaveLength(2)
  })
})

describe("debate — sparse rooms, chosen by the stage; positions never assigned", () => {
  test("the room is author + co-finders + ONE non-author seat, in roster order", async () => {
    const seen = new Set<string>()
    const backend = new FakeBackend({
      "discovery-1": [says({ findingId: "f-1", position: "upholds" })],
      "discovery-2": [says({ findingId: "f-1", position: "denies" })],
      "discovery-3": [says({ findingId: "f-1", position: "denies" })],
      "discovery-4": [says({ findingId: "f-1", position: "denies" })],
    })
    // The canonical was raised by discovery-2 and absorbed discovery-4's copy;
    // the extra seat is the FIRST answered non-member in roster order.
    const finding = contested({ id: "f-1", author: "discovery-2", mergedIds: ["m-1"] })
    const member: Finding = { ...contested({ id: "m-1", author: "discovery-4" }), route: "judge" }

    await run([finding], {}, {
      backend,
      pool: [finding, member],
      roster: roster(["discovery-1", "discovery-2", "discovery-3", "discovery-4"]),
      maxRounds: 1,
    })
    for (const call of backend.calls) seen.add(call.slot)

    // author (discovery-2), co-finder (discovery-4), and discovery-1 as the one
    // extra seat. discovery-3 is NOT in the room — full connectivity is the cost
    // this design exists to avoid.
    expect([...seen].sort()).toEqual(["discovery-1", "discovery-2", "discovery-4"])
  })

  test("the extra seat is only offered to a slot that ANSWERED discovery", async () => {
    const backend = new FakeBackend({
      "discovery-1": [says({ findingId: "f-1", position: "upholds" })],
      "discovery-3": [says({ findingId: "f-1", position: "denies" })],
    })
    await run([contested({ author: "discovery-1" })], {}, {
      backend,
      // discovery-2 dropped out of discovery; it is not offered the seat.
      answeredSlots: ["discovery-1", "discovery-3"],
      maxRounds: 1,
    })
    expect(backend.calls.some((call) => call.slot === "discovery-2")).toBe(false)
    expect(backend.calls.some((call) => call.slot === "discovery-3")).toBe(true)
  })

  test("a single-slot roster still debates — the room is the author alone", async () => {
    const finding = contested({ author: "discovery-1" })
    const result = await run([finding], { "discovery-1": [says({ findingId: "f-1", position: "upholds" })] }, {
      roster: roster(["discovery-1"]),
      answeredSlots: ["discovery-1"],
    })
    expect(finding.exit).toBe("converged")
    expect(result.debated).toBe(1)
  })

  test("NO POSITION IS EVER ASSIGNED — the instruction offers a vocabulary, not a side", async () => {
    // `SPEC.md` forbids telling a debater to oppose. The stage hands every
    // participant the same generalist text and never varies it per seat.
    const instructions: string[] = []
    const recording: ModelBackend = {
      capabilities: () => ({ tools: false }),
      async runTurn(slotId, instructionText, _input, schema) {
        instructions.push(instructionText)
        const parsed = schema.safeParse({
          turns: [{ findingId: "f-1", position: "upholds", argument: "a", citations: [] }],
        })
        return parsed.success
          ? { ok: true, slot: slotId, value: parsed.data, tokens: tokens() }
          : { ok: false, slot: slotId, failure: "schema-invalid", message: "n/a" }
      },
    }
    await run([contested()], {}, { backend: recording, maxRounds: 1 })

    expect(new Set(instructions).size).toBe(1)
    expect(instructions[0]).toBe(CODING_DEBATE_GENERALIST.text)
    const text = instructions[0]!.toLowerCase()
    for (const assigned of ["devil's advocate", "skeptic", "you must disagree", "argue against"]) {
      expect(text).not.toContain(assigned)
    }
  })
})

describe("debate — AD-17a: the lens is out of scope here", () => {
  test("MATRIX: a lens author debates as an AUTHOR, and the lens text is never passed", async () => {
    const lensText = [...CODING_LENS_INSTRUCTIONS.values()][0]!.text
    const instructions: string[] = []
    const prompts: string[] = []
    const recording: ModelBackend = {
      capabilities: () => ({ tools: false }),
      async runTurn(slotId, instructionText, promptInput, schema) {
        instructions.push(instructionText)
        prompts.push(promptInput)
        const parsed = schema.safeParse({
          turns: [{ findingId: "f-1", position: "upholds", argument: "a", citations: [] }],
        })
        return parsed.success
          ? { ok: true, slot: slotId, value: parsed.data, tokens: tokens() }
          : { ok: false, slot: slotId, failure: "schema-invalid", message: "n/a" }
      },
    }
    // A CRITICAL lens finding is the one that reaches debate (CAP-3 rule 1).
    const finding = contested({
      author: "discovery-lens-security",
      source: "lens",
      lens: "security",
      severity: "critical",
    })
    finding.coDiscovery = undefined

    await run([finding], {}, {
      backend: recording,
      roster: roster(["discovery-1"], ["security"]),
      answeredSlots: ["discovery-1", "discovery-lens-security"],
      maxRounds: 1,
    })

    // (a) The instruction is the generalist, for every seat, and is not a lens set.
    expect(new Set(instructions)).toEqual(new Set([CODING_DEBATE_GENERALIST.text]))
    for (const text of instructions) expect(text).not.toBe(lensText)
    // (b) The lens does not reach the PROMPT either — not as text, and not
    // smuggled in through the slot id, which is where AD-17 says the leak hides.
    for (const prompt of prompts) {
      expect(prompt).not.toContain("security")
      expect(prompt).not.toContain("discovery-lens")
      expect(prompt).toContain("participant 1")
    }
    // The finding still carries its lens — debate reads it and writes nothing.
    expect(finding.lens).toBe("security")
    expect(finding.source).toBe("lens")
  })

  test("the transcript labels speakers `participant N`, never by slot id", async () => {
    const prompts: string[] = []
    const recording: ModelBackend = {
      capabilities: () => ({ tools: false }),
      async runTurn(slotId, _instructions, promptInput, schema) {
        prompts.push(promptInput)
        const parsed = schema.safeParse({
          turns: [{ findingId: "f-1", position: slotId === "discovery-1" ? "upholds" : "denies", argument: "a", citations: [] }],
        })
        return parsed.success
          ? { ok: true, slot: slotId, value: parsed.data, tokens: tokens() }
          : { ok: false, slot: slotId, failure: "schema-invalid", message: "n/a" }
      },
    }
    await run([contested()], {}, { backend: recording, maxRounds: 2 })

    const roundTwo = prompts.slice(2)
    expect(roundTwo.length).toBeGreaterThan(0)
    for (const prompt of roundTwo) {
      expect(prompt).toContain("Exchange so far:")
      expect(prompt).toContain("participant 1")
      expect(prompt).not.toContain("discovery-1")
      expect(prompt).not.toContain("discovery-2")
    }
  })
})

describe("debate — AD-6d: the budget runs out, and nothing is dropped", () => {
  test("MATRIX: the ledger refuses the next round → unresolved, warned, and NO further turns", async () => {
    // `tokens()` bills 30 per turn, so a cap of 40 permits round 1 (spend 0 < 40)
    // and refuses round 2 (spend 60 >= 40).
    const ledger = emptyLedger(40) as BudgetLedger
    const findings = [contested({ id: "f-1" }), contested({ id: "f-2" })]
    const backend = new FakeBackend({
      "discovery-1": [says({ findingId: "f-1", position: "upholds" }, { findingId: "f-2", position: "upholds" })],
      "discovery-2": [says({ findingId: "f-1", position: "denies" }, { findingId: "f-2", position: "denies" })],
    })
    const result = await run(findings, {}, { backend, ledger, maxRounds: 3 })

    expect(mayISpend(ledger)).toBe(false)
    expect(result.rounds).toBe(1)
    expect(backend.calls).toHaveLength(2)

    for (const finding of findings) {
      expect(finding.unresolved).toEqual({
        diedAtStage: "debate",
        reason: expect.stringContaining("token budget"),
      })
      // AD-6d — no `exit`, because no exit happened. Absence is the fact.
      expect(finding.exit).toBeUndefined()
      // Nothing was dropped, and the evidence it accumulated is still there.
      expect(roundEntries(finding).length).toBeGreaterThan(0)
    }
    expect(result.findings).toHaveLength(2)
    expect(result.unresolved).toBe(2)

    const warning = result.warnings.find((w) => w.code === "unresolved-findings")!
    expect(warning.stage).toBe("debate")
    expect(warning.message).toContain("40")
    expect(warning.detail?.findings).toEqual(["f-1", "f-2"])
  })

  test("EXHAUSTION IS NOT AN ERROR — the stage returns normally and says where it stopped", async () => {
    const ledger = emptyLedger(0) as BudgetLedger
    const finding = contested()
    const result = await run([finding], { "discovery-1": [says({ findingId: "f-1", position: "upholds" })] }, {
      ledger,
      maxRounds: 3,
    })
    expect(result.rounds).toBe(0)
    expect(result.turns).toBe(0)
    expect(finding.unresolved?.diedAtStage).toBe("debate")
    expect(result.warnings.some((w) => w.code === "unresolved-findings")).toBe(true)
  })

  test("a finding that ALREADY exited before the money ran out keeps its exit", async () => {
    // Exhaustion strands the undecided; it does not retroactively undecide
    // anything that had already settled.
    const ledger = emptyLedger(40) as BudgetLedger
    const settled = contested({ id: "f-1" })
    const open = contested({ id: "f-2" })
    await run([settled, open], {
      "discovery-1": [
        says({ findingId: "f-1", position: "upholds" }, { findingId: "f-2", position: "upholds" }),
      ],
      "discovery-2": [
        says({ findingId: "f-1", position: "upholds" }, { findingId: "f-2", position: "denies" }),
      ],
    }, { ledger, maxRounds: 3 })

    expect(settled.exit).toBe("converged")
    expect(settled.unresolved).toBeUndefined()
    expect(open.exit).toBeUndefined()
    expect(open.unresolved?.diedAtStage).toBe("debate")
  })

  test("an uncapped ledger never refuses, so story 4's callers are unchanged", async () => {
    const ledger = emptyLedger() as BudgetLedger
    const finding = contested()
    const result = await run([finding], {
      "discovery-1": [says({ findingId: "f-1", position: "upholds" })],
      "discovery-2": [
        says({ findingId: "f-1", position: "denies" }),
        says({ findingId: "f-1", position: "unsure" }),
        says({ findingId: "f-1", position: "denies" }),
      ],
    }, { ledger, maxRounds: 3 })

    expect(result.unresolved).toBe(0)
    expect(finding.unresolved).toBeUndefined()
    expect(finding.exit).toBe("cap")
  })
})

describe("debate — what it must NOT touch (AD-8, AD-10, AD-7, AD-9)", () => {
  test("MATRIX: a `route: 'judge'` finding is BYTE-IDENTICAL afterwards", async () => {
    const judged = contested({ id: "f-2", route: "judge" })
    const before = structuredClone(judged)
    const debated = contested({ id: "f-1" })

    const result = await run([debated, judged], {
      "discovery-1": [says({ findingId: "f-1", position: "upholds" })],
      "discovery-2": [says({ findingId: "f-1", position: "upholds" })],
    })

    expect(judged).toEqual(before)
    expect(judged.exit).toBeUndefined()
    expect(judged.history).toHaveLength(before.history.length)
    // ...and it was not counted as a debate either.
    expect(result.debated).toBe(1)
  })

  test("severity, coDiscovery, clusterSeverity, clusterId, route and rank are unwritten", async () => {
    const finding = contested()
    finding.clusterSeverity = "critical"
    finding.rank = 7
    const before = {
      severity: finding.severity,
      clusterSeverity: finding.clusterSeverity,
      coDiscovery: { ...finding.coDiscovery! },
      clusterId: finding.clusterId,
      route: finding.route,
      routeReason: finding.routeReason,
      rank: finding.rank,
      source: finding.source,
      author: finding.author,
      claim: finding.claim,
    }
    await run([finding], {
      "discovery-1": [says({ findingId: "f-1", position: "upholds" })],
      "discovery-2": [says({ findingId: "f-1", position: "upholds" })],
    })

    expect({
      severity: finding.severity,
      clusterSeverity: finding.clusterSeverity,
      coDiscovery: finding.coDiscovery,
      clusterId: finding.clusterId,
      route: finding.route,
      routeReason: finding.routeReason,
      rank: finding.rank,
      source: finding.source,
      author: finding.author,
      claim: finding.claim,
    }).toEqual(before)
  })

  test("AD-8 — the JUDGE's fields stay unset, verdict included", async () => {
    const finding = contested()
    await run([finding], {
      "discovery-1": [says({ findingId: "f-1", position: "withdraws" })],
    })
    expect(finding.exit).toBe("converged")
    // Even for a withdrawal, where `withdrawn-by-author` is sitting right there.
    expect(finding.verdict).toBeUndefined()
    expect(finding.evidence).toBeUndefined()
    expect(finding.factCheck).toBeUndefined()
    expect(finding.logicEval).toBeUndefined()
  })

  test("AD-7 — pre-existing history is never rewritten, only appended to", async () => {
    const finding = contested()
    const before = structuredClone(finding.history)
    await run([finding], {
      "discovery-1": [says({ findingId: "f-1", position: "upholds" })],
      "discovery-2": [says({ findingId: "f-1", position: "upholds" })],
    })
    expect(finding.history.slice(0, before.length)).toEqual(before)
    expect(finding.history.length).toBeGreaterThan(before.length)
  })

  test("EXACTLY ONE EXIT PER DEBATED FINDING, and it is explained in history", async () => {
    const finding = contested()
    await run([finding], {
      "discovery-1": [says({ findingId: "f-1", position: "upholds" })],
      "discovery-2": [says({ findingId: "f-1", position: "upholds" })],
    })
    const exits = finding.history.filter((entry) => entry.kind.startsWith("debate-exit-"))
    expect(exits).toHaveLength(1)
    // The REASON rides in the kind, because `Finding.exit` is three values and
    // three values cannot separate real agreement from an uncontested room.
    expect(exits[0]!.kind).toBe("debate-exit-converged-agreed")
    expect(exits[0]!.actor).toBe("mad")
  })

  test("AD-9 — NO TALLY. No count of who agreed is stored anywhere", async () => {
    // The pattern MAD is defined against. A majority of deniers must not decide
    // anything, and no field on the finding may hold a score.
    const finding = contested({ author: "discovery-1" })
    await run([finding], {
      "discovery-1": [says({ findingId: "f-1", position: "upholds" })],
      "discovery-2": [says({ findingId: "f-1", position: "denies" })],
      "discovery-3": [says({ findingId: "f-1", position: "denies" })],
    }, { maxRounds: 2 })

    // Two deniers to one upholder, and the finding is neither removed nor
    // marked invalid — it exits with a transcript and the judge decides.
    expect(finding.exit).toBe("stalled")
    expect(finding.verdict).toBeUndefined()
    for (const key of ["votes", "score", "confidence", "tally", "agreement"]) {
      expect(Object.keys(finding)).not.toContain(key)
    }
  })

  test("DEBATE NEVER FILTERS — the array returned is the array given", async () => {
    const findings = [contested({ id: "f-1" }), contested({ id: "f-2", route: "judge" })]
    const result = await run(findings, {
      "discovery-1": [says({ findingId: "f-1", position: "withdraws" })],
    })
    expect(result.findings).toBe(findings)
    expect(result.findings).toHaveLength(2)
  })

  test("a turn about a finding the slot was not seated for is DISCARDED", async () => {
    // Batching makes it cheap for a model to answer about a neighbouring
    // finding; applying that would seat it in a room the stage never put it in.
    const mine = contested({ id: "f-1", author: "discovery-1" })
    const theirs = contested({ id: "f-2", author: "discovery-1" })
    theirs.route = "judge"

    await run([mine, theirs], {
      "discovery-1": [
        says({ findingId: "f-1", position: "upholds" }, { findingId: "f-2", position: "denies" }),
      ],
    }, { roster: roster(["discovery-1"]), answeredSlots: ["discovery-1"] })

    expect(roundEntries(mine)).toHaveLength(1)
    expect(roundEntries(theirs)).toHaveLength(0)
  })

  test("a slot answering twice about one finding counts once", async () => {
    const finding = contested({ author: "discovery-1" })
    await run([finding], {
      "discovery-1": [
        says(
          { findingId: "f-1", position: "upholds" },
          { findingId: "f-1", position: "denies" },
        ),
      ],
    }, { roster: roster(["discovery-1"]), answeredSlots: ["discovery-1"] })

    const entries = roundEntries(finding)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.position).toBe("upholds")
  })

  test("a run with NOTHING contested spends no turn and returns zeroed counts", async () => {
    // Zero is not absence: the stage RAN and found nothing to argue about.
    const backend = new FakeBackend({})
    const result = await run([contested({ route: "judge" })], {}, { backend })
    expect(backend.calls).toHaveLength(0)
    expect(result.debated).toBe(0)
    expect(result.rounds).toBe(0)
    expect(result.turns).toBe(0)
  })
})

describe("debate — the envelope must survive a STRICT structured-output provider", () => {
  test("`citations` IS NOT REQUIRED in the JSON Schema the adapter sends", () => {
    // `adapters/opencode/model-backend.ts` calls `z.toJSONSchema(schema)` and
    // sends the result as `format: {type: "json_schema"}`. A `.default([])` lands
    // in the schema's `required` list, so under a provider that enforces the
    // schema strictly a model that cites nothing has its whole turn REJECTED —
    // for omitting a field Zod would have filled in itself. This test runs the
    // real conversion the adapter runs.
    const json = z.toJSONSchema(debateEnvelopeSchema) as Record<string, any>
    const turn = json.properties.turns.items
    expect(turn.required).toContain("findingId")
    expect(turn.required).toContain("position")
    expect(turn.required).toContain("argument")
    expect(turn.required).not.toContain("citations")
    expect(turn.required).not.toContain("concession")
  })

  test("an omitted citations list parses and normalizes to `[]` after the parse", async () => {
    const finding = contested({ author: "discovery-1" })
    await run([finding], {
      // No `citations` key at all — the shape a strict provider would produce.
      "discovery-1": [
        { kind: "ok", value: { turns: [{ findingId: "f-1", position: "upholds", argument: "yes" }] } },
      ],
    }, { roster: roster(["discovery-1"]), answeredSlots: ["discovery-1"] })

    const entry = roundEntries(finding)[0]!
    expect(entry.position).toBe("upholds")
    // One shape for every downstream reader, normalized where it cannot reach
    // the wire.
    expect(entry.citations).toEqual([])
  })
})

describe("debate — a dead slot is dropped for the stage, not re-billed every round", () => {
  test("A SLOT THAT FAILED TWICE IS NOT ASKED AGAIN", async () => {
    // It previously stayed in the fan-out and silently cost 2 attempts per
    // remaining round — up to ten wasted billed calls at the round ceiling, from
    // a slot the run had already reported as gone.
    //
    // Three seats, so the debate has a live disagreement to keep it running past
    // round 1: the canonical's author, the co-finder whose copy was absorbed
    // (this is the slot that dies), and the extra seat.
    const canonical = contested({ id: "f-1", author: "discovery-1", mergedIds: ["m-1"] })
    const absorbed: Finding = { ...contested({ id: "m-1", author: "discovery-2" }), route: "judge" }
    const backend = new FakeBackend({
      "discovery-1": [says({ findingId: "f-1", position: "upholds" })],
      "discovery-2": [{ kind: "fail", failure: "model-error", message: "gone" }],
      "discovery-3": [says({ findingId: "f-1", position: "denies" })],
    })
    await run([canonical], {}, { backend, pool: [canonical, absorbed], maxRounds: 3 })

    // Two attempts in round 1 (one retry, AD-6b), and never again — even though
    // the debate itself ran on without it.
    expect(backend.calls.filter((call) => call.slot === "discovery-2")).toHaveLength(2)
    expect(backend.calls.filter((call) => call.slot === "discovery-1").length).toBeGreaterThan(1)
    expect(backend.calls.filter((call) => call.slot === "discovery-3").length).toBeGreaterThan(1)
  })

  test("the warning SAYS it will not be retried, so the message matches the behaviour", async () => {
    const result = await run([contested()], {
      "discovery-1": [says({ findingId: "f-1", position: "upholds" })],
      "discovery-2": [{ kind: "fail", failure: "model-error", message: "gone" }],
    }, { maxRounds: 3 })
    const dropped = result.warnings.find((w) => w.code === "model-dropped-out")!
    expect(dropped.message).toContain("NOT asked again in any later round")
  })
})

describe("debate — allocations vs billed attempts (AD-15)", () => {
  test("A RETRIED TURN IS ONE ALLOCATION AND TWO BILLED ATTEMPTS", async () => {
    const ledger = emptyLedger() as BudgetLedger
    const finding = contested({ author: "discovery-1" })
    const result = await run([finding], {
      "discovery-1": [
        // Fails once, succeeds on the retry. `FakeBackend`'s fail step carries
        // tokens, exactly as a real provider error does.
        { kind: "fail", failure: "model-error", message: "transient" },
        says({ findingId: "f-1", position: "upholds" }),
      ],
    }, { ledger, roster: roster(["discovery-1"]), answeredSlots: ["discovery-1"], maxRounds: 1 })

    expect(result.turns).toBe(1)
    expect(result.attempts).toBe(2)
    // THE LEDGER IS WRITTEN ON EVERY ATTEMPT THAT REPORTED TOKENS, failures
    // included — the under-reporting `runDebateTurn`'s doc exists to prevent.
    const rows = ledger.entries.filter((entry) => entry.stage === "debate")
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.attempt)).toEqual([1, 2])
    expect(spent(ledger)).toBe(60)
    // ...and the retry did not cost the round: the position landed.
    expect(roundEntries(finding)).toHaveLength(1)
  })

  test("a failed attempt with tokens is billed even when the slot then drops out", async () => {
    const ledger = emptyLedger() as BudgetLedger
    const result = await run([contested()], {
      "discovery-1": [says({ findingId: "f-1", position: "upholds" })],
      "discovery-2": [{ kind: "fail", failure: "model-error", message: "gone" }],
    }, { ledger, maxRounds: 1 })

    // 1 (discovery-1) + 2 (discovery-2's attempt and its retry) = 3 billed rows
    // against 2 allocations.
    expect(result.turns).toBe(2)
    expect(result.attempts).toBe(3)
    expect(ledger.entries.filter((entry) => entry.stage === "debate")).toHaveLength(3)
  })
})

describe("debate — the record cannot lie about itself", () => {
  test("THE COUNT IDENTITY HOLDS: debated === converged + stalled + cap + unresolved", async () => {
    // Stated as "always" in `run-record.ts` and pinned here. The two converged
    // SUBSETS are deliberately excluded from the sum — adding them would
    // double-count.
    const findings = [
      contested({ id: "f-1" }),
      contested({ id: "f-2" }),
      contested({ id: "f-3", route: "judge" }),
    ]
    const result = await run(findings, {
      "discovery-1": [says({ findingId: "f-1", position: "upholds" }, { findingId: "f-2", position: "upholds" })],
      "discovery-2": [says({ findingId: "f-1", position: "upholds" }, { findingId: "f-2", position: "denies" })],
    }, { maxRounds: 2 })

    expect(result.debated).toBe(result.converged + result.stalled + result.cap + result.unresolved)
    expect(result.debated).toBe(2)
    expect(result.convergedUncontested).toBeLessThanOrEqual(result.converged)
    expect(result.convergedUnsure).toBeLessThanOrEqual(result.converged)
  })

  test("an OFF-VOCABULARY position on the record is ignored, not cast into the exit test", async () => {
    // `Entry.position` is a plain `string?` on the shared append-only record, so
    // a future writer (story 6's judge, a v2 replay) could put anything there.
    // An unchecked cast would let it join the agreement test and corrupt an exit
    // with no error anywhere.
    const finding = contested({ author: "discovery-1" })
    finding.history.push({
      stage: "debate",
      actor: "discovery-2",
      at: "t0",
      kind: "debate-round",
      body: "written by some other stage",
      round: 1,
      position: "somewhat-agrees",
      citations: [],
    })

    await run([finding], {
      "discovery-1": [says({ findingId: "f-1", position: "upholds" })],
      "discovery-2": [says({ findingId: "f-1", position: "upholds" })],
    }, { maxRounds: 1 })

    // Two REAL voices agreeing, so `agreed` — the junk entry neither joined the
    // agreement nor blocked it.
    expect(finding.exit).toBe("converged")
    expect(exitKind(finding)).toBe("debate-exit-converged-agreed")
  })

  test("A CO-FINDER'S WITHDRAWAL IS RECORDED ACCURATELY — it did raise something", async () => {
    // The canonical's author owns the finding; a co-finder authored a member
    // clustering absorbed. Telling it "only a finding's author can withdraw it"
    // is simply false about that slot, even though the outcome is right.
    const canonical = contested({ id: "f-1", author: "discovery-1", mergedIds: ["m-1"] })
    const absorbed: Finding = { ...contested({ id: "m-1", author: "discovery-2" }), route: "judge" }

    await run([canonical], {
      "discovery-1": [says({ findingId: "f-1", position: "upholds" })],
      "discovery-2": [says({ findingId: "f-1", position: "withdraws" })],
    }, { pool: [canonical, absorbed], maxRounds: 1 })

    const coFinder = roundEntries(canonical).find((entry) => entry.actor === "discovery-2")!
    // The SEMANTICS are unchanged: it cannot kill the canonical.
    expect(coFinder.position).toBe("denies")
    expect(canonical.exit).not.toBe("converged")
    // The WORDS are accurate about what this slot actually did.
    expect(coFinder.body).toContain("co-found the cluster")
    expect(coFinder.body).toContain("only its author can")
    expect(coFinder.body).not.toContain("only a finding's author can withdraw it]")
  })

  test("a bystander's withdrawal still gets the plain message", async () => {
    const finding = contested({ id: "f-1", author: "discovery-1" })
    await run([finding], {
      "discovery-1": [says({ findingId: "f-1", position: "upholds" })],
      "discovery-2": [says({ findingId: "f-1", position: "withdraws" })],
    }, { maxRounds: 1 })
    const bystander = roundEntries(finding).find((entry) => entry.actor === "discovery-2")!
    expect(bystander.body).toContain("only a finding's author can withdraw it")
    expect(bystander.body).not.toContain("co-found")
  })

  test("EVERY SEAT is filtered through answeredSlots, not only the extra one", async () => {
    // A model that already failed twice produces a warning, not a contest — the
    // stated rationale for filtering the extra seat, which applies identically
    // to an author and a co-finder.
    const finding = contested({ id: "f-1", author: "discovery-1", mergedIds: ["m-1"] })
    const absorbed: Finding = { ...contested({ id: "m-1", author: "discovery-2" }), route: "judge" }
    const backend = new FakeBackend({
      "discovery-3": [says({ findingId: "f-1", position: "upholds" })],
    })
    await run([finding], {}, {
      backend,
      pool: [finding, absorbed],
      // Neither the author nor the co-finder answered discovery.
      answeredSlots: ["discovery-3"],
      maxRounds: 1,
    })

    expect(backend.calls.map((call) => call.slot)).toEqual(["discovery-3"])
  })

  test("the extra seat is picked in ROSTER order, not in the caller's array order", async () => {
    const finding = contested({ author: "discovery-3" })
    const backend = new FakeBackend({
      "discovery-1": [says({ findingId: "f-1", position: "upholds" })],
      "discovery-2": [says({ findingId: "f-1", position: "upholds" })],
      "discovery-3": [says({ findingId: "f-1", position: "upholds" })],
    })
    await run([finding], {}, {
      backend,
      // Deliberately NOT in roster order — the stage must sort it itself.
      answeredSlots: ["discovery-2", "discovery-3", "discovery-1"],
      maxRounds: 1,
    })

    // discovery-1 is first in the ROSTER, so it takes the one extra seat.
    expect([...new Set(backend.calls.map((call) => call.slot))].sort()).toEqual([
      "discovery-1",
      "discovery-3",
    ])
  })
})

describe("clampMaxRounds — the bound is tested, not trusted", () => {
  test("absent and NaN fall back to the default", () => {
    expect(clampMaxRounds(undefined)).toBe(DEFAULT_MAX_ROUNDS)
    expect(clampMaxRounds(Number.NaN)).toBe(DEFAULT_MAX_ROUNDS)
  })

  test("anything that is not a number is absent — `null` must not become 1", () => {
    // `review()` is an exported seam and TypeScript does not police a JavaScript
    // caller. `Math.max(null, 1)` is `1` — the shortest possible debate, from a
    // caller that asked for nothing.
    expect(clampMaxRounds(null as unknown as number)).toBe(DEFAULT_MAX_ROUNDS)
    expect(clampMaxRounds("3" as unknown as number)).toBe(DEFAULT_MAX_ROUNDS)
  })

  test("out of range is CLAMPED, not defaulted", () => {
    expect(clampMaxRounds(0)).toBe(1)
    expect(clampMaxRounds(-5)).toBe(1)
    expect(clampMaxRounds(99)).toBe(MAX_DEBATE_ROUNDS)
  })

  test("fractions floor — 2.9 rounds is 2 rounds you can afford", () => {
    expect(clampMaxRounds(2.9)).toBe(2)
    expect(clampMaxRounds(1.1)).toBe(1)
  })

  test("in-range values pass through", () => {
    expect(clampMaxRounds(1)).toBe(1)
    expect(clampMaxRounds(DEFAULT_MAX_ROUNDS)).toBe(DEFAULT_MAX_ROUNDS)
    expect(clampMaxRounds(MAX_DEBATE_ROUNDS)).toBe(MAX_DEBATE_ROUNDS)
  })

  test("the stage reports the CLAMPED value it actually ran under", async () => {
    const result = await run([contested({ route: "judge" })], {}, { maxRounds: 99 })
    expect(result.maxRounds).toBe(MAX_DEBATE_ROUNDS)
  })
})
