/**
 * FR1 / FR2 (story 2.2) — writing one evaluation as a BUNDLE on disk.
 *
 * The ablation harness has written nothing since story 9, deliberately: it holds
 * three `RunRecord`s in memory and reads them, and A20 asserts the worktree is
 * byte-identical before and after a full run. That stays true for the scripted
 * path. What FR2 needs is for the EVALUATION path to leave something behind,
 * because a reader who wants to re-examine a live run afterwards currently has
 * nothing to read — the ledger entry this story closes says exactly that
 * (`deferred-work.md`, *"A live three-arm run has no reader for its artifact
 * dumps"*).
 *
 * ## The layout, frozen here
 *
 *   <bundleRoot>/bundle.json                          the declared arms
 *   <bundleRoot>/<armId>/<repeatId>/<runId>/          one AD-16 dump + manifest.json
 *
 * `runId` stays the leaf rather than being flattened away, because it is the
 * run's own opaque, sortable identity and the dump names its directory by it
 * (`adapters/opencode/artifacts.ts`). Keeping it means a bundle directory can be
 * read back to the run that produced it without consulting anything else.
 *
 * ## The index is written FIRST, and that is the whole point of having one
 *
 * FR2 requires the reader to NAME a missing arm. A reader that only walks
 * directories cannot: an arm that never ran leaves no directory, so its absence
 * is indistinguishable from an arm nobody intended. `bundle.json` declares the
 * intent before any arm runs, so an evaluation that dies half way through still
 * says what it meant to produce.
 *
 * ## AD-16 is enforced here too, through the SAME check
 *
 * `refusalFor` is imported from the dump rather than reimplemented. A second
 * containment check is a second thing that can be subtly weaker than the first,
 * and AD-16's guarantee is the one in this codebase with no acceptable failure
 * rate.
 */

import { mkdir, open, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import {
  ARTIFACTS_ENV,
  dumpRunArtifacts,
  realRefusalFor,
  refusalFor,
  safeName,
  type ArtifactOutcome,
  type TurnArtifact,
} from "../adapters/opencode/artifacts.ts"
import type { RunRecord } from "../core/domain/run-record.ts"
import type { ChangeSet } from "../core/ports/repo.ts"
import type { ArmRun } from "./arms.ts"
import { syncDirectory } from "./journal.ts"
import {
  buildManifest,
  known,
  unknownValue,
  type AdversarialBinding,
  type CodeRevision,
  type EvaluationIdentity,
  type ExperimentBinding,
  type Maybe,
} from "./manifest.ts"

/**
 * The evaluation could not record what it was doing, so it stopped.
 *
 * A NAMED CLASS, because the CLI has to tell this apart from a crash. FR1's stop
 * is a DELIBERATE outcome — the evidence could not be written, so nothing further
 * is billed and no number is published — and a deliberate outcome that reaches
 * the user as an unhandled stack trace reads as a bug in MAD rather than as the
 * refusal it is. `scripts/ablation.ts` catches this one and keeps its "main
 * always returns 0" contract; anything else still propagates, exactly as it did
 * before story 2.2 (recheck finding, 2026-09-10).
 */
export class EvaluationBundleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EvaluationBundleError"
  }
}

/** The bundle index's filename, at the bundle root. */
export const BUNDLE_FILE = "bundle.json"

/** The index's own version, separate from the manifest's — they change independently. */
export const BUNDLE_SCHEMA_VERSION = 1

/** One arm/repeat the evaluation intends to run. */
export interface BundleArm {
  armId: string
  repeatId: number
}

export interface BundleIndex {
  schemaVersion: number
  createdAt: string
  arms: BundleArm[]
}

/**
 * Where one arm's repeat writes.
 *
 * `safeName` is applied to the arm id for the reason `artifacts.ts` applies it
 * to a slot id: this is a string that becomes a filesystem PATH. Arm ids are
 * MAD's own today (`ablation/live.ts` builds them), and `--arm` on a command
 * line is one edit away from making them the caller's.
 */
export function armDirectory(bundleRoot: string, armId: string, repeatId: number): string {
  return join(resolve(bundleRoot), safeName(armId), String(repeatId))
}

