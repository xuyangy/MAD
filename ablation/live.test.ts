import { describe, expect, test } from "bun:test"

import type { ChangeSet } from "../core/ports/repo.ts"
import { SEEDED_CHANGE } from "../fixtures/seeded-defects/material.ts"
import { measureCrossArm } from "./cross-arm-rates.ts"
import { runLiveAblation } from "./live.ts"
import type { SpawnBlame } from "../adapters/opencode/blame-exec.ts"
import { ChangeReadStopped } from "../adapters/opencode/repo.ts"

/**
 * THE ONE LINE CI CAN NEVER RUN, asserted at a seam (ledger triage 2026-09-09).
 *
 * `createOpencodeClient({ baseUrl })` took no directory while the backend and
 * the repo reader both did, so the candidate enumeration asked the server about
 * whatever directory it happened to consider current. The fix is one property.
 * Deleting it left the whole suite green — the live path is the one module CI
 * cannot drive — so there was nothing to stop it being deleted again.
 *
 * This does not run a live ablation and does not try to. It observes what the
 * client is BUILT FROM, which is the whole of the defect.
 */
describe("the live ablation's client is scoped to --directory", () => {
  test("the directory reaches the client factory, beside the base url", async () => {
    const seen: { baseUrl: string; directory: string }[] = []

    await runLiveAblation({
      pin: { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
      serverUrl: "http://localhost:4096",
      directory: "/some/worktree",
      createClient: (init) => {
        seen.push(init)
        // Enumeration is the next call and it is not what this test is about.
        throw new Error("stop here")
      },
    }).catch(() => undefined)

    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ baseUrl: "http://localhost:4096", directory: "/some/worktree" })
  })

  test("the assertion above can FAIL — an unscoped client does not satisfy it", async () => {
    // The non-vacuous sibling: it is the `directory` property that is checked,
    // not merely that a factory was called.
    const seen: { baseUrl: string; directory?: string }[] = []

    await runLiveAblation({
      pin: { providerId: "anthropic", modelId: "claude-sonnet-4-5" },
      serverUrl: "http://localhost:4096",
      directory: "/some/worktree",
      createClient: (init) => {
        seen.push({ baseUrl: init.baseUrl })
        throw new Error("stop here")
      },
    }).catch(() => undefined)

    expect(seen[0]).not.toEqual({ baseUrl: "http://localhost:4096", directory: "/some/worktree" })
  })
})

/**
 * AC4 (story 2.3) — the governor's wiring, asserted where the live path can be
 * asserted at all.
 *
 * STRUCTURAL, for the reason the client-scoping tests above are behavioural and
 * this one cannot be: reaching `runAblation` on this path needs a running
 * opencode server, a provider, and a worktree with a real diff, and the state
 * that separates "a governor was passed" from "one was not" is a halt that only
 * a billed turn with uncountable usage can produce. The behaviour of the gate
 * itself is pinned in `ablation/governor.test.ts`, which drives `runAblation`
 * directly with a fake backend; what is unpinnable there and pinned here is that
 * THIS module builds one at all, and builds it only where the halt can outlive
 * the process.
 */
describe("the live ablation gates its arms on the experiment governor", () => {
  const liveSource = () => Bun.file(new URL("./live.ts", import.meta.url)).text()

  test("a governor is built from the bundle root, and only when there is one", async () => {
    const source = await liveSource()

    expect(source).toContain("createExperimentGovernor({ bundleRoot: options.bundle.root })")
    // The conditional is the mechanism, not a style choice: a governor with no
    // bundle root has nowhere to persist its halt, and a halt that does not
    // survive the process resumes automatically — the one thing
    // `evaluation-protocol.md:332-339` forbids.
    expect(source).toContain("options.bundle === undefined\n      ? undefined")
    expect(source).toContain("...(governor === undefined ? {} : { governor })")
  })
})

/**
 * AC2 (story 2.3) — the late-usage sink reaches the LIVE backend.
 *
 * STRUCTURAL, for the same reason as the governor test above: only a real
 * provider that answers after MAD stopped waiting can produce a late report, and
 * CI has none. What is pinned here is the one line that was missing when story
 * 2.3 was otherwise complete — the sink `runArm` hands in must go ONTO the
 * backend, or the backend has nothing to report into and the recovery is dead
 * with every test still green.
 *
 * The join itself (same object to the backend and to `review()`) is pinned
 * behaviourally in `ablation/arms.test.ts`, which owns it because `runArm` is
 * where both handoffs happen.
 */
