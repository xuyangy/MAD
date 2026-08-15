import { describe, expect, test } from "bun:test"

import type { Roster } from "../domain/roster.ts"
import { candidate } from "../test-support/fakes.ts"
import {
  countVerifiedLineages,
  dedupeByIdentity,
  fillLensSlots,
  NoCandidatesError,
  selectRoster,
} from "./select.ts"

const OPTS = { slots: 3, providerConfigKey: "provider" }

describe("dedupe before rank (AD-4)", () => {
  test("matrix: same model, two providers — counted once, never a second slot", () => {
    const { roster } = selectRoster(
      [
        candidate("anthropic", "claude-sonnet-4-5-20250929"),
        candidate("bedrock", "us.anthropic.claude-sonnet-4-5-v1:0"),
      ],
      { ...OPTS, slots: 2 },
    )

    expect(roster.slots).toHaveLength(1)
    expect(roster.slots[0]!.providerId).toBe("anthropic")
    expect(roster.slots[0]!.alsoAvailableVia).toEqual(["bedrock"])
    expect(roster.distinctLineages).toBe(1)
  })

  test("dedupe keys on identity, not on provider id", () => {
    const deduped = dedupeByIdentity([
      candidate("anthropic", "claude-sonnet-4-5-20250929"),
      candidate("bedrock", "anthropic.claude-sonnet-4-5-v1:0"),
      candidate("vertex", "claude-sonnet-4-5@20250929"),
      candidate("openai", "gpt-5-2025-08-07"),
    ])
    expect(deduped).toHaveLength(2)
    expect(deduped[0]!.alsoAvailableVia).toEqual(["bedrock", "vertex"])
  })
})

describe("rank for lineage diversity (AD-4 step 2)", () => {
  test("matrix: diverse roster — one model per distinct lineage", () => {
    const { roster } = selectRoster(
      [
        candidate("anthropic", "claude-sonnet-4-5"),
        candidate("anthropic", "claude-haiku-4-5"),
        candidate("openai", "gpt-5"),
        candidate("openai", "gpt-5-mini"),
        candidate("google", "gemini-2.5-pro"),
      ],
      OPTS,
    )

    expect(roster.slots.map((s) => s.lineage.lineage)).toEqual(["claude", "gpt", "gemini"])
    expect(roster.distinctLineages).toBe(3)
  })

  test("distinct lineages outrank distinct models within a lineage", () => {
    // Sonnet + Haiku + GPT beats Sonnet + Haiku + Opus.
    const { roster } = selectRoster(
      [
        candidate("anthropic", "claude-sonnet-4-5"),
        candidate("anthropic", "claude-haiku-4-5"),
        candidate("anthropic", "claude-opus-4-1"),
        candidate("openai", "gpt-5"),
      ],
      OPTS,
    )
    const lineages = roster.slots.map((s) => s.lineage.lineage)
    expect(lineages).toContain("gpt")
    expect(lineages.filter((l) => l === "claude")).toHaveLength(2)
    expect(roster.distinctLineages).toBe(2)
  })

  test("second slot within a lineage only after every lineage has one", () => {
    const { roster } = selectRoster(
      [
        candidate("anthropic", "claude-sonnet-4-5"),
        candidate("anthropic", "claude-haiku-4-5"),
        candidate("openai", "gpt-5"),
      ],
      { ...OPTS, slots: 2 },
    )
    expect(roster.slots.map((s) => s.lineage.lineage)).toEqual(["claude", "gpt"])
  })
})

