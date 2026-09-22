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
 * ## An UNRESOLVED file operation is not a failed one (story 2-7c)
 *
 * The sink's own file work is bounded by the same five seconds the judge and the
 * adapter bound their waits by (`core/ports/observation-wait.ts`). Past that the
 * append is ABANDONED, and abandoning an append to a shared file is a different
 * and worse state than one that failed:
 *
 * - A FAILED append is finished. The file is whatever it is, and the next run
 *   can open it and close the torn tail.
 * - An UNRESOLVED append may still be running. Nothing may be appended after it,
 *   because a line written past an append still in flight lands at an offset
 *   nobody can predict, and NO LATER RUN MAY REUSE THE FILE AT ALL.
 *
 * So an unresolved operation poisons the sink and notifies its host AT ONCE,
 * rather than being discovered by the next run when it opens the file. The check
 * is re-read BEFORE EVERY PHYSICAL STEP — at the front of the queued operation
 * and again after the tail check, which is itself an awaited read of the shared
 * file. Re-checking only at queue entry would let an operation that was already
 * cleared start a fresh append after the poison landed, and suppressing the
 * promises those operations returned would not have stopped the writes. Each
 * in-flight operation keeps the identity it was created with, so a completion
 * that arrives late cannot be attributed to a later finding or a later run.
 *
 * ## The deadline starts when the write is ASKED FOR, not when its turn comes
 *
 * This sink's bound is nested inside its caller's: the judge calls `request()`,
 * gets a promise, and waits on it under `OBSERVATION_WRITE_TIMEOUT_MS`. If the
 * CALLER'S bound expired first, the judge would be released — and could go on to
 * the next model request — before this sink had decided its append was
 * unresolved, so the runner's stop would latch one model request too late.
 *
 * Two things keep the nesting true, and `core/ports/observation-wait.ts` holds
 * both: the inner deadline is strictly shorter, and it starts at ENQUEUE. A
 * shorter deadline that only began when the operation reached the front of a
 * serialized queue would not be shorter at all — it would be however long the
 * queue was, plus itself. An operation that expires while still waiting its turn
 * is therefore abandoned without ever touching the disk.
 *
 * THE ORDERING IS CLAIMED FOR THE SHIPPED WIRING, NOT FOR EVERY CONSTRUCTION.
 * `ablation/adversarial.ts` builds the adversarial path with both defaults in
 * force, and that is the path the claim is about. The construction guard
 * compares an implementation's deadline against the shipped caller bound, so a
 * caller passing its own shorter override can still be released before this sink
 * has decided anything. That override exists for tests; nothing in the shipped
 * wiring uses one.
 */

import { open, readFile, stat } from "node:fs/promises"

import {
  OBSERVATION_IO_TIMEOUT_MS,
  observationIoDeadlineProblem,
} from "../core/ports/observation-wait.ts"
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

/**
 * Story 2-7c — one trace file operation that was abandoned, as the runner is
 * told about it.
 *
 * It names the FILE, because the consequence is about that file and not about
 * this run; the OPERATION, so a reader knows which write is outstanding; and the
 * SLOT it belonged to, so an operation that completes late can be recognised as
 * the one it was rather than assumed to be the current one.
 */
export interface TraceUnresolved {
  file: string
  /** `<caseId>:<side>` — the slot whose write it was. */
  slot: string
  /** The sink's own sequence number for the line, so one abandoned write is one identity. */
  seq: number
  why: string
}

/**
 * Trace files with an operation still in flight, process-wide.
 *
 * MODULE-SCOPED ON PURPOSE, and it is the file rather than the sink that is
 * poisoned. The adversarial suite builds ONE SINK PER RUN over ONE SHARED FILE,
 * so a per-sink flag would let the next run of the same suite open the same file
 * and append behind an outstanding write. Nothing ever clears an entry: recovery
 * is manual, after a human has checked what happened to the named operation.
 *
 * IT IS NOT DURABLE, AND IT IS NOT THE CROSS-PROCESS BAN. This map is memory in
 * one process and is gone the moment that process ends, so it stops later runs
 * of THIS invocation and nothing more. What refuses a restarted process is the
 * RETAINED LOCK and the PERSISTED HALT (`ablation/journal.ts`), which is why the
 * runner does both rather than relying on this — and why a later writer must
 * never be let through merely because the map was lost with the process that
 * held it.
 */