describe("the live ablation hands each arm's backend the arm's own late-usage sink", () => {
  const liveSource = () => Bun.file(new URL("./live.ts", import.meta.url)).text()

  test("`backendFor` takes the sink and puts it on `OpencodeModelBackend`", async () => {
    const source = await liveSource()

    // The parameter, and then the property. Both halves, because taking the
    // argument and dropping it is exactly as broken as not taking it.
    expect(source).toContain("backendFor: (spec, lateUsage) => {")
    expect(source).toContain("slots: [...resolved.roster.slots, ...resolved.roster.lensSlots],\n          lateUsage,")
  })

  test("the assertion above can FAIL — the shape this module shipped with does not satisfy it", async () => {
    // The state of the tree until 2026-09-11: a backend built without a sink, on
    // the only path in the repository that bills real money.
    const reverted = (await liveSource())
      .replace("backendFor: (spec, lateUsage) => {", "backendFor: (spec) => {")
      .replace(
        "slots: [...resolved.roster.slots, ...resolved.roster.lensSlots],\n          lateUsage,",
        "slots: [...resolved.roster.slots, ...resolved.roster.lensSlots],",
      )

    expect(reverted).not.toContain("backendFor: (spec, lateUsage) => {")
    expect(reverted).not.toContain(
      "slots: [...resolved.roster.slots, ...resolved.roster.lensSlots],\n          lateUsage,",
    )
  })
})

/**
 * AC1 / FR5 BEHAVIOURALLY (review finding P3, 2026-09-11).
 *
 * The source assertions above pin the SHAPE and they are not enough on their own:
 * every one of them stayed green while `change,` at the `runAblation` call site
 * was swapped for `change: await repo.change(options.target)`, which reviews the
 * operator's worktree while the manifest stamps the sealed fixture identity —
 * the exact failure `--fixture-version`'s refusal exists to prevent, arriving one
 * line further down.
 *
 * These drive `runLiveAblation` for real, through the seams it already has:
 *
 * - `createClient` returns a stub whose `config.providers()` answers, so
 *   `enumerateCandidates` succeeds and control reaches the change decision.
 * - `repo.spawn` THROWS, so any call to `repo.change` announces itself by name
 *   instead of passing silently.
 * - the injected `ChangeSet`'s `diff` is a getter that throws a sentinel from its
 *   SECOND read on, so the run announces the moment THAT object is read as the
 *   change under review. The first read is the cross-arm applicability check,
 *   which hashes the diff before any arm runs; throwing there would stop the run
 *   before `runAblation` and make the mutation below pass unseen.
 *
 * No network and no provider: the run stops on the sentinel inside
 * `runAblation`, before any turn is issued. Which error comes back is the whole
 * assertion, and the two cases give opposite ones.
 */
describe("the injected change is what the run actually reviews", () => {
  /** Three toolcall-capable models, so the roster resolves and arms can start. */
  const stubClient = () => ({
    config: {
      providers: async () => ({
        data: {
          providers: ["p1", "p2", "p3"].map((id, index) => ({
            id,
            models: {
              only: {
                id: `m${index + 1}`,
                name: `m${index + 1}`,
                capabilities: { toolcall: true },
                limit: { context: 200_000 },
              },
            },
          })),
          default: {},
        },
      }),
    },
  })

  /** Any `git` the change reader is asked to spawn says so, loudly, by name. */
  const refusingRepo = () => ({
    spawn: () => {
      throw new Error("repo.change was called")
    },
  })

  const sentinelChange = () => {
    let reads = 0
    return {
      description: "the injected labelled change",
      files: ["src/billing/refund.ts"],
      get diff(): string {
        reads += 1
        if (reads === 1) return "not the labelled diff"
        throw new Error("SENTINEL: the injected change was read")
      },
    } as never
  }

  test("WITH a change: `repo.change` is never called, and THAT object is what runAblation reviews", async () => {
    const error = await runLiveAblation({
      pin: { providerId: "p1", modelId: "m1" },
      serverUrl: "http://127.0.0.1:1",
      directory: "/tmp/mad-live-test-directory",
      change: sentinelChange(),
      createClient: stubClient as never,
      repo: refusingRepo(),
    }).then(
      () => undefined,
      (thrown: Error) => thrown,
    )

    // The injected object reached `runAblation` and was read as the change.
    expect(error?.message).toContain("SENTINEL: the injected change was read")
    // And the worktree was never read. This is the half that fails under the
    // mutation: `change: await repo.change(options.target)` throws the other one.
    expect(error?.message).not.toContain("repo.change was called")
  })

  test("WITHOUT a change: the worktree read still happens, exactly as before", async () => {
    const error = await runLiveAblation({
      pin: { providerId: "p1", modelId: "m1" },
      serverUrl: "http://127.0.0.1:1",
      directory: "/tmp/mad-live-test-directory",
      createClient: stubClient as never,
      repo: refusingRepo(),
    }).then(
      () => undefined,
      (thrown: Error) => thrown,
    )

    expect(error?.message).toContain("repo.change was called")
  })
})

