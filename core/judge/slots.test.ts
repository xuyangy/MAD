import { describe, expect, test } from "bun:test"

import type { Finding } from "../domain/finding.ts"
import type { LensSlot, Roster, RosterSlot } from "../domain/roster.ts"
import { assignJudgeSlots, JUDGE_ROLES } from "./slots.ts"

function slot(id: string): RosterSlot {
  return {
    slot: id,
    providerId: "p",
    modelId: id,
    identity: id,
    lineage: { lineage: id, label: id, verified: true },
    toolcall: true,
    alsoAvailableVia: [],
  }
}

function roster(ids: string[], lensIds: string[] = []): Roster {
  const lensSlots: LensSlot[] = lensIds.map((lens) => ({
    ...slot(`discovery-lens-${lens}`),
    lens,
  }))
  return {
    slots: ids.map(slot),
    lensSlots,
    requested: ids.length,
    distinctLineages: ids.length,
    providers: ["p"],
  }
}

function finding(id = "f-1", author = "discovery-1"): Finding {
  return {
    id,
    claim: "c",
    reasoning: "r",
    locus: { file: "src/pay.ts" },
    severity: "high",
    author,
    source: "pool",
    history: [],
  }
}

const all = () => true
const none = () => false

describe("assignJudgeSlots", () => {
  test("fills every role", () => {
    const assigned = assignJudgeSlots({
      roster: roster(["discovery-1", "discovery-2", "discovery-3", "discovery-4"]),
      answeredSlots: ["discovery-1", "discovery-2", "discovery-3", "discovery-4"],
      hasTools: all,
      finding: finding(),
    })!
    for (const role of JUDGE_ROLES) expect(assigned.byRole[role]).toBeTruthy()
  })

  test("AD-13 — a TOOLED slot fact-checks even when the untooled ones are non-authors", () => {
    // Tools are a requirement; non-authorship is a preference. When they
    // conflict the requirement wins, including when the only tooled slot is the
    // finding's own author.
    const assigned = assignJudgeSlots({
      roster: roster(["discovery-1", "discovery-2", "discovery-3"]),
      answeredSlots: ["discovery-1", "discovery-2", "discovery-3"],
      hasTools: (s) => s === "discovery-1",
      finding: finding("f-1", "discovery-1"),
    })!
    expect(assigned.byRole["fact-check"]).toBe("discovery-1")
    expect(assigned.factCheckTooled).toBe(true)
  })

  test("AD-13 — a tooled NON-AUTHOR is preferred over a tooled author", () => {
    const assigned = assignJudgeSlots({
      roster: roster(["discovery-1", "discovery-2", "discovery-3"]),
      answeredSlots: ["discovery-1", "discovery-2", "discovery-3"],
      hasTools: (s) => s === "discovery-1" || s === "discovery-2",
      finding: finding("f-1", "discovery-1"),
    })!
    expect(assigned.byRole["fact-check"]).toBe("discovery-2")
    expect(assigned.factCheckTooled).toBe(true)
  })

  test("AD-13 — no tooled slot anywhere still ASSIGNS, and says it is untooled", () => {
    // It never refuses the run. The caller warns and the result is unverified.
    const assigned = assignJudgeSlots({
      roster: roster(["discovery-1", "discovery-2"]),
      answeredSlots: ["discovery-1", "discovery-2"],
      hasTools: none,
      finding: finding(),
    })!
    expect(assigned.byRole["fact-check"]).toBeTruthy()
    expect(assigned.factCheckTooled).toBe(false)
  })

  test("no role goes to the author while a non-author exists", () => {
    const assigned = assignJudgeSlots({
      roster: roster(["discovery-1", "discovery-2", "discovery-3"]),
      answeredSlots: ["discovery-1", "discovery-2", "discovery-3"],
      hasTools: all,
      finding: finding("f-1", "discovery-1"),
    })!
    for (const role of JUDGE_ROLES) expect(assigned.byRole[role]).not.toBe("discovery-1")
  })

  test("a ONE-SLOT roster judges with the author, because nothing else exists", () => {
    // Marking your own work is worse than nothing only when there is an
    // alternative. Here there is none, and refusing to judge would be worse.
    const assigned = assignJudgeSlots({
      roster: roster(["discovery-1"]),
      answeredSlots: ["discovery-1"],
      hasTools: all,
      finding: finding("f-1", "discovery-1"),
    })!
    for (const role of JUDGE_ROLES) expect(assigned.byRole[role]).toBe("discovery-1")
  })

  test("four usable non-author slots give four DISTINCT models", () => {
    const assigned = assignJudgeSlots({
      roster: roster(["discovery-1", "discovery-2", "discovery-3", "discovery-4", "discovery-5"]),
      answeredSlots: [
        "discovery-1",
        "discovery-2",
        "discovery-3",
        "discovery-4",
        "discovery-5",
      ],
      hasTools: all,
      finding: finding("f-1", "discovery-1"),
    })!
    expect(new Set(Object.values(assigned.byRole)).size).toBe(4)
  })

  test("a slot that DROPPED OUT of discovery is never given a role", () => {
    const assigned = assignJudgeSlots({
      roster: roster(["discovery-1", "discovery-2", "discovery-3"]),
      answeredSlots: ["discovery-2"],
      hasTools: all,
      finding: finding("f-1", "discovery-1"),
    })!
    for (const role of JUDGE_ROLES) expect(assigned.byRole[role]).toBe("discovery-2")
  })

  test("a LENS slot never judges, even when it answered", () => {
    const assigned = assignJudgeSlots({
      roster: roster(["discovery-1"], ["security"]),
      answeredSlots: ["discovery-1", "discovery-lens-security"],
      hasTools: all,
      finding: finding(),
    })!
    for (const role of JUDGE_ROLES) {
      expect(assigned.byRole[role]).not.toContain("lens")
    }
  })

  test("NO pool slot answered — undefined, so the caller can degrade honestly", () => {
    expect(
      assignJudgeSlots({
        roster: roster(["discovery-1"], ["security"]),
        answeredSlots: ["discovery-lens-security"],
        hasTools: all,
        finding: finding(),
      }),
    ).toBeUndefined()
  })

  test("deterministic — one finding always gets one assignment", () => {
    const input = {
      roster: roster(["discovery-1", "discovery-2", "discovery-3", "discovery-4"]),
      answeredSlots: ["discovery-1", "discovery-2", "discovery-3", "discovery-4"],
      hasTools: all,
      finding: finding("f-7", "discovery-1"),
    }
    expect(assignJudgeSlots(input)).toEqual(assignJudgeSlots(input)!)
  })

  test("work SPREADS — two findings in one run do not all fact-check on one slot", () => {
    const base = {
      roster: roster(["discovery-1", "discovery-2", "discovery-3", "discovery-4"]),
      answeredSlots: ["discovery-1", "discovery-2", "discovery-3", "discovery-4"],
      hasTools: all,
    }
    const checkers = new Set<string>()
    for (let i = 0; i < 20; i += 1) {
      checkers.add(assignJudgeSlots({ ...base, finding: finding(`f-${i}`, "discovery-1") })!.byRole["fact-check"])
    }
    expect(checkers.size).toBeGreaterThan(1)
  })
})
