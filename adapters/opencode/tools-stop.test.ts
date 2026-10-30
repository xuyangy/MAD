/**
 * CAP-5, part 5b — the run's stop reaches MAD's `git blame` evidence reads.
 *
 * Driven through the launcher seam (`options.spawn`) with a scripted child, as
 * `tools.test.ts` is. Every row of the story's adapter matrix runs here; the rows
 * that do not involve the filter preflight run under both read policies.
 */

import { describe, expect, test } from "bun:test"

import { blameFailureOutcome } from "../../core/judge/blame.ts"
import type { ToolObservation } from "../../core/ports/tool-observation.ts"
import { toolFailureEvidence } from "../../core/ports/tool-observation.ts"
import type { SpawnBlame, SpawnedBlame } from "./blame-exec.ts"
import type { GitReadPolicy } from "./git-read-policy.ts"
import { answeringPreflight, isFilterPreflight } from "./test-support/preflight.ts"
import { opencodeTools, type BlameCleanupUnresolved } from "./tools.ts"

const PORCELAIN =
  "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 12 12 1\n" +
  "author Ada Lovelace\n" +
  "author-time 1709337600\n" +
  "author-tz +0000\n" +
  "summary handle the empty-cart case\n" +
  "\tif (items.length === 0) return 0\n"

const POLICIES: GitReadPolicy[] = ["read-only", "inherit"]

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (text.length > 0) controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

/** A child that has already returned. */
function returned(reply: { stdout?: string; stderr?: string; exitCode?: number; signal?: string }): SpawnedBlame {
  const code = reply.exitCode ?? 0
  return {
    pid: 5100,
    stdout: streamOf(reply.stdout ?? ""),
    stderr: streamOf(reply.stderr ?? ""),
    exited: Promise.resolve(code),
    exitCode: code,
    signalCode: reply.signal ?? null,
    kill: () => undefined,
  }
}

/**
 * A child that runs until it is killed. Each option leaves cleanup unresolved:
 * `unkillable` ignores the kill; `killThrows` cannot be sent SIGKILL;
 * `holdsPipe` exits on the kill while its stdout stays open, as when something
 * that inherited it is still running; `exitPending` records its signal on the
 * handle and closes both pipes on the kill while its exit promise never
 * settles.
 */
function running(
  kills: number[],
  options: { unkillable?: boolean; killThrows?: boolean; holdsPipe?: boolean; exitPending?: boolean } = {},
): SpawnedBlame {
  let settle: (code: number) => void = () => undefined
  let closeOut: () => void = () => undefined
  let closeErr: () => void = () => undefined
  const child: SpawnedBlame = {
    pid: 5200,
    stdout: new ReadableStream<Uint8Array>({ start: (c) => void (closeOut = () => c.close()) }),
    stderr: new ReadableStream<Uint8Array>({ start: (c) => void (closeErr = () => c.close()) }),
    exited: new Promise<number>((resolve) => (settle = resolve)),
    exitCode: null,
    signalCode: null,
    kill() {
      kills.push(9)
      if (options.killThrows) throw new Error("EPERM")
      if (options.unkillable) return
      if (options.exitPending) {
        ;(child as { signalCode: string | null }).signalCode = "SIGKILL"
        closeOut()
        closeErr()
        return
      }
      if (options.holdsPipe) {
        ;(child as { signalCode: string | null }).signalCode = "SIGKILL"
        closeErr()
        settle(137)
        return
      }
      closeOut()
      closeErr()
      settle(137)
    },
  }
  return child
}

/**
 * A stop whose listeners are counted, and which can fire AFTER the `n`-th
 * listener removal: the launcher removes its listener only once its race has
 * settled, so a stop fired there lands after the exit was observed and before
 * the adapter returns.
 */
function stopControl(options: { abortAfterRemoval?: number } = {}) {
  const controller = new AbortController()
  let added = 0
  let removed = 0
  const signal = controller.signal
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)
  signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
    added += 1
    add(...args)
  }) as AbortSignal["addEventListener"]
  signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
    removed += 1
    remove(...args)
    if (removed === options.abortAfterRemoval) controller.abort()
  }) as AbortSignal["removeEventListener"]
  return { controller, signal, counts: () => ({ added, removed }) }
}

