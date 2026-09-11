/**
 * The seeded-defect change's MATERIAL — the diff, the file list, and the base
 * tree it applies to. The answers live next door in `labels.ts` and this module
 * cannot see them.
 *
 * ## This module must import NOTHING from the label side
 *
 * That is the structural half of story 2.4's AC2: "ground truth is withheld from
 * the reviewed worktree and from every model-accessible input and tool". Before
 * the split, the diff and the thirteen labels were one module, so nothing could
 * import the change under review without also importing the answer key — and
 * "withheld" had no expression a reader could check. Now it does: the
 * materializer (`scripts/materialize-labelled-change.ts`) reaches
 * `material.ts` and `seal.ts`, and CANNOT reach `labels.ts` or `adjudicate.ts`.
 * Its import list is the argument.
 *
 * **An edit that adds `import … from "./labels.ts"` here is the mistake, not the
 * shortcut.** It would put a defect id, a summary or a marker back within reach
 * of the code that writes the reviewed worktree, and the leak assertion in
 * `scripts/materialize-labelled-change.test.ts` is what would catch it. Take the
 * label to the label side instead.
 *
 * ## Why this fixture is honest, and what CI can prove with it
 *
 * - **One defect is findable by nobody.** `unchecked-idempotency-key` is planted
 *   and left unfound, so a perfect score is not on offer and a harness bug that
 *   credits everything to everyone shows up as `found === total`.
 * - **Defects overlap between models.** More than one arm finds the SQL
 *   injection and the money-precision bug, so the pool contains the same defect
 *   twice — the pre-clustering state this story creates, and the reason output
 *   says the pool is not merged.
 * - **Every defect carries a `dimension`.** It labels the PLANTED BUG, never a
 *   `Finding`. Story 2A extended this set by adding ROWS in a new file hunk —
 *   `dimension` is still not a `Finding` field and still not a lens; what the
 *   new rows buy is a defect set spanning enough dimensions for CAP-11's recall
 *   claim to be measurable rather than merely stated.
 * - **The unlensed pool is blind to the third file.** The scripted arms in
 *   `recall.test.ts` report nothing from `refund-notice.ts`, so every defect
 *   there is territory only a lens covers. That is the shape CAP-11's criterion
 *   is measured over: "a lensed pass surfaces at least one defect no unlensed
 *   pool member raised".
 * - **The diff is a plausible change**, not a list of tagged bug stubs. A fixture
 *   whose defects are obvious tells you nothing about a real review.
 *
 * Real recall needs real models and real credentials. CI therefore asserts the
 * HARNESS over scripted answers standing in for three models with different blind
 * spots (`recall.test.ts`), which makes CAP-1's criterion mechanical and
 * reproducible. Pointing the same fixture at live providers is what story 2.4's
 * `--labelled-change` makes possible, and `ablation/LIVE-RUN.md` is the
 * procedure.
 */

