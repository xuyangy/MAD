/**
 * CAP-8 through the real pipeline (story 10).
 *
 * `core/judge/blame.test.ts` proves the parser and `adapters/opencode/tools.test.ts`
 * proves the adapter. This file proves the PIPELINE: a change goes in at the
 * `review()` seam, MAD drives the `Tools` port itself, and the rendered output
 * at the other end carries a `git blame` citation as the reason a finding was
 * ruled invalid — the artefact CAP-8's success clause names and that nothing in
 * this repository had ever produced.
 *
 * ## The scripted model READS the blame, it is not told the answer
 *
 * The backend below is not a lookup table keyed on which arm is running. It
 * looks in its own prompt for the blame span MAD built, reads the commit subject
 * out of it, and rules accordingly — which is what a real fact-checker does with
 * the same input. That is what makes the pair non-vacuous: nothing in the two
 * runs differs except the bytes `Tools.blame` returned.
 */

import { describe, expect, test } from "bun:test"

import { spent } from "../../core/budget/ledger.ts"
import type { Finding } from "../../core/domain/finding.ts"
import type { ModelBackend } from "../../core/ports/model-backend.ts"
import type { Tools } from "../../core/ports/tools.ts"
import { selectRoster } from "../../core/roster/select.ts"
import { review } from "../../core/run/review.ts"
import {
  candidate,
  fakeClock,
  judgeRoleOf,
  materialSpans,
  tokens,
  type JudgeRoleTag,
} from "../../core/test-support/fakes.ts"
import {
  BLAME_CHANGE,
  BLAME_DEFECT,
  BLAME_FILE,
  CONTRADICTING_BLAME,
  CONTRADICTING_SUBJECT,
  LOCUS_FIRST_LINE,
  LOCUS_LAST_LINE,
  SUPPORTING_BLAME,
  SUPPORTING_SUBJECT,
  blameLocus,
} from "./change.ts"

interface Turn {
  slot: string
  input: string
  role?: JudgeRoleTag
}

const CANDIDATES = [
  candidate("anthropic", "claude-sonnet-4-5"),
  candidate("openai", "gpt-5"),
  candidate("google", "gemini-2.5-pro"),
]

/** What `Tools.blame` was asked for, so T-cases can assert the argv MAD chose. */
interface BlameCall {
  path: string
  startLine: number
  endLine: number
}

/**
 * The `Tools` fake — a PLAIN OBJECT LITERAL, deliberately not in
 * `core/test-support/fakes.ts`.
 *
 * `fakes.ts` is exempt from `scripts/lint-material-spans.ts`, and a fake that
 * lived there would inherit that exemption by accident. Nothing about this
 * object needs to be shared, and the four undriven methods throwing here mirrors
 * what the shipped adapter does.
 */
function fakeTools(options: {
  blame?: string
  fail?: string
  calls?: BlameCall[]
}): Tools {
  const notDriven = (method: string) => () => {
    throw new Error(`the blame fixture does not drive Tools.${method}`)
  }
  return {
    async blame(path: string, startLine: number, endLine: number): Promise<string> {
      options.calls?.push({ path, startLine, endLine })
      if (options.fail !== undefined) throw new Error(options.fail)
      return options.blame ?? ""
    },
    readFile: notDriven("readFile") as Tools["readFile"],
    list: notDriven("list") as Tools["list"],
    grep: notDriven("grep") as Tools["grep"],
    runTest: notDriven("runTest") as Tools["runTest"],
  }
}

/**
 * The blame body MAD put in this prompt, read back out of the material span
 * rather than off the raw string.
 *
 * Going through `materialSpans` is the point: if the citation ever reached a
 * model OUTSIDE a span, this returns `undefined` and every verdict assertion
 * below flips — so AD-18 compliance is load-bearing for the fixture rather than
 * something a separate test has to remember to check.
 */
function blameSpanOf(prompt: string): string | undefined {
  return materialSpans(prompt).find((span) => span.label === "git blame output")?.body
}

