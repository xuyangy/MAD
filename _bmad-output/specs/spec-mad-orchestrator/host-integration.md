# Host integration

MAD is a plugin for an agent harness (opencode, oh-my-openagent, pi-agent, Claude Code, Codex CLI, agy), not a standalone tool. The orchestrator core is harness-agnostic; **v1 ships exactly one adapter, targeting opencode**, with the seam proven. Cited by CAP-10 in `SPEC.md`.

## Division of responsibility

| Concern | Owner |
| --- | --- |
| Which models exist, credentials, provider fallbacks | Host |
| Selecting a roster from the models the host offers | MAD |
| User consent to send code to a provider | Host |
| Tool execution (read file, walk path, `git blame`, run test) | Host |
| Invocation surface (command, subagent, whatever the host exposes) | Host |
| Which roles a review needs, and how many | MAD |
| Tool availability, and whether a given backend has any | Host declares, MAD reads |
| Clustering, routing, debate, judging, ranking | MAD |
| Disclosing the provider fan-out a run implies | MAD |
| Detecting and reporting a non-heterogeneous roster | MAD |

## Role-based model requests

MAD never names a model, holds no credential, and owns no provider config. It defines the **roles** a review needs, then resolves each one against the models the host already has configured — in opencode, by enumerating `client.config.providers()` and selecting from what comes back.

Roles are MAD's internal vocabulary for *what kind of work a slot does*; they are not a primitive the host is expected to provide. No harness surveyed offers role resolution with its own fallback chain: opencode's `session.prompt` takes a concrete `{providerID, modelID}`, and its agent definitions bind a model one indirection further out. So resolution is MAD's to perform, over a menu the host owns.

The consequence that matters for setup: **a fresh install runs with no MAD-specific configuration at all.** MAD reads what is already there and picks a roster (see *Roster selection* below). User config overrides that selection; it is never required to produce one.

| Role | Wants | Notes |
| --- | --- | --- |
| `discovery-*` | N distinct cheap-to-mid models | N slots, and they must resolve to *different* models. Heterogeneity is the recall mechanism. |
| `discovery-lens-*` | M slots, each carrying one lens | Optional and additive. Filled after the unlensed pool from the same deduped list; may reuse a model the pool already holds, because a lens slot claims no diversity. Never counted in `distinctLineages`. Off by default. |
| `debate` | the model that authored the finding | Positions are discovered, not assigned — a debater is whichever discovery model raised or contested the finding. |
| `evidence-extract` | cheap | Pulls the claims and citations out of a debate transcript. *Added 2026-08-27 (story 6): the Evidence Extractor is a model turn like the three below it, and this table was simply short a row — the stage was never unnamed, only unlisted. It has no lens variant, because a lens is stripped by the anonymizer before it reads anything (AD-17b).* |
| `fact-check` | cheap, tool-capable | "Does this cited line say what he claims?" is a small-model job, but it must be able to open the file and run the test. |
| `logic-eval` | cheap | Advisory rating of argument quality. |
| `aggregate` | mid | Produces the verdict from fact over logic. |

**How the four judge roles are FILLED, as of story 6.** They are assigned across the discovery slots the host already resolved, not resolved as slots of their own: `Roster` holds discovery and lens slots, and the opencode adapter throws on a slot id the roster never filled, so real judge slots cost a roster change, a selection change, an adapter change and a plugin-wiring change — the roster work story 8A owns. Assignment prefers a slot that is not the finding's own author, requires a tool-capable slot for `fact-check` wherever one answered (AD-13), and rotates by finding so one model does not carry every judge turn. A slot may therefore hold more than one role on a small roster: the decomposition CAP-5 asks for is in the four separate narrow turns, not in four separate models. Lens slots never judge. **Story 8A is where the `Wants` column above becomes a resolution decision rather than a description.**

## Roster selection

Filling the `discovery-*` slots is the one resolution decision with teeth, because heterogeneity is the recall mechanism. It runs as three operations, in order.

**0. Pin what the user named.** A caller may supply explicit `provider/model` slots. They fill first, in the order given, and ranking fills only the remainder — a pinned slot is a user decision and MAD does not second-guess it. Pinning happens *after* dedupe, so two pinned providers reaching one model fill one slot and leave the roster short, which is reported like any other thin roster. Pinning is optional; a fresh install pins nothing and gets a full auto-resolved roster (AD-3).

