/**
 * Story 2-8c2 — the relay, against a local fake upstream. Every row of the
 * story's I/O matrix, the credential's boundary, and the usage mapping.
 */

import { afterEach, describe, expect, test } from "bun:test"

import type { AdmissionSettlement, AdmittedTurn, StepDecision } from "../core/ports/admission.ts"
import { stageGatedTurn } from "../core/stages/settlement.ts"
import { RELAY_KEY_PREFIX, startRequestMeter, usageFrom, type RequestMeter } from "./request-meter.ts"

const CREDENTIAL = "sk-test-relay-credential-0123456789"

type Behaviour = "ok" | "json" | "500" | "429" | "hang" | "no-usage"

interface Seen {
  authorization: string | null
  path: string
  aborted: boolean
  abortedAt?: number
}

function fakeUpstream(script: Behaviour[]) {
  const seen: Seen[] = []
  let otherwise: Behaviour = "ok"
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      await request.text()
      const entry: Seen = { authorization: request.headers.get("authorization"), path: new URL(request.url).pathname, aborted: false }
      seen.push(entry)
      const behaviour = script.shift() ?? otherwise
      const usage = { prompt_tokens: 100 * seen.length, completion_tokens: seen.length, total_tokens: 101 * seen.length }
      switch (behaviour) {
        case "500":
          return Response.json({ error: { message: "boom" } }, { status: 500 })
        case "429":
          return Response.json({ error: { message: "slow down" } }, { status: 429 })
        case "json":
          return Response.json({ id: "x", choices: [], usage })
        case "hang":
          return new Promise<Response>((resolve) => {
            request.signal.addEventListener("abort", () => {
              entry.aborted = true
              entry.abortedAt = Date.now()
              resolve(new Response("", { status: 499 }))
            })
          })
        case "no-usage":
          return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        default:
          return new Response(
            `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n` +
              `data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          )
      }
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    seen,
    set otherwise(value: Behaviour) {
      otherwise = value
    },
    stop: () => server.stop(true),
  }
}

/** An admission handle that records what the relay asked of it. */
function fakeTurn(steps: StepDecision[] = []) {
  const first: AdmissionSettlement[] = []
  const stepSettlements: AdmissionSettlement[] = []
  let asked = 0
  const turn: AdmittedTurn = {
    async admitStep() {
      asked += 1
      const decision = steps.shift() ?? { ok: true, step: asked + 1, settle: async (settlement: AdmissionSettlement) => void stepSettlements.push(settlement) }
      return decision
    },
    async settleFirst(settlement) {
      first.push(settlement)
    },
  }
  return { turn, first, stepSettlements, asked: () => asked }
}

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function relayTo(upstream: { url: string; stop: () => unknown }, closeWaitMs = 2_000): RequestMeter {
  const meter = startRequestMeter({ upstream: upstream.url, credential: CREDENTIAL, closeWaitMs })
  cleanups.push(() => upstream.stop())
  cleanups.push(() => meter.stop())
  return meter
}

/** A request as the measured host sends it: both session headers, the placeholder key. */
function hostRequest(meter: RequestMeter, session: string | null, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${meter.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${meter.hostKey}`,
      ...(session === null ? {} : { "x-session-affinity": session, "X-Session-Id": session }),
      ...headers,
    },
    body: JSON.stringify({ model: "m1", stream: true, stream_options: { include_usage: true } }),
  })
}

