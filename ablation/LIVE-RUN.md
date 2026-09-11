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
error is measured only on an 8-row, single-file, *within-run* labelled set. No
cross-arm labelled set exists. That error enters the difference count one for
one: an over-merge invents a matched pair whose two sides were never the same
defect, and an under-merge hides a real pair in `only in`. Read `only in` and
`ambiguous` beside the difference, never the difference alone.

**A degraded arm is not a measurement.** If any arm reports `DEGRADED`, the
report draws no experimental line from it. Fix the roster and run again.

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

**It is not computed yet, and the report says so.** A labelled run's report still prints
`not applicable — no seeded defect set for this change` for lens recall gain, because
`ablation/live.ts` passes `gain: undefined` on both paths. Matching a live arm's findings
against the thirteen labels is story 2.6; story 2.4 built the labelled change and the
withheld answer key, and deliberately took no measurement. Read that line as *not measured
yet*, not as *zero* and not as *impossible* — what changed is that the number now HAS a
reference set to be measured against, and the wording in the report will change with 2.6
rather than before it.

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

### What a labelled run does NOT give you

- **No precision, no false-positive count, no rate.** A finding no planted label covers is
  recorded as **unlabelled** and adjudicated by a human in
  `fixtures/seeded-defects/ADJUDICATION.md` — never counted as a false positive by default,
  which would score the thirteen-defect label set rather than the model
  (`evaluation-protocol.md:130`). Story 2.8 owns precision, under the protocol's bound
  arithmetic.
- **No cross-arm calibration.** The aligner's own error is still unmeasured on a cross-arm
  set; the paragraph above about `only in` and `ambiguous` is unchanged.

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
