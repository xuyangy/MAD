/**
 * The materialized tree, proved honest against real `git` (story 2.4, Task 8).
 *
 * Three claims, and the middle one is the reason this file exists at all:
 *
 * 1. **Round trip.** Re-diffing the materialized tree reproduces
 *    `SEEDED_CHANGE.diff`. Drift between `BASE_TREE` and the diff fails HERE,
 *    on a CI run that costs nothing, rather than on a live run that bills.
 * 2. **Leak check.** No file under the materialized tree contains a defect id or
 *    a summary, and no marker reaches it that `material.ts` did not already
 *    carry. That is AC2 as an assertion — "a model that can read the answer key
 *    measures nothing" — and it is the one claim a comment in the materializer
 *    cannot carry, because the failure mode is a future edit that adds one
 *    import. The marker half is a containment claim rather than an absence one,
 *    and the test that makes it says at length why.
 * 3. **Refusal.** A relative `--out` and an `--out` inside this repository are
 *    both refused, and neither writes anything.
 *
 * This test drives real `git` in a temp directory, as the story's testing
 * standards require, and reaches no network and no provider.
 *
 * ## What "round trip" means here, exactly
 *
 * The story's task says "`git diff --unified=8 HEAD` plus the untracked-file
 * handling equals `SEEDED_CHANGE.diff` byte for byte". Taken literally that is
 * unachievable, and the deviation is recorded rather than papered over — see the
 * `normalize` comment below for the three reasons and for what is compared
 * instead, which is strictly stronger on the property that matters.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { main as materializeMain, parseGitVersion } from "./materialize-labelled-change.ts"
import { BASE_TREE, SEEDED_CHANGE } from "../fixtures/seeded-defects/material.ts"
import { SEEDED_DEFECTS } from "../fixtures/seeded-defects/labels.ts"

const REPO_ROOT = resolve(import.meta.dir, "..")

const scratch: string[] = []

afterEach(async () => {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})

/** A directory that does NOT yet exist, inside one that will be cleaned up. */
async function freshOut(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "mad-materialize-"))
  scratch.push(parent)
  return join(parent, "tree")
}

async function captured(run: () => Promise<number>): Promise<{ code: number; text: string }> {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "))
  }
  try {
    return { code: await run(), text: lines.join("\n") }
  } finally {
    console.log = original
  }
}

/**
 * `env` is a parameter because `process.env` mutations do NOT reach `Bun.spawn`
 * — it snapshots the environment at startup — so the only way to hand a spawned
 * git a different `GIT_CONFIG_GLOBAL` is to pass one.
 */
async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const spawned = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  })
  const stdout = await new Response(spawned.stdout).text()
  await spawned.exited
  return stdout
}

/**
 * Split a unified diff into one normalized section per file.
 *
 * THREE DEVIATIONS FROM "BYTE FOR BYTE", each forced by git and each recorded
 * rather than hidden:
 *
 * 1. **`--unified=3`, not 8.** The fixture's `ledger.ts` hunk is
 *    `@@ -12,6 +12,12 @@` — three leading context lines. `--unified=8` asks git
 *    for eight, so the SAME tree re-diffs as `@@ -7,11 +7,17 @@`. The fixture's
 *    hunk shape IS three lines of context, so three is what reproduces it.
 *    `adapters/opencode/repo.ts` reads a live change at `--unified=8`, and that
 *    is unaffected: more context around an identical change is still the identical
 *    change.
 * 2. **git's own file headers are dropped** — `diff --git`, `index <hash>`,
 *    `new file mode`. They carry blob hashes and a mode, neither of which the
 *    hand-written fixture has ever contained.
 * 3. **A context line that is exactly one space becomes empty.** Git writes an
 *    empty context line as `" "`; the fixture writes it as `""`. `git apply`
 *    accepts both, which is why the fixture applies cleanly in the first place.
 *
 * What survives all three is the whole of the claim: the `---`/`+++` headers, the
 * `@@` hunk headers INCLUDING their line numbers and funcname text, and every
 * context, added and removed line. If `BASE_TREE` drifted so that the hunk landed
 * on different lines, or the funcname above it changed, or one byte of the change
 * moved, the comparison below fails.
 */