describe("usageFrom", () => {
  test("maps prompt and completion so the ledger counts cached input and reasoning once", () => {
    expect(
      usageFrom({
        prompt_tokens: 100,
        completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 40 },
        completion_tokens_details: { reasoning_tokens: 10 },
      }),
    ).toEqual({ input: 60, output: 20, reasoning: 10, cacheRead: 40, cacheWrite: 0 })
  })

  test("refuses anything that is not two whole counts with consistent details, naming why", () => {
    for (const value of [
      null,
      { prompt_tokens: 1 },
      { prompt_tokens: -1, completion_tokens: 1 },
      { prompt_tokens: 1.5, completion_tokens: 1 },
      { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 2 } },
    ]) {
      expect(typeof usageFrom(value), JSON.stringify(value)).toBe("string")
    }
  })

  test("a figure that reports cache writes is unusable, not a figure with the writes dropped", () => {
    expect(usageFrom({ prompt_tokens: 10, completion_tokens: 1, cache_creation_input_tokens: 5 })).toContain("cache writes")
    expect(usageFrom({ prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cache_write_tokens: 5 } })).toContain("cache writes")
    expect(usageFrom({ prompt_tokens: 10, completion_tokens: 1, cache_creation_input_tokens: 0 })).toMatchObject({ input: 10 })
  })
})

