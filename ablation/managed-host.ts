/**
 * Story 2-8c — the managed opencode host: the one module that starts, verifies
 * and stops `opencode serve` for the accounting probe and the paired launcher.
 *
 * ## Why MAD starts its own host
 *
 * A host reached through a URL is whatever happens to be listening there: any
 * build, any plugin, any provider, any config. The request-accounting facts in
 * `ablation/evidence/host-accounting-2026-09-24.json` were measured on ONE build
 * with ONE shape of config, and they say nothing about another. So the host is
 * started here, from a config generated here, and refused before any client
 * call unless it is that build running that config.
 *
 * ## What is fixed and what may vary
 *
 * The effective config is `FIXED_HOST_SETTINGS` plus exactly one provider block.
 * The block always uses `@ai-sdk/openai-compatible`. Only its `baseURL`, the
 * NAME of the environment variable holding its credential, and its model ids
 * vary. The credential reaches the host as `{env:NAME}` in the config and as that
 * one variable in the host's environment, never on its command line.
 *
 * ## Isolation
 *
 * The host's environment is built from nothing, as `env -i` would: a fixed
 * system `PATH`, `HOME` and the four XDG directories in private temporary
 * directories, `OPENCODE_CONFIG`, `OPENCODE_DISABLE_MODELS_FETCH=1`,
 * `OPENCODE_DISABLE_PROJECT_CONFIG=1`, the credential variable, and — when the
 * caller names one — HTTP(S)_PROXY with `NO_PROXY=127.0.0.1`. Nothing else from
 * this process's environment reaches it.
 *
 * NOT OFFLINE. The first time the host runs a prompt it tries
 * `npm install @opencode-ai/plugin` into its config directory, whatever its
 * config says. With a refusing proxy that attempt is refused and listed; without
 * one it reaches the registry. `ManagedHost.pluginInstall()` reads what it left.
 *
 * ## Verification, before any client call
 *
 * - **The build.** The sha256 of the resolved binary (the real path that is also
 *   the one spawned) equals `MEASURED_HOST`'s before anything is spawned, so an
 *   unmeasured binary never runs with the credential; the version the host then
 *   reports on `/global/health` equals it too.
 * - **The config.** `GET /config`, for the host's own directory and for every
 *   directory the caller names, has an empty `plugin` list, exactly one provider
 *   (the generated block), and every other key equal to the generated config,
 *   allowing only the defaults the host adds itself (`HOST_DEFAULTS`).
 * - **The provider registry.** `GET /config/providers`, which the roster is read
 *   from, for the host's own directory and for every directory the caller names,
 *   lists exactly the one provider, with exactly the block's models, each
 *   implemented by `@ai-sdk/openai-compatible`. A block whose id is also a
 *   built-in provider's is caught here, not by `GET /config`.
 *
 * Every request is bounded. A refusal names what differed and the host is
 * stopped. Nothing here rejects: every failure is `ok: false` with its reason.
 *
 * ## Redaction
 *
 * `GET /config` echoes the resolved credential in plain text. The config is
 * redacted before it is recorded, every value is redacted before it is turned
 * into text, and every message this module returns is redacted with both the
 * credential and its JSON-escaped form.
 *
 * AD-1: this tree may import from `core/`; nothing under `core/` imports it.
 */

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * The opencode build the accounting probe measured. The managed host refuses any
 * other. It binds the launcher to this one machine's binary: another install of
 * the same version has another hash until it is re-measured (`ablation/LIVE-RUN.md`,
 * "Re-measuring"). Set from `ablation/evidence/host-accounting-2026-09-24-relay.json`, the
 * probe's run through the relay (story 2-8c2), taken on the same build as story 2-8c's.
 */
export const MEASURED_HOST = {
  version: "1.18.32",
  sha256: "5c944e90c2b3ac6bf6c9425b40b670b9950a0d4a3c0e6775470b93afc6c3dd6e",
  evidence: "ablation/evidence/host-accounting-2026-09-24-relay.json",
} as const

/** The one provider package the managed host accepts. */
export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible"

