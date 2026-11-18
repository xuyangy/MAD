import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  ANSWER_KEY,
  ANSWER_KEY_ISOLATED_ROOTS,
  answerKeyViolations,
  bunResolver,
  main,
  scanAdapterSource,
  scanSource,
} from "./lint-dependency-direction.ts"

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

  test("T7 — THE JUDGE MAY NOT REACH FOR THE `Tools` IMPLEMENTATION (story 10)", () => {
    // The exact temptation story 10 creates. `core/stages/judge.ts` now DRIVES
    // the `Tools` port, and the shortest way to make that work is to import the
    // thing that implements it — which is in `adapters/`, and which AD-1 forbids
    // absolutely. The port arrives through `JudgeInput.tools`, injected at the
    // plugin boundary, or it does not arrive.
    expect(
      scanSource(
        "core/stages/judge.ts",
        `import { opencodeTools } from "../../adapters/opencode/tools.ts"\n`,
      ),
    ).toHaveLength(1)

    // The non-vacuous sibling: taking the INTERFACE is exactly what the stage is
    // supposed to do, and must not be collateral damage of the rule above.
    expect(
      scanSource("core/stages/judge.ts", `import type { Tools } from "../ports/tools.ts"\n`),
    ).toHaveLength(0)
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

describe("the SECOND direction: adapters/ must not reach into fixtures/ or ablation/ (ledger triage 2026-09-09)", () => {
  // AD-1 as written governs `core/` only, and `package.json` ships
  // `adapters/opencode/plugin.ts` — so fixture data reaching the adapter reaches
  // the published entry point.
  test("an adapter importing fixtures/ is a violation, in every spelling", () => {
    for (const specifier of [
      "../../fixtures/seeded-defects/change.ts",
      "../../fixtures",
      "../../ablation/report.ts",
      "../../ablation",
      "../clustering/../../fixtures/recall.ts",
    ]) {
      const found = scanAdapterSource("adapters/opencode/plugin.ts", `import x from "${specifier}"\n`)
      expect(found).toHaveLength(1)
      expect(found[0]!.why).toContain("adapters must not import")
    }
  })

  test("the arrows that ARE allowed still pass", () => {
    // Into core, and within adapters. A fixture DRIVING the real adapter is what
    // an end-to-end fixture is for, so the reverse arrow is not forbidden.
    expect(scanAdapterSource("adapters/opencode/plugin.ts", `import x from "../../core/run/review.ts"\n`)).toEqual([])
    expect(scanAdapterSource("adapters/opencode/plugin.ts", `import x from "./repo.ts"\n`)).toEqual([])
    expect(scanAdapterSource("fixtures/e2e/run.ts", `import x from "../../adapters/opencode/plugin.ts"\n`)).toEqual([])
  })

  test("THE REAL TREE PASSES — this is measured, not assumed", async () => {
    expect(await main()).toBe(0)
  })
})

describe("the AD-1 and adapter rules see every import, a side-effect or dynamic one before an ordinary import included", () => {
  test("a side-effect import before an ordinary one is seen, and so is the ordinary one", () => {
    const violations = scanSource(
      "core/run/review.ts",
      `import "../../adapters/opencode/repo.ts"\nimport { a } from "@opencode-ai/plugin"\n`,
    )
    expect(violations.map((v) => v.specifier).sort()).toEqual(["../../adapters/opencode/repo.ts", "@opencode-ai/plugin"])
  })

  test("a dynamic import between an export and a later `from` is seen", () => {
    const violations = scanSource(
      "core/run/review.ts",
      `export const k = await import("../../adapters/opencode/repo.ts")\nexport { b } from "./b.ts"\n`,
    )
    expect(violations.map((v) => v.specifier)).toEqual(["../../adapters/opencode/repo.ts"])
  })

  test("a non-ASCII alias or a quoted export name in the clause is still seen", () => {
    for (const clause of ["{ läs }", `{ "quoted name" as q }`, "{ a as läs, b }"]) {
      expect(
        scanSource("core/run/review.ts", `import ${clause} from "../../adapters/opencode/repo.ts"\n`).map((v) => v.specifier),
      ).toEqual(["../../adapters/opencode/repo.ts"])
      expect(
        scanAdapterSource("adapters/opencode/plugin.ts", `export ${clause} from "../../fixtures/recall.ts"\n`).map(
          (v) => v.specifier,
        ),
      ).toEqual(["../../fixtures/recall.ts"])
    }
  })

  test("a type-only import is still judged by the AD-1 rule", () => {
    expect(
      scanSource("core/run/review.ts", `import type { Repo } from "../../adapters/opencode/repo.ts"\n`),
    ).toHaveLength(1)
  })

  test("an adapter's side-effect import before an ordinary one is seen", () => {
    expect(
      scanAdapterSource(
        "adapters/opencode/plugin.ts",
        `import "../../fixtures/recall.ts"\nimport { a } from "./repo.ts"\n`,
      ).map((v) => v.specifier),
    ).toEqual(["../../fixtures/recall.ts"])
  })

  test("a clause with comments still reaches its `from`", () => {
    expect(
      scanSource("core/run/review.ts", `import {\n  a, // it's the first\n  /* b */ b,\n} from "@opencode-ai/plugin"\n`),
    ).toHaveLength(1)
  })
})

describe("the answer key never reaches the labelled worktree writer (ledger #13)", () => {
  const ROOT = "scripts/materialize-labelled-change.ts"
  const MATERIAL = "fixtures/seeded-defects/material.ts"
  const reader = (files: Record<string, string>) => (path: string) => files[path]

  test("the root is the labelled worktree writer and the labels are the answer key", () => {
    expect(ANSWER_KEY_ISOLATED_ROOTS).toEqual([ROOT])
    expect(ANSWER_KEY).toBe("fixtures/seeded-defects/labels.ts")
  })

  test("a direct import is a violation naming the chain", () => {
    const violations = answerKeyViolations(
      [ROOT],
      reader({ [ROOT]: `import { SEEDED_DEFECTS } from "../fixtures/seeded-defects/labels.ts"\n`, [ANSWER_KEY]: "" }),
    )
    expect(violations).toHaveLength(1)
    expect(violations[0]!.file).toBe(ROOT)
    expect(violations[0]!.specifier).toBe("../fixtures/seeded-defects/labels.ts")
    expect(violations[0]!.why).toContain(`it is reached as ${ROOT} -> ${ANSWER_KEY}`)
  })

  test("a helper that loads the barrel, which re-exports the labels, is a violation", () => {
    const violations = answerKeyViolations(
      [ROOT],
      reader({
        [ROOT]: `import { helper } from "./helper.ts"\n`,
        "scripts/helper.ts": `import { SEEDED_CHANGE } from "../fixtures/seeded-defects/change.ts"\n`,
        "fixtures/seeded-defects/change.ts": `export { SEEDED_DEFECTS } from "./labels.ts"\n`,
        [ANSWER_KEY]: "",
      }),
    )
    expect(violations).toHaveLength(1)
    expect(violations[0]!.file).toBe("fixtures/seeded-defects/change.ts")
    expect(violations[0]!.why).toContain(
      `it is reached as ${ROOT} -> scripts/helper.ts -> fixtures/seeded-defects/change.ts -> ${ANSWER_KEY}`,
    )
  })

  test("a material-only graph with a cycle passes", () => {
    expect(
      answerKeyViolations(
        [ROOT],
        reader({
          [ROOT]: `import { BASE_TREE } from "../fixtures/seeded-defects/material.ts"\nimport { x } from "./a.ts"\n`,
          [MATERIAL]: `import type { ChangeSet } from "../../core/ports/repo.ts"\n`,
          "core/ports/repo.ts": "",
          "scripts/a.ts": `import { y } from "./b.ts"\n`,
          "scripts/b.ts": `import { x } from "./a.ts"\nimport "node:fs"\n`,
          [ANSWER_KEY]: "",
        }),
      ),
    ).toEqual([])
  })

  test("a side-effect import of a leaking helper, before an ordinary import, is a violation", () => {
    const violations = answerKeyViolations(
      [ROOT],
      reader({
        [ROOT]: `import "./helper.ts"\nimport { BASE_TREE } from "../fixtures/seeded-defects/material.ts"\n`,
        "scripts/helper.ts": `import "../fixtures/seeded-defects/labels.ts"\n`,
        [MATERIAL]: "",
        [ANSWER_KEY]: "",
      }),
    )
    expect(violations.map((v) => v.file)).toEqual(["scripts/helper.ts"])
  })

  test("a non-canonical, extensionless, `.js` or dynamic reference is resolved", () => {
    for (const specifier of [
      "./x/../../fixtures/seeded-defects/labels.ts",
      "../fixtures/seeded-defects/labels",
      "../fixtures/seeded-defects/labels.js",
    ]) {
      for (const line of [`import { a } from "${specifier}"`, `const a = await import("${specifier}")`]) {
        const violations = answerKeyViolations([ROOT], reader({ [ROOT]: `${line}\n`, [ANSWER_KEY]: "" }))
        expect(violations.map((v) => v.specifier)).toEqual([specifier])
        expect(violations[0]!.why).toContain(`it is reached as ${ROOT} -> ${ANSWER_KEY}`)
      }
    }
  })

  test("an extensionless import of a `.js` helper is followed, to a leak or to a clean module", () => {
    const leaking = answerKeyViolations(
      [ROOT],
      reader({
        [ROOT]: `import "./helper"\n`,
        "scripts/helper.js": `require("../fixtures/seeded-defects/labels.ts")\n`,
        [ANSWER_KEY]: "",
      }),
    )
    expect(leaking.map((v) => v.file)).toEqual(["scripts/helper.js"])
    expect(leaking[0]!.why).toContain(`it is reached as ${ROOT} -> scripts/helper.js -> ${ANSWER_KEY}`)
    expect(
      answerKeyViolations(
        [ROOT],
        reader({ [ROOT]: `import "./helper"\n`, "scripts/helper.js": `module.exports = 1\n`, [ANSWER_KEY]: "" }),
      ),
    ).toEqual([])
  })

  test("a directory import is followed to its index", () => {
    const violations = answerKeyViolations(
      [ROOT],
      reader({ [ROOT]: `import { a } from "./lib"\n`, "scripts/lib/index.mjs": `export * from "../../fixtures/seeded-defects/labels.ts"\n`, [ANSWER_KEY]: "" }),
    )
    expect(violations.map((v) => v.file)).toEqual(["scripts/lib/index.mjs"])
  })

  /** Runs `run` with the lint's console output discarded. */
  const quietly = async <T>(run: () => Promise<T>): Promise<T> => {
    const { log, error } = console
    console.log = () => {}
    console.error = () => {}
    try {
      return await run()
    } finally {
      console.log = log
      console.error = error
    }
  }

  test("on disk, a directory import follows its package.json entry as Bun does, not its index", async () => {
    // `scripts/lib/` holds both a clean `index.ts` and a `package.json` whose
    // `main` is `entry.js`; Bun loads `entry.js`, so that is the module checked.
    const dir = await mkdtemp(join(tmpdir(), "mad-answer-key-"))
    try {
      const write = async (path: string, text: string) => {
        await mkdir(dirname(join(dir, path)), { recursive: true })
        await writeFile(join(dir, path), text)
      }
      await write(ROOT, `import "./lib"\n`)
      await write("scripts/lib/package.json", `{ "main": "entry.js" }\n`)
      await write("scripts/lib/index.ts", `export const clean = 1\n`)
      await write(ANSWER_KEY, "export const SEEDED_DEFECTS = []\n")
      const read = (path: string) => {
        try {
          return readFileSync(join(dir, path), "utf8")
        } catch {
          return undefined
        }
      }

      await write("scripts/lib/entry.js", `require("../../fixtures/seeded-defects/labels.ts")\n`)
      const violations = answerKeyViolations([ROOT], read, bunResolver(dir))
      expect(violations.map((v) => v.file)).toEqual(["scripts/lib/entry.js"])
      expect(violations[0]!.why).toContain(`it is reached as ${ROOT} -> scripts/lib/entry.js -> ${ANSWER_KEY}`)

      expect(await quietly(() => main([ROOT], dir))).toBe(1)

      await write("scripts/lib/entry.js", `module.exports = 1\n`)
      expect(answerKeyViolations([ROOT], read, bunResolver(dir))).toEqual([])
      expect(await quietly(() => main([ROOT], dir))).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("on disk, an import Bun cannot resolve, or one outside the root, is a violation", async () => {
    // The repository is `<parent>/repo`; `../../outside.ts` from its `scripts/`
    // is `<parent>/outside.ts`, a real file Bun resolves, outside the root.
    const parent = await mkdtemp(join(tmpdir(), "mad-answer-key-"))
    const dir = join(parent, "repo")
    try {
      await mkdir(join(dir, "scripts"), { recursive: true })
      await writeFile(join(dir, ROOT), `import "./gone"\nimport "../../outside.ts"\n`)
      await writeFile(join(parent, "outside.ts"), "")
      const read = (path: string) => {
        try {
          return readFileSync(join(dir, path), "utf8")
        } catch {
          return undefined
        }
      }
      expect(answerKeyViolations([ROOT], read, bunResolver(dir)).map((v) => v.specifier)).toEqual([
        "./gone",
        "../../outside.ts",
      ])
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  test("a relative import that resolves to no file is a violation naming its chain, not a pass", () => {
    const violations = answerKeyViolations(
      [ROOT],
      reader({ [ROOT]: `import { a } from "./helper.ts"\n`, "scripts/helper.ts": `import "./gone.wasm"\n` }),
    )
    expect(violations.map((v) => [v.file, v.specifier])).toEqual([["scripts/helper.ts", "./gone.wasm"]])
    expect(violations[0]!.why).toContain(`as ${ROOT} -> scripts/helper.ts, imports \`./gone.wasm\`, which resolves to no file`)
  })

  test("the seal, which loads the labels to hash them, is a leak like any other module", async () => {
    // `seal.ts` exports `canonicalLabels()`, the ids, loci, summaries and
    // markers; a writer that could load it could print them.
    const seal = "fixtures/seeded-defects/seal.ts"
    const violations = answerKeyViolations(
      [ROOT],
      reader({
        [ROOT]: `import { canonicalLabels } from "../fixtures/seeded-defects/seal.ts"\n`,
        [seal]: await Bun.file(new URL(`../${seal}`, import.meta.url)).text(),
        "fixtures/seeded-defects/material-seal.ts": "",
        [ANSWER_KEY]: "",
      }),
    )
    expect(violations.map((v) => v.file)).toEqual([seal])
    expect(violations[0]!.why).toContain(`it is reached as ${ROOT} -> ${seal} -> ${ANSWER_KEY}`)
  })

  test("an import line inside a string is data, even when the file it names exists", () => {
    const real = `import { SEEDED_DEFECTS } from "../fixtures/seeded-defects/labels.ts"`
    const files = { [ANSWER_KEY]: "" }
    expect(answerKeyViolations([ROOT], reader({ ...files, [ROOT]: `const s = \`\n${real}\n\`\n` }))).toEqual([])
    expect(answerKeyViolations([ROOT], reader({ ...files, [ROOT]: `const s = "${real.replaceAll('"', "'")}"\n` }))).toEqual([])
    expect(answerKeyViolations([ROOT], reader({ ...files, [ROOT]: `// ${real}\n` }))).toEqual([])
    expect(answerKeyViolations([ROOT], reader({ ...files, [ROOT]: `${real}\n` })).map((v) => v.file)).toEqual([ROOT])
  })

  test("a type-only import loads nothing at run time and is not followed", () => {
    expect(
      answerKeyViolations(
        [ROOT],
        reader({ [ROOT]: `import type { SeededDefect } from "../fixtures/seeded-defects/labels.ts"\n`, [ANSWER_KEY]: "" }),
      ),
    ).toEqual([])
  })

  test("a module in the graph that does not parse is a violation naming its chain", () => {
    const violations = answerKeyViolations(
      [ROOT],
      reader({ [ROOT]: `import { a } from "./broken.ts"\n`, "scripts/broken.ts": "import { from\n" }),
    )
    expect(violations.map((v) => v.file)).toEqual(["scripts/broken.ts"])
    expect(violations[0]!.why).toContain(`as ${ROOT} -> scripts/broken.ts, does not parse`)
  })

  test("a leading `#!` line does not stop the root being read", () => {
    const violations = answerKeyViolations(
      [ROOT],
      reader({ [ROOT]: `#!/usr/bin/env bun\nimport "../fixtures/seeded-defects/labels.ts"\n`, [ANSWER_KEY]: "" }),
    )
    expect(violations.map((v) => v.file)).toEqual([ROOT])
    expect(violations[0]!.why).toContain(`it is reached as ${ROOT} -> ${ANSWER_KEY}`)
  })

  test("a root that cannot be read is a violation, not a pass", () => {
    const violations = answerKeyViolations([ROOT], reader({}))
    expect(violations).toHaveLength(1)
    expect(violations[0]!.why).toContain("could not be read")
  })

  test("the lint entry point fails a real root that reaches the labels, and names the chain", async () => {
    // `fixtures/seeded-defects/arms.ts` loads `change.ts`, which re-exports the labels.
    const errors: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => void errors.push(args.join(" "))
    try {
      expect(await main(["fixtures/seeded-defects/arms.ts"])).toBe(1)
    } finally {
      console.error = original
    }
    expect(errors.join("\n")).toContain(
      `fixtures/seeded-defects/change.ts: imports "./labels.ts" — the answer key must not be loadable by ` +
        "`fixtures/seeded-defects/arms.ts`",
    )
    expect(errors.join("\n")).toContain(
      `it is reached as fixtures/seeded-defects/arms.ts -> fixtures/seeded-defects/change.ts -> ${ANSWER_KEY}`,
    )
  })
})
