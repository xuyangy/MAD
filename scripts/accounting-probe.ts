#!/usr/bin/env bun
/**
 * Story 2-8c — the zero-bill real-host request accounting probe.
 *
 *   bun run accounting-probe --out /tmp/mad-probe
 *
 * ## What it measures
 *
 * How many physical provider requests the opencode host makes behind one
 * admitted port call, and whether the usage MAD records for that call is the
 * usage the provider served. Paired gate 1's invariant is: one physical request
 * per admitted port call, no host retry, and every subcall accounted. Each
 * scenario below gets a verdict against it, `HOLDS` or `FAILS`.
 *
 * It also shows, on the same host, that each of the journal's global, Blocks and
 * phase gates refuses inside the journal's admission, before any backend call
 * (paired gate 2).
 *
 * ## It bills nothing, by construction
 *
 * The host is `ablation/managed-host.ts`'s: an isolated environment whose only
 * provider is the local stub in `ablation/accounting-stub.ts`, a credential that
 * is a fixed dummy string, and HTTP(S)_PROXY pointed at a local proxy that
 * refuses and lists every attempt. That covers clients that honour the proxy
 * variables. **Direct egress is not blocked**, and the evidence says so; it
 * lists the proxy attempts it refused, never "every outbound attempt".
 *
 * ## It drives the production path
 *
 * Each scenario runs the real `discover` stage with a one-slot roster, a real
 * `OpencodeModelBackend` against the managed host, and a real journal's
 * `admission` in its own bundle root. Per admitted attempt it records the
 * journal's `issued` and `settled` lines, the physical requests the stub
 * received for it, and the usage the stub served against the usage MAD settled.
 * Per scenario it keeps MAD's own discover retry (a second admitted attempt)
 * apart from the host's hidden retries within one attempt. See
 * `attributeRequests` for how requests are assigned to attempts.
 *
 * ## Exit status
 *
 * 0 when every scenario ran, every host stop was confirmed, every verdict is
 * complete and every gate-2 case was refused. **Exit 0 does not mean gate 1
 * passed.** A deadline, a thrown error, an unconfirmed host stop, an incomplete
 * verdict or a gate-2 case that was not refused exits 1, removes the scratch
 * directories and leaves no `host-accounting.json`. `--out` must be empty or
 * absent, so no earlier run's journal or evidence is ever read as this one's.
 */

import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve, sep } from "node:path"

import { OpencodeModelBackend, type RequestMeterPort } from "../adapters/opencode/model-backend.ts"
import { startRequestMeter, type RelayEvent, type RequestMeter } from "../ablation/request-meter.ts"
import {
  startAccountingStub,
  startRefusingProxy,
  type AccountingStub,
  type ProxyAttempt,
  type RefusingProxy,
  type StubBehaviour,
  type StubRequest,
} from "../ablation/accounting-stub.ts"
import { PAIRED_ALLOWANCES } from "../ablation/governor.ts"
import { acquireLock, JOURNAL_FILE, openJournal, type IssuedLine, type JournalLine, type SettledLine } from "../ablation/journal.ts"
import {
  MEASURED_HOST,
  OPENAI_COMPATIBLE_NPM,
  redactText,
  secretForms,
  startManagedHost,
  type PluginInstall,
  type ProviderBlock,
  type StopOutcome,
} from "../ablation/managed-host.ts"
import type { RosterSlot } from "../core/domain/roster.ts"
import { emptyLedger, type TokenUsage } from "../core/domain/run-record.ts"
import { CODING_DISCOVERY_GENERALIST } from "../core/instructions/coding/discovery.ts"
import type { AdmissionDecision, AdmissionRequest, RequestAdmission } from "../core/ports/admission.ts"
import { systemClock } from "../core/ports/clock.ts"
import type { LateUsageReporter } from "../core/ports/late-usage.ts"
import type { ModelBackend } from "../core/ports/model-backend.ts"
import { selectRoster } from "../core/roster/select.ts"
import { discover } from "../core/stages/discover.ts"

export const EVIDENCE_KIND =
  "MEASURED RUNTIME CASES — the zero-bill real-host request accounting probe (story 2-8c): a real `opencode serve` " +
  "whose only provider is a local stub"

export const EVIDENCE_FILE = "host-accounting.json"

/** The whole probe. A 500 scenario alone waits out two runs of the host's retry backoff. */
export const PROBE_DEADLINE_MS = 1_200_000
/** How long a probe body is given to settle after the deadline aborts it, before cleanup runs anyway. */
export const BODY_SETTLE_MS = 30_000
/**
 * The adapter's turn deadline in every scenario but the hang. It outlasts the
 * host's six-try backoff (about 71 s); the production default, 600,000 ms, does too.
 */
export const SCENARIO_TURN_TIMEOUT_MS = 150_000
export const PRODUCTION_TURN_TIMEOUT_MS = 600_000
/** The hang scenario's turn deadline, and how long the stub is watched after the adapter gives up. */
export const HANG_TURN_TIMEOUT_MS = 5_000
export const HANG_OBSERVE_MS = 15_000

/** The dummy credential and its variable. It is no provider's key; it is redacted anyway. */
export const STUB_KEY_ENV = "MAD_PROBE_STUB_KEY"
export const STUB_KEY = "mad-probe-stub-key-not-a-credential"
export const STUB_PROVIDER = "stub"
export const STUB_MODEL = "m1"

/** The material every scenario's discover turn reviews. Its content is irrelevant to the count. */
const PROBE_INPUT = "--- a/pay.ts\n+++ b/pay.ts\n@@ -1 +1 @@\n-const fee = 0\n+const fee = total * rate\n"

export type Verdict = "HOLDS" | "FAILS"

export interface Scenario {
  name: string
  what: string
  queue: StubBehaviour[]
  otherwise: StubBehaviour
  /** The adapter's existing `tools` option, when the scenario sets it. */
  tools?: Record<string, boolean>
  turnTimeoutMs: number
  /** How long the stub is watched after `discover` returns. */
  observeAfterMs: number
  /** Journal lines written before the scenario runs, so a gate refuses partway through it. */
  seed?: JournalLine[]
}

/** How far below block 1's prefix allowance the step-refusal scenario starts: less than one stub answer. */
export const STEP_REFUSAL_HEADROOM = 500

export const SCENARIOS: readonly Scenario[] = [
  { name: "success", what: "the stub answers every request with a StructuredOutput call", queue: [], otherwise: "ok", turnTimeoutMs: SCENARIO_TURN_TIMEOUT_MS, observeAfterMs: 0 },
  { name: "persistent 500", what: "the stub answers every request with HTTP 500", queue: [], otherwise: "500", turnTimeoutMs: SCENARIO_TURN_TIMEOUT_MS, observeAfterMs: 0 },
  { name: "429 then success", what: "the first request gets HTTP 429, every later one a success", queue: ["429"], otherwise: "ok", turnTimeoutMs: SCENARIO_TURN_TIMEOUT_MS, observeAfterMs: 0 },
  { name: "400", what: "the first request gets HTTP 400, every later one a success", queue: ["400"], otherwise: "ok", turnTimeoutMs: SCENARIO_TURN_TIMEOUT_MS, observeAfterMs: 0 },
  {
    name: "hang past the adapter timeout",
    what: `every request hangs; the adapter gives up at ${HANG_TURN_TIMEOUT_MS} ms and the stub is watched for ${HANG_OBSERVE_MS} ms more`,
    queue: [],
    otherwise: "hang",
    turnTimeoutMs: HANG_TURN_TIMEOUT_MS,
    observeAfterMs: HANG_OBSERVE_MS,
  },
  {
    name: "host-tool step",
    what: "the first answer calls the host tool `glob`; every later one is a StructuredOutput call (host tools offered by default)",
    queue: ["tool:glob"],
    otherwise: "ok",
    turnTimeoutMs: SCENARIO_TURN_TIMEOUT_MS,
    observeAfterMs: 0,
  },
  {
    name: "unoffered tool",
    what: 'the first answer calls `glob`, which is not offered under `tools: {"*":false,"StructuredOutput":true}`; every later one is a StructuredOutput call',
    queue: ["tool:glob"],
    otherwise: "ok",
    tools: { "*": false, StructuredOutput: true },
    turnTimeoutMs: SCENARIO_TURN_TIMEOUT_MS,
    observeAfterMs: 0,
  },
  {
    name: "step refused mid-turn",
    what:
      `the first answer calls \`glob\`; block 1's prefix is seeded ${STEP_REFUSAL_HEADROOM} tokens short of its allowance, so ` +
      "the first request's usage exhausts it and the journal refuses the tool step",
    queue: ["tool:glob"],
    otherwise: "ok",
    turnTimeoutMs: SCENARIO_TURN_TIMEOUT_MS,
    observeAfterMs: 0,
    seed: seededSpend("blocks", 1, "prefix", PAIRED_ALLOWANCES.prefix - STEP_REFUSAL_HEADROOM),
  },
]

