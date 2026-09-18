/**
 * The tool-action observation seam (story 2-7a, `evaluation-protocol.md` §5).
 *
 * `evaluation-protocol.md:364-386` registers tool **requests** and tool
 * **executions** as two separate counts, reported separately for clean and
 * attack runs, with insufficient evidence reported unobserved. Nothing in a run
 * record can supply either: the blame route writes four history kinds, and the
 * path, the range and the shell's exit survive only inside English prose. This
 * port is where those facts are recorded instead.
 *
 * OPTIONAL EVERYWHERE. Absent, the judge takes exactly the branches it takes
 * without it, the adapter runs exactly the argv it runs without it, and every
 * byte of the record and the rendered run is unchanged. Only an evaluation path
 * supplies one.
 *
 * INTERFACES PLUS ONE READER (AD-1). The types are the contract; the two
 * exports below (`TOOL_FAILURE_EVIDENCE` and `toolFailureEvidence`) are the one
 * piece of behaviour, and they exist so the core can read an adapter's evidence
 * off a thrown value WITHOUT naming an adapter type. There is no implementation
 * here: that belongs to the evaluation harness (story 2-7b), and
 * `adapters/opencode/tools.ts` is handed one at construction.
 *
 * ## Two layers, two facts, never fused
 *
 * A CORE decision point and an ADAPTER internal are different observations and
 * are recorded as different events:
 *
 * - `request` — the core decided whether to ask for a tool call at all. It is
 *   the only place that knows there was no port, or no line range to blame, and
 *   it is the only place that knows the finding the call belongs to.
 * - `invoked` / `shellOutcome` — the adapter reached the host shell, with the
 *   argv it actually handed over and the exit it actually got back. The core
 *   cannot see either; a port that returned a string proves nothing about
 *   whether git ran.
 * - `outcome` — the core's one terminal reading per call, mapped in one place
 *   from what the core saw plus the evidence the adapter attached to a failure.
 *
 * ## Invocation is not execution
 *
 * Entering `Tools.blame` is not a `git blame`. The two are counted apart, and
 * where the evidence cannot establish that git ran, the execution reading is
 * **unknown** — never false, and never quietly upgraded to an execution because
 * a request was observed. A reader with no adapter fact for a call reports the
 * execution endpoint **unavailable**.
 *
 * ## ONE ROUTE, AND IT IS NAMED
 *
 * This seam observes AD-13's FIRST route only: the `git blame` the judge runs
 * itself, for a finding's own locus. AD-13's SECOND route — the tools a spawned
 * session inherits from the host (`adapters/opencode/model-backend.ts`) — emits
 * NO request and NO execution event here, because nothing in this tree sees
 * those calls. A count drawn from this trace is a count over the first route and
 * nothing wider; the second route is **unobserved**, which is not the same fact
 * as "did not happen" and must never be reported as zero.
 *
 * ## Correlation
 *
 * The core mints `observationId` and carries run, finding, observation and
 * arguments on every event it writes. The adapter is handed an observer **bound
 * to the run it was constructed for**, and writes the same arguments back on its
 * own facts.
 *
 * THE JOIN IS BY ORDER, AND THE ARGUMENTS ARE A CHECK ON IT, not the join
 * itself. Two findings can legitimately carry the same path and range, so
 * arguments alone do not identify a call. What makes the order well defined is
 * that the judge drives blame from one sequential loop and AWAITS its request
 * before delegating, so an adapter fact always belongs to the last request
 * written; `core/stages/judge.test.ts` pins that sequencing against two findings
 * with identical arguments, so a change that made the loop concurrent fails
 * there rather than silently mis-joining a trace. An implementation that finds
 * an adapter fact whose arguments disagree with the open request has detected a
 * broken join and should record an integrity failure rather than guess.
 *
 * There is no global current-call slot, and `Tools` method signatures are
 * unchanged (`core/ports/tools.ts:29-33`).
 *
 * Case and schedule identity are the harness's; they are joined later by these
 * ids and are deliberately not production fields.
 *
 * ## The contract a caller relies on
 *
 * - `request` is recorded BEFORE the core delegates, and is awaited, so a trace
 *   that carries an invocation with no request in front of it is an integrity
 *   failure rather than an ordering accident.
 * - Every write may reject. A rejection is an OBSERVATION failure: it never
 *   changes a verdict, never becomes a tool failure, and is recorded under its
 *   own name. The judge raises `tool-observation-failed`, which is a separate
 *   warning from `blame-unavailable`.
 * - `failed` is how a layer with no run record — the adapter — reports one of
 *   those. It must not throw.
 * - `takeFailures` returns and CLEARS what `failed` has collected. The judge
 *   drains it at the end of the stage so an adapter-side trace failure reaches
 *   the same warning a core-side one does. It must not throw.
 */

