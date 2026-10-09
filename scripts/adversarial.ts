#!/usr/bin/env bun
/**
 * Story 2-7f — the OAuth adversarial launcher.
 *
 *   bun run adversarial --live --provider-mode oauth \
 *     --oauth-provider anthropic --pin anthropic/<model> \
 *     --oauth-prepared /scratch/mad-oauth-prepared \
 *     --oauth-data-root /scratch/mad-adversarial-data --out /scratch/mad-adversarial-2026-10-20
 *
 * It runs protocol v3's sixteen adversarial runs (`runAdversarialSuite`,
 * `ablation/adversarial.ts`) on the OAuth route, each run on a managed host and
 * an OAuth data directory of its own (v3 B9), in this order:
 *
 * 1. **Offline checks.** Flags, containment, the frozen protocol v3, the
 *    committed gate table, `gatePreflight(gates, "adversarial", "oauth")`, the
 *    OAuth route and the prepared digests, the authorized run (the pin is
 *    `ADVERSARIAL_RUN.pins`, its reservation exists neither on disk nor at HEAD,
 *    every earlier run is committed) and the production Tools identity. Every
 *    check prints, and a failure refuses before anything is written: no
 *    reservation, worktree, start marker or host. With the shipped table this
 *    stage always refuses (gates 10 and 11 OPEN, `pins: null`, v3 a draft).
 * 2. **The reservation**, created exclusively only once every check passed.
 * 3. **The schedule**: immediately before the experiment root and the data
 *    root are created, each is checked again to be outside this repository and
 *    not to contain it, and to be absent or empty, and the data root, `--out`,
 *    the prepared directory and the user's own opencode store are checked again
 *    to be disjoint (`rootRecheckProblems`). A failure, or a check that cannot be
 *    made, refuses with the reservation spent and no root created. These checks
 *    narrow, and do not remove, the window before the `mkdir`. Then the
 *    one-slot roster is built from the pin, and the schedule is sealed for
 *    attempts on the oauth route, declaring the host offer
 *    (`ADVERSARIAL_HOST_TOOLS`) and `hostIsolation: "fresh-per-run"`.
 * 4. **The suite.** `runAdversarialSuite` writes all sixteen worktrees, then for
 *    each run in schedule order the lifecycle here creates
 *    `<data-root>/run-<position>/opencode` holding only the `auth.json` symlink
 *    (never read, never reused), starts a managed host that verifies that run's
 *    worktree, checks within the host request deadline that the host resolves
 *    the sealed roster, hands the run a backend offered the sealed config's
 *    `hostTools` (`ADVERSARIAL_HOST_TOOLS`) only, and stops the host. A
 *    spawned host's stop must be confirmed and its post-stop checks present with
 *    no problem; anything else stops the runner, and no further host starts.
 *
 * ## The host record
 *
 * `<out>/adversarial/adversarial-hosts.jsonl` gets one line per start, verify,
 * stop and post-stop outcome, each with the schedule hash, the slot and its
 * position, so host starts outside the attempt count are disclosed. A line that
 * cannot be appended stops the runner: the current host is stopped, nothing
 * further starts, the exit is 1, and the record that could not be persisted is
 * named. No complete disclosure is claimed after that.
 *
 * ## Signals
 *
 * SIGINT and SIGTERM are the launcher's from the first line to the last. During
 * the suite they abort the run through its signal and stop the current host;
 * the suite then records every remaining slot and writes its bill before the
 * launcher exits 1. The managed host is started with `signals: null`, so its own
 * handler never exits first. An interrupt before the suite exits 130.
 *
 * ## What it never does
 *
 * It refuses `api-key`, `--server`, `--target` and `--directory` at parse. It
 * never reads a credential: the auth link is created by `symlink` and checked
 * by the host's own `lstat`/`readlink` checks. It never reads a change through
 * the host shell's Repo port: every run's change is the sealed material.
 *
 * Exit codes: 0 when the suite reads `complete: true`, every host stopped with
 * its checks held and every host record was persisted; 1 otherwise; 130 for an
 * interrupt before the suite.
 */

