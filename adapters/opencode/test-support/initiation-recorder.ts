/**
 * CAP-5 — what was STARTED after a stop was observed, counted where it starts.
 *
 * One in-order log of three kinds of event:
 *
 * - `git`: a `Bun.spawn` or `Bun.spawnSync` call whose program is `git`, in
 *   either call form (an options object, or a `cmd` array and options), logged
 *   as the call is entered, before the child exists. Every argument is passed
 *   on unchanged.
 * - `host`: a request started through the guarded `fetch`, logged as the
 *   network guard's wrapper is entered (`installNetworkGuard`'s `onInitiate`),
 *   before the fake host has seen it. That is every request in the process
 *   while the guard is installed: the plugin's SDK clients', a test's own, and
 *   requests the guard then blocks.
 * - `stop`: the marker, logged by `fire` immediately BEFORE it aborts, so
 *   anything an abort listener starts lands after it. `fire` logs it whether or
 *   not logging is on, so a stop fired before `execute` is in the log too.
 *
 * THE RULE (`violations`). After the marker: no git spawn, no model allocation
 * (`isModelAllocation`), and no request outside the host's base URL. Anything
 * before the marker is allowed, and so is cleanup (`DELETE /session/:id`) after
 * it. No timestamps are read: order in the log is the only evidence.
 *
 * WHAT "EVERY GIT MAD STARTS" RESTS ON. MAD's own git reads start through one
 * call, the launcher's default spawn (`adapters/opencode/blame-exec.ts`
 * `defaultSpawn`), which resolves `Bun.spawn` at each call. No production file
 * under `adapters/` or `core/` uses `Bun.spawnSync`, `node:child_process` or
 * `Bun.$`; the host shell the plugin is handed is refused by the acceptance
 * suite. NOT LOGGED: `node:child_process`, `Bun.$`, and any process a logged
 * child starts itself (a `git` that a wrapper script on `PATH` execs is a
 * grandchild).
 *
 * SCOPE. Logging starts when `around` is entered and ends at `dispose`, not
 * when `around`'s body settles: detached work that starts git or a request
 * after `execute` has returned is still logged. `exempt` runs a test's own
 * bookkeeping (the repository snapshot's git reads) without logging its spawns;
 * it is tracked per async context, so concurrent work outside it is still
 * logged. `around` refuses to be entered twice. `Bun.spawn` and
 * `Bun.spawnSync` are restored by `dispose`, or at once if `around`'s body
 * throws.
 */

import { AsyncLocalStorage } from "node:async_hooks"

export type Initiated =
  | { kind: "git"; cmd: readonly string[] }
  | {
      kind: "host"
      method: string
      url: string
      /** The path relative to the host's base URL; absent when the request is outside it. */
      path?: string
    }
  | { kind: "stop" }

export interface InitiationRecorder {
  readonly log: readonly Initiated[]
  /** The host's base URL, once `attach` has been called. */
  readonly base: string | undefined
  /** Names the host's base URL, which `path` and `violations` are relative to. */
  attach(baseUrl: string): void
  /** For `installNetworkGuard`'s `onInitiate`. Logs only while logging is on. */
  onRequest(request: { method: string; url: string }): void
  /** Turns logging on, replaces the spawn functions, and runs `body`. Logging stays on until `dispose`. */
  around<T>(body: () => Promise<T>): Promise<T>
  /** Runs `body` without logging the spawns it starts. */
  exempt<T>(body: () => Promise<T>): Promise<T>
  /** Turns logging off and restores the spawn functions. Safe to call more than once. */
  dispose(): void
  /** Logs the marker, then aborts `stop`. Call it in the callback that fires the stop. */
  fire(stop: AbortController): void
  /** Every logged event after the first marker that the rule forbids, in order. */
  violations(): Initiated[]
  /** The events before the first marker. */
  beforeStop(): Initiated[]
  /** The events after the first marker. */
  afterStop(): Initiated[]
}

/** The `cmd` of a `Bun.spawn` or `Bun.spawnSync` call, in either call form. */
export function spawnCmdOf(args: readonly unknown[]): string[] {
  const first = args[0]
  if (Array.isArray(first)) return first.map(String)
  if (typeof first === "object" && first !== null) {
    const cmd = (first as { cmd?: unknown }).cmd
    if (Array.isArray(cmd)) return cmd.map(String)
  }
  return []
}

