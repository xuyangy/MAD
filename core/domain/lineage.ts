/**
 * AD-5 — lineage is claimed from a shipped table, and an unknown model is
 * never counted as diverse.
 *
 * The table below is DATA, not logic: it maps model-id markers to a lineage and
 * is editable without touching selection code (`core/roster/select.ts`).
 *
 * This is not MAD naming a model. Nothing here is ever *selected*, *requested*
 * or *defaulted to* — the roster comes entirely from the host (AD-3). These are
 * recognition markers for models the host already offers. A model the table
 * does not recognize is reported `lineage unverified` and is never counted as a
 * fresh lineage, so a stale table degrades into an honest unknown rather than a
 * false diversity claim.
 */

/** The sentinel lineage for a model the table does not recognize (AD-5). */
export const UNVERIFIED_LINEAGE = "unverified"

export interface LineageEntry {
  /** Stable lineage id — the unit of diversity (shared training data). */
  lineage: string
  /** Human-readable name used in warnings. */
  label: string
  /** Markers matched against the normalized model identity, first match wins. */
  markers: string[]
}

/**
 * Ordered: the first entry whose marker matches wins. Put the entry that owns
 * the training run before entries whose names may appear as a suffix of it
 * (e.g. a distill carries both its own family marker and its base's).
 */
export const LINEAGE_TABLE: readonly LineageEntry[] = [
  { lineage: "claude", label: "Claude (Anthropic)", markers: ["claude"] },
  { lineage: "gpt", label: "GPT (OpenAI)", markers: ["gpt", "chatgpt", "codex", "o1", "o3", "o4"] },
  { lineage: "gemini", label: "Gemini (Google)", markers: ["gemini", "gemma"] },
  { lineage: "deepseek", label: "DeepSeek", markers: ["deepseek"] },
  { lineage: "qwen", label: "Qwen (Alibaba)", markers: ["qwen", "qwq"] },
  { lineage: "llama", label: "Llama (Meta)", markers: ["llama"] },
  { lineage: "mistral", label: "Mistral", markers: ["mistral", "mixtral", "magistral", "devstral", "codestral"] },
  { lineage: "grok", label: "Grok (xAI)", markers: ["grok"] },
  // "command" already matches "command-r"; listing both made the second dead.
  { lineage: "command", label: "Command (Cohere)", markers: ["command"] },
  { lineage: "nova", label: "Nova (Amazon)", markers: ["nova"] },
  { lineage: "phi", label: "Phi (Microsoft)", markers: ["phi"] },
  { lineage: "kimi", label: "Kimi (Moonshot)", markers: ["kimi", "moonshot"] },
  { lineage: "glm", label: "GLM (Zhipu)", markers: ["glm", "chatglm"] },
  { lineage: "minimax", label: "MiniMax", markers: ["minimax"] },
] as const

/**
 * Markers that identify a snapshot, a rollout channel, or a per-call variant of
 * a model rather than a different model. Stripped during normalization so one
 * model never occupies two roster slots (AD-4).
 */
const VARIANT_MARKERS = [
  "latest",
  "preview",
  "experimental",
  "exp",
  "snapshot",
  "thinking",
  "beta",
] as const

/**
 * AD-4 step 1 input — normalize a host model id to "family plus version,
 * snapshot date stripped", so the same model reached through two providers
 * collapses to one identity.
 *
 *   anthropic/claude-sonnet-4-5-20250929  -> claude-sonnet-4-5
 *   us.anthropic.claude-sonnet-4-5-v1:0   -> claude-sonnet-4-5
 *   gpt-5-2025-08-07                      -> gpt-5
 *   gemini-2.5-pro-preview-05-06          -> gemini-2.5-pro
 */
export function normalizeModelIdentity(modelId: string): string {
  let id = modelId.trim().toLowerCase()

  // Provider routing prefix: "anthropic/claude-..." -> "claude-..."
  const lastSlash = id.lastIndexOf("/")
  if (lastSlash >= 0) id = id.slice(lastSlash + 1)

  // Regional / vendor dotted prefixes: "us.anthropic.claude-..." -> "claude-...".
  // Only strips a prefix that is purely letters, so "claude-3.5-sonnet" is safe.
  while (/^[a-z]+\./.test(id)) id = id.replace(/^[a-z]+\./, "")

  // Trailing/embedded snapshot dates, deployment versions and variant markers.
  let previous: string
  do {
    previous = id
    id = id
      // bedrock inference-profile suffix: ":0"
      .replace(/:\d+$/, "")
      // deployment version: "-v1", "-v2:0"
      .replace(/-v\d+$/, "")
      // "@20250929"
      .replace(/@\d{6,8}$/, "")
      // "-20250929" / "-2025-08-07" / "-05-06" (month-day rollout suffix)
      .replace(/-\d{8}$/, "")
      .replace(/-\d{4}-\d{2}-\d{2}$/, "")
      // "-08-2024" (Cohere's MM-YYYY form). Without this, `command-r` and
      // `command-r-08-2024` are two identities and can take two roster slots —
      // exactly the duplicate AD-4's dedupe exists to prevent.
      .replace(/-(0[1-9]|1[0-2])-20\d{2}$/, "")
      // "-05-06" month-day rollout suffix. Anchored to a plausible month so a
      // model whose name legitimately ends in two digit pairs is not mangled.
      .replace(/-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "")
      .replace(new RegExp(`-(${VARIANT_MARKERS.join("|")})$`), "")
      .replace(/-+$/, "")
  } while (id !== previous)

  // Normalization that consumed the whole id tells us nothing and would collapse
  // unrelated models onto one empty identity. Fall back to the original.
  if (id.length === 0) return modelId.trim().toLowerCase()

  return id
}

export interface LineageClaim {
  lineage: string
  label: string
  /** False when the table did not recognize the model (AD-5). */
  verified: boolean
}

function matches(normalizedId: string, marker: string): boolean {
  // Word-ish boundary so "o1" does not match inside an unrelated id, while
  // "gpt4" (no separator) still matches "gpt".
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`).test(normalizedId)
}

/**
 * AD-5 — claim a lineage for a model id. Unrecognized is `unverified`, and
 * callers must never count an unverified claim as a fresh lineage.
 */
export function lineageOf(modelId: string): LineageClaim {
  const normalized = normalizeModelIdentity(modelId)
  for (const entry of LINEAGE_TABLE) {
    for (const marker of entry.markers) {
      if (matches(normalized, marker)) {
        return { lineage: entry.lineage, label: entry.label, verified: true }
      }
    }
  }
  return { lineage: UNVERIFIED_LINEAGE, label: "lineage unverified", verified: false }
}
