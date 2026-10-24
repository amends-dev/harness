/**
 * What both versions of opencode report of a step the same way: the tokens it used, and why it
 * ended, which become the usage and the finish reason of the harness's `finish-step` and `finish`
 * parts.
 */

import * as Response from "effect/ai/Response"
import * as Schema from "effect/Schema"

/** The tokens of a step, as opencode counts them. */
export const Tokens = Schema.Struct({
  input: Schema.Int,
  output: Schema.Int,
  reasoning: Schema.Int,
  cache: Schema.Struct({ read: Schema.Int, write: Schema.Int })
})

export type Tokens = typeof Tokens.Type

/** The tokens of no step. */
export const noTokens: Tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

export const addTokens = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  reasoning: a.reasoning + b.reasoning,
  cache: { read: a.cache.read + b.cache.read, write: a.cache.write + b.cache.write }
})

/**
 * Tokens as Effect AI counts them. opencode counts input without cached tokens, and output
 * without reasoning.
 */
export const usageOf = (tokens: Tokens): typeof Response.Usage.Encoded => ({
  inputTokens: {
    uncached: tokens.input,
    total: tokens.input + tokens.cache.read + tokens.cache.write,
    cacheRead: tokens.cache.read,
    cacheWrite: tokens.cache.write
  },
  outputTokens: {
    total: tokens.output + tokens.reasoning,
    text: tokens.output,
    reasoning: tokens.reasoning
  }
})

/** A finish reason as Effect AI names it, which opencode's share; any other reads as `other`. */
export const finishReasonOf = (finish: string): Response.FinishReason =>
  Schema.is(Response.FinishReason)(finish) ? finish : "other"
