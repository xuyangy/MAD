/**
 * Story 2-8b — the paired gate table: every condition that must hold before the
 * three paired blocks may bill, numbered, owned, and held in this repository.
 *
 * ## Authority lives only here
 *
 * No flag, environment variable or file read at run time can close a gate. A
 * gate closes by a reviewed change to this file that sets its status to
 * `CLOSED` and records its evidence. `scripts/paired.ts` reads this table and
 * nothing else about readiness, refuses while this file differs from HEAD, and
 * records its committed blob and every gate's status in the sealed schedule.
 *
 * ## Four phases, and no probe or pilot exception
 *
 * Each gate names the phase it is required for: `accounting-probe` (story 2-8c's
 * bounded, authorized probe), `oauth-pilot` (story 2-8c5's bounded OpenAI OAuth
 * pilot, `bun run oauth-pilot --live`), `evaluation` (the three blocks) or
 * `adversarial` (story 2.7's sixteen adversarial runs on the OAuth route). The
 * launcher asks `gatePreflight(PAIRED_GATES, "evaluation", route)` for the route
 * its `--provider-mode` selects, `api-key` by default; the pilot asks
 * `gatePreflight(PAIRED_GATES, "oauth-pilot", "oauth")`. A gate required only for
 * the probe or the pilot is printed and never consulted for the evaluation, so
 * closing it can never stand in for an evaluation gate.
 *
 * ## The adversarial phase (story 2-7e)
 *
 * Gates 10, 11 and 12 are required for `adversarial` on the oauth route. Gate
 * 12 is CLOSED; gates 10 and 11 are OPEN, and gate 11 is story 2-7f2's real-host
 * probe. `ADVERSARIAL_RUN` names the one run gate 10 will cover; its
 * pins are `null` until they are chosen, and `adversarialRunProblem` refuses a
 * run with none. For this phase `gatePreflight` reports that problem, and consults
 * `ADVERSARIAL_CANDIDATE_NON_GATES`, the record of the one prerequisite that may
 * turn out not to be a gate: while that record is unresolved, absent or
 * malformed the preflight refuses, and no list a caller supplies replaces it.
 * Story 2-7f resolved it `NON-GATING` on the evidence of `bun run adversarial`'s
 * full import closure.
 *
 * ## Routes (story 2-8c3a)
 *
 * A gate may name the routes it covers: `api-key` (the relay between the host
 * and one provider) or `oauth` (opencode's own sign-ins, counted in admitted
 * attempts). A gate naming no route covers every route. A gate outside the
 * checked route is printed "(not consulted for route …)" and never consulted,
 * so a gate for one route can neither block nor stand in for the other.
 *
 * ## Authorization is a decision, not an engineering task
 *
 * Gates 3, 4, 8 and 9 are spend authorizations owned by the human who owns the budget.
 * Gate 4 covers the evaluation on the oauth route and gate 9 on the api-key route,
 * so closing one never authorizes the other route's spend.
 * No story closes them, and the completion of this story or any other is not
 * authorization.
 *
 * ## Which OAuth pilot run gate 8 authorizes (story 2-8c7)
 *
 * `OAUTH_PILOT_RUN` names the one run gate 8 covers and every earlier run, with
 * the files each one left. It lives in this table, never in a flag, a variable or
 * a date, so the committed-table check makes the run's identity reviewed
 * authority: no flag, environment variable, file or date names a run, and the
 * command line takes none.
 *
 * AD-1: this tree may import from `core/` and `fixtures/`. Nothing under `core/`
 * imports it.
 */

export type GateKind = "engineering" | "authorization"
export type GatePhase = "accounting-probe" | "oauth-pilot" | "evaluation" | "adversarial"
export const GATE_PHASES: readonly GatePhase[] = ["accounting-probe", "oauth-pilot", "evaluation", "adversarial"]
export type GateStatus = "OPEN" | "CLOSED"
/** Story 2-8c3a — how the managed host reaches its providers. */
export type GateRoute = "api-key" | "oauth"
export const GATE_ROUTES: readonly GateRoute[] = ["api-key", "oauth"]

