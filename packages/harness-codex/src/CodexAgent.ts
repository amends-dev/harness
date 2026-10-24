/**
 * Codex app-server inside a sandbox, reached through the shared harness bridge.
 *
 * @since 0.1.0
 */

import { type Agent, BridgeClient } from "@amends-dev/harness"
import type { Sandbox } from "@amends-dev/sandbox"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as Redacted from "effect/Redacted"
import type * as Schema from "effect/Schema"
import type * as Socket from "effect/socket/Socket"
import { modelsOf, type Options as DriverOptions } from "./internal/models.ts"
import { makeInstallation } from "./internal/template.ts"

/**
 * Model endpoints and the shared sandbox bridge token. Codex requires Responses endpoints.
 * @category options
 * @since 0.1.0
 */
export interface Options extends Agent.Options {
  readonly token: (id: Sandbox.SandboxId) => Redacted.Redacted<string>
  /** Additional Codex configuration, with dotted keys as the app-server accepts them. */
  readonly config?: Readonly<Record<string, Schema.Json>>
  /** Variables supplied to the sandbox's Codex processes. */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * Bundles the bridge with Bun and creates an agent using the supplied WebSocket and Crypto services.
 * @category constructors
 * @since 0.1.0
 */
export const make = Effect.fn("CodexAgent.make")(function* (options: Options) {
  const models = yield* modelsOf(options)
  const installation = yield* makeInstallation()
  const services = yield* Effect.context<Socket.WebSocketConstructor | Crypto.Crypto>()
  const bridge: BridgeClient.Options = {
    id: "codex",
    ...installation,
    token: options.token,
    agentOptions: {
      model: models.model,
      models: models.models,
      config: { ...options.config, ...models.config },
      env: { ...options.env, ...models.env }
    } satisfies DriverOptions
  }
  const agent: Agent.Agent = {
    id: "codex",
    requiresSandbox: true,
    template: installation.template,
    maxToolNameLength: 53,
    createSession: (sessionOptions) => Effect.provide(BridgeClient.createSession(bridge, sessionOptions), services)
  }
  return agent
})
