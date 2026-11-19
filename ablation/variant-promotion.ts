/**
 * THE DEBATE-VARIANTS READER, part two: precision from the blind adjudication
 * sheet, and the promotion gates of `ablation/DEBATE-VARIANTS.md`, over what
 * `readVariantBundle` (`ablation/variant-read.ts`) bound and measured.
 *
 * It bills nothing, runs no model, writes nothing and never throws. A gate's
 * outcome is a report, never a change to any default.
 *
 * ## PRECISION
 *
 * The sheet is the routing design's version-1 `adjudication.json`, read and
 * bound by the same code (`readSheet`, `bindSheetPage`, `classifyUpheld`): a
 * page per block, bound to the block's verified prefix record, one label per
 * canonical candidate of that prefix pool and no arm named anywhere, so the
 * three arms share one blind page. For each bound continuation: `TP` true
 * defects among its upheld findings, `U` its upheld findings labelled
 * `unresolved`, unlabelled, or outside the prefix pool, `N` everything it
 * upheld, and the interval `[TP/N, (TP+U)/N]`; `N = 0` is not applicable. A
 * page is FILLED when it labels every candidate of the prefix pool
 * (`unresolved` is a label); a partial or empty page still gives an interval,
 * and says it is not filled.
 *
 * ## THE GATES
 *
 * Per variant, each against the baseline of its own block, in every planned
 * block:
 *
 * 1. **coverage**: at least three blocks, the contrast eligible in each.
 * 2. **recall**: never below the baseline, and either above it in at least one
 *    block, or equal in every block with fewer unresolved findings in at least
 *    two blocks and more in none. Unresolved counts are needed only on the
 *    second route.
 * 3. **precision**: a filled page and a measured interval for both arms in every
 *    block, and the variant's lower bound never below the baseline's.
 * 4. **cost**: complete usage for both arms in every block (audited, no unknown
 *    turn), tokens at most 115% of the baseline's, newly issued attempts at most
 *    110% of the baseline's or at most two more.
 * 5. **unknown usage**: never more unknown turns than the baseline.
 *
 * A block whose contrast is withheld fails coverage and gives no input to any
 * other gate, which therefore fails for that block. A measure a gate needs that
 * is missing or not applicable fails that gate, naming the block and measure;
 * a gate never reads a measure it does not need. Every comparison is
 * inclusive. Fractions compare by integer cross-products; token figures,
 * which may be fractional, compare exactly as the decimals they print as, and a
 * non-finite figure is unavailable. A variant is promoted only when all five pass.
 *
 * AD-1: this tree may import from `core/` and `fixtures/`. Nothing under `core/`
 * imports it.
 */

import type { Finding } from "../core/domain/finding.ts"
import { bindSheetPage, classifyUpheld, readSheet, type SheetRead } from "./adjudication-read.ts"
import { loadPrefixRecord } from "./labelled-read.ts"
import type { ContinuationRead, Measure, VariantBlockRead, VariantReadOutcome } from "./variant-read.ts"

export interface PrecisionInterval {
  tp: number
  u: number
  n: number
  /** The page labels every candidate of the block's prefix pool. */
  filled: boolean
}

export interface BlockPrecision {
  block: number
  /** Per arm, keyed by arm name. */
  arms: Record<string, Measure<PrecisionInterval>>
}

export interface PrecisionRead {
  /** The schedule of the read this precision was computed from; the evaluator uses it only with that read. */
  scheduleHash: string
  sheet: SheetRead["kind"]
  /** Why the sheet gave no labels at all, or `null`. */
  sheetProblem: string | null
  blocks: BlockPrecision[]
}

type VariantRead = Extract<VariantReadOutcome, { kind: "read" }>

const missing = (reason: string) => ({ kind: "missing" as const, reason })
const measured = <T>(value: T) => ({ kind: "measured" as const, value })

/** Each bound continuation's precision interval from the bundle's sheet. */
export async function readVariantPrecision(read: VariantRead): Promise<PrecisionRead> {
  const sheet = await readSheet(read.root, read.schedule)
  const sheetProblem = sheet.kind === "read" ? null : sheet.why
  const blocks: BlockPrecision[] = []
  for (const block of read.blocks) blocks.push({ block: block.block, arms: await blockPrecision(read, block, sheet) })
  return { scheduleHash: read.schedule.scheduleHash, sheet: sheet.kind, sheetProblem, blocks }
}

