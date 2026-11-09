/**
 * CAP-8 — the root README is bound to the shipped code.
 *
 * Each checked claim is compared with the code it describes, imported rather
 * than copied: the package entry the host would load and its export shape, the
 * registered `mad_review` tool and its argument schema, the preset table, the plugin's default budgets, the session
 * rules, the budget and issued-turns notes, and the read and turn limits. The
 * argument set is read from the registered tool, so an argument added to the
 * schema and missing from the README fails here, as does one the README names
 * and the schema does not.
 *
 * Prose claims that no constant states are checked by presence only. That is a
 * guard against a section going missing, not a proof of the behaviour: the
 * behaviour is pinned by the acceptance scenarios in
 * `adapters/opencode/acceptance.test.ts`.
 *
 * The plugin is imported through the package's own entry and constructed with
 * a client and shell that are never used, so no review runs and no host is
 * contacted.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  budgetNote,
  DEFAULT_DISCOVERY_SLOTS,
  ISSUED_TURNS_NOTE,
  MadPlugin,
} from "../adapters/opencode/plugin.ts"
import { DEFAULT_PLUGIN_BUDGET } from "../adapters/opencode/plugin-budget.ts"
import { DEFAULT_TURN_TIMEOUT_MS } from "../adapters/opencode/model-backend.ts"
import { DEFAULT_CHANGE_READ_BUDGET_MS, DEFAULT_CHANGE_READ_CLEANUP_MS } from "../adapters/opencode/repo.ts"
import { DEFAULT_BLAME_CLEANUP_TIMEOUT_MS, DEFAULT_BLAME_TIMEOUT_MS } from "../adapters/opencode/tools.ts"
import { describeReviewPermission, READ_ONLY_SESSION_NOTICE } from "../adapters/opencode/session-policy.ts"
import { readOnlyGitEnv, unsupportedTargetReason } from "../adapters/opencode/git-read-policy.ts"
import { parseNulNames } from "../adapters/opencode/change-input.ts"
import { ARTIFACTS_ENV, artifactRootFrom, defaultArtifactRoot, refusalFor } from "../adapters/opencode/artifacts.ts"
import { DEFAULT_PRESET, PRESET_DIALS, PRESETS } from "../core/budget/ledger.ts"
import { CODING_LENSES } from "../core/instructions/coding/lenses.ts"

const ROOT = join(import.meta.dir, "..")
const README = readFileSync(join(ROOT, "README.md"), "utf8")
const PACKAGE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  private?: boolean
  main?: string
  exports?: Record<string, string>
}
/** The module the host loads: `package.json` `main`. */
const ENTRY = (await import(join(ROOT, PACKAGE.main!))) as Record<string, unknown>

/**
 * How opencode-ai 1.19.3 turns a plugin module into plugins (read from the
 * installed bundle): every distinct export value must be a function, or an
 * object with a `server` function, and each is called as a plugin.
 */
function hostPluginEntries(module: Record<string, unknown>): unknown[] {
  const seen = new Set<unknown>()
  const entries: unknown[] = []
  for (const value of Object.values(module)) {
    if (seen.has(value)) continue
    seen.add(value)
    if (typeof value === "function") entries.push(value)
    else if (typeof value === "object" && value !== null && typeof (value as { server?: unknown }).server === "function") {
      entries.push((value as { server: unknown }).server)
    } else throw new TypeError("Plugin export is not a function")
  }
  return entries
}

/** The README's table whose header row starts with `firstHeader`, as rows of trimmed cells. */
function table(firstHeader: string): Map<string, string[]> {
  const lines = README.split("\n")
  const start = lines.findIndex((line) => line.startsWith(`| ${firstHeader} |`))
  if (start === -1) throw new Error(`README has no table headed "${firstHeader}"`)
  const rows = new Map<string, string[]>()
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim())
    rows.set(cells[0]!, cells.slice(1))
  }
  return rows
}

