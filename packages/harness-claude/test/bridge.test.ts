import { type Agent, BridgeClient, Harness } from "@amends-dev/harness"
import { SessionId } from "@amends-dev/harness/Agent"
import { Template } from "@amends-dev/sandbox"
import { LocalSandboxProvider } from "@amends-dev/sandbox-local"
import { BunServices, BunSocket } from "@effect/platform-bun"
import { expect, it } from "@effect/vitest"
import { type Crypto, Effect, FileSystem, Layer, Path, Redacted } from "effect"
import type { Socket } from "effect/socket"

it.live(
  "runs a bundled bridge and the real SDK against a fake native subprocess",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped()
      const bridge = path.join(directory, "bridge.js")
      const built = yield* Effect.promise(() =>
        Bun.build({
          entrypoints: [`${import.meta.dirname}/../src/internal/bridge/main.ts`],
          target: "bun",
          minify: true
        })
      )
      expect(built.success).toBe(true)
      const bundle = built.outputs[0]
      if (bundle === undefined) throw new Error("No bundle")
      yield* fs.writeFileString(bridge, yield* Effect.promise(() => bundle.text()))
      const source = yield* fs.readFileString(`${import.meta.dirname}/fake-claude.mjs`)
      yield* fs.writeFileString(path.join(directory, "claude"), `#!${process.execPath}\n${source}`)
      yield* fs.chmod(path.join(directory, "claude"), 0o755)
      const provider = yield* LocalSandboxProvider.make({ directory: path.join(directory, "sandboxes") })
      const sandbox = yield* provider.createScoped()
      const services = yield* Effect.context<Socket.WebSocketConstructor | Crypto.Crypto>()
      const bridgeOptions: BridgeClient.Options = {
        template: { name: Template.TemplateName.make("claude-test"), identity: "fake", prepare: Effect.void },
        id: "claude",
        command: process.execPath,
        args: [bridge],
        token: () => Redacted.make("bridge-test"),
        agentOptions: { model: { model: "claude-test", env: { ANTHROPIC_API_KEY: "test" } }, models: {}, env: {} }
      }
      const agent: Agent.Agent = {
        id: "claude",
        requiresSandbox: true,
        createSession: (options) => BridgeClient.createSession(bridgeOptions, options).pipe(Effect.provide(services))
      }
      const session = yield* Harness.make(agent).createSession({ id: SessionId.make("sdk-test"), sandbox })
      const response = yield* session.generate({ prompt: "hello" })
      expect(response.text).toBe("hello from the SDK subprocess")
      yield* session.destroy
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(BunServices.layer, BunSocket.layerWebSocketConstructor))),
  { timeout: 30000 }
)
