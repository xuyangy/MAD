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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { main as ablationMain, stringFlag } from "../scripts/ablation.ts"
import { main as evalReadMain } from "../scripts/eval-read.ts"
import { BUNDLE_FILE, BUNDLE_SCHEMA_VERSION } from "./bundle.ts"
import { MANIFEST_FILE, MANIFEST_SCHEMA_VERSION, known, unknownValue } from "./manifest.ts"

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
        spend: {
          perStage: [{ stage: "discover", spent: 30, total: 30, ceiling: null }],
          total: { input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          usageCompleteness: "unaudited",
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
    expect(text).toContain("USAGE COMPLETENESS is `unaudited`")
  })
})
