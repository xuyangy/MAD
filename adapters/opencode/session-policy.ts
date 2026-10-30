/**
 * The plugin's review-session policy (spec-mad-v1-readiness CAP-3).
 *
 * A review session may run no host tool. Every plugin-path `session.create`
 * carries `REVIEW_SESSION_PERMISSION`, the host's echo of it is checked before
 * the session is prompted, and `ReviewSessionGuard` blocks any tool call the
 * host routes through `tool.execute.before` for a session MAD created. MAD's
 * own evidence read (`Tools.blame`, run by `./tools.ts`) is not a host tool and
 * is unaffected.
 *
 * WHAT THE HOST DOES WITH THE RULES. Read from the installed host bundle,
 * opencode-ai 1.19.3, without running it; other versions are unverified.
 * - Rules are evaluated last match wins, and a session's rules come after the
 *   agent's and the user config's.
 * - A tool whose last rule by name is a `*` deny is removed from the model's
 *   tool list.
 * - For a `json_schema` prompt, which is every MAD turn, the host assigns its
 *   own `StructuredOutput` tool over the session's tool record. That tool only
 *   records the structured answer, and it is not routed through
 *   `tool.execute.before`. Denying it would fail every turn, so it is the one
 *   allowed name, and the host's own implementation replaces any custom tool
 *   registered under it.
 *
 * WHY NO HOST READ TOOLS. A custom tool can register under a built-in's name,
 * and the rules and the hook both see only the name. Allowing `read`, `grep`,
 * `glob` or `list` would admit whatever is registered under them.
 *
 * WHAT THIS IS NOT. Proof of enforcement. Offline tests show that the request
 * carries the rules and that MAD's own checks behave. The echo is the host's
 * record of the rules, and the hook is a second control.
 */

/** One host permission rule, as `session.create` takes it. */
export interface PermissionRule {
  permission: string
  pattern: string
  action: "allow" | "deny" | "ask"
}

/** The rules every plugin-path review session is created with, in order. */
export const REVIEW_SESSION_PERMISSION: readonly PermissionRule[] = Object.freeze([
  Object.freeze({ permission: "*", pattern: "*", action: "deny" as const }),
  Object.freeze({ permission: "StructuredOutput", pattern: "*", action: "allow" as const }),
])

/**
 * How the host's echo differs from MAD's rules, or `null` when it matches.
 * Fixed phrases only: the host's value is never quoted.
 */
export function permissionEchoProblem(echoed: unknown, expected: readonly PermissionRule[]): string | null {
  if (echoed === undefined || echoed === null) return "the host returned no permission rules for the session"
  if (!Array.isArray(echoed)) return "the host returned permission rules MAD could not read"
  for (const rule of echoed) {
    if (
      typeof rule !== "object" ||
      rule === null ||
      Array.isArray(rule) ||
      typeof (rule as PermissionRule).permission !== "string" ||
      typeof (rule as PermissionRule).pattern !== "string" ||
      !ACTIONS.has((rule as PermissionRule).action)
    ) {
      return "the host returned permission rules MAD could not read"
    }
  }
  // EXACT: the same rules in the same order, and no rule carrying anything
  // else. A field MAD did not send is a rule MAD cannot vouch for.
  const same =
    echoed.length === expected.length &&
    expected.every((rule, i) => {
      const other = echoed[i] as Record<string, unknown>
      return (
        Object.keys(other).length === 3 &&
        other.permission === rule.permission &&
        other.pattern === rule.pattern &&
        other.action === rule.action
      )
    })
  return same ? null : "the host returned permission rules different from the ones MAD sent"
}

const ACTIONS: ReadonlySet<unknown> = new Set(["allow", "deny", "ask"])

/** MAD's rules as one line, for a refusal or a policy-stop note. MAD's own text. */
export function describeReviewPermission(rules: readonly PermissionRule[] = REVIEW_SESSION_PERMISSION): string {
  return rules.map((rule) => `${rule.permission} ${rule.pattern} ${rule.action}`).join("; ")
}

/** Appended to every plugin-path prompt's system text. */
export const READ_ONLY_SESSION_NOTICE =
  "MAD SESSION POLICY. Host tools are unavailable in this session: you cannot read, search or list files, " +
  "run commands or tests, write or edit files, fetch anything or delegate to another agent, and any such " +
  "call is refused. Work only from the material in this prompt, which includes any evidence MAD read " +
  "itself. Report a check you cannot make as unchecked, and say why. Where an instruction above asks you " +
  "to open files, run anything or use tools, this notice takes precedence."

/**
 * The session ids MAD created for reviews, and the hook that blocks their tool
 * calls.
 *
 * An id is tracked as soon as `session.create` returns it, before any prompt,
 * and untracked only when its deletion is confirmed. An id whose deletion
 * failed or was never confirmed stays tracked for the life of this process:
 * the set holds the sessions in flight plus every one MAD could not confirm
 * deleted, and nothing else prunes it.
 */
export class ReviewSessionGuard {
  private readonly tracked = new Set<string>()

  track(sessionID: string): void {
    this.tracked.add(sessionID)
  }

  /** Called only when the host confirmed the deletion. */
  deleted(sessionID: string): void {
    this.tracked.delete(sessionID)
  }

  isTracked(sessionID: string): boolean {
    return this.tracked.has(sessionID)
  }

  /** `tool.execute.before`: refuses every tool on a tracked session; leaves every other session alone. */
  readonly beforeTool = async (input: { tool: string; sessionID: string; callID: string }): Promise<void> => {
    if (!this.tracked.has(input.sessionID)) return
    throw new Error(
      `MAD refused the tool call: this is a MAD review session, and review sessions may not run host tools ` +
        `(${READ_ONLY_TOOL_REFUSAL_REASON}).`,
    )
  }
}

const READ_ONLY_TOOL_REFUSAL_REASON = "MAD reads its own evidence; models review only the material MAD sends"
