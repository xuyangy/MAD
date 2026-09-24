/**
 * Story 2-8b — the paired gate table: every condition that must hold before the
 * three paired blocks may bill, numbered, owned, and held in this repository.
 *
 * ## Authority lives only here
 *
 * No flag, environment variable or file read at run time can close a gate. A
 * gate closes by a reviewed change to this file that sets its status to
 * `CLOSED` and records its evidence. `scripts/paired.ts` reads this table and
 * nothing else about readiness.
 *
 * ## Two phases, and no probe exception
 *
 * Each gate names the phase it is required for: `accounting-probe` (story 2-8c's
 * bounded, authorized probe) or `evaluation` (the three blocks). The launcher
 * asks `gatePreflight(PAIRED_GATES, "evaluation")`. A gate required only for the
 * probe is printed and never consulted for the evaluation, so closing it can
 * never stand in for an evaluation gate.
 *
 * ## Authorization is a decision, not an engineering task
 *
 * Gates 3 and 4 are spend authorizations owned by the human who owns the budget.
 * No story closes them, and the completion of this story or any other is not
 * authorization.
 *
 * AD-1: this tree may import from `core/` and `fixtures/`. Nothing under `core/`
 * imports it.
 */

export type GateKind = "engineering" | "authorization"
export type GatePhase = "accounting-probe" | "evaluation"
export type GateStatus = "OPEN" | "CLOSED"

export interface PairedGate {
  number: number
  name: string
  kind: GateKind
  /** The phase this gate is required for. */
  phase: GatePhase
  owner: string
  status: GateStatus
  /** What closing it requires. */
  requires: string
  /** Present exactly when the gate is CLOSED: what establishes it, and the tests that check it. */
  evidence?: string
  /** A fact about the gate that neither closes it nor is required to. Printed; never consulted. */
  note?: string
}

/** A condition that was checked and found NOT to be a gate, with the condition that would make it one. */
export interface CheckedNonGate {
  name: string
  evidence: string
  reopensWhen: string
}

export const HUMAN_BUDGET_OWNER = "the human budget owner"

export const PAIRED_GATES: readonly PairedGate[] = [
  {
    number: 1,
    name: "host request accounting",
    kind: "engineering",
    phase: "evaluation",
    owner: "story 2-8c",
    status: "OPEN",
    requires:
      "one physical request per admitted port call, no host retry, and every host subcall accounted, on the measured " +
      "host. The zero-bill probe (`bun run accounting-probe`, evidence ablation/evidence/host-accounting-2026-09-23.json) " +
      "measured this false on opencode 1.18.32: F2, the host retries a failed request itself (a persistent 500 was sent " +
      "6 times per admitted attempt and a 429 was retried once; a header timeout was sent 6 times in the 2026-09-23 " +
      "spike; the network-error case is read from the host binary, not measured); F3, host tools are offered by " +
      "default, a tool step costs an extra request and only the last step's usage is returned; N2, with only " +
      "StructuredOutput offered, a stub that returned a call to an unoffered tool caused a second request (whether a real " +
      "provider emits one under tool_choice required is not established). In the hang scenario the host held the " +
      "provider request open after the adapter gave up, until the probe stopped the host. Closing it needs the " +
      "request-accounting story filed in deferred-work.md, re-measured by the probe",
  },
  {
    number: 2,
    name: "shared gates verified on a real host",
    kind: "engineering",
    phase: "evaluation",
    owner: "story 2-8c",
    status: "CLOSED",
    requires: "the journal's global, Blocks and phase gates verified against a real host before the first paid request",
    evidence:
      "`bun run accounting-probe` (scripts/accounting-probe.ts) on the managed host (ablation/managed-host.ts, the " +
      "measured opencode 1.18.32 build) seeded one journal per gate and drove the real discover stage, a real " +
      "OpencodeModelBackend and the journal's admission: the global, Blocks and phase gates each refused inside the " +
      "journal's admission, before any backend call, with 0 backend calls and 0 stub requests. Only block 1's prefix " +
      "phase was exercised, with one slot; no concurrent or multi-slot admission was tested. Evidence: " +
      "ablation/evidence/host-accounting-2026-09-23.json. Tests: scripts/accounting-probe.test.ts",
  },
  {
    number: 3,
    name: "accounting-probe spend authorization",
    kind: "authorization",
    phase: "accounting-probe",
    owner: HUMAN_BUDGET_OWNER,
    status: "OPEN",
    requires: "the budget owner authorizes story 2-8c's bounded accounting probe",
    note: "story 2-8c's probe spent no paid tokens and did not use this gate: its host's only provider was a local stub",
  },
  {
    number: 4,
    name: "evaluation spend authorization",
    kind: "authorization",
    phase: "evaluation",
    owner: HUMAN_BUDGET_OWNER,
    status: "OPEN",
    requires: "the budget owner authorizes the three paired blocks' spend",
  },
  {
    number: 5,
    name: "worktree identity",
    kind: "engineering",
    phase: "evaluation",
    owner: "story 2-8b",
    status: "CLOSED",
    requires: "the handed --directory is proved to be exactly the sealed labelled change before the coin toss",
    evidence:
      "scripts/paired.ts `worktreeIdentity` compares --directory with a reference copy written by " +
      "`writeLabelledTree` (scripts/materialize-labelled-change.ts): paths, entry types, hard links, sizes, bytes, " +
      "executable bits, the local git config, .git/info, non-sample hooks, HEAD^{tree}, porcelain status, a commit " +
      "count of 1 and the commit's author, committer and message, every git call bounded and run with no GIT_* " +
      "variable, no fsmonitor and no hooks; checked at stage 1 and rechecked at stage 3. Tests: scripts/paired.test.ts",
  },
  {
    number: 6,
    name: "production Tools wiring",
    kind: "engineering",
    phase: "evaluation",
    owner: "story 2-8b",
    status: "CLOSED",
    requires: "the run drives the production Tools port with its shipped blame deadlines",
    evidence:
      "scripts/paired.ts `toolsWiringProblem` checks what the Tools factory reports: the adapter must be " +
      "`opencodeTools` and both blame deadlines the shipped defaults; the shipped default factory is `opencodeTools` " +
      "built with no deadline override, and `config.tools` records the same three facts. Checked before the coin " +
      "toss; unconfirmed blame cleanup aborts the run through its signal. Tests: scripts/paired.test.ts",
  },
]

