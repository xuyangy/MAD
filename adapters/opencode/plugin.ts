/**
 * AD-1 — the opencode plugin entry. This is the ONLY module that knows both the
 * host and the core. It resolves the roster from the host, constructs the port
 * implementations, injects them into `core/run/review.ts`, and renders the
 * result through the host's own surface.
 *
 * A fresh install needs no MAD-specific configuration (AD-3): install the
 * plugin, run the tool, and it reviews with whatever the host already has.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

import {
  clampPreset,
  PRESET_DIALS,
  PRESETS,
  SUGGESTED_BUDGET,
} from "../../core/budget/ledger.ts"
import type { Warning } from "../../core/domain/warning.ts"
import { CODING_LENSES } from "../../core/instructions/coding/lenses.ts"
import { systemClock } from "../../core/ports/clock.ts"
import { oneLine } from "../../core/prompt/material.ts"
import { frameForHostAgent, review } from "../../core/run/review.ts"
import { NoCandidatesError, type Pin } from "../../core/roster/select.ts"
import {
  artifactRootFrom,
  createTurnRecorder,
  dumpRunArtifacts,
  refusalFor,
  type ArtifactOutcome,
} from "./artifacts.ts"
import { OpencodeModelBackend } from "./model-backend.ts"
import { opencodeRepo } from "./repo.ts"
import { resolveRoster } from "./roster.ts"

/**
 * Three discovery slots on a fresh install (AD-3: no configuration required to
 * get the real thing). A default of 1 makes CAP-1 unreachable out of the box —
 * heterogeneous discovery that never fans out is a claim, not a capability.
 *
 * Three, specifically, because the contract reasons in threes wherever it counts
 * model turns. AD-15's amendment is the one that counts DISCOVERY turns — three
 * models with five lenses is eight discovery turns rather than three, the
 * fan-out being `slots + lenses` (AD-15 corrected 2026-08-15; the amendment
 * originally stated a multiplicative eighteen, which no code path produces).
 * (`cost-model.md` lever 1's "3 calls per round instead of 27" is the same three
 * models, but it is counting debate calls per round, not discovery.) It is also
 * the smallest N at which
 * `distinctLineages` can express the ideal roster of AD-4 — Claude + GPT +
 * Gemini — rather than merely two thirds of it.
 *
 * It is a slot COUNT, not a model: MAD still names no model (AD-3), and it
 * triples a fresh install's discovery cost against story 1 deliberately. The
 * `provider-fan-out` disclosure (AD-3) already names every model a run bills.
 *
 * Story 9's single-model control arm is `slots: 1` through this same tool and
 * the same `review()` seam — a smaller argument, never a second code path.
 */
export const DEFAULT_DISCOVERY_SLOTS = 3

/**
 * An upper bound on the fan-out. Each slot is a billed session against the
 * user's own credentials, and the argument comes from a model calling the tool,
 * so an unbounded value is an unbounded charge. Well above any roster a real
 * host resolves; there to stop `slots: 200`, not to tune anything.
 */
export const MAX_DISCOVERY_SLOTS = 12

/**
 * Clamp at BOTH ends. The tool schema bounds the argument too, but the value
 * arrives from a model calling the tool: over the maximum is an unbounded
 * charge, and under 1 is a `selectRoster` throw (`slots must be at least 1`)
 * where the user deserves a review. Exported so the bound is tested rather than
 * trusted.
 *
 * Only ABSENT and NOT-A-NUMBER fall back to the default. The infinities are
 * clamped like any other out-of-range value — `Infinity` is an explicit request
 * for more, so it lands on the maximum rather than quietly becoming the default,
 * which is what this comment already promised and the code did not do.
 */
export function clampDiscoverySlots(slots: number | undefined): number {
  if (slots === undefined || Number.isNaN(slots)) return DEFAULT_DISCOVERY_SLOTS
  return Math.min(Math.max(Math.trunc(slots), 1), MAX_DISCOVERY_SLOTS)
}

