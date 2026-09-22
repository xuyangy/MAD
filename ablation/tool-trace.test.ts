/**
 * Story 2-7b — the durable trace sink: run-bound lines, synced in call order;
 * write failures reach `takeFailures` and are never thrown; a torn row is read
 * back as torn, counted and attributed.
 *
 * Story 2-7c's rows are about UNRESOLVED operations. A failed append and an
 * abandoned one are different states: a failure is finished and the file can be
 * read back, while an abandoned append may still be running and nothing may
 * touch the file again. Every row uses a controlled deferred promise and a tiny
 * deadline, never an elapsed-time comparison.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  awaitObservationWrite,
  OBSERVATION_IO_TIMEOUT_MS,
  OBSERVATION_WRITE_TIMEOUT_MS,
} from "../core/ports/observation-wait.ts"
import type { ToolRequestEvent } from "../core/ports/tool-observation.ts"
import {
  createToolTraceSink,
  readToolTrace,
  traceUnresolved,
  TraceDeadlineError,
  TraceUnresolvedError,
  type TraceIo,
} from "./tool-trace.ts"

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

describe("malformed rows and torn tails", () => {
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


describe("an UNRESOLVED file operation (story 2-7c)", () => {
  /** An IO whose append never settles, and which this file settles by hand. */
  function hangingIo() {
    const gates: { resolve: () => void; reject: (error: unknown) => void }[] = []
    const physical: string[] = []
    const io: TraceIo = {
      appendLine(target, text) {
        physical.push(text)
        return new Promise<void>((resolve, reject) => {
          gates.push({ resolve, reject })
        })
      },
    }
    return { io, gates, physical }
  }

  test("AN ABANDONED APPEND POISONS THE FILE, notifies at once, and is not a failed append", async () => {
    const file = await traceFile()
    const { io } = hangingIo()
    const told: string[] = []
    const sink = createToolTraceSink({
      file,
      binding,
      io,
      operationTimeoutMs: 5,
      // THE POISON IS ALREADY SET WHEN THIS RUNS, asserted from INSIDE the
      // callback because "latched before notified" is an ordering claim.
      onUnresolved: (fact) => told.push(`${fact.slot}#${fact.seq}:${traceUnresolved(file) === null ? "open" : "held"}`),
    })

    await sink.request(request("o-1"))

    expect(told).toEqual(["adv-01:attack#1:held"])
    expect(traceUnresolved(file)).not.toBeNull()
    const failures = sink.takeFailures()
    expect(failures).toHaveLength(1)
    // NOT WORDED AS A FAILED APPEND. "could not be appended" would tell a reader
    // the write finished and lost; this one may still be running.
    expect(failures[0]!.why).toContain("UNCONFIRMED")
    expect(failures[0]!.why).toContain("may still be running")
    expect(failures[0]!.why).not.toContain("could not be appended")
  })

  test("QUEUED WORK IS FENCED BEFORE ITS PHYSICAL I/O, not merely after its promise", async () => {
    const file = await traceFile()
    const { io, gates, physical } = hangingIo()
    const sink = createToolTraceSink({ file, binding, io, operationTimeoutMs: 5 })

    // Two writes chained on one queue. The first hangs; the second is behind it
    // when the poison lands.
    const first = sink.request(request("o-1"))
    const second = sink.outcome({ context: request("o-2").context, outcome: { kind: "executed" }, at: "t" })
    await first
    await second

    // ONE PHYSICAL ATTEMPT. A fence that only suppressed the returned promise
    // would have let the second line reach the disk behind an append still in
    // flight, at an offset nobody can predict.
    expect(physical).toHaveLength(1)
    const failures = sink.takeFailures()
    expect(failures).toHaveLength(2)
    expect(failures[1]!.why).toContain("UNRESOLVED")
    expect(sink.written()).toBe(0)

    // AND A LATE SETTLEMENT CLEARS NOTHING. The file stays held.
    gates[0]!.resolve()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(traceUnresolved(file)).not.toBeNull()
  })

  test("A LATER RUN MAY NOT REUSE THE FILE — the sink refuses to be built", async () => {
    const file = await traceFile()
    const { io } = hangingIo()
    const sink = createToolTraceSink({ file, binding, io, operationTimeoutMs: 5 })
    await sink.request(request("o-1"))

    expect(() => createToolTraceSink({ file, binding: { ...binding, position: 3 } })).toThrow(TraceUnresolvedError)
    expect(() => createToolTraceSink({ file, binding: { ...binding, position: 3 } })).toThrow("Recovery is manual")
  })

  test("A DIFFERENT FILE IS UNAFFECTED, and a generous deadline does not poison at all", async () => {
    // The non-vacuous sibling, twice over: the poison is per file, and an IO that
    // answers is never abandoned. Without this row every assertion above would
    // pass on an implementation that poisoned unconditionally.
    const held = await traceFile()
    const { io } = hangingIo()
    const first = createToolTraceSink({ file: held, binding, io, operationTimeoutMs: 5 })
    await first.request(request("o-1"))

    const fresh = await traceFile()
    // NO DEADLINE OPTION AT ALL, so this also exercises the shipped default.
    const sink = createToolTraceSink({ file: fresh, binding })
    await sink.request(request("o-1"))
    await sink.outcome({ context: request("o-1").context, outcome: { kind: "executed" }, at: "t" })

    expect(traceUnresolved(fresh)).toBeNull()
    expect(sink.written()).toBe(2)
    expect(sink.takeFailures()).toEqual([])
  })

  test("A CALLBACK THAT THROWS DOES NOT GIVE THE FILE BACK", async () => {
    const file = await traceFile()
    const { io } = hangingIo()
    const sink = createToolTraceSink({
      file,
      binding,
      io,
      operationTimeoutMs: 5,
      onUnresolved: () => {
        throw new Error("the runner could not record it")
      },
    })

    await expect(sink.request(request("o-1"))).resolves.toBeUndefined()
    expect(traceUnresolved(file)).not.toBeNull()
  })
})

