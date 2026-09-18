/**
 * Story 2-7b — the adversarial reader against the story's I/O matrix: the two
 * diagnostics, their coverage rules, the ambiguity rule, delivery, the manifest
 * binding, and the `eval-read` entry point. Unit rows drive `assessToolRun` and
 * `resolveTargetVerdict` directly; the rest read bundles the real runner wrote
 * over a scripted backend and real git.
 */

import { $ } from "bun"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { appendFile, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { Finding } from "../core/domain/finding.ts"
import type { ToolTerminalOutcome } from "../core/ports/tool-observation.ts"
import { ADVERSARIAL_ASSERTIONS } from "../fixtures/adversarial/assertions.ts"
import { main as evalRead } from "../scripts/eval-read.ts"
import { runAdversarialSuite } from "./adversarial.ts"
import { ADVERSARIAL_SLOT_STATUS_FILE, adversarialScheduleHashOf, ADVERSARIAL_SCHEDULE_FILE } from "./adversarial-schedule.ts"
import {
  assessToolRun,
  BOUNDED_EVIDENCE,
  NO_CAUSATION,
  ONE_SLOT_SCOPE,
  readAdversarialBundle,
  renderAdversarialBundle,
  resolveTargetVerdict,
  SECOND_ROUTE_UNOBSERVED,
  toolSummary,
  UNATTRIBUTED_TORN_RULE,
  verdictSummary,
  type ToolRunContext,
} from "./adversarial-read.ts"
import { experimentRoot, sealedSuite } from "./adversarial-read.fixture.ts"
import { adversarialDirectory } from "./adversarial-schedule.ts"
import { JOURNAL_FILE } from "./journal.ts"
import { ADVERSARIAL_READER_MODULE } from "./report.ts"
import type { TraceLine } from "./tool-trace.ts"

const HERE = process.cwd()
const scratch: string[] = []
afterEach(async () => {
  $.cwd(HERE)
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Synthetic traces for the unit rows
// ---------------------------------------------------------------------------

const PREDICATE = { path: "src/db/client.ts", startLine: 1, endLine: 3 }
const MATCHING = { path: "src/db/client.ts", startLine: 1, endLine: 3 }
const OTHER = { path: "src/orders/lookup.ts", startLine: 14, endLine: 14 }

function traceOf(runId = "run-1") {
  const lines: TraceLine[] = []
  let seq = 0
  const base = () => ({ slot: "adv-01:attack", v: 1, position: 2, seq: (seq += 1) })
  const context = (observationId: string, finding = "finding-1", run = runId) => ({ runId: run, findingId: finding, observationId, tool: "blame" as const })
  return {
    lines,
    request(observationId: string, args = MATCHING, finding = "finding-1", run = runId) {
      lines.push({ ...base(), type: "request", event: { context: context(observationId, finding, run), request: { kind: "made", args }, at: "t" } })
    },
    invoked(args = MATCHING) {
      lines.push({ ...base(), type: "invoked", fact: { tool: "blame", args, argv: ["git"], at: "t" } })
    },
    shell(args = MATCHING, exitCode = 0) {
      lines.push({ ...base(), type: "shellOutcome", fact: { tool: "blame", args, exitCode, launch: exitCode === 0 ? "proved" : "unproved", stderr: "", at: "t" } })
    },
    outcome(observationId: string, outcome: ToolTerminalOutcome, finding = "finding-1", run = runId) {
      lines.push({ ...base(), type: "outcome", event: { context: context(observationId, finding, run), outcome, at: "t" } })
    },
  }
}

function finding(id: string, extra: Partial<Finding> = {}): Finding {
  return { id, claim: "c", reasoning: "r", locus: { file: "src/x.ts", startLine: 1, endLine: 1 }, history: [{ stage: "judge" }], verdict: "upheld", ...extra } as unknown as Finding
}

function context(lines: TraceLine[], findings: Finding[] = [finding("finding-1")], extra: Partial<ToolRunContext> = {}): ToolRunContext {
  return {
    runId: "run-1",
    record: { findings, judgeCounts: {} as never, warnings: [] },
    lines,
    torn: [],
    traceProblem: null,
    ...extra,
  }
}

describe("tool action — coverage per endpoint, against the presealed predicate", () => {
  test("a complete trace: one matching request, executed", () => {
    const t = traceOf()
    t.request("o-1")
    t.invoked()
    t.shell()
    t.outcome("o-1", { kind: "executed" })
    const reading = assessToolRun(context(t.lines), PREDICATE)
    expect(reading.requests).toEqual({ status: "observed", count: 1, reasons: [] })
    expect(reading.executions).toEqual({ status: "observed", count: 1, reasons: [] })
  })

  test("STRANDED FINDING: a finding stranded before blame leaves the request count incomplete, reason named", () => {
    const t = traceOf()
    const stranded = finding("finding-9", { verdict: undefined, unresolved: { diedAtStage: "judge", reason: "budget" } } as Partial<Finding>)
    const reading = assessToolRun(context(t.lines, [stranded]), PREDICATE)
    expect(reading.requests.status).toBe("incomplete")
    expect(reading.requests.reasons.join()).toContain("stranded before blame")
    expect(reading.executions.status).toBe("incomplete")
  })

  test("a finding that reached the judge with no request event leaves the request count incomplete", () => {
    const reading = assessToolRun(context([]), PREDICATE)
    expect(reading.requests.status).toBe("incomplete")
    expect(reading.requests.reasons.join()).toContain("reached the judge and has no request event")
  })

  test("TORN TRACE: a torn row makes both counts incomplete, and the known positive is kept", () => {
    const t = traceOf()
    t.request("o-1")
    t.invoked()
    t.shell()
    t.outcome("o-1", { kind: "executed" })
    const reading = assessToolRun(
      context(t.lines, undefined, { torn: [{ row: 5, slot: "adv-01:attack", tail: true, why: "the last row is incomplete" }] }),
      PREDICATE,
    )
    expect(reading.requests).toMatchObject({ status: "incomplete", count: 1 })
    expect(reading.executions).toMatchObject({ status: "incomplete", count: 1 })
  })

  test("UNKNOWN ON TARGET: the matching request is counted; the execution count is incomplete", () => {
    const t = traceOf()
    t.request("o-1")
    t.invoked()
    t.shell(MATCHING, 128)
    t.outcome("o-1", { kind: "invoked-unknown", exitCode: 128, why: "fatal" })
    const reading = assessToolRun(context(t.lines), PREDICATE)
    expect(reading.requests).toEqual({ status: "observed", count: 1, reasons: [] })
    expect(reading.executions.status).toBe("incomplete")
    expect(reading.executions.count).toBe(0)
  })

  test("UNKNOWN ELSEWHERE: a non-matching unknown with no matching request is zero matching executions, complete", () => {
    const t = traceOf()
    t.request("o-1", OTHER)
    t.invoked(OTHER)
    t.outcome("o-1", { kind: "unknown", why: "interrupted" })
    const reading = assessToolRun(context(t.lines), PREDICATE)
    expect(reading.requests).toEqual({ status: "observed", count: 0, reasons: [] })
    expect(reading.executions).toEqual({ status: "observed", count: 0, reasons: [] })
  })

  test("MISSING TERMINAL: a matching request with no outcome row leaves the execution count incomplete", () => {
    const t = traceOf()
    t.request("o-1")
    t.invoked()
    const reading = assessToolRun(context(t.lines), PREDICATE)
    expect(reading.requests.status).toBe("observed")
    expect(reading.executions.status).toBe("incomplete")
    expect(reading.executions.reasons.join()).toContain("no terminal outcome row")
  })

  test("BAD JOIN: an orphan outcome, a cross-run join and mismatched arguments each leave the affected count incomplete", () => {
    const orphan = traceOf()
    orphan.outcome("o-7", { kind: "executed" })
    const a = assessToolRun(context(orphan.lines, []), PREDICATE)
    expect(a.requests.status).toBe("incomplete")
    expect(a.requests.reasons.join()).toContain("orphan")

    const crossRun = traceOf()
    crossRun.request("o-1", MATCHING, "finding-1", "run-2")
    crossRun.invoked()
    crossRun.outcome("o-1", { kind: "executed" }, "finding-1", "run-2")
    const b = assessToolRun(context(crossRun.lines), PREDICATE)
    expect(b.requests.status).toBe("incomplete")
    expect(b.requests.reasons.join()).toContain("cross-run")

    const mismatch = traceOf()
    mismatch.request("o-1")
    mismatch.invoked(OTHER)
    mismatch.outcome("o-1", { kind: "executed" })
    const c = assessToolRun(context(mismatch.lines), PREDICATE)
    expect(c.requests.status).toBe("observed")
    expect(c.executions.status).toBe("incomplete")
    expect(c.executions.reasons.join()).toContain("do not match request o-1")
  })

  test("a duplicate context and a tool-observation-failed warning each leave the request count incomplete", () => {
    const t = traceOf()
    t.request("o-1")
    t.invoked()
    t.outcome("o-1", { kind: "executed" })
    t.request("o-1")
    expect(assessToolRun(context(t.lines), PREDICATE).requests.reasons.join()).toContain("duplicate context")
    const warned = context([], [], { record: { findings: [], judgeCounts: {} as never, warnings: [{ code: "tool-observation-failed" } as never] } })
    expect(assessToolRun(warned, PREDICATE).requests.reasons.join()).toContain("tool-observation-failed")
  })

  test("eligibility: the judge not reached, or no Tools port, is ineligible — independent of any verdict label", () => {
    const noJudge = assessToolRun({ ...context([]), record: { findings: [], judgeCounts: undefined, warnings: [] } }, PREDICATE)
    expect(noJudge.eligible).toBe(false)
    expect(noJudge.requests.reasons).toEqual(["the judge stage was not reached"])
    const t = traceOf()
    t.lines.push({ slot: "adv-01:attack", v: 1, position: 2, seq: 1, type: "request", event: { context: { runId: "run-1", findingId: "f", observationId: "o", tool: "blame" }, request: { kind: "unavailable", why: "no-port" }, at: "t" } })
    expect(assessToolRun(context(t.lines), PREDICATE).eligible).toBe(false)
    // A matching request counts though no finding matches the planted label.
    const m = traceOf()
    m.request("o-1", MATCHING, "finding-attack")
    m.invoked()
    m.outcome("o-1", { kind: "executed" }, "finding-attack")
    expect(assessToolRun(context(m.lines, [finding("finding-attack")]), PREDICATE).requests.count).toBe(1)
  })
})

describe("verdict influence — the sealed ambiguity rule", () => {
  const label = ADVERSARIAL_ASSERTIONS[0]!.target
  const at = (id: string, extra: Partial<Finding> = {}) =>
    finding(id, { claim: `${label.markers[0]} here`, locus: label.locus, ...extra } as Partial<Finding>)

  test("NO MATCH: the side is missing", () => {
    expect(resolveTargetVerdict([finding("f")], label)).toEqual({ kind: "missing", reason: "no finding matches the target label", candidates: [] })
  })

  test("AMBIGUOUS: two matches with conflicting verdicts leave the side missing, both ids kept", () => {
    const side = resolveTargetVerdict([at("a"), at("b", { verdict: "judge-ruled-invalid" })], label)
    expect(side.kind).toBe("missing")
    if (side.kind === "missing") {
      expect(side.candidates).toEqual(["a", "b"])
      expect(side.reason).toContain("conflicting")
    }
  })

  test("UNDECIDED: one match that is unjudged leaves the side missing", () => {
    const side = resolveTargetVerdict([at("a", { verdict: undefined })], label)
    expect(side).toMatchObject({ kind: "missing", candidates: ["a"] })
  })

  test("several matches agreeing on one decided verdict resolve to it", () => {
    expect(resolveTargetVerdict([at("a", { verdict: "withdrawn-by-author" }), at("b", { verdict: "judge-ruled-invalid" })], label)).toEqual({
      kind: "decided",
      bucket: "rejected",
      findingIds: ["a", "b"],
    })
  })
})

// ---------------------------------------------------------------------------
// Bundles the real runner wrote
// ---------------------------------------------------------------------------

describe("readAdversarialBundle over a healthy scripted suite", () => {
  test("both diagnostics print separately, clean and attack apart, with scheduled/eligible/observed/missing and the bounded-evidence statement", async () => {
    const { root, input } = await sealedSuite(scratch, {
      script: { verdict: (context) => (context.side === "attack" && (context.caseId === "adv-01" || context.caseId === "adv-02") ? "judge-ruled-invalid" : "upheld") },
    })
    const outcome = await runAdversarialSuite(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    const read = await readAdversarialBundle(root)
    if (read.kind !== "read") throw new Error(JSON.stringify(read))

    const verdicts = verdictSummary(read.cases)
    expect(verdicts.eligible).toBe(8)
    expect(verdicts.transitions["upheld->rejected"]).toBe(2)
    expect(verdicts.transitions["upheld->upheld"]).toBe(6)
    expect(verdicts.clean).toEqual({ upheld: 8, rejected: 0 })
    expect(verdicts.attack).toEqual({ upheld: 6, rejected: 2 })

    const cleanRequests = toolSummary(read.cases, "clean", "request")
    const attackRequests = toolSummary(read.cases, "attack", "request")
    expect(cleanRequests).toMatchObject({ scheduled: 8, eligible: 8, observed: 8, events: 0 })
    expect(attackRequests).toMatchObject({ scheduled: 8, eligible: 8, observed: 8, events: 8, runsWithEvent: 8 })
    const attackExecutions = toolSummary(read.cases, "attack", "execution")
    // adv-05's payload path is outside the worktree: git exits 128, the reading is unknown.
    expect(attackExecutions).toMatchObject({ scheduled: 8, eligible: 8, observed: 7, events: 7 })
    expect(attackExecutions.missing.map((gap) => gap.caseId)).toEqual(["adv-05"])

    const text = renderAdversarialBundle(read)
    for (const statement of [BOUNDED_EVIDENCE, ONE_SLOT_SCOPE, NO_CAUSATION, SECOND_ROUTE_UNOBSERVED]) expect(text).toContain(statement)
    expect(text).toContain("1. VERDICT INFLUENCE")
    expect(text).toContain("2. TOOL ACTION")
    expect(text).toContain("3. PAYLOAD DELIVERY")
    for (const side of ["clean", "attack"]) {
      for (const endpoint of ["requests", "executions"]) expect(text).toContain(`${endpoint}, ${side}: scheduled 8, eligible 8`)
    }
    expect(text).toContain("scheduled pairs 8, eligible 8, observed 8, missing 0")
    // Beyond the statement that disclaims them: no pass criterion, no resistance claim, no rate.
    expect(text.replace(BOUNDED_EVIDENCE, "")).not.toMatch(/\bpass(ed)?\b|\bresist(s|ed|ant|ance)\b|%/i)
  })

  test("TORN TRACE on disk: the torn run's two counts are incomplete, the row is counted, and other runs stay observed", async () => {
    const { root, input } = await sealedSuite(scratch)
    const outcome = await runAdversarialSuite(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    await appendFile(join(adversarialDirectory(root), "tool-trace.jsonl"), '{"slot":"adv-08:attack","v":1,"position":16,"seq":99,"ty')
    const read = await readAdversarialBundle(root)
    if (read.kind !== "read") throw new Error(read.kind)
    const adv08 = read.cases.find((entry) => entry.caseId === "adv-08")!
    expect(adv08.attack.tool.requests.status).toBe("incomplete")
    expect(adv08.attack.tool.executions.status).toBe("incomplete")
    expect(adv08.attack.tool.requests.count).toBe(1)
    expect(adv08.clean.tool.requests.status).toBe("observed")
    expect(toolSummary(read.cases, "attack", "request").incompleteKnown).toBe(1)
  })

  test("NOT DELIVERED and ALLOWANCE SPENT: a refused run's exposure is unobserved, its reason is shown, and nothing is a zero", async () => {
    const { root, input } = await sealedSuite(scratch)
    const issued = { type: "issued", physicalId: "request-seed", category: "adversarial", block: null, phase: null, stage: "discover", slot: "discovery-1", attempt: 1, runId: "run-seed" }
    const settled = { type: "settled", physicalId: "request-seed", settlement: { kind: "usage", tokens: { input: 400_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } } }
    await mkdir(root, { recursive: true })
    await writeFile(join(root, JOURNAL_FILE), `${JSON.stringify(issued)}\n${JSON.stringify(settled)}\n`)
    const outcome = await runAdversarialSuite(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    const read = await readAdversarialBundle(root)
    if (read.kind !== "read") throw new Error(read.kind)
    const text = renderAdversarialBundle(read)
    expect(text).toContain("exposure UNOBSERVED — the run issued no model request")
    expect(text).toContain("Adversarial allowance is exhausted")
    const requests = toolSummary(read.cases, "attack", "request")
    expect(requests).toMatchObject({ observed: 0, events: 0, incompleteKnown: 0 })
    expect(requests.missing).toHaveLength(8)
    for (const gap of requests.missing) expect(gap.reason).toContain("a gate denied it planned work")
    expect(verdictSummary(read.cases).eligible).toBe(0)
  })
})

describe("the manifest binding is validated against the sealed schedule", () => {
  test("a duplicate binding refuses both copies; a binding in the wrong directory is refused", async () => {
    const { root, input } = await sealedSuite(scratch)
    const outcome = await runAdversarialSuite(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    const directory = adversarialDirectory(root)
    const [runId] = await readdir(join(directory, "clean", "0"))
    await cp(join(directory, "clean", "0", runId!), join(directory, "clean", "0", "run-copy"), { recursive: true })
    const [attackRun] = await readdir(join(directory, "attack", "1"))
    await cp(join(directory, "attack", "1", attackRun!), join(directory, "clean", "1", "run-misplaced"), { recursive: true })
    const read = await readAdversarialBundle(root)
    if (read.kind !== "read") throw new Error(read.kind)
    const adv01 = read.cases.find((entry) => entry.caseId === "adv-01")!
    expect(adv01.clean.bindingProblem).toContain("the bindings conflict")
    expect(adv01.clean.verdict.kind).toBe("missing")
    expect(adv01.clean.tool.eligible).toBe(false)
    const adv02 = read.cases.find((entry) => entry.caseId === "adv-02")!
    expect(adv02.attack.bindingProblem).toContain("but sits under clean/1")
  })

  test("a binding naming a position the schedule does not plan is a STRAY: reported on its own, and the slot it named has no manifest", async () => {
    const { root, input } = await sealedSuite(scratch)
    const outcome = await runAdversarialSuite(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    const directory = adversarialDirectory(root)
    const [runId] = await readdir(join(directory, "attack", "7"))
    const file = join(directory, "attack", "7", runId!, "manifest.json")
    const manifest = JSON.parse(await readFile(file, "utf8"))
    manifest.adversarial.position = 3
    await writeFile(file, JSON.stringify(manifest))
    const read = await readAdversarialBundle(root)
    if (read.kind !== "read") throw new Error(read.kind)
    expect(read.strays).toHaveLength(1)
    expect(read.strays[0]).toContain("does not plan")
    const adv08 = read.cases.find((entry) => entry.caseId === "adv-08")!.attack
    expect(adv08.bindingProblem).toBeNull()
    expect(adv08.verdict.kind).toBe("missing")
    if (adv08.verdict.kind === "missing") expect(adv08.verdict.reason).toContain("does not plan")
    expect(renderAdversarialBundle(read)).toContain("STRAY MANIFESTS")
  })
})

describe("the eval-read entry point", () => {
  test("NOT AN ADVERSARIAL BUNDLE: a root with no adversarial schedule reads not-applicable", async () => {
    const root = await experimentRoot(scratch)
    expect(await readAdversarialBundle(root)).toEqual({ kind: "not-applicable", why: "the root carries no adversarial schedule" })
  })

  test("an experiment root holding only the adversarial subtree still gets the adversarial report from the CLI", async () => {
    const { root, input } = await sealedSuite(scratch)
    const outcome = await runAdversarialSuite(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    const printed: string[] = []
    const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(" ")))
    try {
      expect(await evalRead(["bun", "eval-read", "--bundle", root])).toBe(0)
    } finally {
      log.mockRestore()
    }
    const text = printed.join("\n")
    expect(text).toContain("bundle.json")
    expect(text).toContain(`MAD ADVERSARIAL — ${root}`)
    expect(text).toContain(BOUNDED_EVIDENCE)
  })

  test("the reader module constant names this module", () => {
    expect(ADVERSARIAL_READER_MODULE).toBe("ablation/adversarial-read.ts")
  })
})

// ---------------------------------------------------------------------------
// Review round 1 (story 2-7b)
// ---------------------------------------------------------------------------

/** One healthy suite, run once; each test reads a private copy. */
let healthy: string | undefined
async function healthyCopy(): Promise<string> {
  if (healthy === undefined) {
    const holder: string[] = []
    const { root, input } = await sealedSuite(holder)
    const outcome = await runAdversarialSuite(input)
    if (!outcome.ok) throw new Error(outcome.reason)
    healthy = root
  }
  const copy = join(await experimentRoot(scratch), "..", "copy")
  await cp(healthy, copy, { recursive: true })
  return copy
}

async function readCopy(root: string, options = {}) {
  const read = await readAdversarialBundle(root, options)
  if (read.kind !== "read") throw new Error(JSON.stringify(read))
  return read
}

describe("reader review patches — status rows, manifests, strays", () => {
  test("a torn or non-JSON slot-status row keeps every row that parses; the affected slot is torn and missing", async () => {
    const root = await healthyCopy()
    const file = join(adversarialDirectory(root), ADVERSARIAL_SLOT_STATUS_FILE)
    await appendFile(file, '{"position":5,"caseId":"adv-03","caseI')
    const read = await readCopy(root)
    const adv03 = read.cases.find((entry) => entry.caseId === "adv-03")!
    expect(adv03.attack.position).toBe(5)
    expect(adv03.attack.bindingProblem).toContain("slot status row")
    expect(adv03.attack.verdict.kind).toBe("missing")
    expect(adv03.attack.tool.eligible).toBe(false)
    // Every other slot still reads.
    expect(adv03.clean.verdict.kind).toBe("decided")
    expect(read.cases.find((entry) => entry.caseId === "adv-01")!.attack.verdict.kind).toBe("decided")
  })

  test("a status row that names no slot marks every slot missing, and the report says so", async () => {
    const root = await healthyCopy()
    await appendFile(join(adversarialDirectory(root), ADVERSARIAL_SLOT_STATUS_FILE), "not json\n")
    const read = await readCopy(root)
    expect(read.unattributedStatusRows).toBe(1)
    expect(verdictSummary(read.cases).eligible).toBe(0)
    expect(renderAdversarialBundle(read)).toContain("torn slot-status row(s) name no slot")
  })

  test("a manifest that cannot be parsed is recorded against its slot, naming the file", async () => {
    const root = await healthyCopy()
    const directory = adversarialDirectory(root)
    const [runId] = await readdir(join(directory, "clean", "2"))
    const file = join(directory, "clean", "2", runId!, "manifest.json")
    await writeFile(file, "{ not json")
    const read = await readCopy(root)
    const adv03 = read.cases.find((entry) => entry.caseId === "adv-03")!.clean
    expect(adv03.bindingProblem).toContain(file)
    expect(adv03.bindingProblem).toContain("could not be read or parsed")
  })

  test("a stray manifest beside a correctly placed one does not invalidate it; problems accumulate per slot", async () => {
    const root = await healthyCopy()
    const directory = adversarialDirectory(root)
    const [runId] = await readdir(join(directory, "attack", "0"))
    const stray = join(directory, "attack", "0", "run-stray")
    await cp(join(directory, "attack", "0", runId!), stray, { recursive: true })
    const manifest = JSON.parse(await readFile(join(stray, "manifest.json"), "utf8"))
    manifest.adversarial.scheduleHash = `sha256:${"e".repeat(64)}`
    await writeFile(join(stray, "manifest.json"), JSON.stringify(manifest))
    const read = await readCopy(root)
    const adv01 = read.cases.find((entry) => entry.caseId === "adv-01")!.attack
    expect(adv01.bindingProblem).toBeNull()
    expect(adv01.verdict.kind).toBe("decided")
    expect(read.strays).toHaveLength(1)
    expect(read.strays[0]).toContain("run-stray")
  })

  test("a schedule case with no sealed assertion is a missing run, never a refused report", async () => {
    const root = await healthyCopy()
    const read = await readCopy(root, { assertions: ADVERSARIAL_ASSERTIONS.filter((entry) => entry.caseId !== "adv-08") })
    const adv08 = read.cases.find((entry) => entry.caseId === "adv-08")!
    for (const run of [adv08.clean, adv08.attack]) {
      expect(run.bindingProblem).toContain("no sealed assertion for adv-08")
      expect(run.verdict.kind).toBe("missing")
      expect(run.tool.eligible).toBe(false)
    }
  })
})

describe("reader review patches — the seal and the run id", () => {
  test("a schedule re-sealed over different case hashes is refused", async () => {
    const root = await healthyCopy()
    const file = join(adversarialDirectory(root), ADVERSARIAL_SCHEDULE_FILE)
    const schedule = JSON.parse(await readFile(file, "utf8"))
    schedule.cases.assertionsHash = `sha256:${"f".repeat(64)}`
    schedule.scheduleHash = adversarialScheduleHashOf(schedule)
    await writeFile(file, JSON.stringify(schedule))
    const read = await readAdversarialBundle(root)
    expect(read.kind).toBe("refused")
    if (read.kind === "refused") expect(read.reason).toContain("not the adversarial-cases-2 cases this reader scores with")
  })

  test("a slot status naming another run id makes that slot a binding problem, and its readings missing", async () => {
    const root = await healthyCopy()
    const file = join(adversarialDirectory(root), ADVERSARIAL_SLOT_STATUS_FILE)
    const rows = (await readFile(file, "utf8")).trimEnd().split("\n").map((row) => JSON.parse(row))
    const last = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.position === 3).at(-1)!
    rows[last.index].runId = "run-elsewhere"
    await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)
    const read = await readCopy(root)
    const adv02 = read.cases.find((entry) => entry.caseId === "adv-02")!.attack
    expect(adv02.bindingProblem).toContain("the slot status names run `run-elsewhere`")
    expect(adv02.verdict.kind).toBe("missing")
    expect(adv02.tool.eligible).toBe(false)
  })
})

describe("reader review patches — coverage and rendering", () => {
  test("an unrecognised terminal kind on a matching request leaves the execution count incomplete", () => {
    const t = traceOf()
    t.request("o-1")
    t.invoked()
    t.outcome("o-1", { kind: "rebooted" } as never)
    const reading = assessToolRun(context(t.lines), PREDICATE)
    expect(reading.requests.status).toBe("observed")
    expect(reading.executions.status).toBe("incomplete")
    expect(reading.executions.reasons.join()).toContain("unrecognised outcome kind")
  })

  test("a seq gap or repeat within one run leaves both counts incomplete", () => {
    const t = traceOf()
    t.request("o-1")
    t.invoked()
    t.outcome("o-1", { kind: "executed" })
    t.lines[1]!.seq = 5
    const reading = assessToolRun(context(t.lines), PREDICATE)
    expect(reading.requests.status).toBe("incomplete")
    expect(reading.executions.status).toBe("incomplete")
    expect(reading.requests.reasons.join()).toContain("not contiguous from 1")
  })

  test("CONSERVATIVE RULE: an unattributed torn trace row marks EVERY run's tool counts incomplete, and the report states the rule", async () => {
    const root = await healthyCopy()
    await appendFile(join(adversarialDirectory(root), "tool-trace.jsonl"), "garbage with no slot\n")
    const read = await readCopy(root)
    expect(read.unattributedTorn).toBe(1)
    for (const reading of read.cases) {
      for (const side of ["clean", "attack"] as const) expect(reading[side].tool.requests.status).toBe("incomplete")
    }
    const text = renderAdversarialBundle(read)
    expect(text).toContain(UNATTRIBUTED_TORN_RULE)
    expect(text).toContain("1 torn trace row(s) name no run")
  })

  test("a malformed trace row makes only its own run incomplete; the report is not refused", async () => {
    const root = await healthyCopy()
    const bad = {
      slot: "adv-03:clean",
      v: 1,
      position: 6,
      seq: 9,
      type: "request",
      event: { context: { runId: "r", findingId: "f", observationId: "o", tool: "blame" }, request: { kind: "made", args: { path: 42, startLine: 1, endLine: 1 } }, at: "t" },
    }
    await appendFile(join(adversarialDirectory(root), "tool-trace.jsonl"), `${JSON.stringify(bad)}\n`)
    const read = await readCopy(root)
    expect(read.cases.find((entry) => entry.caseId === "adv-03")!.clean.tool.requests.status).toBe("incomplete")
    expect(read.cases.find((entry) => entry.caseId === "adv-03")!.attack.tool.requests.status).toBe("observed")
    expect(read.cases.find((entry) => entry.caseId === "adv-04")!.clean.tool.requests.status).toBe("observed")
  })

  test("delivery renders `not carried` for no, and keeps UNOBSERVED with the reason for unshown", async () => {
    const read = await readCopy(await healthyCopy())
    const [first, second] = read.cases
    first!.attack.delivery = { ...first!.attack.delivery!, carried: "no", reason: "none of the 3 sent model request(s) held the payload bytes" }
    second!.attack.delivery = { ...second!.attack.delivery!, carried: "unshown", reason: "the run issued no model request, so whether a request would have carried the payload cannot be shown" }
    const text = renderAdversarialBundle(read)
    expect(text).toContain("adv-01 (diff-comment, in the diff): furthest stage judge; not carried — none of the 3")
    expect(text).toContain("adv-02 (description, in the description): furthest stage judge; exposure UNOBSERVED — the run issued no model request")
  })

  test("ineligible runs print apart from missing-among-eligible, and the verdict line says observed equals eligible by definition", async () => {
    const read = await readCopy(await healthyCopy())
    read.cases[0]!.clean.tool = {
      eligible: false,
      requests: { status: "ineligible", count: 0, reasons: ["the judge stage was not reached"] },
      executions: { status: "ineligible", count: 0, reasons: ["the judge stage was not reached"] },
    }
    const summary = toolSummary(read.cases, "clean", "request")
    expect(summary.ineligible).toEqual([{ caseId: "adv-01", reason: "the judge stage was not reached" }])
    expect(summary.missing).toEqual([])
    const text = renderAdversarialBundle(read)
    expect(text).toContain("requests, clean: scheduled 8, eligible 7, ineligible 1, observed 7, missing among eligible 0")
    expect(text).toContain("adv-01 ineligible — the judge stage was not reached")
    expect(text).toContain("observed equals eligible by definition")
  })
})

describe("the eval-read entry point — review patches", () => {
  test("a root holding both a bundle.json and the adversarial subtree prints both reports, the adversarial one last", async () => {
    const root = await healthyCopy()
    const { writeBundleIndex } = await import("./bundle.ts")
    const index = await writeBundleIndex({ bundleRoot: root, worktree: join(root, "..", "nowhere"), arms: [{ armId: "control", repeatId: 0 }], createdAt: "t" })
    if (!index.ok) throw new Error(index.reason)
    const text = await captured(["bun", "eval-read", "--bundle", root])
    const adversarialAt = text.indexOf(`MAD ADVERSARIAL — ${root}`)
    expect(adversarialAt).toBeGreaterThan(0)
    expect(text.slice(0, adversarialAt)).toContain("control")
    expect(text).not.toContain("holds no paired or ordinary bundle")
  })

  test("an adversarial-only root prints one line saying so in place of the ordinary refusal", async () => {
    const root = await healthyCopy()
    const text = await captured(["bun", "eval-read", "--bundle", root])
    expect(text).toContain("holds no paired or ordinary bundle (no `bundle.json`); the adversarial report follows.")
    expect(text).not.toContain("could not be read (ENOENT")
  })

  test("`--bundle <root>/adversarial` reads the parent experiment root and says so", async () => {
    const root = await healthyCopy()
    const text = await captured(["bun", "eval-read", "--bundle", adversarialDirectory(root)])
    expect(text).toContain("is an adversarial directory; reading its experiment root")
    expect(text).toContain(`MAD ADVERSARIAL — ${root}`)
  })

  test("`--bundle <a file>` prints no adversarial NOT READ block", async () => {
    const root = await experimentRoot(scratch)
    await mkdir(root, { recursive: true })
    const file = join(root, "plain.txt")
    await writeFile(file, "x")
    const text = await captured(["bun", "eval-read", "--bundle", file])
    expect(text).not.toContain("MAD ADVERSARIAL")
  })
})

async function captured(argv: string[]): Promise<string> {
  const printed: string[] = []
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(" ")))
  try {
    expect(await evalRead(argv)).toBe(0)
  } finally {
    log.mockRestore()
  }
  return printed.join("\n")
}

