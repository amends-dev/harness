/** Converts the harness's explicit endpoints to Claude's per-query model and environment. */

import { type Agent, HarnessError, type ModelEndpoint } from "@amends-dev/harness"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

export const Model = Schema.Struct({
  model: Schema.String,
  env: Schema.Record(Schema.String, Schema.String),
  effort: Schema.optionalKey(Schema.Literals(["low", "medium", "high", "xhigh", "max"])),
  thinking: Schema.optionalKey(Schema.Literal("disabled"))
})
export interface Model extends Schema.Schema.Type<typeof Model> {}

export const Options = Schema.Struct({
  model: Model,
  models: Schema.Record(Schema.String, Model),
  env: Schema.Record(Schema.String, Schema.String)
})
export interface Options extends Schema.Schema.Type<typeof Options> {}

export const modelsOf = (
  options: Agent.Options
): Result.Result<Pick<Options, "model" | "models">, HarnessError.UnsupportedError> => {
  const model = modelOf(options.model)
  if (Result.isFailure(model)) return Result.fail(model.failure)
  const models: Record<string, Model> = {}
  for (const [name, endpoint] of Object.entries(options.models ?? {})) {
    const named = modelOf(endpoint)
    if (Result.isFailure(named)) return Result.fail(named.failure)
    Object.defineProperty(models, name, { value: named.success, enumerable: true })
  }
  return Result.succeed({ model: model.success, models })
}

const modelOf = (endpoint: ModelEndpoint.ModelEndpoint): Result.Result<Model, HarnessError.UnsupportedError> => {
  const unsupported = (description: string) => Result.fail(new HarnessError.UnsupportedError({ description }))
  if (endpoint.apiKey === undefined || Redacted.value(endpoint.apiKey).trim() === "")
    return unsupported(
      "Claude requires an explicit non-empty endpoint API key; ambient Claude account credentials are not used"
    )
  if (endpoint.protocol !== "anthropic-messages") return unsupported("Claude requires an Anthropic Messages endpoint")
  if (endpoint.effort === "minimal") return unsupported("Claude has no minimal reasoning effort; choose none or low")
  // Claude adds /v1/messages itself. Refuse other paths rather than silently changing the endpoint.
  const parsed = URL.parse(endpoint.url)
  if (
    parsed === null ||
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.search ||
    parsed.hash ||
    !parsed.pathname.replace(/\/+$/, "").endsWith("/v1")
  ) {
    return unsupported("Claude's endpoint URL must end in /v1, without a query or fragment")
  }
  const headers: Array<string> = []
  for (const [name, value] of Object.entries(endpoint.headers ?? {})) {
    const plain = Redacted.value(value)
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || /[\r\n]/.test(plain))
      return unsupported("Claude's custom headers must be valid single-line HTTP headers")
    headers.push(`${name}: ${plain}`)
  }
  return Result.succeed({
    model: endpoint.model,
    env: {
      ANTHROPIC_BASE_URL: endpoint.url.replace(/\/+$/, "").replace(/\/v1$/, ""),
      ANTHROPIC_API_KEY: Redacted.value(endpoint.apiKey),
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_CUSTOM_HEADERS: headers.join("\n"),
      ...(endpoint.maxOutputTokens === undefined
        ? {}
        : { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(endpoint.maxOutputTokens) })
    },
    ...(endpoint.effort === "none"
      ? { thinking: "disabled" as const }
      : endpoint.effort === undefined
        ? {}
        : { effort: endpoint.effort })
  })
}
