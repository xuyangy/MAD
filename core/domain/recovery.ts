/**
 * Discovery recovery: what the run record keeps about refused discovery slots
 * and the slots dispatched to replace them, and the two views derived from it.
 *
 * `record.roster` is the INITIAL selection and is never changed. The execution
 * view (`executionRoster`) is that selection plus every replacement slot that
 * was dispatched, for the stages and labels that must resolve those slots. It
 * is never the bound reserve (`RecoveryPlan`), which may hold routes no turn
 * ever used.
 */

import { normalizeModelIdentity } from "./lineage.ts"
import type { Refusal } from "./refusal.ts"
import type { RecoveryPlan, Roster, RosterSlot } from "./roster.ts"
import type { RunRecord } from "./run-record.ts"

/** An original pool slot that discovery dropped after a classified refusal: the structured fact recovery starts from. */
export interface RefusedSlot {
  slot: string
  refusal: Refusal
}

/**
 * A replacement slot whose discovery turn was DISPATCHED: admitted and handed to
 * the backend's `runTurn`. That is backend work, not proof a prompt reached the
 * provider; the ledger records what each execution billed, as for any turn.
 */
export interface Replacement {
  /** The refused original pool slot it replaces. */
  from: string
  /** The replacement route, under its bound slot id. */
  to: RosterSlot
  /** How many times its turn was dispatched: the first attempt, and a retry if one was taken. */
  dispatched: 1 | 2
  /** Whether its discovery turn returned findings MAD could use. Says nothing about later stages. */
  answered: boolean
}

/** A refused original pool slot that got no replacement, and why. */
export interface NotReplaced {
  from: string
  reason: "no-plan" | "no-candidate" | "budget" | "admission" | "cancelled"
  detail?: string
}

/** Optional on the record: absent means no slot was refused, and every reader treats it as empty. */
export interface RunRecovery {
  refused: RefusedSlot[]
  replacements: Replacement[]
  notReplaced: NotReplaced[]
}

/**
 * The invariants a supplied recovery plan must hold before any discovery turn
 * is dispatched: unique slot ids that are neither pool nor lens ids, each
 * route's identity its model id's, and no model the pool already holds. A
 * violation is a programming error in the caller that built the plan, so it
 * throws; nothing has been spent yet.
 */
export function validateRecoveryPlan(plan: RecoveryPlan, roster: Roster): void {
  const fail = (why: string): never => {
    throw new Error(`recovery plan is inconsistent: ${why}`)
  }
  const taken = new Set([...roster.slots, ...roster.lensSlots].map((slot) => slot.slot))
  const poolIdentities = new Set(roster.slots.map((slot) => slot.identity))
  const ids = new Set<string>()
  for (const candidate of plan.candidates) {
    if (taken.has(candidate.slot) || ids.has(candidate.slot)) fail(`slot id ${candidate.slot} collides`)
    ids.add(candidate.slot)
    if (normalizeModelIdentity(candidate.modelId) !== candidate.identity) {
      fail(`candidate ${candidate.slot} names identity ${candidate.identity}, but its model ${candidate.modelId} is another`)
    }
    if (poolIdentities.has(candidate.identity)) fail(`candidate ${candidate.slot} is a model the pool already holds`)
  }
}

/** The dispatched replacements, empty when the record has no recovery. */
export function replacementsOf(record: Pick<RunRecord, "recovery">): readonly Replacement[] {
  return record.recovery?.replacements ?? []
}

/**
 * The invariants a record's recovery must hold, checked from its structured
 * fields only. A violation is a programming error, so it throws.
 *
 * - Each `refused` entry names an original pool slot, once, and its refusal's
 *   route is that slot's.
 * - Each replacement comes from a refused slot, at most once, and no slot both
 *   was replaced and is listed as not replaced.
 * - Replacement slot ids are unique and are neither pool nor lens ids.
 * - A replacement's identity is its model id's, and is new: no original pool
 *   identity, no other replacement's.
 * - No replacement goes through a provider any slot refused at provider scope,
 *   or through a provider/model route any slot refused at route scope.
 * - Each not-replaced slot is listed once.
 * - At most one replacement per original filled pool slot; `dispatched` is 1 or 2.
 */
