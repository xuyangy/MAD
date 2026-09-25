#!/usr/bin/env bun
/**
 * Story 2-8c3b — the zero-bill OAuth attempt probe.
 *
 *   bun run oauth-probe --out /scratch/mad-oauth-probe \
 *     [--oauth-data-dir ~/.local/share/mad-opencode-oauth] [--oauth-prepared /scratch/mad-oauth-prepared]
 *
 * It runs the real, measured opencode through `startManagedHost` in OAuth mode and
 * shows what the OAuth route does to MAD's admitted attempts. Its evidence is
 * `<out>/oauth-attempts.json`, committed as `ablation/evidence/oauth-attempts-<date>.json`.
 *
 * ## It bills nothing, and it can reach nothing
 *
 * - **The sandbox.** Every host runs inside `sandbox-exec` with
 *   `(deny network-outbound)` except loopback (`SANDBOX_PROFILE`). Before any host
 *   starts, a self-test runs a Bun process under the same profile: a loopback
 *   server must be reachable and an external IP and an external HTTPS URL must not
 *   be. A failed self-test, a missing `sandbox-exec` or a platform other than macOS
 *   refuses the probe before any host exists.
 * - **The refusing proxy.** HTTP(S)_PROXY points at `startRefusingProxy`, which
 *   forwards nothing and lists each `CONNECT host:port`: it names the destinations
 *   the sandbox blocks. It is an observation aid, not the control.
 * - **Placeholder sign-ins.** Every prompt runs against a probe-owned data
 *   directory whose `opencode/auth.json` is a symlink to a placeholder file with a
 *   far-future expiry, so no real token reaches anything and no refresh fires. The
 *   user's store is used only by the listing-only scenario, which sends no prompt.
 * - **The stubs.** `anthropic` is pointed at a Messages stub and `github-copilot` at
 *   a chat-completions stub (`ablation/oauth-stub.ts`) through the managed host's
 *   probe-only `baseURL` overrides. A stub records provider, method, path and
 *   whether an auth header was present: never a header value, never a body. The
 *   probe writes no raw HTTP request or response; opencode's own session data in the
 *   probe-owned data directory is not probe output. `openai` ignores `baseURL`, so its
 *   OAuth transport is never observed: its scenario is **UNPROBED** by construction,
 *   and records only the egress target the proxy refused.
 *
 * ## It drives the attempt path
 *
 * Each attempt scenario runs the real `discover` stage with a one-slot roster, a
 * real `OpencodeModelBackend` against the managed host, and a real journal opened
 * in attempt mode (`openJournal(…, "attempts")`) in its own bundle root, on the
 * OAuth route. A stub request is attributed to the admitted attempt whose window
 * (admission to settlement) it arrived in; a second request in one window is a host
 * retry, which the OAuth route neither gates nor counts.
 *
 * ## Exit status
 *
 * 0 when every scenario ran, every host stop was confirmed, every post-stop check
 * held, the anthropic and copilot attempts and every other scenario HOLD, and openai
 * is UNPROBED. When every scenario ran the evidence is written, whatever the
 * verdicts; otherwise nothing is written. Exit 0 does not close paired gate 7.
 */

import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

import { OpencodeModelBackend } from "../adapters/opencode/model-backend.ts"
import { startRefusingProxy, type ProxyAttempt, type RefusingProxy } from "../ablation/accounting-stub.ts"
import { acquireLock, JOURNAL_FILE, openJournal, type IssuedLine, type JournalLine, type SettledLine } from "../ablation/journal.ts"
import {
  MEASURED_HOST,
  OAUTH_PAYLOAD,
  spawnHost,
  startManagedHost,
  type OAuthRoute,
  type PostStopChecks,
  type SpawnHost,
  type StopOutcome,
} from "../ablation/managed-host.ts"
import { authLinkPaths, type PreparedMeasure } from "../ablation/oauth-payload.ts"
import { startOAuthStub, type OAuthStub, type OAuthStubBehaviour, type OAuthStubRequest } from "../ablation/oauth-stub.ts"
import type { RosterSlot } from "../core/domain/roster.ts"
import { emptyLedger } from "../core/domain/run-record.ts"
import { CODING_DISCOVERY_GENERALIST } from "../core/instructions/coding/discovery.ts"
import type { AdmissionDecision, AdmissionRequest, RequestAdmission } from "../core/ports/admission.ts"
import { systemClock } from "../core/ports/clock.ts"
import type { LateUsageReporter } from "../core/ports/late-usage.ts"
import type { ModelBackend } from "../core/ports/model-backend.ts"
import { selectRoster } from "../core/roster/select.ts"
import { discover } from "../core/stages/discover.ts"
import { outProblem } from "./accounting-probe.ts"
import { prepareOAuthPayload } from "./oauth-prepare.ts"

export const EVIDENCE_KIND =
  "MEASURED RUNTIME CASES — the zero-bill OAuth attempt probe (story 2-8c3b): a real `opencode serve` in OAuth mode, " +
  "inside a loopback-only sandbox, whose redirected providers are local stubs"

export const EVIDENCE_FILE = "oauth-attempts.json"

/** Denies every outbound connection but loopback and local sockets. */
export const SANDBOX_PROFILE =
  '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket))'
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec"

/** 2-8d's roster: the three OAuth providers and one model each. */
export const OAUTH_ROSTER = [
  { providerId: "openai", modelId: "gpt-6-luna" },
  { providerId: "anthropic", modelId: "claude-opus-5-5" },
  { providerId: "github-copilot", modelId: "gpt-5-mini" },
] as const
export const OAUTH_PROVIDERS = OAUTH_ROSTER.map((entry) => entry.providerId)

export const DEFAULT_DATA_DIR = join(homedir(), ".local", "share", "mad-opencode-oauth")

export const PROBE_DEADLINE_MS = 1_200_000
export const BODY_SETTLE_MS = 30_000
/** Outlasts the host's own retry series on a failing provider. */
export const SCENARIO_TURN_TIMEOUT_MS = 150_000
/** The hang scenario's turn deadline. */
export const HANG_TURN_TIMEOUT_MS = 5_000
/** How much later than its deadline an abandoned attempt may settle and still be within its bound. */
export const ABANDON_SLACK_MS = 5_000
/** How long after an attempt settled a stub request is still attributed to it. */
export const ATTRIBUTION_SLACK_MS = 2_000
/** Attempts seeded into block 1's prefix so exactly one more is admitted: MAD's own retry is then refused. */
export const ONE_LEFT = 9

/** The material every attempt's discover turn reviews. Its content is irrelevant to the count. */
const PROBE_INPUT = "--- a/pay.ts\n+++ b/pay.ts\n@@ -1 +1 @@\n-const fee = 0\n+const fee = total * rate\n"

/** Placeholder sign-ins: no provider's token, with an expiry far enough ahead that no refresh fires. */
export function placeholderAuth(now: number): Record<string, unknown> {
  const expires = now + 10 * 365 * 24 * 3_600_000
  return Object.fromEntries(
    OAUTH_PROVIDERS.map((id) => [id, { type: "oauth", refresh: `mad-probe-placeholder-refresh-${id}`, access: `mad-probe-placeholder-access-${id}`, expires }]),
  )
}

export type Verdict = "HOLDS" | "FAILS" | "UNPROBED"

/** What an attempt scenario expects. */
export type Expectation = "one-request" | "refused" | "abandoned" | "host-retries" | "unprobed"

