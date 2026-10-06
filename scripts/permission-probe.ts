/**
 * Story 2-8d — the zero-bill permission probe: a paired turn cannot wait on a
 * human ask on the measured host.
 *
 * Runs 2 and 4 of the OAuth evaluation each halted on one turn that raised an
 * `ask` (opencode's question tool; an `external_directory` read) and waited for a
 * reply MAD never sends, until its 600 s deadline
 * (`ablation/evidence/host-permission-asks-2026-10-05.json`). This probe drives
 * the shipped defences on the measured host:
 *
 * - the managed host's `FIXED_HOST_SETTINGS.permission` (every ask-capable
 *   permission type the measured host lists denied, read-only exploration
 *   allowed), which also denies an ask raised inside an allowed tool;
 * - the launcher's per-call `PAIRED_HOST_TOOLS` allowlist, which keeps every
 *   other tool name away, but not a permission type raised inside Read, Glob or
 *   Grep.
 *
 * Its verdict holds for the measured host only: rerun it on any later build.
 *
 * The host runs in OAuth mode on placeholder sign-ins. `anthropic` points at a
 * local scripted Messages server and `github-copilot` at a dead local port, so no
 * provider is reached and nothing is billed. The scripted model's first answer
 * calls `read` on `/etc/hosts` (outside --directory) or calls `question`; its next
 * calls `StructuredOutput`. A request body is parsed only to choose the answer
 * and is never recorded: the probe keeps tool NAMES and three booleans per
 * follow-up request.
 *
 * Usage: bun run permission-probe --prepared <dir> --directory <labelled change> [--out <file.json>]
 * Exit 0 when every check HOLDS, 1 otherwise.
 *
 * AD-1: this tree may import from `core/`; nothing under `core/` imports it.
 */

import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { z } from "zod"

import { MEASURED_HOST, startManagedHost } from "../ablation/managed-host.ts"
import { lineageOf } from "../core/domain/lineage.ts"
import { OpencodeModelBackend } from "../adapters/opencode/model-backend.ts"
import { writePlaceholders } from "./oauth-probe.ts"
import { PAIRED_HOST_TOOLS } from "./paired.ts"

export type ProbeScenario = "read-external" | "question"
export const EXTERNAL_PATH = "/etc/hosts"
/** The probe's own turn deadline: far above a refused ask's few seconds, far below the 600 s that halted runs 2 and 4. */
export const PROBE_TURN_MS = 45_000
/** A turn counts as prompt when it ends within this. */
export const PROMPT_MS = 20_000
/** The tools a paired turn may be offered, by normalized name. */
export const EXPECTED_TOOLS = ["glob", "grep", "read", "structuredoutput"]

/** A tool name as opencode's Anthropic route offers it (`mcp_Read`), normalized (`read`). */
export function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/^mcp_/, "")
}

/** What the scripted model answers a request with, chosen from the tool NAMES offered and whether a tool result came back. */
export type ScriptedAnswer = { kind: "text" } | { kind: "tool"; tool: string; input: unknown }

export function scriptedAnswer(scenario: ProbeScenario, offered: readonly string[], hasToolResult: boolean): ScriptedAnswer {
  const named = (want: string) => offered.find((name) => normalizeToolName(name) === want)
  const answer = named("structuredoutput")
  // A request with no answer tool is a host side request (a title): answer with plain text.
  if (answer === undefined) return { kind: "text" }
  if (!hasToolResult) {
    const read = named("read")
    if (scenario === "read-external" && read !== undefined) return { kind: "tool", tool: read, input: { filePath: EXTERNAL_PATH } }
    const question = named("question")
    if (scenario === "question" && question !== undefined) {
      return { kind: "tool", tool: question, input: { questions: [{ question: "Which file?", header: "File", options: [{ label: "a", description: "a" }] }] } }
    }
  }
  return { kind: "tool", tool: answer, input: { findings: [] } }
}

/** What one probe case observed. No request or response content. */
export interface CaseObservation {
  scenario: ProbeScenario
  allowlist: boolean
  ok: boolean
  elapsedMs: number
  failure?: string
  modelRequests: number
  /** Normalized tool names offered in the first model request. */
  offered: string[]
  /** For each follow-up request carrying a tool result: whether it reads as a refusal, and whether the external file's text came back. */
  toolResults: { refused: boolean; externalText: boolean }[]
  firstCall: string | null
}

export interface CaseVerdict {
  holds: boolean
  checks: { check: string; holds: boolean }[]
}

export function caseVerdict(observation: CaseObservation): CaseVerdict {
  const checks = [
    { check: `the turn ended ok within ${PROMPT_MS} ms`, holds: observation.ok && observation.elapsedMs < PROMPT_MS },
    { check: `only ${EXPECTED_TOOLS.join(", ")} were offered`, holds: JSON.stringify([...observation.offered].sort()) === JSON.stringify(EXPECTED_TOOLS) },
  ]
  if (observation.scenario === "read-external") {
    checks.push({ check: `the model's read of ${EXTERNAL_PATH} came back refused`, holds: observation.toolResults.length > 0 && observation.toolResults.every((result) => result.refused) })
    checks.push({ check: `no text of ${EXTERNAL_PATH} reached the model`, holds: observation.toolResults.every((result) => !result.externalText) })
  } else {
    checks.push({ check: "the question tool was not offered, so the first call was the answer", holds: !observation.offered.includes("question") && observation.firstCall === "structuredoutput" })
  }
  return { holds: checks.every((entry) => entry.holds), checks }
}

const REFUSED = /denied|rejected|not allowed|permission/i
const HOSTS_TEXT = /localhost|broadcasthost/i

function sse(events: { event: string; data: unknown }[]): string {
  return events.map((entry) => `event: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`).join("")
}

