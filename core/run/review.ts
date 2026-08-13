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
import { DISCOVERY_INSTRUCTIONS, type InstructionSet } from "../instructions/discovery.ts"
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
  const instructions = deps.instructions ?? DISCOVERY_INSTRUCTIONS

  const record: RunRecord = {
    runId: clock.id("run"),
    startedAt: clock.now(),
    roster,
    answered: 0,
    findings: [],
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
  record.warnings.push(...discovered.warnings)

  // ---- stages 2–5: cluster, route, debate, judge — stories 3–7 ----
  //
  // AD-8 says clustering owns `coDiscovery`. With no cluster stage yet, every
  // finding is its own one-member cluster, so the pipeline assembles that
  // degenerate case HERE rather than letting `discover` write a field it does
  // not own. Story 3 deletes these lines and `core/stages/cluster.ts` takes
  // over. The denominator is `answered` (AD-6a), never `roster.requested`.
  for (const finding of record.findings) {
    finding.coDiscovery = { raised: 1, answered: discovered.answered }
  }

  // ---- stage 6: output ----
  record.finishedAt = clock.now()
  const rendered = output(record)

  return { record, rendered }
}
