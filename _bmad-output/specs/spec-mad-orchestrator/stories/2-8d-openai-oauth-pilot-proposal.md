---
title: 'Story 2-8d — bounded OpenAI OAuth pilot: proposal'
created: '2026-09-25'
status: 'revised for run 2'
decides: 'the human (pilot authorization); the review channel (evidence review, gate 7)'
---

# Bounded OpenAI OAuth pilot: proposal

**Status: a proposal for run 2, for the review channel (window 2), then for the human.** It authorizes
nothing. It is not the protocol-v2 freeze, and it is not gate 4 (the evaluation's spend). Run 1 ran once,
on 2026-09-28, and failed at its first attempt (see "Run 1"). Run 2 is the run this proposal asks for.

## Why a pilot

Gate 7, "OAuth attempt accounting", is OPEN. The zero-bill probe
(`ablation/evidence/oauth-attempts-2026-09-25.json`) showed the Anthropic and Copilot attempt paths on
loopback stubs. OpenAI's ChatGPT OAuth transport ignores a redirected `baseURL` and connects to
`chatgpt.com:443`, so it is UNPROBED (finding O1). Protocol v2 A11 lets a transport that cannot be probed
without billing be closed only on a separately authorized, bounded pilot reviewed before the evaluation,
never on the paid evaluation itself. This is that pilot.

## Run 1

The budget owner authorized run 1 on 2026-09-28. It is recorded in
`ablation/evidence/oauth-pilot-live-2026-09-28.json` (FAILED), and its reservation is committed at
`ablation/evidence/oauth-pilot-live.reservation`. Attempt 1 was journaled and admitted, then ended in
`model-error` without an answer. A later non-billing inspection of the host's database found that the host
reported a token-refresh failure, HTTP 401, for that attempt
(`ablation/evidence/oauth-pilot-diagnosis-2026-09-28.json`). No `chatgpt.com` `CONNECT` was
proxy-observed, the second attempt did not run and the third admission was not asked. OpenAI attempt
accounting stays unestablished, so gate 7 stays OPEN. Run 1's authorization is spent.

What is different for run 2:
- **The sign-in.** The human reports a fresh ChatGPT sign-in with ordinary opencode. That is an
  unverified claim: MAD never reads `auth.json`, and makes no expiry pre-check. Run 2 can fail the same way
  run 1 did.
- **Settlement and diagnostics (story 2-8c6).** An attempt that ends in a host error with an all-zero
  host token object now settles `unknown`, never a known zero, and still stops the run as "ended in an
  error". Each attempt records an allowlisted host-error record: a category (a refresh rejected with
  400, 401 or 403 reads `oauth-token-refresh-rejected` with that code), an optional allowlisted code and a
  fixed summary. The host's message is never recorded, so run 2's evidence states a refresh failure
  without a WAL inspection.
- **Unchanged:** the model, the route, the prompt, the sandbox and proxy, the stop conditions and the
  ceiling of 2 admitted attempts.

## What it would run

- **Command:** `bun run oauth-pilot`, a new command built by story 2-8c5 (see "Built first").
- **Model and route:** `openai/gpt-6-luna` only, through opencode's own ChatGPT OAuth sign-in, read by the
  host through the checked symlink `~/.local/share/mad-opencode-oauth/opencode/auth.json` →
  `~/.local/share/opencode/auth.json`. MAD never opens that file. The host's `enabled_providers` is
  `["openai"]`. It does not prevent Copilot's startup connection: the 2-8c5 dry run observed the host try
  `api.githubcopilot.com:443` twice, both refused by the proxy. `model` and
  `small_model` are both `openai/gpt-6-luna`.
- **Prompts:** at most **2 admitted attempts**, a hard constant in the command, each one `runTurn`
  through MAD's production `OpencodeModelBackend` in attempt mode, with the prompt "Reply with the word
  ok." and no tools. The attempts run one after the other, never concurrently.
- **A third, refused attempt:** the journal is seeded so a third admission is refused. The journal's
  refusal and a zero backend-call count show that MAD issued nothing for it, and the proxy observed no
  `CONNECT` for it. It costs nothing.
- **Turn bound:** 120,000 ms per attempt.
- **Egress:** the host runs inside the same loopback-only OS sandbox as the dry run, so it has no direct
  route out. A loopback `HTTPS_PROXY` outside the sandbox tunnels `CONNECT` only to `chatgpt.com:443`
  and `auth.openai.com:443`, refuses every other host, and logs each `CONNECT` with a timestamp. It is
  the host's only way out. If the OpenAI transport ignores the proxy, the sandbox denies it, the pilot
  fails closed and gate 7 stays OPEN. The log records **proxy-observed CONNECTs**; the sandbox's
  denials are recorded separately, and neither is a complete census.
- **For this pilot, risks 1 and 2 are narrowed, not removed:** a runtime fetch (risk 1) can leave only
  through the proxy to the two OpenAI hosts. The host's startup `CONNECT` to `api.githubcopilot.com:443`
  (risk 2), observed in the dry run even with only `openai` enabled, is refused by the proxy and
  recorded, and does not stop the pilot before the first attempt. The production 2-8d route has no
  sandbox, and its egress risks are as quoted below.

## Stop conditions

The command stops, admits nothing further and records why, on the first of:
- any preflight failure: binary or payload digests, the auth symlink, the data-directory shape and
  disjointness, or the store guard (every guarded table 0);
