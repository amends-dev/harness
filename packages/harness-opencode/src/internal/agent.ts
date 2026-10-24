/**
 * What `OpencodeAgent` and `Opencode2Agent` make: the agent over one version of opencode, whose
 * sessions reach it through the bridge its installation launches in each sandbox.
 */

import { type Agent, BridgeClient, HarnessError } from "@amends-dev/harness"
import type { Sandbox } from "@amends-dev/sandbox"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as Redacted from "effect/Redacted"
import type * as Schema from "effect/Schema"
import type * as Socket from "effect/socket/Socket"
import type { Options as DriverOptions } from "./bridge/driver.ts"
import { modelsOf } from "./models.ts"
import { makeInstallation, type Version } from "./template.ts"

/** What each version's agent is made with, as its module documents. */
export interface Options extends Agent.Options {
  readonly token: (id: Sandbox.SandboxId) => Redacted.Redacted<string>
  readonly config?: { readonly [key: string]: Schema.Json }
  readonly env?: Readonly<Record<string, string>>
}

/** Which opencode an agent runs, the id hosts know it by, and how long its tools' names may be. */
export interface Kind {
  readonly id: string
  readonly version: Version
  readonly maxToolNameLength?: number
}

/** The agent of `kind`, made with `options`. */
export const make = Effect.fnUntraced(function* (kind: Kind, options: Options) {
  const models = yield* Effect.fromResult(modelsOf(kind.version, options)).pipe(
    Effect.mapError((reason) => new HarnessError.HarnessError({ agent: kind.id, reason }))
  )
  const installation = yield* makeInstallation(kind.version)
  const services = yield* Effect.context<Socket.WebSocketConstructor | Crypto.Crypto>()
  const bridge: BridgeClient.Options = {
    id: kind.id,
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
    id: kind.id,
    requiresSandbox: true,
    template: installation.template,
    ...(kind.maxToolNameLength !== undefined && { maxToolNameLength: kind.maxToolNameLength }),
    createSession: (sessionOptions) => Effect.provide(BridgeClient.createSession(bridge, sessionOptions), services)
  }
  return agent
})
