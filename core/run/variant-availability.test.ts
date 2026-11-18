/**
 * Plan item B6b — which configured reasoning variants the host advertised for
 * the routes that issued requests: the pure function, and the record, report
 * and JSON through review().
 */

import { describe, expect, test } from "bun:test"

import type { Candidate } from "../domain/roster.ts"
import { emptyLedger, recordTurn, recordUnknownTurn } from "../domain/run-record.ts"
import type { RunRecovery } from "../domain/recovery.ts"
import { selectRoster } from "../roster/select.ts"
import { runJson } from "../stages/output-json.ts"
import { candidate, fakeChange, fakeClock, FakeBackend, tokens, type SlotScript, type SlotStep } from "../test-support/fakes.ts"
import { continueReview, prepareReview, review } from "./review.ts"
import { variantAvailability } from "./variant-availability.ts"

const withVariants = (providerId: string, modelId: string, variants?: string[]): Candidate => ({
  ...candidate(providerId, modelId),
  ...(variants === undefined ? {} : { variants }),
})

describe("B6b — variantAvailability", () => {
  const selected = selectRoster(
    [
      candidate("gitlab", "duo-chat-gpt-5-6-terra"),
      candidate("anthropic", "claude-sonnet-4-5"),
      candidate("openrouter", "amazon/nova-pro-v1"),
      candidate("google", "gemini-2.5-pro"),
      candidate("xai", "grok-4"),
    ],
    { slots: 3, lenses: ["security"], providerConfigKey: "provider", requireToolcall: true },
  )
  const roster = selected.roster
  const gitlab = roster.slots.find((slot) => slot.providerId === "gitlab")!
  const route = selected.recovery.candidates.find((r) => r.providerId === "xai")!
  const recovery: RunRecovery = {
    refused: [{ slot: gitlab.slot, refusal: { kind: "payment", basis: "host-signature", scope: "provider", providerId: "gitlab", modelId: gitlab.modelId } }],
    replacements: [{ from: gitlab.slot, to: route, dispatched: 1, answered: true }],
    notReplaced: [],
    answeredLineages: 3,
  }

  function ledgerWith(rows: { stage: string; slot: string; unknown?: boolean }[]) {
    const ledger = emptyLedger()
    rows.forEach((row, i) => {
      if (row.unknown) recordUnknownTurn(ledger, { slot: row.slot, stage: row.stage, attempt: 1, executionId: `x-${i}`, why: "no usage" })
      else recordTurn(ledger, { slot: row.slot, stage: row.stage as never, attempt: 1, tokens: tokens() })
    })
    return ledger
  }

  test("each status, a replacement route, a lens slot, unknown-usage rows, and no row for a stage without a request", () => {
    // Two pool slots selection chose, whatever their providers.
    const [anthropic, google] = roster.slots.filter((slot) => slot.providerId !== "gitlab") as [typeof gitlab, typeof gitlab]
    const lens = roster.lensSlots[0]!
    const record = {
      roster,
      recovery,
      reasoningVariants: { discover: "high", debate: "high", judge: "max" },
      ledger: ledgerWith([
        { stage: "discover", slot: anthropic.slot },
        { stage: "discover", slot: anthropic.slot },
        { stage: "discover", slot: google.slot, unknown: true },
        { stage: "discover", slot: lens.slot },
        { stage: "discover", slot: route.slot },
        { stage: "judge", slot: route.slot },
      ]),
    }
    const candidates: Candidate[] = [
      withVariants(anthropic.providerId, anthropic.modelId, ["high", "max"]),
      withVariants(google.providerId, google.modelId, []),
      withVariants(route.providerId, route.modelId, ["low"]),
      // The lens slot's route has no candidate entry with a list.
      withVariants(lens.providerId, lens.modelId),
    ]
    const rows = variantAvailability(record, candidates)!
    const by = (stage: string, slot: string) => rows.find((r) => r.stage === stage && r.slot === slot)?.status

    expect(by("discover", anthropic.slot)).toBe("advertised")
    expect(by("discover", google.slot)).toBe("not-advertised")
    expect(by("discover", route.slot)).toBe("not-advertised")
    expect(by("judge", route.slot)).toBe("not-advertised")
    expect(rows.filter((r) => r.stage === "discover" && r.slot === anthropic.slot)).toHaveLength(1)
    // The lens slot shares the anthropic route here only if selection made it so;
    // whatever its route, its row exists.
    expect(by("discover", lens.slot)).toBeDefined()
    expect(rows.some((r) => r.stage === "debate")).toBe(false)
    expect(rows.find((r) => r.slot === route.slot)).toMatchObject({ providerId: "xai", modelId: route.modelId, variant: "high" })
    expect(variantAvailability({ ...record, reasoningVariants: undefined }, candidates)).toEqual([])
  })

  test("a ledger without its unknown-usage collection gives no answer instead of a partial one", () => {
    const only = roster.slots[1]!
    const ledger = ledgerWith([{ stage: "discover", slot: only.slot }]) as unknown as Record<string, unknown>
    delete ledger["unknownUsage"]
    expect(() => variantAvailability({ roster, ledger: ledger as never, reasoningVariants: { discover: "high" } }, [])).not.toThrow()
    expect(variantAvailability({ roster, ledger: ledger as never, reasoningVariants: { discover: "high" } }, [])).toBeUndefined()
  })

  test("a route with no candidate at all is unknown", () => {
    const only = roster.slots[1]!
    const rows = variantAvailability(
      { roster, ledger: ledgerWith([{ stage: "discover", slot: only.slot }]), reasoningVariants: { discover: "high" } },
      [],
    )
    expect(rows).toEqual([
      { stage: "discover", slot: only.slot, providerId: only.providerId, modelId: only.modelId, variant: "high", status: "unknown" },
    ])
  })
})

