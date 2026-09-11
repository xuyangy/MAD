/**
 * Degradation warnings (AD-6).
 *
 * Spine convention: warnings are structured values on the run record, raised by
 * the stage that detected them and rendered once at output — never
 * `console.log`ged from inside a stage.
 */

import type { Stage } from "./finding.ts"

/**
 * The vocabulary, as a runtime LIST rather than a bare type union.
 *
 * The union came first and could not be counted, so nothing could pin it: a code
 * added here reached the renderer's disclosure/degradation split with no reader
 * ever deciding which side it belonged on. The list is the shape `SEVERITIES`
 * and `DEBATE_POSITIONS` already use in this codebase, and it lets
 * `warning.test.ts` pin the count the way `material.test.ts` pins the span
 * labels — so a new code forces somebody to come back and classify it.
 */
export const WARNING_CODES = [
  /** AD-6c — the roster resolved to fewer distinct lineages than slots. */
  "roster-single-lineage",
  /** AD-5 / AD-6c — a slot filled by a model the lineage table does not know. */
  "roster-lineage-unverified",
  /** AD-6c — fewer candidates existed than slots requested, so slots went unfilled. */
  "roster-underfilled",
  /**
   * AD-6e — every lens slot resolved to ONE model. Several personas over one
   * model share that model's blind spots. A separate fact from the lineage
   * report above, because lens slots never enter `distinctLineages` (AD-17c).
   */
  "roster-lens-homogeneous",
  /** AD-6b — a model errored or timed out; one retry, then the run proceeds. */
  "model-dropped-out",
  /** AD-6a — fewer models answered than were requested. */
  "denominator-reduced",
  /** AD-12 — a model answered, but some items in its envelope failed validation. */
  "partial-envelope",
  /** AD-3 — disclosure of the providers a run sends code to. */
  "provider-fan-out",
  /** AD-6d — findings undecided when the budget ran out. */
  "unresolved-findings",
  /**
   * AD-13 / AD-6 — a fact-check ran without tools, so nothing it says is
   * verified. Either no answering slot reported tool capability, or the checker
   * reported opening nothing. Raised by the judge, never by the adapter: tool
   * capability is READ per slot and the routing decision is the core's.
   */
  "fact-check-untooled",
  /**
   * AD-6 — the judge stage could not run at all, because no POOL slot answered
   * discovery. Every finding therefore reaches output unadjudicated, and without
   * this a reader would see "not adjudicated" everywhere with no cause given —
   * a degraded review indistinguishable from an undecided one.
   */
  "judge-unavailable",
  /**
   * AD-6f (story 7A) — THE USER STOPPED THE RUN.
   *
   * The sixth report, and a degradation rather than a disclosure: a stopped run
   * is a PARTIAL run, which is precisely what AD-6 governs. Stories 2A, 3 and 4
   * each declined a sixth code on the recorded ground that a clamp or a route is
   * a decision rather than a partial run; a cancellation is not that, so the
   * `Ask First` is answered here rather than declined a fourth time.
   *
   * It is raised ONCE per run, by `core/run/review.ts`, naming the stage the run
   * stopped at — a fact about the run, which no single stage is in a position to
   * state. It is NOT `model-dropped-out`: no model failed, and the findings it
   * strands carry a cancellation reason that a reader can tell apart from
   * `unresolved-findings`' budget reason. "We ran out of money" and "you pressed
   * stop" are different facts, and neither is "we finished".
   */
  "run-cancelled",
  /**
   * AD-6a / AD-15 (story 8) — THE BUDGET TRUNCATED DISCOVERY.
   *
   * The thirteenth code, and a degradation for `run-cancelled`'s reason exactly:
   * a roster MAD chose not to finish asking is a PARTIAL run, which is what AD-6
   * governs. Stories 2A, 3 and 4 each declined a new code because a clamp or a
   * route is a decision rather than a partial run; this is not that.
   *
   * IT IS NEITHER OF ITS TWO NEIGHBOURS, and the whole reason it exists is that
   * folding it into either one would be a false report:
   *
   * - NOT `model-dropped-out`. THE SLOTS THIS CODE NAMES were never asked, so no
   *   model failed on them. Naming a provider here would blame a working model
   *   for the user's own budget, which is the exact class of dishonesty this
   *   tool is built against.
   *
   *   SCOPED TO ITS OWN SLOTS, and the message says so in as many words (code
   *   review 2026-09-06). A model CAN drop out elsewhere in the same run — and
   *   its retry is a plausible reason discovery's share ran out in the first
   *   place — so a run-level "no model failed" would be false. The two reports
   *   coexist and each speaks only for the slots it names.
   * - NOT `unresolved-findings`. That is AD-6d, raised over findings that exist
   *   and were left undecided. At the point discovery is truncated there are no
   *   findings yet to strand — the loss is recall, not adjudication.
   *
   * It sits BESIDE `denominator-reduced` rather than inside it: that code says
   * the denominator shrank, this one says the budget is why. A host agent
   * reading only codes can then tell a budget-truncated roster from an
   * under-delivering one, which is the whole argument for a code over a sentence.
   *
   * Raised ONCE per run, by `core/stages/discover.ts`, naming how many pool and
   * lens slots went unasked and the discovery ceiling that refused them.
   */
  "discovery-truncated",
  /**
   * AD-3 amended / AD-6c (story 8A) — A PIN THE RUN COULD NOT HONOUR.
   *
   * The fourteenth code, and it exists because NO EXISTING CODE CAN CARRY THE
   * FACT WITHOUT LYING. AD-3's amendment requires a pin the host does not offer
   * to be reported and its slot to fall through to ranking — and when ranking
   * backfills that slot the roster comes out FULL, so `roster-underfilled` does
   * not fire at all. If it were made to fire, its message ("the host offers only
   * N distinct model(s)... add a provider") would be false twice over: the host
   * may offer plenty, and adding a provider is not the fix for a misspelled pin.
   * `provider-fan-out` is a disclosure and would file a request MAD could not
   * honour as a fact about configuration.
   *
   * Stories 2A, 3 and 4 each declined a new code on the recorded ground that a
   * clamp or a route is a decision rather than a partial run. A pin that named a
   * model the run then did not use is not that: the caller asked for a specific
   * roster and got a different one, which is a fact about what was reviewed.
   *
   * IT IS ABOUT THE PIN AND NEVER ABOUT THE ROSTER'S QUALITY. It carries a
   * per-pin reason — `not-offered`, `dedupe-collapsed`, `no-slot`, `malformed` —
   * and says nothing about diversity, because the four AD-6c reports already say
   * everything there is to say about that and say it identically whether a slot
   * was pinned or ranked. In particular it must never grow a sentence like "you
   * pinned these, so adding a provider will not help": that is false whenever
   * fewer pins than slots were given, and it is the "the user asked for it"
   * suppression AD-4's amendment forbids, wearing a remedy note as a disguise.
   *
   * Raised ONCE per run, by `core/roster/select.ts`, and only when pins were
   * supplied and at least one was not honoured.
   */
  "roster-pin-unhonoured",
  /**
   * AD-6 (epic-1 retrospective, ledger triage bucket D) — A DIAL THE RUN DID NOT
   * HONOUR AS ASKED.
   *
   * The fifteenth code. Stories 2A, 3 and 4 each declined a new code here on the
   * recorded ground that *a clamp is a decision rather than a partial run*, and
   * the effect compounded: `clampThreshold(4)` silently became `1`,
   * `clampMaxRounds(0)` silently became `3`, `clampPreset("thorough")` silently
   * became `normal`. Three requests answered with a different number and nothing
   * said. The retrospective put the question to the human once instead of a
   * fourth decline, and the answer was yes.
   *
   * WHY IT MEETS THE BAR THE LAST THREE CODES SET. `run-cancelled`,
   * `discovery-truncated` and `roster-pin-unhonoured` each argued the same two
   * things, and both hold here. **No existing code can carry the fact without
   * lying:** nothing else speaks about the dials, and bending `denominator-reduced`
   * or `roster-underfilled` to say it would file a request MAD did not honour as
   * a fact about the roster. **And it is a fact about WHAT WAS REVIEWED, not a
   * decision MAD made:** the threshold decides which findings entered debate at
   * all, so a run held to `1` when the caller asked for `4` examined a different
   * set of findings than the caller asked for — and reported the clamped dial as
   * though it were the requested one.
   *
   * The counter-argument, recorded: the caller here is a programmer, not an end
   * user, and TypeScript rejects most of these at the call site. True, and it is
   * why this took four stories to answer. `review()` is an EXPORTED seam and
   * TypeScript does not police a JavaScript caller — the same reasoning
   * `clampConcurrency`'s header already gives for why its own failure modes are
   * reachable at all.
   *
   * NOT RAISED WHEN THE CALLER PASSED NOTHING. Absence is not a clamp: it is the
   * caller declining to set a dial, and warning about it would fire on every
   * default run and teach the reader to skip the warning block — which is the one
   * outcome AD-6 cannot afford.
   *
   * ONE PER RUN, EMITTED BY `core/run/review.ts`, which is the seam where a
   * caller's request meets the clamp. It names every dial that moved, with what
   * was asked for and what is in force.
   *
   * One per run is not one raise site (code review 2026-09-08).
   * `truncatedListWarnings` in `adapters/opencode/plugin.ts` constructs this code
   * too, for the list clamps that happen before the core sees the request at all;
   * `review()` folds those dials into its own and emits the single warning. So
   * the invariant this paragraph promises is enforced by the FOLD, not by there
   * being only one constructor — and a reader chasing where a dial name came from
   * should look at both. The fold also re-stages an adapter-origin clamp from
   * `roster` to `discover`, which is the stage the surviving warning is about.
   */
  "dial-clamped",
  /**
   * AD-6 / AD-13 / CAP-8 (story 10) — MAD TRIED TO RUN `git blame` ITSELF AND
   * COULD NOT.
   *
   * A bad path, a line past the end of the file, an uncommitted line, a shallow
   * clone, or a worktree that is not a git repository. The citation the run
   * would have carried does not exist, and the finding was decided without it.
   *
   * WHY IT MEETS THE BAR THE LAST FOUR CODES SET. **No existing code can carry
   * the fact without lying:** `fact-check-untooled` asserts that no model could
   * use tools, which would be a falsehood in MAD's own voice on a run where the
   * checker's own agent had tools and used them — the failure was MAD's own
   * execution, not the model's capability. **And it is a fact about what was
   * reviewed, not a decision MAD made:** the run examined the finding with one
   * class of evidence missing, and every verdict downstream of it is a verdict
   * reached without the citation.
   *
   * IT MUST NEVER READ AS "NO CONTRADICTION FOUND". That is the whole of it. A
   * blame that failed and a blame that ran and supported the claim are opposite
   * facts, and `.nothrow()` in the adapter would have made them the same empty
   * string. Raised by the judge, which is the only caller of the port.
   *
   * A DEGRADATION, NOT A DISCLOSURE — so it is deliberately absent from
   * `DISCLOSURE_CODES` below, which is the safe default and, here, the intended
   * answer (story 10, Decision 1, approved by the human 2026-09-08).
   */
  "blame-unavailable",
  /**
   * AD-6 / AD-15 / FR10 (story 2.3) — MAD BILLED FOR A TURN IT COULD NOT COUNT.
   *
   * The seventeenth code. A turn was cancelled in flight, timed out, or settled
   * with the host reporting no `tokens` field at all. The provider billed
   * whatever it billed; MAD does not know the number and will not invent one
   * (`core/domain/run-record.ts`, `UnknownUsageEntry`). So the run's TOKENS line
   * is a floor standing in the position a total occupies, and this code is the
   * sentence that says so in the vocabulary rather than only in the prose of one
   * renderer.
   *
   * WHY IT MEETS THE BAR THE LAST FIVE CODES SET. **No existing code can carry
   * the fact without lying.** `model-dropped-out` blames a provider for a
   * failure that may not have happened — a settled, successful turn whose host
   * omitted `tokens` is a working model and a working provider, and the missing
   * number is MAD's own instrumentation gap. `run-cancelled` is raised once per
   * run about the USER's stop and says nothing about money; `unresolved-findings`
   * is AD-6d and is about findings, not about the bill. **And it is a fact about
   * what was reviewed, not a decision MAD made:** every cost figure the run
   * prints, and every cost comparison an ablation draws from it
   * (`evaluation-protocol.md:511-517` — "a missing tag is not evidence of
   * complete usage"), was computed over a total that is known to be short.
   *
   * A DEGRADATION, and this one is not the safe default falling through — it is
   * the answer. AD-6's honesty rule exists so a degraded review cannot read like
   * a good one, and the single number a reader most takes for exact is the token
   * total. Filing an untrustworthy total as a *disclosure* would put it under a
   * heading that says the run is fine.
   *
   * IT MUST NEVER READ AS "THIS TURN WAS FREE". That is the whole of it, and it
   * is the exact lie story 2.3 deletes: `emptyTokenUsage()` is a truthy object,
   * so a fabricated all-zero entry used to reach the ledger and a turn that
   * billed money was recorded as a turn that cost nothing.
   *
   * Raised by the stage that detected it, over the unknown-usage entries the
   * ledger now carries, and rendered once at output.
   */
  "usage-unquantified",
  /**
   * AD-2 / AD-6 (story 2.3) — A SESSION MAD OPENED AND COULD NOT DELETE.
   *
   * The eighteenth code. Session disposal is bounded by a deadline (AC3: an
   * unresolved cleanup is exposed rather than awaited silently), so a `delete`
   * that hangs or throws now ends the turn with the session still on the host
   * instead of holding the run open until it answers.
   *
   * A DISCLOSURE, AND IT IS THE FIRST CODE SINCE `provider-fan-out` TO EARN
   * THAT SIDE. `adapters/opencode/model-backend.ts` has recorded the judgement
   * in prose since story 1 — "a session we cannot delete is untidy, not a
   * failure of the review" — and this code puts that same judgement in the
   * vocabulary without changing it. Nothing about an orphaned session changes
   * which findings were raised, which were argued, or which were judged: the
   * review is worth exactly what it was worth, and the only actionable fact is
   * that something remains on the host.
   *
   * WHY IT IS A CODE AT ALL, GIVEN THAT. Because the alternative is silence.
   * The old `finally { await this.disposeSession(...) }` swallowed every failure
   * on purpose and reported nothing, which is defensible for an error and not
   * defensible for a resource the user is still paying to store. A disclosure is
   * what "here is a fact, it is not a fault" looks like in this vocabulary, and
   * it is the same shape `provider-fan-out` uses for "here is where your code
   * went".
   *
   * IT MUST NEVER GROW A DEGRADATION'S VOICE. In particular it must not say the
   * turn failed, name a model, or appear beside `model-dropped-out` — the turn
   * it rides on may have succeeded completely, and usually did.
   */
  "session-cleanup-unresolved",
] as const

