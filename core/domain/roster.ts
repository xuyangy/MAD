/**
 * Roster domain types (AD-3, AD-4, AD-5).
 *
 * A `Candidate` is what an adapter flattens the host's configured models into.
 * It is deliberately free of any host type — the opencode adapter maps
 * `client.config.providers()` onto it, and a second adapter would map whatever
 * its host offers (AD-1).
 */

import type { LineageClaim } from "./lineage.ts"

export interface Candidate {
  /** Host provider id, e.g. the key under the host's provider config. */
  providerId: string
  /** Host model id, exactly as the host reports it. */
  modelId: string
  /** Display name from the host, if any. */
  name?: string
  /** Host-declared tool capability — read, never guessed (AD-2, design notes). */
  toolcall: boolean
  /** Host-declared context limit, if any. Used only for tie-breaking. */
  contextLimit?: number
  /** Host-declared cost, if any. Used only for tie-breaking (never budgeted on — AD-15). */
  cost?: { input: number; output: number }
}

/** One filled discovery slot. */
export interface RosterSlot {
  /** Slot id — MAD's role vocabulary, e.g. `discovery-1` (host-integration.md). */
  slot: string
  providerId: string
  modelId: string
  /** Family+version identity used for dedupe (AD-4 step 1). */
  identity: string
  lineage: LineageClaim
  toolcall: boolean
  /** Other providers that reach the same model — deduped away, recorded for disclosure. */
  alsoAvailableVia: string[]
}

export interface Roster {
  slots: RosterSlot[]
  /** How many slots were requested — never the denominator (AD-6a). */
  requested: number
  /** Distinct VERIFIED lineages actually filled. Unverified never counts (AD-5). */
  distinctLineages: number
  /** Every provider the run will send code to, for disclosure (AD-3). */
  providers: string[]
}
