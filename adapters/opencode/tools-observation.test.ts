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
 * the launch-evidence rows run the real launcher against a command that does not
 * exist and against a working directory that does not exist. What they establish
 * is recorded in `tools.ts`'s header; this file is where those sentences are kept
 * honest.
 *
 * Story 2-7c added the rows for termination and for bounded observer writes, and
 * they are here for the same reason: a deadline that fires against a fake and
 * never against a real process is a deadline nobody has measured.
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
import { OBSERVATION_WRITE_TIMEOUT_MS } from "../../core/ports/observation-wait.ts"
import { runBoundedBlame } from "./blame-exec.ts"
import { clipStderr, DEFAULT_BLAME_TIMEOUT_MS, launchEvidenceFrom, opencodeTools } from "./tools.ts"

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
 * `blame` does not touch `$` — the launcher takes the working directory as an
 * argument — but this file drives `$` directly to build its repository, so the
 * default is restored after every test rather than left for the next one to trip
 * over.
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

  test("A LAUNCH THE OS REFUSES: the invocation stands, and NOT-EXECUTED is PROVED", async () => {
    // A worktree that does not exist. Story 2-7c changed the answer here, and
    // changed it in the honest direction: the old shell rejected with no exit
    // code at all, so nothing could be established and the reading was
    // `unknown`. The launcher is refused by `posix_spawn` and SEES that for
    // itself, so the same case now proves that nothing ran.
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
    // NO SHELL OUTCOME, because nothing returned one. A trace row with an
    // invented exit code would be the fabrication this story forbids.
    expect(shells(trace.events)).toHaveLength(0)
    expect(toolFailureEvidence(error)).toEqual({ stage: "shell", launch: "failed" })
    expect(blameFailureOutcome(error, "why")).toEqual({
      kind: "not-executed",
      refusedAt: "launch",
      why: "why",
    })
  })
})

