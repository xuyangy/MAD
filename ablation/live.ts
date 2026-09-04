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
 * is therefore the one module in this tree that imports `adapters/`, kept behind
 * a dynamic import in `scripts/ablation.ts` so the scripted path — the one the
 * tests gate — never constructs an opencode client. Read it as an unexercised
 * path and change it with that in mind.
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
import { alignArms } from "./align.ts"
import { runAblation, type ArmSpec } from "./arms.ts"
import { buildReport, lensTokenCost, type AblationReport } from "./compare.ts"

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
}

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
  const client = createOpencodeClient({ baseUrl: options.serverUrl })
  const candidates = await enumerateCandidates(client as never)
  const providerConfigKey = options.providerConfigKey ?? "provider"
  const lenses = options.lenses ?? []
  const specs = LIVE_ARMS(options.pin, lenses)

  const repo = opencodeRepo({
    $: options.shell ?? (Bun.$ as never),
    worktree: options.worktree ?? options.directory,
  })
  const change = await repo.change(options.target)

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
        return new OpencodeModelBackend({
          serverUrl: options.serverUrl,
          directory: options.directory,
          slots: [...resolved.roster.slots, ...resolved.roster.lensSlots],
        })
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
