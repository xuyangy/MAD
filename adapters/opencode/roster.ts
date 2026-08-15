/**
 * AD-3 — the roster is derived at runtime from the host. MAD holds no model id,
 * no credential and no provider config; a fresh install needs no MAD-specific
 * configuration at all.
 *
 * This module is the only place that knows opencode's provider shape. It
 * flattens `client.config.providers()` into harness-agnostic `Candidate`s and
 * hands them to `core/roster` (AD-1).
 */

import type { PluginInput } from "@opencode-ai/plugin"

import type { Candidate } from "../../core/domain/roster.ts"
import { selectRoster, type SelectResult } from "../../core/roster/select.ts"

/**
 * The opencode config key a user edits to add a provider. Named verbatim in the
 * AD-6c warning so the warning is actionable.
 */
export const OPENCODE_PROVIDER_CONFIG_KEY = "provider"

type Client = PluginInput["client"]

/**
 * Flatten the host's configured providers to candidates.
 *
 * Ordering matters for dedupe (first provider seen for an identity wins the
 * slot), so it is made deterministic: the host's default provider for each
 * model comes first, then providers in the order the host listed them.
 */
export class ProviderEnumerationError extends Error {
  constructor(detail: string) {
    super(`Could not read the host's configured providers: ${detail}`)
    this.name = "ProviderEnumerationError"
  }
}

export async function enumerateCandidates(client: Client): Promise<Candidate[]> {
  const response = await client.config.providers()

  // A transport failure is not "you have no providers configured". Conflating
  // them would tell a user with a working setup to go configure a provider.
  if (response.error) {
    const error = response.error as { name?: string; data?: { message?: string } }
    throw new ProviderEnumerationError(
      `${error.name ?? "error"}${error.data?.message ? `: ${error.data.message}` : ""}`,
    )
  }

  const body = response.data
  if (!body) return []

  const defaults = body.default ?? {}
  const candidates: Candidate[] = []

  for (const provider of body.providers ?? []) {
    for (const model of Object.values(provider.models ?? {})) {
      // An id-less model cannot be identified, normalized, or deduped; letting
      // it through would collapse unrelated models onto one empty identity.
      if (!model?.id) continue
      candidates.push({
        providerId: provider.id,
        modelId: model.id,
        name: model.name,
        // Host-declared, never guessed (AD-2, story 1 design notes).
        toolcall: model.capabilities?.toolcall === true,
        contextLimit: model.limit?.context,
        cost: model.cost ? { input: model.cost.input, output: model.cost.output } : undefined,
      })
    }
  }

  // A provider's own default model first WITHIN that provider — the host's
  // opinion about which of its models is the sensible one. Sorting the whole
  // flat list instead would interleave providers, and since dedupe is
  // first-wins on this order, that silently changes which provider owns a slot.
  const isDefault = (c: Candidate) => defaults[c.providerId] === c.modelId
  const byProvider = new Map<string, Candidate[]>()
  for (const candidate of candidates) {
    const group = byProvider.get(candidate.providerId)
    if (group) group.push(candidate)
    else byProvider.set(candidate.providerId, [candidate])
  }

  const ordered: Candidate[] = []
  for (const group of byProvider.values()) {
    ordered.push(
      ...group.sort((a, b) => (isDefault(a) === isDefault(b) ? 0 : isDefault(a) ? -1 : 1)),
    )
  }
  return ordered
}

export async function resolveRoster(
  client: Client,
  slots: number,
  /** CAP-11 — ordered lens ids. Empty by default, so a fresh install runs no lens turn (AD-3). */
  lenses: readonly string[] = [],
): Promise<SelectResult> {
  const candidates = await enumerateCandidates(client)
  // Throws NoCandidatesError when the host has nothing configured — unusable
  // host state, surfaced to the user with guidance by the plugin entry.
  return selectRoster(candidates, {
    slots,
    lenses,
    providerConfigKey: OPENCODE_PROVIDER_CONFIG_KEY,
  })
}
