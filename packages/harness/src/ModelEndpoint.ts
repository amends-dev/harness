/**
 * A model endpoint is how an agent reaches a model: the API the model is served through, where that
 * API is, the key a request presents, and how hard the model works. A host makes an endpoint for
 * each model an agent may use, from what it knows of the model and of the account it uses it under,
 * and an agent's adapter turns endpoints into what its agent takes: an agent in the host's process
 * makes an Effect AI language model of each, and an agent in a sandbox is configured with them.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * The API a model is served through: Anthropic's Messages API, OpenAI's Responses API, or the Chat
 * Completions API that OpenAI defined and most providers serve.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Protocol = Schema.Literals(["anthropic-messages", "openai-responses", "openai-chat"])

/**
 * @category schemas
 * @since 0.1.0
 */
export type Protocol = typeof Protocol.Type

/**
 * How hard a model reasons before it answers, from least to most, as providers name the levels.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Effort = Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh", "max"])

/**
 * @category schemas
 * @since 0.1.0
 */
export type Effort = typeof Effort.Type

/**
 * How an agent reaches one model.
 *
 * **Example** (An endpoint for a model at Anthropic)
 *
 * ```ts
 * import { ModelEndpoint } from "@amends-dev/harness"
 * import { Redacted } from "effect"
 *
 * const sonnet: ModelEndpoint.ModelEndpoint = {
 *   provider: "anthropic",
 *   model: "claude-sonnet-4-5",
 *   protocol: "anthropic-messages",
 *   url: "https://api.anthropic.com/v1",
 *   apiKey: Redacted.make(process.env.ANTHROPIC_API_KEY ?? ""),
 *   effort: "medium",
 *   contextWindow: 200_000
 * }
 * ```
 *
 * @category schemas
 * @since 0.1.0
 */
export const ModelEndpoint = Schema.Struct({
  /**
   * Names the model's provider, such as `anthropic`, as models.dev names providers. An agent that
   * knows providers by name, as opencode does, finds the provider by it.
   */
  provider: Schema.NonEmptyString,

  /** The provider's id for the model, which requests name it by. */
  model: Schema.NonEmptyString,

  /** The API the model is served through. */
  protocol: Protocol,

  /**
   * The base URL of the API, which the protocol's paths follow: such as
   * `https://api.anthropic.com/v1` for `/messages`, or `https://api.openai.com/v1` for `/responses`
   * and `/chat/completions`.
   */
  url: Schema.String,

  /** The key a request presents, as the protocol presents keys. Absent for an API without one. */
  apiKey: Schema.optionalKey(Schema.Redacted(Schema.String)),

  /**
   * Headers a request carries besides the key, which a gateway in front of the provider asks for,
   * such as its own authorization. Absent when the API asks for none.
   */
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Redacted(Schema.String))),

  /** How hard the model reasons. Absent for the provider's default. */
  effort: Schema.optionalKey(Effort),

  /** The most tokens the model writes in a response. Absent for the provider's default. */
  maxOutputTokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),

  /**
   * The most tokens a request to the model holds, what it reads and writes together: its context
   * window, which an agent compacts its conversation to stay within. Absent when unknown.
   */
  contextWindow: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0)))
})

/**
 * @category schemas
 * @since 0.1.0
 */
export interface ModelEndpoint extends Schema.Schema.Type<typeof ModelEndpoint> {}
