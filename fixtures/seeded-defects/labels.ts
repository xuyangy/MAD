/**
 * The ANSWER KEY for the seeded-defect change: the thirteen planted defects and
 * what each one is.
 *
 * ## Nothing on the materializer's path may import this module
 *
 * Story 2.4's AC2: "the ground-truth labels, the scoring answers, and anything
 * that reveals them are withheld from the reviewed worktree and from every
 * model-accessible input and tool. A model that can read the answer key measures
 * nothing."
 *
 * The split from `material.ts` is what makes that checkable rather than
 * promised. `scripts/materialize-labelled-change.ts` writes the tree a live model
 * reviews; it imports `material.ts` and `seal.ts` and it must never reach here.
 * Its test asserts no file it wrote contains any `id`, `summary` or `markers`
 * entry from this file.
 *
 * The evidence for WHY each of these thirteen is a real defect — which
 * `evaluation-protocol.md:465` delegates to story 2.4 — is in
 * `fixtures/seeded-defects/ADJUDICATION.md` beside this file. Labels here,
 * reasons there, and neither reaches the reviewed worktree.
 */

import type { SeededDefect } from "../recall.ts"

/**
 * The planted defects. Line numbers are post-change lines in the files that
 * `material.ts` holds (spine, Locus): `refund.ts` is added whole, so its lines are 1-based from the
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

  // ---- story 2A (CAP-11): the third file, and the dimensions the original
  // eight do not cover. Added as ROWS, exactly as `fixtures/recall.ts` promises
  // — `DEFECT_DIMENSIONS` is open by construction, so none of this reshapes the
  // harness. Loci are post-change lines in `refund-notice.ts`, 1-based from the
  // top of its hunk, and checked against the diff text by `recall.test.ts`.
  {
    id: "n-plus-one-notice-queries",
    dimension: "performance",
    locus: { file: "src/billing/refund-notice.ts", startLine: 12, endLine: 14 },
    summary:
      "Two queries are issued per row, sequentially, inside the batch loop — so a 500-row batch " +
      "is 1000 awaited round trips where two set-based queries would do.",
    markers: ["n+1", "per row", "inside the loop", "sequentially", "round trip"],
  },
  {
    id: "card-number-in-notice-log",
    dimension: "privacy-a11y",
    locus: { file: "src/billing/refund-notice.ts", startLine: 15, endLine: 15 },
    summary:
      "The log line writes the customer's email and `card_number` in plain text, so cardholder " +
      "data lands wherever the logs go and stays there for the retention period.",
    markers: ["card_number", "logged", "log line", "cardholder", "plain text"],
  },
  {
    id: "inaccessible-notice-markup",
    dimension: "privacy-a11y",
    locus: { file: "src/billing/refund-notice.ts", startLine: 26, endLine: 28 },
    summary:
      "The notice renders grey-on-grey text well under any contrast minimum and an image with no " +
      "alt attribute, so the confirmation is unreadable to a low-vision customer and silent to a " +
      "screen reader.",
    markers: ["contrast", "alt attribute", "alt text", "screen reader", "low-vision"],
  },
  {
    id: "untested-notice-batch",
    dimension: "tests",
    locus: { file: "src/billing/refund-notice.ts", startLine: 10, endLine: 11 },
    summary:
      "`notifyRefunds` sends irreversible customer email in a loop and the change ships no test " +
      "for it at all — not for the batch, not for the empty batch, not for a partial send.",
    markers: ["untested", "no test", "not covered", "no coverage", "ships no test"],
  },
  {
    id: "notice-renderer-takes-unused-charge",
    dimension: "maintainability",
    locus: { file: "src/billing/refund-notice.ts", startLine: 24, endLine: 24 },
    summary:
      "`renderNotice` accepts a `charge: unknown` it never reads, which is what forces the caller " +
      "to run the per-row charge query at all; one module now queries, logs, mails and renders, " +
      "and the next change has to unpick all four.",
    markers: ["unused parameter", "never reads", "never used", "responsibilit", "unpick"],
  },
]
