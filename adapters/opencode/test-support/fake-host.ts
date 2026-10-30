/**
 * A fake opencode host for the offline acceptance suite (CAP-1).
 *
 * A loopback HTTP server that answers the routes MAD calls on the shipped plugin
 * path, so the real SDK clients, the real `MadPlugin` entry and the real
 * `OpencodeModelBackend` run unmodified against it:
 *
 * - `GET /config/providers` — the roster `resolveRoster` reads.
 * - `POST /session` — one fresh id per call, answered with the body's
 *   `permission` echoed back as a real host stores it (`echo` overrides that).
 * - `POST /session/:id/message` — a schema-valid fake provider answer.
 * - `DELETE /session/:id` — the backend's bounded dispose.
 * - `POST /session/:id/abort` — counted and answered, so a test can assert MAD
 *   never sends it (CAP-5: a stop is disclosed, not aborted on the host).
 *
 * The answer to a prompt is chosen from what the request ASKS for, never from a
 * call counter. A judge turn is recognised by its instruction text
 * (`judgeRoleOf`), and a discovery turn by its response format's one top-level
 * key, `findings`. Debate is not scripted: a scenario whose findings would be
 * contested has to add a debate answer first. Anything the fake cannot answer
 * honestly is recorded in `problems` and answered with an error, never with a
 * happy default. That covers an unknown route, a malformed body, a prompt or
 * delete for a session it never created, and a turn with no script, debate
 * included. A scenario asserts `problems` is empty.
 */

import type { Severity } from "../../../core/domain/finding.ts"
import { DEFAULT_JUDGE_ANSWERS, judgeRoleOf } from "../../../core/test-support/fakes.ts"
import { READ_ONLY_SESSION_NOTICE } from "../session-policy.ts"

/** One model's entry in the provider list, in the host's `config.providers` shape. */
function model(id: string) {
  return { id, name: id, capabilities: { toolcall: true }, limit: { context: 200000 }, cost: { input: 3, output: 15 } }
}

/** Three lineages, so the default three discovery slots can be filled (AD-4). */
export const THREE_PROVIDERS = {
  providers: [
    { id: "anthropic", name: "Anthropic", source: "env", env: [], options: {}, models: { a: model("claude-sonnet-4-5") } },
    { id: "openai", name: "OpenAI", source: "env", env: [], options: {}, models: { b: model("gpt-5") } },
    { id: "google", name: "Google", source: "env", env: [], options: {}, models: { c: model("gemini-2.5-pro") } },
  ],
  default: {},
}

/** A finding the fake reports from discovery. */
export interface FakeFinding {
  claim: string
  reasoning: string
  severity: Severity
  file: string
  startLine?: number
  endLine?: number
}

export interface FakeHostOptions {
  /** What every discovery turn returns. Omitted means discovery is not scripted. */
  discovery?: FakeFinding[]
  /** Overrides for judge-role answers; a role not named here gets `DEFAULT_JUDGE_ANSWERS`. */
  judge?: Partial<Record<keyof typeof DEFAULT_JUDGE_ANSWERS, unknown>>
  /** The token figures reported on every settled message. */
  tokens?: { input: number; output: number }
  /**
   * CAP-3 — what the session answer carries as `permission`, for the
   * `index`-th create (from 0). Omitted means the body's own `permission`, as
   * the host stores it. Return `OMIT` to leave the field out.
   */
  echo?: (requested: unknown, index: number) => unknown
  /** CAP-3 — the `index`-th create (from 0) answers 500 with no session. */
  failCreate?: (index: number) => boolean
  /** CAP-3 — a delete for this session answers 500, and the session stays open. */
  failDelete?: (sessionID: string) => boolean
  /** A prompt answers 500 instead of a scripted answer. The session is still counted. */
  failPrompt?: (sessionID: string) => boolean
  /** Held before the roster read is answered, so a test can keep it in flight. */
  holdProviders?: () => Promise<void> | undefined
  /** When true, the provider list request is answered with a host error. */
  failProviders?: () => boolean
  /** Held before the `index`-th create (from 0) is answered, so a test can keep it in flight. */
  holdCreate?: (index: number) => Promise<void> | undefined
  /** Rewrites the `index`-th create's answer body, for answers a real host should not give. */
  createAnswer?: (answer: Record<string, unknown>, index: number) => unknown
  /** Held before a prompt is answered, so a test can keep a turn in flight. */
  holdPrompt?: (sessionID: string) => Promise<void> | undefined
}

/** Returned from `echo` to leave `permission` out of the session answer. */
export const OMIT = Symbol("omit")

