import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z, type ZodType } from "zod"

import type { OpencodeBackendOptions } from "../adapters/opencode/model-backend.ts"
import { startRefusingProxy } from "../ablation/accounting-stub.ts"
import { startAdversarialStub, type AdversarialStub } from "../ablation/adversarial-stub.ts"
import { ADVERSARIAL_ATTEMPT_ALLOWANCES } from "../ablation/governor.ts"
import { MEASURED_HOST, type ManagedHostOptions, type ManagedHostStart, type StopOutcome } from "../ablation/managed-host.ts"
import { authLinkPaths } from "../ablation/oauth-payload.ts"
import { frozenV3Copy } from "../ablation/adversarial-read.fixture.ts"
import { ADVERSARIAL_PROTOCOL, ADVERSARIAL_RUN, PAIRED_GATES, type AdversarialRun } from "../ablation/paired-gates.ts"
import { readFrozenProtocol } from "../ablation/schedule.ts"
import type { Envelope, ModelBackend } from "../core/ports/model-backend.ts"
import { candidate } from "../core/test-support/fakes.ts"
import {
  boundedStart,
  calibrate,
  cancelClaims,
  claimsFor,
  EVIDENCE_FILE,
  extraRequests,
  frozenProtocolFixture,
  healthyClaims,
  HostOwner,
  hostOfferClaims,
  hostStopClaims,
  integrityBeforeStartClaims,
  integrityInjectedClaims,
  main,
  manyFindings,
  nonEndingClaims,
  noUsageObservations,
  offeredNamesClaim,
  parseProbeArgs,
  pathProblems,
  rootAllowanceClaims,
  rosterClaim,
  runAllowanceClaims,
  runScenario,
  scenarioBound,
  HANG_TURN_MS,
  LIMITATIONS,
  NO_USAGE_TURN_MS,
  SCENARIOS,
  seededAttempts,
  gate11Statement,
  shippedClaims,
  shippedDecision,
  shippedUnprobedClaims,
  SUITE_ALLOWANCE_CLAIM,
  TRANSPORTS,
  UNPROBED_TRANSPORTS,
  type CallFact,
  type Claim,
  type HostFact,
  type IssuedFact,
  type ProbeContext,
  type ShippedBarrier,
  type ProbeSeams,
  type RequestFact,
  type ScenarioFacts,
  type ScenarioKind,
  type ScenarioSpec,
  type Transport,
} from "./adversarial-probe.ts"
import { ADVERSARIAL_TURN_TIMEOUT_MS, PROTOCOL_V3_FILE } from "./adversarial.ts"
import { REPO_ROOT } from "./paired.ts"
import { placeholderAuth } from "./oauth-probe.ts"

const scratch: string[] = []
const stoppers: { stop(): unknown }[] = []
afterEach(async () => {
  for (const entry of stoppers.splice(0)) await entry.stop()
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "mad-adversarial-probe-test-")))
  scratch.push(dir)
  return dir
}

/**
 * The production reservation's state and content, read only. Run 1 used it and
 * it is committed, so a test captures it before it runs and asserts it is
 * unchanged after: no test modifies, deletes or creates it.
 */
async function productionReservation(): Promise<{ state: "absent" } | { state: "file"; content: string } | { state: "other" }> {
  const path = join(REPO_ROOT, ADVERSARIAL_RUN.reservation)
  try {
    const info = await lstat(path)
    return info.isFile() ? { state: "file", content: await readFile(path, "utf8") } : { state: "other" }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" }
    throw error
  }
}

const PIN = "anthropic/claude-sonnet-5"
/** The committed table with gate 10 CLOSED again, injected: the table as it stood while run 1's authorization was unused. */
const gate10Closed = PAIRED_GATES.map((gate) => (gate.number === 10 ? { ...gate, status: "CLOSED" as const, evidence: "injected by scripts/adversarial-probe.test.ts" } : gate))
const verdictOf = (claims: readonly Claim[], id: string) => claims.find((entry) => entry.id === id)?.verdict
const whyOf = (claims: readonly Claim[], id: string) => claims.find((entry) => entry.id === id)?.why ?? ""

// ---------------------------------------------------------------------------
// Facts, built by hand
// ---------------------------------------------------------------------------

const hostRun = (position: number, overrides: Partial<Record<HostFact["event"], Partial<HostFact>>> = {}): HostFact[] =>
  (["start", "verify", "stop", "postStop"] as const).map((event) => ({ event, ok: true, position, detail: `${event} of run ${position}`, ...overrides[event] }))

const issuedLine = (index: number, position: number, extra: Partial<IssuedFact> = {}): IssuedFact => ({
  physicalId: `request-${index}`,
  position,
  settlements: 1,
  kind: "usage",
  abandoned: false,
  executionId: false,
  ...extra,
})

const call = (position: number, at: number, extra: Partial<CallFact> = {}): CallFact => ({
  position,
  startedAt: at,
  endedAt: at + 50,
  unsettledAtEntry: 1,
  entryId: null,
  entryRunId: null,
  entryPosition: null,
  disposition: "ok",
  failure: null,
  usageUnknown: false,
  abandoned: false,
  ...extra,
})

const request = (index: number, position: number, atMs: number, extra: Partial<RequestFact> = {}): RequestFact => ({
  index,
  provider: "anthropic",
  method: "POST",
  path: "/v1/messages",
  model: true,
  authHeaderPresent: true,
  offered: ["mcp_StructuredOutput"],
  stage: "discover",
  toolResult: null,
  served: "answer",
  atMs,
  position,
  closedAfterMs: null,
  unsettledAtArrival: 1,
  arrivalId: null,
  ...extra,
})

function facts(kind: ScenarioKind, extra: Partial<ScenarioFacts> = {}): ScenarioFacts {
  return {
    kind,
    refused: null,
    complete: false,
    halt: null,
    stop: null,
    haltMarker: false,
    startMarker: true,
    slots: [],
    overshoot: { root: 0, suite: 0, runs: [] },
    integrity: [],
    refusals: [],
    seeded: { issued: 0, unsettled: 0 },
    issued: [],
    journalProblems: [],
    calls: [],
    maxConcurrentCalls: 0,
    requests: [],
    hosts: { starts: 0, records: [], unestablished: [], recordFailure: null },
    injected: null,
    cancelled: false,
    unofferedTool: null,
    unsafe: [],
    deadline: null,
    turnTimeoutMs: null,
    egress: [],
    elapsedMs: 1,
    ...extra,
  }
}

/** A suite of `runs` completed runs, one attempt each. */
function healthy(runs = 16, extra: Partial<ScenarioFacts> = {}): ScenarioFacts {
  const positions = Array.from({ length: runs }, (_unused, index) => index + 1)
  return facts("healthy", {
    complete: runs === 16,
    slots: Array.from({ length: 16 }, (_unused, index) => ({ position: index + 1, status: index < runs ? "completed" : "not-attempted", reason: "" })),
    overshoot: { root: 0, suite: 0, runs: positions.map(() => 0) },
    issued: positions.map((position) => issuedLine(position, position)),
    calls: positions.map((position) => call(position, position * 1000, { entryId: `request-${position}`, entryRunId: `run-${position}`, entryPosition: position })),
    maxConcurrentCalls: 1,
    requests: positions.map((position) => request(position, position, position * 1000 + 10, { arrivalId: `request-${position}` })),
    hosts: { starts: runs, records: positions.flatMap((position) => hostRun(position)), unestablished: [], recordFailure: null },
    ...extra,
  })
}

describe("the healthy suite's claims", () => {
  test("sixteen clean runs hold every claim", () => {
    const claims = healthyClaims(healthy(), PIN)
    expect(claims.map((entry) => entry.verdict)).toEqual(Array.from({ length: 7 }, () => "HOLDS"))
    expect(claims.map((entry) => entry.id)).toEqual(["roster", "journal-before-issue", "counted-once", "serial-no-overshoot", "stop-confirmed", "post-stop-clean", "full-suite"])
  })

  test("a post-stop failure after run 1 fails the guard and the full suite, and the journal claims hold only for the run observed", () => {
    const one = healthy(1, {
      hosts: { starts: 1, records: hostRun(1, { postStop: { ok: false, detail: "FAILED: session=1" } }), unestablished: ["run 1"], recordFailure: null },
      slots: [{ position: 1, status: "failed", reason: "stop not established" }, ...Array.from({ length: 15 }, (_unused, index) => ({ position: index + 2, status: "not-attempted", reason: "" }))],
    })
    const claims = healthyClaims(one, PIN)
    expect(verdictOf(claims, "post-stop-clean")).toBe("FAILS")
    expect(verdictOf(claims, "stop-confirmed")).toBe("HOLDS")
    expect(verdictOf(claims, "full-suite")).toBe("FAILS")
    expect(whyOf(claims, "full-suite")).toContain("the post-stop check of run 1's host failed")
    for (const id of ["journal-before-issue", "counted-once", "serial-no-overshoot"]) {
      expect(verdictOf(claims, id), id).toBe("HOLDS")
      expect(whyOf(claims, id), id).toContain("0 of 16 runs completed")
    }
  })

  test("an observation that found no unsettled issued line fails journal-before-issue", () => {
    const broken = healthy()
    broken.requests[4]!.unsettledAtArrival = 0
    expect(verdictOf(healthyClaims(broken, PIN), "journal-before-issue")).toBe("FAILS")
    const unread = healthy()
    unread.calls[2]!.unsettledAtEntry = null
    expect(whyOf(healthyClaims(unread, PIN), "journal-before-issue")).toContain("could not be read")
  })

  test("a count of one does not certify the line: a stale, reused, wrong-run, ambiguous or twice-settled line each fails", () => {
    const why = (mutate: (seen: ScenarioFacts) => void) => {
      const seen = healthy()
      mutate(seen)
      const claims = healthyClaims(seen, PIN)
      expect(verdictOf(claims, "journal-before-issue")).toBe("FAILS")
      return whyOf(claims, "journal-before-issue")
    }
    // Stale: one unsettled line, and it is not one this scenario issued.
    expect(why((seen) => (seen.calls[3]!.entryId = "probe-seed-open"))).toContain("call 4 (run 4): the unsettled line at entry is not one this scenario issued")
    // Reused: call 6 sees the line call 5 saw.
    expect(why((seen) => (seen.calls[5]!.entryId = "request-5"))).toContain("call 6 (run 6): the unsettled line at entry was already call 5's (reused)")
    // Wrong run: the line belongs to run 2, the call to run 7.
    expect(why((seen) => (seen.calls[6]!.entryPosition = 2))).toContain("belongs to run 2, not to this call's run")
    expect(why((seen) => (seen.calls[6]!.entryPosition = null))).toContain("belongs to no run the suite reported")
    // Ambiguous: two unsettled lines, so no identity.
    expect(
      why((seen) => {
        seen.calls[0]!.unsettledAtEntry = 2
        seen.calls[0]!.entryId = null
      }),
    ).toContain("2 unsettled issued lines at entry, so which is this attempt's is ambiguous")
    // The request found another line than its call did.
    expect(why((seen) => (seen.requests[8]!.arrivalId = "request-1"))).toContain("request 9: the unsettled line when it reached the stub is not the one call 9 (run 9) saw at entry")
    // The line was settled twice, or never.
    expect(why((seen) => (seen.issued[10]!.settlements = 2))).toContain("its line has 2 settlements, not one")
    // A request in no call's window is not identified.
    expect(why((seen) => (seen.requests[2]!.atMs = 500_000))).toContain("request 3: it falls in no `runTurn` call's window")
  })

  test("the holding verdict says how many distinct lines it bound, and that request attribution has limits", () => {
    const text = whyOf(healthyClaims(healthy(), PIN), "journal-before-issue")
    expect(text).toContain("16 distinct physical ids")
    expect(text).toContain("bound to its call's run by the suite's slot report")
    expect(text).toContain("evidence with limits")
  })

  test("a repeated id, a missing settlement or a call count that disagrees fails counted-once", () => {
    const repeated = healthy()
    repeated.issued[1]!.physicalId = repeated.issued[0]!.physicalId
    expect(verdictOf(healthyClaims(repeated, PIN), "counted-once")).toBe("FAILS")
    const unsettled = healthy()
    unsettled.issued[3]!.settlements = 0
    expect(verdictOf(healthyClaims(unsettled, PIN), "counted-once")).toBe("FAILS")
    const extraCall = healthy()
    extraCall.calls.push(call(16, 99_000))
    expect(whyOf(healthyClaims(extraCall, PIN), "counted-once")).toContain("17 `runTurn` calls")
  })

  test("two calls open at once, two unsettled lines, or any overshoot fails the serial claim", () => {
    expect(verdictOf(healthyClaims(healthy(16, { maxConcurrentCalls: 2 }), PIN), "serial-no-overshoot")).toBe("FAILS")
    const two = healthy()
    two.calls[0]!.unsettledAtEntry = 2
    expect(verdictOf(healthyClaims(two, PIN), "serial-no-overshoot")).toBe("FAILS")
    expect(verdictOf(healthyClaims(healthy(16, { overshoot: { root: 1, suite: 0, runs: [] } }), PIN), "serial-no-overshoot")).toBe("FAILS")
  })

  test("with no host started, every observation is UNPROBED and names what blocked it; the full suite FAILS", () => {
    const none = facts("healthy", { hosts: { starts: 1, records: [{ event: "start", ok: false, position: 1, detail: "the sandbox refused" }], unestablished: [], recordFailure: null } })
    const claims = healthyClaims(none, PIN)
    for (const id of ["roster", "journal-before-issue", "counted-once", "serial-no-overshoot", "stop-confirmed", "post-stop-clean"]) expect(verdictOf(claims, id), id).toBe("UNPROBED")
    expect(whyOf(claims, "roster")).toContain("the host of run 1 did not start")
    expect(verdictOf(claims, "full-suite")).toBe("FAILS")
  })

  test("a host that fails its verification fails the roster claim with the lifecycle's reason", () => {
    const failed = healthy(1, { hosts: { starts: 1, records: hostRun(1, { verify: { ok: false, detail: "the host lists no model claude-sonnet-5" } }), unestablished: [], recordFailure: null } })
    const roster = rosterClaim(failed, PIN)
    expect(roster.verdict).toBe("FAILS")
    expect(roster.why).toContain("lists no model")
  })

  test("an unconfirmed stop fails stop-confirmed and leaves post-stop a separate claim", () => {
    const [stop, post] = hostStopClaims(facts("healthy", { hosts: { starts: 1, records: hostRun(1, { stop: { ok: false, detail: "UNCONFIRMED pid 7" } }), unestablished: [], recordFailure: null } }))
    expect(stop!.verdict).toBe("FAILS")
    expect(stop!.why).toContain("UNCONFIRMED pid 7")
    expect(post!.verdict).toBe("HOLDS")
  })
})

