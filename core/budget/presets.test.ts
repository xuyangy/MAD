import { describe, expect, test } from "bun:test"

import { CODING_LENSES } from "../instructions/coding/lenses.ts"
import { DEFAULT_MAX_CONCURRENCY } from "./limiter.ts"
import {
  clampPreset,
  clampSpendShares,
  CUMULATIVE_SHARE,
  DEFAULT_PRESET,
  PRESET_DIALS,
  PRESETS,
  SUGGESTED_BUDGET,
} from "./presets.ts"
import { DEFAULT_CO_DISCOVERY_THRESHOLD } from "../stages/route.ts"

describe("`normal` is the IDENTITY preset (AD-3)", () => {
  // THE COUPLING LIVES HERE AND NOT IN AN IMPORT. `presets.ts` must import
  // nothing (it is the only thing between `domain/` and `budget/` and a cycle),
  // so its table restates `0.8` and `4` as literals. A duplicated constant is
  // the failure this codebase has recorded against itself three times, so it is
  // paid for the one way that works without the import: these tests fail the day
  // either default moves and the table does not follow it.
  test("its threshold IS `DEFAULT_CO_DISCOVERY_THRESHOLD`", () => {
    expect(PRESET_DIALS.normal.threshold).toBe(DEFAULT_CO_DISCOVERY_THRESHOLD)
  })

  test("its concurrency IS `DEFAULT_MAX_CONCURRENCY`", () => {
    expect(PRESET_DIALS.normal.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY)
  })

  test("it runs NO lenses, so a fresh install costs what it costs today", () => {
    expect(PRESET_DIALS.normal.lenses).toEqual([])
  })

  test("the default preset IS `normal`, so passing nothing and passing it agree", () => {
    expect(DEFAULT_PRESET).toBe("normal")
  })
})

describe("lenses — off by default, a SUBSET in paranoid (AD-15 amended 2026-08-14)", () => {
  test("`quick` runs none", () => {
    expect(PRESET_DIALS.quick.lenses).toEqual([])
  })

  test("`paranoid` runs THREE, not the whole pack", () => {
    // Lens count is the only lever that INCREASES cost (`cost-model.md`), and the
    // fan-out is ADDITIVE: three pool slots plus three lens slots is SIX
    // discovery turns. Enabling all eight would be eleven.
    expect(PRESET_DIALS.paranoid.lenses).toEqual(["security", "reliability", "outsider"])
    expect(PRESET_DIALS.paranoid.lenses.length).toBeLessThan(CODING_LENSES.length)
  })

  test("every lens a preset names is REGISTERED, so none is silently generated", () => {
    // A typo here would not fail: `registry.ts` generates an instruction set at
    // run time for an unrecognised id. The run would buy three full-price
    // discovery turns against instructions nobody wrote and label them
    // `generated` in the report — a degradation a preset must never cause.
    const shipped = new Set(CODING_LENSES.map((lens) => lens.id))
    for (const preset of PRESETS) {
      for (const lens of PRESET_DIALS[preset].lenses) {
        expect(shipped).toContain(lens)
      }
    }
  })
})

describe("what a preset may NOT move", () => {
  test("no preset carries `maxRounds` or a slot count", () => {
    // `cost-model.md`: the dial is which lenses, not how many rounds. And AD-3:
    // the roster comes from the host's configured models, not from a word.
    for (const preset of PRESETS) {
      const dials = PRESET_DIALS[preset] as unknown as Record<string, unknown>
      expect(Object.keys(dials).sort()).toEqual(["lenses", "maxConcurrency", "threshold"])
    }
  })

  test("the threshold each preset moves is a real routing value in [0, 1]", () => {
    for (const preset of PRESETS) {
      expect(PRESET_DIALS[preset].threshold).toBeGreaterThanOrEqual(0)
      expect(PRESET_DIALS[preset].threshold).toBeLessThanOrEqual(1)
    }
  })

  test("quick routes LOOSER and paranoid TIGHTER than normal — the ordering IS the feature", () => {
    expect(PRESET_DIALS.quick.threshold).toBeLessThan(PRESET_DIALS.normal.threshold)
    expect(PRESET_DIALS.paranoid.threshold).toBeGreaterThan(PRESET_DIALS.normal.threshold)
  })
})

describe("clampPreset — the word is bounded too", () => {
  test("each of the three passes through unchanged", () => {
    for (const preset of PRESETS) expect(clampPreset(preset)).toBe(preset)
  })

  test("anything unrecognised is `normal`, never a throw", () => {
    // The value arrives from a model through the adapter, and AD-15's rule
    // generalises: a request MAD cannot honour is an outcome, not an error.
    // `normal` is the identity, so an unusable request runs the shipped run.
    expect(clampPreset(undefined)).toBe("normal")
    expect(clampPreset(null)).toBe("normal")
    expect(clampPreset("")).toBe("normal")
    expect(clampPreset("PARANOID")).toBe("normal")
    expect(clampPreset("thorough")).toBe("normal")
    expect(clampPreset(7 as unknown as string)).toBe("normal")
  })
})

