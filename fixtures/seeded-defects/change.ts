/**
 * The seeded-defect change: one realistic diff with eight deliberately planted
 * bugs, and the labelled defect set that says what they are.
 *
 * This is CAP-1's measuring stick. Without it the criterion — "pooled recall
 * exceeds any single participating model's" — is a claim no test can make.
 *
 * ## What makes it honest
 *
 * - **One defect is findable by nobody.** `unchecked-idempotency-key` is planted
 *   and left unfound, so a perfect score is not on offer and a harness bug that
 *   credits everything to everyone shows up as `found === total`.
 * - **Defects overlap between models.** More than one arm finds the SQL
 *   injection and the money-precision bug, so the pool contains the same defect
 *   twice — the pre-clustering state this story creates, and the reason output
 *   says the pool is not merged.
 * - **Every defect carries a `dimension`.** It labels the PLANTED BUG, never a
 *   `Finding`: no `source`, no `lens`, no code from story 2A. Story 2A extends
 *   this set by adding rows.
 * - **The diff is a plausible change**, not a list of tagged bug stubs. A fixture
 *   whose defects are obvious tells you nothing about a real review.
 *
 * ## What CI can and cannot prove with it
 *
 * Real recall needs real models and real credentials. CI therefore asserts the
 * HARNESS over scripted answers standing in for three models with different blind
 * spots (`recall.test.ts`), which makes CAP-1's criterion mechanical and
 * reproducible. Pointing the same fixture at live providers is a manual check,
 * exactly as story 1 recorded for its own live-credential checks.
 */

import type { ChangeSet } from "../../core/ports/repo.ts"
import type { SeededDefect } from "../recall.ts"

const REFUND_TS = `--- /dev/null
+++ b/src/billing/refund.ts
@@ -0,0 +1,54 @@
+import { db } from "../db/client.ts"
+import { gateway } from "./gateway.ts"
+import { appendLedgerEntry } from "./ledger.ts"
+
+export interface RefundRequest {
+  orderId: string
+  amountCents: number
+  reason: string
+  idempotencyKey: string
+}
+
+export interface RefundResult {
+  ok: boolean
+  refundId?: string
+}
+
+export async function refundOrder(req: RefundRequest): Promise<RefundResult> {
+  const conn = await db.acquire()
+
+  const rows = await conn.query(
+    \`select id, amount_cents, currency from charges where order_id = '\${req.orderId}'\`,
+  )
+  const charge = rows[0]
+  if (!charge) return { ok: false }
+
+  await conn.query(
+    "insert into refund_keys (key, order_id) values ($1, $2) on conflict do nothing",
+    [req.idempotencyKey, req.orderId],
+  )
+
+  const refund = await gateway.createRefund({
+    chargeId: charge.id,
+    amount: req.amountCents / 100,
+    reason: req.reason,
+  })
+
+  appendLedgerEntry(conn, {
+    orderId: req.orderId,
+    deltaCents: -req.amountCents,
+    refundId: refund.id,
+  })
+
+  await conn.release()
+  return { ok: true, refundId: refund.id }
+}
+
+export async function refundOrderSafely(req: RefundRequest): Promise<RefundResult> {
+  try {
+    return await refundOrder(req)
+  } catch {
+    // The customer has already been told the refund went through.
+    return { ok: true }
+  }
+}
`

const LEDGER_TS = `--- a/src/billing/ledger.ts
+++ b/src/billing/ledger.ts
@@ -12,6 +12,12 @@ export interface LedgerEntry {
   refundId?: string
 }

-export function appendLedgerEntry(conn: Conn, entry: LedgerEntry): void {
-  balances.set(entry.orderId, (balances.get(entry.orderId) ?? 0) + entry.deltaCents)
+export async function appendLedgerEntry(conn: Conn, entry: LedgerEntry): Promise<void> {
+  const current = balances.get(entry.orderId) ?? 0
+  balances.set(entry.orderId, current + entry.deltaCents)
+  await conn.query("insert into ledger (order_id, delta_cents, refund_id) values ($1, $2, $3)", [
+    entry.orderId,
+    entry.deltaCents,
+    entry.refundId,
+  ])
 }
`

/**
 * The change under review, in the shape the `Repo` port produces — so the
 * fixture reaches `review()` through exactly the seam a real run uses, with no
 * fixture-only code path (AD-1: the core knows no harness, and no fixture).
 */