describe("the run allowance's claims", () => {
  const reached = (extra: Partial<ScenarioFacts> = {}) =>
    facts("run-allowance", {
      slots: [{ position: 1, status: "failed", reason: "a gate denied it planned work: … (budget) …" }, ...Array.from({ length: 15 }, (_unused, index) => ({ position: index + 2, status: "completed", reason: "" }))],
      issued: Array.from({ length: 30 }, (_unused, index) => issuedLine(index, 1)),
      calls: Array.from({ length: 30 }, (_unused, index) => call(1, index * 100)),
      refusals: [
        { cause: "budget", position: 1 },
        { cause: "budget", position: 1 },
      ],
      hosts: { starts: 16, records: Array.from({ length: 16 }, (_unused, index) => hostRun(index + 1)).flat(), unestablished: [], recordFailure: null },
      ...extra,
    })

  test("thirty issued, budget refusals that reached no backend, the run failed and the rest completed", () => {
    expect(runAllowanceClaims(reached()).map((entry) => `${entry.id}:${entry.verdict}`)).toEqual([
      "run-cap-issued:HOLDS",
      "run-cap-refusal:HOLDS",
      "run-cap-fails-run:HOLDS",
      "run-cap-later-runs:HOLDS",
      "stop-confirmed:HOLDS",
      "post-stop-clean:HOLDS",
    ])
  })

  test("a refused attempt that entered the backend, or a refusal with another cause, fails the refusal claim", () => {
    const entered = reached()
    entered.calls.push(call(1, 9000))
    expect(verdictOf(runAllowanceClaims(entered), "run-cap-refusal")).toBe("FAILS")
    expect(verdictOf(runAllowanceClaims(reached({ refusals: [{ cause: "runner-stop", position: 1 }] })), "run-cap-refusal")).toBe("FAILS")
    expect(verdictOf(runAllowanceClaims(reached({ issued: Array.from({ length: 31 }, (_unused, index) => issuedLine(index, 1)) })), "run-cap-issued")).toBe("FAILS")
  })

  test("later runs blocked by run 1's post-stop check are UNPROBED, naming it; stopped for no such reason they FAIL", () => {
    const blocked = reached({
      slots: [{ position: 1, status: "failed", reason: "(budget)" }, ...Array.from({ length: 15 }, (_unused, index) => ({ position: index + 2, status: "not-attempted", reason: "" }))],
      hosts: { starts: 1, records: hostRun(1, { postStop: { ok: false, detail: "FAILED: session=2" } }), unestablished: [], recordFailure: null },
    })
    const claims = runAllowanceClaims(blocked)
    expect(verdictOf(claims, "run-cap-later-runs")).toBe("UNPROBED")
    expect(whyOf(claims, "run-cap-later-runs")).toContain("the post-stop check of run 1's host failed")
    expect(verdictOf(claims, "post-stop-clean")).toBe("FAILS")
    const stopped = reached({ slots: [{ position: 1, status: "failed", reason: "(budget)" }, ...Array.from({ length: 15 }, (_unused, index) => ({ position: index + 2, status: "not-attempted", reason: "" }))], stop: "something else" })
    expect(verdictOf(runAllowanceClaims(stopped), "run-cap-later-runs")).toBe("FAILS")
  })

  test("an allowance never reached fails the issued claim and leaves the refusal claims UNPROBED", () => {
    const short = reached({ refusals: [], issued: [issuedLine(1, 1)], calls: [call(1, 0)] })
    const claims = runAllowanceClaims(short)
    expect(verdictOf(claims, "run-cap-issued")).toBe("FAILS")
    expect(verdictOf(claims, "run-cap-refusal")).toBe("UNPROBED")
    expect(verdictOf(runAllowanceClaims({ ...short, deadline: "the scenario did not end" }), "run-cap-issued")).toBe("UNPROBED")
  })
})

describe("the root allowance's claims, and the suite allowance", () => {
  const stopped = (extra: Partial<ScenarioFacts> = {}) =>
    facts("root-allowance", {
      stop: "the suite root's global allowance is exhausted: 480 of 480 admitted attempts",
      seeded: { issued: 480, unsettled: 0 },
      slots: [{ position: 1, status: "failed", reason: "" }, ...Array.from({ length: 15 }, (_unused, index) => ({ position: index + 2, status: "not-attempted", reason: "" }))],
      hosts: { starts: 1, records: hostRun(1), unestablished: [], recordFailure: null },
      ...extra,
    })

  test("a runner stop naming the root's 480, with no backend call, no request and no later host", () => {
    expect(rootAllowanceClaims(stopped()).every((entry) => entry.verdict === "HOLDS")).toBe(true)
  })

  test("a backend call, a model request, a second host or another stop each fail their claim", () => {
    expect(verdictOf(rootAllowanceClaims(stopped({ calls: [call(1, 0)] })), "root-cap-no-backend")).toBe("FAILS")
    expect(verdictOf(rootAllowanceClaims(stopped({ requests: [request(1, 1, 5)] })), "root-cap-no-backend")).toBe("FAILS")
    expect(verdictOf(rootAllowanceClaims(stopped({ hosts: { starts: 2, records: [...hostRun(1), ...hostRun(2)], unestablished: [], recordFailure: null } })), "root-cap-later-slots")).toBe("FAILS")
    expect(verdictOf(rootAllowanceClaims(stopped({ stop: "the adversarial suite's allowance is exhausted: 480 of 480 admitted attempts" })), "root-cap-stop")).toBe("FAILS")
    expect(verdictOf(rootAllowanceClaims(stopped({ seeded: { issued: 479, unsettled: 0 } })), "root-cap-seeded")).toBe("FAILS")
  })

  test("a suite that was refused before it started fails the stop claim", () => {
    expect(verdictOf(rootAllowanceClaims(facts("root-allowance", { refused: "the schedule could not be sealed" })), "root-cap-stop")).toBe("FAILS")
  })

  test("the suite allowance is UNPROBED by construction, citing the gate and its scripted test", () => {
    expect(SUITE_ALLOWANCE_CLAIM.verdict).toBe("UNPROBED")
    expect(SUITE_ALLOWANCE_CLAIM.why).toContain("ablation/governor.ts")
    expect(SUITE_ALLOWANCE_CLAIM.why).toContain("ablation/governor.test.ts")
    expect(ADVERSARIAL_ATTEMPT_ALLOWANCES.global).toBe(ADVERSARIAL_ATTEMPT_ALLOWANCES.suite)
  })
})

describe("a non-ending attempt, and a cancellation in flight", () => {
  const hung = (extra: Partial<ScenarioFacts> = {}) =>
    facts("non-ending", {
      halt: "attempt `request-1` did not end within its bound",
      haltMarker: true,
      turnTimeoutMs: 5000,
      issued: [issuedLine(1, 1, { kind: "unknown", abandoned: true, executionId: true })],
      calls: [call(1, 1000, { endedAt: 6030, disposition: "failed", failure: "transport-error", usageUnknown: true, abandoned: true })],
      requests: [request(1, 1, 10, { served: "hang", closedAfterMs: 5010 })],
      hosts: { starts: 1, records: hostRun(1), unestablished: [], recordFailure: null },
      ...extra,
    })

  test("settled abandoned within its bound, counted once, halted, the connection closed, nothing later", () => {
    expect(nonEndingClaims(hung()).every((entry) => entry.verdict === "HOLDS")).toBe(true)
  })

  test("past the bound, not abandoned, no marker, an open connection or a later request each fail", () => {
    expect(verdictOf(nonEndingClaims(hung({ calls: [call(1, 0, { endedAt: 10_001 })] })), "abandoned-within-bound")).toBe("FAILS")
    expect(verdictOf(nonEndingClaims(hung({ issued: [issuedLine(1, 1, { kind: "unknown" })] })), "abandoned-within-bound")).toBe("FAILS")
    expect(verdictOf(nonEndingClaims(hung({ haltMarker: false })), "halt-and-marker")).toBe("FAILS")
    expect(verdictOf(nonEndingClaims(hung({ requests: [request(1, 1, 10, { served: "hang" })] })), "connection-closed")).toBe("FAILS")
    expect(verdictOf(nonEndingClaims(hung({ requests: [request(1, 1, 10, { served: "hang", closedAfterMs: 1 }), request(2, 2, 9000)] })), "nothing-later")).toBe("FAILS")
    expect(verdictOf(nonEndingClaims(hung({ hosts: { starts: 1, records: hostRun(1, { stop: { ok: false, detail: "UNCONFIRMED" } }), unestablished: [], recordFailure: null } })), "stop-confirmed")).toBe("FAILS")
  })

  test("with no attempt issued the claim is UNPROBED, and FAILS when the suite itself refused", () => {
    expect(verdictOf(nonEndingClaims(facts("non-ending")), "abandoned-within-bound")).toBe("UNPROBED")
    expect(verdictOf(nonEndingClaims(facts("non-ending", { refused: "refused" })), "abandoned-within-bound")).toBe("FAILS")
  })

  const cancelled = (extra: Partial<ScenarioFacts> = {}) => hung({ kind: "cancel-in-flight", cancelled: true, ...extra })

  test("the in-flight attempt counts one; with no not-issued settlement that claim is UNPROBED and cites the scripted test", () => {
    const claims = cancelClaims(cancelled())
    expect(verdictOf(claims, "cancelled-counts-one")).toBe("HOLDS")
    expect(verdictOf(claims, "halt-and-marker")).toBe("HOLDS")
    expect(verdictOf(claims, "not-issued-release")).toBe("UNPROBED")
    expect(whyOf(claims, "not-issued-release")).toContain("ablation/journal-adversarial.test.ts")
  })

  test("a not-issued settlement that was seen is reported, and it is not a counted attempt", () => {
    const seen = cancelled({ issued: [issuedLine(1, 1, { kind: "unknown", abandoned: true }), issuedLine(2, 1, { kind: "not-issued" })] })
    const claims = cancelClaims(seen)
    expect(verdictOf(claims, "not-issued-release")).toBe("HOLDS")
    expect(verdictOf(claims, "cancelled-counts-one")).toBe("HOLDS")
  })

  test("two counted attempts fail; a signal that was never set leaves the claim UNPROBED", () => {
    expect(verdictOf(cancelClaims(cancelled({ issued: [issuedLine(1, 1), issuedLine(2, 1)] })), "cancelled-counts-one")).toBe("FAILS")
    expect(verdictOf(cancelClaims(cancelled({ cancelled: false })), "cancelled-counts-one")).toBe("UNPROBED")
  })
})