describe("what the LAUNCHER actually does — measured, not assumed (story 2-7c)", () => {
  test("A MISSING COMMAND IS REFUSED BY THE OS, and no output decides it", async () => {
    // The sentence `tools.ts`'s header now rests on. The old seam read the
    // host's own `bun: command not found: ` line back out of stderr, which was
    // the only launch signal `BunShellOutput` carried; this one is the operating
    // system refusing to start the program, reported by the launcher itself.
    const outcome = await runBoundedBlame({
      argv: ["mad-no-such-binary-2-7c"],
      cwd: HERE,
      deadlineMs: 20_000,
      cleanupMs: 5_000,
    })

    expect(outcome.kind).toBe("launch-failed")
  })

  test("UNTRUSTED TEXT CAN NO LONGER FORGE A LAUNCH FAILURE, because nothing reads it", async () => {
    // THE INVERSION THIS SEAM HAS TO DEFEND AGAINST. `Finding.locus.file` is a
    // discovery model's free string and may contain a newline; git echoes the
    // path verbatim into its own `fatal:` line, so a path carrying a shell's
    // not-found wording is attacker text that could decide an execution count.
    // `launchEvidenceFrom` takes no stderr at all, so the exposure does not
    // exist rather than being matched against.
    expect(launchEvidenceFrom(128)).toBe("unproved")
    expect(launchEvidenceFrom(1)).toBe("unproved")
    expect(launchEvidenceFrom(0)).toBe("proved")
    expect(launchEvidenceFrom.length).toBe(1)
  })

  test("AND A REAL GIT FAILURE IS NOT READ AS A LAUNCH FAILURE — the non-vacuous half", async () => {
    // Both halves from the same launcher in the same run, so the distinction is
    // a measurement and not a claim: git that ran and refused comes back as an
    // ordinary non-zero exit, never as `launch-failed`.
    const outcome = await runBoundedBlame({
      argv: ["git", "blame", "--", "no-such-file.ts"],
      cwd: worktree,
      deadlineMs: 20_000,
      cleanupMs: 5_000,
    })

    expect(outcome.kind).toBe("returned")
    if (outcome.kind !== "returned") return
    expect(outcome.exitCode).not.toBe(0)
    expect(launchEvidenceFrom(outcome.exitCode)).toBe("unproved")
    expect(outcome.stderr).toContain("fatal:")
  })

  test("A CHILD THAT DOES NOT RETURN IS KILLED, AND TERMINATION IS CONFIRMED", async () => {
    // Real processes and real signals, with a tiny deadline: what is under test
    // is the path, not the wall clock. No exit code is synthesized — the OS's
    // own `SIGKILL` is what comes back.
    const outcome = await runBoundedBlame({
      argv: ["sleep", "60"],
      cwd: worktree,
      deadlineMs: 200,
      cleanupMs: 5_000,
    })

    expect(outcome.kind).toBe("terminated")
    if (outcome.kind !== "terminated") return
    expect(outcome.observed.signal).toBe("SIGKILL")
    // NOT A 124, AND NOT ANY OTHER INVENTED NUMBER.
    expect(outcome.observed.exitCode).toBeNull()
    expect(outcome.why).toContain("not evidence that git ran")
  })

  test("A DESCENDANT HOLDING THE PIPE: the deadline fires, and cleanup is UNRESOLVED", async () => {
    // Two claims in one row, and the second is the one review corrected.
    //
    // FIRST: the deadline is reachable at all. Awaiting both pipes before
    // `exited` hangs forever when a grandchild inherited the write end; the
    // pipes are raced here, so the timeout still happens.
    //
    // SECOND, AND IT USED TO BE WRONG: this must NOT read as a confirmed
    // termination. The shell exits, but `sleep 60` inherited the pipe and is
    // still running — the signal went to the child MAD spawned and never
    // reaches it. Reporting "confirmed gone" here would be a claim about a
    // process this layer cannot see, so an open pipe past the cleanup budget is
    // unresolved, and unresolved quarantines.
    const outcome = await runBoundedBlame({
      argv: ["sh", "-c", "sleep 60 & echo started; wait"],
      cwd: worktree,
      deadlineMs: 300,
      cleanupMs: 400,
    })

    expect(outcome.kind).toBe("cleanup-unresolved")
    if (outcome.kind !== "cleanup-unresolved") return
    expect(outcome.why).toContain("pipe(s) were still open")
    expect(outcome.why).toContain("TERMINATION IS UNCONFIRMED")
  })

  test("A GENEROUS DEADLINE DOES NOT FIRE — the non-vacuous sibling", async () => {
    // Without this row every assertion above would pass on a launcher that
    // timed out unconditionally.
    const outcome = await runBoundedBlame({
      argv: ["git", "blame", "-L", "1,2", "--porcelain", "--", "pay.ts"],
      cwd: worktree,
      deadlineMs: 30_000,
      cleanupMs: 5_000,
    })

    expect(outcome.kind).toBe("returned")
    if (outcome.kind !== "returned") return
    expect(outcome.exitCode).toBe(0)
    expect(parseBlamePorcelain(outcome.stdout)).toHaveLength(2)
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

describe("BOUNDED OBSERVER WRITES, through the real judge and real git (story 2-7c)", () => {
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

  /**
   * An observer whose chosen writes NEVER SETTLE, and which hands back the
   * promise it left hanging so a row can settle it afterwards.
   *
   * `new Promise(() => {})` is the hang fixture `model-backend.test.ts` already
   * uses for the same job; the deferred variant is here because two rows below
   * have to settle an abandoned write LATE and assert that nothing changed.
   */
  function hanging(writes: ReadonlySet<string>) {
    const events: string[] = []
    let reported: ToolObservationFailure[] = []
    const gates: { resolve: () => void; reject: (error: unknown) => void }[] = []
    const hang = (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        gates.push({ resolve, reject: (error) => reject(error) })
      })
    const observer: ToolObservation = {
      request: (event) => {
        events.push("request")
        return writes.has("request") ? hang() : Promise.resolve()
      },
      outcome: () => {
        events.push("outcome")
        return writes.has("outcome") ? hang() : Promise.resolve()
      },
      invoked: () => {
        events.push("invoked")
        return writes.has("invoked") ? hang() : Promise.resolve()
      },
      shellOutcome: () => {
        events.push("shellOutcome")
        return writes.has("shellOutcome") ? hang() : Promise.resolve()
      },
      failed: (failure) => {
        reported.push(failure)
      },
      takeFailures: () => {
        const taken = reported
        reported = []
        return taken
      },
    }
    return { observer, events, gates }
  }

  const run = async (observer: ToolObservation, tools: ReturnType<typeof opencodeTools>) =>
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
      toolObservation: observer,
      observationTimeoutMs: 5,
    })

  test("A CORE WRITE THAT NEVER SETTLES: the judge returns, and the run says its trace is short", async () => {
    const sink = hanging(new Set(["request", "outcome"]))
    const tools = opencodeTools({ $, worktree, toolObservation: sink.observer, observationTimeoutMs: 5 })

    const result = await run(sink.observer, tools)

    // THE HANGING SEAM RETURNED. Before the bound this call never came back.
    const raised = result.warnings.find((w) => w.code === "tool-observation-failed")
    expect(raised).toBeDefined()
    const detail = raised!.detail as { total: number; failures: { where: string; write: string; why: string }[] }
    expect(detail.failures.map((f) => `${f.where}/${f.write}`).sort()).toEqual(["core/outcome", "core/request"])
    // The reason names the write and the duration, and says what is NOT claimed.
    expect(detail.failures[0]!.why).toContain("5ms")
    expect(detail.failures[0]!.why).toContain("INCOMPLETE")

    // AND IT IS A TRACE FAILURE, NOT A BLAME FAILURE. The blame ran and produced
    // a citation; reporting this under `blame-unavailable` would tell a reader
    // the repository's history was missing from a verdict it was present for.
    expect(result.factChecksMadExecuted).toBe(1)
    expect(result.warnings.some((w) => w.code === "blame-unavailable")).toBe(false)

    // A LATE RESOLUTION AND A LATE REJECTION REACH NOTHING.
    //
    // WHAT THIS ROW CAN AND CANNOT SHOW. `judge()` has returned a value, so there
    // is no live judge-owned surface left to re-read — re-comparing `result`
    // would only restate that a returned object did not mutate itself, which is
    // a property of JavaScript rather than of this code. What is observable here
    // is the OBSERVER, which outlives the run: a fresh drain after the late
    // settlement produces nothing, so no failure was retracted and no write was
    // counted back. The claim that a run's COVERAGE stays incomplete is pinned
    // where a reader actually reads it — against the durable sink and the trace
    // file in `ablation/tool-trace.test.ts`, whose late-resolution row releases a
    // real append and then re-reads the sink's own live counters.
    sink.gates[0]!.resolve()
    sink.gates[1]!.reject(new Error("eventually"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sink.observer.takeFailures()).toEqual([])
  })

  test("AN ADAPTER WRITE THAT NEVER SETTLES: same bound, reported on the ADAPTER's side", async () => {
    const sink = hanging(new Set(["invoked", "shellOutcome"]))
    const tools = opencodeTools({ $, worktree, toolObservation: sink.observer, observationTimeoutMs: 5 })

    const result = await run(sink.observer, tools)

    const raised = result.warnings.find((w) => w.code === "tool-observation-failed")
    expect(raised).toBeDefined()
    const detail = raised!.detail as { total: number; failures: { where: string; write: string }[] }
    // The adapter holds no run record, so these reached the warning through
    // `failed` and the judge's drain — the same route a rejection takes.
    expect(detail.failures.map((f) => `${f.where}/${f.write}`).sort()).toEqual([
      "adapter/invoked",
      "adapter/shellOutcome",
    ])
    // ONLY THE TRACE IS SHORT: the citation and the execution count survive.
    expect(result.factChecksMadExecuted).toBe(1)
    expect(result.warnings.some((w) => w.code === "blame-unavailable")).toBe(false)
  })

  test("A GENEROUS DEADLINE DOES NOT FIRE — the non-vacuous sibling", async () => {
    // The same production wiring with a deadline no healthy sink can miss. Every
    // row above would pass on an implementation that abandoned unconditionally.
    const trace = memory()
    const tools = opencodeTools({ $, worktree, toolObservation: trace.observer, observationTimeoutMs: 30_000 })

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
      observationTimeoutMs: 30_000,
    })

    expect(result.warnings.some((w) => w.code === "tool-observation-failed")).toBe(false)
    expect(result.factChecksMadExecuted).toBe(1)
    expect(trace.events.map((e) => e.type)).toEqual(["request", "invoked", "shell", "outcome"])
  })

  test("AN ORDINARY RUN WITH NO OBSERVER STARTS NO TIMER AND RAISES NO OBSERVATION WARNING", async () => {
    // The matrix row that protects every non-evaluation run: absent an observer,
    // the bounded observation path is never entered, so no observation timer
    // exists.
    const timers: unknown[] = []
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((handler: never, ms: never, ...rest: never[]) => {
      timers.push(ms)
      return realSetTimeout(handler, ms, ...rest)
    }) as typeof setTimeout
    let result
    try {
      result = await judge({
        findings: [tracked()],
        roster,
        answeredSlots: roster.slots.map((s) => s.slot),
        backend: new FakeBackend({}),
        input: "# Change under review",
        clock: fakeClock(),
        ledger: emptyLedger(),
        runId: "run-1",
        tools: opencodeTools({ $, worktree }),
      })
    } finally {
      globalThis.setTimeout = realSetTimeout
    }

    // THE BLAME DEADLINE IS THERE AND IS MEANT TO BE — the blame bound applies
    // to an ordinary run too. NO OBSERVATION TIMER exists beside it.
    expect(timers).toEqual([DEFAULT_BLAME_TIMEOUT_MS])
    expect(timers).not.toContain(OBSERVATION_WRITE_TIMEOUT_MS)
    expect(result.warnings.some((w) => w.code === "tool-observation-failed")).toBe(false)
    expect(result.warnings.some((w) => w.code === "blame-unavailable")).toBe(false)
    // Citation, verdict and output semantics as today.
    expect(result.factChecksMadExecuted).toBe(1)
  })
})

