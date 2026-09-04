/**
 * Stage 4 — DEBATE (CAP-4).
 *
 * The stage that makes a contested finding ARGUED rather than merely counted.
 * Routing (story 4) partitioned the set; everything it marked `route: "debate"`
 * arrives here and leaves with exactly one recorded `exit`.
 *
 * Writes `exit`, appends debate entries to `history`, and — only when the budget
 * runs out — writes `unresolved`. Nothing else (AD-8). It does not write
 * `verdict`, not even when an author withdraws: `withdrawn-by-author` is a
 * `Verdict` value and `verdict` is story 6's field. Debate records the
 * withdrawal as the author's POSITION and exits `converged`; the judge reads the
 * entry.
 *
 * ## The five rules that are the design, not details
 *
 * 1. **Positions are discovered, never assigned.** The stage chooses who is in a
 *    room; it never tells anyone what to think. `SPEC.md` forbids assigning a
 *    position and says nothing about choosing who is asked — so membership is a
 *    deterministic function of the roster and the cluster (see `roomFor`), and
 *    the four positions are a VOCABULARY the model picks from. There is no
 *    devil's-advocate seat and no skeptic role. If everyone in a room agrees in
 *    round 1, that is a converged debate and a cheap one, not a failure.
 *
 * 2. **Batched one turn per model per round** (`cost-model.md` lever 1, AD-15).
 *    A model in three rooms answers all three findings in ONE call, and that call
 *    is ONE allocation — not three. This is the strongest cost lever in the run
 *    and it is also why the instruction tells the model the findings are
 *    independent: the known risk of batching is one bad answer corrupting many
 *    debates at once.
 *
 * 3. **Sparse rooms** (lever 4). Author + the cluster's co-finders + ONE
 *    non-author slot that answered discovery. Full connectivity — every model on
 *    every finding — is exactly the cost this design exists to avoid, and most of
 *    what it buys is models saying "I agree".
 *
 * 4. **`converged` is checked before `stalled`, and both are checked before the
 *    cap.** They are the same observation ("nobody moved") and differ only in
 *    whether the standing positions agree; testing agreement first is what keeps
 *    a settled debate from being reported as a deadlock. `stalled` short-circuits
 *    to the judge instead of burning the remaining rounds — lever 3, and the only
 *    exit that saves tokens by existing.
 *
 * 5. **Silence is abstention.** A slot that drops out neither denies nor
 *    concedes: its absence is never counted as a moved position, never kills a
 *    finding, and never stalls the round. The barrier PROCEEDS — one retry, then
 *    a `model-dropped-out` warning naming the slot, and the round completes with
 *    whoever answered. This is the reference ring's failure
 *    (`reference/multi_agent_debate_ring.py:173-196` blocks until every neighbour
 *    checks in, so one silent solver deadlocks the round) and it is not repeated
 *    here.
 *
 * ## AD-17a, and why participants are anonymous IN THE PROMPT
 *
 * A lens author debates as an AUTHOR, on evidence. Every participant therefore
 * gets the one generalist `debate` instruction and no lens text ever reaches a
 * debate turn. That closes the instruction route — but a lens slot's id is
 * `discovery-lens-security`, and putting slot ids into the transcript would leak
 * the lens back in through the prompt, which is the same leak arriving by a
 * different door (AD-17: "never by parsing `slot`"). So the transcript labels
 * speakers `participant N`, assigned per room in membership order.
 *
 * THIS IS NOT STORY 6'S ANONYMIZER. That one randomizes order and serves AD-17b;
 * this is a stable, unrandomized label whose only job is to keep a lens id out of
 * a debate prompt. `history` records the REAL slot in `actor`, because the record
 * is internal and the judge needs it.
 *
 * ## Nothing is removed, ever
 *
 * No code path here filters `findings`. A denier cannot delete a finding, and
 * neither can an author — a withdrawal is a recorded position with an exit beside
 * it. The stage returns the array it was given.
 */

import { z } from "zod"

import { ceilingClause, ceilingNamed, mayISpend, recordTurn, type BudgetLedger } from "../budget/ledger.ts"
import type { ConcurrencyLimiter } from "../budget/limiter.ts"
import {
  appendEntry,
  effectiveSeverity,
  type Entry,
  type ExitReason,
  type Finding,
} from "../domain/finding.ts"
import { modelNameOf, type Roster } from "../domain/roster.ts"
import type { DebateCounts } from "../domain/run-record.ts"
import type { Warning } from "../domain/warning.ts"
import { resolveInstructions } from "../instructions/registry.ts"
import type { InstructionSet } from "../instructions/types.ts"
import type { Clock } from "../ports/clock.ts"
import { cancelledTurn, type Envelope, type ModelBackend } from "../ports/model-backend.ts"
import { listCell, material, oneLine } from "../prompt/material.ts"

/**
 * `pipeline-stages.md` §4 gives debate a round cap and does not name a number.
 * Three is the smallest cap under which every exit is reachable: round 1 states
 * positions, round 2 is the first round in which anyone can have MOVED (and so
 * the first in which `stalled` is even a meaningful observation), and round 3 is
 * the first that can end in `cap` without having been a stall. Story 8's presets
 * move this one value; they do not reimplement the policy.
 */
export const DEFAULT_MAX_ROUNDS = 3

/**
 * The ceiling on the ceiling. A debate is an exchange, not a conversation: past
 * a handful of rounds the models are restating, which is what `stalled` already
 * catches more cheaply. The bound exists so a caller — or story 8's preset
 * resolution — cannot turn one contested finding into an unbounded spend.
 */
export const MAX_DEBATE_ROUNDS = 6

/**
 * Exported so the bound is TESTED rather than trusted — the pattern
 * `clampThreshold` sets in `route.ts`.
 *
 * Only absent and not-a-number fall back to the default; an out-of-range value
 * is clamped rather than defaulted, because `99` is an explicit request for "as
 * many rounds as you allow" and lands on the ceiling, which is what the caller
 * meant. The `typeof` test rather than `=== undefined` is `clampThreshold`'s
 * reasoning verbatim: `review()` is an exported seam and TypeScript does not
 * police a JavaScript caller, and `Math.max(null, 1)` is `1` — silently turning
 * "I passed nothing meaningful" into the shortest possible debate.
 *
 * Fractional values are floored, not rounded: 2.9 rounds is 2 rounds you can
 * afford, and rounding up spends a round the caller did not ask for.
 *
 * **`0` AND NEGATIVES CLAMP UP TO ONE ROUND, and that is the deliberate mirror
 * image of what `clampTokenCap` does with an explicit `0`** — which it treats as
 * a real ceiling precisely because turning a caller's "none" into "unlimited"
 * would be dishonest. The asymmetry is stated here rather than left for a reader
 * to trip over (code review 2026-08-26). The two are different because the
 * floors mean different things: a zero-token budget is a spend the run can
 * honestly decline, but a zero-ROUND debate would mint the budget-exhaustion
 * shape — `unresolved`, no `exit` — out of a config value, and CAP-4's whole
 * contract is that a contested finding gets argued rather than merely counted.
 * A preset that genuinely means "skip debate, route everything to the judge" is
 * a story 8 decision and needs its own specified path, not this silent
 * reinterpretation. Pinned by `debate.test.ts`'s "out of range is CLAMPED, not
 * defaulted".
 */
export function clampMaxRounds(maxRounds: number | undefined): number {
  if (typeof maxRounds !== "number" || Number.isNaN(maxRounds)) return DEFAULT_MAX_ROUNDS
  return Math.min(Math.max(Math.floor(maxRounds), 1), MAX_DEBATE_ROUNDS)
}

/**
 * AD-12 — the envelope, and it constrains ONLY what MAD computes on.
 *
 * `position` is an enum because the stage compares positions to detect agreement
 * and movement; `argument` and `concession` are model-authored prose and pass
 * through unparsed (AD-11). `withdraws` is meaningful only from the finding's
 * author and is IGNORED from anyone else — a denier withdrawing someone else's
 * finding is the one thing `SPEC.md` says a denier cannot do.
 */
