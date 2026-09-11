import { describe, expect, test } from "bun:test"

import { ALIGNER_MATCHER } from "./align.ts"
import type { AblationReport } from "./compare.ts"
import type { CrossArmCalibration } from "./cross-arm-rates.ts"
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

  test("THE CALIBRATION STATES THAT NO CROSS-ARM LABELLED SET APPLIES TO THIS CHANGE", () => {
    const rendered = text(report())
    expect(rendered).toContain("CROSS-ARM MATCHING IS UNMEASURED")
    expect(rendered).toContain("no cross-arm labelled set applies to this change")
    // A set exists in this repo, so the old sentence would be false on every unlabelled run.
    expect(rendered).not.toContain("no cross-arm labelled set exists")
    expect(rendered).toContain("over-merge 1 of 3, under-merge 1 of 5")
  })
})

/** A calibration shaped as `crossArmCalibrationFor` returns it. */
function crossArm(overrides: Partial<CrossArmCalibration> = {}): CrossArmCalibration {
  return {
    version: "cross-arm-pairs-1",
    datasetHash: "sha256:9d07db2dcd532642290f41c7d1ca38a2592caaa9fc7ad5c27873b1665e503786",
    sourceDiffHash: "sha256:cea5679939f5cb4ccd90230a4eddde861119f375ced04cad474fc2b0ec57e213",
    samples: 20,
    labelCounts: { equivalent: 7, distinct: 5, "only-in-one-arm": 4, ambiguous: 4 },
    matcher: ALIGNER_MATCHER,
    overMerge: { grouped: 3, of: 9 },
    underMerge: { ungrouped: 3, of: 7 },
    ambiguousExcluded: 4,
    ...overrides,
  }
}

