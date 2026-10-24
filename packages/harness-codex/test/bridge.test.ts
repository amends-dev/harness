import { Agent, BridgeClient, Harness } from "@amends-dev/harness"
import { Template } from "@amends-dev/sandbox"
import { LocalSandboxProvider } from "@amends-dev/sandbox-local"
import { BunServices, BunSocket } from "@effect/platform-bun"
import { assert, it } from "@effect/vitest"
import { type Crypto, Effect, FileSystem, Layer, Path, Redacted } from "effect"
import type { Socket } from "effect/socket"

it.live(
  "launches the real bridge through a sandbox, generates, stops, and resumes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped()
      const command = path.join(root, "fake-codex")
      yield* fs.writeFileString(
        command,
        `#!${process.execPath}\n${yield* fs.readFileString(path.join(import.meta.dirname, "fake-codex.js"))}`
      )
      yield* fs.chmod(command, 0o755)
      const provider = yield* LocalSandboxProvider.make({ directory: path.join(root, "sandboxes") })
      const sandbox = yield* provider.createScoped({})
      const bridge: BridgeClient.Options = {
        id: "codex",
        template: { name: Template.TemplateName.make("codex"), identity: "scripted", prepare: Effect.void },
        command: process.execPath,
        args: [path.join(import.meta.dirname, "../src/internal/bridge/main.ts")],
        token: (id) => Redacted.make(`test-secret-${id}`),
        agentOptions: { command, model: { model: "test", provider: "test" }, models: {}, config: {}, env: {} }
      }
      const context = yield* Effect.context<Socket.WebSocketConstructor | Crypto.Crypto>()
      const agent: Agent.Agent = {
        id: "codex",
        requiresSandbox: true,
        template: bridge.template,
        createSession: (options) => BridgeClient.createSession(bridge, options).pipe(Effect.provide(context))
      }
      const harness = Harness.make(agent)
      const session = yield* harness.createSession({ sandbox, id: Agent.SessionId.make("session") })
      const answer = yield* session.generate({ prompt: "hello" })
      assert.strictEqual(answer.text, "Hello from Codex")
      const reviewed = yield* session.generate({ prompt: "phases" })
      assert.strictEqual(reviewed.text, "The files look good.")
      assert.strictEqual(reviewed.steps.length, 2)
      assert.isTrue(
        reviewed.steps[0]?.parts.some((part) => part.type === "text" && part.text === "I'll inspect the files.")
      )
      assert.isTrue(
        reviewed.steps[0]?.parts.some((part) => part.type === "tool-call" && part.name === "commandExecution")
      )
      assert.strictEqual(reviewed.steps[0]?.finish?.usage.inputTokens.total, 10)
      assert.strictEqual(reviewed.steps[1]?.finish?.usage.inputTokens.total, 10)
      assert.strictEqual(reviewed.usage.inputTokens.total, 20)
      const saved = yield* session.stop
      const resumed = yield* harness.createSession({ sandbox, resumeFrom: saved })
      assert.strictEqual((yield* resumed.generate({ prompt: "again" })).text, "Hello from Codex")
      yield* resumed.destroy
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(BunServices.layer, BunSocket.layerWebSocketConstructor))),
  { timeout: 20000 }
)
