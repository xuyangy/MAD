/**
 * Story 2-7b — the SEAL on the eight adversarial cases: a hand-written version
 * and two RECORDED content hashes, one over the material and one over the
 * answer key (`evaluation-protocol.md` §7: 2.7's payload bytes, clean and attack
 * fixtures and case-level assertions are sealed before outcomes are seen).
 *
 * ## Both hashes are literals
 *
 * The `fixtures/cross-arm-pairs/seal.ts` pattern. The seal is read at run time:
 * `ablation/adversarial.ts` refuses to start when the cases it was handed do not
 * hash to these literals, and the schedule records them. A hash computed from
 * the cases at import would equal the cases' hash by construction, so that check
 * could never fail. `seal.test.ts` recomputes both hashes two ways and compares
 * them with the literals.
 *
 * ## `version` is bumped BY HAND
 *
 * A human statement that a deliberate revision happened. A changed case or
 * assertion with no new version and no new literal turns `seal.test.ts` red.
 *
 * ## The canonical serializations
 *
 * `JSON.stringify` over arrays of field-name / value pairs, cases in declaration
 * order (the manifest order the schedule runs them in):
 *
 * - **Material**, per case: `["id", …, "surface", …, "carrier", …, "payload",
 *   …, "baseTree", <[path, contents] pairs sorted by path>, "clean", <change>,
 *   "attack", <change>]`, where a change is `["description", …, "files",
 *   <files in declared order>, "diff", …]`. The files keep their order because
 *   the order is what a model is shown.
 * - **Assertions**: `["rules", <ADVERSARIAL_MATCH_RULES>, "assertions", […]]`,
 *   each assertion `["caseId", …, "target", ["id", …, "dimension", …, "locus",
 *   [file, startLine, endLine], "summary", …, "markers", <sorted>], "blame",
 *   [path, startLine, endLine]]`. An absent line is `null`, never omitted.
 *
 * THIS MODULE READS THE ANSWER KEY, so the worktree writer never imports it.
 */

import { createHash } from "node:crypto"

import { ADVERSARIAL_ASSERTIONS, ADVERSARIAL_MATCH_RULES, type AdversarialAssertion } from "./assertions.ts"
import { ADVERSARIAL_CASES, type AdversarialMaterial } from "./material.ts"

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`
}

function canonicalChange(change: AdversarialMaterial["clean"]): unknown[] {
  return ["description", change.description, "files", [...change.files], "diff", change.diff]
}

/** The material's canonical text. Exported so the test can hash it a second way. */
export function canonicalAdversarialMaterial(cases: readonly AdversarialMaterial[] = ADVERSARIAL_CASES): string {
  return JSON.stringify(
    cases.map((c) => [
      "id",
      c.id,
      "surface",
      c.surface,
      "carrier",
      c.carrier,
      "payload",
      c.payload,
      "baseTree",
      Object.entries(c.baseTree).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      "clean",
      canonicalChange(c.clean),
      "attack",
      canonicalChange(c.attack),
    ]),
  )
}

/** The assertions' canonical text, rules included. */
export function canonicalAdversarialAssertions(
  assertions: readonly AdversarialAssertion[] = ADVERSARIAL_ASSERTIONS,
  rules: readonly string[] = ADVERSARIAL_MATCH_RULES,
): string {
  return JSON.stringify([
    "rules",
    [...rules],
    "assertions",
    assertions.map((a) => [
      "caseId",
      a.caseId,
      "target",
      [
        "id",
        a.target.id,
        "dimension",
        a.target.dimension,
        "locus",
        [a.target.locus.file, a.target.locus.startLine ?? null, a.target.locus.endLine ?? null],
        "summary",
        a.target.summary,
        "markers",
        [...a.target.markers].sort(),
      ],
      "blame",
      [a.blame.path, a.blame.startLine ?? null, a.blame.endLine ?? null],
    ]),
  ])
}

export function adversarialMaterialHashOf(cases: readonly AdversarialMaterial[]): string {
  return sha256(canonicalAdversarialMaterial(cases))
}

export function adversarialAssertionsHashOf(assertions: readonly AdversarialAssertion[]): string {
  return sha256(canonicalAdversarialAssertions(assertions))
}

export interface AdversarialSeal {
  /** Hand-written. Bumped deliberately; never derived from the hashes. */
  version: string
  /** The recorded `sha256:` of `canonicalAdversarialMaterial()`. A literal. */
  materialHash: string
  /** The recorded `sha256:` of `canonicalAdversarialAssertions()`. A literal. */
  assertionsHash: string
}

export const ADVERSARIAL_SEAL: AdversarialSeal = {
  version: "adversarial-cases-3",
  materialHash: "sha256:c91714935d4f934cd37f8a45dbb2c00c04cacc4f3524ed00404aa8833eda29bd",
  assertionsHash: "sha256:5f99afa3e13a0c2b23e3a967f76fab8a5a20f994a76a268c75d140fd8d50bafc",
}

/**
 * Why these cases and assertions are not the sealed ones, naming the hash that
 * differs, or `null` when both hash to the recorded literals and pair up by id
 * in the same order.
 */
export function adversarialSealProblem(
  cases: readonly AdversarialMaterial[],
  assertions: readonly AdversarialAssertion[],
  seal: AdversarialSeal = ADVERSARIAL_SEAL,
): string | null {
  const material = adversarialMaterialHashOf(cases)
  if (material !== seal.materialHash) {
    return `the adversarial material hashes to ${material}, not to the sealed materialHash ${seal.materialHash} (${seal.version})`
  }
  const key = adversarialAssertionsHashOf(assertions)
  if (key !== seal.assertionsHash) {
    return `the adversarial assertions hash to ${key}, not to the sealed assertionsHash ${seal.assertionsHash} (${seal.version})`
  }
  const caseIds = cases.map((c) => c.id).join(",")
  const assertionIds = assertions.map((a) => a.caseId).join(",")
  if (caseIds !== assertionIds) {
    return `the sealed cases (${caseIds}) and assertions (${assertionIds}) do not pair up in order`
  }
  return null
}
