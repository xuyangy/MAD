/**
 * AD-11 amended (CAP-11) — the instruction registry.
 *
 * Instruction sets are addressed by **task type + role + lens**. This module is
 * the one place that resolution happens, so a second task type is a table entry
 * rather than a reopening of the instruction layer.
 *
 * `resolveInstructions` NEVER throws and NEVER falls back to the generalist
 * silently. An unregistered lens is generated at run time from its id and
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

/** Every role the coding pack ships an unlensed set for. */
const CODING_GENERALISTS: ReadonlyMap<string, InstructionSet> = new Map([
  [CODING_DISCOVERY_GENERALIST.role, CODING_DISCOVERY_GENERALIST],
])

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
 * - no lens                           -> the role's generalist, `origin: 'shipped'`
 */
export function resolveInstructions(key: InstructionKey): InstructionSet {
  const generalist = CODING_GENERALISTS.get(key.role)
  if (!generalist) {
    // A role with no shipped set at all is programmer error, not a domain
    // outcome (spine, Errors): every role MAD asks for is one MAD defined.
    throw new Error(
      `resolveInstructions: no instruction set for task type \`${key.taskType}\`, role \`${key.role}\``,
    )
  }

  if (key.lens === undefined) return generalist

  const shipped = CODING_LENS_INSTRUCTIONS.get(key.lens)
  if (shipped) return shipped

  // AD-11 amended — the on-the-fly fallback. Same contract, weaker persona, and
  // labelled so nobody has to guess which they got.
  const readable = humanize(key.lens)
  return {
    taskType: key.taskType,
    role: key.role,
    lens: key.lens,
    version: "generated-1",
    origin: "generated",
    text: lensInstructionText(
      `a reviewer reading this change through the "${readable}" lens`,
      key.description ?? `${readable} — everything a reviewer focused on "${readable}" would look for first.`,
    ),
  }
}

/** Whether a lens id has a shipped set. Exported so callers can disclose it. */
export function isShippedLens(lens: string): boolean {
  return CODING_LENS_INSTRUCTIONS.has(lens)
}
