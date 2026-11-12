/**
 * Recognises a provider REFUSING a request, for an account reason or because
 * the route does not accept a request feature MAD needs, from the host's
 * assistant-message error, and nothing else (`Refusal` in
 * `core/ports/model-backend.ts`).
 *
 * Every input is checked at run time: the error comes from the host and the
 * provider behind it, and a field of the wrong type must never strengthen the
 * evidence. Anything not matched exactly is not a refusal, and the turn stays an
 * ordinary failure with its ordinary retry.
 *
 * - `ProviderAuthError` whose `data.providerID` is the slot's provider,
 *   compared without regard to case as selection compares providers: an
 *   authentication refusal for that provider.
 * - `APIError` whose `data.message` is exactly
 *   `tool_choice: type "tool" and "any" are not supported for this model.`,
 *   with `isRetryable` absent or `false` and any `statusCode` or none: a
 *   capability refusal of this provider/model route, labelled
 *   `host-signature`. The route rejects the forced tool choice MAD's
 *   structured answers need, so a retry would fail the same way. It is checked
 *   before the status rules, so the text decides the kind whatever the status.
 *   Any other text, a variant included, is not read as this refusal.
 * - `APIError` with a numeric `statusCode` of 401 (auth) or 402 (payment), and
 *   `isRetryable` absent or `false`: a refusal of this provider/model route
 *   only. The error shows this request was refused; it does not show that
 *   every route behind the provider shares the account, since a gateway can
 *   route models to different upstream accounts. So another model on the same
 *   provider may still be chosen as a replacement, and may be refused the same
 *   way, costing that slot its one replacement and possibly an attempt of
 *   unknown usage. `isRetryable: true`, or any non-boolean value, is not a
 *   refusal.
 * - `UnknownError` from the `gitlab` provider (any case) whose message starts with
 *   `Failed to get direct access token: 402 Payment Required` and contains
 *   `not enough GitLab Credits`: the text this host emits when the GitLab
 *   account has no credits. A heuristic on a known message, labelled
 *   `host-signature`; no other text is read.
 *
 * The provider and model on the result are the roster slot's.
 */

import type { Refusal } from "../../core/ports/model-backend.ts"

/** The exact host error text of a route that rejects MAD's forced tool choice. */
export const TOOL_CHOICE_UNSUPPORTED = 'tool_choice: type "tool" and "any" are not supported for this model.'
const GITLAB_CREDITS_PREFIX = "Failed to get direct access token: 402 Payment Required"
const GITLAB_CREDITS_MARKER = "not enough GitLab Credits"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function classifyRefusal(error: unknown, slot: { providerId: string; modelId: string }): Refusal | undefined {
  if (!isRecord(error) || typeof error.name !== "string" || !isRecord(error.data)) return undefined
  const data = error.data
  const route = { providerId: slot.providerId, modelId: slot.modelId }

  if (error.name === "ProviderAuthError") {
    if (typeof data.providerID !== "string" || data.providerID.toLowerCase() !== slot.providerId.toLowerCase()) {
      return undefined
    }
    return { kind: "auth", basis: "structured", scope: "provider", ...route }
  }

  if (error.name === "APIError") {
    if (data.isRetryable !== undefined && data.isRetryable !== false) return undefined
    if (data.message === TOOL_CHOICE_UNSUPPORTED) {
      return { kind: "capability", basis: "host-signature", scope: "route", ...route }
    }
    if (typeof data.statusCode !== "number") return undefined
    if (data.statusCode === 401) return { kind: "auth", basis: "structured", scope: "route", ...route }
    if (data.statusCode === 402) return { kind: "payment", basis: "structured", scope: "route", ...route }
    return undefined
  }

  if (error.name === "UnknownError") {
    if (slot.providerId.toLowerCase() !== "gitlab" || typeof data.message !== "string") return undefined
    if (!data.message.startsWith(GITLAB_CREDITS_PREFIX) || !data.message.includes(GITLAB_CREDITS_MARKER)) return undefined
    return { kind: "payment", basis: "host-signature", scope: "provider", ...route }
  }

  return undefined
}
