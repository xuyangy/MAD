/**
 * Story 2-7g part C — the kept adversarial run-1 bundle, pinned to its committed `SHA256SUMS`.
 *
 * `ablation/ADVERSARIAL.md` publishes adversarial run 1 from two committed
 * artifacts: the kept bundle under `evidence/adversarial-oauth-run-1-bundle/` and
 * the reader's stdout over it, `evidence/adversarial-oauth-run-1-eval-read.txt`.
 * This test fails on a missing, extra or changed kept file, naming it, and checks
 * that the reader still prints the committed output.
 *
 * WHAT IT ESTABLISHES, AND WHAT IT DOES NOT. Passing means the kept files are
 * consistent with the hashes committed beside them. It does not establish that
 * the original execution is authentic: a file and its hash committed together
 * agree by construction.
 *
 * The kept copy is the reader-complete subset of the run's `--out`, not its full
 * execution state: every file except `adversarial/worktrees/` (175 files), and no `worktrees`
 * directory. The
 * worktrees each hold a `.git` directory, which git cannot track; their 255
 * files are named by hash in `evidence/adversarial-oauth-run-1-worktrees.SHA256SUMS`
 * and not kept.
 *
 * `SHA256SUMS` is an inventory added beside the 175 kept files, in `shasum -a 256`
 * format with paths relative to the bundle root. It lists every file except
 * itself. Only the inventory at the bundle root is excluded: a file named
 * `SHA256SUMS` anywhere below the root is treated as a kept file like any other,
 * and is therefore reported extra unless the inventory lists it.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { cp, lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const REPO_ROOT = realpathSync(resolve(import.meta.dir, ".."))
const BUNDLE_PATH = "ablation/evidence/adversarial-oauth-run-1-bundle"
const BUNDLE = join(REPO_ROOT, BUNDLE_PATH)
const EVAL_READ = join(REPO_ROOT, "ablation/evidence/adversarial-oauth-run-1-eval-read.txt")
const WORKTREE_SUMS = join(REPO_ROOT, "ablation/evidence/adversarial-oauth-run-1-worktrees.SHA256SUMS")
const SUMS_FILE = "SHA256SUMS"
const KEPT_FILES = 175
const KEPT_BYTES = 1712733
const WORKTREE_FILES = 255
/** The reader commit `ablation/ADVERSARIAL.md` records for the committed output. */
const READER_COMMIT = "22d8fb3a4800b6809a108b3224cc2a5ef361a37d"

const scratch: string[] = []

afterEach(async () => {
  while (scratch.length > 0) {
    await rm(scratch.pop()!, { recursive: true, force: true })
  }
})

/** Every entry under `root` except the root inventory, as sorted relative paths. Anything not a regular file is reported. */
async function keptEntries(root: string): Promise<{ files: string[]; notFiles: string[] }> {
  const files: string[] = []
  const notFiles: string[] = []
  for (const entry of await readdir(root, { recursive: true })) {
    const path = String(entry)
    const info = await lstat(join(root, path))
    if (info.isDirectory()) continue
    if (!info.isFile()) notFiles.push(path)
    else if (path !== SUMS_FILE) files.push(path)
  }
  return { files: files.sort(), notFiles: notFiles.sort() }
}

function parseSums(text: string, name = SUMS_FILE): Map<string, string> {
  const sums = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    if (line === "") continue
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line)
    if (!match) throw new Error(`${name}: malformed line \`${line}\``)
    if (sums.has(match[2]!)) throw new Error(`${name}: \`${match[2]}\` is listed twice`)
    sums.set(match[2]!, match[1]!)
  }
  return sums
}

/** One line per disagreement between the files under `root` and its `SHA256SUMS`, each naming the file. */
async function inventoryProblems(root: string): Promise<string[]> {
  const sums = parseSums(await readFile(join(root, SUMS_FILE), "utf8"))
  const { files, notFiles } = await keptEntries(root)
  const problems = notFiles.map((path) => `not a regular file: ${path}`)
  for (const path of files) {
    const expected = sums.get(path)
    if (expected === undefined) {
      problems.push(`extra: ${path}`)
      continue
    }
    const actual = new Bun.CryptoHasher("sha256").update(await readFile(join(root, path))).digest("hex")
    if (actual !== expected) problems.push(`changed: ${path}`)
  }
  const present = new Set(files)
  for (const path of sums.keys()) if (!present.has(path)) problems.push(`missing: ${path}`)
  return problems
}

async function copyOfBundle(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-adversarial-run1-bundle-"))
  scratch.push(dir)
  await cp(BUNDLE, dir, { recursive: true })
  return dir
}

