/**
 * Stories 2-8c and 2-8c2 — the accounting probe's verdict logic and evidence shape, over
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
import type { RequestMeterPort } from "../adapters/opencode/model-backend.ts"
import type { RelayEvent } from "../ablation/request-meter.ts"
import type { AdmittedTurn } from "../core/ports/admission.ts"
import type { Envelope, ModelBackend } from "../core/ports/model-backend.ts"
import {
  attemptsOf,
  buildEvidence,
  EVIDENCE_FILE,
  EVIDENCE_KIND,
  findingsFrom,
  gateTwoVerdict,
  GATE_TWO_SEEDS,
  main,
  outProblem,
  pairLines,
  parseOut,
  physicalRecord,
  recordedOf,
  runGateTwo,
  runScenario,
  SCENARIOS,
  scenarioVerdict,
  STUB_KEY,
  STEP_REFUSAL_HEADROOM,
  UPSTREAM_CLOSE_BOUND_MS,
  type HostIdentity,
  type ProbeContext,
  type Stoppable,
  type ProbeEvidence,
} from "./accounting-probe.ts"

const request = (index: number, served: boolean, model = true, session = "s1"): StubRequest => ({
  index,
  session,
  at: index,
  method: "POST",
  path: "/v1/chat/completions",
  model,
  behaviour: served ? "ok" : "500",
  toolsOffered: [],
  placeholderKey: false,
  ...(served ? { servedUsage: { prompt_tokens: 1000 + index, completion_tokens: 10 + index, total_tokens: 1010 + 2 * index } } : {}),
})

const issued = (physicalId: string, attempt: number, step?: number): IssuedLine => ({
  type: "issued",
  physicalId,
  category: "blocks",
  block: 1,
  phase: "prefix",
  stage: "discover",
  slot: "discovery-1",
  attempt,
  ...(step === undefined ? {} : { step }),
  runId: "probe",
})

const usage = (physicalId: string, input: number, output: number): SettledLine => ({
  type: "settled",
  physicalId,
  settlement: { kind: "usage", tokens: { input, output, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
})

const unknown = (physicalId: string, why = "the provider answered HTTP 500"): SettledLine => ({ type: "settled", physicalId, settlement: { kind: "unknown", why } })

const forwarded = (session: string, step: number, extra: Partial<RelayEvent> = {}): RelayEvent => ({ at: 0, session, path: "/chat/completions", outcome: "forwarded", step, ...extra })
const refusedEvent = (session: string | null, reason: string): RelayEvent => ({ at: 0, session, path: "/chat/completions", outcome: "refused", reason })

describe("one physical request's verdict", () => {
  test("admitted, forwarded once, and settled with what was served HOLDS", () => {
    const record = physicalRecord(1, { issued: issued("request-1", 1), settled: usage("request-1", 1001, 11) }, request(1, true), forwarded("s", 1))
    expect(record.verdict).toBe("HOLDS")
    expect(record.why).toContain("admitted before it was forwarded")
  })

  test("a forwarded request with no issued line, or one the stub never received, FAILS", () => {
    expect(physicalRecord(1, undefined, request(1, true), forwarded("s", 1)).why).toContain("with no `issued` line")
    expect(physicalRecord(1, { issued: issued("r", 1), settled: usage("r", 0, 0) }, null, forwarded("s", 1)).why).toContain("never received it")
  })

  test("the host's placeholder key reaching the stub FAILS", () => {
    const leaked = { ...request(1, true), placeholderKey: true }
    expect(physicalRecord(1, { issued: issued("r", 1), settled: usage("r", 1001, 11) }, leaked, forwarded("s", 1)).why).toContain("placeholder key")
  })

  test("a figure that is not the one served FAILS; unknown for a served figure FAILS; unknown for none HOLDS", () => {
    expect(physicalRecord(1, { issued: issued("r", 1), settled: usage("r", 5, 5) }, request(1, true), forwarded("s", 1)).why).toContain(
      "MAD recorded 5 in / 5 out; the stub served 1001 in / 11 out",
    )
    expect(physicalRecord(1, { issued: issued("r", 1), settled: unknown("r") }, request(1, true), forwarded("s", 1)).verdict).toBe("FAILS")
    expect(physicalRecord(1, { issued: issued("r", 1), settled: unknown("r") }, request(1, false), forwarded("s", 1)).verdict).toBe("HOLDS")
    // A known figure for a request that served nothing is the known zero Decision 2 forbids.
    expect(physicalRecord(1, { issued: issued("r", 1), settled: usage("r", 0, 0) }, request(1, false), forwarded("s", 1)).why).toContain("the stub served no usage")
  })

  test("a hung request the relay closed promptly HOLDS; one held until the host stopped FAILS", () => {
    const hung: StubRequest = { ...request(1, false), behaviour: "hang", closed: { at: 6_100, afterMs: 5_100, by: "client" } }
    const prompt = physicalRecord(1, { issued: issued("r", 1), settled: unknown("r", "aborted") }, hung, forwarded("s", 1, { closedAfterClose: 40 }))
    expect(prompt.verdict).toBe("HOLDS")
    expect(prompt.upstream).toEqual({ closedAfterAttemptMs: 40, closedBy: "client" })
    const held = physicalRecord(1, { issued: issued("r", 1), settled: unknown("r") }, { ...hung, closed: { at: 21_000, afterMs: 20_000, by: "host-stopping" } }, forwarded("s", 1))
    expect(held.verdict).toBe("FAILS")
    expect(held.why).toContain("until the probe stopped the host")
    const late = physicalRecord(1, { issued: issued("r", 1), settled: unknown("r") }, hung, forwarded("s", 1, { closedAfterClose: UPSTREAM_CLOSE_BOUND_MS + 1 }))
    expect(late.verdict).toBe("FAILS")
  })
})

describe("attempts, from the relay's events, the stub and the journal", () => {
  test("a tool step is paired with its step line; each request settles with its own figure", () => {
    const pairs = pairLines([issued("request-1", 1), issued("request-2", 1, 2), usage("request-1", 1001, 11), usage("request-2", 1002, 12)])
    const { attempts, unattributed } = attemptsOf([{ attempt: 1, session: "s1" }], pairs, [forwarded("s1", 1), forwarded("s1", 2)], [request(1, true), request(2, true)])
    expect(unattributed).toEqual([])
    expect(attempts[0]!.physical.map((record) => [record.step, record.issued?.physicalId, record.verdict])).toEqual([
      [1, "request-1", "HOLDS"],
      [2, "request-2", "HOLDS"],
    ])
    const verdict = scenarioVerdict(attempts, [], [], 0, [])
    expect(verdict.verdict).toBe("HOLDS")
    expect(verdict.totals).toMatchObject({ physicalRequests: 2, admittedSteps: 1, servedInput: 2003, recordedInput: 2003 })
  })

  test("host retries refused by the relay are counted, and MAD's own retry is a second attempt", () => {
    const pairs = pairLines([issued("request-1", 1), unknown("request-1")])
    const events = [forwarded("s1", 1), refusedEvent("s1", "it follows a failed request of the same attempt, and MAD's retry policy is the only retry")]
    const { attempts } = attemptsOf([{ attempt: 1, session: "s1" }], pairs, events, [request(1, false)])
    const verdict = scenarioVerdict(attempts, [], [], 1, [])
    expect(verdict.verdict).toBe("HOLDS")
    expect(verdict.totals).toMatchObject({ admittedAttempts: 1, refusedAdmissions: 1, physicalRequests: 1, hostRetriesRefused: 1, unknownRequests: 1 })
    expect(verdict.why).toContain("1 host retry was refused by the relay")
  })

  test("a step admitted and not forwarded must be settled not-issued; a first request never sent must be a known zero", () => {
    const pairs = pairLines([issued("request-1", 1), usage("request-1", 0, 0), issued("request-2", 1, 2), { type: "settled", physicalId: "request-2", settlement: { kind: "not-issued" } }])
    expect(attemptsOf([{ attempt: 1, session: "s1" }], pairs, [], []).attempts[0]!.verdict).toBe("HOLDS")
    const wrong = pairLines([issued("request-1", 1), usage("request-1", 3, 0)])
    expect(attemptsOf([{ attempt: 1, session: "s1" }], wrong, [], []).attempts[0]!.why).toContain("admitted and never forwarded")
  })

  test("a stub request the relay did not forward, an unattributable refusal and an integrity failure each FAIL the scenario", () => {
    const pairs = pairLines([issued("request-1", 1), usage("request-1", 1001, 11)])
    const run = attemptsOf([{ attempt: 1, session: "s1" }], pairs, [forwarded("s1", 1), refusedEvent(null, "it names no session")], [request(1, true), request(2, true)])
    expect(run.unattributed.map((entry) => entry.index)).toEqual([2])
    const verdict = scenarioVerdict(run.attempts, run.unattributed, run.unattributedRefusals, 0, ["the attempt of request `request-1` was settled with a figure that is not the sum"])
    expect(verdict.verdict).toBe("FAILS")
    expect(verdict.why).toContain("1 physical request(s) reached the stub that the relay did not forward")
    expect(verdict.why).toContain("could not attribute 1 request(s)")
    expect(verdict.why).toContain("integrity failure")
    expect(scenarioVerdict([], [], [], 1, []).verdict).toBe("FAILS")
  })

  test("stub records pair by session, and a forwarded request no admitted attempt opened is unattributed", () => {
    const pairs = pairLines([issued("request-1", 1), usage("request-1", 1002, 12)])
    // The stub saw the orphan's request first; pairing by session still gives attempt 1 its own.
    const run = attemptsOf([{ attempt: 1, session: "s1" }], pairs, [forwarded("s9", 1), forwarded("s1", 1)], [request(1, true, true, "s9"), request(2, true)])
    expect(run.attempts[0]!.physical[0]!.verdict).toBe("HOLDS")
    expect(run.unattributed.map((entry) => entry.index)).toEqual([1])
    expect(scenarioVerdict(run.attempts, run.unattributed, run.unattributedRefusals, 0, []).verdict).toBe("FAILS")
  })

  test("a count mismatch between attempt lines and admissions marks every attempt incomplete", () => {
    const pairs = pairLines([issued("a", 1), usage("a", 1001, 11)])
    const short = attemptsOf(
      [
        { attempt: 1, session: "s1" },
        { attempt: 2, session: "s2" },
      ],
      pairs,
      [],
      [],
    ).attempts
    for (const attempt of short) expect(attempt.incomplete).toContain("1 attempt line(s) for 2 admitted attempt(s)")
    expect(scenarioVerdict(short, [], [], 0, []).complete).toBe(false)
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
  const base = { seeded: "x", backendCalls: 0, stubRequests: 0, issuedLinesAfter: 1, issuedLinesSeeded: 1, hostStop: "process 1 exited (status 143) after SIGTERM" }

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
  test("the seven scenarios story 2-8c named, and the refused step, in order", () => {
    expect(SCENARIOS.map((scenario) => scenario.name)).toEqual([
      "success",
      "persistent 500",
      "429 then success",
      "400",
      "hang past the adapter timeout",
      "host-tool step",
      "unoffered tool",
      "step refused mid-turn",
    ])
    // The refused step starts less than one stub answer short of block 1's prefix allowance.
    const seeded = SCENARIOS.find((scenario) => scenario.name === "step refused mid-turn")!.seed!
    const spent = seeded.flatMap((line) => (line.type === "settled" && line.settlement.kind === "usage" ? [line.settlement.tokens.input] : []))
    expect(spent).toEqual([PAIRED_ALLOWANCES.prefix - STEP_REFUSAL_HEADROOM])
    expect(STEP_REFUSAL_HEADROOM).toBeLessThan(1001)
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
    expect(evidence.isolation.join(" ")).toContain("its attempts to reach registry.npmjs.org appear among the refused proxy attempts")
    expect(evidence.findings.map((finding) => finding.id)).toEqual(["F2", "F3", "N2", "H1", "S1", "A1"])
    expect(evidence.story).toBe("2-8c2")
    expect(evidence.proxyAttempts).toHaveLength(1)
  })

  test("the plugin-install and findings text follow the run, not a fixed script", () => {
    const quiet = buildEvidence({ measuredAt: "2026-09-23T00:00:00.000Z", host, scenarios: [], gateTwo: [], proxyAttempts: [] })
    expect(quiet.isolation.join(" ")).toContain("no attempt to reach registry.npmjs.org was among the refused proxy attempts")
    expect(quiet.findings.find((finding) => finding.id === "F2")!.text).toContain("scenario `persistent 500` did not run")
    const events = [forwarded("s1", 1), refusedEvent("s1", "it follows a failed request of the same attempt, and MAD's retry policy is the only retry")]
    const run = attemptsOf([{ attempt: 1, session: "s1" }], pairLines([issued("request-1", 1), unknown("request-1")]), events, [request(1, false)])
    const scenario = { name: "persistent 500", attempts: run.attempts, unattributedRefusals: [], ...scenarioVerdict(run.attempts, [], [], 1, []) } as unknown as ProbeEvidence["scenarios"][number]
    const measured = buildEvidence({ measuredAt: "2026-09-23T00:00:00.000Z", host, scenarios: [scenario], gateTwo: [], proxyAttempts: [] })
    expect(measured.findings.find((finding) => finding.id === "F2")!.text).toContain(
      "`persistent 500`: 1 request(s) reached the stub, 1 host retry was refused by the relay, and 1 forwarded request(s) were settled unknown",
    )
  })
})

describe(`the committed evidence (${MEASURED_HOST.evidence})`, () => {
  const evidenceUrl = new URL(`../${MEASURED_HOST.evidence}`, import.meta.url)
  const read = async (): Promise<ProbeEvidence> => JSON.parse(await Bun.file(evidenceUrl).text()) as ProbeEvidence

  test("it was taken on the measured build, and names it", async () => {
    const evidence = await read()
    expect(evidence.kind).toBe(EVIDENCE_KIND)
    expect(evidence.host.sha256).toBe(MEASURED_HOST.sha256)
    expect(evidence.host.version).toBe(MEASURED_HOST.version)
    expect(evidence.host.matchesMeasuredHost).toBe(true)
  })

  test("every scenario HOLDS: each physical request admitted, forwarded once and settled with its own figure", async () => {
    const evidence = await read()
    const by = (name: string) => evidence.scenarios.find((scenario) => scenario.name === name)!
    expect(evidence.story).toBe("2-8c2")
    expect(evidence.scenarios.map((scenario) => scenario.name)).toEqual(SCENARIOS.map((scenario) => scenario.name))
    for (const scenario of evidence.scenarios) {
      expect(scenario.complete, scenario.name).toBe(true)
      expect(scenario.verdict, `${scenario.name}: ${scenario.why}`).toBe("HOLDS")
      expect(scenario.integrity, scenario.name).toEqual([])
      expect(scenario.unattributedRequests, scenario.name).toEqual([])
    }
    expect(by("success").totals.physicalRequests).toBe(1)
    // F2: the host still retries; the relay refuses every retry, and none reaches the stub.
    for (const name of ["persistent 500", "429 then success"]) expect(by(name).totals.hostRetriesRefused, name).toBeGreaterThan(0)
    // F3 and N2: the tool step is admitted as step 2 and its usage is recorded.
    for (const name of ["host-tool step", "unoffered tool"]) {
      expect(by(name).totals.admittedSteps, name).toBe(1)
      expect(by(name).totals.recordedInput, name).toBe(by(name).totals.servedInput)
    }
    // H1: the relay closed the hung request when the attempt ended.
    const hung = by("hang past the adapter timeout").attempts.flatMap((attempt) => attempt.physical).find((record) => record.upstream !== undefined)!
    expect(hung.upstream!.closedBy).toBe("client")
    // The refused step reached nothing.
    expect(by("step refused mid-turn").totals.physicalRequests).toBe(1)
    // No stub request carried the host's placeholder key.
    for (const scenario of evidence.scenarios) {
      for (const record of scenario.attempts.flatMap((attempt) => attempt.physical)) expect(record.stub?.placeholderKey, scenario.name).toBe(false)
    }
  })

  test("its findings are the ones its own scenarios give", async () => {
    const evidence = await read()
    expect(evidence.findings).toEqual(findingsFrom(evidence.scenarios))
  })

  test("each of global, Blocks and phase shows a refused admission with 0 backend calls and 0 stub requests", async () => {
    const evidence = await read()
    expect(evidence.gateTwo.map((entry) => entry.gate)).toEqual(["global", "Blocks", "phase"])
    for (const entry of evidence.gateTwo) {
      expect(entry.holds, entry.gate).toBe(true)
      expect(entry.hostStop, entry.gate).toContain("exited")
      expect(entry.refusals.length, entry.gate).toBeGreaterThan(0)
      expect(entry.backendCalls, entry.gate).toBe(0)
      expect(entry.stubRequests, entry.gate).toBe(0)
    }
  })

  test("it carries no credential value and states that no paid token was spent", async () => {
    const text = await Bun.file(evidenceUrl).text()
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
        // The stand-in host's URL is the relay's, so the stand-in backend reaches the stub through it.
        startHost: async (context) => {
          relayKey.value = context.relay!.hostKey
          return {
            url: context.relay!.baseURL,
            stop: async (): Promise<StopOutcome> => {
              counts.hostStops += 1
              return { confirmed: true, pid: 1, how: "exited (status 143) after SIGTERM" }
            },
          }
        },
        backendFor: (host, options) => callingBackend({ url: host.url, hostKey: relayKey.value }, options.meter, counts),
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

  test("a tool step is admitted as step 2, forwarded, and recorded with its own usage", async () => {
    await withContext(async (context) => {
      const record = await runScenario(context, { ...SCENARIOS.find((scenario) => scenario.name === "host-tool step")!, turnTimeoutMs: 5_000 })
      expect(record.verdict, record.why).toBe("HOLDS")
      expect(record.totals).toMatchObject({ admittedAttempts: 1, physicalRequests: 2, admittedSteps: 1, servedInput: 2003, recordedInput: 2003 })
      expect(record.integrity).toEqual([])
    })
  })

  test("a persistent 500: the retry is refused by the relay, the request is unknown, and MAD's retry is refused by the halt", async () => {
    await withContext(async (context) => {
      const record = await runScenario(context, { ...SCENARIOS.find((scenario) => scenario.name === "persistent 500")!, turnTimeoutMs: 5_000 })
      expect(record.verdict, record.why).toBe("HOLDS")
      expect(record.totals).toMatchObject({ admittedAttempts: 1, refusedAdmissions: 1, physicalRequests: 1, hostRetriesRefused: 1, unknownRequests: 1 })
      expect(record.refusedAdmissions[0]!.cause).toBe("halted")
    })
  })

  test("a step refused mid-turn reaches nothing, and the first request keeps its figure", async () => {
    await withContext(async (context) => {
      const record = await runScenario(context, { ...SCENARIOS.find((scenario) => scenario.name === "step refused mid-turn")!, turnTimeoutMs: 5_000 })
      expect(record.verdict, record.why).toBe("HOLDS")
      expect(record.totals).toMatchObject({ physicalRequests: 1, admittedSteps: 0, recordedInput: 1001 })
      expect(record.attempts[0]!.relayRefusals[0]).toContain("shared prefix allowance is exhausted")
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

/**
 * The shipped probe body, run through `main` with a stand-in host and backend and
 * one scenario: what it writes, and when it refuses to write.
 */
