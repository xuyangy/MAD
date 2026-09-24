/**
 * Story 2-8b — the paired gate table's shape, and what `gatePreflight` lets pass.
 */

import { describe, expect, test } from "bun:test"

import { gatePreflight, HUMAN_BUDGET_OWNER, PAIRED_GATES, PAIRED_NON_GATES, type PairedGate } from "./paired-gates.ts"

const closedAll = (gates: readonly PairedGate[]): PairedGate[] =>
  gates.map((gate) => ({ ...gate, status: "CLOSED", evidence: gate.evidence ?? "a reviewed change" }))

describe("PAIRED_GATES", () => {
  test("six gates numbered 1-6, each with a name, kind, phase, owner, status and requirement", () => {
    expect(PAIRED_GATES.map((gate) => gate.number)).toEqual([1, 2, 3, 4, 5, 6])
    for (const gate of PAIRED_GATES) {
      expect(gate.name.trim().length).toBeGreaterThan(0)
      expect(["engineering", "authorization"]).toContain(gate.kind)
      expect(["accounting-probe", "evaluation"]).toContain(gate.phase)
      expect(gate.owner.trim().length).toBeGreaterThan(0)
      expect(["OPEN", "CLOSED"]).toContain(gate.status)
      expect(gate.requires.trim().length).toBeGreaterThan(0)
      // Evidence exactly when CLOSED.
      expect(gate.status === "CLOSED").toBe(gate.evidence !== undefined && gate.evidence.trim().length > 0)
    }
  })

  test("the table records each gate as the story fixes it", () => {
    const row = (gate: PairedGate) => [gate.number, gate.name, gate.kind, gate.phase, gate.owner, gate.status]
    expect(PAIRED_GATES.map(row)).toEqual([
      [1, "host request accounting", "engineering", "evaluation", "story 2-8c", "OPEN"],
      [2, "shared gates verified on a real host", "engineering", "evaluation", "story 2-8c", "CLOSED"],
      [3, "accounting-probe spend authorization", "authorization", "accounting-probe", HUMAN_BUDGET_OWNER, "OPEN"],
      [4, "evaluation spend authorization", "authorization", "evaluation", HUMAN_BUDGET_OWNER, "OPEN"],
      [5, "worktree identity", "engineering", "evaluation", "story 2-8b", "CLOSED"],
      [6, "production Tools wiring", "engineering", "evaluation", "story 2-8b", "CLOSED"],
    ])
  })

  test("exactly gates 3 and 4 are authorization gates, owned by the human budget owner, and OPEN", () => {
    const authorization = PAIRED_GATES.filter((gate) => gate.kind === "authorization")
    expect(authorization.map((gate) => gate.number)).toEqual([3, 4])
    for (const gate of authorization) {
      expect(gate.owner).toBe(HUMAN_BUDGET_OWNER)
      expect(gate.status).toBe("OPEN")
    }
  })

  test("the closed engineering gates name the launcher checks and their tests", () => {
    for (const number of [5, 6]) {
      const gate = PAIRED_GATES.find((entry) => entry.number === number)!
      expect(gate.evidence).toContain("scripts/paired.ts")
      expect(gate.evidence).toContain("scripts/paired.test.ts")
    }
  })

  test("gate 2 is closed on the probe's real-host refusals, and names the probe, the evidence file and its tests", () => {
    const gate = PAIRED_GATES.find((entry) => entry.number === 2)!
    expect(gate.status).toBe("CLOSED")
    for (const text of ["bun run accounting-probe", "ablation/evidence/host-accounting-2026-09-23.json", "scripts/accounting-probe.test.ts", "0 backend calls and 0 stub requests"]) {
      expect(gate.evidence).toContain(text)
    }
    for (const name of ["global", "Blocks", "phase"]) expect(gate.evidence).toContain(name)
  })

  test("gate 1 stays OPEN, and its requirement cites F2, F3 and N2 as measured, with the evidence file", () => {
    const gate = PAIRED_GATES.find((entry) => entry.number === 1)!
    expect(gate.status).toBe("OPEN")
    expect(gate.evidence).toBeUndefined()
    for (const text of ["F2", "F3", "N2", "measured this false", "ablation/evidence/host-accounting-2026-09-23.json"]) {
      expect(gate.requires).toContain(text)
    }
  })

  test("gate 3 stays OPEN and unused, with a note that 2-8c spent no paid tokens", () => {
    const gate = PAIRED_GATES.find((entry) => entry.number === 3)!
    expect(gate.status).toBe("OPEN")
    expect(gate.note).toContain("spent no paid tokens")
    expect(gatePreflight(PAIRED_GATES, "evaluation").lines[2]).toContain(`note: ${gate.note}`)
  })

  test("the adversarial prerequisites' allowance is not a paired gate", () => {
    const text = JSON.stringify(PAIRED_GATES)
    expect(text).not.toContain("400,000")
    expect(text).not.toContain("400000")
  })

  test("repo.ts is recorded as checked and off the paired path, with the condition that reopens it", () => {
    const entry = PAIRED_NON_GATES.find((item) => item.name.includes("adapters/opencode/repo.ts"))!
    expect(entry.evidence).toContain("repo.change()")
    expect(entry.reopensWhen.trim().length).toBeGreaterThan(0)
  })
})

