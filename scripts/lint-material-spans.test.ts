import { describe, expect, test } from "bun:test"

import { main, scanSource, scannedFiles } from "./lint-material-spans.ts"

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

  test("THE ABLATION TREE IS SCANNED TOO (story 9)", () => {
    // The ablation renders a report a reader may cite, and it interpolates
    // model-authored claims into it. A second span emitter there would be the
    // same forgery surface AD-18 closes everywhere else.
    expect(scanSource("ablation/report.ts", `lines.push(\`${opener}\`)\n`)).toHaveLength(1)
  })

  test("...AND THE SCOPE IS CHECKED, not just the rule (retrospective triage, entry 60)", async () => {
    // The test above passes a path in by hand, and `scanSource` consults no
    // directory scope — so it answered about `ablation/report.ts` whether or not
    // the linter would ever OPEN that file. Proven vacuous by mutation: dropping
    // `ablation` from `SCAN_GLOB` left the whole suite at 1057 pass, 0 fail.
    //
    // This asserts against the list the linter will really read. Every tree named
    // in the glob must contribute at least one real file, so a tree silently
    // dropped from the pattern fails here — which is the failure the sibling above
    // was written to produce and could not.
    const files = await scannedFiles()
    for (const tree of ["core", "adapters", "fixtures", "scripts", "ablation"]) {
      expect(files.some((file) => file.startsWith(`${tree}/`))).toBe(true)
    }

    // Named files, so "the tree is scanned" cannot be satisfied by some unrelated
    // file that happens to sit under it. These three are the prompt builders the
    // 2026-08-28 review widened the glob to reach.
    expect(files).toContain("ablation/report.ts")
    expect(files).toContain("fixtures/prompt-injection/change.ts")
    expect(files).toContain("core/prompt/material.ts")

    // NOT VACUOUS: the list is the real one, so it must also EXCLUDE what the
    // glob excludes. A pattern widened to `**/*.ts` would pass every assertion
    // above and this one catches it.
    expect(files.some((file) => file.startsWith("node_modules/"))).toBe(false)
    expect(files.every((file) => file.endsWith(".ts"))).toBe(true)
  })

  test("the real tree passes — one emitter", async () => {
    expect(await main()).toBe(0)
  })
})