// ---------------------------------------------------------------------------
// The verdict logic (pure; unit-tested with fakes)
// ---------------------------------------------------------------------------

/** One admitted attempt: the session its backend opened on the relay, and when the stage settled it. */
export interface AdmissionMark {
  attempt: number
  /** The session the backend opened on the relay for this attempt; absent when it opened none. */
  session?: string
  settledAt?: number
}

export type RecordedUsage =
  | { kind: "usage"; tokens: TokenUsage }
  | { kind: "unknown"; why: string }
  | { kind: "not-issued" }
  | { kind: "missing" }

/** One physical request: what the relay forwarded, what the stub received and served, and what the journal holds. */
export interface PhysicalRecord {
  /** The request's place in its attempt: 1 for the first, 2… for each step. */
  step: number
  issued: IssuedLine | null
  settled: SettledLine | null
  /** The stub's record of it; `null` when it never reached the stub. */
  stub: StubRequest | null
  served: { input: number; output: number } | null
  recorded: RecordedUsage
  /** For a request that never answered: how long after the attempt ended the relay closed it, and who closed it. */
  upstream?: { closedAfterAttemptMs: number | null; closedBy: "client" | "host-stopping" | "still open" }
  verdict: Verdict
  why: string
}

export interface AttemptRecord {
  attempt: number
  session: string | null
  issued: IssuedLine | null
  /** Every physical request the relay forwarded for this attempt, in order. */
  physical: PhysicalRecord[]
  /** Step admissions that were granted and then not forwarded, and how each was settled. */
  admittedNotForwarded: { step: number; recorded: RecordedUsage }[]
  /** What the relay refused for this attempt's session, in order. */
  relayRefusals: string[]
  /** Why this attempt's verdict is incomplete, or `null`. */
  incomplete: string | null
  verdict: Verdict
  why: string
}

export interface ScenarioTotals {
  admittedAttempts: number
  /** MAD's own discover retry: admitted attempts beyond the first. */
  madRetries: number
  refusedAdmissions: number
  /** Model requests the stub received: the physical requests that reached the provider. */
  physicalRequests: number
  /** Requests the relay forwarded after admitting them as steps. */
  admittedSteps: number
  /** Requests the relay refused as the host retrying a failed one. */
  hostRetriesRefused: number
  /** Requests the relay refused for any other reason (a step whose admission was refused, a closed attempt…). */
  otherRelayRefusals: number
  /** Model requests no forwarded request accounts for. */
  unattributedRequests: number
  servedInput: number
  servedOutput: number
  recordedInput: number
  recordedOutput: number
  /** Forwarded requests settled `unknown`. */
  unknownRequests: number
}

/** How long after an attempt ended the relay may take to close a request still open upstream. */
export const UPSTREAM_CLOSE_BOUND_MS = 5_000

/** The settlement as the probe records it. A kind it does not recognise is recorded as unknown, named. */
export function recordedOf(settled: SettledLine | null): RecordedUsage {
  // Read as untyped: the line came off disk, and a kind this probe does not know must not pass as a known one.
  const settlement = settled?.settlement as { kind?: unknown; tokens?: TokenUsage; why?: unknown } | undefined | null
  if (settlement === undefined || settlement === null) return { kind: "missing" }
  if (settlement.kind === "usage" && settlement.tokens !== undefined) return { kind: "usage", tokens: settlement.tokens }
  if (settlement.kind === "unknown") return { kind: "unknown", why: String(settlement.why) }
  if (settlement.kind === "not-issued") return { kind: "not-issued" }
  return { kind: "unknown", why: `the settlement's kind ${JSON.stringify(settlement.kind)} is not one the probe recognises` }
}

/** The journal's lines, paired by physical id, in issue order. */
export function pairLines(lines: readonly JournalLine[]): { issued: IssuedLine; settled: SettledLine | null }[] {
  const pairs: { issued: IssuedLine; settled: SettledLine | null }[] = []
  for (const line of lines) {
    if (line.type === "issued") pairs.push({ issued: line, settled: null })
    else if (line.type === "settled") {
      const pair = pairs.find((entry) => entry.issued.physicalId === line.physicalId)
      if (pair !== undefined && pair.settled === null) pair.settled = line
    }
  }
  return pairs
}

/**
 * One forwarded request against the invariant: it was admitted by a durable
 * `issued` line, it reached the stub once, and the journal settled it with what
 * the stub served, or `unknown` when the stub served nothing.
 */
export function physicalRecord(
  step: number,
  pair: { issued: IssuedLine; settled: SettledLine | null } | undefined,
  stub: StubRequest | null,
  event: RelayEvent,
): PhysicalRecord {
  const recorded = recordedOf(pair?.settled ?? null)
  const served = stub?.servedUsage === undefined ? null : { input: stub.servedUsage.prompt_tokens, output: stub.servedUsage.completion_tokens }
  const problems: string[] = []
  if (pair === undefined) problems.push("the relay forwarded it with no `issued` line in the journal")
  if (stub === null) problems.push("the relay forwarded it and the stub never received it")
  if (stub?.placeholderKey === true) problems.push("it reached the stub with the host's placeholder key, not the relay's credential")
  if (recorded.kind === "missing" && pair !== undefined) problems.push("the journal holds no `settled` line for it")
  if (recorded.kind === "not-issued") problems.push("it reached the provider, and MAD settled it not-issued")
  if (recorded.kind === "usage") {
    if (served === null) problems.push(`MAD recorded ${recorded.tokens.input} in / ${recorded.tokens.output} out, and the stub served no usage`)
    else if (recorded.tokens.input !== served.input || recorded.tokens.output !== served.output) {
      problems.push(`MAD recorded ${recorded.tokens.input} in / ${recorded.tokens.output} out; the stub served ${served.input} in / ${served.output} out`)
    }
    if (recorded.tokens.reasoning + recorded.tokens.cacheRead + recorded.tokens.cacheWrite !== 0) problems.push("MAD recorded reasoning or cache tokens the stub never served")
  } else if (recorded.kind === "unknown" && served !== null) {
    problems.push(`MAD recorded it unknown, and the stub served ${served.input} in / ${served.output} out`)
  }
  let upstream: PhysicalRecord["upstream"]
  if (stub !== null && stub.behaviour === "hang") {
    const closedBy = stub.closed === undefined ? ("still open" as const) : stub.closed.by
    upstream = { closedAfterAttemptMs: event.closedAfterClose ?? null, closedBy }
    if (closedBy !== "client") {
      problems.push(
        closedBy === "host-stopping"
          ? "the provider request stayed open after the attempt ended, until the probe stopped the host"
          : "the provider request was still open when the stub stopped recording",
      )
    } else if (upstream.closedAfterAttemptMs === null || upstream.closedAfterAttemptMs > UPSTREAM_CLOSE_BOUND_MS) {
      problems.push(
        `the provider request was closed ${upstream.closedAfterAttemptMs === null ? "before the attempt ended, by the host" : `${upstream.closedAfterAttemptMs} ms after the attempt ended`}, ` +
          `not by the relay within ${UPSTREAM_CLOSE_BOUND_MS} ms of it`,
      )
    }
  }
  const holds = problems.length === 0
  const figure =
    recorded.kind === "usage"
      ? "settled with the usage the stub served"
      : recorded.kind === "unknown"
        ? `settled unknown (${recorded.why}); the stub served no usage`
        : `settled ${recorded.kind}`
  return {
    step,
    issued: pair?.issued ?? null,
    settled: pair?.settled ?? null,
    stub,
    served,
    recorded,
    ...(upstream === undefined ? {} : { upstream }),
    verdict: holds ? "HOLDS" : "FAILS",
    why: holds
      ? `admitted before it was forwarded, reached the stub once, ${figure}` +
        (upstream === undefined ? "" : `; the relay closed it ${upstream.closedAfterAttemptMs} ms after the attempt ended`)
      : problems.join("; "),
  }
}

