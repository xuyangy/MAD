/**
 * The `Progress` port — what a review reports about itself while it runs.
 * Interfaces and one guard only (AD-1).
 *
 * A snapshot is MAD's own counters, read from the record the run is building:
 * the stage being entered, the time since the run started, and the ledger's
 * observed tokens. Nothing in it is model-authored, so a host can show it
 * without framing it as material (AD-18).
 *
 * A sink observes; it decides nothing. The run never waits for it and never
 * learns whether it failed, so a review with a sink renders the same report as
 * one without.
 */

/** The stages a snapshot can name, in the order a run enters them. */
export const PROGRESS_STAGES = ["discover", "cluster", "route", "debate", "judge", "output"] as const
export type ProgressStage = (typeof PROGRESS_STAGES)[number]

/**
 * `running` on every snapshot but the last. The last one is `finished`, or
 * `stopped` when the record carries a cancellation.
 */
export type ProgressState = "running" | "finished" | "stopped"

export interface ProgressSnapshot {
  runId: string
  /** The stage being entered, or, on the last snapshot, `output`. */
  stage: ProgressStage
  state: ProgressState
  /**
   * Milliseconds from the run's `startedAt` to now, or to `finishedAt` on the
   * last snapshot. `null` when either timestamp does not parse: an injected
   * clock is not bound to real time.
   */
  elapsedMs: number | null
  /** Every token the ledger has counted so far (`spentTokens` of its total). */
  observedTokens: number
  /** Turns MAD issued whose usage it does not know. Not included above. */
  unknownUsageTurns: number
  /** The ledger's ceiling, `null` when the run has none. */
  cap: number | null
}

export interface ProgressSink {
  report(snapshot: ProgressSnapshot): void
}

/**
 * Hands one snapshot to the sink and swallows anything the sink throws, so a
 * failing observer cannot change the review it observes.
 */
export function reportProgress(sink: ProgressSink | undefined, snapshot: ProgressSnapshot): void {
  if (sink === undefined) return
  try {
    sink.report(snapshot)
  } catch {
    // Deliberately dropped: see the module comment.
  }
}
