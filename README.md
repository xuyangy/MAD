# MAD — multi-agent debate code review for OpenCode

MAD reviews a code change with several models at once. Each model reviews the change on its own. Findings that several models raise independently carry a co-discovery fraction. Contested findings are debated, and a judge checks each finding against the code, including a `git blame` MAD runs itself. The report ranks the findings and says every way the run was degraded, stopped or left incomplete.

**Status: checked offline; tried by hand on a live host.** The behaviour this README describes is checked by an offline test suite with a scripted fake host and fake models (`bun test`). No test here runs against a real OpenCode host. Two reviews were run by hand on opencode-ai 1.19.5, and *What a live review showed* below says what they did and did not show. Whether MAD is useful on your changes is a separate, later question.

## Target host

MAD targets opencode-ai 1.19.5, used through the TUI and through `opencode run`. No other host version or route is targeted.

| Route | Status |
|-------|--------|
| TUI | not established |
| `opencode run` | not established |

A route's compatibility is not established until a recorded, authorized live run on 1.19.5 shows it. The two hand reviews below predate that record, and they are not validation.

These are the host facts MAD relies on, and the evidence for each on 1.19.5:

| Fact | Evidence on 1.19.5 |
|------|--------------------|
| How a plugin is loaded from a package | read from the 1.19.3 bundle only; the 1.19.5 loader is unverified. Registration was observed by hand on 1.19.5 (historical registration report E1, source commit `12af673`). |
| The plugin reaches the host through the client OpenCode hands it | observed by hand on 1.19.5 in historical hand-review reports E2 (`opencode run`) and E3 (TUI), source commit `f7efaa0` |
| How the review-session permission rules are evaluated | read from the 1.19.5 bundle |
| A `json_schema` prompt's answer is recorded through the host's `StructuredOutput` tool | read from the 1.19.5 bundle |

## Registration

MAD is a private TypeScript checkout. It is not published to npm.

| What | Where |
|------|-------|
| package `main` | `adapters/opencode/entry.ts` |
| package export `.` | `./adapters/opencode/entry.ts` |
| package export `./server` | `./adapters/opencode/entry.ts` |
| entry module exports | the default export `MadPlugin`, and nothing else |

The entry module exports only the plugin because the host calls every export of a plugin module as a plugin. MAD's own code imports from `adapters/opencode/plugin.ts`.

To register it with OpenCode 1.19.5, a person (not MAD) would do two things:

1. Install the checkout's dependencies, from the checkout's root:

   ```sh
   bun install
   ```

2. Add the checkout's absolute path to the `plugin` list of an OpenCode config file. That is either the global `~/.config/opencode/opencode.json` (under `$XDG_CONFIG_HOME` when it is set), a project's `opencode.json` or `.opencode/opencode.json`, or the file named by `OPENCODE_CONFIG`:

   ```json
   { "plugin": ["file:///absolute/path/to/MAD"] }
   ```

What this rests on, and what it does not:
- **What was read.** The opencode-ai 1.19.3 bundle was read, not run. From it: the config locations above; that a server plugin is taken from a package's `exports["./server"]` or its `main`; that every export of that module is called as a plugin; and how the review-session policy below is evaluated. The opencode-ai 1.19.5 bundle was read the same way for the review-session policy only, and evaluates it as described below. Its plugin loader was not re-read.
- **Where the `file://` form comes from.** It is the form this repository's own managed test host uses to load a local plugin package (`ablation/managed-host.ts`).
- **What was verified.** Registration was verified by hand on opencode-ai 1.19.5: `opencode serve`, started with `OPENCODE_CONFIG` naming a file that holds only the `file://` entry above, loaded MAD and listed `mad_review` among its tools (historical registration report E1, source commit `12af673`). That check ran no review and no model.
- **What a live review showed.** A review was run by hand on opencode-ai 1.19.5, once through `opencode run` and once in the TUI, each with `{"preset":"quick","budget":100000}` on a scratch repository holding one uncommitted file (historical hand-review reports E2 (`opencode run`) and E3 (TUI), source commit `f7efaa0`). In both, MAD's session-policy check passed, a model returned structured findings, the judge decided them, the host reported usage for the turns that completed, and the repository was left unchanged. Each run also had four failed attempts whose usage the host did not report, so each run's token total is a floor, not its full spend. In both, two of the three models MAD chose dropped out (one provider was out of credits, and one model had no endpoint that supports structured output), so each review rested on one model. Those runs predate the tool-calling filter and the replacement of refused slots described under `slots` below; neither has been run against a live host.
- **How MAD reaches the host.** MAD sends every request through the client OpenCode hands the plugin, never to the plugin's `serverUrl`: outside `opencode serve`, OpenCode 1.19.5 passes a placeholder URL that nothing listens on. `serverUrl` is not a supported way for the plugin to reach the host; MAD's evaluation and probe scripts keep it as their transport to a server they start or are given. That client is OpenCode's v1 SDK, whose request types do not declare two fields MAD sends: `permission`, when it creates a review session, and `format`, when it asks for structured output. MAD sends both in the request body, and `adapters/opencode/host-session.test.ts` pins the three session requests it sends this way: create, prompt and delete.
- **What is untested.** No test here runs that registration or a live review. Other host versions are unverified.
- **What the repository does not do.** Nothing in it installs, registers or starts MAD in your host.

