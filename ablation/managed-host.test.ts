/**
 * Story 2-8c — the managed host, driven through injected spawn, fetch and hash.
 * No test here starts an opencode process, and none holds a credential: the
 * "credential" is a marker string the tests look for in every output.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  configDrift,
  hostConfig,
  MEASURED_HOST,
  OPENAI_COMPATIBLE_NPM,
  providerBlockProblems,
  REDACTED,
  redactConfig,
  startManagedHost,
  type HostChild,
  type ManagedHostOptions,
  type ProviderBlock,
  type SignalSource,
  type SpawnHost,
} from "./managed-host.ts"

const SECRET = "sk-test-marker-0123456789"
const BLOCK: ProviderBlock = { id: "stub", npm: OPENAI_COMPATIBLE_NPM, baseURL: "http://127.0.0.1:9/v1", apiKeyEnv: "MAD_TEST_KEY", models: ["m1", "m2"] }

const scratch: string[] = []
afterEach(async () => {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})
async function parent(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-managed-host-test-"))
  scratch.push(dir)
  return dir
}

/** What a healthy host reports for `block`: the generated config, the credential resolved, and the host's own defaults. */
function reportedFor(block: ProviderBlock, patch: (config: Record<string, unknown>) => void = () => {}): Record<string, unknown> {
  const generated = hostConfig(block) as Record<string, unknown>
  const provider = structuredClone((generated.provider as Record<string, Record<string, unknown>>)[block.id]!)
  ;(provider.options as Record<string, unknown>).apiKey = SECRET
  const config: Record<string, unknown> = {
    ...structuredClone(generated),
    command: {},
    mode: {},
    agent: {},
    username: "unknown",
    provider: { [block.id]: provider },
  }
  patch(config)
  return config
}

interface FakeHost {
  spawn: SpawnHost
  requests: { cmd: string[]; cwd: string; env: Record<string, string> }[]
  kills: (number | string | undefined)[]
}

function fakeHost(options: { listening?: string; exitsOn?: "SIGTERM" | "SIGKILL" | "never" } = {}): FakeHost {
  const requests: FakeHost["requests"] = []
  const kills: FakeHost["kills"] = []
  const spawn: SpawnHost = (request) => {
    requests.push(request)
    let exit: (code: number) => void = () => {}
    const exited = new Promise<number>((resolve) => {
      exit = resolve
    })
    const line = options.listening ?? "opencode server listening on http://127.0.0.1:45678\n"
    const child: HostChild = {
      pid: 4242,
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`Warning: unsecured.\n${line}`))
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`boot with key ${SECRET}\n`))
          controller.close()
        },
      }),
      exited,
      kill(signal) {
        kills.push(signal)
        const on = options.exitsOn ?? "SIGTERM"
        if (on !== "never" && (signal === on || signal === "SIGKILL")) exit(signal === "SIGKILL" ? 137 : 143)
      },
    }
    return child
  }
  return { spawn, requests, kills }
}

/** What a healthy host's provider registry reports for `block`. */
function registryFor(block: ProviderBlock, npm = OPENAI_COMPATIBLE_NPM): unknown {
  return {
    providers: [{ id: block.id, models: Object.fromEntries(block.models.map((model) => [model, { id: model, api: { id: model, npm } }])) }],
    default: { [block.id]: block.models[0] },
  }
}

function fetchFor(
  health: unknown,
  config: unknown | ((url: string) => unknown),
  registry: unknown = registryFor(BLOCK),
): ManagedHostOptions["fetch"] {
  return async (url: string) => {
    if (url.endsWith("/global/health")) return Response.json(health)
    if (url.includes("/config/providers?")) return Response.json(registry)
    if (url.includes("/config?")) return Response.json(typeof config === "function" ? (config as (url: string) => unknown)(url) : config)
    return new Response("not found", { status: 404 })
  }
}

async function start(host: FakeHost, overrides: Partial<ManagedHostOptions> = {}) {
  return startManagedHost({
    block: BLOCK,
    credential: SECRET,
    binary: "/opt/opencode",
    resolveBinary: async (path) => path,
    hashFile: async () => MEASURED_HOST.sha256,
    spawn: host.spawn,
    fetch: fetchFor({ healthy: true, version: MEASURED_HOST.version }, reportedFor(BLOCK)),
    scratchParent: await parent(),
    signals: null,
    stopMs: 50,
    ...overrides,
  })
}

