/**
 * Story 2-5c — `runPairedBlocks`, the library runner for the three paired blocks
 * of `evaluation-protocol.md` §4.
 *
 * One invocation executes one sealed schedule (`ablation/schedule.ts`), once:
 *
 * 1. take the bundle root's lock; refuse when the start marker exists;
 * 2. verify the schedule against this runner's own protocol, fixture, code
 *    revision, roster, change and config;
 * 3. write the start marker without overwrite, before anything can bill;
 * 4. for each block in order: `prepareReview` (the shared prefix), then
 *    `forkPreparedReview(…, 2)`, then `continueReview` for the two arms in the
 *    scheduled order, `shipped` for ON and `debate-off` for OFF;
 * 5. write one manifest per arm that produced a run record;
 * 6. close the journal and return a reconciliation handle for late usage.
 *
 * Every billable request passes the ordinary stage gate (each run's ledger is
 * capped at 255,000 with the shipped shares) and the journal's admission gates:
 * the phase allowance (60,000 prefix, 195,000 per continuation, new consumption
 * only), the Blocks allowance, the global cap and the halt.
 *
 * ## What is never done
 *
 * No wrapper retry. No prefix, continuation or block is restarted or replaced.
 * No fork is pretended: a prefix that threw, was cancelled, or ended with a halt,
 * a runner stop or unsettled requests is not forked, and both of its arm slots
 * are recorded `not-attempted` with that reason. No manifest is written for a run
 * that has no record. Every issued request stays in the journal whatever happens.
 *
 * ## When a later block runs
 *
 * Only after a non-cancelled outcome with every request settled and no halt or
 * runner stop. A prefix that threw with everything settled leaves its block
 * unforked and the next block runs. Cancellation, a halt or a runner stop ends
 * admission, and every remaining slot is `not-attempted` with the reason.
 *
 * Verified with fakes only; see `ablation/LIVE-RUN.md` for what that does not
 * establish about a real host.
 */

import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import type { Preset } from "../core/budget/presets.ts"
import type { Roster } from "../core/domain/roster.ts"
import type { RunRecord } from "../core/domain/run-record.ts"
import type { Warning } from "../core/domain/warning.ts"
import type { Clock } from "../core/ports/clock.ts"
import { createLateUsageSink, type LateUsageReporter } from "../core/ports/late-usage.ts"
import type { ModelBackend } from "../core/ports/model-backend.ts"
import type { ChangeSet } from "../core/ports/repo.ts"
import type { Tools } from "../core/ports/tools.ts"
import {
  continueReview,
  forkPreparedReview,
  prepareReview,
  type PreparedReview,
  type ReviewResult,
} from "../core/run/review.ts"
import type { ArtifactOutcome } from "../adapters/opencode/artifacts.ts"
import type { LabelledChangeSeal } from "../fixtures/seeded-defects/seal.ts"
import type { ArmRun } from "./arms.ts"
import { writeArmDump, writeBundleIndex } from "./bundle.ts"
import { governorStateFromBill, PAIRED_ALLOWANCES, type ExperimentGovernorState, type PairedPhase } from "./governor.ts"
import {
  acquireLock,
  openJournal,
  type OvershootReport,
  type PairedJournal,
  type ReconciliationHandle,
  type UniqueExecutionBill,
} from "./journal.ts"
import { known, type CodeRevision, type ExperimentBinding, type Maybe } from "./manifest.ts"
import {
  appendSlotStatus,
  START_MARKER_FILE,
  verifySchedule,
  writeStartMarker,
  type PairedConfig,
  type PairedSchedule,
  type PlannedSlot,
  type SlotStatus,
} from "./schedule.ts"

/** The phase a backend is built for. */
export interface PairedPhaseContext {
  block: number
  phase: PairedPhase
}