describe("the integrity rows", () => {
  test("a suite refused as halted with nothing started holds; a start marker or a host fails", () => {
    const refused = facts("integrity-before-start", { refused: "the experiment is already halted, so the adversarial schedule was not started", startMarker: false })
    expect(integrityBeforeStartClaims(refused).every((entry) => entry.verdict === "HOLDS")).toBe(true)
    expect(verdictOf(integrityBeforeStartClaims({ ...refused, startMarker: true }), "nothing-started")).toBe("FAILS")
    expect(verdictOf(integrityBeforeStartClaims({ ...refused, hosts: { starts: 1, records: [], unestablished: [], recordFailure: null } }), "nothing-started")).toBe("FAILS")
    expect(verdictOf(integrityBeforeStartClaims(facts("integrity-before-start")), "refused-as-halted")).toBe("FAILS")
  })

  const injected = (extra: Partial<ScenarioFacts> = {}) =>
    facts("integrity-injected", {
      halt: "integrity failure: execution `run-1/exec-1` was reported late with two different token payloads",
      haltMarker: true,
      injected: { reported: true, why: "reported" },
      integrity: [{ reason: "two different token payloads", payloads: 2 }],
      issued: [issuedLine(1, 1, { kind: "unknown", executionId: true })],
      calls: [call(1, 0, { disposition: "failed", failure: "model-error", usageUnknown: true })],
      requests: [request(1, 1, 5, { served: "http-400" })],
      refusals: [{ cause: "halted", position: 1 }],
      hosts: { starts: 1, records: hostRun(1), unestablished: [], recordFailure: null },
      ...extra,
    })

  test("the injected conflict holds every claim, and is labelled injected", () => {
    const claims = integrityInjectedClaims(injected())
    expect(claims.every((entry) => entry.verdict === "HOLDS")).toBe(true)
    expect(claims.find((entry) => entry.id === "conflict-recorded")!.claim).toContain("INJECTED by the probe")
  })

  test("a conflict that does not halt FAILS, and so does a retry that entered the backend", () => {
    expect(verdictOf(integrityInjectedClaims(injected({ halt: null, haltMarker: false })), "halt-and-marker")).toBe("FAILS")
    const retried = injected()
    retried.calls.push(call(1, 500))
    retried.requests.push(request(2, 1, 505))
    const claims = integrityInjectedClaims(retried)
    expect(verdictOf(claims, "retry-refused")).toBe("FAILS")
    expect(verdictOf(claims, "nothing-later")).toBe("FAILS")
    expect(verdictOf(integrityInjectedClaims(injected({ integrity: [] })), "conflict-recorded")).toBe("FAILS")
    expect(verdictOf(integrityInjectedClaims(injected({ issued: [issuedLine(1, 1, { kind: "unknown", abandoned: true, executionId: true })] })), "unknown-binds-id")).toBe("FAILS")
  })

  test("retry-refused needs a halted refusal of that run: none, or only another run's, leaves it UNPROBED with the narrower observation", () => {
    const none = integrityInjectedClaims(injected({ refusals: [] }))
    expect(verdictOf(none, "retry-refused")).toBe("UNPROBED")
    expect(whyOf(none, "retry-refused")).toContain("no second backend entry or request was observed")
    expect(whyOf(none, "retry-refused")).toContain("no admission of run 1 was recorded refused `halted`")
    const other = integrityInjectedClaims(injected({ refusals: [{ cause: "halted", position: 2 }] }))
    expect(verdictOf(other, "retry-refused")).toBe("UNPROBED")
    expect(whyOf(other, "retry-refused")).toContain("1 refusal recorded for other runs or causes")
    expect(verdictOf(integrityInjectedClaims(injected({ refusals: [{ cause: "budget", position: 1 }] })), "retry-refused")).toBe("UNPROBED")
    expect(whyOf(integrityInjectedClaims(injected()), "retry-refused")).toBe("1 admission of run 1 refused `halted`, with 1 `runTurn` call and 1 model request in all")
  })

  test("reports that were never made fail the row with the reason, never UNPROBED", () => {
    const claims = integrityInjectedClaims(injected({ injected: { reported: false, why: "the HTTP 400 envelope carried a token figure" } }))
    expect(verdictOf(claims, "conflict-recorded")).toBe("FAILS")
    expect(whyOf(claims, "conflict-recorded")).toContain("carried a token figure")
  })
})

describe("the host offer's claims (protocol v3 B8)", () => {
  const offer = (result: RequestFact["toolResult"] | undefined, extra: Partial<ScenarioFacts> = {}) =>
    facts("host-offer", {
      calls: [call(1, 0)],
      requests: [request(1, 1, 5, { served: "unoffered-tool" }), ...(result === undefined ? [] : [request(2, 1, 20, { toolResult: result })])],
      hosts: { starts: 1, records: hostRun(1), unestablished: [], recordFailure: null },
      ...extra,
    })

  test("an explicit rejection with no canary holds all five claims", () => {
    const claims = hostOfferClaims(offer({ isError: true, namesUnavailableTool: true, canary: false }))
    expect(claims.slice(0, 5).map((entry) => `${entry.id}:${entry.verdict}`)).toEqual([
      "offered-names:HOLDS",
      "treatment:HOLDS",
      "canary-nondisclosure:HOLDS",
      "not-executed:HOLDS",
      "structured-output-usable:HOLDS",
    ])
    expect(whyOf(claims, "treatment")).toContain("rejection")
    expect(whyOf(hostOfferClaims(offer({ isError: true, namesUnavailableTool: true, canary: false }, { unofferedTool: "mcp_Read" })), "treatment")).toContain("`mcp_Read`")
  })

  test("a canary token in the continuation fails nondisclosure and not-executed", () => {
    const claims = hostOfferClaims(offer({ isError: false, namesUnavailableTool: false, canary: true }))
    expect(verdictOf(claims, "canary-nondisclosure")).toBe("FAILS")
    expect(whyOf(claims, "canary-nondisclosure")).toContain("a forbidden read result reached the provider")
    expect(verdictOf(claims, "not-executed")).toBe("FAILS")
  })

  test("no token and no rejection: nondisclosure holds narrowly, not-executed is UNPROBED", () => {
    const claims = hostOfferClaims(offer({ isError: true, namesUnavailableTool: false, canary: false }))
    expect(verdictOf(claims, "canary-nondisclosure")).toBe("HOLDS")
    expect(verdictOf(claims, "not-executed")).toBe("UNPROBED")
    expect(whyOf(claims, "not-executed")).toContain("no adequate execution witness")
  })

  test("no continuation leaves nondisclosure and not-executed UNPROBED and keeps the offered names", () => {
    const claims = hostOfferClaims(offer(undefined))
    expect(verdictOf(claims, "offered-names")).toBe("HOLDS")
    expect(verdictOf(claims, "treatment")).toBe("UNPROBED")
    expect(verdictOf(claims, "canary-nondisclosure")).toBe("UNPROBED")
    expect(verdictOf(claims, "not-executed")).toBe("UNPROBED")
  })

  test("a second offered tool fails the offered names; a turn that did not complete fails usability", () => {
    const wide = offer({ isError: true, namesUnavailableTool: true, canary: false })
    wide.requests[1]!.offered = ["mcp_StructuredOutput", "mcp_Read"]
    expect(verdictOf(hostOfferClaims(wide), "offered-names")).toBe("FAILS")
    expect(verdictOf(hostOfferClaims(offer({ isError: true, namesUnavailableTool: true, canary: false }, { calls: [call(1, 0, { disposition: "failed", failure: "model-error" })] })), "structured-output-usable")).toBe("FAILS")
  })

  test("the offer is checked request by request: an empty offer on a prompt is not masked by another request's", () => {
    // Request 1 offers the tool; request 2, a prompt continuation of the same call, offers nothing.
    const masked = offer({ isError: true, namesUnavailableTool: true, canary: false })
    masked.requests[1]!.offered = []
    const claim = offeredNamesClaim(masked)
    expect(claim.verdict).toBe("FAILS")
    expect(claim.why).toContain("request 2 is a prompt that offered no tool")
    // A prompt-stage request with an empty offer and no tool result fails too.
    const bare = offer(undefined)
    bare.requests[0]!.offered = []
    expect(offeredNamesClaim(bare).why).toContain("request 1 is a prompt that offered no tool")
    // A wider offer names the request and the tools.
    const wide = offer({ isError: true, namesUnavailableTool: true, canary: false })
    wide.requests[0]!.offered = ["mcp_StructuredOutput", "mcp_Bash"]
    expect(offeredNamesClaim(wide).why).toContain("request 1 offered bash, structuredoutput")
  })

  test("a host-side request is outside the claim only beside a prompt of its call that carries the offer, and is counted apart", () => {
    const withSide = facts("host-offer", {
      calls: [call(1, 0, { endedAt: 400 })],
      requests: [request(1, 1, 5), request(2, 1, 50, { offered: [], stage: "side", served: "side-text" })],
    })
    const held = offeredNamesClaim(withSide)
    expect(held.verdict).toBe("HOLDS")
    expect(held.why).toContain("each of 1 prompt request offered exactly structuredoutput")
    expect(held.why).toContain("1 host-side request offered no tool")
    // The same empty offer with no prompt of its call carrying the tool is a failure, not a side request.
    const alone = facts("host-offer", { calls: [call(1, 0, { endedAt: 400 })], requests: [request(1, 1, 50, { offered: [], stage: "side", served: "side-text" })] })
    expect(offeredNamesClaim(alone).verdict).toBe("FAILS")
    expect(offeredNamesClaim(alone).why).toContain("no request of its call carried the offer")
    expect(offeredNamesClaim(facts("host-offer")).verdict).toBe("UNPROBED")
  })

  test("usability and offered names stay visible when a later cleanup fails", () => {
    const claims = hostOfferClaims(offer({ isError: true, namesUnavailableTool: true, canary: false }, { hosts: { starts: 1, records: hostRun(1, { postStop: { ok: false, detail: "FAILED" } }), unestablished: [], recordFailure: null } }))
    expect(verdictOf(claims, "structured-output-usable")).toBe("HOLDS")
    expect(verdictOf(claims, "offered-names")).toBe("HOLDS")
    expect(verdictOf(claims, "post-stop-clean")).toBe("FAILS")
  })
})

