/**
 * The launcher's own gates (story 2-7c).
 *
 * `adapters/opencode/tools.test.ts` drives this module through the adapter, so
 * everything it asserts is a property of the pair. What is pinned here is the
 * launcher's own outcome vocabulary — the distinctions `core/judge/blame.ts`
 * reads and cannot recover once two of them have been fused.
 *
 * ## The one rule every test below is a case of
 *
 * A SPAWN HANDLE IS NOT EVIDENCE THAT GIT RAN, and a promise that settled is not
 * evidence that a pipe reached its end. Both are the same mistake — treating the
 * mechanism MAD used to observe something as the thing observed — and both turn
 * a blind spot into a measurement.
 */

import { describe, expect, test } from "bun:test"

import { runBoundedBlame, type SpawnBlame, type SpawnedBlame } from "./blame-exec.ts"

/** A stream that yields its text and closes, as a healthy pipe does. */
function closedStream(text = ""): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (text.length > 0) controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

/** A stream that yields a prefix and then ERRORS, as a torn read does. */
function tornStream(prefix: string, why: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix.length > 0) controller.enqueue(new TextEncoder().encode(prefix))
      controller.error(new Error(why))
    },
  })
}

interface ChildShape {
  pid?: number
  stdout?: SpawnedBlame["stdout"]
  stderr?: SpawnedBlame["stderr"]
  exited?: Promise<number>
  exitCode?: number | null
  signalCode?: string | null
  onKill?: () => void
}

function spawnOf(shape: ChildShape): { spawn: SpawnBlame; kills: () => number } {
  let kills = 0
  const spawn: SpawnBlame = () => ({
    pid: shape.pid ?? 4242,
    stdout: "stdout" in shape ? shape.stdout : closedStream(),
    stderr: "stderr" in shape ? shape.stderr : closedStream(),
    exited: shape.exited ?? Promise.resolve(0),
    exitCode: shape.exitCode === undefined ? 0 : shape.exitCode,
    signalCode: shape.signalCode ?? null,
    kill: () => {
      kills += 1
      shape.onKill?.()
    },
  })
  return { spawn, kills: () => kills }
}

const RUN = { argv: ["git", "blame", "--porcelain"], cwd: "/repo", deadlineMs: 50, cleanupMs: 50 }

describe("a bad deadline is MAD's own refusal, not the host's", () => {
  test("`refused` rather than `launch-failed`, for every value a timer cannot hold", async () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      const { spawn, kills } = spawnOf({})
      const byDeadline = await runBoundedBlame({ ...RUN, deadlineMs: bad, spawn })
      const byCleanup = await runBoundedBlame({ ...RUN, cleanupMs: bad, spawn })

      // `launch-failed` is what `core/judge/blame.ts` reads as a PROVED
      // non-execution by the operating system. A mistyped constant in this
      // repository is not a fact about the machine the run was made on.
      expect(byDeadline.kind).toBe("refused")
      expect(byCleanup.kind).toBe("refused")
      expect(kills()).toBe(0)
    }
  })

  test("AND A GOOD PAIR REACHES THE SPAWN — the non-vacuous sibling", async () => {
    const { spawn } = spawnOf({ stdout: closedStream("porcelain") })
    const outcome = await runBoundedBlame({ ...RUN, spawn })
    expect(outcome.kind).toBe("returned")
  })
})

describe("a spawn that throws is the only proved non-execution", () => {
  test("`launch-failed`, and it carries the reason the host gave", async () => {
    const spawn: SpawnBlame = () => {
      throw new Error("No such file or directory")
    }
    const outcome = await runBoundedBlame({ ...RUN, spawn })

    expect(outcome.kind).toBe("launch-failed")
    if (outcome.kind === "launch-failed") expect(outcome.why).toContain("No such file or directory")
  })
})

