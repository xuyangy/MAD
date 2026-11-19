/**
 * `runVariantBlocks`, the runner for a sealed debate-variants schedule
 * (`ablation/variant-schedule.ts`, `ablation/DEBATE-VARIANTS.md`).
 *
 * It follows `runPairedBlocks`' lifecycle and shares its block loop
 * (`executeBlocks`):
 *
 * 1. take the bundle root's lock; refuse when the start marker exists;
 * 2. verify the schedule against this runner's own protocol, fixture, code
 *    revision, roster, change and config (`verifyVariantSchedule`), and read
 *    the sealed allowances;
 * 3. open the journal in the debate-variants scope with those allowances, and
 *    refuse when it is already halted or stopped;
 * 4. write the start marker without overwrite, before anything can bill;
 * 5. for each block in order: `prepareReview` (the shared prefix), then one
 *    fork per planned slot, then `continueReview` for the three arms in the
 *    scheduled order, each under the policy and with the debate options the
 *    schedule sealed for its arm;
 * 6. write the evidence of every run that produced a record, each arm's
 *    manifest with a `variant` binding;
 * 7. close the journal and return a reconciliation handle for late usage.
 *
 * Everything `runPairedBlocks` says about evidence, slot statuses, what is
 * never done and when a later block runs holds here as written, with three
 * continuations per block where it has two. The design runs in tokens on the
 * api-key route only. Verified with fakes only.
 *
 * AD-1: this tree may import from `core/` and `fixtures/`. Nothing under `core/`
 * imports it.
 */

import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import type { RunRecord } from "../core/domain/run-record.ts"
import { writeBundleIndex } from "./bundle.ts"
import { sealedVariantAllowances, type VariantAllowances } from "./governor.ts"
import { acquireLock, openJournal, type PairedJournal } from "./journal.ts"
import type { VariantBinding } from "./manifest.ts"
import {
  executeBlocks,
  identityOf,
  type BlockDesign,
  type PairedBlocksOutcome,
  type RunPairedBlocksInput,
} from "./paired.ts"
import { START_MARKER_FILE, writeStartMarker } from "./schedule.ts"
import { variantConfigProblem, verifyVariantSchedule, type VariantSchedule, type VariantSlot } from "./variant-schedule.ts"
import { VARIANT_ARM_OPTIONS, VARIANT_ARMS, type VariantArm, type VariantArmOptions } from "./variants.ts"

/**
 * The same inputs as `runPairedBlocks`; the schedule at the bundle root is a
 * debate-variants one. `expected`, when given, is what the caller already
 * sealed and verified: the schedule must have that hash and be bound to that
 * protocol, checked under the lock before the start marker.
 */
export type RunVariantBlocksInput = RunPairedBlocksInput & {
  expected?: { scheduleHash?: string; protocol?: { id: string; version: number; hash: string } }
}

export type VariantBlocksOutcome =
  | { ok: false; reason: string }
  | (Omit<Extract<PairedBlocksOutcome, { ok: true }>, "schedule" | "slots" | "runs"> & {
      ok: true
      schedule: VariantSchedule
      /** All nine planned slots, in schedule order. */
      slots: Awaited<ReturnType<typeof executeBlocks<VariantSlot>>>["slots"]
      /** Continuations that returned a result. A thrown continuation is only in `slots`. */
      runs: Awaited<ReturnType<typeof executeBlocks<VariantSlot>>>["runs"]
    })

