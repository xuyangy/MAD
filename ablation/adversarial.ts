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
 * `tool-trace.jsonl`, the bundle index, the dumps and the worktrees. It never
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

import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import type { PluginInput } from "@opencode-ai/plugin"

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
  writeAdversarialStartMarker,
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
  type OvershootReport,
  type PairedJournal,
  type ReconciliationHandle,
  type UniqueExecutionBill,
} from "./journal.ts"
import { known, type AdversarialBinding, type CodeRevision, type Maybe } from "./manifest.ts"
import { SCHEDULE_FILE, START_MARKER_FILE, type SlotStatus } from "./schedule.ts"
import { createToolTraceSink, TOOL_TRACE_FILE, type TraceIo } from "./tool-trace.ts"

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

async function probeFile(file: string): Promise<Probe> {
  try {
    await readFile(file)
    return { kind: "present" }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { kind: "absent" }
    if (code === "EISDIR") return { kind: "present" }
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
 * The walk up stops, without refusing, at an ancestor it may not look into
 * (`EACCES`) or that is not a directory (`ENOTDIR`): nothing above that point
 * is readable to this process, so no experiment root there could be shared
 * with it either. Any other error refuses.
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
        if (found.code === "EACCES" || found.code === "ENOTDIR") return null
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
 * A request counts once `runTurn` resolved with an envelope that answered or
 * was billed (`ok`, `tokens` or `usageUnknown`). An envelope with none of those
 * never went out. A `runTurn` that threw is `uncertain`: it may or may not have
 * gone out, and it is never counted as sent.
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

/** The last stage the record shows ran. */
export function furthestStage(record: RunRecord | undefined, requests: number): ReachedStage {
  if (record?.judgeCounts !== undefined) return "judge"
  if (record?.debateCounts !== undefined) return "debate"
  if (record?.routeCounts !== undefined) return "route"
  return requests > 0 ? "discover" : "none"
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
    const releaseError = journal === undefined ? await lock.release() : (await journal.close()).releaseError
    return { ok: false, reason: releaseError === null ? reason : `${reason}; ${releaseError}` }
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

  const mark = async (
    slot: AdversarialSlot,
    status: SlotStatus,
    reason: string,
    extra: Partial<AdversarialSlotReport> = {},
  ): Promise<string | null> => {
    const report: AdversarialSlotReport = { ...reports.get(slot.position), ...slot, status, reason, ...extra }
    reports.set(slot.position, report)
    let at: string
    try {
      at = input.clock.now()
    } catch (error) {
      at = `unknown (the clock failed: ${messageOf(error)})`
    }
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
    const observer = createToolTraceSink({
      file: traceFile,
      binding: { caseId: slot.caseId, side: slot.side, position: slot.position },
      ...(input.traceIo === undefined ? {} : { io: input.traceIo }),
    })
    // THE SHARED-`$` HAZARD: `opencodeTools` calls `$.cwd(worktree)`, and Bun's
    // `$` keeps that directory for every later caller of the same object. Runs
    // are strictly sequential here and each one rebinds `$` to its own worktree
    // before any blame runs, so no run blames in another run's worktree. Making
    // these runs concurrent would break that.
    const tools = opencodeTools({ $: input.shell, worktree, toolObservation: observer, clock: input.clock })

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

  const { handle, releaseError } = await journal.close()
  if (releaseError !== null) warnings.push(releaseError)
  const bill = handle.bill()
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
export function deniedAdversarialWork(
  record: RunRecord,
  refused: readonly { label: string; stage: string; slot: string; attempt: number; cause: string; reason: string }[],
  label: string,
): string | null {
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
