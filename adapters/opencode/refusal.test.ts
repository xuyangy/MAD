/**
 * `classifyRefusal` — what counts as a refused request, and everything that
 * does not. Each negative case is an error a real host could send that must
 * stay an ordinary failure, with its ordinary retry.
 */

import { describe, expect, test } from "bun:test"

import { classifyRefusal, TOOL_CHOICE_UNSUPPORTED as TOOL_CHOICE } from "./refusal.ts"

const GITLAB = { providerId: "gitlab", modelId: "duo-chat-gpt-5-6-terra" }
const ROUTE = { providerId: "openrouter", modelId: "amazon/nova-pro-v1" }
const ANTHROPIC = { providerId: "anthropic", modelId: "claude-opus-5-5" }
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

  test("the recognised text is the one captured in live runs N3 and N4, character for character", () => {
    expect(TOOL_CHOICE).toBe('tool_choice: type "tool" and "any" are not supported for this model.')
  })

  test("the captured tool_choice rejection is a capability refusal of this route, labelled host-signature", () => {
    expect(classifyRefusal({ name: "APIError", data: { message: TOOL_CHOICE } }, ANTHROPIC)).toEqual({
      kind: "capability",
      basis: "host-signature",
      scope: "route",
      ...ANTHROPIC,
    })
  })

  test("the tool_choice rejection is the same with any status, a false isRetryable, or another provider", () => {
    const capability = (slot: { providerId: string; modelId: string }) => ({
      kind: "capability" as const,
      basis: "host-signature" as const,
      scope: "route" as const,
      ...slot,
    })
    for (const statusCode of [400, 422, 500]) {
      expect(
        classifyRefusal({ name: "APIError", data: { message: TOOL_CHOICE, statusCode, isRetryable: false } }, ANTHROPIC),
      ).toEqual(capability(ANTHROPIC))
    }
    expect(classifyRefusal({ name: "APIError", data: { message: TOOL_CHOICE, isRetryable: false } }, ROUTE)).toEqual(
      capability(ROUTE),
    )
    // A non-numeric status does not keep the text from matching.
    expect(classifyRefusal({ name: "APIError", data: { message: TOOL_CHOICE, statusCode: "400" } }, ANTHROPIC)).toEqual(
      capability(ANTHROPIC),
    )
  })

  test("a tool_choice rejection with a 401 or 402 status is a capability refusal, read from the text", () => {
    for (const statusCode of [401, 402]) {
      expect(classifyRefusal({ name: "APIError", data: { message: TOOL_CHOICE, statusCode } }, ANTHROPIC)?.kind).toBe("capability")
    }
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
    [
      "APIError with a non-numeric status and some other text",
      { name: "APIError", data: { message: "Bad Request", statusCode: "401", isRetryable: false } },
      ROUTE,
    ],
    ["APIError with a null status and some other text", { name: "APIError", data: { message: "Bad Request", statusCode: null } }, ROUTE],
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
    ["the tool_choice text marked retryable", { name: "APIError", data: { message: TOOL_CHOICE, isRetryable: true } }, ANTHROPIC],
    [
      "the tool_choice text with a non-boolean isRetryable",
      { name: "APIError", data: { message: TOOL_CHOICE, statusCode: 400, isRetryable: "false" } },
      ANTHROPIC,
    ],
    [
      "the tool_choice text without its final period",
      { name: "APIError", data: { message: TOOL_CHOICE.slice(0, -1) } },
      ANTHROPIC,
    ],
    ["a prefix of the tool_choice text", { name: "APIError", data: { message: "tool_choice: type" } }, ANTHROPIC],
    [
      "the tool_choice text with extra text after it",
      { name: "APIError", data: { message: `${TOOL_CHOICE} Use tool_choice auto.` } },
      ANTHROPIC,
    ],
    [
      "the tool_choice text quoted inside other text",
      { name: "APIError", data: { message: `upstream said: ${TOOL_CHOICE}` } },
      ANTHROPIC,
    ],
    [
      "the tool_choice text in another case",
      { name: "APIError", data: { message: TOOL_CHOICE.toUpperCase() } },
      ANTHROPIC,
    ],
    ["the tool_choice text under another error name", { name: "UnknownError", data: { message: TOOL_CHOICE } }, ANTHROPIC],
    ["the tool_choice text as a non-string message", { name: "APIError", data: { message: [TOOL_CHOICE] } }, ANTHROPIC],
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
