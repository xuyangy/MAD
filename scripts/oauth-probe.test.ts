/**
 * Story 2-8c3b — the OAuth probe's verdicts, its sandbox self-test refusal, and a
 * whole run against a stand-in host. No test here starts opencode, runs npm,
 * reaches the network or touches the user's opencode directories: the stand-in
 * backend sends each attempt to the real local stubs the way the host would.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ZodType } from "zod"

import { JOURNAL_FILE } from "../ablation/journal.ts"
import type { OAuthRoute, StopOutcome } from "../ablation/managed-host.ts"
import { AUTH_CONTENT_MARKER, fakeAuthLink } from "../ablation/oauth-payload.fixture.ts"
import type { OAuthStubRequest } from "../ablation/oauth-stub.ts"
import { abandonedTurn, type Envelope, type ModelBackend } from "../core/ports/model-backend.ts"
import {
  ABANDON_SLACK_MS,
  attemptVerdict,
  attributeRequests,
  egressTargets,
  EVIDENCE_FILE,
  main,
  parseProbeArgs,
  placeholderAuth,
  redactPaths,
  sandboxSelfTest,
  settlementKind,
  journalLines,
  registryListing,
  registryVerdict,
  SCENARIOS,
  selfTestVerdict,
  type AttemptRecord,
  type AttemptScenarioFacts,
  type ProbeEvidence,
  type ProbeHooks,
  type Scenario,
  type SelfTest,
} from "./oauth-probe.ts"

const scratch: string[] = []
afterEach(async () => {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-oauth-probe-test-"))
  scratch.push(dir)
  return dir
}

const request = (index: number, at: number, extra: Partial<OAuthStubRequest> = {}): OAuthStubRequest => ({
  index,
  provider: "anthropic",
  at,
  method: "POST",
  path: "/v1/messages",
  model: true,
  authHeaderPresent: true,
  behaviour: "ok",
  ...extra,
})

const issued = { type: "issued" as const, physicalId: "request-1", category: "blocks" as const, block: 1, phase: "prefix" as const, stage: "discover", slot: "discovery-1", attempt: 1, runId: "r", mode: "attempts" as const }

function attempt(extra: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    attempt: 1,
    admittedAtMs: 100,
    settledAtMs: 300,
    issued,
    settled: { type: "settled", physicalId: "request-1", settlement: { kind: "unknown", why: "none reported" } },
    requests: [{ index: 1, provider: "anthropic", method: "POST", path: "/v1/messages", model: true, authHeaderPresent: true, behaviour: "ok", atMs: 150 }],
    hostRetries: 0,
    settlement: "`unknown`",
    ...extra,
  }
}

function facts(extra: Partial<AttemptScenarioFacts>): AttemptScenarioFacts {
  return {
    expect: "one-request",
    turnTimeoutMs: 1000,
    seededIssued: 0,
    issuedAfter: 1,
    attempts: [attempt()],
    unattributed: [],
    refusals: [],
    backendCalls: 1,
    stubRequests: 1,
    journalLatched: null,
    proxyTargets: [],
    postStop: { held: ["ok"], problems: [] },
    journalProblems: [],
    ...extra,
  }
}

describe("attribution", () => {
  test("a request belongs to the attempt whose window it arrived in; one before every window is unattributed", () => {
    const marks = [
      { attempt: 1, admittedAt: 100, settledAt: 200 },
      { attempt: 2, admittedAt: 300, settledAt: 400 },
    ]
    const { perAttempt, unattributed } = attributeRequests(marks, [request(1, 50), request(2, 150), request(3, 210), request(4, 350), request(5, 360), request(6, 900, { model: false })], 20)
    expect(perAttempt.map((list) => list.map((entry) => entry.index))).toEqual([[2, 3], [4, 5]])
    expect(unattributed.map((entry) => entry.index)).toEqual([1])
  })
})

describe("verdicts", () => {
  test("one attempt journaled before one stub request with an auth header HOLDS", () => {
    expect(attemptVerdict(facts({})).verdict).toBe("HOLDS")
  })

  test("a second request, a request before admission, a missing auth header or an unattributed request FAILS", () => {
    const two = attempt({ requests: [...attempt().requests, { ...attempt().requests[0]!, index: 2, atMs: 160 }], hostRetries: 1 })
    expect(attemptVerdict(facts({ attempts: [two] })).why).toContain("the stub received 2 request(s) for the attempt, not 1")
    const early = attempt({ requests: [{ ...attempt().requests[0]!, atMs: 50 }] })
    expect(attemptVerdict(facts({ attempts: [early] })).why).toContain("`issued` line written before its stub request")
    const bare = attempt({ requests: [{ ...attempt().requests[0]!, authHeaderPresent: false }] })
    expect(attemptVerdict(facts({ attempts: [bare] })).why).toContain("no auth header")
    expect(attemptVerdict(facts({ unattributed: [attempt().requests[0]!] })).why).toContain("outside every admitted attempt's window")
    expect(attemptVerdict(facts({ postStop: { held: [], problems: ["after the host exited, the link moved"] } })).why).toContain("the link moved")
  })

  test("a refused attempt HOLDS only when the attempt gate refused and nothing was called, requested or issued", () => {
    const refused = facts({ expect: "refused", attempts: [], backendCalls: 0, stubRequests: 0, seededIssued: 10, issuedAfter: 10, refusals: [{ cause: "budget", reason: "block 1's shared prefix allowance is exhausted: 10 of 10 admitted attempts" }] })
    expect(attemptVerdict(refused).verdict).toBe("HOLDS")
    expect(attemptVerdict({ ...refused, stubRequests: 1 }).why).toContain("the stubs received 1 request(s)")
    expect(attemptVerdict({ ...refused, refusals: [] }).why).toContain("no admission was refused")
  })

  test("an abandoned attempt HOLDS when settled unknown and abandoned within its bound and the journal latched", () => {
    const abandoned = attempt({ settled: { type: "settled", physicalId: "request-1", settlement: { kind: "unknown", why: "timed out", abandoned: true } }, settledAtMs: 1100 })
    const ok = facts({ expect: "abandoned", attempts: [abandoned], journalLatched: "ATTEMPT-MODE STOP" })
    expect(attemptVerdict(ok).verdict).toBe("HOLDS")
    expect(attemptVerdict({ ...ok, journalLatched: null }).why).toContain("latched neither a stop nor a halt")
    const late = attempt({ ...abandoned, settledAtMs: 100 + 1000 + ABANDON_SLACK_MS + 1 })
    expect(attemptVerdict({ ...ok, attempts: [late] }).why).toContain("the bound is")
    expect(attemptVerdict({ ...ok, attempts: [attempt()] }).why).toContain("not unknown with `abandoned: true`")
  })

  test("host retries within one attempt HOLD and are counted as a disclosure", () => {
    const retried = attempt({ requests: [0, 1, 2].map((n) => ({ ...attempt().requests[0]!, index: n + 1, atMs: 150 + n, behaviour: "500" as const })), hostRetries: 2 })
    const verdict = attemptVerdict(facts({ expect: "host-retries", attempts: [retried] }))
    expect(verdict.verdict).toBe("HOLDS")
    expect(verdict.why).toContain("the stub counted 3 request(s) against it, 2 of them host retries")
    expect(attemptVerdict(facts({ expect: "host-retries", attempts: [retried, retried] })).verdict).toBe("FAILS")
    // No retry observed: UNPROBED, with the reason. No settled line, or a request without an auth header: FAILS.
    const once = attemptVerdict(facts({ expect: "host-retries" }))
    expect(once.verdict).toBe("UNPROBED")
    expect(once.why).toContain("the host made no retry")
    expect(attemptVerdict(facts({ expect: "host-retries", attempts: [{ ...retried, settled: null }] })).why).toContain("no `settled` line")
    const bare = { ...retried, requests: retried.requests.map((request, index) => ({ ...request, authHeaderPresent: index !== 1 })) }
    expect(attemptVerdict(facts({ expect: "host-retries", attempts: [bare] })).why).toContain("carried no auth header")
  })

  test("openai is UNPROBED, naming the refused egress target; a post-stop problem, an unattributed request or a torn journal FAILS it", () => {
    const base = facts({ expect: "unprobed", attempts: [], stubRequests: 0, proxyTargets: ["chatgpt.com:443"] })
    const verdict = attemptVerdict(base)
    expect(verdict.verdict).toBe("UNPROBED")
    expect(verdict.why).toContain("chatgpt.com:443")
    expect(attemptVerdict({ ...base, postStop: { held: [], problems: ["after the host exited, the link moved"] } }).verdict).toBe("FAILS")
    expect(attemptVerdict({ ...base, unattributed: [attempt().requests[0]!] }).verdict).toBe("FAILS")
    expect(attemptVerdict({ ...base, journalProblems: ["line 3 of the journal could not be parsed"] }).why).toContain("line 3")
  })

  test("the settlement is recorded in words, and a usage figure is marked unverified", () => {
    expect(settlementKind(attempt({ settled: { type: "settled", physicalId: "p", settlement: { kind: "usage", tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } } } }))).toBe(
      "`usage` with host-reported 0 in / 0 out (unverified)",
    )
    expect(settlementKind(attempt({ settled: null }))).toBe("never")
    expect(attemptVerdict(facts({})).why).toContain("settled once, `unknown`")
  })

  test("a registry HOLDS when every roster model is listed and the post-stop checks held", () => {
    const listed = registryListing({
      providers: [
        { id: "openai", models: { "gpt-6-luna": {} }, options: { apiKey: AUTH_CONTENT_MARKER } },
        { id: "anthropic", models: { "claude-opus-5-5": {} } },
        { id: "github-copilot", models: { "gpt-5-mini": {}, other: {} } },
      ],
    })
    expect(JSON.stringify(listed)).not.toContain(AUTH_CONTENT_MARKER)
    expect(registryVerdict({ listed, postStop: { held: ["intact"], problems: [] } }).verdict).toBe("HOLDS")
    expect(registryVerdict({ listed: listed.slice(1), postStop: { held: [], problems: [] } }).why).toContain("does not list `openai`")
    expect(registryVerdict({ listed, postStop: null }).verdict).toBe("FAILS")
  })
})

describe("helpers", () => {
  test("egress targets drop loopback and repeats", () => {
    expect(egressTargets([{ at: 0, line: "CONNECT chatgpt.com:443 HTTP/1.1" }, { at: 1, line: "CONNECT chatgpt.com:443 HTTP/1.1" }, { at: 2, line: "CONNECT 127.0.0.1:9 HTTP/1.1" }, { at: 3, line: "GET http://x.test/a?q=1 HTTP/1.1" }])).toEqual([
      "chatgpt.com:443",
      "GET http://x.test/a",
    ])
  })

  test("the self-test is inconclusive when the unsandboxed control cannot connect, and nothing is sandboxed then", async () => {
    const calls: string[] = []
    const result = await sandboxSelfTest(async (hostname, port) => {
      calls.push(`${hostname}:${port}`)
      return "refused: ENETUNREACH"
    })
    expect(result.ok).toBe(false)
    expect(result.why).toMatch(/inconclusive|is absent/)
    expect(calls.length).toBeLessThanOrEqual(1)
    expect(selfTestVerdict({ control: "no answer within 5000 ms", loopback: "connected", external: [{ target: "x", outcome: "refused: ECONNREFUSED" }] }).why).toContain("inconclusive")
  })

  test("the self-test holds only when loopback connected and every external target was refused", () => {
    expect(selfTestVerdict({ control: "connected", loopback: "connected", external: [{ target: "1.1.1.1:443", outcome: "refused: EPERM" }] }).ok).toBe(true)
    expect(selfTestVerdict({ control: "connected", loopback: "connected", external: [{ target: "1.1.1.1:443", outcome: "connected" }] }).why).toContain("`1.1.1.1:443` was not refused")
    expect(selfTestVerdict({ control: "connected", loopback: "refused: EPERM", external: [{ target: "x", outcome: "refused" }] }).ok).toBe(false)
    expect(selfTestVerdict({ control: "connected", loopback: "connected", external: [] }).ok).toBe(false)
  })

  test("paths are replaced longest first", () => {
    expect(redactPaths("/a/b/c and /a/b", [["/a/b", "<out>"], ["/a/b/c", "<scratch>"]])).toBe("<scratch> and <out>")
  })

  test("placeholders are OAuth entries for the three providers, far in the future, and no real token", () => {
    const auth = placeholderAuth(0) as Record<string, { type: string; expires: number; access: string }>
    expect(Object.keys(auth)).toEqual(["openai", "anthropic", "github-copilot"])
    for (const entry of Object.values(auth)) {
      expect(entry.type).toBe("oauth")
      expect(entry.expires).toBeGreaterThan(300 * 24 * 3_600_000)
      expect(entry.access).toStartWith("mad-probe-placeholder-")
    }
  })

  test("arguments: --out required; the data and prepared directories absolute; the data directory defaults to the dedicated one", () => {
    expect(parseProbeArgs(["bun", "x"]).ok).toBe(false)
    expect(parseProbeArgs(["bun", "x", "--out", "/o", "--oauth-data-dir", "rel"])).toEqual({ ok: false, reason: "--oauth-data-dir needs an absolute path" })
    expect(parseProbeArgs(["bun", "x", "--out", "/o", "--x"]).ok).toBe(false)
    expect(parseProbeArgs(["bun", "x", "--out", "/o"], "/home/u")).toEqual({ ok: true, args: { out: "/o", dataDir: expect.stringMatching(/\.local\/share\/mad-opencode-oauth$/), home: "/home/u" } })
  })

  test("the shipped scenarios: two registries, anthropic and copilot attempts, a refusal, a hang, a 500 and openai UNPROBED", () => {
    expect(SCENARIOS.map((scenario) => scenario.name)).toEqual([
      "registry with placeholders",
      "registry with the real data directory",
      "anthropic attempt",
      "copilot attempt",
      "attempt refused by a seeded gate",
      "hang past the turn deadline",
      "persistent 500",
      "openai attempt",
    ])
  })
})

// ---------------------------------------------------------------------------
// A whole run against a stand-in host
// ---------------------------------------------------------------------------

const passingSelfTest = async (): Promise<SelfTest> => ({ ok: true, control: "connected", loopback: "connected", external: [{ target: "1.1.1.1:443", outcome: "refused: EPERM" }], why: "stand-in" })

/**
 * A stand-in for the OAuth host: each attempt is sent to the stub its route points
 * the provider at, as the host would, with an auth header. A hang is given up at
 * the turn deadline and reported abandoned; a 500 is retried twice, as the host's
 * own retries would be; openai has no stub and fails in transport.
 */
