/**
 * Story 2-8c3b — the OAuth probe's stubs: what they answer and what they record.
 */

import { afterEach, describe, expect, test } from "bun:test"

import { startOAuthStub, type OAuthStub } from "./oauth-stub.ts"

const running: OAuthStub[] = []
afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop()
})
function stub(...args: Parameters<typeof startOAuthStub>): OAuthStub {
  const started = startOAuthStub(...args)
  running.push(started)
  return started
}

const SECRET_HEADER = "Bearer mad-test-header-value-never-recorded"
const SECRET_BODY = "mad-test-body-never-recorded"

describe("what a stub records", () => {
  test("provider, method, path and whether an auth header was present; never a header value, a query or a body", async () => {
    const messages = stub("anthropic", "messages")
    const response = await fetch(`${messages.baseURL}/messages?beta=true`, { method: "POST", headers: { authorization: SECRET_HEADER }, body: JSON.stringify({ secret: SECRET_BODY }) })
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    const text = await response.text()
    expect(text).toContain('"name":"StructuredOutput"')
    expect(text).toContain('"partial_json":"{\\"findings\\":[]}"')
    expect(text).toContain("event: message_stop")
    const [recorded] = messages.requests()
    expect(recorded).toMatchObject({ index: 1, provider: "anthropic", method: "POST", path: "/v1/messages", model: true, authHeaderPresent: true, behaviour: "ok" })
    expect(Object.keys(recorded!).sort()).toEqual(["at", "authHeaderPresent", "behaviour", "index", "method", "model", "path", "provider"])
    expect(JSON.stringify(messages.requests())).not.toContain("mad-test")
  })

  test("the chat-completions stub answers a streamed StructuredOutput call; a request with no auth header is recorded as such", async () => {
    const chat = stub("github-copilot", "chat-completions")
    const text = await (await fetch(`${chat.baseURL}/chat/completions`, { method: "POST", body: "{}" })).text()
    expect(text).toContain('"name":"StructuredOutput"')
    expect(text.trim().endsWith("data: [DONE]")).toBe(true)
    expect(chat.requests()[0]).toMatchObject({ path: "/chat/completions", authHeaderPresent: false })
  })

  test("a scripted 500, a non-model request and a reset each behave as named", async () => {
    const messages = stub("anthropic", "messages")
    messages.reset({ queue: ["500"], otherwise: "ok" })
    expect((await fetch(`${messages.baseURL}/messages`, { method: "POST", body: "{}" })).status).toBe(500)
    expect((await fetch(`${messages.baseURL}/messages`, { method: "POST", body: "{}" })).status).toBe(200)
    expect((await fetch(`${messages.baseURL}/models`)).status).toBe(404)
    expect(messages.requests().map((entry) => entry.behaviour)).toEqual(["500", "ok", "not-a-model-request"])
    messages.reset({ queue: [], otherwise: "ok" })
    expect(messages.requests()).toEqual([])
  })

  test("a hang is held until the client gives up, and its close is recorded", async () => {
    const messages = stub("anthropic", "messages")
    messages.reset({ queue: [], otherwise: "hang" })
    await expect(fetch(`${messages.baseURL}/messages`, { method: "POST", body: "{}", signal: AbortSignal.timeout(100) })).rejects.toThrow()
    await new Promise((done) => setTimeout(done, 100))
    expect(messages.requests()[0]!.closed?.afterMs).toBeGreaterThanOrEqual(0)
  })
})
