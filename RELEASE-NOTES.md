**Draft — not released.** v1.0.0 is not tagged; its route gate is unmet (the TUI is *not compatible*).

# MAD release notes

## v1.0.0 (draft)

MAD reviews a code change with several models at once, inside OpenCode. Each model reviews the change on its own, contested findings are debated, and a judge checks each finding against the code. The report says every way the run was degraded, stopped or left incomplete.

### Compatibility

v1 targets opencode-ai 1.19.5, used through the TUI and through `opencode run`. No other host version or route is targeted.

| Route | Verdict |
| --- | --- |
| TUI | not compatible |
| `opencode run` | compatible with listed limitations |

Both verdicts were rendered on 2026-11-16 from one authorized live run per route. In the TUI run, fewer verified model lineages answered than were selected after an ordinary drop-out, and MAD did not warn about it. MAD now warns in that case, but that fix is checked only offline; the TUI verdict stays until a new authorized TUI run shows it. The runs, the criteria and the revision they used are in [`EVIDENCE.md`](EVIDENCE.md).

### What is in v1

- `mad_review`, one OpenCode tool, with the arguments `target`, `slots`, `lenses`, `budget`, `preset`, `models` and `exclude` ([README, *Using `mad_review`*](README.md#using-mad_review)).
- Discovery by several models in parallel, chosen from the providers the host already has configured, preferring distinct model families and using only models the host declares able to call tools. `models` pins models and `exclude` keeps models out.
- Optional lenses: extra discovery turns that narrow what a model looks for. Lens findings add coverage and carry no co-discovery fraction.
- A co-discovery fraction for findings that several pool models raise independently.
- The presets `quick`, `normal` and `paranoid`, which set the co-discovery threshold, the lenses, peak concurrency and the default budget. A finding below the threshold, or a critical one, is debated.
- A judge that checks each finding against the code, with a `git blame` MAD runs itself, read-only.
- Recognised provider refusals are not retried; a refused discovery pool slot that was not pinned is replaced once, from a route that was not refused.
- A token admission budget, with a report that marks overshoot, unknown usage and anything the budget left unresolved.
- An optional debug dump of each run (`MAD_ARTIFACTS`), written only outside the repository under review.

### Installation

MAD is a private source checkout, not published to npm. Install its dependencies from the checkout's root with Bun 1.4.3, the version CI uses:

```sh
bun install --frozen-lockfile
```

Then add the checkout's absolute path to the `plugin` list of an OpenCode config file as a `file://` entry. The full steps are in the [README, *Registration*](README.md#registration).

### Known limitations

These match [`EVIDENCE.md`, *Residual limitations*](EVIDENCE.md#residual-limitations) and the [README, *Known limitations*](README.md#known-limitations).

- Replacement of a refused slot, the replacement session's policy check, a refusal in debate or the judge, and a refusal stopping MAD from asking the slots it covers have run only offline.
- A model that declares tool calling can still have an endpoint that rejects MAD's forced tool choice. `exclude` keeps such a route out, for the reviews it is passed to.
- A free model at its usage limit is retried once as an ordinary failure; it is not classified as a refusal.
- Few models may answer, and a model may judge its own finding.
- The tool-calling filter's exclusions, and refusing a review when no offered model declares tool calling, were not exercised live.
- The budget is an admission budget, not a spend cap. Every known token total is a floor, and the outer agent's usage is not metered.
- A finding's line is the reviewing model's citation; findings on one defect at different lines may not be merged.
- Which version of the host's authentication plugin loaded is unknown, and the host's config merge was not read in full.
- Four refusal shapes stay ordinary failures. `serverUrl` is not a supported plugin route.
- If the same worktree is opened under another spelling of its path, MAD does not recognise that it is quarantined.
- A very large diff, or a git helper that writes a lot of output, is held in memory in full.
- A working tree with very many untracked files can use up the change read's time limit, and the review then fails instead of starting.

### What v1 does not claim

One run per route is a bounded compatibility check. v1 makes no claim about reliability in production, about another host version, or about whether MAD's reviews are useful on your changes.

### License

GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). See [`LICENSE`](LICENSE).