export type WarningCode = (typeof WARNING_CODES)[number]

/**
 * The codes that are a DISCLOSURE rather than a degradation (story 7).
 *
 * A disclosure states a fact about how the run was configured; a degradation
 * says the run is worth less than it looks. Rendering them alike would put
 * "these are the providers your code was sent to" under a heading reading
 * "this run is degraded", which is AD-6's honesty rule pointed the wrong way.
 *
 * IT LIVES HERE, WITH THE VOCABULARY, and not as a `!== "provider-fan-out"` test
 * in `core/stages/output.ts`. A denylist in the renderer is a second, invisible
 * place the vocabulary is defined: a code added to the list above lands in the
 * degradation bucket whether or not that is what it means, and nobody editing
 * this file would see the renderer at all. Being listed here is what makes a
 * code a disclosure; anything unlisted is a degradation, which is the safe
 * default — over-reporting a degradation is noise, under-reporting one is the
 * failure AD-6 exists to prevent.
 */
export const DISCLOSURE_CODES: ReadonlySet<WarningCode> = new Set<WarningCode>([
  /** AD-3 — which providers a run sends code to. A fact, not a fault. */
  "provider-fan-out",
  /**
   * AD-2 (story 2.3) — a session MAD opened and could not delete. Untidy on the
   * host, not a failure of the review, and the turn it rides on may have
   * succeeded completely. The reasoning is at the code's own entry above; it is
   * repeated nowhere, because being listed HERE is what makes a code a
   * disclosure and the argument belongs beside the code it is about.
   *
   * Note what is NOT here: `usage-unquantified`, which arrived in the same
   * story and is a degradation. The two are the reason `warning.test.ts` writes
   * this set out in full rather than counting it.
   */
  "session-cleanup-unresolved",
])

export interface Warning {
  code: WarningCode
  /** The stage that detected it. */
  stage: Stage | "roster"
  /** Human-readable, already carrying every name the user needs to act. */
  message: string
  detail?: Record<string, unknown>
}
