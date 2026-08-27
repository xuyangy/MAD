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

import { MATERIAL_NOTICES } from "../prompt/material.ts"
import { materialSpans } from "../test-support/fakes.ts"
import { CODING_DEBATE_GENERALIST } from "./coding/debate.ts"
import { CODING_DISCOVERY_GENERALIST } from "./coding/discovery.ts"
import { CODING_LENSES } from "./coding/lenses.ts"
import type { InstructionSet } from "./types.ts"
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

/**
 * Byte-for-byte what story 5 shipped, pinned here and nowhere else.
 *
 * The spine and `stories.yaml` both state that BOTH generalists are pinned
 * against literal copies. Until story 5A only discovery was, so the "byte-for-
 * byte unchanged" rule over the debate text was documented and unenforced —
 * which matters most for exactly the story that hardens the ENVELOPE instead of
 * the instruction (AD-18). This is the only test that can catch the one edit
 * story 5A was forbidden to make.
 */
const DEBATE_TEXT_AS_SHIPPED = `You are one participant in a short, evidence-driven exchange about specific claimed defects in a code change. Several findings are put to you at once. They are INDEPENDENT debates that happen to share this turn: decide each one on its own evidence, and never let your answer on one finding move your answer on another.

For each finding below, state the position you actually hold after reading the code and the exchange so far. Nobody has been assigned a side. If you think the finding is right, say so; if you think it is wrong, say so; if the evidence does not settle it, say that instead. Agreeing is a real answer and so is changing your mind — neither costs you anything here.

Choose exactly one position per finding:
- upholds — the defect is real as described.
- denies — the defect is not real, or the described mechanism does not happen.
- withdraws — ONLY if you raised this finding and you no longer stand behind it. Nobody else can withdraw a finding for you, and withdrawing is not conceding a point of detail; it means you no longer claim the defect.
- unsure — you cannot settle it from the evidence available. Say what evidence would settle it.

For each finding also give:
- argument: why you hold that position, in one short paragraph. Argue from the code, not from who said what. If you are answering someone else's point, answer the point.
- concession: anything you now accept that you did not accept before — an error in your own reasoning, a fact the other side established, a narrowing of your claim. Leave it out if there is nothing to concede. Do not manufacture one to look reasonable.
- citations: the specific places that back your argument, as \`file:line\` or \`file:startLine-endLine\` strings. Quote nothing you have not read in the material provided.

Rules that matter:
- Repeating your previous argument unchanged is a legitimate answer when the other side has said nothing new, but say only that. Restating at greater length is not an argument.
- Do not adjudicate. You are not ranking findings, assigning severity, or deciding the outcome — a separate stage does that, and it reads what you write here.
- Do not vote, count sides, or refer to how many participants agree with you. How many hold a position is not evidence for it.
- Answer for every finding you were given, in the order given, using the finding id exactly as it appears.`

const CODING_DISCOVERY = { taskType: "coding", role: "discovery" } as const
const CODING_DEBATE = { taskType: "coding", role: "debate" } as const

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

