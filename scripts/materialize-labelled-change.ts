#!/usr/bin/env bun
/**
 * Write the labelled change onto disk as a real git worktree a live model can be
 * pointed at (story 2.4, Task 7).
 *
 *   bun run materialize-change --out /scratch/mad-labelled-change
 *
 * What it produces is a directory that `opencodeRepo().change()` reads back as
 * the seeded-defect `ChangeSet`: `BASE_TREE` committed once, then
 * `SEEDED_CHANGE.diff` applied and left UNCOMMITTED, so the working-tree path in
 * `adapters/opencode/repo.ts:46-83`, `Repo.change` — `git diff HEAD` plus the
 * untracked files —
 * sees exactly the change under review.
 *
 * ## The import list is the argument (AC2)
 *
 * This module imports `material.ts` and `seal.ts`. It imports NEITHER
 * `labels.ts` NOR `adjudicate.ts`, and it may never import
 * `seeded-defects/change.ts` either — that file re-exports both sides, so
 * importing the door reaches the answer key just as surely as importing the
 * answer key does.
 *
 * Nothing it writes contains a defect id, a summary or a marker.
 * `materialize-labelled-change.test.ts` asserts that over the files on disk
 * rather than trusting this paragraph, because AC2 is the half of story 2.4 that
 * a promise cannot carry: "a model that can read the answer key measures
 * nothing".
 *
 * `seal.ts` DOES read the labels, and importing it here is deliberate and safe:
 * what it exports is a version string and two hex digests, and a digest reveals
 * nothing about the summaries it was computed over. They are printed so the
 * operator pastes the manifest identity rather than typing it from memory.
 *
 * ## `--out` goes through AD-16's containment check, not a new one
 *
 * `refusalFor` and `realRefusalFor` are imported from the artifact dump rather
 * than reimplemented, exactly as `ablation/bundle.ts` imports them and for the
 * reason recorded there: a second containment check is a second thing that can be
 * subtly weaker than the first. BOTH run, in this order. The lexical one is not
 * redundant — `realRefusalFor` starts by resolving its argument against the
 * current working directory, so on its own it would silently accept a relative
 * `--out` instead of refusing it by name.
 *
 * The "repository under review" here is THIS repository. A materialized tree
 * inside MAD's own checkout would put the change under review inside the tree
 * that holds `labels.ts`, which is the exact leak `--labelled-change`'s own
 * refusal in `scripts/ablation.ts` exists to stop.
 *
 * ## This one does NOT always return 0
 *
 * `scripts/ablation.ts` and `scripts/clustering-rates.ts` always return 0 because
 * they are REPORTERS: the tests are what fail CI, and a reporter that also exited
 * non-zero would give one regression two voices. This script is not a reporter —
 * it either produced a worktree or it did not, and the ordinary use is
 * `bun run materialize-change --out X && bun run ablation --live --labelled-change …`.
 * A refusal that exited 0 there would hand the next command a directory that does
 * not hold what it thinks it holds.
 */

