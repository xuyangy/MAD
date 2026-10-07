/**
 * Story 2-8b — the paired gate table's shape, and what `gatePreflight` lets pass.
 */

import { describe, expect, test } from "bun:test"

import { MEASURED_HOST } from "./managed-host.ts"
import { EVALUATION_RUN, EVALUATION_RUN_3_PROPOSAL, EVALUATION_RUN_4_PROPOSAL, EVALUATION_RUN_5_PROPOSAL, EVALUATION_RUN_PROPOSAL, gatePreflight, HUMAN_BUDGET_OWNER, OAUTH_PILOT_PROPOSAL, OAUTH_PILOT_RUN, oauthPilotEvidencePattern, oauthPilotReservation, PAIRED_GATES, PAIRED_NON_GATES, type PairedGate } from "./paired-gates.ts"

const closedAll = (gates: readonly PairedGate[]): PairedGate[] =>
  gates.map((gate) => ({ ...gate, status: "CLOSED", evidence: gate.evidence ?? "a reviewed change" }))

describe("PAIRED_GATES", () => {
  test("nine gates numbered 1-9, each with a name, kind, phase, owner, status and requirement", () => {
    expect(PAIRED_GATES.map((gate) => gate.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    for (const gate of PAIRED_GATES) {
      expect(gate.name.trim().length).toBeGreaterThan(0)
      expect(["engineering", "authorization"]).toContain(gate.kind)
      expect(["accounting-probe", "oauth-pilot", "evaluation"]).toContain(gate.phase)
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
      [7, "OAuth attempt accounting", "engineering", "evaluation", "story 2-8c3b", "CLOSED"],
      [8, "OAuth pilot spend authorization", "authorization", "oauth-pilot", HUMAN_BUDGET_OWNER, "OPEN"],
      [9, "api-key evaluation spend authorization", "authorization", "evaluation", HUMAN_BUDGET_OWNER, "OPEN"],
    ])
    // Routes: gates 1 and 9 cover the api-key route, gates 4, 7 and 8 the oauth route, and every other gate both.
    expect(PAIRED_GATES.map((gate) => [gate.number, gate.routes ?? "every route"])).toEqual([
      [1, ["api-key"]],
      [2, "every route"],
      [3, "every route"],
      [4, ["oauth"]],
      [5, "every route"],
      [6, "every route"],
      [7, ["oauth"]],
      [8, ["oauth"]],
      [9, ["api-key"]],
    ])
  })

  test("gate 7 is CLOSED on the pilot's run 3 and the zero-bill probe, and is never closed from the paid evaluation", () => {
    const gate = PAIRED_GATES.find((entry) => entry.number === 7)!
    expect(gate.status).toBe("CLOSED")
    for (const text of [
      "ablation/evidence/oauth-pilot-live-run-3-2026-09-30.json",
      "ablation/evidence/oauth-attempts-2026-09-25.json",
      "reviewed by the review channel on 2026-09-30",
      "the third admission was refused inside the journal with 0 backend calls",
      "settled unknown and abandoned, and latched a halt",
      "Scope: this build, the OAuth route and the pilot's one-slot discover attempts",
      "physical provider requests, host retries, side requests, host-reported tokens and subscription quota are neither established nor bounded by the attempt count",
      "a reused tunnel cannot count requests for either attempt",
      "not every proxy-observed connection followed an `issued` line",
      "not a complete egress census",
    ]) {
      expect(gate.evidence).toContain(text)
    }
    for (const text of ["2-8c3b", "zero-bill OAuth probe", "OpenAI's OAuth transport", "separately human-authorized bounded pilot", "before story 2-8d", "Never closed from the paid paired evaluation"]) {
      expect(gate.requires).toContain(text)
    }
  })

  test("gate 7's evidence files record what it says, and its note carries the limits and the earlier runs", async () => {
    const gate = PAIRED_GATES.find((entry) => entry.number === 7)!
    const read = async <T,>(path: string) => JSON.parse(await Bun.file(new URL(`../${path}`, import.meta.url)).text()) as T
    const probe = await read<{ summary: Record<string, string> }>("ablation/evidence/oauth-attempts-2026-09-25.json")
    for (const name of ["anthropic attempt", "copilot attempt", "attempt refused by a seeded gate", "hang past the turn deadline"]) expect(probe.summary[name]).toBe("HOLDS")
    const run3 = await read<{
      status?: string
      anyAttemptAnswered: boolean
      attempts: { answered: boolean; failure: string | null; settlement: { kind: string } }[]
      thirdAdmission: { asked: boolean; backendCalls: number }
      proxy: { connects: { target: string; outcome: string; window: string }[] }
      journal: { lines: { type: string }[] }
    }>("ablation/evidence/oauth-pilot-live-run-3-2026-09-30.json")
    expect(run3.status).toBeUndefined()
    expect(run3.anyAttemptAnswered).toBe(true)
    expect(run3.attempts.map((attempt) => [attempt.answered, attempt.failure, attempt.settlement.kind])).toEqual([[true, null, "usage"], [true, null, "usage"]])
    expect(run3.journal.lines.map((line) => line.type)).toEqual(["issued", "settled", "issued", "settled"])
    expect(run3.thirdAdmission).toMatchObject({ asked: true, backendCalls: 0 })
    expect(run3.proxy.connects.filter((connect) => connect.outcome === "tunnelled").map((connect) => [connect.target, connect.window])).toEqual([["chatgpt.com:443", "attempt 1"]])
    expect(run3.proxy.connects.filter((connect) => connect.outcome === "refused").map((connect) => [connect.target, connect.window])).toEqual([
      ["api.githubcopilot.com:443", "before the first admission was asked"],
      ["api.githubcopilot.com:443", "before the first admission was asked"],
    ])
    for (const text of [
      "Limits carried to story 2-8d",
      "session_message, session_entry, session_input, todo, session_share, workspace",
      "the runtime code-fetch risk stays open on an unsandboxed launch",
      "ablation/evidence/oauth-pilot-live-2026-09-28.json",
      "ablation/evidence/oauth-pilot-diagnosis-2026-09-28.json",
      "ablation/evidence/oauth-pilot-live-run-2-2026-09-29.json",
    ]) {
      expect(gate.note).toContain(text)
    }
  })

  test("gate 4 covers the oauth route alone, in admitted attempts, and is OPEN again: runs 1 to 5 are spent", () => {
    const gate = PAIRED_GATES.find((entry) => entry.number === 4)!
    expect(gate.routes).toEqual(["oauth"])
    expect(gate.status).toBe("OPEN")
    expect(gate.evidence).toBeUndefined()
    for (const text of ["oauth route in admitted attempts", "100 per block", "300 in total", "admission threshold", "The api-key route's spend is gate 9's"]) {
      expect(gate.requires).toContain(text)
    }
    for (const text of [
      "Run 5 was authorized on 2026-10-06 against _bmad-output/specs/spec-mad-orchestrator/stories/2-8d-run-5-proposal.md (sha256 613bc2fb489b37ae36258687b6de46f9b9615b6dd77876ad6905059cdd119589)",
      "each paired turn offered Read, Glob, Grep and StructuredOutput only",
      "ablation/evidence/paired-oauth-evaluation-run-5-2026-10-07.json (INCOMPLETE: no halt; block 2's ON continuation reached its 45-attempt allowance and failed with 2 findings unresolved",
      "153 attempts admitted, all settled with usage; 2 of 3 paired blocks completed",
      "with its committed reservation at ablation/evidence/paired-oauth-evaluation-run-5.reservation",
      "Run 4 was authorized on 2026-10-05 against _bmad-output/specs/spec-mad-orchestrator/stories/2-8d-run-4-proposal.md (sha256 19b58092c03761eaa5e1b757862f248fc0a5d8b855f78e8d660a0292ecf24bea)",
      "on the roster openai/gpt-6-sol, anthropic/claude-sonnet-5 and github-copilot/gpt-6-luna, each served by the provider it named",
      "ablation/evidence/paired-oauth-evaluation-run-4-2026-10-05.json (HALTED in block 1's ON continuation: a debate attempt on anthropic/claude-sonnet-5 timed out at its 600000 ms deadline",
      "23 attempts admitted, block 1 partially observed, 0 of 3 paired blocks completed, incomplete",
      "with its committed reservation at ablation/evidence/paired-oauth-evaluation-run-4.reservation",
      "Runs 1 to 3 used earlier authorizations of the same evaluation, all given on 2026-10-02",
      `against ${EVALUATION_RUN_PROPOSAL.path} (sha256 ${EVALUATION_RUN_PROPOSAL.sha256})`,
      "ablation/evidence/paired-oauth-evaluation-run-3-2026-10-02.json (CANCELLED by the human in block 1's shared prefix",
      "All five authorizations are spent; no further live run is authorized",
    ]) {
      expect(gate.note).toContain(text)
    }
    expect(gate.note).not.toContain("refuses")
  })

  test("run 5's committed reservation and evidence record what gate 4's note says", async () => {
    const read = async <T,>(path: string) => JSON.parse(await Bun.file(new URL(`../${path}`, import.meta.url)).text()) as T
    const reservation = await read<{ run: number; story: string; pins: string[] }>("ablation/evidence/paired-oauth-evaluation-run-5.reservation")
    expect(reservation).toMatchObject({ run: 5, story: "2-8d", pins: ["openai/gpt-6-sol", "anthropic/claude-sonnet-5", "github-copilot/gpt-6-luna"] })
    const evidence = await read<{ run: number; status: string; roster: { resolved: string[] }; attempts: { admitted: number; settled: { usage: number; unknown: number } } }>(
      "ablation/evidence/paired-oauth-evaluation-run-5-2026-10-07.json",
    )
    expect(evidence.run).toBe(5)
    expect(evidence.status).toContain("INCOMPLETE (no halt, no stop)")
    expect(evidence.roster.resolved).toContain("discovery-3 github-copilot/gpt-6-luna")
    expect(evidence.attempts.admitted).toBe(153)
    expect(evidence.attempts.settled).toEqual({ usage: 153, unknown: 0 })
  })

  test("the run-5 proposal gate 4 was authorized against is in the repository, byte for byte at its recorded sha256", async () => {
    expect(EVALUATION_RUN_5_PROPOSAL.sha256).toBe("613bc2fb489b37ae36258687b6de46f9b9615b6dd77876ad6905059cdd119589")
    const bytes = await Bun.file(new URL(`../${EVALUATION_RUN_5_PROPOSAL.path}`, import.meta.url)).arrayBuffer()
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(EVALUATION_RUN_5_PROPOSAL.sha256)
  })

  test("run 4's committed reservation and evidence record what gate 4's note says", async () => {
    const read = async <T,>(path: string) => JSON.parse(await Bun.file(new URL(`../${path}`, import.meta.url)).text()) as T
    const reservation = await read<{ run: number; story: string; pins: string[] }>("ablation/evidence/paired-oauth-evaluation-run-4.reservation")
    expect(reservation).toMatchObject({ run: 4, story: "2-8d", pins: ["openai/gpt-6-sol", "anthropic/claude-sonnet-5", "github-copilot/gpt-6-luna"] })
    const evidence = await read<{ run: number; status: string; roster: { resolved: string[] }; attempts: { admitted: number; settled: { usage: number; unknown: number } } }>(
      "ablation/evidence/paired-oauth-evaluation-run-4-2026-10-05.json",
    )
    expect(evidence.run).toBe(4)
    expect(evidence.status).toContain("HALTED (attempt-mode stop)")
    expect(evidence.roster.resolved).toContain("discovery-3 github-copilot/gpt-6-luna")
    expect(evidence.attempts.admitted).toBe(23)
    expect(evidence.attempts.settled).toEqual({ usage: 22, unknown: 1 })
  })

  test("the run-4 proposal gate 4 was authorized against is in the repository, byte for byte at its recorded sha256", async () => {
    expect(EVALUATION_RUN_4_PROPOSAL.sha256).toBe("19b58092c03761eaa5e1b757862f248fc0a5d8b855f78e8d660a0292ecf24bea")
    const bytes = await Bun.file(new URL(`../${EVALUATION_RUN_4_PROPOSAL.path}`, import.meta.url)).arrayBuffer()
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(EVALUATION_RUN_4_PROPOSAL.sha256)
  })

  test("run 3's committed reservation and evidence record what gate 4's note says", async () => {
    const read = async <T,>(path: string) => JSON.parse(await Bun.file(new URL(`../${path}`, import.meta.url)).text()) as T
    const reservation = await read<{ run: number; story: string; pins: string[] }>("ablation/evidence/paired-oauth-evaluation-run-3.reservation")
    expect(reservation).toMatchObject({ run: 3, story: "2-8d", pins: ["openai/gpt-6-sol", "anthropic/claude-opus-5-5", "github-copilot/gpt-6-luna"] })
    const evidence = await read<{ run: number; status: string; roster: { resolved: string[] }; attempts: { admitted: number; settled: { usage: number; unknown: number } } }>(
      "ablation/evidence/paired-oauth-evaluation-run-3-2026-10-02.json",
    )
    expect(evidence.run).toBe(3)
    expect(evidence.status).toContain("CANCELLED by the human")
    expect(evidence.roster.resolved).toContain("discovery-3 openai/gpt-6-luna")
    expect(evidence.attempts.admitted).toBe(6)
    expect(evidence.attempts.settled).toEqual({ usage: 3, unknown: 3 })
  })

  test("the run-3 proposal gate 4 was authorized against is in the repository, byte for byte at its recorded sha256", async () => {
    expect(EVALUATION_RUN_3_PROPOSAL.sha256).toBe("150dfff1df365d2115115aee57c3d3ccede50af13114f52973931cb057f43a40")
    const bytes = await Bun.file(new URL(`../${EVALUATION_RUN_3_PROPOSAL.path}`, import.meta.url)).arrayBuffer()
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(EVALUATION_RUN_3_PROPOSAL.sha256)
  })

  test("run 2's committed reservation and evidence record what gate 4's note says", async () => {
    const read = async <T,>(path: string) => JSON.parse(await Bun.file(new URL(`../${path}`, import.meta.url)).text()) as T
    const reservation = await read<{ run: number; story: string; pins: string[] }>("ablation/evidence/paired-oauth-evaluation-run-2.reservation")
    expect(reservation).toMatchObject({ run: 2, story: "2-8d", pins: ["openai/gpt-6-luna", "anthropic/claude-opus-5-5", "github-copilot/gpt-5-mini"] })
    const evidence = await read<{ run: number; status: string; attempts: { admitted: number; settled: { usage: number; unknown: number } } }>(
      "ablation/evidence/paired-oauth-evaluation-run-2-2026-10-02.json",
    )
    expect(evidence.run).toBe(2)
    expect(evidence.status).toContain("HALTED (attempt-mode stop)")
    expect(evidence.attempts.admitted).toBe(26)
    expect(evidence.attempts.settled).toEqual({ usage: 23, unknown: 3 })
  })

  test("the run proposal gate 4 was authorized against is in the repository, byte for byte at its recorded sha256", async () => {
    const bytes = await Bun.file(new URL(`../${EVALUATION_RUN_PROPOSAL.path}`, import.meta.url)).arrayBuffer()
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(EVALUATION_RUN_PROPOSAL.sha256)
  })

  test("run 1's committed reservation and evidence record what gate 4's note says", async () => {
    const read = async <T,>(path: string) => JSON.parse(await Bun.file(new URL(`../${path}`, import.meta.url)).text()) as T
    const [prior] = EVALUATION_RUN.prior
    expect(prior!.run).toBe(1)
    const reservation = await read<{ run: number; story: string; pins: string[]; gateTableBlob: string }>(prior!.reservation)
    expect(reservation).toMatchObject({ run: 1, story: "2-8d", pins: ["openai/gpt-6-luna", "anthropic/claude-opus-5-5", "github-copilot/gpt-5-mini"] })
    const evidence = await read<{ run: number; status: string; billing: string; diagnosis: { conclusion: string } }>(
      prior!.evidence,
    )
    expect(evidence.run).toBe(1)
    expect(evidence.status).toContain("FAILED at stage 2")
    expect(evidence.billing).toContain("no admitted attempt")
    expect(evidence.diagnosis.conclusion).toContain("what the host waited on is not established")
    const diagnosis = await read<{ diagnoses: string; cases: { name: string; elapsedMs: { gitFirst: number } }[]; conclusion: string }>(
      "ablation/evidence/paired-oauth-evaluation-run-1-diagnosis-2026-10-02.json",
    )
    expect(diagnosis.diagnoses).toBe(prior!.evidence)
    expect(diagnosis.cases.map((entry) => entry.name)).toContain("OAuth mode, the real sign-ins")
    for (const entry of diagnosis.cases) expect(entry.elapsedMs.gitFirst, entry.name).toBeLessThan(10_000)
    expect(diagnosis.conclusion).toContain("none is ruled out")
  })

  test("gate 9 holds the api-key route's spend in ledger tokens, OPEN, and gate 4 never stands in for it", () => {
    const gate = PAIRED_GATES.find((entry) => entry.number === 9)!
    expect(gate.routes).toEqual(["api-key"])
    expect(gate.status).toBe("OPEN")
    expect(gate.evidence).toBeUndefined()
    for (const text of ["api-key route in ledger tokens", "PAIRED_ALLOWANCES, unchanged", "Closing gate 4, which covers only the oauth route, never stands in for it"]) {
      expect(gate.requires).toContain(text)
    }
  })

  test("exactly gates 3, 4, 8 and 9 are authorization gates, owned by the human budget owner, and OPEN", () => {
    const authorization = PAIRED_GATES.filter((gate) => gate.kind === "authorization")
    expect(authorization.map((gate) => gate.number)).toEqual([3, 4, 8, 9])
    for (const gate of authorization) expect(gate.owner).toBe(HUMAN_BUDGET_OWNER)
    expect(authorization.map((gate) => gate.status)).toEqual(["OPEN", "OPEN", "OPEN", "OPEN"])
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

  test("gate 8 authorizes one bounded OAuth pilot run, and never stands in for gate 4 or closes gate 7", () => {
    const gate = PAIRED_GATES.find((entry) => entry.number === 8)!
    expect(gate.status).toBe("OPEN")
    expect(gate.evidence).toBeUndefined()
    for (const text of [
      "authorized run 1 on 2026-09-28",
      "ablation/evidence/oauth-pilot-live-2026-09-28.json (FAILED: attempt 1 returned model-error without an answer",
      "found a token-refresh 401 for that attempt (ablation/evidence/oauth-pilot-diagnosis-2026-09-28.json)",
      "ablation/evidence/oauth-pilot-live.reservation",
      "That authorization is spent.",
      "authorized run 2 on 2026-09-29",
      "ablation/evidence/oauth-pilot-live-run-2-2026-09-29.json (FAILED at host preflight",
      "ablation/evidence/oauth-pilot-live-run-2.reservation",
      "That authorization is spent too.",
      "authorized run 3 on 2026-09-30",
      "ablation/evidence/oauth-pilot-live-run-3-2026-09-30.json (both attempts answered and settled usage",
      "ablation/evidence/oauth-pilot-live-run-3.reservation",
      "no further live run is authorized",
    ]) {
      expect(gate.note).toContain(text)
    }
    expect(gate.requires).toContain(OAUTH_PILOT_PROPOSAL.sha256)
    expect(gate.requires).toContain("the budget owner authorizes run 3 (`OAUTH_PILOT_RUN`, stories 2-8c7 and 2-8c8)")
    expect(gate.requires).toContain("before the reservation, `--live` checks the managed host's binary hash and prepared digests, refusing with the authorization unused on a mismatch")
    expect(gate.requires).toContain(`creates ${oauthPilotReservation(OAUTH_PILOT_RUN.run)} exclusively`)
    expect(oauthPilotReservation(OAUTH_PILOT_RUN.run)).toBe("ablation/evidence/oauth-pilot-live-run-3.reservation")
    for (const text of ["`bun run oauth-pilot --live`", "at most 2 admitted attempts", "openai/gpt-6-luna", "2-8d-openai-oauth-pilot-proposal.md", "never stands in for gate 4 or closes gate 7"]) {
      expect(gate.requires).toContain(text)
    }
  })

  test("OAUTH_PILOT_RUN names run 3; its prior runs are run 1 under its legacy names and run 2 under its own, as committed", () => {
    expect(OAUTH_PILOT_RUN.run).toBe(3)
    expect(OAUTH_PILOT_RUN.prior.map((prior) => prior.run)).toEqual([1, 2])
    const [run1, run2] = OAUTH_PILOT_RUN.prior
    expect(run1).toEqual({
      run: 1,
      reservation: "ablation/evidence/oauth-pilot-live.reservation",
      evidence: "ablation/evidence/oauth-pilot-live-2026-09-28.json",
      proposalSha256: "1245e11370e7df1e9f73a9c2b356334327c315ef0d079c9bd208c275df893402",
    })
    expect(run2).toEqual({
      run: 2,
      reservation: "ablation/evidence/oauth-pilot-live-run-2.reservation",
      evidence: "ablation/evidence/oauth-pilot-live-run-2-2026-09-29.json",
      proposalSha256: "8bd4b660bbe0881a989a8ac75a973f4486ba06e77a3ccddb76598476dfa4dcc5",
    })
    expect(run1!.reservation).toBe(oauthPilotReservation(1))
    expect(run2!.reservation).toBe(oauthPilotReservation(2))
    expect(oauthPilotEvidencePattern(1).test(run1!.evidence.split("/").pop()!)).toBe(true)
    expect(oauthPilotEvidencePattern(2).test(run2!.evidence.split("/").pop()!)).toBe(true)
    expect(run2!.proposalSha256).not.toBe(OAUTH_PILOT_PROPOSAL.sha256)
    expect(oauthPilotEvidencePattern(2).test("oauth-pilot-live-run-2-2026-10-01.json")).toBe(true)
    expect(oauthPilotEvidencePattern(2).test("oauth-pilot-live-2026-10-01.json")).toBe(false)
    expect(oauthPilotEvidencePattern(1).test("oauth-pilot-live-run-2-2026-10-01.json")).toBe(false)
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
  test("the shipped table refuses the api-key evaluation on gate 9 alone; gates 4 and 7 are not consulted", () => {
    const result = gatePreflight(PAIRED_GATES, "evaluation", "api-key")
    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([
      `gate 9 (api-key evaluation spend authorization) is OPEN; owner: ${HUMAN_BUDGET_OWNER}; closing it requires: ${PAIRED_GATES[8]!.requires}`,
    ])
    expect(result.lines).toHaveLength(PAIRED_GATES.length)
    expect(result.lines[2]).toContain("(not consulted for evaluation)")
    expect(result.lines[3]).toContain(
      "gate 4 — evaluation spend authorization — authorization, required for evaluation on route oauth (not consulted for route api-key), owner the human budget owner — OPEN",
    )
    expect(result.lines[6]).toContain(
      "gate 7 — OAuth attempt accounting — engineering, required for evaluation on route oauth (not consulted for route api-key)",
    )
    expect(result.lines[0]).toContain("required for evaluation on route api-key, owner story 2-8c2 — CLOSED")
  })

  test("the shipped table refuses the oauth evaluation on gate 4 alone; gates 1 and 9 are not consulted", () => {
    const result = gatePreflight(PAIRED_GATES, "evaluation", "oauth")
    expect(result.ok).toBe(false)
    expect(result.problems.map((problem) => problem.split(" ").slice(0, 2).join(" "))).toEqual(["gate 4"])
    expect(result.lines[0]).toContain("host request accounting — engineering, required for evaluation on route api-key (not consulted for route oauth)")
    expect(result.lines[3]).toContain("gate 4 — evaluation spend authorization — authorization, required for evaluation on route oauth, owner the human budget owner — OPEN — note:")
    expect(result.lines[7]).toContain("gate 8 — OAuth pilot spend authorization — authorization, required for oauth-pilot on route oauth (not consulted for evaluation)")
    expect(result.lines[8]).toContain("gate 9 — api-key evaluation spend authorization — authorization, required for evaluation on route api-key (not consulted for route oauth)")
    // Gate 4 CLOSED alone opens the oauth evaluation, and leaves the api-key route on gate 9.
    const closed = PAIRED_GATES.map((gate) => (gate.number === 4 ? { ...gate, status: "CLOSED" as const, evidence: "authorized" } : gate))
    expect(gatePreflight(closed, "evaluation", "oauth").ok).toBe(true)
    expect(gatePreflight(closed, "evaluation", "api-key").problems.map((problem) => problem.split(" ").slice(0, 2).join(" "))).toEqual(["gate 9"])
  })

  test("the shipped table refuses the OAuth pilot on gate 8 alone", () => {
    const result = gatePreflight(PAIRED_GATES, "oauth-pilot", "oauth")
    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([`gate 8 (OAuth pilot spend authorization) is OPEN; owner: ${HUMAN_BUDGET_OWNER}; closing it requires: ${PAIRED_GATES[7]!.requires}`])
    for (const index of [0, 1, 2, 3, 4, 5, 6]) expect(result.lines[index]).toContain("(not consulted for oauth-pilot)")
  })

  test("gate 8 is required only for the pilot: closing it opens no evaluation, and the evaluation gates open no pilot", () => {
    const evaluationOpen = PAIRED_GATES.map((gate) => (gate.number === 4 ? { ...gate, status: "OPEN" as const, evidence: undefined } : gate))
    const pilotOnly = evaluationOpen.map((gate) => (gate.number === 8 ? { ...gate, status: "CLOSED" as const, evidence: "authorized" } : gate))
    expect(gatePreflight(pilotOnly, "oauth-pilot", "oauth").ok).toBe(true)
    expect(gatePreflight(pilotOnly, "evaluation", "api-key").problems.join("\n")).toContain("gate 9 (api-key evaluation spend authorization) is OPEN")
    expect(gatePreflight(pilotOnly, "evaluation", "oauth").problems.join("\n")).toContain("gate 4 (evaluation spend authorization) is OPEN")
    const allButEight = closedAll(PAIRED_GATES).map((gate) => (gate.number === 8 ? { ...gate, status: "OPEN" as const, evidence: undefined } : gate))
    expect(gatePreflight(allButEight, "evaluation", "api-key").ok).toBe(true)
    expect(gatePreflight(allButEight, "evaluation", "oauth").ok).toBe(true)
    expect(gatePreflight(allButEight, "oauth-pilot", "oauth").ok).toBe(false)
    // A table without gate 8 authorizes no pilot, whatever else is closed.
    const withoutEight = closedAll(PAIRED_GATES).filter((gate) => gate.number !== 8)
    expect(gatePreflight(withoutEight, "oauth-pilot", "oauth").problems).toContain(
      "the table holds no authorization gate for oauth-pilot on route oauth, so nothing authorizes its spend",
    )
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
    // Without gate 9, gate 4 (oauth only) leaves the api-key route with no authorization gate.
    const gates = closedAll(PAIRED_GATES).filter((gate) => gate.number !== 9)
    expect(gatePreflight(gates, "evaluation", "oauth").ok).toBe(true)
    expect(gatePreflight(gates, "evaluation", "api-key").problems).toContain(
      "the table holds no authorization gate for evaluation on route api-key, so nothing authorizes its spend",
    )
    // Gate 4 CLOSED never opens the api-key route, and gate 9 CLOSED never opens the oauth route.
    const nineOpen = closedAll(PAIRED_GATES).map((gate) => (gate.number === 9 ? { ...gate, status: "OPEN" as const, evidence: undefined } : gate))
    expect(gatePreflight(nineOpen, "evaluation", "oauth").ok).toBe(true)
    expect(gatePreflight(nineOpen, "evaluation", "api-key").problems.map((problem) => problem.split(" ").slice(0, 2).join(" "))).toEqual(["gate 9"])
    const fourOpen = closedAll(PAIRED_GATES).map((gate) => (gate.number === 4 ? { ...gate, status: "OPEN" as const, evidence: undefined } : gate))
    expect(gatePreflight(fourOpen, "evaluation", "api-key").ok).toBe(true)
    expect(gatePreflight(fourOpen, "evaluation", "oauth").problems.map((problem) => problem.split(" ").slice(0, 2).join(" "))).toEqual(["gate 4"])
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
    // With gate 9 left OPEN, closing everything else — gate 3 included — still refuses the api-key route.
    const allButNine = closedAll(PAIRED_GATES).map((gate) => (gate.number === 9 ? { ...gate, status: "OPEN" as const, evidence: undefined } : gate))
    const result = gatePreflight(allButNine, "evaluation", "api-key")
    expect(result.ok).toBe(false)
    expect(result.problems.join("\n")).toContain("gate 9 (api-key evaluation spend authorization) is OPEN")
    // A table whose only authorization gate is for the probe authorizes no evaluation, on either route.
    const relabelled = closedAll(PAIRED_GATES).filter((gate) => gate.number !== 4 && gate.number !== 9)
    for (const route of ["api-key", "oauth"] as const) {
      const refused = gatePreflight(relabelled, "evaluation", route)
      expect(refused.ok).toBe(false)
      expect(refused.problems.join("\n")).toContain("no authorization gate for evaluation")
    }
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
