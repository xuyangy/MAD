/**
 * The CAP-1 recall harness.
 *
 * CAP-1's success criterion is a measurement, not a description: "a run over a
 * change with known seeded bugs produces a pooled finding set whose recall
 * exceeds that of any single participating model's own list". This module is the
 * measurement; `seeded-defects/` is the change it measures over.
 *
 * Three things this deliberately does NOT do:
 *
 * - **It never pre-divides.** `recall()` returns `{ found, total }` (spine, Dates
 *   & numbers). Every arm is scored against the same defect set, so `total` is
 *   shared and comparing `found` needs no division at all. A ratio here would be
 *   the pre-divided-number habit AD-9 and the number convention both push
 *   against, bought for nothing.
 * - **It does not cluster.** Matching a finding to a *planted defect* is not
 *   matching a finding to another *finding*; the latter is clustering (AD-14)
 *   and has its own engine and its own hand-labelled finding-PAIR fixture set at
 *   `core/clustering/`. Nothing here is a similarity function over findings.
 *
 * ## Story 3 (AD-14) — this harness measures `RunRecord.pool`, not `findings`
 *
 * Clustering has now run, so `record.findings` is the CANONICAL set and
 * `record.pool` is the pre-cluster union. Every caller here passes the POOL, and
 * that is a decision rather than an oversight: CAP-1's criterion and CAP-11's
 * are both claims about **discovery** — what the models raised — not about what
 * survived merging. Measured over the canonical set instead, a model whose
 * finding was absorbed into another's cluster silently loses credit for a defect
 * it really did locate, every single-model arm shrinks, and CAP-1's number
 * degrades with nothing failing to say so.
 *
 * Nothing in this module reads `clusterId`, `mergedIds` or `coDiscovery`.
 * - **It does not read `dimension` off a `Finding`.** `dimension` labels a
 *   planted bug and lives only on `SeededDefect`. It is NOT a lens: nothing here
 *   maps a dimension to a lens id, and a lens finding is never credited by
 *   matching its lens against a defect's dimension — that would score a model on
 *   what it was asked to look at rather than on what it found.
 *
 * ## Story 2A (CAP-11) superseded one note here
 *
 * The pre-2A version of this header said "no lens code is involved or implied".
 * That was true for story 2 and is not true now: `Finding.source` is a real
 * field, `recallByAuthor` and `pooledRecallBeatsBestMember` partition POOL arms
 * on it, and `lensRecallGain` answers CAP-11's criterion mechanically. What
 * remains true is the sentence above it — the harness reads `source`, never
 * `lens`, and never `dimension` off a finding.
 *
 * CAP-1's number and CAP-11's number stay SEPARATE (AD-9's two-numbers rule
 * applied to measurement): pooled-beats-best-member is a claim about the
 * unlensed pool, so lens findings are excluded from BOTH sides of it rather than
 * quietly inflating the pooled side against pool-only arms.
 *
 * The matcher is INJECTED with a shipped lexical default, mirroring AD-14's
 * injected similarity function, so a later story can supply a model-backed
 * matcher without reopening the harness.
 *
 * `fixtures/` may import `core/`; the reverse is a lint failure
 * (`scripts/lint-dependency-direction.ts`), so nothing here can leak into the
 * shipped core.
 */

import type { Finding, Locus } from "../core/domain/finding.ts"

/** The kinds of defect the seeded set plants. Story 2A adds rows, not shape. */
export const DEFECT_DIMENSIONS = [
  "security",
  "correctness",
  "data-integrity",
  "resource",
  "error-handling",
  "concurrency",
  "api-misuse",
] as const

/**
 * Open by construction. `DEFECT_DIMENSIONS` is the shipped list and keeps
 * autocomplete useful, but the type admits any string so story 2A extends the
 * seeded set by ADDING ROWS — which is what `change.ts` promises — rather than
 * first reshaping this tuple. A closed `as const` union would have made every
 * new dimension a two-file edit, one of them in the harness.
 */
export type DefectDimension = (typeof DEFECT_DIMENSIONS)[number] | (string & {})

/**
 * One deliberately planted bug in a fixture change, and enough about it to
 * decide mechanically whether a model found it.
 */
