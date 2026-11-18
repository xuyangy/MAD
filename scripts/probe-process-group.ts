#!/usr/bin/env bun
/**
 * Plan item B3 (fusion-harness borrow plan) — the gate before the git launcher
 * signals a process group.
 *
 * `adapters/opencode/blame-exec.ts` starts git with an ordinary `Bun.spawn`, in
 * MAD's own process group, and its kill reaches the direct child alone. B3
 * would start git as the leader of a new group and kill the group instead. This
 * probe measures, on the Bun and the operating system running it, the separate
 * facts that change would rest on. Each case reports what it saw, a contrary
 * observation included; none of them decides whether the change is safe.
 *
 * 1. `leader`: a child spawned with `detached: true` leads a new group, and a
 *    grandchild joins it.
 * 2. `groupKill`: SIGKILL to that group ends a grandchild that holds the
 *    child's stdout, and the pipe ends.
 * 3. `leaderExited`: when the leader exits while a grandchild keeps the pipe
 *    open, Bun reports the exit, the grandchild keeps the group's id, and the
 *    pipe stays open. Nothing is signalled.
 * 4. `reapDuringSyncCode`: whether a child that has exited stays a zombie, with
 *    `exitCode` still `null`, while JavaScript runs synchronously, and is reaped
 *    after an event-loop turn. Nothing is signalled.
 * 5. `setsidEscape`: a grandchild that calls `setsid` leaves the group and
 *    survives a group kill.
 * 6. `directKill`: today's launcher. A child spawned without `detached` shares
 *    this process's group, and killing it leaves a grandchild running.
 *
 * ## Signals reach only processes the probe still owns
 *
 * The probe never signals a pid or a group id it saved earlier. A group is
 * killed from inside, by its leader: a `perl` process (the fixture shell
 * `exec`s it) that reads commands on control channel 3. On `kill` it checks,
 * in the same process and immediately before signalling, that its own group id
 * is its own pid, and only then sends SIGKILL to that group; if the check
 * fails it exits with status 3 and signals nothing, so a spawn that did not
 * create a new group cannot reach MAD's group. On `check` it reports that guard
 * through its exit status (0 owns its group, 3 does not) and signals nothing.
 * End of file on channel 3 is ordinary cleanup: the leader exits and signals
 * nothing. A helper grandchild is a `perl` process that holds stdout, exits
 * when control channel 4 reaches end of file, and exits by `alarm` after
 * `HELPER_SECONDS` regardless; the leader has the same `alarm`. Bun's own
 * `child.kill` is used only in `directKill`, on a leader still blocked reading
 * channel 3, so it has not exited. Cleanup closes the control channels; it
 * sends no signal.
 *
 * ## Process state
 *
 * A process is `running`, `zombie` (exited, not yet reaped), `absent` (no such
 * pid), or `unknown` (the `ps` read failed or timed out). Signal 0 is not used:
 * it reports a zombie as present.
 *
 * Every wait is bounded, `ps` reads included. It starts no git, no opencode and
 * no model. Without `perl` every helper case reports `measured: false`.
 *
 * Run: `bun run scripts/probe-process-group.ts` prints one JSON object.
 */

import { closeSync, writeSync } from "node:fs"

type Child = ReturnType<typeof Bun.spawn>

/** How long a helper lives if nothing ends it. */
const HELPER_SECONDS = 15
/** The longest any single wait in this probe may take. */
const WAIT_MS = 3_000
/** The longest one `ps` read may take. */
const PS_MS = 2_000

export type ProcessState = "running" | "zombie" | "absent" | "unknown"

export type PsRead = { ok: true; value: string } | { ok: false; absent: boolean }

/**
 * One `ps` result, classified. `ps` exits 1 with no output for a pid that does
 * not exist; any other nonzero exit, with or without output, and a timeout are
 * failed reads, never values.
 */
