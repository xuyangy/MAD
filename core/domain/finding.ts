/**
 * `Finding` — the one object the pipeline mutates in place (AD-7).
 *
 * Field ownership is disjoint per stage (AD-8). Each field below is annotated
 * with the stage that OWNS it. A stage may read anything; it writes only its
 * own fields. Every field was declared here from story 1 onward, before its
 * stage existed, so no later story could invent a second conflicting name for
 * one. As of story 6 every stage WRITES: `discover`, `cluster`, `route`,
 * `debate`, `judge` and `output`.
 *
 * AD-8's ownership list for discovery, in full and in one place: **claim,
 * reasoning, locus, severity, author, source, lens.** Nothing else. `source` and
 * `lens` joined it with CAP-11 (story 2A); every other stage reads them and
 * writes neither.
 *
 * AD-8's ownership list for CLUSTERING, likewise in one place: **clusterId,
 * coDiscovery, mergedIds, clusterSeverity.** Nothing else, and `severity` in
 * particular is NOT on it — see `effectiveSeverity` below for why the cluster's
 * severity had to become a fourth field rather than a rewrite of the first.
 *
 * AD-8's ownership list for ROUTING (story 4): **route, routeReason.** Two
 * fields, and two is the whole list — the judge's MODE is derived from `route`
 * rather than stored beside it (`core/stages/route.ts`). Routing READS severity
 * and coDiscovery and writes neither: AD-10 exists because routing depends on
 * severity, so a stage that rewrote it would change what already happened.
 *
 * AD-8's ownership list for DEBATE (story 5): **exit**, the debate entries it
 * appends to `history`, and — only on budget exhaustion — `unresolved`. That is
 * the whole list, and three things are pointedly NOT on it:
 *
 * - `verdict` is the JUDGE's (story 6), including `withdrawn-by-author`. When an
 *   author withdraws, debate records the withdrawal as that author's POSITION in
 *   `history` and exits `converged`; the judge reads the entry and writes the
 *   verdict. Writing it here would make debate a second writer of a field it
 *   does not own, and `withdrawn-by-author` is already a `Verdict` value below.
 * - `severity`, `coDiscovery` and `clusterSeverity` are read and never written
 *   (AD-10), for routing's reason exactly: debate DEPENDS on the contest those
 *   fields produced, so a stage that rewrote them would change what already
 *   happened.
 * - the finding itself is never removed. Deniers cannot delete a finding, an
 *   author's withdrawal does not delete it either, and no code path in the stage
 *   filters the set. A withdrawn finding leaves debate present, exited, and with
 *   its `verdict` unset.
 *
 * `exit` is written EXACTLY ONCE per debated finding, and a `route: "judge"`
 * finding never receives one — that absence is what tells a reader the finding
 * was never argued, which is a different fact from having been argued to no
 * conclusion.
 *
 * AD-8's ownership list for the JUDGE (story 6): **evidence, factCheck,
 * logicEval, verdict**, the judge entries it appends to `history`, and — only on
 * budget exhaustion — `unresolved`. Nothing else, and the exclusions matter as
 * much as the list:
 *
 * - `exit` is DEBATE's and is read, never written. The judge branches on it and
 *   on the exit entry's `exitReason`; rewriting either would change the record of
 *   what happened before the judge existed.
 * - `severity`, `coDiscovery` and `clusterSeverity` are read and never written
 *   (AD-10, AD-9). A verdict is not a severity and never becomes one.
 * - `rank` is OUTPUT's. The judge decides what is true, not what sorts first.
 * - the finding is never removed, `judge-ruled-invalid` included. An invalid
 *   finding is reported as invalid, not hidden — AD-6's honesty rule applies to a
 *   verdict as much as to a degradation.
 *
 * `unresolved` therefore has TWO writers, debate and judge, and that is
 * deliberate rather than an AD-8 exception: the field records WHICH STAGE the
 * budget died at, so the stage that ran out is necessarily the one that writes
 * it, and `diedAtStage` is what keeps the two apart.
 */

/** AD-10 — the severity scale is exactly these four values, and nothing else. */
export const SEVERITIES = ["critical", "high", "medium", "low"] as const
export type Severity = (typeof SEVERITIES)[number]

/** AD-10 — ordering for triage. Higher number sorts first. */
const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
}

export function severityRank(severity: Severity): number {
  return SEVERITY_ORDER[severity]
}

/**
 * Locus — repo-relative POSIX path, 1-indexed lines, `endLine` inclusive and
 * equal to `startLine` for a single line (spine, Consistency Conventions).
 * A finding with no single site (an architectural claim) carries `file` only.
 */
export interface Locus {
  file: string
  startLine?: number
  endLine?: number
}

/** The six pipeline stages, in order (spine, Design Paradigm). */
export type Stage = "discover" | "cluster" | "route" | "debate" | "judge" | "output"