/** The README's paragraph text with line breaks folded, for sentence checks. */
const PROSE = README.replace(/\s*\n\s*/g, " ")

interface Bag {
  minimum?: number
  maximum?: number
}
interface ArgSchema {
  def: { type: string }
  safeParse(value: unknown): { success: boolean }
  unwrap(): { def: { type: string }; options?: string[]; _zod: { bag: Bag } }
}

async function registeredTool() {
  const hooks = (await (ENTRY.default as (input: never) => Promise<unknown>)({
    client: {} as never,
    directory: "/nonexistent",
    worktree: "/nonexistent",
    serverUrl: new URL("http://127.0.0.1:9"),
    $: (() => {
      throw new Error("the README test runs no shell")
    }) as never,
  } as never)) as {
    "tool.execute.before"?: unknown
    tool: { mad_review: { args: Record<string, ArgSchema> } }
  }
  return { hooks, args: hooks.tool.mad_review.args }
}

describe("README — status", () => {
  test("the status line names both the offline suite and the hand runs the live-review section reports", () => {
    expect(README).toContain("**Status: checked offline; tried by hand on a live host.**")
    expect(README).toContain("No test here runs against a real OpenCode host.")
    expect(README).toContain("Two reviews were run by hand on opencode-ai 1.19.5")
    expect(README).toContain("- **What a live review showed.** A review was run by hand on opencode-ai 1.19.5")
    expect(README).not.toContain("not field-tested")
  })

  test("the host-version evidence says which bundle each fact was read from", () => {
    expect(README).toContain("The opencode-ai 1.19.5 bundle was read the same way for the review-session policy only")
    expect(README).toContain("Its plugin loader was not re-read.")
  })

  test("the target host names one version and two routes, each not established, and cites its evidence", () => {
    expect(PROSE).toContain("MAD targets opencode-ai 1.19.5, used through the TUI and through `opencode run`. No other host version or route is targeted.")
    expect(README).toContain("| TUI | not established |")
    expect(README).toContain("| `opencode run` | not established |")
    expect(PROSE).toContain("A route's compatibility is not established until a recorded, authorized live run on 1.19.5 shows it.")
    expect(PROSE).toContain("The two hand reviews below predate that record, and they are not validation.")
    expect(PROSE).toContain(
      "Both routes' verdict for this release is *not established*: the offline-only outcome was chosen, so no authorized live run was made. The tool-calling filter, the replacement of refused slots and the replacement session's policy check have run only in the offline tests.",
    )
    expect(README).toContain("| How a plugin is loaded from a package | read from the 1.19.3 bundle only; the 1.19.5 loader is unverified.")
    expect(README).toContain("Registration was observed by hand on 1.19.5 (historical registration report E1, source commit `12af673`). |")
    expect(README).toContain("| The plugin reaches the host through the client OpenCode hands it | observed by hand on 1.19.5 in historical hand-review reports E2 (`opencode run`) and E3 (TUI), source commit `f7efaa0` |")
    expect(README).toContain("| How the review-session permission rules are evaluated | read from the 1.19.5 bundle |")
    expect(README).toContain("| A `json_schema` prompt's answer is recorded through the host's `StructuredOutput` tool | read from the 1.19.5 bundle |")
    expect(PROSE).toContain("listed `mad_review` among its tools (historical registration report E1, source commit `12af673`).")
    expect(PROSE).toContain("holding one uncommitted file (historical hand-review reports E2 (`opencode run`) and E3 (TUI), source commit `f7efaa0`).")
    expect(README).not.toMatch(/(\bTUI\b|`opencode run`)[^.\n]*\bsupport(s|ed)?\b/i)
    expect(README).not.toMatch(/\bsupport(s|ed)?\b[^.\n]*(\bTUI\b|`opencode run`)/i)
  })
})