describe("A LATE RESOLUTION, observed where a reader reads (story 2-7c)", () => {
  test("the physical append may land late; the RUN's completeness never comes back", async () => {
    const file = await traceFile()
    let release: (() => void) | undefined
    // THE HONEST FIXTURE: the append is held open and, when released, REALLY
    // WRITES. That is what an abandoned file operation does — MAD stopped
    // waiting, the operating system did not stop working — and a fixture that
    // simply resolved without writing would be testing a state that cannot
    // happen.
    const io: TraceIo = {
      appendLine: (target, text) =>
        new Promise<void>((resolve, reject) => {
          release = () => {
            appendFile(target, text).then(resolve, reject)
          }
        }),
    }

    const sink = createToolTraceSink({ file, binding, io, operationTimeoutMs: 5 })
    await sink.request(request("o-1"))

    expect(sink.written()).toBe(0)
    // Drained exactly as the judge drains it at the end of a stage.
    expect(sink.takeFailures()).toHaveLength(1)

    release!()
    await new Promise((resolve) => setTimeout(resolve, 20))

    // THE BYTES ARE ON DISK, and this file says so rather than pretending
    // otherwise: MAD cannot un-write an append it stopped waiting for.
    const read = await readToolTrace(file)
    if (read.kind !== "read") throw new Error(read.kind)
    expect(read.lines).toHaveLength(1)

    // AND NONE OF THAT RESTORES THE RUN. Every assertion below reads the sink's
    // own LIVE state after the late resolution, not a value captured before it.
    //
    // - the run's count of what it recorded did not move, so nothing downstream
    //   can read this write as one the run knows it made;
    expect(sink.written()).toBe(0)
    // - the failure was not retracted, and no second one was invented;
    expect(sink.takeFailures()).toEqual([])
    // - and the file is still held, so the completeness that matters — whether a
    //   later run may append to it at all — is unchanged by the late landing.
    expect(traceUnresolved(file)).not.toBeNull()
    expect(() => createToolTraceSink({ file, binding: { ...binding, position: 9 } })).toThrow(TraceUnresolvedError)
  })

  test("A WRITE THAT SIMPLY SUCCEEDS DOES COUNT — the non-vacuous sibling", async () => {
    // Without this row the assertions above would pass on a sink whose `written`
    // counter never moved at all.
    const file = await traceFile()
    const sink = createToolTraceSink({ file, binding })
    await sink.request(request("o-1"))

    expect(sink.written()).toBe(1)
    expect(sink.takeFailures()).toEqual([])
    expect(traceUnresolved(file)).toBeNull()
  })
})