function standIn(options: { postStopProblems?: string[] } = {}) {
  let route: OAuthRoute | undefined
  const started: OAuthRoute[] = []
  let stops = 0
  const hooks: ProbeHooks = {
    prepare: async () => ({ ok: true }),
    selfTest: passingSelfTest,
    startHost: async (context, given) => {
      route = given
      context.identity ??= {
        binary: "/opt/opencode",
        sha256: "stand-in",
        version: "stand-in",
        measuredHost: { version: "stand-in", sha256: "stand-in" },
        matchesMeasuredHost: false,
        environmentKeys: [],
        generatedConfig: {},
        reportedConfig: {},
        payload: { anthropicAuth: { lockSha256: null, treeDigest: null, entries: null }, configSeed: { lockSha256: null, treeDigest: null, entries: null }, catalogueSha256: null },
      }
      started.push(given)
      return {
        url: "http://127.0.0.1:1",
        stop: async (): Promise<StopOutcome> => {
          stops += 1
          return { confirmed: true, pid: 99, how: "exited", postStop: { held: ["the auth symlink is intact"], problems: options.postStopProblems ?? [] } }
        },
      }
    },
    listProviders: async () => ({
      providers: [
        { id: "openai", models: { "gpt-6-luna": {} } },
        { id: "anthropic", models: { "claude-opus-5-5": {} } },
        { id: "github-copilot", models: { "gpt-5-mini": {} } },
      ],
    }),
    backendFor: (_host, given): ModelBackend => ({
      capabilities: () => ({ tools: true }),
      async runTurn<T>(slot: string, _instructions: string, _input: string, schema: ZodType<T>): Promise<Envelope<T>> {
        const provider = given.slots[0]!.providerId
        const base = route?.baseURLs?.[provider]
        if (base === undefined) return { ok: false, slot, failure: "transport-error", message: "no stub stands in", usageUnknown: { executionId: "exec-x", why: "refused" } }
        const url = provider === "anthropic" ? `${base}/messages` : `${base}/chat/completions`
        for (let tries = 0; tries < 3; tries += 1) {
          let status: number
          try {
            const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer placeholder" }, body: "{}", signal: AbortSignal.timeout(given.timeoutMs) })
            status = response.status
            await response.arrayBuffer()
          } catch {
            return abandonedTurn<T>(slot, "exec-hang", `the turn timed out at its ${given.timeoutMs}ms deadline`)
          }
          if (status === 200) return { ok: true, slot, value: schema.parse({ findings: [] }) }
        }
        return { ok: false, slot, failure: "model-error", message: "HTTP 500", usageUnknown: { executionId: "exec-500", why: "none reported" } }
      },
    }),
    scenarios: SCENARIOS.map((scenario): Scenario => (scenario.kind === "attempt" && scenario.expect === "abandoned" ? { ...scenario, turnTimeoutMs: 200 } : scenario)),
  }
  return { hooks, started, stops: () => stops }
}

