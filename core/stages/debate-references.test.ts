/**
 * Plan item B5a — the opt-in debate references experiment: MAD's entry ids,
 * the citations a speaker may give for a change of position, and the flag MAD
 * computes. Off, debate is exactly what it was.
 */

import { describe, expect, test } from "bun:test"
import type { ZodType } from "zod"

import type { BudgetLedger } from "../budget/ledger.ts"
import type { Entry, Finding } from "../domain/finding.ts"
import type { Roster, RosterSlot } from "../domain/roster.ts"
import { emptyLedger } from "../domain/run-record.ts"
import type { ModelBackend } from "../ports/model-backend.ts"
import { fakeClock, FakeBackend, type SlotScript, type SlotStep } from "../test-support/fakes.ts"
import {
  debate,
  debateEnvelopeSchema,
  debateEnvelopeWithReferencesSchema,
  MAX_REFERENCE_LENGTH,
  MAX_REFERENCES,
  type DebateInput,
} from "./debate.ts"

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

const ROSTER: Roster = {
  slots: ["discovery-1", "discovery-2", "discovery-3"].map(slot),
  lensSlots: [],
  requested: 3,
  distinctLineages: 3,
  providers: ["provider"],
}

function contested(id = "f-1"): Finding {
  return {
    id,
    claim: "the fee is computed before the rate is validated",
    reasoning: "if `rate` is NaN the total silently becomes NaN",
    locus: { file: "src/pay.ts", startLine: 12, endLine: 14 },
    severity: "high",
    author: "discovery-1",
    source: "pool",
    clusterId: `cluster-${id}`,
    coDiscovery: { raised: 1, answered: 3 },
    route: "debate",
    routeReason: "contested",
    history: [{ stage: "discover", actor: "discovery-1", at: "t0", kind: "raised", body: "x" }],
  }
}

type Turn = { findingId: string; position: "upholds" | "denies" | "withdraws" | "unsure"; references?: string[] }

function says(...turns: Turn[]): SlotStep {
  return {
    kind: "ok",
    value: {
      turns: turns.map((turn) => ({
        findingId: turn.findingId,
        position: turn.position,
        argument: `I ${turn.position}.`,
        citations: [],
        ...(turn.references === undefined ? {} : { references: turn.references }),
      })),
    },
  }
}

/** A FakeBackend that also records each prompt and schema it was handed. */
class Recording implements ModelBackend {
  readonly seen: { slot: string; prompt: string; schema: unknown }[] = []
  constructor(private readonly inner: FakeBackend) {}
  capabilities(slotId: string) {
    return this.inner.capabilities(slotId)
  }
  runTurn<T>(...args: Parameters<ModelBackend["runTurn"]>) {
    const [slotId, , prompt, schema] = args
    this.seen.push({ slot: slotId, prompt, schema })
    return this.inner.runTurn(...(args as [string, string, string, ZodType<T>, AbortSignal | undefined, undefined]))
  }
}

async function run(findings: Finding[], scripts: Record<string, SlotScript>, overrides: Partial<DebateInput> = {}) {
  const backend = new Recording(new FakeBackend(scripts))
  const result = await debate({
    findings,
    roster: ROSTER,
    answeredSlots: ["discovery-1", "discovery-2", "discovery-3"],
    backend,
    input: "# Change under review\n\ndiff goes here",
    clock: fakeClock(),
    ledger: emptyLedger() as BudgetLedger,
    maxRounds: 2,
    ...overrides,
  })
  return { result, backend }
}

const rounds = (finding: Finding): Entry[] => finding.history.filter((e) => e.kind === "debate-round")
const entryOf = (finding: Finding, round: number, actor: string) =>
  rounds(finding).find((e) => e.round === round && e.actor === actor)!

/** discovery-1 holds; discovery-2 denies, then upholds in round 2 citing `references`. */
function shiftScripts(references?: string[]): Record<string, SlotScript> {
  return {
    "discovery-1": [says({ findingId: "f-1", position: "upholds" }), says({ findingId: "f-1", position: "upholds" })],
    "discovery-2": [
      says({ findingId: "f-1", position: "denies" }),
      says({ findingId: "f-1", position: "upholds", ...(references === undefined ? {} : { references }) }),
    ],
  }
}

describe("B5a — off is unchanged", () => {
  test("absent and false: the same prompts, the off schema, and entries without any reference field", async () => {
    const plain = contested()
    const offA = await run([plain], shiftScripts())
    const explicit = contested()
    const offB = await run([explicit], shiftScripts(), { references: false })

    expect(offB.backend.seen.map((s) => s.prompt)).toEqual(offA.backend.seen.map((s) => s.prompt))
    expect(offA.backend.seen.every((s) => s.schema === debateEnvelopeSchema)).toBe(true)
    expect(explicit.history).toEqual(plain.history)
    for (const entry of rounds(plain)) {
      for (const key of ["refId", "references", "invalidReferences", "shiftWithoutValidReference"]) {
        expect(key in entry).toBe(false)
      }
    }
    expect(offA.backend.seen.some((s) => s.prompt.includes("[R1E"))).toBe(false)
    expect(offA.backend.seen.some((s) => s.prompt.includes("`references`"))).toBe(false)
  })
})

