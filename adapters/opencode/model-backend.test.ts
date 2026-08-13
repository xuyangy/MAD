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
