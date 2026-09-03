/**
 * AD-16 amended (story 7A) — the optional, additive run-artifact dump.
 *
 * AD-16 has permitted this since the day it was written ("Serializing it is an
 * adapter-side concern that may be added behind a flag without touching a
 * stage") and nothing had implemented it. This is that flag, and every rule it
 * ships under is a clause of AD-16 rather than a preference:
 *
 * - **OFF BY DEFAULT.** A fresh install writes nothing, stats nothing, and
 *   behaves byte-for-byte as it did before this file existed (AD-3: no
 *   configuration is required to get the real thing).
 * - **NEVER INSIDE THE USER'S REPO**, checked rather than trusted. `Repo` is
 *   read-only *by construction* — the port has no write method — and a dump
 *   directory that happened to resolve inside the worktree would break that
 *   guarantee without touching the port. See `refusalFor` below.
 * - **NEVER READ BACK.** Nothing in this module reads an artifact, and nothing
 *   anywhere takes a previous run as input. A file existing is not cross-run
 *   memory; v1 has neither kind (`deferred-v2.md`).
 * - **NO STAGE LEARNS A FILE EXISTS.** Serialization is entirely here. The core
 *   is handed no path, no flag and no writer.
 * - **NEVER FATAL.** A dump MAD could not write is untidy; a review it destroyed
 *   is a broken tool. Every failure returns a value.
 *
 * ## It is a DEBUG dump, not the durable format
 *
 * `stories.yaml` names this explicitly: "This is the DEBUG dump, not the durable
 * format the spine still defers — do not let it become one." Nothing versions
 * these files, nothing reads them, and their shape may change in any story. If a
 * future story needs a format two runs can be compared through, that is the
 * spine's deferred v2 record and it gets designed rather than inherited from
 * whatever this happened to write.
 *
 * ## Why an environment variable and not a tool argument
 *
 * Every other knob on `mad_review` is a REVIEW decision — how many slots, which
 * lenses, which target — and `plugin.ts` says repeatedly, in comments about
 * clamping, that those values arrive FROM A MODEL CALLING THE TOOL. Whether MAD
 * writes files to the user's disk is not a review decision, and a model should
 * not be able to make it. An environment variable is set by the person whose
 * disk it is.
 */

