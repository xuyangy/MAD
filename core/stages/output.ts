/**
 * Stage 6 — OUTPUT (CAP-6).
 *
 * Writes only `rank` (AD-8) and renders the run record.
 *
 * AD-9 is the rule with teeth here: co-discovery, verdict and evidence are
 * three separate fields and three separate columns. No function in this file
 * computes a scalar from more than one of them. Ranking ORDERS by them; it
 * never FUSES them into a stored or displayed number. Co-discovery always
 * renders as a fraction with its denominator.
 *
 * AD-17 lands here too, in its (e) clause: a lens-sourced finding is DISCLOSED
 * — its co-discovery renders *not applicable — lens-sourced*, its lens is named
 * on its row, and the roster block states that lens slots buy coverage and not
 * lineage. Every one of those discriminates on `source`, never on
 * `coDiscovery === undefined` (AD-9 amended) — except the COMPARATOR, which asks
 * a different question and says so at the site.
 *
 * Story 3 extends the same clause to a MERGED finding: an absorbed member leaves
 * the finding list entirely, so a canonical names what it absorbed, who raised
 * it, and — for a lens member — which lens (`renderMerged`). AD-10 arrives with
 * it: the severity cell reads `effectiveSeverity`, because a cluster that took a
 * member's `critical` must print `critical` while `severity` itself stays
 * unwritten (AD-8). ORDERING reads the same accessor (code review 2026-08-15):
 * sorting on the raw field while rendering the effective one printed a
 * `critical` below a `high`. Story 7 still owns the full ranked-output
 * treatment; this is only the tie between the two severity reads.
 *
 * Story 4 adds two READS and no writes: a `route:` line per finding — in the
 * resolved list AND in the unresolved section — and a `ROUTING` summary naming
 * the threshold and the partition. CAP-3's criterion is that changing the
 * threshold alone changes which findings enter debate, and an unrendered route
 * would leave that measurable only from the record. The per-finding line is
 * silent when `route` is unset and the summary is silent when
 * `record.routeCounts` is absent, so `output()` stays callable mid-pipeline.
 *
 * The summary reports `RunRecord.routeCounts` — the ROUTE STAGE's own counts —
 * and never recounts the list it is rendering. Two counts of one partition can
 * disagree, and this one would: the renderer only ever sees the resolved
 * findings, so it would shed any routed finding that later died.
 *
 * Story 5 adds two more READS and, again, no writes: a `debate:` line per
 * finding — in the resolved list AND in the unresolved section, on story 4's
 * precedent — and a `DEBATE` summary after the routing one. `rankFindings` is
 * UNTOUCHED: `exit` is not a ranking criterion, verdict ordering is story 6's,
 * and an exit sorted on would put "we argued about this" above "this is bad".
 * Both are silent when the stage did not run, so `output()` stays callable
 * mid-pipeline.
 *
 * Story 6 adds READS again, and no writes: the `judge:` line per finding in both
 * sections, the three judge outputs printed under the finding, a `JUDGE` summary
 * after the debate one, and — the one behavioural change — the stale
 * "judging is not implemented yet" note is GONE. `rankFindings` DOES change, and
 * only because AD-9's amendment assigned the change to this story: when
 * co-discovery is skipped or ties, ordering now falls through to verdict, then
 * evidence, then locus. Nothing is fused; each criterion still reads one thing.
 *
 * Story 7 adds READS and, again, no writes — `rank` is still the only field this
 * stage sets (AD-8) and `rankFindings` is UNTOUCHED, because ranking was settled
 * by story 6. What story 7 adds is the material behind the claims the page
 * already made: the debate TRANSCRIPT under each finding, so a reader can weigh
 * the argument CAP-6 asks them to weigh and not only its exit; a fallback for
 * `evidence so far:` to the debate's last positions, so AD-6d's promise of "the
 * evidence they accumulated" is true rather than answered with `assertion only`
 * for a finding two models argued over; `Warning.stage` and `source` printed as
 * values; and disclosure-versus-degradation classified from `DISCLOSURE_CODES` in
 * `core/domain/warning.ts` rather than from a denylist here.
 *
 * AD-18's eighth span is NOT here, deliberately. The rendered run reaches a model
 * — the host agent reads the opencode tool's output — but it reaches a human too,
 * where a notice sentence and a fence are noise. `output()` returns the bare
 * report and `frameForHostAgent` (`core/run/review.ts`) frames it at the one
 * boundary a model reads it. Nothing in this file emits a span (AD-18).
 *
 * Story 7A adds two lines and no new read of a finding. A cancelled run says so
 * in its HEADER, above the roster and before any count — the warnings block also
 * carries it, and a reader scrolls past that block on the way to the findings, so
 * "this is not a complete review" has to be the first thing under the title
 * (AD-6f). And the `TOKENS —` line gains a `PEAK —` line beneath it: the bound on
 * turns in flight is MAD-computed and is NOT a degradation, so it sits beside the
 * spend it is the second time scale of rather than under the warnings heading
 * (AD-15 amended).
 *
 * AD-6 — ALL SIX degradation reports are carried here and rendered: the
 * denominator (a), drop-outs (b), the roster warning (c), the unresolved section
 * (d), lens homogeneity (e), and — from story 7A — the cancelled run (f). Six is
 * now true, and the count in this paragraph has been wrong in BOTH directions:
 * it read "all six" before story 7, when five existed and (f) had no signal to
 * raise it; story 7 corrected it to five and named 7A as the story that would
 * make it six. A comment claiming finished work is AD-6's own failure applied to
 * the source, which is why the number is edited rather than left vague. Beside
 * the six, story 6 added an
 * unverified fact-check, which is the report most likely to pass for a healthy
 * run — a verdict reasoned from nothing looks exactly like a verdict read out of
 * the repo. The same rule covers what the finding list IS while the pipeline is
 * short of stages: before clustering runs it is a pool, not a merged set, and a
 * multi-model run says so (`pooledNotYetMerged`).
 */

import { budgetReport, ceilingNamed, spentTokens } from "../budget/ledger.ts"
import { effectiveSeverity, severityRank, type Entry, type Finding } from "../domain/finding.ts"

import { formatThreshold, type RunRecord } from "../domain/run-record.ts"
import { DISCLOSURE_CODES } from "../domain/warning.ts"
import { LINE_BREAK_CLASS, listCell, oneLine } from "../prompt/material.ts"
import { isStatedPosition, type DebatePosition } from "./debate.ts"

/**
 * The co-discovery ratio, computed at sort time and never stored (AD-9). A
 * denominator of zero means nobody answered, which is not evidence of anything.
 */
function coDiscoveryRatio(finding: Finding): number {
  const co = finding.coDiscovery
  if (!co || co.answered <= 0) return 0
  return co.raised / co.answered
}

/**
 * AD-9 — the verdict, as an ORDER and never as a score. Higher sorts first.
 *
 * A reviewer reads top-down and stops when the list stops being worth reading, so
 * the order is "how much does this still deserve your attention":
 *
 * - `upheld` — real, as far as anything could tell. Read it.
 * - not adjudicated (and UNSET, which is the same to a reader) — nobody settled
 *   it, so it is still yours to decide. Above the two that were settled against.
 * - `judge-ruled-invalid` — examined and rejected. Kept visible (nothing is ever
 *   removed) and it does not belong near the top.
 * - `withdrawn-by-author` — LAST, and below judge-ruled-invalid deliberately: the
 *   person who found it no longer claims it, which is the most complete
 *   retraction available. A judge disagreeing with a reviewer is weaker evidence
 *   against a finding than the reviewer disagreeing with themselves.
 */
function verdictRank(finding: Finding): number {
  switch (finding.verdict) {
    case "upheld":
      return 3
    case "judge-ruled-invalid":
      return 1
    case "withdrawn-by-author":
      return 0
    default:
      return 2
  }
}

/**
 * CAP-6 — what was ACTUALLY produced, as an order.
 *
 * Read off the append-only history rather than off `finding.evidence`, and the
 * difference matters: a verify-independently finding never has an extraction (it
 * had no transcript to extract from) but may very well have had its file opened,
 * and ordering on `evidence` alone would sink every unargued finding below every
 * argued one regardless of what was checked.
 *
 * The entry KINDS are the judge's (`core/stages/judge.ts`), which is a coupling
 * between two stages — accepted because the alternative is parsing MAD's own
 * `VERIFIED`/`UNVERIFIED` prefix back out of prose, which is worse.
 */
function evidenceRank(finding: Finding): number {
  let seen = 0
  for (const entry of finding.history) {
    if (entry.stage !== "judge") continue
    if (entry.kind === "judge-fact-check-verified") return 2
    if (entry.kind === "judge-fact-check-unverified" || entry.kind === "judge-evidence") seen = 1
  }
  return seen
}

/**
 * AD-9 — ordering only. Each comparison reads ONE field at a time, in
 * documented precedence; nothing is combined into a score.
 */
