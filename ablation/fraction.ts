/**
 * Exact rational arithmetic for the evaluation reports — one copy, used by every
 * reader that prints a mean, a precision or a bound.
 *
 * The reports print NO FLOAT AND NO PERCENTAGE. A number that is not an integer
 * prints as a reduced `a/b`, so a reader can check it against the counts printed
 * beside it. The arithmetic runs on integers only; every input is a count, so
 * numerators and denominators stay far inside the range where JavaScript
 * integers are exact.
 *
 * `fraction` THROWS on a zero denominator, a part that is not a safe integer,
 * or a result that leaves the safe-integer range. That is a programming error
 * at the call site, never a report state: an arm that upheld nothing has
 * UNDEFINED precision, and the caller names that before any division is
 * attempted (`evaluation-protocol.md:161-162`). `average`, `minOf`, `maxOf` and
 * `meanText` throw a named error on an empty list. A report catches every one of
 * these into an unavailable reason.
 */

/** A reduced rational with a positive denominator. */
export interface Fraction {
  num: number
  den: number
}

export function gcd(a: number, b: number): number {
  return b === 0 ? Math.abs(a) : gcd(b, a % b)
}

export function fraction(num: number, den: number): Fraction {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || den === 0) {
    throw new Error(`fraction: ${num}/${den} is not a ratio of safe integers with a non-zero denominator`)
  }
  const sign = den < 0 ? -1 : 1
  const divisor = gcd(num, den) || 1
  // `+ 0` turns a `-0` numerator into `0`, so zero never prints as `-0`.
  return { num: (sign * num) / divisor + 0, den: (sign * den) / divisor }
}

export const ZERO: Fraction = { num: 0, den: 1 }

export function add(a: Fraction, b: Fraction): Fraction {
  const parts = [a.num * b.den, b.num * a.den, a.den * b.den]
  if (!parts.every(Number.isSafeInteger)) throw new Error("add: a cross product leaves the safe-integer range")
  return fraction(parts[0]! + parts[1]!, parts[2]!)
}

export function negate(a: Fraction): Fraction {
  return fraction(-a.num, a.den)
}

export function subtract(a: Fraction, b: Fraction): Fraction {
  return add(a, negate(b))
}

/** The exact mean of a non-empty list. */
export function average(values: readonly Fraction[]): Fraction {
  if (values.length === 0) throw new Error("average: an empty list has no mean")
  const sum = values.reduce(add, ZERO)
  return fraction(sum.num, sum.den * values.length)
}

/** Negative, zero or positive as `a` is below, equal to or above `b`. */
export function compare(a: Fraction, b: Fraction): number {
  const parts = [a.num * b.den, b.num * a.den]
  if (!parts.every(Number.isSafeInteger)) throw new Error("compare: a cross product leaves the safe-integer range")
  return Math.sign(parts[0]! - parts[1]!)
}

export function minOf(values: readonly Fraction[]): Fraction {
  if (values.length === 0) throw new Error("minOf: an empty list has no minimum")
  return values.reduce((low, value) => (compare(value, low) < 0 ? value : low))
}

export function maxOf(values: readonly Fraction[]): Fraction {
  if (values.length === 0) throw new Error("maxOf: an empty list has no maximum")
  return values.reduce((high, value) => (compare(value, high) > 0 ? value : high))
}

/** An integer as itself, anything else as a reduced `a/b`. */
export function fractionText(value: Fraction): string {
  return value.den === 1 ? String(value.num) : `${value.num}/${value.den}`
}

/** An exact mean: an integer, or a reduced ratio of integers. Never a float. */
export function meanText(values: readonly number[]): string {
  if (values.length === 0) throw new Error("meanText: an empty list has no mean")
  const sum = values.reduce((total, value) => total + value, 0)
  return fractionText(fraction(sum, values.length))
}