describe("SETTLING IS NOT REACHING THE END — what confirmed cleanup requires", () => {
  test("a stdout pipe nothing could open leaves cleanup UNRESOLVED, not confirmed", async () => {
    // THE DEFECT THIS TEST EXISTS FOR. A pipe whose reader could not be acquired
    // resolves immediately as a tagged failure, so waiting for the three
    // promises to settle says nothing at all — and confirming on that basis
    // would report a clean process tree over a pipe MAD never read. An unread
    // pipe is the only descendant signal this layer has.
    const held = closedStream()
    const reader = held.getReader()
    try {
      const { spawn } = spawnOf({ stdout: held })
      const outcome = await runBoundedBlame({ ...RUN, spawn })

      expect(outcome.kind).toBe("observation-failed")
      if (outcome.kind === "observation-failed") {
        expect(outcome.cleanup.kind).toBe("unresolved")
        if (outcome.cleanup.kind === "unresolved") {
          expect(outcome.cleanup.why).toContain("never observed")
          expect(outcome.cleanup.why).toContain("stdout")
        }
      }
    } finally {
      reader.releaseLock()
    }
  })

  test("a stdout read that tore part-way through leaves it unresolved too", async () => {
    const { spawn } = spawnOf({ stdout: tornStream("a1b2c3 1 1 1\n", "the pipe broke") })
    const outcome = await runBoundedBlame({ ...RUN, spawn })

    // A truncated porcelain prefix parses, so the danger is a citation over lines
    // git never finished. The read is a failure AND the end was never seen.
    expect(outcome.kind).toBe("observation-failed")
    if (outcome.kind === "observation-failed") expect(outcome.cleanup.kind).toBe("unresolved")
  })

  test("NO PIPE AT ALL is a different fact, and it does not withhold confirmation", async () => {
    // Nothing was handed over, so there is no inherited write end to reason
    // about. The read still failed — the caller gets no output — but absence is
    // not evidence of a survivor, and treating it as one would quarantine every
    // run on a host that pipes differently.
    const { spawn } = spawnOf({ stdout: null })
    const outcome = await runBoundedBlame({ ...RUN, spawn })

    expect(outcome.kind).toBe("observation-failed")
    if (outcome.kind === "observation-failed") expect(outcome.cleanup.kind).toBe("confirmed")
  })

  test("AND TWO PIPES THAT REACHED EOF DO CONFIRM — the non-vacuous sibling", async () => {
    const { spawn } = spawnOf({ stdout: closedStream("porcelain"), stderr: closedStream() })
    const outcome = await runBoundedBlame({ ...RUN, spawn })

    expect(outcome.kind).toBe("returned")
    if (outcome.kind === "returned") {
      expect(outcome.stdout).toBe("porcelain")
      expect(outcome.exitCode).toBe(0)
    }
  })
})

describe("a rejected exit promise is never confirmation on its own", () => {
  test("no independent exit or signal on the handle leaves it unresolved", async () => {
    const exited = Promise.reject(new Error("the status could not be read"))
    exited.catch(() => undefined)
    const { spawn } = spawnOf({ exited, exitCode: null, signalCode: null })

    const outcome = await runBoundedBlame({ ...RUN, spawn })

    expect(outcome.kind).toBe("observation-failed")
    if (outcome.kind === "observation-failed") expect(outcome.cleanup.kind).toBe("unresolved")
  })

  test("an INDEPENDENT signal recorded on the handle does confirm it", async () => {
    // What reaped the process wrote a real signal on the handle. That is a fact
    // from somewhere other than the promise that failed, which is exactly what
    // the rule asks for — and it is preserved rather than invented.
    const exited = Promise.reject(new Error("the status could not be read"))
    exited.catch(() => undefined)
    const { spawn } = spawnOf({ exited, exitCode: null, signalCode: "SIGKILL" })

    const outcome = await runBoundedBlame({ ...RUN, spawn })

    expect(outcome.kind).toBe("observation-failed")
    if (outcome.kind === "observation-failed") {
      expect(outcome.cleanup.kind).toBe("confirmed")
      if (outcome.cleanup.kind === "confirmed") expect(outcome.cleanup.observed.signal).toBe("SIGKILL")
    }
  })
})