function messagesStream(index: number, answer: ScriptedAnswer): string {
  const start = { event: "message_start", data: { type: "message_start", message: { id: `msg_probe_${index}`, type: "message", role: "assistant", model: "probe", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } } }
  const stop = (reason: string) => [
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 5 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]
  if (answer.kind === "text") {
    return sse([
      start,
      { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Title" } } },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
      ...stop("end_turn"),
    ])
  }
  return sse([
    start,
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_probe_${index}`, name: answer.tool, input: {} } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(answer.input) } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    ...stop("tool_use"),
  ])
}

async function runCase(scenario: ProbeScenario, allowlist: boolean, prepared: string, directory: string, scratch: string): Promise<CaseObservation> {
  const root = await mkdtemp(join(scratch, `${scenario}-${allowlist ? "allowlist" : "config"}-`))
  const work = join(root, "directory")
  await cp(directory, work, { recursive: true, verbatimSymlinks: true })
  await mkdir(join(root, "host"))
  const { dataDir, home } = await writePlaceholders(join(root, "auth"))
  const observation: CaseObservation = { scenario, allowlist, ok: false, elapsedMs: 0, modelRequests: 0, offered: [], toolResults: [], firstCall: null }
  let index = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      if (!(request.method === "POST" && url.pathname.endsWith("/messages"))) return new Response("not found", { status: 404 })
      const body = (await request.json().catch(() => ({}))) as { tools?: { name: string }[]; messages?: unknown[] }
      index += 1
      const offered = (body.tools ?? []).map((tool) => tool.name)
      const messages = JSON.stringify(body.messages ?? [])
      const hasToolResult = messages.includes("tool_result")
      const answer = scriptedAnswer(scenario, offered, hasToolResult)
      if (answer.kind === "tool") {
        observation.modelRequests += 1
        if (observation.offered.length === 0) observation.offered = offered.map(normalizeToolName)
        if (hasToolResult) observation.toolResults.push({ refused: REFUSED.test(messages), externalText: HOSTS_TEXT.test(messages) })
        observation.firstCall ??= normalizeToolName(answer.tool)
      }
      return new Response(messagesStream(index, answer), { headers: { "content-type": "text/event-stream" } })
    },
  })
  const started = await startManagedHost({
    mode: "oauth",
    oauth: {
      providers: ["anthropic", "github-copilot"],
      models: [
        { providerId: "anthropic", modelId: "claude-sonnet-5" },
        { providerId: "github-copilot", modelId: "gpt-6-luna" },
      ],
      dataDir,
      prepared,
      home,
      baseURLs: { anthropic: `http://127.0.0.1:${server.port}/v1`, "github-copilot": "http://127.0.0.1:9/v1" },
    },
    scratchParent: join(root, "host"),
    verifyDirectories: [work],
    signals: null,
  })
  try {
    if (!started.ok) {
      observation.failure = `the host was refused: ${started.reason}`
      return observation
    }
    const backend = new OpencodeModelBackend({
      serverUrl: started.host.url,
      directory: work,
      slots: [{ slot: "probe", providerId: "anthropic", modelId: "claude-sonnet-5", identity: "claude-sonnet-5", lineage: lineageOf("claude-sonnet-5"), toolcall: true, alsoAvailableVia: [] }],
      timeoutMs: PROBE_TURN_MS,
      ...(allowlist ? { tools: { ...PAIRED_HOST_TOOLS } } : {}),
    })
    const began = performance.now()
    const envelope = await backend.runTurn("probe", "Review the change.", "diff", z.object({ findings: z.array(z.unknown()) }))
    observation.elapsedMs = Math.round(performance.now() - began)
    observation.ok = envelope.ok
    if (!envelope.ok) observation.failure = `${envelope.failure}: ${envelope.message}`
    return observation
  } finally {
    if (started.ok) await started.host.stop()
    server.stop(true)
  }
}

export async function main(argv: readonly string[] = Bun.argv): Promise<number> {
  const flag = (name: string) => {
    const index = argv.indexOf(`--${name}`)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const prepared = flag("prepared")
  const directory = flag("directory")
  const out = flag("out")
  if (prepared === undefined || directory === undefined) {
    console.log("usage: bun run permission-probe --prepared <dir> --directory <labelled change> [--out <file.json>]")
    return 1
  }
  const scratch = await mkdtemp(join(tmpdir(), "mad-permission-probe-"))
  const cases: { observation: CaseObservation; verdict: CaseVerdict }[] = []
  try {
    for (const scenario of ["read-external", "question"] as const) {
      for (const allowlist of [false, true]) {
        const observation = await runCase(scenario, allowlist, resolve(prepared), resolve(directory), scratch)
        const verdict = caseVerdict(observation)
        cases.push({ observation, verdict })
        console.log(`${verdict.holds ? "HOLDS" : "FAILS"}  ${scenario}, ${allowlist ? "host permission + PAIRED_HOST_TOOLS" : "host permission only"}: ${observation.elapsedMs} ms`)
        for (const entry of verdict.checks) console.log(`        ${entry.holds ? "holds" : "FAILS"}: ${entry.check}`)
        if (observation.failure !== undefined) console.log(`        ${observation.failure}`)
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  const holds = cases.every((entry) => entry.verdict.holds)
  if (out !== undefined) {
    await writeFile(
      out,
      `${JSON.stringify({ kind: "ZERO-BILL PERMISSION PROBE (story 2-8d)", measuredAt: new Date().toISOString(), host: MEASURED_HOST, holds, cases }, null, 2)}\n`,
      "utf8",
    )
  }
  console.log(holds ? "\nEvery check HOLDS." : "\nA check FAILS.")
  return holds ? 0 : 1
}

if (import.meta.main) process.exit(await main())
