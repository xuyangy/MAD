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

  test("the shipped core/ tree passes", async () => {
    expect(await main()).toBe(0)
  })
})