/** An observer recording which adapter facts were written. */
function recorder(onInvoked?: () => void) {
  const written: string[] = []
  const observer: ToolObservation = {
    async request() {},
    async outcome() {},
    async invoked() {
      written.push("invoked")
      onInvoked?.()
    },
    async shellOutcome(fact) {
      written.push(`shellOutcome:${fact.exitCode}:${fact.launch}`)
    },
    failed() {},
    takeFailures: () => [],
  }
  return { observer, written }
}

function rejection(call: Promise<unknown>): Promise<Error> {
  return call.then(
    () => {
      throw new Error("expected a rejection, but the call resolved")
    },
    (error: unknown) => error as Error,
  )
}

/**
 * Waits until `name` has been launched. Fails at once, with a clear error, if
 * the call settles first: a call that ends before the launch the test waits
 * for would otherwise hang the test until its timeout.
 */
async function untilLaunched(seen: string[], name: string, call: Promise<unknown>): Promise<void> {
  let settled = false
  void call.then(
    () => (settled = true),
    () => (settled = true),
  )
  while (!seen.includes(name)) {
    if (settled) throw new Error(`the blame call settled before ${name} was launched`)
    await Bun.sleep(1)
  }
}

/** Records every launch, preflight included, and hands blame launches to `blame`. */
function launches(blame: () => SpawnedBlame, preflight?: () => SpawnedBlame) {
  const seen: string[] = []
  const spawn: SpawnBlame = (request) => {
    if (isFilterPreflight(request.cmd)) {
      seen.push("preflight")
      return preflight === undefined ? returned({ exitCode: 1 }) : preflight()
    }
    seen.push("blame")
    return blame()
  }
  return { spawn, seen }
}

describe("a stop observed before blame launches (CAP-5, 5b)", () => {
  for (const policy of POLICIES) {
    test(`STOPPED AT THE CALL (${policy}): nothing is spawned, no invocation is observed, the refusal is marked`, async () => {
      const { spawn, seen } = launches(() => returned({ stdout: PORCELAIN }))
      const { observer, written } = recorder()
      const stop = new AbortController()
      stop.abort()
      const tools = opencodeTools({ worktree: "/repo", spawn, gitReadPolicy: policy, toolObservation: observer, signal: stop.signal })

      const error = await rejection(tools.blame("src/pay.ts", 1, 1))

      expect(seen).toEqual([])
      expect(written).toEqual([])
      expect(error.message).toContain("the review was stopped before blame was launched")
      expect(toolFailureEvidence(error)).toEqual({ stage: "pre-shell", launch: "not-attempted", stopped: true })
    })
  }

  test("A BAD RANGE IS REFUSED FIRST, unmarked", async () => {
    const stop = new AbortController()
    stop.abort()
    const error = await rejection(opencodeTools({ worktree: "/repo", signal: stop.signal }).blame("src/pay.ts", 5, 1))
    expect(error.message).toContain("over the line range 5,1")
    expect(toolFailureEvidence(error)).toEqual({ stage: "pre-shell", launch: "not-attempted" })
  })

  test("QUARANTINED AND STOPPED: the quarantine's refusal and disclosure, unmarked", async () => {
    const { spawn, seen } = launches(() => returned({ stdout: PORCELAIN }))
    const stop = new AbortController()
    stop.abort()
    const latched: BlameCleanupUnresolved = { operation: "git blame", why: "process 9 may still be running", pid: 9 }
    const tools = opencodeTools({ worktree: "/repo", spawn, quarantinedBy: latched, signal: stop.signal })

    const error = await rejection(tools.blame("src/pay.ts", 1, 1))

    expect(seen).toEqual([])
    expect(error.message).toContain("refusing to launch: an earlier git blame could not be confirmed terminated")
    expect(error.message).toContain("process 9 may still be running")
    expect(toolFailureEvidence(error)).toEqual({ stage: "pre-shell", launch: "not-attempted" })
  })
})

