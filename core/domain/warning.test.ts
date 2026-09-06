/**
 * AD-6's VOCABULARY, pinned where it lives.
 *
 * The codes were a bare type union until story 7, so nothing could count them —
 * and a code added to the union reached `core/stages/output.ts`'s
 * disclosure-versus-degradation split with no reader ever having decided which
 * side it belonged on. `core/prompt/material.test.ts` pins its label count for
 * exactly that reason; this is the same guard over the same class of vocabulary.
 */

import { describe, expect, test } from "bun:test"

import { DISCLOSURE_CODES, WARNING_CODES, type WarningCode } from "./warning.ts"

describe("the warning vocabulary (AD-6)", () => {
  test("THE COUNT IS PINNED, so a new code forces somebody to classify it", () => {
    // Thirteen: four roster reports, the drop-out, the denominator, the partial
    // envelope, the provider disclosure, the unresolved section, the untooled
    // fact-check, the unavailable judge, from story 7A the cancelled run, and
    // from story 8 the budget-truncated discovery, and from story 8A the pin the
    // run could not honour, and from the epic-1 retrospective the dial the run
    // did not honour as asked. Adding a sixteenth is a deliberate act: AD-6's
    // report set is an `Ask First` that three stories declined before 7A
    // answered it, so it should not be possible to do it quietly.
    //
    // THIS ASSERTION DID ITS JOB (2026-09-06). `dial-clamped` was added and the
    // suite failed here, on exactly this line, forcing the classification below
    // rather than letting a new code reach the renderer's disclosure/degradation
    // split with nobody deciding which side it belonged on.
    expect(WARNING_CODES).toHaveLength(15)
  })

  test("`dial-clamped` IS A DEGRADATION, not a disclosure (epic-1 retrospective)", () => {
    // The classification the count pin above forced. A clamped dial is not a
    // fact about how the run was configured — it is a run held to a value its
    // caller did not ask for, and every number it reports is a number about
    // THAT run. Unlisted is degradation, which is the safe default, and this
    // asserts the default was the intended answer rather than an oversight.
    expect(WARNING_CODES).toContain("dial-clamped")
    expect(DISCLOSURE_CODES.has("dial-clamped")).toBe(false)
  })

  test("every code is unique", () => {
    expect(new Set(WARNING_CODES).size).toBe(WARNING_CODES.length)
  })

  test("DEGRADATION IS THE DEFAULT — only a LISTED code is a disclosure", () => {
    // The safe direction, and the reason the set is a membership test rather
    // than a denylist: over-reporting a degradation is noise, under-reporting
    // one is the failure AD-6 exists to prevent.
    expect([...DISCLOSURE_CODES]).toEqual(["provider-fan-out"])
    const degradations = WARNING_CODES.filter((code) => !DISCLOSURE_CODES.has(code))
    expect(degradations).toHaveLength(WARNING_CODES.length - 1)
    expect(degradations).not.toContain("provider-fan-out")
  })

  test("no disclosure code is missing from the vocabulary", () => {
    // The two are declared separately, so this is what stops a disclosure being
    // listed for a code the union no longer carries.
    for (const code of DISCLOSURE_CODES) {
      expect(WARNING_CODES as readonly WarningCode[]).toContain(code)
    }
  })

  test("ALL SIX AD-6 clauses have a code (story 7A completed the set)", () => {
    // (a) denominator, (b) drop-out, (c) roster, (d) unresolved, (e) lens
    // homogeneity, (f) cancelled. Until story 7A the last one deliberately had
    // NO code, because nothing raised it; this assertion was inverted then and
    // is inverted here, on purpose, so the change is visible in the diff rather
    // than absorbed by deleting a line.
    expect(WARNING_CODES).toContain("denominator-reduced")
    expect(WARNING_CODES).toContain("model-dropped-out")
    expect(WARNING_CODES).toContain("roster-single-lineage")
    expect(WARNING_CODES).toContain("unresolved-findings")
    expect(WARNING_CODES).toContain("roster-lens-homogeneous")
    expect(WARNING_CODES).toContain("run-cancelled")
  })

  test("AD-6f IS A DEGRADATION, NOT A DISCLOSURE", () => {
    // A stopped run is a PARTIAL run, which is what AD-6 governs — the reader
    // must be told the review is worth less than it looks, not merely informed
    // of a configuration fact the way `provider-fan-out` informs them.
    expect(DISCLOSURE_CODES.has("run-cancelled")).toBe(false)
  })
})
