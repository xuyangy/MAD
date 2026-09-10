/**
 * CAP-9 against REAL providers — the only path that can produce an experimental
 * result.
 *
 * The scripted ablation proves the harness works. It measures nothing about
 * whether debate is worth its bill, because the scripted judge answers `upheld`
 * unconditionally and the scripted backend bills a constant per turn. This
 * module is where a real number comes from, and `ablation/LIVE-RUN.md` is the
 * procedure for driving it safely.
 *
 * ## The live and scripted paths differ in THREE injected values and nothing else
 *
 * The backend, the clock and the candidate list. Both call the same
 * `runAblation`, which calls the same exported `review()`. There is no live
 * pipeline and no live mode — a second code path would make the scripted run a
 * test of something the live run does not do, which is the failure story 1's
 * "no second code path" note exists to prevent.
 *
 * ## CI CAN NEVER EXERCISE THIS
 *
 * It needs a running opencode server, at least one provider configured in the
 * HOST (MAD supplies no credential — AD-3), and a worktree with a real diff. It
 * is therefore the one module in this tree that imports the opencode SDK, kept
 * behind a dynamic import in `scripts/ablation.ts` so the scripted path — the one
 * the tests gate — never constructs an opencode client. Read it as an unexercised
 * path and change it with that in mind.
 *
 * (Story 2.2 added a SECOND module reaching into `adapters/`: `ablation/bundle.ts`
 * imports `adapters/opencode/artifacts.ts`. That file pulls in only `node:` and
 * `core/` types and no SDK, so the sentence that matters here — the scripted path
 * constructs no opencode client — is unchanged.)
 *
 * ## It bills real money against the caller's own credentials
 *
 * Three arms over one change is up to `1 + 3 + (3 + lenses)` discovery turns
 * plus debate and judge turns for each. `tokenCap` is passed to EVERY arm from
 * one value, so a ceiling is a shared ceiling; `LIVE-RUN.md` requires one to be
 * stated before anything bills.
 */

import { createOpencodeClient } from "@opencode-ai/sdk/v2"

import { enumerateCandidates } from "../adapters/opencode/roster.ts"
import { OpencodeModelBackend } from "../adapters/opencode/model-backend.ts"
import { opencodeRepo } from "../adapters/opencode/repo.ts"
import { selectRoster, type Pin } from "../core/roster/select.ts"
import { systemClock } from "../core/ports/clock.ts"
import { createTurnRecorder, type TurnArtifact } from "../adapters/opencode/artifacts.ts"
import { alignArms } from "./align.ts"
import { runAblation, type ArmSpec } from "./arms.ts"
import { writeArmDump, writeBundleIndex, type BundleArm } from "./bundle.ts"
import { buildReport, lensTokenCost, type AblationReport } from "./compare.ts"
import type { EvaluationIdentity } from "./manifest.ts"

export interface LiveOptions {
  pin: Pin
  serverUrl: string
  directory: string
  worktree?: string
  /** Host git syntax: a ref range, a commit, or omitted for the working tree. */
  target?: string
  /** ONE ceiling, spread into every arm. See the module header. */
  tokenCap?: number
  repeats?: number
  lenses?: readonly string[]
  providerConfigKey?: string
  /** Injected so a test can drive this without a shell. */
  shell?: Parameters<typeof opencodeRepo>[0]["$"]
  /**
   * Injected so a test can OBSERVE what the client is built from (ledger triage
   * 2026-09-09).
   *
   * The `directory` line below is the whole of a fix that CI can never run —
   * deleting it silently restores the original defect, a live roster enumerated
   * from the wrong directory, with the full suite green. A seam is the only way
   * that line can be asserted at all, so it is a seam.
   */
  createClient?: (init: { baseUrl: string; directory: string }) => unknown
  /**
   * FR1 / FR2 (story 2.2) — write this evaluation as a bundle on disk.
   *
   * ABSENT IS TODAY'S BEHAVIOUR EXACTLY: nothing is written, no turn is kept in
   * memory, and story 9's A20 ("the worktree is byte-identical before and after")
   * holds unchanged. The scripted path never sets it.
   */
  bundle?: {
    /** Absolute, and outside the repository under review — checked, not trusted. */
    root: string
    identity: Omit<EvaluationIdentity, "armId" | "repeatId">
    /** Supplied so the index does not depend on a clock this module does not own. */
    createdAt: string
  }
  /** Where bundle write outcomes go. The CLI prints them; a test collects them. */
  onBundleEvent?: (event: BundleEvent) => void
}

