/**
 * Test doubles for the ports. Test-only, but they live under `core/` because
 * they may only depend on `core/` — the same AD-1 rule the lint enforces.
 */

import type { ZodType } from "zod"

import type { Candidate } from "../domain/roster.ts"
import { emptyTokenUsage, type TokenUsage } from "../domain/run-record.ts"
import type { Clock } from "../ports/clock.ts"
import type {
  BackendCapabilities,
  Envelope,
  ModelBackend,
  TurnFailure,
} from "../ports/model-backend.ts"
import type { ChangeSet } from "../ports/repo.ts"

/** Deterministic clock: fixed time, counted ids. */
export function fakeClock(at = "2026-08-13T00:00:00.000Z"): Clock {
  let n = 0
  return {
    now: () => at,
    id: (prefix) => `${prefix}-${(n += 1)}`,
  }
}

export function tokens(input = 10, output = 20): TokenUsage {
  return { ...emptyTokenUsage(), input, output }
}

export type SlotStep =
  /** A payload that is run through the real schema, so malformed values are exercised. */
  | { kind: "ok"; value: unknown }
  | { kind: "fail"; failure: TurnFailure; message?: string }

export type SlotScript = SlotStep[]

/**
 * A scripted backend. Each slot gets a list of per-attempt outcomes; attempt i
 * uses entry i, and the last entry repeats. `raw` returns a value that is run
 * through the real schema, so schema-invalid responses can be exercised end to
 * end (AD-12).
 */
export class FakeBackend implements ModelBackend {
  readonly calls: { slot: string; attempt: number }[] = []
  private readonly attempts = new Map<string, number>()

  constructor(
    private readonly script: Record<string, SlotScript>,
    private readonly toolcall: Record<string, boolean> = {},
  ) {}

  capabilities(slot: string): BackendCapabilities {
    return { tools: this.toolcall[slot] === true }
  }

  async runTurn<T>(
    slot: string,
    _instructions: string,
    _input: string,
    schema: ZodType<T>,
  ): Promise<Envelope<T>> {
    const attempt = (this.attempts.get(slot) ?? 0) + 1
    this.attempts.set(slot, attempt)
    this.calls.push({ slot, attempt })

    const steps = this.script[slot] ?? []
    const step = steps[Math.min(attempt - 1, steps.length - 1)]
    if (!step) {
      return { ok: false, slot, failure: "empty-response", message: "no script", tokens: tokens() }
    }

    if (step.kind === "fail") {
      return {
        ok: false,
        slot,
        failure: step.failure,
        message: step.message ?? "scripted failure",
        tokens: tokens(),
      }
    }

    const parsed = schema.safeParse(step.value)
    if (!parsed.success) {
      return {
        ok: false,
        slot,
        failure: "schema-invalid",
        message: parsed.error.issues.map((i) => i.message).join("; "),
        tokens: tokens(),
        // Mirrors the real adapter: the unvalidated payload rides along so the
        // stage can salvage the valid items from it.
        raw: step.value,
      }
    }
    return { ok: true, slot, value: parsed.data, tokens: tokens() }
  }
}

export function candidate(providerId: string, modelId: string, toolcall = true): Candidate {
  return { providerId, modelId, toolcall }
}

export function fakeChange(): ChangeSet {
  return {
    description: "working tree (git diff HEAD)",
    files: ["src/pay.ts"],
    diff: "--- a/src/pay.ts\n+++ b/src/pay.ts\n@@ -1 +1 @@\n-const fee = 0\n+const fee = total * rate\n",
  }
}
