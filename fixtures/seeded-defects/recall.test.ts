/**
 * CAP-1's success criterion, asserted rather than described.
 *
 * "A run over a change with known seeded bugs produces a pooled finding set
 * whose recall exceeds that of any single participating model's own list."
 *
 * The run is a real `review()` over the real pipeline seam; only the model turns
 * are scripted, standing in for three models with different blind spots (see
 * `change.ts` on what CI can prove). Every arm is scored against the same defect
 * set, so nothing is divided: `found` is directly comparable.
 */

import { describe, expect, test } from "bun:test"

import { selectRoster } from "../../core/roster/select.ts"
import { review } from "../../core/run/review.ts"
import { candidate, fakeClock, FakeBackend, type SlotScript } from "../../core/test-support/fakes.ts"
import {
  missedDefects,
  pooledRecallBeatsBestMember,
  recall,
  recallByAuthor,
} from "../recall.ts"
import { SEEDED_CHANGE, SEEDED_DEFECTS } from "./change.ts"

const REFUND = "src/billing/refund.ts"
const LEDGER = "src/billing/ledger.ts"

/**
 * Three blind-spot profiles. Nobody sees the idempotency defect; the SQL
 * injection and the money-precision defect are each seen by two models, which is
 * what puts the same defect in the pool twice before clustering exists.
 */
const SCRIPTS: Record<string, SlotScript> = {
  // Reads for security and lifecycle; blind to money semantics and to async.
  "discovery-1": [
    {
      kind: "ok",
      value: {
        findings: [
          {
            claim: "The charges lookup interpolates `req.orderId` straight into the SQL text.",
            reasoning:
              "String interpolation into a query means a crafted order id rewrites the statement. " +
              "Bind it as a parameterized value instead.",
            severity: "critical",
            file: REFUND,
            startLine: 20,
            endLine: 22,
          },
          {
            claim: "`db.acquire()` sits outside any try/finally, so one path never gives the connection back.",
            reasoning:
              "When no charge matches, the function returns at line 24 and that connection is " +
              "never released. Under load the pool is exhausted and every refund after it hangs.",
            severity: "high",
            file: REFUND,
            startLine: 18,
            endLine: 18,
          },
          {
            claim: "`refundOrderSafely` swallows every failure and returns `{ ok: true }`.",
            reasoning:
              "An empty catch turns a failed gateway call into an answer the caller passes on to " +
              "the customer as a completed refund.",
            severity: "high",
            file: REFUND,
            startLine: 47,
            endLine: 53,
          },
          {
            // A finding matching no planted defect. A real arm raises some; the
            // harness must not turn one into recall.
            claim: "`RefundResult.refundId` is optional, so the shape of a good answer is ambiguous.",
            reasoning: "Callers cannot tell a completed refund from a no-op without a second field.",
            severity: "low",
            file: REFUND,
            startLine: 12,
            endLine: 15,
          },
        ],
      },
    },
  ],

  // Reads for money semantics; blind to async and to the ledger's second file.
  "discovery-2": [
    {
      kind: "ok",
      value: {
        findings: [
          {
            claim: "The order id is concatenated into the charges query.",
            reasoning:
              "One quote character in the id breaks the statement and a crafted one rewrites it.",
            severity: "critical",
            file: REFUND,
            startLine: 20,
            endLine: 22,
          },
          {
            claim: "The requested refund amount is never compared with the original charge.",
            reasoning:
              "`charge.amount_cents` is read and then discarded, so a caller can refund more than " +
              "was charged, or pass a negative amount and credit a card that was never debited.",
            severity: "critical",
            file: REFUND,
            startLine: 31,
            endLine: 35,
          },
          {
            claim: "`amountCents / 100` hands the gateway a floating point amount.",
            reasoning:
              "Cents divided by 100 is a binary float, so the rounding drifts on ordinary amounts. " +
              "`charge.currency` is ignored as well, and a zero-decimal currency is refunded at a " +
              "hundredth of face value.",
            severity: "high",
            file: REFUND,
            startLine: 33,
            endLine: 33,
          },
        ],
      },
    },
  ],

  // Reads for async and for cross-file state; blind to security and to the
  // amount check.
  "discovery-3": [
    {
      kind: "ok",
      value: {
        findings: [
          {
            claim: "The `appendLedgerEntry` call is not awaited.",
            reasoning:
              "It returns a promise as of this same change, and the call is fire-and-forget, so " +
              "`conn.release()` runs while the insert is still in flight and a rejected insert " +
              "reaches nobody.",
            severity: "high",
            file: REFUND,
            startLine: 37,
            endLine: 41,
          },
          {
            claim: "`appendLedgerEntry` mutates the in-memory balance before the insert.",
            reasoning:
              "The map is updated first and there is no rollback, so a failed insert leaves the " +
              "process's balance out of sync with the table for as long as it runs.",
            severity: "high",
            file: LEDGER,
            startLine: 16,
            endLine: 22,
          },
          {
            claim: "Money is divided by 100 into a float before it reaches the gateway.",
            reasoning:
              "`req.amountCents / 100` cannot represent every amount in binary, and the rounding " +
              "it introduces lands on the customer's statement.",
            severity: "medium",
            file: REFUND,
            startLine: 33,
            endLine: 33,
          },
        ],
      },
    },
  ],
}

