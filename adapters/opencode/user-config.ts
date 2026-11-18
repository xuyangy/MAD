/**
 * Plan item B4 (fusion-harness borrow plan) — MAD's own user config file:
 * default pins, exclusions and preset, and named stacks of them.
 *
 * ## Where it is read from, and why only there
 *
 * A change under review must not be able to choose its own reviewers. OpenCode
 * passes a plugin its options as a plain record with no origin, and merges a
 * project's `opencode.json` and `.opencode/opencode.json` into the global
 * config, so plugin options may come from the repository under review. MAD
 * therefore does not read plugin options for this. It reads one file it owns:
 * `$XDG_CONFIG_HOME/mad/config.json` when `XDG_CONFIG_HOME` is a non-empty
 * absolute path, and `~/.config/mad/config.json` otherwise. Never the
 * worktree, the working directory or `OPENCODE_CONFIG`.
 *
 * MAD resolves the path itself, one component at a time from the filesystem
 * root, following each symlink. A file that exists is refused when any step of
 * that resolution, a directory or a symlink, is the worktree under review or
 * inside it (as given or resolved): a repository that contains the user's
 * home, a config directory that is a symlink into the repository, and a
 * symlink in the repository that leads back out all count, because the
 * repository could then choose which file is read. The file read is the
 * resolved, checked location, never the alias.
 *
 * ## Outcomes
 *
 * - `absent`: a component of the path as written does not exist. The ordinary
 *   case, no defaults, also when the path runs through the worktree.
 * - `loaded`: the file parsed and every entry is valid.
 * - `refused`: anything else, with MAD's reason: the path could not be
 *   established or resolved (a symlink at any level that leads nowhere, a
 *   component that is not a directory, a loop), a step of its resolution is
 *   inside the worktree, it is not a regular file or cannot be read, or its
 *   content is invalid. A refused file is never partly applied.
 *
 * ## Content
 *
 * `{ "defaults": { "models": [...], "exclude": [...], "preset": "..." },
 *    "stacks": { "<name>": { "models": [...], "exclude": [...], "preset": "..." } } }`
 *
 * Every key is optional; an unknown key is refused. A list holds
 * `provider/model` strings with both halves non-empty (`splitModelRef`, the
 * call path's grammar), at most `MAX_DISCOVERY_SLOTS` models and
 * `MAX_EXCLUSIONS` exclusions. A preset is one of `PRESETS`. A stack name is
 * letters, digits, `-` and `_`. An omitted list and an empty list stay
 * different: omitted inherits, empty clears (applied in B4b). Stacks are held in
 * a `Map`, so no name reaches an inherited property.
 */

