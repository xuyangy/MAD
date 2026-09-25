import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { emptyLedger, emptyTokenUsage, type RunRecord, type TokenUsage } from "../core/domain/run-record.ts"
import type { Warning } from "../core/domain/warning.ts"
import { selectRoster } from "../core/roster/select.ts"
import { FakeBackend, candidate, fakeChange, fakeClock } from "../core/test-support/fakes.ts"
import { runAblation, type ArmRun } from "./arms.ts"
import { EvaluationBundleError } from "./bundle.ts"
import {
  ATTEMPT_ALLOWANCES,
  HALT_MARKER_FILE,
  PAIRED_ALLOWANCES,
  createExperimentGovernor,
  governorStateFromBill,
  requestGate,
  type RequestGateView,
} from "./governor.ts"
import { acquireLock, openJournal } from "./journal.ts"
import { mayISpend, type BudgetLedger } from "../core/budget/ledger.ts"
import type { Finding } from "../core/domain/finding.ts"
import { recordTurn } from "../core/domain/run-record.ts"
import { debate } from "../core/stages/debate.ts"
import { judge } from "../core/stages/judge.ts"

/**
 * THE TEMP DIRECTORY IS OUTSIDE THE REPOSITORY, exactly as `bundle.test.ts`
 * requires of itself: this suite writes and deletes a halt marker, and a test
 * that wrote one into the worktree would be a test that can leave the tool
 * refusing to bill after it has finished running.
 */
const scratch: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

afterEach(async () => {
  while (scratch.length > 0) {
    await rm(scratch.pop()!, { recursive: true, force: true })
  }
})

function record(runId: string, over: Partial<RunRecord> = {}): RunRecord {
  const resolved = selectRoster([candidate("anthropic", "claude-sonnet-4-5")], {
    slots: 1,
    providerConfigKey: "provider",
  })
  return {
    runId,
    startedAt: "2026-09-11T00:00:00.000Z",
    finishedAt: "2026-09-11T00:00:01.000Z",
    roster: resolved.roster,
    answered: 1,
    findings: [],
    pool: [],
    lensInstructions: [],
    threshold: 0.5,
    maxRounds: 3,
    warnings: resolved.warnings,
    ledger: emptyLedger(),
    ...over,
  }
}

function spending(tokens: Partial<TokenUsage>): RunRecord["ledger"] {
  const total = { ...emptyTokenUsage(), ...tokens }
  return {
    ...emptyLedger(),
    entries: [{ slot: "discovery-1", stage: "discover", attempt: 1, tokens: total }],
    total,
  }
}

function armRun(armId: string, repeat: number, run: RunRecord): ArmRun {
  return {
    spec: { id: armId, label: `arm ${armId}`, provenance: "live", slots: 1 },
    repeat,
    record: run,
    rendered: `MAD review — run ${run.runId}\n`,
    backend: new FakeBackend({}),
  }
}

const unknown = (executionId: string, why: string) => ({
  slot: "discovery-1",
  stage: "discover",
  attempt: 1,
  executionId,
  why,
})

describe("AC4 — an experiment with nothing to hide keeps admitting", () => {
  test("a fresh governor over an empty bundle root admits", async () => {
    const root = await tempDir("mad-governor-")
    const governor = createExperimentGovernor({ bundleRoot: root })
    expect(await governor.admit()).toEqual({ ok: true })
    const state = governor.state()
    expect(state.halted).toBe(false)
    expect(state.exposure).toBe("quantified")
    expect(state.unknownUsageCount).toBe(0)
  })

  test("known spend accumulates across observed arms, and nothing halts", async () => {
    const root = await tempDir("mad-governor-")
    const governor = createExperimentGovernor({ bundleRoot: root })
    await governor.admit()
    await governor.observe(armRun("control", 0, record("run-1", { ledger: spending({ input: 10, output: 5 }) })))
    await governor.admit()
    await governor.observe(armRun("pool", 0, record("run-2", { ledger: spending({ input: 20, output: 1 }) })))

    const state = governor.state()
    expect(state.knownSpend).toEqual({ ...emptyTokenUsage(), input: 30, output: 6 })
    expect(state.knownSpendTokens).toBe(36)
    expect(state.observedRuns).toBe(2)
    expect(state.halted).toBe(false)
    expect(await governor.admit()).toEqual({ ok: true })
  })

  test("in flight is what was admitted and has not reported back", async () => {
    const root = await tempDir("mad-governor-")
    const governor = createExperimentGovernor({ bundleRoot: root })
    await governor.admit()
    await governor.admit()
    expect(governor.state().inFlight).toBe(2)
    await governor.observe(armRun("control", 0, record("run-1")))
    expect(governor.state().inFlight).toBe(1)
  })

  test("the surface is three functions — it gates arms and answers nothing else", async () => {
    const root = await tempDir("mad-governor-")
    const governor = createExperimentGovernor({ bundleRoot: root })
    // `mayISpend` is `core/budget/ledger.ts`'s and stays there (AD-15). A
    // governor that grew a per-turn answer would be the second authority on one
    // question that AD-15's single accountant exists to prevent, so the surface
    // is pinned rather than described.
    expect(Object.keys(governor).sort()).toEqual(["admit", "observe", "state"])
  })
})