- the first attempt ending in an error, a refusal by the provider, a settlement other than `usage`,
  or no answer within 120,000 ms. An attempt that does not end within its bound is abandoned and halts
  (v2 A10), and the second attempt is not sent;
- the first attempt returning `cleanupUnresolved` (its session was not deleted within the backend's
  bound), even if it otherwise returned usage. The second attempt is not sent;
- any proxy-observed `CONNECT` to a host outside the two allowed, except `api.githubcopilot.com:443`
  before the first admission is asked (refused and recorded); a Copilot `CONNECT` after that stops it;
- any journal integrity or persistence failure;
- a post-stop failure: the symlink, the store guard, or the seeded config tree.

## Maximum exposure, stated honestly

- **Admitted attempts:** at most 2. This is the only bounded figure.
- **Physical requests:** not bounded by the attempt count. Host retries are neither gated nor counted
  on this route. R1 measured 1 attempt → 6 requests against a persistent 500. opencode's side requests
  (such as the session title) go to the same model uncounted. There is **no upper bound** on
  requests. As an illustration only, not a maximum and not a forecast: the measured R1 case of 6 requests
  per attempt, over 2 attempts plus a side request each, would be 14 requests. TLS and HTTP/2 hide
  request counts, so the proxy log counts proxy-observed connections, not requests.
- **A second run adds its own exposure.** Run 1's requests, whatever they were, are spent. Run 2 has
  its own 2-attempt ceiling and its own unbounded physical-request exposure, on top of run 1's.
- **Tokens:** host-reported tokens are unverified diagnostics (v2 A7). As an estimate only, opencode's
  system prompt makes each request's input some thousands of tokens.
- **Subscription quota:** unmeasured. The pilot draws on the human's ChatGPT subscription through its
  OAuth sign-in, not an API key. MAD cannot see or bound the quota used.
- **Money:** no per-token charge is made by MAD. Whether the subscription has overage charges is not
  established by MAD.
- **Token refresh:** if the stored OpenAI token has expired, the host may refresh it through the symlink
  (risk 5). MAD stats the auth target before and after, without opening or reading it. The evidence
  records only changed or unchanged flags for its size, mtime and inode, never the values. A change is
  evidence of activity. Unchanged metadata proves neither that no write happened nor where a refresh
  went. The diagnosis of run 1 found its attempt failed on a refresh rejected with 401. A fresh sign-in with ordinary opencode beforehand may
  help, but MAD does not verify it and it does not replace the observation.

## Evidence, and what it can close

Committed as `ablation/evidence/oauth-pilot-live-run-2-<date>.json`, redacted, with no request or response
content. The file committed is whichever one the run wrote in `--out`: `oauth-pilot.json`, or
`oauth-pilot.INCOMPLETE.json` when it did not exit 0, as run 1's INCOMPLETE file was committed under its
legacy name. It holds:
- the journal's `issued` and `settled` lines;
- the proxy's log of proxy-observed `CONNECT`s with timestamps. It can show no proxy-observed `CONNECT`
  before an attempt's `issued` line, none for the refused attempt, and none to another host. It cannot
  show that no direct connection occurred;
- for the refused attempt, the journal's refusal and a backend-call count of 0;
- the auth target's changed/unchanged flags for size, mtime and inode;
- each settlement's kind, and each attempt's allowlisted host-error record;
- host-reported tokens, labelled unverified;
- store-guard and symlink results before and after;
- the host binary's identity.

The review channel reads it. Gate 7 closes only by a reviewed, committed change to
`ablation/paired-gates.ts`, and only if every attempt was journaled before any proxy-observed
connection, counted once and settled. The evidence cannot show the number of physical requests per attempt, and gate 7's
text must say so.

## One run only

Gate 8 authorizes one run, run 2. Its identity, `OAUTH_PILOT_RUN` in `ablation/paired-gates.ts`, is
committed beside the gate: no flag, environment variable, file or date names a run, and the command line
takes none. Before it touches a host, the
auth target, the data directory or the network, `--live` checks that run 1's committed reservation and
evidence are unchanged and record run 1's proposal, then creates run 2's reservation file
`ablation/evidence/oauth-pilot-live-run-2.reservation` exclusively. If that file already exists, or any
other live pilot file than run 1's is present, it refuses, whether an earlier run succeeded, failed or
was interrupted, and whatever `--out` it used. Two invocations cannot both create it. Nothing deletes
it, so a failed or interrupted run 2 consumes the authorization. A further run needs the human's
explicit decision, and the budget owner re-opens gate 8 after the run.

## Built first, at no cost

`bun run oauth-pilot` is built and reviewed before the human is asked, as its own no-bill story,
**2-8c5-oauth-pilot-command**, with a spec checkpoint and a local code-review checkpoint:
- its tests use stand-in hosts;
- its dry run runs inside the sandbox with **placeholder credentials only**: no real auth target and no
  live provider prompt. It shows every egress refused and no attempt settled, and it records the proxy-observed
  Copilot startup connection. It may exercise only the first, failed attempt; the ceiling and the refused
  third admission are proven by stand-in tests.

Story 2-8c6 (failed-turn settlement and host-error diagnostics) and story 2-8c7 (run 2's identity and
reservation) were built the same way, at no cost. The live run is the only step the human authorizes.

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

## The decision asked of the human

Authorize, or decline, **run 2 of `bun run oauth-pilot`**, one run: at most 2 admitted attempts to
`openai/gpt-6-luna` through the ChatGPT OAuth sign-in, with the exposure above. This decision is
separate from freezing protocol v2 and from gate 4.