/** What the caller may vary: the provider id, its URL, its credential's variable name and its models. */
export interface ProviderBlock {
  id: string
  /** Must be `OPENAI_COMPATIBLE_NPM`; anything else is refused. */
  npm: string
  baseURL: string
  /** The NAME of the environment variable that holds the credential. */
  apiKeyEnv: string
  models: readonly string[]
}

/** Every setting of the effective config that does not depend on the provider block. */
export const FIXED_HOST_SETTINGS = {
  $schema: "https://opencode.ai/config.json",
  autoupdate: false,
  share: "disabled",
  plugin: [],
} as const

/**
 * Keys the host adds to `GET /config` on its own, with the value each must have.
 * `username` is the host's reading of the (empty) environment, any string.
 */
const HOST_DEFAULTS: Record<string, (value: unknown) => boolean> = {
  command: (value) => isEmptyObject(value),
  mode: (value) => isEmptyObject(value),
  agent: (value) => isEmptyObject(value),
  username: (value) => typeof value === "string",
}

/** Variables the managed host sets itself; a credential variable may not share a name with one. */
const RESERVED_VARIABLES = new Set(
  ["PATH", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"].map(
    (name) => name.toUpperCase(),
  ),
)

/**
 * Prefixes of variables that configure how the host, its runtime or its `npm install`
 * child runs, or where it connects. A credential under one of these names would be
 * read as configuration.
 */
const RUNTIME_VARIABLE = /^(NODE_|BUN_|NPM_CONFIG_|LD_|DYLD_|SSL_CERT_|ALL_PROXY$)/

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"])

export const REDACTED = "[REDACTED]"

/** Why the block cannot be used, one reason each; empty when it can. */
export function providerBlockProblems(block: ProviderBlock): string[] {
  const problems: string[] = []
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(block.id)) {
    problems.push(`the provider id \`${block.id}\` is not a plain identifier (letters, digits, \`-\` and \`_\`)`)
  }
  if (block.npm !== OPENAI_COMPATIBLE_NPM) {
    problems.push(
      `the provider package is \`${block.npm}\`; the managed host accepts only \`${OPENAI_COMPATIBLE_NPM}\`, the ` +
        "package its request accounting was measured with",
    )
  }
  let url: URL | undefined
  try {
    url = new URL(block.baseURL)
  } catch {
    url = undefined
  }
  if (url === undefined || (url.protocol !== "http:" && url.protocol !== "https:")) {
    problems.push(`the provider URL \`${block.baseURL}\` is not an http(s) URL`)
  } else {
    if (url.username !== "" || url.password !== "") {
      problems.push("the provider URL carries a user name or password; pass the credential by its environment variable")
    }
    if (url.search !== "" || url.hash !== "" || block.baseURL.includes("?") || block.baseURL.includes("#")) {
      problems.push("the provider URL carries a query string or a fragment")
    }
    if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
      problems.push(`the provider URL uses plain http to \`${url.hostname}\`; plain http is allowed only to 127.0.0.1, ::1 or localhost`)
    }
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(block.apiKeyEnv)) {
    problems.push(`the credential variable name \`${block.apiKeyEnv}\` is not an environment variable name`)
  } else if (RESERVED_VARIABLES.has(block.apiKeyEnv.toUpperCase()) || block.apiKeyEnv.toUpperCase().startsWith("OPENCODE_")) {
    problems.push(`the credential variable name \`${block.apiKeyEnv}\` is one the managed host sets itself`)
  } else if (RUNTIME_VARIABLE.test(block.apiKeyEnv.toUpperCase())) {
    problems.push(`the credential variable name \`${block.apiKeyEnv}\` is one that configures the host's runtime or its connections`)
  }
  if (block.models.length === 0) problems.push("the provider block names no model")
  const seen = new Set<string>()
  for (const model of block.models) {
    if (model.trim().length === 0 || model !== model.trim()) problems.push(`the model id ${JSON.stringify(model)} is blank or padded`)
    else if (model.includes("/")) problems.push(`the model id \`${model}\` contains \`/\`, which the host reads as a provider separator`)
    else if (seen.has(model)) problems.push(`the model id \`${model}\` is named twice`)
    seen.add(model)
  }
  return problems
}

