import { describe, expect, test } from "bun:test"

import { alignArms } from "./align.ts"
import { runAblation } from "./arms.ts"
import { CONTROL, LENSED, POOL, scriptedAblation, scriptedArms } from "./seeded-defects.ts"
import { renderAblation } from "./report.ts"
import { main } from "../scripts/ablation.ts"
import { abstainingInDebate, LENS_SCRIPTS, SCRIPTS, SEEDED_CANDIDATES } from "../fixtures/seeded-defects/arms.ts"
import { SEEDED_CHANGE } from "../fixtures/seeded-defects/change.ts"
import { fakeClock, FakeBackend } from "../core/test-support/fakes.ts"

const PIN = { providerId: "openai", modelId: "gpt-5" }

describe("the three arms differ in the ROSTER and in nothing else", () => {
  test("THREE ARMS THROUGH ONE review() SEAM", async () => {
    const specs = scriptedArms(PIN)
    expect(specs.map((spec) => spec.id)).toEqual([CONTROL, POOL, LENSED])
    expect(specs.map((spec) => spec.slots)).toEqual([1, 3, 3])
    expect(specs[0]!.pins).toEqual([PIN])
    expect(specs[1]!.lenses).toBeUndefined()
    expect(specs[2]!.lenses!.length).toBeGreaterThan(0)
  })

  test("EVERY DIAL IS EQUAL ACROSS ARMS, as the RECORD reports it", async () => {
    // Read off the RunRecord, not off the arm literal: `review()` re-clamps and
    // re-stamps its dials, so the literal is what was asked for and the record is
    // what happened. Two variables and one number is not a measurement.
    const report = await scriptedAblation({ pin: PIN })
    for (const pairing of report.pairings) {
      expect(pairing.confounders.dialsDiffer).toEqual([])
    }
  })

  test("THE CONTROL ARM IS A NAMED SINGLE MODEL, and the report can say which", async () => {
    const report = await scriptedAblation({ pin: PIN })
    const control = report.arms.find((arm) => arm.id === CONTROL)!
    expect(control.slots).toBe(1)
    expect(control.answered).toBe(1)
    expect(control.lenses).toEqual([])
    expect(control.pinned).toEqual(["openai/gpt-5"])
    expect(control.degradation.warnings.map((w) => w.code)).not.toContain("roster-pin-unhonoured")
  })

  test("THE SAME ARM WITHOUT A PIN RESOLVES TO WHATEVER RANKING RETURNS", async () => {
    // The non-vacuous sibling: without it, "the control arm is pinned" could be
    // true of an arm whose pin did nothing.
    const pinned = await runAblation(
      [{ id: "x", label: "x", provenance: "scripted", slots: 1, pins: [PIN] }],
      {
        backendFor: () => new FakeBackend(abstainingInDebate({ ...SCRIPTS, ...LENS_SCRIPTS })),
        backend: new FakeBackend(abstainingInDebate({ ...SCRIPTS })),
        clock: fakeClock(),
        change: SEEDED_CHANGE,
        candidates: SEEDED_CANDIDATES,
        providerConfigKey: "provider",
      },
    )
    const unpinned = await runAblation(
      [{ id: "x", label: "x", provenance: "scripted", slots: 1 }],
      {
        backendFor: () => new FakeBackend(abstainingInDebate({ ...SCRIPTS, ...LENS_SCRIPTS })),
        backend: new FakeBackend(abstainingInDebate({ ...SCRIPTS })),
        clock: fakeClock(),
        change: SEEDED_CHANGE,
        candidates: SEEDED_CANDIDATES,
        providerConfigKey: "provider",
      },
    )

    expect(pinned[0]!.record.roster.slots[0]!.modelId).toBe("gpt-5")
    expect(unpinned[0]!.record.roster.slots[0]!.modelId).not.toBe("gpt-5")
  })
})