/**
 * The scripted models. `discovery-1` raises the finding; the other two are
 * silent, which is a legitimate answer (silence is abstention, not denial).
 *
 * The FACT-CHECKER is the interesting one and it reasons from its input:
 * - a blame span whose commit predates this change destroys the finding's
 *   premise, so it rules `judge-ruled-invalid` and says why;
 * - a blame span whose commit is the change itself confirms it, so it upholds;
 * - NO blame span at all and it has nothing but the diff, so it upholds on the
 *   diff's own reading — which is exactly the reading blame exists to test, and
 *   is what makes the no-port arm a real control rather than a stub.
 */
function scriptedBackend(
  recorded: Turn[],
  options: { tools?: boolean; silentChecks?: boolean; noLines?: boolean } = {},
): ModelBackend {
  return {
    capabilities: () => ({ tools: options.tools ?? true }),
    async runTurn(slot, instructions, input, schema) {
      const role = judgeRoleOf(instructions)
      recorded.push(role === undefined ? { slot, input } : { slot, input, role })

      if (role === "fact-check" || role === "aggregate") {
        const blame = blameSpanOf(input)
        const contradicted = blame !== undefined && blame.includes(CONTRADICTING_SUBJECT)
        const supported = blame !== undefined && blame.includes(SUPPORTING_SUBJECT)

        // `silentChecks` is the checker that REPORTS NOTHING. It still reads the
        // blame span and still rules on it — what it does not do is write a
        // `checks` list, which is the half of the old verification MAD could
        // never trust. It is what isolates `madExecuted` in `factVerified`.
        const checks = options.silentChecks
          ? []
          : blame === undefined
            ? ["read the diff and the finding; opened no file"]
            : [`read the git blame MAD ran over ${BLAME_FILE}`]

        const payload =
          role === "fact-check"
            ? {
                checks,
                findings: contradicted
                  ? `The blame MAD ran says these lines were last changed in 2023, under the commit ` +
                    `"${CONTRADICTING_SUBJECT}". The finding's premise — that the loop is introduced ` +
                    `by this change and has never run — is contradicted by the repository's own history.`
                  : supported
                    ? `The blame MAD ran says these lines were last changed by "${SUPPORTING_SUBJECT}", ` +
                      `which is this change. The finding's premise holds.`
                    : `Reading the diff alone, every line of the loop is added by this change, so the ` +
                      `premise appears to hold. Nothing was checked against the repository's history.`,
                verdict: contradicted ? "judge-ruled-invalid" : "upheld",
                evidenceKind: contradicted || supported ? "line-cite" : "assertion-only",
              }
            : {
                verdict: contradicted ? "judge-ruled-invalid" : "upheld",
                reasoning: contradicted
                  ? `Ruled invalid on the git blame MAD ran: the cited lines predate this change, so ` +
                    `the claim that they are new is false and everything resting on it falls with it.`
                  : `Upheld: nothing contradicts the claim that these lines are new.`,
                evidenceKind: contradicted || supported ? "line-cite" : "assertion-only",
              }

        const parsed = schema.safeParse(payload)
        return parsed.success
          ? { ok: true, slot, value: parsed.data, tokens: tokens() }
          : { ok: false, slot, failure: "schema-invalid", message: "n/a" }
      }

      if (role !== undefined) {
        const defaults: Record<string, unknown> = {
          "evidence-extract": {
            evidence: "The reviewer says the loop is new; nobody disputed it.",
            pointers: [`${BLAME_FILE}:${blameLocus().startLine}`],
          },
          "logic-eval": { assessment: "The argument is internally consistent and rests on one premise." },
        }
        const parsed = schema.safeParse(defaults[role])
        return parsed.success
          ? { ok: true, slot, value: parsed.data, tokens: tokens() }
          : { ok: false, slot, failure: "schema-invalid", message: "n/a" }
      }

      // DEBATE. Not a judge role, so `judgeRoleOf` cannot see it, and the
      // envelope is what tells a debate turn from a discovery one: only debate's
      // schema accepts `turns`. The finding id comes off MAD's own header line
      // (`debate.ts:459`) rather than being written down here, so this branch
      // cannot drift from the id the run actually minted.
      //
      // ONE SPEAKER IS ENOUGH and is the honest script: the author restates its
      // claim and nobody denies it. Silence is abstention, not denial, so the
      // other two saying nothing is a legitimate answer — and a non-empty
      // transcript is what routes the finding through the AGGREGATOR, which is
      // the path this fixture otherwise never reaches.
      const debated = /## finding `([^`]+)`/.exec(input)
      if (debated !== null && slot === "discovery-1") {
        const turn = schema.safeParse({
          turns: [
            {
              findingId: debated[1],
              position: "upholds",
              argument:
                "The diff replaces the whole function body, so every line of the loop is added here. " +
                "I stand by the claim.",
            },
          ],
        })
        if (turn.success) return { ok: true, slot, value: turn.data, tokens: tokens() }
      }

      const locus = blameLocus()
      const payload =
        slot === "discovery-1"
          ? {
              findings: [
                {
                  claim: BLAME_DEFECT.claim,
                  reasoning: BLAME_DEFECT.reasoning,
                  severity: BLAME_DEFECT.severity,
                  file: locus.file,
                  // `noLines` raises the FILE-ONLY finding — the architectural
                  // claim with no single site that `core/domain/finding.ts`
                  // explicitly permits. Omitted here rather than stripped after
                  // the fact, because discovery owns the locus (AD-8) and no
                  // later stage may write it.
                  ...(options.noLines
                    ? {}
                    : { startLine: locus.startLine, endLine: locus.endLine }),
                },
              ],
            }
          : { findings: [] }
      const parsed = schema.safeParse(payload)
      return parsed.success
        ? { ok: true, slot, value: parsed.data, tokens: tokens() }
        : { ok: false, slot, failure: "schema-invalid", message: "n/a" }
    },
  }
}

