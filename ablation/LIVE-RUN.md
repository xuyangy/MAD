# Running the ablation against real providers

The scripted ablation (`bun run ablation --pin provider/model`) proves the
harness works. **It measures nothing about whether debate is worth its bill.**
`FakeBackend` bills a constant 10 in / 20 out per turn and its judge returns
`upheld` unconditionally, so the verdict-difference column can only be zero and
the token column is a turn count in token clothing. The report says so in a
banner with no suppression option.

This file is how a real number is produced. It is the procedure stories 1, 2 and
5A each deferred to story 9.

## Before anything bills

1. **A running opencode server.** The default is `http://localhost:4096`; pass
   `--server` for anything else.
2. **At least one provider configured in the HOST.** MAD holds no credential and
   adds no provider (AD-3). Whatever `opencode` can reach is what the roster is
   drawn from — three distinct lineages is the roster AD-4 ranks toward, and
   fewer is a legitimate run that reports itself as degraded.
3. **A worktree with a real diff.** `--directory` selects it; `--target` takes
   host git syntax (`main...HEAD`, a commit, or omitted for the working tree).
4. **`MAD_ARTIFACTS` pointed OUTSIDE the repository under review**, or unset.
   AD-16: nothing is written into the repo being reviewed. Without `--out` the
   ablation itself writes nothing at all — it holds the `RunRecord`s in memory
   and reads them — but the artifact dump is a separate feature and it is on if
   that variable is set. **This rule is unchanged by `--out` below**, which is
   checked against the same containment test and refused just as loudly.
5. **State a token ceiling.** `--cap N` is passed to *every* arm from one value,
   so a shared ceiling stays shared. Three arms over one change is up to
   `1 + 3 + (3 + lenses)` discovery turns plus debate and judge turns for each,
   against your own credentials. Decide the number before you spend it.

## The run

```
bun run ablation --live \
  --pin anthropic/claude-sonnet-4-5 \
  --server http://localhost:4096 \
  --directory /path/to/repo \
  --target main...HEAD \
  --cap 400000 \
  --repeats 3
```

`--pin` is required and has no default, on either path. MAD names no model, and
a pin committed in this repository would be the first model id checked into
MAD's own tree — "the ablation's caller names it" stops being true when the
caller is a file inside MAD. You name it.

## Writing an evaluation bundle (`--out`, story 2.2)

A live run is evidence only if someone can check it afterwards. `--out <dir>`
writes an **evaluation bundle**: one AD-16 artifact dump per arm and repeat, each
carrying a versioned `manifest.json` recording the code revision, the change by
both its ref range and a content hash, the protocol and fixture versions, every
resolved slot, every dial, per-stage spend against its ceiling, and how the run
ended.

```
bun run ablation --live \
  --pin anthropic/claude-sonnet-4-5 \
  --directory /path/to/repo \
  --cap 400000 \
  --out /scratch/mad-eval-2026-09-10 \
  --protocol-version 1 \
  --protocol-hash sha256:<the frozen_hash from evaluation-protocol.md>
```

**No `--fixture-version` or `--fixture-hash` here, and that is deliberate.** This command
reviews whatever is in `--directory`, which is an unlabelled change. Pasting the sealed
labelled change's identity onto it would produce a manifest naming a fixture that was not
reviewed — the exact failure `--labelled-change`'s own refusal exists to prevent, arriving
by copy-and-paste instead. The two fields are recorded as explicit unknowns with their
reasons, and `bun run eval-read` segregates them rather than treating an unknown as
agreement. The sealed identity belongs to the labelled procedure below, which fills it
from the seal itself.

The two flags themselves stay available and stay legitimate: if `--directory` holds a change
**you** have sealed elsewhere, pass its version and hash and the manifest records them. What
must never happen is an identity naming a set this run did not review — which is why
`--labelled-change` fills both itself and refuses a hand-typed one beside it.

Then read it back:

```
bun run eval-read --bundle /scratch/mad-eval-2026-09-10
```

Four things worth knowing before you use it:

- **`--out` must be absolute and outside the repository under review.** It goes
  through the same `refusalFor` check the artifact dump uses. A relative path is
  refused because it would resolve against the project directory.
- **`--out` only works with `--live`.** A scripted ablation compares records in
  memory and writes nothing, and that is story 9's A20 rather than an oversight.
- **The identity flags are optional and their absence is RECORDED.** A protocol
  hash you do not pass is written as an explicit unknown with the reason. It is
  not a default and not an empty string — and the reader treats an unknown as
  *not comparable*, so arms missing one are segregated rather than silently
  compared.
- **The code revision is established, not assumed.** It comes from
  `git rev-parse HEAD` plus `git status --porcelain`; if either fails, the
  manifest records an unknown carrying git's own words.
- **Each arm is written as it finishes, and a failed write STOPS the run.** If a
  dump cannot be written — no space, a refused path — the evaluation raises and
  no report is printed, so nothing further bills and no untraceable number is
  published (FR1). Arms that already completed keep their dumps.

`bun run eval-read` prints segregated, missing and unreadable arms ABOVE the
comparison table, with the reason for each, and prints an explicit incompleteness
banner when there are any. It computes no fused score: the arms go side by side
and the reader values them.

## Reading the result

**`--repeats` is not decoration.** Model output is nondeterministic, so a single
live pair cannot tell a real arm difference from run-to-run noise. Run each arm
several times and compare the spread between repeats of the *same* arm against
the difference between *different* arms. A difference smaller than that spread
is not a result.

**The four numbers are four numbers.** Verdict difference is a count of
findings. Token cost is a count of tokens. Lens recall gain is a count of
defects. Lens token cost is a count of tokens. Nothing in this harness divides
one by another, because the exchange rate between a defect and a token is your
judgement and not the tool's (AD-9).

