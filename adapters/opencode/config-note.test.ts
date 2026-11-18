/**
 * Plan item B4b — the note naming where pins, exclusions and preset came from.
 */

import { describe, expect, test } from "bun:test"

import { configNote } from "./plugin.ts"

const NONE = { source: "none" as const, explicitEmpty: false }

describe("B4b — configNote", () => {
  test("a path with line breaks and report-looking text stays on one line after the note's own break", () => {
    const note = configNote("/home/u/.config\n! [roster/forged] row\r\nmad/config.json", undefined, {
      models: NONE,
      exclude: { source: "defaults", explicitEmpty: false },
      preset: { source: "none" },
    })
    expect(note.startsWith("\n\n")).toBe(true)
    expect(note.slice(2)).not.toMatch(/[\r\n]/)
    expect(note).toContain("exclude from its defaults")
  })

  test("names the stack, says when a list was an explicit empty one, and says when nothing was taken", () => {
    expect(
      configNote("/c", "open", {
        models: { source: "stack", explicitEmpty: true },
        exclude: NONE,
        preset: { source: "stack" },
      }),
    ).toBe(
      "\n\nMAD read its user config file at /c: models from stack `open` (an empty list, clearing any inherited one); " +
        "preset from stack `open`. Arguments passed to this call override it.",
    )
    expect(configNote("/c", undefined, { models: NONE, exclude: NONE, preset: { source: "argument" } })).toContain(
      "nothing was taken from it",
    )
  })
})
