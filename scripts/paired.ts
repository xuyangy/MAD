#!/usr/bin/env bun
/**
 * Story 2-8b — the gated paired launcher.
 *
 *   bun run paired --live --pin anthropic/claude-sonnet-4-5 \
 *     --directory /scratch/mad-labelled-change --out /scratch/mad-paired-2026-09-23
 *
 * It runs the protocol's three paired blocks (`ablation/paired.ts`) over the
 * sealed labelled change, and only after a preflight in ONE FIXED SEQUENCE in
 * which each stage gates the next:
 *
 * 1. **Offline checks.** Flags, containment, the bundle root, the frozen
 *    protocol, the paired gate table (`ablation/paired-gates.ts`), the Tools
 *    wiring and the first worktree-identity comparison. Every independent check
 *    runs and every failure prints together; a check whose prerequisite failed
 *    prints `not evaluated: <prerequisite>`. No opencode client exists and no
 *    network call is made until all of them pass.
 * 2. **Client and roster.** The client is created and the shipped default roster
 *    resolved with `--pin` as its pin. A pin that did not fill a slot, or a roster
 *    short of its slots, refuses. No model session, no billable request.
 * 3. **The recheck**, immediately before the schedule: the worktree identity, the
 *    `--out` containment and the bundle root, checked again.
 * 4. **`createSchedule`, then `runPairedBlocks`.**
 *
 * A failure at any stage exits 1 with no schedule and no bill. Nothing is written
 * under `--out` or into `--directory` before stage 3 passes. The one thing the
 * preflight creates is a private scratch directory holding the reference copy,
 * removed on success, on refusal, on a thrown error and on SIGINT/SIGTERM.
 *
 * ## Authority lives in the repository
 *
 * Readiness is `PAIRED_GATES` and nothing else: no flag, environment variable or
 * file read at run time can close a gate. While any gate the evaluation phase
 * requires is OPEN, this command refuses at stage 1.
 *
 * ## The change is the sealed one, and the worktree is proved
 *
 * `SEEDED_CHANGE` and `LABELLED_CHANGE_SEAL` go to both `createSchedule` and
 * `runPairedBlocks`; the change is never read from the worktree, and `--target` is refused as
 * a second authority on what is reviewed. `--directory` is compared with a
 * reference copy written by the materializer's own `writeLabelledTree` (see
 * `worktreeIdentity`). Every git call runs through the 2-7c bounded launcher
 * (`adapters/opencode/blame-exec.ts`) with no `GIT_*` environment variable, no
 * fsmonitor and no hooks. A change made to the worktree after the stage-3
 * recheck, during the paid run, is not detected here.
 *
 * ## The Tools port is the production one
 *
 * The Tools factory reports the adapter it built and both blame deadlines; the
 * launcher requires `opencodeTools` with the shipped deadlines, which is what the
 * default factory builds (no override). `config.tools` records the same three
 * facts. When the port reports unconfirmed blame cleanup, the run is aborted
 * through its signal and the process id is printed.
 *
 * Exit codes: 0 when the three blocks ran and the runner's result reads
 * `complete: true`; 1 for every refusal and every incomplete run.
 */

