/**
 * Stage 1 — DISCOVER (CAP-1).
 *
 * Fans out to the roster in parallel; no model sees another's findings. Records
 * which models ANSWERED — that count is the denominator for every co-discovery
 * fraction downstream (AD-6a), never the count requested.
 *
 * A model that errors, times out, or returns an envelope that fails validation
 * gets EXACTLY ONE retry, then the run proceeds with a warning naming it
 * (AD-6b, AD-12), and it is excluded from the denominator. The one exception is
 * an attempt the backend recognised as a refused request (`Refusal`): it is not
 * retried, and the warning says it was refused and on which attempt.
 *
 * Writes only the fields discovery owns (AD-8): claim, reasoning, locus,
 * severity, author, source, lens.
 *
 * ## The pooling contract (what N>1 means here)
 *
 * These five properties are the whole point of fanning out, and each of them is
 * load-bearing for a downstream stage:
 *
 * 1. **The pool is a UNION, not a merge.** Nothing here clusters, deduplicates
 *    or reconciles: three models describing one defect leave this stage as three
 *    findings. Merging them is clustering's job and clustering's alone (AD-14,
 *    story 3), which also owns `clusterId` and `coDiscovery` (AD-8). Until it
 *    runs, the rendered pool says so (output stage), because a union presented
 *    as a merged set is a degraded review dressed as a good one (AD-6).
 *
 * 2. **Independence.** Every slot receives the identical `input` and the
 *    identical `instructions`; no slot's answer is ever fed to another
 *    (`pipeline-stages.md` §1). Correlated blind spots come from shared training
 *    data, so heterogeneity is the recall mechanism — and it only means anything
 *    if the models did not see each other's work.
 *
 * 3. **Pooled order follows ROSTER order, never completion order.** The fan-out
 *    is concurrent, so arrival order is whatever the network did that minute.
 *    `Promise.all` resolves positionally, and the finding-building loop below is
 *    a SEQUENTIAL post-pass over that positional array — so slot 3 answering
 *    first changes nothing about the output. Two runs over one change print
 *    alike, and a diff between two run records is readable.
 *
 * 4. **Ids are allocated in that same sequential pass**, one clock tick per
 *    slot, so every finding id is unique and stable from the moment of discovery
 *    (spine, Ids). Allocating them inside the concurrent turns instead would
 *    make id order a function of network timing — and ids survive clustering, so
 *    anything a transcript references later would move between runs.
 *
 * 5. **The lens segment is ADDITIVE COVERAGE, and the denominator is
 *    pool-only.** `roster.lensSlots` (CAP-11) is an optional second pass over
 *    the same change, each slot carrying a persona that narrows what it looks
 *    for. Its turns start in the SAME fan-out as the pool's, but it is a
 *    separate segment of the sequential post-pass and it buys different things:
 *    a lens finding claims **no co-discovery prior** (AD-17d — it was prompted
 *    for its dimension, so it has no unprompted signal to report) and **no
 *    lineage** (AD-17c). `answered` counts POOL slots only (AD-6a,
 *    `pipeline-stages.md` §1): a lens slot that answers never moves the
 *    denominator, and a lens slot that drops out warns (AD-6b) without shrinking
 *    it. Every finding carries `source` so the two are never confused
 *    downstream; with no lenses requested, this segment is empty and the stage
 *    behaves byte-for-byte as it did before it existed (AD-3, AD-15 amended).
 *
 * One slot's failure never costs another slot's findings (AD-6b): each turn is
 * isolated, and a backend that throws is converted into a failure envelope for
 * its own slot only.
 *
 * ## Story 7A — the fan-out is bounded, and it can be stopped
 *
 * Two changes, and neither touches the five properties above. Every turn is
 * still STARTED before any is awaited and `Promise.all` still resolves
 * positionally, so properties 3 and 4 hold word for word; what changed is that
 * each turn now waits for a slot from the budget's concurrency limiter (AD-15
 * amended), so the widest point of the run is `limiter.max` in flight rather
 * than `slots + lenses`. At the shipped ceilings that was twenty simultaneous
 * billed sessions against one user's credentials, and provider rate limiting
 * then arrived as a `model-dropped-out` warning naming a model that was working.
 *
 * And a CANCELLED turn is not a drop-out (AD-2 amended, AD-6f). The retry loop
 * refuses to issue a turn once the signal is aborted and returns without a
 * second attempt: AD-6(b)'s one retry is for a model that failed, and retrying a
 * turn the user cancelled spends their money to disobey them. `noteDropOut` is
 * therefore never reached for a cancelled slot — that is the single place this
 * stage could ship the exact failure story 7A exists to prevent.
 */

import {
  coveredByRefusalWords,
  coveringRefusal,
  describeRefusal,
  excludedByDetail,
  type SlotRefusal,
} from "../domain/refusal.ts"
import { stopCauseOf, stoppedTheRun } from "../domain/stop-cause.ts"
import { z } from "zod"

import {
  appendEntry,
  SEVERITIES,
  type Finding,
  type FindingSource,
  type Locus,
} from "../domain/finding.ts"
import {
  refusalExclusions,
  validateRecoveryPlan,
  type NotReplaced,
  type RefusedSlot,
  type Replacement,
  type RunRecovery,
} from "../domain/recovery.ts"
import type { RecoveryPlan, RosterSlot, Roster } from "../domain/roster.ts"
import {
  ceilingNamed,
  mayISpend,
  recordTurn,
  recordUnknownTurn,
  unknownUsageCount,
  usageIsComplete,
} from "../budget/ledger.ts"
import { countVerifiedLineages } from "../roster/select.ts"
import type { LensInstructionRecord, TokenLedger } from "../domain/run-record.ts"
import { hostAbortedWarning, type Warning } from "../domain/warning.ts"
import { resolveInstructions } from "../instructions/registry.ts"
import type { InstructionSet } from "../instructions/types.ts"
import type { ConcurrencyLimiter } from "../budget/limiter.ts"
import type { AdmittedTurn, RequestAdmission, SettleRequest } from "../ports/admission.ts"
import type { Clock } from "../ports/clock.ts"
import { oneLine } from "../prompt/material.ts"
import { cancelledTurn, endedBeforePrompt, type Envelope, type ModelBackend, type Refusal } from "../ports/model-backend.ts"
import { settlementOf, stageGatedTurn } from "./settlement.ts"

/**
 * AD-11 / AD-12 — the schema constrains ONLY the fields MAD computes on:
 * severity, locus, and the envelope's shape. `claim` and `reasoning` are
 * model-authored prose and pass through unparsed — they are typed as strings
 * and nothing inspects their contents.
 */
export const discoveryFindingSchema = z.object({
  claim: z.string().min(1),
  reasoning: z.string(),
  severity: z.enum(SEVERITIES),
  file: z.string().min(1),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
})

export const discoveryEnvelopeSchema = z.object({
  findings: z.array(discoveryFindingSchema),
})

export type DiscoveryEnvelope = z.infer<typeof discoveryEnvelopeSchema>
export type DiscoveryFinding = z.infer<typeof discoveryFindingSchema>

/** The envelope shape alone — used to salvage a partially valid response. */
const looseEnvelopeSchema = z.object({ findings: z.array(z.unknown()) })

export interface Salvage {
  findings: DiscoveryFinding[]
  /** How many items were present but individually invalid. */
  dropped: number
}

/**
 * AD-6a with AD-12 — a whole model's contribution must not be discarded because
 * one item in it was malformed. The envelope is still schema-validated and still
 * retried once; only after the retry fails do we look at the raw payload and
 * keep the items that ARE valid, warning about the ones dropped. Discarding all
 * of them would shrink the denominator over a defect in a single field.
 */
export function salvageFindings(raw: unknown): Salvage | undefined {
  const envelope = looseEnvelopeSchema.safeParse(raw)
  if (!envelope.success) return undefined

  const findings: DiscoveryFinding[] = []
  let dropped = 0
  for (const item of envelope.data.findings) {
    const parsed = discoveryFindingSchema.safeParse(item)
    if (parsed.success) findings.push(parsed.data)
    else dropped += 1
  }
  if (findings.length === 0) return undefined
  return { findings, dropped }
}

