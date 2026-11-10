/**
 * `scripts/live-check.ts` against real git repositories: the before/after check
 * must name every change to tracked bytes, the staged index and untracked
 * content by its exact path (validation-plan.md, Preparation checks), and
 * refuse to write inside the reviewed repository. Nothing here starts a host
 * or calls a provider.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { makeReviewRepo, setupGit, type ReviewRepo } from "../adapters/opencode/test-support/repo-snapshot.ts"
import { madRecord, policyGit, runLiveCheck, type CheckRecord } from "./live-check.ts"
import { differences, snapshot, snapshotFromJson, snapshotToJson } from "./repo-state.ts"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture(dirty: boolean) {
  const repo: ReviewRepo = await makeReviewRepo({ dirty })
  const mad: ReviewRepo = await makeReviewRepo({ dirty: false })
  const outDir = await mkdtemp(join(tmpdir(), "mad-live-check-out-"))
  cleanups.push(repo.remove, mad.remove, () => rm(outDir, { recursive: true, force: true }))
  const lines: string[] = []
  const errors: string[] = []
  const io = { out: (line: string) => lines.push(line), err: (line: string) => errors.push(line), madRoot: mad.dir, now: () => new Date(0) }
  const run = (...argv: string[]) => runLiveCheck(argv, io)
  return { repo: repo.dir, mad: mad.dir, outDir, lines, errors, run }
}

/** `before`, then `mutate`, then `after`: the exit code and the recorded differences. */
async function check(dirty: boolean, mutate: (repo: string) => Promise<void>) {
  const f = await fixture(dirty)
  const before = join(f.outDir, "before.json")
  const after = join(f.outDir, "after.json")
  expect(await f.run("before", "--repo", f.repo, "--out", before)).toBe(0)
  await mutate(f.repo)
  const code = await f.run("after", "--repo", f.repo, "--before", before, "--out", after)
  const record = JSON.parse(await readFile(after, "utf8")) as CheckRecord
  return { code, record, lines: f.lines }
}

describe("live-check — the before/after comparison", () => {
  test("no change: exit 0, no differences, and the after record says so", async () => {
    const { code, record, lines } = await check(true, async () => {})
    expect(code).toBe(0)
    expect(record.differences).toEqual([])
    expect(lines.some((line) => line.startsWith("after: the repository is unchanged"))).toBe(true)
  })

  test("an already-dirty tracked file edited again, its status unchanged, is named", async () => {
    const { code, record, lines } = await check(true, (repo) =>
      writeFile(join(repo, "src", "pay.ts"), "export const fee = (total: number) => total * 0.02\n"),
    )
    expect(code).toBe(1)
    expect(record.differences).toEqual(['changed "src/pay.ts"'])
    expect(lines).toContain('  changed "src/pay.ts"')
  })

  test("a staged change is named as an index change, with the staged path", async () => {
    const { code, record, lines } = await check(true, (repo) => setupGit(repo, ["add", "src/pay.ts"]))
    expect(code).toBe(1)
    expect(record.differences).toContain("the staged index changed")
    expect(record.differences).toContain('staged "src/pay.ts"')
    expect(lines).toContain('  staged "src/pay.ts"')
  })

  test("a staged path with a newline and a trailing space is named exactly", async () => {
    const { record } = await check(false, async (repo) => {
      await writeFile(join(repo, "a\nb.txt "), "x")
      await setupGit(repo, ["add", "--", "a\nb.txt "])
    })
    expect(record.differences).toContain('staged "a\\nb.txt "')
  })

  test("a path removed from the index is named as unstaged", async () => {
    const { record } = await check(false, (repo) => setupGit(repo, ["rm", "-q", "--cached", "src/pay.ts"]))
    expect(record.differences).toContain('unstaged "src/pay.ts"')
  })

  test("changed untracked bytes are named", async () => {
    const { code, record } = await check(true, (repo) => writeFile(join(repo, "notes.txt"), "untracked scratch, edited\n"))
    expect(code).toBe(1)
    expect(record.differences).toEqual(['changed "notes.txt"'])
  })

  test("a new file whose name holds a newline is named exactly, not trimmed or split", async () => {
    const { code, record } = await check(false, (repo) => writeFile(join(repo, "a\nb.txt "), "x"))
    expect(code).toBe(1)
    expect(record.differences).toEqual(['added "a\\nb.txt "'])
  })

  test("a snapshot survives its JSON form: no differences after a round trip", async () => {
    const f = await fixture(true)
    const taken = await snapshot(f.repo)
    const back = snapshotFromJson(JSON.parse(JSON.stringify(snapshotToJson(taken))))
    expect(differences(taken, back)).toEqual([])
  })
})