describe("the generated config and the provider block", () => {
  test("the config is the fixed settings plus one openai-compatible block whose credential is an env reference", () => {
    const config = hostConfig(BLOCK)
    expect(config).toEqual({
      $schema: "https://opencode.ai/config.json",
      autoupdate: false,
      share: "disabled",
      plugin: [],
      enabled_providers: ["stub"],
      model: "stub/m1",
      small_model: "stub/m1",
      provider: {
        stub: {
          npm: "@ai-sdk/openai-compatible",
          name: "stub",
          options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "{env:MAD_TEST_KEY}" },
          models: { m1: { name: "m1" }, m2: { name: "m2" } },
        },
      },
    })
  })

  test("a provider that is not openai-compatible is refused, and nothing is spawned", async () => {
    const block = { ...BLOCK, npm: "@ai-sdk/anthropic" }
    expect(providerBlockProblems(block).join("\n")).toContain("accepts only `@ai-sdk/openai-compatible`")
    const host = fakeHost()
    const started = await start(host, { block })
    expect(started.ok).toBe(false)
    if (!started.ok) expect(started.reason).toContain("the provider block is refused")
    expect(host.requests).toEqual([])
  })

  test("a reserved variable name, a query or fragment, plain http off loopback and a model id with `/` are refused", () => {
    for (const name of ["PATH", "HOME", "XDG_CONFIG_HOME", "OPENCODE_CONFIG", "OPENCODE_ANYTHING", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"]) {
      expect(providerBlockProblems({ ...BLOCK, apiKeyEnv: name }).join("\n"), name).toContain("is one the managed host sets itself")
    }
    expect(providerBlockProblems({ ...BLOCK, baseURL: "https://router.example/v1?key=x" }).join("\n")).toContain("query string or a fragment")
    expect(providerBlockProblems({ ...BLOCK, baseURL: "https://router.example/v1#x" }).join("\n")).toContain("query string or a fragment")
    expect(providerBlockProblems({ ...BLOCK, baseURL: "http://router.example/v1" }).join("\n")).toContain("plain http is allowed only to 127.0.0.1")
    for (const url of ["http://127.0.0.1:9/v1", "http://localhost:9/v1", "http://[::1]:9/v1", "https://router.example/v1"]) {
      expect(providerBlockProblems({ ...BLOCK, baseURL: url }), url).toEqual([])
    }
    expect(providerBlockProblems({ ...BLOCK, models: ["vendor/m1"] }).join("\n")).toContain("contains `/`")
    expect(providerBlockProblems({ ...BLOCK, models: [" m1"] }).join("\n")).toContain("is blank or padded")
  })

  test("a bad URL, a bad variable name, no model and a repeated model are each named", () => {
    const problems = providerBlockProblems({ ...BLOCK, baseURL: "ftp://x", apiKeyEnv: "1 BAD", models: [] }).join("\n")
    expect(problems).toContain("is not an http(s) URL")
    expect(problems).toContain("is not an environment variable name")
    expect(problems).toContain("names no model")
    expect(providerBlockProblems({ ...BLOCK, models: ["m1", "m1"] }).join("\n")).toContain("`m1` is named twice")
    expect(providerBlockProblems({ ...BLOCK, baseURL: "https://user:pw@example.invalid/v1" }).join("\n")).toContain("user name or password")
  })
})

