/**
 * Story 2-8c — the scripted stub and the refusing proxy, driven over real
 * loopback sockets. Neither reaches anything beyond 127.0.0.1.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { connect } from "node:net"

import { EMPTY_FINDINGS, startAccountingStub, startRefusingProxy, usageFor, type AccountingStub, type RefusingProxy } from "./accounting-stub.ts"

const running: (AccountingStub | RefusingProxy)[] = []
afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop()
})

function stub(): AccountingStub {
  const started = startAccountingStub()
  running.push(started)
  return started
}

const completion = (base: string, body: Record<string, unknown>, signal?: AbortSignal) =>
  fetch(`${base}/chat/completions`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, ...(signal ? { signal } : {}) })

const OFFERED = { model: "m1", stream: true, tools: [{ type: "function", function: { name: "StructuredOutput" } }, { type: "function", function: { name: "glob" } }], tool_choice: "required" }

/** The `data:` chunks of an SSE body, `[DONE]` excluded. */
function chunks(text: string): Record<string, unknown>[] {
  return text
    .split("\n\n")
    .map((part) => part.replace(/^data: /, "").trim())
    .filter((part) => part.length > 0 && part !== "[DONE]")
    .map((part) => JSON.parse(part) as Record<string, unknown>)
}

describe("the stub", () => {
  test("binds to 127.0.0.1 and serves /v1", () => {
    const server = stub()
    expect(server.hostname).toBe("127.0.0.1")
    expect(server.baseURL).toBe(`http://127.0.0.1:${server.port}/v1`)
  })

  test("a success streams a StructuredOutput tool call with the payload, then the usage, and is recorded", async () => {
    const server = stub()
    server.reset({ queue: [], otherwise: "ok" })
    const response = await completion(server.baseURL, OFFERED)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const text = await response.text()
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true)
    const parsed = chunks(text)
    const call = (parsed[1]!.choices as { delta: { tool_calls: { function: { name: string; arguments: string } }[] } }[])[0]!.delta.tool_calls[0]!
    expect(call.function.name).toBe("StructuredOutput")
    expect(JSON.parse(call.function.arguments)).toEqual(EMPTY_FINDINGS)
    expect(parsed.at(-1)!.usage).toEqual(usageFor(1))
    const [entry] = server.requests()
    expect(entry).toMatchObject({ index: 1, model: true, behaviour: "ok", requestedModel: "m1", stream: true, toolsOffered: ["StructuredOutput", "glob"], servedUsage: usageFor(1) })
    expect(server.modelRequests()).toBe(1)
  })

  test("the queue is consumed one behaviour per request, then the default applies", async () => {
    const server = stub()
    server.reset({ queue: ["429", "tool:glob"], otherwise: "500" })
    expect((await completion(server.baseURL, OFFERED)).status).toBe(429)
    const tool = chunks(await (await completion(server.baseURL, OFFERED)).text())
    const call = (tool[1]!.choices as { delta: { tool_calls: { function: { name: string; arguments: string } }[] } }[])[0]!.delta.tool_calls[0]!
    expect(call.function.name).toBe("glob")
    expect(JSON.parse(call.function.arguments)).toEqual({ pattern: "*" })
    expect((await completion(server.baseURL, OFFERED)).status).toBe(500)
    expect((await completion(server.baseURL, OFFERED)).status).toBe(500)
    const requests = server.requests()
    expect(requests.map((entry) => entry.behaviour)).toEqual(["429", "tool:glob", "500", "500"])
    // Only answered successes serve usage, each its own figure.
    expect(requests.map((entry) => entry.servedUsage)).toEqual([undefined, usageFor(2), undefined, undefined])
  })

  test("400 answers with a status and no usage", async () => {
    const server = stub()
    server.reset({ queue: ["400"], otherwise: "ok" })
    const response = await completion(server.baseURL, OFFERED)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error" } })
    expect(server.requests()[0]!.servedUsage).toBeUndefined()
  })

  test("a hang never answers, and records when the client closed the connection, and that it was the client", async () => {
    const server = stub()
    server.reset({ queue: [], otherwise: "hang" })
    const controller = new AbortController()
    const pending = completion(server.baseURL, OFFERED, controller.signal).catch((error: unknown) => error)
    await Bun.sleep(50)
    controller.abort()
    expect(await pending).toBeInstanceOf(Error)
    await Bun.sleep(50)
    const [entry] = server.requests()
    expect(entry!.behaviour).toBe("hang")
    expect(entry!.closed!.by).toBe("client")
    expect(entry!.closed!.afterMs).toBeGreaterThanOrEqual(0)
  })

  test("a hung connection that closes after hostStopping() is recorded as closed by the host stopping", async () => {
    const server = stub()
    server.reset({ queue: [], otherwise: "hang" })
    const controller = new AbortController()
    const pending = completion(server.baseURL, OFFERED, controller.signal).catch((error: unknown) => error)
    await Bun.sleep(50)
    server.hostStopping()
    controller.abort()
    await pending
    await Bun.sleep(50)
    expect(server.requests()[0]!.closed!.by).toBe("host-stopping")
  })

  test("a request whose signal is already aborted is recorded as closed at once", async () => {
    const server = stub()
    server.reset({ queue: [], otherwise: "hang" })
    const request = new Request(`${server.baseURL}/chat/completions`, { method: "POST", body: JSON.stringify(OFFERED), signal: AbortSignal.abort() })
    const response = await server.handle(request)
    expect(response.status).toBe(499)
    const [entry] = server.requests()
    expect(entry!.behaviour).toBe("hang")
    expect(entry!.closed).toBeDefined()
  })

  test("a request from before reset() is neither recorded into the new generation nor consumes its script", async () => {
    const server = stub()
    server.reset({ queue: [], otherwise: "ok" })
    let push: (() => void) | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = () => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(OFFERED)))
          controller.close()
        }
      },
    })
    const stale = server.handle(new Request(`${server.baseURL}/chat/completions`, { method: "POST", body, duplex: "half" } as RequestInit))
    server.reset({ queue: ["500"], otherwise: "ok" })
    push!()
    expect((await stale).status).toBe(503)
    expect(server.requests()).toEqual([])
    expect((await completion(server.baseURL, OFFERED)).status).toBe(500)
  })

  test("a body that is null, an array or a scalar, and null tool entries, are recorded and consume one step each", async () => {
    const server = stub()
    server.reset({ queue: ["500", "500", "500", "500"], otherwise: "ok" })
    for (const body of ["null", "[]", "5"]) {
      const response = await fetch(`${server.baseURL}/chat/completions`, { method: "POST", body })
      expect(response.status).toBe(500)
    }
    expect((await completion(server.baseURL, { tools: [null, { function: null }, { name: "x" }] })).status).toBe(500)
    const requests = server.requests()
    expect(requests.map((entry) => entry.behaviour)).toEqual(["500", "500", "500", "500"])
    expect(requests.at(-1)!.toolsOffered).toEqual(["", "", "x"])
  })

  test("usage is numbered by model requests only", async () => {
    const server = stub()
    server.reset({ queue: [], otherwise: "ok" })
    await fetch(`${server.baseURL}/models`)
    await (await completion(server.baseURL, OFFERED)).text()
    const model = server.requests()[1]!
    expect(model.index).toBe(2)
    expect(model.modelIndex).toBe(1)
    expect(model.servedUsage).toEqual(usageFor(1))
  })

  test("a non-model request is recorded but not counted as a physical model request", async () => {
    const server = stub()
    server.reset({ queue: [], otherwise: "ok" })
    expect((await fetch(`${server.baseURL}/models`)).status).toBe(404)
    expect(server.requests()[0]).toMatchObject({ model: false, behaviour: "not-a-model-request" })
    expect(server.modelRequests()).toBe(0)
  })

  test("reset forgets every request and restarts the numbering", async () => {
    const server = stub()
    server.reset({ queue: [], otherwise: "500" })
    await completion(server.baseURL, OFFERED)
    server.reset({ queue: [], otherwise: "ok" })
    expect(server.requests()).toEqual([])
    await (await completion(server.baseURL, OFFERED)).text()
    expect(server.requests()[0]!.index).toBe(1)
  })
})

