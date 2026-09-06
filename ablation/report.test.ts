import { describe, expect, test } from "bun:test"

import type { AblationReport } from "./compare.ts"
import { renderAblation } from "./report.ts"

function baseArm(id: string, overrides: Partial<AblationReport["arms"][number]> = {}) {
  return {
    id,
    repeat: 0,
    label: id,
    provenance: "scripted",
    slots: 3,
    lenses: [] as string[],
    pinned: [] as string[],
    answered: 3,
    findings: 4,
    pooled: 4,
    cost: {
      tokens: 180,
      billedTurns: 6,
      input: 60,
      output: 120,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cap: null as number | null,
    },
    fileLevel: 0,
    degradation: { degraded: false, warnings: [], budgetSkipped: 0 },
    ...overrides,
  }
}

function report(overrides: Partial<AblationReport> = {}): AblationReport {
  return {
    arms: [baseArm("a"), baseArm("b")],
    pairings: [
      {
        a: "a",
        b: "b",
        difference: {
          differing: 0,
          of: 4,
          undecided: 0,
          onlyIn: { a: 0, b: 6 },
          ambiguous: 0,
          differences: [],
        },
        alignment: { comparisons: 78, failures: 0, candidatePairs: 40, blockedPairs: 4 },
        confounders: {
          eitherDegraded: false,
          thresholdVacuousExceptCritical: false,
          dialsDiffer: [],
        },
      },
    ],
    matcherCalibration: { overMerge: { merged: 1, of: 3 }, underMerge: { unmerged: 1, of: 5 } },
    anyScripted: true,
    repeats: 1,
    ...overrides,
  }
}

const text = (r: AblationReport) => renderAblation(r).join("\n")

describe("the LIMITATIONS block sits above the numbers", () => {
  test("THE SCRIPTED BANNER CANNOT BE SUPPRESSED — there is no option that removes it", () => {
    // `renderAblation` takes ONE argument. There is no flag, no default to flip
    // and no `--quiet`, so a future caller cannot quietly produce a clean-looking
    // table from a fixture.
    expect(renderAblation).toHaveLength(1)
    const rendered = text(report())
    expect(rendered).toContain("SCRIPTED BACKEND")
    expect(rendered).toContain("CAN ONLY BE ZERO")
    expect(rendered).toContain("It measures nothing about")
  })

  test("a fully LIVE render omits the scripted banner", () => {
    const rendered = text(report({ anyScripted: false }))
    expect(rendered).not.toContain("SCRIPTED BACKEND")
  })

  test("the banner appears BEFORE the first number, not in a footnote", () => {
    const lines = renderAblation(report())
    const banner = lines.findIndex((line) => line.includes("SCRIPTED BACKEND"))
    const firstNumber = lines.findIndex((line) => line.startsWith("ARMS"))
    expect(banner).toBeGreaterThan(-1)
    expect(banner).toBeLessThan(firstNumber)
  })

  test("THE CALIBRATION STATES THERE IS NO CROSS-ARM LABELLED SET", () => {
    const rendered = text(report())
    expect(rendered).toContain("CROSS-ARM MATCHING IS UNMEASURED")
    expect(rendered).toContain("no cross-arm labelled set exists")
    expect(rendered).toContain("over-merge 1 of 3, under-merge 1 of 5")
  })
})

describe("every rate renders with its denominator", () => {
  test("NO BARE PERCENTAGE AND NO FLOAT APPEARS ANYWHERE", () => {
    // `28.6%` over a denominator of seven reads like a measurement and is not
    // one. `2 of 7` is a number a reader can weigh.
    const rendered = text(report())
    expect(rendered).not.toMatch(/\d%/)
    expect(rendered).not.toMatch(/\d\.\d/)
    expect(rendered).toContain("0 of 4 matched pair(s)")
  })

  test("THE BLOCK KEY'S SILENT VETO IS PRINTED AS A NUMBER", () => {
    const rendered = text(report())
    expect(rendered).toContain("40 cross-arm pair(s) of which 4 were vetoed by the block key")
    expect(rendered).toContain("never")
    expect(rendered).toContain("file-level")
  })

  test("`cap: null` renders as `none`, and a cap of 0 renders as 0", () => {
    expect(text(report())).toContain("cap none")
    const capped = report({ arms: [baseArm("a", { cost: { ...baseArm("a").cost, cap: 0 } })] })
    expect(text(capped)).toContain("cap 0")
  })

  test("an ABSENT counts block renders `—`, never `0`", () => {
    const rendered = text(report())
    expect(rendered).toContain("route: —")
    expect(rendered).toContain("debate: —")
    expect(rendered).toContain("judge: —")
  })
})

