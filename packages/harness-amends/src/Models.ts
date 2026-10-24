/**
 * The models the agent runs on, made from model endpoints: an Effect AI client for the endpoint's
 * protocol, at its URL, with its key and headers, and the endpoint's model on that client, set to
 * the endpoint's effort and output limit.
 *
 * The agent makes them with `LanguageModels`, which `layer` provides over the host's `HttpClient`,
 * that the requests go out through. A test provides models of its own in its place.
 *
 * @since 0.1.0
 */

import type { ModelEndpoint } from "@amends-dev/harness"
import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient"
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel"
import * as ChatClient from "@effect/ai-openai-compat/OpenAiClient"
import * as ChatLanguageModel from "@effect/ai-openai-compat/OpenAiLanguageModel"
import * as OpenAiClient from "@effect/ai-openai/OpenAiClient"
import * as OpenAiLanguageModel from "@effect/ai-openai/OpenAiLanguageModel"
import type * as LanguageModel from "effect/ai/LanguageModel"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { flow } from "effect/Function"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Layer from "effect/Layer"
import * as Record from "effect/Record"
import * as Redacted from "effect/Redacted"
import * as Stream from "effect/Stream"

/**
 * Makes the language model an endpoint reaches. The agent takes it as a service, so that a test
 * provides models of its own in place of the providers' clients.
 *
 * @category services
 * @since 0.1.0
 */
export class LanguageModels extends Context.Service<
  LanguageModels,
  {
    /** The language model `endpoint` reaches. */
    readonly make: (endpoint: ModelEndpoint.ModelEndpoint) => Effect.Effect<LanguageModel.LanguageModel>
  }
>()("@amends-dev/harness-amends/Models/LanguageModels") {}

