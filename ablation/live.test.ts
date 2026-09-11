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