describe("the measured pairings — where ZERO is a result and the UNMATCHED count is not", () => {
  test("THE THREE PAIRINGS, as derived shapes", async () => {
    // The difference may legitimately be zero — the scripted judge answers a
    // constant, which is what the report's banner says. The UNMATCHED counts must
    // not be zero: if every arm aligned perfectly with every other, the aligner
    // would be doing nothing and the zero above would prove nothing.
    const report = await scriptedAblation({ pin: PIN })
    const pairing = (a: string, b: string) =>
      report.pairings.find((p) => p.a === a && p.b === b)!

    const controlPool = pairing(CONTROL, POOL)
    expect(controlPool.difference.differing).toBe(0)
    expect(controlPool.difference.of).toBeGreaterThan(0)
    expect(controlPool.difference.onlyIn.b).toBeGreaterThan(0)

    const poolLensed = pairing(POOL, LENSED)
    expect(poolLensed.difference.of).toBeGreaterThan(controlPool.difference.of)
    expect(poolLensed.difference.onlyIn.b).toBeGreaterThan(0)

    expect(pairing(CONTROL, LENSED).difference.onlyIn.b).toBeGreaterThan(0)
  })

  test("the arms grow in findings and in cost, in the same direction", async () => {
    const report = await scriptedAblation({ pin: PIN })
    const arm = (id: string) => report.arms.find((a) => a.id === id)!
    expect(arm(CONTROL).findings).toBeLessThan(arm(POOL).findings)
    expect(arm(POOL).findings).toBeLessThan(arm(LENSED).findings)
    expect(arm(CONTROL).cost.tokens).toBeLessThan(arm(POOL).cost.tokens)
    expect(arm(POOL).cost.tokens).toBeLessThan(arm(LENSED).cost.tokens)
  })

  test("RECALL READS `pool` AND VERDICTS READ `findings`", async () => {
    // The pre-cluster union is what CAP-1 measures over. Reading the canonical
    // set instead would score an arm against a set clustering already collapsed
    // and silently lower every recall number in this report.
    const report = await scriptedAblation({ pin: PIN })
    const lensed = report.arms.find((arm) => arm.id === LENSED)!
    expect(lensed.pooled).toBeGreaterThan(lensed.findings)
    expect(report.lens!.gain!.combined.found).toBeGreaterThan(report.lens!.gain!.pool.found)
  })

  test("LENS RECALL GAIN AND LENS TOKEN COST ARE TWO NUMBERS, in two units", async () => {
    const report = await scriptedAblation({ pin: PIN })
    expect(report.lens!.gain!.lensOnlyDefects.length).toBeGreaterThan(0)
    expect(report.lens!.cost.tokens).toBeGreaterThan(0)
    expect(Object.keys(report.lens!.cost).sort()).toEqual(["billedTurns", "tokens"])
  })
})

describe("a SHARED CEILING produces a real, arm-caused effect", () => {
  test("one cap, and the wider arms are the ones it bites", async () => {
    // A ceiling that differed by arm would make "this arm stranded findings" a
    // fact about the ceiling instead of a fact about the roster. One value is
    // spread into all three.
    const report = await scriptedAblation({ pin: PIN, tokenCap: 400 })
    const arm = (id: string) => report.arms.find((a) => a.id === id)!

    expect(arm(CONTROL).cost.cap).toBe(400)
    expect(arm(POOL).cost.cap).toBe(400)
    expect(arm(LENSED).cost.cap).toBe(400)

    // The control arm fits; at least one wider arm does not.
    expect(arm(CONTROL).degradation.degraded).toBe(false)
    expect(arm(POOL).degradation.degraded || arm(LENSED).degradation.degraded).toBe(true)
  })

  test("an UNDECIDED finding lands in neither half of the fraction", async () => {
    const report = await scriptedAblation({ pin: PIN, tokenCap: 400 })
    const undecided = report.pairings.reduce((sum, p) => sum + p.difference.undecided, 0)
    expect(undecided).toBeGreaterThan(0)
    for (const pairing of report.pairings) {
      expect(pairing.difference.differing).toBeLessThanOrEqual(pairing.difference.of)
    }
  })
})

