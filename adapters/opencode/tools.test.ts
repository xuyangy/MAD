/**
 * Adapter gates for the `Tools` port (story 10, CAP-8, AD-13's first route).
 *
 * Driven through the launcher seam (`options.spawn`, story 2-7c), and the
 * distinction that matters is the one this file has always been about: a git
 * FAILURE and a genuinely empty result look identical downstream unless this
 * layer separates them. Reading the exit code is what pulls them apart — so a
 * failed blame reaches the judge as a throw it reports under AD-6, never as an
 * empty string the judge would read as "the history contradicts nothing".
 *
 * ## Why the fake imitates a PROCESS rather than a shell
 *
 * `blame` runs through a launcher, not `options.$`, because a `BunShellPromise`
 * carries no pid, no kill and no abort and so cannot be terminated. A process
 * fake is also the honest shape for asserting argv: a spawn takes an array, so
 * an argv boundary is a boundary rather than something recovered from a rendered
 * command line.
 *
 * Real processes, real signals and the deadline itself are exercised in
 * `adapters/opencode/tools-observation.test.ts` against real git. This file is
 * the one for properties of this module's own code.
 */

import { describe, expect, test } from "bun:test"

import { runBoundedBlame, type SpawnBlame, type SpawnedBlame } from "./blame-exec.ts"
import { blameFailureOutcome } from "../../core/judge/blame.ts"
import { toolFailureEvidence } from "../../core/ports/tool-observation.ts"
import { blameQuarantineFor, clearBlameQuarantineForTests, latchBlameQuarantine } from "./plugin.ts"
import { GitError } from "./repo.ts"
import {
  DEFAULT_BLAME_CLEANUP_TIMEOUT_MS,
  DEFAULT_BLAME_TIMEOUT_MS,
  NotDrivenError,
  opencodeTools,
} from "./tools.ts"

interface ProcessReply {
  stdout?: string
  stderr?: string
  exitCode?: number
  /** A terminating signal reported beside the exit, as an outside kill produces. */
  signal?: string
  /** Throw from the spawn itself, as a missing binary or a bad cwd does. */
  refuse?: string
  /** Never exit, so the deadline is what ends the call. */
  hang?: boolean
  /** Never exit even after the kill, so the cleanup budget is what ends it. */
  unkillable?: boolean
  /** POST-SPAWN: the exit promise rejects instead of giving a status. */
  exitRejects?: string
  /** POST-SPAWN: the stdout pipe errors part-way through. */
  stdoutFailsAfter?: string
  /** POST-SPAWN: there is no stdout pipe at all. */
  noStdout?: boolean
}

/** One recorded launch: the argv array as handed over, boundaries intact. */
interface Launch {
  cmd: string[]
  cwd: string
}

/**
 * Matches on a substring of the joined argv, first match wins.
 *
 * THE ARGV IS KEPT AS AN ARRAY. Matching joins it, but every assertion reads
 * `launches[n].cmd`, so a path containing a space is one element here exactly as
 * it is at the system call.
 */
function fakeSpawn(replies: { match: string; reply: ProcessReply }[]) {
  const launches: Launch[] = []
  const killed: number[] = []
  /** Ends a hanging child's wait by hand, whatever it did with the signal. */
  let settleExit: (code: number) => void = () => undefined

  const spawn: SpawnBlame = (request) => {
    launches.push({ cmd: [...request.cmd], cwd: request.cwd })
    const hit = replies.find((r) => request.cmd.join(" ").includes(r.match))
    const reply = hit?.reply ?? { stdout: "", exitCode: 0 }
    if (reply.refuse !== undefined) throw new Error(reply.refuse)

    let settle: ((code: number) => void) | undefined
    const exited =
      reply.exitRejects !== undefined
        ? Promise.reject(new Error(reply.exitRejects))
        : reply.hang === true
          ? new Promise<number>((resolve) => {
              settle = resolve
              settleExit = resolve
            })
          : Promise.resolve(reply.exitCode ?? 0)
    // A rejection attached here and nowhere else would be unhandled before the
    // launcher ever looks at it, which is a property of the fake and not of the
    // code under test.
    if (reply.exitRejects !== undefined) exited.catch(() => undefined)
    const child: SpawnedBlame = {
      pid: 4242,
      stdout: reply.noStdout === true
        ? null
        : reply.stdoutFailsAfter !== undefined
          ? failingStreamOf(reply.stdout ?? "", reply.stdoutFailsAfter)
          : streamOf(reply.stdout ?? ""),
      stderr: streamOf(reply.stderr ?? ""),
      exited,
      // WITH A REJECTING EXIT PROMISE, `exitCode` models the INDEPENDENT source:
      // a status whatever reaped the process recorded on the handle. Omitted, the
      // handle knows nothing and there is no confirmation to be had.
      exitCode:
        reply.hang === true
          ? null
          : reply.exitRejects !== undefined
            ? (reply.exitCode ?? null)
            : (reply.exitCode ?? 0),
      signalCode: reply.signal ?? null,
      kill() {
        killed.push(9)
        // An `unkillable` child ignores the signal, which is exactly the state
        // the cleanup budget exists to put a bound on.
        if (reply.unkillable !== true) settle?.(-1)
      },
    }
    return child
  }

  return { spawn, launches, killed, settleExit: (code: number) => settleExit(code) }
}

/** A stream that yields a prefix and then ERRORS, as a torn read does. */
function failingStreamOf(prefix: string, why: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix.length > 0) controller.enqueue(new TextEncoder().encode(prefix))
      controller.error(new Error(why))
    },
  })
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (text.length > 0) controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