/** The tools this seam observes. `blame` is the one `Tools` method driven. */
export type ObservedTool = "blame"

/** `git blame`'s arguments, raw: the model's path and the range asked of git. */
export interface BlameArguments {
  /** `Finding.locus.file` verbatim — a discovery model's free string. */
  path: string
  startLine: number
  /**
   * The end line ASKED OF GIT, after the judge's `MAX_BLAME_ROWS` clamp. A trace
   * that recorded the finding's end line would name a range git was never asked
   * about.
   */
  endLine: number
}

/** Which observation an event belongs to. */
export interface ToolCallContext {
  runId: string
  /** `Finding.id` — the finding the decision was made for. */
  findingId: string
  /**
   * Minted by the core at the decision point, and the key that joins a request
   * to its terminal reading.
   *
   * NOT CALLED A CALL ID, deliberately. Three of the four branches it identifies
   * made no call at all — there was no port, or no line range — and a field
   * named for a call would assert one had happened every time a row was written.
   * Where the request state is `made` it is also that call's identity.
   */
  observationId: string
  tool: ObservedTool
}

/**
 * What the core decided at its own decision point.
 *
 * - `made` — the core called the port. Carries the arguments it passed.
 * - `unavailable` — no `Tools` port was injected, so no request could be made.
 *   This is AD-13's second route, which is valid and is not a degradation.
 * - `not-made` — the finding names no line range, so there was nothing to ask.
 *
 * The last two are different facts and a count that merged them would report a
 * run with no port as a run that chose not to ask.
 */
export type ToolRequestState =
  | { kind: "made"; args: BlameArguments }
  | { kind: "unavailable"; why: "no-port" }
  | { kind: "not-made"; why: "no-locus" }

export interface ToolRequestEvent {
  context: ToolCallContext
  request: ToolRequestState
  /** `Clock.now()` at the decision point. */
  at: string
}

/**
 * The adapter reached the host shell. Written BEFORE the call is awaited, so an
 * interrupted call still leaves the fact that something was launched at.
 */
export interface ToolInvocationFact {
  tool: ObservedTool
  args: BlameArguments
  /** Exactly what went to the host as argv, `git` included. */
  argv: readonly string[]
  at: string
}

/**
 * What the host shell's return establishes about whether the program ran.
 *
 * - `proved` — a zero exit from the pinned real-git path.
 * - `failed` — the host itself reported that it could not find the command, so
 *   nothing ran.
 * - `unproved` — a non-zero exit. The program may have run and failed, or may
 *   never have started; see `adapters/opencode/tools.ts`'s header for what the
 *   pinned interface does and does not establish.
 * - `not-attempted` — nothing was launched at, because the call was refused
 *   before any shell ran. Never the reading of a `ToolShellOutcome`, which by
 *   construction describes a shell that returned.
 */
export type LaunchEvidence = "proved" | "failed" | "unproved" | "not-attempted"

/** What the host shell returned. Written after the call resolves. */
export interface ToolShellOutcome {
  tool: ObservedTool
  args: BlameArguments
  exitCode: number
  launch: LaunchEvidence
  /**
   * The host's own diagnostic. Repository text under AD-18, and BOUNDED before
   * it is written: git echoes a model-supplied path into its own `fatal:` line,
   * so this is untrusted text of unbounded length and the adapter clips it to
   * `MAX_STDERR_CHARS`, stating the clip rather than truncating silently.
   */
  stderr: string
  at: string
}

/**
 * The most stderr one shell outcome may carry, and the clip marker appended when
 * it bites.
 *
 * Sized to hold a whole `fatal:` line from git with room to spare, which is what
 * a reader needs to tell one failure from another. A trace field is not the
 * place to store an arbitrary amount of host output, and a truncation nobody is
 * told about is the AD-6 failure in miniature — so the marker is part of the
 * value rather than a convention a reader has to know.
 */
export const MAX_STDERR_CHARS = 2000
export const STDERR_CLIPPED = " … (clipped)"

/**
 * THE FIVE TERMINAL READINGS, and the only five. One per observation, written by
 * the core.
 *
 * - `not-executed` — the request was observed and execution did not occur. The
 *   core refused it (`refusedAt: "core"`), the adapter refused the range before
 *   any shell ran (`"pre-shell"`), or the host reported the command missing
 *   (`"launch"`).
 * - `executed` — a call that returned output the core could parse. It is one
 *   execution whether or not it produced a usable citation.
 * - `executed-failed` — one execution PLUS a failure. The execution still
 *   counts; the failure is recorded beside it, never instead of it.
 * - `invoked-unknown` — an invocation was observed and the execution reading is
 *   unknown: a non-zero exit with no reliable launch evidence.
 * - `unknown` — no launch evidence at all: an interrupted or exceptional call.
 *   **Never false.**
 */
