/**
 * Story 2-8c3b — `bun run oauth-prepare`, with the install step injected: no test
 * here runs npm or reaches a registry.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { OAUTH_PAYLOAD } from "../ablation/managed-host.ts"
import { fakePrepared } from "../ablation/oauth-payload.fixture.ts"
import { sha256Of, treeDigest } from "../ablation/oauth-payload.ts"
import { main, NPM_CI, NPM_REGISTRY, OAUTH_INPUTS, parsePrepareArgs, prepareOAuthPayload, type RunCommand } from "./oauth-prepare.ts"

const scratch: string[] = []
afterEach(async () => {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-oauth-prepare-test-"))
  scratch.push(dir)
  return dir
}

/** An install that copies the fixture's node_modules into place, as `npm ci` would install them. */
function copyingInstall(source: string, calls: { cmd: string[]; cwd: string; env?: Record<string, string> }[]): RunCommand {
  return async (cmd, cwd, env) => {
    calls.push({ cmd, cwd, env })
    const tree = cwd.endsWith("anthropic-auth") ? "anthropic-auth" : "config-seed"
    await cp(join(source, tree, "node_modules"), join(cwd, "node_modules"), { recursive: true, verbatimSymlinks: true })
    return { exitCode: 0, output: "" }
  }
}

/** Committed inputs laid out as `ablation/oauth/`, taken from the fixture's prepared directory. */
async function inputsFrom(prepared: string, root: string): Promise<string> {
  const inputs = join(root, "inputs")
  for (const tree of ["anthropic-auth", "config-seed"]) {
    await mkdir(join(inputs, tree), { recursive: true })
    for (const file of ["package.json", "package-lock.json"]) await cp(join(prepared, tree, file), join(inputs, tree, file))
  }
  await cp(join(prepared, "models.json"), join(inputs, "models.json"))
  return inputs
}

describe("the committed inputs", () => {
  test("are byte-for-byte what the spike measured: both locks and the catalogue match OAUTH_PAYLOAD", async () => {
    expect(await sha256Of(join(OAUTH_INPUTS, "anthropic-auth", "package-lock.json"))).toBe(OAUTH_PAYLOAD.anthropicAuth.lockSha256)
    expect(await sha256Of(join(OAUTH_INPUTS, "config-seed", "package-lock.json"))).toBe(OAUTH_PAYLOAD.configSeed.lockSha256)
    expect(await sha256Of(join(OAUTH_INPUTS, "models.json"))).toBe(OAUTH_PAYLOAD.catalogue.sha256)
  })

  test("the plugin lock pins @ex-machina/opencode-anthropic-auth 1.8.1 at the recorded tarball integrity", async () => {
    const lock = JSON.parse(await readFile(join(OAUTH_INPUTS, "anthropic-auth", "package-lock.json"), "utf8")) as {
      packages: Record<string, { version?: string; integrity?: string }>
    }
    const entry = lock.packages["node_modules/@ex-machina/opencode-anthropic-auth"]!
    expect(entry.version).toBe("1.8.1")
    expect(entry.integrity).toBe(OAUTH_PAYLOAD.anthropicAuth.integrity)
    const seed = JSON.parse(await readFile(join(OAUTH_INPUTS, "config-seed", "package-lock.json"), "utf8")) as typeof lock
    expect(seed.packages["node_modules/@opencode-ai/plugin"]!.version).toBe("1.18.5")
  })

  test("the catalogue holds exactly openai, anthropic and github-copilot, with every roster model", async () => {
    const catalogue = JSON.parse(await readFile(join(OAUTH_INPUTS, "models.json"), "utf8")) as Record<string, { models: Record<string, unknown> }>
    expect(Object.keys(catalogue).sort()).toEqual(["anthropic", "github-copilot", "openai"])
    expect(Object.keys(catalogue.openai!.models)).toContain("gpt-6-luna")
    expect(Object.keys(catalogue.anthropic!.models)).toContain("claude-opus-5-5")
    expect(Object.keys(catalogue["github-copilot"]!.models)).toContain("gpt-5-mini")
  })
})

