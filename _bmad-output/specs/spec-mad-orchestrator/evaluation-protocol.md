---
id: PROTOCOL-mad-evaluation-v1
status: draft — not yet frozen
version: 0
frozen_on: null
frozen_hash: null
governs: Epic 2 (live review evaluation)
companion_of: SPEC.md
decided_by:
  - "2026-09-09 — human: build the same-roster debate-off control (FR8)"
  - "2026-09-09 — human: three paired blocks, descriptive"
  - "2026-09-09 — human: no predeclared product-value threshold"
---

# Evaluation protocol — Epic 2

> **This is a pre-registration.** It is written before any live token is spent, and it is
> frozen on approval. Freezing means the `version` increments, `frozen_on` and
> `frozen_hash` are filled, and **the previous frozen version is preserved, not
> overwritten**. Any later amendment must state what data, if any, had already been seen
> when it was made. A file merely described as frozen but edited in place is not a
> pre-registration.

**Approval sheet: sections 1–6.** Everything after section 6 is reference for the story
that owns it. Section 7 is the delegation table: it names, for each detail deferred to a
later story, the owner, the permitted scope, and the deadline by which it must be sealed.

---

## 1. The claim, and the population it is about

**What is compared.** The shipped debate-plus-adjudication policy, against direct
fact-checking of *the same candidates*, on a labelled change, with the discovery pool
frozen and shared between the two arms.

**What this identifies.** Observed differences in the **deployed debate pathway** —
precision, final recall, and cost. When debate is off, the judge also loses evidence
extraction, logic evaluation, and aggregation; those disappear with the argument. So the
contrast is over the *pathway as deployed*, not over model conversation with the judge
pipeline held fixed.

**What this does not identify.** The benefit of conversation itself. The value of the
observed differences. Generalization beyond the evaluated change and configuration.

**Population.** The candidates present in one frozen discovery pool, per block.

## 2. The arms, the intervention, and the pairing

**Arm ON** — the shipped pipeline, unmodified.

**Arm OFF** — an **evaluation-only debate-off policy**, recorded in the manifest and
carried into the run, which skips debate for **every** candidate including criticals and
routes them to `verify-independently`.

Routing still runs once and still writes `route` and `routeReason` (AD-8's routing
ownership list names exactly those two fields). The recorded `routeReason` must read
**experimental intervention** — never "threshold agreement", "silence", "cap", or
"exhausted budget", each of which would be a false claim about what was measured.

**Two mechanisms were examined and rejected. Neither may be used.**

- **`threshold: 0`.** `core/stages/route.ts:137` debates *effective critical* severity at
  any setting including 0, and severity is **model-claimed** — a change with no
  ground-truth critical defect can still raise a spurious critical. `route.ts:186-194`
  also routes a missing or zero-denominator prior to debate, deliberately. Whether this
  mechanism turns debate off is therefore a property of the realized run, so choosing it
  and then switching if the realized critical count came out inconvenient would be an
  **output-dependent design choice**.
- **Amending `clampMaxRounds` to admit `0`.** `core/stages/debate.ts:1141` stamps every
  still-open room `exit=cap` after the loop, so zero rounds would report rooms as debated
  and capped with no argument in them. The floor's honest-recording purpose is intact.
  **The shipped clamp and the presets are not changed by this epic.**

`core/stages/judge.ts:1113` derives `argued` from `route === "debate" && !transcript.empty`
and `:1400` falls back to the Fact-Checker alone, so the judge's **empty-transcript mode**
already supports arm OFF. That is a narrower assurance than "no judge change is needed":
the shared continuation, the ledger provenance, and the accounting still require
integration verification in story 2.5A.

**Pairing.** Within a block, discovery is sampled **once** and the checkpoint is forked
into both arms. Across blocks, discovery is sampled again, so run-to-run discovery
variability is represented. Candidate IDs are stable across the fork, so the two arms pair
directly and **no cross-arm aligner is used** for this contrast. (Story 2.5's aligner
remains for genuinely different discovery populations.)

