/**
 * AD-2 / AD-12 — `ModelBackend` over opencode.
 *
 * THE V1/V2 TRAP (story 1 design notes): `PluginInput.client` is the v1 SDK
 * client and silently lacks a `format` parameter. Structured output — which
 * AD-12 requires, since hand-parsing JSON out of prose is exactly what it
 * forbids — needs a separately constructed v2 client, whose `session.prompt`
 * accepts `format: { type: "json_schema", schema }` and returns the parsed
 * result on `AssistantMessage.structured` (`structured`, NOT
 * `structured_output`; the docs are wrong).
 *
 * Provider and model errors are RETURNED on `AssistantMessage.error`, not
 * thrown, and transport errors are returned too. Both become domain outcomes on
 * the envelope (spine, Errors), never exceptions.
 */

import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { z, type ZodType } from "zod"

import type { RosterSlot } from "../../core/domain/roster.ts"
import type { TokenUsage } from "../../core/domain/run-record.ts"
import type { LateUsageReporter } from "../../core/ports/late-usage.ts"
import {
  abandonedTurn,
  cancelledTurn,
  type BackendCapabilities,
  type CleanupUnresolved,
  type Envelope,
  type ModelBackend,
  type UsageUnknown,
} from "../../core/ports/model-backend.ts"

type V2Client = ReturnType<typeof createOpencodeClient>

/**
 * The parts of `AssistantMessage` this adapter reads. `structured` is where the
 * parsed `format` result lands — `structured`, not `structured_output`.
 */
interface AssistantMessageLike {
  error?: unknown
  structured?: unknown
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
}

/**
 * What `session.prompt` resolves to, as much of it as this adapter reads.
 *
 * The generated `RequestResult` is a union whose success branch has no `error`
 * member; this is the shape BOTH branches satisfy. It was an inline annotation
 * on the `result` local until story 2.3, and it is named now because a second
 * reader appeared: AC2's abandoned-request continuation is handed the same
 * settled value long after `runTurn` returned, and two structurally identical
 * inline annotations for one payload is one field edit away from a continuation
 * that reads a token field the prompt path does not.
 */
interface PromptResultLike {
  data?: { info?: AssistantMessageLike }
  error?: unknown
}

/**
 * FR10 / AC1 (story 2.3) — WHAT ONE SETTLED TURN SAYS ABOUT ITS OWN BILL, as
 * one of exactly two answers.
 *
 * A UNION AND NOT A TWO-OPTIONAL-FIELD OBJECT, deliberately. It is spread into
 * all five outcome envelopes below (`model-error`, `empty-response`, both
 * `schema-invalid` returns, and the success branch), and the property that has
 * to hold at every one of them is that a `tokens` KEY IS ABSENT whenever the
 * host reported no usage. `{ tokens?: TokenUsage; usageUnknown?: UsageUnknown }`
 * would type-check a producer that set both, and — since
 * `exactOptionalPropertyTypes` is off in this repository — one that set
 * `tokens: undefined`, which makes `"tokens" in envelope` TRUE and the field
 * present-but-empty. Present-but-empty is the state story 2.3 exists to delete;
 * the union has nowhere to put it.
 */
type UsageAnnotation = { tokens: TokenUsage } | { usageUnknown: UsageUnknown }

/**
 * The three `why` strings, as constants rather than as inline literals.
 *
 * `UsageUnknown.why` is mandatory and non-empty because "the host reported
 * nothing", "timed out" and "cancelled in flight" are three different facts that
 * a reader — and story 2.3's experiment governor — act on differently. They are
 * named here so the three cannot drift into paraphrases of each other, and so a
 * test can assert the DISTINCTION rather than a substring that happens to appear
 * in all three.
 *
 * They describe the gap and never estimate it (AC1): no number, no
 * "approximately", nothing a later reader could mistake for a figure.
 */
const HOST_REPORTED_NO_USAGE = "the turn settled and the host reported no usage for it"

const CANCELLED_IN_FLIGHT =
  "the run was cancelled while this turn was in flight, so the request was issued and " +
  "its usage was never reported"

/**
 * The transport threw AFTER the prompt went out, and that is a different
 * sentence from the other two on purpose.
 *
 * A cancellation and a timeout both know the request was issued and is running.
 * This one does not know even that: the throw covers a connection refused before
 * a byte left the process AND a socket that hung up mid-answer, and nothing in
 * the error distinguishes them. So the reason says MAY have been billed rather
 * than was — a reader comparing two runs must be able to tell "MAD knows it
 * spent something it cannot count" from "MAD cannot tell whether it spent
 * anything", because only the first is certainly money.
 */
