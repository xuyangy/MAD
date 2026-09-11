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
  threshold?: number
  warnings?: unknown[]
  skippedForBudget?: string[]
  findings?: unknown
  perStage?: unknown
  total?: unknown
  shares?: unknown
  /**
   * AC5 (story 2.3) — the usage-audit half of `spend`, overridable field by
   * field so a malformed one can be written without hand-rolling a whole
   * manifest.
   *
   * THE DEFAULTS CHANGED WITH THE WRITER, and deliberately: this fixture wrote
   * `usageCompleteness: "unaudited"` because story 2.2's builder could write
   * nothing else. `buildManifest` now audits the ledger, so a fixture frozen at
   * `unaudited` would be a reader tested against a manifest MAD no longer
   * produces. The default here is what a clean run produces — `complete`, no
   * identities, exposure `quantified` — and every test that wants another state
   * asks for it.
   */
  usageCompleteness?: unknown
  unknownUsage?: unknown
  unknownUsageCount?: unknown
  exposure?: unknown
  /** Story 2.5A — absent writes the field ABSENT, the pre-2.5A shape. */
  routingPolicy?: unknown
  cap?: number
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
      skippedForBudget: fake.skippedForBudget ?? [],
    },
    dials: {
      threshold: fake.threshold ?? 0.5,
      maxRounds: 2,
      maxConcurrency: 4,
      cap: fake.cap ?? 1000,
      shares: fake.shares ?? { discover: 0.3, debate: 0.65, judge: 1 },
      preset: unknownValue("the caller named no preset"),
      // `in` for `usageCompleteness`' reason: absent must be writable as absent.
      ...("routingPolicy" in fake ? { routingPolicy: fake.routingPolicy } : { routingPolicy: "shipped" }),
    },
    spend: {
      perStage: fake.perStage ?? [{ stage: "discover", spent: 30, total: 30, ceiling: 300 }],
      total: fake.total ?? { input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      // `in` RATHER THAN `??`, for these four only. A test that wants to write a
      // manifest with the field ABSENT — the pre-2.3 shape a reader will meet on
      // disk — passes `undefined`, which `JSON.stringify` drops; `??` would
      // silently substitute the healthy default and the test would pin nothing.
      usageCompleteness: "usageCompleteness" in fake ? fake.usageCompleteness : "complete",
      unknownUsage: "unknownUsage" in fake ? fake.unknownUsage : [],
      unknownUsageCount: "unknownUsageCount" in fake ? fake.unknownUsageCount : 0,
      exposure: "exposure" in fake ? fake.exposure : "quantified",
    },
    status: {
      completion: fake.completion ?? "completed",
      cancelledAt: unknownValue("the run was never cancelled"),
      warnings: fake.warnings ?? [],
      routeCounts: { kind: "did-not-run" },
      debateCounts: { kind: "did-not-run" },
      judgeCounts: { kind: "did-not-run" },
    },
    findings: fake.findings ?? { pool: [], canonicalIds: [], lensInstructions: [] },
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

  test("a two-versus-two split has no plurality and segregates EVERYTHING", async () => {
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
    expect(result.segregated[0]!.reason).toContain("no plurality")
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

/**
 * Review findings 2, 3, 5 and 7 (2026-09-10). Each test below is a defect that
 * shipped in 51023b6 and was found by a reviewer, not by this suite.
 */

async function withRawManifest(armId: string, repeatId: number, body: string): Promise<string> {
  const root = await tempDir("mad-read-bundle-raw-")
  await writeFile(
    join(root, BUNDLE_FILE),
    JSON.stringify({
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      createdAt: "2026-09-10T00:00:00.000Z",
      arms: [{ armId, repeatId }],
    }),
  )
  const dir = join(root, armId, String(repeatId), `run-${armId}-${repeatId}`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, MANIFEST_FILE), body)
  return root
}

describe("finding 2 — a malformed manifest is unreadable, and takes nothing else down", () => {
  test("a `null` manifest does not throw", async () => {
    const result = await readBundle(await withRawManifest("on", 0, "null"))
    if ("error" in result) throw new Error(result.error)
    expect(result.unreadable).toHaveLength(1)
    expect(result.unreadable[0]!.reason).toContain("not a JSON object")
  })

  test("a manifest with only a schemaVersion does not throw", async () => {
    const result = await readBundle(await withRawManifest("on", 0, '{"schemaVersion":1}'))
    if ("error" in result) throw new Error(result.error)
    expect(result.unreadable[0]!.reason).toContain("`identity`")
  })

  test("ONE BAD FILE DOES NOT COST ITS HEALTHY SIBLINGS THEIR REPORT", async () => {
    const root = await bundle(
      [
        { armId: "on", repeatId: 0 },
        { armId: "off", repeatId: 0 },
      ],
      [{ armId: "on", repeatId: 0 }],
    )
    const dir = join(root, "off", "0", "run-off-0")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, MANIFEST_FILE), "null")

    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(result.unreadable).toHaveLength(1)
    expect(result.comparable.map((row) => row.armId)).toEqual(["on"])
  })

  test("A `known` WITH NO `value` IS NOT AGREEMENT — it is malformed", async () => {
    const root = await bundle(
      [
        { armId: "on", repeatId: 0 },
        { armId: "off", repeatId: 0 },
      ],
      [
        { armId: "on", repeatId: 0, protocolHash: { kind: "known" } },
        { armId: "off", repeatId: 0, protocolHash: { kind: "known" } },
      ],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(result.comparable).toEqual([])
    expect(result.unreadable).toHaveLength(2)
    for (const row of result.unreadable) {
      expect(row.reason).toContain("carrying no `value`")
    }
  })

  test("an unrecognised wrapper kind is malformed, not silently unknown", async () => {
    const root = await bundle(
      [{ armId: "on", repeatId: 0 }],
      [{ armId: "on", repeatId: 0, codeRevision: { kind: "maybe", value: "x" } }],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(result.unreadable[0]!.reason).toContain("unrecognised kind")
  })

  test("an index that is not a bundle index is an error naming why", async () => {
    const root = await tempDir("mad-read-bundle-badindex-")
    await writeFile(join(root, BUNDLE_FILE), '{"arms":[{"armId":"on"}]}')
    const result = await readBundle(root)
    expect("error" in result).toBe(true)
    if (!("error" in result)) throw new Error("unreachable")
    expect(result.error).toContain("arms[0]")
  })
})

describe("finding 3 — AC6 is enforced on an ACTUAL load, not only in a helper test", () => {
  test("duplicate pool ids make the arm unreadable, never a printed count", async () => {
    const root = await bundle(
      [{ armId: "on", repeatId: 0 }],
      [
        {
          armId: "on",
          repeatId: 0,
          findings: {
            pool: [{ id: "f1" }, { id: "f1" }],
            canonicalIds: ["f1"],
            lensInstructions: [],
          },
        },
      ],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(result.comparable).toEqual([])
    expect(result.unreadable[0]!.reason).toContain("two findings with id")
  })

  test("a dangling canonical id makes the arm unreadable", async () => {
    const root = await bundle(
      [{ armId: "on", repeatId: 0 }],
      [
        {
          armId: "on",
          repeatId: 0,
          findings: { pool: [], canonicalIds: ["missing", "missing"], lensInstructions: [] },
        },
      ],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(result.comparable).toEqual([])
    expect(result.unreadable).toHaveLength(1)
  })

  test("a valid arm carries its reconstructed canonical findings on the row", async () => {
    const root = await bundle(
      [{ armId: "on", repeatId: 0 }],
      [
        {
          armId: "on",
          repeatId: 0,
          findings: {
            pool: [{ id: "a" }, { id: "b" }],
            canonicalIds: ["b"],
            lensInstructions: [],
          },
        },
      ],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(result.comparable[0]!.findings.map((finding) => finding.id)).toEqual(["b"])
    // THE SAME OBJECT as its pool entry — the property the whole persisted form exists for.
    expect(result.comparable[0]!.findings[0]).toBe(result.comparable[0]!.manifest.findings.pool[1])
  })
})

describe("finding 5 — the manifest must agree with the slot it was filed under", () => {
  test("one arm's dump copied into another arm's slot is UNREADABLE, not relabelled", async () => {
    const root = await bundle(
      [
        { armId: "control", repeatId: 0 },
        { armId: "pool", repeatId: 0 },
      ],
      [{ armId: "control", repeatId: 0 }],
    )
    const dir = join(root, "pool", "0", "run-pool-0")
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, MANIFEST_FILE),
      JSON.stringify(manifestFor({ armId: "control", repeatId: 0 })),
    )

    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(result.comparable.map((row) => row.armId)).toEqual(["control"])
    expect(result.unreadable).toHaveLength(1)
    expect(result.unreadable[0]!.armId).toBe("pool")
    expect(result.unreadable[0]!.reason).toContain("says it is arm `control`")
  })

  test("a repeat id that disagrees with its slot is unreadable too", async () => {
    const root = await bundle([{ armId: "on", repeatId: 1 }], [])
    const dir = join(root, "on", "1", "run-on-1")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, MANIFEST_FILE), JSON.stringify(manifestFor({ armId: "on", repeatId: 0 })))

    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(result.unreadable[0]!.reason).toContain("repeat 0")
  })
})

describe("finding 7 — AC7 disclosures reach the table", () => {
  test("arms whose DIALS differ say so, and say it is not the intervention", async () => {
    const root = await bundle(
      [
        { armId: "on", repeatId: 0 },
        { armId: "off", repeatId: 0 },
      ],
      [
        { armId: "on", repeatId: 0, threshold: 0.5 },
        { armId: "off", repeatId: 0, threshold: 0.9 },
      ],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    const text = renderBundle(result)
    expect(text).toContain("DIFFER IN MORE THAN THE INTERVENTION")
    expect(text).toContain("threshold 0.9")
  })

  test("equal dials are stated, not left to inference", async () => {
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
    expect(renderBundle(result)).toContain("dials equal across every comparable arm")
  })

  test("ONE REPEAT PRINTS `NOT MEASURED` for the noise floor", async () => {
    const root = await bundle([{ armId: "on", repeatId: 0 }], [{ armId: "on", repeatId: 0 }])
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(renderBundle(result)).toContain("NOISE FLOOR: NOT MEASURED")
  })

  test("two repeats say what the noise floor is for", async () => {
    const root = await bundle(
      [
        { armId: "on", repeatId: 0 },
        { armId: "on", repeatId: 1 },
      ],
      [
        { armId: "on", repeatId: 0 },
        { armId: "on", repeatId: 1 },
      ],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(renderBundle(result)).toContain("compare the spread between repeats")
  })

  test("a degraded arm NAMES its warning codes, not just the word `degraded`", async () => {
    const root = await bundle(
      [{ armId: "on", repeatId: 0 }],
      [
        {
          armId: "on",
          repeatId: 0,
          completion: "degraded",
          warnings: [
            { code: "model-dropped-out", stage: "discover", message: "gone", disclosure: false },
            { code: "provider-fan-out", stage: "roster", message: "sent", disclosure: true },
          ],
        },
      ],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    const text = renderBundle(result)
    expect(text).toContain("DEGRADED — 1 warning(s): model-dropped-out")
    expect(text).toContain("disclosures: provider-fan-out")
  })

  test("budget-skipped slots are named, and the claim stays SCOPED TO THOSE SLOTS", async () => {
    const root = await bundle(
      [{ armId: "on", repeatId: 0 }],
      [{ armId: "on", repeatId: 0, skippedForBudget: ["discovery-3"] }],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    const text = renderBundle(result)
    expect(text).toContain("the BUDGET refused 1 discovery slot(s) (discovery-3)")
    expect(text).toContain("no model is blamed for them")
    // The recheck's finding: this used to claim nothing else reduced the run,
    // which is false beside a drop-out warning or a cancellation.
    expect(text).not.toContain("no model failed and nobody cancelled")
  })

  test("A BUDGET SKIP BESIDE A DROP-OUT AND A CANCELLATION CONTRADICTS NOTHING", async () => {
    const root = await bundle(
      [{ armId: "on", repeatId: 0 }],
      [
        {
          armId: "on",
          repeatId: 0,
          completion: "cancelled",
          skippedForBudget: ["discovery-3"],
          warnings: [
            { code: "model-dropped-out", stage: "discover", message: "gone", disclosure: false },
          ],
        },
      ],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    const text = renderBundle(result)
    expect(text).toContain("DEGRADED — 1 warning(s): model-dropped-out")
    expect(text).toContain("the BUDGET refused 1 discovery slot(s)")
    expect(text).toContain("read the warnings and the completion status beside it")
  })

  test("the report says plainly that it compared no findings", async () => {
    const root = await bundle([{ armId: "on", repeatId: 0 }], [{ armId: "on", repeatId: 0 }])
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(renderBundle(result)).toContain("NO FINDING WAS COMPARED ACROSS ARMS")
  })
})

/**
 * The recheck of `bf78a8a` (2026-09-10). Each test below is a defect the FIXES
 * introduced or left standing — a reviewer found them, this suite did not.
 */
describe("recheck — validation reaches inside the arrays", () => {
  const malformed: [string, unknown][] = [
    ["a junk per-stage row", { spendPerStage: [null] }],
    ["a junk warning", { warnings: [null] }],
  ]

  test("a junk `spend.perStage` row is unreadable, not a crash in the renderer", async () => {
    const root = await bundle(
      [{ armId: "on", repeatId: 0 }],
      [{ armId: "on", repeatId: 0, perStage: [null] }],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(result.unreadable[0]!.reason).toContain("spend.perStage[0]")
  })

  test("a junk `status.warnings` entry is unreadable, not a crash in the disclosures", async () => {
    const root = await bundle(
      [{ armId: "on", repeatId: 0 }],
      [{ armId: "on", repeatId: 0, warnings: [null] }],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(result.unreadable[0]!.reason).toContain("status.warnings[0]")
  })

  test("a `mergedIds` that is not a list is unreadable, not `{} is not iterable`", async () => {
    const root = await bundle(
      [{ armId: "on", repeatId: 0 }],
      [
        {
          armId: "on",
          repeatId: 0,
          findings: { pool: [{ id: "x", mergedIds: {} }], canonicalIds: ["x"], lensInstructions: [] },
        },
      ],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(result.unreadable[0]!.reason).toContain("`mergedIds` is not a list of strings")
  })

  test("AN EMPTY `spend.total` IS UNREADABLE — never a table printing NaN tokens", async () => {
    const root = await bundle(
      [{ armId: "on", repeatId: 0 }],
      [{ armId: "on", repeatId: 0, total: {} }],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(result.comparable).toEqual([])
    expect(result.unreadable[0]!.reason).toContain("`spend.total`")
    expect(renderBundle(result)).not.toContain("NaN")
  })

  test("A `known` CARRYING `null` IS NOT A COMPARISON KEY", async () => {
    const root = await bundle(
      [
        { armId: "on", repeatId: 0 },
        { armId: "off", repeatId: 0 },
      ],
      [
        { armId: "on", repeatId: 0, protocolHash: { kind: "known", value: null } },
        { armId: "off", repeatId: 0, protocolHash: { kind: "known", value: null } },
      ],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(result.comparable).toEqual([])
    expect(result.unreadable).toHaveLength(2)
    for (const row of result.unreadable) {
      expect(row.reason).toContain("not a non-empty string")
    }
  })

  test("a `codeRevision` known value of the wrong shape is malformed", async () => {
    const root = await bundle(
      [{ armId: "on", repeatId: 0 }],
      [{ armId: "on", repeatId: 0, codeRevision: { kind: "known", value: {} } }],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(result.unreadable[0]!.reason).toContain("{ commit: string, dirty: boolean }")
  })

  test("the malformed shapes above are still PER-ARM", async () => {
    const root = await bundle(
      [
        { armId: "on", repeatId: 0 },
        { armId: "off", repeatId: 0 },
      ],
      [
        { armId: "on", repeatId: 0 },
        { armId: "off", repeatId: 0, total: {} },
      ],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(result.comparable.map((row) => row.armId)).toEqual(["on"])
    expect(result.unreadable).toHaveLength(1)
  })

  test("the malformed list is not vacuous — the same shapes minus the defect load fine", async () => {
    for (const [, _shape] of malformed) {
      const root = await bundle([{ armId: "on", repeatId: 0 }], [{ armId: "on", repeatId: 0 }])
      const result = await readBundle(root)
      if ("error" in result) throw new Error(result.error)
      expect(result.comparable).toHaveLength(1)
    }
  })
})

describe("recheck — the noise floor is a PER-ARM fact", () => {
  test("two arms with one observation each are NOT two repeats", async () => {
    const root = await bundle(
      [
        { armId: "control", repeatId: 0 },
        { armId: "pool", repeatId: 1 },
      ],
      [
        { armId: "control", repeatId: 0 },
        { armId: "pool", repeatId: 1 },
      ],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    const text = renderBundle(result)
    expect(text).toContain("OBSERVATIONS PER ARM: control 1, pool 1")
    expect(text).toContain("NOT MEASURED for control, pool")
    expect(text).not.toContain("compare the spread between repeats")
  })

  test("a mixed bundle names which arms have a spread and which do not", async () => {
    const root = await bundle(
      [
        { armId: "on", repeatId: 0 },
        { armId: "on", repeatId: 1 },
        { armId: "off", repeatId: 0 },
      ],
      [
        { armId: "on", repeatId: 0 },
        { armId: "on", repeatId: 1 },
        { armId: "off", repeatId: 0 },
      ],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    const text = renderBundle(result)
    expect(text).toContain("OBSERVATIONS PER ARM: on 2, off 1")
    expect(text).toContain("for on, compare the spread")
    expect(text).toContain("NOT MEASURED for off")
  })
})

describe("recheck — spend shares are dials too", () => {
  test("arms whose SHARES differ are not called equal", async () => {
    const root = await bundle(
      [
        { armId: "on", repeatId: 0 },
        { armId: "off", repeatId: 0 },
      ],
      [
        { armId: "on", repeatId: 0 },
        { armId: "off", repeatId: 0, shares: { discover: 0.6, debate: 0.65, judge: 1 } },
      ],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    const text = renderBundle(result)
    expect(text).toContain("DIFFER IN MORE THAN THE INTERVENTION")
    expect(text).toContain("shares 0.6/0.65/1")
    expect(text).not.toContain("dials equal across every comparable arm")
  })
})

/**
 * NEW-1 from the recheck of `7bf0558`: one run counted as two observations.
 *
 * Accepting a duplicate index entry predates that commit; ASSERTING a within-arm
 * spread from the duplicate rows was new in it, because the observation count
 * became a count of rows. Both ends are guarded now.
 */
describe("a duplicate index slot is a corrupt roster, not a repeated measurement", () => {
  test("the bundle is refused, and the reason names the slot", async () => {
    const root = await bundle(
      [
        { armId: "control", repeatId: 0 },
        { armId: "control", repeatId: 0 },
      ],
      [{ armId: "control", repeatId: 0 }],
    )
    const result = await readBundle(root)
    expect("error" in result).toBe(true)
    if (!("error" in result)) throw new Error("unreachable")
    expect(result.error).toContain("`control/0` more than once")
  })

  test("it is NOT silently deduped — a healthy sibling does not rescue it", async () => {
    const root = await bundle(
      [
        { armId: "control", repeatId: 0 },
        { armId: "control", repeatId: 0 },
        { armId: "pool", repeatId: 0 },
      ],
      [
        { armId: "control", repeatId: 0 },
        { armId: "pool", repeatId: 0 },
      ],
    )
    const result = await readBundle(root)
    expect("error" in result).toBe(true)
  })

  test("the same arm at DIFFERENT repeats is fine — that is what repeats are", async () => {
    const root = await bundle(
      [
        { armId: "control", repeatId: 0 },
        { armId: "control", repeatId: 1 },
      ],
      [
        { armId: "control", repeatId: 0 },
        { armId: "control", repeatId: 1 },
      ],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(renderBundle(result)).toContain("OBSERVATIONS PER ARM: control 2")
  })
})

/**
 * AC5 (story 2.3) — the reader states a usage verdict PER ARM, and validates the
 * widened union before it does.
 *
 * Story 2.2's reader printed one hardcoded paragraph for the whole bundle —
 * *"USAGE COMPLETENESS is `unaudited` for every run in this bundle"* — which was
 * true while `buildManifest` could write nothing else. It is false the moment two
 * arms can disagree, and a paragraph that is false in the interesting case is
 * worse than no paragraph: the interesting case is exactly the one where one
 * arm's token column is short and the other's is not.
 */
describe("AC5 — the usage verdict is per arm, and the union is checked", () => {
  const unknownIn = (executionId: string) => ({
    slot: "discovery-1",
    stage: "discover",
    attempt: 1,
    executionId,
    why: "the host settled the turn and reported no tokens",
  })

  const incomplete = (armId: string, ids: readonly string[]) => ({
    armId,
    repeatId: 0,
    usageCompleteness: "incomplete",
    unknownUsage: ids.map(unknownIn),
    unknownUsageCount: ids.length,
    exposure: "unquantified",
  })

  test("two arms disagreeing on usage each get their OWN sentence", async () => {
    const root = await bundle(
      [
        { armId: "on", repeatId: 0 },
        { armId: "off", repeatId: 0 },
      ],
      [{ armId: "on", repeatId: 0 }, incomplete("off", ["exec-2", "exec-5"])],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    const text = renderBundle(result)

    expect(text).toContain("USAGE COMPLETENESS, PER ARM")
    expect(text).toContain("on repeat 0 — complete")
    expect(text).toContain("off repeat 0 — INCOMPLETE: 2 execution(s)")
    expect(text).toContain("exec-2")
    expect(text).toContain("unquantified")
    // The bundle-wide claim is gone, not reworded.
    expect(text).not.toContain("for every run in this bundle")
  })

  test("an `unaudited` arm is not reported as a clean one", async () => {
    const root = await bundle(
      [{ armId: "on", repeatId: 0 }],
      [{ armId: "on", repeatId: 0, usageCompleteness: "unaudited", exposure: "unquantified" }],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    const text = renderBundle(result)
    expect(text).toContain("on repeat 0 — UNAUDITED")
    expect(text).not.toContain("on repeat 0 — complete")
  })

  test("the tokens column is labelled OBSERVED spend, whatever the verdict", async () => {
    const root = await bundle([{ armId: "on", repeatId: 0 }], [{ armId: "on", repeatId: 0 }])
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    // `evaluation-protocol.md:511-517` — "a missing tag is not evidence of
    // complete usage", so the label is unconditional. A column headed `tokens`
    // only when something is known to be missing teaches a reader to read the
    // unlabelled one as a bill.
    expect(renderBundle(result)).toContain("tokens (observed)")
  })

  test("USAGE COMPLETENESS IS NOT A COMPARABILITY FIELD — it labels, it does not segregate", async () => {
    const root = await bundle(
      [
        { armId: "on", repeatId: 0 },
        { armId: "off", repeatId: 0 },
      ],
      [{ armId: "on", repeatId: 0 }, incomplete("off", ["exec-1"])],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    // The four comparability fields are facts about WHAT WAS REVIEWED; usage
    // completeness is a fact about MAD's own instrumentation. Partitioning on it
    // would split a legitimately paired block in half because one arm's host
    // dropped a `tokens` field, which is the reverse of what segregation is for.
    expect(result.segregated).toEqual([])
    expect(result.comparable).toHaveLength(2)
    expect(result.cohortSize).toBe(2)
  })

  test("a verdict outside the union is UNREADABLE, not printed as a word", async () => {
    const root = await bundle(
      [{ armId: "on", repeatId: 0 }],
      [{ armId: "on", repeatId: 0, usageCompleteness: "probably-fine" }],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    expect(result.comparable).toEqual([])
    expect(result.unreadable[0]!.reason).toContain("spend.usageCompleteness")
  })

  test("the identities, the count and the exposure are checked as hard as the total is", async () => {
    const cases: [string, Partial<Fake>, string][] = [
      ["no identities at all", { unknownUsage: undefined }, "spend.unknownUsage"],
      ["identities that are not a list", { unknownUsage: {} }, "spend.unknownUsage"],
      ["an identity with no `why`", { unknownUsage: [{ ...unknownIn("exec-1"), why: "" }] }, "spend.unknownUsage[0]"],
      ["an identity with no `executionId`", { unknownUsage: [{ slot: "s", stage: "discover", attempt: 1, why: "w" }] }, "spend.unknownUsage[0]"],
      ["a count that is not a number", { unknownUsageCount: "two" }, "spend.unknownUsageCount"],
      ["an exposure outside the union", { exposure: "sort-of" }, "spend.exposure"],
    ]
    for (const [name, over, expected] of cases) {
      const root = await bundle([{ armId: "on", repeatId: 0 }], [{ armId: "on", repeatId: 0, ...over }])
      const result = await readBundle(root)
      if ("error" in result) throw new Error(result.error)
      expect(result.comparable, name).toEqual([])
      expect(result.unreadable[0]!.reason, name).toContain(expected)
    }
  })
})

describe("story 2.5A — the routing policy is the intervention, not a confound", () => {
  const onOff = [
    { armId: "on", repeatId: 0 },
    { armId: "off", repeatId: 0 },
  ]

  test("POLICY ONLY: named as the intervention, and neither 'equal' nor 'more than the intervention'", async () => {
    const root = await bundle(onOff, [
      { armId: "on", repeatId: 0, routingPolicy: "shipped" },
      { armId: "off", repeatId: 0, routingPolicy: "debate-off" },
    ])
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    const text = renderBundle(result)

    expect(text).toContain("ROUTING POLICY DIFFERS, and that is the intervention")
    expect(text).toContain("on/0: routing policy shipped")
    expect(text).toContain("off/0: routing policy debate-off")
    expect(text).toContain("every other dial is the same on every comparable arm")
    expect(text).not.toContain("dials equal across every comparable arm")
    expect(text).not.toContain("DIFFER IN MORE THAN THE INTERVENTION")
  })

  test("POLICY AND CAP: the policy is the intervention, and the cap is STILL a confound", async () => {
    const root = await bundle(onOff, [
      { armId: "on", repeatId: 0, routingPolicy: "shipped" },
      { armId: "off", repeatId: 0, routingPolicy: "debate-off", cap: 500 },
    ])
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    const text = renderBundle(result)

    expect(text).toContain("ROUTING POLICY DIFFERS, and that is the intervention")
    expect(text).toContain("DIFFER IN MORE THAN THE INTERVENTION")
    expect(text).toContain("token cap 500")
    expect(text).not.toContain("dials equal across every comparable arm")
  })

  test("ONE POLICY EVERYWHERE prints exactly what it printed before the field existed", async () => {
    const root = await bundle(onOff, [
      { armId: "on", repeatId: 0 },
      { armId: "off", repeatId: 0 },
    ])
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    const text = renderBundle(result)

    expect(text).toContain("dials equal across every comparable arm")
    expect(text).not.toContain("ROUTING POLICY")
  })

  test("a LEGACY manifest with no policy is read as `shipped`, a compatibility interpretation", async () => {
    const root = await bundle(onOff, [
      { armId: "on", repeatId: 0, routingPolicy: undefined },
      { armId: "off", repeatId: 0, routingPolicy: "shipped" },
    ])
    // `undefined` is dropped by JSON.stringify, so the "on" manifest really has no field.
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)

    expect(result.comparable).toHaveLength(2)
    expect(result.comparable.map((row) => row.manifest.dials.routingPolicy)).toEqual(["shipped", "shipped"])
    expect(renderBundle(result)).toContain("dials equal across every comparable arm")
  })

  test("an UNKNOWN policy is refused, never guessed", async () => {
    const root = await bundle([{ armId: "on", repeatId: 0 }], [{ armId: "on", repeatId: 0, routingPolicy: "debate-lite" }])
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)

    expect(result.comparable).toEqual([])
    expect(result.unreadable[0]!.reason).toContain("dials.routingPolicy")
  })

  test("MIXED POLICIES WITHIN ONE ARM are neither the intervention nor a noise floor", async () => {
    const root = await bundle(
      [
        { armId: "on", repeatId: 0 },
        { armId: "off", repeatId: 0 },
        { armId: "off", repeatId: 1 },
      ],
      [
        { armId: "on", repeatId: 0, routingPolicy: "shipped" },
        { armId: "off", repeatId: 0, routingPolicy: "debate-off" },
        { armId: "off", repeatId: 1, routingPolicy: "shipped" },
      ],
    )
    const result = await readBundle(root)
    if ("error" in result) throw new Error(result.error)
    const text = renderBundle(result)

    expect(text).toContain("ROUTING POLICY IS MIXED WITHIN ARM(S) off")
    expect(text).not.toContain("that is the intervention")
    expect(text).not.toContain("NOISE FLOOR: for off")
  })
})
