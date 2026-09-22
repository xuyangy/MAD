/**
 * Story 2-7c — the controllable launcher `git blame` runs through, and the only
 * one in this tree.
 *
 * ## Why the host shell could not stay
 *
 * Awaiting `` $`git ${argv}` `` yields a `BunShellPromise`, and the pinned
 * interface carries no pid, no kill and no abort — so a `git blame` that never
 * returns holds the judge, the stage and the experiment lock with nothing MAD
 * can do about it. `ablation/LIVE-RUN.md` names bounded tool TERMINATION as a
 * prerequisite of the sixteen live adversarial runs, and abandoning the wait
 * while the process runs on is not termination. So `blame` runs here instead of
 * through the shell — and `blame` only: `adapters/opencode/repo.ts` reads the
 * change through `$` and is deliberately untouched.
 *
 * ## BEFORE THE LAUNCH AND AFTER IT ARE DIFFERENT FACTS
 *
 * This is the distinction the whole outcome union is built around, and getting
 * it wrong is the one failure mode that turns a blind spot into a measurement.
 *
 * - **`launch-failed` is PRE-LAUNCH ONLY.** The operating system refused to
 *   start the program — a missing binary, an unreadable working directory. That
 *   is a PROVED non-execution, and `core/judge/blame.ts` reads it as one.
 * - **`refused` is MAD'S OWN PRE-LAUNCH FAULT.** A deadline no timer can honour
 *   means nothing is attempted. Nothing executed here either, but the reason
 *   belongs to MAD's wiring rather than to the host, and reporting it as
 *   `launch-failed` would file a bug in this repository as a measurement of the
 *   machine the run was made on. The caller classifies it `pre-shell`.
 * - **`observation-failed` is POST-LAUNCH.** A spawn handle came back and then
 *   something about watching the process failed: the exit promise rejected, or
 *   the output could not be read to its end. Holding a spawn handle does NOT
 *   prove the git executable ever ran, so the honest reading is `unproved` →
 *   `unknown` — never the proved non-execution `launch-failed` would assert, and
 *   never an execution either. Whatever exit facts really were established are
 *   preserved; none are invented.
 *
 * ## What "bounded" claims, and what it does not
 *
 * A DEADLINE STOPS WAITING. TERMINATION IS CONFIRMED SEPARATELY, and the two are
 * returned as different facts. At `deadlineMs` the child is killed forcibly at
 * once; a further `cleanupMs` is spent confirming it. If that budget passes with
 * anything still outstanding, the outcome is `cleanup-unresolved` and MAD says
 * the process MAY STILL BE RUNNING — never that it is, and never that it stopped.
 *
 * NO MATHEMATICAL WALL-CLOCK BOUND IS PROMISED. The deadline is nominal
 * execution plus at most the cleanup budget, and both are measured by
 * `setTimeout` on an event loop a synchronous caller can block and by an OS that
 * owes no schedule. What is promised is that MAD stops waiting and says which of
 * the outcomes it got.
 *
 * NO EXIT CODE IS EVER INVENTED. There is no synthesized `124` here.
 * `ablation/adversarial-materialize.ts`'s `spawnGit` is the anti-pattern this
 * file was written against: it sends SIGTERM with no escalation, awaits both
 * pipes BEFORE `exited` — so a child holding a pipe open cannot be waited out at
 * all — and fabricates `exitCode: 124` from a timeout flag, which is a number a
 * reader cannot tell from one git actually returned.
 *
 * ## What CONFIRMED termination requires, and why it is three things
 *
 * A confirmed cleanup needs the exit to be established AND both pipes to have
 * reached their natural end. The pipes are part of it because they are the only
 * signal available here about DESCENDANTS: the signal goes to the child MAD
 * spawned, and a credential helper or an external diff driver git left behind
 * never receives it. Such a descendant inherits the write end of the pipes, so
 * output that never reaches EOF after the child is gone means something else is
 * still holding it. Reading that as "confirmed gone" would be a claim about a
 * process MAD cannot see, so it is reported as unresolved instead — which
 * quarantines.
 *
 * WHAT "CONFIRMED" THEREFORE MEANS, EXACTLY: the OBSERVED resources are
 * accounted for — the direct child was reaped and both pipes reached EOF. It
 * does NOT mean no descendant survived. A descendant that closed the inherited
 * pipes, or was started with its output redirected elsewhere, leaves both
 * signals looking clean while it runs on. Nothing at this layer can see that,
 * and this file does not pretend to: the guarantee is over what was observed,
 * and a process tree is not observed. Narrowing it further needs a process-group
 * kill or a supervision tree, which are decisions about what MAD signals on a
 * user's machine rather than properties of one command.
 *
 * A REJECTED EXIT PROMISE IS NEVER CONFIRMATION. A failed read of the exit
 * status says nothing about whether the process ended. It is only treated as
 * confirmed when an independent source — a real exit code or a real terminating
 * signal recorded on the handle — says so.
 *
 * ## No graceful period, and that is a policy rather than a limitation
 *
 * `git blame` is read-only: there is nothing to flush and nothing to corrupt by
 * killing it, so the approved policy (2026-09-21) is immediate forcible
 * termination. That is not a claim that a TERM-then-KILL sequence must be
 * unbounded — a graceful period can be bounded perfectly well — only that this
 * command does not earn one.
 *
 * ## The pipes are raced, never awaited first
 *
 * Output and exit are started together and raced against the deadline as one.
 * Awaiting the pipes before the exit is the specific bug that makes a timeout
 * unreachable. Read resources are released only AFTER the cleanup decision has
 * been taken, because cancelling a read makes it settle — a release performed
 * first would manufacture the very confirmation it is supposed to be testing for.
 */

