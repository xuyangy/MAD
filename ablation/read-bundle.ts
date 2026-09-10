/**
 * FR2 (story 2.2) — the multi-arm reader.
 *
 * Several arms of one evaluation are dumped separately. This module reads them
 * back into ONE report and, before it draws a single cross-arm line, decides
 * which of them were measuring the same thing.
 *
 * ## Segregation, not rejection
 *
 * FR2 permits either. This reader SEGREGATES, because rejection loses the
 * evidence: a bundle where one arm ran against a different commit is exactly the
 * situation a reader needs to see, and a reader that exits on it hands them
 * nothing to look at. Segregation with a named reason is the honest form of the
 * same refusal — the arm is kept, shown, and kept out of every comparison.
 *
 * ## EVERY MANIFEST IS PARSED, NEVER CAST
 *
 * A file on disk is input, not a value of a TypeScript type, and this module read
 * it as the latter until a review said so (finding 2, 2026-09-10). A `null`
 * manifest threw on `schemaVersion`; a manifest missing `identity` threw on the
 * field after it; and — worse than either crash — a `{"kind":"known"}` with no
 * `value` produced the comparison key `undefined`, so two malformed arms AGREED
 * and entered the table as a cohort. Everything now goes through `parseManifest`,
 * whose failures are per-arm: one unreadable file cannot take its healthy
 * siblings' report down with it.
 *
 * ## The persisted findings are VALIDATED on load
 *
 * `fromPersistedFindings` existed from the first commit of this story and the
 * reader never called it (finding 3, 2026-09-10), so a manifest with duplicate
 * pool ids or a dangling `canonicalIds` entry was admitted and its counts
 * printed. AC6 is a property of what the reader accepts, not of a helper that
 * passes its own unit tests.
 *
 * ## Four fields decide comparability, and an unknown is not one of them
 *
 * `protocolHash`, `fixtureHash`, `changeId.diffHash`, `codeRevision`. An arm
 * whose value for any of the four is `{ kind: "unknown" }` is segregated on that
 * ground alone: an unknown cannot be compared, so two arms that are both unknown
 * do not agree — they are both uncheckable, which is a different fact and the
 * one a reader must not mistake for a match.
 *
 * ## The cohort is a PLURALITY, and the word matters
 *
 * The largest group wins outright; a tie for largest yields no cohort at all. It
 * is deliberately NOT a majority rule — three arms out of seven can be the
 * cohort — and this module called it "majority" for one commit, which is a
 * different and stronger claim than the code makes (review, 2026-09-10). It is
 * only how the reader picks which arms go in one table, and the output says which
 * group it used and how large it was, so a reader can disagree with the choice.
 *
 * ## A missing arm needs a declared roster
 *
 * `bundle.json` is that roster, written before the arms ran. A reader that only
 * walked directories could never say *"arm `off` repeat 0 is missing"* — it could
 * only fail to mention it, which is the failure FR2 names.
 */

import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import type { Finding } from "../core/domain/finding.ts"
import { BUNDLE_FILE, type BundleArm, type BundleIndex } from "./bundle.ts"
import {
  MANIFEST_FILE,
  MANIFEST_SCHEMA_VERSION,
  fromPersistedFindings,
  type Maybe,
  type RunManifest,
} from "./manifest.ts"

/** The four fields cross-arm comparability is decided on. */
export const COMPARABILITY_FIELDS = ["protocolHash", "fixtureHash", "changeId", "codeRevision"] as const
export type ComparabilityField = (typeof COMPARABILITY_FIELDS)[number]

export interface ArmRow {
  armId: string
  repeatId: number
  directory: string
  manifest: RunManifest
  /**
   * The canonical findings as reconstructed from the persisted form — the SAME
   * objects as their entries in `manifest.findings.pool` (AC6).
   *
   * It is on the row rather than left to a later caller because the validation
   * that produces it is what admitted the arm at all: a row exists only if its
   * findings round-tripped.
   */
  findings: Finding[]
}

export interface SegregatedRow extends ArmRow {
  reason: string
}

export interface MissingRow {
  armId: string
  repeatId: number
  reason: string
}

export interface UnreadableRow {
  armId: string
  repeatId: number
  reason: string
}

