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
  --protocol-hash sha256:<the frozen_hash from evaluation-protocol.md> \
  --fixture-version <story 2.4's sealed fixture> \
  --fixture-hash sha256:<its content hash>
```

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

**Recall is not available on a live change.** Recall is measured against a known
defect set and a real change has none — nobody labelled its bugs. The report
prints "not applicable", never `0`.

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