import { lstat, readFile, readlink, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import nodePath, { dirname, isAbsolute, join, resolve } from "node:path"

import { PRESETS, type Preset } from "../../core/budget/presets.ts"
import { isWithin } from "./artifacts.ts"
import { MAX_DISCOVERY_SLOTS, MAX_EXCLUSIONS, splitModelRef } from "./model-ref.ts"

export interface ConfigEntry {
  models?: string[]
  exclude?: string[]
  preset?: Preset
}

export interface UserConfig {
  defaults: ConfigEntry
  stacks: ReadonlyMap<string, ConfigEntry>
}

export type UserConfigRead =
  | { kind: "absent"; path: string }
  | { kind: "loaded"; path: string; config: UserConfig }
  | { kind: "refused"; path: string | null; why: string }

const STACK_NAME = /^[A-Za-z0-9_-]{1,64}$/
const ENTRY_KEYS = new Set(["models", "exclude", "preset"])
const TOP_KEYS = new Set(["defaults", "stacks"])

/** The file MAD reads, or why no path can be established. */
export function userConfigPath(env: Record<string, string | undefined>, home: string): { path: string } | { refused: string } {
  const xdg = env["XDG_CONFIG_HOME"]?.trim()
  if (xdg !== undefined && xdg.length > 0 && isAbsolute(xdg)) return { path: join(xdg, "mad", "config.json") }
  if (!isAbsolute(home)) return { refused: "MAD could not find the home directory, so it cannot locate its config file" }
  return { path: join(home, ".config", "mad", "config.json") }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function listProblem(where: string, value: unknown, max: number): string | undefined {
  if (!Array.isArray(value)) return `${where} must be a list of \`provider/model\` strings`
  if (value.length > max) return `${where} names ${value.length} models; at most ${max} are accepted`
  for (const [index, entry] of value.entries()) {
    const { providerId, modelId } = splitModelRef(entry)
    if (typeof entry !== "string" || providerId === "" || modelId === "") {
      return `${where}[${index}] is not a \`provider/model\` string`
    }
  }
  return undefined
}

function entryOf(where: string, value: unknown): { entry: ConfigEntry } | { why: string } {
  if (!isPlainObject(value)) return { why: `${where} must be an object` }
  for (const key of Object.keys(value)) {
    if (!ENTRY_KEYS.has(key)) return { why: `${where} has an unknown key \`${key}\`` }
  }
  const entry: ConfigEntry = {}
  if ("models" in value) {
    const problem = listProblem(`${where}.models`, value["models"], MAX_DISCOVERY_SLOTS)
    if (problem !== undefined) return { why: problem }
    entry.models = [...(value["models"] as string[])]
  }
  if ("exclude" in value) {
    const problem = listProblem(`${where}.exclude`, value["exclude"], MAX_EXCLUSIONS)
    if (problem !== undefined) return { why: problem }
    entry.exclude = [...(value["exclude"] as string[])]
  }
  if ("preset" in value) {
    const preset = value["preset"]
    if (typeof preset !== "string" || !(PRESETS as readonly string[]).includes(preset)) {
      return { why: `${where}.preset must be one of ${PRESETS.join(", ")}` }
    }
    entry.preset = preset as Preset
  }
  return { entry }
}

/** The file's content as a `UserConfig`, or why it is refused. Pure. */
export function parseUserConfig(text: string): { config: UserConfig } | { why: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { why: `it is not valid JSON (${error instanceof Error ? error.message : String(error)})` }
  }
  if (!isPlainObject(raw)) return { why: "it must hold one JSON object" }
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.has(key)) return { why: `it has an unknown key \`${key}\`` }
  }
  let defaults: ConfigEntry = {}
  if ("defaults" in raw) {
    const parsed = entryOf("defaults", raw["defaults"])
    if ("why" in parsed) return parsed
    defaults = parsed.entry
  }
  const stacks = new Map<string, ConfigEntry>()
  if ("stacks" in raw) {
    const value = raw["stacks"]
    if (!isPlainObject(value)) return { why: "`stacks` must be an object" }
    for (const name of Object.keys(value)) {
      if (!STACK_NAME.test(name)) return { why: `stack name \`${name}\` must be letters, digits, \`-\` and \`_\`` }
      const parsed = entryOf(`stacks.${name}`, value[name])
      if ("why" in parsed) return parsed
      stacks.set(name, parsed.entry)
    }
  }
  return { config: { defaults, stacks } }
}

function errnoOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null ? (error as { code?: string }).code : undefined
}

/** The most symlinks one resolution follows, as `realpath` allows. */
const MAX_LINKS = 40

type Chain =
  | { kind: "found"; location: string; throughWorktree: boolean }
  | { kind: "missing" }
  | { kind: "refused"; why: string }

/**
 * An absolute path's root (`/`, `C:\`, or a UNC share root such as
 * `\\server\share\`) and the components below it, under the given path
 * rules. Empty and `.` components are dropped; `..` is kept for the walker.
 * Exported so the decomposition is tested under both POSIX and win32 rules.
 */
export function decompose(p: string, rules: typeof nodePath.posix = nodePath): { root: string; parts: string[] } {
  const { root } = rules.parse(p)
  const separators = rules === nodePath.win32 ? /[\\/]+/ : /\/+/
  const parts = p
    .slice(root.length)
    .split(separators)
    .filter((part) => part.length > 0 && part !== ".")
  return { root, parts }
}

/**
 * Resolves an absolute path one component at a time, following symlinks, and
 * reports whether any location visited (each directory entered and each
 * symlink read) satisfies `within`, which is given the location and, for a
 * directory, its `lstat` result. A component of the path as written that
 * does not exist is `missing`; one that a symlink's target names is a dangling
 * symlink, refused. A component that is not a directory where one is needed,
 * a loop, and any other error are refused.
 */

type Within = (location: string, stats?: { dev: number; ino: number; isDirectory(): boolean }) => boolean

