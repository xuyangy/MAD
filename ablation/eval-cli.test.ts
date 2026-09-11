/**
 * The two command-line seams story 2.2 adds, tested where every other CLI seam
 * in this tree is tested: through `main`, with the printed output captured.
 *
 * The refusals are the point. `--out` names a directory MAD will WRITE to, and
 * every guard on it — repeated, empty, on the scripted path — has to refuse
 * before anything runs, so "nothing was written" is a structural fact rather than
 * a promise.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { main as ablationMain, stringFlag } from "../scripts/ablation.ts"
import { main as evalReadMain } from "../scripts/eval-read.ts"
import { BUNDLE_FILE, BUNDLE_SCHEMA_VERSION, EvaluationBundleError } from "./bundle.ts"
import { MANIFEST_FILE, MANIFEST_SCHEMA_VERSION, known, unknownValue } from "./manifest.ts"
import { SEEDED_CHANGE } from "../fixtures/seeded-defects/material.ts"
import { LABELLED_CHANGE_SEAL } from "../fixtures/seeded-defects/seal.ts"

const REPO_ROOT = resolve(import.meta.dir, "..")

const scratch: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

afterEach(async () => {
  while (scratch.length > 0) {
    await rm(scratch.pop()!, { recursive: true, force: true })
  }
})

async function captured(run: () => Promise<number>): Promise<{ code: number; text: string }> {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "))
  }
  try {
    const code = await run()
    return { code, text: lines.join("\n") }
  } finally {
    console.log = original
  }
}

describe("stringFlag — the same refusals numericFlag makes", () => {
  test("absent is not an error; it is the caller declining to set it", () => {
    expect(stringFlag([], "out")).toEqual({ ok: true, value: undefined })
  })

  test("both spellings are recognised", () => {
    expect(stringFlag(["--out", "/scratch/b"], "out")).toEqual({ ok: true, value: "/scratch/b" })
    expect(stringFlag(["--out=/scratch/b"], "out")).toEqual({ ok: true, value: "/scratch/b" })
  })

  test("a repeated flag is REFUSED, never resolved to the first one", () => {
    expect(stringFlag(["--out", "/a", "--out", "/b"], "out").ok).toBe(false)
  })

  test("a flag with nothing readable after it is refused", () => {
    expect(stringFlag(["--out"], "out").ok).toBe(false)
    expect(stringFlag(["--out", "--live"], "out").ok).toBe(false)
    expect(stringFlag(["--out="], "out").ok).toBe(false)
  })
})

describe("`--out` on the scripted path", () => {
  test("IT IS REFUSED, and nothing runs — story 9's A20 stands", async () => {
    const root = await tempDir("mad-eval-cli-scripted-")
    const { code, text } = await captured(() =>
      ablationMain(["bun", "ablation", "--pin", "anthropic/claude-sonnet-4-5", "--out", root]),
    )
    expect(code).toBe(0)
    expect(text).toContain("--out writes an evaluation bundle")
    expect(text).toContain("Nothing was run and nothing was billed.")
  })

  test("a repeated --out is refused before anything runs", async () => {
    const { text } = await captured(() =>
      ablationMain([
        "bun",
        "ablation",
        "--pin",
        "anthropic/claude-sonnet-4-5",
        "--out",
        "/a",
        "--out",
        "/b",
        "--live",
      ]),
    )
    expect(text).toContain("--out was given 2 times")
  })
})

describe("the evaluation reader CLI", () => {
  test("without --bundle it says what it needs, and returns 0", async () => {
    const { code, text } = await captured(() => evalReadMain(["bun", "eval-read"]))
    expect(code).toBe(0)
    expect(text).toContain("`--bundle <directory>` is required")
  })

  test("a directory with no bundle index is reported, not crashed on", async () => {
    const root = await tempDir("mad-eval-cli-empty-")
    const { code, text } = await captured(() => evalReadMain(["bun", "eval-read", "--bundle", root]))
    expect(code).toBe(0)
    expect(text).toContain(BUNDLE_FILE)
  })

  test("a real bundle renders its table", async () => {
    const root = await tempDir("mad-eval-cli-bundle-")
    await writeFile(
      join(root, BUNDLE_FILE),
      JSON.stringify({
        schemaVersion: BUNDLE_SCHEMA_VERSION,
        createdAt: "2026-09-10T00:00:00.000Z",
        arms: [{ armId: "on", repeatId: 0 }],
      }),
    )
    const dir = join(root, "on", "0", "run-on-0")
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, MANIFEST_FILE),
      JSON.stringify({
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        identity: {
          protocolVersion: known(1),
          protocolHash: known("sha256:protocol"),
          fixtureVersion: known("fixture-1"),
          fixtureHash: known("sha256:fixture"),
          codeRevision: known({ commit: "13eadc6", dirty: false }),
          armId: "on",
          repeatId: 0,
          changeId: { description: "HEAD~1..HEAD", files: [], diffHash: "sha256:diff" },
        },
        run: { runId: "run-on-0", startedAt: "2026-09-10T00:00:00.000Z", finishedAt: known("x") },
        roster: {
          requested: 3,
          filled: 3,
          answered: 3,
          distinctLineages: 3,
          providers: [],
          slots: [],
          lensSlots: [],
          skippedForBudget: [],
        },
        dials: {
          threshold: 0.5,
          maxRounds: 2,
          maxConcurrency: 4,
          cap: null,
          shares: { discover: 0.3, debate: 0.65, judge: 1 },
          preset: unknownValue("the caller named no preset"),
        },
        // AC5 (story 2.3) — THIS FIXTURE IS DELIBERATELY AN INCOMPLETE ARM, and
        // it wrote `usageCompleteness: "unaudited"` before. That value was the
        // only one story 2.2's builder could produce; `buildManifest` now audits
        // the ledger, so keeping it would have pinned the CLI against a manifest
        // MAD no longer writes. The interesting state is the one this end-to-end
        // path has to carry all the way to an operator's terminal: a run whose
        // token figure is short and says so.
        spend: {
          perStage: [{ stage: "discover", spent: 30, total: 30, ceiling: null }],
          total: { input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          usageCompleteness: "incomplete",
          unknownUsage: [
            {
              slot: "discovery-1",
              stage: "discover",
              attempt: 1,
              executionId: "exec-1",
              why: "the host settled the turn and reported no tokens",
            },
          ],
          unknownUsageCount: 1,
          exposure: "unquantified",
        },
        status: {
          completion: "completed",
          cancelledAt: unknownValue("the run was never cancelled"),
          warnings: [],
          routeCounts: { kind: "did-not-run" },
          debateCounts: { kind: "did-not-run" },
          judgeCounts: { kind: "did-not-run" },
        },
        findings: { pool: [], canonicalIds: [], lensInstructions: [] },
        stageOutputs: { recordFile: "record.json", turnFiles: known(0) },
      }),
    )

    const { code, text } = await captured(() => evalReadMain(["bun", "eval-read", "--bundle", root]))
    expect(code).toBe(0)
    expect(text).toContain("COMPARABLE ARMS")
    expect(text).toContain("ceiling none")
    // The bundle-wide "`unaudited` for every run in this bundle" paragraph this
    // line used to assert is gone: the verdict is per arm now, and an operator
    // reading one arm's short token figure gets the identity that made it short.
    expect(text).toContain("USAGE COMPLETENESS, PER ARM")
    expect(text).toContain("on repeat 0 — INCOMPLETE: 1 execution(s)")
    expect(text).toContain("exec-1 (discover/discovery-1, attempt 1)")
    expect(text).toContain("tokens (observed)")
  })
})

/**
 * The recheck's CLI regression (2026-09-10).
 *
 * Making a failed mandatory dump stop the evaluation (finding 6) was right, and
 * it broke this file's own "main always returns 0" contract on the way: the
 * deliberate refusal propagated out of `runLiveAblation`, past an uncaught
 * boundary, and the executable exited 1 with a stack trace. A refusal that looks
 * like a crash teaches the operator to distrust the wrong thing.
 */
