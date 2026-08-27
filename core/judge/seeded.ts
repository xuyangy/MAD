/**
 * Deterministic pseudo-randomness for the judge stage, in one place.
 *
 * Two judge decisions are randomized and both must be REPRODUCIBLE: which letter
 * a debater gets (`anonymize.ts`, AD-17b) and which slot fills a judge role for a
 * given finding (`slots.ts`). Two runs over one input must produce one record —
 * the spine's ordering convention says so, and story 9's ablation compares two
 * run records — so neither may reach for `Math.random`, which is also what would
 * make them untestable.
 *
 * Not cryptographic, and no claim is made that it is. The property required is
 * that the output does not correlate with roster order, and that one seed always
 * gives one answer.
 *
 * Shared rather than duplicated so the two callers cannot drift into two hash
 * functions with one name. They stay INDEPENDENT in effect all the same: each
 * passes a seed of its own shape, so a change to one caller's seed cannot move
 * the other's answer.
 */

/** FNV-1a, 32-bit. Never zero on return, so it is safe as an xorshift state. */
export function fnv1a(seed: string): number {
  let state = 0x811c9dc5
  for (let i = 0; i < seed.length; i += 1) {
    state ^= seed.charCodeAt(i)
    state = Math.imul(state, 0x01000193) >>> 0
  }
  // Zero is a fixed point of xorshift and a degenerate modulus base; nudge it.
  return state === 0 ? 0x9e3779b9 : state
}

/** A xorshift32 stream seeded from `fnv1a`. Values in `[0, 1)`. */
export function seededRandom(seed: string): () => number {
  let state = fnv1a(seed)
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x100000000
  }
}

/** Fisher-Yates over a copy, driven by a seeded stream. */
export function shuffled<T>(items: readonly T[], next: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/**
 * Rotate a list so it starts at a seed-chosen offset, preserving order.
 *
 * ROTATION, not a shuffle: role assignment wants to spread work across the
 * roster without losing the roster's own ordering, so that a reader comparing
 * two findings sees the same sequence starting in a different place rather than
 * an unreadable scramble.
 */
export function rotated<T>(items: readonly T[], seed: string): T[] {
  if (items.length === 0) return []
  const start = fnv1a(seed) % items.length
  return [...items.slice(start), ...items.slice(0, start)]
}
