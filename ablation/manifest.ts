/**
 * FR1 (story 2.2) — the run manifest: what a published number is traceable to.
 *
 * A `RunRecord` is the run as MAD held it in memory. A MANIFEST is the run as a
 * stranger must be able to check it: the same facts, plus the identity of the
 * experiment they belong to, in a shape that is versioned, hashable, and
 * comparable against a sibling arm.
 *
 * ## Three rules, and every design choice here follows from one of them
 *
 * 1. **NOTHING IS INFERRED.** Every field is read off the record, computed from
 *    bytes MAD already holds, or supplied by the caller. A value nobody supplied
 *    and MAD cannot compute is `{ kind: "unknown", why }` — never `""`, never
 *    `0`, never a default that reads as a measurement. `Maybe<T>` exists so that
 *    an absence has to carry its own reason past the type checker.
 * 2. **ABSENT STAYS ABSENT.** `routeCounts`, `debateCounts` and `judgeCounts` are
 *    optional on `RunRecord` and their absence is the signal that the stage never
 *    ran (`core/domain/run-record.ts`). Writing all-zero counts for a stage that
 *    never ran states a different fact, so the manifest carries
 *    `{ kind: "did-not-run" }` and says it out loud.
 * 3. **IT IS PURE.** No filesystem, no clock, no `process.env`, no git. The code
 *    revision is the caller's to establish; a builder that shelled out to git
 *    would be a builder whose output depends on where it ran.
 *
 * ## It is the durable thing; AD-16's dump is not
 *
 * `adapters/opencode/artifacts.ts` says of itself: *"This is the DEBUG dump, not
 * the durable format the spine still defers — do not let it become one."* This
 * module is the durable format, scoped to the evaluation. It rides IN the dump
 * directory and carries `schemaVersion`, so the reader depends on this file's
 * shape and on nothing else in that directory.
 *
 * AD-1: this tree may import from `core/`. Nothing under `core/` may import from
 * here, which `scripts/lint-dependency-direction.ts` enforces.
 */

import { createHash } from "node:crypto"

import { budgetReport, type StageSpend } from "../core/budget/ledger.ts"
import type { Preset, SpendShares } from "../core/budget/presets.ts"
import type { Finding, Stage } from "../core/domain/finding.ts"
import type {
  DebateCounts,
  JudgeCounts,
  LensInstructionRecord,
  RouteCounts,
  RunRecord,
  TokenUsage,
} from "../core/domain/run-record.ts"
import type { LensSlot, RosterSlot } from "../core/domain/roster.ts"
import { DISCLOSURE_CODES, type Warning, type WarningCode } from "../core/domain/warning.ts"
import type { ChangeSet } from "../core/ports/repo.ts"

/**
 * The manifest's own version, and the ONLY compatibility promise this story
 * makes. A reader that does not know a version says so and segregates the arm;
 * it never guesses at an unknown shape.
 */
export const MANIFEST_SCHEMA_VERSION = 1

/** Where a manifest lives inside one run's artifact directory. */
export const MANIFEST_FILE = "manifest.json"

/**
 * A value that is either established or explicitly not, WITH ITS REASON.
 *
 * The alternative was an optional field, and it is the wrong tool here: `?` says
 * "this may be missing" and stays silent about why, so a manifest with no code
 * revision reads identically whether git was unavailable, the caller forgot, or
 * the run predates the field. A reader comparing two arms on `codeRevision` has
 * to be able to tell "they differ" from "neither is known", because only the
 * first is a disagreement.
 */
export type Known<T> = { kind: "known"; value: T }
export type UnknownValue = { kind: "unknown"; why: string }
export type Maybe<T> = Known<T> | UnknownValue

export function known<T>(value: T): Known<T> {
  return { kind: "known", value }
}

/**
 * Named `unknownValue` and not `unknown`, because `unknown` is a TypeScript
 * keyword type and a function sharing that name reads, at every call site, like
 * a type assertion that is not one.
 */