import { rmSync } from "node:fs"
import { lstat, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

import { realRefusalFor, refusalFor } from "../adapters/opencode/artifacts.ts"
import { runBoundedBlame, type BlameExecOutcome, type SpawnBlame, type SpawnedBlame } from "../adapters/opencode/blame-exec.ts"
import { OpencodeModelBackend } from "../adapters/opencode/model-backend.ts"
import { DEFAULT_DISCOVERY_SLOTS } from "../adapters/opencode/plugin.ts"
import { enumerateCandidates, OPENCODE_PROVIDER_CONFIG_KEY } from "../adapters/opencode/roster.ts"
import {
  DEFAULT_BLAME_CLEANUP_TIMEOUT_MS,
  DEFAULT_BLAME_TIMEOUT_MS,
  opencodeTools,
  type BlameCleanupUnresolved,
  type OpencodeToolsOptions,
} from "../adapters/opencode/tools.ts"
import { codeRevisionFrom } from "../ablation/bundle.ts"
import { unknownValue, type CodeRevision, type Maybe } from "../ablation/manifest.ts"
import { runPairedBlocks, type PairedPhaseContext } from "../ablation/paired.ts"
import { gatePreflight, PAIRED_GATES, type PairedGate } from "../ablation/paired-gates.ts"
import {
  createSchedule,
  readFrozenProtocol,
  SCHEDULE_FILE,
  START_MARKER_FILE,
  type CoinFace,
  type PairedConfig,
} from "../ablation/schedule.ts"
import { normalizeModelIdentity } from "../core/domain/lineage.ts"
import type { Candidate, Roster } from "../core/domain/roster.ts"
import type { Warning } from "../core/domain/warning.ts"
import { systemClock, type Clock } from "../core/ports/clock.ts"
import type { LateUsageReporter } from "../core/ports/late-usage.ts"
import type { ModelBackend } from "../core/ports/model-backend.ts"
import type { Tools } from "../core/ports/tools.ts"
import { selectRoster, type Pin } from "../core/roster/select.ts"
import { SEEDED_CHANGE } from "../fixtures/seeded-defects/material.ts"
import { LABELLED_CHANGE_SEAL } from "../fixtures/seeded-defects/seal.ts"
import { writeLabelledTree, type GitResult, type RunGit } from "./materialize-labelled-change.ts"

/** This repository: the reviewed worktree may neither be it, sit inside it, nor contain it. */
const REPO_ROOT = resolve(import.meta.dir, "..")
export const PROTOCOL_FILE = join(REPO_ROOT, "_bmad-output/specs/spec-mad-orchestrator/evaluation-protocol.md")
export const DEFAULT_SERVER = "http://localhost:4096"

/**
 * The preflight's git deadlines: fixed constants, not flags. Each git call in the
 * reference build and the identity comparison is killed at the first and given
 * the second to confirm it went, the same pair `opencodeTools` gives a blame.
 */
export const PREFLIGHT_GIT_DEADLINE_MS = 60_000
export const PREFLIGHT_GIT_CLEANUP_MS = 5_000

/**
 * Settings every preflight git call carries, ahead of its own arguments. A
 * repository's own config could otherwise run code during a read (an fsmonitor
 * program, a hook) or change what git reports. `/dev/null/…` can never exist,
 * so no hook is ever found there.
 */
export const PREFLIGHT_GIT_SETTINGS = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null/mad-no-hooks"] as const

/** The adapter the production Tools port is, as the factory reports it. */
export const PRODUCTION_TOOLS_ADAPTER = "opencodeTools (adapters/opencode/tools.ts)"

/** The Tools port a factory built, and what it reports it was built with. */
export interface ToolsWiring {
  tools: Tools
  adapter: string
  blameTimeoutMs: number
  blameCleanupTimeoutMs: number
}

/** Builds the Tools port. The default is `opencodeTools` with the options exactly as given. */
export type ToolsFactory = (options: OpencodeToolsOptions) => ToolsWiring | undefined

export const productionTools: ToolsFactory = (options) => ({
  tools: opencodeTools(options),
  adapter: PRODUCTION_TOOLS_ADAPTER,
  blameTimeoutMs: options.blameTimeoutMs ?? DEFAULT_BLAME_TIMEOUT_MS,
  blameCleanupTimeoutMs: options.blameCleanupTimeoutMs ?? DEFAULT_BLAME_CLEANUP_TIMEOUT_MS,
})

/** The `config.tools` identity: the adapter and both blame deadlines, as the factory reported them. */
export function toolsIdentity(wiring: ToolsWiring): string {
  return (
    `${wiring.adapter}; blame deadline ${wiring.blameTimeoutMs} ms; ` +
    `blame cleanup budget ${wiring.blameCleanupTimeoutMs} ms`
  )
}

/**
 * Why the factory's report is not the production Tools port with its shipped
 * deadlines, or `null`. It checks what the factory REPORTS; the shipped default
 * factory reports what it passed to `opencodeTools`, which is no override.
 */
export function toolsWiringProblem(wiring: ToolsWiring | undefined): string | null {
  if (wiring === undefined || wiring.tools === undefined) {
    return "no Tools port was built, so the run would drive no production Tools port"
  }
  const problems: string[] = []
  if (wiring.adapter !== PRODUCTION_TOOLS_ADAPTER) problems.push(`the adapter is \`${wiring.adapter}\`, not ${PRODUCTION_TOOLS_ADAPTER}`)
  if (wiring.blameTimeoutMs !== DEFAULT_BLAME_TIMEOUT_MS) {
    problems.push(`the blame deadline is ${wiring.blameTimeoutMs} ms, not the shipped ${DEFAULT_BLAME_TIMEOUT_MS} ms`)
  }
  if (wiring.blameCleanupTimeoutMs !== DEFAULT_BLAME_CLEANUP_TIMEOUT_MS) {
    problems.push(
      `the blame cleanup budget is ${wiring.blameCleanupTimeoutMs} ms, not the shipped ${DEFAULT_BLAME_CLEANUP_TIMEOUT_MS} ms`,
    )
  }
  return problems.length === 0 ? null : problems.join("; ")
}

/** How the launcher listens for SIGINT/SIGTERM. The default is `process`. */
export interface SignalSource {
  on(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown
  off(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown
}

/** The two steps of stage 4, replaceable only so a test can make one throw. */
export interface Runner {
  createSchedule: typeof createSchedule
  runPairedBlocks: typeof runPairedBlocks
}

/** What `main` takes from outside. Every default is the shipped behaviour. */
export interface PairedOverrides {
  gates?: readonly PairedGate[]
  createClient?: (init: { baseUrl: string; directory: string }) => unknown
  enumerate?: (client: unknown) => Promise<Candidate[]>
  backendFor?: (context: PairedPhaseContext, lateUsage: LateUsageReporter, roster: Roster) => ModelBackend
  tools?: ToolsFactory
  clock?: Clock
  coin?: () => CoinFace
  codeRevision?: () => Promise<Maybe<CodeRevision>>
  /** The bounded launcher's spawn, for the preflight's git calls. Defaults to `preflightSpawn`. */
  spawnGit?: SpawnBlame
  /** Test-only: the preflight's git deadlines. The shipped values are the constants above. */
  gitDeadlineMs?: number
  gitCleanupMs?: number
  /** Where the private scratch directory is created. Defaults to the system temp directory. */
  scratchParent?: string
  /** Called at stage 3 before the recheck, so a test can change something between stages. */
  beforeRecheck?: () => Promise<void>
  signals?: SignalSource
  /** What an interrupt during stages 1-3 exits with. Defaults to `process.exit`. */
  exit?: (code: number) => void
  runner?: Partial<Runner>
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set(["pin", "directory", "out", "server", "target"])
const KNOWN_FLAGS = new Set<string>(["live", ...VALUE_FLAGS])

const matchesFlag = (arg: string, name: string) => arg === `--${name}` || arg.startsWith(`--${name}=`)

type FlagValue = { ok: true; value: string | undefined } | { ok: false; message: string; short: string }

function valueFlag(args: readonly string[], name: string): FlagValue {
  const indices = args.flatMap((arg, index) => (matchesFlag(arg, name) ? [index] : []))
  if (indices.length === 0) return { ok: true, value: undefined }
  if (indices.length > 1) {
    return {
      ok: false,
      short: `given ${indices.length} times`,
      message: `--${name} was given ${indices.length} times. Pass it once; MAD will not guess which value is in force.`,
    }
  }
  const arg = args[indices[0]!]!
  const eq = arg.indexOf("=")
  const raw = eq >= 0 ? arg.slice(eq + 1) : args[indices[0]! + 1]
  if (raw === undefined || raw.trim() === "" || raw.startsWith("-")) {
    return { ok: false, short: "no value", message: `--${name} needs a value. Nothing readable followed it.` }
  }
  return { ok: true, value: raw.trim() }
}

/** `provider/model`, split at the first slash. */
function parsePin(value: string): Pin | undefined {
  const cut = value.indexOf("/")
  if (cut <= 0 || cut === value.length - 1) return undefined
  return { providerId: value.slice(0, cut).trim(), modelId: value.slice(cut + 1).trim() }
}

export interface ParsedFlags {
  problems: string[]
  pin?: Pin
  directory?: string
  out?: string
  server: string
  /** Why `--directory` or `--out` is unusable, in the words a dependent check prints. */
  unusable: { directory?: string; out?: string }
}

/** Parse `argv` as `Bun.argv` gives it: the runtime and the script first, then the arguments. */
export function parseFlags(argv: readonly string[]): ParsedFlags {
  const args = argv.slice(2)
  const problems: string[] = []
  const parsed: ParsedFlags = { problems, server: DEFAULT_SERVER, unusable: {} }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg.startsWith("--")) {
      const name = arg.slice(2).split("=")[0]!
      if (!KNOWN_FLAGS.has(name)) {
        problems.push(`\`${arg}\` is not a flag this command knows. It takes --live, --pin, --directory, --out and --server only.`)
      } else if (VALUE_FLAGS.has(name) && !arg.includes("=") && args[index + 1] !== undefined && !args[index + 1]!.startsWith("-")) {
        index += 1
      }
      continue
    }
    problems.push(`unexpected argument \`${arg}\`. Every argument this command takes is a --flag; nothing positional is read.`)
  }

  const live = args.filter((arg) => matchesFlag(arg, "live"))
  if (live.length === 0) {
    problems.push("--live is required. This command runs against real providers once every gate is closed, and says so by name.")
  } else if (live.some((arg) => arg !== "--live")) {
    problems.push(`--live takes no value; it received \`${live.find((arg) => arg !== "--live")}\`.`)
  } else if (live.length > 1) {
    problems.push(`--live was given ${live.length} times. Pass it once.`)
  }

  const pin = valueFlag(args, "pin")
  if (!pin.ok) problems.push(pin.message)
  else if (pin.value === undefined) problems.push("--pin provider/model is required. MAD names no model; you name the pinned slot.")
  else {
    const value = parsePin(pin.value)
    if (value === undefined) problems.push(`--pin must be provider/model. It received \`${pin.value}\`.`)
    else parsed.pin = value
  }

  for (const name of ["directory", "out"] as const) {
    const flag = valueFlag(args, name)
    if (!flag.ok) {
      problems.push(flag.message)
      parsed.unusable[name] = `--${name} (rejected: ${flag.short})`
    } else if (flag.value === undefined) {
      problems.push(
        name === "directory"
          ? "--directory is required: the materialized labelled change the models' sessions open files in."
          : "--out is required: the bundle root the schedule, journal and evidence are written to.",
      )
      parsed.unusable[name] = `--${name}`
    } else if (!isAbsolute(flag.value)) {
      problems.push(`--${name} must be an absolute path. It received \`${flag.value}\`, which would resolve against the current directory.`)
      parsed.unusable[name] = `--${name} (rejected: not absolute)`
    } else parsed[name] = resolve(flag.value)
  }

  const server = valueFlag(args, "server")
  if (!server.ok) problems.push(server.message)
  else if (server.value !== undefined) {
    let url: URL | undefined
    try {
      url = new URL(server.value)
    } catch {
      url = undefined
    }
    if (url === undefined || (url.protocol !== "http:" && url.protocol !== "https:")) {
      problems.push(`--server must be an http(s) URL. It received \`${server.value}\`.`)
    } else parsed.server = server.value
  }

  if (args.some((arg) => matchesFlag(arg, "target"))) {
    problems.push(
      "--target is refused: the launcher reviews the sealed labelled change itself and never reads a ref range, " +
        "so --target would be a second authority on what is reviewed. Drop it.",
    )
  }
  return parsed
}

// ---------------------------------------------------------------------------
// The bounded git runner
// ---------------------------------------------------------------------------

/** A preflight git call that did not return. Carries the launcher's own account. */
export class PreflightGitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PreflightGitError"
  }
}

