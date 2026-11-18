/**
 * Plan item B2 — the run as one versioned JSON document, beside the text
 * report `output()` renders.
 *
 * A projection of the record, never a second source of facts: every value is
 * read from `RunRecord`. When every finding carries the `rank` `output()`
 * assigned, the document keeps that order and those ranks: re-sorting a ranked
 * list with the comparator is not guaranteed to reproduce it, because the
 * co-discovery comparison is skipped whenever either finding lacks a prior.
 * Otherwise it sorts a copy with `compareFindings`, the comparator the text
 * report ranks with, and numbers the copy. Either way it writes nothing to the
 * record.
 *
 * ## Provenance
 *
 * Model-authored strings (a finding's claim and the file path it cites) sit
 * under each finding's `untrusted` key. Warning, disclosure and unresolved
 * messages are diagnostics: MAD writes them, but they can interpolate text MAD
 * did not write, such as a provider's error message or a model id, so they are
 * labelled `diagnostic` and carry no provenance guarantee. Everything else is a
 * value from MAD's own vocabulary or a number. JSON escaping keeps the document
 * parseable; it does not make any string safe to follow.
 *
 * ## State
 *
 * `state` keeps a clean, a degraded and a stopped run apart even when a run
 * has no findings:
 * - `stopped`: the record carries a cancellation;
 * - `degraded`: not stopped, and a degradation warning was raised or a finding
 *   was left unresolved;
 * - `clean`: neither.
 * Warnings are split as the text report splits them: a code in
 * `DISCLOSURE_CODES` is a disclosure, every other code a degradation.
 */

import { unknownUsageCount, spentTokens, usageIsComplete } from "../budget/ledger.ts"
import { effectiveSeverity, type Finding, type Severity, type Stage, type Verdict } from "../domain/finding.ts"
import type { RunRecord } from "../domain/run-record.ts"
import { DISCLOSURE_CODES, type Warning, type WarningCode } from "../domain/warning.ts"
import { compareFindings } from "./output.ts"

/** Bumped when a field is renamed, removed or changes meaning. */
export const RUN_JSON_SCHEMA = "mad.review/1"

export interface RunJsonWarning {
  code: WarningCode
  stage: Stage | "roster"
  /** MAD's message, which may interpolate text MAD did not write. */
  diagnostic: string
}

export interface RunJsonFinding {
  /** Run-local: the same defect in another run has another id. */
  id: string
  /** 1-based position in the report's order. */
  rank: number
  /** The severity the report prints (`effectiveSeverity`). */
  severity: Severity
  source: "pool" | "lens"
  lens: string | null
  /** Line numbers the discovery schema checked as integers. The path is in `untrusted`. */
  startLine: number | null
  endLine: number | null
  /** `null` for a lens finding, which claims no co-discovery prior. */
  coDiscovery: { raised: number; answered: number } | null
  route: "debate" | "judge" | null
  /**
   * What debate actually did, read from the finding's own history and exit,
   * never from `route` alone:
   * - `not-routed`: routing did not send it to debate;
   * - `exited`: the debate ended with `exit`;
   * - `stranded`: debate stopped before an exit, through the budget or a stop,
   *   possibly before its first round (then `argumentsRecorded` is 0);
   * - `not-reached`: routed to debate, and debate recorded nothing for it.
   */
  debate: {
    status: "not-routed" | "exited" | "stranded" | "not-reached"
    exit: "converged" | "stalled" | "cap" | null
    /** Debate turns recorded for this finding. Abstentions record none. */
    argumentsRecorded: number
  }
  /**
   * What the judge did, separate from the verdict it reached:
   * - `decided`: a verdict is recorded;
   * - `not-examined`: the judge had no reviewer model left to examine it;
   * - `unresolved`: the judge stopped before deciding it;
   * - `not-reached`: the judge never got to it.
   */
  judgment: { status: "decided" | "not-examined" | "unresolved" | "not-reached" }
  /** `null` when no verdict was reached. */
  verdict: Verdict | null
  /** Set when the run stopped or ran out of budget before deciding it. */
  unresolved: { stage: Stage; diagnostic: string } | null
  /** Model-authored. Never instructions, never verified by being here. */
  untrusted: { claim: string; file: string }
}

