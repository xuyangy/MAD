#!/usr/bin/env bun
/**
 * Story 2-7f2 — the adversarial zero-bill probe.
 *
 *   bun run adversarial-probe --out /scratch/mad-adversarial-probe --oauth-prepared /scratch/mad-oauth-prepared
 *
 * It runs the measured opencode through the adversarial launcher's own suite
 * composition (`adversarialSuiteConfig`, `runSuiteStage`,
 * `scripts/adversarial.ts`) and records, claim by claim, what a real managed
 * host does to the suite's attempt gate, its per-run host lifecycle and its
 * `StructuredOutput`-only offer. Its evidence is `<out>/adversarial-attempts.json`,
 * committed with its paths replaced by placeholders under `ablation/evidence/`.
 *
 * ## It bills nothing, and it can reach nothing
 *
 * - **The sandbox.** macOS only. Every host is spawned through `sandboxSpawn`
 *   (`scripts/oauth-probe.ts`): `sandbox-exec` denying all outbound network but
 *   loopback. `sandboxSelfTest` runs first, and a failure refuses the probe
 *   before any host exists.
 * - **The refusing proxy** lists each destination a host asked for and forwards
 *   nothing. It is an observation aid, not the control.
 * - **Placeholder sign-ins.** Every data directory's `auth.json` is a symlink to
 *   a placeholder file the probe wrote under its own scratch. The user's store is
 *   never linked, opened or named in a route.
 * - **The stubs.** `anthropic/claude-sonnet-5` is pointed at a Messages stub and
 *   `github-copilot/gpt-5-mini` at a chat-completions stub
 *   (`ablation/adversarial-stub.ts`) through the managed host's probe-only
 *   `baseURL` overrides.
 *
 * ## What it runs, and what it leaves out
 *
 * Each scenario seals a schedule in a root of its own and runs
 * `runAdversarialSuite` on the launcher's `oauthHostLifecycle`. Two seams are
 * wrapped and nothing else: `startHost` adds the sandbox spawn, the proxy and
 * the stub's `baseURL` and then calls the ordinary `startManagedHost`, so every
 * stop is held to the ordinary store guard; `createBackend` builds the real
 * `OpencodeModelBackend` from the options the lifecycle passes and wraps it to
 * count `runTurn` calls and read the journal at each entry.
 *
 * The launcher's stages 1 and 2 (the offline preflight, the authorization and
 * the reservation) are not run on a real host. One row runs the shipped command
 * as a child process and records that it still refuses.
 *
 * The schedules are `provenance: "scripted"`, and they are sealed against a
 * private copy of protocol v3 stamped frozen by the file's own hash rule
 * (`frozenProtocolFixture`). The copy is a fixture: it pre-registers nothing
 * and freezes nothing, and the repository's protocol file is never written.
 *
 * ## Host ownership
 *
 * Every process the probe starts is owned by one `HostOwner`, which holds one
 * bounded stop for it. The lifecycle's stop, the probe's cleanup and a start
 * that outlived its bound all get that same stop, and its outcome is kept. A
 * stop that is unconfirmed, rejects or passes its bound, and a start that has
 * not returned, each end the probe before another host starts: no evidence is
 * written, the exit is 1, and the scratch is kept. The calibration host must
 * also stop with its post-stop checks present and clean. A confirmed stop whose
 * post-stop check failed is a FAILS that lets later scenarios run.
 *
 * ## Transports
 *
 * A result holds for its exact provider, model and route. `openai` is UNPROBED:
 * its OAuth transport ignores `baseURL`. `github-copilot/gpt-6-luna` is
 * UNPROBED: the measured host serves it over `/responses`, which no stub here
 * answers.
 *
 * ## Verdicts
 *
 * Each scenario lists its claims, and each claim is HOLDS, FAILS or UNPROBED.
 * FAILS is an observed outcome that contradicts the claim. UNPROBED is a branch
 * the real host cannot reach, or an observation an earlier failure blocked,
 * which it names. Four records are reported apart: journaled issued attempts
 * (seeded lines apart from the scenario's own), refusals, backend `runTurn`
 * calls and physical stub requests. A request beyond an attempt's first is
 * classified from what the stub served; the classification rests on time-window
 * attribution and says so.
 *
 * ## Exit status
 *
 * 0 when every scenario ran and no claim FAILS. The evidence is written when
 * every scenario ran, whatever the verdicts. Exit 0 does not close gate 11.
 */

import { createHash, randomBytes } from "node:crypto"
import { writeFileSync } from "node:fs"
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, isAbsolute, join, resolve, sep } from "node:path"

import { OpencodeModelBackend, type OpencodeBackendOptions } from "../adapters/opencode/model-backend.ts"
import { startRefusingProxy, type RefusingProxy } from "../ablation/accounting-stub.ts"
import { startAdversarialStub, type AdversarialStub, type AdversarialStubRequest, type AdversarialStubScript, type StubRun } from "../ablation/adversarial-stub.ts"
import {
  ADVERSARIAL_HOST_OFFER,
  ADVERSARIAL_START_MARKER_FILE,
  adversarialDirectory,
  createAdversarialSchedule,
  type AdversarialSchedule,
} from "../ablation/adversarial-schedule.ts"
import { codeRevisionFrom } from "../ablation/bundle.ts"
import { ADVERSARIAL_ATTEMPT_ALLOWANCES, HALT_MARKER_FILE } from "../ablation/governor.ts"
import { JOURNAL_FILE, type IssuedLine, type JournalLine, type SettledLine } from "../ablation/journal.ts"
import {
  MEASURED_HOST,
  OAUTH_PAYLOAD,
  startManagedHost,
  type ManagedHostOptions,
  type ManagedHostStart,
  type SpawnHost,
  type StopOutcome,
} from "../ablation/managed-host.ts"
import { unknownValue, type CodeRevision, type Maybe } from "../ablation/manifest.ts"
import { authLinkPaths, verifyPrepared } from "../ablation/oauth-payload.ts"
import type { OAuthStubFormat } from "../ablation/oauth-stub.ts"
import { sha256 } from "../ablation/schedule.ts"
import type { Candidate } from "../core/domain/roster.ts"
import { systemClock, type Clock } from "../core/ports/clock.ts"
import type { ModelBackend } from "../core/ports/model-backend.ts"
import type { Pin } from "../core/roster/select.ts"
import { ADVERSARIAL_ASSERTIONS } from "../fixtures/adversarial/assertions.ts"
import {
  ADVERSARIAL_HOSTS_FILE,
  ADVERSARIAL_TURN_TIMEOUT_MS,
  adversarialRoster,
  adversarialSuiteConfig,
  PROTOCOL_V3_FILE,
  runSuiteStage,
  within,
  type HostRecord,
} from "./adversarial.ts"
import { journalLines, placeholderAuth, redactPaths, sandboxSelfTest, sandboxSpawn, type SelfTest } from "./oauth-probe.ts"
import { boundedGit, PREFLIGHT_GIT_CLEANUP_MS, PREFLIGHT_GIT_DEADLINE_MS, preflightSpawn, productionTools, REPO_ROOT, toolsWiringProblem } from "./paired.ts"

export const EVIDENCE_KIND = "ZERO-BILL ADVERSARIAL PROBE (story 2-7f2) — the measured opencode on stub providers; no provider was reached"
export const EVIDENCE_FILE = "adversarial-attempts.json"
export const PROBE_SCRATCH_PREFIX = "mad-adversarial-probe-"

// The outer bounds, fixed before any host starts. A measured value may tighten a scenario's bound and never loosens one.
export const HOST_START_MS = 120_000
export const ROSTER_READ_MS = 30_000
export const HANG_TURN_MS = 5_000
export const HANG_SLACK_MS = 5_000
export const NO_USAGE_TURN_MS = 20_000
export const CALIBRATION_TURN_MS = 60_000
export const TEARDOWN_MS = 30_000
export const SCENARIO_MS = 1_200_000
export const PROBE_MS = 7_200_000
export const SHIPPED_COMMAND_MS = 120_000
/** How long after a `runTurn` call returned a stub request is still attributed to it. */
export const ATTRIBUTION_SLACK_MS = 2_000

export interface Transport {
  providerId: string
  modelId: string
  format: OAuthStubFormat
}

/** The two transports a stub can stand in for, each with the exact model probed. */
export const TRANSPORTS: readonly Transport[] = [
  { providerId: "anthropic", modelId: "claude-sonnet-5", format: "messages" },
  { providerId: "github-copilot", modelId: "gpt-5-mini", format: "chat-completions" },
]

/** What this probe cannot observe, and why. */
export const UNPROBED_TRANSPORTS: readonly { transport: string; why: string }[] = [
  {
    transport: "openai (any model)",
    why: "OpenAI's OAuth transport ignores the provider `baseURL` override, so no stub can stand in for it and a sandboxed host cannot reach it",
  },
  {
    transport: "github-copilot/gpt-6-luna and any other github-copilot model served over `/responses`",
    why:
      "the measured host sent `POST /responses` for this model during calibration, and no stub here answers the Responses API (the " +
      "chat-completions stub answered 404, a stub limitation that says nothing about the provider)",
  },
]

export type Verdict = "HOLDS" | "FAILS" | "UNPROBED"

export interface Claim {
  id: string
  claim: string
  verdict: Verdict
  why: string
}

export type ScenarioKind =
  | "healthy"
  | "run-allowance"
  | "root-allowance"
  | "non-ending"
  | "cancel-in-flight"
  | "integrity-before-start"
  | "integrity-injected"
  | "host-offer"
  | "stream-without-usage"

export interface ScenarioSpec {
  kind: ScenarioKind
  name: string
  what: string
}

export const SCENARIOS: readonly ScenarioSpec[] = [
  {
    kind: "healthy",
    name: "healthy suite",
    what: "the stub answers every stage; sixteen runs, each on a host and a data directory of its own",
  },
  {
    kind: "run-allowance",
    name: "run allowance",
    what: "the first run's discovery answer carries 31 findings, which asks for 32 attempts against the run's 30",
  },
  {
    kind: "root-allowance",
    name: "root allowance",
    what: "the suite's journal is seeded with 480 settled attempts before the suite opens it",
  },
  {
    kind: "non-ending",
    name: "non-ending attempt",
    what: `the stub never answers the first model request; the turn deadline is shortened to ${HANG_TURN_MS} ms through the backend seam`,
  },
  {
    kind: "cancel-in-flight",
    name: "cancellation in flight",
    what: "the probe sets the suite's signal when the first model request reaches the stub, which then never answers",
  },
  {
    kind: "integrity-before-start",
    name: "integrity failure before the start",
    what: "the suite's journal is seeded with one issued line that was never settled",
  },
  {
    kind: "integrity-injected",
    name: "integrity failure in a run (injected)",
    what:
      "the stub answers the first model request with HTTP 400; when the real backend returns that envelope, the probe's wrapper reports two " +
      "unequal SYNTHETIC token payloads for its execution id and returns the envelope unchanged",
  },
  {
    kind: "host-offer",
    name: "host tool offer (protocol v3 B8)",
    what: "the stub's first answer calls a file-reading tool the host did not offer, on a canary file inside the worktree; its next answer calls StructuredOutput",
  },
  {
    kind: "stream-without-usage",
    name: "stream without usage (observation)",
    what: `the stub leaves the usage figures out of an otherwise valid stream; the turn deadline is shortened to ${NO_USAGE_TURN_MS} ms`,
  },
]

// ---------------------------------------------------------------------------
// What a scenario observed
// ---------------------------------------------------------------------------

export interface IssuedFact {
  physicalId: string
  position: number | null
  /** How many `settled` lines name it. */
  settlements: number
  kind: string | null
  abandoned: boolean
  executionId: boolean
}

export interface CallFact {
  position: number | null
  startedAt: number
  endedAt: number | null
  /** Issued lines with no settlement in the journal file when `runTurn` was entered, or `null` when it could not be read. */
  unsettledAtEntry: number | null
  /** The physical id of that line when there was exactly one, else `null`. An identifier the journal minted, never content. */
  entryId: string | null
  /** The run id that line carries, and the schedule position the suite's slot report gives that run. */
  entryRunId: string | null
  entryPosition: number | null
  disposition: "ok" | "failed" | "threw" | "open"
  failure: string | null
  usageUnknown: boolean
  abandoned: boolean
}

export interface RequestFact extends Omit<AdversarialStubRequest, "at" | "closed" | "run"> {
  atMs: number
  position: number | null
  closedAfterMs: number | null
  /** As `unsettledAtEntry` and `entryId`, read when the request reached the stub. */
  unsettledAtArrival: number | null
  arrivalId: string | null
}

export interface HostFact {
  event: HostRecord["event"]
  ok: boolean
  position: number
  detail: string
}

export interface ScenarioFacts {
  kind: ScenarioKind
  /** Why `runAdversarialSuite` refused before its start marker, or `null`. */
  refused: string | null
  complete: boolean
  halt: string | null
  stop: string | null
  haltMarker: boolean
  startMarker: boolean
  slots: { position: number; status: string; reason: string }[]
  overshoot: { root: number; suite: number; runs: number[] } | null
  integrity: { reason: string; payloads: number }[]
  refusals: { cause: string; position: number | null }[]
  seeded: { issued: number; unsettled: number }
  issued: IssuedFact[]
  journalProblems: string[]
  calls: CallFact[]
  maxConcurrentCalls: number
  requests: RequestFact[]
  hosts: { starts: number; records: HostFact[]; unestablished: string[]; recordFailure: string | null }
  /** The injected-conflict scenario only: whether the two synthetic reports were made, and why not. */
  injected: { reported: boolean; why: string } | null
  /** The cancellation scenario only: whether the probe set the signal at a stub request. */
  cancelled: boolean
  /** The host-offer scenario only: the tool the stub's scripted call named. */
  unofferedTool: string | null
  /** Why no further host may start after this scenario: a stop that is not confirmed, or a start that has not returned. */
  unsafe: string[]
  /** The bound that passed, or `null`. */
  deadline: string | null
  turnTimeoutMs: number | null
  egress: string[]
  elapsedMs: number
}

