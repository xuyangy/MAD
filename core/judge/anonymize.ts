/**
 * AD-17b — the Anonymizer & Order Randomizer, the judge pipeline's first stage.
 *
 * Debaters become `A`/`B`/`C` in a randomized order. It exists to remove
 * AUTHORITY BIAS: a judge told "the frontier model says X and the small one says
 * Y" is weighing reputations, and a judge told "the Security Sentinel claims X"
 * is weighing a persona. Both are exactly the input this stage deletes.
 *
 * ## What is stripped, and what is deliberately kept
 *
 * STRIPPED: every slot id, every provider and model name reachable through one,
 * and the LENS (AD-17b — "the Security Sentinel claims" carries precisely the
 * authority anonymization exists to remove). `Finding.lens` and `Finding.author`
 * are never rendered, and the labels are assigned from a permutation rather than
 * from the roster order, so the letters cannot be mapped back to slots by a model
 * that has seen a debate prompt from the same run.
 *
 * NOT TOUCHED: a model's own words. The anonymizer relabels the SPEAKER and
 * rewrites nothing inside a `body`, `position` or `concession` — rewriting prose
 * to remove a name that looks like a slot id is exactly the content filtering
 * AD-18's Never clause forbids, and it would silently edit a real argument. The
 * reason that is safe rather than merely principled: nothing ever shows a debater
 * a slot id (`core/stages/debate.ts` labels speakers `participant N`, and its
 * tests assert no slot id and no lens id appears in a debate prompt), so a
 * debater has none to write down.
 *
 * KEPT: the ROLE the debate rules turn on. `authorLabel` says which letter raised
 * the finding, because "a finding dies only when its author withdraws" is a rule
 * the judge has to be able to apply, and a role in an argument is not a model
 * identity. Co-discovery is kept too — by the prompt builder, not here.
 *
 * ## Why RANDOMIZED and not merely relabelled
 *
 * `core/stages/debate.ts` already labels speakers `participant N` in membership
 * order, and `deferred-work.md` records that this is AD-17a hygiene rather than
 * AD-17b anonymization: the labels are stable, so seat order still carries
 * whatever authority membership order carries — the author is always
 * `participant 1`. Relabelling that mapping `A`/`B`/`C` would preserve it exactly.
 * The permutation is the half story 5 deliberately did not do.
 *
 * ## Why deterministic
 *
 * The permutation comes from a seeded PRNG (`./seeded.ts`), not from
 * `Math.random`. Two runs over one input must produce one record — the spine's
 * ordering convention and story 9's ablation both depend on it — and a stage that
 * reached for real randomness would also be untestable, the same reason `Clock`
 * is a port. The seed is the CALLER's (`runId:findingId`), so the order differs
 * per finding within a run, which is what makes it a randomization rather than a
 * rename.
 *
 * PURE, and port-free, on `core/clustering/`'s precedent: no clock, no backend,
 * no ledger. It spends no tokens, so it is the one judge stage the budget never
 * gates.
 */

import type { Finding } from "../domain/finding.ts"
import { listCell, oneLine } from "../prompt/material.ts"
import { seededRandom, shuffled } from "./seeded.ts"

/**
 * `A`…`Z`, then `AA`, `AB`, … — spreadsheet order.
 *
 * Letters rather than numbers because the transcript already numbers ROUNDS, and
 * "round 2, participant 2" puts two unrelated counters one word apart. Unbounded
 * rather than capped at 26 because a room's size is a function of the roster and
 * the cluster; a 27-member room is absurd but must not produce a duplicate label,
 * which would silently merge two debaters into one voice.
 */
export function labelAt(index: number): string {
  let n = index
  let label = ""
  do {
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return label
}

export interface AnonymizedTranscript {
  /**
   * One rendered row per debate-round entry, in the order the rounds happened.
   * Round order is NOT randomized — an argument read out of sequence is a
   * different argument. Only WHO is anonymized.
   */
  rows: string[]
  /**
   * `slot -> label`. Returned so the stage can record the mapping on the run
   * record for a human debugging a verdict, and so tests can assert that no slot
   * id reached a prompt. It is never rendered into a prompt.
   */
  labels: Map<string, string>
  /**
   * The letter that raised the finding, or `undefined` when the author never
   * spoke in the debate — which happens, and the judge must not be told a letter
   * that has no rows behind it.
   */
  authorLabel?: string
  /** No debate rounds at all: a `route: "judge"` finding, or a silent room. */
  empty: boolean
}

/**
 * Anonymize one finding's debate transcript.
 *
 * `seed` is the caller's; pass something that varies per finding within a run
 * (`review()` passes `${runId}:${finding.id}`) so the permutation is a
 * randomization and not a rename.
 */
export function anonymize(finding: Finding, seed: string): AnonymizedTranscript {
  const entries = finding.history.filter(
    (entry) => entry.stage === "debate" && entry.round !== undefined,
  )

  // First-appearance order, then permuted. Collected from the entries rather
  // than from the roster so a slot that never spoke gets no letter at all —
  // there is nothing about it for the judge to weigh, and an unused label
  // implies a participant that was never there.
  const speakers: string[] = []
  for (const entry of entries) {
    if (!speakers.includes(entry.actor)) speakers.push(entry.actor)
  }

  const next = seededRandom(seed)
  const labels = new Map<string, string>()
  shuffled(speakers, next).forEach((slot, index) => {
    labels.set(slot, labelAt(index))
  })

  const rows = entries.map((entry) => {
    // `labels` is built from these same entries, so the fallback is unreachable.
    // It is here because printing `undefined` at a judge would be worse than
    // printing a word that says the record is incomplete.
    const who = labels.get(entry.actor) ?? "an unrecorded participant"
    // EVERY CELL IS ESCAPED, for `core/stages/debate.ts`'s reason exactly: this
    // row is MAD's own frame INSIDE a material span, so a `body` carrying a line
    // break would forge a sibling row — a debate turn nobody took, sitting in a
    // correctly labelled and correctly fenced block. Citations are QUOTED as
    // well, because the list joins on `", "` and a citation may contain it.
    const citations = entry.citations?.map(listCell) ?? []
    const cited = citations.length > 0 ? ` [cites ${citations.join(", ")}]` : ""
    const conceded = entry.concession ? ` (conceded: ${oneLine(entry.concession)})` : ""
    const moved = entry.positionChanged ? ` (moved)` : ""
    const position = oneLine(entry.position ?? "")
    return `- round ${entry.round}, ${who} — ${position}${moved}: ${oneLine(entry.body)}${cited}${conceded}`
  })

  return {
    rows,
    labels,
    authorLabel: labels.get(finding.author),
    empty: entries.length === 0,
  }
}
