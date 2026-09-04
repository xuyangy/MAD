/**
 * AD-4 — roster selection is dedupe THEN rank, in that order.
 *
 * (1) Dedupe candidates by normalized model identity — family plus version,
 *     snapshot date stripped — so one model never occupies two slots regardless
 *     of how many providers reach it.
 * (0) AD-4 amended (story 8A) — resolve the caller's PINS against the deduped
 *     list, consuming at most `slots` of it. Numbered zero and written second
 *     because it is step zero of the RANKING and not of the module: dedupe still
 *     runs first, over the whole raw candidate list, and a pin can only ever
 *     claim something dedupe has already collapsed. `resolvePins` takes
 *     `readonly Deduped[]` and cannot be handed a `Candidate[]`, so that order
 *     is a compile error to violate rather than a convention to remember.
 * (2) Rank the REMAINDER, filling the slots the pins did not take to maximize
 *     distinct lineages first, then distinct models within a lineage.
 *
 * A pinned slot is an ordinary `RosterSlot` with an ordinary `discovery-N` id.
 * NOTHING downstream of the fill can tell it from a ranked one — `RosterSlot`
 * has no `pinned` field and `Roster` has no third collection — which is how the
 * "the user asked for it" suppression AD-4's amendment forbids is prevented:
 * there is no flag for such a branch to read, so writing one would mean adding
 * the field first, in a diff a reviewer can see.
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
import { oneLine } from "../prompt/material.ts"
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
  /**
   * AD-3 amended (story 8A) — discovery slots the CALLER named, in the order
   * they should fill, resolved before ranking sees anything.
   *
   * Absent or empty means byte-for-byte the roster this repo resolved before
   * this story: AD-3's Rule is that user config may OVERRIDE the selection and
   * is never REQUIRED to produce one, and a pinless run must therefore be
   * unchanged rather than merely equivalent.
   *
   * Pinning is not MAD naming a model. The USER names it, from what the HOST
   * already offers, and a pin that names something the host does not offer is
   * reported and falls through to ranking — MAD holds no credential, adds no
   * provider, and does not refuse the run.
   */
  pins?: readonly Pin[]
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
 * AD-3 amended (story 8A) — one discovery slot the caller named.
 *
 * Structurally a `Candidate` minus the capability flags, and deliberately not a
 * `Candidate`: a pin is a REQUEST, not an offer. What the model can do is the
 * host's fact to report, never the caller's to assert, so `toolcall` is not on
 * this type and a pinned slot reads its capability from the deduped entry the
 * host produced exactly as a ranked slot does.
 */
export type Pin = Pick<Candidate, "providerId" | "modelId">

/**
 * Why one pin did not fill a slot — or that it did.
 *
 * FOUR WAYS TO MISS, and they are separate values rather than one "unhonoured"
 * because they have four different fixes and only one of them is the user's
 * spelling. Collapsing them would produce a report that says a pin was not
 * honoured without saying anything a reader could act on.
 */
export type PinOutcome =
  /** It took a slot. */
  | "filled"
  /** The host does not offer this model, or not through this provider. */
  | "not-offered"
  /** Dedupe had already collapsed it into an entry an earlier pin took (AD-4). */
  | "dedupe-collapsed"
  /** Every slot was already filled by an earlier pin. */
  | "no-slot"
  /** Not a usable provider/model pair at all. */
  | "malformed"

export interface PinResolution {
  pin: Pin
  outcome: PinOutcome
  /** The deduped entry it claimed. Present only when `outcome` is `filled`. */
  entry?: Deduped
}

/**
 * What step 0 produced. It NEVER ESCAPES `selectRoster`'s body — nothing on
 * `Roster`, `RosterSlot` or `SelectResult` carries it — which is the property
 * that keeps a pinned slot indistinguishable from a ranked one downstream.
 */
export interface PinnedStep {
  /** The entries the pins claimed, in pin order. At most `slots` of them. */
  filled: Deduped[]
  /** Everything dedupe produced that no pin took, in dedupe order. */
  remaining: Deduped[]
  /** One per pin, in the order given. */
  resolutions: PinResolution[]
}

