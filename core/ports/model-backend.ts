/**
 * AD-2 — the `ModelBackend` port is "run one turn, return a validated envelope".
 *
 * Async, request/response, NON-STREAMING. No stage may depend on incremental
 * token output — that is what keeps an out-of-process backend (another agent
 * CLI, a herdr pane) implementable without a core change.
 *
 * Interfaces only, plus ONE constructor (`cancelledTurn`, story 7A) — the
 * exception is deliberate and narrow. Three stages have to build the same
 * `cancelled` envelope, and each already carries its own copy of the retry loop
 * "repeated rather than shared because each stage names its own ledger `stage`
 * and each has its own schema" (`core/stages/judge.ts`). That argument does not
 * extend to the envelope itself: there is nothing stage-specific in it, and
 * three copies of the one message a user sees when they stop a run is three
 * chances for them to disagree. It lives beside the `TurnFailure` member it
 * constructs.
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
 * AD-12 — every model turn returns a schema-validated envelope. The envelope is
 * validated; the prose inside it (AD-11) is not.
 */
export type Envelope<T> =
  | { ok: true; slot: string; value: T; tokens: TokenUsage }
  | {
      ok: false
      slot: string
      failure: TurnFailure
      message: string
      tokens?: TokenUsage
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
 * Note what it does NOT carry: no `tokens`, because nothing was billed, and no
 * `raw`, because no model answered. A stage seeing this must not retry it, must
 * not count it as an attempt against the slot, and must not raise
 * `model-dropped-out` for it.
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