export function classifyPs(result: { stdout: string; exitCode: number | null; timedOut: boolean }): PsRead {
  const value = result.stdout.trim()
  if (result.timedOut || result.exitCode === null) return { ok: false, absent: false }
  if (result.exitCode !== 0) return { ok: false, absent: result.exitCode === 1 && value === "" }
  if (value === "") return { ok: false, absent: false }
  return { ok: true, value }
}

/** Whether a helper left the leader's group; `null` unless its group id was read as a number. */
export function leftGroupOf(helperPgid: number | "absent" | "unknown", leaderPid: number): boolean | null {
  return typeof helperPgid === "number" ? helperPgid !== leaderPid : null
}

function ps(field: "pgid" | "stat", pid: number): PsRead {
  const result = Bun.spawnSync({
    cmd: ["ps", "-o", `${field}=`, "-p", String(pid)],
    stdout: "pipe",
    stderr: "ignore",
    timeout: PS_MS,
  } as never) as unknown as { stdout: Uint8Array; exitCode: number | null; exitedDueToTimeout?: boolean }
  return classifyPs({
    stdout: new TextDecoder().decode(result.stdout),
    exitCode: result.exitCode,
    timedOut: result.exitedDueToTimeout === true,
  })
}

export function stateOf(pid: number): ProcessState {
  const read = ps("stat", pid)
  if (!read.ok) return read.absent ? "absent" : "unknown"
  return read.value.startsWith("Z") ? "zombie" : "running"
}

export function pgidOf(pid: number): number | "absent" | "unknown" {
  const read = ps("pgid", pid)
  if (!read.ok) return read.absent ? "absent" : "unknown"
  const value = Number(read.value)
  return Number.isInteger(value) && value > 0 ? value : "unknown"
}

async function until(test: () => boolean, ms = WAIT_MS): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (test()) return true
    await Bun.sleep(20)
  }
  return test()
}

/** Resolves with the promise's value, or with `fallback` once `ms` has passed. */
function bounded<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, Bun.sleep(ms).then(() => fallback)])
}

/** The child's stdout: a handshake line, then whether the stream ends within a bound. */
function lineReader(child: Child) {
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buffered = ""
  let ended = false
  const readLine = async (): Promise<string | null> => {
    while (!buffered.includes("\n")) {
      const { value, done } = await reader.read()
      if (done) {
        ended = true
        return null
      }
      buffered += decoder.decode(value)
    }
    const line = buffered.slice(0, buffered.indexOf("\n")).trim()
    buffered = buffered.slice(buffered.indexOf("\n") + 1)
    return line
  }
  /** The helper prints its pid before anything is measured. */
  const handshake = async (): Promise<number | null> => {
    const pid = Number(await bounded(readLine(), WAIT_MS, null))
    return Number.isInteger(pid) && pid > 0 ? pid : null
  }
  const endsWithin = async (ms: number): Promise<boolean> => {
    if (ended) return true
    const drain = (async () => {
      for (;;) {
        const { done } = await reader.read()
        if (done) return true
      }
    })()
    const result = await bounded(drain, ms, false)
    if (result) ended = true
    return result
  }
  const release = () => {
    reader.cancel().catch(() => undefined)
  }
  return { handshake, endsWithin, release }
}

/**
 * A helper grandchild: prints its pid, holds stdout, and exits at end of file
 * on channel 4 or after `HELPER_SECONDS`. With `setsid`, it first leaves the
 * group in a new session.
 */
function helper(setsid: boolean): string {
  const body =
    `${setsid ? "POSIX::setsid(); " : ""}alarm ${HELPER_SECONDS}; $| = 1; print "$$\\n"; ` +
    `open(my $c, "<&=4") or exit 1; my $l = <$c>; exit 0`
  return `perl -MPOSIX -e '${body}'`
}

/**
 * The leader, `exec`ed by the fixture shell so it keeps the shell's pid: reads
 * commands on channel 3. `check` exits 0 when it leads its own group and 3 when
 * it does not. `kill` sends SIGKILL to its own group only after that same check
 * passes, and otherwise exits 3. End of file exits 0. Nothing is signalled
 * except by a passing `kill`.
 */