/**
 * WHY a debate ended, beside WHAT its exit was — the vocabulary `Entry.exitReason`
 * is drawn from.
 *
 * `Finding.exit` is three values and three words are not enough for the judge,
 * and AD-6 is the reason: a room that AGREED and a room where nobody but the
 * author ever spoke both land on `converged`, and "nobody contested it because
 * nobody answered" rendered as "the standing positions settled" is a degraded
 * review reading exactly like a good one.
 *
 * IT LIVES IN THE DOMAIN, not in `core/stages/debate.ts`, because `Entry` is a
 * domain type and a stage may not own a field's vocabulary while the domain owns
 * its declaration. Story 5 encoded the reason INTO the entry's `kind`
 * (`debate-exit-<exit>-<reason>`) and read it back with `kind.split("-").at(-1)`;
 * `deferred-work.md` recorded that the honest shape is a typed field "the moment
 * story 6 wants to branch on a reason", and story 6 does — the judge must tell
 * `uncontested` and `unsure` from `agreed`, because unanimous uncertainty must
 * not reach a reader as a settled debate. The `kind` still carries the reason for
 * a human reading the record; the TYPED FIELD is what code branches on.
 */
export type ExitReason =
  /** Two or more voices, all holding the same definite position. Real agreement. */
  | "agreed"
  /** The author withdrew. A finding dies only by its author's own hand. */
  | "withdrawn"
  /**
   * ONE voice was ever heard. Nobody disagreed because nobody else answered —
   * which is not the same fact as agreement and must never render as one.
   */
  | "uncontested"
  /**
   * Every standing position is `unsure`. Unanimous uncertainty is a settled
   * debate in the sense that nobody is going to move, and it is precisely the
   * case the judge must know was unresolved BY EVIDENCE rather than agreed.
   */
  | "unsure"
  /** People spoke and nobody moved. `cost-model.md` lever 3. */
  | "restated"
  /** Nobody stated a position at all. More rounds cannot help. */
  | "silent"
  /**
   * The round budget ran out with the room still open — the ONLY reason the
   * end-of-stage sweep may write, and never a reason `exitFor` returns.
   *
   * It exists because the sweep used to reuse `restated`, whose sentence
   * ("nobody moved… the remaining rounds were not spent") is false of every
   * finding that actually reaches the sweep: a room that had stopped moving
   * exits `stalled` from `exitFor` first, so anything surviving to the cap was
   * still moving, and every round WAS spent (code review 2026-08-26).
   *
   * The one-word constraint story 5 recorded here is GONE (story 6): it existed
   * only because the reason was recovered by splitting `kind` on `-`, and the
   * typed field below is read directly. A future hyphenated reason is safe.
   */
  | "capped"

/**
 * AD-7 — `history` is append-only. Every entry carries at minimum
 * `{ stage, actor, at, kind, body }`. Debate-round entries (story 5) add the
 * round fields; they are optional here so the shape does not change later.
 */
export interface Entry {
  stage: Stage
  /** Who produced the entry — a roster slot id, or `mad` for the orchestrator. */
  actor: string
  /** UTC ISO-8601. */
  at: string
  kind: string
  /** Model-authored prose passes through unparsed (AD-11). */
  body: string
  round?: number
  position?: string
  positionChanged?: boolean
  concession?: string
  citations?: string[]
  /**
   * Set on a DEBATE EXIT entry and on nothing else (story 6). Optional because
   * every other entry kind legitimately has no exit reason — not because an exit
   * entry may omit it: `recordExit` in `core/stages/debate.ts` is the one writer
   * and always sets it.
   */
  exitReason?: ExitReason
}

/**
 * AD-9 / spine conventions — co-discovery is stored as a pair, never as a
 * pre-divided float, and always renders as a fraction with its denominator.
 * `answered` is how many models actually answered, never how many were
 * requested (AD-6a).
 */
export interface CoDiscovery {
  raised: number
  answered: number
}

/** AD-9 — verdict is its own field; it is never fused with anything else. */
export type Verdict = "upheld" | "withdrawn-by-author" | "judge-ruled-invalid" | "not-adjudicated"

/**
 * AD-9 amended / AD-17d — where a finding came from, and the ONLY discriminator
 * for "no co-discovery prior is claimable".
 *
 * `coDiscovery === undefined` already means "clustering has not run" (AD-14,
 * story 3). Overloading it to also mean "no prior claimable" makes a lens
 * finding silently rank as though clustering failed. Two absences, two
 * mechanisms, one field to tell them apart.
 */
export type FindingSource = "pool" | "lens"

