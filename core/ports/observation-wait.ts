/**
 * Story 2-7c — ONE BOUNDED WAIT FOR AN OBSERVER WRITE, shared by the two layers
 * that make one.
 *
 * `core/stages/judge.ts` and `adapters/opencode/tools.ts` each hold an
 * `observe()` helper that awaits a `ToolObservation` write. An unbounded await
 * there lets a sink that never settles stall the judge one finding at a time,
 * and `core/ports/tool-observation.ts` contracts only that a write may REJECT —
 * so a write that never answers has no contracted meaning of its own. This file
 * gives it one.
 *
 * ## Why it lives under `core/ports/`
 *
 * It is the smallest legal home for something BOTH sides call.
 * `scripts/lint-dependency-direction.ts` lets `adapters/` import `core/` and
 * forbids the reverse (AD-1), and both callers already import
 * `./tool-observation.ts` from here, so a module beside it reverses no arrow and
 * adds no dependency either side did not already have. It is a policy, not a
 * port: no interface here widens, and `ToolObservation` is untouched.
 *
 * ## What it is not
 *
 * NOT A SCHEDULER. One promise, one deadline, three outcomes. There is no queue,
 * no retry, no backoff and no cancellation: a write that has been abandoned is
 * abandoned for the run, because the observation it carried is incomplete and no
 * later attempt can make that finding's trace whole again.
 *
 * NOT `TurnTimedOutError`. `adapters/opencode/model-backend.ts` bounds a MODEL
 * TURN with that error and maps it to a `transport-error` drop-out, which is a
 * statement about a provider. An observer write that hangs says nothing about
 * any model, and a shared error type would let a trace bug be reported as one.
 * The outcomes here are plain values for that reason — a timeout is not an
 * exception, it is an answer.
 */

/**
 * FIVE SECONDS PER OBSERVER WRITE, fixed, with no user-facing dial.
 *
 * The same number `adapters/opencode/model-backend.ts`'s
 * `DEFAULT_CLEANUP_TIMEOUT_MS` uses, for the same reason: one local append to a
 * file on the machine MAD is already running on is not slow, and a sink that has
 * not answered in five seconds will not be quicker if the judge waits fifty.
 * What sets the ceiling is that EVERY observed decision point pays it — six call
 * sites in the judge and two in the adapter, per finding — so a generous
 * deadline multiplies straight into how long a broken trace takes to stop a run.
 *
 * CAP-7 froze the tool's dials at the preset and the budget, so this is a
 * constant rather than a flag, a config key or an environment variable. The
 * `ms` parameter below is a construction seam for tests and for the two option
 * objects that carry it, never a knob a user sees.
 */
export const OBSERVATION_WRITE_TIMEOUT_MS = 5_000

/**
 * THE BOUND A `ToolObservation` IMPLEMENTATION PUTS ON ITS OWN PHYSICAL I/O, and
 * it is deliberately SHORTER than the caller's above.
 *
 * ## Why the two must not be equal
 *
 * They are nested, not parallel. The judge calls `sink.request(...)`, the sink
 * queues an append and starts its own timer, and the judge then waits on the
 * promise it got back. If the JUDGE'S timer wins, the judge is released — and
 * may go on to the next model request — while the sink has not yet decided that
 * its append is unresolved, so the runner has not yet latched its stop. The
 * quarantine would then arrive one model request too late.
 *
 * Two things close that, and both are needed:
 *
 * 1. **The inner deadline is strictly shorter.** A thousand milliseconds of
 *    headroom, which is an eternity for a local append and still leaves the
 *    outer bound at the five seconds the policy above fixes.
 * 2. **The inner timer starts at ENQUEUE, not when the queued task runs.** A
 *    sink that only started counting when its turn came could sit behind another
 *    operation for longer than the caller's whole deadline, and a shorter
 *    duration started later is not shorter at all.
 *
 * `observationIoDeadlineProblem` is what stops a later edit from setting these
 * two numbers equal, or from inverting them, without a test noticing.
 *
 * WHAT THAT GUARD COVERS. By default it compares an implementation's deadline
 * against the constant above, which is the bound the shipped callers use —
 * `core/stages/judge.ts` and `adapters/opencode/tools.ts` both take it by
 * default, and `ablation/adversarial.ts` wires the adversarial path with both
 * defaults in force. A caller that overrides its own bound DECLARES it instead,
 * and the guard then checks the real pair rather than the shipped one, so an
 * inverted override is refused at construction where it is written.
 *
 * WHAT IT STILL DOES NOT COVER. A caller that overrides and declares nothing is
 * checked against the shipped constant, so the ordering it gets is claimed for
 * what it declared rather than for what it does. Closing that for every
 * construction the types allow would need the sink to learn that its caller had
 * abandoned a write, which `ToolObservation` cannot express without widening.
 */
export const OBSERVATION_IO_TIMEOUT_MS = 4_000

/**
 * The largest delay `setTimeout` can actually hold.
 *
 * Past this the duration overflows a signed 32-bit integer and the timer fires
 * IMMEDIATELY — so a deadline of a month (about 2,592,000,000 ms) is not a
 * generous deadline, it is no deadline at all. The same trap in the other
 * direction is a zero, a negative or a `NaN`: all three schedule for right now,
 * which turns a bound into an unconditional failure that looks like a hang
 * nobody can reproduce.
 */
