#!/usr/bin/env bun
/**
 * Story 2-8c5 — the bounded OpenAI OAuth pilot that paired gate 7 needs.
 *
 *   bun run oauth-pilot --out /scratch/mad-oauth-pilot-dry [--oauth-prepared /scratch/mad-oauth-prepared]
 *   bun run oauth-pilot --live --oauth-data-dir ~/.local/share/mad-opencode-oauth \
 *     --oauth-prepared /scratch/mad-oauth-prepared --out /scratch/mad-oauth-pilot
 *
 * OpenAI's ChatGPT OAuth transport ignores a redirected `baseURL`, so no zero-bill
 * probe can observe it (story 2-8c3b, finding O1). Protocol v2 A11 lets such a
 * transport be covered only by a separately authorized, bounded pilot. This is that
 * pilot's command. The proposal it implements is
 * `_bmad-output/specs/spec-mad-orchestrator/stories/2-8d-openai-oauth-pilot-proposal.md`.
 * Its evidence is `<out>/oauth-pilot.json`.
 *
 * ## Two modes, one sandbox
 *
 * In both modes the host runs inside the loopback-only sandbox of the OAuth probe
 * (`SANDBOX_PROFILE`, through `sandboxSpawn`), after the same self-test, so it has
 * no direct route to any external host. Its only way out is the loopback
 * `HTTPS_PROXY`, which runs outside the sandbox, in this process. A transport that
 * ignores `HTTPS_PROXY` is denied by the sandbox, and its attempt fails.
 *
 * - **The dry run** (the default) bills nothing. Its proxy refuses every
 *   `CONNECT`, so its first attempt always fails: it cannot exercise the ceiling or
 *   the refused third admission, which the stand-in tests prove. It runs on a fresh
 *   probe-owned placeholder data directory (`startProbePlaceholderHost`) whose
 *   sign-ins are placeholders for openai, anthropic and github-copilot, as a real
 *   store holding all three would be. It runs the same attempt sequence and stop
 *   rules as the live run. It never touches the user's `auth.json` or data
 *   directory; `--oauth-data-dir` is refused in this mode. It stats only its own
 *   placeholder target. Without `--oauth-prepared` it first builds the prepared
 *   directory with `bun run oauth-prepare`, which runs npm unsandboxed, with
 *   network access.
 * - **The live run** (`--live`) is refused unless paired gate 8, "OAuth pilot
 *   spend authorization", is CLOSED in a committed, unmodified
 *   `ablation/paired-gates.ts`, and only for one run: it also refuses when the
 *   exposure document differs from `OAUTH_PILOT_PROPOSAL`'s sha256, when a live
 *   run's evidence (`ablation/evidence/oauth-pilot-live-*.json`) or its reservation
 *   (`LIVE_RESERVATION`) is committed or in the tree, when `ablation/evidence`
 *   cannot be read, or when `--out` already holds a pilot's evidence. It then
 *   creates the reservation exclusively, so only one invocation can hold it; nothing
 *   deletes it, so a further run needs the human's explicit decision. The
 *   authorization and the one-run checks are the first thing it does after reading
 *   its arguments; the reservation follows the platform and `--out` checks. All of
 *   it comes before any host, any stat of the real auth target, any opening of the
 *   data directory and any network connection. No flag, variable or file can authorize it. Once authorized, one
 *   host runs through `startManagedHost` in OAuth mode on `--oauth-data-dir` and
 *   `--oauth-prepared`, with every check that mode makes (payload digests, the
 *   auth symlink, the data directory's shape and disjointness, the store guard
 *   before and after). Its proxy tunnels `CONNECT` only to
 *   `PILOT_ALLOWED_CONNECTS`.
 *
 * ## The attempts
 *
 * The host's `enabled_providers` is `["openai"]`, and its `model` and `small_model`
 * are both `openai/gpt-6-luna`. At most `PILOT_MAX_ATTEMPTS` (2) attempts are
 * admitted, one after the other, each one `runTurn` through the production
 * `OpencodeModelBackend` with `PILOT_PROMPT`, no host tools, and a
 * `PILOT_TURN_TIMEOUT_MS` bound. The journal runs in attempt mode on block 1's
 * prefix, seeded with `PILOT_SEEDED` settled attempts, so it admits exactly two:
 * after two attempts a third admission is asked for and must be refused inside
 * the journal, with no backend call.
 *
 * ## Stops
 *
 * Nothing further is admitted, and the reason is recorded, on the first of: a
 * failed host start (a preflight failure); an attempt whose backend threw, that
 * timed out (settled abandoned, which latches the journal's halt), that ended in
 * an error (a provider refusal included), that was settled other than `usage`, or
 * that returned `cleanupUnresolved`; a proxy-observed `CONNECT` to a target outside
 * `PILOT_ALLOWED_CONNECTS`; a journal integrity or persistence failure, an
 * admission or a settlement that throws included. A post-stop failure fails the
 * exit code.
 *
 * One `CONNECT` outside the two hosts is excused: one to exactly `COPILOT_TARGET`
 * before the first admission was asked (so before any `issued` line), which the
 * host makes at startup even with only `openai` enabled. The proxy refuses it (it
 * is never tunnelled), and it is recorded with its time. The same `CONNECT` once
 * the first admission has been asked stops the pilot.
 *
 * After the host stops, the proxy's whole log is checked again, so a connection
 * that arrived after the sequence's last check still counts, and the macOS
 * unified log is read for sandbox denials over the host's window. Only the host
 * and its children run sandboxed then, so every denial counts against the host's
 * process tree.
 *
 * ## What the evidence can say
 *
 * Every connection it lists is a **proxy-observed CONNECT**: a connection that does
 * not use the proxy is not seen, so the list is never all egress. TLS hides
 * requests, so the per-attempt physical request count is not shown. The sandbox
 * denials the unified log reported are listed apart from the proxy's log; neither
 * is a complete census of direct connections. The evidence holds no request or
 * response content: an attempt is recorded by its failure kind, its settlement,
 * host-reported tokens labelled unverified, and an allowlisted host-error record
 * (`ablation/host-error.ts`: a category, an optional code and a fixed summary; the
 * host's message is omitted). An attempt that ended in a host error with an
 * all-zero host token object settles `unknown`, not a known zero, and still
 * stops as "ended in an error". The auth target is recorded only as
 * changed or unchanged flags for size, mtime and inode.
 *
 * Only a run that exits 0 writes `oauth-pilot.json`. Every other outcome after the
 * journal opened writes `PARTIAL_EVIDENCE_FILE` instead, labelled INCOMPLETE: a run
 * that completed but failed a check gets `status: "FAILED"`, its `failures` and
 * every diagnostic the full evidence would hold; a run that threw, passed its
 * deadline or was interrupted gets `status: "INCOMPLETE"`, with the journal closed
 * first and the sequence so far, the proxy's log, the journal and the failure.
 * A signal after `oauth-pilot.json` was written demotes it into that one file,
 * naming the signal, and the run ends 130.
 *
 * ## Exit status
 *
 * Dry: 0 when the run completed, every post-stop check held, no connection was
 * tunnelled, the unified log reported no sandbox denial over the host's window and
 * no attempt returned a model answer. An admitted attempt that failed still has a
 * journal `settled` line. Live: 0 when both attempts answered and settled `usage`,
 * nothing stopped the run, the third admission was refused with no backend call,
 * the proxy's log held nothing the stop rule rejects and no tunnel outside an
 * attempt, the unified log was read and reported no sandbox denial, and every
 * post-stop check held. Exit 0 closes no gate: gate 7 closes only by a reviewed,
 * committed change to `ablation/paired-gates.ts`.
 */

import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, isAbsolute, join, resolve } from "node:path"

import { z } from "zod"

import { OpencodeModelBackend } from "../adapters/opencode/model-backend.ts"
import { startAllowlistProxy, type AllowlistProxy, type ProxyConnect } from "../ablation/accounting-stub.ts"
import { ATTEMPT_ALLOWANCES } from "../ablation/governor.ts"
import { acquireLock, JOURNAL_FILE, openJournal, type IssuedLine, type SettledLine } from "../ablation/journal.ts"
import {
  MEASURED_HOST,
  PROBE_PLACEHOLDER_DIR,
  PROBE_SCRATCH_PREFIX,
  startManagedHost,
  startProbePlaceholderHost,
  type ManagedHostStart,
  type OAuthHostOptions,
  type OAuthRoute,
  type PostStopChecks,
  type StopOutcome,
} from "../ablation/managed-host.ts"
import { hostErrorOf, type HostError } from "../ablation/host-error.ts"
import { authLinkPaths, overlapProblem } from "../ablation/oauth-payload.ts"
import { gatePreflight, OAUTH_PILOT_PROPOSAL, PAIRED_GATES, type PairedGate } from "../ablation/paired-gates.ts"
import type { RosterSlot } from "../core/domain/roster.ts"
import type { AdmissionSettlement, RequestAdmission } from "../core/ports/admission.ts"
import type { Envelope, ModelBackend } from "../core/ports/model-backend.ts"
import { selectRoster } from "../core/roster/select.ts"
import { settlementOf } from "../core/stages/settlement.ts"
import { outProblem } from "./accounting-probe.ts"
import {
  CONTROL_TARGET,
  journalLines,
  redactPaths,
  SANDBOX_PROFILE,
  sandboxSelfTest,
  sandboxSpawn,
  seededAttempts,
  writePlaceholders,
  type HostIdentity,
  type SelfTest,
  type Stoppable,
} from "./oauth-probe.ts"
import { prepareOAuthPayload } from "./oauth-prepare.ts"
import {
  boundedGit,
  GATE_TABLE_FILE,
  gateTableState,
  PREFLIGHT_GIT_CLEANUP_MS,
  PREFLIGHT_GIT_DEADLINE_MS,
  preflightSpawn,
  REPO_ROOT,
  type GateTableState,
} from "./paired.ts"
import type { RunGit } from "./materialize-labelled-change.ts"

