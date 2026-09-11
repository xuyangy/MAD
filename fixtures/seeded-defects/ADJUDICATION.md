# Adjudicating findings against the labelled change

This is the worksheet `evaluation-protocol.md:465` delegates to story 2.4, and the
evidence for each of the thirteen truth labels, which no other file in the tree states.

**It is never copied into a reviewed worktree.** It names every defect, every locus and
every marker. `scripts/materialize-labelled-change.ts` writes only what `material.ts`
holds, and `scripts/materialize-labelled-change.test.ts` asserts that no file it wrote
contains an id, a summary or a marker from `labels.ts`. This file is under the same rule:
if it ever appears inside the directory a model is pointed at, the measurement is over.

---

## The two rules this sheet does not get to re-decide

Both are frozen in `evaluation-protocol.md` and are restated here because the person
filling the sheet in needs them in front of them, not because they are reopened.

1. **Adjudication is blind to arm outcomes** (`evaluation-protocol.md:130-132`). You label
   a candidate without knowing which arm upheld it, or whether either did. The common
   candidate pool is truth-adjudicated first; the arms are read afterwards. A label decided
   while looking at which arm it would favour is not a label, it is a result being written
   backwards.
2. **An uncertain label is PRESERVED, not resolved** (`evaluation-protocol.md:132, 170`).
   `unresolved` is a real outcome and it stays in the record. Story 2.8's precision is
   reported as an interval `[TP/N, (TP+U)/N]` precisely so that `U` has somewhere to live;
   forcing a coin-flip label to tidy the sheet destroys that interval's meaning and
   replaces a stated uncertainty with a fabricated certainty.

And the rule those two exist to protect, from `evaluation-protocol.md:130`:

> A finding matching no planted label is **not** proof of a false positive.

Thirteen defects were planted in this change. The change certainly contains others nobody
planted. Counting an unlabelled finding as a false positive by default scores the label
set, not the model.

---

## From a bundle to this sheet

`adjudicate()` is a function, and AC3 is a PROCEDURE. Nothing in `scripts/`, `ablation/` or
`eval-read.ts` calls it, and until 2.6/2.8 own scoring nothing will — so these are the steps
by hand, written down so the path from a written bundle to a filled worksheet exists rather
than being inferred. No reader is built here on purpose: reading a bundle for a SCORE is
story 2.6's and 2.8's, and a half-reader written early is the thing they would have to
unpick.

**1. Find the arm's findings.** A live run with `--out <bundle>` writes

```
<bundle>/bundle.json                                  the declared arms
<bundle>/<armId>/<repeatId>/<runId>/manifest.json     the run identity (FR1)
<bundle>/<armId>/<repeatId>/<runId>/record.json       the whole RunRecord
```

The findings are `record.json`'s `findings` array — the canonical, post-clustering
findings. `report.txt` beside it is the rendered report and is for reading, not for
parsing.

**2. Partition them.** One arm and one repeat at a time, because a truth label is about a
claim and not about an arm:

```
bun -e '
  const { adjudicate } = await import("./fixtures/seeded-defects/adjudicate.ts")
  const { SEEDED_DEFECTS } = await import("./fixtures/seeded-defects/labels.ts")
  const record = await Bun.file(process.argv[1]).json()
  const { matched, unlabelled } = adjudicate(SEEDED_DEFECTS, record.findings)
  console.log("matched:", matched.map((m) => `${m.defectId} <- ${m.finding.id}`).join("\n  "))
  console.log("unlabelled:", unlabelled.map((f) => `${f.id}: ${f.claim}`).join("\n  "))
' <bundle>/<armId>/<repeatId>/<runId>/record.json
```

Run this **outside** the reviewed worktree. It imports `labels.ts`, which is the answer key;
the materialized tree a model was pointed at must never see it (see the rule at the top of
this file).

**3. Fill one row per `unlabelled` finding**, in the table below, under the run identity
that produced it. `matched` needs no row: a planted label already covers it. A repeat that
produced no unlabelled findings still gets a header block saying so, because "nothing to
adjudicate" and "nobody adjudicated this" are different states.

**4. Store the filled sheet with the bundle**, as
`<bundle>/adjudication.md` — beside the evidence it is about, not in this repository. This
file is the blank template and stays blank; a filled copy inside MAD's own tree would be an
answer-key-adjacent document sitting next to the fixture, and it would be one sheet for
runs that must stay distinguishable.

---

## The worksheet

`adjudicate(SEEDED_DEFECTS, findings)` returns `{ matched, unlabelled }`. Every row of
`unlabelled` gets one row here. It computes no precision, no rate and no verdict — story
2.8 owns those.