describe("B6b — through review()", () => {
  const ABSTAIN: SlotStep = { kind: "ok", value: { turns: [] } }
  const FEE = { claim: "Fee is computed before the rate is validated.", reasoning: "r", severity: "high", file: "src/pay.ts", startLine: 12, endLine: 14 }
  const CANDIDATES: Candidate[] = [
    withVariants("anthropic", "claude-sonnet-4-5", ["high"]),
    withVariants("openai", "gpt-5", []),
    withVariants("google", "gemini-2.5-pro"),
  ]

  async function run(extra: Record<string, unknown>) {
    const resolved = selectRoster(CANDIDATES, { slots: 3, lenses: [], providerConfigKey: "provider" })
    const scripts: Record<string, SlotScript> = {
      "discovery-1": [{ kind: "ok", value: { findings: [FEE] } }, ABSTAIN],
      "discovery-2": [{ kind: "ok", value: { findings: [FEE] } }, ABSTAIN],
      "discovery-3": [{ kind: "ok", value: { findings: [FEE] } }, ABSTAIN],
    }
    return review({
      roster: resolved.roster,
      backend: new FakeBackend(scripts),
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
      ...extra,
    })
  }

  test("configured with candidates: the record, the report and the JSON carry each route's advertisement", async () => {
    const { record, rendered } = await run({ reasoningVariants: { discover: "high" }, variantCandidates: CANDIDATES })
    const statuses = Object.fromEntries((record.variantAvailability ?? []).map((r) => [r.providerId, r.status]))
    expect(statuses).toEqual({ anthropic: "advertised", openai: "not-advertised", google: "unknown" })
    expect(rendered).toContain("as advertised in the host's model list (advertisement only, not evidence a provider applied it):")
    expect(rendered).toMatch(/discover discovery-\d openai\/gpt-5 high: NOT advertised/)
    expect(rendered).toMatch(/discover discovery-\d google\/gemini-2\.5-pro high: unknown — the host gave no variant list for this route/)
    expect(runJson(record).variantAvailability).toEqual(record.variantAvailability)
  })

  test("the candidates are read when the review starts: a list changed during the run does not change the record", async () => {
    const candidates: Candidate[] = CANDIDATES.map((c) => ({ ...c, ...(c.variants === undefined ? {} : { variants: [...c.variants] }) }))
    const resolved = selectRoster(candidates, { slots: 3, lenses: [], providerConfigKey: "provider" })
    const inner = new FakeBackend({
      "discovery-1": [{ kind: "ok", value: { findings: [FEE] } }, ABSTAIN],
      "discovery-2": [{ kind: "ok", value: { findings: [FEE] } }, ABSTAIN],
      "discovery-3": [{ kind: "ok", value: { findings: [FEE] } }, ABSTAIN],
    })
    const original = inner.runTurn.bind(inner)
    inner.runTurn = ((...args: Parameters<FakeBackend["runTurn"]>) => {
      // The caller "refreshes" its list mid-run: openai now advertises high, anthropic nothing.
      ;(candidates[1]!.variants as string[]).push("high")
      candidates[0]!.variants = []
      return original(...args)
    }) as FakeBackend["runTurn"]
    const { record } = await review({
      roster: resolved.roster,
      backend: inner,
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
      reasoningVariants: { discover: "high" },
      variantCandidates: candidates,
    })
    const statuses = Object.fromEntries((record.variantAvailability ?? []).map((r) => [r.providerId, r.status]))
    expect(statuses).toEqual({ anthropic: "advertised", openai: "not-advertised", google: "unknown" })
  })

  test("a standalone continuation reads its candidates before its first await", async () => {
    const candidates: Candidate[] = CANDIDATES.map((c) => ({ ...c, ...(c.variants === undefined ? {} : { variants: [...c.variants] }) }))
    const resolved = selectRoster(candidates, { slots: 3, lenses: [], providerConfigKey: "provider" })
    const inner = new FakeBackend({
      "discovery-1": [{ kind: "ok", value: { findings: [FEE] } }, ABSTAIN],
      "discovery-2": [{ kind: "ok", value: { findings: [FEE] } }, ABSTAIN],
      "discovery-3": [{ kind: "ok", value: { findings: [FEE] } }, ABSTAIN],
    })
    const prepared = await prepareReview({
      roster: resolved.roster,
      backend: inner,
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
      reasoningVariants: { discover: "high" },
    })
    const original = inner.runTurn.bind(inner)
    inner.runTurn = ((...args: Parameters<FakeBackend["runTurn"]>) => {
      candidates[0]!.variants = []
      return original(...args)
    }) as FakeBackend["runTurn"]
    const { record } = await continueReview(prepared, { backend: inner, clock: fakeClock(), variantCandidates: candidates })
    expect(record.variantAvailability?.find((r) => r.providerId === "anthropic")?.status).toBe("advertised")
  })

  test("off: no variant, or a variant without candidates, adds no field, no lines and no JSON key", async () => {
    const plain = await run({})
    expect("variantAvailability" in plain.record).toBe(false)
    expect(plain.rendered).not.toContain("as advertised in the host's model list")
    expect("variantAvailability" in runJson(plain.record)).toBe(false)
    const withoutCandidates = await run({ reasoningVariants: { discover: "high" } })
    expect("variantAvailability" in withoutCandidates.record).toBe(false)
    const candidatesOnly = await run({ variantCandidates: CANDIDATES })
    expect(candidatesOnly.rendered).toBe(plain.rendered)
    expect(candidatesOnly.record).toEqual(plain.record)
  })
})
