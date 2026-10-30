/**
 * CAP-5 — the judge's blame, through the REAL `opencodeTools` adapter under the
 * inherit policy the ablation runs use, written by the shipped trace sink and
 * read back by `readToolTrace` and `assessToolRun`.
 *
 * In a version-2 trace the judge calls the port and then records the `made`
 * request. Under the inherit policy the adapter writes its invocation before its
 * first await, so the invocation line precedes the request line, and the reader
 * joins the two. A stop that lands while the request is written lands after the
 * call: the adapter refuses at launch, and the trace still reads without an
 * orphan fact.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { opencodeTools } from "../adapters/opencode/tools.ts"
import { isolateGitHome } from "../adapters/opencode/test-support/git-home.ts"
import { setupGit } from "../adapters/opencode/test-support/repo-snapshot.ts"
import type { BudgetLedger } from "../core/budget/ledger.ts"
import type { Finding } from "../core/domain/finding.ts"
import type { Roster, RosterSlot } from "../core/domain/roster.ts"
import { emptyLedger } from "../core/domain/run-record.ts"
import { material } from "../core/prompt/material.ts"
import { judge } from "../core/stages/judge.ts"
import { FakeBackend, fakeClock } from "../core/test-support/fakes.ts"
import { assessToolRun } from "./adversarial-read.ts"
import { createToolTraceSink, readToolTrace, TOOL_TRACE_FILE, TOOL_TRACE_VERSION, type TraceIo } from "./tool-trace.ts"

isolateGitHome()

const COMMIT = ["-c", "user.name=Ada", "-c", "user.email=ada@example.invalid", "-c", "commit.gpgsign=false"]
let worktree: string
const scratch: string[] = []

beforeAll(async () => {
  worktree = await mkdtemp(join(tmpdir(), "mad-trace-stop-repo-"))
  await setupGit(worktree, ["init", "-q", "-b", "main"])
  await writeFile(join(worktree, "pay.ts"), "const fee = 1\nconst rate = 2\nconst total = fee * rate\n")
  await setupGit(worktree, ["add", "pay.ts"])
  await setupGit(worktree, [...COMMIT, "commit", "-q", "--no-verify", "-m", "the rate check"])
})

afterAll(async () => {
  for (const dir of [worktree, ...scratch]) if (dir !== undefined) await rm(dir, { recursive: true, force: true })
})

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

const IDS = ["discovery-1", "discovery-2", "discovery-3"]
const ROSTER: Roster = { slots: IDS.map(slot), lensSlots: [], requested: 3, distinctLineages: 3, providers: ["p"] }

function finding(id: string): Finding {
  return {
    id,
    claim: "the fee is applied before the rate is validated",
    reasoning: "a NaN rate silently produces a NaN total",
    locus: { file: "pay.ts", startLine: 1, endLine: 2 },
    severity: "high",
    author: "discovery-1",
    source: "pool",
    coDiscovery: { raised: 3, answered: 3 },
    route: "judge",
    history: [],
  }
}

/** One judged run through the real adapter, and the trace's reading. */
async function judged(options: { stopAtRequest: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), "mad-trace-stop-"))
  scratch.push(dir)
  const file = join(dir, TOOL_TRACE_FILE)
  const stop = new AbortController()
  // With `stopAtRequest`, the stop fires during the request line's append.
  const io: TraceIo = {
    async appendLine(path, text) {
      if (options.stopAtRequest && text.includes('"type":"request"') && !stop.signal.aborted) stop.abort()
      await appendFile(path, text, "utf8")
    },
  }
  const sink = createToolTraceSink({ file, binding: { caseId: "case-1", side: "attack", position: 1 }, io })
  const tools = opencodeTools({ worktree, toolObservation: sink, gitReadPolicy: "inherit", signal: stop.signal })
  const findings = [finding("f-1")]
  const result = await judge({
    findings,
    roster: ROSTER,
    answeredSlots: IDS,
    backend: new FakeBackend({}),
    input: `# Change under review\n\n${material("change under review", "diff goes here")}`,
    clock: fakeClock(),
    ledger: emptyLedger() as BudgetLedger,
    runId: "run-1",
    signal: stop.signal,
    tools,
    toolObservation: sink,
  })
  const read = await readToolTrace(file)
  if (read.kind !== "read") throw new Error(`the trace was not read: ${read.kind}`)
  const reading = assessToolRun(
    {
      runId: "run-1",
      record: { findings: result.findings, judgeCounts: result, warnings: result.warnings },
      lines: read.lines,
      torn: read.torn,
      traceProblem: null,
    },
    { path: "pay.ts", startLine: 1, endLine: 2 },
  )
  return { read, reading, findings, stopped: stop.signal.aborted }
}

describe("tool trace — the real inherit-policy adapter, written in the version-2 order (CAP-5)", () => {
  test("NO STOP: invocation, request, shell outcome, outcome; one request and one execution, observed", async () => {
    const { read, reading, findings } = await judged({ stopAtRequest: false })

    expect(TOOL_TRACE_VERSION).toBe(2)
    expect(read.torn).toEqual([])
    expect(read.lines.every((line) => line.v === 2)).toBe(true)
    expect(read.lines.map((line) => line.type)).toEqual(["invoked", "request", "shellOutcome", "outcome"])
    expect(read.lines.map((line) => line.seq)).toEqual([1, 2, 3, 4])
    expect(reading.requests).toEqual({ status: "observed", count: 1, reasons: [] })
    expect(reading.executions).toEqual({ status: "observed", count: 1, reasons: [] })
    expect(findings[0]!.history.map((entry) => entry.kind)).toContain("judge-blame-executed")
  })

  test("A STOP DURING THE REQUEST WRITE: the call came first, the adapter refused at launch, and the trace reads with no orphan fact", async () => {
    const { read, reading, findings, stopped } = await judged({ stopAtRequest: true })

    expect(stopped).toBe(true)
    expect(read.torn).toEqual([])
    // The adapter recorded its invocation as the call started, then refused to
    // launch once it saw the stop: no shell outcome.
    expect(read.lines.map((line) => line.type)).toEqual(["invoked", "request", "outcome"])
    const reasons = [...reading.requests.reasons, ...reading.executions.reasons]
    expect(reasons.filter((reason) => reason.includes("orphan"))).toEqual([])
    expect(reading.requests.count).toBe(1)
    expect(findings[0]!.history.map((entry) => entry.kind)).toContain("judge-blame-stopped")
    expect(findings[0]!.unresolved?.reason).toBe("the run was cancelled while it was being judged")
  })
})
