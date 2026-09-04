import { describe, expect, test } from "bun:test"

import { measurePairs } from "../core/clustering/fixtures/rates.ts"
import type { Finding, Verdict } from "../core/domain/finding.ts"
import { emptyLedger, recordTurn, type RunRecord } from "../core/domain/run-record.ts"
import { selectRoster } from "../core/roster/select.ts"
import { candidate, tokens } from "../core/test-support/fakes.ts"
import { alignArms } from "./align.ts"
import type { ArmRun } from "./arms.ts"
import {
  armCost,
  buildReport,
  degradation,
  fileLevelFindings,
  lensTokenCost,
  verdictDifference,
  verdictState,
} from "./compare.ts"

function finding(id: string, partial: Partial<Finding> = {}): Finding {
  return {
    id,
    claim: partial.claim ?? "shared vocabulary here",
    reasoning: "because of this",
    locus: partial.locus ?? { file: "x.ts", startLine: 10, endLine: 10 },
    severity: "high",
    author: "discovery-1",
    source: "pool",
    history: [],
    ...partial,
  }
}

function record(findings: Finding[] = [], cap: number | null = null): RunRecord {
  const { roster } = selectRoster([candidate("openai", "gpt-5")], {
    slots: 1,
    providerConfigKey: "provider",
  })
  return {
    runId: "run-1",
    startedAt: "2026-09-04T00:00:00.000Z",
    roster,
    answered: 1,
    findings,
    pool: findings,
    lensInstructions: [],
    threshold: 0.8,
    maxRounds: 3,
    warnings: [],
    ledger: emptyLedger(cap),
  }
}

function armRun(id: string, rec: RunRecord): ArmRun {
  return {
    spec: { id, label: id, provenance: "scripted", slots: 1 },
    repeat: 0,
    record: rec,
  rendered: "",
  }
}

describe("verdictState — total over six values, and no absence is coerced", () => {
  test("each of the four decisions passes through", () => {
    const decisions: Verdict[] = [
      "upheld",
      "withdrawn-by-author",
      "judge-ruled-invalid",
      "not-adjudicated",
    ]
    for (const verdict of decisions) {
      expect(verdictState(finding("f", { verdict }))).toBe(verdict)
    }
  })

  test("UNRESOLVED IS NOT `not-adjudicated`, and UNJUDGED IS NOT UNRESOLVED", () => {
    // Three different facts. Folding either absence into `not-adjudicated` would
    // restate *undecided* as *decided-not-adjudicated*, which is the coercion
    // AD-9's amendment forbids one level down.
    const stranded = finding("f", { unresolved: { diedAtStage: "debate", reason: "money" } })
    expect(verdictState(stranded)).toBe("unresolved")
    expect(verdictState(stranded)).not.toBe("not-adjudicated")

    const never = finding("g")
    expect(verdictState(never)).toBe("unjudged")
    expect(verdictState(never)).not.toBe("unresolved")
  })

  test("a verdict WINS over an unresolved mark, because a decision was reached", () => {
    const both = finding("f", {
      verdict: "upheld",
      unresolved: { diedAtStage: "judge", reason: "money" },
    })
    expect(verdictState(both)).toBe("upheld")
  })
})

describe("verdictDifference", () => {
  const ALWAYS = () => true
  const ONE_BLOCK = () => "everything"

  test("UNDECIDED IS IN NEITHER HALF OF THE FRACTION", async () => {
    const a = { id: "a", findings: [finding("f-1", { verdict: "upheld" })] }
    const b = { id: "b", findings: [finding("g-1")] } // unjudged
    const difference = verdictDifference(await alignArms(a, b, ALWAYS, ONE_BLOCK))

    expect(difference.of).toBe(0)
    expect(difference.differing).toBe(0)
    expect(difference.undecided).toBe(1)
  })

  test("A REAL DIFFERENCE IS VISIBLE, and the denominator is MATCHED PAIRS ONLY", async () => {
    // The non-vacuous sibling of the fixture's zero: without this, a comparator
    // that always returned `differing: 0` would pass every other test here.
    const a = {
      id: "a",
      findings: [
        finding("f-1", { verdict: "upheld", locus: { file: "x.ts", startLine: 10, endLine: 10 } }),
        finding("f-2", { verdict: "upheld", claim: "aaa", locus: { file: "y.ts", startLine: 1, endLine: 1 } }),
        finding("f-3", { claim: "zzz", locus: { file: "z.ts", startLine: 1, endLine: 1 } }),
      ],
    }
    const b = {
      id: "b",
      findings: [
        finding("g-1", { verdict: "judge-ruled-invalid", locus: { file: "x.ts", startLine: 10, endLine: 10 } }),
        finding("g-2", { verdict: "upheld", claim: "aaa", locus: { file: "y.ts", startLine: 1, endLine: 1 } }),
        finding("g-3", { claim: "qqq", locus: { file: "q.ts", startLine: 1, endLine: 1 } }),
      ],
    }
    const difference = verdictDifference(await alignArms(a, b))

    expect(difference).toMatchObject({
      differing: 1,
      of: 2,
      undecided: 0,
      onlyIn: { a: 1, b: 1 },
      ambiguous: 0,
    })
    expect(difference.differences[0]).toMatchObject({
      aState: "upheld",
      bState: "judge-ruled-invalid",
    })
  })

  test("an AMBIGUOUS group is excluded from the denominator and counted", async () => {
    const a = { id: "a", findings: [finding("f-1", { verdict: "upheld" })] }
    const b = {
      id: "b",
      findings: [finding("g-1", { verdict: "upheld" }), finding("g-2", { verdict: "upheld" })],
    }
    const difference = verdictDifference(await alignArms(a, b, ALWAYS, ONE_BLOCK))
    expect(difference.of).toBe(0)
    expect(difference.ambiguous).toBe(1)
  })
})

