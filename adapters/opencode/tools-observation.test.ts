/**
 * The tool-action trace over REAL GIT (story 2-7a, `evaluation-protocol.md` §5).
 *
 * ## Why this file is not `tools.test.ts` with an observer bolted on
 *
 * `tools.test.ts` drives a hand-written shell fake, which is the right gate for
 * argv safety and for the throw-versus-empty-string distinction: both are
 * properties of this file's own code. They are the wrong gate for a trace whose
 * whole subject is what the HOST did. A faked exit code proves that the mapping
 * reads the number it was handed; it proves nothing about which numbers the host
 * actually hands over, and the mapping in `core/judge/blame.ts` is only as true
 * as that.
 *
 * So every row below runs real `git` in a real repository this file creates, and
 * the launch-evidence row runs the real host shell against a command that does
 * not exist. What they establish is recorded in `tools.ts`'s header; this file is
 * where those sentences are kept honest.
 *
 * ## And it drives the SHARED FACTORY
 *
 * The last block runs the real `judge()` over tools built by `opencodeTools` —
 * the same function `plugin.ts` calls and the same one the evaluation harness
 * will call. The protocol asks for tool actions recorded through the real
 * production adapter path, and a second imitation of the plugin's wiring would
 * satisfy the letter of that while observing a different adapter.
 */

import { $ } from "bun"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Finding } from "../../core/domain/finding.ts"
import type { Roster } from "../../core/domain/roster.ts"
import { emptyLedger } from "../../core/domain/run-record.ts"
import { blameFailureOutcome, parseBlamePorcelain } from "../../core/judge/blame.ts"
import type {
  ToolInvocationFact,
  ToolObservation,
  ToolObservationFailure,
  ToolOutcomeEvent,
  ToolRequestEvent,
  ToolShellOutcome,
} from "../../core/ports/tool-observation.ts"
import {
  MAX_STDERR_CHARS,
  STDERR_CLIPPED,
  toolFailureEvidence,
} from "../../core/ports/tool-observation.ts"
import { judge } from "../../core/stages/judge.ts"
import { fakeClock, FakeBackend } from "../../core/test-support/fakes.ts"
import { clipStderr, launchEvidenceFrom, opencodeTools } from "./tools.ts"

type Recorded =
  | { type: "request"; event: ToolRequestEvent }
  | { type: "outcome"; event: ToolOutcomeEvent }
  | { type: "invoked"; fact: ToolInvocationFact }
  | { type: "shell"; fact: ToolShellOutcome }
  | { type: "failed"; failure: ToolObservationFailure }

function memory(rejectAdapterWrites = false): { events: Recorded[]; observer: ToolObservation } {
  const events: Recorded[] = []
  let reported: ToolObservationFailure[] = []
  return {
    events,
    observer: {
      async request(event) {
        events.push({ type: "request", event })
      },
      async outcome(event) {
        events.push({ type: "outcome", event })
      },
      async invoked(fact) {
        if (rejectAdapterWrites) throw new Error("the trace sink is full")
        events.push({ type: "invoked", fact })
      },
      async shellOutcome(fact) {
        if (rejectAdapterWrites) throw new Error("the trace sink is full")
        events.push({ type: "shell", fact })
      },
      failed(failure) {
        events.push({ type: "failed", failure })
        reported.push(failure)
      },
      takeFailures() {
        const taken = reported
        reported = []
        return taken
      },
    },
  }
}

const invocations = (events: Recorded[]) => events.flatMap((e) => (e.type === "invoked" ? [e.fact] : []))
const shells = (events: Recorded[]) => events.flatMap((e) => (e.type === "shell" ? [e.fact] : []))

/** A controlled repository, real and local, so blame has something to report. */
let worktree: string

/**
 * BUN'S `$` IS ONE OBJECT AND `.cwd()` RETAINS ITS ARGUMENT.
 *
 * `opencodeTools` binds the worktree by calling `options.$.cwd(worktree)`, which
 * is the production wiring and is what makes this file's rows real. The cost is
 * that a row which binds a directory that does not exist leaves the shared `$`
 * pointed at it, so the default is restored after every test rather than left
 * for the next one to trip over.
 */
