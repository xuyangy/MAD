---
id: PROTOCOL-mad-evaluation-v2
status: draft
version: 2
frozen_on: null
frozen_hash: null
supersedes_on_freeze: PROTOCOL-mad-evaluation-v1
governs: Epic 2 (live review evaluation)
companion_of: SPEC.md
decided_by:
  - "2026-09-15 — review channel (window 2, deciding in the human's place): no new billing.
    A draft protocol v2 proposes CAP-1 and CAP-11 as secondary descriptive endpoints read
    from each paired block's shared discovery prefix."
  - "2026-09-25 — review channel (window 2, deciding in the human's place), story 2-8c3a: no
    new billing. The draft adds A6–A11: on the OAuth route only, the budget unit becomes the
    admitted attempt, the cost endpoint becomes newly issued MAD attempts, the
    physical-request invariant is amended, and the unknown-usage halt is replaced. Freezing
    stays the human's."
---

# Evaluation protocol — Epic 2, version 2 (DRAFT)

> **This is a DRAFT. It is not frozen and it pre-registers nothing.** Protocol v1
> (`evaluation-protocol.md`, frozen 2026-09-10) stays in force, unchanged, and every paired
> schedule sealed so far hashes v1. This document proposes an amendment. It becomes a
> pre-registration only when it is frozen: `status`, `frozen_on` and `frozen_hash` filled, and
> a data-exposure statement current at that date. Freezing is a human decision.
>
> This draft numbers its own sections A1–A11 so they never collide with v1's. A citation of
> the frozen protocol reads "v1 §n". A1–A5 add the prefix endpoints; A6–A11 add attempt-mode
> accounting for the OAuth route.

## A1. What this amendment changes, and what it does not

Protocol v1 registers one primary quantity (precision difference), one guardrail (final
recall), secondary verdict-transition and cost diagnostics, and the 2.7 adversarial
endpoints. It registers **neither CAP-1 pooled recall nor CAP-11 lens gain**, and its
allowance table (v1 §4) and delegation table (v1 §7) give story 2.6 no allowance and no
delegated scope.

This draft adds **two secondary descriptive endpoints**, both read from data the planned
paired blocks already produce. It adds no billing, no allowance, no block and no arm.
v1 §1–§8 carry over unchanged except where A2–A11 say otherwise. A6–A11 bind only a
schedule sealed for the OAuth route; the api-key route keeps v1's token unit and every v1 rule
A6–A11 amend.

## A2. The endpoints

Both are read from each paired block's **shared discovery prefix**: the prefix run's
`record.json`, under `prefix/<block - 1>/<prefix run id>/`. That record holds the only
unmutated discovery pool; each arm's manifest pool is a clone that debate and judge touched
after the fork. Both are scored against the sealed labelled change's planted labels with the
shipped lexical matcher, one finding per defect.

**CAP-1 — within-prefix attribution.**

- *Estimand.* In one discovery pass, the number of planted defects the union of the answered
  pool slots' findings covers, against the number the best single answered pool slot covers.
- *What it is not.* It is not an independently executed single-model run. A slot's findings
  were produced beside the other slots in one pass, under one budget and one clock.
- *Reported.* The union, each answered pool slot, and the best answered pool slot by name, as
  `x of 13` with defect ids; the union minus the best. The difference is nonnegative by
  construction.

**CAP-11 — lens-only defects.**

- *Estimand.* In one discovery pass, the planted defects answered lens slots raised that no
  answered pool slot raised.
- *What it is not.* It is not a causal run effect. It does not say what a run without lenses
  would have found.
- *Reported.* The lens-only defects as `x of 13` with ids, over `n of m` lens slots answered;
  each lens's own count. Nonnegative by construction.

Neither endpoint says anything about precision. Neither is a gate, and neither carries a
threshold (v1 §6 stands).

## A3. "Across arms", reconciled

The epic's 2.6 criterion asks each comparison to use "the same findings population at the
same stage across arms (FR6)". Under the paired design (v1 §2) both arms continue ONE
prepared review, so their discovery populations are identical by construction and a
cross-arm discovery-recall comparison is identically zero. The comparison the criterion
needs is therefore **source-derived discovery attribution inside one prefix**: pool slots
against the pool union (CAP-1), lens-sourced findings against pool-sourced ones (CAP-11),
partitioned on the recorded `Finding.author` and `Finding.source`. No aligner is used, and
no independently executed single-model or no-lens run is implied.