describe("gatePreflight", () => {
  test("the shipped table refuses the evaluation, naming every open evaluation gate", () => {
    const result = gatePreflight(PAIRED_GATES, "evaluation")
    expect(result.ok).toBe(false)
    for (const number of [1, 4]) expect(result.problems.some((problem) => problem.startsWith(`gate ${number} `))).toBe(true)
    // Gate 2 is CLOSED; gate 3 is printed but not consulted for the evaluation.
    for (const number of [2, 3]) expect(result.problems.some((problem) => problem.startsWith(`gate ${number} `))).toBe(false)
    expect(result.lines).toHaveLength(PAIRED_GATES.length)
  })

  test("every gate closed passes", () => {
    expect(gatePreflight(closedAll(PAIRED_GATES), "evaluation").ok).toBe(true)
  })

  test("gate 1 OPEN alone refuses every evaluation", () => {
    const onlyOne = closedAll(PAIRED_GATES).map((gate) => (gate.number === 1 ? { ...gate, status: "OPEN" as const, evidence: undefined } : gate))
    const result = gatePreflight(onlyOne, "evaluation")
    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([`gate 1 (host request accounting) is OPEN; owner: story 2-8c; closing it requires: ${onlyOne[0]!.requires}`])
  })

  test("no gate with phase accounting-probe can satisfy an evaluation preflight", () => {
    // Close everything required for the probe, and only that: the evaluation still refuses.
    const probeOnly = PAIRED_GATES.map((gate) =>
      gate.phase === "accounting-probe" ? { ...gate, status: "CLOSED" as const, evidence: "authorized" } : gate,
    )
    expect(gatePreflight(probeOnly, "evaluation").ok).toBe(false)
    // With gate 4 left OPEN, closing everything else — gate 3 included — still refuses.
    const allButFour = closedAll(PAIRED_GATES).map((gate) => (gate.number === 4 ? { ...gate, status: "OPEN" as const, evidence: undefined } : gate))
    const result = gatePreflight(allButFour, "evaluation")
    expect(result.ok).toBe(false)
    expect(result.problems.join("\n")).toContain("gate 4 (evaluation spend authorization) is OPEN")
    // A table whose only authorization gate is for the probe authorizes no evaluation.
    const relabelled = closedAll(PAIRED_GATES).filter((gate) => gate.number !== 4)
    const refused = gatePreflight(relabelled, "evaluation")
    expect(refused.ok).toBe(false)
    expect(refused.problems.join("\n")).toContain("no authorization gate for evaluation")
  })

  test("a CLOSED gate with no evidence is not closed", () => {
    const gates = closedAll(PAIRED_GATES).map((gate) => (gate.number === 1 ? { ...gate, evidence: " " } : gate))
    const result = gatePreflight(gates, "evaluation")
    expect(result.ok).toBe(false)
    expect(result.problems.join("\n")).toContain("gate 1 (host request accounting) is CLOSED with no evidence recorded")
  })

  test("a duplicate gate number refuses", () => {
    const gates = closedAll(PAIRED_GATES).map((gate) => (gate.number === 6 ? { ...gate, number: 5 } : gate))
    expect(gatePreflight(gates, "evaluation").problems).toContain("gate number 5 appears twice")
  })
})

describe("gatePreflight refuses a malformed row (story 2-8b review)", () => {
  test("an OPEN gate that carries evidence refuses", () => {
    const gates = closedAll(PAIRED_GATES).map((gate) => (gate.number === 2 ? { ...gate, status: "OPEN" as const } : gate))
    expect(gates.find((gate) => gate.number === 2)!.evidence).toBeDefined()
    expect(gatePreflight(gates, "evaluation").problems.join("\n")).toContain(
      "gate 2 (shared gates verified on a real host) is OPEN but carries evidence",
    )
  })

  test("a blank or multi-line note refuses, even when every gate reads CLOSED", () => {
    for (const note of ["", "  ", "two\nlines"]) {
      const gates = closedAll(PAIRED_GATES).map((gate) => (gate.number === 3 ? { ...gate, note } : gate))
      expect(gatePreflight(gates, "evaluation").problems.join("\n"), JSON.stringify(note)).toContain(
        "gate 3 (accounting-probe spend authorization) has a note that is not one non-empty line",
      )
    }
  })

  test("an unknown kind, phase or status refuses, even when every gate reads CLOSED", () => {
    const bad = (patch: Record<string, unknown>) =>
      gatePreflight(
        closedAll(PAIRED_GATES).map((gate) => (gate.number === 5 ? ({ ...gate, ...patch } as unknown as PairedGate) : gate)),
        "evaluation",
      )
    const kind = bad({ kind: "cosmetic" })
    expect(kind.ok).toBe(false)
    expect(kind.problems.join("\n")).toContain('gate 5 (worktree identity) has kind "cosmetic"')
    const phase = bad({ phase: "later" })
    expect(phase.ok).toBe(false)
    expect(phase.problems.join("\n")).toContain('gate 5 (worktree identity) has phase "later"')
    const status = bad({ status: "closed" })
    expect(status.ok).toBe(false)
    expect(status.problems.join("\n")).toContain('gate 5 (worktree identity) has status "closed"')
  })
})