/**
 * CAP-11 — an upper bound on the LENS fan-out, for the same reason
 * `MAX_DISCOVERY_SLOTS` exists: each lens is another billed session against the
 * user's own credentials at the widest point of the run (AD-15 amended — three
 * models with five lenses is eight discovery turns rather than three, the
 * fan-out being `slots + lenses`; see `DEFAULT_DISCOVERY_SLOTS` above, which
 * carries the same correction and the reason the amendment's original
 * multiplicative eighteen matches no code path), and the argument arrives from
 * a model calling the tool.
 *
 * Eight, because that is the shipped coding pack: asking for every lens MAD
 * ships is a defensible request, and asking for more than that is a request for
 * lenses that do not exist and would each be generated at run time.
 */
export const MAX_LENS_SLOTS = 8

/**
 * Normalize the `lenses` argument: drop blanks, dedupe, clamp.
 *
 * Deduped because two slots carrying one lens would share a slot id, which the
 * backend's per-slot map cannot represent and a finding's `author` cannot
 * disambiguate — and because paying twice for one persona is not what the caller
 * meant. UNKNOWN IDS ARE NOT REJECTED: they reach the registry's generated
 * fallback (AD-11 amended), and the run record says the instruction was
 * generated rather than shipped. Exported so the bound is tested, not trusted.
 *
 * The `Array.isArray` guard is not ceremony. The value arrives from a model
 * calling the tool, and a bare string would otherwise ITERATE BY CHARACTER —
 * `"security"` becoming eight one-letter lens slots, which is eight billed
 * discovery turns against the user's own credentials for nothing. The tool
 * schema rejects a non-array first; this is the same belt-and-braces the slot
 * clamp already applies, for the same reason.
 */
/**
 * AD-3 amended (story 8A) — the caller's pinned models, bounded on the way in.
 *
 * `provider/model`, split at the FIRST `/` because a model id may contain one
 * (`openrouter/anthropic/claude-sonnet-4-5` is a real shape) while a provider id
 * may not.
 *
 * IT DEDUPES NOTHING AND DROPS NOTHING. Two pins naming one model, a pin the
 * host lacks, a string with no `/` at all — every one of them survives this
 * function and reaches `selectRoster`, which reports it. This layer CANNOT raise
 * a `Warning`: anything it silently discards is a request the user made and
 * nobody ever answered. That is the opposite of `clampLenses`, which drops
 * duplicates because a duplicate lens is a slot that cannot exist, and it is
 * deliberate rather than an inconsistency.
 *
 * The `Array.isArray` guard is `clampLenses`' guard for `clampLenses`' reason: a
 * bare string arriving from a model call would otherwise iterate BY CHARACTER.
 * The length cap is `MAX_DISCOVERY_SLOTS` because a pin can never fill more than
 * a slot, and an unbounded list arriving from a model is an unbounded loop and
 * an unbounded warning message.
 */
export function clampPins(models: readonly string[] | undefined): Pin[] {
  if (!models || !Array.isArray(models)) return []
  const kept: Pin[] = []
  for (const raw of models) {
    const value = typeof raw === "string" ? raw.trim() : ""
    if (value.length === 0) continue
    const cut = value.indexOf("/")
    // No separator: kept as a MALFORMED pin rather than dropped, so the core
    // reports it. An empty `providerId` is what `resolvePins` reads as malformed.
    if (cut < 0) kept.push({ providerId: "", modelId: value })
    else kept.push({ providerId: value.slice(0, cut).trim(), modelId: value.slice(cut + 1).trim() })
    if (kept.length >= MAX_DISCOVERY_SLOTS) break
  }
  return kept
}

export function clampLenses(lenses: readonly string[] | undefined): string[] {
  if (!lenses || !Array.isArray(lenses)) return []
  const seen = new Set<string>()
  const kept: string[] = []
  for (const raw of lenses) {
    const lens = typeof raw === "string" ? raw.trim() : ""
    if (lens.length === 0 || seen.has(lens)) continue
    seen.add(lens)
    kept.push(lens)
    if (kept.length >= MAX_LENS_SLOTS) break
  }
  return kept
}

