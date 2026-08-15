/**
 * Pipeline assembly — the one seam a caller drives (AD-1: the entrypoint
 * injects the adapters' port implementations; the core knows no harness).
 *
 * Story 1 runs two of the six filters: discover -> output. Stories 2–7 insert
 * cluster, route, debate and judge between them WITHOUT changing this
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
import { discover } from "../stages/discover.ts"
import { output } from "../stages/output.ts"

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
    lensInstructions: [],
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
  record.findings = discovered.findings
  // AD-11 amended / AD-17e — carried to output so a reader can tell a shipped
  // lens instruction from one generated at run time.
  record.lensInstructions = discovered.lensInstructions
  record.warnings.push(...discovered.warnings)

  // ---- stages 2–5: cluster, route, debate, judge — stories 3–7 ----
  //
  // AD-8 says clustering owns `coDiscovery`. With no cluster stage yet, every
  // POOL finding is its own one-member cluster, so the pipeline assembles that
  // degenerate case HERE rather than letting `discover` write a field it does
  // not own. Story 3 deletes these lines and `core/stages/cluster.ts` takes
  // over. The denominator is `answered` (AD-6a), never `roster.requested`.
  //
  // The guard is AD-17d and it is not cosmetic. Unguarded, a lens finding does
  // not necessarily render `1/1` — at `answered: 3` it renders `1/3` — it
  // carries A PRIOR IT WAS NEVER ENTITLED TO, which is AD-9's forbidden
  // conflation whatever the ratio comes out as. A lens was PROMPTED for its
  // dimension, so it has no unprompted signal to report and no number can stand
  // in for one. `source` is the discriminator, never `coDiscovery === undefined`
  // — that already means "clustering has not run".
  for (const finding of record.findings) {
    if (finding.source !== "pool") continue
    finding.coDiscovery = { raised: 1, answered: discovered.answered }
  }

  // ---- stage 6: output ----
  record.finishedAt = clock.now()
  const rendered = output(record)

  return { record, rendered }
}
