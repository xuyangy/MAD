/**
 * FR8 (story 2-5d) — the paired reader, one matrix row at a time.
 *
 * Fakes only. Most cases build a bundle from `paired-read.fixture.ts`, because
 * that is the only way to write the broken shapes a reader meets on disk: a
 * schedule edited after sealing, an arm whose block disagrees with its slot, a
 * prefix evidence file bound to another schedule, a continuation that threw. One
 * case runs the REAL `runPairedBlocks` end to end and reads what it wrote, so
 * the fixture cannot drift away from the writer without this file noticing.
 *
 * WHERE A CLAIM IS ABOUT A COUNT, IT IS ASSERTED ON THE RESULT AND NOT ONLY ON
 * THE RENDERED TEXT. The availability table and the block bodies are built from
 * the same measurements, so a test reading only the text can watch the two
 * contradict each other and still pass.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ZodType } from "zod"

import { emptyTokenUsage, type TokenUsage } from "../core/domain/run-record.ts"
import { CODING_DISCOVERY_GENERALIST } from "../core/instructions/coding/discovery.ts"
import { cancelledTurn, type BackendCapabilities, type Envelope, type ModelBackend } from "../core/ports/model-backend.ts"
import { DEFAULT_JUDGE_ANSWERS, fakeClock, judgeRoleOf } from "../core/test-support/fakes.ts"
import { PREFIX_DIRECTORY, PREFIX_FILE } from "./bundle.ts"
import { HALT_MARKER_FILE } from "./governor.ts"
import { known, unknownValue } from "./manifest.ts"
import {
  allExcluded,
  readPairedBundle,
  renderPairedBundle,
  type PairedBlock,
  type PairedQuantity,
  type PairedReadResult,
} from "./paired-read.ts"
import {
  pairedBundleAt,
  rosterOf,
  scheduleInput,
  sealSchedule,
  sixArms,
  WORKTREE,
  type PairedBundleOptions,
} from "./paired-read.fixture.ts"
import { runPairedBlocks, type PairedPhaseContext } from "./paired.ts"
import { writeBundle } from "./read-bundle.fixture.ts"
import { appendSlotStatus, scheduleHashOf, SCHEDULE_FILE, SLOT_STATUS_FILE, type PairedSchedule } from "./schedule.ts"

const scratch: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mad-paired-read-"))
  scratch.push(dir)
  return dir
}

afterEach(async () => {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})

async function pairedBundle(options: PairedBundleOptions = {}): Promise<{ root: string; schedule: PairedSchedule }> {
  const root = await tempDir()
  return { root, schedule: await pairedBundleAt(root, options) }
}

async function read(root: string): Promise<PairedReadResult> {
  const result = await readPairedBundle(root)
  if ("error" in result) throw new Error(result.error)
  return result
}

function blockOf(result: PairedReadResult, block: number): PairedBlock {
  return result.blocks.find((entry) => entry.block === block)!
}

function availabilityOf(result: PairedReadResult, quantity: PairedQuantity) {
  return result.availability.find((entry) => entry.quantity === quantity)!
}

function exclusionText(result: PairedReadResult): string {
  return allExcluded(result)
    .map((entry) => entry.reason)
    .join(" | ")
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("the happy path — three complete blocks, six arms, heads", () => {
  test("every block pairs by `Finding.id`, with explicit denominators and 3/3 availability", async () => {
    const { root } = await pairedBundle()
    const result = await read(root)

    expect(result.blocks).toHaveLength(3)
    for (const block of result.blocks) {
      expect(block.result.kind).toBe("measured")
      if (block.result.kind !== "measured") continue
      const difference = block.result.difference
      // on f1..f4, off f1,f2,f3,f5 → three ids in both, five distinct.
      expect(difference.paired).toBe(3)
      expect(difference.distinct).toBe(5)
      expect(difference.onlyIn).toEqual({ on: 1, off: 1 })
      // f3 is unresolved on the ON side, so its pair is undecided and is in
      // NEITHER half of `differing of n`.
      expect(difference.undecided).toBe(1)
      expect(difference.of).toBe(2)
      expect(difference.differing).toBe(1)
      expect(difference.differences).toEqual([{ id: "f2", on: "upheld", off: "judge-ruled-invalid" }])
      expect(block.result.treatment).toEqual({ kind: "known", toJudge: 4, wouldHaveDebated: 3 })
    }
    for (const entry of result.availability) {
      expect(entry, entry.quantity).toMatchObject({ available: 3, of: 3, missing: [] })
    }
  })

  test("every measured result carries the anonymizer confound, the position order and the identification sentence", async () => {
    const { root } = await pairedBundle()
    const text = renderPairedBundle(await read(root))

    for (const block of [1, 2, 3]) {
      expect(text).toContain(`CONFOUNDS, BESIDE THIS RESULT — block ${block}`)
    }
    // Once per block, never once at the top of the report.
    expect(text.split("RUN ID / JUDGE ANONYMIZER")).toHaveLength(4)
    expect(text).toContain("the judge's anonymizer seeds its permutation")
    expect(text).toContain("`forkPreparedReview` in `core/run/review.ts`")
    expect(text.split("POSITION ORDER, WITHIN THIS BLOCK")).toHaveLength(4)
    expect(text).toContain("first: on, second: off")
    expect(text).toContain("first: off, second: on")
    expect(text.split("IDENTIFICATION. These are observed differences in the DEPLOYED debate pathway")).toHaveLength(4)
    expect(text).toContain("benefit of conversation with the judge pipeline held fixed")
    // The dial disclosures `read-bundle.ts` computes, over each block's two arms.
    expect(text).toContain("ROUTING POLICY DIFFERS, and that is the intervention")
  })

  test("every quantity names numerator and denominator, and no quantity line prints a float", async () => {
    const { root } = await pairedBundle()
    const text = renderPairedBundle(await read(root))

    expect(text).toContain("paired candidates, of the distinct candidate id(s) across the two arms: 3 of 5")
    expect(text).toContain("verdict-state differences, over the paired candidates where BOTH arms decided: 1 of 2")
    expect(text).toContain("above): 1 of 3")
    expect(text).toContain("only in on, of the distinct candidate id(s): 1 of 5")
    expect(text).toContain("only in off, of the distinct candidate id(s): 1 of 5")
    expect(text).toContain("treatment opportunity, of the candidate(s) the OFF arm sent to the judge: 3 of 4")
    expect(text).not.toContain("%")
    // NO FLOAT IN ANY QUANTITY. Checked on the quantity lines rather than on the
    // whole report, because the dial disclosures print the run's own `threshold`
    // and `shares` — settings, not rates, copied from the manifest.
    const quantities = text
      .split("\n")
      .filter((line) => /^ {2}(paired candidates|verdict-state differences|only in|treatment opportunity|arm )/.test(line))
    expect(quantities.length).toBeGreaterThan(0)
    for (const line of quantities) expect(line, line).not.toMatch(/\d\.\d/)
  })

  test("the schedule, the six slots, each prefix and the declared roster are stated above the results", async () => {
    const { root, schedule } = await pairedBundle()
    const text = renderPairedBundle(await read(root))

    expect(text).toContain(`sealed schedule ${schedule.scheduleHash}, coin heads, first arms on, off, on`)
    expect(text).toContain("SLOT COVERAGE — all six planned slots")
    expect(text.indexOf("SLOT COVERAGE")).toBeLessThan(text.indexOf("BLOCK 1"))
    expect(text.indexOf("AVAILABILITY")).toBeLessThan(text.indexOf("BLOCK 1"))
    // D3 — the bundle-level facts the reader loaded are surfaced, not discarded.
    expect(text).toContain("`bundle.json` declares 6 arm-repeat(s), created 2026-09-10T00:00:00.000Z")
    expect(text).toContain("admitted 6 to its cohort")
    for (const block of [1, 2, 3]) {
      expect(text).toContain(`block ${block}: prefix run \`run-prefix-${block}\`, forked`)
    }
    expect(text).toContain("both arms forked from `run-prefix-1`")
    expect(text).toContain("Add NEWLY EXECUTED figures across arms, then")
  })
})

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------

describe("the schedule", () => {
  test("ORDINARY BUNDLE: no `paired-schedule.json` refuses the paired report and still lists the arms", async () => {
    const root = await tempDir()
    await writeBundle(root, [{ armId: "on", repeatId: 0 }], [{ armId: "on", repeatId: 0 }])
    const result = await read(root)

    expect(result.schedule.ok).toBe(false)
    expect(result.blocks).toEqual([])
    const text = renderPairedBundle(result)
    expect(text).toContain("NO PAIRED RESULT: THE SCHEDULE IS REFUSED AS A WHOLE.")
    expect(text).toContain("on/0")
  })

  test("SELF-HASH: a schedule edited after sealing is refused as a whole, and the arms are still listed", async () => {
    const { root, schedule } = await pairedBundle()
    await writeFile(join(root, SCHEDULE_FILE), JSON.stringify({ ...schedule, createdAt: "2026-09-15T00:00:00.000Z" }))
    const result = await read(root)

    expect(result.schedule.ok).toBe(false)
    if (!result.schedule.ok) expect(result.schedule.reason).toContain("does not match its own scheduleHash")
    expect(result.blocks).toEqual([])
    const text = renderPairedBundle(result)
    for (const block of [1, 2, 3]) {
      expect(text).toContain(`on/${block - 1}`)
      expect(text).toContain(`off/${block - 1}`)
    }
    expect(text).not.toContain("paired candidates,")
  })

  test("A SCHEDULE THAT WAS NEVER SEALED is refused for that, not for being edited", async () => {
    const { root, schedule } = await pairedBundle()
    const { scheduleHash: _hash, ...unsealed } = schedule
    await writeFile(join(root, SCHEDULE_FILE), JSON.stringify(unsealed))
    const result = await read(root)

    expect(result.schedule.ok).toBe(false)
    if (!result.schedule.ok) {
      expect(result.schedule.reason).toContain("carries no string `scheduleHash`, so it was never sealed")
      expect(result.schedule.reason).not.toContain("edited after")
    }
  })

  test("SHAPE: an unknown `scheduleVersion` is refused before anything else is read", async () => {
    const { root, schedule } = await pairedBundle()
    await writeFile(join(root, SCHEDULE_FILE), JSON.stringify({ ...schedule, scheduleVersion: 99 }))
    const result = await read(root)
    expect(result.schedule.ok).toBe(false)
    if (!result.schedule.ok) expect(result.schedule.reason).toContain("schedule version 99")
  })

  test("SHAPE: a coin its order does not follow from is refused, with the disagreeing field named", async () => {
    const { root, schedule } = await pairedBundle()
    // Rehashed, so only the coin → firstArms chain can catch it.
    const { scheduleHash: _hash, ...rest } = schedule
    const forged = { ...rest, coin: "tails" as const }
    await writeFile(join(root, SCHEDULE_FILE), JSON.stringify({ ...forged, scheduleHash: scheduleHashOf(forged) }))
    const result = await read(root)

    expect(result.schedule.ok).toBe(false)
    if (!result.schedule.ok) {
      expect(result.schedule.reason).toContain("orders its first arms")
      expect(result.schedule.reason).toContain("the coin tails does not give")
    }
  })

  test("SHAPE: slots the first arms do not give are refused", async () => {
    const { root, schedule } = await pairedBundle()
    const { scheduleHash: _hash, ...rest } = schedule
    const forged = { ...rest, slots: schedule.slots.slice(0, 4) }
    await writeFile(join(root, SCHEDULE_FILE), JSON.stringify({ ...forged, scheduleHash: scheduleHashOf(forged) }))
    const result = await read(root)

    expect(result.schedule.ok).toBe(false)
    if (!result.schedule.ok) expect(result.schedule.reason).toContain("plans slots its first arms")
  })

  test("a refused schedule leaves every quantity at 0/3, each naming the schedule's reason", async () => {
    const { root, schedule } = await pairedBundle()
    await writeFile(join(root, SCHEDULE_FILE), JSON.stringify({ ...schedule, coin: "tails" }))
    const result = await read(root)

    for (const entry of result.availability) {
      expect(entry.available, entry.quantity).toBe(0)
      expect(entry.missing, entry.quantity).toHaveLength(3)
      expect(entry.missing[0]!.reason, entry.quantity).toContain("scheduleHash")
    }
  })

  test("A REFUSED SCHEDULE STILL FOLDS THE SLOT FILE: all six slots are reported, position unknown", async () => {
    // `paired-slots.jsonl` is appended without the schedule, so a schedule that
    // does not verify says nothing about what it recorded — and it is then the
    // only account left of what was attempted.
    const { root, schedule } = await pairedBundle()
    await writeFile(join(root, SCHEDULE_FILE), JSON.stringify({ ...schedule, coin: "tails" }))
    const result = await read(root)

    expect(result.slots).toHaveLength(6)
    expect(result.slots.every((slot) => slot.status === "completed")).toBe(true)
    expect(result.slots.every((slot) => slot.position === "unknown")).toBe(true)
    const text = renderPairedBundle(result)
    expect(text).toContain("SLOT COVERAGE — all six planned slots")
    expect(text).toContain("block 1 on (position unknown): completed")
  })
})

// ---------------------------------------------------------------------------
// Binding one arm
// ---------------------------------------------------------------------------

describe("each arm is checked against the schedule and against its own slot", () => {
  test.each([
    ["a schedule hash that is not the sealed one", { scheduleHash: `sha256:${"0".repeat(64)}` }, "is not the sealed schedule"],
    ["a block that is not `repeatId + 1`", { block: 3 }, "slot convention makes it block 1"],
    ["a position the schedule did not plan", { position: "second" }, "is not a slot the sealed schedule planned"],
  ])("%s excludes that arm and leaves the other blocks alone", async (_name, over, expected) => {
    const { root } = await pairedBundle({
      written: (schedule) => {
        const arms = sixArms(schedule)
        const broken = arms.find((fake) => fake.armId === "on" && fake.repeatId === 0)!
        broken.experiment = { ...(broken.experiment as Record<string, unknown>), ...over }
        return arms
      },
    })
    const result = await read(root)

    expect(blockOf(result, 1).result.kind).toBe("withheld")
    // The arm is named against the block whose DIRECTORY it sits in — block 1 —
    // whatever its own `experiment.block` claims.
    expect(blockOf(result, 1).excluded.map((entry) => entry.reason).join(" | ")).toContain(expected)
    expect(blockOf(result, 2).result.kind).toBe("measured")
    expect(blockOf(result, 3).result.kind).toBe("measured")
  })

  test("an arm filed under the other arm's id is excluded, and says which two claims disagree", async () => {
    // `parseManifest` binds `experiment.arm` to `dials.routingPolicy`, so the
    // only way to write this is an OFF-policy manifest filed in the ON slot.
    const { root } = await pairedBundle({
      written: (schedule) => {
        const arms = sixArms(schedule)
        const broken = arms.find((fake) => fake.armId === "on" && fake.repeatId === 0)!
        broken.routingPolicy = "debate-off"
        broken.experiment = { ...(broken.experiment as Record<string, unknown>), arm: "off" }
        return arms
      },
    })
    const result = await read(root)
    expect(exclusionText(result)).toContain("filed under arm `on` but its `experiment.arm` is `off`")
  })

  test("NO `experiment`: absence never qualifies a manifest as paired, and it is named as not paired", async () => {
    const { root } = await pairedBundle({
      written: (schedule) => {
        const arms = sixArms(schedule)
        const ordinary = arms.find((fake) => fake.armId === "off" && fake.repeatId === 1)!
        delete ordinary.experiment
        // Without the block there is no intervention to bind the policy to.
        ordinary.routingPolicy = "shipped"
        return arms
      },
    })
    const result = await read(root)

    expect(blockOf(result, 2).result.kind).toBe("withheld")
    const named = result.unbound.find((entry) => entry.armId === "off" && entry.repeatId === 1)
    expect(named?.reason).toContain("carries no `experiment` block, so it is NOT a paired arm")
    expect(renderPairedBundle(result)).toContain("absence never qualifies one as paired")
  })

  test("a segregated arm is named and kept out of its pair, and the other blocks still report", async () => {
    const { root } = await pairedBundle({
      written: (schedule) => {
        const arms = sixArms(schedule)
        arms.find((fake) => fake.armId === "on" && fake.repeatId === 2)!.diffHash = "sha256:another-change"
        return arms
      },
    })
    const result = await read(root)

    expect(blockOf(result, 3).result.kind).toBe("withheld")
    expect(exclusionText(result)).toContain("segregated by the bundle reader")
    expect(exclusionText(result)).toContain("changeId")
    expect(blockOf(result, 1).result.kind).toBe("measured")
  })
})

// ---------------------------------------------------------------------------
// How an arm ended
// ---------------------------------------------------------------------------

describe("a partial or crashed arm supplies no half of a pair, and a degraded one does", () => {
  /** The run shape `runPairedBlocks` writes for a continuation that threw. */
  const thrown = {
    completion: "unfinished",
    finishedAt: unknownValue("the continuation threw before it finished"),
  }

  test("A THROWN ARM: `experiment.failure` withholds its block, names the failure, and drops availability", async () => {
    const { root } = await pairedBundle({
      written: (schedule) => {
        const arms = sixArms(schedule)
        const broke = arms.find((fake) => fake.armId === "off" && fake.repeatId === 0)!
        Object.assign(broke, thrown)
        broke.experiment = { ...(broke.experiment as Record<string, unknown>), failure: "socket closed" }
        return arms
      },
    })
    const result = await read(root)

    const block1 = blockOf(result, 1)
    // The arm is a real arm of its block and is still listed as one.
    expect(block1.arms.map((arm) => arm.arm)).toEqual(["on", "off"])
    expect(block1.result.kind).toBe("withheld")
    if (block1.result.kind === "withheld") {
      expect(block1.result.reasons.join(" ")).toContain("its `off` arm THREW (`experiment.failure`: socket closed)")
      expect(block1.result.reasons.join(" ")).toContain("completion reads `unfinished`")
    }
    for (const entry of result.availability) {
      expect(entry, entry.quantity).toMatchObject({ available: 2, of: 3 })
      expect(entry.missing[0]!.block, entry.quantity).toBe(1)
      expect(entry.missing[0]!.reason, entry.quantity).toContain("THREW")
    }
    const text = renderPairedBundle(result)
    expect(text).toContain("socket closed")
    expect(blockOf(result, 2).result.kind).toBe("measured")
  })

  test.each([["cancelled"], ["unfinished"]])(
    "AN ARM THAT STOPPED PART WAY (`%s`) is named and its block is withheld",
    async (completion) => {
      const { root } = await pairedBundle({ arms: [{ block: 2, arm: "on", over: { completion } }] })
      const result = await read(root)

      const block2 = blockOf(result, 2)
      expect(block2.result.kind).toBe("withheld")
      if (block2.result.kind === "withheld") {
        expect(block2.result.reasons.join(" ")).toContain(`its \`on\` arm STOPPED PART WAY (\`status.completion\` is \`${completion}\`)`)
      }
      expect(availabilityOf(result, "paired candidates")).toMatchObject({ available: 2, of: 3 })
      expect(blockOf(result, 1).result.kind).toBe("measured")
    },
  )

  test("A DEGRADED ARM IS NOT ONE OF THEM: its block measures, and the degradation is named", async () => {
    // THE OTHER HALF OF THE SPLIT. `degraded` means the arm ran to the END and
    // something reduced it — a different fact from a run that stopped part way.
    // AD-6 asks that it never LOOK like a good one, which naming satisfies;
    // withholding it would discard planned data the protocol says is never
    // dropped, and 2-5c already forks a degraded discovery with its warnings as
    // data.
    const { root } = await pairedBundle({
      arms: [
        {
          block: 2,
          arm: "on",
          over: {
            completion: "degraded",
            warnings: [{ code: "model-dropped-out", disclosure: false, message: "a slot stopped answering" }],
          },
        },
      ],
    })
    const result = await read(root)

    const block2 = blockOf(result, 2)
    expect(block2.result.kind).toBe("measured")
    if (block2.result.kind === "measured") {
      expect(block2.result.difference.paired).toBe(3)
      expect(block2.result.arms.find((arm) => arm.arm === "on")!.completion).toBe("degraded")
    }
    // A degraded block counts as available for the quantities it did yield.
    for (const entry of result.availability) {
      expect(entry, entry.quantity).toMatchObject({ available: 3, of: 3, missing: [] })
    }

    // The degradation is named where the confounds sit, beside the numbers it qualifies.
    const text = renderPairedBundle(result)
    const body = text.slice(text.indexOf("BLOCK 2"), text.indexOf("BLOCK 3"))
    expect(body).toContain("A DEGRADED ARM IS IN THIS RESULT, NAMED RATHER THAN DISCARDED.")
    expect(body).toContain("on `run-on-1`: completion `degraded`; 1 warning(s): model-dropped-out")
    expect(body.indexOf("A DEGRADED ARM IS IN THIS RESULT")).toBeGreaterThan(body.indexOf("CONFOUNDS, BESIDE THIS RESULT"))
    // Untouched blocks say nothing about degradation.
    expect(text.slice(text.indexOf("BLOCK 1"), text.indexOf("BLOCK 2"))).not.toContain("A DEGRADED ARM")
  })

  test("A DEGRADED ARM WITH NO WARNING says so rather than implying a cause", async () => {
    const { root } = await pairedBundle({ arms: [{ block: 1, arm: "off", over: { completion: "degraded" } }] })
    const result = await read(root)

    expect(blockOf(result, 1).result.kind).toBe("measured")
    expect(renderPairedBundle(result)).toContain("its manifest records NO warning, so what reduced it is not stated")
  })
})

