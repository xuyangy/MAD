#!/usr/bin/env bun
/**
 * FR2 (story 2.2) — read one evaluation bundle and print it.
 *
 *   bun run eval-read --bundle /scratch/mad-eval-2026-09-10
 *
 * IT PRINTS, IT DOES NOT GATE — `main` always returns 0, exactly as
 * `scripts/ablation.ts` and `scripts/clustering-rates.ts` do and for the recorded
 * reason: the tests are what fail CI, and a reporter that also exited non-zero
 * would give one regression two different voices.
 *
 * A SEGREGATED ARM IS NOT AN ERROR HERE. It is the finding. `readBundle` keeps
 * it, `renderBundle` prints it above the table with its reason, and this script
 * hands both to the operator without deciding anything on their behalf.
 *
 * FR8 (story 2-5d) — A BUNDLE CARRYING A SEALED PAIRED SCHEDULE GETS A SECOND
 * REPORT. `renderBundle` establishes that the arms are comparable; the paired
 * reader pairs them by `Finding.id` within each block and prints the contrast
 * with its confounds. Both print, in that order, and an ordinary bundle is
 * unchanged — it has no schedule, so there is nothing to pair.
 *
 * ONE READ, TWO REPORTS. The bundle and the schedule are read HERE and handed to
 * the paired reader, which reads neither again. Reading them twice would put a
 * window between the two reads in which the directory could change, and the two
 * reports printed under one heading would then describe two different states of
 * it — a difference an operator would read as a finding.
 *
 * Story 2-6 — A PAIRED BUNDLE GETS A THIRD REPORT, the labelled reader's: CAP-1
 * recall and CAP-11 lens gain from each block's prefix record, and each arm's
 * upheld findings against the planted labels, or the refusal that says why this
 * bundle is not the sealed labelled change. It consumes the paired result and
 * reads no bundle file the paired reader already read. An ordinary bundle is
 * unchanged.
 *
 * Story 2-6b — AND A FOURTH, the adjudication reader's, after the labelled one:
 * the four verdict directions and the per-arm false positives, read from
 * `<bundle>/adjudication.json`, the human truth sheet. It prints fourth because
 * it is the only report resting on a human-authored input, so an operator has
 * seen what the machine read before seeing what a person labelled. A bundle with
 * no sheet still gets the report, with every truth-dependent quantity
 * unavailable and the verdict-only counts read.
 */

import { readAdjudicationBundle, renderAdjudicationBundle } from "../ablation/adjudication-read.ts"
import { readLabelledBundle, renderLabelledBundle } from "../ablation/labelled-read.ts"
import { readPairedBundle, renderPairedBundle } from "../ablation/paired-read.ts"
import { readBundle, renderBundle } from "../ablation/read-bundle.ts"
import { readSchedule } from "../ablation/schedule.ts"

function flagIndex(argv: readonly string[], name: string): number {
  return argv.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`))
}

export function flag(argv: readonly string[], name: string): string | undefined {
  const index = flagIndex(argv, name)
  if (index < 0) return undefined
  const arg = argv[index]!
  const eq = arg.indexOf("=")
  if (eq >= 0) return arg.slice(eq + 1)
  return argv[index + 1]
}

export async function main(argv: readonly string[] = Bun.argv): Promise<number> {
  const root = flag(argv, "bundle")
  if (root === undefined || root.trim() === "" || root.startsWith("--")) {
    console.log(
      "MAD evaluation reader — `--bundle <directory>` is required.\n" +
        "\n" +
        "  bun run eval-read --bundle /scratch/mad-eval-2026-09-10\n" +
        "\n" +
        "The directory is the one `bun run ablation --live --out <dir>` wrote: it holds\n" +
        "`bundle.json` and one directory per arm and repeat.",
    )
    return 0
  }

  const result = await readBundle(root.trim())
  if ("error" in result) {
    console.log(`MAD evaluation reader — ${result.error}`)
    return 0
  }

  console.log(renderBundle(result))

  if (result.sealedSchedule) {
    const paired = await readPairedBundle(root.trim(), {
      bundle: result,
      schedule: await readSchedule(root.trim()),
    })
    // `readBundle` above already succeeded and is handed straight through, so
    // `error` is unreachable on this path. It is printed rather than asserted
    // away because this script's whole contract is that it prints and returns 0.
    if ("error" in paired) {
      console.log(`MAD paired reader — ${paired.error}`)
    } else {
      console.log(renderPairedBundle(paired))
      // The labelled reader promises not to throw. If it ever does, the reports
      // above already printed, and this script still prints and returns 0.
      try {
        const labelled = await readLabelledBundle(paired)
        if (labelled.kind !== "not-applicable") console.log(renderLabelledBundle(labelled))
      } catch (error) {
        console.log(`MAD labelled reader — ${error instanceof Error ? error.message : String(error)}`)
      }
      // The adjudication reader makes the same promise, in its own `try` so that
      // a labelled reader that broke it does not take this report with it.
      try {
        const adjudication = await readAdjudicationBundle(paired)
        if (adjudication.kind !== "not-applicable") console.log(renderAdjudicationBundle(adjudication))
      } catch (error) {
        console.log(`MAD adjudication reader — ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return 0
}

// Only run (and only exit) when invoked as the CLI, so the reader can be tested.
if (import.meta.main) process.exit(await main())
