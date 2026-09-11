/**
 * The hand-labelled CROSS-ARM case set — what `ablation/align.ts` is scored on
 * when two arms raised their findings independently (FR3, FR4).
 *
 * `core/clustering/fixtures/pairs.ts` measures the same matcher WITHIN one run:
 * eight rows, one file, both findings from one pool. That calibration does not
 * transfer to two arms, and this set exists because it does not. Every finding
 * here cites a file and a post-change line of `SEEDED_CHANGE`
 * (`fixtures/seeded-defects/material.ts`). The rates counted over it are counts
 * over these few hand-built cases for THAT change: not a measurement of any run's
 * own findings, and they carry over to no other change.
 * `ablation/cross-arm-rates.ts` prints them only in reports of runs whose
 * reviewed diff hashes to `CROSS_ARM_PAIRS_SEAL.sourceDiffHash`.
 *
 * ## Labelled and sealed BEFORE the aligner was first scored on it
 *
 * Every label below was written, and `seal.test.ts` pinned the dataset hash, on
 * 2026-09-11 before `measureCrossArm` ran over this set for the first time. The
 * measured rates are pinned in `ablation/cross-arm-rates.test.ts` as a
 * regression literal, not a target. **A label is never edited to move a rate.**
 * A label found to be wrong is a new set version with the reason recorded, and
 * the rates it produces are reported as re-measured on that version.
 *
 * ## The four labels, and what the aligner should do with each
 *
 * - `equivalent` — one defect, one finding per arm. Correct outcome: the two
 *   subjects share an `AlignedGroup`.
 * - `distinct` — two different defects, one per arm. Correct: they do not.
 * - `only-in-one-arm` — the subject (always in arm A) has no counterpart in arm
 *   B. Correct: the subject's group holds no arm-B finding.
 * - `ambiguous` — the labeller cannot say whether the two findings name the same
 *   defect. Preserved as such, never resolved by a coin or by the matcher, and
 *   excluded from both denominators. Its count is printed.
 *
 * "Grouped" means one `AlignedGroup` of ANY kind — a `matched` group and an
 * `ambiguous` group (two findings from one arm) both count. The error this set
 * measures is the matcher's partition, not the aligner's later classification.
 *
 * ## The honesty property
 *
 * Cases the shipped matcher is expected to get WRONG, in both directions, each
 * saying so in `why`, so a perfect score is not on offer:
 *
 * - under-merge: a cross-file equivalent the basename block key vetoes; a
 *   file-level finding against a line-cited one; one defect described from two
 *   ends with no shared vocabulary.
 * - over-merge: two defects at one locus in shared words; a single-linkage chain
 *   bridged by a third finding; a lone finding absorbed by a neighbour.
 *
 * Every `distinct` and `only-in-one-arm` case keeps all its findings in one
 * basename, so no block-key veto can hide an over-merge: a matcher answering
 * "similar" to everything groups every one of them, and
 * `ablation/cross-arm-rates.test.ts` asserts the full denominator.
 */

import type { Finding, Severity } from "../../core/domain/finding.ts"

export type CrossArmLabel = "equivalent" | "distinct" | "only-in-one-arm" | "ambiguous"

export const CROSS_ARM_LABELS: readonly CrossArmLabel[] = [
  "equivalent",
  "distinct",
  "only-in-one-arm",
  "ambiguous",
]

export interface CrossArmCase {
  id: string
  label: CrossArmLabel
  /** Every finding arm A raised in this case, subject included. */
  armA: Finding[]
  /** Every finding arm B raised in this case. */
  armB: Finding[]
  /** Id of the labelled finding in `armA`. */
  subjectA: string
  /**
   * Id of the labelled finding in `armB`. Absent exactly when `label` is
   * `only-in-one-arm`: that label says arm B has no counterpart to name.
   */
  subjectB?: string
  /** What the case tests, for the human reading a wrong outcome. */
  why: string
}

interface Draft {
  id: string
  claim: string
  file: string
  startLine?: number
  endLine?: number
  severity?: Severity
  author: string
}