describe("AC4 — one unknown usage halts admission experiment-wide", () => {
  test("the halt refuses the next arm, names the identities, and labels the exposure", async () => {
    const root = await tempDir("mad-governor-")
    const governor = createExperimentGovernor({ bundleRoot: root })
    await governor.admit()
    const entry = unknown("exec-3", "the host settled the turn and reported no tokens")
    const ledger = { ...spending({ input: 10 }), unknownUsage: [entry] }
    await governor.observe(armRun("pool", 1, record("run-9", { ledger })))

    const state = governor.state()
    expect(state.halted).toBe(true)
    expect(state.exposure).toBe("unquantified")
    expect(state.unknownUsageCount).toBe(1)
    expect(state.unknownUsage).toEqual([{ armId: "pool", repeatId: 1, runId: "run-9", entry }])
    // The known spend is still reported. A halt does not delete what MAD did
    // count — the protocol asks for both, side by side.
    expect(state.knownSpendTokens).toBe(10)

    const admission = await governor.admit()
    expect(admission.ok).toBe(false)
    expect(admission.ok === false && admission.reason).toContain("exec-3")
    // Refused arms are not in flight: nothing was admitted.
    expect(governor.state().inFlight).toBe(0)
  })

  test("two arms can mint the same executionId, so the identity carries the arm", async () => {
    const root = await tempDir("mad-governor-")
    const governor = createExperimentGovernor({ bundleRoot: root })
    const entry = unknown("exec-1", "cancelled in flight")
    await governor.observe(
      armRun("control", 0, record("run-a", { ledger: { ...emptyLedger(), unknownUsage: [entry] } })),
    )
    await governor.observe(
      armRun("pool", 0, record("run-b", { ledger: { ...emptyLedger(), unknownUsage: [entry] } })),
    )
    expect(governor.state().unknownUsage).toEqual([
      { armId: "control", repeatId: 0, runId: "run-a", entry },
      { armId: "pool", repeatId: 0, runId: "run-b", entry },
    ])
    expect(governor.state().unknownUsageCount).toBe(2)
  })

  test("a record carrying NO unknown-usage collection halts too — unauditable is not clean", async () => {
    const root = await tempDir("mad-governor-")
    const governor = createExperimentGovernor({ bundleRoot: root })
    const legacy = { ...emptyLedger() } as Record<string, unknown>
    delete legacy.unknownUsage
    await governor.observe(armRun("control", 0, record("run-legacy", { ledger: legacy as never })))
    const state = governor.state()
    expect(state.halted).toBe(true)
    expect(state.exposure).toBe("unquantified")
    expect(state.haltReason).toContain("run-legacy")
  })

  test("a record carrying NO readable spend total halts too, rather than throwing", async () => {
    // ADDED AT THE WAVE-5 REVIEW (2026-09-11). `observe` guarded the SAME
    // untrusted record's `unknownUsage` with `Array.isArray` while summing its
    // `total` unguarded twelve lines earlier — so the shape the neighbouring
    // guard exists for crashed the experiment with a TypeError out of
    // `runAblation` instead of stopping it with a reason.
    //
    // A crash would at least fail in the safe direction, and that is exactly why
    // it is worth fixing rather than shrugging at: "died with a TypeError" and
    // "stopped because a run could not be audited" are different facts, and only
    // the second tells the human what happened to their money.
    const root = await tempDir("mad-governor-")
    const governor = createExperimentGovernor({ bundleRoot: root })
    const broken = { ...emptyLedger() } as Record<string, unknown>
    delete broken.total

    // The assertion is that it RETURNS. A throw here is the bug.
    expect(() =>
      governor.observe(armRun("control", 0, record("run-broken", { ledger: broken as never }))),
    ).not.toThrow()

    const state = governor.state()
    expect(state.halted).toBe(true)
    expect(state.exposure).toBe("unquantified")
    expect(state.haltReason).toContain("run-broken")
  })
})

