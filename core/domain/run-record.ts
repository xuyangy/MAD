/**
 * AD-16 — the run record is a first-class in-memory object.
 *
 * A run produces one `RunRecord` holding the finding set, the roster, the
 * degradation warnings, and the token ledger. Output renders it; the ablation
 * (story 9) reads two of them. v1 keeps it in memory and writes NOTHING — no
 * file is created in the user's repo. Serializing it is an adapter-side concern
 * that may be added behind a flag without touching a stage.
 */

import type { InstructionOrigin } from "../instructions/types.ts"
import type { Finding } from "./finding.ts"
import type { Roster } from "./roster.ts"
import type { Warning } from "./warning.ts"

/**
 * AD-11 amended / AD-17e — one lens slot's instruction provenance.
 *
 * `InstructionOrigin` is imported as a TYPE ONLY: this records what the run got,
 * it does not reach into the instruction layer to get it. The alternative was a
 * second declaration of the same two-member union, which is one rename away from
 * a record that disagrees with the registry it describes.
 */
export interface LensInstructionRecord {
  lens: string
  origin: InstructionOrigin
}

/**
 * AD-15 — MAD budgets in tokens, never currency. These are the integers the
 * host reports per assistant message; `cost` is deliberately not carried,
 * because its unit is undocumented.
 */
export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export function emptyTokenUsage(): TokenUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

export function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

/**
 * AD-15 — the unit of allocation is one turn, the same unit
 * `ModelBackend.runTurn` bills. Story 5 grows this into the `BudgetLedger` that
 * answers "may I spend?"; story 1 only records.
 */
export interface LedgerEntry {
  slot: string
  stage: string
  attempt: number
  tokens: TokenUsage
}

export interface TokenLedger {
  entries: LedgerEntry[]
  total: TokenUsage
}

export interface RunRecord {
  /** Opaque and sortable (spine, Ids). */
  runId: string
  startedAt: string
  finishedAt?: string
  roster: Roster
  /**
   * AD-6a — how many roster models actually answered. Every co-discovery
   * fraction downstream divides by this, never by `roster.requested`.
   */
  answered: number
  findings: Finding[]
  /**
   * AD-11 amended / AD-17e — the lens slots this run used and whether each one's
   * instruction was shipped or generated at run time. Required and `[]` when no
   * lens ran, for the same reason `Roster.lensSlots` is: absent and empty must
   * not be two ways of saying the same thing.
   */
  lensInstructions: LensInstructionRecord[]
  warnings: Warning[]
  ledger: TokenLedger
}

export function emptyLedger(): TokenLedger {
  return { entries: [], total: emptyTokenUsage() }
}

export function recordTurn(ledger: TokenLedger, entry: LedgerEntry): void {
  ledger.entries.push(entry)
  ledger.total = addTokens(ledger.total, entry.tokens)
}