describe("degradation reports (AD-6c, AD-5)", () => {
  test("matrix: single lineage — runs, and the warning names lineage and config key", () => {
    const { roster, warnings } = selectRoster(
      [candidate("anthropic", "claude-sonnet-4-5"), candidate("anthropic", "claude-haiku-4-5")],
      OPTS,
    )

    expect(roster.slots).toHaveLength(2) // it runs
    const degraded = warnings.find((w) => w.code === "roster-single-lineage")
    expect(degraded).toBeDefined()
    expect(degraded!.message).toContain("Claude (Anthropic)")
    expect(degraded!.message).toContain("`provider`")
    expect(degraded!.message.toLowerCase()).toContain("weak signal")
    expect(degraded!.message.toLowerCase()).toContain("temperature")
  })

  test("matrix: unknown model — reported unverified, not counted as a fresh lineage", () => {
    const { roster, warnings } = selectRoster(
      [candidate("anthropic", "claude-sonnet-4-5"), candidate("acme", "acme-reviewer-9000")],
      { ...OPTS, slots: 2 },
    )

    expect(roster.slots).toHaveLength(2)
    expect(roster.distinctLineages).toBe(1) // the unknown did not add one
    expect(warnings.some((w) => w.code === "roster-lineage-unverified")).toBe(true)
    expect(warnings.some((w) => w.code === "roster-single-lineage")).toBe(true)
  })

  test("several unknown models do not add up to several lineages", () => {
    const { roster } = selectRoster(
      [candidate("a", "mystery-one"), candidate("b", "mystery-two"), candidate("c", "mystery-three")],
      OPTS,
    )
    expect(roster.slots).toHaveLength(3)
    expect(roster.distinctLineages).toBe(0)
  })

  test("verified lineages are ranked ahead of unverified ones", () => {
    const { roster } = selectRoster(
      [candidate("acme", "mystery-one"), candidate("openai", "gpt-5")],
      { ...OPTS, slots: 1 },
    )
    expect(roster.slots[0]!.modelId).toBe("gpt-5")
  })

  test("an underfilled roster warns in its own right (AD-6c)", () => {
    // "requested 3, filled 1" is a different fact from "filled 3, one lineage",
    // and before this warning existed it reached the output silently.
    const { roster, warnings } = selectRoster([candidate("openai", "gpt-5")], OPTS)

    expect(roster.slots).toHaveLength(1)
    const underfilled = warnings.find((w) => w.code === "roster-underfilled")
    expect(underfilled).toBeDefined()
    expect(underfilled!.detail).toMatchObject({ requested: 3, filled: 1 })
    expect(underfilled!.message).toContain("`provider`")
  })

  test("dedupe-driven underfill is reported with the pre-dedupe candidate count", () => {
    const { warnings } = selectRoster(
      [
        candidate("anthropic", "claude-sonnet-4-5-20250929"),
        candidate("bedrock", "us.anthropic.claude-sonnet-4-5-v1:0"),
      ],
      { ...OPTS, slots: 2 },
    )
    const underfilled = warnings.find((w) => w.code === "roster-underfilled")
    expect(underfilled!.detail).toMatchObject({ filled: 1, candidatesBeforeDedupe: 2 })
  })

  test("a filled roster raises no underfill warning", () => {
    const { warnings } = selectRoster(
      [
        candidate("anthropic", "claude-sonnet-4-5"),
        candidate("openai", "gpt-5"),
        candidate("google", "gemini-2.5-pro"),
      ],
      OPTS,
    )
    expect(warnings.some((w) => w.code === "roster-underfilled")).toBe(false)
  })

  test("a fully diverse roster raises no degradation warning", () => {
    const { warnings } = selectRoster(
      [
        candidate("anthropic", "claude-sonnet-4-5"),
        candidate("openai", "gpt-5"),
        candidate("google", "gemini-2.5-pro"),
      ],
      OPTS,
    )
    expect(warnings.filter((w) => w.code !== "provider-fan-out")).toHaveLength(0)
  })

  test("AD-3: the provider fan-out is disclosed on every run", () => {
    const { warnings } = selectRoster([candidate("openai", "gpt-5")], { ...OPTS, slots: 1 })
    const disclosure = warnings.find((w) => w.code === "provider-fan-out")
    expect(disclosure).toBeDefined()
    expect(disclosure!.message).toContain("openai")
  })
})

