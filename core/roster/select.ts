/**
 * AD-4 — roster selection is dedupe THEN rank, in that order.
 *
 * (1) Dedupe candidates by normalized model identity — family plus version,
 *     snapshot date stripped — so one model never occupies two slots regardless
 *     of how many providers reach it.
 * (2) Rank, filling slots to maximize distinct lineages first, then distinct
 *     models within a lineage.
 *
 * Getting the order wrong is the single most damaging thing this system can do:
 * every co-discovery number downstream inherits the error.
 *
 * AD-6c is raised here — the roster warning is the stage that detected it. So is
 * AD-6e, the lens-homogeneity report (CAP-11).
 *
 * AD-4 amended (CAP-11): lens slots fill AFTER the pool, from the same deduped
 * list, into `Roster.lensSlots`. They may reuse a model the pool already holds —
 * a lens slot claims no diversity, so reuse costs nothing dedupe was protecting
 * — and they never reach `distinctLineages` (AD-17c). Not by a filter: by there
 * being no array that holds both kinds of slot.
 */

import { lineageOf, normalizeModelIdentity, UNVERIFIED_LINEAGE } from "../domain/lineage.ts"
import type { Candidate, LensSlot, Roster, RosterSlot } from "../domain/roster.ts"
import type { Warning } from "../domain/warning.ts"

/**
 * The host config key a user edits to add a provider. Named in the AD-6c
 * warning so the warning is actionable rather than decorative.
 *
 * This is host-shaped, so the caller supplies it (AD-1: no opencode knowledge
 * in the core). The adapter passes opencode's key.
 */
export interface SelectOptions {
  slots: number
  /** e.g. `provider` in opencode.json — named verbatim in the AD-6c warning. */
  providerConfigKey: string
  /** Slot id prefix; `discovery` yields `discovery-1`, `discovery-2`, ... */
  slotPrefix?: string
  /**
   * CAP-11 — ordered lens ids, one lens slot each. Absent or empty means NO
   * lens slots and byte-for-byte the behaviour story 2 shipped (AD-3, AD-15
   * amended: lenses are off by default and a fresh install's cost is unchanged
   * by this capability's existence).
   */
  lenses?: readonly string[]
}

export interface SelectResult {
  roster: Roster
  warnings: Warning[]
}

/** Thrown when the host offers nothing at all — unusable host state, not a domain outcome. */
export class NoCandidatesError extends Error {
  constructor(providerConfigKey: string) {
    super(
      `No models are available from the host, so there is nothing to review with. ` +
        `Configure at least one provider in your opencode config (the \`${providerConfigKey}\` key) ` +
        `or authenticate one with \`opencode auth login\`, then run the review again. ` +
        `MAD holds no credentials and names no model of its own.`,
    )
    this.name = "NoCandidatesError"
  }
}

export interface Deduped {
  candidate: Candidate
  identity: string
  alsoAvailableVia: string[]
}

/**
 * AD-4 step 1. Order is preserved from the input, so the caller's preference
 * ordering survives; the first provider seen for an identity wins the slot and
 * the rest are recorded as `alsoAvailableVia` for disclosure.
 */
export function dedupeByIdentity(candidates: readonly Candidate[]): Deduped[] {
  const byIdentity = new Map<string, Deduped>()
  for (const candidate of candidates) {
    const identity = normalizeModelIdentity(candidate.modelId)
    const existing = byIdentity.get(identity)
    if (existing) {
      // Same model, second provider: it never occupies a second slot (AD-4).
      if (!existing.alsoAvailableVia.includes(candidate.providerId)) {
        existing.alsoAvailableVia.push(candidate.providerId)
      }
      continue
    }
    byIdentity.set(identity, { candidate, identity, alsoAvailableVia: [] })
  }
  return [...byIdentity.values()]
}

/**
 * AD-4 step 2 + AD-5. Round-robin across lineages: one model per lineage before
 * any lineage gets a second. Unverified models are ranked last and grouped into
 * one bucket, because an unrecognized model is never counted as a fresh lineage
 * — grouping them is what stops N unknowns from looking like N lineages.
 */
export function rankByDiversity(deduped: readonly Deduped[], slots: number): Deduped[] {
  const verified = new Map<string, Deduped[]>()
  const unverified: Deduped[] = []

  for (const entry of deduped) {
    const claim = lineageOf(entry.candidate.modelId)
    if (!claim.verified) {
      unverified.push(entry)
      continue
    }
    const bucket = verified.get(claim.lineage)
    if (bucket) bucket.push(entry)
    else verified.set(claim.lineage, [entry])
  }

  const buckets = [...verified.values()]
  const picked: Deduped[] = []

  // Pass n takes the nth model from each lineage, so distinct lineages fill
  // first and distinct models within a lineage fill second.
  for (let depth = 0; picked.length < slots; depth += 1) {
    let placedThisPass = false
    for (const bucket of buckets) {
      if (picked.length >= slots) break
      const entry = bucket[depth]
      if (!entry) continue
      picked.push(entry)
      placedThisPass = true
    }
    if (!placedThisPass) break
  }

  // Unverified models fill leftover slots — they are real models the host has,
  // they just cannot be claimed as diversity.
  for (const entry of unverified) {
    if (picked.length >= slots) break
    picked.push(entry)
  }

  return picked
}