// ---------------------------------------------------------------------------
// The block cohort
// ---------------------------------------------------------------------------

describe("the block cohort is the shared prefix", () => {
  test("PREFIX MISMATCH: no pair, both prefixes named, the guidance withheld, the rest still report", async () => {
    const { root } = await pairedBundle({ arms: [{ block: 2, arm: "off", prefixRunId: "run-prefix-other" }] })
    const result = await read(root)

    const block2 = blockOf(result, 2)
    expect(block2.result.kind).toBe("withheld")
    if (block2.result.kind === "withheld") {
      expect(block2.result.reasons.join(" ")).toContain("its two arms name DIFFERENT prefixes")
    }
    expect(block2.inheritedSum.offered).toBe(false)
    // Block 2's planned order under heads is OFF first, and the arms are listed in it.
    expect(block2.inheritedSum.prefixes).toEqual(["off → `run-prefix-other`", "on → `run-prefix-2`"])

    expect(blockOf(result, 1).result.kind).toBe("measured")
    expect(blockOf(result, 3).result.kind).toBe("measured")

    const text = renderPairedBundle(result)
    expect(text).toContain("THE INHERITED-SUM RULE IS WITHHELD FOR THIS BLOCK")
    expect(text).toContain("no inherited part cancels between them")
  })

  test("AVAILABILITY: one block refused reads 2/3 per quantity, each with that block's exact reason", async () => {
    const { root } = await pairedBundle({ arms: [{ block: 2, arm: "off", prefixRunId: "run-prefix-other" }] })
    const result = await read(root)

    for (const entry of result.availability) {
      expect(entry, entry.quantity).toMatchObject({ available: 2, of: 3 })
      expect(entry.missing, entry.quantity).toHaveLength(1)
      expect(entry.missing[0]!.block, entry.quantity).toBe(2)
      expect(entry.missing[0]!.reason, entry.quantity).toContain("DIFFERENT prefixes")
    }
    expect(renderPairedBundle(result)).toContain("paired candidates: 2/3")
  })

  test("HALF A BLOCK: a missing arm leaves one arm reported, no paired quantity, and the reason recorded", async () => {
    const { root } = await pairedBundle({
      written: (schedule) => sixArms(schedule).filter((fake) => !(fake.armId === "off" && fake.repeatId === 0)),
    })
    const result = await read(root)

    const block1 = blockOf(result, 1)
    expect(block1.arms.map((arm) => arm.arm)).toEqual(["on"])
    expect(block1.result.kind).toBe("withheld")
    if (block1.result.kind === "withheld") {
      expect(block1.result.reasons.join(" ")).toContain("this block bound on (first)")
      expect(block1.result.reasons.join(" ")).toContain("exactly two arms")
    }
    expect(block1.excluded.map((entry) => entry.reason).join(" ")).toContain("no dump was written for it")
    expect(blockOf(result, 2).result.kind).toBe("measured")
    expect(availabilityOf(result, "paired candidates")).toMatchObject({ available: 2, of: 3 })
  })

  test("CROSS-BLOCK IDS: the same id string in two blocks is never a pair", async () => {
    const { root } = await pairedBundle({
      arms: [
        { block: 1, arm: "on", findings: [{ id: "f1", verdict: "upheld" }] },
        { block: 1, arm: "off", findings: [{ id: "f2", verdict: "upheld" }] },
        { block: 2, arm: "on", findings: [{ id: "f2", verdict: "upheld" }] },
        { block: 2, arm: "off", findings: [{ id: "f1", verdict: "upheld" }] },
      ],
    })
    const result = await read(root)

    // Every id occurs twice in the bundle, and never twice inside one block.
    for (const block of [1, 2]) {
      const measured = blockOf(result, block).result
      expect(measured.kind, `block ${block}`).toBe("measured")
      if (measured.kind !== "measured") continue
      expect(measured.difference.paired, `block ${block}`).toBe(0)
      expect(measured.difference.onlyIn, `block ${block}`).toEqual({ on: 1, off: 1 })
    }
  })

  test("EMPTY DENOMINATOR: a zero denominator is `not measurable (0 cases)` AND is not available", async () => {
    // THE AVAILABILITY TABLE AND THE BLOCK BODIES MUST AGREE. Counting a measured
    // block as available whatever its denominator printed `verdict-state
    // differences: 3/3` above three bodies each reading `not measurable (0 cases)`.
    const { root } = await pairedBundle({
      arms: [1, 2, 3].flatMap((block) => [
        { block, arm: "on" as const, findings: [{ id: `a${block}`, verdict: "upheld" }] },
        { block, arm: "off" as const, findings: [{ id: `b${block}`, verdict: "upheld" }] },
      ]),
    })
    const result = await read(root)

    for (const block of result.blocks) {
      expect(block.result.kind, `block ${block.block}`).toBe("measured")
      if (block.result.kind !== "measured") continue
      expect(block.result.difference.paired, `block ${block.block}`).toBe(0)
    }
    // Two arms raised two distinct ids, so the `of`-2 quantities stay available.
    expect(availabilityOf(result, "paired candidates")).toMatchObject({ available: 3, of: 3 })
    expect(availabilityOf(result, "only-in counts")).toMatchObject({ available: 3, of: 3 })
    // Nothing paired, so nothing could be decided on both sides or be undecided.
    const differences = availabilityOf(result, "verdict-state differences")
    expect(differences.available).toBe(0)
    expect(differences.missing).toHaveLength(3)
    expect(differences.missing[0]!.reason).toContain("no paired candidate carried a decision on BOTH sides")
    const undecided = availabilityOf(result, "undecided transitions")
    expect(undecided.available).toBe(0)
    expect(undecided.missing[0]!.reason).toContain("share no candidate id")

    const text = renderPairedBundle(result)
    expect(text).toContain("verdict-state differences, over the paired candidates where BOTH arms decided: not measurable (0 cases)")
    expect(text).toContain("verdict-state differences: 0/3")
    expect(text).not.toContain(" 0 of 0")
  })

  test("A ZERO TREATMENT DENOMINATOR is unavailable on its own, and the other four stay available", async () => {
    const { root } = await pairedBundle({ arms: [{ block: 3, arm: "off", intervention: { toJudge: 0, wouldHaveDebated: 0 } }] })
    const result = await read(root)

    expect(blockOf(result, 3).result.kind).toBe("measured")
    const treatment = availabilityOf(result, "treatment opportunity")
    expect(treatment).toMatchObject({ available: 2, of: 3 })
    expect(treatment.missing[0]!.reason).toContain("sent no candidate to the judge")
    for (const entry of result.availability.filter((row) => row.quantity !== "treatment opportunity")) {
      expect(entry, entry.quantity).toMatchObject({ available: 3, of: 3 })
    }
  })
})

