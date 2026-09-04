/**
 * CAP-9 — an ARM is a `ReviewDeps` literal, and that is the whole of it.
 *
 * `core/run/review.ts` has said since story 1 that "story 9's ablation calls
 * this function directly as the single-model control arm — no second code path",
 * and this module is that sentence implemented. Three arms are three ROSTERS
 * handed to the same exported `review()`; the harness holds the resulting
 * `RunRecord`s in memory and reads them, which AD-16 already calls an ordinary
 * read rather than a special case.
 *
 * ## The arms differ in the roster and in NOTHING ELSE
 *
 * One shared `DIALS` object is spread into every arm, so a threshold, a round
 * cap, a concurrency peak or a token ceiling cannot drift apart between arms
 * without drifting in all of them at once. Two variables and one number is not a
 * measurement, and the failure would be silent: an arm that debated fewer
 * findings because its threshold moved would read exactly like an arm that
 * debated fewer findings because its roster was smaller.
 *
 * Every number the report prints is read back off the `RunRecord`, never off the
 * arm literal — `review()` re-clamps and re-stamps its dials, so the literal is
 * what was asked for and the record is what happened. Those are different facts
 * and only one of them is evidence.
 *
 * ## It runs the arms SEQUENTIALLY
 *
 * Not for correctness — the arms share nothing — but because a live run bills
 * real credentials against a shared rate limit, and three concurrent fan-outs is
 * the provider-rate-limit failure `core/budget/limiter.ts` exists to prevent,
 * reintroduced one level up.
 *
 * AD-1: this tree may import from `core/` and `fixtures/`. Nothing under `core/`
 * may import from here, which `scripts/lint-dependency-direction.ts` enforces.
 */

import type { Pin } from "../core/roster/select.ts"
import { selectRoster } from "../core/roster/select.ts"
import type { Clock } from "../core/ports/clock.ts"
import type { ModelBackend } from "../core/ports/model-backend.ts"
import type { Candidate } from "../core/domain/roster.ts"
import type { ChangeSet } from "../core/ports/repo.ts"
import type { RunRecord } from "../core/domain/run-record.ts"
import { review } from "../core/run/review.ts"

/**
 * Where an arm's numbers came from, and it is on the ARM rather than on the run.
 *
 * A report is allowed to mix them — a live pool arm beside a scripted control is
 * a legitimate thing to want — and the reader must be able to tell which row is
 * which. `report.ts` refuses to draw any experimental line from a scripted arm,
 * and it reads this field to know.
 */
export type Provenance = "scripted" | "live"

export interface ArmSpec {
  /** Stable, short, and used to namespace finding ids during alignment. */
  id: string
  /** What the report calls it. */
  label: string
  provenance: Provenance
  slots: number
  lenses?: readonly string[]
  /** AD-3 amended (story 8A) — how the control arm names its single model. */
  pins?: readonly Pin[]
}

export interface ArmRun {
  spec: ArmSpec
  /** 0-based, for a `--repeats` run measuring the noise floor. */
  repeat: number
  record: RunRecord
  rendered: string
}

/**
 * The dials every arm shares. Spread into each `ReviewDeps` literal, never
 * varied per arm.
 *
 * `tokenCap` is deliberately part of the shared set rather than a per-arm knob:
 * a ceiling that differed by arm would make "this arm stranded findings" a fact
 * about the ceiling instead of a fact about the roster.
 */
export interface Dials {
  tokenCap?: number
  threshold?: number
  maxRounds?: number
  maxConcurrency?: number
}

export interface ArmDeps {
  backend: ModelBackend
  clock: Clock
  change: ChangeSet
  candidates: readonly Candidate[]
  providerConfigKey: string
  dials?: Dials
  /**
   * A fresh backend per arm, when the caller needs one. `FakeBackend` counts
   * attempts per (slot, role) and replays a script's last step once it runs out,
   * so one scripted instance shared across three arms hands arm 2 the step arm 1
   * finished on. A live backend is per-roster by construction and supplies this.
   */
  backendFor?: (spec: ArmSpec) => ModelBackend
}

/** One arm: build its roster, run the shipped seam, keep the record. */
export async function runArm(spec: ArmSpec, deps: ArmDeps, repeat = 0): Promise<ArmRun> {
  const resolved = selectRoster(deps.candidates, {
    slots: spec.slots,
    lenses: spec.lenses ?? [],
    pins: spec.pins ?? [],
    providerConfigKey: deps.providerConfigKey,
  })
  const { record, rendered } = await review({
    roster: resolved.roster,
    backend: deps.backendFor ? deps.backendFor(spec) : deps.backend,
    clock: deps.clock,
    change: deps.change,
    priorWarnings: resolved.warnings,
    ...(deps.dials ?? {}),
  })
  return { spec, repeat, record, rendered }
}

/**
 * Every arm, in order, once per repeat.
 *
 * Repeats exist for one reason and it is not statistics: model output is
 * nondeterministic, so a single live pair cannot tell a real arm difference from
 * run-to-run noise. Running each arm N times gives the report a NOISE FLOOR to
 * print beside the difference, and a difference smaller than the floor is not a
 * result. Under a scripted backend every repeat is identical by construction,
 * which the report says rather than letting a reader infer stability from it.
 */
export async function runAblation(
  specs: readonly ArmSpec[],
  deps: ArmDeps,
  repeats = 1,
): Promise<ArmRun[]> {
  const runs: ArmRun[] = []
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    for (const spec of specs) {
      runs.push(await runArm(spec, deps, repeat))
    }
  }
  return runs
}
