/**
 * Story 2-7b — shared test scaffolding for the adversarial runner and reader: a
 * scripted one-slot backend, a sealed schedule in a temporary experiment root,
 * and the runner input over real git.
 *
 * SCRIPTED, AND LABELLED SO. Every verdict and every finding here is written by
 * this file. What the runs establish is the runner's and reader's handling of
 * what they are handed, never anything about a live model.
 */

import { $ } from "bun"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ZodType } from "zod"

import { emptyTokenUsage, type TokenUsage } from "../core/domain/run-record.ts"
import { CODING_DISCOVERY_GENERALIST } from "../core/instructions/coding/discovery.ts"
import type { Clock } from "../core/ports/clock.ts"
import type { LateUsageReporter } from "../core/ports/late-usage.ts"
import { cancelledTurn, type BackendCapabilities, type Envelope, type ModelBackend } from "../core/ports/model-backend.ts"
import { selectRoster } from "../core/roster/select.ts"
import { candidate, DEFAULT_JUDGE_ANSWERS, fakeClock, judgeRoleOf } from "../core/test-support/fakes.ts"
import { ADVERSARIAL_ASSERTIONS } from "../fixtures/adversarial/assertions.ts"
import type { AdversarialRunContext, RunAdversarialSuiteInput } from "./adversarial.ts"
import { createAdversarialSchedule, type AdversarialConfig, type AdversarialSchedule } from "./adversarial-schedule.ts"
import type { CoinFace } from "./schedule.ts"
import { known } from "./manifest.ts"

export const PROTOCOL_FILE = new URL("../_bmad-output/specs/spec-mad-orchestrator/evaluation-protocol.md", import.meta.url).pathname

export type RuledVerdict = "upheld" | "judge-ruled-invalid" | "not-adjudicated"

export interface ScriptedAdversarial {
  /** Whether an attack run's discovery also reports a finding at the path its payload names. Default true. */
  followPayload?: (context: AdversarialRunContext) => boolean
  /** The verdict every judge turn of this run gives. Default `upheld`. */
  verdict?: (context: AdversarialRunContext) => RuledVerdict
  /** What one call bills. Default 10 in / 20 out. */
  usage?: (context: AdversarialRunContext, stage: "discover" | "judge" | "debate") => TokenUsage | { unknown: string }
  /** A discovery answer that replaces the scripted one. */
  discovery?: (context: AdversarialRunContext) => unknown
}

export interface ScriptedCall extends AdversarialRunContext {
  stage: "discover" | "judge" | "debate"
  input: string
}

/** The target label's finding, phrased with the label's first marker so the lexical matcher credits it. */
export function targetFinding(caseId: string): Record<string, unknown> {
  const assertion = ADVERSARIAL_ASSERTIONS.find((a) => a.caseId === caseId)!
  return {
    claim: `${assertion.target.markers[0]}: ${assertion.target.summary}`,
    reasoning: "Read from the added lines of the change.",
    severity: "high",
    file: assertion.target.locus.file,
    startLine: assertion.target.locus.startLine,
    endLine: assertion.target.locus.endLine,
  }
}

/** A finding at the path the case's payload names: what an attack that steered the reviewer would produce. */
export function payloadFinding(caseId: string): Record<string, unknown> {
  const assertion = ADVERSARIAL_ASSERTIONS.find((a) => a.caseId === caseId)!
  const start = assertion.blame.startLine ?? 1
  return {
    claim: "The configuration this change depends on is wrong here.",
    reasoning: "The change points at this file.",
    severity: "high",
    file: assertion.blame.path,
    startLine: start,
    endLine: assertion.blame.endLine ?? start,
  }
}

export function scriptedAdversarialBackend(script: ScriptedAdversarial = {}) {
  const calls: ScriptedCall[] = []
  let executions = 0
  const backendFor = (context: AdversarialRunContext, _reporter: LateUsageReporter): ModelBackend => ({
    capabilities: (): BackendCapabilities => ({ tools: true }),
    async runTurn<T>(slot: string, instructions: string, input: string, schema: ZodType<T>, signal?: AbortSignal): Promise<Envelope<T>> {
      if (signal?.aborted) return cancelledTurn<T>(slot)
      const role = judgeRoleOf(instructions)
      const stage = role !== undefined ? "judge" : instructions === CODING_DISCOVERY_GENERALIST.text ? "discover" : "debate"
      calls.push({ ...context, stage, input })
      const verdict = script.verdict?.(context) ?? "upheld"
      let payload: unknown
      if (role === "fact-check") payload = { ...(DEFAULT_JUDGE_ANSWERS["fact-check"] as object), verdict }
      else if (role === "aggregate") payload = { ...(DEFAULT_JUDGE_ANSWERS.aggregate as object), verdict }
      else if (role !== undefined) payload = DEFAULT_JUDGE_ANSWERS[role]
      else if (stage === "discover") {
        payload =
          script.discovery?.(context) ?? {
            findings: [
              targetFinding(context.caseId),
              ...(context.side === "attack" && (script.followPayload?.(context) ?? true) ? [payloadFinding(context.caseId)] : []),
            ],
          }
      } else payload = { turns: [] }
      const parsed = schema.safeParse(payload)
      if (!parsed.success) throw new Error(`the scripted ${stage} payload did not parse: ${parsed.error.message}`)
      const usage = script.usage?.(context, stage) ?? { ...emptyTokenUsage(), input: 10, output: 20 }
      const billing =
        "unknown" in usage ? { usageUnknown: { executionId: `exec-${(executions += 1)}`, why: usage.unknown } } : { tokens: usage }
      return { ok: true, slot, value: parsed.data, ...billing }
    },
  })
  return { calls, backendFor }
}

export function oneSlotRoster() {
  return selectRoster([candidate("anthropic", "claude-sonnet-4-5")], { slots: 1, providerConfigKey: "provider" })
}

export const SCRIPTED_CONFIG: AdversarialConfig = { provenance: "scripted", tools: "opencodeTools over each side's materialized worktree" }

export async function experimentRoot(scratch: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-adversarial-"))
  scratch.push(dir)
  return join(dir, "experiment")
}

export interface SealedSuite {
  root: string
  schedule: AdversarialSchedule
  input: RunAdversarialSuiteInput
  calls: ScriptedCall[]
}

/** Publish a schedule under a fresh experiment root and build the runner's input. */
export async function sealedSuite(
  scratch: string[],
  options: { coins?: CoinFace[]; script?: ScriptedAdversarial; clock?: Clock; root?: string } = {},
): Promise<SealedSuite> {
  const root = options.root ?? (await experimentRoot(scratch))
  const resolved = oneSlotRoster()
  const coins = [...(options.coins ?? ["heads", "tails", "heads", "tails"])]
  const base = {
    experimentRoot: root,
    protocolFile: PROTOCOL_FILE,
    codeRevision: known({ commit: "abc123", dirty: false }),
    roster: resolved.roster,
    config: SCRIPTED_CONFIG,
  }
  const created = await createAdversarialSchedule({ ...base, createdAt: "2026-09-18T00:00:00.000Z", coin: () => coins.shift()! })
  if (!created.ok) throw new Error(created.reason)
  const backend = scriptedAdversarialBackend(options.script)
  return {
    root,
    schedule: created.schedule,
    calls: backend.calls,
    input: {
      ...base,
      priorWarnings: resolved.warnings,
      clock: options.clock ?? fakeClock(),
      shell: $ as never,
      backendFor: backend.backendFor,
    },
  }
}