describe("a stop during the filter preflight (CAP-5, 5b)", () => {
  test("STOP WHILE `git config` RUNS: it is killed, blame is not launched, the refusal is marked", async () => {
    const kills: number[] = []
    const { spawn, seen } = launches(
      () => returned({ stdout: PORCELAIN }),
      () => running(kills),
    )
    const { observer, written } = recorder()
    const stop = stopControl()
    const tools = opencodeTools({ worktree: "/repo", spawn, toolObservation: observer, signal: stop.signal, blameCleanupTimeoutMs: 50 })

    const call = rejection(tools.blame("src/pay.ts", 1, 1))
    await untilLaunched(seen, "preflight", call)
    stop.controller.abort()
    const error = await call

    expect(kills).toEqual([9])
    expect(seen).toEqual(["preflight"])
    expect(written).toEqual([])
    expect(error.message).toContain("the review was stopped during the filter preflight, so blame was not run")
    expect(toolFailureEvidence(error)).toEqual({ stage: "pre-shell", launch: "not-attempted", stopped: true })
    expect(stop.counts()).toEqual({ added: 1, removed: 1 })
  })

  test("STOP WHILE `git config` RUNS, cleanup unresolved: quarantined with a fact caused by the stop", async () => {
    const kills: number[] = []
    const { spawn, seen } = launches(
      () => returned({ stdout: PORCELAIN }),
      () => running(kills, { unkillable: true }),
    )
    const facts: BlameCleanupUnresolved[] = []
    const stop = new AbortController()
    const tools = opencodeTools({
      worktree: "/repo",
      spawn,
      signal: stop.signal,
      blameCleanupTimeoutMs: 5,
      onCleanupUnresolved: (fact) => facts.push(fact),
    })

    const call = rejection(tools.blame("src/pay.ts", 1, 1))
    await untilLaunched(seen, "preflight", call)
    stop.abort()
    const error = await call

    expect(toolFailureEvidence(error)).toEqual({ stage: "pre-shell", launch: "not-attempted", stopped: true })
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({
      operation: "git config (filter preflight)",
      pid: 5200,
      byStop: { killSent: true, exited: false },
    })
    expect(facts[0]!.why).toContain("TERMINATION IS UNCONFIRMED")
    expect(seen).toEqual(["preflight"])
  })

  test("A FILTER REFUSAL, THEN THE STOP: the filter refusal, unmarked", async () => {
    const { spawn, seen } = launches(
      () => returned({ stdout: PORCELAIN }),
      () => returned({ exitCode: 0, stdout: "filter.lfs.clean\ngit-lfs clean\0" }),
    )
    const stop = stopControl({ abortAfterRemoval: 1 })
    const error = await rejection(opencodeTools({ worktree: "/repo", spawn, signal: stop.signal }).blame("src/pay.ts", 1, 1))

    expect(stop.signal.aborted).toBe(true)
    expect(seen).toEqual(["preflight"])
    expect(error.message).toContain("defines executable filter driver(s) `lfs`")
    expect(toolFailureEvidence(error)).toEqual({ stage: "pre-shell", launch: "not-attempted" })
  })

  test("AN UNKNOWN PREFLIGHT STATUS, THEN THE STOP: that failure, unmarked", async () => {
    const { spawn } = launches(
      () => returned({ stdout: PORCELAIN }),
      () => returned({ exitCode: 3, stderr: "bad config" }),
    )
    const stop = stopControl({ abortAfterRemoval: 1 })
    const error = await rejection(opencodeTools({ worktree: "/repo", spawn, signal: stop.signal }).blame("src/pay.ts", 1, 1))

    expect(error.message).toContain("the filter preflight failed (status 3)")
    expect(toolFailureEvidence(error)).toEqual({ stage: "pre-shell", launch: "not-attempted" })
  })

  test("A SIGNALLED PREFLIGHT, THEN THE STOP: that failure, unmarked", async () => {
    const { spawn } = launches(
      () => returned({ stdout: PORCELAIN }),
      () => returned({ exitCode: 1, signal: "SIGKILL" }),
    )
    const stop = stopControl({ abortAfterRemoval: 1 })
    const error = await rejection(opencodeTools({ worktree: "/repo", spawn, signal: stop.signal }).blame("src/pay.ts", 1, 1))

    expect(error.message).toContain("did not return cleanly")
    expect(toolFailureEvidence(error)).toEqual({ stage: "pre-shell", launch: "not-attempted" })
  })

  test("A PREFLIGHT LAUNCH FAILURE, THEN THE STOP: the invocation and the launch failure, unmarked, and no spawn", async () => {
    const stop = new AbortController()
    const seen: string[] = []
    const spawn: SpawnBlame = (request) => {
      seen.push(isFilterPreflight(request.cmd) ? "preflight" : "blame")
      stop.abort()
      throw new Error("no such file or directory")
    }
    const { observer, written } = recorder()
    const error = await rejection(
      opencodeTools({ worktree: "/repo", spawn, toolObservation: observer, signal: stop.signal }).blame("src/pay.ts", 1, 1),
    )

    expect(seen).toEqual(["preflight"])
    expect(written).toEqual(["invoked"])
    expect(error.message).toContain("the command could not be started: no such file or directory")
    expect(toolFailureEvidence(error)).toEqual({ stage: "shell", launch: "failed" })
  })
})

