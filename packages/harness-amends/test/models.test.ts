import type { ModelEndpoint } from "@amends-dev/harness"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Models from "../src/Models.ts"

interface Received {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown>
}

/** A provider's answer to a request, saying `hi`, as each protocol answers. */
const answers: Record<ModelEndpoint.Protocol, object> = {
  "anthropic-messages": {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "model",
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      service_tier: "standard"
    }
  },
  "openai-responses": {
    id: "resp_1",
    object: "response",
    created_at: 0,
    status: "completed",
    model: "model",
    output: [
      {
        type: "message",
        id: "msg_1",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "hi", annotations: [] }]
      }
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
  },
  "openai-chat": {
    id: "chat_1",
    object: "chat.completion",
    created: 0,
    model: "model",
    choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }
}

/** The language model `Models.layer` makes of `endpoint`, sending its requests through `client`. */
const languageModelOf = (endpoint: ModelEndpoint.ModelEndpoint, client: HttpClient.HttpClient) =>
  Effect.flatMap(Models.LanguageModels, (languageModels) => languageModels.make(endpoint)).pipe(
    Effect.provide(Models.layer),
    Effect.provideService(HttpClient.HttpClient, client)
  )

/**
 * Asks the model `endpoint` reaches to say hi, through a provider that answers as the endpoint's
 * protocol does, and returns what the model answered and the request the provider received.
 */
const askThrough = (endpoint: ModelEndpoint.ModelEndpoint) =>
  Effect.gen(function* () {
    const received: Array<Received> = []
    const client = HttpClient.make((request, url) =>
      Effect.sync(() => {
        const body = request.body as { readonly body?: Uint8Array }
        received.push({
          url: url.toString(),
          headers: { ...request.headers },
          body: JSON.parse(new TextDecoder().decode(body.body))
        })
        return HttpClientResponse.fromWeb(request, Response.json(answers[endpoint.protocol], { status: 200 }))
      })
    )
    const model = yield* languageModelOf(endpoint, client)
    const response = yield* LanguageModel.generateText({ prompt: "Say hi" }).pipe(
      Effect.provideService(LanguageModel.LanguageModel, model)
    )
    return { text: response.text, received }
  })

const key = Redacted.make("secret-key")

