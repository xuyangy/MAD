---
title: 'Story 2-8d — the live paired evaluation on the OAuth route: run 3 proposal'
created: '2026-10-02'
status: 'draft for review'
decides: 'the human (gate 4, for run 3)'
---

# The live paired evaluation on the OAuth route: run 3 proposal

**Status: a proposal for the review channel (window 2), then for the human.** Nothing here has run, and it
authorizes nothing. Gate 4 is OPEN: runs 1 and 2 of this evaluation used its earlier authorizations,
against `2-8d-run-proposal.md`. Gate 7 is CLOSED and protocol v2 is frozen (2026-10-02); the one
decision left is gate 4, for run 3.

## What changes from runs 1 and 2

- **Roster.** Run 3 pins `openai/gpt-6-sol`, `anthropic/claude-opus-5-5` and `github-copilot/gpt-6-luna`,
  in that `--pin` order. Run 2's `github-copilot/gpt-5-mini` held a judge attempt open past its 600 s
  deadline and so halted the run; `github-copilot/gpt-6-luna` replaces it. One model reached through two
  providers holds one roster slot (AD-4), so `openai/gpt-6-luna` gives way to `openai/gpt-6-sol`. The
  first pin, now `openai/gpt-6-sol`, is also `small_model` (risk 4).
- **Lens slots.** Roster selection chooses their models from the host's catalogue, not from the pins, so
  they are expected to be run 2's: `openai/gpt-5.6-terra-fast` (security) and
  `github-copilot/claude-haiku-4.5` (reliability). Stage 1 binds the three pool pins only; the lens
  models are printed at stage 2 and recorded in the sealed roster.
- **Same accounting, allowances and endpoint** as runs 1 and 2 (below).

## What would run

`bun run paired --live --provider-mode oauth`: the three paired blocks over the sealed labelled change,
debate ON against OFF, sealed before the coin toss.
- **Accounting:** attempt mode on the OAuth route (v2 A6–A10). One admitted attempt is one `runTurn` that
  passed its stage's ledger gate and the experiment's admission and was issued, retries included.
- **Allowances (v2 A7):** per block, prefix 10, ON 45 and OFF 45, so 100 per block and 300 in all. These
  are admission thresholds, not bills. 300 is a chosen cap, not an evidence-based adequate budget; a block
  that reaches it is truncated and reads as incomplete.
- **Endpoint (v2 A8):** newly issued MAD attempts (shared prefix + ON continuation + OFF continuation), and
  ON − OFF over the continuations, by stage, slot and model, with retries apart. It is a workflow-use
  contrast, never token cost, money, quota or physical requests.
- **Outputs:** the bundle under `--out`, and `bun run eval-read --bundle <out>`.

## Before the launch (the human's)

1. **Sign in to Anthropic again** with ordinary opencode. Run 2's `anthropic/claude-opus-5-5` failed on
   `Refresh token expired`; nothing in stage 1 checks that a sign-in is usable.
2. A fresh `--out`. The data directory, prepared directory and labelled change may be run 2's; the store
   guard and the worktree identity check them again.

## Maximum exposure, stated honestly

- **Admitted attempts:** admission thresholds of 100 per block and 300 in total, not a hard cap: attempts
  already in flight when a threshold is reached may overshoot it, and the report states the realised
  count. Neither physical requests nor subscription quota is bounded by them.
- **Physical requests:** not bounded by the attempt count. Host retries are neither gated nor counted. R1
  measured 1 attempt → 6 requests against a persistent 500. Side requests to `small_model`
  (`openai/gpt-6-sol`) are uncounted.
- **Held-open requests:** a turn may hold its request open up to its 600 s deadline; one that does halts
  admission (v2 A10), as in run 2, and its request may still be held open after the halt.
- **Subscription quota:** unmeasured on each of the three providers' subscriptions. MAD sees no quota
  figure and cannot bound it.
- **Money:** MAD makes no per-token charge. Whether any subscription charges overage is not established by
  MAD.
- **Egress:** the production launch has no OS egress control (risk 1). The host connects to
  `api.githubcopilot.com` with the real sign-in at every start (risk 2).
