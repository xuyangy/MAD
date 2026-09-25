/**
 * Story 2-5c — what an admitted, issued attempt cost, for the discover, debate
 * and judge stages alike.
 *
 * The ledger's order: the unknown marker first, else `tokens`, else unknown. A
 * request that went out and came back with no usage figure, or whose `runTurn`
 * threw, may have billed, so it is never settled as free. The figure is passed
 * through as the backend gave it; the admission implementation decides whether
 * it can count it.
 *
 * A `runTurn` that threw is settled `abandoned` (story 2-8c3a): the stage never
 * saw the request end, so it may still be held open, and an attempt-mode journal
 * stops on it. An envelope the backend returned, a transport error included,
 * ended, so it is not abandoned unless the backend said so.
 */

import type { AdmissionSettlement, AdmissionStage, AdmittedTurn, StepDecision } from "../ports/admission.ts"
import type { Envelope } from "../ports/model-backend.ts"

export function settlementOf(envelope: Envelope<unknown>, threw: boolean): AdmissionSettlement {
  if (envelope.usageUnknown) {
    return {
      kind: "unknown",
      why: envelope.usageUnknown.why,
      executionId: envelope.usageUnknown.executionId,
      ...(envelope.usageUnknown.abandoned === true ? { abandoned: true as const } : {}),
    }
  }
  if (envelope.tokens) return { kind: "usage", tokens: envelope.tokens }
  if (threw) return { kind: "unknown", why: "the backend threw after the request was issued", abandoned: true }
  return { kind: "unknown", why: "the backend reported no usage for an issued request" }
}

/**
 * Story 2-8c2 — an attempt's admission handle, with the stage's own ledger gate
 * asked before every later physical request.
 *
 * The experiment's gates live behind `turn.admitStep`; the run's ledger lives
 * only in the stage, so the stage closes over it here and a backend never has to
 * find it. A step the ledger refuses is refused before the experiment is asked,
 * so no journal line is written for it.
 *
 * The ledger records an attempt once, when it settles, so the steps already taken
 * in this attempt are not yet in what `mayISpend` reads. That is the overshoot
 * the ledger already documents for concurrent attempts, and it is the same here.
 */
export function stageGatedTurn(
  turn: AdmittedTurn | undefined,
  mayStep: () => boolean,
  stage: AdmissionStage,
): AdmittedTurn | undefined {
  if (turn === undefined) return undefined
  return {
    async admitStep(): Promise<StepDecision> {
      if (!mayStep()) {
        return {
          ok: false,
          cause: "budget",
          reason: `the run's own ledger refused a further ${stage} request inside this attempt`,
        }
      }
      return turn.admitStep()
    },
    settleFirst: (settlement) => turn.settleFirst(settlement),
  }
}