export function rankFindings(findings: Finding[]): Finding[] {
  const ordered = [...findings].sort((a, b) => {
    // 1. severity — read through `effectiveSeverity`, the SAME accessor the
    // severity cell renders. Sorting on the raw `severity` field instead let a
    // cluster that absorbed a member's `critical` print `critical` and rank
    // below a `high`, because `clusterSeverity` is written exactly when the
    // highest member severity is not the canonical's own (AD-10, AD-8: the raw
    // field stays unwritten). Ordering and rendering must read one accessor.
    const bySeverity = severityRank(effectiveSeverity(b)) - severityRank(effectiveSeverity(a))
    if (bySeverity !== 0) return bySeverity

    // 2. AD-9 amended — co-discovery is a criterion only when BOTH findings
    // carry a prior. Compared as a ratio at sort time and never stored: raw
    // `raised` counts would rank 2/9 above 1/1, inverting the signal the moment
    // denominators differ — which they do from story 2 onward.
    //
    // A missing prior is NOT coerced to a ratio. `coDiscoveryRatio` returns `0`
    // for an absent pair, and `0` already means "nobody answered" — a genuinely
    // different fact. Reusing it here would rank a correct lens finding dead
    // last as though every model had disagreed with it.
    //
    // THE PREDICATE IS `coDiscovery !== undefined`, NOT `source === 'pool'`, and
    // that is not a contradiction of AD-9's "never discriminate on
    // `coDiscovery === undefined`". The two ask different questions. RENDERING
    // asks "is a prior claimable at all?" — permanently a question about
    // `source`. ORDERING asks "does this finding carry a prior right now?" — and
    // a POOL finding before clustering runs does not, so `source === 'pool'`
    // would compare a pool finding's absent prior against a real one and
    // reintroduce the coercion from the other side. Do not "correct" this.
    const aPrior = a.coDiscovery !== undefined
    const bPrior = b.coDiscovery !== undefined
    if (aPrior && bPrior) {
      const byCoDiscovery = coDiscoveryRatio(b) - coDiscoveryRatio(a)
      if (byCoDiscovery !== 0) return byCoDiscovery
    }
    // 3. AD-9 amended, and this is the criterion story 6 was told to add: when
    // co-discovery is skipped or ties, ordering falls through to VERDICT, then
    // EVIDENCE, then locus. Each is read on its own — nothing is combined into a
    // score, and nothing is stored.
    const byVerdict = verdictRank(b) - verdictRank(a)
    if (byVerdict !== 0) return byVerdict

    // 4. what was actually produced. A verdict backed by a file somebody opened
    // sorts above one backed by a model's confidence, which is CAP-6's whole
    // claim about the evidence column applied to the order the columns appear in.
    const byEvidence = evidenceRank(b) - evidenceRank(a)
    if (byEvidence !== 0) return byEvidence

    // 5. stable tiebreak on locus, so two runs of the same input print alike
    const byFile = a.locus.file.localeCompare(b.locus.file)
    if (byFile !== 0) return byFile
    return (a.locus.startLine ?? 0) - (b.locus.startLine ?? 0)
  })

  // `rank` is output's own field (AD-8).
  ordered.forEach((finding, index) => {
    finding.rank = index + 1
  })
  return ordered
}

/**
 * AD-17e / AD-9 — who raised it, and `source` PRINTED AS A VALUE (story 7).
 *
 * The lens label has been rendered since CAP-11, so a lens finding always
 * disclosed itself. A POOL finding said nothing at all: `source` — the field AD-9
 * amended makes the ONE discriminator for "is a co-discovery prior claimable" —
 * was readable only by its absence, which is exactly the inference from silence
 * the amendment forbids everywhere else. A reader could not tell a pool finding
 * from a finding whose `source` the renderer had simply not looked at.
 *
 * So both are named. The lens label keeps its existing wording beside it rather
 * than replacing it: `source: lens` is the field, and WHICH lens found it is the
 * fact AD-17(e) actually requires.
 */
function renderRaisedBy(finding: Finding): string {
  if (finding.source !== "lens") return `      raised by: ${finding.author}  (source: pool)`
  return (
    `      raised by: ${finding.author}` +
    `  (source: lens — lens-sourced: \`${finding.lens ?? "unnamed"}\`)`
  )
}

/**
 * The finding's location, as ONE cell of a row MAD formats.
 *
 * `locus.file` IS A MODEL'S FREE STRING (code review 2026-08-30, second pass).
 * `core/stages/discover.ts` validates it as `z.string().min(1)` and nothing
 * narrows it after — so a `file` carrying a line break puts model-chosen text at
 * MAD's own indentation, under MAD's own headings. Story 5A found this and moved
 * the locus INTO a material span; story 7 then made the whole report a span the
 * host agent is told to read as evidence, and a reviewer demonstrated with a live
 * run that a break plus `  #99  [critical]  src/EVIL.ts:1` renders a finding
 * nobody raised, INSIDE that span. A fence cannot stop it, because the forgery
 * impersonates MAD's frame from inside the frame.
 *
 * So the cell is collapsed here, once, at the one function every reader of the
 * locus goes through — the finding header, the unresolved section, and the change
 * summary alike. `startLine` and `endLine` are numbers and forge nothing.
 */
function renderLocus(finding: Finding): string {
  const { startLine, endLine } = finding.locus
  const file = oneLine(finding.locus.file)
  if (startLine === undefined) return file
  if (endLine === undefined || endLine === startLine) return `${file}:${startLine}`
  return `${file}:${startLine}-${endLine}`
}

/** AD-9 — always a fraction with its denominator, never a pre-divided float. */
function renderCoDiscovery(finding: Finding): string {
  // AD-9 amended / AD-17d — a lens finding claims no prior, and says so in
  // words. Never `—` (which means "clustering has not run"), never `0`, never
  // `1/1`. The discriminator is `source`, permanently: `coDiscovery ===
  // undefined` is the OTHER absence and conflating them is what this whole
  // field exists to prevent.
  if (finding.source === "lens") return "not applicable — lens-sourced"
  if (!finding.coDiscovery) return "—"
  // A zero denominator would print `1/0`, which looks like a number and is not
  // one. AD-6a: the denominator is the honest part of this fraction.
  if (finding.coDiscovery.answered <= 0) return "— (no model answered)"
  return `${finding.coDiscovery.raised}/${finding.coDiscovery.answered}`
}

/**
 * AD-17e — what a merged canonical absorbed, and this is disclosure, not
 * decoration.
 *
 * A lens finding that merges into a pool cluster disappears from the finding
 * list entirely, and "the reader always learns a finding was lens-sourced and
 * which lens found it" has no exception for a member that merged. Members are
 * resolved against `record.pool` — the pre-cluster union — because that is the
 * only place an absorbed member still appears (AD-14, `RunRecord.pool`).
 */
function renderMerged(finding: Finding, pool: readonly Finding[]): string | undefined {
  const ids = finding.mergedIds
  if (!ids || ids.length === 0) return undefined

  const members = ids.map((id) => {
    const member = pool.find((candidate) => candidate.id === id)
    // An id the pool cannot resolve is a broken record, and saying so is more
    // honest than printing a shorter list that looks complete.
    if (!member) return `${id} (unresolved — not on the run record)`
    if (member.source !== "lens") return member.author
    return `${member.author} (lens-sourced: \`${member.lens ?? "unnamed"}\`)`
  })

  return `      merged: ${ids.length} other finding(s) — ${members.join(", ")}`
}

/**
 * CAP-3 — the route and the sentence that explains it.
 *
 * `route: 'judge'` MEANS verify-independently mode (`pipeline-stages.md` §5), and
 * the label says so, because "judge" alone reads like the finding was decided
 * rather than routed. Absent when `route` is unset, so `output()` stays callable
 * on a pre-route record — the same property `pooledNotYetMerged` relies on.
 */
function renderRoute(finding: Finding): string | undefined {
  if (!finding.route) return undefined
  const label = finding.route === "debate" ? "debate" : "judge (verify-independently)"
  return `      route: ${label} — ${finding.routeReason ?? "no reason recorded"}`
}

/**
 * CAP-4 — how this finding's debate ended, and what that exit MEANS.
 *
 * The three exits are not interchangeable and a bare word would let a reader
 * treat them as one: `converged` says the room settled, `stalled` says nobody
 * moved and the remaining rounds were deliberately not spent, `cap` says the
 * argument was still live when the rounds ran out. All three reach the judge;
 * only one of them is agreement.
 *
 * The round count is read from `history` — the append-only record (AD-7) — and
 * never from a stored counter, because a second copy of "how many rounds" is a
 * second thing that can disagree with the transcript printed beside it.
 *
 * Absent when `exit` is unset, which covers both a `route: "judge"` finding (it
 * was never argued) and a pre-debate record. Those two absences are told apart
 * by the `route:` line above, not by this one.
 */
function renderDebate(finding: Finding): string | undefined {
  if (!finding.exit) return undefined
  const rounds = finding.history.reduce(
    (highest, entry) => (entry.stage === "debate" && entry.round ? Math.max(highest, entry.round) : highest),
    0,
  )
  // The exit entry's own words, which carry the REASON the three-value `exit`
  // field cannot (`debate.ts`'s `ExitReason`) — so "the room agreed" and "only
  // the author ever spoke" do not render as the same sentence (AD-6).
  const explanation = finding.history.findLast?.((entry) => entry.kind.startsWith("debate-exit-"))?.body

  // ZERO ROUNDS IS NOT "after 0 round(s)" (code review 2026-08-24). A debate
  // that recorded no position spent no round anybody can read, and printing a
  // round count of zero implies rounds that ran and produced nothing — a
  // different and more flattering claim than the truth, which is that nothing
  // was ever argued.
  const when = rounds === 0 ? `with no round on the record` : `after ${rounds} round(s)`
  return `      debate: ${finding.exit} ${when} — ${explanation ?? "no reason recorded"}`
}