**Every row names the run it came from.** One template serves every future labelled run, and
two runs' adjudications that cannot be told apart are two results that cannot be read: the
same claim can be raised by the pool arm in repeat 0 and by the control arm in repeat 2, and
they are two candidates, not one. Copy the identity columns from the run's own
`manifest.json` (`identity.armId`, `identity.repeatId`, `identity.fixtureVersion`) and from
the bundle path
(`<bundle>/<armId>/<repeatId>/<runId>/`) — never from memory.

| bundle / run id | arm | repeat | fixture version | # | finding id | file:line | the claim, in the model's own words | evidence examined | truth label | who / when |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
|     |     |      |                 |   |            |           |                                     |                   |             |            |

**The four identity columns, and where each one comes from:**

- **bundle / run id** — the bundle directory and the `<runId>` segment under it. Two runs of
  the same arm and repeat in two bundles are two runs.
- **arm** — `manifest.json`'s `identity.armId`: `control`, `pool` or `lensed`. Recorded, never used
  while labelling: adjudication is blind to arm outcomes (rule 1 above).
- **repeat** — `manifest.json`'s `identity.repeatId`. Repeats of one arm are the noise floor, so a
  candidate raised in one repeat and not another is a fact about the model, not a mistake.
- **fixture version** — `manifest.json`'s `identity.fixtureVersion`, a `known` value that
  `--labelled-change` fills from `LABELLED_CHANGE_SEAL`. A sheet whose rows were labelled against a different version
  of the labelled change is a sheet about a different change.

**Filling `arm` does not mean reading it.** The column exists so a filled sheet can be
joined back to the evidence afterwards; rule 1 above is about the ORDER — label the
candidate, then look at which arm raised it.

**`truth label` takes exactly one of three values:**

- `true-defect` — the claim is correct about this code. It was simply not one of the
  thirteen planted. This is an ordinary and expected outcome.
- `not-a-defect` — the claim is wrong about this code, and the evidence column says how you
  established that.
- `unresolved` — you could not establish either from the evidence available. It stays
  `unresolved`. See rule 2 above.

**`evidence examined` is the column that makes the label checkable.** A line cite, a call
path walked, a test run, a `git blame`. "It looked right" is not evidence, and a row whose
evidence column is empty is an `unresolved` row however confident the labeller felt.

**One claim, one row.** If a finding bundles two claims, split it into two rows and label
each. A bundled row cannot carry one label honestly.

---

## Evidence for the thirteen truth labels

Why each planted defect is a real defect. Line numbers are post-change lines in the
materialized tree, which is what `labels.ts` records as each defect's `locus`.

### `src/billing/refund.ts`

**1. `sql-injection` — lines 20-22 (security)**
`req.orderId` is interpolated into the query text with a template literal, inside single
quotes, and the adjacent `insert into refund_keys` call two statements later uses `$1, $2`
placeholders for values of the same provenance. The file therefore demonstrates both the
safe and the unsafe form over the same input, which is the evidence: the parameterised path
exists and this call does not take it. An order id containing `'` terminates the literal.

**2. `unchecked-idempotency-key` — lines 26-29 (correctness)**
`req.idempotencyKey` is inserted into `refund_keys` with `on conflict do nothing`, and no
statement anywhere in the function reads that table. `on conflict do nothing` returns
success on the duplicate, so the write is unconditional and its result is discarded: the
key is written and never read. `gateway.createRefund` is then called regardless, so a
retried webhook issues a second refund for the same order. The evidence is the absent
read — an idempotency key with no read path is decoration.

*This is the defect deliberately left findable by nobody in the scripted arms.* A perfect
score is not on offer, so a harness bug that credits everything to everyone shows up as
`found === total`.

**3. `unvalidated-refund-amount` — lines 31-35 (correctness)**
The `select` at line 20 fetches `amount_cents` and the code never compares it to
`req.amountCents`; the fetched row is used only for `charge.id` and `charge.currency`. No
lower bound is checked either. A caller can therefore refund more than was charged, or a
negative amount which the ledger call at line 37 turns into a positive balance delta. The
evidence is that the authoritative figure is fetched and then not used.

**4. `money-as-float` — line 33 (data-integrity)**
`req.amountCents / 100` is IEEE-754 division on a money quantity, and its result goes
straight to the payment gateway as `amount`. `charge.currency` is selected at line 20 and
never read. Two consequences, both from the same line: values like 1999 cents divide to a
number with no exact binary representation, and a zero-decimal currency (JPY, KRW — charged
in whole units) is refunded at one hundredth of face value. Money arithmetic in floats is a
defect in the ordinary sense; the discarded currency column is the corroborating evidence.