export interface BundleReadResult {
  root: string
  index: BundleIndex
  /** The agreed values, when a cohort was found. */
  cohort: Maybe<Record<ComparabilityField, string>>
  cohortSize: number
  comparable: ArmRow[]
  segregated: SegregatedRow[]
  missing: MissingRow[]
  unreadable: UnreadableRow[]
}

export type BundleReadOutcome = BundleReadResult | { error: string }

/**
 * Read one bundle. The only failure that stops it is a bundle whose index is
 * missing or unreadable — without the declared roster there is no report to
 * render, only a directory listing, and FR2 asks for more than that.
 *
 * Every other failure is per-arm and lands in `unreadable` or `missing`.
 */
export async function readBundle(root: string): Promise<BundleReadOutcome> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(root, BUNDLE_FILE), "utf8"))
  } catch (error) {
    return {
      error:
        `\`${join(root, BUNDLE_FILE)}\` could not be read (${message(error)}). ` +
        `Without it the reader cannot name a missing arm, so it renders nothing rather than a report ` +
        `that quietly omits one.`,
    }
  }

  const index = parseIndex(raw)
  if (!index.ok) {
    return { error: `\`${join(root, BUNDLE_FILE)}\` is not a bundle index: ${index.reason}` }
  }

  const loaded: ArmRow[] = []
  const missing: MissingRow[] = []
  const unreadable: UnreadableRow[] = []

  for (const arm of index.value.arms) {
    const outcome = await loadArm(root, arm)
    if (outcome.kind === "loaded") loaded.push(outcome.row)
    else if (outcome.kind === "missing") missing.push(outcome.row)
    else unreadable.push(outcome.row)
  }

  const partition = partitionByCohort(loaded)
  return { root, index: index.value, ...partition, missing, unreadable }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The index, validated rather than cast.
 *
 * A `null`, an array, or an `arms` list holding anything but `{armId, repeatId}`
 * would each have reached the loading loop and thrown somewhere less legible.
 */
function parseIndex(value: unknown): Parsed<BundleIndex> {
  if (!isRecord(value)) return { ok: false, reason: "it is not a JSON object" }
  if (!Array.isArray(value.arms)) return { ok: false, reason: "it carries no `arms` list" }
  const arms: BundleArm[] = []
  const slots = new Set<string>()
  for (const [position, entry] of value.arms.entries()) {
    if (!isRecord(entry) || typeof entry.armId !== "string" || typeof entry.repeatId !== "number") {
      return {
        ok: false,
        reason: `arms[${position}] is not \`{ armId: string, repeatId: number }\``,
      }
    }
    // A DUPLICATE SLOT IS A CORRUPT ROSTER, NOT A REPEATED MEASUREMENT (recheck of
    // 7bf0558). One declared twice loads ONE directory twice, and the per-arm
    // observation count then reported two observations of one run and told the
    // reader to compare a within-arm spread between a run and itself. Deduping
    // silently would be worse than refusing: it would make a bundle whose index
    // disagrees with its own contents look healthy. The count downstream is a
    // count of rows, and this is what makes rows and slots the same thing.
    const slot = `${entry.armId}/${entry.repeatId}`
    if (slots.has(slot)) {
      return {
        ok: false,
        reason:
          `it declares \`${slot}\` more than once. One slot is one run, so a repeated ` +
          `declaration would count a single measurement as several.`,
      }
    }
    slots.add(slot)
    arms.push({ armId: entry.armId, repeatId: entry.repeatId })
  }
  return {
    ok: true,
    value: {
      schemaVersion: typeof value.schemaVersion === "number" ? value.schemaVersion : 0,
      createdAt: typeof value.createdAt === "string" ? value.createdAt : "an unrecorded time",
      arms,
    },
  }
}

type LoadOutcome =
  | { kind: "loaded"; row: ArmRow }
  | { kind: "missing"; row: MissingRow }
  | { kind: "unreadable"; row: UnreadableRow }

function unreadable(arm: BundleArm, reason: string): LoadOutcome {
  return { kind: "unreadable", row: { armId: arm.armId, repeatId: arm.repeatId, reason } }
}

