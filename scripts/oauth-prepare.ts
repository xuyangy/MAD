#!/usr/bin/env bun
/**
 * Story 2-8c3b — build the OAuth route's prepared directory.
 *
 *   bun run oauth-prepare --out /scratch/mad-oauth-prepared
 *
 * From the inputs committed under `ablation/oauth/` it writes:
 *
 * - `<out>/anthropic-auth/`: the committed `package.json` and `package-lock.json`,
 *   then `npm ci --ignore-scripts`;
 * - `<out>/config-seed/`: the same for the config-directory seed;
 * - `<out>/models.json`: the recorded catalogue.
 *
 * Each committed lock and the catalogue are checked against `OAUTH_PAYLOAD`
 * (`ablation/managed-host.ts`) before anything is installed, and both trees and the
 * catalogue are verified against the pinned digests after (`verifyPrepared`). This
 * is the one step of the OAuth route meant to reach the npm registry, and no auth
 * store is attached to it. npm runs with a clean environment (`npmEnvironment`):
 * this process's PATH, a private empty HOME and npm cache, empty user and global
 * config files, and the registry fixed to `NPM_REGISTRY`, so no `~/.npmrc` or
 * `npm_config_*` variable changes what is installed. No opencode directory is read
 * or written.
 *
 * `--out` must be absolute and empty or absent. Exit 0 when every digest matches
 * the pins; 1 otherwise, with the measured values printed so a re-measure can be
 * reviewed (`ablation/LIVE-RUN.md`, "The OAuth route").
 */

