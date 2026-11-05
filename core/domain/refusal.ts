/**
 * The data vocabulary for a refused request, shared by the backend port, which
 * produces it, and the run record, which keeps it for discovery recovery.
 */

/**
 * A failed turn the backend recognised as the provider REFUSING THE REQUEST for
 * an account reason. It describes this request's refusal, not the account's
 * state: MAD never checks a balance or a credential.
 *
 * A backend sets it only on a `model-error`, and only from evidence it can name
 * in `basis`. Everything it cannot classify stays an ordinary failure. The
 * provider and model are the roster slot's, never read from the error.
 *
 * Discovery, pool and lens slots alike, skips its automatic retry after an
 * attempt carrying a refusal. That is a policy on the classification; it does
 * not establish the account's state, and the refused attempt's usage may still
 * be unknown. Debate and judge retry as they do for any failure.
 */
export interface Refusal {
  /** `auth`: the request's credentials were refused. `payment`: payment was required. */
  kind: "auth" | "payment"
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