describe("the deadline terminates, and says which of the two facts it got", () => {
  test("a child that never returns is killed and the outcome carries no exit code", async () => {
    let settle: ((code: number) => void) | undefined
    const { spawn, kills } = spawnOf({
      exited: new Promise<number>((resolve) => {
        settle = resolve
      }),
      exitCode: null,
      onKill: () => settle?.(-1),
    })

    const outcome = await runBoundedBlame({ ...RUN, deadlineMs: 20, spawn })

    expect(kills()).toBe(1)
    expect(outcome.kind).toBe("terminated")
    // NO `124` AND NO SYNTHESIZED STATUS. `observed` is read off the HANDLE, not
    // off the promise the kill settled, so a handle that recorded nothing yields
    // `null` — which is the honest answer and the one the caller reads as
    // `unknown`. Inventing a number here is the anti-pattern the whole file was
    // written against.
    if (outcome.kind === "terminated") {
      expect(outcome.observed.exitCode).toBeNull()
      expect(outcome.observed.signal).toBeNull()
    }
  })

  test("a child that survives the kill is `cleanup-unresolved`, and names its pid", async () => {
    const { spawn } = spawnOf({
      pid: 9191,
      exited: new Promise<number>(() => {}),
      exitCode: null,
    })

    const outcome = await runBoundedBlame({ ...RUN, deadlineMs: 20, cleanupMs: 20, spawn })

    expect(outcome.kind).toBe("cleanup-unresolved")
    if (outcome.kind === "cleanup-unresolved") {
      expect(outcome.pid).toBe(9191)
      // The operator recovers by checking this process, so the reason has to say
      // it may still be running rather than that it stopped.
      expect(outcome.why).toContain("TERMINATION IS UNCONFIRMED and process 9191 may still be running")
      expect(outcome.why).not.toContain("seen to end")
    }
  })
})

describe("what the launcher will not pass off as something else", () => {
  test("NO STDERR PIPE AT ALL is TAGGED, never presented as git's text, and the call still returns", async () => {
    const { spawn, kills } = spawnOf({ stdout: closedStream("porcelain"), stderr: null, exitCode: 0 })
    const outcome = await runBoundedBlame({ ...RUN, spawn })

    expect(outcome.kind).toBe("returned")
    if (outcome.kind === "returned") {
      // The field holds what the command printed, and there was no pipe to print
      // to. MAD's account of why travels in its own field, where no reader
      // downstream can mistake it for a diagnostic git emitted. No pipe existed,
      // so nothing can be holding it, and the output stands.
      expect(outcome.stdout).toBe("porcelain")
      expect(outcome.stderr).toBe("")
      expect(outcome.stderrFailure).toContain("no stderr pipe was available")
    }
    expect(kills()).toBe(0)
  })

  test("A REAL STDERR PIPE THAT ERRORED BEFORE ITS END fails the call: cleanup unresolved, pid and exit kept, nothing killed", async () => {
    // Ledger #157. Something that inherited the write end may still be running,
    // which is the same signal an unread stdout carries, so the complete stdout
    // is not published.
    const { spawn, kills } = spawnOf({
      pid: 5353,
      stdout: closedStream("porcelain"),
      stderr: tornStream("warning: ", "the stderr pipe broke"),
      exitCode: 0,
    })
    const outcome = await runBoundedBlame({ ...RUN, spawn })

    expect(outcome.kind).toBe("observation-failed")
    if (outcome.kind === "observation-failed") {
      expect(outcome.pid).toBe(5353)
      expect(outcome.why).toContain("exited with status 0, but the stderr pipe could not be read to its end")
      expect(outcome.why).toContain("the stderr pipe broke")
      expect(outcome.cleanup.kind).toBe("unresolved")
      if (outcome.cleanup.kind === "unresolved") {
        expect(outcome.cleanup.why).toContain("stderr")
        expect(outcome.cleanup.why).toContain("never observed")
        // The child's own exit was observed, and an unresolved pipe does not unmake it.
        expect(outcome.cleanup.observed).toEqual({ exitCode: 0, signal: null })
      }
    }
    // Everything had settled: no kill was sent to a child that had exited.
    expect(kills()).toBe(0)
  })

  test("a real stderr pipe something else had locked takes the same branch", async () => {
    const held = closedStream()
    const reader = held.getReader()
    try {
      const { spawn, kills } = spawnOf({ stdout: closedStream("porcelain"), stderr: held, exitCode: 0 })
      const outcome = await runBoundedBlame({ ...RUN, spawn })

      expect(outcome.kind).toBe("observation-failed")
      if (outcome.kind === "observation-failed") {
        expect(outcome.why).toContain("the stderr pipe could not be opened for reading")
        expect(outcome.cleanup.kind).toBe("unresolved")
      }
      expect(kills()).toBe(0)
    } finally {
      reader.releaseLock()
    }
  })

  test("a handle with no usable pid reports `-1` rather than `undefined`", async () => {
    // An operator recovers by this number. `process undefined` in a halt reason
    // is a sentence nobody can act on.
    const { spawn } = spawnOf({
      pid: 0,
      exited: new Promise<number>(() => {}),
      exitCode: null,
    })

    const outcome = await runBoundedBlame({ ...RUN, deadlineMs: 20, cleanupMs: 20, spawn })

    expect(outcome.kind).toBe("cleanup-unresolved")
    if (outcome.kind === "cleanup-unresolved") expect(outcome.pid).toBe(-1)
  })

  test("a signalled exit is returned with BOTH facts, never flattened to a status", async () => {
    const { spawn } = spawnOf({ stdout: closedStream("truncated"), exitCode: 0, signalCode: "SIGTERM" })

    const outcome = await runBoundedBlame({ ...RUN, spawn })

    expect(outcome.kind).toBe("returned")
    if (outcome.kind === "returned") {
      expect(outcome.exitCode).toBe(0)
      // The caller is what refuses to build a citation over this. The launcher's
      // job is to hand over the signal it saw rather than a zero that reads as a
      // completed run.
      expect(outcome.signal).toBe("SIGTERM")
    }
  })
})