describe("an ORDINARY run — no observer — whose blame times out (story 2-7c)", () => {
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

  test("DEGRADATION, NOT SILENCE: `blame-unavailable`, no citation, no execution counted", async () => {
    // AN ORDINARY REVIEW DEGRADES RATHER THAN HANGING. The blame bound applies
    // to a run with no observer too, which is the whole reason it cannot ride on
    // the observation seam. Real git that will not return: a child that sleeps,
    // through the adapter's own launcher seam.
    const tools = opencodeTools({
      $,
      worktree,
      blameTimeoutMs: 20,
      blameCleanupTimeoutMs: 5_000,
      spawn: (request) =>
        Bun.spawn({ cmd: ["sleep", "60"], cwd: request.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" }) as never,
    })

    const result = await judge({
      findings: [
        {
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
        } satisfies Finding,
      ],
      roster,
      answeredSlots: roster.slots.map((s) => s.slot),
      backend: new FakeBackend({}),
      input: "# Change under review",
      clock: fakeClock(),
      ledger: emptyLedger(),
      runId: "run-1",
      tools,
    })

    // The finding continued through normal judge logic WITHOUT blame.
    const raised = result.warnings.find((w) => w.code === "blame-unavailable")
    expect(raised).toBeDefined()
    const detail = raised!.detail as { failures: string[] }
    expect(detail.failures[0]).toContain("did not return within 20ms")
    expect(detail.failures[0]).toContain("accounted for")

    // NO CITATION AND NO EXECUTION COUNTED, even though a process really ran.
    expect(result.factChecksMadExecuted).toBe(0)
    expect(result.findings[0]!.history.some((entry) => entry.kind === "judge-blame-executed")).toBe(false)
    expect(result.findings[0]!.history.some((entry) => entry.kind === "judge-blame-failed")).toBe(true)
    // AND NO OBSERVATION WARNING, because there is no observer.
    expect(result.warnings.some((w) => w.code === "tool-observation-failed")).toBe(false)
  })
})

describe("THE SHIPPED OBSERVATION DEADLINE, at its wiring boundaries (story 2-7c)", () => {
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
    slots: ["discovery-1"].map(slotOf),
    lensSlots: [],
    requested: 1,
    distinctLineages: 1,
    providers: ["p"],
  }
  const finding = (): Finding => ({
    id: "f-1",
    claim: "the rate is never validated",
    reasoning: "a NaN rate silently produces a NaN total",
    locus: { file: "pay.ts", startLine: 1, endLine: 2 },
    severity: "high",
    author: "discovery-1",
    source: "pool",
    coDiscovery: { raised: 1, answered: 1 },
    route: "judge",
    history: [],
  })

  async function timersOf<T>(work: () => Promise<T>): Promise<number[]> {
    const registered: number[] = []
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((handler: never, ms: never, ...rest: never[]) => {
      registered.push(ms as unknown as number)
      return realSetTimeout(handler, ms, ...rest)
    }) as typeof setTimeout
    try {
      await work()
      return registered
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  }

  test("THE CORE HELPER, WIRED: a judge with an observer and no timeout option schedules 5,000 ms", async () => {
    // Exercised through real default construction rather than by reading the
    // exported constant: a `??` fallback pointing somewhere else leaves the
    // constant untouched and would satisfy an assertion about it.
    const trace = memory()
    const registered = await timersOf(() =>
      judge({
        findings: [finding()],
        roster,
        answeredSlots: ["discovery-1"],
        backend: new FakeBackend({}),
        input: "# Change under review",
        clock: fakeClock(),
        ledger: emptyLedger(),
        runId: "run-1",
        tools: opencodeTools({ $, worktree }),
        toolObservation: trace.observer,
      }),
    )

    // One 60,000 ms blame deadline, and one 5,000 ms observation deadline per
    // core write. Both are the shipped defaults and neither is read from a
    // constant this assertion imports.
    expect(registered.filter((ms) => ms === 5_000).length).toBeGreaterThan(0)
    expect(new Set(registered)).toEqual(new Set([5_000, 60_000]))
  })

  test("THE ADAPTER HELPER, WIRED: an adapter with an observer and no timeout option schedules 5,000 ms", async () => {
    const trace = memory()
    const tools = opencodeTools({ $, worktree, toolObservation: trace.observer })

    const registered = await timersOf(() => tools.blame("pay.ts", 1, 2))

    // Two adapter observation writes at 5,000 ms, plus the 60,000 ms blame.
    expect(registered.filter((ms) => ms === 5_000)).toHaveLength(2)
    expect(registered.filter((ms) => ms === 60_000)).toHaveLength(1)
  })

  test("an observation deadline that cannot bound anything is refused at construction", async () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() => opencodeTools({ $, worktree, observationTimeoutMs: bad })).toThrow(RangeError)
      await expect(
        judge({
          findings: [finding()],
          roster,
          answeredSlots: ["discovery-1"],
          backend: new FakeBackend({}),
          input: "# Change under review",
          clock: fakeClock(),
          ledger: emptyLedger(),
          runId: "run-1",
          observationTimeoutMs: bad,
        }),
      ).rejects.toThrow(RangeError)
    }
  })
})
