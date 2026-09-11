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
import type { TokenUsage } from "../../core/domain/run-record.ts"
import type { LateUsageReport, LateUsageReporter } from "../../core/ports/late-usage.ts"
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
  /**
   * Story 2.3, task 1 — `session.delete` NEVER RESOLVES.
   *
   * The seam AC3 needs and the reason this option exists at all: the fake's
   * `delete` always resolved, so a HANGING cleanup was not expressible, and the
   * unbounded `finally { await this.disposeSession(...) }` that AC3 names could
   * not be tested from outside. A test that cannot hold the cleanup open cannot
   * tell a bounded dispose from an unbounded one — both look instant.
   */
  deleteHangs?: boolean
  /**
   * Story 2.3, task 1 — `session.delete` REJECTS with this value.
   *
   * The other half of the same seam, and a different fact from the one above: a
   * host that refuses is not a host that never answers, and the bounded
   * disposal has to report both without failing the review
   * (`model-backend.ts:190-193` — "a session we cannot delete is untidy, not a
   * failure of the review"). Kept separate rather than folded into one
   * `deleteFails` flag, because a deadline and an error take different code
   * paths and a single flag would leave one of them unexercised.
   */
  deleteThrows?: unknown
  /**
   * Story 2.3, task 10 — `session.prompt` returns a promise THE TEST SETTLES,
   * through `settlePrompt` / `rejectPrompt` on the handle.
   *
   * `hang` above is the seam for "abandoned and never answers"; this is the seam
   * for "abandoned and answers LATER", which is the only state AC2 is about. The
   * two cannot be one option: a provider that never answers reports no late
   * usage by definition, so a test built on `hang` would pass against a backend
   * that dropped the continuation entirely.
   */
  pendingPrompt?: boolean
}

function fakeV2(options: FakeV2Options = {}) {
  const calls: {
    create: unknown[]
    prompt: any[]
    delete: unknown[]
    /**
     * Story 2.3 — THE TWO ROUTES THE DEV NOTES REJECTED, recorded so the
     * rejection is pinned rather than remembered.
     *
     * `session.abort` would change what a cancelled turn costs, and AC3 puts
     * anything stronger than AD-2's amendment out of scope; `session.message` /
     * `session.messages` read-back would have to DEFER disposal on exactly the
     * path AC3 requires to be bounded, because `session.delete` permanently
     * removes history. Both exist on the real v2 client, so a backend that
     * started calling one would type-check and pass every other test in this
     * file. These counters are what would fail.
     */
    abort: unknown[]
    message: unknown[]
    messages: unknown[]
  } = {
    create: [],
    prompt: [],
    delete: [],
    abort: [],
    message: [],
    messages: [],
  }
  let settle: ((value: unknown) => void) | undefined
  let fail: ((error: unknown) => void) | undefined
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
        if (options.pendingPrompt) {
          return new Promise((resolve, reject) => {
            settle = resolve
            fail = reject
          })
        }
        return options.reply ?? { data: { info: { structured: PAYLOAD } } }
      },
      abort: async (args: unknown) => {
        calls.abort.push(args)
        return { data: true }
      },
      message: async (args: unknown) => {
        calls.message.push(args)
        return { data: {} }
      },
      messages: async (args: unknown) => {
        calls.messages.push(args)
        return { data: [] }
      },
      delete: async (args: unknown) => {
        // PUSHED BEFORE EITHER FAILURE, deliberately: "the session was asked to
        // be deleted" and "the deletion completed" are two facts, and the
        // exactly-one-dispose-per-attempt invariant is a claim about the first.
        // A fake that recorded the call only on success would make a hanging
        // cleanup look like a cleanup that was never attempted.
        calls.delete.push(args)
        if (options.deleteHangs) return new Promise(() => {})
        if (options.deleteThrows) throw options.deleteThrows
        return { data: true }
      },
    },
  }
  return {
    client,
    calls,
    /** Answer a `pendingPrompt` call — the provider finally replying. */
    settlePrompt(value: unknown) {
      if (!settle) throw new Error("fakeV2: settlePrompt before session.prompt was called")
      settle(value)
    },
    /** The abandoned request eventually FAILING, which is not late usage. */
    rejectPrompt(error: unknown) {
      if (!fail) throw new Error("fakeV2: rejectPrompt before session.prompt was called")
      fail(error)
    },
  }
}

