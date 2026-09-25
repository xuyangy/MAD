import { describe, expect, test } from "bun:test"

import { settlementOf } from "./settlement.ts"

describe("settlementOf — story 2-8c3a's `abandoned`", () => {
  test("an abandoned unknown keeps the flag on its settlement", () => {
    expect(
      settlementOf({ ok: false, slot: "s", failure: "cancelled", message: "m", usageUnknown: { executionId: "e", why: "w", abandoned: true } }, false),
    ).toEqual({ kind: "unknown", why: "w", executionId: "e", abandoned: true })
  })

  test("an unknown without it carries no `abandoned` key", () => {
    const settlement = settlementOf({ ok: true, slot: "s", value: 1, usageUnknown: { executionId: "e", why: "w" } }, false)
    expect(settlement).toEqual({ kind: "unknown", why: "w", executionId: "e" })
    expect("abandoned" in settlement).toBe(false)
  })
})

describe("settlementOf — a thrown runTurn is abandoned (story 2-8c3a)", () => {
  const thrown = { ok: false as const, slot: "s", failure: "transport-error" as const, message: "socket closed" }

  test("a throw settles unknown and abandoned: its request may still be held open", () => {
    expect(settlementOf(thrown, true)).toEqual({ kind: "unknown", why: "the backend threw after the request was issued", abandoned: true })
  })

  test("a returned transport-error envelope stays non-abandoned", () => {
    const settlement = settlementOf(thrown, false)
    expect(settlement).toEqual({ kind: "unknown", why: "the backend reported no usage for an issued request" })
    expect("abandoned" in settlement).toBe(false)
    const marked = settlementOf({ ...thrown, usageUnknown: { executionId: "e", why: "the transport failed" } }, false)
    expect("abandoned" in marked).toBe(false)
  })
})
