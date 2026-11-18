/**
 * The `provider/model` grammar and the list limits, shared by the `mad_review`
 * arguments (`./plugin.ts`) and MAD's user config file (`./user-config.ts`), so
 * the two read one entry the same way.
 */

/** The most discovery slots, and so the most pins, one review takes. */
export const MAX_DISCOVERY_SLOTS = 12

/**
 * The most routes one `exclude` list may name. A list past it is REFUSED,
 * never truncated: a dropped exclusion is a route the caller forbade and MAD
 * would then use.
 */
export const MAX_EXCLUSIONS = 64

/**
 * One `provider/model` string, split at the FIRST `/` because a model id may
 * contain one (`openrouter/anthropic/claude-sonnet-4-5` is a real shape) while a
 * provider id may not. Both halves are trimmed. A string with no `/` gives an
 * empty `providerId` and the whole string as `modelId`; a non-string gives two
 * empty halves. Nothing is rejected here: the call path passes such an entry
 * on for the core to report, and the user config file refuses it.
 */
export function splitModelRef(raw: unknown): { providerId: string; modelId: string } {
  const value = typeof raw === "string" ? raw.trim() : ""
  const cut = value.indexOf("/")
  return cut < 0
    ? { providerId: "", modelId: value }
    : { providerId: value.slice(0, cut).trim(), modelId: value.slice(cut + 1).trim() }
}
