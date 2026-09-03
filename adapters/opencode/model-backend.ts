/**
 * AD-2 / AD-12 — `ModelBackend` over opencode.
 *
 * THE V1/V2 TRAP (story 1 design notes): `PluginInput.client` is the v1 SDK
 * client and silently lacks a `format` parameter. Structured output — which
 * AD-12 requires, since hand-parsing JSON out of prose is exactly what it
 * forbids — needs a separately constructed v2 client, whose `session.prompt`
 * accepts `format: { type: "json_schema", schema }` and returns the parsed
 * result on `AssistantMessage.structured` (`structured`, NOT
 * `structured_output`; the docs are wrong).
 *
 * Provider and model errors are RETURNED on `AssistantMessage.error`, not
 * thrown, and transport errors are returned too. Both become domain outcomes on
 * the envelope (spine, Errors), never exceptions.
 */

import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { z, type ZodType } from "zod"

import type { RosterSlot } from "../../core/domain/roster.ts"
import { emptyTokenUsage, type TokenUsage } from "../../core/domain/run-record.ts"
import {
  cancelledTurn,
  type BackendCapabilities,
  type Envelope,
  type ModelBackend,
} from "../../core/ports/model-backend.ts"

type V2Client = ReturnType<typeof createOpencodeClient>

/**
 * The parts of `AssistantMessage` this adapter reads. `structured` is where the
 * parsed `format` result lands — `structured`, not `structured_output`.
 */
interface AssistantMessageLike {
  error?: unknown
  structured?: unknown
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
}

export interface OpencodeBackendOptions {
  /** The opencode server URL from `PluginInput.serverUrl`. */
  serverUrl: URL | string
  /** The project directory from `PluginInput.directory`. */
  directory: string
  /** The resolved roster — maps a MAD slot id to a concrete host model. */
  slots: readonly RosterSlot[]
  /**
   * Host tools this turn may use, as opencode's per-call allowlist. A spawned
   * session gets host tools by default; passing `{}` leaves that default alone.
   * (AD-13's real mechanism — see the note on `capabilities` below.)
   */
  tools?: Record<string, boolean>
  /** Injected in tests. Defaults to a real v2 client against `serverUrl`. */
  client?: V2Client
  /**
   * How long one turn may hang before it becomes a `transport-error` drop-out.
   * `discover` documents timeout as a drop-out cause (AD-6b); without a deadline
   * that case could never fire and a hung provider stalled the whole fan-out.
   */
  timeoutMs?: number
}

/** Ten minutes: long enough for a slow frontier model on a large diff. */
const DEFAULT_TURN_TIMEOUT_MS = 600_000

function mapTokens(tokens: {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}): TokenUsage {
  // AD-15 — budget in these integers, never in `cost`, whose unit the SDK does
  // not document.
  return {
    input: tokens.input ?? 0,
    output: tokens.output ?? 0,
    reasoning: tokens.reasoning ?? 0,
    cacheRead: tokens.cache?.read ?? 0,
    cacheWrite: tokens.cache?.write ?? 0,
  }
}

function describeError(error: unknown): string {
  if (!error) return "unknown error"
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  const record = error as { name?: string; data?: { message?: string } }
  if (record.name || record.data?.message) {
    return `${record.name ?? "error"}: ${record.data?.message ?? ""}`.trim()
  }
  // Deliberately NOT `JSON.stringify(error)`: SDK error objects routinely carry
  // the originating request config, including auth headers, and this string
  // flows into user-visible warnings and the run record. Describe the shape,
  // never dump it.
  const name = (error as { constructor?: { name?: string } })?.constructor?.name
  return name && name !== "Object" ? `${name} (no message)` : "unrecognized error (no message)"
}

/**
 * Thrown when the USER's signal fires while a turn is in flight, so the catch
 * below can tell it apart from a timeout and from a transport failure.
 *
 * The three all mean "stop waiting" and they are three different facts about the
 * run: a timeout is a drop-out and earns AD-6(b)'s retry, a transport failure is
 * a drop-out too, and a cancellation is neither. One `Error` for all three would
 * make the user's stop indistinguishable from a provider that hung — which is
 * the one confusion AD-2's amendment exists to prevent.
 */
