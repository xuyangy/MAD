/**
 * Story 2-5c — `runPairedBlocks`, the library runner for the three paired blocks
 * of `evaluation-protocol.md` §4.
 *
 * One invocation executes one sealed schedule (`ablation/schedule.ts`), once:
 *
 * 1. take the bundle root's lock; refuse when the start marker exists;
 * 2. verify the schedule against this runner's own protocol, fixture, code
 *    revision, roster, change and config;
 * 3. open the journal, and refuse when it is already halted or stopped;
 * 4. write the start marker without overwrite, before anything can bill;
 * 5. for each block in order: `prepareReview` (the shared prefix), then
 *    `forkPreparedReview(…, 2)`, then `continueReview` for the two arms in the
 *    scheduled order, `shipped` for ON and `debate-off` for OFF;
 * 6. write the evidence of every run that produced a record;
 * 7. close the journal and return a reconciliation handle for late usage.
 *
 * Every billable request passes the ordinary stage gate (each run's ledger is
 * capped at 255,000 with the shipped shares) and the journal's admission gates:
 * the phase allowance (60,000 prefix, 195,000 per continuation, new consumption
 * only), the Blocks allowance, the global cap and the halt.
 *
 * ## Evidence
 *
 * Every record a run produced is written, including a partial one:
 *
 * - each arm slot whose continuation returned or threw gets one manifest with an
 *   `experiment` block. A thrown continuation's manifest carries the record the
 *   branch held when it threw and `experiment.failure`; no output or finish time
 *   is invented for it;
 * - each block's shared prefix gets `prefix/<block - 1>/prefix.json`, with the
 *   prefix record's dump beside it when there is a record (see
 *   `PrefixEvidence`).
 *
 * An evidence write that fails ends admission: nothing further runs, and every
 * remaining slot is `not-attempted` with that reason.
 *
 * ## What is never done
 *
 * No wrapper retry. No prefix, continuation or block is restarted or replaced.
 * No fork is pretended: a prefix that threw, was cancelled, or ended with a halt,
 * a runner stop or unsettled requests is not forked, and both of its arm slots
 * are recorded `not-attempted` with that reason. Every issued request stays in
 * the journal whatever happens.
 *
 * ## Slot statuses
 *
 * A continuation that returned is `completed` only when no gate denied it
 * planned work. When the run's ledger or an admission gate refused a request —
 * discovery slots skipped, findings stranded, or any refused admission in its
 * own phase or its block's prefix — it is `failed`, with what was denied, and the
 * evaluation is not complete (`evaluation-protocol.md`: a block that cannot
 * complete is recorded failed). Reaching a threshold with nothing refused is not
 * a denial.
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
import type { ArmRun, ArmSpec } from "./arms.ts"
import { writeArmDump, writeBundleIndex, writePrefixEvidence } from "./bundle.ts"
import { governorStateFromBill, PAIRED_ALLOWANCES, type ExperimentGovernorState, type PairedPhase } from "./governor.ts"
import {
  acquireLock,
  openJournal,
  type OvershootReport,
  type PairedJournal,
  type ReconciliationHandle,
  type RefusedAdmission,
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
  /** Where the prefix's evidence was written, or why it was not. */
  evidence: { ok: true; file: string; dump: string | null } | { ok: false; reason: string }
}

