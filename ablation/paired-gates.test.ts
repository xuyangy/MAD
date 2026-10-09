/**
 * Story 2-8b — the paired gate table's shape, and what `gatePreflight` lets pass.
 */

import { describe, expect, test } from "bun:test"

import { MEASURED_HOST } from "./managed-host.ts"
import { ADVERSARIAL_CANDIDATE_ITEMS, ADVERSARIAL_CANDIDATE_NON_GATES, ADVERSARIAL_RUN, adversarialReservation, adversarialRunProblem, CANDIDATE_CLAIM_WORDING, candidateProblems, candidateRecordProblems, GATE_PHASES, EVALUATION_RUN, EVALUATION_RUN_3_PROPOSAL, EVALUATION_RUN_4_PROPOSAL, EVALUATION_RUN_5_PROPOSAL, EVALUATION_RUN_PROPOSAL, gatePreflight, HUMAN_BUDGET_OWNER, OAUTH_PILOT_PROPOSAL, OAUTH_PILOT_RUN, oauthPilotEvidencePattern, oauthPilotReservation, PAIRED_GATES, PAIRED_NON_GATES, type CandidateNonGate, type PairedGate } from "./paired-gates.ts"

const closedAll = (gates: readonly PairedGate[]): PairedGate[] =>
  gates.map((gate) => ({ ...gate, status: "CLOSED", evidence: gate.evidence ?? "a reviewed change" }))

