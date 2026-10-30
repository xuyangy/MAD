/**
 * CAP-5 — the caller's stop reaches the shared launcher (`./blame-exec.ts`).
 */

import { describe, expect, test } from "bun:test"

import { runBoundedBlame, type SpawnBlame, type SpawnedBlame } from "./blame-exec.ts"

/** A child the test settles by hand, recording kills. */
function child(options: { unkillable?: boolean; killThrows?: boolean; recordsSignal?: boolean } = {}) {
  let settle: (code: number) => void = () => undefined
  let closeOut: () => void = () => undefined
  let closeErr: () => void = () => undefined
  const kills: number[] = []
  const exited = new Promise<number>((resolve) => (settle = resolve))
  const handle: SpawnedBlame = {
    pid: 4242,
    stdout: new ReadableStream<Uint8Array>({ start: (c) => void (closeOut = () => c.close()) }),
    stderr: new ReadableStream<Uint8Array>({ start: (c) => void (closeErr = () => c.close()) }),
    exited,
    exitCode: null,
    signalCode: null,
    kill() {
      kills.push(9)
      if (options.killThrows) throw new Error("EPERM")
      if (options.unkillable) return
      if (options.recordsSignal) (handle as { signalCode: string | null }).signalCode = "SIGKILL"
      closeOut()
      closeErr()
      settle(137)
    },
  }
  return {
    handle,
    kills,
    exit(code: number) {
      closeOut()
      closeErr()
      settle(code)
    },
  }
}

/** A signal that counts its listeners. */
function countedSignal() {
  const controller = new AbortController()
  let added = 0
  let removed = 0
  const add = controller.signal.addEventListener.bind(controller.signal)
  const remove = controller.signal.removeEventListener.bind(controller.signal)
  controller.signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
    added += 1
    add(...args)
  }) as AbortSignal["addEventListener"]
  controller.signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
    removed += 1
    remove(...args)
  }) as AbortSignal["removeEventListener"]
  return { controller, counts: () => ({ added, removed }) }
}

const base = { argv: ["git", "diff"], cwd: "/repo", deadlineMs: 10_000, cleanupMs: 50 }

