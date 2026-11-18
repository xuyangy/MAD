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
 * would therefore say nothing a hash does not already say. The literal, in
 * `material-seal.ts`, is a human statement that a deliberate revision happened; the hashes are the
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
 * It reads the labels, so code that writes the reviewed worktree never loads it.
 * `scripts/materialize-labelled-change.ts` prints the version and material hash
 * from `material-seal.ts`, which holds the version literal and the material
 * serialization this module builds on, and `scripts/lint-dependency-direction.ts`
 * fails CI if the materializer can load `labels.ts` by any chain of imports.
 */

import { SEEDED_DEFECTS } from "./labels.ts"
import { MATERIAL_IDENTITY, canonicalMaterial, sha256 } from "./material-seal.ts"

export { canonicalMaterial }

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
  version: MATERIAL_IDENTITY.version,
  materialHash: MATERIAL_IDENTITY.materialHash,
  labelsHash: sha256(canonicalLabels()),
}