/** This process's environment with every `GIT_*` variable removed, and `PWD` set to `cwd`. */
export function preflightGitEnv(env: Record<string, string | undefined>, cwd: string): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !key.toUpperCase().startsWith("GIT_")) clean[key] = value
  }
  return { ...clean, PWD: cwd }
}

/**
 * The preflight's spawn: `runBoundedBlame`'s default shape (no standard input,
 * piped output, `PWD` matching the working directory) with every `GIT_*`
 * variable stripped, so a `GIT_DIR`, `GIT_INDEX_FILE` or `GIT_CONFIG_*` in the
 * operator's shell cannot point a comparison at another repository or config.
 */
export const preflightSpawn: SpawnBlame = (request) =>
  Bun.spawn({
    cmd: request.cmd,
    cwd: request.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: preflightGitEnv(process.env, request.cwd),
  }) as unknown as SpawnedBlame

/** Why a bounded outcome is not a returned process, or `null` when it returned. */
export function nonReturnedReason(command: string, outcome: BlameExecOutcome): string | null {
  switch (outcome.kind) {
    case "returned":
      return null
    case "launch-failed":
      return `\`${command}\` could not be started: ${outcome.why}`
    case "refused":
      return `\`${command}\` was not launched: ${outcome.why}`
    case "observation-failed":
      return outcome.cleanup.kind === "confirmed"
        ? `\`${command}\` could not be observed (${outcome.why}); termination was confirmed (process ${outcome.pid})`
        : `\`${command}\` could not be observed (${outcome.why}); termination is UNCONFIRMED — check process ${outcome.pid} by hand`
    case "terminated":
      return `\`${command}\` timed out and was killed; termination was confirmed (process ${outcome.pid}): ${outcome.why}`
    case "cleanup-unresolved":
      return (
        `\`${command}\` timed out; termination is UNCONFIRMED and the process may still be running — ` +
        `check process ${outcome.pid} by hand: ${outcome.why}`
      )
    default: {
      const unhandled: never = outcome
      return `\`${command}\` ended with an outcome this launcher does not know: ${JSON.stringify(unhandled)}`
    }
  }
}

function boundedGit(options: { spawn: SpawnBlame; deadlineMs: number; cleanupMs: number }): RunGit {
  return async (cwd, args, stdin): Promise<GitResult> => {
    const command = `git ${args.join(" ")}`
    if (stdin !== undefined) throw new PreflightGitError(`\`${command}\` needs standard input, which the bounded launcher does not give`)
    const outcome = await runBoundedBlame({
      argv: ["git", ...PREFLIGHT_GIT_SETTINGS, ...args],
      cwd,
      deadlineMs: options.deadlineMs,
      cleanupMs: options.cleanupMs,
      spawn: options.spawn,
    })
    const reason = nonReturnedReason(command, outcome)
    if (reason !== null || outcome.kind !== "returned") throw new PreflightGitError(reason ?? command)
    return { exitCode: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderrFailure ?? outcome.stderr }
  }
}

// ---------------------------------------------------------------------------
// Worktree identity
// ---------------------------------------------------------------------------

