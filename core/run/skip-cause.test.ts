/**
 * CAP-5 — a slot left unasked is attributed only to the refusal the record
 * names. `skippedForBudget` holds slots the run's budget refused AND slots an
 * experiment's admission refused (`core/stages/discover.ts`); the
 * `discovery-truncated` warning's `detail.admission` says which were which.
 */

import { afterEach, describe, expect, test } from "bun:test"

import { selectRoster } from "../roster/select.ts"
import { candidate, fakeAdmission, fakeChange, fakeClock, FakeBackend, settleAudit } from "../test-support/fakes.ts"
import { review } from "./review.ts"

afterEach(() => {
  expect(settleAudit()).toEqual([])
})

const FINDING = {
  findings: [
    {
      claim: "Fee is computed before the rate is validated.",
      reasoning: "If `rate` is NaN the total silently becomes NaN.",
      severity: "high",
      file: "src/pay.ts",
      startLine: 12,
      endLine: 14,
    },
  ],
}

function roster(slots: number) {
  return selectRoster(
    [candidate("anthropic", "claude-sonnet-4-5"), candidate("openai", "gpt-5"), candidate("google", "gemini-2.5-pro")],
    { slots, lenses: [], providerConfigKey: "provider" },
  )
}

async function run(slots: number, extra: Record<string, unknown>, backend = new FakeBackend({})) {
  const resolved = roster(slots)
  return review({
    roster: resolved.roster,
    backend,
    clock: fakeClock(),
    change: fakeChange(),
    priorWarnings: resolved.warnings,
    maxConcurrency: 1,
    ...extra,
  })
}

describe("an unasked slot is attributed to the refusal the record names (CAP-5)", () => {
  test("ADMISSION ONLY, every slot refused: the admission is named, never the budget", async () => {
    const admission = fakeAdmission(() => true)
    const { record, rendered } = await run(2, { admission: admission.admission })
    expect(record.skippedForBudget).toEqual(["discovery-1", "discovery-2"])
    expect(rendered).toContain(
      "  NOTHING WAS EXAMINED — the experiment's admission refused every slot before any model was asked.",
    )
    expect(rendered).toContain(
      "  2 pool slot(s) and 0 lens slot(s) were never asked, because the experiment's admission refused them " +
        "(the discovery-truncated warning says why).",
    )
    expect(rendered).toContain("NEVER ASKED: the experiment's admission refused this slot")
    expect(rendered).toContain("[discover/discovery-truncated] ADMISSION TRUNCATED DISCOVERY: 2 pool slot(s)")
    for (const unsupported of [
      "BUDGET TRUNCATED",
      "the budget ran out",
      "to stay inside the token budget",
      "the budget refused this slot",
      "to stay inside discovery's share",
      "past the",
    ]) {
      expect(rendered).not.toContain(unsupported)
    }
  })

  test("BUDGET ONLY, every slot refused: the budget is named, never the admission", async () => {
    const admission = fakeAdmission()
    const { record, rendered } = await run(2, { admission: admission.admission, tokenCap: 0 })
    expect(record.skippedForBudget).toEqual(["discovery-1", "discovery-2"])
    // The ledger's gate is asked first, so the admission never was.
    expect(admission.asked).toHaveLength(0)
    expect(rendered).toContain("  NOTHING WAS EXAMINED — the budget ran out before any model was asked.")
    expect(rendered).toContain("  2 pool slot(s) and 0 lens slot(s) were never asked, to stay inside the token budget.")
    expect(rendered).toContain("NEVER ASKED: the budget refused this slot")
    expect(rendered).toContain("[discover/discovery-truncated] BUDGET TRUNCATED DISCOVERY: 2 pool slot(s)")
    expect(rendered).not.toContain("admission")
  })

  test("MIXED, one slot refused by each: both causes are named, neither alone", async () => {
    // One slot at a time: the admission refuses discovery-1, discovery-2 is
    // admitted and spends past the cap, and the budget then refuses discovery-3.
    const admission = fakeAdmission((request) => request.slot === "discovery-1")
    const backend = new FakeBackend({ "discovery-2": [{ kind: "ok", value: FINDING }] })
    const { record, rendered } = await run(3, { admission: admission.admission, tokenCap: 10 }, backend)
    expect(record.skippedForBudget).toEqual(["discovery-1", "discovery-3"])
    expect(record.answered).toBe(1)
    expect(rendered).toMatch(/discovery-1: .*NEVER ASKED: the experiment's admission refused this slot/)
    expect(rendered).toMatch(/discovery-3: .*NEVER ASKED: the budget refused this slot/)
    expect(rendered).toContain(
      "2 discovery slot(s) were never asked, to stay inside discovery's share or because the experiment's " +
        "admission refused them",
    )
    expect(rendered).toContain("[discover/discovery-truncated] BUDGET AND ADMISSION TRUNCATED DISCOVERY: 2 pool slot(s)")
    expect(rendered).toContain(
      "2 were never asked: the budget ran out before their turn, or the experiment's admission refused it.",
    )
    // The per-slot causes the pointer below refers to are the rendered ROSTER marks.
    expect(rendered).toContain(
      "  discovery-1: anthropic/claude-sonnet-4-5 — Claude (Anthropic) — NEVER ASKED: the experiment's admission " +
        "refused this slot, so it contributed no coverage",
    )
    expect(rendered).toContain(
      "  discovery-3: google/gemini-2.5-pro — Gemini (Google) — NEVER ASKED: the budget refused this slot, so it " +
        "contributed no coverage",
    )
    expect(rendered).toContain(
      "  2 further slot(s) were never asked at all, to stay inside the token budget or because the experiment's " +
        "admission refused them (each slot's NEVER ASKED mark in the ROSTER says which)",
    )
  })
})