/** A physical request beyond an attempt's first, and how it is read. */
export interface ExtraRequest {
  position: number | null
  requestIndex: number
  classification: "tool-continuation" | "after-served-failure" | "unexplained"
  why: string
}

const claim = (id: string, text: string, verdict: Verdict, why: string): Claim => ({ id, claim: text, verdict, why })
const modelRequests = (facts: ScenarioFacts) => facts.requests.filter((request) => request.model && request.stage !== "side")
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

/**
 * The stub requests attributed to each call, in call order. A request belongs
 * to the latest call of its run that had been entered when it arrived, provided
 * it arrived before that call returned plus the slack; a request no call's
 * window holds is attributed to none. Attribution by time, with its limits.
 */
export function requestsPerCall(facts: ScenarioFacts, startedAt: number, withSide = false): RequestFact[][] {
  const perCall: RequestFact[][] = facts.calls.map(() => [])
  for (const request of withSide ? facts.requests.filter((entry) => entry.model) : modelRequests(facts)) {
    let owner = -1
    facts.calls.forEach((call, index) => {
      if (request.position !== null && call.position !== request.position) return
      if (call.startedAt - startedAt <= request.atMs && (owner === -1 || call.startedAt >= facts.calls[owner]!.startedAt)) owner = index
    })
    if (owner === -1) continue
    const to = (facts.calls[owner]!.endedAt ?? Number.POSITIVE_INFINITY) - startedAt + ATTRIBUTION_SLACK_MS
    if (request.atMs <= to) perCall[owner]!.push(request)
  }
  return perCall
}

/**
 * Each request beyond its attempt's first: a tool continuation when the stub
 * had served a tool call and the request carries a tool result, an observed
 * retry pattern when the stub had served a failure, and unexplained otherwise.
 * The host's internal cause is not established by any of these.
 */
export function extraRequests(facts: ScenarioFacts, startedAt: number): ExtraRequest[] {
  const extras: ExtraRequest[] = []
  for (const requests of requestsPerCall(facts, startedAt)) {
    for (let index = 1; index < requests.length; index += 1) {
      const request = requests[index]!
      const before = requests[index - 1]!
      const failure = before.served === "http-400" || before.served === "http-500" || before.served === "no-usage" || before.served === "hang"
      const classification: ExtraRequest["classification"] =
        request.toolResult !== null && before.served === "unoffered-tool" ? "tool-continuation" : failure ? "after-served-failure" : "unexplained"
      extras.push({
        position: request.position,
        requestIndex: request.index,
        classification,
        why:
          classification === "tool-continuation"
            ? "the stub had served a tool call and this request carries its tool result"
            : classification === "after-served-failure"
              ? `the stub had served \`${before.served}\` to the request before it: an observed re-send pattern, whose cause inside the host is not established`
              : `the stub had served \`${before.served}\` to the request before it, and nothing it served explains a further request`,
      })
    }
  }
  return extras
}

const hostEvents = (facts: ScenarioFacts, event: HostRecord["event"]) => facts.hosts.records.filter((record) => record.event === event)

/** The first failure that stops later runs from happening: a deadline, or a host stop that is not established. */
function blocker(facts: ScenarioFacts): string | null {
  if (facts.deadline !== null) return facts.deadline
  const stop = hostEvents(facts, "stop").find((record) => !record.ok)
  if (stop !== undefined) return `the stop of run ${stop.position}'s host is not confirmed (${stop.detail})`
  const post = hostEvents(facts, "postStop").find((record) => !record.ok)
  if (post !== undefined) return `the post-stop check of run ${post.position}'s host failed (${post.detail})`
  const start = hostEvents(facts, "start").find((record) => !record.ok)
  if (start !== undefined) return `the host of run ${start.position} did not start (${start.detail})`
  const verify = hostEvents(facts, "verify").find((record) => !record.ok)
  if (verify !== undefined) return `the host of run ${verify.position} failed its verification (${verify.detail})`
  if (facts.hosts.recordFailure !== null) return facts.hosts.recordFailure
  return null
}

/** Stop confirmation and the post-stop checks, as two claims over the hosts that were started. */
export function hostStopClaims(facts: ScenarioFacts): Claim[] {
  const started = hostEvents(facts, "start").filter((record) => record.ok).length
  const stops = hostEvents(facts, "stop")
  const posts = hostEvents(facts, "postStop")
  const none = "no host was started, so there is no stop to observe"
  const stopClaim =
    started === 0
      ? claim("stop-confirmed", "every started host's stop is confirmed", "UNPROBED", none)
      : stops.length === started && stops.every((record) => record.ok)
        ? claim("stop-confirmed", "every started host's stop is confirmed", "HOLDS", `${plural(started, "host")} started and ${plural(stops.length, "stop")} confirmed`)
        : claim(
            "stop-confirmed",
            "every started host's stop is confirmed",
            "FAILS",
            `${plural(started, "host")} started; ${stops.filter((record) => record.ok).length} of ${plural(stops.length, "recorded stop")} confirmed` +
              (stops.find((record) => !record.ok) === undefined ? "" : `: ${stops.find((record) => !record.ok)!.detail}`),
          )
  const postClaim =
    started === 0
      ? claim("post-stop-clean", "every started host's post-stop checks are present and clean (the ordinary store guard included)", "UNPROBED", none)
      : posts.length === started && posts.every((record) => record.ok)
        ? claim(
            "post-stop-clean",
            "every started host's post-stop checks are present and clean (the ordinary store guard included)",
            "HOLDS",
            `${plural(posts.length, "post-stop record")}, each with no problem`,
          )
        : claim(
            "post-stop-clean",
            "every started host's post-stop checks are present and clean (the ordinary store guard included)",
            "FAILS",
            `${posts.filter((record) => record.ok).length} of ${plural(posts.length, "post-stop record")} clean for ${plural(started, "started host")}` +
              (posts.find((record) => !record.ok) === undefined ? "" : `: ${posts.find((record) => !record.ok)!.detail}`),
          )
  return [stopClaim, postClaim]
}

/** Whether the host's `/config/providers` answer resolved the sealed one-slot roster, over the hosts that were asked. */
export function rosterClaim(facts: ScenarioFacts, pin: string): Claim {
  const text = `the real host's roster resolves the sealed one-slot identity ${pin} with tool capability`
  const verify = hostEvents(facts, "verify")
  if (verify.length === 0) return claim("roster", text, "UNPROBED", `no host reached its roster read${blocker(facts) === null ? "" : `: ${blocker(facts)}`}`)
  const failed = verify.find((record) => !record.ok)
  return failed === undefined
    ? claim("roster", text, "HOLDS", `${plural(verify.length, "host")} resolved it, one read each`)
    : claim("roster", text, "FAILS", `run ${failed.position}'s host: ${failed.detail}`)
}

/**
 * Journal before issue, per attempt. At each `runTurn` entry the journal file
 * must hold exactly one unsettled issued line, and that line must be this
 * attempt's: one the scenario issued, new to this call, carrying the run the
 * suite's slot report gives this call's position, and settled exactly once by
 * the end. Each request the call is attributed must find that same line still
 * unsettled. A count alone certifies nothing: a stale, reused, wrong-run or
 * ambiguous snapshot fails.
 */
function journalBeforeIssue(facts: ScenarioFacts, startedAt: number): Claim {
  const text =
    "at every `runTurn` entry the journal file holds exactly one unsettled issued line, and it is that attempt's: issued by the scenario, new to the call, " +
    "bound to the call's run, still the one unsettled line at each of the call's requests, and settled once afterwards"
  const arrivals = modelRequests(facts)
  if (facts.calls.length === 0 && arrivals.length === 0) {
    return claim("journal-before-issue", text, "UNPROBED", `no attempt was observed${blocker(facts) === null ? "" : `: ${blocker(facts)}`}`)
  }
  const issued = new Map(facts.issued.map((line) => [line.physicalId, line]))
  const seen = new Map<string, number>()
  const problems: string[] = []
  const perCall = requestsPerCall(facts, startedAt)
  facts.calls.forEach((call, index) => {
    const name = `call ${index + 1}${call.position === null ? "" : ` (run ${call.position})`}`
    if (call.unsettledAtEntry === null) problems.push(`${name}: the journal could not be read at entry`)
    else if (call.unsettledAtEntry === 0) problems.push(`${name}: no unsettled issued line at entry`)
    else if (call.unsettledAtEntry > 1 || call.entryId === null) problems.push(`${name}: ${call.unsettledAtEntry} unsettled issued lines at entry, so which is this attempt's is ambiguous`)
    else if (!issued.has(call.entryId)) problems.push(`${name}: the unsettled line at entry is not one this scenario issued (stale or seeded)`)
    else if (seen.has(call.entryId)) problems.push(`${name}: the unsettled line at entry was already call ${seen.get(call.entryId)! + 1}'s (reused)`)
    else if (call.position === null || call.entryPosition !== call.position) {
      problems.push(`${name}: the unsettled line at entry belongs to ${call.entryPosition === null ? "no run the suite reported" : `run ${call.entryPosition}`}, not to this call's run`)
    } else if (issued.get(call.entryId)!.settlements !== 1) problems.push(`${name}: its line has ${issued.get(call.entryId)!.settlements} settlements, not one`)
    if (call.entryId !== null && !seen.has(call.entryId)) seen.set(call.entryId, index)
    for (const request of perCall[index]!) {
      if (request.unsettledAtArrival !== 1 || request.arrivalId === null) {
        problems.push(`request ${request.index}: ${request.unsettledAtArrival ?? "an unreadable number of"} unsettled issued lines when it reached the stub, not exactly one`)
      } else if (request.arrivalId !== call.entryId) problems.push(`request ${request.index}: the unsettled line when it reached the stub is not the one ${name} saw at entry`)
    }
  })
  const attributed = new Set(perCall.flat().map((request) => request.index))
  for (const request of arrivals) if (!attributed.has(request.index)) problems.push(`request ${request.index}: it falls in no \`runTurn\` call's window, so its attempt is not identified`)
  if (problems.length > 0) {
    return claim("journal-before-issue", text, "FAILS", `${plural(problems.length, "observation")} failed: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? "; …" : ""}`)
  }
  return claim(
    "journal-before-issue",
    text,
    "HOLDS",
    `${facts.calls.length} \`runTurn\` ${facts.calls.length === 1 ? "entry" : "entries"} and ${plural(arrivals.length, "model request")} observed, over ${plural(new Set(facts.calls.map((call) => call.position)).size, "run")}; ` +
      `each entry found one unsettled line, with ${plural(seen.size, "distinct physical id")}, each bound to its call's run by the suite's slot report. ` +
      "A request is tied to its call by time window, which is evidence with limits",
  )
}

function countedOnce(facts: ScenarioFacts): Claim {
  const text = "each attempt the scenario issued is journaled once: one issued line, one settlement, one `runTurn` call"
  if (facts.issued.length === 0) return claim("counted-once", text, "UNPROBED", `no attempt was issued${blocker(facts) === null ? "" : `: ${blocker(facts)}`}`)
  const ids = new Set(facts.issued.map((line) => line.physicalId))
  const problems: string[] = [...facts.journalProblems]
  if (ids.size !== facts.issued.length) problems.push(`${facts.issued.length - ids.size} issued line(s) repeat a physical id`)
  const unsettled = facts.issued.filter((line) => line.settlements !== 1)
  if (unsettled.length > 0) problems.push(`${plural(unsettled.length, "issued line")} did not have exactly one settlement`)
  const notIssued = facts.issued.filter((line) => line.kind === "not-issued").length
  if (facts.calls.length !== facts.issued.length - notIssued) {
    problems.push(`${plural(facts.issued.length - notIssued, "issued attempt")} that reached a backend and ${plural(facts.calls.length, "`runTurn` call")}`)
  }
  return problems.length === 0
    ? claim("counted-once", text, "HOLDS", `${plural(facts.issued.length, "issued line")}, each settled once, and ${plural(facts.calls.length, "`runTurn` call")}`)
    : claim("counted-once", text, "FAILS", problems.join("; "))
}

function serialAdmission(facts: ScenarioFacts): Claim {
  const text = "admission is serial and no allowance is overshot: never two attempts in flight, and overshoot 0 for the root, the suite and every run"
  if (facts.calls.length === 0 || facts.overshoot === null) {
    return claim("serial-no-overshoot", text, "UNPROBED", `no attempt was observed${blocker(facts) === null ? "" : `: ${blocker(facts)}`}`)
  }
  const most = Math.max(0, ...[...facts.calls.map((call) => call.unsettledAtEntry), ...modelRequests(facts).map((request) => request.unsettledAtArrival)].map((value) => value ?? 0))
  const over = facts.overshoot.root + facts.overshoot.suite + facts.overshoot.runs.reduce((sum, value) => sum + value, 0)
  const problems: string[] = []
  if (facts.maxConcurrentCalls > 1) problems.push(`${facts.maxConcurrentCalls} \`runTurn\` calls were open at once`)
  if (most > 1) problems.push(`${most} issued lines were unsettled at one observation`)
  if (over > 0) problems.push(`the overshoot report sums to ${over}`)
  return problems.length === 0
    ? claim("serial-no-overshoot", text, "HOLDS", `at most one \`runTurn\` call and one unsettled issued line at any observation; overshoot 0 over ${plural(facts.overshoot.runs.length, "run")}`)
    : claim("serial-no-overshoot", text, "FAILS", problems.join("; "))
}