/**
 * AD-6 / `dial-clamped` — what the two clamps above TRUNCATED, as a warning the
 * core can carry (epic-1 retrospective ledger triage, entries 4 and 51).
 *
 * Both clamps bound a list arriving from a model call, and both had a real
 * reason to: an unbounded list is an unbounded loop and an unbounded warning
 * message. What neither had was a way to SAY SO. `clampPins`' own header states
 * the problem — "This layer CANNOT raise a `Warning`: anything it silently
 * discards is a request the user made and nobody ever answered" — and it was
 * true only because no code existed to carry it and adding one was an `Ask
 * First` three stories declined. The retrospective put that question to the
 * human and the answer was yes, so the layer can now answer for itself: these
 * go into `priorWarnings`, which the adapter already threads into `review()`.
 *
 * COUNTS ONLY THE OVERFLOW, never the ordinary drops. `clampLenses` also removes
 * blanks and duplicates, and those are NOT truncation: a duplicate lens is a
 * slot that cannot exist, which its own header calls deliberate rather than an
 * inconsistency. Only a list longer than the ceiling loses something the caller
 * asked for. That is why this compares against the ceiling and not against the
 * input length.
 *
 * Reachable only by a direct adapter caller: both tool schemas carry `.max()`,
 * so an over-long array is refused before `execute` runs. Reported anyway, for
 * the reason the schema itself is not enough — the exported function is a seam,
 * and TypeScript does not police a JavaScript caller.
 */
export function truncatedListWarnings(args: {
  models?: readonly string[]
  lenses?: readonly string[]
}): Warning[] {
  const moved: { dial: string; requested: unknown; inForce: unknown }[] = []
  if (Array.isArray(args.models) && args.models.length > MAX_DISCOVERY_SLOTS) {
    moved.push({ dial: "models", requested: args.models.length, inForce: MAX_DISCOVERY_SLOTS })
  }
  if (Array.isArray(args.lenses) && args.lenses.length > MAX_LENS_SLOTS) {
    moved.push({ dial: "lenses", requested: args.lenses.length, inForce: MAX_LENS_SLOTS })
  }
  if (moved.length === 0) return []
  return [
    {
      code: "dial-clamped",
      stage: "roster",
      message:
        `A DIAL WAS NOT HONOURED AS ASKED: ` +
        moved
          .map((m) => `${m.dial} ${JSON.stringify(m.requested)} → ${JSON.stringify(m.inForce)}`)
          .join("; ") +
        `. The entries past that ceiling were never resolved and never reported by the core, ` +
        `because they were dropped before it saw them.`,
      detail: { dials: moved },
    },
  ]
}