export type Scenario =
  | { kind: "registry"; name: string; what: string; store: "placeholders" | "real" }
  | {
      kind: "attempt"
      name: string
      what: string
      providerId: string
      modelId: string
      script: { queue: OAuthStubBehaviour[]; otherwise: OAuthStubBehaviour }
      turnTimeoutMs: number
      /** Attempts seeded into block 1's prefix before the scenario runs. */
      seeded: number
      expect: Expectation
    }

export const SCENARIOS: readonly Scenario[] = [
  { kind: "registry", name: "registry with placeholders", what: "an OAuth host on the placeholder sign-ins lists the three providers and every roster model", store: "placeholders" },
  {
    kind: "registry",
    name: "registry with the real data directory",
    what: "an OAuth host on the real --oauth-data-dir lists the providers; listing only, no prompt; the auth symlink is checked before and after",
    store: "real",
  },
  {
    kind: "attempt",
    name: "anthropic attempt",
    what: "one discover turn on anthropic/claude-opus-5-5; the Messages stub answers with a StructuredOutput call",
    providerId: "anthropic",
    modelId: "claude-opus-5-5",
    script: { queue: [], otherwise: "ok" },
    turnTimeoutMs: SCENARIO_TURN_TIMEOUT_MS,
    seeded: 0,
    expect: "one-request",
  },
  {
    kind: "attempt",
    name: "copilot attempt",
    what: "one discover turn on github-copilot/gpt-5-mini; the chat-completions stub answers with a StructuredOutput call",
    providerId: "github-copilot",
    modelId: "gpt-5-mini",
    script: { queue: [], otherwise: "ok" },
    turnTimeoutMs: SCENARIO_TURN_TIMEOUT_MS,
    seeded: 0,
    expect: "one-request",
  },
  {
    kind: "attempt",
    name: "attempt refused by a seeded gate",
    what: "block 1's prefix is seeded with its 10 attempts, so the journal's admission refuses the turn before any backend call",
    providerId: "anthropic",
    modelId: "claude-opus-5-5",
    script: { queue: [], otherwise: "ok" },
    turnTimeoutMs: SCENARIO_TURN_TIMEOUT_MS,
    seeded: 10,
    expect: "refused",
  },
  {
    kind: "attempt",
    name: "hang past the turn deadline",
    what: `the Messages stub never answers; the adapter gives up at ${HANG_TURN_TIMEOUT_MS} ms and the attempt must settle abandoned within ${HANG_TURN_TIMEOUT_MS + ABANDON_SLACK_MS} ms`,
    providerId: "anthropic",
    modelId: "claude-opus-5-5",
    script: { queue: [], otherwise: "hang" },
    turnTimeoutMs: HANG_TURN_TIMEOUT_MS,
    seeded: 0,
    expect: "abandoned",
  },
  {
    kind: "attempt",
    name: "persistent 500",
    what:
      `the Messages stub answers every request with HTTP 500; block 1's prefix is seeded with ${ONE_LEFT} attempts, so ` +
      "exactly one attempt is admitted and MAD's own retry is refused; the stub counts the host's hidden retries within it",
    providerId: "anthropic",
    modelId: "claude-opus-5-5",
    script: { queue: [], otherwise: "500" },
    turnTimeoutMs: SCENARIO_TURN_TIMEOUT_MS,
    seeded: ONE_LEFT,
    expect: "host-retries",
  },
  {
    kind: "attempt",
    name: "openai attempt",
    what:
      "one discover turn on openai/gpt-6-luna; its OAuth transport ignores baseURL, so nothing stands in for it and only " +
      "the egress target the proxy refused is recorded",
    providerId: "openai",
    modelId: "gpt-6-luna",
    script: { queue: [], otherwise: "ok" },
    turnTimeoutMs: SCENARIO_TURN_TIMEOUT_MS,
    seeded: ONE_LEFT,
    expect: "unprobed",
  },
]

// ---------------------------------------------------------------------------
// The verdict logic (pure; unit-tested with fakes)
// ---------------------------------------------------------------------------

/** One admitted attempt: when admission returned and when the stage settled it. */
export interface AttemptMark {
  attempt: number
  admittedAt: number
  settledAt?: number
}

/** A stub request as the evidence carries it: its time is relative to the scenario's start. */
export type RecordedRequest = Omit<OAuthStubRequest, "at" | "closed"> & { atMs: number; closedAfterMs?: number }

export interface AttemptRecord {
  attempt: number
  admittedAtMs: number
  settledAtMs: number | null
  issued: IssuedLine | null
  settled: SettledLine | null
  /** Every stub model request that arrived in this attempt's window, in order. */
  requests: RecordedRequest[]
  /** Requests after the first in this window: the host's own retries. */
  hostRetries: number
  /** How the attempt was settled, in words (`settlementKind`). */
  settlement: string
}

/**
 * Each stub model request, assigned to the attempt whose window it arrived in:
 * from the moment admission returned (the `issued` line is durable by then) to
 * `slackMs` after the attempt settled. Attempts run one at a time, so the windows
 * do not overlap. A request in no window is unattributed.
 */
export function attributeRequests(
  marks: readonly AttemptMark[],
  requests: readonly OAuthStubRequest[],
  slackMs: number,
): { perAttempt: OAuthStubRequest[][]; unattributed: OAuthStubRequest[] } {
  const perAttempt = marks.map(() => [] as OAuthStubRequest[])
  const unattributed: OAuthStubRequest[] = []
  for (const request of requests.filter((entry) => entry.model)) {
    const index = marks.findIndex((mark) => request.at >= mark.admittedAt && request.at <= (mark.settledAt ?? Number.POSITIVE_INFINITY) + slackMs)
    if (index < 0) unattributed.push(request)
    else perAttempt[index]!.push(request)
  }
  return { perAttempt, unattributed }
}

export interface AttemptScenarioFacts {
  expect: Expectation
  turnTimeoutMs: number
  seededIssued: number
  issuedAfter: number
  attempts: AttemptRecord[]
  unattributed: RecordedRequest[]
  refusals: { cause: string; reason: string }[]
  backendCalls: number
  /** Every stub request in the scenario, model or not. */
  stubRequests: number
  /** What the journal latched, its stop or its halt, or `null`: after this, admission refuses. */
  journalLatched: string | null
  proxyTargets: string[]
  postStop: PostStopChecks | null
  /** Why the scenario's journal could not be read whole (a torn or unparsable line), each named. */
  journalProblems: string[]
}

