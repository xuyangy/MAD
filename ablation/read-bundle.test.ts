import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BUNDLE_FILE, BUNDLE_SCHEMA_VERSION, type BundleArm } from "./bundle.ts"
import { MANIFEST_FILE, MANIFEST_SCHEMA_VERSION, known, unknownValue } from "./manifest.ts"
import { readBundle, renderBundle } from "./read-bundle.ts"

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

interface Fake {
  armId: string
  repeatId: number
  protocolHash?: unknown
  fixtureHash?: unknown
  codeRevision?: unknown
  diffHash?: string
  schemaVersion?: number
  completion?: string
}

function manifestFor(fake: Fake): unknown {
  return {
    schemaVersion: fake.schemaVersion ?? MANIFEST_SCHEMA_VERSION,
    identity: {
      protocolVersion: known(1),
      protocolHash: fake.protocolHash ?? known("sha256:protocol"),
      fixtureVersion: known("fixture-1"),
      fixtureHash: fake.fixtureHash ?? known("sha256:fixture"),
      codeRevision: fake.codeRevision ?? known({ commit: "13eadc6", dirty: false }),
      armId: fake.armId,
      repeatId: fake.repeatId,
      changeId: {
        description: "HEAD~1..HEAD",
        files: ["src/a.ts"],
        diffHash: fake.diffHash ?? "sha256:diff",
      },
    },
    run: { runId: `run-${fake.armId}-${fake.repeatId}`, startedAt: "2026-09-10T00:00:00.000Z", finishedAt: known("2026-09-10T00:01:00.000Z") },
    roster: {
      requested: 3,
      filled: 3,
      answered: 3,
      distinctLineages: 3,
      providers: ["anthropic"],
      slots: [],
      lensSlots: [],
      skippedForBudget: [],
    },
    dials: {
      threshold: 0.5,
      maxRounds: 2,
      maxConcurrency: 4,
      cap: 1000,
      shares: { discover: 0.3, debate: 0.65, judge: 1 },
      preset: unknownValue("the caller named no preset"),
    },
    spend: {
      perStage: [{ stage: "discover", spent: 30, total: 30, ceiling: 300 }],
      total: { input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      usageCompleteness: "unaudited",
    },
    status: {
      completion: fake.completion ?? "completed",
      cancelledAt: unknownValue("the run was never cancelled"),
      warnings: [],
      routeCounts: { kind: "did-not-run" },
      debateCounts: { kind: "did-not-run" },
      judgeCounts: { kind: "did-not-run" },
    },
    findings: { pool: [], canonicalIds: [], lensInstructions: [] },
    stageOutputs: { recordFile: "record.json", turnFiles: known(2) },
  }
}

async function bundle(arms: readonly BundleArm[], written: readonly Fake[]): Promise<string> {
  const root = await tempDir("mad-read-bundle-")
  await writeFile(
    join(root, BUNDLE_FILE),
    JSON.stringify(
      { schemaVersion: BUNDLE_SCHEMA_VERSION, createdAt: "2026-09-10T00:00:00.000Z", arms },
      undefined,
      2,
    ),
  )
  for (const fake of written) {
    const dir = join(root, fake.armId, String(fake.repeatId), `run-${fake.armId}-${fake.repeatId}`)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, MANIFEST_FILE), JSON.stringify(manifestFor(fake), undefined, 2))
  }
  return root
}

