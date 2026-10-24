/** Bun entry point installed beside the pinned Codex runtime. */

import { type Bridge, BridgeServer, HostToolRelay } from "@amends-dev/harness"
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import type * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import type * as Path from "effect/Path"
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { Options } from "../models.ts"
import * as Session from "./session.ts"

const relayLayer = HostToolRelay.layer().pipe(
  Layer.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, idleTimeout: 0 }))
)

BunRuntime.runMain(
  Effect.gen(function* () {
    const launch = yield* BridgeServer.readLaunchOptions
    const options = yield* Schema.decodeUnknownEffect(Options)(launch.agentOptions)
    const relay = yield* HostToolRelay.HostToolRelay
    const services = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >()
    const driver: Bridge.Driver = {
      id: "codex",
      createSession: (sessionOptions) =>
        Session.create(
          { ...options, command: options.command ?? `${import.meta.dirname}/codex-runtime/bin/codex` },
          launch.stateDirectory,
          relay,
          sessionOptions
        ).pipe(Effect.provide(services))
    }
    // Bun can wait forever for previously opened WebSockets, so bound server shutdown after the bridge finalizes.
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
  }).pipe(Effect.scoped, Effect.provide(relayLayer.pipe(Layer.provideMerge(BunServices.layer))))
)