/** How many characters of a caller-supplied id may reach a warning row. */
const PIN_LABEL_MAX = 80

/**
 * A caller's pin, rendered safely into a MAD-authored warning row (AD-18).
 *
 * The pin id is the only string in this module MAD did not write, and it lands
 * inside a code span in a degradation warning. Untouched, a backtick closes
 * MAD's span and a newline starts a row of the caller's own — a forged report,
 * in the one place a reader looks to find out whether the run is trustworthy.
 *
 * IT IS SANITIZED HERE, IN THE CORE, and not only at the adapter's clamp. The
 * `review()` seam is exported and story 9's ablation harness calls it directly,
 * where `clampPins` never runs; a defence that lives only in the adapter is a
 * defence the one caller this story was written for does not have.
 */
export function pinLabel(pin: Pin): string {
  const clip = (value: string): string =>
    oneLine(String(value ?? "")).replaceAll("`", "'").slice(0, PIN_LABEL_MAX)
  return `${clip(pin.providerId)}/${clip(pin.modelId)}`
}

/**
 * AD-4 step 0 (story 8A) — resolve the caller's pins against the DEDUPED list.
 *
 * The parameter is `readonly Deduped[]` and that is the whole safety argument:
 * dedupe has already run, over the whole candidate list, and a pin can only
 * claim something that survived it. Two providers reaching one model meet ONE
 * entry here, so the first pin takes it and the second is `dedupe-collapsed` and
 * fills nothing — which may leave the roster short, which `roster-underfilled`
 * then reports through its own untouched predicate. Pinning cannot buy a
 * diversity claim the models do not support, because there is no second entry
 * for it to buy.
 *
 * The provider half is matched CASE-INSENSITIVELY, and against
 * `alsoAvailableVia` as well as the winning provider. A pin is reachable if the
 * host offers that model through the named provider at all; reporting
 * `bedrock/claude-sonnet-4-5` as "the host does not offer it" when bedrock is
 * sitting in `alsoAvailableVia` would be a false statement about the host, in a
 * warning whose whole job is to be actionable.
 *
 * It MUTATES NOTHING. `deduped` is not sorted, spliced or reordered, and no
 * `alsoAvailableVia` array is touched — those arrays are shared by reference
 * into the lens slots, so a mutation here would corrupt a collection this
 * function is not even about.
 */