describe("the kept adversarial run-1 bundle against its SHA256SUMS", () => {
  test("every kept file matches its committed hash: 175 files, 1712733 bytes, and no worktree", async () => {
    expect(await inventoryProblems(BUNDLE)).toEqual([])
    const { files } = await keptEntries(BUNDLE)
    expect(files).toHaveLength(KEPT_FILES)
    expect(parseSums(await readFile(join(BUNDLE, SUMS_FILE), "utf8")).size).toBe(KEPT_FILES)
    expect(files.filter((path) => path.split("/").includes("worktrees"))).toEqual([])
    // No `worktrees` directory either, not even an empty one.
    const directories: string[] = []
    for (const entry of await readdir(BUNDLE, { recursive: true })) {
      if ((await lstat(join(BUNDLE, String(entry)))).isDirectory()) directories.push(String(entry))
    }
    expect(directories.filter((path) => path.split("/").at(-1) === "worktrees")).toEqual([])
    let bytes = 0
    for (const path of files) bytes += (await lstat(join(BUNDLE, path))).size
    expect(bytes).toBe(KEPT_BYTES)
  })

  test("a changed byte fails, naming the file", async () => {
    const dir = await copyOfBundle()
    // One byte flipped in place: the size is unchanged, so only the hash can tell.
    const file = join(dir, "paired-journal.jsonl")
    const bytes = await readFile(file)
    const size = bytes.length
    bytes[0] = bytes[0]! ^ 0x01
    await writeFile(file, bytes)
    expect((await lstat(file)).size).toBe(size)
    expect(await inventoryProblems(dir)).toEqual(["changed: paired-journal.jsonl"])
  })

  test("an extra file fails, naming it", async () => {
    const dir = await copyOfBundle()
    await writeFile(join(dir, "adversarial/attack/0/extra.json"), "{}")
    expect(await inventoryProblems(dir)).toEqual(["extra: adversarial/attack/0/extra.json"])
  })

  test("a missing file fails, naming it", async () => {
    const dir = await copyOfBundle()
    const [first] = (await keptEntries(dir)).files.filter((path) => path.startsWith("adversarial/clean/"))
    expect(first).toBeDefined()
    await rm(join(dir, first!))
    expect(await inventoryProblems(dir)).toEqual([`missing: ${first}`])
  })

  test("the worktree inventory names 255 files under adversarial/worktrees/, none of them kept", async () => {
    const sums = parseSums(await readFile(WORKTREE_SUMS, "utf8"), "adversarial-oauth-run-1-worktrees.SHA256SUMS")
    expect(sums.size).toBe(WORKTREE_FILES)
    const paths = [...sums.keys()]
    expect(paths.every((path) => path.startsWith("adversarial/worktrees/"))).toBe(true)
    expect(new Set(paths.map((path) => path.split("/")[2])).size).toBe(16)
    const kept = new Set((await keptEntries(BUNDLE)).files)
    expect(paths.filter((path) => kept.has(path))).toEqual([])
  })
})

/**
 * The committed reader output is a header line naming the reader commit, then the
 * reader's stdout verbatim. Emitted paths are never rewritten in that file. The
 * replay compares the reader's stdout with it exactly, with one exception: the
 * bundle path as the reader prints it, recorded and current, are substituted for
 * one another. Nothing else is normalized.
 *
 * The replay pins the reader. The committed file is the record at 22d8fb3 and is
 * never regenerated: a later reader change is published as a NEW dated
 * reader-output file under its own header, and this test is pointed at it.
 */
describe("the committed reader output", () => {
  test("the reader prints it over the kept copy", async () => {
    const committed = await readFile(EVAL_READ, "utf8")
    const newline = committed.indexOf("\n")
    expect(newline).toBeGreaterThan(0)
    expect(committed.slice(0, newline)).toBe(`eval-read at commit ${READER_COMMIT}; every line after this one is its stdout, verbatim`)
    const recorded = committed.slice(newline + 1)
    const recordedBundle = /^MAD ADVERSARIAL — (\S+)$/m.exec(recorded)?.[1]
    expect(recordedBundle).toBeDefined()
    expect(recordedBundle!.endsWith(BUNDLE_PATH)).toBe(true)

    const reader = Bun.spawn([process.execPath, "run", "scripts/eval-read.ts", "--bundle", BUNDLE_PATH], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(reader.stdout).text(),
      new Response(reader.stderr).text(),
      reader.exited,
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })

    if (stdout.split(BUNDLE_PATH).join(recordedBundle!) !== recorded) {
      throw new Error(
        "The reader no longer prints the committed adversarial run-1 output. That file is the record at " +
          `${READER_COMMIT} and is never regenerated: publish a later reader's output as a NEW dated ` +
          "reader-output file under its own header, and point this test at it.",
      )
    }
  }, 120_000)
})
