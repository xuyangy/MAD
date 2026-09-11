import { describe, expect, test } from "bun:test"

import { ALIGNER_MATCHER, alignArms } from "./align.ts"
import { runAblation } from "./arms.ts"
import { matcherText, measureCrossArm } from "./cross-arm-rates.ts"
import { CROSS_ARM_PAIRS_SEAL } from "../fixtures/cross-arm-pairs/seal.ts"
import { CONTROL, LENSED, POOL, scriptedAblation, scriptedArms } from "./seeded-defects.ts"
import { renderAblation } from "./report.ts"
import { main, MAX_REPEATS, MAX_TOKEN_CAP, numericFlag } from "../scripts/ablation.ts"
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

  test("A MISTYPED --cap IS REFUSED, and never reaches clampTokenCap as `no ceiling`", async () => {
    // The regression this pins (retrospective 2026-09-06, F1): `--cap abc` was
    // `Number("abc")` = NaN, and `clampTokenCap(NaN)` is `null`, which means NO
    // CEILING. The run completed, printed `cap none`, and returned 0 — on the one
    // flag whose whole job is to bound spend. Under `--live` that is credentials.
    const lines: string[] = []
    const log = console.log
    console.log = (line: string) => void lines.push(line)
    try {
      expect(await main(["bun", "ablation", "--pin", "openai/gpt-5", "--cap", "abc"])).toBe(0)
    } finally {
      console.log = log
    }
    const printed = lines.join("\n")
    expect(printed).toContain("--cap must be a whole number")
    expect(printed).toContain("Nothing was run and nothing was billed")
    // NOT VACUOUS: the refusal must replace the report, not precede it. If the run
    // still happened, the banner every rendered report carries would be here too.
    expect(printed).not.toContain("SCRIPTED BACKEND")
    expect(printed).not.toContain("cap none")
  })

  test("--repeats 0 is refused instead of throwing a raw TypeError", async () => {
    // F2's mirror of the above: `Number("0")` is a fine number, so nothing rejected
    // it, the empty arm array reached `scriptedAblation`, and the CLI died with
    // `TypeError: undefined is not an object (evaluating 'a.spec')` and a NON-ZERO
    // exit — against this module's own "main always returns 0".
    const lines: string[] = []
    const log = console.log
    console.log = (line: string) => void lines.push(line)
    try {
      expect(await main(["bun", "ablation", "--pin", "openai/gpt-5", "--repeats", "0"])).toBe(0)
    } finally {
      console.log = log
    }
    expect(lines.join("\n")).toContain("--repeats must be 1 or more")
  })

  test("the other unreadable shapes, and the readable ones that must still pass", async () => {
    const log = console.log
    console.log = () => {}
    try {
      // Refused: no value, a bare flag where a value should be, a fraction,
      // Infinity, and a negative cap.
      for (const argv of [
        ["--cap"],
        ["--cap", "--live"],
        ["--cap", "1.5"],
        ["--cap", "Infinity"],
        ["--cap", "-1"],
        ["--repeats", "-2"],
        ["--repeats", "2.5"],
      ]) {
        expect(await main(["bun", "ablation", "--pin", "openai/gpt-5", ...argv])).toBe(0)
      }
    } finally {
      console.log = log
    }

    // Accepted, and the point of asserting it: `--cap 0` is a REAL explicit
    // ceiling of zero, not rubbish, so the floor for `--cap` is 0 and not 1.
    // Absent stays absent — no ceiling, which is the deliberate default.
    expect(numericFlag(["--cap", "0"], "cap", 0, MAX_TOKEN_CAP)).toEqual({ ok: true, value: 0 })
    expect(numericFlag(["--cap", "400"], "cap", 0, MAX_TOKEN_CAP)).toEqual({ ok: true, value: 400 })
    expect(numericFlag([], "cap", 0, MAX_TOKEN_CAP)).toEqual({ ok: true, value: undefined })
    expect(numericFlag(["--repeats", "3"], "repeats", 1, MAX_REPEATS)).toEqual({ ok: true, value: 3 })
  })

  test("a REFUSED run is refused BEFORE the arms run — structurally, not by promise", async () => {
    // `--cap abc --live` would otherwise import `ablation/live.ts` and open an
    // opencode client. It returns 0 without touching the live path, which is what
    // "nothing was billed" has to mean.
    //
    // THE EXIT CODE ALONE ASSERTS NOTHING (code review 2026-09-08). `main`
    // returns 0 on the SUCCESSFUL live path too, so `toBe(0)` passed here only
    // because CI has no opencode server to reach — delete the guard and this
    // test stays green on a machine that does, while real turns are billed. What
    // separates the two outcomes is what was printed: the refusal names the flag,
    // and a run that reached the arms would have printed the report banner.
    const log = console.log
    const printed: string[] = []
    console.log = (...args: unknown[]) => {
      printed.push(args.join(" "))
    }
    try {
      expect(await main(["bun", "ablation", "--pin", "openai/gpt-5", "--live", "--cap", "abc"])).toBe(0)
    } finally {
      console.log = log
    }
    const output = printed.join("\n")
    expect(output).toContain("--cap must be a whole number")
    expect(output).toContain("`abc`")
    expect(output).not.toContain("CAP-9 — ABLATION")
    expect(output).not.toContain("LIMITATIONS")
  })

  test("`--cap=400` is the SAME REQUEST as `--cap 400` (code review 2026-09-08)", () => {
    // The equals form was invisible to `indexOf("--cap")`, so an unseen `--cap`
    // was an ABSENT `--cap`, absent meant no ceiling, and under `--live` no
    // ceiling is real credentials. The seam that refuses a mistyped value could
    // not help: the value was never read.
    expect(numericFlag(["--cap=400"], "cap", 0, MAX_TOKEN_CAP)).toEqual({ ok: true, value: 400 })
    expect(numericFlag(["--repeats=3"], "repeats", 1, MAX_REPEATS)).toEqual({ ok: true, value: 3 })
    // And the equals form is held to the SAME contract, not waved through.
    expect(numericFlag(["--cap=abc"], "cap", 0, MAX_TOKEN_CAP).ok).toBe(false)
    expect(numericFlag(["--cap="], "cap", 0, MAX_TOKEN_CAP).ok).toBe(false)
    expect(numericFlag(["--repeats=0"], "repeats", 1, MAX_REPEATS).ok).toBe(false)
  })

  test("A REPEATED FLAG IS REFUSED, not resolved to the first one (ledger triage 2026-09-09)", () => {
    // `--cap 400 --cap abc` used to run with a ceiling of 400 and never look at
    // the second value — the shape this seam exists to refuse, re-entering
    // through repetition rather than through the value.
    const twice = numericFlag(["--cap", "400", "--cap", "abc"], "cap", 0, MAX_TOKEN_CAP)
    expect(twice.ok).toBe(false)
    if (!twice.ok) expect(twice.message).toContain("2 times")
    // Both spellings count as the same dial.
    expect(numericFlag(["--cap=400", "--cap", "5"], "cap", 0, MAX_TOKEN_CAP).ok).toBe(false)
    // One occurrence is still fine.
    expect(numericFlag(["--cap", "400"], "cap", 0, MAX_TOKEN_CAP)).toEqual({ ok: true, value: 400 })
  })

  test("a number is DECIMAL DIGITS, not whatever `Number` accepts (code review 2026-09-08)", () => {
    // `Number` reads `0x10` as 16, `1e3` as 1000 and `+5` as 5, and
    // `Number.isInteger` then accepts all three — so a flag whose refusal says
    // "must be a whole number" was quietly reinterpreting the digits typed. On
    // the flag that bounds spend, a ceiling that differs from what was typed is
    // the same defect as no ceiling.
    for (const raw of ["0x10", "1e3", "+5", "0b11", "1_000"]) {
      const result = numericFlag(["--cap", raw], "cap", 0, MAX_TOKEN_CAP)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toContain(raw)
    }
    // A negative is still refused BY RANGE, which names the floor, rather than
    // by shape, which would not.
    const negative = numericFlag(["--cap", "-1"], "cap", 0, MAX_TOKEN_CAP)
    expect(negative.ok).toBe(false)
    if (!negative.ok) expect(negative.message).toContain("0 or more")
  })

  test("a numeric flag has a CEILING as well as a floor (human decision 2026-09-08)", async () => {
    // The floor was stated and the ceiling was not, so `--repeats 1000000`
    // validated — and under `--live` that is a million billed runs per arm from
    // one slipped digit. Both ends are refused BY RANGE now, and the message
    // names the limit so the operator can tell a typo from a policy.
    const tooMany = numericFlag(["--repeats", "1000000"], "repeats", 1, MAX_REPEATS)
    expect(tooMany.ok).toBe(false)
    if (!tooMany.ok) {
      expect(tooMany.message).toContain(`${MAX_REPEATS} or less`)
      expect(tooMany.message).toContain("1000000")
    }
    const tooBig = numericFlag(["--cap", String(MAX_TOKEN_CAP + 1)], "cap", 0, MAX_TOKEN_CAP)
    expect(tooBig.ok).toBe(false)
    if (!tooBig.ok) expect(tooBig.message).toContain(`${MAX_TOKEN_CAP} or less`)
    // The ceiling itself is INSIDE the range, not outside it: a stated limit the
    // caller cannot actually use is a different limit.
    expect(numericFlag(["--repeats", String(MAX_REPEATS)], "repeats", 1, MAX_REPEATS)).toEqual({
      ok: true,
      value: MAX_REPEATS,
    })
    expect(numericFlag(["--cap", String(MAX_TOKEN_CAP)], "cap", 0, MAX_TOKEN_CAP)).toEqual({
      ok: true,
      value: MAX_TOKEN_CAP,
    })
    // And the CLI refuses it before either arm path is reached, which is what
    // "nothing was billed" has to mean — the same structural guarantee the other
    // refusals get, checked over the flag this decision added.
    const log = console.log
    const printed: string[] = []
    console.log = (...args: unknown[]) => {
      printed.push(args.join(" "))
    }
    let code: number
    try {
      code = await main(["bun", "ablation", "--pin", "openai/gpt-5", "--repeats", "1000000", "--live"])
    } finally {
      console.log = log
    }
    expect(code).toBe(0)
    const output = printed.join("\n")
    expect(output).toContain("Nothing was run and nothing was billed")
    expect(output).not.toContain("CAP-9 — ABLATION")
  })

  test("a VALID `--cap` actually reaches the run (code review 2026-09-08)", async () => {
    // The suite pinned every refusal and none of the acceptances end to end, so
    // deleting `...(tokenCap === undefined ? {} : { tokenCap })` from both call
    // sites left it green — a test that could not fail, in a story that closed
    // two others of that shape. The ceiling is observable: it is printed.
    const log = console.log
    const printed: string[] = []
    console.log = (...args: unknown[]) => {
      printed.push(args.join(" "))
    }
    let code: number
    try {
      code = await main(["bun", "ablation", "--pin", "openai/gpt-5", "--cap", "400"])
    } finally {
      console.log = log
    }
    expect(code).toBe(0)
    const output = printed.join("\n")
    expect(output).toContain("CAP-9 — ABLATION")
    expect(output).toContain("400")
    // The ceiling BIT: a run with no cap strands nothing, so the degradation the
    // shared-ceiling test proves arm-caused has to be visible from the CLI too.
    expect(output).toMatch(/cap 400|400\)/)
  })

  test("the rendered report carries the unsuppressable banner", async () => {
    const report = await scriptedAblation({ pin: PIN })
    const rendered = renderAblation(report).join("\n")
    expect(rendered).toContain("SCRIPTED BACKEND")
    expect(rendered).toContain("CAN ONLY BE ZERO")
    expect(rendered).toContain("NO conclusion about debate's value follows from it")
  })

  test("ALL FOUR `cannot`s ARE PRINTED, none corrected for (code review 2026-09-08)", async () => {
    // The Design Notes name four things this harness cannot do and say all four
    // are printed. Two were — the noise floor and the matcher error. The other
    // two existed only in the story file, which is the one place a reader of the
    // report cannot see, and without them the control-vs-pool delta reads as
    // debate's effect. That is the exact misreading the block exists to prevent.
    const report = await scriptedAblation({ pin: PIN })
    const rendered = renderAblation(report).join("\n")
    expect(rendered).toContain("NOISE FLOOR")
    expect(rendered).toContain("DEBATE CANNOT BE ISOLATED")
    expect(rendered).toContain("LENSES CANNOT BE SEPARATED FROM FAN-OUT")
  })

  test("A RUN OVER SEEDED_CHANGE PRINTS THE MEASURED CROSS-ARM RATES, scoped to this change", async () => {
    // The scripted ablation reviews the change the sealed cross-arm set was drawn
    // from, so its report takes the measured branch rather than UNMEASURED.
    const report = await scriptedAblation({ pin: PIN })
    const rendered = renderAblation(report).join("\n")
    const calibration = report.crossArmCalibration!
    expect(calibration).toEqual((await measureCrossArm()).calibration)
    expect(rendered).not.toContain("CROSS-ARM MATCHING IS UNMEASURED")
    expect(rendered).not.toContain("no cross-arm labelled set applies to this change")
    expect(rendered).toContain("CROSS-ARM MATCHING IS MEASURED FOR THIS CHANGE ONLY")
    expect(rendered).toContain(`${calibration.samples} hand-built case(s) that cite this change's lines`)
    expect(rendered).toContain(`Cross-arm set: ${CROSS_ARM_PAIRS_SEAL.version} (${CROSS_ARM_PAIRS_SEAL.datasetHash})`)
    expect(rendered).toContain(`Matcher: ${matcherText(ALIGNER_MATCHER)}.`)
    expect(rendered).toContain(
      `over-merge ${calibration.overMerge.grouped} of ${calibration.overMerge.of} (distinct and only-in-one-arm cases grouped)`,
    )
    expect(rendered).toContain(
      `under-merge ${calibration.underMerge.ungrouped} of ${calibration.underMerge.of} (equivalent cases not grouped)`,
    )
    expect(rendered).toContain("Matcher calibration, measured live this run")
    expect(rendered.replace(/\n\s*/g, " ")).toContain("the difference count one for one")
  })

  test("the report states `execution: sequential` (code review 2026-09-08)", async () => {
    // A disclosure the constraints require, not a setting. `runAblation` awaits
    // each arm in turn, so the behaviour was always right — but with the line
    // absent a reader cannot tell a sequential run from an overlapped one, and
    // overlap would put the arms in contention for one host and make every token
    // figure a shared number.
    const report = await scriptedAblation({ pin: PIN })
    expect(renderAblation(report).join("\n")).toContain("execution: sequential")
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
