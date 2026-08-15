/**
 * AD-11 amended (CAP-11) — the instruction registry.
 *
 * Instruction sets are addressed by **task type + role + lens**. This module is
 * the one place that resolution happens, so a second task type is a table entry
 * rather than a reopening of the instruction layer.
 *
 * `resolveInstructions` never throws ON A LENS and NEVER falls back to the
 * generalist silently. (It DOES throw on a (task type, role) pair that ships no
 * set at all — that is programmer error rather than a domain outcome, spine
 * Errors, and the throw site says so. Clarified after a code review read the
 * flat "never throws" against the `throw` twenty lines below it, 2026-08-15.)
 * An unregistered lens is generated at run time from its id and
 * returned with `origin: 'generated'`; the run record carries that distinction
 * to output so a reader can tell a shipped instruction from a made-up one. A
 * silent generalist fallback would be the worst of the three outcomes: the run
 * would cost a lens turn, claim a lens in output, and have asked for nothing.
 *
 * Only the `coding` task type is populated. `TaskType` is a closed union of one
 * member for that reason, and the reason is in `types.ts`: the shape is not
 * permission (`SPEC.md` non-goals).
 */

import { CODING_DISCOVERY_GENERALIST } from "./coding/discovery.ts"
import { CODING_LENS_INSTRUCTIONS, lensInstructionText } from "./coding/lenses.ts"
import type { InstructionSet, TaskType } from "./types.ts"

export interface InstructionKey {
  taskType: TaskType
  /** Role id — matches host-integration.md exactly, e.g. `discovery`. */
  role: string
  /** Absent for the unlensed generalist. */
  lens?: string
  /**
   * Optional prose about an UNREGISTERED lens, used only by the generated
   * fallback (AD-11: "generated at run time from its name and description").
   * A registered lens ignores it — the shipped set is the shipped set.
   */
  description?: string
}

/**
 * The registry key, spelled out: **task type + role**, and + lens for a lens set.
 *
 * Keying on role alone was the shape AD-11's amendment describes and the code
 * did not have (code review 2026-08-15). It cost nothing today — `TaskType` is a
 * closed union of one — but "a second task type is a table entry rather than a
 * reopening of the instruction layer" was not true of a map with no task-type
 * dimension in it.
 */
function keyOf(taskType: TaskType, role: string, lens?: string): string {
  return lens === undefined ? `${taskType}\0${role}` : `${taskType}\0${role}\0${lens}`
}

/** Every (task type, role) the shipped packs have an unlensed set for. */
const GENERALISTS: ReadonlyMap<string, InstructionSet> = new Map([
  [
    keyOf(CODING_DISCOVERY_GENERALIST.taskType, CODING_DISCOVERY_GENERALIST.role),
    CODING_DISCOVERY_GENERALIST,
  ],
])

/**
 * Every shipped lens set, keyed by task type + role + LENS.
 *
 * The role is in the key and that is the point (code review 2026-08-15). Keyed
 * by lens id alone, `resolveInstructions({role: 'debate', lens: 'security'})`
 * returned the DISCOVERY lens instruction — a set whose own `role` field says
 * `discovery` — the moment any second role registered a generalist. That is
 * AD-17(a)'s leak ("it is NOT included in the debate instruction") arriving
 * through the registry, in story 5, silently. A lens set is reachable only from
 * the role it was written for.
 */
const LENS_SETS: ReadonlyMap<string, InstructionSet> = new Map(
  [...CODING_LENS_INSTRUCTIONS.values()].map((set) => [
    keyOf(set.taskType, set.role, set.lens!),
    set,
  ]),
)

/**
 * `threat-model` -> `threat model`. The generated persona is deliberately thin:
 * an id is all an unregistered lens gave us, and dressing it up as though a
 * human wrote it would make `origin: 'generated'` the only way to tell — which
 * is exactly the ambiguity AD-11's amendment exists to remove.
 */
function humanize(lens: string): string {
  return lens.replaceAll(/[-_]+/g, " ").trim()
}

/**
 * Resolve one instruction set.
 *
 * - registered (taskType, role, lens) -> the shipped set, `origin: 'shipped'`
 * - unregistered lens                 -> generated from the id, `origin: 'generated'`
 * - no lens, or a blank/whitespace id -> the role's generalist, `origin: 'shipped'`
 */
export function resolveInstructions(key: InstructionKey): InstructionSet {
  const generalist = GENERALISTS.get(keyOf(key.taskType, key.role))
  if (!generalist) {
    // A role with no shipped set at all is programmer error, not a domain
    // outcome (spine, Errors): every role MAD asks for is one MAD defined.
    throw new Error(
      `resolveInstructions: no instruction set for task type \`${key.taskType}\`, role \`${key.role}\``,
    )
  }

  // A BLANK lens id is no lens, not a lens named "" (code review 2026-08-15).
  // The only thing enforcing a non-empty id was `clampLenses` in the opencode
  // adapter, so a core-level caller — story 9's ablation arms build rosters
  // without going through the tool — could reach the generated fallback with
  // `""` and bill a turn on `a reviewer reading this change through the "" lens`.
  // `fillLensSlots` does not filter blanks either. Normalized here, where the
  // decision belongs, so every entry point reads the same answer. Trimmed for
  // the same reason `clampLenses` trims: `" "` is the same non-request as `""`.
  const lens = key.lens?.trim()
  if (lens === undefined || lens.length === 0) return generalist

  // Task type + role + lens. A lens set written for `discovery` is not reachable
  // from any other role (AD-17a) — an unregistered (role, lens) pair falls
  // through to the generated set below rather than borrowing another role's.
  const shipped = LENS_SETS.get(keyOf(key.taskType, key.role, lens))
  if (shipped) return shipped

  // AD-11 amended — the on-the-fly fallback. Same contract, weaker persona, and
  // labelled so nobody has to guess which they got.
  //
  // `humanize` can empty a degenerate id (`"---"` -> `""`), which produced
  // `through the "" lens` on a billed turn (code review 2026-08-15). The raw id
  // is non-empty here — the blank guard above is what makes that true, rather
  // than an assumption about callers — so it is the honest fallback: a reader
  // sees exactly what was asked for.
  const readable = humanize(lens) || lens
  return {
    taskType: key.taskType,
    role: key.role,
    lens,
    version: "generated-1",
    origin: "generated",
    text: lensInstructionText(
      `a reviewer reading this change through the "${readable}" lens`,
      key.description ?? `${readable} — everything a reviewer focused on "${readable}" would look for first.`,
    ),
  }
}

/**
 * Whether a lens id has a shipped set for a (task type, role). Exported so
 * callers can disclose it. Defaults to the one pair v1 populates, so existing
 * callers read the same answer they always did.
 *
 * Trims for the same reason `resolveInstructions` does: a disclosure that
 * disagrees with the set actually resolved is worse than no disclosure. A blank
 * id is `false` here and the GENERALIST there — both honest, because a blank
 * asks for no lens and there is no shipped LENS set for one.
 */
export function isShippedLens(lens: string, taskType: TaskType = "coding", role = "discovery"): boolean {
  return LENS_SETS.has(keyOf(taskType, role, lens.trim()))
}
