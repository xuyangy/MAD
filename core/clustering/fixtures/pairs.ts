/**
 * The hand-labelled finding-PAIR set — CAP-2's measurement asset (AD-14).
 *
 * It lives HERE, with the engine, and not in the top-level `fixtures/` tree:
 * that tree is CAP-1's seeded-defect change and `core/` may not import it
 * (AD-1). `scripts/lint-dependency-direction.ts` resolves relative specifiers,
 * so a fixture directory inside `core/` is legitimate by construction.
 *
 * These pairs, not the matcher, are the durable asset. A model-backed matcher
 * arriving later is scored by exactly this set without editing it.
 *
 * ## The honesty property
 *
 * At least one row the SHIPPED matcher is expected to get WRONG, so a perfect
 * score is not on offer — the same discipline `fixtures/seeded-defects/change.ts`
 * applies with its deliberately unfindable defect. Two rows are wrong today, one
 * in each direction, and both say so in `why`:
 *
 * - `symptom-vs-root-cause` — one defect described from its two ends, with no
 *   shared vocabulary. A lexical matcher misses it: an UNDER-merge.
 * - `rounding-chain` — the single-linkage chain from `engine.ts`. A~B and B~C
 *   hold, A~C does not, and all three land in one cluster: an OVER-MERGE.
 *
 * A harness bug that answered "equivalent" to everything would drive the
 * over-merge count to the full distinct-row count, which `rates.test.ts` asserts
 * directly.
 */

import type { Finding, Severity } from "../../domain/finding.ts"

export type PairLabel = "equivalent" | "distinct"

export interface PairRow {
  id: string
  label: PairLabel
  a: Finding
  b: Finding
  /**
   * For the human reading a failed rate — the same job `SeededDefect.summary`
   * does. A row that fails without saying what it was testing is a number, not a
   * finding.
   */
  why: string
  /**
   * Extra findings present in the run alongside `a` and `b`. Empty for every
   * ordinary row, which is measured over its two items alone; the chain row is
   * the one that carries a third, because a transitive over-merge cannot be
   * reproduced by a pair in isolation — that is the whole shape of the failure.
   */
  context?: readonly Finding[]
}

interface Draft {
  id: string
  claim: string
  file: string
  startLine?: number
  endLine?: number
  severity?: Severity
  author?: string
}

function pool(draft: Draft): Finding {
  return {
    id: draft.id,
    claim: draft.claim,
    reasoning: "",
    locus: { file: draft.file, startLine: draft.startLine, endLine: draft.endLine },
    severity: draft.severity ?? "high",
    author: draft.author ?? "discovery-1",
    source: "pool",
    history: [],
  }
}

function lens(draft: Draft & { lens: string }): Finding {
  return { ...pool(draft), source: "lens", lens: draft.lens, author: draft.author ?? `discovery-lens-${draft.lens}` }
}

const REFUND = "src/billing/refund.ts"

