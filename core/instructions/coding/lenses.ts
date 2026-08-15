/**
 * The coding lens pack (CAP-11, AD-11 amended). Eight personas, each narrowing
 * what ONE discovery slot looks for.
 *
 * The ids are the contract — they are what a caller passes, what a slot id is
 * built from (`discovery-lens-security`), and what a finding carries in
 * `Finding.lens`. They come from the sprint change proposal's lens-pack table
 * (2026-08-14 §4.10) and are not renameable without moving a user-facing
 * surface.
 *
 * ## What a lens may and may not do
 *
 * A lens narrows SEARCH. It does not license a different schema, a different
 * severity bar, or a different idea of what counts as a finding — which is why
 * every lens instruction ends with the generalist's own text verbatim rather
 * than a restatement of it. Each instructs the model to look HARDEST at its
 * dimension, never ONLY at it: a lens that stops reporting an out-of-dimension
 * defect it plainly saw has converted coverage bias into a blind spot, which is
 * the opposite of what CAP-11 buys.
 *
 * AD-17: the lens applies at exactly this one moment. Nothing here is carried
 * into a debate instruction (a), it is stripped by the anonymizer with model
 * identity (b), it claims no lineage (c), it produces no co-discovery prior (d),
 * and it is disclosed in output (e).
 */

import type { InstructionSet } from "../types.ts"
import { CODING_DISCOVERY_GENERALIST } from "./discovery.ts"

export interface Lens {
  /** The id, and the whole contract. Reaches slot ids and output rows. */
  id: string
  /** The readable name. Carries the persona a short id cannot. */
  persona: string
  /** What this lens looks HARDEST at — never the only thing it may report. */
  looksHardestAt: string
}

/**
 * Composes one lens instruction.
 *
 * The generalist's text is appended VERBATIM rather than paraphrased, so the
 * severity scale (AD-10), the locus rules (spine, Locus) and the "an empty list
 * is a valid answer" clause are literally the same contract for a lensed slot as
 * for a pool slot. A paraphrase here would be eight opportunities to drift the
 * one thing every arm of story 9's ablation has to share.
 *
 * Used for shipped lenses AND for the run-time generated fallback, so an
 * unregistered lens gets a weaker persona but never a weaker contract.
 */
export function lensInstructionText(persona: string, looksHardestAt: string): string {
  return `You are ${persona}, reviewing a code change through one lens.

LOOK HARDEST AT: ${looksHardestAt}

That is where your attention goes first, and where you are expected to out-read a generalist reviewer who is covering everything at once. It is NOT a boundary: if you see a concrete defect outside your dimension, report it. Withholding one because it belongs to someone else's lens is a blind spot, not focus.

Your lens narrows what you SEARCH for and changes nothing else. Same severity scale, same locus rules, same bar for what counts as a finding — judge severity exactly as a generalist would, and do not inflate a defect because it happens to land in the dimension you were asked to watch.

${CODING_DISCOVERY_GENERALIST.text}`
}

/**
 * The eight shipped coding lenses, in the proposal's table order.
 *
 * ONLY the `coding` task type is populated. The registry is SHAPED to hold other
 * task types and that shape is not permission (`SPEC.md` non-goals): outside a
 * repo there is no file to open and no test to run, so a domain pack would have
 * no ground truth to fact-check against.
 */
export const CODING_LENSES: readonly Lens[] = [
  {
    id: "security",
    persona: "The Security Sentinel",
    looksHardestAt:
      "injection of every kind, authorization gaps, secret and credential handling, and every path " +
      "untrusted input takes through this change.",
  },
  {
    id: "performance",
    persona: "The Performance Engineer",
    looksHardestAt:
      "complexity regressions, N+1 query and request patterns, and allocation or I/O added to a hot path.",
  },
  {
    id: "maintainability",
    persona: "The Pragmatic Maintainer",
    looksHardestAt:
      "coupling this change adds, and abstraction that will not survive the next change — the code " +
      "someone has to edit in six months, not the code as written today.",
  },
  {
    id: "reliability",
    persona: "The SRE / Reliability Expert",
    looksHardestAt:
      "failure modes, retries, timeouts, and the partial-failure states this change can leave behind " +
      "when one step succeeds and the next does not.",
  },
  {
    id: "tests",
    persona: "The Test Engineer",
    looksHardestAt:
      "what this change leaves untested, and the gap between what a test ASSERTS and what it CLAIMS " +
      "to cover — a test that cannot fail is worse than an absent one.",
  },
  {
    id: "privacy-a11y",
    persona: "The Accessibility & Privacy Auditor",
    looksHardestAt:
      "where personal data flows, sensitive values reaching logs or error messages, and interaction " +
      "this change makes unusable for someone not using it the default way.",
  },
  {
    id: "intent",
    persona: "The Project Manager",
    looksHardestAt:
      "whether this change does what it says it does, and ONLY that — scope it quietly adds, and " +
      "stated behaviour it does not actually deliver.",
  },
  {
    id: "outsider",
    persona: "The Outsider",
    looksHardestAt:
      "unstated assumptions a new contributor would trip on — the context this change requires you " +
      "to already hold, and never says out loud.",
  },
]

/** Shipped lens instruction sets, keyed by lens id. */
export const CODING_LENS_INSTRUCTIONS: ReadonlyMap<string, InstructionSet> = new Map(
  CODING_LENSES.map((lens) => [
    lens.id,
    {
      taskType: "coding",
      role: CODING_DISCOVERY_GENERALIST.role,
      lens: lens.id,
      version: "1",
      origin: "shipped",
      text: lensInstructionText(lens.persona, lens.looksHardestAt),
    } satisfies InstructionSet,
  ]),
)
