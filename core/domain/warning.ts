/**
 * Degradation warnings (AD-6).
 *
 * Spine convention: warnings are structured values on the run record, raised by
 * the stage that detected them and rendered once at output — never
 * `console.log`ged from inside a stage.
 */

import type { Stage } from "./finding.ts"

export type WarningCode =
  /** AD-6c — the roster resolved to fewer distinct lineages than slots. */
  | "roster-single-lineage"
  /** AD-5 / AD-6c — a slot filled by a model the lineage table does not know. */
  | "roster-lineage-unverified"
  /** AD-6c — fewer candidates existed than slots requested, so slots went unfilled. */
  | "roster-underfilled"
  /**
   * AD-6e — every lens slot resolved to ONE model. Several personas over one
   * model share that model's blind spots. A separate fact from the lineage
   * report above, because lens slots never enter `distinctLineages` (AD-17c).
   */
  | "roster-lens-homogeneous"
  /** AD-6b — a model errored or timed out; one retry, then the run proceeds. */
  | "model-dropped-out"
  /** AD-6a — fewer models answered than were requested. */
  | "denominator-reduced"
  /** AD-12 — a model answered, but some items in its envelope failed validation. */
  | "partial-envelope"
  /** AD-3 — disclosure of the providers a run sends code to. */
  | "provider-fan-out"
  /** AD-6d — findings undecided when the budget ran out. */
  | "unresolved-findings"
  /**
   * AD-13 / AD-6 — a fact-check ran without tools, so nothing it says is
   * verified. Either no answering slot reported tool capability, or the checker
   * reported opening nothing. Raised by the judge, never by the adapter: tool
   * capability is READ per slot and the routing decision is the core's.
   */
  | "fact-check-untooled"
  /**
   * AD-6 — the judge stage could not run at all, because no POOL slot answered
   * discovery. Every finding therefore reaches output unadjudicated, and without
   * this a reader would see "not adjudicated" everywhere with no cause given —
   * a degraded review indistinguishable from an undecided one.
   */
  | "judge-unavailable"

export interface Warning {
  code: WarningCode
  /** The stage that detected it. */
  stage: Stage | "roster"
  /** Human-readable, already carrying every name the user needs to act. */
  message: string
  detail?: Record<string, unknown>
}
