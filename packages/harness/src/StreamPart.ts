/**
 * The parts a harness streams for a turn. They are the parts an Effect AI language model provider
 * streams, in the encoded form `LanguageModel.make` takes from providers, and four that only an
 * agent produces: a turn starting apart from the host, a step finishing, a file changing, and the
 * conversation being compacted. Code that reads a provider's stream reads a harness's, and the
 * parts cross the sandbox boundary as they are.
 *
 * Tool calls and results name any tool and keep its params and result as they came. An agent runs
 * tools of its own that no toolkit declares, while Effect AI's decoded tool parts exist only for
 * the tools of a toolkit. Params and results are therefore `unknown`, as JSON, even for the host's
 * tools; a caller that needs their types decodes them with the tool's schemas.
 *
 * @since 0.1.0
 */

import * as Prompt from "effect/ai/Prompt"
import * as Response from "effect/ai/Response"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

/** A call to any tool. The agent's own tools run inside the agent and are `providerExecuted`. */
const ToolCallPart = Schema.Struct({
  type: Schema.tag("tool-call"),
  id: Schema.String,
  name: Schema.String,
  params: Schema.Unknown,
  providerExecuted: Schema.optional(Schema.Boolean),
  metadata: Schema.optional(Response.ProviderMetadata)
})

/** The result of a call to any tool, which failed when `isFailure` is set. */
const ToolResultPart = Schema.Struct({
  type: Schema.tag("tool-result"),
  id: Schema.String,
  name: Schema.String,
  result: Schema.Unknown,
  isFailure: Schema.Boolean,
  providerExecuted: Schema.optional(Schema.Boolean),
  preliminary: Schema.optional(Schema.Boolean),
  metadata: Schema.optional(Response.ProviderMetadata)
})

/**
 * Ends one step of a turn: one response from the model and the tool calls it made. A turn takes
 * one or more steps, and its `finish` part reports the whole turn's usage.
 *
 * @category schemas
 * @since 0.1.0
 */
export const FinishStepPart = Schema.Struct({
  type: Schema.tag("finish-step"),
  reason: Response.FinishReason,
  usage: Schema.toEncoded(Response.Usage),
  metadata: Schema.optional(Response.ProviderMetadata)
})

/**
 * @category schemas
 * @since 0.1.0
 */
export interface FinishStepPart extends Schema.Schema.Type<typeof FinishStepPart> {}

/**
 * Reports that the agent created, modified, or deleted a file in the sandbox.
 *
 * @category schemas
 * @since 0.1.0
 */
export const FileChangePart = Schema.Struct({
  type: Schema.tag("file-change"),
  event: Schema.Literals(["create", "modify", "delete"]),
  path: Schema.String,
  metadata: Schema.optional(Response.ProviderMetadata)
})

/**
 * @category schemas
 * @since 0.1.0
 */
export interface FileChangePart extends Schema.Schema.Type<typeof FileChangePart> {}

/**
 * Reports that the agent replaced its conversation so far with a summary, because it was asked to
 * (`manual`) or because the conversation outgrew its context (`auto`).
 *
 * **Details**
 *
 * The conversation goes on from the summary and the messages the agent kept, in place of everything
 * before the compaction, as `Session.recordStep` records it. An agent that compacts during a turn
 * streams the compaction between two steps, so that it starts the step after;
 * `AgentSession.compact` returns one made between turns.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CompactionPart = Schema.Struct({
  type: Schema.tag("compaction"),
  trigger: Schema.Literals(["manual", "auto"]),

  /** What the conversation before `kept` said. */
  summary: Schema.String,

  /**
   * The latest messages before the compaction, which the conversation keeps as they were after the
   * summary, as the conversation records them, in their encoded form. None when the summary covers
   * everything.
   */
  kept: Schema.optional(Schema.Array(Schema.toEncoded(Prompt.Message))),
  tokensBefore: Schema.optional(Schema.Int),
  tokensAfter: Schema.optional(Schema.Int),
  metadata: Schema.optional(Response.ProviderMetadata)
})

/**
 * @category schemas
 * @since 0.1.0
 */
export interface CompactionPart extends Schema.Schema.Type<typeof CompactionPart> {}

