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

/**
 * AD-6b — the MODEL behind a slot id, for a warning that has to name it.
 *
 * `discovery-2` is MAD's own role vocabulary (`host-integration.md`) and names
 * nobody; `anthropic/claude-sonnet-4-5` is the fact AD-6(b) asks a drop-out
 * report to carry ("the run proceeds with a warning naming it"). Without it a
 * reader has to cross-reference the ROSTER block by eye to learn which model
 * failed.
 *
 * ONE HELPER, IN THE DOMAIN, because two stages need it and `Roster` is a domain
 * type. `core/stages/debate.ts` and `core/stages/judge.ts` each held a private
 * copy of this for one story; a second copy of a rule is a second thing that can
 * drift, which is the argument that moved `DISCLOSURE_CODES` into
 * `core/domain/warning.ts` beside its vocabulary. `core/stages/discover.ts` does
 * NOT call it — it holds the `RosterSlot` itself and formats the name inline,
 * which is where this shape was first set.
 *
 * BOTH COLLECTIONS ARE SEARCHED. A lens slot fills from the same candidate list
 * and can drop out of debate exactly as a pool slot can (AD-4 amended); omitting
 * `lensSlots` would answer AD-6(b) for a lens model with a denial that the model
 * exists. Lens slots never JUDGE (`core/judge/slots.ts` builds from `slots`
 * alone), so the term is unreachable from that caller — searched anyway, because
 * one helper with one behaviour is what makes it one helper.
 *
 * A SLOT THE ROSTER CANNOT RESOLVE says so, rather than printing a slot id in a
 * field every other value of which is a `provider/model`. Unreachable through
 * both stages today — their slot ids come from the roster — and reached by
 * `roster.test.ts` rather than left as an untested branch.
 *
 * THE FAILURE VALUE IS A NAMED CONSTANT (code review 2026-08-30, second pass). It
 * lands in `Warning.detail.model` beside `provider/model` ids, and it was a bare
 * literal here and four more times in the tests — so a reader wanting to know
 * whether a warning carries a real model name had a sentence to match on and
 * nothing to import. Exported so a caller can TEST for it rather than compare
 * prose, and so rewording it is one edit.
 */
export const MODEL_UNRESOLVED = "unresolved — not on the roster"

export function modelNameOf(roster: Roster, slot: string): string {
  const filled = [...roster.slots, ...roster.lensSlots].find((s) => s.slot === slot)
  return filled ? `${filled.providerId}/${filled.modelId}` : MODEL_UNRESOLVED
}
