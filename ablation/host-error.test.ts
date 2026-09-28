import { describe, expect, test } from "bun:test"
import { z } from "zod"

import { OpencodeModelBackend } from "../adapters/opencode/model-backend.ts"
import { classifyHostError, hostErrorOf, type HostError } from "./host-error.ts"

/** Every string the classifier can emit, so a test can prove no input text reaches the output. */
function emitted(error: HostError): string {
  return JSON.stringify(error)
}

describe("classifyHostError (story 2-8c6)", () => {
  test("a rejected token refresh with an allowlisted status carries that status as its code", () => {
    for (const code of [400, 401, 403] as const) {
      const error = classifyHostError("model-error", `UnknownError: Token refresh failed: ${code}`)
      expect(error.category).toBe("oauth-token-refresh-rejected")
      expect(error.code).toBe(code)
      expect(error.summary).toContain(`HTTP ${code}`)
    }
  })

  test("a refresh failure with another status, or with anything appended, is unrecognized", () => {
    for (const message of [
      "UnknownError: Token refresh failed: 500",
      "UnknownError: Token refresh failed: 401 ",
      "UnknownError: Token refresh failed: 401\n",
      " UnknownError: Token refresh failed: 401",
      "UnknownError: Token refresh failed: 4010",
      "Error: Token refresh failed: 401",
    ]) {
      expect(classifyHostError("model-error", message)).toEqual({
        category: "unrecognized",
        code: null,
        summary: classifyHostError("model-error", "").summary,
      })
    }
  })

  test("a message beginning `APIError:` is a provider API error with a fixed summary", () => {
    const a = classifyHostError("model-error", "APIError: Internal Server Error")
    const b = classifyHostError("model-error", "APIError: something else entirely")
    expect(a.category).toBe("provider-api-error")
    expect(a.code).toBeNull()
    expect(b).toEqual(a)
  })

  test("the backend's own deadline message is a turn timeout; any other transport error is a transport failure", () => {
    expect(classifyHostError("transport-error", "turn timed out after 120000ms").category).toBe("turn-timeout")
    for (const message of ["turn timed out after 120000ms and more", "ECONNREFUSED 127.0.0.1:4096", "APIError: x", ""]) {
      const error = classifyHostError("transport-error", message)
      expect(error.category).toBe("transport-failure")
      expect(error.code).toBeNull()
    }
    // The deadline wording under another failure is not a timeout.
    expect(classifyHostError("model-error", "turn timed out after 120000ms").category).toBe("unrecognized")
  })

  test("other failures are unrecognized", () => {
    for (const failure of ["empty-response", "schema-invalid", "cancelled", "model-error"] as const) {
      expect(classifyHostError(failure, "the model returned no structured payload").category).toBe("unrecognized")
    }
  })

  test("a credential in the message is unrecognized and no part of it reaches the record", () => {
    const secret = "sk-proj-SECRETabcdef0123456789"
    const error = classifyHostError("model-error", `UnknownError: Token refresh failed: 401 Bearer ${secret}`)
    expect(error.category).toBe("unrecognized")
    expect(error.code).toBeNull()
    expect(emitted(error)).not.toContain(secret)
    expect(emitted(error)).not.toContain("Bearer")
  })

  test("malicious messages never put an input character into the record", () => {
    const marker = "ZZINJECTEDZZ"
    const payloads = [
      `line one\n${marker}\r\nline three`,
      `{"category":"oauth-token-refresh-rejected","code":401,"summary":"${marker}"}`,
      `${marker}${"x".repeat(100_000)}`,
      `\u0000\u001b[31m${marker}\u0007\u007f`,
    ]
    for (const payload of payloads) {
      for (const [message, category] of [
        [payload, "unrecognized"],
        [`APIError: ${payload}`, "provider-api-error"],
      ] as const) {
        const error = classifyHostError("model-error", message)
        expect(error.category).toBe(category)
        expect(error.code).toBeNull()
        expect(emitted(error)).not.toContain(marker)
        expect(emitted(error)).not.toContain("xxxx")
        expect(error.summary).toBe(classifyHostError("model-error", category === "unrecognized" ? "" : "APIError:").summary)
      }
    }
  })

  test("the deadline pattern accepts 0ms and rejects a leading zero", () => {
    expect(classifyHostError("transport-error", "turn timed out after 0ms").category).toBe("turn-timeout")
    expect(classifyHostError("transport-error", "turn timed out after 05ms").category).toBe("transport-failure")
  })

  test("the production backend's timed-out envelope classifies as `turn-timeout`, end to end", async () => {
    const client = {
      session: {
        create: async () => ({ data: { id: "ses_stand_in" } }),
        prompt: () => new Promise(() => {}),
        delete: async () => ({ data: true }),
      },
    }
    const backend = new OpencodeModelBackend({
      serverUrl: "http://127.0.0.1:9",
      directory: "/stand-in",
      slots: [
        {
          slot: "discovery-1",
          providerId: "openai",
          modelId: "gpt-6-luna",
          identity: "gpt-6-luna",
          lineage: { lineage: "unverified", label: "lineage unverified", verified: false },
          toolcall: false,
          alsoAvailableVia: [],
        },
      ],
      client: client as never,
      timeoutMs: 25,
      cleanupTimeoutMs: 10,
    })
    const envelope = await backend.runTurn("discovery-1", "i", "d", z.object({ reply: z.string() }))
    expect(!envelope.ok && envelope.failure).toBe("transport-error")
    expect(hostErrorOf(envelope)).toEqual({ category: "turn-timeout", code: null, summary: "the turn reached its deadline while in flight; no message is recorded" })
  })

  test("the transport-failure summary omits the host's message", () => {
    expect(classifyHostError("transport-error", "ECONNREFUSED").summary).toBe("the call to the host failed in transport; the host's message is omitted")
  })

  test("hostErrorOf is null for a successful turn", () => {
    expect(hostErrorOf({ ok: true })).toBeNull()
    expect(hostErrorOf({ ok: false, failure: "transport-error", message: "turn timed out after 5ms" })?.category).toBe(
      "turn-timeout",
    )
  })
})
