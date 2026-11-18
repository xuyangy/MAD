/**
 * Plan item B3 — the process-group facts the launcher change would rest on,
 * measured on the Bun and the operating system running the suite. POSIX only:
 * `detached` and negative pids mean nothing on Windows. The probe needs `perl`
 * for its helpers; without it each helper case must say it was not measured.
 */

import { describe, expect, test } from "bun:test"

import {
  classifyPs,
  directKill,
  groupKill,
  leader,
  leaderExited,
  leaderGuard,
  leftGroupOf,
  reapDuringSyncCode,
  setsidEscape,
} from "./probe-process-group.ts"

const hasPerl = Bun.which("perl") !== null

/** A helper case either measured or says why not; it is never a silent pass. */
function measured<T extends { measured: boolean }>(facts: T): Extract<T, { measured: true }> | undefined {
  if (!facts.measured) {
    expect(hasPerl).toBe(false)
    return undefined
  }
  return facts as Extract<T, { measured: true }>
}

describe.if(process.platform !== "win32")("B3 — process groups on this Bun", () => {
  test("a detached child leads a new group, and its grandchild joins it", async () => {
    const facts = measured(await leader())
    if (facts === undefined) return
    expect(facts).toEqual({ measured: true, leaderLeadsGroup: true, parentInOtherGroup: true, grandchildInGroup: true })
  })

  test("the leader's guard: it owns its group when detached and refuses when it shares this process's group", async () => {
    // Only `check` is sent: no signal reaches any group in this test.
    const facts = measured(await leaderGuard())
    if (facts === undefined) return
    expect(facts).toEqual({ measured: true, detachedStatus: 0, sharedGroupStatus: 3 })
  })

  test("SIGKILL to the group ends a grandchild holding stdout, and the pipe ends", async () => {
    const facts = measured(await groupKill())
    if (facts === undefined) return
    expect(facts.leaderSignal).toBe("SIGKILL")
    // An orphan may be a zombie until its new parent reaps it; either way it is not running.
    expect(["absent", "zombie"]).toContain(facts.grandchildState)
    expect(facts.pipeEnded).toBe(true)
  })

  test("a leader that exits is reaped while a grandchild keeps its group id and the pipe open", async () => {
    const facts = measured(await leaderExited())
    if (facts === undefined) return
    expect(facts).toEqual({
      measured: true,
      leaderExitReported: true,
      leaderState: "absent",
      grandchildState: "running",
      grandchildKeepsGroupId: true,
      pipeEndedWhileHeld: false,
    })
  })

  test("an exited child is reaped after an event-loop turn; on Darwin it stays a zombie through synchronous code", async () => {
    const facts = await reapDuringSyncCode()
    expect(facts.stateAfterAwait).toBe("absent")
    if (process.platform === "darwin") {
      expect(facts).toEqual({
        stateSeen: "zombie",
        exitCodeAtFirstSample: null,
        stateAfterHold: "zombie",
        exitCodeAfterHold: null,
        stateAfterAwait: "absent",
      })
    }
  })

  test("a grandchild that calls setsid leaves the group and survives a group kill", async () => {
    const facts = measured(await setsidEscape())
    if (facts === undefined) return
    expect(facts).toEqual({
      measured: true,
      leftGroup: true,
      leaderSignal: "SIGKILL",
      escapedState: "running",
      pipeEndedWhileHeld: false,
    })
  })

  test("today's launcher: a child that is not detached shares this process's group, and killing it leaves a grandchild", async () => {
    const facts = measured(await directKill())
    if (facts === undefined) return
    expect(facts).toEqual({ measured: true, sharesParentGroup: true, leaderSignal: "SIGKILL", grandchildState: "running" })
  })
})

describe("B3 — reading ps", () => {
  test("only a zero exit with output is a value; exit 1 with no output is absence; everything else is a failed read", () => {
    expect(classifyPs({ stdout: " 123\n", exitCode: 0, timedOut: false })).toEqual({ ok: true, value: "123" })
    expect(classifyPs({ stdout: "", exitCode: 1, timedOut: false })).toEqual({ ok: false, absent: true })
    expect(classifyPs({ stdout: "123", exitCode: 1, timedOut: false })).toEqual({ ok: false, absent: false })
    expect(classifyPs({ stdout: "123", exitCode: 2, timedOut: false })).toEqual({ ok: false, absent: false })
    expect(classifyPs({ stdout: "", exitCode: 0, timedOut: false })).toEqual({ ok: false, absent: false })
    expect(classifyPs({ stdout: "123", exitCode: null, timedOut: true })).toEqual({ ok: false, absent: false })
    expect(classifyPs({ stdout: "123", exitCode: 0, timedOut: true })).toEqual({ ok: false, absent: false })
  })

  test("leftGroup is reported only from a numeric group id", () => {
    expect(leftGroupOf(10, 10)).toBe(false)
    expect(leftGroupOf(11, 10)).toBe(true)
    expect(leftGroupOf("absent", 10)).toBeNull()
    expect(leftGroupOf("unknown", 10)).toBeNull()
  })
})