/**
 * The rejection a call produced, as an `Error`.
 *
 * `.catch((e) => e as Error)` types the result as `string | Error` — the union
 * of the resolved value and the caught one — so reading `.message` off it does
 * not compile. Rethrowing on RESOLUTION also keeps the test honest: a `blame`
 * that unexpectedly succeeds fails here rather than reading `.message` off a
 * string and reporting a confusing mismatch two lines later.
 */
function rejection(call: Promise<unknown>): Promise<Error> {
  return call.then(
    () => {
      throw new Error("expected a rejection, but the call resolved")
    },
    (error: unknown) => error as Error,
  )
}

const PORCELAIN =
  "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 12 12 1\n" +
  "author Ada Lovelace\n" +
  "author-mail <ada@example.com>\n" +
  "author-time 1709337600\n" +
  "author-tz +0000\n" +
  "summary handle the empty-cart case\n" +
  "filename src/pay.ts\n" +
  "\tif (items.length === 0) return 0\n"

describe("opencodeTools.blame", () => {
  test("runs `git blame -L <start>,<end> --porcelain -- <path>` in the worktree, and returns its stdout", async () => {
    const { spawn, launches } = fakeSpawn([{ match: "blame", reply: { stdout: PORCELAIN } }])

    const out = await opencodeTools({ worktree: "/repo", spawn }).blame("src/pay.ts", 12, 12)

    expect(out).toBe(PORCELAIN)
    expect(launches).toHaveLength(1)
    expect(launches[0]!.cmd).toEqual(["git", "blame", "-L", "12,12", "--porcelain", "--", "src/pay.ts"])
    // THE WORKTREE IS AN EXPLICIT ARGUMENT TO THE LAUNCH, rather than a binding
    // retained on a shared shell object — which is what keeps two adapters in one
    // process from taking each other's directory.
    expect(launches[0]!.cwd).toBe("/repo")
  })

  test("THE PATH IS ITS OWN ARGV ELEMENT, after `--`, however hostile it is", async () => {
    // `Finding.locus.file` is validated only as a non-empty string
    // (`core/stages/judge.ts`), so it is a discovery model's free text. It may
    // look like a flag, may carry a space, a quote, a semicolon or a `$(...)`.
    // None of that may reach anything as syntax, and `--` is what stops the
    // flag-shaped case being consumed as an option.
    const hostile = "src/--output=x; rm -rf $(pwd) 'a b'.ts"
    const { spawn, launches } = fakeSpawn([{ match: "blame", reply: { stdout: PORCELAIN } }])

    await opencodeTools({ worktree: "/repo", spawn }).blame(hostile, 1, 3)

    const argv = launches[0]!.cmd
    // ONE element, byte-for-byte, and it is the LAST one — everything before it
    // is MAD's own literal argv.
    expect(argv.at(-1)).toBe(hostile)
    expect(argv.indexOf("--")).toBe(argv.length - 2)
    expect(argv.filter((part) => part.includes("rm -rf"))).toHaveLength(1)
  })

  test("A NON-ZERO EXIT THROWS — it never degrades into empty output", async () => {
    // The failure this whole file exists for. A launcher that returned the
    // process's empty stdout for a path git has never heard of would have the
    // judge read "no contradiction found" off a command that found nothing. T4.
    const { spawn } = fakeSpawn([
      {
        match: "blame",
        reply: { exitCode: 128, stderr: "fatal: no such path 'nope.ts' in HEAD\n" },
      },
    ])

    const call = opencodeTools({ worktree: "/repo", spawn }).blame("nope.ts", 1, 2)
    await expect(call).rejects.toThrow(GitError)
    await expect(call).rejects.toThrow("no such path")
  })

  test("the GitError names the command, so the judge's warning can quote it", async () => {
    const { spawn } = fakeSpawn([{ match: "blame", reply: { exitCode: 128, stderr: "fatal: bad file\n" } }])
    const error = await rejection(opencodeTools({ worktree: "/repo", spawn }).blame("x.ts", 1, 1))
    expect(error.message).toStartWith("git blame failed:")
  })

  test("a stderr-less failure still says something (`repo.ts`'s wording, shared)", async () => {
    const { spawn } = fakeSpawn([{ match: "blame", reply: { exitCode: 1 } }])
    const error = await rejection(opencodeTools({ worktree: "/repo", spawn }).blame("x.ts", 1, 1))
    expect(error.message).toContain("git reported no detail")
  })

  test("A BAD RANGE IS REFUSED BEFORE ANY LAUNCH, and reads as MAD's fault not the repo's", async () => {
    // Reversed, zero-based, fractional and non-finite ranges are caller bugs.
    // Git would reject most of them in its own wording, which a user reads as a
    // problem with their repository. Same error type either way, so the judge's
    // one catch reports all of them under AD-6.
    const { spawn, launches } = fakeSpawn([{ match: "blame", reply: { stdout: PORCELAIN } }])
    const tools = opencodeTools({ worktree: "/repo", spawn })

    for (const [start, end] of [
      [5, 2],
      [0, 3],
      [1.5, 3],
      [Number.NaN, 3],
      [1, Number.POSITIVE_INFINITY],
    ] as const) {
      await expect(tools.blame("src/pay.ts", start, end)).rejects.toThrow(GitError)
    }
    // AND NOTHING RAN. A refusal that still spawned git would be a refusal in
    // name only.
    expect(launches).toHaveLength(0)
  })

  test("A HOST SHELL MAY BE PASSED, AND `blame` DOES NOT USE IT (story 2-7c)", async () => {
    // The shell stays on the construction surface so every caller keeps working,
    // and nothing in the blame path reads it. Asserting that it is never called
    // is what keeps it inert rather than quietly load-bearing.
    const touched: string[] = []
    const shell: any = () => {
      touched.push("ran")
      return Promise.resolve({ stdout: Buffer.from(""), stderr: Buffer.from(""), exitCode: 0 })
    }
    shell.cwd = (dir: string) => {
      touched.push(`cwd:${dir}`)
      return shell
    }
    shell.nothrow = () => {
      touched.push("nothrow")
      return shell
    }

    const { spawn, launches } = fakeSpawn([{ match: "blame", reply: { stdout: PORCELAIN } }])
    await opencodeTools({ $: shell, worktree: "/repo", spawn }).blame("src/pay.ts", 1, 1)

    expect(launches).toHaveLength(1)
    expect(touched).toEqual([])
  })
})

