/**
 * Story 2-8c5 — the OAuth pilot command against stand-in hosts, backends and
 * proxies. No test here starts opencode, runs npm, bills, reaches the network,
 * tunnels to an external host, or touches the user's opencode directories: the
 * live mode runs only with an injected gate table, a stand-in host and a stand-in
 * proxy, and the dry mode's only stat is of its own placeholder target. The one
 * sandboxed process (macOS only) talks to loopback stand-ins through the real
 * allowlisting proxy, and its one direct connection, to a never-routed address, is
 * denied by the sandbox.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { startAllowlistProxy, type ProxyConnect } from "../ablation/accounting-stub.ts"
import { ATTEMPT_ALLOWANCES } from "../ablation/governor.ts"
import { acquireLock, JOURNAL_FILE, openJournal, type PairedJournal } from "../ablation/journal.ts"
import type { ManagedHostStart, StopOutcome } from "../ablation/managed-host.ts"
import type { PreparedMeasure } from "../ablation/oauth-payload.ts"
import { HUMAN_BUDGET_OWNER, OAUTH_PILOT_PROPOSAL, OAUTH_PILOT_RUN, oauthPilotReservation, PAIRED_GATES, type OAuthPilotRun, type PairedGate } from "../ablation/paired-gates.ts"
import { OpencodeModelBackend } from "../adapters/opencode/model-backend.ts"
import type { RosterSlot } from "../core/domain/roster.ts"
import { emptyTokenUsage } from "../core/domain/run-record.ts"
import type { RequestAdmission } from "../core/ports/admission.ts"
import { abandonedTurn, type Envelope, type ModelBackend } from "../core/ports/model-backend.ts"
import {
  attemptStop,
  authorize,
  denialEntries,
  LIVE_EVIDENCE_DIR,
  logTimestamp,
  managedPilotHost,
  oneRunProblems,
  reserveLiveRun,
  runIdentityProblems,
  type HostStarters,
  BEFORE_FIRST_ASK,
  connectRule,
  authTargetFlags,
  COPILOT_TARGET,
  EVIDENCE_FILE,
  EVIDENCE_WORDING,
  findingsFrom,
  HostRefused,
  main,
  parsePilotArgs,
  PILOT_ALLOWED_CONNECTS,
  PILOT_MAX_ATTEMPTS,
  PILOT_MODEL,
  PILOT_PROMPT,
  PILOT_SEEDED,
  PILOT_TOOLS,
  PILOT_TURN_TIMEOUT_MS,
  PARTIAL_EVIDENCE_FILE,
  GATE_EFFECT,
  pilotHostOptions,
  runAttempts,
  statAuthTarget,
  timeConnects,
  type AuthTargetStat,
  type HostRequest,
  type PilotAttempt,
  type PilotEvidence,
  type PilotHost,
  type PilotSeams,
  type SandboxDenials,
} from "./oauth-pilot.ts"
import { SANDBOX_EXEC, SANDBOX_PROFILE, sandboxSpawn, seededAttempts } from "./oauth-probe.ts"
import { boundedGit, GATE_TABLE_FILE, PREFLIGHT_GIT_CLEANUP_MS, PREFLIGHT_GIT_DEADLINE_MS, preflightSpawn } from "./paired.ts"

const scratch: string[] = []
afterEach(async () => {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-oauth-pilot-test-"))
  scratch.push(dir)
  return dir
}

const tokens = { input: 11, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
const answer = (slot: string): Envelope<unknown> => ({ ok: true, slot, value: { reply: "ok" }, tokens })

/** A stand-in backend: one scripted envelope (or throw) per call, and the calls it saw. */
function scriptedBackend(script: ((slot: string) => Envelope<unknown> | Promise<Envelope<unknown>>)[]): ModelBackend & { calls: { slot: string; instructions: string; input: string; tools?: unknown }[] } {
  const calls: { slot: string; instructions: string; input: string }[] = []
  return {
    calls,
    capabilities: () => ({ tools: false }),
    async runTurn<T>(slot: string, instructions: string, input: string): Promise<Envelope<T>> {
      calls.push({ slot, instructions, input })
      const next = script[calls.length - 1]
      if (next === undefined) throw new Error("the stand-in backend was called more often than scripted")
      return (await next(slot)) as Envelope<T>
    },
  }
}

/** A real attempt-mode journal on a temp root, seeded as the pilot seeds it. */
async function seededJournal(seed = PILOT_SEEDED): Promise<PairedJournal> {
  const root = await temp()
  await writeFile(join(root, JOURNAL_FILE), seededAttempts(seed).map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8")
  const taken = await acquireLock(root, new Date().toISOString())
  if (!taken.ok) throw new Error(taken.reason)
  const opened = await openJournal(root, taken.lock, () => new Date().toISOString(), undefined, "attempts")
  if (!opened.ok) throw new Error(opened.reason)
  return opened.journal
}

function sequenceWith(journal: PairedJournal, backend: ModelBackend, connects: () => readonly ProxyConnect[] = () => []) {
  return runAttempts({
    admission: journal.admission({ block: 1, phase: "prefix", runId: () => "pilot-test" }),
    backend,
    slot: "discovery-1",
    signal: new AbortController().signal,
    connects,
    latched: () => {
      const bill = journal.bill()
      return bill.stop ?? bill.halt
    },
  })
}

/** The host's zero-initialized token object, as opencode leaves it on an errored message. */
const HOST_ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const REFRESH_401 = { name: "UnknownError", data: { message: "Token refresh failed: 401" } }
const INJECTED_SECRET = "sk-proj-INJECTEDSECRET0123456789"

/**
 * The production `OpencodeModelBackend` over a stand-in client whose prompt
 * settles an errored message with the host's all-zero token object: no host, no
 * network, no real provider.
 */
function erroredOpencode(error: unknown, options: { directory: string; slots: RosterSlot[]; timeoutMs: number; tools: Record<string, boolean> }): ModelBackend & { prompts: () => number } {
  let prompts = 0
  const client = {
    session: {
      create: async () => ({ data: { id: "ses_stand_in" } }),
      prompt: async () => {
        prompts += 1
        return { data: { info: { error, tokens: HOST_ZERO_TOKENS } } }
      },
      delete: async () => ({ data: true }),
    },
  }
  const backend = new OpencodeModelBackend({ serverUrl: "http://127.0.0.1:9", ...options, client: client as never })
  return Object.assign(backend, { prompts: () => prompts })
}

const STAND_IN_SLOT: RosterSlot = {
  slot: "discovery-1",
  providerId: "openai",
  modelId: "gpt-6-luna",
  identity: "gpt-6-luna",
  lineage: { lineage: "unverified", label: "lineage unverified", verified: false },
  toolcall: true,
  alsoAvailableVia: [],
}

const connect = (target: string | null, at = Date.now(), outcome: ProxyConnect["outcome"] = "refused"): ProxyConnect => ({
  at,
  line: target === null ? "GET http://example.invalid/ HTTP/1.1" : `CONNECT ${target} HTTP/1.1`,
  target,
  outcome,
})

describe("the pilot's fixed shape", () => {
  test("at most 2 admitted attempts, a hard constant; the seed leaves exactly 2 in block 1's prefix", () => {
    expect(PILOT_MAX_ATTEMPTS).toBe(2)
    expect(PILOT_SEEDED + PILOT_MAX_ATTEMPTS).toBe(ATTEMPT_ALLOWANCES.prefix)
  })

  test("the prompt, the model, the turn bound, no host tools, and the two allowed hosts", () => {
    expect(PILOT_PROMPT).toBe("Reply with the word ok.")
    expect(PILOT_MODEL).toEqual({ providerId: "openai", modelId: "gpt-6-luna" })
    expect(PILOT_TURN_TIMEOUT_MS).toBe(120_000)
    expect(PILOT_TOOLS).toEqual({ "*": false, StructuredOutput: true })
    expect([...PILOT_ALLOWED_CONNECTS]).toEqual(["chatgpt.com:443", "auth.openai.com:443"])
  })

  test("the evidence wording says proxy-observed CONNECT, never all egress, and that the per-attempt request count is not shown", () => {
    const text = EVIDENCE_WORDING.join(" ")
    expect(text).toContain("proxy-observed CONNECT")
    expect(text).toContain("never all egress")
    expect(text).toContain("the per-attempt physical request count is not shown")
    expect(text.replace("never all egress", "")).not.toContain("all egress")
  })
})

describe("arguments", () => {
  const argv = (...rest: string[]) => ["bun", "oauth-pilot.ts", ...rest]
  test("the dry run is the default and needs only --out; it refuses --oauth-data-dir", () => {
    expect(parsePilotArgs(argv("--out", "/x/out"), "/home/u")).toEqual({ ok: true, args: { mode: "dry", out: "/x/out", home: "/home/u" } })
    expect(parsePilotArgs(argv("--out", "/x/out", "--oauth-prepared", "/p"), "/h")).toEqual({ ok: true, args: { mode: "dry", out: "/x/out", prepared: "/p", home: "/h" } })
    const refused = parsePilotArgs(argv("--out", "/x/out", "--oauth-data-dir", "/d"))
    expect(refused.ok).toBe(false)
    expect((refused as { reason: string }).reason).toContain("never touches a real one")
  })

  test("--live needs --oauth-data-dir and --oauth-prepared, each absolute", () => {
    expect(parsePilotArgs(argv("--live", "--out", "/o", "--oauth-data-dir", "/d", "--oauth-prepared", "/p"), "/h")).toEqual({
      ok: true,
      args: { mode: "live", out: "/o", dataDir: "/d", prepared: "/p", home: "/h" },
    })
    expect((parsePilotArgs(argv("--live", "--out", "/o")) as { reason: string }).reason).toBe("--live needs --oauth-data-dir <absolute path> and --oauth-prepared <absolute path>")
    expect(parsePilotArgs(argv("--live", "--out", "/o", "--oauth-data-dir", "rel", "--oauth-prepared", "/p")).ok).toBe(false)
    expect(parsePilotArgs(argv("--out", "/o", "--live", "--live")).ok).toBe(false)
    expect(parsePilotArgs(argv("--out", "/o", "--provider-url", "https://x")).ok).toBe(false)
    expect(parsePilotArgs(argv()).ok).toBe(false)
  })
})

/** Gate 8 OPEN: the refusal the live run gives until the budget owner closes it. */
const openEight = PAIRED_GATES.map((gate): PairedGate => (gate.number === 8 ? { ...gate, status: "OPEN", evidence: undefined } : gate))

describe("authorization", () => {
  const committed = async () => ({ ok: true as const, blob: "abc123" })
  const closedEight = PAIRED_GATES.map((gate): PairedGate => (gate.number === 8 ? { ...gate, status: "CLOSED", evidence: "authorized by the budget owner" } : gate))

  test("a table with gate 8 OPEN refuses", async () => {
    const result = await authorize(openEight, committed)
    expect(result.ok).toBe(false)
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]).toStartWith("gate 8 (OAuth pilot spend authorization) is OPEN")
    expect(result.problems[0]).toContain(`owner: ${HUMAN_BUDGET_OWNER}`)
  })

  test("a table that differs from HEAD refuses even with gate 8 CLOSED; a table that cannot be read refuses", async () => {
    const modified = await authorize(closedEight, async () => ({ ok: false, why: "ablation/paired-gates.ts differs from HEAD (` M ablation/paired-gates.ts`)" }))
    expect(modified.ok).toBe(false)
    expect(modified.problems).toEqual(["ablation/paired-gates.ts differs from HEAD (` M ablation/paired-gates.ts`)"])
    const unreadable = await authorize(closedEight, async () => {
      throw new Error("git is missing")
    })
    expect(unreadable.ok).toBe(false)
    expect(unreadable.problems[0]).toContain("git is missing")
  })

  test("gate 8 CLOSED in the committed table authorizes, whatever gates 4 and 7 say", async () => {
    const result = await authorize(closedEight, committed)
    expect(result.ok).toBe(true)
    expect(result.lines[0]).toBe("ablation/paired-gates.ts is HEAD's blob abc123")
  })
})