// ---------------------------------------------------------------------------
// Prefix evidence, slots, halt
// ---------------------------------------------------------------------------

describe("prefix evidence", () => {
  test("ABSENT: the paired result is withheld for that block with its reason", async () => {
    const { root } = await pairedBundle({ prefixes: [1, 3] })
    const result = await read(root)

    const block2 = blockOf(result, 2)
    expect(block2.result.kind).toBe("withheld")
    if (block2.result.kind === "withheld") expect(block2.result.reasons[0]).toContain("could not be read")
    expect(block2.prefix.evidence).toBeNull()
    expect(blockOf(result, 1).result.kind).toBe("measured")
    expect(renderPairedBundle(result)).toContain("block 2: UNUSABLE —")
  })

  test("UNREADABLE: a prefix file that does not parse withholds that block only", async () => {
    const { root } = await pairedBundle()
    await writeFile(join(root, PREFIX_DIRECTORY, "0", PREFIX_FILE), "{ not json")
    const result = await read(root)

    expect(blockOf(result, 1).result.kind).toBe("withheld")
    expect(blockOf(result, 2).result.kind).toBe("measured")
  })

  test("DISAGREEING: a prefix bound to another schedule or another block is refused", async () => {
    const other = `sha256:${"a".repeat(64)}`
    const { root } = await pairedBundle({ prefixOver: { 1: { scheduleHash: other }, 2: { block: 3 } } })
    const result = await read(root)

    const first = blockOf(result, 1).result
    expect(first.kind).toBe("withheld")
    if (first.kind === "withheld") expect(first.reasons[0]).toContain("is not the sealed schedule")
    const second = blockOf(result, 2).result
    expect(second.kind).toBe("withheld")
    if (second.kind === "withheld") expect(second.reasons[0]).toContain("says it is block 3")
    expect(blockOf(result, 3).result.kind).toBe("measured")
  })

  test("MALFORMED: a prefix file missing a field this reader prints is refused", async () => {
    const { root } = await pairedBundle({ prefixOver: { 1: { prefixRunId: "run-prefix-1" } } })
    const result = await read(root)
    const first = blockOf(result, 1).result
    expect(first.kind).toBe("withheld")
    if (first.kind === "withheld") expect(first.reasons[0]).toContain("is malformed")
  })

  test("AN UNKNOWN VERSION is refused for that, before any field is read", async () => {
    const { root } = await pairedBundle({ prefixOver: { 1: { prefixEvidenceVersion: 99, forked: "not a boolean" } } })
    const result = await read(root)
    const first = blockOf(result, 1).result
    expect(first.kind).toBe("withheld")
    if (first.kind === "withheld") {
      expect(first.reasons[0]).toContain("prefix evidence version 99")
      expect(first.reasons[0]).not.toContain("malformed")
    }
  })

  test("`forked: false` WITHHOLDS THE BLOCK: the fork is what makes the id join legitimate", async () => {
    const { root } = await pairedBundle({
      prefixOver: { 1: { forked: false, reason: "the checkpoint fork threw before either branch existed" } },
    })
    const result = await read(root)

    const first = blockOf(result, 1).result
    expect(first.kind).toBe("withheld")
    if (first.kind === "withheld") {
      expect(first.reasons[0]).toContain("`forked: false`")
      expect(first.reasons[0]).toContain("did not continue ONE prepared review")
    }
    // The report never prints `NOT forked` above numbers justified by the fork.
    const text = renderPairedBundle(result)
    expect(text).toContain("block 1: UNUSABLE —")
    expect(blockOf(result, 2).result.kind).toBe("measured")
  })

  test("A PREFIX THAT FAILED withholds its block with the exception it recorded", async () => {
    const { root } = await pairedBundle({
      prefixOver: { 2: { failure: "the discovery stage threw", reason: "no prepared review was produced" } },
    })
    const result = await read(root)
    const second = blockOf(result, 2).result
    expect(second.kind).toBe("withheld")
    if (second.kind === "withheld") expect(second.reasons[0]).toContain("its prefix FAILED (the discovery stage threw)")
  })

  test("A PREFIX THAT MINTED NO RUN ID cannot be reconciled, so its block is withheld", async () => {
    const { root } = await pairedBundle({
      prefixOver: { 3: { prefixRunId: unknownValue("prepareReview threw before a run id was minted") } },
    })
    const result = await read(root)
    const third = blockOf(result, 3).result
    expect(third.kind).toBe("withheld")
    if (third.kind === "withheld") expect(third.reasons[0]).toContain("minted no run id")
  })

  test("THE EVIDENCE AND THE ARMS MUST NAME ONE PREFIX, and a disagreement prints both", async () => {
    const { root } = await pairedBundle({ prefixOver: { 1: { prefixRunId: known("run-prefix-somewhere-else") } } })
    const result = await read(root)

    const first = blockOf(result, 1)
    // The evidence itself is well formed — the disagreement is with the arms.
    expect(first.prefix.problem).toBeNull()
    expect(first.result.kind).toBe("withheld")
    if (first.result.kind === "withheld") {
      expect(first.result.reasons.join(" ")).toContain("records prefix run `run-prefix-somewhere-else`")
      expect(first.result.reasons.join(" ")).toContain("both arms name `run-prefix-1`")
      expect(first.result.reasons.join(" ")).toContain("neither is preferred")
    }
    expect(availabilityOf(result, "paired candidates")).toMatchObject({ available: 2, of: 3 })
  })
})