export const DEBATE_POSITIONS = ["upholds", "denies", "withdraws", "unsure"] as const
export type DebatePosition = (typeof DEBATE_POSITIONS)[number]

export const debateTurnSchema = z.object({
  findingId: z.string().min(1),
  position: z.enum(DEBATE_POSITIONS),
  /** Model-authored prose (AD-11) — typed as a string and never inspected. */
  argument: z.string(),
  /** Model-authored prose. Absent when there is nothing to concede. */
  concession: z.string().optional(),
  /**
   * `.optional()` and NOT `.default([])`, and the difference is a production
   * failure rather than a style choice (code review 2026-08-24).
   *
   * `z.toJSONSchema` — which `adapters/opencode/model-backend.ts` calls to build
   * the `json_schema` response format — puts a defaulted field in the JSON
   * Schema `required` list. Under a provider that enforces structured output
   * strictly, a model that cites nothing would therefore have its whole turn
   * REJECTED for omitting a field Zod would have filled in itself: a debate turn
   * lost, an abstention recorded, over a citation list that is legitimately
   * empty. `discovery.ts` uses `.optional()` throughout for the same reason, and
   * the normalization happens AFTER the parse (`citationsOf`) where it cannot
   * reach the wire.
   */
  citations: z.array(z.string()).optional(),
})

export const debateEnvelopeSchema = z.object({
  turns: z.array(debateTurnSchema),
})

export type DebateEnvelope = z.infer<typeof debateEnvelopeSchema>

/**
 * The one place an absent citation list becomes an empty one. Post-parse, so the
 * wire schema can keep `citations` optional (see the field's note) while every
 * reader downstream — the transcript renderer, `Entry.citations`, story 6's
 * Evidence Extractor — sees one shape.
 */
function citationsOf(turn: { citations?: string[] }): string[] {
  return turn.citations ?? []
}

export interface DebateInput {
  /**
   * The CANONICAL findings, already routed. Mutated in place (AD-7) and returned
   * unfiltered — this stage partitions nothing and drops nothing.
   */
  findings: Finding[]
  /**
   * The pre-cluster union, so a cluster's CO-FINDERS can be resolved from
   * `mergedIds`. Optional: without it a room is the author plus the one
   * non-author seat, which is a smaller room and not a wrong one.
   */
  pool?: Finding[]
  roster: Roster
  /**
   * AD-6a/AD-6b — the slots that actually ANSWERED discovery. A slot that
   * dropped out of discovery is not offered the non-author seat: the seat exists
   * to produce a contest, and a model that has already failed twice will not.
   */
  answeredSlots: readonly string[]
  backend: ModelBackend
  /**
   * AD-11 / AD-17a — the ONE generalist debate set every participant gets.
   * Defaulted from the registry, never inlined, and never a lens variant.
   */
  instructions?: InstructionSet
  /** The material under review — the same diff discovery saw. */
  input: string
  clock: Clock
  /** AD-15 — the one accountant. Debate is its only caller in this slice. */
  ledger: BudgetLedger
  /** The round cap. Defaulted and clamped; never read raw. */
  maxRounds?: number
  /**
   * AD-15 amended — the budget's PEAK half, applied per participant per round.
   * Optional for the reason `DiscoverInput.limiter` is optional: a test driving
   * this stage alone need not build one, and `review()` always passes one.
   */
  limiter?: ConcurrencyLimiter
  /** AD-2 amended / AD-6f — the user's stop. */
  signal?: AbortSignal
}

export interface DebateStageResult extends DebateCounts {
  /** The same array, debated in place. Debate never filters. */
  findings: Finding[]
  /** The clamped value this run actually debated under. */
  maxRounds: number
  /**
   * AD-6b — slots that failed both attempts during THIS stage (code review
   * 2026-08-28).
   *
   * Discovery has always returned its own; debate kept the set local, so
   * `review()` derived "who is still alive to be asked" from discovery alone and
   * handed the judge slots that had already died arguing. Exposed for the reason
   * discovery's is: the stage that watched a model fail is the only one that
   * knows.
   */
  droppedOut: string[]
  warnings: Warning[]
  /**
   * AD-6f — whether this stage stopped issuing rounds because the run was
   * cancelled. `review()` raises the one run-level warning; this stage strands
   * its own open rooms, because `unresolved` is a field it owns (AD-8).
   */
  cancelled: boolean
}

/** One finding's room: who is in it, in a stable order, and their labels. */
interface Room {
  finding: Finding
  members: string[]
  /**
   * The members that authored an ABSORBED member of this cluster — the room's
   * co-finders. Kept apart from `members` because a co-finder is not the
   * canonical's author and is not a bystander either, and the difference is
   * exactly what makes a withdrawal message accurate (see `usurped` below).
   */
  coFinders: Set<string>
  /** AD-17a hygiene — `slot -> "participant N"`, stable for this debate. */
  labels: Map<string, string>
}

/**
 * Room membership: author + the cluster's co-finders + ONE non-author slot,
 * every seat filtered through the slots that ANSWERED discovery, in roster
 * order.
 *
 * The last seat is where a contest can come from, and it is exactly NOT a
 * devil's-advocate role — the model is asked for its position on the evidence,
 * never told to hold one. Choosing WHO is asked is not assigning WHAT they
 * answer, and that distinction is the whole reason a sparse room is allowed to
 * exist at all.
 *
 * EVERY seat is filtered, not only the extra one (code review 2026-08-24). The
 * rationale for filtering the extra seat — a model that already failed twice
 * will produce a warning rather than a contest — applies identically to an
 * author and to a co-finder. It is normally a no-op, because a slot that raised
 * a finding answered by definition; it stops being a no-op the moment a caller
 * other than `review()` builds the two arguments, and the whole point of taking
 * `answeredSlots` as a parameter is that such a caller exists (story 9's
 * ablation drives the core directly).
 *
 * `answered` arrives ALREADY IN ROSTER ORDER from the caller below, which is
 * what makes "deterministically in roster order" true of the code rather than
 * true by luck: the previous version read whatever order the array happened to
 * arrive in, and the parameter is a plain `readonly string[]`.
 *
 * Co-finders come from `mergedIds` resolved against the pool, because an
 * absorbed member is the only place a second author's name survives clustering.
 * Lens slots are eligible for the extra seat AFTER pool slots: a lens model is a
 * model, and here it is not wearing its lens (AD-17a).
 */
function roomFor(
  finding: Finding,
  pool: readonly Finding[],
  answeredInRosterOrder: readonly string[],
): { members: string[]; coFinders: Set<string> } {
  const answered = new Set(answeredInRosterOrder)
  const members: string[] = []
  const coFinders = new Set<string>()

  if (answered.has(finding.author)) members.push(finding.author)

  for (const id of finding.mergedIds ?? []) {
    const member = pool.find((candidate) => candidate.id === id)
    if (!member || !answered.has(member.author) || members.includes(member.author)) continue
    members.push(member.author)
    coFinders.add(member.author)
  }

  // Exactly one extra seat, and only if a slot outside the room answered.
  const extra = answeredInRosterOrder.find((slot) => !members.includes(slot))
  if (extra !== undefined) members.push(extra)

  return { members, coFinders }
}

/**
 * One debate turn plus, on failure, exactly one retry (AD-6b, AD-12).
 *
 * Deliberately NOT a shared helper with `discover.ts`'s `runWithOneRetry`: the
 * shape is copied, the code is not. Discovery's version is typed to the
 * discovery envelope and carries discovery's salvage contract; folding the two
 * into one generic would make a change for either stage a change for both, in a
 * retry path where "one retry" is an architectural decision rather than a
 * parameter (AD-6b).
 *
 * The ledger is written on EVERY attempt that reported tokens, exactly as
 * discovery does: a retried turn cost money whether or not it produced anything,
 * and a ledger that only recorded successes would under-report the run.
 */