export async function runVariantBlocks(given: RunVariantBlocksInput): Promise<VariantBlocksOutcome> {
  // The data the schedule is verified against is copied once, here, and the
  // copy is what verification, every block and every manifest read: a caller
  // that changes its own objects later changes nothing this run does. The
  // ports and callbacks (backends, clock, Tools, the abort signal, the fork)
  // stay live.
  let input: RunVariantBlocksInput
  try {
    input = boundInput(given)
  } catch (error) {
    return { ok: false, reason: `the runner's inputs could not be copied: ${messageOf(error)}` }
  }
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
  let prepared: { schedule: VariantSchedule; journal: PairedJournal; options: Record<VariantArm, VariantArmOptions>; limits: VariantAllowances }
  const refuse = async (reason: string): Promise<VariantBlocksOutcome> => {
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
    const configProblem = variantConfigProblem(input.config)
    if (configProblem !== null) return await refuse(configProblem)
    const verified = await verifyVariantSchedule(root, input)
    if (!verified.ok) return await refuse(verified.reason)
    const schedule = verified.schedule
    const expected = input.expected
    if (expected?.scheduleHash !== undefined && schedule.scheduleHash !== expected.scheduleHash) {
      return await refuse(`the schedule at the bundle root has hash ${schedule.scheduleHash}, not the expected ${expected.scheduleHash}`)
    }
    const protocol = expected?.protocol
    if (
      protocol !== undefined &&
      (schedule.protocol.id !== protocol.id || schedule.protocol.version !== protocol.version || schedule.protocol.hash !== protocol.hash)
    ) {
      return await refuse(
        `the schedule is bound to ${schedule.protocol.id} v${schedule.protocol.version} ${schedule.protocol.hash}, not the expected ` +
          `${protocol.id} v${protocol.version} ${protocol.hash}`,
      )
    }

    // The arm options and allowances are read from the verified schedule, and
    // checked again here because they are what the runs will be given.
    const options = sealedArmOptions(schedule.config.arms)
    if (!options.ok) return await refuse(`the schedule's arm options cannot be read: ${options.reason}`)
    const limits = sealedVariantAllowances(schedule.config.allowances)
    if (!limits.ok) return await refuse(`the schedule's allowances cannot be read: ${limits.reason}`)

    // The bundle index carries AD-16's containment check. It runs before the start
    // marker, so a bundle root that may not be written does not burn the schedule.
    const index = await writeBundleIndex({
      bundleRoot: root,
      worktree: input.worktree,
      arms: schedule.slots.map((slot) => ({ armId: slot.arm, repeatId: slot.block - 1 })),
      createdAt: input.clock.now(),
    })
    if (!index.ok) return await refuse(`the bundle index could not be written: ${index.reason}`)

    const opened = await openJournal(root, lock, () => input.clock.now(), undefined, "tokens", "debate-variants", limits.allowances)
    if (!opened.ok) return await refuse(opened.reason)
    journal = opened.journal

    // A journal that already refuses every request must not spend the schedule.
    const before = journal.bill()
    if (before.halt !== null) return await refuse(`the experiment is already halted, so the schedule was not started: ${before.halt}`)
    if (before.stop !== null) return await refuse(`the journal already stopped admitting, so the schedule was not started: ${before.stop}`)

    const started = await writeStartMarker(root, schedule.scheduleHash, input.clock.now())
    if (!started.ok) return await refuse(started.reason)
    prepared = { schedule, journal, options: options.options, limits: limits.allowances }
  } catch (error) {
    return await refuse(`the runner failed before the start marker was written: ${messageOf(error)}`)
  }
  const executed = await executeBlocks(input, root, variantDesign(input, prepared.schedule, prepared.options, prepared.limits), prepared.journal)
  return { ok: true, schedule: prepared.schedule, ...executed }
}

/** A deep-frozen copy of a plain data value. */
function frozenCopy<T>(value: T): T {
  const copy = structuredClone(value)
  const freeze = (node: unknown): void => {
    if (node === null || typeof node !== "object" || Object.isFrozen(node)) return
    Object.freeze(node)
    for (const child of Object.values(node)) freeze(child)
  }
  freeze(copy)
  return copy
}

/**
 * The runner's input with its data fields replaced by frozen copies: the
 * bundle root, worktree, protocol file, fixture, code revision, roster, change,
 * config and the caller's expectations, and each prior warning copied one level deep, as `runPairedBlocks`
 * copies them for a prefix.
 */
function boundInput(given: RunVariantBlocksInput): RunVariantBlocksInput {
  return {
    ...given,
    bundleRoot: given.bundleRoot,
    worktree: given.worktree,
    protocolFile: given.protocolFile,
    fixture: frozenCopy(given.fixture),
    codeRevision: frozenCopy(given.codeRevision),
    roster: frozenCopy(given.roster),
    change: frozenCopy(given.change),
    config: frozenCopy(given.config),
    ...(given.expected === undefined ? {} : { expected: frozenCopy(given.expected) }),
    ...(given.priorWarnings === undefined ? {} : { priorWarnings: given.priorWarnings.map((warning) => ({ ...warning })) }),
  }
}

/**
 * The sealed arm options, each exactly this design's for its arm, as a fresh
 * frozen copy. The schedule verifier already held them to the table; the
 * runner reads them once more because they are what each continuation runs with.
 */
