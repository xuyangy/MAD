/**
 * Story 2-8c2 — the relay between the managed host and the provider, which
 * admits, forwards and measures every physical request.
 *
 * The measured host (opencode 1.18.32) sends more physical requests than MAD's
 * port calls: it retries a failed request itself (F2), and a host tool step is a
 * further request whose usage the settled message does not carry (F3, N2). It
 * also keeps a request open after MAD has settled its attempt (H1). All four are
 * in `ablation/evidence/host-accounting-2026-09-24.json`. The relay puts every
 * physical request back under admission:
 *
 * - **Attribution.** The measured host stamps `x-session-affinity` and
 *   `X-Session-Id` with its session id on every provider request, and the
 *   backend opens one session per attempt. A request is forwarded only when both
 *   headers are present, equal, and name a session the backend opened with the
 *   attempt's admission handle. This header is a fact about the measured host,
 *   re-verified by the accounting probe, not an opencode contract.
 * - **Only the host.** A request must carry this relay's host key, a random
 *   string made when the relay starts and given only to the host it fronts. Only
 *   a completion request is forwarded, and a streamed one only when it asks for
 *   the usage chunk (`stream_options.include_usage`), which the measured host
 *   does for every `@ai-sdk/openai-compatible` provider.
 * - **Admission before forwarding.** A session's first request is the attempt the
 *   stage already admitted. Each later one (a tool step) is admitted through the
 *   handle first, which asks the stage's ledger gate and then the journal's, and
 *   is forwarded only once that admission is durable.
 * - **Retries refused.** After a forwarded request failed (an error status, or a
 *   response that broke off), the session's next request is the host retrying
 *   it, and MAD's retry policy is the only one: it is refused, not admitted, not
 *   forwarded. So is a second request while one is still open.
 * - **Usage measured here.** A request's figure is the `usage` the provider
 *   returned for it: the SSE usage chunk, or the JSON body's field. A forwarded
 *   request without one, including an error status before any body, is
 *   `unknown`. An error status does not prove that nothing was billed.
 * - **Nothing stays open.** Closing a session aborts its open upstream request,
 *   waits for an admission still being decided, and refuses anything the host
 *   sends afterwards. A request that has not settled when the wait ends is
 *   settled `unknown` then, so no journal line is left in flight.
 * - **The credential.** The relay alone holds the provider credential and sets
 *   it upstream. The host holds only the host key, so the host process never
 *   holds the real one.
 *
 * Every refusal is a local `400`, which the measured host does not retry (the
 * probe's `400` scenario).
 */

import { randomUUID } from "node:crypto"

import type { AdmissionSettlement, AdmittedTurn, StepDecision } from "../core/ports/admission.ts"
import { addTokens, emptyTokenUsage, type TokenUsage } from "../core/domain/run-record.ts"
import type { MeteredUsage, RequestMeterPort, MeteredSession } from "../adapters/opencode/model-backend.ts"
import { redactText, secretForms } from "./managed-host.ts"

/** Every host key starts with this, so a record of a request can tell one from a provider credential. */
export const RELAY_KEY_PREFIX = "mad-relay-host-key-"

/** The path prefix the host's `baseURL` carries; the rest of the path is the provider's. */
const RELAY_PREFIX = "/relay"

/** The provider paths the relay forwards: completion requests, and nothing else. */
const COMPLETION_PATHS = ["/chat/completions", "/completions"]

/** How long closing a session waits for an aborted request, or an admission, to settle. */
const DEFAULT_CLOSE_WAIT_MS = 5_000

/** How much of an upstream error body the relay reads before passing it on. */
const ERROR_BODY_LIMIT = 64 * 1024

/** Request headers never forwarded: the relay sets its own, and none may carry a key upstream. */
const DROPPED_REQUEST_HEADERS = ["host", "authorization", "x-api-key", "api-key", "content-length", "accept-encoding", "connection"]

/** Response headers never passed back to the host. */
const DROPPED_RESPONSE_HEADERS = ["content-length", "content-encoding", "transfer-encoding", "connection", "set-cookie"]