describe("Models.layer", () => {
  it.effect("reaches Anthropic's Messages API at the path that follows the endpoint's URL", () =>
    Effect.gen(function* () {
      const { text, received } = yield* askThrough({
        provider: "anthropic",
        model: "claude-opus-5-5",
        protocol: "anthropic-messages",
        url: "https://api.anthropic.com/v1",
        apiKey: key,
        effort: "max",
        maxOutputTokens: 64_000
      })

      expect(text).toBe("hi")
      expect(received).toHaveLength(1)
      expect(received[0]?.url).toBe("https://api.anthropic.com/v1/messages?beta=true")
      expect(received[0]?.headers["x-api-key"]).toBe("secret-key")
      expect(received[0]?.body).toMatchObject({
        model: "claude-opus-5-5",
        max_tokens: 64_000,
        output_config: { effort: "max" }
      })
    })
  )

  it.effect("reaches OpenAI's Responses API with the endpoint's key, effort, and limit", () =>
    Effect.gen(function* () {
      const { text, received } = yield* askThrough({
        provider: "openai",
        model: "gpt-5.6",
        protocol: "openai-responses",
        url: "https://api.openai.com/v1",
        apiKey: key,
        effort: "xhigh",
        maxOutputTokens: 32_000
      })

      expect(text).toBe("hi")
      expect(received[0]?.url).toBe("https://api.openai.com/v1/responses")
      expect(received[0]?.headers["authorization"]).toBe("Bearer secret-key")
      expect(received[0]?.body).toMatchObject({
        model: "gpt-5.6",
        max_output_tokens: 32_000,
        reasoning: { effort: "xhigh" }
      })
    })
  )

  it.effect("reaches a Chat Completions API with the effort as `reasoning_effort`", () =>
    Effect.gen(function* () {
      const { text, received } = yield* askThrough({
        provider: "openrouter",
        model: "openai/gpt-oss-120b",
        protocol: "openai-chat",
        url: "https://openrouter.ai/api/v1",
        apiKey: key,
        effort: "low",
        maxOutputTokens: 8000
      })

      expect(text).toBe("hi")
      expect(received[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions")
      expect(received[0]?.headers["authorization"]).toBe("Bearer secret-key")
      expect(received[0]?.body).toMatchObject({
        model: "openai/gpt-oss-120b",
        max_tokens: 8000,
        reasoning_effort: "low"
      })
    })
  )

  it.effect("sends the headers the endpoint asks for besides its key, on every protocol", () =>
    Effect.gen(function* () {
      const headers = { "cf-aig-authorization": Redacted.make("Bearer gateway-token") }
      const anthropic = yield* askThrough({
        provider: "anthropic",
        model: "claude-opus-5-5",
        protocol: "anthropic-messages",
        url: "https://gateway.example/anthropic",
        apiKey: key,
        headers
      })
      const openai = yield* askThrough({
        provider: "openai",
        model: "gpt-5.6",
        protocol: "openai-responses",
        url: "https://gateway.example/openai",
        apiKey: key,
        headers
      })
      const compatible = yield* askThrough({
        provider: "openrouter",
        model: "openai/gpt-5.6",
        protocol: "openai-chat",
        url: "https://gateway.example/compat",
        headers
      })

      expect(anthropic.received[0]?.headers).toMatchObject({
        "x-api-key": "secret-key",
        "cf-aig-authorization": "Bearer gateway-token"
      })
      expect(openai.received[0]?.headers).toMatchObject({
        authorization: "Bearer secret-key",
        "cf-aig-authorization": "Bearer gateway-token"
      })
      expect(compatible.received[0]?.headers).toMatchObject({
        "cf-aig-authorization": "Bearer gateway-token"
      })
      expect(compatible.received[0]?.headers["authorization"]).toBeUndefined()
    })
  )

  it.effect("takes a URL that ends in a slash as the one without it", () =>
    Effect.gen(function* () {
      const urls = []
      for (const [protocol, path] of [
        ["anthropic-messages", "/messages?beta=true"],
        ["openai-responses", "/responses"],
        ["openai-chat", "/chat/completions"]
      ] as const) {
        const { received } = yield* askThrough({
          provider: "gateway",
          model: "model",
          protocol,
          url: "https://gateway.example/v1/"
        })
        urls.push([received[0]?.url, `https://gateway.example/v1${path}`])
      }

      for (const [url, expected] of urls) expect(url).toBe(expected)
    })
  )

  it.effect("sends no key, effort, or limit that the endpoint does not give", () =>
    Effect.gen(function* () {
      for (const protocol of ["anthropic-messages", "openai-responses", "openai-chat"] as const) {
        const { received } = yield* askThrough({
          provider: "local",
          model: "model",
          protocol,
          url: "http://localhost:8080/v1"
        })
        const sent: Received = received[0] ?? { url: "", headers: {}, body: {} }
        const { headers, body } = sent

        expect(headers["x-api-key"]).toBeUndefined()
        expect(headers["authorization"]).toBeUndefined()
        expect(body).not.toHaveProperty("output_config")
        expect(body).not.toHaveProperty("reasoning")
        expect(body).not.toHaveProperty("reasoning_effort")
        expect(body).not.toHaveProperty("max_output_tokens")
        if (protocol === "openai-chat") expect(body).not.toHaveProperty("max_tokens")
      }
    })
  )

  it.effect("reads a Chat Completions answer, and a streamed one's usage, with a `service_tier` of null", () =>
    Effect.gen(function* () {
      const chunk = (fields: object) =>
        `data: ${JSON.stringify({ id: "chat_1", object: "chat.completion.chunk", created: 0, model: "model", ...fields })}\n\n`
      const streamed = [
        chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], service_tier: null }),
        chunk({
          choices: [],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          service_tier: null
        }),
        "data: [DONE]\n\n"
      ].join("")
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          const body = request.body as { readonly body?: Uint8Array }
          const asked = JSON.parse(new TextDecoder().decode(body.body))
          return HttpClientResponse.fromWeb(
            request,
            asked.stream === true
              ? new Response(streamed, { headers: { "content-type": "text/event-stream" } })
              : Response.json({ ...answers["openai-chat"], service_tier: null })
          )
        })
      )
      const model = yield* languageModelOf(
        {
          provider: "openrouter",
          model: "model",
          protocol: "openai-chat",
          url: "https://openrouter.ai/api/v1"
        },
        client
      )

      const whole = yield* LanguageModel.generateText({ prompt: "Say hi" }).pipe(
        Effect.provideService(LanguageModel.LanguageModel, model)
      )
      const parts = yield* LanguageModel.streamText({ prompt: "Say hi" }).pipe(
        Stream.runCollect,
        Effect.provideService(LanguageModel.LanguageModel, model)
      )
      const finish = parts.find((part) => part.type === "finish")

      expect(whole.text).toBe("hi")
      expect(finish?.usage.inputTokens.total).toBe(3)
      expect(finish?.usage.outputTokens.total).toBe(2)
    })
  )
})
