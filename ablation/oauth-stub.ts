/**
 * Story 2-8c3b — the OAuth probe's provider stubs.
 *
 * One stub per redirected provider, each a local server on 127.0.0.1 that an
 * OAuth-mode host reaches through the provider's `baseURL` override:
 *
 * - **`messages`** answers the Anthropic Messages API (`POST …/messages`) with a
 *   streamed (SSE) `tool_use` block for opencode's host tool `StructuredOutput`;
 * - **`chat-completions`** answers `POST …/chat/completions` with a streamed tool
 *   call to the same tool, as `ablation/accounting-stub.ts` does.
 *
 * The scripted payload is `EMPTY_FINDINGS`, which `discover`'s envelope accepts.
 * `500` answers HTTP 500; `hang` never answers and records when the connection
 * closed.
 *
 * ## What a stub records
 *
 * For each request: the provider it stands in for, the method, the path (no query
 * string), whether an auth-bearing header (`authorization`, `x-api-key`,
 * `api-key`) was present, when it arrived, and how it was answered. Never a header
 * value and never a body: a request body is drained and dropped, and nothing a stub
 * holds is raw request or response material.
 *
 * `reset()` starts a new generation, exactly as the accounting stub's does: a
 * request from an earlier generation is neither recorded nor answered from the new
 * script.
 *
 * AD-1: this tree may import from `core/`; nothing under `core/` imports it.
 */

import { EMPTY_FINDINGS } from "./accounting-stub.ts"

export type OAuthStubFormat = "messages" | "chat-completions"
export type OAuthStubBehaviour = "ok" | "500" | "hang"

const AUTH_HEADERS = ["authorization", "x-api-key", "api-key"] as const

/** One request a stub received. */
export interface OAuthStubRequest {
  /** 1-based, in arrival order, since the stub started or was last reset. */
  index: number
  provider: string
  at: number
  method: string
  path: string
  /** `true` for a model request in the stub's format. */
  model: boolean
  /** Whether an auth-bearing header was present. Its value is never read into the record. */
  authHeaderPresent: boolean
  behaviour: OAuthStubBehaviour | "not-a-model-request"
  /** For `hang`: when the connection closed, if it did. */
  closed?: { at: number; afterMs: number }
}

export interface OAuthStub {
  provider: string
  format: OAuthStubFormat
  /** The `baseURL` override that points the provider at this stub. */
  baseURL: string
  reset(script: { queue: OAuthStubBehaviour[]; otherwise: OAuthStubBehaviour }): void
  requests(): OAuthStubRequest[]
  stop(): Promise<void>
  /** The handler the server calls, exposed so a test can hand it a request directly. */
  handle(request: Request): Promise<Response>
}

function sse(events: { event?: string; data: unknown }[]): string {
  return events.map((entry) => `${entry.event === undefined ? "" : `event: ${entry.event}\n`}data: ${typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data)}\n\n`).join("")
}

/** A streamed Messages answer: one `tool_use` block calling `StructuredOutput` with `payload`. */
export function messagesAnswer(index: number, payload: unknown): string {
  const input = JSON.stringify(payload)
  return sse([
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: { id: `msg_stub_${index}`, type: "message", role: "assistant", model: "stub", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
      },
    },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_stub_${index}`, name: "StructuredOutput", input: {} } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: input } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ])
}

/** A streamed chat-completions answer: one tool call to `StructuredOutput` with `payload`. */
export function chatCompletionsAnswer(index: number, payload: unknown): string {
  const base = { id: `chatcmpl-stub-${index}`, object: "chat.completion.chunk", created: 0, model: "stub" }
  const call = { id: `call_stub_${index}`, type: "function", function: { name: "StructuredOutput", arguments: JSON.stringify(payload) } }
  return (
    sse([
      { data: { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] } },
      { data: { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: null }] } },
      { data: { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] } },
      { data: { ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } },
    ]) + "data: [DONE]\n\n"
  )
}

export function startOAuthStub(provider: string, format: OAuthStubFormat): OAuthStub {
  let queue: OAuthStubBehaviour[] = []
  let otherwise: OAuthStubBehaviour = "ok"
  let recorded: OAuthStubRequest[] = []
  let generation = 0
  const hung = new Set<() => void>()
  const suffix = format === "messages" ? "/messages" : "/chat/completions"

  const handle = async (request: Request): Promise<Response> => {
    const born = generation
    // Drained and dropped: the body is never recorded, parsed or kept.
    await request.arrayBuffer().catch(() => undefined)
    if (born !== generation) return new Response("stale", { status: 503 })
    const url = new URL(request.url)
    const isModel = request.method === "POST" && url.pathname.endsWith(suffix)
    const entry: OAuthStubRequest = {
      index: recorded.length + 1,
      provider,
      at: Date.now(),
      method: request.method,
      path: url.pathname,
      model: isModel,
      authHeaderPresent: AUTH_HEADERS.some((name) => request.headers.has(name)),
      behaviour: "not-a-model-request",
    }
    recorded.push(entry)
    if (!isModel) return new Response("not found", { status: 404 })
    const behaviour = queue.shift() ?? otherwise
    entry.behaviour = behaviour
    if (behaviour === "500") {
      const body = format === "messages" ? { type: "error", error: { type: "api_error", message: "stub internal error" } } : { error: { message: "stub internal error", type: "server_error" } }
      return Response.json(body, { status: 500 })
    }
    if (behaviour === "hang") {
      return new Promise<Response>((resolve) => {
        const close = () => {
          if (entry.closed === undefined) {
            const at = Date.now()
            entry.closed = { at, afterMs: at - entry.at }
          }
          hung.delete(close)
          resolve(new Response("", { status: 499 }))
        }
        hung.add(close)
        if (request.signal.aborted) close()
        else request.signal.addEventListener("abort", close, { once: true })
      })
    }
    const text = format === "messages" ? messagesAnswer(entry.index, EMPTY_FINDINGS) : chatCompletionsAnswer(entry.index, EMPTY_FINDINGS)
    return new Response(text, { headers: { "content-type": "text/event-stream" } })
  }

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: handle })
  const origin = `http://127.0.0.1:${server.port}`
  return {
    provider,
    format,
    baseURL: format === "messages" ? `${origin}/v1` : origin,
    reset(script) {
      generation += 1
      queue = [...script.queue]
      otherwise = script.otherwise
      recorded = []
    },
    requests: () => recorded.map((entry) => ({ ...entry, ...(entry.closed ? { closed: { ...entry.closed } } : {}) })),
    async stop() {
      for (const release of [...hung]) release()
      await server.stop(true)
    },
    handle,
  }
}
