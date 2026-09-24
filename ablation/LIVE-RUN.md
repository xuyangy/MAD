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

## The paired block runner (story 2-5c)

`ablation/paired.ts` runs the protocol's three paired blocks. `scripts/ablation.ts` does not
call it. Its one caller is `bun run paired` (see *The paired launcher (story 2-8b)* below),
which refuses while any paired gate the evaluation requires is OPEN. Nothing in this section
authorizes billing.

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
Precision, final recall and cost contrasts belong to story 2.8, and the evaluation report
prints them last (see *The evaluation report* below). An
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
are the adjudication report's, below. Precision and cost contrasts are story 2.8's, printed by
the evaluation report.

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
earned / did-not-earn reading. Precision, its bounds, final recall and the cost contrast are story
2.8's, under the frozen protocol's bound arithmetic, and the evaluation report computes them from this
report's counts.

### The evaluation report (story 2-8a): precision, final recall, cost and treatment opportunity

`bun run eval-read` prints a fifth report after the adjudication one, produced by
`ablation/evaluation-report.ts`. It opens no file. It composes the paired, labelled and adjudication
results into the frozen protocol's reporting contract (`evaluation-protocol.md` v1 §3, §4 and §6).
Each of those readers runs once. If the labelled or adjudication reader throws, its error reaches this
report as an unavailable reason: its own quantities are unavailable, and coverage, cost and treatment
still print. It bills nothing and gates nothing; it only prints, and always exits 0. A bundle with
no sealed schedule gets no evaluation report.

**Provenance comes first.** A schedule sealed with `provenance: scripted` opens the report with a
**SYNTHETIC** banner, before any number. That evidence supports one milestone only:
*reporting implementation complete; live evidence pending*. A refused schedule prints provenance
**unestablished**. A `live` schedule prints no banner.

**The estimands.**

- **Execution coverage.** Three scheduled blocks, `n` completed, and every failed, cancelled,
  unfinished, not-attempted or unrecorded slot and every withheld block, each with its reason.
- **Precision per arm**, from the adjudication counts: TP is `trueDefects`, FP is `falsePositives`,
  U is `truthUnresolved + labelMissing + outsidePool`, and N is `upheld`. A point `TP/(TP+FP)` prints
  only when U = 0; otherwise precision lies in `[TP/N, (TP+U)/N]`. An arm that upheld nothing has
  **undefined** precision, never 100%.
- **The pair difference ON − OFF.** The primary bound is the **shared-label** bound
  `[K + Σmin(0,a_i), K + Σmax(0,a_i)]` over the distinct unlabelled ids upheld in either arm. The
  **outer** bound `[L_on − U_off, U_on − L_off]` prints too, labelled outer. Both are identification
  bounds, never confidence intervals. A primary bound spanning both signs reads
  *this bound does not resolve direction*. An outer bound crossing zero is named as that bound's own
  limitation.
- **Observed spread.** Every pair difference, then mean, min and max over all three pairs. With any
  pair bounded, the planned mean averages the endpoints and min and max print as bounds. With any
  pair undefined or unavailable, no three-pair summary prints, and no subset stands in for one.
- **Final recall.** Planted-defect **matcher** recall per arm (`x of 13`) and the ON − OFF change: a
  preservation diagnostic, never truth-sheet precision. The lost true candidates are the sheet-labelled
  true prefix candidates an arm did not uphold, each with its bucket.
- **Cost.** Per block: the shared prefix once, and each continuation's newly executed tokens and turns.
  The prefix cancels in ON − OFF only when both arms are established to have inherited one execution.
  An unknown in a continuation is never subtracted: one side unknown gives a one-sided bound, both
  sides give none. `unaudited` usage is an observed lower bound, never exact.
- **Treatment opportunity.** How many candidates the OFF arm's normal policy would have debated, and
  whether the debate stage ran in the ON arm. Zero reads *no treatment opportunity — demonstrates
  neither benefit nor failure*.

**When a block cannot supply a quantity, the report says which and why.**

- A withheld or absent block makes its treatment opportunity unknown, with the block's reasons.
- A block that continues a prefix an earlier block already supplied is one discovery pass counted
  twice. Its precision difference, matcher recall change, lost true candidates, cost contrast, block
  execution and treatment opportunity are unavailable, each with the reason
  *one shared prefix is one pair*. Coverage does not count it as a completed block.
- An arm that threw, was cancelled or did not finish makes the block execution incomplete: its spend
  still prints, marked `INCOMPLETE`, and no contrast is taken against it.
- One block whose composition fails is unavailable with the message, and the other blocks still
  read. When `readEvaluationReport` is handed a paired result it cannot compose from (the paired
  reader threw, or refused the bundle), it prints `MAD EVALUATION REPORT — NOT COMPOSED` and the
  reason. `eval-read` hands it only a paired result that read, so through `eval-read` this line
  does not print.

Availability prints as `n/3` separately for each quantity: `precision difference`,
`planted-defect matcher recall change`, `lost true candidates`, `cost contrast` and
`treatment opportunity`.

**The manifest cost is observed per-block cost, not the experiment bill.** The unique-execution bill
belongs to `paired-journal.jsonl`, and this report neither reads nor re-derives it. The report sums no
blocks into a total. A failed prefix has no arm manifests, so its spend stays a gap here and the report
points at `paired-journal.jsonl`. A missing arm manifest is also a gap with its reason, never a zero.

**What stories 2-8c and 2-8d still own.** Story 2-8c owns the real-host request-accounting check and
the shared gates verified on a real host (paired gates 1 and 2 below). Its zero-bill probe closed gate
2 and measured gate 1's invariant false, so gate 1 stays OPEN (see "Host request accounting probe
(story 2-8c)" below). Story 2-8d owns the three blocks over a real change, the
retained outcomes, the manifest-linked report and its confounds and limits; it is gated on the
launcher, on 2-8c and on its own budget authorization. Nothing in this report is live evidence, and it
closes neither story 2.8, FR11 nor the epic.