/**
 * One arm. Everything is held constant except the `Tools` port — which is the
 * only way the pair can be read as evidence about blame rather than about the
 * script.
 *
 * `threshold: 0` sends the finding straight to judging: at 1/3 co-discovery it
 * would otherwise be debated, and the Fact-Checker is a cleaner subject when it
 * is the finding's first and only skeptic (`pipeline-stages.md` §5).
 */
async function blameArm(
  options: { tools?: Tools; backendTools?: boolean; silentChecks?: boolean; noLines?: boolean } = {},
) {
  const recorded: Turn[] = []
  const resolved = selectRoster(CANDIDATES, { slots: 3, providerConfigKey: "provider" })
  const result = await review({
    roster: resolved.roster,
    backend: scriptedBackend(recorded, {
      tools: options.backendTools,
      silentChecks: options.silentChecks,
      noLines: options.noLines,
    }),
    clock: fakeClock(),
    change: BLAME_CHANGE,
    priorWarnings: resolved.warnings,
    threshold: 0,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  })
  return { ...result, recorded }
}

/**
 * The same arm, DEBATED — the four-turn path, which is the only one with an
 * aggregator.
 *
 * `threshold: 1` puts the finding's 1/3 co-discovery below the bar, so it is
 * routed to debate rather than judged verify-independently; `discovery-1` then
 * takes one turn and the transcript is non-empty, which is what `judge.ts`
 * reads as `argued`. Everything else is `blameArm`'s, so a difference between
 * the two is a difference in ROUTE and in nothing else.
 */
async function debatedArm(options: { tools?: Tools } = {}) {
  const recorded: Turn[] = []
  const resolved = selectRoster(CANDIDATES, { slots: 3, providerConfigKey: "provider" })
  const result = await review({
    roster: resolved.roster,
    backend: scriptedBackend(recorded),
    clock: fakeClock(),
    change: BLAME_CHANGE,
    priorWarnings: resolved.warnings,
    threshold: 1,
    maxRounds: 1,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  })
  return { ...result, recorded }
}

const theFinding = (findings: Finding[]): Finding => {
  const found = findings.find((f) => f.claim === BLAME_DEFECT.claim)
  if (found === undefined) throw new Error("the fixture's finding was not raised")
  return found
}

describe("the fixture is self-consistent — nothing is written down twice", () => {
  test("the locus is DERIVED from the diff and lands on the loop", () => {
    // `fixtures/seeded-defects/recall.test.ts` learned this the expensive way.
    const { file, startLine, endLine } = blameLocus()
    expect(file).toBe(BLAME_FILE)
    expect(endLine).toBeGreaterThan(startLine)
    const body = BLAME_CHANGE.diff
    expect(body).toContain(LOCUS_FIRST_LINE)
    expect(body).toContain(LOCUS_LAST_LINE)
  })

  test("the two blame outputs differ ONLY in the commit behind the lines", () => {
    // If they differed in the lines they cover, the pair would be comparing two
    // different questions and the opposite verdicts would prove nothing.
    expect(CONTRADICTING_BLAME).toContain(CONTRADICTING_SUBJECT)
    expect(SUPPORTING_BLAME).toContain(SUPPORTING_SUBJECT)
    const linesOf = (porcelain: string) =>
      porcelain.split("\n").filter((line) => line.startsWith("\t"))
    expect(linesOf(CONTRADICTING_BLAME)).toEqual(linesOf(SUPPORTING_BLAME))
    expect(linesOf(CONTRADICTING_BLAME).length).toBeGreaterThan(1)
  })
})

