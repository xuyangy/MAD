/**
 * Stage 1 — DISCOVER (CAP-1).
 *
 * Fans out to the roster in parallel; no model sees another's findings. Records
 * which models ANSWERED — that count is the denominator for every co-discovery
 * fraction downstream (AD-6a), never the count requested.
 *
 * A model that errors, times out, or returns an envelope that fails validation
 * gets EXACTLY ONE retry, then the run proceeds with a warning naming it
 * (AD-6b, AD-12), and it is excluded from the denominator.
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
 */

import { z } from "zod"

import {
  appendEntry,
  SEVERITIES,
  type Finding,
  type FindingSource,
  type Locus,
} from "../domain/finding.ts"
import type { RosterSlot, Roster } from "../domain/roster.ts"
import { recordTurn, type LensInstructionRecord, type TokenLedger } from "../domain/run-record.ts"
import type { Warning } from "../domain/warning.ts"
import { resolveInstructions } from "../instructions/registry.ts"
import type { InstructionSet } from "../instructions/types.ts"
import type { Clock } from "../ports/clock.ts"
import type { Envelope, ModelBackend } from "../ports/model-backend.ts"

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
}

export interface DiscoverResult {
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
   * AD-11 amended / AD-17e — one entry per lens slot, in `lensSlots` order,
   * saying whether its instruction was SHIPPED or GENERATED at run time. It
   * survives to output because a generated lens a reader cannot distinguish from
   * a shipped one is the amendment unimplemented.
   */
  lensInstructions: LensInstructionRecord[]
  warnings: Warning[]
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

/** One turn plus, on failure, exactly one retry (AD-6b, AD-12). */
async function runWithOneRetry(
  input: DiscoverInput,
  slot: string,
  instructions: string,
): Promise<{ envelope: Envelope<DiscoveryEnvelope>; attempts: number }> {
  let last: Envelope<DiscoveryEnvelope> | undefined
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let envelope: Envelope<DiscoveryEnvelope>
    try {
      envelope = await input.backend.runTurn(slot, instructions, input.input, discoveryEnvelopeSchema)
    } catch (error) {
      // A backend is supposed to return failures, not throw them (spine,
      // Errors). If one throws anyway, that is still this slot's problem and
      // must not take the rest of the fan-out down with it.
      envelope = {
        ok: false,
        slot,
        failure: "transport-error",
        message: error instanceof Error ? error.message : "backend threw a non-Error value",
      }
    }
    if (envelope.tokens) {
      recordTurn(input.ledger, { slot, stage: "discover", attempt, tokens: envelope.tokens })
    }
    if (envelope.ok) return { envelope, attempts: attempt }
    last = envelope
  }
  return { envelope: last!, attempts: 2 }
}

export async function discover(input: DiscoverInput): Promise<DiscoverResult> {
  const { roster, clock } = input
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
  // turn is started before any is awaited, so peak concurrency equals the slot
  // count rather than the fan-out degenerating into a sequence. Every slot is
  // isolated: `runWithOneRetry` converts a throw into a failure envelope, so one
  // bad backend cannot abort the whole fan-out and cost the run every other
  // model's findings (AD-6b).
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
  const [poolOutcomes, lensOutcomes] = await Promise.all([
    Promise.all(
      roster.slots.map(async (rosterSlot) => ({
        rosterSlot,
        ...(await runWithOneRetry(input, rosterSlot.slot, input.instructions.text)),
      })),
    ),
    Promise.all(
      roster.lensSlots.map(async (lensSlot, index) => ({
        rosterSlot: lensSlot as RosterSlot,
        lens: lensSlot.lens,
        ...(await runWithOneRetry(input, lensSlot.slot, lensSets[index]!.text)),
      })),
    ),
  ])

  const findings: Finding[] = []
  const warnings: Warning[] = []
  const droppedOut: string[] = []
  let answered = 0

  /**
   * One outcome, turned into findings and warnings.
   *
   * Returns whether the slot ANSWERED. Only the pool segment adds that to the
   * denominator (AD-6a) — the caller decides, so the rule lives in one visible
   * place rather than inside a branch on `source`.
   */
  const collect = (
    outcome: {
      rosterSlot: RosterSlot
      envelope: Envelope<DiscoveryEnvelope>
    },
    origin: { source: FindingSource; lens?: string },
  ): boolean => {
    const { rosterSlot, envelope } = outcome
    const modelName = `${rosterSlot.providerId}/${rosterSlot.modelId}`

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
      // AD-6b — retried once already; proceed with a warning naming the model.
      droppedOut.push(rosterSlot.slot)
      warnings.push({
        code: "model-dropped-out",
        stage: "discover",
        // A salvage attempt can leave a technically-ok envelope with nothing
        // usable in it, so the cause is read only from the failure branch.
        message:
          `MODEL DROPPED OUT: \`${modelName}\` (slot ${rosterSlot.slot}) failed twice ` +
          `(${envelope.ok ? "no usable findings" : `${envelope.failure}: ${envelope.message}`}). ` +
          `The run continued without it, and it is excluded from the co-discovery denominator.`,
        detail: {
          slot: rosterSlot.slot,
          model: modelName,
          failure: envelope.ok ? "none" : envelope.failure,
          error: envelope.ok ? "" : envelope.message,
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
  for (const outcome of poolOutcomes) {
    // AD-6a — the denominator, and the ONLY place it moves.
    if (collect(outcome, { source: "pool" })) answered += 1
  }
  for (const outcome of lensOutcomes) {
    // AD-6a / AD-17d — a lens slot answering does NOT move `answered`. Its
    // findings claim no prior, so there is nothing for the denominator to
    // divide, and inflating it would shrink every pool fraction on the page.
    collect(outcome, { source: "lens", lens: outcome.lens })
  }

  // AD-6a — make the shrunken denominator itself visible, not just implied by
  // the fraction. Compared against the POOL only: `roster.slots.length` never
  // includes a lens slot, so a dropped-out lens can never make this fire and a
  // filled lens roster can never make it stop firing.
  if (answered < roster.slots.length) {
    warnings.push({
      code: "denominator-reduced",
      stage: "discover",
      message:
        `Only ${answered} of ${roster.slots.length} roster model(s) answered. Every co-discovery ` +
        `fraction below is over ${answered}, not over ${roster.requested} requested.`,
      detail: { answered, filled: roster.slots.length, requested: roster.requested },
    })
  }

  return { findings, answered, droppedOut, lensInstructions, warnings }
}