async function loadArm(root: string, arm: BundleArm): Promise<LoadOutcome> {
  const slot = join(root, arm.armId, String(arm.repeatId))
  let entries: string[]
  try {
    entries = (await readdir(slot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    entries = []
  }

  if (entries.length === 0) {
    return {
      kind: "missing",
      row: {
        armId: arm.armId,
        repeatId: arm.repeatId,
        reason: "the bundle declared this arm and no dump was written for it",
      },
    }
  }

  // TWO RUNS IN ONE SLOT IS NOT A CHOICE THIS READER MAKES. Picking the first,
  // the newest, or the largest would each be an answer to "which run was the
  // real one?" that the bundle does not contain.
  if (entries.length > 1) {
    return unreadable(
      arm,
      `${entries.length} run directories share this arm and repeat slot (${entries.join(", ")}); the reader will not choose between them`,
    )
  }

  const directory = join(slot, entries[0]!)
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(directory, MANIFEST_FILE), "utf8"))
  } catch (error) {
    return unreadable(
      arm,
      `\`${MANIFEST_FILE}\` in \`${directory}\` could not be read (${message(error)})`,
    )
  }

  const parsed = parseManifest(raw)
  if (!parsed.ok) {
    return unreadable(arm, `\`${MANIFEST_FILE}\` in \`${directory}\` ${parsed.reason}`)
  }
  const manifest = parsed.value

  // THE MANIFEST MUST AGREE WITH THE SLOT IT WAS FOUND IN (review finding 5,
  // 2026-09-10). The directory names the arm and the file names the arm, and
  // taking the directory's word for it meant a dump copied into another arm's
  // slot printed as that other arm: one measurement shown twice, the real one
  // silently gone. A disagreement is not something to resolve in favour of
  // either side — it is a corrupt bundle, and it says so.
  if (manifest.identity.armId !== arm.armId || manifest.identity.repeatId !== arm.repeatId) {
    return unreadable(
      arm,
      `the manifest in \`${directory}\` says it is arm \`${manifest.identity.armId}\` repeat ` +
        `${manifest.identity.repeatId}, but it is filed under arm \`${arm.armId}\` repeat ${arm.repeatId}`,
    )
  }

  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    return unreadable(
      arm,
      `manifest schemaVersion ${String(manifest.schemaVersion)} is not one this reader knows (it knows ${MANIFEST_SCHEMA_VERSION})`,
    )
  }

  // AC6, ON AN ACTUAL LOAD (review finding 3, 2026-09-10). The validator is the
  // reader's admission test, not a helper with its own passing unit tests.
  const reconstructed = fromPersistedFindings(manifest.findings)
  if (!reconstructed.ok) {
    return unreadable(arm, `its persisted findings do not reconstruct: ${reconstructed.reason}`)
  }

  return {
    kind: "loaded",
    row: { armId: arm.armId, repeatId: arm.repeatId, directory, manifest, findings: reconstructed.findings },
  }
}

/**
 * A manifest, validated field by field — INCLUDING INSIDE ITS ARRAYS.
 *
 * The first version of this function checked only the top level, and a recheck
 * showed that was finding 2 moved one level down rather than fixed: an array
 * whose ELEMENTS were junk passed, and then `renderBundle` threw on
 * `stage.stage`, the new disclosures code threw on `warning.disclosure`, and a
 * `mergedIds` that was an object threw *inside* the reconstructor. A `known`
 * carrying `null` was accepted as a comparison key, so two equally malformed arms
 * agreed all over again.
 *
 * THE RULE IS: EVERY VALUE THIS READER OR ITS RENDERER TOUCHES IS CHECKED HERE.
 * A cast at the end is only honest if the checked set is the touched set, and
 * that is what the length of this function buys. Failures stay per-arm, so one
 * malformed file still cannot cost its healthy siblings their report.
 */