async function resolveChain(path: string, within: Within): Promise<Chain> {
  const start = decompose(path)
  const queue: { name: string; fromLink: boolean }[] = start.parts.map((name) => ({ name, fromLink: false }))
  let current: string = start.root
  let throughWorktree = within(current, await lstat(current).catch(() => undefined))
  let links = 0
  while (queue.length > 0) {
    const { name, fromLink } = queue.shift()!
    if (name === "..") {
      current = dirname(current)
      continue
    }
    const candidate = join(current, name)
    if (within(candidate)) throughWorktree = true
    let stats
    try {
      stats = await lstat(candidate)
      if (within(candidate, stats)) throughWorktree = true
    } catch (error) {
      const code = errnoOf(error)
      if (code === "ENOENT" && !fromLink) return { kind: "missing" }
      if (code === "ENOENT") return { kind: "refused", why: `a symlink on the config file's path leads to \`${candidate}\`, which does not exist` }
      if (code === "ENOTDIR") return { kind: "refused", why: `a component of the config file's path above \`${candidate}\` is not a directory` }
      return { kind: "refused", why: `MAD could not inspect the config file's path at \`${candidate}\` (${code ?? String(error)})` }
    }
    if (stats.isSymbolicLink()) {
      links += 1
      if (links > MAX_LINKS) return { kind: "refused", why: "the config file's path has too many symlinks (a loop?)" }
      let target: string
      try {
        target = await readlink(candidate)
      } catch (error) {
        return { kind: "refused", why: `MAD could not read the symlink \`${candidate}\` (${errnoOf(error) ?? String(error)})` }
      }
      const next = decompose(target)
      if (isAbsolute(target)) current = next.root
      else if (next.root !== "") {
        return { kind: "refused", why: `the symlink \`${candidate}\` has a drive-relative target, which MAD does not follow` }
      }
      queue.unshift(...next.parts.map((part) => ({ name: part, fromLink: true })))
      continue
    }
    if (queue.length > 0 && !stats.isDirectory()) {
      return { kind: "refused", why: `\`${candidate}\` on the config file's path is not a directory` }
    }
    current = candidate
  }
  return { kind: "found", location: current, throughWorktree }
}

export interface ReadUserConfigOptions {
  env: Record<string, string | undefined>
  /** The worktree under review. */
  worktree: string
  /** Defaults to `os.homedir()`. */
  home?: string
  /** Test seam: runs after every check and before the read. */
  afterChecks?: () => Promise<void>
}

/** Reads MAD's user config file for one review. Never throws. */
export async function readUserConfig(options: ReadUserConfigOptions): Promise<UserConfigRead> {
  const located = userConfigPath(options.env, options.home ?? homedir())
  if ("refused" in located) return { kind: "refused", path: null, why: located.refused }
  const path = located.path
  const refuse = (why: string): UserConfigRead => ({ kind: "refused", path, why })

  let realWorktree: string
  try {
    realWorktree = await realpath(resolve(options.worktree))
  } catch (error) {
    return refuse(`MAD could not resolve the worktree under review (${errnoOf(error) ?? String(error)}), so it cannot show the config file is outside it`)
  }
  // By name, as given and as resolved; and by identity, because a filesystem
  // can treat two spellings of one directory as the same directory (on Darwin,
  // composed and decomposed Unicode) while the strings differ. The walk enters
  // every directory on the way down, so entering the worktree under any
  // spelling is entering a directory with the worktree's device and inode.
  let worktreeId: { dev: number; ino: number }
  try {
    worktreeId = await stat(realWorktree)
  } catch (error) {
    return refuse(`MAD could not inspect the worktree under review (${errnoOf(error) ?? String(error)})`)
  }
  const within: Within = (location, stats) =>
    isWithin(location, realWorktree) ||
    isWithin(location, options.worktree) ||
    (stats !== undefined && stats.isDirectory() && stats.dev === worktreeId.dev && stats.ino === worktreeId.ino)

  const chain = await resolveChain(path, within)
  if (chain.kind === "missing") return { kind: "absent", path }
  if (chain.kind === "refused") return refuse(chain.why)
  if (chain.throughWorktree) {
    return refuse(
      "a step of the config file's path is inside the repository under review, which must not choose its own reviewers",
    )
  }
  const real = chain.location
  // The operating system's own resolution must end where MAD's walk did, so a
  // path the system would refuse (a link to a file with a trailing `/` or `/.`)
  // is refused here too.
  let native: string
  try {
    native = await realpath(path)
  } catch (error) {
    return refuse(`the config file exists but MAD could not resolve it (${errnoOf(error) ?? String(error)})`)
  }
  if (!(isWithin(native, real) && isWithin(real, native))) {
    return refuse("MAD's step-by-step resolution of the config file's path disagrees with the system's")
  }
  try {
    const stats = await lstat(real)
    if (!stats.isFile()) return refuse("the config file is not a regular file")
  } catch (error) {
    return refuse(`MAD could not inspect the config file (${errnoOf(error) ?? String(error)})`)
  }

  await options.afterChecks?.()
  let text: string
  try {
    text = await readFile(real, "utf8")
  } catch (error) {
    return refuse(`MAD could not read the config file (${errnoOf(error) ?? String(error)})`)
  }
  const parsed = parseUserConfig(text)
  if ("why" in parsed) return refuse(parsed.why)
  return { kind: "loaded", path, config: parsed.config }
}
