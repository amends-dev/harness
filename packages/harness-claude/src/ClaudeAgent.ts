/**
 * Claude Agent SDK in a sandbox, reached through the shared authenticated bridge. The template
 * installs pinned Bun and Claude binaries and bundles the SDK with the bridge.
 *
 * @since 0.1.0
 */

import { type Agent, BridgeClient, HarnessError } from "@amends-dev/harness"
import type { Sandbox } from "@amends-dev/sandbox"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as Redacted from "effect/Redacted"
import type * as Socket from "effect/socket/Socket"
import { modelsOf, type Options as BridgeOptions } from "./internal/models.ts"
import { makeInstallation } from "./internal/template.ts"

/**
 * Options for the Claude agent.
 * @category options
 * @since 0.1.0
 */
export interface Options extends Agent.Options {
  /** Derive a stable bridge token from the sandbox id using a secret shared by hosts. */
  readonly token: (id: Sandbox.SandboxId) => Redacted.Redacted<string>
  /** Additional environment variables for Claude. Explicit model settings take precedence. */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * Builds the agent and its installation template using Bun.build on the host.
 * @category constructors
 * @since 0.1.0
 */
export const make = Effect.fn("ClaudeAgent.make")(function* (options: Options) {
  for (const name of ["HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_PROJECT_DIR_NAME"]) {
    if (Object.hasOwn(options.env ?? {}, name))
      return yield* new HarnessError.HarnessError({
        agent: "claude",
        reason: new HarnessError.UnsupportedError({
          description: `${name} is owned by the sandbox so Claude session lookup and deletion use the same location as queries`
        })
      })
  }
  const models = yield* Effect.fromResult(modelsOf(options)).pipe(
    Effect.mapError((reason) => new HarnessError.HarnessError({ agent: "claude", reason }))
  )
  const installation = yield* makeInstallation()
  const services = yield* Effect.context<Socket.WebSocketConstructor | Crypto.Crypto>()
  const bridge: BridgeClient.Options = {
    id: "claude",
    ...installation,
    token: options.token,
    agentOptions: { ...models, env: { ...options.env } } satisfies BridgeOptions
  }
  const agent: Agent.Agent = {
    id: "claude",
    requiresSandbox: true,
    template: installation.template,
    maxToolNameLength: 53,
    createSession: (sessionOptions) => Effect.provide(BridgeClient.createSession(bridge, sessionOptions), services)
  }
  return agent
})
