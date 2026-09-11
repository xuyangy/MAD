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

import {
  budgetReport,
  unknownUsageCount,
  usageIsComplete,
  type StageSpend,
} from "../core/budget/ledger.ts"
import type { Preset, SpendShares } from "../core/budget/presets.ts"
import type { Finding, Stage } from "../core/domain/finding.ts"
import type {
  DebateCounts,
  JudgeCounts,
  LensInstructionRecord,
  RouteCounts,
  RoutingPolicy,
  RunRecord,
  TokenLedger,
  TokenUsage,
  UnknownUsageEntry,
} from "../core/domain/run-record.ts"
import type { LensSlot, RosterSlot } from "../core/domain/roster.ts"
import { DISCLOSURE_CODES, type Warning, type WarningCode } from "../core/domain/warning.ts"
import type { ChangeSet } from "../core/ports/repo.ts"

/**
 * The manifest's own version, and the ONLY compatibility promise this story
 * makes. A reader that does not know a version says so and segregates the arm;
 * it never guesses at an unknown shape.
 *
 * IT STAYS `1` THROUGH STORY 2.3, which widened `UsageCompleteness` from one
 * value to three and added three fields to `spend`. That is a schema change and
 * the version not moving is a decision, not an oversight.
 *
 * The reason is that NO EVALUATION BUNDLE WRITTEN BY A BILLING RUN EXISTS. Epic
 * 2 has billed nothing and 2.1 froze the protocol without authorizing any spend,
 * so the only bundles in existence are this repository's own test fixtures,
 * updated in the same commit as the reader. Bumping would make exactly those
 * unreadable (`ablation/read-bundle.ts` refuses a version it does not know) to
 * buy compatibility for a reader that has never run. The freeze boundary the
 * protocol's delegation row sets for 2.2's schema is *"before the first
 * evaluation run is read"*, and that has not happened.
 *
 * The FIRST bundle written by a run that bills is the point at which this
 * argument expires.
 *
 * WHAT THIS COSTS, STATED RATHER THAN HIDDEN: a `1` written before story 2.3
 * carries no `spend.unknownUsage`, and `ablation/read-bundle.ts` refuses it —
 * per arm, by name ("carries no `spend.unknownUsage` list"), because the checked
 * set is the touched set. That is the same outcome a version bump would produce,
 * minus the false implication that two readable schemas exist. It is acceptable
 * only because the set of such files is empty.
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
 * AC5 (story 2.3) — THE AUDIT VERDICT, and it can finally be one.
 *
 * Story 2.2 shipped this type with exactly one value, `unaudited`, and said in
 * this comment that it *deliberately cannot say `complete`*: asserting complete
 * usage before the mechanism that could check it existed would have been the
 * flattering error the protocol's §4 stop rule exists to prevent, written into
 * the record rather than into a report. That was true then and it is why the
 * field shipped narrow rather than optimistic.
 *
 * Story 2.3 built the mechanism, so the comment is rewritten rather than left
 * standing as a claim the code contradicts. `TokenLedger.unknownUsage`
 * (`core/domain/run-record.ts`) is the collection of executions MAD could not
 * count, and `usageIsComplete` / `unknownUsageCount` (`core/budget/ledger.ts`)
 * are the ONE answer over it. `buildManifest` reads those rather than deciding
 * anything here, which is the same rule `perStage` follows through
 * `budgetReport`: the accountant's arithmetic, never a second copy.
 *
 * THREE VALUES, AND THE THIRD IS NOT A LEFTOVER:
 *
 * - `complete` — the ledger holds no unknown. Every turn this run billed is in
 *   `spend.total`.
 * - `incomplete` — at least one execution's usage is unknown. `spend.total` is
 *   OBSERVED spend, `spend.unknownUsage` names what is missing, and
 *   `spend.exposure` is `unquantified` (`evaluation-protocol.md:332-339`).
 * - `unaudited` — the record carried NO unknown-usage collection at all, so no
 *   audit was possible. It is kept because absent and none must not be two ways
 *   of saying the same thing — the exact reason `TokenLedger.unknownUsage` is a
 *   required field one layer down. A manifest built from a pre-2.3 dump, or by a
 *   JavaScript caller that omitted the collection, would otherwise read
 *   `complete` on the strength of a field nobody wrote.
 *
 * `MANIFEST_SCHEMA_VERSION` does NOT bump for this widening; see its own comment.
 *
 * IT IS A `const` WITH THE TYPE DERIVED FROM IT, in the shape
 * `ablation/read-bundle.ts`'s `COMPARABILITY_FIELDS` already uses. A reader on
 * disk has to check the value it read against the set at RUN TIME — a union type
 * erases — and a hand-written second list beside the type is a list that can
 * fall one value behind it. Derived, they cannot disagree.
 */