export const EVIDENCE_FILE = "oauth-pilot.json"
/** Every outcome after the journal opened that does not exit 0 writes this instead of `EVIDENCE_FILE`, labelled INCOMPLETE. */
export const PARTIAL_EVIDENCE_FILE = "oauth-pilot.INCOMPLETE.json"

/** The hard ceiling on admitted attempts. Changing it is a human decision (story 2-8c5, Ask First). */
export const PILOT_MAX_ATTEMPTS = 2
/** Settled attempts seeded into block 1's prefix, so the journal admits exactly `PILOT_MAX_ATTEMPTS` more. */
export const PILOT_SEEDED = ATTEMPT_ALLOWANCES.prefix - PILOT_MAX_ATTEMPTS
export const PILOT_PROMPT = "Reply with the word ok."
export const PILOT_TURN_TIMEOUT_MS = 120_000
export const PILOT_MODEL = { providerId: "openai", modelId: "gpt-6-luna" } as const
export const PILOT_PROVIDERS: readonly string[] = [PILOT_MODEL.providerId]
/** The only targets the live proxy tunnels to. Every other `CONNECT` is refused, and stops the pilot. */
export const PILOT_ALLOWED_CONNECTS: readonly string[] = ["chatgpt.com:443", "auth.openai.com:443"]
/**
 * The host's startup connection the 2-8c3b probe observed (finding E1), made even
 * with only `openai` enabled (the pilot's dry run,
 * `ablation/evidence/oauth-pilot-dryrun-2026-09-28.json`). Refused before the first
 * `issued` line, it does not stop the pilot; after it, it does.
 */
export const COPILOT_TARGET = "api.githubcopilot.com:443"
/** No host tool is offered; `StructuredOutput` is how opencode returns a structured answer, not a tool the model acts through. */
export const PILOT_TOOLS: Readonly<Record<string, boolean>> = { "*": false, StructuredOutput: true }
export const PILOT_REPLY_SCHEMA = z.object({ reply: z.string() })
export const PILOT_DEADLINE_MS = 900_000
export const BODY_SETTLE_MS = 30_000
/** The live run's scratch prefix. The dry run's is the probe's, which `startProbePlaceholderHost` requires. */
export const PILOT_SCRATCH_PREFIX = "mad-oauth-pilot-"
/** The placeholder name the dry run's data directory lives under. */
export const DRY_PLACEHOLDER = "oauth-pilot"
export const LOG_BINARY = "/usr/bin/log"

export type PilotMode = "dry" | "live"

export const EVIDENCE_KIND: Record<PilotMode, string> = {
  dry:
    "MEASURED RUNTIME CASE — the OAuth pilot's dry run (story 2-8c5): a real `opencode serve` in OAuth mode on placeholder " +
    "sign-ins, inside a loopback-only sandbox, behind a proxy that refuses every CONNECT",
  live:
    "MEASURED RUNTIME CASE — the bounded OpenAI OAuth pilot (story 2-8c5): a real `opencode serve` in OAuth mode on the " +
    "ChatGPT OAuth sign-in, inside a loopback-only sandbox, behind a proxy that tunnels CONNECT only to the allowed hosts",
}

/** Every evidence file carries these statements, whatever it observed. */
export const EVIDENCE_WORDING = [
  "every connection listed under `proxy.connects` is a proxy-observed CONNECT: a connection that does not use the proxy is " +
    "not seen, so the list is never all egress",
  "the per-attempt physical request count is not shown: TLS and HTTP/2 hide requests inside a proxy-observed CONNECT, and " +
    "the host's own retries and side requests are neither gated nor counted on the OAuth route",
  "no request or response content is recorded: an attempt is recorded by its failure kind, its journal settlement and its " +
    "host-reported tokens, which are unverified diagnostics, not a cost",
  "a failed attempt's `hostError` is an allowlisted category, an optional allowlisted code and a fixed summary; the host's " +
    "error message is omitted",
  "an attempt that ended in a host error with an all-zero host token object is settled `unknown`: the host reports the same " +
    "zeros for an errored turn that made requests, so they are not a known usage",
]

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export interface PilotArgs {
  mode: PilotMode
  out: string
  /** Live only. */
  dataDir?: string
  prepared?: string
  home: string
}

/**
 * Reads the arguments without touching the filesystem. `--out` is required in
 * both modes; `--live` requires `--oauth-data-dir` and `--oauth-prepared`; the dry
 * run refuses `--oauth-data-dir`, because it never touches a real data directory.
 */
export function parsePilotArgs(argv: readonly string[], home: string = homedir()): { ok: true; args: PilotArgs } | { ok: false; reason: string } {
  const args = argv.slice(2)
  const values: Record<string, string> = {}
  let live = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === "--live") {
      if (live) return { ok: false, reason: "--live was given twice" }
      live = true
      continue
    }
    const name = arg.startsWith("--") ? arg.slice(2).split("=")[0]! : ""
    if (!["out", "oauth-data-dir", "oauth-prepared"].includes(name)) {
      return { ok: false, reason: `unexpected argument \`${arg}\`. This command takes --live, --out, --oauth-data-dir and --oauth-prepared only.` }
    }
    if (name in values) return { ok: false, reason: `--${name} was given twice` }
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++index]
    if (value === undefined || value.trim() === "" || !isAbsolute(value)) return { ok: false, reason: `--${name} needs an absolute path` }
    values[name] = resolve(value)
  }
  if (values.out === undefined) return { ok: false, reason: "--out <absolute directory> is required" }
  if (!live) {
    if (values["oauth-data-dir"] !== undefined) {
      return { ok: false, reason: "--oauth-data-dir is refused without --live: the dry run runs on a fresh placeholder data directory and never touches a real one" }
    }
    return { ok: true, args: { mode: "dry", out: values.out, ...(values["oauth-prepared"] === undefined ? {} : { prepared: values["oauth-prepared"] }), home } }
  }
  const missing = ["oauth-data-dir", "oauth-prepared"].filter((name) => values[name] === undefined)
  if (missing.length > 0) return { ok: false, reason: `--live needs ${missing.map((name) => `--${name} <absolute path>`).join(" and ")}` }
  return { ok: true, args: { mode: "live", out: values.out, dataDir: values["oauth-data-dir"]!, prepared: values["oauth-prepared"]!, home } }
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

export interface Authorization {
  ok: boolean
  /** The gate table's state and every gate line, as printed. */
  lines: string[]
  /** Why the live run is refused; empty when it is authorized. */
  problems: string[]
  /** The committed gate table's blob, when it could be read. */
  blob?: string
}

/**
 * Whether the live run is authorized: `ablation/paired-gates.ts` is HEAD's blob,
 * unmodified, and `gatePreflight(gates, "oauth-pilot", "oauth")` passes, which
 * with a well-formed table means gate 8 is CLOSED. Nothing else is read.
 */
export async function authorize(gates: readonly PairedGate[], table: () => Promise<GateTableState>): Promise<Authorization> {
  let state: GateTableState
  try {
    state = await table()
  } catch (error) {
    state = { ok: false, why: `whether ${GATE_TABLE_FILE} is committed could not be established: ${messageOf(error)}` }
  }
  const preflight = gatePreflight(gates, "oauth-pilot", "oauth")
  const problems = [...(state.ok ? [] : [state.why]), ...preflight.problems]
  return {
    ok: problems.length === 0,
    lines: [state.ok ? `${GATE_TABLE_FILE} is HEAD's blob ${state.blob}` : `${GATE_TABLE_FILE} is not the committed table`, ...preflight.lines],
    problems,
    ...(state.ok ? { blob: state.blob } : {}),
  }
}

// ---------------------------------------------------------------------------
// The auth target: metadata flags, never values
// ---------------------------------------------------------------------------

/** One `lstat` or `stat` of the auth target, held in memory only. Never written out. */
export type StatFacts = { ok: true; size: bigint; mtimeNs: bigint; ino: bigint } | { ok: false; code: string }

export interface AuthTargetStat {
  lstat: StatFacts
  stat: StatFacts
}

/** `lstat` and `stat` of `path`: metadata only. The file is never opened. */
export async function statAuthTarget(path: string): Promise<AuthTargetStat> {
  const facts = async (call: typeof lstat): Promise<StatFacts> => {
    try {
      const info = await call(path, { bigint: true })
      return { ok: true, size: info.size, mtimeNs: info.mtimeNs, ino: info.ino }
    } catch (error) {
      return { ok: false, code: (error as NodeJS.ErrnoException).code ?? "unknown" }
    }
  }
  return { lstat: await facts(lstat), stat: await facts(stat as typeof lstat) }
}

export type Flag = "changed" | "unchanged" | string

export interface AuthTargetFlags {
  lstat: { size: Flag; mtime: Flag; inode: Flag }
  stat: { size: Flag; mtime: Flag; inode: Flag }
}

/** Changed or unchanged for size, mtime and inode; `unavailable (<code>)` when a call failed. No value is carried. */
export function authTargetFlags(before: AuthTargetStat, after: AuthTargetStat): AuthTargetFlags {
  const compare = (a: StatFacts, b: StatFacts) => {
    if (!a.ok || !b.ok) {
      const why = `unavailable (${[!a.ok ? `before: ${a.code}` : "", !b.ok ? `after: ${b.code}` : ""].filter(Boolean).join("; ")})`
      return { size: why, mtime: why, inode: why }
    }
    const flag = (x: bigint, y: bigint): Flag => (x === y ? "unchanged" : "changed")
    return { size: flag(a.size, b.size), mtime: flag(a.mtimeNs, b.mtimeNs), inode: flag(a.ino, b.ino) }
  }
  return { lstat: compare(before.lstat, after.lstat), stat: compare(before.stat, after.stat) }
}