async function runDebateTurn(
  input: DebateInput,
  slot: string,
  instructions: string,
  prompt: string,
): Promise<{ envelope: Envelope<DebateEnvelope>; attempts: number }> {
  let last: Envelope<DebateEnvelope> | undefined
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // AD-2 amended / AD-6f — never ISSUE a turn the user stopped, and never
    // retry one. `core/stages/discover.ts` carries the full argument; the rule
    // is the same here and the round loop below checks the signal again before
    // it commits a whole round's fan-out.
    if (input.signal?.aborted) {
      // `attempts: 0`, not 1 — see `discover.ts`'s `runWithOneRetry` for the
      // argument and the Spec Change Log for the decision. A turn the core
      // refused to issue was never billed, and `attempts` is the billed count.
      return { envelope: cancelledTurn<DebateEnvelope>(slot), attempts: attempt - 1 }
    }
    let envelope: Envelope<DebateEnvelope>
    try {
      envelope = await input.backend.runTurn(
        slot,
        instructions,
        prompt,
        debateEnvelopeSchema,
        input.signal,
      )
    } catch (error) {
      // A backend is supposed to return failures, not throw them (spine,
      // Errors). If one throws anyway, that is this slot's problem and must not
      // take the rest of the round's fan-out down with it.
      envelope = {
        ok: false,
        slot,
        failure: "transport-error",
        message: error instanceof Error ? error.message : "backend threw a non-Error value",
      }
    }
    if (envelope.tokens) {
      recordTurn(input.ledger, { slot, stage: "debate", attempt, tokens: envelope.tokens })
    }
    if (envelope.ok) return { envelope, attempts: attempt }
    if (envelope.failure === "cancelled") return { envelope, attempts: attempt }
    last = envelope
  }
  return { envelope: last!, attempts: 2 }
}

/**
 * The batched prompt for one participant in one round.
 *
 * The change under review appears ONCE, not once per finding — that is most of
 * what batching buys. Each finding carries its own transcript so far, with every
 * speaker rendered as `participant N` (AD-17a; see the module header).
 *
 * ## AD-18 — two of v1's three material spans are built here (story 5A)
 *
 * `input.input` already arrives wrapped as span 1, the change under review; the
 * two this function owns are model-authored PROSE, which is material for exactly
 * the same reason a diff is:
 *
 * - **Span 2, the finding's `claim` and `reasoning`.** Written by a discovery
 *   model, echoed back into a later turn — nothing MAD wrote.
 * - **Span 3, the exchange so far.** `body`, `position`, `concession` and
 *   `citations` are all model-authored (`core/domain/finding.ts` — `position` is
 *   a free `string`, not an enum), and the debate transcript is the route by
 *   which one debater instructs the next.
 *
 * Inside span 3, one entry stays ONE LINE. The span's fence stops content
 * escaping the block, but the per-entry row is MAD's own frame and a `body`
 * carrying a newline would render a forged sibling entry INSIDE a correctly
 * labelled span — a debate turn nobody took. `oneLine` closes that and nothing
 * else; see its comment on why an encoding here is not the filter AD-18 forbids.
 */
function buildPrompt(
  input: DebateInput,
  slot: string,
  rooms: readonly Room[],
  round: number,
): string {
  const lines: string[] = [
    `# Debate round ${round}`,
    ``,
    `You are one participant. ${rooms.length} finding(s) are put to you this round; answer every one of them, by id.`,
    ``,
    input.input,
    ``,
    `# Findings`,
  ]

  for (const room of rooms) {
    const { finding } = room
    const { startLine, endLine } = finding.locus
    // `file` IS MODEL-AUTHORED and can carry line breaks, so it is a cell like
    // any other (code review 2026-08-27). The line numbers are `number`s and
    // need nothing. The assembled locus goes inside span 2 below.
    const file = oneLine(finding.locus.file)
    const locus =
      startLine === undefined
        ? file
        : endLine === undefined || endLine === startLine
          ? `${file}:${startLine}`
          : `${file}:${startLine}-${endLine}`
    const you = room.labels.get(slot) ?? "an observer"

    // MAD'S OWN HEADER LINE, and everything on it is MAD's: `finding.id` comes
    // from `clock.id("finding")` and `effectiveSeverity` is computed. THE LOCUS
    // IS NOT — see below.
    lines.push(
      ``,
      `## finding \`${finding.id}\` [${effectiveSeverity(finding)}]`,
      // The room is told who RAISED the finding, because "a finding dies only by
      // its author's own withdrawal" is a rule the author has to be able to
      // apply — and a non-author has to know that `withdraws` is not theirs.
      `Raised by: ${room.labels.get(finding.author) ?? "participant ?"}. You are ${you}.`,
      ``,
    )

    // Span 2 (AD-18). `File:`, `Claim:` and `Reasoning:` are MAD's labels, but
    // every value beside them is a discovery model's, so each label goes inside
    // the span with the value it labels rather than the span being split around
    // it. An empty `reasoning` still omits its line entirely, exactly as before.
    //
    // THE LOCUS IS IN HERE, not on the header line above (code review
    // 2026-08-27). `Finding.locus.file` is `z.string().min(1)` in discovery's
    // schema and `toLocus` normalizes backslashes and a leading `./` and nothing
    // else — so the path is model-authored text exactly like the claim is, and on
    // the header it was model text OUTSIDE every span, directly under MAD's own
    // `# Findings` heading. `oneLine` alone would stop it writing extra LINES
    // there and would still leave an injected order sitting in MAD's own voice.
    //
    // EVERY CELL GOES THROUGH `oneLine`, for the reason the exchange rows do:
    // these lines are MAD's frame inside the span, so a `claim` carrying a break
    // plus `Reasoning: …` forges a MAD-labelled line that the fence cannot stop
    // — the forgery impersonates the frame from inside the span rather than
    // escaping it. The two spans are escaped by one rule, not two.
    const claimLines = [`File: ${locus}`, `Claim: ${oneLine(finding.claim)}`]
    if (finding.reasoning.trim().length > 0) {
      claimLines.push(`Reasoning: ${oneLine(finding.reasoning)}`)
    }
    lines.push(material("finding locus, claim and reasoning", claimLines.join("\n")))

    const transcript = finding.history.filter((entry) => entry.stage === "debate" && entry.round !== undefined)
    if (transcript.length === 0) {
      // MAD-authored, so it gets NO span: framing MAD's own sentence as material
      // would tell the model to disregard the one line here that is an
      // instruction about the state of the room.
      lines.push(``, `No positions have been stated yet.`)
    } else {
      // Span 3 (AD-18) — the whole exchange as ONE span, with one entry to one
      // line so a `body` cannot forge a sibling entry.
      const rows: string[] = []
      for (const entry of transcript) {
        const who = room.labels.get(entry.actor) ?? "a participant"
        // QUOTED, not merely escaped: the list joins on `", "` and a citation
        // may contain it, which rendered as several citations and put evidence
        // nobody cited in front of a debater (code review 2026-08-27).
        const citations = entry.citations?.map(listCell) ?? []
        const cited = citations.length > 0 ? ` [cites ${citations.join(", ")}]` : ""
        const conceded = entry.concession ? ` (conceded: ${oneLine(entry.concession)})` : ""
        // `position` is optional on `Entry` and always set on a round entry, so
        // the fallback is unreachable — and printing `undefined` at a debater
        // would be worse than printing nothing.
        const position = oneLine(entry.position ?? "")
        rows.push(
          `- round ${entry.round}, ${who} — ${position}: ${oneLine(entry.body)}${cited}${conceded}`,
        )
      }
      lines.push(``, `Exchange so far:`, material("debate exchange so far", rows.join("\n")))
    }
  }

  return lines.join("\n")
}

