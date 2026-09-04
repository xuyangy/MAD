/**
 * CAP-9 over the seeded-defect fixture — the SCRIPTED ablation.
 *
 * Three arms over one change, differing in the roster and in nothing else:
 *
 *   control — `slots: 1`, one pinned model. Story 1's single-model path, reused
 *             rather than rebuilt (`review.ts`: "no second code path"), and now
 *             NAMEABLE, which is what story 8A's pinning bought this arm.
 *   pool    — `slots: 3`, no lenses.
 *   lensed  — `slots: 3`, the fixture's four lenses.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT. It proves the harness runs, that the
 * comparison arithmetic is right, and that a negative result renders as a
 * result. It measures NOTHING about whether debate is worth its bill: the
 * scripted judge answers `upheld` unconditionally and the scripted backend bills
 * a constant per turn, so the verdict-difference column can only be zero and the
 * token column is a turn count. `report.ts` prints that in a banner with no
 * suppression option, and `ablation/LIVE-RUN.md` is how a real result is
 * produced.
 *
 * THE PIN IS A REQUIRED ARGUMENT WITH NO DEFAULT, and that is a decision rather
 * than an oversight (story 9, answered as an Ask First). `host-integration.md`
 * says MAD never names a model; a pin literal committed in this tree would be
 * the first model id checked into MAD's own repository, and "the ablation's
 * caller names it" stops being true when the caller is a file inside MAD. Under
 * the scripted backend the pin changes no answer — `FakeBackend` is keyed by
 * slot id — so it exists only so the report can say what the control arm was.
 */

import { SEEDED_CHANGE, SEEDED_DEFECTS } from "../fixtures/seeded-defects/change.ts"
import {
  abstainingInDebate,
  LENSES,
  LENS_SCRIPTS,
  SCRIPTS,
  SEEDED_CANDIDATES,
} from "../fixtures/seeded-defects/arms.ts"
import { lensRecallGain } from "../fixtures/recall.ts"
import type { Pin } from "../core/roster/select.ts"
import { fakeClock, FakeBackend } from "../core/test-support/fakes.ts"
import { alignArms } from "./align.ts"
import { runAblation, type ArmSpec } from "./arms.ts"
import { buildReport, lensTokenCost, type AblationReport } from "./compare.ts"

export const CONTROL = "control"
export const POOL = "pool"
export const LENSED = "lensed"

export interface ScriptedOptions {
  /**
   * The control arm's model, as `provider/model`. REQUIRED — see the module
   * header on why no default is committed here.
   */
  pin: Pin
  /** One shared ceiling, spread into every arm so it stays shared. */
  tokenCap?: number
  repeats?: number
}

export function scriptedArms(pin: Pin): ArmSpec[] {
  return [
    { id: CONTROL, label: "single pinned model", provenance: "scripted", slots: 1, pins: [pin] },
    { id: POOL, label: "three-model pool, no lenses", provenance: "scripted", slots: 3 },
    {
      id: LENSED,
      label: "three-model pool + four lenses",
      provenance: "scripted",
      slots: 3,
      lenses: [...LENSES],
    },
  ]
}

export async function scriptedAblation(options: ScriptedOptions): Promise<AblationReport> {
  const specs = scriptedArms(options.pin)
  const runs = await runAblation(
    specs,
    {
      // A FRESH backend per arm. `FakeBackend` counts attempts per (slot, role)
      // and replays a script's last step once it runs out, so one instance
      // across three arms hands arm 2 the step arm 1 finished on.
      backendFor: () => new FakeBackend(abstainingInDebate({ ...SCRIPTS, ...LENS_SCRIPTS })),
      backend: new FakeBackend(abstainingInDebate({ ...SCRIPTS, ...LENS_SCRIPTS })),
      clock: fakeClock(),
      change: SEEDED_CHANGE,
      candidates: SEEDED_CANDIDATES,
      providerConfigKey: "provider",
      ...(options.tokenCap === undefined ? {} : { dials: { tokenCap: options.tokenCap } }),
    },
    options.repeats ?? 1,
  )

  const first = (id: string) => runs.find((run) => run.spec.id === id)!
  const control = first(CONTROL)
  const pool = first(POOL)
  const lensed = first(LENSED)

  const pairings = []
  for (const [a, b] of [
    [control, pool],
    [pool, lensed],
    [control, lensed],
  ] as const) {
    pairings.push({
      a: a.spec.id,
      b: b.spec.id,
      alignment: await alignArms(
        { id: a.spec.id, findings: a.record.findings },
        { id: b.spec.id, findings: b.record.findings },
      ),
    })
  }

  return buildReport(runs, {
    pairings,
    lens: {
      // RECALL READS `pool`, NOT `findings`. The pre-cluster union is what CAP-1
      // measures over; reading the canonical set instead would score an arm
      // against a set clustering already collapsed and silently lower every
      // recall number in this report.
      gain: lensRecallGain(SEEDED_DEFECTS, lensed.record.pool),
      cost: lensTokenCost(lensed.record, pool.record),
    },
  })
}