describe("slot coverage", () => {
  test("ABSENT FILE: all six planned slots are reported, each with the reason it has no line", async () => {
    const { root } = await pairedBundle({ slots: "absent" })
    const result = await read(root)

    expect(result.slots).toHaveLength(6)
    for (const slot of result.slots) {
      expect(slot.status).toBe("unrecorded")
      expect(slot.reason).toContain("no slot status lines at all")
    }
    // The slots say nothing about whether the arms pair, and do not stop them.
    expect(blockOf(result, 1).result.kind).toBe("measured")
  })

  test("STARTED WITH NO TERMINAL LINE: the slot reads unfinished, with its reason", async () => {
    const { root } = await pairedBundle({ slots: "started-only" })
    const result = await read(root)

    for (const slot of result.slots) {
      expect(slot.status).toBe("unfinished")
      expect(slot.reason).toContain("carries no terminal line for it")
    }
    expect(renderPairedBundle(result)).toContain("block 1 on (first): unfinished")
  })

  test("`not-attempted` IS REPORTED LIKE ANY OTHER TERMINAL STATUS", async () => {
    const { root, schedule } = await pairedBundle({ slots: "absent" })
    for (const slot of schedule.slots) {
      await appendSlotStatus(root, {
        ...slot,
        status: slot.block === 3 ? "not-attempted" : "completed",
        reason: slot.block === 3 ? "admission ended before this slot" : "the continuation returned a record",
        at: "2026-09-14T00:00:02.000Z",
      })
    }
    const result = await read(root)
    expect(result.slots.filter((slot) => slot.status === "not-attempted")).toHaveLength(2)
    expect(renderPairedBundle(result)).toContain("block 3 on (first): not-attempted — admission ended before this slot")
  })

  test("TWO TERMINAL LINES: the LAST one stands, and the earlier one is named", async () => {
    const { root, schedule } = await pairedBundle({ slots: "absent" })
    const slot = schedule.slots[0]!
    await appendSlotStatus(root, { ...slot, status: "started", reason: "the slot was started", at: "t0" })
    await appendSlotStatus(root, { ...slot, status: "failed", reason: "the block's prefix refused work", at: "t1" })
    await appendSlotStatus(root, { ...slot, status: "completed", reason: "the continuation returned a record", at: "t2" })
    const result = await read(root)

    const folded = result.slots.find((entry) => entry.block === slot.block && entry.arm === slot.arm)!
    expect(folded.status).toBe("completed")
    expect(folded.lines).toBe(3)
    expect(folded.reason).toContain("2 terminal lines; the LAST one stands")
    expect(folded.reason).toContain("read failed")
  })

  test("A LINE THAT PARSES AND IS NOT A SLOT STATUS is counted and named, not dropped", async () => {
    // Dropping it silently made the slot it covered report `carries lines, but
    // none for this planned slot`, which names the wrong cause.
    const { root } = await pairedBundle({ slots: "absent" })
    await writeFile(join(root, SLOT_STATUS_FILE), `${JSON.stringify({ block: 1, arm: "on", status: "finished-ish" })}\n`)
    const result = await read(root)

    expect(result.malformedSlotLines).toHaveLength(1)
    expect(result.malformedSlotLines[0]).toMatchObject({ line: 1 })
    expect(result.malformedSlotLines[0]!.reason).toContain("parsed as JSON and is not a")
    const slot = result.slots.find((entry) => entry.block === 1 && entry.arm === "on")!
    expect(slot.status).toBe("unrecorded")
    expect(slot.reason).toContain("1 line(s) in the file could not be read as slot statuses")
    expect(renderPairedBundle(result)).toContain(`\`${SLOT_STATUS_FILE}\` line 1 was not read`)
  })

  test("A TORN LINE does not throw: every planned slot is still reported with the reason", async () => {
    const { root } = await pairedBundle()
    await writeFile(join(root, SLOT_STATUS_FILE), '{"block":1,"arm":"on"\n', { flag: "a" })
    const result = await read(root)
    expect(result.slots).toHaveLength(6)
    expect(result.slots[0]!.reason).toContain("could not be read")
    expect(blockOf(result, 1).result.kind).toBe("measured")
  })
})