describe("a deliberate bundle stop is a refusal, not a crash", () => {
  const liveArgv = (out: string) => [
    "bun",
    "ablation",
    "--pin",
    "anthropic/claude-sonnet-4-5",
    "--live",
    "--out",
    out,
  ]

  test("it prints, says no report follows, and STILL RETURNS 0", async () => {
    const { code, text } = await captured(() =>
      ablationMain(liveArgv("/scratch/mad-eval"), {
        runLive: () => {
          throw new EvaluationBundleError(
            "the evaluation bundle could not record arm `pool` repeat 0 (failed)",
          )
        },
      }),
    )
    expect(code).toBe(0)
    expect(text).toContain("the evaluation STOPPED and NO REPORT IS PRINTED")
    expect(text).toContain("could not record arm `pool` repeat 0")
    expect(text).toContain("This is a refusal, not a crash")
    expect(text).toContain("KEPT their")
  })

  test("ANY OTHER ERROR STILL PROPAGATES — the catch is narrow, not a blanket", async () => {
    await expect(
      captured(() =>
        ablationMain(liveArgv("/scratch/mad-eval"), {
          runLive: () => {
            throw new Error("the provider hung up")
          },
        }),
      ),
    ).rejects.toThrow("the provider hung up")
  })

  test("a live run that succeeds still prints its report", async () => {
    const { code, text } = await captured(() =>
      ablationMain(liveArgv("/scratch/mad-eval"), {
        runLive: async () => ({
          arms: [],
          pairings: [],
          matcherCalibration: { overMerge: { merged: 0, of: 0 }, underMerge: { unmerged: 0, of: 0 } },
          anyScripted: false,
          repeats: 1,
        }),
      }),
    )
    expect(code).toBe(0)
    expect(text).toContain("CAP-9")
    expect(text).not.toContain("the evaluation STOPPED")
  })
})