describe("T1 — blame DECIDES a finding, and the pair is what makes that non-vacuous", () => {
  test("AC: blame contradicts the claim, so the finding is RULED INVALID", async () => {
    const { record } = await blameArm({ tools: fakeTools({ blame: CONTRADICTING_BLAME }) })
    expect(theFinding(record.findings).verdict).toBe("judge-ruled-invalid")
  })

  test("AC: the SIBLING fixture, where blame supports the claim, reaches the OPPOSITE verdict", async () => {
    // The half without which the test above proves nothing.
    const { record } = await blameArm({ tools: fakeTools({ blame: SUPPORTING_BLAME }) })
    expect(theFinding(record.findings).verdict).toBe("upheld")
  })

  test("CAP-8's success clause, rendered: the citation IS the deciding evidence", async () => {
    const { rendered } = await blameArm({ tools: fakeTools({ blame: CONTRADICTING_BLAME }) })

    // Its OWN heading (AD-9): evidence, the check and the verdict stay three
    // separate fields, and the citation is not fused into any of them.
    expect(rendered).toContain("GIT BLAME — RUN BY MAD, NOT REPORTED BY A MODEL")
    // The citation itself, with the commit that settled it.
    expect(rendered).toContain(CONTRADICTING_SUBJECT)
    expect(rendered).toContain(`${BLAME_FILE} lines ${blameLocus().startLine}-${blameLocus().endLine}`)

    // AND THE CITATION IS WHY. On the verify-independently route there is no
    // aggregator, so the deciding prose is the fact-check's own — the judge's
    // step list names the blame as what it checked, and the reason it gives is
    // the contradiction that blame produced.
    expect(rendered).toContain("verdict: judge-ruled-invalid")
    expect(rendered).toContain("`git blame` RUN BY MAD over the cited lines")
    expect(rendered).toContain("contradicted by the repository's own history")
  })

  test("CAP-8's success clause on the DEBATED route, where an aggregator writes the reason", async () => {
    // The other half of the rendered claim. Verify-independently has no
    // aggregator, so without this arm the aggregate's own citation-carrying
    // reasoning would never be rendered by any test.
    const { record, rendered } = await debatedArm({ tools: fakeTools({ blame: CONTRADICTING_BLAME }) })

    expect(theFinding(record.findings).verdict).toBe("judge-ruled-invalid")
    expect(rendered).toContain("GIT BLAME — RUN BY MAD, NOT REPORTED BY A MODEL")
    expect(rendered).toContain("Ruled invalid on the git blame MAD ran")
  })

  test("the DEBATED arm's sibling reaches the opposite verdict too", async () => {
    // Non-vacuity for the arm above: the route is not what decides, the blame is.
    const { record } = await debatedArm({ tools: fakeTools({ blame: SUPPORTING_BLAME }) })
    expect(theFinding(record.findings).verdict).toBe("upheld")
  })

  test("the heading appears in the CONTRADICTING arm and is absent when MAD ran nothing", async () => {
    const withPort = await blameArm({ tools: fakeTools({ blame: CONTRADICTING_BLAME }) })
    const withoutPort = await blameArm()
    expect(withPort.rendered).toContain("GIT BLAME — RUN BY MAD")
    expect(withoutPort.rendered).not.toContain("GIT BLAME — RUN BY MAD")
  })
})