export interface PairedGate {
  number: number
  name: string
  kind: GateKind
  /** The phase this gate is required for. */
  phase: GatePhase
  /** Story 2-8c3a — the routes this gate covers. Absent means every route. */
  routes?: readonly GateRoute[]
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

/**
 * Story 2-8c5 — the exposure document gate 8 authorizes against, pinned by its
 * sha256. `bun run oauth-pilot --live` refuses when the file on disk differs.
 */
export const OAUTH_PILOT_PROPOSAL = {
  path: "_bmad-output/specs/spec-mad-orchestrator/stories/2-8d-openai-oauth-pilot-proposal.md",
  sha256: "2a241e0125a49259daaac2c33480c7044f5f49983211322f6263ab8cb444ccfb",
} as const

/**
 * Story 2-8d — the exposure document gate 4 was authorized against, with its
 * sha256 at authorization. Provenance only: no launcher reads or checks it.
 */
export const EVALUATION_RUN_PROPOSAL = {
  path: "_bmad-output/specs/spec-mad-orchestrator/stories/2-8d-run-proposal.md",
  sha256: "eab2783a386574f8f8f85d3646efddbdaf35e3c8d244d23580df913f3f6a2c1e",
} as const

/**
 * Story 2-8d — the exposure document gate 4 was authorized against for run 3,
 * with its sha256 at authorization. Provenance only: no launcher reads or checks
 * it. `EVALUATION_RUN_PROPOSAL` stays the record of runs 1 and 2.
 */
export const EVALUATION_RUN_3_PROPOSAL = {
  path: "_bmad-output/specs/spec-mad-orchestrator/stories/2-8d-run-3-proposal.md",
  sha256: "150dfff1df365d2115115aee57c3d3ccede50af13114f52973931cb057f43a40",
} as const

/**
 * Story 2-8d — the exposure document gate 4 was authorized against for run 4,
 * with its sha256 at authorization. Provenance only: no launcher reads or checks it.
 */
export const EVALUATION_RUN_4_PROPOSAL = {
  path: "_bmad-output/specs/spec-mad-orchestrator/stories/2-8d-run-4-proposal.md",
  sha256: "19b58092c03761eaa5e1b757862f248fc0a5d8b855f78e8d660a0292ecf24bea",
} as const

/**
 * Story 2-8d — the exposure document gate 4 was authorized against for run 5,
 * with its sha256 at authorization. Provenance only: no launcher reads or checks it.
 */
export const EVALUATION_RUN_5_PROPOSAL = {
  path: "_bmad-output/specs/spec-mad-orchestrator/stories/2-8d-run-5-proposal.md",
  sha256: "613bc2fb489b37ae36258687b6de46f9b9615b6dd77876ad6905059cdd119589",
} as const

/** Story 2-8d — an OAuth evaluation run that already happened, and the committed files it left. */
export interface EvaluationPriorRun {
  run: number
  /** Its reservation, relative to the repository. */
  reservation: string
  /** Its committed evidence, relative to the repository. */
  evidence: string
}

/** Run N's reservation, relative to the repository. */
export function evaluationReservation(run: number): string {
  return `ablation/evidence/paired-oauth-evaluation-run-${run}.reservation`
}

/**
 * Story 2-8d — the one OAuth evaluation run the launcher admits under gate 4: its run, its
 * roster as `provider/model` pins in `--pin` order (the first is also
 * `small_model`), the reservation `bun run paired --live --provider-mode oauth`
 * creates exclusively, in this repository and so across every `--out`, before it
 * starts a host, and every earlier run, whose files must be committed. Nothing
 * deletes a reservation; a failed or interrupted run uses its authorization. Run
 * 1 ran on 2026-10-02 and was refused at stage 2 before any model session; run 2
 * ran the same day on the pins openai/gpt-6-luna, anthropic/claude-opus-5-5 and
 * github-copilot/gpt-5-mini and halted in block 1. Run 3 ran on openai/gpt-6-sol,
 * anthropic/claude-opus-5-5 and github-copilot/gpt-6-luna and was stopped when the
 * Copilot pin filled its slot through openai. Run 4 kept run 3's OpenAI and
 * Copilot pins, which AD-4's 2026-10-02 amendment now serves through the provider
 * each names, replaced anthropic/claude-opus-5-5, which refuses the forced tool
 * choice, with anthropic/claude-sonnet-5, and halted in block 1 on a turn waiting
 * on a permission ask. Run 5 keeps run 4's pins; its turns are offered read-only
 * tools and the host denies every ask.
 */
export const EVALUATION_RUN = {
  run: 5,
  pins: ["openai/gpt-6-sol", "anthropic/claude-sonnet-5", "github-copilot/gpt-6-luna"],
  reservation: evaluationReservation(5),
  prior: [
    {
      run: 1,
      reservation: evaluationReservation(1),
      evidence: "ablation/evidence/paired-oauth-evaluation-run-1-2026-10-02.json",
    },
    {
      run: 2,
      reservation: evaluationReservation(2),
      evidence: "ablation/evidence/paired-oauth-evaluation-run-2-2026-10-02.json",
    },
    {
      run: 3,
      reservation: evaluationReservation(3),
      evidence: "ablation/evidence/paired-oauth-evaluation-run-3-2026-10-02.json",
    },
    {
      run: 4,
      reservation: evaluationReservation(4),
      evidence: "ablation/evidence/paired-oauth-evaluation-run-4-2026-10-05.json",
    },
  ] as readonly EvaluationPriorRun[],
} as const

/** Story 2-8c7 — a live OAuth pilot run that already happened, and the committed files it left. */
export interface OAuthPilotPriorRun {
  run: number
  /** Its reservation, relative to the repository. */
  reservation: string
  /** Its committed evidence, relative to the repository. */
  evidence: string
  /** The proposal sha256 its reservation and its evidence record. */
  proposalSha256: string
}

/** Story 2-8c7 — the live OAuth pilot run gate 8 authorizes, and every run before it, in order. */
export interface OAuthPilotRun {
  run: number
  prior: readonly OAuthPilotPriorRun[]
}

/** Where a live pilot's reservation and committed evidence live. */
export const OAUTH_PILOT_EVIDENCE_DIR = "ablation/evidence"

/**
 * Run 1's reservation. Run 1 predates run numbers, so its names carry none: a
 * migration case, listed in `OAUTH_PILOT_RUN.prior` and never renamed.
 */
export const OAUTH_PILOT_RUN_1_RESERVATION = `${OAUTH_PILOT_EVIDENCE_DIR}/oauth-pilot-live.reservation`

/** Run N's reservation, for N ≥ 2; run 1's is `OAUTH_PILOT_RUN_1_RESERVATION`. */
export function oauthPilotReservation(run: number): string {
  return run === 1 ? OAUTH_PILOT_RUN_1_RESERVATION : `${OAUTH_PILOT_EVIDENCE_DIR}/oauth-pilot-live-run-${run}.reservation`
}

/** Run N's committed evidence file name, for N ≥ 2: `oauth-pilot-live-run-N-<date>.json`. Run 1's is `oauth-pilot-live-<date>.json`. */
export function oauthPilotEvidencePattern(run: number): RegExp {
  return run === 1 ? /^oauth-pilot-live-\d{4}-\d{2}-\d{2}\.json$/ : new RegExp(`^oauth-pilot-live-run-${run}-\\d{4}-\\d{2}-\\d{2}\\.json$`)
}

/**
 * Stories 2-8c7 and 2-8c8 — the run gate 8 authorizes. Run 1 ran on 2026-09-28 and
 * failed at attempt 1; its reservation and evidence are committed under their
 * legacy names. Run 2 ran on 2026-09-29 and failed at host preflight, with no
 * attempt; its reservation and evidence are committed under run 2's names.
 */
export const OAUTH_PILOT_RUN: OAuthPilotRun = {
  run: 3,
  prior: [
    {
      run: 1,
      reservation: "ablation/evidence/oauth-pilot-live.reservation",
      evidence: "ablation/evidence/oauth-pilot-live-2026-09-28.json",
      proposalSha256: "1245e11370e7df1e9f73a9c2b356334327c315ef0d079c9bd208c275df893402",
    },
    {
      run: 2,
      reservation: "ablation/evidence/oauth-pilot-live-run-2.reservation",
      evidence: "ablation/evidence/oauth-pilot-live-run-2-2026-09-29.json",
      proposalSha256: "8bd4b660bbe0881a989a8ac75a973f4486ba06e77a3ccddb76598476dfa4dcc5",
    },
  ],
}

/** Story 2-7e — an OAuth adversarial run that already happened, and the committed files it left. */
export interface AdversarialPriorRun {
  run: number
  /** Its reservation, relative to the repository. */
  reservation: string
  /** Its committed evidence, relative to the repository. */
  evidence: string
}

/** Story 2-7e — the adversarial run gate 10 covers. */
export interface AdversarialRun {
  run: number
  /** The one-slot roster's `provider/model` pin; the first is also `small_model`. `null` until it is chosen. */
  pins: readonly string[] | null
  /** The reservation the launcher creates exclusively before it starts a host, relative to the repository. */
  reservation: string
  prior: readonly AdversarialPriorRun[]
}

/** Run N's reservation, relative to the repository. */
export function adversarialReservation(run: number): string {
  return `ablation/evidence/adversarial-oauth-run-${run}.reservation`
}

/**
 * Story 2-7e — the one OAuth adversarial run gate 10 will authorize: its run, its
 * roster pin and its reservation, with every earlier run. No run has happened.
 *
 * `pins` is `null`: protocol v3 B1 fixes the pin, and the `small_model` it
 * implies, at freeze or seal, and neither has happened. A launcher asks
 * `adversarialRunProblem` and refuses while it is `null`.
 */
export const ADVERSARIAL_RUN: AdversarialRun = {
  run: 1,
  pins: null,
  reservation: adversarialReservation(1),
  prior: [],
}

/**
 * Why `run` names no usable adversarial run, or `null`. Refused: a run whose
 * pins are not chosen, a reservation that is not the run's own, and a `prior`
 * list that is not exactly runs 1 to N-1 in order, each with its own
 * reservation and a named evidence file.
 */
export function adversarialRunProblem(run: AdversarialRun = ADVERSARIAL_RUN): string | null {
  if (!Number.isInteger(run.run) || run.run < 1) return `the adversarial run number ${JSON.stringify(run.run)} is not a whole number from 1`
  if (run.pins === null) {
    return (
      `adversarial run ${run.run} has no roster pin: \`ADVERSARIAL_RUN.pins\` is null, which means not yet chosen. The ` +
      "pin is fixed when protocol v3 is frozen or the schedule is sealed, by a reviewed change to this table"
    )
  }
  if (!Array.isArray(run.pins) || run.pins.length !== 1 || !run.pins.every((pin) => typeof pin === "string" && /^[^/\s]+\/\S+$/.test(pin))) {
    return `adversarial run ${run.run}'s pins ${JSON.stringify(run.pins)} are not exactly one \`provider/model\` pin for the one-slot roster`
  }
  if (run.reservation !== adversarialReservation(run.run)) {
    return `adversarial run ${run.run}'s reservation \`${run.reservation}\` is not \`${adversarialReservation(run.run)}\``
  }
  if (!Array.isArray(run.prior) || run.prior.length !== run.run - 1) {
    return (
      `adversarial run ${run.run} must list exactly its ${run.run - 1} earlier run(s) in \`prior\`, and it lists ` +
      `${Array.isArray(run.prior) ? run.prior.length : "no list"}`
    )
  }
  for (const [index, earlier] of run.prior.entries()) {
    const expected = index + 1
    if (earlier === null || typeof earlier !== "object" || earlier.run !== expected) {
      return `adversarial run ${run.run}'s \`prior\` entry ${expected} is not run ${expected}; the earlier runs are listed 1 to ${run.run - 1}, in order`
    }
    if (earlier.reservation !== adversarialReservation(expected)) {
      return `adversarial run ${run.run}'s \`prior\` run ${expected} names the reservation \`${earlier.reservation}\`, not \`${adversarialReservation(expected)}\``
    }
    if (typeof earlier.evidence !== "string" || earlier.evidence.trim().length === 0) {
      return `adversarial run ${run.run}'s \`prior\` run ${expected} names no evidence file`
    }
  }
  return null
}

export const PAIRED_GATES: readonly PairedGate[] = [
  {
    number: 1,
    name: "host request accounting",
    kind: "engineering",
    phase: "evaluation",
    routes: ["api-key"],
    owner: "story 2-8c2",
    status: "CLOSED",
    requires:
      "every physical provider request individually admitted and accounted, with host retries refused, on the measured " +
      "host: each request passes the stage's ledger gate and the journal's gates before it is forwarded, is settled with " +
      "the usage the provider returned for it or as unknown, and a request after a failed one in the same attempt is " +
      "refused, never forwarded",
    evidence:
      "`bun run accounting-probe` drove the measured opencode 1.18.32 host through the relay (ablation/request-meter.ts) " +
      "to the local stub, zero-bill. All eight scenarios HOLD: success, persistent 500, 429 then success, 400, hang past " +
      "the adapter timeout, host-tool step, unoffered tool, and a step refused mid-turn. Every request the stub received " +
      "had a durable `issued` line before it was forwarded and a `settled` line equal to what the stub served, or " +
      "`unknown` when it served nothing. The host's retries were refused by the relay and never reached the stub (F2). " +
      "Tool steps were admitted as step 2 and recorded in full (F3, N2). The relay closed the hung request when its " +
      "attempt ended (H1). The step refused by the journal reached nothing (S1). Attribution uses the session id the " +
      "measured host sends in `x-session-affinity` and `X-Session-Id` (A1), a fact about this build, not an opencode " +
      "contract. Any provider error status is settled unknown, which latches the journal's halt. Only one-slot discover " +
      "on block 1's prefix was driven. Evidence file: ablation/evidence/host-accounting-2026-09-24-relay.json. Tests: " +
      "ablation/request-meter.test.ts, ablation/journal.test.ts, scripts/accounting-probe.test.ts",
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
      "phase was exercised, with one slot; no concurrent or multi-slot admission was tested. Story 2-8c2's run of the " +
      "probe, with the relay between the host and the stub, showed the same three refusals. Evidence file: " +
      "ablation/evidence/host-accounting-2026-09-24-relay.json (story 2-8c's run: " +
      "ablation/evidence/host-accounting-2026-09-24.json). Tests: scripts/accounting-probe.test.ts",
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
    routes: ["oauth"],
    owner: HUMAN_BUDGET_OWNER,
    status: "OPEN",
    requires:
      "the budget owner authorizes the three paired blocks' spend on the oauth route in admitted attempts, 100 per block " +
      "and 300 in total, each an admission threshold. An admitted attempt bounds neither the physical requests the host " +
      "sends nor subscription quota: in story 2-8c3b's probe one attempt became 6 provider requests over 75 s (finding R1). " +
      "The api-key route's spend is gate 9's",
    note:
      `Run 5 was authorized on 2026-10-06 against ${EVALUATION_RUN_5_PROPOSAL.path} (sha256 ` +
      `${EVALUATION_RUN_5_PROPOSAL.sha256}) on the roster openai/gpt-6-sol, anthropic/claude-sonnet-5 and ` +
      "github-copilot/gpt-6-luna, each served by the provider it named, each paired turn offered Read, Glob, Grep and " +
      "StructuredOutput only, and is recorded in ablation/evidence/paired-oauth-evaluation-run-5-2026-10-07.json (INCOMPLETE: " +
      "no halt; block 2's ON continuation reached its 45-attempt allowance and failed with 2 findings unresolved, the other " +
      "five slots completed; 153 attempts admitted, all settled with usage; 2 of 3 paired blocks completed), with its " +
      "committed reservation at ablation/evidence/paired-oauth-evaluation-run-5.reservation. " +
      "Run 4 was authorized on 2026-10-05 against " +
      "_bmad-output/specs/spec-mad-orchestrator/stories/2-8d-run-4-proposal.md (sha256 " +
      "19b58092c03761eaa5e1b757862f248fc0a5d8b855f78e8d660a0292ecf24bea) on the roster openai/gpt-6-sol, " +
      "anthropic/claude-sonnet-5 and github-copilot/gpt-6-luna, each served by the provider it named, and is recorded in " +
      "ablation/evidence/paired-oauth-evaluation-run-4-2026-10-05.json (HALTED in block 1's ON continuation: a debate attempt " +
      "on anthropic/claude-sonnet-5 timed out at its 600000 ms deadline; 23 attempts admitted, block 1 partially observed, 0 " +
      "of 3 paired blocks completed, incomplete), with its committed reservation at " +
      "ablation/evidence/paired-oauth-evaluation-run-4.reservation. " +
      "Runs 1 to 3 used earlier authorizations of the same evaluation, all given on 2026-10-02. Runs 1 and 2 were authorized " +
      `against ${EVALUATION_RUN_PROPOSAL.path} (sha256 ${EVALUATION_RUN_PROPOSAL.sha256}) on the roster openai/gpt-6-luna, ` +
      "anthropic/claude-opus-5-5 and github-copilot/gpt-5-mini. Run 1 is recorded in " +
      "ablation/evidence/paired-oauth-evaluation-run-1-2026-10-02.json (FAILED at stage 2: `GET /config` for --directory had " +
      "no answer within 10000 ms, so no model session started and no attempt was admitted), with its committed reservation at " +
      "ablation/evidence/paired-oauth-evaluation-run-1.reservation and a later diagnosis in " +
      "ablation/evidence/paired-oauth-evaluation-run-1-diagnosis-2026-10-02.json. Run 2 is recorded in " +
      "ablation/evidence/paired-oauth-evaluation-run-2-2026-10-02.json (HALTED in block 1's ON continuation: a judge attempt " +
      "on github-copilot/gpt-5-mini timed out at its 600000 ms deadline, after anthropic/claude-opus-5-5 had dropped out on an " +
      "expired sign-in; 26 attempts admitted, block 1 partially observed, 0 of 3 paired blocks completed, incomplete), with " +
      "its committed reservation at ablation/evidence/paired-oauth-evaluation-run-2.reservation. Run 3 was authorized against " +
      "_bmad-output/specs/spec-mad-orchestrator/stories/2-8d-run-3-proposal.md (sha256 " +
      "150dfff1df365d2115115aee57c3d3ccede50af13114f52973931cb057f43a40) on the roster openai/gpt-6-sol, " +
      "anthropic/claude-opus-5-5 and github-copilot/gpt-6-luna, and is recorded in " +
      "ablation/evidence/paired-oauth-evaluation-run-3-2026-10-02.json (CANCELLED by the human in block 1's shared prefix: the " +
      "pin github-copilot/gpt-6-luna had filled its slot through openai; anthropic/claude-opus-5-5 refused the forced tool " +
      "choice; 6 attempts admitted, no continuation started, incomplete), with its committed reservation at " +
      "ablation/evidence/paired-oauth-evaluation-run-3.reservation. All five authorizations are spent; no further live run is " +
      "authorized"
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
  {
    number: 7,
    name: "OAuth attempt accounting",
    kind: "engineering",
    phase: "evaluation",
    routes: ["oauth"],
    owner: "story 2-8c3b",
    status: "CLOSED",
    requires:
      "story 2-8c3b's zero-bill OAuth probe evidence: the host starts with the roster's OAuth providers and lists them, " +
      "every attempt is journaled before it is issued and counted once, a refused attempt reaches nothing, and an " +
      "attempt that does not end within its bound is stopped and recorded. OpenAI's OAuth transport is covered, or the " +
      "gate is closed only by a separately human-authorized bounded pilot whose evidence is reviewed before story 2-8d " +
      "starts. Never closed from the paid paired evaluation",
    evidence:
      "OpenAI's OAuth transport is covered by the human-authorized bounded pilot's run 3 " +
      "(ablation/evidence/oauth-pilot-live-run-3-2026-09-30.json), reviewed by the review channel on 2026-09-30: on the measured " +
      "opencode 1.18.32 host, which listed OpenAI, two admitted attempts to openai/gpt-6-luna each have one journal `issued` line " +
      "before the backend call and one `settled` line, returned an answer within 120 s and settled usage; the third admission was " +
      "refused inside the journal with 0 backend calls and no new `issued` line. The zero-bill OAuth probe " +
      "(ablation/evidence/oauth-attempts-2026-09-25.json) covers Anthropic and Copilot, a seeded refusal that reached nothing, and " +
      "an attempt past its turn deadline that was stopped, settled unknown and abandoned, and latched a halt. Scope: this build, " +
      "the OAuth route and the pilot's one-slot discover attempts. Admitted attempts are counted; physical provider requests, host " +
      "retries, side requests, host-reported tokens and subscription quota are neither established nor bounded by the attempt " +
      "count. One chatgpt.com:443 CONNECT was tunnelled, during attempt 1; a reused tunnel cannot count requests for either " +
      "attempt. Two refused api.githubcopilot.com:443 startup CONNECTs came before the first admission was asked, so not every " +
      "proxy-observed connection followed an `issued` line; no allowed-host CONNECT was observed before the first admission or " +
      "after the last settlement. The proxy log and the zero sandbox denials reported are not a complete egress census. " +
      "Tests: ablation/paired-gates.test.ts, scripts/oauth-pilot.test.ts, scripts/oauth-probe.test.ts",
    note:
      "Limits carried to story 2-8d: the store guard held its guarded tables at 0 before and after the pilot, but opencode's " +
      "logs, `project` and `event` rows and six unguarded session-capable tables (session_message, session_entry, session_input, " +
      "todo, session_share, workspace) can persist in the OAuth data directory across runs, and their effect on comparison is " +
      "unmeasured. The pilot's sandbox does not show production egress control: the runtime code-fetch risk stays open on an " +
      "unsandboxed launch. Earlier runs: run 1 (ablation/evidence/oauth-pilot-live-2026-09-28.json) stopped at attempt 1 on a " +
      "token-refresh 401 (ablation/evidence/oauth-pilot-diagnosis-2026-09-28.json); run 2 " +
      "(ablation/evidence/oauth-pilot-live-run-2-2026-09-29.json) was refused at host preflight with no attempt",
  },
  {
    number: 8,
    name: "OAuth pilot spend authorization",
    kind: "authorization",
    phase: "oauth-pilot",
    routes: ["oauth"],
    owner: HUMAN_BUDGET_OWNER,
    status: "OPEN",
    requires:
      `the budget owner authorizes run ${OAUTH_PILOT_RUN.run} (\`OAUTH_PILOT_RUN\`, stories 2-8c7 and 2-8c8) of story 2-8c5's \`bun run oauth-pilot --live\`: ` +
      "at most 2 admitted attempts to openai/gpt-6-luna through the ChatGPT OAuth sign-in, with the exposure stated in " +
      `${OAUTH_PILOT_PROPOSAL.path} (sha256 ${OAUTH_PILOT_PROPOSAL.sha256}; \`--live\` refuses if the file differs). One run only: ` +
      "before the reservation, `--live` checks the managed host's binary hash and prepared digests, refusing with the authorization unused on a mismatch; it then " +
      `creates ${oauthPilotReservation(OAUTH_PILOT_RUN.run)} exclusively before it starts a host or touches the auth target, the data ` +
      "directory or the network, and refuses while it exists, while an earlier run's committed reservation or evidence is missing, " +
      "changed or malformed, or while any other oauth-pilot-live* file is committed, untracked or in ablation/evidence; nothing " +
      "deletes it, and the budget owner re-opens this gate after the run. An admitted attempt bounds neither the physical requests " +
      "the host sends nor subscription quota. Closing it never stands in for gate 4 or closes gate 7",
    note:
      "The budget owner authorized run 1 on 2026-09-28. It is recorded in ablation/evidence/oauth-pilot-live-2026-09-28.json " +
      "(FAILED: attempt 1 returned model-error without an answer and no further attempt ran), with its committed reservation at " +
      "ablation/evidence/oauth-pilot-live.reservation; a later non-billing inspection of the host database WAL found a token-refresh " +
      "401 for that attempt (ablation/evidence/oauth-pilot-diagnosis-2026-09-28.json). That authorization is spent. The budget " +
      "owner authorized run 2 on 2026-09-29. It is recorded in ablation/evidence/oauth-pilot-live-run-2-2026-09-29.json (FAILED at " +
      "host preflight: the installed opencode binary was not the measured build, so no host started and no attempt was admitted), " +
      "with its committed reservation at ablation/evidence/oauth-pilot-live-run-2.reservation. That authorization is spent too. " +
      "The budget owner authorized run 3 on 2026-09-30. It is recorded in ablation/evidence/oauth-pilot-live-run-3-2026-09-30.json " +
      "(both attempts answered and settled usage; the third admission was refused inside the journal with 0 backend calls), with " +
      "its committed reservation at ablation/evidence/oauth-pilot-live-run-3.reservation. That authorization is spent; no further " +
      "live run is authorized",
  },
  {
    number: 9,
    name: "api-key evaluation spend authorization",
    kind: "authorization",
    phase: "evaluation",
    routes: ["api-key"],
    owner: HUMAN_BUDGET_OWNER,
    status: "OPEN",
    requires:
      "the budget owner authorizes the three paired blocks' spend on the api-key route in ledger tokens: the three blocks' " +
      "token spend under PAIRED_ALLOWANCES, unchanged. Closing gate 4, which covers only the oauth route, never stands in for it",
  },
  {
    number: 10,
    name: "adversarial spend authorization",
    kind: "authorization",
    phase: "adversarial",
    routes: ["oauth"],
    owner: HUMAN_BUDGET_OWNER,
    status: "OPEN",
    requires:
      `the budget owner authorizes run ${ADVERSARIAL_RUN.run} (\`ADVERSARIAL_RUN\`) of the sixteen adversarial runs on the oauth ` +
      "route in admitted attempts under a frozen protocol v3: 30 per run, 480 for the suite and 480 for the suite's own root, " +
      "each an admission threshold and not a proven-adequate budget. An admitted attempt bounds neither the physical requests " +
      "the host sends nor subscription quota. Closing gate 4 or gate 8 never stands in for it",
  },
  {
    number: 11,
    name: "adversarial attempt accounting",
    kind: "engineering",
    phase: "adversarial",
    routes: ["oauth"],
    owner: "story 2-7f2",
    status: "OPEN",
    requires:
      "story 2-7f2's zero-bill probe evidence on a real host, on the adversarial path: every attempt is journaled in the " +
      "suite's own root before it is issued and counted once, an admission refused on the run, suite or root allowance " +
      "reaches no backend, an attempt that does not end within its bound is settled, stopped and recorded, and an integrity " +
      "failure halts. Paired and pilot evidence is reused only within its measured scope",
  },
  {
    number: 12,
    name: "bounded materializer termination",
    kind: "engineering",
    phase: "adversarial",
    routes: ["oauth"],
    owner: "story 2-7e2",
    status: "CLOSED",
    requires:
      "the git calls that write each adversarial worktree (ablation/adversarial-materialize.ts) end within a bound: a call " +
      "past its deadline is sent SIGKILL with no graceful period, its termination is confirmed or reported as unconfirmed, a " +
      "descendant holding a pipe cannot stop the call returning, and a synthesized status is told apart from one git returned",
    evidence:
      "story 2-7e2, accepted by the review channel on 2026-10-09 at commit 9166c42: every production git call in " +
      "ablation/adversarial-materialize.ts goes through `boundedGit()` over `runBoundedBlame` " +
      "(adapters/opencode/blame-exec.ts). If the call has not completed when its nominal 60,000 ms event-loop deadline fires, " +
      "the launcher attempts SIGKILL with no graceful period and uses a separate nominal 5,000 ms cleanup budget; a failed " +
      "signal delivery is reported. Termination is confirmed only when the direct child is accounted for and both its pipes " +
      "reach EOF; a descendant that closed the inherited pipes is not observed, and no process group is killed. A call that " +
      "did not return is a `GitNotReturned` with `exitCode: null` and termination `not-started`, `confirmed` or " +
      "`unconfirmed`; no status is synthesized. An `unconfirmed` call sets `terminationUnconfirmed`, and the runner " +
      "quarantines the suite and retains the lock in both accounting modes. Budgets are validated under the materializer's " +
      "own names before anything is launched. Scope: local tests over `sh` stand-in processes (a hang, a child that traps " +
      "SIGTERM, a descendant holding a pipe, a kill that could not be sent, a refused launch, an unusable budget) and real " +
      "git writing every case and side; no real host and no hung real git. The code is route-neutral and this gate covers the " +
      "oauth route only; nothing here says api-key materialization is safe. Tests: ablation/adversarial-materialize.test.ts, " +
      "ablation/adversarial.test.ts",
    note:
      "Not covered: cancellation during materialization does not interrupt it; the runner observes it only after " +
      "`materializeSide` returns. Each git call has nominal event-loop budgets of 60,000 ms for execution and 5,000 ms for " +
      "cleanup. Materialization may finish its remaining git steps (five in total) and filesystem operations before " +
      "returning; no cancellation-response or guaranteed wall-clock bound is established",
  },
]

/**
 * Story 2-7e — a prerequisite of the sixteen adversarial runs that may turn out
 * not to be a gate, recorded before anyone has shown that it is not.
 *
 * `OPEN` means unresolved: it blocks. `NON-GATING` means the named story
 * validated the claim on the complete launcher path and recorded its evidence.
 * The claim is only ever that a code path is not reached by one launcher and one
 * configuration. It is never a statement about that code path's own behaviour.
 */
export interface CandidateNonGate {
  /** The prerequisite's number in `LIVE-RUN.md`, "Before the sixteen live runs". */
  item: number
  name: string
  status: "OPEN" | "NON-GATING"
  /** The story that must validate the claim before the status may change. */
  validatedBy: string
  /** What would be recorded, worded as reach and nothing more. */
  claim: string
  /** What is known today, and what is not. */
  basis: string
  /** Present exactly when the status is `NON-GATING`: the validation, and the tests that check it. */
  evidence?: string
  reopensWhen: string
}

/** The wording every candidate claim carries. */
export const CANDIDATE_CLAIM_WORDING = "not reached by this launcher and configuration"

/** The prerequisite items the adversarial phase needs a candidate record for. */
export const ADVERSARIAL_CANDIDATE_ITEMS: readonly number[] = [7]

export const ADVERSARIAL_CANDIDATE_NON_GATES: readonly CandidateNonGate[] = [
  {
    item: 7,
    name: "review-path reads (`adapters/opencode/repo.ts`)",
    status: "NON-GATING",
    validatedBy: "story 2-7f",
    claim: `the reads of the change through the host shell in \`adapters/opencode/repo.ts\` are ${CANDIDATE_CLAIM_WORDING}`,
    basis:
      "`bun run adversarial` (scripts/adversarial.ts) hands `runAdversarialSuite` the sealed material, and the suite hands " +
      "`review()` each case's side of it; every run's backend is an `OpencodeModelBackend` against that run's managed host " +
      "and its Tools port is `opencodeTools`. Nothing is said about the reads in repo.ts themselves, wherever else they " +
      "are reached",
    evidence:
      "story 2-7f's source and tests, on stand-in hosts and a scripted backend; no real host was run. A scan in " +
      "scripts/adversarial.test.ts reads every file in the import closure of scripts/adversarial.ts (the launcher, the " +
      "scripts/paired.ts helpers it imports, its host lifecycle, roster verification and callbacks, ablation/managed-host.ts " +
      "and ablation/adversarial*.ts, every static and dynamic relative import followed and every package specifier listed) " +
      "with comments and string, template and regular-expression literals removed. It finds the name `opencodeRepo` or the " +
      "call `repo.change(` in exactly two files, the two exceptions: adapters/opencode/repo.ts, which defines `opencodeRepo` " +
      "and `repo.change`, and adapters/opencode/plugin.ts, which calls them only inside the `mad_review` tool's `execute` " +
      "handler, not at module top level. A second scan reads the launcher, the paired helpers, the lifecycle and host " +
      "modules and every ablation/adversarial*.ts with comments included, and finds neither. The closure walk enumerates " +
      "the importers of repo.ts: plugin.ts, reached only through scripts/paired.ts's import of `DEFAULT_DISCOVERY_SLOTS`, " +
      "and adapters/opencode/tools.ts, which takes `GitError` alone. repo.ts and plugin.ts stay in the closure; the claim " +
      `is that the reads are ${CANDIDATE_CLAIM_WORDING}, and nothing more. Tests: scripts/adversarial.test.ts`,
    reopensWhen:
      "the launcher, its factories or `runAdversarialSuite` ever read the reviewed change through `opencodeRepo` or `repo.change()`",
  },
]

/** The words a candidate record never uses: each would claim something about the code path itself. */
const CANDIDATE_FORBIDDEN_WORDS = /\b(?:un)?bounded\b|\bfixed\b|\bchecked\b/i

/**
 * Why a candidate record does not let the adversarial phase proceed; empty when
 * it does. Every required item must be present exactly once, well formed, and
 * resolved `NON-GATING` with evidence.
 */
export function candidateRecordProblems(record: readonly CandidateNonGate[] | undefined | null): string[] {
  if (!Array.isArray(record)) return ["the candidate non-gate record is absent, so prerequisite 7 is unresolved"]
  const problems: string[] = []
  for (const item of ADVERSARIAL_CANDIDATE_ITEMS) {
    const found = record.filter((entry) => entry !== null && typeof entry === "object" && entry.item === item)
    if (found.length === 0) problems.push(`the candidate non-gate record holds no entry for prerequisite ${item}, so it is unresolved`)
    if (found.length > 1) problems.push(`the candidate non-gate record holds ${found.length} entries for prerequisite ${item}`)
  }
  for (const entry of record) {
    if (entry === null || typeof entry !== "object") {
      problems.push("the candidate non-gate record holds an entry that is not an object")
      continue
    }
    const label = `candidate non-gate ${JSON.stringify(entry.item)} (${typeof entry.name === "string" ? entry.name : "unnamed"})`
    const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
    if (!ADVERSARIAL_CANDIDATE_ITEMS.includes(entry.item)) problems.push(`${label} names a prerequisite the adversarial phase has no candidate for`)
    if (!text(entry.name) || !text(entry.validatedBy) || !text(entry.claim) || !text(entry.basis) || !text(entry.reopensWhen)) {
      problems.push(`${label} is malformed: it needs a name, a validating story, a claim, a basis and a reopening condition`)
      continue
    }
    if (!entry.claim.includes(CANDIDATE_CLAIM_WORDING)) problems.push(`${label} is malformed: its claim does not say "${CANDIDATE_CLAIM_WORDING}"`)
    const said = [entry.name, entry.claim, entry.basis, entry.reopensWhen, entry.evidence ?? ""].join(" ")
    const forbidden = CANDIDATE_FORBIDDEN_WORDS.exec(said)
    if (forbidden !== null) {
      problems.push(`${label} is malformed: it says "${forbidden[0]}", which claims something about the code path rather than its reach`)
    }
    if (entry.status !== "OPEN" && entry.status !== "NON-GATING") {
      problems.push(`${label} has status ${JSON.stringify(entry.status)}, which is neither OPEN nor NON-GATING`)
      continue
    }
    if (entry.status === "OPEN") {
      if (entry.evidence !== undefined) problems.push(`${label} is OPEN but carries evidence; a record with evidence must say NON-GATING, and one without it OPEN`)
      problems.push(`${label} is OPEN: ${entry.validatedBy} has not validated that it is ${CANDIDATE_CLAIM_WORDING}, so it blocks`)
    } else if (!text(entry.evidence)) {
      problems.push(`${label} is NON-GATING with no evidence recorded, so it is not resolved`)
    }
  }
  return problems
}

/**
 * The refusals of the canonical candidate record and of a supplied one. The
 * canonical record's refusals are always kept: a supplied record can add a
 * refusal and can never remove one. `gatePreflight` passes
 * `ADVERSARIAL_CANDIDATE_NON_GATES` as `canonical`; the parameter exists so that
 * property can be shown for a canonical record that is OPEN.
 */
export function candidateProblems(
  canonical: readonly CandidateNonGate[] | null | undefined,
  supplied?: readonly CandidateNonGate[] | null,
): string[] {
  const records: (readonly CandidateNonGate[] | null | undefined)[] = [canonical]
  // `undefined` is "none supplied". A supplied `null` or empty list is a record, and an unresolved one.
  if (supplied !== undefined && supplied !== canonical) records.push(supplied)
  return [...new Set(records.flatMap((record) => candidateRecordProblems(record)))]
}

export const PAIRED_NON_GATES: readonly CheckedNonGate[] = [
  {
    name: "bounded review-path reads (`adapters/opencode/repo.ts`)",
    evidence:
      "a source scan in scripts/paired.test.ts finds no `opencodeRepo` and no `repo.change()` call (it looks for " +
      "`repo.change(`) in scripts/paired.ts, " +
      "ablation/paired.ts or ablation/schedule.ts; the launcher hands `SEEDED_CHANGE` to `createSchedule` and " +
      "`runPairedBlocks`. repo.ts is still in the launcher's import closure, through `DEFAULT_DISCOVERY_SLOTS` from " +
      "adapters/opencode/plugin.ts, whose tool handler is the one caller of `opencodeRepo`, and through `GitError` " +
      "from adapters/opencode/tools.ts; a second test walks that closure and finds plugin.ts and tools.ts its only " +
      "importers, taking those two names alone",
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
 * Check the gates required for `phase` on `route`. A gate for another phase, or
 * naming only other routes, is printed and never consulted. A table that is not
 * well formed refuses: an unknown kind, phase, route or status, a CLOSED gate with
 * no evidence, an OPEN gate carrying evidence, a duplicate or non-positive number,
 * a note that is not one non-empty line, an authorization gate that the human
 * budget owner does not own, or no authorization gate for the phase and route (a
 * table that cannot say who authorized the spend authorizes nothing).
 *
 * FAIL CLOSED ON ROUTES. A `route` that is neither api-key nor oauth is a
 * problem, and then every route-scoped gate is consulted rather than skipped. A
 * gate's `routes` that is not a non-empty list of known routes is a problem too,
 * and that gate is consulted: a malformed value never decides coverage.
 *
 * THE ADVERSARIAL PHASE ALSO NEEDS ITS RUN NAMED AND ITS CANDIDATE RECORD
 * RESOLVED (story 2-7e). `adversarialRunProblem()` is reported for `run`,
 * `ADVERSARIAL_RUN` unless a caller supplies another (as the launcher's test
 * seam does, beside its `gates`), so the phase cannot pass while its pins are
 * not chosen.
 * `ADVERSARIAL_CANDIDATE_NON_GATES` is consulted on every call for that phase,
 * and `candidates`, when a caller supplies one, is checked as well: it can add a
 * refusal and can never remove the canonical record's. Every other phase ignores
 * both, and its result does not depend on them.
 */
export function gatePreflight(
  gates: readonly PairedGate[],
  phase: GatePhase,
  route: GateRoute,
  candidates?: readonly CandidateNonGate[] | null,
  run: AdversarialRun = ADVERSARIAL_RUN,
): GatePreflight {
  const lines: string[] = []
  const problems: string[] = []
  const seen = new Set<number>()
  const knownRoute = GATE_ROUTES.includes(route)
  if (!knownRoute) {
    problems.push(`the route ${JSON.stringify(route)} is neither api-key nor oauth, so every route-scoped gate is consulted`)
  }
  const wellFormedRoutes = (gate: PairedGate): boolean =>
    gate.routes === undefined ||
    (Array.isArray(gate.routes) &&
      gate.routes.length > 0 &&
      gate.routes.every((entry: unknown) => typeof entry === "string" && GATE_ROUTES.includes(entry as GateRoute)))
  const covers = (gate: PairedGate): boolean =>
    gate.routes === undefined || !knownRoute || !wellFormedRoutes(gate) || gate.routes.includes(route)
  for (const gate of gates) {
    const onRoute = covers(gate)
    const required = gate.phase === phase && onRoute
    const evidence = gate.status === "CLOSED" ? ` — evidence: ${gate.evidence ?? "NONE RECORDED"}` : ""
    const note = gate.note === undefined ? "" : ` — note: ${gate.note}`
    const routes =
      gate.routes === undefined ? "" : wellFormedRoutes(gate) ? ` on route ${gate.routes.join(", ")}` : ` on routes ${JSON.stringify(gate.routes)}`
    const skipped = gate.phase !== phase ? ` (not consulted for ${phase})` : onRoute ? "" : ` (not consulted for route ${route})`
    lines.push(
      `gate ${gate.number} — ${gate.name} — ${gate.kind}, required for ${gate.phase}${routes}` +
        `${skipped}, owner ${gate.owner} — ${gate.status}${evidence}${note}`,
    )
    if (gate.kind !== "engineering" && gate.kind !== "authorization") {
      problems.push(`gate ${gate.number} (${gate.name}) has kind ${JSON.stringify(gate.kind)}, which is neither engineering nor authorization`)
    }
    if (!GATE_PHASES.includes(gate.phase)) {
      problems.push(`gate ${gate.number} (${gate.name}) has phase ${JSON.stringify(gate.phase)}, which is not accounting-probe, oauth-pilot, evaluation or adversarial`)
    }
    if (!wellFormedRoutes(gate)) {
      problems.push(`gate ${gate.number} (${gate.name}) has routes ${JSON.stringify(gate.routes)}, which are not a non-empty list of api-key and oauth`)
    }
    if (gate.status !== "OPEN" && gate.status !== "CLOSED") {
      problems.push(`gate ${gate.number} (${gate.name}) has status ${JSON.stringify(gate.status)}, which is neither OPEN nor CLOSED`)
    }
    if (gate.kind === "authorization" && gate.owner !== HUMAN_BUDGET_OWNER) {
      problems.push(`gate ${gate.number} (${gate.name}) is an authorization gate owned by ${gate.owner}; only ${HUMAN_BUDGET_OWNER} owns an authorization`)
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
  if (!gates.some((gate) => gate.phase === phase && gate.kind === "authorization" && covers(gate))) {
    problems.push(`the table holds no authorization gate for ${phase} on route ${route}, so nothing authorizes its spend`)
  }
  if (phase === "adversarial") {
    const runProblem = adversarialRunProblem(run)
    lines.push(`adversarial run ${run.run} — pins ${run.pins === null ? "not yet chosen" : run.pins.join(", ")}`)
    if (runProblem !== null) problems.push(runProblem)
    for (const entry of ADVERSARIAL_CANDIDATE_NON_GATES) {
      lines.push(`candidate non-gate ${entry.item} — ${entry.name} — validated by ${entry.validatedBy} — ${entry.status}`)
    }
    for (const problem of candidateProblems(ADVERSARIAL_CANDIDATE_NON_GATES, candidates)) {
      if (!problems.includes(problem)) problems.push(problem)
    }
  }
  return { ok: problems.length === 0, lines, problems }
}