/**
 * Is this `Entry.position` one of the four positions this stage states?
 *
 * `Entry.position` is a plain `string?` on the shared append-only record, so
 * nothing in the type system stops a writer — story 6's judge, a v2 memory
 * replay — appending a debate entry with an off-vocabulary value. Every READER
 * therefore validates rather than casting: an unchecked cast lets such a value
 * join the agreement and movement tests here, and reach `core/stages/output.ts`'s
 * rendered round header, with no error anywhere.
 *
 * EXPORTED at story 7 for that second reader (code review 2026-08-30). It was
 * private while this file was the only one that read a position back; the
 * renderer now prints one, and two validators for one vocabulary is how they
 * come to disagree. It is a TYPE PREDICATE, so `output.ts`'s `debateRounds` can
 * filter with it and drop a non-null assertion rather than trading one unchecked
 * read for another.
 *
 * The doc comment that stood here belonged to `standingPositions` below, and is
 * back on it.
 */
export function isDebatePosition(value: string | undefined): value is DebatePosition {
  return value !== undefined && (DEBATE_POSITIONS as readonly string[]).includes(value)
}

/**
 * ONE TEST FOR "THIS ENTRY IS A POSITION SOMEBODY STATED IN A ROUND".
 *
 * THE TWO READERS HAD DIFFERENT PREDICATES (code review 2026-08-30, second pass).
 * `standingPositions` below filtered on `round !== undefined` and never looked at
 * `kind`; `output.ts`'s `debateRounds` filtered on `kind === "debate-round"` and
 * never looked at `round`. They agreed only by accident of the current writer
 * set — this file appends exactly three debate kinds, and neither
 * `budget-exhausted` nor `debate-exit-*` carries a round or a position. A future
 * writer with both under some other kind, or a `debate-round` written without a
 * round, would have made the `unresolved-findings` warning's count disagree with
 * the transcript rendered directly beneath it. That warning's own comment claimed
 * the two "cannot disagree", which is the class of unbacked claim story 7 exists
 * to remove — so the claim is now held by one predicate rather than by the
 * comment.
 *
 * VALIDATED ON READ, not cast (code review 2026-08-24). `Entry.position` is a
 * plain `string?` on the shared append-only record, so nothing in the type system
 * stops a future writer — story 6's judge, a v2 memory replay — appending a
 * debate entry with an off-vocabulary position. An unchecked cast would let that
 * value silently join the agreement and movement tests, corrupting an exit with
 * no error anywhere. A value outside the vocabulary is not a position this stage
 * stated, so it is not a position this stage counts. `round` is required for the
 * same reason from the other side: a round-less entry is not something anybody
 * stated IN a round, and the renderer had no round to print for it.
 */
export function isStatedPosition(
  entry: Entry,
): entry is Entry & { position: DebatePosition; round: number } {
  return (
    entry.stage === "debate" &&
    entry.kind === "debate-round" &&
    entry.round !== undefined &&
    isDebatePosition(entry.position)
  )
}

/**
 * The standing positions in a room — the LATEST position each member has stated,
 * or nothing if they have never spoken.
 *
 * Read from `history` rather than from a parallel map, because `history` is the
 * append-only record AD-7 makes authoritative and story 6's judge reads exactly
 * this. A second copy of the same fact is a second thing that can be wrong.
 */
function standingPositions(finding: Finding): Map<string, DebatePosition> {
  const standing = new Map<string, DebatePosition>()
  for (const entry of finding.history) {
    if (!isStatedPosition(entry)) continue
    standing.set(entry.actor, entry.position)
  }
  return standing
}

/**
 * WHY a debate ended, beside WHAT its exit was.
 *
 * The vocabulary MOVED TO `core/domain/finding.ts` at story 6, with `Entry`,
 * which is where a field's type belongs when the field is on a domain record.
 * Read the reasons there; this stage is still their only writer.
 *
 * The reason is now written to a TYPED `Entry.exitReason` and ALSO encoded in
 * the entry's `kind` (`debate-exit-<exit>-<reason>`). Both, deliberately: the
 * `kind` is what a human reads in a dumped record and what
 * `startsWith("debate-exit-")` finds, and the field is what code branches on.
 * `exitReasonOf` reads the field — story 5's `kind.split("-").at(-1)` is gone,
 * which is the `deferred-work.md` entry about that string protocol, closed.
 */

interface Decision {
  exit: "converged" | "stalled" | "cap"
  reason: ExitReason
}

/**
 * The exit test, run at the END of a round. Order is load-bearing.
 *
 * 1. NOBODY HAS EVER SPOKEN — `stalled` / `silent`. Checked FIRST and from round
 *    1, because a room that has produced no position at all will produce none
 *    from an identical prompt next round, and spending the remaining rounds to
 *    discover that is the exact opposite of lever 3 (code review 2026-08-24).
 * 2. The AUTHOR WITHDREW — `converged` / `withdrawn`. A finding dies only by its
 *    author's own withdrawal, and once it has there is nothing left to argue.
 *    Checked before agreement so a room still disagreeing about a claim its
 *    author has dropped does not read as a deadlock.
 * 3. POSITIONS AGREE — `converged`, with the reason carrying WHICH kind of
 *    agreement: `agreed` when two or more voices hold one definite position,
 *    `uncontested` when only one voice was ever heard, `unsure` when the thing
 *    they agree on is that the evidence does not settle it. Checked before the
 *    stall test, because "nobody moved" describes a settled debate and a
 *    deadlocked one equally well and only agreement separates them.
 *
 *    A ONE-VOICE room does NOT converge in round 1 while a live seat has still
 *    never spoken. A seat silent in round 1 may simply have had nothing to add
 *    yet, and exiting on the author's lone voice would end the debate one round
 *    before the dissent arrives — the same failure as the movement bug below,
 *    reached from the other side. Once a seat has been given a second round, or
 *    has dropped out of the stage entirely, its silence is final and the room is
 *    honestly uncontested.
 * 4. NOBODY MOVED — `stalled`, from round 2 onward, with `restated` when people
 *    spoke and `silent` when they did not. Round 1 cannot stall: every position
 *    in it is new, so "nobody moved" is trivially true and would end every
 *    debate before it started.
 *
 * `moved` is the set of slots that put a NEW position into the room this round —
 * which is not the same as "changed their mind". A slot silent in round 1 that
 * arrives in round 2 with a contradicting position has changed nothing and moved
 * everything, and reading only `positionChanged` reported `stalled` in the exact
 * round fresh dissent arrived (code review 2026-08-24). A slot that was silent
 * is still not in the set: silence is abstention.
 */
function exitFor(
  finding: Finding,
  round: number,
  moved: ReadonlySet<string>,
  spokeThisRound: ReadonlySet<string>,
  /** Room members that have not dropped out of the stage — seats that could still speak. */
  liveSeats: ReadonlySet<string>,
): Decision | undefined {
  const standing = standingPositions(finding)
  const voices = [...standing.keys()]
  const positions = [...standing.values()]
  const stillCouldSpeak = [...liveSeats].some((slot) => !standing.has(slot))

  // 1. Nothing was ever said. No more rounds will change that.
  if (positions.length === 0) return { exit: "stalled", reason: "silent" }

  // 2. The author's own withdrawal.
  if (standing.get(finding.author) === "withdraws") {
    return { exit: "converged", reason: "withdrawn" }
  }

  // 3. Agreement, and WHICH kind of agreement.
  if (positions.every((position) => position === positions[0])) {
    if (voices.length < 2) {
      // Give a silent seat its second round before calling the room settled.
      if (round < 2 && stillCouldSpeak) return undefined
      return { exit: "converged", reason: "uncontested" }
    }
    if (positions[0] === "unsure") return { exit: "converged", reason: "unsure" }
    return { exit: "converged", reason: "agreed" }
  }

  // 4. No progress. `cost-model.md` lever 3 — hand it to the judge rather than
  // buy more of the same.
  if (round >= 2 && moved.size === 0) {
    return { exit: "stalled", reason: spokeThisRound.size > 0 ? "restated" : "silent" }
  }

  return undefined
}

