#!/usr/bin/env bun
/**
 * Sizes the plugin's default token budget per preset (CAP-6, decision D6):
 *
 *   bun run plugin-budget-default
 *
 * Offline and deterministic: it reads the run manifests already recorded under
 * `ablation/evidence/paired-oauth-evaluation-run-5-bundle/` and applies a stated
 * turn shape per preset. It bills nothing and runs no model. It prints, it does
 * not gate: `scripts/plugin-budget-default.test.ts` fails when the derivation and
 * `adapters/opencode/plugin-budget.ts` disagree.
 *
 * The recorded runs are six arms of one fixture change, three pool slots plus
 * two lens slots, with no preset named, counted the way the ledger counts
 * (input + output + reasoning + cache read + cache write). They calibrate three
 * per-unit figures and nothing else. The turn shape per preset is an
 * assumption, written out below so a reader can disagree with a number rather
 * than with a conclusion. None of it predicts a real bill, latency or
 * usefulness.
 */

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { CUMULATIVE_SHARE, PRESET_DIALS, PRESETS, type Preset } from "../core/budget/ledger.ts"

export const EVIDENCE_BUNDLE = join(import.meta.dir, "..", "ablation", "evidence", "paired-oauth-evaluation-run-5-bundle")

/** One recorded arm: what each stage spent and how many turns and findings it billed for. */
export interface RecordedRun {
  arm: string
  discover: number
  debate: number
  judge: number
  discoveryTurns: number
  debateTurns: number
  /** Canonical findings routed straight to the judge. */
  judgedDirectly: number
  /** Canonical findings routed to debate before the judge. */
  judgedAfterDebate: number
  /**
   * Findings the judge left unresolved. Such an arm's judge spend covers only
   * part of the work its routing counts describe, so it is kept as a recorded
   * (partial) run and left out of the judge calibration.
   */
  judgeUnresolved: number
}

export function readRecordedRuns(bundle = EVIDENCE_BUNDLE): RecordedRun[] {
  const runs: RecordedRun[] = []
  for (const arm of ["off", "on"]) {
    for (const block of readdirSync(join(bundle, arm)).sort()) {
      for (const run of readdirSync(join(bundle, arm, block)).sort()) {
        const manifest = JSON.parse(readFileSync(join(bundle, arm, block, run, "manifest.json"), "utf8"))
        const perStage = Object.fromEntries(
          (manifest.spend.perStage as { stage: string; spent: number }[]).map((s) => [s.stage, s.spent]),
        )
        const route = manifest.status.routeCounts.counts
        const slots = manifest.roster.slots.length + manifest.roster.lensSlots.length
        runs.push({
          arm: `${arm}/${block}`,
          discover: perStage.discover ?? 0,
          debate: perStage.debate ?? 0,
          judge: perStage.judge ?? 0,
          discoveryTurns: slots,
          debateTurns: manifest.status.debateCounts.counts.attempts,
          judgedDirectly: route.toJudge,
          judgedAfterDebate: route.toDebate,
          judgeUnresolved: manifest.status.judgeCounts.counts.unresolved,
        })
      }
    }
  }
  return runs
}

/**
 * The per-unit figures. MODEL ASSUMPTIONS calibrated on the recorded arms, not
 * per-turn measurements: the manifests record spend per stage, so each figure is
 * the largest PER-ARM AVERAGE, never the largest single turn.
 *
 * `judgeAfterDebate` is further inferred: an arm's judge spend, less its direct
 * findings at the `judgeDirect` figure, divided by its debated findings. That
 * allocation is an assumption too; if an arm's direct findings cost less than
 * `judgeDirect`, the residual understates the debated cost.
 */
export interface UnitCosts {
  discoveryTurn: number
  debateTurn: number
  judgeDirect: number
  judgeAfterDebate: number
}

export function unitCosts(runs: RecordedRun[]): UnitCosts {
  const max = (values: number[]) => Math.ceil(Math.max(...values))
  // The off arms debate nothing, so their judge spend is direct judging alone.
  const direct = max(runs.filter((r) => r.judgedAfterDebate === 0).map((r) => r.judge / r.judgedDirectly))
  return {
    discoveryTurn: max(runs.map((r) => r.discover / r.discoveryTurns)),
    debateTurn: max(runs.filter((r) => r.debateTurns > 0).map((r) => r.debate / r.debateTurns)),
    judgeDirect: direct,
    // Only arms whose judging finished: a partial arm's spend is not the cost
    // of the findings its routing counts name.
    judgeAfterDebate: max(
      runs
        .filter((r) => r.judgedAfterDebate > 0 && r.judgeUnresolved === 0)
        .map((r) => (r.judge - r.judgedDirectly * direct) / r.judgedAfterDebate),
    ),
  }
}

/**
 * The reference workload and the turn shape per preset. ASSUMPTIONS, not
 * measurements and not bounds: ten canonical findings over three pool slots;
 * every seat that may sit in a debate speaks in each of three rounds, retries
 * excluded; and a debated fraction that follows the preset's co-discovery
 * threshold (lower threshold, fewer findings contested). The seats are the pool
 * slots plus the preset's lens slots, since a critical lens finding is debated
 * and its author sits in the room. The recorded `normal`-threshold arms debated
 * 44% to 79% of their findings.
 */
