/**
 * The seeded-defect change, in one import — split in two behind it.
 *
 * This is CAP-1's measuring stick. Without it the criterion — "pooled recall
 * exceeds any single participating model's" — is a claim no test can make.
 *
 * ## Story 2.4 split this module and left this file as the door
 *
 * The diff and the thirteen labels used to live here together, so nothing could
 * import the change under review without also importing the answer key. AC2 —
 * "ground truth is withheld from every model-accessible input and tool" — had no
 * structural expression at all. It does now:
 *
 * - `material.ts` — the diff, the file list, and the base tree it applies to. It
 *   imports nothing from the label side, and that is the whole point.
 * - `labels.ts` — the thirteen `SeededDefect` rows. The answer key.
 * - `seal.ts` — the version and the two content hashes that identify both in a
 *   run manifest (FR1).
 *
 * This file re-exports both so every existing importer is untouched, and it is
 * the RIGHT import for anything that legitimately needs both — the CI recall
 * harness, the scripted ablation, the clustering pair fixtures. Code that writes
 * a worktree a model will read must import `material.ts` DIRECTLY, never this
 * file: a re-export door reaches the labels, and reaching them is the failure.
 */

export { BASE_TREE, SEEDED_CHANGE } from "./material.ts"
export { SEEDED_DEFECTS } from "./labels.ts"