class TurnCancelledError extends Error {
  constructor() {
    super("the run was cancelled while this turn was in flight")
    this.name = "TurnCancelledError"
  }
}

/**
 * A provider that never answers must not stall the whole fan-out. The port is
 * request/response (AD-2), so a hung call has no other way to become the
 * timeout drop-out that `discover` already documents (AD-6b).
 *
 * STORY 7A — the user's stop races here too, and it composes with the deadline
 * rather than replacing it. Both are "stop waiting"; they reject with different
 * errors so the caller can report different facts. The abort listener is removed
 * in the same `finally` the timer is cleared in, for the same reason: a listener
 * left on a long-lived `AbortSignal` is a leak that grows with the number of
 * turns, and discovery issues twenty of them.
 *
 * NOTE WHAT THIS DOES NOT DO: it does not abort the underlying request. The SDK
 * call keeps running until the provider answers, and its tokens are still billed
 * — MAD simply stops waiting for it. That is exactly the guarantee AD-2's
 * amendment settles for ("a backend that cannot abort a request in flight still
 * satisfies the port"), and it is why the core's own refusal to ISSUE the next
 * turn is what actually stops the spending.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    const races: Promise<T>[] = [
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`turn timed out after ${ms}ms`)), ms)
      }),
    ]
    if (signal) {
      races.push(
        new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new TurnCancelledError())
            return
          }
          onAbort = () => reject(new TurnCancelledError())
          signal.addEventListener("abort", onAbort, { once: true })
        }),
      )
    }
    return await Promise.race(races)
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener("abort", onAbort)
  }
}

export class OpencodeModelBackend implements ModelBackend {
  private readonly client: V2Client
  private readonly directory: string
  private readonly bySlot: Map<string, RosterSlot>
  private readonly tools: Record<string, boolean> | undefined
  private readonly timeoutMs: number

  constructor(options: OpencodeBackendOptions) {
    this.client =
      options.client ??
      createOpencodeClient({
        baseUrl: options.serverUrl.toString(),
        directory: options.directory,
      })
    this.directory = options.directory
    this.bySlot = new Map(options.slots.map((slot) => [slot.slot, slot]))
    this.tools = options.tools
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
  }

  /**
   * Best-effort cleanup. A session we cannot delete is untidy, not a failure of
   * the review, so this never surfaces an error to the caller.
   */
  private async disposeSession(sessionID: string): Promise<void> {
    try {
      const deletable = this.client.session as { delete?: (args: unknown) => Promise<unknown> }
      await deletable.delete?.({ sessionID, directory: this.directory })
    } catch {
      // ignored on purpose
    }
  }

  /**
   * AD-2 — the core reads this declaration rather than assuming.
   *
   * AD-13 AMENDMENT FLAGGED: AD-13 assumed MAD declares a backend's tool
   * capability. opencode reports it PER MODEL (`Model.capabilities.toolcall`),
   * and a spawned session gets host tools by default, gated per call by
   * `session.prompt`'s `tools` allowlist. This implements the real mechanism;
   * AD-13 should be amended to "per slot" rather than "per backend".
   */
  capabilities(slot: string): BackendCapabilities {
    return { tools: this.bySlot.get(slot)?.toolcall === true }
  }

  async runTurn<T>(
    slot: string,
    instructions: string,
    input: string,
    schema: ZodType<T>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    const rosterSlot = this.bySlot.get(slot)
    if (!rosterSlot) {
      // Programmer error: a slot the roster never filled (spine, Errors).
      throw new Error(`OpencodeModelBackend: unknown slot \`${slot}\``)
    }

    // AD-2 amended / AD-6f — CHECKED BEFORE THE SESSION IS CREATED, not only
    // before the prompt. Creating a session is a round trip to the host for a
    // turn that will not run, and every one of them has to be disposed
    // afterwards. The core already refuses to issue a cancelled turn; this is
    // the second line of that defence, for the window between the core's check
    // and this call.
    if (signal?.aborted) return cancelledTurn<T>(slot)

    let sessionID: string
    try {
      const created = await this.client.session.create({
        directory: this.directory,
        title: `MAD ${slot}`,
      })
      if (created.error || !created.data?.id) {
        return {
          ok: false,
          slot,
          failure: "transport-error",
          message: `could not create a session: ${describeError(created.error)}`,
        }
      }
      sessionID = created.data.id
    } catch (error) {
      return { ok: false, slot, failure: "transport-error", message: describeError(error) }
    }

    // A schema zod cannot render as JSON Schema is a programmer error, but it
    // must not throw THROUGH the port — `runTurn` returns failures, it does not
    // raise them, or one bad slot takes down the whole fan-out.
    let jsonSchema: Record<string, unknown>
    try {
      jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>
    } catch (error) {
      await this.disposeSession(sessionID)
      return {
        ok: false,
        slot,
        failure: "schema-invalid",
        message: `could not convert the schema to JSON Schema: ${describeError(error)}`,
      }
    }

    // The generated RequestResult is a union whose success branch has no
    // `error` member; this is the shape both branches actually satisfy.
    let result: { data?: { info?: AssistantMessageLike }; error?: unknown }
    try {
      result = await withTimeout(
        this.client.session.prompt({
          sessionID,
          directory: this.directory,
          model: { providerID: rosterSlot.providerId, modelID: rosterSlot.modelId },
          system: instructions,
          // AD-12 — structured output; this is the whole reason for the v2 client.
          format: { type: "json_schema", schema: jsonSchema },
          ...(this.tools ? { tools: this.tools } : {}),
          parts: [{ type: "text", text: input }],
        }),
        this.timeoutMs,
        signal,
      )
    } catch (error) {
      // AD-2 amended — THE USER'S STOP IS NOT A TRANSPORT FAILURE. Reporting it
      // as one would hand the stage a drop-out envelope, which earns AD-6(b)'s
      // retry and puts a working provider's name in a degradation warning.
      if (error instanceof TurnCancelledError) return cancelledTurn<T>(slot)
      // Only thrown for genuine transport failures; provider errors are returned.
      return { ok: false, slot, failure: "transport-error", message: describeError(error) }
    } finally {
      // One session is created per attempt, so a retry orphans two. Nothing
      // downstream reads the session, so it is disposed as soon as the turn ends.
      await this.disposeSession(sessionID)
    }

    if (result.error || !result.data) {
      return {
        ok: false,
        slot,
        failure: "transport-error",
        message: describeError(result.error),
      }
    }

    const info = result.data.info
    const tokens = info?.tokens ? mapTokens(info.tokens) : emptyTokenUsage()

    if (info?.error) {
      // Returned, not thrown — a domain outcome the caller retries once (AD-6b).
      return { ok: false, slot, failure: "model-error", message: describeError(info.error), tokens }
    }

    if (info?.structured === undefined || info.structured === null) {
      return {
        ok: false,
        slot,
        failure: "empty-response",
        message: "the model returned no structured payload",
        tokens,
      }
    }

    // Hosts have been observed handing `structured` back as a JSON string rather
    // than a parsed object. Treating that as schema-invalid would drop every
    // model in the run for a transport detail.
    let payload: unknown = info.structured
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload)
      } catch {
        return {
          ok: false,
          slot,
          failure: "schema-invalid",
          message: "structured payload arrived as a string that is not valid JSON",
          tokens,
        }
      }
    }

    // AD-12 — the envelope is validated. AD-11 — the prose inside it is not.
    const parsed = schema.safeParse(payload)
    if (!parsed.success) {
      return {
        ok: false,
        slot,
        failure: "schema-invalid",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        tokens,
        // Handed back unvalidated so `discover` can salvage the items that ARE
        // valid instead of losing the model — and the denominator — over one
        // malformed field (AD-6a). The stage re-validates every item it keeps.
        raw: payload,
      }
    }

    return { ok: true, slot, value: parsed.data, tokens }
  }
}