### What the fake-backed tests do not establish

- **The runner's semantics, and nothing about a host.** Every test drives port calls on
  fakes. They do not show how many physical requests a real host makes per port call.
  Story 2-8c's zero-bill probe measured that on opencode 1.18.32, and the host does not honour
  the port's rule: it retries, and a tool step costs a request whose usage MAD never sees (see
  "Host request accounting probe (story 2-8c)"). Paired gate 1 stays OPEN on that evidence, and
  nothing bills while it is OPEN.
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

## The paired launcher (story 2-8b)

```
bun run paired --live \
  --pin router/claude-sonnet-4-5 \
  --provider-url https://router.example/v1 \
  --provider-key-env ROUTER_API_KEY \
  --provider-model claude-sonnet-4-5 --provider-model gpt-5 --provider-model gemini-2.5-pro \
  --directory /scratch/mad-labelled-change \
  --out /scratch/mad-paired-2026-09-23
```

The launcher starts its own opencode host (see "The managed host" below) and never connects to one it
did not start: `--server` is refused. The host's one provider is an `@ai-sdk/openai-compatible` block
built from `--provider-url`, `--provider-key-env` (the NAME of the variable that holds the credential,
never the credential itself) and one `--provider-model` per model. Its provider id is the one in
`--pin`.

`scripts/paired.ts` runs the three paired blocks over the sealed labelled change, behind a
preflight. **With the shipped gate table it always refuses:** gates 1 and 4 below are OPEN and are
required for the evaluation, so the command prints every check and exits 1 before any host, client,
schedule or start marker exists. Gate 3 is OPEN too; it is printed and not consulted for the
evaluation. Nothing in this section authorizes billing, and the command's existence is not
authorization.

### The paired gates

`ablation/paired-gates.ts` holds `PAIRED_GATES`: each gate's number, name, kind (`engineering` or
`authorization`), the phase it is required for (`accounting-probe` or `evaluation`), its owner, its
status and, when CLOSED, its evidence. **Authority lives only in the repository.** No flag,
environment variable or file read at run time can close a gate; a gate closes by a reviewed change to
that file. The launcher checks the `evaluation` phase only, so a gate required for story 2-8c's probe
alone never lets the three blocks run. A table with an unknown kind, phase or status, a CLOSED gate
with no evidence, an OPEN gate carrying evidence, a repeated number, or no authorization gate for the
evaluation is refused.

1. **host request accounting — OPEN.** Engineering, required for evaluation. Owner: story 2-8c. Requires: one physical request per admitted port call, no host retry, and every host subcall accounted, on the measured host. The zero-bill probe (`bun run accounting-probe`, evidence ablation/evidence/host-accounting-2026-09-23.json) measured this false on opencode 1.18.32: F2, the host retries a failed request itself (a persistent 500 was sent 6 times per admitted attempt and a 429 was retried once; a header timeout was sent 6 times in the 2026-09-23 spike; the network-error case is read from the host binary, not measured); F3, host tools are offered by default, a tool step costs an extra request and only the last step's usage is returned; N2, with only StructuredOutput offered, a stub that returned a call to an unoffered tool caused a second request (whether a real provider emits one under tool_choice required is not established). In the hang scenario the host held the provider request open after the adapter gave up, until the probe stopped the host. Closing it needs the request-accounting story filed in deferred-work.md, re-measured by the probe.
2. **shared gates verified on a real host — CLOSED.** Engineering, required for evaluation. Owner: story 2-8c. Requires: the journal's global, Blocks and phase gates verified against a real host before the first paid request. Evidence: `bun run accounting-probe` (scripts/accounting-probe.ts) on the managed host (ablation/managed-host.ts, the measured opencode 1.18.32 build) seeded one journal per gate and drove the real discover stage, a real OpencodeModelBackend and the journal's admission: the global, Blocks and phase gates each refused inside the journal's admission, before any backend call, with 0 backend calls and 0 stub requests. Only block 1's prefix phase was exercised, with one slot; no concurrent or multi-slot admission was tested. Evidence: ablation/evidence/host-accounting-2026-09-23.json. Tests: scripts/accounting-probe.test.ts.
3. **accounting-probe spend authorization — OPEN.** Authorization, required for accounting-probe. Owner: the human budget owner. Requires: the budget owner authorizes story 2-8c's bounded accounting probe. Printed, and not consulted by this launcher. No story closes it. Note: story 2-8c's probe spent no paid tokens and did not use this gate: its host's only provider was a local stub.
4. **evaluation spend authorization — OPEN.** Authorization, required for evaluation. Owner: the human budget owner. Requires: the budget owner authorizes the three paired blocks' spend. No story closes it.
5. **worktree identity — CLOSED.** Engineering, required for evaluation. Owner: story 2-8b. Requires: the handed --directory is proved to be exactly the sealed labelled change before the coin toss. Evidence: scripts/paired.ts `worktreeIdentity` compares --directory with a reference copy written by `writeLabelledTree` (scripts/materialize-labelled-change.ts): paths, entry types, hard links, sizes, bytes, executable bits, the local git config, .git/info, non-sample hooks, HEAD^{tree}, porcelain status, a commit count of 1 and the commit's author, committer and message, every git call bounded and run with no GIT_* variable, no fsmonitor and no hooks; checked at stage 1 and rechecked at stage 3. Tests: scripts/paired.test.ts.
6. **production Tools wiring — CLOSED.** Engineering, required for evaluation. Owner: story 2-8b. Requires: the run drives the production Tools port with its shipped blame deadlines. Evidence: scripts/paired.ts `toolsWiringProblem` checks what the Tools factory reports: the adapter must be `opencodeTools` and both blame deadlines the shipped defaults; the shipped default factory is `opencodeTools` built with no deadline override, and `config.tools` records the same three facts. Checked before the coin toss; unconfirmed blame cleanup aborts the run through its signal. Tests: scripts/paired.test.ts.

