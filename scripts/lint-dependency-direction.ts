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
export function scanSource(file: string, source: string): Violation[] {
  const violations: Violation[] = []
  IMPORT_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = IMPORT_RE.exec(source)) !== null) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4]
    if (!specifier) continue

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

  console.log(`AD-1 dependency direction OK — ${checked} file(s) under core/ checked.`)
  return 0
}

// Only run (and only exit) when invoked as the CLI, so the rule can be tested.
if (import.meta.main) process.exit(await main())