export const PAIRS: readonly PairRow[] = [
  {
    id: "same-defect-different-words",
    label: "equivalent",
    why: "Two models describing the float-money defect at the same lines in different words. The base case CAP-2 exists for; missing it is the under-merge that leaves three lonely findings.",
    a: pool({
      id: "p1a",
      claim: "The refund amount is converted to a float before it is stored.",
      file: REFUND,
      startLine: 40,
      endLine: 42,
      author: "discovery-1",
    }),
    b: pool({
      id: "p1b",
      claim: "Storing the refund amount as a float loses cents.",
      file: REFUND,
      startLine: 40,
      endLine: 41,
      author: "discovery-2",
    }),
  },
  {
    id: "line-cites-a-few-apart",
    label: "equivalent",
    why: "One defect, two line cites five lines apart. A model that cites the right bug slightly off found the right bug; requiring exact lines would measure line-cite precision and call the result clustering.",
    a: pool({
      id: "p2a",
      claim: "The connection is never released when the insert fails.",
      file: REFUND,
      startLine: 61,
      endLine: 63,
      author: "discovery-1",
    }),
    b: pool({
      id: "p2b",
      claim: "Connection is not released after a failed insert.",
      file: REFUND,
      startLine: 66,
      author: "discovery-3",
    }),
  },
  {
    id: "adjacent-but-different-defects",
    label: "distinct",
    why: "Two lines apart in one file, and two genuinely different bugs. Merging them would erase one defect entirely — the over-merge failure `pipeline-stages.md` §2 says costs the most.",
    a: pool({
      id: "p3a",
      claim: "The order id is interpolated into the SQL string.",
      file: REFUND,
      startLine: 28,
      severity: "critical",
    }),
    b: pool({
      id: "p3b",
      claim: "The idempotency key is never checked before the refund runs.",
      file: REFUND,
      startLine: 30,
      author: "discovery-2",
    }),
  },
  {
    id: "same-wording-different-files",
    label: "distinct",
    why: "Word-for-word the same claim about two files that share a basename. Locus is what separates them, and a matcher reading prose alone would fuse two real defects into one.",
    a: pool({
      id: "p4a",
      claim: "The order id is interpolated into the SQL string.",
      file: REFUND,
      startLine: 28,
      severity: "critical",
    }),
    b: pool({
      id: "p4b",
      claim: "The order id is interpolated into the SQL string.",
      file: "src/reports/refund.ts",
      startLine: 28,
      severity: "critical",
      author: "discovery-2",
    }),
  },
  {
    id: "pool-and-lens-one-defect",
    label: "equivalent",
    why: "AD-14 amended: a lens finding and a pool finding describing one defect must still merge. The lens member survives and is disclosed (AD-17e); what it must never do is increment `raised` (CAP-11).",
    a: pool({
      id: "p5a",
      claim: "The order id is interpolated into the SQL string.",
      file: REFUND,
      startLine: 28,
      severity: "critical",
    }),
    b: lens({
      id: "p5b",
      claim: "Interpolating the order id into the SQL string allows injection.",
      file: REFUND,
      startLine: 28,
      severity: "critical",
      lens: "security",
    }),
  },
  {
    id: "same-author-twice",
    label: "equivalent",
    why: "One model raising the same defect twice. It must merge, and the cluster it forms is what proves `raised` counts DISTINCT AUTHORS: two members, one author, `raised: 1`.",
    a: pool({
      id: "p6a",
      claim: "The refund amount is stored as a float.",
      file: REFUND,
      startLine: 40,
      author: "discovery-2",
    }),
    b: pool({
      id: "p6b",
      claim: "Refund amounts stored as floats lose precision.",
      file: REFUND,
      startLine: 41,
      author: "discovery-2",
    }),
  },
  {
    id: "symptom-vs-root-cause",
    label: "equivalent",
    why: "THE HONEST HARD CASE, AND THE SHIPPED MATCHER IS EXPECTED TO GET IT WRONG. One defect described from its two ends — the symptom a caller sees, and the dropped promise that causes it — sharing no vocabulary at all. A lexical matcher scores this as an UNDER-merge, and that is what the rate is for.",
    a: pool({
      id: "p7a",
      claim: "Callers see a successful refund even when the ledger write failed.",
      file: REFUND,
      startLine: 72,
      author: "discovery-1",
    }),
    b: pool({
      id: "p7b",
      claim: "The promise returned by appendLedgerEntry is dropped.",
      file: REFUND,
      startLine: 74,
      author: "discovery-3",
    }),
  },
  {
    id: "rounding-chain",
    label: "distinct",
    why: "THE SINGLE-LINKAGE CHAIN, AND THE SHIPPED ENGINE IS EXPECTED TO GET IT WRONG. A~B and B~C both hold, A~C does not, and transitive closure puts all three in one cluster — so this row scores as an OVER-merge. Documented in `engine.ts`, measured here rather than hidden. `a` and `b` are the two ends; `context` carries the bridge.",
    a: pool({
      id: "p8a",
      claim: "The refund total is rounded before tax is applied.",
      file: REFUND,
      startLine: 90,
      author: "discovery-1",
    }),
    b: pool({
      id: "p8c",
      claim: "The currency conversion truncates instead of rounding.",
      file: REFUND,
      startLine: 94,
      author: "discovery-3",
    }),
    context: [
      pool({
        id: "p8b",
        claim: "Rounding the total before tax also truncates the currency conversion.",
        file: REFUND,
        startLine: 92,
        author: "discovery-2",
      }),
    ],
  },
]

/**
 * Row ids the shipped matcher is EXPECTED to answer wrongly. Named rather than
 * counted, so a row that starts failing for a new reason cannot hide inside a
 * tolerance — and so a matcher that fixes one of these fails loudly and gets its
 * expectation updated deliberately.
 */
export const EXPECTED_WRONG = ["symptom-vs-root-cause", "rounding-chain"] as const
