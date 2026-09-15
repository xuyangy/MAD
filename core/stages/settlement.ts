/**
 * Story 2-5c — what an admitted, issued attempt cost, for the discover, debate
 * and judge stages alike.
 *
 * The ledger's order: the unknown marker first, else `tokens`, else unknown. A
 * request that went out and came back with no usage figure, or whose `runTurn`
 * threw, may have billed, so it is never settled as free. The figure is passed
 * through as the backend gave it; the admission implementation decides whether
 * it can count it.
 */

import type { AdmissionSettlement } from "../ports/admission.ts"
import type { Envelope } from "../ports/model-backend.ts"

export function settlementOf(envelope: Envelope<unknown>, threw: boolean): AdmissionSettlement {
  if (envelope.usageUnknown) {
    return { kind: "unknown", why: envelope.usageUnknown.why, executionId: envelope.usageUnknown.executionId }
  }
  if (envelope.tokens) return { kind: "usage", tokens: envelope.tokens }
  return {
    kind: "unknown",
    why: threw ? "the backend threw after the request was issued" : "the backend reported no usage for an issued request",
  }
}