/** Three lineages, three slots — the roster AD-4 ranks toward. */
function threeSlotRun() {
  const resolved = selectRoster(
    [
      candidate("anthropic", "claude-sonnet-4-5"),
      candidate("openai", "gpt-5"),
      candidate("google", "gemini-2.5-pro"),
    ],
    { slots: 3, providerConfigKey: "provider" },
  )
  return review({
    roster: resolved.roster,
    backend: new FakeBackend(SCRIPTS),
    clock: fakeClock(),
    change: SEEDED_CHANGE,
    priorWarnings: resolved.warnings,
  })
}

/**
 * Post-change line numbering for every file in a unified diff, so the defect
 * loci can be checked against the fixture's own text rather than trusted.
 */
function postChangeLines(diff: string): Map<string, Map<number, string>> {
  const files = new Map<string, Map<number, string>>()
  let current: Map<number, string> | undefined
  let lineNo = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) continue
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//, "")
      current = files.get(path) ?? new Map<number, string>()
      files.set(path, current)
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      lineNo = Number(hunk[1]) - 1
      continue
    }
    if (!current) continue
    if (line.startsWith("-")) continue
    lineNo += 1
    current.set(lineNo, line.slice(1))
  }
  return files
}

describe("the fixture is self-consistent — loci checked against the diff text", () => {
  // Without this, nothing tied SEEDED_DEFECTS' line numbers to SEEDED_CHANGE.
  // The scripted findings hardcode the same numbers as the defects, so editing
  // the diff and forgetting the loci left the suite green while the fixture
  // rotted for the live-provider check it exists to support.
  const byFile = postChangeLines(SEEDED_CHANGE.diff)

  test("every defect names a file the change actually touches", () => {
    for (const defect of SEEDED_DEFECTS) {
      expect(SEEDED_CHANGE.files).toContain(defect.locus.file)
      expect(byFile.has(defect.locus.file)).toBe(true)
    }
  })

  test("every cited line exists in the post-change file", () => {
    for (const defect of SEEDED_DEFECTS) {
      const lines = byFile.get(defect.locus.file)!
      const start = defect.locus.startLine
      if (start === undefined) continue
      const end = defect.locus.endLine ?? start
      expect(end).toBeGreaterThanOrEqual(start)
      for (let n = start; n <= end; n += 1) {
        expect(lines.has(n)).toBe(true)
      }
      // A locus pointing at nothing but blank lines is drift, not a defect.
      const cited = Array.from({ length: end - start + 1 }, (_, i) => lines.get(start + i) ?? "")
      expect(cited.join("").trim().length).toBeGreaterThan(0)
    }
  })

  test("the loci still land on the statements they were written for", () => {
    // A handful of anchors, so a shifted hunk is caught by content and not only
    // by line count. These are code substrings, not finding markers.
    const anchors: Record<string, string> = {
      "sql-injection": "order_id = '${req.orderId}'",
      "unchecked-idempotency-key": "refund_keys",
      "money-as-float": "req.amountCents / 100",
      "missing-await-ledger-write": "appendLedgerEntry(conn, {",
      "unreleased-connection": "db.acquire()",
      "swallowed-refund-failure": "refundOrderSafely",
      "ledger-diverges-on-insert-failure": "balances.set(",
    }
    for (const [id, anchor] of Object.entries(anchors)) {
      const defect = SEEDED_DEFECTS.find((d) => d.id === id)
      expect(defect, `no seeded defect with id ${id}`).toBeDefined()
      const lines = byFile.get(defect!.locus.file)!
      const start = defect!.locus.startLine!
      const end = defect!.locus.endLine ?? start
      const text = Array.from({ length: end - start + 1 }, (_, i) => lines.get(start + i) ?? "").join("\n")
      expect(text).toContain(anchor)
    }
  })
})