/** The scenario's verdict and why, from what it measured. */
export function attemptVerdict(facts: AttemptScenarioFacts): { verdict: Verdict; why: string } {
  const problems: string[] = []
  const post = facts.postStop?.problems ?? []
  problems.push(...post)
  problems.push(...facts.journalProblems)
  if (facts.unattributed.length > 0) problems.push(`${facts.unattributed.length} stub request(s) arrived outside every admitted attempt's window`)
  const only = facts.attempts[0]
  const journaledFirst = (record: AttemptRecord) => record.issued !== null && record.issued.mode === "attempts" && record.requests.every((request) => request.atMs >= record.admittedAtMs)
  switch (facts.expect) {
    case "one-request": {
      if (facts.attempts.length !== 1) problems.push(`${facts.attempts.length} attempts were admitted, not 1`)
      else {
        if (!journaledFirst(only!)) problems.push("the attempt has no attempt-mode `issued` line written before its stub request")
        if (only!.settled === null) problems.push("the attempt has no `settled` line")
        if (only!.requests.length !== 1) problems.push(`the stub received ${only!.requests.length} request(s) for the attempt, not 1`)
        else if (!only!.requests[0]!.authHeaderPresent) problems.push("the stub request carried no auth header")
      }
      if (facts.journalLatched !== null) problems.push(`the journal latched: ${facts.journalLatched}`)
      return problems.length === 0
        ? { verdict: "HOLDS", why: `1 attempt journaled (attempt mode) before 1 stub request, with an auth header; settled once, ${settlementKind(only!)}` }
        : { verdict: "FAILS", why: problems.join("; ") }
    }
    case "refused": {
      if (facts.refusals.length === 0) problems.push("no admission was refused")
      else if (!facts.refusals.every((refusal) => refusal.cause === "budget" && refusal.reason.includes("attempts"))) {
        problems.push(`a refusal was not the attempt-mode budget gate's (${facts.refusals.map((refusal) => `${refusal.cause}: ${refusal.reason}`).join("; ")})`)
      }
      if (facts.backendCalls !== 0) problems.push(`${facts.backendCalls} backend call(s) were made`)
      if (facts.stubRequests !== 0) problems.push(`the stubs received ${facts.stubRequests} request(s)`)
      if (facts.issuedAfter !== facts.seededIssued) problems.push("the journal gained an `issued` line")
      return problems.length === 0
        ? { verdict: "HOLDS", why: "refused inside the journal's admission, worded in attempts, before any backend call; 0 stub requests; no `issued` line added" }
        : { verdict: "FAILS", why: problems.join("; ") }
    }
    case "abandoned": {
      if (facts.attempts.length !== 1) problems.push(`${facts.attempts.length} attempts were admitted, not 1`)
      else {
        const settlement = only!.settled?.settlement as { kind?: string; abandoned?: boolean } | undefined
        if (!journaledFirst(only!)) problems.push("the attempt has no attempt-mode `issued` line written before its stub request")
        if (settlement?.kind !== "unknown" || settlement.abandoned !== true) problems.push(`the attempt was settled ${JSON.stringify(settlement ?? null)}, not unknown with \`abandoned: true\``)
        const took = only!.settledAtMs === null ? null : only!.settledAtMs - only!.admittedAtMs
        const bound = facts.turnTimeoutMs + ABANDON_SLACK_MS
        if (took === null || took > bound) problems.push(`the attempt settled ${took === null ? "never" : `${took} ms after admission`}; the bound is ${bound} ms`)
        if (only!.requests.length === 0) problems.push("the stub never received the attempt's request, so nothing was held open")
      }
      if (facts.journalLatched === null) problems.push("the journal latched neither a stop nor a halt")
      return problems.length === 0
        ? { verdict: "HOLDS", why: `1 attempt settled unknown with \`abandoned: true\` within its bound, and the journal latched: ${facts.journalLatched}` }
        : { verdict: "FAILS", why: problems.join("; ") }
    }
    case "host-retries": {
      if (facts.attempts.length !== 1) problems.push(`${facts.attempts.length} attempts were admitted, not 1`)
      else {
        if (!journaledFirst(only!)) problems.push("the attempt has no attempt-mode `issued` line written before its first stub request")
        if (only!.settled === null) problems.push("the attempt has no `settled` line")
        if (only!.requests.length === 0) problems.push("the stub received no request for the attempt")
        if (only!.requests.some((request) => !request.authHeaderPresent)) problems.push("a stub request carried no auth header")
      }
      if (problems.length > 0) return { verdict: "FAILS", why: problems.join("; ") }
      const retries = only!.hostRetries
      if (retries === 0) {
        return { verdict: "UNPROBED", why: `1 attempt journaled before its one stub request, settled ${settlementKind(only!)}; the host made no retry, so no host retry was observed` }
      }
      return {
        verdict: "HOLDS",
        why:
          `1 attempt journaled before its first stub request and settled ${settlementKind(only!)}; the stub counted ${only!.requests.length} request(s) against it, ` +
          `${retries} of them host retr${retries === 1 ? "y" : "ies"}: ungated and uncounted on the OAuth route, disclosed, not a failure`,
      }
    }
    case "unprobed":
      if (problems.length > 0) return { verdict: "FAILS", why: problems.join("; ") }
      return {
        verdict: "UNPROBED",
        why:
          `OpenAI's OAuth transport ignores baseURL, so no stub stood in for it and nothing was observed of it. ` +
          `${facts.attempts.length} attempt(s) were admitted; ${facts.stubRequests} stub request(s) arrived; the proxy refused ` +
          `${facts.proxyTargets.length === 0 ? "no connection" : facts.proxyTargets.join(", ")}` +
          (only === undefined ? "" : `; the attempt settled ${settlementKind(only)}`),
      }
  }
}

/**
 * How an attempt was settled, in words. A `usage` figure is the host's own report,
 * an unverified diagnostic: zeros on a failed attempt are not a known zero cost.
 */
export function settlementKind(record: AttemptRecord): string {
  const settlement = record.settled?.settlement as { kind?: unknown; tokens?: { input?: number; output?: number }; abandoned?: boolean } | undefined
  if (settlement === undefined) return "never"
  if (settlement.kind === "usage") return `\`usage\` with host-reported ${settlement.tokens?.input ?? "?"} in / ${settlement.tokens?.output ?? "?"} out (unverified)`
  return `\`${String(settlement.kind)}\`${settlement.abandoned === true ? " (abandoned)" : ""}`
}

/** A registry scenario holds when the managed host verified the registry and every post-stop check held. */
export function registryVerdict(facts: { listed: RegistryListing[]; postStop: PostStopChecks | null }): { verdict: Verdict; why: string } {
  const problems = [...(facts.postStop?.problems ?? [])]
  if (facts.postStop === null) problems.push("no post-stop check was made")
  for (const { providerId, modelId } of OAUTH_ROSTER) {
    const entry = facts.listed.find((listing) => listing.id === providerId)
    if (entry === undefined) problems.push(`the registry does not list \`${providerId}\``)
    else if (!entry.rosterModelListed) problems.push(`the registry's \`${providerId}\` does not list \`${modelId}\``)
  }
  return problems.length === 0
    ? { verdict: "HOLDS", why: `the managed host verified the registry; it lists ${facts.listed.map((entry) => entry.id).join(", ")} with every roster model; ${facts.postStop!.held.join("; ")}` }
    : { verdict: "FAILS", why: problems.join("; ") }
}

/** One provider in `GET /config/providers`, reduced to its id, how many models it offers and whether the roster's is one. */
export interface RegistryListing {
  id: string
  models: number
  rosterModelListed: boolean
}

export function registryListing(body: unknown): RegistryListing[] {
  const providers = (body as { providers?: unknown } | null)?.providers
  if (!Array.isArray(providers)) return []
  return providers.flatMap((provider: { id?: unknown; models?: unknown }) => {
    if (provider === null || typeof provider !== "object" || typeof provider.id !== "string") return []
    const models = provider.models !== null && typeof provider.models === "object" ? Object.keys(provider.models) : []
    const roster = OAUTH_ROSTER.find((entry) => entry.providerId === provider.id)
    return [{ id: provider.id, models: models.length, rosterModelListed: roster !== undefined && models.includes(roster.modelId) }]
  })
}