## Using `mad_review`

The plugin adds one tool, `mad_review`. You ask your OpenCode agent to call it, for example "review my working tree with mad_review". The agent fills in the arguments.

| Argument | Type | Default | Bounds |
|----------|------|---------|--------|
| `target` | string | the working tree against `HEAD` | must not start with `-` |
| `slots` | integer | 3 | 1 to 12 |
| `lenses` | list of lens ids | the preset's lenses | at most 8 |
| `budget` | integer, tokens | the preset's default budget | 0 or more |
| `preset` | `quick`, `normal` or `paranoid` | `normal` | one of the three |
| `models` | list of `provider/model` | MAD chooses the whole roster | at most 12 |

- **`target`.** Omit it to review uncommitted work: tracked edits and untracked files, against `HEAD`. Pass a ref, a commit or a range such as `main...HEAD` to review that instead; untracked files are then not read. A target that starts with `-` is refused before anything runs, because git would read it as an option.
- **`slots`.** How many discovery models review the change in parallel. MAD fills them from the providers your host already has configured, preferring distinct model families. It uses only models the host declares able to call tools, because OpenCode returns MAD's structured answers through a tool call; a model offered through several providers is used through the first one that declares it, and the report says how many offerings were left out. A declared capability does not guarantee a working endpoint. If no offered model declares it, MAD refuses before asking any model. When a provider refuses a discovery model's request for an account reason (a recognised authentication or payment refusal, such as GitLab's no-credits error), MAD does not retry it. A 429 quota error, a 403, GitLab's no-credits text under a provider id other than `gitlab`, or a refusal in the prompt envelope's `result.error` is treated as an ordinary failure. It can receive the ordinary retry if the stop and budget gates permit it; that error alone does not qualify the slot for replacement. For a recognised refusal, once every first-round discovery turn has finished, MAD replaces the refused slot once with a model not in the pool (one a lens already used may be chosen) on a provider and route that were not refused, preferring a model family the models that answered lack, if one is available and the budget admits it; the report names both models, keeps the refused model's row, and the title counts the replacements. A generic 401 or 402 error excludes only that model on that provider, so another model on the same provider can be chosen and refused the same way. A slot you pinned with `models` is not replaced, and lens slots are never replaced. If the host offers fewer models than slots, the run continues with fewer and says so.
- **`lenses`.** Extra discovery turns, each with a persona that narrows what it looks for. The shipped ids are `security`, `performance`, `maintainability`, `reliability`, `tests`, `privacy-a11y`, `intent` and `outsider`. An unknown id is accepted and its instruction is generated at run time, and the report says so. Lens findings add coverage; they carry no co-discovery fraction.
- **`budget`.** The token admission budget; see [What the cost figures mean](#what-the-cost-figures-mean). `0` starts no model turn.
- **`preset`.** Moves the numbers in the table below, never the policy.
- **`models`.** Models to pin, filling slots in the order given before MAD chooses the rest. A model the host does not offer is reported, and its slot is filled automatically. MAD holds no credentials and adds no provider.

An argument you pass always beats the preset, including an explicit empty `lenses` list under `paranoid`.

| Preset | Co-discovery threshold | Lenses | Peak concurrent turns | Default budget (tokens) |
|--------|------------------------|--------|-----------------------|-------------------------|
| `quick` | 0.5 | none | 4 | 400000 |
| `normal` | 0.8 | none | 4 | 450000 |
| `paranoid` | 1 | `security`, `reliability`, `outsider` | 6 | 650000 |

A finding raised by at least the threshold fraction of the models that answered goes straight to the judge. Below it, the finding is debated. A critical finding is debated at any threshold. Each lens is another discovery turn, so `paranoid` with the default 3 slots runs 6 discovery turns rather than 3.

Examples of what an agent would pass:

```json
{}
{ "target": "main...HEAD" }
{ "preset": "paranoid", "lenses": [] }
{ "slots": 2, "budget": 200000 }
```

## What a review runs, reads and changes

**It changes nothing in your repository.** MAD's repository access has no write operation. Outside the repository, the environment variable `MAD_ARTIFACTS` turns on a debug dump of each run, and only that:
- unset or empty: nothing is written;
- `MAD_ARTIFACTS=1` (or `true`, `yes`, `on`): the dump goes to `mad-runs` under the system temp directory;
- any other value: the dump goes to that directory, which must be an absolute path outside the repository under review. A relative path, or one inside the repository, is refused.

**It sends the change to each model it asks.** The report's disclosure lists every provider and model in the roster. A slot the report marks NEVER ASKED, a zero budget, or a run stopped early sends it to fewer.

**It runs git, and only git, read-only.**
- MAD's own git processes read the change and, for the judge, `git blame` over the lines a finding cites. Every one runs with pagers, external diff drivers, text conversion, file-system monitors and colour turned off. It runs without the `PAGER` and `GIT_*` variables it would inherit, and with MAD's own `GIT_ALLOW_PROTOCOL`, `GIT_NO_LAZY_FETCH`, `GIT_OPTIONAL_LOCKS` and `GIT_TERMINAL_PROMPT` set in their place, so no network transport is allowed.
- A repository whose effective git config defines executable filter drivers (clean, smudge or process commands) is refused before anything is read, because git could run them while reading. That includes a filter set in your global config, such as the one `git lfs install` writes there, which makes MAD refuse every repository on that machine.
- A submodule is reviewed as its commit pointer only. Uncommitted changes inside a submodule are not read, and the report says so.
- A file name MAD cannot read exactly, or an untracked file that vanishes or cannot be read, is refused by name. MAD never reviews it as an empty or clean file. A name containing the character U+FFFD is always refused, because MAD cannot tell it from bytes that are not UTF-8.

**Review sessions get no host tools.** Every session MAD creates carries the permission rules `* * deny; StructuredOutput * allow`. That denies every host tool, custom tools and delegation to another agent included. `StructuredOutput` is the host's own tool for recording the structured answer every MAD turn asks for. MAD checks the host's record of the rules before prompting a session. A second check refuses any tool call the host routes through the `tool.execute.before` hook for a session MAD created. Each prompt also tells the model that host tools are unavailable and that it should report a check it cannot make as unchecked. If the host does not record the rules MAD sent, MAD refuses to review before asking any model, or stops the run if a later session's rules differ, and says which. MAD's own `git blame` read is not a host tool, and it is how evidence reaches the judge.

The offline tests show that every session request carries these rules and that MAD's own checks behave as described. They use fake requests, so they prove the wiring, not that a real host enforces the rules.

## What the cost figures mean

- **Tokens, not money.** MAD counts tokens. What a token costs is your host's and provider's business, and MAD makes no promise about your bill, a quota, latency, or whether the review will be useful.
- **The budget is an admission budget.** It is an admission budget, not a hard bill or quota ceiling. MAD checks it when it admits work: each discovery attempt, each debate round as a whole, each judge step. Work already admitted, a debate round's retries included, can take the total past it. A stage marked OVER in the report shows that overshoot.
- **MAD starts a review it may not be able to finish.** It never refuses up front for cost. When the budget runs out, the report says where the review stopped and lists each undecided finding, with its cause, under UNRESOLVED.
- **Unreported usage may have been billed.** When the host reports no usage for a turn MAD issued, the turn is not counted as free. The report calls the total OBSERVED spend and a floor, says how many turns have unknown usage, and says they may have been billed.
- **Host activity MAD does not see.** MAD does not meter all host retries and tool steps, so the host may bill more than the TOKENS figure.

Every returned review ends with a note, outside the report, naming the budget it ran under and repeating these limits.

## Stopping and cleanup

When you stop a review in OpenCode, MAD sees the stop and starts no further model turn, retry or git read after it.

- **Model turns already issued.** In OpenCode, MAD stops waiting for model turns it already issued but does not abort them, so they may keep running on the host and be billed. The report says so whenever a turn had been issued.
- **Git processes.** When you stop, or a git read passes its deadline, MAD sends that git process SIGKILL at once, or reports that SIGKILL could not be sent. It then waits a short cleanup period to confirm that the process ended and its output closed. If it cannot confirm that, the report says the process may still be running, gives its pid, and quarantines the worktree until OpenCode restarts. After a change read, MAD reads nothing more in that worktree. After a `git blame` read, it runs no further `git blame` there.
- **Confirmed means observed.** A confirmed cleanup means the git process MAD started was reaped and its output reached its end. MAD does not kill a process group. A helper git started that let go of its output, or wrote it elsewhere, could outlive the kill, and MAD would not see it.

| Limit | Deadline (ms) | Cleanup (ms) |
|-------|---------------|--------------|
| reading the change, all git reads together | 60000 | 5000 |
| one `git blame` evidence read | 60000 | 5000 |
| one model turn | 600000 | — |

These are operational limits, not measured latencies.

## Known limitations

- **Another spelling of the same path.** If the same worktree is opened under another spelling of its path, MAD does not recognise that it is quarantined.
- **Large changes in memory.** A very large diff, or a git helper that writes a lot of output, is held in memory in full.
- **Many untracked files.** A working tree with very many untracked files can use up the change read's time limit, and the review then fails instead of starting.

These are stated so you can plan around them. No fix is implied.

## Development

The offline tests are run with Bun 1.4.3, locally and in CI (`.github/workflows/ci.yml`). The snapshot that checks the repository under review is unchanged needs directory entries as raw name bytes, and stops with an error on a Bun that returns them as strings.

```sh
bun run typecheck
bun run lint
bun test
```

`bun test` includes the offline acceptance scenarios. They drive the real `mad_review` entry against a fake host with a network guard, and each checks that the repository under review is unchanged afterwards. `scripts/readme.test.ts` fails when this README disagrees with the shipped code on registration, arguments and defaults, presets, the session rules, the budget note, the stop note or the limits above.