describe("a latched halt", () => {
  test("the paired results are still read, with the halt and its reason stated above them", async () => {
    const { root } = await pairedBundle()
    await writeFile(
      join(root, HALT_MARKER_FILE),
      JSON.stringify({ halted: true, haltReason: "an execution reported no usage and could not be counted" }),
    )
    const result = await read(root)

    expect(result.halt.kind).toBe("halted")
    if (result.halt.kind === "halted") expect(result.halt.reason).toContain("an execution reported no usage")
    expect(blockOf(result, 1).result.kind).toBe("measured")
    const text = renderPairedBundle(result)
    expect(text).toContain("THIS EXPERIMENT IS HALTED.")
    expect(text.indexOf("THIS EXPERIMENT IS HALTED.")).toBeLessThan(text.indexOf("BLOCK 1"))
  })

  test("a marker this reader cannot parse still halts, because its PRESENCE is the signal", async () => {
    const { root } = await pairedBundle()
    await writeFile(join(root, HALT_MARKER_FILE), "{ not json")
    const result = await read(root)
    expect(result.halt.kind).toBe("halted")
    if (result.halt.kind === "halted") expect(result.halt.reason).toContain("its presence is the halt")
  })

  test("NO MARKER IS NOT A HALT, and prints no banner", async () => {
    const { root } = await pairedBundle()
    const result = await read(root)
    expect(result.halt).toEqual({ kind: "none" })
    const text = renderPairedBundle(result)
    expect(text).not.toContain("HALTED")
    expect(text).not.toContain("COULD NOT BE ESTABLISHED")
  })

  test("A MARKER THAT COULD NOT BE READ IS ITS OWN STATE, and never asserts a halt", async () => {
    // A directory where the file should be fails with EISDIR, not ENOENT: the
    // question is open, which is neither `halted` nor `none`.
    const { root } = await pairedBundle()
    await (await import("node:fs/promises")).mkdir(join(root, HALT_MARKER_FILE))
    const result = await read(root)

    expect(result.halt.kind).toBe("unestablished")
    if (result.halt.kind === "unestablished") {
      expect(result.halt.reason).toContain("which is not evidence that it does not exist")
    }
    const text = renderPairedBundle(result)
    expect(text).toContain("WHETHER THIS EXPERIMENT IS HALTED COULD NOT BE ESTABLISHED.")
    expect(text).not.toContain("THIS EXPERIMENT IS HALTED.")
    expect(blockOf(result, 1).result.kind).toBe("measured")
  })
})