/**
 * AD-6d's sentence about what a stranded finding CARRIES — one of three, chosen
 * by counting rather than assumed.
 *
 * The sentence used to promise "the evidence they accumulated" unconditionally,
 * and the promise is false in a state `core/run/review.ts` documents as
 * reachable: a cap smaller than discovery's own spend leaves nothing for debate,
 * the first gate refuses, and every contested finding is stranded with no round
 * on the record. The warning then sat directly above rows reading `evidence so
 * far: assertion only` — the exact sentence-under-warning pair story 7 exists to
 * kill, produced by story 7's own text (acceptance audit 2026-08-30). AD-6's
 * rule is that a claim is backed by the material it names OR the claim is
 * reworded; this rewords it.
 *
 * ## The middle case is unreachable TODAY, and is written anyway
 *
 * A mixed strand cannot occur through this stage, and the reason is an
 * invariant two functions apart: `mayISpend` is checked ONCE per round before
 * the fan-out, so a round is all-or-nothing, and `exitFor`'s rule 1 exits any
 * room that has produced no position as `stalled`/`silent` at the end of every
 * round that runs. So either the gate refused at round 1 — every stranded room
 * has nothing — or a round completed, and every position-less room already left
 * with an exit. `withPositions` is therefore always `0` or `stranded.length`.
 *
 * It is written and tested regardless, because "some argued and some did not" is
 * a third fact and reporting it as either of the other two is the same AD-6
 * failure this function exists to fix — over-claiming for half of them or
 * under-claiming for the other half. Both invariants above are one edit away
 * from changing (a per-turn gate, or a fourth exit rule), and neither edit would
 * look like it touches this sentence.
 *
 * EXPORTED AND PURE so the three branches are tested directly rather than
 * through a pipeline state two of them can reach and the third cannot.
 */
/**
 * WHY THE RUN STOPPED, as the half-sentence `carriedClause` embeds.
 *
 * Added by the code review of 2026-08-31. `carriedClause` hardcoded "before the
 * budget ran out", and story 7A reused it verbatim for the CANCELLATION warning
 * — so a run the user stopped was told, in the warning whose entire purpose is to
 * say the opposite, that the token budget ran out. It is the same fused sentence
 * AD-6(f) splits everywhere else, surviving in the one function the story's own
 * Code Map told a reader to read first.
 */
export type StrandCause = "budget" | "cancellation"

const CAUSE_CLAUSE: Record<StrandCause, string> = {
  budget: "before the budget ran out",
  cancellation: "before you stopped the run",
}

export function carriedClause(
  stranded: number,
  withPositions: number,
  cause: StrandCause = "budget",
): string {
  // THE ARGUMENTS ARE CHECKED, NOT TRUSTED (code review 2026-08-30, second pass).
  // Two same-typed positional numbers with no guard: swapping them at the call
  // site falls into the `withPositions >= stranded` branch and produces "with the
  // evidence they accumulated" — the exact over-claim this function exists to
  // prevent, delivered by the function meant to prevent it. `stranded === 0` had
  // no defined answer either, and the caller only reaches here inside
  // `stranded.length > 0`. A sentence about a set that cannot exist is a bug in
  // the caller, and this stage's rule is that MAD fails loudly rather than
  // wording something it cannot back.
  if (stranded <= 0 || withPositions < 0 || withPositions > stranded) {
    throw new Error(
      `carriedClause: ${withPositions} of ${stranded} stranded finding(s) is not a countable state`,
    )
  }
  if (withPositions === 0) {
    return (
      `None of them recorded a position ${CAUSE_CLAUSE[cause]}, so there is no accumulated ` +
      `evidence to show: they are reported in the UNRESOLVED section with the stage they died ` +
      `at, and nothing was dropped.`
    )
  }
  if (withPositions >= stranded) {
    return (
      `They are reported in the UNRESOLVED section with the evidence they accumulated — nothing ` +
      `was dropped.`
    )
  }
  return (
    `${withPositions} of them recorded positions ${CAUSE_CLAUSE[cause]} and are reported with ` +
    `them; the other ${stranded - withPositions} recorded none, so there is nothing accumulated ` +
    `to show for those. All are in the UNRESOLVED section with the stage they died at — nothing ` +
    `was dropped.`
  )
}

/**
 * Stage 4. Async, because unlike routing it spends turns.
 *
 * RUNS ONCE PER RUN, for `route()`'s reason: it appends history unconditionally
 * and writes `exit` once. `review()` calls it exactly once.
 */