/**
 * Story 2.3 — the second parameter became an object.
 *
 * It was a bare `timeoutMs?: number`, and this story adds two more dials the
 * same tests need to set (`cleanupTimeoutMs` for the bounded disposal AC3 names,
 * `lateUsage` for AC2's sink) plus a fake whose prompt the test settles. Three
 * positional numbers, two of them milliseconds, is the shape where a test that
 * bounds the CLEANUP silently bounds the TURN instead and still passes — which
 * on this story's paths is a test that proves nothing.
 */
function backendWith(
  options: FakeV2Options = {},
  tuning: { timeoutMs?: number; cleanupTimeoutMs?: number; lateUsage?: LateUsageReporter } = {},
) {
  const fake = fakeV2(options)
  const backend = new OpencodeModelBackend({
    serverUrl: "http://localhost:4096",
    directory: "/repo",
    slots: SLOTS,
    client: fake.client as never,
    ...(tuning.timeoutMs === undefined ? {} : { timeoutMs: tuning.timeoutMs }),
    ...(tuning.cleanupTimeoutMs === undefined ? {} : { cleanupTimeoutMs: tuning.cleanupTimeoutMs }),
    ...(tuning.lateUsage === undefined ? {} : { lateUsage: tuning.lateUsage }),
  })
  return { backend, calls: fake.calls, settlePrompt: fake.settlePrompt, rejectPrompt: fake.rejectPrompt }
}

/** The write half of AC2's sink, as an adapter is given it. Collects, never reads back. */
function collectingReporter(): LateUsageReporter & { reports: LateUsageReport[] } {
  const reports: LateUsageReport[] = []
  return {
    reports,
    report(report: LateUsageReport) {
      reports.push(report)
    },
  }
}