describe("the attempt sequence, on a real seeded journal", () => {
  test("two attempts answer; the third admission is refused inside the journal with no backend call", async () => {
    const journal = await seededJournal()
    const backend = scriptedBackend([answer, answer])
    const run = await sequenceWith(journal, backend)
    await journal.close()
    expect(run.stop).toBeNull()
    expect(run.attempts.map((attempt) => [attempt.attempt, attempt.answered, attempt.settlement.kind])).toEqual([
      [1, true, "usage"],
      [2, true, "usage"],
    ])
    expect(run.backendCalls).toBe(2)
    expect(backend.calls).toHaveLength(2)
    expect(backend.calls.every((call) => call.input === PILOT_PROMPT && call.slot === "discovery-1")).toBe(true)
    expect(run.third.asked).toBe(true)
    expect(run.third.backendCalls).toBe(0)
    expect(run.third.refusal?.cause).toBe("budget")
    expect(run.third.refusal?.reason).toContain(`${ATTEMPT_ALLOWANCES.prefix} of ${ATTEMPT_ALLOWANCES.prefix} admitted attempts`)
  })

  test("a journal that would admit a third attempt is caught: it is never sent, and the ceiling failure stops the run", async () => {
    const journal = await seededJournal(PILOT_SEEDED - 1)
    const backend = scriptedBackend([answer, answer])
    const run = await sequenceWith(journal, backend)
    await journal.close()
    expect(backend.calls).toHaveLength(2)
    expect(run.third.refusal).toBeNull()
    expect(run.third.backendCalls).toBe(0)
    expect(run.stop?.reason).toContain("2-attempt ceiling did not hold")
  })

  test("the first attempt ending in an error stops the run: the second is not sent, even when the host reported zero usage", async () => {
    const journal = await seededJournal()
    const backend = scriptedBackend([(slot) => ({ ok: false, slot, failure: "model-error", message: "provider refused", tokens: emptyTokenUsage() }), answer])
    const run = await sequenceWith(journal, backend)
    await journal.close()
    expect(backend.calls).toHaveLength(1)
    expect(run.attempts).toHaveLength(1)
    expect(run.attempts[0]!.failure).toBe("model-error")
    expect(run.stop).toEqual({ reason: "attempt 1 ended in an error (model-error)", after: "attempt 1" })
    expect(run.third).toMatchObject({ asked: false, backendCalls: 0 })
  })

  test("a refresh rejected before any request settles `unknown` with its host-error category, stops, and latches no halt (2-8c6)", async () => {
    const journal = await seededJournal()
    const backend = erroredOpencode(REFRESH_401, { directory: "/stand-in", slots: [STAND_IN_SLOT], timeoutMs: PILOT_TURN_TIMEOUT_MS, tools: { ...PILOT_TOOLS } })
    const run = await sequenceWith(journal, backend)
    const bill = journal.bill()
    await journal.close()
    expect(backend.prompts()).toBe(1)
    expect(run.attempts).toHaveLength(1)
    expect(run.attempts[0]!.settlement.kind).toBe("unknown")
    expect(run.attempts[0]!.settlement).not.toHaveProperty("abandoned")
    expect(run.attempts[0]!.hostError).toEqual({
      category: "oauth-token-refresh-rejected",
      code: 401,
      summary: expect.stringContaining("HTTP 401"),
    })
    expect(run.stop).toEqual({ reason: "attempt 1 ended in an error (model-error)", after: "attempt 1" })
    // Attempt mode: a non-abandoned unknown is a diagnostic, counted as an attempt, and latches nothing.
    expect(bill.halt).toBeNull()
    expect(bill.stop).toBeNull()
  })

  test("an answered attempt records `hostError: null`", async () => {
    const journal = await seededJournal()
    const run = await sequenceWith(journal, scriptedBackend([answer, answer]))
    await journal.close()
    expect(run.attempts.map((attempt) => attempt.hostError)).toEqual([null, null])
  })

  test("a settlement other than usage stops the run", async () => {
    const journal = await seededJournal()
    const backend = scriptedBackend([(slot) => ({ ok: true, slot, value: { reply: "ok" } }), answer])
    const run = await sequenceWith(journal, backend)
    await journal.close()
    expect(backend.calls).toHaveLength(1)
    expect(run.attempts[0]!.settlement.kind).toBe("unknown")
    expect(run.stop?.reason).toBe("attempt 1 was settled `unknown`, not `usage`")
  })

  test("a timeout is settled abandoned, which halts the journal and stops the run", async () => {
    const journal = await seededJournal()
    const backend = scriptedBackend([(slot) => ({ ...abandonedTurn(slot, "exec-1", "the turn timed out"), failure: "transport-error" }), answer])
    const run = await sequenceWith(journal, backend)
    expect(journal.bill().halt).not.toBeNull()
    await journal.close()
    expect(backend.calls).toHaveLength(1)
    expect(run.stop?.reason).toContain(`did not end within its ${PILOT_TURN_TIMEOUT_MS} ms bound`)
    expect(run.stop?.reason).toContain("which halts")
  })

  test("a runTurn that throws is settled abandoned and stops the run", async () => {
    const journal = await seededJournal()
    const backend = scriptedBackend([
      () => {
        throw new Error("socket closed")
      },
      answer,
    ])
    const run = await sequenceWith(journal, backend)
    await journal.close()
    expect(run.attempts[0]).toMatchObject({ threw: true, answered: false, hostError: { category: "transport-failure", code: null } })
    expect(run.attempts[0]!.settlement).toMatchObject({ kind: "unknown", abandoned: true })
    expect(run.stop).toEqual({ reason: "attempt 1: the backend threw after the request was issued, which halts", after: "attempt 1" })
    expect(backend.calls).toHaveLength(1)
  })

  /** An admission whose `admit` or `settle` throws where the test says. */
  function throwingAdmission(journal: PairedJournal, where: { admitOn?: number; settleOn?: number }): RequestAdmission {
    const inner = journal.admission({ block: 1, phase: "prefix", runId: () => "pilot-test" })
    return {
      async admit(request) {
        if (request.attempt === where.admitOn) throw new Error("the journal file vanished")
        const decision = await inner.admit(request)
        if (!decision.ok || request.attempt !== where.settleOn) return decision
        return {
          ...decision,
          settle: async (settlement) => {
            await decision.settle(settlement)
            throw new Error("fsync failed")
          },
        }
      },
    }
  }

  test("a settlement that throws after the backend was called: the attempt is recorded, the run stops with the reason, nothing escapes", async () => {
    const journal = await seededJournal()
    const backend = scriptedBackend([answer, answer])
    const run = await runAttempts({
      admission: throwingAdmission(journal, { settleOn: 1 }),
      backend,
      slot: "discovery-1",
      signal: new AbortController().signal,
      connects: () => [],
      latched: () => null,
    })
    await journal.close()
    expect(backend.calls).toHaveLength(1)
    expect(run.attempts).toHaveLength(1)
    expect(run.attempts[0]).toMatchObject({ answered: true, settleError: "fsync failed" })
    expect(run.stop).toEqual({ reason: "attempt 1's settlement could not be recorded in the journal: fsync failed", after: "attempt 1" })
  })

  test("an admission that throws after the backend was called stops the run with the reason; so does a third admission that throws", async () => {
    const second = await seededJournal()
    const backend = scriptedBackend([answer, answer])
    const run = await runAttempts({
      admission: throwingAdmission(second, { admitOn: 2 }),
      backend,
      slot: "discovery-1",
      signal: new AbortController().signal,
      connects: () => [],
      latched: () => null,
    })
    await second.close()
    expect(backend.calls).toHaveLength(1)
    expect(run.stop).toEqual({ reason: "the journal's admission of attempt 2 threw: the journal file vanished", after: "attempt 1" })
    const third = await seededJournal()
    const both = scriptedBackend([answer, answer])
    const ceiling = await runAttempts({
      admission: throwingAdmission(third, { admitOn: 3 }),
      backend: both,
      slot: "discovery-1",
      signal: new AbortController().signal,
      connects: () => [],
      latched: () => null,
    })
    await third.close()
    expect(both.calls).toHaveLength(2)
    expect(ceiling.third).toMatchObject({ asked: true, refusal: null, backendCalls: 0 })
    expect(ceiling.stop?.reason).toBe("the journal's third admission threw: the journal file vanished")
  })

  test("cleanupUnresolved on an answered attempt with usage stops the run", async () => {
    const journal = await seededJournal()
    const backend = scriptedBackend([(slot) => ({ ...answer(slot), cleanupUnresolved: { why: "session.delete did not answer within 5000 ms" } }), answer])
    const run = await sequenceWith(journal, backend)
    await journal.close()
    expect(backend.calls).toHaveLength(1)
    expect(run.attempts[0]).toMatchObject({ answered: true, cleanupUnresolved: true })
    expect(run.attempts[0]!.settlement.kind).toBe("usage")
    expect(run.stop?.reason).toContain("cleanupUnresolved")
  })

  test("a proxy-observed CONNECT outside the two hosts stops the run: before the first admission, or after an attempt", async () => {
    const early = await seededJournal()
    const none = scriptedBackend([])
    const before = await sequenceWith(early, none, () => [connect("registry.npmjs.org:443")])
    await early.close()
    expect(before.attempts).toHaveLength(0)
    expect(none.calls).toHaveLength(0)
    expect(before.stop).toEqual({ reason: "a proxy-observed CONNECT outside chatgpt.com:443 and auth.openai.com:443: `CONNECT registry.npmjs.org:443 HTTP/1.1`", after: "the host started" })

    const later = await seededJournal()
    const seen: ProxyConnect[] = [connect("chatgpt.com:443", Date.now(), "tunnelled")]
    const backend = scriptedBackend([
      (slot) => {
        seen.push(connect("evil.example:443"))
        return answer(slot)
      },
      answer,
    ])
    const after = await sequenceWith(later, backend, () => seen)
    await later.close()
    expect(backend.calls).toHaveLength(1)
    expect(after.stop?.after).toBe("attempt 1")
    expect(after.stop?.reason).toContain("evil.example:443")
    // A plain request line is outside the two hosts as well.
    const plain = await seededJournal()
    const refusedPlain = await sequenceWith(plain, scriptedBackend([]), () => [connect(null)])
    await plain.close()
    expect(refusedPlain.attempts).toHaveLength(0)
  })

  test("Copilot at startup: a refused CONNECT to api.githubcopilot.com:443 before the first issued line is recorded and does not stop the run", async () => {
    const journal = await seededJournal()
    const seen: ProxyConnect[] = [connect(COPILOT_TARGET, Date.now() - 50), connect(COPILOT_TARGET, Date.now() - 40)]
    const backend = scriptedBackend([answer, answer])
    const run = await sequenceWith(journal, backend, () => seen)
    await journal.close()
    expect(run.stop).toBeNull()
    expect(backend.calls).toHaveLength(2)
    expect(run.third.refusal?.cause).toBe("budget")
    const timed = timeConnects(seen, run, 0)
    expect(timed.map((entry) => [entry.window, entry.stopRule])).toEqual([
      [BEFORE_FIRST_ASK, "copilot-startup"],
      [BEFORE_FIRST_ASK, "copilot-startup"],
    ])
  })

  test("Copilot later: the same CONNECT once the first admission was asked stops the run, and so does a tunnelled one before it", async () => {
    const journal = await seededJournal()
    const seen: ProxyConnect[] = [connect(COPILOT_TARGET, Date.now() - 50)]
    const backend = scriptedBackend([
      (slot) => {
        seen.push(connect(COPILOT_TARGET))
        return answer(slot)
      },
      answer,
    ])
    const run = await sequenceWith(journal, backend, () => seen)
    await journal.close()
    expect(backend.calls).toHaveLength(1)
    expect(run.stop).toEqual({ reason: `a proxy-observed CONNECT to ${COPILOT_TARGET} after the first admission was asked: \`CONNECT ${COPILOT_TARGET} HTTP/1.1\``, after: "attempt 1" })
    expect(timeConnects(seen, run, 0).map((entry) => [entry.window, entry.stopRule])).toEqual([
      [BEFORE_FIRST_ASK, "copilot-startup"],
      ["attempt 1", "stops"],
    ])
    // The exception is for a refused CONNECT to exactly that target: anything else stops.
    expect(connectRule(connect(COPILOT_TARGET, 1, "tunnelled"), null)).toBe("stops")
    expect(connectRule(connect("api.githubcopilot.com:8443", 1), null)).toBe("stops")
    expect(connectRule(connect("x.api.githubcopilot.com:443", 1), null)).toBe("stops")
    expect(connectRule(connect(COPILOT_TARGET, 5), 5)).toBe("stops")
    expect(connectRule(connect(COPILOT_TARGET, 4), 5)).toBe("copilot-startup")
    expect(connectRule(connect("chatgpt.com:443", 9, "tunnelled"), 5)).toBe("allowed-host")
  })

  test("a journal that has latched stops the run before the next admission", async () => {
    const journal = await seededJournal()
    let latched: string | null = null
    const backend = scriptedBackend([
      (slot) => {
        latched = "the journal could not record a settlement"
        return answer(slot)
      },
      answer,
    ])
    const run = await runAttempts({
      admission: journal.admission({ block: 1, phase: "prefix", runId: () => "pilot-test" }),
      backend,
      slot: "discovery-1",
      signal: new AbortController().signal,
      connects: () => [],
      latched: () => latched,
    })
    await journal.close()
    expect(backend.calls).toHaveLength(1)
    expect(run.stop).toEqual({ reason: "the journal latched: the journal could not record a settlement", after: "attempt 1" })
  })

  test("the stop rules, in order", () => {
    const base: PilotAttempt = { attempt: 1, askedAt: 0, admittedAt: 0, settledAt: 1, answered: true, failure: null, threw: false, hostError: null, settlement: { kind: "usage", tokens }, settleError: null, cleanupUnresolved: false }
    const abandoned = { kind: "unknown" as const, why: "x", abandoned: true as const }
    const throwText = "attempt 1: the backend threw after the request was issued, which halts"
    const timeoutText = `attempt 1 did not end within its ${PILOT_TURN_TIMEOUT_MS} ms bound: it was settled abandoned, which halts`
    expect(attemptStop(base)).toBeNull()
    // Each rule alone.
    expect(attemptStop({ ...base, answered: false, failure: "transport-error", threw: true, settlement: abandoned })).toBe(throwText)
    expect(attemptStop({ ...base, answered: false, failure: "transport-error", settlement: abandoned })).toBe(timeoutText)
    expect(attemptStop({ ...base, answered: false, failure: "model-error" })).toBe("attempt 1 ended in an error (model-error)")
    expect(attemptStop({ ...base, settlement: { kind: "unknown", why: "no usage" } })).toBe("attempt 1 was settled `unknown`, not `usage`")
    expect(attemptStop({ ...base, cleanupUnresolved: true })).toBe("attempt 1 returned cleanupUnresolved: its session was not deleted within the backend's bound")
    // Their order: a throw before a timeout, a timeout before an error, an error before a non-usage settlement, that before cleanupUnresolved.
    expect(attemptStop({ ...base, answered: false, failure: "transport-error", threw: true, settlement: abandoned, cleanupUnresolved: true })).toBe(throwText)
    expect(attemptStop({ ...base, answered: false, failure: "model-error", settlement: abandoned, cleanupUnresolved: true })).toBe(timeoutText)
    expect(attemptStop({ ...base, answered: false, failure: "model-error", settlement: { kind: "unknown", why: "x" }, cleanupUnresolved: true })).toBe("attempt 1 ended in an error (model-error)")
    expect(attemptStop({ ...base, settlement: { kind: "unknown", why: "x" }, cleanupUnresolved: true })).toBe("attempt 1 was settled `unknown`, not `usage`")
  })
})

describe("the auth target: flags, never values", () => {
  const facts = (size: bigint, mtimeNs: bigint, ino: bigint) => ({ ok: true as const, size, mtimeNs, ino })

  test("changed and unchanged for size, mtime and inode, for lstat and stat; no value reaches the flags", () => {
    const before: AuthTargetStat = { lstat: facts(4321n, 1790000000123456789n, 987654n), stat: facts(4321n, 1790000000123456789n, 987654n) }
    const after: AuthTargetStat = { lstat: facts(4321n, 1790000999123456789n, 987654n), stat: facts(4400n, 1790000999123456789n, 987655n) }
    const flags = authTargetFlags(before, after)
    expect(flags).toEqual({
      lstat: { size: "unchanged", mtime: "changed", inode: "unchanged" },
      stat: { size: "changed", mtime: "changed", inode: "changed" },
    })
    const text = JSON.stringify(flags)
    for (const value of ["4321", "4400", "1790000", "987654", "987655"]) expect(text).not.toContain(value)
  })

  test("a failed call is unavailable, named by its error code only", () => {
    const before: AuthTargetStat = { lstat: { ok: false, code: "ENOENT" }, stat: facts(1n, 2n, 3n) }
    const flags = authTargetFlags(before, before)
    expect(flags.lstat.size).toBe("unavailable (before: ENOENT; after: ENOENT)")
    expect(flags.stat).toEqual({ size: "unchanged", mtime: "unchanged", inode: "unchanged" })
  })

  test("statAuthTarget reads metadata of a temp file and reports a missing one by its code", async () => {
    const dir = await temp()
    const file = join(dir, "auth.json")
    await writeFile(file, "placeholder\n")
    const seen = await statAuthTarget(file)
    expect(seen.stat).toMatchObject({ ok: true, size: 12n })
    expect(seen.lstat.ok).toBe(true)
    expect(await statAuthTarget(join(dir, "missing.json"))).toEqual({ lstat: { ok: false, code: "ENOENT" }, stat: { ok: false, code: "ENOENT" } })
  })
})

