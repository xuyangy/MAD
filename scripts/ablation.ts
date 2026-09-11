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

import { resolve } from "node:path"

import { realRefusalFor, refusalFor } from "../adapters/opencode/artifacts.ts"
import { renderAblation } from "../ablation/report.ts"
import { scriptedAblation } from "../ablation/seeded-defects.ts"
// `material.ts` and `seal.ts` DIRECTLY, never `seeded-defects/change.ts`. Both
// are plain data and neither touches the SDK, so the scripted path still
// constructs no opencode client. The door module would reach `labels.ts`, and
// while this file is not the materializer, naming the narrow import is what keeps
// the habit — story 2.4's whole structural claim is that the import list says
// which side of the split a module is on.
import { SEEDED_CHANGE } from "../fixtures/seeded-defects/material.ts"
import { LABELLED_CHANGE_SEAL } from "../fixtures/seeded-defects/seal.ts"
import type { Pin } from "../core/roster/select.ts"

/**
 * BOTH SPELLINGS OF A FLAG, because a CLI that recognises only one of them is a
 * CLI that silently ignores the other (code review 2026-09-08).
 *
 * `--cap 400` and `--cap=400` are the same request, and `indexOf("--cap")` sees
 * only the first. On `--cap` that miss is not cosmetic: an unseen `--cap` is an
 * ABSENT `--cap`, absent means no ceiling, and under `--live` no ceiling is real
 * credentials — the very failure the seam below exists to end, re-entering
 * through the spelling rather than through the value.
 */
function flagIndex(argv: readonly string[], name: string): number {
  return argv.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`))
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = flagIndex(argv, name)
  if (index < 0) return undefined
  const arg = argv[index]!
  const eq = arg.indexOf("=")
  if (eq >= 0) return arg.slice(eq + 1)
  return argv[index + 1]
}

function has(argv: readonly string[], name: string): boolean {
  return flagIndex(argv, name) >= 0
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
 * - **Out of range** is refused against a floor AND a ceiling the caller states,
 *   because both differ: a cap of 0 is a real, explicit ceiling of zero, and 0
 *   repeats is not a run; a cap of two million tokens is a large budget and
 *   twenty repeats is a long noise floor, while anything past either is a typo
 *   that under `--live` spends real credentials.
 *
 * It REFUSES, it does not gate: like the missing-`--pin` path above, an invalid
 * invocation prints and `main` still returns 0. The tests are what fail CI.
 */
/**
 * The two ceilings, stated once (human decision, 2026-09-08).
 *
 * Neither is a budget policy — `--cap` IS the budget dial and the caller owns it.
 * They are the distance between a large deliberate number and a slipped digit,
 * placed well above any run this harness was built for: three arms over a
 * seeded-defect fixture, or a live pass a person watches.
 */
export const MAX_TOKEN_CAP = 2_000_000
export const MAX_REPEATS = 20

type NumericFlag = { ok: true; value: number | undefined } | { ok: false; message: string }

export function numericFlag(
  argv: readonly string[],
  name: string,
  min: number,
  max: number,
): NumericFlag {
  if (!has(argv, name)) return { ok: true, value: undefined }
  // A REPEATED FLAG IS REFUSED, not silently resolved to the first one (ledger
  // triage 2026-09-09). `flagIndex` finds the FIRST occurrence, so
  // `--cap 400 --cap abc` used to run with a ceiling of 400 and never look at
  // the second, unreadable value — the exact shape this seam exists to refuse,
  // re-entering through repetition rather than through the value. Two spellings
  // of one dial is an operator who is not sure which value is in force, and on
  // the flag that bounds spend the honest answer is to say so.
  const occurrences = argv.filter((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`)).length
  if (occurrences > 1) {
    return {
      ok: false,
      message: `--${name} was given ${occurrences} times. Pass it once; MAD will not guess which value is in force.`,
    }
  }
  const raw = flag(argv, name)
  if (raw === undefined || raw.trim() === "" || raw.startsWith("--")) {
    return { ok: false, message: `--${name} needs a value. Nothing readable followed it.` }
  }
  // DECIMAL DIGITS ONLY, checked on the STRING (code review 2026-09-08).
  // `Number` is not the contract this message states: it reads `0x10` as 16,
  // `1e3` as 1000 and `+5` as 5, all of which `Number.isInteger` then accepts —
  // so a flag whose refusal says "must be a whole number" was quietly
  // reinterpreting the digits the operator typed. On the flag that bounds spend,
  // a ceiling that differs from what was typed is the same defect as no ceiling.
  // The sign is allowed through so a negative is refused BY RANGE below, which
  // names the floor, rather than by shape, which would not.
  if (!/^-?\d+$/.test(raw.trim())) {
    return { ok: false, message: `--${name} must be a whole number. It received \`${raw}\`.` }
  }
  const value = Number(raw)
  if (!Number.isInteger(value)) {
    return { ok: false, message: `--${name} must be a whole number. It received \`${raw}\`.` }
  }
  if (value < min) {
    return { ok: false, message: `--${name} must be ${min} or more. It received \`${raw}\`.` }
  }
  // A CEILING AS WELL AS A FLOOR (human decision, 2026-09-08). The floor was
  // stated and the ceiling was not, so `--repeats 1000000` validated — and under
  // `--live` that is a million billed runs per arm from one mistyped digit. The
  // number is refused BY NAME against a stated ceiling, the same shape the floor
  // uses, so the message says which flag, what it received and what the limit is.
  // The ceilings are deliberately generous: they are a typo guard, not a policy.
  if (value > max) {
    return { ok: false, message: `--${name} must be ${max} or less. It received \`${raw}\`.` }
  }
  return { ok: true, value }
}

