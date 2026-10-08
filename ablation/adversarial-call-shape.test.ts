/**
 * Story 2-7d — the adversarial suite's call shape, zero-bill: how many backend
 * `runTurn` invocations one one-slot run makes, per stage, through
 * `runAdversarialSuite` and the production `review()` pipeline. In this fixture
 * every invocation is an issued attempt, and the journal's recorded requests are
 * checked against them. It is the evidence protocol v3 B4 cites for its call
 * shape, and it also pins that v3 is refused while it is a draft, that v3's hash
 * rule reproduces, and that v1 and v2 are unchanged.
 *
 * EVIDENCE OF THE PIPELINE'S STRUCTURE, NOT VERIFICATION OF THE ATTEMPT-MODE
 * GOVERNOR. The suite here runs the token-mode journal; the attempt-mode
 * adversarial gate is covered by `journal-adversarial.test.ts` and
 * `adversarial.test.ts`. Every answer here is scripted by this file, so nothing
 * here says what a live model would do or how often.
 *
 * NOT EXERCISED HERE: v3 B8's `StructuredOutput`-only host-tool offer. This
 * backend reports `tools: true` and no host is involved; story 2-7f verifies the
 * offer on the real host.
 *
 * A TEST-LOCAL BACKEND, because the shared `scriptedAdversarialBackend` answers
 * every debate turn with no turns at all, which can never exercise an argued
 * finding. This one answers discovery as scripted, every debate finding with an
 * author position, and each of the four judge roles with a valid answer.
 */

import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"

import type { ZodType } from "zod"

import { emptyTokenUsage } from "../core/domain/run-record.ts"
import { CODING_DEBATE_GENERALIST } from "../core/instructions/coding/debate.ts"
import { CODING_DISCOVERY_GENERALIST } from "../core/instructions/coding/discovery.ts"
import type { LateUsageReporter } from "../core/ports/late-usage.ts"
import { cancelledTurn, type BackendCapabilities, type Envelope, type ModelBackend } from "../core/ports/model-backend.ts"
import { DEFAULT_JUDGE_ANSWERS, judgeRoleOf, type JudgeRoleTag } from "../core/test-support/fakes.ts"
import { runAdversarialSuite, type AdversarialRunContext, type AdversarialSuiteOutcome } from "./adversarial.ts"
import { frozenV3Copy, PROTOCOL_FILE as PROTOCOL_V1, payloadFinding, sealedSuite, targetFinding } from "./adversarial-read.fixture.ts"
import { readFrozenProtocol, sha256 } from "./schedule.ts"

const SPECS = new URL("../_bmad-output/specs/spec-mad-orchestrator/", import.meta.url).pathname
const PROTOCOL_V2 = `${SPECS}evaluation-protocol-v2.md`
const PROTOCOL_V3 = `${SPECS}evaluation-protocol-v3.md`

const HERE = process.cwd()
const scratch: string[] = []
afterEach(async () => {
  // `opencodeTools` rebinds Bun's shared `$` to each worktree; restore it.
  $.cwd(HERE)
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})

type Stage = "discover" | "debate" | "judge"
type Position = "upholds" | "withdraws"
type Ok = Extract<AdversarialSuiteOutcome, { ok: true }>

interface Call extends AdversarialRunContext {
  stage: Stage
  role?: JudgeRoleTag
  input: string
  ok: boolean
}

interface Failure {
  stage: Stage
  role?: JudgeRoleTag
  /** Fail only calls whose input carries the case's target claim. */
  onTarget?: boolean
  /** How many matching calls in each run fail, in order. */
  times: 1 | 2
}

interface Shape {
  /** The discovery answer. Default: the case's target finding, plus the payload's finding on an attack run. */
  discovery?: (context: AdversarialRunContext) => unknown
  /** The author's position on one debated finding, given the finding's id and its section of the prompt. Default `upholds`. */
  position?: (context: AdversarialRunContext, findingId: string, section: string) => Position
  /** Answer every debate turn with no turns at all: an empty transcript. */
  silent?: boolean
  /** Calls that return `model-error`. */
  fail?: Failure
}

