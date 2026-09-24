/**
 * Story 2-8c — the accounting probe's two local servers.
 *
 * - **The stub** is an OpenAI-compatible chat-completions endpoint and the
 *   managed host's only provider. It answers from a script, one behaviour per
 *   physical request, and records every request it receives with the usage it
 *   served. It bills nothing: it is a local process and no provider stands
 *   behind it.
 * - **The proxy** is what HTTP(S)_PROXY points at. It reads the request line of
 *   each connection (`CONNECT host:443 HTTP/1.1`, or a plain request line), even
 *   when it arrives in pieces, records it, answers `403` and closes. It forwards
 *   nothing.
 *
 * Both bind to 127.0.0.1 only.
 *
 * ## How the stub answers
 *
 * opencode's structured output is its host tool `StructuredOutput`, so a
 * success is a streamed tool call to that tool with the scripted payload,
 * followed by a usage chunk. `tool:<name>` calls another tool instead, which is
 * how the probe makes the host run a tool step. The error behaviours answer
 * with an HTTP status and no usage. `hang` never answers; it records when the
 * connection closed and whether that was before or after the probe announced it
 * was stopping the host (`hostStopping`).
 *
 * Every successful answer serves a usage figure unique to its model request
 * (`servedUsage`, numbered by model requests only), so the probe can tell whose
 * tokens MAD recorded.
 *
 * ## Scenarios do not bleed into each other
 *
 * `reset()` starts a new generation. A request that arrived under an earlier
 * generation is never recorded into the new one and never consumes its script.
 * A body that is not a JSON object is read as an empty one, so a script step is
 * never consumed without its request being recorded.
 *
 * AD-1: this tree may import from `core/`; nothing under `core/` imports it.
 */

export type StubBehaviour = "ok" | "500" | "429" | "400" | "hang" | `tool:${string}`

export interface ServedUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

/** One request the stub received, as the probe reads it back. */
export interface StubRequest {
  /** 1-based, in arrival order, since the stub started or was last reset. */
  index: number
  /** 1-based among model requests only; absent for any other request. */
  modelIndex?: number
  at: number
  method: string
  path: string
  /** `true` for a chat-completions call: a physical model request. */
  model: boolean
  behaviour: StubBehaviour | "not-a-model-request"
  /** The model id the host asked for. */
  requestedModel?: string
  stream?: boolean
  /** The names of the tools the host offered, in order. */
  toolsOffered: string[]
  toolChoice?: unknown
  /** The usage this request was answered with; absent when it served none. */
  servedUsage?: ServedUsage
  /** For `hang`: when the connection closed, and who closed it, if it did. */
  closed?: {
    at: number
    afterMs: number
    /** `client` before the probe announced it was stopping the host; `host-stopping` after. */
    by: "client" | "host-stopping"
  }
}

export interface AccountingStub {
  /** The base URL a provider block names, ending in `/v1`. */
  baseURL: string
  hostname: string
  port: number
  /** Replace the script, forget every recorded request, and start a new generation. */
  reset(script: { queue: StubBehaviour[]; otherwise: StubBehaviour; payload?: unknown }): void
  /** The probe is about to stop the host: a hung connection that closes from now on was closed by that. */
  hostStopping(): void
  requests(): StubRequest[]
  /** Physical model requests received so far. */
  modelRequests(): number
  stop(): Promise<void>
  /** The handler the server calls, exposed so a test can hand it a request the network cannot shape. */
  handle(request: Request): Promise<Response>
}

/** A payload `discover`'s envelope schema accepts. */
export const EMPTY_FINDINGS = { findings: [] }

/** The usage model request `modelIndex` is served with: distinct for every model request. */
export function usageFor(modelIndex: number): ServedUsage {
  const prompt = 1000 + modelIndex
  const completion = 10 + modelIndex
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
}

function toolArguments(name: string): unknown {
  return name === "glob" ? { pattern: "*" } : {}
}

/** A JSON object, or `{}` for anything else (null, an array, a scalar, malformed text). */
function objectBody(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = raw.length > 0 ? JSON.parse(raw) : {}
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function toolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return []
  return tools.map((tool) => {
    if (tool === null || typeof tool !== "object") return ""
    const entry = tool as { function?: { name?: unknown } | null; name?: unknown }
    const name = entry.function?.name ?? entry.name
    return typeof name === "string" ? name : ""
  })
}

