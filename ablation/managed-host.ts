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
 * ## OAuth mode (story 2-8c3b)
 *
 * `mode: "oauth"` runs the host on opencode's own sign-ins, with no credential and
 * no relay. Everything above holds, with these differences:
 *
 * - **The payloads.** Before anything is spawned, the prepared directory
 *   (`scripts/oauth-prepare.ts`) is verified against `OAUTH_PAYLOAD`: both tree
 *   digests and the catalogue's sha256 (`ablation/oauth-payload.ts`). The Anthropic
 *   sign-in plugin, the config seed and the catalogue are then copied into the
 *   host's private root, and every copy is verified again, so what the host loads is
 *   what was verified.
 * - **The config.** `plugin` is exactly the `file://` spec of the private copy of the
 *   Anthropic sign-in plugin, `enabled_providers` exactly the OAuth provider ids, and no
 *   credential appears anywhere. A `provider` key appears only when the probe passes
 *   `baseURL` overrides, and then holds exactly those; the launcher never passes one.
 * - **The environment.** `XDG_DATA_HOME` is the caller's data directory, never a
 *   private one. No credential variable is set.
 * - **The registry.** `GET /config/providers` lists exactly the OAuth providers, and
 *   every roster model under its provider.
 * - **The data directory is the caller's.** Before the spawn its real path must be
 *   disjoint from the private root's, the prepared directory's and the user's own
 *   `<HOME>/.local/share/opencode`; `<data-dir>/opencode` must be a real directory
 *   whose only symlink is `auth.json`, and that symlink's `readlink` must be exactly
 *   `<HOME>/.local/share/opencode/auth.json` (`dataDirProblems`: `lstat`, `readdir`
 *   and `readlink` only). `stop()` removes only the private root. After the host's
 *   exit is confirmed it checks the data directory again, the seeded config lock's
 *   sha256 and the seeded tree's digest (allowing only the host's own `.gitignore`,
 *   `HOST_CONFIG_GITIGNORE`), and reports them on the outcome's `postStop`; an
 *   unconfirmed exit establishes none of them.
 *
 * AD-1: this tree may import from `core/`; nothing under `core/` imports it.
 */

