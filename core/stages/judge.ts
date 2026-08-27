/**
 * Stage 5 — JUDGE (CAP-5).
 *
 * The stage that DECIDES. Four stages ran before it and none of them wrote a
 * verdict: discovery raised claims, clustering counted who agreed, routing chose
 * who argues, debate produced the argument. This one reads all of that and says
 * whether the defect is real.
 *
 * Writes `evidence`, `factCheck`, `logicEval` and `verdict`, appends its own
 * entries to `history`, and — only when the budget runs out — writes
 * `unresolved`. Nothing else (AD-8). It does not write `severity` (AD-10), does
 * not write `exit` (debate's), does not write `rank` (output's), and NEVER
 * removes a finding: `judge-ruled-invalid` is reported as such, not hidden.
 *
 * ## Decomposition is the point, not decoration
 *
 * `pipeline-stages.md` §5: "A pipeline of narrow specialists, not one
 * authoritative model. Decomposition is what dissolves the expensive-lead-model
 * premise." Each turn is asked one small question, in its own context, under its
 * own narrow instruction. The alternative — one prompt asking a strong model to
 * read everything and rule — is the design this project exists to replace, and it
 * is exactly what a well-meaning simplification here would rebuild.
 *
 * ## Two modes, DERIVED from `route` and stored nowhere
 *
 * - **adjudicate** (`route: "debate"`) — arrived with a transcript. Anonymize,
 *   extract, then fact-check and logic-evaluate in parallel, then aggregate.
 *   Four billed turns.
 * - **verify-independently** (`route: "judge"`) — threshold-skipped or
 *   lens-sourced, never challenged by anything. ONE billed turn: the
 *   Fact-Checker, which is the finding's first and only skeptic and therefore
 *   rules as well as checks. No extractor (there is no transcript to extract
 *   from), no Logic Evaluator (there is no argument to evaluate), and no
 *   aggregator (there is nothing to aggregate — one input is not a panel).
 *
 * A `judgeMode` field would be a second source of truth one rename from
 * disagreeing with `route` (AD-8 gives routing two fields, and the deferred-work
 * ledger records the condition on which to revisit that).
 *
 * ## Three rules that look like details and are not
 *
 * 1. **FACT OUTRANKS LOGIC.** The Logic Evaluator is advisory, it is forbidden
 *    from checking facts, and the aggregator is TOLD which of its inputs came
 *    from the repo. A logic rating that quietly became a second opinion about
 *    the code would be weighed against the real one with nothing to separate them.
 * 2. **A FACT-CHECK THAT USED NO TOOLS IS NOT ONE** (AD-13). Capability is read
 *    per slot from the backend; the checker also reports what it opened. Either
 *    absence marks the check UNVERIFIED, tells the aggregator so in words, and
 *    raises a warning. The run is never refused — that is what AD-13 forbids.
 * 3. **AN AUTHOR'S WITHDRAWAL COSTS NOTHING.** Debate records a withdrawal as the
 *    author's position and exits `converged`; the judge writes
 *    `withdrawn-by-author` and spends no turn. Fact-checking a claim its own
 *    author has dropped buys nothing.
 *
 * ## AD-18 — four more spans, and they are the widest in the pipeline
 *
 * The anonymized transcript, the extracted evidence, the fact-check report and
 * the logic rating are all model-authored prose, and the first two are prose
 * whose only job was to persuade. The extractor is deliberately biased toward
 * keeping too much, so whatever an attacker got into the diff and then into the
 * argument is what it most reliably carries forward. All four are labelled
 * material spans built HERE, in the envelope, never in the instruction text
 * (`core/prompt/material.ts`), and each has a label of its OWN — a report
 * labelled as something it is not would be a lie told on MAD's fence line. The
 * finding's own claim and reasoning reuse span 2 rather than getting a fifth.
 *
 * What is NOT in a span, because MAD computed it: the co-discovery fraction, the
 * severity, which participant raised the finding, and the VERIFIED/UNVERIFIED
 * attestation on the fact-check. Framing MAD's own statements as material would
 * tell the model to disregard the only lines in front of it that are facts about
 * the run rather than claims made inside it.
 *
 * ## Not batched, deliberately
 *
 * `cost-model.md` lists no batching lever for the judge, and lever 1's stated
 * risk — one bad answer corrupting many findings at once — is worse in the stage
 * that writes the verdict than in the one that argues. Four turns per contested
 * finding is the price of the decomposition CAP-5 asks for. Whether a batched
 * judge is affordable is a measurement, and measurement of the budget surface is
 * story 8's; it is filed in `deferred-work.md` rather than guessed at here.
 */

import { z } from "zod"