describe("timing and findings", () => {
  const attempts: PilotAttempt[] = [
    { attempt: 1, askedAt: 900, admittedAt: 1_000, settledAt: 2_000, answered: false, failure: "model-error", threw: false, hostError: null, settlement: { kind: "usage", tokens: emptyTokenUsage() }, settleError: null, cleanupUnresolved: false },
  ]
  const sequence = { attempts, firstAskedAt: 900 }

  test("the Copilot boundary is the sequence's first ask, even when that admission was refused and no attempt exists", () => {
    const [late] = timeConnects([connect(COPILOT_TARGET, 950)], { attempts: [], firstAskedAt: 900 }, 0)
    expect(late).toMatchObject({ stopRule: "stops" })
    expect(late!.window).not.toBe(BEFORE_FIRST_ASK)
    const [early] = timeConnects([connect(COPILOT_TARGET, 850)], { attempts: [], firstAskedAt: 900 }, 0)
    expect(early).toMatchObject({ stopRule: "copilot-startup", window: BEFORE_FIRST_ASK })
  })

  test("each CONNECT is timed against the attempts' windows", () => {
    const timed = timeConnects([connect(COPILOT_TARGET, 500), connect("chatgpt.com:443", 1_500), connect("chatgpt.com:443", 2_500)], sequence, 100)
    expect(timed.map((entry) => [entry.atMs, entry.window])).toEqual([
      [400, BEFORE_FIRST_ASK],
      [1_400, "attempt 1"],
      [2_400, "after the last settled line"],
    ])
    expect("at" in timed[0]!).toBe(false)
  })

  test("the findings answer whether an attempt returned a model answer and the Copilot question, bounded to what the proxy observed", () => {
    const timed = timeConnects([connect(COPILOT_TARGET, 500)], sequence, 100)
    const findings = findingsFrom({ mode: "dry", attempts, connects: timed, third: { asked: false, refusal: null, backendCalls: 0, why: "not asked" }, stop: { reason: "attempt 1 ended in an error (model-error)", after: "attempt 1" }, hostStarted: true, denials: { ok: true, source: "log", entries: [] } })
    const text = (id: string) => findings.find((finding) => finding.id === id)!.text
    expect(text("S1")).toContain("1 attempt(s) admitted; none returned a model answer; journal settlements: attempt 1 `usage`")
    expect(text("C1")).toContain(`the proxy observed 1 CONNECT(s) to ${COPILOT_TARGET}, the first at 400 ms (${BEFORE_FIRST_ASK})`)
    expect(text("C1")).toContain("1 before the first admission was asked, refused and recorded as the expected startup event, which does not stop the pilot; 0 after it")
    expect(text("D1")).toBe(
      "this dry run exercised attempt 1 (failed). The dry run cannot exercise the 2-attempt ceiling or the refused third admission: its proxy " +
        "refuses every CONNECT, so its first attempt always fails and stops the run. They are proven by the stand-in tests in " +
        "`scripts/oauth-pilot.test.ts`, reported separately",
    )
    expect(text("C1")).toContain("bounded to what this run's proxy observed")
    expect(text("E1")).toContain("sandbox denials the unified log reported over the host's window: 0")
    expect(text("E1")).toContain("Neither is a complete census of direct connections")
    const quiet = findingsFrom({ mode: "dry", attempts: [], connects: [], third: { asked: false, refusal: null, backendCalls: 0, why: "" }, stop: null, hostStarted: true, denials: "n/a" })
    expect(quiet.find((finding) => finding.id === "C1")!.text).toContain(`the proxy observed no CONNECT to ${COPILOT_TARGET} in this run`)
  })
})

// ---------------------------------------------------------------------------
// Whole runs, through main
// ---------------------------------------------------------------------------

const identity = {
  binary: "/stand-in/opencode",
  sha256: "0".repeat(64),
  version: "1.18.32",
  measuredHost: { version: "1.18.32", sha256: "0".repeat(64) },
  matchesMeasuredHost: true,
  environmentKeys: ["HOME"],
  generatedConfig: {},
  reportedConfig: {},
  payload: { anthropicAuth: { lockSha256: null, treeDigest: null, entries: null }, configSeed: { lockSha256: null, treeDigest: null, entries: null }, catalogueSha256: null } as PreparedMeasure,
}

function standInHost(
  requests: HostRequest[],
  postStop = { held: ["the stand-in's post-stop checks held"], problems: [] as string[] },
  onStop: () => StopOutcome | void = () => undefined,
): (request: HostRequest) => Promise<PilotHost> {
  return async (request) => {
    requests.push(request)
    const host: PilotHost = {
      url: "http://127.0.0.1:1",
      pid: 4242,
      identity,
      stop: async (): Promise<StopOutcome> => onStop() ?? { confirmed: true, pid: 4242, how: "exited", postStop },
    }
    request.onSpawn(host)
    return host
  }
}

/** Every hook a refused live run must never reach. */
function tripwires(touched: string[]): PilotSeams {
  const trip = (name: string) => () => {
    touched.push(name)
    throw new Error(`${name} was reached`)
  }
  return {
    startHost: trip("startHost"),
    startProxy: trip("startProxy"),
    statAuthTarget: trip("statAuthTarget"),
    prepare: trip("prepare"),
    selfTest: trip("selfTest"),
    backendFor: trip("backendFor"),
    sandboxDenials: trip("sandboxDenials"),
  } as PilotSeams
}

async function captured<T>(run: () => Promise<T>): Promise<{ value: T; err: string; out: string }> {
  const errors: string[] = []
  const logs: string[] = []
  const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.join(" ")))
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.join(" ")))
  try {
    return { value: await run(), err: errors.join("\n"), out: logs.join("\n") }
  } finally {
    errSpy.mockRestore()
    logSpy.mockRestore()
  }
}

describe("the live run is refused unless gate 8 is CLOSED in the committed table", () => {
  test("the shipped tree (the real table, this repository, the default git): exit 1, with no host, stat, connection or reservation change", async () => {
    const root = await temp()
    const touched: string[] = []
    const reservation = new URL(`../${oauthPilotReservation(OAUTH_PILOT_RUN.run)}`, import.meta.url).pathname
    const snapshot = async () => (existsSync(reservation) ? await readFile(reservation) : null)
    const before = await snapshot()
    const { value, err } = await captured(() =>
      main(["bun", "oauth-pilot.ts", "--live", "--oauth-data-dir", join(root, "data"), "--oauth-prepared", join(root, "prepared"), "--out", join(root, "out")], {
        ...tripwires(touched),
        // "linux", never "darwin": the platform refusal comes before `--out` and the reservation, so even with
        // gate 8 CLOSED for run 2 this test can never create the real reservation and spend the authorization.
        platform: "linux",
      }),
    )
    expect(value).toBe(1)
    expect(touched).toEqual([])
    expect(existsSync(join(root, "out"))).toBe(false)
    const eight = PAIRED_GATES.find((gate) => gate.number === 8)!
    expect(err).toContain(eight.status === "OPEN" ? "REFUSED: gate 8 (OAuth pilot spend authorization) is OPEN" : "REFUSED")
    const after = await snapshot()
    expect(after === null ? null : after.toString("base64")).toBe(before === null ? null : before.toString("base64"))
  })

  test("with gate 8 OPEN: exit 1 naming gate 8 OPEN, before any host, stat, data-directory open or connection", async () => {
    const root = await temp()
    const out = join(root, "out")
    const touched: string[] = []
    const { value, err } = await captured(() =>
      main(["bun", "oauth-pilot.ts", "--live", "--oauth-data-dir", join(root, "data"), "--oauth-prepared", join(root, "prepared"), "--out", out], {
        ...tripwires(touched),
        repoRoot: root,
        gates: openEight,
        gateTable: async () => ({ ok: true, blob: "shipped" }),
      }),
    )
    expect(value).toBe(1)
    expect(touched).toEqual([])
    expect(existsSync(out)).toBe(false)
    expect(err).toContain("REFUSED: gate 8 (OAuth pilot spend authorization) is OPEN")
    expect(err).toContain("No host was started; the real auth target was not stat-ed")
  })

  test("with gate 8 edited to CLOSED but uncommitted: refused before the same touches", async () => {
    const root = await temp()
    const touched: string[] = []
    const closed = PAIRED_GATES.map((gate): PairedGate => (gate.number === 8 ? { ...gate, status: "CLOSED", evidence: "edited, not committed" } : gate))
    const { value, err } = await captured(() =>
      main(["bun", "oauth-pilot.ts", "--live", "--oauth-data-dir", join(root, "data"), "--oauth-prepared", join(root, "prepared"), "--out", join(root, "out")], {
        ...tripwires(touched),
        gates: closed,
        gateTable: async () => ({ ok: false, why: "ablation/paired-gates.ts differs from HEAD (` M ablation/paired-gates.ts`); a gate closes only by a committed change" }),
      }),
    )
    expect(value).toBe(1)
    expect(touched).toEqual([])
    expect(err).toContain("REFUSED: ablation/paired-gates.ts differs from HEAD")
  })
})

describe("a dry run against a stand-in host", () => {
  test("placeholders only, every CONNECT refused, no attempt returns a model answer; the evidence is written redacted", async () => {
    const root = await temp()
    const out = join(root, "out")
    const home = join(root, "user-home")
    const requests: HostRequest[] = []
    const stats: string[] = []
    const backend = scriptedBackend([(slot) => ({ ok: false, slot, failure: "model-error", message: "connection refused", tokens: emptyTokenUsage() })])
    const { value } = await captured(() =>
      main(["bun", "oauth-pilot.ts", "--out", out], {
        platform: "darwin",
        home,
        selfTest: async () => ({ ok: true, control: "connected", loopback: "connected", external: [{ target: "1.1.1.1:443", outcome: "refused: EPERM" }], why: "held" }),
        prepare: async (dir) => {
          await mkdir(dir, { recursive: true })
          return { ok: true }
        },
        startHost: standInHost(requests),
        backendFor: (_host, options) => {
          expect(options.timeoutMs).toBe(PILOT_TURN_TIMEOUT_MS)
          expect(options.tools).toEqual(PILOT_TOOLS)
          return backend
        },
        statAuthTarget: async (path) => {
          stats.push(path)
          return statAuthTarget(path)
        },
        sandboxDenials: async () => ({ ok: true, source: "stand-in", entries: [] }),
      }),
    )
    expect(value).toBe(0)
    expect(requests).toHaveLength(1)
    const request = requests[0]!
    expect(request.mode).toBe("dry")
    expect(request.route.providers).toEqual(["openai"])
    expect(request.route.models).toEqual([PILOT_MODEL])
    expect(request.route.dataDir).toContain("/placeholders/oauth-pilot/data")
    expect(request.route.home).not.toBe(home)
    // Only the placeholder target was stat-ed; the user's home was never touched.
    expect(stats).toHaveLength(2)
    for (const path of stats) {
      expect(path.startsWith(home)).toBe(false)
      expect(path).toContain("/placeholders/oauth-pilot/home/.local/share/opencode/auth.json")
    }
    const text = await readFile(join(out, EVIDENCE_FILE), "utf8")
    expect(text).not.toContain(out)
    expect(text).not.toContain("connection refused")
    const evidence = JSON.parse(text) as PilotEvidence
    expect(evidence.mode).toBe("dry")
    expect(evidence.authorization).toContain("not consulted")
    expect(evidence.anyAttemptAnswered).toBe(false)
    expect(evidence.backendCalls).toBe(1)
    expect(evidence.stop?.after).toBe("attempt 1")
    expect(evidence.thirdAdmission.asked).toBe(false)
    expect(evidence.proxy.allowedToTunnel).toEqual([])
    expect(evidence.wording).toEqual(EVIDENCE_WORDING)
    expect(evidence.journal.seededAttempts).toBe(PILOT_SEEDED)
    expect(evidence.journal.lines.map((line) => line.type)).toEqual(["issued", "settled"])
    expect(evidence.attempts[0]).toMatchObject({ answered: false, failure: "model-error", settlement: { kind: "usage", hostReportedTokensUnverified: emptyTokenUsage() } })
    expect(evidence.sandboxDenials).toEqual({ ok: true, source: "stand-in", entries: [] })
    expect(evidence.findings.find((finding) => finding.id === "D1")!.text).toContain("this dry run exercised attempt 1 (failed)")
    expect(text).not.toContain("no attempt settle")
  })

  test("a credential-bearing host error reaches the evidence only as an allowlisted category (2-8c6)", async () => {
    const root = await temp()
    const out = join(root, "out")
    const error = { name: "UnknownError", data: { message: `Token refresh failed: 401 Bearer ${INJECTED_SECRET}` } }
    const { value } = await captured(() =>
      main(["bun", "oauth-pilot.ts", "--out", out], {
        platform: "darwin",
        home: join(root, "user-home"),
        selfTest: async () => ({ ok: true, control: "connected", loopback: "connected", external: [{ target: "1.1.1.1:443", outcome: "refused: EPERM" }], why: "held" }),
        prepare: async (dir) => {
          await mkdir(dir, { recursive: true })
          return { ok: true }
        },
        startHost: standInHost([]),
        backendFor: (_host, options) => erroredOpencode(error, options),
        statAuthTarget,
        sandboxDenials: async () => ({ ok: true, source: "stand-in", entries: [] }),
      }),
    )
    expect(value).toBe(0)
    const text = await readFile(join(out, EVIDENCE_FILE), "utf8")
    expect(text).not.toContain(INJECTED_SECRET)
    expect(text).not.toContain("Bearer")
    expect(text).not.toContain("Token refresh failed")
    const evidence = JSON.parse(text) as PilotEvidence
    expect(evidence.attempts[0]).toMatchObject({
      answered: false,
      failure: "model-error",
      hostError: { category: "unrecognized", code: null },
      settlement: { kind: "unknown" },
    })
    // One copy of each statement, in the evidence's fixed wording; the scope does not repeat it.
    expect(evidence.wording.filter((line) => line.includes("the host's error message is omitted"))).toHaveLength(1)
    expect(evidence.wording.filter((line) => line.includes("all-zero host token object is settled `unknown`"))).toHaveLength(1)
    expect(evidence.scope.join(" ")).not.toContain("all-zero")
    expect(evidence.scope.join(" ")).not.toContain("message is omitted")
  })

  test("a failed sandbox self-test refuses and starts no host", async () => {
    const root = await temp()
    const touched: string[] = []
    const { value, err } = await captured(() =>
      main(["bun", "oauth-pilot.ts", "--out", join(root, "out")], {
        ...tripwires(touched),
        platform: "darwin",
        selfTest: async () => ({ ok: false, control: "connected", loopback: "connected", external: [], why: "the sandbox let 1.1.1.1:443 through" }),
      }),
    )
    expect(value).toBe(1)
    expect(touched).toEqual([])
    expect(err).toContain("the sandbox self-test failed")
  })

  test("a platform other than macOS refuses the pilot", async () => {
    const root = await temp()
    const { value, err } = await captured(() => main(["bun", "oauth-pilot.ts", "--out", join(root, "out")], { platform: "linux" }))
    expect(value).toBe(1)
    expect(err).toContain("runs only on macOS")
  })
})

