---
id: SPEC-mad-orchestrator
companions:
  - ../../planning-artifacts/architecture/architecture-MAD-2026-08-13/ARCHITECTURE-SPINE.md
  - pipeline-stages.md
  - host-integration.md
  - cost-model.md
  - survey-grounding.md
  - deferred-v2.md
  - evaluation-protocol.md
sources:
  - ../../brainstorming/brainstorm-mad-orchestrator-2026-08-13/brainstorm-intent.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.
>
> **`ARCHITECTURE-SPINE.md` governs *how* this gets built.** It carries seventeen architecture decisions (`AD-1`–`AD-17`), the consistency conventions, and the pinned stack. Where this SPEC says what must be true, the spine says what every unit must agree on to make it true. Cite `AD-n` rather than restating a rule.

# MAD — Multi-Agent Debate Orchestrator (v1: code review)

## Why

An opportunity to capture, realized as an open-source plugin for agent harnesses rather than a research instrument. Different LLMs find different bugs in a code change, and each one also invents bugs; a reviewer handed 20 findings with 3 real ones trusts none of them. The enemy is noise, not misses. MAD makes heterogeneous models argue over each other's individual findings — deny, concede, cite — so the surviving list is trustable. It is buildable now because a bug claim, unlike an opinion, has ground truth sitting in the repo: a debater can cite the line, walk the call path, read `git blame`, or write the failing test, so debate produces evidence rather than rhetoric. Harnesses already resolve work to heterogeneous models across providers, which is exactly the substrate discovery needs. The design also occupies unexplored ground — nearly every choice here is the marginal option in the field's taxonomy (see `survey-grounding.md`), adopted-against by convention rather than by comparison. Code review is the first and only v1 use case.

## Capabilities

- **CAP-1** — parallel heterogeneous discovery
  - **intent:** N heterogeneous models each review the same change independently and in parallel, so model diversity becomes coverage.
  - **success:** A run over a change with known seeded bugs produces a pooled finding set whose recall exceeds that of any single participating model's own list.

- **CAP-2** — finding clustering
  - **intent:** Equivalent findings raised by different models collapse into one finding carrying a co-discovery count.
  - **success:** Against a hand-labelled fixture set of equivalent/distinct finding pairs, clustering reports an over-merge rate and an under-merge rate as two separate numbers in CI — never fused into one accuracy figure.

- **CAP-3** — severity-aware threshold routing
  - **intent:** Each clustered finding is routed by its co-discovery fraction and its severity: at or above the threshold it skips debate and goes straight to judging, below it goes to debate, and a critical finding is debated regardless.
  - **success:** Changing the threshold alone demonstrably changes which findings enter debate (100% → debate everything; 50% → debate almost nothing), and a finding at full co-discovery still enters debate when its severity is critical.

- **CAP-4** — per-finding debate
  - **intent:** A contested finding is argued by the models with a stake in it until the exchange resolves, so the finding's author either defends it with evidence or withdraws it.
  - **success:** Every debate terminates on exactly one of three recorded exits — converged, stalled (no position moved this round), or cap hit — and the per-round position and concession deltas that decided the exit are readable in the transcript.

- **CAP-5** — judge pipeline
  - **intent:** A finding's final verdict is decided by a decomposed pipeline of narrow judges rather than one authoritative model, in one of two modes depending on whether the finding arrives with a debate transcript.
  - **success:** For a contested finding the run record shows anonymized debaters in randomized order, extracted evidence with pointers back to raw text, separate Fact-Checker and Logic Evaluator outputs, and an aggregated verdict; for a threshold-skipped finding it shows a Fact-Checker verdict and no Logic Evaluator step. Stage contracts in `pipeline-stages.md`.

- **CAP-6** — evidence-carrying ranked output
  - **intent:** The user receives findings ranked by confidence, each carrying the three numbers that produced it and the argument behind it, so a finding can be trusted or dismissed without rerunning anything.
  - **success:** Every emitted finding shows co-discovery as a fraction with its denominator, a verdict (upheld / withdrawn by author / judge-ruled), and what evidence was actually produced (line cite, trace, failing test, or assertion only) — the three shown separately, never fused into one score. Findings left undecided when the budget ran out appear in their own "unresolved — you decide" section with the evidence they accumulated and the stage they died at.

