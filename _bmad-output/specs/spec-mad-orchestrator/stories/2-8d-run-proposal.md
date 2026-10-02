---
title: 'Story 2-8d — the live paired evaluation on the OAuth route: run proposal'
created: '2026-09-25'
status: 'draft for review'
decides: 'the human (protocol-v2 freeze, gate 4)'
---

# The live paired evaluation on the OAuth route: run proposal

**Status: a proposal for the review channel (window 2), then for the human.** Nothing here has run,
and it authorizes nothing. Gate 7 is CLOSED on the evidence of the OAuth pilot's run 3
(`2-8d-openai-oauth-pilot-proposal.md` was that pilot's separate proposal and decision); the two
decisions left are the protocol-v2 freeze and gate 4.

## What would run

`bun run paired --live --provider-mode oauth`: the three paired blocks over a real change, debate ON
against OFF, sealed before the coin toss.
- **Roster:** `openai/gpt-6-luna`, `anthropic/claude-opus-5-5` and `github-copilot/gpt-5-mini`, one
  `--pin` each, with the `security` and `reliability` lens slots. All three are opencode OAuth
  sign-ins, read by the host only through the checked symlink; there is no relay. The first pin,
  `openai/gpt-6-luna`, is also `small_model` (risk 4).
- **Accounting:** attempt mode on the OAuth route (v2 A6–A10). One admitted attempt is one `runTurn`
  that passed its stage's ledger gate and the experiment's admission and was issued, retries included.
- **Allowances (v2 A7):** per block, prefix 10, ON 45 and OFF 45, so 100 per block and 300 in all. These
  are admission thresholds, not bills. 300 is a chosen cap, not an evidence-based adequate budget; a
  block that reaches it is truncated and reads as incomplete.
- **Endpoint (v2 A8):** newly issued MAD attempts (shared prefix + ON continuation + OFF continuation),
  and ON − OFF over the continuations, by stage, slot and model, with retries apart. It is a
  workflow-use contrast, never token cost, money, quota or physical requests. Precision and recall are
  unchanged.
- **Outputs:** the bundle under `--out`, and `bun run eval-read --bundle <out>`. Host-reported tokens
  appear only as unverified diagnostics; manifests mark them `host-reported-unverified`.

## Prerequisites, in order, and who owns each

1. **Gate 7, OAuth attempt accounting — CLOSED.** The review channel read the OAuth pilot's run 3
   evidence (`ablation/evidence/oauth-pilot-live-run-3-2026-09-30.json`) and gate 7 closed by a
   reviewed, committed change to `ablation/paired-gates.ts`. On the measured opencode 1.18.32 host, two
   admitted attempts to `openai/gpt-6-luna` each have one `issued` line before the backend call and one
   `settled` line, answered and settled usage; the third admission was refused inside the journal with
   0 backend calls. Admitted attempts are counted; physical requests, host retries, side requests,
   host-reported tokens and subscription quota are not established or bounded by the count.
2. **Protocol v2 frozen, by the human,** with a data-exposure statement current at that date (v2 A11).
   Stage 1 refuses the OAuth route until then.
3. **Gate 4, evaluation spend, by the human,** in attempts on this route.
4. **Launch-time conditions the launcher checks** (it refuses otherwise):
   - the prepared payloads match their pinned digests;
   - the auth symlink points to `~/.local/share/opencode/auth.json`;
   - the data directory is a real `opencode/` with that link as its only symlink, disjoint from the
     user's own opencode directory;
   - the store guard counts every guarded table at 0.

   The human may sign in again with ordinary opencode first, so that tokens are fresh (risk 5).

## Maximum exposure, stated honestly

- **Admitted attempts:** at most 300, as admission thresholds. Attempts in flight when a threshold is
  reached may overshoot it, and the report states the realised count.
- **Physical requests:** not bounded by the attempt count. Host retries are neither gated nor counted.
  R1 measured 1 attempt → 6 requests against a persistent 500. Side requests to `small_model` are
  uncounted. The attempt count therefore bounds neither physical requests nor subscription quota (gate
  4's own text says so).
- **Subscription quota:** unmeasured, on each of the three providers' subscriptions. MAD sees no quota
  figure and cannot bound it.
- **Money:** MAD makes no per-token charge. Whether any subscription charges overage is not established
  by MAD.
- **Egress:** the production launch has no OS egress control (risk 1), unlike the sandboxed pilot. The
  host connects to `api.githubcopilot.com` with the real sign-in at every start (risk 2).

## Stop conditions (v2 A10)

Admission halts, latched and recorded, and does not resume automatically, on:
- a journal integrity failure;
- an attempt from an earlier invocation that was never settled;
- an attempt that did not end within its bound (a timeout, a cancellation after the request went out,
  or a thrown `runTurn`).

A failed persistence is a runner stop. A post-stop failure (the symlink, the store guard, or the
seeded config tree) fails the exit code. An unknown token figure does not stop admission.

## Limits gate 7 carries to this run

Gate 7's note in `ablation/paired-gates.ts` hands two limits to this run. Neither is closed by a check.
- **Persistent OAuth data directory.** The store guard held its guarded tables at 0 before and after the
  pilot, but opencode's logs, `project` and `event` rows and the six unguarded session-capable tables
  (`session_message`, `session_entry`, `session_input`, `todo`, `session_share`, `workspace`) can
  persist in the OAuth data directory across runs, the pilot's included. Their effect on the ON/OFF
  comparison is unmeasured (risk 6).
- **Runtime code fetch on an unsandboxed launch.** The pilot ran in a sandbox, which does not show
  production egress control. This run has none, so the runtime code-fetch risk stays open (risk 1).

Risk 4 below, quoted unchanged, still calls `openai/gpt-6-luna`'s OAuth transport UNPROBED (finding O1,
from the zero-bill probe). The pilot's run 3 has since driven two admitted attempts over it; that
covers attempt accounting only, not the side requests that risk 4 is about.

## Deferred and disclosed

- The six unguarded tables named in risk 6 are not counted and are not established to be empty.
- A failed unmetered turn's host-reported zeros settle as `usage`. The manifest marks all
  host-reported figures unverified, and the report gives them no cost figure.

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
>    (`openai/gpt-6-luna`, whose OAuth transport is UNPROBED, finding O1). opencode's side requests, such
>    as session titles and summaries, go to that model outside every attempt count.
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

## The decisions asked of the human, kept apart

1. **Freeze protocol v2**, with its data-exposure statement current at the freeze date.
2. **Authorize gate 4:** the evaluation's spend on the OAuth route, up to the attempt allowances above,
   with the exposure above.
