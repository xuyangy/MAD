# MAD v1 — live compatibility evidence

This is the tracked summary of the evidence behind MAD's compatibility claims. The full records (authorizations, run entries N1 to N8, artifacts and verdict settlements) are in the validation spec's live-evidence record, a local file that is not among this repository's tracked files. This summary carries no credentials, run artifacts or content of the repository that was reviewed.

## What v1 targets

MAD targets opencode-ai 1.19.5, used through the TUI and through `opencode run`. Nothing here is a claim about another host version or route, about reliability in production, or about whether MAD's reviews are useful.

A route's verdict comes from the validation plan's ordered verdict rules: *not compatible*, *not established*, *compatible*, or *compatible with listed limitations*. Each verdict rests on authorized live runs, recorded before the claim was made.

## Verdicts

| Route | Verdict | Rendered | Rests on | MAD revision of the run |
| --- | --- | --- | --- | --- |
| TUI | compatible with listed limitations | 2026-11-17 | N8 | `7622913` |
| `opencode run` | compatible with listed limitations | 2026-11-16 | N5 | `e09ef1e` |

The TUI was *not compatible* on 2026-11-16 because V4's lineage warning was missing after an ordinary drop-out in N6: three verified model lineages were selected, two answered, and the report did not warn that fewer verified lineages answered. That was not a safety failure. `14dba29` fixed the warning with an offline regression test, and N8 re-checked it on a new authorized run: three verified lineages were selected, one answered after two ordinary drop-outs, and the report warned once, with the matching counts. Neither route's verdict is *compatible* without limitations, because a classified refusal and the replacement of a refused slot were not both observed live on it.

## The runs

Each run used opencode-ai 1.19.5, the outer agent `anthropic/claude-opus-5-5`, the `quick` preset, a 400000-token admission budget and three slots, and reviewed one uncommitted change in the same repository. Each left the reviewed repository and MAD's checkout unchanged, by before-and-after snapshots. N6 is kept beside the two current runs because it is the run N8 re-checked.

| | N5, `opencode run` | N6, TUI (superseded) | N8, TUI |
| --- | --- | --- | --- |
| Date | 2026-11-16 | 2026-11-16 | 2026-11-17 |
| MAD revision | `e09ef1e` | `e09ef1e` | `7622913` |
| Duration of the review | 16 s | 29 s | 2 min 43 s |
| Slots | `anthropic/claude-opus-5-5`, `openai/gpt-6-luna`, `opencode/nemotron-3.5-lightning-free`, all pinned | `openai/gpt-6-luna` pinned; `anthropic/claude-sonnet-4-6` and `opencode/deepseek-v4.1-flash-free` chosen by MAD, with `exclude` keeping out `anthropic/claude-opus-5-5` | as N6 |
| Answered discovery | 1 of 3: `openai/gpt-6-luna` | 2 of 3: `openai/gpt-6-luna`, `anthropic/claude-sonnet-4-6` | 1 of 3: `anthropic/claude-sonnet-4-6` |
| Why slots dropped out | `claude-opus-5-5` rejected the forced tool choice (classified as a capability refusal, not retried, not replaced because pinned); the free `opencode` model hit its usage limit | the free `opencode` model hit its usage limit | `openai/gpt-6-luna` failed both attempts on its account's usage limit; the free `opencode` model hit its usage limit; neither is a refusal |
| Findings | one, judged and upheld | two, each judged and upheld | one, judged and upheld |
| Known tokens (a floor) | 31192; 3 turns with unknown usage | 69376; 2 turns with unknown usage | 38361; 4 turns with unknown usage |
| Lineage warning | raised: 2 verified lineages selected, 1 answered | **not raised**: 3 verified lineages selected, 2 answered | raised: 3 verified lineages selected, 1 answered |

In every run, the host kept retrying the free model with its next try scheduled past MAD's turn deadline, and MAD settled each such turn at its first read of the host's session status, about five seconds in. In N8 the host also retried `openai/gpt-6-luna` within the turn's deadline, so MAD kept waiting, and each attempt took about 75 seconds. The outer agent's usage is not metered by MAD in any run.