import { mkdir, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"

import type { RunRecord } from "../../core/domain/run-record.ts"
import type { Envelope, ModelBackend } from "../../core/ports/model-backend.ts"
import type { ChangeSet } from "../../core/ports/repo.ts"

/**
 * The one environment variable this feature has.
 *
 * `1` / `true` / `yes` / `on` write to a directory under the OS temp dir; any
 * other non-empty value is taken as the directory itself. Unset or empty is off,
 * which is the default and the shape a fresh install runs in.
 */
export const ARTIFACTS_ENV = "MAD_ARTIFACTS"

const TRUTHY = new Set(["1", "true", "yes", "on"])

/** Where `MAD_ARTIFACTS=1` writes: a MAD-owned directory under the host's temp dir. */
export function defaultArtifactRoot(): string {
  return join(tmpdir(), "mad-runs")
}

/**
 * What the environment asked for, as a directory or as nothing.
 *
 * Exported so the parsing is TESTED rather than trusted, the pattern every clamp
 * in this codebase follows. It reads a plain record rather than `process.env`
 * directly for the same reason: a function that reaches for a global is a
 * function whose behaviour a test has to arrange globally.
 */
export function artifactRootFrom(env: Record<string, string | undefined>): string | undefined {
  const raw = env[ARTIFACTS_ENV]?.trim()
  if (raw === undefined || raw.length === 0) return undefined
  if (TRUTHY.has(raw.toLowerCase())) return defaultArtifactRoot()
  return raw
}

/**
 * AD-16 — MAD NEVER WRITES INSIDE THE USER'S REPO, and this is where that is
 * enforced rather than assumed.
 *
 * Returns the reason to refuse, or `undefined` to proceed. Three refusals, and
 * each one is a way the guarantee could be lost quietly:
 *
 * 1. **A relative path.** It would resolve against the process's working
 *    directory, which for a plugin is the user's project — so `MAD_ARTIFACTS=out`
 *    would write into the repo while looking like it named somewhere else.
 * 2. **The worktree itself.**
 * 3. **Anything under the worktree**, compared on a separator-terminated prefix
 *    so a sibling directory named `my-repo-backup` is not mistaken for a child of
 *    `my-repo`.
 *
 * The check is on the RESOLVED path, so `..` cannot walk back in.
 */
/**
 * Case-fold on the platforms whose filesystems are case-insensitive by default
 * (code review 2026-08-31).
 *
 * On darwin and win32, `/Users/me/repo/out` and `/users/ME/REPO/out` are the same
 * directory, and a byte comparison called the second one a sibling. That is not a
 * hostile case so much as an ordinary one — a shell-completed path, a copied
 * README line — and AD-16's guarantee is the one guarantee in this codebase that
 * has no acceptable failure rate.
 */
function fold(p: string): string {
  return process.platform === "darwin" || process.platform === "win32" ? p.toLowerCase() : p
}

export function refusalFor(root: string, worktree: string): string | undefined {
  if (!isAbsolute(root)) {
    return (
      `\`${ARTIFACTS_ENV}\` must be an absolute path (or \`1\` for a temp directory). ` +
      `A relative path resolves against the project directory, which is the one place MAD ` +
      `never writes.`
    )
  }
  const target = fold(resolve(root))
  const repo = fold(resolve(worktree))
  if (target === repo || target.startsWith(repo + sep)) {
    return (
      `\`${ARTIFACTS_ENV}\` points inside the repository under review (\`${repo}\`). MAD never ` +
      `writes there — the change under review is read-only by construction (AD-16). Point it at ` +
      `a scratch directory outside the repository, or set it to \`1\` for a temp directory.`
    )
  }
  return undefined
}

/**
 * The symlink-aware half of `refusalFor`, for the one call site that can await.
 *
 * Resolves whichever of the two paths actually exist and re-runs the same
 * containment test on the result. A path that does not resolve is left as-is:
 * `MAD_ARTIFACTS` naming a directory that has yet to be created is the ordinary
 * first run, not an attack, and refusing it would break the feature's default.
 */
async function realRefusalFor(root: string, worktree: string): Promise<string | undefined> {
  const [realRoot, realRepo] = await Promise.all([realOrSelf(resolve(root)), realOrSelf(resolve(worktree))])
  return refusalFor(realRoot, realRepo)
}

/**
 * The real path — resolving through the NEAREST EXISTING ANCESTOR when the path
 * itself does not exist yet.
 *
 * Resolving only the path itself is not enough, and macOS is the proof: `/var` is
 * a symlink to `/private/var`, so a dump root under the temp directory that has
 * not been created yet stays `/var/folders/...` while the worktree beside it
 * resolves to `/private/var/folders/...`. The two then look like unrelated trees
 * and the containment test says "outside the repo" about a directory that is
 * inside it. Walking up to something that exists, resolving THAT, and re-joining
 * the remainder gives both sides the same vocabulary.
 */
async function realOrSelf(p: string): Promise<string> {
  const tail: string[] = []
  let current = p
  for (;;) {
    try {
      return join(await realpath(current), ...tail)
    } catch {
      const parent = dirname(current)
      // The filesystem root exists or nothing does; either way there is no more
      // walking to do and the original path is the honest answer.
      if (parent === current) return p
      tail.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * One turn, as it came back from the backend (AD-16 amended: "each turn's
 * envelope").
 *
 * The envelope's payload lives nowhere else. Stages consume it and keep only
 * what they write onto a `Finding`, and `ledger.entries` records what a turn
 * COST without recording what it SAID — so a malformed answer that failed
 * validation, or an answer a stage dropped, survives only here. That is the
 * single most useful thing in the dump when a run went wrong.
 */
export interface TurnArtifact {
  /** 1-based, in the order the turns were ISSUED. */
  seq: number
  slot: string
  /** The prompt the turn was given, verbatim. */
  input: string
  /** The role instruction set it ran under, verbatim. */
  instructions: string
  envelope: Envelope<unknown>
}

/**
 * A `ModelBackend` that keeps every envelope it hands back.
 *
 * ADAPTER-SIDE AND INVISIBLE TO THE CORE (AD-16: "no stage learns that a file
 * exists"). It is a decorator, so `review()` is handed something that satisfies
 * the port and nothing else; the stages cannot tell, and nothing about the run
 * changes — the wrapper adds no retry, swallows no failure, and forwards the
 * cancellation signal untouched.
 *
 * IT IS ONLY CONSTRUCTED WHEN THE FLAG IS ON. With the flag off the plugin hands
 * `review()` the bare backend, so a fresh install allocates nothing and keeps no
 * transcript in memory.
 */
export interface TurnRecorder {
  readonly turns: TurnArtifact[]
  wrap(inner: ModelBackend): ModelBackend
}

export function createTurnRecorder(): TurnRecorder {
  const turns: TurnArtifact[] = []
  // ITS OWN COUNTER, NOT `turns.length`. Turns are pushed when they RETURN and
  // several are in flight at once, so `turns.length + 1` would hand the same
  // number to every turn of one fan-out — twenty turns numbered 1, and the
  // duplicate filenames would then overwrite each other in the dump.
  let issued = 0
  return {
    turns,
    wrap(inner: ModelBackend): ModelBackend {
      return {
        capabilities: (slot) => inner.capabilities(slot),
        async runTurn(slot, instructions, input, schema, signal) {
          // Taken BEFORE the await, so it is ISSUE order rather than completion
          // order — which is the order a person reading the dump is
          // reconstructing, and the one thing `ledger.entries` deliberately does
          // not preserve (`deferred-work.md`, story 2).
          issued += 1
          const seq = issued
          const envelope = await inner.runTurn(slot, instructions, input, schema, signal)
          turns.push({ seq, slot, input, instructions, envelope })
          return envelope
        },
      }
    },
  }
}

/** What a dump attempt did, so the caller can say so without knowing how it works. */
export type ArtifactOutcome =
  /** No flag set. The default, and the only outcome a fresh install can produce. */
  | { kind: "off" }
  /** The flag was set to somewhere MAD will not write. Nothing happened. */
  | { kind: "refused"; reason: string }
  | { kind: "written"; directory: string; files: number }
  /** The filesystem said no. The review is unaffected. */
  | { kind: "failed"; directory: string; error: string }

export interface DumpInput {
  record: RunRecord
  /** The change under review, as the `Repo` port produced it. */
  change: ChangeSet
  /**
   * The HUMAN-FACING render, unframed.
   *
   * DELIBERATELY NOT `frameForHostAgent(rendered)`. AD-18's eighth span exists
   * because the report reaches the host AGENT through the tool's output, and a
   * span's notice sentence is addressed to a model. The reader of this file is a
   * person opening it in an editor, where that sentence is noise — the same call
   * `output()` itself makes, for the same reason, recorded in `review.ts`.
   *
   * This is the second reader of `ReviewResult.rendered` in the codebase, which
   * `deferred-work.md` flagged as the moment "framed or not" stops being
   * obvious. It is answered here, in a comment on the field, and pinned by a
   * test.
   */
  rendered: string
  /**
   * AD-16 amended — every turn's envelope, from `createTurnRecorder`.
   *
   * Optional, and absent means "nobody was recording", which is what a caller
   * that did not wrap the backend gets. It is not derived from the record,
   * because the record does not hold it: `ledger.entries` is what a turn cost,
   * not what it said.
   */
  turns?: readonly TurnArtifact[]
  worktree: string
  /** Injected so a test needs no environment. Defaults to the real one. */
  env?: Record<string, string | undefined>
}

/**
 * Write one run's artifacts, or explain why not. NEVER THROWS.
 *
 * One directory per run, named by `runId` — which is opaque and sortable (spine,
 * Ids), so a scratch root fills up in run order and two runs cannot collide.
 */
export async function dumpRunArtifacts(input: DumpInput): Promise<ArtifactOutcome> {
  const root = artifactRootFrom(input.env ?? process.env)
  if (root === undefined) return { kind: "off" }

  const refusal = refusalFor(root, input.worktree)
  if (refusal !== undefined) return { kind: "refused", reason: refusal }

  // AND AGAIN ON THE REAL PATHS (code review 2026-08-31). `refusalFor` compares
  // RESOLVED paths, which collapses `..` but follows no symlinks — so a symlink
  // at the configured root pointing into the repository, or a worktree the user
  // gave by a symlinked path, passed the check and MAD wrote inside the one
  // directory AD-16 says it never writes to. `refusalFor` stays synchronous and
  // string-only because it is what the plugin's recorder gate can afford to call;
  // this is the version that touches the disk, and it runs before anything is
  // created. Paths that do not exist yet cannot be a symlink into anywhere, so a
  // failed `realpath` is not a refusal — it is the normal first-run case.
  const realRefusal = await realRefusalFor(root, input.worktree)
  if (realRefusal !== undefined) return { kind: "refused", reason: realRefusal }

  const directory = join(resolve(root), input.record.runId)

  // NEVER THROWS, AND THE TRY STARTS HERE RATHER THAN AT `mkdir` (code review
  // 2026-08-31). It used to start below, which left every `json(...)` call —
  // that is, every `JSON.stringify` over a record MAD does not fully control —
  // outside it. A `BigInt`, a cycle, or a throwing getter anywhere in
  // `RunRecord` or `ChangeSet` would then propagate out of a function whose
  // header promises it cannot, out through `plugin.ts`, and destroy a review the
  // user had already paid twenty billed turns for. A dump failure is untidy; a
  // review it destroyed is a broken tool, and that is the clause of AD-16 this
  // guards.
  try {
    return await writeArtifacts(input, directory)
  } catch (error) {
    // AD-16 / spine, Errors — a dump failure is a domain outcome, never an
    // exception that reaches the user in place of their review.
    return {
      kind: "failed",
      directory,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * The dump's actual work, separated ONLY so the `try` above can enclose all of
 * it — the serialization included. It is free to throw; its caller is not.
 */
async function writeArtifacts(input: DumpInput, directory: string): Promise<ArtifactOutcome> {
  // What goes in, and why each one is a separate file rather than one blob: a
  // person debugging a run opens the one thing they are asking about. The
  // rendered report is the thing they open first and is written as text; the
  // rest is the structure behind it.
  const { record } = input
  const files: [string, string][] = [
    ["report.txt", input.rendered],
    ["roster.json", json(record.roster)],
    ["input.json", json(input.change)],
    ["warnings.json", json(record.warnings)],
    ["ledger.json", json(record.ledger)],
    // The whole record, so anything the five files above do not carry — the
    // findings, their append-only history, the stage counts, `cancelled` — is
    // still there. It overlaps the others on purpose: the small files are for
    // reading, this one is for grepping.
    ["record.json", json(record)],
  ]

  // AD-16 amended — ONE FILE PER TURN, named by issue order and slot, rather
  // than one array. A person debugging a run opens the turn they are asking
  // about; a single `turns.json` holding twenty prompts is a file nobody reads
  // twice. The name is zero-padded so a directory listing sorts in issue order,
  // and the slot id is MAD's own vocabulary (`discovery-1`, `judge-*`) rather
  // than anything a model supplies, so nothing here can name a file after
  // attacker-chosen bytes.
  for (const turn of input.turns ?? []) {
    files.push([`turn-${String(turn.seq).padStart(3, "0")}-${safeName(turn.slot)}.json`, json(turn)])
  }

  // 0o700 / 0o600 (code review 2026-08-31) — THE DUMP IS PRIVATE TO THE USER WHO
  // RAN IT. `input.json` is the source under review, and the turn files are every
  // prompt MAD sent and every answer it got back. The default root lives under
  // the host's shared temp directory, so at the default umask on a multi-user
  // host all of that is world-readable. These modes are the difference between a
  // debug feature and a disclosure.
  await mkdir(directory, { recursive: true, mode: 0o700 })
  // WRITTEN IN PARALLEL, after the single `mkdir` they all depend on. This runs
  // between the review finishing and the user seeing it, and a 20-slot run is
  // ~26 files; serially that is a debug feature charging the user wall-clock.
  await Promise.all(
    files.map(([name, body]) => writeFile(join(directory, name), body, { encoding: "utf8", mode: 0o600 })),
  )
  return { kind: "written", directory, files: files.length }
}

/**
 * Two-space JSON, so the files are readable by the person this dump is for.
 *
 * A `RunRecord` holds no cycles — findings are shared between `pool` and
 * `findings` by reference (AD-7), which `JSON.stringify` renders twice rather
 * than choking on. That duplication is a cost in bytes and a feature in a debug
 * dump: the pre-cluster union and the canonical set are separately readable.
 */
function json(value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`
}

/**
 * BELT AND BRACES on a filename.
 *
 * A slot id is MAD's own (`core/domain/roster.ts` builds them), so today this
 * changes nothing. It is here because a filename is the one string in this
 * module that becomes a filesystem PATH, and "MAD builds it" is the kind of
 * invariant that holds until a story adds a slot id derived from a lens name or
 * a pinned model id — story 8A pins models by id, which is a user-supplied
 * string. Anything outside the safe set becomes `_`; there is no path separator
 * and no `..` that can survive it.
 */
function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "slot"
}