describe("live-check — the MAD record", () => {
  test("names the full commit id, and a clean checkout has no status entries", async () => {
    const f = await fixture(false)
    const record = await madRecord(f.mad)
    expect(record.revision).toMatch(/^[0-9a-f]{40}$/)
    expect(record.status).toEqual([])
    expect(record.flagged).toEqual([])
  })

  test("two different staged versions under the same worktree and status have different digests", async () => {
    const repo = await makeReviewRepo({ dirty: true })
    cleanups.push(repo.remove)
    const final = await readFile(join(repo.dir, "src", "pay.ts"))
    const stageVersion = async (text: string) => {
      await writeFile(join(repo.dir, "src", "pay.ts"), text)
      await setupGit(repo.dir, ["add", "src/pay.ts"])
      await writeFile(join(repo.dir, "src", "pay.ts"), final)
      return madRecord(repo.dir)
    }
    const first = await stageVersion("export const fee = (total: number) => total * 0.5\n")
    const second = await stageVersion("export const fee = (total: number) => total * 0.7\n")
    expect(first.status).toEqual(second.status)
    expect(first.status).toContain("MM src/pay.ts")
    expect(second.uncommittedSha256).not.toBe(first.uncommittedSha256)
  })

  // Only assume-unchanged is driven here: on the git this suite runs with,
  // `update-index --skip-worktree` outside a sparse checkout leaves the entry
  // tagged `H`, so it would not exercise the `S` branch.
  test("an assume-unchanged file whose bytes change moves the digest, and is never called clean", async () => {
    for (const flag of ["--assume-unchanged"]) {
      const repo = await makeReviewRepo({ dirty: false })
      cleanups.push(repo.remove)
      await setupGit(repo.dir, ["update-index", flag, "src/pay.ts"])
      const first = await madRecord(repo.dir)
      await writeFile(join(repo.dir, "src", "pay.ts"), "export const fee = (total: number) => total * 0.9\n")
      const second = await madRecord(repo.dir)
      // assume-unchanged hides the edit from status and diff; the digest must move anyway.
      expect(second.status).toEqual([])
      expect(second.status).toEqual(first.status)
      expect(first.flagged).toEqual(["src/pay.ts"])
      expect(second.flagged).toEqual(["src/pay.ts"])
      expect(second.uncommittedSha256).not.toBe(first.uncommittedSha256)
    }
  })

  test("the CLI calls a checkout with flagged paths not clean", async () => {
    const f = await fixture(true)
    await setupGit(f.mad, ["update-index", "--assume-unchanged", "src/pay.ts"])
    expect(await f.run("before", "--repo", f.repo, "--out", join(f.outDir, "b.json"))).toBe(0)
    expect(f.lines[0]).toContain("(1 paths git is told not to look at)")
    expect(f.lines[0]).not.toContain("clean")
  })

  test("an untracked symlink is identified by its target, never followed, dangling or not", async () => {
    const repo = await makeReviewRepo({ dirty: false })
    cleanups.push(repo.remove)
    await symlink("/nonexistent/target-a", join(repo.dir, "link"))
    const first = await madRecord(repo.dir)
    expect(first.status).toEqual(["?? link"])
    await rm(join(repo.dir, "link"))
    await symlink("/nonexistent/target-b", join(repo.dir, "link"))
    expect((await madRecord(repo.dir)).uncommittedSha256).not.toBe(first.uncommittedSha256)
  })

  test("a staged rename is one entry holding its source, even a source named like an untracked record", async () => {
    const repo = await makeReviewRepo({ dirty: false })
    cleanups.push(repo.remove)
    await writeFile(join(repo.dir, "?? src.txt"), "moved\n")
    await setupGit(repo.dir, ["add", "--", "?? src.txt"])
    await setupGit(repo.dir, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--no-verify", "-m", "src"])
    await setupGit(repo.dir, ["mv", "--", "?? src.txt", "dst.txt"])
    // An ignored `src.txt` is in no status entry. Read as an untracked record,
    // the source field `?? src.txt` would name it, and its bytes would move the digest.
    await writeFile(join(repo.dir, ".git", "info", "exclude"), "src.txt\n")
    await writeFile(join(repo.dir, "src.txt"), "ignored, first\n")
    const first = await madRecord(repo.dir)
    expect(first.status).toEqual(["R  dst.txt\0?? src.txt"])
    await writeFile(join(repo.dir, "src.txt"), "ignored, second\n")
    expect((await madRecord(repo.dir)).uncommittedSha256).toBe(first.uncommittedSha256)
  })

  test("a dirty checkout lists its entries, and its digest moves with untracked content", async () => {
    const repo = await makeReviewRepo({ dirty: true })
    cleanups.push(repo.remove)
    const first = await madRecord(repo.dir)
    expect(first.status).toEqual([" M src/pay.ts", "?? notes.txt"])
    await writeFile(join(repo.dir, "notes.txt"), "other scratch\n")
    const second = await madRecord(repo.dir)
    expect(second.uncommittedSha256).not.toBe(first.uncommittedSha256)
    expect(second.revision).toBe(first.revision)
  })
})

describe("live-check — the MAD checkout between before and after", () => {
  const commit = (dir: string) =>
    setupGit(dir, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--no-verify", "--allow-empty", "-m", "next"])

  test("a new commit alone, its content unchanged, is named and exits 1 with the repository unchanged", async () => {
    const f = await fixture(true)
    const before = join(f.outDir, "before.json")
    expect(await f.run("before", "--repo", f.repo, "--out", before)).toBe(0)
    const was = (JSON.parse(await readFile(before, "utf8")) as CheckRecord).mad
    await commit(f.mad)
    const after = join(f.outDir, "after.json")
    expect(await f.run("after", "--repo", f.repo, "--before", before, "--out", after)).toBe(1)
    const record = JSON.parse(await readFile(after, "utf8")) as CheckRecord
    expect(record.differences).toEqual([])
    expect(record.mad.uncommittedSha256).toBe(was.uncommittedSha256)
    expect(record.madDifferences).toEqual([`MAD revision ${was.revision} -> ${record.mad.revision}`])
    expect(f.lines).toContain("after: the MAD checkout CHANGED since before (1)")
    expect(f.lines.some((line) => line.startsWith("after: the repository is unchanged"))).toBe(true)
  })

  test("a change to the checkout's uncommitted content alone, revision and repository unchanged, exits 1", async () => {
    const f = await fixture(true)
    const before = join(f.outDir, "before.json")
    expect(await f.run("before", "--repo", f.repo, "--out", before)).toBe(0)
    await writeFile(join(f.mad, "scratch.txt"), "edited between the snapshots\n")
    const after = join(f.outDir, "after.json")
    expect(await f.run("after", "--repo", f.repo, "--before", before, "--out", after)).toBe(1)
    const record = JSON.parse(await readFile(after, "utf8")) as CheckRecord
    expect(record.differences).toEqual([])
    expect(record.madDifferences).toEqual(["MAD uncommitted content changed"])
  })

  test("a change to the checkout's uncommitted content or flags is named, beside the repository's own changes", async () => {
    const f = await fixture(true)
    const before = join(f.outDir, "before.json")
    expect(await f.run("before", "--repo", f.repo, "--out", before)).toBe(0)
    await writeFile(join(f.mad, "scratch.txt"), "edited between the snapshots\n")
    await setupGit(f.mad, ["update-index", "--assume-unchanged", "src/pay.ts"])
    await writeFile(join(f.repo, "notes.txt"), "untracked scratch, edited\n")
    const after = join(f.outDir, "after.json")
    expect(await f.run("after", "--repo", f.repo, "--before", before, "--out", after)).toBe(1)
    const record = JSON.parse(await readFile(after, "utf8")) as CheckRecord
    expect(record.differences).toEqual(['changed "notes.txt"'])
    expect(record.madDifferences).toEqual(["MAD uncommitted content changed", "MAD flagged paths changed"])
  })

  test("an unchanged checkout records no MAD differences", async () => {
    const { record } = await check(true, async () => {})
    expect(record.madDifferences).toEqual([])
  })

  test("a before record whose MAD fields are missing or malformed is refused with exit 2", async () => {
    const f = await fixture(true)
    const before = join(f.outDir, "before.json")
    expect(await f.run("before", "--repo", f.repo, "--out", before)).toBe(0)
    const good = JSON.parse(await readFile(before, "utf8")) as Record<string, unknown>
    const bad = [
      { ...good, mad: undefined },
      { ...good, mad: { ...(good.mad as object), revision: 7 } },
      { ...good, mad: { ...(good.mad as object), flagged: "src/pay.ts" } },
      { ...good, mad: { ...(good.mad as object), uncommittedSha256: undefined } },
    ]
    for (const [n, record] of bad.entries()) {
      const file = join(f.outDir, `bad-${n}.json`)
      await writeFile(file, JSON.stringify(record))
      expect(await f.run("after", "--repo", f.repo, "--before", file, "--out", join(f.outDir, `a-${n}.json`))).toBe(2)
      expect(f.errors[n]).toContain("--before is not a before record")
      expect(await stat(join(f.outDir, `a-${n}.json`)).catch(() => "absent")).toBe("absent")
    }
  })
})

describe("live-check — git reads under the read-only policy", () => {
  /** A dirty repository whose own config points diff.external, a textconv driver and core.fsmonitor at a marker-writing helper. */
  async function hostileRepo() {
    const repo = await makeReviewRepo({ dirty: true })
    const bin = await mkdtemp(join(tmpdir(), "mad-live-check-helper-"))
    cleanups.push(repo.remove, () => rm(bin, { recursive: true, force: true }))
    const marker = join(bin, "ran")
    const helper = join(bin, "helper")
    await writeFile(helper, `#!/bin/sh\necho "$0 $*" >> '${marker}'\ncat "$1" 2>/dev/null\n`)
    await chmod(helper, 0o755)
    await writeFile(join(repo.dir, ".gitattributes"), "*.ts diff=conv\n")
    await setupGit(repo.dir, ["config", "diff.external", helper])
    await setupGit(repo.dir, ["config", "diff.conv.textconv", helper])
    await setupGit(repo.dir, ["config", "core.fsmonitor", helper])
    const ran = async () => (await stat(marker).catch(() => undefined)) !== undefined
    return { repo: repo.dir, ran }
  }

  test("the MAD record and the snapshot run no external diff, textconv or fsmonitor helper", async () => {
    const { repo, ran } = await hostileRepo()
    const record = await madRecord(repo)
    expect(record.status).toContain(" M src/pay.ts")
    await snapshot(repo, policyGit)
    expect(await ran()).toBe(false)
  })

  test("before and after on a hostile repository run no helper either", async () => {
    const { repo, ran } = await hostileRepo()
    const f = await fixture(false)
    const before = join(f.outDir, "before.json")
    expect(await f.run("before", "--repo", repo, "--out", before)).toBe(0)
    expect(await f.run("after", "--repo", repo, "--before", before, "--out", join(f.outDir, "after.json"))).toBe(0)
    expect(await ran()).toBe(false)
  })

  test("an inherited GIT_DIR does not redirect the MAD record", async () => {
    const mad = await makeReviewRepo({ dirty: false })
    const other = await makeReviewRepo({ dirty: false })
    cleanups.push(mad.remove, other.remove)
    await writeFile(join(other.dir, "extra.txt"), "x")
    await setupGit(other.dir, ["add", "extra.txt"])
    await setupGit(other.dir, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--no-verify", "-m", "other"])
    const own = (await madRecord(mad.dir)).revision
    const saved = process.env.GIT_DIR
    process.env.GIT_DIR = join(other.dir, ".git")
    try {
      expect((await madRecord(mad.dir)).revision).toBe(own)
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = saved
    }
  })

  test("a repository whose config defines a filter driver is refused before any read", async () => {
    const f = await fixture(true)
    await setupGit(f.repo, ["config", "filter.x.clean", "cat"])
    expect(await f.run("before", "--repo", f.repo, "--out", join(f.outDir, "b.json"))).toBe(2)
    expect(f.errors[0]).toContain("executable filter driver(s) `x`")
  })
})

describe("live-check — usage refusals (exit 2, nothing written)", () => {
  test("a --before that is not JSON, or not a before record, is refused", async () => {
    const f = await fixture(true)
    const junk = join(f.outDir, "junk.json")
    await writeFile(junk, "not json")
    expect(await f.run("after", "--repo", f.repo, "--before", junk, "--out", join(f.outDir, "a1.json"))).toBe(2)
    expect(f.errors[0]).toContain("--before is not JSON")
    const shapeless = join(f.outDir, "shapeless.json")
    await writeFile(shapeless, JSON.stringify({ kind: "before", repo: f.repo }))
    expect(await f.run("after", "--repo", f.repo, "--before", shapeless, "--out", join(f.outDir, "a2.json"))).toBe(2)
    expect(f.errors[1]).toContain("--before is not a before record")
  })

  test("a dangling symlink at --out is refused, not followed", async () => {
    const f = await fixture(true)
    const out = join(f.outDir, "b.json")
    await symlink(join(f.outDir, "nowhere.json"), out)
    expect(await f.run("before", "--repo", f.repo, "--out", out)).toBe(2)
    expect(f.errors[0]).toContain("--out already exists")
    expect(await stat(join(f.outDir, "nowhere.json")).catch(() => "absent")).toBe("absent")
  })

  test("--out inside the reviewed repository is refused", async () => {
    const f = await fixture(true)
    expect(await f.run("before", "--repo", f.repo, "--out", join(f.repo, "before.json"))).toBe(2)
    expect(f.errors[0]).toContain("--out must be outside the reviewed repository")
    expect(await readFile(join(f.repo, "before.json")).catch(() => "absent")).toBe("absent")
  })

  test("a relative path is refused", async () => {
    const f = await fixture(true)
    expect(await f.run("before", "--repo", "repo", "--out", join(f.outDir, "b.json"))).toBe(2)
    expect(f.errors[0]).toContain("--repo must be an absolute path")
  })

  test("an existing --out is never overwritten", async () => {
    const f = await fixture(true)
    const out = join(f.outDir, "b.json")
    await writeFile(out, "keep")
    expect(await f.run("before", "--repo", f.repo, "--out", out)).toBe(2)
    expect(await readFile(out, "utf8")).toBe("keep")
  })

  test("a before record taken of another repository is refused", async () => {
    const f = await fixture(true)
    const other = await makeReviewRepo({ dirty: false })
    cleanups.push(other.remove)
    const before = join(f.outDir, "before.json")
    expect(await f.run("before", "--repo", other.dir, "--out", before)).toBe(0)
    expect(await f.run("after", "--repo", f.repo, "--before", before, "--out", join(f.outDir, "after.json"))).toBe(2)
    expect(f.errors[0]).toContain("--before records")
  })

  test("a directory that is not a repository's top is refused", async () => {
    const f = await fixture(true)
    expect(await f.run("before", "--repo", join(f.repo, "src"), "--out", join(f.outDir, "b.json"))).toBe(2)
    expect(f.errors[0]).toContain("is not the top of a git repository")
  })
})