/**
 * Ledger #48 — the unpaired live ablation's change read is bounded, and a read
 * that stops ends the run before any arm.
 *
 * `repo.spawn` hands back a git that never returns until it is killed. With a
 * short read budget the launcher kills it, `change()` raises
 * `ChangeReadStopped`, and the run rejects with it. `serverUrl` is a local
 * server that counts every request, so an arm whose backend opened a session
 * would be seen; the sibling shows the same run with a change handed in does
 * reach it.
 */
describe("a change read that stops ends the live ablation before any arm", () => {
  const stubClient = () => ({
    config: {
      providers: async () => ({
        data: {
          providers: ["p1", "p2", "p3"].map((id, index) => ({
            id,
            models: {
              only: {
                id: `m${index + 1}`,
                name: `m${index + 1}`,
                capabilities: { toolcall: true },
                limit: { context: 200_000 },
              },
            },
          })),
          default: {},
        },
      }),
    },
  })

  /** A local server that refuses everything and counts what reached it. */
  const countingServer = () => {
    let requests = 0
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        requests += 1
        return new Response("refused", { status: 500 })
      },
    })
    return { url: `http://127.0.0.1:${server.port}`, requests: () => requests, stop: () => server.stop(true) }
  }

  test("a hung `repo.spawn` under short limits rejects with ChangeReadStopped, and no arm or backend call is made", async () => {
    let spawns = 0
    let kills = 0
    const hung: SpawnBlame = () => {
      spawns += 1
      let settle: ((code: number) => void) | undefined
      return {
        pid: 31337,
        stdout: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
        stderr: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
        exited: new Promise<number>((resolve) => {
          settle = resolve
        }),
        exitCode: null,
        signalCode: "SIGKILL",
        kill: () => {
          kills += 1
          settle?.(137)
        },
      }
    }
    const server = countingServer()
    try {
      const error = await runLiveAblation({
        pin: { providerId: "p1", modelId: "m1" },
        serverUrl: server.url,
        directory: "/tmp/mad-live-test-hung-read",
        createClient: stubClient as never,
        repo: { spawn: hung, readBudgetMs: 30, cleanupMs: 200 },
      }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      )

      expect(error).toBeInstanceOf(ChangeReadStopped)
      if (!(error instanceof ChangeReadStopped)) return
      expect(error.stop).toBe("terminated")
      expect(error.operation).toBe("git diff")
      expect(error.cleanup).toBe("confirmed")
      expect(error.pid).toBe(31337)
      // One read was started and killed; nothing after it was launched.
      expect(spawns).toBe(1)
      expect(kills).toBe(1)
      // No arm ran: nothing reached the server a backend would call.
      expect(server.requests()).toBe(0)
    } finally {
      server.stop()
    }
  })

  test("THE CHANGE READ KEEPS ITS HISTORICAL GIT: inherit, even when the caller asks for read-only", async () => {
    const seen: { cmd: string[]; env: unknown }[] = []
    const refusing: SpawnBlame = (request) => {
      seen.push({ cmd: request.cmd, env: request.env })
      throw new Error("no such file or directory")
    }
    const server = countingServer()
    try {
      const error = await runLiveAblation({
        pin: { providerId: "p1", modelId: "m1" },
        serverUrl: server.url,
        directory: "/tmp/mad-live-test-inherit",
        createClient: stubClient as never,
        repo: { spawn: refusing, gitReadPolicy: "read-only" },
      }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      )

      expect(error).toBeInstanceOf(ChangeReadStopped)
      // No filter preflight, no policy argv, no policy environment.
      expect(seen).toEqual([{ cmd: ["git", "diff", "--unified=8", "HEAD", "--"], env: undefined }])
    } finally {
      server.stop()
    }
  })

  test("AND A RUN THAT GETS PAST THE CHANGE DOES REACH THE SERVER — the non-vacuous sibling", async () => {
    const server = countingServer()
    try {
      await runLiveAblation({
        pin: { providerId: "p1", modelId: "m1" },
        serverUrl: server.url,
        directory: "/tmp/mad-live-test-hung-read",
        change: SEEDED_CHANGE,
        createClient: stubClient as never,
        repo: {
          spawn: () => {
            throw new Error("repo.change was called")
          },
        },
      }).catch(() => undefined)
      expect(server.requests()).toBeGreaterThan(0)
    } finally {
      server.stop()
    }
  })
})

