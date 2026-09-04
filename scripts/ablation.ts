#!/usr/bin/env bun
/**
 * CAP-9's reporter.
 *
 *   bun run ablation --pin anthropic/claude-sonnet-4-5
 *   bun run ablation --pin openai/gpt-5 --cap 400000
 *   bun run ablation --pin openai/gpt-5 --live --server http://localhost:4096
 *
 * `--pin` is REQUIRED and has no default. MAD names no model
 * (`host-integration.md`), and a pin literal committed in this tree would be the
 * first model id checked into MAD's own repository — "the ablation's caller
 * names it" stops being true when the caller is a file inside MAD. The caller
 * names it on the command line.
 *
 * IT PRINTS, IT DOES NOT GATE — `main` always returns 0, exactly as
 * `scripts/clustering-rates.ts` does and for the recorded reason: the tests are
 * what fail CI, and a reporter that also exited non-zero would give one
 * regression two different voices. A zero verdict difference is a RESULT here,
 * not an error, so exiting non-zero on it would be actively wrong.
 */

import { renderAblation } from "../ablation/report.ts"
import { scriptedAblation } from "../ablation/seeded-defects.ts"
import type { Pin } from "../core/roster/select.ts"

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  if (index < 0) return undefined
  return argv[index + 1]
}

function has(argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`)
}

/** `provider/model`, split at the FIRST slash — a model id may contain one. */
export function parsePin(value: string): Pin | undefined {
  const cut = value.indexOf("/")
  if (cut <= 0 || cut === value.length - 1) return undefined
  return { providerId: value.slice(0, cut).trim(), modelId: value.slice(cut + 1).trim() }
}

export async function main(argv: readonly string[] = Bun.argv): Promise<number> {
  const raw = flag(argv, "pin")
  const pin = raw === undefined ? undefined : parsePin(raw)
  if (!pin) {
    console.log(
      "CAP-9 ablation — `--pin provider/model` is required.\n" +
        "\n" +
        "  bun run ablation --pin anthropic/claude-sonnet-4-5\n" +
        "\n" +
        "MAD names no model of its own, so the control arm's model is named by you and\n" +
        "not by anything committed in this repository. Under the scripted backend the pin\n" +
        "changes no answer — it is what lets the report say what the control arm WAS.",
    )
    return 0
  }

  if (has(argv, "live")) {
    // The live path deliberately lives in `ablation/live.ts` and is not inlined
    // here: it is the one module in this tree that imports `adapters/`, and CI
    // can never exercise it. Keeping it behind one import keeps the scripted
    // path — the one the tests gate — free of an opencode client.
    const { runLiveAblation } = await import("../ablation/live.ts")
    const report = await runLiveAblation({
      pin,
      serverUrl: flag(argv, "server") ?? "http://localhost:4096",
      directory: flag(argv, "directory") ?? process.cwd(),
      ...(flag(argv, "target") === undefined ? {} : { target: flag(argv, "target")! }),
      ...(flag(argv, "cap") === undefined ? {} : { tokenCap: Number(flag(argv, "cap")) }),
      repeats: Number(flag(argv, "repeats") ?? 1),
    })
    for (const line of renderAblation(report)) console.log(line)
    return 0
  }

  const report = await scriptedAblation({
    pin,
    ...(flag(argv, "cap") === undefined ? {} : { tokenCap: Number(flag(argv, "cap")) }),
    repeats: Number(flag(argv, "repeats") ?? 1),
  })
  for (const line of renderAblation(report)) console.log(line)
  return 0
}

// Only run (and only exit) when invoked as the CLI, so the reporter can be tested.
if (import.meta.main) process.exit(await main())