Each arm's **upheld** findings are reported separately, per arm, as planted-label matches and
`U` (upheld findings no planted label claims, unmatched duplicates included). That is final
correctness material, kept apart from discovery recall (v1 §3). Verdict-direction labels and
false-positive counts need blind adjudication and are story 2-6b's; precision and cost
contrasts are story 2.8's.

## A4. Rules that decide what is computable

- **Answered slots.** Pool slots minus discover-stage `model-dropped-out` slots minus
  `skippedForBudget`. Their count must equal the record's `answered`; every pool finding's
  author must be an answered pool slot; every lens finding's author an answered lens slot.
  A mismatch withholds the affected endpoint. Contradictory slot evidence is a mismatch. A
  salvaged answer counts as answered and is disclosed.
- **Unanswered slots** are listed with their reason, never scored as 0. Zero answered pool
  slots: no best member and no comparison, and CAP-11 has no baseline. No lens slot, or zero
  answered lens slots: CAP-11 unavailable. A record cancelled at `discover`: lens coverage
  unknown, CAP-11 withheld.
- **Partial coverage, for the prefix endpoints.** A dropped or skipped slot makes the block a
  partial diagnostic for CAP-1 and CAP-11, reported with both coverages and kept outside their
  summary.
- **Summary.** Per quantity: observed `n/3`, each missing block's reason, and mean, min and max
  over complete observations only, labelled *descriptive over n available observations, not
  the planned three-block result*. One observation: spread unavailable. Zero: unavailable. The
  per-arm upheld-match counts count every block the paired reader measured. The two arms of a
  block share one prefix, and that prefix is one observation of CAP-1 and CAP-11; two blocks
  naming one prefix run are counted once, as a defensive check.
- **Seal and protocol.** Scoring applies only to a schedule whose fixture equals the sealed
  labelled change in version, material hash and labels hash, with every bound arm's fixture
  hash equal to the material hash and its protocol identity equal to the schedule's. Anything
  else is refused with the field named.

## A5. Roster, budget, freezing and data exposure

- **CAP-11 needs lens slots in a newly sealed roster.** A schedule seals its roster. A block
  run over a pool-only roster yields CAP-11 unavailable, and no existing schedule can be
  changed to add lens slots.
- **Billing.** Lens slots are discovery turns inside the shared prefix. They are billed inside
  the existing **60,000** prefix allowance of each block (v1 §4), under the same admission
  gates. No allowance is added or moved. No feasibility is claimed for lens slots inside the
  60,000 prefix allowance: lens slots may be budget-skipped, which leaves CAP-11 partial in
  those blocks.
- **Freezing needs a newly sealed schedule.** A schedule binds the hash of the protocol file it
  was sealed under. A schedule sealed under v1 stays a v1 schedule, and results read from it
  are descriptive, never v2-preregistered. Freezing v2 means filling this header, and sealing
  a new schedule under the frozen v2 file before any block of that schedule runs.
- **Data exposure at drafting.** A search of `/Users/xuyangy`, `/private/tmp` and `/tmp` on
  2026-09-15 found no paired bundle file, and `MAD_ARTIFACTS` was unset. Beyond that search,
  exposure is **not established**. The scripted fixture outputs had been seen: CAP-1 7 of 13
  pooled against 3 of 13 per member, and a nonzero lens-only count on the seeded change.

## A6. Attempt-mode accounting: what it changes, and where

The planned roster signs in through opencode's own OAuth sessions. On that route MAD holds no
provider credential and has no relay between the host and the provider, so it cannot measure a
request's tokens, and v1's token-denominated gates, halt and cost endpoint cannot be applied.
A6–A11 define a second accounting mode, **attempts**, for a schedule sealed for the OAuth route
(`route: oauth`, `accounting: attempts` in its config). A schedule on the api-key route keeps
v1 §4 exactly: the ledger-token unit, `PAIRED_ALLOWANCES`, the unknown-usage stop rule and the
token cost endpoint. Precision (v1 §3), final recall and every other endpoint are unchanged in
both modes.

**The unit.** One *admitted attempt* is one `runTurn` that passed both its stage's ledger gate
and the experiment's admission and was issued, retries included. An attempt refused at
admission writes no journal line and counts 0. An attempt admitted and then not issued (the
run was cancelled before `runTurn`) is settled `not-issued` and counts 0. An attempt is not a
debate round: a round fans out to several seats and the OFF arm has no rounds, so a round can
neither compare the arms nor cap them.

