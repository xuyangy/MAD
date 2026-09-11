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
 * ## The live and scripted paths differ in FOUR injected values and nothing else
 *
 * The backend, the clock, the candidate list — and, since story 2.4, optionally
 * the change itself. Both call the same `runAblation`, which calls the same
 * exported `review()`. There is no live pipeline and no live mode — a second
 * code path would make the scripted run a test of something the live run does
 * not do, which is the failure story 1's "no second code path" note exists to
 * prevent.
 *
 * The fourth is `options.change`, and it stays one injected value for the same
 * reason: a labelled evaluation needs a change whose bugs are written down, and
 * `repo.change()` can only read whatever is in the worktree. Handing the
 * `ChangeSet` in is three lines; a parallel "labelled run" pipeline would be the
 * second code path. It is the same shape `shell` and `createClient` already
 * have — absent means today's behaviour exactly.
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
 * constructs no opencode client — is unchanged.
 *
 * Story 2.3 widened the REACH of that import without changing the sentence, and
 * the difference is worth recording rather than leaving to be rediscovered:
 * `ablation/arms.ts` now imports `EvaluationBundleError` from `bundle.ts` so the
 * governor's refusal is the deliberate stop this tree already has rather than a
 * new exception vocabulary. `arms.ts` is on the SCRIPTED path, so that path now
 * loads `artifacts.ts` too. Still no SDK, still no client, still nothing written
 * unless a caller asks — but the import is no longer confined to the live path,
 * and a future edit to `artifacts.ts` that pulled in the SDK would now reach the
 * scripted run as well.)
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
import type { ModelBackend } from "../core/ports/model-backend.ts"
import type { ChangeSet } from "../core/ports/repo.ts"
import { alignArms } from "./align.ts"
import { runAblation, type ArmSpec } from "./arms.ts"
import { EvaluationBundleError, writeArmDump, writeBundleIndex, type BundleArm } from "./bundle.ts"
import { buildReport, lensTokenCost, type AblationReport } from "./compare.ts"
import { crossArmCalibrationFor } from "./cross-arm-rates.ts"
import { createExperimentGovernor } from "./governor.ts"
import type { EvaluationIdentity } from "./manifest.ts"

export interface LiveOptions {
  pin: Pin
  serverUrl: string
  directory: string
  worktree?: string
  /** Host git syntax: a ref range, a commit, or omitted for the working tree. */
  target?: string
  /**
   * FR5 (story 2.4) — review THIS change instead of reading one from the
   * worktree.
   *
   * ABSENT IS TODAY'S BEHAVIOUR EXACTLY: `repo.change(options.target)` is called
   * and nothing else moves. Present, it is used verbatim and `repo.change` is not
   * called at all, so `--target` has nothing to read and is ignored.
   *
   * This is sufficient for the material under review, and that is a fact about
   * the pipeline rather than a convenience: only `change.diff`, `description` and
   * `files` reach a discovery prompt (`core/run/review.ts:269-317` frames those
   * three and nothing else), so no file body, no directory listing and no
   * `readFile` result reaches any prompt through `core/`. A labelled run
   * therefore needs the `ChangeSet` here and a materialized worktree for the
   * model's OWN tool channel — which is the channel `scripts/ablation.ts`'s
   * `--labelled-change` containment refusal exists to protect.
   */
  change?: ChangeSet
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

  // THE REPO READER IS STILL CONSTRUCTED WHEN A CHANGE WAS HANDED IN, and that
  // is deliberate rather than an oversight for a later reader to tidy away
  // (story 2.4, Task 9). Constructing it is cheap — `opencodeRepo` binds a shell
  // and returns two closures, it runs no git — and `worktree` is still what
  // anchors the bundle containment baseline below (`:211` and `:308`, the two
  // `worktree:` arguments to `writeBundleIndex` and `writeArmDump`), which is the
  // AD-16 check that keeps an evaluation bundle out of the repository under
  // review. Removing the construction would take that baseline with it.
  //
  // What is skipped is the CALL: `repo.change` reads the worktree, and a run
  // given its change already knows what it is reviewing.
  const repo = opencodeRepo({
    $: options.shell ?? (Bun.$ as never),
    worktree: options.worktree ?? options.directory,
  })
  const change = options.change ?? (await repo.change(options.target))

  // THE CROSS-ARM CALIBRATION IS DECIDED BEFORE ANYTHING BILLS. It follows the
  // change actually reviewed — present for the labelled change, absent for a
  // change read out of a worktree. Computed here, a calibration failure (cases
  // drifted from their seal) stops the run before an arm is paid for; computed
  // after the arms, it would throw away a billed run's report.
  const crossArmCalibration = await crossArmCalibrationFor(change)