export async function debate(input: DebateInput): Promise<DebateStageResult> {
  const { findings, clock, ledger } = input
  const maxRounds = clampMaxRounds(input.maxRounds)
  const pool = input.pool ?? findings
  const instructions =
    input.instructions ?? resolveInstructions({ taskType: "coding", role: "debate" })
  const warnings: Warning[] = []

  // AD-17a — the lens NEVER reaches a debate turn. The registry is asked for the
  // UNLENSED generalist, by name, and one text is handed to every seat: there is
  // no per-participant instruction and no branch on `finding.lens` anywhere in
  // this file. (The registry would return a GENERATED lens set for
  // `{role: "debate", lens: "x"}`, which is why nothing here ever asks it for
  // one — see `registry.ts`'s note on why `LENS_SETS` is keyed by role.)
  const debateInstructionText = instructions.text

  // Turn order is ROSTER order, so two runs over one change spend their turns in
  // the same sequence and a diff between two run records is readable. Lens slots
  // follow pool slots, as they do in discovery.
  const slotOrder = [...input.roster.slots.map((s) => s.slot), ...input.roster.lensSlots.map((s) => s.slot)]

  // AD-6b — the MODEL behind a slot id, so a drop-out report names the model and
  // not only MAD's own role vocabulary. `core/domain/roster.ts` owns the one
  // helper; the judge calls the same one (story 7, code review 2026-08-30).
  const modelOf = (slot: string): string => modelNameOf(input.roster, slot)

  const orderOf = (slot: string): number => {
    const index = slotOrder.indexOf(slot)
    return index === -1 ? slotOrder.length : index
  }

  // Sorted HERE, once, so `roomFor`'s "deterministically in roster order" is a
  // property of this code rather than of the order the caller happened to build
  // its array in (code review 2026-08-24). `orderOf` is the same comparator the
  // turn order below uses, so the extra seat and the turn sequence cannot
  // disagree about what roster order means.
  const answeredInRosterOrder = [...input.answeredSlots].sort((a, b) => orderOf(a) - orderOf(b))

  const contested = findings.filter((finding) => finding.route === "debate")
  const rooms: Room[] = contested.map((finding) => {
    const { members, coFinders } = roomFor(finding, pool, answeredInRosterOrder)
    const labels = new Map(members.map((slot, index) => [slot, `participant ${index + 1}`]))
    return { finding, members, coFinders, labels }
  })

  /**
   * Slots that failed twice in a round. They are DROPPED FOR THE REST OF THE
   * STAGE, not merely warned about once (code review 2026-08-24).
   *
   * The previous shape suppressed the duplicate warning and left the slot in
   * every subsequent round's fan-out, so a dead model silently cost two attempts
   * per remaining round — up to ten wasted billed calls at the round ceiling,
   * from a slot the run had already reported as gone. Dropping it is also what
   * makes the warning true: it says the run continued without the slot, and now
   * it did.
   *
   * The trade is that a TRANSIENT failure is not retried in a later round. That
   * is the same trade AD-6b already makes inside one turn — exactly one retry,
   * then proceed — applied at the stage's granularity rather than contradicted
   * at it.
   */
  // A room with NO SEATS cannot ever produce a position — every candidate was
  // filtered out by `answeredSlots`. Settled before the loop rather than left to
  // fall through to `cap` at the end, which would claim a round cap was reached
  // by a debate that never had a participant to spend a round on.
  {
    const at = clock.now()
    for (const room of rooms) {
      if (room.members.length === 0) {
        recordExit(room.finding, { exit: "stalled", reason: "silent" }, 0, at)
      }
    }
  }

  const droppedOutThisStage = new Set<string>()
  let rounds = 0
  let turns = 0
  let attempts = 0
  let exhausted = false
  // AD-6f — a SECOND, separate reason to stop. See the gate in the round loop
  // for why it is not folded into `exhausted`.
  let cancelled = false

  const { signal } = input
  const withSlot = <T>(turn: () => Promise<T>): Promise<T> =>
    input.limiter ? input.limiter.run(turn) : turn()

  for (let round = 1; round <= maxRounds && !exhausted && !cancelled; round += 1) {
    const open = rooms.filter((room) => room.finding.exit === undefined && !room.finding.unresolved)
    if (open.length === 0) break

    // Batching (lever 1, AD-15): one turn per MODEL, covering every open finding
    // that model is in a room for — never one turn per finding. A slot that
    // already dropped out of this stage is not asked again.
    const bySlot = new Map<string, Room[]>()
    for (const room of open) {
      for (const member of room.members) {
        if (droppedOutThisStage.has(member)) continue
        const list = bySlot.get(member)
        if (list) list.push(room)
        else bySlot.set(member, [room])
      }
    }
    const permitted = [...bySlot.keys()].sort((a, b) => orderOf(a) - orderOf(b))
    if (permitted.length === 0) break

    // AD-15 — ASK BEFORE SPENDING. ONE gate check per ROUND, and the round is
    // the honest granularity even though the turn is the unit of allocation:
    // the ledger is only written after the barrier, so every check inside one
    // round would return the same answer, and a loop that pretended otherwise
    // implied a half-spent round that cannot occur (code review 2026-08-24).
    // Half a round of positions is a round nobody can read a movement out of
    // anyway.
    if (!mayISpend(ledger, "debate")) {
      exhausted = true
      break
    }

    // AD-6f — THE SECOND REASON NOT TO ISSUE A ROUND, and it gets its OWN FLAG.
    //
    // Reusing `exhausted` would have been one line shorter and would have made
    // every cancelled run report "the token budget ran out" — a sentence naming
    // a cause that did not happen, printed over findings the user themselves
    // stopped. AD-6(f)'s whole content is that the two must be tellable apart,
    // so they are two flags, two `unresolved` reasons, and two warnings.
    //
    // Checked HERE as well as inside `runDebateTurn` because the round is the
    // unit a reader can interpret: a round issued and then abandoned mid-fan-out
    // leaves half a round of positions on the record, which is a round nobody
    // can read a movement out of, and the ledger would carry the spend anyway.
    if (signal?.aborted) {
      cancelled = true
      break
    }

    rounds += 1

    // The FAN-OUT and then the BARRIER — every turn is started before any is
    // awaited (`discover.ts`'s shape), so the round costs one round of latency
    // rather than one per participant. `runDebateTurn` converts a throw into a
    // failure envelope, so no slot can abort the round, and `Promise.all`
    // resolves POSITIONALLY, so the record is in participant order however the
    // network behaved.
    const outcomes: {
      slot: string
      rooms: Room[]
      envelope: Envelope<DebateEnvelope>
      attempts: number
    }[] = await Promise.all(
      permitted.map(async (slot) => ({
        slot,
        rooms: bySlot.get(slot)!,
        // AD-15 amended — through the budget's peak half, per participant. The
        // fan-out shape and its positional resolution are unchanged; only the
        // number in flight is bounded (`core/budget/limiter.ts`).
        ...(await withSlot(() =>
          runDebateTurn(input, slot, debateInstructionText, buildPrompt(input, slot, bySlot.get(slot)!, round)),
        )),
      })),
    )

    // AD-15 — `turns` counts ALLOCATIONS requested, `attempts` counts turns
    // actually billed. A turn that failed once and succeeded on its retry is one
    // allocation and two billed calls, so the two numbers legitimately differ
    // and the renderer prints both rather than one captioned as the other (code
    // review 2026-08-24).
    //
    // COUNTED AFTER THE FAN-OUT, AND CANCELLED SEATS ARE NOT COUNTED (code
    // review 2026-08-31). `turns += permitted.length` used to run before the
    // round was issued, so a stop landing mid-round counted every permitted
    // seat — including the ones that came back `cancelled` without a backend
    // ever being called. Nothing surfaced it, because `output.ts` prints the
    // allocation-versus-billing comparison only when `attempts > turns`; but the
    // record is what story 7A's own artifact dump serializes for a human to
    // read, and `discover.ts` has always been scrupulous about exactly this.
    for (const outcome of outcomes) {
      attempts += outcome.attempts
      if (outcome.envelope.ok || outcome.envelope.failure !== "cancelled") turns += 1
    }

    const at = clock.now()
    const movedPerFinding = new Map<string, Set<string>>()
    const spokePerFinding = new Map<string, Set<string>>()
    for (const room of open) {
      movedPerFinding.set(room.finding.id, new Set())
      spokePerFinding.set(room.finding.id, new Set())
    }

    for (const outcome of outcomes) {
      if (!outcome.envelope.ok) {
        // AD-2 amended / AD-6f — A CANCELLED TURN IS NOT A DROP-OUT. The model
        // did not fail twice in this round; the user stopped the run mid-round,
        // and a slot added to `droppedOutThisStage` here would be excluded from
        // every later round AND handed to the judge as dead, on the strength of
        // a failure that never happened. `core/stages/discover.ts` carries the
        // full argument. The round's flag is set below and the strand block
        // reports it once, under AD-6(f).
        if (outcome.envelope.failure === "cancelled") {
          cancelled = true
          continue
        }

        // AD-6b / AD-12 — retried once already. The round PROCEEDS without this
        // slot and the run says so, naming it. Silence is abstention: nothing
        // below records a position for it, so its absence cannot move, stall or
        // kill any finding in its rooms.
        //
        // A bad envelope is treated exactly as a drop-out for this slot this
        // round; the raw payload rides along in `detail` so nothing is lost. It
        // is NOT salvaged item-by-item the way discovery salvages findings —
        // discovery salvages to protect the AD-6a denominator, and there is no
        // equivalent here: a half-parsed position is a position nobody stated.
        if (!droppedOutThisStage.has(outcome.slot)) {
          droppedOutThisStage.add(outcome.slot)
          warnings.push({
            code: "model-dropped-out",
            stage: "debate",
            message:
              `MODEL DROPPED OUT OF DEBATE: \`${modelOf(outcome.slot)}\` (slot ${outcome.slot}) failed ` +
              `twice in round ${round} ` +
              `(${outcome.envelope.failure}: ${outcome.envelope.message}). The round completed without ` +
              `it, and it is NOT asked again in any later round of this debate. Its silence is an ` +
              `abstention: it neither denied nor conceded any finding, and no debate waited on it.`,
            detail: {
              slot: outcome.slot,
              model: modelOf(outcome.slot),
              round,
              failure: outcome.envelope.failure,
              error: outcome.envelope.message,
              findings: outcome.rooms.map((room) => room.finding.id),
              raw: outcome.envelope.raw,
            },
          })
        }
        continue
      }

      const roomById = new Map(outcome.rooms.map((room) => [room.finding.id, room]))
      const answered = new Set<string>()
      for (const turn of outcome.envelope.value.turns) {
        const room = roomById.get(turn.findingId)
        // A turn about a finding this slot was not asked about is discarded
        // rather than applied. Batching makes it cheap for a model to answer
        // about a neighbouring finding it saw in someone else's transcript;
        // applying that would put a position in a room the stage never seated it
        // in. Answering twice about one finding is the same problem, so only the
        // first answer counts.
        if (!room || answered.has(turn.findingId)) continue
        answered.add(turn.findingId)

        const standing = standingPositions(room.finding)
        const previous = standing.get(outcome.slot)

        // A finding dies only by its AUTHOR's own withdrawal (`SPEC.md`), so a
        // withdrawal from any other seat is recorded as `denies` — which is what
        // "I do not stand behind this claim" means from someone who did not make
        // it. The rewrite is said out loud in the body rather than applied
        // silently, and the body distinguishes the two ways a slot can not be
        // the author, because they are different situations and one message was
        // inaccurate for the second (code review 2026-08-24):
        //
        // - a CO-FINDER authored a member that clustering absorbed into this
        //   canonical. It really is withdrawing something it raised — its own
        //   copy — and telling it that "only a finding's author can withdraw it"
        //   is simply false about that slot. What it cannot do is withdraw the
        //   CANONICAL, which is still standing on its own author's claim.
        // - anyone else is a seat that never raised anything here.
        const isAuthor = outcome.slot === room.finding.author
        const usurped = turn.position === "withdraws" && !isAuthor
        const position: DebatePosition = usurped ? "denies" : turn.position
        const rewrite = room.coFinders.has(outcome.slot)
          ? `[recorded as \`denies\`: this slot co-found the cluster, so withdrawing removes its own ` +
            `support — the canonical finding stands on its author's claim and only its author can ` +
            `withdraw it]`
          : `[recorded as \`denies\`: only a finding's author can withdraw it]`

        // COMPUTED, never claimed. Asking the model whether it changed its mind
        // makes the stall test a thing the model can be wrong or flattering
        // about; comparing the two recorded positions cannot be.
        const positionChanged = previous !== undefined && previous !== position

        // MOVEMENT IS NOT THE SAME AS CHANGE (code review 2026-08-24). A slot
        // that was silent in round 1 and arrives in round 2 with a contradicting
        // position has changed nothing — there is no previous position to differ
        // from — and has put brand-new dissent into the room. Counting only
        // `positionChanged` returned `stalled` in the exact round fresh dissent
        // arrived. `positionChanged` stays the honest flag ON THE RECORD, and
        // the stall test reads the wider question the round actually asks.
        const isFirstPosition = previous === undefined
        if (positionChanged || (isFirstPosition && round >= 2)) {
          movedPerFinding.get(room.finding.id)?.add(outcome.slot)
        }
        spokePerFinding.get(room.finding.id)?.add(outcome.slot)

        // AD-7 — append-only, and this is the entry story 6's judge reads.
        appendEntry(room.finding, {
          stage: "debate",
          actor: outcome.slot,
          at,
          kind: "debate-round",
          body: usurped ? `${turn.argument}\n\n${rewrite}` : turn.argument,
          round,
          position,
          positionChanged,
          ...(turn.concession === undefined ? {} : { concession: turn.concession }),
          citations: citationsOf(turn),
        })
      }
    }

    // The exit test runs after every position in the round is recorded, so it
    // reads one complete round rather than a partial one.
    //
    // NOT OVER A ROUND THE STOP CUT IN HALF (AD-6f, story 7A). If the signal
    // fired mid-fan-out, some seats returned a cancelled envelope and stated no
    // position — and `exitFor` reads silence as abstention, so a two-seat room
    // whose second seat was cancelled would exit `stalled` with reason `silent`.
    // That is a CONCLUSION drawn from the user's stop: a finding the run never
    // finished arguing, rendered as one that was argued and went nowhere. The
    // positions that were stated stay on the record; the room stays open and is
    // stranded, with the cancellation named as the cause.
    if (cancelled) break
    for (const room of open) {
      const decided = exitFor(
        room.finding,
        round,
        movedPerFinding.get(room.finding.id) ?? new Set(),
        spokePerFinding.get(room.finding.id) ?? new Set(),
        new Set(room.members.filter((member) => !droppedOutThisStage.has(member))),
      )
      if (decided) recordExit(room.finding, decided, round, at)
    }
  }

  // The cap. Anything still open after the last round exits `cap` — a real exit
  // with a transcript behind it, not a failure. It reaches the judge like the
  // other two.
  //
  // NOT AFTER A CANCELLATION EITHER (AD-6f, story 7A). `cap` is a real exit with
  // a transcript behind it and it means "we argued this to the round ceiling";
  // over a room the user stopped, that is a claim about an argument that never
  // finished, printed under a finding nobody spent the rounds on. A cancelled
  // room is stranded below, exactly as a budget-stranded one is.
  if (!exhausted && !cancelled) {
    const at = clock.now()
    for (const room of rooms) {
      if (room.finding.exit === undefined && !room.finding.unresolved) {
        recordExit(room.finding, { exit: "cap", reason: "capped" }, maxRounds, at)
      }
    }
  }

  // AD-6f — THE USER STOPPED IT, and that is a different fact from the budget
  // running out. Same shape as the exhaustion block below, same section in the
  // report (AD-6d), a distinct cause in every sentence: no `exit` is written,
  // because no exit happened, and no round cap is mentioned, because the cap is
  // not why this stopped.
  if (cancelled) {
    const at = clock.now()
    const stranded = rooms.filter(
      (room) => room.finding.exit === undefined && !room.finding.unresolved,
    )
    // The same three-way distinction the budget path had to learn (`where`
    // below): "after round 0" is not English and not true, and a run stopped
    // before debate could start is a different thing to tell a reader than one
    // stopped part-way through arguing.
    const where =
      rounds === 0
        ? `before its first round could run`
        : `after round ${rounds} of ${maxRounds}`
    for (const room of stranded) {
      room.finding.unresolved = {
        diedAtStage: "debate",
        reason: `the run was cancelled ${where}`,
      }
      appendEntry(room.finding, {
        stage: "debate",
        actor: "mad",
        at,
        kind: "run-cancelled",
        body:
          `Debate stopped ${where}: the run was cancelled. This finding was left undecided ` +
          `rather than dropped, and no model was asked again.`,
      })
    }
    if (stranded.length > 0) {
      // COUNTED, NOT ASSUMED — `carriedClause` and `standingPositions`, the same
      // two the budget warning below goes through, for the same reason: this
      // sentence sits directly above rows reading `evidence so far: …` and must
      // not promise material the run does not hold (AD-6). A cancelled run makes
      // the empty case COMMON rather than a corner: a user who stops during
      // discovery strands every contested finding with no round on the record.
      const withPositions = stranded.filter(
        (room) => standingPositions(room.finding).size > 0,
      ).length
      warnings.push({
        code: "unresolved-findings",
        stage: "debate",
        message:
          `RUN CANCELLED DURING DEBATE: ${stranded.length} contested finding(s) were still ` +
          `undecided when you stopped the run, ${where}. ` +
          `${carriedClause(stranded.length, withPositions, "cancellation")}`,
        detail: {
          cause: "cancelled",
          roundsRun: rounds,
          maxRounds,
          findings: stranded.map((room) => room.finding.id),
          withPositions,
        },
      })
    }
  }

  // AD-6d — budget exhaustion is NOT an error. Undecided findings are marked
  // with the stage they died at and surfaced; none is dropped, and none is given
  // an `exit`, because no exit happened.
  if (exhausted) {
    const at = clock.now()
    const stranded = rooms.filter((room) => room.finding.exit === undefined)
    // "after round 0 of 3" is not English and not true — no round happened, so
    // nothing came "after" one. The two cases are genuinely different facts and
    // read differently: one debate ran out of money partway, the other never
    // started because earlier stages had already spent the budget (code review
    // 2026-08-24).
    const where =
      rounds === 0
        ? `before its first round could run — the budget was already spent by the time debate started`
        : `after round ${rounds} of ${maxRounds}`
    for (const room of stranded) {
      room.finding.unresolved = {
        diedAtStage: "debate",
        // AD-15 (story 8) — THE CEILING NAMED IS THE ONE DEBATE WAS HELD TO.
        // This used to interpolate `ledger.cap`, which with a share in force is
        // false: debate refuses at 65% of the cap, so it named 400000 over a run
        // that had spent 260000 — a sentence the reader can check against the
        // TOKENS line and find wrong. `ceilingClause` owns the phrasing for both
        // stranding stages, so the two cannot drift, and returns today's wording
        // character-for-character whenever the ceiling IS the cap.
        reason: `${ceilingClause(ledger, "debate")} ${where}`,
      }
      appendEntry(room.finding, {
        stage: "debate",
        actor: "mad",
        at,
        kind: "budget-exhausted",
        body:
          `Debate stopped ${where}: the token budget ran out. This finding was left undecided ` +
          `rather than dropped.`,
      })
    }
    if (stranded.length > 0) {
      // AD-6 — THE CLAIM IS BACKED BY THE MATERIAL, OR THE CLAIM IS REWORDED
      // (acceptance audit 2026-08-30). This sentence promised "the evidence they
      // accumulated" UNCONDITIONALLY, and the promise is false in a state
      // `core/run/review.ts` documents as reachable: a cap smaller than
      // discovery's own spend leaves nothing for debate, the first gate refuses,
      // and every contested finding is stranded with no round on the record. The
      // warning then sat directly above rows reading `evidence so far: assertion
      // only` — which is exactly the sentence-under-warning pair story 7 exists
      // to kill, produced by story 7's own text.
      //
      // COUNTED, NOT ASSUMED, and counted through `standingPositions` — this
      // file's own accessor, which validates the vocabulary on read — so the
      // number cannot disagree with what `core/stages/output.ts` renders under
      // each finding from the same entries.
      const withPositions = stranded.filter(
        (room) => standingPositions(room.finding).size > 0,
      ).length
      const carried = carriedClause(stranded.length, withPositions)

      warnings.push({
        code: "unresolved-findings",
        stage: "debate",
        message:
          `BUDGET EXHAUSTED IN DEBATE: ${stranded.length} contested finding(s) were still undecided ` +
          `when ${ceilingNamed(ledger, "debate")} was reached, ${where}. ${carried}`,
        detail: {
          cap: ledger.cap,
          roundsRun: rounds,
          maxRounds,
          findings: stranded.map((room) => room.finding.id),
          // The number the sentence above is built from, so a reader can check
          // the prose against a count rather than against the prose.
          withPositions,
        },
      })
    }
  }

  let converged = 0
  let convergedUncontested = 0
  let convergedUnsure = 0
  let stalled = 0
  let cap = 0
  let unresolved = 0
  for (const room of rooms) {
    // EXHAUSTIVE ON PURPOSE (code review 2026-08-24). The old `else unresolved`
    // fallthrough would silently absorb any future `exit` value into the AD-6d
    // bucket — reporting a finding as "the budget ran out" when it had in fact
    // exited some way this code does not know about. `unresolved` is now the
    // absence of an exit and nothing else, which is what the field means.
    switch (room.finding.exit) {
      case "converged":
        converged += 1
        // Two SUBSETS of `converged`, not extra buckets: the identity
        // `debated === converged + stalled + cap + unresolved` still holds, and
        // is asserted in `debate.test.ts`. They exist because `converged` alone
        // cannot tell the judge whether a room agreed, went uncontested, or was
        // unanimously unsure.
        if (exitReasonOf(room.finding) === "uncontested") convergedUncontested += 1
        else if (exitReasonOf(room.finding) === "unsure") convergedUnsure += 1
        break
      case "stalled":
        stalled += 1
        break
      case "cap":
        cap += 1
        break
      case undefined:
        unresolved += 1
        break
    }
  }

  return {
    findings,
    maxRounds,
    warnings,
    debated: rooms.length,
    droppedOut: [...droppedOutThisStage],
    converged,
    convergedUncontested,
    convergedUnsure,
    stalled,
    cap,
    unresolved,
    rounds,
    turns,
    attempts,
    cancelled,
  }
}

