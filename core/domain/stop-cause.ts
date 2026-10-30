/**
 * WHO STOPPED A RUN (spec-mad-v1-readiness CAP-3).
 *
 * A run's stop arrives as an aborted `AbortSignal`. Ordinarily that is the
 * user's stop, and every MAD-authored sentence about it says "you stopped".
 * MAD can also stop a run itself: the plugin does when a review session's
 * permission rules come back from the host different from the ones it sent. It
 * aborts with a `MadStop` as the signal's reason, and the sentences read the
 * cause from there.
 *
 * Any other reason, a host's included, is the user's stop. A caller that never
 * aborts with a `MadStop` gets exactly the wording it always had.
 */

/** Why the run stopped. `"user"` is every stop MAD did not make itself. */
export type StopCause = "user" | "session-policy"

/** The abort reason MAD uses when it stops a run itself. */
export class MadStop {
  constructor(readonly cause: Exclude<StopCause, "user">) {}
}

/** The cause behind an aborted signal; `"user"` unless MAD aborted it. */
export function stopCauseOf(signal: AbortSignal | undefined): StopCause {
  const reason: unknown = signal?.reason
  return reason instanceof MadStop ? reason.cause : "user"
}

/** "… you stopped the run", as each cause says it. */
export function stoppedTheRun(cause: StopCause): string {
  return cause === "user" ? "you stopped the run" : "MAD stopped the run (a review session's permission rules could not be verified)"
}

/** "… you stopped this run", as each cause says it. */
export function stoppedThisRun(cause: StopCause): string {
  return cause === "user" ? "you stopped this run" : "MAD stopped this run (a review session's permission rules could not be verified)"
}