function normalize(diff: string): Map<string, string> {
  const sections = new Map<string, string>()
  let file: string | undefined
  let buffer: string[] = []

  const flush = () => {
    if (file !== undefined) sections.set(file, buffer.join("\n").replace(/\n+$/, ""))
    buffer = []
    file = undefined
  }

  for (const line of diff.split("\n")) {
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("index ") ||
      line.startsWith("new file mode ") ||
      line.startsWith("deleted file mode ")
    ) {
      continue
    }
    if (line.startsWith("--- ")) flush()
    if (line.startsWith("+++ ")) file = line.slice(4).replace(/^b\//, "")
    buffer.push(line === " " ? "" : line)
  }
  flush()
  return sections
}

/** Re-diff a materialized tree exactly as `repo.change()` does, at `--unified=3`. */
async function rediff(root: string): Promise<string> {
  const tracked = await git(root, ["diff", "--unified=3", "HEAD", "--"])
  const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard"]))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  let added = ""
  for (const file of untracked) {
    added += await git(root, ["diff", "--unified=3", "--no-index", "--", "/dev/null", file])
  }
  return tracked + added
}

async function everyFile(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      // `.git` holds the base commit's own blobs, which are the BASE tree — not
      // the labels — but it is machine-written and not worth walking.
      if (entry.name === ".git") continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else found.push(path)
    }
  }
  await walk(root)
  return found
}

describe("the materialized tree round-trips to the fixture diff", () => {
  test("every file's hunks come back identical, headers and line numbers included", async () => {
    const out = await freshOut()
    const { code } = await captured(() => materializeMain(["bun", "materialize", "--out", out]))
    expect(code).toBe(0)

    const expected = normalize(SEEDED_CHANGE.diff)
    const actual = normalize(await rediff(out))

    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort())
    for (const [file, text] of expected) {
      expect(actual.get(file)).toBe(text)
    }
  })

  test("the base tree is ONE commit and the change is UNCOMMITTED", async () => {
    const out = await freshOut()
    await captured(() => materializeMain(["bun", "materialize", "--out", out]))

    // This is what makes `repo.change()` with no `--target` see the change: the
    // working-tree path is `git diff HEAD` plus untracked files. Commit the
    // change and a live run reviews an empty diff while everything still looks
    // fine.
    const log = await git(out, ["rev-list", "--count", "HEAD"])
    expect(log.trim()).toBe("1")

    const status = await git(out, ["status", "--porcelain"])
    expect(status).toContain(" M src/billing/ledger.ts")
    expect(status).toContain("?? src/billing/refund.ts")
    expect(status).toContain("?? src/billing/refund-notice.ts")
  })

  test("the round-trip assertion can FAIL — an edited tree does not satisfy it", async () => {
    const out = await freshOut()
    await captured(() => materializeMain(["bun", "materialize", "--out", out]))

    const file = join(out, "src", "billing", "refund.ts")
    await Bun.write(file, `${await readFile(file, "utf8")}\n// a line nobody planted\n`)

    const expected = normalize(SEEDED_CHANGE.diff)
    const actual = normalize(await rediff(out))
    expect(actual.get("src/billing/refund.ts")).not.toBe(expected.get("src/billing/refund.ts"))
  })
})


/**
 * Every id or summary from the answer key that reached the materialized tree.
 *
 * ONE function, used by the assertion and by its non-vacuity guard, so the guard
 * exercises the thing it claims is fallible rather than a copy of it.
 */