/**
 * The debate entries that actually carry a stated position, in round order.
 *
 * One accessor for the two readers below — the transcript and the `evidence so
 * far:` fallback — so the two can never disagree about what "the argument" was.
 *
 * `position` is part of the filter, not `kind` alone: a `debate-round` entry is
 * written once per position a participant stated (`core/stages/debate.ts`), and
 * an entry without one is not something anybody argued. Round order is HISTORY
 * order, which is append order (AD-7) and therefore already round order; the sort
 * is a stable one on `round` so a record assembled by hand renders the same way,
 * and two runs of one input render alike either way.
 *
 * THE WHOLE FILTER IS `core/stages/debate.ts`'s (code review 2026-08-30, second
 * pass). This filter and `standingPositions` there each had a predicate the other
 * did not — `kind` here, `round` there — so the `unresolved-findings` warning's
 * count and the transcript printed under it could have described different sets
 * while a comment asserted they could not. `isStatedPosition` is now the one test
 * for both, which also means this renderer can no longer be handed a round-less
 * entry and print the literal `round ? —` in MAD's own voice.
 */
function debateRounds(finding: Finding): (Entry & { position: DebatePosition; round: number })[] {
  return finding.history.filter(isStatedPosition).sort((a, b) => a.round - b.round)
}

/**
 * CAP-6 — THE ARGUMENT THAT PRODUCED THE FINDING, which nothing rendered until
 * story 7.
 *
 * `renderDebate` above prints an exit and a round count; the positions and the
 * arguments themselves sat unread in `history`. CAP-6 asks a reader to weigh the
 * argument, and a reader handed "converged after 2 round(s)" has been told a
 * debate happened and shown none of it — which is the AD-6 failure applied to the
 * one thing the whole pipeline exists to produce.
 *
 * WHAT IS PRINTED AND WHAT IS NOT. `round` and `actor` are MAD's own record of
 * the exchange, `position` is checked against this stage's vocabulary on the way
 * in (`debateRounds`), and `body`, `concession` and `citations` are the
 * participant's own words (AD-11: model-authored prose passes through unparsed).
 * What is NOT printed is `Warning.detail.raw` — the unvalidated model payload a
 * failed envelope carries, which nothing on this path sanitizes.
 *
 * ## EVERY CELL IS COLLAPSED, INCLUDING THE ARGUMENT (AD-18 as amended by 5A)
 *
 * `round N — <actor> <position>` and `cites: …` are rows MAD formats, and
 * `body`, `concession` and `citations` are cells MAD does not own.
 *
 * The ARGUMENT was the one left uncollapsed, on the argument that its lines are
 * indented deeper than a round header. That was WRONG and a reviewer demonstrated
 * it (code review 2026-08-30): `indent` puts the SAME ten-space prefix on every
 * body line that MAD's own `cites:` row carries, so a body containing a break and
 * then `cites: "src/NOT-REAL.ts:99"` renders a citation row byte-identical to
 * MAD's — evidence nobody cited, inside the very span the host agent is told to
 * read as evidence. A fence cannot stop it, because the forgery impersonates
 * MAD's frame from INSIDE the span.
 *
 * So the body goes through `oneLine` like every other cell — which is exactly
 * what `core/stages/debate.ts` already does when it renders the same entries into
 * the exchange span, one entry to one line. `oneLine` collapses the whole
 * `LINE_BREAKS` set, not `\n` alone, so a CR or a U+2028 forges no row either.
 * The cost is that a long argument is one long line; the alternative is a
 * transcript a reader cannot trust, and `claim` and `reasoning` below are still
 * printed with their paragraphs (they sit under no MAD-owned row of their own,
 * and are covered by their own deferred entry).
 *
 * NO SPAN AND NO FENCE (AD-18). This is the human-facing render; the framing is
 * applied once, over the whole report, at the boundary a model reads it.
 */
function renderTranscript(finding: Finding): string[] {
  const rounds = debateRounds(finding)
  if (rounds.length === 0) return []

  const lines = [`      the argument, in the participants' own words:`]
  for (const entry of rounds) {
    const conceded = entry.concession ? `  (conceded: ${oneLine(entry.concession)})` : ""
    lines.push(`        round ${entry.round} — ${oneLine(entry.actor)} ${entry.position}${conceded}`)
    lines.push(`          ${oneLine(entry.body)}`)
    if (entry.citations && entry.citations.length > 0) {
      lines.push(`          cites: ${entry.citations.map(listCell).join(", ")}`)
    }
  }
  return lines
}

/**
 * AD-6d — the last position each participant stood on, as the evidence fallback.
 *
 * The LAST one per participant, not every one: AD-6d asks for the evidence a
 * stranded finding accumulated, and a participant that moved is represented by
 * where it ended up.
 *
 * Order is first-appearance order in `debateRounds` — which is ROUND order, not
 * raw `history` order, because `debateRounds` sorts (code review 2026-08-30; this
 * comment said "in `history`", and the two differ in exactly the case a
 * hand-assembled record produces). Either way it is a pure function of the
 * record, so two runs of one input produce one string.
 */
function lastPositions(finding: Finding): string[] {
  const standing = new Map<string, DebatePosition>()
  for (const entry of debateRounds(finding)) {
    standing.set(entry.actor, entry.position)
  }
  // `listCell` ON THE ACTOR (code review 2026-08-30, second pass). These strings
  // are joined with `", "` into MAD's own `evidence so far:` row, so an actor
  // carrying a break or the separator itself would list participants nobody
  // seated — the same cell hygiene the transcript's `body` and `citations`
  // already get, applied to the one field that reaches a MAD-formatted row raw.
  return [...standing.entries()].map(([actor, position]) => `${listCell(actor)} ${position}`)
}

/**
 * CAP-3's criterion is that CHANGING THE THRESHOLD ALONE demonstrably changes
 * which findings enter debate, and this line is where a human sees it: two runs
 * at different thresholds differ here before they differ anywhere else. The dial
 * is printed with the counts because a partition without its threshold is a
 * number nobody can interpret.
 *
 * Silent on a pre-route record, for the same reason `renderRoute` is.
 */
function routingSummary(record: RunRecord): string[] {
  // The STAGE's counts, never a recount over the list being rendered. Absence is
  // "routing has not run" (`RunRecord.routeCounts`), which is why this reads the
  // field rather than filtering `resolved`: a recount here would cover only the
  // resolved findings and would quietly shed any routed finding that later died,
  // reporting a partition narrower than the one that was decided.
  const counts = record.routeCounts
  if (!counts) return []

  const lines = [
    `ROUTING (co-discovery threshold ${formatThreshold(record.threshold)}): ` +
      `${counts.toDebate} to debate, ${counts.toJudge} straight to the judge.`,
  ]

  // THE TWO JUDGE BUCKETS ARE NOT ONE CLAIM. A lens finding reached the judge
  // because it never had a fraction to place against the dial (AD-17d) — saying
  // "at or above the threshold" over a total that includes it would announce an
  // absent prior as a cleared one, which is the conflation AD-9's amendment
  // forbids and the whole reason this stage discriminates on `source`.
  if (counts.toJudgeAtThreshold > 0) {
    lines.push(
      `  ${counts.toJudgeAtThreshold} of those met or beat the threshold; skipping debate is not`,
      `  skipping scrutiny — they are judged verify-independently instead.`,
    )
  }
  if (counts.toJudgeNoPrior > 0) {
    lines.push(
      `  ${counts.toJudgeNoPrior} of those is lens-sourced and was never compared against the`,
      `  threshold at all — a lens claims no co-discovery prior (AD-17d), so it goes to`,
      `  verify-independently judging on that ground, not on a fraction.`,
    )
  }
  lines.push(`  Critical severity is debated at any threshold.`)
  // The "judging is not implemented yet" note that stood here until story 6 IS
  // GONE, and its removal is the point rather than a tidy-up: AD-6's honesty rule
  // cuts both ways, and a run that now judges must not keep telling a reader it
  // did not. What replaces it is `judgeSummary` below, which reports what
  // actually happened instead of what has not been built.
  lines.push("")
  return lines
}

/**
 * CAP-4 — the round cap and the exits it produced.
 *
 * Reports `RunRecord.debateCounts` — the DEBATE STAGE's own counts — and never a
 * recount of the list being rendered, for `routingSummary`'s reason exactly: the
 * renderer only ever sees the resolved findings, so a recount would shed every
 * finding the budget stranded, which is the one bucket a reader most needs to
 * see. Silent when the field is absent, which MEANS debate did not run.
 *
 * The four buckets are printed separately and never summed into a "debates
 * finished" figure. `stalled` is a saving, `cap` is a spend, and `unresolved` is
 * not an exit at all — it is AD-6d, and it is the only one that needs the reader
 * to do something.
 */