const RETRY_REFUSAL = "it follows a failed request of the same attempt"
const UNATTRIBUTED_REFUSALS = ["it names no session", "its two session headers disagree", "its session was not opened with an admitted attempt"]

/**
 * Every admitted attempt, with each physical request the relay forwarded for it.
 *
 * The relay's forwarded events and the stub's model requests are paired by
 * session and, within a session, by order: the relay is the stub's only client
 * and passes the session header on. The events are split between attempts by the
 * session each attempt's backend opened, and each is paired with the journal's
 * `issued` line for its attempt and step. A forwarded request no admitted
 * attempt's session accounts for is unattributed, as is a stub request no
 * forwarded one does.
 */
export function attemptsOf(
  marks: readonly AdmissionMark[],
  pairs: readonly { issued: IssuedLine; settled: SettledLine | null }[],
  events: readonly RelayEvent[],
  requests: readonly StubRequest[],
): { attempts: AttemptRecord[]; unattributed: StubRequest[]; unattributedRefusals: RelayEvent[] } {
  const model = requests.filter((request) => request.model)
  const forwarded = events.filter((event) => event.outcome === "forwarded")
  const stubOf = new Map<RelayEvent, StubRequest | null>()
  const used = new Set<StubRequest>()
  for (const event of forwarded) {
    const stub = model.find((request) => !used.has(request) && request.session === event.session) ?? null
    if (stub !== null) used.add(stub)
    stubOf.set(event, stub)
  }
  const sessions = new Set(marks.flatMap((mark) => (mark.session === undefined ? [] : [mark.session])))
  const orphans = forwarded.filter((event) => event.session === null || !sessions.has(event.session))
  // A stub request with no forwarded counterpart, or behind a forwarded request no attempt accounts for.
  const unattributed = [
    ...model.filter((request) => !used.has(request)),
    ...orphans.flatMap((event) => (stubOf.get(event) === null || stubOf.get(event) === undefined ? [] : [stubOf.get(event)!])),
  ]
  const unattributedRefusals = [
    ...events.filter((event) => event.outcome === "refused" && UNATTRIBUTED_REFUSALS.includes(event.reason ?? "")),
    // A forwarded request whose session no admitted attempt opened, recorded as such even when it never reached the stub.
    ...orphans.filter((event) => stubOf.get(event) === null).map((event) => ({ ...event, reason: "forwarded for a session no admitted attempt opened" })),
  ]
  const firstPairs = pairs.filter((pair) => pair.issued.step === undefined)
  const mismatch =
    firstPairs.length === marks.length
      ? undefined
      : `the journal holds ${firstPairs.length} attempt line(s) for ${marks.length} admitted attempt(s), so no attempt can be paired with its lines`
  const attempts = marks.map((mark): AttemptRecord => {
    const own = pairs.filter((pair) => pair.issued.attempt === mark.attempt)
    const pairFor = (step: number) => own.find((pair) => (pair.issued.step ?? 1) === step)
    const sessionEvents = mark.session === undefined ? [] : events.filter((event) => event.session === mark.session)
    const physical = sessionEvents
      .filter((event) => event.outcome === "forwarded")
      .map((event) => physicalRecord(event.step ?? 0, mismatch === undefined ? pairFor(event.step ?? 0) : undefined, stubOf.get(event) ?? null, event))
    const forwardedSteps = new Set(physical.map((record) => record.step))
    const admittedNotForwarded = own
      .filter((pair) => !forwardedSteps.has(pair.issued.step ?? 1))
      .map((pair) => ({ step: pair.issued.step ?? 1, recorded: recordedOf(pair.settled) }))
    const relayRefusals = sessionEvents.filter((event) => event.outcome === "refused").map((event) => event.reason ?? "no reason recorded")
    const incompleteReasons = [
      ...(mismatch === undefined ? [] : [mismatch]),
      ...(pairFor(1) === undefined ? ["the journal holds no `issued` line for its first request"] : []),
      ...own.filter((pair) => pair.settled === null).map((pair) => `the journal holds no \`settled\` line for request ${pair.issued.step ?? 1}`),
    ]
    const problems = [
      ...incompleteReasons,
      ...physical.filter((record) => record.verdict === "FAILS").map((record) => `request ${record.step}: ${record.why}`),
      ...admittedNotForwarded
        .filter((entry) => entry.step === 1 ? !(entry.recorded.kind === "usage" && spentOf(entry.recorded.tokens) === 0) : entry.recorded.kind !== "not-issued")
        .map((entry) => `request ${entry.step} was admitted and never forwarded, and was settled ${entry.recorded.kind}${entry.recorded.kind === "usage" ? " with a non-zero figure" : ""}`),
    ]
    const retries = relayRefusals.filter((reason) => reason.startsWith(RETRY_REFUSAL)).length
    return {
      attempt: mark.attempt,
      session: mark.session ?? null,
      issued: pairFor(1)?.issued ?? null,
      physical,
      admittedNotForwarded,
      relayRefusals,
      incomplete: incompleteReasons.length === 0 ? null : incompleteReasons.join("; "),
      verdict: problems.length === 0 ? "HOLDS" : "FAILS",
      why:
        problems.length === 0
          ? `${physical.length} physical request(s), each admitted before it was forwarded and settled with its own figure` +
            (retries === 0 ? "" : `; ${retries} host retr${retries === 1 ? "y" : "ies"} refused by the relay, none forwarded`) +
            (relayRefusals.length > retries ? `; ${relayRefusals.length - retries} other request(s) refused by the relay` : "")
          : problems.join("; "),
    }
  })
  return { attempts, unattributed, unattributedRefusals }
}

function spentOf(tokens: TokenUsage): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite
}