export interface DiscoverInput {
  roster: Roster
  /**
   * The routes a refused pool slot may be replaced with, each bound in
   * `backend` under its slot id. Absent means no slot is replaced: a refused
   * slot is recorded as not replaced, with no plan.
   */
  recovery?: RecoveryPlan
  backend: ModelBackend
  /** AD-11 — the POOL's instruction set. Every pool slot gets exactly this. */
  instructions: InstructionSet
  /**
   * AD-11 amended — resolves one lens's instruction set. Injected so a test can
   * script it; defaults to the shipped registry.
   *
   * The task type is `coding` here and the reason is a non-goal rather than an
   * omission (`core/instructions/types.ts`): v1 populates one task type, and the
   * registry's shape is what keeps a second from reopening this layer.
   */
  resolveLens?: (lens: string) => InstructionSet
  /** The material under review — the diff, plus whatever framing the caller adds. */
  input: string
  clock: Clock
  ledger: TokenLedger
  /**
   * AD-15 amended — the budget's PEAK half. Optional so a test driving this
   * stage alone need not build one; absent means the fan-out is unbounded, which
   * is the behaviour every caller had before story 7A. `review()` always passes
   * one, so no real run is unbounded.
   */
  limiter?: ConcurrencyLimiter
  /**
   * AD-2 amended / AD-6f — the user's stop. Optional: a caller that cannot be
   * cancelled passes nothing and this stage behaves exactly as it did.
   */
  signal?: AbortSignal
  /**
   * Story 2-5c — the experiment's per-request admission. Optional; absent, the
   * stage gates exactly as it does without it. See `runWithOneRetry`.
   */
  admission?: RequestAdmission
}

export interface DiscoverResult {
  /** Present when a pool slot was refused: what was refused, and what replaced it or why nothing did. */
  recovery?: RunRecovery
  /**
   * The pool: every answering model's findings unioned, in roster-slot order.
   * Not merged, not deduplicated — one defect appears once per model that raised
   * it until clustering runs (AD-14, story 3).
   */
  findings: Finding[]
  /**
   * AD-6a — the denominator: how many POOL models actually answered. A lens slot
   * answering never moves it (`pipeline-stages.md` §1: "it counts pool models
   * only"), because a lens finding claims no co-discovery prior to divide.
   */
  answered: number
  /** Slots that dropped out after their one retry — pool and lens alike. */
  droppedOut: string[]
  /**
   * Slots still eligible after discovery that a refusal received by another
   * slot covers (`refusalCovers`), pool, replacement and lens alike: slots that
   * answered, and slots whose turn the host aborted or the stop cancelled. Each
   * was warned about once. What each answered, and the denominator, are
   * unchanged; `review()` does not offer them to debate or the judge.
   */
  excludedByRefusal: string[]
  /**
   * AD-15 / CAP-7 (story 8) — slots the BUDGET refused, pool and lens alike, in
   * fan-out order. Never asked, so never billed and never blamed.
   *
   * Required and never optional, for the reason `pool` and `lensInstructions`
   * are: absent and empty must not be two ways of saying the same thing.
   *
   * `review()` reads it for two separate jobs, and BOTH matter: it records the
   * ids on the run, and it filters them out of `answeredSlots` — a slot that was
   * never asked must not be seated as a skeptic in a debate room and billed
   * under the very budget that refused it.
   */
  skippedForBudget: string[]
  /**
   * AD-11 amended / AD-17e — one entry per lens slot, in `lensSlots` order,
   * saying whether its instruction was SHIPPED or GENERATED at run time. It
   * survives to output because a generated lens a reader cannot distinguish from
   * a shipped one is the amendment unimplemented.
   */
  lensInstructions: LensInstructionRecord[]
  warnings: Warning[]
  /**
   * AD-6f — whether this stage stopped issuing turns because the run was
   * cancelled. `review()` reads it to name the stage in the ONE run-level
   * warning; the stage does not raise that warning itself, because "where did
   * the run stop" is a fact about the run and every stage after this one would
   * report it too.
   */
  cancelled: boolean
}

