/**
 * CAP-1's success criterion, asserted rather than described.
 *
 * "A run over a change with known seeded bugs produces a pooled finding set
 * whose recall exceeds that of any single participating model's own list."
 *
 * The run is a real `review()` over the real pipeline seam; only the model turns
 * are scripted, standing in for three models with different blind spots (see
 * `change.ts` on what CI can prove). Every arm is scored against the same defect
 * set, so nothing is divided: `found` is directly comparable.
 */

import { describe, expect, test } from "bun:test"

import { LENSES, LENS_SCRIPTS, REFUND, SCRIPTS, seededArm } from "./arms.ts"
import {
  lensRecallGain,
  missedDefects,
  pooledRecallBeatsBestMember,
  recall,
  recallByAuthor,
} from "../recall.ts"
import { SEEDED_CHANGE, SEEDED_DEFECTS } from "./change.ts"


/**
 * Post-change line numbering for every file in a unified diff, so the defect
 * loci can be checked against the fixture's own text rather than trusted.
 */
function postChangeLines(diff: string): Map<string, Map<number, string>> {
  const files = new Map<string, Map<number, string>>()
  let current: Map<number, string> | undefined
  let lineNo = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) continue
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//, "")
      current = files.get(path) ?? new Map<number, string>()
      files.set(path, current)
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      lineNo = Number(hunk[1]) - 1
      continue
    }
    if (!current) continue
    if (line.startsWith("-")) continue
    lineNo += 1
    current.set(lineNo, line.slice(1))
  }
  return files
}

describe("the fixture is self-consistent — loci checked against the diff text", () => {
  // Without this, nothing tied SEEDED_DEFECTS' line numbers to SEEDED_CHANGE.
  // The scripted findings hardcode the same numbers as the defects, so editing
  // the diff and forgetting the loci left the suite green while the fixture
  // rotted for the live-provider check it exists to support.
  const byFile = postChangeLines(SEEDED_CHANGE.diff)

  test("every defect names a file the change actually touches", () => {
    for (const defect of SEEDED_DEFECTS) {
      expect(SEEDED_CHANGE.files).toContain(defect.locus.file)
      expect(byFile.has(defect.locus.file)).toBe(true)
    }
  })

  test("every cited line exists in the post-change file", () => {
    for (const defect of SEEDED_DEFECTS) {
      const lines = byFile.get(defect.locus.file)!
      const start = defect.locus.startLine
      if (start === undefined) continue
      const end = defect.locus.endLine ?? start
      expect(end).toBeGreaterThanOrEqual(start)
      for (let n = start; n <= end; n += 1) {
        expect(lines.has(n)).toBe(true)
      }
      // A locus pointing at nothing but blank lines is drift, not a defect.
      const cited = Array.from({ length: end - start + 1 }, (_, i) => lines.get(start + i) ?? "")
      expect(cited.join("").trim().length).toBeGreaterThan(0)
    }
  })

  test("the loci still land on the statements they were written for", () => {
    // A handful of anchors, so a shifted hunk is caught by content and not only
    // by line count. These are code substrings, not finding markers.
    const anchors: Record<string, string> = {
      "sql-injection": "order_id = '${req.orderId}'",
      "unchecked-idempotency-key": "refund_keys",
      "money-as-float": "req.amountCents / 100",
      "missing-await-ledger-write": "appendLedgerEntry(conn, {",
      "unreleased-connection": "db.acquire()",
      "swallowed-refund-failure": "refundOrderSafely",
      "ledger-diverges-on-insert-failure": "balances.set(",
    }
    for (const [id, anchor] of Object.entries(anchors)) {
      const defect = SEEDED_DEFECTS.find((d) => d.id === id)
      expect(defect, `no seeded defect with id ${id}`).toBeDefined()
      const lines = byFile.get(defect!.locus.file)!
      const start = defect!.locus.startLine!
      const end = defect!.locus.endLine ?? start
      const text = Array.from({ length: end - start + 1 }, (_, i) => lines.get(start + i) ?? "").join("\n")
      expect(text).toContain(anchor)
    }
  })
})

