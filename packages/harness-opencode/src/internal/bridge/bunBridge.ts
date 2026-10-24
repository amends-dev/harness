/**
 * Runs a bridge program from Bun: `runProgram` makes opencode's driver from the launch options a
 * host gave, and `serve` serves it on every interface of the sandbox, at a port the sandbox picks,
 * until the bridge exits idle or another takes its place.
 *
 * Bun's server never finishes stopping once a WebSocket has been open, so it runs in a scope of its
 * own, which the bridge gives a second to close after the bridge's own finalizers have run, rather
 * than wait for hosts to close their connections.
 */

import { type Bridge, BridgeServer, HostToolRelay } from "@amends-dev/harness"
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Driver from "./driver.ts"

/**
 * Runs the bridge program of the agent `agent`, which a host launches in its sandbox. It reads the
 * launch options the host gave it on standard input, makes opencode's driver from the agent options
 * among them, with the sessions `makeCreateSession` creates, and serves the driver to hosts until
 * it exits idle or another bridge takes its place. opencode's server exiting by itself ends it too,
 * for the next host to launch both again.
 *
 * Beside the bridge it serves the `HostToolRelay`, through which opencode calls the host's tools,
 * on 127.0.0.1 only, where opencode's server reaches it. The driver runs the opencode in
 * `directory`, where the template installs it beside the program, unless the agent options name
 * another command.
 */
export const runProgram = (
  agent: string,
  directory: string,
  makeCreateSession: (relay: HostToolRelay.HostToolRelay["Service"]) => Driver.CreateSession
) =>
  BunRuntime.runMain(
    Effect.gen(function* () {
      const launch = yield* BridgeServer.readLaunchOptions
      const options = yield* Schema.decodeUnknownEffect(Driver.Options)(launch.agentOptions)
      const relay = yield* HostToolRelay.HostToolRelay
      const driver = yield* Driver.make(
        agent,
        { command: `${directory}/opencode`, ...options },
        makeCreateSession(relay)
      )
      return yield* serve(driver, launch).pipe(
        Effect.raceFirst(Effect.andThen(driver.serverExited, Effect.fail("opencode's server exited by itself")))
      )
    }).pipe(
      Effect.scoped,
      Effect.provide(layerRelay.pipe(Layer.provideMerge(Layer.merge(BunServices.layer, FetchHttpClient.layer))))
    )
  )

/**
 * The relay, on a server of its own. A call of a host's tool waits for the host for as long as an
 * approval takes, so the server never closes a connection for being idle.
 */
const layerRelay = HostToolRelay.layer().pipe(
  Layer.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, idleTimeout: 0 }))
)

/**
 * Serves `driver` to hosts as `launch` says, until the bridge exits idle, after `idleTimeout`, or
 * another takes its place.
 */
export const serve = Effect.fnUntraced(function* (
  driver: Bridge.Driver,
  launch: Bridge.LaunchOptions,
  options: Pick<BridgeServer.Options, "idleTimeout"> = {}
) {
  const serverScope = yield* Scope.make()
  yield* Effect.addFinalizer(() =>
    Effect.forkDetach(Scope.close(serverScope, Exit.void)).pipe(
      Effect.flatMap(Fiber.await),
      Effect.timeout("1 second"),
      Effect.ignore
    )
  )
  const server = yield* Layer.buildWithScope(
    BunHttpServer.layer({ hostname: "0.0.0.0", port: 0, disablePreemptiveShutdown: true }),
    serverScope
  )
  return yield* BridgeServer.serve(driver, {
    token: Redacted.make(launch.token),
    bridge: launch.bridge,
    stateDirectory: launch.stateDirectory,
    ...options
  }).pipe(Effect.provideContext(server))
})