function debateSummary(record: RunRecord): string[] {
  const counts = record.debateCounts
  if (!counts) return []

  // AD-15 — the BUDGET is named beside the round cap, on the same CAP-3
  // precedent `maxRounds` follows: a partition without its dial is a count
  // nobody can interpret, and a ceiling that only appears once it has been hit
  // is a ceiling the reader cannot check the run against (code review
  // 2026-08-24). `null` is rendered as words, never as a blank or a `0`.
  // AD-15 (story 8) — the ceiling named here is the one DEBATE was actually held
  // to, which with a share in force is not the cap. `ceilingNamed` owns both
  // phrasings so this line cannot disagree with the strand reason printed under
  // a finding, and it renders as `the token cap of N` whenever the two coincide.
  const budget =
    record.ledger.cap === null ? "no token cap" : ceilingNamed(record.ledger, "debate")

  const lines = [
    `DEBATE (round cap ${record.maxRounds}, ${budget}): ${counts.debated} contested finding(s), ` +
      `${counts.rounds} batched round(s), ${counts.turns} turn(s) spent.`,
  ]

  if (counts.debated === 0) {
    // Not the same fact as "debate did not run", and the absent-vs-zero
    // distinction `debateCounts` exists for is worth one sentence here.
    lines.push(`  Nothing was contested, so no debate turn was spent.`)
    lines.push("")
    return lines
  }

  lines.push(
    `  exits: ${counts.converged} converged, ${counts.stalled} stalled, ${counts.cap} hit the round cap.`,
  )

  // THE TWO CONVERGED SUBSETS ARE SEPARATE CLAIMS, and both are cases where the
  // headline word overstates what happened (AD-6). They are printed as subsets
  // of `converged`, never added to the totals above.
  if (counts.convergedUncontested > 0) {
    lines.push(
      `  ${counts.convergedUncontested} of those converged UNCONTESTED — only one participant ever`,
      `  stated a position, so nobody disagreed because nobody else answered. That is not agreement.`,
    )
  }
  if (counts.convergedUnsure > 0) {
    lines.push(
      `  ${counts.convergedUnsure} of those converged on UNSURE — every participant said the evidence`,
      `  did not settle it. Unresolved by evidence, not upheld.`,
    )
  }
  if (counts.stalled > 0) {
    lines.push(
      `  A stalled debate is one where nobody moved. It short-circuits to the judge rather than`,
      `  burning the remaining rounds — restating is not progress.`,
    )
  }
  if (counts.unresolved > 0) {
    lines.push(
      `  ${counts.unresolved} finding(s) never reached an exit: the token budget ran out. They are`,
      `  in the UNRESOLVED section below, not dropped.`,
    )
  }
  // AD-15 / `cost-model.md` lever 1 — say what the batching bought, because a
  // turn count smaller than the finding count looks like an omission otherwise.
  lines.push(
    `  Turns are batched one per model per round over all of that model's open findings, so one`,
    `  turn can cover several debates (AD-15: that is one allocation, not several).`,
  )
  // The two numbers the TOKENS line can be reconciled against. Printed only when
  // they differ, because "4 turns, 4 attempts" is noise; when they do differ, a
  // reader counting ledger rows against turns needs to know why (code review
  // 2026-08-24).
  if (counts.attempts > counts.turns) {
    lines.push(
      `  ${counts.attempts} turn(s) were BILLED against those ${counts.turns} allocation(s): ` +
        `${counts.attempts - counts.turns} needed`,
      `  their one retry (AD-6b). The TOKENS line below counts billed attempts, not allocations.`,
    )
  }
  lines.push("")
  return lines
}

/**
 * CAP-5 — the verdicts the judge produced, and how much they are worth.
 *
 * Reports `RunRecord.judgeCounts` — the JUDGE STAGE's own counts — and never a
 * recount of the list being rendered, for `routingSummary`'s and
 * `debateSummary`'s reason exactly: the renderer only ever sees the resolved
 * findings, so a recount would shed the ones the budget stranded, which is the
 * one bucket a reader most needs. Silent when the field is absent, which MEANS
 * judging did not run.
 *
 * TWO PARTITIONS ARE PRINTED SEPARATELY — how each finding was handled, and what
 * was decided — and neither is summed into the other. Fusing them would need a
 * cross-tab ("upheld in verify-independently mode") nobody asked for.
 *
 * The unverified-fact-check line is the one AD-6 most requires: a run whose
 * checks all reasoned rather than read produced verdicts that LOOK exactly like
 * verdicts backed by the repo, and a reader with no line here has no way to tell.
 */
function judgeSummary(record: RunRecord): string[] {
  const counts = record.judgeCounts
  if (!counts) return []

  // "REACHED", NOT "DECIDED", AND THE PARTITION SUMS (code review 2026-08-28).
  //
  // `judged` counts every finding the stage got to, INCLUDING the ones the budget
  // stranded and the ones no surviving model could examine. Calling that number
  // "decided" and then naming three buckets that leave both out over-counted in
  // the flattering direction, and the printed numbers did not add up to the one
  // they were printed under.
  //
  // "in verify-independently mode", not "checked independently", for the same
  // reason: it is the MODE the stage chose, and the check inside it can drop out
  // — `factChecksDroppedOut` below is where a reader finds out that it did.
  //
  // AND THE TWO CAUSES OF `unresolved` ARE SPLIT HERE TOO (code review
  // 2026-08-31). This line used to print the whole of `counts.unresolved` as
  // "stranded by the budget", which over a cancelled run told a reader the token
  // cap stranded findings their own stop stranded — while the two warnings a few
  // lines above already had the split right. The summary and the warnings now
  // read off the same two numbers.
  const strandedByBudget = counts.unresolved - counts.unresolvedByCancellation
  const stranded: string[] = []
  if (strandedByBudget > 0) stranded.push(`${strandedByBudget} stranded by the budget`)
  if (counts.unresolvedByCancellation > 0) {
    stranded.push(`${counts.unresolvedByCancellation} left undecided when you stopped the run`)
  }
  if (counts.notExamined > 0) stranded.push(`${counts.notExamined} never examined`)

  const lines: string[] = [
    `JUDGE: ${counts.judged} finding(s) reached — ${counts.adjudicated} adjudicated after a ` +
      `debate, ${counts.verifiedIndependently} in verify-independently mode, ` +
      `${counts.withdrawnByAuthor} withdrawn by whoever raised it` +
      `${stranded.length > 0 ? `, ${stranded.join(", ")}` : ""}.`,
    `  Verdicts: ${counts.upheld} upheld, ${counts.ruledInvalid} ruled invalid, ` +
      `${counts.notAdjudicated} not settled, ${counts.withdrawnByAuthor} withdrawn.`,
  ]

  if (counts.withdrawnByAuthor > 0) {
    // The one verdict no model produced, and no token was spent on it. Said
    // plainly because a reader counting turns against verdicts would otherwise
    // find them short.
    lines.push(
      `  A withdrawn finding cost no judging at all: the reviewer who raised it took it back`,
      `  during the argument, and nobody else can withdraw a finding for them.`,
    )
  }

  if (counts.notAdjudicated > 0) {
    lines.push(
      `  "Not settled" is a real answer, not a failure: the evidence available did not decide it.`,
    )
  }

  if (counts.factChecksDroppedOut > 0) {
    // AD-6b/AD-12 — DIFFERENT from the unverified line below, and a reader acts
    // on it differently: an unverified check answered without opening anything,
    // this one never answered at all.
    lines.push(
      `  ! ${counts.factChecksDroppedOut} check(s) against the code NEVER COMPLETED — the model`,
      `  asked failed both attempts. Any finding relying on one was decided without it, or not`,
      `  decided at all.`,
    )
  }

  if (counts.notExamined > 0) {
    lines.push(
      `  ! ${counts.notExamined} finding(s) were NEVER EXAMINED: no reviewer model was left alive`,
      `  to check, weigh or decide them. They are reported exactly as they were raised.`,
    )
  }

  if (counts.factChecksUnverified > 0) {
    lines.push(
      `  ! ${counts.factChecksUnverified} of the checks against the code OPENED NOTHING AND RAN`,
      `  NOTHING, so nothing they concluded is confirmed. A check made by reasoning alone reads`,
      `  exactly like one that read the file. Treat those verdicts as opinion.`,
    )
  }

  if (counts.unresolved > 0) {
    lines.push(
      `  ${counts.unresolved} finding(s) ran out of budget before a verdict and are in the`,
      `  UNRESOLVED section below with whatever the earlier steps had produced.`,
    )
  }

  // WORDED SO THE TWO NUMBERS CANNOT BE READ AS ONE SET (code review
  // 2026-08-28). "5 allocation(s) spent judging. 7 were BILLED" reads as seven of
  // the five just named. They are a request count and a billing count, and the
  // retry is what separates them.
  lines.push(
    `  ${counts.turns} turn(s) requested while judging` +
      (counts.attempts > counts.turns
        ? `, billed as ${counts.attempts} calls — ${counts.attempts - counts.turns} needed the ` +
          `one retry AD-12 allows.`
        : `, each billed once.`),
  )
  lines.push("")
  return lines
}

/**
 * AD-9 — the verdict column, and it is never fused with the other two.
 *
 * `not adjudicated` covers two DIFFERENT states and deliberately reads the same
 * for both, because the difference is not the reader's to act on: the judge ran
 * and did not settle it, or the judge never reached it. Which one it was is on
 * the `judge:` line below and in the JUDGE summary, where a reader who cares can
 * find it — putting it in a three-word column would make the column a sentence.
 */
function renderVerdict(finding: Finding): string {
  if (!finding.verdict || finding.verdict === "not-adjudicated") return "not adjudicated"
  return finding.verdict
}

/**
 * One cell of the three-column row, clipped so the row cannot wrap.
 *
 * APPLIED BY THE CALLER, NOT BY `renderEvidence` (story 7). The clip belongs to
 * the ROW, not to the field: the resolved list prints `evidence:` as one of three
 * columns and AD-9 asks that row to stay readable as three, but the UNRESOLVED
 * section prints `evidence so far:` on a line of its own, where clipping deletes
 * the material AD-6d requires the run to hand over and there is no second copy of
 * it below. One 72-character rule over both cut a participant off the end of the
 * fallback list.
 */