describe("extra requests, and the observation row", () => {
  test("a tool continuation, a re-send after a served failure and an unexplained request are told apart", () => {
    const observed = facts("host-offer", {
      calls: [call(1, 1000, { endedAt: 1300 }), call(2, 5000, { endedAt: 5300 }), call(3, 9000, { endedAt: 9300 })],
      requests: [
        request(1, 1, 10, { served: "unoffered-tool" }),
        request(2, 1, 100, { toolResult: { isError: true, namesUnavailableTool: true, canary: false } }),
        request(3, 2, 4010, { served: "http-500" }),
        request(4, 2, 4100),
        request(5, 3, 8010),
        request(6, 3, 8100),
      ],
    })
    const extras = extraRequests(observed, 1000)
    expect(extras.map((entry) => `${entry.requestIndex}:${entry.classification}`)).toEqual(["2:tool-continuation", "4:after-served-failure", "6:unexplained"])
    expect(extras[1]!.why).toContain("cause inside the host is not established")
  })

  test("a request that arrives just after a call returned belongs to the next call that was entered, not to the one before", () => {
    // Two attempts of one run 300 ms apart, well inside the attribution slack: one request each, and no extra.
    const observed = facts("healthy", {
      calls: [call(1, 1000, { endedAt: 1200 }), call(1, 1500, { endedAt: 1700 })],
      requests: [request(1, 1, 10), request(2, 1, 510)],
    })
    expect(extraRequests(observed, 1000)).toEqual([])
    // A request before any call was entered is attributed to none.
    expect(extraRequests(facts("healthy", { calls: [call(1, 5000)], requests: [request(1, 1, 10)] }), 1000)).toEqual([])
  })

  test("the stream-without-usage row states what was seen and makes no verdict", () => {
    const observed = facts("stream-without-usage", {
      turnTimeoutMs: 20_000,
      halt: "did not end within its bound",
      issued: [issuedLine(1, 1, { kind: "unknown", abandoned: true })],
      calls: [call(1, 0, { endedAt: 20_040, disposition: "failed", failure: "transport-error", abandoned: true })],
      requests: [1, 2, 3, 4].map((index) => request(index, 1, index * 5000, { served: "no-usage" })),
      hosts: { starts: 1, records: hostRun(1), unestablished: [], recordFailure: null },
    })
    expect(claimsFor(observed, PIN)).toEqual([])
    const lines = noUsageObservations(observed)
    expect(lines[0]).toContain("1 attempt issued")
    expect(lines[0]).toContain("4 model requests")
    expect(lines[1]).toBe("at most 4 model requests arrived inside one `runTurn` call's window")
    expect(lines[2]).toContain("1 failed")
    expect(lines[2]).toContain("1 unknown (abandoned)")
    expect(lines.at(-1)).toContain("Repetition alone does not establish a host retry")
    expect(lines.at(-1)).toContain("not workload or quota evidence")
  })

  test("with one request per call the row says no re-send was seen", () => {
    const observed = facts("stream-without-usage", {
      issued: [issuedLine(1, 1), issuedLine(2, 2)],
      calls: [call(1, 0), call(2, 5000)],
      requests: [request(1, 1, 10, { served: "no-usage" }), request(2, 2, 5010, { served: "no-usage" })],
    })
    const lines = noUsageObservations(observed)
    expect(lines[1]).toContain("at most 1 model request")
    expect(lines.at(-1)).toContain("showed no re-send")
  })
})

/** Barriers a table with gate 10 OPEN and no pin gives; a stand-in for what the command would print. */
const BARRIERS: readonly ShippedBarrier[] = [
  { name: "stage 1", text: "REFUSED at stage 1", why: "the refusal is stage 1's" },
  { name: "gate 10", text: "gate 10 (adversarial spend authorization) is OPEN", why: "gate 10 is OPEN" },
  { name: "adversarial run", text: "ADVERSARIAL_RUN has no roster pin", why: "the pin is null" },
]

describe("whether the shipped command may be started", () => {
  const gate10Open = PAIRED_GATES.map((gate) => (gate.number === 10 ? { ...gate, status: "OPEN" as const, evidence: undefined } : gate))
  const unpinned: AdversarialRun = { ...ADVERSARIAL_RUN, pins: null }
  const names = (decision: Awaited<ReturnType<typeof shippedDecision>>) => (decision.spawn ? decision.barriers.map((barrier) => barrier.name) : null)

  test("on the committed table gate 10 is OPEN (its run-1 authorization is used), so the probe's one barrier is gate 10; the launcher's stage 1 also names the used reservation", async () => {
    const decision = await shippedDecision()
    expect(names(decision)).toEqual(["stage 1", "gate 10"])
    if (decision.spawn) expect(decision.barriers[1]!.text).toBe("gate 10 (adversarial spend authorization) is OPEN")
  })

  test("with gate 10 CLOSED, injected, and the committed run and protocol, nothing refuses, so it is not started", async () => {
    const decision = await shippedDecision({ gates: gate10Closed })
    expect(decision.spawn).toBe(false)
    if (!decision.spawn) {
      expect(decision.why).toContain("no offline refusal is established")
      expect(decision.why).toContain(`adversarial run ${ADVERSARIAL_RUN.run} is pinned to ${PIN}`)
      expect(decision.why).toContain("would use run 1's one authorization and start the live run, so the probe did not start it")
    }
  })

  test("gate 10 OPEN, or a run with no pin, is a barrier taken from the preflight's own problem", async () => {
    const open = await shippedDecision({ gates: gate10Open })
    expect(names(open)).toEqual(["stage 1", "gate 10"])
    if (open.spawn) expect(open.barriers[1]!.text).toBe("gate 10 (adversarial spend authorization) is OPEN")
    const noPin = await shippedDecision({ gates: gate10Closed, run: unpinned })
    expect(names(noPin)).toEqual(["stage 1", "adversarial run"])
    if (noPin.spawn) expect(noPin.barriers[1]!.text).toBe("ADVERSARIAL_RUN has no roster pin")
    expect(names(await shippedDecision({ gates: gate10Open, run: unpinned }))).toEqual(["stage 1", "gate 10", "adversarial run"])
    // A pin outside gate 11's evidence refuses too.
    expect(names(await shippedDecision({ gates: gate10Closed, run: { ...ADVERSARIAL_RUN, pins: ["openai/gpt-6-sol"] } }))).toEqual(["stage 1", "adversarial run"])
  })

  test("a protocol file that is unreadable, edited, malformed or not version 3 is a barrier with the reader's reason", async () => {
    const dir = await tempDir()
    const frozen = await readFile(PROTOCOL_V3_FILE, "utf8")
    const edited = join(dir, "edited.md")
    await writeFile(edited, frozen.replace("## B3. Allowances", "## B3. Allowances, edited"))
    const malformed = join(dir, "malformed.md")
    await writeFile(malformed, frozen.replace(/^status: frozen$/m, "status: draft"))
    const noVersion = join(dir, "no-version.md")
    await writeFile(noVersion, frozen.replace(/^version: 3$/m, "version: three"))
    for (const [protocolFile, why] of [
      [join(dir, "absent.md"), "could not be read"],
      [edited, "the frozen artefact was edited"],
      [malformed, "is not a frozen protocol"],
      [noVersion, "is not a frozen protocol"],
    ] as const) {
      const decision = await shippedDecision({ gates: gate10Closed, protocolFile })
      expect(names(decision), protocolFile).toEqual(["stage 1", "the protocol file"])
      if (decision.spawn) {
        expect(decision.barriers[1]!.text).toBe("protocol v3 is not frozen")
        expect(decision.barriers[1]!.why, protocolFile).toContain(why)
      }
    }
    const v2 = await shippedDecision({ gates: gate10Closed, protocolFile: PROTOCOL_V3_FILE.replace("evaluation-protocol-v3.md", "evaluation-protocol-v2.md") })
    expect(names(v2)).toEqual(["stage 1", "the protocol version"])
    if (v2.spawn) {
      expect(v2.barriers[1]!.text).toBe("the adversarial suite on the OAuth route needs protocol v3")
      expect(v2.barriers[1]!.why).toBe("the frozen protocol read is PROTOCOL-mad-evaluation-v2 v2")
    }
  })

  test("a validly frozen v3 whose hash is not the authorized one is a barrier naming both hashes, as stage 1 refuses it", async () => {
    const fixture = await frozenV3Copy(scratch)
    expect(fixture.hash).not.toBe(ADVERSARIAL_PROTOCOL.frozenHash)
    const decision = await shippedDecision({ gates: gate10Closed, protocolFile: fixture.file })
    expect(decision.spawn).toBe(true)
    expect(names(decision)).toEqual(["stage 1", "the protocol hash"])
    if (decision.spawn) {
      expect(decision.barriers[1]!.text).toBe("a re-frozen v3 is not the protocol the run was authorized under")
      expect(decision.barriers[1]!.why).toContain(fixture.hash)
      expect(decision.barriers[1]!.why).toContain(ADVERSARIAL_PROTOCOL.frozenHash)
    }
    // The committed protocol carries the authorized hash, so it alone refuses nothing.
    expect((await shippedDecision({ gates: gate10Closed, protocolFile: PROTOCOL_V3_FILE })).spawn).toBe(false)
  })

  test("`protocolHash` is the expected hash: honoured when it matches the protocol read, a barrier when it does not", async () => {
    const fixture = await frozenV3Copy(scratch)
    const honoured = await shippedDecision({ gates: gate10Closed, protocolFile: fixture.file, protocolHash: fixture.hash })
    expect(honoured.spawn).toBe(false)
    if (!honoured.spawn) expect(honoured.why).toContain("no offline refusal is established")
    const other = "f".repeat(64)
    expect(other).not.toBe(ADVERSARIAL_PROTOCOL.frozenHash)
    const decision = await shippedDecision({ gates: gate10Closed, protocolHash: other })
    expect(decision.spawn).toBe(true)
    expect(names(decision)).toEqual(["stage 1", "the protocol hash"])
    if (decision.spawn) {
      expect(decision.barriers[1]!.text).toBe("a re-frozen v3 is not the protocol the run was authorized under")
      expect(decision.barriers[1]!.why).toContain(ADVERSARIAL_PROTOCOL.frozenHash)
      expect(decision.barriers[1]!.why).toContain(other)
    }
  })

  test("a check that throws starts nothing, whatever else would have refused", async () => {
    const decision = await shippedDecision({
      gates: gate10Open,
      readProtocol: async () => {
        throw new Error("EIO")
      },
    })
    expect(decision).toEqual({ spawn: false, why: "whether the shipped command would refuse could not be established (EIO), so the probe did not start it" })
  })

  test("the row of a command that was not started is UNPROBED twice, with the reason", () => {
    const claims = shippedUnprobedClaims("not started, because")
    expect(claims.map((entry) => `${entry.id}:${entry.verdict}`)).toEqual(["shipped-refuses:UNPROBED", "shipped-writes-nothing:UNPROBED"])
    expect(claims.every((entry) => entry.why === "not started, because")).toBe(true)
  })
})