async function answerKeyBytesIn(root: string): Promise<string[]> {
  const corpus = (
    await Promise.all((await everyFile(root)).map((file) => readFile(file, "utf8").catch(() => "")))
  )
    .join("\n")
    .toLowerCase()

  const found: string[] = []
  for (const defect of SEEDED_DEFECTS) {
    if (corpus.includes(defect.id.toLowerCase())) found.push(`id: ${defect.id}`)
    if (corpus.includes(defect.summary.toLowerCase())) found.push(`summary: ${defect.summary}`)
  }
  return found
}

describe("AC2 — the answer key is not in the tree a model reads", () => {
  test("no materialized file contains a defect id or a summary", async () => {
    const out = await freshOut()
    await captured(() => materializeMain(["bun", "materialize", "--out", out]))

    expect((await everyFile(out)).length).toBeGreaterThan(0)
    expect(await answerKeyBytesIn(out)).toEqual([])
  })

  /**
   * MARKERS NEED THE WEAKER CLAIM, and the weaker claim is the correct one.
   *
   * A flat "no marker appears in the tree" fails on the honest fixture, and it is
   * worth writing down why rather than loosening the assertion quietly: a marker
   * is chosen to match a MODEL'S PROSE about the defect, and the defect's own
   * vocabulary is necessarily in the buggy code. `idempot` is a marker for
   * `unchecked-idempotency-key` and it is also inside `req.idempotencyKey`;
   * `currency` marks `money-as-float` and is also a column the query selects;
   * `card_number` marks the privacy defect and IS the field being logged.
   * Removing them from the tree would mean deleting the bugs.
   *
   * What AC2 withholds is the LABELLING, not the reviewed code's own words. So
   * the invariant is a containment one: a marker may appear in the materialized
   * tree only where `material.ts` already put it. Anything else is a byte that
   * arrived from the label side, and that is the leak.
   */
  test("a marker appears in the tree only where the material already carried it", async () => {
    const out = await freshOut()
    await captured(() => materializeMain(["bun", "materialize", "--out", out]))

    const corpus = (
      await Promise.all((await everyFile(out)).map((file) => readFile(file, "utf8").catch(() => "")))
    ).join("\n")
    const material = [SEEDED_CHANGE.diff, ...Object.values(BASE_TREE)].join("\n").toLowerCase()

    const arrived: string[] = []
    for (const defect of SEEDED_DEFECTS) {
      for (const marker of defect.markers) {
        const lower = marker.toLowerCase()
        // Case-insensitive because `lexicalDefectMatcher` matches that way: a
        // marker that reached the tree in another casing is the same leak.
        if (corpus.toLowerCase().includes(lower) && !material.includes(lower)) {
          arrived.push(`${defect.id}: ${marker}`)
        }
      }
    }

    expect(arrived).toEqual([])
  })

  /**
   * THE NON-VACUITY GUARD RE-RUNS THE ASSERTION IT CLAIMS TO PROVE FALLIBLE
   * (review finding P9b, 2026-09-11).
   *
   * It used to write `NOTES.md` and then assert only that the corpus contained
   * the id it had just written — `String.prototype.includes`, tested. The check
   * that matters is `answerKeyBytesIn`, and this runs THAT over a tree with one
   * leaked id in it and requires it to come back non-empty. A leak check that
   * cannot report a leak is worse than none, because it reads like one that can.
   */
  test("the leak assertion is non-vacuous — the SAME check reports a planted id", async () => {
    const out = await freshOut()
    await captured(() => materializeMain(["bun", "materialize", "--out", out]))

    expect(await answerKeyBytesIn(out)).toEqual([])

    const leaked = SEEDED_DEFECTS[0]!
    await Bun.write(join(out, "NOTES.md"), `remember: ${leaked.id}\n`)

    expect(await answerKeyBytesIn(out)).toContain(`id: ${leaked.id}`)
  })

  test("the leak check catches a leaked SUMMARY too, not only an id", async () => {
    const out = await freshOut()
    await captured(() => materializeMain(["bun", "materialize", "--out", out]))

    const leaked = SEEDED_DEFECTS[0]!
    await Bun.write(join(out, "src", "billing", "README.md"), `${leaked.summary}\n`)

    expect(await answerKeyBytesIn(out)).toContain(`summary: ${leaked.summary}`)
  })

  test("the materializer's source imports neither the labels nor the adjudicator", async () => {
    // STRUCTURAL, and it is the claim the leak check above cannot make: the leak
    // check proves this ONE invocation wrote nothing incriminating, while the
    // failure mode is a later edit that reaches the answer key at all. The door
    // module `change.ts` is refused too — it re-exports `labels.ts`, so importing
    // it is importing the answer key with one extra step.
    const source = await Bun.file(new URL("./materialize-labelled-change.ts", import.meta.url)).text()
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!)

    expect(imports).toContain("../fixtures/seeded-defects/material.ts")
    expect(imports).not.toContain("../fixtures/seeded-defects/labels.ts")
    expect(imports).not.toContain("../fixtures/seeded-defects/adjudicate.ts")
    expect(imports).not.toContain("../fixtures/seeded-defects/change.ts")
    // `scripts/ablation.ts` reaches `change.ts` transitively through
    // `ablation/seeded-defects.ts`, so importing it for its flag parser would put
    // the answer key back in this module's graph.
    expect(imports).not.toContain("./ablation.ts")
  })
})