async function runProbe(hooks: ProbeHooks, extra: { platform?: string } = {}) {
  const root = await temp()
  const out = join(root, "out")
  const { dataDir, home } = await fakeAuthLink(root)
  const errors: string[] = []
  const lines: string[] = []
  const [log, error] = [console.log, console.error]
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "))
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "))
  try {
    const code = await main(["bun", "x", "--out", out, "--oauth-data-dir", dataDir], { ...hooks, home, scratchRoot: join(root, "no-such-scratch"), ...extra })
    return { code, out, dataDir, home, text: lines.join("\n"), errors: errors.join("\n") }
  } finally {
    console.log = log
    console.error = error
  }
}

describe("a run against a stand-in host", () => {
  test("every scenario runs; anthropic and copilot HOLD, openai is UNPROBED; the evidence is written redacted", async () => {
    const stand = standIn()
    const result = await runProbe(stand.hooks)
    expect(result.code, `${result.text}\n${result.errors}`).toBe(0)
    const evidence = JSON.parse(await readFile(join(result.out, EVIDENCE_FILE), "utf8")) as ProbeEvidence
    expect(evidence.summary).toEqual({
      "registry with placeholders": "HOLDS",
      "registry with the real data directory": "HOLDS",
      "anthropic attempt": "HOLDS",
      "copilot attempt": "HOLDS",
      "attempt refused by a seeded gate": "HOLDS",
      "hang past the turn deadline": "HOLDS",
      "persistent 500": "HOLDS",
      "openai attempt": "UNPROBED",
    })
    // The listing-only scenario used the real data directory; every prompt used the placeholders, with the stubs as overrides.
    expect(stand.started.filter((route) => route.dataDir === result.dataDir).length).toBe(1)
    expect(stand.started.filter((route) => route.dataDir === result.dataDir)[0]!.baseURLs).toBeUndefined()
    expect(stand.started.filter((route) => route.dataDir !== result.dataDir).every((route) => route.baseURLs?.anthropic !== undefined)).toBe(true)
    expect(stand.stops()).toBe(stand.started.length)
    const text = await readFile(join(result.out, EVIDENCE_FILE), "utf8")
    expect(text).not.toContain(result.out)
    expect(text).not.toContain(result.home)
    expect(text).not.toContain(AUTH_CONTENT_MARKER)
    expect(text).not.toContain("mad-probe-placeholder-access")
    const retries = evidence.findings.find((finding) => finding.id === "R1")!
    expect(retries.text).toContain("3 request(s), 2 of them host retries")
  })

  test("a post-stop problem fails the run", async () => {
    const result = await runProbe(standIn({ postStopProblems: ["after the host exited, the link moved"] }).hooks)
    expect(result.code).toBe(1)
    expect(result.errors).toContain("NOT AS EXPECTED")
  })
})

