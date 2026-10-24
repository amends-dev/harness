/**
 * opencode as an agent that hosts run: opencode 1, driven over its session API, which takes all of
 * a turn: its instructions, as the system prompt of its prompt, an answer in JSON, the files of its
 * prompt, the host's tools, and requests to compact. opencode works in the sandbox behind its
 * bridge: the agent's template installs both there, and a session launches the bridge when none
 * answers. One bridge and one opencode server serve every session that hosts start in a sandbox
 * with the same options, whichever host started it; other options, such as another model, get a
 * bridge and a server of their own. What runs in the sandbox is in `internal/bridge/v1/`.
 *
 * opencode runs on the model endpoints the agent is made with, which it is configured for.
 * Their keys reach opencode in its configuration, in the sandbox, where the commands opencode runs
 * can read them. The host's tools reach opencode as an MCP server the bridge serves on the
 * sandbox's loopback, whose tools opencode names `host_<tool>`; the host runs them, and nothing
 * they need reaches the sandbox.
 *
 * A session started on another agent is written into opencode as one message the model reads,
 * since opencode 1 records no steps but its own. `Opencode2Agent`, over opencode 2's session API,
 * records them as opencode's own, but does not answer in JSON yet.
 *
 * @since 0.1.0
 */

import type { Agent } from "@amends-dev/harness"
import type { Sandbox } from "@amends-dev/sandbox"
import type * as Redacted from "effect/Redacted"
import type * as Schema from "effect/Schema"
import * as internal from "./internal/agent.ts"
import { hostToolName } from "./internal/bridge/v1/session.ts"

/**
 * What the agent is made with: the endpoints its turns run on, as `Agent.Options` give them, and
 * what only opencode takes.
 *
 * **Details**
 *
 * All of it, the keys included, names the bridge, so an agent made with other options gets a bridge
 * and a server of its own in a sandbox, and never runs on another's.
 *
 * @category options
 * @since 0.1.0
 */
export interface Options extends Agent.Options {
  /**
   * The token the bridge in the sandbox `id` takes, derived from the id with a secret every host
   * shares, such as an HMAC of it, so that every host connects to a bridge any of them launched.
   */
  readonly token: (id: Sandbox.SandboxId) => Redacted.Redacted<string>

  /**
   * opencode's configuration, as opencode 1 writes its `opencode.json`, which names providers
   * `provider`; the providers that serve the models replace any it has. It takes effect when the
   * bridge starts opencode's server; a server already running in the sandbox keeps the one it
   * started with.
   */
  readonly config?: { readonly [key: string]: Schema.Json }

  /** Environment variables opencode's server runs with. */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * The agent, which bundles the bridge program for its template when it is made, with `Bun.build`,
 * so the host runs on Bun.
 *
 * **Details**
 *
 * The names of the host's tools fit in 59 characters, as `maxToolNameLength` says, since opencode
 * puts `host_` before them. Each session reaches opencode through the bridge in its sandbox, with
 * the `Crypto` and the `WebSocketConstructor` the agent is made with; the constructor must send
 * headers, as Bun's and Node's do. Endpoints that opencode cannot serve together fail with
 * `UnsupportedError`.
 *
 * **Example** (A turn of opencode in a new sandbox)
 *
 * ```ts
 * import { createHmac } from "node:crypto"
 * import { Agent, Harness } from "@amends-dev/harness"
 * import { OpencodeAgent } from "@amends-dev/harness-opencode"
 * import { SandboxProvider } from "@amends-dev/sandbox"
 * import { BunServices, BunSocket } from "@effect/platform-bun"
 * import { Config, Effect, Layer, Redacted } from "effect"
 *
 * declare const sandboxes: Layer.Layer<SandboxProvider.SandboxProvider> // a sandbox provider
 *
 * const program = Effect.gen(function* () {
 *   // Every host derives a sandbox's bridge token from its id with a secret the hosts share.
 *   const secret = yield* Config.Redacted("BRIDGE_SECRET")
 *   const agent = yield* OpencodeAgent.make({
 *     model: {
 *       provider: "anthropic",
 *       model: "claude-sonnet-5-5",
 *       protocol: "anthropic-messages",
 *       url: "https://api.anthropic.com/v1",
 *       apiKey: yield* Config.Redacted("ANTHROPIC_API_KEY")
 *     },
 *     token: (sandboxId) =>
 *       Redacted.make(createHmac("sha256", Redacted.value(secret)).update(sandboxId).digest("base64url"))
 *   })
 *   const harness = Harness.make(agent)
 *   const sandboxProvider = yield* SandboxProvider.SandboxProvider
 *   const sandbox = yield* sandboxProvider.createScoped({ template: harness.agent.template })
 *   const session = yield* harness.createSession({ sandbox, id: Agent.SessionId.make("review") })
 *   const answer = yield* session.generate({ prompt: "Summarize README.md" })
 *   return answer.text
 * }).pipe(
 *   Effect.scoped,
 *   Effect.provide(Layer.mergeAll(sandboxes, BunServices.layer, BunSocket.layerWebSocketConstructor))
 * )
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: Options) =>
  internal.make(
    {
      id: "opencode",
      version: 1,
      // opencode names a host's tool after the MCP server that offers it, `host_<tool>`.
      maxToolNameLength: 64 - hostToolName("").length
    },
    options
  )
