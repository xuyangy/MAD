/**
 * Pipeline assembly — the one seam a caller drives (AD-1: the entrypoint
 * injects the adapters' port implementations; the core knows no harness).
 *
 * Story 4 runs four of the six filters: discover -> cluster -> route -> output.
 * Stories 5–6 insert debate and judge between them WITHOUT changing this
 * signature, and story 9's ablation calls this function directly as the
 * single-model control arm — no second code path.
 */

import type { Roster } from "../domain/roster.ts"
import { emptyLedger, type RunRecord } from "../domain/run-record.ts"
import type { Warning } from "../domain/warning.ts"
import { resolveInstructions } from "../instructions/registry.ts"
import type { InstructionSet } from "../instructions/types.ts"
import type { Clock } from "../ports/clock.ts"
import type { ModelBackend } from "../ports/model-backend.ts"
import type { ChangeSet } from "../ports/repo.ts"
import { cluster } from "../stages/cluster.ts"
import { discover } from "../stages/discover.ts"
import { output } from "../stages/output.ts"
import { clampThreshold, route } from "../stages/route.ts"

export interface ReviewDeps {
  roster: Roster
  backend: ModelBackend
  clock: Clock
  /** The change under review, already read through the `Repo` port. */
  change: ChangeSet
  /** Warnings raised before the pipeline started — the roster's (AD-6c). */
  priorWarnings?: Warning[]
  /** AD-11 — versioned instruction set; defaulted, never inlined at a call site. */
  instructions?: InstructionSet
  /**
   * CAP-3 — the co-discovery threshold, the paranoia dial (`cost-model.md`).
   * Defaulted and clamped by the route stage. This seam is deliberately the only
   * way to move it in story 4: `cost-model.md` puts ONE budget number and a
   * `quick | normal | paranoid` preset in front of the user, and story 8 owns
   * that surface. Story 9's ablation drives `review()` directly, so nothing that
   * needs the dial today is missing it.
   */
  threshold?: number
}

export interface ReviewResult {
  /** AD-16 — in memory. Nothing is written to the user's repo. */
  record: RunRecord
  /** The rendered run (spine, Observability: the rendered run IS the trace). */
  rendered: string
}

function buildInput(change: ChangeSet): string {
  return [
    `# Change under review`,
    ``,
    `Selection: ${change.description}`,
    `Files touched (${change.files.length}): ${change.files.join(", ")}`,
    ``,
    `## Diff`,
    ``,
    "```diff",
    change.diff,
    "```",
  ].join("\n")
}

export async function review(deps: ReviewDeps): Promise<ReviewResult> {
  const { roster, backend, clock, change } = deps
  // AD-11 amended — the pool's set comes from the registry, addressed by task
  // type + role. The lens sets are resolved inside `discover`, per lens slot.
  const instructions =
    deps.instructions ?? resolveInstructions({ taskType: "coding", role: "discovery" })

  const record: RunRecord = {
    runId: clock.id("run"),
    startedAt: clock.now(),
    roster,
    answered: 0,
    findings: [],
    pool: [],
    lensInstructions: [],
    // CAP-3 — clamped once, here, so the record carries the value routing
    // actually used rather than the one the caller asked for.
    threshold: clampThreshold(deps.threshold),
    warnings: [...(deps.priorWarnings ?? [])],
    ledger: emptyLedger(),
  }

  // ---- stage 1: discover ----
  const discovered = await discover({
    roster,
    backend,
    instructions,
    input: buildInput(change),
    clock,
    ledger: record.ledger,
  })

  record.answered = discovered.answered
  // The pre-cluster union is RETAINED, not reconstructed. CAP-1's recall harness
  // measures the discovery pool, and a merged set is a different set.
  record.pool = discovered.findings
  // AD-11 amended / AD-17e — carried to output so a reader can tell a shipped
  // lens instruction from one generated at run time.
  record.lensInstructions = discovered.lensInstructions
  record.warnings.push(...discovered.warnings)

  // ---- stage 2: cluster ----
  //
  // The `{raised: 1, answered}` shim that stood here until story 3 IS GONE.
  // Clustering owns `coDiscovery` (AD-8) and now writes it — including the rule
  // the shim's guard used to carry, that a lens finding never receives a prior
  // (AD-17d, CAP-11). Do not reintroduce a default here; a stage writing a field
  // it does not own is exactly what AD-8 exists to stop.
  //
  // For a run whose findings are all distinct this is byte-for-byte what the
  // shim produced: every finding is a singleton reading `{raised: 1, answered}`.
  // The only rendering that changes is the one that should — findings that are
  // actually equivalent.
  const clustered = await cluster({ findings: record.pool, answered: discovered.answered, clock })
  record.findings = clustered.findings

  // ---- stage 3: route ----
  //
  // The CANONICAL set, never `record.pool`: an absorbed member is not a finding
  // the pipeline decides about, and routing one would produce a decision nothing
  // downstream ever reads.
  const routed = route({ findings: record.findings, threshold: record.threshold, clock })
  // The record reports what the STAGE did, not what the caller asked for and not
  // what the renderer can reconstruct. Re-stamping `threshold` from the return
  // value costs nothing (both sides call `clampThreshold`, so it is already a
  // fixpoint) and removes the class of bug where the two derivations drift; the
  // counts come across for the reason `RunRecord.routeCounts` documents.
  record.threshold = routed.threshold
  record.routeCounts = {
    toDebate: routed.toDebate,
    toJudge: routed.toJudge,
    toJudgeAtThreshold: routed.toJudgeAtThreshold,
    toJudgeNoPrior: routed.toJudgeNoPrior,
  }

  // ---- stages 4–5: debate, judge — stories 5–6 ----

  // ---- stage 6: output ----
  record.finishedAt = clock.now()
  const rendered = output(record)

  return { record, rendered }
}