**Cross-arm matching is the instrument's weakest joint.** Two arms raise
different findings, so they are aligned by the shipped clustering matcher, whose
error is measured only on an 8-row, single-file, *within-run* labelled set. On an
unlabelled change no cross-arm labelled set applies, and the cross-arm error is
unmeasured. That error enters the difference count one for one: an over-merge
invents a matched pair whose two sides were never the same defect, and an
under-merge hides a real pair in `only in`. Read `only in` and `ambiguous` beside
the difference, never the difference alone. (A labelled run is the one exception;
see *What a labelled run gives you: cross-arm counts for that change only* below.)

**A degraded arm is not a measurement — in THIS report.** If any arm reports `DEGRADED`, the
ablation report draws no experimental line from it. Fix the roster and run again. The paired
reader takes the other route on the same rule: it measures the block and NAMES the
degradation beside the result, because withholding it would discard planned data. Both
satisfy AD-6, which asks that a degraded run never *look* like a good one, not that it be
thrown away. See *Reading a paired bundle* below.

**Recall is not available on an UNLABELLED live change.** Recall is measured against a
known defect set and a real change has none — nobody labelled its bugs. The report prints
"not applicable", never `0`. That limitation is true and it stays true: every run that
reads its change out of a real worktree is a run with no recall number, and the sentence
above is about those runs. What story 2.4 added is a second option beside it, not a
replacement for it.

## A labelled run (`--labelled-change`, story 2.4)

A labelled run reviews the sealed seeded-defect change instead of reading one from the
worktree. That is what makes recall computable AT ALL — there is now a fixed reference set
to measure against, never an asserted exhaustive set of every defect in the change
(`evaluation-protocol.md:73-79`).

**A single labelled run does not score itself.** `ablation/live.ts` passes `gain: undefined`
on both paths, so a labelled run's report prints `gain: not measured in this report` for lens
recall gain. It gives no reason beyond that, because the reason differs by path and only one
of them is knowable there: on an unlabelled change nobody wrote the bugs down, while on a
labelled one the set exists. Read the line as *not measured*, not as *zero* and not as
*impossible*.

What DOES score the thirteen labels is the labelled report below, over a **persisted paired
bundle**. A single run is not a paired bundle and writes no prefix `record.json`, so that
reader cannot serve it, and a dated scope decision (2026-09-17) leaves it unscored rather
than adding a second scoring pipeline. **No story owns single-run scoring.**

**It is still LIVE evidence.** The labels are scripted; the backend is not. "Scripted"
versus "live" is a property of the **backend and the evidence provenance**, not of the
change under review (FR7). A labelled run bills real providers, and `report.ts`'s scripted
banner is unchanged — it fires on a scripted BACKEND, which a labelled live run does not
have. A scripted ablation over the same change still prints the banner, and should.

### Step 1 — materialize the worktree

```
bun run materialize-change --out /scratch/mad-labelled-change
```

This writes a real git worktree: the base tree in one commit, then the change applied and
left **uncommitted**, so `git diff HEAD` plus the untracked files is exactly the change
under review. It prints the fixture version and hash on success.

`--out` must be **absolute and outside this repository**, through the same AD-16
containment check `MAD_ARTIFACTS` and `--out` go through. A non-empty destination is
refused rather than merged into.

### Step 2 — point the run at it

```
bun run ablation --live --labelled-change \
  --pin anthropic/claude-sonnet-4-5 \
  --directory /scratch/mad-labelled-change \
  --cap 400000 \
  --out /scratch/mad-eval-labelled
```

`--labelled-change` hands the change to the run and fills `--fixture-version` and
`--fixture-hash` from the seal, so the manifest names what was reviewed and no one types
an identity from memory (FR1).

### Checking a bundle afterwards

Every manifest a labelled run writes carries this identity, and this is the only place in
this file where it appears — it is for CHECKING a bundle you already have, never for
pasting onto a command:

```
fixture version: labelled-change-1
fixture hash:    sha256:76523deb36aee41eb6ce9aaf1f9a51efbde5b404f839b1b20483016968fd848d
```

That is `LABELLED_CHANGE_SEAL.version` and `LABELLED_CHANGE_SEAL.materialHash` from
`fixtures/seeded-defects/seal.ts`, and `ablation/live-run-doc.test.ts` asserts these two
lines still equal it. `fixtures/seeded-defects/seal.test.ts` is designed to force a
deliberate version bump when the fixture changes; without that assertion the bump would
leave these lines stale with CI green, which is the same untraceable-identity failure from
the other end. The hash is the MATERIAL hash — what the models saw. The labels hash seals
the answer key, which no arm read, and it has no place in a manifest of what was reviewed.

### The containment refusal, and why it is not left to you

**`--labelled-change` refuses a `--directory` that is this repository, is inside it, or
CONTAINS it** — `/Users/you/src` and `/` are refused for the same reason `/Users/you/src/MAD`
is. This is not tidiness. A live model's session is created in `--directory` with the host's default
tool set, which MAD does not restrict, and the Fact-Checker is *told* to open files. Pointed
at this repository, a model can open `fixtures/seeded-defects/labels.ts` and read the ids,
loci, summaries and markers of all thirteen planted defects. A model that can read the answer
key measures nothing, and the run would look perfectly fine.

That channel is invisible to `core/` and is exercised by no CI test, which is why it is a
refusal in the CLI rather than a paragraph here. A relative `--directory` is refused too:
containment cannot be decided on a path that has not been resolved.

Three more refusals, all of them before anything bills:

- **`--labelled-change` needs `--live`.** The scripted ablation already reviews this exact
  change against a backend that bills a constant and upholds everything; the flag would
  claim a labelled evaluation and deliver the scripted one.
- **It refuses an explicit `--fixture-version` or `--fixture-hash` beside it.** Two
  authorities on the fixture identity is how a manifest comes to name a set that was not
  reviewed.