// ---------------------------------------------------------------------------
// The label-free rules
// ---------------------------------------------------------------------------

describe("what the reader refuses to say", () => {
  test("AN ARM THAT UPHELD NOTHING IS UNDEFINED, never 100% and never a clean list", async () => {
    const { root } = await pairedBundle({
      arms: [
        {
          block: 1,
          arm: "off",
          findings: [
            { id: "f1", verdict: "judge-ruled-invalid" },
            { id: "f2", verdict: "judge-ruled-invalid" },
          ],
        },
      ],
    })
    const text = renderPairedBundle(await read(root))

    expect(text).toContain("arm off UPHELD NOTHING (0 of 2)")
    expect(text).toContain("is UNDEFINED for this arm — not 100%, and not a clean list")
    expect(text).toContain("No interval is invented for it here.")
  })

  test("BUDGET LOSS: an unresolved candidate stays visible and is never counted as removed noise", async () => {
    const { root } = await pairedBundle()
    const result = await read(root)

    const measured = blockOf(result, 1).result
    expect(measured.kind).toBe("measured")
    if (measured.kind !== "measured") return
    expect(measured.arms.find((arm) => arm.arm === "on")!.unresolved).toBe(1)
    const text = renderPairedBundle(result)
    expect(text).toContain("unresolved 1 of 4")
    expect(text).toContain("UNRESOLVED CANDIDATES STAY VISIBLE")
    expect(text).toContain("NOT successful noise removal")
  })

  test("A LONG DIFFERENCE LIST IS CAPPED, so the confounds still sit beside the result", async () => {
    const ids = Array.from({ length: 9 }, (_unused, index) => `d${index}`)
    const { root } = await pairedBundle({
      arms: [
        { block: 1, arm: "on", findings: ids.map((id) => ({ id, verdict: "upheld" })) },
        { block: 1, arm: "off", findings: ids.map((id) => ({ id, verdict: "judge-ruled-invalid" })) },
      ],
    })
    const result = await read(root)
    const measured = blockOf(result, 1).result
    expect(measured.kind).toBe("measured")
    if (measured.kind !== "measured") return
    // Every difference is kept on the result; only the RENDERING is capped.
    expect(measured.difference.differences).toHaveLength(9)

    const text = renderPairedBundle(result)
    const named = text.split("\n").filter((line) => /^ {4}`d\d`: on upheld → off judge-ruled-invalid$/.test(line))
    expect(named).toHaveLength(5)
    expect(text).toContain("…and 4 more, in this block's two `manifest.json` files.")
    const body = text.slice(text.indexOf("BLOCK 1"), text.indexOf("BLOCK 2"))
    expect(body).toContain("CONFOUNDS, BESIDE THIS RESULT — block 1")
    expect(body.indexOf("…and 4 more")).toBeLessThan(body.indexOf("IDENTIFICATION."))
  })

  test.each([
    ["did-not-run", { kind: "did-not-run" }, "routing stage did not run"],
    ["a kind this reader does not know", { kind: "skipped" }, "neither `did-not-run` nor a readable `ran`"],
    [
      "a malformed intervention",
      { kind: "ran", counts: { toDebate: 0, toJudge: 4, toJudgeAtThreshold: 0, toJudgeNoPrior: 0, intervention: { toJudge: "four" } } },
      "`status.routeCounts.intervention` is malformed",
    ],
    [
      "more debated than judged",
      {
        kind: "ran",
        counts: { toDebate: 0, toJudge: 4, toJudgeAtThreshold: 0, toJudgeNoPrior: 0, intervention: { toJudge: 4, wouldHaveDebated: 5 } },
      },
      "the debated set is a SUBSET of the judged set, so the pair is impossible",
    ],
  ])("TREATMENT OPPORTUNITY is unknown for %s, with its reason", async (_name, routeCounts, expected) => {
    const { root } = await pairedBundle({ arms: [{ block: 2, arm: "off", over: { routeCounts } }] })
    const result = await read(root)

    // The block still pairs; only the one quantity is unavailable.
    const measured = blockOf(result, 2).result
    expect(measured.kind).toBe("measured")
    if (measured.kind === "measured") {
      expect(measured.treatment.kind).toBe("unknown")
      if (measured.treatment.kind === "unknown") expect(measured.treatment.why).toContain(expected)
    }
    const treatment = availabilityOf(result, "treatment opportunity")
    expect(treatment).toMatchObject({ available: 2, of: 3 })
    expect(treatment.missing[0]!.reason).toContain(expected)
    for (const entry of result.availability.filter((row) => row.quantity !== "treatment opportunity")) {
      expect(entry, entry.quantity).toMatchObject({ available: 3, of: 3 })
    }
    expect(renderPairedBundle(result)).toContain("treatment opportunity: UNAVAILABLE —")
  })

  test("TREATMENT OPPORTUNITY drops on its own when the OFF arm recorded no intervention", async () => {
    const { root } = await pairedBundle({ arms: [{ block: 2, arm: "off", intervention: null }] })
    const result = await read(root)

    expect(blockOf(result, 2).result.kind).toBe("measured")
    const treatment = availabilityOf(result, "treatment opportunity")
    expect(treatment).toMatchObject({ available: 2, of: 3 })
    expect(treatment.missing[0]!.reason).toContain("carries no `intervention` block")
  })

  test("the report states what it does not measure, in a list a reader can check", async () => {
    const { root } = await pairedBundle()
    const text = renderPairedBundle(await read(root))

    // A POSITIVE ASSERTION. `not.toContain("false positive")` could not fail —
    // the renderer has no path that emits it — so it pinned nothing.
    const closing = text.slice(text.indexOf("WHAT THIS REPORT DOES NOT MEASURE."))
    expect(closing).toContain("No truth label enters it")
    for (const excluded of [
      "no precision",
      "no false",
      "positives",
      "no final recall",
      "none of the four labelled verdict transitions",
      "no earned /",
      "did-not-earn reading",
    ]) {
      expect(closing, excluded).toContain(excluded)
    }
    expect(closing).toContain("belong to story 2.8")
    expect(closing).toContain("DESCRIPTIVE evidence with no significance")
  })
})