/** Each distinct non-loopback target the proxy refused, from its request lines. */
export function egressTargets(attempts: readonly ProxyAttempt[]): string[] {
  const targets = attempts.map((attempt) => {
    const parts = attempt.line.split(" ")
    return parts[0] === "CONNECT" ? (parts[1] ?? attempt.line) : `${parts[0]} ${(parts[1] ?? "").split("?")[0]}`
  })
  return [...new Set(targets)].filter((target) => !/^(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(target))
}

// ---------------------------------------------------------------------------
// The sandbox
// ---------------------------------------------------------------------------

/** What the sandbox self-test observed: the unsandboxed control, then what the profile allowed. */
export interface SelfTest {
  ok: boolean
  /** An unsandboxed TCP connect to `CONTROL_TARGET` (no byte sent, no TLS): it must connect, or the refusals prove nothing. */
  control: string
  loopback: string
  external: { target: string; outcome: string }[]
  why: string
}

/** The external target the control connects to without the sandbox, and the sandboxed test must fail to reach. */
export const CONTROL_TARGET = { hostname: "1.1.1.1", port: 443 } as const

/** A TCP connect that sends nothing and closes as soon as it opens: `connected`, or why not. */
export function tcpConnect(hostname: string, port: number, ms = 5_000): Promise<string> {
  return new Promise<string>((done) => {
    const timer = setTimeout(() => done(`no answer within ${ms} ms`), ms)
    const settle = (outcome: string) => {
      clearTimeout(timer)
      done(outcome)
    }
    const failed = (error: unknown) => settle(`refused: ${(error as { code?: string } | null)?.code ?? messageOf(error)}`)
    Bun.connect({
      hostname,
      port,
      socket: {
        open(socket) {
          socket.end()
          settle("connected")
        },
        data() {},
        error(_socket, error) {
          failed(error)
        },
        connectError(_socket, error) {
          failed(error)
        },
      },
    }).catch(failed)
  })
}

const SELF_TEST_SCRIPT = `
const within = (ms, promise) => Promise.race([promise, new Promise((done) => setTimeout(() => done("no answer within " + ms + " ms"), ms))])
const tcp = (hostname, port) => within(5000, new Promise((done) => {
  Bun.connect({ hostname, port, socket: { open(s) { s.end(); done("connected") }, data() {}, error(_s, e) { done("refused: " + (e && (e.code || e.message))) }, connectError(_s, e) { done("refused: " + (e && (e.code || e.message))) } } })
    .catch((e) => done("refused: " + (e && (e.code || e.message))))
}))
const https = (url) => within(8000, fetch(url, { signal: AbortSignal.timeout(7000) }).then((r) => "connected (HTTP " + r.status + ")", (e) => "refused: " + (e && (e.code || e.message))))
const out = { loopback: await tcp("127.0.0.1", Number(process.env.MAD_SELF_TEST_PORT)), external: [
  { target: "1.1.1.1:443", outcome: await tcp("1.1.1.1", 443) },
  { target: "https://example.com/", outcome: await https("https://example.com/") },
] }
console.log(JSON.stringify(out))
`

/**
 * Run a Bun process under `SANDBOX_PROFILE`: loopback must connect, the external
 * targets must not. First, unsandboxed, a TCP connect to `CONTROL_TARGET` must
 * succeed: on a machine that cannot reach it anyway, a refusal inside the sandbox
 * shows nothing, and the test is inconclusive.
 */
export async function sandboxSelfTest(connect: (hostname: string, port: number) => Promise<string> = tcpConnect): Promise<SelfTest> {
  const exists = await lstat(SANDBOX_EXEC).catch(() => undefined)
  if (exists === undefined) return { ok: false, control: "not tried", loopback: "not tried", external: [], why: `\`${SANDBOX_EXEC}\` is absent` }
  const control = await connect(CONTROL_TARGET.hostname, CONTROL_TARGET.port)
  if (control !== "connected") {
    return {
      ok: false,
      control,
      loopback: "not tried",
      external: [],
      why: `inconclusive: the unsandboxed control could not connect to ${CONTROL_TARGET.hostname}:${CONTROL_TARGET.port} (${control}), so a refusal inside the sandbox would prove nothing`,
    }
  }
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open(socket) { socket.end() } } })
  try {
    const child = Bun.spawn({
      cmd: [SANDBOX_EXEC, "-p", SANDBOX_PROFILE, process.execPath, "-e", SELF_TEST_SCRIPT],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: tmpdir(), MAD_SELF_TEST_PORT: String(listener.port) },
    })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    let parsed: unknown
    try {
      parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "")
    } catch {
      parsed = undefined
    }
    if (!isObserved(parsed)) {
      return { ok: false, control, loopback: "unread", external: [], why: `the self-test exited ${code} and printed nothing readable: ${stderr.trim().slice(-300) || "(no stderr)"}` }
    }
    return selfTestVerdict({ control, ...parsed })
  } finally {
    listener.stop(true)
  }
}

/** Whether the sandboxed process printed the shape the self-test reads. */
function isObserved(value: unknown): value is { loopback: string; external: { target: string; outcome: string }[] } {
  if (value === null || typeof value !== "object") return false
  const { loopback, external } = value as { loopback?: unknown; external?: unknown }
  return (
    typeof loopback === "string" &&
    Array.isArray(external) &&
    external.every((entry) => entry !== null && typeof entry === "object" && typeof entry.target === "string" && typeof entry.outcome === "string")
  )
}

/** The self-test holds when the unsandboxed control connected, loopback connected inside the sandbox, and no external target did. */
export function selfTestVerdict(observed: { control: string; loopback: string; external: { target: string; outcome: string }[] }): SelfTest {
  const problems: string[] = []
  if (observed.control !== "connected") problems.push(`inconclusive: the unsandboxed control did not connect (${observed.control})`)
  if (observed.loopback !== "connected") problems.push(`a loopback server was not reachable from inside the sandbox (${observed.loopback})`)
  if (observed.external.length === 0) problems.push("no external target was tried")
  for (const entry of observed.external) if (!entry.outcome.startsWith("refused")) problems.push(`\`${entry.target}\` was not refused from inside the sandbox (${entry.outcome})`)
  return { ok: problems.length === 0, ...observed, why: problems.length === 0 ? "the unsandboxed control connected; inside the sandbox loopback was reachable and every external target refused" : problems.join("; ") }
}

/** The managed host's spawn, inside `sandbox-exec` with `SANDBOX_PROFILE`. The binary it names is the one hashed. */
export const sandboxSpawn: SpawnHost = (request) => spawnHost({ ...request, cmd: [SANDBOX_EXEC, "-p", SANDBOX_PROFILE, ...request.cmd] })

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

export interface Stoppable {
  stop(): Promise<StopOutcome>
}

/** A host a scenario runs against: the real managed host, or a test's stand-in. */
export interface ProbeHost extends Stoppable {
  url: string
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
  payload: PreparedMeasure
}

export interface ProbeContext {
  out: string
  workDir: string
  scratchParent: string
  prepared: string
  /** Makes a fresh probe-owned data directory, and the home its placeholder link points into, for one scenario. */
  placeholders: (scenario: string) => Promise<{ dataDir: string; home: string }>
  /** The user's data directory, for the listing-only scenario. */
  realDataDir: string
  realHome: string
  stubs: { anthropic: OAuthStub; copilot: OAuthStub }
  proxy: RefusingProxy
  live: Set<Stoppable>
  signal: AbortSignal
  identity?: HostIdentity
  startHost?: (context: ProbeContext, route: OAuthRoute) => Promise<ProbeHost>
  backendFor?: (host: ProbeHost, options: { directory: string; slots: RosterSlot[]; timeoutMs: number; lateUsage: LateUsageReporter }) => ModelBackend
  /** Reads `GET /config/providers` for `directory`. */
  listProviders?: (host: ProbeHost, directory: string) => Promise<unknown>
}

