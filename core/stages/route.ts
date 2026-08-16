/**
 * Stage 3 — ROUTE (CAP-3).
 *
 * The stage that SPENDS the prior story 3 computed. Every clustered finding
 * takes one of two paths: `debate` when it is contested, `judge` when it is not.
 * `cost-model.md` lever 2 is this decision — the threshold skip is the second
 * largest saving in the run, and the threshold itself is the paranoia dial story
 * 8's presets move: at `1` everything short of UNANIMITY is debated, at `0.5`
 * almost nothing is. (`cost-model.md` says "100% debates everything"; the
 * comparison is `>=`, so a `3/3` finding skips even at `1`. The document is
 * describing the dial's feel, not its boundary — the boundary is stated here.)
 *
 * Writes `route` and `routeReason`. Nothing else (AD-8).
 *
 * RUNS ONCE PER RUN. `route()` is not re-entrant: it appends an AD-7 history
 * entry unconditionally, so a second call over the same findings would leave two
 * `routed` entries and break the one-entry-per-finding contract the judge reads.
 * There is no guard, because a guard would silently half-apply a caller's second
 * intent rather than surface it; `review()` calls this exactly once.
 *
 * Two rules here look like details and are not:
 *
 * 1. **Severity is READ, never written** (AD-10). Routing DEPENDS on severity, so
 *    a stage that changed it would change what already happened. It is read
 *    through `effectiveSeverity`, the same accessor output renders, so a cluster
 *    that absorbed a member's `critical` is debated on that member's claim.
 * 2. **An absent prior is not a low one.** A lens finding has no fraction to
 *    compare because it was PROMPTED for its dimension (AD-17d) — it goes to the
 *    judge in verify-independently mode and its reason never mentions the
 *    threshold, because nothing was compared against it. A POOL finding with no
 *    prior means something failed or was skipped, which is the opposite fact and
 *    gets the opposite answer: more scrutiny, not less. Reading either as "below
 *    threshold" would smuggle back the zero-coercion AD-9 forbids — here it would
 *    change a DECISION, not merely an ordering.
 *
 * SKIPPING DEBATE IS NOT SKIPPING SCRUTINY. `route: 'judge'` MEANS the judge's
 * verify-independently mode (`pipeline-stages.md` §5): no transcript, so the
 * Fact-Checker alone, and the judge is the finding's first and only skeptic. A
 * `route: 'debate'` finding reaches the same judge afterwards in adjudicate mode.
 * The mode is DERIVED from `route` — a `judgeMode` field would be a third field
 * for this stage (AD-8 gives it two) and a second source of truth one rename away
 * from disagreeing with the first.
 */

import { appendEntry, effectiveSeverity, type Finding } from "../domain/finding.ts"
import { formatThreshold, type RouteCounts } from "../domain/run-record.ts"
import type { Clock } from "../ports/clock.ts"

/**
 * `pipeline-stages.md` §3 names ≥80% as the tunable's shape, and `cost-model.md`
 * reserves 100% and 50% for `paranoid` and `quick`. ONE value, so story 8 has one
 * dial to move rather than a policy to reimplement.
 */
export const DEFAULT_CO_DISCOVERY_THRESHOLD = 0.8

/**
 * A fraction, so `[0, 1]`. Exported so the bound is tested rather than trusted —
 * the pattern `clampDiscoverySlots` already sets in the adapter.
 *
 * Only ABSENT and NOT-A-NUMBER fall back to the default. Out-of-range values are
 * clamped rather than defaulted: `2` is an explicit request for "debate
 * everything" and lands on `1`, which is what the caller meant, instead of
 * quietly becoming `0.8`, which is not.
 *
 * The test is `typeof`, not `=== undefined`. `review()` is an exported seam and
 * TypeScript does not police a JavaScript caller: `null` would satisfy neither
 * `undefined` nor `Number.isNaN`, and `Math.max(null, 0)` is `0` — silently
 * turning "I passed nothing meaningful" into "debate nothing", the least
 * conservative dial there is. Anything that is not a number is absent.
 */
export function clampThreshold(threshold: number | undefined): number {
  if (typeof threshold !== "number" || Number.isNaN(threshold)) {
    return DEFAULT_CO_DISCOVERY_THRESHOLD
  }
  return Math.min(Math.max(threshold, 0), 1)
}

export interface RouteInput {
  /** The CANONICAL findings from clustering, in output order. Mutated in place (AD-7). */
  findings: Finding[]
  /** The paranoia dial. Defaulted and clamped; never read raw. */
  threshold?: number
  /**
   * A stage may hold a port; a stage that reached for `new Date()` would make its
   * own history entries untestable (AD-7's `Entry.at` is required). Same reasoning
   * as `ClusterInput.clock`.
   */
  clock: Clock
}

/**
 * `RouteCounts` verbatim, plus what was routed and the dial it was routed
 * against. The counts are the stage's own — `RunRecord.routeCounts` carries them
 * to the renderer so nothing downstream recomputes a partition over a narrower
 * set than the one that was decided.
 */
export interface RouteStageResult extends RouteCounts {
  /** The same array, routed in place. Routing PARTITIONS; it never filters. */
  findings: Finding[]
  /** The clamped value this run actually routed against. */
  threshold: number
}