describe("the debate generalist is pinned too (story 5A)", () => {
  test("THE CODING DEBATE GENERALIST'S TEXT IS BYTE-IDENTICAL TO WHAT STORY 5 SHIPPED", () => {
    expect(resolveInstructions(CODING_DEBATE).text).toBe(DEBATE_TEXT_AS_SHIPPED)
    expect(CODING_DEBATE_GENERALIST.text).toBe(DEBATE_TEXT_AS_SHIPPED)
  })

  test("it resolves as shipped, carries no lens, and knows its role", () => {
    const set = resolveInstructions(CODING_DEBATE)
    expect(set.origin).toBe("shipped")
    expect(set.lens).toBeUndefined()
    expect(set.taskType).toBe("coding")
    expect(set.role).toBe("debate")
  })

  test("it names no model and assigns no position (AD-3, SPEC.md)", () => {
    const text = resolveInstructions(CODING_DEBATE).text.toLowerCase()
    for (const name of ["claude", "gpt", "gemini", "anthropic", "openai", "sonnet"]) {
      expect(text).not.toContain(name)
    }
    for (const assigned of ["devil's advocate", "skeptic", "you must disagree", "argue against"]) {
      expect(text).not.toContain(assigned)
    }
  })

  test("AD-18 — NO SET THE REGISTRY CAN RESOLVE CARRIES THE MATERIAL FRAMING", () => {
    // AD-18's placement rule. As first written this test asserted over the two
    // PINNED LITERALS a few lines above — two constants defined in this file — so
    // it could not fail and tested nothing about the registry (code review
    // 2026-08-27). It now reads every set the registry can hand a stage: both
    // generalists, all eight shipped lens sets, and both GENERATED fallbacks,
    // which are built at run time from a lens id and are the one text in the
    // system that is not a reviewed literal.
    const resolvable: InstructionSet[] = [
      resolveInstructions(CODING_DISCOVERY),
      resolveInstructions(CODING_DEBATE),
      ...CODING_LENSES.map((lens) => resolveInstructions({ ...CODING_DISCOVERY, lens: lens.id })),
      // Unregistered lens ids, on both roles: generated, not shipped.
      resolveInstructions({ ...CODING_DISCOVERY, lens: "not-a-shipped-lens" }),
      resolveInstructions({ ...CODING_DEBATE, lens: "not-a-shipped-lens" }),
    ]
    expect(resolvable.length).toBe(2 + CODING_LENSES.length + 2)

    for (const set of resolvable) {
      for (const [label, notice] of Object.entries(MATERIAL_NOTICES)) {
        expect(set.text, `${set.role}/${set.lens ?? "generalist"} carries ${label}'s notice`).not.toContain(notice)
      }
      expect(set.text).not.toContain("material: ")
      // And no fenced span, which is the other half of the frame.
      expect(materialSpans(set.text)).toHaveLength(0)
    }
  })

  test("the two PINNED LITERALS agree with the registry, so the pins are not stale", () => {
    // The pins above are literal copies. This is what keeps them honest as
    // copies OF something rather than as two more strings in this file.
    expect(resolveInstructions(CODING_DISCOVERY).text).toBe(DISCOVERY_TEXT_AS_SHIPPED)
    expect(resolveInstructions(CODING_DEBATE).text).toBe(DEBATE_TEXT_AS_SHIPPED)
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

  test("A BLANK LENS ID IS NO LENS, NOT A LENS NAMED `\"\"`", () => {
    // The `---` case above is only half of it (code review 2026-08-15). The
    // other half is an id that is ALREADY empty, which `humanize` never sees:
    // the raw-id fallback then hands back `""` too, and the persona reads
    // `through the "" lens` on a billed turn. Only `clampLenses` in the
    // opencode adapter was filtering blanks, so a core caller — story 9's
    // ablation arms build rosters directly — reintroduced it.
    for (const blank of ["", " ", "\t\n"]) {
      const set = resolveInstructions({ ...CODING_DISCOVERY, lens: blank })

      expect(set.origin).toBe("shipped")
      expect(set.lens).toBeUndefined()
      expect(set.text).toBe(DISCOVERY_TEXT_AS_SHIPPED)
      expect(set.text).not.toContain('the "" lens')
      expect(isShippedLens(blank)).toBe(false)
    }
  })

  test("a lens id is trimmed, so a disclosure cannot disagree with what resolved", () => {
    const set = resolveInstructions({ ...CODING_DISCOVERY, lens: "  security  " })

    expect(set.origin).toBe("shipped")
    expect(set.lens).toBe("security")
    expect(isShippedLens("  security  ")).toBe(true)
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
    // Every role MAD asks for is one MAD defined (spine, Errors). Story 5 added
    // `debate`; story 6 adds `fact-check`, `logic-eval` and `aggregate` here.
    expect(() => resolveInstructions({ taskType: "coding", role: "judge" })).toThrow(
      "no instruction set",
    )
  })

  test("story 5 registered the debate generalist, and it is the ONLY debate set", () => {
    const set = resolveInstructions({ taskType: "coding", role: "debate" })
    expect(set.origin).toBe("shipped")
    expect(set.role).toBe("debate")
    expect(set.lens).toBeUndefined()
    // AD-17a — the debate instruction is not discovery's, and cannot become it.
    expect(set.text).not.toBe(DISCOVERY_TEXT_AS_SHIPPED)
    // It names no model and says nothing about who is reading it (AD-3).
    const text = set.text.toLowerCase()
    for (const name of ["claude", "gpt", "gemini", "anthropic", "openai", "sonnet"]) {
      expect(text).not.toContain(name)
    }
    // SPEC.md forbids ASSIGNING a position. The vocabulary is offered; no role is.
    for (const assigned of ["devil's advocate", "skeptic", "you must disagree", "argue against"]) {
      expect(text).not.toContain(assigned)
    }
    // AD-9 — no tally over positions, ever.
    expect(text).toContain("do not vote")
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
    // Story 5 registered `debate`, so the lens lookup IS now reached from that
    // role — which is exactly the moment this property had to hold. A shipped
    // set is stored under its own role and nothing else can address it.
    const shipped = resolveInstructions({ ...CODING_DISCOVERY, lens: "security" })
    expect(shipped.origin).toBe("shipped")
    expect(shipped.role).toBe("discovery")

    // The same key under `debate` does NOT reach discovery's set. It falls
    // through to the generated fallback, labelled as such — and, crucially, the
    // debate STAGE never asks for it: `debate()` resolves the unlensed
    // generalist for every participant (AD-17a). This asserts the registry
    // cannot serve the leak even if some future caller asked for it.
    const notDiscoverys = resolveInstructions({ taskType: "coding", role: "debate", lens: "security" })
    expect(notDiscoverys.origin).toBe("generated")
    expect(notDiscoverys.role).toBe("debate")
    expect(notDiscoverys.text).not.toBe(shipped.text)

    // And `isShippedLens` answers per (task type, role), not globally — so a
    // caller asking about `debate` is told the truth rather than `discovery`'s.
    expect(isShippedLens("security")).toBe(true)
    expect(isShippedLens("security", "coding", "debate")).toBe(false)
  })
})
