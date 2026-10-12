/**
 * Story 2-7f2 — the adversarial probe's provider stub.
 *
 * A local server on 127.0.0.1 that an OAuth-mode host reaches through its
 * provider's `baseURL` override, in one of two formats: the Anthropic Messages
 * API (`POST …/messages`) or chat-completions (`POST …/chat/completions`).
 * Unlike `ablation/oauth-stub.ts`, which answers every request with empty
 * findings, this one answers a whole `review()`: it reads which answer a
 * request wants off the request itself, and serves a scripted step.
 *
 * ## How an answer is chosen
 *
 * The host offers the answer tool, `StructuredOutput`, with the JSON schema of
 * the stage's envelope. The top-level property names of that schema say which
 * stage is asking (`stageOf`), and `STAGE_ANSWERS` holds one schema-valid answer
 * per stage. A discovery answer comes from the script, for the run the caller
 * named with `setRun`. A request that offers no answer tool is a host side
 * request and gets plain text.
 *
 * The script then picks the step served (`serve`): the answer, a hang, an HTTP
 * 400 or 500, the answer with its usage figures left out, or a call to a tool
 * the host did not offer.
 *
 * ## What a stub records, and what it never keeps
 *
 * A request body is parsed to choose the answer and to read the offered tool
 * names, the answer schema's property names, and three booleans about a tool
 * result it carries: whether it is an error, whether it names an unavailable
 * tool, and whether it contains the canary token the caller set. Nothing else
 * of the body is read into a record. A record holds the provider, the method,
 * the path, whether an auth-bearing header was present, the arrival time, the
 * offered tool names, the stage, those booleans, the step served and the run.
 * It never holds a header value, a prompt, a body or any response text. The
 * canary token is compared in memory and never stored in a record.
 *
 * `onRequest` is called with each model request's record before it is
 * answered, so a caller can read its own state at the moment a request
 * arrives.
 *
 * AD-1: this tree may import from `core/`; nothing under `core/` imports it.
 */

import { chatCompletionsAnswer, messagesAnswer, type OAuthStubFormat } from "./oauth-stub.ts"

export type StubStage = "discover" | "debate" | "evidence-extract" | "fact-check" | "logic-eval" | "aggregate" | "side" | "unknown"

/** What a model request was answered with. */
export type StubStep = "answer" | "hang" | "http-400" | "http-500" | "no-usage" | "unoffered-tool"
export type StubServed = StubStep | "side-text" | "not-a-model-request"

/** The run a request belongs to, as the caller named it. */
export interface StubRun {
  position: number
  caseId: string
  side: string
}

/** The three facts kept about a tool result a request carries. */
export interface StubToolResult {
  isError: boolean
  namesUnavailableTool: boolean
  canary: boolean
}

export interface AdversarialStubRequest {
  /** 1-based, in arrival order, since the stub started or was last reset. */
  index: number
  provider: string
  at: number
  method: string
  path: string
  /** `true` for a model request in the stub's format. */
  model: boolean
  authHeaderPresent: boolean
  /** The tool names the request offered, as sent. */
  offered: string[]
  stage: StubStage
  toolResult: StubToolResult | null
  served: StubServed
  run: StubRun | null
  /** For `hang`: when the connection closed, if it did. */
  closed?: { at: number; afterMs: number }
}

/** What a script is asked about one model request that offers the answer tool. */
export interface StubTurn {
  stage: StubStage
  hasToolResult: boolean
  run: StubRun | null
  /** 1-based count of such requests since the last reset. */
  index: number
  /** 1-based count of such requests for this run since the last reset. */
  runIndex: number
}

export interface AdversarialStubScript {
  /** The discovery answer for a run. Empty findings when absent. */
  discovery?: (run: StubRun | null) => unknown
  /** The step served. `answer` when absent. */
  serve?: (turn: StubTurn) => StubStep
  /** For `unoffered-tool`: the tool called and its input. */
  unofferedCall?: { tool: string; input: unknown }
}

export interface AdversarialStub {
  provider: string
  format: OAuthStubFormat
  baseURL: string
  /** Starts a new generation: earlier requests are neither recorded nor answered from the new script. */
  reset(script?: AdversarialStubScript): void
  setRun(run: StubRun | null): void
  /** The token whose presence in a tool result is recorded as `canary: true`. Never stored in a record. */
  setCanary(token: string | null): void
  /** Called with each model request's record before it is answered. A throw or a rejection is ignored. */
  onRequest(hook: ((request: AdversarialStubRequest) => void | Promise<void>) | null): void
  requests(): AdversarialStubRequest[]
  stop(): Promise<void>
  /** The handler the server calls, exposed so a test can hand it a request directly. */
  handle(request: Request): Promise<Response>
}