/**
 * A STRING flag, with the same repeated-flag refusal `numericFlag` applies.
 *
 * `--out` names a directory MAD will write to, so the reasoning that made a
 * repeated `--cap` a refusal applies unchanged: two spellings of one destination
 * is an operator who is not sure where their evidence is going, and picking the
 * first silently is the wrong answer on a flag with a filesystem behind it.
 */
export type StringFlag = { ok: true; value: string | undefined } | { ok: false; message: string }

export function stringFlag(argv: readonly string[], name: string): StringFlag {
  if (!has(argv, name)) return { ok: true, value: undefined }
  const occurrences = argv.filter((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`)).length
  if (occurrences > 1) {
    return {
      ok: false,
      message: `--${name} was given ${occurrences} times. Pass it once; MAD will not guess which value is in force.`,
    }
  }
  const raw = flag(argv, name)
  if (raw === undefined || raw.trim() === "" || raw.startsWith("--")) {
    return { ok: false, message: `--${name} needs a value. Nothing readable followed it.` }
  }
  return { ok: true, value: raw.trim() }
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
      `--cap bounds the tokens a run may spend and is shared by all three arms;\n` +
      `omit it for no ceiling, or give it 0 to ${MAX_TOKEN_CAP}. --repeats runs each arm\n` +
      `N times to establish a noise floor; omit it for one pass, or give it 1 to\n` +
      `${MAX_REPEATS}.\n` +
      `\n` +
      `--labelled-change reviews the sealed labelled change instead of reading one from\n` +
      `--directory, and fills the manifest's fixture version and hash from the seal. It\n` +
      `needs --live and --out (AC4: no --out is no manifest, so the identity would be\n` +
      `recorded nowhere), it refuses an explicit --fixture-version or --fixture-hash and a\n` +
      `--target beside it, and it REFUSES a --directory that is this repository, is inside\n` +
      `it, or CONTAINS it: a live model's session opens files under the directory it is\n` +
      `given, and this repository holds the answer key. Materialize a worktree elsewhere\n` +
      `first:\n` +
      `\n` +
      `  bun run materialize-change --out /scratch/mad-labelled-change\n` +
      `\n` +
      `Nothing was run and nothing was billed.`,
  )
  return 0
}

/** `provider/model`, split at the FIRST slash — a model id may contain one. */
export function parsePin(value: string): Pin | undefined {
  const cut = value.indexOf("/")
  if (cut <= 0 || cut === value.length - 1) return undefined
  return { providerId: value.slice(0, cut).trim(), modelId: value.slice(cut + 1).trim() }
}

/**
 * Injected so the live path's REFUSALS can be asserted without a provider
 * (story 2.2 recheck, 2026-09-10).
 *
 * It is the same shape `ablation/live.ts` already uses for `createClient` and
 * `shell`, and for the reason recorded there: the live path is the one thing CI
 * can never drive, so the only way a line on it is testable at all is a seam.
 * What this one makes testable is the catch below — that a deliberate stop
 * prints and returns 0 rather than exiting 1 with a stack trace.
 */
export interface AblationOverrides {
  runLive?: (
    options: Parameters<typeof import("../ablation/live.ts").runLiveAblation>[0],
  ) => Promise<Awaited<ReturnType<typeof import("../ablation/live.ts").runLiveAblation>>>
}

export async function main(
  argv: readonly string[] = Bun.argv,
  overrides: AblationOverrides = {},
): Promise<number> {
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
  const cap = numericFlag(argv, "cap", 0, MAX_TOKEN_CAP)
  if (!cap.ok) return refuse(cap.message)
  const repeats = numericFlag(argv, "repeats", 1, MAX_REPEATS)
  if (!repeats.ok) return refuse(repeats.message)
  const tokenCap = cap.value
  const repeatCount = repeats.value ?? 1

  // FR1 (story 2.2) — `--out` writes the evaluation bundle. Read and checked
  // here, before either path runs, for the reason the dials above are.
  const out = stringFlag(argv, "out")
  if (!out.ok) return refuse(out.message)
  const protocolVersion = numericFlag(argv, "protocol-version", 1, 1000)
  if (!protocolVersion.ok) return refuse(protocolVersion.message)
  const protocolHash = stringFlag(argv, "protocol-hash")
  if (!protocolHash.ok) return refuse(protocolHash.message)
  const fixtureVersion = stringFlag(argv, "fixture-version")
  if (!fixtureVersion.ok) return refuse(fixtureVersion.message)
  const fixtureHash = stringFlag(argv, "fixture-hash")
  if (!fixtureHash.ok) return refuse(fixtureHash.message)

  // A SCRIPTED RUN WRITES NOTHING, and that is story 9's A20 rather than a
  // preference: the worktree is byte-identical before and after a scripted
  // ablation, and a `--out` that quietly started writing files would end that
  // guarantee on the path CI actually exercises.
  if (out.value !== undefined && !has(argv, "live")) {
    return refuse(
      "--out writes an evaluation bundle and only the --live path produces one. A scripted " +
        "ablation compares records in memory and writes nothing, deliberately.",
    )
  }

  // FR5 / AC1-AC2-AC4 (story 2.4) — `--labelled-change`. Every refusal below runs
  // BEFORE the live path is imported, so "nothing was billed" stays a structural
  // fact rather than a promise, exactly as the dials above are checked first.
  // `--directory` GOES THROUGH `stringFlag`, not bare `flag()` (review finding P8,
  // 2026-09-11). Since this story it is one of the two flags that decide WHAT IS
  // REVIEWED and where a live model's session may open files, which is the same
  // class of flag as `--out` and `--cap`: `--directory /a --directory /b` used to
  // take the first silently, and `--directory --out /x` used to yield the literal
  // string `"--out"` as a directory — a path that then failed containment for the
  // wrong reason, or on another machine passed it.
  const directoryFlag = stringFlag(argv, "directory")
  if (!directoryFlag.ok) return refuse(directoryFlag.message)
  const directory = directoryFlag.value ?? process.cwd()

  // `--labelled-change` IS A BOOLEAN AND TAKES NO VALUE, and a value spelling is
  // refused rather than ignored (review finding P8). `has()` matches
  // `--labelled-change=<anything>` as well as the bare flag, so
  // `--labelled-change=false` turned the labelled path ON — the opposite of what
  // was typed, on the flag that decides whether the sealed identity is stamped
  // into the manifest.
  const labelledValue = argv.filter((arg) => arg.startsWith("--labelled-change="))
  if (labelledValue.length > 0) {
    return refuse(
      `--labelled-change takes no value; it received \`${labelledValue[0]}\`. It is a switch, ` +
        "and MAD will not read `=false` as OFF while the flag is present — pass the bare " +
        "`--labelled-change` to review the sealed labelled change, or omit it entirely.",
    )
  }
  const labelled = has(argv, "labelled-change")

  if (labelled && !has(argv, "live")) {
    return refuse(
      "--labelled-change points a LIVE roster at the sealed labelled change, and only the " +
        "--live path has a roster. The scripted ablation already reviews this exact change " +
        "through `ablation/seeded-defects.ts`, against a backend that bills a constant and " +
        "upholds everything — so the flag would claim a labelled evaluation and deliver the " +
        "scripted one.",
    )
  }

  // `--target` BESIDE `--labelled-change` IS TWO AUTHORITIES ON WHAT IS REVIEWED,
  // and this file refuses every other one of those by name (review finding P7,
  // 2026-09-11). `--target` is host git syntax handed to `repo.change()`, and a
  // labelled run never calls `repo.change()` — the change is handed in
  // (`ablation/live.ts`). Forwarding it meant the operator's ref range was read
  // by nothing while the report and the manifest said the sealed set was
  // reviewed, which is the same silent disagreement the `--fixture-version`
  // refusal below exists to prevent.
  if (labelled && flag(argv, "target") !== undefined) {
    return refuse(
      "--labelled-change reviews the sealed labelled change itself, so nothing reads a " +
        "worktree and --target has nothing to select. Drop --target, or drop " +
        "--labelled-change and review the range you named.",
    )
  }

  // TWO AUTHORITIES ON THE FIXTURE IDENTITY IS HOW A MANIFEST COMES TO NAME A SET
  // THAT WAS NOT REVIEWED. `--labelled-change` fills both fields from the seal;
  // an operator's typed value beside it can only agree redundantly or disagree
  // silently, and the second is unrecoverable after the run — the bundle would
  // carry a hash nobody can match to the bytes the models actually saw.
  if (labelled && (fixtureVersion.value !== undefined || fixtureHash.value !== undefined)) {
    return refuse(
      "--labelled-change fills --fixture-version and --fixture-hash from the sealed fixture " +
        `itself (\`${LABELLED_CHANGE_SEAL.version}\`, \`${LABELLED_CHANGE_SEAL.materialHash}\`), ` +
        "so passing either by hand gives the manifest two authorities on what was reviewed. " +
        "Drop the flag you typed; the seal is the one that cannot be wrong.",
    )
  }

  // THE LOAD-BEARING HALF OF AC2, AND IT CANNOT BE LEFT TO THE OPERATOR.
  //
  // A live model's session is created with `directory: --directory`
  // (`adapters/opencode/model-backend.ts:574`) and the host's default tools are
  // left ON: `ablation/live.ts`'s `backendFor` builds `OpencodeModelBackend` with
  // `serverUrl`, `directory`, `slots` and `lateUsage` and NO `tools` key at all —
  // the word does not appear in that file — and `model-backend.ts:134-140` is
  // where that default stands ("A spawned session gets host tools by default").
  // The Fact-Checker instruction then TELLS the model to open files
  // (`core/instructions/coding/judge.ts:83` — "USE YOUR TOOLS. Open the file.").
  // Pointed at this repository, a model can open
  // `fixtures/seeded-defects/labels.ts` and read the answer key. That channel is
  // invisible to `core/` and is exercised by no CI test, which is exactly why it
  // is refused here rather than documented.
  //
  // The CHECK is `refusalFor`/`realRefusalFor`, imported rather than
  // reimplemented for the reason `ablation/bundle.ts` records — a second
  // containment test is a second thing that can be subtly weaker than the first.
  // Only the MESSAGE is written here: their wording is about where MAD WRITES,
  // and this refusal is about what a model can READ.
  //
  // BOTH DIRECTIONS, AND BOTH FORMS (review finding P1, 2026-09-11). The check
  // asks "is A inside B", and the first version asked it only one way round — so
  // a `--directory` that IS this repository or sits INSIDE it was refused, while
  // one that CONTAINS it (`/Users/me/src`, or `/`) was accepted and a model with
  // the host's default tools could simply walk down into
  // `fixtures/seeded-defects/labels.ts`. The mirror call is the same imported
  // check with its arguments swapped. The lexical form runs first so a relative
  // `--directory` is refused BY NAME — containment cannot be decided on a path
  // that has not been resolved — and the real form follows symlinks, so a link
  // pointing at this repository, or one whose target contains it, cannot slip
  // past the lexical test.
  if (labelled) {
    const repoRoot = resolve(import.meta.dir, "..")
    const contained =
      refusalFor(directory, repoRoot) !== undefined ||
      refusalFor(repoRoot, directory) !== undefined ||
      (await realRefusalFor(directory, repoRoot)) !== undefined ||
      (await realRefusalFor(repoRoot, directory)) !== undefined
    if (contained) {
      return refuse(
        `--labelled-change refuses \`--directory ${directory}\`: it is this repository, is ` +
          "inside it, CONTAINS it, or is not an absolute path that can be checked against it. " +
          "A live model's session can open any file under the directory it is given, and this " +
          "repository holds `fixtures/seeded-defects/labels.ts` — the ids, loci, summaries and " +
          "markers of all thirteen planted defects. A model that can read the answer key " +
          "measures nothing.",
      )
    }
  }

  // A LABELLED RUN WITH NO `--out` IS REFUSED (review finding P4, 2026-09-11).
  //
  // This shipped as a NOTE, on the reasoning that refusing would be a stronger
  // rule than the story gave. It is not stronger — it is AC4: "its version and
  // content hash are recorded in the manifest of every run that reviews it". A
  // run with no `--out` writes no manifest, so it is a run that reviews the
  // sealed set and records the identity NOWHERE, which is the one thing AC4 says
  // must not happen. A warning leaves the operator free to bill a live roster
  // against the labelled change and end with numbers that trace to nothing
  // (FR1), which is exactly the untraceable published number FR1 exists to stop.
  // It is refused here, in the same block as every other cross-flag refusal, and
  // before anything is imported or billed.
  if (labelled && out.value === undefined) {
    return refuse(
      "--labelled-change needs --out. AC4 records the fixture's version and content hash in " +
        "the manifest of every run that reviews it, and without --out no manifest is written " +
        "at all — the run would bill a live roster and leave numbers that trace to nothing " +
        "(FR1). Add --out <a bundle directory outside every repository>.",
    )
  }

  if (has(argv, "live")) {
    // The live path deliberately lives in `ablation/live.ts` and is not inlined
    // here: it is the one module in this tree that imports `adapters/`, and CI
    // can never exercise it. Keeping it behind one import keeps the scripted
    // path — the one the tests gate — free of an opencode client.
    const { runLiveAblation } = await import("../ablation/live.ts")
    const { codeRevisionFrom, EvaluationBundleError } = await import("../ablation/bundle.ts")
    const { known, unknownValue } = await import("../ablation/manifest.ts")

    const bundle =
      out.value === undefined
        ? undefined
        : {
            root: out.value,
            createdAt: new Date().toISOString(),
            identity: {
              protocolVersion:
                protocolVersion.value === undefined
                  ? unknownValue("--protocol-version was not given")
                  : known(protocolVersion.value),
              protocolHash:
                protocolHash.value === undefined
                  ? unknownValue("--protocol-hash was not given")
                  : known(protocolHash.value),
              // AC4 (story 2.4) — THE SEAL IS THE FIRST AUTHORITY, and the
              // refusal above guarantees it is the only one: `--labelled-change`
              // cannot be given beside an explicit `--fixture-version` or
              // `--fixture-hash`, so these two branches can never both be live.
              // Without the flag nothing changes — an unlabelled run still
              // records an explicit unknown with its reason, and
              // `read-bundle.ts:90` still segregates it rather than treating it
              // as agreement.
              fixtureVersion: labelled
                ? known(LABELLED_CHANGE_SEAL.version)
                : fixtureVersion.value === undefined
                  ? unknownValue("--fixture-version was not given")
                  : known(fixtureVersion.value),
              // The MATERIAL hash, not the labels hash. This field answers "which
              // bytes did the models see", and the models saw the material. The
              // labels hash seals the answer key, which no arm read and which
              // therefore has no place in a manifest of what was reviewed.
              fixtureHash: labelled
                ? known(LABELLED_CHANGE_SEAL.materialHash)
                : fixtureHash.value === undefined
                  ? unknownValue("--fixture-hash was not given")
                  : known(fixtureHash.value),
              // ESTABLISHED, NOT ASSUMED. Every failure below comes back as an
              // explicit unknown carrying git's own words (AC4).
              codeRevision: await codeRevisionFrom(async (command, args) => {
                const spawned = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" })
                const [stdout, stderr] = await Promise.all([
                  new Response(spawned.stdout).text(),
                  new Response(spawned.stderr).text(),
                ])
                return { exitCode: await spawned.exited, stdout, stderr }
              }),
            },
          }

    // THE BUNDLE'S DELIBERATE STOP IS CAUGHT HERE (recheck finding, 2026-09-10).
    // A mandatory dump that could not be written stops the evaluation on purpose —
    // FR1: a published number is traceable to the run that produced it, or it is
    // not published — and that refusal reaching the operator as an unhandled stack
    // trace, with the process exiting 1, reads as a crash in MAD rather than as
    // the refusal it is. It also broke this file's own "main always returns 0"
    // contract. Only `EvaluationBundleError` is caught; anything else still
    // propagates exactly as it did before this story.
    let report: Awaited<ReturnType<typeof runLiveAblation>>
    try {
      report = await (overrides.runLive ?? runLiveAblation)({
        pin,
        serverUrl: flag(argv, "server") ?? "http://localhost:4096",
        directory,
        ...(flag(argv, "target") === undefined ? {} : { target: flag(argv, "target")! }),
        // FR5 — the labelled change is handed in, so `repo.change()` is not
        // called and `--target` has nothing to read. `--directory` still matters
        // and is still checked: it is the worktree the model's own session opens
        // files in, which is why it must be the materialized tree and not this
        // repository.
        ...(labelled ? { change: SEEDED_CHANGE } : {}),
        ...(tokenCap === undefined ? {} : { tokenCap }),
        // The lens arm is the third arm, and without this flag the live path could
        // only ever run two — while `LIVE-RUN.md` documented three and story 9's
        // whole third-arm thesis (do lenses earn their tokens?) had no live path at
        // all (code review 2026-09-06).
        ...(flag(argv, "lenses") === undefined
          ? {}
          : { lenses: flag(argv, "lenses")!.split(",").map((lens) => lens.trim()).filter(Boolean) }),
        repeats: repeatCount,
        ...(bundle === undefined
          ? {}
          : {
              bundle,
              onBundleEvent: (event) => {
                console.log(
                  event.kind === "index"
                    ? `bundle index ${event.ok ? "written" : "REFUSED"} — ${event.detail}`
                    : `bundle arm ${event.armId} repeat ${event.repeatId} — ${event.outcome}: ${event.detail}`,
                )
              },
            }),
      })
    } catch (error) {
      if (!(error instanceof EvaluationBundleError)) throw error
      console.log(
        `CAP-9 ablation — the evaluation STOPPED and NO REPORT IS PRINTED.\n` +
          `\n` +
          `  ${error.message}\n` +
          `\n` +
          `This is a refusal, not a crash. FR1: a published number is traceable to the run that\n` +
          `produced it, or it is not published. Arms that completed before this point KEPT their\n` +
          `dumps and are readable with \`bun run eval-read\`; no arm after it was billed.`,
      )
      return 0
    }
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