// ---------------------------------------------------------------------------
// CAP-11 — lens slots. The invariant this story exists to protect is the first
// describe below, and it is asserted twice on purpose (see the story's Design
// Notes): once end to end through `selectRoster`, and once directly against the
// lens-fill helper, where `distinctLineages: 0` over an empty pool is
// expressible without a pool-less run mode having to exist.
// ---------------------------------------------------------------------------

const THREE_LINEAGES = [
  candidate("anthropic", "claude-sonnet-4-5"),
  candidate("openai", "gpt-5"),
  candidate("google", "gemini-2.5-pro"),
]

describe("LENS SLOTS CONTRIBUTE ZERO TO distinctLineages (AD-4 amended, AD-17c)", () => {
  test("matrix: N lens slots over a verified-lineage model add no lineages", () => {
    const oneModel = [candidate("openai", "gpt-5")]
    const { roster: bare } = selectRoster(oneModel, { ...OPTS, slots: 1 })
    const { roster: lensed } = selectRoster(oneModel, {
      ...OPTS,
      slots: 1,
      lenses: ["security", "performance", "reliability", "tests"],
    })

    expect(lensed.lensSlots).toHaveLength(4)
    // ...and the count is EXACTLY what the pool alone yields. A lens slot in
    // `slots` would read 5 here — AD-4's "single most damaging thing this system
    // can get wrong", because every co-discovery number downstream inherits it.
    expect(lensed.distinctLineages).toBe(bare.distinctLineages)
    expect(lensed.distinctLineages).toBe(1)
    expect(lensed.slots).toEqual(bare.slots)
  })

  test("the same holds at a diverse roster: lenses never top up the lineage count", () => {
    const { roster } = selectRoster(THREE_LINEAGES, { ...OPTS, lenses: ["security", "intent"] })
    expect(roster.slots).toHaveLength(3)
    expect(roster.lensSlots).toHaveLength(2)
    expect(roster.distinctLineages).toBe(3) // not 5, and not 3 + anything
  })

  test("a lens-only roster over one model reports distinctLineages: 0 — asserted literally", () => {
    // The narrow reading of the CI requirement (story 2A, Design Notes).
    // `selectRoster` keeps its `slots >= 1` guard, so a pool-less RUN stays
    // inexpressible; the invariant is asserted here against the exported helper
    // instead, where the literal 0 costs nothing to say.
    const deduped = dedupeByIdentity([candidate("openai", "gpt-5")])
    const lensSlots = fillLensSlots(deduped, ["security", "performance"])

    expect(lensSlots).toHaveLength(2)
    expect(lensSlots.every((s) => s.lineage.verified)).toBe(true) // a REAL lineage...

    const lensOnly: Roster = {
      slots: [],
      lensSlots,
      requested: 0,
      // The one function that produces a lineage count, over the pool. This is
      // what "by construction" means: there is no array holding both kinds of
      // slot, so the two verified-lineage lens slots above have no route in.
      distinctLineages: countVerifiedLineages([]),
      providers: [],
    }
    expect(lensOnly.distinctLineages).toBe(0)
  })

  test("selectRoster still refuses a pool-less run", () => {
    // Deliberate: a pool-less run has `answered: 0` and renders through output's
    // "NO MODEL ANSWERED — this is not a clean review" path over a run that
    // worked. The lens invariant above is asserted without buying that.
    expect(() => selectRoster(THREE_LINEAGES, { ...OPTS, slots: 0, lenses: ["security"] })).toThrow(
      "slots must be at least 1",
    )
  })
})

