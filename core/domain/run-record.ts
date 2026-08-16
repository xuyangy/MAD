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
  /** After clustering, the CANONICAL findings. Before it, the whole pool. */
  findings: Finding[]
  /**
   * The pre-cluster union — every finding discovery raised, in roster order.
   * Required and never optional, for the same reason `lensSlots` and
   * `lensInstructions` are: absent and empty must not be two ways of saying the
   * same thing.
   *
   * THIS IS NOT BOOKKEEPING. Findings are mutated in place (AD-7), so `pool` and
   * `findings` share objects and cannot drift; `findings` is the canonical
   * subset. CAP-1's criterion is a claim about the DISCOVERY POOL, and
   * `fixtures/recall.ts` derives every single-model arm from `finding.author` —
   * measured over a merged set instead, an arm silently loses credit for a
   * finding it really did raise and CAP-1's number degrades with no test failing.
   *
   * AD-16 is unchanged: still in memory, still nothing written to the repo.
   */
  pool: Finding[]
  /**
   * AD-11 amended / AD-17e — the lens slots this run used and whether each one's
   * instruction was shipped or generated at run time. Required and `[]` when no
   * lens ran, for the same reason `Roster.lensSlots` is: absent and empty must
   * not be two ways of saying the same thing.
   */
  lensInstructions: LensInstructionRecord[]
  /**
   * CAP-3 — the co-discovery threshold this run actually routed against, already
   * clamped. Required and never optional, for the same reason `pool` and
   * `lensInstructions` are: absent and defaulted must not be two ways of saying
   * the same thing.
   *
   * It is on the record because a routing summary without its dial is a count
   * nobody can interpret — CAP-3's success criterion is that *changing the
   * threshold alone* changes which findings enter debate, and a reader comparing
   * two runs needs to see the number that differed. Story 8's presets record what
   * they resolved to here.
   */
  threshold: number
  /**
   * CAP-3 — the partition routing produced, as the ROUTE STAGE counted it.
   *
   * Optional, and its ABSENCE is the signal that routing has not run — the same
   * shape `clusterId` uses for clustering (AD-14 amended), and the property that
   * keeps `output()` callable mid-pipeline. It is NOT "absent means zero": a run
   * that routed nothing carries all-zero counts, which is a different fact from a
   * run that never routed.
   *
   * Written here rather than recomputed by the renderer because a partition
   * counted twice is a partition that can disagree with itself. The renderer's
   * copy would necessarily count only the RESOLVED findings it is iterating, so
   * once story 8 writes `unresolved`, a finding that was routed and then died at
   * a later stage would silently drop out of the totals. The stage's own counts
   * cover every finding it decided about, which is what the summary claims to be.
   */
  routeCounts?: RouteCounts
  warnings: Warning[]
  ledger: TokenLedger
}

/**
 * CAP-3 — the routed partition, counted once by the stage that decided it.
 *
 * The judge bucket is split by WHY, and that split is load-bearing rather than
 * decorative: a finding reaches the judge either because its fraction cleared the
 * dial or because it never had a fraction at all (AD-17d). Reporting one total
 * and captioning it "at or above the threshold" would state the second case as
 * the first — the exact conflation AD-9's amendment forbids, said in the summary
 * line instead of in the comparator.
 *
 * `toJudge === toJudgeAtThreshold + toJudgeNoPrior`, always.
 */
export interface RouteCounts {
  toDebate: number
  toJudge: number
  /** Judged because `raised / answered >= threshold`. A claim about a comparison. */
  toJudgeAtThreshold: number
  /** Judged because there was no prior to compare — lens-sourced (AD-17d). */
  toJudgeNoPrior: number
}

/**
 * CAP-3 — the ONE way the threshold is written for a human, so the routing stage
 * and the renderer cannot disagree about what dial a run used.
 *
 * A percentage, because that is the vocabulary `cost-model.md` states the dial in
 * ("100% debates everything, 50% debates almost nothing"). Rounded to TWO DECIMAL
 * PLACES of a percent with trailing zeros trimmed, so `0.8` reads `80%` and an
 * awkward `0.667` reads `66.7%`.
 *
 * Rounding at that place is a real, if small, loss: `1/3` renders `33.33%` while
 * `meetsThreshold` compares against `0.3333…`. The precision is chosen to keep the
 * printed dial from landing on a NEIGHBOURING round number a reader would take for
 * the setting — `0.667` must not read `67%`, which routes `2/3` the other way —
 * not to reproduce the double. A caller that needs the exact value reads
 * `RunRecord.threshold`.
 */
export function formatThreshold(threshold: number): string {
  return `${Number.parseFloat((threshold * 100).toFixed(2))}%`
}

export function emptyLedger(): TokenLedger {
  return { entries: [], total: emptyTokenUsage() }
}

export function recordTurn(ledger: TokenLedger, entry: LedgerEntry): void {
  ledger.entries.push(entry)
  ledger.total = addTokens(ledger.total, entry.tokens)
}
