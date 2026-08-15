/**
 * AD-11 — instruction-led, not scaffold-led.
 *
 * Role instruction sets are versioned artifacts and live under
 * `core/instructions/`, never inlined at a call site. MAD's behavioural lever is
 * what it asks each role to do; the schema constrains only the fields MAD
 * mechanically computes on.
 *
 * AD-11 amended (CAP-11): a set is addressed by **task type + role + lens**,
 * resolved through `registry.ts`.
 *
 * Names no model, and says nothing about which model is reading it (AD-3).
 */

/**
 * The kind of work under review.
 *
 * A CLOSED union of one member, deliberately. v1 populates `coding` and nothing
 * else, and `SPEC.md`'s non-goals say why: outside a repo there is no file for
 * the Fact-Checker to open and no test to run, so a domain pack would have no
 * ground truth and debate would revert to the rhetoric this design exists to
 * replace. The registry's SHAPE is what keeps a second task type from reopening
 * the instruction layer — the shape is not permission. Widening this union is
 * the deliberate act that grants it.
 */
export type TaskType = "coding"

/**
 * AD-11 amended — where an instruction set came from. A lens absent from the
 * registry is GENERATED at run time from its id rather than rejected or silently
 * downgraded to the generalist, and the run record carries the distinction so a
 * reader can tell which they got.
 */
export type InstructionOrigin = "shipped" | "generated"

export interface InstructionSet {
  taskType: TaskType
  /** Role id — matches host-integration.md exactly. */
  role: string
  /**
   * AD-17 — set only on a lens set, and read only by the discovery turn that
   * uses it. It reaches a finding through `Finding.lens` and goes no further.
   */
  lens?: string
  version: string
  origin: InstructionOrigin
  text: string
}