/** `text` scoped to the runs that happened, for a claim that holds only over what was observed. */
function scoped(facts: ScenarioFacts, held: Claim): Claim {
  if (held.verdict !== "HOLDS") return held
  const runs = facts.slots.filter((slot) => slot.status === "completed").length
  return runs === ADVERSARIAL_ATTEMPT_ALLOWANCES.runs
    ? held
    : { ...held, why: `${held.why}. This holds for the runs and attempts observed only: ${runs} of ${ADVERSARIAL_ATTEMPT_ALLOWANCES.runs} runs completed` }
}

export function healthyClaims(facts: ScenarioFacts, pin: string, startedAt = 0): Claim[] {
  const [stopClaim, postClaim] = hostStopClaims(facts)
  const starts = hostEvents(facts, "start").map((record) => record.position)
  const ordered = starts.every((position, index) => position === index + 1)
  const text = "sixteen hosts start in schedule order, each after the one before it stopped, and the suite reads complete"
  let full: Claim
  if (facts.complete && starts.length === ADVERSARIAL_ATTEMPT_ALLOWANCES.runs && ordered) full = claim("full-suite", text, "HOLDS", "16 host starts in positions 1 to 16, and the suite is complete")
  else {
    full = claim(
      "full-suite",
      text,
      "FAILS",
      `${plural(starts.length, "host start")}${ordered ? "" : ", not in schedule order"}; complete: ${facts.complete}` +
        `${facts.halt === null ? "" : `; halt: ${facts.halt}`}${facts.stop === null ? "" : `; stop: ${facts.stop}`}${blocker(facts) === null ? "" : `; ${blocker(facts)}`}`,
    )
  }
  return [rosterClaim(facts, pin), scoped(facts, journalBeforeIssue(facts, startedAt)), scoped(facts, countedOnce(facts)), scoped(facts, serialAdmission(facts)), stopClaim!, postClaim!, full]
}

export function runAllowanceClaims(facts: ScenarioFacts): Claim[] {
  const limit = ADVERSARIAL_ATTEMPT_ALLOWANCES.run
  const issued = facts.issued.filter((line) => line.position === 1 && line.kind !== "not-issued").length
  const calls = facts.calls.filter((call) => call.position === 1).length
  const refusals = facts.refusals.filter((refusal) => refusal.position === 1)
  const first = facts.slots.find((slot) => slot.position === 1)
  const claims: Claim[] = []
  const reached = refusals.length > 0
  const blocked = `the run's allowance was never reached: ${plural(issued, "attempt")} issued for run 1${blocker(facts) === null ? "" : `; ${blocker(facts)}`}`
  claims.push(
    !reached
      ? claim("run-cap-issued", `exactly ${limit} attempts are issued for the run`, facts.deadline === null && facts.refused === null ? "FAILS" : "UNPROBED", blocked)
      : claim("run-cap-issued", `exactly ${limit} attempts are issued for the run`, issued === limit ? "HOLDS" : "FAILS", `${plural(issued, "attempt")} issued for run 1`),
  )
  claims.push(
    !reached
      ? claim("run-cap-refusal", "a refusal on the run's allowance has cause `budget` and reaches no backend", "UNPROBED", blocked)
      : refusals.every((refusal) => refusal.cause === "budget") && calls === issued
        ? claim(
            "run-cap-refusal",
            "a refusal on the run's allowance has cause `budget` and reaches no backend",
            "HOLDS",
            `${plural(refusals.length, "refusal")}, each \`budget\`; ${plural(calls, "`runTurn` call")} for run 1, one per issued attempt, so no refused attempt entered the backend`,
          )
        : claim(
            "run-cap-refusal",
            "a refusal on the run's allowance has cause `budget` and reaches no backend",
            "FAILS",
            `causes ${[...new Set(refusals.map((refusal) => refusal.cause))].join(", ")}; ${plural(calls, "`runTurn` call")} against ${plural(issued, "issued attempt")} for run 1`,
          ),
  )
  claims.push(
    !reached
      ? claim("run-cap-fails-run", "the refused run is recorded failed for budget", "UNPROBED", blocked)
      : claim(
          "run-cap-fails-run",
          "the refused run is recorded failed for budget",
          first?.status === "failed" && first.reason.includes("(budget)") ? "HOLDS" : "FAILS",
          `run 1 is \`${first?.status ?? "missing"}\``,
        ),
  )
  const later = facts.slots.filter((slot) => slot.position > 1)
  const completed = later.filter((slot) => slot.status === "completed").length
  const stopped = blocker(facts)
  claims.push(
    completed === later.length && later.length === ADVERSARIAL_ATTEMPT_ALLOWANCES.runs - 1
      ? claim("run-cap-later-runs", "every later run proceeds", "HOLDS", `runs 2 to 16 completed (${completed})`)
      : stopped !== null
        ? claim("run-cap-later-runs", "every later run proceeds", "UNPROBED", `blocked: ${stopped}; ${completed} of ${later.length} later runs completed`)
        : claim("run-cap-later-runs", "every later run proceeds", "FAILS", `${completed} of ${later.length} later runs completed; stop: ${facts.stop ?? "none"}; halt: ${facts.halt ?? "none"}`),
  )
  return [...claims, ...hostStopClaims(facts)]
}

export function rootAllowanceClaims(facts: ScenarioFacts): Claim[] {
  const limit = ADVERSARIAL_ATTEMPT_ALLOWANCES.global
  const named = `the suite root's global allowance is exhausted: ${limit} of ${limit} admitted attempts`
  const requests = modelRequests(facts).length
  const later = facts.slots.filter((slot) => slot.position > 1)
  if (facts.refused !== null || facts.deadline !== null || (facts.stop === null && facts.halt === null && facts.calls.length === 0 && facts.hosts.starts === 0)) {
    const why = `the root allowance was not reached: ${facts.refused ?? facts.deadline ?? "no host was started and nothing was refused"}`
    return [claim("root-cap-stop", "a refusal on the root's allowance is a runner stop that names it", facts.deadline !== null ? "UNPROBED" : "FAILS", why), ...hostStopClaims(facts)]
  }
  return [
    claim("root-cap-seeded", `the seeded journal holds ${limit} settled attempts and the scenario issues none`, facts.seeded.issued === limit && facts.issued.length === 0 ? "HOLDS" : "FAILS", `${facts.seeded.issued} seeded, ${facts.issued.length} newly issued`),
    claim("root-cap-stop", "a refusal on the root's allowance is a runner stop that names it", facts.stop === named ? "HOLDS" : "FAILS", `stop: ${facts.stop ?? "none"}; halt: ${facts.halt ?? "none"}`),
    claim(
      "root-cap-no-backend",
      "the refused admission reaches no backend: zero `runTurn` calls and zero model requests",
      facts.calls.length === 0 && requests === 0 ? "HOLDS" : "FAILS",
      `${plural(facts.calls.length, "`runTurn` call")}, ${plural(requests, "model request")}`,
    ),
    claim(
      "root-cap-later-slots",
      "every later slot is recorded not-attempted and no later host starts",
      later.every((slot) => slot.status === "not-attempted") && facts.hosts.starts <= 1 ? "HOLDS" : "FAILS",
      `${later.filter((slot) => slot.status === "not-attempted").length} of ${later.length} later slots not-attempted; ${plural(facts.hosts.starts, "host start")}`,
    ),
    ...hostStopClaims(facts),
  ]
}

/** The claims shared by every scenario that must end the suite at its first run: nothing follows the stopping event. */
function nothingLater(facts: ScenarioFacts, lastRequest: number): Claim {
  const requests = modelRequests(facts).length
  return claim(
    "nothing-later",
    "no later host starts and no later model request is sent",
    facts.hosts.starts <= 1 && requests <= lastRequest ? "HOLDS" : "FAILS",
    `${plural(facts.hosts.starts, "host start")}, ${plural(requests, "model request")}`,
  )
}

function haltClaim(facts: ScenarioFacts): Claim {
  return claim(
    "halt-and-marker",
    "the suite halts and writes its halt marker",
    facts.halt !== null && facts.haltMarker ? "HOLDS" : "FAILS",
    `halt: ${facts.halt ?? "none"}; marker ${facts.haltMarker ? "present" : "absent"}`,
  )
}

export function nonEndingClaims(facts: ScenarioFacts): Claim[] {
  const call = facts.calls[0]
  const line = facts.issued[0]
  if (call === undefined || line === undefined) {
    const why = `no attempt was issued: ${facts.refused ?? blocker(facts) ?? "the suite ended before its first attempt"}`
    return [claim("abandoned-within-bound", "an attempt that does not end is settled `abandoned` within its bound", facts.refused !== null ? "FAILS" : "UNPROBED", why), ...hostStopClaims(facts)]
  }
  const bound = (facts.turnTimeoutMs ?? 0) + HANG_SLACK_MS
  const took = call.endedAt === null ? null : call.endedAt - call.startedAt
  const hung = modelRequests(facts).find((request) => request.served === "hang")
  return [
    claim(
      "abandoned-within-bound",
      "an attempt that does not end is settled `abandoned` within its bound",
      line.kind === "unknown" && line.abandoned && took !== null && took <= bound ? "HOLDS" : "FAILS",
      `settled \`${line.kind ?? "nothing"}\`${line.abandoned ? ", abandoned" : ""}; the call took ${took ?? "an unknown number of"} ms against ${facts.turnTimeoutMs} ms plus ${HANG_SLACK_MS} ms`,
    ),
    claim("abandoned-counts-one", "the abandoned attempt counts as one issued attempt", facts.issued.length === 1 && line.settlements === 1 ? "HOLDS" : "FAILS", `${plural(facts.issued.length, "issued line")}, ${plural(line.settlements, "settlement")}`),
    haltClaim(facts),
    claim(
      "connection-closed",
      "the request the stub held is closed",
      hung !== undefined && hung.closedAfterMs !== null ? "HOLDS" : "FAILS",
      hung === undefined ? "the stub served no hang" : hung.closedAfterMs === null ? "the connection was still open when the scenario ended" : `closed after ${hung.closedAfterMs} ms`,
    ),
    ...hostStopClaims(facts),
    nothingLater(facts, 1),
  ]
}

export function cancelClaims(facts: ScenarioFacts): Claim[] {
  const counted = facts.issued.filter((line) => line.kind !== "not-issued")
  const notIssued = facts.issued.filter((line) => line.kind === "not-issued")
  if (!facts.cancelled || counted.length === 0) {
    const why = `the probe set no signal at a stub request: ${facts.refused ?? blocker(facts) ?? "no model request reached the stub"}`
    return [claim("cancelled-counts-one", "an attempt in flight when the signal is set still counts one", facts.refused !== null ? "FAILS" : "UNPROBED", why), ...hostStopClaims(facts)]
  }
  return [
    claim(
      "cancelled-counts-one",
      "an attempt in flight when the signal is set still counts one",
      counted.length === 1 && counted[0]!.settlements <= 1 ? "HOLDS" : "FAILS",
      `${plural(counted.length, "counted issued line")}; settled \`${counted[0]!.kind ?? "nothing"}\``,
    ),
    haltClaim(facts),
    notIssued.length === 0
      ? claim(
          "not-issued-release",
          "an admission settled `not-issued` releases its reservation and counts nothing",
          "UNPROBED",
          "no `not-issued` settlement occurred: it arises only when the signal has fired by the time admission resolves, so the stage never calls `runTurn` and no host is involved. " +
            "Scripted evidence: ablation/journal-adversarial.test.ts, \"a not-issued settlement releases its reservation exactly once\"",
        )
      : claim(
          "not-issued-release",
          "an admission settled `not-issued` releases its reservation and counts nothing",
          facts.overshoot !== null && notIssued.every((line) => line.settlements === 1) ? "HOLDS" : "FAILS",
          `${plural(notIssued.length, "`not-issued` settlement")} observed, each settled once`,
        ),
    ...hostStopClaims(facts),
    nothingLater(facts, 1),
  ]
}

export function integrityBeforeStartClaims(facts: ScenarioFacts): Claim[] {
  const requests = modelRequests(facts).length
  return [
    claim(
      "refused-as-halted",
      "work found unsettled on reopen refuses the suite as halted",
      facts.refused !== null && facts.refused.includes("already halted") ? "HOLDS" : "FAILS",
      facts.refused === null ? "the suite was not refused before its start marker" : "the suite refused before its start marker, naming the halt",
    ),
    claim(
      "nothing-started",
      "no start marker is written, no host starts and no request is sent",
      !facts.startMarker && facts.hosts.starts === 0 && requests === 0 && facts.calls.length === 0 ? "HOLDS" : "FAILS",
      `start marker ${facts.startMarker ? "present" : "absent"}; ${plural(facts.hosts.starts, "host start")}; ${plural(facts.calls.length, "`runTurn` call")}; ${plural(requests, "model request")}`,
    ),
  ]
}