import { deadlineProblem } from "../../core/ports/observation-wait.ts"

/** The subprocess surface this file uses. `Bun.spawn`'s return satisfies it. */
export interface SpawnedBlame {
  readonly pid: number
  readonly stdout: ReadableStream<Uint8Array> | number | null | undefined
  readonly stderr: ReadableStream<Uint8Array> | number | null | undefined
  readonly exited: Promise<number>
  readonly exitCode: number | null
  readonly signalCode: string | null
  kill(signal?: number): void
}

/** How a process is started. Injected in tests; the default is `Bun.spawn`. */
export type SpawnBlame = (request: { cmd: string[]; cwd: string }) => SpawnedBlame

/**
 * `"ignore"` RATHER THAN INHERIT, and it is a deliberate difference from the
 * host shell rather than an oversight.
 *
 * A git that decides to prompt — for a credential, for a passphrase — blocks on
 * its standard input until something answers. MAD has no terminal to answer
 * with, and a plugin's standard input is the host's, so inheriting it turns one
 * blame into an indefinite hang that a reader would read as a slow repository.
 * With no input to read, that class of hang becomes a fast non-zero exit git
 * explains on stderr, which is evidence rather than silence.
 */
const STDIN_SOURCE = "ignore" as const

/** What the child actually reported, or `null` where nothing was observed. */
export interface ObservedExit {
  /** The real exit code, never a synthesized one. `null` when it was killed or unknown. */
  exitCode: number | null
  /** The real terminating signal, e.g. `"SIGKILL"`. `null` when there was none. */
  signal: string | null
}

/** Whether the process and the resources it held were accounted for. */
export type CleanupState =
  | { kind: "confirmed"; observed: ObservedExit }
  | { kind: "unresolved"; why: string }

/**
 * The outcomes a bounded blame can end as. They are kept apart because the
 * caller classifies each one differently, and a union that fused any two of them
 * would hand `core/judge/blame.ts` an evidence shape it could not tell apart.
 */