export const MadPlugin: Plugin = async ({ client, directory, worktree, serverUrl, $ }) => {
  return {
    tool: {
      // The user-facing entry point. Invocation surface is the host's
      // (host-integration.md); MAD supplies the behaviour behind it.
      mad_review: tool({
        description:
          "Review a code change with MAD: resolve a model roster from the providers this host " +
          "already has configured, review the change, and emit findings ranked with severity, " +
          "locus and a co-discovery fraction. Reports every way the run was degraded.",
        args: {
          target: tool.schema
            .string()
            .optional()
            .describe(
              "Git ref range or commit to review, e.g. `main...HEAD`. Omit to review the working tree against HEAD.",
            ),
          slots: tool.schema
            .number()
            .int()
            .min(1)
            .max(MAX_DISCOVERY_SLOTS)
            .optional()
            .describe(
              `How many discovery models to fan out to, each reviewing the change independently ` +
                `and in parallel. Defaults to ${DEFAULT_DISCOVERY_SLOTS}, maximum ` +
                `${MAX_DISCOVERY_SLOTS}. Each slot is a separate billed model call. Pass 1 for a ` +
                `single-model review.`,
            ),
          lenses: tool.schema
            .array(tool.schema.string())
            .max(MAX_LENS_SLOTS)
            .optional()
            .describe(
              `OPTIONAL discovery lenses — personas that narrow what one extra slot looks for. ` +
                `Omit for no lenses, which is the default: a fresh install runs zero lens turns and ` +
                `costs exactly what it would without this argument. EACH LENS IS ANOTHER BILLED ` +
                `DISCOVERY TURN at the widest point of the run — 3 slots with 5 lenses is 8 model ` +
                `calls, not 3. Maximum ${MAX_LENS_SLOTS}. Shipped ids: ${CODING_LENSES.map((l) => l.id).join(", ")}. ` +
                `An unrecognized id is accepted and its instruction is generated at run time, and ` +
                `the output says so. Lens findings are additive coverage: they carry no ` +
                `co-discovery fraction and never count toward roster diversity.`,
            ),
          budget: tool.schema
            .number()
            .int()
            .min(0)
            .optional()
            .describe(
              `OPTIONAL ceiling on this review, IN TOKENS — never in currency, because what a ` +
                `token costs is this host's business and not MAD's. Omit for no ceiling, which is ` +
                `the default. MAD STARTS A REVIEW IT MAY NOT BE ABLE TO FINISH and tells you ` +
                `where it stopped; it never refuses up front. The number is split across the ` +
                `three billing stages, so a cheap discovery hands its remainder to debate rather ` +
                `than one stage eating the whole budget. Rough fits over a ~400-line change: ` +
                `${SUGGESTED_BUDGET.quick} for quick, ${SUGGESTED_BUDGET.normal} for normal, ` +
                `${SUGGESTED_BUDGET.paranoid} for paranoid.`,
            ),
          preset: tool.schema
            .enum(PRESETS)
            .optional()
            .describe(
              `OPTIONAL depth. \`normal\` (the default, and identical to passing nothing) routes ` +
                `at a 0.8 co-discovery threshold with no lenses. \`quick\` drops the threshold to ` +
                `0.5, so fewer findings are contested and fewer debate turns are billed. ` +
                `\`paranoid\` raises it to 1.0 AND adds three lens slots (security, reliability, ` +
                `outsider) — with the default 3 slots that is SIX billed discovery turns rather ` +
                `than three, and it is the only setting here that costs more. A preset moves ` +
                `numbers, never policy, and an argument you pass explicitly always beats it.`,
            ),
          models: tool.schema
            .array(tool.schema.string())
            .max(MAX_DISCOVERY_SLOTS)
            .optional()
            .describe(
              `OPTIONAL discovery models to PIN, as \`provider/model\` strings, filling slots in ` +
                `the order given before the rest are chosen automatically. Omit to let MAD choose ` +
                `the whole roster, which is the default and what AD-3 expects. Name only models ` +
                `this host already has configured — MAD holds no credentials and adds no ` +
                `provider. A model this host does not offer is REPORTED and its slot falls back ` +
                `to automatic selection; the run is never refused. Pinning does NOT buy a ` +
                `diversity claim: two providers reaching one model still fill one slot, and a ` +
                `roster you pinned onto one model family is reported as narrow exactly as loudly ` +
                `as one MAD chose.`,
            ),
        },
        async execute(args, context) {
          // Belt and braces: the schema bounds it, and so does this, because the
          // value arrives from a model call and each slot costs real money.
          const slots = clampDiscoverySlots(args.slots)
          // CAP-7 (story 8) — RESOLVED BEFORE THE ROSTER, because the lens half
          // of a preset is a roster decision and `resolveRoster` is what turns a
          // lens list into slots.
          //
          // `args.lenses !== undefined` and NOT `args.lenses?.length`: an
          // explicit `lenses: []` under `paranoid` is a caller declining the lens
          // pass, and a truthiness test would silently sell them three billed
          // discovery turns they just refused.
          const preset = clampPreset(args.preset)
          const dials = PRESET_DIALS[preset]
          const lenses = clampLenses(args.lenses !== undefined ? args.lenses : [...dials.lenses])
          // AD-3 amended (story 8A) — bounded here, RESOLVED in the core. This
          // clamp deliberately discards nothing a user asked for.
          const pins = clampPins(args.models)

          let resolved
          try {
            resolved = await resolveRoster(client, slots, lenses, pins)
          } catch (error) {
            if (error instanceof NoCandidatesError) {
              // Matrix row "No providers": fail with guidance, not a stack trace.
              return { title: "MAD — no providers configured", output: error.message }
            }
            // Anything else — a transport failure reading the host's config, say
            // — is still the user's problem to act on, not a stack trace to read.
            return {
              title: "MAD — could not resolve a roster",
              output:
                `MAD could not work out which models to review with.\n\n` +
                `${error instanceof Error ? error.message : String(error)}\n\n` +
                `Check that opencode can reach your configured providers, then try again.`,
            }
          }

          const repo = opencodeRepo({ $, worktree })
          let change
          try {
            change = await repo.change(args.target)
          } catch (error) {
            // A bad ref, or a directory that is not a git repo. Say which.
            return {
              title: "MAD — could not read the change",
              output:
                `MAD could not read the change to review.\n\n` +
                `${error instanceof Error ? error.message : String(error)}\n\n` +
                (args.target
                  ? `Check that \`${args.target}\` is a valid git ref or ref range.`
                  : `Check that this directory is a git repository with at least one commit.`),
            }
          }

          if (change.diff.trim().length === 0) {
            return {
              title: "MAD — nothing to review",
              output: `No change found for ${change.description}. Make a change, or pass a ref range as \`target\`.`,
            }
          }

          // BOTH collections. `OpencodeModelBackend` builds its per-slot map
          // from this array and `runTurn` THROWS on a slot it does not know;
          // `runWithOneRetry` swallows that throw into a transport-error
          // envelope, so passing only `slots` here would turn every lens slot
          // into a silent double drop-out that looks like a flaky provider.
          // Nothing type-checks this — `plugin-wiring.test.ts` is what does.
          const backend = new OpencodeModelBackend({
            serverUrl,
            directory,
            slots: [...resolved.roster.slots, ...resolved.roster.lensSlots],
          })

          // AD-16 amended (story 7A) — the turn recorder is constructed ONLY
          // when the user turned the dump on. With the flag off `review()` gets
          // the bare backend, so a fresh install allocates nothing and holds no
          // prompt or answer in memory. The decorator satisfies the port and
          // does nothing else: no retry, no swallowed failure, and the
          // cancellation signal forwarded untouched — a stage cannot tell it is
          // there, which is AD-16's "no stage learns that a file exists".
          //
          // The same `artifactRootFrom` the dump itself calls, on the same
          // `process.env`, so the two cannot disagree about whether the flag is
          // on.
          //
          // AND THE REFUSAL IS CHECKED HERE TOO (code review 2026-08-31). The
          // gate used to read `artifactRootFrom` alone, so a user who pointed
          // the variable at their own repository paid the memory cost of holding
          // every prompt, instruction set and envelope for the whole run — and
          // then got nothing, because the dump refused. The recorder is built
          // only when there is a dump for it to feed.
          const artifactRoot = artifactRootFrom(process.env)
          const recorder =
            artifactRoot !== undefined && refusalFor(artifactRoot, worktree) === undefined
              ? createTurnRecorder()
              : undefined

          const { record, rendered } = await review({
            roster: resolved.roster,
            backend: recorder ? recorder.wrap(backend) : backend,
            clock: systemClock(),
            change,
            // AD-6 — the adapter's OWN truncations ride in beside the roster's.
            // `review()` copies `priorWarnings` onto the record verbatim, so this
            // is the supported way for this layer to be heard at all.
            priorWarnings: [...truncatedListWarnings(args), ...resolved.warnings],
            // CAP-7 (story 8) — the two user-facing dials, and the only two on
            // this surface. `tokenCap` is passed through UNCLAMPED and `review()`
            // clamps it; the tool schema's `.int().min(0)` is the only check on
            // this side, and a schema check is not a clamp.
            //
            // This comment used to end "and it is clamped anyway for the reason
            // `slots` is", which was false about the line directly beneath it
            // (epic-1 retrospective ledger triage, entry 61). Passing it through
            // is correct — one clamp, in the accountant that owns the dial, per
            // AD-15 — but a comment claiming a guard that is not there is worse
            // than no comment: it is the thing a later reader trusts instead of
            // looking.
            preset: args.preset === undefined ? undefined : preset,
            tokenCap: args.budget,
            // AD-2 amended / AD-6f (story 7A) — THE HOST HAS ALWAYS HANDED US
            // THIS. `ToolContext.abort` is an `AbortSignal`, and until this story
            // `execute` took one parameter and never read it: pressing stop in
            // opencode abandoned the RESULT while the fan-out kept billing. The
            // core stops issuing turns when it fires and reports where it
            // stopped; `OpencodeModelBackend` also races it against the existing
            // per-turn deadline, which narrows the window without being relied
            // on (AD-2: the signal is not load-bearing).
            signal: context.abort,
          })

          // AD-16 amended (story 7A) — OFF UNLESS THE USER TURNED IT ON, and
          // never inside the repository under review. It runs AFTER `review()`
          // returns, on the finished record, so no stage can be affected by it
          // and a failure here cannot cost the user their review. It is not a
          // tool argument on purpose: see `adapters/opencode/artifacts.ts`.
          //
          // WRAPPED HERE AS WELL AS INSIDE (code review 2026-08-31). The story
          // required its own try/catch at this call site and shipped without one,
          // resting the guarantee entirely on the callee's "NEVER THROWS"
          // header. That header is now true, and this is still here: the clause
          // it protects — a dump failure must never cost the user their review —
          // is worth two independent guards, and a later edit to `artifacts.ts`
          // cannot quietly remove both.
          let artifacts: ArtifactOutcome
          try {
            artifacts = await dumpRunArtifacts({
              record,
              change,
              // The HUMAN render, deliberately unframed. The framed form below
              // is for the host agent; a person opening `report.txt` in an
              // editor is not the reader AD-18's notice sentence is addressed to.
              rendered,
              turns: recorder?.turns,
              worktree,
            })
          } catch (error) {
            artifacts = {
              kind: "failed",
              directory: artifactRoot ?? "(unknown)",
              error: error instanceof Error ? error.message : String(error),
            }
          }

          // AD-6 reaches the headline too, not only the body. Two things this
          // line must not do: denominate on the FILLED roster, which turns a
          // 3-requested/1-filled host into a clean-looking "1/1"; and present a
          // pre-clustering union as a plain finding count, which is the exact
          // misreading the body's POOL — NOT YET MERGED notice exists to stop.
          // The empty list is the third thing it must not do (code review
          // 2026-08-15): `[].every(...)` is `true`, so a 2-model run that
          // raised nothing used to title itself "0 pooled finding(s), not yet
          // merged" — a claim about merging that no longer holds now that
          // clustering always runs, and one the BODY never made
          // (`pooledNotYetMerged` bails on an empty pool). Match its predicate.
          const pooled =
            record.answered > 1 &&
            record.findings.length > 0 &&
            record.findings.every((f) => f.clusterId === undefined)
          const findingLabel = pooled ? "pooled finding(s), not yet merged" : "finding(s)"
          // AD-17e reaches the headline too. The denominator stays the pool's:
          // `answered` counts pool models only, and naming the lens count beside
          // it is what stops a reader reading 5 turns into a 5-model roster.
          const lensLabel =
            record.roster.lensSlots.length > 0 ? ` + ${record.roster.lensSlots.length} lens` : ""

          // AD-6f — THE TITLE SAYS IT TOO. The header line inside the report
          // says it and so does a warning, but the title is the line a user sees
          // in the transcript without opening anything, and "a cancelled run
          // must never render as a finished one" is not satisfied by a fact
          // three scrolls down. It leads, because everything after it is a count
          // taken from a review that did not finish.
          const cancelledLabel = record.cancelled
            ? `CANCELLED during ${record.cancelled.stage} — partial review: `
            : ""

          // AD-16 — the record stays in memory, and nothing is EVER written to
          // the repo. The artifact dump above writes outside it, only when the
          // user set the flag, and refuses anything that resolves inside the
          // worktree.
          return {
            title: `MAD review — ${cancelledLabel}${record.findings.length} ${findingLabel}, ${record.answered}/${record.roster.requested} models answered${lensLabel}`,
            // AD-18's EIGHTH SPAN (story 7). A tool's `output` is read by the
            // calling agent, which is a model, and the report quotes every
            // model-authored claim, argument and judge report the run produced.
            // This is the ONE return site that carries MODEL prose; the four
            // above are MAD-authored sentences, though three of them do
            // interpolate text MAD did not write either — `error.message` from
            // git or a provider, and `args.target` from whoever called the tool.
            // That is a live boundary of its own, deliberately left open rather
            // than claimed closed here. (It is filed in the planning ledger,
            // which lives outside this repository — so this comment states the
            // fact itself rather than pointing a reader at a file they cannot
            // open. Code review 2026-08-30, second pass.)
            // The framing belongs at this boundary and not in the render,
            // because the same report also goes to a human, where a notice
            // sentence is noise. `plugin-wiring.test.ts` fails if this reverts.
            // THE ARTIFACT NOTE SITS OUTSIDE THE SPAN, and it is MAD's own
            // sentence (AD-18). It is appended rather than interpolated so the
            // framed report keeps exactly the bytes `frameForHostAgent`
            // produced. `artifactNote` collapses the one value MAD does not
            // author — a filesystem error message — to a single line, so it
            // cannot forge a row of MAD's own; see the function below.
            output: `${frameForHostAgent(rendered)}${artifactNote(artifacts)}`,
            metadata: {
              runId: record.runId,
              answered: record.answered,
              requested: record.roster.requested,
              distinctLineages: record.roster.distinctLineages,
              // AD-17c/e — reported separately from the roster's diversity, and
              // never folded into it.
              lensSlots: record.roster.lensSlots.map((s) => s.slot),
              lensInstructions: record.lensInstructions,
              warnings: record.warnings.map((w) => w.code),
              tokens: record.ledger.total,
              // AD-6f — machine-readable beside the prose, for a host that wants
              // to branch on it rather than read a title.
              cancelled: record.cancelled?.stage,
              // AD-15 amended — the peak this run was held to.
              maxConcurrency: record.ledger.maxConcurrency,
              // CAP-7 (story 8) — the two dials a caller set, and the one fact
              // about the budget that changes what the review is WORTH.
              //
              // `budgetSkipped` is a COUNT and not the slot ids: a host branching
              // on "was this review cut short" needs the number, and the ids are
              // already in the rendered report and the `discovery-truncated`
              // warning's detail for anyone who needs which.
              preset: record.preset,
              tokenCap: record.ledger.cap,
              budgetSkipped: record.skippedForBudget?.length ?? 0,
              // AD-16 — TWO FIELDS, NOT ONE OVERLOADED STRING (code review
              // 2026-08-31). This used to be a single field holding either a
              // directory path or the bare literal `"refused"`/`"failed"`, so a
              // host could not tell "wrote to a directory" from "did not write"
              // without string-matching MAD's own internal kind names — and a
              // user whose scratch directory happened to be named `failed` broke
              // it outright. The kind is the discriminant; the directory is data.
              artifactsOutcome: artifacts.kind,
              artifacts: artifacts.kind === "written" ? artifacts.directory : undefined,
            },
          }
        },
      }),
    },
  }
}

