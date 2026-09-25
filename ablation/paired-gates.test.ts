/**
 * Story 2-8b — the paired gate table's shape, and what `gatePreflight` lets pass.
 */

import { describe, expect, test } from "bun:test"

import { MEASURED_HOST } from "./managed-host.ts"
import { gatePreflight, HUMAN_BUDGET_OWNER, PAIRED_GATES, PAIRED_NON_GATES, type PairedGate } from "./paired-gates.ts"

const closedAll = (gates: readonly PairedGate[]): PairedGate[] =>
  gates.map((gate) => ({ ...gate, status: "CLOSED", evidence: gate.evidence ?? "a reviewed change" }))

describe("PAIRED_GATES", () => {
  test("seven gates numbered 1-7, each with a name, kind, phase, owner, status and requirement", () => {
    expect(PAIRED_GATES.map((gate) => gate.number)).toEqual([1, 2, 3, 4, 5, 6, 7])
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
      [1, "host request accounting", "engineering", "evaluation", "story 2-8c2", "CLOSED"],
      [2, "shared gates verified on a real host", "engineering", "evaluation", "story 2-8c", "CLOSED"],
      [3, "accounting-probe spend authorization", "authorization", "accounting-probe", HUMAN_BUDGET_OWNER, "OPEN"],
      [4, "evaluation spend authorization", "authorization", "evaluation", HUMAN_BUDGET_OWNER, "OPEN"],
      [5, "worktree identity", "engineering", "evaluation", "story 2-8b", "CLOSED"],
      [6, "production Tools wiring", "engineering", "evaluation", "story 2-8b", "CLOSED"],
      [7, "OAuth attempt accounting", "engineering", "evaluation", "story 2-8c3b", "OPEN"],
    ])
    // Routes: gate 1 covers the api-key route, gate 7 the oauth route, and every other gate both.
    expect(PAIRED_GATES.map((gate) => [gate.number, gate.routes ?? "every route"])).toEqual([
      [1, ["api-key"]],
      [2, "every route"],
      [3, "every route"],
      [4, "every route"],
      [5, "every route"],
      [6, "every route"],
      [7, ["oauth"]],
    ])
  })

  test("gate 7 is OPEN, needs 2-8c3b's zero-bill probe, and is never closed from the paid evaluation", () => {
    const gate = PAIRED_GATES.find((entry) => entry.number === 7)!
    expect(gate.status).toBe("OPEN")
    expect(gate.evidence).toBeUndefined()
    for (const text of ["2-8c3b", "zero-bill OAuth probe", "OpenAI's OAuth transport", "separately human-authorized bounded pilot", "before story 2-8d", "Never closed from the paid paired evaluation"]) {
      expect(gate.requires).toContain(text)
    }
  })

  test("gate 4 states the api-key unit unchanged and the oauth unit in admitted attempts", () => {
    const gate = PAIRED_GATES.find((entry) => entry.number === 4)!
    expect(gate.routes).toBeUndefined()
    for (const text of ["api-key route in ledger tokens", "PAIRED_ALLOWANCES, unchanged", "oauth route in admitted attempts", "100 per block", "300 in total", "admission threshold"]) {
      expect(gate.requires).toContain(text)
    }
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
    for (const text of ["bun run accounting-probe", MEASURED_HOST.evidence, "scripts/accounting-probe.test.ts", "0 backend calls and 0 stub requests"]) {
      expect(gate.evidence).toContain(text)
    }
    for (const name of ["global", "Blocks", "phase"]) expect(gate.evidence).toContain(name)
  })

  test("gate 1 is closed on the relay's invariant, and its evidence names the run, the findings and the tests", () => {
    const gate = PAIRED_GATES.find((entry) => entry.number === 1)!
    expect(gate.status).toBe("CLOSED")
    expect(gate.owner).toBe("story 2-8c2")
    for (const text of ["individually admitted and accounted", "host retries refused", "before it is forwarded"]) {
      expect(gate.requires).toContain(text)
    }
    for (const text of ["bun run accounting-probe", "All eight scenarios HOLD", "F2", "F3", "N2", "H1", "S1", "A1", MEASURED_HOST.evidence, "ablation/request-meter.test.ts"]) {
      expect(gate.evidence).toContain(text)
    }
  })

  test("gate 3 stays OPEN and unused, with a note that 2-8c spent no paid tokens", () => {
    const gate = PAIRED_GATES.find((entry) => entry.number === 3)!
    expect(gate.status).toBe("OPEN")
    expect(gate.note).toContain("spent no paid tokens")
    expect(gatePreflight(PAIRED_GATES, "evaluation", "api-key").lines[2]).toContain(`note: ${gate.note}`)
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
  test("the shipped table refuses the api-key evaluation on gate 4 alone, and gate 7 is not consulted", () => {
    const result = gatePreflight(PAIRED_GATES, "evaluation", "api-key")
    expect(result.ok).toBe(false)
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]).toStartWith("gate 4 ")
    expect(result.lines).toHaveLength(PAIRED_GATES.length)
    expect(result.lines[2]).toContain("(not consulted for evaluation)")
    expect(result.lines[6]).toContain(
      "gate 7 — OAuth attempt accounting — engineering, required for evaluation on route oauth (not consulted for route api-key)",
    )
    expect(result.lines[0]).toContain("required for evaluation on route api-key, owner story 2-8c2 — CLOSED")
  })

  test("the shipped table refuses the oauth evaluation on gates 4 and 7, and gate 1 is not consulted", () => {
    const result = gatePreflight(PAIRED_GATES, "evaluation", "oauth")
    expect(result.ok).toBe(false)
    expect(result.problems.map((problem) => problem.split(" ").slice(0, 2).join(" "))).toEqual(["gate 4", "gate 7"])
    expect(result.lines[0]).toContain("host request accounting — engineering, required for evaluation on route api-key (not consulted for route oauth)")
  })

  test("a gate for one route neither blocks nor stands in for the other", () => {
    // Gate 1 OPEN blocks only the api-key route; gate 7 CLOSED alone does not open it.
    const gates = closedAll(PAIRED_GATES).map((gate) => (gate.number === 1 ? { ...gate, status: "OPEN" as const, evidence: undefined } : gate))
    expect(gatePreflight(gates, "evaluation", "api-key").ok).toBe(false)
    expect(gatePreflight(gates, "evaluation", "oauth").ok).toBe(true)
    // Gate 7 OPEN blocks only the oauth route.
    const seven = closedAll(PAIRED_GATES).map((gate) => (gate.number === 7 ? { ...gate, status: "OPEN" as const, evidence: undefined } : gate))
    expect(gatePreflight(seven, "evaluation", "api-key").ok).toBe(true)
    expect(gatePreflight(seven, "evaluation", "oauth").problems).toEqual([
      `gate 7 (OAuth attempt accounting) is OPEN; owner: story 2-8c3b; closing it requires: ${seven[6]!.requires}`,
    ])
  })

  test("an authorization gate scoped to the other route authorizes nothing on this one", () => {
    const gates = closedAll(PAIRED_GATES).map((gate) => (gate.number === 4 ? { ...gate, routes: ["oauth"] as const } : gate))
    expect(gatePreflight(gates, "evaluation", "oauth").ok).toBe(true)
    expect(gatePreflight(gates, "evaluation", "api-key").problems).toContain(
      "the table holds no authorization gate for evaluation on route api-key, so nothing authorizes its spend",
    )
  })

  test("an unknown route argument is a problem, and every route-scoped gate is then consulted", () => {
    const gates = closedAll(PAIRED_GATES).map((gate) => (gate.number === 7 ? { ...gate, status: "OPEN" as const, evidence: undefined } : gate))
    const result = gatePreflight(gates, "evaluation", "wifi" as never)
    expect(result.ok).toBe(false)
    expect(result.problems[0]).toBe('the route "wifi" is neither api-key nor oauth, so every route-scoped gate is consulted')
    expect(result.problems.some((problem) => problem.startsWith("gate 7 (OAuth attempt accounting) is OPEN"))).toBe(true)
    expect(result.lines.some((line) => line.includes("not consulted for route"))).toBe(false)
  })

  test("a string or other non-list `routes` is a table problem, never throws, and never decides coverage", () => {
    for (const routes of ["oauth", "api-key,oauth", 7, { 0: "oauth" }, [7], null]) {
      const gates = closedAll(PAIRED_GATES).map((gate) =>
        gate.number === 1 ? ({ ...gate, routes, status: "OPEN", evidence: undefined } as unknown as PairedGate) : gate,
      )
      // A substring match on "oauth" must not put gate 1 out of scope for the api-key route, nor in scope by accident.
      for (const route of ["api-key", "oauth"] as const) {
        const result = gatePreflight(gates, "evaluation", route)
        expect(result.ok, `${JSON.stringify(routes)} ${route}`).toBe(false)
        expect(result.problems.join("\n")).toContain("gate 1 (host request accounting) has routes")
        expect(result.problems.join("\n")).toContain("gate 1 (host request accounting) is OPEN")
      }
    }
  })

  test("an unknown or empty route list refuses", () => {
    for (const routes of [[], ["wifi"]]) {
      const gates = closedAll(PAIRED_GATES).map((gate) => (gate.number === 5 ? ({ ...gate, routes } as unknown as PairedGate) : gate))
      expect(gatePreflight(gates, "evaluation", "api-key").problems.join("\n"), JSON.stringify(routes)).toContain(
        "gate 5 (worktree identity) has routes",
      )
    }
  })

  test("every gate closed passes", () => {
    expect(gatePreflight(closedAll(PAIRED_GATES), "evaluation", "api-key").ok).toBe(true)
  })

  test("gate 1 OPEN alone refuses every evaluation", () => {
    const onlyOne = closedAll(PAIRED_GATES).map((gate) => (gate.number === 1 ? { ...gate, status: "OPEN" as const, evidence: undefined } : gate))
    const result = gatePreflight(onlyOne, "evaluation", "api-key")
    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([`gate 1 (host request accounting) is OPEN; owner: story 2-8c2; closing it requires: ${onlyOne[0]!.requires}`])
  })

  test("no gate with phase accounting-probe can satisfy an evaluation preflight", () => {
    // Close everything required for the probe, and only that: the evaluation still refuses.
    const probeOnly = PAIRED_GATES.map((gate) =>
      gate.phase === "accounting-probe" ? { ...gate, status: "CLOSED" as const, evidence: "authorized" } : gate,
    )
    expect(gatePreflight(probeOnly, "evaluation", "api-key").ok).toBe(false)
    // With gate 4 left OPEN, closing everything else — gate 3 included — still refuses.
    const allButFour = closedAll(PAIRED_GATES).map((gate) => (gate.number === 4 ? { ...gate, status: "OPEN" as const, evidence: undefined } : gate))
    const result = gatePreflight(allButFour, "evaluation", "api-key")
    expect(result.ok).toBe(false)
    expect(result.problems.join("\n")).toContain("gate 4 (evaluation spend authorization) is OPEN")
    // A table whose only authorization gate is for the probe authorizes no evaluation.
    const relabelled = closedAll(PAIRED_GATES).filter((gate) => gate.number !== 4)
    const refused = gatePreflight(relabelled, "evaluation", "api-key")
    expect(refused.ok).toBe(false)
    expect(refused.problems.join("\n")).toContain("no authorization gate for evaluation")
  })

  test("a CLOSED gate with no evidence is not closed", () => {
    const gates = closedAll(PAIRED_GATES).map((gate) => (gate.number === 1 ? { ...gate, evidence: " " } : gate))
    const result = gatePreflight(gates, "evaluation", "api-key")
    expect(result.ok).toBe(false)
    expect(result.problems.join("\n")).toContain("gate 1 (host request accounting) is CLOSED with no evidence recorded")
  })

  test("a duplicate gate number refuses", () => {
    const gates = closedAll(PAIRED_GATES).map((gate) => (gate.number === 6 ? { ...gate, number: 5 } : gate))
    expect(gatePreflight(gates, "evaluation", "api-key").problems).toContain("gate number 5 appears twice")
  })
})