export type BlameExecOutcome =
  /**
   * The process ran and returned. `exitCode` is git's own, zero or not.
   *
   * `stderrFailure` IS THE STRUCTURAL TAG. Where it is set, `stderr` is empty
   * and the string in it is MAD's account of why the pipe could not be read —
   * never something git said. A caller that merges the two loses the only
   * distinction between a diagnostic the program emitted and one it did not.
   */
  | {
      kind: "returned"
      exitCode: number
      signal: string | null
      stdout: string
      stderr: string
      stderrFailure: string | null
    }
  /**
   * NOTHING STARTED, and the launcher saw that for itself. PRE-LAUNCH ONLY — see
   * this file's header. It is the authoritative launch-failure signal that
   * replaces reading the old shell's `bun: command not found: ` line out of
   * stderr, and it is the only outcome here that proves a non-execution.
   */
  | { kind: "launch-failed"; why: string }
  /**
   * MAD REFUSED TO LAUNCH, AND THE REFUSAL IS ITS OWN. A caller handed this
   * function a deadline no timer can honour, so nothing was attempted. Nothing
   * executed — as with `launch-failed` — but the reason is a MAD-side
   * construction fault rather than anything the operating system said, and the
   * two must not be reported as one: `launch-failed` is a MEASUREMENT of the
   * host, and a bug in MAD's own wiring is not evidence about the host.
   */
  | { kind: "refused"; why: string }
  /**
   * A SPAWN HANDLE CAME BACK AND THEN THE OBSERVATION FAILED. Nothing about
   * whether git ran is established either way. `cleanup` says whether the
   * process and its resources were accounted for afterwards; unresolved
   * quarantines, confirmed does not.
   */
  | { kind: "observation-failed"; why: string; pid: number; cleanup: CleanupState }
  /**
   * The deadline passed, the kill was sent, and the child AND its pipes were
   * accounted for within the cleanup budget. `observed` carries whatever exit or
   * signal really came back — preserved, never read as proof that git executed.
   */
  | { kind: "terminated"; why: string; pid: number; observed: ObservedExit }
  /**
   * The deadline passed and the cleanup budget passed with the process, a
   * descendant or a held pipe still unaccounted for. It MAY STILL BE RUNNING.
   * This is the outcome that quarantines the adapter.
   */
  | { kind: "cleanup-unresolved"; why: string; pid: number }

export interface BlameExecOptions {
  /** The exact argv, program included. Handed over element for element. */
  argv: readonly string[]
  /** The worktree the process runs in. */
  cwd: string
  /** Nominal execution. At this point the child is killed forcibly, with no grace. */
  deadlineMs: number
  /** How long after the kill MAD waits to account for the child and its pipes. */
  cleanupMs: number
  /** Test seam. Defaults to `Bun.spawn` with piped output and no inherited stdin. */
  spawn?: SpawnBlame
}

/** SIGKILL. The number rather than the name, so the seam takes one shape only. */
const SIGKILL = 9

/**
 * What one pipe gave back. A failed read is TAGGED, never flattened to `""`.
 *
 * `unreadEnd` SEPARATES TWO FAILURES THE CLEANUP DECISION READS DIFFERENTLY. A
 * stream that existed and whose end MAD never saw carries no information about
 * descendants, so it cannot support a confirmed cleanup. A stream that was never
 * there at all is a different fact: there is no inherited write end to reason
 * about, so its absence is not evidence of a survivor.
 */
type PipeRead = { ok: true; text: string } | { ok: false; why: string; unreadEnd: boolean }

/** What the exit gave back. A rejection is TAGGED, never read as an exit. */
type ExitRead = { ok: true; code: number } | { ok: false; why: string }

/** A promise plus a live "has it settled yet" flag, for naming what is outstanding. */
interface Tracked<T> {
  promise: Promise<T>
  settled: () => boolean
}

function track<T>(promise: Promise<T>): Tracked<T> {
  let done = false
  const tracked = promise.then(
    (value) => {
      done = true
      return value
    },
    (error: unknown) => {
      done = true
      throw error
    },
  )
  return { promise: tracked, settled: () => done }
}

/**
 * Read one piped stream to its end.
 *
 * IT NEVER REJECTS AND IT NEVER LIES. A failed, partial or impossible read comes
 * back as `{ ok: false }` with a reason. It must not come back as `""`: an empty
 * string is what a command that printed nothing gives, and the caller turns
 * stdout into a citation — so a truncated-but-parseable porcelain prefix
 * presented as the whole output is a citation over lines git never confirmed.
 *
 * A MISSING OR UNUSABLE HANDLE IS ALSO A FAILED READ. There is no contract under
 * which "the launcher gave us no stdout pipe" means "the program produced no
 * output", so it is not reported as one.
 *
 * `release()` cancels through the reader — the supported mechanism, and the one
 * that works while a read is in flight, which `stream.cancel()` does not once a
 * reader holds the lock. It is called only after the cleanup decision, because
 * cancelling makes the read settle.
 */
