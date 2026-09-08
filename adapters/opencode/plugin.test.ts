import { describe, expect, test } from "bun:test"

import { CODING_LENSES } from "../../core/instructions/coding/lenses.ts"
import {
  clampDiscoverySlots,
  clampLenses,
  clampPins,
  DEFAULT_DISCOVERY_SLOTS,
  MAX_DISCOVERY_SLOTS,
  MAX_LENS_SLOTS,
  truncatedListWarnings,
} from "./plugin.ts"

describe("discovery slot count (AD-3, CAP-1)", () => {
  test("THE DEFAULT FANS OUT TO MORE THAN ONE MODEL", () => {
    // The regression this guards: a default of 1 means a fresh install never
    // runs heterogeneous discovery, and CAP-1 — "pooled recall exceeds any
    // single participating model's" — is unreachable without the user first
    // finding an argument they were never told about (AD-3: configuration is
    // never required for a working run).
    expect(DEFAULT_DISCOVERY_SLOTS).toBeGreaterThan(1)
  })

  test("the default is a whole number within the bound", () => {
    expect(Number.isInteger(DEFAULT_DISCOVERY_SLOTS)).toBe(true)
    expect(DEFAULT_DISCOVERY_SLOTS).toBeLessThanOrEqual(MAX_DISCOVERY_SLOTS)
    expect(MAX_DISCOVERY_SLOTS).toBeGreaterThan(DEFAULT_DISCOVERY_SLOTS)
  })

  test("an absent argument gets the default", () => {
    expect(clampDiscoverySlots(undefined)).toBe(DEFAULT_DISCOVERY_SLOTS)
  })

  test("the value is clamped at BOTH ends", () => {
    // Over the top is an unbounded charge against the user's own credentials;
    // under 1 is a `selectRoster` throw where the user deserves a review.
    expect(clampDiscoverySlots(500)).toBe(MAX_DISCOVERY_SLOTS)
    expect(clampDiscoverySlots(0)).toBe(1)
    expect(clampDiscoverySlots(-4)).toBe(1)
  })

  test("only absent and not-a-number fall back to the default", () => {
    // The infinities are out-of-range requests, not absent ones: `Infinity` asks
    // for more and lands on the maximum. Returning the default there would
    // contradict the doc comment and silently under-serve an explicit request.
    expect(clampDiscoverySlots(Number.POSITIVE_INFINITY)).toBe(MAX_DISCOVERY_SLOTS)
    expect(clampDiscoverySlots(Number.NEGATIVE_INFINITY)).toBe(1)
    expect(clampDiscoverySlots(Number.NaN)).toBe(DEFAULT_DISCOVERY_SLOTS)
    expect(clampDiscoverySlots(undefined)).toBe(DEFAULT_DISCOVERY_SLOTS)
  })

  test("a fractional value truncates rather than rounding up into a billed call", () => {
    expect(clampDiscoverySlots(3.9)).toBe(3)
    expect(clampDiscoverySlots(1.9)).toBe(1)
  })

  test("story 9's control arm is still `slots: 1` — one code path, not two", () => {
    // Story 9 compares the full pipeline against a single model. It asks for one
    // slot through the same tool and the same `review()` seam; nothing about
    // raising the default forecloses that.
    expect(clampDiscoverySlots(1)).toBe(1)
  })

  test("a value inside the range passes through untouched", () => {
    expect(clampDiscoverySlots(2)).toBe(2)
    expect(clampDiscoverySlots(MAX_DISCOVERY_SLOTS)).toBe(MAX_DISCOVERY_SLOTS)
  })
})