describe("the shipped command's claims", () => {
  const refusal = BARRIERS.map((barrier) => barrier.text).join("\n")
  const shippedClaimsFor = (run: Parameters<typeof shippedClaims>[0], leftovers: readonly string[], evidenceChanged: boolean) => shippedClaims(run, leftovers, evidenceChanged, BARRIERS)

  test("exit 1 naming every barrier, with nothing written, holds", () => {
    expect(shippedClaimsFor({ exitCode: 1, output: refusal, timedOut: false }, [], false).every((entry) => entry.verdict === "HOLDS")).toBe(true)
  })

  test("the claim names the barriers it was given, and gate 11 is none of them", () => {
    const [refuses] = shippedClaimsFor({ exitCode: 1, output: refusal, timedOut: false }, [], false)
    expect(refuses!.id).toBe("shipped-refuses")
    expect(refuses!.claim).toContain("exits 1 at stage 1 naming gate 10, adversarial run")
    expect(refuses!.claim).not.toContain("gate 11")
  })

  test("the evidence's gate-11 statement reports the table's status and scope, and claims no closure by the probe", () => {
    const eleven = PAIRED_GATES.find((gate) => gate.number === 11)!
    expect(gate11Statement()).toBe(
      `${eleven.status}, as ablation/paired-gates.ts records it, with an evidence scope of anthropic/claude-sonnet-5 (messages) and ` +
        "github-copilot/gpt-5-mini (chat-completions). This probe run closes nothing and is no verdict on the gate; its status and " +
        "scope change only by a reviewed change to that table.",
    )
    expect(gate11Statement()).toStartWith("CLOSED, as ablation/paired-gates.ts records it")
    // The status is read, never asserted: a table that re-opens the gate is reported as OPEN.
    const reopened = PAIRED_GATES.map((gate) => (gate.number === 11 ? { ...gate, status: "OPEN" as const, evidence: undefined } : gate))
    expect(gate11Statement(reopened)).toStartWith("OPEN, as ablation/paired-gates.ts records it")
    expect(gate11Statement(PAIRED_GATES.filter((gate) => gate.number !== 11))).toStartWith("NOT IN THE TABLE, as ablation/paired-gates.ts records it")
  })

  test("a parse-time refusal is not the preflight: it names no gate and FAILS", () => {
    const claims = shippedClaimsFor({ exitCode: 1, output: "REFUSED at stage 1\n--out must be an absolute path", timedOut: false }, [], false)
    expect(verdictOf(claims, "shipped-refuses")).toBe("FAILS")
    expect(whyOf(claims, "shipped-refuses")).toContain("not named: gate 10, adversarial run")
  })

  test("exit 0, a timeout, a root left behind or a changed evidence directory each fail", () => {
    expect(verdictOf(shippedClaimsFor({ exitCode: 0, output: refusal, timedOut: false }, [], false), "shipped-refuses")).toBe("FAILS")
    expect(verdictOf(shippedClaimsFor({ exitCode: null, output: refusal, timedOut: true }, [], false), "shipped-refuses")).toBe("FAILS")
    expect(verdictOf(shippedClaimsFor({ exitCode: 1, output: refusal, timedOut: false }, ["--out exists after the refusal"], false), "shipped-writes-nothing")).toBe("FAILS")
    expect(verdictOf(shippedClaimsFor({ exitCode: 1, output: refusal, timedOut: false }, [], true), "shipped-writes-nothing")).toBe("FAILS")
  })
})

describe("arguments, paths, the fixture and the bounds", () => {
  test("both flags are required, absolute, and given once", () => {
    expect(parseProbeArgs(["bun", "x", "--out", "/o", "--oauth-prepared", "/p"])).toEqual({ ok: true, args: { out: "/o", prepared: "/p" } })
    expect(parseProbeArgs(["bun", "x", "--out=/o", "--oauth-prepared=/p"])).toEqual({ ok: true, args: { out: "/o", prepared: "/p" } })
    for (const [argv, why] of [
      [["--out", "/o"], "--oauth-prepared <absolute directory> is required"],
      [["--oauth-prepared", "/p"], "--out <absolute directory> is required"],
      [["--out", "rel", "--oauth-prepared", "/p"], "--out needs an absolute path"],
      [["--out", "/o", "--out", "/o2", "--oauth-prepared", "/p"], "--out was given twice"],
      [["--out", "/o", "--oauth-prepared", "/p", "--live"], "unexpected argument `--live`"],
    ] as const) {
      const parsed = parseProbeArgs(["bun", "x", ...argv])
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.reason).toContain(why)
    }
  })

  test("--out and --oauth-prepared must be disjoint, outside the repository, and --out absent or empty", async () => {
    const dir = await tempDir()
    const repo = join(dir, "repo")
    await mkdir(join(repo, "inner"), { recursive: true })
    await mkdir(join(dir, "prepared"))
    await mkdir(join(dir, "full"))
    await writeFile(join(dir, "full", "x"), "x")
    expect(await pathProblems({ out: join(dir, "out"), prepared: join(dir, "prepared") }, repo)).toEqual([])
    expect((await pathProblems({ out: join(repo, "inner", "out"), prepared: join(dir, "prepared") }, repo)).join("\n")).toContain("is inside this repository or contains it")
    expect((await pathProblems({ out: dir, prepared: join(dir, "prepared") }, repo)).join("\n")).toContain("is inside this repository or contains it")
    expect((await pathProblems({ out: join(dir, "prepared", "out"), prepared: join(dir, "prepared") }, repo)).join("\n")).toContain("overlap")
    expect((await pathProblems({ out: join(dir, "full"), prepared: join(dir, "prepared") }, repo)).join("\n")).toContain("is not absent or empty")
    expect((await pathProblems({ out: join(dir, "out"), prepared: join(repo, "inner") }, repo)).join("\n")).toContain("--oauth-prepared")
  })

  test("the protocol fixture is frozen by the file's own rule, and the repository's protocol is not written", async () => {
    const dir = await tempDir()
    const before = await readFile(PROTOCOL_V3_FILE, "utf8")
    const fixture = await frozenProtocolFixture(dir)
    expect(await readFile(PROTOCOL_V3_FILE, "utf8")).toBe(before)
    // The repository's protocol is frozen under its own hash; the fixture is a re-stamped copy and not that freeze.
    expect(/^frozen_hash: (.*)$/m.exec(before)?.[1]).not.toBe(fixture.fixtureHash)
    expect(fixture.file.startsWith(dir)).toBe(true)
    const read = await readFrozenProtocol(fixture.file)
    expect(read).toMatchObject({ ok: true, version: 3, hash: fixture.fixtureHash })
    expect(fixture.draftSha256).toBe(new Bun.CryptoHasher("sha256").update(before).digest("hex"))
    expect(fixture.draftSha256).not.toBe(fixture.fixtureHash)
  })

  test("a source with no single status line is refused", async () => {
    const dir = await tempDir()
    await writeFile(join(dir, "p.md"), "id: x\nversion: 3\n")
    await expect(frozenProtocolFixture(dir, join(dir, "p.md"))).rejects.toThrow("no single `status:` line")
  })

  test("a measured startup tightens a scenario's bound and never loosens it past the outer one", () => {
    expect(scenarioBound(null, null, 1000)).toBe(1000)
    expect(scenarioBound(7000, 1000, 10_000_000)).toBe(16 * 8000 * 3 + 300_000)
    expect(scenarioBound(600_000, 600_000, 1_200_000)).toBe(1_200_000)
  })

  test("the seed fills the root's allowance exactly, and the run-allowance script asks for more than the run's", () => {
    const lines = seededAttempts(16, 30).trim().split("\n")
    expect(lines).toHaveLength(960)
    expect(lines.filter((line) => line.includes('"type":"issued"'))).toHaveLength(ADVERSARIAL_ATTEMPT_ALLOWANCES.global)
    expect(manyFindings("anything").findings).toHaveLength(ADVERSARIAL_ATTEMPT_ALLOWANCES.run + 1)
  })

  test("the transports name exact models, and openai and the copilot Responses route are listed UNPROBED", () => {
    expect(TRANSPORTS.map((entry) => `${entry.providerId}/${entry.modelId}:${entry.format}`)).toEqual(["anthropic/claude-sonnet-5:messages", "github-copilot/gpt-5-mini:chat-completions"])
    expect(UNPROBED_TRANSPORTS.map((entry) => entry.transport).join("\n")).toContain("openai")
    expect(UNPROBED_TRANSPORTS.map((entry) => entry.transport).join("\n")).toContain("github-copilot/gpt-6-luna")
    expect(SCENARIOS.map((entry) => entry.kind)).toHaveLength(9)
  })
})

// ---------------------------------------------------------------------------
// The scenarios, end to end on stand-in hosts and a stand-in backend, against the real suite and its real journal
// ---------------------------------------------------------------------------

/** A managed host that starts and stops as asked, with clean post-stop checks. */
function standInHosts(script: { stop?: (index: number, pid: number) => Promise<StopOutcome> | StopOutcome | undefined } = {}) {
  const started: ManagedHostOptions[] = []
  const stops: number[] = []
  const startHost = async (asked: ManagedHostOptions): Promise<ManagedHostStart> => {
    started.push(asked)
    const index = started.length
    const pid = 4000 + index
    const stop = async (): Promise<StopOutcome> => {
      stops.push(index)
      return (await script.stop?.(index, pid)) ?? { confirmed: true, pid, how: "exited (status 143) after SIGTERM", postStop: { held: ["the OAuth store is empty"], problems: [] } }
    }
    asked.onSpawn?.({ pid, stop })
    return {
      ok: true,
      host: {
        url: `http://127.0.0.1:${47000 + started.length}`,
        pid,
        binary: "/opt/opencode",
        sha256: MEASURED_HOST.sha256,
        version: MEASURED_HOST.version,
        config: {},
        reportedConfig: {},
        environmentKeys: [],
        pluginInstall: async () => ({ installed: true, version: "1.18.5" }),
        stop,
      },
    } as ManagedHostStart
  }
  return { startHost, started, stops }
}

/**
 * A backend that sends each turn to the stub over HTTP in the Messages format,
 * as a host would: it offers `mcp_StructuredOutput` with the stage's schema,
 * answers an unoffered tool call with the measured host's rejection, maps an
 * HTTP 400 to a model error with unknown usage, and a request past its deadline
 * or cancelled in flight to an abandoned turn.
 */
