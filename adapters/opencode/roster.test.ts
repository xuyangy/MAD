/**
 * Adapter tests for roster enumeration (AD-3). Drives the real
 * `enumerateCandidates` / `resolveRoster` against a hand-written v1 client fake.
 */

import { describe, expect, test } from "bun:test"

import { NoCandidatesError } from "../../core/roster/select.ts"
import { enumerateCandidates, ProviderEnumerationError, resolveRoster } from "./roster.ts"

function model(id: string, toolcall: boolean, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    capabilities: { toolcall },
    limit: { context: 200000 },
    cost: { input: 3, output: 15 },
    ...extra,
  }
}

function fakeClient(body: unknown, error?: unknown) {
  return {
    config: {
      providers: async () => (error ? { error } : { data: body }),
    },
  } as never
}

const TWO_PROVIDERS = {
  providers: [
    {
      id: "anthropic",
      name: "Anthropic",
      source: "env",
      env: [],
      options: {},
      models: {
        a: model("claude-haiku-4-5", true),
        b: model("claude-sonnet-4-5-20250929", true),
      },
    },
    {
      id: "openai",
      name: "OpenAI",
      source: "env",
      env: [],
      options: {},
      models: { c: model("gpt-5", false) },
    },
  ],
  default: { anthropic: "claude-sonnet-4-5-20250929", openai: "gpt-5" },
}

describe("enumerateCandidates (AD-3)", () => {
  test("flattens every provider's models into candidates", async () => {
    const candidates = await enumerateCandidates(fakeClient(TWO_PROVIDERS))
    expect(candidates).toHaveLength(3)
    expect(candidates.map((c) => `${c.providerId}/${c.modelId}`).sort()).toEqual([
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-sonnet-4-5-20250929",
      "openai/gpt-5",
    ])
  })

  test("reads `capabilities.toolcall` rather than assuming it", async () => {
    const candidates = await enumerateCandidates(fakeClient(TWO_PROVIDERS))
    expect(candidates.find((c) => c.modelId === "gpt-5")!.toolcall).toBe(false)
    expect(candidates.find((c) => c.modelId === "claude-haiku-4-5")!.toolcall).toBe(true)
  })

  test("a missing capabilities block is `false`, never an optimistic default", async () => {
    const candidates = await enumerateCandidates(
      fakeClient({
        providers: [
          { id: "acme", name: "Acme", source: "config", env: [], options: {}, models: { m: { id: "acme-1" } } },
        ],
        default: {},
      }),
    )
    expect(candidates[0]!.toolcall).toBe(false)
  })

  test("the provider's default model comes first WITHIN that provider", async () => {
    const candidates = await enumerateCandidates(fakeClient(TWO_PROVIDERS))
    // Providers stay in host order; only the order inside a provider changes,
    // because dedupe is first-wins and hoisting defaults globally would silently
    // change which provider owns a slot.
    expect(candidates.map((c) => c.modelId)).toEqual([
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5",
      "gpt-5",
    ])
  })

  test("skips models with no usable id", async () => {
    const candidates = await enumerateCandidates(
      fakeClient({
        providers: [
          {
            id: "acme",
            name: "Acme",
            source: "config",
            env: [],
            options: {},
            models: { good: model("acme-1", true), blank: model("", true), missing: { name: "x" } },
          },
        ],
        default: {},
      }),
    )
    expect(candidates.map((c) => c.modelId)).toEqual(["acme-1"])
  })

  test("a transport failure is NOT reported as 'you have no providers'", async () => {
    // Telling a user with a working setup to go configure a provider is worse
    // than useless; it sends them to fix something that is not broken.
    const client = fakeClient(undefined, { name: "NetworkError", data: { message: "ECONNREFUSED" } })
    await expect(enumerateCandidates(client)).rejects.toThrow(ProviderEnumerationError)
    await expect(enumerateCandidates(client)).rejects.toThrow("ECONNREFUSED")
  })

  test("an empty provider list is genuinely empty", async () => {
    expect(await enumerateCandidates(fakeClient({ providers: [], default: {} }))).toEqual([])
  })
})

describe("resolveRoster (AD-3, AD-4)", () => {
  test("hands the host's models to core selection and gets a diverse roster back", async () => {
    const { roster } = await resolveRoster(fakeClient(TWO_PROVIDERS), 2)
    expect(roster.slots.map((s) => s.lineage.lineage)).toEqual(["claude", "gpt"])
    expect(roster.distinctLineages).toBe(2)
  })

  test("PINS REACH CORE SELECTION and change which model takes discovery-1 (story 8A)", async () => {
    // The pass-through, and nothing more: this adapter validates no pin itself.
    // `selectRoster` is the only place that can tell "the host does not offer it"
    // from "dedupe already collapsed it", and a second, quieter authority here
    // would be a miss reported twice or not at all.
    const base = await resolveRoster(fakeClient(TWO_PROVIDERS), 2)
    const pinned = await resolveRoster(fakeClient(TWO_PROVIDERS), 2, [], [
      { providerId: base.roster.slots[1]!.providerId, modelId: base.roster.slots[1]!.modelId },
    ])

    expect(pinned.roster.slots[0]!.modelId).toBe(base.roster.slots[1]!.modelId)
    expect(pinned.roster.distinctLineages).toBe(base.roster.distinctLineages)
  })

  test("omitting pins resolves the roster this adapter resolved before story 8A", async () => {
    const base = await resolveRoster(fakeClient(TWO_PROVIDERS), 2)
    const explicit = await resolveRoster(fakeClient(TWO_PROVIDERS), 2, [], [])
    expect(explicit.roster).toEqual(base.roster)
    expect(explicit.warnings).toEqual(base.warnings)
  })

  test("no providers surfaces the guidance error, naming the opencode config key", async () => {
    const client = fakeClient({ providers: [], default: {} })
    await expect(resolveRoster(client, 1)).rejects.toThrow(NoCandidatesError)
    await expect(resolveRoster(client, 1)).rejects.toThrow("`provider`")
  })
})