/**
 * The reason a finding exited, read back off the append-only record — the same
 * place the judge reads it, so the counts and the judge cannot disagree.
 *
 * EXPORTED at story 6, because the judge is the second reader. It reads the
 * TYPED `Entry.exitReason` rather than splitting the entry's `kind` on `-`,
 * which is the `deferred-work.md` entry about that string protocol, closed: a
 * hyphenated reason used to decode to its last word with no type error anywhere.
 * The entry is still LOCATED by its `kind` prefix, which is a MAD-authored
 * constant and not a value any model supplies.
 */
export function exitReasonOf(finding: Finding): ExitReason | undefined {
  for (let i = finding.history.length - 1; i >= 0; i -= 1) {
    const entry = finding.history[i]!
    if (!entry.kind.startsWith("debate-exit-")) continue
    return entry.exitReason
  }
  return undefined
}

/**
 * The ONE place `exit` is written, so it cannot be written twice or written
 * without the entry that explains it. The entry's actor is `mad` because the
 * exit is the orchestrator's observation about the round, not any model's claim.
 *
 * The `kind` carries the REASON as well as the exit
 * (`debate-exit-converged-uncontested`), because `Finding.exit` is three values
 * and three values cannot separate "the room agreed" from "nobody else answered"
 * — see `ExitReason`. `startsWith("debate-exit-")` still finds every exit entry.
 */
