/**
 * The paired bundle `ablation/paired-read.test.ts` and `ablation/eval-cli.test.ts`
 * both read.
 *
 * It sits beside `read-bundle.fixture.ts` and for that module's reason: the CLI
 * seam and the reader's own suite have to exercise ONE bundle shape. A second
 * hand-rolled paired bundle in the CLI test would let the two drift exactly
 * where it matters — the CLI would keep asserting that two reports print while
 * the bundle it printed them from stopped resembling anything the runner writes.
 *
 * Everything here writes a HEALTHY bundle by default and takes overrides for the
 * broken shapes, so a test names only the one thing it is about.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { selectRoster } from "../core/roster/select.ts"
import { candidate, fakeChange } from "../core/test-support/fakes.ts"
import { LABELLED_CHANGE_SEAL } from "../fixtures/seeded-defects/seal.ts"
import { PREFIX_DIRECTORY, PREFIX_EVIDENCE_VERSION, PREFIX_FILE, type BundleArm } from "./bundle.ts"
import { known } from "./manifest.ts"
import { writeBundle, type Fake } from "./read-bundle.fixture.ts"
import {
  appendSlotStatus,
  createSchedule,
  type Arm,
  type CoinFace,
  type PairedSchedule,
} from "./schedule.ts"

export const PROTOCOL_FILE = fileURLToPath(
  new URL("../_bmad-output/specs/spec-mad-orchestrator/evaluation-protocol.md", import.meta.url),
)
export const WORKTREE = fileURLToPath(new URL("..", import.meta.url))

export function rosterOf(count = 2) {
  return selectRoster(
    [candidate("anthropic", "claude-sonnet-4-5"), candidate("openai", "gpt-5"), candidate("google", "gemini-2.5-pro")].slice(0, count),
    { slots: count, providerConfigKey: "provider" },
  )
}

/** The inputs `createSchedule` and `runPairedBlocks` are both given. */
export function scheduleInput(root: string, roster = rosterOf().roster) {
  return {
    bundleRoot: root,
    protocolFile: PROTOCOL_FILE,
    fixture: LABELLED_CHANGE_SEAL,
    codeRevision: known({ commit: "abc123", dirty: false }),
    roster,
    change: fakeChange(),
    config: { provenance: "scripted" as const },
  }
}

/** Seal a real schedule at an existing root. Nothing is billed and nothing runs. */
export async function sealSchedule(root: string, coin: CoinFace = "heads"): Promise<PairedSchedule> {
  const created = await createSchedule({
    ...scheduleInput(root),
    createdAt: "2026-09-14T00:00:00.000Z",
    coin: () => coin,
  })
  if (!created.ok) throw new Error(created.reason)
  return created.schedule
}

/** One finding, carrying only what `verdictState` and `parseManifest` read. */
export type FindingSpec = { id: string; verdict?: string; unresolved?: boolean }

export function findingsOf(specs: readonly FindingSpec[]): unknown {
  return {
    pool: specs.map((spec) => ({
      id: spec.id,
      claim: `claim ${spec.id}`,
      ...(spec.verdict === undefined ? {} : { verdict: spec.verdict }),
      ...(spec.unresolved === true ? { unresolved: { why: "the budget refused it before it was decided" } } : {}),
    })),
    canonicalIds: specs.map((spec) => spec.id),
  }
}

export interface ArmSpec {
  block: number
  arm: Arm
  /** Defaults to this block's own prefix. Set it to break the pair. */
  prefixRunId?: string
  findings?: FindingSpec[]
  /** `null` writes a `ran` with no `intervention`. Omitted writes one on the OFF arm. */
  intervention?: { toJudge: number; wouldHaveDebated: number } | null
  /** Overrides applied last, so a test can break exactly one field. */
  over?: Partial<Fake>
}

/**
 * The ON arm's canonical findings: four candidates, one of them left unresolved.
 * `f4` is raised here and not by OFF.
 */
export const BLOCK_ON: FindingSpec[] = [
  { id: "f1", verdict: "upheld" },
  { id: "f2", verdict: "upheld" },
  { id: "f3", unresolved: true },
  { id: "f4", verdict: "upheld" },
]
/** The OFF arm's: three shared ids and `f5`, with `f2` decided the other way. */
export const BLOCK_OFF: FindingSpec[] = [
  { id: "f1", verdict: "upheld" },
  { id: "f2", verdict: "judge-ruled-invalid" },
  { id: "f3", verdict: "judge-ruled-invalid" },
  { id: "f5", verdict: "upheld" },
]