describe("gatePreflight refuses a malformed row (story 2-8b review)", () => {
  test("an authorization gate owned by anyone but the human budget owner refuses, even when CLOSED", () => {
    const gates = closedAll(PAIRED_GATES).map((gate) => (gate.number === 4 ? { ...gate, owner: "story 2-8d" } : gate))
    const { ok, problems } = gatePreflight(gates, "evaluation", "api-key")
    expect(ok).toBe(false)
    expect(problems).toContain(
      `gate 4 (evaluation spend authorization) is an authorization gate owned by story 2-8d; only ${HUMAN_BUDGET_OWNER} owns an authorization`,
    )
  })

  test("an OPEN gate that carries evidence refuses", () => {
    const gates = closedAll(PAIRED_GATES).map((gate) => (gate.number === 2 ? { ...gate, status: "OPEN" as const } : gate))
    expect(gates.find((gate) => gate.number === 2)!.evidence).toBeDefined()
    expect(gatePreflight(gates, "evaluation", "api-key").problems.join("\n")).toContain(
      "gate 2 (shared gates verified on a real host) is OPEN but carries evidence",
    )
  })

  test("a blank or multi-line note refuses, even when every gate reads CLOSED", () => {
    for (const note of ["", "  ", "two\nlines"]) {
      const gates = closedAll(PAIRED_GATES).map((gate) => (gate.number === 3 ? { ...gate, note } : gate))
      expect(gatePreflight(gates, "evaluation", "api-key").problems.join("\n"), JSON.stringify(note)).toContain(
        "gate 3 (accounting-probe spend authorization) has a note that is not one non-empty line",
      )
    }
  })

  test("an unknown kind, phase or status refuses, even when every gate reads CLOSED", () => {
    const bad = (patch: Record<string, unknown>) =>
      gatePreflight(
        closedAll(PAIRED_GATES).map((gate) => (gate.number === 5 ? ({ ...gate, ...patch } as unknown as PairedGate) : gate)),
        "evaluation",
        "api-key",
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
