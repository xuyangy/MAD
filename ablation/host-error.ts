/**
 * Story 2-8c6 — an allowlisted record of the error a failed turn ended in.
 *
 * The OAuth pilot and the zero-bill probe used to record only a failure kind, so
 * a failed attempt's cause had to be recovered from the host's own database. This
 * classifier reads the envelope's `failure` and `message` (the backend's
 * `describeError` output) and returns one of five categories, an optional code
 * and a summary.
 *
 * Redaction is structural rather than a filter: the summary comes from a fixed
 * table, and the only value interpolated into it is a code drawn from an
 * allowlist. No character of the host's message reaches the output, so a
 * credential, a request body or a control sequence in the message cannot reach
 * the evidence.
 */
import type { TurnFailure } from "../core/ports/model-backend.ts"

export type HostErrorCategory =
  | "oauth-token-refresh-rejected"
  | "provider-api-error"
  | "turn-timeout"
  | "transport-failure"
  | "unrecognized"

/** The HTTP statuses a rejected OAuth token refresh may carry into the record. */
export const REFRESH_REJECTION_CODES = [400, 401, 403] as const
export type RefreshRejectionCode = (typeof REFRESH_REJECTION_CODES)[number]

export interface HostError {
  category: HostErrorCategory
  /** Set only for `oauth-token-refresh-rejected`, from `REFRESH_REJECTION_CODES`. */
  code: RefreshRejectionCode | null
  summary: string
}

/** The fixed summary per category; `code` is the only interpolated value. */
const SUMMARY: { [K in HostErrorCategory]: (code: RefreshRejectionCode | null) => string } = {
  "oauth-token-refresh-rejected": (code) =>
    `the host reported that its OAuth token refresh was rejected with HTTP ${code}; the host's message is omitted`,
  "provider-api-error": () => "the host reported a provider API error; the host's message is omitted",
  "turn-timeout": () => "the turn reached its deadline while in flight; no message is recorded",
  "transport-failure": () => "the call to the host failed in transport; the host's message is omitted",
  unrecognized: () => "the turn failed with an error outside the allowlisted categories; its message is omitted",
}

/** The backend's own deadline message (`TurnTimedOutError`), matched whole. */
const TURN_TIMEOUT = /^turn timed out after (0|[1-9][0-9]{0,9})ms$/

function record(category: HostErrorCategory, code: RefreshRejectionCode | null = null): HostError {
  return { category, code, summary: SUMMARY[category](code) }
}

/**
 * Classifies a failed turn. The refresh and timeout patterns match the complete
 * message; `provider-api-error` is a prefix classification with a fixed output.
 */
export function classifyHostError(failure: TurnFailure, message: string): HostError {
  if (failure === "transport-error") {
    return TURN_TIMEOUT.test(message) ? record("turn-timeout") : record("transport-failure")
  }
  for (const code of REFRESH_REJECTION_CODES) {
    if (message === `UnknownError: Token refresh failed: ${code}`) return record("oauth-token-refresh-rejected", code)
  }
  if (message.startsWith("APIError:")) return record("provider-api-error")
  return record("unrecognized")
}

/** The record for one attempt's envelope: `null` for a successful turn. */
export function hostErrorOf(envelope: { ok: true } | { ok: false; failure: TurnFailure; message: string }): HostError | null {
  return envelope.ok ? null : classifyHostError(envelope.failure, envelope.message)
}