const AUTH_HEADERS = ["authorization", "x-api-key", "api-key"] as const
const ANSWER_TOOL = /^(mcp_)?structuredoutput$/i
// The measured host's wording for a call to a tool it did not offer.
const UNAVAILABLE = /unavailable tool/i

/** One schema-valid answer per stage whose answer does not depend on the run. */
export const STAGE_ANSWERS: Readonly<Record<Exclude<StubStage, "discover" | "side" | "unknown">, unknown>> = {
  debate: { turns: [] },
  "evidence-extract": { evidence: "The change adds the line the finding cites.", pointers: [] },
  "fact-check": { checks: ["read the cited lines"], findings: "The cited lines read as the finding says.", verdict: "upheld", evidenceKind: "line-cite" },
  "logic-eval": { assessment: "The argument follows from the cited lines." },
  aggregate: { verdict: "upheld", reasoning: "The cited lines say what the finding claims.", evidenceKind: "line-cite" },
}

/** Which stage an answer schema belongs to, by its top-level property names. */
export function stageOf(properties: readonly string[]): StubStage {
  const has = (name: string) => properties.includes(name)
  if (has("turns")) return "debate"
  if (has("assessment")) return "logic-eval"
  if (has("checks") || has("unchecked")) return "fact-check"
  if (has("evidence")) return "evidence-extract"
  if (has("reasoning") && has("verdict")) return "aggregate"
  if (has("findings")) return "discover"
  return "unknown"
}

interface ParsedRequest {
  offered: string[]
  /** The answer tool's schema property names, or `null` when no answer tool was offered. */
  answerProperties: string[] | null
  toolResult: { isError: boolean; text: string } | null
}

const asRecord = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {})
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** Reads the offered tools, the answer schema's property names and the last tool result out of a request body. */
export function parseRequest(format: OAuthStubFormat, body: unknown): ParsedRequest {
  const root = asRecord(body)
  const offered: string[] = []
  let answerProperties: string[] | null = null
  for (const entry of asArray(root.tools)) {
    const tool = asRecord(entry)
    const fn = format === "messages" ? tool : asRecord(tool.function)
    const name = typeof fn.name === "string" ? fn.name : undefined
    if (name === undefined) continue
    offered.push(name)
    if (ANSWER_TOOL.test(name)) {
      const schema = asRecord(format === "messages" ? fn.input_schema : fn.parameters)
      answerProperties = Object.keys(asRecord(schema.properties))
    }
  }
  let toolResult: ParsedRequest["toolResult"] = null
  for (const entry of asArray(root.messages)) {
    const message = asRecord(entry)
    if (format === "messages") {
      for (const part of asArray(message.content)) {
        const block = asRecord(part)
        if (block.type === "tool_result") toolResult = { isError: block.is_error === true, text: JSON.stringify(block.content ?? "") }
      }
    } else if (message.role === "tool") {
      toolResult = { isError: false, text: JSON.stringify(message.content ?? "") }
    }
  }
  return { offered, answerProperties, toolResult }
}

function sse(events: { event?: string; data: unknown }[]): string {
  return events.map((entry) => `${entry.event === undefined ? "" : `event: ${entry.event}\n`}data: ${JSON.stringify(entry.data)}\n\n`).join("")
}

/** A streamed plain-text answer, for a host side request that offers no answer tool. */
export function textAnswer(format: OAuthStubFormat, index: number): string {
  if (format === "messages") {
    return sse([
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: { id: `msg_stub_${index}`, type: "message", role: "assistant", model: "stub", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
        },
      },
      { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Title" } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } } },
      { event: "message_stop", data: { type: "message_stop" } },
    ])
  }
  const base = { id: `chatcmpl-stub-${index}`, object: "chat.completion.chunk", created: 0, model: "stub" }
  return (
    sse([
      { data: { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Title" }, finish_reason: null }] } },
      { data: { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] } },
      { data: { ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } } },
    ]) + "data: [DONE]\n\n"
  )
}

