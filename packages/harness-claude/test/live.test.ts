import { Harness } from "@amends-dev/harness"
import { SessionId } from "@amends-dev/harness/Agent"
import { LocalSandboxProvider } from "@amends-dev/sandbox-local"
import { BunServices, BunSocket } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Redacted, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as ClaudeAgent from "../src/ClaudeAgent.ts"

const enabled = process.env.AMENDS_TEST_CLAUDE === "1"
const apiKey = process.env.ANTHROPIC_API_KEY

describe.skipIf(!enabled)("Claude with a live model", () => {
  it.live(
    "installs the pinned agent, resumes a session and answers with structured output",
    () =>
      Effect.gen(function* () {
        if (!apiKey) throw new Error("AMENDS_TEST_CLAUDE=1 requires ANTHROPIC_API_KEY")
        const fs = yield* FileSystem.FileSystem
        const home = yield* fs.makeTempDirectoryScoped()
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const isolated = ChildProcessSpawner.make((command) =>
          spawner.spawn(
            ChildProcess.isStandardCommand(command)
              ? ChildProcess.make(command.command, command.args, {
                  ...command.options,
                  env: { ...command.options.env, HOME: home },
                  extendEnv: true
                })
              : command
          )
        )
        const provider = yield* LocalSandboxProvider.make({ directory: `${home}/sandboxes` }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, isolated)
        )
        const agent = yield* ClaudeAgent.make({
          model: {
            provider: "anthropic",
            model: process.env.AMENDS_TEST_CLAUDE_MODEL ?? "claude-sonnet-4-6",
            protocol: "anthropic-messages",
            url: "https://api.anthropic.com/v1",
            apiKey: Redacted.make(apiKey)
          },
          token: () => Redacted.make("live-test-only")
        })
        const sandbox = yield* provider.createScoped(agent.template === undefined ? {} : { template: agent.template })
        const harness = Harness.make(agent)
        const session = yield* harness.createSession({ id: SessionId.make("claude-live"), sandbox })
        const first = yield* session.generate({
          prompt: "Remember the code word persimmon. Reply only OK. Do not use tools."
        })
        expect(first.text).toContain("OK")
        const state = yield* session.stop
        const resumed = yield* harness.createSession({ sandbox, resumeFrom: state })
        const answer = yield* resumed.generateObject({
          prompt: "Return the code word I asked you to remember. Do not use tools except the structured output tool.",
          schema: Schema.Struct({ word: Schema.String })
        })
        expect(answer.value.word.toLowerCase()).toBe("persimmon")
        yield* resumed.destroy
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(BunServices.layer, BunSocket.layerWebSocketConstructor))),
    { timeout: 240000 }
  )
})
