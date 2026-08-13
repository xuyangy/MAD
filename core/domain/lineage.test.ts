import { describe, expect, test } from "bun:test"

import { lineageOf, normalizeModelIdentity, UNVERIFIED_LINEAGE } from "./lineage.ts"

describe("normalizeModelIdentity (AD-4 step 1)", () => {
  test("strips a provider routing prefix", () => {
    expect(normalizeModelIdentity("anthropic/claude-sonnet-4-5")).toBe("claude-sonnet-4-5")
    expect(normalizeModelIdentity("openrouter/openai/gpt-5")).toBe("gpt-5")
  })

  test("strips regional and vendor dotted prefixes", () => {
    expect(normalizeModelIdentity("us.anthropic.claude-sonnet-4-5-v1:0")).toBe("claude-sonnet-4-5")
    expect(normalizeModelIdentity("eu.meta.llama-3-70b-v1:0")).toBe("llama-3-70b")
  })

  test("strips snapshot dates in every shape the hosts use", () => {
    expect(normalizeModelIdentity("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5")
    expect(normalizeModelIdentity("gpt-5-2025-08-07")).toBe("gpt-5")
    expect(normalizeModelIdentity("claude-3-5-sonnet@20241022")).toBe("claude-3-5-sonnet")
  })

  test("strips rollout-channel and per-call variant markers", () => {
    expect(normalizeModelIdentity("gemini-2.5-pro-preview-05-06")).toBe("gemini-2.5-pro")
    expect(normalizeModelIdentity("gpt-5-latest")).toBe("gpt-5")
    expect(normalizeModelIdentity("claude-sonnet-4-5-thinking")).toBe("claude-sonnet-4-5")
  })

  test("strips the MM-YYYY snapshot form (Cohere), so it cannot take a second slot", () => {
    expect(normalizeModelIdentity("command-r-08-2024")).toBe("command-r")
    expect(normalizeModelIdentity("command-r-plus-04-2024")).toBe("command-r-plus")
    expect(normalizeModelIdentity("command-r-08-2024")).toBe(normalizeModelIdentity("command-r"))
  })

  test("but MM-YYYY stripping does not merge genuinely different models", () => {
    expect(normalizeModelIdentity("command-r-08-2024")).not.toBe(
      normalizeModelIdentity("command-r-plus-08-2024"),
    )
    // Not a month: 13 is left alone rather than treated as a date.
    expect(normalizeModelIdentity("mystery-13-2024")).toBe("mystery-13-2024")
  })

  test("normalization never yields an empty identity", () => {
    // An id made entirely of strippable parts would otherwise normalize to ""
    // and collapse every such model onto one identity.
    expect(normalizeModelIdentity("v1")).not.toBe("")
    expect(normalizeModelIdentity("anthropic.")).not.toBe("")
    expect(normalizeModelIdentity("latest")).not.toBe("")
  })

  test("keeps family and version — different versions stay different models", () => {
    expect(normalizeModelIdentity("claude-3.5-sonnet")).toBe("claude-3.5-sonnet")
    expect(normalizeModelIdentity("gpt-4.1")).toBe("gpt-4.1")
    expect(normalizeModelIdentity("claude-opus-4")).not.toBe(normalizeModelIdentity("claude-opus-4-1"))
  })

  test("the same model through two providers collapses to one identity", () => {
    expect(normalizeModelIdentity("anthropic/claude-sonnet-4-5-20250929")).toBe(
      normalizeModelIdentity("us.anthropic.claude-sonnet-4-5-v1:0"),
    )
  })
})

describe("lineageOf (AD-5)", () => {
  test("claims a lineage for known families", () => {
    expect(lineageOf("claude-sonnet-4-5-20250929").lineage).toBe("claude")
    expect(lineageOf("gpt-5").lineage).toBe("gpt")
    expect(lineageOf("o3-mini").lineage).toBe("gpt")
    expect(lineageOf("gemini-2.5-pro").lineage).toBe("gemini")
    expect(lineageOf("us.anthropic.claude-haiku-4-5-v1:0").lineage).toBe("claude")
  })

  test("every known claim is verified", () => {
    expect(lineageOf("gpt-5").verified).toBe(true)
  })

  test("an unrecognized model is unverified, never a fresh lineage", () => {
    const claim = lineageOf("acme-reviewer-9000")
    expect(claim.verified).toBe(false)
    expect(claim.lineage).toBe(UNVERIFIED_LINEAGE)
  })

  test("markers do not match mid-word", () => {
    // "o1" must not be claimed inside an unrelated id.
    expect(lineageOf("solaris-42").verified).toBe(false)
  })
})