describe("the launcher's stop (CAP-5)", () => {
  test("ALREADY STOPPED: nothing is spawned", async () => {
    let spawns = 0
    const spawn: SpawnBlame = () => {
      spawns += 1
      return child().handle
    }
    const stop = new AbortController()
    stop.abort()
    expect(await runBoundedBlame({ ...base, spawn, signal: stop.signal })).toEqual({ kind: "stopped", launched: false })
    expect(spawns).toBe(0)
  })

  test("STOPPED WHILE RUNNING, cleanup confirmed: SIGKILL sent, the child and pipes accounted for, the observed exit kept", async () => {
    const c = child({ recordsSignal: true })
    const { controller, counts } = countedSignal()
    const run = runBoundedBlame({ ...base, spawn: () => c.handle, signal: controller.signal })
    await Bun.sleep(0)
    controller.abort()
    const outcome = await run
    expect(outcome).toMatchObject({ kind: "stopped", launched: true, pid: 4242, killError: null, cleanup: { kind: "confirmed" } })
    if (outcome.kind === "stopped" && outcome.launched) {
      expect(outcome.why).toContain("was stopped while running as process 4242, it was sent SIGKILL")
      expect(outcome.why).toContain("(the OS reported signal SIGKILL for process 4242, which is not evidence that git ran)")
      expect(outcome.why).not.toContain("killed process")
      expect(outcome.why).not.toContain("descendant")
    }
    expect(c.kills).toEqual([9])
    expect(counts()).toEqual({ added: 1, removed: 1 })
  })

  test("STOPPED WHILE RUNNING, cleanup unresolved: reported as unconfirmed", async () => {
    const c = child({ unkillable: true })
    const stop = new AbortController()
    const run = runBoundedBlame({ ...base, spawn: () => c.handle, signal: stop.signal })
    await Bun.sleep(0)
    stop.abort()
    const outcome = await run
    expect(outcome).toMatchObject({ kind: "stopped", launched: true, cleanup: { kind: "unresolved" } })
    if (outcome.kind === "stopped" && outcome.launched) expect(outcome.why).toContain("TERMINATION IS UNCONFIRMED")
  })

  test("THE CHILD EXITED BUT A PIPE STAYED OPEN: cleanup unresolved, and the observed signal is kept", async () => {
    let settle: (code: number) => void = () => undefined
    let closeErr: () => void = () => undefined
    const handle: SpawnedBlame = {
      pid: 4343,
      // stdout never closes: something that inherited it is still holding it.
      stdout: new ReadableStream<Uint8Array>({ start: () => undefined }),
      stderr: new ReadableStream<Uint8Array>({ start: (c) => void (closeErr = () => c.close()) }),
      exited: new Promise<number>((resolve) => (settle = resolve)),
      exitCode: null,
      signalCode: null,
      kill() {
        ;(handle as { signalCode: string | null }).signalCode = "SIGKILL"
        closeErr()
        settle(137)
      },
    }
    const stop = new AbortController()
    const run = runBoundedBlame({ ...base, spawn: () => handle, signal: stop.signal })
    await Bun.sleep(0)
    stop.abort()
    const outcome = await run
    expect(outcome).toMatchObject({
      kind: "stopped",
      launched: true,
      cleanup: { kind: "unresolved", observed: { exitCode: null, signal: "SIGKILL" } },
    })
    if (outcome.kind === "stopped" && outcome.launched) {
      expect(outcome.why).toContain(
        "process 4343 was seen to end (the OS reported signal SIGKILL for process 4343, which is not evidence that git ran), " +
          "but MAD could not confirm its cleanup, so something it started may still be running",
      )
      expect(outcome.why).toContain(
        "its stdout pipe(s) were still open — with process 4343's own exit observed, an open pipe means something " +
          "that inherited it may still be running",
      )
      expect(outcome.why).not.toContain("is still running")
      expect(outcome.why).not.toContain("process 4343 may still be running")
      expect(outcome.why).not.toContain("killed process")
    }
  })

  test("NOTHING OBSERVED, NOTHING CLAIMED: an unkillable child's unresolved cleanup carries no observed exit", async () => {
    const c = child({ unkillable: true })
    const stop = new AbortController()
    const run = runBoundedBlame({ ...base, spawn: () => c.handle, signal: stop.signal })
    await Bun.sleep(0)
    stop.abort()
    const outcome = await run
    expect(outcome.kind === "stopped" && outcome.launched && outcome.cleanup).toEqual({
      kind: "unresolved",
      why: expect.any(String),
    })
  })

  test("A KILL THAT THROWS is kept as a fact beside the cleanup", async () => {
    const c = child({ killThrows: true })
    const stop = new AbortController()
    const run = runBoundedBlame({ ...base, spawn: () => c.handle, signal: stop.signal })
    await Bun.sleep(0)
    stop.abort()
    const outcome = await run
    expect(outcome).toMatchObject({ kind: "stopped", launched: true, killError: "EPERM", cleanup: { kind: "unresolved" } })
    if (outcome.kind === "stopped" && outcome.launched) {
      expect(outcome.why).toContain("SIGKILL could not be sent (EPERM)")
      expect(outcome.why).toContain("TERMINATION IS UNCONFIRMED and process 4242 may still be running")
      expect(outcome.why).not.toContain("it was sent SIGKILL")
      expect(outcome.why).not.toContain("killed process")
    }
  })

  test("THE EXIT WINS when it is observed first: an ordinary return, and the listener is removed", async () => {
    const c = child()
    const { controller, counts } = countedSignal()
    const run = runBoundedBlame({ ...base, spawn: () => c.handle, signal: controller.signal })
    await Bun.sleep(0)
    c.exit(0)
    const outcome = await run
    controller.abort()
    expect(outcome).toMatchObject({ kind: "returned", exitCode: 0 })
    expect(c.kills).toEqual([])
    expect(counts()).toEqual({ added: 1, removed: 1 })
  })

  test("A STOP DURING THE SPAWN ITSELF is not missed", async () => {
    const c = child()
    const stop = new AbortController()
    const spawn: SpawnBlame = () => {
      stop.abort()
      return c.handle
    }
    const outcome = await runBoundedBlame({ ...base, spawn, signal: stop.signal })
    expect(outcome).toMatchObject({ kind: "stopped", launched: true })
    expect(c.kills).toEqual([9])
  })

  test("A SPAWN THAT THROWS adds no listener at all", async () => {
    const { controller, counts } = countedSignal()
    const spawn: SpawnBlame = () => {
      throw new Error("ENOENT")
    }
    expect(await runBoundedBlame({ ...base, spawn, signal: controller.signal })).toMatchObject({ kind: "launch-failed" })
    expect(counts()).toEqual({ added: 0, removed: 0 })
  })

  test("THE DEADLINE STILL WINS when it fires first, and the stop changes nothing after it", async () => {
    const c = child()
    const stop = new AbortController()
    const outcome = await runBoundedBlame({ ...base, deadlineMs: 5, spawn: () => c.handle, signal: stop.signal })
    stop.abort()
    expect(outcome.kind).toBe("terminated")
  })
})

/**
 * A child whose kill is recorded on the handle and closes both pipes, while its
 * exit read never settles: the exit was observed, the pipes reached EOF, and
 * only the exit status read stays pending.
 */
function exitReadPending(pid: number): SpawnedBlame {
  let closeOut: () => void = () => undefined
  let closeErr: () => void = () => undefined
  const handle: SpawnedBlame = {
    pid,
    stdout: new ReadableStream<Uint8Array>({ start: (c) => void (closeOut = () => c.close()) }),
    stderr: new ReadableStream<Uint8Array>({ start: (c) => void (closeErr = () => c.close()) }),
    exited: new Promise<number>(() => undefined),
    exitCode: null,
    signalCode: null,
    kill() {
      ;(handle as { signalCode: string | null }).signalCode = "SIGKILL"
      closeOut()
      closeErr()
    },
  }
  return handle
}

