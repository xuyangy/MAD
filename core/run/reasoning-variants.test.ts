/**
 * Plan item B6a — opt-in reasoning variants per stage: each stage's turns ask
 * for its own variant, the record says what was requested, and nothing changes
 * when no variant is configured.
 */

import { describe, expect, test } from "bun:test"
import type { ZodType } from "zod"

import type { ModelBackend, TurnOptions } from "../ports/model-backend.ts"
import { selectRoster } from "../roster/select.ts"
import { runJson } from "../stages/output-json.ts"
import { candidate, fakeChange, fakeClock, FakeBackend, judgeRoleOf, type SlotScript, type SlotStep } from "../test-support/fakes.ts"
import { continueReview, forkPreparedReview, prepareReview, review, type ReviewDeps } from "./review.ts"

const FEE = {
  claim: "Fee is computed before the rate is validated.",
  reasoning: "If `rate` is NaN the total silently becomes NaN.",
  severity: "high",
  file: "src/pay.ts",
  startLine: 12,
  endLine: 14,
}
const RETRY = {
  claim: "The retry loop has no ceiling and can spin forever.",
  reasoning: "A transient failure becomes an infinite loop.",
  severity: "low",
  file: "src/retry.ts",
  startLine: 30,
}
const ABSTAIN: SlotStep = { kind: "ok", value: { turns: [] } }

type Stage = "discover" | "debate" | "judge"

/** Records each turn's stage (from its prompt and instructions) and options. */
class Recording implements ModelBackend {
  readonly seen: { stage: Stage; options: TurnOptions | undefined }[] = []
  constructor(readonly inner: FakeBackend) {}
  capabilities(slot: string) {
    return this.inner.capabilities(slot)
  }
  runTurn<T>(...args: Parameters<ModelBackend["runTurn"]>) {
    const [, instructions, prompt, , , , options] = args
    const stage: Stage = judgeRoleOf(instructions) !== undefined ? "judge" : prompt.startsWith("# Debate round") ? "debate" : "discover"
    this.seen.push({ stage, options })
    return this.inner.runTurn(
      ...(args as [string, string, string, ZodType<T>, AbortSignal | undefined, undefined, TurnOptions | undefined]),
    )
  }
}

/** Three slots: FEE (3/3) goes to the judge, RETRY (1/3) is debated and judged. */
function deps(extra: Partial<ReviewDeps> = {}, firstDiscovery?: SlotStep[]): { deps: ReviewDeps; backend: Recording } {
  const resolved = selectRoster(
    [candidate("anthropic", "claude-sonnet-4-5"), candidate("openai", "gpt-5"), candidate("google", "gemini-2.5-pro")],
    { slots: 3, lenses: [], providerConfigKey: "provider" },
  )
  const scripts: Record<string, SlotScript> = {
    "discovery-1": [...(firstDiscovery ?? []), { kind: "ok", value: { findings: [FEE, RETRY] } }, ABSTAIN, ABSTAIN, ABSTAIN],
    "discovery-2": [{ kind: "ok", value: { findings: [FEE] } }, ABSTAIN, ABSTAIN, ABSTAIN],
    "discovery-3": [{ kind: "ok", value: { findings: [FEE] } }, ABSTAIN, ABSTAIN, ABSTAIN],
  }
  const backend = new Recording(new FakeBackend(scripts))
  return {
    backend,
    deps: { roster: resolved.roster, backend, clock: fakeClock(), change: fakeChange(), priorWarnings: resolved.warnings, ...extra },
  }
}

const stagesOf = (seen: Recording["seen"]) => new Set(seen.map((s) => s.stage))

