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
import type { AdmittedTurn } from "../../core/ports/admission.ts"
import type { TurnFailure } from "../../core/ports/model-backend.ts"
import { emptyLedger } from "../../core/domain/run-record.ts"
import { CODING_DISCOVERY_GENERALIST as DISCOVERY_INSTRUCTIONS } from "../../core/instructions/coding/discovery.ts"
import { selectRoster } from "../../core/roster/select.ts"
import { discover } from "../../core/stages/discover.ts"
import { candidate, fakeClock } from "../../core/test-support/fakes.ts"
import { createOpencodeClient } from "@opencode-ai/sdk"

import { hostSessionFromPluginClient } from "./host-session.ts"
import {
  DEFAULT_STATUS_POLL_MS,
  HOST_RETRY_PAST_DEADLINE,
  OpencodeModelBackend,
  type MeteredUsage,
  type RequestMeterPort,
  type StatusObservation,
} from "./model-backend.ts"

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
  /**
   * When set, the client has `session.status`, and each call's answer is what
   * this returns for it (`index` from 0): a value, a rejecting promise, or one
   * that never settles. Absent, the client has no `status` at all.
   */
  status?: (args: unknown, index: number) => unknown
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
    /** Every `session.status` call, in order. */
    status: unknown[]
  } = {
    create: [],
    prompt: [],
    delete: [],
    abort: [],
    message: [],
    messages: [],
    status: [],
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
      ...(options.status === undefined
        ? {}
        : {
            status: async (args: unknown) => {
              calls.status.push(args)
              return options.status!(args, calls.status.length - 1)
            },
          }),
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
  tuning: {
    timeoutMs?: number
    cleanupTimeoutMs?: number
    lateUsage?: LateUsageReporter
    executionIdPrefix?: string
    statusPollMs?: number
    onStatusRead?: (observation: StatusObservation) => void
  } = {},
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
    ...(tuning.executionIdPrefix === undefined ? {} : { executionIdPrefix: tuning.executionIdPrefix }),
    ...(tuning.statusPollMs === undefined ? {} : { statusPollMs: tuning.statusPollMs }),
    ...(tuning.onStatusRead === undefined ? {} : { onStatusRead: tuning.onStatusRead }),
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

/** The host's all-zero token object, and what it maps to. */
const ZERO_HOST_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const ZERO_MAPPED: TokenUsage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }

const HOST_TOKENS = { input: 11, output: 22, reasoning: 33, cache: { read: 44, write: 55 } }
const HOST_TOKENS_MAPPED: TokenUsage = {
  input: 11,
  output: 22,
  reasoning: 33,
  cacheRead: 44,
  cacheWrite: 55,
}

/**
 * Ledger #93 — a turn that sent its prompt and ended `empty-response` or
 * `schema-invalid` with an all-zero host token object records UNKNOWN usage:
 * opencode zero-initializes that object, so the zeros are not a measurement.
 * The failure kind, message and `raw` are unchanged; only the usage annotation
 * moves. The reason is asserted as a literal here, not imported, so a reworded
 * constant fails this file.
 */
const FAILED_ZERO_WHY =
  "the turn ended without a usable structured payload and the host reported an all-zero token " +
  "object, which is the host's initial value and does not show that no request was billed, so the " +
  "zeros are not a known usage"

const REJECTED_PAYLOAD = { findings: [{ claim: 42 }] }

const FAILED_BRANCHES: {
  name: string
  info: Record<string, unknown>
  failure: Extract<TurnFailure, "empty-response" | "schema-invalid">
  message: string
  raw?: unknown
}[] = [
  { name: "empty-response", info: {}, failure: "empty-response", message: "the model returned no structured payload" },
  {
    name: "malformed JSON string",
    info: { structured: "I'm afraid I can't do that" },
    failure: "schema-invalid",
    message: "structured payload arrived as a string that is not valid JSON",
  },
  {
    name: "schema rejection",
    info: { structured: REJECTED_PAYLOAD },
    failure: "schema-invalid",
    message: "findings.0.claim: Invalid input: expected string, received number",
    raw: REJECTED_PAYLOAD,
  },
]

/** One non-zero field at a time, host-shaped and mapped. */
const NON_ZERO_FIELDS: { field: string; host: unknown; mapped: TokenUsage }[] = [
  { field: "input", host: { ...ZERO_HOST_TOKENS, input: 12 }, mapped: { ...ZERO_MAPPED, input: 12 } },
  { field: "output", host: { ...ZERO_HOST_TOKENS, output: 7 }, mapped: { ...ZERO_MAPPED, output: 7 } },
  { field: "reasoning", host: { ...ZERO_HOST_TOKENS, reasoning: 5 }, mapped: { ...ZERO_MAPPED, reasoning: 5 } },
  { field: "cache read", host: { ...ZERO_HOST_TOKENS, cache: { read: 3, write: 0 } }, mapped: { ...ZERO_MAPPED, cacheRead: 3 } },
  { field: "cache write", host: { ...ZERO_HOST_TOKENS, cache: { read: 0, write: 9 } }, mapped: { ...ZERO_MAPPED, cacheWrite: 9 } },
]

