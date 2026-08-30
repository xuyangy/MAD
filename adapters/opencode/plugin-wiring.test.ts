/**
 * The seam between the slot default and the host.
 *
 * `plugin.test.ts` pins the constants and the clamp; neither says anything about
 * whether `execute` USES them. That gap was demonstrated, not theorised:
 * replacing `clampDiscoverySlots(args.slots)` with a literal `1` left the whole
 * suite green and typecheck clean, so a fresh install could silently return to
 * single-model review while `DEFAULT_DISCOVERY_SLOTS` still read as 3 in the
 * source and in the tool description. That is the regression story 2 exists to
 * prevent, and this file is the only place it fails.
 *
 * Everything here is a hand-written fake in the house style (`roster.test.ts`),
 * no mocking library and no module interception: the host client, the shell, and
 * an unreachable server URL. The models are therefore expected to drop out —
 * that is fine and deliberate. `metadata.requested` is written from the resolved
 * roster before any model is called, so the wiring is observable through a run
 * that answers nothing (AD-6b: one slot's failure never costs the run).
 */

import { describe, expect, test } from "bun:test"

import { noticeFor } from "../../core/prompt/material.ts"
import { fenceOf, materialSpans } from "../../core/test-support/fakes.ts"
import {
  DEFAULT_DISCOVERY_SLOTS,
  MadPlugin,
  MAX_DISCOVERY_SLOTS,
  MAX_LENS_SLOTS,
} from "./plugin.ts"

function model(id: string) {
  return { id, name: id, capabilities: { toolcall: true }, limit: { context: 200000 }, cost: { input: 3, output: 15 } }
}

/** Three lineages, so a 3-slot request can actually be filled (AD-4). */
const THREE_PROVIDERS = {
  providers: [
    { id: "anthropic", name: "Anthropic", source: "env", env: [], options: {}, models: { a: model("claude-sonnet-4-5") } },
    { id: "openai", name: "OpenAI", source: "env", env: [], options: {}, models: { b: model("gpt-5") } },
    { id: "google", name: "Google", source: "env", env: [], options: {}, models: { c: model("gemini-2.5-pro") } },
  ],
  default: {},
}

function fakeClient(body: unknown = THREE_PROVIDERS) {
  return { config: { providers: async () => ({ data: body }) } } as never
}

/**
 * `opencodeRepo` calls `$`.cwd(...).nothrow() and then tags it as
 * `` $`git ${argv}` ``, reading `exitCode` / `stdout` / `stderr`.
 */
function fakeShell() {
  const run = (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const argv = (values[0] as string[]) ?? []
    let stdout = ""
    if (argv[0] === "diff" && argv.includes("--name-only")) stdout = "src/pay.ts\n"
    else if (argv[0] === "diff" && argv.includes("--no-index")) stdout = ""
    else if (argv[0] === "diff") stdout = "--- a/src/pay.ts\n+++ b/src/pay.ts\n@@ -1 +1 @@\n-const a = 1\n+const a = 2\n"
    else if (argv[0] === "ls-files") stdout = ""
    return Promise.resolve({ exitCode: 0, stdout, stderr: "" })
  }
  const shell = run as unknown as { cwd: () => unknown; nothrow: () => unknown }
  shell.cwd = () => shell
  shell.nothrow = () => shell
  return shell as never
}

interface ToolResult {
  title: string
  output: string
  metadata?: {
    requested?: number
    answered?: number
    lensSlots?: string[]
    lensInstructions?: { lens: string; origin: string }[]
  }
}

async function executeWith(args: Record<string, unknown>): Promise<ToolResult> {
  const plugin = await MadPlugin({
    client: fakeClient(),
    directory: ".",
    worktree: ".",
    // Deliberately unreachable: every turn becomes a transport-error drop-out,
    // which is a domain outcome, not an exception (AD-2, spine Errors).
    serverUrl: "http://127.0.0.1:1",
    $: fakeShell(),
  } as never)
  const tool = (plugin as { tool?: Record<string, { execute: (a: never) => Promise<ToolResult> }> }).tool
  return tool!.mad_review!.execute(args as never)
}