// ---------------------------------------------------------------------------
// Sandbox denials
// ---------------------------------------------------------------------------

/**
 * One network-outbound denial the unified log reported. Only the host and its
 * children run sandboxed during the host's window, so every entry is counted
 * against the host's process tree; `namesHost` says whether it names the host's
 * own process id.
 */
export interface DenialEntry {
  /** Milliseconds after the pilot's body started, or `null` when the timestamp could not be read. */
  atMs: number | null
  message: string
  namesHost: boolean
}

export type SandboxDenials = { ok: true; source: string; entries: DenialEntry[] } | { ok: false; source: string; why: string }

/** How long after the host's exit the log is read: the unified log delivers entries late. */
export const DENIAL_SETTLE_MS = 3_000
/** The margin read on each side of the host's window. The lower side never reaches back past the sandbox self-test's end. */
export const DENIAL_MARGIN_MS = 2_000

const LOG_PREDICATE = 'sender == "Sandbox" AND eventMessage CONTAINS "network-outbound"'

const localTime = (ms: number) => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** A unified-log timestamp (`2026-09-28 14:42:05.993456+0200`) in epoch milliseconds, or NaN. */
export function logTimestamp(text: string): number {
  return Date.parse(text.replace(" ", "T").replace(/(\.\d{3})\d*/, "$1").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"))
}

export interface DenialWindow {
  /** The earliest and latest moments an entry may carry, in epoch milliseconds. */
  from: number
  to: number
  hostPid: number
  /** The pilot body's start, which `atMs` counts from. */
  started: number
}

/** The `Sandbox:` entries of `log show --style ndjson` output that fall inside the window. An entry whose time cannot be read is kept. */
export function denialEntries(ndjson: string, window: DenialWindow): DenialEntry[] {
  return ndjson.split("\n").flatMap((line) => {
    let parsed: { eventMessage?: unknown; timestamp?: unknown }
    try {
      parsed = JSON.parse(line) as { eventMessage?: unknown; timestamp?: unknown }
    } catch {
      return []
    }
    if (parsed === null || typeof parsed.eventMessage !== "string" || !parsed.eventMessage.startsWith("Sandbox: ")) return []
    const at = typeof parsed.timestamp === "string" ? logTimestamp(parsed.timestamp) : Number.NaN
    if (!Number.isNaN(at) && (at < window.from || at > window.to)) return []
    return [{ atMs: Number.isNaN(at) ? null : at - window.started, message: parsed.eventMessage, namesHost: parsed.eventMessage.includes(`(${window.hostPid})`) }]
  })
}

export interface DenialRequest {
  /** When the host start began, and when its exit was confirmed. */
  since: number
  until: number
  /** When the sandbox self-test returned: its own denials are earlier, and are not the host's. */
  floor: number
  hostPid: number
  started: number
}

/**
 * The network-outbound denials the macOS unified log reported over the host's
 * window, read `DENIAL_SETTLE_MS` after its exit with `DENIAL_MARGIN_MS` on each
 * side. The log may drop or coalesce entries, so this is what it reported, never a
 * census.
 */
export async function readSandboxDenials(request: DenialRequest, settleMs = DENIAL_SETTLE_MS): Promise<SandboxDenials> {
  const source = `\`${LOG_BINARY} show --style ndjson --predicate '${LOG_PREDICATE}'\` over the host's run, ${settleMs} ms after its exit, with ${DENIAL_MARGIN_MS} ms each side`
  const from = Math.max(request.since - DENIAL_MARGIN_MS, request.floor)
  const to = request.until + DENIAL_MARGIN_MS
  try {
    await Bun.sleep(settleMs)
    const child = Bun.spawn({
      // `--start` and `--end` are read to the second, so the query is widened by a second and the entries filtered to the window.
      cmd: [LOG_BINARY, "show", "--style", "ndjson", "--start", localTime(from - 1_000), "--end", localTime(to + 1_000), "--predicate", LOG_PREDICATE],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, 60_000)
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    clearTimeout(timer)
    if (timedOut) return { ok: false, source, why: "it did not finish within 60000 ms" }
    if (code !== 0) return { ok: false, source, why: `it exited ${code}: ${stderr.trim().slice(-300) || "no detail"}` }
    return { ok: true, source, entries: denialEntries(stdout, { from, to, hostPid: request.hostPid, started: request.started }) }
  } catch (error) {
    return { ok: false, source, why: messageOf(error) }
  }
}

// ---------------------------------------------------------------------------
// The attempt sequence (unit-tested with stand-ins)
// ---------------------------------------------------------------------------

/** One admitted attempt, with no request or response content. */
export interface PilotAttempt {
  attempt: number
  /** When its admission was asked for: its `issued` line cannot be earlier. */
  askedAt: number
  admittedAt: number
  settledAt: number
  /** Whether the turn returned a model answer. */
  answered: boolean
  /** The turn's failure kind, when it did not answer. */
  failure: string | null
  /** Whether `runTurn` threw instead of returning. */
  threw: boolean
  /** Story 2-8c6 — the allowlisted host-error record, or `null` when the turn answered. The host's message is never kept. */
  hostError: HostError | null
  settlement: AdmissionSettlement
  /** Why the journal could not record the settlement, or `null`. */
  settleError: string | null
  cleanupUnresolved: boolean
}

export interface ThirdAdmission {
  /** Whether the third admission was asked for: only after both attempts ran with no stop. */
  asked: boolean
  refusal: { cause: string; reason: string } | null
  backendCalls: number
  why: string
}

export interface AttemptSequence {
  attempts: PilotAttempt[]
  third: ThirdAdmission
  backendCalls: number
  stop: { reason: string; after: string } | null
  /** When the first admission was asked for: the Copilot startup boundary. `null` when none was. */
  firstAskedAt: number | null
}

export const emptySequence = (): AttemptSequence => ({
  attempts: [],
  third: { asked: false, refusal: null, backendCalls: 0, why: "not asked: no attempt ran" },
  backendCalls: 0,
  stop: null,
  firstAskedAt: null,
})

export interface AttemptInput {
  admission: RequestAdmission
  backend: ModelBackend
  slot: string
  signal: AbortSignal
  /** Every connection the proxy observed so far. */
  connects: () => readonly ProxyConnect[]
  /** What the journal latched, its stop or its halt, or `null`. */
  latched: () => string | null
  now?: () => number
  /** Kept up to date as the sequence runs, so an interrupted run can still report it. */
  progress?: AttemptSequence
}

/**
 * What the stop rule makes of one proxy-observed connection: to an allowed host;
 * the Copilot startup event (a refused `CONNECT` to exactly `COPILOT_TARGET` before
 * `firstAskedAt`, the moment the first admission was asked for, so before any
 * `issued` line); or outside the allowed hosts, which stops the pilot.
 */
export type ConnectRule = "allowed-host" | "copilot-startup" | "stops"

export function connectRule(entry: ProxyConnect, firstAskedAt: number | null): ConnectRule {
  if (entry.target !== null && PILOT_ALLOWED_CONNECTS.includes(entry.target)) return "allowed-host"
  if (entry.target === COPILOT_TARGET && entry.outcome === "refused" && (firstAskedAt === null || entry.at < firstAskedAt)) return "copilot-startup"
  return "stops"
}

/** The first proxy-observed connection that stops the pilot, or `null`. */
export function foreignConnect(connects: readonly ProxyConnect[], firstAskedAt: number | null): ProxyConnect | null {
  return connects.find((entry) => connectRule(entry, firstAskedAt) === "stops") ?? null
}

/** Why an ended attempt stops the pilot, or `null`, checked in this order: a throw, a timeout, an error, a settlement other than `usage`, `cleanupUnresolved`. */
export function attemptStop(attempt: PilotAttempt): string | null {
  const settlement = attempt.settlement
  if (attempt.threw) return `attempt ${attempt.attempt}: the backend threw after the request was issued, which halts`
  if (settlement.kind === "unknown" && settlement.abandoned === true) {
    return `attempt ${attempt.attempt} did not end within its ${PILOT_TURN_TIMEOUT_MS} ms bound: it was settled abandoned, which halts`
  }
  if (!attempt.answered) return `attempt ${attempt.attempt} ended in an error (${attempt.failure ?? "no answer"})`
  if (settlement.kind !== "usage") return `attempt ${attempt.attempt} was settled \`${settlement.kind}\`, not \`usage\``
  if (attempt.cleanupUnresolved) return `attempt ${attempt.attempt} returned cleanupUnresolved: its session was not deleted within the backend's bound`
  return null
}

/**
 * Admit and run at most `PILOT_MAX_ATTEMPTS` attempts, one after the other, and
 * stop on the first stop rule. After two attempts with no stop, a third admission
 * is asked for; the journal must refuse it, and the backend is never called for it.
 * An admission or a settlement that throws stops the sequence; it never escapes.
 */
export async function runAttempts(input: AttemptInput): Promise<AttemptSequence> {
  const now = input.now ?? Date.now
  const sequence = Object.assign(input.progress ?? emptySequence(), emptySequence())
  const standing = (after: string): AttemptSequence["stop"] => {
    const foreign = foreignConnect(input.connects(), sequence.firstAskedAt)
    if (foreign !== null) {
      const where = foreign.target === COPILOT_TARGET ? `to ${COPILOT_TARGET} after the first admission was asked` : `outside ${PILOT_ALLOWED_CONNECTS.join(" and ")}`
      return { reason: `a proxy-observed CONNECT ${where}: \`${foreign.line}\``, after }
    }
    const latched = input.latched()
    if (latched !== null) return { reason: `the journal latched: ${latched}`, after }
    return null
  }
  for (let number = 1; number <= PILOT_MAX_ATTEMPTS; number += 1) {
    const after = number === 1 ? "the host started" : `attempt ${number - 1}`
    sequence.stop = standing(after)
    if (sequence.stop !== null) break
    if (input.signal.aborted) {
      sequence.stop = { reason: "the pilot was aborted: its deadline passed or it was interrupted", after }
      break
    }
    const askedAt = now()
    sequence.firstAskedAt ??= askedAt
    let decision: Awaited<ReturnType<RequestAdmission["admit"]>>
    try {
      decision = await input.admission.admit({ stage: "discover", slot: input.slot, attempt: number })
    } catch (error) {
      sequence.stop = { reason: `the journal's admission of attempt ${number} threw: ${messageOf(error)}`, after }
      break
    }
    if (!decision.ok) {
      sequence.stop = { reason: `the journal refused attempt ${number} (${decision.cause}): ${decision.reason}`, after }
      break
    }
    const admittedAt = now()
    sequence.backendCalls += 1
    let envelope: Envelope<unknown>
    let threw = false
    try {
      envelope = await input.backend.runTurn(input.slot, PILOT_PROMPT, PILOT_PROMPT, PILOT_REPLY_SCHEMA, input.signal, decision.turn)
    } catch (error) {
      threw = true
      envelope = { ok: false, slot: input.slot, failure: "transport-error", message: messageOf(error) }
    }
    const settlement = settlementOf(envelope, threw)
    let settleError: string | null = null
    try {
      await decision.settle(settlement)
    } catch (error) {
      settleError = messageOf(error)
    }
    const record: PilotAttempt = {
      attempt: number,
      askedAt,
      admittedAt,
      settledAt: now(),
      answered: envelope.ok,
      failure: envelope.ok ? null : envelope.failure,
      threw,
      hostError: hostErrorOf(envelope),
      settlement,
      settleError,
      cleanupUnresolved: envelope.cleanupUnresolved !== undefined,
    }
    sequence.attempts.push(record)
    const ended = settleError !== null ? `attempt ${number}'s settlement could not be recorded in the journal: ${settleError}` : attemptStop(record)
    sequence.stop = ended === null ? standing(`attempt ${number}`) : { reason: ended, after: `attempt ${number}` }
    if (sequence.stop !== null) break
  }
  if (sequence.stop !== null) {
    sequence.third = { asked: false, refusal: null, backendCalls: 0, why: "not asked: the pilot stopped, and nothing further is admitted" }
    return sequence
  }
  try {
    const decision = await input.admission.admit({ stage: "discover", slot: input.slot, attempt: PILOT_MAX_ATTEMPTS + 1 })
    if (decision.ok) {
      // Never sent: the backend is not called, and the admission is settled as never issued.
      await decision.settle({ kind: "not-issued" })
      sequence.third = { asked: true, refusal: null, backendCalls: 0, why: "the journal ADMITTED a third attempt; it was settled not-issued and never sent" }
      sequence.stop = { reason: "the journal admitted a third attempt, so the 2-attempt ceiling did not hold", after: `attempt ${PILOT_MAX_ATTEMPTS}` }
    } else {
      sequence.third = { asked: true, refusal: { cause: decision.cause, reason: decision.reason }, backendCalls: 0, why: "refused inside the journal's admission; the backend was not called" }
    }
  } catch (error) {
    sequence.third = { asked: true, refusal: null, backendCalls: 0, why: `the journal's third admission threw: ${messageOf(error)}` }
    sequence.stop = { reason: `the journal's third admission threw: ${messageOf(error)}`, after: `attempt ${PILOT_MAX_ATTEMPTS}` }
  }
  return sequence
}

// ---------------------------------------------------------------------------
// The evidence
// ---------------------------------------------------------------------------

/** The window label of a connection made before the first admission was asked: the Copilot startup boundary. */
export const BEFORE_FIRST_ASK = "before the first admission was asked"

export interface TimedConnect extends Omit<ProxyConnect, "at"> {
  /** Milliseconds after the pilot's body started, as `hostStartAtMs` is. */
  atMs: number
  /** Where it falls: before the first admission was asked, inside an attempt (from its admission being asked for to its settlement), between attempts, or after the last settlement. */
  window: string
  /** What the stop rule made of it. */
  stopRule: ConnectRule
}

/** Each proxy-observed CONNECT, timed against the sequence's first admission and the attempts' windows. */
export function timeConnects(connects: readonly ProxyConnect[], sequence: Pick<AttemptSequence, "attempts" | "firstAskedAt">, started: number): TimedConnect[] {
  const { attempts, firstAskedAt } = sequence
  return connects.map((entry) => {
    const inside = attempts.find((attempt) => entry.at >= attempt.askedAt && entry.at <= attempt.settledAt)
    const window =
      inside !== undefined
        ? `attempt ${inside.attempt}`
        : firstAskedAt === null || entry.at < firstAskedAt
          ? BEFORE_FIRST_ASK
          : attempts.length === 0 || entry.at > attempts[attempts.length - 1]!.settledAt
            ? "after the last settled line"
            : "between attempts"
    const { at, ...rest } = entry
    return { ...rest, atMs: at - started, window, stopRule: connectRule(entry, firstAskedAt) }
  })
}

/**
 * The proxy's whole log, checked once more after the host stopped, so a
 * connection that arrived after the sequence's last check still counts: any the
 * stop rule rejects, and any tunnelled connection outside an attempt's window.
 */
export function connectProblems(connects: readonly TimedConnect[]): string[] {
  const problems: string[] = []
  for (const entry of connects) {
    if (entry.stopRule === "stops") problems.push(`a proxy-observed CONNECT the stop rule rejects, at ${entry.atMs} ms (${entry.window}): \`${entry.line}\``)
    else if (entry.outcome === "tunnelled" && !entry.window.startsWith("attempt ")) problems.push(`a CONNECT was tunnelled outside every attempt, at ${entry.atMs} ms (${entry.window}): \`${entry.line}\``)
  }
  return problems
}

/** How a settlement reads in the evidence: host-reported tokens are labelled unverified. */
export function settlementRecord(settlement: AdmissionSettlement): Record<string, unknown> {
  if (settlement.kind === "usage") return { kind: "usage", hostReportedTokensUnverified: settlement.tokens }
  if (settlement.kind === "unknown") return { kind: "unknown", ...(settlement.abandoned === true ? { abandoned: true } : {}) }
  return { kind: settlement.kind }
}

const attemptRecord = (attempt: PilotAttempt, started: number): Record<string, unknown> => ({
  attempt: attempt.attempt,
  askedAtMs: attempt.askedAt - started,
  admittedAtMs: attempt.admittedAt - started,
  settledAtMs: attempt.settledAt - started,
  answered: attempt.answered,
  failure: attempt.failure,
  threw: attempt.threw,
  hostError: attempt.hostError,
  settlement: settlementRecord(attempt.settlement),
  settleError: attempt.settleError,
  cleanupUnresolved: attempt.cleanupUnresolved,
})

/** What every evidence file says about the gates, whatever it observed. */
export const GATE_EFFECT =
  "this command closes no gate: gate 7 stays OPEN and gate 8 is unchanged; either changes only by a reviewed, committed change to ablation/paired-gates.ts"

export interface PilotEvidence {
  kind: string
  story: "2-8c5"
  mode: PilotMode
  measuredAt: string
  paidTokens: string
  wording: string[]
  gateEffect: string
  /** The live run's reservation (`LIVE_RESERVATION`), which nothing deletes; a string in the dry run. */
  reservation: LiveReservation | string
  authorization: Authorization | string
  sandbox: SelfTest & { profile: string }
  host: HostIdentity | null
  hostStart: string
  /** When the host start began, in milliseconds after the pilot's body started (the self-test and any prepare step come first). */
  hostStartAtMs: number
  route: Record<string, unknown>
  journal: { root: string; seededAttempts: number; lines: (IssuedLine | SettledLine)[]; problems: string[] }
  attempts: Record<string, unknown>[]
  anyAttemptAnswered: boolean
  thirdAdmission: ThirdAdmission
  backendCalls: number
  stop: { reason: string; after: string } | null
  /** When the first admission was asked, in milliseconds after the pilot's body started; `null` when none was. */
  firstAskedAtMs: number | null
  proxy: { allowedToTunnel: readonly string[]; stopRuleAllows: readonly string[]; connects: TimedConnect[]; afterStop: string[] }
  sandboxDenials: SandboxDenials | string
  storeGuardAndSymlink: { beforeSpawn: string; hostStop: string; postStop: PostStopChecks | null }
  authTarget: { observed: string; flags: AuthTargetFlags } | string
  findings: { id: string; text: string }[]
  scope: string[]
}

export function findingsFrom(input: {
  mode: PilotMode
  attempts: readonly PilotAttempt[]
  connects: readonly TimedConnect[]
  third: ThirdAdmission
  stop: AttemptSequence["stop"]
  hostStarted: boolean
  denials: SandboxDenials | string
}): { id: string; text: string }[] {
  const findings: { id: string; text: string }[] = []
  const answered = input.attempts.filter((attempt) => attempt.answered)
  findings.push({
    id: "S1",
    text:
      `${input.attempts.length} attempt(s) admitted; ` +
      (answered.length === 0
        ? "none returned a model answer"
        : `${answered.length} returned a model answer (attempt ${answered.map((attempt) => attempt.attempt).join(", ")})`) +
      (input.attempts.length === 0 ? "" : `; journal settlements: ${input.attempts.map((attempt) => `attempt ${attempt.attempt} \`${attempt.settlement.kind}\``).join(", ")}`) +
      (input.stop === null ? "" : `; stopped after ${input.stop.after}: ${input.stop.reason}`),
  })
  const copilot = input.connects.filter((entry) => entry.target === COPILOT_TARGET)
  const excused = copilot.filter((entry) => entry.stopRule === "copilot-startup").length
  findings.push({
    id: "C1",
    text: !input.hostStarted
      ? "the Copilot startup question is unanswered: no host started"
      : `with \`enabled_providers: ["openai"]\`${input.mode === "dry" ? " and placeholder sign-ins for openai, anthropic and github-copilot" : ""}, ` +
        (copilot.length === 0
          ? `the proxy observed no CONNECT to ${COPILOT_TARGET} in this run`
          : `the proxy observed ${copilot.length} CONNECT(s) to ${COPILOT_TARGET}, the first at ${copilot[0]!.atMs} ms (${copilot[0]!.window}); ` +
            `${excused} ${BEFORE_FIRST_ASK}, refused and recorded as the expected startup event, which does not stop the pilot; ` +
            `${copilot.length - excused} after it, which stop the pilot`) +
        ". This is bounded to what this run's proxy observed: a connection that does not use the proxy is not seen by it; the sandbox denials are listed separately",
  })
  const targets = [...new Set(input.connects.map((entry) => `${entry.target ?? entry.line} (${entry.outcome})`))]
  findings.push({
    id: "E1",
    text:
      `proxy-observed CONNECTs: ${input.connects.length === 0 ? "none" : `${input.connects.length}, to ${targets.join(", ")}`}` +
      (typeof input.denials === "string"
        ? ""
        : input.denials.ok
          ? `; sandbox denials the unified log reported over the host's window: ${input.denials.entries.length}, each counted against the host's process tree ` +
            `(${input.denials.entries.filter((entry) => entry.namesHost).length} naming the host's own process)`
          : `; sandbox denials unavailable: ${input.denials.why}`) +
      ". Neither is a complete census of direct connections",
  })
  if (input.mode === "dry") {
    const exercised =
      input.attempts.length === 0
        ? "this dry run admitted no attempt"
        : `this dry run exercised ${input.attempts.map((attempt) => `attempt ${attempt.attempt} (${attempt.answered ? "answered" : "failed"})`).join(" and ")}`
    findings.push({
      id: "D1",
      text:
        `${exercised}. ` +
        (input.third.asked
          ? `The third admission was asked for: ${input.third.why}`
          : "The dry run cannot exercise the 2-attempt ceiling or the refused third admission: its proxy refuses every CONNECT, so its first " +
            "attempt always fails and stops the run. They are proven by the stand-in tests in `scripts/oauth-pilot.test.ts`, reported separately"),
    })
  }
  if (input.mode === "live") {
    const beforeFirst = input.connects.filter((entry) => entry.window === BEFORE_FIRST_ASK && entry.target !== null && PILOT_ALLOWED_CONNECTS.includes(entry.target))
    findings.push({
      id: "A1",
      text:
        `proxy-observed CONNECTs to an allowed host ${BEFORE_FIRST_ASK}: ${beforeFirst.length}; ` +
        `after the last settled line: ${input.connects.filter((entry) => entry.window === "after the last settled line").length}. ` +
        `The third admission: ${input.third.why}${input.third.refusal === null ? "" : ` (${input.third.refusal.cause}: ${input.third.refusal.reason})`}, backend calls ${input.third.backendCalls}`,
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// One authorization, one run
// ---------------------------------------------------------------------------

/** Where a committed live run's evidence lives, as `oauth-pilot-live-<date>.json`. */
export const LIVE_EVIDENCE_DIR = "ablation/evidence"
export const LIVE_EVIDENCE_PATTERN = /^oauth-pilot-live-.*\.json$/
/**
 * The one live run's reservation, relative to the repository. `--live` creates it
 * exclusively before it touches a host, the auth target, the data directory or the
 * network; while it exists, committed or not, every further `--live` refuses.
 * Nothing deletes it: a further run needs the human's explicit decision.
 */
export const LIVE_RESERVATION = `${LIVE_EVIDENCE_DIR}/oauth-pilot-live.reservation`

/**
 * Why gate 8's authorization does not cover this run, or none: the exposure
 * document differs from the one gate 8 pins; the live reservation, or a live run's
 * evidence, is committed or lies in the tree; the evidence directory cannot be
 * read; or `--out` already holds a pilot's evidence. Reads only the repository and
 * `--out`; never a host, the auth target or the network.
 */
export async function oneRunProblems(root: string, out: string, git: RunGit): Promise<string[]> {
  const problems: string[] = []
  const proposal = join(root, OAUTH_PILOT_PROPOSAL.path)
  try {
    const digest = new Bun.CryptoHasher("sha256").update(await readFile(proposal)).digest("hex")
    if (digest !== OAUTH_PILOT_PROPOSAL.sha256) {
      problems.push(`${OAUTH_PILOT_PROPOSAL.path} changed after gate 8 pinned it (sha256 ${digest}, pinned ${OAUTH_PILOT_PROPOSAL.sha256}); the exposure the budget owner authorized is not the one on disk`)
    }
  } catch (error) {
    problems.push(`${OAUTH_PILOT_PROPOSAL.path}, the exposure document gate 8 pins, could not be read: ${messageOf(error)}`)
  }
  try {
    const listed = await git(root, ["ls-tree", "--name-only", "HEAD", "--", `${LIVE_EVIDENCE_DIR}/`])
    if (listed.exitCode !== 0) {
      problems.push(`whether a live run's evidence is committed could not be established: \`git ls-tree\` exited ${listed.exitCode}: ${listed.stderr.trim() || "no detail"}`)
    } else {
      const names = listed.stdout.split("\n").map((path) => basename(path.trim()))
      const committed = names.filter((name) => LIVE_EVIDENCE_PATTERN.test(name))
      if (committed.length > 0) problems.push(`a live run's evidence is committed (${committed.join(", ")}): gate 8 authorizes one run, and it has run`)
      if (names.includes(basename(LIVE_RESERVATION))) problems.push(`the live reservation \`${LIVE_RESERVATION}\` is committed: gate 8 authorizes one run, and it was reserved`)
    }
  } catch (error) {
    problems.push(`whether a live run's evidence is committed could not be established: ${messageOf(error)}`)
  }
  let present: string[] = []
  try {
    present = await readdir(join(root, LIVE_EVIDENCE_DIR))
  } catch (error) {
    // A missing directory holds no evidence and no reservation; any other failure to read it refuses.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      problems.push(`${LIVE_EVIDENCE_DIR} could not be read (${messageOf(error)}), so an earlier live run or its reservation cannot be ruled out`)
    }
  }
  const uncommitted = present.filter((name) => LIVE_EVIDENCE_PATTERN.test(name))
  if (uncommitted.length > 0) problems.push(`a live run's evidence is in ${LIVE_EVIDENCE_DIR} (${uncommitted.join(", ")}): gate 8 authorizes one run, and it has run`)
  if (present.includes(basename(LIVE_RESERVATION))) {
    problems.push(`the live reservation \`${LIVE_RESERVATION}\` exists: an earlier \`--live\` reserved gate 8's one run, whether it succeeded, failed or was interrupted`)
  }
  for (const file of [EVIDENCE_FILE, PARTIAL_EVIDENCE_FILE]) {
    if (await lstat(join(out, file)).then(() => true, () => false)) problems.push(`--out already holds \`${file}\` from an earlier run`)
  }
  return problems
}

/** What the live reservation records. No secret: the gate table's blob, the pinned proposal and `--out`. */
export interface LiveReservation {
  story: "2-8c5"
  createdAt: string
  gateTableBlob: string | null
  proposalSha256: string
  out: string
}

/**
 * Creates `LIVE_RESERVATION` exclusively (`wx`: O_CREAT|O_EXCL), so of two
 * invocations only one can create it; the other is refused. Never removed.
 */
export async function reserveLiveRun(root: string, reservation: LiveReservation): Promise<{ ok: true; path: string } | { ok: false; why: string }> {
  const path = join(root, LIVE_RESERVATION)
  try {
    await mkdir(join(root, LIVE_EVIDENCE_DIR), { recursive: true })
    await writeFile(path, `${JSON.stringify(reservation, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
    return { ok: true, path }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return {
      ok: false,
      why:
        code === "EEXIST"
          ? `the live reservation \`${LIVE_RESERVATION}\` already exists: another \`--live\` reserved gate 8's one run first`
          : `the live reservation \`${LIVE_RESERVATION}\` could not be created (${messageOf(error)})`,
    }
  }
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

/** A host the pilot runs against: the real managed host, or a test's stand-in. */
export interface PilotHost extends Stoppable {
  url: string
  pid: number
  identity: HostIdentity
}

export interface HostRequest {
  mode: PilotMode
  route: OAuthRoute
  proxy: string
  scratchParent: string
  workDir: string
  onSpawn: (host: Stoppable) => void
}

/** The managed host's options in either mode: always spawned through `sandboxSpawn`, with the pilot's proxy as its only way out. */
export function pilotHostOptions(request: HostRequest, onSpawn: (host: Stoppable) => void): OAuthHostOptions {
  return {
    mode: "oauth",
    oauth: request.route,
    proxy: request.proxy,
    scratchParent: request.scratchParent,
    verifyDirectories: [request.workDir],
    signals: null,
    spawn: sandboxSpawn,
    onSpawn,
  }
}

/** The two ways the managed host starts; a test may put stand-ins in their place. */
export interface HostStarters {
  probePlaceholder: typeof startProbePlaceholderHost
  managed: typeof startManagedHost
}

/** Starts the real managed host, sandboxed: on the probe placeholder route when dry, through `startManagedHost` when live. */
export async function managedPilotHost(request: HostRequest, starters: HostStarters = { probePlaceholder: startProbePlaceholderHost, managed: startManagedHost }): Promise<PilotHost> {
  let spawned: Stoppable | undefined
  const options = pilotHostOptions(request, (host) => {
    spawned = host
    request.onSpawn(host)
  })
  const started: ManagedHostStart =
    request.mode === "dry"
      ? await starters.probePlaceholder(options, { kind: "probe-placeholder", scratch: request.scratchParent })
      : await starters.managed(options)
  if (!started.ok) {
    const unconfirmed = started.stopped !== null && !started.stopped.confirmed
    throw new HostRefused(
      `the managed host was refused: ${started.reason}` +
        (unconfirmed ? `; its exit is UNCONFIRMED (process ${started.stopped!.pid}): ${(started.stopped as { why: string }).why}` : "") +
        (started.stopped?.postStop !== undefined && started.stopped.postStop.problems.length > 0 ? `; after it exited: ${started.stopped.postStop.problems.join("; ")}` : ""),
      spawned !== undefined && !unconfirmed ? spawned : undefined,
      started.stopped?.postStop ?? null,
    )
  }
  const host = started.host
  return {
    url: host.url,
    pid: host.pid,
    stop: host.stop,
    identity: {
      binary: host.binary,
      sha256: host.sha256,
      version: host.version,
      measuredHost: { version: MEASURED_HOST.version, sha256: MEASURED_HOST.sha256 },
      matchesMeasuredHost: host.sha256 === MEASURED_HOST.sha256 && host.version === MEASURED_HOST.version,
      environmentKeys: host.environmentKeys,
      generatedConfig: host.config,
      // The host has verified it against the generated config. Live, it is not recorded: the real sign-ins may reach it.
      reportedConfig: request.mode === "dry" ? host.reportedConfig : "not recorded in the live run; the managed host verified it against `generatedConfig` before any client call",
      payload: host.oauth!.measured,
    },
  }
}

/** A refused host start: a preflight failure, which stops the pilot before any attempt. */
export class HostRefused extends Error {
  constructor(
    message: string,
    /** The spawned host whose exit was confirmed, to take off the live set. */
    readonly confirmed: Stoppable | undefined,
    readonly postStop: PostStopChecks | null,
  ) {
    super(message)
  }
}

/** What a test may put in place of the platform, the self-test, the prepare step, the gates, the proxy, the host, the backend and the log. */
export interface PilotHooks {
  platform?: string
  gates?: readonly PairedGate[]
  gateTable?: () => Promise<GateTableState>
  /** The repository the gate table, the exposure document and committed live evidence are read from. */
  repoRoot?: string
  selfTest?: () => Promise<SelfTest>
  prepare?: (out: string) => Promise<{ ok: boolean; problems?: string[] }>
  /** Starts the proxy; the default is `startAllowlistProxy`, with `PILOT_ALLOWED_CONNECTS` when live and nothing when dry. */
  startProxy?: (allowed: readonly string[]) => Pick<AllowlistProxy, "url" | "connects" | "stop">
  startHost?: (request: HostRequest) => Promise<PilotHost>
  backendFor?: (host: PilotHost, options: { directory: string; slots: RosterSlot[]; timeoutMs: number; tools: Record<string, boolean> }) => ModelBackend
  statAuthTarget?: (path: string) => Promise<AuthTargetStat>
  sandboxDenials?: (request: DenialRequest) => Promise<SandboxDenials>
}

/** What main hands the body, and what the body hands back for an interruption. */
export interface PilotContext {
  args: PilotArgs
  authorization: Authorization | null
  scratch: string[]
  live: Set<Stoppable>
  servers: { stop(): unknown }[]
  signal: AbortSignal
  /** The live run's reservation, as created; `null` in the dry run. */
  reservation: (LiveReservation & { path: string }) | null
  /** Set by the body once its journal is open: closes the journal and writes the partial evidence, once. main calls it on a signal or at the deadline. */
  interrupt: { partial?: (why: string) => Promise<void> }
}

export type PilotBody = (context: PilotContext) => Promise<number>

const pilotWith = (hooks: PilotHooks): PilotBody => async (context) => {
  const { args, authorization, scratch, live, servers, signal } = context
  const reservation: LiveReservation | string =
    context.reservation === null
      ? "none: the dry run makes no reservation"
      : { story: context.reservation.story, createdAt: context.reservation.createdAt, gateTableBlob: context.reservation.gateTableBlob, proposalSha256: context.reservation.proposalSha256, out: context.reservation.out }
  const { out, mode } = args
  const started = Date.now()
  const scratchParent = await realpath(await mkdtemp(join(tmpdir(), mode === "dry" ? PROBE_SCRATCH_PREFIX : PILOT_SCRATCH_PREFIX)))
  scratch.push(scratchParent)

  const selfTest = await (hooks.selfTest ?? sandboxSelfTest)()
  const selfTestEnded = Date.now()
  if (!selfTest.ok) {
    console.error(`REFUSED — the sandbox self-test failed: ${selfTest.why}. No host was started.`)
    return 1
  }
  console.log(`sandbox self-test: ${selfTest.why}`)

  const overlaps: [{ name: string; path: string }, { name: string; path: string }][] = [[{ name: "--out", path: out }, { name: "pilot's scratch directory", path: scratchParent }]]
  if (args.prepared !== undefined) overlaps.push([{ name: "prepared directory", path: args.prepared }, { name: "--out", path: out }])
  if (mode === "live") {
    overlaps.push([{ name: "OAuth data directory", path: args.dataDir! }, { name: "--out", path: out }])
    overlaps.push([{ name: "prepared directory", path: args.prepared! }, { name: "OAuth data directory", path: args.dataDir! }])
  }
  for (const [a, b] of overlaps) {
    const overlap = await overlapProblem(a, b)
    if (overlap !== null) {
      console.error(`REFUSED — ${overlap}. No host was started.`)
      return 1
    }
  }

  let prepared = args.prepared
  if (prepared === undefined) {
    prepared = join(scratchParent, "prepared")
    console.log(`building the prepared directory in ${prepared} (bun run oauth-prepare, unsandboxed, with network access for npm; no auth store attached)`)
    const built = await (hooks.prepare ?? ((dir: string) => prepareOAuthPayload(dir)))(prepared)
    if (!built.ok) {
      console.error(`REFUSED — the prepared directory could not be built: ${(built.problems ?? []).join("; ")}. No host was started.`)
      return 1
    }
  }

  const workDir = join(scratchParent, "work")
  await mkdir(workDir)
  let dataDir: string
  let home: string
  if (mode === "dry") {
    ;({ dataDir, home } = await writePlaceholders(join(scratchParent, PROBE_PLACEHOLDER_DIR, DRY_PLACEHOLDER)))
  } else {
    dataDir = args.dataDir!
    home = args.home
  }
  const authTargetPath = authLinkPaths(dataDir, home).target
  const route: OAuthRoute = { providers: PILOT_PROVIDERS, models: [PILOT_MODEL], dataDir, prepared, home }

  const journalRoot = join(out, "journal")
  await mkdir(journalRoot, { recursive: true })
  try {
    // `wx`: a journal already in --out is refused, never overwritten.
    await writeFile(join(journalRoot, JOURNAL_FILE), seededAttempts(PILOT_SEEDED).map((line) => `${JSON.stringify(line)}\n`).join(""), { encoding: "utf8", flag: "wx" })
  } catch (error) {
    console.error(`REFUSED — the journal \`${join(journalRoot, JOURNAL_FILE)}\` could not be created fresh (${messageOf(error)}); an existing journal is never overwritten. No host was started.`)
    return 1
  }

  const allowed = mode === "live" ? PILOT_ALLOWED_CONNECTS : []
  const proxy = (hooks.startProxy ?? startAllowlistProxy)(allowed)
  servers.push(proxy)
  console.log(
    `MAD OAuth pilot — story 2-8c5 — ${mode === "dry" ? "DRY RUN (sandboxed, placeholder sign-ins, every CONNECT refused)" : "LIVE (sandboxed; the proxy is the only way out)"}\n` +
      `proxy ${proxy.url} (tunnels ${allowed.length === 0 ? "nothing" : allowed.join(", ")}); out ${out}`,
  )

  const statTarget = hooks.statAuthTarget ?? statAuthTarget
  const before = await statTarget(authTargetPath)

  const clock = { now: () => new Date().toISOString() }
  const taken = await acquireLock(journalRoot, clock.now())
  if (!taken.ok) throw new Error(taken.reason)
  const opened = await openJournal(journalRoot, taken.lock, clock.now, undefined, "attempts")
  if (!opened.ok) {
    await taken.lock.release()
    throw new Error(opened.reason)
  }
  const journal = opened.journal
  const runId = `oauth-pilot-${mode}`
  const redactions = (): (readonly [string, string])[] => [
    [scratchParent, "<scratch>"],
    [out, "<out>"],
    [prepared, "<prepared>"],
    ...(mode === "live" ? [[dataDir, "<data-dir>"] as const] : []),
    [args.home, "<home>"],
  ]

  let host: PilotHost | undefined
  let hostStart = ""
  let hostStop = "no host was started"
  let postStop: PostStopChecks | null = null
  let hostStopAt = 0
  const sequence = emptySequence()
  const hostStartAt = Date.now()

  let closing: Promise<unknown> | undefined
  const closeJournal = () => (closing ??= journal.close().then((closed) => {
    if (closed.releaseError !== null) console.error(`warning: ${closed.releaseError}`)
  }))
  let partial: Promise<void> | undefined
  const writePartial = (why: string): Promise<void> =>
    (partial ??= (async () => {
      let reason = why
      try {
        await closeJournal()
      } catch (error) {
        reason += `; the journal did not close: ${messageOf(error)}`
      }
      const { lines } = await journalLines(journalRoot).catch(() => ({ lines: [] as unknown[] }))
      const evidence = {
        kind: `INCOMPLETE — ${EVIDENCE_KIND[mode]}`,
        status: "INCOMPLETE",
        incomplete: reason,
        story: "2-8c5",
        mode,
        measuredAt: new Date().toISOString(),
        wording: EVIDENCE_WORDING,
        gateEffect: GATE_EFFECT,
        reservation,
        hostStart,
        hostStartAtMs: hostStartAt - started,
        journal: { root: journalRoot, lines },
        attempts: sequence.attempts.map((attempt) => attemptRecord(attempt, started)),
        backendCalls: sequence.backendCalls,
        stop: sequence.stop,
        firstAskedAtMs: sequence.firstAskedAt === null ? null : sequence.firstAskedAt - started,
        proxy: { allowedToTunnel: allowed, connects: timeConnects(proxy.connects(), sequence, started) },
      }
      await writeFile(join(out, PARTIAL_EVIDENCE_FILE), `${redactPaths(JSON.stringify(evidence, null, 2), redactions())}\n`, "utf8")
      console.error(`INCOMPLETE — ${reason}. Partial evidence: ${join(out, PARTIAL_EVIDENCE_FILE)}`)
    })())
  context.interrupt.partial = writePartial

  let failure: string | undefined
  try {
    try {
      host = await (hooks.startHost ?? managedPilotHost)({ mode, route, proxy: proxy.url, scratchParent, workDir, onSpawn: (spawned) => live.add(spawned) })
      hostStart = `process ${host.pid} started and verified`
    } catch (error) {
      if (!(error instanceof HostRefused)) throw error
      if (error.confirmed !== undefined) for (const entry of live) if (entry.stop === error.confirmed.stop) live.delete(entry)
      hostStart = error.message
      postStop = error.postStop
      sequence.stop = { reason: `a preflight failure: ${error.message}`, after: "the host start" }
      sequence.third = { ...sequence.third, why: "not asked: the pilot stopped, and nothing further is admitted" }
    }
    if (host !== undefined) {
      const roster = selectRoster([{ ...PILOT_MODEL, toolcall: true }], { slots: 1, providerConfigKey: "provider" }).roster
      const slot = roster.slots[0]!.slot
      const options = { directory: workDir, slots: roster.slots, timeoutMs: PILOT_TURN_TIMEOUT_MS, tools: { ...PILOT_TOOLS } }
      const backend = (hooks.backendFor ?? ((pilotHost, given) => new OpencodeModelBackend({ serverUrl: pilotHost.url, ...given })))(host, options)
      await runAttempts({
        admission: journal.admission({ block: 1, phase: "prefix", runId: () => runId }),
        backend,
        slot,
        signal,
        connects: () => proxy.connects(),
        latched: () => {
          const bill = journal.bill()
          return bill.stop ?? bill.halt
        },
        progress: sequence,
      })
      const outcome = await host.stop()
      hostStopAt = Date.now()
      if (!outcome.confirmed) throw new Error(`the managed host's exit is UNCONFIRMED: check process ${outcome.pid} by hand (${outcome.why})`)
      for (const entry of live) if (entry.stop === host.stop) live.delete(entry)
      hostStop = `process ${outcome.pid} ${outcome.how}`
      postStop = outcome.postStop ?? null
    }
  } catch (error) {
    failure = messageOf(error)
  }
  if (failure === undefined) {
    try {
      await closeJournal()
    } catch (error) {
      failure = `the journal did not close: ${messageOf(error)}`
    }
  }
  if (failure !== undefined || signal.aborted) {
    await writePartial(failure ?? "the pilot was aborted: its deadline passed or it was interrupted")
    return 1
  }
  const after = await statTarget(authTargetPath)
  const denials: SandboxDenials | string =
    host === undefined
      ? "not read: no host started"
      : await (hooks.sandboxDenials ?? readSandboxDenials)({ since: hostStartAt, until: hostStopAt, floor: selfTestEnded, hostPid: host.pid, started })

  const { lines, problems: journalProblems } = await journalLines(journalRoot)
  const own = lines.filter((line): line is IssuedLine => line.type === "issued" && line.runId === runId)
  const ownIds = new Set(own.map((line) => line.physicalId))
  const ownLines = lines.filter((line): line is IssuedLine | SettledLine => (line.type === "issued" || line.type === "settled") && ownIds.has(line.physicalId))
  const connects = timeConnects(proxy.connects(), sequence, started)
  const afterStop = connectProblems(connects)
  const anyAttemptAnswered = sequence.attempts.some((attempt) => attempt.answered)
  const evidence: PilotEvidence = {
    kind: EVIDENCE_KIND[mode],
    story: "2-8c5",
    mode,
    measuredAt: new Date().toISOString(),
    paidTokens:
      mode === "dry"
        ? "none. The host ran inside a sandbox that denied all outbound traffic but loopback, behind a proxy that refused every " +
          "CONNECT, on placeholder sign-ins. No request reached a provider."
        : "unmeasured. The attempts drew on the ChatGPT subscription through its OAuth sign-in; MAD charges nothing per token " +
          "and cannot see or bound the quota used. Host-reported tokens below are unverified diagnostics.",
    wording: EVIDENCE_WORDING,
    gateEffect: GATE_EFFECT,
    reservation,
    authorization: authorization ?? "not consulted: the dry run bills nothing and uses no real sign-in",
    sandbox: { ...selfTest, profile: SANDBOX_PROFILE, control: `unsandboxed TCP connect to ${CONTROL_TARGET.hostname}:${CONTROL_TARGET.port}, no byte sent: ${selfTest.control}` },
    host: host?.identity ?? null,
    hostStart,
    hostStartAtMs: hostStartAt - started,
    route: {
      enabled_providers: PILOT_PROVIDERS,
      model: `${PILOT_MODEL.providerId}/${PILOT_MODEL.modelId}`,
      small_model: `${PILOT_MODEL.providerId}/${PILOT_MODEL.modelId}`,
      prompt: PILOT_PROMPT,
      tools: PILOT_TOOLS,
      turnTimeoutMs: PILOT_TURN_TIMEOUT_MS,
      maxAdmittedAttempts: PILOT_MAX_ATTEMPTS,
      dataDir: mode === "dry" ? "a fresh probe-owned placeholder data directory" : "<data-dir>",
    },
    journal: {
      root: journalRoot,
      seededAttempts: PILOT_SEEDED,
      lines: ownLines,
      problems: journalProblems,
    },
    attempts: sequence.attempts.map((attempt) => attemptRecord(attempt, started)),
    anyAttemptAnswered,
    thirdAdmission: sequence.third,
    backendCalls: sequence.backendCalls,
    stop: sequence.stop,
    firstAskedAtMs: sequence.firstAskedAt === null ? null : sequence.firstAskedAt - started,
    proxy: { allowedToTunnel: allowed, stopRuleAllows: PILOT_ALLOWED_CONNECTS, connects, afterStop },
    sandboxDenials: denials,
    storeGuardAndSymlink: {
      beforeSpawn:
        host === undefined
          ? "the host was not started; see `hostStart`"
          : "held: the managed host spawns only after the payload digests, the auth symlink, the data directory's shape and disjointness and the store guard pass",
      hostStop,
      postStop,
    },
    authTarget: { observed: mode === "dry" ? "the placeholder target only, by lstat and stat; never opened" : "<home>/.local/share/opencode/auth.json by lstat and stat; never opened", flags: authTargetFlags(before, after) },
    findings: findingsFrom({ mode, attempts: sequence.attempts, connects, third: sequence.third, stop: sequence.stop, hostStarted: host !== undefined, denials }),
    scope: [
      `one run, on this machine${host === undefined ? "" : `, opencode ${host.identity.version} (binary sha256 ${host.identity.sha256})`}; not every host, build, account or failure`,
      mode === "dry"
        ? "placeholder sign-ins: no token was refreshed and no provider was reached; the dry run shows the attempt sequence as far as it ran, the stop rules it met and what the proxy and the sandbox saw, not OpenAI's transport"
        : "a change in the auth target's metadata shows file activity during the live interval, not necessarily a refresh caused by the host; unchanged metadata proves neither that no write happened nor where a refresh went",
      "an admitted attempt bounds neither the physical requests the host sends nor subscription quota",
    ],
  }
  if (signal.aborted) {
    // Never the full evidence once aborted: main may already have given the run up.
    await writePartial("the pilot was aborted: its deadline passed or it was interrupted")
    return 1
  }
  const problems = [...(postStop?.problems ?? []), ...journalProblems]
  if (host === undefined) problems.push(`the host did not start: ${hostStart}`)
  if (typeof denials !== "string") {
    if (denials.ok && denials.entries.length > 0) {
      problems.push(`the unified log reported ${denials.entries.length} sandbox denial(s) over the host's window, counted against the host's process tree: a connection went around the proxy`)
    }
    if (!denials.ok && mode === "live") problems.push(`the sandbox denials could not be read (${denials.why}), so a connection around the proxy cannot be ruled out`)
  }
  if (mode === "dry") {
    if (anyAttemptAnswered) problems.push("an attempt returned a model answer in the dry run")
    const tunnelled = connects.filter((entry) => entry.outcome !== "refused")
    if (tunnelled.length > 0) problems.push(`${tunnelled.length} connection(s) were not refused in the dry run`)
  } else {
    if (sequence.stop !== null) problems.push(`the pilot stopped after ${sequence.stop.after}: ${sequence.stop.reason}`)
    if (sequence.attempts.length !== PILOT_MAX_ATTEMPTS || !sequence.attempts.every((attempt) => attempt.answered && attempt.settlement.kind === "usage")) {
      problems.push(`${sequence.attempts.length} attempt(s) ran; both must answer and settle \`usage\``)
    }
    if (sequence.third.refusal === null || sequence.third.backendCalls !== 0) problems.push(`the third admission: ${sequence.third.why}`)
    problems.push(...afterStop)
  }
  // `oauth-pilot.json` is written only for a run that exits 0; a failed one gets the same diagnostics as INCOMPLETE.
  const failed = problems.length > 0
  const written = failed ? join(out, PARTIAL_EVIDENCE_FILE) : join(out, EVIDENCE_FILE)
  const document = failed ? failedEvidence(evidence, problems) : evidence
  if (failed) partial = Promise.resolve()
  await writeFile(written, `${redactPaths(JSON.stringify(document, null, 2), redactions())}\n`, "utf8")
  console.log(
    `\nEvidence${failed ? " (INCOMPLETE: the run failed)" : ""}: ${written}\n` +
      evidence.findings.map((finding) => `  ${finding.id}: ${finding.text}`).join("\n") +
      "\nEvery connection listed is a proxy-observed CONNECT, never all egress. Exit 0 closes no gate.",
  )
  if (failed) {
    console.error(`\nNOT AS EXPECTED — ${problems.join("; ")}`)
    return 1
  }
  return 0
}

/** A failed run's full diagnostics, labelled INCOMPLETE with a failure status: what `oauth-pilot.INCOMPLETE.json` holds when the run completed but exits 1. */
export function failedEvidence<T extends { kind: string }>(evidence: T, failures: readonly string[]): T & { status: "FAILED"; incomplete: string; failures: string[] } {
  return { ...evidence, kind: `INCOMPLETE — ${evidence.kind}`, status: "FAILED", incomplete: failures.join("; "), failures: [...failures] }
}

/**
 * Moves a written `oauth-pilot.json` to `oauth-pilot.INCOMPLETE.json` with a failure
 * status, when the run fails after the body wrote it: a cleanup failure, or a
 * signal. Its content replaces any partial evidence there, being the fuller of the
 * two. Whether a file was demoted.
 */
async function demoteEvidence(out: string, failures: readonly string[], extra: Record<string, unknown> = {}): Promise<boolean> {
  const full = join(out, EVIDENCE_FILE)
  const text = await readFile(full, "utf8").catch(() => null)
  if (text === null) return false
  await writeFile(join(out, PARTIAL_EVIDENCE_FILE), `${JSON.stringify({ ...failedEvidence(JSON.parse(text) as { kind: string }, failures), ...extra }, null, 2)}\n`, "utf8")
  await rm(full, { force: true })
  return true
}

/** Test-only: a shorter deadline, a fake body, hooks into the real one, and the home. */
export interface PilotSeams extends PilotHooks {
  deadlineMs?: number
  settleMs?: number
  /** How long an interruption may take to close the journal and write the partial evidence. */
  interruptMs?: number
  body?: PilotBody
  scratchRoot?: string
  home?: string
  /** Git for the gate table and the one-run checks; the default is the preflight's bounded git. */
  git?: RunGit
  /** How an interrupted run exits; the default is `process.exit`. */
  exit?: (code: number) => void
}

export const INTERRUPT_MS = 15_000

function defaultGit(): RunGit {
  return boundedGit({ spawn: preflightSpawn, deadlineMs: PREFLIGHT_GIT_DEADLINE_MS, cleanupMs: PREFLIGHT_GIT_CLEANUP_MS })
}

export async function main(argv: readonly string[] = Bun.argv, seams: PilotSeams = {}): Promise<number> {
  const parsed = parsePilotArgs(argv, seams.home)
  if (!parsed.ok) {
    console.error(parsed.reason)
    return 1
  }
  const args = parsed.args
  let authorization: Authorization | null = null
  if (args.mode === "live") {
    const root = seams.repoRoot ?? REPO_ROOT
    const git = seams.git ?? defaultGit()
    // The first live operation: nothing below runs unless gate 8 is CLOSED in the committed table, for this one run.
    authorization = await authorize(seams.gates ?? PAIRED_GATES, seams.gateTable ?? (() => gateTableState(git, root)))
    if (authorization.ok) {
      const once = await oneRunProblems(root, args.out, git)
      if (once.length > 0) authorization = { ...authorization, ok: false, problems: once }
    }
    if (!authorization.ok) {
      console.error(
        [
          "REFUSED — the live OAuth pilot is not authorized.",
          ...authorization.lines.map((line) => `  ${line}`),
          ...authorization.problems.map((problem) => `REFUSED: ${problem}`),
          "Gate 8 closes only by a reviewed, committed change to ablation/paired-gates.ts, for one run; no flag, variable or file can close it.",
          "No host was started; the real auth target was not stat-ed; the data directory was not opened; no network connection was made.",
        ].join("\n"),
      )
      return 1
    }
  }
  const platform = seams.platform ?? process.platform
  if (platform !== "darwin") {
    console.error(`REFUSED — the pilot runs only on macOS, whose sandbox-exec is its egress control; this platform is ${platform}. No host was started.`)
    return 1
  }
  const refused = await outProblem(args.out, seams.scratchRoot)
  if (refused !== null) {
    console.error(refused)
    return 1
  }
  await mkdir(args.out, { recursive: true })
  let reservation: PilotContext["reservation"] = null
  if (args.mode === "live") {
    // After every refusal that needs no touch, and before any host, auth-target stat, data-directory open or connection.
    const created: LiveReservation = {
      story: "2-8c5",
      createdAt: new Date().toISOString(),
      gateTableBlob: authorization?.blob ?? null,
      proposalSha256: OAUTH_PILOT_PROPOSAL.sha256,
      out: args.out,
    }
    const reserved = await reserveLiveRun(seams.repoRoot ?? REPO_ROOT, created)
    if (!reserved.ok) {
      console.error(`REFUSED: ${reserved.why}. No host was started; the real auth target was not stat-ed; the data directory was not opened; no network connection was made.`)
      return 1
    }
    reservation = { ...created, path: reserved.path }
    console.log(`reserved gate 8's one live run: ${reserved.path} (never deleted; a further run needs the human's explicit decision)`)
  }
  const deadlineMs = seams.deadlineMs ?? PILOT_DEADLINE_MS
  const settleMs = seams.settleMs ?? BODY_SETTLE_MS
  const interruptMs = seams.interruptMs ?? INTERRUPT_MS
  const scratch: string[] = []
  const live = new Set<Stoppable>()
  const servers: { stop(): unknown }[] = []
  const controller = new AbortController()
  const interrupt: PilotContext["interrupt"] = {}
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
  /** Closes the journal and writes the partial evidence, within `interruptMs`; a failure is printed, never thrown. */
  const writePartial = async (why: string): Promise<void> => {
    if (interrupt.partial === undefined) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const written = await Promise.race([
      interrupt.partial(why).then(
        () => "written",
        (error: unknown) => `failed: ${messageOf(error)}`,
      ),
      new Promise<string>((done) => {
        timer = setTimeout(() => done(`not finished within ${interruptMs} ms`), interruptMs)
      }),
    ])
    clearTimeout(timer)
    if (written !== "written") console.error(`the partial evidence was not written: ${written}`)
  }
  let signalled: Promise<void> | undefined
  /**
   * A signal: the run ends 130, so no `oauth-pilot.json` may remain. One INCOMPLETE
   * file results: a full evidence file the body already wrote is demoted into it
   * (the fuller content, status FAILED, naming the signal); otherwise the partial
   * evidence is written. The check repeats after cleanup, for a body that finished
   * writing meanwhile.
   */
  const onSignal = (name: string) => {
    controller.abort()
    const demote = () => demoteEvidence(args.out, [`interrupted by ${name} after oauth-pilot.json was written; the run did not exit 0`], { interruptedBy: name })
    signalled ??= (async () => {
      if (!(await demote())) await writePartial(`interrupted by ${name}`)
      const problems = await cleanup()
      await demote()
      for (const problem of problems) console.error(problem)
      console.error("\nINTERRUPTED — the pilot stopped; nothing above is a complete measurement.")
      ;(seams.exit ?? process.exit)(130)
    })()
  }
  /** The exit code, unless a signal arrived: then its handler finishes first, and the run ends 130. */
  const finish = async (code: number): Promise<number> => {
    if (signalled === undefined) return code
    await signalled
    return 130
  }
  const onSigint = () => onSignal("SIGINT")
  const onSigterm = () => onSignal("SIGTERM")
  process.on("SIGINT", onSigint)
  process.on("SIGTERM", onSigterm)
  let timer: ReturnType<typeof setTimeout> | undefined
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  try {
    const context: PilotContext = { args, authorization, scratch, live, servers, signal: controller.signal, reservation, interrupt }
    const body = (seams.body ?? pilotWith(seams))(context).then(
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
      await writePartial(`the pilot did not finish within ${deadlineMs} ms`)
    }
    const problems = await cleanup()
    for (const problem of problems) console.error(problem)
    if (bounded === "timed-out") {
      await rm(join(args.out, EVIDENCE_FILE), { force: true }).catch(() => undefined)
      console.error(`the pilot did not finish within ${deadlineMs} ms. NOTHING ABOVE IS A COMPLETE MEASUREMENT.`)
      return await finish(1)
    }
    if ("failed" in bounded) {
      await writePartial(`the pilot failed: ${bounded.failed}`)
      console.error(`the pilot failed: ${bounded.failed}. Nothing above is a complete measurement.`)
      return await finish(1)
    }
    if (problems.length > 0 && bounded.code === 0) await demoteEvidence(args.out, problems.map((problem) => `after the run: ${problem}`))
    return await finish(problems.length > 0 ? 1 : bounded.code)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (settleTimer !== undefined) clearTimeout(settleTimer)
    process.off("SIGINT", onSigint)
    process.off("SIGTERM", onSigterm)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

if (import.meta.main) process.exit(await main())