describe("README — registration (CAP-8)", () => {
  test("the package entry is the one the README names, and it exports the plugin and nothing else", () => {
    const rows = table("What")
    expect(rows.get("package `main`")).toEqual([`\`${PACKAGE.main}\``])
    expect(rows.get("package export `.`")).toEqual([`\`./${PACKAGE.main}\``])
    expect(rows.get("package export `./server`")).toEqual([`\`./${PACKAGE.main}\``])
    expect(PACKAGE.exports?.["."]).toBe(`./${PACKAGE.main}`)
    expect(PACKAGE.exports?.["./server"]).toBe(`./${PACKAGE.main}`)
    expect(rows.get("entry module exports")).toEqual(["the default export `MadPlugin`, and nothing else"])
    expect(Object.keys(ENTRY)).toEqual(["default"])
    expect(ENTRY.default).toBe(MadPlugin)
  })

  test("the host's loader accepts the entry as exactly one plugin, and would refuse the implementation module", async () => {
    expect(hostPluginEntries(ENTRY)).toEqual([MadPlugin])
    const implementation = (await import("../adapters/opencode/plugin.ts")) as Record<string, unknown>
    expect(() => hostPluginEntries(implementation)).toThrow("Plugin export is not a function")
    expect(PROSE).toContain("the host calls every export of a plugin module as a plugin")
  })

  test("it is described as a private checkout with a file:// registration, and nothing claims an npm package", () => {
    expect(PACKAGE.private).toBe(true)
    expect(PROSE).toContain("MAD is a private TypeScript checkout. It is not published to npm.")
    expect(README).toContain('{ "plugin": ["file:///absolute/path/to/MAD"] }')
    expect(PROSE).toContain("To register it with OpenCode 1.19.5")
    expect(PROSE).toContain("Registration was verified by hand on opencode-ai 1.19.5")
    expect(PROSE).toContain("That check ran no review and no model.")
    expect(PROSE).toContain("A review was run by hand on opencode-ai 1.19.5, once through `opencode run` and once in the TUI")
    expect(PROSE).toContain("so each review rested on one model.")
    expect(PROSE).toContain("so each run's token total is a floor, not its full spend.")
    expect(PROSE).toContain("It uses only models the host declares able to call tools, because OpenCode returns MAD's structured answers through a tool call")
    expect(PROSE).toContain("If no offered model declares it, MAD refuses before asking any model.")
    expect(PROSE).toContain("For a recognised refusal, once every first-round discovery turn has finished, MAD replaces the refused slot once with a model not in the pool")
    expect(PROSE).toContain("A slot you pinned with `models` is not replaced, and lens slots are never replaced.")
    expect(PROSE).toContain(
      "A 429 quota error, a 403, GitLab's no-credits text under a provider id other than `gitlab`, or a refusal in the prompt envelope's `result.error` is treated as an ordinary failure. It can receive the ordinary retry if the stop and budget gates permit it; that error alone does not qualify the slot for replacement.",
    )
    expect(PROSE).toContain("Those runs predate the tool-calling filter and the replacement of refused slots described under `slots` below; neither has been run against a live host.")
    expect(PROSE).toContain("No test here runs that registration or a live review.")
    expect(PROSE).toContain("MAD sends every request through the client OpenCode hands the plugin, never to the plugin's `serverUrl`")
    expect(PROSE).toContain("`serverUrl` is not a supported way for the plugin to reach the host; MAD's evaluation and probe scripts keep it as their transport to a server they start or are given.")
    expect(PROSE).toContain("`adapters/opencode/host-session.test.ts` pins the three session requests it sends this way: create, prompt and delete.")
    expect(PROSE).toContain("Nothing in it installs, registers or starts MAD in your host.")
    expect(README).not.toMatch(/npm (install|i) /)
  })
})

