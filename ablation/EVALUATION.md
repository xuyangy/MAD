# The paired evaluation of the debate pathway: published outcome (run 5)

This is the publication of epic 2's paired evaluation (FR11, story 2.8, child 2-8d). On 2026-10-08
the review channel (a standing reviewer agent deciding in the human's place) selected run 5 of the
OAuth paired evaluation as the evaluation's final outcome. There is no run 6. The decision is
recorded in the 2-8d DISPOSITION note in `_bmad-output/implementation-artifacts/sprint-status.yaml`,
a local file that is not committed (the path is gitignored).

## Summary

- An **accepted incomplete outcome**: 2 of 3 paired blocks completed, 3 of 3 were measured.
- ON − OFF continuation attempts: **26** in block 1 and **17** in block 3. Block 2's contrast is
  unavailable.
- Planted-defect matcher recall is **equal between the arms in every block**.
- Precision is **unavailable**: no truth sheet exists.
- No product-value verdict is given.

## Sources

Two sources are cited, by name, beside each figure:

- **The reader output**,
  [`evidence/paired-oauth-evaluation-run-5-eval-read.txt`](evidence/paired-oauth-evaluation-run-5-eval-read.txt),
  cited by the section heading it prints (EXECUTION COVERAGE, COST, MAD LABELLED RECALL and so on).
- **The run record**,
  [`evidence/paired-oauth-evaluation-run-5-2026-10-07.json`](evidence/paired-oauth-evaluation-run-5-2026-10-07.json),
  cited by field (`host`, `roster`, `anthropic`, `attempts`), for facts the reader does not print.

Section 8 also cites runs 1 to 4's evidence files. The only arithmetic done here is named where it is
done: the 153 total (section 3) and the cumulative exposure (section 8).

## Evidence

- **The raw bundle, retained.**
  [`evidence/paired-oauth-evaluation-run-5-bundle/`](evidence/paired-oauth-evaluation-run-5-bundle/)
  is a byte-for-byte copy of the bundle at the `out` path the run-5 reservation records,
  `/Users/xuyangy/trash/mad-runs/bundle-run5`
  ([`evidence/paired-oauth-evaluation-run-5.reservation`](evidence/paired-oauth-evaluation-run-5.reservation)):
  68 files, 3,794,958 bytes, no symlinks. That path is the bundle's original location; this
  directory is the retained evidence. `SHA256SUMS` beside them is an added retention
  inventory, with paths relative to the bundle root; it is not one of the 68 source files.
  `.gitattributes` marks the bundle and the reader output `-text`, so git never converts their line
  endings.
- **Copy comparison.** Each retained file was compared with its source by `cmp`, and the two file
  lists were checked equal, before `SHA256SUMS` was written and verified with `shasum -a 256 -c`. The
  source stays outside the repository, so a later reader can re-verify the retained files against
  `SHA256SUMS` only, not against the source.
- **Auth material.** Before copying, every file was scanned with `grep` for token and key patterns,
  sign-in and session words, e-mail addresses, absolute paths and long opaque strings, the free text
  in reports, inputs and records included. The scan's output was not retained. Nothing was found:
  "credential" occurs only in review prose about the fixture's planted card-number defect, "oauth"
  only as the route name, and the only absolute paths are the bundle's own run directories at its
  original location. The scan is a check, not proof of absence. No OAuth auth, data directory or
  prepared state is retained.
- **The reader output.** The committed file is a header line naming the reader commit, then the
  reader's stdout alone, verbatim. Emitted paths are not rewritten. Recorded separately:
  - reader commit: `c66b06988785edc7ef6bd97b46713980c07e603e`
  - command: `bun run eval-read --bundle ablation/evidence/paired-oauth-evaluation-run-5-bundle`
  - working directory: the repository root, `/Users/xuyangy/trash/git2/MAD`
  - exit code: 0
  - stderr: the package script's echo,
    `$ bun run scripts/eval-read.ts --bundle "ablation/evidence/paired-oauth-evaluation-run-5-bundle"`

  A replay at another checkout path may differ in path text only. That is not changed numerical
  evidence. The file is the record at that commit and is never regenerated; a later reader's output
  would be a new dated file.
- **Integrity.** [`evaluation-publication.test.ts`](evaluation-publication.test.ts) fails on any
  retained file missing from, added to, or changed against `SHA256SUMS`, naming the file. It also
  checks the count and byte total, and that the reader prints the committed output over the retained
  copy. It establishes consistency with the committed hashes, not the independent authenticity of
  the original execution.
- **No truth sheet.** This story produces none. The reader looks for one at
  `<bundle>/adjudication.json`, so a later arm-blind sheet could not be added to this retained bundle
  without changing its inventory and the reader output. It would be a separate, dated publication
  with its own retained copy. This publication and its inventory stay as they are.

## 1. Disposition

Run 5 is an **accepted incomplete outcome, not completed execution.** Under protocol v2 A10
(`_bmad-output/specs/spec-mad-orchestrator/evaluation-protocol-v2.md:223-225`), *complete* on the
OAuth route means every slot completed. One of run 5's six slots failed, so the run is
`complete: false`: 5 of 6 continuations and 2 of 3 paired blocks completed (reader, SLOT COVERAGE
and EXECUTION COVERAGE).

Protocol v1's *No replacement* rule (`_bmad-output/specs/spec-mad-orchestrator/evaluation-protocol.md:192-193`,
`:315-316`) stands: a block that cannot complete is recorded failed and is not replaced. No block
is re-run, and no block from another run stands in for one.