function column(text: string): string {
  return text.length > 72 ? `${text.slice(0, 71)}…` : text
}

/**
 * Every line-break form, as a splitter, derived from AD-18's own exported SET.
 *
 * Built from `LINE_BREAKS` rather than written out, so a form added there is
 * picked up here without anybody remembering to (`core/prompt/material.ts` owns
 * the set and tests it). `\r\n` first, so a CRLF is one break and not two.
 *
 * `split("\n")` was the bug this replaces: a model's prose reaches MAD through
 * JSON, so a `\r` or a U+2028 arrives verbatim, and a "first line" taken on `\n`
 * alone silently carried the rest of the paragraph into a column (code review
 * 2026-08-30).
 *
 * THE CLASS COMES FROM `core/prompt/material.ts` TOO (code review 2026-08-30,
 * second pass). Joining the raw members here built an UNESCAPED class, so a
 * future member that is regex-meaningful (`\`, `]`, `^`, `-`) would have widened
 * or broken it silently. `LINE_BREAK_CLASS` is the escaped form, and it is the
 * same string AD-18's own escaper compiles — one set, one class, two readers.
 */
const LINE_BREAK_SPLIT = new RegExp(`\r\n|[${LINE_BREAK_CLASS}]`)

/** The first line with anything on it, trimmed. `""` when there is none. */
function firstNonBlankLine(text: string): string {
  for (const line of text.split(LINE_BREAK_SPLIT)) {
    const trimmed = line.trim()
    if (trimmed.length > 0) return trimmed
  }
  return ""
}

/**
 * CAP-6 — WHAT WAS ACTUALLY PRODUCED, and `assertion only` is the honest reading
 * of an absent extraction rather than a placeholder.
 *
 * The extractor's prose can run to paragraphs, so this carries its FIRST LINE
 * and the full text goes under the finding.
 *
 * ## AD-6d — the fallback, and why `assertion only` was a false claim (story 7)
 *
 * `evidence` is written by ONE writer, the judge's Evidence Extractor. So every
 * finding the budget stranded in DEBATE has none — and printed `evidence so far:
 * assertion only` directly beneath an `unresolved-findings` warning promising the
 * reader "the evidence they accumulated". Its positions and citations were sitting
 * in `history` unread. `assertion only` is the honest reading of a finding nobody
 * argued; it is a false one for a finding two models argued over for two rounds.
 *
 * So an absent extraction falls back to the debate's LAST standing positions, and
 * only a finding with neither reads `assertion only`. AD-9 is untouched: this
 * still reads ONE field — what was produced — and no scalar is computed from it.
 * The fallback lives in this function rather than at the `evidence so far:` call
 * site because the resolved list's `evidence:` column makes the same claim about
 * the same absence, and two readings of one field is how they come to disagree.
 */
function renderEvidence(finding: Finding): string {
  const state = evidenceState(finding)
  if (state.kind === "extracted") return state.extracted
  if (state.kind === "none") return "assertion only"
  return `no extraction — the debate's last positions: ${state.stood.join(", ")}`
}

/**
 * WHICH OF THE THREE EVIDENCE STATES A FINDING IS IN, decided once.
 *
 * ONE READING OF ONE FIELD (code review 2026-08-30, second pass).
 * `renderEvidence`'s own doc argues the fallback belongs in a single function
 * "because two readings of one field is how they come to disagree" — and then
 * `evidenceColumn` was added below with the same two reads open-coded a second
 * time. The two WORDINGS differ on purpose (one wraps a column, one does not);
 * the DECISION must not. So the decision lives here and each caller only words
 * it.
 *
 * THE FIRST NON-BLANK LINE, not the first line (code review 2026-08-30). An
 * extraction whose first line is blank made this fall through to the
 * debate-positions branch and print "no extraction" over an extraction that
 * exists — AD-6's honesty rule inverted, in the function whose whole job is to
 * say what was actually produced.
 */
type EvidenceState =
  | { kind: "extracted"; extracted: string }
  | { kind: "positions"; stood: string[] }
  | { kind: "none" }

function evidenceState(finding: Finding): EvidenceState {
  const extracted = finding.evidence === undefined ? "" : firstNonBlankLine(finding.evidence)
  if (extracted.length > 0) return { kind: "extracted", extracted }
  const stood = lastPositions(finding)
  return stood.length === 0 ? { kind: "none" } : { kind: "positions", stood }
}

/**
 * The same field as `renderEvidence`, sized for the three-column row.
 *
 * THE FALLBACK IS SUMMARISED HERE, NOT CLIPPED (code review 2026-08-30). The
 * prefix `no extraction — the debate's last positions: ` is 44 characters on its
 * own, so `column()` left barely one participant before the ellipsis: a short
 * TRUE string (`assertion only`) had been replaced by a truncated fragment, which
 * is a worse answer than the one story 7 set out to fix. A count is short, exact,
 * and points at the transcript printed under this same finding, which carries the
 * positions in full — so nothing is lost and the row stays three columns.
 *
 * The UNRESOLVED section's `evidence so far:` line calls `renderEvidence`
 * directly instead: it has no row to wrap and AD-6d wants the material itself.
 */
function evidenceColumn(finding: Finding): string {
  const state = evidenceState(finding)
  if (state.kind === "extracted") return column(state.extracted)
  if (state.kind === "none") return "assertion only"
  // "STANDING position(s)", not "debate position(s)" (code review 2026-08-30,
  // second pass). This is `lastPositions`' count — one per participant — and the
  // transcript it points at prints one row per ROUND, so a two-participant
  // two-round debate said "2" over four rows. Naming which count it is costs a
  // word and removes the mismatch a reader would otherwise have to work out.
  return `no extraction — ${state.stood.length} standing position(s), in the transcript below`
}

/**
 * CAP-5 — what the judge did to THIS finding, beside the summary that says what
 * it did to all of them.
 *
 * Absent when no judge entry exists, which means the stage never reached this
 * finding — a pre-judge record, a finding debate stranded, or a run where no
 * model could judge. That absence is told apart from "judged and undecided" by
 * this line being missing rather than by the verdict column, which reads the same
 * for both (see `renderVerdict`).
 */
function renderJudge(finding: Finding): string | undefined {
  const entries = finding.history.filter((entry) => entry.stage === "judge")
  if (entries.length === 0) return undefined
  // NO OPTIONAL CALL (code review 2026-08-28). `findLast` is ES2023 and the
  // pinned Bun has it; `?.` only bought a silent path where the `— <why>` clause
  // vanished and nothing failed.
  const verdictEntry = entries.findLast((entry) => entry.kind.startsWith("judge-verdict-"))
  const checked = entries.some((entry) => entry.kind === "judge-fact-check-verified")
  const unverified = entries.some((entry) => entry.kind === "judge-fact-check-unverified")
  const weighed = entries.some((entry) => entry.kind === "judge-logic-eval")
  // AD-6 (story 7) — the judge REACHED this finding and could not examine it,
  // which is a fact about the run and not the same as "the judge never got here".
  // Its entry is the only judge entry such a finding has, so without this branch
  // it fell through to `no step completed` — true, and silent about the cause.
  const notExamined = entries.find((entry) => entry.kind === "judge-not-examined")

  const steps: string[] = []
  // AD-13 stated in the render, not only in the warning: a reader scanning one
  // finding must be able to see that its check opened nothing.
  if (checked) steps.push("checked against the code")
  else if (unverified) steps.push("CHECK NOT VERIFIED — nothing was opened or run")
  if (weighed) steps.push("argument quality weighed")
  if (notExamined) {
    steps.push("NEVER EXAMINED — no reviewer model was left to check, weigh or decide it")
  }
  if (steps.length === 0) {
    // TWO EMPTY-STEP CASES, AND THEY ARE OPPOSITE (code review 2026-08-28). A
    // withdrawal's only judge entry is its verdict, because the stage
    // deliberately spends nothing on one — its own comment calls it "the FREE
    // verdict". Printing "no step completed" for it said a step had failed where
    // none was ever going to run, which is the AD-6 honesty rule pointed the
    // other way: a clean outcome reading as a degraded one.
    const withdrawn = verdictEntry?.kind === "judge-verdict-withdrawn-by-author"
    steps.push(withdrawn ? "no step needed" : "no step completed")
  }

  // THE VERDICT'S REASON, AND ONLY THAT (code review 2026-08-30). Falling back to
  // the not-examined entry's body printed the cause TWICE on one row — once as
  // the step above and again here, in ~300 unclipped characters — because both
  // are read off the same entry. The step names the cause; the entry's fuller
  // wording is where a reader of the record finds it, and the JUDGE summary and
  // the `judge-unavailable` warning both carry it in prose.
  //
  // READ THROUGH `firstNonBlankLine`, NOT `split("\n")[0]` (code review
  // 2026-08-30, second pass). This body is MODEL PROSE — `core/stages/judge.ts`
  // writes `${value.reasoning}\n\nEvidence: …` from the aggregator's own words —
  // so it is the same field shape `renderEvidence` above was fixed for, and it
  // was left on the old reader in the same commit that added the new one. A `\r`
  // or a U+2028 in the reasoning carried the WHOLE paragraph onto this row, and
  // its continuation lines landed at column 0 inside the span the host agent is
  // told to read as evidence. `oneLine` then collapses whatever survives, so no
  // break in model prose can forge a second row out of MAD's `judge:` line.
  const whyLine = verdictEntry === undefined ? "" : firstNonBlankLine(verdictEntry.body)
  const why = whyLine.length > 0 ? oneLine(whyLine) : undefined
  return `      judge: ${steps.join(", ")}${why ? ` — ${why}` : ""}`
}