const UNRESOLVED_TRACE_FILES = new Map<string, TraceUnresolved>()

/** The unresolved operation holding this trace file, or `null`. */
export function traceUnresolved(file: string): TraceUnresolved | null {
  return UNRESOLVED_TRACE_FILES.get(file) ?? null
}

/** Refusing to build a sink whose own deadline could not do its job. */
export class TraceDeadlineError extends Error {
  constructor(reason: string) {
    super(`the tool trace sink was not built: ${reason}`)
    this.name = "TraceDeadlineError"
  }
}

/** Refusing to build a sink over a file an earlier operation has not let go of. */
export class TraceUnresolvedError extends Error {
  constructor(readonly unresolved: TraceUnresolved) {
    super(
      `the trace \`${unresolved.file}\` cannot be reused: ${unresolved.why}. Recovery is manual — ` +
        `check the named operation and the file's tail before any run appends to it again.`,
    )
    this.name = "TraceUnresolvedError"
  }
}

export interface ToolTraceSinkInput {
  file: string
  binding: TraceBinding
  io?: TraceIo
  /**
   * Story 2-7c — how long ONE file operation may take, counted from the moment
   * it is asked for.
   *
   * A construction seam for tests, defaulting to `OBSERVATION_IO_TIMEOUT_MS`. No
   * flag, config key or environment variable reaches it. It is VALIDATED at
   * construction — finite, positive, inside the timer ceiling, and strictly
   * shorter than the bound a caller waits under — because every one of those
   * mistakes produces a sink that looks like it has a deadline and does not.
   */
  operationTimeoutMs?: number
  /**
   * Story 2-7c — called ONCE, the first time an operation is abandoned with its
   * physical effect unconfirmed.
   *
   * THE POISON IS SET BEFORE THIS IS CALLED, so a host that reacts inside it
   * already sees a sink that accepts nothing further, and a callback that throws
   * cannot give the sink back. It is called from the write that timed out, not
   * at the end of the run: the runner has to stop admitting before the judge
   * asks another model, and an end-of-run check is too late for that.
   */
  onUnresolved?: (fact: TraceUnresolved) => void
}

/** A `ToolObservation` that also says how many lines it wrote. */
export interface ToolTraceSink extends ToolObservation {
  written(): number
}

/**
 * Build the run's sink.
 *
 * REFUSES rather than degrades when the file is held by an unresolved operation.
 * A sink that accepted the writes and failed them all would leave the caller
 * deciding whether to carry on, and the answer is always no — the file is not
 * safe to touch.
 */