describe("lens slots fill after the pool (AD-4 amended)", () => {
  test("absent `lenses` yields no lens slots, no lens turns and no new warning", () => {
    // AD-3 / AD-15 amended — a fresh install's cost is byte-for-byte what it was
    // before this capability existed.
    const { roster, warnings } = selectRoster(THREE_LINEAGES, OPTS)
    expect(roster.lensSlots).toEqual([])
    expect(warnings.some((w) => w.code === "roster-lens-homogeneous")).toBe(false)
  })

  test("an empty `lenses` array is the same as none", () => {
    expect(selectRoster(THREE_LINEAGES, { ...OPTS, lenses: [] }).roster.lensSlots).toEqual([])
  })

  test("lens ids map to `discovery-lens-<id>` slot ids", () => {
    const { roster } = selectRoster(THREE_LINEAGES, {
      ...OPTS,
      lenses: ["security", "privacy-a11y"],
    })
    expect(roster.lensSlots.map((s) => s.slot)).toEqual([
      "discovery-lens-security",
      "discovery-lens-privacy-a11y",
    ])
    // The lens is READ FROM THE FIELD, never parsed back out of the id.
    expect(roster.lensSlots.map((s) => s.lens)).toEqual(["security", "privacy-a11y"])
  })

  test("lens slots spread round-robin over the whole deduped list", () => {
    const { roster } = selectRoster(THREE_LINEAGES, {
      ...OPTS,
      slots: 3,
      lenses: ["security", "performance", "tests", "intent"],
    })
    // Three deduped candidates, four lenses: one per model, then back to the
    // first. Spreading first is what makes the homogeneity warning mean "your
    // host is narrow" rather than "MAD chose badly".
    expect(roster.lensSlots.map((s) => s.modelId)).toEqual([
      "claude-sonnet-4-5",
      "gpt-5",
      "gemini-2.5-pro",
      "claude-sonnet-4-5",
    ])
  })

  test("matrix: 2 deduped models, 3 lenses — round-robin wraps, and reuse is not warned about", () => {
    const { roster, warnings } = selectRoster(
      [candidate("anthropic", "claude-sonnet-4-5"), candidate("openai", "gpt-5")],
      { ...OPTS, slots: 2, lenses: ["security", "performance", "tests"] },
    )

    expect(roster.lensSlots.map((s) => s.modelId)).toEqual([
      "claude-sonnet-4-5",
      "gpt-5",
      "claude-sonnet-4-5", // wrapped
    ])
    // Two distinct models across the lens slots, so this is not the homogeneous
    // case — and reuse on its own is never a warning (AD-4 amended).
    expect(warnings.some((w) => w.code === "roster-lens-homogeneous")).toBe(false)
    expect(roster.distinctLineages).toBe(2)
  })

  test("a lens may reuse a model the pool already holds, and that alone is not a warning", () => {
    // AD-4 amended — reuse costs nothing dedupe was protecting, because a lens
    // slot claims no diversity.
    const { roster, warnings } = selectRoster(THREE_LINEAGES, {
      ...OPTS,
      slots: 3,
      lenses: ["security"],
    })
    const poolModels = roster.slots.map((s) => s.modelId)
    expect(poolModels).toContain(roster.lensSlots[0]!.modelId)
    expect(warnings.filter((w) => w.code !== "provider-fan-out")).toHaveLength(0)
  })

  test("duplicate lens ids collapse to one slot", () => {
    // Two slots sharing an id would share a slot id, which a backend's per-slot
    // map cannot represent and a finding's `author` cannot disambiguate.
    const { roster } = selectRoster(THREE_LINEAGES, {
      ...OPTS,
      lenses: ["security", "security", "tests"],
    })
    expect(roster.lensSlots.map((s) => s.lens)).toEqual(["security", "tests"])
  })

  test("the fan-out disclosure names the lens turns too (AD-3)", () => {
    const { warnings } = selectRoster(THREE_LINEAGES, { ...OPTS, slots: 1, lenses: ["security"] })
    const disclosure = warnings.find((w) => w.code === "provider-fan-out")!
    expect(disclosure.message).toContain("lens security")
  })

  test("`providers` names a provider only a LENS slot reaches (AD-3)", () => {
    // The reason lens slots are in `providers` at all, and the only case that
    // distinguishes including them from not: the pool takes the top `slots` by
    // diversity rank while lenses round-robin the WHOLE deduped list, so a lens
    // can send the change to a provider the pool never picked. Leaving it out
    // under-discloses the fan-out — and every other lens test happens to land on
    // a provider the pool already uses, where the two are indistinguishable.
    const { roster, warnings } = selectRoster(
      [candidate("anthropic", "claude-sonnet-4-5"), candidate("openai", "gpt-5")],
      { ...OPTS, slots: 1, lenses: ["security", "performance"] },
    )

    expect(roster.slots.map((s) => s.providerId)).toEqual(["anthropic"]) // the pool alone
    expect(roster.lensSlots.map((s) => s.providerId)).toEqual(["anthropic", "openai"])
    // openai is reachable ONLY through a lens slot here, and is disclosed anyway.
    expect(roster.providers).toEqual(["anthropic", "openai"])
    expect(warnings.find((w) => w.code === "provider-fan-out")!.message).toContain(
      "2 provider(s): anthropic, openai",
    )
  })
})