import type { ChangeSet } from "../../core/ports/repo.ts"

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
 * Story 2A's addition, and it is a THIRD FILE rather than an edit to the two
 * above — on purpose.
 *
 * Nothing ties `SEEDED_DEFECTS`' line numbers to the diff text except the
 * self-consistency assertions in `recall.test.ts`, and every existing defect's
 * locus is a post-change line in `refund.ts` / `ledger.ts`. Editing either hunk
 * shifts lines under eight already-correct loci at once; a new file is additive
 * by construction and leaves every existing assertion valid. (Recorded in story
 * 2's code review; applied here.)
 *
 * Its defects span dimensions the original set does not cover — performance,
 * maintainability, tests, privacy and accessibility — so CAP-11's "seeded
 * defects spanning several dimensions" is a property of the fixture rather than
 * a sentence about it. The unlensed pool scripts are deliberately blind to all
 * of them: that blindness is what makes the lens arm's recall gain measurable.
 */
const NOTICE_TS = `--- /dev/null
+++ b/src/billing/refund-notice.ts
@@ -0,0 +1,31 @@
+import { db } from "../db/client.ts"
+import { mailer } from "../notify/mailer.ts"
+
+export interface NoticeRow {
+  orderId: string
+  email: string
+  amountCents: number
+}
+
+/** Called from the admin console once a batch of refunds is approved. */
+export async function notifyRefunds(rows: NoticeRow[]): Promise<void> {
+  for (const row of rows) {
+    const charge = await db.query("select * from charges where order_id = $1", [row.orderId])
+    const customer = await db.query("select * from customers where email = $1", [row.email])
+    console.log(\`refund notice \${row.email} card=\${customer[0]?.card_number} order=\${row.orderId}\`)
+    await mailer.send({
+      to: row.email,
+      subject: "Your refund",
+      body: renderNotice(row, charge[0]),
+    })
+  }
+}
+
+export function renderNotice(row: NoticeRow, charge: unknown): string {
+  return [
+    \`<div style="color:#9a9a9a;background:#a4a4a4">\`,
+    \`<span>Refunded \${row.amountCents} cents for order \${row.orderId}</span>\`,
+    \`<img src="/refund-complete.png">\`,
+    \`</div>\`,
+  ].join("")
+}
`

/**
 * The change under review, in the shape the `Repo` port produces — so the
 * fixture reaches `review()` through exactly the seam a real run uses, with no
 * fixture-only code path (AD-1: the core knows no harness, and no fixture).
 */
export const SEEDED_CHANGE: ChangeSet = {
  description: "feat(billing): add order refunds (fixture change, seeded defects)",
  files: ["src/billing/refund.ts", "src/billing/ledger.ts", "src/billing/refund-notice.ts"],
  diff: `${REFUND_TS}${LEDGER_TS}${NOTICE_TS}`,
}

/**
 * The PRE-CHANGE tree the diff applies to, so the change can be materialized on
 * disk exactly (story 2.4, Task 2).
 *
 * Only `src/billing/ledger.ts` needs an entry. Its hunk is `@@ -12,6 +12,12 @@` —
 * an EDIT — so a pre-change file has to exist for `git apply` to have anything to
 * edit. `refund.ts` and `refund-notice.ts` are `/dev/null` hunks: the diff
 * creates them itself, and giving them a base entry would break the patch rather
 * than help it.
 *
 * ## The direction of authority
 *
 * `SEEDED_CHANGE.diff` IS THE SOURCE OF TRUTH and this tree is fitted to it —
 * never the other way round. The thirteen defect loci are line numbers into the
 * POST-change files, so a base tree that shifted the hunk would silently move
 * every locus in `ledger.ts` and quietly break recall for a fixture that still
 * looked fine. Three properties below are therefore load-bearing rather than
 * stylistic, and `scripts/materialize-labelled-change.test.ts` re-derives all
 * three from real `git` rather than trusting this comment:
 *
 * 1. **`refundId?: string` is line 12, and `}` is line 17.** That is what makes
 *    the regenerated hunk header `@@ -12,6 +12,12 @@` rather than some other
 *    line pair.
 * 2. **`export interface LedgerEntry {` is line 9** — the nearest line above the
 *    hunk matching git's default funcname pattern, which is where the text after
 *    the second `@@` comes from.
 * 3. **The file ends at `}` with a trailing newline.** A missing final newline
 *    would add a `\ No newline at end of file` marker the fixture diff does not
 *    carry.
 */
export const BASE_TREE: Record<string, string> = {
  "src/billing/ledger.ts": `/** The billing ledger: one in-memory balance per order, mirrored into a table. */

import type { Conn } from "../db/client.ts"

/** Running balance per order, in cents. The \`ledger\` table is the durable copy. */
const balances = new Map<string, number>()

/** One appended row. */
export interface LedgerEntry {
  orderId: string
  deltaCents: number
  refundId?: string
}

export function appendLedgerEntry(conn: Conn, entry: LedgerEntry): void {
  balances.set(entry.orderId, (balances.get(entry.orderId) ?? 0) + entry.deltaCents)
}
`,
}