describe("mad_review.execute — the default actually reaches the roster (AC1, CAP-1)", () => {
  test("OMITTING `slots` REQUESTS THE DEFAULT FAN-OUT, NOT ONE", async () => {
    // The load-bearing assertion of this file. A literal `1` in `execute`, or a
    // reverted `args.slots ?? 1`, fails here and nowhere else in the suite.
    const result = await executeWith({})
    expect(result.metadata?.requested).toBe(DEFAULT_DISCOVERY_SLOTS)
    expect(result.metadata?.requested).toBeGreaterThan(1)
  })

  test("an explicit `slots` is honoured through the same seam", async () => {
    expect((await executeWith({ slots: 2 })).metadata?.requested).toBe(2)
  })

  test("story 9's control arm reaches the resolver as exactly one slot", async () => {
    // AC5 — one code path, a smaller argument. Story 9's ablation depends on
    // this and on nothing else.
    expect((await executeWith({ slots: 1 })).metadata?.requested).toBe(1)
  })

  test("the clamp is applied on the way through, not merely exported", async () => {
    // The schema also bounds this, but the clamp is what the code relies on and
    // the two must not drift apart unnoticed.
    expect((await executeWith({ slots: 500 })).metadata?.requested).toBe(MAX_DISCOVERY_SLOTS)
  })

  test("a roster that answers nothing still reports, and says so (AD-6)", async () => {
    const result = await executeWith({})
    expect(result.metadata?.answered).toBe(0)
    expect(result.output).toContain("NO MODEL ANSWERED")
    // AD-6a — the denominator never silently becomes what was requested.
    expect(result.title).toContain("0/")
  })
})

describe("mad_review.execute — THE BACKEND RECEIVES POOL *AND* LENS SLOTS (CAP-11)", () => {
  /**
   * The highest-probability defect in story 2A, and nothing type-checks it.
   *
   * `OpencodeModelBackend` builds its per-slot map from the `slots` array it is
   * constructed with, and `runTurn` THROWS on a slot it does not know.
   * `runWithOneRetry` converts that throw into a transport-error envelope — so
   * a plugin that passes only `resolved.roster.slots` produces a run where
   * every lens slot drops out twice and looks exactly like a flaky provider.
   * Both the wired and unwired versions render a drop-out warning naming the
   * lens slot, which is why asserting on the warning alone would not fail.
   *
   * The one thing that differs is the MESSAGE: the unwired version carries
   * `unknown slot \`discovery-lens-security\`` from the backend's own throw.
   * That string is the assertion.
   */
  test("no lens slot is rejected as an unknown slot", async () => {
    const result = await executeWith({ lenses: ["security", "performance"] })

    // The backend was reached and failed on the network, not on the slot map.
    expect(result.output).not.toContain("unknown slot")
    // ...and the lens slots really did run, so the assertion above is over a run
    // that exercised them rather than one that skipped them.
    expect(result.output).toContain("discovery-lens-security")
    expect(result.output).toContain("discovery-lens-performance")
    expect(result.metadata?.lensSlots).toEqual([
      "discovery-lens-security",
      "discovery-lens-performance",
    ])
  })

  test("pool slots are still wired, with lenses on", async () => {
    const result = await executeWith({ lenses: ["security"] })
    expect(result.output).not.toContain("unknown slot")
    expect(result.output).toContain("discovery-1")
  })

  test("the lenses argument reaches the roster, deduped and clamped", async () => {
    const result = await executeWith({
      lenses: ["security", "security", ...Array.from({ length: 20 }, (_, i) => `x-${i}`)],
    })
    expect(result.metadata?.lensSlots).toHaveLength(MAX_LENS_SLOTS)
    expect(result.metadata?.lensSlots?.[0]).toBe("discovery-lens-security")
  })

  test("an unknown lens id reaches the generated fallback rather than failing", async () => {
    // AD-11 amended, end to end through the only surface a user has.
    const result = await executeWith({ lenses: ["threat-model"] })
    expect(result.metadata?.lensInstructions).toEqual([
      { lens: "threat-model", origin: "generated" },
    ])
    expect(result.output).toContain("GENERATED at run time")
  })

  test("OMITTING `lenses` COSTS NOTHING — no lens slot, no lens turn", async () => {
    // AD-3 / AD-15 amended, asserted through `execute` rather than against the
    // clamp: a fresh install's cost is unchanged by this capability's existence.
    const result = await executeWith({})
    expect(result.metadata?.lensSlots).toEqual([])
    expect(result.metadata?.lensInstructions).toEqual([])
    expect(result.output).not.toContain("discovery-lens-")
    expect(result.output).not.toContain("lens slots:")
    expect(result.title).not.toContain("lens")
  })

  test("the denominator stays the pool's when lenses are on (AD-6a)", async () => {
    const result = await executeWith({ lenses: ["security", "performance"] })
    // Three pool slots requested; the lens slots never join that number.
    expect(result.metadata?.requested).toBe(DEFAULT_DISCOVERY_SLOTS)
    expect(result.title).toContain(`0/${DEFAULT_DISCOVERY_SLOTS}`)
    expect(result.title).toContain("+ 2 lens")
  })
})

