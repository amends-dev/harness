/**
 * The parts the harness streams for a turn of the agent, from what Effect AI streams and returns:
 * each part of a response as the harness's, a response's `finish` as the end of a step, and the
 * turn's own `finish` and `error`.
 */

import type { StreamPart } from "@amends-dev/harness"
import * as AiError from "effect/ai/AiError"
import type * as LanguageModel from "effect/ai/LanguageModel"
import * as Response from "effect/ai/Response"
import type * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import { flow } from "effect/Function"
import * as Headers from "effect/http/Headers"
import * as UrlParams from "effect/http/UrlParams"
import * as Predicate from "effect/Predicate"
import * as Record from "effect/Record"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

/**
 * The parts the harness streams for one of Effect AI's. Calls and results of the agent's own tools
 * are `providerExecuted`; results of the host's tools are left to the session, which streams its
 * own; and a response's `finish` ends a step.
 */
export const streamPartsOf = <Tools extends Record<string, Tool.Any>>(
  part: Response.StreamPart<Tools>,
  isOwnTool: (name: string) => boolean
): Effect.Effect<ReadonlyArray<StreamPart.StreamPart>> => {
  switch (part.type) {
    case "tool-call":
      return Effect.succeed([
        {
          type: "tool-call",
          id: part.id,
          name: part.name,
          params: part.params,
          providerExecuted: isOwnTool(part.name),
          metadata: part.metadata
        }
      ])
    case "tool-result":
      return Effect.succeed(
        isOwnTool(part.name)
          ? [
              {
                type: "tool-result",
                id: part.id,
                name: part.name,
                result: part.encodedResult,
                isFailure: part.isFailure,
                providerExecuted: true,
                preliminary: part.preliminary,
                metadata: part.metadata
              }
            ]
          : []
      )
    case "finish":
      return Effect.map(encodeFinishPart(part), (finish) => [
        {
          type: "finish-step",
          reason: finish.reason,
          usage: finish.usage,
          metadata: finish.metadata
        }
      ])
    default:
      return Effect.map(encodeStreamPart(part), (encoded) => [encoded])
  }
}

/** How a step finished when the model did not say. */
export const unknownFinish = Response.makePart("finish", {
  reason: "unknown",
  usage: new Response.Usage({ inputTokens: {}, outputTokens: {} }),
  response: undefined
})

/** How the step that `response` answered whole finished. */
export const finishPartOf = (response: LanguageModel.GenerateTextResponse<{}>) =>
  Response.makePart("finish", {
    reason: response.finishReason,
    usage: response.usage,
    response: undefined
  })

/** The turn's `finish`: why its last step ended, or `error`, and the tokens its steps used. */
export const turnFinishOf = (steps: ReadonlyArray<Response.FinishPart>, failed: boolean) =>
  encodeFinishPart(
    Response.makePart("finish", {
      reason: failed ? "error" : (steps.at(-1)?.reason ?? "unknown"),
      usage: usageOf(steps),
      response: undefined
    })
  )

/**
 * The `error` part reporting the model's failure, with the `AiError` as JSON. Effect keeps the
 * credentials in a failed request's headers and URL parameters as `Redacted` values, and encoding
 * them as JSON reveals them, so the JSON is redacted again by name, with Effect's own names.
 */
export const errorPartOf = (error: AiError.AiError) =>
  Effect.gen(function* () {
    const json = yield* encodeAiError(error)
    const names: RedactedNames = {
      headers: yield* Headers.CurrentRedactedNames,
      urlParams: yield* UrlParams.CurrentRedactedNames
    }
    const part: StreamPart.StreamPart = { type: "error", error: redactCredentials(json, names) }
    return part
  })

/** The names of the headers and URL parameters whose values are credentials. */
interface RedactedNames {
  readonly headers: ReadonlyArray<string | RegExp>
  readonly urlParams: ReadonlyArray<string | RegExp>
}

const isJsonArray = (json: Schema.Json): json is Schema.JsonArray => Arr.isArray(json)

const isJsonObject = (json: Schema.Json): json is Schema.JsonObject => Predicate.isObject(json) && !isJsonArray(json)

const isStringPair = (json: Schema.Json): json is readonly [string, string] =>
  isJsonArray(json) && json.length === 2 && Predicate.isString(json[0]) && Predicate.isString(json[1])

const shown = (value: string | Redacted.Redacted<string>) => (Redacted.isRedacted(value) ? "<redacted>" : value)

/** `json` with the credentials in every `headers` record and `urlParams` list in it redacted. */
const redactCredentials = (json: Schema.Json, names: RedactedNames): Schema.Json => {
  if (isJsonArray(json)) {
    return json.map((item) => redactCredentials(item, names))
  }
  if (!isJsonObject(json)) {
    return json
  }
  return Record.map(json, (value, key): Schema.Json => {
    if (key === "headers" && isJsonObject(value)) {
      return Record.map(
        Headers.redact(Headers.fromInput(Record.filter(value, Predicate.isString)), names.headers),
        shown
      )
    }
    if (key === "urlParams" && isJsonArray(value)) {
      return UrlParams.redact(UrlParams.fromInput(value.filter(isStringPair)), names.urlParams).map(([name, param]) => [
        name,
        shown(param)
      ])
    }
    return redactCredentials(value, names)
  })
}

// Encoding what Effect AI decoded cannot fail.
const encodeStreamPart = flow(Schema.encodeEffect(Response.StreamPart(Toolkit.empty)), Effect.orDie)

const encodeFinishPart = flow(Schema.encodeEffect(Response.FinishPart), Effect.orDie)

const encodeAiError = flow(Schema.encodeEffect(Schema.toCodecJson(AiError.AiError)), Effect.orDie)

/** The tokens `steps` used together. */
const usageOf = (steps: ReadonlyArray<Response.FinishPart>) => {
  const sum = (tokens: (usage: Response.Usage) => number | undefined) =>
    steps.reduce<number | undefined>((total, step) => {
      const used = tokens(step.usage)
      return used === undefined ? total : (total ?? 0) + used
    }, undefined)
  return new Response.Usage({
    inputTokens: {
      uncached: sum((usage) => usage.inputTokens.uncached),
      total: sum((usage) => usage.inputTokens.total),
      cacheRead: sum((usage) => usage.inputTokens.cacheRead),
      cacheWrite: sum((usage) => usage.inputTokens.cacheWrite)
    },
    outputTokens: {
      total: sum((usage) => usage.outputTokens.total),
      text: sum((usage) => usage.outputTokens.text),
      reasoning: sum((usage) => usage.outputTokens.reasoning)
    }
  })
}
