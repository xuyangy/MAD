/**
 * The review-session policy (`./session-policy.ts`) and the backend's half of
 * it (`./model-backend.ts`), offline. These tests prove what MAD sends and what
 * MAD's own checks do; they do not prove that a real host enforces the rules.
 */

import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"

import { OpencodeModelBackend } from "./model-backend.ts"
import {
  describeReviewPermission,
  permissionEchoProblem,
  READ_ONLY_SESSION_NOTICE,
  REVIEW_SESSION_PERMISSION,
  ReviewSessionGuard,
} from "./session-policy.ts"

const SLOT = { slot: "discovery-1", providerId: "p", modelId: "m", lineage: "p" } as never
const SCHEMA = z.object({ ok: z.boolean() })

interface FakeOptions {
  /** What each create answers, by index from 0. Default: an id and the requested rules echoed. */
  create?: (args: { permission?: unknown }, index: number) => unknown
  /** What each delete answers. Default `{ data: true }`. */
  remove?: (args: { sessionID: string }) => unknown
}

function fakeClient(options: FakeOptions = {}) {
  const calls = { create: [] as { permission?: unknown; title?: string }[], prompt: [] as { system?: string; sessionID: string }[], delete: [] as string[] }
  const client = {
    session: {
      create: async (args: { permission?: unknown; title?: string }) => {
        const index = calls.create.length
        calls.create.push(args)
        if (options.create) return options.create(args, index)
        return { data: { id: `ses_${index}`, ...(args.permission === undefined ? {} : { permission: args.permission }) } }
      },
      prompt: async (args: { system?: string; sessionID: string }) => {
        calls.prompt.push(args)
        return { data: { info: { structured: { ok: true } } } }
      },
      delete: async (args: { sessionID: string }) => {
        calls.delete.push(args.sessionID)
        return options.remove ? options.remove(args) : { data: true }
      },
    },
  }
  return { client, calls }
}

function guardSpy() {
  const events: string[] = []
  return { events, guard: { track: (id: string) => events.push(`track ${id}`), deleted: (id: string) => events.push(`deleted ${id}`) } }
}

function backend(fake: ReturnType<typeof fakeClient>, extra: Record<string, unknown> = {}) {
  return new OpencodeModelBackend({
    serverUrl: "http://127.0.0.1:1",
    directory: "/repo",
    slots: [SLOT],
    client: fake.client as never,
    cleanupTimeoutMs: 50,
    ...extra,
  })
}

describe("the ruleset and the echo check", () => {
  test("deny everything, then allow only the host's own structured-output tool", () => {
    expect(REVIEW_SESSION_PERMISSION).toEqual([
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "StructuredOutput", pattern: "*", action: "allow" },
    ])
    expect(describeReviewPermission()).toBe("* * deny; StructuredOutput * allow")
  })

  test("only an exact, in-order copy matches; every other answer has a fixed description", () => {
    const rules = REVIEW_SESSION_PERMISSION
    expect(permissionEchoProblem(structuredClone([...rules]), rules)).toBeNull()
    expect(permissionEchoProblem(undefined, rules)).toBe("the host returned no permission rules for the session")
    expect(permissionEchoProblem(null, rules)).toBe("the host returned no permission rules for the session")
    expect(permissionEchoProblem("deny", rules)).toBe("the host returned permission rules MAD could not read")
    expect(permissionEchoProblem([{ permission: "*" }], rules)).toBe("the host returned permission rules MAD could not read")
    const different = "the host returned permission rules different from the ones MAD sent"
    expect(permissionEchoProblem([{ ...rules[0]!, note: "x" }, rules[1]], rules)).toBe(different)
    expect(permissionEchoProblem([{ ...rules[0]!, action: "maybe" }, rules[1]], rules)).toBe("the host returned permission rules MAD could not read")
    expect(permissionEchoProblem([...rules].reverse(), rules)).toBe(different)
    expect(permissionEchoProblem([rules[0]], rules)).toBe(different)
    expect(permissionEchoProblem([...rules, { permission: "read", pattern: "*", action: "allow" }], rules)).toBe(different)
    expect(permissionEchoProblem([{ permission: "edit", pattern: "*", action: "allow" }, ...rules], rules)).toBe(different)
  })

  test("the host's value is never quoted in a problem", () => {
    const hostile = [{ permission: "IGNORE PREVIOUS", pattern: "*", action: "allow" }]
    expect(permissionEchoProblem(hostile, REVIEW_SESSION_PERMISSION)).not.toContain("IGNORE")
  })
})