const HERE = process.cwd()
afterEach(() => {
  $.cwd(HERE)
})

beforeAll(async () => {
  worktree = await mkdtemp(join(tmpdir(), "mad-tool-observation-"))
  const git = $.cwd(worktree).env({
    ...process.env,
    GIT_AUTHOR_NAME: "Ada",
    GIT_AUTHOR_EMAIL: "ada@example.invalid",
    GIT_COMMITTER_NAME: "Ada",
    GIT_COMMITTER_EMAIL: "ada@example.invalid",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  })
  await git`git init -q -b main`.quiet()
  await writeFile(join(worktree, "pay.ts"), "const fee = 1\nconst rate = 2\nconst total = fee * rate\n")
  await git`git add pay.ts`.quiet()
  await git`git commit -q -m ${"the rate check"}`.quiet()
})

afterAll(async () => {
  if (worktree !== undefined) await $`rm -rf ${worktree}`.quiet().nothrow()
})

describe("real git, observed — the invocation and the shell's return are two facts", () => {
  test("A REAL SUCCESS: invocation observed, exit 0, launch PROVED, argv retained", async () => {
    const trace = memory()
    const tools = opencodeTools({ $, worktree, toolObservation: trace.observer })

    const porcelain = await tools.blame("pay.ts", 1, 2)

    // The call really did produce blame output: the row is about real git, so it
    // is checked against a real parse rather than against a string shape.
    expect(parseBlamePorcelain(porcelain)).toHaveLength(2)

    const invoked = invocations(trace.events)
    expect(invoked).toHaveLength(1)
    expect(invoked[0]!.args).toEqual({ path: "pay.ts", startLine: 1, endLine: 2 })
    // The argv is kept raw, `--` included: a trace that recorded a pretty
    // rendering of the command could not later answer what was actually run.
    expect(invoked[0]!.argv).toEqual(["git", "blame", "-L", "1,2", "--porcelain", "--", "pay.ts"])

    const shell = shells(trace.events)
    expect(shell).toHaveLength(1)
    expect(shell[0]!.exitCode).toBe(0)
    expect(shell[0]!.launch).toBe("proved")

    // TWO EVENTS AND IN THIS ORDER. The invocation is written before the call is
    // awaited, so a call that never comes back still leaves the record that
    // something was launched at.
    const kinds = trace.events.map((e) => e.type)
    expect(kinds).toEqual(["invoked", "shell"])
  })

  test("A REAL FAILURE: invocation observed, execution UNKNOWN, failure kept apart", async () => {
    // Real git, real refusal: a path that is not in HEAD. The exit code is git's
    // own and is not asserted as a constant beyond being non-zero, because the
    // claim under test is what the mapping does with it.
    const trace = memory()
    const tools = opencodeTools({ $, worktree, toolObservation: trace.observer })

    const error = await tools.blame("no-such-file.ts", 1, 2).then(
      () => undefined,
      (reason: unknown) => reason,
    )

    expect(error).toBeDefined()
    expect(invocations(trace.events)).toHaveLength(1)

    const shell = shells(trace.events)[0]!
    expect(shell.exitCode).not.toBe(0)
    // NOT "the command did not run". The pinned interface carries no launch
    // evidence, so a non-zero exit leaves execution unknown — see `tools.ts`.
    expect(shell.launch).toBe("unproved")
    expect(shell.stderr.length).toBeGreaterThan(0)

    const evidence = toolFailureEvidence(error)
    expect(evidence).toEqual({ stage: "shell", exitCode: shell.exitCode, launch: "unproved" })
  })

  test("A PRE-SHELL REFUSAL: no invocation, no shell outcome, and it says so", async () => {
    // The range is refused before anything is spawned, so this must be separable
    // from every failure above: an execution count that swept it in would count
    // a call that never reached a shell.
    const trace = memory()
    const tools = opencodeTools({ $, worktree, toolObservation: trace.observer })

    const error = await tools.blame("pay.ts", 0, 2).then(
      () => undefined,
      (reason: unknown) => reason,
    )

    expect(error).toBeDefined()
    expect(trace.events).toHaveLength(0)
    // `not-attempted`, not `unproved`: nothing was launched at, and `unproved`
    // is defined as a non-zero exit — there was no exit here at all.
    expect(toolFailureEvidence(error)).toEqual({ stage: "pre-shell", launch: "not-attempted" })
  })

  test("AN INTERRUPTED CALL: the invocation stands, and the evidence is MISSING", async () => {
    // A worktree that does not exist. The host rejects with no exit code at all,
    // so there is nothing to map and `blameFailureOutcome` reads `unknown` —
    // which is the honest answer and is never `false`.
    const trace = memory()
    const tools = opencodeTools({
      $,
      worktree: join(worktree, "no-such-directory"),
      toolObservation: trace.observer,
    })

    const error = await tools.blame("pay.ts", 1, 2).then(
      () => undefined,
      (reason: unknown) => reason,
    )

    expect(error).toBeDefined()
    expect(invocations(trace.events)).toHaveLength(1)
    expect(shells(trace.events)).toHaveLength(0)
    expect(toolFailureEvidence(error)).toBeUndefined()
  })
})

