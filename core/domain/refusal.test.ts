import { describe, expect, test } from "bun:test"

import {
  coveredByRefusalWords,
  coveringRefusal,
  describeRefusal,
  excludedByDetail,
  refusalCovers,
  type Refusal,
} from "./refusal.ts"

const base = { providerId: "anthropic", modelId: "claude-opus-5-5" } as const

describe("describeRefusal — the one description every stage's warnings use", () => {
  test("names the kind, the scope and the evidence; only an account refusal from a host text disclaims the balance", () => {
    const cases: [Refusal, string][] = [
      [
        { ...base, kind: "capability", basis: "host-signature", scope: "route" },
        "a capability refusal (the route does not accept MAD's forced tool choice) for the route " +
          "`anthropic/claude-opus-5-5`, recognised from a known host error text",
      ],
      [
        { ...base, kind: "capability", basis: "structured", scope: "route" },
        "a capability refusal (the route does not accept MAD's forced tool choice) for the route " +
          "`anthropic/claude-opus-5-5`, from the host's structured error",
      ],
      [
        { ...base, kind: "capability", basis: "host-signature", scope: "provider" },
        "a capability refusal (the route does not accept MAD's forced tool choice) for provider " +
          "`anthropic`, recognised from a known host error text",
      ],
      [
        { ...base, kind: "payment", basis: "structured", scope: "route" },
        "a payment refusal for the route `anthropic/claude-opus-5-5`, from the host's structured error",
      ],
      [
        { ...base, kind: "payment", basis: "host-signature", scope: "route" },
        "a payment refusal for the route `anthropic/claude-opus-5-5`, recognised from a known host error " +
          "text, not from a checked account balance",
      ],
      [
        { ...base, kind: "payment", basis: "structured", scope: "provider" },
        "a payment refusal for provider `anthropic`, from the host's structured error",
      ],
      [
        { ...base, kind: "auth", basis: "host-signature", scope: "provider" },
        "an authentication refusal for provider `anthropic`, recognised from a known host error text, " +
          "not from a checked account balance",
      ],
    ]
    for (const [refusal, words] of cases) expect(describeRefusal(refusal)).toBe(words)
  })
})

describe("refusalCovers — which routes a refusal also speaks for", () => {
  const route: Refusal = { ...base, kind: "capability", basis: "host-signature", scope: "route" }
  const provider: Refusal = { ...base, kind: "payment", basis: "structured", scope: "provider" }

  test("a route refusal covers its own provider/model route only", () => {
    expect(refusalCovers(route, { providerId: "anthropic", modelId: "claude-opus-5-5" })).toBe(true)
    // Same provider, other model: stays eligible.
    expect(refusalCovers(route, { providerId: "anthropic", modelId: "claude-sonnet-5" })).toBe(false)
    // Same model id through another provider: another route.
    expect(refusalCovers(route, { providerId: "openrouter", modelId: "claude-opus-5-5" })).toBe(false)
  })

  test("a provider refusal covers every model on its provider and nothing else", () => {
    expect(refusalCovers(provider, { providerId: "anthropic", modelId: "claude-opus-5-5" })).toBe(true)
    expect(refusalCovers(provider, { providerId: "anthropic", modelId: "claude-sonnet-5" })).toBe(true)
    expect(refusalCovers(provider, { providerId: "openai", modelId: "claude-opus-5-5" })).toBe(false)
  })

  test("provider ids compare without regard to case, model ids exactly", () => {
    expect(refusalCovers(route, { providerId: "Anthropic", modelId: "claude-opus-5-5" })).toBe(true)
    expect(refusalCovers(route, { providerId: "anthropic", modelId: "Claude-Opus-5-5" })).toBe(false)
    expect(refusalCovers(provider, { providerId: "ANTHROPIC", modelId: "x" })).toBe(true)
  })

  test("coveringRefusal never names a slot's own refusal, and returns the first that covers it", () => {
    const refusals = [
      { slot: "discovery-1", refusal: route },
      { slot: "discovery-2", refusal: provider },
    ]
    const onRoute = { slot: "discovery-lens-security", providerId: "anthropic", modelId: "claude-opus-5-5" }
    expect(coveringRefusal(refusals, onRoute)).toEqual(refusals[0])
    expect(coveringRefusal(refusals, { ...onRoute, slot: "discovery-1" })).toEqual(refusals[1])
    expect(coveringRefusal([refusals[0]!], { ...onRoute, slot: "discovery-1" })).toBeUndefined()
    expect(coveringRefusal(refusals, { slot: "discovery-3", providerId: "openai", modelId: "gpt-6" })).toBeUndefined()
  })

  test("the exclusion's words name the refused slot, its route and the refusal; the detail carries kind, basis and scope", () => {
    const by = { slot: "discovery-1", refusal: route }
    expect(coveredByRefusalWords(by)).toBe(
      "is not asked again in this run: slot discovery-1 (`anthropic/claude-opus-5-5`) received a refusal " +
        `that covers it (${describeRefusal(route)})`,
    )
    expect(excludedByDetail(by)).toEqual({
      slot: "discovery-1",
      refusal: { kind: "capability", basis: "host-signature", scope: "route" },
    })
  })
})
