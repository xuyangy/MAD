/**
 * Story 2-8c — the accounting probe's verdict logic and evidence shape, over
 * fakes. No test here starts a host: the real-host run is `bun run
 * accounting-probe`, and its committed output is checked by the evidence tests
 * at the bottom.
 */

import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ZodType } from "zod"

import { startAccountingStub, startRefusingProxy, type StubRequest } from "../ablation/accounting-stub.ts"
import { PAIRED_ALLOWANCES } from "../ablation/governor.ts"
import { acquireLock, JOURNAL_FILE, openJournal, type IssuedLine, type SettledLine } from "../ablation/journal.ts"
import { MEASURED_HOST, type StopOutcome } from "../ablation/managed-host.ts"
import type { Envelope, ModelBackend } from "../core/ports/model-backend.ts"
import {
  attemptRecord,
  attemptsOf,
  attributeRequests,
  buildEvidence,
  EVIDENCE_FILE,
  EVIDENCE_KIND,
  gateTwoVerdict,
  GATE_TWO_SEEDS,
  main,
  outProblem,
  pairLines,
  parseOut,
  recordedOf,
  runGateTwo,
  runScenario,
  SCENARIOS,
  scenarioVerdict,
  STUB_KEY,
  type HostIdentity,
  type ProbeContext,
  type Stoppable,
  type ProbeEvidence,
} from "./accounting-probe.ts"

const request = (index: number, served: boolean, model = true): StubRequest => ({
  index,
  at: index,
  method: "POST",
  path: "/v1/chat/completions",
  model,
  behaviour: served ? "ok" : "500",
  toolsOffered: [],
  ...(served ? { servedUsage: { prompt_tokens: 1000 + index, completion_tokens: 10 + index, total_tokens: 1010 + 2 * index } } : {}),
})

const issued = (physicalId: string, attempt: number): IssuedLine => ({
  type: "issued",
  physicalId,
  category: "blocks",
  block: 1,
  phase: "prefix",
  stage: "discover",
  slot: "discovery-1",
  attempt,
  runId: "probe",
})

