/**
 * The `Clock` port — time and ids, injected so stages stay deterministic under
 * test. Interfaces only (AD-1).
 */

export interface Clock {
  /** UTC ISO-8601 (spine, Dates & numbers). */
  now(): string
  /** Opaque and sortable (spine, Ids). Used for run and finding ids. */
  id(prefix: string): string
}

/** Default implementation — sortable ids, UTC timestamps, no host dependency. */
export function systemClock(): Clock {
  let counter = 0
  return {
    now: () => new Date().toISOString(),
    id: (prefix: string) => {
      counter += 1
      const stamp = Date.now().toString(36).padStart(9, "0")
      return `${prefix}-${stamp}-${counter.toString(36).padStart(4, "0")}`
    },
  }
}
