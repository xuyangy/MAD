/**
 * Plan item B6 — which configured reasoning variants the host's model list
 * advertised for the routes that actually issued requests.
 *
 * Pure: it reads the finished ledger and the host's candidates, and asks
 * nothing. For each stage with a configured variant, each slot that issued a
 * request in that stage (a counted ledger entry or an unknown-usage entry, so
 * pool and lens slots, dispatched replacements and whichever slots took a
 * judge role are all covered) gives one row, matched to its exact
 * provider/model route through `executionRoster`. A configured stage that
 * issued no request gives no row. Advertisement is all a row states: nothing
 * here shows that a host or provider applied a variant.
 *
 * A ledger with no unknown-usage collection (a record from before that
 * collection existed) cannot say which slots issued requests whose usage was
 * not counted, so the answer is `undefined`, never a partial list.
 */

import { executionRoster } from "../domain/recovery.ts"
import type { Candidate } from "../domain/roster.ts"
import type { RunRecord, VariantAvailabilityRow } from "../domain/run-record.ts"
import { usageIsAudited } from "../budget/ledger.ts"

const STAGES = ["discover", "debate", "judge"] as const

export function variantAvailability(
  record: Pick<RunRecord, "roster" | "recovery" | "ledger" | "reasoningVariants">,
  candidates: readonly Pick<Candidate, "providerId" | "modelId" | "variants">[],
): VariantAvailabilityRow[] | undefined {
  const configured = record.reasoningVariants
  if (configured === undefined) return []
  if (!usageIsAudited(record.ledger)) return undefined
  const roster = executionRoster(record)
  const routeOf = new Map(
    [...roster.slots, ...roster.lensSlots].map((slot) => [slot.slot, { providerId: slot.providerId, modelId: slot.modelId }]),
  )
  const issued = new Set<string>()
  for (const entry of [...record.ledger.entries, ...record.ledger.unknownUsage]) issued.add(`${entry.stage}\u0000${entry.slot}`)

  const rows: VariantAvailabilityRow[] = []
  for (const stage of STAGES) {
    const variant = configured[stage]
    if (variant === undefined) continue
    const slots = [...issued].filter((key) => key.startsWith(`${stage}\u0000`)).map((key) => key.slice(stage.length + 1))
    for (const slot of slots.sort()) {
      const route = routeOf.get(slot)
      if (route === undefined) continue
      const candidate = candidates.find((c) => c.providerId === route.providerId && c.modelId === route.modelId)
      const status: VariantAvailabilityRow["status"] =
        candidate?.variants === undefined ? "unknown" : candidate.variants.includes(variant) ? "advertised" : "not-advertised"
      rows.push({ stage, slot, providerId: route.providerId, modelId: route.modelId, variant, status })
    }
  }
  return rows
}

/**
 * B6 — the candidates' routes and advertised names, copied and frozen, so a
 * caller refreshing its own list during a run cannot change what the record
 * says was advertised. `undefined` stays `undefined`.
 */
export function snapshotCandidates(
  candidates: readonly Candidate[] | undefined,
): readonly Pick<Candidate, "providerId" | "modelId" | "variants">[] | undefined {
  if (candidates === undefined) return undefined
  return Object.freeze(
    candidates.map((c) =>
      Object.freeze({
        providerId: c.providerId,
        modelId: c.modelId,
        ...(c.variants === undefined ? {} : { variants: Object.freeze([...c.variants]) }),
      }),
    ),
  )
}