// ---------------------------------------------------------------------------
// The real writer
// ---------------------------------------------------------------------------

describe("a bundle `runPairedBlocks` actually wrote", () => {
  test("the reader binds all six arms, pairs all three blocks and folds all six slots", async () => {
    const root = await tempDir()
    const roster = rosterOf()
    const base = scheduleInput(root, roster.roster)
    await sealSchedule(root)

    const outcome = await runPairedBlocks({
      ...base,
      worktree: WORKTREE,
      priorWarnings: roster.warnings,
      clock: fakeClock(),
      backendFor: scriptedBackend,
    })
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.complete).toBe(true)

    const result = await read(root)
    expect(result.schedule.ok).toBe(true)
    expect(result.slots.every((slot) => slot.status === "completed")).toBe(true)
    expect(result.malformedSlotLines).toEqual([])
    expect(allExcluded(result)).toEqual([])
    for (const block of result.blocks) {
      expect(block.arms.map((arm) => arm.arm).sort(), `block ${block.block}`).toEqual(["off", "on"])
      expect(block.prefix.problem, `block ${block.block}`).toBeNull()
      expect(block.result.kind, `block ${block.block}`).toBe("measured")
      if (block.result.kind !== "measured") continue
      // ONE prepared review, cloned into both arms: every candidate pairs, and
      // nothing is only in one arm.
      expect(block.result.difference.paired, `block ${block.block}`).toBeGreaterThan(0)
      expect(block.result.difference.onlyIn, `block ${block.block}`).toEqual({ on: 0, off: 0 })
      expect(block.result.treatment.kind, `block ${block.block}`).toBe("known")
      expect(block.inheritedSum.offered, `block ${block.block}`).toBe(true)
      for (const arm of block.result.arms) expect(arm.completion, `block ${block.block} ${arm.arm}`).toBe("completed")
    }
    for (const entry of result.availability) expect(entry, entry.quantity).toMatchObject({ available: 3, of: 3 })

    const text = renderPairedBundle(result)
    expect(text).toContain("RUN ID / JUDGE ANONYMIZER")
    expect(text).toContain("candidates paired by `Finding.id`, no aligner")

    // The prefix the reader names is the one the writer recorded, in both files.
    const evidence = JSON.parse(await readFile(join(root, PREFIX_DIRECTORY, "0", PREFIX_FILE), "utf8")) as {
      prefixRunId: { value: string }
      forked: boolean
    }
    expect(evidence.forked).toBe(true)
    const first = blockOf(result, 1).result
    if (first.kind === "measured") expect(first.prefixRunId).toBe(evidence.prefixRunId.value)
  })
})

const CRITICAL = {
  findings: [
    {
      claim: "The fee is applied before the rate is validated.",
      reasoning: "A NaN rate silently yields a NaN total.",
      severity: "critical",
      file: "src/pay.ts",
      startLine: 1,
      endLine: 1,
    },
  ],
}

/** Discovery raises one critical finding, debate abstains, the judge gives the defaults. */
function scriptedBackend(_context: PairedPhaseContext): ModelBackend {
  return {
    capabilities: (): BackendCapabilities => ({ tools: true }),
    async runTurn<T>(slot: string, instructions: string, _input: string, schema: ZodType<T>, signal?: AbortSignal): Promise<Envelope<T>> {
      if (signal?.aborted) return cancelledTurn<T>(slot)
      const role = judgeRoleOf(instructions)
      const payload =
        role !== undefined ? DEFAULT_JUDGE_ANSWERS[role] : instructions === CODING_DISCOVERY_GENERALIST.text ? CRITICAL : { turns: [] }
      const parsed = schema.safeParse(payload)
      if (!parsed.success) throw new Error("the fake payload did not parse")
      const tokens: TokenUsage = { ...emptyTokenUsage(), input: 10, output: 20 }
      return { ok: true, slot, value: parsed.data, tokens }
    },
  }
}