describe("the probe body writes evidence only for a complete run", () => {
  const identity: HostIdentity = {
    binary: "/opt/opencode",
    sha256: MEASURED_HOST.sha256,
    version: MEASURED_HOST.version,
    measuredHost: { version: MEASURED_HOST.version, sha256: MEASURED_HOST.sha256 },
    matchesMeasuredHost: true,
    environmentKeys: ["HOME"],
    generatedConfig: {},
    reportedConfig: {},
  }
  const runMain = async (hooks: { recordIdentity: boolean; gateTwoSeeds?: typeof GATE_TWO_SEEDS; stopConfirmed?: boolean }) => {
    const parent = await mkdtemp(join(tmpdir(), "mad-probe-body-"))
    const out = join(parent, "out")
    const errors: string[] = []
    const original = { log: console.log, error: console.error }
    console.log = () => {}
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "))
    }
    try {
      const counts = { backendCalls: 0 }
      const code = await main(["bun", "probe", "--out", out], {
        scenarios: [{ ...SCENARIOS[0]!, turnTimeoutMs: 5_000 }],
        ...(hooks.gateTwoSeeds === undefined ? {} : { gateTwoSeeds: hooks.gateTwoSeeds }),
        startHost: async (context) => {
          if (hooks.recordIdentity) context.identity ??= identity
          relayKey.value = context.relay!.hostKey
          const host: Stoppable & { url: string } = {
            url: context.relay!.baseURL,
            stop: async (): Promise<StopOutcome> =>
              hooks.stopConfirmed === false ? { confirmed: false, pid: 31, why: "no exit" } : { confirmed: true, pid: 31, how: "exited (status 143) after SIGTERM" },
          }
          context.live.add(host)
          return host
        },
        backendFor: (host, options) => callingBackend({ url: host.url, hostKey: relayKey.value }, options.meter, counts),
      })
      return { code, errors: errors.join("\n"), written: existsSync(join(out, EVIDENCE_FILE)), evidence: existsSync(join(out, EVIDENCE_FILE)) ? ((await Bun.file(join(out, EVIDENCE_FILE)).json()) as ProbeEvidence) : undefined }
    } finally {
      console.log = original.log
      console.error = original.error
      await rm(parent, { recursive: true, force: true })
    }
  }

  test("a complete run writes the evidence and exits 0", async () => {
    const result = await runMain({ recordIdentity: true })
    expect(result.errors).toBe("")
    expect(result.code).toBe(0)
    expect(result.written).toBe(true)
    expect(result.evidence!.gateTwo.every((entry) => entry.holds && entry.hostStop.includes("exited"))).toBe(true)
  })

  test("a run with no host identity exits 1 and writes nothing", async () => {
    const result = await runMain({ recordIdentity: false })
    expect(result.code).toBe(1)
    expect(result.errors).toContain("INCOMPLETE — no host identity was recorded")
    expect(result.written).toBe(false)
  })

  test("a gate-2 case that does not hold exits 1 and writes nothing", async () => {
    const unseeded = [{ ...GATE_TWO_SEEDS[0]!, seeded: "nothing: the journal is empty", lines: [] }]
    const result = await runMain({ recordIdentity: true, gateTwoSeeds: unseeded })
    expect(result.code).toBe(1)
    expect(result.errors).toContain("gate 2's global case was not shown (no admission was refused")
    expect(result.written).toBe(false)
  })

  test("a host stop that is not confirmed fails the run, names the pid, and writes nothing", async () => {
    const result = await runMain({ recordIdentity: true, stopConfirmed: false })
    expect(result.code).toBe(1)
    expect(result.errors).toContain("the managed host's exit is UNCONFIRMED: check process 31 by hand")
    expect(result.written).toBe(false)
  })
})