export function validateReplacements(record: Pick<RunRecord, "roster" | "recovery">): void {
  const recovery = record.recovery
  if (recovery === undefined) return
  const fail = (why: string): never => {
    throw new Error(`run record recovery is inconsistent: ${why}`)
  }
  const pool = new Map(record.roster.slots.map((slot) => [slot.slot, slot]))
  const lensIds = new Set(record.roster.lensSlots.map((slot) => slot.slot))

  const refused = new Map<string, Refusal>()
  for (const entry of recovery.refused) {
    const original = pool.get(entry.slot) ?? fail(`refused slot ${entry.slot} is not an original pool slot`)
    if (refused.has(entry.slot)) fail(`slot ${entry.slot} is listed as refused twice`)
    if (entry.refusal.providerId !== original.providerId || entry.refusal.modelId !== original.modelId) {
      fail(`the refusal recorded for ${entry.slot} names another route`)
    }
    refused.set(entry.slot, entry.refusal)
  }
  // Exclusions hold across the whole run, not only for the slot that was refused.
  const refusedProviders = new Set<string>()
  const refusedRoutes = new Set<string>()
  for (const refusal of refused.values()) {
    if (refusal.scope === "provider") refusedProviders.add(refusal.providerId)
    else refusedRoutes.add(`${refusal.providerId}\u0000${refusal.modelId}`)
  }

  if (recovery.replacements.length > record.roster.slots.length) {
    fail("more replacements than original pool slots")
  }
  const from = new Set<string>()
  const toIds = new Set<string>()
  const identities = new Set(record.roster.slots.map((slot) => slot.identity))
  for (const replacement of recovery.replacements) {
    if (!refused.has(replacement.from)) fail(`replacement from ${replacement.from}, which was not refused`)
    if (from.has(replacement.from)) fail(`slot ${replacement.from} was replaced twice`)
    from.add(replacement.from)
    const id = replacement.to.slot
    if (pool.has(id) || lensIds.has(id) || toIds.has(id)) fail(`replacement slot id ${id} collides`)
    toIds.add(id)
    if (normalizeModelIdentity(replacement.to.modelId) !== replacement.to.identity) {
      fail(`replacement ${id} names identity ${replacement.to.identity}, but its model ${replacement.to.modelId} is another`)
    }
    if (identities.has(replacement.to.identity)) fail(`replacement ${id} reuses model ${replacement.to.identity}`)
    identities.add(replacement.to.identity)
    if (refusedProviders.has(replacement.to.providerId)) {
      fail(`replacement ${id} uses provider ${replacement.to.providerId}, which refused at provider scope`)
    }
    if (refusedRoutes.has(`${replacement.to.providerId}\u0000${replacement.to.modelId}`)) {
      fail(`replacement ${id} uses the route ${replacement.to.providerId}/${replacement.to.modelId}, which was refused`)
    }
    if (replacement.dispatched !== 1 && replacement.dispatched !== 2) fail(`replacement ${id} has dispatched ${replacement.dispatched}`)
  }
  const notReplaced = new Set<string>()
  for (const entry of recovery.notReplaced) {
    if (!refused.has(entry.from)) fail(`not-replaced ${entry.from} was not refused`)
    if (notReplaced.has(entry.from)) fail(`slot ${entry.from} is listed as not replaced twice`)
    notReplaced.add(entry.from)
    if (from.has(entry.from)) fail(`slot ${entry.from} is both replaced and not replaced`)
  }
}

/**
 * The roster the later stages run against: the initial pool followed by every
 * dispatched replacement, and the initial lens slots.
 *
 * `requested` and `distinctLineages` are the INITIAL selection's, unchanged: the
 * lineage count describes the roster MAD selected, not the models that ran or
 * answered, and nothing may present it as either. `providers` is
 * `executionProviders`.
 */
export function executionRoster(record: Pick<RunRecord, "roster" | "recovery">): Roster {
  validateReplacements(record)
  const replacements = replacementsOf(record)
  if (replacements.length === 0) return record.roster
  return {
    ...record.roster,
    slots: [...record.roster.slots, ...replacements.map((replacement) => replacement.to)],
    providers: executionProviders(record),
  }
}

/**
 * Where the run may have sent the change: the initial selection's providers,
 * then the provider of each dispatched replacement not already listed. A
 * conservative disclosure; it does not prove a request reached each provider.
 * Reserve routes no replacement used are never included.
 */
export function executionProviders(record: Pick<RunRecord, "roster" | "recovery">): string[] {
  const providers = [...record.roster.providers]
  for (const replacement of replacementsOf(record)) {
    if (!providers.includes(replacement.to.providerId)) providers.push(replacement.to.providerId)
  }
  return providers
}