export interface SeededDefect {
  /** Stable id, referenced in assertions. */
  id: string
  /**
   * What kind of bug it is. This labels the PLANTED BUG — it is not a `Finding`
   * field, and it is not a lens. Story 2A extends the seeded set by adding rows
   * carrying new dimensions, never by reshaping this type.
   */
  dimension: DefectDimension
  /** Where it was planted, in the post-change file (spine, Locus). */
  locus: Locus
  /** What the bug is, for a human reading a failed assertion. */
  summary: string
  /**
   * Substrings that identify a finding as being about THIS defect. Chosen to be
   * distinctive between the defects in one change: they are what the default
   * matcher discriminates on.
   */
  markers: string[]
}

/**
 * A count, never a ratio. `total` is the size of the defect set every arm is
 * scored against, so `found` is directly comparable across arms.
 */
export interface RecallCount {
  found: number
  total: number
}

/** Injected, exactly as AD-14 injects its similarity function. */
export type DefectMatcher = (defect: SeededDefect, finding: Finding) => boolean

/**
 * How far off a finding's line cite may be and still count as the same defect.
 * A model that reports the right bug two lines above the planted line has found
 * it; requiring exact lines would measure line-cite precision and call the
 * result recall.
 */
export const LINE_TOLERANCE = 8

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase()
}

/**
 * Same file, tolerating a finding that cites a shorter path than the fixture.
 *
 * The suffix tolerance requires the shorter side to carry at least one directory
 * segment: `billing/refund.ts` may match `src/billing/refund.ts`, but a bare
 * `refund.ts` may not, because two files in one change can share a basename and
 * crediting a finding to the wrong file's defect is a recall number that is
 * simply wrong rather than merely generous.
 */
export function sameFile(defect: SeededDefect, finding: Finding): boolean {
  const a = normalizePath(defect.locus.file)
  const b = normalizePath(finding.locus.file)
  if (a === b) return true
  const qualified = (path: string) => path.includes("/")
  if (a.endsWith(`/${b}`) && qualified(b)) return true
  if (b.endsWith(`/${a}`) && qualified(a)) return true
  return false
}

/**
 * Within `LINE_TOLERANCE` of the planted lines.
 *
 * The two no-line cases are deliberately NOT symmetric. A defect planted with no
 * single site (an architectural one) is judged on markers alone — it never had a
 * line to be near. But a *finding* with no line cannot be credited to a defect
 * that does have one: one vague file-level claim would otherwise collect every
 * planted defect in that file whose markers it happened to mention, which is the
 * cheapest possible way to fake recall.
 */
export function nearEnough(defect: SeededDefect, finding: Finding): boolean {
  const defectStart = defect.locus.startLine
  if (defectStart === undefined) return true
  const findingStart = finding.locus.startLine
  if (findingStart === undefined) return false
  const defectEnd = defect.locus.endLine ?? defectStart
  const findingEnd = finding.locus.endLine ?? findingStart
  return findingStart <= defectEnd + LINE_TOLERANCE && findingEnd >= defectStart - LINE_TOLERANCE
}

/**
 * The shipped default: same file, a line cite within tolerance, and at least one
 * of the defect's markers somewhere in the model's own prose. Lexical, because
 * the alternative in CI is a model call — see the fixture's own note on what CI
 * can prove.
 */
export const lexicalDefectMatcher: DefectMatcher = (defect, finding) => {
  if (!sameFile(defect, finding)) return false
  if (!nearEnough(defect, finding)) return false
  const text = `${finding.claim}\n${finding.reasoning}`.toLowerCase()
  return defect.markers.some((marker) => text.includes(marker.toLowerCase()))
}

/**
 * The defect set must be well formed before any number is derived from it. Both
 * of these fail SILENTLY and in the flattering direction if left unchecked: a
 * duplicate id collapses in the `found` set while still counting twice in
 * `total`, so `found` can never reach `total`; an empty `markers` array makes a
 * defect unfindable by anyone, permanently understating every arm at once.
 */