function readPipe(
  stream: SpawnedBlame["stdout"],
  name: string,
): { read: Tracked<PipeRead>; release: () => void; setupFailure: string | null } {
  const unusable = (why: string, unreadEnd: boolean) => ({
    read: track(Promise.resolve<PipeRead>({ ok: false, why, unreadEnd })),
    release: () => undefined,
    setupFailure: why,
  })

  if (stream === null || stream === undefined || typeof stream === "number") {
    // NO PIPE EXISTED, so no descendant can be holding its write end. The read
    // still failed — the caller gets no output — but the cleanup decision has
    // nothing to withhold confirmation for.
    return unusable(`no ${name} pipe was available, so the command's ${name} was never read`, false)
  }

  // ACQUIRING THE READER IS ITSELF A FAILABLE STEP, AND IT FAILS SYNCHRONOUSLY.
  // A stream something else already holds a reader on throws `ReadableStream is
  // locked` right here, before any promise exists. Uncaught, that would escape
  // `runBoundedBlame` as a thrown value — past the kill, past the cleanup budget
  // and past every classification — leaving a live process behind and handing the
  // judge an error it cannot read as anything but `unknown`. Setup failure is
  // therefore the same tagged outcome a failed read is.
  let acquired: ReturnType<typeof stream.getReader>
  try {
    acquired = stream.getReader()
  } catch (error) {
    // THE PIPE IS REAL AND SOMETHING ELSE HOLDS IT. Its end will never be
    // observed here, so cleanup cannot be confirmed on it.
    return unusable(`the ${name} pipe could not be opened for reading: ${messageOf(error)}`, true)
  }
  const reader = acquired

  const read = track(
    (async (): Promise<PipeRead> => {
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value !== undefined) {
            chunks.push(value)
            size += value.length
          }
        }
      } catch (error) {
        return { ok: false, why: `the ${name} pipe could not be read to its end: ${messageOf(error)}`, unreadEnd: true }
      }
      const joined = new Uint8Array(size)
      let at = 0
      for (const chunk of chunks) {
        joined.set(chunk, at)
        at += chunk.length
      }
      return { ok: true, text: new TextDecoder().decode(joined) }
    })(),
  )
  return {
    read,
    setupFailure: null,
    release: () => {
      // Total, for the reason acquiring is: a release that threw would escape the
      // path that exists to hand the caller a classified failure. The rejection a
      // cancel can produce is consumed here; there is no caller left that a
      // released resource could fail for.
      try {
        // CANCEL, THEN GIVE THE LOCK BACK. Cancelling ends the read but leaves
        // the reader holding the stream, so a caller that went looking would
        // still find it locked — which is not what "released" means. The lock is
        // returned once the cancel has settled, because releasing under a live
        // read is itself an error.
        void reader
          .cancel()
          .catch(() => undefined)
          .finally(() => {
            try {
              reader.releaseLock()
            } catch {
              // Already released, or released by something else. Either way the
              // stream is not held by us.
            }
          })
      } catch {
        // Nothing left to report to at this layer.
      }
    },
  }
}

const defaultSpawn: SpawnBlame = (request) =>
  Bun.spawn({
    cmd: request.cmd,
    cwd: request.cwd,
    stdin: STDIN_SOURCE,
    stdout: "pipe",
    stderr: "pipe",
    // THE ONLY ENVIRONMENT DIFFERENCE, AND IT IS A REPAIR RATHER THAN A CHOICE.
    // The child otherwise inherits this process's environment unchanged, which
    // is what the host shell does too — but `posix_spawn` sets the working
    // DIRECTORY without touching `PWD`, so the child would be handed the
    // parent's `PWD` while actually running somewhere else. Bun's `$` keeps the
    // two in step, `scripts/probe-host-shell.ts` measured the difference, and
    // this is what closes it. Nothing else in the environment is added, removed
    // or rewritten.
    env: { ...process.env, PWD: request.cwd },
  }) as unknown as SpawnedBlame

