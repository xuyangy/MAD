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
 * severity, author.
 */

import { z } from "zod"

import { appendEntry, SEVERITIES, type Finding, type Locus } from "../domain/finding.ts"
import type { Roster } from "../domain/roster.ts"
import { recordTurn, type TokenLedger } from "../domain/run-record.ts"
import type { Warning } from "../domain/warning.ts"
import type { Clock } from "../ports/clock.ts"
import type { Envelope, ModelBackend } from "../ports/model-backend.ts"
import type { InstructionSet } from "../instructions/discovery.ts"

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
  instructions: InstructionSet
  /** The material under review — the diff, plus whatever framing the caller adds. */
  input: string
  clock: Clock
  ledger: TokenLedger
}

export interface DiscoverResult {
  findings: Finding[]
  /** AD-6a — the denominator: how many models actually answered. */
  answered: number
  /** Slots that dropped out after their one retry. */
  droppedOut: string[]
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
): Promise<{ envelope: Envelope<DiscoveryEnvelope>; attempts: number }> {
  let last: Envelope<DiscoveryEnvelope> | undefined
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let envelope: Envelope<DiscoveryEnvelope>
    try {
      envelope = await input.backend.runTurn(
        slot,
        input.instructions.text,
        input.input,
        discoveryEnvelopeSchema,
      )
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

  // Spine, Concurrency: discovery fans out in parallel across the roster. Every
  // slot is isolated — `runWithOneRetry` converts a throw into a failure
  // envelope, so one bad backend cannot abort the whole fan-out and cost the
  // run every other model's findings.
  const outcomes = await Promise.all(
    roster.slots.map(async (rosterSlot) => ({
      rosterSlot,
      ...(await runWithOneRetry(input, rosterSlot.slot)),
    })),
  )

  const findings: Finding[] = []
  const warnings: Warning[] = []
  const droppedOut: string[] = []
  let answered = 0

  for (const outcome of outcomes) {
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
      continue
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

    answered += 1
    const at = clock.now()
    for (const raw of raised) {
      const finding: Finding = {
        id: clock.id("finding"),
        claim: raw.claim,
        reasoning: raw.reasoning,
        locus: toLocus(raw),
        severity: raw.severity,
        author: rosterSlot.slot,
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
  }

  // AD-6a — make the shrunken denominator itself visible, not just implied by
  // the fraction.
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

  return { findings, answered, droppedOut, warnings }
}
