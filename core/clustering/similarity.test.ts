import { describe, expect, test } from "bun:test"

import type { Finding, Locus } from "../domain/finding.ts"
import { clusterItems } from "./engine.ts"
import { findingBlockKey, lexicalSimilarity } from "./similarity.ts"

function finding(id: string, claim: string, locus: Locus): Finding {
  return {
    id,
    claim,
    reasoning: "",
    locus,
    severity: "high",
    author: "discovery-1",
    source: "pool",
    history: [],
  }
}

describe("lexicalSimilarity — the shipped deterministic matcher", () => {
  test("same file, near lines and overlapping wording is the same defect", async () => {
    const a = finding("a", "The fee is computed before the rate is validated.", {
      file: "src/pay.ts",
      startLine: 12,
      endLine: 14,
    })
    const b = finding("b", "Fee computed before validating the rate value.", {
      file: "src/pay.ts",
      startLine: 13,
      endLine: 13,
    })
    expect(await lexicalSimilarity(a, b)).toBe(true)
  })

  test("a line cite a few lines off is still the same defect", async () => {
    // The same reasoning `fixtures/recall.ts:108-114` gives for LINE_TOLERANCE: a
    // model that cites the right bug two lines off has found the right bug.
    const a = finding("a", "Unvalidated rate makes the fee NaN.", {
      file: "src/pay.ts",
      startLine: 12,
      endLine: 12,
    })
    const b = finding("b", "The rate is never validated, so the fee becomes NaN.", {
      file: "src/pay.ts",
      startLine: 15,
      endLine: 15,
    })
    expect(await lexicalSimilarity(a, b)).toBe(true)
  })

  test("SAME WORDING IN DIFFERENT FILES IS NOT THE SAME DEFECT", async () => {
    const a = finding("a", "The fee is computed before the rate is validated.", {
      file: "src/pay.ts",
      startLine: 12,
    })
    const b = finding("b", "The fee is computed before the rate is validated.", {
      file: "src/refund.ts",
      startLine: 12,
    })
    expect(await lexicalSimilarity(a, b)).toBe(false)
  })

  test("same file and far apart lines is not the same defect", async () => {
    const a = finding("a", "The fee is computed before the rate is validated.", {
      file: "src/pay.ts",
      startLine: 12,
    })
    const b = finding("b", "The fee is computed before the rate is validated.", {
      file: "src/pay.ts",
      startLine: 400,
    })
    expect(await lexicalSimilarity(a, b)).toBe(false)
  })

  test("same file, adjacent lines, genuinely different defects stay apart", async () => {
    const a = finding("a", "The connection is never released back to the pool.", {
      file: "src/pay.ts",
      startLine: 40,
    })
    const b = finding("b", "Money is stored as a float, so cents are lost.", {
      file: "src/pay.ts",
      startLine: 42,
    })
    expect(await lexicalSimilarity(a, b)).toBe(false)
  })

  test("AN ARCHITECTURAL CLAIM WITH NO LINE DOES NOT MERGE WITH EVERYTHING IN ITS FILE", async () => {
    // It blocks on `file` only — so it is a candidate — but a file-level claim
    // and a claim about one statement are not the same finding, however much
    // wording they share. Otherwise one vague claim absorbs the whole file.
    const architectural = finding("a", "This module mixes transport and persistence concerns.", {
      file: "src/pay.ts",
    })
    const sited = finding("b", "This module mixes transport and persistence concerns here.", {
      file: "src/pay.ts",
      startLine: 12,
    })
    expect(await lexicalSimilarity(architectural, sited)).toBe(false)
  })

  test("two architectural claims about one file CAN be the same defect", async () => {
    const a = finding("a", "This module mixes transport and persistence concerns.", {
      file: "src/pay.ts",
    })
    const b = finding("b", "Transport and persistence concerns are mixed in this module.", {
      file: "src/pay.ts",
    })
    expect(await lexicalSimilarity(a, b)).toBe(true)
  })

  test("the matcher is symmetric — the engine compares each pair once, in one order", async () => {
    const a = finding("a", "The fee is computed before the rate is validated.", {
      file: "src/pay.ts",
      startLine: 12,
    })
    const b = finding("b", "Fee computed before validating the rate value.", {
      file: "src/pay.ts",
      startLine: 13,
    })
    expect(await lexicalSimilarity(a, b)).toBe(await lexicalSimilarity(b, a))
  })

  test("a path cited without its leading directory still matches", async () => {
    // Two models spelling one path differently is a spelling difference, not a
    // second defect. The suffix must carry a directory segment, so two files
    // sharing a basename never collapse.
    const a = finding("a", "The fee is computed before the rate is validated.", {
      file: "src/billing/pay.ts",
      startLine: 12,
    })
    const b = finding("b", "Fee computed before validating the rate value.", {
      file: "billing/pay.ts",
      startLine: 12,
    })
    expect(await lexicalSimilarity(a, b)).toBe(true)
  })
})

describe("findingBlockKey — the comparison budget", () => {
  test("findings in different files are never compared at all", async () => {
    const items = [
      finding("a", "The fee is wrong.", { file: "src/pay.ts", startLine: 1 }),
      finding("b", "The fee is wrong.", { file: "src/refund.ts", startLine: 1 }),
      finding("c", "The fee is wrong.", { file: "src/pay.ts", startLine: 1 }),
    ]
    const result = await clusterItems(items, () => true, findingBlockKey)
    expect(result.comparisons).toBe(1)
    expect(result.clusters.map((c) => c.memberIds)).toEqual([["a", "c"], ["b"]])
  })

  test("a differently spelled path lands in the same block", async () => {
    expect(findingBlockKey(finding("a", "x", { file: "./src/pay.ts" }))).toBe(
      findingBlockKey(finding("b", "x", { file: "src/pay.ts" })),
    )
  })
})