- **CAP-7** — budget control
  - **intent:** A user bounds what a review may cost with a single number and a paranoia preset, without touching anything else.
  - **success:** A review run with only a token budget and one of `quick | normal | paranoid` completes within budget; the underlying dials are reachable but untouched. Levers in `cost-model.md`. *Amended 2026-09-04 (story 8): this read "the eleven underlying dials", a count inherited from `brainstorm-intent.md` and never enumerated. Enumerated for the first time in `cost-model.md`, there are **ten** — the judge's spend share is forced to 1 and is not a dial. Seven are reachable on the exported `review()` seam; the per-turn timeout is adapter-side.*

- **CAP-8** — repo and git-history evidence access
  - **intent:** Debaters and the Fact-Checker can inspect the full repository and its git history through the host's tools, not only the diff, so claims are settled against repo-specific truth.
  - **success:** A finding is decided by a `git blame` citation that contradicts a confidently asserted claim, and the citation appears in the output as the deciding evidence.

- **CAP-9** — ablation harness
  - **intent:** The same change can be run through the full pipeline and through a single strong model alone, so the value of debate is measured rather than assumed.
  - **success:** One invocation produces both results plus the verdict-difference rate and token cost of each, on any change the tool can review.

- **CAP-10** — harness plugin integration
  - **intent:** MAD runs inside an agent harness, requesting models by role and tools from the host, so the user configures nothing MAD-specific beyond a budget.
  - **success:** The orchestrator core runs against the shipped opencode adapter with no harness-specific code in the core; MAD names no model anywhere, and every model it uses is selected at runtime from the set the host already has configured. A fresh install runs with no MAD-specific configuration at all. Contract in `host-integration.md`.

- **CAP-11** — lens-augmented discovery
  - **intent:** A discovery slot may additionally carry a lens — a persona narrowing what it looks for (security, performance, reliability, tests, maintainability, privacy and accessibility, stated intent, outsider) — so depth on one dimension supplements the pool's breadth. Lenses are additive coverage and never a substitute for a heterogeneous roster.
  - **success:** Over a fixture change with seeded defects spanning several dimensions, a lensed pass surfaces at least one defect no unlensed pool member raised; every lens-sourced finding reaches output with no co-discovery fraction and an explicit lens-sourced label; a lens roster resolving to one model reports the lens-homogeneity warning; and lens slots never appear in `distinctLineages`. Story 9's third arm reports the recall gain and its token cost as two separate numbers.

## Constraints

- The unit of debate is the individual finding, never the whole review. Everything else derives from this.
- Positions are discovered, never assigned. No devil's-advocate or red-team role exists; disagreement must come from what a model actually concluded. A discovery **lens** — a persona narrowing what one slot looks for — is not an assigned position: it biases coverage *before* anything is found, and is stripped the moment a finding exists. A lens never survives into debate, into judging, or into diversity accounting.
- Silence is abstention, not denial. A model that did not raise a finding was never asked about it; only an argued denial counts as a no.
- Material under review is data, never instruction. A diff, a model's own prose from an earlier turn, and another participant's argument are each delimited and labelled as material wherever a stage puts them in front of a model. A change under review can contain text addressed to its reviewer; a debate transcript can contain text addressed to the judge.
- Co-discovery is a prior, not a verdict, and is never collapsed with the debate outcome into one score. Discovery signal is unprompted; debate signal is prompted; they are different evidence. Only the unlensed pool produces co-discovery. A lens-sourced finding was prompted for its dimension, so it claims **no prior at all** rather than a weak or specially-computed one, and is labelled as such in output.
- The judge never participates in discovery.
- Fact-check outranks logic evaluation. Truth is decisive; argument quality is advisory. A finding may be true with a bad argument or false with a beautiful one.
- The Fact-Checker must use tools — open the file, walk the path, run the test. A reasoning-only fact-check does not count as one.
- The Evidence Extractor keeps pointers back to raw text and is biased toward keeping too much.
- **A degraded review must never be indistinguishable from a good one.** Every co-discovery fraction records its denominator (models that actually answered); a model that drops out gets one retry, then the run proceeds with a visible warning naming it; a discovery roster that resolved to fewer distinct models than slots requested is reported as degraded; findings left undecided by budget exhaustion are surfaced, never dropped; a lens roster whose slots all resolve to one model is reported as lens-homogeneous, because several personas over one model is one model's blind spots wearing hats; and a run the user stopped names the stage it stopped at and is never rendered as one that finished.
- Judges see debaters anonymized and in randomized order, with the co-discovery count visible.
- MAD names no model and holds no credential. It defines the roles a review needs and fills them at runtime from the models the host already has configured, deduping identical models before ranking for lineage diversity. MAD may report a degraded roster but never adds a provider, overrides the host's credentials, or requires configuration to run.
- The host owns provider consent; MAD's obligation is disclosure — naming which resolved providers a review will send code to.
- Narrow judges are small-model jobs; discovery roles want cheap-to-mid models.
- The clustering engine is a separable component that can be pointed at history instead of the current run (see `deferred-v2.md`).
- The orchestrator core is harness-agnostic. No core code may assume a single host's config shape, invocation model, or tool naming.
- Token cost is a first-class constraint. The user sets the cap and caps are the primary control lever.
- Peak spend is bounded by the same accountant that bounds total spend. A run's simultaneous in-flight model turns are limited, so provider rate limiting arrives as backpressure rather than as a drop-out that blames a model.

