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