describe("armCost — read from the accountant, never re-summed", () => {
  test("tokens and turns come off the ledger, and the five components are carried apart", () => {
    const rec = record([], 1000)
    recordTurn(rec.ledger, { slot: "discovery-1", stage: "discover", attempt: 1, tokens: tokens(10, 20) })
    const cost = armCost(rec)
    expect(cost).toMatchObject({ tokens: 30, billedTurns: 1, input: 10, output: 20, cap: 1000 })
  })

  test("`cap: null` STAYS null — it is rendered as `none`, and 0 is a real ceiling", () => {
    expect(armCost(record([], null)).cap).toBeNull()
    expect(armCost(record([], 0)).cap).toBe(0)
  })
})

describe("lensTokenCost and fileLevelFindings", () => {
  test("the lens cost is the arm DIFFERENCE, in tokens and turns", () => {
    const lensed = record([], null)
    const plain = record([], null)
    for (let i = 0; i < 3; i += 1) {
      recordTurn(lensed.ledger, { slot: "s", stage: "discover", attempt: 1, tokens: tokens(10, 20) })
    }
    recordTurn(plain.ledger, { slot: "s", stage: "discover", attempt: 1, tokens: tokens(10, 20) })

    expect(lensTokenCost(lensed, plain)).toEqual({ tokens: 60, billedTurns: 2 })
  })

  test("IT CARRIES NO DEFECT FIELD — the gain and the cost are two numbers (AD-9)", () => {
    expect(Object.keys(lensTokenCost(record(), record())).sort()).toEqual(["billedTurns", "tokens"])
  })

  test("a file-level finding is counted, because it can NEVER align with a line-cited one", () => {
    const rec = record([
      finding("f-1", { locus: { file: "x.ts" } }),
      finding("f-2", { locus: { file: "x.ts", startLine: 1, endLine: 1 } }),
    ])
    expect(fileLevelFindings(rec)).toBe(1)
  })
})

describe("degradation — AD-6, and the three causes stay three", () => {
  test("a clean arm is not degraded, and a provider disclosure is not a degradation", () => {
    const rec = record()
    rec.warnings = [
      { code: "provider-fan-out", stage: "roster", message: "disclosure", detail: {} },
    ]
    expect(degradation(rec).degraded).toBe(false)
  })

  test("a warning, a budget skip and a cancellation EACH mark the arm degraded", () => {
    const warned = record()
    warned.warnings = [
      { code: "roster-underfilled", stage: "roster", message: "short", detail: {} },
    ]
    expect(degradation(warned).degraded).toBe(true)

    const starved = record()
    starved.skippedForBudget = ["discovery-2"]
    expect(degradation(starved)).toMatchObject({ degraded: true, budgetSkipped: 1 })

    const stopped = record()
    stopped.cancelled = { stage: "discover" }
    expect(degradation(stopped)).toMatchObject({ degraded: true, cancelledAt: "discover" })
  })

  test("the WHOLE Warning object survives — code, message and detail", () => {
    const rec = record()
    const warning = {
      code: "roster-underfilled" as const,
      stage: "roster" as const,
      message: "the exact sentence",
      detail: { requested: 3 },
    }
    rec.warnings = [warning]
    expect(degradation(rec).warnings).toEqual([warning])
  })
})

