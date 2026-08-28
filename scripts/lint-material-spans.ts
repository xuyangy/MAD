#!/usr/bin/env bun
/**
 * AD-18 — `core/prompt/material.ts` is the ONE mechanism, enforced rather than
 * asserted in a comment.
 *
 * `material.ts` opens by claiming to be the one emitter and, until this script,
 * nothing checked it. The claim is load-bearing: a second place that writes a
 * labelled fence line is a second span format that can drift from the first —
 * and a reviewer reading `material.ts` would have no way to know it exists.
 * Recommended by
 * `deferred-work.md` while there were two `runTurn` call sites, and applied at
 * story 6, which adds the judge's own spans.
 *
 * ONE RULE, over EVERY directory that could build a prompt: **no module but
 * `core/prompt/material.ts` emits a span opener** — three or more backticks
 * immediately followed by `material: `.
 *
 * The scope was `core/` alone until code review 2026-08-28, justified with
 * "adapters build no spans — AD-1 makes framing the core's job". That is the
 * assertion this script exists to stop taking on trust, and it left
 * `fixtures/prompt-injection/`, which builds prompts, unread.
 *
 * The second rule `deferred-work.md` asked for — "`MaterialLabel` is the only
 * label source" — is deliberately NOT implemented here, because the type system
 * already enforces it and better. `MaterialLabel` is a closed union, so a label
 * literal at a `material()` call site is checked against it and a stale one is a
 * compile error. Linting the literals instead flagged thirty-seven legitimate
 * call sites and assertions, and would have bought nothing the union does not
 * already guarantee. The gap the union does NOT close is a fence built by hand,
 * which is exactly what is checked below.
 *
 * TEST FILES ARE CHECKED TOO, with two exemptions. A test that hand-builds a
 * span is a test that passes when the mechanism is wrong, which is the failure
 * this guard exists to catch. `core/test-support/fakes.ts` parses spans, so
 * `materialSpans` must be able to recognise a fence; `core/prompt/material.test.ts`
 * is the emitter's own test and asserts the exact bytes it produces.
 *
 *   bun run lint
 */

import { Glob } from "bun"
import { relative, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")

/** The one module allowed to emit a span. */
const OWNER = "core/prompt/material.ts"

/**
 * The span PARSER and the emitter's own TEST (see the header). Neither builds a
 * span for a model to read: one recognises the format, the other pins it.
 */
const EXEMPT = new Set(["core/test-support/fakes.ts", "core/prompt/material.test.ts"])

/**
 * A span opener as `material()` writes it: the fence, then `material: `.
 *
 * Matched anywhere in the source rather than only inside a string literal,
 * because a template literal, a concatenation and a heredoc-ish array join all
 * spell it differently and all produce the same bytes. The cost is that a
 * comment quoting the format verbatim would be flagged too — which is why the
 * header above describes the sequence in words rather than writing it out.
 */
const FENCE_RE = /`{3,}material: /

export interface Violation {
  file: string
  line: number
  why: string
}

/**
 * Exported so the rule is unit-tested rather than merely trusted, the pattern
 * `scanSource` in `lint-dependency-direction.ts` already sets.
 *
 * `file` is repo-relative POSIX, matching the spine's path convention and the
 * exemption set above.
 */
export function scanSource(file: string, source: string): Violation[] {
  if (file === OWNER || EXEMPT.has(file)) return []
  const violations: Violation[] = []

  source.split("\n").forEach((text, index) => {
    if (FENCE_RE.test(text)) {
      violations.push({
        file,
        line: index + 1,
        why: `emits a material fence — only ${OWNER} may (AD-18)`,
      })
    }
  })

  return violations
}

export async function main(): Promise<number> {
  const violations: Violation[] = []
  let checked = 0

  // EVERY DIRECTORY THAT COULD BUILD A PROMPT (code review 2026-08-28). This was
  // `core/**/*.ts`, justified in the header with "adapters build no spans — AD-1
  // makes framing the core's job" — which is precisely the assertion the script
  // exists to stop taking on trust. `fixtures/prompt-injection/` builds prompts
  // and was never read.
  const glob = new Glob("{core,adapters,fixtures,scripts}/**/*.ts")
  for await (const path of glob.scan({ cwd: ROOT })) {
    const absolute = resolve(ROOT, path)
    const source = await Bun.file(absolute).text()
    checked += 1
    violations.push(...scanSource(relative(ROOT, absolute).replaceAll("\\", "/"), source))
  }

  if (violations.length > 0) {
    console.error("AD-18 material-span violations:\n")
    for (const violation of violations) {
      console.error(`  ${violation.file}:${violation.line} — ${violation.why}`)
    }
    console.error(`\n${violations.length} violation(s) in ${checked} scanned file(s).`)
    return 1
  }

  console.log(`AD-18 material spans OK — one emitter, ${checked} file(s) checked.`)
  return 0
}

if (import.meta.main) process.exit(await main())
