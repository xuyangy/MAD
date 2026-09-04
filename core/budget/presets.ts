/**
 * CAP-7 (story 8) — the two things a user actually sets, and the table they
 * resolve to.
 *
 * MAD ships eleven-ish dials and a user should have to learn none of them. This
 * module is the whole of the user-facing surface: ONE token number, and ONE word
 * naming a table of dial values. Everything else stays reachable on the
 * `review()` seam and untouched by default.
 *
 * ## A preset moves NUMBERS and never POLICY
 *
 * `quick` is not "route differently"; it is `threshold: 0.5`. `paranoid` is not
 * "try harder"; it is three more discovery slots, named. Every value here is a
 * dial that already existed and was already clamped by its own owner, so a
 * preset cannot reach a state a caller could not reach by hand — which is what
 * keeps this table from becoming a second, hidden policy layer beside
 * `route.ts` and `debate.ts`.
 *
 * Three rules a future editor may not break:
 *
 *   1. **`normal` is the identity preset** (AD-3). Its every value is the
 *      shipped default verbatim, so `preset: "normal"` and passing nothing are
 *      the SAME run. The coupling is a TEST rather than an import — see below.
 *   2. **Lenses are `[]` in `quick` and `normal`, and a SUBSET in `paranoid`**
 *      (AD-15 amended 2026-08-14). Lens count is the only lever that INCREASES
 *      cost (`cost-model.md:12`), so a fresh install that passes nothing runs
 *      zero lens turns and costs exactly what it costs today.
 *   3. **No preset carries `maxRounds` or `slots`.** `cost-model.md:26` — the
 *      dial is which lenses, not how many rounds; and the slot count is AD-3's
 *      roster decision, which belongs to the host's configured models rather
 *      than to a word.
 *
 * ## The fan-out is ADDITIVE
 *
 * `slots + lenses`, never `slots x (1 + lenses)` (AD-15 corrected 2026-08-15).
 * `paranoid` is three pool slots plus three lens slots = **six** discovery
 * turns. The multiplicative reading the amendment originally carried would say
 * twelve, and sizing the budgets against it would size them 2.25x too large.
 *
 * ## Imports NOTHING (AD-1)
 *
 * For `limiter.ts`'s reason exactly: `core/domain/run-record.ts` imports
 * `SpendShares` from here while `core/budget/ledger.ts` imports from
 * `core/domain/`, and this file having no imports is the only thing between
 * that and a cycle. It is enforced in `scripts/lint-dependency-direction.ts`
 * rather than promised here.
 *
 * The consequence is that `PRESET_DIALS.normal` restates `0.8` and `4` as
 * literals rather than importing `DEFAULT_CO_DISCOVERY_THRESHOLD` and
 * `DEFAULT_MAX_CONCURRENCY`. That is the one duplication this codebase has
 * recorded against itself three times, so it is paid for the only way that
 * works without the import: a test asserts each literal EQUALS the constant it
 * mirrors, and that test fails the day either default moves.
 */

/** The three words, and the only three. */
export const PRESETS = ["quick", "normal", "paranoid"] as const

export type Preset = (typeof PRESETS)[number]

/**
 * What a caller who names no preset gets — and it is `normal` because `normal`
 * is the identity, so this constant changes nothing on its own. It exists so
 * the default has a name a reader can grep rather than being spelled `"normal"`
 * at each of its sites.
 */
export const DEFAULT_PRESET: Preset = "normal"

/**
 * The dial values a preset resolves to.
 *
 * Deliberately a SUBSET of `ReviewDeps`, not a mirror of it: a field here is a
 * field a preset is allowed to move. Adding one is a spec decision, which is why
 * `maxRounds` and `slots` are absent rather than present-and-equal.
 */
export interface PresetDials {
  /** AD-6a's co-discovery threshold — what the presets ACTUALLY move. */
  threshold: number
  /**
   * Which lenses, by registered id. The dial is WHICH, never HOW MANY
   * (`cost-model.md:26`), so this is a list and not a count.
   */
  lenses: readonly string[]
  /** The peak from story 7A. This story owns only the default and this table. */
  maxConcurrency: number
}

/**
 * THE TABLE. Every value is a dial that already existed.
 *
 * `security` and `reliability` are the two lenses whose misses reach
 * `critical`; `outsider` is the only shipped lens that is a different VANTAGE
 * rather than a specialization, which is the diversity argument the whole pool
 * rests on. Three of the eight keeps `paranoid` at six discovery turns rather
 * than eleven.
 */
export const PRESET_DIALS: Readonly<Record<Preset, PresetDials>> = {
  quick: { threshold: 0.5, lenses: [], maxConcurrency: 4 },
  normal: { threshold: 0.8, lenses: [], maxConcurrency: 4 },
  paranoid: {
    threshold: 1,
    lenses: ["security", "reliability", "outsider"],
    maxConcurrency: 6,
  },
}

/**
 * A budget that FITS each preset over the reference workload, in tokens.
 *
 * PLANNING figures, and nothing reads them at run time — `ledger.ts:102-105` is
 * explicit that MAD cannot know what a turn will bill before it bills it, so a
 * promise here would be a fabricated number in front of a real one. They exist
 * to be printed in the tool's argument description, so a caller has somewhere to
 * start, and to be the budget CAP-7's acceptance test runs `normal` inside.
 *
 * The arithmetic is in the story's Design Notes and reproduces from three
 * per-turn figures (discovery ~10k, debate ~12k, judge ~6k) over a ~400-line
 * change with three pool slots and ~10 canonical findings. Each carries ~1.4x
 * headroom over its expected total.
 */