## Criteria (V1 to V8)

| # | Offline | Live: TUI (N8) | Live: `opencode run` (N5) |
| --- | --- | --- | --- |
| V1 | passed | passed, partial: the filter's exclusions were not exercised | passed, partial: the filter's exclusions were not exercised |
| V2 | passed | not observed: no refusal | passed for a first-attempt refusal |
| V3 | passed | not observed: no refusal | not observed: the refused slot was pinned |
| V4 | passed | passed: the warning after ordinary drop-outs (N6 had failed it) | passed |
| V5 | passed | passed | passed |
| V6 | passed | passed | passed |
| V7 | passed | offline only, by design | offline only, by design |
| V8 | passed | passed by inference | passed by inference |

## Changes since the runs

N5 used `e09ef1e` and N8 used `7622913`. Between them:

- `14dba29` changes `core/stages/discover.ts` so that MAD warns whenever fewer verified lineages answer discovery than were selected, whatever the cause. N8 observed that warning live on the TUI after ordinary drop-outs.
- N5 raised the lineage warning after a refusal, the case MAD warned about before `14dba29`, so the `opencode run` verdict still holds. The new branch, a warning after a drop-out with no refusal, was observed on the TUI only.
- `117b938` changes only the license declared in `package.json`. The remaining commits change documentation and tests.

Commits after `7622913` are checked against these runs when the release's candidate revision is chosen.

## Residual limitations

- Replacement of a refused slot, the replacement session's policy check, a refusal in debate or the judge, and a refusal stopping MAD from asking the slots it covers have run only offline.
- A model that declares tool calling can still have an endpoint that rejects MAD's forced tool choice (`anthropic/claude-opus-5-5` in N5). Why is not established. `exclude` keeps such a route out, for the reviews it is passed to.
- A model at its usage limit, free or on a paid account, is retried once as an ordinary failure; it is not classified as a refusal. In N8 the host's own retries kept each such attempt on the pinned model waiting about 75 seconds.
- Few models answered: N5 and N8 each rested on one model, which also judged its own finding.
- The tool-calling filter's exclusions, and refusing a review when no offered model declares tool calling, were not exercised live.
- Every known token total is a floor, the outer agent's usage is unknown, and the budget is an admission budget, not a spend cap.
- A finding's line is the reviewing model's citation; two findings on one defect at different lines were not merged in N6.
- Which version of the host's authentication plugin loaded is unknown, and the host's config merge was not read in full.
- Four refusal shapes stay ordinary failures. `serverUrl` is not a supported plugin route.

## Release gates today

v1 is planned as a tagged source release. It needs both routes at least *compatible with listed limitations*, and both now are. Release preparation is still to do: choosing the candidate revision, setting the version, and running the offline suite, typecheck and lint on that revision.

## History

| Date | Revision | TUI | `opencode run` | Why |
| --- | --- | --- | --- | --- |
| reported 2026-11-04 | `12af673` | — | — | E1: registration observed by hand (`opencode serve` listed `mad_review`); not validation |
| reported 2026-11-05 | `f7efaa0` | — | — | E2, E3: one hand review per route, each resting on one model; not validation |
| 2026-11-09 | `f5a811f` | not established | not established | no live run was authorized (offline-only outcome) |
| 2026-11-11 | `4a309c3` | not established | not established | N1: the outer agent's model request was refused before MAD was invoked; the TUI was not attempted |
| 2026-11-12 | `c8c4934` | compatible with listed limitations | compatible with listed limitations | N3, N4 completed (after the outer-model probe N2); each took about 20 minutes |
| 2026-11-16 | `e09ef1e` | not compatible | compatible with listed limitations | N5, N6, above |
| 2026-11-17 | `7622913` | compatible with listed limitations | (not re-rendered) | N8, above: the TUI re-check of `14dba29` |