export const SEEDED_CHANGE: ChangeSet = {
  description: "feat(billing): add order refunds (fixture change, seeded defects)",
  files: ["src/billing/refund.ts", "src/billing/ledger.ts"],
  diff: `${REFUND_TS}${LEDGER_TS}`,
}

/**
 * The planted defects. Line numbers are post-change lines in the files above
 * (spine, Locus): `refund.ts` is added whole, so its lines are 1-based from the
 * top of the hunk; `ledger.ts`'s rewritten function starts at line 15.
 *
 * `markers` are chosen to be distinctive BETWEEN these defects, because that is
 * what stops the default matcher crediting one model's finding to a defect it
 * did not report.
 */
export const SEEDED_DEFECTS: readonly SeededDefect[] = [
  {
    id: "sql-injection",
    dimension: "security",
    locus: { file: "src/billing/refund.ts", startLine: 20, endLine: 22 },
    summary:
      "`req.orderId` is interpolated into the charges query instead of being bound as a " +
      "parameter, so a crafted order id runs arbitrary SQL.",
    markers: ["injection", "interpolat", "parameteri", "concatenat"],
  },
  {
    id: "unchecked-idempotency-key",
    dimension: "correctness",
    locus: { file: "src/billing/refund.ts", startLine: 26, endLine: 29 },
    summary:
      "The idempotency key is WRITTEN and never READ — `on conflict do nothing` swallows the " +
      "duplicate, so a retried webhook issues a second refund for the same order. " +
      "Deliberately findable by nobody in the scripted run: a perfect score is not on offer.",
    markers: ["idempot", "double refund", "duplicate refund", "refunded twice", "replay"],
  },
  {
    id: "unvalidated-refund-amount",
    dimension: "correctness",
    locus: { file: "src/billing/refund.ts", startLine: 31, endLine: 35 },
    summary:
      "`req.amountCents` is never checked against `charge.amount_cents`, so a caller can refund " +
      "more than was charged, or a negative amount.",
    markers: ["exceed", "over-refund", "more than was charged", "negative amount", "unvalidated amount"],
  },
  {
    id: "money-as-float",
    dimension: "data-integrity",
    locus: { file: "src/billing/refund.ts", startLine: 33, endLine: 33 },
    summary:
      "`amountCents / 100` converts money to a binary float and ignores `charge.currency`, so " +
      "amounts round wrong and zero-decimal currencies are refunded at 1/100 of face value.",
    markers: ["/ 100", "floating point", "rounding", "zero-decimal", "currency"],
  },
  {
    id: "missing-await-ledger-write",
    dimension: "concurrency",
    locus: { file: "src/billing/refund.ts", startLine: 37, endLine: 41 },
    summary:
      "`appendLedgerEntry` became async in this same change but its call is not awaited, so the " +
      "connection is released under an in-flight insert and its failure never reaches the caller.",
    markers: ["not awaited", "unawaited", "without await", "fire-and-forget"],
  },
  {
    id: "unreleased-connection",
    dimension: "resource",
    locus: { file: "src/billing/refund.ts", startLine: 18, endLine: 18 },
    summary:
      "The connection is acquired outside any `try`/`finally`, so the early `return { ok: false }` " +
      "and every throw between leak it from the pool.",
    markers: ["leak", "never released", "finally", "pool is exhausted"],
  },
  {
    id: "swallowed-refund-failure",
    dimension: "error-handling",
    locus: { file: "src/billing/refund.ts", startLine: 47, endLine: 53 },
    summary:
      "`refundOrderSafely` catches everything and returns `{ ok: true }`, reporting a refund that " +
      "never happened as a success.",
    markers: ["swallow", "reports success", "ok: true", "empty catch", "silently"],
  },
  {
    id: "ledger-diverges-on-insert-failure",
    dimension: "data-integrity",
    locus: { file: "src/billing/ledger.ts", startLine: 16, endLine: 22 },
    summary:
      "The in-memory balance is mutated BEFORE the insert, with no rollback, so a failed insert " +
      "leaves the process's balance permanently ahead of the table's.",
    markers: ["in-memory", "diverge", "out of sync", "rollback", "before the insert"],
  },
]