export const SUGGESTED_BUDGET: Readonly<Record<Preset, number>> = {
  quick: 250_000,
  normal: 400_000,
  paranoid: 550_000,
}

/**
 * The preset, clamped — exported so the bound is TESTED rather than trusted,
 * the pattern `clampTokenCap`, `clampThreshold` and `clampMaxRounds` all set.
 *
 * `review()` is an exported seam and the value can arrive from a model through
 * the adapter, so "not one of the three" is reachable and its answer is the
 * default rather than a throw: AD-15's exhaustion rule generalises — a request
 * MAD cannot honour is an outcome, not an error. Absent and unusable are the
 * same request, and `normal` is the identity, so both resolve to the run this
 * repo already shipped.
 */
export function clampPreset(preset: string | undefined | null): Preset {
  return (PRESETS as readonly string[]).includes(preset as string)
    ? (preset as Preset)
    : DEFAULT_PRESET
}

/** The three stages that issue billed turns, and the only three. */
export type SpendStage = "discover" | "debate" | "judge"

/**
 * How far into the run's ONE cap each stage may take the total.
 *
 * CUMULATIVE, not a per-stage pot — `shares.debate` is "debate may take the run
 * to 65% of the cap", counting everything discovery already spent. The stages
 * run strictly in sequence in `review.ts`, so when a stage asks, `spent(ledger)`
 * is exactly "everything before me, plus me so far", and a cumulative ceiling on
 * that one number is arithmetically identical to a per-stage allowance — with no
 * per-stage counter to drift, no grouping of `ledger.entries` by the untyped
 * `stage` label, and no second field that can disagree with `cap`
 * (`run-record.ts` gives that reason for `cap` riding on the ledger at all).
 *
 * It also rolls unspent budget FORWARD for free: a cheap discovery hands its
 * remainder to debate. A per-stage pot does the opposite — it strands findings
 * while money sits unspent in a bucket nobody reaches, and then reports "the
 * budget ran out" over a budget that did not.
 *
 * FRACTIONS, never token numbers. A stored token ceiling is a second value
 * derived from `cap` that can stop agreeing with it; a fraction is re-derived at
 * every ask, from whatever cap is actually in force.
 */
export interface SpendShares {
  discover: number
  debate: number
  /** Always `1`. See `clampSpendShares`. */
  judge: number
}

/**
 * 30 / 65 / 100.
 *
 * Expected per-stage fractions of a run are quick 17/40/43, normal 11/40/49,
 * paranoid 16/29/55. Discovery's share is rounded generously UP to 30% because
 * it must cover a retry-heavy run — every slot retrying DOUBLES discovery, which
 * is 24% of quick's suggested budget and 22% of paranoid's — and because a
 * truncated discovery is the most expensive kind of cheapness: it costs the
 * co-discovery denominator every later stage divides by. Debate's cumulative 65%
 * leaves at least 1.2x headroom over the worst case in all three columns.
 *
 * The judge's is 1 BY CONSTRUCTION and not by choice: a judge share below 1
 * would make part of the stated cap unreachable, which is a ceiling that lies to
 * the reader.
 */
export const CUMULATIVE_SHARE: SpendShares = {
  discover: 0.3,
  debate: 0.65,
  judge: 1,
}

/**
 * The shares, clamped.
 *
 * Four rules, and each one exists because the value is reachable from a
 * JavaScript caller through the `review()` seam:
 *
 * - **Anything non-numeric or NaN anywhere resets the WHOLE object**, rather
 *   than that one field. A half-clamped share table is a ceiling nobody
 *   requested sitting between two that somebody did; `clampTokenCap`'s reasoning
 *   for NaN applies with more force here, because `spent < NaN` is `false` for
 *   every spend and an unclamped NaN discovery share refuses the first turn of
 *   the run.
 * - **Each share is clamped into `[0, 1]`.** Above 1 is a ceiling above the cap,
 *   which is not a ceiling; below 0 is a request to spend nothing, and `0` says
 *   that already.
 * - **Monotonicity is FORCED, not rejected.** `debate` becomes
 *   `max(discover, debate)`, because a debate ceiling below discovery's is a
 *   stage whose ceiling is already spent before it starts — a gate that refuses
 *   every turn for a reason no reader could reconstruct. Forcing it is the same
 *   call `clampMaxRounds` makes: a caller who asked for something incoherent
 *   gets the nearest coherent thing rather than a silent dead stage.
 * - **`judge` is forced to 1** and the caller's value is DISCARDED. See
 *   `CUMULATIVE_SHARE`.
 */
export function clampSpendShares(shares: Partial<SpendShares> | undefined | null): SpendShares {
  const discoverRaw = shares?.discover ?? CUMULATIVE_SHARE.discover
  const debateRaw = shares?.debate ?? CUMULATIVE_SHARE.debate
  if (
    typeof discoverRaw !== "number" ||
    !Number.isFinite(discoverRaw) ||
    typeof debateRaw !== "number" ||
    !Number.isFinite(debateRaw)
  ) {
    return { ...CUMULATIVE_SHARE }
  }
  const discover = Math.min(Math.max(discoverRaw, 0), 1)
  const debate = Math.min(Math.max(Math.max(discoverRaw, debateRaw), 0), 1)
  return { discover, debate, judge: 1 }
}