export const REFERENCE = { findings: 10, poolSlots: 3, debateRounds: 3 } as const
export const DEBATED_FRACTION: Readonly<Record<Preset, number>> = { quick: 0.5, normal: 0.8, paranoid: 1 }

/** Headroom over the expected total, and the step the result is rounded up to. */
export const HEADROOM = 1.25
export const ROUND_TO = 50_000

export interface PresetSizing {
  preset: Preset
  discoveryTurns: number
  debateTurns: number
  /** Stage spend with no retries. */
  expected: { discover: number; debate: number; judge: number; total: number }
  /** Discovery spend if every discovery slot retries once. */
  discoverWithRetries: number
  /** The smallest budget each constraint allows; the default is the largest, rounded up. */
  needs: { headroom: number; retries: number; discoverShare: number; debateShare: number }
  budget: number
}

export function sizePreset(preset: Preset, units: UnitCosts): PresetSizing {
  const discoveryTurns = REFERENCE.poolSlots + PRESET_DIALS[preset].lenses.length
  const discover = discoveryTurns * units.discoveryTurn
  const debateTurns = REFERENCE.debateRounds * discoveryTurns
  const debate = debateTurns * units.debateTurn
  const debated = REFERENCE.findings * DEBATED_FRACTION[preset]
  const judge = Math.ceil(debated * units.judgeAfterDebate + (REFERENCE.findings - debated) * units.judgeDirect)
  const total = discover + debate + judge
  const discoverWithRetries = 2 * discover
  const needs = {
    headroom: Math.ceil(total * HEADROOM),
    // Every slot retrying once still lets the judge reach every finding.
    retries: discoverWithRetries + debate + judge,
    // Discovery's admission ceiling still admits a retry of every slot.
    discoverShare: Math.ceil(discoverWithRetries / CUMULATIVE_SHARE.discover),
    // Debate's cumulative ceiling still admits the whole debate after that.
    debateShare: Math.ceil((discoverWithRetries + debate) / CUMULATIVE_SHARE.debate),
  }
  const budget = Math.ceil(Math.max(...Object.values(needs)) / ROUND_TO) * ROUND_TO
  return { preset, discoveryTurns, debateTurns, expected: { discover, debate, judge, total }, discoverWithRetries, needs, budget }
}

export function derive(runs = readRecordedRuns()): { runs: RecordedRun[]; units: UnitCosts; sizing: PresetSizing[] } {
  const units = unitCosts(runs)
  return { runs, units, sizing: PRESETS.map((preset) => sizePreset(preset, units)) }
}

export function main(): number {
  const { runs, units, sizing } = derive()
  const k = (n: number) => `${Math.round(n / 1000)}k`
  console.log("Recorded runs (paired-oauth-evaluation-run-5-bundle), tokens as the ledger counts them")
  for (const r of runs) {
    console.log(
      `  ${r.arm.padEnd(6)} discover ${k(r.discover).padStart(5)} / ${r.discoveryTurns} turns   ` +
        `debate ${k(r.debate).padStart(5)} / ${r.debateTurns} turns   ` +
        `judge ${k(r.judge).padStart(5)} / ${r.judgedDirectly} direct + ${r.judgedAfterDebate} debated   ` +
        `total ${k(r.discover + r.debate + r.judge)}` +
        (r.judgeUnresolved > 0 ? `   PARTIAL: ${r.judgeUnresolved} unresolved, not used for judge calibration` : ""),
    )
  }
  console.log(
    `Per-unit assumptions (largest per-arm average; debated judge cost inferred, complete arms only): discovery turn ${k(units.discoveryTurn)}, debate turn ${k(units.debateTurn)}, ` +
      `judge ${k(units.judgeDirect)} per direct finding, ${k(units.judgeAfterDebate)} per debated finding`,
  )
  console.log(
    `Reference workload (assumed): ${REFERENCE.findings} findings, ${REFERENCE.poolSlots} pool slots, ` +
      `${REFERENCE.debateRounds} debate rounds of every eligible seat, retries excluded; headroom ${HEADROOM}x; shares ${CUMULATIVE_SHARE.discover}/${CUMULATIVE_SHARE.debate}/${CUMULATIVE_SHARE.judge}`,
  )
  for (const s of sizing) {
    console.log(
      `  ${s.preset.padEnd(9)} ${s.discoveryTurns} discovery turns, ${s.debateTurns} debate turns, debated ${DEBATED_FRACTION[s.preset] * 100}%   ` +
        `expected ${k(s.expected.discover)} + ${k(s.expected.debate)} + ${k(s.expected.judge)} = ${k(s.expected.total)}   ` +
        `needs: headroom ${k(s.needs.headroom)}, retries ${k(s.needs.retries)}, ` +
        `discover share ${k(s.needs.discoverShare)}, debate share ${k(s.needs.debateShare)}   -> ${s.budget}`,
    )
  }
  return 0
}

if (import.meta.main) process.exit(main())