describe("lens homogeneity (AD-6e)", () => {
  test("matrix: >1 lens over a single-model host warns and names the model", () => {
    const { roster, warnings } = selectRoster([candidate("openai", "gpt-5")], {
      ...OPTS,
      slots: 1,
      lenses: ["security", "performance", "tests"],
    })

    expect(roster.lensSlots).toHaveLength(3)
    const homogeneous = warnings.find((w) => w.code === "roster-lens-homogeneous")
    expect(homogeneous).toBeDefined()
    expect(homogeneous!.message).toContain("openai/gpt-5")
    expect(homogeneous!.message.toLowerCase()).toContain("blind spots")
    // The consequence, stated on the same grounds as temperature jitter (AD-6c).
    expect(homogeneous!.message.toLowerCase()).toContain("not an accepted substitute")
    expect(homogeneous!.message).toContain("`provider`")
    expect(homogeneous!.detail).toMatchObject({ model: "openai/gpt-5" })
  })

  test("it is a warning, not a failure — the run still has its roster", () => {
    const { roster } = selectRoster([candidate("openai", "gpt-5")], {
      ...OPTS,
      slots: 1,
      lenses: ["security", "performance"],
    })
    expect(roster.slots).toHaveLength(1)
    expect(roster.lensSlots).toHaveLength(2)
  })

  test("lenses spread over several models do not warn", () => {
    const { warnings } = selectRoster(THREE_LINEAGES, {
      ...OPTS,
      lenses: ["security", "performance"],
    })
    expect(warnings.some((w) => w.code === "roster-lens-homogeneous")).toBe(false)
  })

  test("ONE lens slot never warns — one persona over one model is what was asked for", () => {
    const { warnings } = selectRoster([candidate("openai", "gpt-5")], {
      ...OPTS,
      slots: 1,
      lenses: ["security"],
    })
    expect(warnings.some((w) => w.code === "roster-lens-homogeneous")).toBe(false)
  })

  test("a clean roster and clean lenses raise neither report", () => {
    const { warnings } = selectRoster(THREE_LINEAGES, {
      ...OPTS,
      lenses: ["security", "performance"],
    })
    const codes = warnings.map((w) => w.code)
    expect(codes).not.toContain("roster-single-lineage") // roster is fine...
    expect(codes).not.toContain("roster-lens-homogeneous") // ...and so are the lenses
  })

  test("IT FIRES INDEPENDENTLY OF THE LINEAGE REPORT — a fine pool, homogeneous lenses", () => {
    // The case the old version of this test DESCRIBED in a comment and never
    // exercised: it asserted both warnings absent over a plainly diverse roster,
    // so "fires independently" was never observed firing (code review 2026-08-15).
    //
    // Two lineages reach the host but only one of them has depth, and the pool
    // takes the top 1 by diversity rank. Three lens slots then wrap within the
    // deep lineage.
    const { roster, warnings } = selectRoster(
      [
        candidate("anthropic", "claude-sonnet-4-5"),
        candidate("anthropic", "claude-haiku-4-5"),
        candidate("anthropic", "claude-opus-4-1"),
      ],
      { ...OPTS, slots: 1, lenses: ["security", "performance", "tests"] },
    )

    const codes = warnings.map((w) => w.code)
    // The POOL is exactly what was asked for: one slot, one verified lineage.
    expect(roster.slots).toHaveLength(1)
    expect(roster.distinctLineages).toBe(1)
    expect(codes).not.toContain("roster-single-lineage")
    expect(codes).not.toContain("roster-underfilled")
    // ...and the LENS roster is degraded anyway. That is the independence.
    expect(codes).toContain("roster-lens-homogeneous")
  })

  test("AD-6e amended — three DISTINCT models of one lineage still share its blind spots", () => {
    // Keying the warning on model identity alone let this pass silently: three
    // different models, one lineage, no report (code review 2026-08-15). AD-5
    // locates blind spots at the lineage, and AD-6c already warns the pool on
    // exactly these grounds.
    const { roster, warnings } = selectRoster(
      [
        candidate("anthropic", "claude-sonnet-4-5"),
        candidate("anthropic", "claude-haiku-4-5"),
        candidate("anthropic", "claude-opus-4-1"),
      ],
      { ...OPTS, slots: 1, lenses: ["security", "performance", "tests"] },
    )

    // Three distinct models — the identity-only trigger would not fire here.
    expect(new Set(roster.lensSlots.map((s) => s.identity)).size).toBe(3)

    const homogeneous = warnings.find((w) => w.code === "roster-lens-homogeneous")
    expect(homogeneous).toBeDefined()
    expect(homogeneous!.message).toContain("ONE lineage")
    expect(homogeneous!.message.toLowerCase()).toContain("blind spots")
    expect(homogeneous!.detail).toMatchObject({ scope: "one-lineage", lineage: "claude" })
  })

  test("N UNVERIFIED models are N unknowns, not one shared lineage", () => {
    // AD-5 forbids reading anything into an unverified claim in either
    // direction: unrecognized models are never counted as diverse, and must not
    // be counted as correlated either.
    const { roster, warnings } = selectRoster(
      [candidate("local", "some-new-model-v1"), candidate("local", "another-unknown-v2")],
      { ...OPTS, slots: 1, lenses: ["security", "performance"] },
    )

    expect(roster.lensSlots.every((s) => !s.lineage.verified)).toBe(true)
    expect(new Set(roster.lensSlots.map((s) => s.identity)).size).toBe(2)
    expect(warnings.some((w) => w.code === "roster-lens-homogeneous")).toBe(false)
  })
})