describe("AD-6 — a degraded arm is never indistinguishable from a good one", () => {
  test("the whole Warning object is printed, and no experimental line is drawn", () => {
    const degraded = report({
      anyScripted: false,
      arms: [
        baseArm("a", {
          provenance: "live",
          degradation: {
            degraded: true,
            budgetSkipped: 2,
            cancelledAt: "discover",
            warnings: [
              {
                code: "roster-underfilled",
                stage: "roster",
                message: "UNDERFILLED ROSTER: the exact sentence",
                detail: {},
              },
            ],
          },
        }),
      ],
    })
    const rendered = text(degraded)
    expect(rendered).toContain("DEGRADED")
    expect(rendered).toContain("[roster-underfilled] UNDERFILLED ROSTER: the exact sentence")
    expect(rendered).toContain("2 discovery slot(s) never asked (budget)")
    expect(rendered).toContain("cancelled during discover")
    // The three causes stay three, and the conclusion is withheld.
    expect(rendered).toContain("At least one arm was DEGRADED, so no conclusion is drawn")
  })

  test("a pairing with a degraded arm says so in its own confounders", () => {
    const rendered = text(
      report({
        pairings: [
          {
            ...report().pairings[0]!,
            confounders: {
              eitherDegraded: true,
              thresholdVacuousExceptCritical: false,
              dialsDiffer: [],
            },
          },
        ],
      }),
    )
    expect(rendered).toContain("one or both arms is DEGRADED — no conclusion is drawn")
  })

  test("DIALS THAT DIFFER ARE NAMED, so a difference is not read as roster-caused", () => {
    const rendered = text(
      report({
        pairings: [
          {
            ...report().pairings[0]!,
            confounders: {
              eitherDegraded: false,
              thresholdVacuousExceptCritical: false,
              dialsDiffer: ["threshold: 0.8 vs 0.5"],
            },
          },
        ],
      }),
    )
    expect(rendered).toContain("THESE ARMS DIFFER IN MORE THAN THE ROSTER")
    expect(rendered).toContain("threshold: 0.8 vs 0.5")
  })

  test("THE N=1 VACUITY IS STATED NARROWLY — it does not claim nothing debated", () => {
    const rendered = text(
      report({
        pairings: [
          {
            ...report().pairings[0]!,
            confounders: {
              eitherDegraded: false,
              thresholdVacuousExceptCritical: true,
              dialsDiffer: [],
            },
          },
        ],
      }),
    )
    expect(rendered).toContain("It is NOT true that nothing")
    expect(rendered).toContain("critical severity overrides the threshold")
    expect(rendered).not.toContain("nothing debated at all")
  })
})