export type IndexWritten = { ok: true; file: string } | { ok: false; reason: string }

export interface WriteBundleIndexInput {
  bundleRoot: string
  worktree: string
  arms: readonly BundleArm[]
  /** Supplied, never read from a clock here — this module stays testable without one. */
  createdAt: string
}

/**
 * Declare the evaluation's arms. NEVER THROWS.
 *
 * THE REAL-PATH GUARD, NOT THE LEXICAL ONE (review finding 1, 2026-09-10). This
 * first reached for `refusalFor`, which compares resolved-but-not-symlink-followed
 * strings — so a bundle root that was a symlink into the worktree passed the check
 * and the index was written inside the repository under review. `realRefusalFor`
 * runs the same containment test on paths resolved through their nearest existing
 * ancestor, which is the check `dumpRunArtifacts` has always made before writing.
 * BOTH CHECKS RUN, IN THIS ORDER, exactly as `dumpRunArtifacts` runs them. The
 * lexical one is not redundant: `realRefusalFor` starts by `resolve`-ing its
 * argument, which turns a RELATIVE root into an absolute one against the current
 * working directory — so on its own it would silently accept `--out out` instead
 * of refusing it by name.
 */
export async function writeBundleIndex(input: WriteBundleIndexInput): Promise<IndexWritten> {
  const lexical = refusalFor(input.bundleRoot, input.worktree)
  if (lexical !== undefined) return { ok: false, reason: lexical }
  const refusal = await realRefusalFor(input.bundleRoot, input.worktree)
  if (refusal !== undefined) return { ok: false, reason: refusal }

  // REFUSED AT THE WRITER TOO (recheck of 7bf0558). The reader refuses a bundle
  // index that declares one slot twice, and an evaluation that could WRITE one
  // would bill a full run and only then discover its own index is unreadable.
  // Two guards on one rule, at the two ends that can each be reached alone.
  const slots = new Set<string>()
  for (const arm of input.arms) {
    const slot = `${arm.armId}/${arm.repeatId}`
    if (slots.has(slot)) {
      return {
        ok: false,
        reason:
          `the evaluation declares arm \`${arm.armId}\` repeat ${arm.repeatId} more than once. ` +
          `One slot is one run; two declarations would write one dump and count it twice.`,
      }
    }
    slots.add(slot)
  }

  const root = resolve(input.bundleRoot)
  const index: BundleIndex = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    createdAt: input.createdAt,
    arms: input.arms.map((arm) => ({ armId: arm.armId, repeatId: arm.repeatId })),
  }
  try {
    // 0o700 / 0o600 for the reason the dump uses them: the bundle holds the
    // change under review and every prompt MAD sent, and its default home is a
    // shared temp directory.
    await mkdir(root, { recursive: true, mode: 0o700 })
    const file = join(root, BUNDLE_FILE)
    await writeFile(file, `${JSON.stringify(index, undefined, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
    return { ok: true, file }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export interface WriteArmDumpInput {
  bundleRoot: string
  /** Only these fields are written; the backend link is not needed here. */
  run: Pick<ArmRun, "spec" | "repeat" | "record" | "rendered">
  change: ChangeSet
  /** The experiment half of the identity. Arm and repeat come from `run`. */
  identity: Omit<EvaluationIdentity, "armId" | "repeatId">
  /** From `createTurnRecorder()`, when the caller wrapped the backend. */
  turns?: readonly TurnArtifact[]
  worktree: string
  /** Story 2-5c — the paired runner's slot binding. Checked by the runner before this is called. */
  experiment?: ExperimentBinding
  /** Story 2-7b — the adversarial runner's slot binding, likewise. */
  adversarial?: AdversarialBinding
}

/**
 * Write one arm's dump, manifest included. NEVER THROWS — `dumpRunArtifacts`
 * owns that contract and this function adds nothing that can break it.
 *
 * The dump is driven through `MAD_ARTIFACTS` in an INJECTED env rather than the
 * process's own, so an evaluation writing a bundle does not depend on, and does
 * not alter, whatever the operator set in their shell.
 */
export async function writeArmDump(input: WriteArmDumpInput): Promise<ArtifactOutcome> {
  const { run } = input
  const manifest = buildManifest({
    record: run.record,
    change: input.change,
    identity: { ...input.identity, armId: run.spec.id, repeatId: run.repeat },
    // AN ABSENT RECORDER IS AN UNKNOWN, NOT A ZERO. A caller that did not wrap
    // the backend produced no turn files; saying `0` would state that the run
    // issued no turns, which is a different and false fact.
    turnFiles:
      input.turns === undefined
        ? unknownValue("the caller did not wrap the backend with a turn recorder")
        : known(input.turns.length),
    ...(input.experiment === undefined ? {} : { experiment: input.experiment }),
    ...(input.adversarial === undefined ? {} : { adversarial: input.adversarial }),
  })

  return dumpRunArtifacts({
    record: run.record,
    change: input.change,
    rendered: run.rendered,
    ...(input.turns === undefined ? {} : { turns: input.turns }),
    manifest,
    worktree: input.worktree,
    env: { [ARTIFACTS_ENV]: armDirectory(input.bundleRoot, run.spec.id, run.repeat) },
  })
}

/** Story 2-5c — where a paired block's shared prefix is written, beside the arm directories. */
export const PREFIX_DIRECTORY = "prefix"
export const PREFIX_FILE = "prefix.json"
/** Bumped by hand when `PrefixEvidence`'s shape changes. */
export const PREFIX_EVIDENCE_VERSION = 1

/**
 * Story 2-5c — what a paired block's shared prefix did, at
 * `<bundleRoot>/prefix/<block - 1>/prefix.json`.
 *
 * A prefix is not an arm: it is neither ON nor OFF, the bundle index does not
 * declare it, and it has no manifest. This file identifies it by the sealed
 * schedule, the block and its run id, and says whether it was forked and why
 * not. When the prefix produced a record, the record's AD-16 dump sits beside
 * the file, in the directory named by its run id, and `dump` names it. When
 * `prepareReview` threw before returning a record, nothing is invented: `dump`
 * is `null`. `failure` holds the exception that stopped the prefix, from
 * `prepareReview` or from the fork. Its spend is in the journal either way.
 */
export interface PrefixEvidence {
  prefixEvidenceVersion: number
  scheduleHash: string
  block: number
  /** The prefix's run id, or an unknown when none was minted. */
  prefixRunId: Maybe<string>
  forked: boolean
  reason: string
  failure?: string
  /** The dump directory of the prefix record, or `null` when there was no record. */
  dump: string | null
}

export interface WritePrefixEvidenceInput {
  bundleRoot: string
  worktree: string
  change: ChangeSet
  scheduleHash: string
  block: number
  /** The prefix record, when `prepareReview` returned one. */
  record?: RunRecord
  /** The run id the prefix minted, when there is no record to read it from. */
  runId?: string
  forked: boolean
  reason: string
  failure?: string
}

export type PrefixEvidenceWritten = { ok: true; file: string; dump: string | null } | { ok: false; reason: string }

/**
 * Write a prefix's evidence. NEVER THROWS. Refuses a bundle root inside the
 * worktree (AD-16), and never overwrites an existing `prefix.json`.
 */
export async function writePrefixEvidence(input: WritePrefixEvidenceInput): Promise<PrefixEvidenceWritten> {
  try {
    const lexical = refusalFor(input.bundleRoot, input.worktree)
    if (lexical !== undefined) return { ok: false, reason: lexical }
    const refusal = await realRefusalFor(input.bundleRoot, input.worktree)
    if (refusal !== undefined) return { ok: false, reason: refusal }

    // THE DESTINATION IS CHECKED, NOT ONLY THE ROOT. A `prefix` entry under a
    // contained root may itself be a symlink into the worktree, and a prefix with
    // no record reaches `open` below without passing through the dump's own check.
    // Checked again once the directory exists, when its real path is exact.
    const directory = armDirectory(input.bundleRoot, PREFIX_DIRECTORY, input.block - 1)
    const destination = async (): Promise<string | undefined> =>
      refusalFor(directory, input.worktree) ?? (await realRefusalFor(directory, input.worktree))
    const before = await destination()
    if (before !== undefined) return { ok: false, reason: before }
    let dump: string | null = null
    if (input.record !== undefined) {
      const outcome = await dumpRunArtifacts({
        record: input.record,
        change: input.change,
        rendered:
          `No report: this is the shared prefix of block ${input.block}. A prefix stops after discovery and ` +
          `clustering and is continued only by its forks; its findings are in record.json.\n`,
        worktree: input.worktree,
        env: { [ARTIFACTS_ENV]: directory },
      })
      if (outcome.kind !== "written") {
        return {
          ok: false,
          reason: `the prefix record could not be dumped: ${outcome.kind === "failed" ? outcome.error : outcome.kind === "refused" ? outcome.reason : "artifact writing was off"}`,
        }
      }
      dump = outcome.directory
    }
    const runId = input.record?.runId ?? input.runId
    const evidence: PrefixEvidence = {
      prefixEvidenceVersion: PREFIX_EVIDENCE_VERSION,
      scheduleHash: input.scheduleHash,
      block: input.block,
      prefixRunId: runId === undefined ? unknownValue("prepareReview threw before a run id was minted") : known(runId),
      forked: input.forked,
      reason: input.reason,
      ...(input.failure === undefined ? {} : { failure: input.failure }),
      dump,
    }
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const after = await destination()
      if (after !== undefined) return { ok: false, reason: after }
      const file = join(directory, PREFIX_FILE)
      const handle = await open(file, "wx", 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(evidence, undefined, 2)}\n`, "utf8")
        await handle.sync()
      } finally {
        await handle.close()
      }
      await syncDirectory(directory)
      return { ok: true, file, dump }
    } catch (error) {
      // A record already dumped stays where it is, and the reason names it.
      const left = dump === null ? "" : `; the prefix record's dump was written to \`${dump}\``
      return { ok: false, reason: `the prefix evidence could not be written: ${messageOf(error)}${left}` }
    }
  } catch (error) {
    return { ok: false, reason: `the prefix evidence could not be written: ${messageOf(error)}` }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * How a command is run, injected so the code revision can be TESTED rather than
 * trusted — the pattern every seam in this repository follows.
 */
export type RunCommand = (
  command: string,
  args: readonly string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

/**
 * AC4 — the code revision, or an explicit unknown WITH ITS REASON.
 *
 * Two questions, both of which must be answered before the revision means
 * anything: which commit, and whether the worktree was clean. A dirty worktree
 * does not make the revision wrong, it makes it INSUFFICIENT — the commit no
 * longer identifies the bytes that ran — so it travels beside it rather than
 * suppressing it.
 *
 * EVERY FAILURE IS AN UNKNOWN, NEVER A GUESS. No git, a non-zero exit, empty
 * output, a directory that is not a repository: each returns
 * `{ kind: "unknown", why }`. A manifest that recorded `""` or a stale default
 * here would be a traceability claim MAD cannot support, which is the one thing
 * FR1 exists to prevent.
 */
export async function codeRevisionFrom(run: RunCommand): Promise<Maybe<CodeRevision>> {
  let commit: string
  try {
    const head = await run("git", ["rev-parse", "HEAD"])
    if (head.exitCode !== 0) {
      return unknownValue(`\`git rev-parse HEAD\` exited ${head.exitCode}: ${head.stderr.trim()}`)
    }
    commit = head.stdout.trim()
    if (commit.length === 0) {
      return unknownValue("`git rev-parse HEAD` produced no output")
    }
  } catch (error) {
    return unknownValue(`\`git rev-parse HEAD\` could not be run: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    const status = await run("git", ["status", "--porcelain"])
    if (status.exitCode !== 0) {
      return unknownValue(
        `the commit is \`${commit}\` but \`git status --porcelain\` exited ${status.exitCode}, ` +
          `so whether the worktree was clean is not established`,
      )
    }
    return known({ commit, dirty: status.stdout.trim().length > 0 })
  } catch (error) {
    return unknownValue(
      `the commit is \`${commit}\` but \`git status --porcelain\` could not be run ` +
        `(${error instanceof Error ? error.message : String(error)}), so whether the worktree was clean is not established`,
    )
  }
}