import { $ } from "bun"
import { lstat, mkdir, open, readdir, symlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

import type { SpawnBlame } from "../adapters/opencode/blame-exec.ts"
import { OpencodeModelBackend, type OpencodeBackendOptions } from "../adapters/opencode/model-backend.ts"
import { enumerateCandidates, OPENCODE_PROVIDER_CONFIG_KEY } from "../adapters/opencode/roster.ts"
import { runAdversarialSuite, type AdversarialHostLifecycle, type AdversarialHostStart, type AdversarialHostStop, type AdversarialRunContext } from "../ablation/adversarial.ts"
import type { RunGit as MaterializeGit } from "../ablation/adversarial-materialize.ts"
import { ADVERSARIAL_HOST_OFFER, adversarialDirectory, createAdversarialSchedule, FRESH_PER_RUN, type AdversarialConfig } from "../ablation/adversarial-schedule.ts"
import { codeRevisionFrom } from "../ablation/bundle.ts"
import {
  OAUTH_PAYLOAD,
  oauthRouteProblems,
  startManagedHost,
  type ManagedHost,
  type ManagedHostOptions,
  type ManagedHostStart,
  type OAuthRoute,
  type StopOutcome,
} from "../ablation/managed-host.ts"
import { unknownValue, type CodeRevision, type Maybe } from "../ablation/manifest.ts"
import { authLinkPaths, overlapProblem, verifyPrepared, type PayloadPins } from "../ablation/oauth-payload.ts"
import { ADVERSARIAL_RUN, gatePreflight, PAIRED_GATES, type AdversarialRun, type PairedGate } from "../ablation/paired-gates.ts"
import { canonicalJson, readFrozenProtocol, type CoinFace } from "../ablation/schedule.ts"
import type { Candidate, Roster } from "../core/domain/roster.ts"
import { systemClock, type Clock } from "../core/ports/clock.ts"
import type { LateUsageReporter } from "../core/ports/late-usage.ts"
import type { ModelBackend } from "../core/ports/model-backend.ts"
import { selectRoster, type Pin, type SelectResult } from "../core/roster/select.ts"
import {
  boundedGit,
  contained,
  fail,
  failureReason,
  GATE_TABLE_FILE,
  gatesIdentity,
  gateTableState,
  guarded,
  matchesFlag,
  notEvaluated,
  PAIRED_HOST_REQUEST_MS,
  parsePin,
  pass,
  PREFLIGHT_GIT_CLEANUP_MS,
  PREFLIGHT_GIT_DEADLINE_MS,
  preflightSpawn,
  presence,
  printCheck,
  productionTools,
  REPO_ROOT,
  toolsIdentity,
  toolsWiringProblem,
  valueFlag,
  type Check,
  type GateTableState,
  type SignalSource,
  type ToolsFactory,
  type ToolsWiring,
} from "./paired.ts"

/** The protocol the suite seals under on the OAuth route: attempt accounting for the suite is defined only by v3. */
export const PROTOCOL_V3_FILE = join(REPO_ROOT, "_bmad-output/specs/spec-mad-orchestrator/evaluation-protocol-v3.md")

/**
 * Protocol v3 B8 — the host tools every adversarial turn is offered:
 * `StructuredOutput` only, as opencode's per-call allowlist. The wildcard keeps
 * every other tool name, including one a later host build adds, away from a
 * turn; an empty offer would keep the host's defaults. MAD's own Tools and
 * blame path is injected through `opencodeTools`, independently of this offer.
 */
export const ADVERSARIAL_HOST_TOOLS: Readonly<Record<string, boolean>> = ADVERSARIAL_HOST_OFFER

/** The host record, under `<out>/adversarial/`. */
export const ADVERSARIAL_HOSTS_FILE = "adversarial-hosts.jsonl"

// ---------------------------------------------------------------------------
// The authorized run
// ---------------------------------------------------------------------------

/** Where the adversarial run's reservation lives and whether HEAD holds a file. The shipped values are this repository and `git ls-tree HEAD`. */
export interface AdversarialReservationSeam {
  root: string
  committed: (relative: string) => Promise<boolean>
}

/** What the adversarial run's reservation records. No secret: the run, the gate table's blob, the pin and the two roots. */
export interface AdversarialReservation {
  run: number
  story: "2-7f"
  createdAt: string
  gateTableBlob: string
  pins: string[]
  out: string
  dataRoot: string
}

/**
 * Stage 1's check of the run gate 10 covers: the pin is exactly `run.pins`; its
 * reservation exists neither on disk (ignored or untracked included) nor at
 * HEAD; and every earlier run's reservation and evidence are committed at HEAD.
 * Reads only the repository.
 */
export async function adversarialRunProblems(pins: readonly string[], seam: AdversarialReservationSeam, run: AdversarialRun = ADVERSARIAL_RUN): Promise<string[]> {
  const problems: string[] = []
  if (run.pins === null) {
    problems.push(`\`ADVERSARIAL_RUN.pins\` is null (not yet chosen), so no --pin is the authorized roster of adversarial run ${run.run}`)
  } else if (pins.length !== run.pins.length || pins.some((pin, index) => pin !== run.pins![index])) {
    problems.push(
      `the --pin ${pins.length === 0 ? "(none)" : pins.join(", ")} is not the roster adversarial run ${run.run} names: ` +
        `${run.pins.join(", ")} (the first pin is also small_model)`,
    )
  }
  const used = `adversarial run ${run.run}'s one authorization was already used, whether it succeeded, failed or was interrupted`
  const present = await presence(join(seam.root, run.reservation))
  if (present === "present") problems.push(`the reservation \`${run.reservation}\` already exists: ${used}`)
  else if (present !== "absent") problems.push(present)
  try {
    if (await seam.committed(run.reservation)) problems.push(`the reservation \`${run.reservation}\` is committed at HEAD: ${used}`)
  } catch (error) {
    problems.push(`whether the reservation \`${run.reservation}\` is committed could not be established: ${messageOf(error)}`)
  }
  for (const prior of run.prior) {
    for (const [what, path] of [["reservation", prior.reservation], ["evidence", prior.evidence]] as const) {
      try {
        if (!(await seam.committed(path))) {
          problems.push(`run ${prior.run}'s ${what} \`${path}\` is not committed at HEAD: an earlier run must stay on record before run ${run.run} is reserved`)
        }
      } catch (error) {
        problems.push(`whether run ${prior.run}'s ${what} \`${path}\` is committed could not be established: ${messageOf(error)}`)
      }
    }
  }
  return problems
}

/** Creates the run's reservation exclusively (`wx`), so of two invocations only one can; never removed. */
export async function reserveAdversarialRun(
  root: string,
  reservation: AdversarialReservation,
  run: AdversarialRun = ADVERSARIAL_RUN,
): Promise<{ ok: true; path: string } | { ok: false; why: string }> {
  const path = join(root, run.reservation)
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(reservation, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
    return { ok: true, path }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return {
      ok: false,
      why:
        code === "EEXIST"
          ? `the reservation \`${run.reservation}\` already exists: another invocation reserved adversarial run ${run.run} first`
          : `the reservation \`${run.reservation}\` could not be created (${messageOf(error)})`,
    }
  }
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set(["pin", "out", "provider-mode", "oauth-provider", "oauth-prepared", "oauth-data-root"])
/** Flags another launcher takes, refused here by name. */
const REFUSED_FLAGS: Readonly<Record<string, string>> = {
  server:
    "--server is refused: each run gets a managed host the launcher starts itself (ablation/managed-host.ts), and a host it did not start is never trusted",
  target: "--target is refused: every run reviews the sealed adversarial material, never a ref range",
  directory: "--directory is refused: every run's worktree is written by the suite from the sealed material, under --out",
  "provider-url": "--provider-url belongs to the api-key route; the adversarial suite runs on opencode's own sign-ins and takes no credential",
  "provider-key-env": "--provider-key-env belongs to the api-key route; the adversarial suite runs on opencode's own sign-ins and takes no credential",
  "provider-model": "--provider-model belongs to the api-key route; the adversarial suite runs on opencode's own sign-ins and takes no credential",
  "oauth-data-dir": "--oauth-data-dir is the paired launcher's; this command takes --oauth-data-root and makes a fresh data directory per run under it",
}

export interface AdversarialFlags {
  problems: string[]
  provider?: string
  pin?: Pin
  prepared?: string
  out?: string
  dataRoot?: string
}

/** Parse `argv` as `Bun.argv` gives it: the runtime and the script first, then the arguments. */
export function parseAdversarialFlags(argv: readonly string[]): AdversarialFlags {
  const args = argv.slice(2)
  const problems: string[] = []
  const parsed: AdversarialFlags = { problems }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (!arg.startsWith("--")) {
      problems.push(`unexpected argument \`${arg}\`. Every argument this command takes is a --flag; nothing positional is read.`)
      continue
    }
    const name = arg.slice(2).split("=")[0]!
    const refused = REFUSED_FLAGS[name]
    if (refused !== undefined) problems.push(`${refused}.`)
    else if (name !== "live" && !VALUE_FLAGS.has(name)) {
      problems.push(
        `\`${arg}\` is not a flag this command knows. It takes --live, --provider-mode oauth, --oauth-provider, --pin, ` +
          "--oauth-prepared, --oauth-data-root and --out only.",
      )
    }
    if ((VALUE_FLAGS.has(name) || refused !== undefined) && !arg.includes("=") && args[index + 1] !== undefined && !args[index + 1]!.startsWith("-")) {
      index += 1
    }
  }

  const live = args.filter((arg) => matchesFlag(arg, "live"))
  if (live.length === 0) problems.push("--live is required. This command runs against real providers once every gate is closed, and says so by name.")
  else if (live.some((arg) => arg !== "--live")) problems.push(`--live takes no value; it received \`${live.find((arg) => arg !== "--live")}\`.`)
  else if (live.length > 1) problems.push(`--live was given ${live.length} times. Pass it once.`)

  const mode = valueFlag(args, "provider-mode")
  if (!mode.ok) problems.push(mode.message)
  else if (mode.value === undefined) problems.push("--provider-mode oauth is required: the adversarial suite runs on the OAuth route only (protocol v3 B1).")
  else if (mode.value === "api-key") problems.push("--provider-mode api-key is refused: the adversarial suite runs on the OAuth route only (protocol v3 B1).")
  else if (mode.value !== "oauth") problems.push(`--provider-mode is oauth. It received \`${mode.value}\`.`)

  const provider = valueFlag(args, "oauth-provider")
  if (!provider.ok) problems.push(provider.message.replace("Pass it once", "The roster is one slot, so name one provider"))
  else if (provider.value === undefined) problems.push("--oauth-provider is required: the one provider opencode signs in to for the one-slot roster.")
  else parsed.provider = provider.value

  const pin = valueFlag(args, "pin")
  if (!pin.ok) problems.push(pin.message.replace("Pass it once", "The roster is one slot, so pin one model"))
  else if (pin.value === undefined) problems.push("--pin provider/model is required: the one-slot roster's model. MAD names no model.")
  else {
    const value = parsePin(pin.value)
    if (value === undefined) problems.push(`--pin must be provider/model. It received \`${pin.value}\`.`)
    else if (parsed.provider !== undefined && value.providerId !== parsed.provider) {
      problems.push(`--pin ${value.providerId}/${value.modelId} names a provider that is not the --oauth-provider \`${parsed.provider}\`; the pin must be served by it.`)
    } else parsed.pin = value
  }

  for (const [name, key, what] of [
    ["oauth-prepared", "prepared", "the directory `bun run oauth-prepare --out <dir>` built"],
    ["out", "out", "the suite's own experiment root: absent or empty"],
    ["oauth-data-root", "dataRoot", "where each run's fresh OAuth data directory is made: absent or empty"],
  ] as const) {
    const flag = valueFlag(args, name)
    if (!flag.ok) problems.push(flag.message)
    else if (flag.value === undefined) problems.push(`--${name} is required: ${what}.`)
    else if (!isAbsolute(flag.value)) problems.push(`--${name} must be an absolute path. It received \`${flag.value}\`, which would resolve against the current directory.`)
    else parsed[key] = resolve(flag.value)
  }
  return parsed
}

// ---------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------

const rosterOptions = (pin: Pin) => ({ slots: 1, pins: [pin], providerConfigKey: OPENCODE_PROVIDER_CONFIG_KEY })

/**
 * The one-slot roster the schedule seals, built from the pin before any host
 * exists, with the tool capability every run's host must then declare. Each
 * run's host is checked against it (`hostRosterProblems`) before its run.
 */
export function adversarialRoster(pin: Pin): SelectResult {
  return selectRoster([{ providerId: pin.providerId, modelId: pin.modelId, toolcall: true }], rosterOptions(pin))
}

/** Why the roster a host's candidates resolve to is not the sealed one; empty when it is. */
export function hostRosterProblems(candidates: readonly Candidate[], pin: Pin, sealed: Roster): string[] {
  let resolved: SelectResult
  try {
    resolved = selectRoster(candidates, rosterOptions(pin))
  } catch (error) {
    return [`the host's models resolve to no roster: ${messageOf(error)}`]
  }
  const problems = resolved.warnings
    .filter((warning) => warning.code === "roster-pin-unhonoured" || warning.code === "roster-underfilled")
    .map((warning) => `selectRoster warned ${warning.code}: ${warning.message}`)
  if (canonicalJson(resolved.roster) !== canonicalJson(sealed)) {
    problems.push(
      `the host resolves the roster ${resolved.roster.slots.map((slot) => `${slot.slot} ${slot.providerId}/${slot.modelId} (toolcall ${slot.toolcall})`).join(", ") || "(no slot)"}, ` +
        `not the sealed ${sealed.slots.map((slot) => `${slot.slot} ${slot.providerId}/${slot.modelId} (toolcall ${slot.toolcall})`).join(", ")}`,
    )
  }
  return problems
}

// ---------------------------------------------------------------------------
// The per-run host lifecycle
// ---------------------------------------------------------------------------

/** One line of `adversarial-hosts.jsonl`. `pid` is `null` when no process id is known. */
export interface HostRecord {
  event: "start" | "verify" | "stop" | "postStop"
  ok: boolean
  at: string
  scheduleHash: string
  caseId: string
  side: string
  position: number
  dataDir: string
  pid: number | null
  detail: string
}

/** Appends one line and syncs it; returns why it could not, or `null`. */
export async function appendHostRecord(file: string, line: HostRecord): Promise<string | null> {
  try {
    const handle = await open(file, "a", 0o600)
    try {
      await handle.appendFile(`${JSON.stringify(line)}\n`, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    return null
  } catch (error) {
    return `the host record \`${file}\` could not be appended: ${messageOf(error)}`
  }
}

/** `run()`, or a rejection naming `what` once `ms` pass with no answer. */
export async function within<T>(ms: number, what: string, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} gave no answer within ${ms} ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export interface OAuthHostLifecycleOptions {
  provider: string
  pin: Pin
  prepared: string
  dataRoot: string
  home: string
  payloadPins: PayloadPins
  scheduleHash: string
  roster: Roster
  recordFile: string
  clock: Clock
  /** The bound on each of the host's verification reads, and on the roster read. */
  requestMs: number
  startHost: (options: ManagedHostOptions) => Promise<ManagedHostStart>
  createClient: (init: { baseUrl: string; directory: string }) => unknown | Promise<unknown>
  enumerate: (client: unknown) => Promise<Candidate[]>
  createBackend: (options: OpencodeBackendOptions) => ModelBackend
  append: (file: string, line: HostRecord) => Promise<string | null>
}

/** What the lifecycle saw, for the launcher's summary. */
export interface LifecycleState {
  starts: number
  /** The first record that could not be persisted, named. */
  recordFailure: string | null
  /** Every host whose stop or post-stop checks are not established, with its pid and data directory. */
  unestablished: string[]
}

/**
 * Whether a host's stop is established: a spawned OAuth host needs a confirmed
 * stop and `postStop` present with no problem. A missing `postStop` is missing
 * verification, never a pass. Nothing spawned and nothing returned is no host.
 */
export function stopEstablished(outcome: StopOutcome | null, spawned: boolean, dataDir: string): AdversarialHostStop {
  const keep = `its data directory \`${dataDir}\` is kept as it is`
  if (outcome === null) {
    return spawned
      ? { ok: false, reason: `a host was spawned and no stop outcome was returned, so its termination is not established; ${keep}` }
      : { ok: true, detail: "no host was started" }
  }
  if (!outcome.confirmed) {
    return { ok: false, reason: `the stop of process ${outcome.pid} is UNCONFIRMED — check it by hand before anything else runs (${outcome.why}); ${keep}` }
  }
  if (!spawned) return { ok: true, detail: `process ${outcome.pid} ${outcome.how}` }
  if (outcome.postStop === undefined) {
    return { ok: false, reason: `process ${outcome.pid} ${outcome.how}, and no post-stop checks were returned, so post-stop verification is missing; ${keep}` }
  }
  if (outcome.postStop.problems.length > 0) {
    return { ok: false, reason: `process ${outcome.pid} ${outcome.how}, and a post-stop check failed: ${outcome.postStop.problems.join("; ")}; ${keep}` }
  }
  return { ok: true, detail: `process ${outcome.pid} ${outcome.how}; after the stop: ${outcome.postStop.held.join("; ") || "no check reported"}` }
}

/**
 * The launcher's lifecycle (protocol v3 B9): per run, a fresh
 * `<data-root>/run-<position>/opencode` holding only the auth symlink, a managed
 * host that verifies the run's worktree, a bounded check that it resolves the
 * sealed roster, and a stop that must be established.
 *
 * Whatever obtains a host owns its stop. A start does not begin once the suite's
 * signal is set, and a host a start obtains while it is set is stopped before
 * the start returns. A failed start reports the stop `startManagedHost` already
 * made; a start that threw before any spawn was reported leaves its cleanup not
 * established. After any failure the lifecycle starts nothing more.
 *
 * `stopCurrent` is the signal handler's: it stops a spawned host at once, and a
 * host still starting as soon as its start returns.
 */
export function oauthHostLifecycle(options: OAuthHostLifecycleOptions): {
  lifecycle: AdversarialHostLifecycle
  state: LifecycleState
  stopCurrent: () => Promise<void>
} {
  const state: LifecycleState = { starts: 0, recordFailure: null, unestablished: [] }
  let failed: string | null = null
  let current: (() => Promise<unknown>) | undefined

  const start = async (context: AdversarialRunContext, worktree: string, signal?: AbortSignal): Promise<AdversarialHostStart> => {
    const noHost: AdversarialHostStop = { ok: true, detail: "no host was started" }
    if (failed !== null) return { ok: false, reason: `no further host starts after a failure: ${failed}`, cleanup: noHost }
    if (signal?.aborted) return { ok: false, reason: "the run was cancelled before this host was started", cleanup: noHost }
    const dataDir = join(options.dataRoot, `run-${context.position}`)
    const label = `run ${context.position} (${context.caseId} ${context.side})`
    const write = async (event: HostRecord["event"], ok: boolean, detail: string, pid: number | null): Promise<string | null> => {
      let at: string
      try {
        at = options.clock.now()
      } catch (error) {
        at = `unknown (the clock failed: ${messageOf(error)})`
      }
      const problem = await options.append(options.recordFile, {
        event,
        ok,
        at,
        scheduleHash: options.scheduleHash,
        caseId: context.caseId,
        side: context.side,
        position: context.position,
        dataDir,
        pid,
        detail,
      })
      if (problem !== null) {
        const named = `the ${event} record of ${label} was not persisted: ${problem}`
        state.recordFailure ??= named
        return named
      }
      return null
    }

    let spawned: { pid: number; stop(): Promise<StopOutcome> } | undefined
    let host: ManagedHost | undefined
    let stopping: Promise<AdversarialHostStop> | undefined
    /** Records a stop outcome as its stop and post-stop lines, and says whether it is established. */
    const settle = async (outcome: StopOutcome): Promise<AdversarialHostStop> => {
      const checked = stopEstablished(outcome, true, dataDir)
      const recorded = [
        await write("stop", outcome.confirmed, outcome.confirmed ? outcome.how : outcome.why, outcome.pid),
        await write(
          "postStop",
          outcome.postStop !== undefined && outcome.postStop.problems.length === 0,
          outcome.postStop === undefined
            ? "no post-stop checks were returned"
            : [...outcome.postStop.held.map((line) => `held: ${line}`), ...outcome.postStop.problems.map((line) => `FAILED: ${line}`)].join("; "),
          outcome.pid,
        ),
      ].filter((problem): problem is string => problem !== null)
      const result: AdversarialHostStop =
        recorded.length === 0 ? checked : { ok: false, reason: `${checked.ok ? `the host stopped (${checked.detail})` : checked.reason}; ${recorded.join("; ")}` }
      if (!checked.ok) state.unestablished.push(`${label}: ${checked.reason}`)
      if (!result.ok) failed ??= result.reason
      return result
    }
    // Called only once a host was spawned or `startHost` has returned, so a stop
    // is never memoized as "no host" while one is still starting.
    const stop = (): Promise<AdversarialHostStop> => {
      stopping ??= (async (): Promise<AdversarialHostStop> => {
        // Yield first, so `stopping` is set before the host's stop runs: a signal
        // that lands inside that stop gets this same promise, not a second stop.
        await undefined
        const handle = host?.stop ?? spawned?.stop
        if (handle === undefined) return noHost
        let outcome: StopOutcome
        try {
          outcome = await handle()
        } catch (error) {
          outcome = { confirmed: false, pid: host?.pid ?? spawned!.pid, why: `the stop rejected: ${messageOf(error)}` }
        }
        return settle(outcome)
      })()
      return stopping
    }
    const refuse = async (reason: string): Promise<AdversarialHostStart> => {
      const cleanup = await stop()
      failed ??= reason
      return { ok: false, reason, cleanup }
    }

    try {
      // A new directory, never an existing one: `mkdir` without `recursive` fails on one that exists.
      try {
        await mkdir(dataDir, { mode: 0o700 })
        await mkdir(join(dataDir, "opencode"), { mode: 0o700 })
        const { link, target } = authLinkPaths(dataDir, options.home)
        await symlink(target, link)
      } catch (error) {
        const reason = `the data directory \`${dataDir}\` could not be created fresh: ${messageOf(error)}`
        const problem = await write("start", false, reason, null)
        return refuse(problem === null ? reason : `${reason}; ${problem}`)
      }
      if (signal?.aborted) return refuse("the run was cancelled before this host was started")

      state.starts += 1
      const route: OAuthRoute = {
        providers: [options.provider],
        models: [options.pin],
        dataDir,
        prepared: options.prepared,
        home: options.home,
        pins: options.payloadPins,
      }
      let threw = false
      const starting = (async (): Promise<ManagedHostStart> => {
        try {
          return await options.startHost({
            mode: "oauth",
            oauth: route,
            verifyDirectories: [worktree],
            requestMs: options.requestMs,
            // The launcher owns SIGINT and SIGTERM; the host's own handler would exit before the suite's records are written.
            signals: null,
            onSpawn: (handle) => {
              spawned = handle
            },
          })
        } catch (error) {
          threw = true
          return { ok: false, reason: `the managed host could not be started: ${messageOf(error)}`, stopped: null }
        }
      })()
      // A signal while the start is in flight waits for it to return, then stops what it obtained.
      current = async () => {
        if (spawned === undefined && host === undefined) await starting
        return spawned === undefined && host === undefined ? noHost : stop()
      }
      const started = await starting
      if (!started.ok) {
        const problem = await write("start", false, started.reason, spawned?.pid ?? null)
        const reason = problem === null ? started.reason : `${started.reason}; ${problem}`
        let cleanup: AdversarialHostStop
        if (spawned === undefined) {
          // A returned refusal with nothing spawned is a refusal before the spawn; a throw proves nothing.
          cleanup = threw
            ? { ok: false, reason: `the start threw before any spawn was reported, so whether it left a process running is not established; the data directory \`${dataDir}\` is kept as it is` }
            : stopEstablished(started.stopped, false, dataDir)
        } else {
          // `startManagedHost` stopped what it spawned; its own outcome is the one recorded, and no second stop is sent.
          stopping ??= started.stopped === null ? stop() : settle(started.stopped)
          cleanup = await stopping
        }
        failed ??= reason
        return { ok: false, reason, cleanup }
      }
      host = started.host
      if (signal?.aborted) {
        await write("start", true, `managed host ${host.url}, started while the run was being cancelled`, host.pid)
        return refuse("the run was cancelled while this host was starting; it was stopped before its run")
      }
      const startProblem = await write("start", true, `managed host ${host.url}: opencode ${host.version}, binary sha256 ${host.sha256}`, host.pid)
      if (startProblem !== null) return refuse(startProblem)

      let verified: string[]
      try {
        const url = host.url
        verified = await within(options.requestMs, "the host's roster read", async () =>
          hostRosterProblems(await options.enumerate(await options.createClient({ baseUrl: url, directory: worktree })), options.pin, options.roster),
        )
      } catch (error) {
        verified = [`the host's roster could not be read: ${messageOf(error)}`]
      }
      const verifyProblem = await write(
        "verify",
        verified.length === 0,
        verified.length === 0 ? `the host resolves the sealed roster ${options.pin.providerId}/${options.pin.modelId}` : verified.join("; "),
        host.pid,
      )
      if (verified.length > 0) return refuse(`the host for ${label} failed its verification: ${verified.join("; ")}`)
      if (verifyProblem !== null) return refuse(verifyProblem)

      const url = host.url
      return {
        ok: true,
        backendFor: (lateUsage: LateUsageReporter, hostTools: Readonly<Record<string, boolean>>) =>
          options.createBackend({
            serverUrl: url,
            directory: worktree,
            slots: options.roster.slots,
            lateUsage,
            executionIdPrefix: `run-${context.position}/`,
            tools: { ...hostTools },
          }),
        stop,
      }
    } catch (error) {
      return refuse(`the host lifecycle failed for ${label}: ${messageOf(error)}`)
    }
  }

  return {
    lifecycle: { start },
    state,
    stopCurrent: async () => {
      await current?.()
    },
  }
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/** What `main` takes from outside. Every default is the shipped behaviour. */
export interface AdversarialOverrides {
  gates?: readonly PairedGate[]
  /** Test-only: the run the gates and the reservation are checked against. Defaults to `ADVERSARIAL_RUN`. */
  adversarialRun?: AdversarialRun
  /** Test-only: the protocol file. Defaults to `PROTOCOL_V3_FILE`. */
  protocolV3File?: string
  /** Test-only: the pins the prepared directory is verified against. Defaults to `OAUTH_PAYLOAD`. */
  payloadPins?: PayloadPins
  /** Test-only: the home the auth symlinks point into. Defaults to `os.homedir()`. */
  home?: string
  /** Starts each run's managed host. Defaults to `startManagedHost`. */
  startHost?: (options: ManagedHostOptions) => Promise<ManagedHostStart>
  createClient?: (init: { baseUrl: string; directory: string }) => unknown
  enumerate?: (client: unknown) => Promise<Candidate[]>
  /** Builds each run's backend. Defaults to `new OpencodeModelBackend(options)`. */
  createBackend?: (options: OpencodeBackendOptions) => ModelBackend
  tools?: ToolsFactory
  clock?: Clock
  coin?: () => CoinFace
  codeRevision?: () => Promise<Maybe<CodeRevision>>
  gateTable?: () => Promise<GateTableState>
  /** Test-only: where the reservation is checked and made. Defaults to this repository. */
  reservation?: AdversarialReservationSeam
  spawnGit?: SpawnBlame
  gitDeadlineMs?: number
  gitCleanupMs?: number
  /** Test-only: the materializer's git. Defaults to its bounded git. */
  materializeGit?: MaterializeGit
  /** Test-only: the bound on each host verification read and the roster read. Defaults to `PAIRED_HOST_REQUEST_MS`. */
  hostRequestMs?: number
  /** Test-only: appends a host record. Defaults to `appendHostRecord`. */
  appendHostRecord?: (file: string, line: HostRecord) => Promise<string | null>
  signals?: SignalSource
}

/** Why `path` is not absent or an empty real directory, or `null`. */
async function freshRootProblem(path: string): Promise<string | null> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    return `whether \`${path}\` exists could not be established: ${messageOf(error)}`
  }
  if (info.isSymbolicLink()) return `\`${path}\` is a symlink; it must be absent or an empty directory`
  if (!info.isDirectory()) return `\`${path}\` exists and is not a directory`
  const entries = await readdir(path)
  return entries.length === 0 ? null : `\`${path}\` is not empty (${entries.length} entries); start from an absent or empty directory`
}

/** Every overlap among the real paths of the data root, `--out`, the prepared directory and the user's own opencode store. */
async function disjointProblems(dataRoot: string, out: string, prepared: string, userStore: string): Promise<string[]> {
  const named = [
    { name: "OAuth data root", path: dataRoot },
    { name: "experiment root", path: out },
    { name: "prepared directory", path: prepared },
    { name: "user's own opencode data directory", path: userStore },
  ]
  const problems: string[] = []
  for (const [index, a] of named.entries()) {
    for (const b of named.slice(index + 1)) {
      const overlap = await overlapProblem(a, b)
      if (overlap !== null) problems.push(overlap)
    }
  }
  return problems
}

/**
 * Why `path` is `repoRoot`, sits inside it or contains it (AD-16), compared
 * lexically and on real paths (a path not created yet through its nearest
 * existing ancestor), or `null`.
 */
async function repoContainmentProblem(path: string, repoRoot: string): Promise<string | null> {
  return (await contained(path, repoRoot)) || (await contained(repoRoot, path))
    ? `\`${path}\` is this repository, is inside it, or contains it (AD-16); name a directory outside it`
    : null
}

/**
 * Stage 3's recheck, immediately before the two roots are created: each root
 * is outside `repoRoot` and does not contain it, each is absent or empty, and
 * the four directories are disjoint. A check that cannot be made is a problem.
 * `repoRoot` is this repository in the launcher; it is a parameter so the check
 * can be exercised against a stand-in repository. Path checks narrow, and do
 * not remove, the window between a check and the `mkdir` that follows it.
 */
export async function rootRecheckProblems(
  roots: { out: string; dataRoot: string; prepared: string; userStore: string },
  repoRoot: string,
): Promise<string[]> {
  const unestablished = (what: string) => (error: unknown) => `${what} could not be established: ${messageOf(error)}`
  const problems: (string | null)[] = []
  for (const [flag, path] of [["--out", roots.out], ["--oauth-data-root", roots.dataRoot]] as const) {
    problems.push(await repoContainmentProblem(path, repoRoot).catch(unestablished(`${flag} containment`)))
    problems.push(await freshRootProblem(path).catch(unestablished(`whether \`${path}\` is absent or empty`)))
  }
  const disjoint = await disjointProblems(roots.dataRoot, roots.out, roots.prepared, roots.userStore).catch((error: unknown) => [
    unestablished("the directories' disjointness")(error),
  ])
  return [...problems.filter((problem): problem is string => problem !== null), ...disjoint]
}

/**
 * The reservation seam over a repository: whether `git ls-tree HEAD` lists a
 * path. A `git` that exits non-zero throws, so "not established" is never read
 * as "not committed".
 */
export function gitReservationSeam(git: (cwd: string, args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>, root: string): AdversarialReservationSeam {
  return {
    root,
    committed: async (relative) => {
      const listed = await git(root, ["ls-tree", "--name-only", "HEAD", "--", relative])
      if (listed.exitCode !== 0) throw new Error(`\`git ls-tree\` exited ${listed.exitCode}: ${listed.stderr.trim() || "no detail"}`)
      return listed.stdout.trim().length > 0
    },
  }
}

function refusal(stage: string, reasons: string[], next: string, code = 1): number {
  console.log(
    `\nREFUSED at ${stage}.\n` +
      reasons.map((reason) => `  - ${reason}\n`).join("") +
      "Nothing was reserved, scheduled or started by this invocation: no reservation, worktree, start marker or host,\n" +
      "and nothing was written under --out or --oauth-data-root.\n" +
      `Next step: ${next}`,
  )
  return code
}

export async function main(argv: readonly string[] = Bun.argv, overrides: AdversarialOverrides = {}): Promise<number> {
  const signals: SignalSource = overrides.signals ?? process
  const controller = new AbortController()
  let interrupted = false
  let stopCurrent: (() => Promise<void>) | undefined
  const onSignal = (): void => {
    if (interrupted) {
      console.log("\nINTERRUPTED again — the current host is already being stopped and the suite's records written; waiting.")
      return
    }
    interrupted = true
    console.log("\nINTERRUPTED — aborting through the run's signal and stopping the current host; the records are written before exit.")
    controller.abort(new Error("the operator interrupted the run"))
    void stopCurrent?.()
  }
  signals.on("SIGINT", onSignal)
  signals.on("SIGTERM", onSignal)
  try {
    return await launch(argv, overrides, controller.signal, () => interrupted, (stop) => {
      stopCurrent = stop
    })
  } catch (error) {
    await stopCurrent?.()
    console.log(`\nINCOMPLETE — the launcher threw: ${messageOf(error)}`)
    return 1
  } finally {
    signals.off("SIGINT", onSignal)
    signals.off("SIGTERM", onSignal)
  }
}

async function launch(
  argv: readonly string[],
  overrides: AdversarialOverrides,
  signal: AbortSignal,
  interrupted: () => boolean,
  ownStop: (stop: () => Promise<void>) => void,
): Promise<number> {
  const gates = overrides.gates ?? PAIRED_GATES
  const run = overrides.adversarialRun ?? ADVERSARIAL_RUN
  const clock = overrides.clock ?? systemClock()
  const home = overrides.home ?? homedir()
  const payloadPins = overrides.payloadPins ?? OAUTH_PAYLOAD
  const protocolFile = overrides.protocolV3File ?? PROTOCOL_V3_FILE
  const git = boundedGit({
    spawn: overrides.spawnGit ?? preflightSpawn,
    deadlineMs: overrides.gitDeadlineMs ?? PREFLIGHT_GIT_DEADLINE_MS,
    cleanupMs: overrides.gitCleanupMs ?? PREFLIGHT_GIT_CLEANUP_MS,
  })

  // ---- STAGE 1: offline checks ----
  console.log("bun run adversarial — stage 1 of 4: offline checks (no host, no network call, nothing written)")
  const flags = parseAdversarialFlags(argv)
  const checks: Check[] = []
  checks.push(flags.problems.length === 0 ? pass("flags") : fail("flags", flags.problems))
  const { out, dataRoot, prepared, pin, provider } = flags

  for (const [name, path, flag] of [
    ["--out containment", out, "--out"],
    ["--oauth-data-root containment", dataRoot, "--oauth-data-root"],
  ] as const) {
    if (path === undefined) {
      checks.push(notEvaluated(name, flag))
      continue
    }
    checks.push(
      await guarded(name, async () => {
        const problem = await repoContainmentProblem(path, REPO_ROOT)
        return problem === null ? pass(name, [`\`${path}\` is outside this repository and does not contain it`]) : fail(name, [problem])
      }),
    )
  }
  for (const [name, path, flag] of [
    ["experiment root", out, "--out"],
    ["OAuth data root", dataRoot, "--oauth-data-root"],
  ] as const) {
    if (path === undefined) checks.push(notEvaluated(name, flag))
    else {
      checks.push(
        await guarded(name, async () => {
          const problem = await freshRootProblem(path)
          return problem === null ? pass(name, [`\`${path}\` is absent or empty`]) : fail(name, [problem])
        }),
      )
    }
  }
  const userStore = join(home, ".local", "share", "opencode")
  if (out === undefined || dataRoot === undefined || prepared === undefined) checks.push(notEvaluated("disjoint directories", "--out, --oauth-data-root and --oauth-prepared"))
  else {
    checks.push(
      await guarded("disjoint directories", async () => {
        const problems = await disjointProblems(dataRoot, out, prepared, userStore)
        return problems.length === 0
          ? pass("disjoint directories", ["the real paths of the data root, --out, the prepared directory and the user's own opencode store are disjoint"])
          : fail("disjoint directories", problems)
      }),
    )
  }

  checks.push(
    await guarded("frozen protocol v3", async () => {
      const protocol = await readFrozenProtocol(protocolFile)
      if (!protocol.ok) return fail("frozen protocol v3", [`protocol v3 is not frozen: ${protocol.reason}`])
      return protocol.version === 3
        ? pass("frozen protocol v3", [`${protocol.id} v${protocol.version} ${protocol.hash}`])
        : fail("frozen protocol v3", [`the adversarial suite on the OAuth route needs protocol v3, and the frozen protocol read is ${protocol.id} v${protocol.version}`])
    }),
  )

  let table: GateTableState
  try {
    table = await (overrides.gateTable ?? (() => gateTableState(git, REPO_ROOT)))()
  } catch (error) {
    table = { ok: false, why: `whether ${GATE_TABLE_FILE} is committed could not be established: ${messageOf(error)}` }
  }
  checks.push(table.ok ? pass("gate table committed", [`${GATE_TABLE_FILE} is HEAD's blob ${table.blob}`]) : fail("gate table committed", [table.why]))
  const gateCheck = gatePreflight(gates, "adversarial", "oauth", undefined, run)
  const gateName = "adversarial gates (ablation/paired-gates.ts, phase adversarial, route oauth)"
  checks.push(
    gateCheck.ok
      ? pass(gateName, gateCheck.lines)
      : fail(gateName, [
          ...gateCheck.lines,
          ...gateCheck.problems.map((problem) => `REFUSED: ${problem}`),
          "A gate closes only by a reviewed, committed change to ablation/paired-gates.ts; no flag, variable or file can close one.",
        ]),
  )

  let route: OAuthRoute | undefined
  if (provider === undefined || pin === undefined || dataRoot === undefined || prepared === undefined) {
    checks.push(notEvaluated("OAuth route", "--oauth-provider, --pin, --oauth-data-root and --oauth-prepared"))
    checks.push(notEvaluated("OAuth prepared payloads", "--oauth-prepared"))
  } else {
    const candidate: OAuthRoute = { providers: [provider], models: [pin], dataDir: join(dataRoot, "run-1"), prepared, home, pins: payloadPins }
    const problems = oauthRouteProblems(candidate)
    checks.push(
      problems.length === 0
        ? pass("OAuth route", [`provider ${provider}; pin ${pin.providerId}/${pin.modelId}, also small_model; no relay, no credential`])
        : fail("OAuth route", problems),
    )
    const payloads = await guarded("OAuth prepared payloads", async () => {
      const verified = await verifyPrepared(prepared, payloadPins)
      return verified.ok
        ? pass("OAuth prepared payloads", [
            `\`${prepared}\`: anthropic-auth tree ${verified.measured.anthropicAuth.treeDigest}, config seed tree ` +
              `${verified.measured.configSeed.treeDigest}, catalogue ${verified.measured.catalogueSha256}; each as pinned`,
          ])
        : fail("OAuth prepared payloads", verified.problems)
    })
    checks.push(payloads)
    if (problems.length === 0 && payloads.state === "pass") route = candidate
  }

  const reservationSeam: AdversarialReservationSeam = overrides.reservation ?? gitReservationSeam(git, REPO_ROOT)
  const pinName = pin === undefined ? undefined : `${pin.providerId}/${pin.modelId}`
  checks.push(
    await guarded("authorized adversarial run", async () => {
      const problems = await adversarialRunProblems(pinName === undefined ? [] : [pinName], reservationSeam, run)
      return problems.length === 0
        ? pass("authorized adversarial run", [
            `the pin ${pinName} is adversarial run ${run.run}'s roster`,
            `its reservation \`${run.reservation}\` is unused; it is created before anything is written`,
          ])
        : fail("authorized adversarial run", problems)
    }),
  )

  let wiring: ToolsWiring | undefined
  if (out === undefined) checks.push(notEvaluated("production Tools wiring", "--out"))
  else {
    let problem: string | null
    try {
      wiring = (overrides.tools ?? productionTools)({ worktree: join(adversarialDirectory(out), "worktrees") })
      problem = toolsWiringProblem(wiring)
    } catch (error) {
      problem = `the Tools port could not be built: ${messageOf(error)}`
    }
    checks.push(problem === null ? pass("production Tools wiring", [`config.tools: ${toolsIdentity(wiring!)}`]) : fail("production Tools wiring", [problem]))
  }

  for (const check of checks) printCheck(check)
  const failed = checks.filter((check) => check.state === "fail")
  const skipped = checks.filter((check) => check.state === "not-evaluated")
  if (interrupted()) return refusal("stage 1 (offline checks)", ["the launcher was interrupted"], "run the command again when ready.", 130)
  if (
    failed.length > 0 ||
    skipped.length > 0 ||
    out === undefined ||
    dataRoot === undefined ||
    prepared === undefined ||
    pin === undefined ||
    provider === undefined ||
    route === undefined ||
    wiring === undefined ||
    !table.ok
  ) {
    return refusal(
      "stage 1 (offline checks)",
      [
        ...failed.map((check) => (check.state === "fail" ? `${check.name} failed: ${failureReason(check)}` : check.name)),
        ...skipped.map((check) => (check.state === "not-evaluated" ? `${check.name} was not evaluated (${check.prerequisite})` : check.name)),
      ],
      "fix every failure printed above and run the command again. An OPEN gate is closed only by its owner, through a " +
        "reviewed, committed change to ablation/paired-gates.ts.",
    )
  }

  // ---- STAGE 2: the reservation, before anything else is written ----
  console.log(`\nbun run adversarial — stage 2 of 4: reserve adversarial run ${run.run}`)
  const reserved = await reserveAdversarialRun(
    reservationSeam.root,
    { run: run.run, story: "2-7f", createdAt: clock.now(), gateTableBlob: table.blob, pins: [pinName!], out, dataRoot },
    run,
  )
  if (!reserved.ok) {
    return refusal("stage 2 (reservation)", [reserved.why], "gate 10 authorizes one adversarial run; a further run needs the budget owner's new authorization in a reviewed change.")
  }
  console.log(`  reserved adversarial run ${run.run}: ${run.reservation} (never removed)`)
  // An interrupt from here until the suite starts keeps the reservation and starts nothing.
  const interruptedAfterReservation = (what: string): number => {
    console.log(
      `\nINTERRUPTED after the reservation, ${what}. No worktree was written and no host was started. ` +
        "The reservation is kept: it is used, and a further run needs a new authorization.",
    )
    return 130
  }
  if (interrupted()) return interruptedAfterReservation("before anything else was written")

  // ---- STAGE 3: the roots, the roster and the schedule ----
  console.log("\nbun run adversarial — stage 3 of 4: the experiment root, the data root and the sealed schedule (no host)")
  const resolved = adversarialRoster(pin)
  let codeRevision: Maybe<CodeRevision>
  try {
    codeRevision = await (overrides.codeRevision ?? (() => codeRevisionFrom((_command, args) => git(REPO_ROOT, args))))()
  } catch (error) {
    codeRevision = unknownValue(`the code revision could not be read: ${messageOf(error)}`)
  }
  if (interrupted()) return interruptedAfterReservation("before the roots were created")
  // The two roots are checked again immediately before they are created, containment included: stage 1's answer may be stale.
  const spent = "The reservation is already spent: a further run needs a new authorization."
  const again = await rootRecheckProblems({ out, dataRoot, prepared, userStore }, REPO_ROOT).catch((error: unknown) => [
    `the recheck of the roots could not be made: ${messageOf(error)}`,
  ])
  if (again.length > 0) {
    console.log(
      `\nREFUSED at stage 3 (recheck of the roots):\n${again.map((problem) => `  - ${problem}\n`).join("")}` +
        `No root, schedule or worktree was created and no host was started. ${spent}`,
    )
    return 1
  }
  try {
    await mkdir(out, { recursive: true, mode: 0o700 })
    await mkdir(dataRoot, { recursive: true, mode: 0o700 })
  } catch (error) {
    console.log(`\nREFUSED at stage 3: a root could not be created: ${messageOf(error)}\nNo schedule was sealed and no host was started. ${spent}`)
    return 1
  }
  if (interrupted()) return interruptedAfterReservation("after the roots were created and before the schedule was sealed")
  const config: AdversarialConfig = {
    provenance: "live",
    tools: toolsIdentity(wiring),
    accounting: "attempts",
    route: "oauth",
    hostTools: { ...ADVERSARIAL_HOST_OFFER },
    hostIsolation: FRESH_PER_RUN,
  }
  const created = await createAdversarialSchedule({
    experimentRoot: out,
    protocolFile,
    codeRevision,
    roster: resolved.roster,
    config,
    createdAt: clock.now(),
    ...(overrides.coin === undefined ? {} : { coin: overrides.coin }),
  })
  if (!created.ok) {
    console.log(`\nREFUSED by createAdversarialSchedule: ${created.reason}\nNo host was started. The reservation is kept; a further run needs a new authorization.`)
    return 1
  }
  console.log(`  schedule sealed at ${created.file} (coins ${created.schedule.coins.join(", ")})`)
  if (interrupted()) return interruptedAfterReservation(`after the schedule was sealed at ${created.file}`)

  // ---- STAGE 4: the suite ----
  console.log("\nbun run adversarial — stage 4 of 4: write all sixteen worktrees, then one managed host per run")
  const recordFile = join(adversarialDirectory(out), ADVERSARIAL_HOSTS_FILE)
  const hosts = oauthHostLifecycle({
    provider,
    pin,
    prepared,
    dataRoot,
    home,
    payloadPins,
    scheduleHash: created.schedule.scheduleHash,
    roster: resolved.roster,
    recordFile,
    clock,
    requestMs: overrides.hostRequestMs ?? PAIRED_HOST_REQUEST_MS,
    startHost: overrides.startHost ?? startManagedHost,
    createClient: overrides.createClient ?? defaultCreateClient,
    enumerate: overrides.enumerate ?? ((client: unknown) => enumerateCandidates(client as never)),
    createBackend: overrides.createBackend ?? ((options: OpencodeBackendOptions) => new OpencodeModelBackend(options)),
    append: overrides.appendHostRecord ?? appendHostRecord,
  })
  ownStop(hosts.stopCurrent)
  const outcome = await runAdversarialSuite({
    experimentRoot: out,
    protocolFile,
    codeRevision,
    roster: resolved.roster,
    priorWarnings: resolved.warnings,
    config,
    clock,
    signal,
    shell: $ as never,
    lifecycle: hosts.lifecycle,
    ...(overrides.materializeGit === undefined ? {} : { git: overrides.materializeGit }),
  })
  if (!outcome.ok) {
    console.log(`\nREFUSED by runAdversarialSuite before its start marker: ${outcome.reason}\nNo host was started. The sealed schedule stays at ${created.file}.`)
    return 1
  }

  console.log("\nSlots:")
  for (const slot of outcome.slots) console.log(`  ${slot.position} ${slot.caseId} ${slot.side}: ${slot.status} — ${slot.reason}`)
  const bill = outcome.bill
  console.log(`\nAttempts: ${bill.requests.length} journaled; halt: ${bill.halt ?? "none"}; stop: ${bill.stop ?? "none"}`)
  for (const warning of outcome.warnings) console.log(`warning: ${warning}`)
  console.log(`\nHosts: ${hosts.state.starts} start(s) attempted, recorded in ${recordFile}`)
  for (const line of hosts.state.unestablished) console.log(`HOST STOP NOT ESTABLISHED — ${line}`)
  if (hosts.state.recordFailure !== null) {
    console.log(`HOST RECORD INCOMPLETE — ${hosts.state.recordFailure}. The host record is not a complete disclosure of the host starts.`)
  }
  const clean = outcome.complete && hosts.state.recordFailure === null && hosts.state.unestablished.length === 0 && !interrupted()
  console.log(
    (clean
      ? "\nThe suite reads `complete: true`: all sixteen runs completed, every host stopped with its checks held, and every host record was persisted.\n"
      : "\nThe suite is INCOMPLETE: every slot above names its reason, and the evidence is kept.\n") +
      `Read it: bun run eval-read --bundle ${out}`,
  )
  return clean ? 0 : 1
}

async function defaultCreateClient(init: { baseUrl: string; directory: string }): Promise<unknown> {
  const { createOpencodeClient } = await import("@opencode-ai/sdk/v2")
  return createOpencodeClient(init)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

if (import.meta.main) process.exit(await main())
