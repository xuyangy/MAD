#!/usr/bin/env bun
/**
 * CAP-2's reporter — AD-14 requires the harness to REPORT the two rates in CI,
 * not only to assert them.
 *
 * `deferred-work.md` already records the equivalent gap on the recall side: no
 * CI step surfaces the numbers, so a regression produces a bare `expect` failure
 * with no comparison table and nothing to reason from. This is that table for
 * clustering:
 *
 *   bun run clustering-rates
 *
 * The spine's "never `console.log` from inside a stage" rule governs STAGES. A
 * reporter script is exactly where output belongs.
 *
 * It prints, it does not gate: `core/clustering/fixtures/rates.test.ts` is what
 * fails CI. A reporter that also exited non-zero would give one regression two
 * different voices.
 */

import { EXPECTED_WRONG, PAIRS } from "../core/clustering/fixtures/pairs.ts"
import { measurePairs } from "../core/clustering/fixtures/rates.ts"

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length)
}

export async function main(): Promise<number> {
  const report = await measurePairs()
  const expectedWrong = new Set<string>(EXPECTED_WRONG)

  console.log("CAP-2 — clustering over the hand-labelled pair set")
  console.log("=".repeat(78))
  console.log(
    `${pad("pair", 32)}${pad("labelled", 12)}${pad("engine", 12)}${pad("agrees", 8)}expected`,
  )
  console.log("-".repeat(78))

  for (const outcome of report.outcomes) {
    console.log(
      pad(outcome.id, 32) +
        pad(outcome.label, 12) +
        pad(outcome.merged ? "merged" : "separate", 12) +
        pad(outcome.correct ? "yes" : "NO", 8) +
        (expectedWrong.has(outcome.id) ? "known-wrong" : ""),
    )
  }

  console.log("-".repeat(78))
  // TWO COUNTS, NEVER FUSED (AD-14). They fail in opposite directions and cost
  // opposite things, so a single accuracy number would let a matcher trade a
  // defect the reader never sees for a duplicate the reader can ignore.
  console.log(
    `over-merge   = { merged: ${report.overMerge.merged}, of: ${report.overMerge.of} }  ` +
      `— distinct pairs the engine merged anyway; each one ERASES a real defect`,
  )
  console.log(
    `under-merge  = { unmerged: ${report.underMerge.unmerged}, of: ${report.underMerge.of} }  ` +
      `— equivalent pairs it left apart; each one INFLATES one bug into several`,
  )
  console.log("")

  // A failing row is worth reading, and `why` is what the fixture wrote it for.
  for (const outcome of report.outcomes) {
    if (outcome.correct) continue
    const known = expectedWrong.has(outcome.id) ? " (known, and deliberate)" : ""
    console.log(`${outcome.id}${known}:`)
    console.log(`  ${outcome.why}`)
    console.log("")
  }

  console.log(
    `${PAIRS.length} row(s) measured with the shipped deterministic matcher. ` +
      `A model-backed matcher is scored by this same set (AD-14).`,
  )
  return 0
}

// Only run (and only exit) when invoked as the CLI, so the reporter is testable.
if (import.meta.main) process.exit(await main())