describe("the suggested budgets", () => {
  test("they rise with depth, because depth is what costs", () => {
    expect(SUGGESTED_BUDGET.quick).toBe(250_000)
    expect(SUGGESTED_BUDGET.normal).toBe(400_000)
    expect(SUGGESTED_BUDGET.paranoid).toBe(550_000)
    expect(SUGGESTED_BUDGET.quick).toBeLessThan(SUGGESTED_BUDGET.normal)
    expect(SUGGESTED_BUDGET.normal).toBeLessThan(SUGGESTED_BUDGET.paranoid)
  })

  test("each preset's discovery share covers its OWN worst-case discovery", () => {
    // The arithmetic the sizing rests on, executable rather than in prose: a
    // discovery turn is ~10k, the fan-out is ADDITIVE (`slots + lenses`), and
    // every slot retrying doubles it. If a preset's discovery ceiling cannot
    // cover its own retry-heavy fan-out, that preset truncates its own roster at
    // its own suggested budget — the one failure the shares exist to prevent.
    const TURN = 10_000
    const POOL_SLOTS = 3
    for (const preset of PRESETS) {
      const turns = POOL_SLOTS + PRESET_DIALS[preset].lenses.length
      const worstCase = turns * 2 * TURN
      const ceiling = Math.floor(SUGGESTED_BUDGET[preset] * CUMULATIVE_SHARE.discover)
      expect(ceiling).toBeGreaterThanOrEqual(worstCase)
    }
  })
})

describe("CUMULATIVE_SHARE — cumulative, and the judge's is 1", () => {
  test("the shares RISE, so a stage's ceiling is never below the one before it", () => {
    expect(CUMULATIVE_SHARE.discover).toBeLessThan(CUMULATIVE_SHARE.debate)
    expect(CUMULATIVE_SHARE.debate).toBeLessThan(CUMULATIVE_SHARE.judge)
  })

  test("the judge's share IS 1 — no part of a stated cap may be unreachable", () => {
    expect(CUMULATIVE_SHARE.judge).toBe(1)
  })
})

describe("clampSpendShares", () => {
  test("absent is the default table", () => {
    expect(clampSpendShares(undefined)).toEqual(CUMULATIVE_SHARE)
    expect(clampSpendShares(null)).toEqual(CUMULATIVE_SHARE)
    expect(clampSpendShares({})).toEqual(CUMULATIVE_SHARE)
  })

  test("a usable pair passes through, with the judge forced to 1", () => {
    expect(clampSpendShares({ discover: 0.2, debate: 0.5 })).toEqual({
      discover: 0.2,
      debate: 0.5,
      judge: 1,
    })
  })

  test("the judge's value is DISCARDED, however it is asked for", () => {
    // A judge share below 1 makes part of the stated cap unreachable, which is a
    // ceiling that lies to the reader. It is not a dial.
    expect(clampSpendShares({ discover: 0.2, debate: 0.5, judge: 0.7 }).judge).toBe(1)
    expect(clampSpendShares({ discover: 0.2, debate: 0.5, judge: 9 }).judge).toBe(1)
  })

  test("NaN or a non-number ANYWHERE resets the WHOLE table, not one field", () => {
    // A half-clamped table is a ceiling nobody requested sitting between two
    // somebody did. And `spent < NaN` is false for every spend, so an unclamped
    // NaN discovery share refuses the first turn of the run and the report then
    // blames a budget nobody set.
    expect(clampSpendShares({ discover: Number.NaN, debate: 0.5 })).toEqual(CUMULATIVE_SHARE)
    expect(clampSpendShares({ discover: 0.2, debate: Number.NaN })).toEqual(CUMULATIVE_SHARE)
    expect(clampSpendShares({ discover: Number.POSITIVE_INFINITY, debate: 0.5 })).toEqual(
      CUMULATIVE_SHARE,
    )
    expect(
      clampSpendShares({ discover: "0.2" as unknown as number, debate: 0.5 }),
    ).toEqual(CUMULATIVE_SHARE)
  })

  test("each share is bounded into [0, 1]", () => {
    expect(clampSpendShares({ discover: -1, debate: 0.5 }).discover).toBe(0)
    expect(clampSpendShares({ discover: 0.2, debate: 4 }).debate).toBe(1)
  })

  test("MONOTONICITY IS FORCED, not rejected — debate never ends up below discovery", () => {
    // A debate ceiling under discovery's is a stage whose ceiling is already
    // spent before it starts: a gate that refuses every turn for a reason no
    // reader could reconstruct. The caller gets the nearest coherent thing.
    expect(clampSpendShares({ discover: 0.8, debate: 0.2 })).toEqual({
      discover: 0.8,
      debate: 0.8,
      judge: 1,
    })
  })

  test("zero is a real request and survives — it is not read as absent", () => {
    expect(clampSpendShares({ discover: 0, debate: 0.5 }).discover).toBe(0)
  })
})
