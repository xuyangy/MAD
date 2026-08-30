/**
 * Test doubles for the ports. Test-only, but they live under `core/` because
 * they may only depend on `core/` — the same AD-1 rule the lint enforces.
 */

import type { ZodType } from "zod"

import type { Candidate } from "../domain/roster.ts"
import { CODING_AGGREGATE, CODING_EVIDENCE_EXTRACT, CODING_FACT_CHECK, CODING_LOGIC_EVAL } from "../instructions/coding/judge.ts"
import { emptyTokenUsage, type TokenUsage } from "../domain/run-record.ts"
import type { Clock } from "../ports/clock.ts"
import type {
  BackendCapabilities,
  Envelope,
  ModelBackend,
  TurnFailure,
} from "../ports/model-backend.ts"
import type { ChangeSet } from "../ports/repo.ts"
import { type MaterialLabel, MATERIAL_NOTICES, noticeFor } from "../prompt/material.ts"

/** Deterministic clock: fixed time, counted ids. */
export function fakeClock(at = "2026-08-13T00:00:00.000Z"): Clock {
  let n = 0
  return {
    now: () => at,
    id: (prefix) => `${prefix}-${(n += 1)}`,
  }
}

export function tokens(input = 10, output = 20): TokenUsage {
  return { ...emptyTokenUsage(), input, output }
}

export type SlotStep =
  /** A payload that is run through the real schema, so malformed values are exercised. */
  | { kind: "ok"; value: unknown }
  | { kind: "fail"; failure: TurnFailure; message?: string }

export type SlotScript = SlotStep[]

/**
 * The judge roles a scripted backend can recognise, and the role vocabulary is
 * recovered FROM THE INSTRUCTION TEXT the stage handed it.
 *
 * `ModelBackend.runTurn` takes no role parameter — deliberately, since a backend
 * runs a turn and knows nothing about the pipeline — but a fake has to answer
 * four different schemas for one slot. The instruction text is the one thing the
 * stage passes that identifies which question is being asked, so the fake reads
 * it. Nothing in production does this; it is a test double recovering a fact the
 * port has no reason to carry.
 */
const JUDGE_TEXTS: readonly (readonly [JudgeRoleTag, string])[] = [
  ["evidence-extract", CODING_EVIDENCE_EXTRACT.text],
  ["fact-check", CODING_FACT_CHECK.text],
  ["logic-eval", CODING_LOGIC_EVAL.text],
  ["aggregate", CODING_AGGREGATE.text],
]

export type JudgeRoleTag = "evidence-extract" | "fact-check" | "logic-eval" | "aggregate"

export function judgeRoleOf(instructions: string): JudgeRoleTag | undefined {
  return JUDGE_TEXTS.find(([, text]) => text === instructions)?.[0]
}

/**
 * A plausible, schema-valid answer per judge role.
 *
 * They exist so a test about DISCOVERY or DEBATE does not have to script four
 * more turns per finding to stay green — and, more importantly, so it does not
 * silently acquire a `model-dropped-out` warning it was never about. A test that
 * IS about judging overrides them.
 *
 * The fact-check answer reports a check it "ran", because the default should be
 * the healthy path; the untooled path is a degradation and every test that wants
 * it asks for it explicitly.
 */
export const DEFAULT_JUDGE_ANSWERS: Record<JudgeRoleTag, unknown> = {
  "evidence-extract": {
    evidence: "Participant A says the constant is never read; B says it is read on the error path.",
    pointers: ["src/pay.ts:12"],
  },
  "fact-check": {
    checks: ["opened src/pay.ts and read lines 1-40"],
    findings: "The cited line reads `const fee = total * rate`, which supports the claim.",
    verdict: "upheld",
    evidenceKind: "line-cite",
  },
  "logic-eval": { assessment: "A argued from the code and is adequate; B asserted and is weak." },
  aggregate: {
    verdict: "upheld",
    reasoning: "The cited line says what the finding claims it says.",
    evidenceKind: "line-cite",
  },
}

