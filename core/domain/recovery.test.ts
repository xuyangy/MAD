/**
 * The recovery record's invariants, the recovery plan's, and the two views
 * derived from a record, over hand-built records. Discovery producing them is
 * covered in `adapters/opencode/recovery-discover.test.ts`.
 */

import { describe, expect, test } from "bun:test"

import { candidate } from "../test-support/fakes.ts"
import { selectRoster } from "../roster/select.ts"
import {
  executionProviders,
  executionRoster,
  heldReplacementCount,
  recoverySummary,
  refusalExclusions,
  replacementsOf,
  validateRecoveryPlan,
  validateReplacements,
  type RunRecovery,
} from "./recovery.ts"
import type { Refusal } from "./refusal.ts"
import { modelNameOf, type RosterSlot } from "./roster.ts"

const selected = selectRoster(
  [
    candidate("gitlab", "duo-chat-gpt-5-6-terra"),
    candidate("anthropic", "claude-sonnet-4-5"),
    candidate("openrouter", "amazon/nova-pro-v1"),
    candidate("google", "gemini-2.5-pro"),
    candidate("openrouter", "google/gemini-2.5-pro"),
    candidate("xai", "grok-4"),
  ],
  { slots: 3, lenses: ["security"], providerConfigKey: "provider", requireToolcall: true },
)
const roster = selected.roster
const [gitlabSlot] = roster.slots.filter((slot) => slot.providerId === "gitlab")
const reserve = selected.recovery.candidates

function refusalOf(slot: RosterSlot, scope: Refusal["scope"] = "provider"): Refusal {
  return { kind: "payment", basis: "host-signature", scope, providerId: slot.providerId, modelId: slot.modelId }
}

function recordWith(recovery: RunRecovery | undefined) {
  return recovery === undefined ? { roster } : { roster, recovery }
}

const replacementRoute = reserve.find((route) => route.providerId === "xai")!
const VALID: RunRecovery = {
  refused: [{ slot: gitlabSlot!.slot, refusal: refusalOf(gitlabSlot!) }],
  replacements: [{ from: gitlabSlot!.slot, to: replacementRoute, dispatched: 1, answered: true }],
  notReplaced: [],
  answeredLineages: 3,
}

describe("the views", () => {
  test("with no recovery, the execution roster IS the initial roster, and nothing is replaced", () => {
    expect(executionRoster(recordWith(undefined))).toBe(roster)
    expect(replacementsOf(recordWith(undefined))).toEqual([])
    expect(executionProviders(recordWith(undefined))).toEqual(roster.providers)
  })

  test("a dispatched replacement joins the pool after the initial slots; lens slots, requested and lineages stay initial", () => {
    const execution = executionRoster(recordWith(VALID))
    expect(execution.slots.map((slot) => slot.slot)).toEqual([...roster.slots.map((slot) => slot.slot), replacementRoute.slot])
    expect(execution.lensSlots).toBe(roster.lensSlots)
    expect(execution.requested).toBe(roster.requested)
    expect(execution.distinctLineages).toBe(roster.distinctLineages)
    expect(modelNameOf(execution, replacementRoute.slot)).toBe(`xai/${replacementRoute.modelId}`)
    // The persisted selection is untouched.
    expect(roster.slots.some((slot) => slot.slot === replacementRoute.slot)).toBe(false)
  })

  test("providers are the initial ones plus each dispatched replacement's, never an unused reserve route's", () => {
    expect(executionProviders(recordWith(VALID))).toEqual([...roster.providers, "xai"])
    const reserveProviders = new Set(reserve.map((route) => route.providerId))
    const unused = [...reserveProviders].filter((provider) => provider !== "xai" && !roster.providers.includes(provider))
    for (const provider of unused) expect(executionProviders(recordWith(VALID))).not.toContain(provider)
  })
})

