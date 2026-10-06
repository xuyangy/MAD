/**
 * Story 2-8d — the permission probe's own logic: what the scripted model answers,
 * and what each case must show. The probe itself drives the measured host and is
 * run by hand (`bun run permission-probe`).
 */

import { describe, expect, test } from "bun:test"

import { caseVerdict, EXPECTED_TOOLS, EXTERNAL_PATH, normalizeToolName, PROMPT_MS, scriptedAnswer, type CaseObservation } from "./permission-probe.ts"

const ALL = ["mcp_Bash", "mcp_Edit", "mcp_Glob", "mcp_Grep", "mcp_Question", "mcp_Read", "mcp_StructuredOutput", "mcp_Write"]
const READ_ONLY = ["mcp_Glob", "mcp_Grep", "mcp_Read", "mcp_StructuredOutput"]

describe("the scripted model", () => {
  test("tool names are normalized from the Anthropic route's mcp_ prefix", () => {
    expect(normalizeToolName("mcp_StructuredOutput")).toBe("structuredoutput")
    expect(normalizeToolName("read")).toBe("read")
  })

  test("a request with no answer tool is a side request and gets plain text", () => {
    expect(scriptedAnswer("read-external", ["mcp_Read"], false)).toEqual({ kind: "text" })
  })

  test("read-external: the first answer reads the external path, the next answers", () => {
    expect(scriptedAnswer("read-external", READ_ONLY, false)).toEqual({ kind: "tool", tool: "mcp_Read", input: { filePath: EXTERNAL_PATH } })
    expect(scriptedAnswer("read-external", READ_ONLY, true)).toEqual({ kind: "tool", tool: "mcp_StructuredOutput", input: { findings: [] } })
  })

  test("question: the first answer calls question when it is offered, and answers directly when it is not", () => {
    const asked = scriptedAnswer("question", ALL, false)
    expect(asked.kind === "tool" && asked.tool).toBe("mcp_Question")
    expect(scriptedAnswer("question", READ_ONLY, false)).toEqual({ kind: "tool", tool: "mcp_StructuredOutput", input: { findings: [] } })
  })
})

describe("a case's checks", () => {
  const base: CaseObservation = { scenario: "read-external", allowlist: false, ok: true, elapsedMs: 2700, modelRequests: 2, offered: [...EXPECTED_TOOLS], toolResults: [{ refused: true, externalText: false }], firstCall: "read" }

  test("a prompt, refused read over the read-only tools holds", () => {
    expect(caseVerdict(base).holds).toBe(true)
  })

  test("a turn that ran to its deadline fails, as runs 2 and 4 did", () => {
    const verdict = caseVerdict({ ...base, ok: false, elapsedMs: 45_000, toolResults: [] })
    expect(verdict.holds).toBe(false)
    expect(verdict.checks.find((entry) => entry.check.startsWith("the turn ended ok"))!.holds).toBe(false)
    expect(PROMPT_MS).toBeLessThan(45_000)
  })

  test("the external file's text reaching the model fails, even when the turn ended", () => {
    expect(caseVerdict({ ...base, toolResults: [{ refused: false, externalText: true }] }).holds).toBe(false)
  })

  test("any tool beyond read-only exploration and the answer fails", () => {
    expect(caseVerdict({ ...base, offered: [...EXPECTED_TOOLS, "bash"] }).holds).toBe(false)
  })

  test("question: offered, or not answered first, fails", () => {
    const question: CaseObservation = { ...base, scenario: "question", toolResults: [], firstCall: "structuredoutput" }
    expect(caseVerdict(question).holds).toBe(true)
    expect(caseVerdict({ ...question, offered: [...EXPECTED_TOOLS, "question"], firstCall: "question" }).holds).toBe(false)
  })
})
