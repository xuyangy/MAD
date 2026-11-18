/**
 * The labelled change's version and material hash, without the labels.
 *
 * `scripts/materialize-labelled-change.ts` writes the worktree the models review
 * and prints the identity an operator checks against the manifest. It may not
 * load `labels.ts` at all (story 2.4's AC2, enforced by
 * `scripts/lint-dependency-direction.ts`), so it takes the identity from here.
 * This module imports `material.ts` and nothing else from the fixture.
 *
 * `seal.ts` builds `LABELLED_CHANGE_SEAL` from these two values and adds the
 * labels hash, so there is one version literal and one material serialization.
 * `seal.ts` documents both serializations and why the version is bumped by hand.
 */

import { createHash } from "node:crypto"

import { BASE_TREE, SEEDED_CHANGE } from "./material.ts"

/** `sha256:<hex>` over the UTF-8 bytes of `text`. */
export function sha256(text: string): string {
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

export interface MaterialIdentity {
  /** Hand-written. Bumped deliberately; never derived from the hashes. */
  version: string
  /** `sha256:<hex>` over `canonicalMaterial()`. */
  materialHash: string
}

export const MATERIAL_IDENTITY: MaterialIdentity = {
  version: "labelled-change-1",
  materialHash: sha256(canonicalMaterial()),
}
