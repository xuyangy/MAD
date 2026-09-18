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

import { inheritsAny } from "../core/budget/ledger.ts"
import type { AblationReport, ArmCost } from "./compare.ts"
import { countText, matcherText } from "./cross-arm-rates.ts"

function fraction(part: number, whole: number): string {
  return `${part} of ${whole}`
}

/** Whether an arm's run inherited any usage, counted or not. `ArmCost` sums its own tokens. */
function inherits(cost: ArmCost): boolean {
  return inheritsAny(cost.inherited)
}

/** The newly executed and inherited figures, printed only for an arm that inherited. */
function splitText(cost: ArmCost): string {
  if (!inherits(cost)) return ""
  const unknown = (count: number, label: string): string =>
    count > 0 ? `, ${count} ${label} unknown` : ""
  return (
    ` | NEWLY EXECUTED ${cost.newlyExecuted.tokens} over ${cost.newlyExecuted.turns} turn(s)` +
    `${unknown(cost.newlyExecuted.unknown, "newly executed")}` +
    ` | inherited ${cost.inherited.tokens} over ${cost.inherited.turns} turn(s)` +
    `${unknown(cost.inherited.unknown, "inherited")}`
  )
}

/**
 * How to add costs across arms when any of them inherited, in the words both
 * reports print. Exported because `ablation/read-bundle.ts` prints the same rule
 * over the same figures, and two wordings of one rule read as two rules.
 */
/**
 * The module that pairs a sealed paired bundle's arms, as both readers name it
 * in their own output.
 *
 * IT LIVES HERE, WITH `INHERITED_SUM_RULE`, FOR THAT CONSTANT'S REASON: two
 * reports say it, so it is written once. `read-bundle.ts` points a reader at the
 * paired report and `paired-read.ts` is the paired report, and a literal in each
 * would be two spellings of one file name — the one that goes stale silently
 * when the file is renamed, because a report's prose is not typechecked.
 * `ablation/report.ts` is the module both of them already import, and it imports
 * neither, so naming it here costs no cycle.
 */
export const PAIRED_READER_MODULE = "ablation/paired-read.ts"

/** The module that reads CAP-1 and CAP-11 from a labelled paired bundle, named here for the same reason. */
export const LABELLED_READER_MODULE = "ablation/labelled-read.ts"

/** The module that binds the human truth sheet and reports the four verdict directions, for the same reason. */
export const ADJUDICATION_READER_MODULE = "ablation/adjudication-read.ts"

/** The module that reads the sealed adversarial suite's two diagnostics, for the same reason. */
export const ADVERSARIAL_READER_MODULE = "ablation/adversarial-read.ts"

