/**
 * AD-15 amended (story 7A) — the accountant's PEAK half.
 *
 * `ledger.ts` answers "may I spend?" over the run's TOTAL. This answers "may I
 * spend it all at once?" — the same budget observed at a second time scale.
 * Splitting the two across two owners is how a stage ends up metering itself,
 * which AD-15's first sentence forbids, so both live in `core/budget/` and
 * `ledger.ts` re-exports this module. No stage constructs a limiter.
 *
 * THE NUMBER THIS EXISTS FOR: at the shipped ceilings `core/stages/discover.ts`
 * starts `MAX_DISCOVERY_SLOTS` 12 + `MAX_LENS_SLOTS` 8 = twenty simultaneous
 * billed sessions against one user's credentials, through a single `Promise.all`.
 * `core/stages/debate.ts` fans out a round the same way, `maxRounds` times.
 * Without a limiter, provider rate limiting arrives as a `model-dropped-out`
 * warning that names — and blames — a model that was working fine: a FALSE
 * degradation report, in the one tool whose thesis is that degradation is
 * reported honestly.
 *
 * ## It is not a gate, and the difference is load-bearing
 *
 * `mayISpend` REFUSES: a refusal is a degradation, and it costs the finding an
 * `unresolved` mark and the run a warning (AD-6d). This WAITS. Waiting is
 * backpressure and costs wall-clock only — no warning, no `unresolved`, no
 * finding treated as undecided. Conflating the two would produce exactly the
 * false report described above with a different cause: a model blamed for a
 * queue.
 *
 * ## It changes concurrency and never order
 *
 * Callers keep the shape they already have — `Promise.all(items.map(i =>
 * limiter.run(() => turn(i))))`. `Promise.all` still resolves POSITIONALLY, so
 * every "the outcomes are in roster order however the network behaved" contract
 * in `discover.ts`, `debate.ts` and `judge.ts` stays true word for word. The only
 * thing that changes is how many of those turns are in flight at any moment.
 *
 * Imports nothing at all (AD-1). No port, no stage, no adapter, no domain — which
 * is what lets `core/domain/run-record.ts` import `DEFAULT_MAX_CONCURRENCY` from
 * here without a cycle. The number is defined HERE, beside the reasoning for it,
 * rather than beside the field it defaults; the alternative was the same value
 * written in two files, which is the failure mode this codebase has recorded
 * against itself three times (`DISCLOSURE_CODES`, `LINE_BREAKS`, `oneLine`).
 */

/**
 * How many billed turns a run may have in flight at once, by default.
 *
 * FOUR, and the number is a floor on parallelism as much as a ceiling on it.
 * Discovery's whole recall mechanism is heterogeneity across models (CAP-1), and
 * a limit of 1 would turn the fan-out into a sequence — the failure
 * `discover.ts` explicitly guards against ("every turn is started before any is
 * awaited, so peak concurrency equals the slot count rather than the fan-out
 * degenerating into a sequence"). Four keeps the default roster of three pool
 * slots fully parallel with room to spare, and it is well under any provider's
 * per-key concurrency allowance.
 *
 * It is a DEFAULT, not a policy. Story 8 owns the user-facing number and the
 * preset that moves it; this story owns the mechanism and this starting value.
 */
export const DEFAULT_MAX_CONCURRENCY = 4

/**
 * The ceiling on the ceiling.
 *
 * Sixteen is above any fan-out MAD can actually produce — the widest is
 * discovery's twenty, and a limit at or above the fan-out is the same as no
 * limit at all — so this exists to stop `maxConcurrency: 10000`, not to tune
 * anything. `MAX_DISCOVERY_SLOTS` and `MAX_LENS_SLOTS` carry the same kind of
 * bound in the adapter, for the same reason: the value can arrive from outside.
 */
export const MAX_CONCURRENCY = 16