describe("`--out` refuses, and a refusal writes nothing", () => {
  test("a relative path is refused BY NAME", async () => {
    const { code, text } = await captured(() =>
      materializeMain(["bun", "materialize", "--out", "some/relative/dir"]),
    )
    expect(code).toBe(1)
    expect(text).toContain("must be an absolute path")
    expect(text).toContain("Nothing was written.")
    await expect(stat(join(REPO_ROOT, "some"))).rejects.toThrow()
  })

  test("a path inside THIS repository is refused, and nothing lands in it", async () => {
    const inside = join(REPO_ROOT, "materialized-here")
    const { code, text } = await captured(() =>
      materializeMain(["bun", "materialize", "--out", inside]),
    )
    expect(code).toBe(1)
    expect(text).toContain("points inside the repository under review")
    await expect(stat(inside)).rejects.toThrow()
  })

  test("the repository under review is injectable, so the rule is tested not trusted", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mad-materialize-repo-"))
    scratch.push(parent)
    const { code, text } = await captured(() =>
      materializeMain(["bun", "materialize", "--out", join(parent, "tree")], {
        repoRoot: parent,
      }),
    )
    expect(code).toBe(1)
    expect(text).toContain("points inside the repository under review")
    await expect(stat(join(parent, "tree"))).rejects.toThrow()
  })

  test("no --out at all is refused, and says what it needs", async () => {
    const { code, text } = await captured(() => materializeMain(["bun", "materialize"]))
    expect(code).toBe(1)
    expect(text).toContain("`--out <directory>` is required")
  })

  test("a repeated --out is refused, never resolved to the first spelling", async () => {
    const { code, text } = await captured(() =>
      materializeMain(["bun", "materialize", "--out", "/a", "--out", "/b"]),
    )
    expect(code).toBe(1)
    expect(text).toContain("--out was given 2 times")
  })

  test("a non-empty destination is refused rather than merged into", async () => {
    const out = await freshOut()
    await captured(() => materializeMain(["bun", "materialize", "--out", out]))

    const { code, text } = await captured(() =>
      materializeMain(["bun", "materialize", "--out", out]),
    )
    expect(code).toBe(1)
    expect(text).toContain("already exists and is not empty")
  })
})

/**
 * THE FOUR UNGUARDED FAILURES (review finding P13, 2026-09-11), plus the `--out`
 * wording (P12) and the inherited-gitignore truncation (P14).
 *
 * Each one used to arrive as something other than a refusal — a raw `ENOENT`, a
 * raw `EEXIST`, git's own `unknown option`, or a silently smaller change.
 */
