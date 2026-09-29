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
 * ## Three phases, and no probe or pilot exception
 *
 * Each gate names the phase it is required for: `accounting-probe` (story 2-8c's
 * bounded, authorized probe), `oauth-pilot` (story 2-8c5's bounded OpenAI OAuth
 * pilot, `bun run oauth-pilot --live`) or `evaluation` (the three blocks). The
 * launcher asks `gatePreflight(PAIRED_GATES, "evaluation", route)` for the route
 * its `--provider-mode` selects, `api-key` by default; the pilot asks
 * `gatePreflight(PAIRED_GATES, "oauth-pilot", "oauth")`. A gate required only for
 * the probe or the pilot is printed and never consulted for the evaluation, so
 * closing it can never stand in for an evaluation gate.
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
 * Gates 3, 4 and 8 are spend authorizations owned by the human who owns the budget.
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
export type GatePhase = "accounting-probe" | "oauth-pilot" | "evaluation"
export const GATE_PHASES: readonly GatePhase[] = ["accounting-probe", "oauth-pilot", "evaluation"]
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
  sha256: "8bd4b660bbe0881a989a8ac75a973f4486ba06e77a3ccddb76598476dfa4dcc5",
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
 * Story 2-8c7 — the run gate 8 authorizes. Run 1 ran on 2026-09-28 and failed at
 * attempt 1; its reservation and evidence are committed under their legacy names.
 */
export const OAUTH_PILOT_RUN: OAuthPilotRun = {
  run: 2,
  prior: [
    {
      run: 1,
      reservation: "ablation/evidence/oauth-pilot-live.reservation",
      evidence: "ablation/evidence/oauth-pilot-live-2026-09-28.json",
      proposalSha256: "1245e11370e7df1e9f73a9c2b356334327c315ef0d079c9bd208c275df893402",
    },
  ],
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
    owner: HUMAN_BUDGET_OWNER,
    status: "OPEN",
    requires:
      "the budget owner authorizes the three paired blocks' spend: on the api-key route in ledger tokens, the three " +
      "blocks' token spend under PAIRED_ALLOWANCES, unchanged; on the oauth route in admitted attempts, 100 per block " +
      "and 300 in total, each an admission threshold. An admitted attempt bounds neither the physical requests the host " +
      "sends nor subscription quota: in story 2-8c3b's probe one attempt became 6 provider requests over 75 s (finding R1)",
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
    status: "OPEN",
    requires:
      "story 2-8c3b's zero-bill OAuth probe evidence: the host starts with the roster's OAuth providers and lists them, " +
      "every attempt is journaled before it is issued and counted once, a refused attempt reaches nothing, and an " +
      "attempt that does not end within its bound is stopped and recorded. OpenAI's OAuth transport is covered, or the " +
      "gate is closed only by a separately human-authorized bounded pilot whose evidence is reviewed before story 2-8d " +
      "starts. Never closed from the paid paired evaluation",
    note:
      "The zero-bill OAuth probe (ablation/evidence/oauth-attempts-2026-09-25.json) covered Anthropic and Copilot but left " +
      "OpenAI unprobed. The authorized live pilot (ablation/evidence/oauth-pilot-live-2026-09-28.json) stopped after one " +
      "journaled attempt returned model-error without an answer; no chatgpt.com CONNECT was proxy-observed, the second " +
      "attempt did not run, and the third admission was not asked. A later non-billing inspection of the host database WAL " +
      "found `UnknownError: Token refresh failed: 401` for that attempt; no chatgpt.com CONNECT was proxy-observed " +
      "(ablation/evidence/oauth-pilot-diagnosis-2026-09-28.json). OpenAI attempt accounting is not established, so this " +
      "gate stays OPEN",
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
      `the budget owner authorizes run ${OAUTH_PILOT_RUN.run} (\`OAUTH_PILOT_RUN\`, story 2-8c7) of story 2-8c5's \`bun run oauth-pilot --live\`: ` +
      "at most 2 admitted attempts to openai/gpt-6-luna through the ChatGPT OAuth sign-in, with the exposure stated in " +
      `${OAUTH_PILOT_PROPOSAL.path} (sha256 ${OAUTH_PILOT_PROPOSAL.sha256}; \`--live\` refuses if the file differs). One run only: ` +
      `\`--live\` creates ${oauthPilotReservation(OAUTH_PILOT_RUN.run)} exclusively before it touches a host, the auth target, the data ` +
      "directory or the network, and refuses while it exists, while an earlier run's committed reservation or evidence is missing, " +
      "changed or malformed, or while any other oauth-pilot-live* file is committed, untracked or in ablation/evidence; nothing " +
      "deletes it, and the budget owner re-opens this gate after the run. An admitted attempt bounds neither the physical requests " +
      "the host sends nor subscription quota. Closing it never stands in for gate 4 or closes gate 7",
    note:
      "The budget owner authorized run 1 on 2026-09-28. It is recorded in ablation/evidence/oauth-pilot-live-2026-09-28.json " +
      "(FAILED: attempt 1 returned model-error without an answer and no further attempt ran), with its committed reservation at " +
      "ablation/evidence/oauth-pilot-live.reservation; a later non-billing inspection of the host database WAL found a token-refresh " +
      "401 for that attempt (ablation/evidence/oauth-pilot-diagnosis-2026-09-28.json). That authorization is spent. Run 2 is not " +
      "authorized while this gate is OPEN",
  },
]

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
 */
export function gatePreflight(gates: readonly PairedGate[], phase: GatePhase, route: GateRoute): GatePreflight {
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
      problems.push(`gate ${gate.number} (${gate.name}) has phase ${JSON.stringify(gate.phase)}, which is not accounting-probe, oauth-pilot or evaluation`)
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
  return { ok: problems.length === 0, lines, problems }
}