/**
 * The whole effective config: the fixed settings plus the one provider block.
 *
 * `model` and `small_model` both name the block's first model. Neither chooses a
 * model for any MAD request: every session MAD creates carries a title (so no
 * title turn runs) and every prompt names its model. They are set so that the
 * config is fully determined rather than left to a host default.
 */
export function hostConfig(block: ProviderBlock): Record<string, unknown> {
  const first = `${block.id}/${block.models[0]}`
  return {
    ...FIXED_HOST_SETTINGS,
    enabled_providers: [block.id],
    model: first,
    small_model: first,
    provider: {
      [block.id]: {
        npm: OPENAI_COMPATIBLE_NPM,
        name: block.id,
        options: { baseURL: block.baseURL, apiKey: `{env:${block.apiKeyEnv}}` },
        models: Object.fromEntries(block.models.map((model) => [model, { name: model }])),
      },
    },
  }
}

/** A secret and the forms it takes inside JSON text, so an escaped copy is redacted too. */
export function secretForms(secret: string): string[] {
  if (secret.length === 0) return []
  const escaped = JSON.stringify(secret).slice(1, -1)
  const twice = JSON.stringify(escaped).slice(1, -1)
  return [...new Set([secret, escaped, twice])]
}

/** `text` with every occurrence of every non-empty secret replaced by `[REDACTED]`. */
export function redactText(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of [...secrets].filter((value) => value.length > 0).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join(REDACTED)
  }
  return out
}

/**
 * A value as it may be recorded: every `apiKey` is replaced whatever its value,
 * and any other string containing a secret is redacted too.
 */
export function redactConfig(config: unknown, secrets: readonly string[]): unknown {
  const walk = (value: unknown, key: string | undefined): unknown => {
    if (typeof value === "string") return key === "apiKey" ? REDACTED : redactText(value, secrets)
    if (Array.isArray(value)) return value.map((item) => walk(item, undefined))
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [redactText(k, secrets), walk(v, k)]))
    }
    return value
  }
  return walk(config, undefined)
}

/**
 * Every way `GET /config` differs from the generated config, one sentence each.
 * The credential is not compared by value: the host echoes it resolved, and a
 * difference sentence would carry it. Every value is redacted with `secrets`
 * before it is written into a sentence.
 */
export function configDrift(reported: unknown, generated: Record<string, unknown>, block: ProviderBlock, secrets: readonly string[] = []): string[] {
  const describe = (value: unknown) => describeValue(value, secrets)
  if (reported === null || typeof reported !== "object" || Array.isArray(reported)) {
    return ["`GET /config` did not return an object"]
  }
  const actual = reported as Record<string, unknown>
  const problems: string[] = []
  const plugins = actual.plugin
  if (!Array.isArray(plugins) || plugins.length > 0) {
    problems.push(`\`plugin\` is ${describe(plugins)}; the managed host loads no plugin, so it must be an empty list`)
  }
  const providers = actual.provider
  if (providers === null || typeof providers !== "object" || Array.isArray(providers)) {
    problems.push(`\`provider\` is ${describe(providers)}, not one provider block`)
  } else {
    const ids = Object.keys(providers)
    if (ids.length !== 1 || ids[0] !== block.id) {
      problems.push(
        `\`provider\` holds ${ids.length === 0 ? "no provider" : ids.map((id) => `\`${redactText(id, secrets)}\``).join(", ")}; ` +
          `exactly one, \`${block.id}\`, is allowed`,
      )
    }
    const entry = (providers as Record<string, unknown>)[block.id]
    if (entry !== undefined) problems.push(...providerDrift(entry, block, describe))
  }
  for (const key of Object.keys(generated)) {
    if (key === "provider" || key === "plugin") continue
    if (!(key in actual)) problems.push(`\`${key}\` is missing; the generated config sets it to ${describe(generated[key])}`)
    else if (!sameJson(actual[key], generated[key])) {
      problems.push(`\`${key}\` is ${describe(actual[key])}; the generated config sets ${describe(generated[key])}`)
    }
  }
  for (const key of Object.keys(actual)) {
    if (key in generated) continue
    const allowed = HOST_DEFAULTS[key]
    const name = redactText(key, secrets)
    if (allowed === undefined) problems.push(`\`${name}\` is set to ${describe(actual[key])}, and the generated config does not set it`)
    else if (!allowed(actual[key])) problems.push(`\`${name}\` is ${describe(actual[key])}, not the host's own default`)
  }
  return problems
}