import { mkdir, readdir, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"

import { realRefusalFor, refusalFor } from "../adapters/opencode/artifacts.ts"
import { BASE_TREE, SEEDED_CHANGE } from "../fixtures/seeded-defects/material.ts"
import { LABELLED_CHANGE_SEAL } from "../fixtures/seeded-defects/seal.ts"

/** This repository — the one a materialized tree must land OUTSIDE of. */
const REPO_ROOT = resolve(import.meta.dir, "..")

/**
 * A deterministic author, so the base commit is reproducible and the script does
 * not depend on whatever `user.email` the operator happens to have configured —
 * or fail outright where they have configured none.
 */
const GIT_IDENTITY = [
  "-c",
  "user.name=MAD fixture",
  "-c",
  "user.email=fixture@mad.invalid",
  "-c",
  "commit.gpgsign=false",
]

/**
 * `--out`, parsed HERE rather than imported from `scripts/ablation.ts`.
 *
 * That file exports exactly the `stringFlag` this needs, with exactly these
 * refusals, and reusing it would be the ordinary call — except that importing it
 * pulls in `ablation/seeded-defects.ts`, which imports
 * `fixtures/seeded-defects/change.ts`, which re-exports `labels.ts`. The answer
 * key would be in this module's graph, and "the import list is the argument"
 * would stop being an argument. Twelve duplicated lines are the cheaper half of
 * that trade.
 *
 * The refusals are the same three `stringFlag` makes and they are not decorative:
 * a repeated flag is refused rather than resolved to the first spelling, because
 * two spellings of one destination is an operator who is not sure where their
 * worktree is going.
 */
export type OutFlag = { ok: true; value: string } | { ok: false; message: string }

export function outFlag(argv: readonly string[]): OutFlag {
  const matches = argv.filter((arg) => arg === "--out" || arg.startsWith("--out="))
  if (matches.length === 0) return { ok: false, message: "`--out <directory>` is required." }
  if (matches.length > 1) {
    return {
      ok: false,
      message: `--out was given ${matches.length} times. Pass it once; MAD will not guess which directory is in force.`,
    }
  }
  const index = argv.findIndex((arg) => arg === "--out" || arg.startsWith("--out="))
  const arg = argv[index]!
  const eq = arg.indexOf("=")
  const raw = eq >= 0 ? arg.slice(eq + 1) : argv[index + 1]
  if (raw === undefined || raw.trim() === "" || raw.startsWith("--")) {
    return { ok: false, message: "--out needs a value. Nothing readable followed it." }
  }
  return { ok: true, value: raw.trim() }
}

export interface GitResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * The minimum git this script needs, and why the number is that one.
 *
 * `git init --initial-branch=base` is the step that sets it:
 * `--initial-branch` landed in git 2.28, and on anything older the step fails
 * with git's own `unknown option` text — true, and unhelpful, because it names
 * the flag rather than the requirement. `preflight` below turns that into a
 * refusal that says which version is needed and what was found.
 */
export const MINIMUM_GIT = { major: 2, minor: 28 }

/** `git version 2.39.5 (Apple Git-154)` → `{ major: 2, minor: 39 }`, or undefined. */
export function parseGitVersion(stdout: string): { major: number; minor: number } | undefined {
  const match = /git version (\d+)\.(\d+)/.exec(stdout)
  if (!match) return undefined
  return { major: Number(match[1]), minor: Number(match[2]) }
}

/** Injected so the test can observe the calls; defaults to real `git`. */
export type RunGit = (cwd: string, args: readonly string[], stdin?: string) => Promise<GitResult>

const spawnGit: RunGit = async (cwd, args, stdin) => {
  // A MISSING `git` IS A REFUSAL, NOT A STACK TRACE (review finding P13a,
  // 2026-09-11). `Bun.spawn` THROWS when the executable is not on PATH, and that
  // throw came out of `main` past every refusal this script has — the operator
  // saw a raw `ENOENT` from a script whose entire contract is "it either produced
  // a worktree or it said why it did not". It is reported the way every other git
  // failure here is: a non-zero exit code carrying git's own words, or in this
  // case the reason there were none.
  //
  // Tested through the injected `git` seam rather than by emptying PATH: `Bun.spawn`
  // snapshots the environment at process start, so a `process.env.PATH` a test sets
  // never reaches the child. The seam returns the same 127 this catch returns.
  try {
    const spawned = Bun.spawn(["git", ...args], {
      cwd,
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([
      new Response(spawned.stdout).text(),
      new Response(spawned.stderr).text(),
    ])
    return { exitCode: await spawned.exited, stdout, stderr }
  } catch (error) {
    return {
      exitCode: 127,
      stdout: "",
      stderr:
        `\`git\` could not be run: ${error instanceof Error ? error.message : String(error)}. ` +
        `This script needs real git on PATH (${MINIMUM_GIT.major}.${MINIMUM_GIT.minor} or ` +
        "newer); nothing about the fixture is wrong.",
    }
  }
}

export interface MaterializeOverrides {
  git?: RunGit
  /** The repository a materialized tree must stay outside of. Defaults to this one. */
  repoRoot?: string
  /**
   * The base tree to write. Defaults to the fixture's own.
   *
   * A seam rather than a mutable import, so the containment refusal on base-tree
   * PATHS can be tested without a test reaching into `material.ts` and editing
   * the sealed fixture out from under `seal.test.ts` in the same process.
   */
  baseTree?: Record<string, string>
}

/**
 * The shared containment check's words, with a `--out` line in front of them
 * (review finding P12, 2026-09-11).
 *
 * `refusalFor` is IMPORTED rather than reworded, and that stays true — one check,
 * one implementation, for the reason `ablation/bundle.ts` records. But its text
 * is written for `MAD_ARTIFACTS`, so an operator who typed `--out some/dir` was
 * told that "`MAD_ARTIFACTS` must be an absolute path (or `1` for a temp
 * directory)" — naming an environment variable they never set, and offering a `1`
 * that is not an option on this flag at all. The check keeps its wording; this
 * says whose refusal it is before quoting it.
 */
function containmentRefusal(message: string): string {
  return (
    "`--out` was refused by the SHARED AD-16 containment check, which is the same check " +
    "`MAD_ARTIFACTS` and `bun run ablation --out` go through and therefore speaks in its own " +
    "terms below. Read it as being about `--out`, and note that `1` is NOT an option here: " +
    "`--out` names a directory and nothing else.\n" +
    "\n" +
    `  ${message}`
  )
}

function refuse(message: string): number {
  console.log(
    `materialize-labelled-change — ${message}\n` +
      "\n" +
      "  bun run materialize-change --out /scratch/mad-labelled-change\n" +
      "\n" +
      "--out names the directory the reviewed worktree is written into. It must be an\n" +
      "ABSOLUTE path and it must be OUTSIDE this repository (AD-16): a tree materialized\n" +
      "inside MAD's own checkout would sit beside `fixtures/seeded-defects/labels.ts`,\n" +
      "and a live model's session can open any file under the directory it is given.\n" +
      "Nothing was written.",
  )
  return 1
}

export async function main(
  argv: readonly string[] = Bun.argv,
  overrides: MaterializeOverrides = {},
): Promise<number> {
  const git = overrides.git ?? spawnGit
  const repoRoot = overrides.repoRoot ?? REPO_ROOT
  const baseTree = overrides.baseTree ?? BASE_TREE

  const out = outFlag(argv)
  if (!out.ok) return refuse(out.message)

  // BOTH CHECKS, IN THIS ORDER — see the module header. The lexical one refuses a
  // relative path BY NAME; the real one follows symlinks so a link pointing back
  // into this repository cannot slip through.
  //
  // Their refusal text names `MAD_ARTIFACTS`, because it is the SAME check the
  // artifact dump makes and it is imported rather than reworded. The paragraph
  // `refuse` prints underneath says what `--out` means here; a check with two
  // wordings is a check with two implementations waiting to happen.
  const lexical = refusalFor(out.value, repoRoot)
  if (lexical !== undefined) return refuse(containmentRefusal(lexical))
  const real = await realRefusalFor(out.value, repoRoot)
  if (real !== undefined) return refuse(containmentRefusal(real))

  const root = resolve(out.value)

  // A `BASE_TREE` KEY MAY NOT ESCAPE THE DESTINATION (review finding P13d,
  // 2026-09-11). `join(root, key)` writes whatever the map says, so a future key
  // containing `..` — or an absolute one — would write outside the directory the
  // containment check just cleared, and the AD-16 guarantee would have been
  // enforced on a path the script then did not use. Today's single key is
  // `src/billing/ledger.ts` and this refuses nothing; it is the edit AFTER this
  // one that it is for.
  for (const path of Object.keys(baseTree)) {
    const target = resolve(root, path)
    if (isAbsolute(path) || (target !== root && !target.startsWith(root + sep))) {
      return refuse(
        `the base tree contains the path \`${path}\`, which resolves OUTSIDE \`${root}\`. ` +
          "Every base-tree key must be a relative path inside the destination; nothing was written.",
      )
    }
  }

  // AN EXISTING NON-DIRECTORY IS NAMED, NOT SWALLOWED (review finding P13b,
  // 2026-09-11). `readdir` fails with ENOTDIR on a regular file exactly as it
  // fails with ENOENT on nothing at all, and the `catch` below treated both as
  // "the destination is free" — so `--out ~/notes.txt` walked past the emptiness
  // guard and threw a raw EEXIST out of `mkdir`, from a script that is supposed
  // to refuse rather than crash.
  const destination = await stat(root).catch(() => undefined)
  if (destination !== undefined && !destination.isDirectory()) {
    return refuse(
      `\`${root}\` already exists and is not a directory. --out names a directory this script ` +
        "creates and fills; it will not replace a file that is already there.",
    )
  }

  // A NON-EMPTY DESTINATION IS REFUSED. `git init` over an existing checkout and
  // `git apply` over files that are already there both fail in ways that leave a
  // half-written tree behind, and a half-written tree is one a run would review
  // without noticing. Name a fresh directory.
  const existing = await readdir(root).catch(() => undefined)
  if (existing !== undefined && existing.length > 0) {
    return refuse(
      `\`${root}\` already exists and is not empty. This script writes a fresh worktree and ` +
        `will not merge into one that is already there; name a directory that does not exist yet.`,
    )
  }

  // GIT ITSELF, CHECKED BEFORE THE FIRST STEP (review finding P13a and P13c,
  // 2026-09-11). Two failures used to arrive as something other than a refusal:
  // git missing from PATH threw out of `Bun.spawn`, and git older than 2.28
  // failed `git init --initial-branch=base` with `unknown option`, which names
  // the flag rather than the requirement. Both are answered here, by name, before
  // anything is written into the destination — before `mkdir`, so "nothing was
  // written" stays literally true. `git --version` does not care about its cwd,
  // which is why it can run before the destination exists.
  //
  // An UNPARSEABLE version is not refused. `git --version` answering something
  // this regex does not know is a git that may well work, and refusing it would
  // trade a clear failure at the `git init` step — which still refuses, carrying
  // git's own words — for a refusal of a working install. The seam's stub git in
  // the tests is exactly that case.
  const version = await git(process.cwd(), ["--version"])
  if (version.exitCode !== 0) {
    return refuse(
      `\`git --version\` failed, so this script cannot build the worktree.\n\n  ` +
        `${version.stderr.trim() || version.stdout.trim() || "git reported no detail"}\n\n` +
        `Real git ${MINIMUM_GIT.major}.${MINIMUM_GIT.minor} or newer must be on PATH. ` +
        "Nothing was written.",
    )
  }
  const parsed = parseGitVersion(version.stdout)
  if (
    parsed !== undefined &&
    (parsed.major < MINIMUM_GIT.major ||
      (parsed.major === MINIMUM_GIT.major && parsed.minor < MINIMUM_GIT.minor))
  ) {
    return refuse(
      `this script needs git ${MINIMUM_GIT.major}.${MINIMUM_GIT.minor} or newer and found ` +
        `${parsed.major}.${parsed.minor}. \`git init --initial-branch=base\` names the base ` +
        "branch explicitly so the materialized tree does not depend on the operator's " +
        "`init.defaultBranch`, and `--initial-branch` arrived in git 2.28. Nothing was written.",
    )
  }

  await mkdir(root, { recursive: true })

  for (const [path, contents] of Object.entries(baseTree)) {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, contents, "utf8")
  }

  const steps: { label: string; args: string[]; stdin?: string }[] = [
    { label: "git init", args: ["init", "--quiet", "--initial-branch=base"] },
    // THE OPERATOR'S GLOBAL GITIGNORE MUST NOT REACH THIS TREE (review finding
    // P14, 2026-09-11). `core.excludesFile` / `~/.gitignore` is inherited by
    // every repository on the machine, and BOTH halves of this fixture run
    // through it: `git add --all` below builds the base commit, and the live
    // run's own `git ls-files --others --exclude-standard`
    // (`adapters/opencode/repo.ts`) is what finds `refund.ts` and
    // `refund-notice.ts` as untracked files. An operator who ignores `*-notice.*`
    // or a `billing/` build directory would have silently reviewed a PARTIAL
    // change — a smaller diff, fewer of the thirteen loci present, and a recall
    // number measured against defects that were never shown to the model.
    //
    // The setting is written into the MATERIALIZED repository's own config, not
    // passed per command, precisely because the command that matters is run later
    // by someone else. The path names a file inside `.git` that this script never
    // creates: git ignores a missing excludes file, and a path that does not
    // exist is the portable spelling of "no excludes" (`/dev/null` is not one on
    // every host).
    {
      label: "git config core.excludesFile",
      args: ["config", "core.excludesFile", join(root, ".git", "no-global-excludes")],
    },
    { label: "git add", args: ["add", "--all"] },
    {
      label: "git commit",
      args: [...GIT_IDENTITY, "commit", "--quiet", "--message", "base tree, before the change"],
    },
    // `--whitespace=nowarn` because the fixture's diff writes empty context lines
    // EMPTY where git writes them as a single space, and a warning on stderr for
    // every one of them would bury a real failure. The patch still has to apply
    // cleanly; nothing about what it does is relaxed.
    { label: "git apply", args: ["apply", "--whitespace=nowarn", "-"], stdin: SEEDED_CHANGE.diff },
  ]

  for (const step of steps) {
    const result = await git(root, step.args, step.stdin)
    if (result.exitCode !== 0) {
      console.log(
        `materialize-labelled-change — \`${step.label}\` failed in \`${root}\` and the tree is INCOMPLETE.\n` +
          "\n" +
          `  ${result.stderr.trim() || result.stdout.trim() || "git reported no detail"}\n` +
          "\n" +
          "Delete the directory before trying again. A partly applied patch is not the change\n" +
          "under review, and a run over it would measure something nobody labelled.",
      )
      return 1
    }
  }

  console.log(
    `The labelled change is materialized at:\n` +
      `\n` +
      `  ${root}\n` +
      `\n` +
      `The base tree is one commit; the change itself is UNCOMMITTED, so a live run reads it\n` +
      `as the working tree. Point the ablation at it and pass the identity below verbatim —\n` +
      `--labelled-change fills both from the seal, so these are for checking, not for typing:\n` +
      `\n` +
      `  --fixture-version ${LABELLED_CHANGE_SEAL.version}\n` +
      `  --fixture-hash ${LABELLED_CHANGE_SEAL.materialHash}\n` +
      `\n` +
      `  bun run ablation --live --labelled-change \\\n` +
      `    --pin provider/model \\\n` +
      `    --directory ${root} \\\n` +
      `    --cap <tokens> \\\n` +
      `    --out <a bundle directory outside every repository>\n` +
      `\n` +
      `The answer key stayed here. Nothing under \`${root}\` names a planted defect, and\n` +
      `\`bun test scripts/materialize-labelled-change.test.ts\` is what checks that.`,
  )
  return 0
}

if (import.meta.main) process.exit(await main())