describe("AC4 — the halt is persisted and does NOT resume automatically", () => {
  test("a FRESH governor over the same bundle root still refuses", async () => {
    const root = await tempDir("mad-governor-")
    const first = createExperimentGovernor({ bundleRoot: root })
    await first.observe(
      armRun(
        "pool",
        0,
        record("run-9", { ledger: { ...emptyLedger(), unknownUsage: [unknown("exec-2", "timed out in flight")] } }),
      ),
    )

    // A DIFFERENT OBJECT, standing in for a different PROCESS. An in-memory flag
    // would pass every test above and resume the moment the operator ran the
    // command again, which is the one thing the protocol forbids.
    const second = createExperimentGovernor({ bundleRoot: root })
    const admission = await second.admit()
    expect(admission.ok).toBe(false)
    expect(admission.ok === false && admission.reason).toContain(HALT_MARKER_FILE)
    expect(second.state().halted).toBe(true)
  })

  test("the marker records the identities, the count and the known spend", async () => {
    const root = await tempDir("mad-governor-")
    const governor = createExperimentGovernor({ bundleRoot: root })
    await governor.admit()
    const entry = unknown("exec-4", "the request may have been billed")
    await governor.observe(
      armRun("lensed", 2, record("run-7", { ledger: { ...spending({ output: 7 }), unknownUsage: [entry] } })),
    )
    const marker = JSON.parse(await readFile(join(root, HALT_MARKER_FILE), "utf8"))
    expect(marker.unknownUsageCount).toBe(1)
    expect(marker.unknownUsage).toEqual([{ armId: "lensed", repeatId: 2, runId: "run-7", entry }])
    expect(marker.knownSpendTokens).toBe(7)
    expect(marker.exposure).toBe("unquantified")
    expect(governor.state().markerFile).toBe(join(root, HALT_MARKER_FILE))
  })

  test("a HUMAN deleting the marker is what resumes admission", async () => {
    const root = await tempDir("mad-governor-")
    const first = createExperimentGovernor({ bundleRoot: root })
    await first.observe(
      armRun("pool", 0, record("run-9", { ledger: { ...emptyLedger(), unknownUsage: [unknown("exec-2", "why")] } })),
    )
    await rm(join(root, HALT_MARKER_FILE))

    expect(await createExperimentGovernor({ bundleRoot: root }).admit()).toEqual({ ok: true })
    // The governor that OBSERVED the unknown stays halted: deleting a file
    // cannot un-observe an uncountable bill, and the process that saw it is not
    // the one the operator is clearing.
    expect((await first.admit()).ok).toBe(false)
  })

  test("a marker this governor never wrote refuses just the same", async () => {
    const root = await tempDir("mad-governor-")
    await writeFile(join(root, HALT_MARKER_FILE), "{}\n", "utf8")
    const admission = await createExperimentGovernor({ bundleRoot: root }).admit()
    expect(admission.ok).toBe(false)
  })
})

describe("AC4 — an unresolved cleanup is recorded and does NOT halt", () => {
  test("a session MAD could not delete is untidy, not an uncountable bill", async () => {
    const root = await tempDir("mad-governor-")
    const governor = createExperimentGovernor({ bundleRoot: root })
    const warnings: Warning[] = [
      { code: "session-cleanup-unresolved", stage: "discover", message: "session s1 would not delete" },
    ]
    await governor.observe(armRun("control", 0, record("run-1", { warnings, ledger: spending({ input: 4 }) })))

    const state = governor.state()
    expect(state.halted).toBe(false)
    expect(state.unresolvedCleanups).toEqual([
      { armId: "control", repeatId: 0, runId: "run-1", message: "session s1 would not delete" },
    ])
    expect(await governor.admit()).toEqual({ ok: true })
  })
})

