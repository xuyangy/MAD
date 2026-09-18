/**
 * `toolFailureEvidence` — the one piece of runtime behaviour this port carries
 * (story 2-7a).
 *
 * It reads a SHAPE off a thrown value, which is what lets the core stay free of
 * any adapter type (AD-1). The cost of a structural read is that nothing else
 * checks it: whatever comes back decides whether a run is reported to have
 * EXECUTED a command, and the value it reads may come from a `Tools`
 * implementation this tree never saw. So the rows below are mostly about what it
 * REFUSES, and each refusal falls back to a reading that under-claims rather
 * than over-claims.
 */

import { describe, expect, test } from "bun:test"

import { TOOL_FAILURE_EVIDENCE, toolFailureEvidence } from "./tool-observation.ts"

/** A thrown value carrying `carried` under the agreed property. */
function thrown(carried: unknown): unknown {
  return Object.assign(new Error("boom"), { [TOOL_FAILURE_EVIDENCE]: carried })
}

describe("toolFailureEvidence — what it refuses", () => {
  test("A NON-OBJECT IS NOT EVIDENCE — and it is total over every shape", () => {
    // `Tools.blame` may reject with anything at all, including a value from a
    // port written elsewhere. A throw here would take down the judge's catch.
    for (const value of ["a string", 42, true, null, undefined, Symbol("s"), () => {}]) {
      expect(toolFailureEvidence(value)).toBeUndefined()
    }
  })

  test("AN ORDINARY ERROR CARRIES NOTHING, and a non-object payload is nothing too", () => {
    expect(toolFailureEvidence(new Error("not a git repository"))).toBeUndefined()
    expect(toolFailureEvidence(thrown(null))).toBeUndefined()
    expect(toolFailureEvidence(thrown("pre-shell"))).toBeUndefined()
    expect(toolFailureEvidence(thrown(128))).toBeUndefined()
  })

  test("AN UNKNOWN `stage` IS REFUSED WHOLE, not repaired", () => {
    // Refusing the whole record reads as `unknown` downstream. Keeping the parts
    // that happened to parse would let a caller that spelled the stage wrong
    // still influence an execution count.
    expect(toolFailureEvidence(thrown({ stage: "spawn", launch: "unproved" }))).toBeUndefined()
    expect(toolFailureEvidence(thrown({ launch: "unproved" }))).toBeUndefined()
  })

  test("AN UNKNOWN `launch` IS REFUSED WHOLE", () => {
    expect(toolFailureEvidence(thrown({ stage: "shell", launch: "maybe" }))).toBeUndefined()
    expect(toolFailureEvidence(thrown({ stage: "shell" }))).toBeUndefined()
    expect(toolFailureEvidence(thrown({ stage: "shell", launch: 0 }))).toBeUndefined()
  })
})

describe("toolFailureEvidence — what it accepts, and how narrowly", () => {
  test("ALL FOUR LAUNCH READINGS SURVIVE — the non-vacuous half of the refusals", () => {
    for (const launch of ["proved", "failed", "unproved", "not-attempted"] as const) {
      expect(toolFailureEvidence(thrown({ stage: "shell", launch }))).toEqual({
        stage: "shell",
        launch,
      })
    }
  })

  test("AN EXIT CODE THAT IS NOT A WHOLE NUMBER IS NOT AN EXIT CODE", () => {
    // `typeof value === "number"` alone admits all three of these. `NaN` is the
    // dangerous one: it would travel into a terminal reading as an exit nobody
    // can interpret, and every comparison against it silently answers false.
    for (const exitCode of ["128", 1.5, Number.NaN, Number.POSITIVE_INFINITY, null]) {
      expect(toolFailureEvidence(thrown({ stage: "shell", exitCode, launch: "unproved" }))).toEqual({
        stage: "shell",
        launch: "unproved",
      })
    }
  })

  test("A WHOLE NUMBER IS KEPT, including zero and a negative one", () => {
    expect(toolFailureEvidence(thrown({ stage: "shell", exitCode: 128, launch: "unproved" }))).toEqual({
      stage: "shell",
      exitCode: 128,
      launch: "unproved",
    })
    // Not filtered for plausibility: a host that reports these is reporting
    // something, and this reader's job is to carry it faithfully or not at all.
    expect(toolFailureEvidence(thrown({ stage: "shell", exitCode: 0, launch: "proved" }))).toEqual({
      stage: "shell",
      exitCode: 0,
      launch: "proved",
    })
    expect(toolFailureEvidence(thrown({ stage: "shell", exitCode: -1, launch: "unproved" }))).toEqual({
      stage: "shell",
      exitCode: -1,
      launch: "unproved",
    })
  })

  test("A `pre-shell` REFUSAL NEVER CARRIES AN EXIT CODE, whatever it was handed", () => {
    // The two together are a contradiction: nothing ran, so nothing exited. The
    // stage is the half that is checkable against what the adapter did, so the
    // exit is the half that is dropped.
    expect(
      toolFailureEvidence(thrown({ stage: "pre-shell", exitCode: 128, launch: "not-attempted" })),
    ).toEqual({ stage: "pre-shell", launch: "not-attempted" })
  })

  test("EXTRA FIELDS ARE IGNORED — the read is structural, not a schema", () => {
    expect(
      toolFailureEvidence(thrown({ stage: "shell", exitCode: 1, launch: "failed", pid: 4321 })),
    ).toEqual({ stage: "shell", exitCode: 1, launch: "failed" })
  })
})