export interface RequestMeterOptions {
  /** The provider's base URL, as `--provider-url` gave it. */
  upstream: string
  /** The provider credential. Sent upstream as a bearer token and nowhere else. */
  credential: string
  /** Injected in tests. */
  fetch?: (request: Request) => Promise<Response>
  /** How long `close` waits for an aborted request or a pending admission; defaults to five seconds. */
  closeWaitMs?: number
  now?: () => number
}

/** One request the relay received, whether or not it went upstream. */
export interface RelayEvent {
  at: number
  /** The session the request named, when it named one. */
  session: string | null
  path: string
  /** `forwarded`, or why it was refused. */
  outcome: "forwarded" | "refused"
  /** The physical request's place in its session (1 for the first), when forwarded. */
  step?: number
  /** The refusal's reason. */
  reason?: string
  /** The upstream status, when forwarded and answered. */
  status?: number
  /** What the forwarded request settled as. */
  settlement?: AdmissionSettlement
  /** Milliseconds from the session's close to the upstream request's end, when close ended it. */
  closedAfterClose?: number
}

export interface RequestMeter extends RequestMeterPort {
  /** The `baseURL` the host's provider block points at. */
  readonly baseURL: string
  /** The key the host is given in place of the credential; the relay forwards nothing without it. */
  readonly hostKey: string
  /** Every request the relay received, in order. */
  events(): RelayEvent[]
  /** Closes every open session and stops listening. */
  stop(): Promise<void>
}

interface PhysicalRecord {
  step: number
  settled: Promise<AdmissionSettlement>
  /** Settles the request `unknown` now, if it has not settled. */
  expire(why: string): Promise<void>
}

interface SessionState {
  id: string
  admitted: AdmittedTurn
  records: PhysicalRecord[]
  busy: boolean
  failed: boolean
  closed: boolean
  closedAt?: number
  /** Aborts the request that is open, if one is. */
  abort?: AbortController
  /** A step admission being decided, which `close` waits for. */
  admitting?: Promise<unknown>
  /** The session's close, once asked for: closing twice returns the first result. */
  closing?: Promise<MeteredUsage>
}

/** Usage fields that report cache writes; MAD cannot tell how a provider counts them, so their presence makes a figure unusable. */
const CACHE_WRITE_FIELDS = ["cache_creation_input_tokens", "cache_write_tokens", "cache_creation_tokens"]

/**
 * A usage object as an OpenAI-compatible provider returns it, mapped to MAD's
 * five integers, or why it cannot be.
 */
export function usageFrom(value: unknown): TokenUsage | string {
  if (value === null || typeof value !== "object") return "the usage figure was not an object"
  const usage = value as Record<string, unknown>
  const whole = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0
  const prompt = usage.prompt_tokens
  const completion = usage.completion_tokens
  if (!whole(prompt) || !whole(completion)) return "the usage figure had no whole prompt_tokens and completion_tokens"
  const promptDetails = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>
  const completionDetails = (usage.completion_tokens_details ?? {}) as Record<string, unknown>
  const writes = CACHE_WRITE_FIELDS.filter((field) => (usage[field] ?? promptDetails[field] ?? 0) !== 0)
  if (writes.length > 0) return `the usage figure reports cache writes (${writes.join(", ")}), which the relay cannot place`
  const cached = promptDetails.cached_tokens ?? 0
  const reasoning = completionDetails.reasoning_tokens ?? 0
  if (!whole(cached) || !whole(reasoning) || cached > prompt || reasoning > completion) {
    return "the usage figure's cached or reasoning count is not a part of its prompt or completion count"
  }
  // `completion_tokens` includes reasoning and `prompt_tokens` includes cached
  // input, and the ledger sums all five fields, so each is counted once.
  return { input: prompt - cached, output: completion - reasoning, reasoning, cacheRead: cached, cacheWrite: 0 }
}

/** Reads SSE text as it arrives and keeps the last `usage` a data line carried. */
class UsageScanner {
  private buffer = ""
  usage: TokenUsage | null = null
  /** Why a line that carried usage could not be read, if one could not. */
  unusable: string | null = null

  push(text: string): void {
    this.buffer += text
    let newline = this.buffer.indexOf("\n")
    while (newline >= 0) {
      this.line(this.buffer.slice(0, newline).replace(/\r$/, ""))
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf("\n")
    }
  }