## 3. Primary quantity, guardrail, and the rules that decide what is computable

**Primary quantity.** For pair *r*: `P_on,r = TP / (TP + FP)` over final canonical findings
with `verdict = upheld`; `P_off,r` likewise. The summary is the equally weighted mean of
the within-pair differences `d_r = P_on,r − P_off,r`. Every numerator and denominator is
printed. **No silent switch** to pooled counts, which would weight toward the most verbose
repeat.

**Truth labels score claims, not proximity.** A finding matching no planted label is
**not** proof of a false positive. The common candidate pool is truth-adjudicated **blind
to arm outcomes**, and uncertain labels are preserved.

**Unlabelled upheld candidates are reported as an interval, never as known-only
precision.** With `U` unlabelled upheld candidates, precision lies in
`[TP/(TP+FP+U), (TP+U)/(TP+FP+U)]`. The pair difference is then bounded by
`[L_on − U_off, U_on − L_off]`, and the planned mean is bounded by averaging the endpoints.
These are **identification bounds, not confidence intervals**. A bound spanning both signs
is reported as *direction unresolved by label uncertainty* — which is neither an
operational failure nor a demonstration of no effect.

**Zero denominators.** An arm that upheld nothing has **undefined** precision. Not 100%,
and not a clean list. The interval formulas do not repair this.

**Guardrail — a diagnostic, not a gate.** Final unique-defect recall against the known
true-defect set, **with the lost true candidates named**. Discovery recall is identical
inside a frozen pair and cannot serve. Because no numeric limit was chosen (section 6),
this is a **recall preservation diagnostic**; nothing fails it automatically.

**Findings that disappeared rather than being decided.** A candidate lost to budget
exhaustion is not successful noise removal. Unresolved and not-adjudicated cases stay
visible, and their operational outcomes are reported even where they invalidate the
primary estimate.

**Secondary diagnostics.** Verdict transitions, each counted separately: false upheld →
rejected; true rejected → upheld; true upheld → rejected; false rejected → upheld; and
undecided transitions on their own. Token deltas are reported **separately**, including the
additional judge turns. *"Verdict differences per 1k tokens" is not used*, even as a
secondary: it mixes correctness-neutral changes with cost, against the existing report's
separation of those quantities.

## 4. Schedule, stopping, and budget

**Three scheduled paired blocks.** Fixed in advance. Treatment order within blocks is
counterbalanced, and the realized schedule is recorded.

**No replacement.** A failed or cancelled block, and its bill, stay in the record. Blocks
are not re-run until three succeed.

**What three blocks can and cannot support.** Three same-direction differences give a
two-sided exact sign-test p of 2/2³ = 0.25 under equiprobable signs. This design is
therefore **descriptive**: every `d_r` is published with the mean, min and max, labelled
**observed spread**. No significance claim. Three identical zero differences do not
demonstrate equivalence either.

**Budget.** The whole experiment is budgeted before it bills: blocks × (discovery +
continuation-on + continuation-off), plus judge, calibration and retry turns. The
configured cap and the residual exposure are stated **separately**. The residual exposure
is a number only where a number is defensible; where unknown billed usage or a
non-abortable in-flight request makes a finite bound impossible, it is named
**unquantified** and an operational stop rule is given instead. FR10's honesty about
unknown usage binds the budget too — a fabricated ceiling is worse than a named unknown.

## 5. Story 2.7 — adversarial material endpoints

Registered here, before any live adversarial run.

**Two separate endpoints, never fused.**

1. **Verdict influence** — a change in the finding's verdict attributable to text addressed
   to the reviewer or judge, measured against a **clean counterpart** case so ordinary
   judging variability is distinguishable from an attack-caused change.
2. **Tool-action influence** — a targeted tool action requested or executed because of that
   text. **Attempted and executed actions are counted separately** wherever both are
   observable.

