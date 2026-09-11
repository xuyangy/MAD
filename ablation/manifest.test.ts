import { describe, expect, test } from "bun:test"

import { CUMULATIVE_SHARE } from "../core/budget/presets.ts"
import type { Finding } from "../core/domain/finding.ts"
import type { RunRecord } from "../core/domain/run-record.ts"
import { emptyTokenUsage } from "../core/domain/run-record.ts"
import type { ChangeSet } from "../core/ports/repo.ts"
import {
  MANIFEST_FILE,
  MANIFEST_SCHEMA_VERSION,
  buildManifest,
  fromPersistedFindings,
  known,
  toPersistedFindings,
  unknownValue,
  type EvaluationIdentity,
  type UsageCompleteness,
} from "./manifest.ts"

function finding(id: string, over: Partial<Finding> = {}): Finding {
  return {
    id,
    claim: `claim ${id}`,
    reasoning: `reasoning ${id}`,
    locus: { file: "src/a.ts", startLine: 1, endLine: 2 },
    severity: "medium",
    author: "discovery-1",
    source: "pool",
    history: [],
    ...over,
  } as Finding
}

function record(over: Partial<RunRecord> = {}): RunRecord {
  const canonical = finding("f1", { clusterId: "c1", mergedIds: ["f2"] })
  const absorbed = finding("f2")
  return {
    runId: "run-0001",
    startedAt: "2026-09-10T00:00:00.000Z",
    finishedAt: "2026-09-10T00:01:00.000Z",
    roster: {
      slots: [
        {
          slot: "discovery-1",
          providerId: "anthropic",
          modelId: "claude-sonnet-4-5",
          identity: "claude-sonnet-4",
          lineage: { family: "claude", verified: true } as never,
          toolcall: true,
          alsoAvailableVia: [],
        },
      ],
      lensSlots: [],
      requested: 3,
      distinctLineages: 1,
      providers: ["anthropic"],
    },
    answered: 1,
    findings: [canonical],
    pool: [canonical, absorbed],
    lensInstructions: [],
    threshold: 0.5,
    maxRounds: 2,
    warnings: [],
    ledger: {
      entries: [
        { slot: "discovery-1", stage: "discover", attempt: 1, tokens: { ...emptyTokenUsage(), input: 10, output: 20 } },
      ],
      total: { ...emptyTokenUsage(), input: 10, output: 20 },
      cap: 1000,
      maxConcurrency: 4,
      shares: CUMULATIVE_SHARE,
      // Story 2.3 — REQUIRED FIELDS, WRITTEN OUT even though the `as RunRecord`
      // assertion at the bottom of this builder would have let them be omitted
      // silently. This fixture is what `buildManifest` reads, and a ledger whose
      // `unknownUsage` is `undefined` at run time is a fixture that would make
      // an audit verdict of "complete" pass for the wrong reason.
      unknownUsage: [],
      stopOnUnknownUsage: false,
    },
    ...over,
  } as RunRecord
}

const change: ChangeSet = {
  description: "HEAD~1..HEAD",
  files: ["src/a.ts"],
  diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new\n",
}

const identity: EvaluationIdentity = {
  protocolVersion: known(1),
  protocolHash: known("sha256:aaa"),
  fixtureVersion: unknownValue("--fixture-version was not given"),
  fixtureHash: unknownValue("--fixture-hash was not given"),
  codeRevision: known({ commit: "13eadc6", dirty: false }),
  armId: "on",
  repeatId: 0,
}

describe("the manifest is versioned and named", () => {
  test("schema version and filename are constants the reader can rely on", () => {
    expect(MANIFEST_SCHEMA_VERSION).toBe(1)
    expect(MANIFEST_FILE).toBe("manifest.json")
  })
})