export function validateSeededDefects(defects: readonly SeededDefect[]): void {
  const seen = new Set<string>()
  for (const defect of defects) {
    if (seen.has(defect.id)) throw new Error(`duplicate seeded defect id: ${defect.id}`)
    seen.add(defect.id)
    if (defect.markers.length === 0) {
      throw new Error(`seeded defect ${defect.id} has no markers, so nothing can ever match it`)
    }
  }
}

/**
 * Which defects this finding list covers.
 *
 * A finding claims AT MOST ONE defect. Without that, one finding whose prose
 * happens to carry two defects' markers credits both, and pooled `found`
 * overstates what the models actually located — on a number CAP-1's whole claim
 * rests on, generous is the same as wrong. Defects are offered in declaration
 * order, so the assignment is deterministic and a reordering of `SEEDED_DEFECTS`
 * is the only thing that can move it.
 */
function foundIds(
  defects: readonly SeededDefect[],
  findings: readonly Finding[],
  matcher: DefectMatcher,
): Set<string> {
  validateSeededDefects(defects)
  const found = new Set<string>()
  const claimed = new Set<Finding>()
  for (const defect of defects) {
    const match = findings.find((finding) => !claimed.has(finding) && matcher(defect, finding))
    if (match) {
      claimed.add(match)
      found.add(defect.id)
    }
  }
  return found
}

/** How many of the planted defects this finding list covers. Counts, not floats. */
export function recall(
  defects: readonly SeededDefect[],
  findings: readonly Finding[],
  matcher: DefectMatcher = lexicalDefectMatcher,
): RecallCount {
  return { found: foundIds(defects, findings, matcher).size, total: defects.length }
}

/** The planted defects nobody in this finding list reported. */
export function missedDefects(
  defects: readonly SeededDefect[],
  findings: readonly Finding[],
  matcher: DefectMatcher = lexicalDefectMatcher,
): SeededDefect[] {
  const found = foundIds(defects, findings, matcher)
  return defects.filter((defect) => !found.has(defect.id))
}

/**
 * CAP-11 — partition on `Finding.source`, the field discovery writes and the
 * only honest discriminator for "was this prompted?" (AD-9 amended). Never on
 * `author`'s spelling, and never on `coDiscovery === undefined`.
 */
export function pooledOnly(findings: readonly Finding[]): Finding[] {
  return findings.filter((finding) => finding.source === "pool")
}

/** The other half of the same partition. */
export function lensOnly(findings: readonly Finding[]): Finding[] {
  return findings.filter((finding) => finding.source === "lens")
}

export interface AuthorRecall {
  /** The roster slot that raised the findings — discovery's own `author` field. */
  author: string
  recall: RecallCount
}

/**
 * Per-model recall, partitioned by `author` alone. `author` is written by
 * discovery (AD-8) and is the only thing a finding says about where it came
 * from, which is exactly what makes the single-model arms derivable from one
 * pooled run instead of needing N separate runs.
 *
 * A model that ANSWERED and raised nothing is a real arm with a recall of zero,
 * but it leaves no trace in the finding list, so it cannot be recovered from
 * `findings` alone. Pass `answered` — the roster slots that replied — to have
 * those arms appear; the AD-6a distinction between who was asked and who
 * answered is exactly as load-bearing here as it is on the denominator, since
 * CAP-1's criterion is over every *participating* model, not every vocal one.
 * Sorted by author so a rendered comparison is stable.
 */
export function recallByAuthor(
  defects: readonly SeededDefect[],
  findings: readonly Finding[],
  matcher: DefectMatcher = lexicalDefectMatcher,
  answered: readonly string[] = [],
): AuthorRecall[] {
  const byAuthor = new Map<string, Finding[]>()
  for (const author of answered) if (!byAuthor.has(author)) byAuthor.set(author, [])
  // POOL ARMS ONLY (CAP-11, AD-6a). `answered` is the pool slots that replied,
  // and a lens slot never enters it; letting lens findings in would add arms the
  // denominator does not know about, and compare a prompted persona's recall
  // against an unprompted model's as though they measured the same thing.
  for (const finding of pooledOnly(findings)) {
    const group = byAuthor.get(finding.author)
    if (group) group.push(finding)
    else byAuthor.set(finding.author, [finding])
  }
  return [...byAuthor.entries()]
    .map(([author, own]) => ({ author, recall: recall(defects, own, matcher) }))
    .sort((a, b) => a.author.localeCompare(b.author))
}