describe("a stop between the preflight and blame's launch (CAP-5, 5b)", () => {
  test("STOP AS THE PREFLIGHT RETURNS: no invocation, no blame spawn, marked", async () => {
    const { spawn, seen } = launches(() => returned({ stdout: PORCELAIN }))
    const { observer, written } = recorder()
    const stop = stopControl({ abortAfterRemoval: 1 })
    const error = await rejection(
      opencodeTools({ worktree: "/repo", spawn, toolObservation: observer, signal: stop.signal }).blame("src/pay.ts", 1, 1),
    )

    expect(seen).toEqual(["preflight"])
    expect(written).toEqual([])
    expect(error.message).toContain("the review was stopped before blame was launched")
    expect(toolFailureEvidence(error)).toEqual({ stage: "pre-shell", launch: "not-attempted", stopped: true })
  })

  for (const policy of POLICIES) {
    test(`STOP AT THE INVOCATION WRITE (${policy}): no blame spawn, the invocation stays with no outcome`, async () => {
      const { spawn, seen } = launches(() => returned({ stdout: PORCELAIN }))
      const stop = new AbortController()
      const { observer, written } = recorder(() => stop.abort())
      const error = await rejection(
        opencodeTools({ worktree: "/repo", spawn, gitReadPolicy: policy, toolObservation: observer, signal: stop.signal }).blame(
          "src/pay.ts",
          1,
          1,
        ),
      )

      expect(seen).toEqual(policy === "read-only" ? ["preflight"] : [])
      expect(written).toEqual(["invoked"])
      expect(toolFailureEvidence(error)).toEqual({ stage: "pre-shell", launch: "not-attempted", stopped: true })
    })
  }

  test("A QUARANTINE AND A STOP WHILE THE INVOCATION IS WRITTEN: the quarantine is reported, unmarked", async () => {
    // Call A's blame outlives its deadline and its kill is never confirmed, so
    // A quarantines the adapter. Call B's invocation write is held until then,
    // and the stop fires as A quarantines.
    const kills: number[] = []
    const { spawn, seen } = launches(() => running(kills, { unkillable: true }))
    const stop = new AbortController()
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => (release = resolve))
    let invocations = 0
    const observer: ToolObservation = {
      ...recorder().observer,
      async invoked() {
        invocations += 1
        if (invocations === 2) await held
      },
    }
    const tools = opencodeTools({
      worktree: "/repo",
      spawn,
      toolObservation: observer,
      signal: stop.signal,
      blameTimeoutMs: 50,
      blameCleanupTimeoutMs: 5,
      onCleanupUnresolved: () => {
        stop.abort()
        release()
      },
    })

    const a = rejection(tools.blame("src/pay.ts", 1, 1))
    const b = rejection(tools.blame("src/pay.ts", 2, 2))
    const first = await a
    const error = await b

    expect(toolFailureEvidence(first)).toEqual({ stage: "shell", launch: "unproved" })
    expect(seen.filter((s) => s === "blame")).toHaveLength(1)
    expect(error.message).toContain("refusing to launch")
    expect(toolFailureEvidence(error)).toEqual({ stage: "pre-shell", launch: "not-attempted" })
  })
})

