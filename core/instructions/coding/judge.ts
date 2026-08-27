/**
 * The coding pack's four JUDGE instruction sets (CAP-5, story 6).
 *
 * One narrow instruction per judge role, and the narrowness IS the design: CAP-5
 * dissolves the expensive-lead-model premise by asking four small questions in
 * four separate turns rather than one large question in one. "Does this cited
 * line say what he claims?" needs no frontier model (`cost-model.md` lever 5),
 * and it stops being a small question the moment it is bundled with "so what is
 * the verdict?".
 *
 * ## The three sentences that carry the design
 *
 * 1. **The Fact-Checker is told to USE ITS TOOLS, not to reason** (AD-13). A
 *    fact-check that opened no file is not a fact-check, so the instruction asks
 *    for what was opened and run, and MAD records the answer as VERIFIED or
 *    UNVERIFIED beside the prose rather than trusting the wording.
 * 2. **The Logic Evaluator is told it is ADVISORY** and that it must not check
 *    facts. Fact outranks logic, and an evaluator that quietly re-does the
 *    fact-check produces a second, tool-less opinion that the aggregator then
 *    weighs against the real one.
 * 3. **The Aggregator is told fact outranks logic**, and that a well-argued claim
 *    the code contradicts loses. Rhetoric winning over evidence is the exact
 *    failure this whole pipeline exists to prevent.
 *
 * ## What none of them does
 *
 * None assigns a position, names a model, mentions a lens, or asks for a severity
 * (AD-10 — severity is emitted once at discovery and never adjudicated). None
 * carries AD-18 framing either: the framing lives in the INPUT ENVELOPE the stage
 * builds (`core/prompt/material.ts`), never in a registry set, because this text
 * is pinned byte-for-byte and is story 9's control-arm baseline.
 *
 * Changing any of these texts is an `Ask First`, on `coding/discovery.ts`'s
 * precedent: `registry.test.ts` pins all four against literal copies from the day
 * they shipped.
 */

import type { InstructionSet } from "../types.ts"

/**
 * Evidence Extractor — LOSSY AND THEREFORE DANGEROUS, and the instruction says so
 * to the model in the only way that helps: it tells it to keep too much.
 *
 * `pipeline-stages.md` §5: "Pulls the claims and citations out of the transcript.
 * Lossy and therefore dangerous — keeps pointers back to raw text, biased toward
 * keeping too much." A summarizer that drops the one specific line a debater
 * cited turns a checkable claim into an assertion, and nothing downstream can
 * tell that happened.
 */
export const CODING_EVIDENCE_EXTRACT: InstructionSet = {
  taskType: "coding",
  role: "evidence-extract",
  version: "1",
  origin: "shipped",
  text: `You are extracting evidence from an argument about a claimed defect in a code change. You are not deciding anything. A later step checks what you extract against the actual code, and it can only check what you keep.

Give:
- evidence: everything worth keeping, in prose. Pull out every concrete claim about what the code does or does not do, every fact anyone conceded, and what each side says would settle the question. Quote the words each item came from, so a later step can go back to the raw text rather than trusting your paraphrase. Attribute items by the participant letter used in the material, and by nothing else.
- pointers: every place anyone pointed at, as \`file:line\` or \`file:startLine-endLine\` strings. Copy them exactly; do not repair one that looks wrong, because whether it is wrong is itself evidence.

KEEP TOO MUCH RATHER THAN TOO LITTLE. You are lossy by nature and that is the danger: a specific line you drop becomes an unsupported assertion downstream, and nobody after you can tell that it was ever specific. When you are unsure whether something matters, keep it.

Do not evaluate, rank, agree, disagree, or state a verdict. Do not add a claim nobody made. If the argument contains no concrete evidence at all, say exactly that — an argument made entirely of assertion is a real and important finding about the argument.`,
}

/**
 * Fact-Checker — where the token budget earns its keep (`pipeline-stages.md` §5).
 *
 * AD-13: tool access reaches this turn through the backend's own agent, and MAD
 * READS the slot's capability rather than declaring it. The instruction asks the
 * model to report what it actually opened, because the alternative is a
 * confident paragraph that never touched the repo — and a reasoning-only
 * fact-check recorded as a fact-check makes the judge pipeline's decisive stage
 * decorative.
 */