describe("the launcher's reasons say what was observed, for process N (#107)", () => {
  test("STOP, EXITED, EXIT READ PENDING, PIPES CLOSED: seen to end, cleanup unconfirmed, nothing blamed on a pipe", async () => {
    const stop = new AbortController()
    const run = runBoundedBlame({ ...base, spawn: () => exitReadPending(4444), signal: stop.signal })
    await Bun.sleep(0)
    stop.abort()
    const outcome = await run
    expect(outcome).toMatchObject({
      kind: "stopped",
      launched: true,
      killError: null,
      cleanup: { kind: "unresolved", observed: { exitCode: null, signal: "SIGKILL" } },
    })
    if (outcome.kind !== "stopped" || !outcome.launched) throw new Error("unreachable")
    expect(outcome.why).toContain("it was sent SIGKILL")
    expect(outcome.why).toContain("the exit read for process 4444 had not settled")
    expect(outcome.why).not.toContain("reaped")
    expect(outcome.why).toContain(
      "process 4444 was seen to end (the OS reported signal SIGKILL for process 4444, which is not evidence that git ran), " +
        "but MAD could not confirm its cleanup, so something it started may still be running",
    )
    for (const absent of ["pipe", "inherited", "process 4444 may still be running", "TERMINATION IS UNCONFIRMED", "killed process"]) {
      expect(outcome.why).not.toContain(absent)
    }
  })

  test("DEADLINE, UNRESOLVED, OBSERVED EXIT: process N was seen to end; it is not said to be running", async () => {
    const outcome = await runBoundedBlame({ ...base, deadlineMs: 5, spawn: () => exitReadPending(4545) })
    expect(outcome).toMatchObject({ kind: "cleanup-unresolved", pid: 4545 })
    expect(outcome.kind === "cleanup-unresolved" && outcome.why).toContain(
      "process 4545 was seen to end (the OS reported signal SIGKILL for process 4545, which is not evidence that git ran), " +
        "but MAD could not confirm its cleanup, so something it started may still be running",
    )
    if (outcome.kind !== "cleanup-unresolved") throw new Error("unreachable")
    for (const absent of ["TERMINATION IS UNCONFIRMED", "process 4545 may still be running", "the process may still be running", "killed process"]) {
      expect(outcome.why).not.toContain(absent)
    }
  })

  test("PIPES OPEN, NO EXIT OBSERVED: the pipe may be held by process N itself; no 'after the child is gone'", async () => {
    const c = child({ unkillable: true })
    const stop = new AbortController()
    const run = runBoundedBlame({ ...base, spawn: () => c.handle, signal: stop.signal })
    await Bun.sleep(0)
    stop.abort()
    const outcome = await run
    if (outcome.kind !== "stopped" || !outcome.launched) throw new Error("unreachable")
    expect(outcome.why).toContain(
      "the exit read for process 4242 had not settled and its stdout and stderr pipe(s) were still open — an open " +
        "pipe may be held by process 4242 or by something that inherited it: TERMINATION IS UNCONFIRMED and " +
        "process 4242 may still be running",
    )
    for (const absent of ["after the child is gone", "is still running", "seen to end"]) {
      expect(outcome.why).not.toContain(absent)
    }
  })

  test("DEADLINE, UNRESOLVED, NO EXIT OBSERVED: termination unconfirmed, and process N may still be running", async () => {
    const c = child({ unkillable: true })
    const outcome = await runBoundedBlame({ ...base, deadlineMs: 5, spawn: () => c.handle })
    expect(outcome).toMatchObject({ kind: "cleanup-unresolved", pid: 4242 })
    if (outcome.kind !== "cleanup-unresolved") throw new Error("unreachable")
    expect(outcome.why).toContain("it was sent SIGKILL")
    expect(outcome.why).toContain("TERMINATION IS UNCONFIRMED and process 4242 may still be running")
    expect(outcome.why).not.toContain("seen to end")
  })

  test("DEADLINE, KILL FAILED: the kill error and the unconfirmed termination are both kept", async () => {
    const c = child({ killThrows: true })
    const outcome = await runBoundedBlame({ ...base, deadlineMs: 5, spawn: () => c.handle })
    expect(outcome).toMatchObject({ kind: "cleanup-unresolved", pid: 4242 })
    if (outcome.kind !== "cleanup-unresolved") throw new Error("unreachable")
    expect(outcome.why).toContain("SIGKILL could not be sent (EPERM)")
    expect(outcome.why).toContain("TERMINATION IS UNCONFIRMED and process 4242 may still be running")
    expect(outcome.why).not.toContain("it was sent SIGKILL")
  })

  test("DEADLINE, CONFIRMED: the observed signal is reported for process N", async () => {
    const c = child({ recordsSignal: true })
    const outcome = await runBoundedBlame({ ...base, deadlineMs: 5, spawn: () => c.handle })
    expect(outcome).toMatchObject({ kind: "terminated", pid: 4242 })
    if (outcome.kind !== "terminated") throw new Error("unreachable")
    expect(outcome.why).toContain("process 4242 and its output were accounted for")
    expect(outcome.why).toContain("(the OS reported signal SIGKILL for process 4242, which is not evidence that git ran)")
    expect(outcome.why).not.toContain("killed process")
  })
})