describe("T2 — MAD EXECUTED IT, and that is not the same fact as VERIFIED", () => {
  test("the fact-check carries MAD's own execution prefix, not the self-report one", async () => {
    const { record } = await blameArm({ tools: fakeTools({ blame: CONTRADICTING_BLAME }) })
    const finding = theFinding(record.findings)
    expect(finding.factCheck).toStartWith("VERIFIED BY MAD (`git blame` run by MAD over the cited lines)")
    expect(finding.factCheck).not.toContain("self-reported")
  })

  test("a run where the model REPORTS checks and MAD executed nothing is NOT MAD-verified", async () => {
    // The non-vacuity clause of T2, stated as its own run. The checker here
    // reports a check and the slot is tool-capable, so `factVerified` is true and
    // AD-13's second route is working exactly as it did before story 10 — and the
    // record still says nobody but the model saw a file.
    const { record } = await blameArm()
    const finding = theFinding(record.findings)
    expect(finding.factCheck).toStartWith("VERIFIED (self-reported")
    expect(record.judgeCounts?.factChecksMadExecuted).toBe(0)
    expect(record.judgeCounts?.factChecksUnverified).toBe(0)
  })

  test("MAD'S OWN EXECUTION VERIFIES ALONE, with the model reporting no checks at all", async () => {
    // THE POINT OF THE WHOLE STORY, and the one assertion that isolates it.
    //
    // Every other arm here has a checker that both reads the blame AND writes a
    // `checks` list, so `madExecuted || (factCheckTooled && usedTools)` is true
    // on both sides of the `||` and the left operand is never load-bearing. Found
    // by MUTATION: deleting `madExecuted ||` from `judge.ts` broke NOTHING, which
    // means the fixture was agreeing with the code by coincidence.
    //
    // Here the checker reports nothing. The self-report half is therefore FALSE,
    // and the fact-check is verified anyway — on evidence MAD executed. That is
    // the difference between proving a check happened and being told one did.
    const { record } = await blameArm({
      tools: fakeTools({ blame: CONTRADICTING_BLAME }),
      silentChecks: true,
    })
    const finding = theFinding(record.findings)

    expect(finding.factCheck).toStartWith("VERIFIED BY MAD")
    expect(finding.factCheck).not.toContain("Checks run:")
    expect(record.judgeCounts?.factChecksMadExecuted).toBe(1)
    expect(record.judgeCounts?.factChecksUnverified).toBe(0)
    expect(finding.verdict).toBe("judge-ruled-invalid")
  })

  test("with NO port, that same silent checker is UNVERIFIED — the `||` is not free", async () => {
    // The non-vacuous sibling. Same silent checker, no `Tools` port: nothing
    // executed and nothing reported, so neither half holds and MAD says so.
    const { record } = await blameArm({ silentChecks: true })
    const finding = theFinding(record.findings)

    expect(finding.factCheck).toStartWith("UNVERIFIED")
    expect(record.judgeCounts?.factChecksMadExecuted).toBe(0)
    expect(record.judgeCounts?.factChecksUnverified).toBe(1)
  })

  test("the COUNT separates the two routes on the run record", async () => {
    const executed = await blameArm({ tools: fakeTools({ blame: CONTRADICTING_BLAME }) })
    expect(executed.record.judgeCounts?.factChecksMadExecuted).toBe(1)
    expect(executed.rendered).toContain("`git blame` MAD RAN ITSELF")

    const reported = await blameArm()
    expect(reported.record.judgeCounts?.factChecksMadExecuted).toBe(0)
    expect(reported.rendered).toContain("MAD ran no repository command itself in this run")
  })

  test("MAD asked for exactly the lines the finding cites — no translation (AD's Locus convention)", async () => {
    const calls: BlameCall[] = []
    await blameArm({ tools: fakeTools({ blame: CONTRADICTING_BLAME, calls }) })
    // The port names the argument `path` and the domain names the field `file`;
    // the NUMBERS are what must survive untranslated, and they do — `Locus` and
    // `Tools.blame` share one convention (1-indexed, `endLine` inclusive).
    const { file, startLine, endLine } = blameLocus()
    expect(calls).toEqual([{ path: file, startLine, endLine }])
  })

  test("BLAME IS NOT A TURN — it costs wall-clock, not tokens", async () => {
    // AD-15 / the No-new-dial constraint. Two runs over the same script that
    // differ only in whether MAD ran a command must bill identically.
    const executed = await blameArm({ tools: fakeTools({ blame: CONTRADICTING_BLAME }) })
    const reported = await blameArm()
    expect(executed.record.judgeCounts?.turns).toBe(reported.record.judgeCounts?.turns)
    expect(executed.record.judgeCounts?.attempts).toBe(reported.record.judgeCounts?.attempts)
    expect(spent(executed.record.ledger)).toBe(spent(reported.record.ledger))
  })
})