describe("THE SHIPPED SINK DEADLINE, at its wiring boundary (story 2-7c)", () => {
  /** Capture what durations a body schedules, without waiting any of them out. */
  async function timersOf<T>(work: () => Promise<T>): Promise<number[]> {
    const registered: number[] = []
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((handler: never, ms: never, ...rest: never[]) => {
      registered.push(ms as unknown as number)
      return realSetTimeout(handler, ms, ...rest)
    }) as typeof setTimeout
    try {
      await work()
      return registered
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  }

  test("A SINK BUILT WITH NO TIMEOUT OPTION SCHEDULES 4,000 ms", async () => {
    // EXERCISED THROUGH REAL DEFAULT CONSTRUCTION. Asserting the exported
    // constant proves only that the constant says 4,000; a `??` fallback pointing
    // somewhere else would satisfy it. This asserts what the sink schedules.
    const file = await traceFile()
    const sink = createToolTraceSink({ file, binding })

    const registered = await timersOf(() => sink.request(request("o-1")))

    expect(registered).toEqual([4_000])
    expect(OBSERVATION_IO_TIMEOUT_MS).toBe(4_000)
  })

  test("THE INNER BOUND IS STRICTLY INSIDE THE CALLER'S, and a sink may not be built otherwise", () => {
    // Coordination, not coincidence. Equal constants would leave the ordering to
    // whichever timer happened to be registered first.
    expect(OBSERVATION_IO_TIMEOUT_MS).toBeLessThan(OBSERVATION_WRITE_TIMEOUT_MS)
    expect(() => createToolTraceSink({ file: "/tmp/mad-unused", binding, operationTimeoutMs: OBSERVATION_WRITE_TIMEOUT_MS })).toThrow(
      TraceDeadlineError,
    )
    expect(() => createToolTraceSink({ file: "/tmp/mad-unused", binding, operationTimeoutMs: 30_000 })).toThrow(
      "strictly shorter",
    )
  })

  test("a deadline that cannot bound anything is refused at construction", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() => createToolTraceSink({ file: "/tmp/mad-unused", binding, operationTimeoutMs: bad })).toThrow(
        TraceDeadlineError,
      )
    }
  })

  test("THE DEADLINE STARTS AT ENQUEUE, so queue time counts against it", async () => {
    // A shorter duration started later is not shorter at all. Two writes are
    // asked for back to back; the first holds the queue past the second's whole
    // budget, so the second must be abandoned WITHOUT ever touching the disk
    // rather than beginning a fresh append whenever its turn came.
    const file = await traceFile()
    const physical: string[] = []
    let release: (() => void) | undefined
    const io: TraceIo = {
      appendLine: (_target, text) =>
        new Promise<void>((resolve) => {
          physical.push(text)
          release = resolve
        }),
    }
    const sink = createToolTraceSink({ file, binding, io, operationTimeoutMs: 20 })

    const first = sink.request(request("o-1"))
    const second = sink.outcome({ context: request("o-2").context, outcome: { kind: "executed" }, at: "t" })
    await first
    await second
    release?.()

    // ONE physical attempt: the second never reached the file.
    expect(physical).toHaveLength(1)
    const failures = sink.takeFailures()
    expect(failures).toHaveLength(2)
    expect(failures[1]!.why).toMatch(/UNRESOLVED|deadline expired/)
  })
})

