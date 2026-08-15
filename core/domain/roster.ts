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

/**
 * One filled LENS slot (CAP-11, AD-4 amended, AD-17).
 *
 * A lens is a persona narrowing what one discovery slot looks for. It applies at
 * exactly one moment — that slot's discovery turn — and claims no diversity, so
 * a lens slot may reuse a model the pool already holds.
 *
 * READ THE LENS FROM `lens`, NEVER BY PARSING `slot`. The slot id
 * (`discovery-lens-security`) is for humans; recovering the lens by
 * string-splitting an id or an `author` field re-creates the leak AD-17 spends
 * five clauses closing, somewhere no reviewer looks.
 */
export interface LensSlot extends RosterSlot {
  /** The lens id this slot carries, e.g. `security`. */
  lens: string
}

export interface Roster {
  /** The unlensed pool. The ONLY slots lineage accounting ever sees (AD-4). */
  slots: RosterSlot[]
  /**
   * AD-4 amended (CAP-11) — lens slots live HERE and never in `slots`, so they
   * are excluded from lineage accounting by construction rather than by a filter
   * someone can forget. Required and `[]` when no lens was asked for: an
   * optional field would re-admit the absent-vs-empty ambiguity at every read.
   */
  lensSlots: LensSlot[]
  /** How many slots were requested — never the denominator (AD-6a). */
  requested: number
  /**
   * Distinct VERIFIED lineages actually filled. Unverified never counts (AD-5).
   *
   * POOL SLOTS ONLY, BY CONSTRUCTION (AD-4 amended, AD-17c). This is computed
   * from `slots` alone; `lensSlots` is a separate collection and cannot reach
   * this number. Several personas over one model are one model's blind spots
   * wearing hats — coverage, never independence (`host-integration.md`).
   */
  distinctLineages: number
  /** Every provider the run will send code to, for disclosure (AD-3). */
  providers: string[]
}