describe("prepareOAuthPayload", () => {
  test("installs each tree with npm ci --ignore-scripts, copies the catalogue, and verifies against the pins", async () => {
    const root = await temp()
    const { prepared: source, pins } = await fakePrepared(root)
    const calls: { cmd: string[]; cwd: string; env?: Record<string, string> }[] = []
    const out = join(root, "out")
    const result = await prepareOAuthPayload(out, { pins, inputs: await inputsFrom(source, root), run: copyingInstall(source, calls) })
    expect(result.ok).toBe(true)
    expect(calls.map(({ cmd, cwd }) => ({ cmd, cwd }))).toEqual([
      { cmd: [...NPM_CI], cwd: join(out, "anthropic-auth") },
      { cmd: [...NPM_CI], cwd: join(out, "config-seed") },
    ])
    expect(NPM_CI).toContain("--ignore-scripts")
    // npm sees only a clean environment: no ~/.npmrc, no npm_config_* of the caller, a fixed registry.
    const env = calls[0]!.env!
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH", "npm_config_cache", "npm_config_globalconfig", "npm_config_registry", "npm_config_userconfig"])
    expect(env.npm_config_registry).toBe(NPM_REGISTRY)
    expect(env.HOME).not.toBe(process.env.HOME)
    expect(env.npm_config_userconfig).not.toBe(env.npm_config_globalconfig)
  })

  test("a committed lock that differs from its pin refuses before anything is installed", async () => {
    const root = await temp()
    const { prepared: source, pins } = await fakePrepared(root)
    const inputs = await inputsFrom(source, root)
    await writeFile(join(inputs, "config-seed", "package-lock.json"), "{}")
    const calls: { cmd: string[]; cwd: string }[] = []
    const result = await prepareOAuthPayload(join(root, "out"), { pins, inputs, run: copyingInstall(source, calls) })
    expect(result.ok ? [] : result.problems).toEqual([expect.stringContaining("the committed `config-seed/package-lock.json` has sha256")])
    expect(calls).toEqual([])
  })

  test("an install whose files differ from the pinned tree fails on the digest", async () => {
    const root = await temp()
    const { prepared: source, pins } = await fakePrepared(root)
    await writeFile(join(source, "config-seed", "node_modules", "@opencode-ai", "plugin", "package.json"), '{"version":"9.9.9"}\n')
    const result = await prepareOAuthPayload(join(root, "out"), { pins, inputs: await inputsFrom(source, root), run: copyingInstall(source, []) })
    expect(result.ok ? "" : result.problems.join("\n")).toContain("the config-directory seed: the tree digest")
  })

  test("a non-empty --out and a failed install are refused", async () => {
    const root = await temp()
    const { prepared: source, pins } = await fakePrepared(root)
    const inputs = await inputsFrom(source, root)
    const busy = join(root, "busy")
    await mkdir(busy)
    await writeFile(join(busy, "x"), "x")
    const refused = await prepareOAuthPayload(busy, { pins, inputs, run: copyingInstall(source, []) })
    expect(refused.ok ? "" : refused.problems[0]).toContain("is not an empty directory")
    const failing: RunCommand = async () => ({ exitCode: 1, output: "npm ERR! network" })
    const failed = await prepareOAuthPayload(join(root, "out"), { pins, inputs, run: failing })
    expect(failed.ok ? "" : failed.problems[0]).toContain("exited 1: npm ERR! network")
  })
})

describe("the command", () => {
  test("takes --out only, as an absolute path", () => {
    expect(parsePrepareArgs(["bun", "x"])).toEqual({ ok: false, reason: "--out <absolute directory> is required" })
    expect(parsePrepareArgs(["bun", "x", "--out", "rel"])).toEqual({ ok: false, reason: "--out needs an absolute directory" })
    expect(parsePrepareArgs(["bun", "x", "--out", "/a", "--x"])).toEqual({ ok: false, reason: "unexpected argument(s): --x. This command takes --out only." })
    expect(parsePrepareArgs(["bun", "x", "--out=/a/b"])).toEqual({ ok: true, out: "/a/b" })
  })

  async function captured(run: () => Promise<number>): Promise<{ code: number; text: string }> {
    const lines: string[] = []
    const original = { log: console.log, error: console.error }
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "))
    console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "))
    try {
      return { code: await run(), text: lines.join("\n") }
    } finally {
      console.log = original.log
      console.error = original.error
    }
  }

  test("exits 1 and prints the measured values when a digest does not match", async () => {
    const root = await temp()
    const { prepared: source } = await fakePrepared(root)
    // The shipped pins and committed inputs: the fixture's trees are not the real payloads, so the digests differ.
    const out = join(root, "out")
    const result = await captured(() => main(["bun", "x", "--out", out], { run: copyingInstall(source, []) }))
    expect(result.code).toBe(1)
    const measured = async (tree: string) => {
      const digest = await treeDigest(join(out, tree))
      return digest.ok ? digest.digest : digest.reason
    }
    expect(result.text).toContain(`anthropic-auth: lock ${OAUTH_PAYLOAD.anthropicAuth.lockSha256}; tree digest ${await measured("anthropic-auth")}`)
    expect(result.text).toContain(`config-seed:    lock ${OAUTH_PAYLOAD.configSeed.lockSha256}; tree digest ${await measured("config-seed")}`)
    expect(result.text).toContain("REFUSED — the prepared directory does not match the pins")
  })

  test("exits 0 when every digest matches the pins", async () => {
    const root = await temp()
    const { prepared: source, pins } = await fakePrepared(root)
    const inputs = await inputsFrom(source, root)
    const result = await captured(() => main(["bun", "x", "--out", join(root, "out")], { run: copyingInstall(source, []), pins, inputs }))
    expect(result.code, result.text).toBe(0)
    expect(result.text).toContain("Every digest matches OAUTH_PAYLOAD")
  })
})