async function blockPrecision(read: VariantRead, block: VariantBlockRead, sheet: SheetRead): Promise<Record<string, Measure<PrecisionInterval>>> {
  const all = (why: string) => Object.fromEntries(block.continuations.map((entry) => [entry.slot.arm, missing(why)]))
  // The truth pool is the forked prefix's canonical findings, through the same
  // identity path the arms were bound against.
  if (block.prefix.evidence.problem !== null) return all(`the block's prefix does not bind its arms: ${block.prefix.evidence.problem}`)
  const loaded = await loadPrefixRecord(read.root, read.schedule, { block: block.block, prefix: block.prefix.evidence })
  if (loaded.kind !== "loaded") return all(`the prefix record is ${loaded.kind}: ${loaded.reasons.join("; ")}`)
  const pool = loaded.record.canonical
  if (pool.kind !== "read") return all(`the prefix record holds no readable canonical pool: ${pool.why}`)
  const page = bindSheetPage(sheet, block.block, loaded.record.runId, loaded.file, pool)
  if (page.kind !== "bound") return all(page.reasons.join("; "))
  const filled = page.rows.size === page.poolIds.size
  return Object.fromEntries(
    block.continuations.map((entry) => [entry.slot.arm, intervalOf(entry, page.rows, page.poolIds, filled)]),
  )
}

function intervalOf(
  entry: ContinuationRead,
  rows: Parameters<typeof classifyUpheld>[1],
  poolIds: ReadonlySet<string>,
  filled: boolean,
): Measure<PrecisionInterval> {
  if (entry.findings === undefined) return missing(`its evidence is not bound (${entry.problems.join("; ")})`)
  const classified = classifyUpheld(entry.findings as Finding[], rows, poolIds)
  const n = classified.upheld
  if (n === 0) return { kind: "not-applicable", reason: "it upheld no finding, so precision has no denominator" }
  const u = classified.truthUnresolved.length + classified.labelMissing.length + classified.outsidePool.length
  return measured({ tp: classified.trueDefects.length, u, n, filled })
}

// ---------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------

export type GateName = "coverage" | "recall" | "precision" | "cost" | "unknown-usage"
export const GATES: readonly GateName[] = ["coverage", "recall", "precision", "cost", "unknown-usage"]

export interface GateResult {
  gate: GateName
  pass: boolean
  /** Why it failed, per block or for the whole gate; empty when it passed. */
  reasons: string[]
}

export interface VariantPromotion {
  variant: "references" | "open-questions"
  gates: GateResult[]
  promote: boolean
}

/** The minimum number of blocks a promotion needs. */
export const PROMOTION_BLOCKS = 3

/** The inputs of one block's contrast, or why the block gives none. */
type Pair = { block: number; baseline: ContinuationRead; variant: ContinuationRead; precision?: BlockPrecision } | { block: number; withheld: string }

/** Promotion of each variant, from the read and the precision. */
export function evaluatePromotion(read: VariantRead, given: PrecisionRead): VariantPromotion[] {
  // Precision from another schedule's read gives this one no labels.
  const precision: PrecisionRead =
    given.scheduleHash === read.schedule.scheduleHash
      ? given
      : { ...given, blocks: [], sheetProblem: `the precision was read for schedule \`${given.scheduleHash}\`, not this bundle's \`${read.schedule.scheduleHash}\`` }
  return (["references", "open-questions"] as const).map((variant) => {
    const pairs: Pair[] = read.blocks.map((block) => {
      const contrast = block.contrasts.find((entry) => entry.variant === variant)
      if (contrast === undefined || !contrast.eligible) return { block: block.block, withheld: contrast?.eligible === false ? contrast.reason : "no contrast" }
      const of = (arm: string) => block.continuations.find((entry) => entry.slot.arm === arm)!
      const blockPrecision = precision.blocks.find((entry) => entry.block === block.block)
      return { block: block.block, baseline: of("baseline"), variant: of(variant), ...(blockPrecision === undefined ? {} : { precision: blockPrecision }) }
    })
    const gates: GateResult[] = [
      coverageGate(pairs),
      recallGate(pairs),
      precisionGate(pairs, variant, precision),
      costGate(pairs),
      unknownGate(pairs),
    ]
    return { variant, gates, promote: gates.every((gate) => gate.pass) }
  })
}

