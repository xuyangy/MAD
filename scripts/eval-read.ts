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
 */

import { readBundle, renderBundle } from "../ablation/read-bundle.ts"

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
  return 0
}

// Only run (and only exit) when invoked as the CLI, so the reader can be tested.
if (import.meta.main) process.exit(await main())
