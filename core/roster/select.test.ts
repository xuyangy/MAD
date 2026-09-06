import { describe, expect, test } from "bun:test"

import type { Roster } from "../domain/roster.ts"
import { candidate } from "../test-support/fakes.ts"
import {
  countVerifiedLineages,
  dedupeByIdentity,
  fillLensSlots,
  NoCandidatesError,
  resolvePins,
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

// ---------------------------------------------------------------------------
// Story 8A — AD-3 amended: the caller may PIN discovery slots.
//
// The load-bearing property of this whole block is that pinning changes WHICH
// models fill the slots and NOTHING ELSE. Every diversity report says the same
// thing about a pinned roster that it says about a ranked one, and the tests
// that prove it are byte comparisons of whole Warning objects rather than code
// arrays — a suppression spelled as a reworded message would pass a code check.
// ---------------------------------------------------------------------------

const HOST = [
  candidate("anthropic", "claude-sonnet-4-5-20250929"),
  candidate("openai", "gpt-5"),
  candidate("google", "gemini-2-5-pro"),
]

const pin = (providerId: string, modelId: string) => ({ providerId, modelId })

describe("resolvePins — AD-4 step 0, over the DEDUPED list (story 8A)", () => {
  const deduped = () => dedupeByIdentity(HOST)

  test("pins fill in the order given, and the remainder keeps dedupe order", () => {
    const list = deduped()
    const step = resolvePins(list, [pin("google", "gemini-2-5-pro"), pin("openai", "gpt-5")], 3)

    expect(step.filled.map((e) => e.candidate.modelId)).toEqual(["gemini-2-5-pro", "gpt-5"])
    expect(step.remaining.map((e) => e.candidate.modelId)).toEqual(["claude-sonnet-4-5-20250929"])
    expect(step.resolutions.map((r) => r.outcome)).toEqual(["filled", "filled"])
  })

  test("TWO PROVIDERS REACHING ONE MODEL FILL ONE SLOT — dedupe already collapsed them", () => {
    // The failure AD-4 calls the single most damaging thing this system can do.
    // The two pins meet ONE deduped entry, so there is no second entry for the
    // second pin to buy, whatever the caller asked for.
    const list = dedupeByIdentity([
      candidate("anthropic", "claude-sonnet-4-5-20250929"),
      candidate("bedrock", "us.anthropic.claude-sonnet-4-5-v1:0"),
    ])
    const step = resolvePins(
      list,
      [pin("anthropic", "claude-sonnet-4-5-20250929"), pin("bedrock", "us.anthropic.claude-sonnet-4-5-v1:0")],
      2,
    )

    expect(step.filled).toHaveLength(1)
    expect(step.resolutions.map((r) => r.outcome)).toEqual(["filled", "dedupe-collapsed"])
  })

  test("a pin reachable only through `alsoAvailableVia` IS offered", () => {
    // Reporting `bedrock/...` as "the host does not offer it" while bedrock sits
    // in `alsoAvailableVia` would be a false statement about the host, in a
    // warning whose only job is to be actionable.
    const list = dedupeByIdentity([
      candidate("anthropic", "claude-sonnet-4-5-20250929"),
      candidate("bedrock", "us.anthropic.claude-sonnet-4-5-v1:0"),
    ])
    const step = resolvePins(list, [pin("bedrock", "claude-sonnet-4-5")], 2)
    expect(step.resolutions[0]!.outcome).toBe("filled")
  })

  test("THE PROVIDER HALF IS CASE-INSENSITIVE", () => {
    // A case-differing pin reported as "this host does not offer it" is a false
    // report about the host, and one the reader cannot act on.
    const step = resolvePins(deduped(), [pin("OpenAI", "gpt-5")], 3)
    expect(step.resolutions[0]!.outcome).toBe("filled")
  })

  test("a model the host does not offer is `not-offered`, and nothing throws", () => {
    const step = resolvePins(deduped(), [pin("anthropic", "claude-opus-9")], 3)
    expect(step.resolutions[0]!.outcome).toBe("not-offered")
    expect(step.filled).toEqual([])
    expect(step.remaining).toHaveLength(3)
  })

  test("a model offered by a DIFFERENT provider than named is `not-offered`", () => {
    // The pin names a provider the user believes they configured. Silently
    // serving it from another one would re-seat their credential for them.
    const step = resolvePins(deduped(), [pin("azure", "gpt-5")], 3)
    expect(step.resolutions[0]!.outcome).toBe("not-offered")
  })

  test("surplus pins are `no-slot`, never billed and never dropped", () => {
    const step = resolvePins(deduped(), [pin("openai", "gpt-5"), pin("google", "gemini-2-5-pro")], 1)
    expect(step.filled).toHaveLength(1)
    expect(step.resolutions.map((r) => r.outcome)).toEqual(["filled", "no-slot"])
  })

  test("a MISSPELLED surplus pin is reported as the misspelling, not as surplus", () => {
    // Ordered deliberately: "this host does not offer it" is the fact the caller
    // can act on; "there were only N slots" would send them to fix the wrong thing.
    const step = resolvePins(deduped(), [pin("openai", "gpt-5"), pin("anthropic", "claude-opus-9")], 1)
    expect(step.resolutions[1]!.outcome).toBe("not-offered")
  })

  test("a malformed pin is `malformed`, not silently dropped", () => {
    const step = resolvePins(deduped(), [pin("", "gpt-5"), pin("openai", "  ")], 3)
    expect(step.resolutions.map((r) => r.outcome)).toEqual(["malformed", "malformed"])
  })

  test("IT MUTATES NOTHING — `deduped` and every `alsoAvailableVia` survive intact", () => {
    // `alsoAvailableVia` arrays are shared BY REFERENCE into the lens slots, so a
    // splice or a sort here would corrupt a collection this function is not
    // even about.
    const list = dedupeByIdentity([
      candidate("anthropic", "claude-sonnet-4-5-20250929"),
      candidate("bedrock", "us.anthropic.claude-sonnet-4-5-v1:0"),
      candidate("openai", "gpt-5"),
    ])
    const before = JSON.parse(JSON.stringify(list))
    resolvePins(list, [pin("openai", "gpt-5"), pin("anthropic", "claude-sonnet-4-5")], 2)
    expect(JSON.parse(JSON.stringify(list))).toEqual(before)
  })

  test("no pins is the identity: everything remains, nothing is resolved", () => {
    const list = deduped()
    const step = resolvePins(list, [], 3)
    expect(step.filled).toEqual([])
    expect(step.resolutions).toEqual([])
    expect(step.remaining).toEqual(list)
  })
})

describe("selectRoster with pins — the roster changes, the reports do not (story 8A)", () => {
  test("AN UNPINNED RUN IS BYTE-IDENTICAL TO TODAY, however absence is spelled", () => {
    // AD-3: user config may OVERRIDE the selection and is never REQUIRED to
    // produce one. A pinless run must be unchanged, not merely equivalent.
    const base = selectRoster(HOST, OPTS)
    for (const pins of [undefined, [] as const]) {
      const other = selectRoster(HOST, { ...OPTS, pins })
      expect(other.roster).toEqual(base.roster)
      expect(other.warnings).toEqual(base.warnings)
    }
  })

  test("pins take discovery-1..k in order, and ranking fills the rest", () => {
    const { roster } = selectRoster(HOST, { ...OPTS, pins: [pin("google", "gemini-2-5-pro")] })

    expect(roster.slots[0]!.slot).toBe("discovery-1")
    expect(roster.slots[0]!.modelId).toBe("gemini-2-5-pro")
    expect(roster.slots).toHaveLength(3)
    expect(roster.slots.map((s) => s.slot)).toEqual(["discovery-1", "discovery-2", "discovery-3"])
  })

  test("RANKING NEVER RE-PICKS A PINNED MODEL — no model holds two slots", () => {
    const { roster } = selectRoster(HOST, { ...OPTS, pins: [pin("openai", "gpt-5")] })
    const identities = roster.slots.map((s) => s.identity)
    expect(new Set(identities).size).toBe(identities.length)
  })

  test("A PINNED SLOT CARRIES NO MARK — there is no field a suppression could read", () => {
    // The structural argument this whole story rests on. Writing
    // `if (slot.pinned)` would mean adding the field first, in a visible diff.
    const { roster } = selectRoster(HOST, { ...OPTS, pins: [pin("openai", "gpt-5")] })
    for (const slot of roster.slots) {
      expect(Object.keys(slot).sort()).toEqual([
        "alsoAvailableVia",
        "identity",
        "lineage",
        "modelId",
        "providerId",
        "slot",
        "toolcall",
      ])
    }
    expect(Object.keys(roster).sort()).toEqual([
      "distinctLineages",
      "lensSlots",
      "providers",
      "requested",
      "slots",
    ])
  })

  test("A PINNED SONNET + HAIKU + OPUS WARNS EXACTLY AS LOUDLY AS A RANKED ONE", () => {
    // The decisive test of AD-4's amendment. Deep-equal on the whole Warning —
    // message and detail, not just the code — because a suppression spelled as a
    // softer sentence would pass a code check.
    const claudeOnly = [
      candidate("anthropic", "claude-sonnet-4-5-20250929"),
      candidate("anthropic", "claude-haiku-4-5"),
      candidate("anthropic", "claude-opus-4-1"),
    ]
    const ranked = selectRoster(claudeOnly, OPTS)
    const pinned = selectRoster(claudeOnly, {
      ...OPTS,
      pins: [
        pin("anthropic", "claude-sonnet-4-5-20250929"),
        pin("anthropic", "claude-haiku-4-5"),
        pin("anthropic", "claude-opus-4-1"),
      ],
    })

    expect(pinned.roster.distinctLineages).toBe(1)
    const only = (r: typeof ranked) => r.warnings.find((w) => w.code === "roster-single-lineage")
    expect(only(pinned)).toEqual(only(ranked))
    // And no pin warning at all, because every pin was honoured.
    expect(pinned.warnings.map((w) => w.code)).not.toContain("roster-pin-unhonoured")
  })

  test("PINNING NEVER RAISES `distinctLineages` — the user naming a model is not evidence of its family", () => {
    const claudeOnly = [
      candidate("anthropic", "claude-sonnet-4-5-20250929"),
      candidate("anthropic", "claude-haiku-4-5"),
    ]
    const { roster } = selectRoster(claudeOnly, {
      ...OPTS,
      slots: 2,
      pins: [pin("anthropic", "claude-sonnet-4-5-20250929"), pin("anthropic", "claude-haiku-4-5")],
    })
    expect(roster.distinctLineages).toBe(1)
  })

  test("a pinned model absent from the lineage table is unverified and counts ZERO", () => {
    const { roster, warnings } = selectRoster(
      [candidate("acme", "mystery-model-1"), candidate("openai", "gpt-5")],
      { ...OPTS, slots: 2, pins: [pin("acme", "mystery-model-1")] },
    )

    const pinned = roster.slots[0]!
    expect(pinned.modelId).toBe("mystery-model-1")
    expect(pinned.lineage.verified).toBe(false)
    expect(roster.distinctLineages).toBe(1)
    const unverified = warnings.find((w) => w.code === "roster-lineage-unverified")
    expect(unverified?.message).toContain("discovery-1")
  })

  test("N PINNED UNKNOWNS ARE N UNKNOWNS, not one shared lineage", () => {
    const { roster } = selectRoster(
      [candidate("acme", "mystery-1"), candidate("acme", "mystery-2")],
      { ...OPTS, slots: 2, pins: [pin("acme", "mystery-1"), pin("acme", "mystery-2")] },
    )
    expect(roster.distinctLineages).toBe(0)
    expect(roster.slots).toHaveLength(2)
  })

  test("DEDUPE FIRST: two providers reaching one pinned model fill ONE slot, and it is reported", () => {
    const { roster, warnings } = selectRoster(
      [
        candidate("anthropic", "claude-sonnet-4-5-20250929"),
        candidate("bedrock", "us.anthropic.claude-sonnet-4-5-v1:0"),
      ],
      {
        ...OPTS,
        slots: 2,
        pins: [
          pin("anthropic", "claude-sonnet-4-5-20250929"),
          pin("bedrock", "us.anthropic.claude-sonnet-4-5-v1:0"),
        ],
      },
    )

    expect(roster.slots).toHaveLength(1)
    expect(warnings.map((w) => w.code)).toContain("roster-underfilled")
    const unhonoured = warnings.find((w) => w.code === "roster-pin-unhonoured")
    expect(unhonoured?.message).toContain("already fills slot discovery-1")
  })

  test("THE SWALLOWED PIN IS REPORTED EVEN WHEN RANKING BACKFILLS THE ROSTER", () => {
    // The case the minimal-diff plan left silent: the roster comes out FULL, so
    // `roster-underfilled` never fires, and without its own code the collapse is
    // reported nowhere at all.
    const { roster, warnings } = selectRoster(
      [
        candidate("anthropic", "claude-sonnet-4-5-20250929"),
        candidate("bedrock", "us.anthropic.claude-sonnet-4-5-v1:0"),
        candidate("openai", "gpt-5"),
      ],
      {
        ...OPTS,
        slots: 2,
        pins: [
          pin("anthropic", "claude-sonnet-4-5-20250929"),
          pin("bedrock", "us.anthropic.claude-sonnet-4-5-v1:0"),
        ],
      },
    )

    expect(roster.slots).toHaveLength(2)
    expect(warnings.map((w) => w.code)).not.toContain("roster-underfilled")
    expect(warnings.map((w) => w.code)).toContain("roster-pin-unhonoured")
  })

  test("A PIN THE HOST DOES NOT OFFER IS REPORTED, AND ITS SLOT FALLS THROUGH TO RANKING", () => {
    const { roster, warnings } = selectRoster(HOST, {
      ...OPTS,
      pins: [pin("anthropic", "claude-opus-9")],
    })

    expect(roster.slots).toHaveLength(3)
    const unhonoured = warnings.find((w) => w.code === "roster-pin-unhonoured")
    expect(unhonoured?.message).toContain("this host does not offer it")
    expect(unhonoured?.message).toContain("fell through to ranking")
    expect(unhonoured?.message).toContain("PROCEEDS")
    expect(unhonoured?.message).toContain("provider")
    expect(unhonoured?.detail).toMatchObject({ pinned: 0, requested: 1 })
  })

  test("MAD DOES NOT REFUSE A RUN WHEN EVERY PIN MISSES (AD-3)", () => {
    const { roster } = selectRoster(HOST, {
      ...OPTS,
      pins: [pin("nope", "nope-1"), pin("nope", "nope-2"), pin("nope", "nope-3")],
    })
    expect(roster.slots).toHaveLength(3)
  })

  test("THE PIN WARNING SAYS NOTHING ABOUT DIVERSITY — no 'the user asked for it' clause", () => {
    // The sentence that got a competing plan scored 4/10: a remedy note saying
    // adding a provider will not help is FALSE whenever pins < slots, and it is
    // the suppression AD-4's amendment forbids wearing a disguise.
    const { warnings } = selectRoster(HOST, { ...OPTS, pins: [pin("nope", "nope-1")] })
    const unhonoured = warnings.find((w) => w.code === "roster-pin-unhonoured")!
    for (const forbidden of ["will not change", "will not help", "you pinned", "asked for"]) {
      expect(unhonoured.message.toLowerCase()).not.toContain(forbidden)
    }
  })

  test("no pin warning is raised when every pin was honoured", () => {
    const { warnings } = selectRoster(HOST, { ...OPTS, pins: [pin("openai", "gpt-5")] })
    expect(warnings.map((w) => w.code)).not.toContain("roster-pin-unhonoured")
  })

  test("PINS NEVER MOVE THE LENS SLOTS", () => {
    // `fillLensSlots` must keep receiving the FULL deduped list, never the
    // pin remainder — a lens slot claims no diversity, so pinning has no bearing
    // on it (AD-4 amended, AD-17c).
    // The pin names the model that ranks FIRST, so a `fillLensSlots(remaining)`
    // regression genuinely moves lens-1 onto a different model. Pinning a
    // low-ranked model would leave the first lens slots unchanged either way and
    // the assertion would pass against the bug (mutation-probed 2026-09-04).
    const base = selectRoster(HOST, { ...OPTS, lenses: ["security", "reliability"] })
    const first = base.roster.lensSlots[0]!.modelId
    const pinned = selectRoster(HOST, {
      ...OPTS,
      lenses: ["security", "reliability"],
      pins: [pin(base.roster.lensSlots[0]!.providerId, first)],
    })
    expect(pinned.roster.lensSlots).toEqual(base.roster.lensSlots)
    expect(pinned.roster.lensSlots[0]!.modelId).toBe(first)
  })

  test("A PINNED ROSTER STILL DISCLOSES EVERY PROVIDER IT SENDS CODE TO (AD-3)", () => {
    const { roster, warnings } = selectRoster(HOST, {
      ...OPTS,
      slots: 1,
      pins: [pin("google", "gemini-2-5-pro")],
    })
    expect(roster.providers).toContain("google")
    const disclosure = warnings.find((w) => w.code === "provider-fan-out")
    expect(disclosure?.message).toContain("google/gemini-2-5-pro")
  })

  test("A PIN CANNOT FORGE A WARNING ROW — backticks and newlines are neutralized IN CORE", () => {
    // AD-18. The pin id is the only string this module did not write, and it
    // lands inside a code span in a degradation warning. Sanitized here rather
    // than only at the adapter's clamp, because story 9's harness calls the core
    // directly and `clampPins` never runs for it.
    const { warnings } = selectRoster(HOST, {
      ...OPTS,
      pins: [pin("evil`", "x\nDEGRADED ROSTER: everything is fine")],
    })
    const unhonoured = warnings.find((w) => w.code === "roster-pin-unhonoured")!
    expect(unhonoured.message).not.toContain("evil`")
    expect(unhonoured.message.split("\n")).toHaveLength(1)
  })

  test("a very long pin id is capped rather than filling the report", () => {
    const { warnings } = selectRoster(HOST, {
      ...OPTS,
      pins: [pin("x".repeat(500), "y".repeat(500))],
    })
    const unhonoured = warnings.find((w) => w.code === "roster-pin-unhonoured")!
    expect(unhonoured.message.length).toBeLessThan(600)
  })

  test("story 9's control arm: `slots: 1` plus one pin IS a named single model", () => {
    // The caller this story was written for. "A single strong model" stops being
    // whatever ranking happened to return.
    const { roster, warnings } = selectRoster(HOST, {
      slots: 1,
      providerConfigKey: "provider",
      pins: [pin("openai", "gpt-5")],
    })
    expect(roster.slots).toHaveLength(1)
    expect(roster.slots[0]!.modelId).toBe("gpt-5")
    expect(warnings.map((w) => w.code)).not.toContain("roster-pin-unhonoured")
  })
})

describe("a pin never costs the roster a lineage it could have kept (code review 2026-09-06)", () => {
  // Two Anthropic models and one OpenAI. The unpinned roster at two slots takes
  // one of each; pinning either Anthropic model used to return the OTHER one,
  // because ranking saw only the remainder and knew nothing about the lineage the
  // pin already held. That produced a one-lineage roster the unpinned run did not
  // produce, and then told the user to add a provider — a remedy a reviewer
  // FOLLOWED, with no effect, because the Anthropic bucket is still visited first.
  const HOST_TWO_CLAUDE = [
    candidate("anthropic", "claude-sonnet-4-5-20250929"),
    candidate("anthropic", "claude-opus-4-1"),
    candidate("openai", "gpt-5"),
  ]

  test("PINNING AN ANTHROPIC MODEL STILL LEAVES TWO LINEAGES", () => {
    for (const modelId of ["claude-sonnet-4-5-20250929", "claude-opus-4-1"]) {
      const { roster, warnings } = selectRoster(HOST_TWO_CLAUDE, {
        ...OPTS,
        slots: 2,
        pins: [pin("anthropic", modelId)],
      })

      expect(roster.slots).toHaveLength(2)
      expect(roster.distinctLineages).toBe(2)
      expect(warnings.map((w) => w.code)).not.toContain("roster-single-lineage")
      // The pin is still honoured and still first.
      expect(roster.slots[0]!.modelId).toBe(modelId)
    }
  })

  test("THE UNPINNED RUN IS THE BASELINE, and the pinned run matches it on diversity", () => {
    // The non-vacuous sibling: the property is that pinning costs nothing, so the
    // unpinned run has to actually get two lineages for the claim to mean anything.
    const base = selectRoster(HOST_TWO_CLAUDE, { ...OPTS, slots: 2 })
    expect(base.roster.distinctLineages).toBe(2)
  })

  test("a genuinely one-lineage host still warns — the fix does not suppress anything", () => {
    // AD-4's amendment: pinning must never buy a diversity claim the models do not
    // support. When the host really has one lineage, the warning still fires.
    const { roster, warnings } = selectRoster(
      [candidate("anthropic", "claude-sonnet-4-5-20250929"), candidate("anthropic", "claude-opus-4-1")],
      { ...OPTS, slots: 2, pins: [pin("anthropic", "claude-opus-4-1")] },
    )
    expect(roster.distinctLineages).toBe(1)
    expect(warnings.map((w) => w.code)).toContain("roster-single-lineage")
  })

  test("an UNVERIFIED pinned lineage marks no bucket occupied (AD-5)", () => {
    // An unverified claim is evidence of nothing in either direction, so it must
    // not deprioritise a real lineage.
    const { roster } = selectRoster(
      [candidate("acme", "mystery-1"), candidate("openai", "gpt-5"), candidate("anthropic", "claude-opus-4-1")],
      { ...OPTS, slots: 2, pins: [pin("acme", "mystery-1")] },
    )
    expect(roster.slots[0]!.modelId).toBe("mystery-1")
    expect(roster.distinctLineages).toBe(1)
  })
})