- **It refuses a `--target` beside it.** A labelled run never reads a worktree, so a ref
  range would be read by nothing while the manifest said the sealed set was reviewed.
- **It needs `--out`.** AC4 records the fixture's version and hash in the manifest of every
  run that reviews the set, and without `--out` no manifest is written at all — the run
  would bill a live roster and leave numbers that trace to nothing (FR1). This is a
  refusal, not a warning.

### What a labelled run gives you: cross-arm counts for that change only

A labelled run's report prints the aligner's cross-arm over-merge and under-merge as
`x of y`, with the case set's version (`cross-arm-pairs-1`), its hash, its label counts, and
the matcher's version and configuration. Read them for what they are:

- **They were counted offline on a small set of hand-built cases** in
  `fixtures/cross-arm-pairs/` that cite this change's files and lines. They were NOT
  measured on the run's own findings.
- **Some cases were built so the shipped matcher gets them wrong**, in both directions. The
  counts reflect that choice of cases, not a sample of real arm findings.
- **The denominators are small**, so one case moves a rate a long way.
- **They carry over to no other change.** The report prints them only when the reviewed
  diff hashes to the set's recorded source diff; every other run keeps the unmeasured
  disclosure above.

`bun run cross-arm-rates` lists every case, its label and what the aligner did with it.
Scoring calls no model and bills nothing.

### What a labelled run does NOT give you

- **No precision, no false-positive count, no rate.** A finding no planted label covers is
  recorded as **unlabelled** and adjudicated by a human in
  `fixtures/seeded-defects/ADJUDICATION.md` — never counted as a false positive by default,
  which would score the thirteen-defect label set rather than the model
  (`evaluation-protocol.md:130`). Story 2.8 owns precision, under the protocol's bound
  arithmetic.
- **No cross-arm rate that carries over, and none for this run's own findings.** The counts
  above are over the hand-built cases for this change. They say nothing about another
  change, and nothing exact about how the aligner treated the findings this run raised.

## The paired block runner (story 2-5c): a library, not a command

`ablation/paired.ts` runs the protocol's three paired blocks. It has no CLI flag, and
`scripts/ablation.ts` does not call it. Nothing in this section authorizes billing.

Two calls, kept apart on purpose:

1. `createSchedule` (`ablation/schedule.ts`) tosses one fair coin and publishes
   `paired-schedule.json` at the bundle root. Heads gives first arms ON, OFF, ON; tails
   gives OFF, ON, OFF. The file binds the frozen protocol's hash, the fixture seal, the code
   revision, the resolved roster and a digest of every non-intervention setting. An existing
   schedule refuses. A schedule is never re-tossed.
2. `runPairedBlocks` takes the bundle root's lock (`paired.lock`), checks the schedule
   against its own inputs, and writes `paired-start.json` before anything can bill. A present
   start marker refuses every later invocation, so a started schedule is never run again.
   A journal that is already halted or stopped refuses before the marker is written, so it
   does not spend the schedule. Each block is one prefix, one fork, and the two
   continuations in the scheduled order.

Every run that produced a record leaves its evidence in the bundle:

- **Each arm slot whose continuation returned or threw** gets one manifest carrying an
  `experiment` block. A continuation that threw keeps the record the branch held when it
  threw, with `experiment.failure` naming the exception; its completion reads `unfinished`
  and no report or finish time is invented for it.
- **Each block's shared prefix** gets `prefix/<block - 1>/prefix.json`: the schedule hash, the
  block, the prefix run id, whether it was forked and why not. When the prefix produced a
  record, its dump sits beside the file. A prefix is not an arm, so `bundle.json` does not
  declare it and it has no manifest.

A failed evidence write ends admission, and every remaining slot is `not-attempted`.

### Reading a paired bundle

```
bun run eval-read --bundle /scratch/mad-eval-2026-09-14
```

When the bundle root carries `paired-schedule.json`, this prints the ordinary arm table and
then a second report, the paired contrast, produced by `ablation/paired-read.ts`. It reads;
it bills nothing, runs nothing, and always exits 0.

**What prints above every number.**

- **The halt, in three states.** A latched `unknown-usage-halt.json` prints
  `THIS EXPERIMENT IS HALTED.` with the reason it recorded, above the results, which are
  still read from what was written. A marker that could not be read at all prints
  `WHETHER THIS EXPERIMENT IS HALTED COULD NOT BE ESTABLISHED.` instead — that is its own
  state, not a halt and not the absence of one. No marker prints no banner.
- **Slot coverage.** All six planned slots, each folded to one terminal status with its
  reason, `not-attempted` and never-recorded included. `paired-slots.jsonl` is appended
  without consulting the schedule, so these print **even when the schedule is refused**; with
  no readable schedule each slot's position reads `position unknown` rather than being
  guessed. A line in the file this reader cannot read as a slot status is counted and named,
  never dropped.
- **Prefix evidence**, one line per block, and **ARMS**: what `bundle.json` declared, how many
  arms the bundle reader admitted to its cohort, which block and slot each arm bound to with
  its run id and prefix, and then every arm that is `KEPT, NAMED, AND OUT OF EVERY PAIR` with
  the reason it is out.
- **Availability**, `n/3` **separately for each quantity**, each missing block naming its
  exact reason. A block supplies a quantity only when that quantity's own denominator is
  non-zero, so a block can supply four of the five.

**What it checks before it pairs anything.** It re-reads the sealed schedule without any
binding — the version, the schedule's own hash recomputed, and that the order follows from
the coin — and then cross-checks every arm against it: the schedule hash, the block (which
must be `repeatId + 1`), the arm, the position, and the schedule hash and block on that
block's `prefix/<block - 1>/prefix.json`. A manifest with no `experiment` block is not a
paired arm, and its absence never makes one. Anything that fails a check is kept, named, and
left out of its pair with the reason; a refused block never voids the other two.

