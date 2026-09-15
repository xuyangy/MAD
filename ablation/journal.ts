/**
 * Story 2-5c — the paired runner's durable request journal: one line per
 * admission, settlement and late usage report, at the bundle root.
 *
 * `evaluation-protocol.md` §4 bills each unique physical execution once, and a
 * forked branch's ledger carries its prefix, so no sum of run ledgers is that
 * bill. The journal is: every billable request is written as `issued` before it
 * may go out, settled with what it cost, and adjusted at most once by a late
 * report. `bill()` reads the result back by category, block and phase.
 *
 * ## Files
 *
 *   <root>/paired.lock            one active writer; created without overwrite
 *   <root>/paired-journal.jsonl   append-only, one JSON object per line
 *
 * ## Rules
 *
 * - **Serialized.** Admissions and every append run one at a time, in call
 *   order. A settlement or late report updates the in-memory state when it is
 *   received, so every later admission sees it before its own write completes.
 * - **Admission is durable first.** `admit` resolves `ok` only after its
 *   `issued` line was appended.
 * - **In flight is not unknown.** During an invocation, an issued request with no
 *   settlement is in flight and latches nothing. A journal opened with such a
 *   request finds it UNCERTAIN: its cost is unquantified, the halt latches, and
 *   nothing reopened from that journal is admitted.
 * - **The halt never clears.** An unknown settlement, an uncertain request or an
 *   integrity failure latches it. A late report that recovers an unknown adds its
 *   tokens to the known spend and leaves the halt in place.
 * - **Integrity failures are recorded, never resolved.** A conflicting repeat
 *   settlement, a late payload that disagrees with an earlier one for the same
 *   execution (in any batch), and one `executionId` bound to two requests each
 *   latch the halt and keep every payload visible.
 * - **A persistence failure stops the runner.** No admission follows it. It is
 *   never reported as a model's failure.
 *
 * AD-1: this tree may import from `core/`. Nothing under `core/` imports it.
 */

import { mkdir, open, readFile, unlink } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { spentTokens } from "../core/budget/ledger.ts"
import { addTokens, emptyTokenUsage, type TokenUsage } from "../core/domain/run-record.ts"
import type {
  AdmissionDecision,
  AdmissionRefusalCause,
  AdmissionRequest,
  AdmissionSettlement,
  RequestAdmission,
} from "../core/ports/admission.ts"
import type { LateUsageReport, LateUsageReporter } from "../core/ports/late-usage.ts"
import {
  HALT_MARKER_FILE,
  PAIRED_ALLOWANCES,
  requestGate,
  type AllowanceCategory,
  type PairedPhase,
  type RequestGateView,
} from "./governor.ts"

export const JOURNAL_FILE = "paired-journal.jsonl"
export const LOCK_FILE = "paired.lock"

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------

export interface HeldLock {
  file: string
  /** Removes the lock file. Resolves to a reason when that failed, else `null`. */
  release(): Promise<string | null>
}

export type LockOutcome = { ok: true; lock: HeldLock } | { ok: false; reason: string }

/**
 * Take the bundle root's single-writer lock.
 *
 * Created with `wx`, so an existing lock refuses and nothing is overwritten.
 * Every other I/O error refuses too: a writer that cannot establish it is alone
 * does not write.
 */
