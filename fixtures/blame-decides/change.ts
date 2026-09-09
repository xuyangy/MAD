/**
 * CAP-8's success clause, as a fixture: a confidently asserted claim whose
 * PREMISE `git blame` settles.
 *
 * > "A finding is decided by a `git blame` citation that contradicts a
 * > confidently asserted claim, and the citation appears in the output as the
 * > deciding evidence."
 *
 * That clause had never been produced by anything in this repository before
 * story 10 — no test asserted it, no fixture produced it, and no rendered run
 * had ever contained one.
 *
 * ## Why the claim is shaped the way it is
 *
 * A claim blame can decide has to be a claim ABOUT THE HISTORY, not about the
 * code's behaviour — blame cannot tell you whether a retry loop is correct, and
 * a fixture pretending otherwise would be proving something the tool cannot do.
 * So the reviewer here asserts a PREMISE: that the retry loop is brand new,
 * introduced by this very change, and therefore unproven in production. That is
 * exactly the kind of confident, plausible, load-bearing assertion a reviewer
 * makes from a diff alone — the diff really does show the loop being added — and
 * it is exactly the kind `git blame` either confirms or destroys.
 *
 * ## The PAIR is the whole point
 *
 * One fixture proves nothing: a run that always rules a finding invalid rules it
 * invalid whatever the blame said. So there are two blame outputs over one
 * change, one contradicting the premise and one supporting it, and the pipeline
 * must reach OPPOSITE verdicts. Everything else about the two runs is identical,
 * down to the scripted model's own logic — which reads the blame body out of the
 * prompt exactly as a real model would.
 *
 * ## Why it is SEPARATE from the other two fixtures
 *
 * `fixtures/seeded-defects/` is CAP-1's recall baseline and CAP-11's lens-gain
 * baseline, and `fixtures/prompt-injection/` is AD-18's. Adding to either would
 * move numbers those fixtures exist to hold still. A new fixture is additive;
 * editing one of those is not. (The same argument `prompt-injection/change.ts`
 * makes for its own existence.)
 */

import type { ChangeSet } from "../../core/ports/repo.ts"

export const BLAME_FILE = "src/payments/retry.ts"

/**
 * The change: a bare call replaced by a retry loop with exponential backoff.
 *
 * Read from the diff alone, the loop is unambiguously NEW — the `-` line is the
 * whole old body. That reading is what the reviewer below commits to, and it is
 * what a diff can never actually establish: a diff says what this change did to
 * the file, and says nothing about whether the same lines existed, were removed,
 * and are now being restored.
 */
export const BLAME_CHANGE: ChangeSet = {
  description: "working tree (git diff HEAD)",
  files: [BLAME_FILE],
  diff: [
    `--- a/${BLAME_FILE}`,
    `+++ b/${BLAME_FILE}`,
    `@@ -1,6 +1,14 @@`,
    ` import { chargeCard } from "./gateway.ts"`,
    ` `,
    ` export async function chargeWithRetry(card: Card, amount: number): Promise<Receipt> {`,
    `-  return chargeCard(card, amount)`,
    `+  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {`,
    `+    try {`,
    `+      return await chargeCard(card, amount)`,
    `+    } catch (error) {`,
    `+      if (attempt === MAX_ATTEMPTS - 1) throw error`,
    `+      await sleep(BASE_DELAY_MS * 2 ** attempt)`,
    `+    }`,
    `+  }`,
    `+  throw new Error("unreachable")`,
    ` }`,
    ``,
  ].join("\n"),
}

/**
 * The two anchors the locus is DERIVED from, so no line number is written down
 * twice.
 *
 * `fixtures/seeded-defects/recall.test.ts` learned this the expensive way: its
 * defect loci were hardcoded in one file and the diff in another, and editing
 * the diff left the suite green while the fixture rotted. Here the finding's
 * `startLine`/`endLine` are computed from the diff's own text by
 * `blameLocus()`, and the anchors below are the only things stated by hand.
 */
export const LOCUS_FIRST_LINE = "for (let attempt = 0;"
export const LOCUS_LAST_LINE = `throw new Error("unreachable")`

/**
 * Post-change line numbering for a unified diff — the same reader
 * `fixtures/seeded-defects/recall.test.ts` uses, for the same reason: the
 * fixture's line numbers must come from the fixture's own text.
 */
export function postChangeLines(diff: string): Map<string, Map<number, string>> {
  const files = new Map<string, Map<number, string>>()
  let current: Map<number, string> | undefined
  let lineNo = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) continue
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//, "")
      current = files.get(path) ?? new Map<number, string>()
      files.set(path, current)
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      lineNo = Number(hunk[1]) - 1
      continue
    }
    if (!current) continue
    if (line.startsWith("-")) continue
    lineNo += 1
    current.set(lineNo, line.slice(1))
  }
  return files
}