  // ONE RECORDER PER ARM RUN, KEYED BY THE BACKEND OBJECT ITSELF (review finding
  // a/4, 2026-09-10). This was an array matched to `runs` by index, which is
  // correct only while `runAblation` is sequential and which would fail SILENTLY
  // under concurrency — equal counts, swapped contents, one arm's transcript
  // filed under another arm's manifest. `ArmRun.backend` is the object
  // `backendFor` returned for that arm, so the lookup below is a link rather than
  // a position and cannot be wrong however the arms are scheduled.
  //
  // BUILT ONLY WHEN A BUNDLE IS ASKED FOR, exactly as `plugin.ts` builds its
  // recorder only when the flag is on: with no bundle, no transcript is held in
  // memory at all.
  const recorders = new Map<ModelBackend, { turns: readonly TurnArtifact[] }>()
  const dumpFailures: string[] = []

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
      throw new EvaluationBundleError(`the evaluation bundle could not be declared: ${index.reason}`)
    }
  }

  // AC4 (story 2.3) — THE EXPERIMENT-WIDE STOP MECHANISM
  // (`evaluation-protocol.md:332-339`), built here and consulted by
  // `runAblation` before every arm.
  //
  // ONLY WHEN A BUNDLE IS WRITTEN, and that is the mechanism rather than a
  // convenience: the halt is persisted as a marker in the bundle root, and "do
  // not resume automatically" means the refusal has to outlive this process. A
  // governor with nowhere to write would hold its halt in memory and lift it the
  // moment the operator ran the command again. It is built AFTER the index for
  // the same reason the index is written first — a run whose evidence cannot be
  // declared never reaches the point of needing a gate.
  //
  // The scripted path passes no bundle, builds no governor, and is unchanged
  // (AD-16).
  const governor =
    options.bundle === undefined
      ? undefined
      : createExperimentGovernor({ bundleRoot: options.bundle.root })

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
      //
      // `lateUsage` IS THE ARM'S OWN SINK, minted by `runArm` and handed in. It
      // goes onto the backend here and onto `review()` there, and they are the
      // same object by construction rather than by two call sites agreeing. On
      // the live path this is the only thing that recovers a bill the provider
      // reports after MAD stopped waiting for it (AC2, story 2.3) — without it
      // an evaluation halts on an uncountable turn that was, in fact, countable.
      backendFor: (spec, lateUsage) => {
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
          lateUsage,
        })
        if (options.bundle === undefined) return backend
        const recorder = createTurnRecorder()
        const wrapped = recorder.wrap(backend)
        recorders.set(wrapped, recorder)
        return wrapped
      },
      backend: undefined as never,
      clock: systemClock(),
      change,
      candidates,
      providerConfigKey,
      ...(governor === undefined ? {} : { governor }),
      ...(options.tokenCap === undefined ? {} : { dials: { tokenCap: options.tokenCap } }),
      // EACH ARM IS PERSISTED AS IT FINISHES (review finding 4, 2026-09-10).
      // Writing every dump after the whole loop meant an evaluation that died in
      // its third arm lost the first two — arms that had completed and had
      // already billed — and the reader called them missing. Evidence that
      // exists is written down when it exists.
      ...(options.bundle === undefined
        ? {}
        : {
            onArmComplete: async (run) => {
              const recorder = recorders.get(run.backend)
              const outcome = await writeArmDump({
                bundleRoot: options.bundle!.root,
                run,
                change,
                identity: options.bundle!.identity,
                ...(recorder === undefined ? {} : { turns: recorder.turns }),
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
              // A MANDATORY DUMP THAT FAILED STOPS THE EVALUATION (review finding
              // 6). FR1 is that a published number is traceable to the run that
              // produced it or it is not published; continuing would bill further
              // arms whose evidence cannot be written either.
              if (outcome.kind !== "written") {
                dumpFailures.push(`${run.spec.id} repeat ${run.repeat}: ${outcome.kind}`)
                throw new EvaluationBundleError(
                  `the evaluation bundle could not record arm \`${run.spec.id}\` repeat ${run.repeat} ` +
                    `(${outcome.kind}). FR1: a published number is traceable to the run that produced it, ` +
                    `or it is not published. Nothing further was billed.`,
                )
              }
            },
          }),
    },
    options.repeats ?? 1,
  )

  // The loop above throws on the first failure, so reaching here means every arm
  // was recorded. The check is kept because "the report is only returned when the
  // evidence exists" is the property FR1 asks for, and a property worth having is
  // worth asserting at the point it is relied on.
  if (options.bundle !== undefined && dumpFailures.length > 0) {
    throw new EvaluationBundleError(
      `the evaluation bundle is incomplete (${dumpFailures.join("; ")}), so no report is returned.`,
    )
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

  // NO LENS RECALL GAIN ON A LIVE RUN — ON EITHER PATH, AND FOR TWO DIFFERENT
  // REASONS (review finding P5, 2026-09-11).
  //
  // On an UNLABELLED run its absence is a fact rather than a gap: recall is
  // measured against a KNOWN defect set, and a change read out of a real worktree
  // has none — nobody has labelled its bugs.
  //
  // On a LABELLED run (`options.change`, story 2.4) that sentence is FALSE — the
  // set is `SEEDED_DEFECTS` and its thirteen loci are written down. `gain` is
  // still `undefined` here, so `report.ts` still prints "not applicable — no
  // seeded defect set for this change", and on that path the words are wrong
  // while the NUMBER is honest. Measuring live recall is story 2.6: it needs the
  // arm's findings matched against the labels through `recall()`, which is a
  // measurement this story was told not to take. Until 2.6 wires it, a labelled
  // run reports no recall either, and `LIVE-RUN.md` says so in those words rather
  // than promising one.
  //
  // Either way the report renders "not applicable" rather than `0`, because an
  // unknown recall is not a recall of zero.
  return buildReport(runs, {
    pairings: pairs,
    ...(lensed === undefined
      ? {}
      : { lens: { gain: undefined, cost: lensTokenCost(lensed.record, pool.record) } }),
    ...(crossArmCalibration === undefined ? {} : { crossArmCalibration }),
  })
}