export type PairedBlocksOutcome =
  | { ok: false; reason: string }
  | {
      ok: true
      schedule: PairedSchedule
      /** All six planned slots, in schedule order. */
      slots: SlotReport[]
      prefixes: PrefixReport[]
      /** Continuations that returned a result. A thrown continuation is only in `slots`. */
      runs: PairedArmRun[]
      /** The journal's unique-execution bill after the invocation closed. */
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
  let prepared: { schedule: PairedSchedule; journal: PairedJournal }
  const refuse = async (reason: string): Promise<PairedBlocksOutcome> => {
    const releaseError = journal === undefined ? await lock.release() : (await journal.close()).releaseError
    return { ok: false, reason: releaseError === null ? reason : `${reason}; ${releaseError}` }
  }

  // Everything between taking the lock and executing is inside one `try`: a
  // lock left behind by a throw would refuse every later writer.
  try {
    const marker = join(root, START_MARKER_FILE)
    try {
      await readFile(marker)
      return await refuse(`the schedule was already started (\`${marker}\` exists); a started schedule is never executed again`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return await refuse(`whether \`${marker}\` exists could not be established: ${messageOf(error)}`)
      }
    }

    if ((input.tools === undefined) !== (input.config.tools === undefined)) {
      return await refuse(
        input.tools === undefined
          ? "the config names a Tools identity, but no Tools port was supplied"
          : "a Tools port was supplied, but the config names no Tools identity for the schedule to bind",
      )
    }
    if (input.config.tools !== undefined && input.config.tools.trim().length === 0) {
      return await refuse("the config's Tools identity is blank, so the schedule would bind no identifiable Tools configuration")
    }
    const verified = await verifySchedule(root, input)
    if (!verified.ok) return await refuse(verified.reason)
    const schedule = verified.schedule

    // The bundle index carries AD-16's containment check. It runs before the start
    // marker, so a bundle root that may not be written does not burn the schedule.
    const index = await writeBundleIndex({
      bundleRoot: root,
      worktree: input.worktree,
      arms: schedule.slots.map((slot) => ({ armId: slot.arm, repeatId: slot.block - 1 })),
      createdAt: input.clock.now(),
    })
    if (!index.ok) return await refuse(`the bundle index could not be written: ${index.reason}`)

    const opened = await openJournal(root, lock, () => input.clock.now())
    if (!opened.ok) return await refuse(opened.reason)
    journal = opened.journal

    // A journal that already refuses every request must not spend the schedule.
    const before = journal.bill()
    if (before.halt !== null) return await refuse(`the experiment is already halted, so the schedule was not started: ${before.halt}`)
    if (before.stop !== null) return await refuse(`the journal already stopped admitting, so the schedule was not started: ${before.stop}`)

    const started = await writeStartMarker(root, schedule.scheduleHash, input.clock.now())
    if (!started.ok) return await refuse(started.reason)
    prepared = { schedule, journal }
  } catch (error) {
    return await refuse(`the runner failed before the start marker was written: ${messageOf(error)}`)
  }
  // Outside the `try` above: once the schedule is started, `execute` owns the
  // journal, gives every slot a terminal status and returns the reconciliation
  // handle whatever happens inside it.
  return execute(input, root, prepared.schedule, prepared.journal)
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
  /** A slot reason that keeps its own cause and, when different, why admission ended. */
  const withEnded = (reason: string): string => (ended === null || ended === reason ? reason : `${reason}; ${ended}`)

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

  const specOf = (slot: PlannedSlot): ArmSpec => ({
    id: slot.arm,
    label: slot.arm === "on" ? "debate on" : "debate off",
    provenance: config.provenance,
    slots: input.roster.slots.length,
  })

  /** Write one arm slot's manifest, or the refusal that stopped it. */
  const writeManifest = async (
    slot: PlannedSlot,
    record: RunRecord,
    rendered: string,
    prefixId: string,
    failure?: string,
  ): Promise<ArtifactOutcome> => {
    const experiment: ExperimentBinding = {
      scheduleHash: schedule.scheduleHash,
      block: slot.block,
      arm: slot.arm,
      position: slot.position,
      prefixRunId: prefixId,
      ...(failure === undefined ? {} : { failure }),
    }
    const problem = bindingProblem(schedule, experiment, record)
    const manifest: ArtifactOutcome =
      problem !== null
        ? { kind: "refused", reason: problem }
        : await writeArmDump({
            bundleRoot: root,
            run: { spec: specOf(slot), repeat: slot.block - 1, record, rendered },
            change: input.change,
            identity,
            worktree: input.worktree,
            experiment,
          })
    if (manifest.kind !== "written") {
      endWith(`the manifest for block ${slot.block} ${slot.arm.toUpperCase()} was not written: ${manifestReason(manifest)}`)
    }
    return manifest
  }

  /** Write a prefix's evidence and report it; a failed write ends admission. */
  const recordPrefix = async (
    block: number,
    prefix: { record?: RunRecord; runId?: string; forked: boolean; reason: string; failure?: string },
  ): Promise<PrefixReport> => {
    const evidence = await writePrefixEvidence({
      bundleRoot: root,
      worktree: input.worktree,
      change: input.change,
      scheduleHash: schedule.scheduleHash,
      block,
      ...prefix,
    })
    if (!evidence.ok) endWith(`block ${block}'s prefix evidence was not written: ${evidence.reason}`)
    const runId = prefix.record?.runId ?? prefix.runId
    const report: PrefixReport = {
      block,
      ...(runId === undefined ? {} : { runId }),
      forked: prefix.forked,
      reason: prefix.reason,
      evidence,
    }
    prefixes.push(report)
    return report
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
        if (stopped) endWith(`the run was cancelled during block ${block}'s shared prefix`)
        if (blocked !== null) endWith(blocked)
        await recordPrefix(block, {
          ...(prepared === undefined ? {} : { record: prepared.record }),
          ...(prefixRunId === undefined ? {} : { runId: prefixRunId }),
          forked: false,
          reason: noFork,
          ...(threw === undefined ? {} : { failure: threw }),
        })
        for (const slot of planned) await mark(slot, "not-attempted", withEnded(noFork))
        continue
      }

      let branches: PreparedReview[]
      try {
        branches = forkPreparedReview(prepared!, input.clock, 2)
      } catch (error) {
        const reason = `block ${block}'s shared prefix could not be forked: ${messageOf(error)}`
        await recordPrefix(block, { record: prepared!.record, forked: false, reason, failure: messageOf(error) })
        for (const slot of planned) await mark(slot, "not-attempted", withEnded(reason))
        continue
      }
      const prefixId = prepared!.record.runId
      await recordPrefix(block, {
        record: prepared!.record,
        forked: true,
        reason: "forked into the scheduled ON and OFF continuations",
      })

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
          failure = messageOf(error) || "the continuation threw an error with no message"
        }
        await journal.settled()

        if (result === undefined) {
          if (input.signal?.aborted) endWith(`the run was cancelled during block ${block}`)
          // The record is what the branch held when it threw: the inherited
          // prefix plus whatever the continuation reached.
          const manifest = await writeManifest(
            slot,
            branch.record,
            `No report: the ${slot.arm.toUpperCase()} continuation of block ${block} threw before its output was ` +
              `assembled (${failure}). The record is what the branch held when it threw.\n`,
            prefixId,
            failure,
          )
          await mark(slot, "failed", `the ${slot.arm.toUpperCase()} continuation threw: ${failure}`, { manifest })
        } else {
          const run: ArmRun = {
            spec: specOf(slot),
            repeat: block - 1,
            record: result.record,
            rendered: result.rendered,
            backend: backend!,
          }
          runs.push({ slot, run, prefixRunId: prefixId })
          const manifest = await writeManifest(slot, result.record, result.rendered, prefixId)
          const cancelled = result.record.cancelled !== undefined
          if (cancelled || input.signal?.aborted) endWith(`the run was cancelled during block ${block}`)
          const denied = cancelled ? null : deniedWork(result.record, journal.bill().refused, block, slot.arm)
          await mark(
            slot,
            cancelled ? "cancelled" : denied !== null ? "failed" : "completed",
            cancelled
              ? `the run was cancelled during the ${result.record.cancelled!.stage} stage of block ${block}'s ${slot.arm.toUpperCase()} continuation`
              : denied !== null
                ? `the ${slot.arm.toUpperCase()} continuation of block ${block} returned, but a gate denied it planned work: ${denied}`
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

  // The bill is read after `close()` drained every queued append, so a failure
  // in that last drain is in `bill.stop`. Closing itself latches nothing.
  const { handle, releaseError } = await journal.close()
  if (releaseError !== null) warnings.push(releaseError)
  const bill = handle.bill()
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

/**
 * What a gate denied a returned continuation, or `null` when nothing was denied.
 *
 * Read from both authorities, because neither sees every refusal: the run's own
 * ledger refuses before an admission is asked (`mayISpend`), which only the
 * record shows, and an admission may refuse a request whose consequence the
 * record does not name (a refused retry, a refused logic evaluation). A prefix
 * denial counts for both of its branches, which inherit the prefix record. A
 * finding left unresolved by a cancellation is not a denial.
 */
export function deniedWork(
  record: RunRecord,
  refused: readonly RefusedAdmission[],
  block: number,
  arm: "on" | "off",
): string | null {
  const parts: string[] = []
  const skipped = record.skippedForBudget ?? []
  if (skipped.length > 0) parts.push(`discovery skipped ${skipped.join(", ")} for budget`)
  const stranded = record.findings.filter(
    (finding) => finding.unresolved !== undefined && !finding.unresolved.reason.startsWith("the run was cancelled"),
  ).length
  if (stranded > 0) parts.push(`${stranded} finding(s) were left unresolved`)
  // Every cause counts: a halted or stopped admission denied the work as surely as
  // an exhausted allowance did.
  const refusals = refused.filter(
    (refusal) =>
      refusal.block === block &&
      // One invocation runs one continuation per arm per block, so the phase names the run.
      (refusal.phase === "prefix" || refusal.phase === arm),
  )
  if (refusals.length > 0) {
    const first = refusals[0]!
    parts.push(
      `${refusals.length} admission(s) were refused, beginning with ${first.phase} ${first.stage}/${first.slot} ` +
        `attempt ${first.attempt} (${first.cause}): ${first.reason}`,
    )
  }
  return parts.length === 0 ? null : parts.join("; ")
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