const slug = (name: string) => name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()

function stopIfAborted(context: ProbeContext, what: string): void {
  if (context.signal.aborted) throw new Error(`the probe deadline passed, so ${what} was not started`)
}

/** The route one scenario's host runs: the three providers, the roster, and — with placeholders, fresh for the scenario — the stubs. */
export async function probeRoute(context: ProbeContext, store: "placeholders" | "real", scenario: string): Promise<OAuthRoute> {
  const base = { providers: OAUTH_PROVIDERS, models: OAUTH_ROSTER, prepared: context.prepared }
  if (store === "real") return { ...base, dataDir: context.realDataDir, home: context.realHome }
  const { dataDir, home } = await context.placeholders(scenario)
  return { ...base, dataDir, home, baseURLs: { anthropic: context.stubs.anthropic.baseURL, "github-copilot": context.stubs.copilot.baseURL } }
}

/** Writes placeholder sign-ins into `<root>/home` and links `<root>/data/opencode/auth.json` to them. */
export async function writePlaceholders(root: string): Promise<{ dataDir: string; home: string }> {
  const home = join(root, "home")
  const dataDir = join(root, "data")
  const { link, target } = authLinkPaths(dataDir, home)
  await mkdir(join(target, ".."), { recursive: true })
  await writeFile(target, `${JSON.stringify(placeholderAuth(Date.now()))}\n`, { mode: 0o600 })
  await mkdir(join(link, ".."), { recursive: true })
  await symlink(target, link)
  return { dataDir, home }
}