/** The findings a debate prompt puts to the participant, in prompt order, each with its section of the prompt. */
function debatedFindings(input: string): { id: string; section: string }[] {
  const headings = [...input.matchAll(/^## finding `([^`]+)`/gm)]
  return headings.map((match, index) => ({
    id: match[1]!,
    section: input.slice(match.index, headings[index + 1]?.index ?? input.length),
  }))
}

function stageOf(instructions: string, role: JudgeRoleTag | undefined): Stage {
  if (role !== undefined) return "judge"
  if (instructions === CODING_DISCOVERY_GENERALIST.text) return "discover"
  if (instructions === CODING_DEBATE_GENERALIST.text) return "debate"
  throw new Error(`a runTurn whose instructions are no judge role, discovery or debate: ${instructions.slice(0, 80)}`)
}

const targetClaim = (caseId: string) => String(targetFinding(caseId).claim)
const payloadClaim = (caseId: string) => String(payloadFinding(caseId).claim)

function critical(finding: Record<string, unknown>): Record<string, unknown> {
  return { ...finding, severity: "critical" }
}

function callShapeBackend(shape: Shape = {}) {
  const calls: Call[] = []
  const failures = new Map<number, number>()
  const backendFor = (context: AdversarialRunContext, _reporter: LateUsageReporter): ModelBackend => ({
    capabilities: (): BackendCapabilities => ({ tools: true }),
    async runTurn<T>(slot: string, instructions: string, input: string, schema: ZodType<T>, signal?: AbortSignal): Promise<Envelope<T>> {
      const role = judgeRoleOf(instructions)
      const stage = stageOf(instructions, role)
      const record = (ok: boolean) => calls.push({ ...context, stage, ...(role === undefined ? {} : { role }), input, ok })
      if (signal?.aborted) {
        record(false)
        return cancelledTurn<T>(slot)
      }
      const tokens = { ...emptyTokenUsage(), input: 10, output: 20 }
      const fail = shape.fail
      if (
        fail !== undefined &&
        fail.stage === stage &&
        (fail.role === undefined || fail.role === role) &&
        (!fail.onTarget || input.includes(targetClaim(context.caseId))) &&
        (failures.get(context.position) ?? 0) < fail.times
      ) {
        failures.set(context.position, (failures.get(context.position) ?? 0) + 1)
        record(false)
        return { ok: false, slot, failure: "model-error", message: "scripted model error", tokens }
      }
      record(true)
      let payload: unknown
      if (role !== undefined) payload = DEFAULT_JUDGE_ANSWERS[role]
      else if (stage === "discover") {
        payload = shape.discovery?.(context) ?? {
          findings: [targetFinding(context.caseId), ...(context.side === "attack" ? [payloadFinding(context.caseId)] : [])],
        }
      } else if (shape.silent) payload = { turns: [] }
      else {
        const debated = debatedFindings(input)
        if (debated.length === 0) throw new Error("a debate prompt with no finding heading: the empty-transcript path would match silently")
        payload = {
          turns: debated.map(({ id, section }) => ({
            findingId: id,
            position: shape.position?.(context, id, section) ?? "upholds",
            argument: "The cited lines say what the finding claims.",
          })),
        }
      }
      const parsed = schema.safeParse(payload)
      if (!parsed.success) throw new Error(`the scripted ${stage} payload did not parse: ${parsed.error.message}`)
      return { ok: true, slot, value: parsed.data, tokens }
    },
  })
  return { calls, backendFor }
}

/** Run the sixteen sealed slots over the test-local backend. */
async function suiteWith(shape: Shape = {}, options: { complete?: boolean } = {}) {
  const sealed = await sealedSuite(scratch)
  const backend = callShapeBackend(shape)
  const outcome = await runAdversarialSuite({ ...sealed.input, backendFor: backend.backendFor })
  if (!outcome.ok) throw new Error(outcome.reason)
  expect(outcome.slots).toHaveLength(16)
  if (options.complete ?? true) expect(outcome.complete).toBe(true)
  return { outcome, calls: backend.calls, schedule: sealed.schedule }
}

const callsOf = (calls: readonly Call[], position: number) => calls.filter((call) => call.position === position)

/** Backend `runTurn` invocations per stage for one run. */
function stagesOf(calls: readonly Call[], position: number): Record<Stage, number> {
  const mine = callsOf(calls, position)
  return {
    discover: mine.filter((call) => call.stage === "discover").length,
    debate: mine.filter((call) => call.stage === "debate").length,
    judge: mine.filter((call) => call.stage === "judge").length,
  }
}

/** The journal's recorded requests per stage for one run equal the backend's invocations. */
function expectJournalMatches(outcome: Ok, calls: readonly Call[]): void {
  for (const slot of outcome.slots) {
    expect(slot.runId).toBeDefined()
    const requests = outcome.bill.requests.filter((request) => request.runId === slot.runId)
    expect({
      discover: requests.filter((request) => request.stage === "discover").length,
      debate: requests.filter((request) => request.stage === "debate").length,
      judge: requests.filter((request) => request.stage === "judge").length,
    }).toEqual(stagesOf(calls, slot.position))
  }
  expect(outcome.bill.requests).toHaveLength(calls.length)
}

/**
 * v3 B4's planned successful turns, under its stated conditions: N canonical
 * findings, C of them effectively critical, W of those withdrawn.
 */
function plannedTurns(n: number, c: number, w: number): number {
  if (!(0 <= w && w <= c && c <= n)) throw new RangeError(`plannedTurns needs 0 <= w <= c <= n, and got n=${n}, c=${c}, w=${w}`)
  return 1 + (c > 0 ? 1 : 0) + (n - c) + 4 * (c - w)
}

const ADJUDICATE: JudgeRoleTag[] = ["evidence-extract", "fact-check", "logic-eval", "aggregate"]

/**
 * Two critical findings on every run, clean runs included. STRUCTURAL ONLY: a
 * clean run's discovery is not expected to raise the payload's path; the second
 * finding is there to put two critical findings in front of the one debate turn.
 */
const twoCritical = (context: AdversarialRunContext) => ({
  findings: [critical(targetFinding(context.caseId)), critical(payloadFinding(context.caseId))],
})

describe("the one-slot call shape: backend runTurn invocations per run and per stage (scripted, zero-bill)", () => {
  test("plannedTurns refuses counts outside 0 <= w <= c <= n", () => {
    expect(() => plannedTurns(1, 2, 0)).toThrow(RangeError)
    expect(() => plannedTurns(2, 1, 2)).toThrow(RangeError)
    expect(() => plannedTurns(1, 0, -1)).toThrow(RangeError)
    expect(plannedTurns(9, 0, 0)).toBe(10)
    expect(plannedTurns(9, 1, 0)).toBe(14)
    expect(plannedTurns(9, 2, 0)).toBe(17)
  })

  test("the default script: a clean run invokes runTurn 2 times (discover, judge), an attack run 3, as the journal records", async () => {
    const { calls, outcome, schedule } = await suiteWith()
    for (const slot of schedule.slots) {
      const expected = slot.side === "clean" ? { discover: 1, debate: 0, judge: 1 } : { discover: 1, debate: 0, judge: 2 }
      expect(stagesOf(calls, slot.position)).toEqual(expected)
      expect(callsOf(calls, slot.position)).toHaveLength(plannedTurns(slot.side === "clean" ? 1 : 2, 0, 0))
    }
    // A non-critical finding at 1/1 co-discovery is judged verify-independently: one fact-check.
    expect(calls.filter((call) => call.stage === "judge").every((call) => call.role === "fact-check")).toBe(true)
    expectJournalMatches(outcome, calls)
  })

  test("two critical findings, both argued: discover 1, ONE debate invocation covering both, the four adjudicate roles each", async () => {
    const { calls, outcome, schedule } = await suiteWith({ discovery: twoCritical })
    for (const slot of schedule.slots) {
      expect(stagesOf(calls, slot.position)).toEqual({ discover: 1, debate: 1, judge: 8 })
      expect(callsOf(calls, slot.position)).toHaveLength(plannedTurns(2, 2, 0))
      const debate = callsOf(calls, slot.position).find((call) => call.stage === "debate")!
      expect(debatedFindings(debate.input)).toHaveLength(2)
      const roles = callsOf(calls, slot.position)
        .filter((call) => call.stage === "judge")
        .map((call) => call.role!)
      expect([...roles].sort()).toEqual([...ADJUDICATE, ...ADJUDICATE].sort())
    }
    expectJournalMatches(outcome, calls)
  })

  test("a critical finding its author withdraws costs no judge invocation; the upheld one gets the four adjudicate roles", async () => {
    const withdrawn = new Map<number, string>()
    const { calls, outcome, schedule } = await suiteWith({
      discovery: twoCritical,
      position: (context, findingId, section) => {
        if (!section.includes(payloadClaim(context.caseId))) return "upholds"
        withdrawn.set(context.position, findingId)
        return "withdraws"
      },
    })
    for (const slot of schedule.slots) {
      expect(stagesOf(calls, slot.position)).toEqual({ discover: 1, debate: 1, judge: 4 })
      expect(callsOf(calls, slot.position)).toHaveLength(plannedTurns(2, 2, 1))
      const judged = callsOf(calls, slot.position).filter((call) => call.stage === "judge")
      expect(judged.map((call) => call.role!).sort()).toEqual([...ADJUDICATE].sort())
      expect(judged.some((call) => call.input.includes(payloadClaim(slot.caseId)))).toBe(false)
    }
    // The record names the withdrawn finding by the id the debate turn withdrew.
    for (const slot of outcome.slots) {
      if (slot.manifest?.kind !== "written") throw new Error(`slot ${slot.position} wrote no manifest`)
      const record = JSON.parse(await readFile(join(slot.manifest.directory, "record.json"), "utf8")) as {
        findings: { id: string; verdict?: string; claim: string }[]
      }
      const id = withdrawn.get(slot.position)
      expect(id).toBeDefined()
      const finding = record.findings.find((candidate) => candidate.id === id)!
      expect(finding.claim).toBe(payloadClaim(slot.caseId))
      expect(finding.verdict).toBe("withdrawn-by-author")
      expect(record.findings.filter((candidate) => candidate.id !== id).map((candidate) => candidate.verdict)).toEqual(["upheld"])
    }
    expectJournalMatches(outcome, calls)
  })

  test("a critical finding with an empty transcript falls back to one verify-independently judge invocation", async () => {
    const { calls, outcome, schedule } = await suiteWith({
      discovery: (context) => ({ findings: [critical(targetFinding(context.caseId))] }),
      silent: true,
    })
    for (const slot of schedule.slots) {
      expect(stagesOf(calls, slot.position)).toEqual({ discover: 1, debate: 1, judge: 1 })
      expect(callsOf(calls, slot.position).filter((call) => call.stage === "judge").map((call) => call.role)).toEqual(["fact-check"])
      // Outside B4's conditions: the critical finding is not argued, so of its 4 judge turns
      // only the fact-check is issued, 3 fewer than planned.
      expect(callsOf(calls, slot.position)).toHaveLength(plannedTurns(1, 1, 0) - 3)
    }
    expectJournalMatches(outcome, calls)
  })
})

describe("retries: a failed turn issues at most 2 attempts, so planned turns and issued attempts differ", () => {
  test("one discover model-error: 2 attempts for 1 planned turn, the retry journaled as attempt 2", async () => {
    const { calls, outcome, schedule } = await suiteWith({ fail: { stage: "discover", times: 1 } })
    for (const slot of schedule.slots) {
      const planned = plannedTurns(slot.side === "clean" ? 1 : 2, 0, 0)
      const issued = callsOf(calls, slot.position)
      expect(stagesOf(calls, slot.position).discover).toBe(2)
      expect(issued.filter((call) => call.ok)).toHaveLength(planned)
      expect(issued).toHaveLength(planned + 1)
    }
    expectJournalMatches(outcome, calls)
    const retries = outcome.bill.requests.filter((request) => request.attempt === 2)
    expect(retries).toHaveLength(schedule.slots.length)
    expect(retries.every((request) => request.stage === "discover")).toBe(true)
  })

  test("one judge model-error: the fact-check is retried once", async () => {
    const { calls, outcome, schedule } = await suiteWith({ fail: { stage: "judge", role: "fact-check", onTarget: true, times: 1 } })
    for (const slot of schedule.slots) {
      const planned = plannedTurns(slot.side === "clean" ? 1 : 2, 0, 0)
      expect(callsOf(calls, slot.position)).toHaveLength(planned + 1)
      expect(callsOf(calls, slot.position).filter((call) => call.ok)).toHaveLength(planned)
    }
    expectJournalMatches(outcome, calls)
    const retries = outcome.bill.requests.filter((request) => request.attempt === 2)
    expect(retries).toHaveLength(schedule.slots.length)
    expect(retries.every((request) => request.stage === "judge")).toBe(true)
  })

  test("one debate model-error: the batched debate turn is retried once", async () => {
    const { calls, outcome, schedule } = await suiteWith({ discovery: twoCritical, fail: { stage: "debate", times: 1 } })
    for (const slot of schedule.slots) {
      expect(stagesOf(calls, slot.position)).toEqual({ discover: 1, debate: 2, judge: 8 })
      expect(callsOf(calls, slot.position)).toHaveLength(plannedTurns(2, 2, 0) + 1)
    }
    expectJournalMatches(outcome, calls)
    expect(outcome.bill.requests.filter((request) => request.attempt === 2).every((request) => request.stage === "debate")).toBe(true)
  })

  test("a turn that fails twice in a row is not attempted a third time", async () => {
    const { calls, outcome, schedule } = await suiteWith(
      { fail: { stage: "judge", role: "fact-check", onTarget: true, times: 2 } },
      { complete: false },
    )
    for (const slot of schedule.slots) {
      const onTarget = callsOf(calls, slot.position).filter((call) => call.stage === "judge" && call.input.includes(targetClaim(slot.caseId)))
      expect(onTarget.map((call) => call.ok)).toEqual([false, false])
    }
    expect(outcome.bill.requests.some((request) => request.attempt > 2)).toBe(false)
    expectJournalMatches(outcome, calls)
  })
})

describe("protocol v3's state, and v1 and v2 unchanged", () => {
  test("readFrozenProtocol refuses v3 while it is a draft, and verifies it once it is frozen", async () => {
    const text = await readFile(PROTOCOL_V3, "utf8")
    const status = /^status: (.*)$/m.exec(text)?.[1]?.trim()
    expect(["draft", "frozen"]).toContain(status!)
    const read = await readFrozenProtocol(PROTOCOL_V3)
    if (status === "draft") {
      expect(read.ok).toBe(false)
      if (!read.ok) expect(read.reason).toContain("is not a frozen protocol")
      expect(text).toMatch(/^frozen_on: null$/m)
      expect(text).toMatch(/^frozen_hash: null$/m)
    } else {
      expect(read).toMatchObject({ ok: true, version: 3 })
    }
  })

  test("v3's hash rule reproduces: a temporary copy frozen by v2's rule verifies", async () => {
    // The banner's own mention of `frozen_hash:` sits inside a blockquote and is not a line the rule rewrites.
    expect(await readFile(PROTOCOL_V3, "utf8")).toContain("`frozen_hash:`")
    const copy = await frozenV3Copy(scratch)
    const text = await readFile(copy.file, "utf8")
    expect(text).toContain("`frozen_hash:`")
    expect(sha256(text.replace(/^frozen_hash: .*$/gm, "frozen_hash: PENDING"))).toBe(copy.hash)
    expect(await readFrozenProtocol(copy.file)).toEqual({ ok: true, id: "PROTOCOL-mad-evaluation-v3", version: 3, hash: copy.hash })
  })

  test("v1 still verifies at its pinned hash", async () => {
    expect(await readFrozenProtocol(PROTOCOL_V1)).toMatchObject({
      ok: true,
      version: 1,
      hash: "sha256:a572141bc69494d43e04380f9ca83dcdb004ffc31ff630e61e4b67d353a61ac0",
    })
  })

  test("v2 still verifies by its frozen_hash rule", async () => {
    expect(await readFrozenProtocol(PROTOCOL_V2)).toMatchObject({
      ok: true,
      version: 2,
      hash: "sha256:82c7f07fe82bc293d750c61b89f7d4b850b81e6449a79df9f13531fec093c4f2",
    })
  })
})