Closure of story 2-8d, of story 2.8 (FR11) and of epic 2 follows review of this publication. This
document does not close them.

## 2. Coverage

From the reader's EXECUTION COVERAGE and SLOT COVERAGE:

- **3 scheduled blocks, 2 completed, 3 measured.** A block is completed when both continuations are
  recorded completed in `paired-slots.jsonl`, and measured when both arms were read into a pair.
- **Block 2's ON continuation failed.** Its allowance was exhausted at 45 of 45 admitted attempts, and
  a gate denied it planned work: 1 admission was refused on budget (on judge/discovery-2 attempt 1),
  and 2 findings were left unresolved, `finding-0muxurdss-001n` and `finding-0muxurdss-001s` (reader,
  MAD ADJUDICATION, block 2). The 45 attempts include 1 retry, on judge/discovery-2, which counted
  toward the allowance (reader, COST). Its OFF continuation and the other four slots completed.
- The allowance bound was reached. The cost of completing block 2's ON continuation is not known.
- **Every arm is `degraded`** (reader, COMPARABLE ARMS). All six carry `roster-single-lineage` and
  `blame-unavailable`; on/0 also carries `model-dropped-out`, and on/1 `unresolved-findings`. Every
  arm also carries the disclosure `provider-fan-out`, which names the providers a run sends code to;
  it is a disclosure, not a degradation.

## 3. Cost

From the reader's COST. The unit is **newly issued MAD attempts** (protocol v2 A8): the shared prefix
once plus both continuations, each admitted attempt once, retries included. It is a workflow-use
contrast, never token cost, money, subscription quota or a physical request count.

| block | shared prefix | ON continuation | OFF continuation | block total | ON − OFF |
|---|---|---|---|---|---|
| 1 | 5 | 35 (1 retry) | 9 | 49 | 26 |
| 2 | 5 | 45 (1 retry) | 14 | 64 | unavailable |
| 3 | 5 | 26 | 9 | 40 | 17 |

- **Total: 153 newly issued attempts**, the sum of the reader's block totals 49 + 64 + 40, with the 2
  retries included and each shared prefix counted once. It matches the run record's
  `attempts.admitted`.
- Blocks 1 and 3 (ON − OFF 26 and 17) are **descriptive** observations.
- **Block 2's ON − OFF is unavailable under A8, not 31.** A8 withholds the contrast while either
  continuation did not complete, because a truncated continuation would read as a difference.
- No planned three-block cost summary is formed from the two available blocks.
- **Thresholds, as observed.** Protocol v2 A7 registers 10 attempts for each shared prefix and 45 for
  each continuation, out of 100 per block (`evaluation-protocol-v2.md:162-165`); gate 4's
  authorization restates the 100 per block. Each prefix realised 5 of 10. The ON continuations
  realised 35, 45 and 26 of 45; the OFF continuations 9, 14 and 9 of 45. These are observations, not
  a claim that the allowance was tight or loose.