function providerDrift(entry: unknown, block: ProviderBlock, describe: (value: unknown) => string): string[] {
  if (entry === null || typeof entry !== "object") return [`provider \`${block.id}\` is ${describe(entry)}`]
  const provider = entry as Record<string, unknown>
  const problems: string[] = []
  const where = `provider \`${block.id}\``
  if (provider.npm !== OPENAI_COMPATIBLE_NPM) problems.push(`${where} uses ${describe(provider.npm)}, not \`${OPENAI_COMPATIBLE_NPM}\``)
  const allowedKeys = new Set(["npm", "name", "options", "models"])
  for (const key of Object.keys(provider)) {
    if (!allowedKeys.has(key)) problems.push(`${where} sets ${describe(key)}, which the generated block does not`)
  }
  if (provider.name !== block.id) problems.push(`${where} is named ${describe(provider.name)}, not \`${block.id}\``)
  const options = provider.options as Record<string, unknown> | undefined
  if (options === null || typeof options !== "object") problems.push(`${where} has no options`)
  else {
    const keys = Object.keys(options).sort()
    if (!sameJson(keys, ["apiKey", "baseURL"])) {
      problems.push(`${where}'s options hold ${keys.map((key) => describe(key)).join(", ")}; only \`apiKey\` and \`baseURL\` are allowed`)
    }
    if (options.baseURL !== block.baseURL) problems.push(`${where}'s baseURL is ${describe(options.baseURL)}, not \`${block.baseURL}\``)
    if (typeof options.apiKey !== "string" || options.apiKey.length === 0) problems.push(`${where} carries no credential`)
  }
  const models = provider.models as Record<string, unknown> | undefined
  const expected = Object.fromEntries(block.models.map((model) => [model, { name: model }]))
  if (!sameJson(models, expected)) {
    const listed = models === null || typeof models !== "object" ? models : Object.keys(models)
    problems.push(`${where}'s models are ${describe(listed)}; the block names ${describe([...block.models])}`)
  }
  return problems
}

/**
 * Every way `GET /config/providers` differs from the one block: the registry the
 * roster is read from must list exactly that provider, exactly its models, and
 * each model implemented by `@ai-sdk/openai-compatible`.
 */