## Non-goals

- Any use case other than code review.
- Any harness adapter beyond opencode in v1 — further adapters must stay possible, not shipped.
- Cross-run memory of either layer — no instance memory ("you already rejected this") and no `.mad/preferences.md` rule memory in v1.
- Two-key rejection (`wrong` vs `don't care`) and the calibration it feeds.
- Evidence-weighted or reputation-weighted voting.
- Human-in-the-loop escalation as a deadlock authority.
- Scoring the tool or its models from git-derived ground truth.
- Adjudicating severity by debate — severity is emitted at discovery, used for routing, and carried to output unchanged.
- MAD-owned model credentials, provider configuration, or a second consent gate on top of the host's.
- Persona packs for non-code domains — legal, technical writing, and the rest. The instruction registry is *shaped* to hold them (AD-11) and nothing more. Outside code there is no repo for the Fact-Checker to open and no test to run, so there is no ground truth; without it, debate reverts to the rhetoric this design exists to replace. Shipping the shape is not shipping permission.
- Lens-vs-lens debate, and any lens participation in judging.

## Evaluation exception (dated 2026-09-09, epic 2)

`evaluation-protocol.md` governs epic 2's live evaluation and is a companion of this SPEC.
It introduces ONE exception to the shipped contract, scoped to the evaluation path and to
nothing else:

- **An evaluation-only debate-off policy.** A run executed under the protocol may skip
  debate for every candidate, including critical severity, routing them to
  `verify-independently`. Routing still runs once and still writes `route` and
  `routeReason`; under this policy the recorded `routeReason` reads **experimental
  intervention**, which is a distinct and honest claim from "threshold agreement",
  "silence", "cap", or "exhausted budget". CAP-3's critical override is unchanged for
  every ordinary run.
- **A ledger entry gains provenance** — executed-here versus inherited-from-a-shared
  prefix, with a reference to the original execution. This is an additive schema change and
  a semantic amendment to AD-15, taken deliberately so a shared discovery prefix is billed
  once in the actual cost while each branch still inherits it against its own logical cap.
  Inherited unknown usage stays unknown.

**The shipped `clampMaxRounds` floor, the co-discovery threshold clamp, and the presets are
NOT changed by this exception.** Two mechanisms that would have changed them — `threshold: 0`
and admitting `maxRounds: 0` — were examined and rejected; `evaluation-protocol.md` §2
records why, and no story may reintroduce either.

**What epic 2 will and will not deliver against the success signal below.** A dated human
decision (2026-09-09) bought three paired blocks, descriptively, with no predeclared
product-value threshold. Epic 2 therefore reports observed differences in the deployed
debate pathway — precision, final recall, and cost — and assesses product value not at all.
The success signal's question stands as written; what is narrowed, with a date, is what
epic 2 delivers against it.

## Success signal

Run a real change through MAD and through a single strong model alone: MAD's ranked list is one a reviewer acts on directly, and the ablation harness shows debate changed enough verdicts to justify its token bill. If it does not, the design is wrong and that was found out cheaply — build the harness early.