describe("an authorized live run against stand-ins (gate table injected; nothing is reached)", () => {
  const closedEight = PAIRED_GATES.map((gate): PairedGate => (gate.number === 8 ? { ...gate, status: "CLOSED", evidence: "a test's stand-in authorization" } : gate))
  const facts = (mtimeNs: bigint) => ({ ok: true as const, size: 900n, mtimeNs, ino: 77n })

  async function liveRun(options: {
    backend: ModelBackend
    connects?: () => ProxyConnect[]
    startHost?: (request: HostRequest) => Promise<PilotHost>
    postStop?: { held: string[]; problems: string[] }
    denials?: SandboxDenials
    onStop?: () => StopOutcome | void
    statAuthTarget?: (path: string, count: number) => Promise<AuthTargetStat>
    repoRoot?: string
  }) {
    const root = await temp()
    const repoRoot = options.repoRoot ?? (await liveRepo())
    const dataDir = join(root, "data")
    const home = join(root, "home")
    const out = join(root, "out")
    const requests: HostRequest[] = []
    const proxies: (readonly string[])[] = []
    const stats: string[] = []
    let statCount = 0
    const run = await captured(() =>
      main(["bun", "oauth-pilot.ts", "--live", "--oauth-data-dir", dataDir, "--oauth-prepared", join(root, "prepared"), "--out", out], {
        home,
        platform: "darwin",
        repoRoot,
        gates: closedEight,
        gateTable: async () => ({ ok: true, blob: "committed" }),
        selfTest: async () => ({ ok: true, control: "connected", loopback: "connected", external: [{ target: "1.1.1.1:443", outcome: "refused: EPERM" }], why: "held" }),
        startProxy: (allowed) => {
          proxies.push(allowed)
          return { url: "http://127.0.0.1:1", connects: options.connects ?? (() => []), stop() {} }
        },
        startHost: options.startHost ?? standInHost(requests, options.postStop, options.onStop),
        backendFor: () => options.backend,
        statAuthTarget: async (path) => {
          stats.push(path)
          statCount += 1
          if (options.statAuthTarget !== undefined) return options.statAuthTarget(path, statCount)
          return { lstat: facts(statCount === 1 ? 5n : 6n), stat: facts(statCount === 1 ? 5n : 6n) }
        },
        sandboxDenials: async () => options.denials ?? { ok: true, source: "stand-in", entries: [] },
      }),
    )
    const text = existsSync(join(out, EVIDENCE_FILE)) ? await readFile(join(out, EVIDENCE_FILE), "utf8") : null
    const partialText = existsSync(join(out, PARTIAL_EVIDENCE_FILE)) ? await readFile(join(out, PARTIAL_EVIDENCE_FILE), "utf8") : null
    return {
      ...run,
      requests,
      proxies,
      stats,
      text,
      evidence: text === null ? null : (JSON.parse(text) as PilotEvidence),
      partial: partialText === null ? null : (JSON.parse(partialText) as Record<string, unknown> & { incomplete: string; kind: string; status: string }),
      failed: partialText === null ? null : (JSON.parse(partialText) as PilotEvidence & { status: string; incomplete: string; failures: string[] }),
      partialText,
      dataDir,
      home,
      out,
      repoRoot,
    }
  }

  test("two answered attempts, the third refused with 0 backend calls, the auth target recorded as flags; exit 0", async () => {
    const backend = scriptedBackend([answer, answer])
    const run = await liveRun({ backend })
    expect(run.value).toBe(0)
    expect(run.proxies).toEqual([PILOT_ALLOWED_CONNECTS])
    expect(run.requests[0]).toMatchObject({ mode: "live" })
    expect(run.requests[0]!.route).toMatchObject({ providers: ["openai"], models: [PILOT_MODEL], dataDir: run.dataDir, home: run.home })
    expect(run.stats).toEqual([join(run.home, ".local/share/opencode/auth.json"), join(run.home, ".local/share/opencode/auth.json")])
    const evidence = run.evidence!
    expect(evidence.mode).toBe("live")
    expect(evidence.stop).toBeNull()
    expect(evidence.backendCalls).toBe(2)
    expect(evidence.thirdAdmission).toMatchObject({ asked: true, backendCalls: 0, refusal: { cause: "budget" } })
    expect(evidence.attempts.map((attempt) => (attempt.settlement as { kind: string }).kind)).toEqual(["usage", "usage"])
    expect(evidence.attempts[0]!.settlement).toEqual({ kind: "usage", hostReportedTokensUnverified: tokens })
    expect(evidence.authTarget).toMatchObject({ flags: { stat: { size: "unchanged", mtime: "changed", inode: "unchanged" } } })
    expect(typeof evidence.authorization === "object" && evidence.authorization.ok).toBe(true)
    expect(evidence.sandbox).toMatchObject({ ok: true, profile: SANDBOX_PROFILE })
    expect(evidence.sandboxDenials).toEqual({ ok: true, source: "stand-in", entries: [] })
    expect(run.text).not.toContain(run.dataDir)
    expect(run.text).not.toContain(run.home)
    expect(evidence.findings.find((finding) => finding.id === "A1")!.text).toContain("backend calls 0")
  })

  test("a foreign CONNECT during attempt 1 stops the run: the second attempt is not sent, exit 1, the stop recorded", async () => {
    const seen: ProxyConnect[] = []
    const backend = scriptedBackend([
      (slot) => {
        seen.push(connect("registry.npmjs.org:443"))
        return answer(slot)
      },
      answer,
    ])
    const run = await liveRun({ backend, connects: () => seen })
    expect(run.value).toBe(1)
    expect(run.evidence).toBeNull()
    expect(run.failed!.status).toBe("FAILED")
    expect(backend.calls).toHaveLength(1)
    expect(run.failed!.stop?.reason).toContain("registry.npmjs.org:443")
    expect(run.failed!.proxy.connects[0]).toMatchObject({ target: "registry.npmjs.org:443", window: "attempt 1" })
  })

  test("Copilot at startup in the live run: refused, recorded with its time, no stop; both attempts run; exit 0", async () => {
    const seen: ProxyConnect[] = [connect(COPILOT_TARGET, Date.now() - 1_000)]
    const backend = scriptedBackend([answer, answer])
    const run = await liveRun({ backend, connects: () => seen })
    expect(run.value).toBe(0)
    expect(backend.calls).toHaveLength(2)
    expect(run.evidence!.stop).toBeNull()
    expect(run.evidence!.proxy.connects).toMatchObject([{ target: COPILOT_TARGET, outcome: "refused", window: BEFORE_FIRST_ASK, stopRule: "copilot-startup" }])
    expect(typeof run.evidence!.proxy.connects[0]!.atMs).toBe("number")
  })

  test("Copilot later in the live run: the same CONNECT during attempt 1 stops it; the second attempt is not sent", async () => {
    const seen: ProxyConnect[] = []
    const backend = scriptedBackend([
      (slot) => {
        seen.push(connect(COPILOT_TARGET))
        return answer(slot)
      },
      answer,
    ])
    const run = await liveRun({ backend, connects: () => seen })
    expect(run.value).toBe(1)
    expect(run.evidence).toBeNull()
    expect(run.failed!.status).toBe("FAILED")
    expect(backend.calls).toHaveLength(1)
    expect(run.failed!.stop?.reason).toContain(`to ${COPILOT_TARGET} after the first admission was asked`)
    expect(run.failed!.proxy.connects[0]).toMatchObject({ window: "attempt 1", stopRule: "stops" })
  })

  test("the transport ignores the proxy: the sandbox denies its direct connection, the attempt fails, the pilot fails closed and closes no gate", async () => {
    const backend = scriptedBackend([(slot) => ({ ok: false, slot, failure: "transport-error", message: "connect EPERM", tokens: emptyTokenUsage() }), answer])
    const denial = { atMs: 900, message: "Sandbox: opencode(4242) deny(1) network-outbound 192.0.2.10:443", namesHost: true }
    const run = await liveRun({ backend, denials: { ok: true, source: "stand-in", entries: [denial] } })
    expect(run.value).toBe(1)
    expect(run.evidence).toBeNull()
    expect(run.failed!.status).toBe("FAILED")
    expect(backend.calls).toHaveLength(1)
    expect(run.failed!.stop).toEqual({ reason: "attempt 1 ended in an error (transport-error)", after: "attempt 1" })
    expect(run.failed!.anyAttemptAnswered).toBe(false)
    expect(run.failed!.proxy.connects).toEqual([])
    expect(run.failed!.sandboxDenials).toEqual({ ok: true, source: "stand-in", entries: [denial] })
    expect(run.failed!.findings.find((finding) => finding.id === "E1")!.text).toContain(
      "sandbox denials the unified log reported over the host's window: 1, each counted against the host's process tree (1 naming the host's own process)",
    )
    expect(run.err).toContain("the unified log reported 1 sandbox denial(s) over the host's window, counted against the host's process tree: a connection went around the proxy")
    expect(run.failed!.gateEffect).toBe(GATE_EFFECT)
    expect(GATE_EFFECT).toContain("this command closes no gate: gate 7 stays OPEN")
  })

  test("a denial that does not name the host's pid still fails the live run: only the host's tree runs sandboxed", async () => {
    const denial = { atMs: 900, message: "Sandbox: node(5151) deny(1) network-outbound 192.0.2.10:443", namesHost: false }
    const run = await liveRun({ backend: scriptedBackend([answer, answer]), denials: { ok: true, source: "stand-in", entries: [denial] } })
    expect(run.value).toBe(1)
    expect(run.err).toContain("1 sandbox denial(s) over the host's window, counted against the host's process tree")
  })

  test("a denial log that could not be read fails the live run with the reason", async () => {
    const run = await liveRun({ backend: scriptedBackend([answer, answer]), denials: { ok: false, source: "stand-in", why: "it exited 64: log: invalid predicate" } })
    expect(run.value).toBe(1)
    expect(run.evidence).toBeNull()
    expect(run.failed!.status).toBe("FAILED")
    expect(run.err).toContain("the sandbox denials could not be read (it exited 64: log: invalid predicate), so a connection around the proxy cannot be ruled out")
    expect(run.failed!.sandboxDenials).toMatchObject({ ok: false })
  })

  test("the proxy log is checked again after the host stops: a foreign CONNECT after the last check fails the exit code", async () => {
    const seen: ProxyConnect[] = []
    const run = await liveRun({
      backend: scriptedBackend([answer, answer]),
      connects: () => seen,
      onStop: () => void seen.push(connect("telemetry.example:443", Date.now())),
    })
    expect(run.value).toBe(1)
    expect(run.evidence).toBeNull()
    expect(run.failed!.status).toBe("FAILED")
    expect(run.failed!.stop).toBeNull()
    expect(run.failed!.proxy.afterStop).toHaveLength(1)
    expect(run.err).toContain("a proxy-observed CONNECT the stop rule rejects")
    expect(run.err).toContain("telemetry.example:443")
  })

  test("a tunnelled allowed-host CONNECT outside every attempt fails the exit code; one inside an attempt does not", async () => {
    const seen: ProxyConnect[] = []
    const backend = scriptedBackend([
      (slot) => {
        seen.push(connect("chatgpt.com:443", Date.now(), "tunnelled"))
        return answer(slot)
      },
      answer,
    ])
    const run = await liveRun({ backend, connects: () => seen, onStop: () => void seen.push(connect("auth.openai.com:443", Date.now() + 50, "tunnelled")) })
    expect(run.value).toBe(1)
    expect(run.evidence).toBeNull()
    expect(run.failed!.status).toBe("FAILED")
    expect(run.failed!.proxy.afterStop).toEqual([expect.stringContaining("a CONNECT was tunnelled outside every attempt")])
    expect(run.failed!.proxy.afterStop[0]).toContain("auth.openai.com:443")
    expect(run.failed!.proxy.afterStop[0]).toContain("after the last settled line")
  })

  test("an unconfirmed host exit after an admission: INCOMPLETE partial evidence with the sequence and the journal, never the full file; exit 1", async () => {
    const run = await liveRun({ backend: scriptedBackend([answer, answer]), onStop: () => ({ confirmed: false, pid: 4242, why: "still running after SIGKILL" }) })
    expect(run.value).toBe(1)
    expect(run.evidence).toBeNull()
    expect(run.partial!.kind).toStartWith("INCOMPLETE — ")
    expect(run.partial!.incomplete).toContain("the managed host's exit is UNCONFIRMED")
    expect(run.partial!.backendCalls).toBe(2)
    expect((run.partial!.journal as { root: string; lines: { type: string }[] }).root).toBe("<out>/journal")
    expect((run.partial!.journal as { lines: { type: string }[] }).lines.map((line) => line.type)).toContain("issued")
    expect(run.partialText).not.toContain(run.dataDir)
    expect(run.err).toContain("INCOMPLETE — ")
  })

  test("an error after the journal closed still leaves INCOMPLETE partial evidence; exit 1", async () => {
    const run = await liveRun({
      backend: scriptedBackend([answer, answer]),
      statAuthTarget: async (_path, count) => {
        if (count === 2) throw new Error("the stat seam failed")
        return { lstat: facts(5n), stat: facts(5n) }
      },
    })
    expect(run.value).toBe(1)
    expect(run.evidence).toBeNull()
    expect(run.partial!.incomplete).toContain("the stat seam failed")
    expect((run.partial!.attempts as unknown[]).length).toBe(2)
  })

  test("a refused host start is a preflight stop: no attempt, INCOMPLETE evidence written, exit 1", async () => {
    const backend = scriptedBackend([])
    const run = await liveRun({
      backend,
      startHost: async () => {
        throw new HostRefused("the managed host was refused: the OAuth data directory is refused: session=3", undefined, null)
      },
    })
    expect(run.value).toBe(1)
    expect(run.evidence).toBeNull()
    expect(run.failed!.status).toBe("FAILED")
    expect(backend.calls).toHaveLength(0)
    expect(run.failed!.host).toBeNull()
    expect(run.failed!.stop?.reason).toContain("a preflight failure")
    expect(run.failed!.stop?.reason).toContain("session=3")
  })

  test("a post-stop failure fails the exit code", async () => {
    const run = await liveRun({ backend: scriptedBackend([answer, answer]), postStop: { held: [], problems: ["the store guard found session=1 after the stop"] } })
    expect(run.value).toBe(1)
    expect(run.evidence).toBeNull()
    expect(run.failed!.status).toBe("FAILED")
    expect(run.err).toContain("session=1 after the stop")
    expect(run.failed!.storeGuardAndSymlink.postStop?.problems).toEqual(["the store guard found session=1 after the stop"])
  })

  describe("a failed live run never writes oauth-pilot.json", () => {
    const diagnostics = (failed: PilotEvidence & { status: string; failures: string[] }) => {
      expect(failed.kind).toStartWith("INCOMPLETE — ")
      expect(failed.status).toBe("FAILED")
      expect(failed.failures.length).toBeGreaterThan(0)
      expect(failed.attempts.length).toBeGreaterThan(0)
      expect(Array.isArray(failed.proxy.afterStop)).toBe(true)
      expect(typeof failed.sandboxDenials).toBe("object")
      expect(failed.storeGuardAndSymlink.postStop).not.toBeNull()
      expect(failed.reservation).toMatchObject({ proposalSha256: OAUTH_PILOT_PROPOSAL.sha256, out: "<out>" })
      expect(failed.authTarget).toMatchObject({ flags: { stat: { size: "unchanged" } } })
    }

    test("a first-attempt failure: exit 1, INCOMPLETE with a FAILED status and every diagnostic, no oauth-pilot.json", async () => {
      const run = await liveRun({ backend: scriptedBackend([(slot) => ({ ok: false, slot, failure: "model-error", message: "refused", tokens: emptyTokenUsage() }), answer]) })
      expect(run.value).toBe(1)
      expect(existsSync(join(run.out, EVIDENCE_FILE))).toBe(false)
      diagnostics(run.failed!)
      expect(run.failed!.stop).toEqual({ reason: "attempt 1 ended in an error (model-error)", after: "attempt 1" })
      expect(run.failed!.failures).toContain("the pilot stopped after attempt 1: attempt 1 ended in an error (model-error)")
    })

    test("a post-stop sandbox denial after two answered attempts: exit 1, INCOMPLETE with the denial, no oauth-pilot.json", async () => {
      const denial = { atMs: 5, message: "Sandbox: opencode(4242) deny(1) network-outbound 192.0.2.20:443", namesHost: true }
      const run = await liveRun({ backend: scriptedBackend([answer, answer]), denials: { ok: true, source: "stand-in", entries: [denial] } })
      expect(run.value).toBe(1)
      expect(existsSync(join(run.out, EVIDENCE_FILE))).toBe(false)
      diagnostics(run.failed!)
      expect(run.failed!.stop).toBeNull()
      expect(run.failed!.thirdAdmission).toMatchObject({ refusal: { cause: "budget" } })
      expect(run.failed!.sandboxDenials).toEqual({ ok: true, source: "stand-in", entries: [denial] })
      expect(run.failed!.failures).toEqual([expect.stringContaining("1 sandbox denial(s) over the host's window")])
    })

    test("a cleanup failure after a run that would exit 0 demotes the evidence to INCOMPLETE: exit 1, no oauth-pilot.json", async () => {
      const repoRoot = await liveRepo()
      const root = await temp()
      const out = join(root, "out")
      const closed = PAIRED_GATES.map((gate): PairedGate => (gate.number === 8 ? { ...gate, status: "CLOSED", evidence: "stand-in" } : gate))
      const { value, err } = await captured(() =>
        main(["bun", "oauth-pilot.ts", "--live", "--oauth-data-dir", join(root, "data"), "--oauth-prepared", join(root, "prepared"), "--out", out], {
          home: join(root, "home"),
          platform: "darwin",
          repoRoot,
          gates: closed,
          gateTable: async () => ({ ok: true, blob: "committed" }),
          selfTest: heldSelfTest,
          startProxy: () => ({
            url: "http://127.0.0.1:1",
            connects: () => [],
            stop() {
              throw new Error("the proxy would not stop")
            },
          }),
          startHost: standInHost([]),
          backendFor: () => scriptedBackend([answer, answer]),
          statAuthTarget: async () => ({ lstat: { ok: true, size: 1n, mtimeNs: 1n, ino: 1n }, stat: { ok: true, size: 1n, mtimeNs: 1n, ino: 1n } }),
          sandboxDenials: async () => ({ ok: true, source: "stand-in", entries: [] }),
        }),
      )
      expect(value).toBe(1)
      expect(err).toContain("the proxy would not stop")
      expect(existsSync(join(out, EVIDENCE_FILE))).toBe(false)
      const failed = JSON.parse(await readFile(join(out, PARTIAL_EVIDENCE_FILE), "utf8")) as { status: string; failures: string[]; backendCalls: number }
      expect(failed.status).toBe("FAILED")
      expect(failed.failures).toEqual(["after the run: a local server did not stop: the proxy would not stop"])
      expect(failed.backendCalls).toBe(2)
    })
  })

  describe("the durable one-run reservation", () => {
    const reservationAt = (repoRoot: string) => join(repoRoot, RUN_2_RESERVATION)

    test("an authorized run creates run 2's reservation, recording the run, its time, the gate table's blob, the pinned proposal and --out; the evidence records it; run 1's files are untouched", async () => {
      const repoRoot = await liveRepo()
      const priorFiles = OAUTH_PILOT_RUN.prior.flatMap((prior) => [prior.reservation, prior.evidence])
      const before = await Promise.all(priorFiles.map((path) => readFile(join(repoRoot, path))))
      const run = await liveRun({ backend: scriptedBackend([answer, answer]), repoRoot })
      expect(run.value).toBe(0)
      expect(run.requests).toHaveLength(1)
      const written = JSON.parse(await readFile(reservationAt(run.repoRoot), "utf8")) as Record<string, unknown>
      expect(written).toMatchObject({ run: 2, story: "2-8c7", gateTableBlob: "committed", proposalSha256: OAUTH_PILOT_PROPOSAL.sha256, out: run.out })
      expect(Date.parse(written.createdAt as string)).not.toBeNaN()
      expect(run.evidence!.reservation).toMatchObject({ run: 2, story: "2-8c7", proposalSha256: OAUTH_PILOT_PROPOSAL.sha256, out: "<out>" })
      const after = await Promise.all(priorFiles.map((path) => readFile(join(repoRoot, path))))
      for (const [index, bytes] of after.entries()) expect(bytes.equals(before[index]!), priorFiles[index]).toBe(true)
      expect(await readFile(join(repoRoot, OAUTH_PILOT_RUN.prior[0]!.reservation))).toEqual(await readFile(join(REPO, OAUTH_PILOT_RUN.prior[0]!.reservation)))
    })

    test("a second run with a different --out refuses before any host, stat, proxy or data-directory touch", async () => {
      const first = await liveRun({ backend: scriptedBackend([answer, answer]) })
      expect(first.value).toBe(0)
      const root = await temp()
      const touched: string[] = []
      const { value, err } = await captured(() =>
        main(["bun", "oauth-pilot.ts", "--live", "--oauth-data-dir", join(root, "data"), "--oauth-prepared", join(root, "prepared"), "--out", join(root, "second-out")], {
          ...tripwires(touched),
          platform: "darwin",
          repoRoot: first.repoRoot,
          gates: closedEight,
          gateTable: async () => ({ ok: true, blob: "committed" }),
        }),
      )
      expect(value).toBe(1)
      expect(touched).toEqual([])
      expect(existsSync(join(root, "second-out"))).toBe(false)
      expect(err).toContain(`REFUSED: run 2's reservation \`${RUN_2_RESERVATION}\` already exists (`)
    })

    test("run 2's reservation left by a failed or interrupted run, committed, untracked or ignored, refuses", async () => {
      const uncommitted = await liveRepo()
      await writeFile(reservationAt(uncommitted), '{"run":2,"story":"2-8c7","note":"an interrupted run"}\n')
      const committedRoot = await liveRepo(async (dir) => writeFile(join(dir, RUN_2_RESERVATION), "{}\n"))
      await rm(reservationAt(committedRoot))
      const ignored = await liveRepo(async (dir) => writeFile(join(dir, ".gitignore"), `/${RUN_2_RESERVATION}\n`))
      await writeFile(reservationAt(ignored), "{}\n")
      for (const [repoRoot, expected] of [
        [uncommitted, `run 2's reservation \`${RUN_2_RESERVATION}\` already exists (untracked, in ablation/evidence)`],
        [committedRoot, `run 2's reservation \`${RUN_2_RESERVATION}\` already exists (committed)`],
        [ignored, `run 2's reservation \`${RUN_2_RESERVATION}\` already exists (in ablation/evidence)`],
      ] as const) {
        const root = await temp()
        const touched: string[] = []
        const { value, err } = await captured(() =>
          main(["bun", "oauth-pilot.ts", "--live", "--oauth-data-dir", join(root, "data"), "--oauth-prepared", join(root, "prepared"), "--out", join(root, "out")], {
            ...tripwires(touched),
            platform: "darwin",
            repoRoot,
            gates: closedEight,
            gateTable: async () => ({ ok: true, blob: "committed" }),
          }),
        )
        expect(value).toBe(1)
        expect(touched).toEqual([])
        expect(err).toContain(expected)
      }
    })

    test("two concurrent invocations: exactly one reservation and one refusal", async () => {
      const repoRoot = await liveRepo()
      const [a, b] = await Promise.all([
        liveRun({ backend: scriptedBackend([answer, answer]), repoRoot }),
        liveRun({ backend: scriptedBackend([answer, answer]), repoRoot }),
      ])
      expect([a.value, b.value].sort()).toEqual([0, 1])
      const loser = a.value === 1 ? a : b
      const winner = a.value === 0 ? a : b
      // Both runs spy on the same console concurrently, so a refusal may land in either capture.
      expect(`${a.err}\n${b.err}`).toMatch(/REFUSED: run 2's reservation `ablation\/evidence\/oauth-pilot-live-run-2\.reservation` already exists/)
      expect(loser.requests).toEqual([])
      expect(loser.stats).toEqual([])
      expect(loser.proxies).toEqual([])
      const written = JSON.parse(await readFile(join(repoRoot, RUN_2_RESERVATION), "utf8")) as { out: string; run: number }
      expect(written.run).toBe(2)
      expect(written.out).toBe(winner.out)
    })

    test("the reservation survives a failed run and an unconfirmed exit: nothing deletes it", async () => {
      const failed = await liveRun({ backend: scriptedBackend([(slot) => ({ ok: false, slot, failure: "model-error", message: "refused", tokens: emptyTokenUsage() })]) })
      expect(failed.value).toBe(1)
      expect(existsSync(reservationAt(failed.repoRoot))).toBe(true)
      const unconfirmed = await liveRun({ backend: scriptedBackend([answer, answer]), onStop: () => ({ confirmed: false, pid: 4242, why: "still running" }) })
      expect(unconfirmed.value).toBe(1)
      expect(existsSync(reservationAt(unconfirmed.repoRoot))).toBe(true)
      expect(unconfirmed.partial!.reservation).toMatchObject({ proposalSha256: OAUTH_PILOT_PROPOSAL.sha256, out: "<out>" })
    })
  })
})

describe("the host is sandboxed in both modes", () => {
  test("the managed host's options spawn it through sandboxSpawn, dry and live, with the pilot's proxy", () => {
    for (const mode of ["dry", "live"] as const) {
      const request: HostRequest = {
        mode,
        route: { providers: ["openai"], models: [PILOT_MODEL], dataDir: "/d", prepared: "/p", home: "/h" },
        proxy: "http://127.0.0.1:9",
        scratchParent: "/s",
        workDir: "/s/work",
        onSpawn: () => undefined,
      }
      const options = pilotHostOptions(request, () => undefined)
      expect(options.spawn).toBe(sandboxSpawn)
      expect(options.proxy).toBe("http://127.0.0.1:9")
    }
  })
})

/**
 * The pilot's arrangement end to end, on loopback only: a process under
 * `SANDBOX_PROFILE` whose one way out is the allowlisting proxy, running outside
 * the sandbox. The allowed name is synthetic (`.invalid`), and the proxy resolves
 * it to a loopback stand-in; the refused name is never resolved; the direct
 * connection goes to 192.0.2.1 (TEST-NET-1, never routed). Nothing here reaches a
 * provider or any external host.
 */
describe("a sandboxed process behind the allowlisting proxy", () => {
  const SCRIPT = `
const within = (ms, promise) => Promise.race([promise, new Promise((done) => setTimeout(() => done("no answer within " + ms + " ms"), ms))])
const why = (e) => (e && (e.code || e.message))
const talk = (head, payload) => within(5000, new Promise((done) => {
  let text = ""
  let sent = false
  Bun.connect({ hostname: "127.0.0.1", port: Number(process.env.PROXY_PORT), socket: {
    open(s) { s.write(head) },
    data(s, chunk) {
      text += Buffer.from(chunk).toString("latin1")
      if (payload !== undefined && !sent && text.startsWith("HTTP/1.1 200") && text.includes("\\r\\n\\r\\n")) { sent = true; s.write(payload) }
      if (payload !== undefined && text.endsWith(payload)) s.end()
    },
    close() { done(text) },
    error(_s, e) { done("error: " + why(e)) },
    connectError(_s, e) { done("refused: " + why(e)) },
  } }).catch((e) => done("refused: " + why(e)))
}))
const tcp = (hostname, port) => within(5000, new Promise((done) => {
  Bun.connect({ hostname, port, socket: { open(s) { s.end(); done("connected") }, data() {}, error(_s, e) { done("refused: " + why(e)) }, connectError(_s, e) { done("refused: " + why(e)) } } })
    .catch((e) => done("refused: " + why(e)))
}))
const out = {
  allowed: await talk("CONNECT pilot-allowed.invalid:443 HTTP/1.1\\r\\nHost: pilot-allowed.invalid:443\\r\\n\\r\\n", "ping through the tunnel"),
  other: await talk("CONNECT not-allowed.invalid:443 HTTP/1.1\\r\\n\\r\\n"),
  direct: await tcp("192.0.2.1", 443),
  loopback: await tcp("127.0.0.1", Number(process.env.STAND_IN_PORT)),
}
console.log(JSON.stringify(out))
`

  test.skipIf(process.platform !== "darwin" || !existsSync(SANDBOX_EXEC))(
    "the allowed synthetic host is tunnelled to its loopback stand-in, another host is refused, and a direct connection is denied by the sandbox, unseen by the proxy",
    async () => {
      let standInConnections = 0
      const standIn = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          open() {
            standInConnections += 1
          },
          data(socket, chunk) {
            socket.write(chunk)
          },
        },
      })
      const resolved: [string, number][] = []
      const proxy = startAllowlistProxy(["pilot-allowed.invalid:443"], {
        resolve: (host, port) => {
          resolved.push([host, port])
          return { hostname: "127.0.0.1", port: standIn.port }
        },
      })
      try {
        const child = Bun.spawn({
          cmd: [SANDBOX_EXEC, "-p", SANDBOX_PROFILE, process.execPath, "-e", SCRIPT],
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: tmpdir(), PROXY_PORT: String(proxy.port), STAND_IN_PORT: String(standIn.port) },
        })
        const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        const seen = JSON.parse(stdout.trim().split("\n").pop() ?? "null") as { allowed: string; other: string; direct: string; loopback: string } | null
        expect(seen, stderr).not.toBeNull()
        expect(seen!.allowed.startsWith("HTTP/1.1 200 Connection Established\r\n\r\n")).toBe(true)
        expect(seen!.allowed.endsWith("ping through the tunnel")).toBe(true)
        expect(seen!.other.startsWith("HTTP/1.1 403 Forbidden")).toBe(true)
        expect(seen!.direct).toStartWith("refused")
        expect(seen!.loopback).toBe("connected")
        // The tunnel and the loopback check reached the stand-in; the refused host was never resolved.
        expect(standInConnections).toBe(2)
        expect(resolved).toEqual([["pilot-allowed.invalid", 443]])
        // The proxy saw exactly the two CONNECTs sent to it; the sandbox-denied direct connection is not in its log.
        expect(proxy.connects().map((entry) => [entry.target, entry.outcome])).toEqual([
          ["pilot-allowed.invalid:443", "tunnelled"],
          ["not-allowed.invalid:443", "refused"],
        ])
      } finally {
        proxy.stop()
        standIn.stop(true)
      }
    },
    30_000,
  )
})