/**
 * Starts a turn that runs apart from the host, as in a sandbox, with what `createSession` takes as
 * the unfinished turn's `agentState`.
 *
 * **Details**
 *
 * A caller that keeps it continues the turn with `continueStream` once the host that ran it is
 * gone, catching up on the steps it does not have.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TurnStartPart = Schema.Struct({
  type: Schema.tag("turn-start"),
  agentState: Schema.Json
})

/**
 * @category schemas
 * @since 0.1.0
 */
export interface TurnStartPart extends Schema.Schema.Type<typeof TurnStartPart> {}

/**
 * A part of a turn's stream: an Effect AI provider's part in its encoded form, or one of the four
 * only an agent produces.
 *
 * @category schemas
 * @since 0.1.0
 */
export const StreamPart = Schema.Union([
  Schema.toEncoded(Response.TextStartPart),
  Schema.toEncoded(Response.TextDeltaPart),
  Schema.toEncoded(Response.TextEndPart),
  Schema.toEncoded(Response.ReasoningStartPart),
  Schema.toEncoded(Response.ReasoningDeltaPart),
  Schema.toEncoded(Response.ReasoningEndPart),
  Schema.toEncoded(Response.ToolParamsStartPart),
  Schema.toEncoded(Response.ToolParamsDeltaPart),
  Schema.toEncoded(Response.ToolParamsEndPart),
  ToolCallPart,
  ToolResultPart,
  Schema.toEncoded(Response.ToolApprovalRequestPart),
  Schema.toEncoded(Response.FilePart),
  Schema.toEncoded(Response.DocumentSourcePart),
  Schema.toEncoded(Response.UrlSourcePart),
  Schema.toEncoded(Response.ResponseMetadataPart),
  Schema.toEncoded(Response.FinishPart),
  Schema.toEncoded(Response.ErrorPart),
  FinishStepPart,
  FileChangePart,
  CompactionPart,
  TurnStartPart
]) satisfies Schema.Codec<Response.StreamPartEncoded | FinishStepPart | FileChangePart | CompactionPart | TurnStartPart>

/**
 * @category schemas
 * @since 0.1.0
 */
export type StreamPart = Superset<typeof StreamPart.Type, Response.StreamPartEncoded>

/**
 * `Whole`, which the compiler checks contains every `Subset`, so that a part Effect AI adds cannot
 * go missing from `StreamPart`.
 */
type Superset<Whole, Subset extends Whole> = Whole | Subset

/**
 * A part of a step as the step's stream adds up: a text or a reasoning whole rather than its
 * deltas, a tool call without the params it streamed on its way, and a tool's final result.
 *
 * **Details**
 *
 * These are the parts Effect AI's `generateText` returns for a response, and those only an agent
 * produces.
 *
 * @category schemas
 * @since 0.1.0
 */
export const StepPart = Schema.Union([
  Schema.toEncoded(Response.TextPart),
  Schema.toEncoded(Response.ReasoningPart),
  ToolCallPart,
  ToolResultPart,
  Schema.toEncoded(Response.ToolApprovalRequestPart),
  Schema.toEncoded(Response.FilePart),
  Schema.toEncoded(Response.DocumentSourcePart),
  Schema.toEncoded(Response.UrlSourcePart),
  Schema.toEncoded(Response.ResponseMetadataPart),
  Schema.toEncoded(Response.ErrorPart),
  FileChangePart,
  CompactionPart
])

/**
 * @category schemas
 * @since 0.1.0
 */
export type StepPart = typeof StepPart.Type

/**
 * One step of a turn: what the model wrote, the tools it called and their results, in the order the
 * step streamed them, and the `finish-step` part that ended it.
 *
 * **Details**
 *
 * A step the turn ended partway through, by failing or being stopped, has what it streamed so far
 * and no `finish`. A step is JSON, for callers that store a turn's steps.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Step = Schema.Struct({
  parts: Schema.Array(StepPart),
  finish: Schema.optional(FinishStepPart)
})

/**
 * @category schemas
 * @since 0.1.0
 */
export interface Step extends Schema.Schema.Type<typeof Step> {}