type EntryType = "file" | "directory" | "symlink" | "FIFO" | "socket" | "device"

interface Entry {
  type: EntryType
  size: number
  links: number
  executable: boolean
}

/**
 * Every entry under `root` except its top-level `.git`, by lstat. With `limit`,
 * the walk stops and returns `overflow` once it has seen more entries than that.
 * This bounds how many entries are walked; it does not bound a slow mount.
 */
async function entriesOf(root: string, limit?: number): Promise<{ entries: Map<string, Entry>; overflow: boolean }> {
  const entries = new Map<string, Entry>()
  const walk = async (relative: string): Promise<boolean> => {
    const names = (await readdir(join(root, relative))).sort()
    for (const name of names) {
      if (relative === "" && name === ".git") continue
      const path = relative === "" ? name : `${relative}/${name}`
      const info = await lstat(join(root, path))
      const type: EntryType = info.isSymbolicLink()
        ? "symlink"
        : info.isFile()
          ? "file"
          : info.isDirectory()
            ? "directory"
            : info.isFIFO()
              ? "FIFO"
              : info.isSocket()
                ? "socket"
                : "device"
      entries.set(path, { type, size: info.size, links: info.nlink, executable: (info.mode & 0o111) !== 0 })
      if (limit !== undefined && entries.size > limit) return false
      if (type === "directory" && !(await walk(path))) return false
    }
    return true
  }
  const complete = await walk("")
  return { entries, overflow: !complete }
}

const article = (type: EntryType) => (type === "file" ? "a regular file" : `a ${type}`)

