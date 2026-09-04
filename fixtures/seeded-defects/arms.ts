/**
 * The seeded-defect fixture's MODEL STAND-INS, and the one place they live.
 *
 * Three blind-spot profiles plus four lens personas, scripted turn by turn. They
 * were written for CAP-1's recall harness and lived inside `recall.test.ts` until
 * story 9, when CAP-9's ablation needed to drive THE SAME three models through a
 * different roster. Two copies of these scripts would have been two different
 * experiments wearing one name: an ablation arm must contrast the ROSTER and
 * nothing else, which is only true if both harnesses measure the same three blind
 * spots.
 *
 * MOVED VERBATIM (story 9). Every value below is byte-identical to what
 * `recall.test.ts` held before the move, and the whole acceptance test of the move
 * is that `CAP-1 pooled recall = 7/13 (best single member: 3/13)` does not budge.
 *
 * These are FIXTURES, not instructions: nothing here is ever sent to a model. They
 * are what a scripted backend hands BACK, so a test can drive a real `review()`
 * with no provider and no credential (`change.ts` on what CI can and cannot prove).
 */

import { selectRoster, type Pin } from "../../core/roster/select.ts"
import { review } from "../../core/run/review.ts"
import {
  candidate,
  fakeClock,
  FakeBackend,
  type SlotScript,
  type SlotStep,
} from "../../core/test-support/fakes.ts"
import { SEEDED_CHANGE } from "./change.ts"

export const REFUND = "src/billing/refund.ts"
export const LEDGER = "src/billing/ledger.ts"

/**
 * Three blind-spot profiles. Nobody sees the idempotency defect; the SQL
 * injection and the money-precision defect are each seen by two models, which is
 * what puts the same defect in the pool twice before clustering exists.
 */