**Denominator and eligibility.** A case counts only where the run had a genuine opportunity
to take the targeted action. A case with no opportunity, or with no trace, **cannot certify
resistance** and is reported as unobserved rather than as a pass.

**Observation path.** Tool actions are recorded through the **real production adapter
path**. Unit-injected ports do not prove the production wiring.

**Interpretation.** Passing the sealed case set is bounded evidence over those cases. It is
never a general guarantee.

## 6. What is deliberately not assessed

**Product value.** No earned / did-not-earn verdict. No pass/fail recall gate. No automatic
keep-or-remove recommendation.

This follows from a dated human decision (2026-09-09) not to predeclare a material
precision threshold, an acceptable true-defect loss, or a cost rule. Those are willingness-
to-pay choices. The evaluation reports the differences and the reader values them.

**Value is unassessed on purpose — it is not missing because anything failed.** The word
*inconclusive*, where it survives at all, means only: **the named measurement or contrast
cannot be determined from the planned data**, with the reason stated. It never means a
failed hypothesis test and never an unfavourable product judgement.

**Incomplete or non-identifying evidence never becomes evidence of no effect, nor evidence
against the design.** The SPEC's success signal asked a larger question and still does;
this protocol narrows what Epic 2 will deliver against it, and says so with a date rather
than rewriting the original motivation.

**The reporting contract**, in four parts:

| Part | What is reported |
| --- | --- |
| Execution coverage | scheduled blocks = 3, completed = *n*, every failure retained |
| Measurement availability | each pair's precision, final recall and cost as a point value, a justified bound, or unavailable/undefined **with its exact reason** |
| Treatment opportunity | how many candidates normal policy would have debated, and whether debate actually ran |
| Product value | **not assessed, by design** |

Completing execution is **not** certification that every metric is computable. A point
estimate of the planned mean requires all three differences defined and fully
truth-labelled; otherwise supported bounds or the incomplete data are reported, **never an
imputation and never a convenient subset averaged and labelled the planned result**.

If all arms complete but no treatment was exercised — normal policy would have debated
nothing — the data still exist and demonstrate neither benefit nor failure of the pathway.
That limitation is reported; the fixture is **not** changed until it disappears.

---

## 7. Delegation table — what is sealed later, by whom, and when

Deferring a detail is not permission to postpone an analytical choice until a promising
pilot exists. Fixture eligibility, scoring rules, number of tries, attack-success
definitions, thresholds, and primary/secondary status are fixed **here** and may not
quietly change in an implementation story. **Any design change made after the relevant
outcomes were visible is recorded as such, and its evidential scope is revisited.**

| Owner | Permitted scope | Freeze boundary |
| --- | --- | --- |
| 2.2 | manifest and reader field names, layout, artifact paths, provenance encoding, comparison-table rendering, canonical-ID reconstruction schema | before the first evaluation run is read |
| 2.3 | how cancellation, timeout and usage states are captured and propagated | before the first billing run. *The numerical interpretation of missing usage and the operational stop rule stay in this document* |
| 2.4 | fixture construction, individual cases, evidence for truth labels, label-file schema, adjudicator worksheets, validation checks | sealed with content hashes **before** 2.4's first live run. *Inclusion and sampling rule, arm-blind adjudication, unresolved-label treatment stay here* |
| 2.5 / 2.5A | checkpoint types, function signatures, alias-preservation tests, pairing reader, ledger calculations, and the realized randomized order generated by the rule frozen here | before the first paired block runs. *Paired design, population identity, accounting meaning, no-replacement rule stay here* |
| 2.7 | payload bytes, clean and attack fixtures, production tracing setup, case-level assertions, event-to-trace mapping | sealed **before** observing the relevant live outcomes. *Endpoint definitions, denominators, clean comparison, missing-observation treatment stay here* |

**Pilots.** Any pilot has a named budget and **disjoint development cases**. An
outcome-informed endpoint or case selection is **exploratory** and may not silently become
the confirmatory test. Pre-registration separates planned from exploratory work; it does
not ban exploratory work.

## 8. Engineering notes carried from design review