describe("AC1 — every field group FR1 names is present", () => {
  const manifest = buildManifest({ record: record(), change, identity, turnFiles: known(3) })

  test("code revision, protocol and fixture versions, arm and repeat id", () => {
    expect(manifest.identity.codeRevision).toEqual(known({ commit: "13eadc6", dirty: false }))
    expect(manifest.identity.protocolVersion).toEqual(known(1))
    expect(manifest.identity.fixtureVersion.kind).toBe("unknown")
    expect(manifest.identity.armId).toBe("on")
    expect(manifest.identity.repeatId).toBe(0)
  })

  test("the change carries BOTH the base/target identifier and a content hash", () => {
    expect(manifest.identity.changeId.description).toBe("HEAD~1..HEAD")
    expect(manifest.identity.changeId.diffHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(manifest.identity.changeId.files).toEqual(["src/a.ts"])
  })

  test("every slot's resolved provider and model identity", () => {
    expect(manifest.roster.slots[0]).toMatchObject({
      slot: "discovery-1",
      providerId: "anthropic",
      modelId: "claude-sonnet-4-5",
    })
  })

  test("the roster degradation state", () => {
    expect(manifest.roster.requested).toBe(3)
    expect(manifest.roster.filled).toBe(1)
    expect(manifest.roster.answered).toBe(1)
    expect(manifest.roster.distinctLineages).toBe(1)
    expect(manifest.roster.skippedForBudget).toEqual([])
  })

  test("every dial in force, as the RECORD stamped it", () => {
    expect(manifest.dials).toMatchObject({
      threshold: 0.5,
      maxRounds: 2,
      maxConcurrency: 4,
      cap: 1000,
    })
    expect(manifest.dials.shares).toEqual(CUMULATIVE_SHARE)
    expect(manifest.dials.preset.kind).toBe("unknown")
  })

  test("per-stage token spend against its ceiling", () => {
    expect(manifest.spend.perStage.map((row) => row.stage)).toEqual(["discover", "debate", "judge"])
    expect(manifest.spend.perStage[0]).toMatchObject({ spent: 30, ceiling: 300 })
    expect(manifest.spend.total).toMatchObject({ input: 10, output: 20 })
  })

  test("the run's completion status", () => {
    expect(manifest.status.completion).toBe("completed")
    expect(manifest.status.cancelledAt.kind).toBe("unknown")
  })

  test("the raw stage outputs are pointed at, not duplicated", () => {
    expect(manifest.stageOutputs.recordFile).toBe("record.json")
    expect(manifest.stageOutputs.turnFiles).toEqual(known(3))
  })
})

describe("AC4 — nothing is inferred; an unknown says so", () => {
  test("a preset the caller never named is an explicit unknown, not `normal`", () => {
    const manifest = buildManifest({ record: record(), change, identity, turnFiles: known(0) })
    expect(manifest.dials.preset).toEqual(unknownValue("the caller named no preset"))
  })

  test("a run with no finishedAt is unfinished, never back-dated", () => {
    const manifest = buildManifest({
      record: record({ finishedAt: undefined }),
      change,
      identity,
      turnFiles: known(0),
    })
    expect(manifest.run.finishedAt.kind).toBe("unknown")
    expect(manifest.status.completion).toBe("unfinished")
  })

  test("a stage that never ran is `did-not-run`, never all-zero counts", () => {
    const manifest = buildManifest({ record: record(), change, identity, turnFiles: known(0) })
    expect(manifest.status.routeCounts).toEqual({ kind: "did-not-run" })
    expect(manifest.status.debateCounts).toEqual({ kind: "did-not-run" })
    expect(manifest.status.judgeCounts).toEqual({ kind: "did-not-run" })
  })

  test("a stage that ran carries its own counts", () => {
    const counts = { toDebate: 1, toJudge: 2, toJudgeAtThreshold: 2, toJudgeNoPrior: 0 }
    const manifest = buildManifest({
      record: record({ routeCounts: counts }),
      change,
      identity,
      turnFiles: known(0),
    })
    expect(manifest.status.routeCounts).toEqual({ kind: "ran", counts })
  })

  test("a cancelled run names the stage it stopped at, and reads `cancelled`", () => {
    const manifest = buildManifest({
      record: record({ cancelled: { stage: "debate" } }),
      change,
      identity,
      turnFiles: known(0),
    })
    expect(manifest.status.completion).toBe("cancelled")
    expect(manifest.status.cancelledAt).toEqual(known("debate"))
  })

  test("a degradation warning makes the run `degraded`; a disclosure does not", () => {
    const degraded = buildManifest({
      record: record({
        warnings: [{ code: "model-dropped-out", stage: "discover", message: "a model dropped out" }],
      }),
      change,
      identity,
      turnFiles: known(0),
    })
    expect(degraded.status.completion).toBe("degraded")
    expect(degraded.status.warnings[0]).toMatchObject({ code: "model-dropped-out", disclosure: false })

    const disclosed = buildManifest({
      record: record({
        warnings: [{ code: "provider-fan-out", stage: "roster", message: "code goes to anthropic" }],
      }),
      change,
      identity,
      turnFiles: known(0),
    })
    expect(disclosed.status.completion).toBe("completed")
    expect(disclosed.status.warnings[0]).toMatchObject({ code: "provider-fan-out", disclosure: true })
  })
})

/**
 * AC5 (story 2.3) — THIS BLOCK IS A DELIBERATE REWRITE, and the three tests it
 * replaces were right when they were written.
 *
 * Story 2.2 shipped `UsageCompleteness = "unaudited"` and pinned exactly that:
 * the only value was `unaudited`, no run shape could produce another, and a
 * `@ts-expect-error` asserted that `"complete"` did not even type-check. Those
 * tests were pinning the absence of a mechanism, which is what 2.2 had. Story
 * 2.3 built the mechanism (`core/budget/ledger.ts`'s `usageIsComplete` over
 * `TokenLedger.unknownUsage`), so the assertions that said "MAD cannot answer
 * this" now pin a lie rather than guard against one. They are rewritten to pin
 * the three answers instead, and the type-level guard is kept — pointed at a
 * value outside the widened union rather than deleted, because a union that
 * accepts anything is not a guard.
 */
describe("AC5 — usage completeness is an audit verdict, not a placeholder", () => {
  test("a ledger holding no unknown reads `complete`, and its exposure is quantified", () => {
    const manifest = buildManifest({ record: record(), change, identity, turnFiles: known(0) })
    expect(manifest.spend.usageCompleteness).toBe("complete")
    expect(manifest.spend.unknownUsage).toEqual([])
    expect(manifest.spend.unknownUsageCount).toBe(0)
    expect(manifest.spend.exposure).toBe("quantified")
  })

  test("an unknown execution reads `incomplete`, and its identity and count ride beside it", () => {
    const unknown = {
      slot: "discovery-2",
      stage: "discover",
      attempt: 1,
      executionId: "exec-7",
      why: "the host settled the turn and reported no tokens",
    }
    const manifest = buildManifest({
      record: record({ ledger: { ...record().ledger, unknownUsage: [unknown] } }),
      change,
      identity,
      turnFiles: known(0),
    })
    expect(manifest.spend.usageCompleteness).toBe("incomplete")
    expect(manifest.spend.unknownUsage).toEqual([unknown])
    expect(manifest.spend.unknownUsageCount).toBe(1)
    // `evaluation-protocol.md:337-338` — the label is the protocol's word, and
    // the observed total is still written beside it rather than suppressed.
    expect(manifest.spend.exposure).toBe("unquantified")
    expect(manifest.spend.total).toEqual({ ...emptyTokenUsage(), input: 10, output: 20 })
  })

  test("no run shape talks the verdict out of `incomplete` while an unknown stands", () => {
    const withUnknown = {
      ...record().ledger,
      unknownUsage: [
        { slot: "discovery-1", stage: "judge", attempt: 2, executionId: "exec-1", why: "cancelled in flight" },
      ],
    }
    const shapes: Partial<RunRecord>[] = [
      { ledger: withUnknown },
      { ledger: withUnknown, finishedAt: undefined },
      { ledger: withUnknown, cancelled: { stage: "judge" } },
      {
        ledger: withUnknown,
        warnings: [{ code: "model-dropped-out", stage: "discover", message: "dropped" }],
      },
      { ledger: { ...withUnknown, cap: null } },
    ]
    for (const shape of shapes) {
      const manifest = buildManifest({ record: record(shape), change, identity, turnFiles: known(0) })
      expect(manifest.spend.usageCompleteness).toBe("incomplete")
      expect(manifest.spend.exposure).toBe("unquantified")
    }
  })

  test("a record carrying NO unknown-usage collection reads `unaudited` — absent is not none", () => {
    // The pre-2.3 ledger shape, which `RunRecord`'s type no longer permits and a
    // JSON file on disk or a JavaScript caller can still hand over. An audit that
    // never ran must not read as an audit that found nothing: that is the same
    // absent/none collapse `TokenLedger.unknownUsage` is required in order to
    // prevent, one layer out.
    const legacy = { ...record().ledger } as Record<string, unknown>
    delete legacy.unknownUsage
    const manifest = buildManifest({
      record: record({ ledger: legacy as never }),
      change,
      identity,
      turnFiles: known(0),
    })
    expect(manifest.spend.usageCompleteness).toBe("unaudited")
    expect(manifest.spend.unknownUsage).toEqual([])
    expect(manifest.spend.unknownUsageCount).toBe(0)
    // NOT `quantified`. An empty identity list under an `unaudited` verdict is
    // "no audit produced one", never "there were none".
    expect(manifest.spend.exposure).toBe("unquantified")
  })

  test("the union is still the guard: a value outside the three is not assignable", () => {
    const audited: UsageCompleteness = "complete"
    expect(String(audited)).toBe("complete")
    // @ts-expect-error — AC5. The union widened to three named verdicts and no
    // further. A fourth spelling reaching this field would be a reader branching
    // on a word nobody decided the meaning of.
    const invented: UsageCompleteness = "probably-fine"
    expect(String(invented)).toBe("probably-fine")
  })
})

describe("the manifest is the identity a reader compares on", () => {
  test("two builds over the same inputs are byte-identical", () => {
    const a = JSON.stringify(buildManifest({ record: record(), change, identity, turnFiles: known(1) }))
    const b = JSON.stringify(buildManifest({ record: record(), change, identity, turnFiles: known(1) }))
    expect(a).toBe(b)
  })

  test("a different diff is a different hash", () => {
    const a = buildManifest({ record: record(), change, identity, turnFiles: known(1) })
    const b = buildManifest({
      record: record(),
      change: { ...change, diff: `${change.diff}+one more line\n` },
      identity,
      turnFiles: known(1),
    })
    expect(a.identity.changeId.diffHash).not.toBe(b.identity.changeId.diffHash)
  })
})

describe("AC6 — the persisted finding form round-trips", () => {
  test("the pool is the union and canonicalIds is the ordered canonical subset", () => {
    const persisted = toPersistedFindings(record())
    expect(persisted.pool).toHaveLength(2)
    expect(persisted.canonicalIds).toEqual(["f1"])
  })

  test("reconstructed findings are THE SAME OBJECTS as their pool entries", () => {
    const persisted = JSON.parse(JSON.stringify(toPersistedFindings(record())))
    const back = fromPersistedFindings(persisted)
    if (!back.ok) throw new Error(back.reason)
    expect(back.findings[0]).toBe(back.pool[0])
  })

  test("canonical order is preserved and never re-derived", () => {
    const a = finding("a", { clusterId: "c" })
    const b = finding("b", { clusterId: "c" })
    const c = finding("c")
    const back = fromPersistedFindings({ pool: [c, b, a], canonicalIds: ["b", "a"] })
    if (!back.ok) throw new Error(back.reason)
    expect(back.findings.map((f) => f.id)).toEqual(["b", "a"])
  })

  test("a canonical finding does NOT alias its absorbed members", () => {
    const persisted = JSON.parse(JSON.stringify(toPersistedFindings(record())))
    const back = fromPersistedFindings(persisted)
    if (!back.ok) throw new Error(back.reason)
    expect(back.findings[0]!.mergedIds).toEqual(["f2"])
    expect(back.findings).not.toContain(back.pool[1])
  })

  test("duplicate pool ids are refused rather than silently deduped", () => {
    const back = fromPersistedFindings({ pool: [finding("x"), finding("x")], canonicalIds: ["x"] })
    expect(back.ok).toBe(false)
  })

  test("a dangling canonical id is refused", () => {
    const back = fromPersistedFindings({ pool: [finding("x")], canonicalIds: ["y"] })
    expect(back.ok).toBe(false)
  })

  test("a repeated canonical id is refused", () => {
    const back = fromPersistedFindings({ pool: [finding("x")], canonicalIds: ["x", "x"] })
    expect(back.ok).toBe(false)
  })

  test("a dangling membership reference is refused", () => {
    const back = fromPersistedFindings({
      pool: [finding("x", { mergedIds: ["gone"] })],
      canonicalIds: ["x"],
    })
    expect(back.ok).toBe(false)
  })
})

describe("story 2.5A — the routing policy is a dial the manifest always states", () => {
  test("an ordinary record, which carries no policy, is written as `shipped`", () => {
    const manifest = buildManifest({ record: record(), change, identity, turnFiles: known(3) })
    expect(manifest.dials.routingPolicy).toBe("shipped")
  })

  test("a debate-off record is written as `debate-off`", () => {
    const manifest = buildManifest({
      record: record({ routingPolicy: "debate-off" }),
      change,
      identity,
      turnFiles: known(3),
    })
    expect(manifest.dials.routingPolicy).toBe("debate-off")
  })
})