describe("AD-16 — three records compared in memory", () => {
  test("NOTHING IS WRITTEN, and the report holds the numbers rather than a path", async () => {
    // The ablation writes nothing at all: no artifact, no scratch file, no
    // temp directory. `ablation/` imports no filesystem writer, which is the
    // structural version of this assertion.
    const source = await Bun.file("ablation/compare.ts").text()
    const align = await Bun.file("ablation/align.ts").text()
    const arms = await Bun.file("ablation/arms.ts").text()
    for (const module of [source, align, arms]) {
      expect(module).not.toContain("node:fs")
      expect(module).not.toContain("Bun.write")
      expect(module).not.toContain("writeFile")
    }
  })

  test("alignment reuses the ENGINE and never the stage, so no record is mutated", async () => {
    const report = await scriptedAblation({ pin: PIN })
    // A run through `cluster()` — the stage — would have stamped co-discovery
    // whose denominator spans two rosters. Nothing here carries one.
    expect(report.pairings.every((p) => p.alignment.comparisons > 0)).toBe(true)
  })
})

describe("the reporter", () => {
  test("IT RETURNS 0 ON A ZERO-DIFFERENCE RUN — a negative result is not a failure", async () => {
    expect(await main(["bun", "ablation", "--pin", "openai/gpt-5"])).toBe(0)
  })

  test("a MISSING pin prints guidance and still returns 0", async () => {
    expect(await main(["bun", "ablation"])).toBe(0)
    expect(await main(["bun", "ablation", "--pin", "no-slash"])).toBe(0)
  })

  test("the rendered report carries the unsuppressable banner", async () => {
    const report = await scriptedAblation({ pin: PIN })
    const rendered = renderAblation(report).join("\n")
    expect(rendered).toContain("SCRIPTED BACKEND")
    expect(rendered).toContain("CAN ONLY BE ZERO")
    expect(rendered).toContain("NO conclusion about debate's value follows from it")
  })

  test("A FRESH BACKEND PER ARM — one instance across three arms replays the wrong step", async () => {
    // `FakeBackend` counts attempts per (slot, role). Sharing one across three
    // arms hands arm 2 the step arm 1 finished on, which would make the arms
    // differ in their SCRIPTS as well as their rosters.
    const shared = new FakeBackend(abstainingInDebate({ ...SCRIPTS, ...LENS_SCRIPTS }))
    const runs = await runAblation(scriptedArms(PIN), {
      backend: shared,
      clock: fakeClock(),
      change: SEEDED_CHANGE,
      candidates: SEEDED_CANDIDATES,
      providerConfigKey: "provider",
    })
    const fresh = await scriptedAblation({ pin: PIN })
    const sharedPool = runs.find((run) => run.spec.id === POOL)!
    const freshPool = fresh.arms.find((arm) => arm.id === POOL)!
    expect(sharedPool.record.findings.length).not.toBe(freshPool.findings)
  })
})

describe("alignment over the fixture", () => {
  test("the control and pool arms both start at finding-1 and are NOT conflated", async () => {
    const report = await scriptedAblation({ pin: PIN })
    // Ids collide across arms by construction (`fakeClock` numbers from 1 per
    // run); the namespacing is what keeps them apart. If it failed, the
    // control arm's four findings would all match the pool arm's first four by
    // name and `onlyIn` would be zero.
    const controlPool = report.pairings.find((p) => p.a === CONTROL && p.b === POOL)!
    expect(controlPool.difference.onlyIn.b).toBeGreaterThan(0)
  })

  test("the aligner is asked something: comparisons and candidate pairs are non-zero", async () => {
    const report = await scriptedAblation({ pin: PIN })
    for (const pairing of report.pairings) {
      expect(pairing.alignment.comparisons).toBeGreaterThan(0)
      expect(pairing.alignment.candidatePairs).toBeGreaterThan(0)
      expect(pairing.alignment.failures).toBe(0)
    }
  })

  test("an arm aligned with ITSELF is refused — two arms must have different ids", async () => {
    await expect(
      alignArms({ id: "same", findings: [] }, { id: "same", findings: [] }),
    ).rejects.toThrow("different ids")
  })
})