const LEADER =
  `exec perl -e 'alarm ${HELPER_SECONDS}; open(my $c, "<&=3") or exit 1; ` +
  `while (my $l = <$c>) { chomp $l; my $own = (getpgrp() == $$); ` +
  `if ($l eq "check") { exit($own ? 0 : 3) } ` +
  `if ($l eq "kill") { exit 3 unless $own; kill("KILL", -$$); exit 4 } } exit 0'`

interface Fixture {
  child: Child
  out: ReturnType<typeof lineReader>
  /** Sends the leader a command on channel 3. */
  command(line: "check" | "kill"): void
  /** Ends both control channels: the leader and the helpers exit; nothing is signalled. */
  close(): void
}

function fixture(script: string, detached: boolean): Fixture {
  const child = Bun.spawn({
    cmd: ["/bin/sh", "-c", script],
    stdio: ["ignore", "pipe", "ignore", "pipe", "pipe"],
    detached,
  } as never) as Child & { stdio: (number | undefined)[] }
  const leaderControl = child.stdio[3] as number
  const helperControl = child.stdio[4] as number
  let closed = false
  const out = lineReader(child)
  return {
    child,
    out,
    command(line) {
      try {
        writeSync(leaderControl, `${line}\n`)
      } catch {
        // The leader is gone; its channel is closed below.
      }
    },
    close() {
      if (closed) return
      closed = true
      for (const fd of [leaderControl, helperControl]) {
        try {
          closeSync(fd)
        } catch {
          // Already closed.
        }
      }
      out.release()
    },
  }
}

async function withFixture<T>(script: string, detached: boolean, body: (f: Fixture) => Promise<T>): Promise<T> {
  const f = fixture(script, detached)
  try {
    return await body(f)
  } finally {
    f.close()
  }
}

const NO_PERL = { measured: false as const, why: "perl is not available" }
const NO_HANDSHAKE = { measured: false as const, why: "the helper printed no pid" }

export async function leader() {
  if (Bun.which("perl") === null) return NO_PERL
  return withFixture(`${helper(false)} & ${LEADER}`, true, async (f) => {
    const grandchild = await f.out.handshake()
    if (grandchild === null) return NO_HANDSHAKE
    return {
      measured: true as const,
      leaderLeadsGroup: pgidOf(f.child.pid) === f.child.pid,
      parentInOtherGroup: pgidOf(process.pid) !== f.child.pid,
      grandchildInGroup: pgidOf(grandchild) === f.child.pid,
    }
  })
}

export async function groupKill() {
  if (Bun.which("perl") === null) return NO_PERL
  return withFixture(`${helper(false)} & ${LEADER}`, true, async (f) => {
    const grandchild = await f.out.handshake()
    if (grandchild === null) return NO_HANDSHAKE
    f.command("kill")
    await bounded(f.child.exited, WAIT_MS, undefined)
    await until(() => stateOf(grandchild) !== "running")
    return {
      measured: true as const,
      leaderSignal: f.child.signalCode,
      grandchildState: stateOf(grandchild),
      pipeEnded: await f.out.endsWithin(WAIT_MS),
    }
  })
}

export async function leaderExited() {
  if (Bun.which("perl") === null) return NO_PERL
  // The shell exits at once; the helper keeps stdout open until channel 4 closes.
  return withFixture(`${helper(false)} & exit 0`, true, async (f) => {
    const grandchild = await f.out.handshake()
    if (grandchild === null) return NO_HANDSHAKE
    await bounded(f.child.exited, WAIT_MS, undefined)
    await until(() => stateOf(f.child.pid) === "absent")
    return {
      measured: true as const,
      leaderExitReported: f.child.exitCode !== null || f.child.signalCode !== null,
      leaderState: stateOf(f.child.pid),
      grandchildState: stateOf(grandchild),
      grandchildKeepsGroupId: pgidOf(grandchild) === f.child.pid,
      pipeEndedWhileHeld: await f.out.endsWithin(300),
    }
  })
}