/**
 * Provides `LanguageModels` over the `HttpClient` the requests go out through, such as
 * `FetchHttpClient.layer`.
 *
 * **Example** (Generating text on OpenRouter with the model of an endpoint)
 *
 * ```ts
 * import { Models } from "@amends-dev/harness-amends"
 * import { Config, Effect, Layer } from "effect"
 * import { LanguageModel } from "effect/ai"
 * import { FetchHttpClient } from "effect/http"
 *
 * const program = Effect.gen(function* () {
 *   const languageModels = yield* Models.LanguageModels
 *   const model = yield* languageModels.make({
 *     provider: "openrouter",
 *     model: "nvidia/nemotron-3-super-120b-a12b:free",
 *     protocol: "openai-chat",
 *     url: "https://openrouter.ai/api/v1",
 *     apiKey: yield* Config.Redacted("OPENROUTER_API_KEY")
 *   })
 *   const response = yield* LanguageModel.generateText({ prompt: "Say hi" }).pipe(
 *     Effect.provideService(LanguageModel.LanguageModel, model)
 *   )
 *   return response.text
 * }).pipe(Effect.provide(Models.layer.pipe(Layer.provide(FetchHttpClient.layer))))
 * ```
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.effect(
  LanguageModels,
  Effect.map(HttpClient.HttpClient, (client) =>
    LanguageModels.of({
      make: (endpoint) => languageModel(endpoint).pipe(Effect.provideService(HttpClient.HttpClient, client))
    })
  )
)

const languageModel = (
  endpoint: ModelEndpoint.ModelEndpoint
): Effect.Effect<LanguageModel.LanguageModel, never, HttpClient.HttpClient> => {
  // A URL is the one the protocol's paths follow, with or without a slash at its end.
  const url = endpoint.url.replace(/\/+$/, "")
  switch (endpoint.protocol) {
    case "anthropic-messages":
      return anthropicModel(endpoint, url)
    case "openai-responses":
      return responsesModel(endpoint, url)
    case "openai-chat":
      return chatModel(endpoint, url)
  }
}

const anthropicModel = Effect.fnUntraced(function* (endpoint: ModelEndpoint.ModelEndpoint, url: string) {
  const client = yield* AnthropicClient.make({
    apiKey: endpoint.apiKey,
    apiUrl: url,
    // The client sends to `/v1/messages` after its URL, while the endpoint's URL is the one that
    // `/messages` follows, which ends in `/v1` for Anthropic's own API.
    transformClient: flow(
      HttpClient.mapRequest(HttpClientRequest.updateUrl((requestUrl) => requestUrl.replace(`${url}/v1/`, `${url}/`))),
      withHeaders(endpoint)
    )
  })
  return yield* AnthropicLanguageModel.make({
    model: endpoint.model,
    config: {
      ...(endpoint.maxOutputTokens === undefined ? {} : { max_tokens: endpoint.maxOutputTokens }),
      ...(endpoint.effort === undefined
        ? {}
        : // Effect's settings name only the levels up to `high`; the client sends any it is given,
          // and Anthropic's API takes `xhigh` and `max` too, for the models the catalog lists them for.
          { output_config: { effort: endpoint.effort as "high" } })
    }
  }).pipe(Effect.provideService(AnthropicClient.AnthropicClient, client))
})

const responsesModel = Effect.fnUntraced(function* (endpoint: ModelEndpoint.ModelEndpoint, url: string) {
  const client = yield* OpenAiClient.make({
    apiKey: endpoint.apiKey,
    apiUrl: url,
    transformClient: withHeaders(endpoint)
  })
  return yield* OpenAiLanguageModel.make({
    model: endpoint.model,
    config: {
      ...(endpoint.maxOutputTokens === undefined ? {} : { max_output_tokens: endpoint.maxOutputTokens }),
      ...(endpoint.effort === undefined
        ? {}
        : // Effect's settings name the levels up to `xhigh`; the client sends any it is given, and
          // OpenAI's API takes `max` too, for the models the catalog lists it for.
          { reasoning: { effort: endpoint.effort as "xhigh" } })
    }
  }).pipe(Effect.provideService(OpenAiClient.OpenAiClient, client))
})

const chatModel = Effect.fnUntraced(function* (endpoint: ModelEndpoint.ModelEndpoint, url: string) {
  const client = yield* ChatClient.make({
    apiKey: endpoint.apiKey,
    apiUrl: url,
    transformClient: flow(withoutNullServiceTiers, withHeaders(endpoint))
  })
  return yield* ChatLanguageModel.make({
    model: endpoint.model,
    config: {
      ...(endpoint.maxOutputTokens === undefined ? {} : { max_output_tokens: endpoint.maxOutputTokens }),
      // The Chat Completions API takes the effort as `reasoning_effort`, which the client sends as
      // it is, being a setting it does not name.
      ...(endpoint.effort === undefined ? {} : { reasoning_effort: endpoint.effort })
    }
  }).pipe(Effect.provideService(ChatClient.OpenAiClient, client))
})

/** Sends each request with the headers `endpoint` asks for besides its key. */
const withHeaders = (endpoint: ModelEndpoint.ModelEndpoint) =>
  HttpClient.mapRequest(HttpClientRequest.setHeaders(Record.map(endpoint.headers ?? {}, Redacted.value)))

/**
 * A Chat Completions API's answers without a `service_tier` of null, as OpenRouter answers: in each
 * line of a streamed answer, where every chunk is a line, and in a whole answer. Effect's client
 * refuses a whole answer that has one, and skips a streamed chunk that has one, which loses the
 * usage OpenRouter streams in its last chunk.
 */
const withoutNullServiceTiers = HttpClient.transformResponse(
  Effect.flatMap((response: HttpClientResponse.HttpClientResponse) => {
    const answerWith = (body: string | ReadableStream<Uint8Array>) =>
      HttpClientResponse.fromWeb(
        response.request,
        new Response(body, { status: response.status, headers: response.headers })
      )
    if (response.headers["content-type"]?.startsWith("text/event-stream") === true) {
      const lines = response.stream.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.map((line) => `${withoutNullServiceTier(line)}\n`),
        Stream.encodeText
      )
      return Effect.succeed(answerWith(Stream.toReadableStream(lines)))
    }
    return Effect.map(response.text, (text) => answerWith(withoutNullServiceTier(text)))
  })
)

/** `text`, or the JSON in it, after `data: ` in a streamed line, without a `service_tier` of null. */
const withoutNullServiceTier = (text: string): string => {
  if (!/"service_tier"\s*:\s*null/.test(text)) return text
  const prefix = text.startsWith("data:") ? text.slice(0, text.indexOf(":") + 1) : ""
  try {
    const { service_tier: _, ...rest } = JSON.parse(text.slice(prefix.length))
    return `${prefix}${JSON.stringify(rest)}`
  } catch {
    return text
  }
}