describe("refusals before any host", () => {
  test("a failed sandbox self-test refuses the probe and starts no host", async () => {
    const stand = standIn()
    const result = await runProbe({ ...stand.hooks, selfTest: async () => selfTestVerdict({ control: "connected", loopback: "connected", external: [{ target: "1.1.1.1:443", outcome: "connected" }] }) })
    expect(result.code).toBe(1)
    expect(result.errors).toContain("REFUSED — the sandbox self-test failed")
    expect(stand.started).toEqual([])
    expect(existsSync(join(result.out, EVIDENCE_FILE))).toBe(false)
  })

  test("a platform other than macOS refuses the probe and starts no host", async () => {
    const stand = standIn()
    const result = await runProbe(stand.hooks, { platform: "linux" })
    expect(result.code).toBe(1)
    expect(result.errors).toContain("runs only on macOS")
    expect(stand.started).toEqual([])
  })
})

describe("the journal is read defensively", () => {
  test("a torn trailing line is named, not thrown", async () => {
    const root = await temp()
    await writeFile(join(root, JOURNAL_FILE), '{"type":"issued","physicalId":"a"}\n{"type":"sett')
    const read = await journalLines(root)
    expect(read.lines.length).toBe(1)
    expect(read.problems).toEqual([expect.stringContaining("line 2 of the journal could not be parsed")])
  })
})