export function scenarioVerdict(
  attempts: readonly AttemptRecord[],
  unattributed: readonly StubRequest[],
  unattributedRefusals: readonly RelayEvent[],
  refusedAdmissions: number,
  integrity: readonly string[],
): { verdict: Verdict; complete: boolean; why: string; totals: ScenarioTotals } {
  const physical = attempts.flatMap((attempt) => attempt.physical)
  const refusals = attempts.flatMap((attempt) => attempt.relayRefusals)
  const retries = refusals.filter((reason) => reason.startsWith(RETRY_REFUSAL)).length
  const known = physical.flatMap((record) => (record.recorded.kind === "usage" ? [record.recorded.tokens] : []))
  const totals: ScenarioTotals = {
    admittedAttempts: attempts.length,
    madRetries: Math.max(0, attempts.length - 1),
    refusedAdmissions,
    physicalRequests: physical.filter((record) => record.stub !== null).length + unattributed.length,
    admittedSteps: physical.filter((record) => record.step > 1).length,
    hostRetriesRefused: retries,
    otherRelayRefusals: refusals.length - retries + unattributedRefusals.length,
    unattributedRequests: unattributed.length,
    servedInput: [...physical.map((record) => record.served?.input ?? 0), ...unattributed.map((request) => request.servedUsage?.prompt_tokens ?? 0)].reduce((a, b) => a + b, 0),
    servedOutput: [...physical.map((record) => record.served?.output ?? 0), ...unattributed.map((request) => request.servedUsage?.completion_tokens ?? 0)].reduce((a, b) => a + b, 0),
    recordedInput: known.reduce((total, tokens) => total + tokens.input, 0),
    recordedOutput: known.reduce((total, tokens) => total + tokens.output, 0),
    unknownRequests: physical.filter((record) => record.recorded.kind === "unknown").length,
  }
  const complete = attempts.length > 0 && attempts.every((attempt) => attempt.incomplete === null)
  const reasons = [
    ...attempts.filter((attempt) => attempt.verdict === "FAILS").map((attempt) => `attempt ${attempt.attempt}: ${attempt.why}`),
    ...(unattributed.length > 0 ? [`${unattributed.length} physical request(s) reached the stub that the relay did not forward`] : []),
    ...(unattributedRefusals.length > 0
      ? [`the relay could not attribute ${unattributedRefusals.length} request(s) to an admitted attempt (${[...new Set(unattributedRefusals.map((event) => event.reason))].join("; ")})`]
      : []),
    ...integrity.map((reason) => `the journal recorded an integrity failure: ${reason}`),
    ...(attempts.length === 0 ? ["no attempt was admitted"] : []),
  ]
  return {
    verdict: reasons.length === 0 ? "HOLDS" : "FAILS",
    complete,
    why:
      reasons.length === 0
        ? `every physical request (${totals.physicalRequests}) was admitted before it was forwarded and settled with its own figure` +
          (retries === 0 ? "" : `; ${retries} host retr${retries === 1 ? "y was" : "ies were"} refused by the relay and never reached the stub`)
        : reasons.join("; "),
    totals,
  }
}

export type GateName = "global" | "Blocks" | "phase"

export interface GateTwoRecord {
  gate: GateName
  seeded: string
  refusals: { cause: string; reason: string }[]
  backendCalls: number
  stubRequests: number
  issuedLinesAfter: number
  issuedLinesSeeded: number
  /** How the case's host was stopped; a stop that is not confirmed fails the probe before this is recorded. */
  hostStop: string
  holds: boolean
  why: string
}

/** A gate-2 case holds when exactly its own gate refused, and nothing was called, requested or issued. */
export function gateTwoVerdict(input: Omit<GateTwoRecord, "holds" | "why">, expected: string): GateTwoRecord {
  const problems: string[] = []
  if (input.refusals.length === 0) problems.push("no admission was refused")
  else if (!input.refusals.every((refusal) => refusal.cause === "budget" && refusal.reason.includes(expected))) {
    problems.push(`the refusal was not the ${input.gate} gate's (${input.refusals.map((refusal) => `${refusal.cause}: ${refusal.reason}`).join("; ")})`)
  }
  if (input.backendCalls !== 0) problems.push(`${input.backendCalls} backend call(s) were made`)
  if (input.stubRequests !== 0) problems.push(`the stub received ${input.stubRequests} request(s)`)
  if (input.issuedLinesAfter !== input.issuedLinesSeeded) problems.push("the journal gained an `issued` line")
  return {
    ...input,
    holds: problems.length === 0,
    why:
      problems.length === 0
        ? "refused inside the journal's admission, before any backend call; 0 requests reached the stub; no `issued` line added"
        : problems.join("; "),
  }
}

// ---------------------------------------------------------------------------
// The evidence
// ---------------------------------------------------------------------------

export interface ScenarioRecord {
  name: string
  what: string
  tools: Record<string, boolean> | "the adapter's default (no `tools` option: host tools offered)"
  stubScript: { queue: StubBehaviour[]; otherwise: StubBehaviour }
  turnTimeoutMs: number
  attempts: AttemptRecord[]
  unattributedRequests: StubRequest[]
  /** Relay refusals no admitted attempt's session accounts for. */
  unattributedRefusals: RelayEvent[]
  refusedAdmissions: { cause: string; reason: string }[]
  /** The journal's integrity failures, including the stage's cross-check of each attempt's sum. */
  integrity: string[]
  totals: ScenarioTotals
  verdict: Verdict
  complete: boolean
  why: string
  hostStop: string
  proxyAttempts: ProxyAttempt[]
}

export interface HostIdentity {
  binary: string
  sha256: string
  version: string
  measuredHost: { version: string; sha256: string }
  matchesMeasuredHost: boolean
  environmentKeys: string[]
  generatedConfig: Record<string, unknown>
  reportedConfig: unknown
  /** What the first scenario's host plugin install left, read just before that host was stopped. */
  pluginInstall?: PluginInstall
}

export interface ProbeEvidence {
  kind: string
  story: "2-8c2"
  measuredAt: string
  paidTokens: string
  isolation: string[]
  egress: string
  host: HostIdentity
  scenarios: ScenarioRecord[]
  gateTwo: GateTwoRecord[]
  gateTwoScope: string
  proxyAttempts: ProxyAttempt[]
  findings: { id: string; text: string }[]
  scope: string[]
}

/** The findings, each stated from what this run's scenarios measured, naming the scenario. */
export function findingsFrom(scenarios: readonly ScenarioRecord[]): { id: string; text: string }[] {
  const named = (name: string) => scenarios.find((scenario) => scenario.name === name)
  const missing = (name: string) => `scenario \`${name}\` did not run, so this run measured nothing for it`
  const figures = (scenario: ScenarioRecord) =>
    `MAD recorded ${scenario.totals.recordedInput} in / ${scenario.totals.recordedOutput} out; the stub served ` +
    `${scenario.totals.servedInput} in / ${scenario.totals.servedOutput} out`
  const retried = (name: string) => {
    const scenario = named(name)
    return scenario === undefined
      ? missing(name)
      : `\`${name}\`: ${scenario.totals.physicalRequests} request(s) reached the stub, ${scenario.totals.hostRetriesRefused} host retr` +
          `${scenario.totals.hostRetriesRefused === 1 ? "y was" : "ies were"} refused by the relay, and ${scenario.totals.unknownRequests} ` +
          `forwarded request(s) were settled unknown`
  }
  const stepped = (name: string) => {
    const scenario = named(name)
    return scenario === undefined
      ? missing(name)
      : `\`${name}\`: ${scenario.totals.admittedSteps} step(s) admitted before forwarding, ${scenario.totals.physicalRequests} ` +
          `request(s) reached the stub, and ${figures(scenario)}`
  }
  const hang = named("hang past the adapter timeout")
  const held = hang?.attempts.flatMap((attempt) => attempt.physical).find((record) => record.upstream !== undefined)?.upstream
  const refused = named("step refused mid-turn")
  const forwarded = scenarios.flatMap((scenario) => scenario.attempts.flatMap((attempt) => attempt.physical))
  const unattributable = scenarios.reduce((total, scenario) => total + scenario.unattributedRefusals.length, 0)
  return [
    {
      id: "F2",
      text:
        "the host's own retry of a failed provider request. Measured through the relay: " +
        ["persistent 500", "429 then success", "400"].map(retried).join("; ") +
        ". A refused retry never reaches the provider, and a failed request is settled unknown, which latches the journal's halt",
    },
    { id: "F3", text: `a host tool step, with host tools offered by default. ${stepped("host-tool step")}` },
    {
      id: "N2",
      text:
        `a call to a tool that was not offered (\`tools: {"*":false,"StructuredOutput":true}\`). ${stepped("unoffered tool")}. ` +
        'Whether a real provider emits such a call under `tool_choice: "required"` is not established',
    },
    {
      id: "H1",
      text:
        hang === undefined
          ? `a request that outlives the adapter's deadline: ${missing("hang past the adapter timeout")}`
          : held === undefined
            ? "in the hang scenario every provider request answered, so nothing was held open"
            : held.closedBy === "client"
              ? `in the hang scenario the relay closed the provider request ${held.closedAfterAttemptMs ?? "an unmeasured number of"} ms after the attempt ended`
              : `in the hang scenario the provider request stayed open after the attempt ended, ${held.closedBy === "host-stopping" ? "until the probe stopped the host" : "and it was still open when the stub stopped recording"}`,
    },
    {
      id: "S1",
      text:
        refused === undefined
          ? `a step whose admission is refused: ${missing("step refused mid-turn")}`
          : `a step whose admission the journal refused mid-turn: ${refused.totals.otherRelayRefusals} request(s) refused by the relay, ` +
            `${refused.totals.physicalRequests} reached the stub, and ${figures(refused)}`,
    },
    {
      id: "A1",
      text:
        `attribution by the host's session headers: ${forwarded.length} request(s) were forwarded, each naming an attempt's session ` +
        `in both \`x-session-affinity\` and \`X-Session-Id\`, and ${unattributable} request(s) were refused because they did not. ` +
        "This is a fact about the measured host, not an opencode contract",
    },
  ]
}

