import { describe, expect, test } from "bun:test"

import { main, scanSource } from "./lint-material-spans.ts"

/**
 * Built at run time rather than written as a literal, so this test file does not
 * itself contain the sequence it is testing for — and so a reader is not misled
 * into thinking a fence may be spelled by hand somewhere.
 */
const fence = "`".repeat(4)
const opener = `${fence}material: change under review`

describe("AD-18 material-span rule", () => {
  test("fails a core file that emits a fence line", () => {
    const violations = scanSource("core/stages/judge.ts", `  lines.push(\`${opener}\`)\n`)
    expect(violations).toHaveLength(1)
    expect(violations[0]!.why).toContain("material fence")
    expect(violations[0]!.line).toBe(1)
  })

  test("fails a WIDER fence too — the width is the body's, not a constant", () => {
    // `fenceFor` widens past the longest run in the body, so a hand-built span
    // that copied the mechanism would not be spelled with four backticks.
    const wide = "`".repeat(9)
    expect(scanSource("core/stages/judge.ts", `${wide}material: extracted evidence\n`)).toHaveLength(1)
  })

  test("catches a fence assembled by concatenation, not only a literal", () => {
    // The rule reads the SOURCE line, so it sees the bytes however they are
    // spelled — which is the point: three spellings produce one output.
    expect(scanSource("core/x.ts", `const open = "${opener}" + label\n`)).toHaveLength(1)
  })

  test("allows an ordinary fence with no material label", () => {
    expect(scanSource("core/x.ts", "const inner = \"```diff\"\n")).toEqual([])
  })

  test("allows the word material in prose", () => {
    expect(
      scanSource("core/stages/judge.ts", `// span 4 is the extracted evidence the judge reads\n`),
    ).toEqual([])
  })

  test("exempts material.ts itself", () => {
    expect(scanSource("core/prompt/material.ts", `${opener}\n`)).toEqual([])
  })

  test("exempts the span PARSER and the emitter's own test", () => {
    // `materialSpans` must recognise a fence to parse one; `material.test.ts`
    // pins the exact bytes `material()` produces. Neither builds a span a model
    // will read.
    expect(scanSource("core/test-support/fakes.ts", `const open = /${fence}material: /\n`)).toEqual([])
    expect(scanSource("core/prompt/material.test.ts", `${opener}\n`)).toEqual([])
  })

  test("reports the line number, so a violation is navigable", () => {
    const violations = scanSource("core/x.ts", `a\nb\n${opener}\n`)
    expect(violations).toHaveLength(1)
    expect(violations[0]!.line).toBe(3)
  })

  test("the real tree passes — one emitter", async () => {
    expect(await main()).toBe(0)
  })
})