describe("README — arguments and defaults (CAP-8)", () => {
  test("the argument table names exactly the registered tool's arguments", async () => {
    const { args } = await registeredTool()
    const documented = [...table("Argument").keys()].map((cell) => cell.replace(/`/g, ""))
    expect(documented.sort()).toEqual(Object.keys(args).sort())
  })

  test("each argument's type, default and bounds agree with the schema and the plugin's constants", async () => {
    const { args } = await registeredTool()
    const rows = table("Argument")
    const row = (name: string) => rows.get(`\`${name}\``)!
    const inner = (name: string) => args[name]!.unwrap()
    for (const name of Object.keys(args)) expect(args[name]!.def.type).toBe("optional")

    expect(inner("target").def.type).toBe("string")
    expect(row("target")).toEqual(["string", "the working tree against `HEAD`", "must not start with `-`"])
    expect(unsupportedTargetReason("-x")).toBeDefined()
    expect(unsupportedTargetReason("main...HEAD")).toBeUndefined()

    const slots = inner("slots")._zod.bag
    expect(row("slots")).toEqual(["integer", `${DEFAULT_DISCOVERY_SLOTS}`, `${slots.minimum} to ${slots.maximum}`])

    expect(inner("lenses").def.type).toBe("array")
    expect(row("lenses")).toEqual(["list of lens ids", "the preset's lenses", `at most ${inner("lenses")._zod.bag.maximum}`])

    expect(row("budget")).toEqual(["integer, tokens", "the preset's default budget", `${inner("budget")._zod.bag.minimum} or more`])

    const presets = inner("preset").options!
    expect(presets).toEqual([...PRESETS])
    expect(row("preset")).toEqual([
      presets.map((p) => `\`${p}\``).join(", ").replace(/, ([^,]+)$/, " or $1"),
      `\`${DEFAULT_PRESET}\``,
      "one of the three",
    ])

    expect(inner("models").def.type).toBe("array")
    expect(row("models")).toEqual(["list of `provider/model`", "MAD chooses the whole roster", `at most ${inner("models")._zod.bag.maximum}`])
  })

  test("the documented types are the schema's: strings, integers and lists of strings", async () => {
    const { args } = await registeredTool()
    const accepts = (name: string, value: unknown) => args[name]!.safeParse(value).success
    expect(accepts("target", "main...HEAD")).toBe(true)
    expect(accepts("target", 1)).toBe(false)
    for (const name of ["slots", "budget"]) {
      expect(accepts(name, 2)).toBe(true)
      expect(accepts(name, 2.5)).toBe(false)
      expect(accepts(name, "2")).toBe(false)
    }
    for (const name of ["lenses", "models"]) {
      expect(accepts(name, ["security"])).toBe(true)
      expect(accepts(name, [1])).toBe(false)
      expect(accepts(name, "security")).toBe(false)
    }
    expect(accepts("preset", "thorough")).toBe(false)
  })

  test("the shipped lens ids are the ones the README lists", () => {
    const ids = CODING_LENSES.map((lens) => `\`${lens.id}\``)
    expect(PROSE).toContain(`The shipped ids are ${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}.`)
  })

  test("the preset table is PRESET_DIALS and the plugin's default budgets, preset by preset", () => {
    const rows = table("Preset")
    expect([...rows.keys()]).toEqual(PRESETS.map((p) => `\`${p}\``))
    for (const preset of PRESETS) {
      const dials = PRESET_DIALS[preset]
      const lenses = dials.lenses.length === 0 ? "none" : dials.lenses.map((l) => `\`${l}\``).join(", ")
      expect(rows.get(`\`${preset}\``)).toEqual([
        `${dials.threshold}`,
        lenses,
        `${dials.maxConcurrency}`,
        `${DEFAULT_PLUGIN_BUDGET[preset]}`,
      ])
    }
    expect(PROSE).toContain("An argument you pass always beats the preset, including an explicit empty `lenses` list under `paranoid`.")
  })
})

describe("README — tool and evidence policy (CAP-8)", () => {
  test("the session rules are the ones MAD sends, and the hook it names is registered", async () => {
    const { hooks } = await registeredTool()
    expect(PROSE).toContain(`carries the permission rules \`${describeReviewPermission()}\``)
    expect(typeof hooks["tool.execute.before"]).toBe("function")
    expect(PROSE).toContain("routes through the `tool.execute.before` hook")
  })

  test("the prompt notice the README paraphrases says what the README says it does", () => {
    expect(READ_ONLY_SESSION_NOTICE).toContain("delegate to another agent")
    expect(READ_ONLY_SESSION_NOTICE).toContain("Report a check you cannot make as unchecked")
    expect(PROSE).toContain("report a check it cannot make as unchecked")
  })

  test("the git environment is the read policy's: inherited GIT_* and PAGER removed, MAD's own variables set", () => {
    const env = readOnlyGitEnv({ GIT_DIR: "/elsewhere", GIT_CONFIG_GLOBAL: "/elsewhere", PAGER: "less", PATH: "/bin" })
    const own = Object.keys(env).filter((key) => key.startsWith("GIT_")).sort()
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.PAGER).toBeUndefined()
    expect(PROSE).toContain(
      `with MAD's own ${own.slice(0, -1).map((key) => `\`${key}\``).join(", ")} and \`${own.at(-1)}\` set in their place`,
    )
    expect(PROSE).toContain("It runs without the `PAGER` and `GIT_*` variables it would inherit")
  })

  test("MAD_ARTIFACTS chooses the dump destination as the README says", () => {
    expect(ARTIFACTS_ENV).toBe("MAD_ARTIFACTS")
    expect(artifactRootFrom({})).toBeUndefined()
    expect(artifactRootFrom({ MAD_ARTIFACTS: "" })).toBeUndefined()
    for (const value of ["1", "true", "yes", "on"]) expect(artifactRootFrom({ MAD_ARTIFACTS: value })).toBe(defaultArtifactRoot())
    expect(defaultArtifactRoot().endsWith("mad-runs")).toBe(true)
    expect(artifactRootFrom({ MAD_ARTIFACTS: "/var/dumps" })).toBe("/var/dumps")
    expect(refusalFor("relative/dir", "/work/repo")).toBeDefined()
    expect(refusalFor("/work/repo/dumps", "/work/repo")).toBeDefined()
    expect(refusalFor("/var/dumps", "/work/repo")).toBeUndefined()
    expect(PROSE).toContain("`MAD_ARTIFACTS=1` (or `true`, `yes`, `on`): the dump goes to `mad-runs` under the system temp directory")
    expect(PROSE).toContain("A relative path, or one inside the repository, is refused.")
  })

  test("the fan-out claim covers only the models MAD asks", () => {
    expect(PROSE).toContain("It sends the change to each model it asks.")
    expect(PROSE).toContain("A slot the report marks NEVER ASKED, a zero budget, or a run stopped early sends it to fewer.")
  })

  test("the README says the offline tests prove wiring, not real-host enforcement", () => {
    expect(PROSE).toContain("so they prove the wiring, not that a real host enforces the rules.")
    expect(PROSE).toContain("MAD's own `git blame` read is not a host tool")
  })
})