export function providerRegistryDrift(reported: unknown, block: ProviderBlock, secrets: readonly string[] = []): string[] {
  const describe = (value: unknown) => describeValue(value, secrets)
  const body = reported as { providers?: unknown } | null
  if (body === null || typeof body !== "object" || !Array.isArray(body.providers)) {
    return ["`GET /config/providers` did not return a provider list"]
  }
  const providers = body.providers as { id?: unknown; models?: unknown }[]
  const problems: string[] = []
  const ids = providers.map((provider) => (provider !== null && typeof provider === "object" ? provider.id : undefined))
  if (providers.length !== 1 || ids[0] !== block.id) {
    problems.push(`the provider registry lists ${describe(ids)}; exactly one provider, \`${block.id}\`, is allowed`)
  }
  const provider = providers.find((entry) => entry !== null && typeof entry === "object" && entry.id === block.id)
  if (provider !== undefined) {
    const models = (provider.models ?? {}) as Record<string, { api?: { npm?: unknown } } | null>
    const listed = Object.keys(models).sort()
    if (!sameJson(listed, [...block.models].sort())) {
      problems.push(`the registry's \`${block.id}\` offers ${describe(listed)}; the block names ${describe([...block.models].sort())}`)
    }
    for (const [id, model] of Object.entries(models)) {
      const npm = model?.api?.npm
      if (npm !== OPENAI_COMPATIBLE_NPM) {
        problems.push(`the registry's model \`${redactText(id, secrets)}\` is implemented by ${describe(npm)}, not \`${OPENAI_COMPATIBLE_NPM}\``)
      }
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// The process
// ---------------------------------------------------------------------------

/** The subprocess surface this module uses. `Bun.spawn`'s return satisfies it. */
export interface HostChild {
  readonly pid: number
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  kill(signal?: number | NodeJS.Signals): void
}

export type SpawnHost = (request: { cmd: string[]; cwd: string; env: Record<string, string> }) => HostChild

/** The default spawn: no standard input, piped output, and exactly the environment given. */
export const spawnHost: SpawnHost = (request) =>
  Bun.spawn({
    cmd: request.cmd,
    cwd: request.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: request.env,
  }) as unknown as HostChild

/** How a signal is listened for. The default is `process`. */
export interface SignalSource {
  on(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown
  off(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown
}

export interface ManagedHostOptions {
  block: ProviderBlock
  /** The credential's value. It reaches the host only as the `block.apiKeyEnv` variable. */
  credential: string
  /** A proxy for HTTP(S)_PROXY, with `NO_PROXY=127.0.0.1`. Absent, no proxy variable is set. */
  proxy?: string
  /**
   * Directories whose `GET /config` and `GET /config/providers` are verified too, besides the host's own: the
   * directories the caller's sessions will use.
   */
  verifyDirectories?: readonly string[]
  /**
   * Called once, immediately after the process is spawned and before any check,
   * with the `stop` the returned host will carry. A caller that handles signals
   * itself uses it to stop a host that is still starting.
   */
  onSpawn?: (host: { pid: number; stop(): Promise<StopOutcome> }) => void
  /** The opencode binary; defaults to `opencode` on this process's PATH. Either way its real path is hashed and spawned. */
  binary?: string
  spawn?: SpawnHost
  fetch?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>
  /** The sha256 of a file, as lowercase hex. */
  hashFile?: (path: string) => Promise<string>
  /** Resolves a binary path to the real path that is hashed and spawned. Defaults to `realpath`. */
  resolveBinary?: (path: string) => Promise<string>
  /** Where the private directories are created. Defaults to the system temp directory. */
  scratchParent?: string
  /** The build the host must be. Defaults to `MEASURED_HOST`. */
  measured?: { version: string; sha256: string }
  /** How long the host may take to print its listening line. */
  startupMs?: number
  /** How long each verification request may take. */
  requestMs?: number
  /** How long each of SIGTERM and SIGKILL is given to be confirmed. */
  stopMs?: number
  /**
   * Where SIGINT and SIGTERM are listened for while the host runs: each stops the
   * host, confirms it exited, then calls `exit(130)`. `null` installs no handler,
   * for a caller that handles the signals itself and stops the host on its way out.
   */
  signals?: SignalSource | null
  exit?: (code: number) => void
}

export type StopOutcome =
  | { confirmed: true; pid: number; how: string }
  | { confirmed: false; pid: number; why: string }

/** What the host's plugin install left in its config directory. */
export type PluginInstall =
  | { installed: true; version: string }
  | { installed: false; why: string }

export interface ManagedHost {
  url: string
  pid: number
  binary: string
  sha256: string
  version: string
  /** The generated config, which carries the credential's variable name and never its value. */
  config: Record<string, unknown>
  /** `GET /config` as the host reported it, redacted. */
  reportedConfig: unknown
  /** The names, never the values, of every variable in the host's environment. */
  environmentKeys: string[]
  /** Reads whether `@opencode-ai/plugin` is installed in the host's config directory, and its version. */
  pluginInstall(): Promise<PluginInstall>
  /** Stops the host and confirms it exited. Idempotent: a second call returns the first outcome. Never rejects. */
  stop(): Promise<StopOutcome>
}

export type ManagedHostStart =
  | { ok: true; host: ManagedHost }
  | { ok: false; reason: string; stopped: StopOutcome | null }

export const DEFAULT_STARTUP_MS = 30_000
export const DEFAULT_REQUEST_MS = 10_000
export const DEFAULT_STOP_MS = 5_000

/** The port must be followed by whitespace, so a line split across output chunks is never read short. */
const LISTENING = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)\s/

export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(await Bun.file(path).arrayBuffer())
  return hasher.digest("hex")
}

function defaultBinary(): string {
  const found = Bun.which("opencode")
  if (found === null) throw new Error("no `opencode` binary is on PATH")
  return found
}

/**
 * Start the managed host and verify it. On a refusal or a throw the host is
 * stopped and the private directories removed before this returns; on success
 * they live until `stop()`. It never rejects.
 */
export async function startManagedHost(options: ManagedHostOptions): Promise<ManagedHostStart> {
  const secrets = secretForms(options.credential)
  const redact = (text: string) => redactText(text, secrets)
  try {
    return await start(options, secrets, redact)
  } catch (error) {
    return { ok: false, reason: redact(`the managed host could not be started: ${messageOf(error)}`), stopped: null }
  }
}

async function start(options: ManagedHostOptions, secrets: string[], redact: (text: string) => string): Promise<ManagedHostStart> {
  const problems = providerBlockProblems(options.block)
  if (problems.length > 0) return { ok: false, reason: redact(`the provider block is refused: ${problems.join("; ")}`), stopped: null }
  const measured = options.measured ?? MEASURED_HOST
  const doFetch = options.fetch ?? ((url: string, init?: { signal?: AbortSignal }) => fetch(url, init))
  const stopMs = options.stopMs ?? DEFAULT_STOP_MS
  const requestMs = options.requestMs ?? DEFAULT_REQUEST_MS

  let binary: string
  let sha256: string
  try {
    binary = await (options.resolveBinary ?? realpath)(options.binary ?? defaultBinary())
    sha256 = await (options.hashFile ?? sha256File)(binary)
  } catch (error) {
    return { ok: false, reason: redact(`the opencode binary could not be identified: ${messageOf(error)}`), stopped: null }
  }
  // Refused before the spawn: an unmeasured binary never runs with the credential in its environment.
  if (sha256 !== measured.sha256) {
    return {
      ok: false,
      reason: redact(
        `the host is not the measured build (binary sha256 ${sha256}, version not read: the binary was not started; measured sha256 ` +
          `${measured.sha256}, version ${measured.version}): the binary \`${binary}\` has sha256 ${sha256}; the measured build's is ${measured.sha256}`,
      ),
      stopped: null,
    }
  }

  const root = await mkdtemp(join(options.scratchParent ?? tmpdir(), "mad-managed-host-"))
  const dirs = {
    home: join(root, "home"),
    config: join(root, "xdg-config"),
    data: join(root, "xdg-data"),
    cache: join(root, "xdg-cache"),
    state: join(root, "xdg-state"),
    cwd: join(root, "cwd"),
  }
  const removeRoot = () => rm(root, { recursive: true, force: true })
  let child: HostChild | undefined
  let stopping: Promise<StopOutcome> | undefined
  let signalHandler: (() => void) | undefined
  const signals = options.signals === undefined ? process : options.signals
  const exit = options.exit ?? ((code: number) => process.exit(code))

  const stop = (): Promise<StopOutcome> => {
    stopping ??= (async (): Promise<StopOutcome> => {
      if (signalHandler !== undefined && signals !== null) {
        signals.off("SIGINT", signalHandler)
        signals.off("SIGTERM", signalHandler)
      }
      let outcome: StopOutcome
      try {
        outcome = child === undefined ? { confirmed: true, pid: 0, how: "no host was started" } : await stopChild(child, stopMs)
      } catch (error) {
        outcome = { confirmed: false, pid: child?.pid ?? 0, why: redact(`the stop failed: ${messageOf(error)}`) }
      }
      await removeRoot().catch(() => undefined)
      return outcome
    })()
    return stopping
  }
  const refuse = async (reason: string): Promise<ManagedHostStart> => {
    const stopped = await stop()
    return { ok: false, reason: redact(reason), stopped }
  }

  try {
    for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true, mode: 0o700 })
    const config = hostConfig(options.block)
    const configFile = join(root, "opencode.json")
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    const env: Record<string, string> = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: dirs.home,
      XDG_CONFIG_HOME: dirs.config,
      XDG_DATA_HOME: dirs.data,
      XDG_CACHE_HOME: dirs.cache,
      XDG_STATE_HOME: dirs.state,
      OPENCODE_CONFIG: configFile,
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      [options.block.apiKeyEnv]: options.credential,
      ...(options.proxy === undefined
        ? {}
        : {
            HTTP_PROXY: options.proxy,
            HTTPS_PROXY: options.proxy,
            http_proxy: options.proxy,
            https_proxy: options.proxy,
            NO_PROXY: "127.0.0.1",
            no_proxy: "127.0.0.1",
          }),
    }

    child = (options.spawn ?? spawnHost)({
      cmd: [binary, "serve", "--hostname", "127.0.0.1", "--port", "0"],
      cwd: dirs.cwd,
      env,
    })
    options.onSpawn?.({ pid: child.pid, stop })
    if (signals !== null) {
      signalHandler = () => {
        void stop().then((outcome) => {
          console.error(
            outcome.confirmed
              ? `\nINTERRUPTED — the managed host (process ${outcome.pid}) was stopped: ${outcome.how}.`
              : `\nINTERRUPTED — the managed host's exit is UNCONFIRMED: check process ${outcome.pid} by hand (${outcome.why}).`,
          )
          exit(130)
        })
      }
      signals.on("SIGINT", signalHandler)
      signals.on("SIGTERM", signalHandler)
    }

    const stderr = drain(child.stderr)
    const listening = await listeningUrl(child, options.startupMs ?? DEFAULT_STARTUP_MS)
    if (!listening.ok) return await refuse(`${listening.why}; the host's stderr ended with: ${tail(await stderr.soFar(), secrets)}`)
    const url = listening.url
    if (stopping !== undefined) return await refuse("the host was stopped while it was starting")

    const health = await readJson(doFetch, `${url}/global/health`, requestMs)
    const version = health.ok && typeof (health.value as { version?: unknown })?.version === "string" ? (health.value as { version: string }).version : undefined
    const buildProblems: string[] = []
    if (sha256 !== measured.sha256) buildProblems.push(`the binary \`${binary}\` has sha256 ${sha256}; the measured build's is ${measured.sha256}`)
    if (version !== measured.version) {
      buildProblems.push(
        `the host reports version ${version ?? `nothing readable (${health.ok ? "no version field" : health.why})`}; the measured build is ${measured.version}`,
      )
    }
    if (buildProblems.length > 0) {
      return await refuse(
        `the host is not the measured build (binary sha256 ${sha256}, version ${version ?? "unknown"}; measured sha256 ` +
          `${measured.sha256}, version ${measured.version}): ${buildProblems.join("; ")}`,
      )
    }

    let reportedConfig: unknown
    for (const directory of [dirs.cwd, ...(options.verifyDirectories ?? [])]) {
      const reported = await readJson(doFetch, `${url}/config?directory=${encodeURIComponent(directory)}`, requestMs)
      if (!reported.ok) return await refuse(`\`GET /config\` for \`${directory}\` could not be read: ${reported.why}`)
      const drift = configDrift(reported.value, config, options.block, secrets)
      if (drift.length > 0) return await refuse(`the host's effective config for \`${directory}\` is not the generated one: ${drift.join("; ")}`)
      reportedConfig ??= reported.value
    }

    for (const directory of [dirs.cwd, ...(options.verifyDirectories ?? [])]) {
      const registry = await readJson(doFetch, `${url}/config/providers?directory=${encodeURIComponent(directory)}`, requestMs)
      if (!registry.ok) return await refuse(`\`GET /config/providers\` for \`${directory}\` could not be read: ${registry.why}`)
      const registryDrift = providerRegistryDrift(registry.value, options.block, secrets)
      if (registryDrift.length > 0) {
        return await refuse(`the host's provider registry for \`${directory}\` is not the one block: ${registryDrift.join("; ")}`)
      }
    }
    // A stop that arrived while the host was starting (through `onSpawn` or a signal) wins.
    if (stopping !== undefined) return await refuse("the host was stopped while it was starting")

    return {
      ok: true,
      host: {
        url,
        pid: child.pid,
        binary,
        sha256,
        version: version!,
        config,
        reportedConfig: redactConfig(reportedConfig, secrets),
        environmentKeys: Object.keys(env).sort(),
        pluginInstall: () => pluginInstallIn(dirs.config),
        stop,
      },
    }
  } catch (error) {
    return await refuse(`the managed host could not be started: ${messageOf(error)}`)
  }
}

