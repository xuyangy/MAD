import { describe, expect, test } from "bun:test"

import {
  clampDiscoverySlots,
  DEFAULT_DISCOVERY_SLOTS,
  MAX_DISCOVERY_SLOTS,
} from "./plugin.ts"

describe("discovery slot count (AD-3, CAP-1)", () => {
  test("THE DEFAULT FANS OUT TO MORE THAN ONE MODEL", () => {
    // The regression this guards: a default of 1 means a fresh install never
    // runs heterogeneous discovery, and CAP-1 — "pooled recall exceeds any
    // single participating model's" — is unreachable without the user first
    // finding an argument they were never told about (AD-3: configuration is
    // never required for a working run).
    expect(DEFAULT_DISCOVERY_SLOTS).toBeGreaterThan(1)
  })

  test("the default is a whole number within the bound", () => {
    expect(Number.isInteger(DEFAULT_DISCOVERY_SLOTS)).toBe(true)
    expect(DEFAULT_DISCOVERY_SLOTS).toBeLessThanOrEqual(MAX_DISCOVERY_SLOTS)
    expect(MAX_DISCOVERY_SLOTS).toBeGreaterThan(DEFAULT_DISCOVERY_SLOTS)
  })

  test("an absent argument gets the default", () => {
    expect(clampDiscoverySlots(undefined)).toBe(DEFAULT_DISCOVERY_SLOTS)
  })

  test("the value is clamped at BOTH ends", () => {
    // Over the top is an unbounded charge against the user's own credentials;
    // under 1 is a `selectRoster` throw where the user deserves a review.
    expect(clampDiscoverySlots(500)).toBe(MAX_DISCOVERY_SLOTS)
    expect(clampDiscoverySlots(0)).toBe(1)
    expect(clampDiscoverySlots(-4)).toBe(1)
  })

  test("only absent and not-a-number fall back to the default", () => {
    // The infinities are out-of-range requests, not absent ones: `Infinity` asks
    // for more and lands on the maximum. Returning the default there would
    // contradict the doc comment and silently under-serve an explicit request.
    expect(clampDiscoverySlots(Number.POSITIVE_INFINITY)).toBe(MAX_DISCOVERY_SLOTS)
    expect(clampDiscoverySlots(Number.NEGATIVE_INFINITY)).toBe(1)
    expect(clampDiscoverySlots(Number.NaN)).toBe(DEFAULT_DISCOVERY_SLOTS)
    expect(clampDiscoverySlots(undefined)).toBe(DEFAULT_DISCOVERY_SLOTS)
  })

  test("a fractional value truncates rather than rounding up into a billed call", () => {
    expect(clampDiscoverySlots(3.9)).toBe(3)
    expect(clampDiscoverySlots(1.9)).toBe(1)
  })

  test("story 9's control arm is still `slots: 1` — one code path, not two", () => {
    // Story 9 compares the full pipeline against a single model. It asks for one
    // slot through the same tool and the same `review()` seam; nothing about
    // raising the default forecloses that.
    expect(clampDiscoverySlots(1)).toBe(1)
  })

  test("a value inside the range passes through untouched", () => {
    expect(clampDiscoverySlots(2)).toBe(2)
    expect(clampDiscoverySlots(MAX_DISCOVERY_SLOTS)).toBe(MAX_DISCOVERY_SLOTS)
  })
})