export function createToolTraceSink(input: ToolTraceSinkInput): ToolTraceSink {
  const held = traceUnresolved(input.file)
  if (held !== null) throw new TraceUnresolvedError(held)

  const io = input.io ?? FILE_IO
  const operationTimeoutMs = input.operationTimeoutMs ?? OBSERVATION_IO_TIMEOUT_MS
  const deadlineIssue = observationIoDeadlineProblem(operationTimeoutMs)
  if (deadlineIssue !== null) throw new TraceDeadlineError(deadlineIssue)
  let queue: Promise<void> = Promise.resolve()
  let seq = 0
  let written = 0
  let broken: string | null = null
  let failures: ToolObservationFailure[] = []
  let tailChecked = false

  /** Latch the poison, then tell the host. In that order — see `onUnresolved`. */
  const poison = (fact: TraceUnresolved): void => {
    if (UNRESOLVED_TRACE_FILES.has(fact.file)) return
    UNRESOLVED_TRACE_FILES.set(fact.file, fact)
    try {
      input.onUnresolved?.(fact)
    } catch {
      // The host could not record it. The file stays poisoned either way; there
      // is no second channel at this layer.
    }
  }

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
    // THE DEADLINE STARTS HERE, AT ENQUEUE — see this file's header. An operation
    // that spends its whole budget waiting behind another one is abandoned
    // without ever touching the disk, which is what keeps this bound genuinely
    // inside the caller's.
    let expired = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => {
        expired = true
        resolve("expired")
      }, operationTimeoutMs)
    })

    const task = queue.then(async () => {
      const kind = entry.type as ToolObservationWrite
      const fail = (why: string): void => {
        failures.push({ where: where(kind), write: kind, ...(observationId === undefined ? {} : { observationId }), why })
      }
      /**
       * Why this operation may not touch the shared file right now, or `null`.
       *
       * CALLED BEFORE EVERY PHYSICAL STEP, not once at the top. Work queued
       * before the poison was latched is still sitting in this chain, and the
       * tail check in the middle of an append is itself an awaited read — so a
       * check taken only at entry would clear an operation that then starts a
       * fresh write after the file became unsafe. Suppressing the promise this
       * function returns would not have stopped that write reaching the disk,
       * which is the only thing that matters when an earlier append may still be
       * in flight at an unknown offset.
       */
      const blocked = (): string | null => {
        const held = traceUnresolved(input.file)
        if (held !== null) {
          return `the trace \`${input.file}\` stopped accepting lines because an earlier operation is UNRESOLVED (${held.why})`
        }
        if (broken !== null) {
          return `the trace \`${input.file}\` stopped accepting lines after an earlier append failed (${broken})`
        }
        if (expired) {
          return `this operation's own ${operationTimeoutMs}ms deadline expired before it could reach the file, so nothing was written`
        }
        return null
      }

      const atEntry = blocked()
      if (atEntry !== null) {
        fail(atEntry)
        return
      }

      seq += 1
      // THIS OPERATION'S OWN IDENTITY, taken before any await and never re-read.
      // `seq` moves on; a completion that arrives late has to be recognisable as
      // the write it was, not as whichever write is current when it lands.
      const mine = seq
      let text: string
      try {
        const line = { slot: slotKey(input.binding), v: TOOL_TRACE_VERSION, position: input.binding.position, seq: mine, ...entry }
        text = `${JSON.stringify(line)}\n`
      } catch (error) {
        fail(`the ${kind} line could not be serialized: ${messageOf(error)}`)
        return
      }

      type Physical = { done: true } | { failed: unknown } | { fenced: string }
      const physical = (async (): Promise<Physical> => {
        try {
          if (!tailChecked) {
            text = `${await closeTornTail()}${text}`
            tailChecked = true
            // RE-CHECKED AFTER THE AWAIT. The tail read is shared-file activity
            // of its own, and the poison can land while it is outstanding.
            const afterTail = blocked()
            if (afterTail !== null) return { fenced: afterTail }
          }
          await io.appendLine(input.file, text)
          return { done: true }
        } catch (error) {
          return { failed: error }
        }
      })()

      const outcome = await Promise.race<Physical | "expired">([physical, deadline])

      if (outcome === "expired") {
        const why =
          `the ${kind} line (slot ${slotKey(input.binding)}, seq ${mine}) did not complete within ` +
          `${operationTimeoutMs}ms: the physical append to \`${input.file}\` is UNCONFIRMED and may still be ` +
          `running, so the file's contents past this point are unknown`
        poison({ file: input.file, slot: slotKey(input.binding), seq: mine, why })
        fail(why)
        return
      }
      if ("fenced" in outcome) {
        fail(outcome.fenced)
        return
      }
      if ("failed" in outcome) {
        // FINISHED, AND KNOWN TO HAVE FAILED. The file is whatever it is and a
        // later run may close its torn tail; this is the pre-existing shape and
        // it does not poison.
        broken = messageOf(outcome.failed)
        fail(`the trace \`${input.file}\` could not be appended: ${broken}`)
        return
      }
      written += 1
    })

    const settled = task.finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
    queue = settled.catch(() => undefined)
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