export const INHERITED_SUM_RULE = [
  "  An ATTRIBUTED figure counts an inherited prefix. Add NEWLY EXECUTED figures across arms, then",
  "  add each distinct INHERITED prefix once. Adding ATTRIBUTED figures counts a shared prefix twice.",
]

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
  // THE CROSS-ARM PARAGRAPH HAS TWO BRANCHES AND ONE RULE. `crossArmCalibration`
  // is present only when the reviewed change's diff hash equals the sealed
  // cross-arm set's recorded source diff (`cross-arm-rates.ts`). Absent, the
  // UNMEASURED disclosure prints, and it says no labelled set APPLIES to this
  // change — a set exists, it just does not describe this diff. Present, the
  // measured rates print with the set's identity and the matcher's, scoped to
  // this change and to the small hand-built case set they were counted on.
  // Both branches keep the one-for-one sentence and the within-run line.
  const cross = report.crossArmCalibration
  if (cross === undefined) {
    lines.push(
      "  CROSS-ARM MATCHING IS UNMEASURED. Two arms raise different findings, so they are aligned",
      "  by the shipped clustering matcher. Its error is measured ONLY on an 8-row, single-file,",
      "  WITHIN-run labelled set; no cross-arm labelled set applies to this change. That error enters",
      "  the difference count one for one — an over-merge invents a matched pair, an under-merge",
      "  hides a real one in `only in`.",
    )
  } else {
    const counts = cross.labelCounts
    lines.push(
      "  CROSS-ARM MATCHING IS MEASURED FOR THIS CHANGE ONLY. Two arms raise different findings, so",
      "  they are aligned by the shipped clustering matcher. This run reviewed the change a sealed,",
      `  hand-labelled cross-arm case set was drawn from. The rates below were counted offline on`,
      `  ${cross.samples} hand-built case(s) that cite this change's lines, NOT on this run's findings.`,
      "  Some cases were built so the matcher gets them wrong, the denominators are small, and the",
      "  rates carry over to no other change. That error enters the difference count one for one —",
      "  an over-merge invents a matched pair, an under-merge hides a real one in `only in`.",
      `  Cross-arm set: ${cross.version} (${cross.datasetHash}), ${cross.samples} case(s):` +
        ` equivalent ${counts.equivalent}, distinct ${counts.distinct},` +
        ` only-in-one-arm ${counts["only-in-one-arm"]}, ambiguous ${counts.ambiguous}.`,
      `  Matcher: ${matcherText(cross.matcher)}.`,
      `  Cross-arm calibration: over-merge ${countText(cross.overMerge.grouped, cross.overMerge.of)}` +
        ` (distinct and only-in-one-arm cases grouped), under-merge` +
        ` ${countText(cross.underMerge.ungrouped, cross.underMerge.of)} (equivalent cases not grouped);` +
        ` ${cross.ambiguousExcluded} ambiguous case(s) excluded from both` +
        ` (\`bun run cross-arm-rates\` names which cases it gets wrong).`,
    )
  }
  lines.push(
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
  // `execution: sequential` is a DISCLOSURE the constraints require, not a
  // setting (code review 2026-09-08). `runAblation` awaits each arm in turn, so
  // the behaviour was always right; without the line a reader cannot tell a
  // sequential run from an overlapped one, and overlap would put the arms in
  // contention for the same host and make every token figure a shared number.
  lines.push("ARMS (execution: sequential)")
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
      // OBSERVED, UNCONDITIONALLY (AC5, story 2.3). `ArmCost.tokens` is the
      // accountant's total and counts only the turns MAD could count; a turn
      // whose usage the host never reported is in `ledger.unknownUsage` and in no
      // figure on this line. `evaluation-protocol.md:511-517` requires the label
      // at the human-facing end and requires it unlabelled-means-nothing:
      // "a missing tag is not evidence of complete usage".
      `    tokens (${inherits(arm.cost) ? "attributed, " : ""}observed): ${arm.cost.tokens} over ` +
        `${arm.cost.billedTurns} billed turn(s), cap ${capText(arm.cost.cap)}` +
        ` | in ${arm.cost.input} / out ${arm.cost.output} / reasoning ${arm.cost.reasoning}` +
        ` / cache r ${arm.cost.cacheRead} w ${arm.cost.cacheWrite}` +
        splitText(arm.cost),
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
      // TWO COUNTS OVER TWO DIFFERENT SETS, said as two sentences (human
      // decision, 2026-09-08). Run together they read as one fraction —
      // `78 comparison(s) … 40 cross-arm pair(s)` looks like 78 out of 40 — and
      // neither number is a part of the other: `comparisons` counts the
      // similarity calls the engine billed over ALL pairs, within-arm included,
      // while `candidatePairs` counts the cross-arm pairs that existed to be
      // judged, vetoed ones included. Only `blockedPairs` is a subset, and it is
      // a subset of the cross-arm count, which is the sentence it now sits in.
      `    alignment: ${pairing.alignment.comparisons} similarity call(s) over all pairs, ` +
        `${pairing.alignment.failures} failure(s).`,
      `      cross-arm pairs, a DIFFERENT set and not a share of those calls: ` +
        `${pairing.alignment.candidatePairs}, of which ${pairing.alignment.blockedPairs} ` +
        `were vetoed by the block key before the matcher was asked.`,
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
  lines.push(
    "2. TOKEN COST — OBSERVED spend: a count of the tokens MAD could COUNT. Not divided by the",
  )
  lines.push(
    "   count above it, and not topped up for any turn whose usage the host never reported.",
  )
  for (const arm of report.arms) {
    const repeat = report.repeats > 1 ? ` (repeat ${arm.repeat})` : ""
    lines.push(
      `  ${arm.id}${repeat}: ${arm.cost.tokens} token(s) over ${arm.cost.billedTurns} billed turn(s)` +
        (inherits(arm.cost) ? ` ATTRIBUTED${splitText(arm.cost)}` : ""),
    )
  }
  if (report.arms.some((arm) => inherits(arm.cost))) {
    // AD-15 amended — a forked arm's figures include the prefix it inherited, so
    // summing two such arms counts that prefix twice. SUMMING NEWLY EXECUTED
    // FIGURES ALONE COUNTS IT ZERO TIMES: the prefix ran before the fork, so it
    // is inherited by every branch and newly executed by none, and the run that
    // executed it was consumed at the fork and writes no arm of its own. The
    // rule has to name both halves or it states a bill that is short by a whole
    // discovery pass (`evaluation-protocol.md` §4).
    lines.push(...INHERITED_SUM_RULE)
  }
  lines.push("")

  // ---- Lens gain and lens cost ----
  lines.push("3. LENS RECALL GAIN — a count of DEFECTS.")
  lines.push("4. LENS TOKEN COST — a count of TOKENS. These are two numbers (AD-9).")
  if (report.lens === undefined) {
    // THE REASON HAS TO BE TRUE ON BOTH PATHS. This branch is reached because no
    // lens arm ran, which is knowable here; whether the change carries a seeded
    // defect set is not, and asserting it does was false on a labelled run.
    lines.push(
      "  not applicable — this run had no lens arm, so there is no lens recall gain to measure.",
      "  Unknown is not zero and is not rendered as zero.",
    )
  } else {
    const gain = report.lens.gain
    if (gain === undefined) {
      // Recall is UNKNOWN here, and unknown is not zero and is not rendered as
      // zero. The report does not state WHY: on an unlabelled change nobody wrote
      // the bugs down, but on a labelled one the set exists and its thirteen loci
      // are written — so "no seeded defect set for this change" was a false clause
      // on the one path where the set is real. A persisted paired bundle is scored
      // against those labels by `ablation/labelled-read.ts`.
      lines.push(
        "  gain: not measured in this report. Unknown is not zero and is not rendered as zero.",
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
      `  cost: ${report.lens.cost.tokens} token(s) over ${report.lens.cost.billedTurns} extra turn(s)` +
        (report.arms.some((arm) => inherits(arm.cost))
          ? " — a difference of NEWLY EXECUTED figures, so no inherited prefix is inside it"
          : ""),
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
  // ALL FOUR "CANNOTS" ARE PRINTED, none corrected for (code review 2026-09-08).
  // Two of them — the noise floor and the matcher error — were already content
  // above. The other two were only ever in the story's Design Notes, which is
  // the one place a reader of the report cannot see: without them, the
  // control-vs-pool delta reads as debate's effect, which is exactly the
  // misreading this block exists to prevent.
  lines.push(
    "  DEBATE CANNOT BE ISOLATED. No arm turns debate off — the round cap floors at 1 — so no",
    "  number here is a debate-on minus debate-off difference.",
    "  LENSES CANNOT BE SEPARATED FROM FAN-OUT on a three-candidate host: the lens arm adds both",
    "  personas and turns at once, so a delta cannot be attributed to either alone.",
  )
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
      // THE DENOMINATOR IS NOT A POPULATION, and the line above must not be read
      // as one (ledger triage 2026-09-09). The pairings SHARE arms — three arms
      // make three pairings, so one arm's findings are counted in two of them —
      // and summing the pairings therefore counts the same finding more than
      // once. It is still the honest total of what was compared; it is not a
      // sample size, and a reader who takes it for one will read a rate off it.
      `  THE PAIRINGS SHARE ARMS, so this total counts a finding once per pairing it appears in.`,
      `  It is a sum over ${report.pairings.length} comparison(s), NOT a population — read the`,
      `  per-pairing lines above for the rates.`,
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