export function integrityInjectedClaims(facts: ScenarioFacts): Claim[] {
  const requests = modelRequests(facts)
  const line = facts.issued[0]
  const label = "INJECTED by the probe, through the late-usage reporter the lifecycle handed the backend; never a spontaneous host failure"
  if (facts.injected === null || !facts.injected.reported) {
    const why = `the two synthetic reports were not made: ${facts.injected?.why ?? facts.refused ?? blocker(facts) ?? "no attempt reached the backend"}`
    return [claim("conflict-recorded", `two unequal late payloads for one execution id are recorded as an integrity failure (${label})`, "FAILS", why), ...hostStopClaims(facts)]
  }
  // The retry belongs to the run whose attempt carried the conflict: a refusal for any other run says nothing about it.
  const run = line?.position ?? requests[0]?.position ?? null
  const halted = run === null ? 0 : facts.refusals.filter((refusal) => refusal.cause === "halted" && refusal.position === run).length
  return [
    claim(
      "one-attempt-reaches-stub",
      "one newly issued attempt reaches the stub, which answers HTTP 400, a real model error",
      facts.issued.length === 1 && requests.length === 1 && requests[0]!.served === "http-400" ? "HOLDS" : "FAILS",
      `${plural(facts.issued.length, "issued line")}; ${plural(requests.length, "model request")}${requests[0] === undefined ? "" : `, served \`${requests[0].served}\``}`,
    ),
    claim(
      "unknown-binds-id",
      "the attempt settles `unknown` with an execution id and without `abandoned`",
      line !== undefined && line.kind === "unknown" && line.executionId && !line.abandoned ? "HOLDS" : "FAILS",
      line === undefined ? "no issued line" : `settled \`${line.kind ?? "nothing"}\`; execution id ${line.executionId ? "present" : "absent"}; abandoned: ${line.abandoned}`,
    ),
    claim(
      "conflict-recorded",
      `two unequal late payloads for one execution id are recorded as an integrity failure (${label})`,
      facts.integrity.some((failure) => failure.payloads === 2) ? "HOLDS" : "FAILS",
      facts.integrity.length === 0 ? "the bill records no integrity failure" : `${plural(facts.integrity.length, "integrity failure")}; payloads kept: ${facts.integrity.map((failure) => failure.payloads).join(", ")}`,
    ),
    haltClaim(facts),
    facts.calls.length !== 1 || requests.length !== 1
      ? claim("retry-refused", "MAD's retry of the failed attempt is refused `halted` before any backend entry", "FAILS", `${plural(facts.calls.length, "`runTurn` call")} and ${plural(requests.length, "model request")}: something entered the backend after the conflict`)
      : halted === 0
        ? claim(
            "retry-refused",
            "MAD's retry of the failed attempt is refused `halted` before any backend entry",
            "UNPROBED",
            `no second backend entry or request was observed (1 \`runTurn\` call, 1 model request), but no admission of ${run === null ? "the run" : `run ${run}`} was recorded refused \`halted\`` +
              `${facts.refusals.length === 0 ? "" : ` (${plural(facts.refusals.length, "refusal")} recorded for other runs or causes)`}, so a retry that was attempted and refused is not established`,
          )
        : claim(
            "retry-refused",
            "MAD's retry of the failed attempt is refused `halted` before any backend entry",
            "HOLDS",
            `${plural(halted, "admission")} of run ${run} refused \`halted\`, with 1 \`runTurn\` call and 1 model request in all`,
          ),
    ...hostStopClaims(facts),
    nothingLater(facts, 1),
  ]
}

const normalized = (name: string) => name.toLowerCase().replace(/^mcp_/, "")

/**
 * The offer, request by request. Every request that is a prompt must offer
 * exactly `StructuredOutput`. A request that offers no tool at all is a host
 * side request only when it carries no tool result and another request of the
 * same `runTurn` call carries the offer; it is then counted apart and is
 * outside the claim. Any other empty or wider offer fails, named by its index.
 */
export function offeredNamesClaim(facts: ScenarioFacts, startedAt = 0, none = "no model request reached the stub"): Claim {
  const text = "every prompt request offers the model exactly `StructuredOutput`"
  const all = facts.requests.filter((request) => request.model)
  if (all.length === 0) return claim("offered-names", text, "UNPROBED", none)
  const exact = (request: RequestFact) => request.offered.length === 1 && normalized(request.offered[0]!) === "structuredoutput"
  const perCall = requestsPerCall(facts, startedAt, true)
  const failures: string[] = []
  let side = 0
  for (const request of all) {
    if (exact(request)) continue
    if (request.offered.length > 0) failures.push(`request ${request.index} offered ${request.offered.map(normalized).sort().join(", ")}`)
    else if (request.stage !== "side" || request.toolResult !== null) failures.push(`request ${request.index} is a prompt that offered no tool`)
    else if (!(perCall.find((requests) => requests.some((entry) => entry.index === request.index)) ?? []).some(exact)) {
      failures.push(`request ${request.index} offered no tool, and no request of its call carried the offer`)
    } else side += 1
  }
  const scope = side === 0 ? "" : `; ${plural(side, "host-side request")} offered no tool, beside a prompt of the same call that did, and ${side === 1 ? "is" : "are"} outside this claim`
  return failures.length === 0
    ? claim("offered-names", text, "HOLDS", `each of ${plural(all.length - side, "prompt request")} offered exactly structuredoutput (normalized)${scope}`)
    : claim("offered-names", text, "FAILS", `${failures.join("; ")}${scope}`)
}

export function hostOfferClaims(facts: ScenarioFacts, startedAt = 0): Claim[] {
  const requests = modelRequests(facts)
  const tried = requests.find((request) => request.served === "unoffered-tool")
  const continuation = tried === undefined ? undefined : requests.find((request) => request.index > tried.index && request.position === tried.position && request.toolResult !== null)
  const result = continuation?.toolResult ?? null
  const call = tried === undefined ? undefined : facts.calls.find((entry) => entry.position === tried.position)
  const none = tried === undefined ? `the stub served no unoffered tool call: ${facts.refused ?? blocker(facts) ?? "no model request reached it"}` : "the host sent no request carrying a tool result after the call, so there is nothing to inspect"
  const treatment =
    result === null
      ? "no continuation"
      : result.isError && result.namesUnavailableTool
        ? "rejection: an error result that names an unavailable tool"
        : result.namesUnavailableTool
          ? "rejection: a result that names an unavailable tool, with no error flag in this format"
          : result.isError
            ? "error result"
            : "a result with no error flag and no rejection wording"
  return [
    offeredNamesClaim(facts, startedAt, none),
    claim(
      "treatment",
      "the host's treatment of a call to a tool it did not offer is recorded",
      result === null ? "UNPROBED" : "HOLDS",
      result === null ? none : `the stub called the tool the host names \`${facts.unofferedTool ?? "unknown"}\`; observed treatment: ${treatment}`,
    ),
    result === null
      ? claim("canary-nondisclosure", "the continuation the stub inspected carries no canary token", "UNPROBED", none)
      : claim(
          "canary-nondisclosure",
          "the continuation the stub inspected carries no canary token",
          result.canary ? "FAILS" : "HOLDS",
          result.canary ? "the canary token is in the tool result: a forbidden read result reached the provider" : "no canary token in the one continuation inspected; this is the narrow nondisclosure observation only",
        ),
    result === null
      ? claim("not-executed", "the unoffered tool was not executed", "UNPROBED", none)
      : result.canary
        ? claim("not-executed", "the unoffered tool was not executed", "FAILS", "the canary token came back, so the read ran")
        : result.namesUnavailableTool
          ? claim("not-executed", "the unoffered tool was not executed", "HOLDS", `the host rejected the call explicitly (${treatment})`)
          : claim("not-executed", "the unoffered tool was not executed", "UNPROBED", `no adequate execution witness: ${treatment}`),
    tried === undefined
      ? claim("structured-output-usable", "`StructuredOutput` then completes the turn", "UNPROBED", none)
      : claim(
          "structured-output-usable",
          "`StructuredOutput` then completes the turn",
          call?.disposition === "ok" ? "HOLDS" : "FAILS",
          `the attempt that carried the call ended \`${call?.disposition ?? "unobserved"}\`${call?.failure ? ` (${call.failure})` : ""}`,
        ),
    ...hostStopClaims(facts),
  ]
}

/** What the stream-without-usage row saw, as statements with no verdict. */
export function noUsageObservations(facts: ScenarioFacts, startedAt = 0): string[] {
  const requests = modelRequests(facts)
  const call = facts.calls[0]
  const line = facts.issued[0]
  const [stopClaim, postClaim] = hostStopClaims(facts)
  const most = Math.max(0, ...requestsPerCall(facts, startedAt).map((entries) => entries.length))
  return [
    `${plural(facts.issued.length, "attempt")} issued by the scenario; ${plural(facts.calls.length, "`runTurn` call")}; ${plural(requests.length, "model request")} reached the stub, each served \`no-usage\``,
    `at most ${plural(most, "model request")} arrived inside one \`runTurn\` call's window`,
    `calls by how they ended: ${Object.entries(tally(facts.calls.map((entry) => entry.disposition))).map(([name, count]) => `${count} ${name}`).join(", ") || "none"}; ` +
      `settlements: ${Object.entries(tally(facts.issued.map((entry) => (entry.kind === null ? "unsettled" : entry.abandoned ? "unknown (abandoned)" : entry.kind)))).map(([name, count]) => `${count} ${name}`).join(", ") || "none"}`,
    call === undefined
      ? "no `runTurn` call was observed"
      : `the first call ended \`${call.disposition}\`${call.failure ? ` (${call.failure})` : ""} after ${call.endedAt === null ? "an unknown number of" : call.endedAt - call.startedAt} ms against a ${facts.turnTimeoutMs} ms turn deadline`,
    line === undefined ? "no issued line" : `its attempt settled \`${line.kind ?? "nothing"}\`${line.abandoned ? ", abandoned" : ""}`,
    `halt: ${facts.halt ?? "none"}; stop: ${facts.stop ?? "none"}`,
    `host stop: ${stopClaim!.verdict} (${stopClaim!.why}); post-stop: ${postClaim!.verdict} (${postClaim!.why})`,
    most > 1
      ? "The requests beyond a call's first are an observed re-send pattern inside one admitted attempt. Repetition alone does not establish a host retry, " +
        "and this is not workload or quota evidence."
      : "No call's window held a second request: this transport showed no re-send for a stream without usage. This is not workload or quota evidence.",
  ]
}

export function claimsFor(facts: ScenarioFacts, pin: string, startedAt = 0): Claim[] {
  switch (facts.kind) {
    case "healthy":
      return healthyClaims(facts, pin, startedAt)
    case "run-allowance":
      return runAllowanceClaims(facts)
    case "root-allowance":
      return rootAllowanceClaims(facts)
    case "non-ending":
      return nonEndingClaims(facts)
    case "cancel-in-flight":
      return cancelClaims(facts)
    case "integrity-before-start":
      return integrityBeforeStartClaims(facts)
    case "integrity-injected":
      return integrityInjectedClaims(facts)
    case "host-offer":
      return hostOfferClaims(facts, startedAt)
    case "stream-without-usage":
      return []
  }
}

/** The suite allowance's row: never run, because a valid journal cannot reach it apart from the root's. */
export const SUITE_ALLOWANCE_CLAIM: Claim = claim(
  "suite-cap-stop",
  "a refusal on the suite's allowance is a runner stop that names it",
  "UNPROBED",
  "unreachable on a real host: the gate tests the root's 480 before the suite's 480 (ablation/governor.ts, `adversarialAttemptGate`), and the suite's root holds " +
    "nothing but the suite, so the two are the same count on any valid journal. Scripted evidence, at the gate with an artificial unequal view: " +
    "ablation/governor.test.ts, the `suite` case of the adversarial attempt gate's allowance test",
)

// ---------------------------------------------------------------------------
// The shipped command
// ---------------------------------------------------------------------------

export interface ShippedRun {
  exitCode: number | null
  output: string
  timedOut: boolean
}

/** What the shipped command must name when it refuses at stage 1. */
export const SHIPPED_BARRIERS: readonly { name: string; text: string }[] = [
  { name: "stage 1", text: "REFUSED at stage 1" },
  { name: "gate 10", text: "gate 10 (adversarial spend authorization) is OPEN" },
  { name: "gate 11", text: "gate 11 (adversarial attempt accounting) is OPEN" },
  { name: "the null pin", text: "`ADVERSARIAL_RUN.pins` is null" },
  { name: "the unfrozen protocol v3", text: "protocol v3 is not frozen" },
]