// ---------------------------------------------------------------------------
// Review batch: denials, one-run authorization, wiring, deadlines, interruption
// ---------------------------------------------------------------------------

const PROPOSAL_SOURCE = new URL(`../${OAUTH_PILOT_PROPOSAL.path}`, import.meta.url).pathname
/** This repository, whose committed run-1 files the fixtures copy. */
const REPO = new URL("../", import.meta.url).pathname
const RUN_2_RESERVATION = oauthPilotReservation(OAUTH_PILOT_RUN.run)
const RUN_1 = OAUTH_PILOT_RUN.prior[0]!

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-c", "user.name=pilot-test", "-c", "user.email=pilot-test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
}

/**
 * A temp repository holding copies of the pinned exposure document and of run 1's
 * committed reservation and evidence, with one commit; `setup` runs before it.
 */
async function liveRepo(setup: (root: string) => Promise<void> = async () => undefined): Promise<string> {
  const root = await temp()
  git(root, "init", "-q")
  await mkdir(join(root, OAUTH_PILOT_PROPOSAL.path, ".."), { recursive: true })
  await writeFile(join(root, OAUTH_PILOT_PROPOSAL.path), await readFile(PROPOSAL_SOURCE))
  await mkdir(join(root, LIVE_EVIDENCE_DIR), { recursive: true })
  await writeFile(join(root, LIVE_EVIDENCE_DIR, "oauth-pilot-dryrun-2026-09-28.json"), "{}\n")
  for (const prior of OAUTH_PILOT_RUN.prior) {
    for (const path of [prior.reservation, prior.evidence]) await writeFile(join(root, path), await readFile(join(REPO, path)))
  }
  await setup(root)
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "fixture")
  return root
}