describe("validateReplacements — each invariant", () => {
  const otherSlot = roster.slots.find((slot) => slot.providerId !== "gitlab")!
  const cases: [string, RunRecovery, string][] = [
    [
      "a refused slot that is not an original pool slot",
      { ...VALID, refused: [{ slot: "discovery-9", refusal: refusalOf(gitlabSlot!) }], replacements: [] },
      "not an original pool slot",
    ],
    ["a slot refused twice", { ...VALID, refused: [...VALID.refused, ...VALID.refused], replacements: [] }, "refused twice"],
    [
      "a refusal naming another route",
      { ...VALID, refused: [{ slot: gitlabSlot!.slot, refusal: refusalOf(otherSlot) }], replacements: [] },
      "names another route",
    ],
    ["a replacement from a slot that was not refused", { ...VALID, refused: [] }, "was not refused"],
    [
      "a slot replaced twice",
      { ...VALID, replacements: [VALID.replacements[0]!, { ...VALID.replacements[0]!, to: { ...replacementRoute, slot: "discovery-r99", identity: "other" } }] },
      "replaced twice",
    ],
    [
      "a replacement id that collides with a lens slot",
      { ...VALID, replacements: [{ ...VALID.replacements[0]!, to: { ...replacementRoute, slot: roster.lensSlots[0]!.slot } }] },
      "collides",
    ],
    [
      "a replacement id that collides with a pool slot",
      { ...VALID, replacements: [{ ...VALID.replacements[0]!, to: { ...replacementRoute, slot: otherSlot.slot } }] },
      "collides",
    ],
    [
      "a replacement reusing an original model",
      {
        ...VALID,
        replacements: [
          { ...VALID.replacements[0]!, to: { ...replacementRoute, modelId: otherSlot.modelId, identity: otherSlot.identity } },
        ],
      },
      "reuses model",
    ],
    [
      "a replacement whose identity is not its model's",
      { ...VALID, replacements: [{ ...VALID.replacements[0]!, to: { ...replacementRoute, identity: "a-new-name" } }] },
      "but its model",
    ],
    [
      "a slot listed as not replaced twice",
      {
        ...VALID,
        replacements: [],
        notReplaced: [
          { from: gitlabSlot!.slot, reason: "budget" },
          { from: gitlabSlot!.slot, reason: "no-candidate" },
        ],
      },
      "not replaced twice",
    ],
    [
      "a replacement through the provider that refused at provider scope",
      { ...VALID, replacements: [{ ...VALID.replacements[0]!, to: { ...replacementRoute, providerId: "gitlab" } }] },
      "refused at provider scope",
    ],
    [
      "a dispatch count that is not 1 or 2",
      { ...VALID, replacements: [{ ...VALID.replacements[0]!, dispatched: 3 as never }] },
      "dispatched 3",
    ],
    ["a not-replaced slot that was not refused", { ...VALID, replacements: [], notReplaced: [{ from: otherSlot.slot, reason: "no-candidate" }] }, "was not refused"],
    [
      "a slot both replaced and not replaced",
      { ...VALID, notReplaced: [{ from: gitlabSlot!.slot, reason: "budget" }] },
      "both replaced and not replaced",
    ],
    [
      "a refused slot neither replaced nor listed as not replaced",
      { ...VALID, refused: [...VALID.refused, { slot: otherSlot.slot, refusal: refusalOf(otherSlot, "route") }] },
      `refused slot ${otherSlot.slot} is neither replaced nor listed as not replaced`,
    ],
    ["an answered-lineage count above the pool it counts", { ...VALID, answeredLineages: 5 }, "answeredLineages 5"],
    ["a negative answered-lineage count", { ...VALID, answeredLineages: -1 }, "answeredLineages -1"],
    ["a fractional answered-lineage count", { ...VALID, answeredLineages: 1.5 }, "answeredLineages 1.5"],
  ]
  for (const [label, recovery, message] of cases) {
    test(label, () => {
      expect(() => validateReplacements(recordWith(recovery))).toThrow(message)
      expect(() => executionRoster(recordWith(recovery))).toThrow(message)
    })
  }

  test("a provider refused at provider scope for one slot is excluded for every slot's replacement", () => {
    const other = roster.slots.find((slot) => slot.providerId !== "gitlab")!
    const crossed: RunRecovery = {
      refused: [
        { slot: gitlabSlot!.slot, refusal: refusalOf(gitlabSlot!, "provider") },
        { slot: other.slot, refusal: refusalOf(other, "provider") },
      ],
      // The replacement is for the OTHER slot, routed through gitlab.
      replacements: [{ from: other.slot, to: { ...replacementRoute, providerId: "gitlab" }, dispatched: 1, answered: true }],
      notReplaced: [{ from: gitlabSlot!.slot, reason: "no-candidate" }],
      answeredLineages: 2,
    }
    expect(() => validateReplacements(recordWith(crossed))).toThrow("uses provider gitlab, which refused at provider scope")
  })

  test("a case variant of a provider refused at provider scope is the same provider", () => {
    const crossed: RunRecovery = {
      refused: [{ slot: gitlabSlot!.slot, refusal: refusalOf(gitlabSlot!, "provider") }],
      replacements: [{ from: gitlabSlot!.slot, to: { ...replacementRoute, providerId: "GitLab" }, dispatched: 1, answered: true }],
      notReplaced: [],
      answeredLineages: 3,
    }
    expect(() => validateReplacements(recordWith(crossed))).toThrow("uses provider GitLab, which refused at provider scope")
  })

  test("more replacements than original pool slots", () => {
    const small = { ...roster, slots: roster.slots.slice(0, 1) }
    const only = small.slots[0]!
    expect(() =>
      validateReplacements({
        roster: small,
        recovery: {
          refused: [{ slot: only.slot, refusal: refusalOf(only) }],
          replacements: [
            { from: only.slot, to: reserve[0]!, dispatched: 1, answered: false },
            { from: only.slot, to: reserve[1]!, dispatched: 1, answered: false },
          ],
          notReplaced: [],
          answeredLineages: 1,
        },
      }),
    ).toThrow("more replacements than original pool slots")
  })

  test("the valid record passes, and a route-scope refusal may be replaced through the same provider", () => {
    expect(() => validateReplacements(recordWith(VALID))).not.toThrow()
    const routeScope: RunRecovery = {
      refused: [{ slot: gitlabSlot!.slot, refusal: refusalOf(gitlabSlot!, "route") }],
      replacements: [{ from: gitlabSlot!.slot, to: { ...replacementRoute, providerId: "gitlab" }, dispatched: 2, answered: false }],
      notReplaced: [],
      answeredLineages: 2,
    }
    expect(() => validateReplacements(recordWith(routeScope))).not.toThrow()
  })
})