function sealedArmOptions(
  value: unknown,
): { ok: true; options: Record<VariantArm, VariantArmOptions> } | { ok: false; reason: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "they are not an object" }
  const record = value as Record<string, unknown>
  const extra = Object.keys(record).filter((key) => !(VARIANT_ARMS as readonly string[]).includes(key))
  if (extra.length > 0) return { ok: false, reason: `they name ${extra.join(", ")}, which is not an arm of this design` }
  const options = {} as Record<VariantArm, VariantArmOptions>
  for (const arm of VARIANT_ARMS) {
    const entry = record[arm] as Record<string, unknown> | undefined
    const expected = VARIANT_ARM_OPTIONS[arm]
    const same =
      entry !== null &&
      typeof entry === "object" &&
      Object.keys(entry).length === Object.keys(expected).length &&
      (Object.keys(expected) as (keyof VariantArmOptions)[]).every((key) => entry[key] === expected[key])
    if (!same) return { ok: false, reason: `arm ${arm}'s are ${JSON.stringify(entry)}, not ${JSON.stringify(expected)}` }
    options[arm] = Object.freeze({
      policy: entry.policy as VariantArmOptions["policy"],
      debateReferences: entry.debateReferences as boolean,
      debateMissingEvidence: entry.debateMissingEvidence as boolean,
    })
  }
  return { ok: true, options: Object.freeze(options) }
}

/** The debate-variants design: every arm under its sealed policy and options, each manifest with a `variant` binding. */
function variantDesign(
  input: RunVariantBlocksInput,
  schedule: VariantSchedule,
  options: Record<VariantArm, VariantArmOptions>,
  limits: VariantAllowances,
): BlockDesign<VariantSlot> {
  return {
    slots: schedule.slots,
    scheduleHash: schedule.scheduleHash,
    identity: identityOf(schedule),
    forkedReason: "forked into the scheduled baseline, references and open-questions continuations",
    armName: (arm) => arm,
    continuation: (slot) => {
      const arm = options[slot.arm]
      return {
        policy: arm.policy,
        ...(arm.debateReferences ? { debateReferences: true } : {}),
        ...(arm.debateMissingEvidence ? { debateMissingEvidence: true } : {}),
      }
    },
    spec: (slot) => ({
      id: slot.arm,
      label: `debate variant ${slot.arm}`,
      provenance: input.config.provenance,
      slots: input.roster.slots.length,
      debate: { references: options[slot.arm].debateReferences, missingEvidence: options[slot.arm].debateMissingEvidence },
    }),
    binding(slot, prefixRunId, record, failure) {
      const variant: VariantBinding = {
        scheduleHash: schedule.scheduleHash,
        block: slot.block,
        arm: slot.arm,
        position: slot.position,
        prefixRunId,
        options: { ...options[slot.arm] },
        ...(failure === undefined ? {} : { failure }),
      }
      const problem = variantBindingProblem(schedule, variant, record)
      return problem === null ? { ok: true, binding: { variant } } : { ok: false, reason: problem }
    },
    runCap: limits.runCap,
  }
}

/**
 * Why a manifest's `variant` block would misstate its run, or `null`. The slot
 * must be one the schedule planned, its options the ones the schedule sealed
 * for its arm, and the prefix the run's own parent.
 */
export function variantBindingProblem(schedule: VariantSchedule, variant: VariantBinding, record: RunRecord): string | null {
  if (variant.scheduleHash !== schedule.scheduleHash) return "its schedule hash is not the sealed schedule's"
  const planned = schedule.slots.some(
    (slot) => slot.block === variant.block && slot.arm === variant.arm && slot.position === variant.position,
  )
  if (!planned) return `block ${variant.block} ${variant.arm} ${variant.position} is not a slot the sealed schedule planned`
  const sealed = (schedule.config.arms as Record<string, Record<string, unknown>> | undefined)?.[variant.arm]
  const keys = Object.keys(variant.options) as (keyof VariantArmOptions)[]
  const same =
    sealed !== null &&
    typeof sealed === "object" &&
    Object.keys(sealed).length === keys.length &&
    keys.every((key) => sealed[key] === variant.options[key])
  if (!same) {
    return `its options ${JSON.stringify(variant.options)} are not the ones the schedule sealed for arm ${variant.arm}`
  }
  if (record.forkedFrom !== variant.prefixRunId) {
    return `its prefix \`${variant.prefixRunId}\` is not the run's forkedFrom \`${String(record.forkedFrom)}\``
  }
  return null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