import { mayISpend, recordTurn, type BudgetLedger } from "../budget/ledger.ts"
import {
  appendEntry,
  effectiveSeverity,
  severityRank,
  type Finding,
  type Verdict,
} from "../domain/finding.ts"
import type { Roster } from "../domain/roster.ts"
import type { JudgeCounts } from "../domain/run-record.ts"
import type { Warning } from "../domain/warning.ts"
import { anonymize, type AnonymizedTranscript } from "../judge/anonymize.ts"
import { assignJudgeSlots, JUDGE_ROLES, type JudgeRole, type JudgeSlots } from "../judge/slots.ts"
import { resolveInstructions } from "../instructions/registry.ts"
import type { InstructionSet } from "../instructions/types.ts"
import type { Clock } from "../ports/clock.ts"
import type { Envelope, ModelBackend } from "../ports/model-backend.ts"
import { material, oneLine } from "../prompt/material.ts"
import { exitReasonOf } from "./debate.ts"

// ---------------------------------------------------------------------------
// Envelopes (AD-12) — each constrains ONLY what MAD computes on
// ---------------------------------------------------------------------------

/**
 * AD-11 — `evidence` is prose and passes through unparsed. `pointers` is a list
 * because MAD renders it as a list and a reader needs the items separable.
 *
 * `.optional()` and NOT `.default([])`, for `debate.ts`'s documented reason:
 * `z.toJSONSchema` puts a defaulted field in the JSON Schema `required` list, so
 * under a provider that enforces structured output strictly a model that pointed
 * at nothing would have its whole turn rejected over a legitimately empty list.
 */
export const evidenceEnvelopeSchema = z.object({
  evidence: z.string(),
  pointers: z.array(z.string()).optional(),
})

/** What the aggregator says actually backed the decision (CAP-6). */
export const EVIDENCE_KINDS = ["line-cite", "trace", "failing-test", "assertion-only"] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

/** The verdicts a MODEL may return. `withdrawn-by-author` is MAD's, never a model's. */
export const RULED_VERDICTS = ["upheld", "judge-ruled-invalid", "not-adjudicated"] as const

/**
 * AD-13 — `checks` is the field MAD computes on: an empty list means the checker
 * opened nothing, which makes the result UNVERIFIED however confident the prose.
 *
 * `verdict` and `evidenceKind` are optional because they belong to ONE of the two
 * modes. In verify-independently mode the Fact-Checker is the finding's only
 * skeptic and rules; in adjudicate mode the aggregator rules and the envelope
 * tells the checker to leave both out. One schema rather than two because the
 * instruction is one, and a second schema would need a second instruction to
 * describe it.
 */
export const factCheckEnvelopeSchema = z.object({
  checks: z.array(z.string()).optional(),
  findings: z.string(),
  unchecked: z.array(z.string()).optional(),
  verdict: z.enum(RULED_VERDICTS).optional(),
  evidenceKind: z.enum(EVIDENCE_KINDS).optional(),
})

/** AD-11 — the rating is prose. MAD computes on none of it; it is advisory. */
export const logicEvalEnvelopeSchema = z.object({
  assessment: z.string(),
})

export const aggregateEnvelopeSchema = z.object({
  verdict: z.enum(RULED_VERDICTS),
  reasoning: z.string(),
  evidenceKind: z.enum(EVIDENCE_KINDS),
})

export type EvidenceEnvelope = z.infer<typeof evidenceEnvelopeSchema>
export type FactCheckEnvelope = z.infer<typeof factCheckEnvelopeSchema>
export type LogicEvalEnvelope = z.infer<typeof logicEvalEnvelopeSchema>
export type AggregateEnvelope = z.infer<typeof aggregateEnvelopeSchema>

// ---------------------------------------------------------------------------
// Stage I/O
// ---------------------------------------------------------------------------

export interface JudgeInput {
  /**
   * The CANONICAL findings, already routed and debated. Mutated in place (AD-7)
   * and returned unfiltered — this stage decides about findings and drops none.
   */
  findings: Finding[]
  roster: Roster
  /**
   * AD-6a/AD-6b — the slots that ANSWERED discovery. A slot that already failed
   * twice judges nothing: a judge turn from a dead model is a warning, not a
   * verdict.
   */
  answeredSlots: readonly string[]
  backend: ModelBackend
  /** The material under review — the same framed change every earlier stage saw. */
  input: string
  clock: Clock
  /** AD-15 — the one accountant. Asked before every turn, never after. */
  ledger: BudgetLedger
  /**
   * Seeds the anonymizer's permutation together with the finding id, so two runs
   * over one input produce one record. Defaulted rather than required because a
   * caller driving one stage in a test has no run id to hand.
   */
  runId?: string
  /**
   * AD-11 — the four role sets, defaulted from the registry and never inlined.
   * Injectable per role so a test can script one without reaching into the
   * registry, exactly as `DebateInput.instructions` is.
   */
  instructions?: Partial<Record<JudgeRole, InstructionSet>>
}

export interface JudgeStageResult extends JudgeCounts {
  /** The same array, judged in place. The judge never filters. */
  findings: Finding[]
  warnings: Warning[]
}

// ---------------------------------------------------------------------------
// One turn, plus its one retry
// ---------------------------------------------------------------------------

interface TurnOutcome<T> {
  envelope: Envelope<T>
  attempts: number
}

/**
 * One turn plus, on failure, exactly one retry (AD-6b, AD-12) — `discover.ts`
 * and `debate.ts` have the same shape, and it is repeated rather than shared
 * because each stage names its own ledger `stage` and each has its own schema.
 */