/**
 * AD-6's honesty rule applied to the state a multi-model run is in before
 * clustering exists: the finding list is a UNION across models, not a merged
 * set. Left unsaid, a reader counting entries reads three models describing one
 * defect as three defects, and reads `1/3` on all of them as three weak
 * findings rather than one possibly-strong one.
 *
 * The discriminator is `clusterId` — the field clustering owns (AD-8) — so this
 * notice self-deletes the moment story 3 writes it, with nothing to remember to
 * remove. It says nothing at N=1, where a union of one is a merged set already.
 *
 * STORY 3 MUST WRITE `clusterId` ON EVERY FINDING, INCLUDING SINGLETONS.
 * `clusterId` is a proxy here for "clustering has run", and it only holds if
 * clustering marks findings it did not merge as well. If story 3 assigns ids
 * only to multi-member clusters, a post-clustering run in which nothing merged
 * re-announces this notice over a fully-clustered pool — a false statement, in
 * the one place AD-6 exists to keep honest. (Reviewed and bound, 2026-08-14.)
 *
 * The count is over the whole POOL, resolved or not (story 8). It used to be
 * over `resolved` alone, on the reasoning that a header should count the rows it
 * sits above — correct while `unresolved` was unreachable, and wrong the moment
 * story 8's budget made an all-unresolved run routine: the notice vanished
 * exactly when the once-per-model pool it warns about was the only thing on the
 * page. Both sections render pool findings, so the pool is the honest scope.
 */
function pooledNotYetMerged(record: RunRecord): string[] {
  // AD-17c/e — POOL-SCOPED, every number in it. `answered` already counts pool
  // models only (AD-6a); the count and the uniformity check below must match
  // that scope or the sentence describes a set it did not read. A lens finding
  // is additive coverage sitting in the same list, not a member of the union
  // this notice is about.
  //
  // AD-14 / deferred-work 2026-08-14 (closed by story 8) — DRIVEN OFF THE POOL,
  // NOT OFF THE RESOLVED LIST. This read `resolved` alone, and the entry filed
  // against it named exactly the state this story makes routine: when every
  // finding dies at a stage, `resolved` is empty, the notice is suppressed, and
  // the UNRESOLVED section below prints an unmerged pool — one defect once per
  // model — with nothing above it saying so. The warning belongs above the rows
  // a reader is about to be confused by, whichever section they are in.
  const pooled = record.findings.filter((finding) => finding.source === "pool")

  if (record.answered <= 1) return []
  if (pooled.length === 0) return []
  if (record.findings.some((finding) => finding.clusterId !== undefined)) return []

  const lines = [
    `POOL — NOT YET MERGED: these ${pooled.length} pool finding(s) are the union of what ` +
      `${record.answered} model(s) reported,`,
    `  reviewed independently and in parallel. Equivalent findings have not been clustered yet, so`,
    `  ONE DEFECT MAY APPEAR ONCE PER MODEL.`,
  ]

  // Only claim what the rows below actually show. The `{raised, answered}` pair
  // is stamped outside this stage (`core/run/review.ts`), and `output` is
  // exported and callable on a record whose findings carry none — where every
  // row renders `—` and an unconditional "every fraction reads 1/N" would be
  // simply false. AD-6 is an honesty rule; a header that describes rows it never
  // read is the failure it names, not an exception to it.
  //
  // Over POOL findings only: a lens finding never carries a pair (AD-17d), so
  // including it here would make `uniform` false whenever a lens ran and
  // silently suppress a true statement about the pool.
  const uniform = pooled.every(
    (finding) => finding.coDiscovery?.raised === 1 && finding.coDiscovery.answered === record.answered,
  )
  if (uniform) {
    lines.push(
      `  Every co-discovery fraction below reads 1/${record.answered}, because no finding has yet`,
      `  been credited with a second model raising it.`,
    )
  }

  lines.push("")
  return lines
}

/**
 * Indent every non-empty line of a block.
 *
 * SPLIT ON THE WHOLE BREAK SET, NOT `\n` ALONE (code review 2026-08-30, second
 * pass). This prints `claim`, `reasoning`, `evidence` and `factCheck` — all model
 * prose — and a `\r` or a U+2028 left everything after it UNINDENTED, at column 0,
 * inside the span the host agent is told to read as evidence. The file added
 * `LINE_BREAK_SPLIT` for exactly this class and did not use it here. Rejoined
 * with `\n` so the output normalises to one break form on the way out.
 */
function indent(text: string, prefix = "    "): string {
  return text
    .split(LINE_BREAK_SPLIT)
    .map((line) => (line.length > 0 ? prefix + line : line))
    .join("\n")
}

/**
 * A BLOCK OF MODEL PROSE, collapsed to one line before it is indented.
 *
 * THE LAST ROUTE INTO MAD'S OWN VOICE (code review 2026-08-30, second pass, and
 * a human decision the same day reversing the deferral).
 *
 * `claim`, `reasoning`, `evidence`, `factCheck` and `logicEval` are all written by
 * a model and were all printed at `"      "` — the SAME six-space prefix MAD uses
 * for its own `raised by:`, `route:`, `debate:` and `judge:` rows. A break in any
 * of them followed by `judge: checked against the code` renders a judge line no
 * judge wrote. Story 5A found the class, story 7 closed it for the transcript's
 * `body`, `concession` and `citations` and DEFERRED these — a defensible call
 * while the report was read only by a human.
 *
 * Story 7 is what changed that. `frameForHostAgent` makes the whole report a
 * labelled span the host agent is told to read as evidence, so a forged row is no
 * longer a cosmetic break in a terminal: it is a fabricated finding, or a verdict,
 * handed to a model inside MAD's own attestation. An acceptance run demonstrated
 * both. Shipping the span while leaving the cells open would have advertised as
 * safe a block whose interior rows can be written by the material inside it.
 *
 * THE COST IS PARAGRAPHS, AND IT WAS ACCEPTED KNOWINGLY. `oneLine` collapses the
 * whole `LINE_BREAKS` set to a literal `\n`, so a long argument or a
 * multi-paragraph fact-check is one long line. That is the same trade story 7
 * already made for the transcript body, for the same reason and with the same
 * alternative: a report a reader cannot trust. Nothing is removed and nothing is
 * judged — the escape is an encoding applied to the whole cell.
 */
function modelBlock(text: string): string {
  return indent(oneLine(text), "      ")
}

/**
 * Renders the run record. The rendered run IS the trace (spine, Observability):
 * a degraded run must never be indistinguishable from a clean one (AD-6).
 */
