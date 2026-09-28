/**
 * Story 2-8c — the scripted stub and the refusing proxy, driven over real
 * loopback sockets. Neither reaches anything beyond 127.0.0.1.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { connect } from "node:net"

import {
  EMPTY_FINDINGS,
  startAccountingStub,
  startAllowlistProxy,
  startRefusingProxy,
  usageFor,
  type AccountingStub,
  type AllowlistProxy,
  type RefusingProxy,
} from "./accounting-stub.ts"

const running: (AccountingStub | RefusingProxy | AllowlistProxy | { stop(): unknown })[] = []
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

/**
 * Story 2-8c5 — the allowlisting proxy. Every allowed target in these tests is a
 * loopback echo server: no test tunnels to an external host. The names the pilot
 * allows (`chatgpt.com:443`, `auth.openai.com:443`) appear only in refusal cases
 * whose target is NOT on the list, and in the pilot's own constant.
 */
describe("the allowlisting proxy", () => {
  /** A loopback echo server that counts its connections. */
  function echo(): { port: number; connections: () => number; stop(): void } {
    let count = 0
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open() {
          count += 1
        },
        data(socket, chunk) {
          socket.write(chunk)
        },
      },
    })
    const handle = { port: server.port, connections: () => count, stop: () => server.stop(true) }
    running.push(handle)
    return handle
  }

  /** Sends `head`, then (once a 200 arrives) `payload`; resolves with everything read until the proxy or the echo closes. */
  function talk(port: number, head: string, payload?: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => socket.write(head))
      let text = ""
      let sent = false
      socket.on("data", (chunk) => {
        text += chunk.toString("latin1")
        if (!sent && payload !== undefined && text.includes("\r\n\r\n") && text.startsWith("HTTP/1.1 200")) {
          sent = true
          socket.write(payload)
        }
        if (payload !== undefined && text.endsWith(payload)) socket.end()
      })
      socket.on("end", () => resolve(text))
      socket.on("close", () => resolve(text))
      socket.on("error", reject)
    })
  }

  test("tunnels a CONNECT to an allowed target both ways and logs it with its time and outcome", async () => {
    const target = echo()
    const proxy = startAllowlistProxy([`127.0.0.1:${target.port}`])
    running.push(proxy)
    expect(proxy.hostname).toBe("127.0.0.1")
    const before = Date.now()
    const reply = await talk(proxy.port, `CONNECT 127.0.0.1:${target.port} HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n\r\n`, "hello through the tunnel")
    expect(reply.startsWith("HTTP/1.1 200 Connection Established\r\n\r\n")).toBe(true)
    expect(reply.endsWith("hello through the tunnel")).toBe(true)
    expect(target.connections()).toBe(1)
    const [entry] = proxy.connects()
    expect(entry).toMatchObject({ line: `CONNECT 127.0.0.1:${target.port} HTTP/1.1`, target: `127.0.0.1:${target.port}`, outcome: "tunnelled" })
    expect(entry!.at).toBeGreaterThanOrEqual(before)
  })

  test("bytes sent with the CONNECT head reach the target first", async () => {
    const target = echo()
    const proxy = startAllowlistProxy([`127.0.0.1:${target.port}`])
    running.push(proxy)
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(proxy.port, "127.0.0.1", () => socket.write(`CONNECT 127.0.0.1:${target.port} HTTP/1.1\r\n\r\nearly`))
      let text = ""
      socket.on("data", (chunk) => {
        text += chunk.toString("latin1")
        if (text.endsWith("early")) socket.end()
      })
      socket.on("close", () => resolve(text))
      socket.on("error", reject)
    })
    expect(reply).toBe("HTTP/1.1 200 Connection Established\r\n\r\nearly")
  })

  test("refuses and logs a CONNECT to any other target, matched exactly: no suffix, prefix, port or case trick", async () => {
    const target = echo()
    const proxy = startAllowlistProxy([`127.0.0.1:${target.port}`, "chatgpt.com:443"])
    running.push(proxy)
    const refused = ["evil-chatgpt.com:443", "chatgpt.com.evil.example:443", "chatgpt.com:8443", "api.githubcopilot.com:443", `localhost:${target.port}`, `127.0.0.1:${target.port + 1}`]
    for (const other of refused) {
      const reply = await talk(proxy.port, `CONNECT ${other} HTTP/1.1\r\nHost: ${other}\r\n\r\n`)
      expect(reply.startsWith("HTTP/1.1 403 Forbidden"), other).toBe(true)
    }
    expect(target.connections()).toBe(0)
    expect(proxy.connects().map((entry) => [entry.target, entry.outcome])).toEqual(refused.map((other) => [other.toLowerCase(), "refused"]))
    const listed = startAllowlistProxy(["ChatGPT.com:443"])
    running.push(listed)
    expect(listed.allowed).toEqual(["chatgpt.com:443"])
  })

  test("`CONNECT ChatGPT.COM:443` matches an allowed `chatgpt.com:443` case-insensitively (resolved to a loopback stand-in)", async () => {
    const target = echo()
    const proxy = startAllowlistProxy(["chatgpt.com:443"], { resolve: () => ({ hostname: "127.0.0.1", port: target.port }) })
    running.push(proxy)
    const reply = await talk(proxy.port, "CONNECT ChatGPT.COM:443 HTTP/1.1\r\n\r\n", "case")
    expect(reply.startsWith("HTTP/1.1 200")).toBe(true)
    expect(reply.endsWith("case")).toBe(true)
    expect(proxy.connects()).toMatchObject([{ line: "CONNECT ChatGPT.COM:443 HTTP/1.1", target: "chatgpt.com:443", outcome: "tunnelled" }])
  })

  test("several MB each way cross the tunnel byte-identical, however the writes split", async () => {
    const size = 6 * 1024 * 1024
    const up = new Uint8Array(size).map((_, index) => (index * 7 + 3) & 0xff)
    const down = new Uint8Array(size).map((_, index) => (index * 13 + 5) & 0xff)
    const received: Uint8Array[] = []
    let receivedBytes = 0
    let upstreamDone: () => void = () => undefined
    const upstreamFinished = new Promise<void>((resolve) => (upstreamDone = resolve))
    // A loopback upstream that sends `down` with its own backpressure handling and keeps everything it is sent.
    const pump = (socket: { data: { offset: number }; write(data: Uint8Array): number }) => {
      while (socket.data.offset < down.length) {
        const written = socket.write(down.subarray(socket.data.offset, Math.min(down.length, socket.data.offset + 256 * 1024)))
        if (written <= 0) return
        socket.data.offset += written
      }
    }
    const server = Bun.listen<{ offset: number }>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          socket.data = { offset: 0 }
          pump(socket)
        },
        drain: pump,
        data(_socket, chunk) {
          received.push(new Uint8Array(chunk))
          receivedBytes += chunk.byteLength
          if (receivedBytes >= size) upstreamDone()
        },
      },
    })
    running.push({ stop: () => server.stop(true) })
    const proxy = startAllowlistProxy(["bulk.invalid:443"], { resolve: () => ({ hostname: "127.0.0.1", port: server.port }) })
    running.push(proxy)
    const fromTunnel = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      let head = true
      let total = 0
      const socket = connect(proxy.port, "127.0.0.1", () => socket.write("CONNECT bulk.invalid:443 HTTP/1.1\r\n\r\n"))
      socket.on("data", (chunk: Buffer) => {
        if (head) {
          const text = chunk.toString("latin1")
          const end = text.indexOf("\r\n\r\n")
          expect(text.startsWith("HTTP/1.1 200")).toBe(true)
          head = false
          chunk = chunk.subarray(end + 4)
          socket.write(up)
        }
        chunks.push(chunk)
        total += chunk.length
        if (total >= size) {
          socket.end()
          resolve(Buffer.concat(chunks))
        }
      })
      socket.on("error", reject)
    })
    await upstreamFinished
    expect(fromTunnel.length).toBe(size)
    expect(Buffer.compare(fromTunnel, Buffer.from(down))).toBe(0)
    expect(Buffer.compare(Buffer.concat(received), Buffer.from(up))).toBe(0)
  }, 30_000)

  test("a slow client and an upstream that sends more than the queue cap, then closes: reading pauses, and every byte reaches the client before its side ends", async () => {
    const size = 24 * 1024 * 1024
    const down = new Uint8Array(size).map((_, index) => (index * 11 + 1) & 0xff)
    const pump = (socket: { data: { offset: number }; write(data: Uint8Array): number; end(): void }) => {
      while (socket.data.offset < down.length) {
        const written = socket.write(down.subarray(socket.data.offset, Math.min(down.length, socket.data.offset + 256 * 1024)))
        if (written <= 0) return
        socket.data.offset += written
      }
      socket.end()
    }
    const server = Bun.listen<{ offset: number }>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          socket.data = { offset: 0 }
        },
        data(socket) {
          pump(socket)
        },
        drain: pump,
      },
    })
    running.push({ stop: () => server.stop(true) })
    const proxy = startAllowlistProxy(["closing.invalid:443"], { resolve: () => ({ hostname: "127.0.0.1", port: server.port }) })
    running.push(proxy)
    const body = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      const socket = connect(proxy.port, "127.0.0.1", () => socket.write("CONNECT closing.invalid:443 HTTP/1.1\r\n\r\n"))
      let head = true
      socket.on("data", (chunk: Buffer) => {
        if (head) {
          head = false
          chunk = chunk.subarray(chunk.toString("latin1").indexOf("\r\n\r\n") + 4)
          socket.write("go")
          // Read slowly at first, so bytes queue in the proxy while the upstream closes.
          socket.pause()
          setTimeout(() => socket.resume(), 300)
        }
        chunks.push(chunk)
      })
      socket.on("close", () => resolve(Buffer.concat(chunks)))
      socket.on("error", reject)
    })
    expect(body.length).toBe(size)
    expect(Buffer.compare(body, Buffer.from(down))).toBe(0)
  }, 30_000)

  test("an upstream that aborts mid-tunnel ends the client's side; the log keeps the tunnel", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          socket.write("partial")
          socket.terminate()
        },
      },
    })
    running.push({ stop: () => server.stop(true) })
    const proxy = startAllowlistProxy(["abort.invalid:443"], { resolve: () => ({ hostname: "127.0.0.1", port: server.port }) })
    running.push(proxy)
    const reply = await new Promise<string>((resolve, reject) => {
      let text = ""
      const socket = connect(proxy.port, "127.0.0.1", () => socket.write("CONNECT abort.invalid:443 HTTP/1.1\r\n\r\n"))
      socket.on("data", (chunk) => {
        text += chunk.toString("latin1")
        if (text === "HTTP/1.1 200 Connection Established\r\n\r\n") socket.write("go")
      })
      socket.on("close", () => resolve(text))
      socket.on("error", reject)
    })
    expect(reply.startsWith("HTTP/1.1 200 Connection Established\r\n\r\n")).toBe(true)
    expect(proxy.connects().map((entry) => entry.outcome)).toEqual(["tunnelled"])
  })

  test("an allowed CONNECT whose head never completes is logged with its parsed target", async () => {
    const target = echo()
    const proxy = startAllowlistProxy([`127.0.0.1:${target.port}`])
    running.push(proxy)
    await new Promise<void>((resolve) => {
      const socket = connect(proxy.port, "127.0.0.1", () => socket.end(`CONNECT 127.0.0.1:${target.port} HTTP/1.1\r\nHost: x\r\n`))
      socket.on("close", () => resolve())
    })
    await Bun.sleep(20)
    expect(target.connections()).toBe(0)
    expect(proxy.connects().map((entry) => [entry.target, entry.outcome])).toEqual([[`127.0.0.1:${target.port}`, "refused"]])
  })

  test("refuses a plain request line, a malformed CONNECT and a line cut off by a hang-up", async () => {
    const target = echo()
    const proxy = startAllowlistProxy([`127.0.0.1:${target.port}`])
    running.push(proxy)
    expect((await talk(proxy.port, `GET http://127.0.0.1:${target.port}/ HTTP/1.1\r\n\r\n`)).startsWith("HTTP/1.1 403")).toBe(true)
    expect((await talk(proxy.port, `CONNECT 127.0.0.1:${target.port}\r\n\r\n`)).startsWith("HTTP/1.1 403")).toBe(true)
    await new Promise<void>((resolve) => {
      const socket = connect(proxy.port, "127.0.0.1", () => socket.end("CONNECT 127.0.0.1"))
      socket.on("close", () => resolve())
    })
    await Bun.sleep(20)
    expect(target.connections()).toBe(0)
    expect(proxy.connects().map((entry) => [entry.target, entry.outcome])).toEqual([
      [null, "refused"],
      [null, "refused"],
      [null, "refused"],
    ])
  })

  test("with no target named it refuses every connection: the refuse-all mode", async () => {
    const target = echo()
    const proxy = startAllowlistProxy([])
    running.push(proxy)
    expect(proxy.allowed).toEqual([])
    const reply = await talk(proxy.port, `CONNECT 127.0.0.1:${target.port} HTTP/1.1\r\n\r\n`, "x")
    expect(reply.startsWith("HTTP/1.1 403 Forbidden")).toBe(true)
    expect(target.connections()).toBe(0)
    expect(proxy.connects()).toHaveLength(1)
    expect(proxy.connects()[0]!.outcome).toBe("refused")
  })

  test("a test's resolver sends an allowed synthetic name to a loopback stand-in; the log names the requested target", async () => {
    const target = echo()
    const resolved: string[] = []
    const proxy = startAllowlistProxy(["stand-in.invalid:443"], {
      resolve: (host, port) => {
        resolved.push(`${host}:${port}`)
        return { hostname: "127.0.0.1", port: target.port }
      },
    })
    running.push(proxy)
    const reply = await talk(proxy.port, "CONNECT stand-in.invalid:443 HTTP/1.1\r\n\r\n", "via the resolver")
    expect(reply.endsWith("via the resolver")).toBe(true)
    expect((await talk(proxy.port, "CONNECT other.invalid:443 HTTP/1.1\r\n\r\n")).startsWith("HTTP/1.1 403")).toBe(true)
    expect(resolved).toEqual(["stand-in.invalid:443"])
    expect(proxy.connects().map((entry) => [entry.target, entry.outcome])).toEqual([
      ["stand-in.invalid:443", "tunnelled"],
      ["other.invalid:443", "refused"],
    ])
  })

  test("an allowed target that refuses the connection is answered 502 and logged upstream-failed", async () => {
    const closed = echo()
    const port = closed.port
    closed.stop()
    const proxy = startAllowlistProxy([`127.0.0.1:${port}`])
    running.push(proxy)
    const reply = await talk(proxy.port, `CONNECT 127.0.0.1:${port} HTTP/1.1\r\n\r\n`)
    expect(reply.startsWith("HTTP/1.1 502 Bad Gateway")).toBe(true)
    expect(proxy.connects().map((entry) => entry.outcome)).toEqual(["upstream-failed"])
  })
})
