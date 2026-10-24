/**
 * What `generate` returns: a whole turn, with the parts it streamed and getters for what callers
 * usually read, as Effect AI's `GenerateTextResponse` has for one model response. A turn takes one
 * or more steps, each one response from the model and the tools it called, and the turn's answer
 * is the text of its last step. `generateObject` returns `GenerateObjectResult`, which adds the
 * object that answer decoded to.
 *
 * @since 0.1.0
 */

import type * as Response from "effect/ai/Response"
import * as StreamPart from "./StreamPart.ts"

/**
 * A whole turn, as `Session.generate` returns it.
 *
 * **Example** (Reading a turn's answer and what it did)
 *
 * ```ts
 * import { Session } from "@amends-dev/harness"
 * import { Effect } from "effect"
 *
 * declare const session: Session.Session
 *
 * const program = Effect.gen(function* () {
 *   const result = yield* session.generate({
 *     prompt: "Rename the module and update its imports"
 *   })
 *   return {
 *     answer: result.text,
 *     steps: result.steps.length,
 *     changed: result.fileChanges.map((change) => change.path),
 *     reason: result.finishReason
 *   }
 * })
 * ```
 *
 * @category models
 * @since 0.1.0
 */
export class GenerateResult {
  /** Every part the turn streamed, in order. */
  readonly parts: ReadonlyArray<StreamPart.StreamPart>

  constructor(parts: ReadonlyArray<StreamPart.StreamPart>) {
    this.parts = parts
  }

  /** The turn's steps, each with the parts it streamed added up and how it finished. */
  get steps(): ReadonlyArray<StreamPart.Step> {
    return StreamPart.stepsOf(this.parts)
  }

  /** The text of the turn's last step: its answer, without what the agent said while it worked. */
  get text(): string {
    const lastStep = this.steps.findLast((step) => step.parts.length > 0)
    return (lastStep?.parts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
  }

  /** Every tool call of the turn, of the agent's own tools and the host's. */
  get toolCalls(): ReadonlyArray<Response.ToolCallPartEncoded> {
    return this.parts.filter((part) => part.type === "tool-call")
  }

  /** Every tool result of the turn, preliminary ones included. */
  get toolResults(): ReadonlyArray<Response.ToolResultPartEncoded> {
    return this.parts.filter((part) => part.type === "tool-result")
  }

  /** The files the agent reported creating, modifying, or deleting. */
  get fileChanges(): ReadonlyArray<StreamPart.FileChangePart> {
    return this.parts.filter((part) => part.type === "file-change")
  }

  /** Why the turn ended, or `unknown` when it streamed no `finish` part. */
  get finishReason(): Response.FinishReason {
    return this.parts.find((part) => part.type === "finish")?.reason ?? "unknown"
  }

  /** The tokens the whole turn used, across its steps. */
  get usage(): typeof Response.Usage.Encoded {
    return (
      this.parts.find((part) => part.type === "finish")?.usage ?? {
        inputTokens: {},
        outputTokens: {}
      }
    )
  }
}

/**
 * What `Session.generateObject` returns: the turn, and the object its answer decoded to.
 *
 * @category models
 * @since 0.1.0
 */
export class GenerateObjectResult<A> extends GenerateResult {
  /** The object the turn's answer decoded to. */
  readonly value: A

  constructor(value: A, parts: ReadonlyArray<StreamPart.StreamPart>) {
    super(parts)
    this.value = value
  }
}
