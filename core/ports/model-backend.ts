/**
 * AD-2 — the `ModelBackend` port is "run one turn, return a validated envelope".
 *
 * Async, request/response, NON-STREAMING. No stage may depend on incremental
 * token output — that is what keeps an out-of-process backend (another agent
 * CLI, a herdr pane) implementable without a core change.
 *
 * Interfaces only, plus TWO constructors (`cancelledTurn`, story 7A;
 * `abandonedTurn`, story 2.3) — the exception is deliberate and narrow. Three
 * stages have to build the same `cancelled` envelope, and each already carries
 * its own copy of the retry loop "repeated rather than shared because each stage
 * names its own ledger `stage` and each has its own schema"
 * (`core/stages/judge.ts`). That argument does not extend to the envelope
 * itself: there is nothing stage-specific in it, and three copies of the one
 * message a user sees when they stop a run is three chances for them to
 * disagree. They live beside the `TurnFailure` member they construct, and beside
 * each other, because the two make opposite claims about whether the turn cost
 * anything and a reader choosing between them needs both arguments in view.
 *
 * Nothing here imports a harness SDK (AD-1).
 */

import type { ZodType } from "zod"

import type { TokenUsage } from "../domain/run-record.ts"

/**
 * AD-2 — each backend declares its capabilities and the core reads the
 * declaration rather than assuming.
 *
 * NOTE (AD-13 amendment flagged, story 1 design notes): AD-13 assumed MAD would
 * declare a backend's tool capability. The opencode host reports it PER MODEL
 * (`Model.capabilities.toolcall`), so the declaration is per slot, not per
 * backend. Implemented against the real mechanism; AD-13 needs amending to say
 * "per slot".
 */
export interface BackendCapabilities {
  /** Whether the model behind this slot can call tools at all. */
  tools: boolean
}

/** Why a turn failed. All of these are domain outcomes, never exceptions. */
export type TurnFailure =
  /** The provider/model returned an error (opencode returns, never throws). */
  | "model-error"
  /** The call could not be made or the transport failed. */
  | "transport-error"
  /** AD-12 — the response failed schema validation. */
  | "schema-invalid"
  /** The model answered, but with no structured payload at all. */
  | "empty-response"
  /**
   * AD-2 amended (story 7A) — the USER stopped the run. The one failure here
   * that is NOT a degradation of a model.
   *
   * It gets no retry and no `model-dropped-out` warning. AD-6(b)'s single retry
   * exists for a model that failed; retrying a turn the user cancelled spends
   * their money to disobey them. A cancelled slot is not a slow slot, an
   * unreliable slot, or a slot that shrank the AD-6(a) denominator by any fault
   * of its own — it is a slot that was never asked. Reported under AD-6(f), once
   * per run, naming the stage the run stopped at.
   */
  | "cancelled"

/**
 * FR10 / AC1 (story 2.3) — THIS EXECUTION BILLED SOMETHING MAD CANNOT COUNT.
 *
 * The marker a backend attaches when it has no usage figure to report and has
 * no defensible reason to claim the turn was free. Three real states produce
 * one: a turn cancelled in flight, a turn abandoned at its deadline, and a turn
 * that SETTLED SUCCESSFULLY with the host reporting no `tokens` field.
 *
 * WHAT IT REPLACES IS THE POINT. `adapters/opencode/model-backend.ts` mapped
 * missing usage to `emptyTokenUsage()`, which is a TRUTHY object, so the three
 * stages' `if (envelope.tokens)` guard fired and an all-zero entry landed in the
 * ledger — a turn that billed money recorded as a turn that cost nothing, in the
 * direction that flatters MAD. `evaluation-protocol.md:341-343` names that exact
 * line as the reason its own stop rule "cannot work until story 2.3 ships".
 *
 * `executionId` names ONE physical model request and is minted by the backend at
 * the call site where the request is actually made. It is NOT
 * `stage + slot + attempt`, which the protocol states outright is not a unique id
 * (`:504-507`) — debate rounds and different judge findings reuse all three. It
 * is what lets a usage figure the provider supplies later be matched back to the
 * turn it belongs to (`reconcileLateUsage`).
 *
 * `why` is mandatory and non-empty, the rule `UnknownUsageEntry` states: "the
 * host reported nothing", "cancelled in flight" and "timed out" are three
 * different facts and a reader acts on them differently.
 */
export interface UsageUnknown {
  executionId: string
  why: string
}