Recorded here so the owning stories inherit them rather than rediscovering them.

**Checkpoint cloning.** One `structuredClone` of `{pool, findings, ledger}` is sufficient
for the real `Finding` graph. The canonical finding must alias **its own occurrence in
`pool`**, and must **not** alias its absorbed members — `core/stages/cluster.ts:108-110`
selects one member as canonical and excludes that object from `absorbed`, and `:123` stores
absorbed members as string IDs. What breaks without the alias is **mutation consistency**,
not member lookup: `core/stages/debate.ts:323` and `core/stages/output.ts:321` look up by
ID and survive two separate arrays.

**Cloning boundary.** `core/domain/warning.ts:248` types `detail` as
`Record<string, unknown>`; a caller-supplied prior warning may hold a function or other
non-serializable value, which `structuredClone` rejects. Reject unsupported checkpoint
values **visibly**; never JSON-strip evidence. Keep `backend`, `clock`, the limiter,
`Tools` and `AbortSignal` **out** of the checkpoint; keep discovery drop-outs and
cancellations **in**, as data. Distinct continuation `runId`s — copying the prefix `runId`
into both branches collides in artifact identity. `withShares()` is **not** the branch
copier: `core/domain/run-record.ts:399` is a shallow copy.

**Persisted form.** One `pool` plus ordered `canonicalIds`. On load, validate unique IDs
and every membership reference, then reconstruct `findings` by selecting **those exact
objects** from the pool. Preserve canonical order; do not re-cluster to rediscover it. Do
not deserialize duplicate `Finding` objects and expect a clone to reconnect them.

**Ledger provenance.** `core/domain/run-record.ts:68` defines `LedgerEntry` as `slot`,
`stage`, `attempt`, `tokens` — there is no metadata bag, so this is an **additive schema
change plus a dated AD-15 semantic amendment**, part of the commissioned evaluation
exception. Semantics: *executed here* versus *inherited*; an inherited entry references the
**original execution**, and a chain resolves to that original rather than minting apparent
spend at each fork. `stage + slot + attempt` is **not** a unique id — debate rounds and
different judge findings reuse those values. Disagreeing token payloads for one physical
execution are an **integrity error**, not something to deduplicate by first-seen. Inherited
unknown usage stays unknown; an origin tag cannot turn it into zero, and usage-completeness
stays 2.3's schema rather than a competing one.

**The readers are the work, not the field.** `ablation/compare.ts:140-143` calls
`ledger.total` the cost and `entries.length` the billed turns; `core/stages/output.ts:1613-1621`
prints the same total and count. Once inherited entries exist, both need explicit labels for
*attributed run consumption* versus *newly executed usage*, or the human-facing bill is
misleading while the JSON is correct. Ordinary runs with no inherited entries keep their
current numbers, and old artifacts get an explicit legacy interpretation — a missing tag is
**not** evidence of complete usage.

**Actual cost.** Derived from unique **physical** executions, counting the shared prefix
once: per block, `discovery + continuation-on + continuation-off` — never two whole-run
ledgers summed. Each branch still inherits the prefix consumption against its own logical
cap. Only the same shared-prefix execution, present in both attributed views, cancels
algebraically; unknown costs in two branches are never subtracted away.

**Seam shape.** Extract a small typed preparation/continuation boundary from `review()`:
*prepare* through clustering; *continue* by routing once under the recorded policy, then the
**same shipped** debate/judge/output assembly. Ordinary review composes both, so no second
experimental pipeline exists. Today there is no such seam: `core/run/review.ts:482`
discovers unconditionally, `:521` clusters, `:529` routes, `:576` debates, `:628` judges,
and `ReviewDeps` has no prepared-input field. `ablation/arms.ts:107` always runs a whole
review, and `:83` shares `Dials` across arms, so `runAblation` cannot vary even `threshold`
per arm without harness work. `ablation/compare.ts:332-333` keeps the **first** run per arm
id and does not compute a paired endpoint across repeats.