export async function acquireLock(bundleRoot: string, at: string): Promise<LockOutcome> {
  const root = resolve(bundleRoot)
  const file = join(root, LOCK_FILE)
  try {
    await mkdir(root, { recursive: true, mode: 0o700 })
  } catch (error) {
    return {
      ok: false,
      reason:
        `the lock \`${file}\` could not be created (${messageOf(error)}), so a single writer is not ` +
        `established and nothing was written.`,
    }
  }
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(file, "wx", 0o600)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return {
      ok: false,
      reason:
        code === "EEXIST"
          ? `another writer holds \`${file}\`. One writer per bundle root; nothing was written.`
          : `the lock \`${file}\` could not be created (${messageOf(error)}), so a single writer is not ` +
            `established and nothing was written.`,
    }
  }
  try {
    try {
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: at })}\n`, "utf8")
    } finally {
      await handle.close()
    }
  } catch (error) {
    // THIS CALL CREATED THE FILE, so it removes it: a lock left behind by a
    // writer that never held it would refuse every later writer.
    const cleanup = await unlink(file).then(
      () => "",
      (unlinkError: unknown) => `; the partial lock could not be removed either (${messageOf(unlinkError)})`,
    )
    return {
      ok: false,
      reason:
        `the lock \`${file}\` could not be written (${messageOf(error)})${cleanup}, so a single writer is not ` +
        `established and nothing was written.`,
    }
  }
  let released = false
  return {
    ok: true,
    lock: {
      file,
      async release() {
        if (released) return null
        try {
          await unlink(file)
          released = true
          return null
        } catch (error) {
          return `the lock \`${file}\` could not be removed: ${messageOf(error)}`
        }
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Lines, and the state they replay into
// ---------------------------------------------------------------------------

export interface IssuedLine {
  type: "issued"
  physicalId: string
  category: AllowanceCategory
  /** 1-based block for the Blocks category; `null` for any other category. */
  block: number | null
  phase: PairedPhase | null
  stage: string
  slot: string
  attempt: number
  runId: string
}

export interface SettledLine {
  type: "settled"
  physicalId: string
  settlement: AdmissionSettlement
}

export interface LateLine {
  type: "late"
  physicalId: string
  executionId: string
  tokens: TokenUsage
}

export type JournalLine = IssuedLine | SettledLine | LateLine

export type RequestState = "in-flight" | "usage" | "unknown" | "not-issued" | "uncertain"

/** One physical request, as the journal knows it. */
export interface BilledRequest {
  physicalId: string
  category: AllowanceCategory
  block: number | null
  phase: PairedPhase | null
  stage: string
  slot: string
  attempt: number
  runId: string
  state: RequestState
  /** The settled figure (`usage`). */
  tokens?: TokenUsage
  /** An `unknown` settlement's reason. */
  why?: string
  executionId?: string
  /** The late figure that recovered an `unknown`. */
  late?: TokenUsage
}

export interface IntegrityFailure {
  reason: string
  physicalId?: string
  executionId?: string
  payloads?: unknown[]
}

/** Known spend and counts for one allowance phase. */
export interface PhaseBill {
  category: AllowanceCategory
  block: number | null
  phase: PairedPhase | null
  tokens: TokenUsage
  requests: number
  unknown: number
  inFlight: number
}

/**
 * The unique-execution bill: each physical request once, whichever runs
 * inherited it.
 *
 * `known` is persisted usage plus recovered late figures. It is NOT the whole
 * cost while `unknown`, `uncertain` or `inFlight` is non-empty; those carry no
 * number, and no number is invented for them.
 */
export interface UniqueExecutionBill {
  requests: BilledRequest[]
  known: TokenUsage
  byCategory: Partial<Record<AllowanceCategory, TokenUsage>>
  byPhase: PhaseBill[]
  /** Settled `unknown`, including ones a late report later recovered. */
  unknown: BilledRequest[]
  /** Issued by an interrupted invocation and never settled. */
  uncertain: BilledRequest[]
  inFlight: BilledRequest[]
  integrity: IntegrityFailure[]
  halt: string | null
  stop: string | null
  /**
   * Late reports received and not yet applied. During an invocation these are
   * reports whose `executionId` no request carries yet; after completion, every
   * report held for `flush()`.
   */
  unappliedLate: LateUsageReport[]
  /**
   * Every admission this invocation refused, in order. Held in memory only: a
   * refused request issues nothing, so the journal file has no line for it. The
   * paired runner records the consequence durably in the slot status.
   */
  refused: RefusedAdmission[]
  /**
   * Known spend past each configured threshold. Admitted in-flight work may
   * overshoot a threshold; the overshoot is reported here and never borrowed from
   * another allowance. Zero means no overshoot.
   */
  overshoot: OvershootReport
  /** Where the halt marker was written for a latched halt, or why it could not be. */
  haltMarker: { file: string | null; error: string | null }
}

/** One refused admission: where it would have been spent, and why it was not. */
export interface RefusedAdmission {
  block: number
  phase: PairedPhase
  /** Absent when the run had no id yet. */
  runId?: string
  stage: string
  slot: string
  attempt: number
  cause: AdmissionRefusalCause
  reason: string
}

export interface OvershootReport {
  global: { limit: number; spent: number; overshoot: number }
  blocks: { limit: number; spent: number; overshoot: number }
  /** One row per Blocks phase that holds any request. */
  phases: { block: number; phase: PairedPhase; limit: number; spent: number; overshoot: number }[]
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

const TOKEN_FIELDS = ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const

function countable(tokens: unknown): tokens is TokenUsage {
  if (tokens === null || typeof tokens !== "object") return false
  return TOKEN_FIELDS.every((field) => {
    const n = (tokens as Record<string, unknown>)[field]
    return typeof n === "number" && Number.isFinite(n) && n >= 0
  })
}

function tokensOf(tokens: TokenUsage): TokenUsage {
  return {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
  }
}

const UNCOUNTABLE_USAGE = "the settled usage figure was not five finite, non-negative numbers"

/**
 * A settlement in the one form the journal records, compares and replays.
 *
 * A stage passes a backend's figure through as it came, so a `usage` settlement
 * may carry tokens MAD cannot count. It becomes the `unknown` it is billed as
 * BEFORE it is compared or written: the line on disk is then one replay accepts,
 * and an identical repeat of the same malformed figure compares equal to it.
 * Reading a field may throw (a getter); the caller records that as a runner stop.
 */
function normalizedSettlement(settlement: AdmissionSettlement): AdmissionSettlement {
  if (settlement === null || typeof settlement !== "object") {
    return { kind: "unknown", why: "the settlement was not an object" }
  }
  if (settlement.kind === "usage") {
    return countable(settlement.tokens)
      ? { kind: "usage", tokens: tokensOf(settlement.tokens) }
      : { kind: "unknown", why: UNCOUNTABLE_USAGE }
  }
  if (settlement.kind === "not-issued") return { kind: "not-issued" }
  if (settlement.kind === "unknown") {
    const { why, executionId } = settlement
    return {
      kind: "unknown",
      why: typeof why === "string" ? why : "the unknown settlement carried no reason",
      ...(typeof executionId === "string" ? { executionId } : {}),
    }
  }
  return { kind: "unknown", why: "the settlement named no recognised outcome" }
}

const ADMISSION_STAGES: readonly string[] = ["discover", "debate", "judge"]

/** Why an admission request could not be journaled as given, or `null`. */
function requestProblem(request: AdmissionRequest): string | null {
  if (request === null || typeof request !== "object") return "the request was not an object"
  if (!ADMISSION_STAGES.includes(request.stage)) return `its stage ${JSON.stringify(request.stage)} is not discover, debate or judge`
  if (typeof request.slot !== "string" || request.slot.length === 0) return "it names no slot"
  if (!isWhole(request.attempt, 1)) return `its attempt ${JSON.stringify(request.attempt)} is not a whole number from 1`
  return null
}

/**
 * The journal's state machine. Replaying the file and running an invocation
 * apply the same transitions, so what a later `flush()` reads back agrees with
 * what the invocation held in memory.
 */
class JournalState {
  readonly requests = new Map<string, BilledRequest>()
  readonly byExecution = new Map<string, string>()
  readonly integrity: IntegrityFailure[] = []
  halt: string | null = null
  stop: string | null = null
  haltMarker: { file: string | null; error: string | null } = { file: null, error: null }

  latch(reason: string): void {
    this.halt ??= reason
  }

  fail(failure: IntegrityFailure): void {
    this.integrity.push(failure)
    this.latch(`integrity failure: ${failure.reason}`)
  }

  apply(line: JournalLine): void {
    if (line.type === "issued") {
      if (this.requests.has(line.physicalId)) {
        this.fail({ reason: `request \`${line.physicalId}\` was issued twice`, physicalId: line.physicalId })
        return
      }
      const { type: _type, ...request } = line
      this.requests.set(line.physicalId, { ...request, state: "in-flight" })
      return
    }
    const request = this.requests.get(line.physicalId)
    if (request === undefined) {
      this.fail({ reason: `a ${line.type} line names \`${line.physicalId}\`, which was never issued`, physicalId: line.physicalId })
      return
    }
    if (line.type === "settled") this.settle(request, line.settlement)
    else this.late(request, line.executionId, line.tokens)
  }

  private settle(request: BilledRequest, settlement: AdmissionSettlement): void {
    if (request.state !== "in-flight" && request.state !== "uncertain") {
      const previous = this.settlementOf(request)
      if (!sameJson(previous, settlement)) {
        this.fail({
          reason: `request \`${request.physicalId}\` was settled twice with different outcomes`,
          physicalId: request.physicalId,
          payloads: [previous, settlement],
        })
      }
      return
    }
    if (settlement.kind === "usage" && countable(settlement.tokens)) {
      request.state = "usage"
      request.tokens = tokensOf(settlement.tokens)
      return
    }
    if (settlement.kind === "not-issued") {
      request.state = "not-issued"
      return
    }
    request.state = "unknown"
    request.why = settlement.kind === "unknown" ? settlement.why : UNCOUNTABLE_USAGE
    this.latch(
      `request \`${request.physicalId}\` (block ${request.block ?? "-"} ${request.phase ?? request.category}, ` +
        `${request.stage}/${request.slot} attempt ${request.attempt}) billed an UNKNOWN amount: ${request.why}`,
    )
    if (settlement.kind === "unknown" && settlement.executionId !== undefined) {
      const bound = this.byExecution.get(settlement.executionId)
      if (bound !== undefined && bound !== request.physicalId) {
        this.fail({
          reason: `execution id \`${settlement.executionId}\` is bound to both \`${bound}\` and \`${request.physicalId}\``,
          physicalId: request.physicalId,
          executionId: settlement.executionId,
        })
        return
      }
      request.executionId = settlement.executionId
      this.byExecution.set(settlement.executionId, request.physicalId)
    }
  }

  private late(request: BilledRequest, executionId: string, tokens: TokenUsage): void {
    if (request.executionId !== executionId || request.state !== "unknown") {
      this.fail({
        reason: `a late report for \`${executionId}\` names request \`${request.physicalId}\`, which carries no such unknown`,
        physicalId: request.physicalId,
        executionId,
      })
      return
    }
    if (request.late !== undefined) {
      if (!sameJson(request.late, tokens)) {
        this.fail({
          reason: `execution \`${executionId}\` was reported late with two different token payloads`,
          physicalId: request.physicalId,
          executionId,
          payloads: [request.late, tokens],
        })
      }
      return
    }
    request.late = tokensOf(tokens)
  }

  settlementOf(request: BilledRequest): AdmissionSettlement | undefined {
    switch (request.state) {
      case "usage":
        return { kind: "usage", tokens: request.tokens! }
      case "not-issued":
        return { kind: "not-issued" }
      case "unknown":
        return {
          kind: "unknown",
          why: request.why!,
          ...(request.executionId === undefined ? {} : { executionId: request.executionId }),
        }
      default:
        return undefined
    }
  }

  /** Every in-flight request becomes uncertain. Used when a journal is reopened. */
  interrupt(): void {
    const uncertain = [...this.requests.values()].filter((request) => request.state === "in-flight")
    for (const request of uncertain) request.state = "uncertain"
    if (uncertain.length > 0) {
      this.latch(
        `${uncertain.length} request(s) were issued by an earlier invocation and never settled, beginning with ` +
          `\`${uncertain[0]!.physicalId}\`; their cost is uncertain and unquantified`,
      )
    }
  }

  knownOf(request: BilledRequest): TokenUsage | undefined {
    if (request.state === "usage") return request.tokens
    if (request.state === "unknown") return request.late
    return undefined
  }

  view(): RequestGateView {
    return {
      stop: this.stop,
      halt: this.halt,
      globalSpent: this.spentWhere(() => true),
      categorySpent: (category) => this.spentWhere((request) => request.category === category),
      phaseSpent: (block, phase) =>
        this.spentWhere((request) => request.category === "blocks" && request.block === block && request.phase === phase),
    }
  }

  private spentWhere(match: (request: BilledRequest) => boolean): number {
    let total = 0
    for (const request of this.requests.values()) {
      const known = this.knownOf(request)
      if (known !== undefined && match(request)) total += spentTokens(known)
    }
    return total
  }

  bill(unappliedLate: readonly LateUsageReport[], refused: readonly RefusedAdmission[] = []): UniqueExecutionBill {
    const requests = [...this.requests.values()].map((request) => structuredClone(request))
    let known = emptyTokenUsage()
    const byCategory: Partial<Record<AllowanceCategory, TokenUsage>> = {}
    const phases = new Map<string, PhaseBill>()
    for (const request of this.requests.values()) {
      const key = `${request.category}\0${request.block}\0${request.phase}`
      let phase = phases.get(key)
      if (phase === undefined) {
        phase = {
          category: request.category,
          block: request.block,
          phase: request.phase,
          tokens: emptyTokenUsage(),
          requests: 0,
          unknown: 0,
          inFlight: 0,
        }
        phases.set(key, phase)
      }
      if (request.state !== "not-issued") phase.requests += 1
      if (request.state === "unknown" || request.state === "uncertain") phase.unknown += 1
      if (request.state === "in-flight") phase.inFlight += 1
      const figure = this.knownOf(request)
      if (figure === undefined) continue
      known = addTokens(known, figure)
      byCategory[request.category] = addTokens(byCategory[request.category] ?? emptyTokenUsage(), figure)
      phase.tokens = addTokens(phase.tokens, figure)
    }
    return {
      requests,
      known,
      byCategory,
      byPhase: [...phases.values()],
      unknown: requests.filter((request) => request.state === "unknown"),
      uncertain: requests.filter((request) => request.state === "uncertain"),
      inFlight: requests.filter((request) => request.state === "in-flight"),
      integrity: this.integrity.map((failure) => structuredClone(failure)),
      halt: this.halt,
      stop: this.stop,
      unappliedLate: unappliedLate.map((report) => structuredClone(report)),
      refused: refused.map((refusal) => ({ ...refusal })),
      overshoot: overshootOf(known, byCategory.blocks, [...phases.values()]),
      haltMarker: { ...this.haltMarker },
    }
  }
}

const CATEGORIES: readonly AllowanceCategory[] = ["blocks", "adversarial", "calibration", "pilot"]
const PHASES: readonly (PairedPhase | null)[] = ["prefix", "on", "off", null]

function overshootOf(
  known: TokenUsage,
  blocks: TokenUsage | undefined,
  phases: readonly PhaseBill[],
): OvershootReport {
  const row = (limit: number, spent: number) => ({ limit, spent, overshoot: Math.max(0, spent - limit) })
  return {
    global: row(PAIRED_ALLOWANCES.global, spentTokens(known)),
    blocks: row(PAIRED_ALLOWANCES.blocks, blocks === undefined ? 0 : spentTokens(blocks)),
    phases: phases
      .filter((phase) => phase.category === "blocks" && phase.block !== null && phase.phase !== null)
      .map((phase) => ({
        block: phase.block!,
        phase: phase.phase!,
        ...row(phase.phase === "prefix" ? PAIRED_ALLOWANCES.prefix : PAIRED_ALLOWANCES.continuation, spentTokens(phase.tokens)),
      })),
  }
}

function isWhole(value: unknown, least: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= least
}

/**
 * A journal line, validated field by field. A line that fails is not replayed
 * and the journal refuses to open: a journal MAD cannot read is not evidence
 * that nothing was spent.
 */
function isLine(value: unknown): value is JournalLine {
  if (value === null || typeof value !== "object") return false
  const line = value as Record<string, unknown>
  if (typeof line.physicalId !== "string" || line.physicalId.length === 0) return false
  if (line.type === "issued") {
    if (!CATEGORIES.includes(line.category as AllowanceCategory)) return false
    if (!PHASES.includes(line.phase as PairedPhase | null)) return false
    const blocks = line.category === "blocks"
    // A Blocks request always names its block and phase. Another category has no
    // phase, and may name a block.
    if (blocks ? !isWhole(line.block, 1) || line.phase === null : !(line.block === null || isWhole(line.block, 1)) || line.phase !== null) {
      return false
    }
    return (
      typeof line.stage === "string" &&
      typeof line.slot === "string" &&
      line.slot.length > 0 &&
      isWhole(line.attempt, 1) &&
      typeof line.runId === "string" &&
      line.runId.length > 0
    )
  }
  if (line.type === "settled") {
    const settlement = line.settlement as Record<string, unknown> | null
    if (settlement === null || typeof settlement !== "object") return false
    if (settlement.kind === "usage") return countable(settlement.tokens)
    if (settlement.kind === "unknown") {
      return typeof settlement.why === "string" && (settlement.executionId === undefined || typeof settlement.executionId === "string")
    }
    return settlement.kind === "not-issued"
  }
  if (line.type === "late") return typeof line.executionId === "string" && countable(line.tokens)
  return false
}

type Replayed = { ok: true; state: JournalState; existed: boolean } | { ok: false; reason: string }

/** Read and replay a journal file. An absent file is an empty journal. */
async function replayFile(file: string): Promise<Replayed> {
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, state: new JournalState(), existed: false }
    return { ok: false, reason: `the journal \`${file}\` could not be read: ${messageOf(error)}` }
  }
  const state = new JournalState()
  const rows = text.split("\n").filter((row) => row.length > 0)
  for (const [position, row] of rows.entries()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(row)
    } catch {
      return { ok: false, reason: `line ${position + 1} of the journal \`${file}\` is not JSON` }
    }
    if (!isLine(parsed)) return { ok: false, reason: `line ${position + 1} of the journal \`${file}\` is not a valid journal line` }
    state.apply(parsed)
  }
  return { ok: true, state, existed: true }
}

// ---------------------------------------------------------------------------
// The open journal
// ---------------------------------------------------------------------------

/** Which Blocks allowance a stage's requests are admitted against, and for which run. */
export interface AdmissionBinding {
  block: number
  phase: PairedPhase
  /**
   * The run the requests belong to, read at admission time, because a prefix
   * mints its run id inside `prepareReview`. `undefined` means no run id exists
   * yet: the request is refused as a runner stop and never journaled.
   */
  runId: () => string | undefined
}

/**
 * How the journal appends a line. Injected for tests; the default appends and
 * syncs the file. It may reject before or after the bytes reached the file, and
 * the journal treats both alike (see `openJournal`).
 */
export interface JournalIo {
  appendLine(file: string, line: JournalLine): Promise<void>
}

const FILE_IO: JournalIo = { appendLine }

export interface FlushOutcome {
  /** True when every held report and settlement was persisted or classified. */
  ok: boolean
  /** Late reports and settlements appended to the journal. */
  persisted: number
  /** Held reports or settlements that disagree with a persisted payload. Recorded as integrity failures. */
  conflicts: IntegrityFailure[]
  /** Held reports no request in the journal carries. Kept, and offered again by the next `flush()`. */
  unmatched: LateUsageReport[]
  /** Why nothing, or not everything, could be persisted. Unpersisted items are kept for a later `flush()`. */
  failed: string | null
}

/**
 * The retained reconciliation handle a completed run returns.
 *
 * The run's completion ends admission, not the life of its late reporter: a
 * provider may still answer. A report, or a settlement, that arrives after
 * completion is held in memory until the caller calls `flush()`, which takes
 * the lock again, reads the journal's execution mappings and payloads back from
 * disk, appends, and releases. No report writes through a released lock. The
 * halt stays latched.
 *
 * Call \`flush()\` after every invocation: besides the reports \`held()\` lists, it
 * appends settlements that arrived after close and lines held back by a failed
 * append, which \`held()\` does not list. With nothing to write it does nothing.
 */
export interface ReconciliationHandle {
  flush(): Promise<FlushOutcome>
  /** Reports received and not yet persisted or classified. */
  held(): LateUsageReport[]
  bill(): UniqueExecutionBill
}

export interface PairedJournal {
  admission(binding: AdmissionBinding): RequestAdmission
  /**
   * A non-throwing reporter for a backend. Each report goes to `sink` (the run's
   * own late-usage sink, which `continueReview` drains) and, as a separate copy,
   * to the journal.
   */
  reporter(sink?: LateUsageReporter): LateUsageReporter
  /** Stop admitting. The reason is reported as a runner stop, never as a model failure. */
  stopAdmitting(reason: string): void
  bill(): UniqueExecutionBill
  /** Wait for every queued append. */
  settled(): Promise<void>
  /**
   * End the invocation: stop admitting, wait for the queue, release the lock and
   * return the reconciliation handle. Does not wait on any provider.
   */
  close(): Promise<{ handle: ReconciliationHandle; releaseError: string | null }>
}

export type JournalOpened = { ok: true; journal: PairedJournal } | { ok: false; reason: string }

/**
 * Open the journal under a lock the caller already holds.
 *
 * Existing lines are replayed first: spend from every category counts toward
 * the global cap, and any request an earlier invocation issued and never
 * settled is uncertain and latches the halt. A halt marker already at the bundle
 * root (`HALT_MARKER_FILE`, written by this journal or by the arm governor)
 * latches the halt too. When this journal latches a halt it writes that marker,
 * so the arm governor on the same root refuses as well.
 *
 * ## A failed append
 *
 * An append can fail before its bytes reach the file or after (a failed sync),
 * and possibly with a partial line. So once one fails, nothing more is appended
 * during the invocation: a line appended after a torn tail would corrupt the
 * journal. The runner stops, and every settlement or late line from then on is
 * kept in memory, in order, for `flush()`. `flush()` replays the file first,
 * skips a line already there with the same payload, and refuses a journal it
 * cannot replay rather than appending to it or truncating it.
 */
export async function openJournal(
  bundleRoot: string,
  lock: HeldLock,
  now: () => string,
  io: JournalIo = FILE_IO,
): Promise<JournalOpened> {
  const root = resolve(bundleRoot)
  const file = join(root, JOURNAL_FILE)
  const markerPath = join(root, HALT_MARKER_FILE)
  const replayed = await replayFile(file)
  if (!replayed.ok) return { ok: false, reason: replayed.reason }
  const state = replayed.state
  state.interrupt()
  try {
    await readFile(markerPath)
    state.latch(`the halt marker \`${markerPath}\` exists`)
    state.haltMarker = { file: markerPath, error: null }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      state.latch(`whether the halt marker \`${markerPath}\` exists could not be established (${messageOf(error)})`)
    }
  }

  let fileExists = replayed.existed
  let sequence = 0
  let queue: Promise<void> = Promise.resolve()
  let closed = false
  let heldLock: HeldLock | null = lock
  let markerQueued = state.haltMarker.file !== null
  /** Reports whose `executionId` is not bound yet, in arrival order. */
  let pending: LateUsageReport[] = []
  /** Reports received after close, for `flush()`. */
  let held: LateUsageReport[] = []
  /**
   * Settlement and late lines not on disk, in the order they were applied: every
   * line received after close, and every line from the first failed append on.
   * `flush()` appends them.
   */
  let unpersisted: (SettledLine | LateLine)[] = []
  /** Set by the first failed append; nothing is appended during the invocation after it. */
  let appendBroken = false
  /** Admissions refused during this invocation. */
  const refused: RefusedAdmission[] = []

  /** Serializes a task. The returned promise never rejects: a throw becomes `onError`'s value. */
  const enqueue = <T>(task: () => Promise<T>, onError: (error: unknown) => T): Promise<T> => {
    const run = queue.then(task).catch(onError)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const writeLine = async (line: JournalLine): Promise<void> => {
    try {
      await io.appendLine(file, line)
      if (!fileExists) {
        await syncDirectory(root)
        fileExists = true
      }
    } catch (error) {
      appendBroken = true
      throw error
    }
  }

  const append = (line: SettledLine | LateLine): Promise<void> =>
    enqueue(
      async () => {
        if (appendBroken) {
          unpersisted.push(line)
          return
        }
        try {
          await writeLine(line)
        } catch (error) {
          unpersisted.push(line)
          state.stop ??= `the journal \`${file}\` could not be appended: ${messageOf(error)}`
        }
      },
      (error) => {
        state.stop ??= `the journal \`${file}\` could not be appended: ${messageOf(error)}`
      },
    )

  /** Write the halt marker once, the first time a halt is latched. */
  const watchHalt = (): void => {
    if (state.halt === null || markerQueued) return
    markerQueued = true
    void enqueue(
      () => writeHaltMarker(markerPath, state),
      (error) => {
        state.haltMarker = { file: null, error: messageOf(error) }
      },
    )
  }

  const bindPending = (): void => {
    const still: LateUsageReport[] = []
    for (const report of pending) {
      const physicalId = state.byExecution.get(report.executionId)
      if (physicalId === undefined) {
        still.push(report)
        continue
      }
      applyLate(physicalId, report)
    }
    pending = still
  }

  const applyLate = (physicalId: string, report: LateUsageReport): void => {
    const request = state.requests.get(physicalId)!
    if (request.late !== undefined && sameJson(request.late, report.tokens)) return
    const line: LateLine = { type: "late", physicalId, executionId: report.executionId, tokens: tokensOf(report.tokens) }
    state.apply(line)
    void append(line)
    watchHalt()
  }

  const receive = (report: LateUsageReport): void => {
    if (report === null || typeof report !== "object") return
    if (typeof report.executionId !== "string" || report.executionId.length === 0) return
    if (!countable(report.tokens)) return
    const copy: LateUsageReport = { executionId: report.executionId, tokens: tokensOf(report.tokens) }
    if (closed) {
      held.push(copy)
      return
    }
    pending.push(copy)
    bindPending()
  }

  const nextPhysicalId = (): string => {
    let id: string
    do {
      sequence += 1
      id = `request-${sequence}`
    } while (state.requests.has(id))
    return id
  }

  const refuseAsStop = (): AdmissionDecision => ({
    ok: false,
    cause: "runner-stop",
    reason: `the paired runner stopped admitting: ${state.stop}. No model failed.`,
  })

  const journal: PairedJournal = {
    admission(binding) {
      return {
        admit(request: AdmissionRequest): Promise<AdmissionDecision> {
          /** Record a refusal in `refused`, whatever its cause, and return it. */
          const refuse = (decision: AdmissionDecision & { ok: false }): AdmissionDecision => {
            let where: Pick<RefusedAdmission, "stage" | "slot" | "attempt">
            let runId: string | undefined
            try {
              const attempt = Number(request?.attempt)
              where = { stage: String(request?.stage), slot: String(request?.slot), attempt: Number.isFinite(attempt) ? attempt : 0 }
            } catch {
              where = { stage: "unreadable", slot: "unreadable", attempt: 0 }
            }
            try {
              const id = binding.runId()
              if (typeof id === "string" && id.length > 0) runId = id
            } catch {
              // The run id is context for the refusal; its absence is recorded as absence.
            }
            refused.push({
              block: binding.block,
              phase: binding.phase,
              ...(runId === undefined ? {} : { runId }),
              ...where,
              cause: decision.cause,
              reason: decision.reason,
            })
            return decision
          }
          return enqueue(
            async (): Promise<AdmissionDecision> => {
              // A completed invocation refuses as a runner stop without latching
              // `stop`: `stop` reports a failure, and completing is not one. Nor is
              // it recorded in `refused`, which describes the invocation.
              if (closed) {
                return {
                  ok: false,
                  cause: "runner-stop",
                  reason: "the paired runner stopped admitting: the invocation has completed and admits nothing further. No model failed.",
                }
              }
              const gate = requestGate(state.view(), { block: binding.block, phase: binding.phase })
              if (!gate.ok) return refuse(gate)
              const problem = requestProblem(request)
              if (problem !== null) {
                state.stop ??= `block ${binding.block}'s ${binding.phase} asked to admit a malformed request: ${problem}`
                return refuse(refuseAsStop() as AdmissionDecision & { ok: false })
              }
              const runId = binding.runId()
              if (typeof runId !== "string" || runId.length === 0) {
                state.stop ??= `block ${binding.block}'s ${binding.phase} asked to admit a request before its run id existed`
                return refuse(refuseAsStop() as AdmissionDecision & { ok: false })
              }
              const line: IssuedLine = {
                type: "issued",
                physicalId: nextPhysicalId(),
                category: "blocks",
                block: binding.block,
                phase: binding.phase,
                stage: request.stage,
                slot: request.slot,
                attempt: request.attempt,
                runId,
              }
              try {
                await writeLine(line)
              } catch (error) {
                // The line may have reached the file before the failure. A
                // \`not-issued\` settlement is held for \`flush()\`, which appends it
                // only if the journal carries this \`issued\` line, so a request that
                // never went out is not read back as uncertain.
                unpersisted.push({ type: "settled", physicalId: line.physicalId, settlement: { kind: "not-issued" } })
                state.stop ??= `the journal \`${file}\` could not record an admission: ${messageOf(error)}`
                return refuse(refuseAsStop() as AdmissionDecision & { ok: false })
              }
              state.apply(line)
              return { ok: true, settle: settleFor(line.physicalId) }
            },
            (error) => {
              state.stop ??= `an admission could not be decided: ${messageOf(error)}`
              return refuse(refuseAsStop() as AdmissionDecision & { ok: false })
            },
          )
        },
      }
    },

    reporter(sink) {
      return {
        report(report: LateUsageReport): void {
          try {
            sink?.report(report)
          } catch {
            // The run's sink is the run's; its failure must not cost the journal its copy.
          }
          try {
            receive(report)
          } catch (error) {
            state.stop ??= `a late usage report could not be recorded: ${messageOf(error)}`
          }
        },
      }
    },

    stopAdmitting(reason) {
      state.stop ??= reason
    },

    bill: () => state.bill(pending, refused),

    settled: () => enqueue(async () => undefined, () => undefined),

    async close() {
      closed = true
      await enqueue(async () => undefined, () => undefined)
      const releaseError = heldLock === null ? null : await heldLock.release()
      heldLock = null
      held = [...pending, ...held]
      pending = []
      return { handle: reconciliationHandle(), releaseError }
    },
  }

  /**
   * The settle closure for one admitted request. It never rejects. The settled
   * line is queued BEFORE any late report it binds, so on disk a late line never
   * precedes its settlement. After `close()` it writes nothing: the settlement is
   * held for `flush()`, which appends it under a freshly taken lock.
   */
  function settleFor(physicalId: string): (settlement: AdmissionSettlement) => Promise<void> {
    return async (given) => {
      try {
        const settlement = normalizedSettlement(given)
        const request = state.requests.get(physicalId)!
        const previous = state.settlementOf(request)
        if (previous !== undefined && sameJson(previous, settlement)) return
        const line: SettledLine = { type: "settled", physicalId, settlement }
        state.apply(line)
        if (closed) {
          unpersisted.push(line)
          watchHalt()
          return
        }
        const written = append(line)
        if (previous === undefined) bindPending()
        watchHalt()
        await written
      } catch (error) {
        state.stop ??= `a settlement could not be recorded: ${messageOf(error)}`
      }
    }
  }

  function reconciliationHandle(): ReconciliationHandle {
    return {
      held: () => held.map((report) => structuredClone(report)),
      bill: () => state.bill(held, refused),
      async flush(): Promise<FlushOutcome> {
        const outcome: FlushOutcome = { ok: true, persisted: 0, conflicts: [], unmatched: [], failed: null }
        if (held.length === 0 && unpersisted.length === 0) return outcome
        const taken = await acquireLock(root, now())
        if (!taken.ok) return { ...outcome, ok: false, failed: taken.reason }
        const fail = (reason: string): FlushOutcome => {
          outcome.ok = false
          outcome.failed ??= reason
          return outcome
        }
        try {
          const disk = await replayFile(file)
          if (!disk.ok) return fail(disk.reason)
          const persist = async (line: JournalLine): Promise<boolean> => {
            try {
              await io.appendLine(file, line)
            } catch (error) {
              fail(`the journal \`${file}\` could not be appended: ${messageOf(error)}`)
              return false
            }
            const before = disk.state.integrity.length
            disk.state.apply(line)
            if (disk.state.integrity.length > before) {
              outcome.conflicts.push(...disk.state.integrity.slice(before).map((failure) => structuredClone(failure)))
            } else {
              outcome.persisted += 1
            }
            return true
          }

          // Lines already applied in memory. One the disk already carries with the
          // same payload (an append that failed after its bytes were written) is
          // not appended again.
          while (unpersisted.length > 0) {
            const line = unpersisted[0]!
            const request = disk.state.requests.get(line.physicalId)
            // A refused admission whose \`issued\` line never reached the file has
            // nothing to settle.
            if (request === undefined && line.type === "settled" && line.settlement.kind === "not-issued") {
              unpersisted.shift()
              continue
            }
            const onDisk =
              line.type === "settled"
                ? request !== undefined && sameJson(disk.state.settlementOf(request), line.settlement)
                : request?.late !== undefined && sameJson(request.late, line.tokens)
            if (!onDisk && !(await persist(line))) return outcome
            unpersisted.shift()
          }

          const keep: LateUsageReport[] = []
          while (held.length > 0) {
            const report = held[0]!
            const physicalId = disk.state.byExecution.get(report.executionId)
            if (physicalId === undefined) {
              outcome.unmatched.push(structuredClone(report))
              keep.push(report)
              held.shift()
              continue
            }
            const request = disk.state.requests.get(physicalId)!
            if (!(request.late !== undefined && sameJson(request.late, report.tokens))) {
              const line: LateLine = { type: "late", physicalId, executionId: report.executionId, tokens: report.tokens }
              if (!(await persist(line))) {
                held = [...keep, ...held]
                return outcome
              }
              state.apply(line)
            }
            held.shift()
          }
          held = keep
          if (state.halt !== null && state.haltMarker.file === null) {
            try {
              await writeHaltMarker(markerPath, state)
            } catch (error) {
              state.haltMarker = { file: null, error: messageOf(error) }
            }
          }
          return outcome
        } finally {
          const releaseError = await taken.lock.release()
          if (releaseError !== null) fail(releaseError)
        }
      },
    }
  }

  watchHalt()
  return { ok: true, journal }
}

/**
 * Write the arm governor's halt marker for a latched journal halt, without
 * overwrite: a marker already there is the halt, and is kept as it was written.
 */
async function writeHaltMarker(markerPath: string, state: JournalState): Promise<void> {
  const record = {
    halted: true,
    haltReason: state.halt,
    source: "paired journal",
    stop: state.stop,
    integrity: state.integrity,
  }
  try {
    const handle = await open(markerPath, "wx", 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(record, undefined, 2)}\n`, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await syncDirectory(dirname(markerPath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  state.haltMarker = { file: markerPath, error: null }
}

/** Append one line and flush it to stable storage before resolving. */
async function appendLine(file: string, line: JournalLine): Promise<void> {
  const handle = await open(file, "a", 0o600)
  try {
    await handle.appendFile(`${JSON.stringify(line)}\n`, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Flush a directory's entries to stable storage, so a file just created, linked
 * or renamed inside it survives a crash. Rejects when it could not.
 */
export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