/**
 * A turn's steps, from its parts as far as they go, split at their `finish-step` parts.
 *
 * **Details**
 *
 * The turn's `finish` part ends the turn rather than a step, so no step holds it. A step the parts
 * end before its `finish-step` comes last when it has parts.
 *
 * **Example** (Adding a turn's parts up into steps)
 *
 * ```ts
 * import { StreamPart } from "@amends-dev/harness"
 *
 * const steps = StreamPart.stepsOf([
 *   { type: "text-start", id: "answer" },
 *   { type: "text-delta", id: "answer", delta: "Hello, " },
 *   { type: "text-delta", id: "answer", delta: "world." },
 *   { type: "text-end", id: "answer" },
 *   { type: "finish-step", reason: "stop", usage: { inputTokens: {}, outputTokens: {} } },
 *   { type: "finish", reason: "stop", usage: { inputTokens: {}, outputTokens: {} } }
 * ])
 * // steps[0].parts is [{ type: "text", text: "Hello, world." }]
 * ```
 *
 * @category getters
 * @since 0.1.0
 */
export const stepsOf = (parts: ReadonlyArray<StreamPart>): ReadonlyArray<Step> => {
  const steps: Array<Step> = []
  let stepParts: Array<StreamPart> = []
  for (const part of parts) {
    if (part.type === "finish-step") {
      steps.push({ parts: addUpStep(stepParts), finish: part })
      stepParts = []
    } else if (part.type !== "finish") {
      stepParts.push(part)
    }
  }
  const unfinished = addUpStep(stepParts)
  return unfinished.length === 0 ? steps : [...steps, { parts: unfinished }]
}

/**
 * Drops the parts of a turn's first `steps` steps, for an agent whose turn kept running to stream
 * it again from the step after those the harness already has, as `continueTurn` asks.
 *
 * @category filtering
 * @since 0.1.0
 */
export const afterSteps = (steps: number) =>
  Stream.mapAccum(
    () => 0,
    (finished: number, part: StreamPart) =>
      [part.type === "finish-step" ? finished + 1 : finished, finished < steps ? [] : [part]] as const
  )

/**
 * The parts of one step as they add up. A text or a reasoning sits where it started, with the
 * deltas it has so far and the metadata of its parts merged, as Effect AI merges them; deltas of
 * one that never started are dropped, as Effect AI drops them. A tool's params stream in its call,
 * which holds them whole, and its preliminary results give way to the final one.
 */
const addUpStep = (parts: ReadonlyArray<StreamPart>): Array<StepPart> => {
  const added: Array<StepPart> = []
  /** Each text or reasoning the step is writing, by kind and id, until it ends. */
  const writing = new Map<string, Writing>()
  for (const part of parts) {
    switch (part.type) {
      case "text-start":
      case "reasoning-start": {
        const type = part.type === "text-start" ? "text" : "reasoning"
        const written: Writing = { type, text: "", ...metadataOf(part.metadata) }
        writing.set(`${type}:${part.id}`, written)
        added.push(written)
        break
      }
      case "text-delta":
      case "text-end":
      case "reasoning-delta":
      case "reasoning-end": {
        const key = `${part.type.startsWith("text") ? "text" : "reasoning"}:${part.id}`
        const written = writing.get(key)
        if (written === undefined) break
        if (part.type === "text-delta" || part.type === "reasoning-delta") {
          written.text += part.delta
        } else {
          writing.delete(key)
        }
        Object.assign(written, metadataOf(mergeMetadata(written.metadata, part.metadata)))
        break
      }
      case "tool-params-start":
      case "tool-params-delta":
      case "tool-params-end":
      case "finish-step":
      case "finish":
      case "turn-start":
        break
      case "tool-result":
        if (part.preliminary !== true) added.push(part)
        break
      default:
        added.push(part)
    }
  }
  return added
}

/** A text or a reasoning of a step, which grows as its deltas arrive. */
interface Writing {
  readonly type: "text" | "reasoning"
  text: string
  metadata?: Response.ProviderMetadata
}

/** `metadata` as a part's field, which a part without any leaves out. */
const metadataOf = (metadata: Response.ProviderMetadata | undefined) => (metadata === undefined ? {} : { metadata })

/** What `left` says of each provider, with what `right` says merged in, as Effect AI merges it. */
const mergeMetadata = (
  left: Response.ProviderMetadata | undefined,
  right: Response.ProviderMetadata | undefined
): Response.ProviderMetadata | undefined => {
  if (right === undefined) return left
  const merged = { ...left }
  for (const [provider, metadata] of Object.entries(right)) {
    const previous = merged[provider]
    merged[provider] =
      Predicate.isObject(previous) && Predicate.isObject(metadata) ? Object.assign({}, previous, metadata) : metadata
  }
  return merged
}