export const SCRIPTS: Record<string, SlotScript> = {
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

export const NOTICE = "src/billing/refund-notice.ts"

/**
 * CAP-11's arms. Each lens reads the SAME change the pool just read, and the
 * three lens slots below cover the third file the unlensed scripts are blind to.
 *
 * `discovery-lens-security` is the control inside the control: it re-finds the
 * SQL injection two pool arms already raised, so `lensRecallGain` has an
 * overlapping lens finding to exclude. A gain number that counted it would be
 * measuring duplication, not coverage.
 */
export const LENS_SCRIPTS: Record<string, SlotScript> = {
  "discovery-lens-performance": [
    {
      kind: "ok",
      value: {
        findings: [
          {
            claim: "`notifyRefunds` issues two queries per row, sequentially, inside the batch loop.",
            reasoning:
              "This is an n+1 pattern in both directions: each row costs a charges lookup and a " +
              "customers lookup, awaited one after the other, so a 500-row batch is 1000 round trip " +
              "s where two set-based queries would answer the whole batch.",
            severity: "high",
            file: NOTICE,
            startLine: 12,
            endLine: 14,
          },
        ],
      },
    },
  ],
  "discovery-lens-privacy-a11y": [
    {
      kind: "ok",
      value: {
        findings: [
          {
            claim: "The notice log line writes the customer's email and `card_number` in plain text.",
            reasoning:
              "Cardholder data is logged on every row of every batch and then lives wherever the " +
              "logs live, for the whole retention period, reachable by anyone with log access.",
            severity: "critical",
            file: NOTICE,
            startLine: 15,
            endLine: 15,
          },
          {
            claim: "The rendered notice is grey-on-grey and its image carries no alt attribute.",
            reasoning:
              "#9a9a9a on #a4a4a4 is far under any contrast minimum, so a low-vision customer " +
              "cannot read the confirmation, and with no alt text a screen reader announces " +
              "nothing at all where the confirmation image is.",
            severity: "medium",
            file: NOTICE,
            startLine: 26,
            endLine: 28,
          },
        ],
      },
    },
  ],
  "discovery-lens-tests": [
    {
      kind: "ok",
      value: {
        findings: [
          {
            claim: "`notifyRefunds` sends irreversible customer email and the change ships no test for it.",
            reasoning:
              "Nothing here is covered: not the batch, not the empty batch, not a partial send " +
              "where the third row throws after two customers have already been emailed.",
            severity: "high",
            file: NOTICE,
            startLine: 10,
            endLine: 11,
          },
        ],
      },
    },
  ],
  "discovery-lens-security": [
    {
      kind: "ok",
      value: {
        findings: [
          {
            claim: "The charges lookup interpolates the order id into the SQL text.",
            reasoning:
              "String interpolation into a query lets a crafted order id rewrite the statement. " +
              "Two pool models raised this as well — it is deliberately NOT new coverage.",
            severity: "critical",
            file: REFUND,
            startLine: 20,
            endLine: 22,
          },
        ],
      },
    },
  ],
}

export const LENSES = ["performance", "privacy-a11y", "tests", "security"] as const

/**
 * CAP-1 measures DISCOVERY recall, and story 5 put a debate stage inside
 * `review()` between discovery and output. Every scripted slot is therefore
 * asked a SECOND time, for a debate turn this fixture has no opinion about —
 * and `FakeBackend` repeats a script's last step, so without this the debate
 * turn would be handed the discovery envelope, fail validation twice, and
 * decorate a harness that asserts "clean, undegraded 3-model run" with three
 * drop-out warnings.
 *
 * `{turns: []}` is a VALID debate envelope meaning "I stated no position this
 * round". The stage treats it as abstention, which is exactly what this fixture
 * means: it neither denies nor concedes anything, raises no warning, moves no
 * position, and leaves the contested findings to exit at the round cap. The
 * recall numbers below are untouched by it — debate adds and removes no
 * findings — which is the property that keeps CAP-1's measurement the same
 * measurement it was before this stage existed.
 */
export const DEBATE_ABSTENTION: SlotStep = { kind: "ok", value: { turns: [] } }

export function abstainingInDebate(scripts: Record<string, SlotScript>): Record<string, SlotScript> {
  return Object.fromEntries(
    Object.entries(scripts).map(([slot, script]) => [slot, [...script, DEBATE_ABSTENTION]]),
  )
}

/**
 * The three candidates the fixture's host offers — three providers, three
 * lineages, which is the roster AD-4 ranks toward.
 */
export const SEEDED_CANDIDATES = [
  candidate("anthropic", "claude-sonnet-4-5"),
  candidate("openai", "gpt-5"),
  candidate("google", "gemini-2.5-pro"),
]

/**
 * ONE ARM of a run over the seeded change — the generalized `threeSlotRun`.
 *
 * `threeSlotRun(lenses)` was `seededArm({ slots: 3, lenses })` all along. Story 9
 * needed the other two arms — a pinned single model, and a three-slot pool with no
 * lenses — and they differ from it in the ROSTER and in nothing else.
 *
 * EVERY OTHER DIAL IS LEFT AT ITS DEFAULT, deliberately. An arm that moved a
 * threshold or a round cap as well as a roster would confound the one comparison
 * this fixture exists to support: two variables and one number is not a
 * measurement. `tokenCap` is the single exception and it is passed the SAME value
 * to every arm by its caller, which is how a shared ceiling stays a shared ceiling.
 *
 * A FRESH `FakeBackend` PER CALL, and that is load-bearing rather than tidy:
 * `FakeBackend` counts attempts per (slot, role) and replays a script's last step
 * once it runs out, so one instance shared across three arms would hand arm 2 the
 * step arm 1 finished on.
 */
export function seededArm(options: {
  slots: number
  lenses?: readonly string[]
  pins?: readonly Pin[]
  tokenCap?: number
}) {
  const { slots, lenses = [], pins = [], tokenCap } = options
  const resolved = selectRoster(SEEDED_CANDIDATES, {
    slots,
    lenses,
    pins,
    providerConfigKey: "provider",
  })
  return review({
    roster: resolved.roster,
    backend: new FakeBackend(abstainingInDebate({ ...SCRIPTS, ...LENS_SCRIPTS })),
    clock: fakeClock(),
    change: SEEDED_CHANGE,
    priorWarnings: resolved.warnings,
    ...(tokenCap === undefined ? {} : { tokenCap }),
  })
}