describe("validateRecoveryPlan", () => {
  test("the plan selection produced is consistent", () => {
    expect(() => validateRecoveryPlan(selected.recovery, roster)).not.toThrow()
  })
  const route = reserve[0]!
  const cases: [string, RosterSlot[], string][] = [
    ["an id that is a pool slot's", [{ ...route, slot: roster.slots[0]!.slot }], "collides"],
    ["an id that is a lens slot's", [{ ...route, slot: roster.lensSlots[0]!.slot }], "collides"],
    ["a repeated id", [route, { ...route, modelId: "other-model", identity: "other-model" }], "collides"],
    ["an identity that is not its model's", [{ ...route, identity: "something-else" }], "but its model"],
    [
      "a model the pool already holds",
      [{ ...route, modelId: roster.slots[0]!.modelId, identity: roster.slots[0]!.identity }],
      "the pool already holds",
    ],
  ]
  for (const [label, candidates, message] of cases) {
    test(label, () => {
      expect(() => validateRecoveryPlan({ candidates, pinned: [] }, roster)).toThrow(message)
    })
  }
  test("a pinned id that is not a pool slot's, or is listed twice", () => {
    const pool = roster.slots[0]!.slot
    expect(() => validateRecoveryPlan({ candidates: reserve, pinned: [roster.lensSlots[0]!.slot] }, roster)).toThrow(
      "is not a pool slot",
    )
    expect(() => validateRecoveryPlan({ candidates: reserve, pinned: [pool, pool] }, roster)).toThrow("listed twice")
    expect(() => validateRecoveryPlan({ candidates: reserve, pinned: [pool] }, roster)).not.toThrow()
  })
})