/**
 * AC3 (story 2.3) — A SESSION MAD OPENED AND COULD NOT CLOSE.
 *
 * Session disposal is bounded, so a `delete` that hangs or throws ends the turn
 * with the session still on the host rather than holding the run open until the
 * host answers — that unbounded `await` is the one AC3 names. The consequence
 * has to go SOMEWHERE, and it rides on the envelope of the turn that opened the
 * session, because that is the only object the port hands back.
 *
 * IT IS NOT A FAILURE OF THE TURN, and nothing here lets it become one. The
 * turn it rides on may have succeeded completely, and usually did.
 * `adapters/opencode/model-backend.ts:190-193` has recorded that judgement in
 * prose since story 1 — "a session we cannot delete is untidy, not a failure of
 * the review" — and `session-cleanup-unresolved` is a DISCLOSURE for exactly
 * that reason (`core/domain/warning.ts`).
 *
 * No `sessionID` field, deliberately: the id is a host handle that means nothing
 * to a reader and nothing to a stage, and putting it on the envelope would put
 * it on the rendered run. `why` already carries every name a user needs to act,
 * which is what `Warning.message` promises too.
 */
export interface CleanupUnresolved {
  why: string
}

/**
 * AD-12 — every model turn returns a schema-validated envelope. The envelope is
 * validated; the prose inside it (AD-11) is not.
 *
 * STORY 2.3 ADDED TWO OPTIONAL FIELDS TO BOTH BRANCHES, and made the success
 * branch's `tokens` OPTIONAL. Both are additive in the sense that matters — no
 * existing producer changes shape and no existing reader breaks, because the
 * three stages have always guarded with `if (envelope.tokens)` — and the second
 * one is load-bearing rather than cosmetic:
 *
 * - **A successful turn whose host reported no usage was not expressible.** It
 *   is a real state, observed, and the adapter's only way to satisfy a REQUIRED
 *   `tokens` was to fabricate `emptyTokenUsage()` for it. Making the field
 *   optional is what lets that fabrication be deleted instead of moved.
 * - **A successful turn whose session would not delete was not expressible
 *   either**, so a bounded cleanup had nowhere to report its outcome and the
 *   only bounded option was to keep awaiting it forever.
 *
 * `usageUnknown` and `tokens` are near-exclusive in practice and are NOT modelled
 * as a union, which is a decision rather than laziness: a union would force every
 * existing reader of `envelope.tokens` to discriminate before reading it, for a
 * type-level guarantee the producers can already keep. What matters is enforced
 * where it can be — the constructors below never emit both, and no code path
 * turns an unknown into a number, because `TokenUsage` has nowhere to put one.
 */
export type Envelope<T> =
  | {
      ok: true
      slot: string
      value: T
      /**
       * OPTIONAL SINCE STORY 2.3, and absent means "not known" — never zero.
       * See the header above for why this had to widen. A reader that wants the
       * bill reads `tokens` AND `usageUnknown`; a reader that wants a number
       * reads `tokens` and gets `undefined` when there is none, which is the
       * honest answer and the one thing the old required field could not give.
       */
      tokens?: TokenUsage
      /** Story 2.3 — present when the host reported no usage for this turn. */
      usageUnknown?: UsageUnknown
      /** Story 2.3 — present when this turn's session could not be deleted. */
      cleanupUnresolved?: CleanupUnresolved
    }
  | {
      ok: false
      slot: string
      failure: TurnFailure
      message: string
      tokens?: TokenUsage
      /** Story 2.3 — present when this turn billed something MAD cannot count. */
      usageUnknown?: UsageUnknown
      /** Story 2.3 — present when this turn's session could not be deleted. */
      cleanupUnresolved?: CleanupUnresolved
      /**
       * The unvalidated payload, when there was one (`schema-invalid`). The
       * discover stage uses it to salvage the items that ARE valid rather than
       * discarding a model's whole contribution — and therefore shrinking the
       * AD-6a denominator — over one malformed field. Never fed to a stage
       * unvalidated.
       */
      raw?: unknown
    }

/**
 * The envelope for a turn the core DECIDED NOT TO ISSUE because the user stopped
 * the run (AD-2 amended, AD-6f).
 *
 * Note what it does NOT carry: no `tokens`, and no `raw`, because no model
 * answered. A stage seeing this must not retry it, must not count it as an
 * attempt against the slot, and must not raise `model-dropped-out` for it.
 *
 * ## "Nothing was billed" IS TRUE OF THIS CASE ONLY, and that is now stated
 *
 * NARROWED IN STORY 2.3. This comment used to say the absent `tokens` meant
 * "nothing was billed", full stop — and that claim was FALSE at one of its own
 * call sites: `adapters/opencode/model-backend.ts:294` routed a turn cancelled
 * WHILE IN FLIGHT here, and the adapter's own AD-2 header three lines up
 * (`:134-139`) says in as many words that the SDK call keeps running until the
 * provider answers and its tokens are still billed. So the port asserted a turn
 * cost nothing while the adapter documented the opposite about the same turn.
 *
 * The claim holds for the PRE-ISSUE case and is scoped to it: this constructor
 * is for a turn the core never handed to a backend at all — the signal was
 * already aborted when the stage or the adapter checked it — so the cost really
 * is a known zero, not an unknown. That distinction is what `usageUnknown`
 * exists to carry, and marking a never-issued turn unknown would be its own
 * dishonesty: it would halt an evaluation (AC4's stop rule reads
 * `TokenLedger.unknownUsage`) over a turn that provably cost nothing.
 *
 * The in-flight case is `abandonedTurn` below.
 *
 * The message is deliberately about the RUN and not about the slot. "The run was
 * cancelled" is true of every slot that gets one; "this model did not answer" is
 * the sentence that would quietly turn a user's stop into a provider's fault.
 */
