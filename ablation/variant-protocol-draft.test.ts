/**
 * The debate-variants protocol document against the code it describes: its
 * literals are the code's (so the document a person freezes cannot silently
 * disagree with what runs), and its freeze state is the one `VARIANT_PROTOCOL`
 * pins — an unfrozen draft while the pin is empty, the pinned id, version and
 * hash once it is filled.
 */

import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { SEEDED_CHANGE } from "../fixtures/seeded-defects/material.ts"
import { SEEDED_DEFECTS } from "../fixtures/seeded-defects/labels.ts"
import { LABELLED_CHANGE_SEAL } from "../fixtures/seeded-defects/seal.ts"
import { VARIANT_ALLOWANCES } from "./governor.ts"
import { changeIdFor } from "./manifest.ts"
import { VARIANT_PROTOCOL } from "./paired-gates.ts"
import { PAIRED_BLOCKS, readFrozenProtocol } from "./schedule.ts"
import { VARIANT_DRAWS, VARIANT_PERMUTATIONS, variantOrderFor } from "./variant-schedule.ts"
import { VARIANT_ARM_OPTIONS, VARIANT_ARMS, VARIANT_PROTOCOL_ID } from "./variants.ts"

const REPO_ROOT = join(import.meta.dir, "..")
const FILE = join(REPO_ROOT, VARIANT_PROTOCOL.path)
const text = () => readFile(FILE, "utf8")
const field = (document: string, name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(document)?.[1]?.trim()
const tokens = (value: number) => value.toLocaleString("en-US")

describe("the debate-variants protocol document", () => {
  test("is the protocol VARIANT_PROTOCOL names, at its path", async () => {
    const document = await text()
    expect(field(document, "id")).toBe(VARIANT_PROTOCOL_ID)
    expect(VARIANT_PROTOCOL.id).toBe(VARIANT_PROTOCOL_ID)
  })

  test("its allowance literals are VARIANT_ALLOWANCES, with the sum and both margins", async () => {
    const document = await text()
    for (const [name, value] of [
      ["global", VARIANT_ALLOWANCES.global],
      ["Blocks", VARIANT_ALLOWANCES.blocks],
      ["prefix", VARIANT_ALLOWANCES.prefix],
      ["continuation", VARIANT_ALLOWANCES.continuation],
      ["run cap", VARIANT_ALLOWANCES.runCap],
    ] as const) {
      expect(document, name).toContain(`| ${name} | **${tokens(value)}** |`)
    }
    const sum = PAIRED_BLOCKS.length * (VARIANT_ALLOWANCES.prefix + VARIANT_ARMS.length * VARIANT_ALLOWANCES.continuation)
    expect(document).toContain(`= **${tokens(sum)}**`)
    expect(document).toContain(`a margin of **${tokens(VARIANT_ALLOWANCES.blocks - sum)}** above it`)
    expect(document).toContain(`a margin of **${tokens(VARIANT_ALLOWANCES.global - VARIANT_ALLOWANCES.blocks)}** above the`)
  })

  test("its arm table is VARIANT_ARM_OPTIONS", async () => {
    const document = await text()
    for (const arm of VARIANT_ARMS) {
      const options = VARIANT_ARM_OPTIONS[arm]
      expect(document, arm).toContain(`| \`${arm}\` | \`${options.policy}\` | ${options.debateReferences} | ${options.debateMissingEvidence} |`)
    }
  })

  test("its change, seal and label count are the shipped ones", async () => {
    const document = await text()
    expect(document).toContain(changeIdFor(SEEDED_CHANGE).diffHash)
    expect(document).toContain(`\`${LABELLED_CHANGE_SEAL.version}\``)
    expect(document).toContain(LABELLED_CHANGE_SEAL.materialHash)
    expect(document).toContain(LABELLED_CHANGE_SEAL.labelsHash)
    expect(document).toContain(`the ${SEEDED_DEFECTS.length} planted defects`)
  })

  test("its schedule is the sealed format's: three blocks, nine continuations, a draw from 0 to 11 by rejection", async () => {
    const document = await text()
    expect(document).toContain(`exactly **${PAIRED_BLOCKS.length}** blocks and **${PAIRED_BLOCKS.length * VARIANT_ARMS.length}** scheduled continuations`)
    const flat = document.replace(/\s+/g, " ")
    expect(flat).toContain(`drawn again while it is 252 or more; the draw is \`d = byte mod ${VARIANT_DRAWS}\`, an integer from 0 to ${VARIANT_DRAWS - 1}`)
    // The six orders, in the base order's indices, are the code's permutations in the code's order.
    const indices = VARIANT_PERMUTATIONS.map((order) => `(${order.map((arm) => VARIANT_ARMS.indexOf(arm)).join(",")})`).join(", ")
    expect(flat).toContain(`listed lexicographically: ${indices}.`)
    const [first, second, third] = variantOrderFor(0)
    expect(flat).toContain(`draw 0 gives block 1 ${first!.join(", ")}; block 2 ${second!.join(", ")}; block 3 ${third!.join(", ")}.`)
  })

  test("its freeze state follows the pin: both pin fields empty and an unfrozen draft, or both set and the frozen file they name", async () => {
    const document = await text()
    const empty = VARIANT_PROTOCOL.version === null && VARIANT_PROTOCOL.frozenHash === null
    const set = VARIANT_PROTOCOL.version !== null && VARIANT_PROTOCOL.frozenHash !== null
    expect(empty || set).toBe(true)
    const read = await readFrozenProtocol(FILE)
    if (empty) {
      expect(field(document, "status")).toBe("draft")
      expect(field(document, "frozen_hash")).toBe("PENDING")
      expect(read.ok).toBe(false)
    } else {
      expect(read).toEqual({ ok: true, id: VARIANT_PROTOCOL.id, version: VARIANT_PROTOCOL.version!, hash: VARIANT_PROTOCOL.frozenHash! })
    }
  })
})