describe("the refusals say --out, not MAD_ARTIFACTS", () => {
  test("a relative --out names the flag the operator typed, and disowns `1`", async () => {
    const { code, text } = await captured(() =>
      materializeMain(["bun", "materialize", "--out", "some/relative/dir"]),
    )
    expect(code).toBe(1)
    // The shared check keeps its own wording — one check, one implementation —
    // and this line says whose refusal it is before quoting it.
    expect(text).toContain("`--out` was refused by the SHARED AD-16 containment check")
    expect(text).toContain("`1` is NOT an option here")
    expect(text).toContain("must be an absolute path")
  })
})

describe("git itself is checked before anything is written", () => {
  test("`git --version` failing is a refusal that names the requirement", async () => {
    const out = await freshOut()
    const { code, text } = await captured(() =>
      materializeMain(["bun", "materialize", "--out", out], {
        git: async (_cwd, args) =>
          args[0] === "--version"
            ? { exitCode: 127, stdout: "", stderr: "`git` could not be run: ENOENT" }
            : { exitCode: 0, stdout: "", stderr: "" },
      }),
    )
    expect(code).toBe(1)
    expect(text).toContain("`git --version` failed")
    expect(text).toContain("2.28 or newer must be on PATH")
    expect(text).toContain("Nothing was written.")
  })

  test("a git older than 2.28 is refused by NAME, not by `unknown option`", async () => {
    const out = await freshOut()
    const { code, text } = await captured(() =>
      materializeMain(["bun", "materialize", "--out", out], {
        git: async (_cwd, args) =>
          args[0] === "--version"
            ? { exitCode: 0, stdout: "git version 2.20.1\n", stderr: "" }
            : { exitCode: 0, stdout: "", stderr: "" },
      }),
    )
    expect(code).toBe(1)
    expect(text).toContain("needs git 2.28 or newer and found 2.20")
    expect(text).toContain("--initial-branch")
  })

  test("an UNPARSEABLE version is not refused — a working git is not turned away", async () => {
    // The failing `git init` step still refuses, carrying git's own words. This
    // guard exists to name a requirement, not to police version strings.
    expect(parseGitVersion("something nobody expected")).toBeUndefined()
    expect(parseGitVersion("git version 2.39.5 (Apple Git-154)")).toEqual({ major: 2, minor: 39 })
    expect(parseGitVersion("git version 2.28.0")).toEqual({ major: 2, minor: 28 })
  })
})

describe("an --out that is not a fresh directory is refused by name", () => {
  test("an existing REGULAR FILE is named, not hidden by the readdir catch", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mad-materialize-file-"))
    scratch.push(parent)
    const file = join(parent, "not-a-directory")
    await writeFile(file, "an operator's notes\n", "utf8")

    const { code, text } = await captured(() =>
      materializeMain(["bun", "materialize", "--out", file]),
    )
    expect(code).toBe(1)
    expect(text).toContain("already exists and is not a directory")
    // Untouched: the refusal wrote nothing over it.
    expect(await readFile(file, "utf8")).toBe("an operator's notes\n")
  })
})

describe("a base-tree path cannot escape the destination", () => {
  test("a `..` key is refused, and the destination stays empty", async () => {
    const out = await freshOut()
    const { code, text } = await captured(() =>
      materializeMain(["bun", "materialize", "--out", out], {
        // Injected rather than mutating `BASE_TREE`: editing the real fixture in
        // this process would move `canonicalMaterial()` under `seal.test.ts`.
        baseTree: { "../escaped.ts": "written outside the destination\n" },
      }),
    )
    expect(code).toBe(1)
    expect(text).toContain("resolves OUTSIDE")
    await expect(stat(join(out, "..", "escaped.ts"))).rejects.toThrow()
  })

  test("an ABSOLUTE key is refused too", async () => {
    const out = await freshOut()
    const { code, text } = await captured(() =>
      materializeMain(["bun", "materialize", "--out", out], {
        baseTree: { "/tmp/mad-escaped.ts": "nope\n" },
      }),
    )
    expect(code).toBe(1)
    expect(text).toContain("resolves OUTSIDE")
  })

  test("the guard is non-vacuous — the shipped base tree passes it", async () => {
    const out = await freshOut()
    const { code } = await captured(() => materializeMain(["bun", "materialize", "--out", out]))
    expect(code).toBe(0)
    expect(Object.keys(BASE_TREE).length).toBeGreaterThan(0)
  })
})