function result(gate: GateName, reasons: string[]): GateResult {
  return { gate, pass: reasons.length === 0, reasons }
}

/** The two arms' measures of one block, or why the gate cannot read them. */
function both<T>(
  pair: Pair,
  name: string,
  pick: (entry: ContinuationRead) => Measure<T> | undefined,
): { baseline: T; variant: T } | string {
  if ("withheld" in pair) return `block ${pair.block} is withheld: ${pair.withheld}`
  const a = pick(pair.baseline)
  const b = pick(pair.variant)
  for (const [arm, value] of [["baseline", a], [pair.variant.slot.arm, b]] as const) {
    if (value === undefined) return `block ${pair.block}: the ${arm} arm has no ${name}`
    if (value.kind !== "measured") return `block ${pair.block}: the ${arm} arm's ${name} is ${value.kind} (${value.reason})`
  }
  return { baseline: (a as { value: T }).value, variant: (b as { value: T }).value }
}

function coverageGate(pairs: readonly Pair[]): GateResult {
  const reasons: string[] = []
  if (pairs.length < PROMOTION_BLOCKS) reasons.push(`only ${pairs.length} block(s), and promotion needs at least ${PROMOTION_BLOCKS}`)
  for (const pair of pairs) if ("withheld" in pair) reasons.push(`block ${pair.block} is withheld: ${pair.withheld}`)
  return result("coverage", reasons)
}

/** `a/b` compared with `c/d` by cross-product, both denominators positive: negative, zero or positive. */
function compareFractions(a: number, b: number, c: number, d: number): number {
  return a * d - c * b
}

function recallGate(pairs: readonly Pair[]): GateResult {
  const reasons: string[] = []
  const comparisons: { block: number; order: number }[] = []
  for (const pair of pairs) {
    const recall = both(pair, "recall", (entry) => entry.measures?.recall)
    if (typeof recall === "string") {
      reasons.push(recall)
      continue
    }
    const order = compareFractions(recall.variant.found, recall.variant.of, recall.baseline.found, recall.baseline.of)
    if (order < 0) reasons.push(`block ${pair.block}: the variant's recall ${recall.variant.found}/${recall.variant.of} is below the baseline's ${recall.baseline.found}/${recall.baseline.of}`)
    comparisons.push({ block: pair.block, order })
  }
  if (reasons.length > 0) return result("recall", reasons)
  if (comparisons.some((entry) => entry.order > 0)) return result("recall", [])
  // Equal in every block: the second route needs the unresolved counts.
  let fewer = 0
  for (const pair of pairs) {
    const unresolved = both(pair, "unresolved count", (entry) => entry.measures?.unresolved)
    if (typeof unresolved === "string") {
      reasons.push(unresolved)
      continue
    }
    if (unresolved.variant > unresolved.baseline) {
      reasons.push(`block ${pair.block}: recall is equal and the variant leaves more findings unresolved (${unresolved.variant} vs ${unresolved.baseline})`)
    }
    if (unresolved.variant < unresolved.baseline) fewer += 1
  }
  if (reasons.length === 0 && fewer < 2) {
    reasons.push(`recall is equal in every block, and the variant leaves fewer findings unresolved in ${fewer} block(s), not at least 2`)
  }
  return result("recall", reasons)
}

function precisionGate(pairs: readonly Pair[], variant: string, precision: PrecisionRead): GateResult {
  // A sheet-wide problem is named once; withheld blocks are still named, each.
  const reasons: string[] = []
  if (precision.sheetProblem !== null) reasons.push(`no readable adjudication sheet: ${precision.sheetProblem}`)
  for (const pair of pairs) {
    if ("withheld" in pair) {
      reasons.push(`block ${pair.block} is withheld: ${pair.withheld}`)
      continue
    }
    if (precision.sheetProblem !== null) continue
    const arms = pair.precision?.arms
    const a = arms?.baseline ?? missing("no precision was read for this block")
    const b = arms?.[variant] ?? missing("no precision was read for this block")
    const unavailable = [
      ["baseline", a],
      [variant, b],
    ].find(([, value]) => (value as Measure<PrecisionInterval>).kind !== "measured") as [string, Exclude<Measure<PrecisionInterval>, { kind: "measured" }>] | undefined
    if (unavailable !== undefined) {
      reasons.push(`block ${pair.block}: the ${unavailable[0]} arm's precision is ${unavailable[1].kind} (${unavailable[1].reason})`)
      continue
    }
    const base = (a as { value: PrecisionInterval }).value
    const own = (b as { value: PrecisionInterval }).value
    if (!base.filled || !own.filled) {
      reasons.push(`block ${pair.block}: the sheet's page does not label every candidate of the prefix pool`)
      continue
    }
    if (compareFractions(own.tp, own.n, base.tp, base.n) < 0) {
      reasons.push(`block ${pair.block}: the variant's precision lower bound ${own.tp}/${own.n} is below the baseline's ${base.tp}/${base.n}`)
    }
  }
  return result("precision", reasons)
}

