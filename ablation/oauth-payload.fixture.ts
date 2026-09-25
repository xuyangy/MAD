/**
 * Story 2-8c3b — test fixtures for the OAuth route: a tiny prepared directory with
 * pins measured from it, and a data directory whose auth link points into a
 * temporary home. Nothing here touches the user's opencode directories.
 */

import { chmod, mkdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { authLinkPaths, sha256Of, treeDigest, type PayloadPins } from "./oauth-payload.ts"

async function put(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, text, "utf8")
}

/** A prepared directory under `root` shaped as `bun run oauth-prepare` builds one, and the pins it measures as. */
export async function fakePrepared(root: string): Promise<{ prepared: string; pins: PayloadPins }> {
  const prepared = join(root, "prepared")
  const plugin = join(prepared, "anthropic-auth")
  await put(join(plugin, "package.json"), '{"dependencies":{"@ex-machina/opencode-anthropic-auth":"1.8.1"}}\n')
  await put(join(plugin, "package-lock.json"), '{"lockfileVersion":3,"fake":"anthropic-auth"}\n')
  await put(join(plugin, "node_modules", "@ex-machina", "opencode-anthropic-auth", "package.json"), '{"name":"@ex-machina/opencode-anthropic-auth","version":"1.8.1"}\n')
  await put(join(plugin, "node_modules", "@ex-machina", "opencode-anthropic-auth", "dist", "index.js"), "export const AnthropicAuthPlugin = 1\n")
  await put(join(plugin, "node_modules", "tool", "cli.js"), "#!/usr/bin/env node\n")
  await chmod(join(plugin, "node_modules", "tool", "cli.js"), 0o755)
  await mkdir(join(plugin, "node_modules", ".bin"), { recursive: true })
  await symlink("../tool/cli.js", join(plugin, "node_modules", ".bin", "tool"))
  const seed = join(prepared, "config-seed")
  await put(join(seed, "package.json"), '{"dependencies":{"@opencode-ai/plugin":"1.18.5"}}\n')
  await put(join(seed, "package-lock.json"), '{"lockfileVersion":3,"fake":"config-seed"}\n')
  await put(join(seed, "node_modules", "@opencode-ai", "plugin", "package.json"), '{"name":"@opencode-ai/plugin","version":"1.18.5"}\n')
  await put(join(prepared, "models.json"), '{"anthropic":{},"github-copilot":{},"openai":{}}\n')
  const digest = async (dir: string) => {
    const measured = await treeDigest(dir)
    if (!measured.ok) throw new Error(measured.reason)
    return measured.digest
  }
  const pins: PayloadPins = {
    anthropicAuth: { dir: "anthropic-auth", lockSha256: await sha256Of(join(plugin, "package-lock.json")), treeDigest: await digest(plugin) },
    configSeed: { dir: "config-seed", lockSha256: await sha256Of(join(seed, "package-lock.json")), treeDigest: await digest(seed) },
    catalogue: { file: "models.json", sha256: await sha256Of(join(prepared, "models.json")) },
  }
  return { prepared, pins }
}

/** A marker a test looks for: the placeholder file holds it, and no output may. */
export const AUTH_CONTENT_MARKER = "mad-test-auth-content-never-printed"

/** A data directory under `root` whose `opencode/auth.json` links to a file in a temporary home. */
export async function fakeAuthLink(root: string): Promise<{ dataDir: string; home: string; link: string; target: string }> {
  const home = join(root, "home")
  const dataDir = join(root, "data")
  const { link, target } = authLinkPaths(dataDir, home)
  await put(target, `{"marker":"${AUTH_CONTENT_MARKER}"}\n`)
  await mkdir(join(link, ".."), { recursive: true })
  await symlink(target, link)
  return { dataDir, home, link, target }
}
