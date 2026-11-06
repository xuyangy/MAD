/**
 * `classifyRefusal` — what counts as a refused request, and everything that
 * does not. Each negative case is an error a real host could send that must
 * stay an ordinary failure, with its ordinary retry.
 */

import { describe, expect, test } from "bun:test"

import { classifyRefusal } from "./refusal.ts"

const GITLAB = { providerId: "gitlab", modelId: "duo-chat-gpt-5-6-terra" }
const ROUTE = { providerId: "openrouter", modelId: "amazon/nova-pro-v1" }
const GITLAB_CREDITS =
  'Failed to get direct access token: 402 Payment Required - {"message":"Token creation failed: not enough GitLab Credits. Contact your administrator for more credits."}'

describe("recognised refusals", () => {
  test("ProviderAuthError naming the slot's provider is an authentication refusal for that provider", () => {
    expect(classifyRefusal({ name: "ProviderAuthError", data: { providerID: "openrouter", message: "bad key" } }, ROUTE)).toEqual({
      kind: "auth",
      basis: "structured",
      scope: "provider",
      ...ROUTE,
    })
  })

  test("APIError 401 and 402, not retryable, refuse this route only", () => {
    for (const isRetryable of [false, undefined]) {
      const data = { message: "x", ...(isRetryable === undefined ? {} : { isRetryable }) }
      expect(classifyRefusal({ name: "APIError", data: { ...data, statusCode: 401 } }, ROUTE)).toEqual({
        kind: "auth",
        basis: "structured",
        scope: "route",
        ...ROUTE,
      })
      expect(classifyRefusal({ name: "APIError", data: { ...data, statusCode: 402 } }, ROUTE)).toEqual({
        kind: "payment",
        basis: "structured",
        scope: "route",
        ...ROUTE,
      })
    }
  })

  test("the GitLab no-credits text from the gitlab provider is a payment refusal for the provider, labelled host-signature", () => {
    expect(classifyRefusal({ name: "UnknownError", data: { message: GITLAB_CREDITS } }, GITLAB)).toEqual({
      kind: "payment",
      basis: "host-signature",
      scope: "provider",
      ...GITLAB,
    })
  })

  test("provider ids match without regard to case, as selection groups them, and the result keeps the slot's spelling", () => {
    expect(classifyRefusal({ name: "ProviderAuthError", data: { providerID: "OpenRouter" } }, ROUTE)).toEqual({
      kind: "auth",
      basis: "structured",
      scope: "provider",
      ...ROUTE,
    })
    const upper = { ...GITLAB, providerId: "GitLab" }
    expect(classifyRefusal({ name: "UnknownError", data: { message: GITLAB_CREDITS } }, upper)).toEqual({
      kind: "payment",
      basis: "host-signature",
      scope: "provider",
      ...upper,
    })
    // The message evidence is still exact under a case-variant provider.
    expect(classifyRefusal({ name: "UnknownError", data: { message: GITLAB_CREDITS.toLowerCase() } }, upper)).toBeUndefined()
  })

  test("the provider and model are the slot's, whatever the error body names", () => {
    const refusal = classifyRefusal(
      { name: "APIError", data: { statusCode: 402, isRetryable: false, providerID: "elsewhere", modelID: "other" } },
      ROUTE,
    )
    expect(refusal?.providerId).toBe("openrouter")
    expect(refusal?.modelId).toBe("amazon/nova-pro-v1")
  })
})

describe("not refusals", () => {
  const cases: [string, unknown, { providerId: string; modelId: string }][] = [
    ["ProviderAuthError for another provider", { name: "ProviderAuthError", data: { providerID: "anthropic" } }, ROUTE],
    ["ProviderAuthError without a providerID", { name: "ProviderAuthError", data: { message: "bad key" } }, ROUTE],
    ["APIError 402 marked retryable", { name: "APIError", data: { statusCode: 402, isRetryable: true } }, ROUTE],
    ["APIError 402 with a non-boolean isRetryable", { name: "APIError", data: { statusCode: 402, isRetryable: "false" } }, ROUTE],
    ["APIError with a string status", { name: "APIError", data: { statusCode: "402", isRetryable: false } }, ROUTE],
    ["APIError without a status", { name: "APIError", data: { message: "402 Payment Required" } }, ROUTE],
    ["APIError 403", { name: "APIError", data: { statusCode: 403, isRetryable: false } }, ROUTE],
    ["APIError 429", { name: "APIError", data: { statusCode: 429, isRetryable: false } }, ROUTE],
    ["APIError 404 (no tool-use endpoint)", { name: "APIError", data: { statusCode: 404, isRetryable: false } }, ROUTE],
    ["the GitLab text from another provider", { name: "UnknownError", data: { message: GITLAB_CREDITS } }, ROUTE],
    ["a generic 402 in an UnknownError", { name: "UnknownError", data: { message: "402 Payment Required" } }, GITLAB],
    [
      "the GitLab prefix without the credits marker",
      { name: "UnknownError", data: { message: "Failed to get direct access token: 402 Payment Required - {}" } },
      GITLAB,
    ],
    [
      "the credits marker quoted inside some other text",
      { name: "UnknownError", data: { message: `upstream said: ${GITLAB_CREDITS}` } },
      GITLAB,
    ],
    ["the GitLab text under another error name", { name: "APIError", data: { message: GITLAB_CREDITS } }, GITLAB],
    ["an UnknownError with a non-string message", { name: "UnknownError", data: { message: 402 } }, GITLAB],
    ["an error without data", { name: "APIError" }, ROUTE],
    ["an error without a name", { data: { statusCode: 402 } }, ROUTE],
    ["a string", "402 Payment Required", ROUTE],
    ["nothing", undefined, ROUTE],
  ]
  for (const [label, error, slot] of cases) {
    test(label, () => {
      expect(classifyRefusal(error, slot)).toBeUndefined()
    })
  }
})