describe("a stop while blame runs (CAP-5, 5b)", () => {
  for (const policy of POLICIES) {
    test(`STOP DURING BLAME (${policy}): killed, marked, no outcome written, listeners removed`, async () => {
      const kills: number[] = []
      const { spawn, seen } = launches(() => running(kills))
      const { observer, written } = recorder()
      const stop = stopControl()
      const facts: BlameCleanupUnresolved[] = []
      const tools = opencodeTools({
        worktree: "/repo",
        spawn,
        gitReadPolicy: policy,
        toolObservation: observer,
        signal: stop.signal,
        blameCleanupTimeoutMs: 50,
        onCleanupUnresolved: (fact) => facts.push(fact),
      })

      const call = rejection(tools.blame("src/pay.ts", 1, 1))
      await untilLaunched(seen, "blame", call)
      stop.controller.abort()
      const error = await call

      expect(kills).toEqual([9])
      expect(written).toEqual(["invoked"])
      expect(error.message).toContain("was stopped while running as process 5200")
      expect(toolFailureEvidence(error)).toEqual({ stage: "shell", launch: "unproved", stopped: true })
      expect(facts).toEqual([])
      const launchesWithListener = policy === "read-only" ? 2 : 1
      expect(stop.counts()).toEqual({ added: launchesWithListener, removed: launchesWithListener })
    })

    const UNRESOLVED_CASES = [
      { name: "an unconfirmed child", child: { unkillable: true }, byStop: { killSent: true, exited: false } },
      { name: "SIGKILL could not be sent", child: { killThrows: true }, byStop: { killSent: false, exited: false } },
      { name: "an exited child whose pipe is held", child: { holdsPipe: true }, byStop: { killSent: true, exited: true } },
      { name: "an exited child whose exit read is pending", child: { exitPending: true }, byStop: { killSent: true, exited: true } },
    ] as const

    for (const unresolved of UNRESOLVED_CASES) {
      test(`STOP DURING BLAME, cleanup unresolved, ${unresolved.name} (${policy}): quarantined with the stop's structured facts`, async () => {
        const kills: number[] = []
        const { spawn, seen } = launches(() => running(kills, unresolved.child))
        const facts: BlameCleanupUnresolved[] = []
        const stop = new AbortController()
        const tools = opencodeTools({
          worktree: "/repo",
          spawn,
          gitReadPolicy: policy,
          signal: stop.signal,
          blameCleanupTimeoutMs: 5,
          onCleanupUnresolved: (fact) => facts.push(fact),
        })

        const call = rejection(tools.blame("src/pay.ts", 1, 1))
        await untilLaunched(seen, "blame", call)
        stop.abort()
        const error = await call

        expect(toolFailureEvidence(error)).toEqual({ stage: "shell", launch: "unproved", stopped: true })
        expect(facts).toHaveLength(1)
        expect(facts[0]).toMatchObject({ operation: "git blame", pid: 5200, byStop: unresolved.byStop })
        // The latch holds for every later call, whatever its signal.
        const later = await rejection(tools.blame("src/pay.ts", 1, 1))
        expect(later.message).toContain("refusing to launch")
        expect(seen.filter((s) => s === "blame")).toHaveLength(1)
      })
    }
  }
})

