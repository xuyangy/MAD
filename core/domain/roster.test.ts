/**
 * The roster domain's own helper.
 *
 * `core/roster/select.test.ts` covers SELECTION. This covers `modelNameOf`, which
 * is a read over an already-built roster and is what AD-6(b)'s "a warning naming
 * it" resolves to in two stages.
 */

import { describe, expect, test } from "bun:test"

import {
  MODEL_AMBIGUOUS,
  MODEL_UNRESOLVED,
  modelNameOf,
  type LensSlot,
  type Roster,
  type RosterSlot,
} from "./roster.ts"

function slot(id: string, providerId: string, modelId: string): RosterSlot {
  return {
    slot: id,
    providerId,
    modelId,
    identity: modelId,
    lineage: { lineage: modelId, label: modelId, verified: true },
    toolcall: true,
    alsoAvailableVia: [],
  }
}

const ROSTER: Roster = {
  slots: [slot("discovery-1", "anthropic", "claude-sonnet-4-5"), slot("discovery-2", "openai", "gpt-5")],
  lensSlots: [{ ...slot("discovery-lens-security", "google", "gemini-2.5-pro"), lens: "security" } as LensSlot],
  requested: 2,
  distinctLineages: 2,
  providers: ["anthropic", "openai", "google"],
}

describe("modelNameOf (AD-6b)", () => {
  test("a POOL slot resolves to `providerId/modelId`", () => {
    expect(modelNameOf(ROSTER, "discovery-1")).toBe("anthropic/claude-sonnet-4-5")
    expect(modelNameOf(ROSTER, "discovery-2")).toBe("openai/gpt-5")
  })

  test("A LENS SLOT RESOLVES TOO — it fills from the same list and drops out the same way", () => {
    // The term a reviewer demonstrated could be deleted with every test still
    // green (code review 2026-08-30). A lens model's drop-out reported as
    // "not on the roster" is AD-6(b) answered with a denial that it exists.
    // `core/stages/debate.test.ts` drives the same fact through the stage.
    expect(modelNameOf(ROSTER, "discovery-lens-security")).toBe("google/gemini-2.5-pro")
  })

  test("A SLOT THE ROSTER DOES NOT HOLD says so, rather than echoing the slot id", () => {
    // Unreachable through either calling stage — their slot ids come from the
    // roster — and covered here rather than left as an untested branch whose
    // output would otherwise be prose in a field that everywhere else holds a
    // `provider/model` id.
    expect(modelNameOf(ROSTER, "discovery-9")).toBe(MODEL_UNRESOLVED)
    expect(modelNameOf(ROSTER, "")).toBe(MODEL_UNRESOLVED)
  })

  test("A SLOT ID CLAIMED BY BOTH COLLECTIONS says AMBIGUOUS, not the first match", () => {
    // `slots` and `lensSlots` are disjoint by construction (AD-4 amended), so
    // this is unreachable today — covered here rather than left as an untested
    // branch, exactly as the unresolved case above is.
    //
    // The old `find` took the FIRST match silently, so a broken invariant became
    // an AD-6(b) warning CONFIDENTLY NAMING THE WRONG MODEL (epic-1 retrospective
    // ledger triage, entry 38). A wrong name is worse than no name: AD-6 exists
    // so a degraded review is never indistinguishable from a good one, and a
    // plausible wrong name is precisely indistinguishable.
    const collided: Roster = {
      ...ROSTER,
      lensSlots: [{ ...slot("discovery-1", "google", "gemini-2.5-pro"), lens: "security" } as LensSlot],
    }
    expect(modelNameOf(collided, "discovery-1")).toBe(MODEL_AMBIGUOUS)

    // NOT VACUOUS: the same roster still resolves every UNAMBIGUOUS id normally,
    // so the branch is reached by collision and not by the fixture being broken.
    expect(modelNameOf(collided, "discovery-2")).toBe("openai/gpt-5")
    expect(modelNameOf(collided, "discovery-9")).toBe(MODEL_UNRESOLVED)
  })

  test("it reads the SLOT ID, never a substring of one", () => {
    expect(modelNameOf(ROSTER, "discovery-")).toBe(MODEL_UNRESOLVED)
    expect(modelNameOf(ROSTER, "discovery-1 ")).toBe(MODEL_UNRESOLVED)
  })
})