import { copyFile, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

import { OAUTH_PAYLOAD } from "../ablation/managed-host.ts"
import { sha256Of, verifyPrepared, type PayloadPins, type PreparedMeasure } from "../ablation/oauth-payload.ts"

const REPO_ROOT = resolve(import.meta.dir, "..")
/** The committed inputs. */
export const OAUTH_INPUTS = join(REPO_ROOT, "ablation", "oauth")

/** Runs one command in `cwd` with exactly `env`; the default is `Bun.spawn`. */
export type RunCommand = (cmd: string[], cwd: string, env: Record<string, string>) => Promise<{ exitCode: number; output: string }>

export const NPM_REGISTRY = "https://registry.npmjs.org/"

/**
 * The only environment npm runs with: PATH (to find npm and node), a private HOME
 * holding its own empty npm cache, empty user and global config files, and the
 * registry. Nothing else of this process's environment reaches it.
 */
export async function npmEnvironment(scratch: string, path: string | undefined): Promise<Record<string, string>> {
  const home = join(scratch, "home")
  await mkdir(home, { recursive: true })
  // Two files: npm refuses to load one file as both its user and its global config.
  const userConfig = join(scratch, "empty-user-npmrc")
  const globalConfig = join(scratch, "empty-global-npmrc")
  await writeFile(userConfig, "")
  await writeFile(globalConfig, "")
  return {
    PATH: path ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    npm_config_cache: join(home, ".npm"),
    npm_config_registry: NPM_REGISTRY,
  }
}

const runCommand: RunCommand = async (cmd, cwd, env) => {
  const child = Bun.spawn({ cmd, cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { exitCode, output: `${stdout}${stderr}`.trim() }
}

export const NPM_CI = ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"] as const

export type Prepared = { ok: true; measured: PreparedMeasure } | { ok: false; problems: string[]; measured?: PreparedMeasure }

/** Build and verify the prepared directory at `out`, which must be empty or absent. Never rejects. */
export async function prepareOAuthPayload(
  out: string,
  options: { pins?: PayloadPins; inputs?: string; run?: RunCommand } = {},
): Promise<Prepared> {
  const pins = options.pins ?? OAUTH_PAYLOAD
  const inputs = options.inputs ?? OAUTH_INPUTS
  const run = options.run ?? runCommand
  try {
    const existing = await lstat(out).catch(() => undefined)
    if (existing !== undefined && (!existing.isDirectory() || (await readdir(out)).length > 0)) {
      return { ok: false, problems: [`\`${out}\` exists and is not an empty directory; every prepared directory is built from nothing`] }
    }
    const problems: string[] = []
    for (const pin of [pins.anthropicAuth, pins.configSeed]) {
      const lock = await sha256Of(join(inputs, pin.dir, "package-lock.json"))
      if (lock !== pin.lockSha256) problems.push(`the committed \`${pin.dir}/package-lock.json\` has sha256 ${lock}; the pinned lock's is ${pin.lockSha256}`)
    }
    const catalogue = await sha256Of(join(inputs, pins.catalogue.file))
    if (catalogue !== pins.catalogue.sha256) problems.push(`the committed catalogue has sha256 ${catalogue}; the pinned catalogue's is ${pins.catalogue.sha256}`)
    if (problems.length > 0) return { ok: false, problems }

    await mkdir(out, { recursive: true })
    const scratch = await mkdtemp(join(tmpdir(), "mad-oauth-prepare-npm-"))
    try {
      const env = await npmEnvironment(scratch, process.env.PATH)
      for (const pin of [pins.anthropicAuth, pins.configSeed]) {
        const dir = join(out, pin.dir)
        await mkdir(dir)
        for (const file of ["package.json", "package-lock.json"]) await copyFile(join(inputs, pin.dir, file), join(dir, file))
        const installed = await run([...NPM_CI], dir, env)
        if (installed.exitCode !== 0) return { ok: false, problems: [`\`${NPM_CI.join(" ")}\` in \`${dir}\` exited ${installed.exitCode}: ${installed.output.slice(-600)}`] }
      }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
    await copyFile(join(inputs, pins.catalogue.file), join(out, pins.catalogue.file))
    const verified = await verifyPrepared(out, pins)
    return verified.ok ? { ok: true, measured: verified.measured } : { ok: false, problems: verified.problems, measured: verified.measured }
  } catch (error) {
    return { ok: false, problems: [`the prepared directory could not be built: ${error instanceof Error ? error.message : String(error)}`] }
  }
}

export function parsePrepareArgs(argv: readonly string[]): { ok: true; out: string } | { ok: false; reason: string } {
  const args = argv.slice(2)
  const at = args.findIndex((arg) => arg === "--out" || arg.startsWith("--out="))
  if (at < 0) return { ok: false, reason: "--out <absolute directory> is required" }
  const others = args.filter((_arg, index) => index !== at && !(index === at + 1 && !args[at]!.includes("=")))
  if (others.length > 0) return { ok: false, reason: `unexpected argument(s): ${others.join(" ")}. This command takes --out only.` }
  const value = args[at]!.includes("=") ? args[at]!.slice(args[at]!.indexOf("=") + 1) : args[at + 1]
  if (value === undefined || value.trim() === "" || !isAbsolute(value)) return { ok: false, reason: "--out needs an absolute directory" }
  return { ok: true, out: resolve(value) }
}

export async function main(argv: readonly string[] = Bun.argv, options: { run?: RunCommand; pins?: PayloadPins; inputs?: string } = {}): Promise<number> {
  const parsed = parsePrepareArgs(argv)
  if (!parsed.ok) {
    console.error(parsed.reason)
    return 1
  }
  console.log(`bun run oauth-prepare — building ${parsed.out} from ablation/oauth/`)
  const prepared = await prepareOAuthPayload(parsed.out, options)
  if (prepared.measured !== undefined) {
    const m = prepared.measured
    console.log(`  anthropic-auth: lock ${m.anthropicAuth.lockSha256}; tree digest ${m.anthropicAuth.treeDigest} (${m.anthropicAuth.entries} entries)`)
    console.log(`  config-seed:    lock ${m.configSeed.lockSha256}; tree digest ${m.configSeed.treeDigest} (${m.configSeed.entries} entries)`)
    console.log(`  models.json:    sha256 ${m.catalogueSha256}`)
  }
  if (!prepared.ok) {
    console.error(`\nREFUSED — the prepared directory does not match the pins in ablation/managed-host.ts (OAUTH_PAYLOAD):\n${prepared.problems.map((p) => `  - ${p}`).join("\n")}`)
    return 1
  }
  console.log(`\nEvery digest matches OAUTH_PAYLOAD. Pass it to the launcher as --oauth-prepared ${parsed.out}`)
  return 0
}

if (import.meta.main) process.exit(await main())