describe("starting and verifying", () => {
  test("a healthy host: isolated env, the credential only in its variable, the URL from the listening line", async () => {
    const host = fakeHost()
    const started = await start(host, { proxy: "http://127.0.0.1:3128" })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.host.url).toBe("http://127.0.0.1:45678")
    const [request] = host.requests
    expect(request!.cmd).toEqual(["/opt/opencode", "serve", "--hostname", "127.0.0.1", "--port", "0"])
    expect(request!.cmd.join(" ")).not.toContain(SECRET)
    expect(Object.keys(request!.env).sort()).toEqual(
      [
        "HOME",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "MAD_TEST_KEY",
        "NO_PROXY",
        "OPENCODE_CONFIG",
        "OPENCODE_DISABLE_MODELS_FETCH",
        "OPENCODE_DISABLE_PROJECT_CONFIG",
        "PATH",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "http_proxy",
        "https_proxy",
        "no_proxy",
      ].sort(),
    )
    expect(request!.env.MAD_TEST_KEY).toBe(SECRET)
    expect(request!.env.NO_PROXY).toBe("127.0.0.1")
    expect(request!.env.OPENCODE_DISABLE_MODELS_FETCH).toBe("1")
    expect(request!.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1")
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
      expect(request!.env[key]!.includes("mad-managed-host-")).toBe(true)
    }
    const configText = await Bun.file(request!.env.OPENCODE_CONFIG!).text()
    expect(configText).not.toContain(SECRET)
    expect(JSON.stringify(started.host)).not.toContain(SECRET)
    expect(JSON.stringify(started.host.reportedConfig)).toContain(REDACTED)
    const stopped = await started.host.stop()
    expect(stopped).toMatchObject({ confirmed: true, pid: 4242 })
    expect(host.kills).toEqual(["SIGTERM"])
    // The private directories are gone once the host is stopped.
    await expect(Bun.file(request!.env.OPENCODE_CONFIG!).exists()).resolves.toBe(false)
    // A second stop returns the first outcome and sends nothing.
    expect(await started.host.stop()).toEqual(stopped)
    expect(host.kills).toEqual(["SIGTERM"])
  })

  test("the resolved real path is what is hashed and what is spawned", async () => {
    const host = fakeHost()
    const hashed: string[] = []
    const started = await start(host, {
      binary: "/usr/local/bin/opencode",
      resolveBinary: async () => "/usr/local/lib/opencode.exe",
      hashFile: async (path) => {
        hashed.push(path)
        return MEASURED_HOST.sha256
      },
    })
    expect(started.ok).toBe(true)
    expect(hashed).toEqual(["/usr/local/lib/opencode.exe"])
    expect(host.requests[0]!.cmd[0]).toBe("/usr/local/lib/opencode.exe")
    if (started.ok) await started.host.stop()
  })

  test("onSpawn is handed the host's stop before any check, so a host still starting can be stopped", async () => {
    const host = fakeHost()
    const seen: number[] = []
    const started = await start(host, {
      onSpawn: ({ pid, stop }) => {
        seen.push(pid)
        void stop()
      },
    })
    expect(seen).toEqual([4242])
    expect(started.ok).toBe(false)
    if (!started.ok) {
      expect(started.reason).toBe("the host was stopped while it was starting")
      expect(started.stopped).toMatchObject({ confirmed: true, pid: 4242 })
    }
    expect(host.kills).toEqual(["SIGTERM"])
  })

  test("a setup step that throws is ok:false with a redacted reason, never a rejection", async () => {
    const host = fakeHost()
    const started = await start(host, { scratchParent: `/nonexistent-${SECRET}/dir` })
    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.reason).toContain("could not be started")
    expect(started.reason).not.toContain(SECRET)
    expect(host.requests).toEqual([])
  })

  test("a host that prints its listening line and then stalls is refused within the request bound, and stopped", async () => {
    const host = fakeHost()
    const t0 = Date.now()
    const started = await start(host, { requestMs: 30, fetch: () => new Promise<Response>(() => {}) })
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.reason).toContain("no answer within 30 ms")
    expect(started.stopped).toMatchObject({ confirmed: true })
    expect(host.kills).toEqual(["SIGTERM"])
  })

  test("the provider registry must list only the block, with its models, each openai-compatible", async () => {
    const builtin = { providers: [{ id: "stub", models: { m1: { api: { npm: "@ai-sdk/anthropic" } }, m2: { api: { npm: OPENAI_COMPATIBLE_NPM } } } }] }
    const first = await start(fakeHost(), { fetch: fetchFor({ healthy: true, version: MEASURED_HOST.version }, reportedFor(BLOCK), builtin) })
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.reason).toContain("the registry's model `m1` is implemented by \"@ai-sdk/anthropic\"")
    const two = { providers: [...(registryFor(BLOCK) as { providers: unknown[] }).providers, { id: "opencode", models: {} }] }
    const second = await start(fakeHost(), { fetch: fetchFor({ healthy: true, version: MEASURED_HOST.version }, reportedFor(BLOCK), two) })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toContain('the provider registry lists ["stub","opencode"]')
    const fewer = await start(fakeHost(), { fetch: fetchFor({ healthy: true, version: MEASURED_HOST.version }, reportedFor(BLOCK), registryFor({ ...BLOCK, models: ["m1"] })) })
    expect(fewer.ok).toBe(false)
    if (!fewer.ok) expect(fewer.reason).toContain("offers")
  })

  test("the config is verified for every named directory too, and drift there is refused", async () => {
    const asked: string[] = []
    const started = await start(fakeHost(), {
      verifyDirectories: ["/work/tree"],
      fetch: fetchFor({ healthy: true, version: MEASURED_HOST.version }, (url: string) => {
        asked.push(decodeURIComponent(url.split("directory=")[1]!))
        return url.includes(encodeURIComponent("/work/tree")) ? reportedFor(BLOCK, (config) => (config.plugin = ["project-plugin"])) : reportedFor(BLOCK)
      }),
    })
    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(asked.at(-1)).toBe("/work/tree")
    expect(started.reason).toContain("effective config for `/work/tree` is not the generated one")
  })

  test("pluginInstall reads the version the host's install left, or says none is there", async () => {
    const host = fakeHost()
    const started = await start(host)
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(await started.host.pluginInstall()).toEqual({ installed: false, why: "no `@opencode-ai/plugin` is installed in the host's config directory" })
    const configHome = host.requests[0]!.env.XDG_CONFIG_HOME!
    await Bun.write(join(configHome, "opencode", "node_modules", "@opencode-ai", "plugin", "package.json"), JSON.stringify({ version: "1.18.32" }))
    expect(await started.host.pluginInstall()).toEqual({ installed: true, version: "1.18.32" })
    await started.host.stop()
  })

  test("no proxy variable is set when no proxy is named", async () => {
    const host = fakeHost()
    const started = await start(host)
    expect(started.ok).toBe(true)
    expect(Object.keys(host.requests[0]!.env).filter((key) => /proxy/i.test(key))).toEqual([])
    if (started.ok) await started.host.stop()
  })

  test("build drift: a different version is refused naming both identities, and the host is stopped", async () => {
    const host = fakeHost()
    const started = await start(host, { fetch: fetchFor({ healthy: true, version: "1.19.0" }, reportedFor(BLOCK)) })
    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.reason).toContain("version 1.19.0")
    expect(started.reason).toContain(`measured sha256 ${MEASURED_HOST.sha256}, version ${MEASURED_HOST.version}`)
    expect(started.stopped).toMatchObject({ confirmed: true })
    expect(host.kills).toEqual(["SIGTERM"])
  })

  test("build drift: a different binary hash is refused naming both hashes", async () => {
    const host = fakeHost()
    const started = await start(host, { hashFile: async () => "0".repeat(64) })
    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.reason).toContain(`has sha256 ${"0".repeat(64)}; the measured build's is ${MEASURED_HOST.sha256}`)
    expect(started.stopped).toMatchObject({ confirmed: true })
  })

  const refusedFor = async (patch: (config: Record<string, unknown>) => void) => {
    const host = fakeHost()
    const started = await start(host, { fetch: fetchFor({ healthy: true, version: MEASURED_HOST.version }, reportedFor(BLOCK, patch)) })
    expect(started.ok).toBe(false)
    if (started.ok) throw new Error("expected a refusal")
    expect(started.stopped).toMatchObject({ confirmed: true })
    expect(started.reason).not.toContain(SECRET)
    return started.reason
  }

  test("config drift: an extra plugin is refused and named", async () => {
    expect(await refusedFor((config) => (config.plugin = ["some-plugin@1.0.0"]))).toContain('`plugin` is ["some-plugin@1.0.0"]')
  })

  test("config drift: a second provider is refused and named", async () => {
    const reason = await refusedFor((config) => {
      ;(config.provider as Record<string, unknown>).anthropic = { npm: "@ai-sdk/anthropic", options: { apiKey: SECRET } }
    })
    expect(reason).toContain("`provider` holds `stub`, `anthropic`; exactly one, `stub`, is allowed")
  })

  test("config drift: a changed non-provider key and an unknown key are refused and named", async () => {
    const reason = await refusedFor((config) => {
      config.model = "stub/m2"
      config.instructions = [`use ${SECRET}`]
    })
    expect(reason).toContain('`model` is "stub/m2"; the generated config sets "stub/m1"')
    expect(reason).toContain("`instructions` is set to")
    expect(reason).toContain(REDACTED)
  })

  test("config drift: a provider option beyond baseURL and apiKey is refused", async () => {
    const reason = await refusedFor((config) => {
      ;((config.provider as Record<string, Record<string, Record<string, unknown>>>).stub!.options!).headerTimeout = 3000
    })
    expect(reason).toContain("only `apiKey` and `baseURL` are allowed")
  })

  test("a host that prints no listening line is refused within the bound, stopped, and its stderr redacted", async () => {
    const host = fakeHost({ listening: "" })
    const started = await start(host, { startupMs: 30 })
    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.reason).toContain("no listening line within 30 ms")
    expect(started.reason).not.toContain(SECRET)
    expect(started.reason).toContain(REDACTED)
  })

  test("a stop that is never confirmed is reported within the bound, naming the pid", async () => {
    const host = fakeHost({ exitsOn: "never" })
    const started = await start(host, { stopMs: 20 })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const t0 = Date.now()
    const stopped = await started.host.stop()
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(stopped).toEqual({
      confirmed: false,
      pid: 4242,
      why: "no exit within 20 ms of SIGTERM; no exit within 20 ms of SIGKILL",
    })
    expect(host.kills).toEqual(["SIGTERM", "SIGKILL"])
  })

  test("SIGTERM stops the host, confirms it, then exits 130", async () => {
    const host = fakeHost()
    const handlers = new Map<string, () => void>()
    const signals: SignalSource = {
      on: (signal, handler) => handlers.set(signal, handler),
      off: (signal) => handlers.delete(signal),
    }
    let exitCode: number | undefined
    const exited = new Promise<void>((resolve) => {
      void start(host, {
        signals,
        exit: (code) => {
          exitCode = code
          resolve()
        },
      }).then((started) => {
        expect(started.ok).toBe(true)
        handlers.get("SIGTERM")!()
      })
    })
    const original = console.error
    console.error = () => {}
    try {
      await exited
    } finally {
      console.error = original
    }
    expect(exitCode).toBe(130)
    expect(host.kills).toEqual(["SIGTERM"])
    expect(handlers.size).toBe(0)
  })

  test("the private directories are removed after a refusal", async () => {
    const dir = await parent()
    const host = fakeHost()
    const started = await start(host, { scratchParent: dir, hashFile: async () => "f".repeat(64) })
    expect(started.ok).toBe(false)
    expect(await readdir(dir)).toEqual([])
  })
})

