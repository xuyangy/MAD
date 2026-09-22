/**
 * Story 2-7b — `runAdversarialSuite`, the library runner for the sixteen
 * adversarial runs of `evaluation-protocol.md` §5, in the shape of
 * `runPairedBlocks` (`ablation/paired.ts`). It bills nothing by itself: a caller
 * supplies the backend, and the live execution is a separate, unticked task
 * (`ablation/LIVE-RUN.md`).
 *
 * ## One experiment, one ledger
 *
 * The journal (`paired-journal.jsonl`), the lock (`paired.lock`) and the halt
 * marker are the EXPERIMENT ROOT's, shared with every category, so Blocks spend
 * already recorded there counts toward the global cap and a halt written there
 * refuses the next adversarial request. The suite's own files live under
 * `<root>/adversarial/`: the schedule, start marker, slot status,
 * `tool-trace.jsonl`, the bundle index, the dumps, the worktrees and, when the
 * runner ends, the bill summary the reader prints. It never
 * touches the paired schedule, start marker or `bundle.json`. A root nested
 * inside another experiment root, or an adversarial subtree holding a journal of
 * its own, is refused: a fresh journal there would see none of the experiment's
 * spend and enforce no global cap.
 *
 * ## Preflight, then the start marker
 *
 * In the order `runPairedBlocks` uses: take the root's lock; refuse a started
 * schedule; refuse a nested root or an adversarial ledger; refuse a blank Tools
 * identity, a `maxConcurrency` above 1, or a roster that is not one slot; check
 * the seal (the refusal names the hash); verify the schedule against this
 * runner's inputs; open the journal and refuse when it is halted or stopped;
 * check every planned worktree against the bundle root with the shared AD-16
 * checks. Only then is anything written under `adversarial/`: the bundle index,
 * then the start marker. A refused preflight never spends an unstarted
 * schedule, and a started schedule is never executed again.
 *
 * ## One run
 *
 * Sequential, in schedule order. For each slot: write the side's worktree
 * (`ablation/adversarial-materialize.ts`), check its containment again on the
 * real paths, build ONE trace sink and hand that same value to `opencodeTools`
 * and to `review()`, run `review()` on the one-slot roster with the ordinary
 * 25,000 `tokenCap` and the adversarial admission, write the dump and manifest,
 * and record the slot's terminal status with an attack run's delivery evidence.
 * No run is retried, re-run or replaced.
 *
 * Every billable request passes the run's own ledger gate and the journal's
 * adversarial gate: stop, halt, global 2,000,000, adversarial 400,000.
 *
 * Verified with a scripted backend over real git; see `ablation/LIVE-RUN.md` for
 * what that does not establish about a real host.
 */

import { stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import type { PluginInput } from "@opencode-ai/plugin"

import type { SpawnBlame } from "../adapters/opencode/blame-exec.ts"
import { opencodeTools } from "../adapters/opencode/tools.ts"
import { createTurnRecorder, realRefusalFor, refusalFor, safeName, type ArtifactOutcome } from "../adapters/opencode/artifacts.ts"
import type { Roster } from "../core/domain/roster.ts"
import type { RunRecord } from "../core/domain/run-record.ts"
import type { Warning } from "../core/domain/warning.ts"
import type { Clock } from "../core/ports/clock.ts"
import { createLateUsageSink, type LateUsageReporter } from "../core/ports/late-usage.ts"
import type { ModelBackend } from "../core/ports/model-backend.ts"
import { review, type ReviewResult } from "../core/run/review.ts"
import { ADVERSARIAL_ASSERTIONS, type AdversarialAssertion } from "../fixtures/adversarial/assertions.ts"
import { ADVERSARIAL_CASES, type AdversarialMaterial } from "../fixtures/adversarial/material.ts"
import { ADVERSARIAL_SEAL, adversarialSealProblem } from "../fixtures/adversarial/seal.ts"
import { materializeSide, type RunGit } from "./adversarial-materialize.ts"
import {
  ADVERSARIAL_DIRECTORY,
  ADVERSARIAL_SCHEDULE_FILE,
  ADVERSARIAL_START_MARKER_FILE,
  adversarialDirectory,
  appendAdversarialSlotStatus,
  concurrencyProblem,
  oneSlotProblem,
  verifyAdversarialSchedule,
  writeAdversarialBill,
  writeAdversarialStartMarker,
  type AdversarialBillSummary,
  type AdversarialConfig,
  type AdversarialSchedule,
  type AdversarialSlot,
  type DeliveryEvidence,
  type ReachedStage,
  type Side,
} from "./adversarial-schedule.ts"
import { writeArmDump, writeBundleIndex } from "./bundle.ts"
import { ADVERSARIAL_ALLOWANCES, governorStateFromBill, HALT_MARKER_FILE, type ExperimentGovernorState } from "./governor.ts"
import {
  acquireLock,
  JOURNAL_FILE,
  LOCK_FILE,
  openJournal,
  operationalHaltReason,
  type AdversarialRefusal,
  type OvershootReport,
  type PairedJournal,
  type ReconciliationHandle,
  type UniqueExecutionBill,
} from "./journal.ts"
import { known, type AdversarialBinding, type CodeRevision, type Maybe } from "./manifest.ts"
import { SCHEDULE_FILE, START_MARKER_FILE, type SlotStatus } from "./schedule.ts"
import { createToolTraceSink, TOOL_TRACE_FILE, TraceUnresolvedError, type TraceIo } from "./tool-trace.ts"

type Shell = PluginInput["$"]

/** Where the worktrees are written, under the adversarial directory. */
export const WORKTREES_DIRECTORY = "worktrees"

/** A run a backend is built for. */
export interface AdversarialRunContext {
  caseId: string
  side: Side
  position: number
}

export interface RunAdversarialSuiteInput {
  experimentRoot: string
  protocolFile: string
  codeRevision: Maybe<CodeRevision>
  /** The one-slot roster the schedule was sealed with. */
  roster: Roster
  priorWarnings?: Warning[]
  config: AdversarialConfig
  clock: Clock
  signal?: AbortSignal
  /** The host shell `opencodeTools` binds to each worktree in turn. */
  shell: Shell
  /** A backend for one run. `lateUsage` reaches the run's own sink and, as a copy, the journal. */
  backendFor(context: AdversarialRunContext, lateUsage: LateUsageReporter): ModelBackend
  /** Seams for a drift test. Default to the sealed fixture. */
  cases?: readonly AdversarialMaterial[]
  assertions?: readonly AdversarialAssertion[]
  /** Seams for tests. Default to real git and the file-backed trace. */
  git?: RunGit
  traceIo?: TraceIo
  /**
   * Story 2-7c — the four bounded-wait seams, passed straight through to the
   * adapter, the judge and the sink. Construction options with shipped defaults,
   * for tests that would otherwise have to wait out a real minute; no flag,
   * config key or environment variable reaches any of them.
   *
   * `observationTimeoutMs` is the CALLER'S bound, the outer half of the nested
   * pair. Without a seam for it the suite could drive the sink's inner deadline
   * and never the bound the whole nesting argument is about, so the one ordering
   * that puts the runner's stop before the next model request was reachable in
   * no test that ran the real wiring. It is declared to the sink as well as
   * passed to the adapter and the judge, so an override that inverted the pair
   * is refused where it is written rather than discovered as a late latch.
   */
  blameTimeoutMs?: number
  blameCleanupTimeoutMs?: number
  traceTimeoutMs?: number
  observationTimeoutMs?: number
  /** Test seam for the blame launcher. Defaults to the real one. */
  spawnBlame?: SpawnBlame
}

export interface AdversarialSlotReport extends AdversarialSlot {
  status: SlotStatus
  reason: string
  runId?: string
  worktree?: string
  manifest?: ArtifactOutcome
  delivery?: DeliveryEvidence
}

export type AdversarialSuiteOutcome =
  | { ok: false; reason: string }
  | {
      ok: true
      schedule: AdversarialSchedule
      /** All sixteen slots, in schedule order. */
      slots: AdversarialSlotReport[]
      bill: UniqueExecutionBill
      overshoot: OvershootReport
      governor: ExperimentGovernorState & { runnerStop: string | null }
      /** True only when all sixteen completed and nothing is halted, stopped, unknown or in flight. */
      complete: boolean
      reconciliation: ReconciliationHandle
      warnings: string[]
    }

/** The worktree a slot's side is written to. */
export function worktreeFor(experimentRoot: string, slot: Pick<AdversarialSlot, "caseId" | "side">): string {
  return join(adversarialDirectory(experimentRoot), WORKTREES_DIRECTORY, `${safeName(slot.caseId)}-${slot.side}`)
}

/** The shared AD-16 checks `writeBundleIndex` and the dump make, lexical then real. */
async function containmentProblem(bundleRoot: string, worktree: string): Promise<string | null> {
  return refusalFor(bundleRoot, worktree) ?? (await realRefusalFor(bundleRoot, worktree)) ?? null
}

type Probe = { kind: "present" } | { kind: "absent" } | { kind: "error"; code: string | undefined; reason: string }

/**
 * Whether a path exists, by `stat`: it needs search permission on the
 * directories only, never read permission on the file. `ENOTDIR` means a
 * component on the way is a file, so nothing can sit at this path.
 */
async function probeFile(file: string): Promise<Probe> {
  try {
    await stat(file)
    return { kind: "present" }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" }
    return { kind: "error", code, reason: `whether \`${file}\` exists could not be established: ${messageOf(error)}` }
  }
}

/** The files whose presence marks a directory as an experiment root. */
const EXPERIMENT_ROOT_MARKERS = [
  JOURNAL_FILE,
  LOCK_FILE,
  HALT_MARKER_FILE,
  SCHEDULE_FILE,
  START_MARKER_FILE,
  join(ADVERSARIAL_DIRECTORY, ADVERSARIAL_SCHEDULE_FILE),
]

/**
 * Why this root cannot be the experiment's one ledger, or `null`: an ancestor
 * directory is already an experiment root, or the adversarial subtree holds a
 * journal or lock of its own.
 *
 * Each marker is probed with `stat`, so a marker that exists and cannot be read
 * still refuses. The walk up stops, without refusing, at an ancestor this
 * process may not search (`EACCES` or `EPERM` from `stat`): it cannot open any
 * file under that directory, so no experiment root there could be shared with
 * it either. Any other error refuses.
 */
export async function sharedLedgerProblem(experimentRoot: string): Promise<string | null> {
  const root = resolve(experimentRoot)
  for (const name of [JOURNAL_FILE, LOCK_FILE]) {
    const file = join(root, ADVERSARIAL_DIRECTORY, name)
    const found = await probeFile(file)
    if (found.kind === "error") return found.reason
    if (found.kind === "present") {
      return (
        `\`${file}\` exists: the adversarial subtree must not keep a ledger of its own. The journal, lock and ` +
        `halt marker are the experiment root's, shared by every category`
      )
    }
  }
  let directory = dirname(root)
  for (;;) {
    for (const name of EXPERIMENT_ROOT_MARKERS) {
      const file = join(directory, name)
      const found = await probeFile(file)
      if (found.kind === "error") {
        if (found.code === "EACCES" || found.code === "EPERM") return null
        return found.reason
      }
      if (found.kind === "present") {
        return (
          `\`${file}\` exists above \`${root}\`, so \`${root}\` is nested inside another experiment root. A journal ` +
          `here would see none of that experiment's spend and enforce no global cap`
        )
      }
    }
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

/**
 * Counts the model requests a run actually sent, and how many held the payload
 * bytes (a byte-substring check over the prompt and the instructions).
 *
 * A request counts as sent once `runTurn` resolved with an envelope that
 * answered or was billed (`ok`, `tokens` or `usageUnknown`). A `runTurn` that
 * threw, or resolved as a failure with no usage, is `uncertain`: it may or may
 * not have gone out, and it is never counted as sent.
 */
export function deliveryProbe(payload: string | null) {
  let requests = 0
  let carrying = 0
  let uncertain = 0
  let uncertainCarrying = 0
  return {
    wrap(inner: ModelBackend): ModelBackend {
      return {
        capabilities: (slot) => inner.capabilities(slot),
        async runTurn(slot, instructions, input, schema, signal) {
          const holds = payload !== null && (input.includes(payload) || instructions.includes(payload))
          let envelope: Awaited<ReturnType<ModelBackend["runTurn"]>>
          try {
            envelope = await inner.runTurn(slot, instructions, input, schema, signal)
          } catch (error) {
            uncertain += 1
            if (holds) uncertainCarrying += 1
            throw error
          }
          const sent =
            envelope.ok ||
            (envelope as { tokens?: unknown }).tokens !== undefined ||
            (envelope as { usageUnknown?: unknown }).usageUnknown !== undefined
          if (sent) {
            requests += 1
            if (holds) carrying += 1
          } else {
            uncertain += 1
            if (holds) uncertainCarrying += 1
          }
          return envelope as never
        },
      }
    },
    counts: () => ({ requests, carrying, uncertain, uncertainCarrying }),
  }
}

/** An attack run's delivery evidence from the probe's counts. */
export function deliveryOf(
  material: Pick<AdversarialMaterial, "surface" | "carrier">,
  record: RunRecord | undefined,
  counts: { requests: number; carrying: number; uncertain: number; uncertainCarrying: number },
): DeliveryEvidence {
  const base = {
    surface: material.surface,
    carrier: material.carrier,
    furthestStage: furthestStage(record, counts.requests),
    requests: counts.requests,
    carrying: counts.carrying,
    uncertain: counts.uncertain,
  }
  if (counts.carrying > 0) {
    return { ...base, carried: "yes", reason: `${counts.carrying} of ${counts.requests} sent model request(s) held the payload bytes` }
  }
  if (counts.uncertainCarrying > 0) {
    return {
      ...base,
      carried: "unshown",
      reason: `${counts.uncertainCarrying} request(s) holding the payload bytes threw, so whether any went out cannot be shown`,
    }
  }
  if (counts.requests === 0) {
    return {
      ...base,
      carried: "unshown",
      reason: "the run issued no model request, so whether a request would have carried the payload cannot be shown",
    }
  }
  return { ...base, carried: "no", reason: `none of the ${counts.requests} sent model request(s) held the payload bytes` }
}

/**
 * The last stage the record shows a finding reached. The stage counts are set
 * on every returned record, even when no finding got that far, so they are not
 * read here.
 */
export function furthestStage(record: RunRecord | undefined, requests: number): ReachedStage {
  const findings = record?.findings ?? []
  const reached = (stage: string): boolean =>
    findings.some((finding) => finding.unresolved?.diedAtStage === stage || (finding.history ?? []).some((entry) => entry.stage === stage))
  if (findings.some((finding) => finding.verdict !== undefined) || reached("judge")) return "judge"
  if (reached("debate")) return "debate"
  if (findings.some((finding) => finding.route !== undefined)) return "route"
  return requests > 0 || findings.length > 0 ? "discover" : "none"
}

export async function runAdversarialSuite(input: RunAdversarialSuiteInput): Promise<AdversarialSuiteOutcome> {
  const root = resolve(input.experimentRoot)
  const directory = adversarialDirectory(root)
  let now: string
  try {
    now = input.clock.now()
  } catch (error) {
    return { ok: false, reason: `the clock failed before the lock was taken: ${messageOf(error)}` }
  }
  const taken = await acquireLock(root, now)
  if (!taken.ok) return { ok: false, reason: taken.reason }
  const lock = taken.lock
  let journal: PairedJournal | undefined
  const refuse = async (reason: string): Promise<AdversarialSuiteOutcome> => {
    if (journal === undefined) {
      const releaseError = await lock.release()
      return { ok: false, reason: releaseError === null ? reason : `${reason}; ${releaseError}` }
    }
    // A RETAINED LOCK IS REPORTED HERE TOO. This path has no `warnings` channel,
    // so the one place it can say the lock is still held is the reason itself.
    // Preflight cannot quarantine today, which is exactly why the flag must not
    // be read and dropped: the next caller to reach a quarantine through here
    // would return an ordinary refusal over a directory nothing may touch.
    const { releaseError, lockRetained } = await journal.close()
    const notes = [
      ...(releaseError === null ? [] : [releaseError]),
      ...(lockRetained
        ? [`the run lock was NOT released and is still held; recovery is manual`]
        : []),
    ]
    return { ok: false, reason: notes.length === 0 ? reason : `${reason}; ${notes.join("; ")}` }
  }

  let prepared: { schedule: AdversarialSchedule; journal: PairedJournal; cases: readonly AdversarialMaterial[] }
  try {
    const marker = join(directory, ADVERSARIAL_START_MARKER_FILE)
    const started = await probeFile(marker)
    if (started.kind === "error") return await refuse(started.reason)
    if (started.kind === "present") return await refuse(`the adversarial schedule was already started (\`${marker}\` exists); a started schedule is never executed again`)

    const nested = await sharedLedgerProblem(root)
    if (nested !== null) return await refuse(nested)

    if (input.config.tools.trim().length === 0) {
      return await refuse("the config's Tools identity is blank, so the schedule would bind no identifiable Tools configuration")
    }
    const concurrency = concurrencyProblem(input.config)
    if (concurrency !== null) return await refuse(concurrency)
    const roster = oneSlotProblem(input.roster)
    if (roster !== null) return await refuse(roster)

    const cases = input.cases ?? ADVERSARIAL_CASES
    const sealProblem = adversarialSealProblem(cases, input.assertions ?? ADVERSARIAL_ASSERTIONS)
    if (sealProblem !== null) return await refuse(`the adversarial suite refuses to start: ${sealProblem}`)

    const verified = await verifyAdversarialSchedule(root, {
      protocolFile: input.protocolFile,
      codeRevision: input.codeRevision,
      roster: input.roster,
      config: input.config,
      seal: ADVERSARIAL_SEAL,
      caseIds: cases.map((c) => c.id),
    })
    if (!verified.ok) return await refuse(verified.reason)
    const schedule = verified.schedule

    // The journal first: a halted or stopped experiment refuses before anything
    // is written under `adversarial/`.
    const opened = await openJournal(root, lock, () => input.clock.now())
    if (!opened.ok) return await refuse(opened.reason)
    journal = opened.journal
    const before = journal.bill()
    if (before.halt !== null) return await refuse(`the experiment is already halted, so the adversarial schedule was not started: ${before.halt}`)
    if (before.stop !== null) return await refuse(`the journal already stopped admitting, so the adversarial schedule was not started: ${before.stop}`)

    // AD-16, per planned worktree, through the checks `writeBundleIndex` and the
    // dump make, before anything is written or spent.
    for (const slot of schedule.slots) {
      const problem = await containmentProblem(directory, worktreeFor(root, slot))
      if (problem !== null) return await refuse(`the adversarial bundle root is not outside ${slot.caseId}'s ${slot.side} worktree: ${problem}`)
    }
    const index = await writeBundleIndex({
      bundleRoot: directory,
      worktree: join(directory, WORKTREES_DIRECTORY),
      arms: schedule.slots.map((slot) => ({ armId: slot.side, repeatId: slot.caseIndex })),
      createdAt: input.clock.now(),
    })
    if (!index.ok) return await refuse(`the adversarial bundle index could not be written: ${index.reason}`)

    const marked = await writeAdversarialStartMarker(root, schedule.scheduleHash, input.clock.now())
    if (!marked.ok) return await refuse(marked.reason)
    prepared = { schedule, journal, cases }
  } catch (error) {
    return await refuse(`the adversarial runner failed before the start marker was written: ${messageOf(error)}`)
  }
  return execute(input, root, prepared.schedule, prepared.journal, prepared.cases)
}

async function execute(
  input: RunAdversarialSuiteInput,
  root: string,
  schedule: AdversarialSchedule,
  journal: PairedJournal,
  cases: readonly AdversarialMaterial[],
): Promise<AdversarialSuiteOutcome> {
  const directory = adversarialDirectory(root)
  const traceFile = join(directory, TOOL_TRACE_FILE)
  const warnings: string[] = []
  const reports = new Map<number, AdversarialSlotReport>()
  let ended: string | null = null
  const endWith = (reason: string): void => {
    ended ??= reason
    journal.stopAdmitting(reason)
  }

  /**
   * Story 2-7c — the suite's response to an unconfirmed process cleanup or an
   * unconfirmed trace append.
   *
   * SYNCHRONOUS, AND IN THIS ORDER. `endWith` stops local admission and
   * `haltOperationally` latches the journal's own stop, both before this
   * function returns — so by the time the adapter's timed-out `blame` call
   * returns to the judge, the next model request is already refused. An
   * end-of-run check would be too late: the judge catches a blame failure and
   * goes straight on to ask its fact-checker.
   *
   * SAFETY DOES NOT WAIT ON THE DURABLE HALF. `haltOperationally` queues the
   * halt marker's write and retains the lock synchronously; if that write fails,
   * admission has still stopped and the lock is still held.
   */
  const quarantine = (why: string): void => {
    // WORDED ONCE, and the same sentence everywhere it lands: the runner's own
    // stop, the slot statuses it strands, the journal's halt and the marker at
    // the root. Two spellings of one halt is how a reader ends up guessing.
    const reason = operationalHaltReason(why)
    endWith(reason)
    journal.haltOperationally(reason)
    warnings.push(reason)
  }

  const mark = async (
    slot: AdversarialSlot,
    status: SlotStatus,
    reason: string,
    extra: Partial<AdversarialSlotReport> = {},
  ): Promise<string | null> => {
    const report: AdversarialSlotReport = { ...reports.get(slot.position), ...slot, status, reason, ...extra }
    reports.set(slot.position, report)
    const at = now(input.clock)
    const problem = await appendAdversarialSlotStatus(root, {
      ...slot,
      status,
      reason,
      at,
      ...(report.runId === undefined ? {} : { runId: report.runId }),
      ...(report.delivery === undefined ? {} : { delivery: report.delivery }),
    })
    if (problem !== null) {
      warnings.push(problem)
      endWith(`a slot status could not be recorded: ${problem}`)
    }
    return problem
  }

  const identity = {
    protocolVersion: known(schedule.protocol.version),
    protocolHash: known(schedule.protocol.hash),
    fixtureVersion: known(schedule.cases.version),
    fixtureHash: known(schedule.cases.materialHash),
    codeRevision: schedule.codeRevision,
  }

  const runSlot = async (slot: AdversarialSlot): Promise<void> => {
    const material = cases[slot.caseIndex]!
    const label = `${slot.caseId} ${slot.side}`
    const worktree = worktreeFor(root, slot)
    if ((await mark(slot, "started", `the ${label} run started`, { worktree })) !== null) {
      await mark(slot, "not-attempted", ended!)
      return
    }

    const written = await materializeSide({
      directory: worktree,
      baseTree: material.baseTree,
      change: material[slot.side],
      ...(input.git === undefined ? {} : { git: input.git }),
    })
    if (!written.ok) {
      await mark(slot, "failed", `the ${label} worktree could not be written, so nothing was issued: ${written.reason}`)
      return
    }
    const contained = await containmentProblem(directory, worktree)
    if (contained !== null) {
      endWith(`the ${label} worktree failed the AD-16 containment check: ${contained}`)
      await mark(slot, "failed", `the ${label} worktree failed the AD-16 containment check, so nothing was issued: ${contained}`)
      return
    }

    // ONE OBSERVER VALUE, handed to the adapter and to `review()` below. Either
    // half alone is half a trace.
    //
    // IT REFUSES TO BUILD over a trace file an earlier operation has not let go
    // of (story 2-7c). Sixteen runs share one `tool-trace.jsonl`, so a slot that
    // appended and never heard back leaves a file no later slot may touch.
    let observer: ReturnType<typeof createToolTraceSink>
    try {
      observer = createToolTraceSink({
        file: traceFile,
        binding: { caseId: slot.caseId, side: slot.side, position: slot.position },
        ...(input.traceIo === undefined ? {} : { io: input.traceIo }),
        ...(input.traceTimeoutMs === undefined ? {} : { operationTimeoutMs: input.traceTimeoutMs }),
        ...(input.observationTimeoutMs === undefined ? {} : { callerTimeoutMs: input.observationTimeoutMs }),
        onUnresolved: (fact) =>
          quarantine(
            `the ${label} run left an UNRESOLVED trace operation: ${fact.why}; no further run may ` +
              `append to that file and recovery is manual`,
          ),
      })
    } catch (error) {
      // A REFUSAL IS NOT A QUARANTINE. `TraceUnresolvedError` means an earlier
      // operation still holds the file, which is the state this run must stop
      // for. Every other construction failure — a deadline this suite was built
      // with, an inverted nesting — is a fault in MAD's own wiring, and
      // stranding sixteen slots behind a retained lock for a number someone
      // mistyped would make a configuration mistake indistinguishable from a
      // process nobody can account for.
      if (error instanceof TraceUnresolvedError) {
        quarantine(`the ${label} run could not open the tool trace: ${messageOf(error)}`)
      }
      await mark(slot, "failed", `the ${label} run could not open the tool trace, so nothing was issued: ${messageOf(error)}`)
      return
    }
    // THE SHARED-`$` HAZARD, AND WHY IT DOES NOT BITE HERE. Bun's `$` is one
    // object whose `.cwd()` retains its argument, so two adapters over one shell
    // can take each other's directory. `blame` does not go through the shell —
    // `adapters/opencode/blame-exec.ts` launches it with an explicit working
    // directory — so no run can move another run's `$`. The shell is handed over
    // because `opencodeTools` keeps it on its construction surface, and these
    // runs stay strictly sequential.
    const tools = opencodeTools({
      $: input.shell,
      worktree,
      toolObservation: observer,
      ...(input.observationTimeoutMs === undefined ? {} : { observationTimeoutMs: input.observationTimeoutMs }),
      clock: input.clock,
      ...(input.blameTimeoutMs === undefined ? {} : { blameTimeoutMs: input.blameTimeoutMs }),
      ...(input.blameCleanupTimeoutMs === undefined ? {} : { blameCleanupTimeoutMs: input.blameCleanupTimeoutMs }),
      ...(input.observationTimeoutMs === undefined ? {} : { observationTimeoutMs: input.observationTimeoutMs }),
      ...(input.spawnBlame === undefined ? {} : { spawn: input.spawnBlame }),
      onCleanupUnresolved: (fact) =>
        quarantine(
          `the ${label} run could not confirm that a process it launched terminated: ${fact.why}; ` +
            `check process ${fact.pid} by hand before anything else is run here`,
        ),
    })

    let runId: string | undefined
    const runClock: Clock = {
      now: () => input.clock.now(),
      id: (prefix) => {
        const id = input.clock.id(prefix)
        if (prefix === "run" && runId === undefined) runId = id
        return id
      },
    }
    const sink = createLateUsageSink()
    const recorder = createTurnRecorder()
    const probe = deliveryProbe(slot.side === "attack" ? material.payload : null)
    let result: ReviewResult | undefined
    let failure: string | undefined
    try {
      const backend = probe.wrap(recorder.wrap(input.backendFor({ caseId: slot.caseId, side: slot.side, position: slot.position }, journal.reporter(sink))))
      result = await review({
        roster: input.roster,
        backend,
        clock: runClock,
        change: material[slot.side],
        priorWarnings: (input.priorWarnings ?? []).map((warning) => ({ ...warning })),
        tokenCap: ADVERSARIAL_ALLOWANCES.runCap,
        stopOnUnknownUsage: true,
        ...(input.config.maxConcurrency === undefined ? {} : { maxConcurrency: input.config.maxConcurrency }),
        tools,
        toolObservation: observer,
      ...(input.observationTimeoutMs === undefined ? {} : { observationTimeoutMs: input.observationTimeoutMs }),
        lateUsage: sink,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        admission: journal.adversarialAdmission({ label, runId: () => runId }),
      })
    } catch (error) {
      failure = messageOf(error) || "the run threw an error with no message"
    }
    await journal.settled()

    const counts = probe.counts()
    const delivery: DeliveryEvidence | undefined =
      slot.side === "attack" ? deliveryOf(material, result?.record, counts) : undefined

    if (result === undefined) {
      if (input.signal?.aborted) endWith(`the run was cancelled during ${label}`)
      await mark(slot, "failed", `the ${label} run threw before it returned a record: ${failure}`, {
        ...(runId === undefined ? {} : { runId }),
        ...(delivery === undefined ? {} : { delivery }),
      })
    } else {
      const binding: AdversarialBinding = {
        scheduleHash: schedule.scheduleHash,
        caseId: slot.caseId,
        side: slot.side,
        position: slot.position,
      }
      const manifest = await writeArmDump({
        bundleRoot: directory,
        run: {
          spec: { id: slot.side, label: `${slot.side} side`, provenance: input.config.provenance, slots: 1 },
          repeat: slot.caseIndex,
          record: result.record,
          rendered: result.rendered,
        },
        change: material[slot.side],
        identity,
        turns: recorder.turns,
        worktree,
        adversarial: binding,
      })
      if (manifest.kind !== "written") endWith(`the manifest for ${label} was not written: ${manifestReason(manifest)}`)
      const cancelled = result.record.cancelled !== undefined
      if (cancelled || input.signal?.aborted) endWith(`the run was cancelled during ${label}`)
      const denied = cancelled ? null : deniedAdversarialWork(result.record, journal.bill().refusedAdversarial, label)
      await mark(
        slot,
        cancelled ? "cancelled" : denied !== null ? "failed" : "completed",
        cancelled
          ? `the run was cancelled during the ${result.record.cancelled!.stage} stage of ${label}`
          : denied !== null
            ? `the ${label} run returned, but a gate denied it planned work: ${denied}`
            : `the ${label} run finished`,
        { runId: result.record.runId, manifest, ...(delivery === undefined ? {} : { delivery }) },
      )
    }

    const bill = journal.bill()
    if (bill.halt !== null) endWith(`the experiment halted: ${bill.halt}`)
    else if (bill.stop !== null) endWith(`the runner stopped: ${bill.stop}`)
    else {
      const inFlight = bill.inFlight.filter((request) => request.runId === runId).length
      if (inFlight > 0) endWith(`${label} left ${inFlight} request(s) issued and unsettled, so its cost is not accounted`)
    }
  }

  try {
    for (const slot of schedule.slots) {
      if (ended === null && input.signal?.aborted) endWith(`the run was cancelled before ${slot.caseId} ${slot.side} started`)
      if (ended !== null) {
        await mark(slot, "not-attempted", ended)
        continue
      }
      await runSlot(slot)
    }
  } catch (error) {
    endWith(`the adversarial runner failed: ${messageOf(error)}`)
    warnings.push(`the adversarial runner failed: ${messageOf(error)}`)
  }
  for (const slot of schedule.slots) {
    const report = reports.get(slot.position)
    if (report === undefined) await mark(slot, "not-attempted", ended ?? "the runner ended before this slot")
    else if (report.status === "started") await mark(slot, "failed", ended ?? "the runner ended while this slot was running")
  }

  const { handle, releaseError, lockRetained } = await journal.close()
  if (releaseError !== null) warnings.push(releaseError)
  if (lockRetained) {
    warnings.push(
      `the experiment lock was NOT released: this bundle is quarantined and the lock is what stops a ` +
        `second writer appending beside a process or a file operation nobody can account for. Release ` +
        `it by hand once the named process and file state have been checked.`,
    )
  }
  const bill = handle.bill()
  const billProblem = await writeAdversarialBill(root, billSummaryOf(schedule.scheduleHash, bill, now(input.clock)))
  if (billProblem !== null) warnings.push(billProblem)
  const slots = schedule.slots.map((slot) => reports.get(slot.position)!)
  const complete =
    slots.every((slot) => slot.status === "completed") &&
    bill.halt === null &&
    bill.stop === null &&
    bill.unknown.length === 0 &&
    bill.uncertain.length === 0 &&
    bill.inFlight.length === 0
  return {
    ok: true,
    schedule,
    slots,
    bill,
    overshoot: bill.overshoot,
    governor: governorStateFromBill(bill),
    complete,
    reconciliation: handle,
    warnings,
  }
}

/**
 * What a gate denied a returned adversarial run, or `null`: discovery slots
 * skipped for budget, findings stranded by anything but a cancellation, and any
 * refused adversarial admission of this run.
 */
export function deniedAdversarialWork(record: RunRecord, refused: readonly AdversarialRefusal[], label: string): string | null {
  const parts: string[] = []
  const skipped = record.skippedForBudget ?? []
  if (skipped.length > 0) parts.push(`discovery skipped ${skipped.join(", ")} for budget`)
  const stranded = record.findings.filter(
    (finding) => finding.unresolved !== undefined && !finding.unresolved.reason.startsWith("the run was cancelled"),
  ).length
  if (stranded > 0) parts.push(`${stranded} finding(s) were left unresolved`)
  const refusals = refused.filter((refusal) => refusal.label === label)
  if (refusals.length > 0) {
    const first = refusals[0]!
    parts.push(
      `${refusals.length} admission(s) were refused, beginning with ${first.stage}/${first.slot} attempt ${first.attempt} ` +
        `(${first.cause}): ${first.reason}`,
    )
  }
  return parts.length === 0 ? null : parts.join("; ")
}

/** The durable summary of the journal's bill for the reader. */
export function billSummaryOf(scheduleHash: string, bill: UniqueExecutionBill, at: string): AdversarialBillSummary {
  return {
    scheduleHash,
    at,
    adversarialKnown: bill.overshoot.adversarial.spent,
    globalKnown: bill.overshoot.global.spent,
    overshoot: { global: { ...bill.overshoot.global }, adversarial: { ...bill.overshoot.adversarial } },
    unknown: bill.unknown.filter((request) => request.category === "adversarial").length,
    uncertain: bill.uncertain.filter((request) => request.category === "adversarial").length,
    inFlight: bill.inFlight.filter((request) => request.category === "adversarial").length,
    refused: bill.refusedAdversarial.map((refusal) => ({ label: refusal.label, stage: refusal.stage, cause: refusal.cause, reason: refusal.reason })),
    halt: bill.halt,
    stop: bill.stop,
    operational: [...bill.operational],
  }
}

function now(clock: Clock): string {
  try {
    return clock.now()
  } catch (error) {
    return `unknown (the clock failed: ${messageOf(error)})`
  }
}

function manifestReason(outcome: ArtifactOutcome): string {
  switch (outcome.kind) {
    case "refused":
      return outcome.reason
    case "failed":
      return outcome.error
    case "off":
      return "artifact writing was off"
    default:
      return "written"
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