export function unknownValue(why: string): UnknownValue {
  return { kind: "unknown", why }
}

/**
 * AC5 — story 2.3 owns the usage-completeness schema
 * (`evaluation-protocol.md:297`). This story writes the FIELD so 2.3 has a place
 * to put its answer, and gives it exactly one value.
 *
 * `unaudited` means *no usage-completeness audit exists yet*. It deliberately
 * cannot say `complete`: a manifest asserting complete usage before the mechanism
 * that could check it has been built would be the flattering error the protocol's
 * §4 stop rule exists to prevent, written into the record rather than into a
 * report.
 */
export type UsageCompleteness = "unaudited"

/**
 * How a run ended. Four values, because "completed" and "completed with a
 * degradation" are different facts and FR1 asks for both.
 *
 * `unfinished` is not a synonym for `cancelled`: a run with no `finishedAt` and
 * no `cancelled` stage is one whose record was captured mid-flight or whose
 * process died, and calling that "cancelled" would name a user action nobody took.
 */
export type Completion = "completed" | "degraded" | "cancelled" | "unfinished"

/** A stage's counts, or the fact that the stage never ran. */
export type StageCounts<T> = { kind: "did-not-run" } | { kind: "ran"; counts: T }

/** The code the run was produced by. `dirty` is a fact about the worktree, not a warning. */
export interface CodeRevision {
  commit: string
  dirty: boolean
}

/**
 * The change under review, by BOTH halves FR1 offers.
 *
 * FR1 says "exact base/target identifier **or** content hash". Both are written,
 * because they answer different questions: `description` is host syntax and says
 * what was ASKED FOR; `diffHash` says what was actually REVIEWED. Two arms given
 * the same ref range on two different days are not reviewing the same bytes, and
 * `diffHash` is the field the reader compares on for exactly that reason.
 */
export interface ChangeId {
  description: string
  files: string[]
  /** `sha256:<hex>` over the unified diff text. */
  diffHash: string
}

/**
 * The half of the manifest that comes from the EXPERIMENT rather than from the
 * run — supplied by the caller, never discovered here.
 *
 * `changeId` is not on this interface: it is computed by `buildManifest` from the
 * `ChangeSet` the run was actually given, which is stronger than trusting a
 * caller to describe it. (Recorded as a deliberate deviation from the story's
 * task list in the Spec Change Log.)
 */
export interface EvaluationIdentity {
  protocolVersion: Maybe<number>
  protocolHash: Maybe<string>
  fixtureVersion: Maybe<string>
  fixtureHash: Maybe<string>
  codeRevision: Maybe<CodeRevision>
  /** The arm this run is, e.g. `on` / `off`. Stable across repeats. */
  armId: string
  /** 0-based, matching `ArmRun.repeat`. */
  repeatId: number
}

/** One warning, with the disclosure/degradation split resolved at write time. */
export interface ManifestWarning {
  code: WarningCode
  stage: Stage | "roster"
  message: string
  /**
   * Resolved HERE from `DISCLOSURE_CODES` rather than left to the reader, so a
   * reader cannot re-answer it differently. `core/domain/warning.ts` owns the
   * vocabulary; a second denylist somewhere else is a second place it can drift.
   */
  disclosure: boolean
}