export const PAIRED_NON_GATES: readonly CheckedNonGate[] = [
  {
    name: "bounded review-path reads (`adapters/opencode/repo.ts`)",
    evidence:
      "a source scan in scripts/paired.test.ts finds no `opencodeRepo` and no `repo.change()` call (it looks for " +
      "`repo.change(`) in scripts/paired.ts, " +
      "ablation/paired.ts or ablation/schedule.ts; the launcher hands `SEEDED_CHANGE` to `createSchedule` and " +
      "`runPairedBlocks`",
    reopensWhen: "the launcher or `runPairedBlocks` ever reads the reviewed change through `opencodeRepo` or `repo.change()`",
  },
]

export interface GatePreflight {
  ok: boolean
  /** Every gate, with its status and whether this phase requires it. */
  lines: string[]
  /** Why the preflight refuses; empty when it passes. */
  problems: string[]
}

/**
 * Check the gates required for `phase`. A gate for another phase is printed and
 * never consulted. A table that is not well formed refuses: an unknown kind, phase
 * or status, a CLOSED gate with no evidence, an OPEN gate carrying evidence, a
 * duplicate or non-positive number, a note that is not one non-empty line, or no
 * authorization gate for the phase (a table that cannot say who authorized the
 * spend authorizes nothing).
 */
export function gatePreflight(gates: readonly PairedGate[], phase: GatePhase): GatePreflight {
  const lines: string[] = []
  const problems: string[] = []
  const seen = new Set<number>()
  for (const gate of gates) {
    const required = gate.phase === phase
    const evidence = gate.status === "CLOSED" ? ` — evidence: ${gate.evidence ?? "NONE RECORDED"}` : ""
    const note = gate.note === undefined ? "" : ` — note: ${gate.note}`
    lines.push(
      `gate ${gate.number} — ${gate.name} — ${gate.kind}, required for ${gate.phase}` +
        `${required ? "" : ` (not consulted for ${phase})`}, owner ${gate.owner} — ${gate.status}${evidence}${note}`,
    )
    if (gate.kind !== "engineering" && gate.kind !== "authorization") {
      problems.push(`gate ${gate.number} (${gate.name}) has kind ${JSON.stringify(gate.kind)}, which is neither engineering nor authorization`)
    }
    if (gate.phase !== "accounting-probe" && gate.phase !== "evaluation") {
      problems.push(`gate ${gate.number} (${gate.name}) has phase ${JSON.stringify(gate.phase)}, which is neither accounting-probe nor evaluation`)
    }
    if (gate.status !== "OPEN" && gate.status !== "CLOSED") {
      problems.push(`gate ${gate.number} (${gate.name}) has status ${JSON.stringify(gate.status)}, which is neither OPEN nor CLOSED`)
    }
    if (gate.status === "OPEN" && gate.evidence !== undefined) {
      problems.push(`gate ${gate.number} (${gate.name}) is OPEN but carries evidence; a gate with evidence must say CLOSED, and one without it OPEN`)
    }
    if (gate.note !== undefined && (typeof gate.note !== "string" || gate.note.trim().length === 0 || /[\r\n]/.test(gate.note))) {
      problems.push(`gate ${gate.number} (${gate.name}) has a note that is not one non-empty line`)
    }
    if (!Number.isInteger(gate.number) || gate.number < 1) problems.push(`gate "${gate.name}" has no valid number`)
    else if (seen.has(gate.number)) problems.push(`gate number ${gate.number} appears twice`)
    seen.add(gate.number)
    if (gate.status === "CLOSED" && (gate.evidence === undefined || gate.evidence.trim().length === 0)) {
      problems.push(`gate ${gate.number} (${gate.name}) is CLOSED with no evidence recorded, so it is not closed`)
      continue
    }
    if (required && gate.status !== "CLOSED") {
      problems.push(`gate ${gate.number} (${gate.name}) is ${gate.status}; owner: ${gate.owner}; closing it requires: ${gate.requires}`)
    }
  }
  if (!gates.some((gate) => gate.phase === phase && gate.kind === "authorization")) {
    problems.push(`the table holds no authorization gate for ${phase}, so nothing authorizes its spend`)
  }
  return { ok: problems.length === 0, lines, problems }
}