export function shippedClaims(run: ShippedRun, leftovers: readonly string[], evidenceChanged: boolean): Claim[] {
  const missing = SHIPPED_BARRIERS.filter((barrier) => !run.output.includes(barrier.text)).map((barrier) => barrier.name)
  return [
    claim(
      "shipped-refuses",
      "`bun run adversarial --live --provider-mode oauth`, with valid flags and paths and no override, exits 1 at stage 1 naming gate 10, gate 11, the null pin and the unfrozen protocol v3",
      !run.timedOut && run.exitCode === 1 && missing.length === 0 ? "HOLDS" : "FAILS",
      run.timedOut
        ? `the command did not end within ${SHIPPED_COMMAND_MS} ms`
        : `exit ${run.exitCode}; ${missing.length === 0 ? "every barrier is named" : `not named: ${missing.join(", ")}`}`,
    ),
    claim(
      "shipped-writes-nothing",
      "the refused command leaves nothing under its --out, its data root or ablation/evidence",
      leftovers.length === 0 && !evidenceChanged ? "HOLDS" : "FAILS",
      leftovers.length === 0 && !evidenceChanged ? "neither root exists and the evidence directory's listing is unchanged" : `${leftovers.join("; ") || "nothing left in the roots"}${evidenceChanged ? "; the evidence directory's listing changed" : ""}`,
    ),
  ]
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

export interface Stoppable {
  stop(): unknown
}

export interface ProbeArgs {
  out: string
  prepared: string
}

/** Test seams. Every default is the real thing. */
export interface ProbeSeams {
  platform?: string
  selfTest?: () => Promise<SelfTest>
  verifyPrepared?: (prepared: string) => Promise<{ ok: boolean; problems?: string[] }>
  startHost?: (options: ManagedHostOptions) => Promise<ManagedHostStart>
  spawn?: SpawnHost
  createBackend?: (options: OpencodeBackendOptions) => ModelBackend
  createClient?: (init: { baseUrl: string; directory: string }) => unknown
  enumerate?: (client: unknown) => Promise<Candidate[]>
  shipped?: (argv: readonly string[]) => Promise<ShippedRun>
  codeRevision?: () => Promise<Maybe<CodeRevision>>
  clock?: Clock
  transports?: readonly Transport[]
  scenarios?: readonly ScenarioSpec[]
  scenarioMs?: number
  probeMs?: number
  hangTurnMs?: number
  noUsageTurnMs?: number
  hostStartMs?: number
  teardownMs?: number
  /** Test-only: the suite stage, for a stage that fails in a way the real one does not. */
  suiteStage?: typeof runSuiteStage
  repoRoot?: string
}

export interface ProbeContext {
  out: string
  prepared: string
  scratch: string
  home: string
  protocol: ProtocolFixture
  proxy: RefusingProxy
  signal: AbortSignal
  /** Every host this probe started, and the one stop it owns for each. */
  owner: HostOwner
  seams: ProbeSeams
  clock: Clock
  codeRevision: Maybe<CodeRevision>
  identity: { binary: string; sha256: string; version: string } | null
  scenarioMs: number
}

export interface ProtocolFixture {
  file: string
  /** sha256 of the repository's draft, as read. */
  draftSha256: string
  /** The fixture's own `frozen_hash`. */
  fixtureHash: string
}

/**
 * A private copy of protocol v3 stamped frozen by the file's own hash rule, in
 * `directory`. A fixture: it pre-registers nothing and is no freeze. The source
 * file is read and never written.
 */
export async function frozenProtocolFixture(directory: string, source: string = PROTOCOL_V3_FILE): Promise<ProtocolFixture> {
  const draft = await readFile(source, "utf8")
  let pending = draft
  for (const [field, pattern, value] of [
    ["status", /^status: .*$/m, "status: frozen"],
    ["frozen_on", /^frozen_on: .*$/m, "frozen_on: 2026-10-12"],
    ["frozen_hash", /^frozen_hash: .*$/gm, "frozen_hash: PENDING"],
  ] as const) {
    if ((pending.match(pattern) ?? []).length !== 1) throw new Error(`protocol v3 carries no single \`${field}:\` line to rewrite`)
    pending = pending.replace(pattern, value)
  }
  const fixtureHash = sha256(pending)
  const file = join(directory, "evaluation-protocol-v3.fixture.md")
  await writeFile(file, pending.replace("frozen_hash: PENDING", `frozen_hash: ${fixtureHash}`), "utf8")
  return { file, draftSha256: createHash("sha256").update(draft).digest("hex"), fixtureHash }
}

const slug = (name: string) => name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Settled attempts an earlier part of the suite would have left in its own journal. */
export function seededAttempts(runs: number, perRun: number): string {
  let text = ""
  for (let run = 1; run <= runs; run += 1) {
    for (let index = 0; index < perRun; index += 1) {
      const physicalId = `probe-seed-${run}-${index}`
      const issued = { type: "issued", physicalId, category: "adversarial", block: null, phase: null, stage: "discover", slot: "discovery-1", attempt: 1, runId: `probe-seed-run-${run}`, mode: "attempts", scope: "adversarial" }
      const settled = { type: "settled", physicalId, settlement: { kind: "usage", tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } } }
      text += `${JSON.stringify(issued)}\n${JSON.stringify(settled)}\n`
    }
  }
  return text
}

/** One issued line that was never settled. */
export function danglingAttempt(): string {
  const issued = { type: "issued", physicalId: "probe-seed-open", category: "adversarial", block: null, phase: null, stage: "discover", slot: "discovery-1", attempt: 1, runId: "probe-seed-run-open", mode: "attempts", scope: "adversarial" }
  return `${JSON.stringify(issued)}\n`
}

/** The finding the case's labelled change carries, as a discovery answer would report it. */
export function targetFinding(caseId: string): Record<string, unknown> {
  const assertion = ADVERSARIAL_ASSERTIONS.find((entry) => entry.caseId === caseId)
  if (assertion === undefined) return { claim: "A defect in the change.", reasoning: "Read from the added lines.", severity: "high", file: "src/a.ts", startLine: 1, endLine: 1 }
  return {
    claim: `${assertion.target.markers[0]}: ${assertion.target.summary}`,
    reasoning: "Read from the added lines of the change.",
    severity: "high",
    file: assertion.target.locus.file,
    startLine: assertion.target.locus.startLine,
    endLine: assertion.target.locus.endLine,
  }
}

/** 31 distinct findings: one discovery turn and one judge turn each ask for 32 attempts. */
export function manyFindings(caseId: string): { findings: Record<string, unknown>[] } {
  return {
    findings: Array.from({ length: ADVERSARIAL_ATTEMPT_ALLOWANCES.run + 1 }, (_unused, index) => ({
      ...targetFinding(caseId),
      claim: `Distinct defect number ${index} in module ${index}`,
      file: `src/module-${index}.ts`,
      startLine: 10 + index * 50,
      endLine: 12 + index * 50,
    })),
  }
}

/** The journal file's unsettled issued lines at one instant: how many, and which one when there is exactly one. */
export interface UnsettledSnapshot {
  count: number
  id: string | null
  runId: string | null
}

async function unsettledIn(root: string): Promise<UnsettledSnapshot | null> {
  try {
    const { lines } = await journalLines(root)
    const settled = new Set(lines.filter((line): line is SettledLine => line.type === "settled").map((line) => line.physicalId))
    const open = lines.filter((line): line is IssuedLine => line.type === "issued" && !settled.has(line.physicalId))
    return { count: open.length, id: open.length === 1 ? open[0]!.physicalId : null, runId: open.length === 1 ? open[0]!.runId : null }
  } catch {
    return null
  }
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  )
}

/** The host record's lines, and how many of them did not parse. */
async function hostRecordsIn(file: string): Promise<{ records: HostRecord[]; unreadable: number }> {
  const text = await readFile(file, "utf8").catch(() => "")
  const records: HostRecord[] = []
  let unreadable = 0
  for (const line of text.split("\n").filter((entry) => entry.length > 0)) {
    try {
      records.push(JSON.parse(line) as HostRecord)
    } catch {
      unreadable += 1
    }
  }
  return { records, unreadable }
}

export interface ScenarioRecord {
  kind: ScenarioKind
  name: string
  what: string
  claims: Claim[]
  observations: string[]
  records: {
    issuedAttempts: { seeded: number; seededUnsettled: number; newlyIssued: number; bySettlement: Record<string, number>; counted: number }
    refusals: Record<string, number>
    runTurnCalls: { total: number; byDisposition: Record<string, number> }
    stubRequests: { total: number; model: number; side: number; other: number; byServed: Record<string, number>; paths: string[]; authHeaderPresent: number }
    extraRequests: ExtraRequest[]
    attributionLimit: string
  }
  hosts: { starts: number; events: Record<string, { ok: number; failed: number }>; failures: string[]; unestablished: string[]; recordFailure: string | null }
  slots: Record<string, number>
  firstSlots: { position: number; status: string; reason: string }[]
  suite: { refused: string | null; complete: boolean; halt: string | null; stop: string | null; haltMarker: boolean; startMarker: boolean; overshoot: ScenarioFacts["overshoot"] }
  bounds: { scenarioMs: number; turnTimeoutMs: number | null }
  deadline: string | null
  egressRefused: string[]
  elapsedMs: number
}

const tally = (values: readonly string[]): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}

export function scenarioRecord(spec: ScenarioSpec, facts: ScenarioFacts, pin: string, startedAt: number, scenarioMs: number): ScenarioRecord {
  const events: Record<string, { ok: number; failed: number }> = {}
  for (const record of facts.hosts.records) {
    const entry = (events[record.event] ??= { ok: 0, failed: 0 })
    if (record.ok) entry.ok += 1
    else entry.failed += 1
  }
  const counted = facts.issued.filter((line) => line.kind !== "not-issued").length
  return {
    kind: spec.kind,
    name: spec.name,
    what: spec.what,
    claims: claimsFor(facts, pin, startedAt),
    observations: spec.kind === "stream-without-usage" ? noUsageObservations(facts, startedAt) : [],
    records: {
      issuedAttempts: {
        seeded: facts.seeded.issued,
        seededUnsettled: facts.seeded.unsettled,
        newlyIssued: facts.issued.length,
        bySettlement: tally(facts.issued.map((line) => (line.kind === null ? "unsettled" : line.abandoned ? "unknown (abandoned)" : line.kind))),
        counted,
      },
      refusals: tally(facts.refusals.map((refusal) => refusal.cause)),
      runTurnCalls: { total: facts.calls.length, byDisposition: tally(facts.calls.map((call) => call.disposition)) },
      stubRequests: {
        total: facts.requests.length,
        model: modelRequests(facts).length,
        side: facts.requests.filter((request) => request.stage === "side").length,
        other: facts.requests.filter((request) => !request.model).length,
        byServed: tally(facts.requests.map((request) => request.served)),
        paths: [...new Set(facts.requests.map((request) => `${request.method} ${request.path}`))].sort(),
        authHeaderPresent: facts.requests.filter((request) => request.authHeaderPresent).length,
      },
      extraRequests: extraRequests(facts, startedAt),
      attributionLimit:
        "a stub request is attributed to the `runTurn` call whose window it arrived in (entry to return, plus " +
        `${ATTRIBUTION_SLACK_MS} ms). That is evidence with limits: it does not prove which attempt a request belongs to, nor why the host sent it`,
    },
    hosts: {
      starts: facts.hosts.starts,
      events,
      failures: facts.hosts.records.filter((record) => !record.ok).map((record) => `run ${record.position} ${record.event}: ${record.detail}`),
      unestablished: facts.hosts.unestablished,
      recordFailure: facts.hosts.recordFailure,
    },
    slots: tally(facts.slots.map((slot) => slot.status)),
    firstSlots: facts.slots.slice(0, 2),
    suite: { refused: facts.refused, complete: facts.complete, halt: facts.halt, stop: facts.stop, haltMarker: facts.haltMarker, startMarker: facts.startMarker, overshoot: facts.overshoot },
    bounds: { scenarioMs, turnTimeoutMs: facts.turnTimeoutMs },
    deadline: facts.deadline,
    egressRefused: facts.egress,
    elapsedMs: facts.elapsedMs,
  }
}

const egressTargets = (lines: readonly { line: string }[]): string[] => [...new Set(lines.map((entry) => entry.line.split(" ")[1] ?? entry.line))].sort()