function standInBackend(stub: AdversarialStub, options: OpencodeBackendOptions): ModelBackend {
  let executions = 0
  return {
    capabilities: () => ({ tools: true }),
    async runTurn<T>(slot: string, _instructions: string, _input: string, schema: ZodType<T>, signal?: AbortSignal): Promise<Envelope<T>> {
      const executionId = `${options.executionIdPrefix ?? ""}exec-${(executions += 1)}`
      const messages: unknown[] = [{ role: "user", content: [{ type: "text", text: "review" }] }]
      const deadline = AbortSignal.timeout(options.timeoutMs ?? 5000)
      const abort = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
      for (let step = 0; step < 4; step += 1) {
        let response: Response
        try {
          response = await fetch(`${stub.baseURL}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": "placeholder" },
            body: JSON.stringify({ tools: [{ name: "mcp_StructuredOutput", input_schema: z.toJSONSchema(schema) }], messages }),
            signal: abort,
          })
        } catch {
          return { ok: false, slot, failure: "transport-error", message: "the turn did not end", usageUnknown: { executionId, why: "the turn did not end within its bound", abandoned: true } }
        }
        if (response.status !== 200) {
          return { ok: false, slot, failure: "model-error", message: `HTTP ${response.status}`, usageUnknown: { executionId, why: "the turn ended in a host error" } }
        }
        const events = (await response.text())
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)) as Record<string, any>)
        const tool = events.find((event) => event.type === "content_block_start")?.content_block?.name as string | undefined
        const json = events.find((event) => event.type === "content_block_delta")?.delta?.partial_json as string | undefined
        if (tool !== "StructuredOutput") {
          messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "Model tried to call unavailable tool 'invalid'. Available tools: StructuredOutput.", is_error: true }] })
          continue
        }
        const parsed = schema.safeParse(JSON.parse(json ?? "{}"))
        if (!parsed.success) return { ok: false, slot, failure: "schema-invalid", message: parsed.error.message, tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 } } as Envelope<T>
        return { ok: true, slot, value: parsed.data, tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }
      }
      return { ok: false, slot, failure: "model-error", message: "the stand-in gave up", usageUnknown: { executionId, why: "the stand-in gave up" } }
    },
  }
}

const ANTHROPIC: Transport = TRANSPORTS[0]!
const spec = (kind: ScenarioKind): ScenarioSpec => SCENARIOS.find((entry) => entry.kind === kind)!

async function standInContext(extra: ProbeSeams = {}): Promise<{ context: ProbeContext; stub: AdversarialStub; hosts: ReturnType<typeof standInHosts> }> {
  const dir = await tempDir()
  const home = join(dir, "home")
  const { target } = authLinkPaths(join(dir, "unused"), home)
  await mkdir(join(target, ".."), { recursive: true })
  await writeFile(target, JSON.stringify(placeholderAuth(Date.now())))
  const stub = startAdversarialStub(ANTHROPIC.providerId, ANTHROPIC.format)
  const proxy = startRefusingProxy()
  stoppers.push(stub, proxy)
  const hosts = standInHosts()
  const seams: ProbeSeams = {
    startHost: hosts.startHost,
    createBackend: (options) => standInBackend(stub, options),
    createClient: (init) => ({ fake: init }),
    enumerate: async () => [candidate(ANTHROPIC.providerId, ANTHROPIC.modelId)],
    hangTurnMs: 300,
    noUsageTurnMs: 300,
    ...extra,
  }
  const context: ProbeContext = {
    out: join(dir, "out"),
    prepared: join(dir, "prepared"),
    scratch: dir,
    home,
    protocol: await frozenProtocolFixture(dir),
    proxy,
    signal: new AbortController().signal,
    owner: new HostOwner(extra.teardownMs ?? 2000),
    seams,
    clock: (await import("../core/ports/clock.ts")).systemClock(),
    codeRevision: { kind: "known", value: { commit: "abc123", dirty: false } },
    identity: null,
    scenarioMs: 120_000,
  }
  return { context, stub, hosts }
}

async function observed(kind: ScenarioKind, extra: ProbeSeams = {}) {
  const { context, stub, hosts } = await standInContext(extra)
  const { facts: seen, startedAt } = await runScenario(context, ANTHROPIC, stub, spec(kind))
  return { facts: seen, claims: claimsFor(seen, PIN, startedAt), hosts, context }
}

describe("the scenarios on stand-ins, through the real suite and journal", () => {
  test("healthy: sixteen hosts in order, each attempt journaled before it is issued and counted once", async () => {
    const { facts: seen, claims, hosts } = await observed("healthy")
    expect(claims.map((entry) => `${entry.id}:${entry.verdict}`)).toEqual([
      "roster:HOLDS",
      "journal-before-issue:HOLDS",
      "counted-once:HOLDS",
      "serial-no-overshoot:HOLDS",
      "stop-confirmed:HOLDS",
      "post-stop-clean:HOLDS",
      "full-suite:HOLDS",
    ])
    expect(seen.complete).toBe(true)
    expect(seen.calls.length).toBeGreaterThanOrEqual(16)
    expect(seen.calls.every((entry) => entry.unsettledAtEntry === 1)).toBe(true)
    expect(seen.requests.every((entry) => entry.unsettledAtArrival === 1)).toBe(true)
    // The probe adds only the sandbox spawn, the proxy, the scratch and the stub's baseURL to what the lifecycle asked for.
    const asked = hosts.started[0]!
    expect(asked.mode).toBe("oauth")
    if (asked.mode === "oauth") {
      expect(Object.keys(asked.oauth.baseURLs ?? {})).toEqual(["anthropic"])
      expect(asked.oauth.providers).toEqual(["anthropic"])
      expect(asked.signals).toBeNull()
      expect(asked.proxy).toMatch(/^http:\/\/127\.0\.0\.1:/)
      expect(asked.spawn).toBeDefined()
    }
  }, 120_000)

  test("run allowance: thirty issued for run 1, the rest refused for budget before any backend entry, later runs proceed", async () => {
    const { facts: seen, claims } = await observed("run-allowance")
    expect(claims.map((entry) => `${entry.id}:${entry.verdict}`)).toEqual([
      "run-cap-issued:HOLDS",
      "run-cap-refusal:HOLDS",
      "run-cap-fails-run:HOLDS",
      "run-cap-later-runs:HOLDS",
      "stop-confirmed:HOLDS",
      "post-stop-clean:HOLDS",
    ])
    expect(seen.calls.filter((entry) => entry.position === 1)).toHaveLength(30)
  }, 120_000)

  test("root allowance: the seeded 480 stop the runner with no backend call and no request", async () => {
    const { facts: seen, claims } = await observed("root-allowance")
    expect(claims.every((entry) => entry.verdict === "HOLDS")).toBe(true)
    expect(seen.seeded).toEqual({ issued: 480, unsettled: 0 })
    expect(seen.calls).toHaveLength(0)
    expect(seen.requests).toHaveLength(0)
  }, 120_000)

  test("non-ending: the hung attempt is abandoned at the shortened deadline, the suite halts, nothing follows", async () => {
    const { facts: seen, claims } = await observed("non-ending")
    expect(claims.every((entry) => entry.verdict === "HOLDS")).toBe(true)
    expect(seen.turnTimeoutMs).toBe(300)
    expect(seen.hosts.starts).toBe(1)
  }, 120_000)

  test("the turn deadline each row's backend is given: the hang and no-usage rows their own, every other row the launcher's", async () => {
    expect([HANG_TURN_MS, NO_USAGE_TURN_MS]).toEqual([5_000, 20_000])
    const given = async (kind: ScenarioKind): Promise<(number | undefined)[]> => {
      const seen: (number | undefined)[] = []
      const { context, stub } = await standInContext()
      context.seams.createBackend = (options) => {
        seen.push(options.timeoutMs)
        return standInBackend(stub, options)
      }
      await runScenario(context, ANTHROPIC, stub, spec(kind))
      return [...new Set(seen)]
    }
    // The stand-in context sets both shortened deadlines to 300 ms.
    expect(await given("non-ending")).toEqual([300])
    expect(await given("stream-without-usage")).toEqual([300])
    expect(await given("host-offer")).toEqual([ADVERSARIAL_TURN_TIMEOUT_MS])
    expect(await given("run-allowance")).toEqual([ADVERSARIAL_TURN_TIMEOUT_MS])
    expect(LIMITATIONS.join("\n")).toContain(`to 5000 ms and 20000 ms. Every other row runs on the shipped launcher's own 120000 ms, which no row here waited out.`)
  }, 240_000)

  test("cancel in flight: the signal set at the stub request halts the suite and the attempt counts one", async () => {
    const { facts: seen, claims } = await observed("cancel-in-flight", { hangTurnMs: 5000 })
    expect(seen.cancelled).toBe(true)
    expect(verdictOf(claims, "cancelled-counts-one")).toBe("HOLDS")
    expect(verdictOf(claims, "halt-and-marker")).toBe("HOLDS")
    expect(verdictOf(claims, "nothing-later")).toBe("HOLDS")
    expect(seen.deadline).toBeNull()
  }, 120_000)

  test("integrity before the start: a dangling issued line refuses the suite with nothing started", async () => {
    const { facts: seen, claims, hosts } = await observed("integrity-before-start")
    expect(claims.every((entry) => entry.verdict === "HOLDS")).toBe(true)
    expect(seen.seeded).toEqual({ issued: 1, unsettled: 1 })
    expect(hosts.started).toHaveLength(0)
  }, 120_000)

  test("injected conflict: reports made before the envelope returns latch the halt during settlement, and the retry never enters the backend", async () => {
    const { facts: seen, claims } = await observed("integrity-injected")
    expect(claims.map((entry) => `${entry.id}:${entry.verdict}`)).toEqual([
      "one-attempt-reaches-stub:HOLDS",
      "unknown-binds-id:HOLDS",
      "conflict-recorded:HOLDS",
      "halt-and-marker:HOLDS",
      "retry-refused:HOLDS",
      "stop-confirmed:HOLDS",
      "post-stop-clean:HOLDS",
      "nothing-later:HOLDS",
    ])
    expect(seen.injected).toMatchObject({ reported: true })
    expect(seen.calls).toHaveLength(1)
    expect(seen.integrity).toEqual([expect.objectContaining({ payloads: 2 })])
    expect(seen.refusals.some((refusal) => refusal.cause === "halted")).toBe(true)
    expect(seen.halt).toContain("two different token payloads")
  }, 120_000)

  test("injected conflict: an envelope that carries a token figure leaves the reports unmade, and the row FAILS with that reason", async () => {
    const { context, stub } = await standInContext()
    context.seams.createBackend = (options) => {
      const inner = standInBackend(stub, options)
      return {
        capabilities: (slot) => inner.capabilities(slot),
        async runTurn(slot, instructions, input, schema, signal, admitted) {
          const envelope = await inner.runTurn(slot, instructions, input, schema, signal, admitted)
          if (envelope.ok || envelope.usageUnknown === undefined) return envelope
          const { usageUnknown: _dropped, ...rest } = envelope
          return { ...rest, tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }
        },
      }
    }
    const { facts: seen } = await runScenario(context, ANTHROPIC, stub, spec("integrity-injected"))
    expect(seen.injected).toMatchObject({ reported: false })
    const claims = claimsFor(seen, PIN)
    expect(verdictOf(claims, "conflict-recorded")).toBe("FAILS")
    expect(whyOf(claims, "conflict-recorded")).toContain("carried a token figure")
  }, 120_000)

  test("host offer: the unoffered call is rejected, no canary comes back, and StructuredOutput completes the turn", async () => {
    const { facts: seen, claims, context } = await observed("host-offer")
    expect(claims.slice(0, 5).map((entry) => `${entry.id}:${entry.verdict}`)).toEqual([
      "offered-names:HOLDS",
      "treatment:HOLDS",
      "canary-nondisclosure:HOLDS",
      "not-executed:HOLDS",
      "structured-output-usable:HOLDS",
    ])
    const tried = seen.requests.find((entry) => entry.served === "unoffered-tool")!
    expect(tried.position).toBe(1)
    expect(seen.requests.filter((entry) => entry.served === "unoffered-tool")).toHaveLength(1)
    // The canary is a file in run 1's worktree, and its token is in no fact.
    const canary = (await Array.fromAsync(new Bun.Glob("**/probe-canary.txt").scan({ cwd: context.out, absolute: true })))[0]!
    const token = (await readFile(canary, "utf8")).trim()
    expect(token).toMatch(/^MAD-CANARY-[0-9a-f]{24}$/)
    expect(JSON.stringify(seen)).not.toContain(token)
  }, 120_000)

  test("stream without usage: the row records what it saw and makes no claim", async () => {
    const { facts: seen, claims } = await observed("stream-without-usage")
    expect(claims).toEqual([])
    expect(seen.requests.every((entry) => entry.served === "no-usage")).toBe(true)
    expect(seen.turnTimeoutMs).toBe(300)
    expect(seen.calls.length).toBeGreaterThanOrEqual(16)
  }, 120_000)

  test("a scenario whose host stop is UNCONFIRMED starts no further host, and says the probe must not go on", async () => {
    const hosts = standInHosts({ stop: (index, pid) => (index === 1 ? { confirmed: false, pid, why: "SIGKILL was sent and the exit was not observed" } : undefined) })
    const { context, stub } = await standInContext({ startHost: hosts.startHost })
    const { facts: seen } = await runScenario(context, ANTHROPIC, stub, spec("healthy"))
    expect(hosts.started).toHaveLength(1)
    expect(hosts.stops).toEqual([1])
    expect(seen.unsafe).toHaveLength(1)
    expect(seen.unsafe[0]).toContain("the stop of process 4001")
    expect(seen.unsafe[0]).toContain("UNCONFIRMED")
    expect(verdictOf(claimsFor(seen, PIN), "stop-confirmed")).toBe("FAILS")
    // The owner refuses the next start itself, whoever asks: a second scenario on the same probe starts nothing.
    const again = await runScenario(context, ANTHROPIC, stub, spec("root-allowance"))
    expect(hosts.started).toHaveLength(1)
    expect(again.facts.hosts.records.find((record) => record.event === "start")?.detail).toContain("no further host starts while an earlier one is unresolved")
  }, 120_000)

  test("a confirmed stop whose post-stop check failed is disclosed and leaves the probe free to go on", async () => {
    const hosts = standInHosts({ stop: (_index, pid) => ({ confirmed: true, pid, how: "exited", postStop: { held: [], problems: ["session=1"] } }) })
    const { context, stub } = await standInContext({ startHost: hosts.startHost })
    const { facts: seen } = await runScenario(context, ANTHROPIC, stub, spec("non-ending"))
    expect(seen.unsafe).toEqual([])
    expect(verdictOf(claimsFor(seen, PIN), "post-stop-clean")).toBe("FAILS")
    expect(verdictOf(claimsFor(seen, PIN), "stop-confirmed")).toBe("HOLDS")
  }, 120_000)

  test("a suite stage that throws with a host up does not lose it: the owner stops it, with a known outcome, before the scenario returns", async () => {
    const hosts = standInHosts()
    const { context, stub } = await standInContext({ startHost: hosts.startHost })
    let lifecycleStops = 0
    // A stage that takes a host through the probe's own start seam, hands over a stop, and then throws.
    context.seams.suiteStage = async (input) => {
      input.ownStop(async () => {
        lifecycleStops += 1
      })
      const started = await input.startHost!({ mode: "oauth", oauth: { dataDir: join(input.dataRoot, "run-1") }, signals: null } as unknown as ManagedHostOptions)
      expect(started.ok).toBe(true)
      throw new Error("the stage failed with its host up")
    }
    const { facts: seen } = await runScenario(context, ANTHROPIC, stub, spec("healthy"))
    expect(seen.refused).toBe("the scenario threw: the stage failed with its host up")
    // The lifecycle's own stop was asked for, and the owner stopped the host it had not.
    expect(lifecycleStops).toBe(1)
    expect(hosts.started).toHaveLength(1)
    expect(hosts.stops).toEqual([1])
    expect(context.owner.hosts).toHaveLength(1)
    expect(context.owner.hosts[0]!.outcome).toMatchObject({ confirmed: true })
    expect(seen.unsafe).toEqual([])
  }, 120_000)

  test("the same throw with a host whose stop is not confirmed leaves the scenario unsafe", async () => {
    const hosts = standInHosts({ stop: (_index, pid) => ({ confirmed: false, pid, why: "the exit was not observed" }) })
    const { context, stub } = await standInContext({ startHost: hosts.startHost })
    context.seams.suiteStage = async (input) => {
      await input.startHost!({ mode: "oauth", oauth: { dataDir: join(input.dataRoot, "run-1") }, signals: null } as unknown as ManagedHostOptions)
      throw new Error("the stage failed with its host up")
    }
    const { facts: seen } = await runScenario(context, ANTHROPIC, stub, spec("healthy"))
    expect(seen.unsafe).toHaveLength(1)
    expect(seen.unsafe[0]).toContain("UNCONFIRMED")
  }, 120_000)
})

describe("the host owner", () => {
  const confirmed = (pid: number): StopOutcome => ({ confirmed: true, pid, how: "exited", postStop: { held: [], problems: [] } })

  test("one stop per process: the spawn handle and the started host share it, and the fullest stop is the one called", async () => {
    const owner = new HostOwner(500)
    const calls: string[] = []
    const first = owner.own("/data/run-1", 11, async () => (calls.push("spawn handle"), { confirmed: true, pid: 11, how: "killed" }))
    const second = owner.own("/data/run-1", 11, async () => (calls.push("host"), confirmed(11)))
    expect(second).toBe(first)
    const [a, b] = await Promise.all([first.stop(), second.stop()])
    expect(calls).toEqual(["host"])
    expect(a).toBe(b)
    expect(first.outcome).toEqual(confirmed(11))
    expect(await owner.settle()).toEqual([])
  })

  test("a stop that rejects, or that passes the teardown bound, is kept as an unconfirmed outcome and never dropped", async () => {
    const owner = new HostOwner(40)
    owner.own("/data/a", 21, async () => {
      throw new Error("kill failed")
    })
    owner.own("/data/b", 22, () => new Promise<StopOutcome>(() => undefined))
    const problems = await owner.settle()
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain("process 21")
    expect(problems[0]).toContain("the stop rejected: kill failed")
    expect(problems[1]).toContain("process 22")
    expect(problems[1]).toContain("the stop gave no answer within 40 ms")
    // Asking again does not send a second stop or change the answer.
    expect(await owner.settle()).toEqual(problems)
  })

  test("settle stops a host nobody stopped", async () => {
    const owner = new HostOwner(500)
    let stopped = 0
    owner.own("/data/a", 31, async () => ((stopped += 1), confirmed(31)))
    expect(owner.unresolved()).toEqual(["process 31 (`/data/a`) was started and has not been stopped"])
    expect(await owner.settle()).toEqual([])
    expect(stopped).toBe(1)
  })
})

describe("a host start that outlives its bound", () => {
  const lateHost = (pid: number, stop: () => Promise<StopOutcome>): ManagedHostStart => ({ ok: true, host: { url: "http://127.0.0.1:1", pid, stop } }) as unknown as ManagedHostStart
  const oauth = (dataDir: string) => ({ mode: "oauth", oauth: { dataDir } }) as unknown as ManagedHostOptions

  test("it is refused and stays owned: the host it returns later is stopped, and its outcome is known before the probe goes on", async () => {
    const { context } = await standInContext({ hostStartMs: 30 })
    let stopped = 0
    context.seams.startHost = async () => {
      await Bun.sleep(120)
      return lateHost(51, async () => ((stopped += 1), { confirmed: true, pid: 51, how: "stopped", postStop: { held: [], problems: [] } }))
    }
    const started = await boundedStart(context, "the managed host's start", oauth("/data/run-1"))
    expect(started.ok).toBe(false)
    if (!started.ok) expect(started.reason).toContain("gave no answer within 30 ms")
    // Until the start returns, another host must not start.
    expect(context.owner.unresolved().join("\n")).toContain("the start on `/data/run-1` outlived its bound and has not returned")
    expect(await context.owner.settle()).toEqual([])
    expect(stopped).toBe(1)
    expect(context.owner.hosts[0]).toMatchObject({ key: "/data/run-1", pid: 51, outcome: { confirmed: true } })
  })

  test("a late host whose stop fails is reported, not dropped", async () => {
    const { context } = await standInContext({ hostStartMs: 30 })
    context.seams.startHost = async () => {
      await Bun.sleep(80)
      return lateHost(52, async () => {
        throw new Error("the process would not die")
      })
    }
    await boundedStart(context, "x", oauth("/data/run-2"))
    const problems = await context.owner.settle()
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("process 52")
    expect(problems[0]).toContain("the stop rejected: the process would not die")
  })

  test("a late start that rejects, and one that never returns within the teardown bound, are each unresolved", async () => {
    const rejecting = await standInContext({ hostStartMs: 30 })
    rejecting.context.seams.startHost = async () => {
      await Bun.sleep(80)
      throw new Error("spawn failed late")
    }
    await boundedStart(rejecting.context, "x", oauth("/data/run-3"))
    expect((await rejecting.context.owner.settle()).join("\n")).toContain("outlived its bound and then rejected (spawn failed late)")

    const hanging = await standInContext({ hostStartMs: 30, teardownMs: 60 })
    hanging.context.seams.startHost = () => new Promise<ManagedHostStart>(() => undefined)
    await boundedStart(hanging.context, "x", oauth("/data/run-4"))
    expect((await hanging.context.owner.settle()).join("\n")).toContain("the start on `/data/run-4` outlived its bound and has not returned")
  })

  test("a start inside the bound is returned with the owner's stop, and the caller's onSpawn gets that same stop", async () => {
    const { context } = await standInContext()
    const hosts = standInHosts()
    context.seams.startHost = hosts.startHost
    let spawnStop: (() => Promise<StopOutcome>) | undefined
    const started = await boundedStart(context, "x", { ...oauth("/data/run-5"), onSpawn: (handle) => (spawnStop = handle.stop) } as ManagedHostOptions)
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.host.stop).toBe(spawnStop!)
    await Promise.all([started.host.stop(), spawnStop!()])
    expect(hosts.stops).toEqual([1])
    // A refusal before the spawn passes through, and a stop `startManagedHost` already made is recorded.
    context.seams.startHost = async () => ({ ok: false, reason: "refused", stopped: { confirmed: false, pid: 77, why: "not observed" } })
    await boundedStart(context, "x", oauth("/data/run-6"))
    expect(context.owner.unresolved().join("\n")).toContain("process 77")
  })
})

describe("the calibration host's stop", () => {
  const calibrated = async (stop: (index: number, pid: number) => Promise<StopOutcome> | StopOutcome | undefined, extra: ProbeSeams = {}) => {
    const hosts = standInHosts({ stop })
    const { context, stub } = await standInContext({ startHost: hosts.startHost, ...extra })
    return { record: await calibrate(context, ANTHROPIC, stub), hosts, context }
  }

  test("a clean stop leaves nothing to say", async () => {
    const { record } = await calibrated(() => undefined)
    expect(record).toMatchObject({ stopProblem: null, unsafe: [], stop: { confirmed: true, postStopProblems: 0 }, turn: { disposition: "ok" } })
  })

  test("an unconfirmed stop, a stop that throws, missing post-stop checks and a failed check each give a stop problem", async () => {
    const unconfirmed = await calibrated((_index, pid) => ({ confirmed: false, pid, why: "the exit was not observed" }))
    expect(unconfirmed.record.stopProblem).toContain("its stop is UNCONFIRMED (the exit was not observed)")
    expect(unconfirmed.record.unsafe).toHaveLength(1)
    const thrown = await calibrated(() => {
      throw new Error("stop exploded")
    })
    expect(thrown.record.stopProblem).toContain("UNCONFIRMED (the stop rejected: stop exploded)")
    expect(thrown.record.unsafe).toHaveLength(1)
    const missing = await calibrated((_index, pid) => ({ confirmed: true, pid, how: "exited" }))
    expect(missing.record.stopProblem).toContain("no post-stop checks")
    expect(missing.record.stop).toEqual({ confirmed: true, postStopProblems: null })
    expect(missing.record.unsafe).toEqual([])
    const failed = await calibrated((_index, pid) => ({ confirmed: true, pid, how: "exited", postStop: { held: [], problems: ["session=1"] } }))
    expect(failed.record.stopProblem).toContain("a post-stop check failed: session=1")
  })

  test("a stop past the teardown bound is unconfirmed, and the calibration returns", async () => {
    const { record } = await calibrated(() => new Promise<StopOutcome>(() => undefined), { teardownMs: 50 })
    expect(record.stopProblem).toContain("the stop gave no answer within 50 ms")
    expect(record.unsafe).toHaveLength(1)
  })
})

describe("the scenarios on stand-ins, their bounds", () => {
  test("a scenario past its bound aborts the suite, stops its host and fails its claims", async () => {
    const { context, stub } = await standInContext({ hangTurnMs: 60_000 })
    context.scenarioMs = 400
    const { facts: seen } = await runScenario(context, ANTHROPIC, stub, spec("non-ending"))
    expect(seen.deadline).toContain("did not end within its 400 ms bound")
    expect(seen.hosts.records.filter((record) => record.event === "stop" && record.ok).length).toBeLessThanOrEqual(1)
    const full = await runScenario({ ...context, scenarioMs: 1 }, ANTHROPIC, stub, spec("healthy"))
    expect(verdictOf(claimsFor(full.facts, PIN), "full-suite")).toBe("FAILS")
    expect(whyOf(claimsFor(full.facts, PIN), "full-suite")).toContain("did not end within its 1 ms bound")
  }, 120_000)
})

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

describe("main", () => {
  const SHIPPED = { exitCode: 1, output: BARRIERS.map((barrier) => barrier.text).join("\n"), timedOut: false }

  async function commandSeams(extra: ProbeSeams = {}, hosts = standInHosts()) {
    const dir = await tempDir()
    const stubFor = new Map<string, AdversarialStub>()
    const seams: ProbeSeams = {
      platform: "darwin",
      selfTest: async () => ({ ok: true, why: "stand-in self-test" }) as never,
      verifyPrepared: async () => ({ ok: true }),
      startHost: async (options) => {
        // The stub a host was pointed at is the one its backend talks to.
        if (options.mode === "oauth") for (const [provider, baseURL] of Object.entries(options.oauth.baseURLs ?? {})) stubFor.set(provider, { baseURL } as AdversarialStub)
        return hosts.startHost(options)
      },
      createBackend: (options) => standInBackend({ baseURL: [...stubFor.values()].at(-1)!.baseURL } as AdversarialStub, options),
      createClient: (init) => ({ fake: init }),
      enumerate: async () => [candidate(ANTHROPIC.providerId, ANTHROPIC.modelId)],
      shipped: async () => SHIPPED,
      // A stand-in decision: no real command is started here, and no table is read.
      shippedDecision: async () => ({ spawn: true, barriers: BARRIERS }),
      codeRevision: async () => ({ kind: "known", value: { commit: "abc123", dirty: false } }),
      transports: [ANTHROPIC],
      scenarios: [spec("integrity-before-start"), spec("root-allowance"), spec("integrity-injected")],
      hangTurnMs: 300,
      repoRoot: join(dir, "repo"),
      ...extra,
    }
    await mkdir(join(dir, "repo"), { recursive: true })
    await mkdir(join(dir, "prepared"))
    return { dir, seams, hosts, argv: ["bun", "x", "--out", join(dir, "out"), "--oauth-prepared", join(dir, "prepared")] }
  }

  test("it refuses off macOS, on a failed self-test and on an unverified payload, before any host", async () => {
    const { seams, argv, hosts, dir } = await commandSeams()
    expect(await main(argv, { ...seams, platform: "linux" })).toBe(1)
    expect(await main(argv, { ...seams, selfTest: async () => ({ ok: false, why: "an external target was reachable" }) as never })).toBe(1)
    expect(await main(argv, { ...seams, verifyPrepared: async () => ({ ok: false, problems: ["the tree digest differs"] }) })).toBe(1)
    expect(await main(["bun", "x", "--out", join(dir, "repo", "out"), "--oauth-prepared", join(dir, "prepared")], seams)).toBe(1)
    expect(hosts.started).toHaveLength(0)
    expect(existsSync(join(dir, "out", EVIDENCE_FILE))).toBe(false)
  })

  test("a calibration host that does not start refuses the probe before any scenario", async () => {
    const { seams, argv, dir } = await commandSeams({ startHost: async () => ({ ok: false, reason: "the binary is not the measured build", stopped: null }) })
    expect(await main(argv, seams)).toBe(1)
    expect(existsSync(join(dir, "out", EVIDENCE_FILE))).toBe(false)
  })

  test("a calibration host whose stop is not established, or whose post-stop checks are missing, refuses before any scenario", async () => {
    for (const stop of [
      (_index: number, pid: number): StopOutcome => ({ confirmed: false, pid, why: "the exit was not observed" }),
      (_index: number, pid: number): StopOutcome => ({ confirmed: true, pid, how: "exited" }),
      (_index: number, pid: number): StopOutcome => ({ confirmed: true, pid, how: "exited", postStop: { held: [], problems: ["session=1"] } }),
    ]) {
      const hosts = standInHosts({ stop })
      const { seams, argv, dir } = await commandSeams({}, hosts)
      expect(await main(argv, seams)).toBe(1)
      // The calibration host only: no scenario started another.
      expect(hosts.started).toHaveLength(1)
      expect(existsSync(join(dir, "out", EVIDENCE_FILE))).toBe(false)
    }
  }, 120_000)

  test("a scenario that leaves a host's termination unconfirmed ends the probe: no later scenario starts a host, and no evidence is written", async () => {
    // Host 1 is the calibration's; host 2 is the first scenario's, and its stop is not confirmed.
    const hosts = standInHosts({ stop: (index, pid) => (index === 2 ? { confirmed: false, pid, why: "the exit was not observed" } : undefined) })
    const { seams, argv, dir } = await commandSeams({ scenarios: [spec("non-ending"), spec("root-allowance"), spec("integrity-injected")] }, hosts)
    expect(await main(argv, seams)).toBe(1)
    expect(hosts.started).toHaveLength(2)
    expect(existsSync(join(dir, "out", EVIDENCE_FILE))).toBe(false)
  }, 120_000)

  test("it writes evidence with per-claim verdicts, the calibration apart, the fixture's digests, and no path", async () => {
    const { seams, argv, dir } = await commandSeams()
    expect(await main(argv, seams)).toBe(0)
    const text = await readFile(join(dir, "out", EVIDENCE_FILE), "utf8")
    expect(text).not.toContain(dir)
    expect(text).not.toContain(tmpdir())
    expect(text).toContain("<probe-out>")
    const evidence = JSON.parse(text) as Record<string, any>
    expect(evidence.gate11).toBe(gate11Statement())
    expect(evidence.calibration.label).toContain("CALIBRATION")
    expect(evidence.calibration.turn.disposition).toBe("ok")
    expect(evidence.protocolFixture.label).toContain("SYNTHETIC FIXTURE")
    expect(evidence.protocolFixture.draftSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(evidence.suiteAllowance.verdict).toBe("UNPROBED")
    expect(evidence.unprobedTransports).toHaveLength(2)
    expect(evidence.transports).toHaveLength(1)
    expect(evidence.transports[0].scenarios.map((scenario: any) => scenario.kind)).toEqual(["integrity-before-start", "root-allowance", "integrity-injected"])
    const injected = evidence.transports[0].scenarios[2]
    expect(injected.records.issuedAttempts).toMatchObject({ seeded: 0, newlyIssued: 1, counted: 1 })
    expect(injected.records.runTurnCalls.total).toBe(1)
    expect(injected.records.refusals.halted).toBeGreaterThanOrEqual(1)
    expect(evidence.transports[0].scenarios[1].records.issuedAttempts).toMatchObject({ seeded: 480, newlyIssued: 0 })
    expect(evidence.summary.fails).toBe(0)
    expect(evidence.summary.note).toContain("not a verdict on gate 11")
  }, 120_000)

  test("a failing claim exits 1 and the evidence is still written, with the failure named", async () => {
    const { seams, argv, dir } = await commandSeams({ shipped: async () => ({ exitCode: 0, output: "", timedOut: false }), scenarios: [spec("integrity-before-start")] })
    expect(await main(argv, seams)).toBe(1)
    const evidence = JSON.parse(await readFile(join(dir, "out", EVIDENCE_FILE), "utf8")) as Record<string, any>
    expect(evidence.summary.failing).toContain("shipped command: shipped-refuses")
  }, 120_000)

  test("with no offline refusal, or a decision that throws, the shipped command is never started and its row is UNPROBED", async () => {
    const before = await productionReservation()
    // Run 1's reservation is committed, so an unchanged state is a regular file and the comparison is never vacuous.
    expect(before.state).toBe("file")
    for (const [shippedDecisionSeam, why] of [
      // The committed table refuses on gate 10, so the no-refusal decision is taken over gate 10 CLOSED, injected.
      [async () => shippedDecision({ gates: gate10Closed }), "no offline refusal is established"],
      [
        async () => {
          throw new Error("table unreadable")
        },
        "could not be established (table unreadable)",
      ],
    ] as const) {
      let started = 0
      const { seams, argv, dir } = await commandSeams({
        shippedDecision: shippedDecisionSeam,
        shipped: async () => {
          started += 1
          return SHIPPED
        },
        scenarios: [spec("integrity-before-start")],
      })
      expect(await main(argv, seams), why).toBe(0)
      expect(started, why).toBe(0)
      const evidence = JSON.parse(await readFile(join(dir, "out", EVIDENCE_FILE), "utf8")) as Record<string, any>
      expect(evidence.shippedCommand.claims.map((entry: Claim) => `${entry.id}:${entry.verdict}`)).toEqual(["shipped-refuses:UNPROBED", "shipped-writes-nothing:UNPROBED"])
      expect(evidence.shippedCommand.claims[0].why, why).toContain(why)
      // Nothing of the shipped command's exists: neither root, and no reservation under the stand-in repository.
      for (const path of [join(dir, "out", "shipped", "out"), join(dir, "out", "shipped", "data"), join(dir, "repo", ADVERSARIAL_RUN.reservation)]) expect(existsSync(path), path).toBe(false)
      expect(await productionReservation(), why).toEqual(before)
    }
  }, 240_000)

  test("on the committed tree (no decision injected) the probe derives gate 10 as its barrier and starts only the recording stand-in, once, with its argv", async () => {
    const before = await productionReservation()
    // Run 1's reservation is committed, so an unchanged state is a regular file and the comparison is never vacuous.
    expect(before.state).toBe("file")
    const calls: (readonly string[])[] = []
    const { seams, argv, dir } = await commandSeams({
      // The default decision reads the committed table; the recording stand-in is the only command started.
      shippedDecision: undefined,
      shipped: async (shippedArgv) => {
        calls.push([...shippedArgv])
        return { exitCode: 1, output: "REFUSED at stage 1\ngate 10 (adversarial spend authorization) is OPEN", timedOut: false }
      },
      scenarios: [spec("integrity-before-start")],
    })
    const expected = await shippedDecision()
    expect(expected.spawn ? expected.barriers.map((barrier) => barrier.name) : null).toEqual(["stage 1", "gate 10"])
    expect(await main(argv, seams)).toBe(0)
    expect(calls).toEqual([
      [
        "--live",
        "--provider-mode",
        "oauth",
        "--oauth-provider",
        ANTHROPIC.providerId,
        "--pin",
        `${ANTHROPIC.providerId}/${ANTHROPIC.modelId}`,
        "--oauth-prepared",
        join(dir, "prepared"),
        "--oauth-data-root",
        join(dir, "out", "shipped", "data"),
        "--out",
        join(dir, "out", "shipped", "out"),
      ],
    ])
    const evidence = JSON.parse(await readFile(join(dir, "out", EVIDENCE_FILE), "utf8")) as Record<string, any>
    expect(evidence.shippedCommand.claims.map((entry: Claim) => `${entry.id}:${entry.verdict}`)).toEqual(["shipped-refuses:HOLDS", "shipped-writes-nothing:HOLDS"])
    expect(evidence.shippedCommand.claims[0].claim).toContain("exits 1 at stage 1 naming gate 10")
    expect(await productionReservation()).toEqual(before)
  }, 120_000)

  test("a stand-in decision to start, with no stand-in command, starts nothing: the real command is never its fallback", async () => {
    const before = await productionReservation()
    // Run 1's reservation is committed, so an unchanged state is a regular file and the comparison is never vacuous.
    expect(before.state).toBe("file")
    const { seams, argv, dir } = await commandSeams({ shipped: undefined, scenarios: [spec("integrity-before-start")] })
    expect(await main(argv, seams)).toBe(0)
    const evidence = JSON.parse(await readFile(join(dir, "out", EVIDENCE_FILE), "utf8")) as Record<string, any>
    expect(evidence.shippedCommand.claims.map((entry: Claim) => entry.verdict)).toEqual(["UNPROBED", "UNPROBED"])
    expect(evidence.shippedCommand.claims[0].why).toContain("a stand-in decision never starts the real command")
    for (const path of [join(dir, "out", "shipped", "out"), join(dir, "out", "shipped", "data")]) expect(existsSync(path), path).toBe(false)
    expect(await productionReservation()).toEqual(before)
  }, 120_000)

  test("a probe past its own deadline writes no evidence and exits 1", async () => {
    const { seams, argv, dir } = await commandSeams({ probeMs: 1, scenarios: [spec("non-ending")], hangTurnMs: 2000 })
    expect(await main(argv, seams)).toBe(1)
    expect(existsSync(join(dir, "out", EVIDENCE_FILE))).toBe(false)
  }, 120_000)
})