/**
 * A scripted backend. Each slot gets a list of per-attempt outcomes; attempt i
 * uses entry i, and the last entry repeats. `raw` returns a value that is run
 * through the real schema, so schema-invalid responses can be exercised end to
 * end (AD-12).
 *
 * JUDGE TURNS ARE SCRIPTED SEPARATELY, by role rather than by slot, because one
 * slot answers up to four different schemas in one run and a single per-slot
 * sequence cannot express that. Attempts are counted per (slot, role), so the
 * one-retry contract is exercised per role too.
 */
export class FakeBackend implements ModelBackend {
  readonly calls: { slot: string; attempt: number; role?: JudgeRoleTag }[] = []
  private readonly attempts = new Map<string, number>()

  constructor(
    private readonly script: Record<string, SlotScript>,
    /**
     * Tool capability per slot. UNLISTED SLOTS ARE TOOL-CAPABLE — the opposite of
     * this fake's original default, and deliberate: `capabilities()` has exactly
     * one caller in the core, the judge's AD-13 routing, so a fake that defaulted
     * to "no tools" would make every pipeline test report an untooled fact-check
     * it was never about. A test that wants the degradation says `false`.
     */
    private readonly toolcall: Record<string, boolean> = {},
    /** Per-judge-role overrides. Absent roles use `DEFAULT_JUDGE_ANSWERS`. */
    private readonly judgeScript: Partial<Record<JudgeRoleTag, SlotScript>> = {},
  ) {}

  capabilities(slot: string): BackendCapabilities {
    return { tools: this.toolcall[slot] !== false }
  }

  async runTurn<T>(
    slot: string,
    instructions: string,
    _input: string,
    schema: ZodType<T>,
  ): Promise<Envelope<T>> {
    const role = judgeRoleOf(instructions)
    const key = role === undefined ? slot : `${slot}\0${role}`
    const attempt = (this.attempts.get(key) ?? 0) + 1
    this.attempts.set(key, attempt)
    this.calls.push(role === undefined ? { slot, attempt } : { slot, attempt, role })

    const steps =
      role === undefined
        ? (this.script[slot] ?? [])
        : (this.judgeScript[role] ?? [{ kind: "ok", value: DEFAULT_JUDGE_ANSWERS[role] }])
    const step = steps[Math.min(attempt - 1, steps.length - 1)]
    if (!step) {
      return { ok: false, slot, failure: "empty-response", message: "no script", tokens: tokens() }
    }

    if (step.kind === "fail") {
      return {
        ok: false,
        slot,
        failure: step.failure,
        message: step.message ?? "scripted failure",
        tokens: tokens(),
      }
    }

    const parsed = schema.safeParse(step.value)
    if (!parsed.success) {
      return {
        ok: false,
        slot,
        failure: "schema-invalid",
        message: parsed.error.issues.map((i) => i.message).join("; "),
        tokens: tokens(),
        // Mirrors the real adapter: the unvalidated payload rides along so the
        // stage can salvage the valid items from it.
        raw: step.value,
      }
    }
    return { ok: true, slot, value: parsed.data, tokens: tokens() }
  }
}

export function candidate(providerId: string, modelId: string, toolcall = true): Candidate {
  return { providerId, modelId, toolcall }
}

export function fakeChange(): ChangeSet {
  return {
    description: "working tree (git diff HEAD)",
    files: ["src/pay.ts"],
    diff: "--- a/src/pay.ts\n+++ b/src/pay.ts\n@@ -1 +1 @@\n-const fee = 0\n+const fee = total * rate\n",
  }
}

/** One material span found in a prompt, with the offsets of its BODY. */
export interface MaterialSpan {
  label: MaterialLabel
  body: string
  /** Offset of the body's first byte in the prompt. */
  start: number
  /** Offset one past the body's last byte. Equals `start` for an empty body. */
  end: number
}