async function runJudgeTurn<T>(
  input: JudgeInput,
  slot: string,
  instructions: string,
  prompt: string,
  schema: z.ZodType<T>,
): Promise<TurnOutcome<T>> {
  let last: Envelope<T> | undefined
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let envelope: Envelope<T>
    try {
      envelope = await input.backend.runTurn(slot, instructions, prompt, schema)
    } catch (error) {
      // A backend is supposed to return failures, not throw them (spine,
      // Errors). One judge role throwing must not cost the finding its verdict,
      // let alone cost the stage the rest of the findings.
      envelope = {
        ok: false,
        slot,
        failure: "transport-error",
        message: error instanceof Error ? error.message : "backend threw a non-Error value",
      }
    }
    if (envelope.tokens) {
      recordTurn(input.ledger, { slot, stage: "judge", attempt, tokens: envelope.tokens })
    }
    if (envelope.ok) return { envelope, attempts: attempt }
    last = envelope
  }
  return { envelope: last!, attempts: 2 }
}

// ---------------------------------------------------------------------------
// Prompts — where AD-18's two new spans are built
// ---------------------------------------------------------------------------

/**
 * The finding itself, as span 2 — the SAME label `core/stages/debate.ts` uses,
 * reused rather than duplicated so the two cannot drift into two framings of one
 * kind of text.
 *
 * EVERY CELL GOES THROUGH `oneLine`. These lines are MAD's own frame INSIDE the
 * span, so a `claim` carrying a line break plus a plausible `Reasoning: …` forges
 * a MAD-labelled line the fence cannot stop — the forgery impersonates the frame
 * from inside the span rather than escaping it. `locus.file` is a discovery
 * model's free string and is a cell like any other.
 */
function findingSpan(finding: Finding): string {
  const { startLine, endLine } = finding.locus
  const file = oneLine(finding.locus.file)
  const locus =
    startLine === undefined
      ? file
      : endLine === undefined || endLine === startLine
        ? `${file}:${startLine}`
        : `${file}:${startLine}-${endLine}`
  const lines = [`File: ${locus}`, `Claim: ${oneLine(finding.claim)}`]
  if (finding.reasoning.trim().length > 0) {
    lines.push(`Reasoning: ${oneLine(finding.reasoning)}`)
  }
  return material("finding locus, claim and reasoning", lines.join("\n"))
}

/**
 * AD-9 — co-discovery renders as a fraction with its denominator, and a
 * lens-sourced finding renders "not applicable", never `0` and never `1/1`.
 *
 * It is MAD-COMPUTED, so it sits outside every span. `pipeline-stages.md` §5
 * keeps it visible to the judge on purpose: how many models raised something
 * unprompted is evidence about the finding, unlike who they were, which is what
 * the anonymizer removes.
 */
function coDiscoveryLine(finding: Finding): string {
  if (finding.source === "lens") {
    return `Co-discovery: not applicable — this finding was found by a prompted search, so it claims no unprompted agreement.`
  }
  const co = finding.coDiscovery
  if (!co) return `Co-discovery: not recorded.`
  return `Co-discovery: ${co.raised} of ${co.answered} reviewers raised this independently.`
}

/**
 * The header every judge turn shares: what MAD is asking about, and the facts
 * MAD itself computed.
 *
 * Severity is stated and immediately fenced off (AD-10): the judge is told the
 * number so it can weigh how much the answer matters, and told not to revisit it
 * because routing already depended on it and a stage that changed it would change
 * what already happened.
 */
function preamble(finding: Finding, heading: string, mode: string): string[] {
  return [
    heading,
    ``,
    `You are looking at ONE claimed defect. ${mode}`,
    ``,
    coDiscoveryLine(finding),
    `Severity, as recorded by the reviewer who raised it: ${effectiveSeverity(finding)}. It is not yours to change.`,
    ``,
    `# The change under review`,
    ``,
  ]
}

/**
 * Span 4 — the anonymized exchange. `A`/`B`/`C` in a randomized order, with the
 * author's letter named separately because "a finding dies only when its author
 * withdraws" is a rule the judge has to be able to apply.
 */
function transcriptSection(transcript: AnonymizedTranscript): string[] {
  if (transcript.empty) return []
  const who =
    transcript.authorLabel === undefined
      ? `The participant who raised the finding never answered in the exchange.`
      : `Participant ${transcript.authorLabel} is the one who raised the finding.`
  return [
    ``,
    `# The exchange`,
    ``,
    // MAD-authored, so it gets NO span: framing MAD's own sentence as material
    // would tell the model to disregard the one line here that is a fact about
    // the room rather than a claim made inside it.
    who,
    ``,
    material("anonymized debate transcript", transcript.rows.join("\n")),
  ]
}

/** Span 5 — the extractor's own prose, plus the pointers it kept. */
function evidenceSection(evidence: string | undefined): string[] {
  if (evidence === undefined) return []
  return [``, `# Evidence extracted from the exchange`, ``, material("extracted evidence", evidence)]
}