describe("discovery lenses (CAP-11, AD-3, AD-15 amended)", () => {
  test("THE DEFAULT IS NO LENSES — a fresh install's cost is unchanged", () => {
    // The regression this guards is the expensive one: lens count multiplies the
    // run's widest fan-out (3 models with 5 lenses is 8 discovery turns, not 3).
    // A default of anything but none makes this capability's existence cost every
    // fresh install money it never asked to spend (AD-3, AD-15 amended).
    expect(clampLenses(undefined)).toEqual([])
    expect(clampLenses([])).toEqual([])
  })

  test("lens ids are deduped, order preserved", () => {
    // Two slots carrying one lens would share a slot id, and paying twice for one
    // persona is not what the caller meant either.
    expect(clampLenses(["security", "tests", "security"])).toEqual(["security", "tests"])
  })

  test("the list is clamped to MAX_LENS_SLOTS", () => {
    const many = Array.from({ length: 40 }, (_, i) => `lens-${i}`)
    expect(clampLenses(many)).toHaveLength(MAX_LENS_SLOTS)
    expect(clampLenses(many)[0]).toBe("lens-0")
  })

  test("the whole shipped pack fits inside the bound", () => {
    // Asking for every lens MAD ships is a defensible request and must not be
    // silently truncated.
    expect(CODING_LENSES.length).toBeLessThanOrEqual(MAX_LENS_SLOTS)
    expect(clampLenses(CODING_LENSES.map((l) => l.id))).toHaveLength(CODING_LENSES.length)
  })

  test("AN UNKNOWN ID IS ACCEPTED, NOT REJECTED", () => {
    // It reaches the registry's generated fallback (AD-11 amended) and the run
    // record says the instruction was generated rather than shipped. Rejecting
    // it here would make the fallback unreachable through the only surface a
    // user has.
    expect(clampLenses(["threat-model"])).toEqual(["threat-model"])
    expect(clampLenses(["security", "not-a-real-lens"])).toEqual(["security", "not-a-real-lens"])
  })

  test("blank and whitespace-only ids are dropped, and ids are trimmed", () => {
    // An empty id would build the slot id `discovery-lens-`, which names nothing
    // and collides with the next empty one.
    expect(clampLenses(["", "  ", " security "])).toEqual(["security"])
  })

  test("a non-string arriving from a model call is dropped rather than stringified", () => {
    // The value comes from a model calling the tool; the schema bounds it and so
    // does this, on the same reasoning as the slot clamp.
    expect(clampLenses([null, 7, "security"] as never)).toEqual(["security"])
  })

  test("A BARE STRING IS NOT ITERATED BY CHARACTER", () => {
    // Without the `Array.isArray` guard, `"security"` iterates into eight
    // one-letter lens ids — eight billed discovery turns against the user's own
    // credentials, for nothing, from a single mistyped tool call.
    expect(clampLenses("security" as never)).toEqual([])
    expect(clampLenses(42 as never)).toEqual([])
    expect(clampLenses({ 0: "security", length: 1 } as never)).toEqual([])
  })
})