const heldSelfTest = async () => ({ ok: true, control: "connected", loopback: "connected", external: [{ target: "1.1.1.1:443", outcome: "refused: EPERM" }], why: "held" })

describe("sandbox denials from the unified log", () => {
  const from = Date.parse("2026-09-28T14:42:00.000+02:00")
  const window = { from, to: from + 10_000, hostPid: 4242, started: from - 1_000 }
  const line = (timestamp: string, eventMessage: string) => JSON.stringify({ timestamp, eventMessage, processID: 0, subsystem: "", category: "" })

  test("the macOS timestamp, with its +0200 offset, is read to the millisecond", () => {
    expect(logTimestamp("2026-09-28 14:42:05.993456+0200")).toBe(Date.parse("2026-09-28T12:42:05.993Z"))
    expect(logTimestamp("2026-09-28 14:42:05.993456-0530")).toBe(Date.parse("2026-09-28T20:12:05.993Z"))
    expect(Number.isNaN(logTimestamp("yesterday"))).toBe(true)
  })

  test("host and other processes are both kept, the host's marked; outside the window, non-Sandbox and unreadable lines are dropped", () => {
    const ndjson = [
      line("2026-09-28 14:42:05.993456+0200", "Sandbox: opencode(4242) deny(1) network-outbound 192.0.2.10:443"),
      line("2026-09-28 14:42:06.100000+0200", "Sandbox: node(5151) deny(1) network-outbound 192.0.2.11:443"),
      line("2026-09-28 14:42:10.500000+0200", "Sandbox: opencode(4242) deny(1) network-outbound 192.0.2.12:443"),
      line("2026-09-28 14:41:59.000000+0200", "Sandbox: opencode(4242) deny(1) network-outbound 192.0.2.13:443"),
      line("2026-09-28 14:42:07.000000+0200", "kernel: network-outbound something else"),
      line("not a time", "Sandbox: opencode(4242) deny(1) network-outbound 192.0.2.14:443"),
      "{ not json",
      "",
    ].join("\n")
    expect(denialEntries(ndjson, window)).toEqual([
      { atMs: 6_993, message: "Sandbox: opencode(4242) deny(1) network-outbound 192.0.2.10:443", namesHost: true },
      { atMs: 7_100, message: "Sandbox: node(5151) deny(1) network-outbound 192.0.2.11:443", namesHost: false },
      { atMs: null, message: "Sandbox: opencode(4242) deny(1) network-outbound 192.0.2.14:443", namesHost: true },
    ])
  })

  test("a denial in the dry run fails its exit code, whatever process it names", async () => {
    const root = await temp()
    const out = join(root, "out")
    const { value, err } = await captured(() =>
      main(["bun", "oauth-pilot.ts", "--out", out], {
        platform: "darwin",
        home: join(root, "home"),
        selfTest: heldSelfTest,
        prepare: async (dir) => {
          await mkdir(dir, { recursive: true })
          return { ok: true }
        },
        startHost: standInHost([]),
        backendFor: () => scriptedBackend([(slot) => ({ ok: false, slot, failure: "model-error", message: "refused", tokens: emptyTokenUsage() })]),
        sandboxDenials: async () => ({ ok: true, source: "stand-in", entries: [{ atMs: 10, message: "Sandbox: bun(777) deny(1) network-outbound 192.0.2.1:443", namesHost: false }] }),
      }),
    )
    expect(value).toBe(1)
    expect(err).toContain("1 sandbox denial(s) over the host's window, counted against the host's process tree")
  })
})

describe("the dry run's exit guards", () => {
  async function dryRun(options: { backend: ModelBackend; connects?: () => ProxyConnect[] }) {
    const root = await temp()
    const out = join(root, "out")
    const run = await captured(() =>
      main(["bun", "oauth-pilot.ts", "--out", out], {
        platform: "darwin",
        home: join(root, "home"),
        selfTest: heldSelfTest,
        prepare: async (dir) => {
          await mkdir(dir, { recursive: true })
          return { ok: true }
        },
        startProxy: () => ({ url: "http://127.0.0.1:1", connects: options.connects ?? (() => []), stop() {} }),
        startHost: standInHost([]),
        backendFor: () => options.backend,
        sandboxDenials: async () => ({ ok: true, source: "stand-in", entries: [] }),
      }),
    )
    return { ...run, out }
  }

  test("an attempt that returned a model answer fails the dry run: INCOMPLETE only, never oauth-pilot.json", async () => {
    const { value, err, out } = await dryRun({ backend: scriptedBackend([answer, answer]) })
    expect(value).toBe(1)
    expect(err).toContain("an attempt returned a model answer in the dry run")
    expect(existsSync(join(out, EVIDENCE_FILE))).toBe(false)
    const failed = JSON.parse(await readFile(join(out, PARTIAL_EVIDENCE_FILE), "utf8")) as { status: string; failures: string[] }
    expect(failed.status).toBe("FAILED")
    expect(failed.failures).toContain("an attempt returned a model answer in the dry run")
  })

  test("a tunnelled connection fails the dry run", async () => {
    const tunnelled = [connect("chatgpt.com:443", Date.now() - 1_000, "tunnelled")]
    const { value, err } = await dryRun({ backend: scriptedBackend([(slot) => ({ ok: false, slot, failure: "model-error", message: "x", tokens: emptyTokenUsage() })]), connects: () => tunnelled })
    expect(value).toBe(1)
    expect(err).toContain("1 connection(s) were not refused in the dry run")
  })
})

