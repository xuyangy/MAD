import { afterEach, describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { emptyLedger, type RunRecord } from "../core/domain/run-record.ts"
import { selectRoster } from "../core/roster/select.ts"
import { FakeBackend, candidate, fakeChange, fakeClock } from "../core/test-support/fakes.ts"
import { runAblation, type ArmRun } from "./arms.ts"
import {
  BUNDLE_FILE,
  PREFIX_FILE,
  armDirectory,
  codeRevisionFrom,
  type PathKind,
  type RunCommand,
  writeArmDump,
  writeBundleIndex,
  writePrefixEvidence,
} from "./bundle.ts"
import { MANIFEST_FILE, known, unknownValue, type EvaluationIdentity } from "./manifest.ts"
import { parseManifest, readBundle } from "./read-bundle.ts"
import { manifestFor, writeBundle } from "./read-bundle.fixture.ts"

const scratch: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

afterEach(async () => {
  while (scratch.length > 0) {
    await rm(scratch.pop()!, { recursive: true, force: true })
  }
})

function fakeRecord(runId: string): RunRecord {
  const resolved = selectRoster([candidate("anthropic", "claude-sonnet-4-5")], {
    slots: 1,
    providerConfigKey: "provider",
  })
  return {
    runId,
    startedAt: "2026-09-10T00:00:00.000Z",
    finishedAt: "2026-09-10T00:00:01.000Z",
    roster: resolved.roster,
    answered: 1,
    findings: [],
    pool: [],
    lensInstructions: [],
    threshold: 0.5,
    maxRounds: 3,
    warnings: resolved.warnings,
    ledger: emptyLedger(),
  }
}

function armRun(id: string, repeat: number, runId: string): ArmRun {
  return {
    spec: { id, label: `arm ${id}`, provenance: "live", slots: 1 },
    repeat,
    record: fakeRecord(runId),
    rendered: `MAD review — run ${runId}\n`,
    backend: new FakeBackend({}),
  }
}

const identity: Omit<EvaluationIdentity, "armId" | "repeatId"> = {
  protocolVersion: known(1),
  protocolHash: known("sha256:protocol"),
  fixtureVersion: unknownValue("--fixture-version was not given"),
  fixtureHash: unknownValue("--fixture-hash was not given"),
  codeRevision: known({ commit: "13eadc6", dirty: false }),
}

describe("the bundle layout is fixed here", () => {
  test("one directory per arm, per repeat, and the run id stays the leaf", () => {
    expect(armDirectory("/scratch/bundle", "on", 0)).toBe("/scratch/bundle/on/0")
  })

  test("an arm id that is not path-safe is made path-safe, never trusted", () => {
    expect(armDirectory("/scratch/bundle", "../escape", 1)).toBe("/scratch/bundle/.._escape/1")
  })
})

describe("the bundle index declares what the evaluation MEANT to produce", () => {
  test("it names every arm and repeat, and is written before any arm runs", async () => {
    const root = await tempDir("mad-bundle-index-")
    const written = await writeBundleIndex({
      bundleRoot: root,
      worktree: "/Users/somebody/project",
      arms: [
        { armId: "on", repeatId: 0 },
        { armId: "off", repeatId: 0 },
      ],
      createdAt: "2026-09-10T00:00:00.000Z",
    })
    expect(written.ok).toBe(true)

    const index = JSON.parse(await readFile(join(root, BUNDLE_FILE), "utf8"))
    expect(index.arms).toEqual([
      { armId: "on", repeatId: 0 },
      { armId: "off", repeatId: 0 },
    ])
    expect(index.createdAt).toBe("2026-09-10T00:00:00.000Z")
  })

  test("the index is private to the user who wrote it, like the dump", async () => {
    const root = await tempDir("mad-bundle-mode-")
    await writeBundleIndex({
      bundleRoot: root,
      worktree: "/Users/somebody/project",
      arms: [{ armId: "on", repeatId: 0 }],
      createdAt: "2026-09-10T00:00:00.000Z",
    })
    const mode = (await stat(join(root, BUNDLE_FILE))).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test("AD-16 — a bundle root inside the repository under review is REFUSED", async () => {
    const worktree = await tempDir("mad-bundle-repo-")
    const written = await writeBundleIndex({
      bundleRoot: join(worktree, "bundle"),
      worktree,
      arms: [{ armId: "on", repeatId: 0 }],
      createdAt: "2026-09-10T00:00:00.000Z",
    })
    expect(written.ok).toBe(false)
    expect(await readdir(worktree)).toEqual([])
  })

  test("A SYMLINK INTO THE REPOSITORY IS REFUSED (review finding 1, 2026-09-10)", async () => {
    // The whole of the defect: `refusalFor` compares resolved-but-not-followed
    // paths, so an alias pointing at the worktree looked like an unrelated tree
    // and the index landed inside the repository AD-16 says MAD never writes to.
    const worktree = await tempDir("mad-bundle-symlink-repo-")
    const outside = await tempDir("mad-bundle-symlink-alias-")
    const alias = join(outside, "alias")
    await symlink(worktree, alias)

    const written = await writeBundleIndex({
      bundleRoot: join(alias, "output"),
      worktree,
      arms: [{ armId: "on", repeatId: 0 }],
      createdAt: "2026-09-10T00:00:00.000Z",
    })
    expect(written.ok).toBe(false)
    expect(await readdir(worktree)).toEqual([])
  })

  test("a relative bundle root is refused — it would resolve against the project", async () => {
    const written = await writeBundleIndex({
      bundleRoot: "out",
      worktree: "/Users/somebody/project",
      arms: [{ armId: "on", repeatId: 0 }],
      createdAt: "2026-09-10T00:00:00.000Z",
    })
    expect(written.ok).toBe(false)
  })
})

describe("one arm's dump", () => {
  test("it writes the AD-16 files AND the manifest, under the arm's own directory", async () => {
    const root = await tempDir("mad-bundle-arm-")
    const outcome = await writeArmDump({
      bundleRoot: root,
      run: armRun("on", 0, "run-on-0"),
      change: fakeChange(),
      identity,
      worktree: "/Users/somebody/project",
    })
    expect(outcome.kind).toBe("written")

    const dir = join(root, "on", "0", "run-on-0")
    const written = (await readdir(dir)).sort()
    expect(written).toContain(MANIFEST_FILE)
    expect(written).toContain("record.json")
    expect(written).toContain("report.txt")
  })

  test("the manifest carries the arm and repeat id it was written for", async () => {
    const root = await tempDir("mad-bundle-identity-")
    await writeArmDump({
      bundleRoot: root,
      run: armRun("off", 2, "run-off-2"),
      change: fakeChange(),
      identity,
      worktree: "/Users/somebody/project",
    })
    const manifest = JSON.parse(
      await readFile(join(root, "off", "2", "run-off-2", MANIFEST_FILE), "utf8"),
    )
    expect(manifest.identity.armId).toBe("off")
    expect(manifest.identity.repeatId).toBe(2)
    expect(manifest.schemaVersion).toBe(1)
  })

  test("NO TURN RECORDER IS AN EXPLICIT UNKNOWN, never a count of zero", async () => {
    const root = await tempDir("mad-bundle-turns-")
    await writeArmDump({
      bundleRoot: root,
      run: armRun("on", 0, "run-on-0"),
      change: fakeChange(),
      identity,
      worktree: "/Users/somebody/project",
    })
    const manifest = JSON.parse(
      await readFile(join(root, "on", "0", "run-on-0", MANIFEST_FILE), "utf8"),
    )
    expect(manifest.stageOutputs.turnFiles.kind).toBe("unknown")
  })

  test("turns supplied are counted, and each one is written as its own file", async () => {
    const root = await tempDir("mad-bundle-turnfiles-")
    const turns = [
      {
        seq: 1,
        slot: "discovery-1",
        input: "review this",
        instructions: "be a reviewer",
        envelope: { ok: true, value: {} } as never,
      },
    ]
    await writeArmDump({
      bundleRoot: root,
      run: armRun("on", 0, "run-on-0"),
      change: fakeChange(),
      identity,
      turns,
      worktree: "/Users/somebody/project",
    })
    const dir = join(root, "on", "0", "run-on-0")
    const manifest = JSON.parse(await readFile(join(dir, MANIFEST_FILE), "utf8"))
    expect(manifest.stageOutputs.turnFiles).toEqual({ kind: "known", value: 1 })
    expect((await readdir(dir)).filter((name) => name.startsWith("turn-"))).toHaveLength(1)
  })

  test("AD-16 — an arm dump inside the repository under review is REFUSED", async () => {
    const worktree = await tempDir("mad-bundle-arm-repo-")
    const outcome = await writeArmDump({
      bundleRoot: join(worktree, "bundle"),
      run: armRun("on", 0, "run-on-0"),
      change: fakeChange(),
      identity,
      worktree,
    })
    expect(outcome.kind).toBe("refused")
    expect(await readdir(worktree)).toEqual([])
  })
})

/**
 * The recorder-to-run pairing, after review finding a/4 (2026-09-10).
 *
 * It used to be an array index into `runs`, which is correct only while
 * `runAblation` is sequential and which fails SILENTLY under concurrency: equal
 * counts, swapped contents, one arm's transcript filed under another arm's
 * manifest. `ArmRun.backend` makes it a link. These tests pin the link and the
 * per-arm callback, both in a file CI actually runs — the live path never is.
 */
describe("each arm carries the backend it ran against, and is offered as it finishes", () => {
  const deps = (backends: Map<string, FakeBackend>) => ({
    backendFor: (spec: { id: string }) => {
      const backend = new FakeBackend({})
      backends.set(spec.id, backend)
      return backend
    },
    backend: undefined as never,
    clock: fakeClock(),
    change: fakeChange(),
    candidates: [candidate("anthropic", "claude-sonnet-4-5"), candidate("openai", "gpt-5")],
    providerConfigKey: "provider",
  })

  test("ArmRun.backend IS the object backendFor returned for that arm", async () => {
    const backends = new Map<string, FakeBackend>()
    const runs = await runAblation(
      [
        { id: "a", label: "arm a", provenance: "scripted" as const, slots: 1 },
        { id: "b", label: "arm b", provenance: "scripted" as const, slots: 1 },
      ],
      deps(backends),
    )
    // Identity, not equality. Two FakeBackends are deeply equal and are not the
    // same object, which is the whole distinction this field exists to carry.
    for (const run of runs) {
      expect(run.backend).toBe(backends.get(run.spec.id)!)
    }
  })

  test("onArmComplete fires once per arm, BEFORE the next arm starts", async () => {
    const order: string[] = []
    const backends = new Map<string, FakeBackend>()
    await runAblation(
      [
        { id: "a", label: "arm a", provenance: "scripted" as const, slots: 1 },
        { id: "b", label: "arm b", provenance: "scripted" as const, slots: 1 },
      ],
      {
        ...deps(backends),
        backendFor: (spec) => {
          order.push(`start:${spec.id}`)
          const backend = new FakeBackend({})
          backends.set(spec.id, backend)
          return backend
        },
        onArmComplete: (run) => {
          order.push(`done:${run.spec.id}`)
        },
      },
    )
    expect(order).toEqual(["start:a", "done:a", "start:b", "done:b"])
  })

  test("A THROW FROM onArmComplete STOPS THE RUN — no further arm is billed", async () => {
    const started: string[] = []
    const backends = new Map<string, FakeBackend>()
    await expect(
      runAblation(
        [
          { id: "a", label: "arm a", provenance: "scripted" as const, slots: 1 },
          { id: "b", label: "arm b", provenance: "scripted" as const, slots: 1 },
        ],
        {
          ...deps(backends),
          backendFor: (spec) => {
            started.push(spec.id)
            const backend = new FakeBackend({})
            backends.set(spec.id, backend)
            return backend
          },
          onArmComplete: () => {
            throw new Error("the dump could not be written")
          },
        },
      ),
    ).rejects.toThrow("the dump could not be written")
    expect(started).toEqual(["a"])
  })

  test("an awaited onArmComplete really is awaited", async () => {
    const events: string[] = []
    const backends = new Map<string, FakeBackend>()
    await runAblation(
      [
        { id: "a", label: "arm a", provenance: "scripted" as const, slots: 1 },
        { id: "b", label: "arm b", provenance: "scripted" as const, slots: 1 },
      ],
      {
        ...deps(backends),
        backendFor: (spec) => {
          events.push(`start:${spec.id}`)
          const backend = new FakeBackend({})
          backends.set(spec.id, backend)
          return backend
        },
        onArmComplete: async (run) => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          events.push(`written:${run.spec.id}`)
        },
      },
    )
    expect(events).toEqual(["start:a", "written:a", "start:b", "written:b"])
  })
})

describe("the code revision is established or explicitly unknown (AC4)", () => {
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" })
  const BLOB_A = "a".repeat(40)
  const BLOB_B = "b".repeat(40)

  /**
   * A stubbed git and worktree: `status` is the raw `-z` output, `files` maps each
   * absolute path to what is there, and `blobs` maps each absolute path to its
   * `hash-object` answer. Every git call is recorded.
   */
  function stubbed(options: {
    status: string
    toplevel?: { exitCode: number; stdout: string; stderr?: string } | "throw"
    files?: Record<string, "file" | { other: string } | "throw">
    blobs?: Record<string, string | { exitCode: number; stderr: string }>
  }) {
    const calls: string[][] = []
    const run = async (_command: string, args: readonly string[]) => {
      calls.push([...args])
      if (args[0] === "rev-parse" && args[1] === "HEAD") return ok("13eadc6e51d1\n")
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        const top = options.toplevel ?? ok("/repo\n")
        if (top === "throw") throw new Error("git vanished")
        return { stderr: "", ...top }
      }
      if (args[0] === "status") return ok(options.status)
      if (args[0] === "hash-object") {
        const answer = options.blobs?.[args.at(-1)!]
        if (answer === undefined) throw new Error(`no blob stubbed for ${args.at(-1)}`)
        return typeof answer === "string" ? ok(`${answer}\n`) : { stdout: "", ...answer }
      }
      throw new Error(`unexpected git ${args.join(" ")}`)
    }
    const pathKind = async (path: string) => {
      const kind = options.files?.[path]
      if (kind === "throw") throw new Error("EACCES: permission denied")
      return kind ?? ("absent" as const)
    }
    return { run, pathKind, calls }
  }

  test("a clean worktree records the commit, `dirty: false` and no entries", async () => {
    const git = stubbed({ status: "" })
    expect(await codeRevisionFrom(git.run, git.pathKind)).toEqual(known({ commit: "13eadc6e51d1", dirty: false, entries: [] }))
    expect(git.calls).toContainEqual(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  })

  test("a dirty worktree keeps the commit and records every porcelain record with the blob of the file now at its path", async () => {
    const git = stubbed({
      // modified; untracked; staged-deleted; renamed (source as the next field); copied; deleted in the worktree.
      status: " M core/run/review.ts\0?? notes/new.md\0D  gone.ts\0R  moved.ts\0old.ts\0C  copy.ts\0orig.ts\0 D lost.ts\0",
      files: {
        "/repo/core/run/review.ts": "file",
        "/repo/notes/new.md": "file",
        "/repo/moved.ts": "file",
        "/repo/copy.ts": "file",
      },
      blobs: {
        "/repo/core/run/review.ts": BLOB_A,
        "/repo/notes/new.md": BLOB_B,
        "/repo/moved.ts": BLOB_A,
        "/repo/copy.ts": BLOB_B,
      },
    })
    const revision = await codeRevisionFrom(git.run, git.pathKind)
    expect(revision).toEqual(
      known({
        commit: "13eadc6e51d1",
        dirty: true,
        entries: [
          { status: "C ", path: "copy.ts", sourcePath: "orig.ts", blob: BLOB_B },
          { status: " M", path: "core/run/review.ts", blob: BLOB_A },
          { status: "D ", path: "gone.ts", blob: null },
          { status: " D", path: "lost.ts", blob: null },
          { status: "R ", path: "moved.ts", sourcePath: "old.ts", blob: BLOB_A },
          { status: "??", path: "notes/new.md", blob: BLOB_B },
        ],
      }),
    )
    // Each regular file is hashed by its absolute path under the toplevel.
    expect(git.calls.filter((args) => args[0] === "hash-object").map((args) => args.at(-1)).sort()).toEqual(
      ["/repo/copy.ts", "/repo/core/run/review.ts", "/repo/moved.ts", "/repo/notes/new.md"],
    )
  })

  test("a path listed twice keeps both records, sorted by status code unit, each with the file now at the path", async () => {
    const git = stubbed({ status: "?? a\0D  a\0", files: { "/repo/a": "file" }, blobs: { "/repo/a": BLOB_A } })
    expect(await codeRevisionFrom(git.run, git.pathKind)).toEqual(
      known({
        commit: "13eadc6e51d1",
        dirty: true,
        entries: [
          { status: "??", path: "a", blob: BLOB_A },
          { status: "D ", path: "a", blob: BLOB_A },
        ],
      }),
    )
  })

  test("a deleted status with a file present is hashed, and a modified status with no file is `null`: the blob follows the worktree", async () => {
    const git = stubbed({ status: " D here\0 M away\0", files: { "/repo/here": "file" }, blobs: { "/repo/here": BLOB_B } })
    const revision = await codeRevisionFrom(git.run, git.pathKind)
    if (revision.kind !== "known") throw new Error(revision.why)
    expect(revision.value.entries).toEqual([
      { status: " M", path: "away", blob: null },
      { status: " D", path: "here", blob: BLOB_B },
    ])
  })

  test("two renames to one path from different sources differ only in `sourcePath`", async () => {
    const files = { "/repo/c": "file" as const }
    const blobs = { "/repo/c": BLOB_A }
    const one = await codeRevisionFrom(...runAndKind(stubbed({ status: "R  c\0a\0", files, blobs })))
    const two = await codeRevisionFrom(...runAndKind(stubbed({ status: "R  c\0b\0", files, blobs })))
    expect(one).toEqual(known({ commit: "13eadc6e51d1", dirty: true, entries: [{ status: "R ", path: "c", sourcePath: "a", blob: BLOB_A }] }))
    expect(two).toEqual(known({ commit: "13eadc6e51d1", dirty: true, entries: [{ status: "R ", path: "c", sourcePath: "b", blob: BLOB_A }] }))
  })

  test("a symlink, a directory or any other non-regular entry makes the whole revision unknown, naming the path and kind; nothing is hashed", async () => {
    for (const other of ["symlink", "directory (a gitlink, submodule or nested repository)", "FIFO"]) {
      const git = stubbed({ status: " M fine.ts\0?? odd\0", files: { "/repo/fine.ts": "file", "/repo/odd": { other } }, blobs: { "/repo/fine.ts": BLOB_A } })
      const revision = await codeRevisionFrom(git.run, git.pathKind)
      if (revision.kind !== "unknown") throw new Error(`${other} was recorded`)
      expect(revision.why).toContain("`odd`")
      expect(revision.why).toContain(other)
      expect(revision.why).toContain("13eadc6e51d1")
    }
  })

  test("a path that cannot be inspected is unknown, naming the path", async () => {
    const git = stubbed({ status: "?? locked\0", files: { "/repo/locked": "throw" } })
    const revision = await codeRevisionFrom(git.run, git.pathKind)
    if (revision.kind !== "unknown") throw new Error("recorded")
    expect(revision.why).toContain("`locked`")
    expect(revision.why).toContain("EACCES")
  })

  test("a failed `hash-object` or `rev-parse --show-toplevel` is unknown, naming the command and the path", async () => {
    const hashing = stubbed({ status: " M x.ts\0", files: { "/repo/x.ts": "file" }, blobs: { "/repo/x.ts": { exitCode: 128, stderr: "fatal: cannot open" } } })
    const hashed = await codeRevisionFrom(hashing.run, hashing.pathKind)
    if (hashed.kind !== "unknown") throw new Error("recorded")
    expect(hashed.why).toContain("git hash-object -- /repo/x.ts")
    expect(hashed.why).toContain("fatal: cannot open")

    const junk = stubbed({ status: " M x.ts\0", files: { "/repo/x.ts": "file" }, blobs: { "/repo/x.ts": "not-a-blob" } })
    expect((await codeRevisionFrom(junk.run, junk.pathKind)).kind).toBe("unknown")

    for (const toplevel of [{ exitCode: 128, stdout: "", stderr: "fatal: bare" }, "throw" as const, ok("\n")]) {
      const git = stubbed({ status: "", toplevel })
      const revision = await codeRevisionFrom(git.run, git.pathKind)
      if (revision.kind !== "unknown") throw new Error("recorded")
      expect(revision.why).toContain("git rev-parse --show-toplevel")
    }
  })

  test("status output that is not NUL-terminated `XY PATH` records, or a rename with no source, is unknown", async () => {
    for (const status of [" M x.ts", "XYZ\0", "?? \0", "R  c\0"]) {
      const git = stubbed({ status, files: { "/repo/x.ts": "file" }, blobs: { "/repo/x.ts": BLOB_A } })
      expect((await codeRevisionFrom(git.run, git.pathKind)).kind, JSON.stringify(status)).toBe("unknown")
    }
  })

  test("no git at all is an unknown that says why, never an empty string", async () => {
    const revision = await codeRevisionFrom(async () => {
      throw new Error("git: command not found")
    })
    expect(revision.kind).toBe("unknown")
    if (revision.kind !== "unknown") throw new Error("unreachable")
    expect(revision.why).toContain("git: command not found")
  })

  test("a non-zero rev-parse is an unknown carrying git's own words", async () => {
    const revision = await codeRevisionFrom(async () => ({
      exitCode: 128,
      stdout: "",
      stderr: "fatal: not a git repository",
    }))
    expect(revision.kind).toBe("unknown")
    if (revision.kind !== "unknown") throw new Error("unreachable")
    expect(revision.why).toContain("not a git repository")
  })

  test("a commit with no readable status is UNKNOWN, not silently clean", async () => {
    const revision = await codeRevisionFrom(async (_command, args) =>
      args[0] === "rev-parse" ? ok(args[1] === "HEAD" ? "13eadc6\n" : "/repo\n") : { exitCode: 1, stdout: "", stderr: "broken" },
    )
    expect(revision.kind).toBe("unknown")
    if (revision.kind !== "unknown") throw new Error("unreachable")
    expect(revision.why).toContain("13eadc6")
    expect(revision.why).toContain("worktree held is not established")
  })

  test("empty rev-parse output is an unknown, never a commit of `''`", async () => {
    const revision = await codeRevisionFrom(async () => ok("   \n"))
    expect(revision.kind).toBe("unknown")
  })
})

function runAndKind(git: { run: RunCommand; pathKind: PathKind }): [RunCommand, PathKind] {
  return [git.run, git.pathKind]
}

describe("the code revision over real git", () => {
  const environment = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }

  /** Real git, run in `cwd`. */
  function gitIn(cwd: string): RunCommand {
    return async (command, args) => {
      const spawned = Bun.spawn([command, ...args], { cwd, env: environment, stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr] = await Promise.all([new Response(spawned.stdout).text(), new Response(spawned.stderr).text()])
      return { exitCode: await spawned.exited, stdout, stderr }
    }
  }

  async function sh(cwd: string, ...args: string[]): Promise<string> {
    const result = await gitIn(cwd)("git", args)
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
    return result.stdout.trim()
  }

  /** A repository with one commit holding `a` and `b`, identical content. */
  async function repository(): Promise<string> {
    const root = realpathSync(await tempDir("mad-revision-"))
    await sh(root, "init", "-q", "-b", "main")
    await sh(root, "config", "user.email", "test@example.invalid")
    await sh(root, "config", "user.name", "test")
    await sh(root, "config", "commit.gpgsign", "false")
    await writeFile(join(root, "a"), "same\n")
    await writeFile(join(root, "b"), "same\n")
    await mkdir(join(root, "nested", "deeper"), { recursive: true })
    await writeFile(join(root, "nested", "deeper", "keep"), "kept\n")
    await sh(root, "add", ".")
    await sh(root, "commit", "-q", "-m", "init")
    return root
  }

  test("a clean tree gives `dirty: false` and no entries", async () => {
    const root = await repository()
    const head = await sh(root, "rev-parse", "HEAD")
    expect(await codeRevisionFrom(gitIn(root))).toEqual(known({ commit: head, dirty: false, entries: [] }))
  })

  test("renames `a→c` and `b→c` with identical content differ in `sourcePath` and so in cohort key", async () => {
    const first = await repository()
    const second = await repository()
    await sh(first, "mv", "a", "c")
    await sh(second, "mv", "b", "c")
    const one = await codeRevisionFrom(gitIn(first))
    const two = await codeRevisionFrom(gitIn(second))
    if (one.kind !== "known" || two.kind !== "known") throw new Error("unknown")
    const blob = await sh(first, "hash-object", "c")
    expect(one.value.entries).toEqual([{ status: "R ", path: "c", sourcePath: "a", blob }])
    expect(two.value.entries).toEqual([{ status: "R ", path: "c", sourcePath: "b", blob }])

    // The two commits differ (two repositories), so compare keys under one commit.
    const bundleRoot = await tempDir("mad-revision-bundle-")
    await writeBundle(
      bundleRoot,
      [
        { armId: "x", repeatId: 0 },
        { armId: "y", repeatId: 0 },
      ],
      [
        { armId: "x", repeatId: 0, codeRevision: known(one.value) },
        { armId: "y", repeatId: 0, codeRevision: known({ ...two.value, commit: one.value.commit }) },
      ],
    )
    const read = await readBundle(bundleRoot)
    if ("error" in read) throw new Error(read.error)
    expect(read.comparable).toEqual([])
    expect(read.segregated).toHaveLength(2)
  })

  test("a symlink in the worktree makes the revision unknown, naming it", async () => {
    const root = await repository()
    await symlink("a", join(root, "link"))
    const revision = await codeRevisionFrom(gitIn(root))
    if (revision.kind !== "unknown") throw new Error("a symlink was recorded")
    expect(revision.why).toContain("`link`")
    expect(revision.why).toContain("symlink")
  })

  test("a staged deletion with a recreated file keeps `D ` and `??`, each with the current blob; the revision parses and keys identically reordered", async () => {
    const root = await repository()
    await sh(root, "rm", "-q", "--cached", "a")
    await writeFile(join(root, "a"), "recreated\n")
    const revision = await codeRevisionFrom(gitIn(root))
    if (revision.kind !== "known") throw new Error(revision.why)
    const blob = await sh(root, "hash-object", "a")
    expect(revision.value).toEqual({
      commit: await sh(root, "rev-parse", "HEAD"),
      dirty: true,
      entries: [
        { status: "??", path: "a", blob },
        { status: "D ", path: "a", blob },
      ],
    })
    const parsed = parseManifest(manifestFor({ armId: "on", repeatId: 0, codeRevision: known(revision.value) }))
    expect(parsed.ok).toBe(true)

    const bundleRoot = await tempDir("mad-revision-bundle-")
    await writeBundle(
      bundleRoot,
      [
        { armId: "on", repeatId: 0 },
        { armId: "off", repeatId: 0 },
      ],
      [
        { armId: "on", repeatId: 0, codeRevision: known(revision.value) },
        { armId: "off", repeatId: 0, codeRevision: known({ ...revision.value, entries: [...revision.value.entries!].reverse() }) },
      ],
    )
    const read = await readBundle(bundleRoot)
    if ("error" in read) throw new Error(read.error)
    expect(read.segregated).toEqual([])
    expect(read.comparable).toHaveLength(2)
  })

  test("called from a nested directory, porcelain paths are resolved against the toplevel and the right file is hashed", async () => {
    const root = await repository()
    await writeFile(join(root, "a"), "changed at the root\n")
    await writeFile(join(root, "nested", "deeper", "a"), "a different file with the same name\n")
    const revision = await codeRevisionFrom(gitIn(join(root, "nested", "deeper")))
    if (revision.kind !== "known") throw new Error(revision.why)
    expect(revision.value.entries).toEqual([
      { status: " M", path: "a", blob: await sh(root, "hash-object", "a") },
      { status: "??", path: "nested/deeper/a", blob: await sh(root, "hash-object", "nested/deeper/a") },
    ])
    expect(revision.value.entries![0]!.blob).not.toBe(revision.value.entries![1]!.blob)
  })
})

describe("the writer refuses a duplicate slot too", () => {
  test("one arm/repeat declared twice is refused before anything is written", async () => {
    const root = await tempDir("mad-bundle-dup-")
    const written = await writeBundleIndex({
      bundleRoot: root,
      worktree: "/Users/somebody/project",
      arms: [
        { armId: "control", repeatId: 0 },
        { armId: "control", repeatId: 0 },
      ],
      createdAt: "2026-09-10T00:00:00.000Z",
    })
    expect(written.ok).toBe(false)
    if (written.ok) throw new Error("unreachable")
    expect(written.reason).toContain("more than once")
    expect(await readdir(root)).toEqual([])
  })

  test("the same arm at different repeats is written normally", async () => {
    const root = await tempDir("mad-bundle-repeats-")
    const written = await writeBundleIndex({
      bundleRoot: root,
      worktree: "/Users/somebody/project",
      arms: [
        { armId: "control", repeatId: 0 },
        { armId: "control", repeatId: 1 },
      ],
      createdAt: "2026-09-10T00:00:00.000Z",
    })
    expect(written.ok).toBe(true)
  })
})

describe("prefix evidence stays outside the reviewed worktree (story 2-5c review)", () => {
  test.each([
    ["with no record", false],
    ["with a record", true],
  ])("a `prefix` directory symlinked into the worktree is refused %s, and nothing is written there", async (_name, withRecord) => {
    const worktree = await tempDir("mad-prefix-worktree-")
    const bundle = await tempDir("mad-prefix-bundle-")
    await symlink(worktree, join(bundle, "prefix"))
    const outcome = await writePrefixEvidence({
      bundleRoot: bundle,
      worktree,
      change: fakeChange(),
      scheduleHash: `sha256:${"d".repeat(64)}`,
      block: 1,
      ...(withRecord ? { record: fakeRecord("run-prefix") } : { runId: "run-prefix" }),
      forked: false,
      reason: "the shared prefix failed before it could be forked",
      failure: "boom",
    })
    expect(outcome.ok).toBe(false)
    expect(await readdir(worktree)).toEqual([])
  })

  test("an ordinary bundle root gets the file and, with a record, its dump", async () => {
    const worktree = await tempDir("mad-prefix-worktree-")
    const bundle = await tempDir("mad-prefix-bundle-")
    const outcome = await writePrefixEvidence({
      bundleRoot: bundle,
      worktree,
      change: fakeChange(),
      scheduleHash: `sha256:${"d".repeat(64)}`,
      block: 2,
      record: fakeRecord("run-prefix"),
      forked: true,
      reason: "forked",
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.file).toBe(join(bundle, "prefix", "1", PREFIX_FILE))
    expect(outcome.dump).toBe(join(bundle, "prefix", "1", "run-prefix"))
    expect((await stat(join(outcome.dump!, "record.json"))).isFile()).toBe(true)
  })
})
