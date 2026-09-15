/**
 * The fake bundle `ablation/read-bundle.test.ts` and `ablation/paired-read.test.ts`
 * both read.
 *
 * IT LIVES OUTSIDE BOTH TEST FILES BECAUSE THERE MUST BE ONE OF IT. The paired
 * reader reads the same manifests the bundle reader does, through the same
 * `parseManifest`, and a second hand-rolled builder would drift from this one
 * exactly where it matters: a field the writer adds would be written by one
 * fixture and not the other, and the suite that missed it would keep passing
 * against a manifest MAD no longer produces.
 *
 * Every default here is WHAT `buildManifest` PRODUCES, never a frozen literal
 * that was once true. A test wanting another state asks for it, and a test
 * wanting a field ABSENT — the shape a reader meets on disk from an older
 * writer — passes `undefined`, which `JSON.stringify` drops.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { BUNDLE_FILE, BUNDLE_SCHEMA_VERSION, type BundleArm } from "./bundle.ts"
import { MANIFEST_SCHEMA_VERSION, MANIFEST_FILE, known, unknownValue } from "./manifest.ts"

export interface Fake {
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
  /**
   * Story 2.5A, child 2-5b — `run.forkedFrom` and `spend.origin`.
   *
   * THE DEFAULTS ARE WHAT THE WRITER PRODUCES, for the `usageCompleteness`
   * reason above: `buildManifest` writes both fields on EVERY manifest, so a
   * fixture that omitted them by default would test this reader against a
   * manifest MAD no longer produces, and would route every other case in this
   * file down the pre-2.5b compatibility path. The default is an unforked run —
   * `forkedFrom` unknown, an all-inherited-zero split over `total` — and a test
   * that wants the legacy shape passes `undefined`, which `JSON.stringify`
   * drops.
   */
  forkedFrom?: unknown
  origin?: unknown
  /**
   * Story 2-5c / 2-5d — the `experiment` block that makes a manifest a PAIRED
   * arm. Absent writes the field absent, which is an ordinary arm: absence never
   * qualifies a manifest as paired, so this knob is the only way in.
   */
  experiment?: unknown
  /**
   * Story 2-5d — `status.routeCounts`, which carries the treatment opportunity
   * the paired reader READS rather than re-derives. The default is the
   * `did-not-run` a stage that never ran writes.
   */
  routeCounts?: unknown
  /**
   * Story 2-5d — `run.finishedAt`. It needs a knob because `parseManifest`
   * refuses an `experiment.failure` on a manifest whose run reads as finished:
   * a thrown continuation's record is what the branch HELD when it threw, so its
   * completion is `unfinished` and its finish time is an unknown. Without this
   * the fixture could not write a thrown arm at all, and the reader's handling
   * of one could not be tested.
   */
  finishedAt?: unknown
}

/**
 * The split an UNFORKED run's manifest carries: everything attributed, all of it
 * executed here, nothing inherited.
 *
 * DERIVED FROM THE FAKE'S OWN `total` AND `unknownUsage`, never a frozen literal,
 * because `provenanceProblem` refuses a split that does not conserve against
 * them. A test that overrides either field and says nothing about provenance
 * would otherwise write a manifest that is malformed for a reason it never
 * meant to test. A test writing a malformed `total` still gets the message that
 * names `spend.total`, which is checked first.
 */
export function unforkedOrigin(total: unknown, unknownUsage: unknown): unknown {
  const zero = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  const unknown = Array.isArray(unknownUsage) ? unknownUsage.length : 0
  return {
    attributed: { tokens: total, turns: 1, unknown },
    executedHere: { tokens: total, turns: 1, unknown },
    inherited: { tokens: zero, turns: 0, unknown: 0 },
  }
}

export function manifestFor(fake: Fake): unknown {
  const total = fake.total ?? { input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  const unknownUsage = "unknownUsage" in fake ? fake.unknownUsage : []
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
    run: {
      runId: `run-${fake.armId}-${fake.repeatId}`,
      ...("forkedFrom" in fake
        ? { forkedFrom: fake.forkedFrom }
        : { forkedFrom: unknownValue("the run was not forked") }),
      startedAt: "2026-09-10T00:00:00.000Z",
      finishedAt: "finishedAt" in fake ? fake.finishedAt : known("2026-09-10T00:01:00.000Z"),
    },
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
      total,
      // `in` RATHER THAN `??`, for these four only. A test that wants to write a
      // manifest with the field ABSENT — the pre-2.3 shape a reader will meet on
      // disk — passes `undefined`, which `JSON.stringify` drops; `??` would
      // silently substitute the healthy default and the test would pin nothing.
      usageCompleteness: "usageCompleteness" in fake ? fake.usageCompleteness : "complete",
      unknownUsage,
      unknownUsageCount: "unknownUsageCount" in fake ? fake.unknownUsageCount : 0,
      exposure: "exposure" in fake ? fake.exposure : "quantified",
      ...("origin" in fake ? { origin: fake.origin } : { origin: unforkedOrigin(total, unknownUsage) }),
    },
    status: {
      completion: fake.completion ?? "completed",
      cancelledAt: unknownValue("the run was never cancelled"),
      warnings: fake.warnings ?? [],
      routeCounts: "routeCounts" in fake ? fake.routeCounts : { kind: "did-not-run" },
      debateCounts: { kind: "did-not-run" },
      judgeCounts: { kind: "did-not-run" },
    },
    findings: fake.findings ?? { pool: [], canonicalIds: [], lensInstructions: [] },
    stageOutputs: { recordFile: "record.json", turnFiles: known(2) },
    ...("experiment" in fake ? { experiment: fake.experiment } : {}),
  }
}

/** Write `bundle.json` and one manifest per fake under an existing root. */
export async function writeBundle(
  root: string,
  arms: readonly BundleArm[],
  written: readonly Fake[],
): Promise<string> {
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