describe("CAP-1 — pooled recall over the seeded-defect change", () => {
  test("the fixture is what it claims: at least 6 defects, all uniquely identified", () => {
    expect(SEEDED_DEFECTS.length).toBeGreaterThanOrEqual(6)
    // Every defect is labelled with a dimension, and it labels the PLANTED BUG.
    // Story 2A extends this by adding rows.
    expect(SEEDED_DEFECTS.every((d) => d.dimension.length > 0)).toBe(true)
    expect(new Set(SEEDED_DEFECTS.map((d) => d.id)).size).toBe(SEEDED_DEFECTS.length)
  })

  test("POOLED RECALL STRICTLY EXCEEDS EVERY SINGLE MEMBER'S — CAP-1", async () => {
    const { record } = await threeSlotRun()
    expect(record.answered).toBe(3)

    // The roster answered in full (asserted above), so every filled slot is a
    // participating arm — passed explicitly so an arm that raised nothing would
    // still appear rather than vanishing from the comparison.
    const answered = record.roster.slots.map((slot) => slot.slot)
    const comparison = pooledRecallBeatsBestMember(SEEDED_DEFECTS, record.findings, undefined, answered)

    expect(comparison.beats).toBe(true)
    expect(comparison.members).toHaveLength(3)
    for (const member of comparison.members) {
      expect(comparison.pooled.found).toBeGreaterThan(member.recall.found)
      // Same defect set for every arm, so the denominator never moves and the
      // comparison needs no division (spine, Dates & numbers).
      expect(member.recall.total).toBe(comparison.pooled.total)
    }

    // DERIVED, not pinned. `change.ts` promises story 2A extends this set by
    // ADDING ROWS; a hardcoded `{found: 7}` and `[3, 3, 3]` would fail on the
    // first added row with a number that says nothing about what regressed. The
    // properties below are what the fixture actually guarantees, and they hold
    // at any size.
    expect(comparison.pooled.total).toBe(SEEDED_DEFECTS.length)
    expect(comparison.pooled.found).toBe(
      SEEDED_DEFECTS.length - missedDefects(SEEDED_DEFECTS, record.findings).length,
    )
    // No arm is silent, and no arm alone reaches the pool — which is the shape
    // that makes the strict inequality above mean "heterogeneity paid", rather
    // than "one model happened to carry the run".
    for (const member of comparison.members) {
      expect(member.recall.found).toBeGreaterThan(0)
      expect(member.recall.found).toBeLessThan(comparison.pooled.found)
    }
    // Every model that answered is represented as an arm, including any that
    // raised nothing — CAP-1's criterion is over every PARTICIPATING model.
    expect(comparison.members).toHaveLength(record.answered)
  })

  test("nobody finds everything — the unfound defect is still counted against the pool", async () => {
    const { record } = await threeSlotRun()
    const pooled = recall(SEEDED_DEFECTS, record.findings)

    expect(pooled.found).toBeLessThan(pooled.total)
    expect(missedDefects(SEEDED_DEFECTS, record.findings).map((d) => d.id)).toEqual([
      "unchecked-idempotency-key",
    ])
  })

  test("per-model recall is derivable from `author` alone", async () => {
    const { record } = await threeSlotRun()

    // Partition on nothing but `author` — the field discovery writes (AD-8) —
    // and the arms fall out of one pooled run rather than needing N runs.
    const authors = [...new Set(record.findings.map((f) => f.author))]
    expect(authors).toEqual(["discovery-1", "discovery-2", "discovery-3"])

    const byHand = authors
      .map((author) => ({
        author,
        recall: recall(
          SEEDED_DEFECTS,
          record.findings.filter((finding) => finding.author === author),
        ),
      }))
      .sort((a, b) => a.author.localeCompare(b.author))

    expect(recallByAuthor(SEEDED_DEFECTS, record.findings)).toEqual(byHand)
  })

  test("a false positive is not recall", async () => {
    const { record } = await threeSlotRun()
    const shapeFinding = record.findings.find((f) => f.claim.includes("RefundResult.refundId"))
    expect(shapeFinding).toBeDefined()
    expect(recall(SEEDED_DEFECTS, [shapeFinding!])).toEqual({
      found: 0,
      total: SEEDED_DEFECTS.length,
    })
  })

  test("an injected matcher replaces the lexical default (AD-14's shape)", async () => {
    const { record } = await threeSlotRun()
    // A matcher that agrees with nothing proves the default is not hard-wired.
    expect(recall(SEEDED_DEFECTS, record.findings, () => false).found).toBe(0)
    expect(pooledRecallBeatsBestMember(SEEDED_DEFECTS, record.findings, () => false).beats).toBe(
      false,
    )
  })

  test("the run this is measured over is a clean, undegraded 3-model run", async () => {
    const { record, rendered } = await threeSlotRun()

    // No drop-out, no reduced denominator, no single-lineage warning: the recall
    // number is not standing on a degraded run (AD-6).
    expect(record.warnings.map((w) => w.code)).toEqual(["provider-fan-out"])
    // AD-6a — one denominator, and it is who answered.
    expect(record.findings.every((f) => f.coDiscovery?.answered === 3)).toBe(true)
    expect(rendered).toContain("co-discovery: 1/3")
    // The pool is a union, and the output says so until clustering lands.
    expect(rendered).toContain("POOL — NOT YET MERGED")
  })
})