*Shipped 2026-09-04 (story 8A) as the `models` argument on `mad_review`, taking `provider/model` strings.* Two clarifications the implementation had to settle, neither of which this paragraph said: (a) *"MAD does not second-guess it"* governs the SELECTION and nothing else — every AD-6c report is byte-identical over a pinned roster and a ranked one, and a pinned slot carries no field a suppression could branch on; (b) a pin the host does not offer needed a report of its own, `roster-pin-unhonoured`, because when ranking backfills the fallen-through slot the roster comes out FULL and `roster-underfilled` never fires — and its remedy, "add a provider", is not the fix for a misspelled model id. The report carries a per-pin reason: `not-offered`, `dedupe-collapsed`, `no-slot`, `malformed`.

**1. Dedupe by model identity.** Candidates are keyed by normalized identity — family and version, snapshot date stripped — so one model never occupies two slots however many providers reach it. Claude via Anthropic and Claude via Bedrock are *one* candidate, not two.

**2. Rank by diversity.** Slots fill to maximize distinct **lineages** first, then distinct models within a lineage:

| | Roster | Verdict |
| --- | --- | --- |
| Ideal | Claude + GPT + Gemini | three lineages |
| Acceptable | Sonnet + Haiku + GPT | two lineages, when the host has no third |
| Degraded | Sonnet + Haiku + Opus | one lineage — runs, warns loudly |
| Denied | Claude (Anthropic) + Claude (Bedrock) | same model; deduped before ranking |

Lineage is the unit because correlated blind spots come from shared training data, not from shared endpoints. It is claimed from a small shipped table of model-id markers; an unrecognized model is reported `lineage unverified` and **never counted as a fresh lineage**, so a stale table degrades into an honest unknown rather than a false diversity claim.

Temperature variation across one model is **not** an accepted substitute for a diverse roster. Neither is lens variation: several personas over one model are one model's blind spots wearing hats. Lenses buy coverage, not independence, and the two are reported separately for that reason (AD-17c, AD-6e).

A pinned roster is held to exactly the same standard. `distinctLineages` counts verified lineages only, an unrecognized pinned model is `lineage unverified` and never counted as fresh, and a pinned `Sonnet + Haiku + Opus` warns as loudly as a ranked one. The user choosing the models does not make correlated blind spots go away.

## Degradation reporting

MAD does not override host model choice, and it does not refuse to run. It reports what it got:

- **Roster not heterogeneous** — discovery slots resolved to fewer distinct lineages than slots requested. Warn loudly in the output, naming the lineage and the host config key the user would edit to add a provider; co-discovery numbers over a single-lineage roster mean much less than over a diverse one. A slot filled by a model the lineage table does not recognize is reported `lineage unverified` rather than counted as diverse.
- **Model dropped out** — one retry, then proceed with a visible warning naming the model, alongside the recorded denominator.
- **Provider fan-out** — name the resolved providers a review will send code to. Disclosure, not a consent gate; the host already holds credentials and the user's consent.
- **Lens roster homogeneous** — the lens slots (CAP-11) all resolved to one model. Warn, naming the model, and state that several personas over one model share that model's blind spots. Lens slots never count toward `distinctLineages`, so this is a separate fact from the heterogeneity report above (AD-6e, AD-17c).

- **Run cancelled** — the user stopped the run. Name the stage it stopped at and carry the findings it had, in the same section as budget-exhausted findings but under its own cause (AD-6f). A cancelled model turn is not a drop-out and gets no retry: the user's stop is not a provider failure.

The rule behind all five: a degraded review must never be indistinguishable from a good one — and neither must a stopped one.

## Portability

The core takes a repo handle, a tool interface, and a **model backend**: `runTurn(slot, instructions, input, schema) → Envelope`. Async, request/response, **non-streaming** — no stage may depend on incremental token output. Each backend declares its capabilities, at minimum whether it has tools.

That shape is deliberate. Claude Code is Anthropic-only and Codex is OpenAI-only, so on those harnesses a heterogeneous roster cannot come from an in-host call at all — it has to come from running another agent CLI as a process, or a pane in a runtime like herdr. A backend of that kind is slower and its tools are the other agent's, but it satisfies the same port without a core change.

Everything harness-specific lives in the adapter. Additional adapters are a v1 non-goal, but nothing in the core may assume a single host's config shape, invocation model, or tool naming.

A worked example of that backend shape exists outside this project and is digested in `reference/README.md`: fusion-harness's `child-runner.ts` spawns the host CLI as `--mode json -p` with skills, extensions, and context files all disabled — a clean room whose entire contract is the prompt, and whose disabled-extensions flag is also the recursion guard that stops the plugin invoking itself. Read for the mechanism, not for the shape: MAD's port is stateless per turn and that is deliberate (AD-2).