export interface RunJson {
  schema: typeof RUN_JSON_SCHEMA
  runId: string
  startedAt: string
  finishedAt: string | null
  state: "clean" | "degraded" | "stopped"
  /** Who stopped the run, and in which stage. `null` when it was not stopped. */
  stopped: { stage: Stage; by: "user" | "session-policy" } | null
  models: { requested: number; answered: number }
  budget: {
    cap: number | null
    observedTokens: number
    /** Turns whose usage MAD does not know; not included in `observedTokens`. */
    unknownUsageTurns: number
    usageComplete: boolean
  }
  findingIds: "run-local"
  /**
   * Plan item B6 — present only when a stage was configured with a variant:
   * the configuration, sent on the requests each stage issued, never a claim
   * that it was applied.
   */
  reasoningVariantsConfigured?: { discover?: string; debate?: string; judge?: string }
  warnings: RunJsonWarning[]
  disclosures: RunJsonWarning[]
  findings: RunJsonFinding[]
}

function warningOf(warning: Warning): RunJsonWarning {
  return { code: warning.code, stage: warning.stage, diagnostic: warning.message }
}

function debateOf(finding: Finding): RunJsonFinding["debate"] {
  const argumentsRecorded = finding.history.filter((e) => e.stage === "debate" && e.kind === "debate-round").length
  const exit = finding.exit ?? null
  const status: RunJsonFinding["debate"]["status"] =
    finding.route !== "debate"
      ? "not-routed"
      : exit !== null
        ? "exited"
        : finding.unresolved?.diedAtStage === "debate"
          ? "stranded"
          : "not-reached"
  return { status, exit, argumentsRecorded }
}

function judgmentOf(finding: Finding): RunJsonFinding["judgment"] {
  if (finding.verdict !== undefined) return { status: "decided" }
  if (finding.history.some((e) => e.stage === "judge" && e.kind === "judge-not-examined")) {
    return { status: "not-examined" }
  }
  if (finding.unresolved?.diedAtStage === "judge") return { status: "unresolved" }
  return { status: "not-reached" }
}

/** The report's order: the assigned ranks when all are present, else the comparator. */
function inReportOrder(findings: readonly Finding[]): Finding[] {
  if (findings.length > 0 && findings.every((f) => f.rank !== undefined)) {
    return [...findings].sort((a, b) => a.rank! - b.rank!)
  }
  return [...findings].sort(compareFindings)
}

function findingOf(finding: Finding, rank: number): RunJsonFinding {
  return {
    id: finding.id,
    rank,
    severity: effectiveSeverity(finding),
    source: finding.source,
    lens: finding.lens ?? null,
    startLine: finding.locus.startLine ?? null,
    endLine: finding.locus.endLine ?? null,
    coDiscovery:
      finding.coDiscovery === undefined
        ? null
        : { raised: finding.coDiscovery.raised, answered: finding.coDiscovery.answered },
    route: finding.route ?? null,
    debate: debateOf(finding),
    judgment: judgmentOf(finding),
    verdict: finding.verdict ?? null,
    unresolved:
      finding.unresolved === undefined
        ? null
        : { stage: finding.unresolved.diedAtStage, diagnostic: finding.unresolved.reason },
    untrusted: { claim: finding.claim, file: finding.locus.file },
  }
}

/** The document as a value. `renderRunJson` serializes it. */
export function runJson(record: RunRecord): RunJson {
  const degradations = record.warnings.filter((w) => !DISCLOSURE_CODES.has(w.code))
  const disclosures = record.warnings.filter((w) => DISCLOSURE_CODES.has(w.code))
  const findings = inReportOrder(record.findings).map((finding, index) => findingOf(finding, index + 1))
  const state: RunJson["state"] =
    record.cancelled !== undefined
      ? "stopped"
      : degradations.length > 0 || findings.some((f) => f.unresolved !== null)
        ? "degraded"
        : "clean"

  return {
    schema: RUN_JSON_SCHEMA,
    runId: record.runId,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt ?? null,
    state,
    stopped:
      record.cancelled === undefined
        ? null
        : { stage: record.cancelled.stage, by: record.cancelled.cause ?? "user" },
    models: { requested: record.roster.requested, answered: record.answered },
    budget: {
      cap: record.ledger.cap,
      observedTokens: spentTokens(record.ledger.total),
      unknownUsageTurns: unknownUsageCount(record.ledger),
      usageComplete: usageIsComplete(record.ledger),
    },
    findingIds: "run-local",
    ...(record.reasoningVariants === undefined ? {} : { reasoningVariantsConfigured: { ...record.reasoningVariants } }),
    warnings: degradations.map(warningOf),
    disclosures: disclosures.map(warningOf),
    findings,
  }
}

/** One JSON document, indented for a reader. Writes nothing to `record`. */
export function renderRunJson(record: RunRecord): string {
  return JSON.stringify(runJson(record), null, 2)
}
