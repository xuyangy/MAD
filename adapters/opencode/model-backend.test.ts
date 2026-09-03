/**
 * Adapter tests for the v1/v2 trap this story's Code Map flags as its main
 * hazard. Everything here drives the REAL `OpencodeModelBackend` through the
 * `OpencodeBackendOptions.client` seam with a hand-written fake — no mocking
 * library (spec Change Log, KEEP list).
 *
 * The point of pinning these: flipping `info.structured` to
 * `info.structured_output` breaks every model turn in production, and before
 * this file existed CI stayed green while it did.
 */

import { describe, expect, test } from "bun:test"
import { z } from "zod"

import type { RosterSlot } from "../../core/domain/roster.ts"
import { OpencodeModelBackend } from "./model-backend.ts"

const SCHEMA = z.object({ findings: z.array(z.object({ claim: z.string() })) })
const PAYLOAD = { findings: [{ claim: "off-by-one in the retry loop" }] }

const SLOTS: RosterSlot[] = [
  {
    slot: "discovery-1",
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5-20250929",
    identity: "claude-sonnet-4-5",
    lineage: { lineage: "claude", label: "Claude (Anthropic)", verified: true },
    toolcall: true,
    alsoAvailableVia: ["bedrock"],
  },
  {
    slot: "discovery-2",
    providerId: "acme",
    modelId: "acme-1",
    identity: "acme-1",
    lineage: { lineage: "unverified", label: "lineage unverified", verified: false },
    toolcall: false,
    alsoAvailableVia: [],
  },
]

interface FakeV2Options {
  /** What `session.prompt` resolves to. */
  reply?: unknown
  /** When set, `session.prompt` rejects with it instead. */
  throws?: unknown
  /** When set, `session.create` returns this instead of a fresh id. */
  create?: unknown
  /** Never resolves — used for the timeout path. */
  hang?: boolean
}

function fakeV2(options: FakeV2Options = {}) {
  const calls: { create: unknown[]; prompt: any[]; delete: unknown[] } = {
    create: [],
    prompt: [],
    delete: [],
  }
  const client = {
    session: {
      create: async (args: unknown) => {
        calls.create.push(args)
        return options.create ?? { data: { id: "ses_test" } }
      },
      prompt: async (args: unknown) => {
        calls.prompt.push(args)
        if (options.throws) throw options.throws
        if (options.hang) return new Promise(() => {})
        return options.reply ?? { data: { info: { structured: PAYLOAD } } }
      },
      delete: async (args: unknown) => {
        calls.delete.push(args)
        return { data: true }
      },
    },
  }
  return { client, calls }
}

function backendWith(options: FakeV2Options = {}, timeoutMs?: number) {
  const { client, calls } = fakeV2(options)
  const backend = new OpencodeModelBackend({
    serverUrl: "http://localhost:4096",
    directory: "/repo",
    slots: SLOTS,
    client: client as never,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
  return { backend, calls }
}

describe("runTurn — the v1/v2 structured-output contract (AD-12)", () => {
  test("passes `format` carrying the JSON schema", async () => {
    const { backend, calls } = backendWith()
    await backend.runTurn("discovery-1", "instructions", "the diff", SCHEMA)

    const sent = calls.prompt[0]
    expect(sent.format.type).toBe("json_schema")
    expect(sent.format.schema).toMatchObject({
      type: "object",
      properties: { findings: { type: "array" } },
    })
    // AD-11 — the instructions are the lever, and they travel as `system`.
    expect(sent.system).toBe("instructions")
    expect(sent.parts).toEqual([{ type: "text", text: "the diff" }])
  })

  test("sends the roster slot's concrete provider and model", async () => {
    const { backend, calls } = backendWith()
    await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(calls.prompt[0].model).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5-20250929",
    })
  })

  test("reads the payload off `structured` — NOT `structured_output`", async () => {
    const ok = await backendWith({ reply: { data: { info: { structured: PAYLOAD } } } })
      .backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(ok.ok).toBe(true)
    expect(ok.ok && ok.value).toEqual(PAYLOAD)

    // The mirror image: the docs' field name carries no payload, so reading it
    // instead would make every turn an empty-response drop-out. This assertion
    // is what fails if someone "fixes" the field name to match the docs.
    const wrong = await backendWith({
      reply: { data: { info: { structured_output: PAYLOAD } } },
    }).backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(wrong.ok).toBe(false)
    expect(!wrong.ok && wrong.failure).toBe("empty-response")
  })

  test("tolerates `structured` arriving as a JSON string", async () => {
    const result = await backendWith({
      reply: { data: { info: { structured: JSON.stringify(PAYLOAD) } } },
    }).backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(result.ok).toBe(true)
    expect(result.ok && result.value).toEqual(PAYLOAD)
  })

  test("a string that is not JSON is a schema-invalid failure, not a throw", async () => {
    const result = await backendWith({
      reply: { data: { info: { structured: "I'm afraid I can't do that" } } },
    }).backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.failure).toBe("schema-invalid")
  })

  test("a payload failing the schema returns the raw value for salvage (AD-6a)", async () => {
    const bad = { findings: [{ claim: "fine" }, { claim: 42 }] }
    const result = await backendWith({
      reply: { data: { info: { structured: bad } } },
    }).backend.runTurn("discovery-1", "i", "d", SCHEMA)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.failure).toBe("schema-invalid")
    expect(!result.ok && result.raw).toEqual(bad)
  })
})

