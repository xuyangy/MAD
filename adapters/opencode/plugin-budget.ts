/**
 * CAP-6 (v1 readiness story 6a) — the token budget a review gets through the
 * plugin when the caller names none.
 *
 * It is an ADMISSION budget, not a ceiling on the bill. The core's single
 * accountant (`core/budget/ledger.ts` `mayISpend`) is asked when work is
 * admitted: before each discovery attempt, once before each debate round, and
 * before judge steps. Work it already admitted can take the total past it,
 * including a debate round's turns and their retries; usage a provider does not
 * report is not counted against it; and the host's own retries and tool steps
 * are never seen by it.
 *
 * The figures are sized offline by `scripts/plugin-budget-default.ts` from the
 * recorded paired-evaluation runs, per-unit cost assumptions calibrated on them,
 * and a stated per-preset turn shape over a reference workload;
 * `scripts/plugin-budget-default.test.ts` fails when this table and that
 * derivation disagree. They make no claim about a real bill, latency or how
 * useful the review will be.
 *
 * This is the plugin boundary's default only. `review()` itself keeps `null`
 * (no ceiling) for a caller that passes nothing, so ablation and evaluation
 * runs, which call `review()` directly, are unchanged; and `SUGGESTED_BUDGET`
 * in `core/budget/presets.ts` stays a planning table that nothing enforces.
 */

import type { Preset } from "../../core/budget/ledger.ts"

/** The default budget per preset, in tokens. Every preset has a finite one. */
export const DEFAULT_PLUGIN_BUDGET: Readonly<Record<Preset, number>> = {
  quick: 400_000,
  normal: 450_000,
  paranoid: 650_000,
}

/**
 * The budget a plugin review runs under: the caller's own when given, `0`
 * included, otherwise the preset's default. `preset` is the already-clamped
 * preset, so an unrecognised one gets `normal`'s figure like the rest of its
 * dials.
 */
export function pluginBudget(budget: number | undefined | null, preset: Preset): number {
  return budget ?? DEFAULT_PLUGIN_BUDGET[preset]
}