export interface Finding {
  // ---- discover owns (AD-8) ----
  /** Stable from the moment of discovery; survives clustering. */
  id: string
  /** Model-authored prose — passes through unparsed (AD-11). */
  claim: string
  /** Model-authored prose — passes through unparsed (AD-11). */
  reasoning: string
  locus: Locus
  severity: Severity
  /** The roster slot that raised it. */
  author: string
  /**
   * AD-9 amended / AD-17d — REQUIRED, and required is the point. Optional would
   * make "absent" a third meaning alongside "not yet clustered" and "no prior
   * claimable", and AD-9's discriminator would stop discriminating.
   */
  source: FindingSource
  /**
   * AD-17 — the lens that produced it, set only when `source === 'lens'`. This
   * field and `LensSlot.lens` are the only places a lens is readable: it is
   * never parsed out of a slot id, never carried into a debate instruction
   * (AD-17a), and stripped by the anonymizer with model identity (AD-17b).
   */
  lens?: string

  // ---- cluster owns (AD-8) — story 3 ----
  /**
   * Set on EVERY finding clustering processes, singletons included (AD-14
   * amended 2). It is what `core/stages/output.ts` reads as "clustering has
   * run"; written only on merges, a run in which nothing merged would be
   * indistinguishable from a run that never clustered.
   */
  clusterId?: string
  coDiscovery?: CoDiscovery
  /** Ids merged into this canonical finding, so transcript references resolve. */
  mergedIds?: string[]
  /**
   * AD-10 — the highest severity among the cluster's members, set on the
   * canonical only when it differs from the canonical's own. Read through
   * `effectiveSeverity`, never directly.
   */
  clusterSeverity?: Severity

  // ---- route owns (AD-8) — story 4 ----
  /**
   * CAP-3. `'judge'` MEANS the judge's verify-independently mode
   * (`pipeline-stages.md` §5) — threshold-skipped, no transcript, Fact-Checker
   * only. `'debate'` reaches the same judge afterwards in adjudicate mode. The
   * mode is derived from this field, never stored beside it.
   */
  route?: "debate" | "judge"
  /**
   * Why it took that route, in words. A lens finding's reason never mentions the
   * threshold, because no fraction was placed against it (AD-17d, AD-9 amended).
   */
  routeReason?: string

  // ---- debate owns (AD-8) — story 5; rounds are appended to `history` ----
  exit?: "converged" | "stalled" | "cap"

  // ---- judge owns (AD-8) — story 6 ----
  /**
   * AD-9 / AD-11 — what the Evidence Extractor pulled out of the argument, as
   * model-authored prose. Kept separate from `verdict` and `coDiscovery`, and
   * never fused with either.
   *
   * ABSENT IS NOT "no evidence". It means no extractor ran — a
   * verify-independently finding has no transcript to extract from, and a
   * finding the budget stranded may have died before its extractor turn. Output
   * renders the absence as `assertion only`, which is the honest reading of both.
   */
  evidence?: string
  /**
   * The Fact-Checker's prose, prefixed by MAD with whether the check was
   * VERIFIED or UNVERIFIED (AD-13): a check that opened no file and ran no test
   * is not a fact-check, and a reader must not have to infer that from the
   * wording a model chose.
   */
  factCheck?: string
  /**
   * The Logic Evaluator's prose. ADVISORY, and absent on every
   * verify-independently finding by design — there is no argument to evaluate
   * when there was no debate (`pipeline-stages.md` §5).
   */
  logicEval?: string
  verdict?: Verdict

  // ---- output owns (AD-8) ----
  rank?: number

  /**
   * AD-6d — set when the budget ran out before this finding was decided.
   *
   * Written by DEBATE or by JUDGE, whichever stage the money ran out in, and
   * `diedAtStage` is what tells them apart. Two writers of one field is not an
   * AD-8 exception: the field's whole content is "which stage stopped", so the
   * stage that stopped is necessarily its author.
   *
   * A finding carrying this has NO `verdict`. Undecided and decided-invalid are
   * different facts and output prints them in different sections.
   */
  unresolved?: { diedAtStage: Stage; reason: string }

  /** AD-7 — append-only. */
  history: Entry[]
}

/**
 * AD-10 — the ONE read path for "how severe is this finding now".
 *
 * AD-10 says two things that cannot both hold if a merged cluster's severity is
 * written onto the canonical's own `severity`: the cluster takes the HIGHEST
 * severity among its members, and NO stage after discovery writes `severity`.
 * Picking the most severe member as canonical does not resolve it either — a
 * `critical` LENS member may not be canonical (AD-9's rendering rule), so its
 * severity would simply be lost.
 *
 * So clustering writes `clusterSeverity`, a field it owns (AD-8), and every
 * reader asks here instead of choosing between two fields at each call site.
 * Story 4's routing reads this same helper.
 */
export function effectiveSeverity(finding: Finding): Severity {
  return finding.clusterSeverity ?? finding.severity
}

/**
 * AD-7 — the only sanctioned way to touch `history`. No stage rewrites or
 * removes an entry it did not append.
 */
export function appendEntry(finding: Finding, entry: Entry): void {
  finding.history.push(entry)
}
