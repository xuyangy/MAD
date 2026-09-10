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
 * ## Four fields decide it, and an unknown is not one of them
 *
 * `protocolHash`, `fixtureHash`, `changeId.diffHash`, `codeRevision`. An arm
 * whose value for any of the four is `{ kind: "unknown" }` is segregated on that
 * ground alone: an unknown cannot be compared, so two arms that are both unknown
 * do not agree — they are both uncheckable, which is a different fact and the
 * one a reader must not mistake for a match.
 *
 * ## The majority cohort is not a vote on truth
 *
 * It is only how the reader picks which arms go in one table. Two-versus-two is
 * not a majority, and it renders as nothing comparable rather than as a winner.
 * The output says which cohort it used and how large it was, so a reader can
 * disagree with the choice.
 *
 * ## A missing arm needs a declared roster
 *
 * `bundle.json` is that roster, written before the arms ran. A reader that only
 * walked directories could never say *"arm `off` repeat 0 is missing"* — it could
 * only fail to mention it, which is the failure FR2 names.
 */

import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { BUNDLE_FILE, type BundleArm, type BundleIndex } from "./bundle.ts"
import { MANIFEST_FILE, MANIFEST_SCHEMA_VERSION, type Maybe, type RunManifest } from "./manifest.ts"

/** The four fields cross-arm comparability is decided on. */
export const COMPARABILITY_FIELDS = ["protocolHash", "fixtureHash", "changeId", "codeRevision"] as const
export type ComparabilityField = (typeof COMPARABILITY_FIELDS)[number]

