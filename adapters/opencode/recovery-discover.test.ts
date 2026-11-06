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
import { selectRoster, type Pin } from "../../core/roster/select.ts"
import { discover } from "../../core/stages/discover.ts"
import { candidate, fakeAdmission, fakeClock } from "../../core/test-support/fakes.ts"
import { createTurnRecorder } from "./artifacts.ts"
import { OpencodeModelBackend } from "./model-backend.ts"
import { cancelledTurn } from "../../core/ports/model-backend.ts"
import { REVIEW_SESSION_PERMISSION } from "./session-policy.ts"

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
  pins?: Pin[]
  wrap?: (backend: OpencodeModelBackend) => import("../../core/ports/model-backend.ts").ModelBackend
}

async function run(options: RunOptions) {
  const selected = selectRoster(options.candidates, {
    slots: options.slots,
    providerConfigKey: "provider",
    requireToolcall: true,
    ...(options.pins === undefined ? {} : { pins: options.pins }),
  })
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
      answeredLineages: 3,
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

  test("a provider-scope refusal excludes a case variant of that provider from the replacement", async () => {
    const result = await run({
      candidates: [...POOL, candidate("GitLab", "mistral-large"), candidate("xai", "grok-4")],
      slots: 3,
      script: (route) => (route.startsWith("gitlab/") ? GITLAB_REFUSAL : NOTHING_FOUND),
    })
    expect(`${result.plan.candidates[0]!.providerId}/${result.plan.candidates[0]!.modelId}`).toBe("GitLab/mistral-large")
    expect(result.discovered.recovery!.replacements[0]!.to.providerId).toBe("xai")
    expect(result.prompts.filter((route) => route === "GitLab/mistral-large")).toEqual([])
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

  test("no model outside the pool: not replaced, and the drop-out row says why", async () => {
    const result = await run({
      candidates: POOL,
      slots: 3,
      script: (route) => (route.startsWith("gitlab/") ? GITLAB_REFUSAL : NOTHING_FOUND),
    })
    const gitlab = result.roster.slots.find((slot) => slot.providerId === "gitlab")!
    expect(result.discovered.recovery!.notReplaced).toEqual([{ from: gitlab.slot, reason: "no-candidate" }])
    expect(result.rowOf(gitlab.slot)!.message).toEndWith(
      "It was not replaced: the host offers no model outside the pool on a provider or route that was not refused.",
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
    // The cause is the unknown-usage stop, not the ceiling: no cap was set.
    expect(result.discovered.recovery!.notReplaced).toEqual([expect.objectContaining({ reason: "unknown-usage" })])
    const gitlab = result.roster.slots.find((slot) => slot.providerId === "gitlab")!
    expect(result.rowOf(gitlab.slot)!.message).toEndWith(
      "It was not replaced: the unknown-usage stop refused the replacement's turn before it was dispatched, " +
        "because an earlier turn's usage was not reported.",
    )
    expect(result.rowOf(gitlab.slot)!.message).not.toContain("the budget refused the replacement")
    expect(result.discovered.recovery!.replacements).toEqual([])
    expect(result.prompts.some((route) => route.startsWith("xai/"))).toBe(false)
    // No trace of the reserve slot outside the original's not-replaced cause.
    expect(result.discovered.skippedForBudget).not.toContain("discovery-r1")
    // The held replacement names the unknown-usage stop, never the ceiling.
    const truncated = result.discovered.warnings.find((w) => w.code === "discovery-truncated")!
    expect(truncated.message).toContain(
      "were never dispatched, because the unknown-usage stop refused it, because an earlier turn's usage was not reported.",
    )
    expect(truncated.message).not.toContain("past")
    expect(truncated.detail).toMatchObject({ replacementsHeld: [{ from: gitlab.slot, reason: "unknown-usage" }] })
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
    const truncated = result.discovered.warnings.find((w) => w.code === "discovery-truncated")!
    expect(truncated.message).toContain(
      "were never dispatched, because the experiment's admission refused it (refused by the fake admission).",
    )
    expect(truncated.message).not.toContain("past")
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
  const stopDuringRoundOne = (controller: AbortController) => async (route: string) => {
    if (route.startsWith("gitlab/")) return GITLAB_REFUSAL
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    return NOTHING_FOUND
  }

  test("a stop during round 1 is why a refused slot with an eligible route is not replaced, and discovery reports the stop", async () => {
    const controller = new AbortController()
    const result = await run({
      candidates: [...POOL, candidate("xai", "grok-4")],
      slots: 3,
      signal: controller.signal,
      script: stopDuringRoundOne(controller),
    })
    const gitlab = result.roster.slots.find((slot) => slot.providerId === "gitlab")!
    expect(result.discovered.recovery!.notReplaced).toEqual([{ from: gitlab.slot, reason: "cancelled" }])
    expect(result.discovered.cancelled).toBe(true)
    expect(result.prompts.some((route) => route.startsWith("xai/"))).toBe(false)
    expect(result.discovered.warnings.some((w) => w.code === "model-replaced")).toBe(false)
    expect(result.rowOf(gitlab.slot)!.message).toEndWith(
      "It was not replaced: the run was stopped before a replacement was dispatched.",
    )
  })

  for (const plan of [true, false]) {
    // Whether discovery reports the stop here depends on the round-1 turn the
    // stop cancelled in flight; "review — a stop between discovery's two rounds"
    // in core/run/review.test.ts pins the case where round 1 had finished.
    test(`a stop during round 1 with ${plan ? "no unused route" : "no plan"} reports that reason, not the stop`, async () => {
      const controller = new AbortController()
      const result = await run({
        candidates: POOL,
        slots: 3,
        plan,
        signal: controller.signal,
        script: stopDuringRoundOne(controller),
      })
      const gitlab = result.roster.slots.find((slot) => slot.providerId === "gitlab")!
      expect(result.discovered.recovery!.notReplaced).toEqual([
        { from: gitlab.slot, reason: plan ? "no-candidate" : "no-plan" },
      ])
      expect(result.discovered.warnings.some((w) => w.code === "model-replaced")).toBe(false)
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
    // The held replacement is a budget signal, counted as a pool turn and named
    // as the budget's, in the truncation warning and the denominator's clause.
    const truncated = result.discovered.warnings.find((w) => w.code === "discovery-truncated")!
    expect(truncated.message).toStartWith(
      "REPLACEMENT HELD BACK: 1 replacement(s) for refused pool slot(s) were never dispatched, because " +
        "dispatching it would have taken the run past",
    )
    expect(truncated.detail).toMatchObject({
      poolSkipped: 0,
      lensSkipped: 0,
      replacementsHeld: [{ from: gitlab.slot, reason: "budget" }],
    })
    const reduced = result.discovered.warnings.find((w) => w.code === "denominator-reduced")!
    expect(reduced.message).toContain("1 replacement(s) for refused pool slot(s) were never dispatched")
    expect(reduced.detail).toMatchObject({ replacementsHeld: 1 })
  })

  test("an admission-skipped lens beside a budget-held replacement: the title and the body name both gates, each for its own slots", async () => {
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
    // The admission refuses only the lens; the two answering pool turns spend
    // discovery's share of the 50-token cap, so the budget holds the replacement.
    const admission = fakeAdmission((request) => request.slot === lens.slot)
    const result = await run({
      candidates: [...POOL, candidate("xai", "grok-4")],
      slots: 3,
      cap: 50,
      lensSlots: [lens],
      admission: admission.admission,
      script: (route) => (route.startsWith("gitlab/") ? GITLAB_REFUSAL : NOTHING_FOUND),
    })
    const gitlab = result.roster.slots.find((slot) => slot.providerId === "gitlab")!
    expect(result.discovered.recovery!.notReplaced).toEqual([{ from: gitlab.slot, reason: "budget" }])
    const truncated = result.discovered.warnings.filter((w) => w.code === "discovery-truncated")
    expect(truncated).toHaveLength(1)
    const message = truncated[0]!.message
    expect(message).toStartWith("BUDGET AND ADMISSION TRUNCATED DISCOVERY: 0 pool slot(s) and 1 lens slot(s) were never asked")
    // The roster clause names the admission; the held-replacement clause names the budget.
    expect(message).toContain("because the experiment's admission refused them (refused by the fake admission)")
    expect(message).toContain(
      "1 replacement(s) for refused pool slot(s) were never dispatched, because dispatching it would have taken the run past",
    )
    expect(truncated[0]!.detail).toMatchObject({
      slots: [lens.slot],
      poolSkipped: 0,
      lensSkipped: 1,
      replacementsHeld: [{ from: gitlab.slot, reason: "budget" }],
    })
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

describe("discovery recovery — pins, lineage and route scope", () => {
  const FIVE = [
    candidate("openai", "gpt-5"),
    candidate("anthropic", "claude-sonnet-4-5"),
    candidate("google", "gemini-2.5-pro"),
    candidate("xai", "grok-4"),
    candidate("mistral", "mistral-large"),
  ]

  test("a refused PINNED slot is not replaced, and says so; a refused ranked slot in the same run is", async () => {
    const result = await run({
      candidates: FIVE,
      slots: 3,
      pins: [{ providerId: "openai", modelId: "gpt-5" }],
      script: (route) => (route === "openai/gpt-5" || route.startsWith("google/") ? PAYMENT_402 : NOTHING_FOUND),
    })
    const pinned = result.roster.slots[0]!
    const ranked = result.roster.slots.find((slot) => slot.providerId === "google")!
    expect(`${pinned.providerId}/${pinned.modelId}`).toBe("openai/gpt-5")
    expect(result.plan.pinned).toEqual([pinned.slot])
    expect(result.discovered.recovery!.notReplaced).toEqual([{ from: pinned.slot, reason: "pinned", detail: "openai/gpt-5" }])
    expect(result.discovered.recovery!.replacements.map((replacement) => replacement.from)).toEqual([ranked.slot])
    expect(result.rowOf(pinned.slot)!.message).toEndWith(
      "It was not replaced: the slot was pinned to `openai/gpt-5`, and MAD does not put a model or provider the pin did not name in its place.",
    )
    expect(result.rowOf(pinned.slot)!.detail).toMatchObject({ recovery: { notReplaced: "pinned" } })
    // One replacement turn, for the ranked slot only.
    expect(result.prompts.filter((route) => route.startsWith("xai/") || route.startsWith("mistral/"))).toHaveLength(1)
  })

  test("a pin the host does not offer protects nothing: the slot ranking backfilled is replaced", async () => {
    const result = await run({
      candidates: FIVE,
      slots: 3,
      pins: [{ providerId: "openai", modelId: "gpt-9" }],
      script: (route) => (route === "openai/gpt-5" ? PAYMENT_402 : NOTHING_FOUND),
    })
    const refused = result.roster.slots.find((slot) => slot.providerId === "openai")!
    expect(result.plan.pinned).toEqual([])
    expect(result.discovered.recovery!.notReplaced).toEqual([])
    expect(result.discovered.recovery!.replacements.map((replacement) => replacement.from)).toEqual([refused.slot])
  })

  test("allocation prefers a lineage the answered pool and earlier allocations lack, over the plan's order", async () => {
    const result = await run({
      candidates: [
        candidate("anthropic", "claude-sonnet-4-5"),
        candidate("openai", "gpt-5"),
        candidate("google", "gemini-2.5-pro"),
        candidate("anthropic", "claude-opus-4-1"),
        candidate("openai", "gpt-5-mini"),
        candidate("google", "gemini-2.5-flash"),
      ],
      slots: 3,
      // Route-scope refusals: the same providers' other models stay eligible.
      script: (route) => (route === "openai/gpt-5" || route === "google/gemini-2.5-pro" ? PAYMENT_402 : NOTHING_FOUND),
    })
    // The plan lists the Claude model first; neither refused slot takes it.
    expect(result.plan.candidates.map((route) => `${route.slot}=${route.modelId}`)).toEqual([
      "discovery-r1=claude-opus-4-1",
      "discovery-r2=gpt-5-mini",
      "discovery-r3=gemini-2.5-flash",
    ])
    expect(
      result.discovered.recovery!.replacements.map((replacement) => `${replacement.from}->${replacement.to.slot}`),
    ).toEqual(["discovery-2->discovery-r2", "discovery-3->discovery-r3"])
    expect(result.discovered.recovery!.answeredLineages).toBe(3)
    expect(result.discovered.warnings.some((w) => w.code === "answered-lineages-reduced")).toBe(false)
  })

  test("a replacement that can only repeat a held lineage is dispatched, and the narrower answered pool is reported", async () => {
    const result = await run({
      candidates: [
        candidate("anthropic", "claude-sonnet-4-5"),
        candidate("openai", "gpt-5"),
        candidate("google", "gemini-2.5-pro"),
        candidate("anthropic", "claude-opus-4-1"),
      ],
      slots: 3,
      script: (route) => (route === "openai/gpt-5" ? PAYMENT_402 : NOTHING_FOUND),
    })
    const { discovered } = result
    expect(discovered.answered).toBe(3)
    expect(discovered.recovery!.replacements).toEqual([
      expect.objectContaining({ from: "discovery-2", to: expect.objectContaining({ modelId: "claude-opus-4-1" }), answered: true }),
    ])
    expect(result.roster.distinctLineages).toBe(3)
    expect(discovered.recovery!.answeredLineages).toBe(2)
    const reduced = discovered.warnings.find((w) => w.code === "answered-lineages-reduced")!
    expect(reduced.stage).toBe("discover")
    expect(reduced.message).toContain(
      "FEWER LINEAGES ANSWERED: the initial selection held 3 distinct verified lineage(s), but the pool that " +
        "answered discovery after recovery holds 2 (Claude (Anthropic), Gemini (Google)).",
    )
    expect(reduced.detail).toEqual({ initialLineages: 3, answeredLineages: 2, lineages: ["claude", "gemini"], replacements: 1 })
  })

  test("a lens slot's ROUTE-scope refusal excludes only that route: another model on its provider replaces", async () => {
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
    const AUTH_401 = { error: { name: "APIError", data: { statusCode: 401, isRetryable: false } }, tokens: ZERO }
    const result = await run({
      candidates: [
        candidate("anthropic", "claude-sonnet-4-5"),
        candidate("openai", "gpt-5"),
        candidate("q", "codestral-latest"),
        candidate("q", "mistral-large"),
      ],
      slots: 2,
      lensSlots: [lens],
      script: (route) => (route === "openai/gpt-5" ? PAYMENT_402 : route === "q/codestral-latest" ? AUTH_401 : NOTHING_FOUND),
    })
    // The lens's refused route is the plan's first candidate.
    expect(`${result.plan.candidates[0]!.providerId}/${result.plan.candidates[0]!.modelId}`).toBe("q/codestral-latest")
    const replacement = result.discovered.recovery!.replacements[0]!
    expect(`${replacement.to.providerId}/${replacement.to.modelId}`).toBe("q/mistral-large")
    // The refused route was prompted once, by the lens, and never as a replacement.
    expect(result.prompts.filter((route) => route === "q/codestral-latest")).toHaveLength(1)
  })

  test("a lens slot's ROUTE-scope refusal excludes that model through a case variant of its provider, not another model there", async () => {
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
    const AUTH_401 = { error: { name: "APIError", data: { statusCode: 401, isRetryable: false } }, tokens: ZERO }
    const result = await run({
      candidates: [
        candidate("anthropic", "claude-sonnet-4-5"),
        candidate("openai", "gpt-5"),
        candidate("Q", "codestral-latest"),
        candidate("Q", "mistral-large"),
      ],
      slots: 2,
      lensSlots: [lens],
      script: (route) => (route === "openai/gpt-5" ? PAYMENT_402 : route === "q/codestral-latest" ? AUTH_401 : NOTHING_FOUND),
    })
    expect(`${result.plan.candidates[0]!.providerId}/${result.plan.candidates[0]!.modelId}`).toBe("Q/codestral-latest")
    const replacement = result.discovered.recovery!.replacements[0]!
    expect(`${replacement.to.providerId}/${replacement.to.modelId}`).toBe("Q/mistral-large")
    expect(result.prompts.filter((route) => route === "Q/codestral-latest")).toEqual([])
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
    const colliding = { candidates: [{ ...selected.recovery.candidates[0]!, slot: selected.roster.slots[0]!.slot }], pinned: [] }
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

describe("discovery recovery — a replacement whose session the stop ended before any prompt", () => {
  // The real backend under the review-session policy: the stop lands while the
  // replacement's session is being created, so the backend disposes it
  // unprompted and returns the pre-issue cancellation.
  async function stopDuringReplacementCreate() {
    const selected = selectRoster(
      [
        candidate("gitlab", "duo-chat-gpt-5-6-terra"),
        candidate("anthropic", "claude-sonnet-4-5"),
        candidate("openrouter", "amazon/nova-pro-v1"),
        candidate("xai", "grok-4"),
      ],
      { slots: 3, providerConfigKey: "provider", requireToolcall: true },
    )
    const controller = new AbortController()
    let creates = 0
    const prompts: string[] = []
    const deleted: string[] = []
    const client = {
      session: {
        create: async (request: { permission?: unknown }) => {
          creates += 1
          // Round 1 creates three sessions; the fourth is the replacement's.
          if (creates === 4) controller.abort()
          return { data: { id: `ses_${creates}`, permission: request.permission } }
        },
        prompt: async (request: { model: { providerID: string; modelID: string } }) => {
          prompts.push(`${request.model.providerID}/${request.model.modelID}`)
          return { data: { info: request.model.providerID === "gitlab" ? GITLAB_REFUSAL : NOTHING_FOUND } }
        },
        delete: async (request: { sessionID?: string; path?: { id?: string } }) => {
          deleted.push(String(request.sessionID ?? request.path?.id))
          return { data: true }
        },
      },
    }
    const backend = new OpencodeModelBackend({
      directory: "/repo",
      slots: [...selected.roster.slots, ...selected.recovery.candidates],
      client: client as never,
      cleanupTimeoutMs: 10,
      sessionPermission: REVIEW_SESSION_PERMISSION,
    })
    const admission = fakeAdmission()
    const discovered = await discover({
      roster: selected.roster,
      recovery: selected.recovery,
      backend,
      instructions: DISCOVERY_INSTRUCTIONS,
      input: "diff",
      clock: fakeClock(),
      ledger: emptyLedger(null),
      signal: controller.signal,
      admission: admission.admission,
    })
    validateReplacements({ roster: selected.roster, recovery: discovered.recovery })
    return { selected, discovered, prompts, creates: () => creates, deleted, admission }
  }

  test("is not recorded as dispatched: the slot is not replaced, because the run was stopped", async () => {
    const { selected, discovered, prompts, creates, deleted } = await stopDuringReplacementCreate()
    const gitlab = selected.roster.slots.find((slot) => slot.providerId === "gitlab")!
    expect(creates()).toBe(4)
    expect(prompts.some((route) => route.startsWith("xai/"))).toBe(false)
    expect(deleted).toContain("ses_4")
    expect(discovered.recovery!.replacements).toEqual([])
    expect(discovered.recovery!.notReplaced).toEqual([{ from: gitlab.slot, reason: "cancelled" }])
    expect(discovered.cancelled).toBe(true)
    expect(discovered.warnings.some((w) => w.code === "model-replaced")).toBe(false)
  })

  test("its admission settles as not issued, and the refused original's attempt keeps its own settlement", async () => {
    const { selected, admission } = await stopDuringReplacementCreate()
    const gitlab = selected.roster.slots.find((slot) => slot.providerId === "gitlab")!
    const replacementSettlements = admission.settlements.filter((entry) => entry.request.slot === "discovery-r1")
    expect(replacementSettlements.map((entry) => entry.settlement)).toEqual([{ kind: "not-issued" }])
    const refusedSettlements = admission.settlements.filter((entry) => entry.request.slot === gitlab.slot)
    expect(refusedSettlements.map((entry) => entry.settlement.kind)).toEqual(["unknown"])
  })
})

describe("discovery — a retry the backend ended before its prompt", () => {
  const TURN_TOKENS = { input: 7, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  test("keeps the issued first attempt: the slot was asked once and is reported as stopped in flight, not never asked", async () => {
    const selected = selectRoster(
      [candidate("anthropic", "claude-sonnet-4-5"), candidate("openai", "gpt-5"), candidate("google", "gemini-2.5-pro")],
      { slots: 3, providerConfigKey: "provider" },
    )
    const [first] = selected.roster.slots
    const controller = new AbortController()
    const calls: { slot: string; attempt: number }[] = []
    const backend: import("../../core/ports/model-backend.ts").ModelBackend = {
      capabilities: () => ({ tools: false }),
      async runTurn(slot) {
        const attempt = calls.filter((call) => call.slot === slot).length + 1
        calls.push({ slot, attempt })
        if (slot === first!.slot) {
          if (attempt === 1) return { ok: false, slot, failure: "model-error", message: "upstream hiccup", tokens: TURN_TOKENS }
          controller.abort()
          return cancelledTurn(slot)
        }
        return { ok: true, slot, value: { findings: [] } as never, tokens: TURN_TOKENS }
      },
    }
    const discovered = await discover({
      roster: selected.roster,
      recovery: selected.recovery,
      backend,
      instructions: DISCOVERY_INSTRUCTIONS,
      input: "diff",
      clock: fakeClock(),
      ledger: emptyLedger(null),
      signal: controller.signal,
    })
    expect(calls.filter((call) => call.slot === first!.slot)).toHaveLength(2)
    expect(discovered.cancelled).toBe(true)
    const reduced = discovered.warnings.find((w) => w.code === "denominator-reduced")!
    expect(reduced.message).toContain("1 did not answer because the run was cancelled")
    expect(reduced.message).not.toContain("never asked")
  })
})