/** What `npm install @opencode-ai/plugin` left under the host's config directory. */
async function pluginInstallIn(configHome: string): Promise<PluginInstall> {
  const file = join(configHome, "opencode", "node_modules", "@opencode-ai", "plugin", "package.json")
  try {
    const version = (JSON.parse(await readFile(file, "utf8")) as { version?: unknown }).version
    return typeof version === "string" ? { installed: true, version } : { installed: false, why: `\`${file}\` names no version` }
  } catch (error) {
    return {
      installed: false,
      why: (error as NodeJS.ErrnoException).code === "ENOENT" ? "no `@opencode-ai/plugin` is installed in the host's config directory" : messageOf(error),
    }
  }
}

/** SIGTERM, then SIGKILL, each given `stopMs` to be confirmed by the process's exit. */
async function stopChild(child: HostChild, stopMs: number): Promise<StopOutcome> {
  // A rejected `exited` is no confirmation: the exit could not be observed.
  const exitedWithin = async (ms: number): Promise<number | null | "unobservable"> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        child.exited.then((code) => code, () => "unobservable" as const),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), ms)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  const tried: string[] = []
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      child.kill(signal)
    } catch (error) {
      tried.push(`${signal} could not be sent (${messageOf(error)})`)
    }
    const code = await exitedWithin(stopMs)
    if (code === "unobservable") return { confirmed: false, pid: child.pid, why: [...tried, `the process's exit could not be observed after ${signal}`].join("; ") }
    if (code !== null) return { confirmed: true, pid: child.pid, how: `exited (status ${code}) after ${signal}` }
    tried.push(`no exit within ${stopMs} ms of ${signal}`)
  }
  return { confirmed: false, pid: child.pid, why: tried.join("; ") }
}

