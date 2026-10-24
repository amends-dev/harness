/** The sandbox program: a private MCP relay and an authenticated public harness bridge. */

import { BridgeServer, HostToolRelay } from "@amends-dev/harness"
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { Options } from "../models.ts"
import { make } from "./driver.ts"
import { sdk } from "./sdk.ts"

const relay = HostToolRelay.layer().pipe(
  Layer.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, idleTimeout: 0 }))
)

BunRuntime.runMain(
  Effect.gen(function* () {
    const launch = yield* BridgeServer.readLaunchOptions
    const options = yield* Schema.decodeUnknownEffect(Options)(launch.agentOptions)
    const hostToolRelay = yield* HostToolRelay.HostToolRelay
    const environment = yield* Config.all({
      HOME: Config.String("HOME"),
      PATH: Config.String("PATH"),
      TMPDIR: Config.String("TMPDIR").pipe(Config.withDefault("/tmp"))
    })
    const driver = yield* make(sdk, options, hostToolRelay, `${import.meta.dirname}/claude`, environment)
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
      stateDirectory: launch.stateDirectory
    }).pipe(Effect.provideContext(server))
  }).pipe(Effect.scoped, Effect.provide(relay.pipe(Layer.provideMerge(BunServices.layer))))
)