describe("redaction", () => {
  test("a credential with a quote, a backslash and a control character never leaks, escaped or not", async () => {
    const nasty = 'sk-"quoted"\\back\u0001slash-9876'
    const host = fakeHost()
    const started = await start(host, {
      credential: nasty,
      fetch: fetchFor({ healthy: true, version: MEASURED_HOST.version }, reportedFor(BLOCK, (config) => {
        config.instructions = [`use ${nasty}`]
        config.extra = { nested: nasty }
      })),
    })
    expect(started.ok).toBe(false)
    if (started.ok) return
    const escaped = JSON.stringify(nasty).slice(1, -1)
    expect(started.reason).not.toContain(nasty)
    expect(started.reason).not.toContain(escaped)
    expect(started.reason).toContain(REDACTED)
  })

  test("every apiKey is replaced, and a secret anywhere else is redacted", () => {
    const redacted = redactConfig({ provider: { a: { options: { apiKey: "anything" } } }, note: `x ${SECRET} y` }, [SECRET])
    expect(redacted).toEqual({ provider: { a: { options: { apiKey: REDACTED } } }, note: `x ${REDACTED} y` })
  })

  test("configDrift never prints the credential it compares", () => {
    const problems = configDrift(reportedFor(BLOCK, (config) => ((config.provider as Record<string, Record<string, unknown>>).stub!.options = { apiKey: SECRET })), hostConfig(BLOCK), BLOCK)
    expect(problems.join("\n")).toContain("only `apiKey` and `baseURL` are allowed")
    expect(problems.join("\n")).not.toContain(SECRET)
  })

  test("a healthy config shows no drift", () => {
    expect(configDrift(reportedFor(BLOCK), hostConfig(BLOCK), BLOCK)).toEqual([])
  })
})
