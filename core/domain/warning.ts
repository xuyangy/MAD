/**
 * Degradation warnings (AD-6).
 *
 * Spine convention: warnings are structured values on the run record, raised by
 * the stage that detected them and rendered once at output — never
 * `console.log`ged from inside a stage.
 */

import type { Stage } from "./finding.ts"

/**
 * The vocabulary, as a runtime LIST rather than a bare type union.
 *
 * The union came first and could not be counted, so nothing could pin it: a code
 * added here reached the renderer's disclosure/degradation split with no reader
 * ever deciding which side it belonged on. The list is the shape `SEVERITIES`
 * and `DEBATE_POSITIONS` already use in this codebase, and it lets
 * `warning.test.ts` pin the count the way `material.test.ts` pins the span
 * labels — so a new code forces somebody to come back and classify it.
 */
export const WARNING_CODES = [
  /** AD-6c — the roster resolved to fewer distinct lineages than slots. */
  "roster-single-lineage",
  /** AD-5 / AD-6c — a slot filled by a model the lineage table does not know. */
  "roster-lineage-unverified",
  /** AD-6c — fewer candidates existed than slots requested, so slots went unfilled. */
  "roster-underfilled",
  /**
   * AD-6e — every lens slot resolved to ONE model. Several personas over one
   * model share that model's blind spots. A separate fact from the lineage
   * report above, because lens slots never enter `distinctLineages` (AD-17c).
   */
  "roster-lens-homogeneous",
  /** AD-6b — a model errored or timed out; one retry, then the run proceeds. */
  "model-dropped-out",
  /** AD-6a — fewer models answered than were requested. */
  "denominator-reduced",
  /** AD-12 — a model answered, but some items in its envelope failed validation. */
  "partial-envelope",
  /** AD-3 — disclosure of the providers a run sends code to. */
  "provider-fan-out",
  /** AD-6d — findings undecided when the budget ran out. */
  "unresolved-findings",
  /**
   * AD-13 / AD-6 — a fact-check ran without tools, so nothing it says is
   * verified. Either no answering slot reported tool capability, or the checker
   * reported opening nothing. Raised by the judge, never by the adapter: tool
   * capability is READ per slot and the routing decision is the core's.
   */
  "fact-check-untooled",
  /**
   * AD-6 — the judge stage could not run at all, because no POOL slot answered
   * discovery. Every finding therefore reaches output unadjudicated, and without
   * this a reader would see "not adjudicated" everywhere with no cause given —
   * a degraded review indistinguishable from an undecided one.
   */
  "judge-unavailable",
  /**
   * AD-6f (story 7A) — THE USER STOPPED THE RUN.
   *
   * The sixth report, and a degradation rather than a disclosure: a stopped run
   * is a PARTIAL run, which is precisely what AD-6 governs. Stories 2A, 3 and 4
   * each declined a sixth code on the recorded ground that a clamp or a route is
   * a decision rather than a partial run; a cancellation is not that, so the
   * `Ask First` is answered here rather than declined a fourth time.
   *
   * It is raised ONCE per run, by `core/run/review.ts`, naming the stage the run
   * stopped at — a fact about the run, which no single stage is in a position to
   * state. It is NOT `model-dropped-out`: no model failed, and the findings it
   * strands carry a cancellation reason that a reader can tell apart from
   * `unresolved-findings`' budget reason. "We ran out of money" and "you pressed
   * stop" are different facts, and neither is "we finished".
   */
  "run-cancelled",
  /**
   * AD-6a / AD-15 (story 8) — THE BUDGET TRUNCATED DISCOVERY.
   *
   * The seventh report, and a degradation for `run-cancelled`'s reason exactly:
   * a roster MAD chose not to finish asking is a PARTIAL run, which is what AD-6
   * governs. Stories 2A, 3 and 4 each declined a new code because a clamp or a
   * route is a decision rather than a partial run; this is not that.
   *
   * IT IS NEITHER OF ITS TWO NEIGHBOURS, and the whole reason it exists is that
   * folding it into either one would be a false report:
   *
   * - NOT `model-dropped-out`. No model failed and no model was even asked.
   *   Naming a provider here would blame a working model for the user's own
   *   budget, which is the exact class of dishonesty this tool is built against.
   * - NOT `unresolved-findings`. That is AD-6d, raised over findings that exist
   *   and were left undecided. At the point discovery is truncated there are no
   *   findings yet to strand — the loss is recall, not adjudication.
   *
   * It sits BESIDE `denominator-reduced` rather than inside it: that code says
   * the denominator shrank, this one says the budget is why. A host agent
   * reading only codes can then tell a budget-truncated roster from an
   * under-delivering one, which is the whole argument for a code over a sentence.
   *
   * Raised ONCE per run, by `core/stages/discover.ts`, naming how many pool and
   * lens slots went unasked and the discovery ceiling that refused them.
   */
  "discovery-truncated",
  /**
   * AD-3 amended / AD-6c (story 8A) — A PIN THE RUN COULD NOT HONOUR.
   *
   * The fourteenth code, and it exists because NO EXISTING CODE CAN CARRY THE
   * FACT WITHOUT LYING. AD-3's amendment requires a pin the host does not offer
   * to be reported and its slot to fall through to ranking — and when ranking
   * backfills that slot the roster comes out FULL, so `roster-underfilled` does
   * not fire at all. If it were made to fire, its message ("the host offers only
   * N distinct model(s)... add a provider") would be false twice over: the host
   * may offer plenty, and adding a provider is not the fix for a misspelled pin.
   * `provider-fan-out` is a disclosure and would file a request MAD could not
   * honour as a fact about configuration.
   *
   * Stories 2A, 3 and 4 each declined a new code on the recorded ground that a
   * clamp or a route is a decision rather than a partial run. A pin that named a
   * model the run then did not use is not that: the caller asked for a specific
   * roster and got a different one, which is a fact about what was reviewed.
   *
   * IT IS ABOUT THE PIN AND NEVER ABOUT THE ROSTER'S QUALITY. It carries a
   * per-pin reason — `not-offered`, `dedupe-collapsed`, `no-slot`, `malformed` —
   * and says nothing about diversity, because the four AD-6c reports already say
   * everything there is to say about that and say it identically whether a slot
   * was pinned or ranked. In particular it must never grow a sentence like "you
   * pinned these, so adding a provider will not help": that is false whenever
   * fewer pins than slots were given, and it is the "the user asked for it"
   * suppression AD-4's amendment forbids, wearing a remedy note as a disguise.
   *
   * Raised ONCE per run, by `core/roster/select.ts`, and only when pins were
   * supplied and at least one was not honoured.
   */
  "roster-pin-unhonoured",
] as const

