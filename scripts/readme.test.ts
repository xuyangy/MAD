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
  MAX_EXCLUSIONS,
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
const EVIDENCE = readFileSync(join(ROOT, "EVIDENCE.md"), "utf8")
const RELEASE_NOTES = readFileSync(join(ROOT, "RELEASE-NOTES.md"), "utf8")
const PACKAGE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  private?: boolean
  version?: string
  license?: string
  description?: string
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
  test("the status line names the offline suite, the hand runs and the authorized runs the live sections report", () => {
    expect(README).toContain("**Status: checked offline; reviewed live on one host version.**")
    expect(README).toContain("No test here runs against a real OpenCode host.")
    expect(README).toContain("On opencode-ai 1.19.5, two reviews were run by hand, and authorized reviews were run and recorded on each route from 2026-11-12 to 2026-11-18; *What a live review showed* and *Target host* below say what they did and did not show.")
    expect(README).not.toContain("tried by hand on a live host")
    expect(README).toContain("- **What a live review showed.** A review was run by hand on opencode-ai 1.19.5")
    expect(README).not.toContain("not field-tested")
  })

  test("the host-version evidence says which bundle each fact was read from", () => {
    expect(PROSE).toContain(
      "The opencode-ai 1.19.5 bundle was read the same way for the review-session policy, which it evaluates as described below, and, for the live-run authorization, for how `opencode run` chooses the outer agent's model and handles permission requests, and how a plugin's tools are wrapped.",
    )
    expect(PROSE).toContain("Its plugin loader was not re-read in full.")
    expect(README).not.toContain("for the review-session policy only")
  })

  test("the target host names one version and two routes with their verdicts, and cites its evidence", () => {
    expect(PROSE).toContain("MAD targets opencode-ai 1.19.5, used through the TUI and through `opencode run`. No other host version or route is targeted.")
    expect(README).toContain("| TUI | compatible with listed limitations |")
    expect(README).toContain("| `opencode run` | compatible with listed limitations |")
    expect(PROSE).toContain("A route's compatibility is not established until a recorded, authorized live run on 1.19.5 shows it.")
    expect(PROSE).toContain("The two hand reviews below predate that record, and they are not validation.")
    expect(PROSE).toContain(
      "The current verdicts: both routes are *compatible with listed limitations*, the TUI from a run on 2026-11-17 and `opencode run` from a run on 2026-11-18. The v1.0.0 release gate rested on the 2026-11-17 TUI run and a 2026-11-16 `opencode run` run; the 2026-11-18 run came after the tag, on the same runtime code, and replaced the 2026-11-16 one as that route's evidence without changing its verdict. Each run returned a judged finding and left the reviewed repository unchanged. One run per route is a bounded compatibility check, not a claim about reliability or usefulness. The 2026-11-18 `opencode run` review pinned `anthropic/claude-sonnet-4-6`, `openai/gpt-6-luna` and the OpenRouter model `openrouter/nvidia/nemotron-3.5-lightning:free`; all three answered, no turn failed or was refused, MAD retried none, and it took 64 seconds. MAD's lineage table does not know the OpenRouter model's family, so the report counted two verified lineages, and said so. Which upstream served that model, and its logging and retention terms, are unknown. An earlier `opencode run` review, on 2026-11-16, pinned three models, and `anthropic/claude-opus-5-5`'s endpoint rejected the forced tool choice MAD's structured answers use, although the same model worked as the outer agent; MAD recognised the rejection as a capability refusal and did not retry it, and because the slot was pinned it was not replaced. Only `openai/gpt-6-luna` answered there, and the judge ran on that same model. The TUI was not compatible after its 2026-11-16 run: three verified model lineages were selected, two answered after an ordinary drop-out, and MAD's report did not warn that fewer verified lineages answered, a warning the criteria require; MAD then warned only after a refusal. MAD now warns whenever fewer verified lineages answer discovery than were selected, whatever the cause, and the 2026-11-17 TUI run showed it: one slot was pinned to `openai/gpt-6-luna` and `exclude` kept `anthropic/claude-opus-5-5` out; MAD chose `anthropic/claude-sonnet-4-6` and `opencode/deepseek-v4.1-flash-free` itself; `openai/gpt-6-luna` failed both attempts on its account's usage limit, the free model hit its usage limit, and the report warned that one of three verified lineages answered. The review rested on `anthropic/claude-sonnet-4-6` alone, which also judged its own finding. A free `opencode` model hit its usage limit in the 2026-11-16 `opencode run` review and the 2026-11-17 TUI review (`nemotron-3.5-lightning-free` and `deepseek-v4.1-flash-free`), and the host kept retrying it with its next try scheduled past MAD's turn deadline. MAD stopped waiting at its first read of the host's session status, about five seconds in, and retried each such turn once as an ordinary failure, which stopped the same way. Neither usage limit is treated as a refusal. The TUI review took 2 minutes 43 seconds, where each attempt on the pinned model's usage limit took about 75 seconds. The runs, the verdicts and every listed limitation are recorded as N7 and the 2026-11-18 `opencode run` verdict, and N8 and the 2026-11-17 TUI verdict, in the validation spec's live-evidence record, which is not among this repository's tracked files. `EVIDENCE.md` is the tracked summary of those verdicts, the runs they rest on and their limitations. The replacement of refused slots, the replacement session's policy check, a refusal in debate or the judge, a refusal stopping MAD from asking the slots it covers, and the tool-calling filter's exclusions have run only in the offline tests.",
    )
    expect(README).not.toContain("the offline-only outcome was chosen")
    expect(README).not.toContain("`opencode run` from a run on 2026-11-16")
    expect(README).not.toContain("This release's verdicts:")
    expect(README).not.toContain("with no failed turn, retry or refusal")
    expect(README).not.toContain("The review took 16 seconds on `opencode run`")
    expect(README).not.toContain("recorded as N5 and the 2026-11-16 verdict")
    expect(README).not.toContain("A free `opencode` model hit its usage limit in each run")
    expect(README).not.toContain("from 2026-11-12 to 2026-11-17")
    expect(README).not.toContain("It warns only after a refusal.")
    expect(README).not.toContain("At that revision it warned only after a refusal.")
    expect(README).not.toContain("This release's verdicts were rendered on 2026-11-16")
    expect(README).not.toContain("that fix is checked only offline, and clearing the TUI verdict needs a new authorized run")
    expect(README).not.toContain("and 29 seconds in the TUI")
    expect(README).not.toContain("clearing the TUI verdict needs a fix and a new authorized run")
    expect(README).not.toContain("rendered on 2026-11-11")
    expect(README).not.toContain("rendered on 2026-11-12")
    expect(README).not.toContain("each review took about 20 minutes")
    expect(README).not.toContain("Classified refusal, the replacement of refused slots")
    expect(README).not.toContain("pinned every slot to a model that declares tool calling, so no model was left out")
    expect(README).not.toContain("each returned judged findings")
    expect(README).not.toContain("| TUI | not compatible |")
    expect(README).not.toContain("Both routes' verdict for this release, rendered on 2026-11-16")
    expect(README).not.toContain("so the reviews took 16 and 29 seconds")
    expect(README).not.toContain("stopping MAD asking")
    expect(README).not.toContain("declared every model it offered able to,")
    expect(README).not.toContain("forced tool choice in the 2026-11-12 runs is not established")
    expect(README).not.toContain("| TUI | not established |")
    expect(README).not.toContain("| `opencode run` | not established |")
    expect(README).not.toContain("The one authorized attempt")
    expect(README).not.toContain("recorded as N1")
    expect(README).not.toContain("The authorization then ended, so the TUI was not attempted.")
    expect(README).toContain("| How a plugin is loaded from a package | read from the 1.19.3 bundle; in 1.19.5 only the wrapper around a plugin's tools was read, and the loader itself is unverified.")
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

describe("EVIDENCE.md — the tracked evidence summary", () => {
  const rowOf = (text: string, route: string) =>
    text.split("\n").find((line) => line.startsWith(`| ${route} |`))?.split("|").map((cell) => cell.trim())

  test("its route verdicts are the README's, and each names the run and revision it rests on", () => {
    for (const route of ["TUI", "`opencode run`"]) {
      const readme = rowOf(README, route)
      const evidence = rowOf(EVIDENCE, route)
      expect(readme).toBeDefined()
      expect(evidence).toBeDefined()
      expect(evidence![2]).toBe(readme![2])
    }
    expect(rowOf(EVIDENCE, "TUI")!.slice(3, 6)).toEqual(["2026-11-17", "N8", "`7622913`"])
    expect(rowOf(EVIDENCE, "`opencode run`")!.slice(3, 6)).toEqual(["2026-11-18", "N7", "`59d27dd`"])
    expect(EVIDENCE).toContain(
      "| 2026-11-18 | `59d27dd` | (not re-rendered) | compatible with listed limitations | N7, above: an `opencode run` review with an OpenRouter model, on v1.0.0's runtime code |",
    )
    expect(EVIDENCE).toContain("| # | Offline | Live: TUI (N8) | Live: `opencode run` (N7) |")
    expect(EVIDENCE).not.toContain("| # | Offline | Live: TUI (N8) | Live: `opencode run` (N5) |")
    // N7's column of the runs table and its criteria cells.
    const n7 = (label: string) => EVIDENCE.split("\n").find((line) => line.startsWith(`| ${label} |`))?.split("|").map((cell) => cell.trim())[2]
    expect(n7("Date")).toBe("2026-11-18")
    expect(n7("MAD revision")).toBe("`59d27dd`")
    expect(n7("Duration of the review")).toBe("64 s")
    expect(n7("Answered discovery")).toBe("3 of 3")
    expect(n7("Why slots dropped out")).toBe("none dropped out; no turn failed")
    expect(n7("Known tokens")).toBe("178984; no turn with unknown usage")
    expect(EVIDENCE.split("\n").find((line) => line.startsWith("| V2 |"))?.split("|").map((cell) => cell.trim())[4]).toBe("not observed: no refusal (N5 passed it for a first-attempt refusal)")
    expect(EVIDENCE.split("\n").find((line) => line.startsWith("| V3 |"))?.split("|").map((cell) => cell.trim())[4]).toBe("not observed: no refusal, and every slot was pinned")
    expect(EVIDENCE.split("\n").find((line) => line.startsWith("| V4 |"))?.split("|").map((cell) => cell.trim())[4]).toBe("passed: no warning was due")
    expect(EVIDENCE).toContain(
      "- MAD's lineage table does not know the OpenRouter model `nvidia/nemotron-3.5-lightning:free`, so N7 counted two verified lineages of three slots. Which upstream OpenRouter routed it to, and that upstream's logging and retention terms, are unknown.",
    )
    expect(EVIDENCE).toContain("The release gate rested on N5 and N8; N7 ran after the tag, on the same runtime code, and now carries the `opencode run` verdict, which it left unchanged.")
    expect(EVIDENCE).toContain(
      "The TUI was *not compatible* on 2026-11-16 because V4's lineage warning was missing after an ordinary drop-out in N6",
    )
    expect(EVIDENCE).toContain("N8 observed that warning live on the TUI after ordinary drop-outs.")
    expect(EVIDENCE).not.toContain("This fixes the TUI's V4 gap offline only.")
    expect(EVIDENCE).not.toContain("That gate is unmet while the TUI is *not compatible*.")
  })

  test("the README points to it", () => {
    expect(PROSE).toContain("`EVIDENCE.md` is the tracked summary of those verdicts, the runs they rest on and their limitations.")
  })

  test("it carries no local path and nothing that identifies the reviewed repository", () => {
    for (const forbidden of ["/Users/", "ansible", "login_rdp", "dbconf"]) expect(EVIDENCE).not.toContain(forbidden)
  })
})

describe("RELEASE-NOTES.md — the v1 release notes", () => {
  const rowOf = (text: string, route: string) =>
    text.split("\n").find((line) => line.startsWith(`| ${route} |`))?.split("|").map((cell) => cell.trim())

  test("they are the v1.0.0 notes, no longer a draft, and the package is version 1.0.0", () => {
    expect(PACKAGE.version).toBe("1.0.0")
    expect(PACKAGE.license).toBe("AGPL-3.0-only")
    expect(PACKAGE.description).toBe(
      "MAD — multi-agent debate code review for OpenCode: several models review a change, contested findings are debated, and a judge checks each against the code.",
    )
    expect(RELEASE_NOTES.startsWith("# MAD release notes\n\n## v1.0.0\n")).toBe(true)
    expect(RELEASE_NOTES).not.toContain("Draft — not released")
    expect(RELEASE_NOTES).not.toContain("(draft)")
    expect(EVIDENCE).not.toContain("Release preparation is still to do")
    expect(EVIDENCE).toContain("so N7's and N8's compatibility claims hold for the v1.0.0 candidate revision.")
    expect(EVIDENCE).not.toContain("so N5's and N8's compatibility claims hold")
    expect(RELEASE_NOTES).toContain(
      "The release gate rested on one authorized live run per route: `opencode run` on 2026-11-16, and the TUI on 2026-11-17. The TUI's re-check run on 2026-11-16, N6, was *not compatible*:",
    )
    expect(RELEASE_NOTES).toContain(
      "**Validation update after the release (2026-11-18).** An authorized `opencode run` run after the tag, N7, on the same runtime code as v1.0.0, now carries that route's verdict in place of the 2026-11-16 run; the verdict is unchanged.",
    )
    expect(RELEASE_NOTES).toContain("The tagged copy of these notes predates this update.")
    expect(RELEASE_NOTES).toContain(
      "- MAD's lineage table does not know every model's family; an unknown one is reported and not counted as a distinct lineage. Which upstream OpenRouter routes a model to, and its logging and retention terms, are not established by MAD.",
    )
    expect(RELEASE_NOTES).not.toContain("The TUI's first run, on 2026-11-16")
    expect(EVIDENCE).toContain("The annotated tag `v1.0.0` marks that revision.")
    expect(EVIDENCE).toContain("pass on `784c004`, the v1.0.0 candidate revision")
    expect(EVIDENCE).not.toContain("not yet tagged")
  })

  test("its route verdicts are the README's", () => {
    for (const route of ["TUI", "`opencode run`"]) {
      const readme = rowOf(README, route)
      expect(readme).toBeDefined()
      expect(rowOf(RELEASE_NOTES, route)?.[2]).toBe(readme![2])
    }
  })

  test("it names the license, the Bun version and the install command the README gives", () => {
    expect(RELEASE_NOTES).toContain(`(\`${PACKAGE.license}\`)`)
    expect(RELEASE_NOTES).toContain("with Bun 1.4.3, the version CI uses")
    expect(PROSE).toContain("with Bun 1.4.3, the version CI uses.")
    expect(RELEASE_NOTES).toContain("```sh\nbun install --frozen-lockfile\n```")
  })

  test("it carries no local path and nothing that identifies the reviewed repository", () => {
    for (const forbidden of ["/Users/", "ansible", "login_rdp", "dbconf"]) expect(RELEASE_NOTES).not.toContain(forbidden)
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
    expect(rows.get("package export `./core`")).toEqual([`\`${PACKAGE.exports?.["./core"]}\``])
    for (const key of Object.keys(PACKAGE.exports ?? {})) expect(rows.has(`package export \`${key}\``)).toBe(true)
    expect(PROSE).toContain("OpenCode does not load it as a plugin, and it is not a promised stable public API.")
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
    const ciBun = /bun-version:\s*(\S+)/.exec(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"))?.[1]
    expect(ciBun).toBe("1.4.3")
    expect(PROSE).toContain(`with Bun ${ciBun}, the version CI uses.`)
    expect(README).toContain("   bun install --frozen-lockfile\n")
    expect(README).not.toMatch(/^\s*bun install\s*$/m)
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
    expect(PROSE).toContain("When a provider refuses a request in a way MAD recognises, MAD does not retry it, whether the request was a discovery, debate or judge turn; a refused debate or judge model drops out of that stage and is not replaced.")
    expect(PROSE).not.toContain("refuses a discovery model's request")
    expect(PROSE).toContain(
      "A recognised refusal is an authentication or payment refusal, such as GitLab's no-credits error, or a capability refusal: an `APIError` whose message is exactly `tool_choice: type \"tool\" and \"any\" are not supported for this model.`, with `isRetryable` absent or false, whatever its status code (a 401, 402 or 5xx carrying this text is a capability refusal, not an authentication or payment one), which means the route rejects the forced tool choice MAD's structured answers need.",
    )
    expect(PROSE).toContain(
      "A generic 401 or 402 error and a capability refusal each refuse only that route, meaning that model on that provider, so another model on the same provider can be chosen as the replacement, and may be refused the same way.",
    )
    expect(PROSE).toContain("on a provider and route that were not refused")
    expect(PROSE).toContain(
      "A recognised refusal also stops MAD asking any other slot it covers for the rest of the run, lens slots included: one on the same route, or, for a refusal of the whole provider, one on that provider; this starts at the next stage, the next debate round or the next judged finding, so a turn issued alongside the refused one (in discovery's concurrent first round, or in the same debate round) still counts, and the report names each slot it stopped asking.",
    )
    expect(README).not.toContain("for an account reason (a recognised authentication or payment refusal")
    expect(README).not.toContain("A generic 401 or 402 error excludes only that model on that provider")
    expect(README).not.toContain("is not retried either and, for an unpinned discovery slot")
    expect(PROSE).toContain(
      "A 429 quota error, a 403, GitLab's no-credits text under a provider id other than `gitlab`, or a refusal in the prompt envelope's `result.error` is treated as an ordinary failure. It can receive the ordinary retry if the stop and budget gates permit it; that error alone does not qualify the slot for replacement.",
    )
    expect(PROSE).toContain("Those runs predate the tool-calling filter and the replacement of refused slots described under `slots` below. In the authorized TUI runs of 2026-11-16 and 2026-11-17 (see *Target host*), MAD chose two slots itself from models the host declares able to call tools; each time all 69 models the host offered declared tool calling, so the filter left none out. The filter's exclusions and the replacement of refused slots have not been run against a live host.")
    expect(README).not.toContain("neither has been run against a live host")
    expect(PROSE).toContain(
      "MAD does not remember a refusal from one review to the next, so a route you know rejects MAD, such as one that returned the capability refusal described under `slots`, is excluded only for the reviews you pass it to.",
    )
    expect(PROSE).toContain("Why `anthropic/claude-opus-5-5` rejected the forced tool choice in the 2026-11-12 and 2026-11-16 runs is not established.")
    expect(PROSE).toContain("An excluded model fills no slot, no lens and no replacement, and a model you both pin and exclude is reported as excluded and its slot is filled automatically.")
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

    expect(inner("exclude").def.type).toBe("array")
    expect(inner("exclude")._zod.bag.maximum).toBe(MAX_EXCLUSIONS)
    expect(row("exclude")).toEqual(["list of `provider/model`", "nothing excluded", `at most ${MAX_EXCLUSIONS}`])
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
    for (const name of ["lenses", "models", "exclude"]) {
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
    expect(PROSE).toContain("When the dump is on, it also holds `session-status.jsonl`")
    expect(PROSE).toContain("No other session's status is kept.")
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