/** What the bundle writer did, reported rather than thrown. */
export type BundleEvent =
  | { kind: "index"; ok: boolean; detail: string }
  | { kind: "arm"; armId: string; repeatId: number; outcome: string; detail: string }

export const LIVE_ARMS = (pin: Pin, lenses: readonly string[]): ArmSpec[] => [
  { id: "control", label: "single pinned model", provenance: "live", slots: 1, pins: [pin] },
  { id: "pool", label: "three-model pool, no lenses", provenance: "live", slots: 3 },
  ...(lenses.length === 0
    ? []
    : [
        {
          id: "lensed",
          label: `three-model pool + ${lenses.length} lens(es)`,
          provenance: "live" as const,
          slots: 3,
          lenses,
        },
      ]),
]

export async function runLiveAblation(options: LiveOptions): Promise<AblationReport> {
  // SCOPED TO `--directory`, like every other client in this tree (epic-1
  // retrospective ledger triage, entry 58). `OpencodeModelBackend` passes
  // `directory` at its own construction site and `opencodeRepo` takes a
  // worktree; this one took a bare `baseUrl`, so the candidate enumeration below
  // asked the server about whatever directory it happened to consider current.
  // Unexercised by CI — the live path is the one module CI can never run — which
  // is why it survived to here rather than being caught by a test.
  const client = (options.createClient ?? createOpencodeClient)({
    baseUrl: options.serverUrl,
    directory: options.directory,
  })
  const candidates = await enumerateCandidates(client as never)
  const providerConfigKey = options.providerConfigKey ?? "provider"
  const lenses = options.lenses ?? []
  const specs = LIVE_ARMS(options.pin, lenses)

  const repo = opencodeRepo({
    $: options.shell ?? (Bun.$ as never),
    worktree: options.worktree ?? options.directory,
  })
  const change = await repo.change(options.target)

  // ONE RECORDER PER ARM RUN, in CALL ORDER, and the pairing below depends on
  // `runAblation` being sequential — it awaits each `runArm` before starting the
  // next, and `backendFor` is called at the top of each one, so the Nth recorder
  // belongs to the Nth run. The length check after the loop is what makes that
  // dependency loud rather than silent if the harness ever runs arms in parallel;
  // `ablation/bundle.test.ts` pins the ordering itself against `runAblation`.
  //
  // BUILT ONLY WHEN A BUNDLE IS ASKED FOR, exactly as `plugin.ts` builds its
  // recorder only when the flag is on: with no bundle, no transcript is held in
  // memory at all.
  const recorders: { turns: readonly TurnArtifact[] }[] = []

  if (options.bundle !== undefined) {
    const declared: BundleArm[] = []
    for (let repeat = 0; repeat < (options.repeats ?? 1); repeat += 1) {
      for (const spec of specs) declared.push({ armId: spec.id, repeatId: repeat })
    }
    const index = await writeBundleIndex({
      bundleRoot: options.bundle.root,
      worktree: options.worktree ?? options.directory,
      arms: declared,
      createdAt: options.bundle.createdAt,
    })
    options.onBundleEvent?.({
      kind: "index",
      ok: index.ok,
      detail: index.ok ? index.file : index.reason,
    })
    // A REFUSED INDEX STOPS THE EVALUATION BEFORE IT BILLS. The index is the only
    // thing that can name a missing arm afterwards, so an evaluation that ran
    // without one would spend real credentials on a bundle nobody can check —
    // which is the whole of FR1's "a published number is traceable or it is not
    // published".
    if (!index.ok) {
      throw new Error(`the evaluation bundle could not be declared: ${index.reason}`)
    }
  }

  const runs = await runAblation(
    specs,
    {
      // ONE BACKEND PER ARM, built from that arm's own roster.
      // `OpencodeModelBackend` maps by slot id and THROWS on a slot it does not
      // know, and `runWithOneRetry` swallows that throw into a transport-error
      // envelope — so a backend shared across arms with different rosters would
      // turn every unknown slot into a silent double drop-out that reads exactly
      // like a flaky provider. Both collections, for the reason `plugin.ts`
      // records at its own construction site.
      backendFor: (spec) => {
        const resolved = selectRoster(candidates, {
          slots: spec.slots,
          lenses: spec.lenses ?? [],
          pins: spec.pins ?? [],
          providerConfigKey,
        })
        const backend = new OpencodeModelBackend({
          serverUrl: options.serverUrl,
          directory: options.directory,
          slots: [...resolved.roster.slots, ...resolved.roster.lensSlots],
        })
        if (options.bundle === undefined) return backend
        const recorder = createTurnRecorder()
        recorders.push(recorder)
        return recorder.wrap(backend)
      },
      backend: undefined as never,
      clock: systemClock(),
      change,
      candidates,
      providerConfigKey,
      ...(options.tokenCap === undefined ? {} : { dials: { tokenCap: options.tokenCap } }),
    },
    options.repeats ?? 1,
  )

  if (options.bundle !== undefined) {
    if (recorders.length !== runs.length) {
      throw new Error(
        `the bundle writer kept ${recorders.length} turn recorder(s) for ${runs.length} run(s); ` +
          `the recorder-to-run pairing assumes runAblation runs arms sequentially and it no longer does.`,
      )
    }
    for (const [index, run] of runs.entries()) {
      const outcome = await writeArmDump({
        bundleRoot: options.bundle.root,
        run,
        change,
        identity: options.bundle.identity,
        turns: recorders[index]!.turns,
        worktree: options.worktree ?? options.directory,
      })
      options.onBundleEvent?.({
        kind: "arm",
        armId: run.spec.id,
        repeatId: run.repeat,
        outcome: outcome.kind,
        detail:
          outcome.kind === "written"
            ? `${outcome.files} file(s) in ${outcome.directory}`
            : outcome.kind === "refused"
              ? outcome.reason
              : outcome.kind === "failed"
                ? outcome.error
                : "the artifact flag resolved to off",
      })
    }
  }

  const first = (id: string) => runs.find((run) => run.spec.id === id)
  const control = first("control")!
  const pool = first("pool")!
  const lensed = first("lensed")

  const pairs: { a: string; b: string; alignment: Awaited<ReturnType<typeof alignArms>> }[] = []
  const pairsToAlign = [
    [control, pool],
    ...(lensed ? [[pool, lensed], [control, lensed]] : []),
  ] as const
  for (const [a, b] of pairsToAlign) {
    pairs.push({
      a: a!.spec.id,
      b: b!.spec.id,
      alignment: await alignArms(
        { id: a!.spec.id, findings: a!.record.findings },
        { id: b!.spec.id, findings: b!.record.findings },
      ),
    })
  }

  // NO LENS RECALL GAIN ON A LIVE RUN, and its absence is a fact rather than a
  // gap. Recall is measured against a KNOWN defect set, and a real change has
  // none — nobody has labelled its bugs. The report renders "not applicable"
  // rather than `0`, because an unknown recall is not a recall of zero.
  return buildReport(runs, {
    pairings: pairs,
    ...(lensed === undefined
      ? {}
      : { lens: { gain: undefined, cost: lensTokenCost(lensed.record, pool.record) } }),
  })
}