describe("the cross-arm paragraph: UNMEASURED unless the run reviewed the labelled change", () => {
  const WITHIN_RUN_LINE =
    "  Matcher calibration, measured live this run: over-merge 1 of 3, under-merge 1 of 5 " +
    "(WITHIN-run set; `bun run clustering-rates` names which rows it gets wrong)."

  test("WITHOUT a cross-arm calibration the UNMEASURED paragraph is pinned byte for byte", () => {
    // Byte-identical to the paragraph before the cross-arm set existed, except the
    // one phrase the story's Spec Change Log names: "exists in this repo" became
    // "applies to this change".
    const lines = renderAblation(report())
    const start = lines.indexOf(
      "  CROSS-ARM MATCHING IS UNMEASURED. Two arms raise different findings, so they are aligned",
    )
    expect(start).toBeGreaterThan(-1)
    expect(lines.slice(start, start + 6)).toEqual([
      "  CROSS-ARM MATCHING IS UNMEASURED. Two arms raise different findings, so they are aligned",
      "  by the shipped clustering matcher. Its error is measured ONLY on an 8-row, single-file,",
      "  WITHIN-run labelled set; no cross-arm labelled set applies to this change. That error enters",
      "  the difference count one for one — an over-merge invents a matched pair, an under-merge",
      "  hides a real one in `only in`.",
      WITHIN_RUN_LINE,
    ])
    expect(lines.join("\n")).not.toContain("MEASURED FOR THIS CHANGE ONLY")
  })

  test("WITH one, the rates print with the set's and the matcher's identity, scoped to this change", () => {
    const rendered = text(report({ crossArmCalibration: crossArm() }))
    expect(rendered).not.toContain("CROSS-ARM MATCHING IS UNMEASURED")
    expect(rendered).not.toContain("no cross-arm labelled set applies to this change")
    expect(rendered).toContain("CROSS-ARM MATCHING IS MEASURED FOR THIS CHANGE ONLY")
    // The scope is stated as what it is: a count over a small hand-built set.
    expect(rendered).toContain("20 hand-built case(s) that cite this change's lines, NOT on this run's findings.")
    expect(rendered).toContain("Some cases were built so the matcher gets them wrong, the denominators are small")
    expect(rendered).toContain("rates carry over to no other change")
    expect(rendered).not.toContain("describe the matcher on THIS change")
    expect(rendered).toContain(
      "Cross-arm set: cross-arm-pairs-1 " +
        "(sha256:9d07db2dcd532642290f41c7d1ca38a2592caaa9fc7ad5c27873b1665e503786), 20 case(s): " +
        "equivalent 7, distinct 5, only-in-one-arm 4, ambiguous 4.",
    )
    expect(rendered).toContain(
      "Matcher: lexical-single-linkage-1 (line tolerance 8, overlap threshold 34/100, " +
        "block key file-basename, linkage single).",
    )
    expect(rendered).toContain("over-merge 3 of 9 (distinct and only-in-one-arm cases grouped)")
    expect(rendered).toContain("under-merge 3 of 7 (equivalent cases not grouped)")
    expect(rendered).toContain("4 ambiguous case(s) excluded from both")
  })

  test("both branches keep the one-for-one sentence and the within-run line", () => {
    for (const r of [report(), report({ crossArmCalibration: crossArm() })]) {
      const lines = renderAblation(r)
      expect(lines.join("\n").replace(/\n\s*/g, " ")).toContain("the difference count one for one")
      expect(lines).toContain(WITHIN_RUN_LINE)
    }
  })

  test("the measured branch prints no float and no percentage", () => {
    const rendered = text(report({ crossArmCalibration: crossArm() }))
    expect(rendered).not.toMatch(/\d%/)
    expect(rendered).not.toMatch(/\d\.\d/)
  })

  test("an EMPTY denominator renders `not measurable (0 cases)`, never `0 of 0`", () => {
    const rendered = text(
      report({
        crossArmCalibration: crossArm({
          labelCounts: { equivalent: 0, distinct: 5, "only-in-one-arm": 4, ambiguous: 4 },
          samples: 13,
          underMerge: { ungrouped: 0, of: 0 },
        }),
      }),
    )
    expect(rendered).toContain("under-merge not measurable (0 cases)")
    expect(rendered).not.toContain("0 of 0")
  })

  test("an injected matcher is named as injected, not as the shipped version", () => {
    const rendered = text(report({ crossArmCalibration: crossArm({ matcher: "injected" }) }))
    expect(rendered).toContain("Matcher: injected (not the shipped matcher; no version).")
    expect(rendered).not.toContain("lexical-single-linkage-1")
  })

  test("renderAblation still takes ONE argument", () => {
    expect(renderAblation).toHaveLength(1)
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
    // TWO SETS, TWO SENTENCES (human decision 2026-09-08). The counts used to run
    // together as `78 comparison(s) … 40 cross-arm pair(s)`, which reads as 78 out
    // of 40, and neither count is a share of the other.
    expect(rendered).toContain("78 similarity call(s) over all pairs")
    expect(rendered).toContain("a DIFFERENT set and not a share of those calls: 40")
    expect(rendered).toContain("of which 4 were vetoed by the block key")
    expect(rendered).not.toContain("78 comparison(s)")
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

describe("the headline total says it is NOT a population (ledger triage 2026-09-09)", () => {
  test("the shared-arm caveat sits with the number it qualifies", () => {
    // Three arms make three pairings and each arm appears in two of them, so
    // summing the pairings counts one finding more than once. The sum is still
    // the honest total of what was compared; it is not a sample size, and a
    // reader who takes it for one reads a rate off it.
    const three = report({
      anyScripted: false,
      arms: [baseArm("a"), baseArm("b"), baseArm("c")],
      pairings: [
        report().pairings[0]!,
        { ...report().pairings[0]!, a: "a", b: "c" },
        { ...report().pairings[0]!, a: "b", b: "c" },
      ],
    })
    const rendered = text(three)

    expect(rendered).toContain("Across every pairing,")
    expect(rendered).toContain("THE PAIRINGS SHARE ARMS")
    expect(rendered).toContain("It is a sum over 3 comparison(s), NOT a population")
  })

  test("the caveat rides with the headline and not with the scripted banner", () => {
    // Non-vacuous: a scripted run prints no headline total, so it must print no
    // caveat about one either.
    expect(text(report({ anyScripted: true }))).not.toContain("THE PAIRINGS SHARE ARMS")
  })
})

/**
 * AC5 (story 2.3) — the ablation report's token figures are OBSERVED spend, and
 * they say so.
 *
 * `ArmCost.tokens` is `ledger.total` and `ArmCost.billedTurns` is
 * `ledger.entries.length`, and since story 2.3 neither of those counts a turn
 * whose usage MAD could not establish — those live in `ledger.unknownUsage`, a
 * second collection, precisely so that no unknown can reach a total as a zero.
 * `evaluation-protocol.md:511-517` is explicit that the label is required at the
 * human-facing end: *"both need explicit labels … or the human-facing bill is
 * misleading while the JSON is correct"*, and *"a missing tag is not evidence of
 * complete usage"* is why the label is unconditional rather than printed only
 * when something is known to be missing.
 */
describe("AC5 — the token figures are labelled OBSERVED spend", () => {
  test("the per-arm line and the token-cost block both say observed", () => {
    const rendered = text(report())
    expect(rendered).toContain("tokens (observed)")
    expect(rendered).toContain("2. TOKEN COST — OBSERVED spend")
    // Not divided by anything, still (AD-9). Labelling the figure does not fuse it.
    expect(rendered).not.toContain("per token")
  })
})
