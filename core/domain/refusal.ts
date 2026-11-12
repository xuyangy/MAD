/**
 * The data vocabulary for a refused request. The type is shared by the backend
 * port, which produces it, and the run record, which keeps it for discovery
 * recovery. The module also holds the one description of a refusal that every
 * stage's warnings use.
 */

/**
 * A failed turn the backend recognised as the provider REFUSING THE REQUEST,
 * for an account reason (`auth`, `payment`) or because the route does not
 * accept a request feature MAD needs (`capability`). It describes this
 * request's refusal, not the account's state or the model's general
 * abilities: MAD never checks a balance or a credential.
 *
 * A backend sets it only on a `model-error`, and only from evidence it can name
 * in `basis`. Everything it cannot classify stays an ordinary failure. The
 * provider and model are the roster slot's, never read from the error.
 *
 * Every stage skips its automatic retry after an attempt carrying a refusal:
 * discovery's pool and lens slots, debate's seats and judge's roles. That is a
 * policy on the classification; it does not establish the account's state, and
 * the refused attempt's usage may still be unknown. Only discovery replaces a
 * refused slot.
 */
export interface Refusal {
  /**
   * `auth`: the request's credentials were refused. `payment`: payment was
   * required. `capability`: the route rejected a request feature MAD needs; not
   * an account reason. The only capability signature recognised today is the
   * rejection of the forced tool choice MAD's structured answers use.
   */
  kind: "auth" | "payment" | "capability"
  /**
   * `structured`: from the host's typed error fields. `host-signature`: from a
   * known, fixed error text one host adapter emits; a heuristic, labelled so.
   */
  basis: "structured" | "host-signature"
  /** `provider`: the evidence names the provider account. `route`: only this provider/model route. */
  scope: "provider" | "route"
  providerId: string
  modelId: string
}

/**
 * One refusal, in words: what was refused, at what scope, and on what evidence.
 * A capability refusal is named by the feature it rejected; the forced tool
 * choice is the only capability signature recognised today, so the wording
 * names it.
 */
export function describeRefusal(refusal: Refusal): string {
  const what = refusalKindWords(refusal.kind)
  const where =
    refusal.scope === "provider"
      ? `for provider \`${refusal.providerId}\``
      : `for the route \`${refusal.providerId}/${refusal.modelId}\``
  const evidence =
    refusal.basis === "structured"
      ? "from the host's structured error"
      : refusal.kind === "capability"
        ? "recognised from a known host error text"
        : "recognised from a known host error text, not from a checked account balance"
  return `${what} ${where}, ${evidence}`
}

/** A refusal's kind, in words; a new kind fails to compile until it is worded here. */
function refusalKindWords(kind: Refusal["kind"]): string {
  switch (kind) {
    case "auth":
      return "an authentication refusal"
    case "payment":
      return "a payment refusal"
    case "capability":
      return "a capability refusal (the route does not accept MAD's forced tool choice)"
    default: {
      const unworded: never = kind
      return unworded
    }
  }
}

/** A refusal and the slot whose turn received it. */
export interface SlotRefusal {
  slot: string
  refusal: Refusal
}

/**
 * Whether a refusal covers a route: a provider-scope refusal covers every model
 * on its provider, a route-scope refusal only its own provider/model route.
 * Provider ids are compared without regard to case and model ids exactly, as
 * `refusalExclusions` compares them; nothing else (lineage, identity) counts.
 */
export function refusalCovers(refusal: Refusal, route: { providerId: string; modelId: string }): boolean {
  if (refusal.providerId.toLowerCase() !== route.providerId.toLowerCase()) return false
  return refusal.scope === "provider" || refusal.modelId === route.modelId
}

/**
 * The first refusal, received by another slot, that covers `slot`'s route; a
 * slot's own refusal is never the one that excludes it.
 */
export function coveringRefusal(
  refusals: readonly SlotRefusal[],
  slot: { slot: string; providerId: string; modelId: string },
): SlotRefusal | undefined {
  return refusals.find((entry) => entry.slot !== slot.slot && refusalCovers(entry.refusal, slot))
}

/**
 * The sentence every stage's exclusion warning uses: the covering refusal, the
 * slot that received it, and that the covered slot is not asked again.
 */
export function coveredByRefusalWords(by: SlotRefusal): string {
  return (
    `is not asked again in this run: slot ${by.slot} ` +
    `(\`${by.refusal.providerId}/${by.refusal.modelId}\`) received a refusal that covers it ` +
    `(${describeRefusal(by.refusal)})`
  )
}

/** The `detail.excludedBy` every stage's exclusion warning carries. */
export function excludedByDetail(by: SlotRefusal): {
  slot: string
  refusal: Pick<Refusal, "kind" | "basis" | "scope">
} {
  return { slot: by.slot, refusal: { kind: by.refusal.kind, basis: by.refusal.basis, scope: by.refusal.scope } }
}