export type WarningCode = (typeof WARNING_CODES)[number]

/**
 * The codes that are a DISCLOSURE rather than a degradation (story 7).
 *
 * A disclosure states a fact about how the run was configured; a degradation
 * says the run is worth less than it looks. Rendering them alike would put
 * "these are the providers your code was sent to" under a heading reading
 * "this run is degraded", which is AD-6's honesty rule pointed the wrong way.
 *
 * IT LIVES HERE, WITH THE VOCABULARY, and not as a `!== "provider-fan-out"` test
 * in `core/stages/output.ts`. A denylist in the renderer is a second, invisible
 * place the vocabulary is defined: a code added to the list above lands in the
 * degradation bucket whether or not that is what it means, and nobody editing
 * this file would see the renderer at all. Being listed here is what makes a
 * code a disclosure; anything unlisted is a degradation, which is the safe
 * default — over-reporting a degradation is noise, under-reporting one is the
 * failure AD-6 exists to prevent.
 */
export const DISCLOSURE_CODES: ReadonlySet<WarningCode> = new Set<WarningCode>([
  /** AD-3 — which providers a run sends code to. A fact, not a fault. */
  "provider-fan-out",
])

export interface Warning {
  code: WarningCode
  /** The stage that detected it. */
  stage: Stage | "roster"
  /** Human-readable, already carrying every name the user needs to act. */
  message: string
  detail?: Record<string, unknown>
}
