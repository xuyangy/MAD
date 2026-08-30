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
