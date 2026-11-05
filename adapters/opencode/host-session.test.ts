/**
 * `hostSessionFromPluginClient` on the wire: a real v1 `createOpencodeClient`,
 * configured as the host configures the one it gives plugins (a base URL, the
 * project directory, the server's auth header and its own `fetch`), with a
 * recording `fetch` standing in for the server. Each test pins the exact request
 * and checks that the SDK's result envelope comes back unchanged.
 *
 * The recording `fetch` is injected into the client, so the network guard
 * (`test-support/network-guard.ts`) does not see these requests. Nothing here
 * opens a socket: every request is answered by the recorder.
 */

import { describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk"

import { hostSessionFromPluginClient } from "./host-session.ts"
import type { HostPromptArgs } from "./model-backend.ts"
import { REVIEW_SESSION_PERMISSION } from "./session-policy.ts"

const AUTH = "Basic b3BlbmNvZGU6c2VjcmV0"

interface Recorded {
  method: string
  path: string
  query: Record<string, string>
  authorization: string | null
  body: unknown
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })
}

/** A host client whose every request is recorded and answered by `answer`. */
function recordingHost(answer: (request: Recorded) => Response | Promise<Response>) {
  const requests: Recorded[] = []
  const fetch = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
    const url = new URL(request.url)
    const text = await request.text()
    const recorded: Recorded = {
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: request.headers.get("authorization"),
      body: text === "" ? undefined : JSON.parse(text),
    }
    requests.push(recorded)
    return answer(recorded)
  }
  const client = createOpencodeClient({
    baseUrl: "http://localhost:4096",
    directory: "/repo",
    headers: { authorization: AUTH },
    fetch: fetch as typeof globalThis.fetch,
  })
  return { api: hostSessionFromPluginClient(client), requests }
}

const PROMPT: HostPromptArgs = {
  sessionID: "ses_1",
  directory: "/repo",
  model: { providerID: "anthropic", modelID: "claude-haiku-5-5" },
  system: "instructions\n\nnotice",
  format: { type: "json_schema", schema: { type: "object", properties: { ok: { type: "boolean" } } } },
  tools: { read: false },
  parts: [{ type: "text", text: "the change" }],
}

describe("session.create", () => {
  test("posts the title and the permission rules to /session, with the directory and the host's auth header", async () => {
    const echo = { id: "ses_1", title: "MAD a", permission: [...REVIEW_SESSION_PERMISSION], extra: "kept" }
    const host = recordingHost(() => json(200, echo))

    const created = await host.api.session.create({
      directory: "/repo",
      title: "MAD a",
      permission: [...REVIEW_SESSION_PERMISSION],
    })

    expect(host.requests).toEqual([
      {
        method: "POST",
        path: "/session",
        query: { directory: "/repo" },
        authorization: AUTH,
        body: { title: "MAD a", permission: [...REVIEW_SESSION_PERMISSION] },
      },
    ])
    expect(created.error).toBeUndefined()
    expect(created.data).toEqual(echo)
  })

  test("sends no permission key when no rules are given", async () => {
    const host = recordingHost(() => json(200, { id: "ses_1" }))
    await host.api.session.create({ directory: "/repo", title: "MAD a" })
    expect(host.requests[0]!.body).toEqual({ title: "MAD a" })
  })

  test("an HTTP error comes back as the envelope's error, not as a rejection", async () => {
    const refusal = { name: "UnknownError", data: { message: "no" } }
    const host = recordingHost(() => json(500, refusal))
    const created = await host.api.session.create({ directory: "/repo", title: "MAD a" })
    expect(created.data).toBeUndefined()
    expect(created.error).toEqual(refusal)
  })

  test("a transport failure rejects with the transport's own error", async () => {
    const boom = new Error("socket gone")
    const host = recordingHost(() => {
      throw boom
    })
    await expect(host.api.session.create({ directory: "/repo", title: "MAD a" })).rejects.toBe(boom)
  })
})

describe("session.prompt", () => {
  test("posts model, system, format, tools and parts to /session/{id}/message and returns the envelope unchanged", async () => {
    const answer = {
      info: {
        structured: { ok: true },
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 1, write: 2 } },
        unknownField: "kept",
      },
      parts: [],
    }
    const host = recordingHost(() => json(200, answer))

    const result = await host.api.session.prompt(PROMPT)

    expect(host.requests).toEqual([
      {
        method: "POST",
        path: "/session/ses_1/message",
        query: { directory: "/repo" },
        authorization: AUTH,
        body: {
          model: PROMPT.model,
          system: PROMPT.system,
          format: PROMPT.format,
          tools: PROMPT.tools,
          parts: PROMPT.parts,
        },
      },
    ])
    expect(result.error).toBeUndefined()
    expect(result.data).toEqual(answer as never)
  })

  test("sends no tools key when no tools are given", async () => {
    const host = recordingHost(() => json(200, { info: {}, parts: [] }))
    const { tools: _omitted, ...withoutTools } = PROMPT
    await host.api.session.prompt(withoutTools)
    expect(Object.keys(host.requests[0]!.body as object).sort()).toEqual(["format", "model", "parts", "system"])
  })

  test("an HTTP error comes back as the envelope's error", async () => {
    const refusal = { name: "ProviderAuthError", data: { message: "expired" } }
    const host = recordingHost(() => json(401, refusal))
    const result = await host.api.session.prompt(PROMPT)
    expect(result.data).toBeUndefined()
    expect(result.error).toEqual(refusal)
  })

  test("a transport failure rejects with the transport's own error", async () => {
    const boom = new Error("socket gone")
    const host = recordingHost(() => {
      throw boom
    })
    await expect(host.api.session.prompt(PROMPT)).rejects.toBe(boom)
  })

  test("a delayed answer settles the adapter's promise when it arrives, and not before", async () => {
    let release!: (response: Response) => void
    const held = new Promise<Response>((resolve) => {
      release = resolve
    })
    const host = recordingHost(() => held)

    let settled = false
    const pending = host.api.session.prompt(PROMPT).then((result) => {
      settled = true
      return result
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(host.requests).toHaveLength(1)
    expect(settled).toBe(false)

    release(json(200, { info: { tokens: { input: 3, output: 1 } }, parts: [] }))
    const result = await pending
    expect(settled).toBe(true)
    expect(result.data?.info?.tokens).toEqual({ input: 3, output: 1 })
  })
})

describe("session.delete", () => {
  test("sends DELETE /session/{id} with the directory and the host's auth header, and returns the boolean answer", async () => {
    const host = recordingHost(() => json(200, true))
    const deleted = await host.api.session.delete!({ sessionID: "ses_1", directory: "/repo" })
    expect(host.requests).toEqual([
      { method: "DELETE", path: "/session/ses_1", query: { directory: "/repo" }, authorization: AUTH, body: undefined },
    ])
    expect((deleted as { data?: unknown }).data).toBe(true)
  })

  test("an HTTP error comes back as the envelope's error", async () => {
    const refusal = { name: "NotFoundError", data: { message: "gone" } }
    const host = recordingHost(() => json(404, refusal))
    const deleted = (await host.api.session.delete!({ sessionID: "ses_1", directory: "/repo" })) as {
      data?: unknown
      error?: unknown
    }
    expect(deleted.data).toBeUndefined()
    expect(deleted.error).toEqual(refusal)
  })
})