describe("an exit that won the race, then the stop before blame returns (CAP-5, 5b)", () => {
  for (const policy of POLICIES) {
    const blameRemoval = policy === "read-only" ? 2 : 1

    test(`EXIT 0 (${policy}): the outcome is written, no output is returned, the failure is marked`, async () => {
      const { spawn } = launches(() => returned({ stdout: PORCELAIN }))
      const { observer, written } = recorder()
      const stop = stopControl({ abortAfterRemoval: blameRemoval })
      const error = await rejection(
        opencodeTools({ worktree: "/repo", spawn, gitReadPolicy: policy, toolObservation: observer, signal: stop.signal }).blame(
          "src/pay.ts",
          12,
          12,
        ),
      )

      expect(written).toEqual(["invoked", "shellOutcome:0:proved"])
      expect(error.message).toContain(
        "git blame ran, but its output was not returned for use as evidence because the review was stopped",
      )
      expect(error.message).not.toContain("Ada Lovelace")
      expect(toolFailureEvidence(error)).toEqual({ stage: "shell", exitCode: 0, launch: "proved", stopped: true })
      expect(stop.counts()).toEqual({ added: blameRemoval, removed: blameRemoval })
    })

    test(`EXIT 128 (${policy}): git's own failure, unmarked`, async () => {
      const { spawn } = launches(() => returned({ exitCode: 128, stderr: "fatal: no such path 'x' in HEAD" }))
      const { observer, written } = recorder()
      const stop = stopControl({ abortAfterRemoval: blameRemoval })
      const error = await rejection(
        opencodeTools({ worktree: "/repo", spawn, gitReadPolicy: policy, toolObservation: observer, signal: stop.signal }).blame(
          "src/pay.ts",
          1,
          1,
        ),
      )

      expect(stop.signal.aborted).toBe(true)
      expect(written).toEqual(["invoked", "shellOutcome:128:unproved"])
      expect(error.message).toContain("fatal: no such path")
      expect(toolFailureEvidence(error)).toEqual({ stage: "shell", exitCode: 128, launch: "unproved" })
    })

    test(`A SIGNALLED EXIT (${policy}): its own failure, unmarked`, async () => {
      const { spawn } = launches(() => returned({ exitCode: 0, signal: "SIGTERM", stdout: PORCELAIN }))
      const stop = stopControl({ abortAfterRemoval: blameRemoval })
      const error = await rejection(
        opencodeTools({ worktree: "/repo", spawn, gitReadPolicy: policy, signal: stop.signal }).blame("src/pay.ts", 1, 1),
      )

      expect(error.message).toContain("terminated by signal SIGTERM")
      expect(toolFailureEvidence(error)).toEqual({ stage: "shell", exitCode: 0, launch: "unproved" })
    })
  }
})

describe("a signal that never fires, and the judge's reading of the mark (CAP-5, 5b)", () => {
  for (const policy of POLICIES) {
    test(`AN UNFIRED SIGNAL (${policy}) returns blame's output, and every listener is removed`, async () => {
      const { spawn } = launches(() => returned({ stdout: PORCELAIN }))
      const stop = stopControl()
      const tools = opencodeTools({ worktree: "/repo", spawn, gitReadPolicy: policy, signal: stop.signal })
      expect(await tools.blame("src/pay.ts", 12, 12)).toBe(PORCELAIN)
      const listeners = policy === "read-only" ? 2 : 1
      expect(stop.counts()).toEqual({ added: listeners, removed: listeners })
    })
  }

  test("NO SIGNAL: blame's output is returned after the preflight answers", async () => {
    const seen: string[] = []
    const spawn = answeringPreflight(() => (seen.push("blame"), returned({ stdout: PORCELAIN })))
    expect(await opencodeTools({ worktree: "/repo", spawn }).blame("src/pay.ts", 12, 12)).toBe(PORCELAIN)
    expect(seen).toEqual(["blame"])
  })

  test("THE TERMINAL READING OF A MARKED FAILURE is the ordinary one: the mark does not change what executed", async () => {
    const stop = new AbortController()
    stop.abort()
    const error = await rejection(opencodeTools({ worktree: "/repo", signal: stop.signal }).blame("src/pay.ts", 1, 1))
    expect(blameFailureOutcome(error, "stopped")).toEqual({ kind: "not-executed", refusedAt: "pre-shell", why: "stopped" })
  })
})