describe("B6a — reasoning variants per stage", () => {
  test("absent: no turn is handed options, and the record, report and JSON say nothing", async () => {
    const { deps: d, backend } = deps()
    const { record, rendered } = await review(d)
    expect(stagesOf(backend.seen)).toEqual(new Set(["discover", "debate", "judge"]))
    expect(backend.seen.every((s) => s.options === undefined)).toBe(true)
    expect("reasoningVariants" in record).toBe(false)
    expect(rendered).not.toContain("REASONING VARIANTS")
    expect("reasoningVariantsConfigured" in runJson(record)).toBe(false)
  })

  test("each stage's turns ask for that stage's variant and no other", async () => {
    const { deps: d, backend } = deps({ reasoningVariants: { discover: "low", debate: "medium", judge: "high" } })
    const { record, rendered } = await review(d)
    const expected: Record<Stage, string> = { discover: "low", debate: "medium", judge: "high" }
    expect(stagesOf(backend.seen)).toEqual(new Set(["discover", "debate", "judge"]))
    for (const turn of backend.seen) expect(turn.options).toEqual({ variant: expected[turn.stage] })
    expect(record.reasoningVariants).toEqual({ discover: "low", debate: "medium", judge: "high" })
    expect(rendered).toContain("REASONING VARIANTS CONFIGURED — discover low, debate medium, judge high.")
    expect(rendered).toContain("whether a provider applied it is not established")
    expect(runJson(record).reasoningVariantsConfigured).toEqual({ discover: "low", debate: "medium", judge: "high" })
  })

  test("only the configured stage sends one, and a retry asks for the same variant", async () => {
    const fail: SlotStep = { kind: "fail", failure: "model-error", message: "once" }
    const { deps: d, backend } = deps({ reasoningVariants: { discover: "low" } }, [fail])
    const { record } = await review(d)
    const discovery = backend.seen.filter((s) => s.stage === "discover")
    // discovery-1 failed once and was retried: four discovery turns, all asking for "low".
    expect(discovery).toHaveLength(4)
    expect(discovery.every((s) => s.options?.variant === "low")).toBe(true)
    expect(backend.seen.filter((s) => s.stage !== "discover").every((s) => s.options === undefined)).toBe(true)
    expect(record.reasoningVariants).toEqual({ discover: "low" })
  })

  test("a stage that issued no turn still records what was requested", async () => {
    const resolved = selectRoster([candidate("anthropic", "claude-sonnet-4-5")], { slots: 1, lenses: [], providerConfigKey: "provider" })
    const backend = new FakeBackend({ "discovery-1": [{ kind: "ok", value: { findings: [] } }] })
    const { record, rendered } = await review({
      roster: resolved.roster,
      backend,
      clock: fakeClock(),
      change: fakeChange(),
      priorWarnings: resolved.warnings,
      reasoningVariants: { judge: "high" },
    })
    expect(backend.calls.some((c) => c.role !== undefined)).toBe(false)
    expect(record.reasoningVariants).toEqual({ judge: "high" })
    expect(rendered).toContain("REASONING VARIANTS CONFIGURED — judge high.")
    expect(rendered).toContain("and on none for a stage that issued no turn")
    expect(rendered).not.toContain("asked the host")
  })

  test("an invalid name is refused before any request", async () => {
    for (const bad of ["", "a b", "x".repeat(65), "line\nbreak"]) {
      const { deps: d, backend } = deps({ reasoningVariants: { judge: bad } })
      await expect(review(d)).rejects.toThrow(/reasoning variant for judge/)
      expect(backend.inner.calls).toEqual([])
    }
  })
})

