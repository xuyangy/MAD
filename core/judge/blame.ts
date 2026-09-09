/**
 * `git blame --porcelain`, turned into a citation a reader can act on (CAP-8,
 * story 10).
 *
 * ## Why parse it at all
 *
 * The adapter asks for `--porcelain` rather than the default human format
 * because the default's columns are locale- and terminal-width dependent, and a
 * citation MAD renders into its own report has to be stable. Porcelain is
 * stable and unreadable, so exactly one place turns it into rows: here.
 *
 * ## Every cell is one line, by construction
 *
 * A blamed line's text, an author name and a commit subject are all REPOSITORY
 * TEXT — written by whoever wrote the commit, which under AD-18 is material and
 * not MAD's voice. The rows below are MAD's frame around those cells, so each
 * cell goes through `oneLine` for the reason every other MAD-owned row's cells
 * do: a `\n`, a `\r` or a U+2028 in a commit subject would otherwise forge a
 * second row in MAD's own shape. The BLOCK still travels inside an AD-18 span
 * wherever a model reads it — escaping cells is not a substitute for the span,
 * it is what makes the block safe to indent into the rendered report a human
 * also reads.
 *
 * ## It is bounded
 *
 * A finding may legitimately cite a wide range, and `-L 1,20000` over a large
 * file would put twenty thousand rows into a prompt and into the report. The cap
 * is stated in the output rather than applied silently — a truncation nobody is
 * told about is the AD-6 failure in miniature.
 */

import { oneLine } from "../prompt/material.ts"

/** One blamed line, as porcelain reports it. */
export interface BlameLine {
  /** The commit sha, full. Rendered abbreviated. */
  sha: string
  /** Final-file line number, 1-indexed. */
  line: number
  author: string
  /** `author-time` as a UTC date, `YYYY-MM-DD`. Empty when git reported none. */
  date: string
  /** The commit subject line. */
  summary: string
  /** The source line itself. */
  text: string
}

/**
 * The most rows one citation may carry. Sized so a citation stays a citation:
 * a finding whose locus spans more lines than this is not pointing at a line,
 * and the rows that ARE shown plus a stated count is more use than either a
 * truncation nobody mentions or a prompt made mostly of blame output.
 */
export const MAX_BLAME_ROWS = 40

/**
 * THE HISTORY `kind` STRINGS THIS ROUTE WRITES, named once (ledger triage
 * 2026-09-09).
 *
 * `Entry.kind` is typed `string`, so these were written by hand in
 * `core/stages/judge.ts` and matched by hand in `core/stages/output.ts` — a typo
 * on either side failing silently rather than at build time, in the block whose
 * whole content is that four outcomes must never render as each other. Story 10
 * doubled the number of them, which is what made the convention worth breaking
 * here first.
 *
 * SCOPED TO THE BLAME ROUTE. `judge-anonymized` and `judge-not-examined` are the
 * same shape and are left alone: they belong to a tree-wide refactor of every
 * `kind` in the judge, which is a bigger change than the one this fixes.
 */
export const BLAME_KIND = {
  executed: "judge-blame-executed",
  failed: "judge-blame-failed",
  noLocus: "judge-blame-no-locus",
  noPort: "judge-blame-no-port",
} as const

/** Length of the abbreviated sha in a rendered row. Git's own default. */
const SHA_WIDTH = 8

/**
 * Parse `git blame --porcelain` output.
 *
 * The format: a header line `<sha> <origline> <finalline> [<numlines>]`, then
 * key/value lines for the FIRST appearance of that commit only, then exactly one
 * tab-prefixed line carrying the source text. Later lines from a commit already
 * seen repeat the header and the tab line and omit the metadata — which is why
 * the commit table below is remembered across the whole parse rather than reset
 * per entry. A parser that expected the metadata every time would render every
 * repeated commit as an unknown author.
 *
 * Unparseable input yields an EMPTY list rather than a throw: garbage from git
 * is not the same failure as git refusing to run, and the caller reports the two
 * differently (an empty citation is not offered as evidence).
 */