/**
 * Story 2.5 — the live report carries the cross-arm calibration of the change it
 * REVIEWED.
 *
 * BEHAVIOURAL for applicability. With no server at `127.0.0.1:1`, every model
 * turn fails as a transport error, every arm finishes degraded with nothing
 * billed, and `runLiveAblation` returns a real report. That report is what is
 * asserted: the calibration is present for `SEEDED_CHANGE` (fails if the spread
 * into `buildReport` is deleted) and absent for a one-byte-different diff (fails
 * if the lookup is hard-wired to `SEEDED_CHANGE`).
 *
 * STRUCTURAL for ordering, and said so: "computed before any arm bills" has no
 * observable difference in a run where nothing bills, so the source order is
 * what is pinned.
 */
describe("the live report's cross-arm calibration follows the reviewed change", () => {
  const stubClient = () => ({
    config: {
      providers: async () => ({
        data: {
          providers: ["p1", "p2", "p3"].map((id, index) => ({
            id,
            models: {
              only: {
                id: `m${index + 1}`,
                name: `m${index + 1}`,
                capabilities: { toolcall: true },
                limit: { context: 200_000 },
              },
            },
          })),
          default: {},
        },
      }),
    },
  })

  const refusingRepo = () => ({
    spawn: () => {
      throw new Error("repo.change was called")
    },
  })

  const reportFor = (change: ChangeSet) =>
    runLiveAblation({
      pin: { providerId: "p1", modelId: "m1" },
      serverUrl: "http://127.0.0.1:1",
      directory: "/tmp/mad-live-test-directory",
      change,
      createClient: stubClient as never,
      repo: refusingRepo(),
    })

  test("BEHAVIOURAL: reviewing SEEDED_CHANGE, the report carries the sealed calibration", async () => {
    const report = await reportFor(SEEDED_CHANGE)
    expect(report.crossArmCalibration).toEqual((await measureCrossArm()).calibration)
  })

  test("BEHAVIOURAL: reviewing any other diff, the report carries none", async () => {
    const report = await reportFor({ ...SEEDED_CHANGE, diff: `${SEEDED_CHANGE.diff}\n` })
    expect(report.crossArmCalibration).toBeUndefined()
    expect("crossArmCalibration" in report).toBe(false)
  })

  test("STRUCTURAL: the calibration is computed from `change` after it is resolved and before any arm runs", async () => {
    const source = await Bun.file(new URL("./live.ts", import.meta.url)).text()
    const resolved = source.indexOf("const change = options.change ?? (await repo.change(options.target))")
    const computed = source.indexOf("const crossArmCalibration = await crossArmCalibrationFor(change)")
    const armsRun = source.indexOf("await runAblation(")

    expect(resolved).toBeGreaterThan(-1)
    expect(computed).toBeGreaterThan(resolved)
    expect(armsRun).toBeGreaterThan(computed)
    expect(source).not.toContain("crossArmCalibrationFor(SEEDED_CHANGE)")
  })
})

/**
 * AC1 / FR5 (story 2.4) — a live run can be handed the change it reviews.
 *
 * STRUCTURAL, for the reason the two suites above are: reaching the line at all
 * needs a running opencode server and a provider, because `enumerateCandidates`
 * comes first and there is nothing to enumerate without one. What is pinned here
 * is the shape — the injected change WINS over the worktree read, and the repo
 * reader is still constructed so the bundle containment baseline keeps its
 * `worktree`.
 */
describe("a live run reviews the change it was given, when it was given one", () => {
  const liveSource = () => Bun.file(new URL("./live.ts", import.meta.url)).text()

  test("the injected change short-circuits `repo.change`", async () => {
    const source = await liveSource()

    expect(source).toContain("const change = options.change ?? (await repo.change(options.target))")
  })

  test("`opencodeRepo` is STILL constructed — the containment baseline needs its worktree", async () => {
    // Not a style point. `worktree` anchors the AD-16 check that keeps an
    // evaluation bundle out of the repository under review, at the two call sites
    // below. A later reader "tidying away" a construction whose `change()` is no
    // longer always called would take that baseline with it.
    const source = await liveSource()

    expect(source).toContain("const repo = opencodeRepo({")
    expect(source).toContain("worktree: options.worktree ?? options.directory,")
  })

  test("`change` is one optional injected value, beside `repo` and `createClient`", async () => {
    // No second live pipeline: the option is declared on `LiveOptions` like the
    // other three, not behind a mode flag or a parallel entry point.
    const source = await liveSource()

    expect(source).toContain("change?: ChangeSet")
    expect(source).toContain("differ in FOUR injected values and nothing else")
  })
})