describe("gate 8 authorizes one run", () => {
  const closedEight = PAIRED_GATES.map((gate): PairedGate => (gate.number === 8 ? { ...gate, status: "CLOSED", evidence: "a test's stand-in authorization" } : gate))

  test("the pin is the exposure document's sha256, and gate 8's requirement cites it", async () => {
    const digest = new Bun.CryptoHasher("sha256").update(await readFile(PROPOSAL_SOURCE)).digest("hex")
    expect(digest).toBe(OAUTH_PILOT_PROPOSAL.sha256)
    const eight = PAIRED_GATES.find((gate) => gate.number === 8)!
    expect(eight.requires).toContain(`(sha256 ${OAUTH_PILOT_PROPOSAL.sha256}; \`--live\` refuses if the file differs)`)
    expect(eight.requires).toContain("the budget owner re-opens this gate after the run")
    expect(eight.requires).toContain("the budget owner authorizes run 2 (`OAUTH_PILOT_RUN`, story 2-8c7)")
    expect(eight.requires).toContain(`creates ${RUN_2_RESERVATION} exclusively`)
  })

  test("the committed run identity is run 2, with run 1's legacy files as its one prior run", () => {
    expect(OAUTH_PILOT_RUN).toEqual({
      run: 2,
      prior: [
        {
          run: 1,
          reservation: "ablation/evidence/oauth-pilot-live.reservation",
          evidence: "ablation/evidence/oauth-pilot-live-2026-09-28.json",
          proposalSha256: "1245e11370e7df1e9f73a9c2b356334327c315ef0d079c9bd208c275df893402",
        },
      ],
    })
    expect(runIdentityProblems(OAUTH_PILOT_RUN)).toEqual([])
    expect(RUN_2_RESERVATION).toBe("ablation/evidence/oauth-pilot-live-run-2.reservation")
  })

  async function refusedLive(repoRoot: string, prepareOut?: (out: string) => Promise<void>, pilotRun?: OAuthPilotRun) {
    const root = await temp()
    const out = join(root, "out")
    await prepareOut?.(out)
    const touched: string[] = []
    const evidenceBefore = await readdir(join(repoRoot, LIVE_EVIDENCE_DIR)).catch(() => [] as string[])
    const run = await captured(() =>
      main(["bun", "oauth-pilot.ts", "--live", "--oauth-data-dir", join(root, "data"), "--oauth-prepared", join(root, "prepared"), "--out", out], {
        ...tripwires(touched),
        repoRoot,
        gates: closedEight,
        gateTable: async () => ({ ok: true, blob: "committed" }),
        ...(pilotRun === undefined ? {} : { pilotRun }),
      }),
    )
    expect(run.value).toBe(1)
    expect(touched).toEqual([])
    // No reservation, nor any other file, was created in the evidence directory.
    expect(await readdir(join(repoRoot, LIVE_EVIDENCE_DIR)).catch(() => [] as string[])).toEqual(evidenceBefore)
    return { ...run, touched, out }
  }

  test("an unchanged pin and no earlier run: the one-run checks pass", async () => {
    const root = await liveRepo()
    expect(await oneRunProblems(root, join(root, "no-out"), defaultGitForTest())).toEqual([])
  })

  test("the exposure document changed after the pin, or is missing: refused before any host, stat or connection", async () => {
    const changed = await liveRepo()
    await writeFile(join(changed, OAUTH_PILOT_PROPOSAL.path), "a different exposure\n")
    const run = await refusedLive(changed)
    expect(run.value).toBe(1)
    expect(run.touched).toEqual([])
    expect(existsSync(run.out)).toBe(false)
    expect(run.err).toContain(`REFUSED: ${OAUTH_PILOT_PROPOSAL.path} changed after gate 8 pinned it`)
    const missing = await liveRepo()
    await rm(join(missing, OAUTH_PILOT_PROPOSAL.path))
    const gone = await refusedLive(missing)
    expect(gone.value).toBe(1)
    expect(gone.err).toContain("the exposure document gate 8 pins, could not be read")
  })

  test("an undeclared live file, committed (anywhere), untracked or ignored, refuses as unaccounted", async () => {
    const committed = await liveRepo(async (dir) => {
      await writeFile(join(dir, LIVE_EVIDENCE_DIR, "oauth-pilot-live-2026-10-01.json"), "{}\n")
      await mkdir(join(dir, "docs"), { recursive: true })
      await writeFile(join(dir, "docs", "oauth-pilot-live-copy.json"), "{}\n")
    })
    await rm(join(committed, LIVE_EVIDENCE_DIR, "oauth-pilot-live-2026-10-01.json"))
    const one = await refusedLive(committed)
    expect(one.err).toContain("`ablation/evidence/oauth-pilot-live-2026-10-01.json` (committed) is an unaccounted live pilot file")
    expect(one.err).toContain("`docs/oauth-pilot-live-copy.json` (committed) is an unaccounted live pilot file")
    const untracked = await liveRepo()
    await writeFile(join(untracked, LIVE_EVIDENCE_DIR, "oauth-pilot-live-2026-10-02.json"), "{}\n")
    await writeFile(join(untracked, "oauth-pilot-live-run-3.reservation"), "{}\n")
    const two = await refusedLive(untracked)
    expect(two.err).toContain("`ablation/evidence/oauth-pilot-live-2026-10-02.json` (untracked, in ablation/evidence) is an unaccounted live pilot file")
    expect(two.err).toContain("`oauth-pilot-live-run-3.reservation` (untracked) is an unaccounted live pilot file")
    const ignored = await liveRepo(async (dir) => writeFile(join(dir, ".gitignore"), "/ablation/evidence/*.tmp\n"))
    await writeFile(join(ignored, LIVE_EVIDENCE_DIR, "oauth-pilot-live-scratch.tmp"), "x")
    const three = await refusedLive(ignored)
    expect(three.err).toContain("`ablation/evidence/oauth-pilot-live-scratch.tmp` (in ablation/evidence) is an unaccounted live pilot file")
  })

  test("run 2's evidence, committed or in the tree, refuses: run 2 has already run", async () => {
    const name = "oauth-pilot-live-run-2-2026-10-01.json"
    const committed = await liveRepo(async (dir) => writeFile(join(dir, LIVE_EVIDENCE_DIR, name), "{}\n"))
    expect((await refusedLive(committed)).err).toContain(`run 2's evidence \`${LIVE_EVIDENCE_DIR}/${name}\` already exists (committed, in ablation/evidence): run 2 has already run`)
    const untracked = await liveRepo()
    await writeFile(join(untracked, LIVE_EVIDENCE_DIR, name), "{}\n")
    expect((await refusedLive(untracked)).err).toContain(`run 2's evidence \`${LIVE_EVIDENCE_DIR}/${name}\` already exists (untracked, in ablation/evidence)`)
  })

  test("run 1's reservation or evidence missing, uncommitted, edited or malformed: exit 1 naming the file and why", async () => {
    const missing = await liveRepo()
    await rm(join(missing, RUN_1.reservation))
    expect((await refusedLive(missing)).err).toContain(`REFUSED: run 1's reservation \`${RUN_1.reservation}\` is missing or modified (\` D ${RUN_1.reservation}\`)`)

    const uncommitted = await liveRepo()
    git(uncommitted, "rm", "-q", "--cached", RUN_1.evidence)
    git(uncommitted, "commit", "-q", "-m", "uncommit run 1's evidence")
    expect((await refusedLive(uncommitted)).err).toContain(`REFUSED: run 1's evidence \`${RUN_1.evidence}\` is not committed`)

    const edited = await liveRepo()
    await writeFile(join(edited, RUN_1.evidence), `${await readFile(join(edited, RUN_1.evidence), "utf8")} `)
    expect((await refusedLive(edited)).err).toContain(`REFUSED: run 1's evidence \`${RUN_1.evidence}\` is missing or modified (\` M ${RUN_1.evidence}\`)`)

    const notJson = await liveRepo(async (dir) => writeFile(join(dir, RUN_1.reservation), "not json\n"))
    expect((await refusedLive(notJson)).err).toContain(`REFUSED: run 1's reservation \`${RUN_1.reservation}\` is not JSON`)

    const otherPin = await liveRepo(async (dir) => {
      const record = JSON.parse(await readFile(join(dir, RUN_1.reservation), "utf8")) as Record<string, unknown>
      await writeFile(join(dir, RUN_1.reservation), `${JSON.stringify({ ...record, proposalSha256: OAUTH_PILOT_PROPOSAL.sha256 }, null, 2)}\n`)
    })
    expect((await refusedLive(otherPin)).err).toContain(`REFUSED: run 1's reservation \`${RUN_1.reservation}\` has the wrong shape: its proposalSha256 is "${OAUTH_PILOT_PROPOSAL.sha256}", not ${RUN_1.proposalSha256}`)

    const evidenceShape = await liveRepo(async (dir) => {
      const evidence = JSON.parse(await readFile(join(dir, RUN_1.evidence), "utf8")) as Record<string, unknown>
      await writeFile(join(dir, RUN_1.evidence), `${JSON.stringify({ ...evidence, reservation: { ...(evidence.reservation as object), proposalSha256: "0".repeat(64) } }, null, 2)}\n`)
    })
    expect((await refusedLive(evidenceShape)).err).toContain(`REFUSED: run 1's evidence \`${RUN_1.evidence}\` has the wrong shape: its \`reservation.\`proposalSha256 is "${"0".repeat(64)}"`)

    const noReservation = await liveRepo(async (dir) => writeFile(join(dir, RUN_1.evidence), "[]\n"))
    expect((await refusedLive(noReservation)).err).toContain(`REFUSED: run 1's evidence \`${RUN_1.evidence}\` has the wrong shape: it records no \`reservation\` object`)
  })

  test("the exposure document uncommitted or differing from HEAD refuses, even with its pinned sha256", async () => {
    const untracked = await liveRepo()
    git(untracked, "rm", "-q", "--cached", OAUTH_PILOT_PROPOSAL.path)
    git(untracked, "commit", "-q", "-m", "uncommit the proposal")
    const run = await refusedLive(untracked)
    expect(run.err).toContain(`REFUSED: ${OAUTH_PILOT_PROPOSAL.path} differs from HEAD (\`?? ${OAUTH_PILOT_PROPOSAL.path}\`)`)
    expect(run.err).toContain(`REFUSED: ${OAUTH_PILOT_PROPOSAL.path} is not committed`)
    expect(run.err).not.toContain("changed after gate 8 pinned it")
  })

  test("a reused or gapped run identity refuses before any touch", async () => {
    const root = await liveRepo()
    const reused = await refusedLive(root, undefined, { run: 1, prior: [] })
    expect(reused.err).toContain("REFUSED: OAUTH_PILOT_RUN names run 1: run 1 has run and is spent")
    // A malformed identity names no run of its own, so run 1's files are unaccounted, never "run 1's reservation already exists".
    expect(reused.err).toContain(`REFUSED: \`${RUN_1.reservation}\` (committed, in ablation/evidence) is an unaccounted live pilot file`)
    expect(reused.err).not.toContain("already exists")
    const gap = await refusedLive(root, undefined, { run: 3, prior: [RUN_1] })
    expect(gap.err).toContain("REFUSED: OAUTH_PILOT_RUN.prior lists runs [1], not exactly runs 1 to 2 before run 3")
    const duplicate = await refusedLive(root, undefined, { run: 2, prior: [RUN_1, RUN_1] })
    expect(duplicate.err).toContain("REFUSED: OAUTH_PILOT_RUN.prior lists runs [1, 1], not exactly runs [1]")
    const renamed = await refusedLive(root, undefined, { run: 2, prior: [{ ...RUN_1, reservation: "ablation/evidence/oauth-pilot-live-run-1.reservation" }] })
    expect(renamed.err).toContain("OAUTH_PILOT_RUN.prior names run 1's reservation `ablation/evidence/oauth-pilot-live-run-1.reservation`")
    expect(runIdentityProblems({ run: 2.5, prior: [RUN_1] })).toHaveLength(1)
    expect(runIdentityProblems({ run: 2 ** 40, prior: [RUN_1] })).toEqual([`OAUTH_PILOT_RUN.prior lists runs [1], not exactly runs 1 to ${2 ** 40 - 1} before run ${2 ** 40}: a gap, a duplicate or a reused run`])
  })

  test("a fractional run identity through main: exit 1 before any touch, and no own-run names built from it", async () => {
    const root = await liveRepo()
    await writeFile(join(root, LIVE_EVIDENCE_DIR, "oauth-pilot-live-run-2x5-2026-10-01.json"), "{}\n")
    const run = await refusedLive(root, undefined, { run: 2.5, prior: [RUN_1] })
    expect(run.err).toContain("REFUSED: OAUTH_PILOT_RUN names run 2.5: run 1 has run and is spent, so the run gate 8 authorizes is an integer of at least 2")
    expect(run.err).toContain("`ablation/evidence/oauth-pilot-live-run-2x5-2026-10-01.json` (untracked, in ablation/evidence) is an unaccounted live pilot file")
    expect(existsSync(join(root, "ablation/evidence/oauth-pilot-live-run-2.5.reservation"))).toBe(false)
  })

  test("a live file matched case-insensitively is unaccounted", async () => {
    const root = await liveRepo()
    await writeFile(join(root, LIVE_EVIDENCE_DIR, "OAuth-Pilot-Live-2026-10-01.json"), "{}\n")
    const run = await refusedLive(root)
    expect(run.err).toContain("REFUSED: `ablation/evidence/OAuth-Pilot-Live-2026-10-01.json` (untracked, in ablation/evidence) is an unaccounted live pilot file")
  })

  test("run 1's reservation without a story, or evidence recording another story, has the wrong shape", async () => {
    const noStory = await liveRepo(async (dir) => {
      const { story: _story, ...rest } = JSON.parse(await readFile(join(dir, RUN_1.reservation), "utf8")) as Record<string, unknown>
      await writeFile(join(dir, RUN_1.reservation), `${JSON.stringify(rest, null, 2)}\n`)
    })
    const one = await refusedLive(noStory)
    expect(one.err).toContain(`REFUSED: run 1's reservation \`${RUN_1.reservation}\` has the wrong shape: it records no story`)
    const otherStory = await liveRepo(async (dir) => {
      const evidence = JSON.parse(await readFile(join(dir, RUN_1.evidence), "utf8")) as Record<string, unknown>
      await writeFile(join(dir, RUN_1.evidence), `${JSON.stringify({ ...evidence, reservation: { ...(evidence.reservation as object), story: "2-8c9" } }, null, 2)}\n`)
    })
    const two = await refusedLive(otherStory)
    expect(two.err).toContain(`REFUSED: run 1's evidence \`${RUN_1.evidence}\` records the reservation's story "2-8c9", but its reservation records "2-8c5"`)
  })

  test("a prior run whose evidence lies outside ablation/evidence or is misnamed, or whose sha256 is not 64 hex characters, refuses", async () => {
    const root = await liveRepo()
    const outside = await refusedLive(root, undefined, { run: 2, prior: [{ ...RUN_1, evidence: "docs/oauth-pilot-live-2026-09-28.json" }] })
    expect(outside.err).toContain("REFUSED: OAUTH_PILOT_RUN.prior names run 1's evidence `docs/oauth-pilot-live-2026-09-28.json`, which is not run 1's evidence name in ablation/evidence")
    const misnamed = await refusedLive(root, undefined, { run: 2, prior: [{ ...RUN_1, evidence: "ablation/evidence/oauth-pilot-live-run-1-2026-09-28.json" }] })
    expect(misnamed.err).toContain("REFUSED: OAUTH_PILOT_RUN.prior names run 1's evidence `ablation/evidence/oauth-pilot-live-run-1-2026-09-28.json`, which is not run 1's evidence name in ablation/evidence")
    const shortSha = await refusedLive(root, undefined, { run: 2, prior: [{ ...RUN_1, proposalSha256: "1245e113" }] })
    expect(shortSha.err).toContain("REFUSED: OAUTH_PILOT_RUN.prior records no sha256 for run 1's proposal")
  })

  test("a prior run 2 whose committed reservation or evidence records another run refuses", async () => {
    const run2 = { run: 2, reservation: RUN_2_RESERVATION, evidence: `${LIVE_EVIDENCE_DIR}/oauth-pilot-live-run-2-2026-10-01.json`, proposalSha256: OAUTH_PILOT_PROPOSAL.sha256 }
    const reservation = { run: 7, story: "2-8c7", createdAt: "2026-10-01T00:00:00.000Z", gateTableBlob: "b", proposalSha256: OAUTH_PILOT_PROPOSAL.sha256, out: "/o" }
    const root = await liveRepo(async (dir) => {
      await writeFile(join(dir, run2.reservation), `${JSON.stringify(reservation, null, 2)}\n`)
      await writeFile(join(dir, run2.evidence), `${JSON.stringify({ reservation: { ...reservation, run: 2, out: "<out>" } }, null, 2)}\n`)
    })
    const run = await refusedLive(root, undefined, { run: 3, prior: [RUN_1, run2] })
    expect(run.err).toContain(`REFUSED: run 2's reservation \`${RUN_2_RESERVATION}\` has the wrong shape: its run is 7, not 2`)
    expect(run.err).not.toContain(`run 2's evidence \`${run2.evidence}\` has the wrong shape`)
    expect(run.err).not.toContain("unaccounted")
    expect(existsSync(join(root, oauthPilotReservation(3)))).toBe(false)
  })

  test("--out holding an earlier run's evidence, full or partial, refuses", async () => {
    for (const file of [EVIDENCE_FILE, PARTIAL_EVIDENCE_FILE]) {
      const run = await refusedLive(await liveRepo(), async (out) => {
        await mkdir(out, { recursive: true })
        await writeFile(join(out, file), "{}\n")
      })
      expect(run.value).toBe(1)
      expect(run.touched).toEqual([])
      expect(run.err).toContain(`--out already holds \`${file}\` from an earlier run`)
    }
  })

  test("reserveLiveRun is exclusive: of eight concurrent creations exactly one succeeds, the rest are refused, and the winner's record stays", async () => {
    const root = await liveRepo()
    const record = (out: string) => ({ run: 2, story: "2-8c7" as const, createdAt: new Date().toISOString(), gateTableBlob: "b", proposalSha256: OAUTH_PILOT_PROPOSAL.sha256, out })
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => reserveLiveRun(root, record(`/out-${index}`))))
    const won = results.flatMap((result, index) => (result.ok ? [index] : []))
    expect(won).toHaveLength(1)
    for (const result of results) if (!result.ok) expect(result.why).toContain("already exists: another `--live` reserved run 2 first")
    expect((JSON.parse(await readFile(join(root, RUN_2_RESERVATION), "utf8")) as { out: string }).out).toBe(`/out-${won[0]}`)
  })

  test("the reservation's path is the one the pinned proposal names", async () => {
    expect(await readFile(PROPOSAL_SOURCE, "utf8")).toContain(`\`${RUN_2_RESERVATION}\``)
  })

  test("an evidence directory that exists but cannot be read refuses; a missing one does not", async () => {
    const root = await liveRepo()
    const dir = join(root, LIVE_EVIDENCE_DIR)
    await chmod(dir, 0o000)
    try {
      const problems = await oneRunProblems(root, join(root, "out"), defaultGitForTest())
      expect(problems).toContainEqual(expect.stringContaining(`${LIVE_EVIDENCE_DIR} could not be read (`))
      expect(problems.join("\n")).toContain("an earlier live run or its reservation cannot be ruled out")
    } finally {
      await chmod(dir, 0o755)
    }
    const missing = await liveRepo()
    await rm(join(missing, LIVE_EVIDENCE_DIR), { recursive: true })
    const gone = await oneRunProblems(missing, join(missing, "out"), defaultGitForTest())
    expect(gone.join("\n")).not.toContain("could not be read")
    expect(gone).toContainEqual(expect.stringContaining(`run 1's reservation \`${RUN_1.reservation}\` is missing or modified`))
  })

  test("a repository whose git cannot list HEAD refuses", async () => {
    const root = await temp()
    await mkdir(join(root, OAUTH_PILOT_PROPOSAL.path, ".."), { recursive: true })
    await writeFile(join(root, OAUTH_PILOT_PROPOSAL.path), await readFile(PROPOSAL_SOURCE))
    const problems = await oneRunProblems(root, join(root, "out"), defaultGitForTest())
    expect(problems).toContainEqual(expect.stringContaining("what HEAD holds could not be established"))
  })
})