export interface RecallComparison {
  /**
   * The union across every model that answered — `RunRecord.pool`, which is the
   * pre-cluster set and stays the pre-cluster set now that AD-14 has run.
   */
  pooled: RecallCount
  /**
   * Every single-model arm, derived from `author` — and, when `answered` is
   * supplied, including arms that answered and raised nothing.
   */
  members: AuthorRecall[]
  /** The best single arm, or undefined when nobody raised anything. */
  best: AuthorRecall | undefined
  /**
   * CAP-1's criterion: STRICTLY greater. Equal recall means the pool bought
   * nothing, and the claim MAD exists to make would be unsupported.
   */
  beats: boolean
}

/**
 * CAP-1's success criterion, mechanically. `total` is shared by construction —
 * every arm is scored against the same defect set — so this compares `found` and
 * divides nothing.
 */
export function pooledRecallBeatsBestMember(
  defects: readonly SeededDefect[],
  findings: readonly Finding[],
  matcher: DefectMatcher = lexicalDefectMatcher,
  answered: readonly string[] = [],
): RecallComparison {
  // Both sides are POOL findings (CAP-11). CAP-1's claim is that pooling
  // heterogeneous UNPROMPTED models beats any one of them; counting lens
  // findings on the pooled side while every arm is pool-only would let a lens
  // win CAP-1 on the pool's behalf. CAP-11's gain is `lensRecallGain`'s to
  // report, as its own number (AD-9's two-numbers rule).
  const pool = pooledOnly(findings)
  const pooled = recall(defects, pool, matcher)
  const members = recallByAuthor(defects, pool, matcher, answered)
  let best: AuthorRecall | undefined
  for (const member of members) {
    if (!best || member.recall.found > best.recall.found) best = member
  }
  return { pooled, members, best, beats: best !== undefined && pooled.found > best.recall.found }
}

export interface LensGain {
  /** What the unlensed pool alone found. The CAP-1 arm, unchanged by lenses. */
  pool: RecallCount
  /** What the lens findings alone found. Prompted signal, reported separately. */
  lens: RecallCount
  /** Both together — the run as it actually happened. */
  combined: RecallCount
  /**
   * CAP-11's criterion, as defects rather than a count: what the lens arm found
   * that NO unlensed pool member raised. Non-empty is the claim.
   */
  lensOnlyDefects: SeededDefect[]
  /** Whether CAP-11's criterion holds over this run. */
  beats: boolean
}

/**
 * CAP-11's success criterion, mechanically: "over a fixture change with seeded
 * defects spanning several dimensions, a lensed pass surfaces at least one
 * defect no unlensed pool member raised."
 *
 * Partitioned on `Finding.source` — a real field since story 2A, so this needs
 * no convention about slot-id spelling and no lens-to-dimension mapping. Counts,
 * never ratios, exactly like everything else in this module: the four numbers
 * are over one shared defect set, so nothing needs dividing to compare them.
 *
 * The gain is deliberately reported as its own number and never folded into
 * CAP-1's. Story 9's third arm divides the recall gain from its token cost for
 * the same reason (AD-9, and the sprint change proposal's success criterion 5).
 */
export function lensRecallGain(
  defects: readonly SeededDefect[],
  findings: readonly Finding[],
  matcher: DefectMatcher = lexicalDefectMatcher,
): LensGain {
  const pool = pooledOnly(findings)
  const lens = lensOnly(findings)

  const foundByPool = foundIds(defects, pool, matcher)
  const foundByLens = foundIds(defects, lens, matcher)

  const lensOnlyDefects = defects.filter(
    (defect) => foundByLens.has(defect.id) && !foundByPool.has(defect.id),
  )

  return {
    pool: { found: foundByPool.size, total: defects.length },
    lens: { found: foundByLens.size, total: defects.length },
    combined: recall(defects, findings, matcher),
    lensOnlyDefects,
    beats: lensOnlyDefects.length > 0,
  }
}