const HOST_TOKENS = { input: 11, output: 22, reasoning: 33, cache: { read: 44, write: 55 } }
const HOST_TOKENS_MAPPED: TokenUsage = {
  input: 11,
  output: 22,
  reasoning: 33,
  cacheRead: 44,
  cacheWrite: 55,
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
    const result = await backendWith({ hang: true }, { timeoutMs: 25 }).backend.runTurn(
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
    const { backend, calls } = backendWith({ hang: true }, { timeoutMs: 10_000 })
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

/**
 * FR10 / AC1 (story 2.3) — THE FABRICATED ZERO, AT EVERY ONE OF ITS FIVE EXITS.
 *
 * `const tokens = info?.tokens ? mapTokens(info.tokens) : emptyTokenUsage()` was
 * one line and it reached five envelopes: `model-error`, `empty-response`, both
 * `schema-invalid` returns, and the success branch. `emptyTokenUsage()` is a
 * TRUTHY object, so the three stages' `if (envelope.tokens)` guard fired and an
 * all-zero entry landed in the ledger — a turn that billed money recorded as a
 * turn that cost nothing, in the direction that flatters MAD.
 *
 * Every test here asserts ABSENCE and not falsiness (`"tokens" in envelope`,
 * `toBeUndefined()`), because `expect(envelope.tokens).toBeFalsy()` passes on
 * both of the two states this story exists to separate — which is why the old
 * suite could not have caught this and did not.
 */
describe("runTurn — usage the host did not report is UNKNOWN, never zero (AC1)", () => {
  test("a SUCCESSFUL turn with no `tokens` carries `usageUnknown` and NO `tokens` key", async () => {
    const result = await backendWith({
      reply: { data: { info: { structured: PAYLOAD } } },
    }).backend.runTurn("discovery-1", "i", "d", SCHEMA)

    // The turn SETTLED and the answer is good. Unknown usage is not a failure.
    expect(result.ok).toBe(true)
    expect(result.ok && result.value).toEqual(PAYLOAD)
    expect("tokens" in result).toBe(false)
    expect(result.tokens).toBeUndefined()
    expect(result.usageUnknown).toBeDefined()
    expect(result.usageUnknown!.executionId.length).toBeGreaterThan(0)
    expect(result.usageUnknown!.why.trim().length).toBeGreaterThan(0)
    // The reason distinguishes this state from the two abandoned ones: this host
    // ANSWERED and told MAD nothing about the bill.
    expect(result.usageUnknown!.why).toContain("reported no usage")
  })

  test("a MODEL-ERROR envelope with no `tokens` does too", async () => {
    const result = await backendWith({
      reply: { data: { info: { error: { name: "ProviderAuthError" } } } },
    }).backend.runTurn("discovery-1", "i", "d", SCHEMA)

    expect(!result.ok && result.failure).toBe("model-error")
    expect("tokens" in result).toBe(false)
    expect(result.usageUnknown).toBeDefined()
  })

  test("an EMPTY-RESPONSE envelope with no `tokens` does too", async () => {
    const result = await backendWith({
      reply: { data: { info: {} } },
    }).backend.runTurn("discovery-1", "i", "d", SCHEMA)

    expect(!result.ok && result.failure).toBe("empty-response")
    expect("tokens" in result).toBe(false)
    expect(result.usageUnknown).toBeDefined()
  })

  test("a STRING-THAT-IS-NOT-JSON envelope with no `tokens` does too", async () => {
    const result = await backendWith({
      reply: { data: { info: { structured: "I'm afraid I can't do that" } } },
    }).backend.runTurn("discovery-1", "i", "d", SCHEMA)

    expect(!result.ok && result.failure).toBe("schema-invalid")
    expect("tokens" in result).toBe(false)
    expect(result.usageUnknown).toBeDefined()
  })

  test("a SCHEMA-INVALID envelope keeps `raw` for salvage AND drops `tokens` (AD-6a)", async () => {
    const bad = { findings: [{ claim: "fine" }, { claim: 42 }] }
    const result = await backendWith({
      reply: { data: { info: { structured: bad } } },
    }).backend.runTurn("discovery-1", "i", "d", SCHEMA)

    expect(!result.ok && result.failure).toBe("schema-invalid")
    // Both facts on one envelope: discover still salvages the valid items, and
    // the bill is still unknown. Fixing one of these by losing the other is the
    // regression this test is shaped to catch.
    expect(!result.ok && result.raw).toEqual(bad)
    expect("tokens" in result).toBe(false)
    expect(result.usageUnknown).toBeDefined()
  })

  test("a PRESENT `tokens` object is KNOWN usage — no marker, and `?? 0` still applies", async () => {
    // `mapTokens`'s per-field `?? 0` for a present object stays: a host that
    // reported `{ input: 7 }` said the other four were zero, which is a
    // different fact from a host that reported nothing at all. This test is what
    // stops a later reading of AC1 from marking the whole object unknown.
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
    expect(result.usageUnknown).toBeUndefined()
    expect("usageUnknown" in result).toBe(false)
  })

  test("`executionId` is monotonic per instance, one per physical `session.prompt`", async () => {
    // A counter and not `Math.random()`: the id lands in the run record and in
    // the evaluation manifest's unknown-usage identities, and a test that could
    // only assert "it is a string" would not notice a backend that minted ONE id
    // and reused it for every turn — which would make `reconcileLateUsage`
    // credit one turn's late usage to another.
    const { backend } = backendWith({ reply: { data: { info: { structured: PAYLOAD } } } })
    const first = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    const second = await backend.runTurn("discovery-2", "i", "d", SCHEMA)

    expect(first.usageUnknown!.executionId).toBe("exec-1")
    expect(second.usageUnknown!.executionId).toBe("exec-2")
  })

  test("a turn that was never ISSUED consumes no `executionId`", async () => {
    // `stage + slot + attempt` is not a unique id and neither is "how many times
    // was runTurn called": the id names a PHYSICAL request, so a pre-issue
    // cancellation and a session-create failure must not advance the counter, or
    // the identities MAD records would refer to executions that never happened.
    const { backend } = backendWith({ reply: { data: { info: { structured: PAYLOAD } } } })
    const controller = new AbortController()
    controller.abort()
    await backend.runTurn("discovery-1", "i", "d", SCHEMA, controller.signal)

    const issued = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(issued.usageUnknown!.executionId).toBe("exec-1")
  })
})

/**
 * AC1 / AC3 (story 2.3) — THE THREE WAYS A TURN ENDS WITHOUT A NUMBER, kept
 * three facts.
 *
 * A timeout, a user's stop and a turn that was never issued all mean "MAD is not
 * waiting any more", and they make three DIFFERENT claims about money: the first
 * two were billed and cannot be counted, the third provably cost nothing. The
 * failure this describe block guards is the flattening of any of them into the
 * others — which is also why `TurnFailure`'s five members do not move here: a
 * timed-out turn stays a `transport-error` so its AD-6(b) retry classification
 * is exactly what it was, and the typed error is internal to the adapter.
 */
describe("runTurn — abandonment marks usage unknown without moving a failure (AC1, AC3)", () => {
  test("A TIMED-OUT turn keeps `transport-error` AND marks usage unknown", async () => {
    const result = await backendWith({ hang: true }, { timeoutMs: 25 }).backend.runTurn(
      "discovery-1",
      "i",
      "d",
      SCHEMA,
    )

    // UNCHANGED, deliberately — `evaluation-protocol.md:311-327` pins the retry
    // classification and this story moves no classification.
    expect(!result.ok && result.failure).toBe("transport-error")
    expect(!result.ok && result.message).toContain("timed out")
    // ADDED — the request went out, so the provider is billing for it.
    expect(result.usageUnknown).toBeDefined()
    expect(result.usageUnknown!.why).toContain("timed out")
    expect("tokens" in result).toBe(false)
  })

  test("A TURN CANCELLED IN FLIGHT is `cancelled`, marked unknown, and says so", async () => {
    // The pin this REPLACES asserted the pre-issue sentence ("cancelled before
    // this turn was issued") for a turn the adapter had already sent, while the
    // AD-2 header six lines above the call site said in as many words that the
    // SDK call keeps running and its tokens are still billed. The port claimed
    // the turn was free; the adapter documented the opposite about the same turn.
    const { backend, calls } = backendWith({ hang: true }, { timeoutMs: 10_000 })
    const controller = new AbortController()
    const pending = backend.runTurn("discovery-1", "i", "d", SCHEMA, controller.signal)
    controller.abort()
    const result = await pending

    expect(!result.ok && result.failure).toBe("cancelled")
    expect(result.usageUnknown).toBeDefined()
    expect(result.usageUnknown!.why).toContain("in flight")
    expect("tokens" in result).toBe(false)
    expect(!result.ok && result.message).toContain("in flight")
    expect(!result.ok && result.message).not.toContain("before this turn was issued")
    expect(calls.delete).toHaveLength(1)
  })

  test("A PRE-ISSUE cancellation carries NO marker — that turn provably cost nothing", async () => {
    // Marking it unknown would be its own dishonesty: AC4's stop rule reads
    // `ledger.unknownUsage`, so it would halt an evaluation over a turn no
    // provider ever saw.
    const { backend, calls } = backendWith()
    const controller = new AbortController()
    controller.abort()
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA, controller.signal)

    expect(!result.ok && result.failure).toBe("cancelled")
    expect("usageUnknown" in result).toBe(false)
    expect(result.usageUnknown).toBeUndefined()
    expect(calls.create).toHaveLength(0)
    expect(calls.delete).toHaveLength(0)
  })

  test("A FAILED SESSION CREATE carries NO marker — nothing was issued", async () => {
    const { backend, calls } = backendWith({ create: { error: { name: "Unauthorized" } } })
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)

    expect(!result.ok && result.failure).toBe("transport-error")
    expect("usageUnknown" in result).toBe(false)
    expect(calls.prompt).toHaveLength(0)
    // No session id came back, so there is nothing to dispose either.
    expect(calls.delete).toHaveLength(0)
  })

  test("A TRANSPORT THROW FROM THE PROMPT CALL DOES carry a marker — it may have been billed", async () => {
    // CORRECTED AT THE WAVE-4 REVIEW (2026-09-11), and this test is the one that
    // holds the correction down. The path returned a bare `transport-error` on
    // the reasoning that a failed call has "no usage to be unknown about". That
    // is true of a connection refused before a byte went out and FALSE of a
    // socket that hung up while the provider was answering, and the thrown error
    // does not say which — so the bare return picked the flattering reading of a
    // state MAD cannot distinguish, which is the same move as the fabricated
    // zero this whole story exists to delete.
    //
    // `evaluation-protocol.md:332-339` binds "any billed OR POTENTIALLY BILLED
    // execution whose usage is missing", and once `session.prompt` has been
    // invoked the execution is potentially billed.
    //
    // The two tests either side of this one are the contrast that makes the rule
    // legible: a session that could not be CREATED and a schema that could not be
    // CONVERTED both fail before the prompt goes out, and both stay unmarked.
    // "Did we send it?" is the line, not "did it work?".
    const { backend, calls } = backendWith({ throws: new Error("socket hang up") })
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)

    expect(!result.ok && result.failure).toBe("transport-error")
    expect(result.usageUnknown).toBeDefined()
    expect(result.usageUnknown!.executionId).toBe("exec-1")
    // The reason says MAY have been billed, not WAS. A cancellation and a
    // timeout both know the request is running; this one does not know even that,
    // and a reader must be able to tell those two states apart.
    expect(result.usageUnknown!.why).toContain("may have")
    // No tokens invented to sit beside the marker.
    expect("tokens" in result).toBe(false)
    // The prompt DID go out, which is the whole premise, and the session is
    // still disposed exactly once.
    expect(calls.prompt).toHaveLength(1)
    expect(calls.delete).toHaveLength(1)
  })

  test("A SCHEMA-CONVERSION failure carries NO marker, and still disposes once", async () => {
    // `z.toJSONSchema` throws on a type it cannot represent, which happens
    // BEFORE the prompt goes out: the session exists, so it is disposed, and no
    // model was asked for anything, so no bill is unknown.
    const { backend, calls } = backendWith()
    const result = await backend.runTurn("discovery-1", "i", "d", z.bigint())

    expect(!result.ok && result.failure).toBe("schema-invalid")
    expect("usageUnknown" in result).toBe(false)
    expect(calls.prompt).toHaveLength(0)
    expect(calls.delete).toHaveLength(1)
  })
})