function failedInFlight(): string {
  return (
    "the transport failed after the request was sent, so the provider may have received " +
    "and billed it, and its usage was never reported"
  )
}

function timedOutInFlight(ms: number): string {
  return (
    `the turn timed out at its ${ms}ms deadline while in flight, so the request was issued ` +
    `and its usage was never reported`
  )
}

export interface OpencodeBackendOptions {
  /** The opencode server URL from `PluginInput.serverUrl`. */
  serverUrl: URL | string
  /** The project directory from `PluginInput.directory`. */
  directory: string
  /** The resolved roster — maps a MAD slot id to a concrete host model. */
  slots: readonly RosterSlot[]
  /**
   * Host tools this turn may use, as opencode's per-call allowlist. A spawned
   * session gets host tools by default; passing `{}` leaves that default alone.
   * (AD-13's real mechanism — see the note on `capabilities` below.)
   */
  tools?: Record<string, boolean>
  /** Injected in tests. Defaults to a real v2 client against `serverUrl`. */
  client?: V2Client
  /**
   * How long one turn may hang before it becomes a `transport-error` drop-out.
   * `discover` documents timeout as a drop-out cause (AD-6b); without a deadline
   * that case could never fire and a hung provider stalled the whole fan-out.
   */
  timeoutMs?: number
  /**
   * AC3 (story 2.3) — HOW LONG SESSION DISPOSAL MAY TAKE.
   *
   * A SECOND, MUCH SHORTER DEADLINE, and a separate dial rather than a reuse of
   * `timeoutMs` above. The two bound different things: `timeoutMs` bounds a
   * frontier model thinking about a large diff, and this bounds one local host
   * round trip that deletes a row. Sharing the dial would mean a hung
   * `session.delete` holding the turn open for ten minutes — which is
   * indistinguishable, from every caller's point of view, from the unbounded
   * `await` this story removed.
   *
   * It is an ADAPTER option and not a `core/` dial, deliberately: no stage and
   * no accountant has any business knowing that a session exists, let alone how
   * long deleting one may take (AD-1, AD-2 — the port is "run one turn, return
   * an envelope").
   *
   * THE SHIPPED HOST PASSES NEITHER THIS NOR `timeoutMs`, and that is a
   * deliberate symmetry rather than an omission. `adapters/opencode/plugin.ts`
   * constructs the backend with a roster and nothing else, because there is no
   * user-facing surface for either deadline — CAP-7 froze the tool's dials at
   * the preset and the budget. Giving the shorter of two sibling deadlines the
   * only configuration path would leave a reader unable to guess where the other
   * one comes from. The option is the seam a host or a test sets, and this file
   * is where the default that answers for both lives.
   */
  cleanupTimeoutMs?: number
  /**
   * AC2 (story 2.3) — WHERE USAGE THAT ARRIVES TOO LATE GOES.
   *
   * The WRITE HALF ONLY (`core/ports/late-usage.ts`): an adapter may report and
   * may not `drain()`, so a backend cannot read or clear the usage the run is
   * about to recover into its record.
   *
   * OPTIONAL, and an ordinary code review passes none — the continuation is then
   * never attached at all, so a fresh install allocates nothing and holds no
   * abandoned promise for a run that has finished. `core/run/review.ts` is what
   * builds a sink and hands this half over when there is something to reconcile.
   */
  lateUsage?: LateUsageReporter
}

/** Ten minutes: long enough for a slow frontier model on a large diff. */
const DEFAULT_TURN_TIMEOUT_MS = 600_000

/**
 * Five seconds for a `session.delete`, and the asymmetry with the ten minutes
 * above is the point.
 *
 * Deleting a session is one local round trip to the opencode server, so five
 * seconds is already far outside the range a healthy host answers in — and a
 * host that has not answered in five is not going to be quicker if MAD waits
 * fifty. What sets the ceiling is that EVERY turn pays this on its way out and
 * discovery issues twenty of them, so a generous cleanup deadline is a generous
 * multiplier on how long a stopped run takes to actually stop (AC3:
 * "cancellation stays responsive").
 */
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000

function mapTokens(tokens: {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}): TokenUsage {
  // AD-15 — budget in these integers, never in `cost`, whose unit the SDK does
  // not document.
  return {
    input: tokens.input ?? 0,
    output: tokens.output ?? 0,
    reasoning: tokens.reasoning ?? 0,
    cacheRead: tokens.cache?.read ?? 0,
    cacheWrite: tokens.cache?.write ?? 0,
  }
}