/**
 * `--labelled-change` (story 2.4, Task 11).
 *
 * Every one of these refusals happens BEFORE `ablation/live.ts` is imported, so
 * "nothing was billed" is structural rather than promised — the same property
 * the `--out` refusals above buy. The `runLive` seam is what lets the ACCEPTED
 * case be asserted at all: it observes the options the live path would have been
 * called with, on a path CI can never actually drive.
 */
describe("`--labelled-change` refuses before anything bills", () => {
  const labelledArgv = (...extra: string[]) => [
    "bun",
    "ablation",
    "--pin",
    "anthropic/claude-sonnet-4-5",
    "--labelled-change",
    ...extra,
  ]

  test("without --live it is refused — the scripted path has no roster", async () => {
    const { code, text } = await captured(() => ablationMain(labelledArgv()))
    expect(code).toBe(0)
    expect(text).toContain("--labelled-change points a LIVE roster")
    expect(text).toContain("Nothing was run and nothing was billed.")
  })

  test("an explicit --fixture-version beside it is refused", async () => {
    const out = await tempDir("mad-labelled-version-")
    const { text } = await captured(() =>
      ablationMain(
        labelledArgv("--live", "--directory", out, "--fixture-version", "something-else"),
      ),
    )
    expect(text).toContain("two authorities on what was reviewed")
    expect(text).toContain(LABELLED_CHANGE_SEAL.version)
  })

  test("an explicit --fixture-hash beside it is refused", async () => {
    const out = await tempDir("mad-labelled-hash-")
    const { text } = await captured(() =>
      ablationMain(labelledArgv("--live", "--directory", out, "--fixture-hash", "sha256:nope")),
    )
    expect(text).toContain("two authorities on what was reviewed")
  })

  test("a --directory INSIDE this repository is refused — the answer key is there", async () => {
    const { text } = await captured(() =>
      ablationMain(labelledArgv("--live", "--directory", join(REPO_ROOT, "fixtures"))),
    )
    expect(text).toContain("A model that can read the answer key measures nothing")
    expect(text).toContain("labels.ts")
  })

  test("a --directory that IS this repository is refused", async () => {
    const { text } = await captured(() =>
      ablationMain(labelledArgv("--live", "--directory", REPO_ROOT)),
    )
    expect(text).toContain("A model that can read the answer key measures nothing")
  })

  test("a RELATIVE --directory is refused: containment cannot be decided on it", async () => {
    const { text } = await captured(() =>
      ablationMain(labelledArgv("--live", "--directory", "some/relative/tree")),
    )
    expect(text).toContain("A model that can read the answer key measures nothing")
  })

  /**
   * THE MIRROR HALF OF THE CONTAINMENT REFUSAL (review finding P1, 2026-09-11).
   *
   * The check asks "is A inside B", and the first version asked it one way only.
   * A `--directory` that CONTAINS this repository was accepted, and a model with
   * the host's default tools walks down into `fixtures/seeded-defects/labels.ts`
   * from there exactly as easily as it reads it from inside the repository.
   */
  test("a --directory that CONTAINS this repository is refused", async () => {
    const { text } = await captured(() =>
      ablationMain(labelledArgv("--live", "--directory", dirname(REPO_ROOT))),
    )
    expect(text).toContain("A model that can read the answer key measures nothing")
    expect(text).toContain("CONTAINS it")
  })

  test("`--directory /` — the directory that contains everything — is refused", async () => {
    // The edge that made the mirror check worth testing rather than assuming:
    // `resolve("/")` already ends in the separator, so a naive `repo + sep`
    // prefix was `"//"` and nothing was ever inside it.
    const { text } = await captured(() => ablationMain(labelledArgv("--live", "--directory", "/")))
    expect(text).toContain("A model that can read the answer key measures nothing")
  })

  test("a SYMLINK pointing at this repository is refused — the lexical test cannot see it", async () => {
    const parent = await tempDir("mad-labelled-symlink-")
    const link = join(parent, "looks-innocent")
    await symlink(REPO_ROOT, link, "dir")

    const { text } = await captured(() =>
      ablationMain(labelledArgv("--live", "--directory", link)),
    )
    expect(text).toContain("A model that can read the answer key measures nothing")
  })

  test("a SYMLINK whose target CONTAINS this repository is refused too", async () => {
    // Both halves at once: the mirror direction, through the symlink-aware form.
    const parent = await tempDir("mad-labelled-symlink-parent-")
    const link = join(parent, "up-there")
    await symlink(dirname(REPO_ROOT), link, "dir")

    const { text } = await captured(() =>
      ablationMain(labelledArgv("--live", "--directory", link)),
    )
    expect(text).toContain("A model that can read the answer key measures nothing")
  })

  test("--target beside it is refused — nothing would read the range", async () => {
    const worktree = await tempDir("mad-labelled-target-")
    const { text } = await captured(() =>
      ablationMain(
        labelledArgv("--live", "--directory", worktree, "--target", "main...HEAD"),
      ),
    )
    expect(text).toContain("--target has nothing to select")
    expect(text).toContain("Nothing was run and nothing was billed.")
  })

  /**
   * THE TWO FLAGS THAT NOW DECIDE WHAT IS REVIEWED, PARSED LIKE IT (review
   * finding P8, 2026-09-11).
   */
  test("a repeated --directory is refused, never resolved to the first spelling", async () => {
    const { text } = await captured(() =>
      ablationMain(labelledArgv("--live", "--directory", "/a", "--directory", "/b")),
    )
    expect(text).toContain("--directory was given 2 times")
  })

  test("a --directory with nothing readable after it is refused by name", async () => {
    const bundleRoot = await tempDir("mad-labelled-dangling-")
    const { text } = await captured(() =>
      ablationMain(labelledArgv("--live", "--directory", "--out", bundleRoot)),
    )
    expect(text).toContain("--directory needs a value")
  })

  test("`--labelled-change=false` is refused, not read as ON", async () => {
    const worktree = await tempDir("mad-labelled-false-")
    const { text } = await captured(() =>
      ablationMain([
        "bun",
        "ablation",
        "--pin",
        "anthropic/claude-sonnet-4-5",
        "--live",
        "--labelled-change=false",
        "--directory",
        worktree,
      ]),
    )
    expect(text).toContain("--labelled-change takes no value")
  })

  test("the refusal is NOT vacuous — a directory outside this repo is accepted", async () => {
    const worktree = await tempDir("mad-labelled-ok-")
    const bundleRoot = await tempDir("mad-labelled-ok-bundle-")
    const seen: { change?: unknown }[] = []
    const { code, text } = await captured(() =>
      ablationMain(labelledArgv("--live", "--directory", worktree, "--out", bundleRoot), {
        runLive: async (options) => {
          seen.push(options)
          return {
            arms: [],
            pairings: [],
            matcherCalibration: {
              overMerge: { merged: 0, of: 0 },
              underMerge: { unmerged: 0, of: 0 },
            },
            anyScripted: false,
            repeats: 1,
          }
        },
      }),
    )
    expect(code).toBe(0)
    expect(text).not.toContain("A model that can read the answer key")
    expect(seen).toHaveLength(1)
    // FR5 — the change is HANDED IN, so `repo.change()` is never called and the
    // run reviews a set whose bugs are written down.
    expect(seen[0]!.change).toEqual(SEEDED_CHANGE)
  })
})