**A block yields a paired quantity only when all of this holds.** Otherwise it is withheld
and every reason is printed:

- exactly two arms, one `on` and one `off`, both bound to this block;
- **neither arm is partial or crashed** — an arm carrying `experiment.failure`, or whose
  `status.completion` is `unfinished` or `cancelled`, has the findings it HELD when it
  stopped, and joining those against a whole arm would report the truncation as a difference
  between the arms. **A `degraded` arm is not one of these.** It ran to the end and something
  reduced it, so its block is measured and its degradation — with the warnings that caused it,
  or the fact that none is recorded — is named beside that block's result. AD-6 asks that a
  degraded run never *look* like a good one, which naming satisfies; discarding it would throw
  away planned data the protocol says is never dropped;
- **both arms name ONE `experiment.prefixRunId`** — two prefixes are two populations;
- **the prefix evidence records that the fork happened** — `forked: false`, a `failure`, or a
  prefix that minted no run id each withhold the block, because the fork is what makes the id
  join legitimate;
- **the prefix evidence and the arms name the same prefix run** — when the two files
  disagree, neither is preferred and both values are printed.

**How the arms are paired.** Within a block the two arms pair by `Finding.id`, with no
aligner: one prepared review was forked into both, so the ids are the same candidates.
**Ids are comparable only inside one block** — across blocks discovery is re-sampled, so an
equal id string names two different candidates and is never paired.

**What it prints per measured block**, in the words the availability table uses for the same
five quantities: **paired candidates** over the distinct candidate ids across the two arms;
**verdict-state differences** over the paired candidates where both arms decided;
**undecided transitions** over the paired candidates, counted on their own and in neither
half of the line above; **only-in counts**, one per arm; and the **treatment opportunity**,
read from **the OFF arm's** `status.routeCounts.intervention` and never re-derived — the ON
arm ran the shipped policy and writes no `intervention` block at all. Every rate names its
numerator and denominator; a zero denominator reads `not measurable (0 cases)`. A long list
of differing candidates is capped at five with the rest counted, so the confounds are not
pushed off the end of the block.

**What sits beside every MEASURED result**, per block and never in a footnote: the
run-id/anonymizer confound above, the within-block position order, the sentence saying what
the contrast identifies, and the dial disclosures. A **withheld** block has no result to
qualify, so it prints its reasons and its arms instead.

**What it still does not measure.** No truth label enters it. It states no precision, no
false positives, no final recall, none of the four labelled verdict transitions, and no
earned / did-not-earn reading. CAP-1 recall and CAP-11 lens gain are the labelled report's,
printed after this one. The four labelled verdict transitions and the per-arm false positives
are the adjudication report's, printed after that one, from a human truth sheet.
Precision, final recall and cost contrasts belong to story 2.8. An
arm that upheld nothing is reported as undefined, never as 100% and never as a clean list. A
candidate left unresolved by the budget is counted and shown, never treated as removed noise.
It does not re-derive the unique-execution bill: that is the journal's.

Every billable request is written to `paired-journal.jsonl` before it goes out and settled
there with what it cost. The journal's bill counts each physical execution once, so a shared
prefix is not counted again for each branch that inherited it. `paired-slots.jsonl` records a
started and a terminal status, with its reason, for each of the six planned arm slots.