/** The host key of the relay the stand-in host was started behind, for the stand-in backend. */
const relayKey = { value: "" }

/**
 * A backend that behaves as the measured host does behind one port call: it opens
 * a session on the meter, sends each request to the relay with the session in
 * both headers and the placeholder key, follows one tool step, and retries a
 * failed request once. The turn's usage is the meter's.
 */
function callingBackend(relay: { url: string; hostKey: string }, meter: RequestMeterPort, counts: { backendCalls: number }): ModelBackend {
  let sessions = 0
  return {
    capabilities: () => ({ tools: true }),
    async runTurn<T>(slot: string, _instructions: string, _input: string, schema: ZodType<T>, _signal?: AbortSignal, admitted?: AdmittedTurn): Promise<Envelope<T>> {
      counts.backendCalls += 1
      sessions += 1
      const session = `ses_stand_in_${sessions}`
      const metered = admitted === undefined ? undefined : meter.open(session, admitted)
      const call = async () => {
        const response = await fetch(`${relay.url}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${relay.hostKey}`,
            "x-session-affinity": session,
            "X-Session-Id": session,
          },
          body: JSON.stringify({ model: "m1", stream: false, tools: [{ type: "function", function: { name: "StructuredOutput" } }] }),
        })
        return { status: response.status, body: (await response.json().catch(() => ({}))) as { choices?: { message?: { tool_calls?: { function: { name: string; arguments: string } }[] } }[] } }
      }
      let answer = await call()
      if (answer.status === 500 || answer.status === 429) answer = await call()
      if (answer.body.choices?.[0]?.message?.tool_calls?.[0]?.function.name === "glob") answer = await call()
      const measured = metered === undefined ? undefined : await metered.close()
      const usage =
        measured === undefined || measured.kind === "unknown"
          ? { usageUnknown: { executionId: `exec-${sessions}`, why: measured?.why ?? "not metered" } }
          : { tokens: measured.tokens }
      if (answer.status !== 200) return { ok: false, slot, failure: "model-error", message: `HTTP ${answer.status}`, ...usage }
      const args = JSON.parse(answer.body.choices![0]!.message!.tool_calls![0]!.function.arguments) as unknown
      return { ok: true, slot, value: schema.parse(args), ...usage }
    },
  }
}
