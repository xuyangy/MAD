/**
 * `HostSessionApi` over the client the host hands a plugin (`PluginInput.client`).
 *
 * WHY THE HOST'S CLIENT AND NOT A CLIENT BUILT FROM `serverUrl`. Under the TUI and
 * `opencode run`, opencode-ai 1.19.5 gives plugins the placeholder `serverUrl`
 * `http://localhost:4096`, with nothing listening on it. The client it gives
 * them instead routes to the server in-process and carries the server's auth
 * headers (`packages/opencode/src/plugin/index.ts` at v1.19.5). Calling through
 * that client, bound to its own `session` object, keeps the host's transport,
 * headers and interceptors exactly as the host set them.
 *
 * THAT CLIENT IS THE v1 SDK, whose request types do not declare two fields MAD
 * sends: `permission` on a session create and `format` on a prompt. The v1 SDK
 * serializes the whole `body` it is given, and the server reads both fields on
 * the same routes the v2 SDK posts to (`POST /session` and
 * `POST /session/{id}/message`). The body types below extend the v1 request
 * types with exactly those two fields. `host-session.test.ts` pins each request
 * on the wire. What comes back is the SDK's result envelope, returned
 * unchanged: the permission echo and `structured` are beyond v1's declared
 * response types, and the backend reads them at run time.
 *
 * This adapter adds no timeout, retry or cancellation. The backend's own races
 * decide when to stop waiting, and a late answer still settles the promise the
 * backend holds.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import type { SessionCreateData, SessionPromptData } from "@opencode-ai/sdk"

import type { HostSessionApi } from "./model-backend.ts"
import type { PermissionRule } from "./session-policy.ts"

type HostClient = PluginInput["client"]

/** v1's create body, plus the permission rules the v1 types leave out. */
type CreateBody = NonNullable<SessionCreateData["body"]> & { permission?: PermissionRule[] }

/** v1's prompt body, plus the structured-output format the v1 types leave out. */
type PromptBody = NonNullable<SessionPromptData["body"]> & {
  format: { type: "json_schema"; schema: Record<string, unknown> }
}

export function hostSessionFromPluginClient(client: HostClient): HostSessionApi {
  // A host client without `session.status` gives a session surface without it,
  // so the backend takes its no-status path rather than calling a missing method.
  const hasStatus = typeof (client.session as { status?: unknown }).status === "function"
  return {
    session: {
      create({ directory, title, permission }) {
        const body: CreateBody = permission === undefined ? { title } : { title, permission }
        return client.session.create({ body, query: { directory } })
      },
      prompt({ sessionID, directory, model, system, format, tools, parts }) {
        const body: PromptBody = tools === undefined ? { model, system, format, parts } : { model, system, format, tools, parts }
        return client.session.prompt({ path: { id: sessionID }, query: { directory }, body })
      },
      delete({ sessionID, directory }) {
        return client.session.delete({ path: { id: sessionID }, query: { directory } })
      },
      ...(hasStatus
        ? {
            status({ directory }: { directory: string }) {
              return client.session.status({ query: { directory } })
            },
          }
        : {}),
    },
  }
}