describe("a bundle whose arms agree", () => {
  test("every arm is comparable, and nothing is segregated or missing", async () => {
    const root = await bundle(
      [
        { armId: "on", repeatId: 0 },
        { armId: "off", repeatId: 0 },
      ],
      [
        { armId: "on", repeatId: 0 },
        { armId: "off", repeatId: 0 },
      ],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(result.comparable.map((row) => row.armId)).toEqual(["on", "off"])
    expect(result.segregated).toEqual([])
    expect(result.missing).toEqual([])
    expect(result.unreadable).toEqual([])
  })

  test("the rendered table carries one row per comparable arm", async () => {
    const root = await bundle(
      [
        { armId: "on", repeatId: 0 },
        { armId: "off", repeatId: 0 },
      ],
      [
        { armId: "on", repeatId: 0 },
        { armId: "off", repeatId: 0 },
      ],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    const text = renderBundle(result)
    expect(text).toContain("on")
    expect(text).toContain("off")
    expect(text).toContain("COMPARABLE ARMS")
    expect(text).not.toContain("SEGREGATED")
    expect(text).not.toContain("MISSING")
  })
})

describe("AC2 — arms that do not match are segregated, with the reason", () => {
  test("a differing code revision segregates the minority arm", async () => {
    const root = await bundle(
      [
        { armId: "on", repeatId: 0 },
        { armId: "on", repeatId: 1 },
        { armId: "off", repeatId: 0 },
      ],
      [
        { armId: "on", repeatId: 0 },
        { armId: "on", repeatId: 1 },
        { armId: "off", repeatId: 0, codeRevision: known({ commit: "deadbee", dirty: false }) },
      ],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(result.comparable).toHaveLength(2)
    expect(result.segregated).toHaveLength(1)
    expect(result.segregated[0]!.armId).toBe("off")
    expect(result.segregated[0]!.reason).toContain("codeRevision")
  })

  test("a differing change identifier segregates, and the reason names it", async () => {
    const root = await bundle(
      [
        { armId: "on", repeatId: 0 },
        { armId: "on", repeatId: 1 },
        { armId: "off", repeatId: 0 },
      ],
      [
        { armId: "on", repeatId: 0 },
        { armId: "on", repeatId: 1 },
        { armId: "off", repeatId: 0, diffHash: "sha256:other" },
      ],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(result.segregated[0]!.reason).toContain("changeId")
  })

  test("AN UNKNOWN IS NOT AGREEMENT — two unknowns do not make a cohort", async () => {
    const root = await bundle(
      [
        { armId: "on", repeatId: 0 },
        { armId: "off", repeatId: 0 },
      ],
      [
        { armId: "on", repeatId: 0, codeRevision: unknownValue("git was unavailable") },
        { armId: "off", repeatId: 0, codeRevision: unknownValue("git was unavailable") },
      ],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(result.comparable).toEqual([])
    expect(result.segregated).toHaveLength(2)
    for (const row of result.segregated) {
      expect(row.reason).toContain("codeRevision")
      expect(row.reason).toContain("unknown")
    }
  })

  test("a two-versus-two split has no majority and segregates EVERYTHING", async () => {
    const root = await bundle(
      [
        { armId: "a", repeatId: 0 },
        { armId: "b", repeatId: 0 },
        { armId: "c", repeatId: 0 },
        { armId: "d", repeatId: 0 },
      ],
      [
        { armId: "a", repeatId: 0, diffHash: "sha256:one" },
        { armId: "b", repeatId: 0, diffHash: "sha256:one" },
        { armId: "c", repeatId: 0, diffHash: "sha256:two" },
        { armId: "d", repeatId: 0, diffHash: "sha256:two" },
      ],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(result.comparable).toEqual([])
    expect(result.segregated).toHaveLength(4)
    expect(result.segregated[0]!.reason).toContain("no majority")
  })
})

describe("AC2 — a missing arm is NAMED", () => {
  test("an arm the index declared and the disk does not hold is missing", async () => {
    const root = await bundle(
      [
        { armId: "on", repeatId: 0 },
        { armId: "off", repeatId: 0 },
      ],
      [{ armId: "on", repeatId: 0 }],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(result.missing).toEqual([
      { armId: "off", repeatId: 0, reason: "the bundle declared this arm and no dump was written for it" },
    ])
    expect(renderBundle(result)).toContain("MISSING ARMS")
  })

  test("a dump with no manifest is unreadable, not silently skipped", async () => {
    const root = await bundle([{ armId: "on", repeatId: 0 }], [])
    await mkdir(join(root, "on", "0", "run-on-0"), { recursive: true })
    await writeFile(join(root, "on", "0", "run-on-0", "record.json"), "{}")
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(result.unreadable).toHaveLength(1)
    expect(result.unreadable[0]!.reason).toContain(MANIFEST_FILE)
  })

  test("a manifest schema version this reader does not know is unreadable", async () => {
    const root = await bundle([{ armId: "on", repeatId: 0 }], [{ armId: "on", repeatId: 0, schemaVersion: 99 }])
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(result.unreadable[0]!.reason).toContain("schemaVersion 99")
  })

  test("unparseable JSON is unreadable, and says so", async () => {
    const root = await bundle([{ armId: "on", repeatId: 0 }], [])
    const dir = join(root, "on", "0", "run-on-0")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, MANIFEST_FILE), "{ not json")
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(result.unreadable).toHaveLength(1)
  })

  test("two run directories under one arm/repeat slot are unreadable, never picked between", async () => {
    const root = await bundle([{ armId: "on", repeatId: 0 }], [{ armId: "on", repeatId: 0 }])
    const second = join(root, "on", "0", "run-on-0-again")
    await mkdir(second, { recursive: true })
    await writeFile(join(second, MANIFEST_FILE), JSON.stringify(manifestFor({ armId: "on", repeatId: 0 })))
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(result.unreadable).toHaveLength(1)
    expect(result.unreadable[0]!.reason).toContain("2 run directories")
  })

  test("a bundle with no index is an error, not an empty report", async () => {
    const root = await tempDir("mad-read-bundle-noindex-")
    const result = await readBundle(root)
    expect("error" in result).toBe(true)
  })
})

describe("AC7 — the reader states its own limits", () => {
  test("an incomplete bundle says so, and makes no cross-arm claim", async () => {
    const root = await bundle(
      [
        { armId: "on", repeatId: 0 },
        { armId: "off", repeatId: 0 },
      ],
      [{ armId: "on", repeatId: 0 }],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    const text = renderBundle(result)
    expect(text).toContain("THIS BUNDLE IS INCOMPLETE")
    expect(text).toContain("no cross-arm claim")
  })

  test("a complete bundle carries no incompleteness banner", async () => {
    const root = await bundle(
      [
        { armId: "on", repeatId: 0 },
        { armId: "off", repeatId: 0 },
      ],
      [
        { armId: "on", repeatId: 0 },
        { armId: "off", repeatId: 0 },
      ],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(renderBundle(result)).not.toContain("THIS BUNDLE IS INCOMPLETE")
  })

  test("NO FUSED SCORE — the report names no rate, ratio or efficiency", async () => {
    const root = await bundle([{ armId: "on", repeatId: 0 }], [{ armId: "on", repeatId: 0 }])
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    const text = renderBundle(result).toLowerCase()
    for (const banned of ["score", "efficiency", "ratio", "pertoken"]) {
      expect(text).not.toContain(banned)
    }
    expect(JSON.stringify(result).toLowerCase()).not.toContain("pertoken")
  })

  test("a degraded arm's status reaches the table", async () => {
    const root = await bundle(
      [{ armId: "on", repeatId: 0 }],
      [{ armId: "on", repeatId: 0, completion: "degraded" }],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(renderBundle(result)).toContain("degraded")
  })
})
