/**
 * Discovery recovery through the real backend: `selectRoster` builds the pool
 * and the plan, `OpencodeModelBackend` is bound to both, a scripted host client
 * answers by route and attempt, and `discover` runs round 1 and round 2.
 */

import { describe, expect, test } from "bun:test"

import { emptyLedger } from "../../core/domain/run-record.ts"
import { validateReplacements } from "../../core/domain/recovery.ts"
import type { LensSlot, Roster } from "../../core/domain/roster.ts"
import { lineageOf, normalizeModelIdentity } from "../../core/domain/lineage.ts"
import { CODING_DISCOVERY_GENERALIST as DISCOVERY_INSTRUCTIONS } from "../../core/instructions/coding/discovery.ts"
import type { RequestAdmission } from "../../core/ports/admission.ts"
import { selectRoster } from "../../core/roster/select.ts"
import { discover } from "../../core/stages/discover.ts"
import { candidate, fakeAdmission, fakeClock } from "../../core/test-support/fakes.ts"
import { createTurnRecorder } from "./artifacts.ts"
import { OpencodeModelBackend } from "./model-backend.ts"

const ZERO = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const KNOWN = { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } }
const GITLAB_CREDITS =
  'Failed to get direct access token: 402 Payment Required - {"message":"Token creation failed: not enough GitLab Credits."}'
const GITLAB_REFUSAL = { error: { name: "UnknownError", data: { message: GITLAB_CREDITS } }, tokens: ZERO }
const PAYMENT_402 = { error: { name: "APIError", data: { statusCode: 402, isRetryable: false } }, tokens: ZERO }
const AUTH_PROVIDER = (providerID: string) => ({ error: { name: "ProviderAuthError", data: { providerID } }, tokens: ZERO })
const NOTHING_FOUND = { structured: { findings: [] }, tokens: KNOWN }
const FOUND = {
  structured: {
    findings: [
      { claim: "the page offset skips a page", reasoning: "start uses page, not page - 1", severity: "high", file: "pager.js", startLine: 3, endLine: 3 },
    ],
  },
  tokens: KNOWN,
}

type Answer = Record<string, unknown> | Promise<Record<string, unknown>>
type Script = (route: string, attempt: number) => Answer

/** A host client answering each prompt from `script(provider/model, attempt for that route)`. */
function scriptedHost(script: Script) {
  const attempts = new Map<string, number>()
  const prompts: string[] = []
  let sessions = 0
  return {
    prompts,
    client: {
      session: {
        create: async () => ({ data: { id: `ses_${++sessions}` } }),
        prompt: async (args: { model: { providerID: string; modelID: string } }) => {
          const route = `${args.model.providerID}/${args.model.modelID}`
          const attempt = (attempts.get(route) ?? 0) + 1
          attempts.set(route, attempt)
          prompts.push(route)
          return { data: { info: await script(route, attempt) } }
        },
        delete: async () => ({ data: true }),
      },
    },
  }
}

interface RunOptions {
  candidates: ReturnType<typeof candidate>[]
  slots: number
  script: Script
  plan?: boolean
  lensSlots?: LensSlot[]
  stopOnUnknownUsage?: boolean
  /** The run's token cap; discovery may spend its share of it. */
  cap?: number
  admission?: RequestAdmission
  signal?: AbortSignal
  wrap?: (backend: OpencodeModelBackend) => import("../../core/ports/model-backend.ts").ModelBackend
}

