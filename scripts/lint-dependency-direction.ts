#!/usr/bin/env bun
/**
 * AD-1 — the dependency-direction rule, and it must fail CI.
 *
 * No module under `core/` may import from `adapters/`, from `@opencode-ai/*`,
 * or from any other harness SDK. Adapters implement `core/ports` interfaces and
 * the entrypoint injects them; the arrow never points the other way.
 *
 * This is the `eslint.config.js (or equivalent)` the story asks for, written as
 * an equivalent so the rule needs no plugin toolchain to run in CI:
 *   bun run lint
 */

import { Glob } from "bun"
import { relative, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")

/** Specifier prefixes no file under `core/` may import. */
const FORBIDDEN_FOR_CORE: { pattern: RegExp; why: string }[] = [
  { pattern: /^\.\.\/(\.\.\/)*adapters\//, why: "core must not import from adapters/" },
  { pattern: /(^|\/)adapters\//, why: "core must not import from adapters/" },
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

/** Exported so the rule itself is unit-tested rather than merely trusted. */
export function scanSource(file: string, source: string): Violation[] {
  const violations: Violation[] = []
  IMPORT_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = IMPORT_RE.exec(source)) !== null) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4]
    if (!specifier) continue
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
