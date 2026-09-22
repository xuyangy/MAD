/**
 * Story 2-7c — the host/runtime probe behind the blame launcher.
 *
 * ## What it is for
 *
 * `adapters/opencode/blame-exec.ts` replaces the host shell for `git blame`,
 * which is only safe to reason about if the facts it rests on are MEASURED on
 * the machine the evaluation runs on rather than remembered. This script is
 * that measurement, in two stages:
 *
 * - **Stage 1 — the baseline.** What the CURRENT host shell does: which git it
 *   resolves, what working directory and argv it passes, what a success looks
 *   like and what a launch failure looks like. Written before the launcher
 *   existed, so it could not be shaped by it.
 * - **Stage 2 — the comparison.** The same cases through the launcher, reported
 *   beside the baseline, with every difference stated rather than smoothed over.
 *
 * ## THREE KINDS OF EVIDENCE, AND THEY ARE NOT INTERCHANGEABLE
 *
 * Every row below is labelled with which of these it is, because collapsing them
 * is how a reader ends up believing something was measured that was not.
 *
 * 1. **TAGGED SOURCE.** opencode's own `packages/opencode/src/plugin/index.ts`
 *    assigns `$: typeof Bun === "undefined" ? undefined : Bun.$` in v1.18.18 and
 *    v1.18.31 — directly, no broker, no permission wrapper. That is a fact about
 *    a published release, read by a human.
 * 2. **BINARY BUILD MARKER.** The Bun version inside the installed opencode is
 *    INFERRED from version strings left in the compiled file. It is not a
 *    statement the host made about itself, and it does not establish that the
 *    installed binary matches its tag.
 * 3. **MEASURED RUNTIME CASES.** Everything under stage 1 and stage 2 — commands
 *    really run on this machine, right now.
 *
 * WHAT THIS SCRIPT IS NOT. It starts no opencode session and loads no plugin, so
 * its stage-1 rows are **Bun's `$` in THIS process**, not the `$` an injected
 * host plugin receives. Those two are the same object only because of (1), which
 * is source evidence — so the comparison here is "Bun's shell against a direct
 * spawn", and it is only a statement about the host plugin's shell to the extent
 * that the tagged source holds for the installed binary. Reported that way, and
 * never as an empirical probe of the injected host.
 *
 * ## What it never does
 *
 * IT MAKES NO MODEL REQUEST, sends no prompt, bills nothing and starts no
 * opencode session. It does not verify host request accounting and it does not
 * verify the experiment's shared gates — those are prerequisites (1) and (3) of
 * the sixteen live runs, split into a story of their own, and they need a live
 * host this script deliberately does not have.
 *
 * IT INSTALLS NOTHING. The repository it probes is one temporary directory it
 * creates and removes, and git is run with `GIT_CONFIG_GLOBAL` and
 * `GIT_CONFIG_SYSTEM` pointed at `/dev/null`, so the user's own git and opencode
 * configuration is neither read nor written.
 *
 * IT PRINTS NO ENVIRONMENT VALUE. The two environments are compared IN MEMORY
 * and only KEY NAMES and equality flags come out, because an environment carries
 * credentials and this output is meant to be pasted into a ledger entry.
 *
 * ## What the tagged source already settles, so the probe does not
 *
 * opencode's own `packages/opencode/src/plugin/index.ts` assigns
 * `$: typeof Bun === "undefined" ? undefined : Bun.$` in both v1.18.18 and
 * v1.18.31 — directly, with no broker and no permission wrapper. So the question
 * "is the injected `$` something other than Bun's" is answered from source, and
 * what is left to measure is the runtime and configuration: which binaries
 * resolve, what the two launch paths do, and whether they agree on the cases
 * that matter.
 *
 * Run: `bun run scripts/probe-host-shell.ts`
 */

import { $ } from "bun"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runBoundedBlame } from "../adapters/opencode/blame-exec.ts"

/** Every child this script starts is bounded, including the ones establishing the baseline. */
const CHILD_DEADLINE_MS = 20_000
const CHILD_CLEANUP_MS = 5_000
/** The whole probe, so a hung host cannot leave it running. */
const PROBE_DEADLINE_MS = 120_000