import { cp, mkdir, mkdtemp, readFile, realpath, rm, rmdir, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"

import {
  authLinkPaths,
  dataDirProblems,
  overlapProblem,
  pluginPackageDir,
  recordDigest,
  sha256Of,
  treeDigest,
  treeRecord,
  verifyPrepared,
  type PayloadPins,
  type PreparedMeasure,
} from "./oauth-payload.ts"

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

/**
 * Story 2-8c3b — the OAuth route's prepared payloads, as `bun run oauth-prepare`
 * builds them from `ablation/oauth/`. Every OAuth-mode start verifies the prepared
 * directory against these before anything is spawned (`verifyPrepared`). Each tree
 * digest was pinned after two fresh installs agreed (`evidence`).
 */
export const OAUTH_PAYLOAD = {
  anthropicAuth: {
    dir: "anthropic-auth",
    package: "@ex-machina/opencode-anthropic-auth@1.8.1",
    integrity: "sha512-p1kER9dYcDnDGWJCYdifVX/e42OPtDF+q/HGdMlCWYD1nYslP96I/Ywf/IP/iKuZvRs6kKJ3wrfi5Oph6HK/2Q==",
    lockSha256: "8a4718c3e8f67b23bef90833295fd68ecc953f8ead04278dd76b8a7f60c186c8",
    treeDigest: "bdced1b7417dceae5b74e4c935b8794dc738c80416aa8ffc88cf70d16cf27f1a",
  },
  // 1.18.5, not the host's 1.18.32: opencode 1.18.32's config-directory installer compares dependency names only,
  // never versions, so a seeded 1.18.5 satisfies it and it fetches nothing (2-8c3-design.md, "Config-directory dependencies").
  configSeed: {
    dir: "config-seed",
    package: "@opencode-ai/plugin@1.18.5",
    integrity: "sha512-o1loQw5lh3zK7dgTN25Zh4tK+bW7BdszyDwdSumj0ahaR1lXWjYjVbAZuOQxeEQfkr266cqNi2x8UrrlkI0n7A==",
    lockSha256: "c94a4fa3aff0c9562c911d5a02476448904ed4b154f7248024575a3b7777c6c3",
    treeDigest: "ed93593910767097b1e6ffd2e4ae6ce9958b7333e536d2f168f6ec9c553d7151",
  },
  catalogue: { file: "models.json", sha256: "ee798d480fee862e04e092674720a3ccea5291852ba49ed9f524b0c17e8fc6e3" },
  evidence: "ablation/evidence/oauth-prepare-2026-09-25.json",
} as const

/**
 * Story 2-8c3b — the one file opencode 1.18.32 adds to a seeded config directory:
 * a top-level `.gitignore` of five fixed lines (`node_modules`, `package.json`,
 * `package-lock.json`, `bun.lock`, `.gitignore`), measured by story 2-8c3b's probe.
 * The post-stop digest check allows exactly this entry, byte for byte, and nothing
 * else.
 */
export const HOST_CONFIG_GITIGNORE = {
  path: ".gitignore",
  sha256: "663a068e76d264d0bc6740f5450b6c4193c7b41ecf5e0dc222485b8a17404d95",
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
  problems.push(...otherKeyDrift(actual, generated, describe, secrets))
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
// OAuth mode (story 2-8c3b)
// ---------------------------------------------------------------------------

/** What an OAuth-mode host runs with. */
export interface OAuthRoute {
  /** The providers opencode signs in to, and the host's `enabled_providers`, in order. */
  providers: readonly string[]
  /** The roster's models; the registry must list each under its provider. The first is the config's `model`. */
  models: readonly { providerId: string; modelId: string }[]
  /** The caller's opencode data directory: the host's `XDG_DATA_HOME`. Never created, written or removed here. */
  dataDir: string
  /** The prepared directory (`bun run oauth-prepare`). */
  prepared: string
  /** The home whose `.local/share/opencode/auth.json` the data directory must link to. Defaults to `os.homedir()`. */
  home?: string
  /** Probe-only: a `baseURL` per provider, pointing it at a local stub. The launcher never passes this. */
  baseURLs?: Readonly<Record<string, string>>
  /** The pins the prepared directory is verified against. Defaults to `OAUTH_PAYLOAD`. */
  pins?: PayloadPins
}

const PLAIN_ID = /^[a-z0-9][a-z0-9_-]*$/i

/** Why the OAuth route cannot be used, one reason each; empty when it can. */
export function oauthRouteProblems(route: OAuthRoute): string[] {
  const problems: string[] = []
  if (route.providers.length === 0) problems.push("no OAuth provider is named")
  const seen = new Set<string>()
  for (const id of route.providers) {
    if (!PLAIN_ID.test(id)) problems.push(`the provider id \`${id}\` is not a plain identifier (letters, digits, \`-\` and \`_\`)`)
    else if (seen.has(id)) problems.push(`the provider \`${id}\` is named twice`)
    seen.add(id)
  }
  if (route.models.length === 0) problems.push("the OAuth route names no model")
  const models = new Set<string>()
  for (const { providerId, modelId } of route.models) {
    if (!seen.has(providerId)) problems.push(`the model \`${providerId}/${modelId}\` names a provider that is not an OAuth provider`)
    if (modelId.trim().length === 0 || modelId !== modelId.trim()) problems.push(`the model id ${JSON.stringify(modelId)} is blank or padded`)
    else if (modelId.includes("/")) problems.push(`the model id \`${modelId}\` contains \`/\`, which the host reads as a provider separator`)
    else if (models.has(`${providerId}/${modelId}`)) problems.push(`the model \`${providerId}/${modelId}\` is named twice`)
    models.add(`${providerId}/${modelId}`)
  }
  for (const [name, path] of [["data directory", route.dataDir], ["prepared directory", route.prepared]] as const) {
    if (!isAbsolute(path)) problems.push(`the ${name} \`${path}\` is not an absolute path`)
  }
  if (route.home !== undefined && !isAbsolute(route.home)) problems.push(`the home \`${route.home}\` is not an absolute path`)
  for (const [id, baseURL] of Object.entries(route.baseURLs ?? {})) {
    if (!seen.has(id)) problems.push(`a baseURL override names \`${id}\`, which is not an OAuth provider`)
    let url: URL | undefined
    try {
      url = new URL(baseURL)
    } catch {
      url = undefined
    }
    if (url === undefined || url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      problems.push(`the baseURL override for \`${id}\` is \`${baseURL}\`; an override may only point at a local stub (plain http to 127.0.0.1, ::1 or localhost)`)
    }
  }
  return problems
}

/** The `plugin` spec that loads the Anthropic sign-in plugin under `root`: a `file://` path, so opencode's installer never runs. */
export function oauthPluginSpec(prepared: string): string {
  return `file://${pluginPackageDir(prepared)}`
}

/**
 * The whole effective config of an OAuth-mode host, loading the plugin from the
 * verified copy under `payloadRoot`. No credential appears in it.
 */
export function oauthHostConfig(route: OAuthRoute, payloadRoot: string): Record<string, unknown> {
  const first = `${route.models[0]!.providerId}/${route.models[0]!.modelId}`
  const overrides = Object.entries(route.baseURLs ?? {})
  return {
    ...FIXED_HOST_SETTINGS,
    plugin: [oauthPluginSpec(payloadRoot)],
    enabled_providers: [...route.providers],
    model: first,
    small_model: first,
    ...(overrides.length === 0 ? {} : { provider: Object.fromEntries(overrides.map(([id, baseURL]) => [id, { options: { baseURL } }])) }),
  }
}

/**
 * Every way an OAuth-mode host's `GET /config` differs from the generated config,
 * one sentence each: `plugin` must be exactly the private plugin copy, `provider`
 * exactly the probe's overrides or absent, and every other key as generated,
 * allowing only the host's own defaults (`HOST_DEFAULTS`).
 *
 * There is no credential to redact here, and the host's sign-ins may reach its
 * config, so no reported value is ever described: a sentence names keys, provider
 * ids and option names only, and describes only what MAD generated.
 */
export function oauthConfigDrift(reported: unknown, generated: Record<string, unknown>): string[] {
  const describe = (value: unknown) => describeValue(value, [])
  if (reported === null || typeof reported !== "object" || Array.isArray(reported)) {
    return ["`GET /config` did not return an object"]
  }
  const actual = reported as Record<string, unknown>
  const problems: string[] = []
  if (!sameJson(actual.plugin, generated.plugin)) {
    problems.push(`\`plugin\` is ${shapeOf(actual.plugin)}, not the generated list; the OAuth host loads exactly ${describe(generated.plugin)}`)
  }
  if (!sameJson(actual.provider, generated.provider)) {
    problems.push(
      `\`provider\` is ${providerKeys(actual.provider)}; ` +
        (generated.provider === undefined ? "the OAuth host's config sets no provider block" : `the generated config sets exactly ${describe(generated.provider)}`),
    )
  }
  problems.push(...otherKeyDrift(actual, generated, describe, [], shapeOf))
  return problems
}

/** A reported value described by its shape alone: never its contents. */
function shapeOf(value: unknown): string {
  if (value === undefined) return "absent"
  if (Array.isArray(value)) return `a list of ${value.length} entr${value.length === 1 ? "y" : "ies"}`
  if (value === null) return "null"
  if (typeof value === "object") return `an object with keys ${JSON.stringify(Object.keys(value).sort())}`
  return `a ${typeof value} value`
}

/** A reported provider block described by provider ids and option names alone. */
function providerKeys(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return shapeOf(value)
  const entries = Object.entries(value as Record<string, unknown>).map(([id, entry]) => {
    const options = entry !== null && typeof entry === "object" ? (entry as { options?: unknown }).options : undefined
    const names = options !== null && typeof options === "object" ? Object.keys(options).sort() : []
    return `\`${id}\` (option names ${JSON.stringify(names)})`
  })
  return entries.length === 0 ? "an empty provider block" : `a provider block naming ${entries.join(", ")}`
}

/**
 * Every way an OAuth-mode host's `GET /config/providers` differs from the route: it
 * must list exactly the OAuth providers, and every roster model under its provider.
 * Nothing from a provider's options is read or described.
 */
export function oauthRegistryDrift(reported: unknown, route: OAuthRoute): string[] {
  const describe = (value: unknown) => describeValue(value, [])
  const body = reported as { providers?: unknown } | null
  if (body === null || typeof body !== "object" || !Array.isArray(body.providers)) {
    return ["`GET /config/providers` did not return a provider list"]
  }
  const providers = body.providers as { id?: unknown; models?: unknown }[]
  const ids = providers.map((provider) => (provider !== null && typeof provider === "object" ? provider.id : undefined))
  const problems: string[] = []
  const expected = [...route.providers].sort()
  if (!sameJson([...ids].sort(), expected)) {
    problems.push(`the provider registry lists ${describe(ids)}; exactly the OAuth providers ${describe(expected)} are allowed`)
  }
  for (const { providerId, modelId } of route.models) {
    const provider = providers.find((entry) => entry !== null && typeof entry === "object" && entry.id === providerId)
    const models = provider?.models
    if (provider === undefined) continue
    if (models === null || typeof models !== "object" || !Object.hasOwn(models, modelId)) {
      problems.push(`the registry's \`${providerId}\` does not list the roster model \`${modelId}\``)
    }
  }
  return problems
}

/**
 * Keys other than `provider` and `plugin`: each as generated, and nothing else but
 * the host's own defaults. `describeActual` describes a reported value; it is
 * `describe` unless the caller must not print reported values.
 */
function otherKeyDrift(
  actual: Record<string, unknown>,
  generated: Record<string, unknown>,
  describe: (value: unknown) => string,
  secrets: readonly string[],
  describeActual: (value: unknown) => string = describe,
): string[] {
  const problems: string[] = []
  for (const key of Object.keys(generated)) {
    if (key === "provider" || key === "plugin") continue
    if (!(key in actual)) problems.push(`\`${key}\` is missing; the generated config sets it to ${describe(generated[key])}`)
    else if (!sameJson(actual[key], generated[key])) {
      problems.push(`\`${key}\` is ${describeActual(actual[key])}; the generated config sets ${describe(generated[key])}`)
    }
  }
  for (const key of Object.keys(actual)) {
    if (key in generated || key === "provider" || key === "plugin") continue
    const allowed = HOST_DEFAULTS[key]
    const name = redactText(key, secrets)
    if (allowed === undefined) problems.push(`\`${name}\` is set to ${describeActual(actual[key])}, and the generated config does not set it`)
    else if (!allowed(actual[key])) problems.push(`\`${name}\` is ${describeActual(actual[key])}, not the host's own default`)
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

/** The api-key mode: one `@ai-sdk/openai-compatible` block and its credential. */
export interface ApiKeyHostOptions extends HostOptionsBase {
  mode?: "api-key"
  block: ProviderBlock
  /** The credential's value. It reaches the host only as the `block.apiKeyEnv` variable. */
  credential: string
}

/** Story 2-8c3b — the OAuth mode: opencode's own sign-ins, no credential, no relay. */
export interface OAuthHostOptions extends HostOptionsBase {
  mode: "oauth"
  oauth: OAuthRoute
}

export type ManagedHostOptions = ApiKeyHostOptions | OAuthHostOptions

/** What both modes take. */
export interface HostOptionsBase {
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

export type StopOutcome = (
  | { confirmed: true; pid: number; how: string }
  | { confirmed: false; pid: number; why: string }
) & {
  /** Story 2-8c3b — OAuth mode only, when a host was spawned: the checks made after it exited. */
  postStop?: PostStopChecks
}

/** What an OAuth-mode stop checked after the host exited and before the private root was removed. */
export interface PostStopChecks {
  /** Each check that held, in words. */
  held: string[]
  /** Each check that failed, in words; non-empty fails the caller's exit code. */
  problems: string[]
}

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
  /** Story 2-8c3b — OAuth mode only: the data directory, and what the prepared directory measured as. */
  oauth?: { dataDir: string; prepared: string; measured: PreparedMeasure }
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
  const secrets = options.mode === "oauth" ? [] : secretForms(options.credential)
  const redact = (text: string) => redactText(text, secrets)
  try {
    return await start(options, secrets, redact)
  } catch (error) {
    return { ok: false, reason: redact(`the managed host could not be started: ${messageOf(error)}`), stopped: null }
  }
}

async function start(options: ManagedHostOptions, secrets: string[], redact: (text: string) => string): Promise<ManagedHostStart> {
  const variant =
    options.mode === "oauth"
      ? ({ kind: "oauth", route: options.oauth } as const)
      : ({ kind: "api-key", block: options.block, credential: options.credential } as const)
  const route = variant.kind === "oauth" ? variant.route : undefined
  if (variant.kind === "api-key") {
    const problems = providerBlockProblems(variant.block)
    if (problems.length > 0) return { ok: false, reason: redact(`the provider block is refused: ${problems.join("; ")}`), stopped: null }
  } else {
    const problems = oauthRouteProblems(variant.route)
    if (problems.length > 0) return { ok: false, reason: `the OAuth route is refused: ${problems.join("; ")}`, stopped: null }
  }
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

  // OAuth mode, before anything is created: the payloads as pinned, and the data directory's shape and place.
  const pins = route?.pins ?? OAUTH_PAYLOAD
  const home = route?.home ?? homedir()
  let measuredPayload: PreparedMeasure | undefined
  if (route !== undefined) {
    const verified = await verifyPrepared(route.prepared, pins)
    if (!verified.ok) return { ok: false, reason: `the prepared directory \`${route.prepared}\` is refused: ${verified.problems.join("; ")}`, stopped: null }
    measuredPayload = verified.measured
    const shape = await dataDirProblems(route.dataDir, home)
    if (shape.length > 0) return { ok: false, reason: `the OAuth data directory is refused: ${shape.join("; ")}`, stopped: null }
    for (const other of [
      { name: "user's own opencode data directory", path: join(home, ".local", "share", "opencode") },
      { name: "prepared directory", path: route.prepared },
    ]) {
      const overlap = await overlapProblem({ name: "OAuth data directory", path: route.dataDir }, other)
      if (overlap !== null) return { ok: false, reason: `the OAuth data directory is refused: ${overlap}`, stopped: null }
    }
  }

  const root = await mkdtemp(join(options.scratchParent ?? tmpdir(), "mad-managed-host-"))
  if (route !== undefined) {
    // Checked while the root is still empty, so a refusal removes nothing but that empty directory.
    const overlap = await overlapProblem({ name: "OAuth data directory", path: route.dataDir }, { name: "managed host's private root", path: root })
    if (overlap !== null) {
      await rmdir(root).catch(() => undefined)
      return { ok: false, reason: `the OAuth data directory is refused: ${overlap}`, stopped: null }
    }
  }
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
      if (route !== undefined && child !== undefined) {
        outcome = {
          ...outcome,
          postStop: outcome.confirmed
            ? await postStopChecks(route, home, pins, dirs.config)
            : { held: [], problems: ["the host's exit was not confirmed; post-stop checks not established"] },
        }
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
    for (const [name, dir] of Object.entries(dirs)) {
      // The OAuth host's data directory is the caller's; the private one is never made.
      if (route === undefined || name !== "data") await mkdir(dir, { recursive: true, mode: 0o700 })
    }
    const payloadRoot = join(root, "payload")
    if (route !== undefined) {
      const seeded = await seedPayloads(route.prepared, pins, { plugin: payloadRoot, config: dirs.config, cache: dirs.cache })
      if (seeded !== null) return await refuse(seeded)
    }
    const config = variant.kind === "api-key" ? hostConfig(variant.block) : oauthHostConfig(variant.route, payloadRoot)
    const configFile = join(root, "opencode.json")
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    const env: Record<string, string> = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: dirs.home,
      XDG_CONFIG_HOME: dirs.config,
      XDG_DATA_HOME: variant.kind === "api-key" ? dirs.data : variant.route.dataDir,
      XDG_CACHE_HOME: dirs.cache,
      XDG_STATE_HOME: dirs.state,
      OPENCODE_CONFIG: configFile,
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      ...(variant.kind === "api-key" ? { [variant.block.apiKeyEnv]: variant.credential } : {}),
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
      const drift = variant.kind === "api-key" ? configDrift(reported.value, config, variant.block, secrets) : oauthConfigDrift(reported.value, config)
      if (drift.length > 0) return await refuse(`the host's effective config for \`${directory}\` is not the generated one: ${drift.join("; ")}`)
      reportedConfig ??= reported.value
    }

    for (const directory of [dirs.cwd, ...(options.verifyDirectories ?? [])]) {
      const registry = await readJson(doFetch, `${url}/config/providers?directory=${encodeURIComponent(directory)}`, requestMs)
      if (!registry.ok) return await refuse(`\`GET /config/providers\` for \`${directory}\` could not be read: ${registry.why}`)
      const registryDrift = variant.kind === "api-key" ? providerRegistryDrift(registry.value, variant.block, secrets) : oauthRegistryDrift(registry.value, variant.route)
      if (registryDrift.length > 0) {
        return await refuse(
          variant.kind === "api-key"
            ? `the host's provider registry for \`${directory}\` is not the one block: ${registryDrift.join("; ")}`
            : `the host's provider registry for \`${directory}\` is not the OAuth route's: ${registryDrift.join("; ")}`,
        )
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
        ...(route === undefined ? {} : { oauth: { dataDir: route.dataDir, prepared: route.prepared, measured: measuredPayload! } }),
        pluginInstall: () => pluginInstallIn(dirs.config),
        stop,
      },
    }
  } catch (error) {
    return await refuse(`the managed host could not be started: ${messageOf(error)}`)
  }
}

/**
 * Copy the Anthropic sign-in plugin into `<plugin>/`, the config seed into
 * `<config>/opencode/` and the catalogue into `<cache>/opencode/models.json`, then
 * verify every copy against the pins. The host loads and reads only these copies,
 * so a change to the prepared directory after it was verified reaches nothing. The
 * reason they were refused, or `null`.
 */
async function seedPayloads(prepared: string, pins: PayloadPins, into: { plugin: string; config: string; cache: string }): Promise<string | null> {
  const plugin = join(into.plugin, pins.anthropicAuth.dir)
  const seed = join(into.config, "opencode")
  const catalogue = join(into.cache, "opencode", pins.catalogue.file)
  const copy = { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false }
  await mkdir(into.plugin, { recursive: true, mode: 0o700 })
  await cp(join(prepared, pins.anthropicAuth.dir), plugin, copy)
  await cp(join(prepared, pins.configSeed.dir), seed, copy)
  await mkdir(join(into.cache, "opencode"), { recursive: true, mode: 0o700 })
  await cp(join(prepared, pins.catalogue.file), catalogue, { errorOnExist: true, force: false })
  const problems: string[] = []
  for (const [what, dir, pinned] of [
    ["the copied Anthropic sign-in plugin", plugin, pins.anthropicAuth.treeDigest],
    ["the copied config seed", seed, pins.configSeed.treeDigest],
  ] as const) {
    const digest = await treeDigest(dir)
    if (!digest.ok) problems.push(digest.reason)
    else if (digest.digest !== pinned) problems.push(`${what}'s tree digest is ${digest.digest}; the pinned digest is ${pinned}`)
  }
  const sha = await sha256Of(catalogue)
  if (sha !== pins.catalogue.sha256) problems.push(`the copied catalogue's sha256 is ${sha}; the pinned catalogue's is ${pins.catalogue.sha256}`)
  return problems.length === 0 ? null : `the payloads copied into the host's private directories differ from the pins: ${problems.join("; ")}`
}

/**
 * After an OAuth-mode host's exit was confirmed: the data directory still has its
 * shape and the auth symlink is still the expected link, the seeded config lock is
 * byte-identical to the pinned one, and the whole seeded tree still has its pinned
 * digest. Neither the link nor its target is opened. Never rejects.
 */
async function postStopChecks(route: OAuthRoute, home: string, pins: PayloadPins, configHome: string): Promise<PostStopChecks> {
  const held: string[] = []
  const problems: string[] = []
  const { link, target } = authLinkPaths(route.dataDir, home)
  const shape = await dataDirProblems(route.dataDir, home)
  if (shape.length === 0) held.push(`\`${link}\` is still a symlink to \`${target}\``)
  else problems.push(...shape.map((problem) => `after the host exited, ${problem}`))
  const lockFile = join(configHome, "opencode", "package-lock.json")
  const lock = await sha256Of(lockFile).catch((error: unknown) => ({ failed: messageOf(error) }))
  if (typeof lock !== "string") problems.push(`after the host exited, the seeded config lock could not be hashed: ${lock.failed}`)
  else if (lock !== pins.configSeed.lockSha256) problems.push(`after the host exited, the seeded config lock's sha256 is ${lock}; the pinned lock's is ${pins.configSeed.lockSha256}`)
  else held.push(`the seeded config lock is unchanged (sha256 ${lock})`)
  const record = await treeRecord(join(configHome, "opencode")).catch((error: unknown) => ({ ok: false as const, reason: messageOf(error) }))
  if (!record.ok) problems.push(`after the host exited, ${record.reason}`)
  else {
    // The host's own `.gitignore`, exactly as measured, is the one entry allowed beyond the seed.
    const gitignore = `F\t${HOST_CONFIG_GITIGNORE.path}\t${HOST_CONFIG_GITIGNORE.sha256}\t-\n`
    const digest = recordDigest(record.lines.filter((line) => line !== gitignore))
    if (digest !== pins.configSeed.treeDigest) {
      problems.push(
        `after the host exited, the seeded config tree's digest (less the host's own \`${HOST_CONFIG_GITIGNORE.path}\`) is ${digest}; ` +
          `the pinned digest is ${pins.configSeed.treeDigest}`,
      )
    } else held.push(`the seeded config tree is unchanged but for the host's own \`${HOST_CONFIG_GITIGNORE.path}\` (digest ${digest})`)
  }
  return { held, problems }
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