describe("CAP-1 — pooled recall over the seeded-defect change", () => {
  test("the fixture is what it claims: at least 6 defects, all uniquely identified", () => {
    expect(SEEDED_DEFECTS.length).toBeGreaterThanOrEqual(6)
    // Every defect is labelled with a dimension, and it labels the PLANTED BUG.
    // Story 2A extends this by adding rows.
    expect(SEEDED_DEFECTS.every((d) => d.dimension.length > 0)).toBe(true)
    expect(new Set(SEEDED_DEFECTS.map((d) => d.id)).size).toBe(SEEDED_DEFECTS.length)
  })

  test("POOLED RECALL STRICTLY EXCEEDS EVERY SINGLE MEMBER'S — CAP-1", async () => {
    const { record } = await seededArm({ slots: 3 })
    expect(record.answered).toBe(3)

    // The roster answered in full (asserted above), so every filled slot is a
    // participating arm — passed explicitly so an arm that raised nothing would
    // still appear rather than vanishing from the comparison.
    const answered = record.roster.slots.map((slot) => slot.slot)
    const comparison = pooledRecallBeatsBestMember(SEEDED_DEFECTS, record.pool, undefined, answered)

    expect(comparison.beats).toBe(true)
    expect(comparison.members).toHaveLength(3)
    for (const member of comparison.members) {
      expect(comparison.pooled.found).toBeGreaterThan(member.recall.found)
      // Same defect set for every arm, so the denominator never moves and the
      // comparison needs no division (spine, Dates & numbers).
      expect(member.recall.total).toBe(comparison.pooled.total)
    }

    // DERIVED, not pinned. `change.ts` promises story 2A extends this set by
    // ADDING ROWS; a hardcoded `{found: 7}` and `[3, 3, 3]` would fail on the
    // first added row with a number that says nothing about what regressed. The
    // properties below are what the fixture actually guarantees, and they hold
    // at any size.
    expect(comparison.pooled.total).toBe(SEEDED_DEFECTS.length)
    expect(comparison.pooled.found).toBe(
      SEEDED_DEFECTS.length - missedDefects(SEEDED_DEFECTS, record.pool).length,
    )
    // No arm is silent, and no arm alone reaches the pool — which is the shape
    // that makes the strict inequality above mean "heterogeneity paid", rather
    // than "one model happened to carry the run".
    for (const member of comparison.members) {
      expect(member.recall.found).toBeGreaterThan(0)
      expect(member.recall.found).toBeLessThan(comparison.pooled.found)
    }
    // Every model that answered is represented as an arm, including any that
    // raised nothing — CAP-1's criterion is over every PARTICIPATING model.
    expect(comparison.members).toHaveLength(record.answered)

    // REPORTED, NOT ASSERTED (AC #6, and the spine's "re-run and report" rule for
    // any story that moves what a model is shown). The assertions above are
    // properties that hold at any fixture size; this line is the NUMBER a story
    // quotes when it has to show the baseline did not move. Printed the way
    // `scripts/clustering-rates.ts` prints its two rates, and for the same reason
    // — a number nobody can see is a number nobody can check.
    console.log(
      `CAP-1 pooled recall = ${comparison.pooled.found}/${comparison.pooled.total} ` +
        `(best single member: ${Math.max(...comparison.members.map((m) => m.recall.found))}/` +
        `${comparison.pooled.total})`,
    )
  })

  test("nobody finds everything — the unfound defects are still counted against the pool", async () => {
    const { record } = await seededArm({ slots: 3 })
    const pooled = recall(SEEDED_DEFECTS, record.pool)

    expect(pooled.found).toBeLessThan(pooled.total)

    const missed = missedDefects(SEEDED_DEFECTS, record.pool).map((d) => d.id)
    // The deliberately unfindable one, planted so a perfect score is not on
    // offer and a harness bug crediting everything to everyone shows up as
    // `found === total`.
    expect(missed).toContain("unchecked-idempotency-key")
    // Story 2A: the rest of what this unlensed pool misses is the third file,
    // which the scripts above are blind to by construction. Derived from the
    // fixture rather than pinned as a list, because `change.ts` promises the set
    // extends by adding rows and story 9 reuses it.
    const notice = SEEDED_DEFECTS.filter((d) => d.locus.file === "src/billing/refund-notice.ts")
    expect(notice.length).toBeGreaterThan(0)
    for (const defect of notice) expect(missed).toContain(defect.id)
    expect(missed).toHaveLength(1 + notice.length)
  })

  test("CLUSTERING DID NOT MOVE CAP-1's NUMBER — the pool is discovery's set, untouched", async () => {
    // AD-8 in one assertion. This harness reads `claim`, `reasoning`, `locus`,
    // `author`, `source` and `severity`; clustering writes `clusterId`,
    // `coDiscovery`, `mergedIds` and `clusterSeverity` and nothing else. So
    // measuring `record.pool` AFTER clustering measures exactly the set story 2
    // measured, and the numbers below cannot have moved. Assert it rather than
    // reason it: a stage that started rewriting a claim would degrade CAP-1
    // silently, which is the one failure mode this measurement cannot survive.
    const { record } = await seededArm({ slots: 3, lenses: LENSES })

    expect(record.pool.length).toBeGreaterThan(0)
    for (const finding of record.pool) {
      expect(typeof finding.claim).toBe("string")
      expect(finding.severity).toBeDefined()
      // A merge entry is APPENDED (AD-7); discovery's own entry is still first.
      expect(finding.history[0]!.stage).toBe("discover")
    }

    // And the pool is strictly larger than the canonical set here, so the choice
    // of set is load-bearing rather than an academic distinction.
    expect(record.pool.length).toBeGreaterThan(record.findings.length)

    // Every arm is still derivable from `author` over the pool, which is what
    // would break first if a merged member had been dropped.
    const authors = new Set(record.pool.filter((f) => f.source === "pool").map((f) => f.author))
    expect([...authors].sort()).toEqual(["discovery-1", "discovery-2", "discovery-3"])
  })

  test("the seeded set spans several dimensions — CAP-11 has something to measure over", () => {
    // CAP-11's criterion is "seeded defects spanning several dimensions". One
    // dimension would make a lensed pass and an unlensed one measure the same
    // thing, and the recall gain would be noise.
    const dimensions = new Set(SEEDED_DEFECTS.map((d) => d.dimension))
    expect(dimensions.size).toBeGreaterThanOrEqual(6)
    for (const required of ["performance", "maintainability", "tests", "privacy-a11y"]) {
      expect([...dimensions]).toContain(required)
    }
  })

  test("per-model recall is derivable from `author` alone", async () => {
    const { record } = await seededArm({ slots: 3 })

    // Partition on nothing but `author` — the field discovery writes (AD-8) —
    // and the arms fall out of one pooled run rather than needing N runs.
    const authors = [...new Set(record.pool.map((f) => f.author))]
    expect(authors).toEqual(["discovery-1", "discovery-2", "discovery-3"])

    const byHand = authors
      .map((author) => ({
        author,
        recall: recall(
          SEEDED_DEFECTS,
          record.pool.filter((finding) => finding.author === author),
        ),
      }))
      .sort((a, b) => a.author.localeCompare(b.author))

    expect(recallByAuthor(SEEDED_DEFECTS, record.pool)).toEqual(byHand)
  })

  test("a false positive is not recall", async () => {
    const { record } = await seededArm({ slots: 3 })
    const shapeFinding = record.pool.find((f) => f.claim.includes("RefundResult.refundId"))
    expect(shapeFinding).toBeDefined()
    expect(recall(SEEDED_DEFECTS, [shapeFinding!])).toEqual({
      found: 0,
      total: SEEDED_DEFECTS.length,
    })
  })

  test("an injected matcher replaces the lexical default (AD-14's shape)", async () => {
    const { record } = await seededArm({ slots: 3 })
    // A matcher that agrees with nothing proves the default is not hard-wired.
    expect(recall(SEEDED_DEFECTS, record.pool, () => false).found).toBe(0)
    expect(pooledRecallBeatsBestMember(SEEDED_DEFECTS, record.pool, () => false).beats).toBe(
      false,
    )
  })

  test("a lensed run leaves CAP-1's own numbers exactly where they were", async () => {
    // The two capabilities are measured separately (AD-9's two-numbers rule).
    // `pooledRecallBeatsBestMember` partitions on `source`, so turning lenses on
    // must not move CAP-1's comparison by a single count in either direction.
    const answered = ["discovery-1", "discovery-2", "discovery-3"]
    const unlensed = await seededArm({ slots: 3 })
    const lensed = await seededArm({ slots: 3, lenses: LENSES })

    const a = pooledRecallBeatsBestMember(SEEDED_DEFECTS, unlensed.record.pool, undefined, answered)
    const b = pooledRecallBeatsBestMember(SEEDED_DEFECTS, lensed.record.pool, undefined, answered)

    expect(b.pooled).toEqual(a.pooled)
    expect(b.members).toEqual(a.members)
    expect(b.beats).toBe(true)
    // The lens arms are not extra pool arms — the assertion `recall.test.ts`
    // relies on, and the one an inflated `answered` would break first.
    expect(b.members).toHaveLength(lensed.record.answered)
    expect(lensed.record.answered).toBe(3)
  })

  test("the run this is measured over is a clean, undegraded 3-model run", async () => {
    const { record, rendered } = await seededArm({ slots: 3 })

    // No drop-out, no reduced denominator, no single-lineage warning: the recall
    // number is not standing on a degraded run (AD-6).
    expect(record.warnings.map((w) => w.code)).toEqual(["provider-fan-out"])
    // AD-6a — one denominator, and it is who answered. Every CANONICAL pool
    // finding carries the pair...
    expect(record.findings.every((f) => f.coDiscovery?.answered === 3)).toBe(true)
    // ...and across the whole pool no OTHER denominator appears anywhere. An
    // absorbed member carries no pair of its own — clustering writes it on the
    // canonical (AD-8) — so absence here is correct and a second denominator
    // would not be.
    expect(
      record.pool.every((f) => f.coDiscovery === undefined || f.coDiscovery.answered === 3),
    ).toBe(true)
    expect(rendered).toContain("co-discovery: 1/3")
    // Clustering has run, so the union notice is gone and every finding —
    // canonical and absorbed alike — carries a clusterId (AD-14 amended 2).
    expect(rendered).not.toContain("POOL — NOT YET MERGED")
    expect(record.pool.every((f) => f.clusterId !== undefined)).toBe(true)
  })
})