/** The real managed host in OAuth mode, sandboxed, registered in `live` the moment it is spawned. */
export async function managedProbeHost(context: ProbeContext, route: OAuthRoute): Promise<ProbeHost> {
  let spawned: Stoppable | undefined
  const started = await startManagedHost({
    mode: "oauth",
    oauth: route,
    proxy: context.proxy.url,
    scratchParent: context.scratchParent,
    verifyDirectories: [context.workDir],
    signals: null,
    spawn: sandboxSpawn,
    onSpawn: (host) => {
      spawned = host
      context.live.add(host)
    },
  })
  if (!started.ok) {
    if (spawned !== undefined && (started.stopped === null || started.stopped.confirmed)) context.live.delete(spawned)
    throw new Error(
      `the managed host was refused: ${started.reason}` +
        (started.stopped !== null && !started.stopped.confirmed ? `; its exit is UNCONFIRMED (process ${started.stopped.pid}): ${started.stopped.why}` : "") +
        (started.stopped?.postStop !== undefined && started.stopped.postStop.problems.length > 0 ? `; after it exited: ${started.stopped.postStop.problems.join("; ")}` : ""),
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
    payload: host.oauth!.measured,
  }
  return { url: host.url, stop: host.stop }
}

async function stopHost(context: ProbeContext, host: ProbeHost): Promise<{ how: string; postStop: PostStopChecks | null }> {
  const outcome = await host.stop()
  if (!outcome.confirmed) throw new Error(`the managed host's exit is UNCONFIRMED: check process ${outcome.pid} by hand (${outcome.why})`)
  for (const entry of context.live) if (entry.stop === host.stop) context.live.delete(entry)
  return { how: `process ${outcome.pid} ${outcome.how}`, postStop: outcome.postStop ?? null }
}

async function defaultListProviders(host: ProbeHost, directory: string): Promise<unknown> {
  const response = await fetch(`${host.url}/config/providers?directory=${encodeURIComponent(directory)}`, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`\`GET /config/providers\` answered HTTP ${response.status}`)
  return response.json()
}

export interface RegistryRecord {
  kind: "registry"
  name: string
  what: string
  store: "placeholders" | "real"
  dataDir: string
  /** The auth symlink the host was started with; checked before the spawn and after the exit. */
  authLink: { link: string; target: string }
  listed: RegistryListing[]
  proxyTargets: string[]
  hostStop: string
  postStop: PostStopChecks | null
  verdict: Verdict
  why: string
}

export async function runRegistry(context: ProbeContext, scenario: Extract<Scenario, { kind: "registry" }>): Promise<RegistryRecord> {
  stopIfAborted(context, `scenario \`${scenario.name}\``)
  const route = await probeRoute(context, scenario.store, slug(scenario.name))
  const proxyBefore = context.proxy.attempts().length
  const host = await (context.startHost ?? managedProbeHost)(context, route)
  let listed: RegistryListing[] = []
  let failure: unknown
  try {
    listed = registryListing(await (context.listProviders ?? defaultListProviders)(host, context.workDir))
  } catch (error) {
    failure = error
  }
  const stopped = await stopHost(context, host)
  if (failure !== undefined) throw failure
  return {
    kind: "registry",
    name: scenario.name,
    what: scenario.what,
    store: scenario.store,
    dataDir: route.dataDir,
    authLink: authLinkPaths(route.dataDir, route.home!),
    listed,
    proxyTargets: egressTargets(context.proxy.attempts().slice(proxyBefore)),
    hostStop: stopped.how,
    postStop: stopped.postStop,
    ...registryVerdict({ listed, postStop: stopped.postStop }),
  }
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

function markingAdmission(inner: RequestAdmission, marks: AttemptMark[], refusals: { cause: string; reason: string }[]): RequestAdmission {
  return {
    async admit(request: AdmissionRequest): Promise<AdmissionDecision> {
      const decision = await inner.admit(request)
      if (!decision.ok) {
        refusals.push({ cause: decision.cause, reason: decision.reason })
        return decision
      }
      const mark: AttemptMark = { attempt: request.attempt, admittedAt: Date.now() }
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

/** The journal's lines, and each line that could not be parsed, named, instead of a throw. */
export async function journalLines(root: string): Promise<{ lines: JournalLine[]; problems: string[] }> {
  const text = await readFile(join(root, JOURNAL_FILE), "utf8").catch(() => "")
  const lines: JournalLine[] = []
  const problems: string[] = []
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim().length === 0) continue
    try {
      lines.push(JSON.parse(line) as JournalLine)
    } catch (error) {
      problems.push(`line ${index + 1} of the journal could not be parsed (${messageOf(error)}); it may be torn`)
    }
  }
  return { lines, problems }
}

/** `count` settled attempt-mode prefix attempts in block 1, from an earlier run. */
export function seededAttempts(count: number): JournalLine[] {
  return Array.from({ length: count }, (_unused, index): JournalLine[] => {
    const physicalId = `seed-${index + 1}`
    return [
      { type: "issued", physicalId, category: "blocks", block: 1, phase: "prefix", stage: "discover", slot: "seed", attempt: 1, runId: "seed-run", mode: "attempts" },
      { type: "settled", physicalId, settlement: { kind: "usage", tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } } },
    ]
  }).flat()
}

export interface AttemptScenarioRecord extends AttemptScenarioFacts {
  kind: "attempt"
  name: string
  what: string
  model: string
  route: "oauth"
  accounting: "attempts"
  stubScript: { queue: OAuthStubBehaviour[]; otherwise: OAuthStubBehaviour }
  seeded: number
  hostStop: string
  verdict: Verdict
  why: string
}

export async function runAttempt(context: ProbeContext, scenario: Extract<Scenario, { kind: "attempt" }>): Promise<AttemptScenarioRecord> {
  stopIfAborted(context, `scenario \`${scenario.name}\``)
  const root = join(context.out, "scenarios", slug(scenario.name))
  await mkdir(root, { recursive: true })
  const seed = seededAttempts(scenario.seeded)
  if (seed.length > 0) await writeFile(join(root, JOURNAL_FILE), seed.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8")
  for (const stub of Object.values(context.stubs)) stub.reset(scenario.script)
  const proxyBefore = context.proxy.attempts().length
  const started = Date.now()

  const clock = systemClock()
  const taken = await acquireLock(root, clock.now())
  if (!taken.ok) throw new Error(taken.reason)
  const opened = await openJournal(root, taken.lock, () => clock.now(), undefined, "attempts")
  if (!opened.ok) {
    await taken.lock.release()
    throw new Error(opened.reason)
  }
  const journal = opened.journal
  const marks: AttemptMark[] = []
  const refusals: { cause: string; reason: string }[] = []
  const calls = { count: 0 }
  const runId = `oauth-probe-${slug(scenario.name)}`
  let host: ProbeHost | undefined
  let failure: { error: unknown } | undefined
  let stopped: { how: string; postStop: PostStopChecks | null } = { how: "", postStop: null }
  let journalLatched: string | null = null
  try {
    host = await (context.startHost ?? managedProbeHost)(context, await probeRoute(context, "placeholders", slug(scenario.name)))
    const roster = selectRoster([{ providerId: scenario.providerId, modelId: scenario.modelId, toolcall: true }], { slots: 1, providerConfigKey: "provider" }).roster
    const options = { directory: context.workDir, slots: roster.slots, timeoutMs: scenario.turnTimeoutMs, lateUsage: journal.reporter() }
    const backend = (context.backendFor ?? ((probeHost, given) => new OpencodeModelBackend({ serverUrl: probeHost.url, ...given })))(host, options)
    await discover({
      roster,
      backend: countingBackend(backend, calls),
      instructions: CODING_DISCOVERY_GENERALIST,
      input: PROBE_INPUT,
      clock,
      ledger: emptyLedger(),
      admission: markingAdmission(journal.admission({ block: 1, phase: "prefix", runId: () => runId }), marks, refusals),
      // The probe deadline cancels a turn in flight before cleanup stops its host.
      signal: context.signal,
    })
    const bill = journal.bill()
    journalLatched = bill.stop ?? bill.halt
    stopped = await stopHost(context, host)
    host = undefined
  } catch (error) {
    failure = { error }
  }
  if (host !== undefined) {
    const stop = host.stop
    const outcome = await stop().catch((error: unknown): StopOutcome => ({ confirmed: false, pid: 0, why: messageOf(error) }))
    if (outcome.confirmed) {
      for (const entry of context.live) if (entry.stop === stop) context.live.delete(entry)
    } else console.error(`the managed host's exit is UNCONFIRMED: check process ${outcome.pid} by hand (${outcome.why})`)
  }
  try {
    const closed = await journal.close()
    if (closed.releaseError !== null) console.error(`warning: ${closed.releaseError}`)
  } catch (error) {
    if (failure === undefined) failure = { error }
  }
  if (failure !== undefined) throw failure.error

  const { lines, problems: journalProblems } = await journalLines(root)
  const issued = lines.filter((line): line is IssuedLine => line.type === "issued")
  const own = issued.filter((line) => line.runId === runId)
  const settledOf = (line: IssuedLine) => lines.find((entry): entry is SettledLine => entry.type === "settled" && entry.physicalId === line.physicalId) ?? null
  const all = [...context.stubs.anthropic.requests(), ...context.stubs.copilot.requests()].sort((a, b) => a.at - b.at)
  const { perAttempt, unattributed } = attributeRequests(marks, all, ATTRIBUTION_SLACK_MS)
  const relative = (request: OAuthStubRequest): RecordedRequest => {
    const { at, closed, ...rest } = request
    return { ...rest, atMs: at - started, ...(closed === undefined ? {} : { closedAfterMs: closed.afterMs }) }
  }
  const attempts: AttemptRecord[] = marks.map((mark, index) => {
    const line = own.find((entry) => entry.attempt === mark.attempt) ?? null
    const requests = perAttempt[index]!.map(relative)
    return {
      attempt: mark.attempt,
      admittedAtMs: mark.admittedAt - started,
      settledAtMs: mark.settledAt === undefined ? null : mark.settledAt - started,
      issued: line,
      settled: line === null ? null : settledOf(line),
      requests,
      hostRetries: Math.max(0, requests.length - 1),
      settlement: "",
    }
  }).map((record) => ({ ...record, settlement: settlementKind(record) }))
  const facts: AttemptScenarioFacts = {
    expect: scenario.expect,
    turnTimeoutMs: scenario.turnTimeoutMs,
    seededIssued: seed.filter((line) => line.type === "issued").length,
    issuedAfter: issued.length,
    attempts,
    unattributed: unattributed.map(relative),
    refusals,
    backendCalls: calls.count,
    stubRequests: all.length,
    journalLatched,
    proxyTargets: egressTargets(context.proxy.attempts().slice(proxyBefore)),
    postStop: stopped.postStop,
    journalProblems,
  }
  return {
    kind: "attempt",
    name: scenario.name,
    what: scenario.what,
    model: `${scenario.providerId}/${scenario.modelId}`,
    route: "oauth",
    accounting: "attempts",
    stubScript: scenario.script,
    seeded: scenario.seeded,
    ...facts,
    hostStop: stopped.how,
    ...attemptVerdict(facts),
  }
}

export type ScenarioRecord = RegistryRecord | AttemptScenarioRecord

export interface ProbeEvidence {
  kind: string
  story: "2-8c3b"
  measuredAt: string
  paidTokens: string
  sandbox: SelfTest & { profile: string }
  isolation: string[]
  host: HostIdentity
  summary: Record<string, Verdict>
  scenarios: ScenarioRecord[]
  proxyAttempts: ProxyAttempt[]
  findings: { id: string; text: string }[]
  scope: string[]
}

/** The findings, each stated from what this run measured, naming its scenario. */
export function findingsFrom(scenarios: readonly ScenarioRecord[]): { id: string; text: string }[] {
  const named = (name: string) => scenarios.find((scenario) => scenario.name === name)
  const missing = (name: string) => `scenario \`${name}\` did not run, so this run measured nothing for it`
  const retries = named("persistent 500") as AttemptScenarioRecord | undefined
  const openai = named("openai attempt") as AttemptScenarioRecord | undefined
  const startup = scenarios.filter((scenario): scenario is RegistryRecord => scenario.kind === "registry")
  const hang = named("hang past the turn deadline") as AttemptScenarioRecord | undefined
  const startupTargets = new Set(startup.flatMap((scenario) => scenario.proxyTargets))
  const promptTargets = (record: AttemptScenarioRecord) => record.proxyTargets.filter((target) => !startupTargets.has(target))
  return [
    {
      id: "R1",
      text:
        retries === undefined
          ? `the host's own retries on a failing provider: ${missing("persistent 500")}`
          : `the host's own retries on a failing provider (\`persistent 500\`): ${retries.attempts.length} admitted attempt(s); the stub counted ` +
            `${retries.attempts.reduce((total, attempt) => total + attempt.requests.length, 0)} request(s), ` +
            `${retries.attempts.reduce((total, attempt) => total + attempt.hostRetries, 0)} of them host retries. On the OAuth route a host retry is ` +
            "neither gated nor counted: MAD counts the attempt once. Disclosed, not a failure",
    },
    {
      id: "E1",
      text:
        startup.length === 0
          ? "startup egress: no registry scenario ran"
          : `startup egress with no prompt sent: ${startup.map((scenario) => `\`${scenario.name}\`: the proxy refused ${scenario.proxyTargets.length === 0 ? "nothing" : scenario.proxyTargets.join(", ")}`).join("; ")}. ` +
            "A production host is not sandboxed, so these connections would leave the machine before MAD admits any attempt",
    },
    {
      id: "O1",
      text:
        openai === undefined
          ? `OpenAI: ${missing("openai attempt")}`
          : `OpenAI's OAuth transport ignores baseURL and is UNPROBED: beyond the startup connections (E1) the proxy refused ` +
            `${promptTargets(openai).length === 0 ? "no connection" : promptTargets(openai).join(", ")}; ${openai.stubRequests} stub request(s) arrived. ` +
            "Paired gate 7 stays OPEN until a separately human-authorized bounded pilot covers it",
    },
    {
      id: "H1",
      text:
        hang === undefined
          ? `an attempt past its deadline: ${missing("hang past the turn deadline")}`
          : `an attempt past its deadline: ${hang.why}` +
            (hang.attempts[0]?.requests[0]?.closedAfterMs === undefined
              ? "; the stub request was still open when the scenario ended"
              : `; the stub request closed ${hang.attempts[0].requests[0].closedAfterMs} ms after it arrived`),
    },
  ]
}

export function buildEvidence(input: {
  measuredAt: string
  sandbox: SelfTest
  host: HostIdentity
  scenarios: ScenarioRecord[]
  proxyAttempts: ProxyAttempt[]
}): ProbeEvidence {
  return {
    kind: EVIDENCE_KIND,
    story: "2-8c3b",
    measuredAt: input.measuredAt,
    paidTokens:
      "none. Every host ran inside a sandbox that denied all outbound traffic but loopback; every prompt used placeholder " +
      "sign-ins; anthropic and github-copilot were pointed at local stubs, and openai's connection was refused. The " +
      "user's sign-ins were used only for a listing, with no prompt. Nothing bills.",
    sandbox: { ...input.sandbox, profile: SANDBOX_PROFILE, control: `unsandboxed TCP connect to ${CONTROL_TARGET.hostname}:${CONTROL_TARGET.port}, no byte sent: ${input.sandbox.control}` },
    isolation: [
      "every host is `ablation/managed-host.ts`'s in OAuth mode: the environment built from nothing, the prepared payloads " +
        "verified against OAUTH_PAYLOAD before the spawn, the config seed and catalogue copied into private directories and " +
        "verified again, the config and registry verified before any client call",
      "HTTP(S)_PROXY pointed at a local proxy that forwards nothing and lists each request line; the sandbox, not the proxy, " +
        "is what denies direct egress",
      "the auth symlink was checked by lstat and readlink before every spawn and after every confirmed exit; MAD opened, read, " +
        "copied and hashed neither the link's target nor any token. opencode itself reads the store it links to: the " +
        "placeholders in every prompt scenario, and the user's sign-ins in the listing-only scenario",
      "the listing-only scenario on the user's sign-ins cannot write a refresh: the sandbox blocks any refresh request, and the " +
        "Anthropic plugin refreshes only inside its fetch wrapper, on a model request, which that scenario never sends. " +
        "Whether openai or github-copilot refresh at startup is not established; the before and after readlink checks guard it",
      "the stubs recorded provider, method, path and whether an auth header was present, never a header value or a body; " +
        "the probe persisted no raw HTTP request or response",
      "a fresh host, and for every prompt scenario a fresh placeholder data directory, was used for every scenario, and " +
        "each host's exit was confirmed: see each record's `hostStop`",
    ],
    host: input.host,
    summary: Object.fromEntries(input.scenarios.map((scenario) => [scenario.name, scenario.verdict])),
    scenarios: input.scenarios,
    proxyAttempts: input.proxyAttempts,
    findings: findingsFrom(input.scenarios),
    scope: [
      `opencode ${input.host.version} (binary sha256 ${input.host.sha256}) on this machine, the Anthropic plugin ${OAUTH_PAYLOAD.anthropicAuth.package}, ` +
        "one-slot discover, the scripted stub behaviours above; not every host, build, provider, stage or failure",
      "OpenAI's OAuth transport was not observed: it ignores baseURL, so no stub stood in for it. Nothing here covers it",
      "placeholder sign-ins with a far-future expiry: no token refresh was exercised, and where a real refresh writes is not established",
      "each attempt records how it was settled. A `usage` settlement carries the host's own token report, an unverified " +
        "diagnostic: the persistent-500 and openai attempts settle `usage` with zero host-reported tokens, which is not a " +
        "known zero cost",
      "a stub request is attributed to the attempt whose window it arrived in; attempts ran one at a time",
      `the turn deadline was ${SCENARIO_TURN_TIMEOUT_MS} ms (${HANG_TURN_TIMEOUT_MS} ms in the hang scenario)`,
      "the host's own retries, tool steps and held-open requests are not gated or counted on the OAuth route; token spend and " +
        "subscription quota are unmeasured there",
    ],
  }
}

/** What a test may put in place of the platform, the self-test, the prepare step, the host and the backend. */
export interface ProbeHooks {
  platform?: string
  selfTest?: () => Promise<SelfTest>
  /** Builds the prepared directory at the given path; the default is `prepareOAuthPayload`. */
  prepare?: (out: string) => Promise<{ ok: boolean; problems?: string[] }>
  startHost?: ProbeContext["startHost"]
  backendFor?: ProbeContext["backendFor"]
  listProviders?: ProbeContext["listProviders"]
  scenarios?: readonly Scenario[]
}

export interface ProbeArgs {
  out: string
  dataDir: string
  prepared?: string
  home: string
}

export type ProbeBody = (args: ProbeArgs, scratch: string[], live: Set<Stoppable>, servers: { stop(): unknown }[], signal: AbortSignal) => Promise<number>

const probeWith = (hooks: ProbeHooks): ProbeBody => async (args, scratch, live, servers, signal) => {
  const { out } = args
  const scratchParent = await realpath(await mkdtemp(join(tmpdir(), "mad-oauth-probe-")))
  scratch.push(scratchParent)
  const selfTest = await (hooks.selfTest ?? sandboxSelfTest)()
  if (!selfTest.ok) {
    console.error(`REFUSED — the sandbox self-test failed: ${selfTest.why}. No host was started.`)
    return 1
  }
  console.log(`sandbox self-test: ${selfTest.why}`)

  let prepared = args.prepared
  if (prepared === undefined) {
    prepared = join(scratchParent, "prepared")
    console.log(`building the prepared directory in ${prepared} (bun run oauth-prepare; no auth store attached)`)
    const built = await (hooks.prepare ?? ((dir: string) => prepareOAuthPayload(dir)))(prepared)
    if (!built.ok) {
      console.error(`REFUSED — the prepared directory could not be built: ${(built.problems ?? []).join("; ")}. No host was started.`)
      return 1
    }
  }

  const workDir = join(scratchParent, "work")
  await mkdir(workDir)
  await writeFile(join(workDir, "pay.ts"), "const fee = total * rate\n", "utf8")

  const stubs = { anthropic: startOAuthStub("anthropic", "messages"), copilot: startOAuthStub("github-copilot", "chat-completions") }
  const proxy = startRefusingProxy()
  servers.push({ stop: () => stubs.anthropic.stop() }, { stop: () => stubs.copilot.stop() }, proxy)
  const context: ProbeContext = {
    out,
    workDir,
    scratchParent,
    prepared,
    placeholders: (scenario) => writePlaceholders(join(scratchParent, "placeholders", scenario)),
    realDataDir: args.dataDir,
    realHome: args.home,
    stubs,
    proxy,
    live,
    signal,
    ...(hooks.startHost === undefined ? {} : { startHost: hooks.startHost }),
    ...(hooks.backendFor === undefined ? {} : { backendFor: hooks.backendFor }),
    ...(hooks.listProviders === undefined ? {} : { listProviders: hooks.listProviders }),
  }
  console.log(`MAD OAuth attempt probe — story 2-8c3b\nanthropic stub ${stubs.anthropic.baseURL}; copilot stub ${stubs.copilot.baseURL}; refusing proxy ${proxy.url}; out ${out}`)

  const scenarios: ScenarioRecord[] = []
  for (const scenario of hooks.scenarios ?? SCENARIOS) {
    console.log(`  running: ${scenario.name}`)
    const record = scenario.kind === "registry" ? await runRegistry(context, scenario) : await runAttempt(context, scenario)
    console.log(`    ${record.verdict} — ${record.why}`)
    scenarios.push(record)
  }
  if (context.identity === undefined || signal.aborted) {
    console.error(`\nINCOMPLETE — ${context.identity === undefined ? "no host identity was recorded" : "the probe deadline passed"}. No ${EVIDENCE_FILE} was written.`)
    return 1
  }
  const evidence = buildEvidence({ measuredAt: new Date().toISOString(), sandbox: selfTest, host: context.identity, scenarios, proxyAttempts: proxy.attempts() })
  const text = redactPaths(JSON.stringify(evidence, null, 2), [
    [scratchParent, "<scratch>"],
    [out, "<out>"],
    [prepared, "<prepared>"],
    [args.dataDir, "<data-dir>"],
    [args.home, "<home>"],
  ])
  await writeFile(join(out, EVIDENCE_FILE), `${text}\n`, "utf8")

  const unexpected = scenarios.filter((scenario) =>
    scenario.kind === "attempt" && scenario.expect === "unprobed" ? scenario.verdict !== "UNPROBED" || (scenario.postStop?.problems.length ?? 0) > 0 : scenario.verdict !== "HOLDS",
  )
  console.log(
    `\nEvidence: ${join(out, EVIDENCE_FILE)}\n` +
      scenarios.map((scenario) => `  ${scenario.verdict.padEnd(8)} ${scenario.name}`).join("\n") +
      "\nNo paid token was spent. Exit 0 does not close paired gate 7: OpenAI's OAuth transport is UNPROBED.",
  )
  if (unexpected.length > 0) {
    console.error(`\nNOT AS EXPECTED — ${unexpected.map((scenario) => `${scenario.name}: ${scenario.verdict} (${scenario.why})`).join("; ")}`)
    return 1
  }
  return 0
}

/** `text` with each path replaced by its label, the longest path first so no prefix of a longer one is replaced before it. */
export function redactPaths(text: string, replacements: readonly (readonly [string, string])[]): string {
  let out = text
  for (const [path, label] of [...replacements].filter(([path]) => path.length > 1).sort((a, b) => b[0].length - a[0].length)) out = out.split(path).join(label)
  return out
}

export function parseProbeArgs(argv: readonly string[], home: string = homedir()): { ok: true; args: ProbeArgs } | { ok: false; reason: string } {
  const args = argv.slice(2)
  const values: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    const name = arg.startsWith("--") ? arg.slice(2).split("=")[0]! : ""
    if (!["out", "oauth-data-dir", "oauth-prepared"].includes(name)) {
      return { ok: false, reason: `unexpected argument \`${arg}\`. This command takes --out, --oauth-data-dir and --oauth-prepared only.` }
    }
    if (name in values) return { ok: false, reason: `--${name} was given twice` }
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++index]
    if (value === undefined || value.trim() === "" || !isAbsolute(value)) return { ok: false, reason: `--${name} needs an absolute path` }
    values[name] = resolve(value)
  }
  if (values.out === undefined) return { ok: false, reason: "--out <absolute directory> is required" }
  return {
    ok: true,
    args: {
      out: values.out,
      dataDir: values["oauth-data-dir"] ?? DEFAULT_DATA_DIR,
      ...(values["oauth-prepared"] === undefined ? {} : { prepared: values["oauth-prepared"] }),
      home,
    },
  }
}

