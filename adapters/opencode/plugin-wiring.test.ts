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

import { DEFAULT_DISCOVERY_SLOTS, MadPlugin, MAX_DISCOVERY_SLOTS } from "./plugin.ts"

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
  metadata?: { requested?: number; answered?: number }
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
