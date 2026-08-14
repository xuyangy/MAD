/**
 * Stage 6 — OUTPUT (CAP-6).
 *
 * Writes only `rank` (AD-8) and renders the run record.
 *
 * AD-9 is the rule with teeth here: co-discovery, verdict and evidence are
 * three separate fields and three separate columns. No function in this file
 * computes a scalar from more than one of them. Ranking ORDERS by them; it
 * never FUSES them into a stored or displayed number. Co-discovery always
 * renders as a fraction with its denominator.
 *
 * AD-6 — all four degradation reports are carried here and rendered: the
 * denominator, drop-outs, the roster warning, and the unresolved section. The
 * same rule covers what the finding list IS while the pipeline is short of
 * stages: before clustering runs it is a pool, not a merged set, and a
 * multi-model run says so (`pooledNotYetMerged`).
 */

import { severityRank, type Finding } from "../domain/finding.ts"
import type { RunRecord } from "../domain/run-record.ts"

/**
 * The co-discovery ratio, computed at sort time and never stored (AD-9). A
 * denominator of zero means nobody answered, which is not evidence of anything.
 */
function coDiscoveryRatio(finding: Finding): number {
  const co = finding.coDiscovery
  if (!co || co.answered <= 0) return 0
  return co.raised / co.answered
}

/**
 * AD-9 — ordering only. Each comparison reads ONE field at a time, in
 * documented precedence; nothing is combined into a score.
 */
export function rankFindings(findings: Finding[]): Finding[] {
  const ordered = [...findings].sort((a, b) => {
    // 1. severity, carried unchanged from discovery (AD-10)
    const bySeverity = severityRank(b.severity) - severityRank(a.severity)
    if (bySeverity !== 0) return bySeverity

    // 2. co-discovery, compared as a ratio at sort time and never stored.
    // Raw `raised` counts would rank 2/9 above 1/1, inverting the signal the
    // moment denominators differ — which they do from story 2 onward.
    const byCoDiscovery = coDiscoveryRatio(b) - coDiscoveryRatio(a)
    if (byCoDiscovery !== 0) return byCoDiscovery

    // 3. stable tiebreak on locus, so two runs of the same input print alike
    const byFile = a.locus.file.localeCompare(b.locus.file)
    if (byFile !== 0) return byFile
    return (a.locus.startLine ?? 0) - (b.locus.startLine ?? 0)
  })

  // `rank` is output's own field (AD-8).
  ordered.forEach((finding, index) => {
    finding.rank = index + 1
  })
  return ordered
}

function renderLocus(finding: Finding): string {
  const { file, startLine, endLine } = finding.locus
  if (startLine === undefined) return file
  if (endLine === undefined || endLine === startLine) return `${file}:${startLine}`
  return `${file}:${startLine}-${endLine}`
}

/** AD-9 — always a fraction with its denominator, never a pre-divided float. */
function renderCoDiscovery(finding: Finding): string {
  if (!finding.coDiscovery) return "—"
  // A zero denominator would print `1/0`, which looks like a number and is not
  // one. AD-6a: the denominator is the honest part of this fraction.
  if (finding.coDiscovery.answered <= 0) return "— (no model answered)"
  return `${finding.coDiscovery.raised}/${finding.coDiscovery.answered}`
}

function renderVerdict(finding: Finding): string {
  // Story 1 runs no judge, so this is honestly empty rather than defaulted to
  // something that reads like an adjudication.
  if (!finding.verdict || finding.verdict === "not-adjudicated") return "not adjudicated"
  return finding.verdict
}

function renderEvidence(finding: Finding): string {
  return finding.evidence ?? "assertion only"
}

/**
 * AD-6's honesty rule applied to the state a multi-model run is in before
 * clustering exists: the finding list is a UNION across models, not a merged
 * set. Left unsaid, a reader counting entries reads three models describing one
 * defect as three defects, and reads `1/3` on all of them as three weak
 * findings rather than one possibly-strong one.
 *
 * The discriminator is `clusterId` — the field clustering owns (AD-8) — so this
 * notice self-deletes the moment story 3 writes it, with nothing to remember to
 * remove. It says nothing at N=1, where a union of one is a merged set already.
 *
 * STORY 3 MUST WRITE `clusterId` ON EVERY FINDING, INCLUDING SINGLETONS.
 * `clusterId` is a proxy here for "clustering has run", and it only holds if
 * clustering marks findings it did not merge as well. If story 3 assigns ids
 * only to multi-member clusters, a post-clustering run in which nothing merged
 * re-announces this notice over a fully-clustered pool — a false statement, in
 * the one place AD-6 exists to keep honest. (Reviewed and bound, 2026-08-14.)
 *
 * The count is over the findings this notice actually sits above — the resolved
 * ones. Today nothing is unresolved, but AD-6d's section fills from story 8, and
 * a header counting findings printed in a different section is the kind of quiet
 * arithmetic error a reader has no way to catch.
 */
