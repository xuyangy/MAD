# Cost model

Token cost is a first-class constraint, not an afterthought. Cited by CAP-7 in `SPEC.md`.

## Levers, strongest first

1. **Batch by model, not by finding.** One call per model per round covering all open findings — roughly 3 calls per round instead of 27. Bonus: cross-finding context lets a model notice that two findings share a root cause. Risk: one bad response corrupts many debates at once.
2. **Threshold skip.** Findings above the co-discovery threshold never enter debate.
3. **Stall exit.** Two models restating themselves is not progress — short-circuit to the judge instead of burning the round cap.
4. **Sparse rooms.** Author + skeptic + co-finders, not everyone on every finding. Full connectivity charges you for models saying "I agree."
5. **Narrow judges are small-model jobs.** "Does this cited line say what he claims?" does not need a frontier model.
6. **Lens count.** Additive coverage bought at the widest point of the run: each lens is one more discovery slot, so three models with five lenses is **eight** discovery turns rather than three. This is the only lever on this list that *increases* cost, which is why lenses are off by default and why `paranoid` enables a subset rather than all of them. *Corrected 2026-08-15 (story 2A code review): this read "eighteen discovery turns", a multiplicative model in which every pool model carries every lens. The shipped fan-out is `slots + lenses`, per `host-integration.md`'s `discovery-lens-*` row ("M slots, each carrying one lens"). See AD-15's correction note.*

Budget can be spent as an allocation rather than a flat cap: contested findings buy more rounds than settled ones.

*Story 8 implemented the first half of that sentence and deliberately not the second.* The one cap is split across the three billing stages as **cumulative shares** — discovery may take the run's total to 30% of the cap, debate to 65%, the judge to 100%. The stages run strictly in sequence, so a cumulative ceiling on the one total is arithmetically a per-stage allowance, with no second number that can disagree with the cap and with unspent budget rolling forward for free. **Per-FINDING allocation is not implemented**: it would need a cost estimate per finding before the turn is billed, and `core/budget/ledger.ts` is explicit that MAD cannot know what a turn will cost before it costs it. Filed as deferred work rather than guessed at.

## A guard, not a lever

**Peak concurrency** bounds how many billed turns a run can have in flight at once. It is not on the list above because it does not reduce what a run spends — only how fast, and how hard it leans on one user's rate limits. It belongs to the same accountant (AD-15): at the shipped ceilings discovery's fan-out is 12 pool slots plus 8 lens slots, and twenty simultaneous sessions against one set of credentials produces rate-limit errors that look exactly like models dropping out. A limiter converts that into backpressure, which costs wall-clock instead of costing a false degradation report.

## UX

One budget number plus a `quick | normal | paranoid` preset.

The co-discovery threshold *is* the paranoia dial: 100% debates everything, 50% debates almost nothing. Critical-severity findings debate at any setting.

**The dials, enumerated — amended 2026-09-04 (story 8).** This paragraph said *eleven* dials from the day it was written, a number inherited verbatim from `brainstorm-intent.md:88` and never once enumerated. Enumerating them is the first thing story 8 had to do to size the presets, and the count is **ten**:

1. co-discovery threshold · 2. debate round cap · 3. token cap · 4. peak concurrency · 5. discovery slots · 6. which lenses · 7. discovery share · 8. debate share · 9. preset · 10. per-turn timeout.

The judge's share is **not** a dial: it is forced to 1, because a judge ceiling below the cap would make part of the stated cap unreachable — a ceiling that lies to the reader. Two of the ten (`budget` and `preset`) are the user-facing surface; **five** of the remaining eight are reachable on the exported `review()` seam — `threshold`, the round cap, peak concurrency, and the discovery and debate shares, all `ReviewDeps` fields. *Amended 2026-09-06 (epic-1 retrospective ledger triage, entry 62): this said **seven**, and a reviewer counting `ReviewDeps` got five. The reviewer was right. **Discovery slots** and **which lenses** are `selectRoster` inputs, not `ReviewDeps` fields — `review()` receives an already-built `roster`, so they are reachable on the roster seam and not on this one. They are still reachable; the sentence named the wrong seam.* That is what "in config for people who want them" means in a codebase with no config reader — AD-3 requires a missing config file to be a valid install, so a file-based layer whose whole job would be defaulting is the largest possible diff for the smallest gain. The per-turn timeout is the one dial not on that seam; it is adapter-side, and filed as deferred work rather than invented into a config layer.

Nobody should have to touch any of them.

Lenses are off in `quick` and `normal`. `paranoid` enables a subset — the dial is which lenses, not how many rounds. Whether they pay for themselves is story 9's third arm to report, not this document's to assert.

**The table as shipped (story 8).** No preset moves the round cap or the slot count.

| | threshold | lenses | peak concurrency | budget that fits |
|---|---|---|---|---|
| `quick` | 0.5 | none | 4 | 250 000 |
| `normal` | 0.8 | none | 4 | 400 000 |
| `paranoid` | 1.0 | `security`, `reliability`, `outsider` | 6 | 550 000 |

`normal` is the **identity** preset: every value is the shipped default verbatim, so naming it and passing nothing are the same run (AD-3), pinned by a test rather than promised here. `paranoid`'s three lens slots make discovery **six** turns at the default three pool slots — additive, per lever 6 above. The suggested budgets are planning figures over a reference workload (~400-line change, ~10 canonical findings, ~10k a discovery turn, ~12k a debate turn, ~6k a judge turn), each carrying ~1.4x headroom; nothing reads them at run time.

Model pricing, provider choice, and fallbacks are the host's concern (`host-integration.md`). MAD budgets in tokens, not currency.

## Budget exhaustion

When the budget runs out with findings still undecided, they are **surfaced, not dropped** — an "unresolved — you decide" section carrying the evidence each one accumulated and the stage it died at. Silently emitting only the decided findings would make a review that ran out of money look exactly like one that finished, which is the same failure as hiding a shrunken denominator.

The tool does not refuse to start a review it cannot afford to finish; it starts, spends what it has, and says where it stopped.

**And a budget that bites discovery must not blame a model** (story 8). Since discovery gained a gate, a slot MAD chose not to ask is a third fact beside "a model failed" and "the user stopped the run": it raises `discovery-truncated`, it is absent from `droppedOut`, it is never seated in a later stage's room, and no provider is named in any degradation warning. The co-discovery denominator still shrinks — it counts answers, never requests — and `denominator-reduced` says the budget is why.