describe("truncatedListWarnings — the clamps can finally say what they dropped", () => {
  // Entries 4 and 51 of the epic-1 ledger triage. Both clamps had a real reason
  // to bound a list from a model call, and no way to say so — `clampPins`' own
  // header said the layer "CANNOT raise a `Warning`". It can now, through
  // `priorWarnings`, because `dial-clamped` exists.
  test("A LIST WITHIN THE CEILING RAISES NOTHING", () => {
    expect(truncatedListWarnings({})).toEqual([])
    expect(truncatedListWarnings({ models: ["openai/gpt-5"], lenses: ["security"] })).toEqual([])
    // AT the ceiling is not OVER it — nothing was dropped, so nothing is said.
    expect(
      truncatedListWarnings({ models: Array.from({ length: MAX_DISCOVERY_SLOTS }, () => "a/b") }),
    ).toEqual([])
  })

  test("a 13th pin is REPORTED, not silently dropped", () => {
    const warnings = truncatedListWarnings({
      models: Array.from({ length: MAX_DISCOVERY_SLOTS + 1 }, () => "a/b"),
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.code).toBe("dial-clamped")
    expect(warnings[0]!.detail).toMatchObject({
      dials: [{ dial: "models", requested: MAX_DISCOVERY_SLOTS + 1, inForce: MAX_DISCOVERY_SLOTS }],
    })
    expect(warnings[0]!.message).toContain(`models ${MAX_DISCOVERY_SLOTS + 1} → ${MAX_DISCOVERY_SLOTS}`)
  })

  test("lens overflow too, and both in ONE warning", () => {
    const warnings = truncatedListWarnings({
      models: Array.from({ length: MAX_DISCOVERY_SLOTS + 2 }, () => "a/b"),
      lenses: Array.from({ length: MAX_LENS_SLOTS + 3 }, (_, i) => `lens-${i}`),
    })
    expect(warnings).toHaveLength(1)
    const dials = (warnings[0]!.detail as { dials: { dial: string }[] }).dials
    expect(dials.map((d) => d.dial)).toEqual(["models", "lenses"])
  })

  test("DUPLICATES AND BLANKS ARE NOT TRUNCATION — they raise nothing", () => {
    // The distinction that decides whether this warning is trustworthy. A
    // duplicate lens is a slot that cannot exist, which `clampLenses` calls
    // deliberate rather than an inconsistency; only a list longer than the
    // CEILING loses something the caller asked for. Comparing against the input
    // length instead of the ceiling would fire on every deduped list.
    expect(truncatedListWarnings({ lenses: ["security", "security", "", "  "] })).toEqual([])
    expect(clampLenses(["security", "security", "", "  "])).toEqual(["security"])
  })

  test("a list OVER the ceiling that dedupes UNDER it raises nothing (code review 2026-09-08)", () => {
    // The case the test above could not reach. Its input is four entries against
    // a ceiling of eight, so it returns on `moved.length === 0` whether the
    // comparison is against the ceiling or against the raw input length — the
    // property it names was never actually exercised.
    //
    // Twenty-two copies of one lens is the shape that separates them. The raw
    // length clears the ceiling; the number of lenses the caller asked for is
    // ONE, and one is kept, so nothing was truncated. The raw comparison
    // announced `lenses 22 → 8`: a dial reported as not honoured over a run that
    // honoured every lens asked for, naming a ceiling never reached and a count
    // of entries never lost. That is the fabricated number AD-6 cannot carry.
    const duplicated = Array.from({ length: MAX_LENS_SLOTS + 14 }, () => "security")
    expect(clampLenses(duplicated)).toEqual(["security"])
    expect(truncatedListWarnings({ lenses: duplicated })).toEqual([])

    // And the boundary either side of it, so the fix cannot be "return [] more
    // often": nine DISTINCT lenses still truncate, and `requested` is the count
    // that survived the drops rather than the raw input length.
    const distinct = Array.from({ length: MAX_LENS_SLOTS + 1 }, (_, i) => `lens-${i}`)
    const noisy = [...distinct, ...distinct, "", "   "]
    const warnings = truncatedListWarnings({ lenses: noisy })
    expect(warnings).toHaveLength(1)
    expect(
      (warnings[0]!.detail as { dials: { dial: string; requested: unknown; inForce: unknown }[] }).dials,
    ).toEqual([{ dial: "lenses", requested: MAX_LENS_SLOTS + 1, inForce: MAX_LENS_SLOTS }])
  })
})

describe("clampPins — bounded here, RESOLVED in the core (story 8A)", () => {
  test("absent or non-array is no pins", () => {
    expect(clampPins(undefined)).toEqual([])
    expect(clampPins([])).toEqual([])
    // A bare string would otherwise iterate BY CHARACTER, the same defect
    // `clampLenses`' guard exists for.
    expect(clampPins("openai/gpt-5" as unknown as string[])).toEqual([])
  })

  test("`provider/model` splits at the FIRST slash, so a model id may contain one", () => {
    // `openrouter/anthropic/claude-sonnet-4-5` is a real shape.
    expect(clampPins(["openai/gpt-5"])).toEqual([{ providerId: "openai", modelId: "gpt-5" }])
    expect(clampPins(["openrouter/anthropic/claude-sonnet-4-5"])).toEqual([
      { providerId: "openrouter", modelId: "anthropic/claude-sonnet-4-5" },
    ])
  })

  test("IT KEEPS A MALFORMED ENTRY so the core can report it", () => {
    // This layer cannot raise a Warning. Anything it silently discards is a
    // request the user made that nobody ever answers — which is exactly the
    // failure this story exists to remove one level up.
    expect(clampPins(["gpt-5"])).toEqual([{ providerId: "", modelId: "gpt-5" }])
  })

  test("IT DEDUPES NOTHING — two pins on one model both reach the core", () => {
    // The opposite of `clampLenses`, and deliberately: a duplicate lens is a slot
    // that cannot exist, while a duplicate pin is a fact the roster report must
    // state (AD-4, dedupe-collapsed).
    expect(clampPins(["anthropic/claude-sonnet-4-5", "bedrock/claude-sonnet-4-5"])).toHaveLength(2)
    expect(clampPins(["openai/gpt-5", "openai/gpt-5"])).toHaveLength(2)
  })

  test("whitespace is trimmed on both halves, and A BLANK ENTRY IS KEPT, not dropped", () => {
    expect(clampPins(["  openai / gpt-5  "])).toEqual([{ providerId: "openai", modelId: "gpt-5" }])
    // Matrix row P10 names `[" "]` and says it "reaches the core as an empty
    // half and is reported `{malformed}`, never dropped by the adapter". This
    // test used to assert the opposite (code review 2026-09-06), which is worse
    // than the bug: the drop contradicted the frozen row AND `clampPins`' own
    // header, and the suite said both were fine. This layer cannot raise a
    // `Warning`, so anything it swallows is a request nobody ever answered.
    expect(clampPins(["", "   "])).toEqual([
      { providerId: "", modelId: "" },
      { providerId: "", modelId: "" },
    ])
  })

  test("the list is capped — a pin can never fill more than a slot", () => {
    const many = Array.from({ length: 50 }, (_, i) => `p${i}/m${i}`)
    expect(clampPins(many)).toHaveLength(MAX_DISCOVERY_SLOTS)
  })
})