/**
 * `evidence` + `pointers`, as ONE body for span 5.
 *
 * The pointers are a MAD-formatted list inside the span, so each is a cell and is
 * escaped and quoted for the reason the transcript rows are: a pointer carrying a
 * line break would forge a row of MAD's shape inside a correctly labelled block.
 */
function evidenceBody(envelope: EvidenceEnvelope): string {
  // THE PROSE IS NOT CELL-ESCAPED, and that is a decision rather than an
  // omission (code review 2026-08-27). Prose containing its own
  // `Places pointed at:` line would render a second list of MAD's shape inside
  // the span — but both halves have ONE author, the extractor, so nothing is
  // impersonated: a fabricated pointer in the prose is a fabricated pointer the
  // same model could have put in `pointers`. What cell escaping exists to stop is
  // one party forging another's row (a debate turn nobody took) or content
  // falsifying a MAD attestation (a file count that disagrees with the list), and
  // neither is reachable here — MAD attests nothing about these pointers, it
  // relays them. Escaping the prose would collapse its paragraphs and make the
  // one span the aggregator most needs to read unreadable.
  const pointers = envelope.pointers ?? []
  // The PROSE is a block and is not collapsed: it is meant to be read as prose,
  // and collapsing its paragraphs would make it unreadable for the reason
  // collapsing a diff would. Nothing frames it for content to forge. The pointer
  // list below it IS a MAD-owned frame, so its items are escaped one by one.
  if (pointers.length === 0) return envelope.evidence
  return [
    envelope.evidence,
    ``,
    `Places pointed at:`,
    ...pointers.map((pointer) => `- ${oneLine(pointer)}`),
  ].join("\n")
}

function buildExtractPrompt(
  input: JudgeInput,
  finding: Finding,
  transcript: AnonymizedTranscript,
): string {
  return [
    ...preamble(
      finding,
      `# Extract the evidence`,
      `A reviewer raised it and it was argued. Pull the evidence out of that argument.`,
    ),
    input.input,
    ``,
    `# The finding`,
    ``,
    findingSpan(finding),
    ...transcriptSection(transcript),
  ].join("\n")
}

function buildFactCheckPrompt(
  input: JudgeInput,
  finding: Finding,
  transcript: AnonymizedTranscript,
  evidence: string | undefined,
  argued: boolean,
): string {
  return [
    ...preamble(
      finding,
      `# Check it against the code`,
      argued
        ? `It was ARGUED. A later step decides the verdict — do not state one.`
        : `It was NEVER ARGUED. Nobody has challenged it and there is no later step: you are its first and only skeptic, so state a verdict as well.`,
    ),
    input.input,
    ``,
    `# The finding`,
    ``,
    findingSpan(finding),
    ...evidenceSection(evidence),
    // The raw transcript goes to the fact-checker ONLY when there is no extracted
    // evidence to give it instead — the extractor's turn dropped out. Sending
    // both would double the tokens for one argument and give the checker two
    // versions of it to reconcile.
    ...(evidence === undefined ? transcriptSection(transcript) : []),
  ].join("\n")
}

function buildLogicEvalPrompt(
  finding: Finding,
  transcript: AnonymizedTranscript,
  evidence: string | undefined,
): string {
  return [
    ...preamble(
      finding,
      `# Rate the reasoning`,
      `Judge how well each side argued. You cannot open the repository; a separate step has.`,
    ),
    // NO change under review. The Logic Evaluator is forbidden from checking
    // facts, and handing it the diff is an invitation to try — the one input that
    // would let it manufacture the tool-less second opinion the instruction
    // exists to prevent.
    `# The finding`,
    ``,
    findingSpan(finding),
    ...transcriptSection(transcript),
    ...evidenceSection(evidence),
  ].join("\n")
}

/**
 * `factCheck` here is the checker's OWN words and nothing else — MAD's
 * VERIFIED/UNVERIFIED attestation is added below, OUTSIDE the span (AD-18).
 * Passing the prefixed string would put MAD's own sentence inside a block whose
 * notice tells the model to weigh it as somebody's evidence.
 */
