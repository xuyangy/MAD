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

import { mayISpend, recordTurn, type BudgetLedger } from "../budget/ledger.ts"
import { appendEntry, effectiveSeverity, type Finding } from "../domain/finding.ts"
import type { Roster } from "../domain/roster.ts"
import type { DebateCounts } from "../domain/run-record.ts"
import type { Warning } from "../domain/warning.ts"
import { resolveInstructions } from "../instructions/registry.ts"
import type { InstructionSet } from "../instructions/types.ts"
import type { Clock } from "../ports/clock.ts"
import type { Envelope, ModelBackend } from "../ports/model-backend.ts"

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
}

export interface DebateStageResult extends DebateCounts {
  /** The same array, debated in place. Debate never filters. */
  findings: Finding[]
  /** The clamped value this run actually debated under. */
  maxRounds: number
  warnings: Warning[]
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
    let envelope: Envelope<DebateEnvelope>
    try {
      envelope = await input.backend.runTurn(slot, instructions, prompt, debateEnvelopeSchema)
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
    const { file, startLine, endLine } = finding.locus
    const locus =
      startLine === undefined
        ? file
        : endLine === undefined || endLine === startLine
          ? `${file}:${startLine}`
          : `${file}:${startLine}-${endLine}`
    const you = room.labels.get(slot) ?? "an observer"

    lines.push(
      ``,
      `## finding \`${finding.id}\` — ${locus} [${effectiveSeverity(finding)}]`,
      // The room is told who RAISED the finding, because "a finding dies only by
      // its author's own withdrawal" is a rule the author has to be able to
      // apply — and a non-author has to know that `withdraws` is not theirs.
      `Raised by: ${room.labels.get(finding.author) ?? "participant ?"}. You are ${you}.`,
      ``,
      `Claim: ${finding.claim}`,
    )
    if (finding.reasoning.trim().length > 0) lines.push(`Reasoning: ${finding.reasoning}`)

    const transcript = finding.history.filter((entry) => entry.stage === "debate" && entry.round !== undefined)
    if (transcript.length === 0) {
      lines.push(``, `No positions have been stated yet.`)
    } else {
      lines.push(``, `Exchange so far:`)
      for (const entry of transcript) {
        const who = room.labels.get(entry.actor) ?? "a participant"
        const cited = entry.citations && entry.citations.length > 0 ? ` [cites ${entry.citations.join(", ")}]` : ""
        const conceded = entry.concession ? ` (conceded: ${entry.concession})` : ""
        lines.push(`- round ${entry.round}, ${who} — ${entry.position}: ${entry.body}${cited}${conceded}`)
      }
    }
  }

  return lines.join("\n")
}

/**
 * The standing positions in a room — the LATEST position each member has stated,
 * or nothing if they have never spoken.
 *
 * Read from `history` rather than from a parallel map, because `history` is the
 * append-only record AD-7 makes authoritative and story 6's judge reads exactly
 * this. A second copy of the same fact is a second thing that can be wrong.
 */
function isDebatePosition(value: string | undefined): value is DebatePosition {
  return value !== undefined && (DEBATE_POSITIONS as readonly string[]).includes(value)
}

function standingPositions(finding: Finding): Map<string, DebatePosition> {
  const standing = new Map<string, DebatePosition>()
  for (const entry of finding.history) {
    if (entry.stage !== "debate" || entry.round === undefined) continue
    // VALIDATED ON READ, not cast (code review 2026-08-24). `Entry.position` is
    // a plain `string?` on the shared append-only record, so nothing in the type
    // system stops a future writer — story 6's judge, a v2 memory replay —
    // appending a debate entry with an off-vocabulary position. An unchecked
    // cast would let that value silently join the agreement and movement tests,
    // corrupting an exit with no error anywhere. A value outside the vocabulary
    // is not a position this stage stated, so it is not a position this stage
    // counts.
    if (!isDebatePosition(entry.position)) continue
    standing.set(entry.actor, entry.position)
  }
  return standing
}

