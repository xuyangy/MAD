/**
 * A `fetch` guard for the offline acceptance suite (CAP-1).
 *
 * WHAT IT COVERS. Both SDK clients the plugin uses reach the host over
 * `fetch`, and each captures `globalThis.fetch` when it is CREATED
 * (`@opencode-ai/sdk/dist/v2/gen/client/client.gen.js`). So the guard has to be
 * installed before `MadPlugin` runs and before any client is built, and it stays
 * installed until all started work has settled.
 *
 * A request to an allowed origin, the fake host's, goes through. Any other
 * request is recorded and rejected BEFORE the underlying `fetch` is called, so
 * nothing leaves the process. `fetch.preconnect` is blocked the same way.
 *
 * NO REDIRECT IS FOLLOWED OR RETURNED. The underlying `fetch` would follow a
 * redirect from an allowed origin to any other origin by itself, outside this
 * wrapper. So every delegated call runs with `redirect: "manual"`, overriding
 * whatever the caller or a `Request` input asked for. Every redirect response,
 * same-origin included, is recorded by its resolved target and rejected. The
 * fake host never redirects, so any redirect is a fault.
 *
 * ONE GUARD AT A TIME. Installing a second guard while one is active throws, so
 * a guard leaked by an earlier failure cannot be stacked on and then "restored"
 * in place of the real `fetch`.
 *
 * AN INITIATION HOOK. `onInitiate`, when given, is called synchronously as the
 * wrapper is entered, before the request is checked, delegated or blocked, with
 * the request's method (upper-cased; from `init`, else from a `Request` input,
 * else `GET`) and absolute URL. A request the guard then blocks is reported
 * too. It is how a test logs, in order with other events, the moment a request
 * was STARTED rather than the moment the server saw it. A hook that throws does
 * not make `fetch` throw synchronously: that call returns a rejected promise
 * and nothing is delegated.
 *
 * WHAT IT DOES NOT COVER. It is not an OS network sandbox. Raw sockets
 * (`node:net`, `Bun.connect`), `WebSocket`, and child processes, including git
 * and anything git's configuration starts, are outside it. CAP-2 constrains the
 * git path.
 */

export class NetworkBlockedError extends Error {
  constructor(readonly url: string) {
    super(`network blocked by the acceptance guard: ${url}`)
    this.name = "NetworkBlockedError"
  }
}

export interface NetworkGuard {
  /** Every rejected request's absolute URL, in order. */
  readonly blocked: string[]
  /** How many requests were passed to the real `fetch`. */
  readonly delegated: () => number
  /** Puts the original `fetch` back. Safe to call more than once. */
  restore(): void
}

const GUARD_MARK = Symbol.for("mad.acceptance.network-guard")

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}

function methodOf(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): string {
  if (init?.method !== undefined) return init.method.toUpperCase()
  if (input instanceof Request) return input.method.toUpperCase()
  return "GET"
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ""
  }
}

export function installNetworkGuard(
  allowedOrigins: readonly string[],
  onInitiate?: (request: { method: string; url: string }) => void,
): NetworkGuard {
  const original = globalThis.fetch
  if ((original as unknown as Record<symbol, unknown>)[GUARD_MARK]) {
    throw new Error("a network guard is already installed; an earlier test did not restore it")
  }
  const blocked: string[] = []
  let delegated = 0
  let restored = false

  const block = (url: string): Promise<never> => {
    blocked.push(url)
    return Promise.reject(new NetworkBlockedError(url))
  }

  const guarded = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = urlOf(input)
    try {
      onInitiate?.({ method: methodOf(input, init), url })
    } catch (error) {
      return Promise.reject(error)
    }
    if (!allowedOrigins.includes(originOf(url))) return block(url)
    delegated++
    return original(input, { ...init, redirect: "manual" }).then(async (response) => {
      const isRedirect = response.type === "opaqueredirect" || (response.status >= 300 && response.status <= 399)
      if (!isRedirect) return response
      await response.body?.cancel()
      const location = response.headers.get("location")
      return block(location === null ? `(redirect ${response.status} from ${url})` : new URL(location, url).href)
    })
  }) as typeof fetch

  const preconnect = (url: string | URL) => {
    blocked.push(String(url))
    throw new NetworkBlockedError(String(url))
  }
  globalThis.fetch = Object.assign(guarded, { preconnect, [GUARD_MARK]: true })

  return {
    blocked,
    delegated: () => delegated,
    restore() {
      if (restored) return
      restored = true
      globalThis.fetch = original
    },
  }
}
