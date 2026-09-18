/**
 * Story 2-7b — the durable `ToolObservation` sink behind `<adversarial root>/tool-trace.jsonl`
 * (`core/ports/tool-observation.ts`, `evaluation-protocol.md` §5).
 *
 * ## One value, two layers
 *
 * The runner builds ONE sink per run and hands the same value to
 * `opencodeTools` (the adapter's `invoked` / `shellOutcome` facts) and to
 * `review()` (the judge's `request` / `outcome` events). Every line it writes
 * carries the run's slot — case and side — as its FIRST field, so a line whose
 * tail was torn off still names the run it belonged to.
 *
 * ## The sink records; the reader decides
 *
 * This module decides no coverage. It appends what it is told, in call order,
 * each line synced before the write resolves. Joining requests to outcomes,
 * checking arguments and run ids, and deciding whether a count is complete are
 * `ablation/adversarial-read.ts`'s, built once against §5's denominators.
 *
 * ## A write failure is an observation failure, never a throw
 *
 * Every method resolves. A failed append is kept for `takeFailures`, which the
 * judge drains into its one `tool-observation-failed` warning. After the first
 * failed append nothing more is appended to the file, because a line written
 * after a torn tail would merge with it; every later write is kept as a failure
 * too, naming the first.
 *
 * ## A torn tail from an earlier run is closed, not continued
 *
 * Before its first line, a new sink checks whether the file ends in a newline.
 * If an earlier run's last append was cut short, the sink writes the newline
 * first, so the torn row stays a row of its own (and is read back as torn,
 * attributed to its run) instead of merging with this run's first line.
 *
 * Observer writes are unbounded in time, as 2-7a recorded: a hanging append
 * stalls the judge. Bounding it is escalated to a human and is not done here.
 */

import { open, readFile, stat } from "node:fs/promises"

import type {
  ToolInvocationFact,
  ToolObservation,
  ToolObservationFailure,
  ToolObservationWrite,
  ToolOutcomeEvent,
  ToolRequestEvent,
  ToolShellOutcome,
} from "../core/ports/tool-observation.ts"

export const TOOL_TRACE_FILE = "tool-trace.jsonl"

/** Bumped by hand when a trace line's shape changes. */
export const TOOL_TRACE_VERSION = 1

/** Which scheduled run a line belongs to. */
export interface TraceBinding {
  caseId: string
  side: "clean" | "attack"
  /** The slot's 1-based schedule position. */
  position: number
}

/** `<caseId>:<side>` — the first field of every line. */
export function slotKey(binding: Pick<TraceBinding, "caseId" | "side">): string {
  return `${binding.caseId}:${binding.side}`
}

export type TraceEntry =
  | { type: "request"; event: ToolRequestEvent }
  | { type: "outcome"; event: ToolOutcomeEvent }
  | { type: "invoked"; fact: ToolInvocationFact }
  | { type: "shellOutcome"; fact: ToolShellOutcome }

/** One line on disk. `slot` is written first. */
export type TraceLine = { slot: string; v: number; position: number; seq: number } & TraceEntry

/** How a line reaches the file. Injected for tests; the default appends and syncs. */
export interface TraceIo {
  appendLine(file: string, text: string): Promise<void>
}

const FILE_IO: TraceIo = {
  async appendLine(file, text) {
    const handle = await open(file, "a", 0o600)
    try {
      await handle.appendFile(text, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
  },
}

export interface ToolTraceSinkInput {
  file: string
  binding: TraceBinding
  io?: TraceIo
}

/** A `ToolObservation` that also says how many lines it wrote. */
export interface ToolTraceSink extends ToolObservation {
  written(): number
}

export function createToolTraceSink(input: ToolTraceSinkInput): ToolTraceSink {
  const io = input.io ?? FILE_IO
  let queue: Promise<void> = Promise.resolve()
  let seq = 0
  let written = 0
  let broken: string | null = null
  let failures: ToolObservationFailure[] = []
  let tailChecked = false

  /** `"\n"` when the file exists, is non-empty and does not end in a newline; else `""`. */
  const closeTornTail = async (): Promise<string> => {
    let size: number
    try {
      size = (await stat(input.file)).size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
      throw error
    }
    if (size === 0) return ""
    const handle = await open(input.file, "r")
    try {
      const last = Buffer.alloc(1)
      await handle.read(last, 0, 1, size - 1)
      return last[0] === 0x0a ? "" : "\n"
    } finally {
      await handle.close()
    }
  }

  const where = (write: ToolObservationWrite): "core" | "adapter" => (write === "request" || write === "outcome" ? "core" : "adapter")

  const write = (entry: TraceEntry, observationId: string | undefined): Promise<void> => {
    const task = queue.then(async () => {
      const kind = entry.type as ToolObservationWrite
      const fail = (why: string): void => {
        failures.push({ where: where(kind), write: kind, ...(observationId === undefined ? {} : { observationId }), why })
      }
      if (broken !== null) {
        fail(`the trace \`${input.file}\` stopped accepting lines after an earlier append failed (${broken})`)
        return
      }
      seq += 1
      let text: string
      try {
        const line = { slot: slotKey(input.binding), v: TOOL_TRACE_VERSION, position: input.binding.position, seq, ...entry }
        text = `${JSON.stringify(line)}\n`
      } catch (error) {
        fail(`the ${kind} line could not be serialized: ${messageOf(error)}`)
        return
      }
      try {
        if (!tailChecked) {
          text = `${await closeTornTail()}${text}`
          tailChecked = true
        }
        await io.appendLine(input.file, text)
        written += 1
      } catch (error) {
        broken = messageOf(error)
        fail(`the trace \`${input.file}\` could not be appended: ${broken}`)
      }
    })
    queue = task.catch(() => undefined)
    return queue
  }

  return {
    request: (event) => write({ type: "request", event }, event?.context?.observationId),
    outcome: (event) => write({ type: "outcome", event }, event?.context?.observationId),
    invoked: (fact) => write({ type: "invoked", fact }, undefined),
    shellOutcome: (fact) => write({ type: "shellOutcome", fact }, undefined),
    failed(failure) {
      try {
        failures.push({ ...failure })
      } catch {
        // Contracted not to throw; there is no second channel here.
      }
    },
    takeFailures() {
      const taken = failures
      failures = []
      return taken
    },
    written: () => written,
  }
}

// ---------------------------------------------------------------------------
// Reading the file back
// ---------------------------------------------------------------------------

/** A row that did not parse as a trace line: counted, never dropped. */
export interface TornRow {
  /** 1-based line number in the file. */
  row: number
  /** The slot key read off the row's start, or `null` when not even that survived. */
  slot: string | null
  /** True when the row is the file's last and has no newline. */
  tail: boolean
  why: string
}

export type TraceRead =
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string }
  | { kind: "read"; lines: TraceLine[]; torn: TornRow[] }

const SLOT_PREFIX = /^\{"slot":"([^"\\]+)"/

