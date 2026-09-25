/**
 * Story 2-8c3b — the tree digest, payload verification, the auth symlink check and
 * the disjointness check, on temporary trees and a temporary symlink only.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AUTH_CONTENT_MARKER, fakeAuthLink, fakePrepared } from "./oauth-payload.fixture.ts"
import { authLinkProblem, overlapProblem, sha256Of, treeDigest, treeRecord, verifyPrepared } from "./oauth-payload.ts"

const scratch: string[] = []
afterEach(async () => {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-oauth-payload-test-"))
  scratch.push(dir)
  return dir
}

const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")

describe("the tree record", () => {
  test("one line per file and symlink, sorted by UTF-8 bytes, with execute bits and link targets; directories implied", async () => {
    const root = join(await temp(), "tree")
    await mkdir(join(root, "b", "empty"), { recursive: true })
    await writeFile(join(root, "b", "z.txt"), "z")
    await writeFile(join(root, "a.sh"), "run")
    await chmod(join(root, "a.sh"), 0o744)
    await writeFile(join(root, "Z"), "upper")
    await writeFile(join(root, "é"), "accent")
    await symlink("b/z.txt", join(root, "link"))
    const record = await treeRecord(root)
    expect(record).toEqual({
      ok: true,
      lines: [
        `F\tZ\t${sha("upper")}\t-\n`,
        `F\ta.sh\t${sha("run")}\tx\n`,
        `F\tb/z.txt\t${sha("z")}\t-\n`,
        "L\tlink\tb/z.txt\t-\n",
        `F\té\t${sha("accent")}\t-\n`,
      ],
    })
    const digest = await treeDigest(root)
    expect(digest).toEqual({ ok: true, digest: sha(record.ok ? record.lines.join("") : ""), entries: 5 })
  })

  test("an execute bit alone changes the digest", async () => {
    const root = join(await temp(), "tree")
    await mkdir(root)
    await writeFile(join(root, "f"), "same")
    const before = await treeDigest(root)
    await chmod(join(root, "f"), 0o755)
    const after = await treeDigest(root)
    expect(before.ok && after.ok && before.digest !== after.digest).toBe(true)
  })

  test.each([
    ["escaping", async (root: string) => symlink("../outside", join(root, "out")), "resolves outside the tree"],
    ["absolute", async (root: string) => {
      await writeFile(join(root, "inside"), "i")
      await symlink(join(root, "inside"), join(root, "abs"))
    }, "has an absolute target"],
    ["dangling", async (root: string) => symlink("missing", join(root, "gone")), "does not resolve (dangling)"],
    ["cyclic", async (root: string) => {
      await symlink("b", join(root, "a"))
      await symlink("a", join(root, "b"))
    }, "does not resolve (a cycle)"],
    ["tab in a name", async (root: string) => writeFile(join(root, "bad\tname"), "x"), "holds a tab or a newline"],
    ["newline in a link target", async (root: string) => symlink("x\ny", join(root, "nl")), "target holds a tab or a newline"],
  ])("a tree with a %s entry is refused", async (_name, make, expected) => {
    const parent = await temp()
    const root = join(parent, "tree")
    await mkdir(root)
    await writeFile(join(parent, "outside"), "o")
    await make(root)
    const digest = await treeDigest(root)
    expect(digest.ok).toBe(false)
    expect(digest.ok ? "" : digest.reason).toContain(expected)
  })

  test("a FIFO refuses the tree", async () => {
    const root = join(await temp(), "tree")
    await mkdir(root)
    const made = Bun.spawnSync(["mkfifo", join(root, "pipe")])
    expect(made.exitCode).toBe(0)
    const digest = await treeDigest(root)
    expect(digest.ok ? "" : digest.reason).toContain("is a FIFO")
  })

  test("a root that is a symlink is refused", async () => {
    const parent = await temp()
    await mkdir(join(parent, "real"))
    await symlink(join(parent, "real"), join(parent, "alias"))
    const digest = await treeDigest(join(parent, "alias"))
    expect(digest.ok ? "" : digest.reason).toContain("is a symlink")
  })
})

describe("verifyPrepared", () => {
  test("a prepared directory as pinned verifies", async () => {
    const { prepared, pins } = await fakePrepared(await temp())
    const verified = await verifyPrepared(prepared, pins)
    expect(verified.ok).toBe(true)
    expect(verified.measured.anthropicAuth.treeDigest).toBe(pins.anthropicAuth.treeDigest)
  })

  test("one byte changed in node_modules with the lock unchanged fails on the digest, named", async () => {
    const { prepared, pins } = await fakePrepared(await temp())
    await appendFile(join(prepared, "anthropic-auth", "node_modules", "@ex-machina", "opencode-anthropic-auth", "dist", "index.js"), " ")
    const verified = await verifyPrepared(prepared, pins)
    expect(verified.ok).toBe(false)
    expect(verified.measured.anthropicAuth.lockSha256).toBe(pins.anthropicAuth.lockSha256)
    expect(verified.ok ? [] : verified.problems).toEqual([
      expect.stringContaining(`the Anthropic sign-in plugin: the tree digest of \`${join(prepared, "anthropic-auth")}\` is`),
    ])
  })

  test("a changed lock, a changed catalogue and a missing seed are each named", async () => {
    const { prepared, pins } = await fakePrepared(await temp())
    await writeFile(join(prepared, "anthropic-auth", "package-lock.json"), "{}")
    await writeFile(join(prepared, "models.json"), "{}")
    await rm(join(prepared, "config-seed"), { recursive: true })
    const verified = await verifyPrepared(prepared, pins)
    const text = verified.ok ? "" : verified.problems.join("\n")
    expect(text).toContain("the Anthropic sign-in plugin: the lock's sha256 is")
    expect(text).toContain("the model catalogue")
    expect(text).toContain("the config-directory seed:")
  })

  test("an escaping symlink in the prepared tree refuses it", async () => {
    const root = await temp()
    const { prepared, pins } = await fakePrepared(root)
    await writeFile(join(root, "elsewhere.js"), "x")
    await symlink("../../../elsewhere.js", join(prepared, "config-seed", "node_modules", "escape.js"))
    const verified = await verifyPrepared(prepared, pins)
    expect(verified.ok ? "" : verified.problems.join("\n")).toContain("resolves outside the tree")
  })
})

describe("the auth symlink", () => {
  test("the expected link passes, and its target is never read", async () => {
    const root = await temp()
    const { dataDir, home } = await fakeAuthLink(root)
    expect(await authLinkProblem(dataDir, home)).toBeNull()
  })

  test("a regular file in its place is refused by path, never by contents", async () => {
    const { dataDir, home, link } = await fakeAuthLink(await temp())
    await unlink(link)
    await writeFile(link, `{"token":"${AUTH_CONTENT_MARKER}"}`)
    const problem = await authLinkProblem(dataDir, home)
    expect(problem).toContain(`\`${link}\` is a regular file`)
    expect(problem).not.toContain(AUTH_CONTENT_MARKER)
    // The check left the file as it was.
    expect(await readFile(link, "utf8")).toContain(AUTH_CONTENT_MARKER)
  })

  test("a retargeted link and a missing link are refused", async () => {
    const root = await temp()
    const { dataDir, home, link, target } = await fakeAuthLink(root)
    await unlink(link)
    await symlink(`${target}.other`, link)
    expect(await authLinkProblem(dataDir, home)).toContain(`points to \`${target}.other\`; it must point to \`${target}\` exactly`)
    await unlink(link)
    expect(await authLinkProblem(dataDir, home)).toContain("could not be examined (ENOENT)")
  })

  test("a relative link to the same file is refused: readlink must equal the target exactly", async () => {
    const { dataDir, home, link } = await fakeAuthLink(await temp())
    await unlink(link)
    await symlink("../../home/.local/share/opencode/auth.json", link)
    expect(await authLinkProblem(dataDir, home)).toContain("exactly")
  })
})

describe("overlapProblem", () => {
  test("disjoint directories pass; equal, containing, symlinked and `..` paths are refused", async () => {
    const root = await temp()
    await mkdir(join(root, "a", "inner"), { recursive: true })
    await mkdir(join(root, "b"))
    await symlink(join(root, "a", "inner"), join(root, "into-a"))
    const a = { name: "A", path: join(root, "a") }
    expect(await overlapProblem({ name: "B", path: join(root, "b") }, a)).toBeNull()
    expect(await overlapProblem({ name: "B", path: join(root, "a") }, a)).toContain("is the A")
    expect(await overlapProblem({ name: "B", path: join(root, "into-a") }, a)).toContain("inside the A")
    expect(await overlapProblem({ name: "B", path: join(root, "b", "..", "a", "inner") }, a)).toContain("inside the A")
    expect(await overlapProblem({ name: "B", path: root }, a)).toContain("which contains the A")
    // A path not created yet is compared where it will be, through its nearest existing ancestor.
    expect(await overlapProblem({ name: "B", path: join(root, "missing", "deeper") }, a)).toBeNull()
    expect(await overlapProblem({ name: "B", path: join(root, "into-a", "not-yet") }, a)).toContain("inside the A")
  })
})

test("sha256Of hashes bytes", async () => {
  const file = join(await temp(), "f")
  await writeFile(file, "abc")
  expect(await sha256Of(file)).toBe(sha("abc"))
})