describe("README — change input limits", () => {
  test("a name holding U+FFFD is refused, as the README says", () => {
    expect(parseNulNames("ok.ts\0bad\uFFFD.ts\0")).toEqual({ problem: "unrepresentable" })
    expect(README).toContain("A name containing the character U+FFFD is always refused")
  })

  test("a globally configured filter refuses every repository, as the README says", () => {
    expect(README).toContain("such as the one `git lfs install` writes there, which makes MAD refuse every repository on that machine")
  })
})

describe("README — cost meaning (CAP-8)", () => {
  // The note a returned review carries, built by the plugin's own function.
  const note = budgetNote({ ledger: { cap: DEFAULT_PLUGIN_BUDGET.normal, unknownUsage: [] } as never }, undefined, "normal")
  const unknownNote = budgetNote(
    { ledger: { cap: DEFAULT_PLUGIN_BUDGET.normal, unknownUsage: [{}] } as never },
    undefined,
    "normal",
  )

  test("the admission and host-metering sentences are the budget note's own", () => {
    for (const words of [
      "It is an admission budget, not a hard bill or quota ceiling",
      "MAD does not meter all host retries and tool steps, so the host may bill more than the TOKENS figure.",
    ]) {
      expect(note).toContain(words)
      expect(PROSE).toContain(words)
    }
    expect(note).toContain("(each discovery attempt, each debate round as a whole, each judge step)")
    expect(PROSE).toContain("each discovery attempt, each debate round as a whole, each judge step")
    expect(note).toContain("a debate round's retries included, can take the total past it")
    expect(PROSE).toContain("a debate round's retries included, can take the total past it")
  })

  test("unreported usage is described as possibly billed, as the note and the report say", () => {
    expect(unknownNote).toContain("Turns whose usage the host did not report are not counted against the budget")
    expect(PROSE).toContain("When the host reports no usage for a turn MAD issued, the turn is not counted as free.")
    expect(PROSE).toContain("says they may have been billed")
    expect(PROSE).toContain("MAD makes no promise about your bill, a quota, latency, or whether the review will be useful.")
    expect(README).not.toMatch(/billed model call|were NOT free|each billed once/)
  })

  test("the tool's argument descriptions speak of attempts and turns, never of a billed call per slot or lens", async () => {
    const { args } = await registeredTool()
    const descriptions = Object.values(args)
      .map((schema) => (schema as { description?: string }).description ?? "")
      .join("\n")
    expect(descriptions).toContain("Each slot plans one discovery turn: a model attempt and at most one retry.")
    expect(descriptions).toContain("3 slots with 5 lenses is 8 discovery turns, not 3, before any retry")
    expect(descriptions).toContain("with the default 3 slots that is SIX discovery turns rather than three")
    expect(descriptions).not.toMatch(/billed model call|billed discovery turn|debate turns are billed|model calls, not/i)
  })
})