export const GATE_TWO_SCOPE =
  "on the measured host, each of the global, Blocks and phase gates refused inside the journal's admission, before any " +
  "backend call, and 0 requests reached the stub. Only block 1's prefix phase was exercised, with one slot; no " +
  "concurrent or multi-slot admission was tested, and the Adversarial gate was not exercised"

export function buildEvidence(input: {
  measuredAt: string
  host: HostIdentity
  scenarios: ScenarioRecord[]
  gateTwo: GateTwoRecord[]
  proxyAttempts: ProxyAttempt[]
}): ProbeEvidence {
  return {
    kind: EVIDENCE_KIND,
    story: "2-8c2",
    measuredAt: input.measuredAt,
    paidTokens:
      "none. The host held only the relay's placeholder key, its only configured provider was the relay on 127.0.0.1, " +
      "and the relay's one upstream was the local stub on 127.0.0.1, with a fixed dummy key. Nothing bills.",
    isolation: [
      "the host's environment was built from nothing (as `env -i`): a fixed system PATH, HOME and " +
        "XDG_CONFIG/DATA/CACHE/STATE_HOME in private temporary directories, OPENCODE_CONFIG, " +
        "OPENCODE_DISABLE_MODELS_FETCH=1, OPENCODE_DISABLE_PROJECT_CONFIG=1, the credential variable set to the relay's placeholder key, and " +
        "HTTP(S)_PROXY at a local refusing proxy with NO_PROXY=127.0.0.1",
      "the effective config was the fixed host settings plus one `@ai-sdk/openai-compatible` provider block, verified " +
        "through `GET /config` (for the host's directory and the session directory) and `GET /config/providers` before " +
        "any client call, on every host start",
      "a fresh host and a fresh relay were started for every scenario and every gate-2 case, and each host's exit was " +
        "confirmed: see each record's `hostStop`",
      "the host's provider block pointed at the relay (`ablation/request-meter.ts`), which admitted each physical request " +
        "through the journal before forwarding it to the stub, and set the stub's key in place of the host's placeholder: " +
        "see each stub request's `placeholderKey`",
      "the host is not offline: the first time it runs a prompt it tries `npm install @opencode-ai/plugin`, and " +
        (input.proxyAttempts.some((attempt) => attempt.line.includes("registry.npmjs.org"))
          ? "its attempts to reach registry.npmjs.org appear among the refused proxy attempts"
          : "no attempt to reach registry.npmjs.org was among the refused proxy attempts in this run"),
    ],
    egress:
      "the proxy refused and listed the request line of every connection a proxy-honouring client opened to it and " +
      "sent one on; direct egress was NOT shown to be blocked, so `proxyAttempts` lists the proxy attempts refused, not " +
      "every outbound attempt",
    host: input.host,
    scenarios: input.scenarios,
    gateTwo: input.gateTwo,
    gateTwoScope: GATE_TWO_SCOPE,
    proxyAttempts: input.proxyAttempts,
    findings: findingsFrom(input.scenarios),
    scope: [
      `opencode ${input.host.version} (binary sha256 ${input.host.sha256}) on this machine, one provider package ` +
        `(${OPENAI_COMPATIBLE_NPM}), one model, one-slot discover, the scripted behaviours above; not every host, build, ` +
        "provider, stage or failure",
      "each forwarded request is attributed to its attempt by the session the attempt's backend opened on the relay, and to " +
        "the stub's record of it by order: the relay is the stub's only client",
      `the adapter's turn deadline was ${SCENARIO_TURN_TIMEOUT_MS} ms (${HANG_TURN_TIMEOUT_MS} ms in the hang scenario); ` +
        `the production default is ${PRODUCTION_TURN_TIMEOUT_MS} ms, which also outlasts the host's six-try retry series`,
      `the hang scenario watched the stub for ${HANG_OBSERVE_MS} ms after the adapter gave up, and says nothing about later`,
      "a HOLDS verdict is about admission, forwarding and usage for that scenario only",
      "the stub's 429 carries no Retry-After or rate-limit header; F2's 429 figure covers that one response shape",
      `the relay is given ${UPSTREAM_CLOSE_BOUND_MS} ms to close a request still open when its attempt ends`,
    ],
  }
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

/** Anything the probe must stop on its way out. */
export interface Stoppable {
  stop(): Promise<StopOutcome>
}

/** A host a scenario runs against: the real managed host, or a test's stand-in. */
export interface ProbeHost extends Stoppable {
  url: string
  pluginInstall?(): Promise<PluginInstall>
}

export interface ProbeContext {
  out: string
  stub: AccountingStub
  proxy: RefusingProxy
  workDir: string
  scratchParent: string
  /** Hosts spawned and not yet confirmed stopped, for the deadline and the signals. */
  live: Set<Stoppable>
  /** Fires when the probe deadline passes: no further host is started and no further scenario runs. */
  signal: AbortSignal
  identity?: HostIdentity
  /** The relay the current host's provider block points at; set for each host before it starts. */
  relay?: RequestMeter
  /** Starts a host for one scenario. The default is the verified managed host. */
  startHost?: (context: ProbeContext) => Promise<ProbeHost>
  /** Builds the backend a scenario's discover turn uses. The default is `OpencodeModelBackend`. */
  backendFor?: (
    host: ProbeHost,
    options: {
      directory: string
      slots: RosterSlot[]
      timeoutMs: number
      lateUsage: LateUsageReporter
      meter: RequestMeterPort
      tools?: Record<string, boolean>
    },
  ) => ModelBackend
  /** Starts the relay for one host. The default is `startRequestMeter` in front of the stub. */
  startRelay?: (context: ProbeContext) => RequestMeter
}

const slug = (name: string) => name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()

/** The host's provider block: the relay, which forwards to the stub. */
function relayBlock(relay: RequestMeter): ProviderBlock {
  return { id: STUB_PROVIDER, npm: OPENAI_COMPATIBLE_NPM, baseURL: relay.baseURL, apiKeyEnv: STUB_KEY_ENV, models: [STUB_MODEL] }
}

/** The relay in front of the stub, holding the stub's dummy key; the host gets the placeholder. */
function stubRelay(context: ProbeContext): RequestMeter {
  return startRequestMeter({ upstream: context.stub.baseURL, credential: STUB_KEY })
}

function stopIfAborted(context: ProbeContext, what: string): void {
  if (context.signal.aborted) throw new Error(`the probe deadline passed, so ${what} was not started`)
}

/** The real managed host, registered in `live` the moment it is spawned. */
export async function managedProbeHost(context: ProbeContext): Promise<ProbeHost> {
  let spawned: Stoppable | undefined
  if (context.relay === undefined) throw new Error("no relay was started for this host")
  const started = await startManagedHost({
    block: relayBlock(context.relay),
    credential: context.relay.hostKey,
    proxy: context.proxy.url,
    scratchParent: context.scratchParent,
    verifyDirectories: [context.workDir],
    signals: null,
    onSpawn: (host) => {
      spawned = host
      context.live.add(host)
    },
  })
  if (!started.ok) {
    // A refused host was stopped by the refusal; it stays in `live` only when that stop was not confirmed.
    if (spawned !== undefined && (started.stopped === null || started.stopped.confirmed)) context.live.delete(spawned)
    throw new Error(
      `the managed host was refused: ${started.reason}` +
        (started.stopped !== null && !started.stopped.confirmed ? `; its exit is UNCONFIRMED (process ${started.stopped.pid}): ${started.stopped.why}` : ""),
    )
  }
  const host = started.host
  context.identity ??= {
    binary: host.binary,
    sha256: host.sha256,
    version: host.version,
    measuredHost: { version: MEASURED_HOST.version, sha256: MEASURED_HOST.sha256 },
    matchesMeasuredHost: host.sha256 === MEASURED_HOST.sha256 && host.version === MEASURED_HOST.version,
    environmentKeys: host.environmentKeys,
    generatedConfig: host.config,
    reportedConfig: host.reportedConfig,
  }
  return { url: host.url, stop: host.stop, pluginInstall: host.pluginInstall }
}

async function stopHost(context: ProbeContext, host: ProbeHost): Promise<string> {
  context.stub.hostStopping()
  if (context.identity !== undefined && context.identity.pluginInstall === undefined && host.pluginInstall !== undefined) {
    context.identity.pluginInstall = await host.pluginInstall()
  }
  const outcome = await host.stop()
  if (!outcome.confirmed) throw new Error(`the managed host's exit is UNCONFIRMED: check process ${outcome.pid} by hand (${outcome.why})`)
  for (const entry of context.live) if (entry.stop === host.stop) context.live.delete(entry)
  return `process ${outcome.pid} ${outcome.how}`
}

function countingBackend(inner: ModelBackend, calls: { count: number }): ModelBackend {
  return {
    capabilities: (slot) => inner.capabilities(slot),
    runTurn(slot, instructions, input, schema, signal, admitted) {
      calls.count += 1
      return inner.runTurn(slot, instructions, input, schema, signal, admitted)
    },
  }
}

function markingAdmission(inner: RequestAdmission, marks: AdmissionMark[], refusals: { cause: string; reason: string }[]): RequestAdmission {
  return {
    async admit(request: AdmissionRequest): Promise<AdmissionDecision> {
      const decision = await inner.admit(request)
      if (!decision.ok) {
        refusals.push({ cause: decision.cause, reason: decision.reason })
        return decision
      }
      const mark: AdmissionMark = { attempt: request.attempt }
      marks.push(mark)
      return {
        ...decision,
        settle: async (settlement) => {
          mark.settledAt ??= Date.now()
          await decision.settle(settlement)
        },
      }
    },
  }
}

/**
 * The relay, recording which admitted attempt opened each session. One slot runs
 * at a time, so the n-th session opened belongs to the n-th admitted attempt.
 */
function markingMeter(relay: RequestMeterPort, marks: AdmissionMark[], unmarked: string[]): RequestMeterPort {
  let opened = 0
  return {
    open(sessionID, admitted) {
      const mark = marks[opened]
      opened += 1
      if (mark !== undefined) mark.session = sessionID
      else unmarked.push(sessionID)
      return relay.open(sessionID, admitted)
    },
  }
}

async function journalLines(root: string): Promise<JournalLine[]> {
  const text = await readFile(join(root, JOURNAL_FILE), "utf8").catch(() => "")
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JournalLine)
}