describe("bounded termination and the quarantine it can leave behind (story 2-7c)", () => {
  test("A BLAME THAT DOES NOT RETURN IS KILLED, and the failure carries NO exit code", async () => {
    const { spawn, killed } = fakeSpawn([{ match: "blame", reply: { hang: true } }])
    const tools = opencodeTools({ worktree: "/repo", spawn, blameTimeoutMs: 5, blameCleanupTimeoutMs: 50 })

    const error = await rejection(tools.blame("src/pay.ts", 1, 1))

    expect(killed).toEqual([9])
    // NEVER A SYNTHESIZED 124, and never a success. The reading is `unknown`,
    // which is what a call MAD stopped waiting for establishes.
    expect(toolFailureEvidence(error)).toEqual({ stage: "shell", launch: "unproved" })
    expect(blameFailureOutcome(error, "why")).toEqual({ kind: "unknown", why: "why" })
    expect(error.message).toContain("did not return within 5ms")
  })

  test("A GENEROUS DEADLINE DOES NOT FIRE — the non-vacuous sibling", async () => {
    // Without this row every assertion above passes on an adapter that timed out
    // unconditionally.
    const { spawn, killed } = fakeSpawn([{ match: "blame", reply: { stdout: PORCELAIN } }])
    const tools = opencodeTools({ worktree: "/repo", spawn, blameTimeoutMs: 30_000, blameCleanupTimeoutMs: 5_000 })

    expect(await tools.blame("src/pay.ts", 12, 12)).toBe(PORCELAIN)
    expect(killed).toEqual([])
  })

  test("AN UNCONFIRMED CLEANUP LATCHES FIRST AND NOTIFIES SECOND, and refuses every later launch", async () => {
    const { spawn, launches } = fakeSpawn([{ match: "blame", reply: { hang: true, unkillable: true } }])
    const seen: { operation: string; pid: number; refusedInside?: boolean }[] = []
    let tools: ReturnType<typeof opencodeTools>
    tools = opencodeTools({
      worktree: "/repo",
      spawn,
      blameTimeoutMs: 5,
      blameCleanupTimeoutMs: 5,
      onCleanupUnresolved: (fact) => {
        // THE LATCH IS ALREADY IN PLACE WHEN THIS RUNS. Asserted from INSIDE the
        // callback, because "latched before notified" is an ordering claim and
        // an assertion made afterwards cannot tell the two orders apart.
        void tools.blame("src/pay.ts", 1, 1).then(
          () => seen.push({ operation: fact.operation, pid: fact.pid, refusedInside: false }),
          () => seen.push({ operation: fact.operation, pid: fact.pid, refusedInside: true }),
        )
      },
    })

    const first = await rejection(tools.blame("src/pay.ts", 1, 1))
    expect(first.message).toContain("TERMINATION IS UNCONFIRMED")

    const second = await rejection(tools.blame("src/other.ts", 1, 1))
    expect(second.message).toContain("refusing to launch")
    // A REFUSAL THAT STILL LAUNCHED WOULD BE A REFUSAL IN NAME ONLY: one launch
    // in total, the one that hung.
    expect(launches).toHaveLength(1)
    // And the refusal is a PROVED non-execution, not an unknown.
    expect(blameFailureOutcome(second, "why")).toEqual({
      kind: "not-executed",
      refusedAt: "pre-shell",
      why: "why",
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(seen).toEqual([{ operation: "git blame", pid: 4242, refusedInside: true }])
  })

  test("A CALLBACK THAT THROWS RESTORES NOTHING", async () => {
    const { spawn } = fakeSpawn([{ match: "blame", reply: { hang: true, unkillable: true } }])
    const tools = opencodeTools({
      worktree: "/repo",
      spawn,
      blameTimeoutMs: 5,
      blameCleanupTimeoutMs: 5,
      onCleanupUnresolved: () => {
        throw new Error("the host could not record it")
      },
    })

    // The blame is still a failure, and the instance is still quarantined.
    await expect(tools.blame("src/pay.ts", 1, 1)).rejects.toThrow(GitError)
    await expect(tools.blame("src/pay.ts", 1, 1)).rejects.toThrow("refusing to launch")
  })

  test("A LAUNCH THE OS REFUSES DOES NOT QUARANTINE — nothing was left running", async () => {
    // The distinction the quarantine hangs on: a spawn that never started leaves
    // no process to be unaccounted for, so the next call must still be allowed.
    const { spawn, launches } = fakeSpawn([{ match: "blame", reply: { refuse: "no such file or directory" } }])
    let notified = 0
    const tools = opencodeTools({ worktree: "/repo", spawn, onCleanupUnresolved: () => (notified += 1) })

    const error = await rejection(tools.blame("src/pay.ts", 1, 1))
    expect(blameFailureOutcome(error, "why")).toEqual({ kind: "not-executed", refusedAt: "launch", why: "why" })
    await expect(tools.blame("src/pay.ts", 1, 1)).rejects.toThrow(GitError)
    expect(launches).toHaveLength(2)
    expect(notified).toBe(0)
  })
})

describe("the four undriven methods (scope discipline, story 10)", () => {
  test("each throws a NAMED error rather than returning a plausible empty answer", async () => {
    const { spawn, launches } = fakeSpawn([])
    const tools = opencodeTools({ worktree: "/repo", spawn })

    // A stub returning `""` / `[]` / `{ exitCode: 0 }` would be a wrong answer a
    // reader believes. A named failure is one a test catches.
    //
    // REJECTIONS, NOT SYNCHRONOUS THROWS (code review 2026-09-09). These methods
    // are declared to return a `Promise`, and a synchronous throw from one skips
    // the caller's `.catch()` entirely — so this test asserted the very shape
    // that made `tools.grep(x).catch(handle)` fail to reach `handle`. Asserting
    // rejection is what pins the fix.
    await expect(tools.readFile("src/pay.ts")).rejects.toThrow(NotDrivenError)
    await expect(tools.list("**/*.ts")).rejects.toThrow(NotDrivenError)
    await expect(tools.grep("fee")).rejects.toThrow(NotDrivenError)
    await expect(tools.runTest()).rejects.toThrow(NotDrivenError)

    // And the promise chain is intact: a caller may handle it the ordinary way.
    const handled = await tools.grep("fee").catch((error: unknown) => error)
    expect(handled).toBeInstanceOf(NotDrivenError)
    // AND NONE OF THEM RAN A COMMAND. `runTest` in particular is the one with a
    // real permission surface (`host-integration.md`), and this is the assertion
    // that it executes nothing at all until a story drives it.
    expect(launches).toEqual([])
  })

  test("the message names the method and says it is a story, not a patch", async () => {
    const { spawn } = fakeSpawn([])
    const tools = opencodeTools({ worktree: "/repo", spawn })
    // `rejection`, not a try/catch around a synchronous call — see the note in
    // the test above. The old shape passed only because the method threw before
    // returning its promise, which was the defect.
    const error = await rejection(tools.runTest("pay"))
    expect(error.message).toContain("Tools.runTest")
    expect(error.message).toContain("blame() only")
  })
})

describe("T6 / AD-16 — read-only BY CONSTRUCTION, asserted structurally", () => {
  test("the module contains no write path of any kind", async () => {
    // The same shape `ablation/seeded-defects.test.ts` uses for "the ablation
    // writes nothing": read the module text and assert the absence, because a
    // behavioural test can only prove the paths it happens to exercise. AD-16 is
    // an absolute — MAD never writes to the user's repo — and an absolute is
    // worth a structural assertion.
    const source = await Bun.file(new URL("./tools.ts", import.meta.url)).text()

    for (const writer of ["node:fs", "Bun.write", "writeFile", "mkdir", "rmdir", "rm(", "unlink"]) {
      expect(source, `${writer} is a write path and must not appear`).not.toContain(writer)
    }
    // And no git subcommand that mutates a repository. `git blame` is the only
    // git this file may run.
    for (const mutating of [
      "git add",
      "git commit",
      "git checkout",
      "git apply",
      "git reset",
      "git clean",
      "git stash",
      "git push",
      "git fetch",
      "git merge",
      "git rebase",
      // The quoted forms, because this adapter builds its argv as an ARRAY of
      // string literals rather than as a command line — `["blame", ...]` — so a
      // mutating verb would appear quoted and none of the `git x` probes above
      // would see it.
      '"add"',
      '"commit"',
      '"checkout"',
      '"apply"',
      '"reset"',
      '"restore"',
      '"clean"',
      '"stash"',
      '"push"',
      '"switch"',
      '"worktree"',
    ]) {
      expect(source, `${mutating} mutates a repository and must not appear`).not.toContain(mutating)
    }
  })

  test("the only git subcommand in the argv is `blame`", async () => {
    // Complements the grep above from the other side: rather than listing the
    // verbs that are forbidden, assert the one that is allowed, by running the
    // one driven method and reading what it asked for.
    const { spawn, launches } = fakeSpawn([{ match: "blame", reply: { stdout: PORCELAIN } }])
    await opencodeTools({ worktree: "/repo", spawn }).blame("src/pay.ts", 1, 4)
    expect(launches).toHaveLength(1)
    expect(launches[0]!.cmd.slice(0, 2)).toEqual(["git", "blame"])
  })

  test("it builds no material span — the CORE frames, the adapter executes (AD-1/AD-18)", async () => {
    // `scripts/lint-material-spans.ts` scans `adapters/` and would fail the
    // build on a fence here, so this is belt and braces — but it states the
    // SPLIT, which the lint cannot: this file returns raw repository text and
    // `core/prompt/material.ts` is what wraps it.
    const source = await Bun.file(new URL("./tools.ts", import.meta.url)).text()
    expect(source).not.toContain("material(")
    expect(source).not.toContain("MaterialLabel")
  })

})

describe("THE SHIPPED DEADLINES, pinned by value and by wiring (story 2-7c)", () => {
  /**
   * Run `work` with `setTimeout` watched, recording every duration registered
   * and letting `onTimer` react to each one.
   *
   * COUNTING REGISTRATIONS, NOT ELAPSED TIME. A test that waited out a real
   * minute would be asserting the clock rather than the constant, and a test
   * that only compared the adapter's behaviour against the constant it imports
   * would pass just as happily if both were changed to sixty milliseconds.
   */
  async function withTimersWatched<T>(
    onTimer: (ms: number) => void,
    work: () => Promise<T>,
  ): Promise<{ result: T; registered: number[] }> {
    const registered: number[] = []
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((handler: never, ms: never, ...rest: never[]) => {
      registered.push(ms as unknown as number)
      const id = realSetTimeout(handler, ms, ...rest)
      onTimer(ms as unknown as number)
      return id
    }) as typeof setTimeout
    try {
      return { result: await work(), registered }
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  }

  test("sixty seconds to run, five to confirm the kill — the values themselves", () => {
    // The pair `core/ports/observation-wait.test.ts` pins for the observation
    // bound, in the same shape. Without it an edit from 60_000 to 60 changes what
    // MAD ships and no test in the tree notices.
    expect(DEFAULT_BLAME_TIMEOUT_MS).toBe(60_000)
    expect(DEFAULT_BLAME_CLEANUP_TIMEOUT_MS).toBe(5_000)
  })

  test("AND THE EXECUTION DEADLINE IS THE ONE A DEFAULT CONSTRUCTION USES", async () => {
    const { spawn } = fakeSpawn([{ match: "blame", reply: { stdout: PORCELAIN } }])
    // No deadline options at all — exactly what `adapters/opencode/plugin.ts`
    // constructs, since there is no user-facing dial for either.
    const tools = opencodeTools({ worktree: "/repo", spawn })

    const { registered } = await withTimersWatched(
      () => undefined,
      () => tools.blame("src/pay.ts", 12, 12),
    )

    expect(registered).toEqual([60_000])
  })

  test("AND THE CLEANUP BUDGET IS THE ONE A DEFAULT CONSTRUCTION USES", async () => {
    // The cleanup timer only exists once a deadline has fired, so the execution
    // deadline is shortened here and the cleanup one is left at its default. The
    // child is released the moment that timer is registered, so this asserts the
    // registered duration without waiting five seconds for it.
    const { spawn, settleExit, killed } = fakeSpawn([{ match: "blame", reply: { hang: true, unkillable: true } }])
    const tools = opencodeTools({ worktree: "/repo", spawn, blameTimeoutMs: 5 })

    const { registered } = await withTimersWatched(
      (ms) => {
        if (ms === DEFAULT_BLAME_CLEANUP_TIMEOUT_MS) settleExit(-1)
      },
      () => rejection(tools.blame("src/pay.ts", 12, 12)),
    )

    expect(killed).toEqual([9])
    expect(registered).toEqual([5, 5_000])
  })
})

describe("PRE-LAUNCH AND POST-LAUNCH ARE DIFFERENT FACTS (story 2-7c)", () => {
  test("a spawn the OS refuses is the ONLY proved non-execution", async () => {
    // The reference point for every row below. `launch: "failed"` is read by
    // `core/judge/blame.ts` as `not-executed`, which is a measurement — so it
    // may only ever describe a program that was never started.
    const { spawn } = fakeSpawn([{ match: "blame", reply: { refuse: "no such file or directory" } }])
    const error = await rejection(opencodeTools({ worktree: "/repo", spawn }).blame("src/pay.ts", 1, 1))

    expect(toolFailureEvidence(error)).toEqual({ stage: "shell", launch: "failed" })
    expect(blameFailureOutcome(error, "why")).toEqual({ kind: "not-executed", refusedAt: "launch", why: "why" })
  })

  test("A REJECTED EXIT PROMISE IS UNKNOWN, NOT A PROVED NON-EXECUTION", async () => {
    // `launch-failed` is read as a PROVED non-execution, which is a measurement.
    // Holding a spawn handle is not evidence that the executable ran, so a
    // failure after the spawn establishes nothing either way and the only honest
    // reading is `unknown`.
    const { spawn, killed } = fakeSpawn([{ match: "blame", reply: { exitRejects: "the exit status could not be read" } }])
    const tools = opencodeTools({ worktree: "/repo", spawn, blameCleanupTimeoutMs: 50 })

    const error = await rejection(tools.blame("src/pay.ts", 1, 1))

    expect(toolFailureEvidence(error)).toEqual({ stage: "shell", launch: "unproved" })
    expect(blameFailureOutcome(error, "why")).toEqual({ kind: "unknown", why: "why" })
    expect(blameFailureOutcome(error, "why")).not.toMatchObject({ kind: "not-executed" })
    // Liveness was unconfirmed, so termination was ATTEMPTED rather than assumed.
    expect(killed).toEqual([9])
    expect(error.message).toContain("UNKNOWN")
  })

  test("A REJECTED EXIT PROMISE IS NOT CONFIRMATION — with no independent source it quarantines", async () => {
    // Nothing about a failed read of the exit status says the process ended.
    // This fake records neither an exit code nor a signal, so there is no
    // independent source either, and unconfirmed liveness quarantines.
    const { spawn } = fakeSpawn([{ match: "blame", reply: { exitRejects: "read failed" } }])
    let quarantined: { pid: number; why: string } | undefined
    const tools = opencodeTools({
      worktree: "/repo",
      spawn,
      blameCleanupTimeoutMs: 50,
      onCleanupUnresolved: (fact) => (quarantined = fact),
    })

    await expect(tools.blame("src/pay.ts", 1, 1)).rejects.toThrow(GitError)

    expect(quarantined).toBeDefined()
    expect(quarantined!.why).toContain("nothing confirms it ended")
    await expect(tools.blame("src/pay.ts", 1, 1)).rejects.toThrow("refusing to launch")
  })

  test("AN INDEPENDENT SOURCE DOES CONFIRM IT — the non-vacuous sibling, and it does NOT quarantine", async () => {
    // Without this row the one above would pass on an implementation that
    // quarantined every failed exit read. A real exit code recorded on the
    // handle by whatever reaped the process IS authoritative, so cleanup is
    // confirmed and an ordinary failure is enough.
    const { spawn } = fakeSpawn([{ match: "blame", reply: { exitRejects: "read failed", exitCode: 0 } }])
    let notified = 0
    const tools = opencodeTools({
      worktree: "/repo",
      spawn,
      blameCleanupTimeoutMs: 50,
      onCleanupUnresolved: () => (notified += 1),
    })
    // `exitCode` is ignored for the promise (it rejects) but is recorded on the
    // handle, which is exactly the split under test.
    const error = await rejection(tools.blame("src/pay.ts", 1, 1))

    expect(blameFailureOutcome(error, "why")).toEqual({ kind: "unknown", why: "why" })
    expect(notified).toBe(0)
    // Launch permission was never withdrawn.
    await expect(tools.blame("src/pay.ts", 1, 1)).rejects.toThrow(GitError)
    await expect(tools.blame("src/pay.ts", 1, 1)).rejects.not.toThrow("refusing to launch")
  })

  test("A TORN STDOUT READ IS NEVER PRESENTED AS COMPLETE OUTPUT", async () => {
    // The silent one. A truncated porcelain prefix PARSES, so a pipe that errors
    // part-way must not come back as `""` or as the prefix it had yielded —
    // either would build a citation over lines git never finished blaming.
    const truncated = PORCELAIN.slice(0, 60)
    const { spawn } = fakeSpawn([
      { match: "blame", reply: { stdout: truncated, stdoutFailsAfter: "the pipe broke", exitCode: 0 } },
    ])
    const tools = opencodeTools({ worktree: "/repo", spawn })

    const error = await rejection(tools.blame("src/pay.ts", 1, 1))

    // A FAILURE, not a short success. The exit was read, so the process itself
    // is accounted for and nothing quarantines — but the call produced nothing a
    // citation could rest on.
    expect(error.message).toContain("INCOMPLETE")
    expect(error.message).not.toContain(truncated)
    expect(toolFailureEvidence(error)).toEqual({ stage: "shell", launch: "unproved" })
    expect(blameFailureOutcome(error, "why")).toEqual({ kind: "unknown", why: "why" })
  })

  test("A MISSING STDOUT PIPE IS NOT AN EMPTY RESULT", async () => {
    // There is no contract under which "the launcher handed us no stdout" means
    // "the program printed nothing", so it is not reported as one.
    const { spawn } = fakeSpawn([{ match: "blame", reply: { noStdout: true, exitCode: 0 } }])
    const error = await rejection(opencodeTools({ worktree: "/repo", spawn }).blame("src/pay.ts", 1, 1))

    expect(error.message).toContain("no stdout pipe was available")
    expect(blameFailureOutcome(error, "why")).toEqual({ kind: "unknown", why: "why" })
  })

  test("AN ORDINARY SUCCESS STILL SUCCEEDS — the non-vacuous sibling for all of the above", async () => {
    const { spawn } = fakeSpawn([{ match: "blame", reply: { stdout: PORCELAIN, exitCode: 0 } }])
    expect(await opencodeTools({ worktree: "/repo", spawn }).blame("src/pay.ts", 12, 12)).toBe(PORCELAIN)
  })
})

describe("A SIGNALLED EXIT IS NOT A COMPLETED RUN (story 2-7c)", () => {
  test("status 0 WITH a terminating signal produces no citation and no success", async () => {
    // THE DELIBERATELY INCONSISTENT INJECTED RESULT. A child killed from outside
    // — an operator, an OOM killer, a session teardown — can be reported with
    // status 0 and a signal, and its stdout is whatever it had flushed. A
    // truncated porcelain prefix parses, so without this rule it would be cited
    // as a real execution over lines git never finished.
    const { spawn } = fakeSpawn([
      { match: "blame", reply: { stdout: PORCELAIN.slice(0, 60), exitCode: 0, signal: "SIGKILL" } },
    ])
    const error = await rejection(opencodeTools({ worktree: "/repo", spawn }).blame("src/pay.ts", 1, 1))

    expect(error.message).toContain("terminated by signal SIGKILL")
    // The exit code really was observed, so it is preserved — but the launch
    // reading stays `unproved`, so this is never `executed-failed`.
    expect(toolFailureEvidence(error)).toEqual({ stage: "shell", exitCode: 0, launch: "unproved" })
    expect(blameFailureOutcome(error, "why")).toEqual({ kind: "invoked-unknown", exitCode: 0, why: "why" })
  })

  test("a NON-zero exit with a signal is still not read as a git failure it can explain", async () => {
    const { spawn } = fakeSpawn([{ match: "blame", reply: { exitCode: 128, signal: "SIGTERM" } }])
    const error = await rejection(opencodeTools({ worktree: "/repo", spawn }).blame("src/pay.ts", 1, 1))
    expect(error.message).toContain("terminated by signal SIGTERM")
  })

  test("NO SIGNAL, ZERO EXIT: still an ordinary success — the non-vacuous sibling", async () => {
    const { spawn } = fakeSpawn([{ match: "blame", reply: { stdout: PORCELAIN, exitCode: 0 } }])
    expect(await opencodeTools({ worktree: "/repo", spawn }).blame("src/pay.ts", 12, 12)).toBe(PORCELAIN)
  })
})

describe("the deadlines are validated before anything launches (story 2-7c)", () => {
  test("zero, negative, NaN and past the timer ceiling are refused AT CONSTRUCTION", async () => {
    // Every one of these makes `setTimeout` fire immediately, which turns a
    // bound into an unconditional failure that reads like a hang nobody can
    // reproduce. Refused where the value is supplied, which for a construction
    // option is the construction — not once per call, and not as an outcome the
    // judge would go on to count as a measurement of the host.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      const { spawn, launches } = fakeSpawn([{ match: "blame", reply: { stdout: PORCELAIN } }])
      expect(() => opencodeTools({ worktree: "/repo", spawn, blameTimeoutMs: bad })).toThrow(RangeError)
      expect(() => opencodeTools({ worktree: "/repo", spawn, blameCleanupTimeoutMs: bad })).toThrow(RangeError)
      expect(launches).toEqual([])
    }
  })

  test("AND A GOOD PAIR STILL BUILDS AND RUNS — the non-vacuous sibling", async () => {
    const { spawn, launches } = fakeSpawn([{ match: "blame", reply: { stdout: PORCELAIN } }])
    const tools = opencodeTools({ worktree: "/repo", spawn, blameTimeoutMs: 1_000, blameCleanupTimeoutMs: 100 })
    expect(await tools.blame("src/pay.ts", 1, 1)).toBe(PORCELAIN)
    expect(launches).toHaveLength(1)
  })

  test("THE LAUNCHER'S OWN REFUSAL IS MAD'S FAULT, NOT THE HOST'S", async () => {
    // For the caller that does not come through `opencodeTools`. Nothing ran, so
    // the reading is `not-executed` either way — but `pre-shell` says MAD
    // refused, where `refusedAt: "launch"` would put a mistyped constant in this
    // repository on the record as the operating system declining to start git.
    const { spawn, launches } = fakeSpawn([{ match: "blame", reply: { stdout: PORCELAIN } }])
    const outcome = await runBoundedBlame({ argv: ["git", "blame"], cwd: "/repo", deadlineMs: 0, cleanupMs: 5, spawn })
    expect(outcome.kind).toBe("refused")
    expect(launches).toEqual([])
  })
})

describe("THE PER-WORKTREE LATCH AN ORDINARY RUN NEEDS (story 2-7c)", () => {
  test("a pre-set quarantine refuses without launching, and rides `blame-unavailable`", async () => {
    // What `adapters/opencode/plugin.ts` carries between invocations. An ordinary
    // run builds a NEW adapter each time, so without this a user retrying after
    // an unconfirmed termination starts another process beside the one already
    // unaccounted for, once per attempt.
    const { spawn, launches } = fakeSpawn([{ match: "blame", reply: { stdout: PORCELAIN } }])
    const tools = opencodeTools({
      worktree: "/repo",
      spawn,
      quarantinedBy: { operation: "git blame", why: "process 4242 was never accounted for", pid: 4242 },
    })

    const error = await rejection(tools.blame("src/pay.ts", 1, 1))

    expect(launches).toEqual([])
    expect(error.message).toContain("refusing to launch")
    // The pid reaches the user, because checking it is the recovery.
    expect(error.message).toContain("4242")
    // A PROVED non-execution — nothing was started — and it travels on the
    // existing warning rather than a new code.
    expect(blameFailureOutcome(error, "why")).toEqual({ kind: "not-executed", refusedAt: "pre-shell", why: "why" })
  })

  test("AND AN ADAPTER BUILT WITHOUT ONE STILL RUNS — the non-vacuous sibling", async () => {
    const { spawn, launches } = fakeSpawn([{ match: "blame", reply: { stdout: PORCELAIN } }])
    expect(await opencodeTools({ worktree: "/repo", spawn }).blame("src/pay.ts", 1, 1)).toBe(PORCELAIN)
    expect(launches).toHaveLength(1)
  })

  test("the plugin's latch OUTLIVES ONE INVOCATION, and a second run refuses", async () => {
    // RUN, NOT GREPPED. `MadPlugin` is reachable in tests only through a wiring
    // harness whose unreachable server URL means the blame block is never
    // entered, so the seam used to be pinned by source-text assertions alone —
    // and moving the declaration inside the plugin would leave every one of them
    // green while the latch quietly became per-invocation.
    const worktree = "/repo-latch-a"
    clearBlameQuarantineForTests(worktree)
    try {
      expect(blameQuarantineFor(worktree)).toBeUndefined()

      // Invocation one: an unconfirmed cleanup latches through the callback the
      // plugin installs.
      const first = fakeSpawn([{ match: "blame", reply: { stdout: PORCELAIN, hang: true, unkillable: true } }])
      const toolsOne = opencodeTools({
        worktree,
        spawn: first.spawn,
        blameTimeoutMs: 20,
        blameCleanupTimeoutMs: 20,
        onCleanupUnresolved: (fact) => latchBlameQuarantine(worktree, fact),
      })
      await rejection(toolsOne.blame("src/pay.ts", 1, 1))
      expect(blameQuarantineFor(worktree)).toBeDefined()

      // Invocation two: a NEW adapter, as an ordinary run builds each time. It
      // must refuse without launching, because the process from the first one is
      // still unaccounted for.
      const second = fakeSpawn([{ match: "blame", reply: { stdout: PORCELAIN } }])
      const carried = blameQuarantineFor(worktree)
      const toolsTwo = opencodeTools({
        worktree,
        spawn: second.spawn,
        ...(carried === undefined ? {} : { quarantinedBy: carried }),
      })
      const error = await rejection(toolsTwo.blame("src/pay.ts", 1, 1))

      expect(second.launches).toEqual([])
      expect(error.message).toContain("refusing to launch")
    } finally {
      clearBlameQuarantineForTests(worktree)
    }
  })

  test("AND AN UNRELATED WORKTREE STILL RUNS — the latch is keyed, not global", async () => {
    const quarantined = "/repo-latch-b"
    const healthy = "/repo-latch-c"
    clearBlameQuarantineForTests(quarantined)
    clearBlameQuarantineForTests(healthy)
    try {
      latchBlameQuarantine(quarantined, { operation: "git blame", why: "process 7 was never accounted for", pid: 7 })

      // One unaccounted-for process in one repository is no reason to refuse MAD
      // in an unrelated one.
      expect(blameQuarantineFor(healthy)).toBeUndefined()
      const { spawn, launches } = fakeSpawn([{ match: "blame", reply: { stdout: PORCELAIN } }])
      expect(await opencodeTools({ worktree: healthy, spawn }).blame("src/pay.ts", 1, 1)).toBe(PORCELAIN)
      expect(launches).toHaveLength(1)
    } finally {
      clearBlameQuarantineForTests(quarantined)
      clearBlameQuarantineForTests(healthy)
    }
  })

  test("the latch keeps the FIRST reason, and stays out of any durable store", async () => {
    const worktree = "/repo-latch-d"
    clearBlameQuarantineForTests(worktree)
    try {
      latchBlameQuarantine(worktree, { operation: "git blame", why: "first", pid: 1 })
      latchBlameQuarantine(worktree, { operation: "git blame", why: "second", pid: 2 })
      // A reason replaced is a pid lost, and the earliest process is the one an
      // operator has least chance of finding by other means.
      expect(blameQuarantineFor(worktree)?.pid).toBe(1)

      // An ordinary review has no experiment to quarantine: no file, no lock, no
      // halt marker. That one is structural because its claim is an ABSENCE.
      const source = await Bun.file(new URL("./plugin.ts", import.meta.url)).text()
      const latch = source.slice(source.indexOf("UNRESOLVED_BLAME_CLEANUP"))
      expect(latch).not.toContain("writeFile")
    } finally {
      clearBlameQuarantineForTests(worktree)
    }
  })
})

describe("A PIPE THAT CANNOT EVEN BE OPENED (story 2-7c)", () => {
  /**
   * A spawn whose named pipe is already locked by someone else, which makes
   * `getReader()` throw SYNCHRONOUSLY.
   *
   * The failure mode this guards is not a bad read but a bad ACQUISITION: a
   * throw from setup escapes past the kill, past the cleanup budget and past
   * every classification, leaving a live process behind and handing the judge a
   * value it can only read as `unknown` with no termination attempted.
   */
  function lockedPipe(which: "stdout" | "stderr") {
    const closed = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() })
    const locked = closed()
    const held = locked.getReader()
    // The OTHER pipe, kept so a test can ask whether its reader was given back.
    const other = closed()
    let kills = 0
    const spawn: SpawnBlame = () => ({
      pid: 777,
      stdout: which === "stdout" ? locked : other,
      stderr: which === "stderr" ? locked : other,
      // Never settles, so nothing but the guard can end this call.
      exited: new Promise<number>(() => {}),
      exitCode: null,
      signalCode: null,
      kill: () => {
        kills += 1
      },
    })
    return { spawn, other, kills: () => kills, release: () => held.releaseLock() }
  }

  test("A LOCKED STDOUT IS KILLED AND CLASSIFIED — it does not escape as a throw", async () => {
    const locked = lockedPipe("stdout")
    let quarantined: { pid: number; why: string } | undefined
    const tools = opencodeTools({
      worktree: "/repo",
      spawn: locked.spawn,
      blameTimeoutMs: 20,
      blameCleanupTimeoutMs: 20,
      onCleanupUnresolved: (fact) => (quarantined = fact),
    })
    try {
      const error = await rejection(tools.blame("src/pay.ts", 1, 1))

      // TERMINATION WAS ATTEMPTED. Without the guard this count is zero.
      expect(locked.kills()).toBe(1)
      // A TAGGED FAILURE the judge can classify, not a bare `TypeError`.
      expect(error).toBeInstanceOf(GitError)
      expect(error.message).toContain("could not be opened for reading")
      expect(toolFailureEvidence(error)).toEqual({ stage: "shell", launch: "unproved" })
      expect(blameFailureOutcome(error, "why")).toEqual({ kind: "unknown", why: "why" })
      // Liveness never came back, so it went through the quarantine path.
      expect(quarantined).toBeDefined()
      expect(quarantined!.pid).toBe(777)
    } finally {
      locked.release()
    }
  })

  test("A LOCKED STDERR RELEASES THE STDOUT READER ALREADY ACQUIRED", async () => {
    // The second-pipe case: stdout's reader is live by the time stderr's setup
    // fails, and it must not be left held. stderr is diagnostic, so the call is
    // not short-circuited for it — the deadline is what ends this one.
    const locked = lockedPipe("stderr")
    const tools = opencodeTools({
      worktree: "/repo",
      spawn: locked.spawn,
      blameTimeoutMs: 20,
      blameCleanupTimeoutMs: 20,
    })
    try {
      const error = await rejection(tools.blame("src/pay.ts", 1, 1))

      expect(locked.kills()).toBe(1)
      expect(error).toBeInstanceOf(GitError)
      expect(blameFailureOutcome(error, "why")).toEqual({ kind: "unknown", why: "why" })
      // THE RELEASE ITSELF, OBSERVED. `getReader()` throws while a reader is
      // held, so acquiring one here is the only direct evidence that the stdout
      // reader was given back — and without it this test asserted a kill and a
      // classification while its title claimed something it never looked at.
      // The release settles on a microtask after the cancel, so the check waits
      // one turn — it is asserting that the lock comes back, not when.
      await Promise.resolve()
      await Promise.resolve()
      expect(() => locked.other.getReader()).not.toThrow()
    } finally {
      locked.release()
    }
  })

  test("AND A HELD READER REALLY DOES REFUSE A SECOND ONE — the non-vacuous sibling", () => {
    // The assertion above is only worth anything if `getReader()` throws when the
    // lock is genuinely still held. It does.
    const stream = new ReadableStream<Uint8Array>({ start: (c) => c.close() })
    const held = stream.getReader()
    expect(() => stream.getReader()).toThrow()
    held.releaseLock()
  })

  test("AND AN OPENABLE PIPE STILL READS — the non-vacuous sibling", async () => {
    const { spawn } = fakeSpawn([{ match: "blame", reply: { stdout: PORCELAIN, exitCode: 0 } }])
    expect(await opencodeTools({ worktree: "/repo", spawn }).blame("src/pay.ts", 1, 1)).toBe(PORCELAIN)
  })
})