/**
 * AC3 (story 2.3) — SESSION CLEANUP IS BOUNDED, AND ITS FAILURE IS EXPOSED
 * RATHER THAN AWAITED SILENTLY.
 *
 * `finally { await this.disposeSession(sessionID) }` is the unbounded await AC3
 * names: a host that never answers `session.delete` held the turn — and through
 * `runWithOneRetry`, the stage, and the run — open forever, and did it on the
 * cancellation path too, so the user's stop was as unresponsive as the hang. It
 * could not be tested before this story either, because the fake's `delete`
 * always resolved and a bounded dispose and an unbounded one both look instant.
 *
 * A cleanup failure NEVER FAILS A REVIEW (`model-backend.ts:190-193`, story 1:
 * "a session we cannot delete is untidy, not a failure of the review"), which is
 * why every test here also asserts the turn's own outcome survived.
 */
describe("runTurn — bounded, exposed session cleanup (AC3)", () => {
  test("a HANGING `session.delete` does not hold the turn open, and is reported", async () => {
    const { backend, calls } = backendWith({ deleteHangs: true }, { cleanupTimeoutMs: 10 })
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)

    // The turn itself is untouched: the model answered and the answer stands.
    expect(result.ok).toBe(true)
    expect(result.ok && result.value).toEqual(PAYLOAD)
    expect(calls.delete).toHaveLength(1)
    expect(result.cleanupUnresolved).toBeDefined()
    expect(result.cleanupUnresolved!.why).toContain("10ms")
  })

  test("a THROWING `session.delete` is reported too, and described rather than dumped", async () => {
    // A host that refuses is not a host that never answers, and the message goes
    // through `describeError` for the reason every message in this file does: an
    // SDK error routinely carries the originating request config, auth headers
    // included, and this string reaches a user-visible warning and the record.
    const leaky = { request: { headers: { authorization: "Bearer sk-secret-token" } } }
    const { backend, calls } = backendWith({ deleteThrows: leaky })
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)

    expect(result.ok).toBe(true)
    expect(calls.delete).toHaveLength(1)
    expect(result.cleanupUnresolved).toBeDefined()
    expect(result.cleanupUnresolved!.why).not.toContain("sk-secret-token")
    expect(result.cleanupUnresolved!.why).not.toContain("authorization")
  })

  test("a CLEAN delete leaves no `cleanupUnresolved` key at all", async () => {
    const result = await backendWith().backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(result.ok).toBe(true)
    expect("cleanupUnresolved" in result).toBe(false)
    expect(result.cleanupUnresolved).toBeUndefined()
  })

  test("CANCELLATION STAYS RESPONSIVE even when the cleanup hangs", async () => {
    // The compound failure AC3 is really about: the user pressed stop, the turn
    // was abandoned, and the session the run opened will not close. Before this
    // story the second of those swallowed the first — `runTurn` awaited a
    // `delete` that never answered, so the stop was invisible until the host
    // came back, which is the definition of unresponsive.
    const { backend, calls } = backendWith(
      { hang: true, deleteHangs: true },
      { timeoutMs: 10_000, cleanupTimeoutMs: 10 },
    )
    const controller = new AbortController()
    const pending = backend.runTurn("discovery-1", "i", "d", SCHEMA, controller.signal)
    controller.abort()
    const result = await pending

    expect(!result.ok && result.failure).toBe("cancelled")
    // BOTH facts ride on the one envelope the port hands back: the bill is
    // unknown AND the session is still on the host.
    expect(result.usageUnknown).toBeDefined()
    expect(result.cleanupUnresolved).toBeDefined()
    expect(calls.delete).toHaveLength(1)
  })

  test("EXACTLY ONE dispose per attempt, whatever the cleanup does", async () => {
    const { backend, calls } = backendWith({ deleteThrows: new Error("gone") })
    await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(calls.create).toHaveLength(2)
    expect(calls.delete).toHaveLength(2)
  })

  test("nothing about the cleanup throws THROUGH the port", async () => {
    // `runTurn` returns failures, it does not raise them, or one bad slot takes
    // down the whole fan-out — and a `delete` that rejects is the easiest way to
    // put a throw on a path whose own outcome was a success.
    const { backend } = backendWith({ deleteThrows: "a bare string, not an Error" })
    await expect(backend.runTurn("discovery-1", "i", "d", SCHEMA)).resolves.toBeDefined()
  })
})