describe("CAP-11 — a lensed pass over the same change", () => {
  test("A LENSED PASS SURFACES A DEFECT NO UNLENSED POOL MEMBER RAISED — CAP-11", async () => {
    // CAP-11's success criterion, asserted rather than described. Everything
    // below is derived from `SEEDED_DEFECTS` and `Finding.source`; nothing is a
    // hardcoded count, because `change.ts` promises this set extends by adding
    // rows and story 9's third arm reuses the same harness.
    const { record } = await seededArm({ slots: 3, lenses: LENSES })
    const gain = lensRecallGain(SEEDED_DEFECTS, record.pool)

    expect(gain.beats).toBe(true)
    expect(gain.lensOnlyDefects.length).toBeGreaterThan(0)
    // Additive: the lens arm adds coverage on top of the pool and takes none
    // away, so the combined count strictly exceeds the pool's alone.
    expect(gain.combined.found).toBeGreaterThan(gain.pool.found)
    expect(gain.combined.found).toBe(gain.pool.found + gain.lensOnlyDefects.length)
    // Same defect set on every arm, so the four counts compare without division.
    expect(gain.pool.total).toBe(SEEDED_DEFECTS.length)
    expect(gain.lens.total).toBe(SEEDED_DEFECTS.length)
  })

  test("a lens finding the pool already raised is NOT counted as a gain", async () => {
    // `discovery-lens-security` re-finds the SQL injection two pool arms raised.
    // A gain number that counted it would be measuring duplication.
    const { record } = await seededArm({ slots: 3, lenses: LENSES })
    const gain = lensRecallGain(SEEDED_DEFECTS, record.pool)

    const lensFindings = record.pool.filter((f) => f.source === "lens")
    expect(lensFindings.some((f) => f.claim.includes("interpolates the order id"))).toBe(true)
    expect(gain.lensOnlyDefects.map((d) => d.id)).not.toContain("sql-injection")
    // ...and the lens arm's own recall DOES include it, so the exclusion above
    // is the comparison's doing rather than the matcher failing to see it.
    expect(gain.lens.found).toBeGreaterThan(gain.lensOnlyDefects.length)
  })

  test("with no lenses there is no gain, and the fresh-install numbers are untouched", async () => {
    // AD-3 / AD-15 amended — the default path. Not "a small gain": none, and no
    // lens finding to compute one from.
    const { record } = await seededArm({ slots: 3 })
    const gain = lensRecallGain(SEEDED_DEFECTS, record.pool)

    expect(record.pool.every((f) => f.source === "pool")).toBe(true)
    expect(gain.lens.found).toBe(0)
    expect(gain.lensOnlyDefects).toEqual([])
    expect(gain.beats).toBe(false)
    expect(gain.combined.found).toBe(gain.pool.found)
  })

  test("the matcher is injected here too (AD-14's shape)", async () => {
    // The module's own rule: the matcher is supplied, never hard-wired, so a
    // later story can swap in a model-backed one without reopening the harness.
    // Untested, `lensRecallGain` could have reached for the lexical default
    // directly and nothing would have said so.
    const { record } = await seededArm({ slots: 3, lenses: LENSES })

    expect(lensRecallGain(SEEDED_DEFECTS, record.pool, () => false).beats).toBe(false)
    expect(lensRecallGain(SEEDED_DEFECTS, record.pool, () => false).lensOnlyDefects).toEqual([])
    // A matcher that agrees with everything credits the pool first, so nothing
    // is left for the lens arm to claim uniquely — the greedy assignment is the
    // matcher's to drive, not the harness's.
    expect(lensRecallGain(SEEDED_DEFECTS, record.pool, () => true).pool.found).toBeGreaterThan(0)
  })

  test("nobody finds everything, lenses included", async () => {
    // The honesty property survives the extension: at least one planted defect
    // is findable by no arm at all, lensed or not, so a perfect score is still
    // not on offer and a matcher that credits everything shows up immediately.
    const { record } = await seededArm({ slots: 3, lenses: LENSES })
    const missed = missedDefects(SEEDED_DEFECTS, record.pool)
    expect(missed.length).toBeGreaterThan(0)
    expect(missed.map((d) => d.id)).toContain("unchecked-idempotency-key")
  })

  test("AD-17d — no lens finding carries a co-discovery prior, end to end", async () => {
    // Asserted here as well as in `review.test.ts` because this is the run that
    // most resembles a real one: a full pipeline over the real change, through
    // the same `review()` seam story 9's arms use.
    const { record, rendered } = await seededArm({ slots: 3, lenses: LENSES })

    // Over the WHOLE POOL, absorbed members included: a lens finding carries no
    // prior wherever it ends up, and no pool finding carries a denominator that
    // is not `answered`. `raised` is no longer always 1 — that is clustering
    // doing its job — so the invariant is asserted on the two things that must
    // never move.
    for (const finding of record.pool) {
      if (finding.source === "lens") expect(finding.coDiscovery).toBeUndefined()
      else if (finding.coDiscovery) expect(finding.coDiscovery.answered).toBe(3)
    }
    // And on the canonical set, every pool finding carries its pair.
    for (const finding of record.findings) {
      if (finding.source === "lens") expect(finding.coDiscovery).toBeUndefined()
      else expect(finding.coDiscovery?.answered).toBe(3)
    }
    expect(rendered).toContain("not applicable — lens-sourced")
    expect(rendered).toContain("co-discovery: 1/3")
    // AD-17c — four lens slots over three lineages, and the count is the pool's.
    expect(record.roster.lensSlots).toHaveLength(LENSES.length)
    expect(record.roster.distinctLineages).toBe(3)
  })
})