/** Read stdout until the listening line, the process exits, or the deadline. Keeps draining after. */
async function listeningUrl(child: HostChild, ms: number): Promise<{ ok: true; url: string } | { ok: false; why: string }> {
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), ms)
  })
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline])
      if (next === "deadline") return { ok: false, why: `the host printed no listening line within ${ms} ms` }
      if (next.done) return { ok: false, why: "the host's output ended before it printed a listening line" }
      text += decoder.decode(next.value, { stream: true })
      const match = text.match(LISTENING)
      if (match) {
        // Keep reading so the host never blocks on a full pipe.
        void (async () => {
          try {
            while (!(await reader.read()).done) {
              // discarded
            }
          } catch {
            // the pipe closed with the process
          }
        })()
        return { ok: true, url: match[1]! }
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Drain a stream in the background, keeping its last few kilobytes. */
function drain(stream: ReadableStream<Uint8Array>): { soFar(): Promise<string> } {
  let text = ""
  const decoder = new TextDecoder()
  void (async () => {
    try {
      const reader = stream.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        text = (text + decoder.decode(value, { stream: true })).slice(-4096)
      }
    } catch {
      // the pipe closed with the process
    }
  })()
  return { soFar: async () => text }
}

/** One bounded JSON request. The deadline holds even for a fetch that ignores its signal. */
async function readJson(
  doFetch: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>,
  url: string,
  ms: number,
): Promise<{ ok: true; value: unknown } | { ok: false; why: string }> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<{ ok: false; why: string }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ ok: false, why: `no answer within ${ms} ms` })
    }, ms)
  })
  const request = (async (): Promise<{ ok: true; value: unknown } | { ok: false; why: string }> => {
    try {
      const response = await doFetch(url, { signal: controller.signal })
      if (!response.ok) return { ok: false, why: `HTTP ${response.status}` }
      return { ok: true, value: await response.json() }
    } catch (error) {
      return { ok: false, why: messageOf(error) }
    }
  })()
  try {
    return await Promise.race([request, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function tail(text: string, secrets: readonly string[]): string {
  const trimmed = redactText(text, secrets).trim()
  return trimmed.length === 0 ? "(nothing)" : JSON.stringify(trimmed.slice(-600))
}

function isEmptyObject(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0
}

/** A value as text, redacted BEFORE it is serialized, so an escaped copy of a secret cannot survive. */
function describeValue(value: unknown, secrets: readonly string[]): string {
  if (value === undefined) return "absent"
  const text = JSON.stringify(redactConfig(value, secrets))
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