/** One discover turn on a fresh host, against the journal in `root`. A cleanup failure never hides the turn's own error. */
async function discoverOnce(
  context: ProbeContext,
  root: string,
  options: { tools?: Record<string, boolean>; turnTimeoutMs: number; observeAfterMs: number },
): Promise<{
  marks: AdmissionMark[]
  refusals: { cause: string; reason: string }[]
  backendCalls: number
  hostStop: string
  events: RelayEvent[]
  integrity: string[]
  runId: string
}> {
  stopIfAborted(context, "another host")
  const clock = systemClock()
  const taken = await acquireLock(root, clock.now())
  if (!taken.ok) throw new Error(taken.reason)
  const opened = await openJournal(root, taken.lock, () => clock.now())
  if (!opened.ok) {
    await taken.lock.release()
    throw new Error(opened.reason)
  }
  const journal = opened.journal
  const marks: AdmissionMark[] = []
  const refusals: { cause: string; reason: string }[] = []
  const calls = { count: 0 }
  let host: ProbeHost | undefined
  let failure: { error: unknown } | undefined
  let hostStop = ""
  const runId = `probe-${slug(root.split("/").pop() ?? "run")}`
  let relay: RequestMeter | undefined
  let events: RelayEvent[] = []
  let integrity: string[] = []
  const unmarked: string[] = []
  try {
    relay = (context.startRelay ?? stubRelay)(context)
    context.relay = relay
    host = await (context.startHost ?? managedProbeHost)(context)
    const roster = selectRoster([{ providerId: STUB_PROVIDER, modelId: STUB_MODEL, toolcall: true }], { slots: 1, providerConfigKey: "provider" }).roster
    const backendOptions = {
      directory: context.workDir,
      slots: roster.slots,
      timeoutMs: options.turnTimeoutMs,
      lateUsage: journal.reporter(),
      meter: markingMeter(relay, marks, unmarked),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
    }
    const backend = (context.backendFor ?? ((probeHost, given) => new OpencodeModelBackend({ serverUrl: probeHost.url, ...given })))(host, backendOptions)
    await discover({
      roster,
      backend: countingBackend(backend, calls),
      instructions: CODING_DISCOVERY_GENERALIST,
      input: PROBE_INPUT,
      clock,
      ledger: emptyLedger(),
      admission: markingAdmission(journal.admission({ block: 1, phase: "prefix", runId: () => runId }), marks, refusals),
    })
    if (options.observeAfterMs > 0) await new Promise((done) => setTimeout(done, options.observeAfterMs))
    // Read before the host stops: what the relay did while MAD's turns ran, not what the stop does.
    events = relay.events()
    integrity = [
      ...journal.bill().integrity.map((failure) => failure.reason),
      ...unmarked.map((session) => `session \`${session}\` was opened on the relay with no admitted attempt to own it`),
    ]
    hostStop = await stopHost(context, host)
    host = undefined
  } catch (error) {
    failure = { error }
  }
  if (host !== undefined) {
    const stop = host.stop
    const outcome = await stop().catch((error: unknown): StopOutcome => ({ confirmed: false, pid: 0, why: messageOf(error) }))
    if (outcome.confirmed) {
      for (const entry of context.live) if (entry.stop === stop) context.live.delete(entry)
    } else {
      console.error(`the managed host's exit is UNCONFIRMED: check process ${outcome.pid} by hand (${outcome.why})`)
    }
  }
  await relay?.stop().catch((error: unknown) => console.error(`warning: the relay did not stop cleanly: ${messageOf(error)}`))
  context.relay = undefined
  try {
    const closed = await journal.close()
    if (closed.releaseError !== null) console.error(`warning: ${closed.releaseError}`)
  } catch (error) {
    if (failure === undefined) failure = { error }
    else console.error(`warning: the journal in \`${root}\` could not be closed: ${messageOf(error)}`)
  }
  if (failure !== undefined) throw failure.error
  return { marks, refusals, backendCalls: calls.count, hostStop, events, integrity, runId }
}

