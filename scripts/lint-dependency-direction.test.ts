import { describe, expect, test } from "bun:test"

import { main, scanSource } from "./lint-dependency-direction.ts"

describe("AD-1 dependency-direction rule", () => {
  test("fails a core file importing from adapters/", () => {
    const violations = scanSource(
      "core/stages/discover.ts",
      `import { opencodeRepo } from "../../adapters/opencode/repo.ts"\n`,
    )
    expect(violations).toHaveLength(1)
    expect(violations[0]!.why).toContain("adapters/")
  })

  test("fails a core file importing a harness SDK", () => {
    expect(
      scanSource("core/ports/model-backend.ts", `import type { Plugin } from "@opencode-ai/plugin"\n`),
    ).toHaveLength(1)
    expect(
      scanSource("core/run/review.ts", `const sdk = await import("@opencode-ai/sdk/v2")\n`),
    ).toHaveLength(1)
    expect(
      scanSource("core/run/review.ts", `const sdk = require("@opencode-ai/sdk")\n`),
    ).toHaveLength(1)
  })

  test("fails a MULTI-LINE import — the shape this codebase actually writes", () => {
    // `core/test-support/fakes.ts` already imports across four lines. A rule
    // that only matched single-line imports would let this exact shape through.
    const violations = scanSource(
      "core/ports/model-backend.ts",
      `import type {\n  BackendCapabilities,\n  Envelope,\n  ModelBackend,\n} from "@opencode-ai/plugin"\n`,
    )
    expect(violations).toHaveLength(1)
    expect(violations[0]!.specifier).toBe("@opencode-ai/plugin")
  })

  test("fails a multi-line import from adapters/", () => {
    expect(
      scanSource(
        "core/run/review.ts",
        `import {\n  opencodeRepo,\n  type OpencodeRepoOptions,\n} from "../../adapters/opencode/repo.ts"\n`,
      ),
    ).toHaveLength(1)
  })

  test("fails a SIDE-EFFECT import, which has no `from` clause at all", () => {
    const violations = scanSource("core/run/review.ts", `import "@opencode-ai/sdk/v2"\n`)
    expect(violations).toHaveLength(1)
    expect(violations[0]!.specifier).toBe("@opencode-ai/sdk/v2")
  })

  test("fails a multi-line export ... from", () => {
    expect(
      scanSource("core/domain/finding.ts", `export type {\n  Plugin,\n} from "@opencode-ai/plugin"\n`),
    ).toHaveLength(1)
  })

  test("fails a core file importing from the top-level fixtures/ tree", () => {
    // Fixture code — seeded defects, scripted answers, recall counting — must not
    // be reachable from a shipped stage.
    const violations = scanSource(
      "core/stages/discover.ts",
      `import { SEEDED_DEFECTS } from "../../fixtures/seeded-defects/change.ts"\n`,
    )
    expect(violations).toHaveLength(1)
    expect(violations[0]!.why).toContain("fixtures/")

    expect(
      scanSource(
        "core/run/review.ts",
        `import {\n  recall,\n  type SeededDefect,\n} from "../../fixtures/recall.ts"\n`,
      ),
    ).toHaveLength(1)
    expect(scanSource("core/stages/output.ts", `import "fixtures/recall.ts"\n`)).toHaveLength(1)
    expect(
      scanSource("core/run/review.ts", `const f = await import("../../fixtures/recall.ts")\n`),
    ).toHaveLength(1)
  })

  test("a non-canonical specifier cannot slip past the anchors", () => {
    // Both of these reach the top-level fixtures/ tree while reading as
    // something else, so a prefix pattern alone never sees them.
    expect(
      scanSource("core/clustering/engine.ts", `import { x } from "../../fixtures"\n`),
    ).toHaveLength(1)
    expect(
      scanSource(
        "core/clustering/engine.ts",
        `import { x } from "../clustering/../../fixtures/recall.ts"\n`,
      ),
    ).toHaveLength(1)
    // Same hole on the adapters side: a directory import, no trailing slash.
    expect(scanSource("core/run/review.ts", `import "../../adapters"\n`)).toHaveLength(1)
    expect(
      scanSource("core/run/review.ts", `import { x } from "../run/../../adapters/opencode/plugin.ts"\n`),
    ).toHaveLength(1)
  })

  test("resolution does not over-reach: a sibling named like a forbidden tree is fine", () => {
    // `core/fixtures/` is inside core, not the top-level tree.
    expect(
      scanSource("core/clustering/engine.test.ts", `import { P } from "../fixtures/pairs.ts"\n`),
    ).toHaveLength(0)
  })

  test("allows a fixture harness that ships INSIDE core, which AD-14 requires", () => {
    // AD-14: clustering's fixture harness ships with the engine. The rule forbids
    // reaching the top-level tree, not owning a local one.
    expect(
      scanSource(
        "core/clustering/engine.test.ts",
        `import { PAIRS } from "./fixtures/pairs.ts"\nimport { LABELS } from "../clustering/fixtures/labels.ts"\n`,
      ),
    ).toHaveLength(0)
  })

  test("STORY 3'S REAL SPECIFIERS: the shipped harness passes, a reach out does not", () => {
    // The cases above are hypothetical; these are the specifiers actually in the
    // tree now that `core/clustering/fixtures/` exists. Story 3 is the first to
    // RELY on the resolver behaving this way, so it is pinned against the real
    // files rather than against an example of them.
    expect(
      scanSource(
        "core/clustering/fixtures/rates.ts",
        `import type { Finding } from "../../domain/finding.ts"\n` +
          `import { clusterItems } from "../engine.ts"\n` +
          `import { PAIRS } from "./pairs.ts"\n`,
      ),
    ).toHaveLength(0)
    expect(
      scanSource("scripts/clustering-rates.ts", `import { PAIRS } from "../core/clustering/fixtures/pairs.ts"\n`),
    ).toHaveLength(0)

    // ...and the thing that must still fail: clustering's own fixture tree
    // reaching CAP-1's seeded-defect tree, which is three directories up.
    expect(
      scanSource(
        "core/clustering/fixtures/rates.ts",
        `import { SEEDED_DEFECTS } from "../../../fixtures/seeded-defects/change.ts"\n`,
      ),
    ).toHaveLength(1)
  })

  test("allows the imports the core is supposed to make", () => {
    expect(
      scanSource(
        "core/stages/discover.ts",
        `import { z } from "zod"\nimport type { Finding } from "../domain/finding.ts"\nexport type { Locus } from "../domain/finding.ts"\n`,
      ),
    ).toHaveLength(0)
  })

  test("CORE MAY NOT IMPORT FROM ablation/ (story 9's fourth tree)", () => {
    // A measurement harness reachable from inside a stage would let an
    // experiment's scaffolding ship inside the tool it is measuring.
    expect(
      scanSource("core/stages/output.ts", `import { armCost } from "../../ablation/compare.ts"\n`),
    ).toHaveLength(1)
    expect(
      scanSource("core/run/review.ts", `import { runAblation } from "ablation/arms.ts"\n`),
    ).toHaveLength(1)
  })

  test("THE ARROW POINTS ONE WAY — the shipped tree passes with ablation/ importing core and adapters", async () => {
    // The non-vacuous sibling, and it is stated as a property of `main()` rather
    // than of `scanSource`. `scanSource` applies the CORE rules to whatever path
    // it is handed; it is `main()` that decides those rules govern `core/` alone
    // by globbing that tree. Asking `scanSource` about an `ablation/` file would
    // measure the scanner's scope rather than the rule (found while writing this
    // test: it reports `ablation/live.ts`'s legitimate adapters import as a
    // violation).
    //
    // `ablation/arms.ts` imports `core/`, `ablation/live.ts` imports `adapters/`,
    // and both are shipped in the tree this assertion runs over.
    expect(await main()).toBe(0)
  })

  test("the shipped core/ tree passes", async () => {
    expect(await main()).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Story 8 — the presets module imports nothing, and no stage meters itself.
  // -------------------------------------------------------------------------

  test("`core/budget/presets.ts` importing ANYTHING is a violation", () => {
    // `core/domain/run-record.ts` imports `SpendShares` from it while
    // `core/budget/ledger.ts` imports from `core/domain/`. This file having no
    // imports is the only thing keeping that from being a cycle — a property
    // that was a doc comment for `limiter.ts` until it was made a rule.
    expect(
      scanSource("core/budget/presets.ts", `import { spent } from "./ledger.ts"
`),
    ).toHaveLength(1)
    expect(
      scanSource("core/budget/presets.ts", `import type { Stage } from "../domain/finding.ts"
`),
    ).toHaveLength(1)
  })

  test("the presets module with no imports passes", () => {
    expect(scanSource("core/budget/presets.ts", `export const PRESETS = ["quick"]
`)).toHaveLength(0)
  })

  test("A STAGE THAT READS THE SHARES OR COMPUTES A CEILING IS A VIOLATION", () => {
    // AD-15 — a stage may ASK the accountant; a stage that multiplies the cap by
    // a share is a stage metering itself, which is what the decision's first
    // sentence forbids.
    for (const symbol of ["stageCeiling", "spentInStage", "clampSpendShares", "CUMULATIVE_SHARE"]) {
      expect(
        scanSource("core/stages/debate.ts", `const x = ${symbol}(ledger, "debate")
`),
      ).toHaveLength(1)
    }
    expect(
      scanSource("core/stages/output.ts", `const share = record.ledger.shares.debate
`),
    ).toHaveLength(1)
  })

  test("a stage that only ASKS the accountant passes", () => {
    // The permitted vocabulary, and the whole point of the rule: all three of
    // these return finished answers, so no stage has to compute a ceiling.
    expect(
      scanSource(
        "core/stages/debate.ts",
        `if (!mayISpend(ledger, "debate")) return
const why = ceilingClause(ledger, "debate")
` +
          `const rows = budgetReport(ledger)
const named = ceilingNamed(ledger, "debate")
`,
      ),
    ).toHaveLength(0)
  })

  test("the rule is scoped to stages, and does not fire on the accountant itself", () => {
    // `core/budget/ledger.ts` is where this arithmetic BELONGS.
    expect(
      scanSource("core/budget/ledger.ts", `export function stageCeiling() {}
`),
    ).toHaveLength(0)
    // Nor on a stage's own test, which is where the internals are asserted.
    expect(
      scanSource("core/stages/debate.test.ts", `expect(stageCeiling(ledger, "debate")).toBe(1)
`),
    ).toHaveLength(0)
  })

  test("a near-miss identifier is NOT a violation — the match is word-bounded", () => {
    expect(
      scanSource("core/stages/debate.ts", `const stageCeilingLabel = "x"
`),
    ).toHaveLength(0)
  })
})
