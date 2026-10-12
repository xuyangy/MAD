import { afterEach, describe, expect, test } from "bun:test"

import { parseRequest, stageOf, startAdversarialStub, STAGE_ANSWERS, type AdversarialStub, type AdversarialStubRequest } from "./adversarial-stub.ts"
import { aggregateEnvelopeSchema, evidenceEnvelopeSchema, factCheckEnvelopeSchema, logicEvalEnvelopeSchema } from "../core/stages/judge.ts"
import { debateEnvelopeSchema } from "../core/stages/debate.ts"

const stubs: AdversarialStub[] = []
afterEach(async () => {
  for (const stub of stubs.splice(0)) await stub.stop()
})

function started(format: "messages" | "chat-completions"): AdversarialStub {
  const stub = startAdversarialStub(format === "messages" ? "anthropic" : "github-copilot", format)
  stubs.push(stub)
  return stub
}

const SECRET_PROMPT = "PROMPT-TEXT-THAT-MUST-NOT-BE-KEPT"
const SECRET_HEADER = "Bearer header-value-that-must-not-be-kept"

function messagesBody(properties: string[], extra: Record<string, unknown> = {}): unknown {
  return {
    system: SECRET_PROMPT,
    tools: [{ name: "mcp_StructuredOutput", input_schema: { type: "object", properties: Object.fromEntries(properties.map((name) => [name, {}])) } }],
    messages: [{ role: "user", content: [{ type: "text", text: SECRET_PROMPT }] }],
    ...extra,
  }
}

function chatBody(properties: string[], extra: Record<string, unknown> = {}): unknown {
  return {
    tools: [{ type: "function", function: { name: "StructuredOutput", parameters: { type: "object", properties: Object.fromEntries(properties.map((name) => [name, {}])) } } }],
    messages: [{ role: "user", content: SECRET_PROMPT }],
    ...extra,
  }
}

