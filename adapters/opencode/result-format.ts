/**
 * Plan item B2 — what `mad_review` returns under `format: "json"`, and the one
 * place every result path is formatted.
 *
 * `execute` describes each way a call ends as an `Answer`: a completed run, or
 * one of the ways no run happened. `formatAnswer` turns it into the tool's
 * result. Under `format: "text"` (the default) that is the text result the
 * answer carries, unchanged. Under `format: "json"` the model-facing span holds
 * one JSON document instead of the text report:
 * - the span is built by `frameForHostAgent`, with the same `review report`
 *   label as the text report (AD-18), so no string inside it can close it;
 * - MAD's host notes stay outside the span, exactly where the text path puts
 *   them, and the facts they state are repeated inside the document under
 *   `host` (a completed run) or `facts` (no run);
 * - title and metadata are the text path's.
 *
 * A reader takes the whole tool output, finds the line that opens the
 * `review report` span, finds the line that closes it (the same backtick run,
 * alone on its line), and parses the lines between them. A transcript a host
 * truncated may have lost the closing line; nothing here can make that
 * parseable.
 */

import type { RunRecord } from "../../core/domain/run-record.ts"
import { frameForHostAgent } from "../../core/run/review.ts"
import { RUN_JSON_SCHEMA, runJson, type RunJson } from "../../core/stages/output-json.ts"
import type { ArtifactOutcome } from "./artifacts.ts"
import type { PolicyProbe } from "./model-backend.ts"
import type { ChangeReadStopped } from "./repo.ts"
import type { BlameCleanupUnresolved } from "./tools.ts"

export type ResultFormat = "text" | "json"

/** The text result every path already builds. */
export interface TextResult {
  title: string
  output: string
  metadata?: Record<string, unknown>
}

/**
 * Why a call produced no review:
 * - `stopped`: the review was stopped (by the host's stop or by MAD) before
 *   any model was asked;
 * - `refused`: MAD declined the input, the configuration or the host;
 * - `failed`: MAD could not do a step it needed, such as reading the roster or
 *   the change;
 * - `nothing-to-review`: the change was empty.
 */
export type NotRunOutcome = "stopped" | "refused" | "failed" | "nothing-to-review"

/** Structured facts a no-run path already holds. Absent when it holds none. */
export interface NotRunFacts {
  /** From a change read that did not return cleanly. */
  changeRead?: {
    stop: string
    readsCompleted: number
    cleanup: "confirmed" | "unresolved" | "not-applicable"
    pid: number | null
    quarantined: boolean
  }
  /** From the session-policy check. */
  policyCheck?: PolicyCheckFacts
}

export interface PolicyCheckFacts {
  /** MAD could not confirm its policy-check session was deleted. */
  cleanupUnresolved: boolean
  /** The session's create had not answered, so a session may exist. */
  sessionMayExist: boolean
}

/** Facts the completed run's host notes state, in structured form. */
export interface RunHostFacts {
  /** A submodule is read as its commit pointer; changes inside it are not reviewed. */
  submodules: "commit-pointers-only"
  /** Where the token budget came from: MAD's default, the caller, or none usable. */
  budgetSource: "default" | "passed" | "none"
  policyCheck: PolicyCheckFacts
  /** The run was stopped after it had issued turns, which may keep running and billing. */
  issuedTurnsMayStillBill: boolean
  /** A `git blame` process the stop tried to end and whose cleanup MAD could not confirm. */
  stoppedBlame: { operation: string; pid: number; killSent: boolean; exited: boolean } | null
  /** The debug dump's outcome. */
  artifacts: ArtifactOutcome["kind"]
  /** MAD stopped the run because a session's permission rules differed; the host's description. */
  policyStop: { diagnostic: string } | null
}

export type Answer =
  | { kind: "not-run"; outcome: NotRunOutcome; text: TextResult; facts: NotRunFacts }
  | {
      kind: "run"
      text: TextResult
      record: RunRecord
      /** MAD's own text before the span (the policy-stop note), as on the text path. */
      before: string
      /** MAD's own notes after the span, as on the text path. */
      after: string
      host: RunHostFacts
    }

export interface NotRunJson {
  schema: typeof RUN_JSON_SCHEMA
  state: "not-run"
  outcome: NotRunOutcome
  /** MAD's title for this result. */
  title: string
  /** MAD's text for this result, which may interpolate git, provider and argument text. */
  diagnostic: string
  facts: NotRunFacts
}

export type RunJsonWithHost = RunJson & { host: RunHostFacts }

export function notRun(outcome: NotRunOutcome, text: TextResult, facts: NotRunFacts = {}): Answer {
  return { kind: "not-run", outcome, text, facts }
}

export function changeReadFacts(error: ChangeReadStopped): NotRunFacts {
  return {
    changeRead: {
      stop: error.stop,
      readsCompleted: error.readsCompleted,
      cleanup: error.cleanup,
      pid: error.pid ?? null,
      quarantined: error.quarantine !== undefined,
    },
  }
}

export function policyCheckFacts(probe: PolicyProbe): PolicyCheckFacts {
  return {
    cleanupUnresolved: probe.cleanupUnresolved !== undefined,
    sessionMayExist: !probe.ok && probe.sessionMayExist === true,
  }
}

export function stoppedBlameFacts(fact: BlameCleanupUnresolved | undefined): RunHostFacts["stoppedBlame"] {
  if (fact?.byStop === undefined) return null
  return { operation: fact.operation, pid: fact.pid, killSent: fact.byStop.killSent, exited: fact.byStop.exited }
}

/** The same test `budgetNote` words its first sentence from. */
export function budgetSourceOf(cap: number | null, budget: number | undefined | null): RunHostFacts["budgetSource"] {
  if (cap === null) return "none"
  return budget === undefined || budget === null ? "default" : "passed"
}

export function notRunJson(answer: Extract<Answer, { kind: "not-run" }>): NotRunJson {
  return {
    schema: RUN_JSON_SCHEMA,
    state: "not-run",
    outcome: answer.outcome,
    title: answer.text.title,
    diagnostic: answer.text.output,
    facts: answer.facts,
  }
}

export function formatAnswer(answer: Answer, format: ResultFormat | undefined): TextResult {
  if (format !== "json") return answer.text
  if (answer.kind === "not-run") {
    return { ...answer.text, output: frameForHostAgent(JSON.stringify(notRunJson(answer), null, 2)) }
  }
  const document: RunJsonWithHost = { ...runJson(answer.record), host: answer.host }
  return {
    ...answer.text,
    output: `${answer.before}${frameForHostAgent(JSON.stringify(document, null, 2))}${answer.after}`,
  }
}