export interface RunPairedBlocksInput {
  bundleRoot: string
  /** The reviewed worktree; the bundle root must lie outside it (AD-16). */
  worktree: string
  protocolFile: string
  fixture: LabelledChangeSeal
  codeRevision: Maybe<CodeRevision>
  roster: Roster
  /** The roster's own warnings, handed to every prefix. */
  priorWarnings?: Warning[]
  change: ChangeSet
  config: PairedConfig
  clock: Clock
  tools?: Tools
  signal?: AbortSignal
  /**
   * A backend for one phase. `lateUsage` is the runner's reporter for that phase:
   * each report reaches the run's own sink and, as a separate copy, the journal.
   * Execution ids must be unique across every backend of one invocation; a
   * collision is recorded as an integrity failure and halts.
   */
  backendFor(context: PairedPhaseContext, lateUsage: LateUsageReporter): ModelBackend
}

/** The final status of one planned arm slot. */
export interface SlotReport extends PlannedSlot {
  status: SlotStatus
  reason: string
  runId?: string
  /** Present only for a slot whose run produced a record. */
  manifest?: ArtifactOutcome
}

export interface PairedArmRun {
  slot: PlannedSlot
  run: ArmRun
  prefixRunId: string
}

export interface PrefixReport {
  block: number
  /** Absent when `prepareReview` threw before returning a record. */
  runId?: string
  forked: boolean
  reason: string
}

export type PairedBlocksOutcome =
  | { ok: false; reason: string }
  | {
      ok: true
      schedule: PairedSchedule
      /** All six planned slots, in schedule order. */
      slots: SlotReport[]
      prefixes: PrefixReport[]
      runs: PairedArmRun[]
      /** The journal's unique-execution bill as the invocation closed. */
      bill: UniqueExecutionBill
      /**
       * Known spend past each threshold: per block prefix, per continuation, the
       * Blocks allowance and the global cap. Admitted work may overshoot; this is
       * where it is reported. The same figures as `bill.overshoot`.
       */
      overshoot: OvershootReport
      /** The halt and known spend, presented from `bill`. */
      governor: ExperimentGovernorState & { runnerStop: string | null }
      /**
       * True only when all six slots completed, no halt or runner stop latched and
       * no request is unknown, uncertain or in flight. Otherwise the evaluation is
       * incomplete and no bill equation holds.
       */
      complete: boolean
      /** The caller owns late usage from here on; see `ReconciliationHandle`. */
      reconciliation: ReconciliationHandle
      /** A problem releasing the lock or recording status, if one occurred. */
      warnings: string[]
    }

export async function runPairedBlocks(input: RunPairedBlocksInput): Promise<PairedBlocksOutcome> {
  const root = resolve(input.bundleRoot)
  const taken = await acquireLock(root, input.clock.now())
  if (!taken.ok) return { ok: false, reason: taken.reason }
  const lock = taken.lock
  const refuse = async (reason: string): Promise<PairedBlocksOutcome> => {
    const releaseError = await lock.release()
    return { ok: false, reason: releaseError === null ? reason : `${reason}; ${releaseError}` }
  }

  const marker = join(root, START_MARKER_FILE)
  try {
    await readFile(marker)
    return refuse(`the schedule was already started (\`${marker}\` exists); a started schedule is never executed again`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return refuse(`whether \`${marker}\` exists could not be established: ${messageOf(error)}`)
    }
  }

  if ((input.tools === undefined) !== (input.config.tools === undefined)) {
    return refuse(
      input.tools === undefined
        ? "the config names a Tools identity, but no Tools port was supplied"
        : "a Tools port was supplied, but the config names no Tools identity for the schedule to bind",
    )
  }
  const verified = await verifySchedule(root, input)
  if (!verified.ok) return refuse(verified.reason)
  const schedule = verified.schedule

  // The bundle index carries AD-16's containment check. It runs before the start
  // marker, so a bundle root that may not be written does not burn the schedule.
  const index = await writeBundleIndex({
    bundleRoot: root,
    worktree: input.worktree,
    arms: schedule.slots.map((slot) => ({ armId: slot.arm, repeatId: slot.block - 1 })),
    createdAt: input.clock.now(),
  })
  if (!index.ok) return refuse(`the bundle index could not be written: ${index.reason}`)

  const opened = await openJournal(root, lock, () => input.clock.now())
  if (!opened.ok) return refuse(opened.reason)
  const journal = opened.journal

  const started = await writeStartMarker(root, schedule.scheduleHash, input.clock.now())
  if (!started.ok) {
    const { releaseError } = await journal.close()
    return { ok: false, reason: releaseError === null ? started.reason : `${started.reason}; ${releaseError}` }
  }

  return execute(input, root, schedule, journal)
}