async function run(options: RunOptions) {
  const selected = selectRoster(options.candidates, { slots: options.slots, providerConfigKey: "provider", requireToolcall: true })
  const roster: Roster = { ...selected.roster, lensSlots: options.lensSlots ?? selected.roster.lensSlots }
  const host = scriptedHost(options.script)
  const backend = new OpencodeModelBackend({
    directory: "/repo",
    slots: [...roster.slots, ...roster.lensSlots, ...selected.recovery.candidates],
    client: host.client as never,
    cleanupTimeoutMs: 10,
  })
  const ledger = { ...emptyLedger(options.cap ?? null), stopOnUnknownUsage: options.stopOnUnknownUsage ?? false }
  const discovered = await discover({
    roster,
    ...(options.plan === false ? {} : { recovery: selected.recovery }),
    backend: options.wrap ? options.wrap(backend) : backend,
    instructions: DISCOVERY_INSTRUCTIONS,
    input: "diff",
    clock: fakeClock(),
    ledger,
    ...(options.admission === undefined ? {} : { admission: options.admission }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (discovered.recovery !== undefined) validateReplacements({ roster, recovery: discovered.recovery })
  const rowOf = (slot: string) => discovered.warnings.find((w) => w.code === "model-dropped-out" && w.detail?.slot === slot)
  return { selected, roster, plan: selected.recovery, discovered, ledger, prompts: host.prompts, rowOf }
}

const POOL = [
  candidate("gitlab", "duo-chat-gpt-5-6-terra"),
  candidate("anthropic", "claude-sonnet-4-5"),
  candidate("openrouter", "amazon/nova-pro-v1"),
]

describe("discovery recovery over the real backend", () => {
  test("a refused pool slot is replaced by the plan's first eligible route, which answers and fills the denominator", async () => {
    const result = await run({
      candidates: [...POOL, candidate("xai", "grok-4")],
      slots: 3,
      script: (route) => (route.startsWith("gitlab/") ? GITLAB_REFUSAL : route === "xai/grok-4" ? FOUND : NOTHING_FOUND),
    })
    const { discovered, prompts, rowOf } = result
    const gitlab = result.roster.slots.find((slot) => slot.providerId === "gitlab")!

    expect(prompts.filter((route) => route.startsWith("gitlab/"))).toHaveLength(1)
    expect(prompts.filter((route) => route === "xai/grok-4")).toHaveLength(1)
    expect(discovered.answered).toBe(3)
    expect(discovered.recovery).toEqual({
      refused: [{ slot: gitlab.slot, refusal: expect.objectContaining({ kind: "payment", scope: "provider" }) }],
      replacements: [{ from: gitlab.slot, to: result.plan.candidates[0]!, dispatched: 1, answered: true }],
      notReplaced: [],
    })
    expect(discovered.findings.map((finding) => finding.author)).toEqual(["discovery-r1"])
    expect(rowOf(gitlab.slot)!.message).toEndWith("It was replaced by slot discovery-r1.")
    const replaced = discovered.warnings.find((w) => w.code === "model-replaced")!
    expect(replaced.message).toContain(
      `MODEL REPLACED: \`gitlab/duo-chat-gpt-5-6-terra\` (slot ${gitlab.slot}) was refused (a payment refusal for provider ` +
        "`gitlab`, recognised from a known host error text, not from a checked account balance); MAD dispatched " +
        "`xai/grok-4` (slot discovery-r1) in its place, 1 time(s), and it answered discovery.",
    )
    // The restored denominator raises no reduced-denominator warning; the
    // refused attempt's unknown usage is still reported.
    expect(discovered.warnings.some((w) => w.code === "denominator-reduced")).toBe(false)
    expect(discovered.warnings.some((w) => w.code === "usage-unquantified")).toBe(true)
  })

  test("a replacement that is itself refused keeps its row, and nothing replaces it", async () => {
    const result = await run({
      candidates: [...POOL, candidate("xai", "grok-4"), candidate("mistral", "mistral-large")],
      slots: 3,
      script: (route) =>
        route.startsWith("gitlab/") ? GITLAB_REFUSAL : route === "xai/grok-4" ? PAYMENT_402 : NOTHING_FOUND,
    })
    const { discovered, prompts, rowOf } = result
    expect(prompts.filter((route) => route.startsWith("mistral/"))).toEqual([])
    expect(discovered.recovery!.replacements).toEqual([
      expect.objectContaining({ to: expect.objectContaining({ slot: "discovery-r1" }), dispatched: 1, answered: false }),
    ])
    expect(discovered.answered).toBe(2)
    expect(rowOf("discovery-r1")!.message).toContain("was refused on its only attempt")
    expect(discovered.warnings.find((w) => w.code === "model-replaced")!.message).toContain(
      "did not answer discovery, so it is not in the co-discovery denominator; the distinct-lineage count is the initial selection's.",
    )
    expect(discovered.warnings.find((w) => w.code === "model-replaced")!.message).not.toContain("count the replacement")
    expect(discovered.warnings.some((w) => w.code === "denominator-reduced")).toBe(true)
  })

  test("a provider refused at provider scope is skipped for the replacement, and the next route is taken", async () => {
    const result = await run({
      candidates: [...POOL, candidate("gitlab", "mistral-large"), candidate("xai", "grok-4")],
      slots: 3,
      script: (route) => (route.startsWith("gitlab/") ? GITLAB_REFUSAL : NOTHING_FOUND),
    })
    expect(result.plan.candidates[0]!.providerId).toBe("gitlab")
    expect(result.discovered.recovery!.replacements[0]!.to.providerId).toBe("xai")
    expect(result.prompts.filter((route) => route === "gitlab/mistral-large")).toEqual([])
  })

  test("a lens slot's provider-scope refusal excludes that provider from the replacement too", async () => {
    const lens: LensSlot = {
      slot: "discovery-lens-security",
      lens: "security",
      providerId: "q",
      modelId: "codestral-latest",
      identity: normalizeModelIdentity("codestral-latest"),
      lineage: lineageOf("codestral-latest"),
      toolcall: true,
      alsoAvailableVia: [],
    }
    const result = await run({
      candidates: [
        candidate("anthropic", "claude-sonnet-4-5"),
        candidate("openai", "gpt-5"),
        candidate("q", "mistral-large"),
        candidate("xai", "grok-4"),
      ],
      slots: 2,
      lensSlots: [lens],
      script: (route) =>
        route === "openai/gpt-5" ? PAYMENT_402 : route.startsWith("q/") ? AUTH_PROVIDER("q") : NOTHING_FOUND,
    })
    expect(result.plan.candidates[0]!.providerId).toBe("q")
    expect(result.discovered.recovery!.refused.map((entry) => entry.slot)).toEqual(["discovery-2"])
    expect(result.discovered.recovery!.replacements[0]!.to.providerId).toBe("xai")
  })

  test("no unused route: not replaced, and the drop-out row says why", async () => {
    const result = await run({
      candidates: POOL,
      slots: 3,
      script: (route) => (route.startsWith("gitlab/") ? GITLAB_REFUSAL : NOTHING_FOUND),
    })
    const gitlab = result.roster.slots.find((slot) => slot.providerId === "gitlab")!
    expect(result.discovered.recovery!.notReplaced).toEqual([{ from: gitlab.slot, reason: "no-candidate" }])
    expect(result.rowOf(gitlab.slot)!.message).toEndWith(
      "It was not replaced: the host offers no unused model on a provider or route that was not refused.",
    )
    expect(result.discovered.warnings.some((w) => w.code === "model-replaced")).toBe(false)
  })

  test("no plan: not replaced, and no reserve route is prompted", async () => {
    const result = await run({
      candidates: [...POOL, candidate("xai", "grok-4")],
      slots: 3,
      plan: false,
      script: (route) => (route.startsWith("gitlab/") ? GITLAB_REFUSAL : NOTHING_FOUND),
    })
    expect(result.discovered.recovery!.notReplaced).toEqual([expect.objectContaining({ reason: "no-plan" })])
    expect(result.prompts.some((route) => route.startsWith("xai/"))).toBe(false)
  })

  test("with the unknown-usage stop set, the refusal's unknown bill refuses the replacement before it is dispatched", async () => {
    const result = await run({
      candidates: [...POOL, candidate("xai", "grok-4")],
      slots: 3,
      stopOnUnknownUsage: true,
      script: (route) => (route.startsWith("gitlab/") ? GITLAB_REFUSAL : NOTHING_FOUND),
    })
    expect(result.discovered.recovery!.notReplaced).toEqual([expect.objectContaining({ reason: "budget" })])
    expect(result.discovered.recovery!.replacements).toEqual([])
    expect(result.prompts.some((route) => route.startsWith("xai/"))).toBe(false)
    // No trace of the reserve slot outside the original's not-replaced cause.
    expect(result.discovered.skippedForBudget).not.toContain("discovery-r1")
  })

  test("the experiment's admission refusing the replacement is recorded with its reason", async () => {
    const admission = fakeAdmission((request) => request.slot.startsWith("discovery-r"))
    const result = await run({
      candidates: [...POOL, candidate("xai", "grok-4")],
      slots: 3,
      admission: admission.admission,
      script: (route) => (route.startsWith("gitlab/") ? GITLAB_REFUSAL : NOTHING_FOUND),
    })
    expect(result.discovered.recovery!.notReplaced).toEqual([
      expect.objectContaining({ reason: "admission", detail: "refused by the fake admission" }),
    ])
    expect(result.prompts.some((route) => route.startsWith("xai/"))).toBe(false)
  })

  test("a stop after allocation, before the replacement is dispatched: not replaced, cancelled", async () => {
    const controller = new AbortController()
    // The stop lands while the replacement's turn is being admitted: allocated,
    // not yet dispatched.
    const admission = fakeAdmission(
      () => false,
      (request) => {
        if (request.slot.startsWith("discovery-r")) controller.abort()
      },
    )
    const result = await run({
      candidates: [...POOL, candidate("xai", "grok-4")],
      slots: 3,
      signal: controller.signal,
      admission: admission.admission,
      script: (route) => (route.startsWith("gitlab/") ? GITLAB_REFUSAL : NOTHING_FOUND),
    })
    expect(result.discovered.recovery!.notReplaced).toEqual([expect.objectContaining({ reason: "cancelled" })])
    expect(result.prompts.some((route) => route.startsWith("xai/"))).toBe(false)
  })

  test("a stop while the replacement is in flight keeps the replacement, dispatched once, not answered", async () => {
    const controller = new AbortController()
    const result = await run({
      candidates: [...POOL, candidate("xai", "grok-4")],
      slots: 3,
      signal: controller.signal,
      script: (route) => {
        if (route.startsWith("gitlab/")) return GITLAB_REFUSAL
        if (route === "xai/grok-4") {
          controller.abort()
          return new Promise(() => {})
        }
        return NOTHING_FOUND
      },
    })
    expect(result.discovered.recovery!.replacements).toEqual([expect.objectContaining({ dispatched: 1, answered: false })])
    expect(result.discovered.cancelled).toBe(true)
  })

  test("two refused slots are allocated in slot order, however their turns completed", async () => {
    const result = await run({
      candidates: [...POOL, candidate("xai", "grok-4"), candidate("mistral", "mistral-large")],
      slots: 3,
      script: async (route) => {
        if (route.startsWith("gitlab/")) {
          await new Promise((resolve) => setTimeout(resolve, 30))
          return GITLAB_REFUSAL
        }
        if (route.startsWith("openrouter/amazon")) return PAYMENT_402
        return NOTHING_FOUND
      },
    })
    const bySlot = new Map(result.discovered.recovery!.replacements.map((r) => [r.from, r.to.slot]))
    const refusedInOrder = result.roster.slots.filter((slot) => bySlot.has(slot.slot)).map((slot) => bySlot.get(slot.slot))
    expect(refusedInOrder).toEqual(["discovery-r1", "discovery-r2"])
  })

  test("a refusal with known usage records that usage and is still not retried", async () => {
    const result = await run({
      candidates: [...POOL, candidate("xai", "grok-4")],
      slots: 3,
      script: (route) => (route.startsWith("gitlab/") ? { ...GITLAB_REFUSAL, tokens: KNOWN } : NOTHING_FOUND),
    })
    const gitlab = result.roster.slots.find((slot) => slot.providerId === "gitlab")!
    expect(result.prompts.filter((route) => route.startsWith("gitlab/"))).toHaveLength(1)
    expect(result.ledger.entries.filter((entry) => entry.slot === gitlab.slot)).toHaveLength(1)
    expect(result.ledger.unknownUsage.filter((entry) => entry.slot === gitlab.slot)).toEqual([])
  })

  test("through the artifact recorder, the replacement turn is dumped and reaches the backend with its admission handle", async () => {
    const admission = fakeAdmission(() => false, undefined, true)
    const recorder = createTurnRecorder()
    // Under the recorder, a backend that notes the admission handle each turn
    // arrives with before handing it on.
    const handles = new Map<string, unknown>()
    const result = await run({
      candidates: [...POOL, candidate("xai", "grok-4")],
      slots: 3,
      admission: admission.admission,
      wrap: (backend) =>
        recorder.wrap({
          capabilities: (slot) => backend.capabilities(slot),
          runTurn: (slot, instructions, input, schema, signal, admitted) => {
            handles.set(slot, admitted)
            return backend.runTurn(slot, instructions, input, schema, signal, admitted)
          },
        }),
      script: (route) => (route.startsWith("gitlab/") ? GITLAB_REFUSAL : NOTHING_FOUND),
    })
    expect(result.discovered.recovery!.replacements).toHaveLength(1)
    expect(recorder.turns.some((turn) => turn.slot === "discovery-r1")).toBe(true)
    expect(handles.get("discovery-r1")).toBeDefined()
    // Settled once, by the stage that admitted it.
    expect(admission.settlements.filter((entry) => entry.request.slot === "discovery-r1")).toHaveLength(1)
  })
})

describe("discovery recovery — stops and limits around round 2", () => {
  for (const plan of [true, false]) {
    test(`a stop during round 1 is why a refused slot is not replaced (${plan ? "no unused route" : "no plan"})`, async () => {
      const controller = new AbortController()
      const result = await run({
        candidates: POOL,
        slots: 3,
        plan,
        signal: controller.signal,
        script: async (route) => {
          if (route.startsWith("gitlab/")) return GITLAB_REFUSAL
          await new Promise((resolve) => setTimeout(resolve, 20))
          controller.abort()
          return NOTHING_FOUND
        },
      })
      const gitlab = result.roster.slots.find((slot) => slot.providerId === "gitlab")!
      expect(result.discovered.recovery!.notReplaced).toEqual([{ from: gitlab.slot, reason: "cancelled" }])
      expect(result.discovered.warnings.some((w) => w.code === "model-replaced")).toBe(false)
      expect(result.rowOf(gitlab.slot)!.message).toEndWith(
        "It was not replaced: the run was stopped before a replacement was dispatched.",
      )
    })
  }

  test("known spend exhausting discovery's share before round 2 refuses the replacement as budget", async () => {
    // Discovery's share of a 50-token cap is 15; the two answering pool turns
    // report 10 each, so nothing more is admitted.
    const result = await run({
      candidates: [...POOL, candidate("xai", "grok-4")],
      slots: 3,
      cap: 50,
      script: (route) => (route.startsWith("gitlab/") ? GITLAB_REFUSAL : NOTHING_FOUND),
    })
    const gitlab = result.roster.slots.find((slot) => slot.providerId === "gitlab")!
    expect(result.discovered.recovery!.notReplaced).toEqual([{ from: gitlab.slot, reason: "budget" }])
    expect(result.prompts.some((route) => route.startsWith("xai/"))).toBe(false)
    expect(result.discovered.skippedForBudget).toEqual([])
    // The refused attempt's bill is kept.
    expect(result.ledger.unknownUsage.filter((entry) => entry.slot === gitlab.slot)).toHaveLength(1)
  })

  test("a replacement whose first attempt fails and whose retry the admission refuses stays a replacement", async () => {
    const admission = fakeAdmission((request) => request.slot === "discovery-r1" && request.attempt === 2)
    const result = await run({
      candidates: [...POOL, candidate("xai", "grok-4")],
      slots: 3,
      admission: admission.admission,
      script: (route) =>
        route.startsWith("gitlab/")
          ? GITLAB_REFUSAL
          : route === "xai/grok-4"
            ? { error: { name: "UnknownError", data: { message: "upstream hiccup" } }, tokens: KNOWN }
            : NOTHING_FOUND,
    })
    expect(result.discovered.recovery!.replacements).toEqual([
      expect.objectContaining({ to: expect.objectContaining({ slot: "discovery-r1" }), dispatched: 1, answered: false }),
    ])
    expect(result.discovered.recovery!.notReplaced).toEqual([])
    expect(result.prompts.filter((route) => route === "xai/grok-4")).toHaveLength(1)
    expect(admission.settlements.filter((entry) => entry.request.slot === "discovery-r1")).toHaveLength(1)
    const row = result.rowOf("discovery-r1")!
    expect(row.message).toContain(
      "failed once, and the experiment's admission refused the retry (refused by the fake admission)",
    )
    expect(row.message).not.toContain("the budget refused the retry")
    expect(row.detail).toMatchObject({ attempts: 1, admission: "refused by the fake admission" })
  })
})

describe("an inconsistent recovery plan", () => {
  test("is refused before any turn is dispatched", async () => {
    const selected = selectRoster([...POOL, candidate("xai", "grok-4")], { slots: 3, providerConfigKey: "provider", requireToolcall: true })
    const host = scriptedHost(() => NOTHING_FOUND)
    const backend = new OpencodeModelBackend({
      directory: "/repo",
      slots: [...selected.roster.slots, ...selected.recovery.candidates],
      client: host.client as never,
    })
    const colliding = { candidates: [{ ...selected.recovery.candidates[0]!, slot: selected.roster.slots[0]!.slot }] }
    await expect(
      discover({
        roster: selected.roster,
        recovery: colliding,
        backend,
        instructions: DISCOVERY_INSTRUCTIONS,
        input: "diff",
        clock: fakeClock(),
        ledger: emptyLedger(),
      }),
    ).rejects.toThrow("recovery plan is inconsistent")
    expect(host.prompts).toEqual([])
  })
})