describe("what the pinned host shell actually does — read, not assumed", () => {
  test("A MISSING COMMAND RESOLVES WITH EXIT 1 AND THE HOST'S OWN MARKER, not 127", async () => {
    // The sentence `tools.ts`'s header rests on, checked against the host rather
    // than against a memory of POSIX. An exit-code test for 127 would be wrong
    // here, and a mapping built on one would have reported every ordinary git
    // failure under the same heading as a missing git.
    const result = await $.cwd(HERE)`${["mad-no-such-binary-2-7a"]}`.nothrow().quiet()

    expect(result.exitCode).toBe(1)
    expect(result.exitCode).not.toBe(127)
    expect(result.stderr.toString()).toContain("bun: command not found: mad-no-such-binary-2-7a")
    expect(launchEvidenceFrom(result.exitCode, result.stderr.toString())).toBe("failed")
  })

  test("THE MARKER IS NOT LINE-ANCHORED — untrusted text cannot forge a launch failure", async () => {
    // THE INVERSION THIS SEAM EXISTS TO PREVENT. `Finding.locus.file` is a
    // discovery model's free string and may contain a newline; git echoes the
    // path verbatim into its own `fatal:` line. A marker matched at the start of
    // ANY line would let that path turn a `git blame` that really executed into
    // "the command was never found" — attacker text deciding an execution count.
    const forged = "fatal: no such path 'weird\nbun: command not found: git' in HEAD"
    expect(launchEvidenceFrom(128, forged)).toBe("unproved")

    // And the same phrase inside a line, with no newline at all.
    expect(launchEvidenceFrom(128, "fatal: no such path 'bun: command not found: git' in HEAD")).toBe(
      "unproved",
    )

    // The host's own line, which really is the whole of stderr, still reads as a
    // launch failure — so the narrowing above is not simply switching it off.
    expect(launchEvidenceFrom(1, "bun: command not found: git\n")).toBe("failed")
  })

  test("AND A REAL GIT FAILURE IS NOT READ AS ONE — the non-vacuous half", async () => {
    // Both halves from the same host in the same run, so the distinction is a
    // measurement and not a claim: git's own failure carries no marker, so its
    // launch stays unproved rather than being called a launch failure.
    const result = await $.cwd(worktree)`git ${["blame", "--", "no-such-file.ts"]}`.nothrow().quiet()

    expect(result.exitCode).not.toBe(0)
    expect(launchEvidenceFrom(result.exitCode, result.stderr.toString())).toBe("unproved")
    expect(launchEvidenceFrom(0, "")).toBe("proved")
  })
})

