/**
 * The per-request admission seam (story 2-5c, `evaluation-protocol.md` §4).
 *
 * An evaluation must pass every billable request through gates the run's own
 * ledger cannot answer: a prefix or continuation allowance, an experiment
 * allowance, a global cap and an experiment-wide unknown-usage halt. The ledger
 * stays the one authority on "may this run spend?" (`mayISpend`); this port asks
 * the second question, "may the experiment issue this request?", and a stage asks
 * both, in that order, inside its per-attempt helper.
 *
 * OPTIONAL ON EVERY STAGE INPUT. Absent, a stage keeps its ordinary gate
 * placement and its record bytes are unchanged. Only an evaluation path supplies
 * one.
 *
 * ## The contract a stage relies on
 *
 * - `admit` never rejects. A refusal is a value, whatever its cause: an exhausted
 *   gate, a latched halt, or an implementation that could not persist the
 *   admission. The stage takes its budget-exhausted path for every cause and
 *   issues no retry.
 * - An `ok` admission is durable before it resolves: the request is recorded as
 *   issued before the stage may issue it.
 * - `settle` is called exactly once per admitted attempt and is awaited before
 *   the helper returns or retries. It never rejects. A persistence failure inside
 *   it is the implementation's to record, and it refuses every later admission.
 *   A repeat with an identical settlement is a no-op; a conflicting repeat is an
 *   integrity failure the implementation records.
 * - An `ok` admission may carry a `turn` handle (story 2-8c2). A stage passes it,
 *   wrapped in its own ledger gate, to `runTurn`, so a backend that meters
 *   physical requests can admit and settle each request after the first. Without
 *   one, the stage's settlement is the attempt's only settlement, as before.
 *
 * Types only; the one implementation is the paired runner's journal
 * (`ablation/journal.ts`).
 */

import type { TokenUsage } from "../domain/run-record.ts"

/** The three stages that issue billable requests. */
export type AdmissionStage = "discover" | "debate" | "judge"

/** One physical attempt a stage is about to issue. */
export interface AdmissionRequest {
  stage: AdmissionStage
  slot: string
  /** 1 for the first attempt, 2 for the one retry. */
  attempt: number
  /**
   * Story 2-8c2 — which physical request inside the attempt: absent for the
   * first, 2, 3, … for each later one (a host tool step). Only a `turn` handle
   * asks for a step.
   */
  step?: number
}

/**
 * What an admitted attempt came to.
 *
 * - `usage` — the envelope carried `tokens` and no unknown marker.
 * - `unknown` — the envelope carried `usageUnknown` (which wins when both are
 *   present), carried neither field, or `runTurn` threw. `executionId` is present
 *   only when the backend supplied one. `abandoned` is carried from the
 *   envelope's `usageUnknown`: the attempt did not end within its bound.
 * - `not-issued` — the signal had fired by the time admission resolved, so the
 *   stage never called `runTurn`. Nothing was billed.
 */
export type AdmissionSettlement =
  | { kind: "usage"; tokens: TokenUsage }
  | { kind: "unknown"; why: string; executionId?: string; abandoned?: true }
  | { kind: "not-issued" }

export type SettleRequest = (settlement: AdmissionSettlement) => Promise<void>

/**
 * Why a request was refused. A stage treats every cause alike; the cause exists
 * for the caller that reads the refusal back.
 *
 * - `budget` — an allowance or cap is exhausted.
 * - `halted` — the experiment's unknown-usage or integrity halt is latched.
 * - `runner-stop` — the implementation could not persist its journal, or the
 *   runner stopped admitting for another reason. Never a model's failure.
 */
export type AdmissionRefusalCause = "budget" | "halted" | "runner-stop"

export type AdmissionDecision =
  | { ok: true; settle: SettleRequest; turn?: AdmittedTurn }
  | { ok: false; cause: AdmissionRefusalCause; reason: string }

/** Story 2-8c2 — the answer for one physical request after an attempt's first. */
export type StepDecision =
  | { ok: true; step: number; settle: SettleRequest }
  | { ok: false; cause: AdmissionRefusalCause; reason: string }

/**
 * Story 2-8c2 — one admitted attempt, as a backend that meters its physical
 * requests sees it.
 *
 * - `admitStep` asks for the attempt's next physical request. It passes the same
 *   gates the attempt passed, in the same order: the stage's ledger gate (the
 *   stage wraps the handle with it), then the experiment's. It never rejects, and
 *   an `ok` step is durable before it resolves. The returned `settle` has the
 *   contract of an attempt's.
 * - `settleFirst` settles the attempt's first physical request with that
 *   request's own figure. Once it is called, the stage's later settlement of the
 *   attempt is a cross-check against the sum of the attempt's physical requests.
 *   It writes nothing and cannot change any request's state. It never rejects.
 */
export interface AdmittedTurn {
  admitStep(): Promise<StepDecision>
  settleFirst(settlement: AdmissionSettlement): Promise<void>
}

export interface RequestAdmission {
  admit(request: AdmissionRequest): Promise<AdmissionDecision>
}
