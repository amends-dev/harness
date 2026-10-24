/**
 * The models opencode runs on, made from model endpoints: what opencode's server takes to serve
 * them, its providers and the variables it runs with, and each endpoint's model as opencode names
 * it. opencode serves a model through the endpoint's protocol, at its URL, within its limits, and
 * with the key and headers of its provider. An endpoint's effort is a variant of the model, which
 * the endpoint's model names.
 *
 * opencode 1 and opencode 2 configure providers apart: opencode 1 names them `provider`, and
 * opencode 2 `providers`, each in a shape of its own. Both give a model its AI SDK package and URL,
 * and a variant the AI SDK options that ask for its effort, and both find the providers and models
 * that models.dev lists by their ids, as endpoints name them, knowing the rest of a model from
 * there, such as whether it calls tools.
 */

import { HarnessError, type ModelEndpoint } from "@amends-dev/harness"
import * as Array from "effect/Array"
import * as Record from "effect/Record"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import type * as Schema from "effect/Schema"
import type { ModelRef } from "./bridge/driver.ts"
import type { Version } from "./template.ts"

type Endpoints = Array.NonEmptyReadonlyArray<ModelEndpoint.ModelEndpoint>

type JsonObject = { readonly [field: string]: Schema.Json }

export interface Models {
  /** The fields of opencode's configuration that serve the endpoints' models: its providers. */
  readonly config: JsonObject

  /** The environment variables opencode's server serves the models with. */
  readonly env: { readonly [name: string]: string }

  /** The model a turn runs on when it names none. */
  readonly model: ModelRef

  /** The models a turn can name, by name. */
  readonly models: { readonly [name: string]: ModelRef }
}

/**
 * The models opencode `version` runs on for the endpoint `model`, and `models` by name. opencode
 * presents one key, with one set of headers, for each provider, and serves a model through one
 * protocol, at one URL, within one output limit and context window, so endpoints that differ in
 * them fail with `UnsupportedError`.
 */
export const modelsOf = (
  version: Version,
  endpoints: {
    readonly model: ModelEndpoint.ModelEndpoint
    readonly models?: Readonly<Record<string, ModelEndpoint.ModelEndpoint>> | undefined
  }
): Result.Result<Models, HarnessError.UnsupportedError> => {
  const all = [endpoints.model, ...Object.values(endpoints.models ?? {})] as const
  const byProvider = Object.entries(Array.groupBy(all, (endpoint) => endpoint.provider))
  for (const [providerId, ofProvider] of byProvider) {
    const conflict = conflictIn(providerId, ofProvider)
    if (conflict !== undefined) {
      return Result.fail(new HarnessError.UnsupportedError({ description: conflict }))
    }
  }
  const providers = Object.fromEntries(
    byProvider.map(([providerId, ofProvider]) => [providerId, providerOf[version](ofProvider)])
  )
  const config: JsonObject = version === 1 ? { provider: providers } : { providers }
  return Result.succeed({
    config,
    env: version === 1 ? outputCeilingOf(all) : {},
    model: modelRefOf(endpoints.model),
    models: Object.fromEntries(
      Object.entries(endpoints.models ?? {}).map(([name, endpoint]) => [name, modelRefOf(endpoint)])
    )
  })
}

/** Why opencode cannot serve the endpoints of the provider `providerId`, or nothing when it can. */
const conflictIn = (providerId: string, endpoints: ReadonlyArray<ModelEndpoint.ModelEndpoint>): string | undefined => {
  if (new Set(endpoints.map((endpoint) => JSON.stringify(secretsOf(endpoint)))).size > 1) {
    return (
      "opencode presents one key, with one set of headers, for each provider, and the " +
      `endpoints for ${providerId} differ in them`
    )
  }
  for (const [modelId, ofModel] of Object.entries(Array.groupBy(endpoints, (endpoint) => endpoint.model))) {
    const served = new Set(
      ofModel.map((endpoint) =>
        JSON.stringify([endpoint.protocol, urlOf(endpoint), endpoint.maxOutputTokens, endpoint.contextWindow])
      )
    )
    if (served.size > 1) {
      return (
        "opencode serves a model through one protocol, at one URL, within one output limit and " +
        `context window, and the endpoints for ${providerId}/${modelId} differ in them`
      )
    }
  }
  return undefined
}

/** The configuration of the provider that serves `endpoints`, which share their provider. */
const providerOf: Record<Version, (endpoints: Endpoints) => Schema.Json> = {
  1: (endpoints) => {
    const options: JsonObject = secretsOf(endpoints[0])
    return {
      ...(Record.isEmptyRecord(options) ? {} : { options }),
      models: modelsByIdOf(endpoints, opencode1ModelOf)
    }
  },
  2: (endpoints) => {
    const { apiKey, headers } = secretsOf(endpoints[0])
    return {
      ...(apiKey === undefined ? {} : { settings: { apiKey } }),
      ...(headers === undefined ? {} : { headers }),
      models: modelsByIdOf(endpoints, opencode2ModelOf)
    }
  }
}

