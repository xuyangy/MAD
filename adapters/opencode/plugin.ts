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
 * Story 1 is the single-model control arm (and story 9 reuses it as exactly
 * that), so one discovery slot is the default. It is a slot COUNT, not a model
 * — MAD still names no model (AD-3).
 */
const DEFAULT_DISCOVERY_SLOTS = 1

/**
 * An upper bound on the fan-out. Each slot is a billed session against the
 * user's own credentials, and the argument comes from a model calling the tool,
 * so an unbounded value is an unbounded charge. Well above any roster a real
 * host resolves; there to stop `slots: 200`, not to tune anything.
 */
const MAX_DISCOVERY_SLOTS = 12

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
              `How many discovery models to fan out to. Defaults to ${DEFAULT_DISCOVERY_SLOTS}, ` +
                `maximum ${MAX_DISCOVERY_SLOTS}. Each slot is a separate billed model call.`,
            ),
        },
        async execute(args) {
          // Belt and braces: the schema bounds it, and so does this, because the
          // value arrives from a model call and each slot costs real money.
          const slots = Math.min(args.slots ?? DEFAULT_DISCOVERY_SLOTS, MAX_DISCOVERY_SLOTS)

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

          // AD-16 — the record stays in memory; nothing is written to the repo.
          return {
            title: `MAD review — ${record.findings.length} finding(s), ${record.answered}/${record.roster.slots.length} models answered`,
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
