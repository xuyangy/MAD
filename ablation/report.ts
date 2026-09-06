/**
 * CAP-9's report — and the single most important thing this story ships is not a
 * number, it is what sits above the numbers.
 *
 * ## The limitations are CONTENT, not commentary
 *
 * `survey-grounding.md` says nobody has run this comparison, which makes this
 * output the kind of thing somebody might cite. Under the scripted backend CI is
 * limited to, `DEFAULT_JUDGE_ANSWERS.aggregate` returns `upheld` unconditionally
 * and `FakeBackend` bills a constant 10 in / 20 out per turn — so the
 * verdict-difference column **can only be zero** and the token column is a turn
 * count wearing a token costume. A report that printed those two numbers without
 * saying so would be the exact overstatement this capability exists to prevent,
 * and it would be worse than no harness at all, because it would look like
 * evidence.
 *
 * The scripted banner therefore has NO suppression option. Not a default that
 * can be flipped, not a `--quiet`: there is no parameter that removes it, so a
 * future caller cannot quietly produce a clean-looking table.
 *
 * ## Every rate carries its denominator
 *
 * No bare percentage and no float appears anywhere in this output. `2 of 7` is
 * a number a reader can weigh; `28.6%` over a denominator of seven is a number
 * that reads like a measurement and is not one. It is the same rule
 * `clustering-rates` already follows, and `output.ts` follows for co-discovery.
 *
 * ## A negative result renders as a RESULT
 *
 * "Debate changed no verdict at this cost" and "lenses found nothing the pool
 * did not" are the findings this experiment exists to be able to report. They
 * are printed as conclusions in their own right, not as an absence, not as a
 * failure, and nothing here returns non-zero because of them.
 *
 * Pure line building: it returns `string[]` so the format is unit-testable, and
 * `scripts/ablation.ts` is the only thing that prints.
 */

import type { AblationReport } from "./compare.ts"

function fraction(part: number, whole: number): string {
  return `${part} of ${whole}`
}

/** `null` is `none`. A cap of `0` is a real ceiling and must not read as absence. */
function capText(cap: number | null): string {
  return cap === null ? "none" : String(cap)
}

/** An absent counts block is `—`, never `0`: "did not run" is not "ran and found nothing". */
function countsText(counts: unknown): string {
  return counts === undefined ? "—" : JSON.stringify(counts)
}

