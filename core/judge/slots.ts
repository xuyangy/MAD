/**
 * Which model runs which judge role, for one finding.
 *
 * `host-integration.md` names four wants — `fact-check` cheap and TOOL-CAPABLE,
 * `logic-eval` cheap, `aggregate` mid, and (story 6) `evidence-extract` — but
 * `Roster` holds discovery slots and lens slots and nothing else, and
 * `adapters/opencode/model-backend.ts` THROWS on a slot id the roster never
 * filled. Real judge slots therefore cost a roster shape change, a selection
 * change, an adapter change and a plugin-wiring change; that is the roster work
 * story 8A owns. Until then the roles are assigned across slots the host already
 * gave us, which honours AD-3 (MAD names no model) and AD-13 (capability is READ
 * per slot) without inventing a slot id no backend can resolve.
 *
 * ## The three rules, in priority order
 *
 * 1. **TOOLS OUTRANK EVERYTHING for `fact-check`** (AD-13). A fact-check that
 *    opened no file is not a fact-check, so a tool-capable slot is chosen even
 *    when the only one is the finding's own author. The core refuses to ROUTE
 *    fact-checking to an untooled slot while a tooled one exists; when NONE
 *    exists it still runs, still reports, and the caller warns — it never
 *    refuses the run.
 * 2. **Prefer a NON-AUTHOR.** A model handed its own argument back, anonymized,
 *    is being asked to mark its own work. The anonymizer removes identity from
 *    the transcript but cannot stop a model recognising its own prose.
 * 3. **Spread across the roster**, rotating the start by a hash of the finding
 *    id so one slot does not carry every judge turn in the run, and so two
 *    findings in one run are not judged in lockstep by the same model.
 *
 * ## Why a slot may hold more than one role
 *
 * With three pool slots and one of them the author, two remain for four roles.
 * That is fine and is not a dilution of CAP-5: the decomposition is in the
 * INSTRUCTIONS and the separate turns — "does this cited line say what he
 * claims?" is asked on its own, in its own context, with its own narrow
 * instruction — not in the model behind them. What the decomposition rules out
 * is ONE turn deciding everything, and that never happens here.
 *
 * POOL SLOTS ONLY. Lens slots never judge: they are outside every roster claim
 * by construction (AD-4 amended, AD-17c), and keeping them out means no
 * `discovery-lens-*` id is ever passed to a judge turn at all.
 *
 * PURE. It reads a capability predicate rather than a `ModelBackend`, so it has
 * no port dependency and the caller decides where "can this slot use tools?"
 * comes from.
 */

import type { Finding } from "../domain/finding.ts"
import type { Roster } from "../domain/roster.ts"
import { rotated } from "./seeded.ts"

/**
 * The judge roles, matching `host-integration.md`'s role vocabulary exactly
 * (spine, Consistency Conventions: one name for a role across instructions,
 * ports, config and output).
 *
 * `evidence-extract` is the one this story ADDED to that vocabulary. The table
 * listed five roles and the Evidence Extractor is a model turn like the other
 * three, so the table was short by a row rather than the stage being unnamed;
 * `host-integration.md` carries the dated amendment.
 */
export const JUDGE_ROLES = ["evidence-extract", "fact-check", "logic-eval", "aggregate"] as const
export type JudgeRole = (typeof JUDGE_ROLES)[number]

export interface JudgeSlots {
  /** One slot per role. Slots repeat when the roster is smaller than the role list. */
  byRole: Record<JudgeRole, string>
  /**
   * AD-13 — whether the slot chosen for `fact-check` can actually call tools.
   *
   * `false` is a DEGRADATION the caller must report (AD-6): the check still runs,
   * because refusing the run is what AD-13 forbids, but nothing it produces may
   * be presented as verified.
   */
  factCheckTooled: boolean
}

export interface AssignJudgeSlotsInput {
  roster: Roster
  /** AD-6a/AD-6b — the slots that ANSWERED discovery. A dead model judges nothing. */
  answeredSlots: readonly string[]
  /** AD-13 — read from the backend per slot, never declared by MAD. */
  hasTools: (slot: string) => boolean
  finding: Finding
}

/**
 * Assign the four roles for one finding.
 *
 * Returns `undefined` when NO pool slot answered — there is no model to judge
 * with, which is a degradation the caller reports rather than an error. It is
 * reachable: a run whose entire pool dropped out still has findings if lens slots
 * answered.
 */
export function assignJudgeSlots(input: AssignJudgeSlotsInput): JudgeSlots | undefined {
  const { roster, answeredSlots, hasTools, finding } = input
  const answered = new Set(answeredSlots)

  const eligible = roster.slots.map((slot) => slot.slot).filter((slot) => answered.has(slot))
  if (eligible.length === 0) return undefined

  // Rule 3 — rotate by the finding, so the run's judge turns spread over the
  // roster instead of piling onto whichever slot happens to be first.
  const spread = rotated(eligible, finding.id)

  // Rule 2 — non-authors first, the author last rather than excluded. Excluding
  // it would leave a single-slot roster with nothing to judge with, and a model
  // marking its own work is worse than nothing only when there IS an alternative.
  const preferred = [
    ...spread.filter((slot) => slot !== finding.author),
    ...spread.filter((slot) => slot === finding.author),
  ]
  // Non-authors alone, when any exist: the three non-fact-check roles cycle over
  // these, so a two-slot roster never hands the author its own argument to
  // logic-evaluate.
  const nonAuthors = preferred.filter((slot) => slot !== finding.author)
  const cycle = nonAuthors.length > 0 ? nonAuthors : preferred

  // Rule 1 — tools outrank both other rules. Searched over `preferred` first so a
  // tooled non-author wins over a tooled author, then over the whole eligible
  // list, because AD-13's requirement is not negotiable against a preference.
  const factCheck =
    cycle.find((slot) => hasTools(slot)) ?? preferred.find((slot) => hasTools(slot)) ?? cycle[0]!
  const factCheckTooled = hasTools(factCheck)

  // The remaining three cycle from just after the fact-checker, so a roster with
  // four usable slots gives four distinct models and a smaller one repeats in a
  // predictable order rather than collapsing onto one slot.
  const start = cycle.indexOf(factCheck)
  const at = (offset: number): string => cycle[(Math.max(start, 0) + offset) % cycle.length]!

  return {
    byRole: {
      "evidence-extract": at(1),
      "fact-check": factCheck,
      "logic-eval": at(2),
      aggregate: at(3),
    },
    factCheckTooled,
  }
}