export function startAdversarialStub(provider: string, format: OAuthStubFormat): AdversarialStub {
  let script: AdversarialStubScript = {}
  let recorded: AdversarialStubRequest[] = []
  let generation = 0
  let run: StubRun | null = null
  let canary: string | null = null
  let hook: ((request: AdversarialStubRequest) => void | Promise<void>) | null = null
  let turns = 0
  const perRun = new Map<number, number>()
  const hung = new Set<() => void>()
  const suffix = format === "messages" ? "/messages" : "/chat/completions"
  const stream = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } })
  const tooled = (index: number, payload: unknown, options: { tool?: string; usage?: boolean } = {}) =>
    format === "messages" ? messagesAnswer(index, payload, options) : chatCompletionsAnswer(index, payload, options)

  const handle = async (request: Request): Promise<Response> => {
    const born = generation
    const url = new URL(request.url)
    const isModel = request.method === "POST" && url.pathname.endsWith(suffix)
    // Parsed to choose the answer; only the names and booleans below leave this function.
    const body: unknown = isModel ? await request.json().catch(() => ({})) : await request.arrayBuffer().then(() => ({}), () => ({}))
    if (born !== generation) return new Response("stale", { status: 503 })
    const parsed = isModel ? parseRequest(format, body) : { offered: [], answerProperties: null, toolResult: null }
    const stage: StubStage = !isModel ? "unknown" : parsed.answerProperties === null ? "side" : stageOf(parsed.answerProperties)
    const entry: AdversarialStubRequest = {
      index: recorded.length + 1,
      provider,
      at: Date.now(),
      method: request.method,
      path: url.pathname,
      model: isModel,
      authHeaderPresent: AUTH_HEADERS.some((name) => request.headers.has(name)),
      offered: parsed.offered,
      stage,
      toolResult:
        parsed.toolResult === null
          ? null
          : {
              isError: parsed.toolResult.isError,
              namesUnavailableTool: UNAVAILABLE.test(parsed.toolResult.text),
              canary: canary !== null && parsed.toolResult.text.includes(canary),
            },
      served: "not-a-model-request",
      run: run === null ? null : { ...run },
    }
    recorded.push(entry)
    if (!isModel) return new Response("not found", { status: 404 })
    if (parsed.answerProperties === null) {
      entry.served = "side-text"
      return stream(textAnswer(format, entry.index))
    }
    turns += 1
    const position = run?.position ?? 0
    perRun.set(position, (perRun.get(position) ?? 0) + 1)
    const turn: StubTurn = { stage, hasToolResult: parsed.toolResult !== null, run: entry.run, index: turns, runIndex: perRun.get(position)! }
    const step = script.serve?.(turn) ?? "answer"
    entry.served = step
    try {
      await hook?.({ ...entry })
    } catch {
      // A caller's observation never changes what the stub serves.
    }
    if (born !== generation) return new Response("stale", { status: 503 })
    if (step === "http-400" || step === "http-500") {
      const status = step === "http-400" ? 400 : 500
      const kind = status === 400 ? "invalid_request_error" : "api_error"
      const message = `stub ${status}`
      return Response.json(format === "messages" ? { type: "error", error: { type: kind, message } } : { error: { message, type: kind } }, { status })
    }
    if (step === "hang") {
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
    if (step === "unoffered-tool" && script.unofferedCall !== undefined) {
      return stream(tooled(entry.index, script.unofferedCall.input, { tool: script.unofferedCall.tool }))
    }
    const payload = stage === "discover" ? (script.discovery?.(entry.run) ?? { findings: [] }) : stage === "unknown" || stage === "side" ? {} : STAGE_ANSWERS[stage]
    return stream(tooled(entry.index, payload, { usage: step !== "no-usage" }))
  }

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: handle })
  const origin = `http://127.0.0.1:${server.port}`
  return {
    provider,
    format,
    baseURL: format === "messages" ? `${origin}/v1` : origin,
    reset(next = {}) {
      generation += 1
      script = next
      recorded = []
      turns = 0
      perRun.clear()
      run = null
      for (const release of [...hung]) release()
    },
    setRun(next) {
      run = next
    },
    setCanary(token) {
      canary = token
    },
    onRequest(next) {
      hook = next
    },
    requests: () => recorded.map((entry) => ({ ...entry, offered: [...entry.offered], ...(entry.toolResult ? { toolResult: { ...entry.toolResult } } : {}), ...(entry.closed ? { closed: { ...entry.closed } } : {}) })),
    async stop() {
      for (const release of [...hung]) release()
      await server.stop(true)
    },
    handle,
  }
}
