/**
 * The SHIPPED similarity function — deterministic, lexical, and supplied to the
 * engine BY THE CALLER.
 *
 * It lives beside `engine.ts` and the engine does not import it (AD-14):
 * `core/stages/cluster.ts` passes it in. That seam is the whole point. The
 * model-backed matcher `stories.yaml` anticipates drops in here without
 * reopening the engine, and `fixtures/rates.ts` scores whichever matcher it is
 * given with the same pair set.
 *
 * Why the shipped one is deterministic rather than model-backed (recorded in the
 * story's Spec Change Log, and in `deferred-work.md` when this lands):
 * `host-integration.md` has no role for a similarity model, AD-15's budget
 * ledger does not exist yet and pairwise model calls are O(n²) at the widest
 * point of the run, and CAP-2's success criterion is satisfiable over a
 * deterministic matcher because the durable asset is the FIXTURE SET, not the
 * matcher.
 */

import type { Finding } from "../domain/finding.ts"
import type { BlockKey, Similar } from "./engine.ts"

/**
 * How far apart two line cites may be and still be the same defect. Same
 * reasoning as `fixtures/recall.ts`'s LINE_TOLERANCE, restated here rather than
 * imported: `core/` may not reach into the top-level `fixtures/` tree (AD-1),
 * and a model that cites the right bug two lines off found the right bug.
 */
export const LINE_TOLERANCE = 8

/**
 * How much of the smaller claim's vocabulary must appear in the larger one. The
 * overlap COEFFICIENT rather than Jaccard, so a terse claim and a verbose one
 * describing the same defect are not penalised for the verbose side's extra
 * words — which is the commonest shape of one defect described by two models.
 */
export const OVERLAP_THRESHOLD = 0.34

/**
 * Words that carry no discriminating signal. Deliberately small: an aggressive
 * list starts deciding what a defect IS, and this matcher's job is to be dumb,
 * predictable, and scored.
 */
const STOPWORDS = new Set([
  "the", "and", "are", "was", "were", "been", "being", "for", "with", "from",
  "this", "that", "these", "those", "there", "here", "not", "but", "into",
  "has", "have", "had", "does", "did", "can", "could", "will", "would",
  "should", "may", "might", "when", "where", "which", "who", "what", "how",
  "all", "any", "some", "more", "most", "one", "two", "its", "it's", "they",
  "them", "you", "your", "our", "their", "then", "than", "also", "only",
])

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase()
}

/**
 * Same file, tolerating a model that cites a shorter path than another did. The
 * shorter side must carry at least one directory segment, so two files sharing a
 * basename never collapse into one defect — the same rule and the same reason as
 * `fixtures/recall.ts`'s `sameFile`.
 */
export function sameFile(a: Finding, b: Finding): boolean {
  const left = normalizePath(a.locus.file)
  const right = normalizePath(b.locus.file)
  if (left === right) return true
  const qualified = (path: string) => path.includes("/")
  if (left.endsWith(`/${right}`) && qualified(right)) return true
  if (right.endsWith(`/${left}`) && qualified(left)) return true
  return false
}

/**
 * Overlapping or near line ranges.
 *
 * The no-line cases are decided together, not one-sidedly: two findings with no
 * single site are both architectural claims about the file and may well be the
 * same one, but a file-level claim and a claim about one statement are not. Left
 * permissive, one vague claim would absorb every finding in its file — the
 * cheapest possible over-merge, and the one a chain cannot even be blamed for.
 */
export function nearEnough(a: Finding, b: Finding): boolean {
  const aStart = a.locus.startLine
  const bStart = b.locus.startLine
  if (aStart === undefined || bStart === undefined) return aStart === bStart
  const aEnd = a.locus.endLine ?? aStart
  const bEnd = b.locus.endLine ?? bStart
  return aStart <= bEnd + LINE_TOLERANCE && aEnd >= bStart - LINE_TOLERANCE
}

/** Content words of a claim, lowercased. Model prose is never parsed (AD-11). */
export function claimTokens(claim: string): Set<string> {
  const words = claim.toLowerCase().split(/[^a-z0-9]+/)
  return new Set(words.filter((word) => word.length >= 3 && !STOPWORDS.has(word)))
}

/** |A ∩ B| / min(|A|, |B|). Zero when either side has nothing to compare. */
export function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  const smaller = a.size <= b.size ? a : b
  const larger = smaller === a ? b : a
  if (smaller.size === 0) return 0
  let shared = 0
  for (const word of smaller) if (larger.has(word)) shared += 1
  return shared / smaller.size
}

/**
 * The blocking key: the file's BASENAME.
 *
 * It must be no stricter than `sameFile`, or the block would silently veto pairs
 * the matcher would have merged — a full path key would split `src/pay.ts` from
 * `billing/pay.ts`, which `sameFile` deliberately accepts. A basename is stable
 * across path spellings and still keeps a matcher from being billed for two
 * findings that cannot be the same site.
 */
export const findingBlockKey: BlockKey<Finding> = (finding) => {
  const path = normalizePath(finding.locus.file)
  return path.slice(path.lastIndexOf("/") + 1)
}

/**
 * Same file, line ranges within tolerance, and enough shared vocabulary in the
 * two claims. Synchronous by nature, typed as `Similar<Finding>` because that is
 * the seam a model-backed replacement occupies.
 */
export const lexicalSimilarity: Similar<Finding> = (a, b) => {
  if (!sameFile(a, b)) return false
  if (!nearEnough(a, b)) return false
  return overlapCoefficient(claimTokens(a.claim), claimTokens(b.claim)) >= OVERLAP_THRESHOLD
}