/** The configuration of each model that `endpoints` name, by its id, as `modelOf` writes it. */
const modelsByIdOf = (endpoints: Endpoints, modelOf: (endpoints: Endpoints) => Schema.Json) =>
  Object.fromEntries(
    Object.entries(Array.groupBy(endpoints, (endpoint) => endpoint.model)).map(([modelId, ofModel]) => [
      modelId,
      modelOf(ofModel)
    ])
  )

/**
 * A model in opencode 1's configuration. opencode 1 takes a model's limits together, so an
 * endpoint with an output limit gives its context window too, or 0, which opencode takes as
 * unknown; an endpoint without one leaves both to what opencode knows of the model from models.dev.
 * A variant gives the AI SDK options that ask for its effort.
 */
const opencode1ModelOf = (endpoints: Endpoints): Schema.Json => {
  const [endpoint] = endpoints
  const variants = efforts(endpoints).map(
    (effort) => [variantOf(effort), effortOptions[endpoint.protocol](effort)] as const
  )
  return {
    provider: { npm: packages[endpoint.protocol], api: urlOf(endpoint) },
    ...(endpoint.maxOutputTokens === undefined
      ? {}
      : { limit: { context: endpoint.contextWindow ?? 0, output: endpoint.maxOutputTokens } }),
    ...(variants.length === 0 ? {} : { variants: Object.fromEntries(variants) })
  }
}

/**
 * A model in opencode 2's configuration, whose URL is an AI SDK setting, and whose limits opencode
 * takes apart, each over what models.dev says.
 */
const opencode2ModelOf = (endpoints: Endpoints): Schema.Json => {
  const [endpoint] = endpoints
  const limit: JsonObject = {
    ...(endpoint.maxOutputTokens === undefined ? {} : { output: endpoint.maxOutputTokens }),
    ...(endpoint.contextWindow === undefined ? {} : { context: endpoint.contextWindow })
  }
  const variants = efforts(endpoints).map((effort) => ({
    id: variantOf(effort),
    settings: effortOptions[endpoint.protocol](effort)
  }))
  return {
    package: packages[endpoint.protocol],
    settings: { baseURL: urlOf(endpoint) },
    ...(Record.isEmptyRecord(limit) ? {} : { limit }),
    ...(variants.length === 0 ? {} : { variants })
  }
}

/** The efforts that `endpoints` ask for, each once. */
const efforts = (endpoints: Endpoints) => [
  ...new Set(endpoints.flatMap(({ effort }) => (effort === undefined ? [] : [effort])))
]

const modelRefOf = (endpoint: ModelEndpoint.ModelEndpoint): ModelRef => ({
  providerID: endpoint.provider,
  id: endpoint.model,
  ...(endpoint.effort === undefined ? {} : { variant: variantOf(endpoint.effort) })
})

/**
 * The AI SDK package opencode serves a protocol with: opencode's runner sends a model's requests as
 * the API that the package its model names reaches.
 */
const packages: Record<ModelEndpoint.Protocol, string> = {
  "anthropic-messages": "@ai-sdk/anthropic",
  "openai-responses": "@ai-sdk/openai",
  "openai-chat": "@ai-sdk/openai-compatible"
}

/**
 * The AI SDK options that ask for an effort, as each protocol's package takes them, which opencode
 * gives the requests of a model that runs in a variant of them.
 */
const effortOptions: Record<ModelEndpoint.Protocol, (effort: ModelEndpoint.Effort) => JsonObject> = {
  "anthropic-messages": (effort) => ({ effort }),
  "openai-responses": (effort) => ({ reasoningEffort: effort }),
  "openai-chat": (effort) => ({ reasoningEffort: effort })
}

/**
 * The variant of a model that asks for `effort`, named apart from the variants that opencode gives
 * models itself, whose fields one of the same name would join.
 */
const variantOf = (effort: ModelEndpoint.Effort) => `amends-${effort}`

/** The endpoint's URL without a slash at its end, which the protocol's paths follow. */
const urlOf = (endpoint: ModelEndpoint.ModelEndpoint) => endpoint.url.replace(/\/+$/, "")

/** The key and headers the endpoint's requests carry, each absent when it gives none. */
const secretsOf = (
  endpoint: ModelEndpoint.ModelEndpoint
): { readonly apiKey?: string; readonly headers?: { readonly [name: string]: string } } => {
  const headers = Record.map(endpoint.headers ?? {}, Redacted.value)
  return {
    ...(endpoint.apiKey === undefined ? {} : { apiKey: Redacted.value(endpoint.apiKey) }),
    ...(Record.isEmptyRecord(headers) ? {} : { headers })
  }
}

/**
 * The most tokens opencode 1 lets a model write in a response is 32,000, whatever its output
 * limit, unless its server is given a higher ceiling. It is given the highest output limit of the
 * endpoints when one is higher, which leaves the models without one as they were.
 */
const outputCeilingOf = (
  endpoints: ReadonlyArray<ModelEndpoint.ModelEndpoint>
): { readonly [name: string]: string } => {
  const highest = Math.max(...endpoints.map((endpoint) => endpoint.maxOutputTokens ?? 0))
  return highest > 32_000 ? { OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: String(highest) } : {}
}
