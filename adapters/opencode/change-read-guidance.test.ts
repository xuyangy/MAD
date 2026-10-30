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
    // A dead direct child is not the condition: a helper it started can still hold the output.
    expect(text).toContain("check that process 9191 has ended AND look for any git process or helper it started")
    expect(text).toContain("Process 9191 having ended does not mean its helpers have. Then restart opencode.")
    expect(text).not.toContain("Then try again.")
  })

  test("an observation failure whose cleanup is unresolved latched too", () => {
    const text = changeReadStopGuidance(stop({ stop: "observation-failed", cleanup: "unresolved", pid: 5 }))
    expect(text).toContain(`This worktree is now ${QUARANTINE_LINE}`)
    expect(text).toContain("check that process 5 has ended AND look for any git process or helper it started")
  })

  test("an unresolved cleanup with no pid names no process", () => {
    const text = changeReadStopGuidance(stop({ stop: "cleanup-unresolved", cleanup: "unresolved" }))
    expect(text).toContain("look for any git process or helper still running in this worktree")
    expect(text).toContain("MAD has no process id for this read. Then restart opencode.")
    expect(text).not.toMatch(/process \d/)
  })

  test("quarantined: restart guidance with the latching pid, and nothing else", () => {
    const text = changeReadStopGuidance(
      stop({ stop: "quarantined", quarantine: { operation: "git ls-files", why: "x", pid: 4242 } }),
    )
    expect(text.startsWith(`This worktree is ${QUARANTINE_LINE} Before restarting opencode, `)).toBe(true)
    // A later call is told the same as the latching one: the pid AND its helpers.
    expect(text).toContain("check that process 4242 has ended AND look for any git process or helper it started")
    expect(text).toContain("Process 4242 having ended does not mean its helpers have. Then restart opencode.")
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

  test("cancelled with unresolved cleanup and an observed exit: git was seen to end, its cleanup unconfirmed", () => {
    const text = changeReadStopGuidance(stop({ stop: "cancelled", cleanup: "unresolved", pid: 7, signal: "SIGKILL" }))
    expect(text).toContain(
      "Git's own process was seen to end, but MAD could not confirm its cleanup, so something it started may still be running.",
    )
    expect(text).not.toContain("holds its output")
    expect(text).not.toContain("could not confirm that git ended")
    expect(text).toContain(`This worktree is now ${QUARANTINE_LINE}`)
  })

  test("cancelled with unresolved cleanup and nothing observed: it cannot confirm git ended", () => {
    const text = changeReadStopGuidance(stop({ stop: "cancelled", cleanup: "unresolved", pid: 7 }))
    expect(text).toContain("MAD could not confirm that git ended.")
    expect(text).toContain(`This worktree is now ${QUARANTINE_LINE}`)
  })

  test("the message's ending follows how much of the change was read", () => {
    expect(stop({ stop: "cancelled" }).message).toEndWith("No change was read.")
    expect(stop({ stop: "cancelled", contentRead: "possibly" }).message).toEndWith(
      "Some of the change may have been read, but none of it was returned for review.",
    )
    expect(stop({ stop: "cancelled", contentRead: "some" }).message).toEndWith(
      "Part of the change was read, but none of it was returned for review.",
    )
    expect(stop({ stop: "cancelled", operation: "change read", contentRead: "some" }).message).toEndWith(
      "The change was read, but none of it was returned for review.",
    )
  })
})