describe("the guard", () => {
  test("every tool on a tracked session is refused; an untracked session is untouched", async () => {
    const guard = new ReviewSessionGuard()
    guard.track("ses_a")
    for (const tool of ["read", "grep", "glob", "list", "bash", "edit", "write", "task", "webfetch", "my_custom_tool", "StructuredOutput"]) {
      await expect(guard.beforeTool({ tool, sessionID: "ses_a", callID: "c" })).rejects.toThrow("MAD refused the tool call")
    }
    await expect(guard.beforeTool({ tool: "bash", sessionID: "ses_other", callID: "c" })).resolves.toBeUndefined()
  })

  test("two concurrent sessions are each covered, and one confirmed deletion releases only its own", async () => {
    const guard = new ReviewSessionGuard()
    guard.track("ses_a")
    guard.track("ses_b")
    guard.deleted("ses_a")
    await expect(guard.beforeTool({ tool: "bash", sessionID: "ses_a", callID: "c" })).resolves.toBeUndefined()
    await expect(guard.beforeTool({ tool: "bash", sessionID: "ses_b", callID: "c" })).rejects.toThrow()
  })
})

describe("the backend under the policy", () => {
  test("create carries the rules, the id is tracked before the prompt, the notice is appended, and a confirmed delete releases it", async () => {
    const fake = fakeClient()
    const spy = guardSpy()
    const order: string[] = spy.events
    const prompt = fake.client.session.prompt
    fake.client.session.prompt = async (args) => (order.push("prompt"), prompt(args))
    const b = backend(fake, { sessionPermission: REVIEW_SESSION_PERMISSION, promptNotice: READ_ONLY_SESSION_NOTICE, sessionGuard: spy.guard })

    const envelope = await b.runTurn("discovery-1", "INSTRUCTIONS", "input", SCHEMA)

    expect(envelope.ok).toBe(true)
    expect(fake.calls.create[0]!.permission).toEqual([...REVIEW_SESSION_PERMISSION])
    expect(fake.calls.prompt[0]!.system).toBe(`INSTRUCTIONS\n\n${READ_ONLY_SESSION_NOTICE}`)
    expect(order).toEqual(["track ses_0", "prompt", "deleted ses_0"])
  })

  test("A SESSION WHOSE ECHO DIFFERS IS NEVER PROMPTED: disposed, reported once, and its slot gets the pre-issue cancellation", async () => {
    const fake = fakeClient({ create: () => ({ data: { id: "ses_x" } }) })
    const mismatches: { slot: string; problem: string }[] = []
    const b = backend(fake, { sessionPermission: REVIEW_SESSION_PERMISSION, onPolicyMismatch: (fact: never) => mismatches.push(fact) })

    const envelope = await b.runTurn("discovery-1", "I", "input", SCHEMA)

    expect(fake.calls.prompt).toHaveLength(0)
    expect(fake.calls.delete).toEqual(["ses_x"])
    expect(mismatches).toEqual([{ slot: "discovery-1", problem: "the host returned no permission rules for the session" }])
    expect(envelope).toMatchObject({ ok: false, failure: "cancelled" })
    expect("tokens" in envelope).toBe(false)
  })

  test("ONLY `{ data: true }` CONFIRMS A DELETE: an error, a throw, a hang, false, {}, null or no delete keeps the session tracked and is reported", async () => {
    for (const remove of [
      () => ({ error: { name: "NotFound" } }),
      () => Promise.reject(new Error("refused")),
      () => new Promise(() => {}),
      () => ({ data: false }),
      () => ({}),
      () => null,
    ]) {
      const spy = guardSpy()
      const b = backend(fakeClient({ remove }), { sessionPermission: REVIEW_SESSION_PERMISSION, sessionGuard: spy.guard })
      const envelope = await b.runTurn("discovery-1", "I", "input", SCHEMA)
      expect(spy.events).toEqual(["track ses_0"])
      expect(envelope.cleanupUnresolved?.why).toStartWith("the session was not deleted")
    }
    const noDelete = fakeClient()
    delete (noDelete.client.session as { delete?: unknown }).delete
    const spy = guardSpy()
    const envelope = await backend(noDelete, { sessionPermission: REVIEW_SESSION_PERMISSION, sessionGuard: spy.guard }).runTurn("discovery-1", "I", "input", SCHEMA)
    expect(spy.events).toEqual(["track ses_0"])
    expect(envelope.cleanupUnresolved?.why).toContain("no session.delete")
  })

  test("A CONFIRMATION THAT ARRIVES AFTER THE DEADLINE still releases the session, and the turn still reports the late delete", async () => {
    let confirm: (value: unknown) => void = () => undefined
    const spy = guardSpy()
    const fake = fakeClient({ remove: () => new Promise((resolve) => (confirm = resolve)) })
    const envelope = await backend(fake, { sessionPermission: REVIEW_SESSION_PERMISSION, sessionGuard: spy.guard }).runTurn("discovery-1", "I", "input", SCHEMA)
    expect(envelope.cleanupUnresolved?.why).toContain("did not answer within 50ms")
    expect(spy.events).toEqual(["track ses_0"])
    confirm({ data: true })
    await Bun.sleep(0)
    expect(spy.events).toEqual(["track ses_0", "deleted ses_0"])
  })

  test("WITHOUT THE POLICY, delete answers are read as they always were", async () => {
    for (const remove of [() => ({ data: false }), () => ({}), () => ({ error: { name: "NotFound" } })]) {
      const envelope = await backend(fakeClient({ remove })).runTurn("discovery-1", "I", "input", SCHEMA)
      expect(envelope.cleanupUnresolved).toBeUndefined()
    }
  })

  test("A CREATE THAT SUCCEEDS WITHOUT A USABLE ID stops the run: absent, empty, numeric or object id; nothing tracked, prompted or deleted", async () => {
    for (const id of [undefined, "", 42, { id: "ses_0" }]) {
      const fake = fakeClient({ create: () => ({ data: { id, permission: [...REVIEW_SESSION_PERMISSION] } }) })
      const spy = guardSpy()
      const mismatches: unknown[] = []
      const envelope = await backend(fake, {
        sessionPermission: REVIEW_SESSION_PERMISSION,
        sessionGuard: spy.guard,
        onPolicyMismatch: (fact: unknown) => mismatches.push(fact),
      }).runTurn("discovery-1", "I", "input", SCHEMA)
      expect(envelope).toMatchObject({ ok: false, failure: "cancelled" })
      expect(mismatches).toEqual([{ slot: "discovery-1", problem: "the host answered a session create without a usable session id" }])
      expect(spy.events).toEqual([])
      expect(fake.calls.prompt).toHaveLength(0)
      expect(fake.calls.delete).toHaveLength(0)
    }
  })

  test("A CREATE THE HOST REFUSED is still a transport failure, and stops nothing", async () => {
    const mismatches: unknown[] = []
    const envelope = await backend(fakeClient({ create: () => ({ error: { name: "BadRequest" } }) }), {
      sessionPermission: REVIEW_SESSION_PERMISSION,
      onPolicyMismatch: (fact: unknown) => mismatches.push(fact),
    }).runTurn("discovery-1", "I", "input", SCHEMA)
    expect(envelope).toMatchObject({ ok: false, failure: "transport-error" })
    expect(mismatches).toEqual([])
  })

  test("A STOP THAT LANDS WHILE THE CREATE IS IN FLIGHT: the session is disposed unprompted, and the turn is the pre-issue cancellation", async () => {
    let answer: (value: unknown) => void = () => undefined
    const fake = fakeClient({ create: () => new Promise((resolve) => (answer = resolve)) })
    const spy = guardSpy()
    const stop = new AbortController()
    const turn = backend(fake, { sessionPermission: REVIEW_SESSION_PERMISSION, sessionGuard: spy.guard }).runTurn("discovery-1", "I", "input", SCHEMA, stop.signal)
    await Bun.sleep(0)
    stop.abort()
    answer({ data: { id: "ses_late", permission: [...REVIEW_SESSION_PERMISSION] } })
    const envelope = await turn
    expect(envelope).toMatchObject({ ok: false, failure: "cancelled" })
    expect(fake.calls.prompt).toHaveLength(0)
    expect(fake.calls.delete).toEqual(["ses_late"])
    expect(spy.events).toEqual(["track ses_late", "deleted ses_late"])
  })

  test("WITHOUT THE OPTIONS, nothing changes: no permission, no notice, no tracking", async () => {
    const fake = fakeClient()
    await backend(fake).runTurn("discovery-1", "INSTRUCTIONS", "input", SCHEMA)
    expect("permission" in fake.calls.create[0]!).toBe(false)
    expect(fake.calls.prompt[0]!.system).toBe("INSTRUCTIONS")
    expect(await backend(fake).probeSessionPolicy()).toEqual({ ok: true })
    expect(fake.calls.create).toHaveLength(1)
  })
})

