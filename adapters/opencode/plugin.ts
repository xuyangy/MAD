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

import { systemClock } from "../../core/ports/clock.ts"
import { review } from "../../core/run/review.ts"
import { NoCandidatesError } from "../../core/roster/select.ts"
import { OpencodeModelBackend } from "./model-backend.ts"
import { opencodeRepo } from "./repo.ts"
import { resolveRoster } from "./roster.ts"

/**
 * Three discovery slots on a fresh install (AD-3: no configuration required to
 * get the real thing). A default of 1 makes CAP-1 unreachable out of the box —
 * heterogeneous discovery that never fans out is a claim, not a capability.
 *
 * Three, specifically, because the contract reasons in threes wherever it counts
 * model turns. AD-15's amendment is the one that counts DISCOVERY turns —
 * "three models with five lenses is eighteen discovery turns rather than three".
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
        },
        async execute(args) {
          // Belt and braces: the schema bounds it, and so does this, because the
          // value arrives from a model call and each slot costs real money.
          const slots = clampDiscoverySlots(args.slots)

          let resolved
          try {
            resolved = await resolveRoster(client, slots)
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

          const backend = new OpencodeModelBackend({
            serverUrl,
            directory,
            slots: resolved.roster.slots,
          })

          const { record, rendered } = await review({
            roster: resolved.roster,
            backend,
            clock: systemClock(),
            change,
            priorWarnings: resolved.warnings,
          })

          // AD-6 reaches the headline too, not only the body. Two things this
          // line must not do: denominate on the FILLED roster, which turns a
          // 3-requested/1-filled host into a clean-looking "1/1"; and present a
          // pre-clustering union as a plain finding count, which is the exact
          // misreading the body's POOL — NOT YET MERGED notice exists to stop.
          const pooled =
            record.answered > 1 && record.findings.every((f) => f.clusterId === undefined)
          const findingLabel = pooled ? "pooled finding(s), not yet merged" : "finding(s)"

          // AD-16 — the record stays in memory; nothing is written to the repo.
          return {
            title: `MAD review — ${record.findings.length} ${findingLabel}, ${record.answered}/${record.roster.requested} models answered`,
            output: rendered,
            metadata: {
              runId: record.runId,
              answered: record.answered,
              requested: record.roster.requested,
              distinctLineages: record.roster.distinctLineages,
              warnings: record.warnings.map((w) => w.code),
              tokens: record.ledger.total,
            },
          }
        },
      }),
    },
  }
}

export default MadPlugin