describe("B5a — on", () => {
  test("entries get room-separated ids, prompts show them and ask for references, and the wider schema is sent", async () => {
    const finding = contested()
    const { backend } = await run([finding], shiftScripts(["R1E1"]), { references: true })

    expect(rounds(finding).map((e) => e.refId)).toEqual(["R1E1", "R1E2", "R1E3", "R1E4"])
    expect(backend.seen.every((s) => s.schema === debateEnvelopeWithReferencesSchema)).toBe(true)
    const round2 = backend.seen.filter((s) => s.prompt.includes("# Debate round 2"))
    expect(round2.length).toBeGreaterThan(0)
    for (const seen of round2) {
      expect(seen.prompt).toContain("- [R1E1] round 1,")
      expect(seen.prompt).toContain("- [R1E2] round 1,")
      expect(seen.prompt).toContain("list in `references` the ids of the earlier entries that changed it")
    }
  })

  test("a shift citing a shown id is recorded with it; a valid id shows existence, not support", async () => {
    // discovery-2 cites its OWN earlier denial: valid, because it was shown and
    // exists, although it cannot be what moved it to uphold.
    const finding = contested()
    await run([finding], shiftScripts(["R1E2"]), { references: true })
    const shifted = entryOf(finding, 2, "discovery-2")
    expect(shifted.positionChanged).toBe(true)
    expect(shifted.references).toEqual(["R1E2"])
    expect(shifted.invalidReferences).toBe(0)
    expect(shifted.shiftWithoutValidReference).toBe(false)
  })

  test("the flag: a shift with no citation is flagged; a restatement and a first position are not", async () => {
    const finding = contested()
    await run([finding], shiftScripts(), { references: true })
    expect(entryOf(finding, 2, "discovery-2").shiftWithoutValidReference).toBe(true)
    expect(entryOf(finding, 2, "discovery-1").positionChanged).toBe(false)
    expect(entryOf(finding, 2, "discovery-1").shiftWithoutValidReference).toBe(false)
    expect(entryOf(finding, 1, "discovery-2").positionChanged).toBe(false)
    expect(entryOf(finding, 1, "discovery-2").shiftWithoutValidReference).toBe(false)
  })

  test("invalid: a nonexistent id, an id appended earlier in the same round, and duplicates count once", async () => {
    // In round 2, discovery-1's turn is appended first and gets R1E3, which
    // discovery-2 was never shown.
    const finding = contested()
    await run([finding], shiftScripts(["R1E9", "R1E3", "R1E9"]), { references: true })
    const shifted = entryOf(finding, 2, "discovery-2")
    expect(entryOf(finding, 2, "discovery-1").refId).toBe("R1E3")
    expect(shifted.references).toEqual([])
    expect(shifted.invalidReferences).toBe(2)
    expect(shifted.shiftWithoutValidReference).toBe(true)
  })

  test("invalid: an id from the other room shown in the same prompt", async () => {
    const one = contested("f-1")
    const two = contested("f-2")
    // Room 2 stays contested (the author upholds, the other seat denies) so it is in round 2 too.
    const both = (position: Turn["position"], onTwo: Turn["position"], references?: string[]): SlotStep =>
      says(
        { findingId: "f-1", position, ...(references === undefined ? {} : { references }) },
        { findingId: "f-2", position: onTwo },
      )
    const { backend } = await run(
      [one, two],
      {
        "discovery-1": [both("upholds", "upholds"), both("upholds", "upholds")],
        "discovery-2": [both("denies", "denies"), both("upholds", "denies", ["R2E1", "R1E1"])],
      },
      { references: true },
    )
    // Both rooms were in discovery-2's round-2 prompt, each with its own ids.
    const prompt = backend.seen.find((s) => s.slot === "discovery-2" && s.prompt.includes("# Debate round 2"))!.prompt
    expect(prompt).toContain("[R1E1]")
    expect(prompt).toContain("[R2E1]")
    const shifted = entryOf(one, 2, "discovery-2")
    expect(shifted.references).toEqual(["R1E1"])
    expect(shifted.invalidReferences).toBe(1)
    expect(rounds(two).map((e) => e.refId)).toEqual(["R2E1", "R2E2", "R2E3", "R2E4"])
  })

  test("invalid: an id on an entry the prompt never showed (a debate-round entry with no round)", async () => {
    const finding = contested()
    finding.history.push({ stage: "debate", actor: "discovery-3", at: "t0", kind: "debate-round", body: "x", refId: "R1E7" })
    const { backend } = await run([finding], shiftScripts(["R1E7"]), { references: true })
    expect(backend.seen.some((s) => s.prompt.includes("R1E7"))).toBe(false)
    const shifted = entryOf(finding, 2, "discovery-2")
    expect(shifted.references).toEqual([])
    expect(shifted.invalidReferences).toBe(1)
  })

  test("bounds on the enabled parse path: too many or too long ids make the turn schema-invalid", async () => {
    const tooMany = Array.from({ length: MAX_REFERENCES + 1 }, (_, i) => `R1E${i + 1}`)
    const tooLong = ["R".repeat(MAX_REFERENCE_LENGTH + 1)]
    for (const references of [tooMany, tooLong]) {
      const finding = contested()
      const bad = says({ findingId: "f-1", position: "upholds", references })
      await run(
        [finding],
        {
          "discovery-1": [says({ findingId: "f-1", position: "upholds" }), says({ findingId: "f-1", position: "upholds" })],
          // Round 2: both attempts carry the over-bound list, so no round-2 entry is recorded for this seat.
          "discovery-2": [says({ findingId: "f-1", position: "denies" }), bad, bad],
        },
        { references: true },
      )
      expect(rounds(finding).some((e) => e.round === 2 && e.actor === "discovery-2")).toBe(false)
    }
    const atLimit = Array.from({ length: MAX_REFERENCES }, (_, i) => `R1E${i + 1}`)
    expect(
      debateEnvelopeWithReferencesSchema.safeParse({
        turns: [{ findingId: "f-1", position: "upholds", argument: "a", references: atLimit }],
      }).success,
    ).toBe(true)
  })
})