export function renderAblation(report: AblationReport): string[] {
  const lines: string[] = []

  lines.push("CAP-9 — ABLATION: the same change, three rosters, four separate numbers.")
  lines.push("")

  // ---- The limitations, ABOVE the numbers ----
  lines.push("LIMITATIONS — read these before the tables.")
  if (report.anyScripted) {
    lines.push(
      "  SCRIPTED BACKEND. At least one arm ran against `FakeBackend`, which bills a CONSTANT",
      "  10 in / 20 out per turn and whose judge returns `upheld` unconditionally. In a scripted",
      "  run the verdict-difference column CAN ONLY BE ZERO and the token column is a turn count",
      "  in token clothing. A scripted run proves the harness works. It measures nothing about",
      "  whether debate is worth its bill — for that, run a live arm (see ablation/LIVE-RUN.md).",
    )
  }
  lines.push(
    "  CROSS-ARM MATCHING IS UNMEASURED. Two arms raise different findings, so they are aligned",
    "  by the shipped clustering matcher. Its error is measured ONLY on an 8-row, single-file,",
    "  WITHIN-run labelled set; no cross-arm labelled set exists in this repo. That error enters",
    "  the difference count one for one — an over-merge invents a matched pair, an under-merge",
    "  hides a real one in `only in`.",
    `  Matcher calibration, measured live this run: over-merge ` +
      `${fraction(report.matcherCalibration.overMerge.merged, report.matcherCalibration.overMerge.of)}` +
      `, under-merge ` +
      `${fraction(report.matcherCalibration.underMerge.unmerged, report.matcherCalibration.underMerge.of)}` +
      ` (WITHIN-run set; \`bun run clustering-rates\` names which rows it gets wrong).`,
    "  BLOCK-KEY VETO. The matcher never compares two findings in different files, and never",
    "  compares a file-level finding with a line-cited one. Both counts are printed below.",
    `  REPEATS: ${report.repeats}. NOISE FLOOR: ${
      report.repeats > 1
        ? "compare the spread between repeats of the SAME arm against the difference between arms"
        : "NOT MEASURED — one run per arm cannot tell a real arm difference from run-to-run variation"
    }.`,
  )
  lines.push("")

  // ---- Arms ----
  lines.push("ARMS")
  for (const arm of report.arms) {
    // Labelled whenever more than one repeat ran. Without it `--repeats 3` printed
    // three identical unlabelled blocks per arm (code review 2026-09-06).
    const repeat = report.repeats > 1 ? ` repeat=${arm.repeat}` : ""
    const pins = arm.pinned.length > 0 ? ` pinned=${arm.pinned.join(",")}` : ""
    const lenses = arm.lenses.length > 0 ? ` lenses=${arm.lenses.join(",")}` : " lenses=none"
    lines.push(
      `  ${arm.id} (${arm.label}) [${arm.provenance}]${repeat} slots=${arm.slots}${lenses}${pins}`,
      `    answered: ${arm.answered} | canonical findings: ${arm.findings} | pooled: ${arm.pooled}` +
        ` | file-level (never alignable with a line-cited finding): ${arm.fileLevel}`,
      `    tokens: ${arm.cost.tokens} over ${arm.cost.billedTurns} billed turn(s), cap ${capText(arm.cost.cap)}` +
        ` | in ${arm.cost.input} / out ${arm.cost.output} / reasoning ${arm.cost.reasoning}` +
        ` / cache r ${arm.cost.cacheRead} w ${arm.cost.cacheWrite}`,
      `    route: ${countsText(arm.routeCounts)}`,
      `    debate: ${countsText(arm.debateCounts)}`,
      `    judge: ${countsText(arm.judgeCounts)}`,
    )
    if (arm.degradation.degraded) {
      // AD-6 — a degraded arm is never indistinguishable from a good one, and no
      // experimental line is drawn from it below.
      lines.push(
        `    DEGRADED — this arm's own run was partial, so it is not a clean measurement:`,
      )
      if (arm.degradation.cancelledAt !== undefined) {
        lines.push(`      cancelled during ${arm.degradation.cancelledAt}`)
      }
      if (arm.degradation.budgetSkipped > 0) {
        lines.push(`      ${arm.degradation.budgetSkipped} discovery slot(s) never asked (budget)`)
      }
      for (const warning of arm.degradation.warnings) {
        lines.push(`      [${warning.code}] ${warning.message}`)
      }
    }
    lines.push("")
  }

  // ---- Verdict difference, per pairing ----
  lines.push("1. VERDICT DIFFERENCE — a count of findings. Never divided by anything below it.")
  for (const pairing of report.pairings) {
    const d = pairing.difference
    lines.push(
      `  ${pairing.a} vs ${pairing.b}: ${fraction(d.differing, d.of)} matched pair(s) carry` +
        ` different decisions.`,
      `    undecided (either side unresolved or unjudged, in NEITHER half): ${d.undecided}`,
      `    only in ${pairing.a}: ${d.onlyIn.a} | only in ${pairing.b}: ${d.onlyIn.b}` +
        ` | ambiguous groups excluded: ${d.ambiguous}`,
      `    alignment: ${pairing.alignment.comparisons} comparison(s), ` +
        `${pairing.alignment.failures} failure(s), ${pairing.alignment.candidatePairs} cross-arm ` +
        `pair(s) of which ${pairing.alignment.blockedPairs} were vetoed by the block key ` +
        `before the matcher was asked.`,
    )
    for (const difference of d.differences) {
      lines.push(
        `      ${difference.a.id} (${difference.aState}) vs ${difference.b.id} (${difference.bState})`,
      )
    }
    const c = pairing.confounders
    lines.push(`    CONFOUNDERS for this pairing:`)
    if (c.eitherDegraded) {
      lines.push(`      one or both arms is DEGRADED — no conclusion is drawn from this pairing.`)
    }
    if (c.thresholdVacuousExceptCritical) {
      lines.push(
        `      an arm answered with ONE model, so the co-discovery threshold cannot route on its`,
        `      own (a lone finding is 1/1 and meets every setting). It is NOT true that nothing`,
        `      debated: critical severity overrides the threshold at any setting.`,
      )
    }
    if (c.dialsDiffer.length > 0) {
      lines.push(
        `      THESE ARMS DIFFER IN MORE THAN THE ROSTER, so the difference above is not`,
        `      attributable to the roster alone: ${c.dialsDiffer.join("; ")}`,
      )
    } else {
      lines.push(`      dials equal across both arms (threshold, round cap, token cap, peak).`)
    }
    lines.push("")
  }

  // ---- Token cost ----
  lines.push("2. TOKEN COST — a count of tokens. Not divided by the count above it.")
  for (const arm of report.arms) {
    const repeat = report.repeats > 1 ? ` (repeat ${arm.repeat})` : ""
    lines.push(
      `  ${arm.id}${repeat}: ${arm.cost.tokens} token(s) over ${arm.cost.billedTurns} billed turn(s)`,
    )
  }
  lines.push("")

  // ---- Lens gain and lens cost ----
  lines.push("3. LENS RECALL GAIN — a count of DEFECTS.")
  lines.push("4. LENS TOKEN COST — a count of TOKENS. These are two numbers (AD-9).")
  if (report.lens === undefined) {
    lines.push(
      "  not applicable — no seeded defect set for this change, so recall is UNKNOWN.",
      "  Unknown is not zero and is not rendered as zero.",
    )
  } else {
    const gain = report.lens.gain
    if (gain === undefined) {
      // A live change has no LABELLED defect set — nobody wrote down its bugs —
      // so recall is UNKNOWN. Unknown is not zero and is not rendered as zero.
      lines.push(
        "  gain: not applicable — no seeded defect set for this change, so recall is UNKNOWN.",
      )
    } else {
      lines.push(
        `  gain: pool ${fraction(gain.pool.found, gain.pool.total)} defect(s) | ` +
          `lens alone ${fraction(gain.lens.found, gain.lens.total)} | ` +
          `combined ${fraction(gain.combined.found, gain.combined.total)}`,
        `  found by a LENS and by no unlensed pool member: ${gain.lensOnlyDefects.length}` +
          (gain.lensOnlyDefects.length === 0
            ? ""
            : ` (${gain.lensOnlyDefects.map((defect) => defect.id).join(", ")})`),
      )
      if (gain.lensOnlyDefects.length === 0) {
        lines.push(
          "  LENSES FOUND NOTHING THE POOL DID NOT, at the token cost below. That is a RESULT:",
          "  story 2A is deletable on this evidence, which is what the two-tier design is for.",
        )
      }
    }
    lines.push(
      `  cost: ${report.lens.cost.tokens} token(s) over ${report.lens.cost.billedTurns} extra turn(s)`,
    )
    if (report.lens.cost.tokens <= 0) {
      // A DIFFERENCE OF LEDGERS, NOT A PRICE. Under a shared cap both arms can be
      // cut off at the same ceiling, so the lensed arm's total is not higher and
      // the subtraction goes to zero or below. Printed alone it reads as "the
      // lenses were free" — beside a POSITIVE gain (code review 2026-09-06).
      lines.push(
        "  THIS IS NOT A PRICE. The lens cost is one arm's ledger minus another's, and both arms",
        "  hit the same ceiling here, so what is shown is the cap and not what lenses cost.",
        "  Re-run with a higher cap, or with none, to measure it.",
      )
    }
    lines.push(
      "  Whether that many defects is worth that many tokens is the READER's judgement.",
      "  This harness does not divide one by the other and reports no combined score.",
    )
  }
  lines.push("")

  // ---- What this run does and does not support ----
  lines.push("READ AS AN EXPERIMENT")
  const anyDegraded = report.arms.some((arm) => arm.degradation.degraded)
  if (report.anyScripted) {
    lines.push(
      "  This run used a scripted backend, so NO conclusion about debate's value follows from it.",
      "  To conclude anything, all of the following would have to be true: every arm live; enough",
      "  repeats to establish a noise floor; a cross-arm matcher whose error is measured on a",
      "  labelled cross-arm set; and arms differing only in the roster.",
    )
  } else if (anyDegraded) {
    lines.push(
      "  At least one arm was DEGRADED, so no conclusion is drawn. Re-run with a clean roster.",
    )
  } else {
    const total = report.pairings.reduce((sum, p) => sum + p.difference.differing, 0)
    const compared = report.pairings.reduce((sum, p) => sum + p.difference.of, 0)
    lines.push(
      `  Across every pairing, ${fraction(total, compared)} matched pair(s) carried a different`,
      `  decision, at the token costs listed above. This is the run's own number and not a verdict`,
      `  on the design: what it supports depends on the repeats, the sample and the matcher error`,
      `  stated at the top of this report.`,
    )
    if (total === 0) {
      lines.push(
        "  DEBATE CHANGED NO VERDICT IN THIS RUN, at the cost listed. That is a RESULT and not a",
        "  failure — CAP-9 exists to be able to report it.",
      )
    }
  }

  return lines
}