function expectFailureUnchanged(result: Awaited<ReturnType<OpencodeModelBackend["runTurn"]>>, branch: (typeof FAILED_BRANCHES)[number]) {
  expect(!result.ok && result.failure).toBe(branch.failure)
  expect(!result.ok && result.message).toBe(branch.message)
  if (branch.raw === undefined) expect("raw" in result).toBe(false)
  else expect(!result.ok && result.raw).toEqual(branch.raw)
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

  test("a MODEL-ERROR envelope with no `tokens` carries `usageUnknown` and NO `tokens` key", async () => {
    const result = await backendWith({
      reply: { data: { info: { error: { name: "ProviderAuthError" } } } },
    }).backend.runTurn("discovery-1", "i", "d", SCHEMA)

    expect(!result.ok && result.failure).toBe("model-error")
    expect("tokens" in result).toBe(false)
    expect(result.usageUnknown).toBeDefined()
  })

  test("an errored turn with an all-zero `tokens` object is UNKNOWN, not a known zero (2-8c6)", async () => {
    // The live pilot's attempt: the token refresh failed before any request, and
    // the host reported the same zeros as for a turn that made six requests.
    const result = await backendWith({
      reply: {
        data: { info: { error: { name: "UnknownError", data: { message: "Token refresh failed: 401" } }, tokens: ZERO_HOST_TOKENS } },
      },
    }).backend.runTurn("discovery-1", "i", "d", SCHEMA)

    expect(!result.ok && result.failure).toBe("model-error")
    expect(!result.ok && result.message).toBe("UnknownError: Token refresh failed: 401")
    expect("tokens" in result).toBe(false)
    expect(result.usageUnknown?.executionId).toBe("exec-1")
    expect(result.usageUnknown?.why).toContain("all-zero token object")
    expect(result.usageUnknown?.abandoned).toBeUndefined()
  })

  test("an errored turn whose zero object omits fields is UNKNOWN too", async () => {
    const result = await backendWith({
      reply: { data: { info: { error: { name: "APIError", data: { message: "HTTP 500" } }, tokens: {} } } },
    }).backend.runTurn("discovery-1", "i", "d", SCHEMA)

    expect(!result.ok && result.failure).toBe("model-error")
    expect("tokens" in result).toBe(false)
    expect(result.usageUnknown?.why).toContain("all-zero token object")
  })

  test("an errored turn with any NON-ZERO field keeps its tokens (2-8c6)", async () => {
    const result = await backendWith({
      reply: { data: { info: { error: { name: "APIError" }, tokens: { ...ZERO_HOST_TOKENS, input: 12 } } } },
    }).backend.runTurn("discovery-1", "i", "d", SCHEMA)

    expect(!result.ok && result.failure).toBe("model-error")
    expect(result.tokens).toEqual({ input: 12, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    expect("usageUnknown" in result).toBe(false)
  })

  test("an EMPTY-RESPONSE envelope with no `tokens` carries `usageUnknown` and NO `tokens` key", async () => {
    const result = await backendWith({
      reply: { data: { info: {} } },
    }).backend.runTurn("discovery-1", "i", "d", SCHEMA)

    expect(!result.ok && result.failure).toBe("empty-response")
    expect("tokens" in result).toBe(false)
    expect(result.usageUnknown).toBeDefined()
  })

  test("a STRING-THAT-IS-NOT-JSON envelope with no `tokens` carries `usageUnknown` and NO `tokens` key", async () => {
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

  test("two backends with different `executionIdPrefix`es never mint the same id", async () => {
    // One journal binds every id it sees, and a paired run hands it one backend per block and phase.
    const reply = { reply: { data: { info: { structured: PAYLOAD } } } }
    const prefix = backendWith(reply, { executionIdPrefix: "block-1-prefix/" }).backend
    const on = backendWith(reply, { executionIdPrefix: "block-1-on/" }).backend
    const a = await prefix.runTurn("discovery-1", "i", "d", SCHEMA)
    const b = await on.runTurn("discovery-1", "i", "d", SCHEMA)

    expect(a.usageUnknown!.executionId).toBe("block-1-prefix/exec-1")
    expect(b.usageUnknown!.executionId).toBe("block-1-on/exec-1")
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

  test("AN ERROR ANSWER TO THE PROMPT CALL DOES carry a marker — it may have been billed", async () => {
    // CAP-7 — the same line as the throw below: the prompt went out, and an
    // error answer, or an answer with no data, does not say the provider never
    // received and billed it.
    for (const reply of [{ error: { name: "UnknownError", data: { message: "HTTP 500" } } }, {}]) {
      const { backend, calls } = backendWith({ reply })
      const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)

      expect(!result.ok && result.failure).toBe("transport-error")
      expect(result.usageUnknown?.executionId).toBe("exec-1")
      expect(result.usageUnknown?.why).toContain("answered the issued request with an error or without response data")
      expect(result.usageUnknown?.why).toContain("may have")
      expect(result.usageUnknown?.abandoned).toBeUndefined()
      expect("tokens" in result).toBe(false)
      expect(calls.prompt).toHaveLength(1)
    }
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
/**
 * Story 2-8c3a — `abandoned` is data, not wording: it marks a turn that did not
 * end within its bound (a timeout, or a cancellation after the prompt went out),
 * and only that. A turn that ended with no usage, or whose transport threw, is
 * unknown without it.
 */
describe("runTurn — `abandoned` marks only a turn that did not end within its bound (story 2-8c3a)", () => {
  test("the timeout path sets it", async () => {
    const result = await backendWith({ hang: true }, { timeoutMs: 25 }).backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(result.usageUnknown?.abandoned).toBe(true)
  })

  test("the cancel-after-issue path sets it", async () => {
    const { backend } = backendWith({ hang: true }, { timeoutMs: 10_000 })
    const controller = new AbortController()
    const pending = backend.runTurn("discovery-1", "i", "d", SCHEMA, controller.signal)
    controller.abort()
    const result = await pending
    expect(result.usageUnknown?.abandoned).toBe(true)
  })

  test("ordinary missing host usage does not, and neither does a transport throw", async () => {
    const missing = await backendWith({ reply: { data: { info: { structured: PAYLOAD } } } }).backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(missing.usageUnknown).toBeDefined()
    expect("abandoned" in missing.usageUnknown!).toBe(false)
    const thrown = await backendWith({ throws: new Error("socket hang up") }).backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(thrown.usageUnknown).toBeDefined()
    expect("abandoned" in thrown.usageUnknown!).toBe(false)
  })
})

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

  test("an abandoned request that settles with an error and an all-zero token object reports NOTHING (2-8c6)", async () => {
    const lateUsage = collectingReporter()
    const { backend, settlePrompt } = backendWith(
      { pendingPrompt: true },
      { timeoutMs: 10, cleanupTimeoutMs: 10, lateUsage },
    )
    await backend.runTurn("discovery-1", "i", "d", SCHEMA)

    settlePrompt({
      data: {
        info: {
          error: { name: "APIError", data: { message: "Internal Server Error" } },
          tokens: ZERO_HOST_TOKENS,
        },
      },
    })
    await flush()
    expect(lateUsage.reports).toEqual([])
  })

  test("an abandoned request that settles with an error and a NON-ZERO token object still reports (2-8c6)", async () => {
    const lateUsage = collectingReporter()
    const { backend, settlePrompt } = backendWith(
      { pendingPrompt: true },
      { timeoutMs: 10, cleanupTimeoutMs: 10, lateUsage },
    )
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)

    settlePrompt({ data: { info: { error: { name: "APIError" }, tokens: HOST_TOKENS } } })
    await flush()
    expect(lateUsage.reports).toEqual([{ executionId: result.usageUnknown!.executionId, tokens: HOST_TOKENS_MAPPED }])
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

describe("runTurn — a metered turn (story 2-8c2)", () => {
  const HANDLE: AdmittedTurn = { admitStep: async () => ({ ok: false, cause: "budget", reason: "unused" }), settleFirst: async () => {} }
  const MEASURED: TokenUsage = { input: 300, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0 }

  function meteredBackend(options: FakeV2Options, measured: MeteredUsage, tuning: { timeoutMs?: number; lateUsage?: LateUsageReporter } = {}) {
    const fake = fakeV2(options)
    const events: string[] = []
    const opened: { sessionID: string; admitted: AdmittedTurn }[] = []
    const meter: RequestMeterPort = {
      open(sessionID, admitted) {
        events.push(`open ${sessionID} (prompts so far: ${fake.calls.prompt.length})`)
        opened.push({ sessionID, admitted })
        return {
          close: async () => {
            events.push(`close (deletes so far: ${fake.calls.delete.length})`)
            return measured
          },
        }
      },
    }
    const backend = new OpencodeModelBackend({
      serverUrl: "http://localhost:4096",
      directory: "/repo",
      slots: SLOTS,
      client: fake.client as never,
      meter,
      cleanupTimeoutMs: 10,
      ...(tuning.timeoutMs === undefined ? {} : { timeoutMs: tuning.timeoutMs }),
      ...(tuning.lateUsage === undefined ? {} : { lateUsage: tuning.lateUsage }),
    })
    return { backend, events, opened, calls: fake.calls, settlePrompt: fake.settlePrompt }
  }

  test("the session is opened on the meter before the prompt and closed before it is deleted", async () => {
    const { backend, events, opened } = meteredBackend(
      { reply: { data: { info: { structured: PAYLOAD, tokens: HOST_TOKENS } } } },
      { kind: "usage", tokens: MEASURED, physicalRequests: 2 },
    )
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA, undefined, HANDLE)
    expect(events).toEqual(["open ses_test (prompts so far: 0)", "close (deletes so far: 0)"])
    expect(opened[0]!.admitted).toBe(HANDLE)
    // The meter's sum, not the host's settled message.
    expect(result.ok).toBe(true)
    expect(result.tokens).toEqual(MEASURED)
    expect(result.usageUnknown).toBeUndefined()
  })

  test("an unknown physical request makes the turn unknown, whatever the host reported", async () => {
    const { backend } = meteredBackend(
      { reply: { data: { info: { structured: PAYLOAD, tokens: HOST_TOKENS } } } },
      { kind: "unknown", why: "the provider answered HTTP 500", physicalRequests: 1 },
    )
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA, undefined, HANDLE)
    expect(result.tokens).toBeUndefined()
    expect(result.usageUnknown?.why).toContain("the provider answered HTTP 500")
    expect(result.usageUnknown?.executionId).toMatch(/^exec-\d+$/)
  })

  test("a timed-out turn closes its meter session and reports no late usage", async () => {
    const lateUsage = collectingReporter()
    const { backend, events, settlePrompt } = meteredBackend(
      { pendingPrompt: true },
      { kind: "unknown", why: "aborted when the attempt ended", physicalRequests: 1 },
      { timeoutMs: 10, lateUsage },
    )
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA, undefined, HANDLE)
    expect(!result.ok && result.failure).toBe("transport-error")
    expect(events).toContain("close (deletes so far: 0)")
    expect(result.usageUnknown?.why).toContain("aborted when the attempt ended")
    settlePrompt({ data: { info: { structured: PAYLOAD, tokens: HOST_TOKENS } } })
    await flush()
    expect(lateUsage.reports).toEqual([])
  })

  test("a cancelled turn closes its meter session too", async () => {
    const { backend, events } = meteredBackend({ hang: true }, { kind: "unknown", why: "aborted", physicalRequests: 1 })
    const controller = new AbortController()
    const pending = backend.runTurn("discovery-1", "i", "d", SCHEMA, controller.signal, HANDLE)
    controller.abort()
    const result = await pending
    expect(!result.ok && result.failure).toBe("cancelled")
    expect(events).toContain("close (deletes so far: 0)")
    expect(result.usageUnknown).toBeDefined()
  })

  test("an errored zero-token turn takes the meter's figure: 0 physical requests is a known zero (2-8c6)", async () => {
    const errored = {
      reply: {
        data: {
          info: {
            error: { name: "UnknownError", data: { message: "Token refresh failed: 401" } },
            tokens: ZERO_HOST_TOKENS,
          },
        },
      },
    }
    const noRequests = await meteredBackend(errored, { kind: "usage", tokens: ZERO_MAPPED, physicalRequests: 0 }).backend.runTurn(
      "discovery-1", "i", "d", SCHEMA, undefined, HANDLE,
    )
    expect(!noRequests.ok && noRequests.failure).toBe("model-error")
    expect(noRequests.tokens).toEqual(ZERO_MAPPED)
    expect("usageUnknown" in noRequests).toBe(false)

    const measured = await meteredBackend(errored, { kind: "usage", tokens: MEASURED, physicalRequests: 6 }).backend.runTurn(
      "discovery-1", "i", "d", SCHEMA, undefined, HANDLE,
    )
    expect(measured.tokens).toEqual(MEASURED)
    expect("usageUnknown" in measured).toBe(false)
  })

  for (const branch of FAILED_BRANCHES) {
    test(`an all-zero ${branch.name} takes the meter's figure: measured zero, measured usage, measured unknown (ledger #93)`, async () => {
      const failed = { reply: { data: { info: { ...branch.info, tokens: ZERO_HOST_TOKENS } } } }

      const measuredZero = await meteredBackend(failed, { kind: "usage", tokens: ZERO_MAPPED, physicalRequests: 0 }).backend.runTurn(
        "discovery-1", "i", "d", SCHEMA, undefined, HANDLE,
      )
      expectFailureUnchanged(measuredZero, branch)
      expect(measuredZero.tokens).toEqual(ZERO_MAPPED)
      expect("usageUnknown" in measuredZero).toBe(false)

      const measured = await meteredBackend(failed, { kind: "usage", tokens: MEASURED, physicalRequests: 2 }).backend.runTurn(
        "discovery-1", "i", "d", SCHEMA, undefined, HANDLE,
      )
      expectFailureUnchanged(measured, branch)
      expect(measured.tokens).toEqual(MEASURED)
      expect("usageUnknown" in measured).toBe(false)

      const unknown = await meteredBackend(failed, { kind: "unknown", why: "the provider answered HTTP 500", physicalRequests: 1 }).backend.runTurn(
        "discovery-1", "i", "d", SCHEMA, undefined, HANDLE,
      )
      expectFailureUnchanged(unknown, branch)
      expect("tokens" in unknown).toBe(false)
      expect(unknown.usageUnknown).toEqual({
        executionId: "exec-1",
        why: "the relay has no usage figure for a physical request of this attempt: the provider answered HTTP 500",
      })
    })
  }

  test("without a handle nothing is opened, and the host's figure stands", async () => {
    const { backend, opened } = meteredBackend(
      { reply: { data: { info: { structured: PAYLOAD, tokens: HOST_TOKENS } } } },
      { kind: "usage", tokens: MEASURED, physicalRequests: 1 },
    )
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(opened).toHaveLength(0)
    expect(result.tokens).toEqual(HOST_TOKENS_MAPPED)
  })
})

describe("runTurn — a failed turn's all-zero token object is unknown usage (ledger #93)", () => {
  for (const branch of FAILED_BRANCHES) {
    for (const [label, tokens] of [
      ["an all-zero token object", ZERO_HOST_TOKENS],
      ["an empty token object", {}],
    ] as const) {
      test(`${branch.name} with ${label} carries usageUnknown with the fixed reason and no tokens key`, async () => {
        const result = await backendWith({
          reply: { data: { info: { ...branch.info, tokens } } },
        }).backend.runTurn("discovery-1", "i", "d", SCHEMA)

        expectFailureUnchanged(result, branch)
        expect("tokens" in result).toBe(false)
        expect(result.usageUnknown).toEqual({ executionId: "exec-1", why: FAILED_ZERO_WHY })
      })
    }

    for (const { field, host, mapped } of NON_ZERO_FIELDS) {
      test(`${branch.name} with a non-zero ${field} keeps its tokens`, async () => {
        const result = await backendWith({
          reply: { data: { info: { ...branch.info, tokens: host } } },
        }).backend.runTurn("discovery-1", "i", "d", SCHEMA)

        expectFailureUnchanged(result, branch)
        expect(result.tokens).toEqual(mapped)
        expect("usageUnknown" in result).toBe(false)
      })
    }

    test(`${branch.name} with no tokens object keeps the host-reported-no-usage reason`, async () => {
      const result = await backendWith({
        reply: { data: { info: branch.info } },
      }).backend.runTurn("discovery-1", "i", "d", SCHEMA)

      expectFailureUnchanged(result, branch)
      expect("tokens" in result).toBe(false)
      expect(result.usageUnknown?.why).toBe("the turn settled and the host reported no usage for it")
    })
  }

  test("a successful all-zero turn stays a known zero (2-8c6, ledger #93)", async () => {
    const result = await backendWith({
      reply: { data: { info: { structured: PAYLOAD, tokens: ZERO_HOST_TOKENS } } },
    }).backend.runTurn("discovery-1", "i", "d", SCHEMA)

    expect(result.ok).toBe(true)
    expect(result.tokens).toEqual(ZERO_MAPPED)
    expect("usageUnknown" in result).toBe(false)
  })

  test("a schema-conversion failure is unmarked and consumes no execution id", async () => {
    const { backend } = backendWith({ reply: { data: { info: { tokens: ZERO_HOST_TOKENS } } } })
    const unconvertible = await backend.runTurn("discovery-1", "i", "d", z.bigint())
    expect(!unconvertible.ok && unconvertible.failure).toBe("schema-invalid")
    expect("usageUnknown" in unconvertible).toBe(false)
    expect("tokens" in unconvertible).toBe(false)

    const next = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(next.usageUnknown).toEqual({ executionId: "exec-1", why: FAILED_ZERO_WHY })
  })

  test("a model-error with an all-zero token object keeps its own reason", async () => {
    const result = await backendWith({
      reply: { data: { info: { error: { name: "APIError" }, tokens: ZERO_HOST_TOKENS } } },
    }).backend.runTurn("discovery-1", "i", "d", SCHEMA)

    expect(!result.ok && result.failure).toBe("model-error")
    expect(result.usageUnknown?.why).toContain("ended in a host error")
    expect(result.usageUnknown?.why).not.toBe(FAILED_ZERO_WHY)
  })
})

describe("runTurn — late usage of a failed all-zero reply (ledger #93)", () => {
  async function abandoned() {
    const lateUsage = collectingReporter()
    const { backend, settlePrompt } = backendWith(
      { pendingPrompt: true },
      { timeoutMs: 10, cleanupTimeoutMs: 10, lateUsage },
    )
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(!result.ok && result.failure).toBe("transport-error")
    return { lateUsage, settlePrompt, executionId: result.usageUnknown!.executionId }
  }

  for (const branch of FAILED_BRANCHES) {
    test(`a late ${branch.name} with an all-zero token object reports nothing`, async () => {
      const { lateUsage, settlePrompt } = await abandoned()
      settlePrompt({ data: { info: { ...branch.info, tokens: ZERO_HOST_TOKENS } } })
      await flush()
      expect(lateUsage.reports).toEqual([])
    })

    test(`a late ${branch.name} with a non-zero token field still reports`, async () => {
      const { lateUsage, settlePrompt, executionId } = await abandoned()
      settlePrompt({ data: { info: { ...branch.info, tokens: { ...ZERO_HOST_TOKENS, output: 4 } } } })
      await flush()
      expect(lateUsage.reports).toEqual([{ executionId, tokens: { ...ZERO_MAPPED, output: 4 } }])
    })
  }

  test("a late empty-response with an empty token object reports nothing", async () => {
    const { lateUsage, settlePrompt } = await abandoned()
    settlePrompt({ data: { info: { tokens: {} } } })
    await flush()
    expect(lateUsage.reports).toEqual([])
  })

  test("a late all-zero reply with a top-level error and a valid payload reports nothing", async () => {
    // The prompt path settles a top-level `error` as `transport-error`, a failure,
    // whatever `data` holds.
    const { lateUsage, settlePrompt } = await abandoned()
    settlePrompt({ error: { name: "BadRequest" }, data: { info: { structured: PAYLOAD, tokens: ZERO_HOST_TOKENS } } })
    await flush()
    expect(lateUsage.reports).toEqual([])
  })

  test("a late non-zero reply with a top-level error still reports", async () => {
    const { lateUsage, settlePrompt, executionId } = await abandoned()
    settlePrompt({ error: { name: "BadRequest" }, data: { info: { structured: PAYLOAD, tokens: HOST_TOKENS } } })
    await flush()
    expect(lateUsage.reports).toEqual([{ executionId, tokens: HOST_TOKENS_MAPPED }])
  })

  test("a late successful all-zero reply reports a known zero", async () => {
    const { lateUsage, settlePrompt, executionId } = await abandoned()
    settlePrompt({ data: { info: { structured: PAYLOAD, tokens: ZERO_HOST_TOKENS } } })
    await flush()
    expect(lateUsage.reports).toEqual([{ executionId, tokens: ZERO_MAPPED }])
  })

  test("a late successful all-zero reply as a JSON string reports a known zero", async () => {
    const { lateUsage, settlePrompt, executionId } = await abandoned()
    settlePrompt({ data: { info: { structured: JSON.stringify(PAYLOAD), tokens: ZERO_HOST_TOKENS } } })
    await flush()
    expect(lateUsage.reports).toEqual([{ executionId, tokens: ZERO_MAPPED }])
  })
})

/**
 * Ledger #7 — the host reported the turn aborted (the SDK's
 * `MessageAbortedError`). It settles as `host-aborted`, matched on the error's
 * `name` only, and its usage follows the host-error rule.
 */
describe("runTurn — a host-reported abort settles as host-aborted (ledger #7)", () => {
  const ABORTED = { name: "MessageAbortedError", data: { message: "The operation was aborted." } }
  const HOST_ERROR_ZERO_WHY =
    "the turn ended in a host error and the host reported an all-zero token object, which it " +
    "also reports for an errored turn that made requests, so the zeros are not a known usage"

  test("a MessageAbortedError with non-zero tokens is host-aborted, tokens known", async () => {
    const result = await backendWith({
      reply: { data: { info: { error: ABORTED, tokens: { ...ZERO_HOST_TOKENS, input: 12 } } } },
    }).backend.runTurn("discovery-1", "i", "d", SCHEMA)

    expect(!result.ok && result.failure).toBe("host-aborted")
    expect(!result.ok && result.message).toBe("MessageAbortedError: The operation was aborted.")
    expect(result.tokens).toEqual({ ...ZERO_MAPPED, input: 12 })
    expect("usageUnknown" in result).toBe(false)
  })

  for (const [label, tokens] of [
    ["an all-zero token object", ZERO_HOST_TOKENS],
    ["an empty token object", {}],
  ] as const) {
    test(`a MessageAbortedError with ${label} is unknown usage with the host-error reason`, async () => {
      const result = await backendWith({
        reply: { data: { info: { error: ABORTED, tokens } } },
      }).backend.runTurn("discovery-1", "i", "d", SCHEMA)

      expect(!result.ok && result.failure).toBe("host-aborted")
      expect("tokens" in result).toBe(false)
      expect(result.usageUnknown).toEqual({ executionId: "exec-1", why: HOST_ERROR_ZERO_WHY })
    })
  }

  test("a MessageAbortedError with no tokens object keeps the host-reported-no-usage reason", async () => {
    const result = await backendWith({ reply: { data: { info: { error: ABORTED } } } }).backend.runTurn(
      "discovery-1", "i", "d", SCHEMA,
    )
    expect(!result.ok && result.failure).toBe("host-aborted")
    expect("tokens" in result).toBe(false)
    expect(result.usageUnknown?.why).toBe("the turn settled and the host reported no usage for it")
  })

  test("a metered abort takes the meter's figure", async () => {
    const HANDLE: AdmittedTurn = { admitStep: async () => ({ ok: false, cause: "budget", reason: "unused" }), settleFirst: async () => {} }
    const measuredTokens: TokenUsage = { input: 300, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    const run = async (measured: MeteredUsage) => {
      const fake = fakeV2({ reply: { data: { info: { error: ABORTED, tokens: ZERO_HOST_TOKENS } } } })
      const meter: RequestMeterPort = { open: () => ({ close: async () => measured }) }
      const backend = new OpencodeModelBackend({
        serverUrl: "http://localhost:4096",
        directory: "/repo",
        slots: SLOTS,
        client: fake.client as never,
        meter,
        cleanupTimeoutMs: 10,
      })
      return backend.runTurn("discovery-1", "i", "d", SCHEMA, undefined, HANDLE)
    }
    const usage = await run({ kind: "usage", tokens: measuredTokens, physicalRequests: 1 })
    expect(!usage.ok && usage.failure).toBe("host-aborted")
    expect(usage.tokens).toEqual(measuredTokens)
    expect("usageUnknown" in usage).toBe(false)

    const unknown = await run({ kind: "unknown", why: "the provider answered HTTP 500", physicalRequests: 1 })
    expect(!unknown.ok && unknown.failure).toBe("host-aborted")
    expect("tokens" in unknown).toBe(false)
    expect(unknown.usageUnknown?.why).toContain("the provider answered HTTP 500")
  })

  test("the user's stop wins: an abort that settles after the caller's signal fired is cancelled, usage kept", async () => {
    const controller = new AbortController()
    const reply = { data: { info: { error: ABORTED, tokens: { ...ZERO_HOST_TOKENS, input: 12 } } } }
    const fake = fakeV2({ reply })
    // The signal fires once the request is out, and the host's reply is already
    // there: the turn settles as aborted with the caller's signal fired.
    fake.client.session.prompt = ((_args: unknown) => {
      controller.abort()
      return Promise.resolve(reply)
    }) as never
    const backend = new OpencodeModelBackend({
      serverUrl: "http://localhost:4096",
      directory: "/repo",
      slots: SLOTS,
      client: fake.client as never,
    })
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA, controller.signal)
    expect(!result.ok && result.failure).toBe("cancelled")
    expect(!result.ok && result.message).toBe(
      "the run was cancelled while this turn was in flight, and the host reported the turn aborted",
    )
    expect(result.tokens).toEqual({ ...ZERO_MAPPED, input: 12 })
    expect("usageUnknown" in result).toBe(false)
  })

  test("with a signal that has not fired, the abort stays host-aborted", async () => {
    const controller = new AbortController()
    const result = await backendWith({
      reply: { data: { info: { error: ABORTED, tokens: ZERO_HOST_TOKENS } } },
    }).backend.runTurn("discovery-1", "i", "d", SCHEMA, controller.signal)
    expect(!result.ok && result.failure).toBe("host-aborted")
    expect(result.usageUnknown).toEqual({ executionId: "exec-1", why: HOST_ERROR_ZERO_WHY })
  })

  test("look-alikes stay model-error: an APIError mentioning an abort, an AbortError", async () => {
    for (const error of [
      { name: "APIError", data: { message: "request aborted by upstream" } },
      { name: "AbortError", data: { message: "The operation was aborted." } },
      { name: "UnknownError", data: { message: "MessageAbortedError" } },
    ]) {
      const result = await backendWith({
        reply: { data: { info: { error, tokens: HOST_TOKENS } } },
      }).backend.runTurn("discovery-1", "i", "d", SCHEMA)
      expect(!result.ok && result.failure).toBe("model-error")
    }
  })

  test("a late all-zero abort reports nothing; a late non-zero abort reports", async () => {
    for (const [tokens, expected] of [
      [ZERO_HOST_TOKENS, false],
      [{ ...ZERO_HOST_TOKENS, output: 4 }, true],
    ] as const) {
      const lateUsage = collectingReporter()
      const { backend, settlePrompt } = backendWith({ pendingPrompt: true }, { timeoutMs: 10, cleanupTimeoutMs: 10, lateUsage })
      const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
      expect(!result.ok && result.failure).toBe("transport-error")
      settlePrompt({ data: { info: { error: ABORTED, tokens } } })
      await flush()
      expect(lateUsage.reports).toEqual(
        expected ? [{ executionId: result.usageUnknown!.executionId, tokens: { ...ZERO_MAPPED, output: 4 } }] : [],
      )
    }
  })
})

/**
 * Ledger #93, through a consumer — the real backend driving `discover` under an
 * evaluation's stop dial. The unknown the backend now reports lands in
 * `ledger.unknownUsage`, and the accountant refuses the retry; with non-zero
 * tokens the retry is issued as before.
 */
describe("discover over the real backend — an all-zero empty-response stops the retry (ledger #93)", () => {
  async function discoverOnce(tokens: unknown, stopOnUnknownUsage = true) {
    const roster = selectRoster([candidate("anthropic", "claude-sonnet-4-5")], {
      slots: 1,
      lenses: [],
      providerConfigKey: "provider",
    }).roster
    const fake = fakeV2({ reply: { data: { info: { tokens } } } })
    const backend = new OpencodeModelBackend({
      serverUrl: "http://localhost:4096",
      directory: "/repo",
      slots: roster.slots,
      client: fake.client as never,
      cleanupTimeoutMs: 10,
    })
    const ledger = { ...emptyLedger(), stopOnUnknownUsage }
    const discovered = await discover({
      roster,
      backend,
      instructions: DISCOVERY_INSTRUCTIONS,
      input: "diff",
      clock: fakeClock(),
      ledger,
    })
    return { ledger, discovered, prompts: fake.calls.prompt.length }
  }

  test("an all-zero empty-response records one unknown with the fixed reason and refuses the retry", async () => {
    const { ledger, discovered, prompts } = await discoverOnce(ZERO_HOST_TOKENS)

    expect(prompts).toBe(1)
    expect(ledger.unknownUsage).toHaveLength(1)
    expect(ledger.unknownUsage[0]!.why).toBe(FAILED_ZERO_WHY)
    expect(ledger.unknownUsage[0]!.attempt).toBe(1)
    expect(ledger.entries).toEqual([])
    expect(discovered.answered).toBe(0)
  })

  test("control: a non-zero empty-response is counted and the retry is issued", async () => {
    const { ledger, discovered, prompts } = await discoverOnce({ ...ZERO_HOST_TOKENS, input: 12 })

    expect(prompts).toBe(2)
    expect(ledger.unknownUsage).toEqual([])
    expect(ledger.entries).toHaveLength(2)
    expect(discovered.answered).toBe(0)
  })

  test("dial off: the all-zero empty-response's retry is issued and both attempts are unknown", async () => {
    const { ledger, discovered, prompts } = await discoverOnce(ZERO_HOST_TOKENS, false)

    expect(prompts).toBe(2)
    expect(ledger.unknownUsage.map((entry) => entry.attempt)).toEqual([1, 2])
    expect(ledger.unknownUsage.map((entry) => entry.why)).toEqual([FAILED_ZERO_WHY, FAILED_ZERO_WHY])
    expect(ledger.entries).toEqual([])
    expect(discovered.answered).toBe(0)
  })
})

/**
 * Ledger #7, through a consumer — the real backend driving `discover` with a
 * host reply whose error is `MessageAbortedError` and whose tokens are non-zero.
 */
describe("discover over the real backend — a host-reported abort (ledger #7)", () => {
  test("one prompt, a turn-host-aborted warning, no drop-out, not cancelled, tokens counted", async () => {
    const roster = selectRoster([candidate("anthropic", "claude-sonnet-4-5")], {
      slots: 1,
      lenses: [],
      providerConfigKey: "provider",
    }).roster
    const fake = fakeV2({
      reply: {
        data: {
          info: {
            error: { name: "MessageAbortedError", data: { message: "The operation was aborted." } },
            tokens: { ...ZERO_HOST_TOKENS, input: 12 },
          },
        },
      },
    })
    const backend = new OpencodeModelBackend({
      serverUrl: "http://localhost:4096",
      directory: "/repo",
      slots: roster.slots,
      client: fake.client as never,
      cleanupTimeoutMs: 10,
    })
    const ledger = emptyLedger()
    const discovered = await discover({
      roster,
      backend,
      instructions: DISCOVERY_INSTRUCTIONS,
      input: "diff",
      clock: fakeClock(),
      ledger,
    })

    expect(fake.calls.prompt).toHaveLength(1)
    expect(ledger.entries).toHaveLength(1)
    expect(ledger.entries[0]!.tokens).toEqual({ ...ZERO_MAPPED, input: 12 })
    expect(discovered.cancelled).toBe(false)
    expect(discovered.droppedOut).toEqual([])
    const codes = discovered.warnings.map((warning) => warning.code)
    expect(codes).toContain("turn-host-aborted")
    expect(codes).not.toContain("model-dropped-out")
  })
})


/**
 * Where the backend's session client comes from: the one it is given, else one
 * built from `serverUrl`, else nothing, which is a programming error.
 */
describe("the session client", () => {
  test("a backend with neither a client nor a server URL is refused at construction", () => {
    expect(() => new OpencodeModelBackend({ directory: "/repo", slots: SLOTS })).toThrow(
      "OpencodeModelBackend needs a session client or a server URL",
    )
  })

  test("a given client wins over a server URL, which is never contacted", async () => {
    const realFetch = globalThis.fetch
    const contacted: string[] = []
    globalThis.fetch = Object.assign(
      async (input: Request | string | URL) => {
        contacted.push(String(input instanceof Request ? input.url : input))
        throw new Error("this test makes no network request")
      },
      { preconnect: realFetch.preconnect },
    ) as typeof globalThis.fetch
    try {
      const fake = fakeV2()
      const backend = new OpencodeModelBackend({
        serverUrl: "http://127.0.0.1:9",
        directory: "/repo",
        slots: SLOTS,
        client: fake.client as never,
      })
      const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
      expect(result.ok).toBe(true)
      expect(fake.calls.create).toHaveLength(1)
      expect(contacted).toEqual([])
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("without the session policy, a create answering a non-string id is a transport-error, and nothing is prompted or deleted", async () => {
    const { backend, calls } = backendWith({ create: { data: { id: 42 } } })
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(!result.ok && result.failure).toBe("transport-error")
    expect(calls.prompt).toHaveLength(0)
    expect(calls.delete).toHaveLength(0)
  })
})

/**
 * The backend through `hostSessionFromPluginClient` over a real v1 client, the
 * plugin's path. The adapter adds no cancellation, so a stop still returns at
 * once, the session is still disposed, and the held answer still reaches the
 * late-usage sink when it arrives.
 */
describe("runTurn through the host client adapter", () => {
  test("a stop returns before the held prompt settles; cleanup runs, and the usage arrives late", async () => {
    const requests: { method: string; path: string; signal: AbortSignal }[] = []
    let release!: (response: Response) => void
    const held = new Promise<Response>((resolve) => {
      release = resolve
    })
    let promptSeen!: () => void
    const promptStarted = new Promise<void>((resolve) => {
      promptSeen = resolve
    })
    const fetch = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      const path = new URL(request.url).pathname
      requests.push({ method: request.method, path, signal: request.signal })
      if (request.method === "POST" && path === "/session") return Response.json({ id: "ses_v1" })
      if (request.method === "POST" && path === "/session/ses_v1/message") {
        promptSeen()
        return held
      }
      if (request.method === "DELETE" && path === "/session/ses_v1") return Response.json(true)
      return Response.json({ name: "NotFound", data: {} }, { status: 404 })
    }
    const v1 = createOpencodeClient({ baseUrl: "http://localhost:4096", directory: "/repo", fetch: fetch as typeof globalThis.fetch })
    const lateUsage = collectingReporter()
    const backend = new OpencodeModelBackend({
      directory: "/repo",
      slots: SLOTS,
      client: hostSessionFromPluginClient(v1),
      timeoutMs: 10_000,
      cleanupTimeoutMs: 1_000,
      lateUsage,
    })

    const controller = new AbortController()
    const pending = backend.runTurn("discovery-1", "i", "d", SCHEMA, controller.signal)
    await promptStarted
    controller.abort()
    const result = await pending

    expect(!result.ok && result.failure).toBe("cancelled")
    expect(lateUsage.reports).toEqual([])
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /session",
      "POST /session/ses_v1/message",
      "DELETE /session/ses_v1",
    ])
    // The stop is not forwarded to the transport: the prompt request is still open.
    expect(requests[1]!.signal.aborted).toBe(false)

    release(Response.json({ info: { structured: PAYLOAD, tokens: HOST_TOKENS }, parts: [] }))
    await flush()
    expect(lateUsage.reports).toEqual([{ executionId: result.usageUnknown!.executionId, tokens: HOST_TOKENS_MAPPED }])
  })
})

/**
 * A refused request, through the real backend driving `discover`: the backend
 * classifies the host's error (`./refusal.ts`), and the stage does not retry a
 * refused attempt. Each provider below answers by attempt, so one run shows a
 * first-attempt refusal, a refusal on the retry, and an ordinary two-failure
 * drop-out side by side.
 */
describe("discover over the real backend — a refused request is not retried", () => {
  const GITLAB_CREDITS =
    'Failed to get direct access token: 402 Payment Required - {"message":"Token creation failed: not enough GitLab Credits."}'
  const ORDINARY = { name: "UnknownError", data: { message: "upstream hiccup" } }

  /** A host client whose prompt answers come from `script(provider, attempt)`, each with all-zero tokens. */
  function scriptedClient(script: (provider: string, attempt: number) => unknown) {
    const attempts = new Map<string, number>()
    const prompts: string[] = []
    let sessions = 0
    const client = {
      session: {
        create: async () => ({ data: { id: `ses_${++sessions}` } }),
        prompt: async (args: { model: { providerID: string } }) => {
          const provider = args.model.providerID
          const attempt = (attempts.get(provider) ?? 0) + 1
          attempts.set(provider, attempt)
          prompts.push(provider)
          return { data: { info: { error: script(provider, attempt), tokens: ZERO_HOST_TOKENS } } }
        },
        delete: async () => ({ data: true }),
      },
    }
    return { client, prompts }
  }

  async function run(candidates: ReturnType<typeof candidate>[], lenses: string[], script: (provider: string, attempt: number) => unknown) {
    const roster = selectRoster(candidates, { slots: candidates.length, lenses, providerConfigKey: "provider" }).roster
    const host = scriptedClient(script)
    const backend = new OpencodeModelBackend({
      directory: "/repo",
      slots: [...roster.slots, ...roster.lensSlots],
      client: host.client as never,
      cleanupTimeoutMs: 10,
    })
    const ledger = emptyLedger()
    const discovered = await discover({ roster, backend, instructions: DISCOVERY_INSTRUCTIONS, input: "diff", clock: fakeClock(), ledger })
    const dropped = discovered.warnings.filter((w) => w.code === "model-dropped-out")
    return { roster, discovered, ledger, prompts: host.prompts, dropped }
  }

  test("refused on the first attempt, refused on the retry, and an ordinary drop-out, each reported for what it was", async () => {
    const { prompts, dropped, ledger, discovered } = await run(
      [
        candidate("gitlab", "duo-chat-gpt-5-6-terra"),
        candidate("anthropic", "claude-sonnet-4-5"),
        candidate("openrouter", "amazon/nova-pro-v1"),
      ],
      [],
      (provider, attempt) => {
        if (provider === "gitlab") return { name: "UnknownError", data: { message: GITLAB_CREDITS } }
        if (provider === "anthropic") return attempt === 1 ? ORDINARY : { name: "APIError", data: { statusCode: 402, isRetryable: false } }
        return ORDINARY
      },
    )

    expect(prompts.filter((p) => p === "gitlab")).toHaveLength(1)
    expect(prompts.filter((p) => p === "anthropic")).toHaveLength(2)
    expect(prompts.filter((p) => p === "openrouter")).toHaveLength(2)
    expect(discovered.answered).toBe(0)

    const byModel = (model: string) => dropped.find((w) => (w.detail as { model: string }).model.includes(model))!
    const gitlab = byModel("duo-chat")
    expect(gitlab.message).toContain(
      "was refused on its only attempt (a payment refusal for provider `gitlab`, recognised from a known host error " +
        "text, not from a checked account balance), so it was not retried",
    )
    expect(gitlab.detail).toMatchObject({
      attempts: 1,
      refusal: { kind: "payment", basis: "host-signature", scope: "provider" },
      retry: "skipped",
    })

    const anthropic = byModel("claude-sonnet")
    expect(anthropic.message).toContain(
      "failed once, then its retry was refused (a payment refusal for the route `anthropic/claude-sonnet-4-5`, from the host's structured error)",
    )
    expect(anthropic.detail).toMatchObject({ attempts: 2, refusal: { kind: "payment", basis: "structured", scope: "route" }, retry: "refused" })

    const ordinary = byModel("nova")
    expect(ordinary.message).toContain("failed twice")
    expect(ordinary.detail).not.toHaveProperty("refusal")
    expect(ordinary.detail).not.toHaveProperty("retry")

    // Every attempt issued is recorded, each under its own execution.
    expect(ledger.unknownUsage).toHaveLength(5)
    expect(new Set(ledger.unknownUsage.map((entry) => entry.executionId)).size).toBe(5)
    expect(ledger.unknownUsage.filter((entry) => entry.slot === gitlab.detail!.slot).map((entry) => entry.attempt)).toEqual([1])
    expect(ledger.unknownUsage.filter((entry) => entry.slot === anthropic.detail!.slot).map((entry) => entry.attempt)).toEqual([1, 2])
  })

  test("a lens slot's refused request is not retried either", async () => {
    const { prompts, dropped } = await run([candidate("gitlab", "duo-chat-gpt-5-6-terra")], ["security"], () => ({
      name: "UnknownError",
      data: { message: GITLAB_CREDITS },
    }))
    // One pool slot and one lens slot, one attempt each.
    expect(prompts).toEqual(["gitlab", "gitlab"])
    expect(dropped).toHaveLength(2)
    for (const warning of dropped) expect(warning.detail).toMatchObject({ attempts: 1, retry: "skipped" })
  })
})

/**
 * The recovery routes the plugin binds at construction: each `discovery-r<k>`
 * id resolves like any slot, and binding makes no host request.
 */
describe("recovery routes bound at construction", () => {
  test("every reserve id is known to the backend, and building it touches nothing", () => {
    const resolved = selectRoster(
      [
        candidate("anthropic", "claude-sonnet-4-5"),
        candidate("openai", "gpt-5"),
        candidate("openrouter", "x-ai/grok-4"),
        candidate("xai", "grok-4"),
      ],
      { slots: 2, providerConfigKey: "provider", requireToolcall: true },
    )
    expect(resolved.recovery.candidates.map((route) => `${route.slot} ${route.providerId}/${route.modelId}`)).toEqual([
      "discovery-r1 openrouter/x-ai/grok-4",
      "discovery-r2 xai/grok-4",
    ])
    const fake = fakeV2()
    const backend = new OpencodeModelBackend({
      directory: "/repo",
      slots: [...resolved.roster.slots, ...resolved.roster.lensSlots, ...resolved.recovery.candidates],
      client: fake.client as never,
    })
    for (const route of resolved.recovery.candidates) expect(backend.capabilities(route.slot)).toEqual({ tools: true })
    expect(fake.calls.create).toEqual([])
    expect(fake.calls.prompt).toEqual([])
    expect(fake.calls.delete).toEqual([])
  })
})

/**
 * After a retryable provider error, opencode 1.19.5 keeps the session in its
 * own retry loop and answers the prompt only after its retries are spent, so a
 * turn waiting on the prompt alone waits out its deadline. The host reports
 * such a session as `{ type: "retry", attempt, message, next }` on
 * `session.status`, with `next` the epoch ms of its next try.
 */
const FREE_LIMIT = "Free usage limit reached. Free models work in OpenCode"

function retrying(next: number, attempt = 1) {
  return { data: { ses_test: { type: "retry", attempt, message: FREE_LIMIT, next } } }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("runTurn — a session the host is retrying past the turn's deadline", () => {
  test("REPRODUCTION: the turn settles within a poll interval as a timeout would, naming the host's retry", async () => {
    const next = Date.now() + 3_600_000
    const { backend, calls } = backendWith(
      { hang: true, status: () => retrying(next, 2) },
      { timeoutMs: 10_000, statusPollMs: 20, cleanupTimeoutMs: 10 },
    )
    const started = Date.now()
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(2_000)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.failure).toBe("transport-error")
    expect(!result.ok && result.message).toContain(FREE_LIMIT)
    expect(!result.ok && result.message).toContain("attempt 2")
    expect(!result.ok && result.message).toContain(String(next))
    expect(result.usageUnknown).toBeDefined()
    expect(result.usageUnknown!.abandoned).toBe(true)
    expect(result.usageUnknown!.why).toBe(HOST_RETRY_PAST_DEADLINE)
    expect(result.usageUnknown!.why).not.toContain("timed out")
    expect("tokens" in result).toBe(false)
    expect(calls.status[0]).toEqual({ directory: "/repo" })
  })

  test("the host's message is flattened and capped before it reaches the failure", async () => {
    const long = `first line\nsecond\tline\u0000\u007f${"y".repeat(1_000)}`
    const { backend } = backendWith(
      {
        hang: true,
        status: () => ({ data: { ses_test: { type: "retry", attempt: 1, message: long, next: Date.now() + 3_600_000 } } }),
      },
      { timeoutMs: 10_000, statusPollMs: 10, cleanupTimeoutMs: 10 },
    )
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    const message = !result.ok ? result.message : ""
    expect(message).toContain("first line second line  ")
    expect(message).not.toMatch(/[\u0000-\u001f\u007f]/)
    expect(message.endsWith("… [truncated]")).toBe(true)
    const host = message.slice(message.indexOf("first line"), -"… [truncated]".length)
    expect(Array.from(host)).toHaveLength(300)
  })

  test("a short host message is kept whole", async () => {
    const { backend } = backendWith(
      { hang: true, status: () => retrying(Date.now() + 3_600_000) },
      { timeoutMs: 10_000, statusPollMs: 10, cleanupTimeoutMs: 10 },
    )
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(!result.ok && result.message.endsWith(`: ${FREE_LIMIT}`)).toBe(true)
  })

  test("the first read comes at half the deadline when the poll interval is longer", async () => {
    const { backend, calls } = backendWith(
      { hang: true, status: () => retrying(Date.now() + 3_600_000) },
      { timeoutMs: 400, statusPollMs: 60_000, cleanupTimeoutMs: 10 },
    )
    const started = Date.now()
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    const elapsed = Date.now() - started
    expect(calls.status).toHaveLength(1)
    expect(elapsed).toBeGreaterThanOrEqual(150)
    expect(elapsed).toBeLessThan(400)
    expect(!result.ok && result.usageUnknown!.why).toBe(HOST_RETRY_PAST_DEADLINE)
  })

  test("a read that throws synchronously changes nothing, and the next read still counts", async () => {
    const { backend, calls } = backendWith(
      {
        hang: true,
        status: () => retrying(Date.now() + 3_600_000),
      },
      { timeoutMs: 10_000, statusPollMs: 10, cleanupTimeoutMs: 10 },
    )
    const session = (backend as unknown as { client: { session: { status: (args: unknown) => unknown } } }).client.session
    const answer = session.status
    let thrown = 0
    session.status = (args: unknown) => {
      if (thrown < 2) {
        thrown += 1
        throw new Error("synchronous failure")
      }
      return answer(args)
    }
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(thrown).toBe(2)
    expect(calls.status.length).toBeGreaterThan(0)
    expect(!result.ok && result.usageUnknown!.why).toBe(HOST_RETRY_PAST_DEADLINE)
  })

  test("a read that throws synchronously on every tick: the turn times out as before", async () => {
    const { backend } = backendWith({ hang: true, status: () => ({ data: {} }) }, { timeoutMs: 80, statusPollMs: 10, cleanupTimeoutMs: 10 })
    const session = (backend as unknown as { client: { session: { status: unknown } } }).client.session
    let thrown = 0
    session.status = () => {
      thrown += 1
      throw new Error("synchronous failure")
    }
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(thrown).toBeGreaterThan(1)
    expect(!result.ok && result.message).toBe("turn timed out after 80ms")
  })

  for (const attempt of [Number.NaN, -1, 1.5]) {
    test(`a retry whose attempt is ${attempt}: waits for the deadline and times out as before`, async () => {
      const { backend, calls } = backendWith(
        {
          hang: true,
          status: () => ({ data: { ses_test: { type: "retry", attempt, message: FREE_LIMIT, next: Date.now() + 3_600_000 } } }),
        },
        { timeoutMs: 80, statusPollMs: 10, cleanupTimeoutMs: 10 },
      )
      const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
      expect(calls.status.length).toBeGreaterThan(1)
      expect(!result.ok && result.message).toBe("turn timed out after 80ms")
    })
  }

  test("attempt 0 is a valid retry", async () => {
    const { backend } = backendWith(
      { hang: true, status: () => retrying(Date.now() + 3_600_000, 0) },
      { timeoutMs: 10_000, statusPollMs: 10, cleanupTimeoutMs: 10 },
    )
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(!result.ok && result.message).toContain("attempt 0")
  })

  test("the poll interval defaults to 5000 ms", () => {
    expect(DEFAULT_STATUS_POLL_MS).toBe(5_000)
    const { backend } = backendWith()
    expect((backend as unknown as { statusPollMs: number }).statusPollMs).toBe(5_000)
  })

  for (const statusPollMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "10" as unknown as number, 2_147_483_648]) {
    test(`a poll interval of ${String(statusPollMs)} is refused at construction`, () => {
      expect(() => backendWith({}, { statusPollMs })).toThrow(
        "statusPollMs must be a positive number of at most 2147483647",
      )
    })
  }

  test("the longest timer delay is accepted as a poll interval", () => {
    const { backend } = backendWith({}, { statusPollMs: 2_147_483_647 })
    expect((backend as unknown as { statusPollMs: number }).statusPollMs).toBe(2_147_483_647)
  })

  test("no status read is issued after the turn settles early", async () => {
    const { backend, calls } = backendWith(
      { hang: true, status: () => retrying(Date.now() + 3_600_000) },
      { timeoutMs: 2_000, statusPollMs: 10, cleanupTimeoutMs: 10 },
    )
    await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    const reads = calls.status.length
    await pause(60)
    expect(calls.status).toHaveLength(reads)
  })

  test("a retry whose next try is within the deadline is waited out, and a later one past it settles", async () => {
    const { backend, calls } = backendWith(
      {
        hang: true,
        status: (_args, index) => (index < 3 ? retrying(Date.now() + 50, 1) : retrying(Date.now() + 3_600_000, 2)),
      },
      { timeoutMs: 2_000, statusPollMs: 10, cleanupTimeoutMs: 10 },
    )
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(calls.status.length).toBeGreaterThanOrEqual(4)
    expect(!result.ok && result.failure).toBe("transport-error")
    expect(!result.ok && result.message).toContain("attempt 2")
  })

  test("SHORT HOST RETRY: a retry within the deadline, then an answer, succeeds", async () => {
    const { backend, calls, settlePrompt } = backendWith(
      { pendingPrompt: true, status: () => retrying(Date.now() + 100) },
      { timeoutMs: 2_000, statusPollMs: 10, cleanupTimeoutMs: 10 },
    )
    let settled = false
    const pending = backend.runTurn("discovery-1", "i", "d", SCHEMA).then((result) => {
      settled = true
      return result
    })
    await pause(60)
    expect(calls.status.length).toBeGreaterThan(0)
    expect(settled).toBe(false)

    settlePrompt({ data: { info: { structured: PAYLOAD, tokens: HOST_TOKENS } } })
    const result = await pending
    expect(result.ok).toBe(true)
    expect(result.ok && result.value).toEqual(PAYLOAD)
  })

  test("BUSY: the turn still succeeds when the prompt answers", async () => {
    const { backend, calls, settlePrompt } = backendWith(
      { pendingPrompt: true, status: () => ({ data: { ses_test: { type: "busy" } } }) },
      { timeoutMs: 2_000, statusPollMs: 10, cleanupTimeoutMs: 10 },
    )
    const pending = backend.runTurn("discovery-1", "i", "d", SCHEMA)
    await pause(40)
    expect(calls.status.length).toBeGreaterThan(0)
    settlePrompt({ data: { info: { structured: PAYLOAD } } })
    expect((await pending).ok).toBe(true)
  })

  const waited: Array<[string, (args: unknown, index: number) => unknown]> = [
    ["busy", () => ({ data: { ses_test: { type: "busy" } } })],
    ["idle", () => ({ data: { ses_test: { type: "idle" } } })],
    ["absent from the map", () => ({ data: {} })],
    ["only another session retrying", () => ({ data: { ses_other: retrying(Date.now() + 3_600_000).data.ses_test } })],
    ["a read that rejects", () => Promise.reject(new Error("socket gone"))],
    ["an error envelope", () => ({ error: { name: "BadRequestError", data: { message: "no" } } })],
    ["an error envelope beside a retry", () => ({ ...retrying(Date.now() + 3_600_000), error: { name: "BadRequestError" } })],
    ["no data", () => ({})],
    ["a null answer", () => null],
    ["a retry with a string next", () => ({ data: { ses_test: { type: "retry", attempt: 1, message: FREE_LIMIT, next: "later" } } })],
    ["a retry with a non-finite next", () => ({ data: { ses_test: { type: "retry", attempt: 1, message: FREE_LIMIT, next: Infinity } } })],
    ["a retry with no message", () => ({ data: { ses_test: { type: "retry", attempt: 1, next: Date.now() + 3_600_000 } } })],
    ["a retry with no attempt", () => ({ data: { ses_test: { type: "retry", message: FREE_LIMIT, next: Date.now() + 3_600_000 } } })],
  ]
  for (const [name, status] of waited) {
    test(`${name}: waits for the deadline and times out as before`, async () => {
      const { backend, calls } = backendWith({ hang: true, status }, { timeoutMs: 80, statusPollMs: 10, cleanupTimeoutMs: 10 })
      const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
      expect(calls.status.length).toBeGreaterThan(1)
      expect(!result.ok && result.failure).toBe("transport-error")
      expect(!result.ok && result.message).toBe("turn timed out after 80ms")
      expect(result.usageUnknown!.why).toContain("timed out")
    })
  }

  test("reads that never settle: later reads continue, and the turn times out as before", async () => {
    const { backend, calls } = backendWith(
      { hang: true, status: () => new Promise(() => {}) },
      { timeoutMs: 80, statusPollMs: 10, cleanupTimeoutMs: 10 },
    )
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(calls.status.length).toBeGreaterThan(1)
    expect(!result.ok && result.message).toBe("turn timed out after 80ms")
    const reads = calls.status.length
    await pause(40)
    expect(calls.status).toHaveLength(reads)
  })

  test("a read that never settles does not stop a later read from settling the turn early", async () => {
    let late: ((value: unknown) => void) | undefined
    const { backend, calls } = backendWith(
      {
        hang: true,
        status: (_args, index) => {
          if (index === 0) {
            return new Promise((resolve) => {
              late = resolve
            })
          }
          return index < 3 ? { data: {} } : retrying(Date.now() + 3_600_000, 4)
        },
      },
      { timeoutMs: 10_000, statusPollMs: 10, cleanupTimeoutMs: 10 },
    )
    const started = Date.now()
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(calls.status.length).toBeGreaterThanOrEqual(4)
    expect(!result.ok && result.message).toContain("attempt 4")
    // The abandoned first read answering afterwards changes nothing.
    late!(retrying(Date.now() + 3_600_000, 9))
    await flush()
  })

  test("a slow read's answer still counts when no later read has answered", async () => {
    let late: ((value: unknown) => void) | undefined
    const { backend, calls } = backendWith(
      {
        hang: true,
        status: (_args, index) =>
          index === 0
            ? new Promise((resolve) => {
                late = resolve
              })
            : new Promise(() => {}),
      },
      { timeoutMs: 10_000, statusPollMs: 10, cleanupTimeoutMs: 10 },
    )
    const started = Date.now()
    const pending = backend.runTurn("discovery-1", "i", "d", SCHEMA)
    await pause(40)
    expect(calls.status.length).toBeGreaterThan(1)
    late!(retrying(Date.now() + 3_600_000, 9))
    const result = await pending
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(!result.ok && result.message).toContain("attempt 9")
  })

  test("an older read's answer after a later read's answer is ignored", async () => {
    let late: ((value: unknown) => void) | undefined
    const { backend, calls } = backendWith(
      {
        hang: true,
        status: (_args, index) =>
          index === 0
            ? new Promise((resolve) => {
                late = resolve
              })
            : index === 1
              ? { data: {} }
              : new Promise(() => {}),
      },
      { timeoutMs: 150, statusPollMs: 10, cleanupTimeoutMs: 10 },
    )
    const pending = backend.runTurn("discovery-1", "i", "d", SCHEMA)
    await pause(40)
    expect(calls.status.length).toBeGreaterThan(2)
    late!(retrying(Date.now() + 3_600_000, 9))
    const result = await pending
    expect(!result.ok && result.message).toBe("turn timed out after 150ms")
  })

  test("every read slower than the interval: the turn still settles early", async () => {
    const { backend, calls } = backendWith(
      {
        hang: true,
        status: () => new Promise((resolve) => setTimeout(() => resolve(retrying(Date.now() + 3_600_000, 2)), 35)),
      },
      { timeoutMs: 2_000, statusPollMs: 20, cleanupTimeoutMs: 10 },
    )
    const started = Date.now()
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(calls.status.length).toBeGreaterThan(1)
    expect(!result.ok && result.failure).toBe("transport-error")
    expect(!result.ok && result.message).toContain("attempt 2")
  })

  test("NO STATUS ON THE CLIENT: the turn times out exactly as before", async () => {
    const { backend, calls } = backendWith({ hang: true }, { timeoutMs: 50, statusPollMs: 10, cleanupTimeoutMs: 10 })
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(calls.status).toHaveLength(0)
    expect(!result.ok && result.failure).toBe("transport-error")
    expect(!result.ok && result.message).toBe("turn timed out after 50ms")
  })

  test("USER STOP while polling: `cancelled` as before, and no read after it", async () => {
    const { backend, calls } = backendWith(
      { hang: true, status: () => ({ data: { ses_test: { type: "busy" } } }) },
      { timeoutMs: 10_000, statusPollMs: 10, cleanupTimeoutMs: 10 },
    )
    const controller = new AbortController()
    const pending = backend.runTurn("discovery-1", "i", "d", SCHEMA, controller.signal)
    await pause(40)
    controller.abort()
    const result = await pending
    expect(!result.ok && result.failure).toBe("cancelled")
    const reads = calls.status.length
    expect(reads).toBeGreaterThan(0)
    await pause(50)
    expect(calls.status).toHaveLength(reads)
  })

  test("LATE ANSWER after an early settle reaches the late-usage sink, as for a timeout", async () => {
    const lateUsage = collectingReporter()
    const { backend, settlePrompt } = backendWith(
      { pendingPrompt: true, status: () => retrying(Date.now() + 3_600_000) },
      { timeoutMs: 10_000, statusPollMs: 10, cleanupTimeoutMs: 10, lateUsage },
    )
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(!result.ok && result.failure).toBe("transport-error")
    expect(lateUsage.reports).toEqual([])

    settlePrompt({ data: { info: { structured: PAYLOAD, tokens: HOST_TOKENS } } })
    await flush()
    expect(lateUsage.reports).toEqual([{ executionId: result.usageUnknown!.executionId, tokens: HOST_TOKENS_MAPPED }])
  })

  test("through `discover`: one AD-6(b) retry, then a drop-out warning naming the host's retry", async () => {
    const roster = selectRoster([candidate("anthropic", "claude-sonnet-4-5")], {
      slots: 1,
      lenses: [],
      providerConfigKey: "provider",
    }).roster
    const fake = fakeV2({ hang: true, status: () => retrying(Date.now() + 3_600_000) })
    const backend = new OpencodeModelBackend({
      serverUrl: "http://localhost:4096",
      directory: "/repo",
      slots: roster.slots,
      client: fake.client as never,
      timeoutMs: 10_000,
      statusPollMs: 10,
      cleanupTimeoutMs: 10,
    })
    const ledger = emptyLedger()
    const started = Date.now()
    const discovered = await discover({
      roster,
      backend,
      instructions: DISCOVERY_INSTRUCTIONS,
      input: "diff",
      clock: fakeClock(),
      ledger,
    })

    expect(Date.now() - started).toBeLessThan(2_000)
    expect(fake.calls.prompt).toHaveLength(2)
    expect(discovered.answered).toBe(0)
    expect(discovered.cancelled).toBe(false)
    expect(discovered.droppedOut).toHaveLength(1)
    const dropped = discovered.warnings.filter((warning) => warning.code === "model-dropped-out")
    expect(dropped).toHaveLength(1)
    expect(dropped[0]!.message).toContain("failed twice")
    expect(dropped[0]!.message).toContain("transport-error")
    expect(dropped[0]!.message).toContain(FREE_LIMIT)
    expect(ledger.unknownUsage).toHaveLength(2)
    expect(ledger.unknownUsage.map((entry) => entry.why)).toEqual([HOST_RETRY_PAST_DEADLINE, HOST_RETRY_PAST_DEADLINE])
    const unquantified = discovered.warnings.find((warning) => warning.code === "usage-unquantified")
    expect(unquantified).toBeDefined()
    const executions = (unquantified!.detail as { executions: Array<{ why: string }> }).executions
    expect(executions.map((entry) => entry.why)).toEqual([HOST_RETRY_PAST_DEADLINE, HOST_RETRY_PAST_DEADLINE])
  })
})

/**
 * Retro action item 11: every settled `session.status` read for a turn is
 * handed to `onStatusRead` as a bounded observation of that turn's session
 * only, without changing the turn, the reads or their timing.
 */
describe("runTurn — the status observer", () => {
  const observing = () => {
    const seen: StatusObservation[] = []
    return { seen, onStatusRead: (observation: StatusObservation) => void seen.push(observation) }
  }

  test("a retry past the deadline: each read is observed in order, and only the settling read is acted on", async () => {
    const next = Date.now() + 3_600_000
    const { seen, onStatusRead } = observing()
    const { backend } = backendWith(
      { hang: true, status: (_args, index) => (index < 2 ? { data: { ses_test: { type: "busy" } } } : retrying(next, 3)) },
      { timeoutMs: 10_000, statusPollMs: 10, cleanupTimeoutMs: 10, onStatusRead, executionIdPrefix: "run-x" },
    )
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(!result.ok && result.message).toContain("attempt 3")
    expect(seen.map((o) => o.readSeq)).toEqual([1, 2, 3])
    expect(seen.map((o) => o.actedOn)).toEqual([false, false, true])
    expect(seen[0]).toMatchObject({ sessionID: "ses_test", slot: "discovery-1", outcome: "answered", status: { type: "busy" } })
    expect(seen[2]!.status).toEqual({ type: "retry", attempt: 3, next, message: FREE_LIMIT })
    expect(new Set(seen.map((o) => o.executionId)).size).toBe(1)
    expect(seen[0]!.executionId.startsWith("run-x")).toBe(true)
    for (const o of seen) expect(Number.isNaN(Date.parse(o.at))).toBe(false)
  })

  test("a retry inside the deadline, an absent session and another session's retry are answered and not acted on; other sessions are not kept", async () => {
    const { seen, onStatusRead } = observing()
    const { backend } = backendWith(
      {
        hang: true,
        status: (_args, index) =>
          index === 0
            ? retrying(Date.now() + 5)
            : { data: { ses_other: { type: "retry", attempt: 7, message: "someone else's secret", next: Date.now() + 3_600_000 } } },
      },
      { timeoutMs: 80, statusPollMs: 10, cleanupTimeoutMs: 10, onStatusRead },
    )
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(!result.ok && result.message).toBe("turn timed out after 80ms")
    expect(seen[0]).toMatchObject({ outcome: "answered", status: { type: "retry", attempt: 1 }, actedOn: false })
    expect(seen.slice(1).every((o) => o.outcome === "answered" && o.status === null && !o.actedOn)).toBe(true)
    expect(JSON.stringify(seen)).not.toContain("ses_other")
    expect(JSON.stringify(seen)).not.toContain("someone else's secret")
  })

  test("an error envelope, a malformed answer, a rejection and a synchronous throw are failed observations", async () => {
    const { seen, onStatusRead } = observing()
    const answers: unknown[] = [
      { error: { name: "BadRequestError", data: { message: "no" } } },
      { data: null },
      { data: { ses_test: "busy" } },
      "not an object",
    ]
    const { backend } = backendWith(
      { hang: true, status: (_args, index) => (index < answers.length ? answers[index] : Promise.reject(new Error("socket gone"))) },
      { timeoutMs: 80, statusPollMs: 10, cleanupTimeoutMs: 10, onStatusRead },
    )
    await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    const failed = seen.filter((o) => o.outcome === "failed").map((o) => o.problem)
    expect(failed.slice(0, 4)).toEqual([
      "the host answered with an error: BadRequestError: no",
      "the status answer carries no status map",
      "this session's status entry is not an object",
      "the status answer is not an object",
    ])
    expect(failed.slice(4).every((problem) => problem === "socket gone")).toBe(true)
    expect(seen.every((o) => !o.actedOn && o.status === undefined)).toBe(true)

    // A read that throws before returning a promise is observed too.
    const thrown = observing()
    const { backend: throwing } = backendWith({ hang: true, status: () => ({ data: {} }) }, { timeoutMs: 60, statusPollMs: 10, cleanupTimeoutMs: 10, onStatusRead: thrown.onStatusRead })
    const session = (throwing as unknown as { client: { session: { status: unknown } } }).client.session
    session.status = () => {
      throw new Error("status threw synchronously")
    }
    await throwing.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(thrown.seen.length).toBeGreaterThan(0)
    expect(thrown.seen.every((o) => o.outcome === "failed" && o.problem === "status threw synchronously")).toBe(true)
  })

  test("overlapping reads answering out of order are observed in settlement order, and the stale answer is not acted on", async () => {
    const { seen, onStatusRead } = observing()
    let late: ((value: unknown) => void) | undefined
    const { backend, calls } = backendWith(
      {
        hang: true,
        status: (_args, index) =>
          index === 0
            ? new Promise((resolve) => {
                late = resolve
              })
            : index === 1
              ? { data: {} }
              : new Promise(() => {}),
      },
      { timeoutMs: 150, statusPollMs: 10, cleanupTimeoutMs: 10, onStatusRead },
    )
    const pending = backend.runTurn("discovery-1", "i", "d", SCHEMA)
    await pause(40)
    expect(calls.status.length).toBeGreaterThan(2)
    late!(retrying(Date.now() + 3_600_000, 9))
    const result = await pending
    expect(!result.ok && result.message).toBe("turn timed out after 150ms")
    expect(seen.map((o) => o.readSeq)).toEqual([2, 1])
    expect(seen[1]).toMatchObject({ outcome: "answered", status: { type: "retry", attempt: 9 }, actedOn: false })
  })

  test("the host's message and type are flattened and capped", async () => {
    const { seen, onStatusRead } = observing()
    const long = `line one\nline\ttwo ${"x".repeat(400)}`
    const { backend } = backendWith(
      { hang: true, status: () => ({ data: { ses_test: { type: "retry\nX", attempt: 1, message: long, next: Date.now() + 5 } } }) },
      { timeoutMs: 40, statusPollMs: 10, cleanupTimeoutMs: 10, onStatusRead },
    )
    await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    const status = seen[0]!.status!
    expect(status.type).toBe("retry X")
    expect(status.message!.startsWith("line one line two ")).toBe(true)
    expect(status.message!.endsWith("… [truncated]")).toBe(true)
    expect(Array.from(status.message!.replace("… [truncated]", ""))).toHaveLength(300)
  })

  test("nothing is observed after the prompt settles: a read answering later is dropped", async () => {
    const { seen, onStatusRead } = observing()
    let late: ((value: unknown) => void) | undefined
    const { backend, settlePrompt } = backendWith(
      {
        pendingPrompt: true,
        status: () =>
          new Promise((resolve) => {
            late = resolve
          }),
      },
      { timeoutMs: 2_000, statusPollMs: 10, cleanupTimeoutMs: 10, onStatusRead },
    )
    const pending = backend.runTurn("discovery-1", "i", "d", SCHEMA)
    await pause(30)
    settlePrompt({ data: { info: { structured: PAYLOAD } } })
    expect((await pending).ok).toBe(true)
    late!({ data: { ses_test: { type: "busy" } } })
    await pause(20)
    expect(seen).toEqual([])
  })

  test("a throwing observer changes nothing: the turn settles early exactly as without one", async () => {
    const { backend, calls } = backendWith(
      { hang: true, status: () => retrying(Date.now() + 3_600_000, 2) },
      {
        timeoutMs: 10_000,
        statusPollMs: 10,
        cleanupTimeoutMs: 10,
        onStatusRead: () => {
          throw new Error("observer broke")
        },
      },
    )
    const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(!result.ok && result.failure).toBe("transport-error")
    expect(!result.ok && result.message).toContain("attempt 2")
    expect(result.usageUnknown!.why).toBe(HOST_RETRY_PAST_DEADLINE)
    expect(calls.status.length).toBeGreaterThan(0)
  })

  test("arrays where the host answers with objects are failed observations, not answered ones", async () => {
    const { seen, onStatusRead } = observing()
    const answers: unknown[] = [[], { data: [] }, { data: { ses_test: [] } }]
    const { backend } = backendWith(
      { hang: true, status: (_args, index) => answers[index] ?? new Promise(() => {}) },
      { timeoutMs: 80, statusPollMs: 10, cleanupTimeoutMs: 10, onStatusRead },
    )
    await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(seen.map((o) => [o.outcome, o.problem, o.status])).toEqual([
      ["failed", "the status answer is not an object", undefined],
      ["failed", "the status answer carries no status map", undefined],
      ["failed", "this session's status entry is not an object", undefined],
    ])
  })

  test("an observer whose promise rejects changes nothing and leaves no unhandled rejection", async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => void unhandled.push(reason)
    process.on("unhandledRejection", onUnhandled)
    try {
      const { backend } = backendWith(
        { hang: true, status: () => retrying(Date.now() + 3_600_000, 2) },
        {
          timeoutMs: 10_000,
          statusPollMs: 10,
          cleanupTimeoutMs: 10,
          onStatusRead: async () => {
            throw new Error("recorder failed")
          },
        },
      )
      const result = await backend.runTurn("discovery-1", "i", "d", SCHEMA)
      expect(!result.ok && result.message).toContain("attempt 2")
      expect(result.usageUnknown!.why).toBe(HOST_RETRY_PAST_DEADLINE)
      await pause(20)
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  for (const stop of ["the prompt answering", "the deadline", "the user's stop"] as const) {
    for (const late of ["answers", "rejects"] as const) {
      test(`a read still pending at ${stop} that later ${late} is not observed`, async () => {
        const { seen, onStatusRead } = observing()
        const pendingReads: { resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = []
        const status = () => new Promise((resolve, reject) => void pendingReads.push({ resolve, reject }))
        const controller = new AbortController()
        const { backend, settlePrompt } = backendWith(
          stop === "the prompt answering" ? { pendingPrompt: true, status } : { hang: true, status },
          { timeoutMs: stop === "the deadline" ? 60 : 2_000, statusPollMs: 10, cleanupTimeoutMs: 10, onStatusRead },
        )
        const pending = backend.runTurn("discovery-1", "i", "d", SCHEMA, controller.signal)
        await pause(30)
        expect(pendingReads.length).toBeGreaterThan(0)
        if (stop === "the prompt answering") settlePrompt({ data: { info: { structured: PAYLOAD } } })
        if (stop === "the user's stop") controller.abort()
        const result = await pending
        if (stop === "the prompt answering") expect(result.ok).toBe(true)
        if (stop === "the deadline") expect(!result.ok && result.message).toBe("turn timed out after 60ms")
        if (stop === "the user's stop") expect(result.ok).toBe(false)
        for (const read of pendingReads) {
          if (late === "answers") read.resolve(retrying(Date.now() + 3_600_000, 5))
          else read.reject(new Error("late failure"))
        }
        await pause(20)
        expect(seen).toEqual([])
      })
    }
  }

  test("a client without `session.status` gives no observation", async () => {
    const { seen, onStatusRead } = observing()
    const { backend } = backendWith({ hang: true }, { timeoutMs: 40, statusPollMs: 10, cleanupTimeoutMs: 10, onStatusRead })
    await backend.runTurn("discovery-1", "i", "d", SCHEMA)
    expect(seen).toEqual([])
  })
})
