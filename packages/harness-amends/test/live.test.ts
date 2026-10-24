import { Agent, Harness, type ModelEndpoint } from "@amends-dev/harness"
import { LocalSandboxProvider } from "@amends-dev/sandbox-local"
import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, Predicate, Redacted, Schema } from "effect"
import { AiError, LanguageModel, Tool, Toolkit } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import * as AmendsAgent from "../src/AmendsAgent.ts"
import * as Models from "../src/Models.ts"

/**
 * These tests reach real model APIs over the network and run only with `AMENDS_TEST_MODELS=1`. The
 * turns run on one of OpenRouter's free models, which costs nothing, with the key in
 * `OPENROUTER_API_KEY`, as `bun --env-file=.env` gives it; `AMENDS_TEST_MODELS_MODEL`
 * names another of OpenRouter's models. Anthropic and OpenAI are reached with a key they refuse,
 * which shows that a request found their API, without spending anything. One turn works in a
 * sandbox on this machine, with the agent's own tools.
 */
const enabled = process.env.AMENDS_TEST_MODELS === "1"
const openRouterKey = process.env.OPENROUTER_API_KEY ?? ""
const openRouterModel = process.env.AMENDS_TEST_MODELS_MODEL ?? "nvidia/nemotron-3-super-120b-a12b:free"

const id = Agent.SessionId.make("live")
const timeout = 120_000
const LiveLayer = Layer.merge(BunServices.layer, Models.layer.pipe(Layer.provideMerge(FetchHttpClient.layer)))

/** The endpoint of OpenRouter's model `modelId`, through its Chat Completions API. */
const openRouterEndpoint = (modelId: string): ModelEndpoint.ModelEndpoint => ({
  provider: "openrouter",
  model: modelId,
  protocol: "openai-chat",
  url: "https://openrouter.ai/api/v1",
  apiKey: Redacted.make(openRouterKey),
  maxOutputTokens: 4096
})

/** An endpoint of `provider`'s API, reached through `protocol` at `url`, with a key it refuses. */
const refusedEndpoint = (
  provider: string,
  model: string,
  protocol: ModelEndpoint.Protocol,
  url: string
): ModelEndpoint.ModelEndpoint => ({
  provider,
  model,
  protocol,
  url,
  apiKey: Redacted.make("not-a-key")
})

/** A session of the agent on OpenRouter's model, in `sandbox` when given. */
const makeSession = (sandbox?: Parameters<Harness.Harness["Service"]["createSession"]>[0]["sandbox"]) =>
  Effect.flatMap(AmendsAgent.make({ model: openRouterEndpoint(openRouterModel) }), (agent) =>
    Harness.make(agent).createSession({ id, ...(sandbox === undefined ? {} : { sandbox }) })
  )

const LookUpCodeword = Tool.make("look_up_codeword", {
  description: "Looks up the codeword the user asks about.",
  parameters: Schema.Struct({ topic: Schema.String }),
  success: Schema.String
})
const Codewords = Toolkit.make(LookUpCodeword)

/** Whether a request with `endpoint`'s key failed for the key, which only the API itself says. */
const refusesKey = (endpoint: ModelEndpoint.ModelEndpoint) =>
  Effect.gen(function* () {
    const languageModels = yield* Models.LanguageModels
    const model = yield* languageModels.make(endpoint)
    const error = yield* Effect.flip(
      LanguageModel.generateText({ prompt: "Say hi" }).pipe(Effect.provideService(LanguageModel.LanguageModel, model))
    )
    return AiError.isAiError(error) && Predicate.isTagged(error.reason, "AuthenticationError")
  })

describe.skipIf(!enabled)("amends's agent on a real model API", () => {
  it.live(
    "answers a turn on OpenRouter, calling a host tool on the way",
    () =>
      Effect.gen(function* () {
        const session = yield* makeSession()
        const toolkit = yield* Effect.provide(
          Codewords,
          Codewords.toLayer({ look_up_codeword: () => Effect.succeed("TIDEPOOL-42") })
        )

        const result = yield* session.generate({
          prompt: "Use the look_up_codeword tool for the topic `harbor`, then tell me the codeword.",
          toolkit
        })

        expect(result.toolCalls.map((call) => call.name)).toContain("look_up_codeword")
        expect(result.text).toContain("TIDEPOOL-42")
        expect(result.finishReason).toBe("stop")
        expect(result.usage.outputTokens.total).toBeGreaterThan(0)
      }).pipe(Effect.provide(LiveLayer)),
    timeout
  )

  it.live(
    "answers a turn asking for JSON on OpenRouter",
    () =>
      Effect.gen(function* () {
        const session = yield* makeSession()

        const result = yield* session.generateObject({
          prompt: "How many sides does a hexagon have? Answer with the number as `sides`.",
          schema: Schema.Struct({ sides: Schema.Finite })
        })

        expect(result.value).toEqual({ sides: 6 })
      }).pipe(Effect.provide(LiveLayer)),
    timeout
  )

  it.live(
    "works in a sandbox on this machine, running a command there",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const sandboxProvider = yield* LocalSandboxProvider.make({
          directory: yield* fs.makeTempDirectoryScoped()
        })
        const sandbox = yield* sandboxProvider.createScoped()
        const session = yield* makeSession(sandbox)

        const result = yield* session.generate({
          prompt: "Run `echo amends-live > proof.txt` with your bash tool, then reply with: done"
        })

        expect(result.toolCalls.map((call) => call.name)).toContain("bash")
        expect(yield* sandbox.fileSystem.readFileString(path.join(sandbox.workingDirectory, id, "proof.txt"))).toBe(
          "amends-live\n"
        )
      }).pipe(Effect.provide(LiveLayer)),
    timeout
  )

  it.live(
    "reaches Anthropic's Messages API and OpenAI's Responses API",
    () =>
      Effect.gen(function* () {
        const anthropic = refusedEndpoint(
          "anthropic",
          "claude-opus-5-5",
          "anthropic-messages",
          "https://api.anthropic.com/v1"
        )
        const openai = refusedEndpoint("openai", "gpt-5.6", "openai-responses", "https://api.openai.com/v1")

        expect(yield* refusesKey(anthropic)).toBe(true)
        expect(yield* refusesKey(openai)).toBe(true)
      }).pipe(Effect.provide(LiveLayer)),
    timeout
  )
})