## A7. The budget unit, on the OAuth route

Replaces v1 §4's token allowances for an attempt-mode schedule.

- **Per block:** the shared prefix gets 2×(3+L) attempts with L lens slots; the remainder of
  100 is split equally between the ON and OFF continuations. With L = 2 (the shipped
  `security` and `reliability` lenses) that is **10, 45 and 45**.
- **Blocks:** 300 for the three blocks. **Global:** 300.
- **Admission thresholds, not bills.** Each test is `spent < limit`, counted over attempts in
  every issued state (settled, unknown, in flight, uncertain). Attempts already in flight when a
  threshold is reached may overshoot it, so 300 is not a hard realised maximum unless admission
  is serialized. The overshoot is reported and never borrowed from another allowance, and the
  report states the realised count.
- 300 is a chosen cap, not an evidence-based adequate budget. A block that reaches it is
  truncated and reads as incomplete, never as measured.
- Each run carries no token cap and does not stop on unknown usage; the ledger's own stop rule
  is unchanged and simply not turned on. Host-reported tokens are unverified diagnostics: they
  are kept per attempt with their source, and excluded from admission, caps, completeness and
  every cost contrast.

## A8. The cost endpoint, on the OAuth route

Replaces v1 §4's *Actual cost* for an attempt-mode schedule.

- **Newly issued MAD attempts:** per block, shared prefix + ON continuation + OFF
  continuation, each admitted attempt counted once and the prefix once. `not-issued` attempts
  are excluded.
- **The contrast** is ON − OFF over the continuation attempts only. It is unavailable while
  either continuation did not complete, because a truncated continuation would read as a
  difference.
- Attempts are reported by stage, slot and model (read from the manifest roster), with retries
  (`attempt > 1`) apart, and every figure names where it was read from. They are read from the
  persisted journal, replayed and validated as a whole; a journal that is incomplete, conflicted
  or mixed-mode yields no figure.
- **What it is.** A workflow-use contrast. It is never token cost, money, subscription quota or
  a physical request count, and no attempt is equated with any number of tokens. The report
  states that token spend and subscription quota are unmeasured on this route. Subscription
  exhaustion and failed attempts stay visible outcomes.

## A9. The physical-request invariant, amended

v1 §4 requires every billable request to pass its stage gate and every experiment gate, with no
additional host or provider retry unaccounted for. On the OAuth route every **MAD attempt**
passes the stage's gate and the experiment's gates before it is issued. The host's own work
inside an attempt — its retries, tool steps and requests held open — is **not gated and not
counted**, and the report discloses it as unmeasured. MAD adds no retry of its own beyond v1's
one per request. The claim that every physical request is gated is not made on this route.

## A10. The unknown-usage halt, replaced

v1 §4's *Stop rule on unknown usage* does not apply on the OAuth route: a missing token figure
does not stop admission, because the attempt count is exact either way. It is recorded as a
diagnostic. Admission still **halts**, latched and recorded in the halt marker, and does not
resume automatically, on:

- an integrity failure in the journal;
- an attempt issued by an earlier invocation and never settled, whose ending is not
  established;
- an attempt that did not end within its bound (a timeout, a cancellation after the request
  went out, or a `runTurn` that threw), since a held-open request may still consume quota.

Each halt is worded operationally and never implies unknown spend. Separately, a failed
persistence of an admission or a settlement is a **runner stop**, as in v1: the runner admits
nothing further in that invocation and names the failure, but it is not a halt, writes no halt
marker, and carries no attempt-mode wording. *Complete* on this route means
every slot completed, with no halt, no stop, and nothing uncertain or in flight; an unknown token
figure does not make a block incomplete.

## A11. Freezing A6–A11, and data exposure

- **Before any OAuth-route schedule is sealed,** v2 is frozen with a data-exposure statement
  current at that date. A schedule sealed under v1 is never read under A6–A11.
- **The gates.** The OAuth route is required to pass its own attempt-accounting gate, closed only
  on zero-bill probe evidence or, for a transport that cannot be probed without billing, on a
  separately authorized bounded pilot reviewed before the evaluation; never on the paid
  evaluation itself. The evaluation spend authorization is restated in attempts for this route.
- **Data exposure at drafting (2026-09-25).** No paired bundle on the OAuth route exists: no host
  route selects it, and no outcome data was seen for A6–A11. The v1 exposure statement in A5
  stands for everything else.