function toLocus(raw: { file: string; startLine?: number; endLine?: number }): Locus {
  // Spine convention: repo-relative POSIX, 1-indexed, endLine inclusive and
  // equal to startLine for a single line. A claim with no single site carries
  // `file` only.
  const file = raw.file.replaceAll("\\", "/").replace(/^\.\//, "")
  if (raw.startLine === undefined) return { file }
  const startLine = raw.startLine
  const endLine = raw.endLine === undefined || raw.endLine < startLine ? startLine : raw.endLine
  return { file, startLine, endLine }
}

/**
 * One turn plus, on failure, exactly one retry (AD-6b, AD-12), except after a
 * refused request, which is not retried.
 *
 * ## Cancellation short-circuits the retry, and that is the whole rule
 *
 * The signal is checked BEFORE each attempt, so the second attempt is never
 * issued for a turn the user stopped — AD-6(b)'s retry exists for a model that
 * failed, and spending a user's money twice to disobey them is not a retry
 * policy. A backend that honours the signal and returns `cancelled` gets the
 * same treatment: the loop returns immediately with `attempts: 1` rather than
 * counting a second billed call the caller never made.
 *
 * The check is what makes cancellation work on EVERY backend (AD-2 amended). A
 * backend that ignores the signal entirely still stops costing money here,
 * because the core never issues the next turn.
 */
/**
 * What one slot's turn came to — and the third possibility story 8 added.
 *
 * A LOCAL discriminated union, deliberately, and NOT a `budget-refused` member
 * on the `TurnFailure` port union. Two reasons, and both are about honesty
 * rather than tidiness:
 *
 *   1. The budget is the CORE's alone. A failure member no adapter may ever
 *      produce is a port contract that lies about what a backend can return.
 *   2. A fabricated failure ENVELOPE flows straight into `collect`'s `!raised`
 *      branch, where it becomes a `model-dropped-out` warning naming a provider
 *      that was working fine — the exact false degradation report this stage
 *      already refuses to produce for cancellation.
 */
type SlotOutcome =
  | {
      skippedForBudget: false
      envelope: Envelope<DiscoveryEnvelope>
      attempts: number
      /** Story 2-5c — set when the experiment's admission refused this slot's retry. */
      admissionReason?: string
    }
  /**
   * Never asked. `attempts` is the count actually BILLED, so it is always 0.
   * `admissionReason` is set when the experiment's admission refused, rather
   * than the run's ledger (story 2-5c).
   */
  | {
      skippedForBudget: true
      attempts: 0
      admissionReason?: string
      /**
       * Set when the ledger refused under the unknown-usage stop
       * (`stopOnUnknownUsage`) rather than at its ceiling, read at the gate so
       * a later turn's usage cannot change the cause.
       */
      unknownUsageStop?: true
    }

async function runWithOneRetry(
  input: DiscoverInput,
  slot: string,
  instructions: string,
  /**
   * AC3 (story 2.3) — WHERE A SESSION MAD COULD NOT DELETE IS WRITTEN DOWN, and
   * it is a parameter rather than something read off the returned envelope.
   *
   * The reason is the retry: this loop returns ONE envelope and the first
   * attempt's is discarded, so a caller reading only the result would drop a
   * session that is still sitting on the host whenever the retry succeeded —
   * the silent swallow AC3 exists to end, reintroduced one level up. Unknown
   * USAGE needs no such channel because it goes to the ledger, which is the
   * run's one record of money; a cleanup fact has no home on the record, so the
   * stage carries it to the warning it raises.
   */
  cleanups: { slot: string; why: string }[],
): Promise<SlotOutcome> {
  let last: Envelope<DiscoveryEnvelope> | undefined
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (input.signal?.aborted) {
      // NOT `last`, and not `attempts: 2`. A turn that was never issued is not a
      // turn that failed twice.
      //
      // AND IT IS `0`, NOT `1` (code review 2026-08-31, decision recorded in the
      // Spec Change Log). Story 7A's I/O matrix said 1; `attempts` is read
      // everywhere else in this codebase as BILLED CALLS — `output.ts` prints it
      // as "N turn(s) were BILLED against those M allocation(s)" — and a turn the
      // core refused to issue was never billed. Returning 1 here would make that
      // line overstate spend on exactly the runs a user stopped to save money.
      // The matrix row's actual content, "never 2", is what this preserves.
      return {
        skippedForBudget: false,
        envelope: cancelledTurn<DiscoveryEnvelope>(slot),
        attempts: attempt - 1,
      }
    }
    // AD-15 / CAP-7 (story 8) — THE BUDGET GATE, and it is on the FIRST attempt
    // too, not only the retry.
    //
    // Gating only the retry would leave the widest stage in the run effectively
    // unmetered, since a retry only ever happens after a failure: `budget: 0`
    // would still bill the entire fan-out, and the defect `core/run/review.ts`
    // documents in shipped source — discovery eats the cap, every contested
    // finding strands at debate's first gate with no debate turn run — would
    // survive the story written to close it.
    //
    // IT SITS HERE, INSIDE THE PER-SLOT CALL, and that placement is the point:
    // `withSlot` wraps each individual `runWithOneRetry` rather than either
    // `Promise.all`, so a slot asks after earlier slots have recorded their
    // spend. A check before the fan-out would return the same answer for every
    // slot and meter nothing.
    //
    // The known imprecision, stated rather than hidden: the limiter admits up to
    // `maxConcurrency` turns at once, so a wave already in flight can carry the
    // total past the ceiling — the same overshoot `mayISpend` documents for
    // every gate in this codebase, bounded here by the peak rather than by the
    // fan-out.
    //
    // `attempt - 1` is the billed count, for the reason the cancellation branch
    // above gives at length: a turn the core refused to issue was never billed.
    // On a refused RETRY it is 1, which is a slot that failed ONCE and could not
    // be asked again — a different fact from failing twice, and `collect` words
    // it differently.
    if (!mayISpend(input.ledger, "discover")) {
      if (attempt === 1) {
        // `mayISpend` asks the unknown-usage stop first, so when it holds it is
        // why the gate refused.
        const unknownStop = input.ledger.stopOnUnknownUsage === true && !usageIsComplete(input.ledger)
        return { skippedForBudget: true, attempts: 0, ...(unknownStop ? { unknownUsageStop: true as const } : {}) }
      }
      return { skippedForBudget: false, envelope: last!, attempts: 1 }
    }
    // Story 2-5c — THE EXPERIMENT'S GATE, asked after the ledger's and only when
    // an evaluation supplied one. A refusal takes the budget branch above for
    // every cause, so no retry follows it and nothing blames the model. The
    // signal is read again once admission resolves, because admission may wait
    // on I/O: a stop that landed meanwhile settles the request as never issued.
    // Nothing is awaited between that check and `runTurn`.
    let settle: SettleRequest | undefined
    let admitted: AdmittedTurn | undefined
    if (input.admission !== undefined) {
      const decision = await input.admission.admit({ stage: "discover", slot, attempt })
      if (!decision.ok) {
        if (attempt === 1) return { skippedForBudget: true, attempts: 0, admissionReason: decision.reason }
        return { skippedForBudget: false, envelope: last!, attempts: 1, admissionReason: decision.reason }
      }
      if (input.signal?.aborted) {
        await decision.settle({ kind: "not-issued" })
        return {
          skippedForBudget: false,
          envelope: cancelledTurn<DiscoveryEnvelope>(slot),
          attempts: attempt - 1,
        }
      }
      settle = decision.settle
      admitted = stageGatedTurn(decision.turn, () => mayISpend(input.ledger, "discover"), "discover")
    }
    let envelope: Envelope<DiscoveryEnvelope>
    let threw = false
    try {
      envelope = await input.backend.runTurn(
        slot,
        instructions,
        input.input,
        discoveryEnvelopeSchema,
        input.signal,
        admitted,
      )
    } catch (error) {
      // A backend is supposed to return failures, not throw them (spine,
      // Errors). If one throws anyway, that is still this slot's problem and
      // must not take the rest of the fan-out down with it.
      threw = true
      envelope = {
        ok: false,
        slot,
        failure: "transport-error",
        message: error instanceof Error ? error.message : "backend threw a non-Error value",
      }
    }
    // FR10 / AC1 (story 2.3) — THE ORDERED RECORD, AND THE ORDER IS THE RULE.
    //
    // Unknown marker FIRST, else `tokens`, else nothing. The whole of this used
    // to be `if (envelope.tokens) recordTurn(...)`, and that guard is what made
    // the lie possible: the adapter had no way to say "the host reported no
    // usage" and fabricated `emptyTokenUsage()`, which is a TRUTHY object, so an
    // all-zero entry landed in the ledger and a turn that billed money was
    // recorded as a turn that cost nothing — in the direction that flatters MAD.
    // `evaluation-protocol.md:341-343` names that line as the reason the
    // protocol's own stop rule could not work before this story.
    //
    // The order decides exactly one case: an envelope carrying BOTH. The marker
    // wins, because a backend that sent both has told MAD two things about one
    // turn and only one of them is defensible — taking the number would be the
    // pre-2.3 behaviour arriving through a different door.
    //
    // `else`, and never two `if`s. A turn is counted once or marked once. Doing
    // both would put one execution in `entries` AND in `unknownUsage`, and every
    // reader downstream treats those two collections as a partition:
    // `usageIsComplete`, the manifest's audit verdict, and the renderer's
    // observed-spend caveat all read them that way.
    //
    // NO RETRY IS ADDED, and none may be — "Cancellation, budget refusal and
    // unquantified usage never authorize a retry" (`evaluation-protocol.md:311-327`).
    // A turn whose first attempt cannot be counted is a turn a retry makes
    // WORSE: it adds a second uncountable bill to the first.
    //
    // THE LOOP BELOW IS UNTOUCHED, AND THE REFUSAL COMES FROM THE ACCOUNTANT
    // INSTEAD — which is the whole reason it can be honoured without a second
    // gate in this stage. `mayISpend` is asked before EVERY attempt including
    // the retry, and it refuses once the ledger holds an unknown and the run's
    // `stopOnUnknownUsage` dial is set. So under an evaluation, a failed turn
    // whose usage is unknown is asked ONCE and never again; under an ordinary
    // review the dial is off, the retry proceeds, and the second attempt is
    // recorded as its own unknown. Both behaviours are deliberate and the story
    // records why (*Dev Notes → Why the stop rule is a dial*); the protocol's
    // rule binds the first, which is the path that bills an experiment.
    //
    // Pinned end-to-end by `discover.test.ts`'s "AC4 — with the stop dial set,
    // the retry after an unknown is REFUSED, not billed", because the dial being
    // correct in `core/budget/ledger.ts` proves nothing about the stage reaching
    // it on the retry path.
    if (envelope.usageUnknown) {
      recordUnknownTurn(input.ledger, {
        slot,
        stage: "discover",
        attempt,
        executionId: envelope.usageUnknown.executionId,
        why: envelope.usageUnknown.why,
      })
    } else if (envelope.tokens) {
      recordTurn(input.ledger, { slot, stage: "discover", attempt, tokens: envelope.tokens })
    }
    if (settle !== undefined) await settle(settlementOf(envelope, threw))
    // AC3 — collected per ATTEMPT, for the reason the parameter's comment gives.
    if (envelope.cleanupUnresolved) cleanups.push({ slot, why: envelope.cleanupUnresolved.why })
    if (envelope.ok) return { skippedForBudget: false, envelope, attempts: attempt }
    // A backend that DID honour the signal reports `cancelled`. Same rule as the
    // pre-check above: no second attempt, and the attempt that was billed is
    // counted honestly. One the backend ended before its prompt was sent
    // (`endedBeforePrompt`) is not counted, so a first attempt ended that way leaves
    // the slot never asked.
    if (envelope.failure === "cancelled") {
      return { skippedForBudget: false, envelope, attempts: endedBeforePrompt(envelope) ? attempt - 1 : attempt }
    }
    // Ledger #7 — the host reported the turn aborted. The attempt was issued and
    // is recorded above; a second one is not taken, whatever its usage was.
    if (envelope.failure === "host-aborted") {
      return { skippedForBudget: false, envelope, attempts: attempt }
    }
    // A REFUSED REQUEST IS NOT RETRIED. When the backend classifies this
    // attempt as an authentication, payment or capability refusal (`Refusal`),
    // discovery skips its automatic retry. The classification does not
    // establish the account's state, and this attempt's usage may be unknown;
    // it is recorded above either way. On the retry, this ends the slot as the
    // loop would.
    if (envelope.refusal !== undefined) {
      return { skippedForBudget: false, envelope, attempts: attempt }
    }
    last = envelope
  }
  return { skippedForBudget: false, envelope: last!, attempts: 2 }
}

