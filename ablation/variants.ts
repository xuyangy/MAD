/**
 * The arms of the debate-variants design (`ablation/DEBATE-VARIANTS.md`): a
 * baseline and the two opt-in debate variants, each a continuation of the same
 * prepared review under the shipped routing policy. They differ only in the
 * two debate options `continueReview` takes.
 *
 * The mapping below is sealed into a debate-variants schedule's config and
 * checked against this table when the schedule is read or verified, so an arm
 * is identified by the options it runs with, not by its label alone.
 *
 * AD-1: this tree may import from `core/`. Nothing under `core/` imports it.
 */

import type { RoutingPolicy } from "../core/domain/run-record.ts"

/**
 * The id of the frozen protocol a debate-variants schedule binds. No routing
 * schedule may bind it, and a debate-variants schedule binds no other.
 */
export const VARIANT_PROTOCOL_ID = "PROTOCOL-mad-debate-variants"

export type VariantArm = "baseline" | "references" | "open-questions"

/** The arms, in the order their options are listed. */
export const VARIANT_ARMS: readonly VariantArm[] = ["baseline", "references", "open-questions"]

/** What one arm's continuation runs with. */
export interface VariantArmOptions {
  readonly policy: RoutingPolicy
  readonly debateReferences: boolean
  readonly debateMissingEvidence: boolean
}

export const VARIANT_ARM_OPTIONS: Readonly<Record<VariantArm, VariantArmOptions>> = {
  baseline: { policy: "shipped", debateReferences: false, debateMissingEvidence: false },
  references: { policy: "shipped", debateReferences: true, debateMissingEvidence: false },
  "open-questions": { policy: "shipped", debateReferences: false, debateMissingEvidence: true },
}

/** A fresh copy of the mapping, for sealing. */
export function variantArmOptions(): Record<VariantArm, VariantArmOptions> {
  return Object.fromEntries(VARIANT_ARMS.map((arm) => [arm, { ...VARIANT_ARM_OPTIONS[arm] }])) as Record<
    VariantArm,
    VariantArmOptions
  >
}