/**
 * WHY a debate ended, beside WHAT its exit was.
 *
 * `Finding.exit` is a three-value field declared in story 1 and this story must
 * not widen it (AD-8, and the story's own Code Map). But three words are not
 * enough for story 6's judge, and AD-6 is the reason: a room that AGREED and a
 * room where nobody but the author ever spoke both land on `converged` today,
 * and "nobody contested it because nobody answered" rendered as "the standing
 * positions settled" is a degraded review reading exactly like a good one.
 *
 * So the reason rides in the exit entry's `kind` — `debate-exit-<exit>-<reason>`
 * — which is a free string on the append-only record the judge already reads,
 * costs no new field, and keeps `startsWith("debate-exit-")` working for anyone
 * who only wants to know that an exit happened.
 */
type ExitReason =
  /** Two or more voices, all holding the same definite position. Real agreement. */
  | "agreed"
  /** The author withdrew. A finding dies only by its author's own hand. */
  | "withdrawn"
  /**
   * ONE voice was ever heard. Nobody disagreed because nobody else answered —
   * which is not the same fact as agreement and must never render as one.
   */
  | "uncontested"
  /**
   * Every standing position is `unsure`. Unanimous uncertainty is a settled
   * debate in the sense that nobody is going to move, and it is precisely the
   * case the judge must know was unresolved BY EVIDENCE rather than agreed.
   */
  | "unsure"
  /** People spoke and nobody moved. `cost-model.md` lever 3. */
  | "restated"
  /** Nobody stated a position at all. More rounds cannot help. */
  | "silent"

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

  for (let round = 1; round <= maxRounds && !exhausted; round += 1) {
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
    if (!mayISpend(ledger)) {
      exhausted = true
      break
    }

    rounds += 1
    turns += permitted.length

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
        ...(await runDebateTurn(input, slot, debateInstructionText, buildPrompt(input, slot, bySlot.get(slot)!, round))),
      })),
    )

    // AD-15 — `turns` counts ALLOCATIONS requested, `attempts` counts turns
    // actually billed. A turn that failed once and succeeded on its retry is one
    // allocation and two billed calls, so the two numbers legitimately differ
    // and the renderer prints both rather than one captioned as the other (code
    // review 2026-08-24).
    for (const outcome of outcomes) attempts += outcome.attempts

    const at = clock.now()
    const movedPerFinding = new Map<string, Set<string>>()
    const spokePerFinding = new Map<string, Set<string>>()
    for (const room of open) {
      movedPerFinding.set(room.finding.id, new Set())
      spokePerFinding.set(room.finding.id, new Set())
    }

    for (const outcome of outcomes) {
      if (!outcome.envelope.ok) {
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
              `MODEL DROPPED OUT OF DEBATE: slot \`${outcome.slot}\` failed twice in round ${round} ` +
              `(${outcome.envelope.failure}: ${outcome.envelope.message}). The round completed without ` +
              `it, and it is NOT asked again in any later round of this debate. Its silence is an ` +
              `abstention: it neither denied nor conceded any finding, and no debate waited on it.`,
            detail: {
              slot: outcome.slot,
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
  if (!exhausted) {
    const at = clock.now()
    for (const room of rooms) {
      if (room.finding.exit === undefined && !room.finding.unresolved) {
        recordExit(room.finding, { exit: "cap", reason: "restated" }, maxRounds, at)
      }
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
        reason: `the token budget (${ledger.cap}) ran out ${where}`,
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
      warnings.push({
        code: "unresolved-findings",
        stage: "debate",
        message:
          `BUDGET EXHAUSTED IN DEBATE: ${stranded.length} contested finding(s) were still undecided ` +
          `when the token cap of ${ledger.cap} was reached, ${where}. They are reported in the ` +
          `UNRESOLVED section with the evidence they accumulated — nothing was dropped.`,
        detail: {
          cap: ledger.cap,
          roundsRun: rounds,
          maxRounds,
          findings: stranded.map((room) => room.finding.id),
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
    converged,
    convergedUncontested,
    convergedUnsure,
    stalled,
    cap,
    unresolved,
    rounds,
    turns,
    attempts,
  }
}

/**
 * The reason a finding exited, read back off the append-only record — the same
 * place story 6's judge reads it, so the counts and the judge cannot disagree.
 */
function exitReasonOf(finding: Finding): ExitReason | undefined {
  for (let i = finding.history.length - 1; i >= 0; i -= 1) {
    const kind = finding.history[i]!.kind
    if (!kind.startsWith("debate-exit-")) continue
    const reason = kind.split("-").at(-1)
    return reason as ExitReason
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
  }
}
