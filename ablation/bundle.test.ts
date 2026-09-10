import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { emptyLedger, type RunRecord } from "../core/domain/run-record.ts"
import { selectRoster } from "../core/roster/select.ts"
import { FakeBackend, candidate, fakeChange, fakeClock } from "../core/test-support/fakes.ts"
import { runAblation, type ArmRun } from "./arms.ts"
import {
  BUNDLE_FILE,
  armDirectory,
  codeRevisionFrom,
  writeArmDump,
  writeBundleIndex,
} from "./bundle.ts"
import { MANIFEST_FILE, known, unknownValue, type EvaluationIdentity } from "./manifest.ts"

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
  }
}

const identity: Omit<EvaluationIdentity, "armId" | "repeatId"> = {
  protocolVersion: known(1),
  protocolHash: known("sha256:protocol"),
  fixtureVersion: unknownValue("story 2.4 has not sealed a fixture yet"),
  fixtureHash: unknownValue("story 2.4 has not sealed a fixture yet"),
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
 * The pairing `ablation/live.ts` depends on, pinned where it can actually be
 * exercised.
 *
 * The bundle writer keeps one turn recorder per `backendFor` call and matches
 * the Nth recorder to the Nth run. That is only true while `runAblation` awaits
 * each arm before starting the next. If a later story makes the harness run arms
 * in parallel, this test fails HERE — in a file CI runs — rather than in the live
 * path, which CI can never run, and where the symptom would be one arm's
 * transcript filed under another arm's manifest.
 */
describe("backendFor call order matches the order runAblation returns runs", () => {
  test("sequential arms, one recorder each, in the same order", async () => {
    const calls: string[] = []
    const specs = [
      { id: "a", label: "arm a", provenance: "scripted" as const, slots: 1 },
      { id: "b", label: "arm b", provenance: "scripted" as const, slots: 1 },
    ]
    const runs = await runAblation(
      specs,
      {
        backendFor: (spec) => {
          calls.push(spec.id)
          return new FakeBackend({})
        },
        backend: undefined as never,
        clock: fakeClock(),
        change: fakeChange(),
        candidates: [candidate("anthropic", "claude-sonnet-4-5"), candidate("openai", "gpt-5")],
        providerConfigKey: "provider",
      },
      2,
    )

    expect(calls).toHaveLength(runs.length)
    expect(calls).toEqual(runs.map((run) => run.spec.id))
    expect(runs.map((run) => `${run.spec.id}:${run.repeat}`)).toEqual(["a:0", "b:0", "a:1", "b:1"])
  })
})

describe("the code revision is established or explicitly unknown (AC4)", () => {
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" })

  test("a clean worktree records the commit and `dirty: false`", async () => {
    const revision = await codeRevisionFrom(async (_command, args) =>
      args[0] === "rev-parse" ? ok("13eadc6e51d1\n") : ok(""),
    )
    expect(revision).toEqual(known({ commit: "13eadc6e51d1", dirty: false }))
  })

  test("a dirty worktree keeps the commit AND says the worktree was dirty", async () => {
    const revision = await codeRevisionFrom(async (_command, args) =>
      args[0] === "rev-parse" ? ok("13eadc6e51d1\n") : ok(" M core/run/review.ts\n"),
    )
    expect(revision).toEqual(known({ commit: "13eadc6e51d1", dirty: true }))
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
      args[0] === "rev-parse" ? ok("13eadc6\n") : { exitCode: 1, stdout: "", stderr: "broken" },
    )
    expect(revision.kind).toBe("unknown")
    if (revision.kind !== "unknown") throw new Error("unreachable")
    expect(revision.why).toContain("13eadc6")
    expect(revision.why).toContain("clean")
  })

  test("empty rev-parse output is an unknown, never a commit of `''`", async () => {
    const revision = await codeRevisionFrom(async () => ok("   \n"))
    expect(revision.kind).toBe("unknown")
  })
})