export function parseBlamePorcelain(porcelain: string): BlameLine[] {
  const lines = porcelain.split("\n")
  const commits = new Map<string, { author: string; date: string; summary: string }>()
  const out: BlameLine[] = []

  let sha: string | undefined
  let finalLine = 0

  for (const raw of lines) {
    const header = /^([0-9a-f]{7,40}) \d+ (\d+)(?: \d+)?$/.exec(raw)
    if (header) {
      sha = header[1]!
      finalLine = Number(header[2])
      if (!commits.has(sha)) commits.set(sha, { author: "", date: "", summary: "" })
      continue
    }
    if (sha === undefined) continue
    const commit = commits.get(sha)!

    if (raw.startsWith("\t")) {
      out.push({
        sha,
        line: finalLine,
        author: commit.author,
        date: commit.date,
        summary: commit.summary,
        text: raw.slice(1),
      })
      sha = undefined
      continue
    }

    const space = raw.indexOf(" ")
    const key = space === -1 ? raw : raw.slice(0, space)
    const value = space === -1 ? "" : raw.slice(space + 1)
    if (key === "author") commit.author = value
    else if (key === "summary") commit.summary = value
    else if (key === "author-time") {
      // AN EMPTY VALUE IS NOT A DATE, and `Number("")` is `0` (code review
      // 2026-09-09). `0` is finite, so a blank or whitespace-only `author-time`
      // used to render as `1970-01-01` — MAD inventing a date and putting it
      // inside a citation, which is the one thing a citation must never contain.
      // Absent and blank now behave the same: no date rather than a made-up one.
      const seconds = value.trim().length === 0 ? Number.NaN : Number(value)
      // UTC, matching the spine's timestamp convention. `author-tz` is
      // deliberately not applied: a citation whose dates are each in a different
      // committer's local zone cannot be read in order.
      //
      // `Number.isFinite` IS NOT ENOUGH, and this file's own header promised
      // otherwise (code review 2026-09-09). `author-time 99999999999999` is a
      // finite number whose milliseconds land outside the range `Date` can
      // represent, so `toISOString()` threw `RangeError` — breaking the "garbage
      // yields an EMPTY list rather than a throw" contract stated above, and
      // surfacing in `judge.ts` as a caught `blame-unavailable` warning that
      // blames GIT for what is a parser bug. `Date`'s representable range is
      // ±8.64e15 ms; anything outside it is garbage and reads as no date.
      const ms = seconds * 1000
      commit.date =
        Number.isFinite(ms) && Math.abs(ms) <= 8.64e15
          ? new Date(ms).toISOString().slice(0, 10)
          : ""
    }
  }

  return out
}

/**
 * The citation body: MAD-authored rows around repository cells.
 *
 * `path` and the line numbers are echoed back because a citation with no subject
 * is unreadable on its own — the path is a discovery model's free string, so it
 * is escaped like every other cell.
 */
export function renderBlameCitation(
  path: string,
  startLine: number,
  endLine: number,
  blamed: readonly BlameLine[],
): string {
  const head = `\`git blame\` over ${oneLine(path)} lines ${startLine}-${endLine}, run by MAD:`
  // NOT REACHED FROM THE JUDGE, and that is settled rather than accidental
  // (ledger triage 2026-09-09). `core/stages/judge.ts` treats zero blamed lines
  // as `judge-blame-failed` — git ran and said nothing usable is a FAILURE to
  // check, not a check that found nothing — so the stage never calls this with
  // an empty list. The branch stays because this is an exported pure function
  // and a total one: a caller that does pass an empty list must get a sentence
  // that cannot be read as "the history is consistent with the claim". It is
  // NOT a second opinion about what an empty blame means; the judge's is the
  // one that ships.
  if (blamed.length === 0) {
    return `${head}\n  (git reported no blamed lines for that range)`
  }

  const shown = blamed.slice(0, MAX_BLAME_ROWS)
  const rows = shown.map((entry) => {
    const who = [entry.author, entry.date].filter((part) => part.length > 0).join(" ")
    return `  ${entry.sha.slice(0, SHA_WIDTH)} (${oneLine(who || "unknown")}) ${entry.line}: ${oneLine(entry.text)}`
  })

  // TRUNCATION IS STATED, never silent (AD-6 in miniature).
  const clipped =
    blamed.length > shown.length
      ? [`  … ${blamed.length - shown.length} further blamed line(s) not shown.`]
      : []

  // The commit subjects, once each, in first-seen order. This is the half of a
  // blame that most often contradicts a confident claim — "this was never
  // handled" against a commit whose subject says it was handled — so it is a
  // labelled section rather than a column nobody reads.
  const seen = new Set<string>()
  const subjects: string[] = []
  for (const entry of shown) {
    if (seen.has(entry.sha)) continue
    seen.add(entry.sha)
    if (entry.summary.trim().length === 0) continue
    subjects.push(`  ${entry.sha.slice(0, SHA_WIDTH)} — ${oneLine(entry.summary)}`)
  }

  return [
    head,
    ...rows,
    ...clipped,
    ...(subjects.length > 0 ? ["", "Commits behind those lines:", ...subjects] : []),
  ].join("\n")
}