export async function runScenario(context: ProbeContext, scenario: Scenario): Promise<ScenarioRecord> {
  stopIfAborted(context, `scenario \`${scenario.name}\``)
  const root = join(context.out, "scenarios", slug(scenario.name))
  await mkdir(root, { recursive: true })
  if (scenario.seed !== undefined) await writeFile(join(root, JOURNAL_FILE), scenario.seed.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8")
  context.stub.reset({ queue: scenario.queue, otherwise: scenario.otherwise })
  const proxyBefore = context.proxy.attempts().length
  const run = await discoverOnce(context, root, scenario)
  const own = pairLines(await journalLines(root)).filter((pair) => pair.issued.runId === run.runId)
  const { attempts, unattributed, unattributedRefusals } = attemptsOf(run.marks, own, run.events, context.stub.requests())
  const verdict = scenarioVerdict(attempts, unattributed, unattributedRefusals, run.refusals.length, run.integrity)
  return {
    name: scenario.name,
    what: scenario.what,
    tools: scenario.tools ?? "the adapter's default (no `tools` option: host tools offered)",
    stubScript: { queue: scenario.queue, otherwise: scenario.otherwise },
    turnTimeoutMs: scenario.turnTimeoutMs,
    attempts,
    unattributedRequests: unattributed,
    unattributedRefusals,
    refusedAdmissions: run.refusals,
    integrity: run.integrity,
    ...verdict,
    hostStop: run.hostStop,
    proxyAttempts: context.proxy.attempts().slice(proxyBefore),
  }
}

/**
 * The seeded journal for each gate-2 case: known spend that reaches exactly that
 * gate's threshold and no earlier one's, read from `PAIRED_ALLOWANCES`.
 */
export const GATE_TWO_SEEDS: readonly { gate: GateName; expected: string; seeded: string; lines: JournalLine[] }[] = [
  {
    gate: "global",
    expected: "global cap is exhausted",
    seeded: `one settled Pilot request of ${PAIRED_ALLOWANCES.global} tokens: the global cap is reached, the Blocks allowance is untouched`,
    lines: seededSpend("pilot", null, null, PAIRED_ALLOWANCES.global),
  },
  {
    gate: "Blocks",
    expected: "Blocks allowance is exhausted",
    seeded:
      `one settled block-3 ON request of ${PAIRED_ALLOWANCES.blocks} tokens: the Blocks allowance is reached, the global ` +
      "cap and block 1's prefix are not",
    lines: seededSpend("blocks", 3, "on", PAIRED_ALLOWANCES.blocks),
  },
  {
    gate: "phase",
    expected: "shared prefix allowance is exhausted",
    seeded:
      `one settled block-1 prefix request of ${PAIRED_ALLOWANCES.prefix} tokens: block 1's prefix allowance is reached, ` +
      "the Blocks and global ones are not",
    lines: seededSpend("blocks", 1, "prefix", PAIRED_ALLOWANCES.prefix),
  },
]

function seededSpend(category: IssuedLine["category"], block: number | null, phase: IssuedLine["phase"], input: number): JournalLine[] {
  const physicalId = "seed-1"
  return [
    { type: "issued", physicalId, category, block, phase, stage: "discover", slot: "seed", attempt: 1, runId: `seed-${category}` },
    { type: "settled", physicalId, settlement: { kind: "usage", tokens: { input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } } },
  ]
}

export async function runGateTwo(context: ProbeContext, entry: (typeof GATE_TWO_SEEDS)[number]): Promise<GateTwoRecord> {
  stopIfAborted(context, `gate 2's ${entry.gate} case`)
  const root = join(context.out, "gate-2", slug(entry.gate))
  await mkdir(root, { recursive: true })
  await writeFile(join(root, JOURNAL_FILE), entry.lines.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8")
  context.stub.reset({ queue: [], otherwise: "ok" })
  const run = await discoverOnce(context, root, { turnTimeoutMs: SCENARIO_TURN_TIMEOUT_MS, observeAfterMs: 0 })
  const issued = (await journalLines(root)).filter((line) => line.type === "issued").length
  return gateTwoVerdict(
    {
      gate: entry.gate,
      seeded: entry.seeded,
      refusals: run.refusals,
      backendCalls: run.backendCalls,
      stubRequests: context.stub.requests().length,
      issuedLinesAfter: issued,
      issuedLinesSeeded: entry.lines.filter((line) => line.type === "issued").length,
      hostStop: run.hostStop,
    },
    entry.expected,
  )
}

function usageText(input: number, output: number): string {
  return `${input}/${output}`
}

function printTable(scenarios: readonly ScenarioRecord[], gateTwo: readonly GateTwoRecord[]): void {
  console.log("\nPer physical request (forwarded by the relay; served = what the stub answered with):")
  for (const scenario of scenarios) {
    for (const attempt of scenario.attempts) {
      for (const record of attempt.physical) {
        const recorded =
          record.recorded.kind === "usage" ? usageText(record.recorded.tokens.input, record.recorded.tokens.output) : record.recorded.kind
        const served = record.served === null ? "none" : usageText(record.served.input, record.served.output)
        console.log(
          `  ${scenario.name.padEnd(30)} attempt ${attempt.attempt} request ${record.step}  served ${served.padEnd(11)} ` +
            `recorded ${recorded.padEnd(11)} ${record.verdict} — ${record.why}`,
        )
      }
      for (const reason of attempt.relayRefusals) console.log(`  ${scenario.name.padEnd(30)} attempt ${attempt.attempt} refused by the relay — ${reason}`)
    }
  }
  console.log("\nPer scenario:")
  console.log(`  ${"scenario".padEnd(30)} admitted  refused  physical  steps  retries refused  served in/out  recorded in/out  verdict`)
  for (const scenario of scenarios) {
    const t = scenario.totals
    console.log(
      `  ${scenario.name.padEnd(30)} ${String(t.admittedAttempts).padStart(8)}  ${String(t.refusedAdmissions).padStart(7)}  ` +
        `${String(t.physicalRequests).padStart(8)}  ${String(t.admittedSteps).padStart(5)}  ${String(t.hostRetriesRefused).padStart(15)}  ` +
        `${usageText(t.servedInput, t.servedOutput).padStart(13)}  ${usageText(t.recordedInput, t.recordedOutput).padStart(15)}  ${scenario.verdict}`,
    )
  }
  console.log("\nGate 2 (each gate made to refuse by its own seeded journal):")
  for (const entry of gateTwo) {
    console.log(
      `  ${entry.gate.padEnd(7)} ${entry.holds ? "REFUSED" : "NOT SHOWN"} — backend calls ${entry.backendCalls}, stub requests ` +
        `${entry.stubRequests} — ${entry.why}${entry.refusals[0] === undefined ? "" : ` (${entry.refusals[0].reason})`}`,
    )
  }
}

/** The probe body `main` bounds: it registers what it creates in the three collections as it goes, and stops starting work once `signal` fires. */
export type ProbeBody = (
  out: string,
  scratch: string[],
  live: Set<Stoppable>,
  servers: { stop(): unknown }[],
  signal: AbortSignal,
) => Promise<number>

/** What a test may put in place of the real host, backend, scenarios and gate-2 seeds. Absent, the shipped ones run. */
export interface ProbeHooks {
  startHost?: ProbeContext["startHost"]
  backendFor?: ProbeContext["backendFor"]
  scenarios?: readonly Scenario[]
  gateTwoSeeds?: typeof GATE_TWO_SEEDS
}

const probeWith = (hooks: ProbeHooks): ProbeBody => async (out, scratch, live, servers, signal) => {
  const scratchParent = await mkdtemp(join(tmpdir(), "mad-accounting-probe-"))
  scratch.push(scratchParent)
  const workDir = join(scratchParent, "work")
  await mkdir(workDir)
  await writeFile(join(workDir, "pay.ts"), "const fee = total * rate\n", "utf8")
  const stub = startAccountingStub()
  const proxy = startRefusingProxy()
  servers.push({ stop: () => stub.stop() }, proxy)
  const context: ProbeContext = {
    out,
    stub,
    proxy,
    workDir,
    scratchParent,
    live,
    signal,
    ...(hooks.startHost === undefined ? {} : { startHost: hooks.startHost }),
    ...(hooks.backendFor === undefined ? {} : { backendFor: hooks.backendFor }),
  }
  console.log(`MAD host request accounting probe — stories 2-8c and 2-8c2\nstub ${stub.baseURL}; refusing proxy ${proxy.url}; out ${out}`)

  const scenarios: ScenarioRecord[] = []
  for (const scenario of hooks.scenarios ?? SCENARIOS) {
    console.log(`  running: ${scenario.name}`)
    scenarios.push(await runScenario(context, scenario))
  }
  const gateTwo: GateTwoRecord[] = []
  for (const entry of hooks.gateTwoSeeds ?? GATE_TWO_SEEDS) {
    console.log(`  running: gate 2, ${entry.gate}`)
    gateTwo.push(await runGateTwo(context, entry))
  }
  printTable(scenarios, gateTwo)

  // Gate 2's CLOSED status cites this file, so a case that does not hold leaves no evidence behind either.
  const incomplete = [
    ...scenarios.filter((scenario) => !scenario.complete).map((scenario) => scenario.name),
    ...gateTwo.filter((entry) => !entry.holds).map((entry) => `gate 2's ${entry.gate} case was not shown (${entry.why})`),
    ...(context.identity === undefined ? ["no host identity was recorded"] : []),
    ...(signal.aborted ? ["the probe deadline passed"] : []),
  ]
  if (context.identity === undefined || incomplete.length > 0) {
    console.error(
      `\nINCOMPLETE — ${incomplete.join("; ")}. ` +
        `No ${EVIDENCE_FILE} was written, and nothing above may be quoted as a complete measurement.`,
    )
    return 1
  }
  const evidence = buildEvidence({
    measuredAt: new Date().toISOString(),
    host: context.identity,
    scenarios,
    gateTwo,
    proxyAttempts: proxy.attempts(),
  })
  // The scratch parent first: it is never inside `--out`, but a longer path must be replaced before any prefix of it.
  const text = redactText(JSON.stringify(evidence, null, 2), secretForms(STUB_KEY)).split(scratchParent).join("<scratch>").split(out).join("<out>")
  await writeFile(join(out, EVIDENCE_FILE), `${text}\n`, "utf8")
  console.log(
    `\nProxy attempts refused: ${proxy.attempts().length} (${[...new Set(proxy.attempts().map((attempt) => attempt.line))].join("; ") || "none"}).` +
      "\nDirect egress was not shown to be blocked; only proxy-honouring attempts are listed." +
      "\nNo paid token was spent: the host's only provider was the relay, whose only upstream was the local stub, with a dummy key." +
      `\nEvidence: ${join(out, EVIDENCE_FILE)}` +
      "\nExit 0 means every scenario ran, every verdict is complete and every gate-2 case was refused. Paired gate 1 needs every scenario to HOLD, and a reviewed change to close it.",
  )
  return 0
}

export function parseOut(argv: readonly string[]): { ok: true; out: string } | { ok: false; reason: string } {
  const args = argv.slice(2)
  const at = args.findIndex((arg) => arg === "--out" || arg.startsWith("--out="))
  if (at < 0) return { ok: false, reason: "--out <absolute directory> is required" }
  const others = args.filter((_arg, index) => index !== at && !(index === at + 1 && !args[at]!.includes("=")))
  if (others.length > 0) return { ok: false, reason: `unexpected argument(s): ${others.join(" ")}. This command takes --out only.` }
  const value = args[at]!.includes("=") ? args[at]!.slice(args[at]!.indexOf("=") + 1) : args[at + 1]
  if (value === undefined || value.trim() === "" || !isAbsolute(value)) return { ok: false, reason: "--out needs an absolute directory" }
  return { ok: true, out: resolve(value) }
}

/**
 * Why `out` may not hold this run, or `null`. It must be empty or absent (so no
 * earlier run's journal or evidence is read or left beside this one), and it may
 * not be `/` or contain the temporary directory the scratch copies are made in.
 */
export async function outProblem(out: string, scratchRoot: string = tmpdir()): Promise<string | null> {
  if (out === sep) return "--out may not be the filesystem root"
  const scratchReal = await realpath(scratchRoot).catch(() => scratchRoot)
  const outReal = await realpath(out).catch(() => out)
  for (const [candidate, root] of [
    [out, scratchRoot],
    [outReal, scratchReal],
  ] as const) {
    const prefix = candidate.endsWith(sep) ? candidate : `${candidate}${sep}`
    if (root === candidate || root.startsWith(prefix)) return `--out \`${out}\` contains the temporary directory \`${scratchRoot}\` the probe's scratch copies are made in`
  }
  const info = await lstat(out).catch(() => undefined)
  if (info === undefined) return null
  if (!info.isDirectory()) return `--out \`${out}\` exists and is not a directory`
  const entries = await readdir(out)
  return entries.length === 0 ? null : `--out \`${out}\` is not empty (${entries.length} entr${entries.length === 1 ? "y" : "ies"}); every run starts in an empty directory`
}

/** Test-only: a shorter deadline, a shorter settle bound, a fake body or hooks into the real one. The shipped values are the constants above and the real probe. */
export interface ProbeSeams extends ProbeHooks {
  deadlineMs?: number
  settleMs?: number
  body?: ProbeBody
  /** The directory `--out` may not contain. Defaults to the system temp directory. */
  scratchRoot?: string
}

export async function main(argv: readonly string[] = Bun.argv, seams: ProbeSeams = {}): Promise<number> {
  const parsed = parseOut(argv)
  if (!parsed.ok) {
    console.error(parsed.reason)
    return 1
  }
  const refused = await outProblem(parsed.out, seams.scratchRoot)
  if (refused !== null) {
    console.error(refused)
    return 1
  }
  await mkdir(parsed.out, { recursive: true })
  const deadlineMs = seams.deadlineMs ?? PROBE_DEADLINE_MS
  const settleMs = seams.settleMs ?? BODY_SETTLE_MS
  const scratch: string[] = []
  const live = new Set<Stoppable>()
  const servers: { stop(): unknown }[] = []
  const controller = new AbortController()
  const cleanup = async (): Promise<string[]> => {
    const problems: string[] = []
    for (const host of [...live]) {
      const outcome = await host.stop().catch((error: unknown): StopOutcome => ({ confirmed: false, pid: 0, why: messageOf(error) }))
      if (outcome.confirmed) live.delete(host)
      else problems.push(`the managed host's exit is UNCONFIRMED: check process ${outcome.pid} by hand (${outcome.why})`)
    }
    for (const server of servers) {
      try {
        await server.stop()
      } catch (error) {
        problems.push(`a local server did not stop: ${messageOf(error)}`)
      }
    }
    for (const dir of scratch) {
      await rm(dir, { recursive: true, force: true }).catch((error: unknown) => problems.push(`\`${dir}\` could not be removed: ${messageOf(error)}`))
    }
    return problems
  }
  const onSignal = () => {
    controller.abort()
    void cleanup().then((problems) => {
      for (const problem of problems) console.error(problem)
      console.error("\nINTERRUPTED — the probe stopped; nothing above is a complete measurement.")
      process.exit(130)
    })
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
  let timer: ReturnType<typeof setTimeout> | undefined
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  try {
    const body = (seams.body ?? probeWith(seams))(parsed.out, scratch, live, servers, controller.signal).then(
      (code) => ({ code }),
      (error: unknown) => ({ failed: messageOf(error) }),
    )
    const bounded = await Promise.race([
      body,
      new Promise<"timed-out">((done) => {
        timer = setTimeout(() => done("timed-out"), deadlineMs)
      }),
    ])
    if (bounded === "timed-out") {
      // Stop the body starting anything more, and give what it already started a bounded chance to register.
      controller.abort()
      await Promise.race([
        body,
        new Promise((done) => {
          settleTimer = setTimeout(done, settleMs)
        }),
      ])
    }
    const problems = await cleanup()
    for (const problem of problems) console.error(problem)
    if (bounded === "timed-out") {
      // A body that finished writing during the settle window leaves no evidence of a run that did not finish in time.
      await rm(join(parsed.out, EVIDENCE_FILE), { force: true }).catch((error: unknown) => console.error(`${EVIDENCE_FILE} could not be removed: ${messageOf(error)}`))
      console.error(`the probe did not finish within ${deadlineMs} ms. NOTHING ABOVE IS A COMPLETE MEASUREMENT.`)
      return 1
    }
    if ("failed" in bounded) {
      console.error(`the probe failed: ${redactText(bounded.failed, secretForms(STUB_KEY))}. Nothing above is a complete measurement.`)
      return 1
    }
    return problems.length > 0 ? 1 : bounded.code
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (settleTimer !== undefined) clearTimeout(settleTimer)
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

if (import.meta.main) process.exit(await main())