/**
 * The limit, clamped — exported so the bound is TESTED rather than trusted, the
 * pattern `clampThreshold`, `clampMaxRounds` and `clampTokenCap` all set.
 *
 * `review()` is an exported seam and TypeScript does not police a JavaScript
 * caller, so every failure mode below is reachable from outside. The four cases
 * are `clampTokenCap`'s four, and THREE OF THE ANSWERS DIFFER — which is why
 * this is written out rather than pointed at:
 *
 * - **Not a number, or NaN, is the DEFAULT.** `clampTokenCap` answers "no
 *   ceiling" because absence of a budget is a coherent request. Absence of a
 *   concurrency limit is not: it is the twenty-simultaneous-sessions state this
 *   module exists to remove, and it is not what a caller passing rubbish asked
 *   for. There is no "unlimited" value here, by design.
 * - **Zero and negative are ONE, not the default and not zero.** A limit of zero
 *   permits no turn ever and would deadlock the run — the one answer that turns
 *   a resource bound into a hang. One is the nearest honest reading of "as
 *   little parallelism as possible", and it still completes.
 * - **Infinity is the MAXIMUM, not the default.** `Infinity` is an explicit
 *   request for more, so it lands on the ceiling rather than quietly becoming
 *   the default — the same call `clampDiscoverySlots` makes, and for the same
 *   stated reason.
 * - **Fractional floors.** Turns are whole; 2.9 in flight is 2.
 */
export function clampConcurrency(max: number | undefined | null): number {
  if (typeof max !== "number" || Number.isNaN(max)) return DEFAULT_MAX_CONCURRENCY
  return Math.min(Math.max(Math.floor(max), 1), MAX_CONCURRENCY)
}

/**
 * The peak accountant, seen from the side a stage uses.
 *
 * `max` is restated on the object so a caller can assert what bound it actually
 * got without reaching back to the ledger — the same reason `BudgetLedger`
 * restates `cap`.
 */
export interface ConcurrencyLimiter {
  /** The bound actually in force, already clamped. */
  readonly max: number
  /** How many are in flight right now. For tests and diagnostics only. */
  readonly inFlight: number
  /**
   * Run `fn` when a slot frees up, and release the slot when it settles.
   *
   * REJECTIONS RELEASE TOO. A stage's turn runner converts a throw into a
   * failure envelope before it reaches here, so this should never see one — but
   * "should never" plus a permanently consumed slot is a deadlock, and the whole
   * point of this object is that it never becomes the reason a run stops.
   */
  run<T>(fn: () => Promise<T>): Promise<T>
}

/**
 * A counting semaphore, FIFO.
 *
 * FIFO matters for one reason and it is not fairness: the waiters are turns
 * whose results are collected positionally, and a run that admits them in a
 * different order every time makes the ledger's completion-order entries — and
 * any wall-clock reading of the artifact dump — noise rather than a record. It
 * costs nothing: a shifted array of at most the fan-out width.
 */
export function createLimiter(max: number): ConcurrencyLimiter {
  const bound = clampConcurrency(max)
  const waiting: (() => void)[] = []
  let inFlight = 0

  /**
   * THE SLOT IS TRANSFERRED, NOT RELEASED AND RE-TAKEN.
   *
   * The obvious shape — decrement, then wake a waiter that increments again —
   * has a hole, because the woken waiter resumes on a later microtask: a fresh
   * caller arriving in between sees the decremented count, takes the slot, and
   * the waiter then increments on top of it. The bound is exceeded by one per
   * hand-off, silently, and only under load, which is the only condition anyone
   * would run this under. So `inFlight` stays where it is and the slot passes
   * straight to the next waiter; it is decremented only when nobody is queued.
   */
  const acquire = async (): Promise<void> => {
    if (inFlight < bound) {
      inFlight += 1
      return
    }
    await new Promise<void>((resolve) => waiting.push(resolve))
  }

  const release = (): void => {
    const next = waiting.shift()
    if (next) next()
    else inFlight -= 1
  }

  return {
    max: bound,
    get inFlight() {
      return inFlight
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire()
      try {
        return await fn()
      } finally {
        release()
      }
    },
  }
}