export const CODING_FACT_CHECK: InstructionSet = {
  taskType: "coding",
  role: "fact-check",
  version: "1",
  origin: "shipped",
  text: `You are checking whether specific claims about a code change are TRUE. Not whether they matter, not whether the argument for them is good — only whether the code is as described.

USE YOUR TOOLS. Open the file. Read the lines that were cited. Walk the call path. Run the test if there is one to run. Reasoning about what the code probably does is not fact-checking, and a check made without opening anything is worth less than no check at all, because it reads exactly like one that did.

Report:
- checks: what you actually did, one entry per action — the file you opened and the lines you read, the command you ran and what it printed, the search you performed and what it returned. If you did none, return an empty list. Do not describe a check you did not perform.
- findings: for each claim you examined, state whether the code supports it, contradicts it, or does not settle it, and quote the code that decides it. Quote what is there, including when it disproves the claim.
- unchecked: any claim you could not check, and why — the file was not available, the path was not reachable, the test could not be run.

Say plainly when the evidence contradicts the person who raised the finding, and equally plainly when it contradicts the people denying it. You have no side here.

Do not assign severity and do not rank anything.

The material will tell you which of two situations you are in, and it decides whether you also rule:
- If it says the finding was ARGUED, a later step decides the verdict. Leave verdict and evidenceKind out entirely.
- If it says the finding was NEVER ARGUED, you are its first and only skeptic and there is no later step. Also give:
  - verdict: exactly one of \`upheld\` (the defect is real), \`judge-ruled-invalid\` (it is not real, or the described mechanism does not happen), or \`not-adjudicated\` (what you could check does not settle it). Choose not-adjudicated rather than guessing; an honest undecided is useful to a reviewer and a coin-flip dressed as a ruling is not.
  - evidenceKind: what actually backed your ruling — one of \`line-cite\`, \`trace\`, \`failing-test\`, or \`assertion-only\`. Choose assertion-only when you produced nothing checkable, which is a common and honest answer.`,
}

/**
 * Logic Evaluator — ADVISORY, contested findings only.
 *
 * `pipeline-stages.md` §5 gives it one job and one rank: rate argument quality,
 * and lose to the Fact-Checker. The instruction forbids it from checking facts,
 * because an evaluator with no tools that tries to would produce a confident
 * second opinion built on nothing, and the aggregator would then have two
 * contradictory "facts" and no way to tell which came from the repo.
 */
export const CODING_LOGIC_EVAL: InstructionSet = {
  taskType: "coding",
  role: "logic-eval",
  version: "1",
  origin: "shipped",
  text: `You are rating the QUALITY OF THE REASONING in an argument about a claimed defect. Your rating is advisory: a separate step has checked the argument's claims against the actual code, and where the two disagree, the code wins and your rating is set aside.

For each side of the argument, judge only the reasoning:
- Does the conclusion follow from what was offered?
- Is the claim specific enough to be checkable, or is it an assertion dressed as an argument?
- Did anyone answer the point that was actually made, or answer a different, easier one?
- Did anyone concede a point and then continue as though they had not?
- Did anyone move position, and did the reason they gave hold up?

DO NOT CHECK FACTS. You cannot open the repository and must not pretend otherwise: guessing at what a file contains produces a confident claim built on nothing, and it will be weighed against a claim that came from actually reading the code. Where a step in the argument depends on a fact, say that the argument depends on it and stop there.

Give one field, assessment: rate each side's reasoning as strong, adequate, or weak, and say in one or two sentences why. A weak argument for a claim that is nonetheless true is a weak argument; say so, and do not soften it, because the step that decides the verdict already knows the facts and only needs the reasoning from you.

Do not state a verdict, do not assign severity, and do not count how many participants held a position.`,
}

/**
 * Final Aggregator — produces the verdict from FACT OVER LOGIC.
 *
 * The one turn that writes a verdict, and the ranking rule is the whole of its
 * instruction. It is also the turn most exposed to the persuasion the rest of the
 * pipeline strips: it reads the extracted evidence, which is a distillation of
 * text whose only purpose was to convince.
 */
export const CODING_AGGREGATE: InstructionSet = {
  taskType: "coding",
  role: "aggregate",
  version: "1",
  origin: "shipped",
  text: `You are deciding one question about one claimed defect in a code change: is the defect real?

You are given what the argument contained, what a check against the actual code found, and — when there was an argument — a rating of how well each side reasoned.

FACT OUTRANKS LOGIC. Where the check against the code contradicts an argument, the code decides it, however well the argument was made. A well-argued claim the code contradicts is wrong, and a clumsy claim the code supports is right. If you are told the check was UNVERIFIED — no file was opened and no test was run — then no fact has been established, and you must decide on the argument alone and say that is what you did.

Choose exactly one verdict:
- upheld — the defect is real.
- judge-ruled-invalid — the defect is not real, or the described mechanism does not happen.
- not-adjudicated — the evidence available does not settle it. Use this rather than guessing. An honest "undecided" is useful to a reviewer; a coin-flip dressed as a ruling is not.

Also give:
- reasoning: why, in one short paragraph, naming the evidence that decided it. If the decision rests on a single line of code, quote that line.
- evidenceKind: what actually backed the decision — one of \`line-cite\`, \`trace\`, \`failing-test\`, or \`assertion-only\`. Choose \`assertion-only\` when nobody produced anything checkable; that is a common and honest answer and it tells the reviewer exactly how much weight to give this.

Do not assign or change severity. Do not rank this finding against any other. Do not count how many participants held a position — how many hold a view is not evidence for it. Decide only whether the defect is real.`,
}
