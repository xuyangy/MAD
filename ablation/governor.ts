/**
 * AC4 (story 2.3) — THE EXPERIMENT-WIDE STOP MECHANISM the frozen protocol
 * specifies and could not, until now, evaluate.
 *
 * `evaluation-protocol.md:332-339` is the whole of the policy, and none of it is
 * re-decided here:
 *
 * > On any billed or potentially billed execution whose usage is missing and
 * > carries no defensible finite upper bound, **stop admitting all new billable
 * > requests experiment-wide**, retries, calibration, pilots and adversarial runs
 * > included. Record the known spend, the identities and count of executions with
 * > unknown usage, and any in-flight requests; label token exposure
 * > **unquantified**. […] **Do not resume automatically.**
 *
 * The same document said this predicate "cannot work until story 2.3 ships",
 * because `adapters/opencode/model-backend.ts` mapped missing usage to
 * `emptyTokenUsage()` and an unknown read as a free turn. That line is gone,
 * `TokenLedger.unknownUsage` now holds the executions MAD could not count, and
 * this module is the mechanism that reads it and stops.
 *
 * ## TWO LEVELS OF ONE RULE, ONE AUTHORITY PER LEVEL
 *
 * This is the half of AC4 that would otherwise be a second opinion on a question
 * AD-15 gives to exactly one module, so the split is worth stating precisely:
 *
 * - **"May this TURN spend?"** is `core/budget/ledger.ts`'s `mayISpend`, and it
 *   is answered against ONE run's ledger. Its unknown-usage clause is the
 *   within-run half of this same rule, gated by `TokenLedger.stopOnUnknownUsage`.
 *   NOTHING HERE ANSWERS THAT QUESTION — this module cannot see a turn, is never
 *   consulted by a stage, and exports no function a stage could call.
 * - **"May this ARM run?"** is here, and it is answered across EVERY run the
 *   experiment has observed. An arm is the unit because it is the unit the
 *   evaluation harness admits: `ablation/arms.ts` starts one, bills it, and
 *   finishes it, and there is no smaller thing this tree hands out.
 *
 * A governor that also answered the first question would put two authorities on
 * one question, which is the failure `core/budget/ledger.ts:10-19` exists to
 * prevent. The surface is three functions and `governor.test.ts` pins that it is
 * three.
 *
 * ## THE HALT IS A FILE, BECAUSE AN IN-MEMORY FLAG RESUMES AUTOMATICALLY
 *
 * "Do not resume automatically" is a property of the EXPERIMENT, not of a
 * process. A boolean on this object satisfies every test that runs inside one
 * process and then evaporates when the operator runs the command again — which
 * is precisely the resumption the protocol forbids, arriving as a convenience
 * nobody decided on. So the halt is written into the bundle root as
 * `unknown-usage-halt.json`, `admit()` refuses while that file exists, and A
 * HUMAN DELETES IT. Nothing in this codebase deletes it, and that omission is
 * the mechanism rather than a gap in it.
 *
 * The marker is also the RECORD the protocol asks for: the known spend, the
 * identities and count of unknown-usage executions, the in-flight count and the
 * exposure label, in a file that outlives the process that stopped.
 *
 * ## IT REFUSES, IT DOES NOT THROW — AND THE CALLER STOPS
 *
 * `admit()` returns an outcome, in the shape `writeBundleIndex` and
 * `writeArmDump` already use in `ablation/bundle.ts`: this module cannot know
 * whether its caller is a CLI that must keep its "main always returns 0"
 * contract. The ONE place a refusal becomes an exception is `runAblation`, and
 * the exception is `EvaluationBundleError` — the class `ablation/live.ts:254`
 * already throws for a mandatory dump that could not be written, which
 * `scripts/ablation.ts` already catches and prints as a deliberate stop rather
 * than a crash. A NEW exception class would have meant a second vocabulary for
 * one idea ("the evaluation stopped on purpose, nothing further was billed") and
 * a CLI that printed one of them as a stack trace.
 *
 * ## WHAT IT DOES NOT CHECK, AND WHY
 *
 * The bundle root's containment (AD-16 — never inside the worktree under review)
 * is checked by `writeBundleIndex` before any arm runs, through
 * `artifacts.ts`'s own `refusalFor`/`realRefusalFor`. This module writes into
 * that same already-checked root and deliberately does not re-implement the
 * test: `ablation/bundle.ts`'s header says why, and it is the reason that file
 * imports the check rather than copying it — "a second containment check is a
 * second thing that can be subtly weaker than the first".
 *
 * AD-1: this tree may import from `core/`. Nothing under `core/` may import from
 * here, which `scripts/lint-dependency-direction.ts` enforces.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { spentTokens } from "../core/budget/ledger.ts"
import {
  addTokens,
  emptyTokenUsage,
  type TokenUsage,
  type UnknownUsageEntry,
} from "../core/domain/run-record.ts"
import type { ArmRun } from "./arms.ts"
import type { TokenExposure } from "./manifest.ts"

/**
 * The halt marker's filename, at the bundle root, beside `bundle.json`.
 *
 * NAMED FOR WHAT HAPPENED rather than for the machinery — an operator who finds
 * it has to be able to tell what it is without reading this file. Its presence
 * is the whole signal: the contents are the record, and `admit()` refuses on a
 * marker it cannot parse exactly as firmly as on one it can.
 */
