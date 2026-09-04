import { describe, expect, test } from "bun:test"

import type { Finding } from "../core/domain/finding.ts"
import { alignArms } from "./align.ts"

function finding(id: string, claim: string, file: string, line: number): Finding {
  return {
    id,
    claim,
    reasoning: "because of this",
    locus: { file, startLine: line, endLine: line },
    severity: "high",
    author: "discovery-1",
    source: "pool",
    history: [],
  }
}

const ALWAYS = () => true
const NEVER = () => false
const ONE_BLOCK = () => "everything"

describe("alignArms — two arms, different finding sets", () => {
  test("TWO ARMS' IDENTICALLY-NUMBERED FINDINGS ARE NEVER CONFLATED", () => {
    // `fakeClock` numbers findings from 1 per run, so two arms genuinely collide
    // on ids. Without namespacing, the union-find would fuse arm A's first
    // finding with arm B's first for no reason but their names — an invented
    // matched pair, straight into the difference denominator.
    const a = { id: "a", findings: [finding("finding-1", "alpha alpha alpha", "x.ts", 10)] }
    const b = { id: "b", findings: [finding("finding-1", "zulu zulu zulu", "y.ts", 90)] }

    return alignArms(a, b).then((alignment) => {
      expect(alignment.groups).toHaveLength(2)
      expect(alignment.groups.map((g) => g.kind).sort()).toEqual(["only-a", "only-b"])
    })
  })

  test("THE COMPARATOR NEVER MUTATES WHAT IT READS", async () => {
    // It clusters shallow copies and returns the originals. `cluster()` — the
    // STAGE — mutates findings in place (AD-7) and would rewrite the very
    // records the report is about to read.
    const aFindings = [finding("f-1", "shared vocabulary here", "x.ts", 10)]
    const bFindings = [finding("f-1", "shared vocabulary here", "x.ts", 10)]
    const before = JSON.parse(JSON.stringify({ aFindings, bFindings }))

    await alignArms({ id: "a", findings: aFindings }, { id: "b", findings: bFindings })

    expect(JSON.parse(JSON.stringify({ aFindings, bFindings }))).toEqual(before)
  })

  test("it returns the ORIGINAL findings, not the namespaced copies", async () => {
    const original = finding("f-1", "shared vocabulary here", "x.ts", 10)
    const alignment = await alignArms(
      { id: "a", findings: [original] },
      { id: "b", findings: [finding("f-1", "shared vocabulary here", "x.ts", 10)] },
    )
    const matched = alignment.groups.find((g) => g.kind === "matched")!
    expect(matched.a[0]!.id).toBe("f-1")
    expect(matched.a[0]).toBe(original)
  })

  test("AN AMBIGUOUS ARM ID IS REFUSED rather than silently namespaced", async () => {
    const ok = { id: "a", findings: [] }
    await expect(alignArms(ok, { id: "b::c", findings: [] })).rejects.toThrow('must not contain "::"')
    await expect(alignArms(ok, { id: "", findings: [] })).rejects.toThrow("non-empty")
    await expect(alignArms(ok, { id: "a", findings: [] })).rejects.toThrow("different ids")
  })

  test("A NON-1:1 GROUP IS AMBIGUOUS AND IS EXCLUDED FROM THE DENOMINATOR", async () => {
    // Two of arm B's findings land with one of arm A's, so there is no pair to
    // compare. Dropping it silently would shrink the denominator and inflate
    // whatever rate is computed over it; it is excluded AND counted.
    const a = { id: "a", findings: [finding("f-1", "x", "x.ts", 10)] }
    const b = {
      id: "b",
      findings: [finding("g-1", "x", "x.ts", 10), finding("g-2", "x", "x.ts", 10)],
    }
    const alignment = await alignArms(a, b, ALWAYS, ONE_BLOCK)
    expect(alignment.groups).toHaveLength(1)
    expect(alignment.groups[0]!.kind).toBe("ambiguous")
  })

  test("REMOVING THE EXTRA FINDING YIELDS A MATCHED PAIR — 'ambiguous' is not this aligner's default", async () => {
    // The non-vacuous sibling of the test above, and the reason it exists: the
    // same two arms, one finding fewer on arm B, and the classification changes
    // from `ambiguous` to `matched`. Without it, an aligner that returned
    // `ambiguous` for absolutely everything would pass the test above.
    const a = { id: "a", findings: [finding("f-1", "x", "x.ts", 10)] }
    const two = {
      id: "b",
      findings: [finding("g-1", "x", "x.ts", 10), finding("g-2", "x", "x.ts", 10)],
    }
    const one = { id: "b", findings: [finding("g-1", "x", "x.ts", 10)] }

    expect((await alignArms(a, two, ALWAYS, ONE_BLOCK)).groups.map((g) => g.kind)).toEqual([
      "ambiguous",
    ])
    expect((await alignArms(a, one, ALWAYS, ONE_BLOCK)).groups.map((g) => g.kind)).toEqual([
      "matched",
    ])
  })

  test("a finding only one arm raised is `only-a` / `only-b`, and is named for its own arm", async () => {
    const a = { id: "a", findings: [finding("f-1", "alpha alpha", "x.ts", 10)] }
    const b = {
      id: "b",
      findings: [finding("g-1", "alpha alpha", "x.ts", 10), finding("g-2", "zulu", "z.ts", 90)],
    }
    const alignment = await alignArms(a, b)
    const only = alignment.groups.find((g) => g.kind === "only-b")!
    expect(only.b.map((f) => f.id)).toEqual(["g-2"])
    expect(only.a).toEqual([])
  })

  test("THE MATCHER AND THE BLOCK KEY ARE INJECTED, NOT HARD-WIRED", async () => {
    const a = { id: "a", findings: [finding("f-1", "alpha", "x.ts", 10)] }
    const b = { id: "b", findings: [finding("g-1", "zulu", "y.ts", 90)] }

    // Always-true, one block: everything collapses into one group.
    const fused = await alignArms(a, b, ALWAYS, ONE_BLOCK)
    expect(fused.groups).toHaveLength(1)
    expect(fused.groups[0]!.kind).toBe("matched")

    // Always-false: both arms are wholly exclusive.
    const split = await alignArms(a, b, NEVER, ONE_BLOCK)
    expect(split.groups.map((g) => g.kind).sort()).toEqual(["only-a", "only-b"])
  })

  test("THE BLOCK KEY'S SILENT VETO IS COUNTED — it is a pair nobody judged", async () => {
    // The shipped block key is the file's basename, so two findings in different
    // files are never compared however similar their claims. That is a decision
    // the matcher never got to make, and the report prints the count.
    const a = { id: "a", findings: [finding("f-1", "same words entirely", "x.ts", 10)] }
    const b = { id: "b", findings: [finding("g-1", "same words entirely", "y.ts", 10)] }

    const blocked = await alignArms(a, b)
    expect(blocked.candidatePairs).toBe(1)
    expect(blocked.blockedPairs).toBe(1)

    const unblocked = await alignArms(a, b, ALWAYS, ONE_BLOCK)
    expect(unblocked.candidatePairs).toBe(1)
    expect(unblocked.blockedPairs).toBe(0)
  })

  test("candidatePairs counts CROSS-ARM pairs only", async () => {
    // A within-arm pair was never something this alignment would compare, so
    // counting it would inflate the denominator of a number the report prints.
    const a = {
      id: "a",
      findings: [finding("f-1", "one", "x.ts", 1), finding("f-2", "two", "x.ts", 2)],
    }
    const b = { id: "b", findings: [finding("g-1", "three", "x.ts", 3)] }
    const alignment = await alignArms(a, b, NEVER)
    expect(alignment.candidatePairs).toBe(2)
  })

  test("empty arms are an empty alignment, not a crash", async () => {
    const alignment = await alignArms({ id: "a", findings: [] }, { id: "b", findings: [] })
    expect(alignment.groups).toEqual([])
    expect(alignment.candidatePairs).toBe(0)
  })
})