const isGit = (cmd: readonly string[]): boolean => {
  const program = cmd[0] ?? ""
  return program === "git" || program.endsWith("/git")
}

/**
 * Session routes that create a session or start model work on one, as the
 * installed SDK exposes them (`@opencode-ai/sdk/dist/v2/gen/sdk.gen.js`).
 * MAD's backend calls only `session.create`, `session.prompt` and
 * `session.delete`; the rest are listed so a call MAD should not make is caught
 * as well.
 */
const MODEL_WORK = /^\/session\/[^/]+\/(message|prompt_async|command|shell|summarize|init|fork)$/

/** A create (`POST /session`) or model work on a session, by path relative to the host's base URL. */
export const isModelAllocation = (event: Initiated): boolean =>
  event.kind === "host" &&
  event.method === "POST" &&
  event.path !== undefined &&
  (event.path === "/session" || MODEL_WORK.test(event.path))

/** `url`'s path relative to `base`, or `undefined` when `url` is not under it. */
function relativePath(url: string, base: string | undefined): string | undefined {
  if (base === undefined) return undefined
  let target: URL
  let root: URL
  try {
    target = new URL(url)
    root = new URL(base)
  } catch {
    return undefined
  }
  if (target.origin !== root.origin) return undefined
  const prefix = root.pathname.replace(/\/+$/, "")
  if (prefix === "") return target.pathname
  if (target.pathname !== prefix && !target.pathname.startsWith(`${prefix}/`)) return undefined
  return target.pathname.slice(prefix.length) || "/"
}

export function initiationRecorder(): InitiationRecorder {
  const log: Initiated[] = []
  const exempted = new AsyncLocalStorage<true>()
  let base: string | undefined
  let state: "idle" | "on" | "disposed" = "idle"
  let restore: (() => void) | undefined
  const marker = () => log.findIndex((event) => event.kind === "stop")

  const dispose = () => {
    state = "disposed"
    restore?.()
    restore = undefined
  }

  return {
    log,
    get base() {
      return base
    },
    attach(baseUrl) {
      base = baseUrl
    },
    onRequest({ method, url }) {
      if (state !== "on") return
      const path = relativePath(url, base)
      log.push({ kind: "host", method, url, ...(path === undefined ? {} : { path }) })
    },
    async around<T>(body: () => Promise<T>): Promise<T> {
      if (state !== "idle") throw new Error("initiationRecorder: around was already entered")
      const realSpawn = Bun.spawn
      const realSpawnSync = Bun.spawnSync
      const logging =
        <F extends (...args: never[]) => unknown>(real: F) =>
        (...args: unknown[]) => {
          const cmd = spawnCmdOf(args)
          if (state === "on" && exempted.getStore() === undefined && isGit(cmd)) log.push({ kind: "git", cmd })
          return (real as unknown as (...a: unknown[]) => unknown)(...args)
        }
      ;(Bun as { spawn: unknown }).spawn = logging(realSpawn)
      ;(Bun as { spawnSync: unknown }).spawnSync = logging(realSpawnSync)
      restore = () => {
        ;(Bun as { spawn: unknown }).spawn = realSpawn
        ;(Bun as { spawnSync: unknown }).spawnSync = realSpawnSync
      }
      state = "on"
      try {
        return await body()
      } catch (error) {
        dispose()
        throw error
      }
    },
    exempt: (body) => exempted.run(true, body),
    dispose,
    fire(stop) {
      log.push({ kind: "stop" })
      stop.abort()
    },
    violations() {
      const at = marker()
      if (at < 0) return []
      return log
        .slice(at + 1)
        .filter((event) => event.kind === "git" || isModelAllocation(event) || (event.kind === "host" && event.path === undefined))
    },
    beforeStop() {
      const at = marker()
      return at < 0 ? [...log] : log.slice(0, at)
    },
    afterStop() {
      const at = marker()
      return at < 0 ? [] : log.slice(at + 1)
    },
  }
}
