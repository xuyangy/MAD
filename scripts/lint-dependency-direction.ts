#!/usr/bin/env bun
/**
 * AD-1 — the dependency-direction rule, and it must fail CI.
 *
 * No module under `core/` may import from `adapters/`, from the top-level
 * `fixtures/` tree, from `@opencode-ai/*`, or from any other harness SDK.
 * Adapters implement `core/ports` interfaces and the entrypoint injects them;
 * fixtures drive the core from outside it. The arrow never points the other way.
 *
 * This is the `eslint.config.js (or equivalent)` the story asks for, written as
 * an equivalent so the rule needs no plugin toolchain to run in CI:
 *   bun run lint
 */

import { Glob } from "bun"
import { dirname, join, relative, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")

/** Specifier prefixes no file under `core/` may import. */
const FORBIDDEN_FOR_CORE: { pattern: RegExp; why: string }[] = [
  { pattern: /^\.\.\/(\.\.\/)*adapters\//, why: "core must not import from adapters/" },
  { pattern: /(^|\/)adapters\//, why: "core must not import from adapters/" },
  // AD-1's direction rule over the top-level `fixtures/` tree. `fixtures/` may
  // import `core/` — the recall harness drives `review()` — and the arrow never
  // points back, so seeded-defect data, scripted answers and test-only helpers
  // cannot end up shipped inside a stage.
  //
  // AD-1's direction rule over the top-level `fixtures/` tree, for NON-relative
  // specifiers only. Every relative form is decided exactly by `escapesTo`
  // below, which resolves the path instead of guessing at its prefix — an
  // anchored `^\.\./fixtures/` both missed real escapes
  // (`"../clustering/../../fixtures/x"`) and flagged legitimate ones
  // (`"../fixtures/x"` from `core/clustering/` is `core/fixtures/`, inside core).
  // AD-14 has clustering's own harness shipping WITH the engine, so a fixture
  // tree inside `core/` is legitimate; what is forbidden is reaching the
  // top-level one.
  { pattern: /^fixtures(\/|$)/, why: "core must not import from fixtures/" },
  { pattern: /^ablation(\/|$)/, why: "core must not import from ablation/" },
  { pattern: /^@opencode-ai\//, why: "core must not import a harness SDK (@opencode-ai/*)" },
  { pattern: /^opencode(\/|$)/, why: "core must not import a harness SDK" },
  { pattern: /^@anthropic-ai\//, why: "core must not import a harness SDK" },
  { pattern: /^@openai\/|^openai$/, why: "core must not import a harness SDK" },
]

/**
 * Four forms, and the first two must tolerate newlines: a multi-line
 * `import {\n  A,\n  B,\n} from "x"` is the style this codebase already writes,
 * so a rule that only matched single-line imports left AD-1 enforceable in
 * theory and porous in practice. `[\s\S]` rather than `.` is the whole point.
 *
 *   1. static  import/export ... from "x"   (may span lines)
 *   2. bare    import "x"                   (side-effect, no `from` clause)
 *   3. dynamic import("x")
 *   4. require("x")
 */
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s[\s\S]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|(?:^|[^\w.])import\s*\(\s*["']([^"']+)["']\s*\)|(?:^|[^\w.])require\s*\(\s*["']([^"']+)["']\s*\)/g

export interface Violation {
  file: string
  specifier: string
  why: string
}

/** Top-level trees a module under `core/` may never reach into. */
const FORBIDDEN_TREES = [
  { tree: "fixtures", why: "core must not import from fixtures/" },
  { tree: "adapters", why: "core must not import from adapters/" },
  // Story 9 — the fourth top-level tree. CAP-9's ablation drives `core/` from
  // outside it, exactly as `fixtures/` does, and the arrow never points back: a
  // measurement harness reachable from inside a stage would let an experiment's
  // scaffolding ship inside the tool it is measuring.
  { tree: "ablation", why: "core must not import from ablation/" },
] as const

/**
 * Resolve a RELATIVE specifier against the importing file and report the
 * top-level tree it actually lands in.
 *
 * A prefix pattern can only see the specifier as written, so
 * `"../clustering/../../fixtures/recall.ts"` reads as `../clustering/…` and
 * escapes every anchor — while resolving to `fixtures/recall.ts` all the same.
 * Resolution is exact where a pattern is a guess, and it keeps AD-14's
 * `core/clustering/fixtures/` legitimate for free: that one resolves to a path
 * under `core/`, not to the top-level tree.
 */
function escapesTo(file: string, specifier: string): { why: string } | undefined {
  if (!specifier.startsWith(".")) return undefined
  const resolved = join(dirname(file), specifier).replaceAll("\\", "/")
  for (const { tree, why } of FORBIDDEN_TREES) {
    if (resolved === tree || resolved.startsWith(`${tree}/`)) return { why }
  }
  return undefined
}

/** Exported so the rule itself is unit-tested rather than merely trusted. */
/**
 * `core/budget/limiter.ts` MUST IMPORT NOTHING (code review 2026-08-31).
 *
 * `core/domain/run-record.ts` imports `DEFAULT_MAX_CONCURRENCY` from it, while
 * `core/budget/ledger.ts` imports from `domain/` — so domain and budget point at
 * each other, and the only reason there is no cycle is that this one file has no
 * imports at all. That was a property promised in a doc comment and enforced by
 * nothing, which is the shape of every layering rule that eventually breaks. It
 * is a rule now, checked in the same pass as AD-1's, because the cost of it
 * failing is a module cycle that surfaces as an undefined constant at import
 * time rather than as an error anyone can read.
 */
const MUST_NOT_IMPORT: ReadonlySet<string> = new Set([
  "core/budget/limiter.ts",
  // Story 8, and the same cycle for the same reason: `core/domain/run-record.ts`
  // imports `SpendShares` from it while `core/budget/ledger.ts` imports from
  // `core/domain/`. A SET rather than a second string because the property is
  // "these files import nothing", and a rule written once per file is a rule
  // somebody adds a third file to without noticing the second.
  "core/budget/presets.ts",
])

/**
 * AD-15 — the internals of the budget's stage shares, which a STAGE may not
 * touch.
 *
 * A stage may ASK the accountant (`mayISpend`) and may ask it to phrase the
 * answer (`ceilingClause`, `ceilingNamed`). A stage that reads `ledger.shares`
 * and multiplies by the cap is a stage doing its own budget arithmetic, which is
 * exactly what AD-15's first sentence forbids and what makes two authorities on
 * "may I spend?" possible again. `budgetReport` is the renderer's one door: it
 * returns finished figures, so `core/stages/output.ts` can print the BUDGET
 * block without computing any part of it.
 *
 * Story 7A's commit records the general case: a layering property promised in
 * prose and enforced by nothing is the shape that breaks.
 */
const STAGE_MUST_NOT_METER = [
  "stageCeiling",
  "spentInStage",
  "clampSpendShares",
  "CUMULATIVE_SHARE",
  "ledger.shares",
]

export function scanSource(file: string, source: string): Violation[] {
  const violations: Violation[] = []
  const unix = file.replaceAll("\\", "/")

  // AD-15 — ONE ACCOUNTANT, AND NO STAGE BUILDS ITS OWN (code review
  // 2026-08-31). `review()` constructs the run's single limiter; a stage
  // constructing one would make the peak `stages x limit`, which is not a peak.
  // Story 7A stated this property in prose and tested nothing, so this is the
  // clause that makes it real. Checked ONCE per file, not once per import.
  if (unix.startsWith("core/stages/") && !unix.endsWith(".test.ts") && /\bcreateLimiter\b/.test(source)) {
    violations.push({
      file,
      specifier: "createLimiter",
      why:
        `AD-15 — a stage must not construct a limiter. \`core/run/review.ts\` creates the one ` +
        `limiter for the whole run; a limiter per stage would make the peak \`stages x limit\`. ` +
        `Take one through \`DiscoverInput\`/\`DebateInput\`/\`JudgeInput\` instead.`,
    })
  }

  // AD-15 — AND NO STAGE METERS ITSELF (story 8). Same shape as the clause
  // above, same reason, one file check rather than one per import.
  if (unix.startsWith("core/stages/") && !unix.endsWith(".test.ts")) {
    for (const symbol of STAGE_MUST_NOT_METER) {
      // `ledger.shares` carries a dot, so it is matched literally; the bare
      // identifiers get word boundaries so `stageCeilingFoo` is not a false hit.
      const pattern = symbol.includes(".")
        ? new RegExp(symbol.replaceAll(".", "\\."))
        : new RegExp(`\\b${symbol}\\b`)
      if (!pattern.test(source)) continue
      violations.push({
        file,
        specifier: symbol,
        why:
          `AD-15 — a stage must not do budget arithmetic. \`${symbol}\` is an internal of the ` +
          `accountant's stage shares. Ask \`mayISpend(ledger, stage)\`, phrase a refusal with ` +
          `\`ceilingClause\`/\`ceilingNamed\`, and render figures from \`budgetReport\` — all ` +
          `three return finished answers, so no stage has to compute a ceiling.`,
      })
    }
  }

  IMPORT_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = IMPORT_RE.exec(source)) !== null) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4]
    if (!specifier) continue

    if (MUST_NOT_IMPORT.has(unix)) {
      violations.push({
        file,
        specifier,
        why:
          `\`${unix}\` must import nothing. \`core/domain/run-record.ts\` imports from it and ` +
          `\`core/budget/ledger.ts\` imports from \`core/domain/\`; this file having no imports ` +
          `is the only thing keeping that from being a cycle. Move what you need into ` +
          `\`core/domain/\` instead of importing here.`,
      })
      continue
    }

    const escaped = escapesTo(file, specifier)
    if (escaped) {
      violations.push({ file, specifier, why: escaped.why })
      continue
    }

    for (const rule of FORBIDDEN_FOR_CORE) {
      if (rule.pattern.test(specifier)) {
        violations.push({ file, specifier, why: rule.why })
        break
      }
    }
  }
  return violations
}

export async function main(): Promise<number> {
  const violations: Violation[] = []
  let checked = 0

  const glob = new Glob("core/**/*.ts")
  for await (const path of glob.scan({ cwd: ROOT })) {
    const absolute = resolve(ROOT, path)
    const source = await Bun.file(absolute).text()
    checked += 1
    violations.push(...scanSource(relative(ROOT, absolute), source))
  }

  if (violations.length > 0) {
    console.error("AD-1 dependency-direction violations:\n")
    for (const violation of violations) {
      console.error(`  ${violation.file}: imports "${violation.specifier}" — ${violation.why}`)
    }
    console.error(`\n${violations.length} violation(s) in ${checked} file(s) under core/.`)
    return 1
  }

  console.log(
    `AD-1 dependency direction OK — ${checked} file(s) under core/ checked ` +
      `(${[...MUST_NOT_IMPORT].map((f) => `\`${f}\``).join(" and ")} import nothing; ` +
      `no stage builds a limiter or meters its own budget).`,
  )
  return 0
}

// Only run (and only exit) when invoked as the CLI, so the rule can be tested.
if (import.meta.main) process.exit(await main())
