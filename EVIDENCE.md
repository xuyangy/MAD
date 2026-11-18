# MAD v1 — live compatibility evidence

This is the tracked summary of the evidence behind MAD's compatibility claims. The full records (authorizations, run entries N1 to N8, artifacts and verdict settlements) are in the validation spec's live-evidence record, a local file that is not among this repository's tracked files. This summary carries no credentials, run artifacts or content of the repository that was reviewed.

## What v1 targets

MAD targets opencode-ai 1.19.5, used through the TUI and through `opencode run`. Nothing here is a claim about another host version or route, about reliability in production, or about whether MAD's reviews are useful.

A route's verdict comes from the validation plan's ordered verdict rules: *not compatible*, *not established*, *compatible*, or *compatible with listed limitations*. Each verdict rests on authorized live runs, recorded before the claim was made.

## Verdicts

| Route | Verdict | Rendered | Rests on | MAD revision of the run |
| --- | --- | --- | --- | --- |
| TUI | compatible with listed limitations | 2026-11-17 | N8 | `7622913` |
| `opencode run` | compatible with listed limitations | 2026-11-18 | N7 | `59d27dd` |

The TUI was *not compatible* on 2026-11-16 because V4's lineage warning was missing after an ordinary drop-out in N6: three verified model lineages were selected, two answered, and the report did not warn that fewer verified lineages answered. That was not a safety failure. `14dba29` fixed the warning with an offline regression test, and N8 re-checked it on a new authorized run: three verified lineages were selected, one answered after two ordinary drop-outs, and the report warned once, with the matching counts. Neither route's verdict is *compatible* without limitations, because a classified refusal and the replacement of a refused slot were not both observed live on it.

## The runs

Each run used opencode-ai 1.19.5, the outer agent `anthropic/claude-opus-5-5`, the `quick` preset, a 400000-token admission budget and three slots, and reviewed one uncommitted change in the same repository. Each left the reviewed repository and MAD's checkout unchanged, by before-and-after snapshots. N7 and N8 are the runs the verdicts rest on. N5 and N6 are kept beside them as superseded: N6 because N8 re-checked it, and N5 because it holds the only classified refusal observed live.