/** Test-only: a shorter deadline, a fake body, hooks into the real one, and the home the real data directory links into. */
export interface ProbeSeams extends ProbeHooks {
  deadlineMs?: number
  settleMs?: number
  body?: ProbeBody
  scratchRoot?: string
  home?: string
}

export async function main(argv: readonly string[] = Bun.argv, seams: ProbeSeams = {}): Promise<number> {
  const platform = seams.platform ?? process.platform
  if (platform !== "darwin") {
    console.error(`REFUSED — the OAuth probe runs only on macOS, whose sandbox-exec is its egress control; this platform is ${platform}. No host was started.`)
    return 1
  }
  const parsed = parseProbeArgs(argv, seams.home)
  if (!parsed.ok) {
    console.error(parsed.reason)
    return 1
  }
  const refused = await outProblem(parsed.args.out, seams.scratchRoot)
  if (refused !== null) {
    console.error(refused)
    return 1
  }
  await mkdir(parsed.args.out, { recursive: true })
  const deadlineMs = seams.deadlineMs ?? PROBE_DEADLINE_MS
  const settleMs = seams.settleMs ?? BODY_SETTLE_MS
  const scratch: string[] = []
  const live = new Set<Stoppable>()
  const servers: { stop(): unknown }[] = []
  const controller = new AbortController()
  let cleaning: Promise<string[]> | undefined
  // One cleanup, shared: a signal and main's own way out may both ask for it.
  const cleanup = (): Promise<string[]> => (cleaning ??= cleanupOnce())
  const cleanupOnce = async (): Promise<string[]> => {
    const problems: string[] = []
    for (const host of [...live]) {
      const outcome = await host.stop().catch((error: unknown): StopOutcome => ({ confirmed: false, pid: 0, why: messageOf(error) }))
      if (outcome.confirmed) live.delete(host)
      else problems.push(`the managed host's exit is UNCONFIRMED: check process ${outcome.pid} by hand (${outcome.why})`)
      for (const problem of outcome.postStop?.problems ?? []) problems.push(problem)
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
    const body = (seams.body ?? probeWith(seams))(parsed.args, scratch, live, servers, controller.signal).then(
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
      await rm(join(parsed.args.out, EVIDENCE_FILE), { force: true }).catch(() => undefined)
      console.error(`the probe did not finish within ${deadlineMs} ms. NOTHING ABOVE IS A COMPLETE MEASUREMENT.`)
      return 1
    }
    if ("failed" in bounded) {
      console.error(`the probe failed: ${bounded.failed}. Nothing above is a complete measurement.`)
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
