# Deferred to v2

Designed, deliberately not built first. Each is a non-goal in `SPEC.md`. They are recorded here because two of them constrain v1 structure — clustering must be a separable component, and rejection must be capturable in two kinds — and because a v1 builder who does not know they are coming will foreclose them.

## Two-layer memory

- **Instance memory** — "you already rejected this finding." Reuses the v1 clustering engine pointed at rejection history instead of at the current run. The within-run clustering engine and the cross-run memory are one component discovered twice; v1 must not weld clustering to the current-run data structures.
- **Rule memory** — a human-readable, PR-reviewable `.mad/preferences.md`, injected at discovery time so a nitpick is never generated rather than filtered afterward.

## Two-key rejection

`wrong` (false positive → model calibration) versus `don't care` (true but unwanted → preference rule). Same click, opposite lessons. Collapsing them teaches the tool to hide real bugs it once found boring.

## Free ground truth from git

A flagged line that changes in a later commit is silent acceptance. The tool can score itself and each participating model from git history with zero user effort.

## Evidence-weighted voting

Weight a debater by what it actually produced — cited line, trace, repro — not by model reputation, with weights calibrated from accumulated verdict history. Makes debate quality mechanically matter.

## Persona packs for non-code task types

Coding lenses ship in v1 (CAP-11). Legal, technical-writing, and other domain packs do not, and the reason is structural rather than a matter of effort: the Fact-Checker is what makes debate produce evidence instead of rhetoric, and it works by opening the file, walking the path, or running the test. Outside a repo, none of those exist. A domain pack therefore needs its own ground-truth mechanism designed first — a citable corpus, a style authority, a statute reference — and that is a product decision, not an instruction set.

What v1 owes v2 is only the registry shape (AD-11): task type plus role plus lens, with on-the-fly generation as the fallback. That much is built.

## Human as escalation authority

Deadlocks surface to the user with both arguments attached; the ruling is stored as calibration data feeding per-model weights. The cheapest route into the survey's "memory beyond session" gap.