export const HALT_MARKER_FILE = "unknown-usage-halt.json"

/**
 * ONE execution whose usage is unknown, carried with the run it happened in.
 *
 * THE ARM, REPEAT AND RUN ARE NOT DECORATION. `UnknownUsageEntry.executionId` is
 * minted by a monotonic counter PER BACKEND INSTANCE
 * (`adapters/opencode/model-backend.ts`'s `nextExecutionId`), and the evaluation
 * builds one backend per arm — so `exec-1` in the control arm and `exec-1` in the
 * pool arm are two different physical requests wearing one name. Within a run
 * that is unambiguous and is exactly what `reconcileLateUsage` needs; across an
 * experiment it is not, and the protocol asks this level for IDENTITIES. Three
 * fields make the identity whole rather than renaming the execution and losing
 * the link back to its own run's ledger.
 */
export interface ExperimentUnknownUsage {
  armId: string
  repeatId: number
  runId: string
  entry: UnknownUsageEntry
}

/**
 * A session the adapter could not confirm it had deleted, carried for the same
 * reason and NEVER as a halt.
 *
 * `core/domain/warning.ts` classifies `session-cleanup-unresolved` as a
 * DISCLOSURE: a session MAD could not delete is untidy, not a failure of the
 * review, and not a bill MAD cannot count. The protocol's stop rule binds
 * unknown USAGE. Recording these here is the "and any in-flight requests" half
 * of the same sentence — what the experiment left behind on a host is what an
 * operator has to go and look at — and halting on one would be this module
 * inventing a policy the protocol did not state.
 */
export interface ExperimentCleanup {
  armId: string
  repeatId: number
  runId: string
  message: string
}

/**
 * What the experiment knows about its own exposure, in the protocol's own terms.
 *
 * Every field the stop rule names is here and none of them is fused with
 * another: the known spend is a number and a breakdown, the unknown is a list
 * and a count, and the exposure is a LABEL — because the one thing
 * `evaluation-protocol.md:332-339` refuses to do is put a number on what is
 * unknown ("an unknown amount cannot be compared with a number").
 */
export interface ExperimentGovernorState {
  /** True once admission is refused. Never cleared by this module. */
  halted: boolean
  /** Why, in a sentence an operator can act on. `null` while admission is open. */
  haltReason: string | null
  /**
   * The spend MAD COULD count, summed over every observed run's ledger total.
   * Carried as the five components because a total is not a breakdown —
   * `ablation/compare.ts`'s `ArmCost` makes the same split for the same reason.
   */
  knownSpend: TokenUsage
  /** The same figure summed, through the accountant's `spentTokens`. */
  knownSpendTokens: number
  unknownUsage: ExperimentUnknownUsage[]
  /** `unknownUsage.length`, recorded because the protocol asks for the count too. */
  unknownUsageCount: number
  unresolvedCleanups: ExperimentCleanup[]
  /**
   * Arms admitted that have not reported back — "any in-flight requests", at the
   * only granularity this level admits anything.
   *
   * An arm that was admitted and never observed is an arm that threw, or whose
   * process died, and its spend is therefore not in `knownSpend` at all. That is
   * the figure a human needs when reading a halt, and it is why this is counted
   * rather than inferred from the run list.
   */
  inFlight: number
  observedRuns: number
  exposure: TokenExposure
  /** Where the halt is persisted, once it is. `null` while nothing is halted. */
  markerFile: string | null
  /**
   * Non-null when the halt could NOT be written down, with the reason.
   *
   * THIS PROCESS STILL REFUSES — the in-memory flag is set before the write is
   * attempted — but the next one would not see the marker, so the failure is
   * surfaced instead of swallowed. A halt nobody can read after the process exits
   * is the automatic resumption this module exists to prevent.
   */
  markerError: string | null
}

/** A refusal is a value, not an exception. See the module header. */
export type Admission = { ok: true } | { ok: false; reason: string }

export interface ExperimentGovernor {
  /**
   * May the experiment start another arm? ASKED BEFORE EVERY ONE, including
   * retries and repeats — the protocol's list is "retries, calibration, pilots
   * and adversarial runs included", so there is no category this gate is polite
   * about.
   */
  admit(): Promise<Admission>
  /** Read one finished arm's record. Halts the experiment if it holds an unknown. */
  observe(run: ArmRun): Promise<ExperimentGovernorState>
  /** What this governor knows, right now. Never reads the disk; see `admit`. */
  state(): ExperimentGovernorState
}