export function cancelledTurn<T>(slot: string): Envelope<T> {
  return {
    ok: false,
    slot,
    failure: "cancelled",
    message: "the run was cancelled before this turn was issued",
  }
}

/**
 * The sentence a blank `why` becomes.
 *
 * `abandonedTurn` substitutes rather than throws, for the reason
 * `clampTokenCap` clamps rather than throws: this is an exported seam a
 * JavaScript caller reaches, and an empty reason is a caller who supplied
 * nothing, not a caller who deserves a crashed run. What it must never become
 * is an unknown with a blank reason attached, because the `why` is the whole
 * difference between a record that says MAD could not count this turn and a
 * record that just has a hole in it.
 *
 * It is EXPORTED so the substitution is pinned by a test that names the exact
 * string, and so a reader who finds this sentence in a report can grep for where
 * it came from. The mirror of `UNKNOWN_USAGE_UNSTATED_REASON` in
 * `core/domain/run-record.ts`, one layer down, for the same reason.
 */
export const UNSTATED_ABANDONMENT_REASON = "the turn was abandoned in flight, with no reason recorded"

/**
 * AC1 / AC3 (story 2.3) — the envelope for a turn that WAS ISSUED and then
 * abandoned: the request went out, the provider is billing for it, and MAD
 * stopped waiting.
 *
 * The second constructor in this file, and the exception the module header makes
 * for `cancelledTurn` extends to it for the same reason and one more. The
 * reason: three stages and the adapter must not each write their own version of
 * the one thing MAD says about money it cannot account for. The one more: the
 * two constructors make OPPOSITE claims about the bill and are one character
 * apart at a call site, so they belong side by side where a reader choosing
 * between them sees both arguments at once.
 *
 * ## What it claims, and what it refuses to claim
 *
 * - **`usageUnknown`, always.** This is the whole purpose. The request was
 *   issued, so something was billed; MAD does not know the number and will not
 *   invent one (AC1: no unknown value is ever estimated or interpolated).
 * - **No `tokens`, ever — the key is ABSENT, not zero.** `emptyTokenUsage()` is
 *   truthy, and a truthy zero here is the exact lie this story deletes.
 * - **`failure: "cancelled"`, unchanged.** `TurnFailure`'s five members are
 *   untouched by this story, deliberately, so the retry classification does not
 *   move: `evaluation-protocol.md:311-327` — "Cancellation, budget refusal and
 *   unquantified usage never authorize a retry." A turn whose first attempt's
 *   cost is unknown is a turn a retry makes WORSE, not better, because it adds a
 *   second uncountable bill to the first.
 * - **A blank `why` is SUBSTITUTED, never thrown on.** The same rule and the
 *   same reasoning as `recordUnknownTurn`: losing the marker over a bad reason
 *   string would turn an uncountable turn back into a free one, which is the
 *   failure the validation is for.
 *
 * The message is about the RUN, like `cancelledTurn`'s, and states the in-flight
 * truth rather than claiming the turn was never issued.
 */
export function abandonedTurn<T>(slot: string, executionId: string, why: string): Envelope<T> {
  const stated = typeof why === "string" && why.trim().length > 0 ? why : UNSTATED_ABANDONMENT_REASON
  return {
    ok: false,
    slot,
    failure: "cancelled",
    message: "the run stopped waiting on this turn while it was in flight, so its usage is unknown",
    usageUnknown: { executionId, why: stated },
  }
}

export interface ModelBackend {
  /** AD-2 — capability declaration the core reads instead of assuming. */
  capabilities(slot: string): BackendCapabilities

  /**
   * AD-2 / AD-12 — run one turn for one slot.
   *
   * `instructions` is the versioned role instruction set (AD-11); `input` is the
   * material under review; `schema` constrains only MAD's computed fields.
   * Retries are the CALLER's business (AD-6b: exactly one), so a backend must
   * not retry internally.
   *
   * `signal` is OPTIONAL AND LAST ON PURPOSE (AD-2 amended, story 7A). A backend
   * that ignores it entirely still satisfies this port, because the core stops
   * ISSUING turns either way — the signal narrows the window between the user's
   * stop and the last turn ending, and is never load-bearing. That is what keeps
   * an out-of-process backend implementable, for the same reason this port is
   * non-streaming: MAD must not require of a backend anything an agent CLI
   * behind a pipe cannot provide.
   *
   * A backend that DOES honour it returns `failure: "cancelled"` and nothing
   * else. In particular it must not report an aborted request as a
   * `transport-error`, which would make the user's stop indistinguishable from a
   * provider failure and earn it AD-6(b)'s retry.
   */
  runTurn<T>(
    slot: string,
    instructions: string,
    input: string,
    schema: ZodType<T>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>>
}
