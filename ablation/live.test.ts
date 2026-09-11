import { describe, expect, test } from "bun:test"

import { runLiveAblation } from "./live.ts"

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
 * - `shell` is a stub whose command tag THROWS, so any call to `repo.change`
 *   announces itself by name instead of passing silently.
 * - the injected `ChangeSet`'s `diff` is a getter that throws a sentinel, so the
 *   run announces the moment THAT object is read as the change under review.
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

  /** Any `git` this shell is asked to run says so, loudly, by name. */
  const refusingShell = () =>
    ({
      cwd: () => ({
        nothrow: () => () => {
          throw new Error("repo.change was called")
        },
      }),
    }) as never

  const sentinelChange = () =>
    ({
      description: "the injected labelled change",
      files: ["src/billing/refund.ts"],
      get diff(): string {
        throw new Error("SENTINEL: the injected change was read")
      },
    }) as never

  test("WITH a change: `repo.change` is never called, and THAT object is what runAblation reviews", async () => {
    const error = await runLiveAblation({
      pin: { providerId: "p1", modelId: "m1" },
      serverUrl: "http://127.0.0.1:1",
      directory: "/tmp/mad-live-test-directory",
      change: sentinelChange(),
      createClient: stubClient as never,
      shell: refusingShell(),
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
      shell: refusingShell(),
    }).then(
      () => undefined,
      (thrown: Error) => thrown,
    )

    expect(error?.message).toContain("repo.change was called")
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

  test("`change` is one optional injected value, beside `shell` and `createClient`", async () => {
    // No second live pipeline: the option is declared on `LiveOptions` like the
    // other three, not behind a mode flag or a parallel entry point.
    const source = await liveSource()

    expect(source).toContain("change?: ChangeSet")
    expect(source).toContain("differ in FOUR injected values and nothing else")
  })
})