describe("B6a — the caller's object is read once", () => {
  test("changing the options during discovery changes neither what later stages send nor the record", async () => {
    const options: { discover?: string; debate?: string; judge?: string } = { discover: "low", judge: "high" }
    const { deps: d, backend } = deps({ reasoningVariants: options })
    const original = backend.inner.runTurn.bind(backend.inner)
    let mutated = false
    backend.inner.runTurn = ((...args: Parameters<FakeBackend["runTurn"]>) => {
      if (!mutated) {
        mutated = true
        options.discover = "max"
        options.judge = "bad value"
        options.debate = "max"
      }
      return original(...args)
    }) as FakeBackend["runTurn"]
    const { record } = await review(d)
    expect(mutated).toBe(true)
    expect(backend.seen.filter((s) => s.stage === "judge").every((s) => s.options?.variant === "high")).toBe(true)
    expect(backend.seen.filter((s) => s.stage === "debate").every((s) => s.options === undefined)).toBe(true)
    expect(backend.seen.filter((s) => s.stage === "discover").every((s) => s.options?.variant === "low")).toBe(true)
    expect(record.reasoningVariants).toEqual({ discover: "low", judge: "high" })
  })

  test("absent at entry stays absent: a property added during discovery is not seen", async () => {
    const { deps: d, backend } = deps()
    const original = backend.inner.runTurn.bind(backend.inner)
    backend.inner.runTurn = ((...args: Parameters<FakeBackend["runTurn"]>) => {
      d.reasoningVariants = { discover: "max", judge: "high" }
      return original(...args)
    }) as FakeBackend["runTurn"]
    const { record } = await review(d)
    expect(d.reasoningVariants).toEqual({ discover: "max", judge: "high" })
    expect(backend.seen.length).toBeGreaterThan(0)
    expect(backend.seen.every((s) => s.options === undefined)).toBe(true)
    expect("reasoningVariants" in record).toBe(false)
  })

  test("an empty configuration is no configuration", async () => {
    const { deps: d, backend } = deps({ reasoningVariants: {} })
    const { record, rendered } = await review(d)
    expect(backend.seen.every((s) => s.options === undefined)).toBe(true)
    expect("reasoningVariants" in record).toBe(false)
    expect(rendered).not.toContain("REASONING VARIANTS")
  })

  test("a standalone continuation reads its own options once too", async () => {
    const { deps: d, backend } = deps()
    const prepared = await prepareReview(d)
    const options: { judge?: string } = { judge: "high" }
    const original = backend.inner.runTurn.bind(backend.inner)
    backend.inner.runTurn = ((...args: Parameters<FakeBackend["runTurn"]>) => {
      options.judge = "changed"
      return original(...args)
    }) as FakeBackend["runTurn"]
    const { record } = await continueReview(prepared, { backend, clock: fakeClock(), reasoningVariants: options })
    expect(backend.seen.filter((s) => s.stage === "judge").every((s) => s.options?.variant === "high")).toBe(true)
    expect(record.reasoningVariants).toEqual({ judge: "high" })
  })
})

describe("B6a — prepare, fork and continue", () => {
  test("discovery's variant is fixed at prepare, survives a fork, and continuations add their own", async () => {
    const { deps: d, backend } = deps({ reasoningVariants: { discover: "low" } })
    const prepared = await prepareReview(d)
    const [onBranch, offBranch] = forkPreparedReview(prepared, d.clock, 2)
    expect(onBranch!.record.reasoningVariants).toEqual({ discover: "low" })

    const on = await continueReview(onBranch!, { backend, clock: fakeClock(), reasoningVariants: { judge: "high" } })
    expect(on.record.reasoningVariants).toEqual({ discover: "low", judge: "high" })
    const off = await continueReview(offBranch!, { backend, clock: fakeClock() })
    expect(off.record.reasoningVariants).toEqual({ discover: "low" })
  })

  test("a continuation that names a different discovery variant is refused, and the prepared review stays unused", async () => {
    const { deps: d, backend } = deps({ reasoningVariants: { discover: "low" } })
    const prepared = await prepareReview(d)
    await expect(
      continueReview(prepared, { backend, clock: fakeClock(), reasoningVariants: { discover: "high", judge: "high" } }),
    ).rejects.toThrow(/cannot change it/)
    const resumed = await continueReview(prepared, { backend, clock: fakeClock(), reasoningVariants: { discover: "low" } })
    expect(resumed.record.reasoningVariants).toEqual({ discover: "low" })
  })

  test("an invalid continuation name is refused before routing", async () => {
    const { deps: d, backend } = deps()
    const prepared = await prepareReview(d)
    const before = backend.inner.calls.length
    await expect(continueReview(prepared, { backend, clock: fakeClock(), reasoningVariants: { debate: "a b" } })).rejects.toThrow(
      /reasoning variant for debate/,
    )
    expect(backend.inner.calls.length).toBe(before)
    expect(prepared.record.routeCounts).toBeUndefined()
  })
})
