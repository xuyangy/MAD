/**
 * Adapter tests for roster enumeration (AD-3). Drives the real
 * `enumerateCandidates` / `resolveRoster` against a hand-written v1 client fake.
 */

import { describe, expect, test } from "bun:test"

import { NoCandidatesError, NoEligibleCandidatesError } from "../../core/roster/select.ts"
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
  test("hands the host's models to core selection, requiring tool calling: gpt-5 (declared false) is left out", async () => {
    const { roster, warnings } = await resolveRoster(fakeClient(TWO_PROVIDERS), 2)
    expect(roster.slots.map((s) => `${s.providerId}/${s.modelId}`)).toEqual([
      "anthropic/claude-sonnet-4-5-20250929",
      "anthropic/claude-haiku-4-5",
    ])
    expect(roster.distinctLineages).toBe(1)
    expect(warnings.find((w) => w.code === "roster-capability-excluded")?.detail).toEqual({
      requirement: "toolcall",
      offerings: 3,
      incapableOfferings: 1,
      excludedModels: 1,
    })
  })

  test("a model whose capabilities are missing is not declared able to call tools, so it is left out", async () => {
    const body = {
      providers: [
        { id: "anthropic", models: { a: model("claude-sonnet-4-5", true) } },
        { id: "local", models: { b: { id: "gpt-5", name: "gpt-5" } } },
      ],
      default: {},
    }
    const { roster, warnings } = await resolveRoster(fakeClient(body), 2)
    expect(roster.slots.map((s) => s.modelId)).toEqual(["claude-sonnet-4-5"])
    expect(warnings.some((w) => w.code === "roster-capability-excluded")).toBe(true)
  })

  test("the image-preview model the host lists first through openrouter, without tool calling, is served by google, which declares it", async () => {
    // The shape a live run met on opencode-ai 1.19.5: openrouter listed before
    // google, and its route to the model declared `toolcall: false`.
    const body = {
      providers: [
        { id: "gitlab", models: { a: model("duo-chat-gpt-5-6-terra", true) } },
        {
          id: "openrouter",
          models: { b: model("google/gemini-3-pro-image-preview", false), c: model("amazon/nova-pro-v1", true) },
        },
        { id: "google", models: { d: model("gemini-3-pro-image-preview", true) } },
      ],
      default: {},
    }
    const { roster } = await resolveRoster(fakeClient(body), 3)
    const gemini = roster.slots.find((s) => s.identity === "gemini-3-pro-image")!
    expect(`${gemini.providerId}/${gemini.modelId}`).toBe("google/gemini-3-pro-image-preview")
    expect(gemini.toolcall).toBe(true)
    expect(gemini.alsoAvailableVia).toEqual(["openrouter"])
    expect(roster.slots.every((s) => s.toolcall)).toBe(true)
  })

  test("a host whose models all lack tool calling is refused with its own guidance, naming the config key", async () => {
    const client = fakeClient({ providers: [{ id: "openrouter", models: { a: model("google/gemini-3-pro-image-preview", false) } }], default: {} })
    await expect(resolveRoster(client, 1)).rejects.toThrow(NoEligibleCandidatesError)
    await expect(resolveRoster(client, 1)).rejects.toThrow("`provider`")
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

describe("opencode's wording for selection's remedies (OPENCODE_HOST_GUIDANCE)", () => {
  // Exact messages through resolveRoster, so the adapter's wiring, not a copy of
  // the constant, is what keeps opencode's guidance.
  test("no providers, and no provider declaring tool calling", async () => {
    await expect(resolveRoster(fakeClient({ providers: [], default: {} }), 1)).rejects.toThrow(
      "No models are available from the host, so there is nothing to review with. Configure at least one provider in your opencode config (the `provider` key) or authenticate one with `opencode auth login`, then run the review again. MAD holds no credentials and names no model of its own.",
    )
    const incapable = fakeClient({ providers: [{ id: "openrouter", models: { a: model("google/gemini-3-pro-image-preview", false) } }], default: {} })
    await expect(resolveRoster(incapable, 1)).rejects.toThrow(
      "The host offers 1 provider/model offering(s), but none declares tool calling, which this host needs to return MAD's structured answers, so there is nothing to review with. Configure a provider whose models support tool calling in your opencode config (the `provider` key) or authenticate one with `opencode auth login`, then run the review again. MAD holds no credentials and names no model of its own.",
    )
  })

  test("every roster remedy names the opencode config and why opencode needs tool calling", async () => {
    const { warnings } = await resolveRoster(fakeClient(TWO_PROVIDERS), 3, ["security", "performance"], [
      { providerId: "openai", modelId: "gpt-5" },
    ])
    const messages = Object.fromEntries(warnings.filter((w) => w.code !== "provider-fan-out").map((w) => [w.code, w.message]))
    expect(messages).toEqual({
      "roster-pin-unhonoured":
        "PIN NOT HONOURED: 1 of 1 pinned model(s) did not fill a slot — `openai/gpt-5` (the host does not declare tool calling for it through this provider, and this host needs it for structured answers). Those slot(s) fell through to ranking and the run PROCEEDS with the roster below; MAD names no model of its own and does not refuse a run over a pin. Check the provider and model ids against the `provider` key in your opencode config.",
      "roster-capability-excluded":
        "MODELS LEFT OUT: 1 of the 3 provider/model offering(s) the host lists do not declare tool calling, which this host needs to return MAD's structured answers, so selection did not use them. 1 model(s) were left out entirely; other excluded offerings share a model identity with an eligible offering. A declared capability does not guarantee a working endpoint.",
      "roster-underfilled":
        "UNDERFILLED ROSTER: 3 discovery slot(s) requested but the host offers only 2 distinct model(s) that declare tool calling (3 candidate(s) before dedupe). The run proceeds with a smaller roster; every co-discovery fraction is over what answered, not over 3. Add a provider under the `provider` key in your opencode config to fill the remaining slot(s).",
      "roster-single-lineage":
        "DEGRADED ROSTER: 3 discovery slot(s) requested but only 1 distinct verified lineage(s) available (Claude (Anthropic), Claude (Anthropic)). Co-discovery over a roster this narrow is a WEAK SIGNAL — models from one lineage share training data and therefore share blind spots. Add a provider from another lineage under the `provider` key in your opencode config to fix this. Temperature variation across one model is not an accepted substitute for a diverse roster.",
      "roster-lens-homogeneous":
        "LENS ROSTER HOMOGENEOUS: all 2 lens slot(s) resolved to 2 models of ONE lineage (Claude (Anthropic)): anthropic/claude-sonnet-4-5-20250929, anthropic/claude-haiku-4-5 (security, performance). Several personas over one lineage share that lineage's blind spots, so these lenses buy COVERAGE and not independence. Lens variation is not an accepted substitute for a diverse roster, on the same grounds as temperature variation. Add a provider from another lineage under the `provider` key in your opencode config to spread them. Lens slots never count toward distinct lineages, so this is a separate fact from the roster report.",
    })
  })
})