describe("AC4 — the refusal reaches the harness as the stop that already exists", () => {
  const deps = () => ({
    backendFor: () => new FakeBackend({}),
    backend: undefined as never,
    clock: fakeClock(),
    change: fakeChange(),
    candidates: [candidate("anthropic", "claude-sonnet-4-5"), candidate("openai", "gpt-5")],
    providerConfigKey: "provider",
  })

  test("runAblation refuses the NEXT arm after an unknown, as an EvaluationBundleError", async () => {
    const root = await tempDir("mad-governor-")
    const governor = createExperimentGovernor({ bundleRoot: root })
    const started: string[] = []
    // The second arm is refused, so the first arm's record is what halts the
    // experiment: the fake's ledger is clean, so the halt is planted by observing
    // an unknown through the governor itself before the loop reaches arm `b`.
    await governor.observe(
      armRun("a", 0, record("run-0", { ledger: { ...emptyLedger(), unknownUsage: [unknown("exec-1", "why")] } })),
    )

    await expect(
      runAblation(
        [
          { id: "a", label: "arm a", provenance: "scripted" as const, slots: 1 },
          { id: "b", label: "arm b", provenance: "scripted" as const, slots: 1 },
        ],
        {
          ...deps(),
          backendFor: (spec) => {
            started.push(spec.id)
            return new FakeBackend({})
          },
          governor,
        },
      ),
    ).rejects.toBeInstanceOf(EvaluationBundleError)
    expect(started).toEqual([])
  })

  test("AN UNKNOWN PRODUCED BY ARM A HALTS ARM B — the claim, end to end", async () => {
    // ADDED AT THE WAVE-5 REVIEW (2026-09-11). The test above plants the halt by
    // calling `governor.observe` directly BEFORE the loop, so no arm ever runs
    // and `runAblation`'s own in-loop `observe` is never executed — deleting
    // that line left the whole suite green. It also refuses the FIRST arm, while
    // AC4's actual claim is about the NEXT one.
    //
    // This drives the real thing: arm `a` runs against a backend whose turn
    // reports no usage, `runAblation` observes the record it produced, and arm
    // `b` is refused because of what arm `a` did. Nothing is planted.
    const root = await tempDir("mad-governor-")
    const governor = createExperimentGovernor({ bundleRoot: root })
    const started: string[] = []

    await expect(
      runAblation(
        [
          { id: "a", label: "arm a", provenance: "scripted" as const, slots: 1 },
          { id: "b", label: "arm b", provenance: "scripted" as const, slots: 1 },
        ],
        {
          ...deps(),
          backendFor: (spec) => {
            started.push(spec.id)
            return new FakeBackend({
              "discovery-1": [
                { kind: "fail", failure: "model-error", usageUnknown: "the host reported no usage" },
              ],
            })
          },
          governor,
        },
      ),
    ).rejects.toBeInstanceOf(EvaluationBundleError)

    // ARM `a` RAN AND ARM `b` DID NOT. Both halves matter: refusing both would
    // mean the governor halted on something other than arm `a`'s record, and
    // running both would mean the in-loop observe never fired.
    expect(started).toEqual(["a"])

    // And the halt names what caused it, rather than being a bare stop.
    const state = await governor.state()
    expect(state.halted).toBe(true)
    expect(state.exposure).toBe("unquantified")
    expect(state.unknownUsage.length).toBeGreaterThan(0)
  })

  test("a governor ARMS THE TURN-LEVEL GATE TOO, so the retry after an unknown is refused", async () => {
    // THE OTHER HALF OF AC4, AND THE ONE THAT WAS MISSING ENTIRELY (wave-5
    // review, 2026-09-11). `mayISpend` refuses once usage is unknown and
    // `TokenLedger.stopOnUnknownUsage` is set — correct, tested, and reached by
    // NOTHING: no production caller ever set the dial, so `ablation/` armed the
    // arm-level governor while the stage loops went on retrying the unknown turn
    // inside the current arm. The protocol's "unquantified usage never
    // authorizes a retry" (`evaluation-protocol.md:311-327`) was enforced by no
    // path an evaluation actually runs.
    //
    // The observable consequence, which is what this asserts: the stage asks the
    // backend ONCE. With the dial off, the same failed turn earns AD-6(b)'s
    // retry and `core/stages/discover.test.ts` pins it becoming TWO unknowns.
    const root = await tempDir("mad-governor-")
    const governor = createExperimentGovernor({ bundleRoot: root })
    const backend = new FakeBackend({
      "discovery-1": [
        { kind: "fail", failure: "model-error", usageUnknown: "the host reported no usage" },
      ],
    })

    await expect(
      runAblation(
        [
          { id: "a", label: "arm a", provenance: "scripted" as const, slots: 1 },
          { id: "b", label: "arm b", provenance: "scripted" as const, slots: 1 },
        ],
        { ...deps(), backendFor: () => backend, governor },
      ),
    ).rejects.toBeInstanceOf(EvaluationBundleError)

    // ONE physical call, not two: the accountant refused the retry.
    expect(backend.calls).toHaveLength(1)
  })

  test("with no governor the turn-level gate stays OFF, exactly as an ordinary review", async () => {
    // The mirror, and the reason the dial is a dial. AD-16's rule is that
    // evaluation machinery is additive and never changes an ordinary run: with
    // no governor the unknown is REPORTED and the run keeps working, so the
    // failed turn still earns its one retry and the backend is asked twice.
    const backend = new FakeBackend({
      "discovery-1": [
        { kind: "fail", failure: "model-error", usageUnknown: "the host reported no usage" },
      ],
    })
    const runs = await runAblation(
      [{ id: "a", label: "arm a", provenance: "scripted" as const, slots: 1 }],
      { ...deps(), backendFor: () => backend },
    )

    expect(backend.calls).toHaveLength(2)
    expect(runs[0]!.record.ledger.stopOnUnknownUsage).toBe(false)
    expect(runs[0]!.record.ledger.unknownUsage).toHaveLength(2)
  })

  test("with no governor, runAblation behaves exactly as it did", async () => {
    const runs = await runAblation(
      [{ id: "a", label: "arm a", provenance: "scripted" as const, slots: 1 }],
      deps(),
    )
    expect(runs).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Story 2-5c — the request-level gates over the journal's unique-execution bill
// ---------------------------------------------------------------------------

describe("requestGate — every Blocks request passes every gate (story 2-5c)", () => {
  function view(over: Partial<RequestGateView> & { phases?: Record<string, number>; blocks?: number } = {}): RequestGateView {
    return {
      stop: over.stop ?? null,
      halt: over.halt ?? null,
      globalSpent: over.globalSpent ?? 0,
      categorySpent: (category) => (category === "blocks" ? (over.blocks ?? 0) : 0),
      phaseSpent: (block, phase) => over.phases?.[`${block}:${phase}`] ?? 0,
    }
  }

  test("the prefix gate refuses AT 60,000 new consumption, not above it", () => {
    expect(requestGate(view({ phases: { "1:prefix": 59_999 } }), { block: 1, phase: "prefix" }).ok).toBe(true)
    expect(requestGate(view({ phases: { "1:prefix": 60_000 } }), { block: 1, phase: "prefix" })).toMatchObject({
      ok: false,
      cause: "budget",
    })
  })

  test("each continuation has its own 195,000; ON's exhaustion does not refuse OFF", () => {
    const exhaustedOn = view({ phases: { "1:on": 195_000 } })
    expect(requestGate(exhaustedOn, { block: 1, phase: "on" }).ok).toBe(false)
    expect(requestGate(exhaustedOn, { block: 1, phase: "off" }).ok).toBe(true)
    expect(requestGate(exhaustedOn, { block: 2, phase: "on" }).ok).toBe(true)
  })

  test("Blocks, global and the halt still apply to the other arm", () => {
    expect(requestGate(view({ blocks: 1_400_000 }), { block: 3, phase: "off" })).toMatchObject({ ok: false, cause: "budget" })
    expect(requestGate(view({ globalSpent: 2_000_000 }), { block: 3, phase: "off" })).toMatchObject({ ok: false, cause: "budget" })
    expect(requestGate(view({ halt: "exec-1 unknown" }), { block: 3, phase: "off" })).toMatchObject({ ok: false, cause: "halted" })
    expect(requestGate(view({ stop: "disk full" }), { block: 3, phase: "off" })).toMatchObject({ ok: false, cause: "runner-stop" })
  })

  test("the 50,000 of reporting headroom is never admitted against by a phase", () => {
    expect(PAIRED_ALLOWANCES.prefix + 2 * PAIRED_ALLOWANCES.continuation).toBe(450_000)
    expect(PAIRED_ALLOWANCES.blocks - 3 * 450_000).toBe(50_000)
  })
})

describe("the ordinary stage ceiling and the experiment gate, together (story 2-5c)", () => {
  async function journalWithOnSpend(root: string, onSpend: number) {
    const lock = await acquireLock(root, "t")
    if (!lock.ok) throw new Error(lock.reason)
    const opened = await openJournal(root, lock.lock, () => "t")
    if (!opened.ok) throw new Error(opened.reason)
    const journal = opened.journal
    const decision = await journal.admission({ block: 1, phase: "on", runId: () => "run-on" }).admit({ stage: "judge", slot: "discovery-1", attempt: 1 })
    if (!decision.ok) throw new Error(decision.reason)
    await decision.settle({ kind: "usage", tokens: { ...emptyTokenUsage(), input: onSpend } })
    return journal
  }

  function branchLedger(inherited: number, fresh: number): BudgetLedger {
    const ledger = { ...emptyLedger(255_000), stopOnUnknownUsage: true } as BudgetLedger
    recordTurn(ledger, { slot: "discovery-1", stage: "discover", attempt: 1, tokens: { ...emptyTokenUsage(), input: inherited }, origin: { runId: "prefix", entry: 0 } })
    recordTurn(ledger, { slot: "discovery-1", stage: "judge", attempt: 1, tokens: { ...emptyTokenUsage(), input: fresh } })
    return ledger
  }

  function routedFinding(route: "judge" | "debate"): Finding {
    return {
      id: "f-1",
      claim: "a claim",
      reasoning: "a reason",
      locus: { file: "src/pay.ts", startLine: 1, endLine: 1 },
      severity: "high",
      author: "discovery-1",
      source: "pool",
      coDiscovery: { raised: 1, answered: 1 },
      route,
      history: [],
    }
  }

  const roster = () =>
    selectRoster([candidate("anthropic", "claude-sonnet-4-5")], { slots: 1, providerConfigKey: "provider" }).roster

  test("judge: inherited 50,000 + new 195,000 passes the 255,000 ceiling and is refused by the continuation gate", async () => {
    const root = await tempDir("mad-gates-")
    const journal = await journalWithOnSpend(root, 195_000)
    const ledger = branchLedger(50_000, 195_000)
    expect(mayISpend(ledger, "judge")).toBe(true)
    const backend = new FakeBackend({})
    const finding = routedFinding("judge")
    await judge({
      findings: [finding],
      roster: roster(),
      answeredSlots: ["discovery-1"],
      backend,
      input: "diff",
      clock: fakeClock(),
      ledger,
      admission: journal.admission({ block: 1, phase: "on", runId: () => "run-on" }),
    })
    expect(backend.calls).toHaveLength(0)
    expect(finding.unresolved?.diedAtStage).toBe("judge")
    // The ON continuation allowance refused it, not the run's cap or another gate.
    expect(journal.bill().refused).toEqual([expect.objectContaining({ phase: "on", cause: "budget" })])
    expect(finding.unresolved?.reason).toContain("ON continuation allowance is exhausted: 195000 of 195000")
    expect(finding.unresolved?.reason).not.toContain("token budget")
    await journal.close()
  })

  test("debate at the same point is already refused by its own share, at 165,750", async () => {
    const root = await tempDir("mad-gates-")
    const journal = await journalWithOnSpend(root, 0)
    const ledger = branchLedger(50_000, 195_000)
    expect(mayISpend(ledger, "debate")).toBe(false)
    const asked: string[] = []
    const admission = journal.admission({ block: 1, phase: "on", runId: () => "run-on" })
    const finding = routedFinding("debate")
    await debate({
      findings: [finding],
      roster: roster(),
      answeredSlots: ["discovery-1"],
      backend: new FakeBackend({}),
      input: "diff",
      clock: fakeClock(),
      ledger,
      admission: { admit: (request) => (asked.push(request.slot), admission.admit(request)) },
    })
    expect(asked).toHaveLength(0)
    expect(finding.unresolved?.diedAtStage).toBe("debate")
    await journal.close()
  })

  test("judge: inherited 70,000 + new 185,000 is refused by the ordinary ceiling though new is under 195,000", async () => {
    const root = await tempDir("mad-gates-")
    const journal = await journalWithOnSpend(root, 185_000)
    const ledger = branchLedger(70_000, 185_000)
    expect(mayISpend(ledger, "judge")).toBe(false)
    expect(journal.bill().byPhase[0]!.tokens.input).toBeLessThan(PAIRED_ALLOWANCES.continuation)
    const asked: string[] = []
    const admission = journal.admission({ block: 1, phase: "on", runId: () => "run-on" })
    const finding = routedFinding("judge")
    await judge({
      findings: [finding],
      roster: roster(),
      answeredSlots: ["discovery-1"],
      backend: new FakeBackend({}),
      input: "diff",
      clock: fakeClock(),
      ledger,
      admission: { admit: (request) => (asked.push(request.slot), admission.admit(request)) },
    })
    expect(asked).toHaveLength(0)
    expect(finding.unresolved?.reason).toContain("the token budget (255000) ran out")
    await journal.close()
  })
})

describe("two branches of one prefix bill it once (story 2-5c)", () => {
  test("the journal bill counts each physical execution once; attributed ledgers count the prefix twice", async () => {
    const root = await tempDir("mad-bill-")
    const lock = await acquireLock(root, "t")
    if (!lock.ok) throw new Error(lock.reason)
    const opened = await openJournal(root, lock.lock, () => "t")
    if (!opened.ok) throw new Error(opened.reason)
    const journal = opened.journal
    const spend = async (phase: "prefix" | "on" | "off", input: number) => {
      const decision = await journal.admission({ block: 1, phase, runId: () => `run-${phase}` }).admit({ stage: "discover", slot: "discovery-1", attempt: 1 })
      if (!decision.ok) throw new Error(decision.reason)
      await decision.settle({ kind: "usage", tokens: { ...emptyTokenUsage(), input } })
    }
    await spend("prefix", 1_000)
    await spend("on", 300)
    await spend("off", 200)

    const bill = journal.bill()
    const prefixTokens = bill.byPhase.find((phase) => phase.phase === "prefix")!.tokens.input
    expect(bill.byCategory.blocks!.input).toBe(1_500)
    // Each branch inherits the prefix against its own cap.
    const attributedOn = prefixTokens + 300
    const attributedOff = prefixTokens + 200
    expect(attributedOn + attributedOff - bill.byCategory.blocks!.input).toBe(prefixTokens)

    const state = governorStateFromBill(bill)
    expect(state.knownSpendTokens).toBe(1_500)
    expect(state.halted).toBe(false)
    expect(state.exposure).toBe("quantified")
    await journal.close()
  })

  test("a request still in flight leaves exposure unquantified", async () => {
    const root = await tempDir("mad-bill-")
    const lock = await acquireLock(root, "t")
    if (!lock.ok) throw new Error(lock.reason)
    const opened = await openJournal(root, lock.lock, () => "t")
    if (!opened.ok) throw new Error(opened.reason)
    const decision = await opened.journal.admission({ block: 1, phase: "prefix", runId: () => "run-p" }).admit({ stage: "discover", slot: "discovery-1", attempt: 1 })
    expect(decision.ok).toBe(true)
    const state = governorStateFromBill(opened.journal.bill())
    expect(state.halted).toBe(false)
    expect(state.inFlight).toBe(1)
    expect(state.exposure).toBe("unquantified")
    await opened.journal.close()
  })

  test("the halt presentation names each unknown execution from the bill, and exposure is unquantified", async () => {
    const root = await tempDir("mad-bill-")
    const lock = await acquireLock(root, "t")
    if (!lock.ok) throw new Error(lock.reason)
    const opened = await openJournal(root, lock.lock, () => "t")
    if (!opened.ok) throw new Error(opened.reason)
    const decision = await opened.journal.admission({ block: 2, phase: "off", runId: () => "run-off" }).admit({ stage: "judge", slot: "discovery-1", attempt: 2 })
    if (!decision.ok) throw new Error(decision.reason)
    await decision.settle({ kind: "unknown", why: "timed out", executionId: "exec-4" })
    const state = governorStateFromBill(opened.journal.bill())
    expect(state.halted).toBe(true)
    expect(state.exposure).toBe("unquantified")
    expect(state.unknownUsage).toEqual([
      { armId: "off", repeatId: 1, runId: "run-off", entry: { slot: "discovery-1", stage: "judge", attempt: 2, executionId: "exec-4", why: "timed out" } },
    ])
    await opened.journal.close()
  })
})

describe("requestGate in admitted attempts (story 2-8c3a)", () => {
  function view(over: { phases?: Record<string, number>; perBlock?: Record<number, number>; blocks?: number; globalSpent?: number; halt?: string; stop?: string } = {}): RequestGateView {
    return {
      stop: over.stop ?? null,
      halt: over.halt ?? null,
      globalSpent: over.globalSpent ?? 0,
      categorySpent: (category) => (category === "blocks" ? (over.blocks ?? 0) : 0),
      phaseSpent: (block, phase) => over.phases?.[`${block}:${phase}`] ?? 0,
      mode: "attempts",
      blockSpent: (block) => over.perBlock?.[block] ?? 0,
    }
  }

  test("ATTEMPT_ALLOWANCES: prefix 2×(3+L) with L = 2, 45 per continuation, 100 per block, 300 in all", () => {
    expect(ATTEMPT_ALLOWANCES).toEqual({ global: 300, blocks: 300, block: 100, prefix: 10, continuation: 45 })
    expect(ATTEMPT_ALLOWANCES.prefix as number).toBe(2 * (3 + 2))
    expect(ATTEMPT_ALLOWANCES.prefix + 2 * ATTEMPT_ALLOWANCES.continuation).toBe(ATTEMPT_ALLOWANCES.block as number)
    expect(3 * ATTEMPT_ALLOWANCES.block).toBe(ATTEMPT_ALLOWANCES.blocks as number)
  })

  test("each threshold refuses AT its value, and every message counts attempts", () => {
    expect(requestGate(view({ phases: { "1:prefix": 9 } }), { block: 1, phase: "prefix" }).ok).toBe(true)
    const cases: [ReturnType<typeof view>, { block: number; phase: "prefix" | "on" | "off" }, string][] = [
      [view({ phases: { "1:prefix": 10 } }), { block: 1, phase: "prefix" }, "block 1's shared prefix allowance is exhausted: 10 of 10 admitted attempts"],
      [view({ phases: { "2:off": 45 } }), { block: 2, phase: "off" }, "block 2's OFF continuation allowance is exhausted: 45 of 45 admitted attempts"],
      [view({ perBlock: { 3: 100 }, phases: { "3:on": 44 } }), { block: 3, phase: "on" }, "block 3's allowance is exhausted: 100 of 100 admitted attempts"],
      [view({ blocks: 300 }), { block: 3, phase: "on" }, "the Blocks allowance is exhausted: 300 of 300 admitted attempts"],
      [view({ globalSpent: 300 }), { block: 3, phase: "on" }, "the experiment's global cap is exhausted: 300 of 300 admitted attempts"],
    ]
    for (const [gateView, target, reason] of cases) {
      expect(requestGate(gateView, target)).toEqual({ ok: false, cause: "budget", reason })
    }
  })

  test("the per-block total refuses one continuation even while its own phase has room", () => {
    const full = view({ perBlock: { 1: 100 }, phases: { "1:on": 40 } })
    expect(requestGate(full, { block: 1, phase: "on" }).ok).toBe(false)
    expect(requestGate(full, { block: 2, phase: "on" }).ok).toBe(true)
  })

  test("a halt never claims token exposure; the stop and the halt still refuse", () => {
    const halted = requestGate(view({ halt: "ATTEMPT-MODE STOP (…): an attempt did not end within its bound" }), { block: 1, phase: "on" })
    expect(halted).toMatchObject({ ok: false, cause: "halted" })
    if (!halted.ok) {
      expect(halted.reason).not.toContain("Token exposure")
      expect(halted.reason).toContain("does not resume automatically")
    }
    expect(requestGate(view({ stop: "disk full" }), { block: 1, phase: "on" })).toMatchObject({ ok: false, cause: "runner-stop" })
  })

  test("a token-mode view is gated in tokens exactly as before", () => {
    const tokens: RequestGateView = { ...view({ phases: { "1:prefix": 10 } }), mode: undefined, blockSpent: undefined }
    expect(requestGate(tokens, { block: 1, phase: "prefix" }).ok).toBe(true)
    const atLimit: RequestGateView = { ...view({ phases: { "1:prefix": 60_000 } }), mode: undefined, blockSpent: undefined }
    expect(requestGate(atLimit, { block: 1, phase: "prefix" })).toEqual({
      ok: false,
      cause: "budget",
      reason: "block 1's shared prefix allowance is exhausted: 60000 of 60000 newly executed tokens",
    })
  })

  test("an attempt-mode view with no per-block count is a malformed view, never a budget refusal", () => {
    const broken: RequestGateView = { ...view(), blockSpent: undefined }
    const result = requestGate(broken, { block: 1, phase: "prefix" })
    expect(result).toMatchObject({ ok: false, cause: "runner-stop" })
    if (!result.ok) {
      expect(result.reason).toContain("carries no per-block attempt count")
      expect(result.reason).not.toContain("Infinity")
    }
  })

  test("governorStateFromBill reads an attempt-mode bill by its unit: the count, and token exposure unmeasured", async () => {
    const root = await tempDir("mad-bill-")
    const lock = await acquireLock(root, "t")
    if (!lock.ok) throw new Error(lock.reason)
    const opened = await openJournal(root, lock.lock, () => "t", undefined, "attempts")
    if (!opened.ok) throw new Error(opened.reason)
    const admission = opened.journal.admission({ block: 1, phase: "prefix", runId: () => "run-p" })
    const first = await admission.admit({ stage: "discover", slot: "discovery-1", attempt: 1 })
    if (!first.ok) throw new Error(first.reason)
    await first.settle({ kind: "unknown", why: "the host reported nothing" })
    const second = await admission.admit({ stage: "discover", slot: "discovery-2", attempt: 1 })
    if (!second.ok) throw new Error(second.reason)
    await second.settle({ kind: "not-issued" })
    const state = governorStateFromBill(opened.journal.bill())
    expect(state.accounting).toBe("attempts")
    expect(state.admittedAttempts).toBe(1)
    expect(state.halted).toBe(false)
    expect(state.exposure).toBe("unquantified")
    // The unknown is a diagnostic, listed apart from the interrupted requests.
    expect(state.unknownUsage).toEqual([])
    expect(state.unknownUsageCount).toBe(0)
    expect(state.unknownDiagnostics!.map((entry) => entry.entry.why)).toEqual(["the host reported nothing"])
    // An attempt left in flight is what `unknownUsage` lists, once the journal is reopened.
    expect((await admission.admit({ stage: "discover", slot: "discovery-3", attempt: 1 })).ok).toBe(true)
    await opened.journal.close()
    const again = await acquireLock(root, "t")
    if (!again.ok) throw new Error(again.reason)
    const reopened = await openJournal(root, again.lock, () => "t", undefined, "attempts")
    if (!reopened.ok) throw new Error(reopened.reason)
    const after = governorStateFromBill(reopened.journal.bill())
    expect(after.unknownUsage.map((entry) => entry.entry.why)).toEqual(["issued by an interrupted invocation and never settled"])
    expect(after.unknownDiagnostics).toHaveLength(1)
    await reopened.journal.close()
  })
})
