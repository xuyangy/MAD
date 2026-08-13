/**
 * AD-2 — the `ModelBackend` port is "run one turn, return a validated envelope".
 *
 * Async, request/response, NON-STREAMING. No stage may depend on incremental
 * token output — that is what keeps an out-of-process backend (another agent
 * CLI, a herdr pane) implementable without a core change.
 *
 * Interfaces only. Nothing here imports a harness SDK (AD-1).
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
   */
  runTurn<T>(
    slot: string,
    instructions: string,
    input: string,
    schema: ZodType<T>,
  ): Promise<Envelope<T>>
}
