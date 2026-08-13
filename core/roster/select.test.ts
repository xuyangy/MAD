import { describe, expect, test } from "bun:test"

import { candidate } from "../test-support/fakes.ts"
import { dedupeByIdentity, NoCandidatesError, selectRoster } from "./select.ts"

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
