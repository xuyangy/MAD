import { describe, expect, test } from "bun:test"

import { candidate } from "../test-support/fakes.ts"
import {
  AllOfferingsExcludedError,
  InvalidExclusionError,
  NoCandidatesError,
  NoEligibleCandidatesError,
  selectRoster,
  type SelectResult,
} from "./select.ts"

const OPTS = { slots: 3, providerConfigKey: "provider" }
const REQUIRE = { ...OPTS, requireToolcall: true }

/** Every provider/model route the result could send a request to: pool, lenses and replacements. */
function routes(result: SelectResult): string[] {
  return [
    ...result.roster.slots.map((slot) => `${slot.providerId}/${slot.modelId}`),
    ...result.roster.lensSlots.map((slot) => `${slot.providerId}/${slot.modelId}`),
    ...result.recovery.candidates.map((slot) => `${slot.providerId}/${slot.modelId}`),
  ]
}

/** Every provider a slot names, served or as an alternative. */
function providersNamed(result: SelectResult): string[] {
  return [...result.roster.slots, ...result.roster.lensSlots].flatMap((slot) => [slot.providerId, ...slot.alsoAvailableVia])
}

const HOST = [
  candidate("anthropic", "claude-opus-5-5"),
  candidate("bedrock", "us.anthropic.claude-opus-5-5-v1:0"),
  candidate("openai", "gpt-5"),
  candidate("google", "gemini-2.5-pro"),
  candidate("anthropic", "claude-haiku-4-5"),
]

