/**
 * Plan item B4a — MAD's user config file: where it is read from, what makes it
 * refused, and that the repository under review cannot supply it.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, stat, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import nodePath, { join } from "node:path"

import { MAX_DISCOVERY_SLOTS, MAX_EXCLUSIONS } from "./model-ref.ts"
import { decompose, mergeConfig, parseUserConfig, readUserConfig, userConfigPath, type UserConfigRead } from "./user-config.ts"

const VALID = {
  defaults: { exclude: ["anthropic/claude-opus-5-5"], preset: "quick" },
  stacks: {
    cheap: { models: ["openai/gpt-6-luna", "openrouter/nvidia/nemotron"], exclude: [] },
    constructor: { preset: "paranoid" },
  },
}

const scratch: string[] = []
async function dir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `mad-user-config-${prefix}-`))
  scratch.push(path)
  return path
}
afterEach(async () => {
  for (const path of scratch.splice(0)) {
    await chmod(path, 0o700).catch(() => undefined)
    await rm(path, { recursive: true, force: true })
  }
})

async function writeConfig(root: string, content: unknown = VALID): Promise<string> {
  await mkdir(join(root, "mad"), { recursive: true })
  const file = join(root, "mad", "config.json")
  await writeFile(file, typeof content === "string" ? content : JSON.stringify(content))
  return file
}

describe("B4a — userConfigPath", () => {
  test("XDG_CONFIG_HOME when it is a non-empty absolute path, else ~/.config", () => {
    expect(userConfigPath({ XDG_CONFIG_HOME: "/x/cfg" }, "/home/u")).toEqual({ path: "/x/cfg/mad/config.json" })
    expect(userConfigPath({ XDG_CONFIG_HOME: "relative/cfg" }, "/home/u")).toEqual({ path: "/home/u/.config/mad/config.json" })
    expect(userConfigPath({ XDG_CONFIG_HOME: "  " }, "/home/u")).toEqual({ path: "/home/u/.config/mad/config.json" })
    expect(userConfigPath({}, "/home/u")).toEqual({ path: "/home/u/.config/mad/config.json" })
    expect(userConfigPath({}, "")).toHaveProperty("refused")
    // Never OPENCODE_CONFIG.
    expect(userConfigPath({ OPENCODE_CONFIG: "/evil/opencode.json" }, "/home/u")).toEqual({
      path: "/home/u/.config/mad/config.json",
    })
  })
})

describe("B4a — decompose", () => {
  test("POSIX: the root is / and empty and . components are dropped", () => {
    expect(decompose("/home/me/.config//mad/./config.json", nodePath.posix)).toEqual({
      root: "/",
      parts: ["home", "me", ".config", "mad", "config.json"],
    })
    expect(decompose("../x/y", nodePath.posix)).toEqual({ root: "", parts: ["..", "x", "y"] })
  })

  test("win32: a drive root and a UNC share root are kept whole, and both separators split", () => {
    expect(decompose("C:\\Users\\me\\.config\\mad\\config.json", nodePath.win32)).toEqual({
      root: "C:\\",
      parts: ["Users", "me", ".config", "mad", "config.json"],
    })
    expect(decompose("\\\\server\\share\\cfg/mad\\config.json", nodePath.win32)).toEqual({
      root: "\\\\server\\share\\",
      parts: ["cfg", "mad", "config.json"],
    })
    expect(decompose("..\\mad", nodePath.win32)).toEqual({ root: "", parts: ["..", "mad"] })
    // Drive-relative: a root with no separator, which the walker refuses as a link target.
    expect(decompose("C:mad", nodePath.win32)).toEqual({ root: "C:", parts: ["mad"] })
  })
})

describe("B4a — parseUserConfig", () => {
  test("a valid file: defaults and stacks, omitted and empty lists kept apart, stacks in a Map", () => {
    const parsed = parseUserConfig(JSON.stringify(VALID))
    if ("why" in parsed) throw new Error(parsed.why)
    expect(parsed.config.defaults).toEqual({ exclude: ["anthropic/claude-opus-5-5"], preset: "quick" })
    expect(parsed.config.defaults.models).toBeUndefined()
    const cheap = parsed.config.stacks.get("cheap")!
    expect(cheap.exclude).toEqual([])
    expect("preset" in cheap).toBe(false)
    expect(parsed.config.stacks.get("constructor")).toEqual({ preset: "paranoid" })
    // No name reaches an inherited property.
    expect(parsed.config.stacks.get("toString")).toBeUndefined()
    expect(parsed.config.stacks.get("hasOwnProperty")).toBeUndefined()
  })

  test("an empty object is valid and sets nothing", () => {
    expect(parseUserConfig("{}")).toEqual({ config: { defaults: {}, stacks: new Map() } })
  })

  test("a __proto__ stack name is an own key and changes no prototype", () => {
    const parsed = parseUserConfig('{"stacks":{"__proto__":{"preset":"quick"}}}')
    if ("why" in parsed) throw new Error(parsed.why)
    expect(parsed.config.stacks.get("__proto__")).toEqual({ preset: "quick" })
    expect(({} as Record<string, unknown>)["preset"]).toBeUndefined()
  })

  const refusals: [string, string, RegExp][] = [
    ["invalid JSON", "{", /not valid JSON/],
    ["not an object", "[]", /one JSON object/],
    ["unknown top key", '{"plugins":{}}', /unknown key `plugins`/],
    ["unknown entry key", '{"defaults":{"slots":3}}', /defaults has an unknown key `slots`/],
    ["defaults not an object", '{"defaults":[]}', /defaults must be an object/],
    ["stacks not an object", '{"stacks":[]}', /`stacks` must be an object/],
    ["models not a list", '{"defaults":{"models":"a/b"}}', /defaults.models must be a list/],
    ["entry without a slash", '{"defaults":{"exclude":["opus"]}}', /defaults.exclude\[0\] is not/],
    ["empty provider", '{"defaults":{"exclude":["/m"]}}', /defaults.exclude\[0\] is not/],
    ["empty model", '{"stacks":{"s":{"models":["p/ "]}}}', /stacks.s.models\[0\] is not/],
    ["non-string entry", '{"defaults":{"models":[1]}}', /defaults.models\[0\] is not/],
    ["unknown preset", '{"defaults":{"preset":"fast"}}', /preset must be one of quick, normal, paranoid/],
    ["bad stack name", '{"stacks":{"a b":{}}}', /stack name `a b`/],
    ["stack entry not an object", '{"stacks":{"s":3}}', /stacks.s must be an object/],
  ]
  for (const [name, text, why] of refusals) {
    test(`refused: ${name}`, () => {
      const parsed = parseUserConfig(text)
      expect("why" in parsed && parsed.why).toMatch(why)
    })
  }

  test("refused: lists past the call-argument limits", () => {
    const models = Array.from({ length: MAX_DISCOVERY_SLOTS + 1 }, (_, i) => `p/m${i}`)
    const exclude = Array.from({ length: MAX_EXCLUSIONS + 1 }, (_, i) => `p/m${i}`)
    expect(parseUserConfig(JSON.stringify({ defaults: { models } }))).toHaveProperty("why")
    expect(parseUserConfig(JSON.stringify({ defaults: { exclude } }))).toHaveProperty("why")
    expect(parseUserConfig(JSON.stringify({ defaults: { models: models.slice(1), exclude: exclude.slice(1) } }))).toHaveProperty(
      "config",
    )
  })
})

describe("B4a — readUserConfig", () => {
  test("no file is absent; a valid file is loaded from the global path only", async () => {
    const worktree = await dir("repo")
    const xdg = await dir("xdg")
    expect(await readUserConfig({ env: { XDG_CONFIG_HOME: xdg }, worktree })).toEqual({
      kind: "absent",
      path: join(xdg, "mad", "config.json"),
    })
    await writeConfig(xdg)
    const read = await readUserConfig({ env: { XDG_CONFIG_HOME: xdg }, worktree })
    expect(read.kind).toBe("loaded")
    if (read.kind === "loaded") expect(read.config.defaults.preset).toBe("quick")
  })

  test("a worktree with its own OpenCode config and a lookalike MAD config supplies nothing", async () => {
    const worktree = await dir("repo")
    const xdg = await dir("xdg")
    const home = await dir("home")
    await writeFile(
      join(worktree, "opencode.json"),
      JSON.stringify({ plugin: [["file:///mad", { defaults: { exclude: ["openai/gpt-6-luna"] } }]] }),
    )
    await mkdir(join(worktree, ".opencode"))
    await writeFile(join(worktree, ".opencode", "opencode.json"), "{}")
    await writeConfig(join(worktree, ".config"), { defaults: { preset: "paranoid" } })
    await writeConfig(worktree, { defaults: { preset: "paranoid" } })

    // No global file: absent, whatever the worktree holds.
    expect((await readUserConfig({ env: { XDG_CONFIG_HOME: xdg }, worktree, home })).kind).toBe("absent")
    expect((await readUserConfig({ env: {}, worktree, home })).kind).toBe("absent")
    // A global file: only it is read.
    await writeConfig(xdg, { defaults: { preset: "quick" } })
    const read = await readUserConfig({ env: { XDG_CONFIG_HOME: xdg }, worktree, home })
    expect(read.kind === "loaded" && read.config.defaults).toEqual({ preset: "quick" })
  })

  test("a repository holding the user's home: a file there is refused, no file is absent", async () => {
    const worktree = await dir("repo")
    await writeConfig(join(worktree, ".config"))
    const read = await readUserConfig({ env: {}, worktree, home: worktree })
    expect(read.kind).toBe("refused")
    expect(read.kind === "refused" && read.why).toMatch(/inside the repository under review/)
    const empty = await dir("repo")
    expect((await readUserConfig({ env: {}, worktree: empty, home: empty })).kind).toBe("absent")
  })

  test("refused when a symlink in the worktree is a hop between an outside origin and an outside target", async () => {
    const worktree = await dir("repo")
    const xdg = await dir("xdg")
    const outside = await dir("outside")
    await writeConfig(outside)
    // xdg/mad -> worktree/hop -> outside/mad: both ends outside, the choice inside.
    await symlink(join(outside, "mad"), join(worktree, "hop"))
    await symlink(join(worktree, "hop"), join(xdg, "mad"))
    const read = await readUserConfig({ env: { XDG_CONFIG_HOME: xdg }, worktree })
    expect(read.kind === "refused" && read.why).toMatch(/inside the repository under review/)
  })

  test("refused when the walk enters the worktree under another spelling the filesystem treats as the same directory", async () => {
    const parent = await dir("unicode")
    const composed = join(parent, "caf\u00e9")
    const decomposed = join(parent, "cafe\u0301")
    await mkdir(composed)
    // Only where the filesystem resolves both spellings to one directory (Darwin's APFS does).
    const alias = await stat(decomposed).catch(() => undefined)
    if (alias === undefined || alias.ino !== (await stat(composed)).ino) return
    const xdg = await dir("xdg")
    const outside = await dir("outside")
    await writeConfig(outside)
    await symlink(join(outside, "mad"), join(composed, "hop"))
    // xdg/mad -> <decomposed spelling of the worktree>/hop -> outside/mad.
    await symlink(join(decomposed, "hop"), join(xdg, "mad"))
    const read = await readUserConfig({ env: { XDG_CONFIG_HOME: xdg }, worktree: composed })
    expect(read.kind === "refused" && read.why).toMatch(/inside the repository under review/)
  })

  test("a relative symlink with .. resolves from the link's real directory", async () => {
    const worktree = await dir("repo")
    const xdg = await dir("xdg")
    await mkdir(join(xdg, "real", "mad"), { recursive: true })
    await writeFile(join(xdg, "real", "mad", "config.json"), JSON.stringify({ defaults: { preset: "quick" } }))
    await mkdir(join(xdg, "links"))
    await symlink("../real/mad", join(xdg, "links", "mad-link"))
    await symlink(join(xdg, "links", "mad-link"), join(xdg, "mad"))
    const read = await readUserConfig({ env: { XDG_CONFIG_HOME: xdg }, worktree })
    expect(read.kind === "loaded" && read.config.defaults).toEqual({ preset: "quick" })
  })

  test("a missing component of the path as written is absent, also through an outside symlink", async () => {
    const worktree = await dir("repo")
    const xdg = await dir("xdg")
    const outside = await dir("outside")
    // xdg/mad -> outside, which has no config.json.
    await symlink(outside, join(xdg, "mad"))
    expect((await readUserConfig({ env: { XDG_CONFIG_HOME: xdg }, worktree })).kind).toBe("absent")
  })

  test("refused, not absent: a regular file where a directory is needed, a dangling ancestor symlink, a loop", async () => {
    const worktree = await dir("repo")

    const fileAsDir = await dir("xdg")
    await writeFile(join(fileAsDir, "mad"), "not a directory")
    const fileAsDirRead = await readUserConfig({ env: { XDG_CONFIG_HOME: fileAsDir }, worktree })
    expect(fileAsDirRead.kind === "refused" && fileAsDirRead.why).toMatch(/is not a directory/)

    const danglingAncestor = await dir("xdg")
    await symlink(join(danglingAncestor, "nowhere"), join(danglingAncestor, "mad"))
    const danglingRead = await readUserConfig({ env: { XDG_CONFIG_HOME: danglingAncestor }, worktree })
    expect(danglingRead.kind === "refused" && danglingRead.why).toMatch(/which does not exist/)

    const loop = await dir("xdg")
    await symlink(join(loop, "b"), join(loop, "a"))
    await symlink(join(loop, "a"), join(loop, "b"))
    await symlink(join(loop, "a"), join(loop, "mad"))
    const loopRead = await readUserConfig({ env: { XDG_CONFIG_HOME: loop }, worktree })
    expect(loopRead.kind === "refused" && loopRead.why).toMatch(/too many symlinks/)
  })

  test("refused when a directory symlink leads into the worktree", async () => {
    const worktree = await dir("repo")
    const xdg = await dir("xdg")
    await mkdir(join(worktree, "cfg"))
    await writeFile(join(worktree, "cfg", "config.json"), JSON.stringify(VALID))
    await symlink(join(worktree, "cfg"), join(xdg, "mad"))
    const read = await readUserConfig({ env: { XDG_CONFIG_HOME: xdg }, worktree })
    expect(read.kind).toBe("refused")
    expect(read.kind === "refused" && read.why).toMatch(/inside the repository under review/)
  })

  test("refused when the file is a symlink into the worktree; a symlink to a file outside is loaded", async () => {
    const worktree = await dir("repo")
    const xdg = await dir("xdg")
    const elsewhere = await dir("elsewhere")
    await writeFile(join(worktree, "cfg.json"), JSON.stringify(VALID))
    await mkdir(join(xdg, "mad"))
    await symlink(join(worktree, "cfg.json"), join(xdg, "mad", "config.json"))
    expect((await readUserConfig({ env: { XDG_CONFIG_HOME: xdg }, worktree })).kind).toBe("refused")

    const xdg2 = await dir("xdg")
    await writeFile(join(elsewhere, "cfg.json"), JSON.stringify(VALID))
    await mkdir(join(xdg2, "mad"))
    await symlink(join(elsewhere, "cfg.json"), join(xdg2, "mad", "config.json"))
    expect((await readUserConfig({ env: { XDG_CONFIG_HOME: xdg2 }, worktree })).kind).toBe("loaded")
  })

  test("refused, never absent: a dangling symlink, a directory, an unreadable file, invalid content", async () => {
    const worktree = await dir("repo")

    const dangling = await dir("xdg")
    await mkdir(join(dangling, "mad"))
    await symlink(join(dangling, "missing.json"), join(dangling, "mad", "config.json"))
    const danglingRead = await readUserConfig({ env: { XDG_CONFIG_HOME: dangling }, worktree })
    expect(danglingRead.kind === "refused" && danglingRead.why).toMatch(/which does not exist/)

    const directory = await dir("xdg")
    await mkdir(join(directory, "mad", "config.json"), { recursive: true })
    const directoryRead = await readUserConfig({ env: { XDG_CONFIG_HOME: directory }, worktree })
    expect(directoryRead.kind === "refused" && directoryRead.why).toMatch(/not a regular file/)

    if (process.getuid?.() !== 0) {
      const unreadable = await dir("xdg")
      const file = await writeConfig(unreadable)
      await chmod(file, 0o000)
      const unreadableRead = await readUserConfig({ env: { XDG_CONFIG_HOME: unreadable }, worktree })
      // macOS refuses at `realpath`, Linux at the read; either way it is refused with EACCES.
      expect(unreadableRead.kind === "refused" && unreadableRead.why).toMatch(/EACCES/)
      await chmod(file, 0o600)
    }

    const invalid = await dir("xdg")
    await writeConfig(invalid, '{"defaults":{"exclude":["opus"]}}')
    const invalidRead = await readUserConfig({ env: { XDG_CONFIG_HOME: invalid }, worktree })
    expect(invalidRead.kind === "refused" && invalidRead.why).toMatch(/defaults.exclude\[0\]/)
  })

  test("the checked, resolved file is the one read, even if the alias is re-pointed after the checks", async () => {
    const worktree = await dir("repo")
    const xdg = await dir("xdg")
    const elsewhere = await dir("elsewhere")
    await writeFile(join(elsewhere, "cfg.json"), JSON.stringify({ defaults: { preset: "quick" } }))
    await writeFile(join(worktree, "cfg.json"), JSON.stringify({ defaults: { preset: "paranoid" } }))
    await mkdir(join(xdg, "mad"))
    const alias = join(xdg, "mad", "config.json")
    await symlink(join(elsewhere, "cfg.json"), alias)
    const read = await readUserConfig({
      env: { XDG_CONFIG_HOME: xdg },
      worktree,
      afterChecks: async () => {
        await unlink(alias)
        await symlink(join(worktree, "cfg.json"), alias)
      },
    })
    expect(read.kind === "loaded" && read.config.defaults).toEqual({ preset: "quick" })
  })

  test("a path MAD cannot inspect is refused, not absent", async () => {
    if (process.getuid?.() === 0) return
    const worktree = await dir("repo")
    const xdg = await dir("xdg")
    await writeConfig(xdg)
    await chmod(join(xdg, "mad"), 0o000)
    try {
      const read = await readUserConfig({ env: { XDG_CONFIG_HOME: xdg }, worktree })
      expect(read.kind === "refused" && read.why).toMatch(/could not inspect the config file's path at .*\(EACCES\)/)
    } finally {
      await chmod(join(xdg, "mad"), 0o700)
    }
  })

  test("refused: a symlink to a file with a trailing / or /. , which the system would not resolve", async () => {
    const worktree = await dir("repo")
    for (const suffix of ["/", "/."]) {
      const xdg = await dir("xdg")
      await writeFile(join(xdg, "cfg.json"), JSON.stringify(VALID))
      await mkdir(join(xdg, "mad"))
      await symlink(join(xdg, "cfg.json") + suffix, join(xdg, "mad", "config.json"))
      const read = await readUserConfig({ env: { XDG_CONFIG_HOME: xdg }, worktree })
      expect(read.kind).toBe("refused")
    }
  })

  test("a worktree that cannot be resolved: no file is absent, an existing file is refused", async () => {
    const xdg = await dir("xdg")
    const worktree = join(xdg, "no-such-repo")
    expect((await readUserConfig({ env: { XDG_CONFIG_HOME: xdg }, worktree })).kind).toBe("absent")
    await writeConfig(xdg)
    const read = await readUserConfig({ env: { XDG_CONFIG_HOME: xdg }, worktree })
    expect(read.kind === "refused" && read.why).toMatch(/could not resolve the worktree/)
  })
})

describe("B4b — mergeConfig", () => {
  const loaded = (text: unknown): UserConfigRead => {
    const parsed = parseUserConfig(JSON.stringify(text))
    if ("why" in parsed) throw new Error(parsed.why)
    return { kind: "loaded", path: "/cfg/mad/config.json", config: parsed.config }
  }
  const FILE = loaded({
    defaults: { models: ["a/one"], exclude: ["b/two"], preset: "quick" },
    stacks: { s: { exclude: [], preset: "paranoid" }, bare: {} },
  })

  test("no file and no stack: every field is the argument's or none, and nothing is added", () => {
    const merged = mergeConfig({ models: ["x/y"] }, { kind: "absent", path: "/cfg/mad/config.json" }, undefined)
    expect(merged).toEqual({
      effective: {
        models: ["x/y"],
        sources: {
          models: { source: "argument", explicitEmpty: false },
          exclude: { source: "none", explicitEmpty: false },
          preset: { source: "none" },
        },
        configPath: "/cfg/mad/config.json",
      },
    })
    if ("effective" in merged) {
      expect("exclude" in merged.effective).toBe(false)
      expect("preset" in merged.effective).toBe(false)
    }
  })

  test("argument > stack > defaults, field by field, and an empty list from the stack clears the defaults", () => {
    const merged = mergeConfig({ models: ["arg/model"] }, FILE, "s")
    if (!("effective" in merged)) throw new Error("refused")
    expect(merged.effective.models).toEqual(["arg/model"])
    expect(merged.effective.exclude).toEqual([])
    expect(merged.effective.preset).toBe("paranoid")
    expect(merged.effective.sources).toEqual({
      models: { source: "argument", explicitEmpty: false },
      exclude: { source: "stack", explicitEmpty: true },
      preset: { source: "stack" },
    })
  })

  test("a stack that omits a field inherits it from defaults; an explicit empty argument clears too", () => {
    const merged = mergeConfig({ exclude: [] }, FILE, "bare")
    if (!("effective" in merged)) throw new Error("refused")
    expect(merged.effective.models).toEqual(["a/one"])
    expect(merged.effective.exclude).toEqual([])
    expect(merged.effective.preset).toBe("quick")
    expect(merged.effective.sources.models).toEqual({ source: "defaults", explicitEmpty: false })
    expect(merged.effective.sources.exclude).toEqual({ source: "argument", explicitEmpty: true })
  })

  test("refused: a refused file, an unknown stack, a stack with no file, an inherited property name", () => {
    expect(mergeConfig({}, { kind: "refused", path: "/p", why: "bad" }, undefined)).toEqual({ refused: "config", why: "bad", path: "/p" })
    expect(mergeConfig({}, FILE, "missing")).toMatchObject({ refused: "stack" })
    expect(mergeConfig({}, FILE, "constructor")).toMatchObject({ refused: "stack" })
    expect(mergeConfig({}, { kind: "absent", path: "/p" }, "s")).toMatchObject({ refused: "stack" })
  })
})