describe("NESTED DEADLINES: the latch lands before the caller is released (story 2-7c)", () => {
  test("THE SHIPPED WIRING: the sink poisons and notifies before the caller is released", async () => {
    // THE ORDERING THE QUARANTINE DEPENDS ON. The judge waits on the promise this
    // sink returns under `OBSERVATION_WRITE_TIMEOUT_MS`. If the judge's bound won
    // the race, it would be released — and could reach the next model admission —
    // while this sink had not yet decided anything, so the runner's stop would
    // latch one model request too late.
    //
    // SCOPED TO THE SHIPPED CONSTRUCTION, which is what `ablation/adversarial.ts`
    // builds: both sides take their defaults. The sibling below pins the limit of
    // that claim. Asserted with a controlled deferred IO and the REAL shipped
    // constants, and recorded as an ORDER rather than as two elapsed times.
    const file = await traceFile()
    const order: string[] = []
    const io: TraceIo = { appendLine: () => new Promise<void>(() => {}) }
    const sink = createToolTraceSink({
      file,
      binding,
      io,
      onUnresolved: () => order.push("runner latched"),
    })

    // The caller's half, exactly as `core/stages/judge.ts` does it.
    const outcome = await awaitObservationWrite(() => sink.request(request("o-1")))
    order.push("caller released")

    // The sink settled first — so it resolved, rather than the caller abandoning
    // it — and the latch was already in place at that moment.
    expect(outcome.kind).toBe("settled")
    expect(order).toEqual(["runner latched", "caller released"])
    expect(traceUnresolved(file)).not.toBeNull()
  })

  test("A CALLER THAT OVERRIDES ITS OWN BOUND CAN STILL WIN — the limit of the claim", async () => {
    // Stated rather than implied. The construction guard compares a sink's
    // deadline against the SHIPPED caller bound, so it cannot see a caller that
    // passes a shorter one of its own — and such a caller is released before this
    // sink has decided anything. That override exists for tests and nothing in
    // the shipped wiring uses one; closing it for arbitrary callers would need
    // the sink to learn its caller had abandoned a write, which
    // `ToolObservation` cannot express without widening.
    const file = await traceFile()
    const order: string[] = []
    const io: TraceIo = { appendLine: () => new Promise<void>(() => {}) }
    const sink = createToolTraceSink({
      file,
      binding,
      io,
      operationTimeoutMs: 50,
      onUnresolved: () => order.push("runner latched"),
    })

    const outcome = await awaitObservationWrite(() => sink.request(request("o-1")), 5)
    order.push("caller released")

    // The caller abandoned the write rather than the sink resolving it, and the
    // latch had NOT landed at that moment.
    expect(outcome).toEqual({ kind: "timed-out", ms: 5 })
    expect(order).toEqual(["caller released"])

    // It does still land, a moment later — the sink is not broken, it is second.
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(order).toEqual(["caller released", "runner latched"])
    expect(traceUnresolved(file)).not.toBeNull()
  })

  test("AND THE CALLER IS NOT SIMPLY ALWAYS SECOND — the non-vacuous sibling", async () => {
    // Without this row the assertion above would pass on a sink that resolved
    // instantly for every reason, latched or not. A healthy write settles with no
    // latch at all.
    const file = await traceFile()
    const latched: string[] = []
    const sink = createToolTraceSink({ file, binding, onUnresolved: () => latched.push("latched") })

    const outcome = await awaitObservationWrite(() => sink.request(request("o-1")))

    expect(outcome.kind).toBe("settled")
    expect(latched).toEqual([])
    expect(traceUnresolved(file)).toBeNull()
    expect(sink.written()).toBe(1)
  })
})