/**
 * The lineage count, and the ONLY function that produces one (AD-4, AD-5).
 *
 * It takes `RosterSlot[]` and is called with `roster.slots` and nothing else.
 * `LensSlot` structurally extends `RosterSlot`, so a caller COULD hand it lens
 * slots — which is exactly why AD-4's amendment puts them in a separate
 * collection: there is no array anywhere in the tree that holds both, so the
 * lens slots have no route into this count. That is what "by construction"
 * means (AD-17c). Exported so `distinctLineages: 0` over an empty pool is
 * assertable literally, without a pool-less run mode having to exist.
 */
export function countVerifiedLineages(slots: readonly RosterSlot[]): number {
  return new Set(slots.filter((s) => s.lineage.verified).map((s) => s.lineage.lineage)).size
}

/**
 * CAP-11 / AD-4 amended — fill the lens slots, AFTER the pool, from the same
 * deduped candidate list.
 *
 * Lens *i* takes `deduped[i % deduped.length]`: round-robin over the FULL
 * deduped list, so lenses spread across models where the host has them and reuse
 * a pool model where it does not. Reuse is permitted and costs nothing dedupe
 * was protecting — a lens slot claims no diversity (AD-17c) — but spreading
 * first gets the better roster for free and makes `roster-lens-homogeneous` mean
 * "your host is narrow" rather than "MAD chose badly".
 *
 * Duplicate lens ids collapse to one slot. Two slots sharing an id would share a
 * slot id, which a backend's per-slot map cannot represent and a finding's
 * `author` cannot disambiguate.
 *
 * An empty candidate list yields no lens slots: there is no model to run one on.
 */
export function fillLensSlots(
  deduped: readonly Deduped[],
  lenses: readonly string[],
  slotPrefix = "discovery",
): LensSlot[] {
  if (deduped.length === 0) return []

  const seen = new Set<string>()
  const slots: LensSlot[] = []
  for (const lens of lenses) {
    if (seen.has(lens)) continue
    seen.add(lens)
    const entry = deduped[slots.length % deduped.length]!
    slots.push({
      // The id is for HUMANS. `LensSlot.lens` is the data — nothing downstream
      // recovers the lens by string-splitting this (AD-17, design notes).
      slot: `${slotPrefix}-lens-${lens}`,
      lens,
      providerId: entry.candidate.providerId,
      modelId: entry.candidate.modelId,
      identity: entry.identity,
      lineage: lineageOf(entry.candidate.modelId),
      toolcall: entry.candidate.toolcall,
      alsoAvailableVia: entry.alsoAvailableVia,
    })
  }
  return slots
}