/**
 * AN OPERATOR'S GLOBAL GITIGNORE MUST NOT TRUNCATE THE CHANGE (review finding
 * P14, 2026-09-11).
 *
 * `git ls-files --others --exclude-standard` is what finds the two NEW files of
 * this change, and `--exclude-standard` honours `core.excludesFile` — a setting
 * that lives in the operator's `~/.gitconfig` and reaches every repository on
 * their machine, this fixture included. A pattern as ordinary as `*-notice.*`
 * would have dropped `src/billing/refund-notice.ts` from the reviewed change,
 * taking three of the thirteen loci with it, and the run would have reported a
 * recall number against defects it never showed anyone.
 *
 * `GIT_CONFIG_GLOBAL` is how the test gives itself such an operator without
 * touching the machine's real config.
 */
describe("a global gitignore cannot silently shrink the materialized change", () => {
  /** An operator whose `~/.gitconfig` ignores something this change adds. */
  async function globalExcludes(patterns: string): Promise<Record<string, string>> {
    const home = await mkdtemp(join(tmpdir(), "mad-materialize-gitconfig-"))
    scratch.push(home)
    const ignore = join(home, "global-ignore")
    await writeFile(ignore, patterns, "utf8")
    await writeFile(join(home, "gitconfig"), `[core]\n\texcludesFile = ${ignore}\n`, "utf8")
    return { GIT_CONFIG_GLOBAL: join(home, "gitconfig") }
  }

  test("an ignored new file is STILL part of the change the run reads", async () => {
    const out = await freshOut()
    const operator = await globalExcludes("*-notice.ts\n")

    const { code } = await captured(() => materializeMain(["bun", "materialize", "--out", out]))
    expect(code).toBe(0)

    // Read the tree the way `adapters/opencode/repo.ts` does, as that operator.
    const untracked = await git(out, ["ls-files", "--others", "--exclude-standard"], operator)
    expect(untracked).toContain("src/billing/refund-notice.ts")
    expect(untracked).toContain("src/billing/refund.ts")
  })

  test("the repo-level setting is WHAT SAVES IT — remove it and the file vanishes", async () => {
    const out = await freshOut()
    const operator = await globalExcludes("*-notice.ts\n")
    await captured(() => materializeMain(["bun", "materialize", "--out", out]))

    expect(await git(out, ["config", "--get", "core.excludesFile"])).toContain(
      "no-global-excludes",
    )

    // Non-vacuity: without the repo-level override the operator's global pattern
    // wins, the new file drops out of the change, and three of the thirteen loci
    // go with it — silently, with a perfectly normal-looking run.
    await git(out, ["config", "--unset", "core.excludesFile"])
    const untracked = await git(out, ["ls-files", "--others", "--exclude-standard"], operator)
    expect(untracked).not.toContain("src/billing/refund-notice.ts")
  })
})

describe("a failing git step stops rather than leaving a half-built tree", () => {
  test("the refusal names the step and says the tree is incomplete", async () => {
    const out = await freshOut()
    const { code, text } = await captured(() =>
      materializeMain(["bun", "materialize", "--out", out], {
        git: async (_cwd, args) =>
          args[0] === "apply"
            ? { exitCode: 1, stdout: "", stderr: "error: patch does not apply" }
            : { exitCode: 0, stdout: "", stderr: "" },
      }),
    )
    expect(code).toBe(1)
    expect(text).toContain("`git apply` failed")
    expect(text).toContain("the tree is INCOMPLETE")
    expect(text).toContain("patch does not apply")
  })
})