describe("PAIRED_GATES", () => {
  test("twelve gates numbered 1-12, each with a name, kind, phase, owner, status and requirement", () => {
    expect(PAIRED_GATES.map((gate) => gate.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    for (const gate of PAIRED_GATES) {
      expect(gate.name.trim().length).toBeGreaterThan(0)
      expect(["engineering", "authorization"]).toContain(gate.kind)
      expect(["accounting-probe", "oauth-pilot", "evaluation", "adversarial"]).toContain(gate.phase)
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
      [10, "adversarial spend authorization", "authorization", "adversarial", HUMAN_BUDGET_OWNER, "OPEN"],
      [11, "adversarial attempt accounting", "engineering", "adversarial", "story 2-7f2", "OPEN"],
      [12, "bounded materializer termination", "engineering", "adversarial", "story 2-7e2", "CLOSED"],
    ])
    // Routes: gates 1 and 9 cover the api-key route, gates 4, 7, 8 and 10 to 12 the oauth route, and every other gate both.
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
      [10, ["oauth"]],
      [11, ["oauth"]],
      [12, ["oauth"]],
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

  test("exactly gates 3, 4, 8, 9 and 10 are authorization gates, owned by the human budget owner, and OPEN", () => {
    const authorization = PAIRED_GATES.filter((gate) => gate.kind === "authorization")
    expect(authorization.map((gate) => gate.number)).toEqual([3, 4, 8, 9, 10])
    for (const gate of authorization) expect(gate.owner).toBe(HUMAN_BUDGET_OWNER)
    expect(authorization.map((gate) => gate.status)).toEqual(["OPEN", "OPEN", "OPEN", "OPEN", "OPEN"])
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

// ---------------------------------------------------------------------------
// Story 2-7e — the adversarial phase: gates 10 to 12, the run pin and the candidate record
// ---------------------------------------------------------------------------

describe("the adversarial phase of the gate table", () => {
  const adversarial = PAIRED_GATES.filter((gate) => gate.phase === "adversarial")

  test("`adversarial` is a phase, and gates 10, 11 and 12 are its gates: oauth-routed; 10 and 11 OPEN with no evidence, 12 CLOSED with evidence", () => {
    expect(GATE_PHASES).toEqual(["accounting-probe", "oauth-pilot", "evaluation", "adversarial"])
    expect(adversarial.map((gate) => gate.number)).toEqual([10, 11, 12])
    for (const gate of adversarial) expect(gate.routes).toEqual(["oauth"])
    expect(adversarial.map((gate) => gate.status)).toEqual(["OPEN", "OPEN", "CLOSED"])
    expect(adversarial.map((gate) => gate.evidence === undefined)).toEqual([true, true, false])
  })

  test("gate 10 is the human-owned spend authorization in admitted attempts, and names the run it covers", () => {
    const gate = PAIRED_GATES.find((entry) => entry.number === 10)!
    expect(gate.kind).toBe("authorization")
    expect(gate.owner).toBe(HUMAN_BUDGET_OWNER)
    for (const text of ["`ADVERSARIAL_RUN`", "in admitted attempts", "frozen protocol v3", "30 per run", "480 for the suite", "480 for the suite's own root", "bounds neither the physical requests"]) {
      expect(gate.requires, text).toContain(text)
    }
  })

  test("gate 11 is 2-7f2's real-host probe on the adversarial path, and gate 12 is 2-7e2's materializer termination", () => {
    const eleven = PAIRED_GATES.find((entry) => entry.number === 11)!
    expect(eleven.owner).toBe("story 2-7f2")
    expect(eleven.status).toBe("OPEN")
    expect(eleven.evidence).toBeUndefined()
    for (const text of ["story 2-7f2's zero-bill probe", "real host", "adversarial path", "reaches no backend"]) {
      expect(eleven.requires, text).toContain(text)
    }
    const twelve = PAIRED_GATES.find((entry) => entry.number === 12)!
    expect(twelve.owner).toBe("story 2-7e2")
    expect(twelve.requires).toContain("ablation/adversarial-materialize.ts")
    // The requirement names the approved policy: an immediate SIGKILL, never a graceful escalation.
    expect(twelve.requires).toContain("is sent SIGKILL with no graceful period")
    expect(twelve.requires).not.toContain("escalated")
    // Closed on 2-7e2's accepted evidence, scoped to stand-ins and the oauth route.
    for (const text of ["accepted by the review channel on 2026-10-09 at commit 9166c42", "`GitNotReturned`", "no status is synthesized", "quarantines the suite and retains the lock", "no real host and no hung real git", "nothing here says api-key materialization is safe", "Tests: ablation/adversarial-materialize.test.ts"]) {
      expect(twelve.evidence, text).toContain(text)
    }
    expect(twelve.evidence).toContain("If the call has not completed when its nominal 60,000 ms event-loop deadline fires")
    expect(twelve.evidence).toContain("a failed signal delivery is reported")
    expect(twelve.evidence).toContain("no process group is killed")
    // Cancellation is not bounded by the per-call budgets, and the note claims no bound for it.
    expect(twelve.note).toContain("cancellation during materialization does not interrupt it")
    expect(twelve.note).toContain("no cancellation-response or guaranteed wall-clock bound is established")
  })

  test("no gate text mentions the token allowance of the api-key design", () => {
    const text = JSON.stringify([PAIRED_GATES, ADVERSARIAL_RUN, ADVERSARIAL_CANDIDATE_NON_GATES])
    expect(text).not.toContain("400,000")
    expect(text).not.toContain("400000")
  })

  test("ADVERSARIAL_RUN is run 1 with no prior run, its reservation, and pins not yet chosen; a consumer refuses it", () => {
    expect(ADVERSARIAL_RUN).toEqual({ run: 1, pins: null, reservation: "ablation/evidence/adversarial-oauth-run-1.reservation", prior: [] })
    expect(ADVERSARIAL_RUN.reservation).toBe(adversarialReservation(1))
    expect(adversarialRunProblem()).toContain("`ADVERSARIAL_RUN.pins` is null, which means not yet chosen")
    // A chosen pin is accepted; anything that is not one provider/model pin is not.
    expect(adversarialRunProblem({ ...ADVERSARIAL_RUN, pins: ["anthropic/claude-sonnet-5"] })).toBeNull()
    for (const pins of [[], ["anthropic/claude-sonnet-5", "openai/gpt-6-sol"], ["no-slash"], [""]]) {
      expect(adversarialRunProblem({ ...ADVERSARIAL_RUN, pins }), JSON.stringify(pins)).toContain("are not exactly one `provider/model` pin")
    }
    expect(adversarialRunProblem({ ...ADVERSARIAL_RUN, pins: ["a/b"], reservation: "elsewhere" })).toContain("is not `ablation/evidence/adversarial-oauth-run-1.reservation`")
    expect(adversarialRunProblem({ ...ADVERSARIAL_RUN, run: 0, pins: ["a/b"] })).toContain("is not a whole number from 1")
  })

  test("run N lists exactly runs 1 to N-1 in `prior`, in order, each with its own reservation and an evidence file", () => {
    const earlier = (run: number) => ({ run, reservation: adversarialReservation(run), evidence: `ablation/evidence/adversarial-oauth-run-${run}-2026-10-20.json` })
    const three = { run: 3, pins: ["anthropic/claude-sonnet-5"], reservation: adversarialReservation(3), prior: [earlier(1), earlier(2)] }
    expect(adversarialRunProblem(three)).toBeNull()
    const cases: [string, typeof three.prior, string][] = [
      ["none listed", [], "must list exactly its 2 earlier run(s) in `prior`, and it lists 0"],
      ["one missing", [earlier(1)], "must list exactly its 2 earlier run(s) in `prior`, and it lists 1"],
      ["one too many", [earlier(1), earlier(2), earlier(3)], "must list exactly its 2 earlier run(s) in `prior`, and it lists 3"],
      ["out of order", [earlier(2), earlier(1)], "`prior` entry 1 is not run 1"],
      ["a run repeated", [earlier(1), earlier(1)], "`prior` entry 2 is not run 2"],
      ["another run's reservation", [earlier(1), { ...earlier(2), reservation: adversarialReservation(1) }], "`prior` run 2 names the reservation"],
      ["no evidence", [earlier(1), { ...earlier(2), evidence: " " }], "`prior` run 2 names no evidence file"],
    ]
    for (const [name, prior, why] of cases) expect(adversarialRunProblem({ ...three, prior }), name).toContain(why)
    // Run 1 has no earlier run, and listing one is refused.
    expect(adversarialRunProblem({ ...ADVERSARIAL_RUN, pins: ["a/b"], prior: [earlier(1)] })).toContain("must list exactly its 0 earlier run(s)")
  })
})

describe("the item-7 candidate non-gate record", () => {
  const seven = ADVERSARIAL_CANDIDATE_NON_GATES.find((entry) => entry.item === 7)!
  const resolved = (over: Partial<CandidateNonGate> = {}): CandidateNonGate => ({
    ...seven,
    status: "NON-GATING",
    evidence: "story 2-7f walked the launcher's import closure and call path; tests: scripts/adversarial.test.ts",
    ...over,
  })

  test("it holds item 7, NON-GATING, validated by story 2-7f, worded as reach and nothing more", () => {
    expect(ADVERSARIAL_CANDIDATE_ITEMS).toEqual([7])
    expect(ADVERSARIAL_CANDIDATE_NON_GATES).toHaveLength(1)
    expect(seven.status).toBe("NON-GATING")
    expect(seven.validatedBy).toBe("story 2-7f")
    expect(CANDIDATE_CLAIM_WORDING).toBe("not reached by this launcher and configuration")
    expect(seven.claim).toContain(CANDIDATE_CLAIM_WORDING)
    // The evidence names the scans and the closure walk, and does not claim repo.ts is absent.
    for (const text of [
      "story 2-7f's source and tests, on stand-in hosts and a scripted backend; no real host was run",
      "import closure of scripts/adversarial.ts",
      "the two exceptions: adapters/opencode/repo.ts, which defines `opencodeRepo` and `repo.change`, and adapters/opencode/plugin.ts, which calls them only inside the `mad_review` tool's `execute` handler, not at module top level",
      `the claim is that the reads are ${CANDIDATE_CLAIM_WORDING}, and nothing more`,
      "`DEFAULT_DISCOVERY_SLOTS`",
      "takes `GitError` alone",
      "repo.ts and plugin.ts stay in the closure",
      "Tests: scripts/adversarial.test.ts",
    ]) {
      expect(seven.evidence, text).toContain(text)
    }
    // It never says "bounded", "fixed" or "checked": none of those is what the record could establish.
    expect(JSON.stringify(seven)).not.toMatch(/bounded|fixed|checked/i)
    // Acceptance is not presented as pending, and no file is claimed to name neither.
    expect(seven.evidence).not.toContain("for review at acceptance")
    expect(seven.evidence).not.toMatch(/no file names/i)
  })

  test("the shipped record is resolved, so it no longer blocks", () => {
    expect(candidateRecordProblems(ADVERSARIAL_CANDIDATE_NON_GATES)).toEqual([])
    // An OPEN copy of it still blocks.
    expect(candidateRecordProblems([{ ...seven, status: "OPEN", evidence: undefined }])).toEqual([
      "candidate non-gate 7 (review-path reads (`adapters/opencode/repo.ts`)) is OPEN: story 2-7f has not validated that it is not reached by this launcher and configuration, so it blocks",
    ])
  })

  test("only a well-formed record resolved NON-GATING with evidence passes", () => {
    expect(candidateRecordProblems([resolved()])).toEqual([])
  })

  test("an absent, empty or duplicated record, and one for the wrong item, are each unresolved", () => {
    expect(candidateRecordProblems(undefined)).toEqual(["the candidate non-gate record is absent, so prerequisite 7 is unresolved"])
    expect(candidateRecordProblems(null)).toEqual(["the candidate non-gate record is absent, so prerequisite 7 is unresolved"])
    expect(candidateRecordProblems([])).toEqual(["the candidate non-gate record holds no entry for prerequisite 7, so it is unresolved"])
    expect(candidateRecordProblems([resolved(), resolved()])).toContain("the candidate non-gate record holds 2 entries for prerequisite 7")
    const wrong = candidateRecordProblems([resolved({ item: 6 })])
    expect(wrong).toContain("the candidate non-gate record holds no entry for prerequisite 7, so it is unresolved")
    expect(wrong.join("\n")).toContain("names a prerequisite the adversarial phase has no candidate for")
  })

  test("a malformed record is refused: resolved without evidence, OPEN with evidence, an unknown status, a missing field, the wrong wording", () => {
    const cases: [string, CandidateNonGate, string][] = [
      ["resolved without evidence", resolved({ evidence: undefined }), "is NON-GATING with no evidence recorded, so it is not resolved"],
      ["resolved with blank evidence", resolved({ evidence: "   " }), "is NON-GATING with no evidence recorded, so it is not resolved"],
      ["OPEN with evidence", resolved({ status: "OPEN" }), "is OPEN but carries evidence"],
      ["an unknown status", resolved({ status: "CLOSED" as never }), 'has status "CLOSED", which is neither OPEN nor NON-GATING'],
      ["no validating story", resolved({ validatedBy: "" }), "is malformed: it needs a name, a validating story, a claim, a basis and a reopening condition"],
      ["no reopening condition", resolved({ reopensWhen: undefined as never }), "is malformed: it needs a name"],
      ["another claim", resolved({ claim: "the reads are safe" }), `its claim does not say "${CANDIDATE_CLAIM_WORDING}"`],
      ["says bounded", resolved({ evidence: "the reads are bounded" }), 'it says "bounded"'],
      ["says fixed", resolved({ basis: "the reads were fixed" }), 'it says "fixed"'],
      ["says checked", resolved({ evidence: "checked by hand" }), 'it says "checked"'],
    ]
    for (const [name, record, why] of cases) {
      expect(candidateRecordProblems([record]).join("\n"), name).toContain(why)
    }
    expect(candidateRecordProblems([null as never]).join("\n")).toContain("holds an entry that is not an object")
  })
})

describe("gatePreflight for the adversarial phase", () => {
  const allClosed = closedAll(PAIRED_GATES)
  const seven = ADVERSARIAL_CANDIDATE_NON_GATES[0]!
  const resolved: CandidateNonGate = { ...seven, status: "NON-GATING", evidence: "validated on the launcher path; tests: scripts/adversarial.test.ts" }
  const open: CandidateNonGate = { ...seven, status: "OPEN", evidence: undefined }
  const candidateProblem =
    "candidate non-gate 7 (review-path reads (`adapters/opencode/repo.ts`)) is OPEN: story 2-7f has not validated that it is not reached by this launcher and configuration, so it blocks"
  // `ADVERSARIAL_RUN` is the table's own, so its problem is reported whatever gates a caller supplies.
  const runProblem = adversarialRunProblem()!
  const chosen = { ...ADVERSARIAL_RUN, pins: ["anthropic/claude-sonnet-5"] }

  test("the shipped table refuses on gates 10 and 11 and on the run whose pins are not chosen; the resolved candidate adds no refusal", () => {
    const result = gatePreflight(PAIRED_GATES, "adversarial", "oauth")
    expect(result.ok).toBe(false)
    expect(result.problems.map((problem) => problem.split(" ").slice(0, 2).join(" "))).toEqual(["gate 10", "gate 11", "adversarial run"])
    expect(runProblem).toContain("`ADVERSARIAL_RUN.pins` is null")
    expect(result.problems).toContain(runProblem)
    expect(result.problems).not.toContain(candidateProblem)
    expect(result.lines).toContain("adversarial run 1 — pins not yet chosen")
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8]) expect(result.lines[index]).toContain("(not consulted for adversarial)")
    expect(result.lines[9]).toContain("gate 10 — adversarial spend authorization — authorization, required for adversarial on route oauth, owner the human budget owner — OPEN")
    expect(result.lines.at(-1)).toBe("candidate non-gate 7 — review-path reads (`adapters/opencode/repo.ts`) — validated by story 2-7f — NON-GATING")
  })

  test("with gates 10 to 12 CLOSED a supplied record still refuses when it is empty, null, OPEN, or resolved without evidence", () => {
    // Omitted: the canonical record is consulted, and it is resolved; only the run refuses.
    expect(gatePreflight(allClosed, "adversarial", "oauth")).toMatchObject({ ok: false, problems: [runProblem] })
    const supplied: [string, readonly CandidateNonGate[] | null, string][] = [
      ["empty", [], "the candidate non-gate record holds no entry for prerequisite 7, so it is unresolved"],
      ["null", null, "the candidate non-gate record is absent, so prerequisite 7 is unresolved"],
      ["resolved without evidence", [{ ...resolved, evidence: undefined }], "is NON-GATING with no evidence recorded, so it is not resolved"],
      ["still open", [open], candidateProblem],
    ]
    for (const [name, record, why] of supplied) {
      const result = gatePreflight(allClosed, "adversarial", "oauth", record, chosen)
      expect(result.ok, name).toBe(false)
      expect(result.problems.join("\n"), name).toContain(why)
    }
  })

  test("a supplied resolved record adds nothing, and the phase opens only with every gate CLOSED and a run whose pin is chosen", () => {
    expect(gatePreflight(allClosed, "adversarial", "oauth", [resolved]).problems).toEqual([runProblem])
    expect(gatePreflight(allClosed, "adversarial", "oauth", undefined, chosen)).toMatchObject({ ok: true, problems: [] })
    expect(gatePreflight(allClosed, "adversarial", "oauth", undefined, chosen).lines).toContain("adversarial run 1 — pins anthropic/claude-sonnet-5")
    // The supplied run is checked by the same rule: a malformed one refuses.
    expect(gatePreflight(allClosed, "adversarial", "oauth", undefined, { ...chosen, pins: ["a/b", "c/d"] }).problems.join("\n")).toContain("are not exactly one `provider/model` pin")
  })

  test("a supplied candidate record can never remove the canonical record's refusal: an OPEN canonical record refuses whatever is supplied", () => {
    for (const supplied of [undefined, [resolved], [], null, [open]] as const) {
      expect(candidateProblems([open], supplied), JSON.stringify(supplied)).toContain(candidateProblem)
    }
    // A resolved canonical record adds no refusal, and a supplied unresolved one still adds its own.
    expect(candidateProblems(ADVERSARIAL_CANDIDATE_NON_GATES)).toEqual([])
    expect(candidateProblems(ADVERSARIAL_CANDIDATE_NON_GATES, [open])).toEqual([candidateProblem])
    // gatePreflight is that function over the shipped record.
    for (const supplied of [undefined, [resolved], [], null, [open]] as const) {
      const problems = gatePreflight(allClosed, "adversarial", "oauth", supplied, chosen).problems
      expect(problems, JSON.stringify(supplied)).toEqual(candidateProblems(ADVERSARIAL_CANDIDATE_NON_GATES, supplied))
    }
  })

  test("with every gate CLOSED the phase cannot pass while `ADVERSARIAL_RUN.pins` is null", () => {
    expect(ADVERSARIAL_RUN.pins).toBeNull()
    const result = gatePreflight(allClosed, "adversarial", "oauth")
    expect(result.ok).toBe(false)
    expect(result.problems[0]).toBe(runProblem)
    // No supplied candidate record removes it either.
    for (const record of [undefined, [], null] as const) expect(gatePreflight(allClosed, "adversarial", "oauth", record).problems).toContain(runProblem)
  })

  test("the api-key route has no authorization gate for the phase, so it refuses whatever is closed", () => {
    const result = gatePreflight(allClosed, "adversarial", "api-key", undefined, chosen)
    expect(result.ok).toBe(false)
    expect(result.problems).toContain("the table holds no authorization gate for adversarial on route api-key, so nothing authorizes its spend")
  })

  test("closing a paired or pilot gate never stands in for an adversarial one, and the reverse", () => {
    const pairedClosed = PAIRED_GATES.map((gate) => (gate.phase === "adversarial" ? gate : { ...gate, status: "CLOSED" as const, evidence: gate.evidence ?? "a reviewed change" }))
    expect(gatePreflight(pairedClosed, "adversarial", "oauth").problems.map((problem) => problem.split(" ").slice(0, 2).join(" "))).toEqual([
      "gate 10",
      "gate 11",
      "adversarial run",
    ])
    // Gate 12 ships CLOSED, so its own refusal is checked on a table that re-opens it.
    const twelveOpen = pairedClosed.map((gate) => (gate.number === 12 ? { ...gate, status: "OPEN" as const, evidence: undefined } : gate))
    expect(gatePreflight(twelveOpen, "adversarial", "oauth").problems.map((problem) => problem.split(" ").slice(0, 2).join(" "))).toEqual([
      "gate 10",
      "gate 11",
      "gate 12",
      "adversarial run",
    ])
    const adversarialClosed = PAIRED_GATES.map((gate) => (gate.phase === "adversarial" ? { ...gate, status: "CLOSED" as const, evidence: "a reviewed change" } : gate))
    expect(gatePreflight(adversarialClosed, "evaluation", "oauth").problems.map((problem) => problem.split(" ").slice(0, 2).join(" "))).toEqual(["gate 4"])
    expect(gatePreflight(adversarialClosed, "oauth-pilot", "oauth").problems.map((problem) => problem.split(" ").slice(0, 2).join(" "))).toEqual(["gate 8"])
  })
  test("a paired phase refuses on its own gates only: no candidate line, and a supplied record changes nothing", () => {
    for (const [phase, route, numbers] of [
      ["evaluation", "api-key", ["gate 9"]],
      ["evaluation", "oauth", ["gate 4"]],
      ["oauth-pilot", "oauth", ["gate 8"]],
      ["accounting-probe", "api-key", ["gate 3"]],
    ] as const) {
      const plain = gatePreflight(PAIRED_GATES, phase, route)
      expect(plain.problems.map((problem) => problem.split(" ").slice(0, 2).join(" ")), `${phase} ${route}`).toEqual([...numbers])
      expect(plain.lines).toHaveLength(PAIRED_GATES.length)
      expect(plain.lines.some((line) => line.startsWith("candidate non-gate") || line.startsWith("adversarial run"))).toBe(false)
      expect(plain.problems.some((problem) => problem.includes("ADVERSARIAL_RUN"))).toBe(false)
      for (const index of [9, 10, 11]) expect(plain.lines[index]).toContain(`(not consulted for ${phase})`)
      for (const record of [[], null, [resolved]] as const) expect(gatePreflight(PAIRED_GATES, phase, route, record)).toEqual(plain)
    }
    // The adversarial gates add nothing to a paired phase: with them removed from the table, its problems and its lines for gates 1 to 9 are the same.
    const before = PAIRED_GATES.filter((gate) => gate.phase !== "adversarial")
    for (const [phase, route] of [["evaluation", "api-key"], ["evaluation", "oauth"], ["oauth-pilot", "oauth"], ["accounting-probe", "api-key"]] as const) {
      expect(gatePreflight(PAIRED_GATES, phase, route).problems).toEqual(gatePreflight(before, phase, route).problems)
      expect(gatePreflight(PAIRED_GATES, phase, route).lines.slice(0, before.length)).toEqual(gatePreflight(before, phase, route).lines)
    }
  })
})