| | N7, `opencode run` | N8, TUI | N5, `opencode run` (superseded) | N6, TUI (superseded) |
| --- | --- | --- | --- | --- |
| Date | 2026-11-18 | 2026-11-17 | 2026-11-16 | 2026-11-16 |
| MAD revision | `59d27dd` | `7622913` | `e09ef1e` | `e09ef1e` |
| Duration of the review | 64 s | 2 min 43 s | 16 s | 29 s |
| Slots | `anthropic/claude-sonnet-4-6`, `openai/gpt-6-luna`, `openrouter/nvidia/nemotron-3.5-lightning:free`, all pinned | `openai/gpt-6-luna` pinned; `anthropic/claude-sonnet-4-6` and `opencode/deepseek-v4.1-flash-free` chosen by MAD, with `exclude` keeping out `anthropic/claude-opus-5-5` | `anthropic/claude-opus-5-5`, `openai/gpt-6-luna`, `opencode/nemotron-3.5-lightning-free`, all pinned | as N8 |
| Answered discovery | 3 of 3 | 1 of 3: `anthropic/claude-sonnet-4-6` | 1 of 3: `openai/gpt-6-luna` | 2 of 3: `openai/gpt-6-luna`, `anthropic/claude-sonnet-4-6` |
| Why slots dropped out | none dropped out; no turn failed | `openai/gpt-6-luna` failed both attempts on its account's usage limit; the free `opencode` model hit its usage limit; neither is a refusal | `claude-opus-5-5` rejected the forced tool choice (classified as a capability refusal, not retried, not replaced because pinned); the free `opencode` model hit its usage limit | the free `opencode` model hit its usage limit |
| Findings | two: one upheld (raised by all three models), one ruled invalid after a one-round debate | one, judged and upheld | one, judged and upheld | two, each judged and upheld |
| Known tokens | 178984; no turn with unknown usage | 38361 (a floor); 4 turns with unknown usage | 31192 (a floor); 3 turns with unknown usage | 69376 (a floor); 2 turns with unknown usage |
| Lineage warning | not due: 2 verified lineages selected (the OpenRouter model's lineage is unverified and was reported as such), both answered | raised: 3 verified lineages selected, 1 answered | raised: 2 verified lineages selected, 1 answered | **not raised**: 3 verified lineages selected, 2 answered |

In N5, N6 and N8, the host kept retrying a free `opencode` model with its next try scheduled past MAD's turn deadline, and MAD settled each such turn at its first read of the host's session status, about five seconds in. In N8 the host also retried `openai/gpt-6-luna` within the turn's deadline, so MAD kept waiting, and each attempt took about 75 seconds. In N7 no read of the host's session status showed a retry. The outer agent's usage is not metered by MAD in any run.

## Criteria (V1 to V8)

| # | Offline | Live: TUI (N8) | Live: `opencode run` (N7) |
| --- | --- | --- | --- |
| V1 | passed | passed, partial: the filter's exclusions were not exercised | passed, partial: every slot was pinned, so the filter's exclusions were not exercised |
| V2 | passed | not observed: no refusal | not observed: no refusal (N5 passed it for a first-attempt refusal) |
| V3 | passed | not observed: no refusal | not observed: no refusal, and every slot was pinned |
| V4 | passed | passed: the warning after ordinary drop-outs (N6 had failed it) | passed: no warning was due |
| V5 | passed | passed | passed |
| V6 | passed | passed | passed |
| V7 | passed | offline only, by design | offline only, by design |
| V8 | passed | passed by inference | passed by inference |

## Changes since the runs

N8 used `7622913` and N7 used `59d27dd`. Commits after `7622913` change documentation, tests and `package.json` metadata (`version` and `description`) only, with no runtime code change: `7622913`, `784c004` (the v1.0.0 candidate) and `59d27dd` run the same code, so N7's and N8's compatibility claims hold for the v1.0.0 candidate revision.

- Both runs include `14dba29`, which changes `core/stages/discover.ts` so that MAD warns whenever fewer verified lineages answer discovery than were selected, whatever the cause. N8 observed that warning live on the TUI after ordinary drop-outs. In N7 every verified lineage answered, so the warning was not due.
- The superseded runs N5 and N6 used `e09ef1e`, before `14dba29`.

## Residual limitations

- Replacement of a refused slot, the replacement session's policy check, a refusal in debate or the judge, and a refusal stopping MAD from asking the slots it covers have run only offline.
- A model that declares tool calling can still have an endpoint that rejects MAD's forced tool choice (`anthropic/claude-opus-5-5` in N5). Why is not established. `exclude` keeps such a route out, for the reviews it is passed to.
- A model at its usage limit, free or on a paid account, is retried once as an ordinary failure; it is not classified as a refusal. In N8 the host's own retries kept each such attempt on the pinned model waiting about 75 seconds.
- Few models answered in N8, which rested on one model that also judged its own finding. In N7 all three answered.
- MAD's lineage table does not know the OpenRouter model `nvidia/nemotron-3.5-lightning:free`, so N7 counted two verified lineages of three slots. Which upstream OpenRouter routed it to, and that upstream's logging and retention terms, are unknown.
- The tool-calling filter's exclusions, and refusing a review when no offered model declares tool calling, were not exercised live.
- A known token total is a floor when a turn's usage was unknown (N5, N6, N8); the host may bill steps MAD does not meter, the outer agent's usage is unknown, and the budget is an admission budget, not a spend cap.
- A finding's line is the reviewing model's citation; two findings on one defect at different lines were not merged in N6.
- Which version of the host's authentication plugin loaded is unknown, and the host's config merge was not read in full.
- Four refusal shapes stay ordinary failures. `serverUrl` is not a supported plugin route.

## Release gates today

v1 is a tagged source release. Both routes meet its route bar, *compatible with listed limitations*. The offline suite, typecheck and lint pass on `784c004`, the v1.0.0 candidate revision, and every v1 gate holds for it. The annotated tag `v1.0.0` marks that revision. The release gate rested on N5 and N8; N7 ran after the tag, on the same runtime code, and now carries the `opencode run` verdict, which it left unchanged.

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
| 2026-11-18 | `59d27dd` | (not re-rendered) | compatible with listed limitations | N7, above: an `opencode run` review with an OpenRouter model, on v1.0.0's runtime code |
