/**
 * `Finding` — the one object the pipeline mutates in place (AD-7).
 *
 * Field ownership is disjoint per stage (AD-8). Each field below is annotated
 * with the stage that OWNS it. A stage may read anything; it writes only its
 * own fields. Every field was declared here from story 1 onward, before its
 * stage existed, so no later story could invent a second conflicting name for
 * one. As of story 4 the stages that WRITE are `discover`, `cluster`, `route`
 * and `output`; the fields owned by `debate` and `judge` are still declared and
 * left unset, and will be written by stories 5–6.
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
  /** AD-9 — evidence stays separate from verdict and co-discovery. */
  evidence?: string
  factCheck?: string
  logicEval?: string
  verdict?: Verdict

  // ---- output owns (AD-8) ----
  rank?: number

  /** AD-6d — set when the budget ran out before this finding was decided. */
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