/** The locus the reviewer cites, derived from the diff rather than asserted. */
export function blameLocus(): { file: string; startLine: number; endLine: number } {
  const lines = postChangeLines(BLAME_CHANGE.diff).get(BLAME_FILE)
  if (lines === undefined) throw new Error(`${BLAME_FILE} is not in the fixture diff`)

  let startLine: number | undefined
  let endLine: number | undefined
  for (const [number, text] of lines) {
    if (text.includes(LOCUS_FIRST_LINE)) startLine = number
    if (text.includes(LOCUS_LAST_LINE)) endLine = number
  }
  if (startLine === undefined || endLine === undefined) {
    throw new Error("the locus anchors are no longer in the fixture diff")
  }
  return { file: BLAME_FILE, startLine, endLine }
}

/**
 * The finding, exactly as a discovery model would report it — confident, in the
 * present tense, and resting on a premise the diff cannot support.
 */
export const BLAME_DEFECT = {
  claim:
    "The retry loop is introduced by this change and has never run in production, so its backoff " +
    "constants are unvalidated against a real gateway.",
  reasoning:
    "The diff replaces the entire old body with the loop, so every line of it is new. Nothing " +
    "here has ever been exercised against a live payment gateway, and BASE_DELAY_MS * 2 ** " +
    "attempt is a guess until it has been.",
  severity: "high" as const,
}

// ---------------------------------------------------------------------------
// The two blame outputs. `git blame --porcelain` as the adapter returns it.
// ---------------------------------------------------------------------------

const OLD_SHA = "9c4e1b7a2f0d3e5c6b8a1907f2e3d4c5b6a70819"
const NEW_SHA = "1f2e3d4c5b6a70819c4e1b7a2f0d3e5c6b8a1907"

/** The subject that settles it, quoted by the test so the fixture cannot drift. */
export const CONTRADICTING_SUBJECT = "back off exponentially after the 2023-11 gateway outage"
export const SUPPORTING_SUBJECT = "wip: first cut of a retry loop, untested"

function porcelain(
  sha: string,
  author: string,
  authorTime: number,
  summary: string,
  lines: readonly { number: number; text: string }[],
): string {
  return lines
    .map((line, index) =>
      [
        `${sha} ${line.number} ${line.number} 1`,
        // Porcelain emits the metadata block for a commit's FIRST line only.
        // Emitting it every time would let a parser that resets per entry pass,
        // which is the trap `core/judge/blame.test.ts` pins.
        ...(index === 0
          ? [
              `author ${author}`,
              `author-mail <${author.toLowerCase().replace(/ /g, ".")}@example.com>`,
              `author-time ${authorTime}`,
              `author-tz +0000`,
              `summary ${summary}`,
            ]
          : []),
        `filename ${BLAME_FILE}`,
        `\t${line.text}`,
      ].join("\n"),
    )
    .join("\n")
}

function blamedLines(): { number: number; text: string }[] {
  const { startLine, endLine } = blameLocus()
  const lines = postChangeLines(BLAME_CHANGE.diff).get(BLAME_FILE)!
  const out: { number: number; text: string }[] = []
  for (let number = startLine; number <= endLine; number += 1) {
    out.push({ number, text: lines.get(number) ?? "" })
  }
  return out
}

/**
 * ARM A — blame CONTRADICTS the claim.
 *
 * The lines the reviewer says are new were last touched in November 2023, by a
 * commit whose subject says the backoff was added in response to a real outage.
 * The premise "introduced by this change and never run in production" is false,
 * and everything the finding concluded from it goes with it.
 */
export const CONTRADICTING_BLAME = porcelain(
  OLD_SHA,
  "Ada Lovelace",
  1699000000, // 2023-11-03
  CONTRADICTING_SUBJECT,
  blamedLines(),
)

/**
 * ARM B — blame SUPPORTS the claim.
 *
 * Identical in every respect except what the repository actually says: the same
 * lines are brand new, uncommitted work with a subject that admits as much. The
 * reviewer's premise holds, and the finding stands.
 *
 * Without this half, arm A proves nothing — a pipeline that always rules the
 * finding invalid would pass it.
 */
export const SUPPORTING_BLAME = porcelain(
  NEW_SHA,
  "Grace Hopper",
  1757289600, // 2025-09-08
  SUPPORTING_SUBJECT,
  blamedLines(),
)