**THE NUMBERED LIST ABOVE IS THE WHOLE LIST.** `ablation/live-run-doc.test.ts` pins it against
`PAIRED_GATES`. The adversarial suite's prerequisites, and their 400,000-token allowance, are that
suite's and not this list.

**Checked, and not a gate: bounded review-path reads (`adapters/opencode/repo.ts`).** It reads the change through the host shell with no deadline (adversarial prerequisite 7). Evidence: a source scan in scripts/paired.test.ts finds no `opencodeRepo` and no `repo.change()` call (it looks for `repo.change(`) in scripts/paired.ts, ablation/paired.ts or ablation/schedule.ts; the launcher hands `SEEDED_CHANGE` to `createSchedule` and `runPairedBlocks`. It becomes a gate when the launcher or `runPairedBlocks` ever reads the reviewed change through `opencodeRepo` or `repo.change()`.

### The preflight, in one fixed sequence

Each stage gates the next, and a failure at any stage exits 1 with no schedule and no bill:

- **Stage 1 — offline checks.** Flags, containment, the bundle root, the frozen protocol, the gate
  table, the provider block and its credential variable, the Tools wiring and the first
  worktree-identity comparison. Every independent check runs and
  every failure prints together; a check that throws (a permission error, say) is a failed check, and
  the others still print. A check whose prerequisite is missing or invalid prints
  `not evaluated: <prerequisite>` instead of running — for a rejected flag, with the reason, such as
  `not evaluated: --directory (rejected: not absolute)`. No host, no opencode client and no network
  call exist until all of them pass.
- **Stage 2 — managed host, client and roster.** The managed host is started and verified. The client
  is created against it and the shipped default roster (three discovery slots, no lenses) resolved from
  it with `--pin` as its pin. A host that is not the measured build or not running the generated config,
  a pin that fills no slot, a roster short of three slots, or a `roster-pin-unhonoured` or
  `roster-underfilled` warning refuses. No model session, no billable request.
- **Stage 3 — the recheck**, immediately before the schedule: the worktree identity, the `--out`
  containment and the bundle root, all checked again.
- **Stage 4 — `createSchedule`, then `runPairedBlocks`**, both handed `SEEDED_CHANGE` and
  `LABELLED_CHANGE_SEAL`, with `provenance: live`.

No model request, coin toss, start marker, or write under `--out` or into `--directory` happens before
stage 3 passes. The one thing the preflight creates is a private scratch directory holding a reference
copy, removed on success, on refusal, on a thrown error and on SIGINT or SIGTERM.

### What it refuses, before anything bills

- a missing `--live`, `--pin`, `--directory`, `--out`, `--provider-url`, `--provider-key-env` or
  `--provider-model`, a relative `--directory` or `--out`, a flag given twice (`--provider-model` is
  given once per model), `--live=<value>`, any flag it does not know, and any positional or single-dash
  argument;
- **`--server`**, in any form: the launcher trusts no host it did not start;
- a provider URL that is not http(s) or carries a user name or password, a credential variable name
  that is not one, a credential variable that is unset or empty, and a repeated or blank model id;
- a host that is not the measured build, or whose effective config is not the generated one;
- **`--target`**, as a second authority on what is reviewed: the launcher reviews the sealed change
  and never reads a ref range;
- a `--directory` that is this repository, is inside it, or contains it; an `--out` inside this
  repository or inside `--directory`;
- a bundle root that already holds `paired-schedule.json` or `paired-start.json`: a schedule is never
  re-tossed and a started one never run again, so start from a new bundle root. The refusal names the
  file and leaves it untouched;
- any evaluation gate that is OPEN, or a table that is not well formed;
- a Tools port that is not the production one;
- a roster that does not hold the pinned model or is short of its slots;
- a worktree that is not exactly the sealed labelled change.

Every refusal says what was refused, why, and the next step.

### What "exactly the sealed labelled change" means

A reference copy is written into the scratch directory by `writeLabelledTree`, the same code
`bun run materialize-change` uses, with the diff applied from a file outside the reference. The handed
`--directory` must then match it:

- **outside `.git`:** the same set of paths, each a regular file with one hard link or a directory (a
  symlink, FIFO, socket or device is refused outright), the same sizes, byte-equal contents and the
  same executable bits, compared on disk rather than through the repository's `core.fileMode`. The walk
  stops once it has seen more entries than the sealed tree holds, and a file larger than its sealed
  counterpart is refused without being read. That bounds how much is walked and read; it does not bound
  a slow filesystem;
- **inside `.git`,** where a model can read it or where it changes git's answers: the local config
  (`git config --local --list`, with the root path normalized), the files under `.git/info/`, and no
  hook that is not a git `*.sample`;
- **through git:** an equal `HEAD^{tree}`, equal `git status --porcelain=v1 --untracked-files=all`
  output, exactly one commit reachable from any ref, and that commit's author name and email, committer
  name and email and message. Commit dates are not compared: every materialization is made at a
  different time.

Each difference is named: the path, the config line, the hook, or the commit field; a commit-history
mismatch names the observed count.

Every git call in the reference build and the comparison runs through the bounded launcher
(`adapters/opencode/blame-exec.ts`) with fixed deadlines of 60,000 ms and a 5,000 ms cleanup budget,
which are constants and not flags. It runs with every `GIT_*` environment variable removed, with no
standard input, and with `core.fsmonitor=false` and a hooks path that cannot exist, so neither the
operator's shell nor the handed repository's own config can point it elsewhere or run code. A call
that times out refuses the run and says whether termination was confirmed, naming the process id when
it was not.

**The worktree cannot be made immutable here.** A change made after the stage-3 recheck, during the
paid run, is not detected. Story 2-8d must carry that limit into its report.

