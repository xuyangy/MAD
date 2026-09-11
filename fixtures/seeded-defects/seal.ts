/**
 * The SEAL on the labelled change: one hand-written version, and two content
 * hashes derived from the bytes.
 *
 * `evaluation-protocol.md:465` gives story 2.4 the fixture construction, the
 * label-file schema and the validation checks, and attaches one condition to all
 * of it: **sealed with content hashes before 2.4's first live run**.
 * `evaluation-protocol.md:73-79` says why — the change and the known true-defect
 * reference set are identified by *immutable content hashes*, fixed before any
 * relevant live outcome is observed. This module is that identity, and
 * `seal.test.ts` is what stops it drifting.
 *
 * FR1 wants it in the manifest of every run that reviews this set (story 2.4's
 * AC4). `scripts/ablation.ts --labelled-change` fills `fixtureVersion` and
 * `fixtureHash` from here, so the operator never types the identity from memory
 * and no second authority on it exists.
 *
 * ## `version` is bumped BY HAND, never derived
 *
 * A version derived from the hashes would move silently with every edit and
 * would therefore say nothing a hash does not already say. This literal is a
 * human statement that a deliberate revision happened; the hashes are the
 * machine check that nothing else did. Changing the material or the labels
 * without bumping it turns `seal.test.ts` red, which is the point.
 *
 * ## The canonical serializations, stated so they can be reproduced
 *
 * Both are `JSON.stringify` over an ARRAY of field-name / value pairs, so the
 * encoding is stable under any source reformatting — indentation, line wrapping
 * and comment edits move no byte of it — and the field names are inside the
 * hashed text, so two different shapes can never collide.
 *
 * - **Material** — `["description", <description>, "files", <files sorted>,
 *   "diff", <diff>, "baseTree", <BASE_TREE entries as [path, contents] pairs,
 *   sorted by path>]`. `files` is sorted because the manifest's own `changeId`
 *   already records the declaration order; what this hash answers is "are these
 *   the same bytes", and a reordered file list is the same bytes. `BASE_TREE` is
 *   INSIDE the seal, and that is load-bearing rather than thorough: it is what
 *   `scripts/materialize-labelled-change.ts` writes to disk and commits before
 *   the diff is applied, so it is part of the bytes a model opens in the reviewed
 *   worktree. Left outside, an edit to a base file would change what the models
 *   see without moving `materialHash` and without reddening `seal.test.ts` — a
 *   fixture identity that no longer identifies the fixture. Its entries are
 *   sorted by path for the same reason `files` is: the map's insertion order is
 *   not part of what was reviewed.
 * - **Labels** — one entry per defect IN DECLARATION ORDER (the order
 *   `fixtures/recall.ts` assigns findings in, so it is load-bearing and a
 *   reordering must change the hash), each
 *   `["id", …, "dimension", …, "locus", [file, startLine, endLine], "summary",
 *   …, "markers", <markers sorted>]`. A missing line number is `null`, never
 *   omitted, so an absent locus line cannot serialize to the same text as a
 *   present one.
 *
 * `createHash("sha256")` and the `sha256:` prefix are the same primitive and the
 * same shape `ablation/manifest.ts:468-474` already uses for `changeId.diffHash`,
 * so an operator comparing a fixture hash against a change hash is comparing two
 * things written the same way.
 *
 * ## This module is NOT importable from the materializer path
 *
 * It reads the labels, so it can never be reached by code that writes the
 * reviewed worktree... except that `scripts/materialize-labelled-change.ts` DOES
 * import it, to print the identity. That is safe and it is not an accident:
 * `LABELLED_CHANGE_SEAL` is three strings — a version and two hex digests — and a
 * digest reveals nothing about the summaries it was computed over. What the
 * materializer must never do is re-export, print or write anything else this
 * module touched, and its leak test asserts exactly that over the files it wrote.
 */

import { createHash } from "node:crypto"

import { SEEDED_DEFECTS } from "./labels.ts"
import { BASE_TREE, SEEDED_CHANGE } from "./material.ts"

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`
}

/** The material's canonical text. Exported so the test can hash it a second way. */
export function canonicalMaterial(): string {
  return JSON.stringify([
    "description",
    SEEDED_CHANGE.description,
    "files",
    [...SEEDED_CHANGE.files].sort(),
    "diff",
    SEEDED_CHANGE.diff,
    // THE BASE TREE IS INSIDE THE SEAL. It is written to the reviewed worktree
    // and committed there, so editing it changes the bytes the models see; a
    // hash that did not cover it would let that happen with CI green.
    "baseTree",
    Object.entries(BASE_TREE).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ])
}

/** The labels' canonical text, in declaration order. */
export function canonicalLabels(): string {
  return JSON.stringify(
    SEEDED_DEFECTS.map((defect) => [
      "id",
      defect.id,
      "dimension",
      defect.dimension,
      "locus",
      [defect.locus.file, defect.locus.startLine ?? null, defect.locus.endLine ?? null],
      "summary",
      defect.summary,
      "markers",
      [...defect.markers].sort(),
    ]),
  )
}

export interface LabelledChangeSeal {
  /** Hand-written. Bumped deliberately; never derived from the hashes. */
  version: string
  /** `sha256:<hex>` over `canonicalMaterial()`. */
  materialHash: string
  /** `sha256:<hex>` over `canonicalLabels()`. */
  labelsHash: string
}

export const LABELLED_CHANGE_SEAL: LabelledChangeSeal = {
  version: "labelled-change-1",
  materialHash: sha256(canonicalMaterial()),
  labelsHash: sha256(canonicalLabels()),
}
