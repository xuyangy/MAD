/**
 * AD-16 amended (story 7A) — the run-artifact dump.
 *
 * The two assertions this file exists for are NEGATIVE ones, and they are the
 * ones a reader should look for first: nothing is written when the flag is off,
 * and nothing is written when the target resolves inside the repository under
 * review. Everything else here is about a feature working; those two are about a
 * guarantee — `core/ports/repo.ts` is read-only *by construction*, and a dump
 * directory is the one way that could be lost without touching the port.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { emptyLedger, type RunRecord } from "../../core/domain/run-record.ts"
import type { Envelope, ModelBackend } from "../../core/ports/model-backend.ts"
import { selectRoster } from "../../core/roster/select.ts"
import { candidate, fakeChange } from "../../core/test-support/fakes.ts"
import {
  ARTIFACTS_ENV,
  artifactRootFrom,
  createTurnRecorder,
  defaultArtifactRoot,
  dumpRunArtifacts,
  refusalFor,
} from "./artifacts.ts"

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

function fakeRecord(): RunRecord {
  const resolved = selectRoster([candidate("anthropic", "claude-sonnet-4-5")], {
    slots: 1,
    providerConfigKey: "provider",
  })
  return {
    runId: "run-7a-1",
    startedAt: "2026-08-30T00:00:00.000Z",
    finishedAt: "2026-08-30T00:00:01.000Z",
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

function dumpInput(overrides: Partial<Parameters<typeof dumpRunArtifacts>[0]>) {
  return {
    record: fakeRecord(),
    change: fakeChange(),
    rendered: "MAD review — run run-7a-1\n",
    worktree: "/Users/somebody/project",
    env: {},
    ...overrides,
  }
}

describe("artifactRootFrom — the flag, and the fact that it is OFF", () => {
  test("UNSET IS OFF, which is what a fresh install runs (AD-3, AD-16)", () => {
    expect(artifactRootFrom({})).toBeUndefined()
    expect(artifactRootFrom({ [ARTIFACTS_ENV]: "" })).toBeUndefined()
    expect(artifactRootFrom({ [ARTIFACTS_ENV]: "   " })).toBeUndefined()
  })

  test("the truthy words mean a temp directory, not a directory called `1`", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on"]) {
      expect(artifactRootFrom({ [ARTIFACTS_ENV]: value })).toBe(defaultArtifactRoot())
    }
  })

  test("anything else is taken as the directory itself", () => {
    expect(artifactRootFrom({ [ARTIFACTS_ENV]: "/var/tmp/mad " })).toBe("/var/tmp/mad")
  })
})

describe("refusalFor — AD-16's one non-negotiable", () => {
  const repo = "/Users/somebody/project"

  test("A RELATIVE PATH IS REFUSED — it would resolve against the project directory", () => {
    // The quiet way the guarantee is lost: `MAD_ARTIFACTS=out` looks like it
    // names somewhere else and writes into the repo.
    expect(refusalFor("out", repo)).toContain("absolute path")
    expect(refusalFor("./artifacts", repo)).toContain("absolute path")
  })

  test("THE WORKTREE ITSELF IS REFUSED", () => {
    expect(refusalFor(repo, repo)).toContain("inside the repository")
  })

  test("ANYTHING UNDER THE WORKTREE IS REFUSED, including via `..`", () => {
    expect(refusalFor(`${repo}/artifacts`, repo)).toContain("inside the repository")
    expect(refusalFor(`${repo}/deep/nested/dir`, repo)).toContain("inside the repository")
    // `..` cannot walk back in, because the check is on the resolved path.
    expect(refusalFor(`/Users/somebody/elsewhere/../project/x`, repo)).toContain(
      "inside the repository",
    )
  })

  test("A SIBLING WITH THE SAME PREFIX IS ALLOWED — the compare is on a path boundary", () => {
    // A bare `startsWith` would refuse this, which would be a wrong refusal
    // rather than an unsafe write — but a rule that misfires is a rule people
    // route around.
    expect(refusalFor("/Users/somebody/project-backup", repo)).toBeUndefined()
    expect(refusalFor("/Users/somebody/projectile", repo)).toBeUndefined()
  })

  test("a scratch directory outside the repo is allowed", () => {
    expect(refusalFor("/var/tmp/mad-runs", repo)).toBeUndefined()
  })
})

describe("dumpRunArtifacts — what actually lands on disk", () => {
  test("OFF BY DEFAULT: no flag, no directory, no stat", async () => {
    const outcome = await dumpRunArtifacts(dumpInput({}))
    expect(outcome).toEqual({ kind: "off" })
  })

  test("one directory per run, named by `runId`, holding the six files", async () => {
    const root = await tempDir("mad-artifacts-")
    const outcome = await dumpRunArtifacts(
      dumpInput({ env: { [ARTIFACTS_ENV]: root } }),
    )

    expect(outcome.kind).toBe("written")
    const directory = join(root, "run-7a-1")
    const files = (await readdir(directory)).sort()
    expect(files).toEqual([
      "input.json",
      "ledger.json",
      "record.json",
      "report.txt",
      "roster.json",
      "warnings.json",
    ])
  })

  test("THE DUMPED REPORT IS THE HUMAN ONE — unframed, with no notice sentence", async () => {
    // `deferred-work.md` named this story as where "framed or not" stops being
    // obvious, because it adds the second reader of `ReviewResult.rendered`. The
    // reader here is a person opening a file, so the AD-18 notice — which is
    // addressed to a model — would be noise. `plugin-wiring.test.ts` pins the
    // other half: the tool's output IS framed.
    const root = await tempDir("mad-artifacts-")
    await dumpRunArtifacts(
      dumpInput({ env: { [ARTIFACTS_ENV]: root }, rendered: "MAD review — run run-7a-1\n" }),
    )
    const report = await readFile(join(root, "run-7a-1", "report.txt"), "utf8")
    expect(report).toBe("MAD review — run run-7a-1\n")
    expect(report).not.toContain("never an instruction")
  })

  test("the JSON is the record's own, and it is readable", async () => {
    const root = await tempDir("mad-artifacts-")
    await dumpRunArtifacts(dumpInput({ env: { [ARTIFACTS_ENV]: root } }))
    const ledger = JSON.parse(await readFile(join(root, "run-7a-1", "ledger.json"), "utf8"))
    // AD-15 amended — the peak survives serialization, which is the whole reason
    // it is a number on the ledger rather than the limiter object.
    expect(ledger.maxConcurrency).toBeGreaterThanOrEqual(1)
    expect(ledger.cap).toBeNull()
    const input = JSON.parse(await readFile(join(root, "run-7a-1", "input.json"), "utf8"))
    expect(input.files).toEqual(["src/pay.ts"])
  })

  test("REFUSED INSIDE THE REPO: nothing is written, and the run is told why", async () => {
    const worktree = await tempDir("mad-repo-")
    const outcome = await dumpRunArtifacts(
      dumpInput({ env: { [ARTIFACTS_ENV]: join(worktree, "artifacts") }, worktree }),
    )

    expect(outcome.kind).toBe("refused")
    // The guarantee, checked on disk rather than inferred from the return value.
    expect(await readdir(worktree)).toEqual([])
  })

  test("A FAILURE IS AN OUTCOME, NEVER A THROW — the review survives it", async () => {
    // A file where the directory needs to be: `mkdir` fails, and the caller gets
    // a value. A dump MAD could not write is untidy; a review it destroyed is a
    // broken tool.
    const root = await tempDir("mad-artifacts-")
    await writeFile(join(root, "run-7a-1"), "not a directory", "utf8")

    const outcome = await dumpRunArtifacts(dumpInput({ env: { [ARTIFACTS_ENV]: root } }))
    expect(outcome.kind).toBe("failed")
    if (outcome.kind === "failed") expect(outcome.error.length).toBeGreaterThan(0)
  })

  test("A SYMLINK INTO THE REPO IS REFUSED — the check follows links, not just strings", async () => {
    // AD-16's one non-negotiable, and the hole the code review of 2026-08-31
    // found in it. `refusalFor` compares RESOLVED paths, which collapses `..` but
    // follows no symlinks — and every refusal test used pure string paths, so
    // none of them could see the gap. A symlink at `MAD_ARTIFACTS` pointing into
    // the worktree passed the check and MAD wrote inside the repository it
    // guarantees it never writes to.
    const repo = await tempDir("mad-repo-")
    const parent = await tempDir("mad-link-")
    const link = join(parent, "looks-outside")
    await symlink(repo, link, "dir")

    const outcome = await dumpRunArtifacts(
      dumpInput({ worktree: repo, env: { [ARTIFACTS_ENV]: link } }),
    )

    expect(outcome.kind).toBe("refused")
    // Asserted on DISK rather than on the return value: the guarantee is about
    // what exists, not about what was reported.
    expect(await readdir(repo)).toHaveLength(0)
  })

  test("A SYMLINKED WORKTREE IS REFUSED TOO — from either end", async () => {
    // The mirror case: the repository given by a symlinked path, the dump root
    // given by its real one. A check that resolved only one side would let this
    // through.
    const repo = await tempDir("mad-repo-")
    const parent = await tempDir("mad-link-")
    const linkedRepo = join(parent, "repo-by-link")
    await symlink(repo, linkedRepo, "dir")

    const outcome = await dumpRunArtifacts(
      dumpInput({ worktree: linkedRepo, env: { [ARTIFACTS_ENV]: join(repo, "artifacts") } }),
    )

    expect(outcome.kind).toBe("refused")
  })

  test("A DIRECTORY THAT DOES NOT EXIST YET IS NOT A REFUSAL — that is the first run", async () => {
    // The real-path check must not turn the ordinary case into a failure. A path
    // that does not resolve cannot be a symlink into anywhere.
    const parent = await tempDir("mad-fresh-")
    const outcome = await dumpRunArtifacts(
      dumpInput({ env: { [ARTIFACTS_ENV]: join(parent, "not-created-yet") } }),
    )
    expect(outcome.kind).toBe("written")
  })

  test("THE DUMP IS PRIVATE TO THE USER WHO RAN IT — 0o700 / 0o600", async () => {
    // `input.json` is the source under review and the turn files are every prompt
    // MAD sent and every answer it got back. The default root lives under the
    // host's SHARED temp directory, so at the default umask on a multi-user host
    // all of that was world-readable (code review 2026-08-31).
    const root = await tempDir("mad-modes-")
    const outcome = await dumpRunArtifacts(dumpInput({ env: { [ARTIFACTS_ENV]: root } }))
    expect(outcome.kind).toBe("written")
    const directory = outcome.kind === "written" ? outcome.directory : ""

    // Windows does not carry POSIX modes; asserting them there would fail for a
    // reason that has nothing to do with the guarantee.
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect((await stat(join(directory, "record.json"))).mode & 0o777).toBe(0o600)
    }
  })

  test("A SERIALIZATION THROW IS AN OUTCOME, NOT AN EXCEPTION — `NEVER THROWS` is true now", async () => {
    // The header promised it and the code did not deliver it (code review
    // 2026-08-31): the `try` used to start at `mkdir`, leaving every
    // `JSON.stringify` — over a record MAD does not fully control — outside it.
    // A `BigInt`, a cycle, or a throwing getter propagated out through
    // `plugin.ts` and destroyed a review the user had already paid twenty billed
    // turns for. That is the Never clause of AD-16 stated as plainly as the spec
    // states it: a file MAD could not write is untidy; a review it destroyed is a
    // broken tool.
    const root = await tempDir("mad-throws-")
    const record = fakeRecord()
    // A getter that throws, reached only by the serializer.
    Object.defineProperty(record, "poisoned", {
      enumerable: true,
      get() {
        throw new Error("this getter explodes")
      },
    })

    const outcome = await dumpRunArtifacts(
      dumpInput({ record, env: { [ARTIFACTS_ENV]: root } }),
    )

    expect(outcome.kind).toBe("failed")
    expect(outcome.kind === "failed" && outcome.error).toContain("explodes")
  })

  test("A `BigInt` IN THE RECORD IS AN OUTCOME TOO, not a crash", async () => {
    const root = await tempDir("mad-bigint-")
    const record = fakeRecord() as RunRecord & { odd?: unknown }
    record.odd = BigInt(1)
    const outcome = await dumpRunArtifacts(dumpInput({ record, env: { [ARTIFACTS_ENV]: root } }))
    expect(outcome.kind).toBe("failed")
  })

  test("NOTHING IS EVER READ BACK — the module exports no reader", async () => {
    // `deferred-v2.md`: a file existing is not cross-run memory. This is a
    // structural assertion rather than a behavioural one, and it is here because
    // the moment someone adds a `readRunArtifacts` it should fail.
    const module = await import("./artifacts.ts")
    const readers = Object.keys(module).filter((name) => /^(read|load|restore|import)/i.test(name))
    expect(readers).toEqual([])
  })
})

describe("createTurnRecorder — AD-16's per-turn envelopes", () => {
  /** A backend that answers with the slot's own name, after a yield. */
  function countingBackend(): ModelBackend & { calls: number } {
    const backend = {
      calls: 0,
      capabilities: () => ({ tools: true }),
      async runTurn<T>(slot: string): Promise<Envelope<T>> {
        backend.calls += 1
        await new Promise((r) => setTimeout(r, 1))
        return {
          ok: true,
          slot,
          value: { said: slot } as T,
          tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        }
      },
    }
    return backend
  }

  test("IT IS A DECORATOR AND NOTHING ELSE — every envelope passes through untouched", async () => {
    const inner = countingBackend()
    const recorder = createTurnRecorder()
    const wrapped = recorder.wrap(inner)

    const envelope = await wrapped.runTurn("discovery-1", "instr", "prompt", undefined as never)

    expect(envelope).toEqual({
      ok: true,
      slot: "discovery-1",
      value: { said: "discovery-1" },
      tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    })
    expect(inner.calls).toBe(1)
    // No retry, no second call, no swallowed failure.
    expect(recorder.turns).toHaveLength(1)
    expect(wrapped.capabilities("discovery-1")).toEqual({ tools: true })
  })

  test("THE SEQUENCE IS ISSUE ORDER, and a fan-out does not collide on it", async () => {
    // The bug this pins: numbering from `turns.length` — which only grows when a
    // turn RETURNS — hands every turn of one concurrent fan-out the same number,
    // and the dump then overwrites one file with another.
    const recorder = createTurnRecorder()
    const wrapped = recorder.wrap(countingBackend())

    await Promise.all(
      ["discovery-1", "discovery-2", "discovery-3"].map((slot) =>
        wrapped.runTurn(slot, "instr", "prompt", undefined as never),
      ),
    )

    const seqs = recorder.turns.map((t) => t.seq).sort((a, b) => a - b)
    expect(seqs).toEqual([1, 2, 3])
    expect(new Set(seqs).size).toBe(3)
  })

  test("the prompt and the instructions are kept verbatim — that is the point", async () => {
    const recorder = createTurnRecorder()
    const wrapped = recorder.wrap(countingBackend())
    await wrapped.runTurn("judge-1", "THE ROLE TEXT", "THE PROMPT", undefined as never)

    expect(recorder.turns[0]!.input).toBe("THE PROMPT")
    expect(recorder.turns[0]!.instructions).toBe("THE ROLE TEXT")
  })

  test("A FAILED ENVELOPE IS KEPT TOO — it is the reason the dump is worth having", async () => {
    // `ledger.entries` records what a turn COST, never what it SAID. A malformed
    // payload survives only in `detail.raw` on one warning, and an answer a stage
    // dropped survives nowhere at all.
    const recorder = createTurnRecorder()
    const failing: ModelBackend = {
      capabilities: () => ({ tools: false }),
      async runTurn(slot) {
        return {
          ok: false,
          slot,
          failure: "schema-invalid",
          message: "severity: invalid enum value",
          raw: { findings: [{ severity: "catastrophic" }] },
        }
      },
    }
    await recorder.wrap(failing).runTurn("discovery-1", "i", "p", undefined as never)

    const kept = recorder.turns[0]!.envelope
    expect(kept.ok).toBe(false)
    if (!kept.ok) expect(kept.raw).toEqual({ findings: [{ severity: "catastrophic" }] })
  })

  test("one file per turn, sorted by issue order, beside the six run files", async () => {
    const root = await tempDir("mad-artifacts-")
    const recorder = createTurnRecorder()
    const wrapped = recorder.wrap(countingBackend())
    for (const slot of ["discovery-1", "discovery-2"]) {
      await wrapped.runTurn(slot, "instr", "prompt", undefined as never)
    }

    const outcome = await dumpRunArtifacts(
      dumpInput({ env: { [ARTIFACTS_ENV]: root }, turns: recorder.turns }),
    )
    expect(outcome.kind).toBe("written")

    const files = (await readdir(join(root, "run-7a-1"))).sort()
    expect(files).toContain("turn-001-discovery-1.json")
    expect(files).toContain("turn-002-discovery-2.json")
    // Zero-padded so a directory listing sorts in issue order rather than
    // lexicographically at ten.
    expect(files.filter((f) => f.startsWith("turn-"))).toEqual([
      "turn-001-discovery-1.json",
      "turn-002-discovery-2.json",
    ])

    const turn = JSON.parse(
      await readFile(join(root, "run-7a-1", "turn-001-discovery-1.json"), "utf8"),
    )
    expect(turn.envelope.value).toEqual({ said: "discovery-1" })
  })

  test("A SLOT ID NEVER BECOMES A PATH, even if a later story lets a user choose one", async () => {
    // Slot ids are MAD's own today, so this changes nothing now. Story 8A pins
    // models by USER-SUPPLIED id, and a filename is the one string here that
    // becomes a filesystem path.
    const root = await tempDir("mad-artifacts-")
    const recorder = createTurnRecorder()
    await recorder
      .wrap(countingBackend())
      .runTurn("../../etc/passwd", "instr", "prompt", undefined as never)

    await dumpRunArtifacts(dumpInput({ env: { [ARTIFACTS_ENV]: root }, turns: recorder.turns }))
    const files = await readdir(join(root, "run-7a-1"))
    expect(files).toContain("turn-001-.._.._etc_passwd.json")
    expect(files.some((f) => f.includes("/"))).toBe(false)
  })

  test("no turns recorded means no turn files — the flag-off shape", async () => {
    const root = await tempDir("mad-artifacts-")
    await dumpRunArtifacts(dumpInput({ env: { [ARTIFACTS_ENV]: root } }))
    const files = await readdir(join(root, "run-7a-1"))
    expect(files.filter((f) => f.startsWith("turn-"))).toEqual([])
  })
})
