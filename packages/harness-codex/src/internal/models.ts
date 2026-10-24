/** Converts endpoints into Codex providers, keeping credentials out of process arguments. */

import { type Agent, ModelEndpoint } from "@amends-dev/harness"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { unsupported } from "./errors.ts"

export const Model = Schema.Struct({
  model: Schema.String,
  provider: Schema.String,
  effort: Schema.optionalKey(ModelEndpoint.Effort),
  contextWindow: Schema.optionalKey(Schema.Int)
})

export type Model = typeof Model.Type

export const Options = Schema.Struct({
  model: Model,
  models: Schema.Record(Schema.String, Model),
  config: Schema.Record(Schema.String, Schema.Json),
  env: Schema.Record(Schema.String, Schema.String),
  command: Schema.optionalKey(Schema.String)
})
export type Options = typeof Options.Type

export const modelsOf = Effect.fn("CodexAgent.modelsOf")(function* (options: Agent.Options) {
  const config: Record<string, Schema.Json> = {}
  const env: Record<string, string> = {}
  let index = 0
  const convert = (endpoint: ModelEndpoint.ModelEndpoint) => {
    const provider = `amends_${index++}`
    const key = `AMENDS_CODEX_KEY_${provider}`
    if (endpoint.apiKey !== undefined) env[key] = Redacted.value(endpoint.apiKey)
    config[`model_providers.${provider}`] = {
      name: provider,
      base_url: endpoint.url.replace(/\/+$/, ""),
      wire_api: "responses",
      requires_openai_auth: false,
      supports_websockets: false,
      ...(endpoint.apiKey === undefined ? {} : { env_key: key }),
      http_headers: Object.fromEntries(Object.entries(endpoint.headers ?? {}).map(([k, v]) => [k, Redacted.value(v)]))
    }
    return {
      model: endpoint.model,
      provider,
      ...(endpoint.effort === undefined ? {} : { effort: endpoint.effort }),
      ...(endpoint.contextWindow === undefined ? {} : { contextWindow: endpoint.contextWindow })
    }
  }
  for (const endpoint of [options.model, ...Object.values(options.models ?? {})]) {
    if (endpoint.protocol !== "openai-responses") {
      return yield* unsupported(`Codex requires the Responses API; ${endpoint.protocol} is unsupported`)
    }
    if (endpoint.maxOutputTokens !== undefined) {
      return yield* unsupported("Codex app-server has no configurable maximum output token limit")
    }
  }
  const model = convert(options.model)
  const models = Object.fromEntries(Object.entries(options.models ?? {}).map(([name, value]) => [name, convert(value)]))
  return { model, models, config, env }
})