export interface FakeHost {
  /** `http://127.0.0.1:<ephemeral port>` — no fixed port is assumed. */
  readonly url: string
  readonly origin: string
  readonly counts: { providers: number; create: number; prompt: number; delete: number; abort: number }
  /** Every `POST /session` body, in order, as JSON. */
  readonly creates: unknown[]
  /** The ids handed out, in create order. */
  readonly sessionIds: string[]
  /** Every prompt's `system` text and joined text parts, in arrival order, with its session id. */
  readonly prompts: { sessionID: string; system: string; text: string }[]
  /** Every request the fake could not answer honestly. Must be empty after a scenario. */
  readonly problems: string[]
  /** Sessions created and not yet deleted. */
  readonly openSessions: ReadonlySet<string>
  stop(): Promise<void>
}

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The top-level property names of a JSON Schema object, or `[]`. */
function schemaKeys(format: unknown): string[] {
  if (!isObject(format) || !isObject(format.schema) || !isObject(format.schema.properties)) return []
  return Object.keys(format.schema.properties).sort()
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

export function startFakeHost(options: FakeHostOptions = {}): FakeHost {
  const counts = { providers: 0, create: 0, prompt: 0, delete: 0, abort: 0 }
  const problems: string[] = []
  const open = new Set<string>()
  const creates: unknown[] = []
  const sessionIds: string[] = []
  const prompts: { sessionID: string; system: string; text: string }[] = []
  let nextSession = 0
  const tokens = options.tokens ?? { input: 100, output: 50 }

  function refuse(why: string, status = 400): Response {
    problems.push(why)
    return json({ name: "FakeHostError", data: { message: why } }, status)
  }

  function answerFor(body: JsonObject): unknown | Response {
    const keys = schemaKeys(body.format).join(",")
    // The plugin appends its read-only notice after the instructions; the role
    // is read from what comes before it, exactly as before.
    const raw = typeof body.system === "string" ? body.system : ""
    const suffix = `\n\n${READ_ONLY_SESSION_NOTICE}`
    const system = raw.endsWith(suffix) ? raw.slice(0, -suffix.length) : raw
    const role = judgeRoleOf(system)
    if (role !== undefined) return options.judge !== undefined && role in options.judge ? options.judge[role] : DEFAULT_JUDGE_ANSWERS[role]
    if (keys === "findings") {
      if (options.discovery === undefined) return refuse("a discovery turn arrived and none is scripted")
      return { findings: options.discovery }
    }
    return refuse(`no scripted answer for a turn whose format has keys [${keys}]`)
  }

  async function prompt(sessionID: string, request: Request): Promise<Response> {
    counts.prompt++
    if (!open.has(sessionID)) return refuse(`prompt for a session that was not created: ${sessionID}`, 404)
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return refuse("prompt body is not JSON")
    }
    if (!isObject(body) || !Array.isArray(body.parts) || !isObject(body.format) || !isObject(body.model)) {
      return refuse("prompt body lacks parts, format or model")
    }
    prompts.push({
      sessionID,
      system: typeof body.system === "string" ? body.system : "",
      text: body.parts.map((part) => (isObject(part) && typeof part.text === "string" ? part.text : "")).join("\n"),
    })
    await options.holdPrompt?.(sessionID)
    if (options.failPrompt?.(sessionID)) return json({ name: "UnknownError", data: { message: "fake prompt failure" } }, 500)
    const answer = answerFor(body)
    if (answer instanceof Response) return answer
    return json({
      info: {
        id: `msg_${sessionID}_${counts.prompt}`,
        sessionID,
        role: "assistant",
        structured: answer,
        tokens: { input: tokens.input, output: tokens.output, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [],
    })
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const path = url.pathname
      if (request.method === "GET" && path === "/config/providers") {
        counts.providers++
        await options.holdProviders?.()
        if (options.failProviders?.()) return json({ name: "UnknownError", data: { message: "fake provider failure" } }, 500)
        return json(THREE_PROVIDERS)
      }
      if (request.method === "POST" && path === "/session") {
        const index = counts.create++
        let body: unknown
        try {
          body = await request.json()
        } catch {
          body = undefined
        }
        creates.push(body)
        await options.holdCreate?.(index)
        if (options.failCreate?.(index)) return json({ name: "UnknownError", data: { message: "fake create failure" } }, 500)
        const id = `ses_fake_${++nextSession}`
        open.add(id)
        sessionIds.push(id)
        const requested = isObject(body) ? body.permission : undefined
        const permission = options.echo ? options.echo(requested, index) : requested
        const answer = {
          id,
          title: "fake",
          directory: url.searchParams.get("directory") ?? "",
          ...(permission === OMIT || permission === undefined ? {} : { permission }),
        }
        return json(options.createAnswer ? options.createAnswer(answer, index) : answer)
      }
      const message = /^\/session\/([^/]+)\/message$/.exec(path)
      if (request.method === "POST" && message) return prompt(decodeURIComponent(message[1]!), request)
      if (request.method === "POST" && /^\/session\/[^/]+\/abort$/.test(path)) {
        counts.abort++
        return json(true)
      }
      const session = /^\/session\/([^/]+)$/.exec(path)
      if (request.method === "DELETE" && session) {
        counts.delete++
        const id = decodeURIComponent(session[1]!)
        if (options.failDelete?.(id)) return json({ name: "UnknownError", data: { message: "fake delete failure" } }, 500)
        if (!open.delete(id)) return refuse(`delete for a session that was not created or is already gone: ${id}`, 404)
        return json(true)
      }
      return refuse(`unexpected route ${request.method} ${path}`, 404)
    },
  })

  const origin = `http://127.0.0.1:${server.port}`
  return {
    url: origin,
    origin,
    counts,
    creates,
    sessionIds,
    prompts,
    problems,
    openSessions: open,
    async stop() {
      await server.stop(true)
    },
  }
}