function recordExit(finding: Finding, decision: Decision, round: number, at: string): void {
  finding.exit = decision.exit
  appendEntry(finding, {
    stage: "debate",
    actor: "mad",
    at,
    kind: `debate-exit-${decision.exit}-${decision.reason}`,
    // TYPED, beside the `kind` rather than instead of it (story 6). The `kind`
    // is what a human reads and what `startsWith("debate-exit-")` locates; this
    // is what the judge and the counts branch on.
    exitReason: decision.reason,
    body: exitBody(decision, round),
  })
}

/** One sentence per reason, saying what actually happened rather than what the exit is called. */
function exitBody(decision: Decision, round: number): string {
  switch (decision.reason) {
    case "withdrawn":
      return (
        `Converged in round ${round}: the AUTHOR withdrew the finding. It is recorded, not deleted, ` +
        `and the verdict is the judge's to write.`
      )
    case "agreed":
      return `Converged in round ${round}: two or more participants hold the same position.`
    case "uncontested":
      // AD-6 — the degraded case must not read like the good one. This is the
      // sentence that stops "only the author ever spoke" from being reported as
      // agreement, and the judge reads the `-uncontested` kind for the same fact.
      return (
        `Converged in round ${round}: UNCONTESTED — only one participant ever stated a position, so ` +
        `nothing here is agreement. Nobody disagreed because nobody else answered.`
      )
    case "unsure":
      return (
        `Converged in round ${round}: every participant answered UNSURE. They agree only that the ` +
        `evidence available to them does not settle it — this is unresolved by evidence, not upheld.`
      )
    case "restated":
      return (
        `Stalled in round ${round}: nobody moved. Two models restating themselves is not progress, ` +
        `so the remaining rounds were not spent — the judge takes it from here.`
      )
    case "silent":
      return (
        `Stalled in round ${round}: NO PARTICIPANT STATED A POSITION. There is no transcript to ` +
        `read; more rounds could not have produced one, so they were not spent.`
      )
    case "capped":
      // Deliberately ONE neutral sentence for both rooms that reach the sweep:
      // a live disagreement that never settled, and a lone voice whose silent
      // seat never got the second round `exitFor` promised it. "Did not reach a
      // conclusion" is literally true of both — `exitFor` returning `undefined`
      // IS the stage declining to conclude — where "positions remained
      // unsettled" would be false of the second. Distinguishing the two would
      // need a specified reason and its own tests, not a state inspection
      // reconstructed here (code review 2026-08-26).
      return (
        `Round cap reached after round ${round}: the room did not reach a conclusion before the ` +
        `configured limit.`
      )
  }
}