describe("T3 — the two routes stay two, and the record says which one ran", () => {
  test("AC: with NO `Tools` port, AD-13's second route still decides the finding", async () => {
    const { record, rendered } = await blameArm()
    const finding = theFinding(record.findings)
    // It still gets a verdict, still gets a fact-check, and warns about neither.
    expect(finding.verdict).toBe("upheld")
    expect(finding.factCheck).toBeDefined()
    expect(record.warnings.map((w) => w.code)).not.toContain("blame-unavailable")
    expect(record.warnings.map((w) => w.code)).not.toContain("fact-check-untooled")
    // And the row says so, rather than leaving the reader to infer it.
    expect(rendered).toContain("MAD ran nothing itself — the checker's own tools only")
  })

  test("the history distinguishes the routes without parsing any prose", async () => {
    const executed = await blameArm({ tools: fakeTools({ blame: CONTRADICTING_BLAME }) })
    const reported = await blameArm()
    const kinds = (findings: Finding[]) => theFinding(findings).history.map((e) => e.kind)

    expect(kinds(executed.record.findings)).toContain("judge-blame-executed")
    expect(kinds(executed.record.findings)).not.toContain("judge-blame-no-port")
    expect(kinds(reported.record.findings)).toContain("judge-blame-no-port")
    expect(kinds(reported.record.findings)).not.toContain("judge-blame-executed")
  })

  test("AC: a finding with a file but NO line range is not blamed, and says so", async () => {
    // REWRITTEN 2026-09-09 — the version this replaces asserted the OPPOSITE of
    // its own name. Its comment admitted "the scripted discovery DOES carry
    // lines", and its three assertions (`calls` has length 1, a finding exists,
    // the GIT BLAME heading renders) were the WITH-locus arm. It called itself
    // "the control for the no-locus arm below" and no such arm existed, so
    // `judge-blame-no-locus` and its rendered step had zero coverage anywhere in
    // the repository. Found by two independent review layers.
    //
    // The locus is omitted at DISCOVERY, which is the only honest way to build
    // it: discovery owns `locus` under AD-8 and no later stage may write it, so
    // stripping the field after the fact would test a state the pipeline cannot
    // actually produce.
    const calls: BlameCall[] = []
    const { record, rendered } = await blameArm({
      noLines: true,
      tools: fakeTools({ blame: CONTRADICTING_BLAME, calls }),
    })
    const finding = theFinding(record.findings)

    // The port was available and MAD chose not to call it. That is the claim.
    expect(calls).toEqual([])
    expect(finding.locus.startLine).toBeUndefined()

    // NOT a failure, and the distinction is the point: "there were no lines to
    // blame" and "blame ran and failed" are different facts, and reading the
    // first as the second is what raises a spurious degradation warning.
    expect(record.warnings.map((w) => w.code)).not.toContain("blame-unavailable")
    expect(finding.history.some((e) => e.kind === "judge-blame-no-locus")).toBe(true)
    expect(finding.history.some((e) => e.kind === "judge-blame-failed")).toBe(false)

    // And it is SAID, rather than left to be inferred from an absence (AD-6).
    expect(rendered).toContain("no line range to blame")
    expect(rendered).not.toContain("GIT BLAME — RUN BY MAD")
  })

  test("the WITH-locus control, so the test above is a difference and not a default", async () => {
    // The non-vacuous sibling the old test claimed to be. Same fixture, same
    // port, lines present: blame runs, and the two arms differ in the locus and
    // in nothing else.
    const calls: BlameCall[] = []
    const { record, rendered } = await blameArm({
      tools: fakeTools({ blame: CONTRADICTING_BLAME, calls }),
    })
    expect(calls).toHaveLength(1)
    expect(theFinding(record.findings).history.some((e) => e.kind === "judge-blame-no-locus")).toBe(
      false,
    )
    expect(rendered).toContain("GIT BLAME — RUN BY MAD")
  })
})