export interface ExperimentGovernorOptions {
  /**
   * Where the halt marker lives — the same root `writeBundleIndex` declared the
   * arms in, so a halt is filed with the evidence it is about.
   */
  bundleRoot: string
}

/**
 * The governor for ONE experiment, holding ONE bundle root.
 *
 * It is a closure rather than a class for the reason `createLateUsageSink` is:
 * the state must not be reachable from outside the three functions. A field an
 * arm could write is a halt an arm could clear.
 */
/**
 * Whether a run's `total` is a figure this governor may do arithmetic over —
 * five fields, each a finite, non-negative number.
 *
 * The mirror of `isCountableUsage` in `core/domain/run-record.ts`, and a
 * separate copy on purpose rather than an export dragged across the boundary:
 * that one guards what enters a LEDGER, this one guards what enters a report
 * about many ledgers, and they are allowed to diverge if the two questions ever
 * do. Six lines is a cheaper coupling than an exported internal.
 */
function countableTotal(total: unknown): total is TokenUsage {
  if (total === null || typeof total !== "object") return false
  const usage = total as Record<string, unknown>
  for (const field of ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const) {
    const n = usage[field]
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return false
  }
  return true
}

export function createExperimentGovernor(options: ExperimentGovernorOptions): ExperimentGovernor {
  const root = resolve(options.bundleRoot)
  const markerPath = join(root, HALT_MARKER_FILE)

  let halted = false
  let haltReason: string | null = null
  let knownSpend: TokenUsage = emptyTokenUsage()
  let inFlight = 0
  let observedRuns = 0
  let markerFile: string | null = null
  let markerError: string | null = null
  const unknownUsage: ExperimentUnknownUsage[] = []
  const unresolvedCleanups: ExperimentCleanup[] = []

  const state = (): ExperimentGovernorState => ({
    halted,
    haltReason,
    knownSpend: { ...knownSpend },
    knownSpendTokens: spentTokens(knownSpend),
    // COPIED OUT. `state()` is read by a caller that may hold it while the
    // experiment continues, and a live alias would be a recorded figure that
    // keeps changing — the same reason `buildManifest` copies this collection.
    unknownUsage: unknownUsage.map((identity) => ({ ...identity })),
    unknownUsageCount: unknownUsage.length,
    unresolvedCleanups: unresolvedCleanups.map((cleanup) => ({ ...cleanup })),
    inFlight,
    observedRuns,
    // ONCE HALTED, UNQUANTIFIED — and it is the halt that decides, not the
    // count. A governor halted on a run whose unknown-usage collection was
    // missing altogether has no identities to show and no defensible bound
    // either, and `ablation/manifest.ts`'s `TokenExposure` makes the same
    // collapse one layer down for the same reason.
    exposure: halted ? "unquantified" : "quantified",
    markerFile,
    markerError,
  })

  /**
   * Write the halt down. NEVER THROWS — `bundle.ts`'s writers hold the same
   * contract, and for the stronger reason here: the halt is already in force in
   * memory by the time this runs, so a failed write must degrade to a reported
   * problem rather than to an exception that unwinds the stop itself.
   */
  const persist = async (): Promise<void> => {
    try {
      // 0o700 / 0o600 for the reason the dump and the index use them: this file
      // names what an experiment billed and could not count, and its default home
      // is a shared temp directory.
      await mkdir(root, { recursive: true, mode: 0o700 })
      const { markerFile: _file, markerError: _error, ...recorded } = state()
      await writeFile(markerPath, `${JSON.stringify(recorded, undefined, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      })
      markerFile = markerPath
      markerError = null
    } catch (error) {
      markerFile = null
      markerError = error instanceof Error ? error.message : String(error)
    }
  }

  const halt = (reason: string): void => {
    halted = true
    // THE FIRST REASON STANDS. A later unknown adds an identity to the list; it
    // does not rewrite the sentence that says what stopped the experiment, and
    // an operator reading the marker wants the first cause rather than the most
    // recent one.
    haltReason ??= reason
  }

  return {
    async admit(): Promise<Admission> {
      // THE DISK IS CONSULTED FIRST, EVERY TIME. The marker may have been written
      // by an earlier process, or by this one; either way the question "is this
      // experiment halted?" is answered by the file, because that is the answer
      // that survives a restart.
      let marker: string | undefined
      try {
        marker = await readFile(markerPath, "utf8")
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== "ENOENT") {
          // FAIL CLOSED. MAD could not establish that no halt exists, and the
          // direction FR10 requires erring in is the one where a wasted block is
          // recoverable and an uncountable bill inside a published number is not.
          return {
            ok: false,
            reason:
              `the experiment's halt marker \`${markerPath}\` could not be read ` +
              `(${error instanceof Error ? error.message : String(error)}), so whether this ` +
              `experiment is halted is NOT established. Nothing further is admitted until it is.`,
          }
        }
      }

      if (marker !== undefined) {
        // ADOPTED, NOT MERGED. The marker's own identities stay in the marker:
        // claiming another process's observations as this governor's would
        // double-count them in any state this one goes on to write.
        halt(
          `this experiment is HALTED: \`${markerPath}\` exists. It records the executions whose ` +
            `usage is unknown and the spend that was known when admission stopped ` +
            `(\`evaluation-protocol.md:332-339\`).`,
        )
        markerFile = markerPath
      }

      if (halted) {
        return {
          ok: false,
          reason:
            `${haltReason} Admission does NOT resume automatically: a human reads the halt, decides ` +
            `what the unknown usage was, and deletes \`${HALT_MARKER_FILE}\` from the bundle root ` +
            `to resume. Nothing further was billed.`,
        }
      }

      inFlight += 1
      return { ok: true }
    },

    async observe(run: ArmRun): Promise<ExperimentGovernorState> {
      // FLOORED AT ZERO. `observe` is reachable without a matching `admit` — a
      // test does it, and so would a caller that wired the gate in later — and a
      // negative in-flight count is a figure nobody can read.
      inFlight = Math.max(0, inFlight - 1)
      observedRuns += 1

      const ledger = run.record.ledger
      const identity = { armId: run.spec.id, repeatId: run.repeat, runId: run.record.runId }

      // GUARDED FOR THE SAME REASON THE `unknownUsage` CHECK TWELVE LINES BELOW
      // IS, and it was not (wave-5 review, 2026-09-11). The two read the SAME
      // untrusted record: if a pre-2.3 dump or a JavaScript caller can hand this
      // a ledger with no `unknownUsage`, it can hand it one with no `total`, and
      // an unguarded `addTokens` threw straight out of `observe` and out of
      // `runAblation`.
      //
      // A crash here fails in the safe direction — nothing further gets billed —
      // but "the experiment died with a TypeError" and "the experiment stopped
      // because it could not audit a run" are different facts, and only the
      // second tells the human what to do. So it HALTS with a reason instead,
      // which is what the collection guard already does for its half.
      //
      // `isCountableUsage`'s job in `core/domain/run-record.ts`, restated rather
      // than imported: `core/` may not be imported FROM here for a value that
      // would drag the domain's internals into the harness, and a total that is
      // not five finite numbers is exactly as unusable there as here.
      if (!countableTotal(ledger.total)) {
        halt(
          `arm \`${identity.armId}\` repeat ${identity.repeatId} (run \`${identity.runId}\`) carries NO ` +
            `readable spend total, so the known-spend figure this governor reports would be ` +
            `arithmetic over a value MAD cannot read. Token exposure is unquantified.`,
        )
      } else {
        knownSpend = addTokens(knownSpend, ledger.total)
      }

      for (const warning of run.record.warnings ?? []) {
        if (warning.code !== "session-cleanup-unresolved") continue
        unresolvedCleanups.push({ ...identity, message: warning.message })
      }

      // THE GUARD IS NOT DEAD CODE, though `TokenLedger` says the field is
      // required: a record deserialized from a pre-2.3 dump, or built by a
      // JavaScript caller, has not been through that type. A ledger with NO
      // unknown-usage collection cannot support the claim that its usage is
      // complete, and admitting on the strength of a field nobody wrote is the
      // flattering direction this whole story exists to close.
      if (!Array.isArray(ledger.unknownUsage)) {
        halt(
          `arm \`${identity.armId}\` repeat ${identity.repeatId} (run \`${identity.runId}\`) carries NO ` +
            `unknown-usage collection, so whether it billed anything MAD could not count is ` +
            `UNAUDITABLE. An unaudited run is not a clean one.`,
        )
      } else if (ledger.unknownUsage.length > 0) {
        for (const entry of ledger.unknownUsage) unknownUsage.push({ ...identity, entry })
        const first = ledger.unknownUsage[0]!
        halt(
          `arm \`${identity.armId}\` repeat ${identity.repeatId} (run \`${identity.runId}\`) billed ` +
            `${ledger.unknownUsage.length} execution(s) whose usage is UNKNOWN, beginning with ` +
            `\`${first.executionId}\` (${first.stage}/${first.slot}, attempt ${first.attempt}: ` +
            `${first.why}). Token exposure for this experiment is UNQUANTIFIED ` +
            `(\`evaluation-protocol.md:332-339\`).`,
        )
      }

      if (halted) await persist()
      return state()
    },

    state,
  }
}