/** Every file under `dir`, relative, with its bytes; an absent directory is empty. */
async function filesUnder(dir: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()
  const walk = async (relative: string): Promise<void> => {
    let names: string[]
    try {
      names = (await readdir(join(dir, relative))).sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    for (const name of names) {
      const path = relative === "" ? name : `${relative}/${name}`
      const info = await lstat(join(dir, path))
      if (info.isDirectory()) await walk(path)
      else files.set(path, info.isFile() ? await readFile(join(dir, path)) : Buffer.from(`<${info.isSymbolicLink() ? "symlink" : "special"}>`))
    }
  }
  await walk("")
  return files
}

/** `text` with every spelling of `root` (as given, and its real path) replaced by `<root>`. */
async function withRoot(text: string, root: string): Promise<string> {
  const spellings = new Set([root, await realpath(root).catch(() => root)])
  let out = text
  for (const spelling of [...spellings].sort((a, b) => b.length - a.length)) out = out.split(spelling).join("<root>")
  return out
}

const COMMIT_FIELDS = ["author name", "author email", "committer name", "committer email", "message"] as const

/**
 * Every way `directory` differs from the reference copy, each difference named.
 * Empty means the worktree is exactly the sealed labelled change:
 *
 * - outside `.git`: the same paths, each a regular file (with one link) or a
 *   directory, the same size, bytes and executable bit — the bit is compared on
 *   disk, not through the handed repository's `core.fileMode`;
 * - inside `.git`, what the model can read or what changes git's answers: the
 *   local config (the root path normalized), `.git/info/`, and no hook that is
 *   not a git `*.sample`;
 * - through git: `HEAD^{tree}`, the porcelain status, exactly one commit, and
 *   that commit's author, committer and message. Its dates are not compared:
 *   every materialization is made at a different time.
 */
export async function worktreeIdentity(directory: string, reference: string, git: RunGit): Promise<string[]> {
  const root = await lstat(directory).catch(() => undefined)
  if (root === undefined || !root.isDirectory()) {
    return [
      `\`${directory}\` ${root === undefined ? "does not exist" : "is not a directory"}. Materialize the sealed change there ` +
        `first: bun run materialize-change --out ${directory}`,
    ]
  }
  const problems: string[] = []
  const gitDir = await lstat(join(directory, ".git")).catch(() => undefined)
  const gitDirOk = gitDir !== undefined && !gitDir.isSymbolicLink() && gitDir.isDirectory()
  if (!gitDirOk) {
    problems.push(
      `\`${join(directory, ".git")}\` is ${gitDir === undefined ? "missing" : gitDir.isSymbolicLink() ? "a symlink" : "not a directory"}; ` +
        "the sealed materialization is a repository with its own .git directory",
    )
  }

  const sealed = (await entriesOf(reference)).entries
  const walked = await entriesOf(directory, sealed.size)
  const handed = walked.entries
  if (walked.overflow) {
    problems.push(
      `the worktree holds more than ${sealed.size} entries outside .git, and the sealed tree holds exactly ${sealed.size}; ` +
        "the walk stopped there, so only the entries seen before it stopped are named below",
    )
  }
  for (const [path, entry] of handed) {
    if (entry.type !== "file" && entry.type !== "directory") {
      problems.push(`\`${path}\` is ${article(entry.type)}; only regular files and directories are allowed outside .git`)
      continue
    }
    const expected = sealed.get(path)
    if (expected === undefined) {
      problems.push(`\`${path}\` is not in the sealed tree (an extra ${entry.type === "file" ? "file" : "directory"})`)
    } else if (expected.type !== entry.type) {
      problems.push(`\`${path}\` is ${article(entry.type)} where the sealed tree has ${article(expected.type)}`)
    } else if (entry.type === "file") {
      if (entry.links > 1) problems.push(`\`${path}\` has ${entry.links} hard links; a sealed file has exactly one`)
      if (entry.executable !== expected.executable) {
        problems.push(`\`${path}\`'s executable bit is ${entry.executable ? "set" : "clear"}; the sealed file's is ${expected.executable ? "set" : "clear"}`)
      }
      if (entry.size > expected.size) {
        problems.push(`\`${path}\` is larger than its sealed counterpart (${entry.size} bytes, sealed ${expected.size}); not read`)
      } else if (entry.size !== expected.size) {
        problems.push(`\`${path}\` differs in content from the sealed tree (${entry.size} bytes, sealed ${expected.size})`)
      } else {
        const [a, b] = await Promise.all([readFile(join(directory, path)), readFile(join(reference, path))])
        if (!a.equals(b)) problems.push(`\`${path}\` differs in content from the sealed tree`)
      }
    }
  }
  // A stopped walk did not see every path, so what it did not reach is not called missing.
  if (!walked.overflow) {
    for (const path of sealed.keys()) {
      if (!handed.has(path)) problems.push(`\`${path}\` is missing`)
    }
  }
  if (!gitDirOk || walked.overflow) return problems

  // ---- inside .git ----
  const [handedInfo, sealedInfo] = await Promise.all([filesUnder(join(directory, ".git", "info")), filesUnder(join(reference, ".git", "info"))])
  for (const path of new Set([...handedInfo.keys(), ...sealedInfo.keys()])) {
    const a = handedInfo.get(path)
    const b = sealedInfo.get(path)
    if (a === undefined) problems.push(`\`.git/info/${path}\` is missing`)
    else if (b === undefined) problems.push(`\`.git/info/${path}\` is not in the sealed repository`)
    else if (!a.equals(b)) problems.push(`\`.git/info/${path}\` differs from the sealed repository's`)
  }
  const hooks = await readdir(join(directory, ".git", "hooks")).catch(() => [] as string[])
  for (const hook of hooks.sort()) {
    if (!hook.endsWith(".sample")) problems.push(`\`.git/hooks/${hook}\` is a hook that is not a git sample; the sealed repository has none`)
  }

  const read = async (cwd: string, args: string[], allow: number[] = [0]): Promise<string> => {
    const result = await git(cwd, args)
    if (!allow.includes(result.exitCode)) {
      throw new PreflightGitError(`\`git ${args.join(" ")}\` in \`${cwd}\` exited ${result.exitCode}: ${result.stderr.trim() || "no detail"}`)
    }
    return result.stdout
  }
  const config = ["config", "--local", "--list"]
  const [handedConfig, sealedConfig] = [
    await withRoot(await read(directory, config), directory),
    await withRoot(await read(reference, config), reference),
  ]
  if (handedConfig !== sealedConfig) {
    const a = new Set(handedConfig.split("\n").filter(Boolean))
    const b = new Set(sealedConfig.split("\n").filter(Boolean))
    const extra = [...a].filter((line) => !b.has(line))
    const missing = [...b].filter((line) => !a.has(line))
    problems.push(
      `\`git config --local --list\` differs from the sealed repository's` +
        `${extra.length > 0 ? `; not sealed: ${extra.join(", ")}` : ""}${missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""}`,
    )
  }

  const tree = ["rev-parse", "HEAD^{tree}"]
  const status = ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"]
  const [handedTree, sealedTree] = [(await read(directory, tree)).trim(), (await read(reference, tree)).trim()]
  if (handedTree !== sealedTree) problems.push(`HEAD^{tree} is ${handedTree}; the sealed materialization's is ${sealedTree}`)
  const [handedStatus, sealedStatus] = [await read(directory, status), await read(reference, status)]
  if (handedStatus !== sealedStatus) {
    problems.push(
      `\`git status --porcelain=v1 --untracked-files=all\` differs:\n` +
        `    worktree: ${JSON.stringify(handedStatus)}\n    sealed:   ${JSON.stringify(sealedStatus)}`,
    )
  }
  const count = (await read(directory, ["rev-list", "--all", "--count"])).trim()
  if (count !== "1") {
    problems.push(`${count} commits are reachable from the worktree's refs (expected 1: the materializer makes one base commit)`)
  }
  // Author and committer names and emails and the message; dates vary by materialization and are not compared.
  const metadata = ["log", "-1", "--format=%an%x00%ae%x00%cn%x00%ce%x00%B"]
  const [handedCommit, sealedCommit] = [(await read(directory, metadata)).split("\0"), (await read(reference, metadata)).split("\0")]
  for (const [index, field] of COMMIT_FIELDS.entries()) {
    if (handedCommit[index] !== sealedCommit[index]) {
      problems.push(
        `the commit's ${field} is ${JSON.stringify(handedCommit[index] ?? "")}; the sealed commit's is ${JSON.stringify(sealedCommit[index] ?? "")}`,
      )
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// Checks shared by stages 1 and 3
// ---------------------------------------------------------------------------

type Check =
  | { name: string; state: "pass"; detail: string[] }
  | { name: string; state: "fail"; detail: string[] }
  | { name: string; state: "not-evaluated"; prerequisite: string }

const pass = (name: string, detail: string[] = []): Check => ({ name, state: "pass", detail })
const fail = (name: string, detail: string[]): Check => ({ name, state: "fail", detail })
const notEvaluated = (name: string, prerequisite: string): Check => ({ name, state: "not-evaluated", prerequisite })

async function contained(inner: string, outer: string): Promise<boolean> {
  return refusalFor(inner, outer) !== undefined || (await realRefusalFor(inner, outer)) !== undefined
}

/** A check that threw is a failed check, so every other check still prints. */
export async function guarded(name: string, run: () => Promise<Check>): Promise<Check> {
  try {
    return await run()
  } catch (error) {
    return fail(name, [`the check could not be made: ${messageOf(error)}`])
  }
}

async function presence(file: string): Promise<"absent" | "present" | string> {
  try {
    await lstat(file)
    return "present"
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" ? "absent" : `whether \`${file}\` exists could not be established: ${messageOf(error)}`
  }
}

async function outContainment(out: string, directory: string): Promise<Check> {
  return guarded("--out containment", async () => {
    const problems: string[] = []
    if (await contained(out, REPO_ROOT)) problems.push(`\`${out}\` is inside this repository (AD-16); name a bundle root outside it`)
    if (await contained(out, directory)) {
      problems.push(`\`${out}\` is inside --directory; the bundle would be written into the reviewed worktree (AD-16)`)
    }
    return problems.length === 0 ? pass("--out containment") : fail("--out containment", problems)
  })
}

/** The bundle root check, and which of the runner's files are already there. */
async function bundleRoot(out: string): Promise<{ check: Check; preexisting: string[] }> {
  const preexisting: string[] = []
  const check = await guarded("bundle root", async () => {
    const problems: string[] = []
    const root = await lstat(out).catch(() => undefined)
    if (root !== undefined && !root.isDirectory()) problems.push(`\`${out}\` exists and is not a directory`)
    else {
      for (const [file, what] of [
        [SCHEDULE_FILE, "a schedule is never re-tossed"],
        [START_MARKER_FILE, "a started schedule is never run again"],
      ] as const) {
        const state = await presence(join(out, file))
        if (state === "present") {
          preexisting.push(join(out, file))
          problems.push(`\`${join(out, file)}\` already exists; ${what}. Start from a new bundle root.`)
        } else if (state !== "absent") problems.push(state)
      }
    }
    return problems.length === 0 ? pass("bundle root", [`\`${out}\` holds no schedule and no start marker`]) : fail("bundle root", problems)
  })
  return { check, preexisting }
}

function printCheck(check: Check): void {
  if (check.state === "not-evaluated") {
    console.log(`  ${check.name} — not evaluated: ${check.prerequisite}`)
    return
  }
  console.log(`  ${check.state === "pass" ? "PASS" : "FAIL"}  ${check.name}`)
  for (const line of check.detail) console.log(`        ${line}`)
}

/**
 * A preflight refusal: what was refused, why, and the next step. The trailer
 * states what THIS invocation did not do, and names any runner file that was
 * already in the bundle root and left untouched.
 */
function refusal(stage: string, reasons: string[], next: string, preexisting: string[] = []): number {
  console.log(
    `\nREFUSED at ${stage}.\n` +
      reasons.map((reason) => `  - ${reason}\n`).join("") +
      "Nothing was scheduled and nothing was billed by this invocation: it tossed no coin, wrote no start marker,\n" +
      "and wrote nothing under --out or into --directory.\n" +
      (preexisting.length === 0 ? "" : `Already in the bundle root, and left untouched: ${preexisting.join(", ")}.\n`) +
      `Next step: ${next}`,
  )
  return 1
}

/** The next step for a `createSchedule` refusal, matched to its reason. */
function scheduleNextStep(reason: string): string {
  if (reason.includes("another writer holds")) {
    return "confirm that no runner is active on this bundle root, then remove its paired.lock; or start from a new bundle root."
  }
  if (reason.includes("already exists")) return "a schedule is never re-tossed: start from a new bundle root."
  if (reason.includes("protocol")) return "restore the frozen protocol file exactly as frozen (protocol v1 is never edited), then run again."
  return "fix the cause named above and start from a new bundle root."
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export async function main(argv: readonly string[] = Bun.argv, overrides: PairedOverrides = {}): Promise<number> {
  const gates = overrides.gates ?? PAIRED_GATES
  const clock = overrides.clock ?? systemClock()
  const git = boundedGit({
    spawn: overrides.spawnGit ?? preflightSpawn,
    deadlineMs: overrides.gitDeadlineMs ?? PREFLIGHT_GIT_DEADLINE_MS,
    cleanupMs: overrides.gitCleanupMs ?? PREFLIGHT_GIT_CLEANUP_MS,
  })
  const signals: SignalSource = overrides.signals ?? process
  const exit = overrides.exit ?? ((code: number) => process.exit(code))
  const runner: Runner = {
    createSchedule: overrides.runner?.createSchedule ?? createSchedule,
    runPairedBlocks: overrides.runner?.runPairedBlocks ?? runPairedBlocks,
  }
  const controller = new AbortController()
  const unresolved: BlameCleanupUnresolved[] = []
  const onCleanupUnresolved = (fact: BlameCleanupUnresolved): void => {
    unresolved.push(fact)
    console.log(
      `\nBLAME CLEANUP UNCONFIRMED — ${fact.operation}: ${fact.why}. The run is being aborted. ` +
        `Check process ${fact.pid} by hand before anything else runs against this worktree.`,
    )
    controller.abort(new Error(`blame cleanup was not confirmed for process ${fact.pid}`))
  }

  let scratch: string | undefined
  let interrupted = false
  // SIGINT/SIGTERM during stages 1-3: remove the scratch copy and exit; nothing else exists yet.
  const preflightInterrupt = (): void => {
    interrupted = true
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true })
    console.log("\nINTERRUPTED during the preflight. The scratch copy was removed; nothing was scheduled and nothing was billed.")
    exit(130)
  }
  signals.on("SIGINT", preflightInterrupt)
  signals.on("SIGTERM", preflightInterrupt)

  let prepared: { pin: Pin; directory: string; out: string; server: string; wiring: ToolsWiring; roster: Roster; warnings: Warning[] }
  try {
    // ---- STAGE 1: offline checks ----
    console.log("bun run paired — stage 1 of 4: offline checks (no client, no network call, nothing written)")
    const flags = parseFlags(argv)
    const checks: Check[] = []
    checks.push(flags.problems.length === 0 ? pass("flags") : fail("flags", flags.problems))

    const { directory, out } = flags
    const directoryMissing = flags.unusable.directory ?? "--directory"
    const outMissing = flags.unusable.out ?? "--out"
    let directoryContained = true
    if (directory === undefined) checks.push(notEvaluated("--directory containment", directoryMissing))
    else {
      checks.push(
        await guarded("--directory containment", async () => {
          directoryContained = (await contained(directory, REPO_ROOT)) || (await contained(REPO_ROOT, directory))
          return directoryContained
            ? fail("--directory containment", [
                `\`${directory}\` is this repository, is inside it, or contains it. A model's session can open any file ` +
                  "under --directory, and this repository holds the answer key (`fixtures/seeded-defects/labels.ts`). " +
                  "Materialize the change elsewhere: bun run materialize-change --out /scratch/mad-labelled-change",
              ])
            : pass("--directory containment", [`\`${directory}\` is outside this repository and does not contain it`])
        }),
      )
    }

    if (out === undefined) checks.push(notEvaluated("--out containment", outMissing))
    else if (directory === undefined) checks.push(notEvaluated("--out containment", directoryMissing))
    else checks.push(await outContainment(out, directory))

    let preexisting: string[] = []
    if (out === undefined) checks.push(notEvaluated("bundle root", outMissing))
    else {
      const root = await bundleRoot(out)
      preexisting = root.preexisting
      checks.push(root.check)
    }

    checks.push(
      await guarded("frozen protocol", async () => {
        const protocol = await readFrozenProtocol(PROTOCOL_FILE)
        return protocol.ok
          ? pass("frozen protocol", [`${protocol.id} v${protocol.version} ${protocol.hash}`])
          : fail("frozen protocol", [protocol.reason])
      }),
    )

    const gateCheck = gatePreflight(gates, "evaluation")
    checks.push(
      gateCheck.ok
        ? pass("paired gates (ablation/paired-gates.ts, phase evaluation)", gateCheck.lines)
        : fail("paired gates (ablation/paired-gates.ts, phase evaluation)", [
            ...gateCheck.lines,
            ...gateCheck.problems.map((problem) => `REFUSED: ${problem}`),
            "A gate closes only by a reviewed change to ablation/paired-gates.ts; no flag, variable or file can close one.",
          ]),
    )

    let wiring: ToolsWiring | undefined
    if (directory === undefined) checks.push(notEvaluated("production Tools wiring", directoryMissing))
    else {
      let problem: string | null
      try {
        wiring = (overrides.tools ?? productionTools)({ worktree: directory, onCleanupUnresolved })
        problem = toolsWiringProblem(wiring)
      } catch (error) {
        problem = `the Tools port could not be built: ${messageOf(error)}`
      }
      checks.push(
        problem === null
          ? pass("production Tools wiring", [`config.tools: ${toolsIdentity(wiring!)}`])
          : fail("production Tools wiring", [problem]),
      )
    }

    let reference: string | undefined
    const identityName = "worktree identity (first comparison)"
    if (directory === undefined) checks.push(notEvaluated(identityName, directoryMissing))
    else if (directoryContained) checks.push(notEvaluated(identityName, "--directory containment"))
    else {
      try {
        scratch = await mkdtemp(join(overrides.scratchParent ?? tmpdir(), "mad-paired-reference-"))
        const diffFile = join(scratch, "change.diff")
        await writeFile(diffFile, SEEDED_CHANGE.diff, "utf8")
        const built = await writeLabelledTree({ root: join(scratch, "reference"), git, diffFile })
        if (!built.ok) {
          checks.push(fail(identityName, [`the reference copy could not be built: \`${built.step}\` failed: ${built.detail}`]))
        } else {
          reference = join(scratch, "reference")
          const problems = await worktreeIdentity(directory, reference, git)
          checks.push(
            problems.length === 0
              ? pass(identityName, [`\`${directory}\` is exactly the sealed labelled change ${LABELLED_CHANGE_SEAL.version}`])
              : fail(identityName, problems),
          )
        }
      } catch (error) {
        checks.push(fail(identityName, [messageOf(error)]))
      }
    }

    for (const check of checks) printCheck(check)
    const failed = checks.filter((check) => check.state === "fail")
    const skipped = checks.filter((check) => check.state === "not-evaluated")
    if (
      failed.length > 0 ||
      skipped.length > 0 ||
      interrupted ||
      flags.pin === undefined ||
      directory === undefined ||
      out === undefined ||
      wiring === undefined ||
      reference === undefined
    ) {
      return refusal(
        "stage 1 (offline checks)",
        [
          ...failed.map((check) => `${check.name} failed`),
          ...skipped.map((check) => (check.state === "not-evaluated" ? `${check.name} was not evaluated (${check.prerequisite})` : check.name)),
        ],
        "fix every failure printed above and run the command again. An OPEN gate is closed only by its owner, " +
          "through a reviewed change to ablation/paired-gates.ts.",
        preexisting,
      )
    }

    // ---- STAGE 2: client and roster ----
    console.log("\nbun run paired — stage 2 of 4: opencode client and roster (no model session, no billable request)")
    let roster: Roster
    let warnings: Warning[]
    try {
      const client = await (overrides.createClient ?? defaultCreateClient)({ baseUrl: flags.server, directory })
      const candidates = await (overrides.enumerate ?? ((value: unknown) => enumerateCandidates(value as never)))(client)
      const resolved = selectRoster(candidates, {
        slots: DEFAULT_DISCOVERY_SLOTS,
        pins: [flags.pin],
        providerConfigKey: OPENCODE_PROVIDER_CONFIG_KEY,
      })
      roster = resolved.roster
      warnings = resolved.warnings
    } catch (error) {
      return refusal(
        "stage 2 (client and roster)",
        [`the roster could not be resolved from ${flags.server}: ${messageOf(error)}`],
        "start the opencode server (or pass --server), make sure the host has a provider configured, and run the command again.",
      )
    }
    for (const slot of roster.slots) console.log(`  ${slot.slot}: ${slot.providerId}/${slot.modelId}`)
    for (const warning of warnings) console.log(`  warning ${warning.code}: ${warning.message}`)
    const rosterProblems = rosterProblemsFor(roster, warnings, flags.pin)
    if (rosterProblems.length > 0) {
      return refusal(
        "stage 2 (client and roster)",
        rosterProblems,
        "configure the pinned model and enough distinct models in the host (the `provider` key in your opencode config), " +
          "or pin a model the host offers, and run the command again.",
      )
    }

    // ---- STAGE 3: worktree identity recheck ----
    console.log("\nbun run paired — stage 3 of 4: recheck (worktree identity, --out containment, bundle root)")
    await overrides.beforeRecheck?.()
    let recheck: string[]
    try {
      recheck = interrupted ? ["the preflight was interrupted"] : await worktreeIdentity(directory, reference, git)
    } catch (error) {
      recheck = [messageOf(error)]
    }
    const outAgain = await outContainment(out, directory)
    const rootAgain = await bundleRoot(out)
    const failures = [
      ...(recheck.length > 0 ? ["--directory changed after the first comparison and is no longer the sealed labelled change"] : []),
      ...(outAgain.state === "fail" ? ["--out containment failed at the recheck"] : []),
      ...(rootAgain.check.state === "fail" ? ["the bundle root changed after stage 1"] : []),
    ]
    for (const line of recheck) console.log(`  ${line}`)
    printCheck(outAgain)
    printCheck(rootAgain.check)
    if (failures.length > 0) {
      return refusal(
        "stage 3 (recheck: worktree identity, --out containment, bundle root)",
        failures,
        "leave --directory and --out untouched between the checks (materialize a fresh worktree with " +
          "bun run materialize-change --out <new directory> if it changed), and run the command again.",
        rootAgain.preexisting,
      )
    }
    console.log(`  PASS  \`${directory}\` is still exactly the sealed labelled change`)
    prepared = { pin: flags.pin, directory, out, server: flags.server, wiring, roster, warnings }
  } finally {
    signals.off("SIGINT", preflightInterrupt)
    signals.off("SIGTERM", preflightInterrupt)
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
  }

  // ---- STAGE 4: schedule, then the three blocks ----
  console.log("\nbun run paired — stage 4 of 4: createSchedule, then runPairedBlocks")
  const { directory, out, wiring, roster, warnings } = prepared
  // SIGINT/SIGTERM during the run: abort through the runner's signal, which keeps every piece of evidence.
  const runInterrupt = (): void => {
    console.log("\nINTERRUPTED — aborting the run through its signal; the evidence written so far is kept.")
    controller.abort(new Error("the operator interrupted the run"))
  }
  signals.on("SIGINT", runInterrupt)
  signals.on("SIGTERM", runInterrupt)
  try {
    return await stageFour()
  } catch (error) {
    const started = (await presence(join(out, START_MARKER_FILE))) === "present"
    console.log(
      `\nINCOMPLETE — stage 4 threw: ${messageOf(error)}\n` +
        (started
          ? `The start marker exists, so the schedule is spent and its evidence is kept. Read it: bun run eval-read --bundle ${out}\n`
          : "No start marker exists, so nothing was billed.\n") +
        unresolved.map((fact) => `BLAME CLEANUP UNCONFIRMED: check process ${fact.pid} by hand (${fact.operation}: ${fact.why}).\n`).join("") +
        "Next step: keep the bundle root as it is and start any new evaluation from a new bundle root.",
    )
    return 1
  } finally {
    signals.off("SIGINT", runInterrupt)
    signals.off("SIGTERM", runInterrupt)
  }

  async function stageFour(): Promise<number> {
    // MAD's own revision, read through the same bounded runner in this repository;
    // `codeRevisionFrom` turns every failure, a non-returned git included, into an explicit unknown.
    let codeRevision: Maybe<CodeRevision>
    try {
      codeRevision = await (overrides.codeRevision ?? (() => codeRevisionFrom((_command, args) => git(REPO_ROOT, args))))()
    } catch (error) {
      codeRevision = unknownValue(`the code revision could not be read: ${messageOf(error)}`)
    }
    const config: PairedConfig = { provenance: "live", tools: toolsIdentity(wiring) }
    const base = {
      bundleRoot: out,
      protocolFile: PROTOCOL_FILE,
      fixture: LABELLED_CHANGE_SEAL,
      codeRevision,
      roster,
      change: SEEDED_CHANGE,
      config,
    }
    const created = await runner.createSchedule({
      ...base,
      createdAt: clock.now(),
      ...(overrides.coin === undefined ? {} : { coin: overrides.coin }),
    })
    if (!created.ok) {
      console.log(`\nREFUSED by createSchedule: ${created.reason}\nNothing was billed. Next step: ${scheduleNextStep(created.reason)}`)
      return 1
    }
    console.log(`  schedule sealed at ${created.file} (coin ${created.schedule.coin}, first arms ${created.schedule.firstArms.join(", ")})`)

    const backendFor =
      overrides.backendFor ??
      ((_context: PairedPhaseContext, lateUsage: LateUsageReporter, resolved: Roster): ModelBackend =>
        new OpencodeModelBackend({
          serverUrl: prepared.server,
          directory,
          slots: [...resolved.slots, ...resolved.lensSlots],
          lateUsage,
        }))
    const outcome = await runner.runPairedBlocks({
      ...base,
      worktree: directory,
      priorWarnings: warnings,
      clock,
      tools: wiring.tools,
      signal: controller.signal,
      backendFor: (context, lateUsage) => backendFor(context, lateUsage, roster),
    })
    if (!outcome.ok) {
      console.log(
        `\nREFUSED by runPairedBlocks before its start marker: ${outcome.reason}\n` +
          `Nothing was billed. The sealed schedule stays at ${created.file} as evidence. Next step: fix the cause and ` +
          "start from a new bundle root.",
      )
      return 1
    }

    const flushed = await outcome.reconciliation.flush()
    console.log("\nSlots:")
    for (const slot of outcome.slots) {
      console.log(`  block ${slot.block} ${slot.arm.toUpperCase()} (${slot.position}): ${slot.status} — ${slot.reason}`)
    }
    const bill = outcome.bill
    console.log(`\nBill: ${bill.requests.length} request(s) journaled; halt: ${bill.halt ?? "none"}; stop: ${bill.stop ?? "none"}`)
    console.log(
      `Late usage flush: ${flushed.persisted} persisted, ${flushed.conflicts.length} conflict(s), ` +
        `${flushed.unmatched.length} unmatched${flushed.failed === null ? "" : `; failed: ${flushed.failed}`}`,
    )
    for (const warning of outcome.warnings) console.log(`warning: ${warning}`)
    for (const fact of unresolved) {
      console.log(`BLAME CLEANUP UNCONFIRMED: check process ${fact.pid} by hand (${fact.operation}: ${fact.why}).`)
    }
    console.log(
      (outcome.complete
        ? "\nThe runner's result reads `complete: true`: all six slots completed, with no halt, stop, or unknown or in-flight request.\n"
        : "\nThe run is INCOMPLETE (`complete: false`): every slot above names its reason, and the evidence is kept.\n") +
        "A change made to --directory during the run is not detected by this command.\n" +
        `Read it: bun run eval-read --bundle ${out}`,
    )
    return outcome.complete ? 0 : 1
  }
}


/**
 * Why the resolved roster is not the shipped default roster with `--pin` as its
 * pin: the pin did not fill a slot, or the roster is short of its slots.
 * `selectRoster` only warns about either; the launcher refuses.
 */
export function rosterProblemsFor(roster: Roster, warnings: readonly Warning[], pin: Pin): string[] {
  const problems: string[] = []
  const identity = normalizeModelIdentity(pin.modelId)
  const provider = pin.providerId.toLowerCase()
  const pinned = roster.slots.some(
    (slot) =>
      slot.identity === identity &&
      (slot.providerId.toLowerCase() === provider || slot.alsoAvailableVia.some((via) => via.toLowerCase() === provider)),
  )
  if (!pinned) problems.push(`the pinned model ${pin.providerId}/${pin.modelId} holds no slot in the resolved roster`)
  if (roster.slots.length < DEFAULT_DISCOVERY_SLOTS) {
    problems.push(`the roster holds ${roster.slots.length} of the ${DEFAULT_DISCOVERY_SLOTS} discovery slots it needs`)
  }
  for (const warning of warnings) {
    if (warning.code === "roster-pin-unhonoured" || warning.code === "roster-underfilled") {
      problems.push(`selectRoster warned ${warning.code}: ${warning.message}`)
    }
  }
  return problems
}

async function defaultCreateClient(init: { baseUrl: string; directory: string }): Promise<unknown> {
  const { createOpencodeClient } = await import("@opencode-ai/sdk/v2")
  return createOpencodeClient(init)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

if (import.meta.main) process.exit(await main())