/** Why a refused slot got no replacement, as the clause its drop-out row ends with. */
function notReplacedReason(entry: NotReplaced): string {
  switch (entry.reason) {
    case "no-plan":
      return "no recovery plan was supplied"
    case "pinned":
      return (
        `the slot was pinned to \`${entry.detail ?? "this model"}\`, and MAD does not put a model or ` +
        `provider the pin did not name in its place`
      )
    case "no-candidate":
      return "the host offers no model outside the pool on a provider or route that was not refused"
    case "budget":
      return "the budget refused the replacement's turn before it was dispatched"
    case "unknown-usage":
      return (
        "the unknown-usage stop refused the replacement's turn before it was dispatched, because an " +
        "earlier turn's usage was not reported"
      )
    case "admission":
      return `the experiment's admission refused the replacement's turn (${entry.detail ?? "no reason given"})`
    case "cancelled":
      return "the run was stopped before a replacement was dispatched"
  }
}

export async function discover(input: DiscoverInput): Promise<DiscoverResult> {
  const { roster, clock } = input
  // Before any turn is dispatched, so an inconsistent plan spends nothing.
  if (input.recovery !== undefined) validateRecoveryPlan(input.recovery, roster)
  const resolveLens =
    input.resolveLens ?? ((lens: string) => resolveInstructions({ taskType: "coding", role: "discovery", lens }))

  // AD-11 amended — resolved BEFORE the fan-out, so a generated lens is recorded
  // whether or not its turn survives. One entry per lens slot, in slot order.
  const lensSets = roster.lensSlots.map((lensSlot) => resolveLens(lensSlot.lens))
  const lensInstructions: LensInstructionRecord[] = roster.lensSlots.map((lensSlot, index) => ({
    lens: lensSlot.lens,
    origin: lensSets[index]!.origin,
  }))

  // Spine, Concurrency: discovery fans out in parallel across the roster — every
  // turn is started before any is awaited, so the fan-out does not degenerate
  // into a sequence. Every slot is isolated: `runWithOneRetry` converts a throw
  // into a failure envelope, so one bad backend cannot abort the whole fan-out
  // and cost the run every other model's findings (AD-6b).
  //
  // PEAK CONCURRENCY IS THE LIMITER'S, NOT THE SLOT COUNT (AD-15 amended, story
  // 7A). This comment used to say the two were equal, and that was the problem:
  // at the shipped ceilings the slot count is 12 + 8 = 20 simultaneous billed
  // sessions against one user's credentials. `withSlot` wraps each INDIVIDUAL
  // turn rather than either `Promise.all`, so the array shape — and pooling
  // contract 3's positional resolution with it — is exactly what it was.
  //
  // Pooling contract 5: pool turns and lens turns start in ONE fan-out, so peak
  // concurrency is pool + lens slots and the lens pass costs no extra wall-clock
  // round. They are separated again in the sequential post-pass below, which is
  // where the two segments' different meanings live.
  //
  // Pooling contract 2 (independence): each POOL slot is handed the SAME
  // `input.input` and `input.instructions` and nothing else. A lens slot gets
  // that same input and its own lens instruction — the one difference the whole
  // capability consists of. There is no channel by which one slot's findings
  // could reach another, lensed or not.
  //
  // Pooling contract 3: `Promise.all` resolves POSITIONALLY, so `outcomes` is in
  // roster order however the turns actually completed — and the pool's entries
  // precede the lens slots' by construction of the array.
  const withSlot = <T>(turn: () => Promise<T>): Promise<T> =>
    input.limiter ? input.limiter.run(turn) : turn()

  // Story 2.3 — the two facts this stage learns about a turn that are NOT about
  // findings, gathered here so the warnings below are raised once for the stage
  // rather than once per slot.
  //
  // THE UNKNOWNS ARE NOT COLLECTED INTO A SECOND LIST, deliberately. They are
  // already on the ledger, which is the run's ONE record of what was spent, and
  // a stage keeping its own parallel count of money is the second authority
  // AD-15 exists to prevent. `unknownUsageCount` marks the ledger's high-water
  // point before the fan-out, and everything appended past it is this stage's —
  // the stages run strictly in sequence (`core/run/review.ts`), so the tail is
  // exactly what discovery recorded. Cleanups have no place on the record at
  // all, which is why they alone need the array.
  const unknownBefore = unknownUsageCount(input.ledger)
  const cleanups: { slot: string; why: string }[] = []

  const [poolOutcomes, lensOutcomes] = await Promise.all([
    Promise.all(
      roster.slots.map(async (rosterSlot) => ({
        rosterSlot,
        ...(await withSlot(() => runWithOneRetry(input, rosterSlot.slot, input.instructions.text, cleanups))),
      })),
    ),
    Promise.all(
      roster.lensSlots.map(async (lensSlot, index) => ({
        rosterSlot: lensSlot as RosterSlot,
        lens: lensSlot.lens,
        ...(await withSlot(() => runWithOneRetry(input, lensSlot.slot, lensSets[index]!.text, cleanups))),
      })),
    ),
  ])

  const findings: Finding[] = []
  const warnings: Warning[] = []
  const droppedOut: string[] = []
  const skippedForBudget: string[] = []
  /** Ledger #7 — slots, pool and lens, whose turn the host reported aborted. */
  const hostAborted: string[] = []
  /** AD-6f — slots whose outcome was the user's stop, and whether a turn of theirs was issued. */
  const cancelledSlots: { slot: string; issued: boolean }[] = []
  /** Story 2-5c — the admission's reason for each slot it refused, by slot. */
  const admissionRefusals = new Map<string, string>()
  let answered = 0

  /**
   * One outcome, turned into findings and warnings.
   *
   * Returns whether the slot ANSWERED. Only the pool segment adds that to the
   * denominator (AD-6a) — the caller decides, so the rule lives in one visible
   * place rather than inside a branch on `source`.
   */
  const collect = (
    outcome: { rosterSlot: RosterSlot } & SlotOutcome,
    origin: { source: FindingSource; lens?: string },
  ): boolean => {
    const { rosterSlot } = outcome
    const modelName = `${rosterSlot.providerId}/${rosterSlot.modelId}`

    // AD-15 / AD-6a (story 8) — A SLOT THE BUDGET REFUSED IS NOT A DROP-OUT,
    // and this is the branch where it would silently become one. Same shape,
    // and the same reasoning, as the cancellation rule below it: the model did
    // not fail, it was never asked. It gets no warning naming it and no place in
    // `droppedOut`, which `review()` reads to decide who is still alive to
    // debate.
    //
    // The denominator still shrinks — AD-6(a) counts answers, never requests —
    // and `denominator-reduced`'s `becauseBudget` clause is where the cause is
    // named, once, without a provider in it.
    if (outcome.skippedForBudget) {
      skippedForBudget.push(rosterSlot.slot)
      if (outcome.admissionReason !== undefined) admissionRefusals.set(rosterSlot.slot, outcome.admissionReason)
      return false
    }
    const { envelope } = outcome

    // AD-6a — before writing this model off, see whether part of its answer is
    // usable. One off-scale severity should cost one finding, not the model.
    let raised: DiscoveryFinding[] | undefined
    let salvaged: Salvage | undefined
    if (envelope.ok) {
      raised = envelope.value.findings
    } else if (envelope.failure === "schema-invalid" && envelope.raw !== undefined) {
      salvaged = salvageFindings(envelope.raw)
      raised = salvaged?.findings
    }

    if (!raised) {
      // AD-2 amended / AD-6f — A CANCELLED TURN IS NOT A DROP-OUT, and this is
      // the branch where it would silently become one. The model did not fail;
      // it was never asked. Reporting it here would blame a working provider for
      // the user's own stop, put its name in a degradation warning, and add it
      // to `droppedOut` — which `review()` reads to decide who is still alive to
      // debate, so one cancelled run would exclude a healthy model from a LATER
      // stage's rooms. Cancellation is reported ONCE, by `review()`, under
      // AD-6(f).
      //
      // The denominator still shrinks, because this slot genuinely did not
      // answer and AD-6(a) counts answers rather than requests. What must not
      // happen — and does not — is a model being named as the cause.
      if (!envelope.ok && envelope.failure === "cancelled") {
        // Whether this slot's turn went out: a stop caught before the first
        // attempt issued nothing, one reported by the backend came back from a
        // turn that was issued.
        cancelledSlots.push({ slot: rosterSlot.slot, issued: outcome.attempts > 0 })
        return false
      }

      // Ledger #7 — A HOST-ABORTED TURN IS NOT A DROP-OUT EITHER. The host
      // reported the turn aborted and nothing says who aborted it or why, so the
      // model is not named as failing and the slot is not added to `droppedOut`:
      // it stays eligible for later, independently planned turns. It did not
      // answer, so it still does not count toward the denominator.
      if (!envelope.ok && envelope.failure === "host-aborted") {
        hostAborted.push(rosterSlot.slot)
        warnings.push(
          hostAbortedWarning({
            stage: "discover",
            slot: rosterSlot.slot,
            model: modelName,
            attempts: outcome.attempts,
            error: envelope.message,
            turn: origin.source === "lens" ? `lens discovery` : `discovery`,
            consequence:
              origin.source === "lens"
                ? `this lens's vantage is missing from discovery.`
                : `it is excluded from the co-discovery denominator.`,
            ...(outcome.admissionReason === undefined ? {} : { admission: outcome.admissionReason }),
          }),
        )
        return false
      }

      // AD-6b — retried once already; proceed with a warning naming the model.
      droppedOut.push(rosterSlot.slot)
      // AD-6b / AD-15 (story 8) — "failed twice" IS A COUNT, AND IT MUST BE THE
      // REAL ONE. When the budget refuses the retry, this model failed ONCE and
      // was not asked again; saying "twice" would bill it for a turn nobody ran
      // and overstate its unreliability in the one report a reader uses to judge
      // it. The retry that did not happen is named by its actual cause.
      //
      // A REFUSED request says so, with the attempt it happened on: refused on
      // its first attempt, the retry was skipped; refused on its retry, the
      // first attempt had failed in an ordinary way.
      const refusal = envelope.ok ? undefined : envelope.refusal
      const howOften =
        refusal !== undefined
          ? outcome.attempts < 2
            ? `was refused on its only attempt (${describeRefusal(refusal)}), so it was not retried`
            : `failed once, then its retry was refused (${describeRefusal(refusal)})`
          : outcome.attempts < 2
            ? outcome.admissionReason === undefined
              ? `failed once, and the budget refused the retry`
              : `failed once, and the experiment's admission refused the retry (${oneLine(outcome.admissionReason)})`
            : `failed twice`
      warnings.push({
        code: "model-dropped-out",
        stage: "discover",
        // A salvage attempt can leave a technically-ok envelope with nothing
        // usable in it, so the cause is read only from the failure branch.
        message:
          `MODEL DROPPED OUT: \`${modelName}\` (slot ${rosterSlot.slot}) ${howOften} ` +
          `(${envelope.ok ? "no usable findings" : `${envelope.failure}: ${envelope.message}`}). ` +
          `The run continued without it, and it is excluded from the co-discovery denominator.`,
        detail: {
          slot: rosterSlot.slot,
          model: modelName,
          attempts: outcome.attempts,
          failure: envelope.ok ? "none" : envelope.failure,
          error: envelope.ok ? "" : envelope.message,
          ...(outcome.admissionReason === undefined ? {} : { admission: outcome.admissionReason }),
          ...(refusal === undefined
            ? {}
            : {
                refusal: { kind: refusal.kind, basis: refusal.basis, scope: refusal.scope },
                retry: outcome.attempts < 2 ? "skipped" : "refused",
              }),
        },
      })
      return false
    }

    if (salvaged) {
      // The model answered; part of what it said was unusable. That is a
      // degradation, so it is reported — but it is not a drop-out, and the
      // denominator keeps this model (AD-6a).
      warnings.push({
        code: "partial-envelope",
        stage: "discover",
        message:
          `PARTIAL ANSWER: \`${modelName}\` (slot ${rosterSlot.slot}) returned ` +
          `${salvaged.dropped} finding(s) that failed schema validation; they were dropped and ` +
          `${salvaged.findings.length} valid finding(s) were kept. The model still counts toward ` +
          `the co-discovery denominator.`,
        detail: {
          slot: rosterSlot.slot,
          model: modelName,
          kept: salvaged.findings.length,
          dropped: salvaged.dropped,
        },
      })
    }

    const at = clock.now()
    for (const raw of raised) {
      const finding: Finding = {
        id: clock.id("finding"),
        claim: raw.claim,
        reasoning: raw.reasoning,
        locus: toLocus(raw),
        severity: raw.severity,
        author: rosterSlot.slot,
        // AD-8 / AD-9 amended — discovery owns these two, and `source` is what
        // every downstream stage reads to know whether a prior is claimable at
        // all. `lens` is set on a lens finding and left absent on a pool one.
        source: origin.source,
        ...(origin.lens === undefined ? {} : { lens: origin.lens }),
        history: [],
      }
      // AD-7 — history is append-only; discovery appends the first entry.
      appendEntry(finding, {
        stage: "discover",
        actor: rosterSlot.slot,
        at,
        kind: "raised",
        body: raw.claim,
      })
      findings.push(finding)
    }
    return true
  }

  // Pooling contracts 1, 3, 4 and 5: one SEQUENTIAL pass over the positional
  // outcomes, in TWO ORDERED SEGMENTS — every pool slot in roster order, then
  // every lens slot in `lensSlots` order. It is what makes the pooled order
  // roster order, the ids unique and stable, and the result a plain union — no
  // member of `findings` is ever compared against, folded into, or deduplicated
  // against another here. Pool findings get exactly the ids they get with no
  // lenses configured, because the lens segment runs strictly after them.
  // The original pool slots that answered round 1: what recovery prefers a
  // fresh lineage against, and the originals `answeredLineages` counts.
  const answeredOriginals: RosterSlot[] = []
  for (const outcome of poolOutcomes) {
    // AD-6a — the denominator, and the ONLY place it moves.
    if (collect(outcome, { source: "pool" })) {
      answered += 1
      answeredOriginals.push(outcome.rosterSlot)
    }
  }
  for (const outcome of lensOutcomes) {
    // AD-6a / AD-17d — a lens slot answering does NOT move `answered`. Its
    // findings claim no prior, so there is nothing for the denominator to
    // divide, and inflating it would shrink every pool fraction on the page.
    collect(outcome, { source: "lens", lens: outcome.lens })
  }

  // ---- round 2: discovery recovery ----
  //
  // A POOL slot whose turn ended in a classified refusal (`Refusal`) gets at
  // most one replacement, from `input.recovery`, in roster slot order. Only
  // round 1's evidence decides: the providers and routes refused in round 1,
  // pool and lens, are excluded, and nothing a replacement's own turn reports
  // changes that set, this slot's record, or anyone else's. There is no third
  // round and no replacement of a replacement.
  //
  // A slot a caller's pin filled (`RecoveryPlan.pinned`) is never replaced: the
  // user named that model through that provider, and a substitute would spend
  // where the pin did not authorize. A slot ranking filled is replaced as usual.
  //
  // Among the eligible routes, allocation prefers one whose VERIFIED lineage is
  // absent from the originals that answered round 1 and from earlier
  // allocations, then falls back to the plan's order. Restoring the refused
  // model's lineage and adding another fresh one count the same (AD-5). The
  // routes keep their bound slot ids; only the choice among them changes.
  //
  // A model is consumed when it is ALLOCATED, before anything is dispatched, so
  // which slot gets which model does not depend on completion order. A
  // replacement whose first attempt is never dispatched (the budget, the
  // unknown-usage stop, the admission or a stop refused it) leaves no slot of
  // its own: the original is
  // recorded as not replaced, with that cause. A dispatched one is collected
  // as a pool slot like any other, so it answers, drops out or is cancelled
  // under the ordinary rules, and an answer counts toward the denominator.
  const refusedOutcomes = poolOutcomes.filter(
    (outcome) => !outcome.skippedForBudget && !outcome.envelope.ok && outcome.envelope.refusal !== undefined,
  )
  let recovery: RunRecovery | undefined
  // Set when the stop is why round 2 allocated no replacement for a refused
  // slot that had an eligible route.
  let stoppedBeforeReplacement = false
  const replacementOutcomes: ({ rosterSlot: RosterSlot; from: string } & SlotOutcome)[] = []
  if (refusedOutcomes.length > 0) {
    const refusalOfOutcome = (outcome: SlotOutcome): Refusal | undefined =>
      outcome.skippedForBudget || outcome.envelope.ok ? undefined : outcome.envelope.refusal
    const refused: RefusedSlot[] = refusedOutcomes.map((outcome) => ({
      slot: outcome.rosterSlot.slot,
      refusal: refusalOfOutcome(outcome)!,
    }))
    const excluded = refusalExclusions(
      [...poolOutcomes, ...lensOutcomes].flatMap((outcome) => refusalOfOutcome(outcome) ?? []),
    )
    const modelOf = (slot: string): string => {
      const rosterSlot = roster.slots.find((candidate) => candidate.slot === slot)!
      return `${rosterSlot.providerId}/${rosterSlot.modelId}`
    }
    const allocatedIdentities = new Set(roster.slots.map((rosterSlot) => rosterSlot.identity))
    const heldLineages = new Set(
      answeredOriginals.filter((slot) => slot.lineage.verified).map((slot) => slot.lineage.lineage),
    )
    const notReplaced: NotReplaced[] = []
    const allocations: { from: string; to: RosterSlot }[] = []
    for (const entry of refused) {
      if (input.recovery === undefined) {
        notReplaced.push({ from: entry.slot, reason: "no-plan" })
        continue
      }
      if (input.recovery.pinned.includes(entry.slot)) {
        notReplaced.push({ from: entry.slot, reason: "pinned", detail: modelOf(entry.slot) })
        continue
      }
      const eligible = input.recovery.candidates.filter(
        (candidate) =>
          !allocatedIdentities.has(candidate.identity) && excluded(candidate) === undefined,
      )
      const to =
        eligible.find((candidate) => candidate.lineage.verified && !heldLineages.has(candidate.lineage.lineage)) ??
        eligible[0]
      if (to === undefined) {
        notReplaced.push({ from: entry.slot, reason: "no-candidate" })
        continue
      }
      // A stop observed here is why a replacement that had a route is not
      // allocated, and that skipped allocation is this stage's: it is what makes
      // discovery the stage the run was stopped in. Every reason above holds
      // whether or not the run was stopped, so it is reported instead.
      if (input.signal?.aborted) {
        notReplaced.push({ from: entry.slot, reason: "cancelled" })
        stoppedBeforeReplacement = true
        continue
      }
      allocatedIdentities.add(to.identity)
      if (to.lineage.verified) heldLineages.add(to.lineage.lineage)
      allocations.push({ from: entry.slot, to })
    }

    replacementOutcomes.push(
      ...(await Promise.all(
        allocations.map(async ({ from, to }) => ({
          rosterSlot: to,
          from,
          ...(await withSlot(() => runWithOneRetry(input, to.slot, input.instructions.text, cleanups))),
        })),
      )),
    )

    const replacements: Replacement[] = []
    for (const outcome of replacementOutcomes) {
      if (outcome.skippedForBudget) {
        notReplaced.push({
          from: outcome.from,
          ...(outcome.admissionReason !== undefined
            ? { reason: "admission" as const, detail: outcome.admissionReason }
            : outcome.unknownUsageStop === true
              ? { reason: "unknown-usage" as const }
              : { reason: "budget" as const }),
        })
        continue
      }
      if (outcome.attempts === 0) {
        // Cancelled before its first attempt was dispatched.
        notReplaced.push({ from: outcome.from, reason: "cancelled" })
        continue
      }
      const answeredDiscovery = collect(outcome, { source: "pool" })
      if (answeredDiscovery) answered += 1
      replacements.push({
        from: outcome.from,
        to: outcome.rosterSlot,
        dispatched: outcome.attempts === 1 ? 1 : 2,
        answered: answeredDiscovery,
      })
    }
    const order = new Map(refused.map((entry, index) => [entry.slot, index]))
    notReplaced.sort((a, b) => order.get(a.from)! - order.get(b.from)!)
    // The pool that answered: originals that answered round 1 and replacements
    // that answered. Never `executionRoster`, which keeps the refused originals.
    const answeredPool = [
      ...answeredOriginals,
      ...replacements.filter((replacement) => replacement.answered).map((replacement) => replacement.to),
    ]
    const answeredLineages = countVerifiedLineages(answeredPool)
    recovery = { refused, replacements, notReplaced, answeredLineages }

    // Each refused original's drop-out row says what became of its slot, and
    // each dispatched replacement gets its own row.
    const rowOf = (slot: string): Warning | undefined =>
      warnings.find((warning) => warning.code === "model-dropped-out" && warning.detail?.slot === slot)
    for (const replacement of replacements) {
      const row = rowOf(replacement.from)
      if (row !== undefined) {
        row.message += ` It was replaced by slot ${replacement.to.slot}.`
        row.detail = { ...row.detail, recovery: { replacedBy: replacement.to.slot } }
      }
      const refusal = refused.find((entry) => entry.slot === replacement.from)!.refusal
      const to = `${replacement.to.providerId}/${replacement.to.modelId}`
      warnings.push({
        code: "model-replaced",
        stage: "discover",
        message:
          `MODEL REPLACED: \`${modelOf(replacement.from)}\` (slot ${replacement.from}) was refused ` +
          `(${describeRefusal(refusal)}); MAD dispatched \`${to}\` (slot ${replacement.to.slot}) in its ` +
          `place, ${replacement.dispatched} time(s), and it ` +
          (replacement.answered
            ? `answered discovery. Co-discovery fractions count the replacement as one pool model; `
            : `did not answer discovery, so it is not in the co-discovery denominator; `) +
          `the distinct-lineage count is the initial selection's.`,
        detail: {
          from: replacement.from,
          to: replacement.to.slot,
          model: to,
          refusal: { kind: refusal.kind, basis: refusal.basis, scope: refusal.scope },
          dispatched: replacement.dispatched,
          answered: replacement.answered,
        },
      })
    }
    for (const entry of notReplaced) {
      const row = rowOf(entry.from)
      if (row === undefined) continue
      row.message += ` It was not replaced: ${notReplacedReason(entry)}.`
      row.detail = { ...row.detail, recovery: { notReplaced: entry.reason } }
    }

    // AD-6c over the pool that answered, after recovery. The selection's own
    // report (`roster-single-lineage`) describes the roster MAD chose; this
    // says the pool whose answers the co-discovery fractions count holds fewer
    // verified lineages than that roster did, whether or not a replacement
    // restored the answer count.
    if (answeredLineages < roster.distinctLineages) {
      const lineages = [
        ...new Set(answeredPool.filter((slot) => slot.lineage.verified).map((slot) => slot.lineage.label)),
      ]
      warnings.push({
        code: "answered-lineages-reduced",
        stage: "discover",
        message:
          `FEWER LINEAGES ANSWERED: the initial selection held ${roster.distinctLineages} distinct verified ` +
          `lineage(s), but the pool that answered discovery after recovery holds ${answeredLineages}` +
          (lineages.length > 0 ? ` (${lineages.join(", ")})` : ``) +
          `. Co-discovery over this pool is a weaker signal than the selection's lineage count suggests: ` +
          `models from one lineage share blind spots, whatever the answer count reads.`,
        detail: {
          initialLineages: roster.distinctLineages,
          answeredLineages,
          lineages: [
            ...new Set(answeredPool.filter((slot) => slot.lineage.verified).map((slot) => slot.lineage.lineage)),
          ],
          replacements: replacements.length,
        },
      })
    }
  }

  // A refusal also covers every other slot on its route, or, at provider scope,
  // on its provider (`refusalCovers`). Discovery's own turns ran concurrently,
  // so nothing in it is excluded and its counts are untouched; the covered
  // slots that are still eligible are reported once here and are not offered
  // to debate or the judge.
  const seenRefusals: SlotRefusal[] = [...poolOutcomes, ...lensOutcomes, ...replacementOutcomes].flatMap(
    (outcome) =>
      outcome.skippedForBudget || outcome.envelope.ok || outcome.envelope.refusal === undefined
        ? []
        : [{ slot: outcome.rosterSlot.slot, refusal: outcome.envelope.refusal }],
  )
  const excludedByRefusal: string[] = []
  if (seenRefusals.length > 0) {
    const eligible = [
      ...roster.slots,
      ...(recovery?.replacements ?? []).map((replacement) => replacement.to),
      ...roster.lensSlots,
    ].filter((rosterSlot) => !droppedOut.includes(rosterSlot.slot) && !skippedForBudget.includes(rosterSlot.slot))
    for (const rosterSlot of eligible) {
      const by = coveringRefusal(seenRefusals, rosterSlot)
      if (by === undefined) continue
      excludedByRefusal.push(rosterSlot.slot)
      const modelName = `${rosterSlot.providerId}/${rosterSlot.modelId}`
      // A host-aborted or cancelled slot is eligible too, but it did not answer.
      const answeredDiscovery =
        !hostAborted.includes(rosterSlot.slot) && !cancelledSlots.some((entry) => entry.slot === rosterSlot.slot)
      warnings.push({
        code: "model-dropped-out",
        stage: "discover",
        message:
          `MODEL DROPPED OUT: \`${modelName}\` (slot ${rosterSlot.slot}) ${coveredByRefusalWords(by)}. ` +
          (answeredDiscovery
            ? `What it raised in discovery stands, and its place in the co-discovery denominator is unchanged; `
            : `It did not answer discovery, and that is reported separately; `) +
          `it is not seated in debate or asked by the judge.`,
        detail: { slot: rosterSlot.slot, model: modelName, excludedBy: excludedByDetail(by) },
      })
    }
  }

  // AD-6a — make the shrunken denominator itself visible, not just implied by
  // the fraction. Compared against the POOL only: `roster.slots.length` never
  // includes a lens slot, so a dropped-out lens can never make this fire and a
  // filled lens roster can never make it stop firing.
  // AD-6f — read off the OUTCOMES and off a replacement the stop kept round 2
  // from allocating, never off `input.signal.aborted` alone. A stop that arrives
  // after the last turn has already returned, with no replacement left to
  // allocate, cancelled nothing here, and this stage must not claim to be where
  // the run stopped when it finished its work; the next stage to actually skip
  // a turn is the honest answer, and `review()` takes the FIRST stage that
  // reports one.
  // The pool the summaries below count over: the initial slots and every
  // dispatched replacement. `roster.slots.length` stays the filled count.
  const executionPoolIds = (): string[] => [
    ...roster.slots.map((rosterSlot) => rosterSlot.slot),
    ...(recovery?.replacements ?? []).map((replacement) => replacement.to.slot),
  ]
  const cancelled =
    stoppedBeforeReplacement ||
    [...poolOutcomes, ...lensOutcomes, ...replacementOutcomes].some(
      (outcome) =>
        !outcome.skippedForBudget && !outcome.envelope.ok && outcome.envelope.failure === "cancelled",
    )

  // AD-15 / AD-6 (story 8) — the budget truncated the roster, said ONCE, with no
  // provider in it.
  //
  // It is a separate code from `denominator-reduced` beside it, and the split is
  // the point: that one says the denominator shrank, this one says the budget is
  // why. A host agent reading only `metadata.warnings` codes can then tell a
  // budget-truncated roster from an under-delivering one, which is the whole
  // argument for a code rather than a sentence.
  //
  // The lens count is reported separately from the pool count because they cost
  // the same and mean different things: an unasked POOL slot costs the
  // co-discovery denominator every later fraction divides by, while an unasked
  // LENS slot costs only that lens's vantage (AD-17d).
  // A REPLACEMENT A GATE HELD BACK is a planned pool turn that was never
  // asked, for the refused slot it would have restored. It is reported beside
  // the skipped slots, never in `skippedForBudget`, whose ids are roster slots,
  // and each gate is named for what it is: the run's budget, the experiment's
  // admission, or the unknown-usage stop.
  const heldReplacements = (recovery?.notReplaced ?? []).filter(
    (entry) => entry.reason === "budget" || entry.reason === "admission" || entry.reason === "unknown-usage",
  )
  const heldCause = (): string => {
    const causes: string[] = []
    if (heldReplacements.some((entry) => entry.reason === "budget")) {
      causes.push(`dispatching it would have taken the run past ${ceilingNamed(input.ledger, "discover")}`)
    }
    const admission = [
      ...new Set(heldReplacements.filter((entry) => entry.reason === "admission").map((entry) => entry.detail ?? "")),
    ]
    if (admission.length > 0) causes.push(`the experiment's admission refused it (${admission.join("; ")})`)
    if (heldReplacements.some((entry) => entry.reason === "unknown-usage")) {
      causes.push("the unknown-usage stop refused it, because an earlier turn's usage was not reported")
    }
    return causes.join(", or ")
  }
  const heldSentence =
    heldReplacements.length === 0
      ? ""
      : `${heldReplacements.length} replacement(s) for refused pool slot(s) were never dispatched, because ` +
        `${heldCause()}.`

  if (skippedForBudget.length === 0 && heldReplacements.length > 0) {
    warnings.push({
      code: "discovery-truncated",
      stage: "discover",
      message:
        `REPLACEMENT HELD BACK: ${heldSentence} The refused slot(s) stay out of the co-discovery denominator, ` +
        `so this run examined the change with fewer models than recovery planned.`,
      detail: {
        slots: [],
        poolSkipped: 0,
        lensSkipped: 0,
        replacementsHeld: heldReplacements.map((entry) => ({ from: entry.from, reason: entry.reason })),
        cap: input.ledger.cap,
      },
    })
  }

  if (skippedForBudget.length > 0) {
    const poolSlots = new Set(executionPoolIds())
    const poolSkipped = skippedForBudget.filter((slot) => poolSlots.has(slot)).length
    const lensSkipped = skippedForBudget.length - poolSkipped
    // The ceiling is NAMED BY THE ACCOUNTANT, not computed here. A stage that
    // multiplies the cap by its own share is a stage metering itself, which
    // AD-15 forbids and `scripts/lint-dependency-direction.ts` catches.
    // Story 2-5c — when the experiment's admission refused every skipped slot,
    // the run's own ceiling did not, so the sentence names the admission instead.
    const admissionReasons = [...new Set(admissionRefusals.values())]
    // CAP-5 — THE TITLE NAMES THE SAME CAUSES AS THE BODY: every gate behind a
    // skipped roster slot, and every gate behind a held replacement.
    const gates = new Set<"BUDGET" | "ADMISSION" | "UNKNOWN-USAGE STOP">()
    if (admissionRefusals.size < skippedForBudget.length) gates.add("BUDGET")
    if (admissionRefusals.size > 0) gates.add("ADMISSION")
    for (const entry of heldReplacements) {
      gates.add(entry.reason === "budget" ? "BUDGET" : entry.reason === "admission" ? "ADMISSION" : "UNKNOWN-USAGE STOP")
    }
    const title = `${(["BUDGET", "ADMISSION", "UNKNOWN-USAGE STOP"] as const).filter((gate) => gates.has(gate)).join(" AND ")} TRUNCATED DISCOVERY`
    const cause =
      admissionRefusals.size === skippedForBudget.length
        ? `the experiment's admission refused them (${admissionReasons.join("; ")})`
        : `doing so would have taken the run past ${ceilingNamed(input.ledger, "discover")}` +
          (admissionReasons.length > 0 ? `, or the experiment's admission refused them (${admissionReasons.join("; ")})` : "")
    warnings.push({
      code: "discovery-truncated",
      stage: "discover",
      message:
        `${title}: ${poolSkipped} pool slot(s) and ${lensSkipped} lens slot(s) ` +
        `were never asked, because ${cause}. THOSE SLOTS were not skipped because a ` +
        `model failed — they were never asked at all.${heldSentence === "" ? "" : ` ${heldSentence}`} This run ` +
        `examined the change with fewer models than it had available.`,
      detail: {
        slots: [...skippedForBudget],
        poolSkipped,
        lensSkipped,
        ...(heldReplacements.length === 0
          ? {}
          : { replacementsHeld: heldReplacements.map((entry) => ({ from: entry.from, reason: entry.reason })) }),
        cap: input.ledger.cap,
        ...(admissionRefusals.size === 0 ? {} : { admission: Object.fromEntries(admissionRefusals) }),
      },
    })
  }

  if (answered < roster.slots.length) {
    // AD-6f (code review 2026-08-31, decision recorded in the Spec Change Log) —
    // A CANCELLED RUN SAYS WHY THE DENOMINATOR SHRANK.
    //
    // The number itself is right either way, and this warning already takes care
    // never to NAME a model. But "Only 1 of 3 roster model(s) answered" over a
    // run the user stopped still reads as the roster under-delivering, when the
    // other two were simply never asked. Story 7A's whole thesis is that
    // degradation is reported honestly, and a cause the report knows and does not
    // print is the same failure one step quieter.
    // AD-15 (story 8) — THE SAME RULE, FOR THE OTHER CAUSE MAD KNOWS ABOUT.
    // The budget is a reason the report knows for the denominator being smaller,
    // and a cause the report knows and does not print is the same failure one
    // step quieter. Counted off the pool ids rather than off `answered`, because
    // a run can lose slots to a drop-out AND to the budget at once — and both
    // clauses can be true in one run, which is why this is a second clause
    // rather than a branch.
    const poolIds = new Set(executionPoolIds())
    const poolSkippedCount = skippedForBudget.filter((slot) => poolIds.has(slot)).length
    const poolAdmissionRefused = skippedForBudget.filter((slot) => poolIds.has(slot) && admissionRefusals.has(slot)).length
    const becauseBudget =
      poolSkippedCount === 0
        ? ""
        : poolAdmissionRefused === poolSkippedCount
          ? ` ${poolSkippedCount} were never asked: the experiment's admission refused their turn.`
          : poolAdmissionRefused === 0
            ? ` ${poolSkippedCount} were never asked: the budget ran out before their turn.`
            : // CAP-5 — a mixed set names both causes, neither alone.
              ` ${poolSkippedCount} were never asked: the budget ran out before their turn, or the experiment's ` +
              `admission refused it.`
    // Ledger #7 — THE THIRD KNOWN CAUSE: the host reported a pool turn aborted.
    // Worded without an actor, because the report does not know one.
    const poolHostAbortedCount = hostAborted.filter((slot) => poolIds.has(slot)).length
    const becauseHostAborted =
      poolHostAbortedCount === 0
        ? ""
        : poolHostAbortedCount === 1
          ? ` 1 did not answer: the host reported its turn aborted.`
          : ` ${poolHostAbortedCount} did not answer: the host reported their turns aborted.`
    // AD-6f — the stop's clause, argued at the top of this block. Counted off
    // the pool slots whose OWN outcome was the stop, never as the remainder:
    // a slot that dropped out, was refused by the budget or the admission, or
    // whose turn the host reported aborted has its own cause and its own
    // sentence. And a stop is "never asked" only when no turn of that slot was
    // issued; one that went out and was then stopped did not answer because the
    // run was cancelled.
    const poolCancelled = cancelledSlots.filter((entry) => poolIds.has(entry.slot))
    const stoppedUnasked = poolCancelled.filter((entry) => !entry.issued).length
    const stoppedInFlight = poolCancelled.length - stoppedUnasked
    const otherwiseLost = roster.slots.length - answered - poolCancelled.length
    const becauseStopped =
      (stoppedUnasked === 0
        ? ""
        : otherwiseLost === 0 && stoppedInFlight === 0
          ? ` The remaining ${stoppedUnasked} were never asked: ${stoppedTheRun(stopCauseOf(input.signal))}.`
          : ` ${stoppedUnasked} were never asked: ${stoppedTheRun(stopCauseOf(input.signal))}.`) +
      (stoppedInFlight === 0 ? "" : ` ${stoppedInFlight} did not answer because the run was cancelled.`)
    warnings.push({
      code: "denominator-reduced",
      stage: "discover",
      message:
        `Only ${answered} of ${roster.slots.length} roster model(s) answered.${becauseStopped}` +
        `${becauseBudget}${becauseHostAborted}${heldSentence === "" ? "" : ` ${heldSentence}`} Every ` +
        `co-discovery fraction below is over ${answered}, not over ` +
        `${roster.requested} requested.`,
      detail: {
        answered,
        filled: roster.slots.length,
        requested: roster.requested,
        cancelled,
        skippedForBudget: poolSkippedCount,
        ...(poolHostAbortedCount === 0 ? {} : { hostAborted: poolHostAbortedCount }),
        ...(heldReplacements.length === 0 ? {} : { replacementsHeld: heldReplacements.length }),
      },
    })
  }

  // FR10 / AC1 (story 2.3) — WHAT DISCOVERY BILLED AND COULD NOT COUNT.
  //
  // The ledger's tail, not a count this stage kept: see `unknownBefore` above
  // for why the ledger is the only place a stage reads its own spend from.
  //
  // ONE WARNING FOR THE STAGE, not one per turn. A fan-out whose host stopped
  // reporting usage would otherwise raise a warning per slot per attempt, and a
  // warnings block a reader learns to skip is a degradation report that has
  // stopped working (the accumulation rule `judge.ts` states for `blame`).
  const unquantified = input.ledger.unknownUsage.slice(unknownBefore)
  if (unquantified.length > 0) {
    // The DISTINCT causes, in first-seen order. "cancelled in flight", "timed
    // out" and "the host reported nothing" are three different facts a reader
    // acts on differently, and printing the same one eight times says less than
    // printing each once.
    const why = [...new Set(unquantified.map((entry) => entry.why))]
    warnings.push({
      code: "usage-unquantified",
      stage: "discover",
      // NO MODEL AND NO PROVIDER IS NAMED, and that is not an oversight. A
      // settled turn whose host omitted `tokens` is a working model answering
      // normally; the gap is MAD's own instrumentation, and naming a provider
      // for it is the false degradation report AD-6 exists to prevent. NO
      // NUMBER IS PUT ON THE GAP either (AC1: nothing is estimated or
      // interpolated) — the sentence says what is missing and stops.
      message:
        `USAGE UNQUANTIFIED: ${unquantified.length} discovery turn(s) have usage MAD cannot ` +
        `count (${why.join("; ")}). Those turns may have been billed and cannot be assumed free: ` +
        `the TOKENS total for this run is OBSERVED spend and excludes any usage they were not ` +
        `reported for, and MAD does not fill the gap in.`,
      detail: {
        turns: unquantified.length,
        executions: unquantified.map((entry) => ({
          slot: entry.slot,
          attempt: entry.attempt,
          executionId: entry.executionId,
          why: entry.why,
        })),
      },
    })
  }

  // AC3 (story 2.3) — SESSIONS STILL ON THE HOST. A DISCLOSURE, and it keeps a
  // disclosure's voice: no model is named, no turn is called failed, and the
  // sentence says outright that the review is worth what it was worth. The turn
  // each of these rides on may have succeeded completely, and usually did.
  if (cleanups.length > 0) {
    const why = [...new Set(cleanups.map((cleanup) => cleanup.why))]
    warnings.push({
      code: "session-cleanup-unresolved",
      stage: "discover",
      message:
        `SESSION NOT DELETED: ${cleanups.length} session(s) MAD opened during discovery could ` +
        `not be deleted (${why.join("; ")}). Nothing about the review ` +
        `changed — the same findings were raised by the same models — but those sessions may ` +
        `still be on the host.`,
      detail: {
        sessions: cleanups.length,
        slots: [...new Set(cleanups.map((cleanup) => cleanup.slot))],
        reasons: why,
      },
    })
  }

  return {
    findings,
    answered,
    droppedOut,
    skippedForBudget,
    excludedByRefusal,
    lensInstructions,
    warnings,
    cancelled,
    ...(recovery === undefined ? {} : { recovery }),
  }
}