function defaultGitForTest() {
  return boundedGit({ spawn: preflightSpawn, deadlineMs: PREFLIGHT_GIT_DEADLINE_MS, cleanupMs: PREFLIGHT_GIT_CLEANUP_MS })
}

describe("the default gate-table wiring", () => {
  test("with no gateTable seam, an uncommitted close of gate 8 in the repository refuses through gateTableState", async () => {
    const root = await liveRepo(async (dir) => {
      await mkdir(join(dir, "ablation"), { recursive: true })
      await writeFile(join(dir, GATE_TABLE_FILE), "// the committed table\n")
    })
    await writeFile(join(root, GATE_TABLE_FILE), "// gate 8 CLOSED, not committed\n")
    const closedEight = PAIRED_GATES.map((gate): PairedGate => (gate.number === 8 ? { ...gate, status: "CLOSED", evidence: "edited, not committed" } : gate))
    const scratchDir = await temp()
    const touched: string[] = []
    const { value, err } = await captured(() =>
      main(["bun", "oauth-pilot.ts", "--live", "--oauth-data-dir", join(scratchDir, "data"), "--oauth-prepared", join(scratchDir, "prepared"), "--out", join(scratchDir, "out")], {
        ...tripwires(touched),
        repoRoot: root,
        gates: closedEight,
      }),
    )
    expect(value).toBe(1)
    expect(touched).toEqual([])
    expect(err).toContain(`REFUSED: ${GATE_TABLE_FILE} differs from HEAD`)
  })

  test("with no gateTable seam, the committed table is read and a table with gate 8 OPEN refuses", async () => {
    const root = await liveRepo(async (dir) => {
      await mkdir(join(dir, "ablation"), { recursive: true })
      await writeFile(join(dir, GATE_TABLE_FILE), "// the committed table\n")
    })
    const scratchDir = await temp()
    const { value, err } = await captured(() =>
      main(["bun", "oauth-pilot.ts", "--live", "--oauth-data-dir", join(scratchDir, "data"), "--oauth-prepared", join(scratchDir, "prepared"), "--out", join(scratchDir, "out")], {
        ...tripwires([]),
        repoRoot: root,
        gates: openEight,
      }),
    )
    expect(value).toBe(1)
    expect(err).toContain(`${GATE_TABLE_FILE} is HEAD's blob`)
    expect(err).toContain("REFUSED: gate 8 (OAuth pilot spend authorization) is OPEN")
  })
})

describe("managedPilotHost", () => {
  const request = (mode: "dry" | "live"): HostRequest => ({
    mode,
    route: { providers: ["openai"], models: [PILOT_MODEL], dataDir: "/d", prepared: "/p", home: "/h" },
    proxy: "http://127.0.0.1:9",
    scratchParent: "/s",
    workDir: "/s/work",
    onSpawn: () => undefined,
  })
  const started = {
    ok: true,
    host: {
      url: "http://127.0.0.1:2",
      pid: 99,
      binary: "/stand-in/opencode",
      sha256: "0".repeat(64),
      version: "1.18.32",
      config: { enabled_providers: ["openai"] },
      reportedConfig: { enabled_providers: ["openai"], username: "placeholder" },
      environmentKeys: ["HOME"],
      oauth: { dataDir: "/d", prepared: "/p", measured: identity.payload },
      pluginInstall: async () => ({}),
      stop: async () => ({ confirmed: true, pid: 99, how: "exited" }),
    },
  } as unknown as ManagedHostStart

  test("dry starts through startProbePlaceholderHost with its placeholder store; live through startManagedHost; both sandboxed", async () => {
    const calls: string[] = []
    const starters: HostStarters = {
      probePlaceholder: async (options, placeholder) => {
        calls.push(`probe ${placeholder.kind} ${placeholder.scratch}`)
        expect(options.spawn).toBe(sandboxSpawn)
        return started
      },
      managed: async (options) => {
        calls.push("managed")
        expect(options.spawn).toBe(sandboxSpawn)
        return started
      },
    }
    const dry = await managedPilotHost(request("dry"), starters)
    const live = await managedPilotHost(request("live"), starters)
    expect(calls).toEqual(["probe probe-placeholder /s", "managed"])
    expect(dry.identity.reportedConfig).toEqual({ enabled_providers: ["openai"], username: "placeholder" })
    expect(live.identity.reportedConfig).toBe("not recorded in the live run; the managed host verified it against `generatedConfig` before any client call")
  })

  test("a refused start throws HostRefused with the reason", async () => {
    const refusing: HostStarters = {
      probePlaceholder: async () => ({ ok: false, reason: "the store guard found session=2", stopped: null }),
      managed: async () => ({ ok: false, reason: "never", stopped: null }),
    }
    await expect(managedPilotHost(request("dry"), refusing)).rejects.toThrow("the managed host was refused: the store guard found session=2")
  })
})

describe("the live run's other overlap checks", () => {
  test("--oauth-prepared inside --out is refused before any host, proxy or stat", async () => {
    const repoRoot = await liveRepo()
    const root = await temp()
    const out = join(root, "out")
    const touched: string[] = []
    const closedEight = PAIRED_GATES.map((gate): PairedGate => (gate.number === 8 ? { ...gate, status: "CLOSED", evidence: "stand-in" } : gate))
    const { value, err } = await captured(() =>
      main(["bun", "oauth-pilot.ts", "--live", "--oauth-data-dir", join(root, "data"), "--oauth-prepared", join(out, "prepared"), "--out", out], {
        ...tripwires(touched),
        selfTest: heldSelfTest,
        platform: "darwin",
        repoRoot,
        gates: closedEight,
        gateTable: async () => ({ ok: true, blob: "committed" }),
      }),
    )
    expect(value).toBe(1)
    expect(touched).toEqual([])
    expect(err).toContain("REFUSED — the prepared directory")
    expect(err).toContain("inside the --out")
  })

  test("a reused --out whose journal exists is refused, never overwritten", async () => {
    const root = await temp()
    const out = join(root, "out")
    await mkdir(join(out, "journal"), { recursive: true })
    await writeFile(join(out, "journal", JOURNAL_FILE), "{}\n")
    const { value, err } = await captured(() => main(["bun", "oauth-pilot.ts", "--out", out], { ...tripwires([]), platform: "darwin" }))
    expect(value).toBe(1)
    expect(err).toContain("is not empty")
    expect(await readFile(join(out, "journal", JOURNAL_FILE), "utf8")).toBe("{}\n")
  })
})

describe("the deadline and interruption", () => {
  /** A dry run whose backend answers only once the signal aborts, `lateMs` later. */
  function hangingDry(root: string, lateMs: number, onCall: () => void = () => undefined): PilotSeams {
    return {
      platform: "darwin",
      home: join(root, "home"),
      selfTest: heldSelfTest,
      prepare: async (dir) => {
        await mkdir(dir, { recursive: true })
        return { ok: true }
      },
      startProxy: () => ({ url: "http://127.0.0.1:1", connects: () => [], stop() {} }),
      startHost: standInHost([]),
      backendFor: () => ({
        capabilities: () => ({ tools: false }),
        runTurn: <T,>(slot: string, _instructions: string, _input: string, _schema: unknown, signal?: AbortSignal) =>
          new Promise<Envelope<T>>((resolve) => {
            onCall()
            signal?.addEventListener("abort", () => setTimeout(() => resolve({ ...abandonedTurn(slot, "exec-1", "aborted"), failure: "transport-error" } as Envelope<T>), lateMs))
          }),
      }),
      sandboxDenials: async () => ({ ok: true, source: "stand-in", entries: [] }),
    }
  }

  test("a body seam that outlives the deadline: exit 1, the body saw the abort, no evidence file", async () => {
    const root = await temp()
    const out = join(root, "out")
    let sawAbort = false
    const { value, err } = await captured(() =>
      main(["bun", "oauth-pilot.ts", "--out", out], {
        platform: "darwin",
        deadlineMs: 50,
        settleMs: 50,
        body: (context) =>
          new Promise<number>((resolve) => {
            context.signal.addEventListener("abort", () => {
              sawAbort = true
              resolve(0)
            })
          }),
      }),
    )
    expect(value).toBe(1)
    expect(sawAbort).toBe(true)
    expect(err).toContain("did not finish within 50 ms")
    expect(existsSync(join(out, EVIDENCE_FILE))).toBe(false)
  })

  test("the real body past the deadline: exit 1, never oauth-pilot.json, even after the body finishes late; the partial evidence is written", async () => {
    const root = await temp()
    const out = join(root, "out")
    const { value } = await captured(() => main(["bun", "oauth-pilot.ts", "--out", out], { ...hangingDry(root, 200), deadlineMs: 300, settleMs: 20 }))
    expect(value).toBe(1)
    await Bun.sleep(800)
    expect(existsSync(join(out, EVIDENCE_FILE))).toBe(false)
    const partial = JSON.parse(await readFile(join(out, PARTIAL_EVIDENCE_FILE), "utf8")) as { incomplete: string; backendCalls: number }
    expect(partial.incomplete).toContain("did not finish within 300 ms")
    expect(partial.backendCalls).toBe(1)
  })

  test("a SIGINT after oauth-pilot.json was written, during cleanup: exit 130, the full evidence demoted to one INCOMPLETE file naming the signal, no oauth-pilot.json", async () => {
    const root = await temp()
    const out = join(root, "out")
    const exits: number[] = []
    let fullWhenSignalled: boolean | undefined
    const { value } = await captured(() =>
      main(["bun", "oauth-pilot.ts", "--out", out], {
        platform: "darwin",
        home: join(root, "home"),
        selfTest: heldSelfTest,
        prepare: async (dir) => {
          await mkdir(dir, { recursive: true })
          return { ok: true }
        },
        // Cleanup stops the proxy after the body returned 0 and wrote oauth-pilot.json: the signal lands there.
        startProxy: () => ({
          url: "http://127.0.0.1:1",
          connects: () => [],
          stop() {
            fullWhenSignalled = existsSync(join(out, EVIDENCE_FILE))
            process.emit("SIGINT")
          },
        }),
        startHost: standInHost([]),
        backendFor: () => scriptedBackend([(slot) => ({ ok: false, slot, failure: "model-error", message: "refused", tokens: emptyTokenUsage() })]),
        sandboxDenials: async () => ({ ok: true, source: "stand-in", entries: [] }),
        exit: (code) => void exits.push(code),
      }),
    )
    expect(fullWhenSignalled).toBe(true)
    expect(exits).toEqual([130])
    expect(value).toBe(130)
    expect(existsSync(join(out, EVIDENCE_FILE))).toBe(false)
    const demoted = JSON.parse(await readFile(join(out, PARTIAL_EVIDENCE_FILE), "utf8")) as PilotEvidence & { status: string; failures: string[]; interruptedBy: string }
    expect(demoted.kind).toStartWith("INCOMPLETE — ")
    expect(demoted.status).toBe("FAILED")
    expect(demoted.interruptedBy).toBe("SIGINT")
    expect(demoted.failures).toEqual(["interrupted by SIGINT after oauth-pilot.json was written; the run did not exit 0"])
    // The fuller content: the full evidence's diagnostics, not the short partial.
    expect(demoted.attempts).toHaveLength(1)
    expect(demoted.stop).toEqual({ reason: "attempt 1 ended in an error (model-error)", after: "attempt 1" })
    expect(demoted.sandboxDenials).toEqual({ ok: true, source: "stand-in", entries: [] })
    expect(demoted.storeGuardAndSymlink.postStop).not.toBeNull()
    expect(demoted.findings.map((finding) => finding.id)).toContain("D1")
  })

  test("SIGINT: the journal is closed and the partial evidence written before the exit with 130", async () => {
    const root = await temp()
    const out = join(root, "out")
    let exited: (code: number) => void = () => undefined
    const exit = new Promise<number>((resolve) => (exited = resolve))
    const result = captured(async () => {
      const code = main(["bun", "oauth-pilot.ts", "--out", out], {
        ...hangingDry(root, 20, () => setTimeout(() => process.emit("SIGINT"), 20)),
        exit: (code) => exited(code),
      })
      return { code: await code, exitCode: await exit }
    })
    const { value } = await result
    expect(value.exitCode).toBe(130)
    // main itself ends 130 once a signal arrived, never with the body's own code.
    expect(value.code).toBe(130)
    const partial = JSON.parse(await readFile(join(out, PARTIAL_EVIDENCE_FILE), "utf8")) as { incomplete: string; journal: { lines: { type: string }[] } }
    expect(partial.incomplete).toContain("interrupted by SIGINT")
    expect(partial.journal.lines.map((line) => line.type)).toContain("issued")
    expect(existsSync(join(out, EVIDENCE_FILE))).toBe(false)
  })
})