/** One paired arm's manifest, bound to its planned slot in the sealed schedule. */
export function pairedFake(schedule: PairedSchedule, spec: ArmSpec): Fake {
  const slot = schedule.slots.find((planned) => planned.block === spec.block && planned.arm === spec.arm)
  if (slot === undefined) throw new Error(`block ${spec.block} ${spec.arm} is not a planned slot`)
  const prefixRunId = spec.prefixRunId ?? `run-prefix-${spec.block}`
  const intervention =
    spec.intervention === undefined ? (spec.arm === "off" ? { toJudge: 4, wouldHaveDebated: 3 } : null) : spec.intervention
  return {
    armId: spec.arm,
    repeatId: spec.block - 1,
    // The arm IS the routing policy: ON runs the shipped pathway, OFF the
    // evaluation-only debate-off policy. `parseManifest` refuses a disagreement.
    routingPolicy: spec.arm === "on" ? "shipped" : "debate-off",
    forkedFrom: known(prefixRunId),
    findings: findingsOf(spec.findings ?? (spec.arm === "on" ? BLOCK_ON : BLOCK_OFF)),
    routeCounts: {
      kind: "ran",
      counts: {
        toDebate: 0,
        toJudge: 4,
        toJudgeAtThreshold: 0,
        toJudgeNoPrior: 0,
        ...(intervention === null ? {} : { intervention }),
      },
    },
    experiment: {
      scheduleHash: schedule.scheduleHash,
      block: spec.block,
      arm: spec.arm,
      position: slot.position,
      prefixRunId,
    },
    ...spec.over,
  }
}

/** The six arms of a complete bundle, with any of them replaced. */
export function sixArms(schedule: PairedSchedule, over: readonly ArmSpec[] = []): Fake[] {
  const specs: ArmSpec[] = []
  for (const block of [1, 2, 3]) {
    for (const arm of ["on", "off"] as Arm[]) {
      specs.push(over.find((spec) => spec.block === block && spec.arm === arm) ?? { block, arm })
    }
  }
  return specs.map((spec) => pairedFake(schedule, spec))
}

/** The roster `runPairedBlocks` declares: `armId = arm`, `repeatId = block - 1`. */
export const DECLARED: BundleArm[] = [1, 2, 3].flatMap((block) => [
  { armId: "on", repeatId: block - 1 },
  { armId: "off", repeatId: block - 1 },
])

export async function writePrefix(
  root: string,
  schedule: PairedSchedule,
  block: number,
  over: Record<string, unknown> = {},
): Promise<void> {
  const directory = join(root, PREFIX_DIRECTORY, String(block - 1))
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, PREFIX_FILE),
    JSON.stringify({
      prefixEvidenceVersion: PREFIX_EVIDENCE_VERSION,
      scheduleHash: schedule.scheduleHash,
      block,
      prefixRunId: known(`run-prefix-${block}`),
      forked: true,
      reason: "the prefix was prepared once and forked into both arms",
      dump: null,
      ...over,
    }),
  )
}

export async function writeSlots(
  root: string,
  schedule: PairedSchedule,
  mode: "complete" | "started-only" | "absent" = "complete",
): Promise<void> {
  if (mode === "absent") return
  for (const slot of schedule.slots) {
    await appendSlotStatus(root, { ...slot, status: "started", reason: "the slot was started", at: "2026-09-14T00:00:01.000Z" })
    if (mode === "started-only") continue
    await appendSlotStatus(root, {
      ...slot,
      status: "completed",
      reason: "the continuation returned a record",
      at: "2026-09-14T00:00:02.000Z",
      runId: `run-${slot.arm}-${slot.block - 1}`,
    })
  }
}

export interface PairedBundleOptions {
  coin?: CoinFace
  arms?: readonly ArmSpec[]
  declared?: BundleArm[]
  /** Replaces the six-arm default outright, for tests that drop or break one. */
  written?: (schedule: PairedSchedule) => Fake[]
  prefixes?: number[]
  prefixOver?: Record<number, Record<string, unknown>>
  slots?: "complete" | "started-only" | "absent"
}

/** A complete, healthy paired bundle at an existing root, unless a test asks for less. */
export async function pairedBundleAt(root: string, options: PairedBundleOptions = {}): Promise<PairedSchedule> {
  const schedule = await sealSchedule(root, options.coin)
  await writeBundle(root, options.declared ?? DECLARED, options.written?.(schedule) ?? sixArms(schedule, options.arms ?? []))
  for (const block of options.prefixes ?? [1, 2, 3]) {
    await writePrefix(root, schedule, block, options.prefixOver?.[block] ?? {})
  }
  await writeSlots(root, schedule, options.slots)
  return schedule
}