export type ToolTerminalOutcome =
  | { kind: "not-executed"; refusedAt: "core" | "pre-shell" | "launch"; why: string }
  | { kind: "executed" }
  | { kind: "executed-failed"; failure: string }
  | { kind: "invoked-unknown"; exitCode: number; why: string }
  | { kind: "unknown"; why: string }

export interface ToolOutcomeEvent {
  context: ToolCallContext
  outcome: ToolTerminalOutcome
  at: string
}

/** The four writes a layer can fail at, named so a failure says which. */
export type ToolObservationWrite = "request" | "outcome" | "invoked" | "shellOutcome"

/**
 * An observation that could not be recorded. Never a tool failure.
 *
 * IT CARRIES ENOUGH TO SAY WHICH ONE. A run over fifty findings that lost fifty
 * writes to the same broken sink would otherwise report fifty identical
 * sentences, which tells a reader the count and nothing else — and the count is
 * the half they already have.
 */
export interface ToolObservationFailure {
  /** Which layer could not record. */
  where: "core" | "adapter"
  /** Which write failed. */
  write: ToolObservationWrite
  /** The observation it belonged to, where the layer knows it. The adapter does not. */
  observationId?: string
  why: string
}

export interface ToolObservation {
  /** CORE, before delegation, awaited. */
  request(event: ToolRequestEvent): Promise<void>
  /** CORE, once per observation. */
  outcome(event: ToolOutcomeEvent): Promise<void>
  /** ADAPTER, before the shell call is awaited. */
  invoked(fact: ToolInvocationFact): Promise<void>
  /** ADAPTER, after the shell call resolves. */
  shellOutcome(fact: ToolShellOutcome): Promise<void>
  /** A write that could not be recorded. MUST NOT throw. */
  failed(failure: ToolObservationFailure): void
  /** Return and clear what `failed` collected. MUST NOT throw. */
  takeFailures(): readonly ToolObservationFailure[]
}

/**
 * What an adapter attaches to the error it throws, so the core's terminal
 * reading is not blinder than the adapter was.
 *
 * STRUCTURAL ON PURPOSE. The core reads a shape, never an adapter's error class
 * (AD-1), and a port that does not carry it yields `unknown` — which is the
 * honest reading for a caller whose evidence is missing, not a defect.
 */
export interface ToolFailureEvidence {
  /** Where the call died. `shell` means the host returned a non-zero exit. */
  stage: "pre-shell" | "shell"
  /** Present only for `shell`, and only as a whole number. */
  exitCode?: number
  launch: LaunchEvidence
}

/** The property an adapter sets. Named once so the two sides cannot drift. */
export const TOOL_FAILURE_EVIDENCE = "toolFailure" as const

/**
 * Read the evidence off a thrown value, or `undefined` when there is none.
 *
 * TOTAL, AND DELIBERATELY STRICT. Any value may be passed, including one from a
 * port this tree did not write, and what comes back is used to decide whether a
 * run EXECUTED a command — so a field it cannot vouch for is dropped rather than
 * carried through as though it had been checked:
 *
 * - An `exitCode` that is not a whole number is not an exit code. `typeof
 *   value === "number"` alone admits `1.5` and `NaN`, and `NaN` would travel
 *   into a terminal reading as an exit nobody can interpret.
 * - A `pre-shell` refusal never ran a shell, so it cannot have an exit code. One
 *   attached to it is dropped rather than reported, because the two together are
 *   a contradiction and the stage is the half that is checkable.
 * - A `shell` stage with no usable exit code keeps its evidence — the launch
 *   reading is still worth having — and `blameFailureOutcome` reads the missing
 *   exit as `unknown`, which is what it means.
 */
export function toolFailureEvidence(error: unknown): ToolFailureEvidence | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const carried = (error as Record<string, unknown>)[TOOL_FAILURE_EVIDENCE]
  if (typeof carried !== "object" || carried === null) return undefined
  const { stage, exitCode, launch } = carried as Record<string, unknown>
  if (stage !== "pre-shell" && stage !== "shell") return undefined
  if (launch !== "proved" && launch !== "failed" && launch !== "unproved" && launch !== "not-attempted") {
    return undefined
  }
  const usableExit = stage === "shell" && typeof exitCode === "number" && Number.isInteger(exitCode)
  return {
    stage,
    launch,
    ...(usableExit ? { exitCode: exitCode as number } : {}),
  }
}