export function renderRunRecord(record: RunRecord): string {
  const lines: string[] = []

  lines.push(`MAD review — run ${record.runId}`)
  lines.push("=".repeat(60))
  // AD-6f — A CANCELLED RUN MUST NEVER RENDER AS A FINISHED ONE, and the
  // warnings block below is not enough on its own.
  //
  // The warning is there, and it is correct, and it sits under a heading a
  // reader scrolls past on the way to the findings — the same reason AD-6's
  // other reports are attached to the rows they qualify rather than only listed.
  // This is the first line under the title, before the roster, so "this is not a
  // complete review" is read before anything that could be mistaken for one. It
  // is deliberately MAD-authored and interpolates only `Stage`, which is a
  // closed union of MAD's own words — nothing here can be written by a model.
  if (record.cancelled) {
    lines.push(`RUN CANCELLED — you stopped this run during the ${record.cancelled.stage} stage.`)
    lines.push(`This is a PARTIAL review. See the warnings and the UNRESOLVED section below.`)
    lines.push("=".repeat(60))
  }
  lines.push("")

  // ---- roster, with the degradation facts attached ----
  lines.push("ROSTER")
  for (const slot of record.roster.slots) {
    const lineage = slot.lineage.verified ? slot.lineage.label : "lineage unverified"
    const also =
      slot.alsoAvailableVia.length > 0
        ? ` [also reachable via ${slot.alsoAvailableVia.join(", ")}; deduped, one slot only]`
        : ""
    lines.push(`  ${slot.slot}: ${slot.providerId}/${slot.modelId} — ${lineage}${also}`)
  }
  // AD-17c/e — lens slots, on their own lines and outside the lineage count.
  // Printing them inside the pool list above would put the one thing AD-4's
  // amendment separates back into one block for the reader, which is where the
  // "three personas over one Sonnet is three lineages" misreading starts.
  for (const lensSlot of record.roster.lensSlots) {
    const origin = record.lensInstructions.find((entry) => entry.lens === lensSlot.lens)?.origin
    const generated = origin === "generated" ? " [instruction GENERATED at run time, not shipped]" : ""
    lines.push(
      `  ${lensSlot.slot}: ${lensSlot.providerId}/${lensSlot.modelId} — lens \`${lensSlot.lens}\`, ` +
        `additive coverage; does NOT count toward distinct lineages${generated}`,
    )
  }
  lines.push(
    `  slots requested: ${record.roster.requested} | filled: ${record.roster.slots.length} | ` +
      `answered: ${record.answered} | distinct verified lineages: ${record.roster.distinctLineages}`,
  )
  if (record.roster.lensSlots.length > 0) {
    lines.push(
      `  lens slots: ${record.roster.lensSlots.length} (${record.roster.lensSlots
        .map((s) => s.lens)
        .join(", ")}) — coverage, not independence; they add nothing to the lineage count above.`,
    )
  }
  lines.push("")

  // ---- AD-6: warnings, rendered once, here, by output ----
  //
  // CLASSIFIED FROM A NAMED SET, NOT FROM A DENYLIST HERE (story 7). This read
  // `code !== "provider-fan-out"`, which put the vocabulary in two files: a code
  // added to `WarningCode` landed under "this run is degraded" whether or not
  // that is what it meant, and nobody editing `core/domain/warning.ts` would see
  // this line. `DISCLOSURE_CODES` lives beside the union; unlisted means
  // degradation, which is the safe default.
  const degradations = record.warnings.filter((w) => !DISCLOSURE_CODES.has(w.code))
  const disclosures = record.warnings.filter((w) => DISCLOSURE_CODES.has(w.code))

  if (degradations.length > 0) {
    lines.push("WARNINGS — this run is degraded")
    for (const warning of degradations) {
      // THE STAGE IS RENDERED (story 7). `Warning.stage` was populated at all
      // fourteen raise sites and printed at none, and it is the one fact the
      // message prose does NOT reliably carry: `model-dropped-out` is raised by
      // discover, debate and judge, and "which stage lost this model" changes
      // what the reader should conclude — a discovery drop-out shrinks the
      // co-discovery denominator, a judge drop-out does not. `detail` stays
      // unrendered, deliberately; see the story's design notes.
      lines.push(`  ! [${warning.stage}/${warning.code}] ${warning.message}`)
    }
    lines.push("")
  } else {
    lines.push("WARNINGS: none — this run is clean.")
    lines.push("")
  }

  for (const disclosure of disclosures) {
    lines.push(`DISCLOSURE: [${disclosure.stage}/${disclosure.code}] ${disclosure.message}`)
    lines.push("")
  }

  // ---- findings ----
  const resolved = record.findings.filter((f) => !f.unresolved)
  const unresolved = record.findings.filter((f) => f.unresolved)

  // ---- AD-6 — what the finding list below actually is, before clustering ----
  lines.push(...pooledNotYetMerged(record))

  // ---- CAP-3 — the dial and the partition it produced ----
  lines.push(...routingSummary(record))

  // ---- CAP-4 — the round cap and the exits it produced ----
  lines.push(...debateSummary(record))

  // ---- CAP-5 — the verdicts the judge produced ----
  lines.push(...judgeSummary(record))

  lines.push(`FINDINGS (${resolved.length})`)
  // The two facts the empty-findings branches below turn on, read once. A model
  // DROPPING OUT and the budget SKIPPING a slot are independent and can both be
  // true of one run; `record` carries no drop-out list, so the warning the
  // discovery stage already raised is the signal (AD-6b).
  const anyDroppedOut = record.warnings.some((warning) => warning.code === "model-dropped-out")
  const skippedForBudget = record.skippedForBudget?.length ?? 0
  if (resolved.length === 0) {
    // AD-6 — "no findings" and "nobody answered" are opposite facts and must
    // never render the same. An empty list after a roster that all dropped out
    // is not a clean review; saying so is the whole point of the invariant.
    //
    // AD-6f (code review 2026-08-31) — AND "NOBODY ANSWERED" AND "YOU STOPPED
    // IT" ARE A THIRD PAIR OF OPPOSITE FACTS. Until this branch existed, a run
    // the user cancelled before any slot answered printed "Every slot in the
    // roster failed or dropped out" three lines below a `run-cancelled` warning
    // saying no model failed — the report contradicting itself, with the half a
    // reader reaches later blaming providers that were working. That is the
    // exact false degradation report story 7A exists to remove, and it was one
    // render further down than the story looked. `record.cancelled` is checked
    // FIRST because a stop explains the empty roster completely: a slot that was
    // never asked did not drop out.
    if (record.cancelled && record.answered === 0) {
      lines.push("  NOTHING WAS EXAMINED — you stopped this run before any model answered.")
      lines.push(
        `  No model failed and no model was retried; the run stopped during the ` +
          `${record.cancelled.stage} stage.`,
      )
    } else if (skippedForBudget > 0 && record.answered === 0 && !anyDroppedOut) {
      // AD-15 / AD-6 (story 8) — THE SAME DEFECT, RE-OPENED BY A SECOND CAUSE.
      // 7A fixed this branch for cancellation and the fix was cause-specific:
      // once the budget can refuse a discovery turn, a run whose whole roster
      // went unasked lands back on "Every slot in the roster failed or dropped
      // out" — naming providers that never failed, three lines under a
      // `discovery-truncated` warning saying no model failed. Ordered AFTER the
      // cancellation branch (a stop explains an empty roster completely and is
      // the user's own action) and BEFORE the bare `answered === 0`, which is
      // the branch that would otherwise catch it.
      //
      // `!anyDroppedOut` IS LOAD-BEARING (code review 2026-09-06, four verifiers
      // reproduced it end to end). Without it this branch fires on a MIXED run —
      // one slot burns both attempts and blows discovery's share, the rest are
      // then refused — and prints "No model failed and no model was retried"
      // three lines under a `model-dropped-out` warning naming the model that
      // did. Worse, the causality is backwards: the drop-out is what exhausted
      // the share that refused the others. A stop explains an empty roster
      // completely; the budget explains only the slots it lists, which is why
      // this guard is narrower than the cancellation guard above it.
      //
      // The mixed case falls through to the branch below and is reported
      // ADDITIVELY, which is the shape `core/stages/discover.ts` already chose
      // for `denominator-reduced`'s two clauses in this same diff.
      lines.push("  NOTHING WAS EXAMINED — the budget ran out before any model was asked.")
      lines.push(
        `  No model failed and no model was retried; ${skippedForBudget} slot(s) ` +
          `were skipped to stay inside the token budget.`,
      )
    } else if (record.answered === 0) {
      lines.push("  NO MODEL ANSWERED — this is not a clean review.")
      lines.push("  Every slot in the roster failed or dropped out; nothing was examined.")
      lines.push("  See the warnings above for which models failed and why.")
      if (skippedForBudget > 0) {
        // BOTH CAUSES, AS TWO CLAUSES. A run can lose slots to a drop-out AND to
        // the budget at once, and the order matters to a reader: the drop-out
        // came first and is what left nothing for the rest.
        lines.push(
          `  ${skippedForBudget} further slot(s) were never asked at all, to stay inside the ` +
            `token budget — those were not skipped because a model failed.`,
        )
      }
    } else if (record.cancelled) {
      // Models answered and raised nothing, AND the user stopped the run. Both
      // are true and the second is the one that bounds what the first is worth:
      // "nothing was found" over a roster that was cut short is not the same
      // claim as "nothing was found" over one that ran to completion.
      lines.push(
        `  No findings were raised by the ${record.answered} model(s) that answered ` +
          `before you stopped the run.`,
      )
    } else {
      lines.push(`  No findings were raised by the ${record.answered} model(s) that answered.`)
    }
  }
  for (const finding of resolved) {
    lines.push("")
    // AD-10 — the CLUSTER's severity when it has one, so a cluster that took a
    // member's `critical` does not print the canonical's own `high` over it.
    // `severity` itself is never rewritten (AD-8), which is why this reads
    // through `effectiveSeverity` rather than off the field.
    lines.push(`  #${finding.rank ?? "?"}  [${effectiveSeverity(finding)}]  ${renderLocus(finding)}`)
    // AD-9 — three separate columns; nothing is fused.
    lines.push(
      `      co-discovery: ${renderCoDiscovery(finding)}   ` +
        `verdict: ${renderVerdict(finding)}   ` +
        `evidence: ${evidenceColumn(finding)}`,
    )
    // AD-17e — the reader always learns a finding was lens-sourced and WHICH
    // lens found it. Read from `finding.lens`, never parsed back out of the slot
    // id in `author` (AD-17, design notes). Story 7 names `source` for a POOL
    // finding too; see `renderRaisedBy`.
    lines.push(renderRaisedBy(finding))
    const merged = renderMerged(finding, record.pool)
    if (merged) lines.push(merged)
    // CAP-3 — why this finding took the path it did, per finding. The summary
    // line above says how many went each way; this says why THIS one did.
    const routed = renderRoute(finding)
    if (routed) lines.push(routed)
    // CAP-4 — and BELOW the route line on purpose: the route says the finding
    // was contested, the exit says how the argument ended. Read the other way
    // round the exit has nothing to be an exit from.
    const debated = renderDebate(finding)
    if (debated) lines.push(debated)
    // CAP-5 — and BELOW the debate line for the reason the debate line sits below
    // the route line: the judge reads the argument, so the argument has to have
    // been described before the ruling on it means anything.
    const judged = renderJudge(finding)
    if (judged) lines.push(judged)
    // CAP-6 — THE ARGUMENT ITSELF, and BELOW the three one-line summaries above
    // for their reason exactly: the route says the finding was contested, the
    // exit says how the argument ended, the judge line says what was ruled — and
    // only then is the transcript a thing the reader can read those against.
    // Silent when no position was ever stated, so a `route: "judge"` finding and
    // a pre-debate record gain nothing; the `route:` line stays the discriminator.
    lines.push(...renderTranscript(finding))
    lines.push("")
    lines.push(modelBlock(finding.claim))
    if (finding.reasoning.trim().length > 0) {
      lines.push("")
      lines.push(modelBlock(finding.reasoning))
    }
    // AD-9 — the judge's three outputs, each under its own heading and never
    // merged into one paragraph. `factCheck` carries MAD's VERIFIED/UNVERIFIED
    // prefix from the stage, so a reader sees the attestation beside the claim it
    // qualifies rather than having to find the warning that also says it.
    if (finding.evidence !== undefined) {
      lines.push("")
      lines.push("      EVIDENCE EXTRACTED FROM THE ARGUMENT")
      lines.push(modelBlock(finding.evidence))
    }
    if (finding.factCheck !== undefined) {
      lines.push("")
      lines.push("      CHECKED AGAINST THE CODE")
      lines.push(modelBlock(finding.factCheck))
    }
    if (finding.logicEval !== undefined) {
      lines.push("")
      lines.push("      HOW WELL EACH SIDE ARGUED (advisory — the code outranks it)")
      lines.push(modelBlock(finding.logicEval))
    }
  }
  lines.push("")

  // ---- AD-6d — the unresolved section, never dropped ----
  lines.push(`UNRESOLVED — YOU DECIDE (${unresolved.length})`)
  if (unresolved.length === 0) {
    lines.push("  Nothing was left undecided.")
  }
  for (const finding of unresolved) {
    // ONE BLANK LINE PER FINDING, as the resolved list has always done (code
    // review 2026-08-30, second pass). Without it consecutive undecided findings
    // ran together, and story 7 made that worse by adding the transcript: MAD's
    // own rows for one finding now abut the previous finding's claim prose at a
    // near-identical indent, in the ONE section AD-6d says a human reads by hand.
    lines.push("")
    lines.push(
      `  [${effectiveSeverity(finding)}] ${renderLocus(finding)} — died at stage ` +
        `${finding.unresolved?.diedAtStage} (${finding.unresolved?.reason})`,
    )
    lines.push(`      evidence so far: ${renderEvidence(finding)}`)
    // AD-17e applies to THIS section too. It is output, and "the reader always
    // learns a finding was lens-sourced and which lens found it" has no
    // exception for a finding the budget ran out on — a reader deciding an
    // undecided finding by hand needs to know it carries no prior BECAUSE it was
    // prompted, not because judging never reached it. Latent until story 8
    // writes `unresolved`; found before it could ship (code review 2026-08-15).
    lines.push(`${renderRaisedBy(finding)}   co-discovery: ${renderCoDiscovery(finding)}`)
    // AD-17e has no exception for this section either, and a merged canonical
    // that dies at a later stage carries the same absorbed lens member a
    // resolved one does. Same reasoning as the lens label on the line above.
    const merged = renderMerged(finding, record.pool)
    if (merged) lines.push(merged)
    // CAP-3 in this section too, on the same grounds as the lens label above. A
    // reader deciding an undecided finding by hand needs to know whether the
    // pipeline had judged it contested or had sent it straight to the judge —
    // that is the difference between "nobody has argued this yet" and "this was
    // settled enough to skip argument", and the died-at-stage line does not say
    // it. Latent until story 8 writes `unresolved`; added before it could ship
    // (code review 2026-08-16).
    const unresolvedRoute = renderRoute(finding)
    if (unresolvedRoute) lines.push(unresolvedRoute)
    // CAP-5 in this section too, on the same grounds as the lens label and the
    // route line above. A finding the budget stranded MID-JUDGE may already carry
    // a fact-check, and "we looked and ran out before ruling" is a materially
    // different thing to hand a reader than "we ran out before looking" — the
    // died-at-stage line names the stage and does not say how far into it the run
    // got. Unlike `renderDebate`, this one is NOT dead code here: `unresolved` and
    // a completed judge STEP legitimately co-occur, because the stage strands a
    // finding between its turns rather than before all of them.
    const unresolvedJudge = renderJudge(finding)
    if (unresolvedJudge) lines.push(unresolvedJudge)
    // CAP-6 / AD-6d IN THIS SECTION TOO (code review 2026-08-30). The transcript
    // was rendered in the resolved list only, and this is the section AD-6d is
    // actually about: a finding the budget stranded mid-debate is the one a
    // reader has to decide BY HAND, and "you decide" over an argument the report
    // will not show them is the failure story 7 exists to fix, sharpened. The
    // `evidence so far:` line above summarises the standing positions; this is
    // the argument behind them. Unlike `renderDebate`, this is NOT dead code
    // here: rounds are appended as they happen, so a room stranded in round 2
    // legitimately carries round 1's positions with no `exit` written.
    lines.push(...renderTranscript(finding))
    // NO `debate:` LINE HERE, and that is an invariant rather than an omission
    // (code review 2026-08-24). `unresolved` is written ONLY for a room whose
    // `exit` is still undefined (`debate.ts`, AD-6d), and no code path writes an
    // exit afterwards — so `unresolved` and `exit` cannot co-occur, and a
    // `renderDebate` call here was dead code sitting under a comment claiming
    // otherwise. What a reader needs in this section is the died-at-stage line
    // above, which already says the debate never reached an exit.
    //
    // A BLANK LINE BEFORE THE CLAIM, AND ONE AFTER THE FINDING (code review
    // 2026-08-30, second pass). The resolved list has always separated MAD's
    // one-line rows from the model's claim prose this way; this section did not,
    // and story 7 put the transcript directly above the claim at a near-identical
    // indent — so model prose ran straight on from MAD's own transcript rows,
    // and consecutive findings ran into each other, in the ONE section AD-6d says
    // a human has to read by hand.
    lines.push("")
    lines.push(modelBlock(finding.claim))
  }
  lines.push("")

  // ---- AD-15 — tokens, never currency ----
  const t = record.ledger.total
  // AD-15 / CAP-7 (story 8) — the SPEND AGAINST THE CEILING, on the one line
  // that already existed, so the overshoot is visible to a reader who reads
  // nothing else. Omitted entirely when there is no cap, so an uncapped run
  // renders byte-identically to what it rendered before this story.
  const spentClause =
    record.ledger.cap === null ? "" : ` | spent: ${spentTokens(t)} of ${record.ledger.cap}`
  lines.push(
    `TOKENS — turns: ${record.ledger.entries.length} | in: ${t.input} | out: ${t.output} | ` +
      `reasoning: ${t.reasoning} | cache r/w: ${t.cacheRead}/${t.cacheWrite}${spentClause}`,
  )
  // AD-15 amended (story 7A) — the PEAK, beside the total it is the second time
  // scale of. It is MAD-computed and it is not a degradation, so it belongs on
  // this line rather than under the warnings heading: nothing about a bounded
  // fan-out makes a review worth less. A reader comparing two runs' wall-clock
  // needs the number that bounded them, and story 8's presets will move it.
  lines.push(
    `PEAK — at most ${record.ledger.maxConcurrency} model turn(s) in flight at once ` +
      `(rate, not total; nothing was refused or dropped by this bound).`,
  )
  lines.push(...budgetBlock(record))

  return lines.join("\n")
}