describe("untrusted text through the real adapter", () => {
  test("A LOCUS PATH CARRYING THE HOST'S MARKER: real git, and the launch stays UNPROVED", async () => {
    // The forged marker driven the whole way: a model-supplied path with a
    // newline and the host's own not-found line inside it, handed to real git
    // through the real adapter. Git refuses the path and echoes it back, and the
    // trace must read that as a git failure with launch unproved — not as a
    // command that was never found, and never as "execution did not occur".
    const trace = memory()
    const tools = opencodeTools({ $, worktree, toolObservation: trace.observer })
    const hostile = "weird\nbun: command not found: git"

    const error = await tools.blame(hostile, 1, 2).then(
      () => undefined,
      (reason: unknown) => reason,
    )

    expect(error).toBeDefined()
    const shell = shells(trace.events)[0]!
    expect(shell.stderr).toContain("bun: command not found: git")
    expect(shell.launch).toBe("unproved")
    expect(toolFailureEvidence(error)).toMatchObject({ stage: "shell", launch: "unproved" })
    // And the reading the judge would take from it: an invocation was observed
    // and the execution is unknown. NOT `not-executed`.
    expect(blameFailureOutcome(error, "why").kind).toBe("invoked-unknown")
  })

  test("A VERY LONG PATH: the host's diagnostic is CLIPPED, and says it was", async () => {
    // `stderr` is untrusted host text of unbounded length — git puts the model's
    // own path inside it. A trace field is not a place to store an arbitrary
    // amount of it, and a truncation nobody is told about is the AD-6 failure in
    // miniature, so the clip is stated in the value.
    const trace = memory()
    const tools = opencodeTools({ $, worktree, toolObservation: trace.observer })

    await tools.blame(`${"z".repeat(MAX_STDERR_CHARS * 2)}.ts`, 1, 2).catch(() => undefined)

    const shell = shells(trace.events)[0]!
    expect(shell.stderr.length).toBeLessThanOrEqual(MAX_STDERR_CHARS + STDERR_CLIPPED.length)
    expect(shell.stderr.endsWith(STDERR_CLIPPED)).toBe(true)
  })

  test("AND A SHORT ONE IS NOT TOUCHED — the clip is a ceiling, not a constant", () => {
    expect(clipStderr("fatal: no such path")).toBe("fatal: no such path")
    expect(clipStderr("z".repeat(MAX_STDERR_CHARS))).toHaveLength(MAX_STDERR_CHARS)
    expect(clipStderr("z".repeat(MAX_STDERR_CHARS + 1))).toBe(
      `${"z".repeat(MAX_STDERR_CHARS)}${STDERR_CLIPPED}`,
    )
  })
})

describe("the observer alters nothing it observes", () => {
  test("NO OBSERVER: the same bytes come back", async () => {
    const observed = await opencodeTools({ $, worktree, toolObservation: memory().observer }).blame(
      "pay.ts",
      1,
      2,
    )
    const bare = await opencodeTools({ $, worktree }).blame("pay.ts", 1, 2)

    expect(observed).toBe(bare)
  })

  test("AN OBSERVER THAT REJECTS: the blame still succeeds, and the failure is surfaced", async () => {
    // An observation failure is never a tool failure. The adapter holds no run
    // record, so `failed` is its channel; the judge's half of this is the
    // `tool-observation-failed` warning.
    const trace = memory(true)
    const tools = opencodeTools({ $, worktree, toolObservation: trace.observer })

    const porcelain = await tools.blame("pay.ts", 1, 2)

    expect(parseBlamePorcelain(porcelain)).toHaveLength(2)
    const failures = trace.events.flatMap((e) => (e.type === "failed" ? [e.failure] : []))
    expect(failures).toHaveLength(2)
    expect(failures.every((failure) => failure.where === "adapter")).toBe(true)
  })
})