async function execute(
  input: RunPairedBlocksInput,
  root: string,
  schedule: PairedSchedule,
  journal: PairedJournal,
): Promise<PairedBlocksOutcome> {
  const warnings: string[] = []
  const reports = new Map<string, SlotReport>()
  const keyOf = (slot: PlannedSlot): string => `${slot.block}:${slot.arm}`
  const prefixes: PrefixReport[] = []
  const runs: PairedArmRun[] = []
  const config = input.config

  /** Once set, admission has ended and every remaining slot is not attempted for this reason. */
  let ended: string | null = null
  const endWith = (reason: string): void => {
    ended ??= reason
    journal.stopAdmitting(reason)
  }

  /**
   * Record a slot status, in memory and durably. A status that cannot be
   * recorded ends admission: a slot whose start is not on disk must not run, and
   * the reason is returned so the caller can skip it.
   */
  const mark = async (
    slot: PlannedSlot,
    status: SlotStatus,
    reason: string,
    extra: Partial<SlotReport> = {},
  ): Promise<string | null> => {
    const previous = reports.get(keyOf(slot))
    const report: SlotReport = { ...previous, ...slot, status, reason, ...extra }
    reports.set(keyOf(slot), report)
    let at: string
    try {
      at = input.clock.now()
    } catch (error) {
      at = `unknown (the clock failed: ${messageOf(error)})`
    }
    const problem = await appendSlotStatus(root, {
      ...slot,
      status,
      reason,
      at,
      ...(report.runId === undefined ? {} : { runId: report.runId }),
    })
    if (problem !== null) {
      warnings.push(problem)
      endWith(`a slot status could not be recorded: ${problem}`)
    }
    return problem
  }

  /** The reason no further block may start, read off the journal. */
  const blocker = (block: number, phase: PairedPhase): string | null => {
    const bill = journal.bill()
    if (bill.halt !== null) return `the experiment halted: ${bill.halt}`
    if (bill.stop !== null) return `the runner stopped: ${bill.stop}`
    const inFlight = bill.inFlight.filter((request) => request.block === block && request.phase === phase).length
    if (inFlight > 0) {
      return `block ${block}'s ${phase} left ${inFlight} request(s) issued and unsettled, so its cost is not accounted`
    }
    return null
  }

  const identity = {
    protocolVersion: known(schedule.protocol.version),
    protocolHash: known(schedule.protocol.hash),
    fixtureVersion: known(schedule.fixture.version),
    fixtureHash: known(schedule.fixture.materialHash),
    codeRevision: schedule.codeRevision,
  }

  const runBlocks = async (): Promise<void> => {
    for (const block of [...new Set(schedule.slots.map((slot) => slot.block))]) {
      const planned = schedule.slots.filter((slot) => slot.block === block)
      if (ended === null && input.signal?.aborted) endWith(`the run was cancelled before block ${block} started`)
      if (ended !== null) {
        for (const slot of planned) await mark(slot, "not-attempted", ended)
        continue
      }

      // ---- the shared prefix ----
      let prefixRunId: string | undefined
      const prefixClock: Clock = {
        now: () => input.clock.now(),
        id: (prefix) => {
          const id = input.clock.id(prefix)
          if (prefix === "run" && prefixRunId === undefined) prefixRunId = id
          return id
        },
      }
      let prepared: PreparedReview | undefined
      let threw: string | undefined
      try {
        prepared = await prepareReview({
          roster: input.roster,
          backend: input.backendFor({ block, phase: "prefix" }, journal.reporter()),
          clock: prefixClock,
          change: input.change,
          // Copied one level, not cloned: a caller's `warning.detail` is kept as
          // it came, and a value that cannot be copied is refused by the fork.
          priorWarnings: (input.priorWarnings ?? []).map((warning) => ({ ...warning })),
          ...runDials(config),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          admission: journal.admission({ block, phase: "prefix", runId: () => prefixRunId }),
        })
      } catch (error) {
        threw = messageOf(error)
      }
      await journal.settled()

      const stopped =
        (prepared !== undefined && (prepared.record.cancelled !== undefined || prepared.stopRequested)) ||
        (threw !== undefined && input.signal?.aborted === true)
      const blocked = blocker(block, "prefix")
      const noFork =
        threw !== undefined
          ? `the shared prefix failed before it could be forked: ${threw}`
          : stopped
            ? `the run was cancelled during block ${block}'s shared prefix`
            : blocked
      if (noFork !== null) {
        prefixes.push({ block, ...(prepared === undefined ? {} : { runId: prepared.record.runId }), forked: false, reason: noFork })
        if (stopped) endWith(`the run was cancelled during block ${block}'s shared prefix`)
        if (blocked !== null) endWith(blocked)
        for (const slot of planned) await mark(slot, "not-attempted", noFork)
        continue
      }

      let branches: PreparedReview[]
      try {
        branches = forkPreparedReview(prepared!, input.clock, 2)
      } catch (error) {
        const reason = `block ${block}'s shared prefix could not be forked: ${messageOf(error)}`
        prefixes.push({ block, runId: prepared!.record.runId, forked: false, reason })
        for (const slot of planned) await mark(slot, "not-attempted", reason)
        continue
      }
      const prefixId = prepared!.record.runId
      prefixes.push({ block, runId: prefixId, forked: true, reason: "forked into the scheduled ON and OFF continuations" })

      // ---- the two continuations, in scheduled order ----
      for (const [position, slot] of planned.entries()) {
        if (ended !== null) {
          await mark(slot, "not-attempted", ended)
          continue
        }
        const branch = branches[position]!
        const runId = branch.record.runId
        const unrecorded = await mark(slot, "started", `the ${slot.arm.toUpperCase()} continuation of block ${block} started`, { runId })
        if (unrecorded !== null) {
          // The start is not on disk, so the continuation does not run.
          await mark(slot, "not-attempted", ended!)
          continue
        }

        const sink = createLateUsageSink()
        let backend: ModelBackend | undefined
        let result: ReviewResult | undefined
        let failure: string | undefined
        try {
          backend = input.backendFor({ block, phase: slot.arm }, journal.reporter(sink))
          result = await continueReview(
            branch,
            {
              backend,
              clock: input.clock,
              lateUsage: sink,
              ...(input.tools === undefined ? {} : { tools: input.tools }),
              ...(input.signal === undefined ? {} : { signal: input.signal }),
              admission: journal.admission({ block, phase: slot.arm, runId: () => runId }),
            },
            slot.arm === "on" ? "shipped" : "debate-off",
          )
        } catch (error) {
          failure = messageOf(error)
        }
        await journal.settled()

        if (result === undefined) {
          if (input.signal?.aborted) endWith(`the run was cancelled during block ${block}`)
          await mark(slot, "failed", `the ${slot.arm.toUpperCase()} continuation threw: ${failure}`)
        } else {
          const run: ArmRun = {
            spec: { id: slot.arm, label: slot.arm === "on" ? "debate on" : "debate off", provenance: config.provenance, slots: input.roster.slots.length },
            repeat: block - 1,
            record: result.record,
            rendered: result.rendered,
            backend: backend!,
          }
          runs.push({ slot, run, prefixRunId: prefixId })
          const experiment: ExperimentBinding = {
            scheduleHash: schedule.scheduleHash,
            block,
            arm: slot.arm,
            position: slot.position,
            prefixRunId: prefixId,
          }
          const problem = bindingProblem(schedule, experiment, result.record)
          const manifest: ArtifactOutcome =
            problem !== null
              ? { kind: "refused", reason: problem }
              : await writeArmDump({ bundleRoot: root, run, change: input.change, identity, worktree: input.worktree, experiment })
          const cancelled = result.record.cancelled !== undefined
          if (cancelled || input.signal?.aborted) endWith(`the run was cancelled during block ${block}`)
          if (manifest.kind !== "written") {
            endWith(`the manifest for block ${block} ${slot.arm.toUpperCase()} was not written: ${manifestReason(manifest)}`)
          }
          await mark(
            slot,
            cancelled ? "cancelled" : "completed",
            cancelled
              ? `the run was cancelled during the ${result.record.cancelled!.stage} stage of block ${block}'s ${slot.arm.toUpperCase()} continuation`
              : `the ${slot.arm.toUpperCase()} continuation of block ${block} finished`,
            { manifest },
          )
        }
        const reason = blocker(block, slot.arm)
        if (reason !== null) endWith(reason)
      }
    }
  }

  try {
    await runBlocks()
  } catch (error) {
    // Anything that escaped the per-phase handling still ends admission and
    // still reaches `close()`, so the lock is released and every slot is given a
    // terminal status below.
    endWith(`the runner failed: ${messageOf(error)}`)
    warnings.push(`the runner failed: ${messageOf(error)}`)
  }
  for (const slot of schedule.slots) {
    const report = reports.get(keyOf(slot))
    if (report === undefined) await mark(slot, "not-attempted", ended ?? "the runner ended before this slot")
    else if (report.status === "started") await mark(slot, "failed", ended ?? "the runner ended while this slot was running")
  }

  const bill = journal.bill()
  const { handle, releaseError } = await journal.close()
  if (releaseError !== null) warnings.push(releaseError)
  const slots = schedule.slots.map((slot) => reports.get(keyOf(slot))!)
  const complete =
    slots.every((slot) => slot.status === "completed") &&
    bill.halt === null &&
    bill.unknown.length === 0 &&
    bill.uncertain.length === 0 &&
    bill.inFlight.length === 0 &&
    bill.stop === null
  return {
    ok: true,
    schedule,
    slots,
    prefixes,
    runs,
    bill,
    overshoot: bill.overshoot,
    governor: governorStateFromBill(bill),
    complete,
    reconciliation: handle,
    warnings,
  }
}