describe("buildReport — AD-9: four numbers, and NOTHING fuses them", () => {
  const scan = (value: unknown, hit: (key: string) => void): void => {
    if (Array.isArray(value)) {
      for (const item of value) scan(item, hit)
      return
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        hit(key)
        scan(child, hit)
      }
    }
  }

  test("NO KEY ANYWHERE IN THE REPORT IS A FUSED SCORE", async () => {
    // The same assertion `rates.test.ts` already makes for CAP-2. A single "was
    // debate worth it?" number would fuse a defect count with a token count, and
    // the exchange rate between them is the READER's judgement.
    const a = armRun("a", record([finding("f-1", { verdict: "upheld" })]))
    const b = armRun("b", record([finding("g-1", { verdict: "upheld" })]))
    const report = await buildReport([a, b], {
      pairings: [
        {
          a: "a",
          b: "b",
          alignment: await alignArms(
            { id: "a", findings: a.record.findings },
            { id: "b", findings: b.record.findings },
          ),
        },
      ],
    })

    // WHOLE WORDS, split on camelCase and underscores. A substring test matches
    // `matcherCalib-ratio-n`, which is the opposite of a fused score — it is the
    // field that STATES the instrument's error (found while writing this test).
    const FORBIDDEN = new Set(["score", "accuracy", "efficiency", "ratio", "pertoken", "worth"])
    const offenders: string[] = []
    scan(report, (key) => {
      const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[\s_]+/)
      for (const word of words) {
        if (FORBIDDEN.has(word.toLowerCase())) offenders.push(key)
      }
    })
    expect(offenders).toEqual([])
  })

  test("THE MATCHER CALIBRATION IS MEASURED LIVE and cannot go stale", async () => {
    // A literal pasted here would keep reporting 1/3 and 1/5 after the matcher
    // or the labelled set moved — a stated error that is no longer the error.
    const a = armRun("a", record())
    const b = armRun("b", record())
    const report = await buildReport([a, b], { pairings: [] })
    const measured = await measurePairs()
    expect(report.matcherCalibration).toEqual({
      overMerge: measured.overMerge,
      underMerge: measured.underMerge,
    })
  })

  test("`anyScripted` is true when ANY arm was scripted — it drives an unsuppressable banner", async () => {
    const scripted = armRun("a", record())
    const live: ArmRun = {
      ...armRun("b", record()),
      spec: { id: "b", label: "b", provenance: "live", slots: 1 },
    }
    expect((await buildReport([scripted, live], { pairings: [] })).anyScripted).toBe(true)
    expect((await buildReport([live], { pairings: [] })).anyScripted).toBe(false)
  })

  test("an ABSENT counts block stays absent — 'did not run' is not 'ran and found nothing'", async () => {
    const report = await buildReport([armRun("a", record())], { pairings: [] })
    expect(report.arms[0]!.routeCounts).toBeUndefined()
    expect(report.arms[0]!.debateCounts).toBeUndefined()
    expect(report.arms[0]!.judgeCounts).toBeUndefined()
  })

  test("the four numbers are four SEPARATELY REACHABLE objects", async () => {
    const a = armRun("a", record([finding("f-1", { verdict: "upheld" })]))
    const b = armRun("b", record([finding("g-1", { verdict: "upheld" })]))
    const report = await buildReport([a, b], {
      pairings: [
        {
          a: "a",
          b: "b",
          alignment: await alignArms(
            { id: "a", findings: a.record.findings },
            { id: "b", findings: b.record.findings },
          ),
        },
      ],
      lens: { gain: undefined, cost: { tokens: 270, billedTurns: 9 } },
    })

    expect(report.pairings[0]!.difference.differing).toBeDefined()
    expect(report.arms[0]!.cost.tokens).toBeDefined()
    expect(report.lens!.cost.tokens).toBe(270)
    // The gain is a count of DEFECTS and lives on its own field; the cost object
    // beside it carries no defect count.
    expect(Object.keys(report.lens!.cost).sort()).toEqual(["billedTurns", "tokens"])
  })
})

describe("confounders — stated beside the number they degrade", () => {
  test("DIALS THAT DIFFER ARE NAMED, so a difference is not read as roster-caused", async () => {
    const a = armRun("a", record())
    const b = armRun("b", record())
    b.record.threshold = 0.5
    const report = await buildReport([a, b], {
      pairings: [
        { a: "a", b: "b", alignment: await alignArms({ id: "a", findings: [] }, { id: "b", findings: [] }) },
      ],
    })
    expect(report.pairings[0]!.confounders.dialsDiffer).toEqual(["threshold: 0.8 vs 0.5"])
  })

  test("equal dials produce an EMPTY list, not a missing one", async () => {
    const a = armRun("a", record())
    const b = armRun("b", record())
    const report = await buildReport([a, b], {
      pairings: [
        { a: "a", b: "b", alignment: await alignArms({ id: "a", findings: [] }, { id: "b", findings: [] }) },
      ],
    })
    expect(report.pairings[0]!.confounders.dialsDiffer).toEqual([])
  })

  test("THE N=1 VACUITY IS STATED NARROWLY — critical severity still routes", async () => {
    // `route.ts` overrides the threshold for `critical` at any setting, so "the
    // threshold is vacuous at answered: 1" is true and "nothing debates" is not.
    // The flag is named for the narrow claim.
    const a = armRun("a", record())
    const b = armRun("b", record())
    b.record.answered = 3
    const report = await buildReport([a, b], {
      pairings: [
        { a: "a", b: "b", alignment: await alignArms({ id: "a", findings: [] }, { id: "b", findings: [] }) },
      ],
    })
    expect(report.pairings[0]!.confounders.thresholdVacuousExceptCritical).toBe(true)
  })
})