export function parseManifest(value: unknown): Parsed<RunManifest> {
  if (!isRecord(value)) return { ok: false, reason: "is not a JSON object" }
  if (typeof value.schemaVersion !== "number") {
    return { ok: false, reason: "carries no numeric `schemaVersion`" }
  }

  const fail = (reason: string): Parsed<RunManifest> => ({ ok: false, reason })

  // ---- identity ----
  const identity = value.identity
  if (!isRecord(identity)) return fail("carries no `identity` object")
  if (!isText(identity.armId) || !isCount(identity.repeatId)) {
    return fail("carries no `identity.armId` / `identity.repeatId`")
  }
  const changeId = identity.changeId
  if (!isRecord(changeId) || !isText(changeId.diffHash) || typeof changeId.description !== "string") {
    return fail("carries no readable `identity.changeId`")
  }
  if (!isStringArray(changeId.files)) return fail("has a non-string `identity.changeId.files` entry")
  for (const field of ["protocolHash", "fixtureHash"] as const) {
    const problem = maybeOf(identity[field], isText, "a non-empty string")
    if (problem !== undefined) return fail(`has a malformed \`identity.${field}\`: ${problem}`)
  }
  const revision = maybeOf(
    identity.codeRevision,
    (payload) => isRecord(payload) && isText(payload.commit) && typeof payload.dirty === "boolean",
    "`{ commit: string, dirty: boolean }`",
  )
  if (revision !== undefined) return fail(`has a malformed \`identity.codeRevision\`: ${revision}`)

  // ---- run ----
  const run = value.run
  if (!isRecord(run) || !isText(run.runId) || typeof run.startedAt !== "string") {
    return fail("carries no readable `run`")
  }
  const finished = maybeOf(run.finishedAt, (payload) => typeof payload === "string", "a string")
  if (finished !== undefined) return fail(`has a malformed \`run.finishedAt\`: ${finished}`)

  // ---- roster ----
  const roster = value.roster
  if (
    !isRecord(roster) ||
    !isCount(roster.requested) ||
    !isCount(roster.filled) ||
    !isCount(roster.answered) ||
    !isCount(roster.distinctLineages)
  ) {
    return fail("carries no readable `roster` counts")
  }
  if (!isStringArray(roster.skippedForBudget)) {
    return fail("has a non-string `roster.skippedForBudget` entry")
  }
  if (!isStringArray(roster.providers)) return fail("has a non-string `roster.providers` entry")
  if (!Array.isArray(roster.slots) || !Array.isArray(roster.lensSlots)) {
    return fail("carries no `roster.slots` / `roster.lensSlots` lists")
  }

  // ---- dials ----
  const dials = value.dials
  if (
    !isRecord(dials) ||
    !isFinite_(dials.threshold) ||
    !isCount(dials.maxRounds) ||
    !isCount(dials.maxConcurrency) ||
    !(dials.cap === null || isCount(dials.cap))
  ) {
    return fail("carries no readable `dials`")
  }
  const shares = dials.shares
  if (
    !isRecord(shares) ||
    !isFinite_(shares.discover) ||
    !isFinite_(shares.debate) ||
    !isFinite_(shares.judge)
  ) {
    return fail("carries no readable `dials.shares`")
  }
  const preset = maybeOf(dials.preset, isText, "a non-empty string")
  if (preset !== undefined) return fail(`has a malformed \`dials.preset\`: ${preset}`)

  // ---- spend ----
  const spend = value.spend
  if (!isRecord(spend) || !Array.isArray(spend.perStage)) {
    return fail("carries no readable `spend`")
  }
  for (const [position, stage] of spend.perStage.entries()) {
    if (
      !isRecord(stage) ||
      !isText(stage.stage) ||
      !isFinite_(stage.spent) ||
      !isFinite_(stage.total) ||
      !(stage.ceiling === null || isFinite_(stage.ceiling))
    ) {
      return fail(`has an unreadable \`spend.perStage[${position}]\``)
    }
  }
  const total = spend.total
  if (
    !isRecord(total) ||
    !isFinite_(total.input) ||
    !isFinite_(total.output) ||
    !isFinite_(total.reasoning) ||
    !isFinite_(total.cacheRead) ||
    !isFinite_(total.cacheWrite)
  ) {
    // NOT A TOLERATED GAP. `{}` here used to reach the table and print `NaN`
    // tokens, which is a number-shaped hole in the one column a reader most
    // wants to trust.
    return fail("carries no readable `spend.total`")
  }
  if (typeof spend.usageCompleteness !== "string") {
    return fail("carries no `spend.usageCompleteness`")
  }

  // ---- status ----
  const status = value.status
  if (!isRecord(status) || !isText(status.completion) || !Array.isArray(status.warnings)) {
    return fail("carries no readable `status`")
  }
  for (const [position, warning] of status.warnings.entries()) {
    if (
      !isRecord(warning) ||
      !isText(warning.code) ||
      typeof warning.disclosure !== "boolean" ||
      typeof warning.message !== "string"
    ) {
      return fail(`has an unreadable \`status.warnings[${position}]\``)
    }
  }
  const cancelled = maybeOf(status.cancelledAt, (payload) => typeof payload === "string", "a string")
  if (cancelled !== undefined) return fail(`has a malformed \`status.cancelledAt\`: ${cancelled}`)

  // ---- findings ----
  const findings = value.findings
  if (!isRecord(findings) || !Array.isArray(findings.pool) || !Array.isArray(findings.canonicalIds)) {
    return fail("carries no `findings.pool` / `findings.canonicalIds`")
  }
  for (const [position, entry] of findings.pool.entries()) {
    if (!isRecord(entry) || !isText(entry.id)) {
      return fail(`has a pool entry at [${position}] with no string \`id\``)
    }
    // `mergedIds` IS ITERATED BY THE RECONSTRUCTOR. An object here threw
    // "`{}` is not iterable" out of `fromPersistedFindings` — inside `readBundle`,
    // where nothing caught it.
    if (entry.mergedIds !== undefined && !isStringArray(entry.mergedIds)) {
      return fail(`has a pool entry at [${position}] whose \`mergedIds\` is not a list of strings`)
    }
  }
  if (!isStringArray(findings.canonicalIds)) {
    return fail("has a non-string `canonicalIds` entry")
  }

  // ---- stage outputs ----
  const outputs = value.stageOutputs
  if (!isRecord(outputs) || typeof outputs.recordFile !== "string") {
    return fail("carries no readable `stageOutputs`")
  }
  const turnFiles = maybeOf(outputs.turnFiles, isCount, "a whole number")
  if (turnFiles !== undefined) return fail(`has a malformed \`stageOutputs.turnFiles\`: ${turnFiles}`)

  return { ok: true, value: value as unknown as RunManifest }
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isFinite_(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isCount(value: unknown): value is number {
  return isFinite_(value) && Number.isInteger(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

/**
 * Returns the reason a `Maybe` wrapper is malformed, or `undefined` when it is
 * fine — INCLUDING the type of what a `known` carries.
 *
 * The first version checked only `value !== undefined`, so
 * `{kind:"known", value:null}` was accepted and became the comparison key
 * `"null"`. Two arms carrying it then AGREED — the exact defect the
 * unknown-is-not-agreement rule exists to prevent, re-entering through a
 * malformed payload instead of through an honest unknown.
 */
function maybeOf(
  value: unknown,
  ok: (payload: unknown) => boolean,
  expected: string,
): string | undefined {
  if (!isRecord(value)) return "it is not a `{ kind }` wrapper"
  if (value.kind === "unknown") {
    return typeof value.why === "string" ? undefined : "an `unknown` with no string `why`"
  }
  if (value.kind === "known") {
    if (!("value" in value)) return "a `known` carrying no `value`"
    return ok(value.value) ? undefined : `a \`known\` whose value is not ${expected}`
  }
  return `an unrecognised kind \`${String(value.kind)}\``
}

/** The four values of one arm, or the reason it has none to compare. */
type Comparability =
  | { kind: "comparable"; key: Record<ComparabilityField, string> }
  | { kind: "uncomparable"; reason: string }

function comparabilityOf(manifest: RunManifest): Comparability {
  const identity = manifest.identity as unknown as Record<string, unknown>
  const wrappers: Record<ComparabilityField, unknown> = {
    protocolHash: identity.protocolHash,
    fixtureHash: identity.fixtureHash,
    codeRevision: identity.codeRevision,
    // Not a `Maybe` — `changeId.diffHash` is computed from bytes MAD holds, so it
    // is either there or the manifest failed `parseManifest`.
    changeId: { kind: "known", value: manifest.identity.changeId.diffHash },
  }

  const key = {} as Record<ComparabilityField, string>
  const unknowns: string[] = []
  for (const field of COMPARABILITY_FIELDS) {
    const wrapper = wrappers[field] as { kind: string; value?: unknown; why?: string }
    if (wrapper.kind === "known") {
      key[field] = JSON.stringify(wrapper.value)
      continue
    }
    unknowns.push(`${field} is unknown (${String(wrapper.why)})`)
  }

  if (unknowns.length > 0) {
    return {
      kind: "uncomparable",
      reason: `cannot be compared: ${unknowns.join("; ")}. An unknown is not agreement.`,
    }
  }
  return { kind: "comparable", key }
}

interface Partition {
  cohort: Maybe<Record<ComparabilityField, string>>
  cohortSize: number
  comparable: ArmRow[]
  segregated: SegregatedRow[]
}

function partitionByCohort(loaded: readonly ArmRow[]): Partition {
  const uncomparable: SegregatedRow[] = []
  const keyed: { row: ArmRow; key: Record<ComparabilityField, string>; serialized: string }[] = []

  for (const row of loaded) {
    const comparability = comparabilityOf(row.manifest)
    if (comparability.kind === "uncomparable") {
      uncomparable.push({ ...row, reason: comparability.reason })
      continue
    }
    keyed.push({
      row,
      key: comparability.key,
      serialized: COMPARABILITY_FIELDS.map((field) => `${field}=${comparability.key[field]}`).join("|"),
    })
  }

  const groups = new Map<string, typeof keyed>()
  for (const entry of keyed) {
    const group = groups.get(entry.serialized) ?? []
    group.push(entry)
    groups.set(entry.serialized, group)
  }

  const sizes = [...groups.values()].map((group) => group.length)
  const largest = sizes.length === 0 ? 0 : Math.max(...sizes)
  const tied = sizes.filter((size) => size === largest).length

  // A TIE IS NOT A COHORT. Picking either side would publish one group's
  // configuration as the evaluation's, on nothing but iteration order.
  if (largest === 0 || tied > 1) {
    const why =
      sizes.length === 0
        ? "no arm carried a comparable identity"
        : `no plurality cohort: ${tied} groups of ${largest} arm(s) each`
    return {
      cohort: { kind: "unknown", why },
      cohortSize: 0,
      comparable: [],
      segregated: [
        ...uncomparable,
        ...keyed.map((entry) => ({
          ...entry.row,
          reason:
            sizes.length === 0
              ? why
              : `${why}, so no group is the evaluation's`,
        })),
      ],
    }
  }

  const winner = [...groups.values()].find((group) => group.length === largest)!
  const cohortKey = winner[0]!.key
  const segregated: SegregatedRow[] = [...uncomparable]
  for (const entry of keyed) {
    if (entry.serialized === winner[0]!.serialized) continue
    const differing = COMPARABILITY_FIELDS.filter((field) => entry.key[field] !== cohortKey[field])
    segregated.push({
      ...entry.row,
      reason: `differs from the largest cohort on: ${differing.join(", ")}`,
    })
  }

  return {
    cohort: { kind: "known", value: cohortKey },
    cohortSize: largest,
    comparable: winner.map((entry) => entry.row),
    segregated,
  }
}

/**
 * Render the bundle as plain text.
 *
 * ## What is NOT here, and why
 *
 * No fused number. AD-9's rule holds one level up as much as it does inside a
 * run: a token count and a finding count have no exchange rate, and inventing
 * one here would be the "was it worth it?" score `ablation/compare.ts` refuses to
 * compute. This report puts the arms side by side and stops.
 *
 * It also draws no cross-arm FINDING comparison, deliberately: pairing is
 * `ablation/align.ts`'s job and the paired-block design is story 2.5/2.5A's. The
 * closing note says so, because "the arms are comparable" and "the arms have been
 * compared" are different claims.
 *
 * ## What is at the TOP, and why
 *
 * Segregated, missing and unreadable arms print ABOVE the table. A reader must
 * not be able to read the comparison without first seeing what is not in it —
 * the exact ordering `core/stages/output.ts` uses for degradation.
 */
export function renderBundle(result: BundleReadResult): string {
  const lines: string[] = []
  const incomplete =
    result.segregated.length > 0 || result.missing.length > 0 || result.unreadable.length > 0

  lines.push(`MAD evaluation bundle — ${result.root}`)
  lines.push(`declared ${result.index.arms.length} arm-repeat(s), created ${result.index.createdAt}`)
  lines.push("")

  if (incomplete) {
    lines.push("THIS BUNDLE IS INCOMPLETE.")
    lines.push("Arms are listed below with the reason they are not in the table.")
    lines.push("This report makes no cross-arm claim from a bundle in this state.")
    lines.push("")
  }

  if (result.unreadable.length > 0) {
    lines.push("UNREADABLE ARMS")
    for (const row of result.unreadable) {
      lines.push(`  ${row.armId} repeat ${row.repeatId} — ${row.reason}`)
    }
    lines.push("")
  }

  if (result.missing.length > 0) {
    lines.push("MISSING ARMS")
    for (const row of result.missing) {
      lines.push(`  ${row.armId} repeat ${row.repeatId} — ${row.reason}`)
    }
    lines.push("")
  }

  if (result.segregated.length > 0) {
    lines.push("SEGREGATED ARMS — kept, shown, and out of every comparison")
    for (const row of result.segregated) {
      lines.push(`  ${row.armId} repeat ${row.repeatId} — ${row.reason}`)
      lines.push(`    ${row.directory}`)
    }
    lines.push("")
  }

  lines.push("COMPARABLE ARMS")
  if (result.cohort.kind === "known") {
    lines.push(`  largest cohort, ${result.cohortSize} arm(s), agreeing on:`)
    for (const field of COMPARABILITY_FIELDS) {
      lines.push(`    ${field} = ${result.cohort.value[field]}`)
    }
  } else {
    lines.push(`  none — ${result.cohort.why}`)
  }
  lines.push("")

  if (result.comparable.length > 0) {
    lines.push("  arm            repeat  slots  answered  pooled  canonical  status      tokens")
    for (const row of result.comparable) {
      const manifest = row.manifest
      lines.push(
        "  " +
          pad(row.armId, 15) +
          pad(String(row.repeatId), 8) +
          pad(String(manifest.roster.filled), 7) +
          pad(String(manifest.roster.answered), 10) +
          pad(String(manifest.findings.pool.length), 8) +
          pad(String(row.findings.length), 11) +
          pad(manifest.status.completion, 12) +
          String(totalTokens(manifest)),
      )
    }
    lines.push("")
    lines.push("  PER-STAGE SPEND AGAINST CEILING")
    for (const row of result.comparable) {
      for (const stage of row.manifest.spend.perStage) {
        lines.push(
          `    ${row.armId} repeat ${row.repeatId} — ${stage.stage}: ${stage.spent} spent, ` +
            `run total ${stage.total}, ceiling ${stage.ceiling === null ? "none" : stage.ceiling}`,
        )
      }
    }
    lines.push("")
    lines.push(...disclosures(result.comparable))
  }

  lines.push(
    "USAGE COMPLETENESS is `unaudited` for every run in this bundle: the mechanism that could",
  )
  lines.push(
    "check it is story 2.3's and does not exist yet. Read every token figure here as observed",
  )
  lines.push("spend, never as a complete bill.")
  lines.push(
    "NO FINDING WAS COMPARED ACROSS ARMS. This reader establishes that the arms are comparable;",
  )
  lines.push("pairing their findings is story 2.5/2.5A's work and is not attempted here.")
  return `${lines.join("\n")}\n`
}

/**
 * AC7 — the disclosures the manifest already carries and the table would
 * otherwise swallow (review finding 7, 2026-09-10).
 *
 * These are the bundle-level equivalents of what `ablation/report.ts` prints for
 * an in-memory ablation. The two the reader must not omit:
 *
 * - **DIALS THAT DIFFER.** Two arms agreeing on protocol, fixture, change and
 *   revision can still have been run at different thresholds or round caps, and
 *   then a difference between them is not attributable to the intervention. This
 *   is `report.ts`'s "THESE ARMS DIFFER IN MORE THAN THE ROSTER" said one level up.
 * - **THE NOISE FLOOR.** One repeat per arm cannot tell an arm difference from
 *   run-to-run variation, and saying nothing lets a reader assume it could.
 *
 * A degradation is also spelled out rather than left as the single word
 * `degraded` in a status column: AD-6's honesty rule is about naming the cause.
 */
function disclosures(comparable: readonly ArmRow[]): string[] {
  const lines: string[] = ["  DISCLOSURES"]

  const dialSets = new Map<string, string[]>()
  for (const row of comparable) {
    const dials = row.manifest.dials
    // THE SHARES ARE PART OF THE KEY (recheck, 2026-09-10). They were left out,
    // so two arms whose discovery share differed — 30% of the cap against 60% —
    // printed "dials equal across every comparable arm". A stage ceiling is a
    // dial: `core/budget/ledger.ts` derives every per-stage gate from it, so it
    // decides which findings can reach judgement at all.
    const key =
      `threshold ${dials.threshold}; round cap ${dials.maxRounds}; ` +
      `token cap ${dials.cap === null ? "none" : dials.cap}; peak ${dials.maxConcurrency}; ` +
      `shares ${dials.shares.discover}/${dials.shares.debate}/${dials.shares.judge}`
    const holders = dialSets.get(key) ?? []
    holders.push(`${row.armId}/${row.repeatId}`)
    dialSets.set(key, holders)
  }
  if (dialSets.size > 1) {
    lines.push("    THESE ARMS DIFFER IN MORE THAN THE INTERVENTION, so a difference between them")
    lines.push("    is not attributable to the intervention alone:")
    for (const [key, holders] of dialSets) {
      lines.push(`      ${holders.join(", ")}: ${key}`)
    }
  } else {
    lines.push(`    dials equal across every comparable arm (${[...dialSets.keys()][0]}).`)
  }

  // OBSERVATIONS PER ARM, NOT DISTINCT REPEAT IDS (recheck, 2026-09-10). The
  // union of `repeatId` across arms counted `control/0` plus `pool/1` as two
  // repeats and told the reader to compare within-arm spread, when each arm had
  // exactly one observation and no spread exists. A noise floor is a per-arm
  // fact, so it is reported per arm.
  const perArm = new Map<string, number>()
  for (const row of comparable) perArm.set(row.armId, (perArm.get(row.armId) ?? 0) + 1)
  const withSpread = [...perArm].filter(([, count]) => count > 1).map(([armId]) => armId)
  const withoutSpread = [...perArm].filter(([, count]) => count === 1).map(([armId]) => armId)

  lines.push(
    `    OBSERVATIONS PER ARM: ${[...perArm].map(([armId, count]) => `${armId} ${count}`).join(", ")}.`,
  )
  if (withSpread.length > 0) {
    lines.push(
      `    NOISE FLOOR: for ${withSpread.join(", ")}, compare the spread between repeats of the SAME`,
      `    arm against the difference between arms.`,
    )
  }
  if (withoutSpread.length > 0) {
    lines.push(
      `    NOISE FLOOR: NOT MEASURED for ${withoutSpread.join(", ")} — one run of an arm cannot tell a`,
      `    real arm difference from run-to-run variation.`,
    )
  }

  for (const row of comparable) {
    const degradations = row.manifest.status.warnings.filter((warning) => !warning.disclosure)
    const shown = row.manifest.status.warnings.filter((warning) => warning.disclosure)
    if (degradations.length > 0) {
      lines.push(
        `    ${row.armId}/${row.repeatId} DEGRADED — ${degradations.length} warning(s): ` +
          `${degradations.map((warning) => warning.code).join(", ")}`,
      )
    }
    if (shown.length > 0) {
      lines.push(
        `    ${row.armId}/${row.repeatId} disclosures: ${shown.map((warning) => warning.code).join(", ")}`,
      )
    }
    if (row.manifest.roster.skippedForBudget.length > 0) {
      // SCOPED TO THOSE SLOTS (recheck, 2026-09-10). This used to add "no model
      // failed and nobody cancelled", which is a claim about the WHOLE RUN and is
      // simply false beside a `model-dropped-out` warning or a cancelled status —
      // both of which can hold at the same time. The true, narrow statement is
      // about the named slots and nothing else.
      lines.push(
        `    ${row.armId}/${row.repeatId} the BUDGET refused ${row.manifest.roster.skippedForBudget.length} ` +
          `discovery slot(s) (${row.manifest.roster.skippedForBudget.join(", ")}): those slots were not ` +
          `attempted, and no model is blamed for them. It does not follow that nothing else reduced ` +
          `this run — read the warnings and the completion status beside it.`,
      )
    }
    if (row.manifest.roster.filled < row.manifest.roster.requested) {
      lines.push(
        `    ${row.armId}/${row.repeatId} the roster asked for ${row.manifest.roster.requested} slot(s) ` +
          `and filled ${row.manifest.roster.filled}`,
      )
    }
  }

  lines.push("")
  return lines
}

function pad(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value + " ".repeat(width - value.length)
}

function totalTokens(manifest: RunManifest): number {
  const total = manifest.spend.total
  return total.input + total.output + total.reasoning + total.cacheRead + total.cacheWrite
}
