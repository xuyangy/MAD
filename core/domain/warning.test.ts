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
    // Eighteen: four roster reports, the drop-out, the denominator, the partial
    // envelope, the provider disclosure, the unresolved section, the untooled
    // fact-check, the unavailable judge, from story 7A the cancelled run, and
    // from story 8 the budget-truncated discovery, and from story 8A the pin the
    // run could not honour, and from the epic-1 retrospective the dial the run
    // did not honour as asked, and from story 10 the `git blame` MAD tried to
    // run itself and could not, and from story 2.3 the unquantified token
    // column and the session MAD could not delete. Adding a nineteenth is a
    // deliberate act: AD-6's report set is an `Ask First` that three stories
    // declined before 7A answered it, so it should not be possible to do it
    // quietly.
    //
    // THIS ASSERTION DID ITS JOB (2026-09-06). `dial-clamped` was added and the
    // suite failed here, on exactly this line, forcing the classification below
    // rather than letting a new code reach the renderer's disclosure/degradation
    // split with nobody deciding which side it belonged on. IT DID IT AGAIN
    // (2026-09-10, story 2.3): the two codes below arrived together and land on
    // OPPOSITE sides of the split, which is precisely the decision a count pin
    // exists to force somebody to make out loud.
    expect(WARNING_CODES).toHaveLength(18)
  })

  test("`usage-unquantified` IS A DEGRADATION, not a disclosure (story 2.3)", () => {
    // The classification the count pin above forced, and the whole point of the
    // story that added it. A run whose token column cannot be trusted is worth
    // LESS THAN IT LOOKS — the reader is being shown a number that is a floor
    // presented in the position a total occupies — and "worth less than it
    // looks" is the exact thing AD-6 governs. Filing it as a disclosure would
    // put the one dishonest number in the run under a heading that says the run
    // is fine, which is AD-6's honesty rule pointed the wrong way.
    //
    // Unlisted is degradation, which is the safe default, and this asserts the
    // default was the INTENDED answer here rather than an oversight.
    expect(WARNING_CODES).toContain("usage-unquantified")
    expect(DISCLOSURE_CODES.has("usage-unquantified")).toBe(false)
  })

  test("`session-cleanup-unresolved` IS A DISCLOSURE, not a degradation (story 2.3)", () => {
    // The other half of the same forced decision, and it goes the other way.
    // `adapters/opencode/model-backend.ts` has recorded this judgement in prose
    // since story 1 — "a session we cannot delete is untidy, not a failure of
    // the review" — and nothing about an orphaned session changes which
    // findings were raised, argued or judged. Calling it a degradation would
    // teach the reader that the degradation block contains housekeeping, which
    // is the one outcome AD-6 cannot afford.
    //
    // It is the SECOND member of the set, and the first since story 7 — which
    // is why the `toEqual` below is written out in full rather than as a
    // membership test.
    expect(WARNING_CODES).toContain("session-cleanup-unresolved")
    expect(DISCLOSURE_CODES.has("session-cleanup-unresolved")).toBe(true)
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

  test("`blame-unavailable` IS A DEGRADATION, not a disclosure (story 10)", () => {
    // The classification the count pin above forced, and the one that matters
    // most for this particular code: a blame MAD could not run leaves the run
    // short of the one class of evidence MAD executes itself, and every verdict
    // downstream was reached without it. Unlisted is degradation, which is the
    // safe default, and this asserts the default was the intended answer.
    expect(WARNING_CODES).toContain("blame-unavailable")
    expect(DISCLOSURE_CODES.has("blame-unavailable")).toBe(false)
  })

  test("every code is unique", () => {
    expect(new Set(WARNING_CODES).size).toBe(WARNING_CODES.length)
  })

  test("DEGRADATION IS THE DEFAULT — only a LISTED code is a disclosure", () => {
    // The safe direction, and the reason the set is a membership test rather
    // than a denylist: over-reporting a degradation is noise, under-reporting
    // one is the failure AD-6 exists to prevent.
    //
    // THE LIST IS WRITTEN OUT, NOT COUNTED (story 2.3). `session-cleanup-
    // unresolved` is the second disclosure ever added, and a test that only
    // counted the set would have accepted it in the degradation bucket while
    // still passing — which is the failure this whole file exists to catch.
    expect([...DISCLOSURE_CODES]).toEqual(["provider-fan-out", "session-cleanup-unresolved"])
    const degradations = WARNING_CODES.filter((code) => !DISCLOSURE_CODES.has(code))
    expect(degradations).toHaveLength(WARNING_CODES.length - DISCLOSURE_CODES.size)
    expect(degradations).not.toContain("provider-fan-out")
    expect(degradations).not.toContain("session-cleanup-unresolved")
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
