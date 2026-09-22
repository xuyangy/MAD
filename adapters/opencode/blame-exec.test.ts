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
      expect(outcome.why).toContain("may still be running")
    }
  })
})

describe("what the launcher will not pass off as something else", () => {
  test("a stderr pipe that could not be read is TAGGED, never presented as git's text", async () => {
    const held = closedStream()
    const reader = held.getReader()
    try {
      const { spawn } = spawnOf({ stdout: closedStream("porcelain"), stderr: held, exitCode: 0 })
      const outcome = await runBoundedBlame({ ...RUN, spawn })

      expect(outcome.kind).toBe("returned")
      if (outcome.kind === "returned") {
        // The field holds what the command printed, and it printed nothing MAD
        // could read. MAD's account of why travels in its own field, where no
        // reader downstream can mistake it for a diagnostic git emitted.
        expect(outcome.stderr).toBe("")
        expect(outcome.stderrFailure).toContain("could not be opened for reading")
      }
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