function finding(draft: Draft): Finding {
  return {
    id: draft.id,
    claim: draft.claim,
    reasoning: "",
    locus: { file: draft.file, startLine: draft.startLine, endLine: draft.endLine },
    severity: draft.severity ?? "high",
    author: draft.author,
    source: "pool",
    history: [],
  }
}

const REFUND = "src/billing/refund.ts"
const LEDGER = "src/billing/ledger.ts"
const NOTICE = "src/billing/refund-notice.ts"

/** Arm A's author. Two arms are two runs, so the slot names carry no meaning across them. */
const A = "discovery-1"
const B = "discovery-2"

export const CROSS_ARM_CASES: readonly CrossArmCase[] = [
  // ---- equivalent ----
  {
    id: "sql-injection-reworded",
    label: "equivalent",
    why: "The SQL injection at the charges query, described by two arms in different words at overlapping lines. The base case: a matcher that misses it reports a real pair as two lonely findings.",
    armA: [
      finding({
        id: "e1a",
        claim: "The order id is interpolated into the charges query string, so a crafted id runs arbitrary SQL.",
        file: REFUND,
        startLine: 20,
        endLine: 22,
        severity: "critical",
        author: A,
      }),
    ],
    armB: [
      finding({
        id: "e1b",
        claim: "The charges query interpolates req.orderId into the SQL string; it should bind it as a parameter.",
        file: REFUND,
        startLine: 21,
        severity: "critical",
        author: B,
      }),
    ],
    subjectA: "e1a",
    subjectB: "e1b",
  },
  {
    id: "money-float-two-cites",
    label: "equivalent",
    why: "The money-as-float defect, one arm citing the division and the other the whole gateway call around it.",
    armA: [
      finding({
        id: "e2a",
        claim: "amountCents / 100 turns the refund amount into a binary float.",
        file: REFUND,
        startLine: 33,
        author: A,
      }),
    ],
    armB: [
      finding({
        id: "e2b",
        claim: "The refund amount is sent to the gateway as a float, dividing amountCents by 100.",
        file: REFUND,
        startLine: 31,
        endLine: 35,
        author: B,
      }),
    ],
    subjectA: "e2a",
    subjectB: "e2b",
  },
  {
    id: "swallowed-failure-reworded",
    label: "equivalent",
    why: "`refundOrderSafely` reporting a failed refund as a success, one arm citing the function and the other its catch block.",
    armA: [
      finding({
        id: "e3a",
        claim: "refundOrderSafely swallows every error and reports ok true.",
        file: REFUND,
        startLine: 47,
        endLine: 53,
        author: A,
      }),
    ],
    armB: [
      finding({
        id: "e3b",
        claim: "The catch in refundOrderSafely swallows the error and returns ok true for a failed refund.",
        file: REFUND,
        startLine: 50,
        endLine: 52,
        author: B,
      }),
    ],
    subjectA: "e3a",
    subjectB: "e3b",
  },
  {
    id: "duplicate-in-one-arm",
    label: "equivalent",
    why: "Arm A raised the SQL injection twice, arm B once. The aligner calls the group `ambiguous` because it has no 1:1 correspondence, but the subjects still share one group, which is the correct partition. Tests that `grouped` means ANY group kind.",
    armA: [
      finding({
        id: "e4a",
        claim: "The order id is interpolated into the SQL query.",
        file: REFUND,
        startLine: 20,
        severity: "critical",
        author: A,
      }),
      finding({
        id: "e4a2",
        claim: "Interpolating the order id into SQL allows injection.",
        file: REFUND,
        startLine: 21,
        severity: "critical",
        author: "discovery-3",
      }),
    ],
    armB: [
      finding({
        id: "e4b",
        claim: "SQL injection through the interpolated order id in the charges query.",
        file: REFUND,
        startLine: 20,
        endLine: 22,
        severity: "critical",
        author: B,
      }),
    ],
    subjectA: "e4a",
    subjectB: "e4b",
  },
  {
    id: "missing-await-cross-file",
    label: "equivalent",
    why: "THE SHIPPED MATCHER IS EXPECTED TO GET THIS WRONG (under-merge, block-key veto). The missing await on the ledger write: one arm cites the unawaited call in refund.ts, the other the signature that became async in ledger.ts. Same defect, two basenames, so the pair is vetoed before the matcher is asked.",
    armA: [
      finding({
        id: "e5a",
        claim: "appendLedgerEntry is called without await, so a failed ledger insert is never seen.",
        file: REFUND,
        startLine: 37,
        endLine: 41,
        author: A,
      }),
    ],
    armB: [
      finding({
        id: "e5b",
        claim: "appendLedgerEntry is now async but its caller in refund.ts was not updated to await it.",
        file: LEDGER,
        startLine: 15,
        author: B,
      }),
    ],
    subjectA: "e5a",
    subjectB: "e5b",
  },
  {
    id: "untested-batch-file-level",
    label: "equivalent",
    why: "THE SHIPPED MATCHER IS EXPECTED TO GET THIS WRONG (under-merge, file-level veto). The missing test for `notifyRefunds`: one arm cites no line, the other cites the function. The matcher never compares a file-level finding with a line-cited one.",
    armA: [
      finding({
        id: "e6a",
        claim: "No test covers notifyRefunds, which sends customer email.",
        file: NOTICE,
        severity: "medium",
        author: A,
      }),
    ],
    armB: [
      finding({
        id: "e6b",
        claim: "notifyRefunds ships with no test for the batch, the empty batch or a partial send.",
        file: NOTICE,
        startLine: 10,
        endLine: 11,
        severity: "medium",
        author: B,
      }),
    ],
    subjectA: "e6a",
    subjectB: "e6b",
  },
  {
    id: "ledger-divergence-two-ends",
    label: "equivalent",
    why: "THE SHIPPED MATCHER IS EXPECTED TO GET THIS WRONG (under-merge, no shared vocabulary). The in-memory balance running ahead of the table: one arm describes the cause (mutated before the insert), the other the effect (balances ahead of the database).",
    armA: [
      finding({
        id: "e7a",
        claim: "The in-memory balance is updated before the insert and never rolled back.",
        file: LEDGER,
        startLine: 16,
        endLine: 17,
        author: A,
      }),
    ],
    armB: [
      finding({
        id: "e7b",
        claim: "A failed ledger table write leaves balances ahead of the database.",
        file: LEDGER,
        startLine: 18,
        endLine: 22,
        author: B,
      }),
    ],
    subjectA: "e7a",
    subjectB: "e7b",
  },

  // ---- distinct ----
  {
    id: "two-defects-one-locus",
    label: "distinct",
    why: "THE SHIPPED MATCHER IS EXPECTED TO GET THIS WRONG (over-merge). Two defects on the same expression, `req.amountCents`: the float conversion and the missing check against the charged amount. Both claims name the refund amount, so shared words and overlapping lines put them together.",
    armA: [
      finding({
        id: "d1a",
        claim: "The refund amount req.amountCents is divided by 100 into a float.",
        file: REFUND,
        startLine: 33,
        author: A,
      }),
    ],
    armB: [
      finding({
        id: "d1b",
        claim: "The refund amount req.amountCents is never checked against the charged amount.",
        file: REFUND,
        startLine: 31,
        endLine: 35,
        author: B,
      }),
    ],
    subjectA: "d1a",
    subjectB: "d1b",
  },
  {
    id: "chain-across-arms",
    label: "distinct",
    why: "THE SHIPPED MATCHER IS EXPECTED TO GET THIS WRONG (over-merge, single-linkage chain). The leaked connection (arm A) and the idempotency key that is never read (arm B) share no words. Arm B's third finding, about the early return, shares words with both, and transitive closure joins all three.",
    armA: [
      finding({
        id: "d2a",
        claim: "The connection from db.acquire is leaked when no charge row is found.",
        file: REFUND,
        startLine: 18,
        author: A,
      }),
    ],
    armB: [
      finding({
        id: "d2bridge",
        claim: "The early return when no charge row is found skips the refund key insert conflict check.",
        file: REFUND,
        startLine: 24,
        severity: "medium",
        author: "discovery-3",
      }),
      finding({
        id: "d2b",
        claim: "The refund key insert uses on conflict do nothing and never reads the key back.",
        file: REFUND,
        startLine: 26,
        endLine: 29,
        author: B,
      }),
    ],
    subjectA: "d2a",
    subjectB: "d2b",
  },
  {
    id: "adjacent-lines-different-defects",
    label: "distinct",
    why: "The card number in the log line and the per-row queries two lines above it. Near in the file, unrelated as defects.",
    armA: [
      finding({
        id: "d3a",
        claim: "The log line prints the customer's card_number in plain text.",
        file: NOTICE,
        startLine: 15,
        severity: "critical",
        author: A,
      }),
    ],
    armB: [
      finding({
        id: "d3b",
        claim: "Two queries run per row inside the loop, an N+1 pattern.",
        file: NOTICE,
        startLine: 13,
        endLine: 14,
        severity: "medium",
        author: B,
      }),
    ],
    subjectA: "d3a",
    subjectB: "d3b",
  },
  {
    id: "shared-words-far-apart",
    label: "distinct",
    why: "Both claims are about the charge lookup, but one is the select-star query in the loop and the other is the renderer's unused `charge` parameter eleven lines below. Shared vocabulary, different sites, different defects.",
    armA: [
      finding({
        id: "d4a",
        claim: "The charges query selects every column with select star.",
        file: NOTICE,
        startLine: 13,
        severity: "low",
        author: A,
      }),
    ],
    armB: [
      finding({
        id: "d4b",
        claim: "renderNotice takes a charge from the charges query it never reads.",
        file: NOTICE,
        startLine: 24,
        severity: "low",
        author: B,
      }),
    ],
    subjectA: "d4a",
    subjectB: "d4b",
  },
  {
    id: "signature-vs-balance",
    label: "distinct",
    why: "In the same rewritten function: the async signature that breaks every caller, and the balance mutated before the insert. Adjacent lines, no shared defect.",
    armA: [
      finding({
        id: "d5a",
        claim: "appendLedgerEntry now returns a promise, a breaking signature change for every caller.",
        file: LEDGER,
        startLine: 15,
        author: A,
      }),
    ],
    armB: [
      finding({
        id: "d5b",
        claim: "The in-memory balance is set before the insert runs.",
        file: LEDGER,
        startLine: 16,
        endLine: 17,
        author: B,
      }),
    ],
    subjectA: "d5a",
    subjectB: "d5b",
  },

  // ---- only-in-one-arm ----
  {
    id: "lone-idempotency-finding",
    label: "only-in-one-arm",
    why: "Only arm A found the unread idempotency key. Arm B's finding a few lines up is the SQL injection, with no words in common.",
    armA: [
      finding({
        id: "o1a",
        claim: "The idempotency key is written but never read, so a retried webhook refunds twice.",
        file: REFUND,
        startLine: 26,
        endLine: 29,
        author: A,
      }),
    ],
    armB: [
      finding({
        id: "o1b",
        claim: "The order id is interpolated into the charges query.",
        file: REFUND,
        startLine: 20,
        endLine: 22,
        severity: "critical",
        author: B,
      }),
    ],
    subjectA: "o1a",
  },
  {
    id: "lone-finding-absorbed-by-neighbour",
    label: "only-in-one-arm",
    why: "THE SHIPPED MATCHER IS EXPECTED TO GET THIS WRONG (over-merge). Only arm A found the connection leak on a thrown gateway call. Arm B's nearby finding is the unawaited ledger write — a different defect — but both claims name the connection and `conn.release`, so arm A's lone finding is grouped with it.",
    armA: [
      finding({
        id: "o2a",
        claim: "conn.release is skipped when the gateway refund throws, leaking the connection.",
        file: REFUND,
        startLine: 43,
        author: A,
      }),
    ],
    armB: [
      finding({
        id: "o2b",
        claim: "The ledger write on this connection is not awaited before conn.release runs.",
        file: REFUND,
        startLine: 37,
        endLine: 41,
        author: B,
      }),
    ],
    subjectA: "o2a",
  },
  {
    id: "lone-file-level-finding",
    label: "only-in-one-arm",
    why: "Only arm A raised the maintainability claim, and at file level. Arm B's finding in the same file is the card number in the log.",
    armA: [
      finding({
        id: "o3a",
        claim: "The module mixes querying, logging, mailing and rendering in one file.",
        file: NOTICE,
        severity: "low",
        author: A,
      }),
    ],
    armB: [
      finding({
        id: "o3b",
        claim: "The customer's card number is written to the log.",
        file: NOTICE,
        startLine: 15,
        severity: "critical",
        author: B,
      }),
    ],
    subjectA: "o3a",
  },
  {
    id: "lone-divergence-finding",
    label: "only-in-one-arm",
    why: "Only arm A found the balance diverging from the table. Arm B's finding in the same function is the async signature change, with no words in common.",
    armA: [
      finding({
        id: "o4a",
        claim: "The in-memory balance diverges from the ledger table when the insert fails.",
        file: LEDGER,
        startLine: 16,
        endLine: 22,
        author: A,
      }),
    ],
    armB: [
      finding({
        id: "o4b",
        claim: "appendLedgerEntry changed to async without updating its callers to await.",
        file: LEDGER,
        startLine: 15,
        author: B,
      }),
    ],
    subjectA: "o4a",
  },

  // ---- ambiguous ----
  {
    id: "contrast-and-alt",
    label: "ambiguous",
    why: "Low contrast and a missing alt attribute in one snippet of notice markup. Two accessibility failures, or one inaccessible notice? The labeller cannot say, and the label is kept rather than decided.",
    armA: [
      finding({
        id: "x1a",
        claim: "The notice div uses grey text on a grey background with too little contrast.",
        file: NOTICE,
        startLine: 26,
        severity: "medium",
        author: A,
      }),
    ],
    armB: [
      finding({
        id: "x1b",
        claim: "The notice image has no alt text.",
        file: NOTICE,
        startLine: 28,
        severity: "medium",
        author: B,
      }),
    ],
    subjectA: "x1a",
    subjectB: "x1b",
  },
  {
    id: "currency-vs-amount-check",
    label: "ambiguous",
    why: "One arm says the charge currency is ignored when the amount is converted; the other says the amount is never reconciled with the charge's currency and amount. It may be the float conversion, the missing amount check, or both.",
    armA: [
      finding({
        id: "x2a",
        claim: "Zero-decimal currencies are refunded at a hundredth of their value because charge.currency is ignored.",
        file: REFUND,
        startLine: 33,
        author: A,
      }),
    ],
    armB: [
      finding({
        id: "x2b",
        claim: "The refund amount is never reconciled with the charge's currency and amount.",
        file: REFUND,
        startLine: 31,
        endLine: 35,
        author: B,
      }),
    ],
    subjectA: "x2a",
    subjectB: "x2b",
  },
  {
    id: "hidden-failure-two-causes",
    label: "ambiguous",
    why: "Both claims say a failure never reaches the caller. The unawaited ledger write and the catch-all in `refundOrderSafely` each cause that, and neither claim names which.",
    armA: [
      finding({
        id: "x3a",
        claim: "A failed ledger insert never reaches the caller.",
        file: REFUND,
        startLine: 37,
        endLine: 41,
        author: A,
      }),
    ],
    armB: [
      finding({
        id: "x3b",
        claim: "Failures inside refundOrder are hidden from the caller.",
        file: REFUND,
        startLine: 47,
        endLine: 53,
        author: B,
      }),
    ],
    subjectA: "x3a",
    subjectB: "x3b",
  },
  {
    id: "per-row-query-vs-unused-charge",
    label: "ambiguous",
    why: "The per-row charges query is wasted work because `renderNotice` never reads the charge. One arm blames the query, the other the parameter that forces it. One defect seen from two ends, or two defects?",
    armA: [
      finding({
        id: "x4a",
        claim: "The per-row charges query is wasted work.",
        file: NOTICE,
        startLine: 13,
        severity: "low",
        author: A,
      }),
    ],
    armB: [
      finding({
        id: "x4b",
        claim: "renderNotice takes a charge it never reads, which forces the per-row query.",
        file: NOTICE,
        startLine: 24,
        severity: "low",
        author: B,
      }),
    ],
    subjectA: "x4a",
    subjectB: "x4b",
  },
]