function pooledNotYetMerged(record: RunRecord, resolved: readonly Finding[]): string[] {
  if (record.answered <= 1) return []
  if (resolved.length === 0) return []
  if (record.findings.some((finding) => finding.clusterId !== undefined)) return []

  const lines = [
    `POOL — NOT YET MERGED: these ${resolved.length} finding(s) are the union of what ` +
      `${record.answered} model(s) reported,`,
    `  reviewed independently and in parallel. Equivalent findings have not been clustered yet, so`,
    `  ONE DEFECT MAY APPEAR ONCE PER MODEL.`,
  ]

  // Only claim what the rows below actually show. The `{raised, answered}` pair
  // is stamped outside this stage (`core/run/review.ts`), and `output` is
  // exported and callable on a record whose findings carry none — where every
  // row renders `—` and an unconditional "every fraction reads 1/N" would be
  // simply false. AD-6 is an honesty rule; a header that describes rows it never
  // read is the failure it names, not an exception to it.
  const uniform = resolved.every(
    (finding) => finding.coDiscovery?.raised === 1 && finding.coDiscovery.answered === record.answered,
  )
  if (uniform) {
    lines.push(
      `  Every co-discovery fraction below reads 1/${record.answered}, because no finding has yet`,
      `  been credited with a second model raising it.`,
    )
  }

  lines.push("")
  return lines
}

function indent(text: string, prefix = "    "): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? prefix + line : line))
    .join("\n")
}

/**
 * Renders the run record. The rendered run IS the trace (spine, Observability):
 * a degraded run must never be indistinguishable from a clean one (AD-6).
 */
export function renderRunRecord(record: RunRecord): string {
  const lines: string[] = []

  lines.push(`MAD review — run ${record.runId}`)
  lines.push("=".repeat(60))
  lines.push("")

  // ---- roster, with the degradation facts attached ----
  lines.push("ROSTER")
  for (const slot of record.roster.slots) {
    const lineage = slot.lineage.verified ? slot.lineage.label : "lineage unverified"
    const also =
      slot.alsoAvailableVia.length > 0
        ? ` [also reachable via ${slot.alsoAvailableVia.join(", ")}; deduped, one slot only]`
        : ""
    lines.push(`  ${slot.slot}: ${slot.providerId}/${slot.modelId} — ${lineage}${also}`)
  }
  lines.push(
    `  slots requested: ${record.roster.requested} | filled: ${record.roster.slots.length} | ` +
      `answered: ${record.answered} | distinct verified lineages: ${record.roster.distinctLineages}`,
  )
  lines.push("")

  // ---- AD-6: warnings, rendered once, here, by output ----
  const degradations = record.warnings.filter((w) => w.code !== "provider-fan-out")
  const disclosures = record.warnings.filter((w) => w.code === "provider-fan-out")

  if (degradations.length > 0) {
    lines.push("WARNINGS — this run is degraded")
    for (const warning of degradations) {
      lines.push(`  ! [${warning.code}] ${warning.message}`)
    }
    lines.push("")
  } else {
    lines.push("WARNINGS: none — this run is clean.")
    lines.push("")
  }

  for (const disclosure of disclosures) {
    lines.push(`DISCLOSURE: ${disclosure.message}`)
    lines.push("")
  }

  // ---- findings ----
  const resolved = record.findings.filter((f) => !f.unresolved)
  const unresolved = record.findings.filter((f) => f.unresolved)

  // ---- AD-6 — what the finding list below actually is, before clustering ----
  lines.push(...pooledNotYetMerged(record, resolved))

  lines.push(`FINDINGS (${resolved.length})`)
  if (resolved.length === 0) {
    // AD-6 — "no findings" and "nobody answered" are opposite facts and must
    // never render the same. An empty list after a roster that all dropped out
    // is not a clean review; saying so is the whole point of the invariant.
    if (record.answered === 0) {
      lines.push("  NO MODEL ANSWERED — this is not a clean review.")
      lines.push("  Every slot in the roster failed or dropped out; nothing was examined.")
      lines.push("  See the warnings above for which models failed and why.")
    } else {
      lines.push(`  No findings were raised by the ${record.answered} model(s) that answered.`)
    }
  }
  for (const finding of resolved) {
    lines.push("")
    lines.push(`  #${finding.rank ?? "?"}  [${finding.severity}]  ${renderLocus(finding)}`)
    // AD-9 — three separate columns; nothing is fused.
    lines.push(
      `      co-discovery: ${renderCoDiscovery(finding)}   ` +
        `verdict: ${renderVerdict(finding)}   ` +
        `evidence: ${renderEvidence(finding)}`,
    )
    lines.push(`      raised by: ${finding.author}`)
    lines.push("")
    lines.push(indent(finding.claim, "      "))
    if (finding.reasoning.trim().length > 0) {
      lines.push("")
      lines.push(indent(finding.reasoning, "      "))
    }
  }
  lines.push("")

  // ---- AD-6d — the unresolved section, never dropped ----
  lines.push(`UNRESOLVED — YOU DECIDE (${unresolved.length})`)
  if (unresolved.length === 0) {
    lines.push("  Nothing was left undecided.")
  }
  for (const finding of unresolved) {
    lines.push(
      `  [${finding.severity}] ${renderLocus(finding)} — died at stage ` +
        `${finding.unresolved?.diedAtStage} (${finding.unresolved?.reason})`,
    )
    lines.push(`      evidence so far: ${renderEvidence(finding)}`)
    lines.push(indent(finding.claim, "      "))
  }
  lines.push("")

  // ---- AD-15 — tokens, never currency ----
  const t = record.ledger.total
  lines.push(
    `TOKENS — turns: ${record.ledger.entries.length} | in: ${t.input} | out: ${t.output} | ` +
      `reasoning: ${t.reasoning} | cache r/w: ${t.cacheRead}/${t.cacheWrite}`,
  )

  return lines.join("\n")
}

/** The output stage: rank in place, then render. */
export function output(record: RunRecord): string {
  record.findings = rankFindings(record.findings)
  return renderRunRecord(record)
}