  end(): void {
    if (this.buffer.length > 0) this.line(this.buffer)
    this.buffer = ""
  }

  private line(line: string): void {
    if (!line.startsWith("data:")) return
    const data = line.slice(5).trim()
    if (data === "" || data === "[DONE]") return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      // A line that is not JSON carries no figure; only one that names usage can hide one.
      if (data.includes("usage")) this.unusable ??= "a stream line that names usage was not JSON"
      return
    }
    const usage = (parsed as { usage?: unknown } | null)?.usage
    if (usage === undefined || usage === null) return
    const mapped = usageFrom(usage)
    if (typeof mapped === "string") this.unusable ??= mapped
    else this.usage = mapped
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** At most `limit` bytes of a body, read without buffering the rest. */
async function boundedText(response: Response, limit: number): Promise<string> {
  if (response.body === null) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < limit) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, limit))
}

export function startRequestMeter(options: RequestMeterOptions): RequestMeter {
  const upstream = options.upstream.replace(/\/+$/, "")
  const send = options.fetch ?? ((request: Request) => fetch(request))
  const now = options.now ?? Date.now
  const closeWaitMs = options.closeWaitMs ?? DEFAULT_CLOSE_WAIT_MS
  const hostKey = `${RELAY_KEY_PREFIX}${randomUUID()}`
  const secrets = secretForms(options.credential)
  const sessions = new Map<string, SessionState>()
  const log: RelayEvent[] = []
  const redact = (text: string): string => redactText(text, secrets)

  const refusal = (reason: string): Response =>
    new Response(JSON.stringify({ error: { message: `MAD relay refused this request: ${redact(reason)}`, type: "mad_relay_refused" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })

  const refuse = (event: Omit<RelayEvent, "outcome" | "at">, reason: string): Response => {
    log.push({ at: now(), ...event, outcome: "refused", reason: redact(reason) })
    return refusal(reason)
  }

  const passHeaders = (response: Response): Headers => {
    const headers = new Headers(response.headers)
    for (const name of DROPPED_RESPONSE_HEADERS) headers.delete(name)
    return headers
  }

  /** Forwards one admitted request and settles it; resolves with the host's response. */
  const forward = async (
    request: Request,
    body: ArrayBuffer,
    rest: string,
    session: SessionState,
    step: number,
    settle: (settlement: AdmissionSettlement) => Promise<void>,
  ): Promise<Response> => {
    const event: RelayEvent = { at: now(), session: session.id, path: rest, outcome: "forwarded", step }
    log.push(event)
    let resolveSettled!: (settlement: AdmissionSettlement) => void
    const settled = new Promise<AdmissionSettlement>((resolve) => (resolveSettled = resolve))
    const unknown = (why: string): AdmissionSettlement => ({ kind: "unknown", why: redact(why) })
    /** Settles once, whichever of the response, the stream or the close wait comes first. `failed` refuses the session's next request as a retry. */
    const finish = async (settlement: AdmissionSettlement, failed: boolean): Promise<void> => {
      if (event.settlement !== undefined) return
      event.settlement = settlement
      if (session.closedAt !== undefined) event.closedAfterClose = now() - session.closedAt
      session.busy = false
      session.abort = undefined
      if (failed) session.failed = true
      try {
        await settle(settlement)
      } catch {
        // A settlement never rejects by contract; if one does, the record still resolves.
      } finally {
        resolveSettled(settlement)
      }
    }
    session.records.push({ step, settled, expire: (why) => finish(unknown(why), true) })

    const controller = new AbortController()
    session.abort = controller
    const headers = new Headers(request.headers)
    for (const name of DROPPED_REQUEST_HEADERS) headers.delete(name)
    headers.set("authorization", `Bearer ${options.credential}`)
    // Identity encoding, so the relay can read the usage in the body it passes on.
    headers.set("accept-encoding", "identity")
    const target = `${upstream}${rest}${new URL(request.url).search}`
    let response: Response
    try {
      response = await send(
        new Request(target, { method: request.method, headers, body: body.byteLength > 0 ? body : undefined, signal: controller.signal }),
      )
    } catch (error) {
      await finish(unknown(`the request was forwarded and failed before a response: ${messageOf(error)}`), true)
      return new Response(JSON.stringify({ error: { message: redact(messageOf(error)), type: "mad_relay_upstream" } }), {
        status: 502,
        headers: { "content-type": "application/json" },
      })
    }
    event.status = response.status

    if (!response.ok) {
      let text = ""
      try {
        text = await boundedText(response, ERROR_BODY_LIMIT)
      } catch {
        // The body is the provider's; its loss changes nothing about the settlement.
      }
      await finish(unknown(`the provider answered HTTP ${response.status}, which carries no usage figure`), true)
      return new Response(redact(text), { status: response.status, headers: passHeaders(response) })
    }

    const streamed = (response.headers.get("content-type") ?? "").includes("text/event-stream")
    if (!streamed || response.body === null) {
      let text: string
      try {
        text = await response.text()
      } catch (error) {
        await finish(unknown(`the response body could not be read: ${messageOf(error)}`), true)
        return new Response(JSON.stringify({ error: { message: "the provider's response could not be read", type: "mad_relay_upstream" } }), {
          status: 502,
          headers: { "content-type": "application/json" },
        })
      }
      let usage: TokenUsage | string
      try {
        usage = usageFrom((JSON.parse(text) as { usage?: unknown }).usage)
      } catch {
        usage = "the provider's response was not JSON"
      }
      // A complete answer with no figure is unknown, and not a failure: the host's next request is a step, not a retry.
      await finish(typeof usage === "string" ? unknown(usage) : { kind: "usage", tokens: usage }, false)
      return new Response(text, { status: response.status, headers: passHeaders(response) })
    }

    const scanner = new UsageScanner()
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    const out = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            scanner.end()
            const why = scanner.unusable ?? (scanner.usage === null ? "the provider's stream ended with no usage figure" : null)
            await finish(why === null ? { kind: "usage", tokens: scanner.usage! } : unknown(why), false)
            stream.close()
            return
          }
          scanner.push(decoder.decode(value, { stream: true }))
          stream.enqueue(value)
        } catch (error) {
          await finish(unknown(`the provider's stream ended early: ${messageOf(error)}`), true)
          stream.error(error)
        }
      },
      async cancel() {
        controller.abort()
        await finish(unknown("the host stopped reading the provider's stream before it ended"), true)
      },
    })
    return new Response(out, { status: response.status, headers: passHeaders(response) })
  }

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (!url.pathname.startsWith(`${RELAY_PREFIX}/`)) return refuse({ session: null, path: url.pathname }, "the path is not under the relay prefix")
    const rest = url.pathname.slice(RELAY_PREFIX.length)
    const affinity = request.headers.get("x-session-affinity")
    const sessionHeader = request.headers.get("x-session-id")
    const at = { session: affinity ?? sessionHeader, path: rest }
    if (request.headers.get("authorization") !== `Bearer ${hostKey}`) return refuse(at, "it does not carry this relay's host key")
    if (request.method !== "POST" || !COMPLETION_PATHS.some((path) => rest.endsWith(path))) {
      return refuse(at, `only a completion request is forwarded, and this is ${request.method} ${rest}`)
    }
    if (affinity === null || sessionHeader === null) return refuse(at, "it names no session")
    if (affinity !== sessionHeader) return refuse(at, "its two session headers disagree")
    const session = sessions.get(affinity)
    if (session === undefined) return refuse(at, "its session was not opened with an admitted attempt")
    if (session.closed) return refuse(at, "its attempt has already ended")
    if (session.busy) return refuse(at, "another request of the same attempt is still open")
    if (session.failed) {
      return refuse(at, "it follows a failed request of the same attempt, and MAD's retry policy is the only retry")
    }
    session.busy = true
    let body: ArrayBuffer
    try {
      body = await request.arrayBuffer()
    } catch (error) {
      session.busy = false
      return refuse(at, `its body could not be read: ${messageOf(error)}`)
    }
    let parsed: { stream?: unknown; stream_options?: { include_usage?: unknown } } = {}
    try {
      parsed = JSON.parse(new TextDecoder().decode(body)) as typeof parsed
    } catch {
      session.busy = false
      return refuse(at, "its body is not JSON")
    }
    if (parsed.stream === true && parsed.stream_options?.include_usage !== true) {
      session.busy = false
      return refuse(at, "it streams without asking for the usage chunk (`stream_options.include_usage`), so its figure could not be measured")
    }
    if (session.closed) {
      session.busy = false
      return refuse(at, "its attempt ended while its body was being read")
    }
    const step = session.records.length + 1
    if (step === 1) {
      return forward(request, body, rest, session, 1, (settlement) => session.admitted.settleFirst(settlement))
    }
    // The admission, and the not-issued settlement of a step whose attempt ended
    // meanwhile, are one promise, so `close` waits for both before it returns.
    const admitting = (async (): Promise<StepDecision | "ended"> => {
      let decision: StepDecision
      try {
        decision = await session.admitted.admitStep()
      } catch (error) {
        decision = { ok: false, cause: "runner-stop", reason: `the step's admission failed: ${messageOf(error)}` }
      }
      if (decision.ok && session.closed) {
        await decision.settle({ kind: "not-issued" }).catch(() => undefined)
        return "ended"
      }
      return decision
    })()
    session.admitting = admitting
    const decision = await admitting
    session.admitting = undefined
    if (decision === "ended") {
      session.busy = false
      return refuse(at, "its attempt ended while it was being admitted")
    }
    if (!decision.ok) {
      session.busy = false
      return refuse(at, `its admission was refused: ${decision.reason}`)
    }
    return forward(request, body, rest, session, decision.step, decision.settle)
  }

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: handle })

  /** Resolves when `promise` does, or after `ms`, whichever is first, and leaves no timer behind. */
  const within = async <T>(promise: Promise<T>, ms: number): Promise<T | "timed-out"> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([promise, new Promise<"timed-out">((resolve) => (timer = setTimeout(() => resolve("timed-out"), ms)))])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  const closeSession = (session: SessionState): Promise<MeteredUsage> => {
    session.closing ??= (async (): Promise<MeteredUsage> => {
      session.closed = true
      session.closedAt = now()
      session.abort?.abort()
      // An admission being decided settles its own step (not issued) once it returns.
      if (session.admitting !== undefined) await within(session.admitting, closeWaitMs)
      const settlements = await Promise.all(
        session.records.map(async (record) => {
          const settled = await within(record.settled, closeWaitMs)
          if (settled !== "timed-out") return settled
          await record.expire(`physical request ${record.step} did not settle within ${closeWaitMs}ms of the attempt ending`)
          return record.settled
        }),
      )
      if (session.records.length === 0) {
        // Nothing reached the provider: the host holds no credential, so no other
        // path to it exists. The attempt's first request is a known zero.
        await session.admitted.settleFirst({ kind: "usage", tokens: emptyTokenUsage() }).catch(() => undefined)
        return { kind: "usage", tokens: emptyTokenUsage(), physicalRequests: 0 }
      }
      const unknown = settlements.find((settlement) => settlement.kind !== "usage")
      if (unknown !== undefined) {
        return {
          kind: "unknown",
          why: unknown.kind === "unknown" ? unknown.why : "a physical request has no known figure",
          physicalRequests: session.records.length,
        }
      }
      const tokens = settlements.reduce(
        (total, settlement) => (settlement.kind === "usage" ? addTokens(total, settlement.tokens) : total),
        emptyTokenUsage(),
      )
      return { kind: "usage", tokens, physicalRequests: session.records.length }
    })()
    return session.closing
  }

  return {
    baseURL: `http://127.0.0.1:${server.port}${RELAY_PREFIX}`,
    hostKey,
    open(sessionID: string, admitted: AdmittedTurn): MeteredSession {
      const session: SessionState = { id: sessionID, admitted, records: [], busy: false, failed: false, closed: false }
      sessions.set(sessionID, session)
      return { close: () => closeSession(session) }
    },
    events: () => log.map((event) => ({ ...event })),
    async stop(): Promise<void> {
      await Promise.all([...sessions.values()].map((session) => closeSession(session)))
      server.stop(true)
    },
  }
}