export async function reapDuringSyncCode() {
  const child = Bun.spawn({ cmd: ["/bin/sh", "-c", "exit 0"], stdio: ["ignore", "ignore", "ignore"], detached: true } as never)
  // Synchronous from here until the `await` below: wait (bounded) for the
  // child to have exited, and sample Bun's view while it is a zombie.
  const end = Date.now() + WAIT_MS
  let stateSeen: ProcessState = stateOf(child.pid)
  while (stateSeen === "running" && Date.now() < end) stateSeen = stateOf(child.pid)
  const exitCodeAtFirstSample = child.exitCode
  const hold = Date.now() + 200
  while (Date.now() < hold) {
    // Busy wait: no event-loop turn happens here.
  }
  const stateAfterHold = stateOf(child.pid)
  const exitCodeAfterHold = child.exitCode
  await bounded(child.exited, WAIT_MS, undefined)
  await until(() => stateOf(child.pid) === "absent")
  return {
    stateSeen,
    exitCodeAtFirstSample,
    stateAfterHold,
    exitCodeAfterHold,
    stateAfterAwait: stateOf(child.pid),
  }
}

export async function setsidEscape() {
  if (Bun.which("perl") === null) return NO_PERL
  return withFixture(`${helper(true)} & ${LEADER}`, true, async (f) => {
    const escaped = await f.out.handshake()
    if (escaped === null) return NO_HANDSHAKE
    const escapedPgid = pgidOf(escaped)
    const leftGroup = leftGroupOf(escapedPgid, f.child.pid)
    if (leftGroup === null) return { measured: false as const, why: `the helper's group id is ${escapedPgid}` }
    f.command("kill")
    await bounded(f.child.exited, WAIT_MS, undefined)
    return {
      measured: true as const,
      leftGroup,
      leaderSignal: f.child.signalCode,
      escapedState: stateOf(escaped),
      pipeEndedWhileHeld: await f.out.endsWithin(300),
    }
  })
}

export async function directKill() {
  if (Bun.which("perl") === null) return NO_PERL
  // Not detached; the leader blocks on channel 3, so it has not exited when
  // Bun's own `kill` reaches it.
  return withFixture(`${helper(false)} & ${LEADER}`, false, async (f) => {
    const grandchild = await f.out.handshake()
    if (grandchild === null) return NO_HANDSHAKE
    const sharesParentGroup = pgidOf(f.child.pid) === pgidOf(process.pid)
    f.child.kill("SIGKILL")
    await bounded(f.child.exited, WAIT_MS, undefined)
    await Bun.sleep(100)
    return {
      measured: true as const,
      sharesParentGroup,
      leaderSignal: f.child.signalCode,
      grandchildState: stateOf(grandchild),
    }
  })
}

/**
 * The leader's guard, exercised without any signal: a detached leader reports
 * that it owns its group, and one spawned without `detached` (sharing this
 * process's group) reports that it does not. Only `check` is sent.
 */
export async function leaderGuard() {
  if (Bun.which("perl") === null) return NO_PERL
  const statusOf = (detached: boolean) =>
    withFixture(`${helper(false)} & ${LEADER}`, detached, async (f) => {
      if ((await f.out.handshake()) === null) return "no-handshake" as const
      f.command("check")
      await bounded(f.child.exited, WAIT_MS, undefined)
      return f.child.exitCode
    })
  return { measured: true as const, detachedStatus: await statusOf(true), sharedGroupStatus: await statusOf(false) }
}

export async function probeProcessGroup() {
  return {
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    leader: await leader(),
    leaderGuard: await leaderGuard(),
    groupKill: await groupKill(),
    leaderExited: await leaderExited(),
    reapDuringSyncCode: await reapDuringSyncCode(),
    setsidEscape: await setsidEscape(),
    directKill: await directKill(),
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(await probeProcessGroup(), null, 2))
}