export function selectRoster(candidates: readonly Candidate[], options: SelectOptions): SelectResult {
  const { slots, providerConfigKey, slotPrefix = "discovery", lenses = [] } = options
  if (candidates.length === 0) throw new NoCandidatesError(providerConfigKey)
  if (slots < 1) throw new Error("selectRoster: slots must be at least 1")

  const deduped = dedupeByIdentity(candidates)
  const picked = rankByDiversity(deduped, slots)

  const rosterSlots: RosterSlot[] = picked.map((entry, index) => ({
    slot: `${slotPrefix}-${index + 1}`,
    providerId: entry.candidate.providerId,
    modelId: entry.candidate.modelId,
    identity: entry.identity,
    lineage: lineageOf(entry.candidate.modelId),
    toolcall: entry.candidate.toolcall,
    alsoAvailableVia: entry.alsoAvailableVia,
  }))

  // CAP-11 — the lens slots fill AFTER the pool and from the same deduped list,
  // into their own collection. `rosterSlots` is complete before this line runs
  // and is never appended to afterwards.
  const lensSlots = fillLensSlots(deduped, lenses, slotPrefix)

  // AD-4 amended / AD-17c — computed from the POOL alone. `lensSlots` is not in
  // scope for this line and never will be.
  const distinctLineages = countVerifiedLineages(rosterSlots)

  // AD-3 — every provider the run will send code to. A lens slot sends code
  // too, and it can land on a provider the pool did not pick (the pool takes
  // the top `slots` by diversity rank; lenses round-robin the whole deduped
  // list), so leaving them out would under-disclose the fan-out. This is
  // disclosure, not diversity: nothing here reaches `distinctLineages`.
  const providers = [...new Set([...rosterSlots, ...lensSlots].map((s) => s.providerId))]

  const roster: Roster = {
    slots: rosterSlots,
    lensSlots,
    requested: slots,
    distinctLineages,
    providers,
  }

  const warnings: Warning[] = []

  // AD-3 — disclose the provider fan-out a run implies. Disclosure, not a gate.
  const billedModels = [
    ...rosterSlots.map((s) => `${s.providerId}/${s.modelId}`),
    ...lensSlots.map((s) => `${s.providerId}/${s.modelId} (lens ${s.lens})`),
  ]
  warnings.push({
    code: "provider-fan-out",
    stage: "roster",
    message:
      `This review sends the change to ${providers.length} provider(s): ${providers.join(", ")}. ` +
      `Models: ${billedModels.join(", ")}.`,
    detail: { providers, models: billedModels },
  })

  // AD-6c — the roster is smaller than asked for. Distinct from the lineage
  // warning below: "requested 3, filled 1" is a different fact from "filled 3,
  // all one lineage", and a run can be degraded by either. Without this, an
  // underfilled roster with a recognized lineage reached the output with no
  // warning at all, and the shortfall was visible only in the roster header.
  if (rosterSlots.length < slots) {
    warnings.push({
      code: "roster-underfilled",
      stage: "roster",
      message:
        `UNDERFILLED ROSTER: ${slots} discovery slot(s) requested but the host offers only ` +
        `${rosterSlots.length} distinct model(s) (${candidates.length} candidate(s) before dedupe). ` +
        `The run proceeds with a smaller roster; every co-discovery fraction is over what ` +
        `answered, not over ${slots}. Add a provider under the \`${providerConfigKey}\` key in ` +
        `your opencode config to fill the remaining slot(s).`,
      detail: {
        requested: slots,
        filled: rosterSlots.length,
        candidatesBeforeDedupe: candidates.length,
        providerConfigKey,
      },
    })
  }

  // AD-5 — a slot the lineage table does not recognize.
  for (const slot of rosterSlots) {
    if (slot.lineage.verified) continue
    warnings.push({
      code: "roster-lineage-unverified",
      stage: "roster",
      message:
        `\`${slot.providerId}/${slot.modelId}\` (slot ${slot.slot}) is not in MAD's lineage table, ` +
        `so it is reported as ${UNVERIFIED_LINEAGE} and is NOT counted as a distinct lineage. ` +
        `Add a marker to core/domain/lineage.ts if you know its family.`,
      detail: { slot: slot.slot, providerId: slot.providerId, modelId: slot.modelId },
    })
  }

  // AD-6c — a roster resolving to fewer lineages than slots warns loudly, names
  // the lineage and the host config key, and states the weak-signal consequence.
  if (distinctLineages < slots) {
    const named = rosterSlots
      .map((s) => (s.lineage.verified ? s.lineage.label : `${s.modelId} (${UNVERIFIED_LINEAGE})`))
      .join(", ")
    warnings.push({
      code: "roster-single-lineage",
      stage: "roster",
      message:
        `DEGRADED ROSTER: ${slots} discovery slot(s) requested but only ${distinctLineages} ` +
        `distinct verified lineage(s) available (${named}). Co-discovery over a roster this narrow ` +
        `is a WEAK SIGNAL — models from one lineage share training data and therefore share blind ` +
        `spots. Add a provider from another lineage under the \`${providerConfigKey}\` key in your ` +
        `opencode config to fix this. Temperature variation across one model is not an accepted ` +
        `substitute for a diverse roster.`,
      detail: {
        requested: slots,
        distinctLineages,
        lineages: [
          ...new Set(
            rosterSlots.filter((s) => s.lineage.verified).map((s) => s.lineage.lineage),
          ),
        ],
        providerConfigKey,
      },
    })
  }

  // AD-6e / AD-17c — several personas over ONE model. A separate degradation
  // from the lineage report above, and it fires independently of it: a host with
  // three lineages can still resolve four lenses onto one model if that is all
  // the deduped list had left to round-robin over.
  //
  // It fires on MORE THAN ONE lens slot resolving to one identity. A single lens
  // slot is one persona over one model, which is what was asked for; and reuse
  // of a pool model is explicitly permitted (AD-4 amended) and never warned
  // about on its own, because a lens claims no diversity to lose.
  const lensIdentities = new Set(lensSlots.map((s) => s.identity))
  if (lensSlots.length > 1 && lensIdentities.size === 1) {
    const only = lensSlots[0]!
    warnings.push({
      code: "roster-lens-homogeneous",
      stage: "roster",
      message:
        `LENS ROSTER HOMOGENEOUS: all ${lensSlots.length} lens slot(s) resolved to the same model, ` +
        `\`${only.providerId}/${only.modelId}\` (${lensSlots.map((s) => s.lens).join(", ")}). ` +
        `Several personas over one model share that model's blind spots, so these lenses buy ` +
        `COVERAGE and not independence. Lens variation is not an accepted substitute for a diverse ` +
        `roster, on the same grounds as temperature variation. Add a provider from another lineage ` +
        `under the \`${providerConfigKey}\` key in your opencode config to spread them. Lens slots ` +
        `never count toward distinct lineages, so this is a separate fact from the roster report.`,
      detail: {
        model: `${only.providerId}/${only.modelId}`,
        identity: only.identity,
        lenses: lensSlots.map((s) => s.lens),
        providerConfigKey,
      },
    })
  }

  return { roster, warnings }
}