function describeError(error: unknown): string {
  if (!error) return "unknown error"
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  const record = error as { name?: string; data?: { message?: string } }
  if (record.name || record.data?.message) {
    return `${record.name ?? "error"}: ${record.data?.message ?? ""}`.trim()
  }
  // Deliberately NOT `JSON.stringify(error)`: SDK error objects routinely carry
  // the originating request config, including auth headers, and this string
  // flows into user-visible warnings and the run record. Describe the shape,
  // never dump it.
  const name = (error as { constructor?: { name?: string } })?.constructor?.name
  return name && name !== "Object" ? `${name} (no message)` : "unrecognized error (no message)"
}

/**
 * Thrown when the USER's signal fires while a turn is in flight, so the catch
 * below can tell it apart from a timeout and from a transport failure.
 *
 * The three all mean "stop waiting" and they are three different facts about the
 * run: a timeout is a drop-out and earns AD-6(b)'s retry, a transport failure is
 * a drop-out too, and a cancellation is neither. One `Error` for all three would
 * make the user's stop indistinguishable from a provider that hung — which is
 * the one confusion AD-2's amendment exists to prevent.
 */
class TurnCancelledError extends Error {
  constructor() {
    super("the run was cancelled while this turn was in flight")
    this.name = "TurnCancelledError"
  }
}

/**
 * AC1 / AC3 (story 2.3) — thrown when the DEADLINE fires while a turn is in
 * flight, so the catch below can mark that turn's usage unknown.
 *
 * BESIDE `TurnCancelledError` AND FOR THE SAME REASON, one step further. Story
 * 7A separated the user's stop from a transport failure because they are
 * different facts about the run; this separates the third: a request MAD sent
 * and stopped waiting for. It was an anonymous `new Error(...)` inside
 * `withTimeout`, which the catch had no way to tell apart from a genuine
 * transport failure: both became one `transport-error` envelope. That was fine
 * while the two facts had the same consequence, and became a lie the moment one
 * of them had to carry a usage marker and the other must not. The alternative —
 * matching on the message text — is the kind of test-passing,
 * production-failing coupling both typed errors in this file exist to avoid.
 *
 * WHAT IT DELIBERATELY DOES NOT CHANGE: the envelope it produces is still
 * `failure: "transport-error"`. `TurnFailure` gains no `timeout` member in this
 * story, so a timed-out turn keeps AD-6(b)'s retry classification exactly as it
 * was (`evaluation-protocol.md:311-327` pins it, and `model-backend.test.ts`
 * asserts it beside the new marker). The typed error is internal to this
 * adapter; nothing outside the file can see it, and the port's five failures are
 * untouched.
 *
 * `ms` rides on the error because the reason string names the deadline that
 * fired, and reconstructing it at the catch site would mean two places that
 * think they know which deadline this was.
 */
class TurnTimedOutError extends Error {
  constructor(readonly ms: number) {
    // The wording is UNCHANGED from the anonymous error it replaces. It reaches
    // the user through `Envelope.message`, and `discover` documents timeout as a
    // drop-out cause in these words (AD-6b).
    super(`turn timed out after ${ms}ms`)
    this.name = "TurnTimedOutError"
  }
}