function isTraceLine(value: unknown): value is TraceLine {
  if (value === null || typeof value !== "object") return false
  const line = value as Record<string, unknown>
  if (typeof line.slot !== "string" || line.v !== TOOL_TRACE_VERSION || typeof line.seq !== "number" || typeof line.position !== "number") {
    return false
  }
  if (line.type === "request" || line.type === "outcome") {
    const event = line.event as Record<string, unknown> | null
    if (event === null || typeof event !== "object") return false
    const context = event.context as Record<string, unknown> | null | undefined
    if (
      context === null ||
      typeof context !== "object" ||
      typeof context.runId !== "string" ||
      typeof context.findingId !== "string" ||
      typeof context.observationId !== "string"
    ) {
      return false
    }
    if (line.type === "outcome") {
      const outcome = event.outcome as Record<string, unknown> | null
      return outcome !== null && typeof outcome === "object" && typeof outcome.kind === "string"
    }
    const request = event.request as Record<string, unknown> | null
    if (request === null || typeof request !== "object") return false
    if (request.kind === "made") return isBlameArgs(request.args)
    return request.kind === "unavailable" || request.kind === "not-made"
  }
  if (line.type === "invoked" || line.type === "shellOutcome") {
    const fact = line.fact as Record<string, unknown> | null
    return fact !== null && typeof fact === "object" && isBlameArgs(fact.args)
  }
  return false
}

/** A string path and two whole-number lines. Anything else is not a blame argument. */
export function isBlameArgs(value: unknown): value is { path: string; startLine: number; endLine: number } {
  if (value === null || typeof value !== "object") return false
  const args = value as Record<string, unknown>
  return typeof args.path === "string" && Number.isInteger(args.startLine) && Number.isInteger(args.endLine)
}

/** Read the trace. Never throws. */
export async function readToolTrace(file: string): Promise<TraceRead> {
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" }
    return { kind: "unreadable", reason: `the trace \`${file}\` could not be read: ${messageOf(error)}` }
  }
  const rows = text.split("\n")
  // A file that ends in a newline splits into a last empty string; anything
  // else there is a row with no newline, which is a torn tail.
  const last = rows.pop()!
  const lines: TraceLine[] = []
  const torn: TornRow[] = []
  const take = (row: string, index: number, tail: boolean): void => {
    if (row.length === 0 && !tail) {
      torn.push({ row: index + 1, slot: null, tail, why: "an empty row" })
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(row)
    } catch {
      torn.push({ row: index + 1, slot: SLOT_PREFIX.exec(row)?.[1] ?? null, tail, why: tail ? "the last row is incomplete" : "a row is not JSON" })
      return
    }
    if (!isTraceLine(parsed)) {
      torn.push({ row: index + 1, slot: SLOT_PREFIX.exec(row)?.[1] ?? null, tail, why: "a row is not a trace line" })
      return
    }
    if (tail) {
      // Whole JSON with no newline: the write that would have ended it did not
      // complete, so it is kept as a line AND counted as torn.
      torn.push({ row: index + 1, slot: parsed.slot, tail, why: "the last row has no newline" })
    }
    lines.push(parsed)
  }
  rows.forEach((row, index) => take(row, index, false))
  if (last.length > 0) take(last, rows.length, true)
  return { kind: "read", lines, torn }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