/**
 * Run one command under a deadline and a separate cleanup budget.
 *
 * It never throws: every failure it can see is one of the outcomes, because the
 * caller's job is to classify what happened and a thrown value is the one shape
 * that carries no classification.
 */
export async function runBoundedBlame(options: BlameExecOptions): Promise<BlameExecOutcome> {
  // REFUSED BEFORE ANYTHING IS LAUNCHED. A deadline of zero, of `NaN` or past the
  // timer ceiling fires immediately, which would turn every blame into a kill
  // that looks like a hang nobody can reproduce. Nothing has started yet, so this
  // really is a pre-launch refusal.
  for (const [name, ms] of [
    ["the blame execution deadline", options.deadlineMs],
    ["the blame cleanup budget", options.cleanupMs],
  ] as const) {
    const problem = deadlineProblem(name, ms)
    if (problem !== null) return { kind: "refused", why: `nothing was launched: ${problem}` }
  }

  const spawn = options.spawn ?? defaultSpawn

  let child: SpawnedBlame
  try {
    child = spawn({ cmd: [...options.argv], cwd: options.cwd })
  } catch (error) {
    // A SPAWN THAT FAILED IS PROOF NOTHING RAN, which is the one thing the old
    // shell could never give: `nothrow()` turned a missing command into an
    // ordinary resolved value and the only way to recognise it was a string
    // match on stderr, against text git itself could be made to echo.
    return { kind: "launch-failed", why: messageOf(error) }
  }

  // AN OPERATOR RECOVERS BY THIS NUMBER, so a handle that carries none must not
  // reach a halt reason as `undefined`. `-1` is never a real pid, and the
  // reasons below say "process -1" rather than pretending to identify one.
  const pid = Number.isInteger(child.pid) && child.pid > 0 ? child.pid : -1
  const out = readPipe(child.stdout, "stdout")
  const err = readPipe(child.stderr, "stderr")
  // TAGGED, SO A REJECTED EXIT IS NEVER READ AS AN EXIT.
  const exit = track(
    child.exited.then(
      (code): ExitRead => ({ ok: true, code }),
      (error: unknown): ExitRead => ({
        ok: false,
        why: `the process's exit status could not be read: ${messageOf(error)}`,
      }),
    ),
  )
  const releaseReads = (): void => {
    // BOTH, ALWAYS, whatever happened to either. A second pipe whose setup failed
    // after the first reader was acquired must not leave that first reader held.
    out.release()
    err.release()
  }

  // A STDOUT PIPE THAT COULD NOT BE OPENED IS KNOWN-BROKEN NOW, not at the
  // deadline. The call cannot produce anything a citation could rest on,
  // so the process is terminated and accounted for immediately rather than being
  // left to run out its execution budget for output nobody can read. A stderr
  // pipe is diagnostic and does not take this branch: it degrades the message.
  if (out.setupFailure !== null) {
    const killError = forceKill(child)
    const cleanup = await accountFor(child, { exit, out: out.read, err: err.read }, options.cleanupMs)
    releaseReads()
    return {
      kind: "observation-failed",
      pid,
      cleanup,
      why:
        `\`${options.argv.join(" ")}\` was launched as process ${pid} and then ${out.setupFailure}` +
        `${killError === null ? "; it was sent SIGKILL" : `; SIGKILL could not be sent (${killError})`}. ` +
        `Whether git ran is UNKNOWN — a spawn handle is not evidence that the program executed`,
    }
  }

  // STARTED TOGETHER, AWAITED AS ONE. See the header: awaiting the pipes first
  // is what makes a deadline unreachable.
  const finished = Promise.all([exit.promise, out.read.promise, err.read.promise])

  let timer: ReturnType<typeof setTimeout> | undefined
  let raced: Awaited<typeof finished> | "deadline"
  try {
    raced = await Promise.race<Awaited<typeof finished> | "deadline">([
      finished,
      new Promise<"deadline">((resolve) => {
        timer = setTimeout(() => resolve("deadline"), options.deadlineMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }

  if (raced === "deadline") {
    const killError = forceKill(child)
    const cleanup = await accountFor(child, { exit, out: out.read, err: err.read }, options.cleanupMs)
    releaseReads()
    const tried = killError === null ? `it was sent SIGKILL` : `SIGKILL could not be sent (${killError})`
    if (cleanup.kind === "unresolved") {
      return {
        kind: "cleanup-unresolved",
        pid,
        why:
          `\`${options.argv.join(" ")}\` did not return within ${options.deadlineMs}ms and ${tried}, ` +
          `but ${options.cleanupMs}ms later ${cleanup.why}: TERMINATION IS UNCONFIRMED and the process ` +
          `may still be running`,
      }
    }
    return {
      kind: "terminated",
      pid,
      observed: cleanup.observed,
      why:
        `\`${options.argv.join(" ")}\` did not return within ${options.deadlineMs}ms, ${tried}, and ` +
        `process ${pid} and its output were accounted for${describeObserved(cleanup.observed)}`,
    }
  }

  const [exitRead, stdout, stderr] = raced

  if (!exitRead.ok) {
    // POST-LAUNCH, AND LIVENESS IS UNCONFIRMED. A failed exit read says nothing
    // about whether the process ended, so termination is attempted under the
    // same bounded policy rather than assumed.
    const killError = forceKill(child)
    const cleanup = await accountFor(child, { exit, out: out.read, err: err.read }, options.cleanupMs)
    releaseReads()
    return {
      kind: "observation-failed",
      pid,
      cleanup,
      why:
        `\`${options.argv.join(" ")}\` was launched as process ${pid} and then ${exitRead.why}` +
        `${killError === null ? "; it was sent SIGKILL" : `; SIGKILL could not be sent (${killError})`}. ` +
        `Whether git ran is UNKNOWN — a spawn handle is not evidence that the program executed`,
    }
  }

  if (!stdout.ok) {
    // THE PROCESS ITSELF IS ACCOUNTED FOR — its exit was read — but the output a
    // citation would be built from was not. Reporting `""` here is what would
    // let a truncated read become a confident "the history contradicts nothing".
    //
    // THE CLEANUP IS ASKED FOR RATHER THAN ASSERTED. A read that never reached
    // the end of a real pipe is exactly the descendant signal `accountFor`
    // withholds confirmation for, and hard-coding `confirmed` here would state
    // the opposite of what was observed. Everything has already settled, so this
    // spends none of the budget.
    const cleanup = await accountFor(child, { exit, out: out.read, err: err.read }, options.cleanupMs)
    releaseReads()
    return {
      kind: "observation-failed",
      pid,
      cleanup,
      why:
        `\`${options.argv.join(" ")}\` exited with status ${exitRead.code}, but ${stdout.why}. The ` +
        `output is INCOMPLETE, so nothing was read that a citation could rest on`,
    }
  }

  releaseReads()
  return {
    kind: "returned",
    exitCode: exitRead.code,
    signal: child.signalCode,
    stdout: stdout.text,
    // STDERR IS DIAGNOSTIC, NOT REQUIRED, so a failed read of it degrades the
    // message rather than the call. It degrades it in a FIELD OF ITS OWN: the
    // text below is git's or it is absent, and MAD's reason for not having it
    // travels beside it where no reader can mistake one for the other.
    stderr: stderr.ok ? stderr.text : "",
    stderrFailure: stderr.ok ? null : stderr.why,
  }
}

/** Send SIGKILL, and report why it could not be sent rather than assuming it was. */
function forceKill(child: SpawnedBlame): string | null {
  try {
    child.kill(SIGKILL)
    return null
  } catch (error) {
    return messageOf(error)
  }
}

function observedOf(child: SpawnedBlame): ObservedExit {
  return { exitCode: child.exitCode, signal: child.signalCode }
}

/**
 * Account for the process AND the resources it held, within the cleanup budget.
 *
 * THREE THINGS, NOT ONE. The exit says the child MAD spawned is gone; the two
 * pipes reaching their natural end are the only evidence available here that
 * nothing else inherited them. A descendant holding the write end keeps a pipe
 * open after the child is reaped, and calling that "confirmed gone" would be a
 * statement about a process this layer cannot see.
 *
 * NOTHING IS CANCELLED HERE. Cancelling a read settles it, so a release
 * performed inside this function would manufacture the confirmation it is
 * testing for. The caller releases afterwards.
 */
async function accountFor(
  child: SpawnedBlame,
  parts: { exit: Tracked<ExitRead>; out: Tracked<PipeRead>; err: Tracked<PipeRead> },
  cleanupMs: number,
): Promise<CleanupState> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled: "settled" | "timeout"
  try {
    settled = await Promise.race<"settled" | "timeout">([
      Promise.all([parts.exit.promise, parts.out.promise, parts.err.promise]).then(() => "settled" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), cleanupMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }

  if (settled === "timeout") {
    const outstanding: string[] = []
    if (!parts.exit.settled()) outstanding.push(`process ${child.pid} had not been reaped`)
    const pipes: string[] = []
    if (!parts.out.settled()) pipes.push("stdout")
    if (!parts.err.settled()) pipes.push("stderr")
    if (pipes.length > 0) outstanding.push(`its ${pipes.join(" and ")} pipe(s) were still open`)
    return {
      kind: "unresolved",
      // THE DESCENDANT SENTENCE BELONGS TO THE PIPES AND ONLY TO THEM. Appending
      // it to an unreaped process would explain an open pipe that is not part of
      // this failure, and a reason that explains the wrong thing is one a reader
      // acts on wrongly.
      why:
        pipes.length > 0
          ? `${outstanding.join(" and ")} — an open pipe after the child is gone means something that ` +
            `inherited it is still running, and no signal sent here reaches it`
          : outstanding.join(" and "),
    }
  }

  // SETTLING IS NOT REACHING THE END. A pipe whose reader could not be acquired
  // settles immediately, and one that threw mid-stream settles too — neither saw
  // EOF, so neither carries the descendant evidence confirmation rests on. This
  // is the half of the three-part rule that `Promise.all` alone cannot express:
  // it waits for the promises, not for what they say.
  const unseen: string[] = []
  for (const [name, part] of [
    ["stdout", parts.out],
    ["stderr", parts.err],
  ] as const) {
    const read = await part.promise
    if (!read.ok && read.unreadEnd) unseen.push(`${name} (${read.why})`)
  }

  const exitRead = await parts.exit.promise
  const exitConfirmed = ((): { ok: true; observed: ObservedExit } | { ok: false; why: string } => {
    if (exitRead.ok) return { ok: true, observed: observedOf(child) }
    // A REJECTED EXIT PROMISE IS NOT CONFIRMATION. It is only overridden by an
    // INDEPENDENT source: a real exit code or a real signal recorded on the
    // handle by whatever did reap the process.
    const observed = observedOf(child)
    if (observed.exitCode === null && observed.signal === null) {
      return {
        ok: false,
        why:
          `${exitRead.why}, and neither an exit code nor a terminating signal was recorded for process ` +
          `${child.pid}, so nothing confirms it ended`,
      }
    }
    return { ok: true, observed }
  })()

  if (unseen.length > 0) {
    const ended = exitConfirmed.ok ? `process ${child.pid} was accounted for, but ` : `${exitConfirmed.why}, and `
    return {
      kind: "unresolved",
      why:
        `${ended}the end of its ${unseen.join(" and ")} was never observed — an unread pipe is not a ` +
        `closed one, so nothing here rules out a descendant still holding it`,
    }
  }
  if (!exitConfirmed.ok) return { kind: "unresolved", why: exitConfirmed.why }
  return { kind: "confirmed", observed: exitConfirmed.observed }
}

/**
 * The observed exit or signal, in words, or `""` when neither was seen.
 *
 * WORDED SO IT CANNOT BE READ AS AN EXECUTION. The number is real and is
 * preserved — a reader comparing two timed-out blames wants it — but it is
 * introduced as what the OS reported about a process MAD killed, not as what git
 * returned, because a racing late exit of zero is still a blame that produced
 * nothing MAD waited for.
 */
function describeObserved(observed: ObservedExit): string {
  const parts: string[] = []
  if (observed.signal !== null) parts.push(`signal ${observed.signal}`)
  if (observed.exitCode !== null) parts.push(`status ${observed.exitCode}`)
  return parts.length === 0
    ? ""
    : ` (the OS reported ${parts.join(" and ")} for the killed process, which is not evidence that git ran)`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