describe("the relay", () => {
  test("forwards an attempt's first request with the credential, and settles it with the provider's usage", async () => {
    const upstream = fakeUpstream(["ok"])
    const meter = relayTo(upstream)
    const turn = fakeTurn()
    const session = meter.open("ses_a", turn.turn)
    const response = await hostRequest(meter, "ses_a")
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("[DONE]")
    const measured = await session.close()
    expect(upstream.seen).toHaveLength(1)
    expect(upstream.seen[0]!.authorization).toBe(`Bearer ${CREDENTIAL}`)
    expect(upstream.seen[0]!.path).toBe("/v1/chat/completions")
    expect(turn.first).toEqual([{ kind: "usage", tokens: { input: 100, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }])
    expect(turn.asked()).toBe(0)
    expect(measured).toEqual({ kind: "usage", tokens: { input: 100, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, physicalRequests: 1 })
  })

  test("reads usage from a JSON body too", async () => {
    const upstream = fakeUpstream(["json"])
    const meter = relayTo(upstream)
    const turn = fakeTurn()
    const session = meter.open("ses_j", turn.turn)
    expect((await hostRequest(meter, "ses_j")).status).toBe(200)
    expect(await session.close()).toMatchObject({ kind: "usage", physicalRequests: 1 })
  })

  test("a tool step is admitted before it is forwarded, and the attempt's figure is the sum", async () => {
    const upstream = fakeUpstream(["ok", "ok"])
    const meter = relayTo(upstream)
    const order: string[] = []
    const stepSettlements: AdmissionSettlement[] = []
    const turn: AdmittedTurn = {
      async admitStep() {
        order.push(`admitted with ${upstream.seen.length} upstream request(s)`)
        return { ok: true, step: 2, settle: async (settlement) => void stepSettlements.push(settlement) }
      },
      async settleFirst() {},
    }
    const session = meter.open("ses_t", turn)
    await (await hostRequest(meter, "ses_t")).text()
    await (await hostRequest(meter, "ses_t")).text()
    const measured = await session.close()
    expect(order).toEqual(["admitted with 1 upstream request(s)"])
    expect(upstream.seen).toHaveLength(2)
    expect(stepSettlements).toEqual([{ kind: "usage", tokens: { input: 200, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }])
    expect(measured).toEqual({ kind: "usage", tokens: { input: 300, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, physicalRequests: 2 })
    expect(meter.events().map((event) => [event.outcome, event.step])).toEqual([
      ["forwarded", 1],
      ["forwarded", 2],
    ])
  })

  test("a step the experiment refuses gets a local 400 and is never forwarded", async () => {
    const upstream = fakeUpstream(["ok"])
    const meter = relayTo(upstream)
    const turn = fakeTurn([{ ok: false, cause: "budget", reason: "the Blocks allowance is exhausted" }])
    const session = meter.open("ses_r", turn.turn)
    await (await hostRequest(meter, "ses_r")).text()
    const refused = await hostRequest(meter, "ses_r")
    expect(refused.status).toBe(400)
    expect(await refused.text()).toContain("the Blocks allowance is exhausted")
    expect(upstream.seen).toHaveLength(1)
    expect(await session.close()).toMatchObject({ kind: "usage", physicalRequests: 1 })
  })

  test("a step the stage's own ledger refuses asks no journal admission and sends nothing upstream", async () => {
    const upstream = fakeUpstream(["ok"])
    const meter = relayTo(upstream)
    const inner = fakeTurn()
    const gated = stageGatedTurn(inner.turn, () => false, "debate")!
    const session = meter.open("ses_s", gated)
    await (await hostRequest(meter, "ses_s")).text()
    const refused = await hostRequest(meter, "ses_s")
    expect(refused.status).toBe(400)
    expect(await refused.text()).toContain("the run's own ledger refused a further debate request")
    expect(inner.asked()).toBe(0)
    expect(upstream.seen).toHaveLength(1)
    await session.close()
  })

  test("a request after a failed one is the host retrying: refused, not admitted, not forwarded", async () => {
    const upstream = fakeUpstream(["500"])
    const meter = relayTo(upstream)
    const turn = fakeTurn()
    const session = meter.open("ses_f", turn.turn)
    expect((await hostRequest(meter, "ses_f")).status).toBe(500)
    const retry = await hostRequest(meter, "ses_f")
    expect(retry.status).toBe(400)
    expect(await retry.text()).toContain("MAD's retry policy is the only retry")
    expect(turn.asked()).toBe(0)
    expect(upstream.seen).toHaveLength(1)
    const measured = await session.close()
    expect(measured.kind).toBe("unknown")
    expect(turn.first[0]).toMatchObject({ kind: "unknown" })
    expect((turn.first[0] as { why: string }).why).toContain("HTTP 500")
  })

  test("a provider 429 is unknown: an error status does not prove nothing was billed", async () => {
    const upstream = fakeUpstream(["429"])
    const meter = relayTo(upstream)
    const turn = fakeTurn()
    const session = meter.open("ses_429", turn.turn)
    expect((await hostRequest(meter, "ses_429")).status).toBe(429)
    expect(await session.close()).toMatchObject({ kind: "unknown", physicalRequests: 1 })
  })

  test("a stream that ends with no usage chunk is unknown", async () => {
    const upstream = fakeUpstream(["no-usage"])
    const meter = relayTo(upstream)
    const turn = fakeTurn()
    const session = meter.open("ses_n", turn.turn)
    await (await hostRequest(meter, "ses_n")).text()
    const measured = await session.close()
    expect(measured.kind).toBe("unknown")
    expect((measured as { why: string }).why).toContain("no usage figure")
  })

  test("a request that names no session, two different sessions, or an unopened one is refused locally", async () => {
    const upstream = fakeUpstream([])
    const meter = relayTo(upstream)
    meter.open("ses_known", fakeTurn().turn)
    const missing = await hostRequest(meter, null)
    const unequal = await hostRequest(meter, null, { "x-session-affinity": "ses_known", "X-Session-Id": "ses_other" })
    const unopened = await hostRequest(meter, "ses_nobody")
    expect([missing.status, unequal.status, unopened.status]).toEqual([400, 400, 400])
    expect(upstream.seen).toHaveLength(0)
    expect(meter.events().map((event) => event.reason)).toEqual([
      "it names no session",
      "its two session headers disagree",
      "its session was not opened with an admitted attempt",
    ])
  })

  test("a second request while the first is open is refused", async () => {
    const upstream = fakeUpstream(["hang"])
    const meter = relayTo(upstream, 500)
    const turn = fakeTurn()
    const session = meter.open("ses_busy", turn.turn)
    const first = hostRequest(meter, "ses_busy")
    while (upstream.seen.length === 0) await Bun.sleep(5)
    const second = await hostRequest(meter, "ses_busy")
    expect(second.status).toBe(400)
    expect(await second.text()).toContain("still open")
    await session.close()
    await first.catch(() => undefined)
    expect(upstream.seen).toHaveLength(1)
  })

  test("closing the attempt aborts an open upstream request, which settles unknown", async () => {
    const upstream = fakeUpstream(["hang"])
    const meter = relayTo(upstream, 2_000)
    const turn = fakeTurn()
    const session = meter.open("ses_h", turn.turn)
    const pending = hostRequest(meter, "ses_h").catch(() => undefined)
    while (upstream.seen.length === 0) await Bun.sleep(5)
    const closedAt = Date.now()
    const measured = await session.close()
    while (!upstream.seen[0]!.aborted && Date.now() - closedAt < 2_000) await Bun.sleep(5)
    expect(upstream.seen[0]!.aborted).toBe(true)
    expect(upstream.seen[0]!.abortedAt! - closedAt).toBeLessThan(1_000)
    expect(measured).toMatchObject({ kind: "unknown", physicalRequests: 1 })
    expect(turn.first[0]).toMatchObject({ kind: "unknown" })
    await pending
    // The attempt has ended: anything the host sends now is refused.
    const late = await hostRequest(meter, "ses_h")
    expect(late.status).toBe(400)
    expect(upstream.seen).toHaveLength(1)
  })

  test("an attempt whose host sent nothing settles its first request as a known zero", async () => {
    const upstream = fakeUpstream([])
    const meter = relayTo(upstream)
    const turn = fakeTurn()
    const measured = await meter.open("ses_0", turn.turn).close()
    expect(measured).toEqual({ kind: "usage", tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, physicalRequests: 0 })
    expect(turn.first).toEqual([{ kind: "usage", tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }])
  })

  test("the credential reaches only the upstream: not the host's responses, the events, or an error", async () => {
    const meter = startRequestMeter({
      upstream: "http://127.0.0.1:1/v1",
      credential: CREDENTIAL,
      fetch: async () => {
        throw new Error(`connect failed while sending Bearer ${CREDENTIAL}`)
      },
    })
    cleanups.push(() => meter.stop())
    const turn = fakeTurn()
    const session = meter.open("ses_c", turn.turn)
    const response = await hostRequest(meter, "ses_c")
    const text = await response.text()
    const measured = await session.close()
    expect(response.status).toBe(502)
    expect(text).not.toContain(CREDENTIAL)
    expect(JSON.stringify(meter.events())).not.toContain(CREDENTIAL)
    expect(JSON.stringify(measured)).not.toContain(CREDENTIAL)
    expect(JSON.stringify(turn.first)).not.toContain(CREDENTIAL)
    expect(meter.baseURL).not.toContain(CREDENTIAL)
  })
})

describe("the relay's boundary (review of story 2-8c2)", () => {
  test("a request without this relay's host key is refused, and nothing reaches upstream", async () => {
    const upstream = fakeUpstream(["ok"])
    const meter = relayTo(upstream)
    meter.open("ses_k", fakeTurn().turn)
    const wrong = await hostRequest(meter, "ses_k", { authorization: "Bearer someone-else" })
    expect(wrong.status).toBe(400)
    expect(upstream.seen).toHaveLength(0)
    expect(meter.hostKey.startsWith(RELAY_KEY_PREFIX)).toBe(true)
    expect(startRequestMeter({ upstream: upstream.url, credential: CREDENTIAL }).hostKey).not.toBe(meter.hostKey)
  })

  test("only a completion request is forwarded: another path uses up no step and reaches nothing", async () => {
    const upstream = fakeUpstream(["ok"])
    const meter = relayTo(upstream)
    const turn = fakeTurn()
    meter.open("ses_p", turn.turn)
    const models = await fetch(`${meter.baseURL}/models`, {
      headers: { authorization: `Bearer ${meter.hostKey}`, "x-session-affinity": "ses_p", "X-Session-Id": "ses_p" },
    })
    expect(models.status).toBe(400)
    expect(upstream.seen).toHaveLength(0)
    expect(turn.asked()).toBe(0)
    expect((await hostRequest(meter, "ses_p")).status).toBe(200)
  })

  test("a stream that does not ask for the usage chunk is refused before it is forwarded", async () => {
    const upstream = fakeUpstream(["ok"])
    const meter = relayTo(upstream)
    meter.open("ses_u", fakeTurn().turn)
    const response = await fetch(`${meter.baseURL}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${meter.hostKey}`, "x-session-affinity": "ses_u", "X-Session-Id": "ses_u" },
      body: JSON.stringify({ model: "m1", stream: true }),
    })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("include_usage")
    expect(upstream.seen).toHaveLength(0)
  })

  test("the host's key headers are not forwarded, and a provider cookie is not passed back", async () => {
    const seen: Headers[] = []
    const meter = startRequestMeter({
      upstream: "http://127.0.0.1:1/v1",
      credential: CREDENTIAL,
      fetch: async (request) => {
        seen.push(request.headers)
        return Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } }, { headers: { "set-cookie": "a=b" } })
      },
    })
    cleanups.push(() => meter.stop())
    const session = meter.open("ses_h", fakeTurn().turn)
    const response = await hostRequest(meter, "ses_h", { "x-api-key": "leak", "api-key": "leak" })
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(seen[0]!.get("x-api-key")).toBeNull()
    expect(seen[0]!.get("api-key")).toBeNull()
    expect(seen[0]!.get("authorization")).toBe(`Bearer ${CREDENTIAL}`)
    await session.close()
  })
})