describe("the probe", () => {
  const policy = { sessionPermission: REVIEW_SESSION_PERMISSION }

  test("a matching echo: ok, never prompted, deleted and released", async () => {
    const fake = fakeClient()
    const spy = guardSpy()
    expect(await backend(fake, { ...policy, sessionGuard: spy.guard }).probeSessionPolicy()).toEqual({ ok: true })
    expect(fake.calls.create[0]!.title).toBe("MAD session policy probe")
    expect(fake.calls.prompt).toHaveLength(0)
    expect(spy.events).toEqual(["track ses_0", "deleted ses_0"])
  })

  test("an echo that differs is `different`; no usable session is `unchecked`, and claims nothing about what the host did", async () => {
    const different = await backend(fakeClient({ create: () => ({ data: { id: "s", permission: [] } }) }), policy).probeSessionPolicy()
    expect(different).toMatchObject({ ok: false, kind: "different" })

    for (const create of [
      () => ({ error: { name: "BadRequest" } }),
      () => ({ data: {} }),
      () => ({ data: { id: "" } }),
      () => Promise.reject(new Error("connection refused")),
    ]) {
      const fake = fakeClient({ create })
      const outcome = await backend(fake, policy).probeSessionPolicy()
      expect(outcome).toMatchObject({ ok: false, kind: "unchecked" })
      if (!outcome.ok) expect(outcome.problem).toContain("if the host created a session anyway, MAD has no id to delete it by")
      expect(fake.calls.delete).toHaveLength(0)
    }
  })

  test("A HANGING PROBE CREATE is bounded: unchecked, claiming nothing about the host; a late answer with an id is tracked and deleted, never prompted", async () => {
    let answer: (value: unknown) => void = () => undefined
    const fake = fakeClient({ create: () => new Promise((resolve) => (answer = resolve)) })
    const spy = guardSpy()
    const outcome = await backend(fake, { ...policy, sessionGuard: spy.guard }).probeSessionPolicy()
    expect(outcome).toMatchObject({ ok: false, kind: "unchecked", sessionMayExist: true })
    if (!outcome.ok) {
      expect(outcome.problem).toContain("did not answer within 50ms")
      expect(outcome.problem).not.toContain("deletes it")
    }
    answer({ data: { id: "ses_late", permission: [...REVIEW_SESSION_PERMISSION] } })
    await Bun.sleep(5)
    expect(spy.events).toEqual(["track ses_late", "deleted ses_late"])
    expect(fake.calls.delete).toEqual(["ses_late"])
    expect(fake.calls.prompt).toHaveLength(0)
  })

  test("A LATE PROBE SESSION WHOSE DELETE FAILS OR HANGS stays guarded, and is never prompted", async () => {
    for (const remove of [() => ({ error: { name: "NotFound" } }), () => new Promise(() => {})]) {
      let answer: (value: unknown) => void = () => undefined
      const fake = fakeClient({ create: () => new Promise((resolve) => (answer = resolve)), remove })
      const spy = guardSpy()
      await backend(fake, { ...policy, sessionGuard: spy.guard }).probeSessionPolicy()
      answer({ data: { id: "ses_late", permission: [...REVIEW_SESSION_PERMISSION] } })
      await Bun.sleep(80)
      expect(spy.events).toEqual(["track ses_late"])
      expect(fake.calls.delete).toEqual(["ses_late"])
      expect(fake.calls.prompt).toHaveLength(0)
    }
  })

  test("A LATE PROBE FAILURE is consumed, and a late answer without an id tracks nothing", async () => {
    let fail: (error: unknown) => void = () => undefined
    const failing = fakeClient({ create: () => new Promise((_, reject) => (fail = reject)) })
    expect(await backend(failing, policy).probeSessionPolicy()).toMatchObject({ ok: false, kind: "unchecked" })
    fail(new Error("late failure"))
    let answer: (value: unknown) => void = () => undefined
    const spy = guardSpy()
    const empty = fakeClient({ create: () => new Promise((resolve) => (answer = resolve)) })
    await backend(empty, { ...policy, sessionGuard: spy.guard }).probeSessionPolicy()
    answer({ data: {} })
    await Bun.sleep(5)
    expect(spy.events).toEqual([])
  })

  test("A STOP BEFORE OR DURING THE PROBE ends it as cancelled", async () => {
    const before = new AbortController()
    before.abort()
    const unasked = fakeClient()
    expect(await backend(unasked, policy).probeSessionPolicy(before.signal)).toMatchObject({ ok: false, kind: "cancelled" })
    expect(unasked.calls.create).toHaveLength(0)

    let answer: (value: unknown) => void = () => undefined
    const fake = fakeClient({ create: () => new Promise((resolve) => (answer = resolve)) })
    const spy = guardSpy()
    const during = new AbortController()
    const probe = backend(fake, { ...policy, sessionGuard: spy.guard, cleanupTimeoutMs: 10_000 }).probeSessionPolicy(during.signal)
    await Bun.sleep(0)
    during.abort()
    expect(await probe).toMatchObject({ ok: false, kind: "cancelled", sessionMayExist: true })
    answer({ data: { id: "ses_late", permission: [...REVIEW_SESSION_PERMISSION] } })
    await Bun.sleep(5)
    expect(spy.events).toEqual(["track ses_late", "deleted ses_late"])
  })

  test("a probe whose delete fails reports it and stays tracked", async () => {
    const spy = guardSpy()
    const outcome = await backend(fakeClient({ remove: () => new Promise(() => {}) }), { ...policy, sessionGuard: spy.guard }).probeSessionPolicy()
    expect(outcome.ok).toBe(true)
    expect(outcome.cleanupUnresolved?.why).toContain("did not answer within 50ms")
    expect(spy.events).toEqual(["track ses_0"])
  })
})

describe("the harness keeps its requests", () => {
  test("only the plugin passes the policy options", async () => {
    const root = join(import.meta.dir, "..", "..")
    for (const file of ["ablation/live.ts", "ablation/adversarial.ts", "scripts/paired.ts", "ablation/paired.ts"]) {
      const source = await readFile(join(root, file), "utf8")
      for (const option of ["sessionPermission", "promptNotice", "sessionGuard", "onPolicyMismatch"]) {
        expect(source).not.toContain(option)
      }
    }
    const plugin = await readFile(join(root, "adapters", "opencode", "plugin.ts"), "utf8")
    expect(plugin).toContain("sessionPermission: REVIEW_SESSION_PERMISSION")
    expect(plugin).toContain("promptNotice: READ_ONLY_SESSION_NOTICE")
  })
})
