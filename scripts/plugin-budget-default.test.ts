import { describe, expect, test } from "bun:test"

import { DEFAULT_PLUGIN_BUDGET } from "../adapters/opencode/plugin-budget.ts"
import { CUMULATIVE_SHARE, PRESETS } from "../core/budget/ledger.ts"
import { derive } from "./plugin-budget-default.ts"

describe("plugin default budget (CAP-6, D6)", () => {
  const { runs, sizing } = derive()

  test("reads the six recorded arms", () => {
    expect(runs.map((r) => r.arm)).toEqual(["off/0", "off/1", "off/2", "on/0", "on/1", "on/2"])
  })

  test("an arm whose judge left findings unresolved is kept as a partial run and not used for judge calibration", () => {
    expect(runs.filter((r) => r.judgeUnresolved > 0).map((r) => r.arm)).toEqual(["on/1"])
    // A partial arm with an outsized judge spend does not move the calibration.
    const inflated = runs.map((r) => (r.judgeUnresolved > 0 ? { ...r, judge: r.judge * 10 } : r))
    expect(derive(inflated).units.judgeAfterDebate).toBe(derive().units.judgeAfterDebate)
  })

  test("the shipped table is the derivation's result, preset by preset", () => {
    expect(Object.fromEntries(sizing.map((s) => [s.preset, s.budget]))).toEqual({ ...DEFAULT_PLUGIN_BUDGET })
  })

  test("every preset's default is finite and positive", () => {
    for (const preset of PRESETS) {
      expect(Number.isFinite(DEFAULT_PLUGIN_BUDGET[preset])).toBe(true)
      expect(DEFAULT_PLUGIN_BUDGET[preset]).toBeGreaterThan(0)
    }
  })

  test("the normal default admits every recorded run at every stage's cumulative share", () => {
    // The recorded runs named no preset, which is `normal`'s dials; they also
    // ran two lens slots that `normal` does not, so this is a conservative check.
    // A partial arm's total is a floor of what finishing it would have cost.
    const cap = DEFAULT_PLUGIN_BUDGET.normal
    for (const r of runs) {
      expect(r.discover).toBeLessThan(cap * CUMULATIVE_SHARE.discover)
      expect(r.discover + r.debate).toBeLessThan(cap * CUMULATIVE_SHARE.debate)
      expect(r.discover + r.debate + r.judge).toBeLessThan(cap * CUMULATIVE_SHARE.judge)
    }
  })
})