describe("lens spread follows lineage rank, not host listing order (code review 2026-08-15)", () => {
  test("lenses do not pile into one lineage because the host listed it first", () => {
    // The defect: `fillLensSlots` indexed the RAW deduped order while the pool
    // indexed the diversity-ranked one, so the lens spread was a function of how
    // the host happened to list its providers. Here `gpt-5` is listed last and
    // was left unused while three lenses stacked onto three Claude models.
    const { roster } = selectRoster(
      [
        candidate("anthropic", "claude-sonnet-4-5"),
        candidate("anthropic", "claude-haiku-4-5"),
        candidate("anthropic", "claude-opus-4-1"),
        candidate("openai", "gpt-5"),
      ],
      { ...OPTS, slots: 2, lenses: ["security", "performance", "maintainability"] },
    )

    // One model per lineage before any lineage gets a second — the same rule the
    // pool fills by (AD-4 step 2).
    expect(roster.lensSlots.map((s) => s.modelId)).toEqual([
      "claude-sonnet-4-5",
      "gpt-5",
      "claude-haiku-4-5",
    ])
    expect(new Set(roster.lensSlots.map((s) => s.lineage.lineage))).toEqual(
      new Set(["claude", "gpt"]),
    )
    // The pool is untouched by any of this (AD-17c).
    expect(roster.distinctLineages).toBe(2)
  })
})

describe("no providers (matrix row: fail with guidance)", () => {
  test("throws a message naming what to configure in opencode", () => {
    expect(() => selectRoster([], OPTS)).toThrow(NoCandidatesError)
    try {
      selectRoster([], OPTS)
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain("`provider`")
      expect(message).toContain("opencode")
      expect(message).toContain("auth login")
    }
  })
})