describe("runTurn — errors are returned, never thrown (spine, Errors)", () => {
  test("a returned AssistantMessage.error becomes a failure envelope", async () => {
    const result = await backendWith({
      reply: {
        data: {
          info: {
            error: { name: "ProviderAuthError", data: { message: "401 unauthorized" } },
            tokens: { input: 5, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      },
    }).backend.runTurn("discovery-1", "i", "d", SCHEMA)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.failure).toBe("model-error")
    expect(!result.ok && result.message).toContain("ProviderAuthError")
    expect(!result.ok && result.message).toContain("401 unauthorized")
  })

  test("a transport error on the result becomes a failure envelope", async () => {
    const result = await backendWith({ reply: { error: { name: "NetworkError" } } }).backend.runTurn(
      "discovery-1",
      "i",
      "d",
      SCHEMA,
    )
    expect(result.ok).toBe(false)
    expect(!result.ok && result.failure).toBe("transport-error")
  })

  test("a thrown transport failure is caught, not propagated", async () => {
    const result = await backendWith({ throws: new Error("socket hang up") }).backend.runTurn(
      "discovery-1",
      "i",
      "d",
      SCHEMA,
    )
    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toContain("socket hang up")
  })

  test("a failed session create is a failure envelope, not a throw", async () => {
    const result = await backendWith({ create: { error: { name: "Unauthorized" } } }).backend.runTurn(
      "discovery-1",
      "i",
      "d",
      SCHEMA,
    )
    expect(result.ok).toBe(false)
    expect(!result.ok && result.failure).toBe("transport-error")
    expect(!result.ok && result.message).toContain("session")
  })

  test("an error object with no readable fields is described, never dumped", async () => {
    // An SDK error can carry the whole request config, auth headers included.
    const leaky = { request: { headers: { authorization: "Bearer sk-secret-token" } } }
    const result = await backendWith({ reply: { data: { info: { error: leaky } } } }).backend.runTurn(
      "discovery-1",
      "i",
      "d",
      SCHEMA,
    )
    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).not.toContain("sk-secret-token")
    expect(!result.ok && result.message).not.toContain("authorization")
  })

  test("a hung provider times out instead of stalling the fan-out (AD-6b)", async () => {
    const result = await backendWith({ hang: true }, 25).backend.runTurn(
      "discovery-1",
      "i",
      "d",
      SCHEMA,
    )
    expect(result.ok).toBe(false)
    expect(!result.ok && result.failure).toBe("transport-error")
    expect(!result.ok && result.message).toContain("timed out")
  })
})

/**
 * AD-2 amended / AD-6f — THE USER'S STOP, IN THE BACKEND USERS ACTUALLY RUN.
 *
 * Added by the code review of 2026-08-31. Story 7A shipped three cancellation
 * sites in this file — the pre-session check, the abort/timeout race inside
 * `withTimeout`, and the `TurnCancelledError` catch — and NONE of them was
 * executed by any test in the suite; instrumenting all three across 820 tests
 * gave zero hits. `core/run/run-control.test.ts` covers cancellation only through
 * `FakeBackend`, which has its own separate signal handling, so the adapter half
 * of the story's first third was entirely unpinned.
 *
 * What that cost: delete the catch below and a turn the user stopped comes back
 * as `transport-error` instead of `cancelled`. `runWithOneRetry` does not see
 * `failure === "cancelled"`, so it spends AD-6(b)'s retry on a turn the user
 * cancelled — billing them a second time to disobey them — and `discover.ts`'s
 * guard does not fire, so the slot is pushed to `droppedOut` and a working
 * provider is named in a `model-dropped-out` warning. That is the precise failure
 * story 7A was written to prevent, and every test still passed while it was
 * possible.
 */
describe("runTurn — cancellation (AD-2 amended, AD-6f)", () => {
  test("ALREADY ABORTED: reports `cancelled` and never creates a session", async () => {
    const { backend, calls } = backendWith()
    const controller = new AbortController()
    controller.abort()

    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA, controller.signal)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.failure).toBe("cancelled")
    // THE ASSERTION THAT MATTERS: creating a session for a turn that will not run
    // is a billed round trip for nothing, and every one of them has to be
    // disposed afterwards.
    expect(calls.create).toHaveLength(0)
    expect(calls.prompt).toHaveLength(0)
  })

  test("ABORTED IN FLIGHT: `cancelled`, NOT `transport-error` — a stop is not a drop-out", async () => {
    // The same `hang: true` fixture the timeout test uses, so the two paths are
    // pinned against each other: both mean "stop waiting", and they must produce
    // DIFFERENT failures. A timeout earns AD-6(b)'s retry; a stop must not.
    const { backend, calls } = backendWith({ hang: true }, 10_000)
    const controller = new AbortController()
    const pending = backend.runTurn("discovery-1", "i", "d", SCHEMA, controller.signal)
    controller.abort()
    const result = await pending

    expect(result.ok).toBe(false)
    expect(!result.ok && result.failure).toBe("cancelled")
    expect(!result.ok && result.failure).not.toBe("transport-error")
    // The session was created before the stop landed, so it is still disposed —
    // a cancelled turn must not orphan one.
    expect(calls.create).toHaveLength(1)
    expect(calls.delete).toHaveLength(1)
  })

  test("A LIVE SIGNAL THAT NEVER FIRES changes nothing", async () => {
    // The signal is optional and last on the port precisely so a backend that
    // ignores it still satisfies AD-2. Passing one that stays unaborted must be
    // indistinguishable from passing none.
    const controller = new AbortController()
    const result = await backendWith({
      reply: { data: { info: { structured: PAYLOAD } } },
    }).backend.runTurn("discovery-1", "i", "d", SCHEMA, controller.signal)

    expect(result.ok).toBe(true)
    expect(result.ok && result.value).toEqual(PAYLOAD)
  })

  test("NO LISTENER IS LEFT BEHIND on a long-lived signal across many turns", async () => {
    // `withTimeout` adds an `abort` listener per turn and removes it in the same
    // `finally` it clears the timer in. The host's signal outlives the whole run
    // and discovery issues twenty turns through it, so a dropped
    // `removeEventListener` is a leak that grows with the fan-out — and nothing
    // asserted the pairing until this test.
    const { backend } = backendWith({ reply: { data: { info: { structured: PAYLOAD } } } })
    const controller = new AbortController()
    for (let i = 0; i < 20; i += 1) {
      await backend.runTurn("discovery-1", "i", "d", SCHEMA, controller.signal)
    }
    // Bun/Node expose the count through the events introspection API; when it is
    // unavailable the assertion is skipped rather than faked.
    const target = controller.signal as unknown as { listenerCount?: (t: string) => number }
    if (typeof target.listenerCount === "function") {
      expect(target.listenerCount("abort")).toBe(0)
    }
  })
})