export function resolvePins(
  deduped: readonly Deduped[],
  pins: readonly Pin[],
  slots: number,
): PinnedStep {
  const filled: Deduped[] = []
  const resolutions: PinResolution[] = []
  const consumed = new Set<Deduped>()

  for (const pin of pins) {
    const providerId = typeof pin.providerId === "string" ? pin.providerId.trim() : ""
    const modelId = typeof pin.modelId === "string" ? pin.modelId.trim() : ""
    if (providerId.length === 0 || modelId.length === 0) {
      resolutions.push({ pin, outcome: "malformed" })
      continue
    }

    const identity = normalizeModelIdentity(modelId)
    const wanted = providerId.toLowerCase()
    const entry = deduped.find(
      (candidate) =>
        candidate.identity === identity &&
        (candidate.candidate.providerId.toLowerCase() === wanted ||
          candidate.alsoAvailableVia.some((via) => via.toLowerCase() === wanted)),
    )
    if (!entry) {
      resolutions.push({ pin, outcome: "not-offered" })
      continue
    }
    if (consumed.has(entry)) {
      resolutions.push({ pin, outcome: "dedupe-collapsed", entry })
      continue
    }
    // Checked AFTER the two rejections above, deliberately: a surplus pin that
    // ALSO names a model the host lacks should be reported as the misspelling it
    // is, which is the fact the caller can act on.
    if (filled.length >= slots) {
      resolutions.push({ pin, outcome: "no-slot", entry })
      continue
    }
    consumed.add(entry)
    filled.push(entry)
    resolutions.push({ pin, outcome: "filled", entry })
  }

  return { filled, remaining: deduped.filter((entry) => !consumed.has(entry)), resolutions }
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
 * Lens *i* takes the *i*th entry of the FULL deduped list ordered BY LINEAGE
 * SPREAD, wrapping. Reuse is permitted and costs nothing dedupe was protecting —
 * a lens slot claims no diversity (AD-17c) — but spreading first gets the better
 * roster for free and makes `roster-lens-homogeneous` mean "your host is narrow"
 * rather than "MAD chose badly".
 *
 * The ordering is `rankByDiversity` over the whole list, NOT the raw deduped
 * order (code review, 2026-08-15). Indexing the raw order makes the spread a
 * function of how the host happens to list its providers: a host offering
 * `sonnet, haiku, opus, gpt-5` put three lenses on three Claude models and left
 * `gpt-5` unused, which is precisely the "MAD chose badly" case the paragraph
 * above claims cannot happen. Ranking first costs one call and makes the claim
 * true. Reuse still happens — it just happens after every lineage has one.
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

  // AD-4 step 2, reused: one model per lineage before any lineage gets a second.
  // The pool is filled from this same ordering; taking the raw `deduped` order
  // here instead is what let lenses pile into one lineage (code review 2026-08-15).
  const spread = rankByDiversity(deduped, deduped.length)

  const seen = new Set<string>()
  const slots: LensSlot[] = []
  for (const lens of lenses) {
    if (seen.has(lens)) continue
    seen.add(lens)
    const entry = spread[slots.length % spread.length]!
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
  const { slots, providerConfigKey, slotPrefix = "discovery", lenses = [], pins = [] } = options
  if (candidates.length === 0) throw new NoCandidatesError(providerConfigKey)
  if (slots < 1) throw new Error("selectRoster: slots must be at least 1")

  // AD-4 — DEDUPE FIRST, over the whole raw candidate list, and this is still
  // the only line in the module that touches `candidates`. Everything below
  // works on what survived it.
  const deduped = dedupeByIdentity(candidates)
  // AD-4 step 0 (story 8A) — the pins claim from the deduped list; ranking gets
  // the remainder and the slots the pins did not take. When `pins` is empty this
  // is `resolvePins(deduped, [], slots)` returning `{filled: [], remaining:
  // deduped, resolutions: []}`, so `picked` is `rankByDiversity(deduped, slots)`
  // exactly as before — the pinless run is unchanged, not merely equivalent.
  const pinning = resolvePins(deduped, pins, slots)
  const ranked = rankByDiversity(pinning.remaining, slots - pinning.filled.length)
  const picked = [...pinning.filled, ...ranked]

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

  // AD-3 amended (story 8A) — A PIN THE RUN COULD NOT HONOUR, said once.
  //
  // It exists because no existing report can carry the fact without lying: when
  // ranking backfills a missed pin the roster is FULL, so `roster-underfilled`
  // never fires, and its remedy ("add a provider") is not the fix for a
  // misspelled model id anyway.
  //
  // IT SAYS NOTHING ABOUT DIVERSITY. The four AD-6c reports below say everything
  // there is to say about that, and say it identically whether a slot was pinned
  // or ranked. A sentence here along the lines of "you pinned these, so adding a
  // provider will not help" would be the suppression AD-4's amendment forbids
  // wearing a remedy note as a disguise — and it would be FALSE whenever fewer
  // pins than slots were given, since the ranked remainder is exactly what a new
  // provider would change.
  const unhonoured = pinning.resolutions.filter((r) => r.outcome !== "filled")
  if (pins.length > 0 && unhonoured.length > 0) {
    const reasonOf = (resolution: PinResolution): string => {
      switch (resolution.outcome) {
        case "not-offered":
          return "this host does not offer it"
        case "dedupe-collapsed": {
          // Named by the SLOT that already serves the model, so the reader can
          // see it is present rather than missing.
          const serving = rosterSlots.find((slot) => slot.identity === resolution.entry?.identity)
          return serving
            ? `the same model already fills slot ${serving.slot}, so it cannot fill a second`
            : "the same model was already pinned, so it cannot fill a second slot"
        }
        case "no-slot":
          return `there were only ${slots} slot(s) and earlier pins took them all`
        default:
          return "it is not a usable provider/model pair"
      }
    }
    const listed = unhonoured
      .map((resolution) => `\`${pinLabel(resolution.pin)}\` (${reasonOf(resolution)})`)
      .join("; ")
    warnings.push({
      code: "roster-pin-unhonoured",
      stage: "roster",
      message:
        `PIN NOT HONOURED: ${unhonoured.length} of ${pins.length} pinned model(s) did not fill a ` +
        `slot — ${listed}. Those slot(s) fell through to ranking and the run PROCEEDS with the ` +
        `roster below; MAD names no model of its own and does not refuse a run over a pin. Check ` +
        `the provider and model ids against the \`${providerConfigKey}\` key in your opencode ` +
        `config.`,
      detail: {
        pins: unhonoured.map((resolution) => ({
          providerId: pinLabel(resolution.pin).split("/")[0] ?? "",
          modelId: pinLabel(resolution.pin).split("/").slice(1).join("/"),
          reason: resolution.outcome,
          ...(resolution.outcome === "dedupe-collapsed"
            ? {
                servedBy:
                  rosterSlots.find((slot) => slot.identity === resolution.entry?.identity)?.slot ??
                  "",
              }
            : {}),
        })),
        pinned: pinning.filled.length,
        requested: pins.length,
        providerConfigKey,
      },
    })
  }

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
  // It fires on MORE THAN ONE lens slot sharing a blind spot. A single lens slot
  // is one persona over one model, which is what was asked for; and reuse of a
  // pool model is explicitly permitted (AD-4 amended) and never warned about on
  // its own, because a lens claims no diversity to lose.
  //
  // TWO triggers, because AD-6e's rationale is a shared-blind-spots argument and
  // AD-5 locates blind spots at the LINEAGE, not the model ("correlated blind
  // spots come from shared training data"). Keying on identity alone let three
  // personas over sonnet + haiku + opus pass silently — three distinct models,
  // one lineage, exactly the configuration AD-6c warns about for the pool (code
  // review 2026-08-15; AD-6e amended to match its own reasoning).
  //
  // Unverified lineages do NOT collapse together: N unrecognized models are N
  // unknowns, not one shared lineage, and AD-5 forbids reading anything into an
  // unverified claim in either direction.
  const lensIdentities = new Set(lensSlots.map((s) => s.identity))
  const lensLineages = new Set(lensSlots.map((s) => s.lineage.lineage))
  const allVerified = lensSlots.every((s) => s.lineage.verified)
  const oneModel = lensIdentities.size === 1
  const oneLineage = allVerified && lensLineages.size === 1

  if (lensSlots.length > 1 && (oneModel || oneLineage)) {
    const only = lensSlots[0]!
    const shared = oneModel
      ? `the same model, \`${only.providerId}/${only.modelId}\``
      : `${lensIdentities.size} models of ONE lineage (${only.lineage.label}): ` +
        `${[...new Set(lensSlots.map((s) => `${s.providerId}/${s.modelId}`))].join(", ")}`
    warnings.push({
      code: "roster-lens-homogeneous",
      stage: "roster",
      message:
        `LENS ROSTER HOMOGENEOUS: all ${lensSlots.length} lens slot(s) resolved to ${shared} ` +
        `(${lensSlots.map((s) => s.lens).join(", ")}). ` +
        `Several personas over one ${oneModel ? "model" : "lineage"} share ` +
        `${oneModel ? "that model's" : "that lineage's"} blind spots, so these lenses buy ` +
        `COVERAGE and not independence. Lens variation is not an accepted substitute for a diverse ` +
        `roster, on the same grounds as temperature variation. Add a provider from another lineage ` +
        `under the \`${providerConfigKey}\` key in your opencode config to spread them. Lens slots ` +
        `never count toward distinct lineages, so this is a separate fact from the roster report.`,
      detail: {
        model: `${only.providerId}/${only.modelId}`,
        identity: only.identity,
        scope: oneModel ? "one-model" : "one-lineage",
        lineage: only.lineage.lineage,
        lenses: lensSlots.map((s) => s.lens),
        providerConfigKey,
      },
    })
  }

  return { roster, warnings }
}