- **By slot.** In block 3 the OFF arm issued no judge/discovery-1 attempt: judge/discovery-2 issued 5
  and judge/discovery-3 issued 4. That is observed; its cause is not established here.

## 4. Precision, final recall and lost true candidates

From the reader's AVAILABILITY, PRECISION and FINAL RECALL:

- **Precision difference: unavailable, 0/3. Lost true candidates: unavailable, 0/3.** The reason is
  exact: no arm-blind truth sheet exists (the reader prints "truth labels unavailable: no
  adjudication sheet" for every block). No truth is inferred from matcher proximity, and no planned
  three-block precision summary is formed.
- **Planted-defect matcher recall per arm** (a preservation diagnostic, not truth-sheet recall):

  | block | ON | OFF | ON − OFF |
  |---|---|---|---|
  | 1 | 6 of 13 | 6 of 13 | 0 of 13 |
  | 2 | 9 of 13 | 9 of 13 | 0 of 13 |
  | 3 | 6 of 13 | 6 of 13 | 0 of 13 |

  The two arms match in every block. **A zero difference is not equivalence.**
- **Block 2's 9 of 13 is printed for both arms.** The ON continuation failed with 2 findings
  unresolved, so its 9 of 13 is neither truth-adjudicated recall nor the recall of a completed
  execution.
- **Upheld findings per arm**, a verdict-only count that needs no truth (reader, MAD LABELLED RECALL,
  UPHELD FINDINGS PER ARM). U is the upheld findings no planted label claimed. **U is never a
  false-positive count.**

  | block | ON upheld | ON U | OFF upheld | OFF U |
  |---|---|---|---|---|
  | 1 | 7 | 1 | 8 | 2 |
  | 2 | 12 | 3 | 14 | 5 |
  | 3 | 9 | 3 | 8 | 2 |

**Secondary diagnostics: CAP-1 and CAP-11** (protocol v2 A2), from the reader's MAD LABELLED RECALL.
Both are read from each block's shared discovery prefix and are available in 3 of 3 blocks.

| block | CAP-1 pool union | best answered pool slot | union minus best | CAP-11 lens-only defects |
|---|---|---|---|---|
| 1 | 9 of 13 | `discovery-1`, 8 of 13 | 1 | 2 of 13 |
| 2 | 8 of 13 | `discovery-1`, `discovery-3` (tied), 7 of 13 | 1 | 2 of 13 |
| 3 | 7 of 13 | `discovery-1`, 7 of 13 | 0 | 2 of 13 |

- CAP-1 is **within-prefix attribution**: the union of the answered pool slots against the best
  single answered pool slot of the same discovery pass. CAP-11 is **lens-only coverage**: the
  planted defects the answered lens slots raised that no answered pool slot raised in that pass.
- They are not independently executed single-model or no-lens experiments, and they are not
  precision.
- Block 2's prefix diagnostic stands. Neither arm's failure erases a valid shared-prefix diagnostic:
  the prefix record is the one both continuations were forked from.

## 5. Verdicts

From the reader's MAD PAIRED CONTRAST, per block:

- **Block 1:** verdict-state differences 1 of 9, one exchange: `finding-0muxufnb4-0008`, ON
  not-adjudicated and OFF upheld.
- **Block 3:** verdict-state differences 1 of 9, the reverse: `finding-0muxv9oi3-002j`, ON upheld
  and OFF not-adjudicated.
- **Block 2:** 0 of 12 differences among the candidates both arms decided, and 2 of 14 undecided
  transitions: the ON arm's 2 unresolved findings.

**None of these is a correction.** No truth label enters them, so none says which arm was right.
The paired section counts `not-adjudicated` as a settled state; the adjudication section treats it
as non-decisive, which is why it lists blocks 1 and 3's exchanges as undecided transitions.

## 6. Contrast

The contrast identified is the **deployed debate-plus-judge pathway** against direct fact-checking
of the same candidates. It does not measure conversation with the judge pipeline held fixed.

From the reader's TREATMENT OPPORTUNITY: the OFF arm sent 6 of 9, 11 of 14 and 4 of 9 candidates to
the judge that the shipped policy would have debated, in blocks 1, 2 and 3. In each block the ON
arm's debate stage ran, and it debated 6, 11 and 4 candidates, exactly the OFF arm's
would-have-debated counts. That is consistent with both arms applying the same routing
classification to the shared candidates; it does not prove it.

## 7. Confounds and limits

**Model and roster.**

- 3 pool slots: `openai/gpt-6-sol`, `anthropic/claude-sonnet-5` and `github-copilot/gpt-6-luna`
  (reader, COST, by stage and slot). `roster-single-lineage` is raised when the roster resolves to
  fewer distinct lineages than slots (`core/domain/warning.ts`): these 3 slots have 2 verified
  distinct lineages, GPT and Claude (run record, `roster.lineages`). The lineage count is lower than
  the pool-slot count, which triggers the warning on every arm.
- The roster includes two lens slots, `openai/gpt-5.6-terra-fast` (security) and
  `github-copilot/claude-haiku-4.5` (reliability), which add coverage and no lineage. They take part
  in the shared discovery prefix and also in the ON arm's debate stage (`on debate/discovery-lens-*`
  attempts in every block, reader, COST).