const usage = (physicalId: string, input: number, output: number): SettledLine => ({
  type: "settled",
  physicalId,
  settlement: { kind: "usage", tokens: { input, output, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
})

describe("attributing requests to attempts", () => {
  test("every request after an admission and before the next belongs to it; earlier ones are unattributed", () => {
    const requests = [request(1, false), request(2, false), request(3, true), request(4, true, false), request(5, true)]
    const { byAttempt, unattributed } = attributeRequests(
      [
        { attempt: 1, modelRequestsBefore: 1 },
        { attempt: 2, modelRequestsBefore: 3 },
      ],
      requests,
    )
    expect(unattributed.map((entry) => entry.index)).toEqual([1])
    expect(byAttempt.map((entries) => entries.map((entry) => entry.index))).toEqual([[2, 3], [5]])
  })
})

describe("one attempt's verdict", () => {
  test("one request whose served usage is the usage settled HOLDS", () => {
    const record = attemptRecord(1, issued("request-1", 1), usage("request-1", 1001, 11), [request(1, true)])
    expect(record.verdict).toBe("HOLDS")
    expect(record.hiddenRequests).toBe(0)
  })

  test("a host retry FAILS, naming the count the port call did not show", () => {
    const requests = [1, 2, 3, 4, 5, 6].map((index) => request(index, false))
    const record = attemptRecord(1, issued("request-1", 1), usage("request-1", 0, 0), requests)
    expect(record.verdict).toBe("FAILS")
    expect(record.why).toContain("6 physical requests stood behind one admitted port call (5 the port call did not show)")
  })

  test("a tool step whose first step's usage was dropped FAILS on the count and on the usage", () => {
    const record = attemptRecord(1, issued("request-1", 1), usage("request-1", 1002, 12), [request(1, true), request(2, true)])
    expect(record.verdict).toBe("FAILS")
    expect(record.why).toContain("MAD recorded 1002 in / 12 out; the stub served 2003 in / 23 out over 2 request(s)")
  })

  test("an unknown settlement for a request that served nothing HOLDS; one that hid served usage FAILS", () => {
    const unknown: SettledLine = { type: "settled", physicalId: "request-1", settlement: { kind: "unknown", why: "timed out" } }
    expect(attemptRecord(1, issued("request-1", 1), unknown, [request(1, false)]).verdict).toBe("HOLDS")
    const hidden = attemptRecord(1, issued("request-1", 1), unknown, [request(1, true)])
    expect(hidden.verdict).toBe("FAILS")
    expect(hidden.why).toContain("MAD recorded no figure (unknown)")
  })

  test("a missing settled line is an incomplete verdict", () => {
    const record = attemptRecord(1, issued("request-1", 1), null, [request(1, false)])
    expect(record.recorded.kind).toBe("missing")
    expect(scenarioVerdict([record], [], 0).complete).toBe(false)
  })
})

describe("a scenario's totals", () => {
  test("MAD's own retry is kept apart from the host's hidden requests", () => {
    const first = attemptRecord(1, issued("request-1", 1), usage("request-1", 0, 0), [1, 2, 3].map((index) => request(index, false)))
    const second = attemptRecord(2, issued("request-2", 2), usage("request-2", 0, 0), [4, 5, 6].map((index) => request(index, false)))
    const verdict = scenarioVerdict([first, second], [], 0)
    expect(verdict.totals).toMatchObject({ admittedAttempts: 2, madRetries: 1, physicalRequests: 6, hiddenHostRequests: 4 })
    expect(verdict.verdict).toBe("FAILS")
    expect(verdict.complete).toBe(true)
  })

  test("an unattributed request fails the scenario, and no admission is not a HOLDS", () => {
    const ok = attemptRecord(1, issued("request-1", 1), usage("request-1", 1002, 12), [request(2, true)])
    expect(scenarioVerdict([ok], [request(1, false)], 0).verdict).toBe("FAILS")
    const none = scenarioVerdict([], [], 1)
    expect(none.verdict).toBe("FAILS")
    expect(none.complete).toBe(false)
  })

  test("journal lines are paired by physical id in issue order", () => {
    const pairs = pairLines([issued("a", 1), issued("b", 2), usage("b", 1, 1), usage("a", 2, 2)])
    expect(pairs.map((pair) => [pair.issued.physicalId, pair.settled?.physicalId])).toEqual([
      ["a", "a"],
      ["b", "b"],
    ])
  })
})

describe("gate 2", () => {
  const base = { seeded: "x", backendCalls: 0, stubRequests: 0, issuedLinesAfter: 1, issuedLinesSeeded: 1 }

  test("its own gate's budget refusal with nothing called, requested or issued holds", () => {
    const record = gateTwoVerdict({ ...base, gate: "phase", refusals: [{ cause: "budget", reason: "block 1's shared prefix allowance is exhausted: 60000 of 60000" }] }, "shared prefix allowance is exhausted")
    expect(record.holds).toBe(true)
  })

  test("another gate's refusal, a backend call, a stub request or a new issued line does not hold", () => {
    const refusal = { cause: "budget", reason: "the Blocks allowance is exhausted" }
    expect(gateTwoVerdict({ ...base, gate: "global", refusals: [refusal] }, "global cap is exhausted").holds).toBe(false)
    const right = [{ cause: "budget", reason: "the experiment's global cap is exhausted" }]
    expect(gateTwoVerdict({ ...base, gate: "global", refusals: right, backendCalls: 1 }, "global cap is exhausted").why).toContain("1 backend call(s)")
    expect(gateTwoVerdict({ ...base, gate: "global", refusals: right, stubRequests: 2 }, "global cap is exhausted").why).toContain("received 2 request(s)")
    expect(gateTwoVerdict({ ...base, gate: "global", refusals: right, issuedLinesAfter: 2 }, "global cap is exhausted").why).toContain("gained an `issued` line")
    expect(gateTwoVerdict({ ...base, gate: "global", refusals: [] }, "global cap is exhausted").why).toContain("no admission was refused")
  })

  test("each seed exhausts exactly its own gate", () => {
    expect(GATE_TWO_SEEDS.map((entry) => entry.gate)).toEqual(["global", "Blocks", "phase"])
    const spent = (entry: (typeof GATE_TWO_SEEDS)[number]) =>
      entry.lines.flatMap((line) => (line.type === "settled" && line.settlement.kind === "usage" ? [line.settlement.tokens.input] : []))
    expect(GATE_TWO_SEEDS.map(spent)).toEqual([[2_000_000], [1_400_000], [60_000]])
  })
})

describe("the scenarios and the command line", () => {
  test("the seven scenarios the story names, in order", () => {
    expect(SCENARIOS.map((scenario) => scenario.name)).toEqual([
      "success",
      "persistent 500",
      "429 then success",
      "400",
      "hang past the adapter timeout",
      "host-tool step",
      "unoffered tool",
    ])
    expect(SCENARIOS.find((scenario) => scenario.name === "unoffered tool")!.tools).toEqual({ "*": false, StructuredOutput: true })
    // Only the unoffered-tool scenario sets `tools`: no tool policy is changed anywhere else.
    expect(SCENARIOS.filter((scenario) => scenario.tools !== undefined).map((scenario) => scenario.name)).toEqual(["unoffered tool"])
  })

  test("--out must be absolute, and nothing else is taken", () => {
    expect(parseOut(["bun", "probe", "--out", "/tmp/x"])).toEqual({ ok: true, out: "/tmp/x" })
    expect(parseOut(["bun", "probe", "--out=/tmp/x"])).toEqual({ ok: true, out: "/tmp/x" })
    expect(parseOut(["bun", "probe", "--out", "rel"]).ok).toBe(false)
    expect(parseOut(["bun", "probe"]).ok).toBe(false)
    expect(parseOut(["bun", "probe", "--server", "y"]).ok).toBe(false)
    expect(parseOut(["bun", "probe", "--out", "/tmp/x", "--server", "y"]).ok).toBe(false)
  })
})

describe("the evidence shape", () => {
  const host: HostIdentity = {
    binary: "/opt/opencode",
    sha256: MEASURED_HOST.sha256,
    version: MEASURED_HOST.version,
    measuredHost: { version: MEASURED_HOST.version, sha256: MEASURED_HOST.sha256 },
    matchesMeasuredHost: true,
    environmentKeys: ["HOME"],
    generatedConfig: {},
    reportedConfig: {},
  }

  test("it states zero paid tokens, the refused proxy attempts, and that direct egress is not shown blocked", () => {
    const evidence = buildEvidence({ measuredAt: "2026-09-23T00:00:00.000Z", host, scenarios: [], gateTwo: [], proxyAttempts: [{ at: 1, line: "CONNECT registry.npmjs.org:443 HTTP/1.1" }] })
    expect(evidence.kind).toBe(EVIDENCE_KIND)
    expect(evidence.paidTokens.startsWith("none.")).toBe(true)
    expect(evidence.egress).toContain("direct egress was NOT shown to be blocked")
    expect(evidence.egress).not.toContain("every outbound attempt was")
    expect(evidence.isolation.join(" ")).toContain("npm install @opencode-ai/plugin")
    expect(evidence.findings.map((finding) => finding.id)).toEqual(["F2", "F3", "N2"])
    expect(evidence.proxyAttempts).toHaveLength(1)
  })
})

describe("the committed evidence (ablation/evidence/host-accounting-2026-09-23.json)", () => {
  const read = async (): Promise<ProbeEvidence> =>
    JSON.parse(await Bun.file(new URL("../ablation/evidence/host-accounting-2026-09-23.json", import.meta.url)).text()) as ProbeEvidence

  test("it was taken on the measured build, and names it", async () => {
    const evidence = await read()
    expect(evidence.kind).toBe(EVIDENCE_KIND)
    expect(evidence.host.sha256).toBe(MEASURED_HOST.sha256)
    expect(evidence.host.version).toBe(MEASURED_HOST.version)
    expect(evidence.host.matchesMeasuredHost).toBe(true)
  })

  test("success HOLDS with one request; 500, host-tool and unoffered-tool FAIL with their counts", async () => {
    const evidence = await read()
    const by = (name: string) => evidence.scenarios.find((scenario) => scenario.name === name)!
    expect(evidence.scenarios.map((scenario) => scenario.name)).toEqual(SCENARIOS.map((scenario) => scenario.name))
    for (const scenario of evidence.scenarios) expect(scenario.complete, scenario.name).toBe(true)
    expect(by("success").verdict).toBe("HOLDS")
    expect(by("success").totals.physicalRequests).toBe(1)
    for (const name of ["persistent 500", "host-tool step", "unoffered tool"]) {
      expect(by(name).verdict, name).toBe("FAILS")
      expect(by(name).totals.hiddenHostRequests, name).toBeGreaterThan(0)
    }
  })

  test("each of global, Blocks and phase shows a refused admission with 0 backend calls and 0 stub requests", async () => {
    const evidence = await read()
    expect(evidence.gateTwo.map((entry) => entry.gate)).toEqual(["global", "Blocks", "phase"])
    for (const entry of evidence.gateTwo) {
      expect(entry.holds, entry.gate).toBe(true)
      expect(entry.refusals.length, entry.gate).toBeGreaterThan(0)
      expect(entry.backendCalls, entry.gate).toBe(0)
      expect(entry.stubRequests, entry.gate).toBe(0)
    }
  })

  test("it carries no credential value and states that no paid token was spent", async () => {
    const text = await Bun.file(new URL("../ablation/evidence/host-accounting-2026-09-23.json", import.meta.url)).text()
    expect(text).not.toContain(STUB_KEY)
    const evidence = JSON.parse(text) as ProbeEvidence
    expect(evidence.paidTokens.startsWith("none.")).toBe(true)
    expect(evidence.egress).toContain("NOT shown to be blocked")
  })
})

describe("the probe deadline", () => {
  test("a scenario that never settles: the probe stops its host and servers, removes its scratch, exits 1, and writes no evidence", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mad-probe-deadline-"))
    try {
      const out = join(parent, "out")
      const scratchDir = await mkdtemp(join(parent, "scratch-"))
      let hostStops = 0
      let serverStops = 0
      const host = {
        stop: async (): Promise<StopOutcome> => {
          hostStops += 1
          return { confirmed: true, pid: 1, how: "exited (status 143) after SIGTERM" }
        },
      } as Stoppable
      const errors: string[] = []
      const original = { log: console.log, error: console.error }
      console.log = () => {}
      console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "))
      }
      let code: number
      try {
        code = await main(["bun", "probe", "--out", out], {
          deadlineMs: 50,
          // A scenario that never settles: registers what it made, then never resolves.
          body: (_out, scratch, live, servers) => {
            scratch.push(scratchDir)
            live.add(host)
            servers.push({ stop: () => (serverStops += 1) })
            return new Promise<number>(() => {})
          },
          settleMs: 20,
        })
      } finally {
        console.log = original.log
        console.error = original.error
      }
      expect(code).toBe(1)
      expect(errors.join("\n")).toContain("the probe did not finish within 50 ms. NOTHING ABOVE IS A COMPLETE MEASUREMENT.")
      expect(existsSync(scratchDir)).toBe(false)
      expect(hostStops).toBe(1)
      expect(serverStops).toBe(1)
      expect(await readdir(out)).toEqual([])
      expect(existsSync(join(out, EVIDENCE_FILE))).toBe(false)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  test("a host stop the deadline cleanup cannot confirm is named, and the exit stays non-zero", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mad-probe-deadline-"))
    try {
      const host = { stop: async (): Promise<StopOutcome> => ({ confirmed: false, pid: 99, why: "no exit" }) } as Stoppable
      const errors: string[] = []
      const original = { log: console.log, error: console.error }
      console.log = () => {}
      console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "))
      }
      let code: number
      try {
        code = await main(["bun", "probe", "--out", join(parent, "out")], {
          deadlineMs: 20,
          settleMs: 20,
          body: (_out, _scratch, live) => {
            live.add(host)
            return new Promise<number>(() => {})
          },
        })
      } finally {
        console.log = original.log
        console.error = original.error
      }
      expect(code).toBe(1)
      expect(errors.join("\n")).toContain("check process 99 by hand")
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})

describe("the probe deadline cancels the body", () => {
  test("a host the body starts after the deadline fired is still stopped, and the body is told to stop", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mad-probe-deadline-"))
    try {
      let stops = 0
      let sawAbort = false
      const late: Stoppable = {
        stop: async () => {
          stops += 1
          return { confirmed: true, pid: 5, how: "exited (status 143) after SIGTERM" }
        },
      }
      const original = { log: console.log, error: console.error }
      console.log = () => {}
      console.error = () => {}
      let code: number
      try {
        code = await main(["bun", "probe", "--out", join(parent, "out")], {
          deadlineMs: 30,
          settleMs: 2_000,
          body: async (_out, _scratch, live, _servers, signal) => {
            await Bun.sleep(80)
            sawAbort = signal.aborted
            // A host start that was already under way when the deadline fired.
            live.add(late)
            return 0
          },
        })
      } finally {
        console.log = original.log
        console.error = original.error
      }
      expect(code).toBe(1)
      expect(sawAbort).toBe(true)
      expect(stops).toBe(1)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})

describe("--out", () => {
  test("an absent or empty directory is accepted; a non-empty one, `/` and an ancestor of the scratch root are refused", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mad-probe-out-"))
    try {
      expect(await outProblem(join(parent, "absent"), join(parent, "tmp"))).toBeNull()
      await mkdir(join(parent, "empty"))
      expect(await outProblem(join(parent, "empty"), join(parent, "tmp"))).toBeNull()
      await mkdir(join(parent, "used"))
      await writeFile(join(parent, "used", "host-accounting.json"), "{}")
      expect(await outProblem(join(parent, "used"), join(parent, "tmp"))).toContain("is not empty")
      expect(await outProblem("/", join(parent, "tmp"))).toContain("filesystem root")
      expect(await outProblem(parent, join(parent, "tmp", "deeper"))).toContain("contains the temporary directory")
      expect(await outProblem(join(parent, "tmp"), join(parent, "tmp"))).toContain("contains the temporary directory")
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  test("main refuses a non-empty --out before anything runs", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mad-probe-out-"))
    try {
      await writeFile(join(parent, "stale.jsonl"), "x\n")
      let ran = false
      const original = console.error
      console.error = () => {}
      try {
        expect(await main(["bun", "probe", "--out", parent], { body: async () => ((ran = true), 0) })).toBe(1)
      } finally {
        console.error = original
      }
      expect(ran).toBe(false)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})

describe("recorded settlements and pairing", () => {
  test("a settlement kind the probe does not know is recorded as unknown, named, never as not-issued", () => {
    const odd = { type: "settled", physicalId: "a", settlement: { kind: "refunded" } } as unknown as SettledLine
    expect(recordedOf(odd)).toEqual({ kind: "unknown", why: 'the settlement\'s kind "refunded" is not one the probe recognises' })
    expect(recordedOf(null)).toEqual({ kind: "missing" })
  })

  test("pairs are matched on the attempt number, and a count mismatch marks every attempt incomplete", () => {
    const marks = [
      { attempt: 1, modelRequestsBefore: 0 },
      { attempt: 2, modelRequestsBefore: 1 },
    ]
    const requests = [request(1, true), request(2, true)]
    // Issue order swapped: matching is by attempt, not by position.
    const pairs = pairLines([issued("b", 2), usage("b", 1002, 12), issued("a", 1), usage("a", 1001, 11)])
    const matched = attemptsOf(marks, pairs, requests).attempts
    expect(matched.map((attempt) => attempt.issued?.physicalId)).toEqual(["a", "b"])
    expect(matched.every((attempt) => attempt.verdict === "HOLDS")).toBe(true)
    const short = attemptsOf(marks, pairs.slice(0, 1), requests).attempts
    for (const attempt of short) {
      expect(attempt.incomplete).toContain("1 issued line(s) for 2 admitted attempt(s)")
      expect(attempt.verdict).toBe("FAILS")
    }
    expect(scenarioVerdict(short, [], 0).complete).toBe(false)
  })

  test("a hung request closed when the probe stopped the host says the host held it open, and for how long", () => {
    const hung: StubRequest = { ...request(1, false), behaviour: "hang", closed: { at: 21_000, afterMs: 20_000, by: "host-stopping" } }
    const unknown: SettledLine = { type: "settled", physicalId: "request-1", settlement: { kind: "unknown", why: "timed out" } }
    const record = attemptRecord(1, issued("request-1", 1), unknown, [hung], { settledAt: 6_000 })
    expect(record.verdict).toBe("HOLDS")
    expect(record.upstream).toEqual({ heldOpenAfterSettleMs: 15_000, closedBy: "host-stopping" })
    expect(record.why).toContain("the host held the provider request open for 15000 ms after the adapter gave up, until the probe stopped the host")
  })
})

describe("the gate-2 seeds, against the real journal", () => {
  test("the amounts are the allowances", () => {
    const amounts = GATE_TWO_SEEDS.map((entry) =>
      entry.lines.flatMap((line) => (line.type === "settled" && line.settlement.kind === "usage" ? [line.settlement.tokens.input] : [])),
    )
    expect(amounts).toEqual([[PAIRED_ALLOWANCES.global], [PAIRED_ALLOWANCES.blocks], [PAIRED_ALLOWANCES.prefix]])
  })

  for (const entry of GATE_TWO_SEEDS) {
    test(`a journal seeded for ${entry.gate} refuses block 1's prefix admission with its own reason`, async () => {
      const root = await mkdtemp(join(tmpdir(), "mad-probe-seed-"))
      try {
        await writeFile(join(root, JOURNAL_FILE), entry.lines.map((line) => `${JSON.stringify(line)}\n`).join(""))
        const taken = await acquireLock(root, "2026-09-23T00:00:00.000Z")
        if (!taken.ok) throw new Error(taken.reason)
        const opened = await openJournal(root, taken.lock, () => "2026-09-23T00:00:00.000Z")
        if (!opened.ok) throw new Error(opened.reason)
        expect(opened.journal.bill().halt).toBeNull()
        const decision = await opened.journal.admission({ block: 1, phase: "prefix", runId: () => "seed-test" }).admit({ stage: "discover", slot: "discovery-1", attempt: 1 })
        expect(decision.ok).toBe(false)
        if (!decision.ok) {
          expect(decision.cause).toBe("budget")
          expect(decision.reason).toContain(entry.expected)
        }
        await opened.journal.close()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
})

/**
 * The probe's glue, over the real stub, the real journal and a real `discover`,
 * with a stand-in host (no process) and a backend that calls the stub directly.
 * A tool step is imitated as the host does it: a second request, whose usage is
 * the only one reported back.
 */
describe("runScenario and runGateTwo, with a stand-in host and backend", () => {
  const withContext = async (run: (context: ProbeContext, counts: { hostStops: number; backendCalls: number }) => Promise<void>) => {
    const parent = await mkdtemp(join(tmpdir(), "mad-probe-glue-"))
    const stub = startAccountingStub()
    const proxy = startRefusingProxy()
    const counts = { hostStops: 0, backendCalls: 0 }
    try {
      const workDir = join(parent, "work")
      await mkdir(workDir)
      const context: ProbeContext = {
        out: join(parent, "out"),
        stub,
        proxy,
        workDir,
        scratchParent: parent,
        live: new Set(),
        signal: new AbortController().signal,
        startHost: async () => ({
          url: "http://127.0.0.1:1",
          stop: async (): Promise<StopOutcome> => {
            counts.hostStops += 1
            return { confirmed: true, pid: 1, how: "exited (status 143) after SIGTERM" }
          },
        }),
        backendFor: () => callingBackend(stub.baseURL, counts),
      }
      await run(context, counts)
    } finally {
      await stub.stop()
      proxy.stop()
      await rm(parent, { recursive: true, force: true })
    }
  }

  test("a success records one request whose usage is the one settled, and stops the host", async () => {
    await withContext(async (context, counts) => {
      const record = await runScenario(context, { ...SCENARIOS[0]!, turnTimeoutMs: 5_000 })
      expect(record.verdict).toBe("HOLDS")
      expect(record.complete).toBe(true)
      expect(record.totals).toMatchObject({ admittedAttempts: 1, physicalRequests: 1, servedInput: 1001, recordedInput: 1001 })
      expect(record.attempts[0]!.issued!.attempt).toBe(1)
      expect(counts.hostStops).toBe(1)
    })
  })

  test("a tool step records two requests behind one attempt and the lost usage", async () => {
    await withContext(async (context) => {
      const record = await runScenario(context, { ...SCENARIOS.find((scenario) => scenario.name === "host-tool step")!, turnTimeoutMs: 5_000 })
      expect(record.verdict).toBe("FAILS")
      expect(record.totals).toMatchObject({ admittedAttempts: 1, physicalRequests: 2, hiddenHostRequests: 1, servedInput: 2003, recordedInput: 1002 })
    })
  })

  test("a persistent 500 is retried once by MAD, kept apart from host requests", async () => {
    await withContext(async (context) => {
      const record = await runScenario(context, { ...SCENARIOS.find((scenario) => scenario.name === "persistent 500")!, turnTimeoutMs: 5_000 })
      expect(record.totals).toMatchObject({ admittedAttempts: 2, madRetries: 1, physicalRequests: 2, hiddenHostRequests: 0 })
    })
  })

  for (const entry of GATE_TWO_SEEDS) {
    test(`gate 2, ${entry.gate}: refused with 0 backend calls and 0 stub requests`, async () => {
      await withContext(async (context, counts) => {
        const record = await runGateTwo(context, entry)
        expect(record.holds, record.why).toBe(true)
        expect(record.backendCalls).toBe(0)
        expect(record.stubRequests).toBe(0)
        expect(counts.backendCalls).toBe(0)
        expect(counts.hostStops).toBe(1)
      })
    })
  }

  test("an aborted signal stops the next scenario from starting", async () => {
    await withContext(async (context, counts) => {
      const controller = new AbortController()
      controller.abort()
      await expect(runScenario({ ...context, signal: controller.signal }, SCENARIOS[0]!)).rejects.toThrow("the probe deadline passed")
      expect(counts.hostStops).toBe(0)
    })
  })
})

/** A backend that sends its turn straight to the stub, as the host would, following one tool step. */
function callingBackend(baseURL: string, counts: { backendCalls: number }): ModelBackend {
  const call = async () => {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m1", stream: false, tools: [{ type: "function", function: { name: "StructuredOutput" } }] }),
    })
    return { status: response.status, body: (await response.json().catch(() => ({}))) as { choices?: { message?: { tool_calls?: { function: { name: string; arguments: string } }[] } }[]; usage?: { prompt_tokens: number; completion_tokens: number } } }
  }
  return {
    capabilities: () => ({ tools: true }),
    async runTurn<T>(slot: string, _instructions: string, _input: string, schema: ZodType<T>): Promise<Envelope<T>> {
      counts.backendCalls += 1
      let answer = await call()
      if (answer.body.choices?.[0]?.message?.tool_calls?.[0]?.function.name === "glob") answer = await call()
      if (answer.status !== 200) {
        return { ok: false, slot, failure: "model-error", message: `HTTP ${answer.status}`, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }
      }
      const args = JSON.parse(answer.body.choices![0]!.message!.tool_calls![0]!.function.arguments) as unknown
      const usage = answer.body.usage!
      return { ok: true, slot, value: schema.parse(args), tokens: { input: usage.prompt_tokens, output: usage.completion_tokens, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }
    },
  }
}