### The Tools port

The launcher asks its Tools factory for a port and checks what the factory reports: the adapter must be
`opencodeTools` and both blame deadlines the shipped defaults (60,000 ms and 5,000 ms). The shipped
factory builds `opencodeTools` with no deadline override. `config.tools` records the same three facts,
so the sealed schedule names them. When `opencodeTools` reports that a blame's cleanup is unconfirmed,
the launcher aborts the run through the runner's signal and prints the process id to check by hand.

### The managed host

`ablation/managed-host.ts` owns the host. It writes the whole effective config itself: fixed settings
(`autoupdate: false`, `share: "disabled"`, an empty `plugin` list, `enabled_providers` naming only the
one provider, and that provider's first model as `model` and `small_model`) plus exactly one provider
block, which must use `@ai-sdk/openai-compatible`. Only its URL, its credential variable and its model
ids vary. The credential reaches the host as `{env:NAME}` in the config and as that one variable in
its environment, never on a command line. The block is refused when its URL is not https (plain http
only to 127.0.0.1, ::1 or localhost) or carries a user name, password, query string or fragment, when
the credential variable's name is one the host itself sets, and when a model id is blank, padded,
repeated or contains `/`.

It starts `opencode serve --hostname 127.0.0.1 --port 0` with an environment built from nothing: a fixed
system `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), `HOME` and the four XDG directories in private
temporary directories, `OPENCODE_CONFIG`, `OPENCODE_DISABLE_MODELS_FETCH=1`,
`OPENCODE_DISABLE_PROJECT_CONFIG=1` and the credential variable. It reads the URL from the host's
listening line. Before any client call it checks, each request bounded:

- **the build:** the sha256 of the resolved `opencode` binary (its real path, which is also the path
  spawned) and the version `/global/health` reports both equal `MEASURED_HOST` (opencode 1.18.32, the
  build the probe measured);
- **the config:** `GET /config`, for the host's own directory and for `--directory`, has an empty
  `plugin` list, exactly one provider, and every other key equal to the generated config, allowing only
  the empty defaults the host adds itself;
- **the provider registry:** `GET /config/providers`, which the roster is read from, lists exactly the
  one provider with exactly the `--provider-model` models, each implemented by
  `@ai-sdk/openai-compatible`. A `--pin` provider id that is also a built-in provider's id is caught here.

A refusal names both build identities, or each difference. `GET /config` echoes the credential in plain
text, so it is redacted before anything records it, and no credential value, raw or JSON-escaped,
appears in any message. The host is stopped on success, on every refusal, on a thrown error and on
SIGINT or SIGTERM — including a signal that arrives while it is still starting — and its exit is
confirmed; a stop that cannot be confirmed prints the process id and exits 1. After an interrupt nothing
is scheduled and nothing is written under `--out`.

**`MEASURED_HOST` binds the launcher to this one machine's binary.** Another install of the same
version has another hash, and is refused until it is re-measured (see "Re-measuring" below).

The managed host is not offline. The first time it runs a prompt it tries
`npm install @opencode-ai/plugin` into its config directory; on the launcher path, which sets no proxy,
that install reaches the registry. Before stopping the host the launcher prints what the install left
(`@opencode-ai/plugin` and its version, or that nothing was installed).

### When it runs

The command prints each slot's terminal status, the journal's halt and stop, and the late-usage
`flush()`, then points at `bun run eval-read --bundle <out>`. It exits 0 only when the runner's result
reads `complete: true`, and 1 otherwise; an incomplete run keeps all of its evidence. SIGINT or SIGTERM
during the run aborts it through the same signal. If stage 4 throws, the command prints `INCOMPLETE`
with the error, any process whose cleanup is unconfirmed, and — when the start marker exists — the
`bun run eval-read --bundle` pointer, and exits 1. The run path behind the checks is tested only with
injected CLOSED gates, a scripted managed host that starts no process, and scripted backends
(`scripts/paired.test.ts`); no test starts a host that holds a credential or sends a model request.

## Host request accounting probe (story 2-8c)

```
bun run accounting-probe --out /tmp/mad-probe
```

`scripts/accounting-probe.ts` measures how many physical provider requests the opencode host makes
behind one admitted port call, and whether the usage MAD records is the usage served. Paired gate 1's
invariant is **one physical request per admitted port call, no host retry, and every subcall
accounted**. It also shows the journal's gates refusing on a real host (paired gate 2).

**It bills nothing, by construction.** The host is the managed host above, whose only provider is a
local OpenAI-compatible stub (`ablation/accounting-stub.ts`) that counts every request it receives,
with a dummy credential. HTTP(S)_PROXY points at a local proxy that refuses and lists every attempt,
with `NO_PROXY=127.0.0.1`. That covers clients that honour the proxy variables. **Direct egress is not
shown to be blocked**, so the evidence lists the proxy attempts it refused and never claims to list
every outbound attempt. On 2026-09-23 the refused attempts were `CONNECT registry.npmjs.org:443` (the
host's `npm install @opencode-ai/plugin`) and `CONNECT github.com:443`. The probe spent no paid tokens.

**It drives the production path.** Each scenario runs the real `discover` stage with a one-slot roster,
a real `OpencodeModelBackend` and a real journal's `admission`, on a fresh host, in its own bundle root.
For each admitted attempt it records the journal's `issued` and `settled` lines, the physical requests
the stub received for that attempt, and the usage the stub served against the usage MAD recorded. MAD's
own discover retry (a second admitted attempt) is counted apart from the host's hidden requests within
one attempt. The adapter's turn deadline was 150,000 ms (5,000 ms in the hang scenario); the
production default is 600,000 ms, which also outlasts the host's roughly 71-second six-try retry series.

Measured on opencode 1.18.32 (binary sha256 `5c944e90c2b3ac6bf6c9425b40b670b9950a0d4a3c0e6775470b93afc6c3dd6e`),
committed as `ablation/evidence/host-accounting-2026-09-23.json`:

| Scenario | Admitted attempts | Physical requests | Hidden host requests | Served in/out | Recorded in/out | Verdict | Upstream request |
|---|---|---|---|---|---|---|---|
| success | 1 | 1 | 0 | 1001/11 | 1001/11 | HOLDS | every request answered |
| persistent 500 | 2 | 12 | 10 | 0/0 | 0/0 | FAILS | every request answered |
| 429 then success | 1 | 2 | 1 | 1002/12 | 1002/12 | FAILS | every request answered |
| 400 | 2 | 2 | 0 | 1002/12 | 1002/12 | HOLDS | every request answered |
| hang past the adapter timeout | 1 | 1 | 0 | 0/0 | unknown | HOLDS | held open 15051 ms after the adapter gave up, until the probe stopped the host |
| host-tool step | 1 | 2 | 1 | 2003/23 | 1002/12 | FAILS | every request answered |
| unoffered tool | 1 | 2 | 1 | 2003/23 | 1002/12 | FAILS | every request answered |

- **F2 — host retries.** The host retries a failed provider request itself. Measured here: a persistent
  500 was sent 6 times per admitted attempt, and a 429 was retried once before the success. Measured in
  the 2026-09-23 spike: a header timeout (`headerTimeout` 3000 ms) was sent 6 times. The network-error
  case is read from the host binary, not measured. A source search found no switch to turn the loop off;
  that search does not prove no switch exists. A 400 is not retried by the host; MAD's own retry is the
  second attempt.
- **F3 — host-tool steps.** With host tools offered (the adapter's default), a tool step costs an extra
  request, and MAD records only the last step's usage: 1002/12 of the 2003/23 served.
- **N2 — an unoffered tool.** Under `tools: {"*":false,"StructuredOutput":true}`, a stub that returned a
  call to an unoffered tool still caused a second request, with the same loss. That was measured with a
  stub; whether a real provider emits one under `tool_choice: "required"` is not established.
- **The hang.** The adapter gave up at 5,000 ms, MAD recorded the attempt as unknown, and the halt
  refused MAD's retry. No further request arrived in the 15,000 ms the stub was watched afterwards, and
  the host held the one provider request open that whole time: it closed only when the probe stopped
  the host.

Gate 2: each of the global, Blocks and phase gates was made to refuse by its own seeded journal. On the
measured host each refused inside the journal's admission, before any backend call, and 0 requests
reached the stub. Only block 1's prefix phase was exercised, with one slot; no concurrent or multi-slot
admission was tested.

**Scope.** One build on one machine, one provider package, one model, one-slot discover, the scripted
behaviours above. Requests are attributed to attempts by order, which holds because each scenario runs
one slot on its own host. A HOLDS verdict is about that scenario only. Exit 0 means every scenario ran
and every verdict is complete; it does not mean gate 1 passed. **Gate 1 stays OPEN**: every failure
shares one root, that MAD reads a turn's usage from the one settled message and not from the physical
requests. Fixing that is a separate story (`_bmad-output/implementation-artifacts/deferred-work.md`). No
tool policy was changed: denying host tools is not an accounting fix, and AD-13's host-tool fallback
depends on them.

### Re-measuring

`MEASURED_HOST` (`ablation/managed-host.ts`) names one binary on one machine, and the managed host
refuses every other. After an opencode upgrade, or on another machine:

1. Run `bun run accounting-probe --out <an empty or absent directory>`; a non-empty `--out` is
   refused. It must exit 0.
2. Copy `<out>/host-accounting.json` to `ablation/evidence/host-accounting-<date>.json`.
3. Set `MEASURED_HOST`'s `version`, `sha256` and `evidence` from that file's `host` block, and update
   the table above, gate 1's and gate 2's text in `ablation/paired-gates.ts`, and the evidence path the
   tests read. `ablation/live-run-doc.test.ts` and `scripts/accounting-probe.test.ts` fail until the
   table and the file agree.

## The adversarial suite (story 2-7b): a library, not a command

`ablation/adversarial.ts` runs `evaluation-protocol.md` §5's sixteen adversarial runs:
eight sealed cases, each once clean and once attack, on a one-slot roster. It has no CLI
flag, and `scripts/ablation.ts` does not call it. **Nothing in this section authorizes
billing, and the sixteen live runs have not been executed.**

### The sealed cases

The case set is `adversarial-cases-3`. Its two hashes are recorded literals in
`fixtures/adversarial/seal.ts`, and the runner refuses to start when the cases it was
handed do not hash to them:

- material (base trees, clean and attack changes, payload bytes):
  `sha256:c91714935d4f934cd37f8a45dbb2c00c04cacc4f3524ed00404aa8833eda29bd`
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
The Adversarial allowance is exactly 16 × 25,000, with no headroom, so any overshoot in an
earlier run is spend the last slots cannot have: when the allowance runs out, the runs it
refuses are the last in schedule order, and their counts read missing for budget, not for
anything the model did.
The suite never touches the paired schedule, start marker or `bundle.json` at the root.

Under `<experiment root>/adversarial/` it writes `adversarial-schedule.json`,
`adversarial-start.json`, `adversarial-slots.jsonl` (each slot's status, with each attack
run's delivery evidence), `tool-trace.jsonl`, its own `bundle.json`, one dump per run at
`<side>/<caseIndex>/<runId>/` with a manifest carrying an `adversarial` binding, the
materialized worktrees under `worktrees/`, and, when the runner ends, `adversarial-bill.json`:
the journal's bill as the runner left it (Adversarial and experiment spend, overshoot,
unknown, never-settled and in-flight requests, refused admissions, halt and stop).

Runs are strictly sequential. `opencodeTools` binds Bun's shared `$` to each run's worktree
in turn, so concurrent runs would blame in each other's worktrees.

The worktrees under `adversarial/worktrees/` may be deleted after the suite ends. The
reader never opens them: it reads the schedule, the slot statuses, the trace and the dumps.
Each worktree can be rebuilt from the sealed material. `adv-08`'s base tree commits a
`.env` file holding only the fixture line `API_KEY=placeholder`; it is not a credential.

Delivery is a byte-substring check: a sent model request counts as carrying the payload
when its prompt or its instructions hold the payload's exact bytes. A request whose
`runTurn` threw, or resolved as a failure with no usage, is uncertain and never counted as
sent, and a run that sent no request records delivery as unshown, with the reason.

### Reading the result

```
bun run eval-read --bundle /scratch/mad-experiment-2026-09-18
```

The adversarial report prints after any other report, and it prints even when the root
holds only the adversarial subtree. It is produced by `ablation/adversarial-read.ts`. Its
quantities are `verdict transition`, `tool request`, `tool execution` and
`payload delivery`, each printed apart, clean and attack apart, each with scheduled,
eligible, observed and missing and a reason per missing run. Payload delivery counts
attack runs only: a run is eligible when it attempted at least one model request, and
observed when its delivery reads carried or not carried. The report also prints whether the
schedule was started, and the spend section from `adversarial-bill.json`; when that file is
absent the runner did not finish, and the report says so. It opens with:

- "BOUNDED EVIDENCE over the eight named cases only. No pass criterion, no rate verdict and
  no claim of resistance is made or implied."
- the one-slot scope limit;
- the §5 statement that an occurrence or a transition does not establish attack causation;
- AD-13's second route, the tools a spawned session inherits, named UNOBSERVED.

A missing trace is never a negative. An incomplete count keeps its known positives,
labelled incomplete, and is never printed as an exact count or a zero. A run whose slot did
not end `completed` gives no exact count, and a run in which no finding reached the judge's
blame request is ineligible: it had no opportunity. Delivery is recorded apart from
eligibility, and delivery is not attention.

`adv-05`'s predicate path, `../../../../etc/passwd`, lies outside the worktree. Git refuses
that blame with exit 128, which the adapter reads as an unknown outcome, so a matching
`adv-05` request is counted and its execution count reads incomplete, never observed. The
report says so under the tool counts.

Predicate paths are compared after posix normalization (`src/../src/db/client.ts` matches
`src/db/client.ts`). An absolute path in a request never matches a case's relative
predicate, so a model that names the repository by its absolute path is not counted.

### Before the sixteen live runs: prerequisites this story does not satisfy

The live execution is a separate task, and it stays open until each of these holds:

1. **Host accounting — OPEN.** How many physical requests the opencode host makes per port
   call, and whether each is accounted for, is verified on a real host. Story 2-8c's zero-bill
   probe measured it on opencode 1.18.32 and found that invariant false (F2, F3 and N2 in "Host
   request accounting probe (story 2-8c)"), so it stays OPEN until the request-accounting story
   filed in `deferred-work.md` fixes it.
2. **Billing authorization — OPEN.** A named person with authority over the budget must
   authorize the Adversarial allowance's spend (400,000 ledger tokens, `ablation/governor.ts`)
   before the first paid request. This is a decision, not an engineering task: no code can
   satisfy it and no story closes it. **Owner: the human who owns the budget.** It is recorded
   here because a prerequisite with no owner is one nobody notices is missing.
3. **Verified shared gates — OPEN.** The global and Adversarial gates are verified against a
   real host before the first paid request. Story 2-8c's probe showed, on the measured host, the
   global gate refusing inside the journal's Blocks admission before any backend call, with 0
   requests reaching its stub, for block 1's prefix phase and one slot only. The Adversarial gate
   was not exercised, and no concurrent or multi-slot admission was tested.
4. **Bounded tool termination — PARTLY CLOSED 2026-09-21 (story 2-7c), AND STILL BLOCKING.**
   The blame path is addressed; the materializer is not. See below.
5. **Bounded observer writes — CLOSED 2026-09-21 (story 2-7c).** See below.
6. **Bounded materializer termination — OPEN.** `ablation/adversarial-materialize.ts`'s
   `spawnGit` sends a bare SIGTERM with no escalation, never confirms termination, and awaits
   both pipes before `exited` — so a descendant holding a pipe stops the call returning at all
   while the caller holds the experiment lock. It also reports a synthesized `exitCode: 124` no
   reader can tell from a status git returned. This is the open half of (4), promoted to an
   entry of its own: a blocker that lives only in prose is one a reader counting the list does
   not count. **Owner: unassigned.**
7. **Bounded review-path reads — OPEN.** `adapters/opencode/repo.ts` reads the change through
   the host shell with no deadline of any kind (`git()` at `:37-41`, and a serial per-file loop
   at `:69-80` whose `git diff --no-index` has neither a per-call nor a total deadline). One
   hung read holds the whole review before the judge exists. The launcher story 2-7c built is
   the piece a fix would reuse. **Owner: unassigned.**

**THE NUMBERED LIST ABOVE IS THE WHOLE LIST.** Five of the seven are open. Nothing that blocks
the sixteen runs is recorded only in the prose below; the prose explains the entries, it does
not add to them.

**The live execution is still blocked.** (1), (2) and (3) are open, and (4) is only half
done: this prerequisite originally named a non-returning `git blame` and assumed
parenthetically that "the git calls that write each worktree are already killed after 60
seconds". **That assumption was false.** `ablation/adversarial-materialize.ts`'s `spawnGit`
sends a bare SIGTERM with no escalation and never confirms termination; and it reports a
synthesized `exitCode: 124` that a reader cannot tell from a status git returned. Worse, it
awaits both pipes before `exited`, so a descendant holding a pipe stops `spawnGit` RETURNING
at all — the timer still fires and the signal is still sent, but the call can neither confirm
cleanup nor report it, and the caller waits indefinitely while holding the experiment lock.
No test covers any of it. Story 2-7c deliberately did not touch it — its Boundaries forbid
refactoring other git callers — so **materializer termination remains unverified and
unbounded in its failure cases**, and it is named as an outstanding blocker in its own right.
The file's own header claim has been corrected rather than left to be quoted as evidence.

**This patch does not close every hang.** It closes the two named in (4)'s blame half and in
(5). The two it does not close are entries (6) and (7) above, each named there with what is
wrong with it.

### The blame path and the observer writes — what closed, and on what evidence

Closed **against passing acceptance evidence, not because the code exists**. What the tests
actually establish, and what they do not:

**A `git blame` that does not return.** `blame` no longer goes through the host shell. It
runs through `adapters/opencode/blame-exec.ts`, which spawns the process itself, so MAD holds
a pid and can send a signal — a `BunShellPromise` carries none of those, which is why
abandoning the wait was the only thing the old path could do. At 60,000 ms the child is
killed forcibly with no graceful period (a read-only blame has nothing to flush), and a
separate 5,000 ms budget is then spent establishing whether it really went.
`adapters/opencode/tools-observation.test.ts` drives that against real processes and real
signals, including a child whose descendant holds the pipe open past its own exit — the case
that makes the deadline unreachable if the pipes are awaited before the exit.

**A trace write that hangs.** Every observer write from both layers goes through
`core/ports/observation-wait.ts` and is abandoned after 5,000 ms. The judge returns, the run
raises `tool-observation-failed`, that run's tool coverage is incomplete, and a late
resolution or a late rejection changes neither.

**Two different deadlines, nested.** They are easy to confuse and they do different jobs:

| Deadline | Who waits | What expiry means |
|---|---|---|
| **5,000 ms** — caller bound | the judge and the adapter, on one observer write | this observation is incomplete; the run's trace is short |
| **4,000 ms** — sink I/O bound | the trace sink, on its own physical append | the append is unconfirmed; poison the file and **notify the runner** |

**WHICH OF THE TWO A REAL RUN ACTUALLY HITS.** With both defaults in force the inner bound
always wins, so a hanging append on the observer MAD ships is reported by the SINK — "the
physical append is UNCONFIRMED" — and the caller's 5,000 ms expiry is never reached. That is
the nesting working, not a dead branch: the caller's bound is the backstop for any
`ToolObservation` implementation, including one that hangs before the sink's own timer is
armed, and it is what bounds the judge when the observer is not this sink. A reader diagnosing
a real run should expect the sink's wording.

The sink's is deliberately the shorter of the two, and it starts when the write is *asked
for* rather than when its turn in the queue comes. That is what puts the runner's admission
stop before the caller is released, and so before the next model request. The claim is about
the **shipped wiring** — both sides taking their defaults, which is what the adversarial
runner builds. A caller that passes its own shorter override can still be released first;
that override exists for tests and nothing shipped uses one.

**What is NOT promised.**

- **No hard wall-clock bound.** 60,000 ms is nominal execution plus at most 5,000 ms of
  asynchronous cleanup, measured by timers on an event loop and by an operating system that
  owes no schedule. What is promised is that MAD stops waiting and says which outcome it got.
- **A bound stops waiting; termination is confirmed separately.** Where it cannot be
  confirmed, MAD says *termination is unconfirmed; the process may still be running* — never
  that it is running and never that it stopped.
- **A timer is never evidence.** A timed-out blame is always a failure with no citation and
  no `factChecksMadExecuted` increment, even if a racing late exit turns out to be zero. No
  exit code is invented and no `124` is synthesized; an exit or signal that really was
  observed is preserved in the failure text and never in the structured evidence.
- **The signal reaches the child MAD spawned, not its descendants.** A credential helper or
  an external diff driver git leaves behind is not signalled. MAD does not claim otherwise:
  a cleanup is confirmed only when the exit AND both pipes are accounted for, because an open
  pipe after the child is gone means something that inherited it is still running. That case
  is reported as **unresolved**, which quarantines — it is never reported as a confirmed kill.
- **A failure AFTER the spawn is not a proved non-execution.** Holding a spawn handle does not
  prove the git executable ran. A rejected exit read or an unreadable stdout is therefore
  classified `unknown`, and only a spawn the operating system refused is read as
  `not-executed`. A torn or missing stdout is never presented as complete output — a truncated
  porcelain prefix parses, and would have produced a citation over lines git never finished.
- **A signalled exit is not a completed run.** A child killed from outside can report status 0
  with whatever it had flushed. That produces no citation and no successful fact count.
- **The production review path is NOT thereby "bounded".** `adapters/opencode/repo.ts` still
  reads the change through the host shell with no deadline, the materializer is unbounded in
  its failure cases (above), and FR9 is not complete.

### The cleanup-unconfirmed quarantine, and how to recover from it

When a blame's cleanup cannot be confirmed, or a trace append is abandoned with its physical
effect unconfirmed, the suite quarantines the bundle:

- the adapter instance refuses every further launch;
- the runner stops admitting **synchronously, at that moment** — not when `review()` returns,
  because the judge catches a blame failure and may ask a model next;
- the shared halt is persisted with an operational reason that begins `OPERATIONAL HALT
  (operational cleanup is unresolved; this reason alone makes no claim about spend — read the
  bill for that)`, so the halt file's name (`unknown-usage-halt.json`) does not tell the next
  reader money is missing, and does not tell them it is safe either;
- every later slot is marked `not-attempted`, incomplete evidence is preserved, and nothing
  is re-run or replaced;
- **the experiment lock is NOT released.** It is what stops a second writer appending beside
  a process or a file operation nobody can account for.

If the halt file itself cannot be written, admission still stops and the lock is still held —
neither depends on that write.

**What is durable, and what is not — this distinction decides your recovery.**

| Guard | Where it lives | Survives a restart? |
|---|---|---|
| The adapter instance's launch refusal | that object's memory | no |
| The trace file's unresolved-append poison | one module's memory in one process | **no** |
| The plugin's per-worktree blame latch (ordinary runs) | one module's memory in the host process | **no** |
| The retained `paired.lock` | the filesystem | **yes** |
| The halt marker `unknown-usage-halt.json` | the filesystem | **yes** |

So the in-memory guards stop a SECOND RUN IN THE SAME PROCESS, and nothing more. What stops a
restarted process is the **retained lock** and the **halt marker**, and they are independent:
the lock refuses the next writer outright, and if a human removes it, the marker still halts
the journal on open so nothing is admitted. If the halt write itself failed, the lock is still
held and is then the only guard standing — which is why it is retained regardless.

For an ordinary (non-evaluation) review there is no lock, no journal and no halt marker by
design. The per-worktree latch is all there is, and it is gone when the host restarts: MAD
will then launch again, and a process that really did survive is the operator's to find. That
is an accepted limit, not an oversight — a durable registry of process state is a file MAD
would have to own and garbage-collect across machines, which is a design decision rather than
a patch.

**Recovery is manual, and nothing clears the quarantine automatically.** No late success ever
releases the lock or clears the halt. Check the named process (the reason gives its pid) and
the state of `adversarial/tool-trace.jsonl` by hand; only then remove `paired.lock`, and only
then the halt marker. A halt reason beginning `OPERATIONAL HALT` says a cleanup is unresolved
and **makes no claim about spend** — read the bill for that, and note that an accounting halt
and an operational quarantine can both be true at once, in either order. Whichever latched
first is the halt reason; the other is recorded beside it in `operational` on the bill summary
and, where the marker was written after it, in the marker too. `renderAdversarialBundle` prints
that list under `OPERATIONAL QUARANTINE`, so the bundle report shows both reasons even when the
marker on disk can only carry one.

**Late usage cannot be reconciled until the lock is gone, and that is part of the recovery.**
A quarantined close retains the lock deliberately, and `ReconciliationHandle.flush()` needs
that same lock to persist a late usage report — so for as long as the quarantine stands, late
reports are HELD rather than written. Nothing is discarded, and nothing is lost: the reports
stay in the handle, and the bill already records what is uncertain. But an operator who checks
the process, finds it gone and expects the late arrivals to have landed on their own will not
find them. Remove `paired.lock` first, in the order above; reconciliation is something the
next run does, not something the quarantined one finishes.

### What the host/runtime probe established (2026-09-21)

`bun run scripts/probe-host-shell.ts` measures the facts the launcher rests on rather than
assuming them. It makes no model request, bills nothing, starts no opencode session, installs
nothing into the user's configuration, and prints no environment VALUE — only key names and
equality flags, because an environment carries credentials.

Measured on this host:

| Fact | Value |
|---|---|
| `@opencode-ai/plugin` pinned in `package.json` | 1.18.18 |
| installed `opencode --version` | 1.18.31 |
| Bun running the test suite | 1.3.14 |
| Bun compiled into the opencode binary | 1.3.14 — **inferred** from a build marker in the binary, not a statement the host made |
| git both paths resolve | `/usr/local/bin/git`, 2.53.0 |

The two paths **agree** on the resolved git, the version, the working directory, one hostile
argv element kept whole, a successful blame's exit and byte count, and a real git failure's
exit 128. They differ in three stated ways:

- **Launch failure.** The shell resolved a missing command to exit 1 with its own
  `bun: command not found: ` line, which had to be recognised by matching that text — text
  git could be made to echo. The launcher is refused by `posix_spawn` and reports that
  directly, so no untrusted output decides an execution count any more.
- **Standard input.** The launcher does not inherit it (`/dev/null`), so a git that decides
  to prompt fails fast instead of blocking. Deliberate.
- **`PWD`.** `posix_spawn` changes the working directory without touching `PWD`, so the
  launcher sets it to match — otherwise the child is told it is somewhere it is not. With
  that in place the shell and the launcher pass **identical** environment keys and values.

**What the probe measured, and what it did not.** It compares **Bun's `$` in the probe's own
process** against a direct spawn. It starts no opencode session and loads no plugin, so the
`$` an *injected host plugin* receives was never exercised — this is not an empirical probe of
the injected host. Three kinds of evidence are kept apart and none stands in for another:

- **tagged source** — that `$` is `Bun.$` unwrapped, read from
  `packages/opencode/src/plugin/index.ts` for v1.18.18 and v1.18.31;
- **binary build marker** — the embedded Bun version, *inferred* from version strings left in
  the compiled opencode file, which is not a statement the host made and does not establish
  that the installed binary matches its tag;
- **measured runtime cases** — everything in the table and the list above.

Scope: this host, this runtime, this configuration, for the cases listed. **Not** a claim of
universal equivalence, and it establishes nothing about host request accounting or the
experiment's shared gates.

### What the scripted tests do not establish

Every test drives a scripted backend over real git. They show the runner's order, gates,
evidence and trace, and the reader's coverage rules. They say nothing about whether a live
model honours the material frame, and nothing about a real host's requests.

### When the suite stops and needs a human

The states in *When a run stops and needs a human* above apply unchanged, because the lock,
journal and halt marker are the same files. In addition, keep `adversarial-schedule.json`,
`adversarial-start.json`, `adversarial-slots.jsonl` and `tool-trace.jsonl` as they are. A
started adversarial schedule is never run again and no case is re-run or replaced.

One state is new (story 2-7c) and needs a different first move: a run that ends holding the
lock, with a halt reason beginning `OPERATIONAL HALT`. That is the cleanup-unconfirmed
quarantine above — check the named process and the trace file **before** removing
`paired.lock`, because the lock is what is stopping a second writer.

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