- `git blame` was unavailable in every arm (`blame-unavailable` on all six, reader, COMPARABLE ARMS).
- In block 1's ON continuation, the judge's evidence-extract step on `anthropic/claude-sonnet-5`
  failed output validation twice, and that judge run continued without it: `model-dropped-out` on
  on/0 (run record, `anthropic`; commit c66b069's message states the same).

**Run conditions.**

- **Anonymizer.** The judge's anonymizer seeds its permutation from the arm's run id together with
  each finding's id, so the order is drawn per finding, and the two arms of a block can show the
  judge the same exchange in different orders (reader, CONFOUNDS). Nothing corrects for it.
- **Order.** The coin came up tails, so the first arms across blocks 1, 2 and 3 were OFF, ON, OFF
  (reader, MAD PAIRED CONTRAST). ON ran second in blocks 1 and 3, 2 of 3 blocks. Any drift between a
  block's two continuations is therefore confounded with ON twice and with OFF once. An odd number of
  blocks cannot balance first-arm order.

**Provenance and configuration.**

- Host: opencode 1.18.32, binary sha256 `5c944e90c2b3ac6bf6c9425b40b670b9950a0d4a3c0e6775470b93afc6c3dd6e`
  (run record, `host`). Sealed schedule `sha256:70cb3f0389e88cf8188aa14903f723d316f1f3a480454349db9280e3e2505a16`
  (reader, MAD PAIRED CONTRAST).
- Each paired turn was offered read-only tools: Read, Glob, Grep and StructuredOutput (run record,
  `host`).
- The manifests record commit ba9976676e56fc131b9ee62a65f54526d150d212 and dirty:true. The
  identities/content of dirty entries were not retained, so the exact source state at execution is
  not established by that commit. The flag includes untracked files and does not itself prove
  executable source differed from the commit.
- Three provenance claims are kept apart. Runtime-source provenance is the commit and dirty flag
  above. The sealed fixture hashes establish which change was reviewed: the schedule's fixture and
  every bound arm's fixture hash match the sealed material hash (reader, MAD LABELLED RECALL). They
  say nothing about MAD's own source. The retained outcomes' integrity is `SHA256SUMS` and its test,
  which says nothing about either.

**Cost measurement.**

- Host-reported tokens are unverified diagnostics and enter no figure. Token spend and subscription
  quota are not measured; the host's own retries, tool steps and held-open requests are not counted
  (reader, COST).
- The six OAuth residual risks in `ablation/LIVE-RUN.md` ("Residual risks on the OAuth route") stay
  open. Concretely, for run 5:
  - **Runtime code fetch.** The production launch has no OS-level egress control. Nothing prevents
    a code fetch beyond the pinned plugin and config seed.
  - **Startup connection.** The host connects to `api.githubcopilot.com:443` at startup, carrying
    the real Copilot sign-in, before MAD admits any attempt.
  - **Hidden host retries.** A host retry is neither gated nor counted, so an admitted attempt
    bounds neither physical requests nor subscription quota.
  - **`small_model`.** It is the first pin, `openai/gpt-6-sol` (run record, `billing`). opencode's
    side requests, such as session titles and summaries, go to it outside every attempt count.
  - **Refresh write-through.** The auth symlink's readlink checks before the spawn and after the
    exit detect a replaced or retargeted link. They do not establish where a token refresh writes.
  - **Persistent host state.** Run 5 used a fresh data directory (run record, `command`), but that
    does not establish the absence of cross-block state effects within the run. The store guard's
    zeros cover only its guarded tables. They do not cover opencode's logs, its `project` and
    `event` rows, or the six unguarded session-capable tables `session_message`, `session_entry`,
    `session_input`, `todo`, `session_share` and `workspace`.

**Scope.** One change (labelled-change-1, 13 planted defects, reader, MAD LABELLED RECALL), one
configuration, three blocks of descriptive evidence. No significance claim is available from them.

## 8. History

Runs 1 to 4 are earlier executions of the same evaluation. Each stands on its own. None is pooled
with run 5, and no block is selected across runs. Admitted attempts are read from each run's
evidence file (`attempts.admitted`; for run 1, its `billing` field: no attempt was admitted).

| run | outcome | admitted attempts | evidence |
|---|---|---|---|
| 1 | FAILED at stage 2: the host's `GET /config` had no answer within 10000 ms; no block ran | 0 (no attempt admitted) | `evidence/paired-oauth-evaluation-run-1-2026-10-02.json`, diagnosis `evidence/paired-oauth-evaluation-run-1-diagnosis-2026-10-02.json` |
| 2 | HALTED in block 1's ON continuation: a judge attempt timed out at its 600000 ms deadline; 0 of 3 blocks completed | 26 | `evidence/paired-oauth-evaluation-run-2-2026-10-02.json` |
| 3 | CANCELLED by the human in block 1's shared prefix after a provider substitution; no continuation started | 6 | `evidence/paired-oauth-evaluation-run-3-2026-10-02.json` |
| 4 | HALTED in block 1's ON continuation: a debate attempt timed out at its 600000 ms deadline; 0 of 3 blocks completed | 23 | `evidence/paired-oauth-evaluation-run-4-2026-10-05.json` |
| 5 | INCOMPLETE, no halt: block 2's ON continuation reached its allowance; 2 of 3 blocks completed | 153 | `evidence/paired-oauth-evaluation-run-5-2026-10-07.json`, this publication |

**The configuration changed between runs** (each run record's `command` and `roster` fields):

- **Runs 1 and 2** pinned `openai/gpt-6-luna`, `anthropic/claude-opus-5-5` and
  `github-copilot/gpt-5-mini`.
  - Run 2 had two separate failures (run record, `status` and its discovery note):
    - The Anthropic sign-in had expired before the run (`Refresh token expired`), so
      discovery-2 was dropped.
    - Later, a judge attempt on `github-copilot/gpt-5-mini` timed out at its deadline, which
      halted the run.
- **Run 3** pinned `openai/gpt-6-sol`, `anthropic/claude-opus-5-5` and `github-copilot/gpt-6-luna`.
  The pin `github-copilot/gpt-6-luna` filled discovery-3 through openai, not the provider it names
  (run record, `roster.deviation`). AD-4 was amended afterwards so that a pinned slot is served by
  the provider its pin names.
- **Runs 4 and 5** pinned `openai/gpt-6-sol`, `anthropic/claude-sonnet-5` and
  `github-copilot/gpt-6-luna`, each served by the provider it names.
  - Run 4 halted when a debate attempt on `anthropic/claude-sonnet-5` timed out at its 600000 ms
    deadline. Its record does not establish why that attempt waited.
  - Before run 5, commit 67811a0 restricted each paired turn to Read, Glob, Grep and
    StructuredOutput, with a host permission block (run 5's record, `host`). Run 5 is the only run
    with that tool offer.
  - It is not established that run 4's wait was a permission ask.

**Exposure history, not pooled results.** Across runs 1 to 5, 0 + 26 + 6 + 23 + 153 = 208 MAD
attempts were admitted against the same labelled change, under the differing configurations above. This counts exposure only: no result of
runs 1 to 4 enters any figure above.

The committed run-5 record's coverage heading, quoted there from the reader of its day as
"completed: 3 of 3", was wrong: it counted measured blocks. The current reader prints 2 of 3
completed and 3 of 3 measured.

## 9. What this publication does not say

It returns no earned / did-not-earn verdict and no keep / remove recommendation. Product value is
not assessed, by design.