/**
 * AD-9 — the comparison, computed HERE and never stored. Two things this must
 * not do:
 *
 * DIVIDE, do not cross-multiply. `raised / answered >= threshold` and
 * `raised >= threshold * answered` are equal in arithmetic and NOT equal in
 * doubles: at `threshold: 0.28` with `7/25`, the division form is `true` and the
 * cross-multiplied form is `false`, because `0.28 * 25` rounds to just above 7.
 * The disagreement is always AT the boundary — the one place CAP-3's criterion
 * lives — and the division form is the one that matches the written rule
 * ("co-discovery fraction ≥ threshold"), so it is the one that is right.
 *
 * AT OR ABOVE skips. `pipeline-stages.md` §3: "Co-discovery fraction ≥ threshold
 * → skip debate."
 */
function meetsThreshold(raised: number, answered: number, threshold: number): boolean {
  return raised / answered >= threshold
}

/**
 * WHY a finding took its route, not only where it went. The two judge buckets are
 * separate values because they are separate claims: `at-threshold` says a fraction
 * was compared and cleared the dial, `no-prior` says there was never a fraction to
 * compare (AD-17d). A summary that added them together and captioned the total
 * "at or above the threshold" would state the second as the first.
 */
type Bucket = "debate" | "judge-at-threshold" | "judge-no-prior"

/** The decision and the sentence that explains it, produced together so they cannot drift. */
function decide(
  finding: Finding,
  threshold: number,
): { route: "debate" | "judge"; bucket: Bucket; reason: string } {
  // 1. CAP-3 — critical overrides the threshold at ANY setting, including 0, and
  // for any `source`. A unanimous "remote code execution" claim is exactly the
  // one worth arguing. Read through `effectiveSeverity` (AD-10): a cluster that
  // absorbed a member's `critical` is critical, and `severity` stays unwritten.
  const severity = effectiveSeverity(finding)
  if (severity === "critical") {
    return {
      route: "debate",
      bucket: "debate",
      reason: `critical severity overrides the threshold (CAP-3) — debated at any setting`,
    }
  }

  // 2. AD-17d / `pipeline-stages.md` §3 — a lens finding has NO fraction to
  // compare. `source` is the discriminator, permanently, and the reason never
  // names the threshold because nothing was placed against it.
  if (finding.source === "lens") {
    return {
      route: "judge",
      bucket: "judge-no-prior",
      reason:
        `no co-discovery prior — lens-sourced (\`${finding.lens ?? "unnamed"}\`); ` +
        `judged verify-independently`,
    }
  }

  // 3. The threshold itself. `answered <= 0` is not a fraction — AD-6a makes the
  // denominator the honest half, and a zero one means nobody answered, which is
  // not evidence of anything.
  const co = finding.coDiscovery
  if (co && co.answered > 0) {
    const fraction = `${co.raised}/${co.answered}`
    if (meetsThreshold(co.raised, co.answered, threshold)) {
      return {
        route: "judge",
        bucket: "judge-at-threshold",
        reason:
          `co-discovery ${fraction} at or above threshold ${formatThreshold(threshold)} — ` +
          `debate skipped, judged verify-independently`,
      }
    }
    return {
      route: "debate",
      bucket: "debate",
      reason: `co-discovery ${fraction} below threshold ${formatThreshold(threshold)} — contested`,
    }
  }

  // 4. A POOL finding with no usable prior. Clustering did not run, or nobody
  // answered. CONSERVATIVE ON PURPOSE: debate is scrutiny, and skipping it on an
  // unexplained absence is the direction that loses a real bug. Said in words
  // rather than routed as "below threshold", which would be a different and false
  // claim about what was measured.
  const missing =
    co && co.answered <= 0
      ? "no model answered, so there is no denominator to divide by"
      : "no co-discovery prior recorded — clustering did not run"
  return { route: "debate", bucket: "debate", reason: `${missing}; treated as contested` }
}

/**
 * Synchronous — routing makes no model call, so an `async` signature would be a
 * promise nobody awaits for a reason.
 */
export function route(input: RouteInput): RouteStageResult {
  const { findings, clock } = input
  const threshold = clampThreshold(input.threshold)
  const at = clock.now()

  let toDebate = 0
  let toJudgeAtThreshold = 0
  let toJudgeNoPrior = 0

  for (const finding of findings) {
    const { route: decision, bucket, reason } = decide(finding, threshold)
    finding.route = decision
    finding.routeReason = reason
    if (bucket === "debate") toDebate += 1
    else if (bucket === "judge-at-threshold") toJudgeAtThreshold += 1
    else toJudgeNoPrior += 1

    // AD-7 — append-only. One entry per finding, so story 6's judge can read WHY
    // a finding arrived with or without a transcript.
    appendEntry(finding, { stage: "route", actor: "mad", at, kind: "routed", body: reason })
  }

  return {
    findings,
    threshold,
    toDebate,
    toJudge: toJudgeAtThreshold + toJudgeNoPrior,
    toJudgeAtThreshold,
    toJudgeNoPrior,
  }
}