/** A name that cannot exist on any machine, used for the launch-failure case. */
const MISSING_BINARY = "mad-no-such-binary-2-7c"

type Fact = { name: string; value: string }

/** Temporary directories this probe created, removed on every exit path. */
const scratchDirs: string[] = []

const facts: Fact[] = []
function record(name: string, value: string): void {
  facts.push({ name, value })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The four version facts, kept APART rather than collapsed into "the pinned
 * runtime".
 *
 * They can legitimately differ, and a single number would hide exactly the
 * disagreement worth knowing about: the test suite runs on the Bun on `PATH`,
 * while a plugin runs inside the Bun compiled into the opencode binary, and the
 * package this repository builds against is pinned independently of the opencode
 * actually installed.
 */
/**
 * The version facts.
 *
 * NOT STAGE 1, and the label matters. These helpers run `opencode --version` and
 * `which opencode` THROUGH THE LAUNCHER, so they cannot serve as a baseline
 * established independently of it. They are reported on their own, as versions,
 * and the stage-1 rows below — which use the host shell — are the only ones that
 * claim to be launcher-independent.
 */
async function versions(): Promise<void> {
  const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json()
  record("versions — package @opencode-ai/plugin (pinned in package.json)", pkg.dependencies["@opencode-ai/plugin"])

  const hostVersion = await capture(["opencode", "--version"])
  record(
    "versions — host opencode --version (measured; run through the LAUNCHER, not the shell)",
    hostVersion.kind === "returned" ? hostVersion.stdout.trim() : `NOT ESTABLISHED: ${describe(hostVersion)}`,
  )

  record("versions — test Bun (this process, and the one `bun test` uses)", Bun.version)

  // THE EMBEDDED BUN IS READ AS A MARKER, AND IS LABELLED AS ONE. opencode ships
  // as a single compiled binary, and the only way to ask it which Bun is inside
  // without starting a session is to look for the version strings the build
  // leaves behind. That is evidence about the file, not a statement the host
  // made about itself, so it is reported with its provenance attached.
  record("versions — embedded Bun (INFERRED from build markers, not a statement by the host)", await embeddedBun())
}

async function embeddedBun(): Promise<string> {
  const which = await capture(["which", "opencode"])
  if (which.kind !== "returned" || which.stdout.trim().length === 0) {
    return "NOT ESTABLISHED: opencode is not on PATH"
  }
  const binary = which.stdout.trim()
  try {
    const bytes = await Bun.file(binary).bytes()
    // Byte-for-byte rather than UTF-8: this is a binary, and a lossy decode
    // would corrupt the very strings being searched for.
    //
    // SCANNED CHUNK BY CHUNK, AND NEVER ACCUMULATED. The file is on the order of
    // a hundred megabytes, so building one string of it is a large allocation in
    // a script whose whole point is to be cheap. Chunks OVERLAP by the longest
    // marker a match can span, so one that straddles a boundary is still found.
    const marker = /(?:bun-v|Bun\/)(\d+\.\d+\.\d+)/g
    const OVERLAP = 64
    const found = new Set<string>()
    for (let at = 0; at < bytes.length; at += 65_536) {
      const end = Math.min(at + 65_536 + OVERLAP, bytes.length)
      const chunk = bytes.subarray(at, end)
      let text = ""
      // Built one code unit at a time rather than by spreading the chunk: a
      // spread of 65,536 arguments sits against the engine's argument limit.
      for (const byte of chunk) text += String.fromCharCode(byte)
      marker.lastIndex = 0
      for (const match of text.matchAll(marker)) found.add(match[1]!)
    }
    if (found.size === 0) return `NOT ESTABLISHED: no Bun version marker in ${binary}`
    return `${[...found].sort().join(", ")} (read from ${binary}; a build marker, not a statement by the host)`
  } catch (error) {
    return `NOT ESTABLISHED: ${binary} could not be read (${messageOf(error)})`
  }
}

/** Run a command through the LAUNCHER, bounded. Used for the probe's own helpers too. */
async function capture(argv: string[], cwd = process.cwd()) {
  return await runBoundedBlame({
    argv,
    cwd,
    deadlineMs: CHILD_DEADLINE_MS,
    cleanupMs: CHILD_CLEANUP_MS,
  })
}

function describe(outcome: Awaited<ReturnType<typeof capture>>): string {
  switch (outcome.kind) {
    case "returned":
      return `exit ${outcome.exitCode}${outcome.signal === null ? "" : ` signal ${outcome.signal}`}`
    case "launch-failed":
      return `launch-failed: ${outcome.why}`
    case "terminated":
      return `terminated: ${outcome.why}`
    case "refused":
      return `refused before any launch (MAD's own wiring, not the host): ${outcome.why}`
    case "observation-failed":
      return `observation-failed: ${outcome.why}`
    case "cleanup-unresolved":
      return `cleanup-unresolved: ${outcome.why}`
    default:
      // EXHAUSTIVE, AND CHECKED AT COMPILE TIME. This report is read as a
      // readiness ledger, so an outcome that fell through to a `default` would be
      // filed under whichever label that branch happened to carry — which is how
      // a failed read came to be printed as a cleanup failure. A new variant now
      // fails the build here instead.
      return `unknown outcome: ${JSON.stringify(outcome satisfies never)}`
  }
}

/**
 * The environment the two paths pass to a child, compared IN MEMORY.
 *
 * Only key names and counts come out. A key whose VALUE differs is reported by
 * name with an equality flag and never with either value, because a shell
 * legitimately injects secrets and this output is written down.
 */
async function environments(worktree: string): Promise<void> {
  // `env` PRINTS ONE LINE PER VARIABLE UNTIL A VALUE CONTAINS A NEWLINE, and
  // several on this machine do. A line that does not open with a well-formed
  // name is therefore a CONTINUATION of the value above it, not a variable —
  // appended rather than counted, so a multi-line value does not show up as a
  // handful of invented keys with punctuation in their names.
  const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
  const readEnv = (text: string): Map<string, string> => {
    const map = new Map<string, string>()
    let current: string | null = null
    for (const line of text.split("\n")) {
      const at = line.indexOf("=")
      const name = at > 0 ? line.slice(0, at) : ""
      if (at > 0 && NAME.test(name)) {
        current = name
        map.set(name, line.slice(at + 1))
      } else if (current !== null) {
        map.set(current, `${map.get(current)!}\n${line}`)
      }
    }
    return map
  }

  // `env` with no arguments prints the child's whole environment. Both paths run
  // the SAME program, so any difference is the launcher's or the shell's.
  //
  // THE REFERENCE IS `process.env`, NOT THE SHELL. `$.env({...})` mutates the
  // shared shell object for every later caller exactly as `$.cwd()` does, and
  // this script has already used it to build an isolated git configuration — so
  // a shell-versus-launcher diff would be measuring this script's own earlier
  // call. The launcher is compared against the process environment it is meant
  // to pass through, and the shell's extra keys are reported separately as the
  // observation about `$` that they are.
  const viaShell = await $.cwd(worktree)`env`.nothrow().quiet()
  const viaLauncher = await capture(["env"], worktree)
  if (viaLauncher.kind !== "returned") {
    record("environment comparison", `NOT ESTABLISHED: ${describe(viaLauncher)}`)
    return
  }

  const shellEnv = readEnv(viaShell.stdout.toString())
  const launcherEnv = readEnv(viaLauncher.stdout)
  const parentEnv = new Map(Object.entries(process.env).filter(([, value]) => value !== undefined) as [string, string][])

  const diff = (left: Map<string, string>, right: Map<string, string>) => ({
    onlyLeft: [...left.keys()].filter((key) => !right.has(key)).sort(),
    onlyRight: [...right.keys()].filter((key) => !left.has(key)).sort(),
    differing: [...left.keys()].filter((key) => right.has(key) && right.get(key) !== left.get(key)).sort(),
  })
  const show = (keys: string[]): string => (keys.length === 0 ? "(none)" : keys.join(", "))

  const againstParent = diff(parentEnv, launcherEnv)
  record("environment: keys in this process", String(parentEnv.size))
  record("environment: keys the launcher passes on", String(launcherEnv.size))
  record("environment: keys the launcher DROPS (names only)", show(againstParent.onlyLeft))
  record("environment: keys the launcher ADDS (names only)", show(againstParent.onlyRight))
  record("environment: keys the launcher CHANGES (names only)", show(againstParent.differing))
  record(
    "environment: why a key would legitimately change",
    `\`PWD\` is set to the launched command's working directory on purpose — \`posix_spawn\` changes ` +
      `the directory without it, so the child would otherwise be told it is somewhere it is not. ` +
      `\`npm_command\` is set per invocation by whatever ran this script and is not the launcher's.`,
  )

  const againstShell = diff(shellEnv, launcherEnv)
  record("environment: keys via the host shell", String(shellEnv.size))
  record(
    "environment: keys only the shell passes (names only)",
    `${show(againstShell.onlyLeft)} — these are this script's own \`$.env({...})\` call leaking into ` +
      `the shared shell object, which is the same retention hazard \`$.cwd()\` has`,
  )
  record("environment: keys only the launcher passes (names only)", show(againstShell.onlyRight))
  record("environment: shell/launcher keys with DIFFERENT values (names only)", show(againstShell.differing))
}

async function main(): Promise<void> {
  const worktree = await mkdtemp(join(tmpdir(), "mad-probe-host-shell-"))
  // Registered for the outer cleanup too: a timed-out `main` never reaches its
  // own `finally`, and a probe that leaves temporary repositories behind on the
  // one path that already went wrong is a probe nobody runs twice.
  scratchDirs.push(worktree)
  try {
    // An isolated repository and an isolated git configuration. Nothing here is
    // installed into the user's own config, and nothing reads it.
    const git = $.cwd(worktree).env({
      ...process.env,
      GIT_AUTHOR_NAME: "Probe",
      GIT_AUTHOR_EMAIL: "probe@example.invalid",
      GIT_COMMITTER_NAME: "Probe",
      GIT_COMMITTER_EMAIL: "probe@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    })
    await git`git init -q -b main`.quiet()
    await writeFile(join(worktree, "pay.ts"), "const fee = 1\nconst rate = 2\n")
    await git`git add pay.ts`.quiet()
    await git`git commit -q -m ${"the rate check"}`.quiet()

    await versions()

    // ---- Stage 1: the host shell's own behaviour --------------------------
    const whichShell = await $.cwd(worktree)`sh -c ${"command -v git"}`.nothrow().quiet()
    record("stage 1 — git the host shell resolves", whichShell.stdout.toString().trim() || "(not resolved)")
    const versionShell = await $.cwd(worktree)`git --version`.nothrow().quiet()
    record("stage 1 — git version via the host shell", versionShell.stdout.toString().trim())

    // `pwd -P` THROUGH `sh`, not the shell's own builtin. Bun's `$` implements
    // `pwd` itself and answers with the LOGICAL path, while an external program
    // sees the physical one — on a machine where the temporary directory is
    // reached through a symlink those are two spellings of one directory, and
    // comparing them would report a difference that is not one.
    const cwdShell = await $.cwd(worktree)`sh -c ${"pwd -P"}`.nothrow().quiet()
    record("stage 1 — cwd the host shell passes", cwdShell.stdout.toString().trim())

    // ARGV BEHAVIOUR: one hostile element with a space, a quote and shell syntax
    // in it must arrive as ONE argument, unchanged.
    const hostile = "a b'c;$(pwd)"
    const argvShell = await $.cwd(worktree)`printf ${["%s\n", hostile]}`.nothrow().quiet()
    record("stage 1 — one hostile argv element survives the host shell", JSON.stringify(argvShell.stdout.toString()))

    const okShell = await $.cwd(worktree)`git ${["blame", "-L", "1,2", "--porcelain", "--", "pay.ts"]}`.nothrow().quiet()
    record("stage 1 — a successful blame via the host shell", `exit ${okShell.exitCode}, ${okShell.stdout.toString().length} bytes of stdout`)

    const missShell = await $.cwd(worktree)`${[MISSING_BINARY]}`.nothrow().quiet()
    record(
      "stage 1 — a LAUNCH FAILURE via the host shell",
      `exit ${missShell.exitCode}, stderr ${JSON.stringify(missShell.stderr.toString().trim())}`,
    )

    const badPathShell = await $.cwd(worktree)`git ${["blame", "-L", "1,2", "--porcelain", "--", "no-such.ts"]}`.nothrow().quiet()
    record("stage 1 — a real git FAILURE via the host shell", `exit ${badPathShell.exitCode}`)

    // ---- Stage 2: the same cases through the launcher ---------------------
    const whichLauncher = await capture(["sh", "-c", "command -v git"], worktree)
    record(
      "stage 2 — git the launcher resolves",
      whichLauncher.kind === "returned" ? whichLauncher.stdout.trim() || "(not resolved)" : describe(whichLauncher),
    )
    const versionLauncher = await capture(["git", "--version"], worktree)
    record(
      "stage 2 — git version via the launcher",
      versionLauncher.kind === "returned" ? versionLauncher.stdout.trim() : describe(versionLauncher),
    )

    const cwdLauncher = await capture(["sh", "-c", "pwd -P"], worktree)
    record("stage 2 — cwd the launcher passes", cwdLauncher.kind === "returned" ? cwdLauncher.stdout.trim() : describe(cwdLauncher))

    const argvLauncher = await capture(["printf", "%s\n", hostile], worktree)
    record(
      "stage 2 — one hostile argv element survives the launcher",
      argvLauncher.kind === "returned" ? JSON.stringify(argvLauncher.stdout) : describe(argvLauncher),
    )

    const okLauncher = await capture(["git", "blame", "-L", "1,2", "--porcelain", "--", "pay.ts"], worktree)
    record(
      "stage 2 — a successful blame via the launcher",
      okLauncher.kind === "returned" ? `exit ${okLauncher.exitCode}, ${okLauncher.stdout.length} bytes of stdout` : describe(okLauncher),
    )

    const missLauncher = await capture([MISSING_BINARY], worktree)
    record("stage 2 — a LAUNCH FAILURE via the launcher", describe(missLauncher))

    const badCwd = await capture(["git", "--version"], join(worktree, "no-such-directory"))
    record("stage 2 — a working directory that does not exist", describe(badCwd))

    const badPathLauncher = await capture(["git", "blame", "-L", "1,2", "--porcelain", "--", "no-such.ts"], worktree)
    record(
      "stage 2 — a real git FAILURE via the launcher",
      badPathLauncher.kind === "returned" ? `exit ${badPathLauncher.exitCode}` : describe(badPathLauncher),
    )

    // A CHILD THAT WILL NOT RETURN, so the deadline and the cleanup budget are
    // measured rather than assumed. Tiny deadlines: the point is the path, not
    // the wall clock.
    const hang = await runBoundedBlame({
      argv: ["sleep", "60"],
      cwd: worktree,
      deadlineMs: 200,
      cleanupMs: 2_000,
    })
    record("stage 2 — a child that does not return", describe(hang))

    // AND A CHILD THAT HOLDS THE PIPE OPEN PAST ITS OWN EXIT. This is the case
    // that makes awaiting the pipes before the exit unbounded, so it is measured
    // rather than argued about.
    const pipeHolder = await runBoundedBlame({
      argv: ["sh", "-c", "sleep 60 & echo started; wait"],
      cwd: worktree,
      deadlineMs: 300,
      cleanupMs: 2_000,
    })
    record("stage 2 — a child whose descendant holds the pipe", describe(pipeHolder))

    await environments(worktree)

    // ---- The comparison, stated ------------------------------------------
    const agree =
      whichShell.stdout.toString().trim() === (whichLauncher.kind === "returned" ? whichLauncher.stdout.trim() : "\u0000") &&
      versionShell.stdout.toString().trim() === (versionLauncher.kind === "returned" ? versionLauncher.stdout.trim() : "\u0000") &&
      cwdShell.stdout.toString().trim() === (cwdLauncher.kind === "returned" ? cwdLauncher.stdout.trim() : "\u0000") &&
      argvShell.stdout.toString() === (argvLauncher.kind === "returned" ? argvLauncher.stdout : "\u0000") &&
      okShell.exitCode === (okLauncher.kind === "returned" ? okLauncher.exitCode : -1) &&
      badPathShell.exitCode === (badPathLauncher.kind === "returned" ? badPathLauncher.exitCode : -1)
    record(
      "COMPARISON — resolved git, version, cwd, argv, success and git-failure exit",
      agree ? "the two paths AGREE on every case above" : "THE TWO PATHS DISAGREE — read the rows above",
    )
    record(
      "COMPARISON — the launch-failure case",
      `the paths differ BY DESIGN: the shell resolves it to exit ${missShell.exitCode} with its own ` +
        `stderr line, which had to be recognised by matching that text; the launcher is refused by the ` +
        `operating system and reports it directly, so no untrusted output decides it any more`,
    )
    record(
      "COMPARISON — standard input",
      `the launcher does not inherit stdin (it is /dev/null), so a git that decides to prompt fails ` +
        `fast instead of blocking. This is a deliberate difference from the shell path.`,
    )
    record(
      "SCOPE — what was measured",
      `Bun's \`$\` in THIS process against a direct spawn, on this host, this runtime and this ` +
        `configuration, for the cases above. Not a claim of universal equivalence.`,
    )
    record(
      "SCOPE — what was NOT measured",
      `no opencode session was started and no plugin was loaded, so the \`$\` an INJECTED HOST PLUGIN ` +
        `receives was never exercised here. That it is the same object rests on opencode's tagged ` +
        `source (v1.18.18 and v1.18.31 assign \`$\` directly from \`Bun.$\`), which is source evidence ` +
        `and does not establish that the installed binary matches its tag. Host request accounting and ` +
        `the experiment's shared gates are untouched.`,
    )

    const width = Math.max(...facts.map((fact) => fact.name.length))
    console.log(`MAD host/runtime probe — story 2-7c\n${"=".repeat(width + 4)}`)
    for (const fact of facts) console.log(`${fact.name.padEnd(width)}  ${fact.value}`)
  } finally {
    await rm(worktree, { recursive: true, force: true })
  }
}

/**
 * THE PROBE FAILS LOUDLY AND EXITS NON-ZERO.
 *
 * It exists to establish facts that get written into a readiness document, so a
 * run that half-finished and exited 0 is worse than one that did not run: the
 * rows it did print would be quoted as a complete measurement. A crash, a
 * timeout and a cleanup failure are all reported by name, and every one of them
 * sets a non-zero status.
 *
 * The temporary worktree is removed on EVERY path, including the timeout — which
 * `main`'s own `finally` cannot cover, because a timed-out `main` is still
 * running when this decides.
 */
const bounded = await Promise.race([
  main().then(
    () => "done" as const,
    (error: unknown) => ({ failed: messageOf(error) }),
  ),
  new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), PROBE_DEADLINE_MS).unref()),
])

let cleanupFailed: string | null = null
for (const dir of scratchDirs) {
  try {
    await rm(dir, { recursive: true, force: true })
  } catch (error) {
    cleanupFailed = `the probe's temporary directory could not be removed: ${messageOf(error)}`
  }
}

if (bounded === "timed-out") {
  console.error(
    `the probe did not finish within ${PROBE_DEADLINE_MS}ms. NOTHING ABOVE IS A COMPLETE MEASUREMENT ` +
      `and none of it may be quoted as one.`,
  )
  process.exitCode = 1
} else if (bounded !== "done") {
  console.error(`the probe failed: ${bounded.failed}. Nothing above is a complete measurement.`)
  process.exitCode = 1
}
if (cleanupFailed !== null) {
  console.error(cleanupFailed)
  process.exitCode = 1
}