describe("the recovery summary a host reads", () => {
  test("counts dispatched replacements and those that answered, separately from the initial selection", () => {
    expect(recoverySummary(VALID)).toEqual({
      refused: 1,
      replacementsDispatched: 1,
      replacementsAnswered: 1,
      notReplaced: {},
      answeredLineages: 3,
    })
    expect(roster.distinctLineages).toBe(3)
  })

  test("a replacement dispatched but unanswered is counted as dispatched and not as answered", () => {
    const summary = recoverySummary({
      ...VALID,
      replacements: [{ ...VALID.replacements[0]!, answered: false }],
      answeredLineages: 2,
    })
    expect(summary.replacementsDispatched).toBe(1)
    expect(summary.replacementsAnswered).toBe(0)
  })

  test("a refused slot with no replacement is counted by its reason, never as dispatched", () => {
    const summary = recoverySummary({ ...VALID, replacements: [], notReplaced: [{ from: gitlabSlot!.slot, reason: "budget" }], answeredLineages: 2 })
    expect(summary).toEqual({ refused: 1, replacementsDispatched: 0, replacementsAnswered: 0, notReplaced: { budget: 1 }, answeredLineages: 2 })
  })

  test("held replacements are the ones a gate refused: budget, admission or the unknown-usage stop, and nothing else", () => {
    const record = (reason: "budget" | "admission" | "unknown-usage" | "cancelled" | "no-candidate" | "pinned" | "no-plan") => ({
      recovery: { ...VALID, replacements: [], notReplaced: [{ from: gitlabSlot!.slot, reason }] },
    })
    expect(heldReplacementCount(record("budget"))).toBe(1)
    expect(heldReplacementCount(record("admission"))).toBe(1)
    expect(heldReplacementCount(record("unknown-usage"))).toBe(1)
    for (const reason of ["cancelled", "no-candidate", "pinned", "no-plan"] as const) {
      expect(heldReplacementCount(record(reason))).toBe(0)
    }
    expect(heldReplacementCount({})).toBe(0)
  })
})

describe("refusalExclusions", () => {
  const refusal = (scope: Refusal["scope"], providerId: string, modelId: string): Refusal => ({
    kind: "auth",
    basis: "structured",
    scope,
    providerId,
    modelId,
  })

  test("a provider-scope refusal excludes every model through any case variant of its provider", () => {
    const excluded = refusalExclusions([refusal("provider", "GitLab", "duo-chat-gpt-5-6-terra")])
    expect(excluded({ providerId: "gitlab", modelId: "mistral-large" })).toBe("provider")
    expect(excluded({ providerId: "GITLAB", modelId: "duo-chat-gpt-5-6-terra" })).toBe("provider")
    expect(excluded({ providerId: "xai", modelId: "grok-4" })).toBeUndefined()
  })

  test("a route-scope refusal excludes its model through a case variant of its provider, and nothing else", () => {
    const excluded = refusalExclusions([refusal("route", "openrouter", "amazon/nova-pro-v1")])
    expect(excluded({ providerId: "OpenRouter", modelId: "amazon/nova-pro-v1" })).toBe("route")
    // Model ids compare exactly: another model, or another spelling of one, is another route.
    expect(excluded({ providerId: "OpenRouter", modelId: "google/gemini-2.5-pro" })).toBeUndefined()
    expect(excluded({ providerId: "openrouter", modelId: "Amazon/Nova-Pro-V1" })).toBeUndefined()
    expect(excluded({ providerId: "anthropic", modelId: "amazon/nova-pro-v1" })).toBeUndefined()
  })
})