describe("runTurn — token mapping (AD-15)", () => {
  test("maps input/output/reasoning and cache read/write to the ledger's shape", async () => {
    const result = await backendWith({
      reply: {
        data: {
          info: {
            structured: PAYLOAD,
            tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 40, write: 500 } },
          },
        },
      },
    }).backend.runTurn("discovery-1", "i", "d", SCHEMA)

    // Distinct magnitudes on purpose: swapping read/write fails this test.
    expect(result.ok && result.tokens).toEqual({
      input: 1,
      output: 2,
      reasoning: 3,
      cacheRead: 40,
      cacheWrite: 500,
    })
  })

  test("missing token fields default to zero rather than NaN", async () => {
    const result = await backendWith({
      reply: { data: { info: { structured: PAYLOAD, tokens: { input: 7 } } } },
    }).backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(result.ok && result.tokens).toEqual({
      input: 7,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })
})

describe("sessions and capabilities", () => {
  test("the per-turn session is disposed, so a retry does not orphan two", async () => {
    const { backend, calls } = backendWith()
    await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    await backend.runTurn("discovery-1", "i", "d", SCHEMA)

    expect(calls.create).toHaveLength(2)
    expect(calls.delete).toHaveLength(2)
  })

  test("capabilities are read per slot from the host's toolcall flag (AD-2/AD-13)", () => {
    const { backend } = backendWith()
    expect(backend.capabilities("discovery-1")).toEqual({ tools: true })
    expect(backend.capabilities("discovery-2")).toEqual({ tools: false })
    expect(backend.capabilities("nonexistent")).toEqual({ tools: false })
  })

  test("an unknown slot is programmer error and does throw", async () => {
    const { backend } = backendWith()
    await expect(backend.runTurn("discovery-9", "i", "d", SCHEMA)).rejects.toThrow("unknown slot")
  })
})