describe("caller exclusions (SelectOptions.exclude)", () => {
  test("absent and empty exclusions give the same result as before the option existed", () => {
    const options = { ...REQUIRE, lenses: ["security"], pins: [{ providerId: "openai", modelId: "gpt-5" }] }
    const base = selectRoster(HOST, options)
    expect(selectRoster(HOST, { ...options, exclude: [] })).toEqual(base)
    expect(base.warnings.some((w) => w.code === "roster-caller-excluded")).toBe(false)
  })

  test("an excluded first provider leaves the same model eligible through another provider, which serves it alone", () => {
    const result = selectRoster(HOST, { ...REQUIRE, slots: 4, exclude: [{ providerId: "anthropic", modelId: "claude-opus-5-5" }] })
    const opus = result.roster.slots.find((slot) => slot.identity.includes("opus"))!
    expect(opus.providerId).toBe("bedrock")
    expect(opus.alsoAvailableVia).toEqual([])
    expect(routes(result)).not.toContain("anthropic/claude-opus-5-5")
    // Another model on the excluded provider stays eligible.
    expect(routes(result)).toContain("anthropic/claude-haiku-4-5")
  })

  test("the exclusion also holds without the tool-calling requirement", () => {
    const result = selectRoster(HOST, { ...OPTS, slots: 4, exclude: [{ providerId: "anthropic", modelId: "claude-opus-5-5" }] })
    expect(routes(result)).not.toContain("anthropic/claude-opus-5-5")
    expect(result.roster.slots.find((slot) => slot.identity.includes("opus"))!.alsoAvailableVia).toEqual([])
  })

  test("the provider is matched without regard to case, and a model id with its own slash is matched whole", () => {
    const host = [candidate("openrouter", "anthropic/claude-sonnet-4-5"), candidate("openai", "gpt-5")]
    const result = selectRoster(host, { ...REQUIRE, exclude: [{ providerId: " OpenRouter ", modelId: "anthropic/claude-sonnet-4-5" }] })
    expect(routes(result)).toEqual(["openai/gpt-5"])
    expect(result.warnings.find((w) => w.code === "roster-caller-excluded")!.detail).toEqual({
      exclusions: [{ providerId: " OpenRouter ", modelId: "anthropic/claude-sonnet-4-5", removed: 1 }],
      offerings: 2,
      removedOfferings: 1,
    })
  })

  test("the model id is matched exactly: another id the provider lists for the same model stays eligible, and case matters", () => {
    const host = [candidate("anthropic", "claude-sonnet-4-5"), candidate("anthropic", "claude-sonnet-4-5-20250929"), candidate("openai", "gpt-5")]
    const exact = selectRoster(host, { ...REQUIRE, exclude: [{ providerId: "anthropic", modelId: "claude-sonnet-4-5" }] })
    expect(routes(exact)).toContain("anthropic/claude-sonnet-4-5-20250929")
    expect(routes(exact)).not.toContain("anthropic/claude-sonnet-4-5")

    const wrongCase = selectRoster(host, { ...REQUIRE, exclude: [{ providerId: "anthropic", modelId: "Claude-Sonnet-4-5" }] })
    expect(routes(wrongCase)).toContain("anthropic/claude-sonnet-4-5")
    expect(wrongCase.warnings.find((w) => w.code === "roster-caller-excluded")!.message).toContain(
      "`anthropic/Claude-Sonnet-4-5` (matched no offering the host lists)",
    )
  })

  test("an excluded model fills no pool slot, no lens slot and no replacement route", () => {
    const result = selectRoster(HOST, {
      ...REQUIRE,
      slots: 2,
      lenses: ["security", "performance", "outsider", "tests"],
      exclude: [{ providerId: "google", modelId: "gemini-2.5-pro" }],
    })
    expect(result.recovery.candidates.length).toBeGreaterThan(0)
    expect(result.roster.lensSlots).toHaveLength(4)
    expect(routes(result).some((route) => route.startsWith("google/"))).toBe(false)
    expect(providersNamed(result)).not.toContain("google")
    expect(result.roster.providers).not.toContain("google")
  })

  test("exclusion wins over a pin naming the same route; the pin is reported, and ranking may still pick another route to the model", () => {
    const result = selectRoster(HOST, {
      ...REQUIRE,
      slots: 4,
      pins: [{ providerId: "anthropic", modelId: "claude-opus-5-5" }],
      exclude: [{ providerId: "ANTHROPIC", modelId: "claude-opus-5-5" }],
    })
    expect(routes(result)).not.toContain("anthropic/claude-opus-5-5")
    expect(result.recovery.pinned).toEqual([])
    expect(routes(result)).toContain("bedrock/us.anthropic.claude-opus-5-5-v1:0")
    const unhonoured = result.warnings.find((w) => w.code === "roster-pin-unhonoured")!
    expect(unhonoured.message).toContain("`anthropic/claude-opus-5-5` (the caller's exclusions forbid this route)")
    expect(unhonoured.detail!.pins).toEqual([{ providerId: "anthropic", modelId: "claude-opus-5-5", reason: "excluded" }])
  })

  test("a pin is excluded when the exclusions removed every offering of its model through that provider, under another id", () => {
    const host = [candidate("anthropic", "claude-sonnet-4-5-20250929"), candidate("openai", "gpt-5")]
    const result = selectRoster(host, {
      ...REQUIRE,
      pins: [{ providerId: "anthropic", modelId: "claude-sonnet-4-5" }],
      exclude: [{ providerId: "anthropic", modelId: "claude-sonnet-4-5-20250929" }],
    })
    expect(result.warnings.find((w) => w.code === "roster-pin-unhonoured")!.detail!.pins).toEqual([
      { providerId: "anthropic", modelId: "claude-sonnet-4-5", reason: "excluded" },
    ])
  })

  test("a pin to an id the exclusions left is honoured through that route, and recovery keeps it pinned", () => {
    const host = [
      candidate("anthropic", "claude-sonnet-4-5"),
      candidate("anthropic", "claude-sonnet-4-5-20250929"),
      candidate("openai", "gpt-5"),
    ]
    const result = selectRoster(host, {
      ...REQUIRE,
      pins: [{ providerId: "anthropic", modelId: "claude-sonnet-4-5-20250929" }],
      exclude: [{ providerId: "anthropic", modelId: "claude-sonnet-4-5" }],
    })
    expect(result.roster.slots[0]).toMatchObject({ slot: "discovery-1", providerId: "anthropic", modelId: "claude-sonnet-4-5-20250929" })
    expect(result.recovery.pinned).toEqual(["discovery-1"])
    expect(result.warnings.some((w) => w.code === "roster-pin-unhonoured")).toBe(false)
  })

  test("an excluded route the host declares no tool calling for is reported as excluded, not as lacking the capability", () => {
    const host = [candidate("anthropic", "claude-sonnet-4-5", false), candidate("openai", "gpt-5")]
    const result = selectRoster(host, {
      ...REQUIRE,
      pins: [{ providerId: "anthropic", modelId: "claude-sonnet-4-5" }],
      exclude: [{ providerId: "anthropic", modelId: "claude-sonnet-4-5" }],
    })
    expect(result.warnings.find((w) => w.code === "roster-pin-unhonoured")!.detail!.pins).toEqual([
      { providerId: "anthropic", modelId: "claude-sonnet-4-5", reason: "excluded" },
    ])
    // The removed offering is not counted again as one lacking the capability.
    expect(result.warnings.some((w) => w.code === "roster-capability-excluded")).toBe(false)
  })

  test("every requested exclusion is reported once, with what it removed, including one that matched nothing", () => {
    const result = selectRoster(HOST, {
      ...REQUIRE,
      exclude: [
        { providerId: "openai", modelId: "gpt-5" },
        { providerId: "OpenAI", modelId: "gpt-5" },
        { providerId: "mistral", modelId: "large" },
      ],
    })
    const warning = result.warnings.find((w) => w.code === "roster-caller-excluded")!
    expect(warning.message).toBe(
      "MODELS EXCLUDED BY THE CALLER: 2 exclusion(s) removed 1 of the 5 provider/model offering(s) the host lists — " +
        "`openai/gpt-5` (1 offering(s) removed); `mistral/large` (matched no offering the host lists). " +
        "Selection, lenses and replacement did not use them. 1 exclusion(s) matched nothing; check the provider and " +
        "model ids against the `provider` key in the host's configuration.",
    )
    expect(warning.detail).toEqual({
      exclusions: [
        { providerId: "openai", modelId: "gpt-5", removed: 1 },
        { providerId: "mistral", modelId: "large", removed: 0 },
      ],
      offerings: 5,
      removedOfferings: 1,
    })
  })

  test("a caller-supplied id is sanitized in the report and the list is bounded", () => {
    const exclude = [
      { providerId: "evil`\nrow", modelId: "x".repeat(200) },
      ...Array.from({ length: 13 }, (_, i) => ({ providerId: "p", modelId: `m${i}` })),
    ]
    const warning = selectRoster(HOST, { ...REQUIRE, exclude }).warnings.find((w) => w.code === "roster-caller-excluded")!
    expect(warning.message).not.toContain("\n")
    expect(warning.message).not.toContain("evil`")
    expect(warning.message).toContain("…")
    expect(warning.message).toContain("; … and 2 further exclusion(s) not listed here")
    expect((warning.detail!.exclusions as unknown[]).length).toBe(14)
  })

  test("an entry that is not a provider/model pair refuses selection before anything else, naming it", () => {
    for (const bad of [
      { providerId: "", modelId: "gpt-5" },
      { providerId: "openai", modelId: "  " },
      { providerId: 7, modelId: "gpt-5" },
      null,
      undefined,
    ]) {
      const run = () => selectRoster(HOST, { ...REQUIRE, exclude: [{ providerId: "openai", modelId: "gpt-5" }, bad as never] })
      expect(run).toThrow(InvalidExclusionError)
      expect(run).toThrow("1 excluded model(s) are not provider/model pairs")
    }
    // Before the host's own state is judged: an empty host still reports the bad entry.
    expect(() => selectRoster([], { ...OPTS, exclude: [{ providerId: "", modelId: "gpt-5" }] })).toThrow(InvalidExclusionError)
    expect(() => selectRoster([], { ...OPTS, exclude: [{ providerId: "openai", modelId: "gpt-5" }] })).toThrow(NoCandidatesError)
  })

  test("exclusions that remove every offering refuse with their own message, not the tool-calling one", () => {
    const run = () =>
      selectRoster([candidate("openai", "gpt-5"), candidate("OpenAI", "gpt-5")], {
        ...REQUIRE,
        exclude: [{ providerId: "openai", modelId: "gpt-5" }],
      })
    expect(run).toThrow(AllOfferingsExcludedError)
    expect(run).toThrow("The host offers 2 provider/model offering(s), and the caller's exclusions remove every one of them")
    expect(run).not.toThrow("tool calling")
  })

  test("exclusions and the tool-calling filter together leaving nothing are both named", () => {
    const run = () =>
      selectRoster([candidate("openai", "gpt-5"), candidate("xai", "grok-4", false)], {
        ...REQUIRE,
        exclude: [{ providerId: "openai", modelId: "gpt-5" }],
      })
    expect(run).toThrow(NoEligibleCandidatesError)
    expect(run).toThrow(
      "The host offers 2 provider/model offering(s); the caller's exclusions remove 1, and none of the remaining 1 declares tool calling",
    )
    expect(run).toThrow("Exclude fewer models, or configure a provider whose models support tool calling")
  })

  test("the capability and underfilled reports count what the exclusions left, and say so", () => {
    const host = [candidate("openai", "gpt-5"), candidate("google", "gemini-2.5-pro"), candidate("xai", "grok-4", false)]
    const { warnings } = selectRoster(host, { ...REQUIRE, exclude: [{ providerId: "google", modelId: "gemini-2.5-pro" }] })
    const byCode = new Map(warnings.map((w) => [w.code, w]))
    expect(byCode.get("roster-capability-excluded")!.message).toContain(
      "MODELS LEFT OUT: 1 of the 2 provider/model offering(s) the caller did not exclude do not declare tool calling",
    )
    expect(byCode.get("roster-capability-excluded")!.detail).toMatchObject({ offerings: 2, incapableOfferings: 1 })
    const underfilled = byCode.get("roster-underfilled")!
    expect(underfilled.message).toContain(
      "the host offers only 1 distinct model(s) that declare tool calling and are not excluded by the caller (3 candidate(s) before dedupe, 1 of them excluded)",
    )
    expect(underfilled.message).toContain("in the host's configuration, or exclude fewer models, to fill the remaining slot(s).")
    expect(underfilled.detail).toMatchObject({ excludedOfferings: 1 })

    const noRequirement = selectRoster(host, { ...OPTS, exclude: [{ providerId: "google", modelId: "gemini-2.5-pro" }] }).warnings
    expect(noRequirement.find((w) => w.code === "roster-underfilled")!.message).toContain(
      "only 2 distinct model(s) that are not excluded by the caller (3 candidate(s) before dedupe, 1 of them excluded)",
    )
  })
})
