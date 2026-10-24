/**
 * opencode's driver, which runs opencode for the bridge in its sandbox. One opencode server, which
 * the driver starts when the first session starts, serves every session there, each an opencode
 * session in the session's directory. The sessions are those of the API the bridge's version of
 * opencode speaks: `v1/session.ts` creates them over opencode 1's session API, and `v2/session.ts`
 * over opencode 2's, and each bridge program makes the driver with its own.
 *
 * opencode's server runs until the bridge stops. A server that fails to start is started again by
 * the next session, and one that exits by itself completes `serverExited`, for the bridge to exit
 * with it.
 */

import type { Bridge, HarnessError } from "@amends-dev/harness"
import type * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as FileSystem from "effect/FileSystem"
import type * as HttpClient from "effect/http/HttpClient"
import type * as Path from "effect/Path"
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Server from "./server.ts"

/** A model, as opencode names one: its provider, its id there, and a variant such as `high`. */
export const ModelRef = Schema.Struct({
  id: Schema.String,
  providerID: Schema.String,
  variant: Schema.optionalKey(Schema.String)
})

export interface ModelRef extends Schema.Schema.Type<typeof ModelRef> {}

/** What the host gives the bridge for opencode, as its agent options. */
export const Options = Schema.Struct({
  /** The model a turn runs on when it names none. */
  model: ModelRef,

  /**
   * The models a turn can name, by name. A turn that names another fails with
   * `UnsupportedError`.
   */
  models: Schema.Record(Schema.String, ModelRef),

  /**
   * The command that runs opencode in the sandbox, when it is not the opencode the template
   * installs beside the bridge program.
   */
  command: Schema.optionalKey(Schema.String),

  /**
   * opencode's configuration, as its `opencode.json` takes it, with the providers of the models.
   */
  config: Schema.Record(Schema.String, Schema.Json),

  /** Environment variables opencode runs with. */
  env: Schema.Record(Schema.String, Schema.String)
})

export interface Options extends Schema.Schema.Type<typeof Options> {}

export interface Driver extends Bridge.Driver {
  /**
   * Completes when opencode's server exits before the bridge stops it, for the bridge to exit with
   * it.
   */
  readonly serverExited: Effect.Effect<void>
}

/**
 * Creates a session on opencode's server, as the API of one version of opencode does: the
 * session's turns run on `options`' models, and `sessionOptions` say where it works and what
 * conversation it starts from. It reads the sandbox's files with the bridge's file system, and
 * makes ids with its `Crypto`.
 */
export type CreateSession = (
  server: Server.Server,
  options: Pick<Options, "model" | "models">,
  sessionOptions: Bridge.CreateSessionOptions
) => Effect.Effect<Bridge.DriverSession, HarnessError.HarnessError, Scope.Scope | FileSystem.FileSystem | Crypto.Crypto>

/**
 * The driver of the agent `id`, which starts opencode's server with `options` when the first
 * session starts, and creates each session on it with `createSession`. The server runs in the
 * scope the driver is made in.
 */
export const make = Effect.fnUntraced(function* (id: string, options: Required<Options>, createSession: CreateSession) {
  const services = yield* Effect.context<
    ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient | Crypto.Crypto | FileSystem.FileSystem | Path.Path
  >()
  const driverScope = yield* Effect.scope
  const serverExited = yield* Deferred.make<void>()
  const running = yield* Ref.make<Server.Server | undefined>(undefined)
  /** Held while the server starts, so that sessions starting together start one. */
  const starting = yield* Semaphore.make(1)

  /** opencode's server, which the first session to need it starts. */
  const startedServer = Semaphore.withPermit(
    starting,
    Effect.gen(function* () {
      const current = yield* Ref.get(running)
      if (current !== undefined) return current
      const serverScope = yield* Scope.fork(driverScope)
      const server = yield* Server.start({
        agent: id,
        command: options.command,
        config: options.config,
        env: options.env
      }).pipe(
        Scope.provide(serverScope),
        Effect.onError((cause) => Scope.close(serverScope, Exit.failCause(cause)))
      )
      yield* Effect.forkIn(Effect.andThen(server.exited, Deferred.succeed(serverExited, undefined)), serverScope)
      yield* Ref.set(running, server)
      return server
    })
  ).pipe(Effect.provide(services))

  const driver: Driver = {
    id,
    serverExited: Deferred.await(serverExited),
    createSession: (sessionOptions) =>
      Effect.flatMap(startedServer, (server) =>
        createSession(server, options, sessionOptions).pipe(Effect.provide(services))
      )
  }
  return driver
})