/** The dials every prefix receives; continuations inherit them from the prefix record. */
function runDials(config: PairedConfig): {
  tokenCap: number
  stopOnUnknownUsage: true
  threshold?: number
  maxRounds?: number
  maxConcurrency?: number
  preset?: Preset
} {
  return {
    tokenCap: PAIRED_ALLOWANCES.runCap,
    stopOnUnknownUsage: true,
    ...(config.threshold === undefined ? {} : { threshold: config.threshold }),
    ...(config.maxRounds === undefined ? {} : { maxRounds: config.maxRounds }),
    ...(config.maxConcurrency === undefined ? {} : { maxConcurrency: config.maxConcurrency }),
    ...(config.preset === undefined ? {} : { preset: config.preset }),
  }
}

/**
 * Why a manifest's `experiment` block would misstate its run, or `null`. The
 * slot must be one the schedule planned, and the prefix must be the run's own
 * parent.
 */
export function bindingProblem(schedule: PairedSchedule, experiment: ExperimentBinding, record: RunRecord): string | null {
  if (experiment.scheduleHash !== schedule.scheduleHash) return "its schedule hash is not the sealed schedule's"
  const planned = schedule.slots.some(
    (slot) => slot.block === experiment.block && slot.arm === experiment.arm && slot.position === experiment.position,
  )
  if (!planned) {
    return `block ${experiment.block} ${experiment.arm} ${experiment.position} is not a slot the sealed schedule planned`
  }
  if (record.forkedFrom !== experiment.prefixRunId) {
    return `its prefix \`${experiment.prefixRunId}\` is not the run's forkedFrom \`${String(record.forkedFrom)}\``
  }
  return null
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