export interface RunManifest {
  schemaVersion: number
  identity: EvaluationIdentity & { changeId: ChangeId }
  run: {
    runId: string
    startedAt: string
    finishedAt: Maybe<string>
  }
  roster: {
    requested: number
    /** Slots actually filled. Never the denominator — that is `answered` (AD-6a). */
    filled: number
    answered: number
    distinctLineages: number
    providers: string[]
    slots: RosterSlot[]
    lensSlots: LensSlot[]
    /** AD-6a / AD-15 — slots the BUDGET refused. `[]` is a run where none were. */
    skippedForBudget: string[]
  }
  dials: {
    threshold: number
    maxRounds: number
    maxConcurrency: number
    /** `null` MEANS no ceiling, exactly as `TokenLedger.cap` does. */
    cap: number | null
    shares: SpendShares
    preset: Maybe<Preset>
  }
  spend: {
    /** From `budgetReport` — the accountant's own arithmetic, never a second copy. */
    perStage: StageSpend[]
    total: TokenUsage
    usageCompleteness: UsageCompleteness
  }
  status: {
    completion: Completion
    cancelledAt: Maybe<Stage>
    warnings: ManifestWarning[]
    routeCounts: StageCounts<RouteCounts>
    debateCounts: StageCounts<DebateCounts>
    judgeCounts: StageCounts<JudgeCounts>
  }
  findings: PersistedFindings & { lensInstructions: LensInstructionRecord[] }
  /**
   * FR1's "raw stage outputs" — POINTED AT, not duplicated.
   *
   * They already exist in the dump this manifest ships inside: `record.json`
   * carries the whole record including every finding's append-only history, and
   * `turn-NNN-<slot>.json` carries every prompt sent and every envelope returned.
   * The count is recorded because a dump written by a caller that did not wrap
   * the backend has NO turn files, and that dump looks healthy in every other
   * respect — the same silent-absence shape story 10's review caught in
   * `plugin.ts`.
   */
  stageOutputs: {
    recordFile: string
    turnFiles: Maybe<number>
  }
}

export interface BuildManifestInput {
  record: RunRecord
  change: ChangeSet
  identity: EvaluationIdentity
  turnFiles: Maybe<number>
}

export function buildManifest(input: BuildManifestInput): RunManifest {
  const { record, change, identity } = input
  const warnings = record.warnings.map(toManifestWarning)
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    identity: { ...identity, changeId: changeIdFor(change) },
    run: {
      runId: record.runId,
      startedAt: record.startedAt,
      finishedAt:
        record.finishedAt === undefined
          ? unknownValue("the record carries no finishedAt — the run did not reach its end")
          : known(record.finishedAt),
    },
    roster: {
      requested: record.roster.requested,
      filled: record.roster.slots.length,
      answered: record.answered,
      distinctLineages: record.roster.distinctLineages,
      providers: record.roster.providers,
      slots: record.roster.slots,
      lensSlots: record.roster.lensSlots,
      skippedForBudget: record.skippedForBudget ?? [],
    },
    dials: {
      threshold: record.threshold,
      maxRounds: record.maxRounds,
      maxConcurrency: record.ledger.maxConcurrency,
      cap: record.ledger.cap,
      shares: record.ledger.shares,
      preset:
        record.preset === undefined ? unknownValue("the caller named no preset") : known(record.preset),
    },
    spend: {
      perStage: budgetReport(record.ledger),
      total: record.ledger.total,
      usageCompleteness: "unaudited",
    },
    status: {
      completion: completionOf(record, warnings),
      cancelledAt:
        record.cancelled === undefined
          ? unknownValue("the run was never cancelled")
          : known(record.cancelled.stage),
      warnings,
      routeCounts: stageCounts(record.routeCounts),
      debateCounts: stageCounts(record.debateCounts),
      judgeCounts: stageCounts(record.judgeCounts),
    },
    findings: { ...toPersistedFindings(record), lensInstructions: record.lensInstructions },
    stageOutputs: { recordFile: "record.json", turnFiles: input.turnFiles },
  }
}

function changeIdFor(change: ChangeSet): ChangeId {
  return {
    description: change.description,
    files: change.files,
    diffHash: `sha256:${createHash("sha256").update(change.diff, "utf8").digest("hex")}`,
  }
}

function toManifestWarning(warning: Warning): ManifestWarning {
  return {
    code: warning.code,
    stage: warning.stage,
    message: warning.message,
    disclosure: DISCLOSURE_CODES.has(warning.code),
  }
}