export function startAccountingStub(): AccountingStub {
  let queue: StubBehaviour[] = []
  let otherwise: StubBehaviour = "ok"
  let payload: unknown = EMPTY_FINDINGS
  let recorded: StubRequest[] = []
  let generation = 0
  let stoppingAt: number | undefined
  const hung = new Set<() => void>()

  const handle = async (request: Request): Promise<Response> => {
    const born = generation
    const url = new URL(request.url)
    const raw = request.method === "POST" ? await request.text().catch(() => "") : ""
    // A request from before `reset()` belongs to no scenario the probe is recording.
    if (born !== generation) return new Response("stale", { status: 503 })
    const body = objectBody(raw)
    const isModel = request.method === "POST" && url.pathname.endsWith("/chat/completions")
    const entry: StubRequest = {
      index: recorded.length + 1,
      ...(isModel ? { modelIndex: recorded.filter((item) => item.model).length + 1 } : {}),
      at: Date.now(),
      method: request.method,
      path: url.pathname,
      model: isModel,
      behaviour: "not-a-model-request",
      ...(typeof body.model === "string" ? { requestedModel: body.model } : {}),
      ...(typeof body.stream === "boolean" ? { stream: body.stream } : {}),
      toolsOffered: toolNames(body.tools),
      ...(body.tool_choice === undefined ? {} : { toolChoice: body.tool_choice }),
    }
    recorded.push(entry)
    if (!isModel) return new Response("not found", { status: 404 })
    const behaviour = queue.shift() ?? otherwise
    entry.behaviour = behaviour

    const error = (status: number, message: string, type: string) =>
      new Response(JSON.stringify({ error: { message, type } }), { status, headers: { "content-type": "application/json" } })
    switch (behaviour) {
      case "500":
        return error(500, "stub internal error", "server_error")
      case "429":
        return error(429, "stub rate limited", "rate_limit")
      case "400":
        return error(400, "stub bad request", "invalid_request_error")
      case "hang":
        return new Promise<Response>((resolve) => {
          const close = () => {
            if (entry.closed === undefined) {
              const at = Date.now()
              entry.closed = { at, afterMs: at - entry.at, by: stoppingAt !== undefined && at >= stoppingAt ? "host-stopping" : "client" }
            }
            hung.delete(close)
            resolve(new Response("", { status: 499 }))
          }
          hung.add(close)
          if (request.signal.aborted) close()
          else request.signal.addEventListener("abort", close, { once: true })
        })
    }

    const usage = usageFor(entry.modelIndex!)
    entry.servedUsage = usage
    const offeredStructured = entry.toolsOffered.find((name) => name === "StructuredOutput")
    const tool = behaviour.startsWith("tool:") ? behaviour.slice("tool:".length) : offeredStructured
    const args = behaviour.startsWith("tool:") ? toolArguments(tool!) : payload
    const id = `chatcmpl-${entry.index}`
    const created = Math.floor(entry.at / 1000)
    const base = { id, object: "chat.completion.chunk", created, model: entry.requestedModel }
    const call = tool === undefined ? undefined : { id: `call_${entry.index}`, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }
    if (body.stream !== true) {
      return Response.json({
        id,
        object: "chat.completion",
        created,
        model: entry.requestedModel,
        choices: [
          {
            index: 0,
            message: call === undefined ? { role: "assistant", content: JSON.stringify(args) } : { role: "assistant", content: null, tool_calls: [call] },
            finish_reason: call === undefined ? "stop" : "tool_calls",
          },
        ],
        usage,
      })
    }
    const chunks: unknown[] = [{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }]
    if (call !== undefined) {
      chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: null }] })
      chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
    } else {
      chunks.push({ ...base, choices: [{ index: 0, delta: { content: JSON.stringify(args) }, finish_reason: null }] })
      chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
    }
    chunks.push({ ...base, choices: [], usage })
    const text = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"
    return new Response(text, { headers: { "content-type": "text/event-stream" } })
  }

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: handle })

  return {
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    hostname: String(server.hostname),
    port: Number(server.port),
    reset(script) {
      generation += 1
      queue = [...script.queue]
      otherwise = script.otherwise
      payload = script.payload ?? EMPTY_FINDINGS
      recorded = []
      stoppingAt = undefined
    },
    hostStopping() {
      stoppingAt ??= Date.now()
    },
    requests: () => recorded.map((entry) => ({ ...entry, toolsOffered: [...entry.toolsOffered], ...(entry.closed ? { closed: { ...entry.closed } } : {}) })),
    modelRequests: () => recorded.filter((entry) => entry.model).length,
    async stop() {
      stoppingAt ??= Date.now()
      for (const release of [...hung]) release()
      await server.stop(true)
    },
    handle,
  }
}

/** One connection the proxy refused. */
export interface ProxyAttempt {
  at: number
  /** The request line the client sent, e.g. `CONNECT registry.npmjs.org:443 HTTP/1.1`. */
  line: string
}

export interface RefusingProxy {
  url: string
  hostname: string
  port: number
  attempts(): ProxyAttempt[]
  stop(): void
}

/** The longest request line the proxy keeps; a longer one is recorded cut at this length. */
const MAX_LINE = 2048

/** A proxy that forwards nothing: it records each connection's request line and answers 403. */
export function startRefusingProxy(): RefusingProxy {
  const attempts: ProxyAttempt[] = []
  const refuse = (socket: { write(data: string): unknown; end(): unknown }) => {
    socket.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
    socket.end()
  }
  const listener = Bun.listen<{ buffer: string; done: boolean }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { buffer: "", done: false }
      },
      data(socket, chunk) {
        if (socket.data.done) return
        socket.data.buffer += Buffer.from(chunk).toString("latin1")
        const end = socket.data.buffer.indexOf("\r\n")
        if (end < 0 && socket.data.buffer.length < MAX_LINE) return
        socket.data.done = true
        attempts.push({ at: Date.now(), line: (end < 0 ? socket.data.buffer : socket.data.buffer.slice(0, end)).slice(0, MAX_LINE) })
        refuse(socket)
      },
      close(socket) {
        // A client that sent part of a line and hung up is still an attempt.
        if (!socket.data.done && socket.data.buffer.length > 0) {
          socket.data.done = true
          attempts.push({ at: Date.now(), line: socket.data.buffer.slice(0, MAX_LINE) })
        }
      },
    },
  })
  return {
    url: `http://127.0.0.1:${listener.port}`,
    hostname: listener.hostname,
    port: listener.port,
    attempts: () => attempts.map((attempt) => ({ ...attempt })),
    stop: () => listener.stop(true),
  }
}