describe("README — stop and cleanup limits (CAP-8)", () => {
  test("the issued-turns sentence is the plugin's own note", () => {
    expect(PROSE).toContain(ISSUED_TURNS_NOTE.trim())
  })

  test("the limits table is the shipped deadlines and cleanup budgets", () => {
    const rows = table("Limit")
    expect(rows.get("reading the change, all git reads together")).toEqual([
      `${DEFAULT_CHANGE_READ_BUDGET_MS}`,
      `${DEFAULT_CHANGE_READ_CLEANUP_MS}`,
    ])
    expect(rows.get("one `git blame` evidence read")).toEqual([`${DEFAULT_BLAME_TIMEOUT_MS}`, `${DEFAULT_BLAME_CLEANUP_TIMEOUT_MS}`])
    expect(rows.get("one model turn")).toEqual([`${DEFAULT_TURN_TIMEOUT_MS}`, "—"])
    expect(rows.size).toBe(3)
  })

  test("the stop section states the kill attempt, the unconfirmed case and the process-group limit", () => {
    expect(PROSE).toContain("MAD sends that git process SIGKILL at once, or reports that SIGKILL could not be sent.")
    expect(PROSE).not.toContain("is killed with SIGKILL")
    expect(PROSE).toContain("the report says the process may still be running, gives its pid")
    expect(PROSE).toContain("MAD does not kill a process group.")
  })
})

describe("README — kept limitations (CAP-8)", () => {
  test("the three limitations are stated as consequences, without ledger numbers or a promised fix", () => {
    expect(PROSE).toContain("MAD does not recognise that it is quarantined")
    expect(PROSE).toContain("is held in memory in full")
    expect(PROSE).toContain("can use up the change read's time limit, and the review then fails")
    expect(PROSE).toContain("No fix is implied.")
    expect(README).not.toMatch(/#\d{2,}\b/)
  })
})