/**
 * AC2 (story 2.3) — LATE USAGE IS RECOVERED, AND NOTHING IS WAITED ON.
 *
 * A provider MAD stopped waiting on keeps working and eventually answers. That
 * prompt promise is still in memory, so a NON-AWAITED continuation on it can
 * hand the usage the provider finally reports to the injected reporter, and the
 * run's assembly drains the sink before it closes the record.
 *
 * Every test here settles the prompt only AFTER `runTurn` has already resolved,
 * which is the whole claim: the critical path awaits none of it. There is no
 * `session.wait`, no event subscription, and nothing extending the run past its
 * stop — and the fake counts calls to the two routes the Dev Notes rejected
 * (`session.abort`, `session.message`) so that stays true by test rather than by
 * memory.
 */
describe("runTurn — late usage, awaited by nothing (AC2)", () => {
  test("usage reported after the deadline reaches the sink, keyed to the same execution", async () => {
    const lateUsage = collectingReporter()
    const { backend, calls, settlePrompt } = backendWith(
      { pendingPrompt: true },
      { timeoutMs: 10, cleanupTimeoutMs: 10, lateUsage },
    )
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)

    expect(!result.ok && result.failure).toBe("transport-error")
    const executionId = result.usageUnknown!.executionId
    // THE ASSERTION AC2 IS ABOUT: the turn is over and nothing has arrived. If
    // this line ever fails, `runTurn` waited for the provider.
    expect(lateUsage.reports).toEqual([])

    settlePrompt({ data: { info: { structured: PAYLOAD, tokens: HOST_TOKENS } } })
    await flush()

    expect(lateUsage.reports).toEqual([{ executionId, tokens: HOST_TOKENS_MAPPED }])
    // Not by reading the session back: `session.delete` permanently removes
    // history, so a read-back would have to defer the disposal AC3 bounds.
    expect(calls.message).toHaveLength(0)
    expect(calls.messages).toHaveLength(0)
    expect(calls.abort).toHaveLength(0)
  })

  test("a turn CANCELLED in flight recovers its usage the same way", async () => {
    const lateUsage = collectingReporter()
    const { backend, settlePrompt } = backendWith(
      { pendingPrompt: true },
      { timeoutMs: 10_000, cleanupTimeoutMs: 10, lateUsage },
    )
    const controller = new AbortController()
    const pending = backend.runTurn("discovery-1", "i", "d", SCHEMA, controller.signal)
    controller.abort()
    const result = await pending

    expect(!result.ok && result.failure).toBe("cancelled")
    settlePrompt({ data: { info: { structured: PAYLOAD, tokens: HOST_TOKENS } } })
    await flush()

    expect(lateUsage.reports).toEqual([
      { executionId: result.usageUnknown!.executionId, tokens: HOST_TOKENS_MAPPED },
    ])
  })

  test("an abandoned request that answers with NO tokens reports NOTHING", async () => {
    // The fabricated zero, one layer out. A continuation that reported
    // `emptyTokenUsage()` here would move the unknown into `entries` with a zero
    // bill, which is the same lie in a new place — and worse, because
    // `reconcileLateUsage` would then say the run's usage is complete.
    const lateUsage = collectingReporter()
    const { backend, settlePrompt } = backendWith(
      { pendingPrompt: true },
      { timeoutMs: 10, cleanupTimeoutMs: 10, lateUsage },
    )
    await backend.runTurn("discovery-1", "i", "d", SCHEMA)

    settlePrompt({ data: { info: { structured: PAYLOAD } } })
    await flush()
    expect(lateUsage.reports).toEqual([])
  })

  test("an abandoned request that eventually FAILS reports nothing and stays silent", async () => {
    // A floating rejection on this path is an unhandled rejection surfacing in a
    // run that has already finished, from code whose entire purpose is to not
    // affect the run. The continuation swallows it deliberately.
    const lateUsage = collectingReporter()
    const { backend, rejectPrompt } = backendWith(
      { pendingPrompt: true },
      { timeoutMs: 10, cleanupTimeoutMs: 10, lateUsage },
    )
    await backend.runTurn("discovery-1", "i", "d", SCHEMA)

    rejectPrompt(new Error("socket hang up, eventually"))
    await flush()
    expect(lateUsage.reports).toEqual([])
  })

  test("NO REPORTER INJECTED changes nothing — an ordinary run is unaffected", async () => {
    // `lateUsage` is optional and an ordinary code review passes none. The
    // abandoned continuation must then not exist at all rather than exist and
    // throw on `undefined.report`.
    const { backend, settlePrompt } = backendWith(
      { pendingPrompt: true },
      { timeoutMs: 10, cleanupTimeoutMs: 10 },
    )
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(!result.ok && result.failure).toBe("transport-error")

    settlePrompt({ data: { info: { structured: PAYLOAD, tokens: HOST_TOKENS } } })
    await expect(flush()).resolves.toBeUndefined()
  })

  test("a turn that SETTLES IN TIME reports no late usage at all", async () => {
    // The continuation exists only for a request the race abandoned. A backend
    // that attached it unconditionally would report every turn's usage twice —
    // once on the envelope and once into the sink — and `reconcileLateUsage`
    // folds a report into `total`, so that would double a real bill.
    const lateUsage = collectingReporter()
    const { backend } = backendWith(
      { reply: { data: { info: { structured: PAYLOAD, tokens: HOST_TOKENS } } } },
      { lateUsage },
    )
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)

    expect(result.ok && result.tokens).toEqual(HOST_TOKENS_MAPPED)
    await flush()
    expect(lateUsage.reports).toEqual([])
  })
})

/**
 * One macrotask, which is all the continuation needs and more than it should
 * take. Awaited only in the tests: it is the LATE half of AC2, so a test has to
 * give the abandoned promise a turn to run — and doing that with a timer rather
 * than a fixed number of microtask hops keeps the assertion about the mechanism
 * instead of about how many `then`s the fake's `async` wrapper inserts.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
