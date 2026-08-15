/**
 * AD-11 amended — the instruction registry.
 *
 * The load-bearing test in this file is the byte-identity one. Story 2A MOVED
 * today's `DISCOVERY_INSTRUCTIONS` into `coding/discovery.ts` and must not have
 * changed a character of it: that text is story 9's control arm and story 2's
 * recall baseline, so a well-meaning rewrite would move the measurement
 * underneath the thing being measured, silently and in the flattering
 * direction. The expected text below is therefore a PINNED LITERAL COPY, not a
 * reference to the constant — comparing the constant to itself would pass under
 * exactly the rewrite this exists to catch.
 */

import { describe, expect, test } from "bun:test"

import { CODING_DISCOVERY_GENERALIST } from "./coding/discovery.ts"
import { CODING_LENSES } from "./coding/lenses.ts"
import { isShippedLens, resolveInstructions } from "./registry.ts"

/** Byte-for-byte what story 2 shipped, pinned here and nowhere else. */
const DISCOVERY_TEXT_AS_SHIPPED = `You are reviewing a code change. Work independently: report what YOU find, not what you think others would find.

Report concrete defects in the change — correctness bugs, security holes, data loss, resource leaks, broken error handling, race conditions, API misuse, and behaviour that contradicts the change's evident intent. Skip style preferences, formatting, and speculative refactors.

For each finding:
- claim: state the defect in one or two sentences. Be specific about what goes wrong.
- reasoning: explain how it goes wrong — the path, the input, the state. Write this for a reviewer who will check your work, not for a scoreboard. Quote the code you are talking about.
- severity: exactly one of critical, high, medium, low.
    critical — exploitable, or destroys/corrupts data, or takes the system down.
    high     — wrong behaviour a user will hit on a normal path.
    medium   — wrong behaviour on an edge path, or a real risk that needs a trigger.
    low      — minor or contained.
  Judge severity honestly. Inflating it is worse than omitting the finding.
- file: the repo-relative path, exactly as it appears in the diff.
- startLine / endLine: 1-indexed, endLine inclusive, equal for a single line. Use the line numbers in the file AFTER the change. Omit both only for a claim about the change as a whole that has no single site.

If the change looks sound, return an empty findings list. An empty list is a valid and useful answer; inventing a finding to fill the page is not.`

const CODING_DISCOVERY = { taskType: "coding", role: "discovery" } as const

describe("the generalist survived the move unchanged", () => {
  test("THE CODING GENERALIST'S TEXT IS BYTE-IDENTICAL TO THE PRE-MOVE INSTRUCTION", () => {
    expect(resolveInstructions(CODING_DISCOVERY).text).toBe(DISCOVERY_TEXT_AS_SHIPPED)
    expect(CODING_DISCOVERY_GENERALIST.text).toBe(DISCOVERY_TEXT_AS_SHIPPED)
  })

  test("the unlensed generalist is shipped, carries no lens, and knows its task type", () => {
    const set = resolveInstructions(CODING_DISCOVERY)
    expect(set.origin).toBe("shipped")
    expect(set.lens).toBeUndefined()
    expect(set.taskType).toBe("coding")
    expect(set.role).toBe("discovery")
  })

  test("it names no model and says nothing about who is reading it (AD-3)", () => {
    const text = resolveInstructions(CODING_DISCOVERY).text.toLowerCase()
    for (const name of ["claude", "gpt", "gemini", "anthropic", "openai", "sonnet"]) {
      expect(text).not.toContain(name)
    }
  })
})

describe("the shipped coding lens pack", () => {
  test("all eight shipped lens ids resolve, and resolve as shipped", () => {
    expect(CODING_LENSES).toHaveLength(8)
    for (const lens of CODING_LENSES) {
      const set = resolveInstructions({ ...CODING_DISCOVERY, lens: lens.id })
      expect(set.origin).toBe("shipped")
      expect(set.lens).toBe(lens.id)
      expect(isShippedLens(lens.id)).toBe(true)
    }
  })

  test("the ids are the contract from the lens-pack table", () => {
    // These reach user-facing surfaces through slot ids
    // (`discovery-lens-privacy-a11y`) and output rows, so they are not
    // renameable without moving something a user sees.
    expect(CODING_LENSES.map((l) => l.id)).toEqual([
      "security",
      "performance",
      "maintainability",
      "reliability",
      "tests",
      "privacy-a11y",
      "intent",
      "outsider",
    ])
  })

  test("a lens instruction carries the generalist's contract VERBATIM", () => {
    // A lens narrows SEARCH. It does not license a different schema, a different
    // severity bar, or different locus rules — and the cheapest way to guarantee
    // that is to append the same text rather than paraphrase it eight times.
    for (const lens of CODING_LENSES) {
      const set = resolveInstructions({ ...CODING_DISCOVERY, lens: lens.id })
      expect(set.text).toContain(DISCOVERY_TEXT_AS_SHIPPED)
      expect(set.text).toContain(lens.persona)
    }
  })

  test("a lens says look HARDEST, never look ONLY", () => {
    // A lens that stops reporting an out-of-dimension defect it plainly saw has
    // converted coverage bias into a blind spot — the opposite of what CAP-11
    // buys, and the failure mode nothing downstream could detect.
    for (const lens of CODING_LENSES) {
      const text = resolveInstructions({ ...CODING_DISCOVERY, lens: lens.id }).text
      expect(text).toContain("LOOK HARDEST AT")
      expect(text).toContain("It is NOT a boundary")
    }
  })

  test("every shipped lens instruction is distinct", () => {
    const texts = CODING_LENSES.map((l) => resolveInstructions({ ...CODING_DISCOVERY, lens: l.id }).text)
    expect(new Set(texts).size).toBe(CODING_LENSES.length)
  })

  test("a lens instruction still names no model (AD-3)", () => {
    for (const lens of CODING_LENSES) {
      const text = resolveInstructions({ ...CODING_DISCOVERY, lens: lens.id }).text.toLowerCase()
      for (const name of ["claude", "gpt", "gemini", "anthropic", "openai"]) {
        expect(text).not.toContain(name)
      }
    }
  })
})