/** The output stage: rank in place, then render. */
export function output(record: RunRecord): string {
  record.findings = rankFindings(record.findings)
  return renderRunRecord(record)
}

/**
 * AD-15 / CAP-7 (story 8) — where the money actually went, stage by stage.
 *
 * Prints NOTHING when there is no cap: an uncapped run has no ceilings to
 * compare against, and a block of "spent X of no limit" rows is noise in the
 * place a reader looks for a problem.
 *
 * THE RENDERER DOES NO BUDGET ARITHMETIC. Every number here comes back from
 * `budgetReport` in `core/budget/ledger.ts` — a stage that read the shares off
 * the ledger and multiplied would be a stage metering itself, which AD-15's
 * first sentence forbids and `scripts/lint-dependency-direction.ts` mechanically
 * prevents. It is also what keeps the printed figures from drifting from the
 * ones the gate compared, since both are folded out of the same `entries`.
 *
 * The three stage figures need not sum to the run total, and that is not a bug
 * to paper over: `LedgerEntry.stage` is a bare string, so an entry written by
 * anything other than the three billing stages lands in no bucket. The TOKENS
 * line above carries the true total, and this block never claims to replace it.
 */
function budgetBlock(record: RunRecord): string[] {
  const { cap } = record.ledger
  if (cap === null) return []

  const preset = record.preset === undefined ? "no preset" : `preset ${record.preset}`
  const lines = [`BUDGET (${preset}, token cap ${cap}) — each stage's share of that one cap:`]
  for (const row of budgetReport(record.ledger)) {
    const ceiling = row.ceiling === null ? "no ceiling" : `${row.ceiling}`
    // The ceiling is CUMULATIVE, and saying so on every row is cheaper than a
    // reader deducing it from three numbers that do not add up to the cap.
    const over = row.ceiling !== null && row.spent > row.ceiling ? " — OVER" : ""
    lines.push(`  ${row.stage}: ${row.spent} spent, cumulative ceiling ${ceiling}${over}`)
  }
  if (record.skippedForBudget !== undefined) {
    lines.push(
      `  ${record.skippedForBudget.length} discovery slot(s) were never asked, to stay inside ` +
        `discovery's share — those slots were not skipped because a model failed.`,
    )
  }
  return lines
}