describe("the refusing proxy", () => {
  test("binds to 127.0.0.1, answers 403 to a CONNECT and records its first line", async () => {
    const proxy = startRefusingProxy()
    running.push(proxy)
    expect(proxy.hostname).toBe("127.0.0.1")
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(proxy.port, "127.0.0.1", () => socket.write("CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n"))
      let text = ""
      socket.on("data", (chunk) => (text += chunk.toString()))
      socket.on("end", () => resolve(text))
      socket.on("error", reject)
    })
    expect(reply.startsWith("HTTP/1.1 403 Forbidden")).toBe(true)
    expect(proxy.attempts().map((attempt) => attempt.line)).toEqual(["CONNECT registry.npmjs.org:443 HTTP/1.1"])
  })

  test("a request line split across chunks is recorded whole", async () => {
    const proxy = startRefusingProxy()
    running.push(proxy)
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(proxy.port, "127.0.0.1", () => {
        socket.write("CONNECT registry.np")
        setTimeout(() => socket.write("mjs.org:443 HTTP/1.1\r\nHost: x\r\n\r\n"), 50)
      })
      let text = ""
      socket.on("data", (chunk) => (text += chunk.toString()))
      socket.on("end", () => resolve(text))
      socket.on("error", reject)
    })
    expect(reply.startsWith("HTTP/1.1 403 Forbidden")).toBe(true)
    expect(proxy.attempts().map((attempt) => attempt.line)).toEqual(["CONNECT registry.npmjs.org:443 HTTP/1.1"])
  })
})