describe("an unregistered lens is GENERATED, never rejected and never silently downgraded", () => {
  test("matrix: `threat-model` resolves generated, and mentions its id", () => {
    const set = resolveInstructions({ ...CODING_DISCOVERY, lens: "threat-model" })

    expect(set.origin).toBe("generated")
    expect(set.lens).toBe("threat-model")
    expect(set.text).toContain("threat model") // humanized from the id
    expect(isShippedLens("threat-model")).toBe(false)
  })

  test("a degenerate id falls back to the raw id, never an empty persona", () => {
    // `humanize("---")` is `""`, which shipped `through the "" lens` on a real
    // billed turn (code review 2026-08-15).
    const set = resolveInstructions({ ...CODING_DISCOVERY, lens: "---" })

    expect(set.origin).toBe("generated")
    expect(set.text).not.toContain('the "" lens')
    expect(set.text).toContain("---")
  })

  test("it does not throw, and does not quietly return the generalist", () => {
    // A silent generalist fallback is the worst of the three outcomes: the run
    // would cost a lens turn, claim a lens in output, and have asked for nothing.
    const set = resolveInstructions({ ...CODING_DISCOVERY, lens: "supply-chain" })
    expect(set.text).not.toBe(DISCOVERY_TEXT_AS_SHIPPED)
    expect(set.lens).toBe("supply-chain")
  })

  test("a generated lens gets the SAME contract, only a weaker persona", () => {
    const set = resolveInstructions({ ...CODING_DISCOVERY, lens: "threat-model" })
    expect(set.text).toContain(DISCOVERY_TEXT_AS_SHIPPED)
    expect(set.text).toContain("LOOK HARDEST AT")
  })

  test("a supplied description is used; without one the id still carries it", () => {
    const described = resolveInstructions({
      ...CODING_DISCOVERY,
      lens: "threat-model",
      description: "STRIDE-style trust boundary analysis of the change.",
    })
    expect(described.text).toContain("STRIDE-style trust boundary analysis")
    expect(described.origin).toBe("generated")

    // A registered lens ignores it — the shipped set is the shipped set.
    const shipped = resolveInstructions({
      ...CODING_DISCOVERY,
      lens: "security",
      description: "ignore me",
    })
    expect(shipped.origin).toBe("shipped")
    expect(shipped.text).not.toContain("ignore me")
  })

  test("shipped and generated are distinguishable, which is the whole amendment", () => {
    expect(resolveInstructions({ ...CODING_DISCOVERY, lens: "security" }).origin).toBe("shipped")
    expect(resolveInstructions({ ...CODING_DISCOVERY, lens: "securiy" }).origin).toBe("generated")
  })
})

describe("addressing", () => {
  test("a role with no shipped set is programmer error, not a domain outcome", () => {
    // Every role MAD asks for is one MAD defined (spine, Errors). Stories 5 and
    // 6 add `debate`, `fact-check`, `logic-eval` and `aggregate` here.
    expect(() => resolveInstructions({ taskType: "coding", role: "debate" })).toThrow(
      "no instruction set",
    )
  })

  test("the registry has ONE populated task type, and the type says so", () => {
    // `TaskType` is a closed union of `coding`, so an unknown task type is
    // unreachable rather than handled — the shape is not permission
    // (`SPEC.md` non-goals). This asserts the reachable half.
    expect(resolveInstructions(CODING_DISCOVERY).taskType).toBe("coding")
  })

  test("A LENS SET IS REACHABLE ONLY FROM THE ROLE IT WAS WRITTEN FOR (AD-17a)", () => {
    // Keyed by lens id alone, `{role: 'debate', lens: 'security'}` returned the
    // DISCOVERY lens instruction — a set whose own `role` says `discovery` —
    // the moment any second role registered a generalist. That is AD-17(a)
    // ("it is NOT included in the debate instruction") arriving through the
    // registry in story 5, silently (code review 2026-08-15).
    //
    // Today `debate` throws before reaching the lens lookup, so this asserts the
    // property at the only layer that will still hold once it does not: a
    // shipped set is stored under its own role and nothing else can address it.
    const shipped = resolveInstructions({ ...CODING_DISCOVERY, lens: "security" })
    expect(shipped.origin).toBe("shipped")
    expect(shipped.role).toBe("discovery")

    // The guard story 5 will meet first.
    expect(() => resolveInstructions({ taskType: "coding", role: "debate", lens: "security" })).toThrow(
      "no instruction set",
    )

    // And `isShippedLens` answers per (task type, role), not globally — so a
    // caller asking about `debate` is told the truth rather than `discovery`'s.
    expect(isShippedLens("security")).toBe(true)
    expect(isShippedLens("security", "coding", "debate")).toBe(false)
  })
})