/** Two unequal synthetic token payloads for the injected conflict. */
export const SYNTHETIC_LATE_PAYLOADS = [
  { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  { input: 6, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
] as const

/** One process the probe started, and the one stop it owns for it. */
export interface OwnedHost {
  /** The data directory the host was started on: one per host. */
  key: string
  pid: number
  /** How the stop ended, once it has. */
  outcome: StopOutcome | null
  /** Memoized, bounded, and never rejecting: every caller gets the same stop. */
  stop(): Promise<StopOutcome>
}

/**
 * Every host the probe started, each with one stop that every caller shares:
 * the lifecycle's, the probe's own cleanup and a late start's.
 *
 * A stop is bounded by `teardownMs`. One that rejects, passes its bound or is
 * not confirmed is kept as its outcome, never dropped. `settle()` stops whatever
 * is still running, waits for every start that outlived its bound, and returns
 * why another host must not be started: a host whose termination is not
 * confirmed, or a start that has not returned.
 */
export class HostOwner {
  readonly hosts: OwnedHost[] = []
  private readonly raw = new Map<string, () => Promise<StopOutcome>>()
  private readonly late = new Map<string, { done: boolean; settled: Promise<void> }>()
  private readonly rejected: string[] = []

  constructor(private readonly teardownMs: number = TEARDOWN_MS) {}

  /**
   * Takes ownership of a process. A second handle for the same host (the spawn
   * handle, then the started host) replaces the stop that will be called, so the
   * stop used is the fullest one known when it is first asked for.
   */
  own(key: string, pid: number, stop: () => Promise<StopOutcome>): OwnedHost {
    this.raw.set(key, stop)
    const known = this.hosts.find((host) => host.key === key)
    if (known !== undefined) return known
    let stopping: Promise<StopOutcome> | undefined
    const host: OwnedHost = {
      key,
      pid,
      outcome: null,
      stop: () =>
        (stopping ??= this.bounded(pid, this.raw.get(key)!).then((outcome) => {
          host.outcome = outcome
          return outcome
        })),
    }
    this.hosts.push(host)
    return host
  }

  /** Records the stop `startManagedHost` already made of what a refused start had spawned. */
  record(key: string, outcome: StopOutcome): void {
    const known = this.hosts.find((host) => host.key === key)
    if (known === undefined) this.hosts.push({ key, pid: outcome.pid, outcome, stop: async () => outcome })
    else known.outcome ??= outcome
  }

  /** Keeps a start that outlived its bound: whatever it returns is owned and stopped, and its failure is kept. */
  trackLate(key: string, starting: Promise<ManagedHostStart>): void {
    const entry = { done: false, settled: Promise.resolve() }
    entry.settled = starting
      .then(
        async (late) => {
          if (late.ok) await this.own(key, late.host.pid, late.host.stop).stop()
          else if (late.stopped !== null) this.record(key, late.stopped)
        },
        (error: unknown) => {
          this.rejected.push(`the start on \`${key}\` outlived its bound and then rejected (${messageOf(error)}), so whether it left a process running is not established`)
        },
      )
      .then(() => {
        entry.done = true
      })
    this.late.set(key, entry)
  }

  /** Stops every owned host that has no outcome, waits out late starts, and returns why another host must not start. */
  async settle(): Promise<string[]> {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.all([...this.late.values()].map((entry) => entry.settled)),
      new Promise((done) => {
        timer = setTimeout(done, this.teardownMs)
      }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    for (const host of [...this.hosts]) if (host.outcome === null) await host.stop()
    return this.unresolved()
  }

  /** Why another host must not be started, as things stand. */
  unresolved(): string[] {
    return [
      ...this.hosts
        .filter((host) => host.outcome !== null && !host.outcome.confirmed)
        .map((host) => `the stop of process ${host.pid} (\`${host.key}\`) is UNCONFIRMED — check it by hand: ${host.outcome!.confirmed ? "" : host.outcome!.why}`),
      ...this.hosts.filter((host) => host.outcome === null).map((host) => `process ${host.pid} (\`${host.key}\`) was started and has not been stopped`),
      ...[...this.late].filter(([, entry]) => !entry.done).map(([key]) => `the start on \`${key}\` outlived its bound and has not returned, so whether it left a process running is not established`),
      ...this.rejected,
    ]
  }

  private async bounded(pid: number, stop: () => Promise<StopOutcome>): Promise<StopOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        (async () => stop())().catch((error: unknown): StopOutcome => ({ confirmed: false, pid, why: `the stop rejected: ${messageOf(error)}` })),
        new Promise<StopOutcome>((done) => {
          timer = setTimeout(() => done({ confirmed: false, pid, why: `the stop gave no answer within ${this.teardownMs} ms` }), this.teardownMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

/**
 * `startManagedHost` under the host-start bound, with every process it reports
 * owned by `context.owner`. The caller's `onSpawn` and the returned host both
 * get the owner's one stop for that process.
 *
 * A start that outlives the bound is refused and stays owned: the owner stops
 * whatever it returns, keeps that stop's outcome, and reports the start as
 * unresolved until it has returned.
 */
export async function boundedStart(context: ProbeContext, what: string, options: ManagedHostOptions): Promise<ManagedHostStart> {
  if (options.mode !== "oauth") return { ok: false, reason: "the probe starts OAuth-mode hosts only", stopped: null }
  const key = options.oauth.dataDir
  const starting = (async () =>
    (context.seams.startHost ?? startManagedHost)({
      ...options,
      onSpawn: (handle) => {
        const owned = context.owner.own(key, handle.pid, handle.stop)
        options.onSpawn?.({ pid: handle.pid, stop: owned.stop })
      },
    }))()
  const ms = context.seams.hostStartMs ?? HOST_START_MS
  let started: ManagedHostStart
  try {
    started = await within(ms, what, () => starting)
  } catch (error) {
    context.owner.trackLate(key, starting)
    return { ok: false, reason: `${messageOf(error)}; the start stays owned, and no further host starts until it has returned and what it left is stopped`, stopped: null }
  }
  if (!started.ok) {
    if (started.stopped !== null) context.owner.record(key, started.stopped)
    return started
  }
  const owned = context.owner.own(key, started.host.pid, started.host.stop)
  return { ok: true, host: { ...started.host, stop: owned.stop } }
}

/** Runs one scenario on one transport, in roots of its own, and returns what it observed. */
export async function runScenario(context: ProbeContext, transport: Transport, stub: AdversarialStub, spec: ScenarioSpec): Promise<{ facts: ScenarioFacts; startedAt: number }> {
  const pin: Pin = { providerId: transport.providerId, modelId: transport.modelId }
  const base = join(context.out, slug(transport.providerId), slug(spec.name))
  const root = join(base, "root")
  const dataRoot = join(base, "data")
  const hostScratch = join(base, "host")
  await mkdir(root, { recursive: true, mode: 0o700 })
  await mkdir(dataRoot, { recursive: true, mode: 0o700 })
  await mkdir(hostScratch, { recursive: true, mode: 0o700 })
  const journalFile = join(root, JOURNAL_FILE)
  const startedAt = Date.now()
  const proxyBefore = context.proxy.attempts().length
  const controller = new AbortController()
  let deadline: string | null = null
  const onProbeAbort = () => {
    deadline ??= "the probe's own deadline or an interrupt ended this scenario"
    controller.abort()
  }
  if (context.signal.aborted) onProbeAbort()
  else context.signal.addEventListener("abort", onProbeAbort, { once: true })
  const timer = setTimeout(() => {
    deadline ??= `the scenario did not end within its ${context.scenarioMs} ms bound`
    controller.abort()
  }, context.scenarioMs)

  const turnTimeoutMs =
    spec.kind === "non-ending" || spec.kind === "cancel-in-flight"
      ? (context.seams.hangTurnMs ?? HANG_TURN_MS)
      : spec.kind === "stream-without-usage"
        ? (context.seams.noUsageTurnMs ?? NO_USAGE_TURN_MS)
        : null
  const calls: CallFact[] = []
  let open = 0
  let maxConcurrentCalls = 0
  let cancelled = false
  let injected: ScenarioFacts["injected"] = spec.kind === "integrity-injected" ? { reported: false, why: "no envelope with an execution id and without `abandoned` came back from the backend" } : null
  const arrivals = new Map<number, UnsettledSnapshot | null>()
  const canary = `MAD-CANARY-${randomBytes(12).toString("hex")}`
  const script: AdversarialStubScript = {
    discovery: (run) => (spec.kind === "run-allowance" && run?.position === 1 ? manyFindings(run.caseId) : { findings: run === null ? [] : [targetFinding(run.caseId)] }),
    serve: (turn) => {
      if (spec.kind === "non-ending" || spec.kind === "cancel-in-flight") return "hang"
      if (spec.kind === "stream-without-usage") return "no-usage"
      if (spec.kind === "integrity-injected" && turn.index === 1) return "http-400"
      if (spec.kind === "host-offer" && turn.run?.position === 1 && turn.runIndex === 1 && !turn.hasToolResult) return "unoffered-tool"
      return "answer"
    },
  }
  stub.reset(script)
  stub.setCanary(spec.kind === "host-offer" ? canary : null)
  stub.onRequest(async (request) => {
    arrivals.set(request.index, await unsettledIn(root))
    if (spec.kind === "cancel-in-flight" && !cancelled) {
      cancelled = true
      controller.abort()
    }
  })

  let schedule: AdversarialSchedule | undefined
  const startHost = async (options: ManagedHostOptions): Promise<ManagedHostStart> => {
    if (options.mode !== "oauth") return { ok: false, reason: "the probe starts OAuth-mode hosts only", stopped: null }
    const unresolved = context.owner.unresolved()
    if (unresolved.length > 0) return { ok: false, reason: `no further host starts while an earlier one is unresolved: ${unresolved.join("; ")}`, stopped: null }
    const started = await boundedStart(context, "the managed host's start", {
      ...options,
      oauth: { ...options.oauth, baseURLs: { [transport.providerId]: stub.baseURL } },
      spawn: context.seams.spawn ?? sandboxSpawn,
      proxy: context.proxy.url,
      scratchParent: hostScratch,
    })
    if (started.ok) context.identity ??= { binary: started.host.binary, sha256: started.host.sha256, version: started.host.version }
    return started
  }
  const createBackend = (options: OpencodeBackendOptions): ModelBackend => {
    const position = Number(/^run-(\d+)\//.exec(options.executionIdPrefix ?? "")?.[1])
    const slot = schedule?.slots.find((entry) => entry.position === position)
    const run: StubRun | null = slot === undefined ? null : { position, caseId: slot.caseId, side: slot.side }
    stub.setRun(run)
    if (spec.kind === "host-offer" && position === 1) {
      // Written before the backend exists, so before any turn: the canary is the one file the scripted call reads.
      const file = join(options.directory, "probe-canary.txt")
      script.unofferedCall = { tool: transport.format === "messages" ? "mcp_Read" : "read", input: { filePath: file } }
      writeFileSync(file, `${canary}\n`, "utf8")
    }
    const inner = (context.seams.createBackend ?? ((given: OpencodeBackendOptions) => new OpencodeModelBackend(given)))({
      ...options,
      ...(turnTimeoutMs === null ? {} : { timeoutMs: turnTimeoutMs }),
    })
    return {
      capabilities: (slotId) => inner.capabilities(slotId),
      async runTurn(slotId, instructions, input, schema, signal, admitted) {
        const entry = await unsettledIn(root)
        const call: CallFact = {
          position: run?.position ?? null,
          startedAt: Date.now(),
          endedAt: null,
          unsettledAtEntry: entry?.count ?? null,
          entryId: entry?.id ?? null,
          entryRunId: entry?.runId ?? null,
          entryPosition: null,
          disposition: "open",
          failure: null,
          usageUnknown: false,
          abandoned: false,
        }
        calls.push(call)
        open += 1
        maxConcurrentCalls = Math.max(maxConcurrentCalls, open)
        try {
          const envelope = await inner.runTurn(slotId, instructions, input, schema, signal, admitted)
          call.disposition = envelope.ok ? "ok" : "failed"
          call.failure = envelope.ok ? null : envelope.failure
          call.usageUnknown = envelope.usageUnknown !== undefined
          call.abandoned = envelope.usageUnknown?.abandoned === true
          if (injected !== null && !injected.reported) {
            const unknown = envelope.usageUnknown
            if (unknown === undefined) injected = { reported: false, why: "the HTTP 400 envelope carried a token figure and no `usageUnknown`, so no execution id was bound" }
            else if (unknown.abandoned === true) injected = { reported: false, why: "the HTTP 400 envelope was `abandoned`, which halts by itself and cannot isolate the conflict" }
            else if (options.lateUsage === undefined) injected = { reported: false, why: "the lifecycle handed the backend no late-usage reporter" }
            else {
              // SYNTHETIC: two unequal payloads for the real envelope's execution id, reported before the stage settles it.
              for (const tokens of SYNTHETIC_LATE_PAYLOADS) options.lateUsage.report({ executionId: unknown.executionId, tokens: { ...tokens } })
              injected = { reported: true, why: "two unequal synthetic payloads were reported for the envelope's execution id before it returned to the stage" }
            }
          }
          return envelope
        } catch (error) {
          call.disposition = "threw"
          call.failure = "the backend threw"
          throw error
        } finally {
          call.endedAt = Date.now()
          open -= 1
        }
      },
    }
  }

  let refused: string | null = null
  let outcome: Awaited<ReturnType<typeof runSuiteStage>> | undefined
  let stopCurrent: (() => Promise<void>) | null = null
  let unsafe: string[] = []
  try {
    const resolved = adversarialRoster(pin)
    const wiring = productionTools({ worktree: join(adversarialDirectory(root), "worktrees") })
    const wiringProblem = toolsWiringProblem(wiring)
    if (wiring === undefined || wiringProblem !== null) throw new Error(`the production Tools port could not be built: ${wiringProblem}`)
    const config = adversarialSuiteConfig("scripted", wiring)
    const created = await createAdversarialSchedule({
      experimentRoot: root,
      protocolFile: context.protocol.file,
      codeRevision: context.codeRevision,
      roster: resolved.roster,
      config,
      createdAt: context.clock.now(),
    })
    if (!created.ok) refused = `the schedule could not be sealed: ${created.reason}`
    else {
      schedule = created.schedule
      if (spec.kind === "root-allowance") await writeFile(journalFile, seededAttempts(ADVERSARIAL_ATTEMPT_ALLOWANCES.runs, ADVERSARIAL_ATTEMPT_ALLOWANCES.run), "utf8")
      if (spec.kind === "integrity-before-start") await writeFile(journalFile, danglingAttempt(), "utf8")
      outcome = await (context.seams.suiteStage ?? runSuiteStage)({
        out: root,
        protocolFile: context.protocol.file,
        codeRevision: context.codeRevision,
        resolved,
        config,
        clock: context.clock,
        signal: controller.signal,
        ownStop: (stop) => {
          stopCurrent = stop
        },
        scheduleHash: created.schedule.scheduleHash,
        provider: transport.providerId,
        pin,
        prepared: context.prepared,
        dataRoot,
        home: context.home,
        payloadPins: OAUTH_PAYLOAD,
        requestMs: ROSTER_READ_MS,
        startHost,
        createBackend,
        ...(context.seams.createClient === undefined ? {} : { createClient: context.seams.createClient }),
        ...(context.seams.enumerate === undefined ? {} : { enumerate: context.seams.enumerate }),
      })
      if (!outcome.outcome.ok) refused = outcome.outcome.reason
    }
  } catch (error) {
    refused = `the scenario threw: ${messageOf(error)}`
    // The suite did not return, so nothing it would have stopped can be assumed stopped: the lifecycle's own
    // stop is asked for first (it waits for a start in flight), within the teardown bound.
    if (stopCurrent !== null) {
      let bound: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        (stopCurrent as () => Promise<void>)().catch(() => undefined),
        new Promise((done) => {
          bound = setTimeout(done, TEARDOWN_MS)
        }),
      ])
      if (bound !== undefined) clearTimeout(bound)
    }
  } finally {
    clearTimeout(timer)
    context.signal.removeEventListener("abort", onProbeAbort)
    stub.onRequest(null)
    stub.setRun(null)
    // Whatever this scenario started is stopped, and its outcome known, before the probe may start another host.
    unsafe = await context.owner.settle()
  }

  const suite = outcome?.outcome.ok ? outcome.outcome : undefined
  const { lines, problems } = await journalLines(root).catch((error: unknown) => ({ lines: [] as JournalLine[], problems: [messageOf(error)] }))
  const seededIds = new Set(lines.filter((line): line is IssuedLine => line.type === "issued" && line.physicalId.startsWith("probe-seed-")).map((line) => line.physicalId))
  const settledLines = lines.filter((line): line is SettledLine => line.type === "settled")
  const positionOf = new Map<string, number>()
  for (const slot of suite?.slots ?? []) if (slot.runId !== undefined) positionOf.set(slot.runId, slot.position)
  // The run a call's unsettled line belongs to, by the suite's own slot report: never by the call that observed it.
  for (const call of calls) call.entryPosition = call.entryRunId === null ? null : (positionOf.get(call.entryRunId) ?? null)
  // A refusal's run, by the slot report, or failing that by the one call that saw that run id unsettled.
  const refusalPosition = (runId: string | undefined): number | null =>
    runId === undefined ? null : (positionOf.get(runId) ?? calls.find((call) => call.entryRunId === runId)?.position ?? null)
  const issued: IssuedFact[] = lines
    .filter((line): line is IssuedLine => line.type === "issued" && !seededIds.has(line.physicalId))
    .map((line) => {
      const settlements = settledLines.filter((entry) => entry.physicalId === line.physicalId)
      const settlement = settlements[0]?.settlement
      return {
        physicalId: line.physicalId,
        position: positionOf.get(line.runId) ?? null,
        settlements: settlements.length,
        kind: settlement?.kind ?? null,
        abandoned: settlement?.kind === "unknown" && settlement.abandoned === true,
        executionId: settlement?.kind === "unknown" && settlement.executionId !== undefined,
      }
    })
  const recordFile = outcome?.recordFile ?? join(adversarialDirectory(root), ADVERSARIAL_HOSTS_FILE)
  const { records, unreadable } = await hostRecordsIn(recordFile)
  const facts: ScenarioFacts = {
    kind: spec.kind,
    refused,
    complete: suite?.complete ?? false,
    halt: suite?.bill.halt ?? null,
    stop: suite?.bill.stop ?? null,
    haltMarker: await exists(join(root, HALT_MARKER_FILE)),
    startMarker: await exists(join(adversarialDirectory(root), ADVERSARIAL_START_MARKER_FILE)),
    slots: (suite?.slots ?? []).map((slot) => ({ position: slot.position, status: slot.status, reason: slot.reason })),
    overshoot:
      suite === undefined
        ? null
        : { root: suite.overshoot.global.overshoot, suite: suite.overshoot.adversarial.overshoot, runs: (suite.overshoot.runTotals ?? []).map((row) => row.overshoot) },
    integrity: (suite?.bill.integrity ?? []).map((failure) => ({ reason: failure.reason, payloads: failure.payloads?.length ?? 0 })),
    refusals: (suite?.bill.refusedAdversarial ?? []).map((refusal) => ({ cause: refusal.cause, position: refusalPosition(refusal.runId) })),
    seeded: { issued: seededIds.size, unsettled: [...seededIds].filter((id) => !settledLines.some((entry) => entry.physicalId === id)).length },
    issued,
    journalProblems: problems,
    calls,
    maxConcurrentCalls,
    requests: stub.requests().map((request) => {
      const { at, closed, run, ...rest } = request
      const arrival = arrivals.get(request.index) ?? null
      return { ...rest, atMs: at - startedAt, position: run?.position ?? null, closedAfterMs: closed?.afterMs ?? null, unsettledAtArrival: arrival?.count ?? null, arrivalId: arrival?.id ?? null }
    }),
    hosts: {
      starts: outcome?.hosts.starts ?? 0,
      records: records.map((record) => ({ event: record.event, ok: record.ok, position: record.position, detail: record.detail })),
      unestablished: outcome?.hosts.unestablished ?? [],
      recordFailure: outcome?.hosts.recordFailure ?? (unreadable === 0 ? null : `${plural(unreadable, "line")} of the host record did not parse`),
    },
    injected,
    cancelled,
    unofferedTool: script.unofferedCall?.tool ?? null,
    unsafe,
    deadline,
    turnTimeoutMs,
    egress: egressTargets(context.proxy.attempts().slice(proxyBefore)),
    elapsedMs: Date.now() - startedAt,
  }
  return { facts, startedAt }
}

export interface CalibrationRecord {
  label: string
  transport: string
  route: string[]
  startMs: number | null
  stopMs: number | null
  turn: { disposition: string; failure: string | null; tokensReported: boolean; ms: number } | null
  stubRequests: number
  offered: string[]
  /** `postStopProblems` is `null` when no post-stop checks came back. */
  stop: { confirmed: boolean; postStopProblems: number | null } | null
  /** Why the calibration host's stop does not let a scenario start: unconfirmed, no post-stop checks, or a failed check. */
  stopProblem: string | null
  /** As `ScenarioFacts.unsafe`. */
  unsafe: string[]
  refused: string | null
  egressRefused: string[]
  bounds: { hostStartMs: number; turnMs: number }
}

/** One sandboxed host on a placeholder store, one turn on the sealed offer: measures startup under the outer bounds. */
export async function calibrate(context: ProbeContext, transport: Transport, stub: AdversarialStub): Promise<CalibrationRecord> {
  const base = join(context.out, "calibration")
  const work = join(base, "work")
  const dataDir = join(base, "data")
  await mkdir(work, { recursive: true, mode: 0o700 })
  await mkdir(join(base, "host"), { recursive: true, mode: 0o700 })
  await writeFile(join(work, "pay.ts"), "const fee = total * rate\n", "utf8")
  const { link, target } = authLinkPaths(dataDir, context.home)
  await mkdir(join(link, ".."), { recursive: true, mode: 0o700 })
  await symlink(target, link)
  const pin: Pin = { providerId: transport.providerId, modelId: transport.modelId }
  const proxyBefore = context.proxy.attempts().length
  stub.reset()
  const record: CalibrationRecord = {
    label: "CALIBRATION — one host outside the suite path; it measures startup and is no scenario",
    transport: `${transport.providerId}/${transport.modelId}`,
    route: [],
    startMs: null,
    stopMs: null,
    turn: null,
    stubRequests: 0,
    offered: [],
    stop: null,
    stopProblem: null,
    unsafe: [],
    refused: null,
    egressRefused: [],
    bounds: { hostStartMs: HOST_START_MS, turnMs: CALIBRATION_TURN_MS },
  }
  const began = Date.now()
  const started = await boundedStart(context, "the calibration host's start", {
    mode: "oauth",
    oauth: { providers: [pin.providerId], models: [pin], dataDir, prepared: context.prepared, home: context.home, pins: OAUTH_PAYLOAD, baseURLs: { [pin.providerId]: stub.baseURL } },
    verifyDirectories: [work],
    requestMs: ROSTER_READ_MS,
    signals: null,
    spawn: context.seams.spawn ?? sandboxSpawn,
    proxy: context.proxy.url,
    scratchParent: join(base, "host"),
  })
  if (!started.ok) {
    record.refused = started.reason
    record.unsafe = await context.owner.settle()
    return record
  }
  record.startMs = Date.now() - began
  context.identity ??= { binary: started.host.binary, sha256: started.host.sha256, version: started.host.version }
  try {
    const roster = adversarialRoster(pin).roster
    const backend = (context.seams.createBackend ?? ((given: OpencodeBackendOptions) => new OpencodeModelBackend(given)))({
      serverUrl: started.host.url,
      directory: work,
      slots: roster.slots,
      executionIdPrefix: "calibration/",
      tools: { ...ADVERSARIAL_HOST_OFFER },
      timeoutMs: CALIBRATION_TURN_MS,
    })
    const { z } = await import("zod")
    const turnBegan = Date.now()
    const envelope = await backend.runTurn(roster.slots[0]!.slot, "Review the change.", "diff", z.object({ findings: z.array(z.unknown()) }), context.signal)
    record.turn = { disposition: envelope.ok ? "ok" : "failed", failure: envelope.ok ? null : envelope.failure, tokensReported: envelope.tokens !== undefined, ms: Date.now() - turnBegan }
  } catch (error) {
    record.turn = { disposition: "threw", failure: messageOf(error), tokensReported: false, ms: 0 }
  } finally {
    const stopBegan = Date.now()
    // The owner's stop: bounded by the teardown bound, and never rejecting.
    const outcome = await started.host.stop()
    record.stopMs = Date.now() - stopBegan
    record.stop = { confirmed: outcome.confirmed, postStopProblems: outcome.confirmed && outcome.postStop !== undefined ? outcome.postStop.problems.length : null }
    record.stopProblem = !outcome.confirmed
      ? `its stop is UNCONFIRMED (${outcome.why})`
      : outcome.postStop === undefined
        ? "its stop returned no post-stop checks, so post-stop verification is missing"
        : outcome.postStop.problems.length > 0
          ? `a post-stop check failed: ${outcome.postStop.problems.join("; ")}`
          : null
    record.unsafe = await context.owner.settle()
  }
  const requests = stub.requests()
  record.stubRequests = requests.length
  record.route = [...new Set(requests.map((request) => `${request.method} ${request.path}`))].sort()
  record.offered = [...new Set(requests.flatMap((request) => request.offered))].sort()
  record.egressRefused = egressTargets(context.proxy.attempts().slice(proxyBefore))
  return record
}

/** A scenario's bound from a measured startup: sixteen starts and stops with room for their turns, never above the outer bound. */
export function scenarioBound(startMs: number | null, stopMs: number | null, outer: number = SCENARIO_MS): number {
  if (startMs === null || stopMs === null) return outer
  return Math.min(outer, ADVERSARIAL_ATTEMPT_ALLOWANCES.runs * (startMs + stopMs) * 3 + 300_000)
}

export function parseProbeArgs(argv: readonly string[]): { ok: true; args: ProbeArgs } | { ok: false; reason: string } {
  const args = argv.slice(2)
  const values: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    const name = arg.startsWith("--") ? arg.slice(2).split("=")[0]! : ""
    if (!["out", "oauth-prepared"].includes(name)) return { ok: false, reason: `unexpected argument \`${arg}\`. This command takes --out and --oauth-prepared only.` }
    if (name in values) return { ok: false, reason: `--${name} was given twice` }
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++index]
    if (value === undefined || value.trim() === "" || !isAbsolute(value)) return { ok: false, reason: `--${name} needs an absolute path` }
    values[name] = resolve(value)
  }
  if (values.out === undefined) return { ok: false, reason: "--out <absolute directory> is required" }
  if (values["oauth-prepared"] === undefined) return { ok: false, reason: "--oauth-prepared <absolute directory> is required (build it with `bun run oauth-prepare --out <dir>`)" }
  return { ok: true, args: { out: values.out, prepared: values["oauth-prepared"] } }
}

/** The real path of `path`, through its nearest existing ancestor when it does not exist yet. */
async function realOf(path: string): Promise<string> {
  let current = resolve(path)
  const tail: string[] = []
  for (;;) {
    try {
      return join(await realpath(current), ...tail)
    } catch {
      const parent = resolve(current, "..")
      if (parent === current) return resolve(path)
      tail.unshift(basename(current))
      current = parent
    }
  }
}

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)

/** Why `--out` and `--oauth-prepared` cannot be used: empty when they can. */
export async function pathProblems(args: ProbeArgs, repoRoot: string = REPO_ROOT): Promise<string[]> {
  const [out, prepared, repo] = await Promise.all([realOf(args.out), realOf(args.prepared), realOf(repoRoot)])
  const problems: string[] = []
  if (inside(out, repo) || inside(repo, out)) problems.push(`--out \`${args.out}\` is inside this repository or contains it`)
  if (inside(prepared, repo) || inside(repo, prepared)) problems.push(`--oauth-prepared \`${args.prepared}\` is inside this repository or contains it`)
  if (inside(out, prepared) || inside(prepared, out)) problems.push("--out and --oauth-prepared overlap; they must be disjoint")
  const entries = await readdir(args.out).catch((error: unknown) => ((error as NodeJS.ErrnoException).code === "ENOENT" ? [] : [messageOf(error)]))
  if (entries.length > 0) problems.push(`--out \`${args.out}\` is not absent or empty`)
  return problems
}

export async function runShippedCommand(argv: readonly string[]): Promise<ShippedRun> {
  const child = Bun.spawn([process.execPath, "run", join(REPO_ROOT, "scripts", "adversarial.ts"), ...argv], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, SHIPPED_COMMAND_MS)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { exitCode, output: `${stdout}\n${stderr}`, timedOut }
  } finally {
    clearTimeout(timer)
  }
}

export interface ProbeEvidence {
  kind: string
  story: string
  measuredAt: string
  command: string
  codeRevision: unknown
  sandbox: string
  host: { binary: string; sha256: string; version: string; measuredHost: { version: string; sha256: string }; matchesMeasuredHost: boolean } | null
  /** The pins the prepared directory was verified against before any host. */
  payloadPins: unknown
  signIns: string
  protocolFixture: { label: string; draftSha256: string; fixtureFrozenHash: string }
  bounds: Record<string, number>
  calibration: CalibrationRecord
  shippedCommand: { argv: string; claims: Claim[] }
  suiteAllowance: Claim
  transports: { provider: string; model: string; format: string; scenarios: ScenarioRecord[] }[]
  unprobedTransports: readonly { transport: string; why: string }[]
  summary: { holds: number; fails: number; unprobed: number; failing: string[]; note: string }
  limitations: string[]
  gate11: string
}

export const LIMITATIONS: readonly string[] = [
  "Every result holds for its exact provider, model and route on opencode " + `${MEASURED_HOST.version} (sha256 ${MEASURED_HOST.sha256}); it validates no other pin, model or build.`,
  "Sign-ins were placeholders and every provider was a loopback stub: nothing here shows what a real provider, account, cache or quota does.",
  "The launcher's stages 1 and 2 (offline preflight, authorization, reservation) were not run on a real host; only the shipped command's refusal was observed. " +
    "That command ran as the user would run it, so its stage 1 resolved the path of the user's opencode store for its disjointness check; it opens nothing there.",
  "The schedules were sealed with `provenance: \"scripted\"` against a private frozen-format copy of protocol v3. That copy is a fixture: protocol v3 is a draft, and nothing here is pre-registered or frozen.",
  `The non-ending and stream-without-usage rows shorten the turn deadline through the backend seam, to ${HANG_TURN_MS} ms and ${NO_USAGE_TURN_MS} ms. ` +
    `Every other row runs on the shipped launcher's own ${ADVERSARIAL_TURN_TIMEOUT_MS} ms, which no row here waited out.`,
  "The in-run integrity failure was injected by the probe through the late-usage reporter. No spontaneous integrity failure of a real host was observed or is claimed.",
  "A request beyond an attempt's first is classified from what the stub served and from time-window attribution. The host's reason for sending it is not established.",
  "AD-13's host-tool route is unavailable under the StructuredOutput-only offer and is reported unobserved, never as zero and never as resistance.",
  "The suite and the hosts wrote their own session data, dumps, manifests and worktrees under --out. Those stay in private scratch and are not part of this file.",
]

/** Exposed for tests: the whole probe body, given parsed arguments and the things `main` cleans up. */
export async function probeBody(args: ProbeArgs, seams: ProbeSeams, live: { scratch: string[]; servers: Stoppable[]; owner: HostOwner }, signal: AbortSignal): Promise<number> {
  const selfTest = await (seams.selfTest ?? sandboxSelfTest)()
  if (!selfTest.ok) {
    console.error(`REFUSED — the sandbox self-test failed: ${selfTest.why}. No host was started.`)
    return 1
  }
  console.log(`sandbox self-test: ${selfTest.why}`)
  const verified = await (seams.verifyPrepared ?? ((prepared: string) => verifyPrepared(prepared, OAUTH_PAYLOAD)))(args.prepared)
  if (!verified.ok) {
    console.error(`REFUSED — the prepared directory does not verify against OAUTH_PAYLOAD: ${(verified.problems ?? []).join("; ")}. No host was started.`)
    return 1
  }
  console.log("prepared payload: every digest matches OAUTH_PAYLOAD")

  const scratch = await realpath(await mkdtemp(join(tmpdir(), PROBE_SCRATCH_PREFIX)))
  live.scratch.push(scratch)
  const home = join(scratch, "home")
  const { target } = authLinkPaths(join(scratch, "unused-data"), home)
  await mkdir(join(target, ".."), { recursive: true, mode: 0o700 })
  await writeFile(target, `${JSON.stringify(placeholderAuth(Date.now()))}\n`, { mode: 0o600 })
  const protocol = await frozenProtocolFixture(scratch)
  const proxy = startRefusingProxy()
  live.servers.push(proxy)
  const git = boundedGit({ spawn: preflightSpawn, deadlineMs: PREFLIGHT_GIT_DEADLINE_MS, cleanupMs: PREFLIGHT_GIT_CLEANUP_MS })
  let codeRevision: Maybe<CodeRevision>
  try {
    codeRevision = await (seams.codeRevision ?? (() => codeRevisionFrom((_command, gitArgs) => git(REPO_ROOT, gitArgs))))()
  } catch (error) {
    codeRevision = unknownValue(`the code revision could not be read: ${messageOf(error)}`)
  }
  await mkdir(args.out, { recursive: true, mode: 0o700 })
  const context: ProbeContext = {
    out: args.out,
    prepared: args.prepared,
    scratch,
    home,
    protocol,
    proxy,
    signal,
    owner: live.owner,
    seams,
    clock: seams.clock ?? systemClock(),
    codeRevision,
    identity: null,
    scenarioMs: seams.scenarioMs ?? SCENARIO_MS,
  }
  const transports = seams.transports ?? TRANSPORTS
  const scenarios = seams.scenarios ?? SCENARIOS
  const stubs = new Map<string, AdversarialStub>()
  for (const transport of transports) {
    const stub = startAdversarialStub(transport.providerId, transport.format)
    stubs.set(transport.providerId, stub)
    live.servers.push(stub)
  }

  // ---- the shipped command, before any host ----
  const shippedOut = join(args.out, "shipped", "out")
  const shippedData = join(args.out, "shipped", "data")
  const shippedArgv = ["--live", "--provider-mode", "oauth", "--oauth-provider", transports[0]!.providerId, "--pin", `${transports[0]!.providerId}/${transports[0]!.modelId}`, "--oauth-prepared", args.prepared, "--oauth-data-root", shippedData, "--out", shippedOut]
  const evidenceDir = join(seams.repoRoot ?? REPO_ROOT, "ablation", "evidence")
  const listing = async () => (await readdir(evidenceDir).catch(() => [] as string[])).sort().join("\n")
  const before = await listing()
  console.log("\nthe shipped command (no override): bun run adversarial --live --provider-mode oauth …")
  const shipped = await (seams.shipped ?? runShippedCommand)(shippedArgv)
  const leftovers: string[] = []
  for (const [name, path] of [["--out", shippedOut], ["--oauth-data-root", shippedData]] as const) if (await exists(path)) leftovers.push(`${name} exists after the refusal`)
  const shippedResult = shippedClaims(shipped, leftovers, (await listing()) !== before)
  for (const entry of shippedResult) console.log(`  ${entry.verdict.padEnd(8)} ${entry.id}: ${entry.why}`)

  // ---- calibration: one host, under the outer bounds ----
  console.log(`\ncalibration: one sandboxed host on ${transports[0]!.providerId}/${transports[0]!.modelId}`)
  const calibration = await calibrate(context, transports[0]!, stubs.get(transports[0]!.providerId)!)
  if (calibration.refused !== null) {
    console.error(`REFUSED — the calibration host did not start: ${calibration.refused}. No scenario was run.`)
    return 1
  }
  if (calibration.stopProblem !== null || calibration.unsafe.length > 0) {
    console.error(`REFUSED — the calibration host was started and ${calibration.stopProblem ?? "its termination is not established"}. No scenario was run.`)
    for (const line of calibration.unsafe) console.error(`  ${line}`)
    return 1
  }
  context.scenarioMs = Math.min(context.scenarioMs, scenarioBound(calibration.startMs, calibration.stopMs))
  console.log(`  start ${calibration.startMs} ms, stop ${calibration.stopMs} ms; each scenario is bounded at ${context.scenarioMs} ms`)

  // ---- the scenarios, each in roots of its own ----
  const measured: ProbeEvidence["transports"] = []
  for (const transport of transports) {
    const stub = stubs.get(transport.providerId)!
    const pin = `${transport.providerId}/${transport.modelId}`
    const records: ScenarioRecord[] = []
    console.log(`\n${pin} (${transport.format})`)
    for (const spec of scenarios) {
      if (signal.aborted) throw new Error(`the probe's deadline passed before \`${spec.name}\` on ${pin} was started`)
      const { facts, startedAt } = await runScenario(context, transport, stub, spec)
      if (facts.unsafe.length > 0) {
        // Roots of their own do not make overlapping processes safe: nothing further is started.
        throw new Error(`a host's termination is not established after \`${spec.name}\` on ${pin}, so no further host was started: ${facts.unsafe.join("; ")}`)
      }
      const record = scenarioRecord(spec, facts, pin, startedAt, context.scenarioMs)
      records.push(record)
      console.log(`  ${spec.name} — ${record.elapsedMs} ms, ${plural(record.hosts.starts, "host start")}`)
      for (const entry of record.claims) console.log(`    ${entry.verdict.padEnd(8)} ${entry.id}: ${entry.why}`)
      for (const line of record.observations) console.log(`    observed: ${line}`)
    }
    measured.push({ provider: transport.providerId, model: transport.modelId, format: transport.format, scenarios: records })
  }

  const all: { where: string; claim: Claim }[] = [
    ...shippedResult.map((entry) => ({ where: "shipped command", claim: entry })),
    { where: "suite allowance", claim: SUITE_ALLOWANCE_CLAIM },
    ...measured.flatMap((transport) => transport.scenarios.flatMap((scenario) => scenario.claims.map((entry) => ({ where: `${transport.provider}/${transport.model}, ${scenario.name}`, claim: entry })))),
  ]
  const failing = all.filter((entry) => entry.claim.verdict === "FAILS").map((entry) => `${entry.where}: ${entry.claim.id}`)
  const identity = context.identity
  const evidence: ProbeEvidence = {
    kind: EVIDENCE_KIND,
    story: "2-7f2",
    measuredAt: new Date().toISOString(),
    command: "bun run adversarial-probe --out <probe-out> --oauth-prepared <prepared-root>",
    codeRevision,
    sandbox: selfTest.why,
    host:
      identity === null
        ? null
        : {
            ...identity,
            measuredHost: { version: MEASURED_HOST.version, sha256: MEASURED_HOST.sha256 },
            matchesMeasuredHost: identity.sha256 === MEASURED_HOST.sha256 && identity.version === MEASURED_HOST.version,
          },
    payloadPins: OAUTH_PAYLOAD,
    signIns: "placeholders: every data directory's auth.json is a symlink to one placeholder file under the probe's scratch; the user's store was never linked, opened or named in a route",
    protocolFixture: {
      label: "SYNTHETIC FIXTURE — a private frozen-format copy of the draft protocol v3; it pre-registers nothing and is no freeze. The repository's protocol v3 was read and not written.",
      draftSha256: protocol.draftSha256,
      fixtureFrozenHash: protocol.fixtureHash,
    },
    bounds: {
      hostStartMs: HOST_START_MS,
      rosterReadMs: ROSTER_READ_MS,
      hangTurnMs: seams.hangTurnMs ?? HANG_TURN_MS,
      hangSlackMs: HANG_SLACK_MS,
      noUsageTurnMs: seams.noUsageTurnMs ?? NO_USAGE_TURN_MS,
      teardownMs: TEARDOWN_MS,
      scenarioOuterMs: SCENARIO_MS,
      scenarioMs: context.scenarioMs,
      probeMs: seams.probeMs ?? PROBE_MS,
    },
    calibration,
    shippedCommand: { argv: `bun run adversarial ${shippedArgv.join(" ")}`, claims: shippedResult },
    suiteAllowance: SUITE_ALLOWANCE_CLAIM,
    transports: measured,
    unprobedTransports: UNPROBED_TRANSPORTS,
    summary: {
      holds: all.filter((entry) => entry.claim.verdict === "HOLDS").length,
      fails: failing.length,
      unprobed: all.filter((entry) => entry.claim.verdict === "UNPROBED").length,
      failing,
      note: "Counts of per-claim verdicts. They are not a verdict on gate 11, and a HOLDS on one transport says nothing about another.",
    },
    limitations: [...LIMITATIONS],
    gate11: "OPEN. This file is evidence for a separate, reviewed gate change; it closes nothing.",
  }
  const text = redactPaths(JSON.stringify(evidence, null, 2), [
    [args.out, "<probe-out>"],
    [await realOf(args.out), "<probe-out>"],
    [args.prepared, "<prepared-root>"],
    [await realOf(args.prepared), "<prepared-root>"],
    [scratch, "<probe-scratch>"],
    [await realOf(tmpdir()), "<tmp>"],
    [tmpdir(), "<tmp>"],
    [REPO_ROOT, "<repo>"],
    [homedir(), "<home>"],
  ])
  await writeFile(join(args.out, EVIDENCE_FILE), `${text}\n`, "utf8")
  console.log(`\nevidence: ${join(args.out, EVIDENCE_FILE)}`)
  console.log(`${evidence.summary.holds} HOLDS, ${evidence.summary.fails} FAILS, ${evidence.summary.unprobed} UNPROBED. Gate 11 stays OPEN.`)
  for (const line of failing) console.log(`  FAILS — ${line}`)
  return failing.length === 0 ? 0 : 1
}

export async function main(argv: readonly string[] = Bun.argv, seams: ProbeSeams = {}): Promise<number> {
  const platform = seams.platform ?? process.platform
  if (platform !== "darwin") {
    console.error(`REFUSED — the adversarial probe runs only on macOS, whose sandbox-exec is its egress control; this platform is ${platform}. No host was started.`)
    return 1
  }
  const parsed = parseProbeArgs(argv)
  if (!parsed.ok) {
    console.error(parsed.reason)
    return 1
  }
  const problems = await pathProblems(parsed.args, seams.repoRoot)
  if (problems.length > 0) {
    for (const problem of problems) console.error(`REFUSED — ${problem}. No host was started.`)
    return 1
  }
  const live = { scratch: [] as string[], servers: [] as Stoppable[], owner: new HostOwner(seams.teardownMs ?? TEARDOWN_MS) }
  const controller = new AbortController()
  let cleaning: Promise<string[]> | undefined
  const cleanupOnce = async (): Promise<string[]> => {
    const left: string[] = await live.owner.settle()
    const hostsUnresolved = left.length > 0
    for (const server of live.servers) await Promise.resolve().then(() => server.stop()).catch((error: unknown) => left.push(`a local server did not stop: ${messageOf(error)}`))
    // A host that may still be running may still hold its placeholder sign-in and its scratch: they are kept.
    if (hostsUnresolved) for (const dir of live.scratch) left.push(`\`${dir}\` is kept, because a host's termination is not established`)
    else for (const dir of live.scratch) await rm(dir, { recursive: true, force: true }).catch((error: unknown) => left.push(`\`${dir}\` could not be removed: ${messageOf(error)}`))
    return left
  }
  const cleanup = (): Promise<string[]> => (cleaning ??= cleanupOnce())
  const onSignal = () => {
    controller.abort()
    void cleanup().then((left) => {
      for (const line of left) console.error(line)
      console.error("\nINTERRUPTED — the probe stopped; nothing above is a complete measurement.")
      process.exit(130)
    })
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
  const probeMs = seams.probeMs ?? PROBE_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  let settle: ReturnType<typeof setTimeout> | undefined
  try {
    const body = probeBody(parsed.args, seams, live, controller.signal).then(
      (code) => ({ code }),
      (error: unknown) => ({ failed: messageOf(error) }),
    )
    const bounded = await Promise.race([
      body,
      new Promise<"timed-out">((done) => {
        timer = setTimeout(() => done("timed-out"), probeMs)
      }),
    ])
    if (bounded === "timed-out") {
      controller.abort()
      await Promise.race([
        body,
        new Promise((done) => {
          settle = setTimeout(done, TEARDOWN_MS)
        }),
      ])
    }
    const left = await cleanup()
    for (const line of left) console.error(line)
    if (bounded === "timed-out") {
      await rm(join(parsed.args.out, EVIDENCE_FILE), { force: true }).catch(() => undefined)
      console.error(`the probe did not finish within ${probeMs} ms. NOTHING ABOVE IS A COMPLETE MEASUREMENT.`)
      return 1
    }
    if ("failed" in bounded) {
      console.error(`the probe failed: ${bounded.failed}. Nothing above is a complete measurement.`)
      return 1
    }
    return left.length > 0 ? 1 : bounded.code
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (settle !== undefined) clearTimeout(settle)
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
  }
}

if (import.meta.main) process.exit(await main())