/** A stream the test feeds and ends by hand, to hold a pipe open. */
function heldStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) })
  return {
    stream,
    push: (text: string) => controller.enqueue(new TextEncoder().encode(text)),
    close: () => controller.close(),
  }
}

/** A stream that yields each text as its own chunk, then closes. */
function chunkedStream(...texts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const text of texts) controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

describe("ledger #158 — a pipe past its output limit is refused, never truncated", () => {
  const LIMITS = { stdoutBytes: 4, stderrBytes: 4 }

  test("exactly the limit is kept and returned; one byte more fails, across chunks", async () => {
    const exact = await runBoundedBlame({ ...RUN, outputLimits: LIMITS, spawn: spawnOf({ stdout: chunkedStream("ab", "cd") }).spawn })
    expect(exact.kind).toBe("returned")
    if (exact.kind === "returned") expect(exact.stdout).toBe("abcd")

    const over = await runBoundedBlame({ ...RUN, outputLimits: LIMITS, spawn: spawnOf({ stdout: chunkedStream("ab", "cde") }).spawn })
    expect(over.kind).toBe("observation-failed")
    if (over.kind === "observation-failed") {
      expect(over.why).toContain("the stdout output passed its 4-byte limit, so none of it is used")
      expect(over.why).not.toContain("abcd")
    }
  })

  test("bytes, not characters: a two-byte character that crosses the limit fails, one that fits returns", async () => {
    const fits = await runBoundedBlame({ ...RUN, outputLimits: LIMITS, spawn: spawnOf({ stdout: closedStream("abé") }).spawn })
    expect(fits.kind).toBe("returned")
    if (fits.kind === "returned") expect(fits.stdout).toBe("abé")
    const crosses = await runBoundedBlame({ ...RUN, outputLimits: LIMITS, spawn: spawnOf({ stdout: closedStream("abcé") }).spawn })
    expect(crosses.kind).toBe("observation-failed")
  })

  test("one oversized chunk on stderr fails the call too, and no output is returned", async () => {
    const outcome = await runBoundedBlame({
      ...RUN,
      outputLimits: LIMITS,
      spawn: spawnOf({ stdout: closedStream("ok"), stderr: closedStream("warning: far too long") }).spawn,
    })
    expect(outcome.kind).toBe("observation-failed")
    if (outcome.kind === "observation-failed") {
      expect(outcome.why).toContain("the stderr output passed its 4-byte limit")
      expect(outcome.why).not.toContain("warning")
    }
  })

  test("a limit that is not a positive whole number is refused before anything is spawned", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      for (const outputLimits of [{ stdoutBytes: bad }, { stderrBytes: bad }]) {
        let spawned = 0
        const spawn: SpawnBlame = (request) => (spawned++, spawnOf({}).spawn(request))
        const outcome = await runBoundedBlame({ ...RUN, outputLimits, spawn })
        expect(outcome.kind).toBe("refused")
        if (outcome.kind === "refused") expect(outcome.why).toContain("must be a positive whole number of bytes")
        expect(spawned).toBe(0)
      }
    }
  })

  test("the breach ends the wait at once: the kill comes while the exit and stderr are still held, and the drained pipes confirm", async () => {
    const stdout = heldStream()
    const stderr = heldStream()
    let exit!: (code: number) => void
    let heldWhenKilled: boolean | undefined
    let released = false
    const { spawn, kills } = spawnOf({
      stdout: stdout.stream,
      stderr: stderr.stream,
      exited: new Promise<number>((resolve) => (exit = resolve)),
      exitCode: null,
      onKill: () => {
        heldWhenKilled = !released
        // The killed child ends: its exit and both pipes close naturally.
        released = true
        stdout.push("still writing")
        stdout.close()
        stderr.close()
        exit(137)
      },
    })
    const running = runBoundedBlame({ ...RUN, deadlineMs: 60_000, cleanupMs: 2_000, outputLimits: LIMITS, spawn })
    stdout.push("abcdefgh")
    const outcome = await running

    expect(kills()).toBe(1)
    expect(heldWhenKilled).toBe(true)
    expect(outcome.kind).toBe("observation-failed")
    if (outcome.kind === "observation-failed") {
      expect(outcome.cleanup.kind).toBe("confirmed")
      expect(outcome.why).toContain("it was sent SIGKILL")
      expect(outcome.why).toContain("were accounted for")
    }
  })

  test("a breach whose child ignores the kill and holds its pipes stays unresolved", async () => {
    const stdout = heldStream()
    const stderr = heldStream()
    const { spawn, kills } = spawnOf({
      pid: 6464,
      stdout: stdout.stream,
      stderr: stderr.stream,
      exited: new Promise<number>(() => undefined),
      exitCode: null,
    })
    const running = runBoundedBlame({ ...RUN, deadlineMs: 60_000, cleanupMs: 50, outputLimits: LIMITS, spawn })
    stdout.push("abcdefgh")
    const outcome = await running

    expect(kills()).toBe(1)
    expect(outcome.kind).toBe("observation-failed")
    if (outcome.kind === "observation-failed") {
      expect(outcome.pid).toBe(6464)
      expect(outcome.cleanup.kind).toBe("unresolved")
      expect(outcome.why).toContain("the stdout output passed its 4-byte limit")
      expect(outcome.why).toContain("50ms later")
    }
  })

  test("a breach whose child exits on the kill while something still holds its stdout stays unresolved: the end was never seen", async () => {
    // The drain goes on after the breach, and only a naturally observed end
    // confirms. Stopping the read at the breach would claim an end nobody saw.
    const stdout = heldStream()
    const stderr = heldStream()
    let exit!: (code: number) => void
    const { spawn, kills } = spawnOf({
      stdout: stdout.stream,
      stderr: stderr.stream,
      exited: new Promise<number>((resolve) => (exit = resolve)),
      exitCode: null,
      onKill: () => {
        // One more write lands after the breach; the holder keeps the pipe open.
        stdout.push("more")
        stderr.close()
        exit(137)
      },
    })
    const running = runBoundedBlame({ ...RUN, deadlineMs: 60_000, cleanupMs: 50, outputLimits: LIMITS, spawn })
    stdout.push("abcdefgh")
    const outcome = await running

    expect(kills()).toBe(1)
    expect(outcome.kind).toBe("observation-failed")
    if (outcome.kind === "observation-failed") {
      expect(outcome.cleanup.kind).toBe("unresolved")
      if (outcome.cleanup.kind === "unresolved") expect(outcome.cleanup.why).toContain("stdout")
    }
  })

  test("a kill that cannot be sent is said so, and the held child stays unresolved", async () => {
    const stdout = heldStream()
    const { spawn } = spawnOf({
      stdout: stdout.stream,
      stderr: heldStream().stream,
      exited: new Promise<number>(() => undefined),
      exitCode: null,
      onKill: () => {
        throw new Error("EPERM")
      },
    })
    const running = runBoundedBlame({ ...RUN, deadlineMs: 60_000, cleanupMs: 50, outputLimits: LIMITS, spawn })
    stdout.push("abcdefgh")
    const outcome = await running
    expect(outcome.kind).toBe("observation-failed")
    if (outcome.kind === "observation-failed") {
      expect(outcome.why).toContain("SIGKILL could not be sent (EPERM)")
      expect(outcome.cleanup.kind).toBe("unresolved")
    }
  })

  test("a breach with a REJECTED exit read: the kill is still attempted, no exit is invented, and nothing confirms", async () => {
    const exited = Promise.reject(new Error("wait failed"))
    exited.catch(() => undefined)
    const { spawn, kills } = spawnOf({ stdout: closedStream("abcdefgh"), exited, exitCode: null })
    const outcome = await runBoundedBlame({ ...RUN, outputLimits: LIMITS, spawn })

    expect(kills()).toBe(1)
    expect(outcome.kind).toBe("observation-failed")
    if (outcome.kind === "observation-failed") {
      expect(outcome.cleanup.kind).toBe("unresolved")
      if (outcome.cleanup.kind === "unresolved") expect(outcome.cleanup.observed).toBeUndefined()
      expect(outcome.why).not.toContain("exited with status")
    }
  })

  test("a child that had already exited when its buffered output passed the limit is not killed, and its end is kept", async () => {
    const { spawn, kills } = spawnOf({ stdout: closedStream("abcdefgh"), exited: Promise.resolve(0), exitCode: 0 })
    const outcome = await runBoundedBlame({ ...RUN, outputLimits: LIMITS, spawn })

    expect(kills()).toBe(0)
    expect(outcome.kind).toBe("observation-failed")
    if (outcome.kind === "observation-failed") {
      expect(outcome.cleanup.kind).toBe("confirmed")
      if (outcome.cleanup.kind === "confirmed") expect(outcome.cleanup.observed).toEqual({ exitCode: 0, signal: null })
      expect(outcome.why).toMatch(/it had already exited with status 0|its end was already recorded on the handle/)
      expect(outcome.why).not.toContain("SIGKILL")
    }
  })

  test("empty chunks are skipped: interleaved with payload, exactly the limit still returns", async () => {
    const outcome = await runBoundedBlame({
      ...RUN,
      outputLimits: LIMITS,
      spawn: spawnOf({ stdout: chunkedStream("", "ab", "", "", "cd", "") }).spawn,
    })
    expect(outcome.kind).toBe("returned")
    if (outcome.kind === "returned") expect(outcome.stdout).toBe("abcd")
  })

  /** A stream that yields the same chunk `times` times, then closes: large output without a large allocation. */
  function repeated(chunk: Uint8Array, times: number): ReadableStream<Uint8Array> {
    let sent = 0
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === times) return controller.close()
        sent += 1
        controller.enqueue(chunk)
      },
    })
  }

  test("with no limits given, the defaults apply: 64 MiB of stdout and 1 MiB of stderr, each one byte past refused", async () => {
    const { DEFAULT_STDOUT_LIMIT_BYTES, DEFAULT_STDERR_LIMIT_BYTES } = await import("./blame-exec.ts")
    expect(DEFAULT_STDOUT_LIMIT_BYTES).toBe(64 * 1024 * 1024)
    expect(DEFAULT_STDERR_LIMIT_BYTES).toBe(1024 * 1024)
    const mib = new Uint8Array(1024 * 1024).fill(120)
    const byte = new Uint8Array(1).fill(120)
    const past = (chunks: number) =>
      new ReadableStream<Uint8Array>({
        start: () => undefined,
        async pull(controller) {
          const reader = repeated(mib, chunks).getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            controller.enqueue(value)
          }
          controller.enqueue(byte)
          controller.close()
        },
      })

    const stdout = await runBoundedBlame({ ...RUN, deadlineMs: 30_000, spawn: spawnOf({ stdout: past(64) }).spawn })
    expect(stdout.kind).toBe("observation-failed")
    if (stdout.kind === "observation-failed") expect(stdout.why).toContain(`the stdout output passed its ${64 * 1024 * 1024}-byte limit`)

    const stderr = await runBoundedBlame({
      ...RUN,
      deadlineMs: 30_000,
      spawn: spawnOf({ stdout: closedStream("ok"), stderr: past(1) }).spawn,
    })
    expect(stderr.kind).toBe("observation-failed")
    if (stderr.kind === "observation-failed") expect(stderr.why).toContain(`the stderr output passed its ${1024 * 1024}-byte limit`)

    // Exactly the default is kept and returned.
    const exact = await runBoundedBlame({
      ...RUN,
      deadlineMs: 30_000,
      spawn: spawnOf({ stdout: closedStream("ok"), stderr: repeated(mib, 1) }).spawn,
    })
    expect(exact.kind).toBe("returned")
  }, 60_000)
})