describe("THE PRODUCTION PATH, end to end — the shared factory under the real judge", () => {
  const slotOf = (id: string) => ({
    slot: id,
    providerId: "p",
    modelId: id,
    identity: id,
    lineage: { lineage: id, label: id, verified: true },
    toolcall: true,
    alsoAvailableVia: [],
  })

  const roster: Roster = {
    slots: ["discovery-1", "discovery-2", "discovery-3"].map(slotOf),
    lensSlots: [],
    requested: 3,
    distinctLineages: 3,
    providers: ["p"],
  }

  function tracked(): Finding {
    return {
      id: "f-1",
      claim: "the rate is never validated",
      reasoning: "a NaN rate silently produces a NaN total",
      locus: { file: "pay.ts", startLine: 1, endLine: 2 },
      severity: "high",
      author: "discovery-1",
      source: "pool",
      coDiscovery: { raised: 1, answered: 3 },
      route: "judge",
      history: [],
    }
  }

  test("A TRACKED FILE: the trace carries the path, the range, an INVOCATION and EXECUTION PROVED", async () => {
    const trace = memory()
    const tools = opencodeTools({ $, worktree, toolObservation: trace.observer })

    await judge({
      findings: [tracked()],
      roster,
      answeredSlots: roster.slots.map((s) => s.slot),
      backend: new FakeBackend({}),
      input: "# Change under review",
      clock: fakeClock(),
      ledger: emptyLedger(),
      runId: "run-1",
      tools,
      toolObservation: trace.observer,
    })

    // THE REQUEST CAME FIRST, and it carries what was asked for.
    expect(trace.events[0]!.type).toBe("request")
    const request = trace.events[0]! as Extract<Recorded, { type: "request" }>
    expect(request.event.context).toMatchObject({ runId: "run-1", findingId: "f-1", tool: "blame" })
    expect(request.event.request).toEqual({
      kind: "made",
      args: { path: "pay.ts", startLine: 1, endLine: 2 },
    })

    // THE INVOCATION IS THE ADAPTER'S, and it is a separate fact from the
    // request above — the core cannot write it and the adapter cannot write the
    // request.
    expect(trace.events.map((e) => e.type)).toEqual(["request", "invoked", "shell", "outcome"])
    expect(shells(trace.events)[0]!.launch).toBe("proved")

    // AND THE EXECUTION IS PROVED, by a real git that really ran.
    const outcome = trace.events.at(-1)! as Extract<Recorded, { type: "outcome" }>
    expect(outcome.event.outcome).toEqual({ kind: "executed" })
    expect(outcome.event.context.observationId).toBe(request.event.context.observationId)
  })

  test("AN ADAPTER THAT CANNOT WRITE ITS TRACE IS SURFACED BY THE JUDGE", async () => {
    // The half a run could lose silently. The adapter holds no run record, so if
    // nothing drained its failures a run whose every `invoked` and
    // `shellOutcome` write failed would render byte-identical to a fully traced
    // one — a trace missing exactly the events that carry the executions, with
    // nothing anywhere saying so.
    const trace = memory(true)
    const tools = opencodeTools({ $, worktree, toolObservation: trace.observer })

    const result = await judge({
      findings: [tracked()],
      roster,
      answeredSlots: roster.slots.map((s) => s.slot),
      backend: new FakeBackend({}),
      input: "# Change under review",
      clock: fakeClock(),
      ledger: emptyLedger(),
      runId: "run-1",
      tools,
      toolObservation: trace.observer,
    })

    // The blame itself succeeded, so this is NOT a blame failure.
    expect(result.factChecksMadExecuted).toBe(1)
    expect(result.warnings.some((w) => w.code === "blame-unavailable")).toBe(false)

    const raised = result.warnings.find((w) => w.code === "tool-observation-failed")
    expect(raised).toBeDefined()
    const detail = raised!.detail as { total: number; failures: { where: string; write: string }[] }
    expect(detail.total).toBe(2)
    // Named by layer and by write, so a reader knows WHICH half of the trace is
    // missing rather than only how much of it.
    expect(detail.failures.map((f) => `${f.where}/${f.write}`).sort()).toEqual([
      "adapter/invoked",
      "adapter/shellOutcome",
    ])
  })

  test("A RANGE THE ADAPTER REFUSES: request observed, NO invocation, execution did not occur", async () => {
    // The same production path, one row along: a locus whose end precedes its
    // start is refused before any shell runs, and the trace says exactly that.
    const trace = memory()
    const tools = opencodeTools({ $, worktree, toolObservation: trace.observer })
    const finding = tracked()
    finding.locus = { file: "pay.ts", startLine: 9, endLine: 4 }

    await judge({
      findings: [finding],
      roster,
      answeredSlots: roster.slots.map((s) => s.slot),
      backend: new FakeBackend({}),
      input: "# Change under review",
      clock: fakeClock(),
      ledger: emptyLedger(),
      runId: "run-1",
      tools,
      toolObservation: trace.observer,
    })

    expect(trace.events.map((e) => e.type)).toEqual(["request", "outcome"])
    const outcome = trace.events[1]! as Extract<Recorded, { type: "outcome" }>
    expect(outcome.event.outcome).toMatchObject({ kind: "not-executed", refusedAt: "pre-shell" })
  })
})