describe("T4 — a FAILED blame is reported, and never reads as a pass", () => {
  test("AC: the failure raises `blame-unavailable` and no citation is produced", async () => {
    const { record, rendered } = await blameArm({
      tools: fakeTools({ fail: "git blame failed: fatal: no such path 'src/payments/retry.ts' in HEAD" }),
    })

    const warning = record.warnings.find((w) => w.code === "blame-unavailable")
    expect(warning).toBeDefined()
    expect(warning!.message).toContain("no such path")
    expect(warning!.stage).toBe("judge")

    // THE SENTENCE THAT MATTERS: it must not read as "nothing contradicted it".
    expect(warning!.message).toContain('NOT "the history contradicts nothing"')
    expect(rendered).toContain("GIT BLAME FAILED")
    expect(rendered).not.toContain("GIT BLAME — RUN BY MAD, NOT REPORTED BY A MODEL")
  })

  test("a failure is NOT silently the self-report path", async () => {
    // The precise AD-6 failure this guards: a run where the port was present and
    // blame failed must not be indistinguishable from a run where no port was
    // injected at all.
    const failed = await blameArm({ tools: fakeTools({ fail: "fatal: not a git repository" }) })
    const noPort = await blameArm()

    expect(failed.record.warnings.map((w) => w.code)).toContain("blame-unavailable")
    expect(noPort.record.warnings.map((w) => w.code)).not.toContain("blame-unavailable")
    expect(theFinding(failed.record.findings).history.map((e) => e.kind)).toContain("judge-blame-failed")
    expect(theFinding(noPort.record.findings).history.map((e) => e.kind)).toContain("judge-blame-no-port")
  })

  test("git running and returning NOTHING is a failure too, not an empty absence of contradiction", async () => {
    const { record } = await blameArm({ tools: fakeTools({ blame: "" }) })
    expect(record.warnings.map((w) => w.code)).toContain("blame-unavailable")
    expect(record.judgeCounts?.factChecksMadExecuted).toBe(0)
  })

  test("a failed blame still lets the run finish — AD-13 never refuses the run", async () => {
    const { record } = await blameArm({ tools: fakeTools({ fail: "fatal: bad revision" }) })
    expect(theFinding(record.findings).verdict).toBeDefined()
  })
})

describe("T5 — the blame body is MATERIAL, wrapped by the single emitter (AD-18)", () => {
  test("every blame body that reached a model was inside a `git blame output` span", async () => {
    const { recorded } = await blameArm({ tools: fakeTools({ blame: CONTRADICTING_BLAME }) })
    const sawIt = recorded.filter((turn) => turn.input.includes(CONTRADICTING_SUBJECT))
    expect(sawIt.length).toBeGreaterThan(0)
    for (const turn of sawIt) {
      const span = blameSpanOf(turn.input)
      expect(span, `${turn.role ?? "discovery"} saw the blame outside a span`).toBeDefined()
      expect(span!).toContain(CONTRADICTING_SUBJECT)
    }
  })

  test("MAD's own attestation stays OUTSIDE the span, as it does for the fact-check", async () => {
    // The rule this file's stage header states: framing MAD's own statements as
    // material would tell the model to disregard the only lines in front of it
    // that are facts about the run.
    const { recorded } = await blameArm({ tools: fakeTools({ blame: CONTRADICTING_BLAME }) })
    const check = recorded.find((turn) => turn.role === "fact-check")!
    const attestation = "MAD ran this command itself."
    expect(check.input).toContain(attestation)
    for (const span of materialSpans(check.input)) {
      expect(span.body).not.toContain(attestation)
    }
  })

  test("the AGGREGATOR gets the citation too, in its own span and with MAD's third attestation", async () => {
    // Verify-independently mode has no aggregator, so this uses the debated arm.
    const { recorded } = await debatedArm({ tools: fakeTools({ blame: CONTRADICTING_BLAME }) })
    const aggregate = recorded.find((turn) => turn.role === "aggregate")
    expect(aggregate, "the finding never reached the aggregator").toBeDefined()
    expect(blameSpanOf(aggregate!.input)).toContain(CONTRADICTING_SUBJECT)
    expect(aggregate!.input).toContain("This check was VERIFIED BY MAD")
    for (const span of materialSpans(aggregate!.input)) {
      expect(span.body).not.toContain("This check was VERIFIED BY MAD")
    }
  })
})