describe("a NEGATIVE result renders as a RESULT, not as a failure", () => {
  test("debate changing no verdict is stated as a finding", () => {
    const rendered = text(report({ anyScripted: false, arms: [baseArm("a", { provenance: "live" })] }))
    expect(rendered).toContain("DEBATE CHANGED NO VERDICT IN THIS RUN")
    expect(rendered).toContain("That is a RESULT and not a")
    expect(rendered).not.toContain("FAILED")
  })

  test("LENSES FINDING NOTHING is stated as a finding, and names what follows from it", () => {
    const rendered = text(
      report({
        lens: {
          gain: {
            pool: { found: 7, total: 13 },
            lens: { found: 0, total: 13 },
            combined: { found: 7, total: 13 },
            lensOnlyDefects: [],
            beats: false,
          },
          cost: { tokens: 270, billedTurns: 9 },
        },
      }),
    )
    expect(rendered).toContain("LENSES FOUND NOTHING THE POOL DID NOT")
    expect(rendered).toContain("story 2A is deletable on this evidence")
  })

  test("a real lens gain names the defects it found", () => {
    const rendered = text(
      report({
        lens: {
          gain: {
            pool: { found: 7, total: 13 },
            lens: { found: 5, total: 13 },
            combined: { found: 11, total: 13 },
            lensOnlyDefects: [
              {
                id: "card-number-in-notice-log",
                dimension: "privacy-a11y",
                locus: { file: "x.ts", startLine: 1, endLine: 1 },
                summary: "s",
                markers: [],
              },
            ],
            beats: true,
          },
          cost: { tokens: 270, billedTurns: 9 },
        },
      }),
    )
    expect(rendered).toContain("pool 7 of 13 defect(s)")
    expect(rendered).toContain("found by a LENS and by no unlensed pool member: 1")
    expect(rendered).toContain("card-number-in-notice-log")
    expect(rendered).toContain("270 token(s) over 9 extra turn(s)")
    // AD-9 — the two are never divided into one.
    expect(rendered).toContain("This harness does not divide one by the other")
  })
})

describe("an UNKNOWN is never rendered as a zero", () => {
  test("no seeded defect set renders 'not applicable', and the other blocks still print", () => {
    const rendered = text(report())
    expect(rendered).toContain("not applicable — no seeded defect set")
    expect(rendered).toContain("Unknown is not zero")
    // The verdict-difference and token-cost blocks still print in full.
    expect(rendered).toContain("1. VERDICT DIFFERENCE")
    expect(rendered).toContain("2. TOKEN COST")
  })

  test("a live run with lenses but no labelled defects prints the cost and not a zero gain", () => {
    const rendered = text(
      report({ lens: { gain: undefined, cost: { tokens: 270, billedTurns: 9 } } }),
    )
    expect(rendered).toContain("gain: not applicable")
    expect(rendered).toContain("270 token(s) over 9 extra turn(s)")
  })
})

describe("repeats and the noise floor (code review 2026-09-06)", () => {
  test("AT ONE REPEAT THE NOISE FLOOR IS `NOT MEASURED`, never implied to be zero", () => {
    // A single run per arm cannot tell a real arm difference from run-to-run
    // variation. Saying nothing lets a reader assume it can.
    const rendered = text(report())
    expect(rendered).toContain("REPEATS: 1")
    expect(rendered).toContain("NOISE FLOOR: NOT MEASURED")
  })

  test("above one repeat the rows are LABELLED and the floor line changes", () => {
    const many = report({
      repeats: 3,
      arms: [baseArm("a", { repeat: 0 }), baseArm("a", { repeat: 1 })],
    })
    const rendered = text(many)
    expect(rendered).toContain("REPEATS: 3")
    expect(rendered).toContain("repeat=0")
    expect(rendered).toContain("repeat=1")
    expect(rendered).toContain("(repeat 1)")
    expect(rendered).not.toContain("NOISE FLOOR: NOT MEASURED")
  })

  test("at one repeat NO repeat label is printed — the number is noise when there is one row", () => {
    expect(text(report())).not.toContain("repeat=")
  })
})

describe("a zero or negative lens cost is not a price (code review 2026-09-06)", () => {
  test("IT SAYS SO, because beside a positive gain it reads as 'the lenses were free'", () => {
    const rendered = text(
      report({
        lens: {
          gain: {
            pool: { found: 7, total: 13 },
            lens: { found: 5, total: 13 },
            combined: { found: 11, total: 13 },
            lensOnlyDefects: [
              { id: "d-1", dimension: "tests", locus: { file: "x.ts" }, summary: "s", markers: [] },
            ],
            beats: true,
          },
          cost: { tokens: 0, billedTurns: 0 },
        },
      }),
    )
    expect(rendered).toContain("THIS IS NOT A PRICE")
    expect(rendered).toContain("what is shown is the cap and not what lenses cost")
  })

  test("a POSITIVE cost prints no such caveat", () => {
    const rendered = text(
      report({ lens: { gain: undefined, cost: { tokens: 270, billedTurns: 9 } } }),
    )
    expect(rendered).not.toContain("THIS IS NOT A PRICE")
  })
})
