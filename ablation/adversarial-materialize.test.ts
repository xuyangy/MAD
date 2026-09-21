/**
 * Story 2-7b — the answer key never reaches a model: the worktree writer imports
 * no answer key, and a written worktree holds no target label id, summary or
 * predicate. Over real git.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ADVERSARIAL_ASSERTIONS } from "../fixtures/adversarial/assertions.ts"
import { ADVERSARIAL_CASES } from "../fixtures/adversarial/material.ts"
import { isolatedGitEnv, materializeSide, spawnGit } from "./adversarial-materialize.ts"

const scratch: string[] = []
afterEach(async () => {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-adversarial-tree-"))
  scratch.push(dir)
  return dir
}

/**
 * Every file under a worktree except git's objects and git's own sample hooks
 * (git writes those from its template, and they hold ordinary English words
 * such as a marker), as one lower-cased corpus.
 */
async function corpusOf(root: string): Promise<{ text: string; files: string[] }> {
  const files: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir)) {
      const path = join(dir, entry)
      if ((entry === "objects" || entry === "hooks") && dir.endsWith(".git")) continue
      if ((await stat(path)).isDirectory()) await walk(path)
      else files.push(path)
    }
  }
  await walk(root)
  const texts = await Promise.all(files.map((file) => readFile(file, "utf8").catch(() => "")))
  return { text: texts.join("\n").toLowerCase(), files }
}

/** Every answer-key string the corpus holds that the material did not already carry. */
function answerKeyBytesIn(corpus: string, caseIndex: number): string[] {
  const material = ADVERSARIAL_CASES[caseIndex]!
  const materialText = JSON.stringify(material).toLowerCase()
  const found: string[] = []
  for (const assertion of ADVERSARIAL_ASSERTIONS) {
    if (corpus.includes(assertion.target.id.toLowerCase())) found.push(`id: ${assertion.target.id}`)
    if (corpus.includes(assertion.target.summary.toLowerCase())) found.push(`summary: ${assertion.target.summary}`)
    for (const marker of assertion.target.markers) {
      if (corpus.includes(marker.toLowerCase()) && !materialText.includes(marker.toLowerCase())) found.push(`marker: ${marker}`)
    }
    // A predicate path the material itself names (the defect's file) is no
    // leak; one the material never names is.
    const predicate = assertion.blame.path.toLowerCase()
    if (corpus.includes(predicate) && !materialText.includes(predicate)) found.push(`predicate: ${assertion.blame.path}`)
  }
  return found
}

describe("materializeSide over real git", () => {
  test("each side's worktree is the base tree committed plus the side's diff, uncommitted", async () => {
    const dir = await tempDir()
    for (const [index, c] of ADVERSARIAL_CASES.entries()) {
      for (const side of ["clean", "attack"] as const) {
        const worktree = join(dir, `${c.id}-${side}`)
        const written = await materializeSide({ directory: worktree, baseTree: c.baseTree, change: c[side] })
        expect(written).toEqual({ ok: true, directory: worktree })
        const diff = await spawnGit(worktree, ["diff", "HEAD", "--name-only"])
        expect(diff.stdout).toContain(ADVERSARIAL_ASSERTIONS[index]!.target.locus.file)
        const log = await spawnGit(worktree, ["log", "--oneline"])
        expect(log.stdout.trim().split("\n")).toHaveLength(1)
        expect(answerKeyBytesIn((await corpusOf(worktree)).text, index), `${c.id} ${side}`).toEqual([])
      }
    }
  })

  test("the leak check is not vacuous: a planted label id, summary, marker and predicate path are reported", async () => {
    const dir = await tempDir()
    const c = ADVERSARIAL_CASES[0]!
    const worktree = join(dir, "planted")
    expect((await materializeSide({ directory: worktree, baseTree: c.baseTree, change: c.clean })).ok).toBe(true)
    const materialText = JSON.stringify(c).toLowerCase()
    const leaked = ADVERSARIAL_ASSERTIONS[0]!.target
    const marker = ADVERSARIAL_ASSERTIONS.flatMap((a) => a.target.markers).find((m) => !materialText.includes(m.toLowerCase()))!
    const path = ADVERSARIAL_ASSERTIONS.map((a) => a.blame.path).find((p) => !materialText.includes(p.toLowerCase()))!
    expect(marker).toBeDefined()
    expect(path).toBeDefined()
    await writeFile(join(worktree, "NOTES.md"), `${leaked.id}\n${leaked.summary}\n${marker}\n${path}\n`)
    const found = answerKeyBytesIn((await corpusOf(worktree)).text, 0)
    expect(found).toContain(`id: ${leaked.id}`)
    expect(found).toContain(`summary: ${leaked.summary}`)
    expect(found).toContain(`marker: ${marker}`)
    expect(found).toContain(`predicate: ${path}`)
  })

  test("a non-empty destination and an escaping base-tree path are refused, and nothing is written", async () => {
    const dir = await tempDir()
    await writeFile(join(dir, "already"), "x")
    const c = ADVERSARIAL_CASES[0]!
    const busy = await materializeSide({ directory: dir, baseTree: c.baseTree, change: c.clean })
    expect(busy.ok).toBe(false)
    const escaping = await materializeSide({ directory: join(dir, "fresh"), baseTree: { "../out.ts": "x" }, change: c.clean })
    expect(escaping.ok).toBe(false)
    expect(await readdir(dir)).toEqual(["already"])
  })

  test("a diff that does not apply is refused by name", async () => {
    const dir = await tempDir()
    const c = ADVERSARIAL_CASES[0]!
    const written = await materializeSide({
      directory: join(dir, "bad"),
      baseTree: c.baseTree,
      change: { ...c.clean, diff: c.clean.diff.replace("return rows[0]", "return rows[1]") },
    })
    expect(written.ok).toBe(false)
    if (!written.ok) expect(written.reason).toContain("git apply")
  })
})

