/**
 * The SEAL on the cross-arm case set: a hand-written version, a content hash of
 * the cases, and the recorded hash of the diff the cases were drawn from.
 *
 * It follows `fixtures/seeded-defects/seal.ts` in spirit, and for the same
 * reason: a set identified only by its name recomputes happily over whatever the
 * file now says. An edit to a claim, a locus, a label or a `why` without a
 * version bump turns `seal.test.ts` red.
 *
 * ## `datasetHash` is RECORDED, not recomputed
 *
 * Unlike the seeded-defect seal, both hashes here are literals. The seal is read
 * at run time: `ablation/cross-arm-rates.ts` names a measurement `unsealed`
 * unless the cases it scored hash to `datasetHash`, and refuses to put an unsealed
 * measurement in a report. A `datasetHash` computed from `CROSS_ARM_CASES` at
 * import would equal the cases' hash by construction, so that check could never
 * fail and an edited set would still print under the sealed version.
 * `seal.test.ts` recomputes the hash from the canonical text and compares it with
 * this literal.
 *
 * ## `version` is bumped BY HAND, never derived
 *
 * A version derived from the hash moves with every edit and says nothing the
 * hash does not. This literal is a human statement that a deliberate revision
 * happened; the hash is the machine check that nothing else did.
 *
 * ## `sourceDiffHash` is RECORDED, not recomputed
 *
 * It is the `sha256:` of `SEEDED_CHANGE.diff` as it stood when the cases were
 * labelled — the same value `changeIdFor` (`ablation/manifest.ts`) writes into a
 * manifest's `changeId.diffHash`. It is a literal on purpose. The cases cite
 * that diff's files and post-change lines; if the diff moves, the cases no longer
 * describe the change being reviewed, and a recomputed hash would follow the edit
 * and keep printing the rates beside a change they were never measured on. A
 * literal stops matching instead, so the report falls back to the UNMEASURED
 * disclosure, and `seal.test.ts` turns red until someone relabels.
 *
 * ## The canonical serialization, stated so it can be reproduced
 *
 * `JSON.stringify` over an ARRAY with one entry per case IN DECLARATION ORDER
 * (the order `bun run cross-arm-rates` prints, so a reordering changes the
 * hash). Each case is
 *
 *   `["id", …, "label", …, "armA", [<finding>…], "armB", [<finding>…],
 *     "subjectA", …, "subjectB", <id or null>, "why", …]`
 *
 * and each finding, in its arm's order, is
 *
 *   `["id", …, "claim", …, "reasoning", …, "locus", [file, startLine, endLine],
 *     "severity", …, "author", …, "source", …, "lens", <lens or null>,
 *     "history", <history>]`.
 *
 * Absent values are `null`, never omitted, so an absent line cannot serialize to
 * the same text as a present one. Field names sit inside the hashed text, so two
 * shapes cannot collide, and source formatting and comments move no byte of it.
 * `seal.test.ts` also checks that no finding carries a field outside that list,
 * so a field added to a case cannot sit outside the hash.
 */

import { createHash } from "node:crypto"

import type { Finding } from "../../core/domain/finding.ts"
import { CROSS_ARM_CASES, type CrossArmCase } from "./cases.ts"

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`
}

/** The finding fields the canonical text covers. */
export const CANONICAL_FINDING_FIELDS = [
  "id",
  "claim",
  "reasoning",
  "locus",
  "severity",
  "author",
  "source",
  "lens",
  "history",
] as const

function canonicalFinding(finding: Finding): unknown[] {
  return [
    "id",
    finding.id,
    "claim",
    finding.claim,
    "reasoning",
    finding.reasoning,
    "locus",
    [finding.locus.file, finding.locus.startLine ?? null, finding.locus.endLine ?? null],
    "severity",
    finding.severity,
    "author",
    finding.author,
    "source",
    finding.source,
    "lens",
    finding.lens ?? null,
    "history",
    finding.history,
  ]
}

/** The cases' canonical text. Exported so the test can hash it a second way. */
export function canonicalCases(cases: readonly CrossArmCase[] = CROSS_ARM_CASES): string {
  return JSON.stringify(
    cases.map((c) => [
      "id",
      c.id,
      "label",
      c.label,
      "armA",
      c.armA.map(canonicalFinding),
      "armB",
      c.armB.map(canonicalFinding),
      "subjectA",
      c.subjectA,
      "subjectB",
      c.subjectB ?? null,
      "why",
      c.why,
    ]),
  )
}

/** `sha256:<hex>` over `canonicalCases(cases)`. */
export function datasetHashOf(cases: readonly CrossArmCase[]): string {
  return sha256(canonicalCases(cases))
}

export interface CrossArmPairsSeal {
  /** Hand-written. Bumped deliberately; never derived from the hash. */
  version: string
  /** The recorded `sha256:<hex>` of `canonicalCases()` at sealing. A literal. */
  datasetHash: string
  /** The recorded `changeId.diffHash` of the change the cases cite. A literal. */
  sourceDiffHash: string
}

export const CROSS_ARM_PAIRS_SEAL: CrossArmPairsSeal = {
  version: "cross-arm-pairs-1",
  datasetHash: "sha256:9d07db2dcd532642290f41c7d1ca38a2592caaa9fc7ad5c27873b1665e503786",
  sourceDiffHash: "sha256:cea5679939f5cb4ccd90230a4eddde861119f375ced04cad474fc2b0ec57e213",
}
