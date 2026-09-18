/**
 * Story 2-7b — the durable trace sink: run-bound lines, synced in call order;
 * write failures reach `takeFailures` and are never thrown; a torn row is read
 * back as torn, counted and attributed.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ToolRequestEvent } from "../core/ports/tool-observation.ts"
import { createToolTraceSink, readToolTrace, type TraceIo } from "./tool-trace.ts"

const scratch: string[] = []
afterEach(async () => {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})

async function traceFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-trace-"))
  scratch.push(dir)
  return join(dir, "tool-trace.jsonl")
}

const binding = { caseId: "adv-01", side: "attack" as const, position: 2 }
const args = { path: "src/db/client.ts", startLine: 1, endLine: 3 }
const request = (observationId: string): ToolRequestEvent => ({
  context: { runId: "run-1", findingId: "finding-2", observationId, tool: "blame" },
  request: { kind: "made", args },
  at: "t",
})

describe("createToolTraceSink", () => {
  test("appends one run-bound line per write, slot first, in call order", async () => {
    const file = await traceFile()
    const sink = createToolTraceSink({ file, binding })
    await sink.request(request("o-1"))
    await sink.invoked({ tool: "blame", args, argv: ["git", "blame"], at: "t" })
    await sink.shellOutcome({ tool: "blame", args, exitCode: 0, launch: "proved", stderr: "", at: "t" })
    await sink.outcome({ context: request("o-1").context, outcome: { kind: "executed" }, at: "t" })
    const text = await readFile(file, "utf8")
    const rows = text.trimEnd().split("\n")
    expect(rows).toHaveLength(4)
    for (const row of rows) expect(row.startsWith('{"slot":"adv-01:attack"')).toBe(true)
    const read = await readToolTrace(file)
    if (read.kind !== "read") throw new Error(read.kind)
    expect(read.lines.map((line) => `${line.seq}:${line.type}`)).toEqual(["1:request", "2:invoked", "3:shellOutcome", "4:outcome"])
    expect(read.torn).toEqual([])
    expect(sink.written()).toBe(4)
    expect(sink.takeFailures()).toEqual([])
  })

  test("a failed append resolves, reaches takeFailures, and stops every later append", async () => {
    const file = await traceFile()
    let calls = 0
    const io: TraceIo = {
      async appendLine(target, text) {
        calls += 1
        if (calls === 2) throw new Error("disk full")
        await appendFile(target, text)
      },
    }
    const sink = createToolTraceSink({ file, binding, io })
    await sink.request(request("o-1"))
    await expect(sink.invoked({ tool: "blame", args, argv: ["git"], at: "t" })).resolves.toBeUndefined()
    await sink.outcome({ context: request("o-1").context, outcome: { kind: "executed" }, at: "t" })
    const failures = sink.takeFailures()
    expect(failures.map((failure) => `${failure.where}/${failure.write}`)).toEqual(["adapter/invoked", "core/outcome"])
    expect(failures[0]!.why).toContain("disk full")
    expect(failures[1]!.why).toContain("earlier append failed")
    expect(sink.takeFailures()).toEqual([])
    expect(calls).toBe(2)
    expect((await readFile(file, "utf8")).trimEnd().split("\n")).toHaveLength(1)
  })

  test("an adapter-reported failure is returned once by takeFailures", () => {
    const sink = createToolTraceSink({ file: "/nonexistent/trace", binding })
    sink.failed({ where: "adapter", write: "invoked", why: "x" })
    expect(sink.takeFailures()).toHaveLength(1)
    expect(sink.takeFailures()).toHaveLength(0)
  })
})

describe("readToolTrace", () => {
  test("an incomplete last row is torn, attributed to its slot, and the lines before it are kept", async () => {
    const file = await traceFile()
    const sink = createToolTraceSink({ file, binding })
    await sink.request(request("o-1"))
    await appendFile(file, '{"slot":"adv-01:attack","v":1,"position":2,"seq":2,"type":"inv')
    const read = await readToolTrace(file)
    if (read.kind !== "read") throw new Error(read.kind)
    expect(read.lines).toHaveLength(1)
    expect(read.torn).toEqual([{ row: 2, slot: "adv-01:attack", tail: true, why: "the last row is incomplete" }])
  })

  test("an absent file is absent, never an empty trace", async () => {
    expect(await readToolTrace(join(await traceFile(), "missing"))).toEqual({ kind: "absent" })
  })
})

describe("malformed rows and torn tails (story 2-7b review)", () => {
  test("a row with a bad request kind, bad made-request arguments or a non-string outcome kind is torn, attributed to its run", async () => {
    const file = await traceFile()
    const context = { runId: "run-1", findingId: "f", observationId: "o", tool: "blame" }
    const rows = [
      { slot: "adv-02:clean", v: 1, position: 4, seq: 1, type: "request", event: { context, request: { kind: "sideways" }, at: "t" } },
      { slot: "adv-02:clean", v: 1, position: 4, seq: 2, type: "request", event: { context, request: { kind: "made", args: { path: 7, startLine: 1, endLine: 1 } }, at: "t" } },
      { slot: "adv-02:clean", v: 1, position: 4, seq: 3, type: "outcome", event: { context, outcome: { kind: 5 }, at: "t" } },
      { slot: "adv-02:clean", v: 1, position: 4, seq: 4, type: "invoked", fact: { args: { path: "a", startLine: 1.5, endLine: 2 } } },
    ]
    await appendFile(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(""))
    const read = await readToolTrace(file)
    if (read.kind !== "read") throw new Error(read.kind)
    expect(read.lines).toEqual([])
    expect(read.torn.map((row) => `${row.row}:${row.slot}`)).toEqual(["1:adv-02:clean", "2:adv-02:clean", "3:adv-02:clean", "4:adv-02:clean"])
  })

  test("a new sink closes an earlier run's torn tail with a newline, so the two runs' rows stay apart", async () => {
    const file = await traceFile()
    await appendFile(file, '{"slot":"adv-01:clean","v":1,"position":1,"seq":1,"type":"req')
    const next = createToolTraceSink({ file, binding })
    await next.request(request("o-1"))
    const read = await readToolTrace(file)
    if (read.kind !== "read") throw new Error(read.kind)
    expect(read.torn).toEqual([{ row: 1, slot: "adv-01:clean", tail: false, why: "a row is not JSON" }])
    expect(read.lines.map((line) => `${line.slot}:${line.seq}`)).toEqual(["adv-01:attack:1"])
  })

  test("a file that already ends in a newline gets no extra blank row", async () => {
    const file = await traceFile()
    await createToolTraceSink({ file, binding: { ...binding, caseId: "adv-00" } }).request(request("o-0"))
    await createToolTraceSink({ file, binding }).request(request("o-1"))
    const read = await readToolTrace(file)
    if (read.kind !== "read") throw new Error(read.kind)
    expect(read.torn).toEqual([])
    expect(read.lines).toHaveLength(2)
  })
})