describe("the worktree writer's import list is the argument", () => {
  test("it imports no fixture, and neither the assertions nor the seal", async () => {
    const source = await Bun.file(new URL("./adversarial-materialize.ts", import.meta.url)).text()
    const imports = [...source.matchAll(/^import[^"]*"([^"]+)"/gm)].map((match) => match[1]!)
    expect(imports.length).toBeGreaterThan(0)
    for (const path of imports) {
      expect(path).not.toContain("fixtures/")
      expect(path).not.toContain("assertions")
      expect(path).not.toContain("seal")
    }
  })

  test("the material module imports nothing from the answer key", async () => {
    const source = await Bun.file(new URL("../fixtures/adversarial/material.ts", import.meta.url)).text()
    const imports = [...source.matchAll(/^import[^"]*"([^"]+)"/gm)].map((match) => match[1]!)
    for (const path of imports) {
      expect(path).not.toContain("assertions")
      expect(path).not.toContain("seal")
    }
  })
})

describe("git is isolated from the operator's configuration", () => {
  test("every GIT_* variable is stripped, and global and system config are switched off", () => {
    const env = isolatedGitEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      GIT_DIR: "/elsewhere/.git",
      GIT_WORK_TREE: "/elsewhere",
      GIT_INDEX_FILE: "/elsewhere/index",
      GIT_OBJECT_DIRECTORY: "/elsewhere/objects",
    })
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/x", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" })
  })

  test("a GIT_DIR in the caller's environment does not redirect the write", async () => {
    const dir = await tempDir()
    const decoy = join(dir, "decoy")
    const previous = process.env.GIT_DIR
    process.env.GIT_DIR = join(decoy, ".git")
    try {
      const c = ADVERSARIAL_CASES[0]!
      const written = await materializeSide({ directory: join(dir, "real"), baseTree: c.baseTree, change: c.clean })
      expect(written.ok).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previous
    }
    expect(await readdir(join(dir, "real", ".git"))).toContain("HEAD")
    expect(await readdir(dir)).not.toContain("decoy")
  })

  test("a base-tree key with a .git component at any depth is refused, and nothing is written", async () => {
    const dir = await tempDir()
    const c = ADVERSARIAL_CASES[0]!
    for (const key of [".git/hooks/post-commit", ".GIT/config", "./.git/HEAD", "sub/.git/config", "vendor/.Git/HEAD"]) {
      const written = await materializeSide({ directory: join(dir, "w"), baseTree: { ...c.baseTree, [key]: "x" }, change: c.clean })
      expect(written.ok, key).toBe(false)
      if (!written.ok) expect(written.reason).toContain("has a `.git` component")
    }
    expect(await readdir(dir)).toEqual([])
  })

  test("the worktree gets no template hooks", async () => {
    const dir = await tempDir()
    const c = ADVERSARIAL_CASES[0]!
    expect((await materializeSide({ directory: join(dir, "w"), baseTree: c.baseTree, change: c.clean })).ok).toBe(true)
    expect(await readdir(join(dir, "w", ".git"))).not.toContain("hooks")
  })
})

