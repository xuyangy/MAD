/**
 * AC2 (story 2.3) — THE SINK NOTHING AWAITS.
 *
 * A provider that MAD stopped waiting on keeps working, and eventually answers.
 * The prompt promise for that request is still in memory, so a non-awaited
 * continuation on it can hand the usage the provider finally reports to
 * something the run will read later. This is that something.
 *
 * ## Why a sink at all, and not a read-back
 *
 * The SDK does offer read-back: `session.prompt` accepts a `messageID`
 * (`sdk.gen.d.ts:1089`), and `session.message` (`:1120`) / `session.messages`
 * (`:1073`) return usage afterwards. Nothing in this tree calls any of them, and
 * the route was REJECTED for AC2 rather than overlooked: `session.delete` is
 * documented as permanently removing messages and history (`:1000-1003`), so
 * reading usage back would mean DEFERRING session disposal for an unbounded
 * period on exactly the path AC3 requires to be bounded. The two acceptance
 * criteria would fight. The continuation needs no session at all — the promise
 * is already in memory, and its eventual `info.tokens` is the same number the
 * provider bills.
 *
 * ## Why the write half and the read half are two interfaces
 *
 * `LateUsageReporter` is what an adapter is given. `LateUsageSink` is what the
 * run's assembly holds. The narrowing is the whole point: a backend that could
 * `drain()` would silently take usage the record was about to recover, and
 * nothing downstream would ever learn that a number had existed. An adapter can
 * write and cannot read or clear.
 *
 * ## Why `drain()` is synchronous, and why that is a type-level guarantee
 *
 * AC2 says the run waits for no completion it cannot guarantee. A `drain()`
 * returning `Promise<LateUsageReport[]>` would satisfy every functional test
 * anyone would write about it, and would reintroduce the unbounded wait through
 * the front door — the only correct way to consume a promise is to await it, and
 * the one caller (`core/run/review.ts`, immediately before `finishedAt` is
 * stamped) would then be awaiting a completion nobody can bound. Synchronous
 * makes "it never waits" a property of the type rather than of a caller's
 * discipline.
 *
 * The honest consequence, stated rather than hidden: usage that arrives after
 * the drain is NOT in that run's record. The sink still holds it, nothing throws
 * it away, and no story here pretends the record is closed over a number that
 * had not arrived.
 *
 * Interfaces plus ONE constructor, the shape `core/ports/model-backend.ts`
 * already has and for the same reason: there is nothing caller-specific in a
 * queue, and two implementations of one queue is two chances to get "draining
 * takes" wrong. Imports nothing but the domain (AD-1).
 */

import type { LateUsageReport } from "../domain/run-record.ts"

/**
 * `LateUsageReport` is DECLARED in `core/domain/run-record.ts` and re-exported
 * here, which is where every caller imports it from.
 *
 * Not a duplication and not an accident: the domain owns the vocabulary of what
 * usage IS (`TokenUsage` has lived there since story 1, and
 * `reconcileLateUsage` is the one function that consumes a report), while this
 * port owns the MECHANISM by which one is delivered. Declaring the payload here
 * instead would mean `core/domain/` importing `core/ports/` — and
 * `core/ports/model-backend.ts` already imports `TokenUsage` from the domain, so
 * that arrow is a module cycle. Restating the shape in both files was the other
 * option and was rejected: two structurally identical types with two names is
 * one field edit away from a reconciler that silently accepts a payload it
 * cannot read.
 */
export type { LateUsageReport }

/**
 * The WRITE HALF — what an adapter is handed
 * (`OpencodeBackendOptions.lateUsage`).
 *
 * `report` returns `void` and not a promise. A promise here would put a floating
 * one on the abandoned-prompt continuation, and a floating rejection on that
 * path is an unhandled rejection surfacing in a run that has already finished —
 * from code whose entire purpose is to not affect the run.
 *
 * A reporter must be safe to call at any time, including after the run has
 * closed its record. Reporting into a drained sink is not an error; it is the
 * ordinary case for a provider that took longer than the run did.
 */
export interface LateUsageReporter {
  report(report: LateUsageReport): void
}

/**
 * The READ HALF, held by the run's assembly and never by an adapter.
 *
 * `drain()` returns what has arrived so far AND TAKES IT: the sink owns the
 * "already delivered" state so no caller has to keep a cursor. That matters
 * because `reconcileLateUsage` folds a report into `ledger.total`, so a report
 * delivered twice would double a real bill — the mirror image of the
 * undercounting this story exists to fix, and just as wrong.
 *
 * It is `LateUsageReporter` extended rather than a separate shape, so the one
 * object can be handed to the adapter as the narrow type with no adapter or
 * conversion in between.
 */
export interface LateUsageSink extends LateUsageReporter {
  drain(): LateUsageReport[]
}

/**
 * The one implementation: an in-memory queue, in arrival order.
 *
 * It DEDUPLICATES NOTHING and MERGES NOTHING, deliberately. Two payloads for one
 * `executionId` both arrive, because deciding whether they disagree is an
 * integrity question about a ledger (`evaluation-protocol.md:504-507`: a
 * disagreement is an integrity error, "not something to deduplicate by
 * first-seen") and this object holds no ledger. A sink that collapsed them by
 * first-seen would be doing the forbidden thing one layer early, where nothing
 * could see it happen.
 *
 * It is unbounded, and that is safe for the reason the run is bounded: a sink
 * lives for one run, and the number of reports it can receive is bounded by the
 * number of turns that run issued.
 */
export function createLateUsageSink(): LateUsageSink {
  let queue: LateUsageReport[] = []
  return {
    report(report: LateUsageReport): void {
      queue.push(report)
    },
    drain(): LateUsageReport[] {
      // A NEW ARRAY, not the same one emptied. The caller passes the result
      // straight to `reconcileLateUsage` and may hold it afterwards; handing out
      // the live buffer would mean a later `report()` mutating an array the
      // reconciler had already read past.
      const taken = queue
      queue = []
      return taken
    },
  }
}
