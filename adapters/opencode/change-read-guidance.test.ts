/**
 * The stop guidance a user reads when a change read stopped, one case per stop
 * kind. Decided from the error alone: no quarantine map is consulted.
 */

import { describe, expect, test } from "bun:test"

import { changeReadStopGuidance } from "./change-read-guidance.ts"
import { ChangeReadStopped, type ChangeReadStoppedFacts } from "./repo.ts"

const stop = (facts: Partial<ChangeReadStoppedFacts> & Pick<ChangeReadStoppedFacts, "stop">): ChangeReadStopped =>
  new ChangeReadStopped({ operation: "git diff", why: "why", readsCompleted: 0, cleanup: "not-applicable", ...facts })

const QUARANTINE_LINE = "QUARANTINED: MAD reads nothing in it until opencode restarts."
const CAUSES = "Likely causes:"

describe("changeReadStopGuidance", () => {
  test("hang-shaped stops with a confirmed or no cleanup: the causes, a retry, and no quarantine line", () => {
    for (const kind of ["terminated", "observation-failed", "budget-exhausted", "budget-passed"] as const) {
      const text = changeReadStopGuidance(
        stop({ stop: kind, cleanup: kind === "budget-exhausted" || kind === "budget-passed" ? "not-applicable" : "confirmed", pid: 7 }),
      )
      expect(text, kind).toContain(CAUSES)
      expect(text, kind).toContain("fsmonitor")
      expect(text, kind).toContain("very large untracked tree")
      expect(text, kind).toContain("do not normally prompt")
      expect(text, kind).toContain("partial clone")
      expect(text, kind).toContain("Then try again.")
      expect(text, kind).not.toContain("QUARANTINED")
    }
  })

  test("the LATCHING call (cleanup unresolved, no `quarantine` field) says the worktree is now quarantined, with its pid", () => {
    const error = stop({ stop: "cleanup-unresolved", cleanup: "unresolved", pid: 9191 })
    expect(error.quarantine).toBeUndefined()
    const text = changeReadStopGuidance(error)
    expect(text).toContain(CAUSES)
    expect(text).toContain(`This worktree is now ${QUARANTINE_LINE}`)
    expect(text).toContain("Check that process 9191 has ended, then restart opencode.")
    expect(text).not.toContain("Then try again.")
  })

  test("an observation failure whose cleanup is unresolved latched too", () => {
    const text = changeReadStopGuidance(stop({ stop: "observation-failed", cleanup: "unresolved", pid: 5 }))
    expect(text).toContain(`This worktree is now ${QUARANTINE_LINE}`)
    expect(text).toContain("Check that process 5 has ended")
  })

  test("an unresolved cleanup with no pid names no process", () => {
    const text = changeReadStopGuidance(stop({ stop: "cleanup-unresolved", cleanup: "unresolved" }))
    expect(text).toContain("Check for a leftover git process in this worktree, then restart opencode.")
    expect(text).not.toMatch(/process \d/)
  })

  test("quarantined: restart guidance with the latching pid, and nothing else", () => {
    const text = changeReadStopGuidance(
      stop({ stop: "quarantined", quarantine: { operation: "git ls-files", why: "x", pid: 4242 } }),
    )
    expect(text).toBe(`This worktree is ${QUARANTINE_LINE} Check that process 4242 has ended, then restart opencode.`)
    expect(text).not.toContain(CAUSES)
    expect(text).not.toContain("no process id")
  })

  test("launch-failed: git could not be started", () => {
    const text = changeReadStopGuidance(stop({ stop: "launch-failed" }))
    expect(text).toContain("git could not be started")
    expect(text).toContain("installed and on the PATH")
    expect(text).not.toContain(CAUSES)
    expect(text).not.toContain("QUARANTINED")
  })

  test("refused: MAD's own fault", () => {
    const text = changeReadStopGuidance(stop({ stop: "refused" }))
    expect(text).toContain("fault in MAD")
    expect(text).not.toContain(CAUSES)
  })

  test("signalled: killed from outside, output incomplete, retry", () => {
    const text = changeReadStopGuidance(stop({ stop: "signalled", status: 0, signal: "SIGKILL" }))
    expect(text).toContain("killed the git read")
    expect(text).toContain("incomplete")
    expect(text).toContain("Try again.")
    expect(text).not.toContain(CAUSES)
    expect(text).not.toContain("QUARANTINED")
  })

  test("stderr-unread: retry", () => {
    const text = changeReadStopGuidance(stop({ stop: "stderr-unread", status: 0 }))
    expect(text).toContain("diagnostics")
    expect(text).toContain("Try again.")
    expect(text).not.toContain(CAUSES)
    expect(text).not.toContain("QUARANTINED")
  })

  test("it does not repeat what the message already says", () => {
    const error = stop({ stop: "terminated", cleanup: "confirmed", pid: 7, why: "a distinctive launcher reason" })
    const text = changeReadStopGuidance(error)
    expect(text).not.toContain("a distinctive launcher reason")
    expect(text).not.toContain("Cleanup:")
    expect(text).not.toContain("`git diff` (terminated)")
    expect(error.message.endsWith("No change was read.")).toBe(true)
  })
})