function stageCounts<T>(counts: T | undefined): StageCounts<T> {
  return counts === undefined ? { kind: "did-not-run" } : { kind: "ran", counts }
}

/**
 * CANCELLATION OUTRANKS DEGRADATION, and that ordering is the whole content of
 * this function.
 *
 * A run the user stopped is a stopped run whatever else it also recorded — the
 * degradations it collected on the way out are true and are already in
 * `warnings`, and promoting one of them to the headline would name a fault MAD
 * found in place of an action the user took.
 */
function completionOf(record: RunRecord, warnings: readonly ManifestWarning[]): Completion {
  if (record.cancelled !== undefined) return "cancelled"
  if (record.finishedAt === undefined) return "unfinished"
  return warnings.some((warning) => !warning.disclosure) ? "degraded" : "completed"
}

/**
 * AC6 — the persisted finding form: ONE pool plus ordered canonical ids.
 *
 * `RunRecord.pool` and `RunRecord.findings` share objects by reference (AD-7),
 * and that sharing is the property everything downstream relies on: a finding
 * mutated through one array is mutated in the other. JSON has no references, so a
 * naive dump of both arrays deserializes into two disconnected object graphs that
 * LOOK right under deep equality and are wrong under mutation. Persisting the
 * union once and the canonical set as ids is what makes the aliasing
 * reconstructible rather than lost.
 *
 * `evaluation-protocol.md` §8 (*Persisted form*) is the source of this shape.
 */
export interface PersistedFindings {
  pool: Finding[]
  /** The canonical subset, in canonical order. Order is preserved, never re-derived. */
  canonicalIds: string[]
}

export function toPersistedFindings(record: Pick<RunRecord, "pool" | "findings">): PersistedFindings {
  return {
    pool: record.pool,
    canonicalIds: record.findings.map((finding) => finding.id),
  }
}

export type Reconstructed =
  | { ok: true; pool: Finding[]; findings: Finding[] }
  | { ok: false; reason: string }

/**
 * Validate, THEN reconstruct. Never re-cluster.
 *
 * Re-clustering to rediscover which findings were canonical would replace a
 * recorded fact with a recomputed one, and the two can differ — the clustering
 * engine is not a pure function of the pool alone once severities and
 * co-discovery counts have been written onto it. The order in `canonicalIds` is
 * the run's own and is preserved exactly.
 *
 * Every refusal below is a way the aliasing could be silently wrong rather than
 * loudly absent, which is why none of them is repaired: a duplicate id is not
 * deduped, a dangling reference is not dropped.
 */
export function fromPersistedFindings(persisted: PersistedFindings): Reconstructed {
  const byId = new Map<string, Finding>()
  for (const finding of persisted.pool) {
    if (byId.has(finding.id)) {
      return { ok: false, reason: `the pool carries two findings with id \`${finding.id}\`` }
    }
    byId.set(finding.id, finding)
  }

  const seen = new Set<string>()
  const findings: Finding[] = []
  for (const id of persisted.canonicalIds) {
    if (seen.has(id)) {
      return { ok: false, reason: `canonicalIds names \`${id}\` more than once` }
    }
    const finding = byId.get(id)
    if (finding === undefined) {
      return { ok: false, reason: `canonicalIds names \`${id}\`, which is not in the pool` }
    }
    seen.add(id)
    // THE SAME OBJECT, selected from the pool — never a copy. This one line is
    // what the whole persisted form exists to make possible.
    findings.push(finding)
  }

  for (const finding of persisted.pool) {
    for (const merged of finding.mergedIds ?? []) {
      if (!byId.has(merged)) {
        return {
          ok: false,
          reason: `finding \`${finding.id}\` absorbed \`${merged}\`, which is not in the pool`,
        }
      }
    }
  }

  return { ok: true, pool: persisted.pool, findings }
}