function costGate(pairs: readonly Pair[]): GateResult {
  const reasons: string[] = []
  for (const pair of pairs) {
    const tokens = both(pair, "observed tokens", (entry) => entry.measures?.tokens)
    const unknown = both(pair, "unknown-usage count", (entry) => entry.measures?.unknownTurns)
    const attempts = both(pair, "newly issued attempts", (entry) => entry.measures?.attempts)
    const problems = [tokens, unknown, attempts].filter((value): value is string => typeof value === "string")
    if (problems.length > 0) {
      reasons.push(...new Set(problems))
      continue
    }
    const t = tokens as { baseline: { executedHere: number; floor: boolean }; variant: { executedHere: number; floor: boolean } }
    const k = unknown as { baseline: number; variant: number }
    const n = attempts as { baseline: number; variant: number }
    if (t.baseline.floor || t.variant.floor || k.baseline > 0 || k.variant > 0) {
      reasons.push(`block ${pair.block}: usage is not complete for both arms (unknown turns ${k.baseline} and ${k.variant}), so the token cost is a floor`)
      continue
    }
    if (!Number.isFinite(t.baseline.executedHere) || !Number.isFinite(t.variant.executedHere)) {
      reasons.push(`block ${pair.block}: a token figure is not finite`)
      continue
    }
    // Tokens may be fractional: compared exactly, as the decimals they are, inclusive.
    if (compareDecimals(t.variant.executedHere, 100, t.baseline.executedHere, 115) > 0) {
      reasons.push(`block ${pair.block}: the variant used ${t.variant.executedHere} tokens, more than 115% of the baseline's ${t.baseline.executedHere}`)
    }
    // Attempts are whole numbers: integer comparisons, inclusive.
    if (n.variant * 100 > n.baseline * 110 && n.variant > n.baseline + 2) {
      reasons.push(
        `block ${pair.block}: the variant issued ${n.variant} attempts, more than 110% of the baseline's ${n.baseline} and more than ${n.baseline + 2}`,
      )
    }
  }
  return result("cost", reasons)
}

/**
 * A finite, non-negative number as the exact decimal it prints as:
 * `mantissa × 10^exponent`. JavaScript prints the shortest decimal that
 * round-trips, so this is the value as recorded.
 */
function decimalOf(value: number): { mantissa: bigint; exponent: number } {
  const [digits, power] = value.toString().toLowerCase().split("e") as [string, string | undefined]
  const [whole, fraction = ""] = digits.split(".") as [string, string | undefined]
  return { mantissa: BigInt(whole + fraction), exponent: Number(power ?? 0) - fraction.length }
}

/** `a × p` compared with `b × q`, exactly: negative, zero or positive. `a` and `b` finite and non-negative; `p` and `q` whole. */
function compareDecimals(a: number, p: number, b: number, q: number): number {
  const x = decimalOf(a)
  const y = decimalOf(b)
  const exponent = Math.min(x.exponent, y.exponent)
  const left = x.mantissa * BigInt(p) * 10n ** BigInt(x.exponent - exponent)
  const right = y.mantissa * BigInt(q) * 10n ** BigInt(y.exponent - exponent)
  return left === right ? 0 : left > right ? 1 : -1
}

function unknownGate(pairs: readonly Pair[]): GateResult {
  const reasons: string[] = []
  for (const pair of pairs) {
    const unknown = both(pair, "unknown-usage count", (entry) => entry.measures?.unknownTurns)
    if (typeof unknown === "string") {
      reasons.push(unknown)
      continue
    }
    if (unknown.variant > unknown.baseline) {
      reasons.push(`block ${pair.block}: the variant has ${unknown.variant} turn(s) of unknown usage, more than the baseline's ${unknown.baseline}`)
    }
  }
  return result("unknown-usage", reasons)
}