describe("`--labelled-change` writes the sealed identity into the manifest (AC4)", () => {
  test("fixtureVersion and fixtureHash are `known` and equal the seal", async () => {
    const worktree = await tempDir("mad-labelled-identity-")
    const bundleRoot = await tempDir("mad-labelled-bundle-")
    const seen: { bundle?: { identity: Record<string, unknown> }; change?: unknown }[] = []

    await captured(() =>
      ablationMain(
        [
          "bun",
          "ablation",
          "--pin",
          "anthropic/claude-sonnet-4-5",
          "--live",
          "--labelled-change",
          "--directory",
          worktree,
          "--out",
          bundleRoot,
        ],
        {
          runLive: async (options) => {
            seen.push(options)
            return {
              arms: [],
              pairings: [],
              matcherCalibration: {
                overMerge: { merged: 0, of: 0 },
                underMerge: { unmerged: 0, of: 0 },
              },
              anyScripted: false,
              repeats: 1,
            }
          },
        },
      ),
    )

    const identity = seen[0]!.bundle!.identity
    expect(identity.fixtureVersion).toEqual(known(LABELLED_CHANGE_SEAL.version))
    // The MATERIAL hash: this field says which bytes the models saw, and no arm
    // read the labels.
    expect(identity.fixtureHash).toEqual(known(LABELLED_CHANGE_SEAL.materialHash))
    expect(identity.fixtureHash).not.toEqual(known(LABELLED_CHANGE_SEAL.labelsHash))
  })

  test("WITHOUT the flag nothing changes — an unlabelled run still records an unknown", async () => {
    const bundleRoot = await tempDir("mad-unlabelled-identity-")
    const seen: { bundle?: { identity: Record<string, unknown> }; change?: unknown }[] = []

    await captured(() =>
      ablationMain(
        ["bun", "ablation", "--pin", "anthropic/claude-sonnet-4-5", "--live", "--out", bundleRoot],
        {
          runLive: async (options) => {
            seen.push(options)
            return {
              arms: [],
              pairings: [],
              matcherCalibration: {
                overMerge: { merged: 0, of: 0 },
                underMerge: { unmerged: 0, of: 0 },
              },
              anyScripted: false,
              repeats: 1,
            }
          },
        },
      ),
    )

    const identity = seen[0]!.bundle!.identity
    expect(identity.fixtureVersion).toEqual(unknownValue("--fixture-version was not given"))
    expect(identity.fixtureHash).toEqual(unknownValue("--fixture-hash was not given"))
    expect(seen[0]!.change).toBeUndefined()
  })

  /**
   * AC4 IS A REFUSAL, NOT A WARNING (review finding P4, 2026-09-11).
   *
   * "its version and content hash are recorded in the manifest of every run that
   * reviews it" — a run with no `--out` writes no manifest, so it reviews the
   * sealed set and records the identity nowhere. This shipped as a NOTE and the
   * run went ahead; the seam is what proves it no longer does.
   */
  test("a labelled run with no --out is REFUSED, and the live path is never reached", async () => {
    const worktree = await tempDir("mad-labelled-no-out-")
    let reached = false
    const { code, text } = await captured(() =>
      ablationMain(
        [
          "bun",
          "ablation",
          "--pin",
          "anthropic/claude-sonnet-4-5",
          "--live",
          "--labelled-change",
          "--directory",
          worktree,
        ],
        {
          runLive: async () => {
            reached = true
            return {
              arms: [],
              pairings: [],
              matcherCalibration: {
                overMerge: { merged: 0, of: 0 },
                underMerge: { unmerged: 0, of: 0 },
              },
              anyScripted: false,
              repeats: 1,
            }
          },
        },
      ),
    )
    expect(code).toBe(0)
    expect(text).toContain("--labelled-change needs --out")
    expect(text).toContain("Nothing was run and nothing was billed.")
    expect(reached).toBe(false)
  })
})
