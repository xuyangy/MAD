---
id: PROTOCOL-mad-debate-variants
status: frozen
version: 1
frozen_on: 2026-11-19
frozen_hash: sha256:c7f7ee681c49b71f47591cc465f3e3d94bf44c905a57003a64192e65a81908ec
governs: the debate-variants comparison of ablation/DEBATE-VARIANTS.md (baseline, references, open questions)
companion_of: SPEC.md
decided_by:
  - "2026-11-19 — the human, typed as the argument of `/backlog-bridge-loop` in the Claude Code session of
    2026-11-19: draft this protocol from ablation/DEBATE-VARIANTS.md, with the variant allowances as literals,
    for the human to review and freeze; do not freeze it or pin VARIANT_PROTOCOL. This file is that draft.
    Freezing it, pinning it and authorizing a run remain the human's decisions."
  - "2026-11-19 — the human, typed as the argument of `/backlog-bridge-loop` in the Claude Code session of
    2026-11-19: \"I approve the draft as written: freeze
    _bmad-output/specs/spec-mad-orchestrator/debate-variants-protocol.md (status frozen, frozen_on today,
    frozen_hash by the reader's rule) and pin its version and hash in VARIANT_PROTOCOL in
    ablation/paired-gates.ts — do not close gate 14\". This records that freeze. It authorizes no spend:
    gate 14 stays OPEN."
---

# Debate-variants protocol — version 1

> **This protocol is FROZEN at version 1 as of 2026-11-19, with every number and rule as drafted.
> The freeze authorizes nothing.** `VARIANT_PROTOCOL` in `ablation/paired-gates.ts` pins this
> version and `frozen_hash`; a run still needs the budget owner's authorization (3. below), and gate
> 14 is OPEN.
>
> **Freezing, pinning and authorizing are three separate decisions, all the human's.**
>
> 1. **Freezing** sets `status: frozen` and a `frozen_on` date in this file and computes its
>    `frozen_hash` by the reader's own rule: the `frozen_hash:` line is replaced by the literal
>    `frozen_hash: PENDING`, nothing else altered, and the file's bytes are hashed with SHA-256; the
>    result, written as `sha256:<hex>`, is the value recorded. After the freeze, any change is a new
>    version, never an edit in place.
> 2. **Pinning** records that version and `frozen_hash` in `VARIANT_PROTOCOL`, in a reviewed,
>    committed change to `ablation/paired-gates.ts`.
> 3. **Authorizing** is the budget owner closing gate 14 for the one run `VARIANT_EVALUATION_RUN`
>    names. The launcher then reserves that run exclusively
>    (`ablation/evidence/debate-variants-evaluation-run-1.reservation`) before any host or relay
>    starts. Freezing this file is not that authorization, and neither is pinning it.
>
> Sections are numbered D1–D10 so they never collide with the evaluation protocols' §n, An or Bn.

## D1. Scope

This protocol binds **only a debate-variants schedule**: a `paired-schedule.json` of schedule version 2
and design `debate-variants` (`ablation/variant-schedule.ts`), sealed for the **api-key route**, in
**token accounting**.

- Protocols v1, v2 and v3 (`evaluation-protocol.md`, `evaluation-protocol-v2.md`,
  `evaluation-protocol-v3.md`), and every schedule or journal sealed under them, are untouched and are
  not reinterpreted. A routing (ON/OFF) schedule never binds this protocol, and a debate-variants
  schedule binds no other (`routingProtocolProblem`, `variantProtocolProblem`).
- Attempt accounting and the OAuth route are not defined for this design. A schedule or a launch that
  names either is refused.

## D2. The arms, and the intervention

Each block's shared prefix (discovery and clustering) is forked into three continuations that differ
only in two debate options. All three run under the shipped routing policy.

| Arm | Routing policy | `debateReferences` | `debateMissingEvidence` |
|---|---|---|---|
| `baseline` | `shipped` | false | false |
| `references` | `shipped` | true | false |
| `open-questions` | `shipped` | false | true |

- **references**: each debate entry carries a MAD id; a speaker who changes position is asked to cite
  the earlier entries that changed it; MAD records which citations were valid and flags a change with
  none; the judge and the report see those recorded facts.
- **open questions**: a speaker may list facts it could not check as questions. Of the model
  prompts, only the Fact-Checker's carries them; the report also renders the recorded questions.

The mapping is sealed into the schedule's config and every arm's manifest records the options it ran
with; a reader holds both to this table.

## D3. The change and the labels

- **The change** is the seeded change (`SEEDED_CHANGE`, `fixtures/seeded-defects/material.ts`), whose
  diff hash is `sha256:cea5679939f5cb4ccd90230a4eddde861119f375ced04cad474fc2b0ec57e213`. It is never
  read from the reviewed worktree.
- **The fixture seal** is `labelled-change-1`: material hash
  `sha256:76523deb36aee41eb6ce9aaf1f9a51efbde5b404f839b1b20483016968fd848d`, labels hash
  `sha256:8e95a53afd7ef9216715f90e9a6f28b34c6b60ecca3bff1882eefb83b8a75105`.
- **The labels** are the 13 planted defects (`SEEDED_DEFECTS`). The answer keys are never inside the
  reviewed worktree.

## D4. The schedule

- **Blocks:** exactly **3** blocks and **9** scheduled continuations (three per block). This
  instantiates the design's minimum of three blocks; this schedule format fixes it.
- **One prefix per block:** each block runs one shared prefix, forked into the block's three
  continuations; no prefix is shared across blocks.
- **Order:** one byte from the platform's cryptographic generator, drawn again while it is 252 or
  more; the draw is `d = byte mod 12`, an integer from 0 to 11, which picks one of the twelve 3×3
  Latin squares. Number the arms in their base order baseline = 0, references = 1, open-questions = 2.
  Block 1's order is permutation number `⌊d/2⌋` (counted from zero) of the six orders of those
  indices listed lexicographically: (0,1,2), (0,2,1), (1,0,2), (1,2,0), (2,0,1), (2,1,0). The direction
  `d mod 2` sets the other blocks: 0 rotates block 1's order one place left for block 2 and two for
  block 3; 1 rotates it two places left for block 2 and one for block 3. Each arm runs once in each
  block and once in each position. Example: draw 0 gives block 1 baseline, references,
  open-questions; block 2 references, open-questions, baseline; block 3 open-questions, baseline,
  references.
- **Sealed before admission:** the schedule is published, without overwrite, before any request is
  admitted. It binds this protocol's id, version and hash, the fixture seal, the code revision, the
  roster, the change's diff hash, every non-intervention setting, the arm options of D2 and the
  allowances of D5.

## D5. The unit, and the allowances

The unit is **ledger tokens**: input, output, reasoning, cache read and cache write, summed.

The thresholds, as literals. **These literals are the contract**, not the code constants they match
today:

| Threshold | Tokens | What it bounds |
|---|---|---|
| global | **2,585,000** | known persisted spend over every category of this bundle root |
| Blocks | **1,985,000** | known spend of the Blocks category |
| prefix | **60,000** | new consumption of one block's shared prefix |
| continuation | **195,000** | new consumption of one arm's continuation in one block |
| run cap | **255,000** | each run's own attributed `tokenCap`, enforced by the run |

- The sum of the phase thresholds is 3 × (60,000 + 3 × 195,000) = **1,935,000**. The Blocks threshold
  leaves a margin of **50,000** above it, and the global threshold a margin of **600,000** above the
  Blocks threshold.
- **Thresholds, not bills.** Every test is `spent < limit` at admission. Work is admitted before its
  final settlement, so admitted work may take spend past a threshold; the overshoot is reported and
  never borrowed from another allowance. None of these figures is a maximum bill or a hard exposure
  ceiling (D10).
- Every arm's continuation has the same limit.

## D6. Measures

Per block and per continuation, read only from a continuation whose evidence is bound to its slot
(the schedule, the block's forked prefix, the protocol, fixture, code revision, change and roster):

- **Planted-defect recall:** the continuation's upheld findings matched by the shipped matcher against
  the 13 sealed labels, counting distinct label ids found. Measured only when the schedule binds the
  seeded change of D3, by its seal fields and its diff hash.
- **Findings left unresolved**, and the verdict counts.
- **Newly issued attempts:** the continuation's own journal rows: Blocks rows of its block and arm
  with no `step` (a step is a further physical request inside one attempt) and not settled
  `not-issued`, every such row naming the continuation's run.
- **The shared prefix** is reported once per block as overhead, its attempts by the same rule and its
  executed-here tokens and unknown turns from its own record, and is never part of a continuation's
  figures or of any contrast.
- **Observed tokens:** `spentTokens(usageByOrigin(ledger).executedHere.tokens)` from the
  continuation's own record. A forked continuation's `ledger.total` includes the inherited prefix and
  is never the measure. The figure is a floor when any turn's usage is unknown, and when the ledger
  carries no unknown-usage collection (unaudited).
- **Turns with unknown usage:** `usageByOrigin(ledger).executedHere.unknown`, read only when
  `usageIsAudited(ledger)` holds; otherwise missing.
- **references arm only:** position changes, those citing at least one valid entry, those flagged
  `shiftWithoutValidReference`, and the cited share (not applicable when no position changed).
- **open-questions arm only:** questions recorded. Questions that reached a Fact-Checker prompt are
  **missing** in the current bundle reader, which has no issued-prompt evidence; any future measurement
  of delivery needs evidence of the prompts actually issued, and a recorded question never establishes
  it.
- **Precision:** from the blind adjudication sheet (`adjudication.json`, version 1): one page per
  block, bound to the block's verified prefix record, one label per canonical candidate of that
  prefix pool, no arm named. Per continuation, `TP` true defects among its upheld findings, `U` its
  upheld findings labelled `unresolved`, unlabelled, or outside the prefix pool, `N` all it upheld,
  and the interval `[TP/N, (TP+U)/N]`; `N = 0` is not applicable. The reader shows an interval for a
  partially filled page too, marked provisional (not filled).

**The blinding procedure** is upfront and procedural: the sheet is filled for each block's prefix
pool before any arm is read, by someone who does not know which arm upheld what. The reader checks the
sheet's binding (schedule, block, prefix run, candidates) and completeness; it cannot check blinding.

## D7. Handling of gaps

- **Failed or withheld block:** a variant's contrast with its block's baseline exists only when both
  continuations are bound and completed (their slot's terminal status is `completed` for that run, and
  the manifest reads as a finished run). A baseline that did not complete withholds both contrasts of
  its block; a variant that did not complete withholds only its own. A withheld contrast supplies no
  comparison to any gate and is recorded as a failure reason in each.
- **Missing metric:** reported as missing, never filled in or carried from another block.
- **Zero denominator:** reported as not applicable, never as 0 or 1.
- **Unavailable gate metric:** a measure a gate needs that is missing or not applicable in any block
  fails that gate. A gate never reads a measure it does not need.
- **Unknown usage:** a continuation with any turn of unknown usage, or an unaudited ledger, has
  incomplete token cost; its tokens are a floor and the cost gate cannot be met in that block.

## D8. Promotion

Per variant, against the baseline of its own block, in every block. Every limit is inclusive (a value
equal to its limit meets it); the improvements gate 2 asks for are strict. Fractions compare by
integer cross-products; token figures compare exactly as the decimals they are
recorded as. A variant becomes a default only if all five hold:

1. **Coverage:** at least three blocks, and the contrast eligible in every block.
2. **Recall:** in no block is the variant's recall below the baseline's; and either it is above in at
   least one block, or recall is equal in every block and the variant leaves fewer findings unresolved
   in at least two blocks and more in none. Unresolved counts are read only on that second route.
3. **Precision:** a readable sheet whose page for every block is fully filled and bound, `N > 0` for
   both arms, and in no block is the variant's lower bound `TP/N` below the baseline's. Recall alone
   never promotes a variant.
4. **Cost:** in every block both continuations have complete usage (audited, no turn of unknown
   usage), the variant's observed tokens are at most 115% of the baseline's, and its newly issued
   attempts are at most 110% of the baseline's or at most two more, whichever allows more.
5. **Unknown usage:** in no block does the variant have more turns of unknown usage than the baseline.
   Equal counts do not establish equal cost; gate 4 is what requires complete usage.

Anything else leaves the variant opt-in. The outcome is reported either way, with every block's
figures and every gate's reasons, and the report changes no default: a default changes only by a
change a person makes after reading it.

## D9. Halt, stop and completion

- **Unknown usage halts.** Each run stops on its first turn of unknown usage, and the journal latches
  a halt on an unknown settlement, an uncertain request at reopen, or an integrity failure. A halt is
  never cleared; nothing further is admitted, and every remaining slot is recorded `not-attempted`
  with the reason.
- **An unforked block:** a prefix that throws, or a fork that fails, leaves its block unforked and its
  three slots `not-attempted` with the reason. The next block runs only when nothing ended admission:
  no halt (an unknown settlement latches one), no runner stop, no request of the prefix left unsettled,
  and its prefix evidence written. Otherwise every remaining slot is `not-attempted` with that reason.
- **A continuation that does not complete:** `cancelled` when it returned a record marked cancelled;
  `failed` when it threw (even if a cancellation also stopped the run), or when it returned but a gate
  denied it planned work (discovery skipped,
  findings stranded, an admission refused). Its manifest is attempted either way; a manifest that is
  refused or fails to write ends admission.
- **Statuses on disk:** every slot is meant to end with a terminal status line. A status line that
  cannot be written ends admission, so later slots are not attempted, and the slot status file may
  then lack lines it was meant to hold; the runner's own result still names every slot.
- **Completion:** the run is complete only when all nine slots completed with no halt, no runner stop
  and no unknown, uncertain or in-flight request.
- **No restart.** No prefix, continuation or block is restarted or replaced, and a started schedule is
  never executed again.

## D10. Exposure, and what is not established

- **Not a bill.** The figures of D5 are admission thresholds. Admitted work may overshoot them before
  it settles; the host may make requests and steps MAD does not meter; known spend is a floor whenever
  usage is unknown. None of them is a maximum bill or a hard exposure ceiling, and nothing here bounds
  provider pricing or quota.
- **Unmeasured.** No live run of this design has happened. Whether the allowances are adequate for a
  live run, and how the variants behave on a real host and real providers, is not established by any
  test; every check behind this design runs on fakes only.
- **Blinding is procedural** (D6): no reader can confirm it from the files.
