/**
 * Story 2-8d — the retained run-5 bundle, pinned to its committed `SHA256SUMS`.
 *
 * `ablation/EVALUATION.md` publishes run 5 from two committed artifacts: the raw
 * bundle under `evidence/paired-oauth-evaluation-run-5-bundle/` and the reader's
 * stdout over it, `evidence/paired-oauth-evaluation-run-5-eval-read.txt`. This
 * test fails on a missing, extra or changed bundle file, naming it, pins that
 * output by its hash, and checks that the current reader prints the dated
 * output file beside it.
 *
 * WHAT IT ESTABLISHES, AND WHAT IT DOES NOT. Passing means the retained files are
 * consistent with the hashes committed beside them. It does not establish the
 * independent authenticity of the original execution: a file and its hash
 * committed together agree by construction.
 *
 * `SHA256SUMS` is a retention inventory added beside the 68 source files, in
 * `shasum -a 256` format with paths relative to the bundle root. It lists every
 * file except itself. Only the inventory at the bundle root is excluded: a file
 * named `SHA256SUMS` anywhere below the root is treated as a retained file like
 * any other, and is therefore reported extra unless the inventory lists it.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { appendFile, cp, lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const REPO_ROOT = realpathSync(resolve(import.meta.dir, ".."))
const BUNDLE_PATH = "ablation/evidence/paired-oauth-evaluation-run-5-bundle"
const BUNDLE = join(REPO_ROOT, BUNDLE_PATH)
/** The record `ablation/EVALUATION.md` publishes from, produced at `PUBLISHED_READER_COMMIT`. */
const PUBLISHED_EVAL_READ = join(REPO_ROOT, "ablation/evidence/paired-oauth-evaluation-run-5-eval-read.txt")
const PUBLISHED_EVAL_READ_SHA256 = "2f06a25442acd6c286ff31d96d877b959475be5ed5054ce0215df89dec32f3a5"
/** The current reader's output over the same bundle. */
const EVAL_READ = join(REPO_ROOT, "ablation/evidence/paired-oauth-evaluation-run-5-eval-read-2026-10-15.txt")
const SUMS_FILE = "SHA256SUMS"
const RETAINED_FILES = 68
const RETAINED_BYTES = 3794958
/** The reader commit `ablation/EVALUATION.md` records for the published output. */
const PUBLISHED_READER_COMMIT = "c66b06988785edc7ef6bd97b46713980c07e603e"
/** The reader commit the current output file names. */
const READER_COMMIT = "3fba92dfc5bb9a93982dd8b974ddc3b2900d409a"

const scratch: string[] = []

afterEach(async () => {
  while (scratch.length > 0) {
    await rm(scratch.pop()!, { recursive: true, force: true })
  }
})

/** Every entry under `root` except the root inventory, as sorted relative paths. Anything not a regular file is reported. */
async function retainedEntries(root: string): Promise<{ files: string[]; notFiles: string[] }> {
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

function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    if (line === "") continue
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line)
    if (!match) throw new Error(`${SUMS_FILE}: malformed line \`${line}\``)
    if (sums.has(match[2]!)) throw new Error(`${SUMS_FILE}: \`${match[2]}\` is listed twice`)
    sums.set(match[2]!, match[1]!)
  }
  return sums
}

/** One line per disagreement between the files under `root` and its `SHA256SUMS`, each naming the file. */
async function inventoryProblems(root: string): Promise<string[]> {
  const sums = parseSums(await readFile(join(root, SUMS_FILE), "utf8"))
  const { files, notFiles } = await retainedEntries(root)
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
  const dir = await mkdtemp(join(tmpdir(), "mad-run5-bundle-"))
  scratch.push(dir)
  await cp(BUNDLE, dir, { recursive: true })
  return dir
}

describe("the retained run-5 bundle against its SHA256SUMS", () => {
  test("every retained file matches its committed hash: 68 files, 3794958 bytes", async () => {
    expect(await inventoryProblems(BUNDLE)).toEqual([])
    const { files } = await retainedEntries(BUNDLE)
    expect(files).toHaveLength(RETAINED_FILES)
    expect(parseSums(await readFile(join(BUNDLE, SUMS_FILE), "utf8")).size).toBe(RETAINED_FILES)
    let bytes = 0
    for (const path of files) bytes += (await lstat(join(BUNDLE, path))).size
    expect(bytes).toBe(RETAINED_BYTES)
  })

  test("a changed byte fails, naming the file", async () => {
    const dir = await copyOfBundle()
    await appendFile(join(dir, "paired-journal.jsonl"), " ")
    expect(await inventoryProblems(dir)).toEqual(["changed: paired-journal.jsonl"])
  })

  test("an extra file fails, naming it", async () => {
    const dir = await copyOfBundle()
    await writeFile(join(dir, "on/0/extra.json"), "{}")
    expect(await inventoryProblems(dir)).toEqual(["extra: on/0/extra.json"])
  })

  test("a missing file fails, naming it", async () => {
    const dir = await copyOfBundle()
    const [first] = (await retainedEntries(dir)).files.filter((path) => path.startsWith("prefix/"))
    expect(first).toBeDefined()
    await rm(join(dir, first!))
    expect(await inventoryProblems(dir)).toEqual([`missing: ${first}`])
  })
})

/**
 * Each committed reader output is a header line naming the reader commit, then
 * the reader's stdout verbatim. Emitted paths are never rewritten in such a file;
 * here the checkout root it was produced under, when it prints one, and this
 * checkout's, are both read as one token, so a replay at another checkout path
 * compares equal when only path text differs.
 *
 * The replay pins the reader to the current output file. Neither file is ever
 * regenerated: `paired-oauth-evaluation-run-5-eval-read.txt` is the record at
 * c66b069 that `ablation/EVALUATION.md` publishes from, and is pinned by its
 * hash. A later reader change is published as a NEW dated reader-output file
 * under its own header, and this test is pointed at it.
 */
describe("the committed reader output", () => {
  test("the published record at c66b069 is unchanged", async () => {
    const published = await readFile(PUBLISHED_EVAL_READ)
    expect(published.toString("utf8").startsWith(`eval-read at commit ${PUBLISHED_READER_COMMIT};`)).toBe(true)
    expect(createHash("sha256").update(published).digest("hex")).toBe(PUBLISHED_EVAL_READ_SHA256)
  })

  test("the reader prints the current output over the retained copy", async () => {
    const committed = await readFile(EVAL_READ, "utf8")
    const newline = committed.indexOf("\n")
    expect(newline).toBeGreaterThan(0)
    expect(committed.slice(0, newline)).toBe(`eval-read at commit ${READER_COMMIT}; every line after this one is its stdout, verbatim`)
    const recorded = committed.slice(newline + 1)
    expect(recorded.startsWith(`MAD evaluation bundle — ${BUNDLE_PATH}\n`)).toBe(true)
    const recordedRoot = new RegExp(`([^\\s\`]*)/${BUNDLE_PATH}/`).exec(recorded)?.[1]
    expect(recordedRoot).not.toBe("")
    expect(recordedRoot).not.toBe("/")

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

    const asToken = (text: string, root: string | undefined) => (root === undefined ? text : text.split(`${root}/`).join("<checkout>/"))
    const replay = asToken(stdout, recordedRoot === undefined ? undefined : REPO_ROOT)
    if (replay !== asToken(recorded, recordedRoot)) {
      throw new Error(
        "The reader no longer prints the committed run-5 output. That file is the reader's output at " +
          `${READER_COMMIT} and is never regenerated: publish a later reader's output as a NEW dated ` +
          "reader-output file under its own header, and point this test at it.",
      )
    }
  })
})
