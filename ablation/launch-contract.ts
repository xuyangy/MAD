/**
 * Epic-2 retro item 3 — the pre-reservation contract the three live launchers
 * share: the exclusive reservation writer and the run-identity validator.
 *
 * `scripts/oauth-pilot.ts` (gate 8), `scripts/paired.ts` (gate 4, OAuth route)
 * and `scripts/adversarial.ts` (gate 10) each authorize one numbered run, name
 * every earlier run with its committed files, and create that run's reservation
 * exclusively before any host starts. This module holds the parts that are the
 * same for all three. Each launcher keeps a thin wrapper that supplies its own
 * operator-facing texts and its own rules, so its messages stay its own.
 *
 * `stageOneBinary` carries stage 1's identified host binary into stage 2's
 * `startManagedHost`, so the host spawned is the binary that was hashed.
 *
 * It imports nothing from `scripts/` or `ablation/paired-gates.ts`: the rules
 * carry every per-launcher fact.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

import type { BinaryIdentityOptions } from "./managed-host.ts"

/** Where every launcher's reservations and committed run evidence live, relative to the repository. */
export const LAUNCH_EVIDENCE_DIR = "ablation/evidence"

/** What a reservation writer returns: the created file, or why it was not created. */
export type ReserveResult = { ok: true; path: string } | { ok: false; why: string }

/** A launcher's own texts for the two ways an exclusive create fails. */
export interface ReserveWhy {
  /** The reservation already exists (EEXIST): another invocation reserved the run first. */
  exists(relative: string): string
  /** Any other failure, with the error's message. */
  failed(relative: string, message: string): string
}

/**
 * Creates `relativePath` under `root` exclusively (`wx`: O_CREAT|O_EXCL), so of
 * two invocations only one can create it; the other is refused with
 * `why.exists`. Its directory is created first. The bytes are
 * `JSON.stringify(record, null, 2)` and a newline, in the caller's key order.
 * Nothing here removes a reservation: a failed or interrupted run consumes its
 * authorization. Never rejects.
 */
export async function reserveExclusive(root: string, relativePath: string, record: unknown, why: ReserveWhy): Promise<ReserveResult> {
  const path = join(root, relativePath)
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
    return { ok: true, path }
  } catch (error) {
    return {
      ok: false,
      why: (error as NodeJS.ErrnoException).code === "EEXIST" ? why.exists(relativePath) : why.failed(relativePath, messageOf(error)),
    }
  }
}

/** The fields every launcher's run identity carries. A field's type is checked here, never assumed. */
export interface RunIdentity {
  run: unknown
  /** The run's own reservation; the pilot's identity has none and derives it. */
  reservation?: unknown
  prior: unknown
}

/** One launcher's identity rules. */
export interface RunIdentityRules<T extends RunIdentity> {
  /** The constant the identity comes from, which every problem names, e.g. `OAUTH_PILOT_RUN`. */
  label: string
  /** The lowest run the launcher can authorize: 2 for the pilot (run 1 is spent), 1 otherwise. */
  floor: number
  /** Run N's reservation, relative to the repository; for a prior run as for the run itself. */
  reservationOf(run: number): string
  /** Whether the identity names its own reservation, which must then be `reservationOf(run)`. */
  ownReservation?: boolean
  /** The launcher's own checks, run after the shared ones; they must tolerate a malformed identity. */
  extra?(identity: T): string[]
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Why `identity` is not a run its launcher can authorize, every problem listed;
 * empty when it is one. `run` must be an integer of at least `rules.floor`; the
 * run's own reservation (when the identity names one) must be the derived one;
 * `prior` must be a list of exactly runs 1 to `run - 1`, in order, its length
 * checked before any entry is read; each entry must be an object naming its
 * derived reservation and an evidence file in `LAUNCH_EVIDENCE_DIR`. The
 * launcher's `extra` checks follow.
 */
export function runIdentityProblems<T extends RunIdentity>(identity: T, rules: RunIdentityRules<T>): string[] {
  const problems: string[] = []
  const { label } = rules
  const run = identity.run
  if (typeof run !== "number" || !Number.isInteger(run) || run < rules.floor) {
    problems.push(`${label} names run ${JSON.stringify(run)}, which is not an integer of at least ${rules.floor}`)
  } else {
    if (rules.ownReservation === true && identity.reservation !== rules.reservationOf(run)) {
      problems.push(`${label} names its own reservation ${quoted(identity.reservation)}, which is not \`${rules.reservationOf(run)}\``)
    }
    problems.push(...priorProblems(identity.prior, run, rules))
  }
  if (rules.extra !== undefined) problems.push(...rules.extra(identity))
  return problems
}

function priorProblems<T extends RunIdentity>(prior: unknown, run: number, rules: RunIdentityRules<T>): string[] {
  const { label } = rules
  const expected = run === 1 ? "[]" : run === 2 ? "[1]" : `1 to ${run - 1}`
  if (!Array.isArray(prior)) return [`${label}.prior is not a list: it must list exactly runs ${expected} before run ${run}`]
  const runs = prior.map((entry: unknown) => (isObject(entry) ? JSON.stringify(entry.run) : "(not an object)"))
  // The length first, so a huge `run` is never compared entry by entry.
  if (prior.length !== run - 1 || prior.some((entry: unknown, index) => !isObject(entry) || entry.run !== index + 1)) {
    const problems = [`${label}.prior lists runs [${runs.join(", ")}], not exactly runs ${expected} before run ${run}: a gap, a duplicate or a reused run`]
    if (prior.length === run - 1) {
      for (const [index, entry] of prior.entries()) {
        if (!isObject(entry)) problems.push(`${label}.prior entry ${index + 1} is not an object`)
      }
    }
    return problems
  }
  const problems: string[] = []
  for (const entry of prior as Record<string, unknown>[]) {
    const priorRun = entry.run as number
    const reservation = rules.reservationOf(priorRun)
    if (entry.reservation !== reservation) {
      problems.push(`${label}.prior names run ${priorRun}'s reservation ${quoted(entry.reservation)}, not \`${reservation}\``)
    }
    const evidence = entry.evidence
    if (typeof evidence !== "string" || dirname(evidence) !== LAUNCH_EVIDENCE_DIR || basename(evidence).trim().length === 0) {
      problems.push(`${label}.prior names run ${priorRun}'s evidence ${quoted(evidence)}, which is not a file in ${LAUNCH_EVIDENCE_DIR}`)
    }
  }
  return problems
}

/**
 * The binary options stage 2 hands `startManagedHost`: `binary` is the real path
 * stage 1's `identifyBinary` resolved and hashed, so the host spawned is the file
 * that was checked rather than whatever `opencode` resolves to later, and the
 * stage-1 seam's `resolveBinary`, `hashFile` and `measured`, when set, so the
 * spawn-time re-check identifies it the same way. With no identified path the
 * seam's own options pass through unchanged.
 */
export function stageOneBinary(identified: string | undefined, seam: BinaryIdentityOptions | undefined): BinaryIdentityOptions {
  return {
    ...(identified === undefined ? (seam?.binary === undefined ? {} : { binary: seam.binary }) : { binary: identified }),
    ...(seam?.resolveBinary === undefined ? {} : { resolveBinary: seam.resolveBinary }),
    ...(seam?.hashFile === undefined ? {} : { hashFile: seam.hashFile }),
    ...(seam?.measured === undefined ? {} : { measured: seam.measured }),
  }
}

/** A value as the problems quote it: a string in backticks, anything else as JSON. */
function quoted(value: unknown): string {
  return typeof value === "string" ? `\`${value}\`` : `${JSON.stringify(value) ?? String(value)}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