/**
 * The material spans in one prompt (AD-18), read the way a reader would.
 *
 * Deliberately NOT `material()` in reverse: a helper that rebuilt the expected
 * string from the function under test would pass under any change made to both.
 * It scans for a labelled fence line, then takes every line up to the first line
 * exactly equal to that fence — which is also why a forged header inside a body
 * cannot open a span of its own, since it is consumed as body before the scan
 * reaches it.
 *
 * ## It THROWS rather than tolerating a malformed span
 *
 * Three failures, all of which a lenient parser turned into a passing test (code
 * review 2026-08-27):
 *
 * - **No closing fence.** Treating end-of-input as the close made every "the
 *   order is inside the span" assertion true for a span that never closed, and
 *   clamping the end offset instead scored a plant on the final line as OUTSIDE
 *   the span — a real regression failing with a misleading message.
 * - **No notice.** Matching only the fence line meant a span emitted with no
 *   notice sentence passed every pipeline test, while AD-18's rule is the
 *   sentence as much as the fence.
 * - **An unknown label.** Every label is a literal in `MaterialLabel`, so one the
 *   parser does not recognise at the top level is either a new span nobody
 *   updated this list for, or content that got out.
 *
 * Throwing puts the diagnosis in the failure message instead of leaving the
 * caller to work out which of its own assertions lied.
 */
export function materialSpans(prompt: string): MaterialSpan[] {
  const spans: MaterialSpan[] = []
  const lines = prompt.split("\n")
  let offset = 0
  const offsets = lines.map((line) => {
    const at = offset
    offset += line.length + 1
    return at
  })

  for (let i = 0; i < lines.length; i += 1) {
    const open = /^(`{3,})material: (.+)$/.exec(lines[i]!)
    if (!open) continue
    const [fence, label] = [open[1]!, open[2]!]

    if (!(label in MATERIAL_NOTICES)) {
      throw new Error(`unknown material label "${label}" opened a span at line ${i + 1}`)
    }
    const known = label as MaterialLabel
    if (lines[i - 1] !== noticeFor(known)) {
      throw new Error(
        `material span "${label}" is not preceded by its notice sentence (line ${i} reads ${JSON.stringify(lines[i - 1] ?? null)})`,
      )
    }

    let j = i + 1
    for (; j < lines.length && lines[j] !== fence; j += 1) {}
    if (j >= lines.length) {
      throw new Error(`material span "${label}" opened at line ${i + 1} is never closed`)
    }

    const body = lines.slice(i + 1, j).join("\n")
    const start = offsets[i + 1]!
    spans.push({ label: known, body, start, end: start + body.length })
    i = j
  }
  return spans
}

/**
 * The fence that opens `label`'s span, found by PARSING rather than by position.
 *
 * FOUND, NOT ASSUMED AT LINE 1 (code review 2026-08-30, second pass). Two tests —
 * `adapters/opencode/plugin-wiring.test.ts` and
 * `fixtures/prompt-injection/injection.test.ts` — each reverse-engineered the
 * fence from `output.split("\n")[1]` and then subtracted the label's length,
 * which assumes the notice is exactly one line AND that this is the first span.
 * Both assumptions are true today and neither is checked: a notice that gains a
 * break would have made both tests measure the wrong string and still PASS, in
 * the one assertion that proves the fence outruns the body's longest backtick
 * run. Parsing the opener cannot silently measure something else — it throws.
 *
 * No fence literal here either: this file is scanned by
 * `scripts/lint-material-spans.ts` and is not exempt.
 */
export function fenceOf(text: string, label: MaterialLabel): string {
  const opener = new RegExp(`^(\`{3,})material: ${label}$`, "m").exec(text)
  if (!opener) throw new Error(`no material span labelled "${label}" opens in this text`)
  return opener[1]!
}

/** Every offset at which `needle` occurs in `haystack`. */
export function occurrencesOf(haystack: string, needle: string): number[] {
  const found: number[] = []
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    found.push(at)
  }
  return found
}
