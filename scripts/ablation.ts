#!/usr/bin/env bun
/**
 * CAP-9's reporter.
 *
 *   bun run ablation --pin anthropic/claude-sonnet-4-5
 *   bun run ablation --pin openai/gpt-5 --cap 400000
 *   bun run ablation --pin openai/gpt-5 --live --server http://localhost:4096
 *   bun run ablation --pin openai/gpt-5 --live --lenses security,reliability,outsider
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

/**
 * A numeric flag, VALIDATED AT THE SEAM — before any `clamp*` sees the value.
 *
 * The core's clamps are correct and they are not a substitute for this, because
 * their answers to the same rubbish DELIBERATELY DIFFER (`core/budget/limiter.ts`
 * writes the divergence out in full). `clampTokenCap(NaN)` is `null`, and `null`
 * means NO CEILING — a coherent answer to "no budget was requested" and the wrong
 * answer to "the budget was mistyped". So `--cap abc` used to complete a run with
 * `cap none` printed and exit 0, on the flag whose whole job is to bound spend;
 * under `--live` that is real credentials (retrospective 2026-09-06, F1).
 *
 * `--repeats 0` had the mirror failure at the other end: `Number("0")` is a
 * perfectly good number, so nothing rejected it, and the empty arm array reached
 * `scriptedAblation` and threw a raw `TypeError` out of the CLI — against this
 * module's own "`main` always returns 0" (F2).
 *
 * Both are ONE defect: an unguarded seam. The three failing shapes are the same
 * for every numeric flag, so they are answered once, here:
 *
 * - **Absent** is not an error. It is the caller declining to set the dial, and
 *   each call site says what that means — no ceiling for `--cap`, one pass for
 *   `--repeats`.
 * - **Present but unreadable** — no value after the flag, a non-number, a
 *   fraction, `Infinity` — is refused by NAME, so the message says which flag
 *   and what it received. Fractions are refused rather than floored: a CLI that
 *   silently rounds the number you typed is a CLI you cannot trust the report of.
 * - **Out of range** is refused against a floor the caller states, because the
 *   floor differs: a cap of 0 is a real, explicit ceiling of zero, and 0 repeats
 *   is not a run.
 *
 * It REFUSES, it does not gate: like the missing-`--pin` path above, an invalid
 * invocation prints and `main` still returns 0. The tests are what fail CI.
 */
type NumericFlag = { ok: true; value: number | undefined } | { ok: false; message: string }

export function numericFlag(argv: readonly string[], name: string, min: number): NumericFlag {
  if (!has(argv, name)) return { ok: true, value: undefined }
  const raw = flag(argv, name)
  if (raw === undefined || raw.trim() === "" || raw.startsWith("--")) {
    return { ok: false, message: `--${name} needs a value. Nothing readable followed it.` }
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return { ok: false, message: `--${name} must be a whole number. It received \`${raw}\`.` }
  }
  if (value < min) {
    return { ok: false, message: `--${name} must be ${min} or more. It received \`${raw}\`.` }
  }
  return { ok: true, value }
}

/**
 * Print why the invocation was refused, and return the module's one exit code.
 *
 * Refusing is not gating: this is the same shape the missing-`--pin` path uses,
 * for the same reason recorded in the file header. What it buys is that the
 * refusal happens before `scriptedAblation` or `runLiveAblation` is called at
 * all, so "nothing was billed" is a structural fact rather than a promise.
 */
function refuse(message: string): number {
  console.log(
    `CAP-9 ablation — ${message}\n` +
      "\n" +
      "  bun run ablation --pin openai/gpt-5 --cap 400000 --repeats 3\n" +
      "\n" +
      "--cap bounds the tokens a run may spend and is shared by all three arms;\n" +
      "omit it for no ceiling. --repeats runs each arm N times to establish a noise\n" +
      "floor; omit it for one pass. Nothing was run and nothing was billed.",
  )
  return 0
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

  // Both dials are read and checked BEFORE either path runs, so a mistyped flag
  // costs nothing — not a scripted run, and under `--live` not a billed turn.
  const cap = numericFlag(argv, "cap", 0)
  if (!cap.ok) return refuse(cap.message)
  const repeats = numericFlag(argv, "repeats", 1)
  if (!repeats.ok) return refuse(repeats.message)
  const tokenCap = cap.value
  const repeatCount = repeats.value ?? 1

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
      ...(tokenCap === undefined ? {} : { tokenCap }),
      // The lens arm is the third arm, and without this flag the live path could
      // only ever run two — while `LIVE-RUN.md` documented three and story 9's
      // whole third-arm thesis (do lenses earn their tokens?) had no live path at
      // all (code review 2026-09-06).
      ...(flag(argv, "lenses") === undefined
        ? {}
        : { lenses: flag(argv, "lenses")!.split(",").map((lens) => lens.trim()).filter(Boolean) }),
      repeats: repeatCount,
    })
    for (const line of renderAblation(report)) console.log(line)
    return 0
  }

  const report = await scriptedAblation({
    pin,
    ...(tokenCap === undefined ? {} : { tokenCap }),
    repeats: repeatCount,
  })
  for (const line of renderAblation(report)) console.log(line)
  return 0
}

// Only run (and only exit) when invoked as the CLI, so the reporter can be tested.
if (import.meta.main) process.exit(await main())
