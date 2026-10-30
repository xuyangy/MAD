/**
 * CAP-5 — the caller's stop reaches the shared launcher (`./blame-exec.ts`).
 */

import { describe, expect, test } from "bun:test"

import { runBoundedBlame, type SpawnBlame, type SpawnedBlame } from "./blame-exec.ts"

/** A child the test settles by hand, recording kills. */
function child(options: { unkillable?: boolean; killThrows?: boolean } = {}) {
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
    const c = child()
    const { controller, counts } = countedSignal()
    const run = runBoundedBlame({ ...base, spawn: () => c.handle, signal: controller.signal })
    await Bun.sleep(0)
    controller.abort()
    const outcome = await run
    expect(outcome).toMatchObject({ kind: "stopped", launched: true, pid: 4242, killError: null, cleanup: { kind: "confirmed" } })
    if (outcome.kind === "stopped" && outcome.launched) {
      expect(outcome.why).toContain("was stopped while running as process 4242, it was sent SIGKILL")
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
      expect(outcome.why).toContain("process 4343 itself ended (the OS reported signal SIGKILL for the killed process")
      expect(outcome.why).toContain("CLEANUP IS UNCONFIRMED and something that inherited its output may still be running")
      expect(outcome.why).not.toContain("the process may still be running")
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
    if (outcome.kind === "stopped" && outcome.launched) expect(outcome.why).toContain("SIGKILL could not be sent (EPERM)")
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