**5. `missing-await-ledger-write` — lines 37-41 (concurrency)**
`appendLedgerEntry` is changed to `async` in this same diff — the `ledger.ts` hunk is the
other half of the evidence — and the call site here is not awaited. Two consequences:
`await conn.release()` on line 45 runs while the insert is still in flight, and a rejection
from the insert becomes an unhandled promise rejection rather than reaching the caller.
The diff itself contains both sides, which is what makes this checkable without running
anything.

**6. `unreleased-connection` — line 18 (resource)**
`const conn = await db.acquire()` is outside any `try`/`finally`, and `conn.release()`
appears exactly once, on line 45, on the success path only. The early
`return { ok: false }` on line 25 returns without releasing, and any throw between line 18
and line 45 does the same. The evidence is the single release site against the multiple
exit paths above it.

**7. `swallowed-refund-failure` — lines 47-53 (error-handling)**
`refundOrderSafely` wraps `refundOrder` in `try { … } catch { return { ok: true } }`. The
catch is empty of handling, discards the error object entirely, and returns the same shape
a successful refund returns — so no caller can distinguish a refund that happened from one
that threw. The comment on the line above (`// The customer has already been told the
refund went through.`) states the rationale, and that rationale is the defect: it makes the
gateway failure invisible instead of making it recoverable.

### `src/billing/ledger.ts`

**8. `ledger-diverges-on-insert-failure` — lines 16-22 (data-integrity)**
`balances.set(...)` mutates the in-memory map on line 17, then `await conn.query("insert
into ledger …")` runs on line 18. There is no `try`/`catch`, no compensating delete, and no
transaction around the pair. If the insert rejects, the map keeps the mutation and the
table does not receive the row, so the process's balance is permanently ahead of the
table's with nothing to detect it. The evidence is the ORDER of the two statements plus the
absence of any rollback between them.

### `src/billing/refund-notice.ts`

**9. `n-plus-one-notice-queries` — lines 12-14 (performance)**
Two `await db.query(...)` calls sit inside `for (const row of rows)`, each awaited
separately, so query count is `2 × rows.length` and the round trips are sequential rather
than concurrent. Both queries are keyed by a single column (`order_id`, `email`) and would
be one set-based query each outside the loop. The evidence is the loop body: the awaits are
inside it and the keys are per-row scalars.

**10. `card-number-in-notice-log` — line 15 (privacy-a11y)**
`console.log` writes a template string containing `row.email` and
`customer[0]?.card_number` in plain text. That is cardholder data written to whatever sink
the process's stdout goes to, retained for that sink's retention period, outside any
tokenisation or masking. The evidence is on the line: the field is named `card_number` and
it is not masked, hashed or truncated.

**11. `inaccessible-notice-markup` — lines 26-28 (privacy-a11y)**
`renderNotice` emits `color:#9a9a9a` on `background:#a4a4a4`. Those two greys have a
contrast ratio of roughly 1.1:1, against the 4.5:1 minimum for body text — a ratio anyone
can recompute from the two hex values, which is why this label needs no judgement call. The
`<img src="/refund-complete.png">` on the next line carries no `alt` attribute, so a screen
reader announces the file name or nothing. Two defects in one locus, and the label covers
the locus.

**12. `untested-notice-batch` — lines 10-11 (tests)**
`notifyRefunds` sends irreversible customer email in a loop, and the change ships no test
file for this module at all — the diff adds three files and none of them is a test. The
evidence is the file list of the change itself. The untested behaviours are not marginal:
the batch, the empty batch, and a partial send where the loop throws after some mail has
already left.

**13. `notice-renderer-takes-unused-charge` — line 24 (maintainability)**
`renderNotice(row: NoticeRow, charge: unknown)` never reads `charge` — the body uses only
`row.amountCents` and `row.orderId`. The parameter is what forces the caller to run the
per-row `select * from charges` on line 12, so an unread argument is the direct cause of
defect 9's first query. The module also queries, logs, mails and renders, and the next
change has to unpick all four. The evidence is the body: `charge` appears in the signature
and nowhere below it.

---

## Note on defects 9 and 13

They interact and they are still two labels. Deleting the unused `charge` parameter removes
one of the two per-row queries; it does not remove the other, and it does not make the loop
set-based. A model that reports only the unused parameter has found 13 and not 9. Where a
single finding genuinely makes both claims, the greedy matcher in
`fixtures/seeded-defects/adjudicate.ts` credits the first defect in declaration order and
leaves the finding claimed — it never counts one finding twice.
