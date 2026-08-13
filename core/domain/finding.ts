/**
 * `Finding` — the one object the pipeline mutates in place (AD-7).
 *
 * Field ownership is disjoint per stage (AD-8). Each field below is annotated
 * with the stage that OWNS it. A stage may read anything; it writes only its
 * own fields. Story 1 runs `discover` and `output` only, so the fields owned by
 * cluster / route / debate / judge are declared here and left unset — they are
 * declared now so no later story invents a second, conflicting name for them.
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
 * `{ stage, actor, at, kind, body }`. Debate-round entries (story 4) add the
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

  // ---- cluster owns (AD-8) — story 3 ----
  clusterId?: string
  coDiscovery?: CoDiscovery
  /** Ids merged into this canonical finding, so transcript references resolve. */
  mergedIds?: string[]

  // ---- route owns (AD-8) — story 4 ----
  route?: "debate" | "judge"
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
 * AD-7 — the only sanctioned way to touch `history`. No stage rewrites or
 * removes an entry it did not append.
 */
export function appendEntry(finding: Finding, entry: Entry): void {
  finding.history.push(entry)
}