export const MAX_TIMER_MS = 2_147_483_647

/**
 * Why `ms` cannot be used as a deadline, or `null`.
 *
 * TOTAL AND EXPLICIT, because every caller here takes its value from a
 * construction option. A bad one must be refused where it is supplied, not
 * discovered later as a timer that fired at once.
 */
export function deadlineProblem(name: string, ms: number): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return `${name} must be a finite number of milliseconds, and ${String(ms)} is not one`
  }
  if (ms <= 0) {
    return `${name} must be greater than zero, and ${ms} would make the deadline fire immediately`
  }
  if (ms > MAX_TIMER_MS) {
    return (
      `${name} must be at most ${MAX_TIMER_MS}ms (the largest delay a timer can hold), and ${ms} ` +
      `would overflow and fire immediately`
    )
  }
  return null
}

/**
 * Why `ms` cannot be an observation implementation's own I/O deadline, or `null`.
 *
 * Adds the NESTING rule to the checks above: an inner deadline at or past the
 * caller's is not an inner deadline. See `OBSERVATION_IO_TIMEOUT_MS`.
 */
export function observationIoDeadlineProblem(ms: number, callerMs: number = OBSERVATION_WRITE_TIMEOUT_MS): string | null {
  const problem = deadlineProblem("an observation I/O deadline", ms)
  if (problem !== null) return problem
  if (ms >= callerMs) {
    return (
      `an observation I/O deadline must be strictly shorter than the ${callerMs}ms ` +
      `a caller waits (${ms}ms is not), or the caller is released before the sink has decided its ` +
      `write is unresolved — and the quarantine then lands one model request too late`
    )
  }
  return null
}

/**
 * What one bounded observer write did.
 *
 * `timed-out` IS ITS OWN OUTCOME AND NOT A REJECTION, which is the distinction
 * the whole file exists for. A rejection means the sink answered and said no; a
 * timeout means the sink said nothing, so the observation is INCOMPLETE and the
 * physical write may still be in flight. A caller that folded them together
 * would report an unresolved append as a settled failure, which is the one
 * reading that lets a later run reuse a file an earlier write still holds.
 */
export type ObservationWaitOutcome =
  | { kind: "settled" }
  | { kind: "rejected"; error: unknown }
  | { kind: "timed-out"; ms: number }

/**
 * Await one observer write for at most `ms`.
 *
 * THE LATE SETTLEMENT IS CONSUMED, NEVER FLOATED. `Promise.race` attaches a
 * handler to every entry it is given, and the entry here is the ALREADY-HANDLED
 * `started.then(ok, err)` — so a rejection that arrives after the timer won is
 * absorbed there rather than surfacing as an unhandled rejection in a run that
 * has moved on. That is the same shape `model-backend.ts`'s cleanup race uses,
 * and it is the reason the value is folded into the outcome inside `then`
 * instead of being caught around the race.
 *
 * THE TIMER IS ALWAYS CLEARED, on every path, including the rejecting one. An
 * uncleared five-second timer per write would hold the event loop open past the
 * end of a run and make a test's teardown depend on the wall clock.
 *
 * A SYNCHRONOUS THROW FROM `write` IS A REJECTION. A sink that throws before
 * returning its promise has answered, and answering badly is not hanging.
 */
export interface ObservationWaitOptions {
  /**
   * How long to wait, in milliseconds. Defaults to `OBSERVATION_WRITE_TIMEOUT_MS`.
   *
   * NAMED RATHER THAN POSITIONAL, on `adapters/opencode/model-backend.ts`'s
   * precedent and for its reason: a bare number at a call site says nothing
   * about which of a nested pair of deadlines it is, and the two here differ by
   * one second and decide whether a quarantine lands before the next model
   * request or after it.
   */
  timeoutMs?: number
}

export async function awaitObservationWrite(
  write: () => Promise<void>,
  options: ObservationWaitOptions = {},
): Promise<ObservationWaitOutcome> {
  const ms = options.timeoutMs ?? OBSERVATION_WRITE_TIMEOUT_MS
  let started: Promise<void>
  try {
    started = write()
  } catch (error) {
    return { kind: "rejected", error }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race<ObservationWaitOutcome>([
      started.then(
        (): ObservationWaitOutcome => ({ kind: "settled" }),
        (error: unknown): ObservationWaitOutcome => ({ kind: "rejected", error }),
      ),
      new Promise<ObservationWaitOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timed-out", ms }), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The reason text a timed-out write is reported under, in one place so the core
 * half and the adapter half cannot drift into two different sentences about the
 * same event.
 *
 * It names the WRITE and the DURATION, because the warning that carries it folds
 * every failure of a run into one message and "a write timed out" without either
 * is a sentence a reader can do nothing with. It says the physical write may
 * still be running, because that is the fact that decides whether the file
 * behind it is safe to reuse — and claiming it stopped would be the invented
 * half of AD-6's failure.
 */
export function observationTimeoutReason(write: string, ms: number): string {
  return (
    `the ${write} observation was abandoned after ${ms}ms: the sink did not answer, so this ` +
    `observation is INCOMPLETE and the write it started may still be running — it is not ` +
    `recorded as having failed and it is never recorded as having succeeded`
  )
}