describe("mad_review.execute — THE REPORT LEAVES FRAMED (AD-18's eighth span, story 7)", () => {
  /**
   * The only place a reverted `output: frameForHostAgent(rendered)` fails.
   *
   * A tool's `output` is read by the calling agent, which is a model, and the
   * report quotes every model-authored claim, argument and judge report the run
   * produced. `injection.test.ts` proves the SPAN contains every planted order;
   * nothing there drives `execute`, so nothing there would notice the adapter
   * handing back the bare string. This does.
   *
   * NO FENCE LITERAL ANYWHERE BELOW. This file is scanned by
   * `scripts/lint-material-spans.ts` and is not exempt, so the expectation is
   * built at run time from the emitter's own helpers.
   */
  test("the whole report is ONE `review report` span, with the notice outside it", async () => {
    const result = await executeWith({})

    const spans = materialSpans(result.output)
    expect(spans).toHaveLength(1)
    expect(spans[0]!.label).toBe("review report")

    // The notice is MAD's own voice and sits OUTSIDE the fence, which is what
    // lets the whole report be framed honestly rather than each block inside it.
    // Asserted as "not in the body", which CAN fail — a framing applied inside
    // `output()` would trip it — rather than as `startsWith(noticeFor(...))`,
    // which is true by construction of `material()` (code review 2026-08-30).
    expect(spans[0]!.body).not.toContain(noticeFor("review report"))
    expect(result.output.indexOf(noticeFor("review report"))).toBeLessThan(spans[0]!.start)

    // The body is the report, unedited — the run this fixture drives answers
    // nothing, so the report says so and that sentence is inside the span.
    expect(spans[0]!.body).toContain("MAD review — run ")
    expect(spans[0]!.body).toContain("NO MODEL ANSWERED")
    expect(spans[0]!.body).toContain("TOKENS — turns:")
  })

  test("the fence is longer than any run of backticks the report contains", async () => {
    // MEASURED AGAINST THE REPORT, NOT AGAINST `fenceFor` (code review
    // 2026-08-30). `expect(body).not.toContain(fenceFor(body))` cannot fail —
    // `fenceFor` returns longest-run-plus-one by definition — so it read as this
    // span's safety proof and proved nothing. The run length is counted here
    // independently; `core/prompt/material.test.ts` owns the bound itself. The
    // report quotes model prose and a roster block full of backticked ids, so a
    // fixed-width delimiter really would be closable from inside it.
    const result = await executeWith({ lenses: ["security"] })
    const body = materialSpans(result.output)[0]!.body
    const openerFence = fenceOf(result.output, "review report")

    const longestRun = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length))
    expect(openerFence.length).toBeGreaterThan(longestRun)
    expect(result.output.split("\n").at(-1)).toBe(openerFence)
  })
})
