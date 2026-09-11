import { describe, expect, test } from "bun:test"

import { main } from "./cross-arm-rates.ts"

async function captured(): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = []
  const log = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "))
  }
  try {
    return { code: await main(), lines }
  } finally {
    console.log = log
  }
}

describe("`bun run cross-arm-rates` prints the cases and the two counts", () => {
  test("it exits 0 and prints the seal and the matcher", async () => {
    const { code, lines } = await captured()
    expect(code).toBe(0)
    const output = lines.join("\n")
    expect(output).toContain("set:          cross-arm-pairs-1")
    expect(output).toContain("matcher:      lexical-single-linkage-1 (line tolerance 8, overlap threshold 34/100")
  })

  test("a known-wrong case prints NO and WRONG", async () => {
    const { lines } = await captured()
    expect(lines.find((line) => line.startsWith("missing-await-cross-file "))).toMatch(/separate\s+NO$/)
    expect(lines).toContain("missing-await-cross-file [equivalent, separate, WRONG]:")
  })

  test("a known-right case prints yes and agrees", async () => {
    const { lines } = await captured()
    expect(lines.find((line) => line.startsWith("sql-injection-reworded "))).toMatch(/grouped\s+yes$/)
    expect(lines).toContain("sql-injection-reworded [equivalent, grouped, agrees]:")
  })

  test("the count lines read `over-merge 3 of 9` and `under-merge 3 of 7`", async () => {
    const { lines } = await captured()
    expect(lines.some((line) => line.startsWith("over-merge 3 of 9 "))).toBe(true)
    expect(lines.some((line) => line.startsWith("under-merge 3 of 7 "))).toBe(true)
  })
})
