/**
 * The debate-variants report: `readVariantBundle`'s read, the precision read
 * from the same read, and the promotion evaluated on both, as text.
 *
 * Pure: it derives no measure and applies no threshold. Every figure is the
 * reader's, printed as a value, `missing (reason)` or `not applicable
 * (reason)`; fractions print exactly as `a/b`. Blocks and arms print in
 * scheduled order. Status and binding are separate lines. Rows that cannot
 * apply to an arm are not printed for it.
 *
 * AD-1: this tree may import from `core/` and `fixtures/`. Nothing under `core/`
 * imports it.
 */

import type { BlockPrecision, GateResult, PrecisionInterval, PrecisionRead, VariantPromotion } from "./variant-promotion.ts"
import type { ContinuationMeasures, ContinuationRead, Measure, PrefixRead, VariantReadOutcome } from "./variant-read.ts"

type VariantRead = Extract<VariantReadOutcome, { kind: "read" }>

/** A refused read: one line. */
export function renderVariantRefusal(reason: string): string {
  return `MAD debate-variants reader — ${reason}`
}

export function renderVariantReport(read: VariantRead, precision: PrecisionRead, promotions: readonly VariantPromotion[]): string {
  const schedule = read.schedule
  const lines: string[] = [
    "MAD debate-variants report",
    `  bundle: ${read.root}`,
    `  schedule: ${schedule.scheduleHash}, protocol ${schedule.protocol.id} version ${schedule.protocol.version}, draw ${schedule.draw}`,
    ...schedule.order.map((arms, index) => `  block ${index + 1} order: ${arms.join(", ")}`),
    `  planted-defect recall: ${read.sealProblem === null ? "scored against the committed labelled change" : `missing everywhere (${read.sealProblem})`}`,
    `  newly issued attempts: ${read.journalProblem === null ? "counted from the replayed journal" : `missing everywhere (${read.journalProblem})`}`,
    `  adjudication sheet: ${precision.sheetProblem === null ? `${precision.sheet}; blind labelling is a procedure this file cannot show` : `${precision.sheet} (${precision.sheetProblem})`}`,
  ]
  for (const block of read.blocks) {
    const blockPrecision = precision.blocks.find((entry) => entry.block === block.block)
    lines.push("", `Block ${block.block}`)
    lines.push(...prefixLines(block.prefix))
    for (const entry of block.continuations) lines.push(...continuationLines(entry, blockPrecision))
    lines.push("  contrasts:")
    for (const contrast of block.contrasts) {
      lines.push(`    ${contrast.variant} vs baseline: ${contrast.eligible ? "eligible" : `withheld (${contrast.reason})`}`)
    }
  }
  lines.push("", "Promotion (ablation/DEBATE-VARIANTS.md)")
  for (const promotion of promotions) {
    lines.push(`  ${promotion.variant}: ${promotion.promote ? "PROMOTE" : "NOT PROMOTED"}`)
    for (const gate of promotion.gates) lines.push(...gateLines(gate))
  }
  lines.push(
    "",
    "This report changes no default. A variant becomes a default only by a change a person makes after reading it.",
  )
  return lines.join("\n")
}

function measureText<T>(measure: Measure<T> | undefined, show: (value: T) => string): string {
  if (measure === undefined) return "missing (not read)"
  if (measure.kind === "measured") return show(measure.value)
  return `${measure.kind === "missing" ? "missing" : "not applicable"} (${measure.reason})`
}

const tokensText = (value: { executedHere: number; floor: boolean }) =>
  `${value.executedHere}${value.floor ? " (a floor: usage is not completely known)" : ""}`
const count = (value: number) => String(value)

function prefixLines(prefix: PrefixRead): string[] {
  return [
    `  shared prefix${prefix.runId === undefined ? "" : ` ${prefix.runId}`}: ${prefix.evidence.problem === null ? "forked" : `does not bind its arms (${prefix.evidence.problem})`}`,
    `    attempts ${measureText(prefix.attempts, count)}; executed-here tokens ${measureText(prefix.tokens, tokensText)}; unknown-usage turns ${measureText(prefix.unknownTurns, count)}`,
  ]
}

function continuationLines(entry: ContinuationRead, precision: BlockPrecision | undefined): string[] {
  const { slot } = entry
  const status =
    entry.status.kind === "read"
      ? `${entry.status.status}${entry.status.runId === undefined ? "" : ` (run ${entry.status.runId})`} — ${entry.status.reason}`
      : `missing (${entry.status.reason})`
  const lines = [
    `  ${slot.arm} (${slot.position})${entry.runId === undefined ? "" : ` run ${entry.runId}`}`,
    `    status: ${status}`,
    `    binding: ${entry.problems.length === 0 ? "bound" : `NOT bound — ${entry.problems.join("; ")}`}`,
    `    completed: ${entry.completed ? "yes" : "no"}`,
  ]
  const m = entry.measures
  if (m === undefined) return lines
  lines.push(
    `    recall ${measureText(m.recall, (value) => `${value.found}/${value.of}${value.defectIds.length === 0 ? "" : ` (${value.defectIds.join(", ")})`}`)}`,
    `    unresolved ${measureText(m.unresolved, count)}; verdicts ${measureText(m.verdicts, (value) => Object.entries(value).map(([state, n]) => `${state} ${n}`).join(", "))}`,
    `    executed-here tokens ${measureText(m.tokens, tokensText)}; unknown-usage turns ${measureText(m.unknownTurns, count)}; newly issued attempts ${measureText(m.attempts, count)}`,
    `    precision ${measureText(precision?.arms[slot.arm], intervalText)}`,
    ...armLines(slot.arm, m),
  )
  return lines
}

function intervalText(value: PrecisionInterval): string {
  return `[${value.tp}/${value.n}, ${value.tp + value.u}/${value.n}] (TP ${value.tp}, U ${value.u}, N ${value.n}; page ${value.filled ? "filled" : "partial"})`
}

function armLines(arm: string, m: ContinuationMeasures): string[] {
  if (arm === "references") {
    return [
      `    position changes ${measureText(m.references, (value) => `${value.changes}, citing a valid entry ${value.withValidCitation}, flagged without one ${value.flagged}, cited share ${measureText(value.citedShare, (share) => share.toString())}`)}`,
    ]
  }
  if (arm === "open-questions") {
    return [
      `    open questions recorded ${measureText(m.openQuestions, count)}; reached a Fact-Checker prompt ${measureText(m.questionsDelivered, count)}`,
    ]
  }
  return []
}

function gateLines(gate: GateResult): string[] {
  return [`    ${gate.gate}: ${gate.pass ? "pass" : "FAIL"}`, ...gate.reasons.map((reason) => `      - ${reason}`)]
}
