#!/usr/bin/env bun
/**
 * The aligner's cross-arm error on the sealed case set, printed case by case:
 *
 *   bun run cross-arm-rates
 *
 * It prints the set's seal, the matcher's identity, every case's label, outcome
 * and `why`, and the two rates with numerator and denominator. It prints, it
 * does not gate: `ablation/cross-arm-rates.test.ts` is what fails CI. Scoring is
 * offline and deterministic, so running this bills nothing.
 *
 * The rates are counts over a small set of hand-built cases that cite one
 * change's lines, some built so the matcher gets them wrong. They are not a
 * measurement of any run's findings and carry over to no other change.
 */

import { countText, matcherText, measureCrossArm } from "../ablation/cross-arm-rates.ts"

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length)
}

export async function main(): Promise<number> {
  const { calibration, outcomes } = await measureCrossArm()

  console.log("Cross-arm calibration of the aligner over the sealed, hand-labelled case set")
  console.log("=".repeat(88))
  console.log(`set:          ${calibration.version}`)
  console.log(`dataset hash: ${calibration.datasetHash}`)
  console.log(
    calibration.sourceDiffHash === null
      ? "source diff:  none (unsealed set; these rates apply to no change)"
      : `source diff:  ${calibration.sourceDiffHash} (the only change these rates apply to)`,
  )
  console.log(`matcher:      ${matcherText(calibration.matcher)}`)
  console.log(
    `cases:        ${calibration.samples} — ` +
      Object.entries(calibration.labelCounts)
        .map(([label, count]) => `${label} ${count}`)
        .join(", "),
  )
  console.log("-".repeat(88))
  console.log(`${pad("case", 38)}${pad("label", 18)}${pad("aligner", 12)}agrees`)
  console.log("-".repeat(88))
  for (const o of outcomes) {
    console.log(
      pad(o.id, 38) +
        pad(o.label, 18) +
        pad(o.grouped ? "grouped" : "separate", 12) +
        (o.correct === undefined ? "— (ambiguous, excluded)" : o.correct ? "yes" : "NO"),
    )
  }
  console.log("-".repeat(88))
  // TWO COUNTS, NEVER FUSED. They fail in opposite directions and cost opposite things.
  console.log(
    `over-merge ${countText(calibration.overMerge.grouped, calibration.overMerge.of)}` +
      ` — distinct and only-in-one-arm cases grouped; each one invents a matched pair`,
  )
  console.log(
    `under-merge ${countText(calibration.underMerge.ungrouped, calibration.underMerge.of)}` +
      ` — equivalent cases not grouped; each one hides a real pair in \`only in\``,
  )
  console.log(`ambiguous: ${calibration.ambiguousExcluded} case(s), excluded from both denominators`)
  console.log(
    "Small hand-built denominators, some cases built to be wrong; these counts carry over to no other change.",
  )
  console.log("")

  for (const o of outcomes) {
    const verdict = o.correct === undefined ? "ambiguous" : o.correct ? "agrees" : "WRONG"
    console.log(`${o.id} [${o.label}, ${o.grouped ? "grouped" : "separate"}, ${verdict}]:`)
    console.log(`  ${o.why}`)
    console.log("")
  }
  return 0
}

// Only run (and only exit) when invoked as the CLI, so the reporter is testable.
if (import.meta.main) process.exit(await main())