export const USAGE_COMPLETENESS_VALUES = ["complete", "incomplete", "unaudited"] as const
export type UsageCompleteness = (typeof USAGE_COMPLETENESS_VALUES)[number]

/**
 * `evaluation-protocol.md:332-339` — TOKEN EXPOSURE, in the protocol's own two
 * words, resolved at write time so a reader never has to derive it.
 *
 * The protocol states the configured cap and the residual exposure SEPARATELY,
 * and says the residual exposure "is a number only where a number is defensible;
 * where unknown billed usage or a non-abortable in-flight request makes a finite
 * bound impossible, it is named **unquantified**".
 *
 * So this is not a synonym for `usageCompleteness`, and it collapses the union
 * on purpose: `incomplete` and `unaudited` both yield `unquantified`, because a
 * run that could not count a turn and a run nobody audited are equally unable to
 * support a finite bound. Only `complete` yields `quantified`, and then the
 * number is `spend.total` — already written beside it, never restated here.
 *
 * The alternative was to leave the reader to infer it from the verdict. It was
 * rejected for the reason `ManifestWarning.disclosure` is resolved at write time:
 * an inference made in two readers is an inference that can differ between them,
 * and this one is the difference between a bill and a bound.
 */
export type TokenExposure = "quantified" | "unquantified"

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
    /**
     * SPEC.md "Evaluation exception" — the routing policy the run continued
     * under. ALWAYS WRITTEN, `shipped` included, because the debate-pathway
     * contrast is exactly this dial and a reader must not have to infer it.
     *
     * A manifest written before story 2.5A has no such field. The reader reads
     * that absence as `shipped` under a compatibility interpretation: no code
     * path before that story could route any other way. It is not evidence
     * that the artifact is authentic or complete, and it says nothing about
     * usage.
     */
    routingPolicy: RoutingPolicy
  }
  spend: {
    /** From `budgetReport` — the accountant's own arithmetic, never a second copy. */
    perStage: StageSpend[]
    /**
     * OBSERVED spend (story 2.3). It is the sum of the turns MAD could count and
     * it is not the bill whenever `usageCompleteness` is anything but `complete`
     * — `evaluation-protocol.md:511-517`, *"a missing tag is not evidence of
     * complete usage"*. Nothing is added to it to cover the gap: an unknown has
     * no number and the three fields below say so instead.
     */
    total: TokenUsage
    usageCompleteness: UsageCompleteness
    /**
     * `evaluation-protocol.md:337-338` — THE IDENTITIES, which the stop rule
     * requires to be recorded and not merely counted.
     *
     * They are `UnknownUsageEntry` exactly as the ledger holds them, carried
     * through rather than reshaped: each names one physical execution
     * (`executionId`), where it happened (`slot`, `stage`, `attempt`) and WHY
     * its usage is unknown. The `why` is the field a human acts on — "cancelled
     * in flight", "timed out" and "the host reported nothing" are three
     * different facts — and a manifest that kept only the count would leave the
     * operator clearing `ablation/governor.ts`'s halt with nothing to read.
     *
     * `[]` UNDER AN `unaudited` VERDICT IS NOT A CLAIM THAT THERE WERE NONE. The
     * verdict is the field that distinguishes those; this one is empty because
     * no audit produced a list.
     */
    unknownUsage: UnknownUsageEntry[]
    /**
     * The same protocol line's COUNT, written beside the identities rather than
     * left as `unknownUsage.length`.
     *
     * Redundant by construction and deliberately so, in the shape `roster.filled`
     * already uses beside `roster.slots`: the protocol names the count as a thing
     * to record, and a renderer must print a figure it did not compute
     * (`core/budget/ledger.ts`'s `unknownUsageCount` is the one that computes it,
     * for the same reason `budgetReport` exists).
     */
    unknownUsageCount: number
    /** `unquantified` unless the verdict is `complete`. See `TokenExposure`. */
    exposure: TokenExposure
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
      // Absent on the record IS the shipped policy (`RunRecord.routingPolicy`);
      // the manifest spells it out either way.
      routingPolicy: record.routingPolicy ?? "shipped",
    },
    spend: {
      perStage: budgetReport(record.ledger),
      total: record.ledger.total,
      ...auditUsage(record.ledger),
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

/**
 * AC5 (story 2.3) — THE AUDIT, in the one place that performs it.
 *
 * Three fields come back together because they are three readings of one fact
 * and a caller that could write them separately is a caller that could write
 * them inconsistently — a manifest saying `complete` beside two named unknowns
 * is worse than either field alone.
 *
 * IT DECIDES NOTHING ABOUT WHAT "COMPLETE" MEANS. `usageIsComplete` and
 * `unknownUsageCount` in `core/budget/ledger.ts` are the accountant's answer,
 * and the same two functions gate `mayISpend` and phrase what
 * `core/stages/output.ts` prints — so the manifest's verdict, the refusal to
 * spend and the rendered caveat cannot drift apart. This function's whole content
 * is the `unaudited` case below.
 *
 * THE `Array.isArray` GUARD IS NOT DEAD CODE, though the type says it is.
 * `TokenLedger.unknownUsage` is required, so every ledger MAD builds has one; a
 * record deserialized from a pre-2.3 dump or handed over by a JavaScript caller
 * has not been through that type. Without the guard, `usageIsComplete` reads
 * `undefined.length`, throws, and takes down a builder whose whole contract is
 * that it is pure and total. With it, the absence gets the verdict that names it.
 *
 * PURE (`:21-23`): no clock, no filesystem, no environment. It reads the ledger
 * and nothing else.
 */
function auditUsage(ledger: TokenLedger): {
  usageCompleteness: UsageCompleteness
  unknownUsage: UnknownUsageEntry[]
  unknownUsageCount: number
  exposure: TokenExposure
} {
  if (!Array.isArray(ledger.unknownUsage)) {
    return {
      usageCompleteness: "unaudited",
      unknownUsage: [],
      unknownUsageCount: 0,
      exposure: "unquantified",
    }
  }
  const complete = usageIsComplete(ledger)
  return {
    usageCompleteness: complete ? "complete" : "incomplete",
    // COPIED, not aliased. `recordUnknownTurn` and `reconcileLateUsage` mutate
    // this array in place for the life of the run, so a manifest sharing it would
    // be a written record that keeps changing after it was written — which is the
    // one thing a manifest exists not to do. The roster arrays above are aliased
    // because nothing mutates them after the roster resolves.
    unknownUsage: [...ledger.unknownUsage],
    unknownUsageCount: unknownUsageCount(ledger),
    exposure: complete ? "quantified" : "unquantified",
  }
}

/**
 * The change's identity as a manifest records it. `diffHash` is also the key
 * `ablation/cross-arm-rates.ts` compares against a labelled set's recorded
 * source diff, so the two can never disagree on how a change is hashed.
 */
export function changeIdFor(change: ChangeSet): ChangeId {
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