/**
 * A provider that never answers must not stall the whole fan-out. The port is
 * request/response (AD-2), so a hung call has no other way to become the
 * timeout drop-out that `discover` already documents (AD-6b).
 *
 * STORY 7A — the user's stop races here too, and it composes with the deadline
 * rather than replacing it. Both are "stop waiting"; they reject with different
 * errors so the caller can report different facts. The abort listener is removed
 * in the same `finally` the timer is cleared in, for the same reason: a listener
 * left on a long-lived `AbortSignal` is a leak that grows with the number of
 * turns, and discovery issues twenty of them.
 *
 * NOTE WHAT THIS DOES NOT DO: it does not abort the underlying request. The SDK
 * call keeps running until the provider answers, and its tokens are still billed
 * — MAD simply stops waiting for it. That is exactly the guarantee AD-2's
 * amendment settles for ("a backend that cannot abort a request in flight still
 * satisfies the port"), and it is why the core's own refusal to ISSUE the next
 * turn is what actually stops the spending.
 *
 * STORY 2.3 / AC2 — `onAbandoned` IS WHAT THAT PARAGRAPH IMPLIES, FOLLOWED
 * THROUGH. If the SDK call keeps running and its tokens are still billed, then
 * the number MAD needs is going to exist, in this process, some time after this
 * function has already thrown. The promise is still in memory; the only thing
 * missing was somebody listening to it.
 *
 * So when the race is LOST — and only then — the still-running promise gets a
 * continuation that hands its settled value to the callback. Three properties
 * make that safe to do on a path whose entire purpose is to not affect the run:
 *
 * - **It is not awaited, and it is not returned.** `withTimeout` throws the race
 *   error it always threw, at the same moment it always threw it. There is no
 *   `session.wait`, no event subscription, and nothing that extends the run past
 *   its stop; a test settles the abandoned promise only after `runTurn` has
 *   already resolved, which is the whole claim.
 * - **Both outcomes are handled.** A rejection handler is attached alongside,
 *   because a floating rejection here is an unhandled rejection surfacing in a
 *   run that has already finished. An abandoned request that eventually fails
 *   reports nothing: there is no usage to recover, and no zero to invent.
 * - **The callback's own throw is swallowed.** The one caller reports into a
 *   queue and cannot throw, and if a future one does, the failure belongs to
 *   nobody: there is no turn left to fail and no stage left to tell.
 *
 * It fires for BOTH abandonment errors, because both mean a request is in flight
 * that MAD is no longer waiting for, and neither means a request that failed.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  signal?: AbortSignal,
  onAbandoned?: (settled: T) => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    const races: Promise<T>[] = [
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TurnTimedOutError(ms)), ms)
      }),
    ]
    if (signal) {
      races.push(
        new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new TurnCancelledError())
            return
          }
          onAbort = () => reject(new TurnCancelledError())
          signal.addEventListener("abort", onAbort, { once: true })
        }),
      )
    }
    return await Promise.race(races)
  } catch (error) {
    const abandoned = error instanceof TurnTimedOutError || error instanceof TurnCancelledError
    if (onAbandoned && abandoned) {
      // NOT AWAITED — see the header. `void` is the statement saying so out
      // loud, and the two handlers are what keep this from ever being heard
      // from again on its own.
      void promise.then(
        (settled) => {
          try {
            onAbandoned(settled)
          } catch {
            // ignored on purpose: there is no turn left to fail
          }
        },
        () => {
          // The abandoned request eventually failed. No usage to recover, and
          // emphatically no zero to invent (AC1).
        },
      )
    }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener("abort", onAbort)
  }
}

export class OpencodeModelBackend implements ModelBackend {
  private readonly client: V2Client
  private readonly directory: string
  private readonly bySlot: Map<string, RosterSlot>
  private readonly tools: Record<string, boolean> | undefined
  private readonly timeoutMs: number
  private readonly cleanupTimeoutMs: number
  private readonly lateUsage: LateUsageReporter | undefined

  /**
   * How many `executionId`s this backend has minted. See `nextExecutionId`.
   *
   * Per INSTANCE and not per module, so two backends in one process cannot
   * interleave into each other's numbering, and a test's ids do not depend on
   * what ran before it.
   */
  private executions = 0

  constructor(options: OpencodeBackendOptions) {
    this.client =
      options.client ??
      createOpencodeClient({
        baseUrl: options.serverUrl.toString(),
        directory: options.directory,
      })
    this.directory = options.directory
    this.bySlot = new Map(options.slots.map((slot) => [slot.slot, slot]))
    this.tools = options.tools
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS
    this.lateUsage = options.lateUsage
  }

  /**
   * ONE PHYSICAL MODEL REQUEST, named — minted immediately before
   * `session.prompt` is called and nowhere else.
   *
   * A MONOTONIC COUNTER AND NOT `Math.random()` OR A TIMESTAMP. The id lands in
   * `TokenLedger.unknownUsage` and from there in the evaluation manifest's
   * unknown-usage identities, which a human reads and a test asserts on, so it
   * has to be reproducible across two runs of the same suite. Uniqueness is by
   * construction rather than by hope: a counter cannot collide with itself,
   * where a random id can and a millisecond timestamp will, since a twenty-way
   * discovery fan-out issues its turns inside the same millisecond.
   *
   * WHY THE BACKEND MINTS IT AT ALL, rather than a stage passing one down:
   * `stage + slot + attempt` is explicitly NOT a unique id
   * (`evaluation-protocol.md:504-507`) — debate rounds and different judge
   * findings reuse all three — so the id has to be minted where the physical
   * execution actually happens, which is here. It is what lets a usage figure
   * the provider supplies later be matched back to the turn that incurred it
   * (`reconcileLateUsage`).
   *
   * Nothing is minted for a turn that was never issued: a pre-issue
   * cancellation, a failed session create and a schema that will not convert all
   * return before this is called, because an identity for an execution that
   * never happened is a row a reader cannot act on.
   *
   * The `exec-N` shape is the one `core/test-support/fakes.ts` mints too, and
   * that is on purpose rather than a coincidence to be tidied away: a reader of
   * a `TokenLedger` should see one vocabulary of identities whichever backend
   * filled it. They cannot collide, because a run holds one backend.
   */
  private nextExecutionId(): string {
    this.executions += 1
    return `exec-${this.executions}`
  }

  /**
   * AC3 (story 2.3) — BOUNDED cleanup that REPORTS instead of hiding.
   *
   * Story 1's version was `try { await delete } catch {}` returning `void`, and
   * its own comment — "a session we cannot delete is untidy, not a failure of
   * the review" — is still the governing judgement and is still why nothing here
   * throws. Two things changed, and only these two:
   *
   * - **It has a deadline.** The `catch` covered a `delete` that REJECTED and
   *   had no answer for a `delete` that never settled, so a host that accepted
   *   the request and went quiet held this `await`, the turn, the stage and the
   *   whole run open indefinitely. That is the unbounded await AC3 names, and it
   *   was worst on the cancellation path: the user's stop was as unresponsive as
   *   the hang. The deadline is a timer racing the deletion, the same shape
   *   `withTimeout` uses for the turn itself, so the ordinary case — a host that
   *   answers — pays nothing but a `clearTimeout`.
   * - **It says what happened.** `void` meant the consequence went nowhere, so
   *   the only bounded option available to the caller was to keep waiting.
   *   `CleanupUnresolved | undefined` is the smallest thing that lets `runTurn`
   *   put the fact on the envelope it was already returning, where
   *   `session-cleanup-unresolved` — a DISCLOSURE, not a degradation — can be
   *   raised from it.
   *
   * `undefined` MEANS DELETED, and that asymmetry is on purpose: the caller's
   * test is then `if (unresolved)` and the clean path adds no key to the
   * envelope at all. An `{ ok: true }` outcome object would have made every
   * successful turn carry a `cleanupUnresolved` saying nothing was unresolved,
   * which is the present-but-empty shape this whole story is about.
   *
   * Every message goes through `describeError` for the reason every message in
   * this file does: an SDK error routinely carries the originating request
   * config, auth headers included, and this string reaches a user-visible
   * warning and the run record.
   */
  private async disposeSession(sessionID: string): Promise<CleanupUnresolved | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const deletable = this.client.session as { delete?: (args: unknown) => Promise<unknown> }
      const deletion = deletable.delete?.({ sessionID, directory: this.directory })
      // A client with no `delete` at all is not an unresolved cleanup: there was
      // never a request to resolve. (The v1 client's shape is why this call is
      // optional in the first place.)
      if (deletion === undefined) return undefined

      // `Promise.race` attaches a handler to every entry, so a rejection that
      // arrives after the timer already won is CONSUMED here rather than
      // floating — which is what keeps a slow, failing `delete` from surfacing
      // as an unhandled rejection in a run that has moved on.
      const outcome = await Promise.race<"deleted" | "unresolved" | { refused: unknown }>([
        deletion.then(
          () => "deleted" as const,
          (error: unknown) => ({ refused: error }),
        ),
        new Promise<"unresolved">((resolve) => {
          timer = setTimeout(() => resolve("unresolved"), this.cleanupTimeoutMs)
        }),
      ])

      if (outcome === "deleted") return undefined
      if (outcome === "unresolved") {
        return {
          why: `the session was not deleted: session.delete did not answer within ${this.cleanupTimeoutMs}ms`,
        }
      }
      return { why: `the session was not deleted: ${describeError(outcome.refused)}` }
    } catch (error) {
      // A `delete` that throws SYNCHRONOUSLY — a non-async implementation, or a
      // client whose property access itself fails. Same outcome, same wording:
      // the turn is unaffected either way.
      return { why: `the session was not deleted: ${describeError(error)}` }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * AD-2 — the core reads this declaration rather than assuming.
   *
   * AD-13 AMENDMENT FLAGGED: AD-13 assumed MAD declares a backend's tool
   * capability. opencode reports it PER MODEL (`Model.capabilities.toolcall`),
   * and a spawned session gets host tools by default, gated per call by
   * `session.prompt`'s `tools` allowlist. This implements the real mechanism;
   * AD-13 should be amended to "per slot" rather than "per backend".
   */
  capabilities(slot: string): BackendCapabilities {
    return { tools: this.bySlot.get(slot)?.toolcall === true }
  }

  async runTurn<T>(
    slot: string,
    instructions: string,
    input: string,
    schema: ZodType<T>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    const rosterSlot = this.bySlot.get(slot)
    if (!rosterSlot) {
      // Programmer error: a slot the roster never filled (spine, Errors).
      throw new Error(`OpencodeModelBackend: unknown slot \`${slot}\``)
    }

    // AD-2 amended / AD-6f — CHECKED BEFORE THE SESSION IS CREATED, not only
    // before the prompt. Creating a session is a round trip to the host for a
    // turn that will not run, and every one of them has to be disposed
    // afterwards. The core already refuses to issue a cancelled turn; this is
    // the second line of that defence, for the window between the core's check
    // and this call.
    if (signal?.aborted) return cancelledTurn<T>(slot)

    let sessionID: string
    try {
      const created = await this.client.session.create({
        directory: this.directory,
        title: `MAD ${slot}`,
      })
      if (created.error || !created.data?.id) {
        return {
          ok: false,
          slot,
          failure: "transport-error",
          message: `could not create a session: ${describeError(created.error)}`,
        }
      }
      sessionID = created.data.id
    } catch (error) {
      return { ok: false, slot, failure: "transport-error", message: describeError(error) }
    }

    // AC3 (story 2.3) — ONE DISPOSE PER ATTEMPT, BOUNDED, AND ITS OUTCOME
    // CARRIED OUT.
    //
    // This replaced `finally { await this.disposeSession(sessionID) }` around
    // the prompt, which is the unbounded await AC3 names. The `finally` was the
    // reason the disposal could not report anything: a `finally` runs while the
    // envelope is already on its way out of the function, so there was nowhere
    // to put what it learned, and "keep awaiting" was the only bounded-looking
    // option left. Splitting the body out is what gives the cleanup an envelope
    // to write on.
    //
    // The invariants this ordering keeps, all of them pinned in
    // `model-backend.test.ts`:
    //
    // - **Exactly one dispose per attempt.** One session is created per attempt,
    //   so a retry orphans two if either is missed. Every path that created a
    //   session reaches this line exactly once; the paths that did not create one
    //   (a pre-issue cancellation, a failed `session.create`) returned above and
    //   dispose nothing, because there is nothing to dispose.
    // - **The cancelled path still deletes.** The body RETURNS its cancellation
    //   envelope rather than throwing past this, which is what the old `finally`
    //   guaranteed structurally and this now guarantees by having exactly one
    //   exit.
    // - **A cleanup failure never fails a review.** It attaches a field; it does
    //   not touch `ok`, `failure` or `message`, and it cannot turn a successful
    //   turn into a failed one. `session-cleanup-unresolved` is a DISCLOSURE.
    // - **Nothing throws through the port.** `disposeSession` returns its
    //   outcome and raises nothing, so this `await` cannot reject.
    const envelope = await this.promptAndParse({
      sessionID,
      rosterSlot,
      slot,
      instructions,
      input,
      schema,
      signal,
    })
    const unresolved = await this.disposeSession(sessionID)
    if (!unresolved) return envelope
    return { ...envelope, cleanupUnresolved: unresolved }
  }

  /**
   * The turn itself: convert the schema, issue the one physical request, and
   * turn what came back into an envelope. It creates no session and deletes
   * none — `runTurn` owns the session's whole life, which is what makes
   * "exactly one dispose per attempt" a property of the shape rather than of
   * five `return` statements each remembering to clean up.
   *
   * ONE PARAMETER OBJECT rather than seven positional arguments: three of them
   * are strings, and `(sessionID, slot, instructions, input)` transposed by one
   * is a turn that prompts a model with its own instructions and still
   * type-checks.
   *
   * Every envelope it returns may be handed a `cleanupUnresolved` field by the
   * caller afterwards. Nothing in here knows about that.
   */
  private async promptAndParse<T>(request: {
    sessionID: string
    rosterSlot: RosterSlot
    slot: string
    instructions: string
    input: string
    schema: ZodType<T>
    signal?: AbortSignal
  }): Promise<Envelope<T>> {
    const { sessionID, rosterSlot, slot, instructions, input, schema, signal } = request

    // A schema zod cannot render as JSON Schema is a programmer error, but it
    // must not throw THROUGH the port — `runTurn` returns failures, it does not
    // raise them, or one bad slot takes down the whole fan-out.
    //
    // NO USAGE MARKER, and no `executionId` consumed: this fails BEFORE the
    // prompt goes out, so nothing was issued and nothing is unknown. Marking it
    // unknown would halt an evaluation (AC4's stop rule reads
    // `TokenLedger.unknownUsage`) over a turn no provider ever saw.
    let jsonSchema: Record<string, unknown>
    try {
      jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>
    } catch (error) {
      return {
        ok: false,
        slot,
        failure: "schema-invalid",
        message: `could not convert the schema to JSON Schema: ${describeError(error)}`,
      }
    }

    // Story 2.3 — MINTED HERE, one line above the call it names. See
    // `nextExecutionId`: this is the point where a physical request becomes a
    // thing that can be billed, and therefore the point where it needs an
    // identity a late usage report can be matched back to.
    const executionId = this.nextExecutionId()

    let result: PromptResultLike
    try {
      result = await withTimeout(
        this.client.session.prompt({
          sessionID,
          directory: this.directory,
          model: { providerID: rosterSlot.providerId, modelID: rosterSlot.modelId },
          system: instructions,
          // AD-12 — structured output; this is the whole reason for the v2 client.
          format: { type: "json_schema", schema: jsonSchema },
          ...(this.tools ? { tools: this.tools } : {}),
          parts: [{ type: "text", text: input }],
        }),
        this.timeoutMs,
        signal,
        // AC2 — passed ONLY when a sink was injected, so an ordinary review
        // attaches no continuation to anything and a fresh install holds no
        // abandoned promise for a run that has already finished.
        this.lateUsage
          ? (settled: PromptResultLike) => this.reportLateUsage(executionId, settled)
          : undefined,
      )
    } catch (error) {
      // AD-2 amended — THE USER'S STOP IS NOT A TRANSPORT FAILURE. Reporting it
      // as one would hand the stage a drop-out envelope, which earns AD-6(b)'s
      // retry and puts a working provider's name in a degradation warning.
      //
      // AC1 (story 2.3) — IT IS ALSO NOT A FREE TURN. This routes to
      // `abandonedTurn` and not `cancelledTurn`: the request went out, the AD-2
      // paragraph above says in as many words that the SDK call keeps running
      // and its tokens are still billed, and `cancelledTurn`'s "nothing was
      // billed" is true only of a turn that was never issued. Same
      // `failure: "cancelled"`, same absence of a retry — the only thing that
      // changed is that MAD now admits it cannot count this one.
      if (error instanceof TurnCancelledError) {
        return abandonedTurn<T>(slot, executionId, CANCELLED_IN_FLIGHT)
      }
      // AC1 — the deadline fired. The failure stays `transport-error` so the
      // AD-6(b) retry classification does not move (`TurnFailure` gains no
      // `timeout` member in this story), and the marker rides beside it: a
      // request that timed out is a request the provider is still billing for.
      if (error instanceof TurnTimedOutError) {
        return {
          ok: false,
          slot,
          failure: "transport-error",
          message: describeError(error),
          usageUnknown: { executionId, why: timedOutInFlight(error.ms) },
        }
      }
      // Only thrown for genuine transport failures; provider errors are returned.
      //
      // AC1, CORRECTED AT THE WAVE-4 REVIEW (2026-09-11) — THIS ONE IS MARKED
      // UNKNOWN TOO, and the earlier reasoning for leaving it bare was wrong.
      //
      // That reasoning was "the call itself failed, so there is no settled
      // request behind it and no usage to be unknown about". It is true of a
      // connection refused before a byte went out, and FALSE of a socket that
      // hung up while the provider was answering — and a thrown transport error
      // does not tell MAD which of the two happened. Leaving the marker off
      // asserted the flattering one. That is the same shape as the fabricated
      // `emptyTokenUsage()` this story exists to delete: a state MAD cannot
      // distinguish, resolved silently in the direction that makes the bill look
      // smaller.
      //
      // The frozen protocol settles it without needing a judgement call here:
      // the stop rule binds "any billed OR POTENTIALLY BILLED execution whose
      // usage is missing" (`evaluation-protocol.md:332-339`). Once
      // `session.prompt` has been invoked the execution is potentially billed,
      // so the honest answer is `unknown` and not `nothing`.
      //
      // The cost is stated rather than hidden: a genuinely free failure — a
      // refused connection — now reads as unknown too, and under an evaluation
      // that halts admission for a turn that cost nothing. That is the direction
      // this story is required to err in. Over-reporting an unknown wastes a
      // block; under-reporting one puts an uncountable bill in a published
      // number, which is the failure FR10 names.
      //
      // The two failures BEFORE the prompt goes out — a session that could not
      // be created, and a schema zod could not render — stay unmarked, and that
      // distinction is the real one: nothing was sent, so nothing is unknown.
      return {
        ok: false,
        slot,
        failure: "transport-error",
        message: describeError(error),
        usageUnknown: { executionId, why: failedInFlight() },
      }
    }

    if (result.error || !result.data) {
      return {
        ok: false,
        slot,
        failure: "transport-error",
        message: describeError(result.error),
      }
    }

    const info = result.data.info

    // THE ONE LINE THIS STORY EXISTS TO DELETE, and what replaced it.
    //
    // It was `const tokens = info?.tokens ? mapTokens(info.tokens) :
    // emptyTokenUsage()`. `emptyTokenUsage()` is a TRUTHY object, so the three
    // stages' `if (envelope.tokens)` guard fired and an all-zero entry landed in
    // the ledger: a turn that billed money, recorded as a turn that cost
    // nothing, in the direction that flatters MAD.
    // `evaluation-protocol.md:341-343` names that exact line as the reason its
    // own stop rule "cannot work until story 2.3 ships".
    //
    // `mapTokens`'s per-field `?? 0` for a PRESENT object stays, and that is not
    // an inconsistency: a host that reported `{ input: 7 }` said the other four
    // were zero, which is a different fact from a host that reported no `tokens`
    // object at all. The first is knowledge; the second was an invention.
    const usage: UsageAnnotation = info?.tokens
      ? { tokens: mapTokens(info.tokens) }
      : { usageUnknown: { executionId, why: HOST_REPORTED_NO_USAGE } }

    if (info?.error) {
      // Returned, not thrown — a domain outcome the caller retries once (AD-6b).
      return { ok: false, slot, failure: "model-error", message: describeError(info.error), ...usage }
    }

    if (info?.structured === undefined || info.structured === null) {
      return {
        ok: false,
        slot,
        failure: "empty-response",
        message: "the model returned no structured payload",
        ...usage,
      }
    }

    // Hosts have been observed handing `structured` back as a JSON string rather
    // than a parsed object. Treating that as schema-invalid would drop every
    // model in the run for a transport detail.
    let payload: unknown = info.structured
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload)
      } catch {
        return {
          ok: false,
          slot,
          failure: "schema-invalid",
          message: "structured payload arrived as a string that is not valid JSON",
          ...usage,
        }
      }
    }

    // AD-12 — the envelope is validated. AD-11 — the prose inside it is not.
    const parsed = schema.safeParse(payload)
    if (!parsed.success) {
      return {
        ok: false,
        slot,
        failure: "schema-invalid",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        ...usage,
        // Handed back unvalidated so `discover` can salvage the items that ARE
        // valid instead of losing the model — and the denominator — over one
        // malformed field (AD-6a). The stage re-validates every item it keeps.
        raw: payload,
      }
    }

    return { ok: true, slot, value: parsed.data, ...usage }
  }

  /**
   * AC2 (story 2.3) — the continuation's body: hand a late token payload to the
   * injected sink, or hand over nothing.
   *
   * Called from `withTimeout`'s non-awaited continuation, so by the time it runs
   * the turn's envelope has long since been returned and the run may already
   * have closed its record. That is expected rather than exceptional: reporting
   * into a drained sink is the ordinary case for a provider that took longer than
   * the run did, and `LateUsageReporter.report` is documented as safe to call at
   * any time.
   *
   * IT REPORTS NOTHING WHEN THERE IS NOTHING, which is the same rule as the
   * prompt path's and it matters more here. A continuation that reported
   * `emptyTokenUsage()` for an abandoned request that answered without a
   * `tokens` field would be the deleted fabrication rebuilt one layer out — and
   * strictly worse, because `reconcileLateUsage` would move the unknown into
   * `entries` with a zero bill and the run would then read as COMPLETE.
   *
   * It uses the same `mapTokens` the settled path uses, so an early and a late
   * payload cannot be mapped two ways.
   */
  private reportLateUsage(executionId: string, settled: PromptResultLike): void {
    const tokens = settled?.data?.info?.tokens
    if (!tokens) return
    this.lateUsage?.report({ executionId, tokens: mapTokens(tokens) })
  }
}