/**
 * One MAD-authored line about the artifact dump, or nothing at all.
 *
 * SILENT WHEN THE FLAG IS OFF, which is the default: a fresh install's tool
 * output is byte-for-byte what it was before this story. The other three
 * outcomes all say something the user can act on, and none of them is a failure
 * of the review.
 *
 * TWO SPANS HERE ARE NOT MAD'S OWN WORDS, not one (code review 2026-08-31): the
 * filesystem's error text, and the DIRECTORY — which comes from `MAD_ARTIFACTS`,
 * which the user sets. The docstring used to claim only the first, and only the
 * first was collapsed. Both now go through `oneLine` — the same collapse `core/stages/output.ts` applies to
 * every model-authored cell — so a message carrying a line break cannot forge a
 * row below the span. It is not fenced as material: it is a `mkdir`/`write`
 * error from the local filesystem, not model prose, and a notice sentence on one
 * diagnostic line costs more than it buys (the same call story 7 recorded for
 * this file's four other `output:` sites).
 */
function artifactNote(outcome: ArtifactOutcome): string {
  switch (outcome.kind) {
    case "off":
      return ""
    case "written":
      return `\n\nMAD wrote this run's artifacts to ${oneLine(outcome.directory)} (${outcome.files} files).`
    case "refused":
      return `\n\nMAD did NOT write run artifacts. ${oneLine(outcome.reason)}`
    case "failed":
      return (
        `\n\nMAD could not write run artifacts to ${oneLine(outcome.directory)}: ` +
        `${oneLine(outcome.error)}. The review above is unaffected.`
      )
  }
}

export default MadPlugin
