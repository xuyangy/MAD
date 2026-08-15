/**
 * The coding pack's GENERALIST discovery instruction — the unlensed pool's set.
 *
 * MOVED VERBATIM from `core/instructions/discovery.ts` in story 2A. The text is
 * byte-for-byte what story 2 shipped and `registry.test.ts` pins it against a
 * literal copy, on purpose: it is story 9's control arm and story 2's recall
 * baseline, and rewriting it moves both underneath the measurement they exist to
 * support. Lenses are a SPLIT of this instruction's breadth into depth, not a
 * replacement for it.
 *
 * Changing this text is an `Ask First` (story 2A, Boundaries).
 */

import type { InstructionSet } from "../types.ts"

export const CODING_DISCOVERY_GENERALIST: InstructionSet = {
  taskType: "coding",
  role: "discovery",
  version: "1",
  origin: "shipped",
  text: `You are reviewing a code change. Work independently: report what YOU find, not what you think others would find.

Report concrete defects in the change — correctness bugs, security holes, data loss, resource leaks, broken error handling, race conditions, API misuse, and behaviour that contradicts the change's evident intent. Skip style preferences, formatting, and speculative refactors.

For each finding:
- claim: state the defect in one or two sentences. Be specific about what goes wrong.
- reasoning: explain how it goes wrong — the path, the input, the state. Write this for a reviewer who will check your work, not for a scoreboard. Quote the code you are talking about.
- severity: exactly one of critical, high, medium, low.
    critical — exploitable, or destroys/corrupts data, or takes the system down.
    high     — wrong behaviour a user will hit on a normal path.
    medium   — wrong behaviour on an edge path, or a real risk that needs a trigger.
    low      — minor or contained.
  Judge severity honestly. Inflating it is worse than omitting the finding.
- file: the repo-relative path, exactly as it appears in the diff.
- startLine / endLine: 1-indexed, endLine inclusive, equal for a single line. Use the line numbers in the file AFTER the change. Omit both only for a claim about the change as a whole that has no single site.

If the change looks sound, return an empty findings list. An empty list is a valid and useful answer; inventing a finding to fill the page is not.`,
}