- **Coverage of the OpenAI pin:** gate 7's evidence covers attempt accounting on OpenAI's OAuth transport
  for `openai/gpt-6-luna`; `openai/gpt-6-sol` on that transport is unmeasured.

## Stop conditions (v2 A10)

Admission halts, latched and recorded, and does not resume automatically, on a journal integrity failure,
an attempt from an earlier invocation that was never settled, or an attempt that did not end within its
bound. A failed persistence is a runner stop. A post-stop failure fails the exit code. An unknown token
figure does not stop admission.

## Earlier runs

- Run 1 (`ablation/evidence/paired-oauth-evaluation-run-1-2026-10-02.json`): refused at stage 2 when the
  host's `GET /config` for `--directory` gave no answer within 10000 ms; no model session.
- Run 2 (`ablation/evidence/paired-oauth-evaluation-run-2-2026-10-02.json`): halted in block 1's ON
  continuation; 26 attempts admitted; block 1 partially observed (OFF completed, ON failed), 0 of 3 paired
  blocks completed; incomplete.

## Residual risks on the OAuth route

Quoted in full from `ablation/LIVE-RUN.md`:

> ### Residual risks on the OAuth route (story 2-8c4)
>
> **Story 2-8d's run proposal must quote this section before the human is asked to freeze protocol v2 or
> authorize gate 4.** Each risk below is open on the shipped tree; none is closed by a check.
>
> 1. **Runtime code fetch.** The config seed and the pinned plugin remove the one runtime fetch observed
>    (opencode's background `npm install @opencode-ai/plugin`, refused as `CONNECT registry.npmjs.org:443`
>    in `ablation/evidence/host-accounting-2026-09-24-relay.json` and in the 2-8c3 spike's `run-stub`).
>    Nothing at the OS level prevents another fetch beyond the pinned plugin and seed: the production
>    launch has no OS egress control, unlike the sandboxed probe.
> 2. **The startup connection with the real sign-in.** With no prompt sent, the host connects to
>    `api.githubcopilot.com:443` at startup, before MAD admits any attempt (finding E1,
>    `ablation/evidence/oauth-attempts-2026-09-25.json`). On a production launch that connection leaves
>    the machine carrying the real Copilot sign-in.
> 3. **Hidden host retries.** Against a stub answering HTTP 500, one admitted attempt became 6 requests
>    over 75 s (R1: 1 attempt → 6 requests, same evidence file). On the OAuth route a host retry is
>    neither gated nor counted, so an attempt bounds neither physical requests nor subscription quota.
> 4. **`small_model` is the first pin.** The config's `model` and `small_model` are the first `--pin`
>    (`openai/gpt-6-sol` for run 3). The zero-bill probe left OpenAI's OAuth transport unprobed (finding O1);
>    the OAuth pilot's run 3 covered attempt accounting on it for `openai/gpt-6-luna` only. opencode's side
>    requests, such as session titles and summaries, go to that model outside every attempt count.
> 5. **Unverified refresh write-through.** A stored token that has expired may be refreshed by the host
>    through the auth symlink. The probe used placeholder sign-ins only, so no refresh was exercised; where
>    a refresh writes is not established. The readlink checks before the spawn and after the exit detect a
>    replaced or retargeted link, not a write through it.
> 6. **Persistent host state.** The data directory keeps opencode's database, storage and logs across
>    blocks and runs. The launcher holds the guarded tables (`STORE_TABLES`: session, message, part,
>    permission and the sign-in tables) at 0 before and after every host run; the effect of persistent
>    logs, `project` and `event` rows on later runs is unmeasured; every table outside the store guard's
>    allowlist of opencode 1.18.32 tables is unguarded, and a table a newer schema adds goes unseen.
>    Among the unguarded tables, six may hold session data: `session_message`, `session_entry`,
>    `session_input`, `todo`, `session_share` and `workspace`. Nothing counts them or establishes that
>    they are empty. **2-8d's run proposal must name these six tables too before the human is asked to
>    authorize a bounded pilot.**

## The decision asked of the human

**Authorize gate 4 for run 3:** the evaluation's spend on the OAuth route, on the roster above, under
admission thresholds of 100 admitted attempts per block and 300 in total (in-flight attempts may overshoot
them), with no bound on physical requests or subscription quota, and the rest of the exposure above.