function buildAggregatePrompt(
  input: JudgeInput,
  finding: Finding,
  evidence: string | undefined,
  factCheck: string | undefined,
  factVerified: boolean,
  logicEval: string | undefined,
): string {
  const lines = [
    ...preamble(finding, `# Decide it`, `Decide whether the defect is real.`),
    input.input,
    ``,
    `# The finding`,
    ``,
    findingSpan(finding),
    ...evidenceSection(evidence),
  ]

  lines.push(``, `# What the check against the code found`, ``)
  if (factCheck === undefined) {
    // AD-6 — a missing input is stated, never silently treated as an empty one.
    lines.push(`The check did not complete: the model that was asked to run it did not answer.`)
  } else {
    // MAD's OWN attestation, outside the span, because MAD computed it: the slot
    // reported no tool capability, or the checker reported opening nothing.
    lines.push(
      factVerified
        ? `This check was VERIFIED: files were opened or commands were run.`
        : `This check was UNVERIFIED: nothing was opened and nothing was run, so no fact has been established by it.`,
      ``,
      material("code check report", factCheck),
    )
  }

  if (logicEval !== undefined) {
    lines.push(
      ``,
      `# How well each side argued`,
      ``,
      `This is advisory and it loses to the check above wherever the two disagree.`,
      ``,
      material("argument quality rating", logicEval),
    )
  }

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

/** MAD's own words for what a check without tools is worth (AD-13). */
const UNVERIFIED_PREFIX = "UNVERIFIED (no file was opened and no command was run) — "
const VERIFIED_PREFIX = "VERIFIED — "

function instructionFor(input: JudgeInput, role: JudgeRole): InstructionSet {
  return input.instructions?.[role] ?? resolveInstructions({ taskType: "coding", role })
}

/**
 * Descending severity, stable within a band.
 *
 * The array is NEVER reordered — `rank` is output's field and this stage does not
 * touch it. Only the VISIT order changes, and it changes for AD-6d's sake: when
 * the budget runs out mid-stage, the tokens that were left went to the worst
 * findings rather than to whichever happened to be first in the array. It is
 * deterministic, so two runs over one input strand the same set.
 */
function visitOrder(findings: readonly Finding[]): Finding[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort(
      (a, b) =>
        severityRank(effectiveSeverity(b.finding)) - severityRank(effectiveSeverity(a.finding)) ||
        a.index - b.index,
    )
    .map((entry) => entry.finding)
}

/** The author withdrew in debate, so there is nothing left to adjudicate. */
function authorWithdrew(finding: Finding): boolean {
  return finding.exit === "converged" && exitReasonOf(finding) === "withdrawn"
}

export async function judge(input: JudgeInput): Promise<JudgeStageResult> {
  const { findings, clock, ledger } = input
  const runId = input.runId ?? "run"
  const warnings: Warning[] = []

  const counts = {
    judged: 0,
    adjudicated: 0,
    verifiedIndependently: 0,
    withdrawnByAuthor: 0,
    upheld: 0,
    ruledInvalid: 0,
    notAdjudicated: 0,
    unresolved: 0,
    factChecksUnverified: 0,
    turns: 0,
    attempts: 0,
  }

  const droppedOut: string[] = []
  const untooled: string[] = []

  /**
   * Which of the three exhaustion facts applies to this finding.
   *
   * The discriminator is TURNS, not which finding the gate happened to refuse on
   * — and that is the whole subtlety. The gate is checked at the TOP of a
   * finding's work, so the finding it refuses on is usually one that never got a
   * turn; calling that "while it was being judged" would be false of exactly the
   * common case. `turnsBefore` is the count as this finding started, so
   * `counts.turns > turnsBefore` means this finding really did spend something.
   */
  let turnsBefore = 0
  const strandedWhere = (): StrandedWhere => {
    if (counts.turns === 0) {
      return `before judging could start — the budget was already spent by the time judging began`
    }
    return counts.turns > turnsBefore
      ? `while it was being judged`
      : `before it could be judged at all — an earlier finding used the last of the budget`
  }

  /** One place records a verdict, so it cannot be written without its entry. */
  const recordVerdict = (finding: Finding, verdict: Verdict, body: string, actor = "mad"): void => {
    finding.verdict = verdict
    appendEntry(finding, {
      stage: "judge",
      actor,
      at: clock.now(),
      kind: `judge-verdict-${verdict}`,
      body,
    })
    if (verdict === "upheld") counts.upheld += 1
    else if (verdict === "judge-ruled-invalid") counts.ruledInvalid += 1
    else if (verdict === "withdrawn-by-author") counts.withdrawnByAuthor += 1
    else counts.notAdjudicated += 1
  }

  /**
   * AD-6b — a turn that failed twice is reported once per slot, by name, AND THE
   * SLOT IS DROPPED FOR THE REST OF THE STAGE.
   *
   * Warning-only was the shape until code review 2026-08-27, and it repeated
   * exactly the defect story 5's review found in debate: a dead model stayed in
   * the rotation and cost two attempts on every remaining finding, silently,
   * because the duplicate warning was suppressed and nothing else changed. The
   * judge visits every finding, so the waste is per finding rather than per
   * round — twenty findings past a dead slot is forty billed calls to a model
   * the run has already reported as gone.
   *
   * Dropping it is also what makes the warning TRUE: it says the run continued
   * without the slot, and now it does. The trade — a transient failure is not
   * retried on a later finding — is the trade AD-6b already makes inside one
   * turn, applied at the stage's granularity rather than contradicted at it.
   */
  const noteDropOut = (slot: string, role: JudgeRole, message: string): void => {
    if (droppedOut.includes(slot)) return
    droppedOut.push(slot)
    warnings.push({
      code: "model-dropped-out",
      stage: "judge",
      message:
        `JUDGE TURN LOST: the model behind \`${slot}\` failed twice on the ${role} step and the run ` +
        `continued without it. Any finding it was asked about is decided on what the other steps ` +
        `produced, which is less than it should have been. (${message})`,
      detail: { slot, role, message },
    })
  }

  const ordered = visitOrder(findings)
  let exhausted = false
  let unavailable = false

  for (const finding of ordered) {
    // Already dead: the budget ran out in debate. Its `unresolved` belongs to
    // that stage and is not rewritten here, and no turn is spent on it.
    if (finding.unresolved) continue
    // Never routed. `review()` always routes, so this is reachable only from a
    // caller driving the stage directly — and deciding a finding the pipeline
    // never triaged would invent a mode rather than derive one.
    if (finding.route === undefined) continue

    // The FREE verdict comes before the exhaustion check, and the order is the
    // point (code review 2026-08-27). A withdrawn finding costs no turn, so
    // reporting "the budget ran out" for one the run could decide for nothing is
    // false in the flattering direction — it blames the budget for a decision
    // that was never going to need it.
    if (authorWithdrew(finding)) {
      counts.judged += 1
      recordVerdict(
        finding,
        "withdrawn-by-author",
        `The reviewer who raised this withdrew it during the exchange. Recorded, not deleted — a ` +
          `withdrawn finding stays visible so a reader can see it was raised and dropped. No judge ` +
          `turn was spent on it.`,
      )
      continue
    }

    if (exhausted) {
      counts.judged += 1
      // RESET FIRST (code review 2026-08-27). `turnsBefore` is the count as the
      // CURRENT finding started, and this finding starts having spent nothing.
      // Left at the previous finding's value, a finding that never got a turn was
      // told it ran out "while it was being judged" — true of the finding the gate
      // actually stopped on, false of every one after it.
      turnsBefore = counts.turns
      counts.unresolved += 1
      strand(finding, ledger, clock.now(), strandedWhere())
      continue
    }

    counts.judged += 1
    turnsBefore = counts.turns

    const slots = assignJudgeSlots({
      roster: input.roster,
      // The slots that answered discovery MINUS the ones that have since died in
      // this stage. Recomputed per finding rather than once, because the set
      // shrinks as the stage runs.
      answeredSlots: input.answeredSlots.filter((slot) => !droppedOut.includes(slot)),
      hasTools: (slot) => input.backend.capabilities(slot).tools,
      finding,
    })
    if (!slots) {
      // Nothing left that can judge — either no pool slot answered discovery at
      // all, or every one that did has since dropped out of this stage. Stop
      // rather than repeat the same failure per finding, and say so once.
      unavailable = true
      counts.judged -= 1
      break
    }

    const transcript = anonymize(finding, `${runId}:${finding.id}`)
    /**
     * WHETHER THERE IS AN ARGUMENT TO WEIGH — and it is not the same question as
     * which way `route` sent the finding (code review 2026-08-27).
     *
     * `pipeline-stages.md` §5 defines adjudicate as "contested finding, ARRIVES
     * WITH A TRANSCRIPT", and the story's own matrix says the same. A finding
     * routed to debate whose room never produced a position — `exit: "stalled"`
     * with reason `silent`, which `debate.ts` settles before its first round —
     * arrives with no transcript at all. Deriving the mode from `route` alone
     * spent an extractor turn and a logic-evaluator turn on an empty exchange,
     * and told both models "it was argued", which was false.
     *
     * `deferred-work.md` recorded the condition on which to revisit "the mode is
     * derived from `route`": *"if the two ever stop being one-to-one — a third
     * mode, or a debate exit that changes the mode"*. This is that, and the
     * answer is still not a stored `judgeMode` field: it is derived from the
     * record, from two fields instead of one.
     */
    const argued = finding.route === "debate" && !transcript.empty

    let evidence: string | undefined
    let factCheckProse: string | undefined
    /** The checker's OWN words, with no MAD attestation in front of them (AD-18). */
    let factCheckMaterial: string | undefined
    let factVerified = false
    let logicEvalProse: string | undefined

    // ---- adjudicate: the extractor ----
    if (argued) {
      if (!mayISpend(ledger)) {
        exhausted = true
        counts.unresolved += 1
        strand(finding, ledger, clock.now(), strandedWhere())
        continue
      }
      counts.turns += 1
      const slot = slots.byRole["evidence-extract"]
      const outcome = await runJudgeTurn(
        input,
        slot,
        instructionFor(input, "evidence-extract").text,
        buildExtractPrompt(input, finding, transcript),
        evidenceEnvelopeSchema,
      )
      counts.attempts += outcome.attempts
      if (outcome.envelope.ok) {
        evidence = evidenceBody(outcome.envelope.value)
        finding.evidence = evidence
        appendEntry(finding, {
          stage: "judge",
          actor: slot,
          at: clock.now(),
          kind: "judge-evidence",
          body: evidence,
        })
      } else {
        noteDropOut(slot, "evidence-extract", outcome.envelope.message)
      }
    }

    // ---- the fact-check, and in adjudicate mode the logic evaluation beside it ----
    if (!mayISpend(ledger)) {
      exhausted = true
      counts.unresolved += 1
      strand(finding, ledger, clock.now(), strandedWhere())
      continue
    }

    const factSlot = slots.byRole["fact-check"]
    counts.turns += 1
    const factPromise = runJudgeTurn(
      input,
      factSlot,
      instructionFor(input, "fact-check").text,
      buildFactCheckPrompt(input, finding, transcript, evidence, argued),
      factCheckEnvelopeSchema,
    )

    // The two run in PARALLEL — `pipeline-stages.md`'s diagram branches them from
    // the extractor and rejoins at the aggregator, and they share no input the
    // other produces. One barrier, so the pair costs one round of latency.
    const logicSlot = slots.byRole["logic-eval"]
    let logicPromise: Promise<TurnOutcome<LogicEvalEnvelope>> | undefined
    if (argued) {
      counts.turns += 1
      logicPromise = runJudgeTurn(
        input,
        logicSlot,
        instructionFor(input, "logic-eval").text,
        buildLogicEvalPrompt(finding, transcript, evidence),
        logicEvalEnvelopeSchema,
      )
    }

    const [factOutcome, logicOutcome] = await Promise.all([factPromise, logicPromise])
    counts.attempts += factOutcome.attempts + (logicOutcome?.attempts ?? 0)

    if (factOutcome.envelope.ok) {
      const value = factOutcome.envelope.value
      // AD-13, both halves: the SLOT must be able to use tools, and the checker
      // must report having used them. Either absence means no fact was
      // established, however confident the prose reads.
      const usedTools = (value.checks ?? []).length > 0
      factVerified = slots.factCheckTooled && usedTools
      if (!factVerified) {
        counts.factChecksUnverified += 1
        if (!untooled.includes(factSlot)) untooled.push(factSlot)
      }
      const checks = value.checks ?? []
      const unchecked = value.unchecked ?? []
      // TWO STRINGS, and the difference is AD-18 (code review 2026-08-27).
      //
      // The model's own report goes inside the span; MAD's VERIFIED/UNVERIFIED
      // attestation does NOT. This file's own header states the rule — "framing
      // MAD's own statements as material would tell the model to disregard the
      // only lines in front of it that are facts about the run" — and the first
      // draft broke it here, putting MAD's attestation inside a block whose
      // notice sentence tells the reader to weigh the contents as somebody's
      // evidence. The aggregator is told the attestation OUTSIDE the span, where
      // it is MAD speaking (see `buildAggregatePrompt`).
      //
      // `Checks run:` and `Could not check:` stay inside: those are MAD's frame
      // around the MODEL's cells, which is the ordinary case, and each cell is
      // escaped for the reason every other MAD-owned row's cells are.
      const reported = [
        value.findings,
        ...(checks.length > 0 ? [``, `Checks run:`, ...checks.map((c) => `- ${oneLine(c)}`)] : []),
        ...(unchecked.length > 0
          ? [``, `Could not check:`, ...unchecked.map((c) => `- ${oneLine(c)}`)]
          : []),
      ].join("\n")
      factCheckMaterial = reported
      // The FIELD keeps the attestation, because `core/stages/output.ts` renders
      // it to a human who has no other line saying whether anything was opened.
      factCheckProse = `${factVerified ? VERIFIED_PREFIX : UNVERIFIED_PREFIX}${reported}`
      finding.factCheck = factCheckProse
      appendEntry(finding, {
        stage: "judge",
        actor: factSlot,
        at: clock.now(),
        kind: factVerified ? "judge-fact-check-verified" : "judge-fact-check-unverified",
        body: factCheckProse,
      })

      // VERIFY-INDEPENDENTLY ENDS HERE. One turn, and the Fact-Checker is the
      // finding's first and only skeptic, so it rules as well as checks
      // (`pipeline-stages.md` §5). No aggregator: one input is not a panel.
      if (!argued) {
        counts.verifiedIndependently += 1
        recordVerdict(
          finding,
          value.verdict ?? "not-adjudicated",
          value.verdict === undefined
            ? `This finding was never argued, so the check against the code was also its only ` +
                `ruling — and it returned no ruling. Undecided, which is a fact about the review ` +
                `rather than about the finding.`
            : `Decided by the check against the code alone: this finding was never argued, so ` +
                `there was no reasoning to weigh against it. Evidence: ${value.evidenceKind ?? "assertion-only"}.`,
          factSlot,
        )
        continue
      }
    } else {
      noteDropOut(factSlot, "fact-check", factOutcome.envelope.message)
      if (!argued) {
        counts.verifiedIndependently += 1
        recordVerdict(
          finding,
          "not-adjudicated",
          `This finding was never argued, and the one check that would have decided it did not ` +
            `complete. Nothing was established either way.`,
        )
        continue
      }
    }

    if (logicOutcome) {
      if (logicOutcome.envelope.ok) {
        logicEvalProse = logicOutcome.envelope.value.assessment
        finding.logicEval = logicEvalProse
        appendEntry(finding, {
          stage: "judge",
          actor: logicSlot,
          at: clock.now(),
          kind: "judge-logic-eval",
          body: logicEvalProse,
        })
      } else {
        noteDropOut(logicSlot, "logic-eval", logicOutcome.envelope.message)
      }
    }

    // ---- the aggregator ----
    if (!mayISpend(ledger)) {
      exhausted = true
      counts.unresolved += 1
      strand(finding, ledger, clock.now(), strandedWhere())
      continue
    }

    counts.adjudicated += 1
    const aggregateSlot = slots.byRole.aggregate
    counts.turns += 1
    const aggregateOutcome = await runJudgeTurn(
      input,
      aggregateSlot,
      instructionFor(input, "aggregate").text,
      buildAggregatePrompt(
        input,
        finding,
        evidence,
        factCheckMaterial,
        factVerified,
        logicEvalProse,
      ),
      aggregateEnvelopeSchema,
    )
    counts.attempts += aggregateOutcome.attempts

    if (aggregateOutcome.envelope.ok) {
      const value = aggregateOutcome.envelope.value
      recordVerdict(
        finding,
        value.verdict,
        `${value.reasoning}\n\nEvidence: ${value.evidenceKind}.`,
        aggregateSlot,
      )
    } else {
      noteDropOut(aggregateSlot, "aggregate", aggregateOutcome.envelope.message)
      // A missing ruling is not a ruling. `not-adjudicated` is the honest value
      // and the warning above names the model that was supposed to produce one.
      recordVerdict(
        finding,
        "not-adjudicated",
        `The step that decides the verdict did not complete, so this was never decided. What the ` +
          `earlier steps found is recorded above and is all there is.`,
      )
    }
  }

  if (unavailable) {
    warnings.push({
      code: "judge-unavailable",
      stage: "judge",
      // WORDED FOR BOTH WAYS IT IS REACHED (code review 2026-08-27). Dropping a
      // dead slot for the rest of the stage made this reachable PARTWAY through,
      // so "every finding below is unverified" became an overstatement the moment
      // any finding had already been judged. It now says what is true in both
      // cases: whatever was left is undecided by anybody.
      message:
        `JUDGING STOPPED: no reviewer model was left to check, weigh or decide anything — either ` +
        `none from the main pool answered, or every one that did has since failed. Any finding ` +
        `below without a verdict was never examined by anyone, and is reported exactly as it was ` +
        `raised.`,
      detail: {
        answeredSlots: [...input.answeredSlots],
        droppedOutInJudging: [...droppedOut],
        judged: counts.judged,
      },
    })
  }

  if (untooled.length > 0) {
    warnings.push({
      code: "fact-check-untooled",
      stage: "judge",
      message:
        `FACT-CHECKS WERE NOT VERIFIED: ${counts.factChecksUnverified} check(s) ran without opening ` +
        `a file or running a command, so nothing they say is confirmed against the code. Either no ` +
        `model in the roster can use tools, or the one asked did not use them. A check made by ` +
        `reasoning alone reads exactly like one that read the code, which is why this is reported ` +
        `rather than left for you to notice.`,
      detail: { slots: untooled, unverified: counts.factChecksUnverified },
    })
  }

  if (counts.unresolved > 0) {
    warnings.push({
      code: "unresolved-findings",
      stage: "judge",
      message:
        `BUDGET EXHAUSTED IN JUDGING: ${counts.unresolved} finding(s) were still undecided when the ` +
        `token cap of ${ledger.cap} was reached. They are reported in the UNRESOLVED section with ` +
        `the evidence they accumulated — nothing was dropped.`,
      detail: { cap: ledger.cap, unresolved: counts.unresolved },
    })
  }

  return { findings, warnings, ...counts }
}

/**
 * THREE DIFFERENT FACTS, and they must not share a sentence.
 *
 * Debate learned this the same way (`debate.ts`: "after round 0 of 3" is not
 * English and not true). A run that never had the budget to start judging, a
 * finding the gate refused partway through, and a finding that never got its
 * turn because an earlier one used the last of it are three distinct things a
 * reader acts on differently — the first says raise the budget, the last says the
 * budget was nearly enough.
 */
type StrandedWhere =
  | `before judging could start — the budget was already spent by the time judging began`
  | `while it was being judged`
  | `before it could be judged at all — an earlier finding used the last of the budget`

/**
 * AD-6d — mark one finding as undecided because the money ran out.
 *
 * It keeps whatever it accumulated: a finding that got as far as its fact-check
 * shows that fact-check in the unresolved section, which is the difference
 * between "we ran out before looking" and "we looked and ran out before ruling".
 * It gets NO verdict, because none was reached.
 */
function strand(finding: Finding, ledger: BudgetLedger, at: string, where: StrandedWhere): void {
  finding.unresolved = {
    diedAtStage: "judge",
    reason: `the token budget (${ledger.cap}) ran out ${where}`,
  }
  appendEntry(finding, {
    stage: "judge",
    actor: "mad",
    at,
    kind: "judge-budget-exhausted",
    body:
      `Judging stopped ${where}: the token budget ran out. This finding was left undecided rather ` +
      `than dropped, and whatever earlier steps produced for it is recorded above.`,
  })
}

/** Re-exported so a caller can enumerate the roles without importing two modules. */
export { JUDGE_ROLES, type JudgeRole, type JudgeSlots }