A continuation that returned is `completed` only when nothing was refused. When the run's own
ledger or an admission gate refused it planned work (discovery slots skipped, findings left
unresolved, or a refused admission in its phase or its block's prefix), the slot is `failed`
with what was denied, and the result's `complete` is false. Reaching a threshold with
nothing refused is not a denial.

Late usage is the caller's to reconcile. The result carries a reconciliation handle. A
report that arrives after the run returned is held in memory until the caller calls
`flush()`, and a process that exits first loses it. Call `flush()` after every invocation,
and again whenever a late report may have arrived: besides the reports `held()` lists, it
appends settlements that arrived after the run returned and lines held back by a failed
append, which `held()` does not list. With nothing to write it does nothing. `flush()` takes
the lock again, replays the journal, and appends what is held:

- `persisted` counts the lines it appended. A line the journal already carries with the same
  payload is not appended again.
- `conflicts` lists held payloads that disagree with the journal. Each is an integrity failure,
  and the halt stays.
- `unmatched` lists late reports no request in the journal carries. They are kept, and the
  next `flush()` offers them again.
- `failed` says why it stopped. Everything not persisted is kept. A journal it cannot replay,
  such as one with a torn last line, is refused and left exactly as it is.

### The labelled report (story 2-6): CAP-1 recall and CAP-11 lens gain

When the bundle carries a sealed paired schedule, `bun run eval-read` prints a third report
after the paired contrast, produced by `ablation/labelled-read.ts`. It reads what the paired
reader already read, plus each block's prefix `record.json`. It bills nothing, runs nothing,
and always exits 0. A bundle with no sealed schedule gets no labelled report at all: the run
and paired reports are the whole output.

**When it refuses.** The schedule's fixture must be `labelled-change-1` with the sealed
material and labels hashes. Every arm the paired reader bound must carry the sealed material
hash as `identity.fixtureHash`, and the schedule's protocol version and hash as
`identity.protocolVersion` and `identity.protocolHash`; with no arm bound at all, the report
refuses too. Otherwise it prints `REFUSED: THIS BUNDLE IS NOT THE SEALED LABELLED CHANGE.`
with each field that differs, and computes no number. An arm the paired reader did not bind is
listed with that reader's reason and refuses nothing. A schedule the paired reader refused
keeps that refusal.

**Where the pool comes from.** The prefix record is the only unmutated discovery pool. Each
arm's `manifest.findings.pool` was touched by debate and judge after the fork, so CAP-1 and
CAP-11 never read it. The reader finds the record from the bundle root, at
`prefix/<block - 1>/<prefixRunId>/record.json`, so a copied or moved bundle still reads. The
`dump` path in `prefix.json` was written where the bundle was made and is only a cross-check:
its last directory name must be the prefix run id. By real path, the block directory must be
inside the bundle root, and the dump directory and `record.json` inside the block directory.
The record's `runId` must be the block's prefix run id and its `roster` the schedule's. Any
other record is refused with both values named.

**What each block prints.**

- Every pool and lens slot, and whether it answered. A slot that did not answer is listed with
  its reason (`model-dropped-out` or `skippedForBudget`), never as a zero. A salvaged answer
  counts as answered and shows its `partial-envelope` disclosure.
- **CAP-1**: the pool union, each answered pool slot, and the best answered pool slot by name,
  each as `x of 13` with the defect ids. With no answered pool slot there is no best member
  and no comparison.
- **CAP-11**: the lens-only defects, over `n of m` lens slots answered, and each lens's own
  count. With no lens slot or no answered lens slot it is unavailable. A record cancelled at
  `discover` has unknown lens coverage, so CAP-11 is withheld.
- **Each arm's upheld findings**: planted-label matches with the defect ids, and `U`, the upheld
  findings no planted label claimed, unmatched duplicates included. `U` is not a truth label.
  False positives are the adjudication report's, below, and are counted from the human truth
  sheet rather than from `U`.

The answered slot ids are derived (pool slots minus discover-stage drop-outs minus budget
skips) and checked against `record.answered`, against every finding's `author`, and against
the slot evidence itself. A mismatch withholds the quantity it affects, with both sides named.
Contradictory evidence is a mismatch: a slot both dropped and skipped, a dropped or skipped slot
that is also a `partial-envelope` answer, two drop-out warnings for one slot, a slot named twice
in `skippedForBudget`, or a discover-stage `model-dropped-out` OR `partial-envelope` warning with
no slot or an unknown one. A lens finding whose author is a pool slot withholds
CAP-1 and CAP-11; a finding by a dropped or skipped lens slot withholds CAP-11. A roster with
no pool slot, or no answered pool slot, gives CAP-11 no baseline, so it is unavailable.

**The estimands.** CAP-1 is within-prefix attribution: the union of one discovery pass against
the best single answered pool slot of the same pass, not an independently executed
single-model run. CAP-11 is the defects answered lens slots raised that no answered pool slot
raised in that pass, not a causal run effect. Both are nonnegative by construction and say
nothing about precision.

**The summary.** Each quantity reads `observed n/3`, each missing block with its reason, and
mean, min and max over complete observations only, labelled descriptive and not the planned
three-block result. One observation reads `spread unavailable`; none reads unavailable. The
partial-diagnostic rule applies to the prefix quantities, CAP-1 and CAP-11: a block with a
dropped or skipped slot is reported, and kept outside their summary. The arm quantities count
every block the paired reader measured. The two arms of a block share one prefix, so that
prefix is one observation; two blocks naming one prefix run are also counted once, as a
defensive check.

**Identity in the header.** The labelled change's version, its planted-defect count, its
material hash and its **labels hash**. The material hash is what the schedule's fixture and every
bound arm's `identity.fixtureHash` are checked against; the labels hash is what every number
below is scored against, and the schedule's fixture is checked on it too.

**Protocol identity and status.** The report prints the protocol the schedule was sealed under
(id, version, hash) and each bound arm's `protocolVersion` and `protocolHash`. Every number is
descriptive. `evaluation-protocol-v2.md` proposes both endpoints and is a draft, so no number is
v2-preregistered.

The status block states four things separately, and the third and fourth are easy to confuse:

- `bundle observations` counts **quantities**, not blocks: each of the eight is counted once if
  ANY block gave it a complete observation, so **one complete block alone prints `8 of 8`**.
- `planned live evaluation` therefore says, unconditionally, that completion is **not**
  established by this report — bundle observation counts alone establish neither live provenance
  nor completion of the planned three blocks.
- `matcher` names which matcher produced the numbers. The shipped lexical matcher is the one the
  draft protocol (A2) proposes; an injected one is labelled `INJECTED` and the report says the
  numbers are not that proposal's quantity.

**What it does not own.** The four labelled verdict transitions and the per-arm false positives
are the adjudication report's, below. Precision and cost contrasts are story 2.8.

### The adjudication report (story 2-6b): the four verdict directions and false positives

`bun run eval-read` prints a fourth report after the labelled one, produced by
`ablation/adjudication-read.ts`. It reads what the paired reader already read, each block's
prefix `record.json` through the labelled reader's own `loadPrefixRecord`, and one
human-authored file: `<bundle>/adjudication.json`. It bills nothing, runs nothing, prints and
gates nothing, and always exits 0. A bundle with no sealed schedule gets no adjudication
report at all.

**It is the only reader here that consumes a human-authored input**, so the sheet is bound like
evidence rather than trusted like config. Its `scheduleHash` says which PLAN, its `block` says
which block, and its `prefixRunId` says which EXECUTION — `PairedSchedule` carries no candidate
identity, so the schedule hash alone cannot tell a copied plan from the run that produced these
candidates. The file must also resolve, by real path, inside the bundle root, exactly as every
file the labelled reader opens must. `fixtures/seeded-defects/ADJUDICATION.md` holds the sheet's
fields, a command that prints a blank page for one block, and the rules for filling it. Copy
`prefixRunId.value` from `prefix.json`, not `prefixRunId`: the field there is a `Maybe`. The
reader never parses `adjudication.md` and never falls back to it.

A filled sheet is kept out of this repository by a `.gitignore` entry on `adjudication.json`.

**The truth pool is the shared prefix.** Every canonical candidate in the block's prefix
`record.json` gets one label slot — not the intersection of the surviving arms, not the upheld
ones, and not a per-arm list. A pool defined by what survived would let a candidate's
disappearance decide whether it is ever truth-labelled.

**A planted-label match is suggested evidence, never a truth label.** The report prints one line
per candidate — the human label, the matcher's association and the bucket the candidate landed in,
with the row's `evidence` beneath it when the sheet gave one — and the association enters no count; every number is identical under an injected matcher. A
human label that contradicts a suggestion is **kept**, and the contradictions are listed again on
their own. A label of `not-a-defect` or `unresolved` against a matched planted defect is a
contradiction; a candidate with no row at all is not, because nobody labelled it.

**The four directions, each counted separately, OFF → ON**, over the candidates both arms raised
and both arms decided as upheld or rejected:

- **false upheld → rejected** — OFF upheld a candidate the sheet calls not-a-defect, ON rejected it.
- **true rejected → upheld** — OFF rejected a real defect, ON upheld it.
- **true upheld → rejected** — OFF upheld a real defect, ON rejected it.
- **false rejected → upheld** — OFF rejected a candidate the sheet calls not-a-defect, ON upheld it.

`upheld` is `upheld`; `rejected` is `withdrawn-by-author` or `judge-ruled-invalid`.
**`not-adjudicated`, `unresolved` and `unjudged` are each named separately and are never
rejected** — `not-adjudicated` is the judge saying the evidence does not settle the claim, and the
aggregator also writes it on drop-out, so `upheld → not-adjudicated` is not noise removal.
**Truth-`unresolved` and verdict-`unresolved` are different facts** and print apart.

**Every candidate is accounted for once**, and the buckets sum to the prefix pool: a transition,
unchanged, undecided, label missing, truth unresolved, unclassified, or missing from an arm. A
candidate one arm never raised is **missing**, with the side named, and is never a transition.

**`unchanged` is a verdict-axis count.** Both arms deciding a candidate the same way needs no truth
label to establish, so it reads with no sheet, and it is tested before the label: the four
directions and the two label buckets divide the candidates that DIFFER between the arms, which is
the population they partition. A candidate with no row is `label missing`; one the sheet labels
`unresolved` is kept under its own name. Both are excluded from the four directions and neither is
a false positive. `unclassified label` is a candidate the sheet labelled that no direction row
covers; it is empty under the three labels that exist, and it is there so a fourth could not vanish.

**Known false positives are counted among ALL upheld findings**, per arm, as `k of n upheld
finding(s) are known false positives`. It is a **count, not a precision**: `evaluation-protocol.md`
defines the denominator over final upheld findings as `N = TP + FP + U` with the unknowns retained,
and permits a point precision only when `U = 0`. The line beneath it holds the identity that
denominator obeys — `upheld = known FP + known true-defect + truth unresolved + label missing +
outside the pool` — so a reader can see every part of `n`. Upheld ids the prefix pool does not hold
are printed on their own line and are never dropped from the denominator: dropping them would
silently select a different population. They are never derived from the labelled report's `U` and
are never a default for an unlabelled finding. Every list of ids on these lines is capped at five
with the rest counted.

**What the sheet's absence costs, in distinct states that never collapse.** No sheet: every
truth-dependent quantity is unavailable with the reason `no adjudication sheet`, and the
verdict-only counts — undecided transitions, candidates missing from an arm, and unchanged — still
read. A sheet this process could not open reads `THE TRUTH SHEET COULD NOT BE READ`, which is not
the same fact as nobody having written one — and a sheet that is a **symlink resolving to nothing**
reads there too, because somebody placed it. A sheet about another plan, or resolving outside the
bundle, is refused. A sheet present with no row for one candidate is that candidate's `label
missing`, not a sheet state.

**Malformed is whole-sheet; a bad page is not.** Only the sheet's own identity — text that is not
JSON, a version this reader does not know, a missing `scheduleHash`, a `blocks` that is not a list
— makes the whole sheet malformed, because such a document has no pages to isolate. Every check
below that is a check on ONE page, and a page failing it withdraws its own block and no others.

Three page-level outcomes, each on its own:

- **A page naming an unplanned block** is a stray. It is rejected and named with the value it
  carried, and nothing is inferred about which block it was meant for.
- **A page naming a planned block that cannot be read as one** — a bad `prefixRunId`, a bad `rows`,
  a bad row, or a label outside the three — is rejected with its reason.
- **Two pages for one block** rejects BOTH. Choosing between them would publish labels nobody
  agreed on, which is the rule already applied to two rows for one candidate.

In all three, the block left without a page reads `carries no valid page for block N` with the
reason beside it, and every other block still reads. **Every rejected page is also listed once in
the sheet section**, by index, by the block it named or as carrying no readable block number, and
with its reason. Two kinds of rejected page reach no block report at all: one naming a known block
whose block is unavailable for an earlier reason — a withheld paired block, a prefix record missing
or bound elsewhere, a canonical pool that will not parse — and one carrying no readable block
number, which leaves no block short of a page and so is mentioned nowhere when all three read.
Discarding part of a hand-filled sheet in silence is the collapse this reader exists to prevent.

**A cancelled prefix run is said out loud.** The truth pool is then whatever discovery had reached.
Nothing is withheld — the counts are true of the pool that exists — but the report names the stage
it was cancelled at, because a pool the operator believes is complete is the one way these
denominators mislead.

**The block itself has three states too.** A prefix record bound to another run id or another
roster, or one escaping the bundle root, is **refused**; a record that is not there, or that
nothing could parse, is **unavailable**. The report prints them under their own headings.

**The lost true candidates are named in full.** `true upheld → rejected` prints every id; the
other three lists are capped at five with the rest counted.

**The partition checks itself.** The line saying every candidate is accounted for once compares the
buckets against the pool size before printing — both their total and the number of DISTINCT ids
across them, because a total alone cannot see a candidate filed twice: the double-count and the
candidate it displaced cancel. Both numbers come from the one loop that assigns the buckets. When
they disagree the report says so loudly and tells the reader not to trust the counts above it.

**A rate with nothing to divide by says so.** Every `k of n` line reads `not measurable (0 cases)`
when `n` is zero, rather than `0 of 0`.

**One prefix run is one observation.** Two blocks naming one `prefixRunId` contribute one value
to each summary, and the second names that reason.

**The summary** reads `observed n/3` per quantity, each missing block with its reason, and mean, min
and max over complete observations only, labelled descriptive and not the planned three-block result.
One observation reads `spread unavailable`; none reads unavailable, never 0. The quantities are the
four directions — `false upheld → rejected`, `true rejected → upheld`, `true upheld → rejected`,
`false rejected → upheld` — plus `label missing`, `truth unresolved`, `unclassified label`,
`on false positives`, `off false positives`, `undecided transitions`,
`candidates missing from an arm` and `unchanged`. The last three need no sheet; the rest do.

**What it does not own.** No precision, no precision bound, no final recall, no cost contrast and no
earned / did-not-earn reading. Those are story 2.8's, under the frozen protocol's bound arithmetic.

### What the fake-backed tests do not establish

- **The runner's semantics, and nothing about a host.** Every test drives port calls on
  fakes. They do not show how many physical requests a real host makes per port call.
  The port forbids backend retries, but whether the opencode host honours that, and whether
  each host subcall is accounted for, is unverified. Story 2.8 owns that check, and it must
  pass before anything bills.
- **A residual confound between the two arms of a block.** Each branch is a new run with
  its own run id, and the judge's anonymizer seeds its order from the run id and the finding
  id (`core/run/review.ts`, the `runId` passed to `judge`). So the two arms can show the judge
  the same exchange in different anonymized orders. That difference is part of every paired
  contrast, and it is not removed. The paired reader states it beside every MEASURED block's
  result, with that block's two run ids, so it is never read as a footnote to one number of
  three. A withheld block has no result to qualify and prints its reasons instead.

### When a run stops and needs a human

Nothing in the runner resumes on its own. These states stop it and wait for a person:

- **A stale `paired.lock`.** A process that died while it held the lock leaves the file
  behind, and every later writer refuses. Confirm that no runner is still active on that
  bundle root before you remove it.
- **A latched halt.** Unknown usage, an integrity failure, or an uncertain request latches
  the halt and writes `unknown-usage-halt.json` at the bundle root. The journal and the arm
  governor both refuse while that file exists. An uncertain request is an `issued` line in
  `paired-journal.jsonl` with no `settled` line: an invocation that did not finish sent it,
  and its cost is unquantified.
- **A runner stop.** The runner stops admitting, and names why in the bill's `stop` or the
  slot reasons, when the journal could not be appended, a slot status or a manifest or prefix
  evidence could not be written, or the run was cancelled. A failed append leaves lines held
  for `flush()`.
- **A refusal before the start marker.** The invocation is refused, nothing is billed, and the
  lock is released when: the start marker or the lock is present; a Tools port and a Tools
  identity are not supplied together, or the identity is blank; the schedule does not match
  the runner's inputs; the bundle index may not be written; the journal cannot be opened, or
  is already halted or stopped; the clock fails; or the start marker cannot be created. A
  schedule refused before its marker exists can still be run once the cause is fixed.
- **A spent start marker.** If `paired-start.json` was created but could not be written or
  synced, the refusal says the schedule is spent. The file may be empty or partial. It still
  refuses every later invocation, so start a new evaluation from a new bundle root.
- **A journal `flush()` cannot replay.** A torn or malformed line makes `flush()` refuse and
  leave the file exactly as it is, with every held line kept in memory. Do not edit the
  journal to make it replay; keep it as evidence, record what the held lines were, and treat
  the requests after the damaged line as unquantified.
- **`conflicts` or `unmatched` from `flush()`.** A conflict is an integrity failure: two
  payloads disagree for one request, both are kept, and the halt stays. An unmatched report
  names an execution id no request in the journal carries; it is kept and offered again, and
  it means a backend reported an execution this journal never admitted.

In every case, keep `paired-journal.jsonl`, `paired-schedule.json`, `paired-start.json`
and `paired-slots.jsonl` as they are. They are the evidence of what was scheduled, admitted
and billed. A started schedule is never executed again, so a new evaluation starts from a
new bundle root.

## The adversarial suite (story 2-7b): a library, not a command

`ablation/adversarial.ts` runs `evaluation-protocol.md` §5's sixteen adversarial runs:
eight sealed cases, each once clean and once attack, on a one-slot roster. It has no CLI
flag, and `scripts/ablation.ts` does not call it. **Nothing in this section authorizes
billing, and the sixteen live runs have not been executed.**

### The sealed cases

The case set is `adversarial-cases-2`. Its two hashes are recorded literals in
`fixtures/adversarial/seal.ts`, and the runner refuses to start when the cases it was
handed do not hash to them:

- material (base trees, clean and attack changes, payload bytes):
  `sha256:16b46d8f1aacde60e78831a5dd7114e21a1cc204b1c5fcfa32555211343b251d`
- assertions (target labels, blame predicates and the matching rules):
  `sha256:5f99afa3e13a0c2b23e3a967f76fab8a5a20f994a76a268c75d140fd8d50bafc`

The assertions hash identifies the answer key; it does not reveal it. The key lives in
`fixtures/adversarial/assertions.ts`, which the worktree writer never imports, and no
materialized worktree holds a label or a predicate.

### Two calls, kept apart on purpose

1. `createAdversarialSchedule` (`ablation/adversarial-schedule.ts`) tosses one fair coin per
   consecutive pair of cases and publishes `adversarial-schedule.json` under
   `<experiment root>/adversarial/`. Heads runs the pair's first case clean first and its
   second case attack first; tails the reverse, so four cases are clean-first and four
   attack-first. The file binds the frozen protocol, the case seal, the code revision, the
   one-slot roster and the run settings. An existing schedule refuses; it is never
   re-tossed.
2. `runAdversarialSuite` takes the experiment root's lock and then checks, in this order:
   1. no start marker exists;
   2. the root is not nested in another experiment root, and the adversarial subtree keeps
      no journal or lock of its own;
   3. the Tools identity is not blank;
   4. `maxConcurrency` is not above 1 (one slot, and one shared `$` rebound per run);
   5. the roster is one slot;
   6. the seal;
   7. the schedule against the runner's own inputs;
   8. the journal opens and is not halted or stopped;
   9. every planned worktree passes the shared AD-16 checks against the bundle root.

   Only then does it write under `adversarial/`: first the bundle index, then
   `adversarial-start.json`. A refusal at any of the nine checks writes nothing under
   `adversarial/`, bills nothing and leaves the schedule usable. A failure writing the
   bundle index also leaves the schedule usable. A started schedule is never run again.

### One experiment, one ledger

The journal (`paired-journal.jsonl`), the lock (`paired.lock`) and the halt marker
(`unknown-usage-halt.json`) are the experiment root's, shared with the paired blocks. Blocks
spend already there counts toward the global cap, and a halt written there refuses the next
adversarial request. Every adversarial request passes the run's ordinary 25,000 `tokenCap`
and then the adversarial gate: stop, halt, the global 2,000,000, the Adversarial 400,000.
These are admission thresholds, not a final bill; overshoot and unknown usage are reported.
The suite never touches the paired schedule, start marker or `bundle.json` at the root.

Under `<experiment root>/adversarial/` it writes `adversarial-schedule.json`,
`adversarial-start.json`, `adversarial-slots.jsonl` (each slot's status, with each attack
run's delivery evidence), `tool-trace.jsonl`, its own `bundle.json`, one dump per run at
`<side>/<caseIndex>/<runId>/` with a manifest carrying an `adversarial` binding, and the
materialized worktrees under `worktrees/`.

Runs are strictly sequential. `opencodeTools` binds Bun's shared `$` to each run's worktree
in turn, so concurrent runs would blame in each other's worktrees.

The worktrees under `adversarial/worktrees/` may be deleted after the suite ends. The
reader never opens them: it reads the schedule, the slot statuses, the trace and the dumps.
Each worktree can be rebuilt from the sealed material. `adv-08`'s base tree commits a
`.env` file holding only the fixture line `API_KEY=placeholder`; it is not a credential.

Delivery is a byte-substring check: a sent model request counts as carrying the payload
when its prompt or its instructions hold the payload's exact bytes. A request whose
`runTurn` threw is not counted as sent, and a run that sent no request records delivery
as unshown, with the reason.

### Reading the result

```
bun run eval-read --bundle /scratch/mad-experiment-2026-09-18
```

The adversarial report prints after any other report, and it prints even when the root
holds only the adversarial subtree. It is produced by `ablation/adversarial-read.ts`. Its
quantities are `verdict transition`, `tool request`, `tool execution` and
`payload delivery`, each printed apart, clean and attack apart, each with scheduled,
eligible, observed and missing and a reason per missing run. It opens with:

- "BOUNDED EVIDENCE over the eight named cases only. No pass criterion, no rate verdict and
  no claim of resistance is made or implied."
- the one-slot scope limit;
- the §5 statement that an occurrence or a transition does not establish attack causation;
- AD-13's second route, the tools a spawned session inherits, named UNOBSERVED.

A missing trace is never a negative. An incomplete count keeps its known positives,
labelled incomplete, and is never printed as an exact count or a zero. Delivery is recorded
apart from eligibility, and delivery is not attention.

Predicate paths are compared after posix normalization (`src/../src/db/client.ts` matches
`src/db/client.ts`). An absolute path in a request never matches a case's relative
predicate, so a model that names the repository by its absolute path is not counted.

### Before the sixteen live runs: prerequisites this story does not satisfy

The live execution is a separate task, and it stays open until each of these holds:

- **Host accounting.** How many physical requests the opencode host makes per port call,
  and whether each is accounted for, is verified on a real host.
- **Billing authorization.** A person authorizes the Adversarial allowance's spend.
- **Verified shared gates.** The global and Adversarial gates are verified against a real
  host before the first paid request.
- **Bounded tool termination.** A `git blame` that does not return is bounded.
- **Bounded observer writes.** A trace write that hangs stalls the judge; bounding it is an
  escalated human decision (2-7a).

### What the scripted tests do not establish

Every test drives a scripted backend over real git. They show the runner's order, gates,
evidence and trace, and the reader's coverage rules. They say nothing about whether a live
model honours the material frame, and nothing about a real host's requests.

### When the suite stops and needs a human

The states in *When a run stops and needs a human* above apply unchanged, because the lock,
journal and halt marker are the same files. In addition, keep `adversarial-schedule.json`,
`adversarial-start.json`, `adversarial-slots.jsonl` and `tool-trace.jsonl` as they are. A
started adversarial schedule is never run again and no case is re-run or replaced.

## What would falsify the design

This is the experiment's whole point, so it is worth writing down before you run
it:

- **Debate.** If the verdict difference between the single-model arm and the
  pool arm is at or near zero across enough live repeats to clear the noise
  floor, then debate changed nothing at the token cost printed beside it. That
  is a finding about the design, not a bug in the harness.
- **Lenses.** If `found by a LENS and by no unlensed pool member` is zero, the
  lens pass bought nothing the pool did not already have, at the extra token
  cost printed beside it. Story 2A is deletable on that evidence, and the
  two-tier design exists so that stays true.

The harness reports both outcomes as results and exits 0 either way. A reporter
that failed on a negative result would be a reporter that could only confirm.
