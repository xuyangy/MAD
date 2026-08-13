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