describe("story 4 — routing did not move a discovery number", () => {
  test("CAP-1 AND CAP-11 ARE MEASURED OVER THE POOL, WHICH ROUTING NEVER TOUCHES", async () => {
    // Routing writes `route` and `routeReason` (AD-8) and reads everything else.
    // The harness derives every arm from `finding.author` over `record.pool`, and
    // routing runs over the CANONICAL set — so an inserted stage must be invisible
    // here. Asserted structurally, because the numbers above passing unchanged is
    // evidence and this is the reason.
    const { record } = await seededArm({ slots: 3, lenses: LENSES })

    // Only canonicals were routed; the pool still holds absorbed members that
    // nothing decided about. `pool.length >= findings.length` is true by
    // construction and asserts nothing — the claim worth pinning is that the
    // ABSORBED members carry no route, because routing an absorbed member would
    // produce a decision nothing downstream ever reads.
    const canonicalIds = new Set(record.findings.map((f) => f.id))
    const absorbed = record.pool.filter((f) => !canonicalIds.has(f.id))
    expect(absorbed.length).toBeGreaterThan(0)
    for (const member of absorbed) {
      expect(member.route).toBeUndefined()
      expect(member.routeReason).toBeUndefined()
      expect(member.history.some((e) => e.stage === "route")).toBe(false)
    }
    expect(record.pool.filter((f) => f.route !== undefined).length).toBe(record.findings.length)

    // Every field the recall harness reads is untouched by routing.
    for (const finding of record.pool) {
      expect(finding.author.length).toBeGreaterThan(0)
      expect(["pool", "lens"]).toContain(finding.source)
      expect(finding.history[0]!.stage).toBe("discover")
    }

    // AD-8 — routing wrote nothing clustering owns.
    for (const finding of record.findings) {
      if (finding.source === "lens") expect(finding.coDiscovery).toBeUndefined()
      else expect(finding.coDiscovery?.answered).toBe(record.answered)
    }
  })
})
