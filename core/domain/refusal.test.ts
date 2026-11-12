import { describe, expect, test } from "bun:test"

import { describeRefusal, type Refusal } from "./refusal.ts"

const base = { providerId: "anthropic", modelId: "claude-opus-5-5" } as const

describe("describeRefusal — the one description every stage's warnings use", () => {
  test("names the kind, the scope and the evidence; only an account refusal from a host text disclaims the balance", () => {
    const cases: [Refusal, string][] = [
      [
        { ...base, kind: "capability", basis: "host-signature", scope: "route" },
        "a capability refusal (the route does not accept MAD's forced tool choice) for the route " +
          "`anthropic/claude-opus-5-5`, recognised from a known host error text",
      ],
      [
        { ...base, kind: "capability", basis: "structured", scope: "route" },
        "a capability refusal (the route does not accept MAD's forced tool choice) for the route " +
          "`anthropic/claude-opus-5-5`, from the host's structured error",
      ],
      [
        { ...base, kind: "capability", basis: "host-signature", scope: "provider" },
        "a capability refusal (the route does not accept MAD's forced tool choice) for provider " +
          "`anthropic`, recognised from a known host error text",
      ],
      [
        { ...base, kind: "payment", basis: "structured", scope: "route" },
        "a payment refusal for the route `anthropic/claude-opus-5-5`, from the host's structured error",
      ],
      [
        { ...base, kind: "payment", basis: "host-signature", scope: "route" },
        "a payment refusal for the route `anthropic/claude-opus-5-5`, recognised from a known host error " +
          "text, not from a checked account balance",
      ],
      [
        { ...base, kind: "payment", basis: "structured", scope: "provider" },
        "a payment refusal for provider `anthropic`, from the host's structured error",
      ],
      [
        { ...base, kind: "auth", basis: "host-signature", scope: "provider" },
        "an authentication refusal for provider `anthropic`, recognised from a known host error text, " +
          "not from a checked account balance",
      ],
    ]
    for (const [refusal, words] of cases) expect(describeRefusal(refusal)).toBe(words)
  })
})