describe("main: the deadline and an incomplete run", () => {
  async function quiet<T>(run: () => Promise<T>): Promise<{ value: T; errors: string }> {
    const errors: string[] = []
    const original = { log: console.log, error: console.error }
    console.log = () => {}
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "))
    try {
      return { value: await run(), errors: errors.join("\n") }
    } finally {
      console.log = original.log
      console.error = original.error
    }
  }

  test("a body that never settles: exit 1, the deadline message, no evidence, the live host stopped once, the scratch removed", async () => {
    const root = await temp()
    const out = join(root, "out")
    const scratchDir = join(root, "scratch-made")
    await mkdir(scratchDir)
    let hostStops = 0
    let serverStops = 0
    const host = { stop: async (): Promise<StopOutcome> => ((hostStops += 1), { confirmed: true, pid: 7, how: "exited" }) }
    const { value: code, errors } = await quiet(() =>
      main(["bun", "x", "--out", out], {
        deadlineMs: 50,
        settleMs: 20,
        scratchRoot: join(root, "no-such-scratch"),
        body: (_args, scratch, live, servers) => {
          scratch.push(scratchDir)
          live.add(host)
          servers.push({ stop: () => (serverStops += 1) })
          return new Promise<number>(() => {})
        },
      }),
    )
    expect(code).toBe(1)
    expect(errors).toContain("the probe did not finish within 50 ms. NOTHING ABOVE IS A COMPLETE MEASUREMENT.")
    expect(existsSync(join(out, EVIDENCE_FILE))).toBe(false)
    expect(existsSync(scratchDir)).toBe(false)
    expect(hostStops).toBe(1)
    expect(serverStops).toBe(1)
  })

  test("a host stop the deadline cleanup cannot confirm is named, and the exit stays non-zero", async () => {
    const root = await temp()
    const host = { stop: async (): Promise<StopOutcome> => ({ confirmed: false, pid: 99, why: "no exit" }) }
    const { value: code, errors } = await quiet(() =>
      main(["bun", "x", "--out", join(root, "out")], {
        deadlineMs: 20,
        settleMs: 20,
        scratchRoot: join(root, "no-such-scratch"),
        body: (_args, _scratch, live) => {
          live.add(host)
          return new Promise<number>(() => {})
        },
      }),
    )
    expect(code).toBe(1)
    expect(errors).toContain("check process 99 by hand")
  })

  test("a run that records no host identity is INCOMPLETE and writes no evidence", async () => {
    const stand = standIn()
    const hooks: ProbeHooks = {
      ...stand.hooks,
      startHost: async (_context, given) => {
        stand.started.push(given)
        return { url: "http://127.0.0.1:1", stop: async () => ({ confirmed: true, pid: 1, how: "exited", postStop: { held: [], problems: [] } }) }
      },
    }
    const result = await runProbe(hooks)
    expect(result.code).toBe(1)
    expect(result.errors).toContain("INCOMPLETE — no host identity was recorded")
    expect(existsSync(join(result.out, EVIDENCE_FILE))).toBe(false)
  })
})