const post = (stub: AdversarialStub, body: unknown, signal?: AbortSignal) =>
  stub.handle(
    new Request(`${stub.baseURL}${stub.format === "messages" ? "/messages" : "/chat/completions"}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: SECRET_HEADER },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    }),
  )

/** The tool a streamed answer calls and the JSON it passes, read back out of the stream. */
function answerOf(format: "messages" | "chat-completions", text: string): { tool: string | undefined; input: unknown } {
  const events = text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Record<string, any>)
  if (format === "messages") {
    const start = events.find((event) => event.type === "content_block_start")
    const delta = events.find((event) => event.type === "content_block_delta")
    return { tool: start?.content_block?.name, input: delta?.delta?.partial_json === undefined ? undefined : JSON.parse(delta.delta.partial_json) }
  }
  const call = events.map((event) => event.choices?.[0]?.delta?.tool_calls?.[0]).find((entry) => entry !== undefined)
  return { tool: call?.function?.name, input: call === undefined ? undefined : JSON.parse(call.function.arguments) }
}

describe("stageOf", () => {
  test("each stage's answer schema is told apart by its property names", () => {
    expect(stageOf(["findings"])).toBe("discover")
    expect(stageOf(["turns"])).toBe("debate")
    expect(stageOf(["evidence", "pointers"])).toBe("evidence-extract")
    expect(stageOf(["checks", "findings", "unchecked", "verdict", "evidenceKind"])).toBe("fact-check")
    expect(stageOf(["assessment"])).toBe("logic-eval")
    expect(stageOf(["verdict", "reasoning", "evidenceKind"])).toBe("aggregate")
    expect(stageOf(["something"])).toBe("unknown")
  })

  test("each scripted stage answer parses under the stage's own schema", () => {
    expect(debateEnvelopeSchema.safeParse(STAGE_ANSWERS.debate).success).toBe(true)
    expect(evidenceEnvelopeSchema.safeParse(STAGE_ANSWERS["evidence-extract"]).success).toBe(true)
    expect(factCheckEnvelopeSchema.safeParse(STAGE_ANSWERS["fact-check"]).success).toBe(true)
    expect(logicEvalEnvelopeSchema.safeParse(STAGE_ANSWERS["logic-eval"]).success).toBe(true)
    expect(aggregateEnvelopeSchema.safeParse(STAGE_ANSWERS.aggregate).success).toBe(true)
  })
})

describe("parseRequest", () => {
  test("Messages: tool names, the answer schema's property names and the last tool result", () => {
    const parsed = parseRequest(
      "messages",
      messagesBody(["findings"], {
        messages: [
          { role: "user", content: [{ type: "text", text: "x" }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "Model tried to call unavailable tool 'invalid'.", is_error: true }] },
        ],
      }),
    )
    expect(parsed.offered).toEqual(["mcp_StructuredOutput"])
    expect(parsed.answerProperties).toEqual(["findings"])
    expect(parsed.toolResult?.isError).toBe(true)
    expect(parsed.toolResult?.text).toContain("unavailable tool")
  })

  test("chat-completions: the function's name and parameters, and a `tool` message", () => {
    const parsed = parseRequest("chat-completions", chatBody(["assessment"], { messages: [{ role: "tool", tool_call_id: "c", content: "file text" }] }))
    expect(parsed.offered).toEqual(["StructuredOutput"])
    expect(parsed.answerProperties).toEqual(["assessment"])
    expect(parsed.toolResult).toEqual({ isError: false, text: JSON.stringify("file text") })
  })

  test("a request with no answer tool, and a body that is not an object", () => {
    expect(parseRequest("messages", { tools: [{ name: "mcp_Read", input_schema: {} }] })).toEqual({ offered: ["mcp_Read"], answerProperties: null, toolResult: null })
    expect(parseRequest("messages", "nonsense")).toEqual({ offered: [], answerProperties: null, toolResult: null })
  })
})

describe("the stub", () => {
  for (const format of ["messages", "chat-completions"] as const) {
    const body = format === "messages" ? messagesBody : chatBody

    test(`${format}: a discovery request gets the script's answer for the run, and a judge request its stage answer`, async () => {
      const stub = started(format)
      stub.reset({ discovery: (run) => ({ findings: [{ claim: `for ${run?.caseId}` }] }) })
      stub.setRun({ position: 3, caseId: "case-c", side: "attack" })
      const discovery = answerOf(format, await (await post(stub, body(["findings"]))).text())
      expect(discovery).toEqual({ tool: "StructuredOutput", input: { findings: [{ claim: "for case-c" }] } })
      const judge = answerOf(format, await (await post(stub, body(["verdict", "reasoning", "evidenceKind"]))).text())
      expect(judge.input).toEqual(STAGE_ANSWERS.aggregate)
      const [first, second] = stub.requests()
      expect(first).toMatchObject({ index: 1, stage: "discover", served: "answer", model: true, authHeaderPresent: true, run: { position: 3, caseId: "case-c", side: "attack" }, toolResult: null })
      expect(second).toMatchObject({ index: 2, stage: "aggregate", served: "answer" })
    })

    test(`${format}: a record holds names and booleans, never a prompt, a body or a header value`, async () => {
      const stub = started(format)
      stub.setCanary("CANARY-TOKEN-1")
      const withResult =
        format === "messages"
          ? body(["findings"], { messages: [{ role: "user", content: [{ type: "tool_result", content: `${SECRET_PROMPT} CANARY-TOKEN-1`, is_error: false }] }] })
          : body(["findings"], { messages: [{ role: "tool", content: `${SECRET_PROMPT} CANARY-TOKEN-1` }] })
      await post(stub, withResult)
      const text = JSON.stringify(stub.requests())
      expect(text).not.toContain(SECRET_PROMPT)
      expect(text).not.toContain("header-value")
      expect(text).not.toContain("CANARY-TOKEN-1")
      expect(stub.requests()[0]!.toolResult).toEqual({ isError: false, namesUnavailableTool: false, canary: true })
    })

    test(`${format}: the script's steps — an unoffered tool call, then the answer once the result comes back`, async () => {
      const stub = started(format)
      stub.reset({
        serve: (turn) => (turn.runIndex === 1 && !turn.hasToolResult ? "unoffered-tool" : "answer"),
        unofferedCall: { tool: "mcp_Read", input: { filePath: "/x/canary.txt" } },
      })
      const first = answerOf(format, await (await post(stub, body(["findings"]))).text())
      expect(first).toEqual({ tool: "mcp_Read", input: { filePath: "/x/canary.txt" } })
      const rejected = "Model tried to call unavailable tool 'invalid'. Available tools: StructuredOutput."
      const continuation =
        format === "messages"
          ? body(["findings"], { messages: [{ role: "user", content: [{ type: "tool_result", content: rejected, is_error: true }] }] })
          : body(["findings"], { messages: [{ role: "tool", content: rejected }] })
      const second = answerOf(format, await (await post(stub, continuation)).text())
      expect(second.tool).toBe("StructuredOutput")
      expect(stub.requests().map((request) => request.served)).toEqual(["unoffered-tool", "answer"])
      expect(stub.requests()[1]!.toolResult).toEqual({ isError: format === "messages", namesUnavailableTool: true, canary: false })
    })

    test(`${format}: HTTP 400 and 500, and an answer with no usage figures`, async () => {
      const stub = started(format)
      const steps = ["http-400", "http-500", "no-usage", "answer"] as const
      stub.reset({ serve: (turn) => steps[turn.index - 1]! })
      expect((await post(stub, body(["findings"]))).status).toBe(400)
      expect((await post(stub, body(["findings"]))).status).toBe(500)
      const bare = await (await post(stub, body(["findings"]))).text()
      expect(bare).not.toContain("usage")
      expect(answerOf(format, bare).tool).toBe("StructuredOutput")
      expect(await (await post(stub, body(["findings"]))).text()).toContain("usage")
      expect(stub.requests().map((request) => request.served)).toEqual([...steps])
    })

    test(`${format}: a hang is released when the request is aborted, and its close is recorded`, async () => {
      const stub = started(format)
      stub.reset({ serve: () => "hang" })
      const controller = new AbortController()
      const pending = post(stub, body(["findings"]), controller.signal)
      await Bun.sleep(20)
      expect(stub.requests()[0]!.closed).toBeUndefined()
      controller.abort()
      expect((await pending).status).toBe(499)
      expect(stub.requests()[0]!.closed?.afterMs).toBeGreaterThanOrEqual(0)
    })

    test(`${format}: a request that offers no answer tool is a side request and gets plain text`, async () => {
      const stub = started(format)
      const side = format === "messages" ? { tools: [], messages: [] } : { messages: [] }
      const text = await (await post(stub, side)).text()
      expect(text).toContain("Title")
      expect(stub.requests()[0]).toMatchObject({ stage: "side", served: "side-text", offered: [] })
    })
  }

  test("the hook sees each model request before it is answered, and its failure changes nothing", async () => {
    const stub = started("messages")
    const seen: AdversarialStubRequest[] = []
    stub.onRequest((request) => {
      seen.push(request)
      throw new Error("an observer's failure")
    })
    const response = await post(stub, messagesBody(["findings"]))
    expect(response.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ index: 1, stage: "discover", served: "answer" })
  })

  test("the per-run count follows the run the caller named, and reset starts both counts again", async () => {
    const stub = started("messages")
    const turns: { index: number; runIndex: number; position: number | undefined }[] = []
    const script = {
      serve: (turn: { index: number; runIndex: number; run: { position: number } | null }) => {
        turns.push({ index: turn.index, runIndex: turn.runIndex, position: turn.run?.position })
        return "answer" as const
      },
    }
    stub.reset(script)
    stub.setRun({ position: 1, caseId: "a", side: "clean" })
    await post(stub, messagesBody(["findings"]))
    await post(stub, messagesBody(["assessment"]))
    stub.setRun({ position: 2, caseId: "a", side: "attack" })
    await post(stub, messagesBody(["findings"]))
    expect(turns).toEqual([
      { index: 1, runIndex: 1, position: 1 },
      { index: 2, runIndex: 2, position: 1 },
      { index: 3, runIndex: 1, position: 2 },
    ])
    stub.reset(script)
    expect(stub.requests()).toEqual([])
    await post(stub, messagesBody(["findings"]))
    expect(turns.at(-1)).toEqual({ index: 1, runIndex: 1, position: undefined })
  })

  test("a request that is not a model request is recorded and answered 404", async () => {
    const stub = started("messages")
    const response = await stub.handle(new Request(`${stub.baseURL}/models`))
    expect(response.status).toBe(404)
    expect(stub.requests()[0]).toMatchObject({ model: false, served: "not-a-model-request", path: "/v1/models", authHeaderPresent: false })
  })
})