describe("the relay's settlement paths (review of story 2-8c2)", () => {
  test("a complete answer with no figure is unknown, and the host's next request is a step, not a retry", async () => {
    const upstream = fakeUpstream(["no-usage", "ok"])
    const meter = relayTo(upstream)
    const turn = fakeTurn()
    const session = meter.open("ses_nu", turn.turn)
    await (await hostRequest(meter, "ses_nu")).text()
    const next = await hostRequest(meter, "ses_nu")
    expect(next.status).toBe(200)
    await next.text()
    expect(turn.asked()).toBe(1)
    expect(upstream.seen).toHaveLength(2)
    expect((await session.close()).kind).toBe("unknown")
  })

  test("a stream that stalls after its headers is aborted on close, settles unknown promptly, and fails the session", async () => {
    const meter = startRequestMeter({
      upstream: "http://127.0.0.1:1/v1",
      credential: CREDENTIAL,
      closeWaitMs: 2_000,
      fetch: async (request) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "h" } }] })}\n\n`))
            request.signal.addEventListener("abort", () => controller.error(new DOMException("aborted by the relay", "AbortError")))
          },
        })
        return new Response(stream, { headers: { "content-type": "text/event-stream" } })
      },
    })
    cleanups.push(() => meter.stop())
    const turn = fakeTurn()
    const session = meter.open("ses_stall", turn.turn)
    const response = await hostRequest(meter, "ses_stall")
    const reader = response.body!.getReader()
    await reader.read()
    const reading = reader.read().catch(() => undefined)
    const started = Date.now()
    const measured = await session.close()
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(measured.kind).toBe("unknown")
    expect(turn.first[0]).toMatchObject({ kind: "unknown" })
    await reading
  })

  test("a stream the host abandons mid-way settles unknown when its attempt ends, without waiting out the close", async () => {
    const meter = startRequestMeter({
      upstream: "http://127.0.0.1:1/v1",
      credential: CREDENTIAL,
      closeWaitMs: 2_000,
      fetch: async (request) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: {}\n\n"))
              request.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")))
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    })
    cleanups.push(() => meter.stop())
    const turn = fakeTurn()
    const session = meter.open("ses_ab", turn.turn)
    const response = await hostRequest(meter, "ses_ab")
    await response.body!.cancel()
    const started = Date.now()
    const measured = await session.close()
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(measured.kind).toBe("unknown")
    expect(turn.first).toHaveLength(1)
  })

  test("closing while a step is being admitted settles the step not-issued, refuses it, and forwards nothing", async () => {
    const upstream = fakeUpstream(["ok"])
    const meter = relayTo(upstream)
    let admitNow!: () => void
    const stepSettlements: AdmissionSettlement[] = []
    const turn: AdmittedTurn = {
      admitStep: () =>
        new Promise<StepDecision>((resolve) => {
          admitNow = () => resolve({ ok: true, step: 2, settle: async (settlement) => void stepSettlements.push(settlement) })
        }),
      settleFirst: async () => {},
    }
    const session = meter.open("ses_race", turn)
    await (await hostRequest(meter, "ses_race")).text()
    const step = hostRequest(meter, "ses_race")
    while (admitNow === undefined) await Bun.sleep(5)
    const closing = session.close()
    admitNow()
    await closing
    // The close waited for the admission, so the step was settled before it returned.
    expect(stepSettlements).toEqual([{ kind: "not-issued" }])
    expect((await step).status).toBe(400)
    expect(upstream.seen).toHaveLength(1)
  })

  test("a request still open when the close wait ends is settled unknown then, and a late answer changes nothing", async () => {
    let answer: ((response: Response) => void) | undefined
    const meter = startRequestMeter({
      upstream: "http://127.0.0.1:1/v1",
      credential: CREDENTIAL,
      closeWaitMs: 50,
      // An upstream that ignores the abort.
      fetch: () => new Promise<Response>((resolve) => (answer = resolve)),
    })
    cleanups.push(() => meter.stop())
    const turn = fakeTurn()
    const session = meter.open("ses_slow", turn.turn)
    const pending = hostRequest(meter, "ses_slow")
    while (answer === undefined) await Bun.sleep(5)
    const measured = await session.close()
    expect(measured.kind).toBe("unknown")
    expect(turn.first).toHaveLength(1)
    expect((turn.first[0] as { why: string }).why).toContain("did not settle within 50ms")
    answer(Response.json({ usage: { prompt_tokens: 5, completion_tokens: 5 } }))
    await pending
    expect(turn.first).toHaveLength(1)
  })

  test("an admission that throws frees the session and refuses only that request", async () => {
    const upstream = fakeUpstream(["ok", "ok"])
    const meter = relayTo(upstream)
    let calls = 0
    const turn: AdmittedTurn = {
      admitStep: async () => {
        calls += 1
        if (calls === 1) throw new Error("the ledger exploded")
        return { ok: true, step: 2, settle: async () => {} }
      },
      settleFirst: async () => {},
    }
    const session = meter.open("ses_throw", turn)
    await (await hostRequest(meter, "ses_throw")).text()
    const refused = await hostRequest(meter, "ses_throw")
    expect(refused.status).toBe(400)
    expect(await refused.text()).toContain("the ledger exploded")
    expect((await hostRequest(meter, "ses_throw")).status).toBe(200)
    await session.close()
  })

  test("sessions open at the same time settle each request against its own attempt", async () => {
    const upstream = fakeUpstream(["ok", "ok", "ok"])
    const meter = relayTo(upstream)
    const a = fakeTurn()
    const b = fakeTurn()
    const sa = meter.open("ses_a1", a.turn)
    const sb = meter.open("ses_b1", b.turn)
    await Promise.all([hostRequest(meter, "ses_a1").then((r) => r.text()), hostRequest(meter, "ses_b1").then((r) => r.text())])
    await (await hostRequest(meter, "ses_b1")).text()
    const [ma, mb] = await Promise.all([sa.close(), sb.close()])
    expect(ma.physicalRequests).toBe(1)
    expect(mb.physicalRequests).toBe(2)
    expect(a.first).toHaveLength(1)
    expect(b.first).toHaveLength(1)
    expect(b.stepSettlements).toHaveLength(1)
  })

  test("stop closes each session once, however often it was closed", async () => {
    const upstream = fakeUpstream([])
    const meter = startRequestMeter({ upstream: upstream.url, credential: CREDENTIAL })
    cleanups.push(() => upstream.stop())
    const turn = fakeTurn()
    const session = meter.open("ses_once", turn.turn)
    await session.close()
    await meter.stop()
    expect(turn.first).toHaveLength(1)
  })
})