export interface ArmRow {
  armId: string
  repeatId: number
  directory: string
  manifest: RunManifest
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
 * Read one bundle. The only failure that stops it is a bundle with no index —
 * without the declared roster there is no report to render, only a directory
 * listing, and FR2 asks for more than that.
 */
export async function readBundle(root: string): Promise<BundleReadOutcome> {
  let index: BundleIndex
  try {
    index = JSON.parse(await readFile(join(root, BUNDLE_FILE), "utf8")) as BundleIndex
  } catch (error) {
    return {
      error:
        `\`${join(root, BUNDLE_FILE)}\` could not be read (${error instanceof Error ? error.message : String(error)}). ` +
        `Without it the reader cannot name a missing arm, so it renders nothing rather than a report ` +
        `that quietly omits one.`,
    }
  }
  if (!Array.isArray(index.arms)) {
    return { error: `\`${BUNDLE_FILE}\` carries no \`arms\` list; it is not a bundle index.` }
  }

  const loaded: ArmRow[] = []
  const missing: MissingRow[] = []
  const unreadable: UnreadableRow[] = []

  for (const arm of index.arms) {
    const outcome = await loadArm(root, arm)
    if (outcome.kind === "loaded") loaded.push(outcome.row)
    else if (outcome.kind === "missing") missing.push(outcome.row)
    else unreadable.push(outcome.row)
  }

  const partition = partitionByCohort(loaded)
  return { root, index, ...partition, missing, unreadable }
}

type LoadOutcome =
  | { kind: "loaded"; row: ArmRow }
  | { kind: "missing"; row: MissingRow }
  | { kind: "unreadable"; row: UnreadableRow }

async function loadArm(root: string, arm: BundleArm): Promise<LoadOutcome> {
  const slot = join(root, arm.armId, String(arm.repeatId))
  let entries: string[]
  try {
    entries = (await readdir(slot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return {
      kind: "missing",
      row: {
        armId: arm.armId,
        repeatId: arm.repeatId,
        reason: "the bundle declared this arm and no dump was written for it",
      },
    }
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
    return {
      kind: "unreadable",
      row: {
        armId: arm.armId,
        repeatId: arm.repeatId,
        reason: `${entries.length} run directories share this arm and repeat slot (${entries.join(", ")}); the reader will not choose between them`,
      },
    }
  }

  const directory = join(slot, entries[0]!)
  let manifest: RunManifest
  try {
    manifest = JSON.parse(await readFile(join(directory, MANIFEST_FILE), "utf8")) as RunManifest
  } catch (error) {
    return {
      kind: "unreadable",
      row: {
        armId: arm.armId,
        repeatId: arm.repeatId,
        reason: `\`${MANIFEST_FILE}\` in \`${directory}\` could not be read (${error instanceof Error ? error.message : String(error)})`,
      },
    }
  }

  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    return {
      kind: "unreadable",
      row: {
        armId: arm.armId,
        repeatId: arm.repeatId,
        reason: `manifest schemaVersion ${String(manifest.schemaVersion)} is not one this reader knows (it knows ${MANIFEST_SCHEMA_VERSION})`,
      },
    }
  }

  return { kind: "loaded", row: { armId: arm.armId, repeatId: arm.repeatId, directory, manifest } }
}

/** The four values of one arm, or the reason it has none to compare. */
type Comparability =
  | { kind: "comparable"; key: Record<ComparabilityField, string> }
  | { kind: "uncomparable"; reason: string }

function comparabilityOf(manifest: RunManifest): Comparability {
  const identity = manifest.identity
  const raw: Record<ComparabilityField, Maybe<unknown> | string> = {
    protocolHash: identity.protocolHash,
    fixtureHash: identity.fixtureHash,
    codeRevision: identity.codeRevision,
    changeId: identity.changeId?.diffHash,
  }

  const key = {} as Record<ComparabilityField, string>
  const unknowns: string[] = []
  for (const field of COMPARABILITY_FIELDS) {
    const value = raw[field]
    if (typeof value === "string") {
      key[field] = value
      continue
    }
    if (value !== undefined && value !== null && typeof value === "object" && "kind" in value) {
      if (value.kind === "known") {
        key[field] = JSON.stringify((value as { value: unknown }).value)
        continue
      }
      unknowns.push(`${field} is unknown (${String((value as { why?: string }).why ?? "no reason recorded")})`)
      continue
    }
    unknowns.push(`${field} is unknown (the manifest carries no readable value for it)`)
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
    return {
      cohort: {
        kind: "unknown",
        why:
          sizes.length === 0
            ? "no arm carried a comparable identity"
            : `no majority cohort: ${tied} groups of ${largest} arm(s) each`,
      },
      cohortSize: 0,
      comparable: [],
      segregated: [
        ...uncomparable,
        ...keyed.map((entry) => ({
          ...entry.row,
          reason:
            sizes.length === 0
              ? "no arm carried a comparable identity"
              : `no majority cohort: ${tied} groups of ${largest} arm(s) each, so no group is the evaluation's`,
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
      reason: `differs from the majority cohort on: ${differing.join(", ")}`,
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
    lines.push(`  cohort of ${result.cohortSize}, agreeing on:`)
    for (const field of COMPARABILITY_FIELDS) {
      lines.push(`    ${field} = ${result.cohort.value[field]}`)
    }
  } else {
    lines.push(`  none — ${result.cohort.why}`)
  }
  lines.push("")

  if (result.comparable.length > 0) {
    lines.push(
      "  arm            repeat  slots  answered  pooled  canonical  status      tokens",
    )
    for (const row of result.comparable) {
      const manifest = row.manifest
      lines.push(
        "  " +
          pad(row.armId, 15) +
          pad(String(row.repeatId), 8) +
          pad(String(manifest.roster.filled), 7) +
          pad(String(manifest.roster.answered), 10) +
          pad(String(manifest.findings.pool.length), 8) +
          pad(String(manifest.findings.canonicalIds.length), 11) +
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
  }

  lines.push(
    "USAGE COMPLETENESS is `unaudited` for every run in this bundle: the mechanism that could",
  )
  lines.push(
    "check it is story 2.3's and does not exist yet. Read every token figure here as observed",
  )
  lines.push("spend, never as a complete bill.")
  return `${lines.join("\n")}\n`
}

function pad(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value + " ".repeat(width - value.length)
}

function totalTokens(manifest: RunManifest): number {
  const total = manifest.spend.total
  return total.input + total.output + total.reasoning + total.cacheRead + total.cacheWrite
}
