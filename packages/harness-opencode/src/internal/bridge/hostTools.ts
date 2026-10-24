/**
 * The host's tools as both versions of opencode reach them: through the bridge's `HostToolRelay`,
 * an MCP server that opencode connects to for each session's directory as `host`, presenting the
 * session's token. opencode lists an MCP server's tools when it connects, so the session connects
 * it again whenever a turn's tools change, and disconnects it for a turn without any.
 */

import type { Bridge, HarnessError, HostToolRelay } from "@amends-dev/harness"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"

/** The name the relay's MCP server has in opencode. */
export const serverName = "host"

/** An MCP server the agent connects to over HTTP, presenting `headers`. */
export interface RemoteMcpServer {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

/** How a session's directory adds, connects, and disconnects the relay's MCP server. */
export interface McpServers {
  readonly add: (server: RemoteMcpServer) => Effect.Effect<void, HarnessError.HarnessError>
  readonly reconnect: Effect.Effect<void, HarnessError.HarnessError>
  readonly disconnect: Effect.Effect<void, HarnessError.HarnessError>
}

/**
 * The function that has opencode list a turn's `tools` from the relay at `relayUrl` for the
 * session `relaySession` opened, through `mcpServers`, doing nothing while they are the ones it
 * lists already.
 */
export const makeLister = Effect.fnUntraced(function* (
  relayUrl: string,
  relaySession: HostToolRelay.RelaySession,
  mcpServers: McpServers
) {
  /** The tools opencode lists, as JSON, or nothing while it lists none. */
  const listed = yield* Ref.make<string | undefined>(undefined)
  const added = yield* Ref.make(false)
  return Effect.fnUntraced(function* (tools: ReadonlyArray<Bridge.ToolDefinition>) {
    const wanted = tools.length === 0 ? undefined : JSON.stringify(tools)
    if (wanted === (yield* Ref.get(listed))) return
    if (wanted === undefined) {
      yield* mcpServers.disconnect
    } else if (yield* Ref.get(added)) {
      yield* mcpServers.reconnect
    } else {
      yield* mcpServers.add({
        url: relayUrl,
        headers: { authorization: `Bearer ${Redacted.value(relaySession.token)}` }
      })
      yield* Ref.set(added, true)
    }
    yield* Ref.set(listed, wanted)
  })
})
