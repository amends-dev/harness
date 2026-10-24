/** Translates SDK messages, retaining step boundaries until their tools have answered. */

import type { StreamPart } from "@amends-dev/harness"
import type { SDKMessage, SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk"
import type * as Response from "effect/ai/Response"

interface Tokens {
  readonly input_tokens?: number | null | undefined
  readonly output_tokens?: number | undefined
  readonly cache_read_input_tokens?: number | null | undefined
  readonly cache_creation_input_tokens?: number | null | undefined
}
export const usageOf = (tokens: Tokens): typeof Response.Usage.Encoded => ({
  inputTokens: {
    total:
      (tokens.input_tokens ?? 0) + (tokens.cache_read_input_tokens ?? 0) + (tokens.cache_creation_input_tokens ?? 0),
    uncached: tokens.input_tokens ?? 0,
    cacheRead: tokens.cache_read_input_tokens ?? 0,
    cacheWrite: tokens.cache_creation_input_tokens ?? 0
  },
  outputTokens: { total: tokens.output_tokens ?? 0 }
})
const reasonOf = (reason: string | null): Response.FinishReason =>
  reason === "end_turn" || reason === "stop_sequence"
    ? "stop"
    : reason === "tool_use"
      ? "tool-calls"
      : reason === "max_tokens"
        ? "length"
        : "other"

export interface Turn {
  readonly consume: (message: SDKMessage) => ReadonlyArray<StreamPart.StreamPart>
  readonly call: (id: string, name: string, params: unknown) => ReadonlyArray<StreamPart.StreamPart>
  readonly compact: (part: StreamPart.CompactionPart) => ReadonlyArray<StreamPart.StreamPart>
}

/** One translator per turn. It also accepts permission callbacks that arrive before SDK messages. */
export const make = (hostTools: ReadonlySet<string>, json: boolean): Turn => {
  const calls = new Map<string, string>()
  const answered = new Set<string>()
  const streamed = new Set<string>()
  const blocks = new Map<
    number,
    { readonly type: "text" | "reasoning"; readonly id: string; readonly signature?: string }
  >()
  let messageId = ""
  let tokens: Tokens = {}
  let reason: Response.FinishReason = "other"
  let open = false
  let written = false
  let failed = false

  const closeStep = (): Array<StreamPart.StreamPart> => {
    if (!open) return []
    open = false
    return [{ type: "finish-step", reason: failed ? "error" : reason, usage: usageOf(tokens) }]
  }
  const call = (id: string, name: string, params: unknown): Array<StreamPart.StreamPart> => {
    if (calls.has(id)) return []
    calls.set(id, name)
    return hostTools.has(name) ? [] : [{ type: "tool-call", id, name, params, providerExecuted: true }]
  }
  const partial = (event: SDKPartialAssistantMessage["event"]): Array<StreamPart.StreamPart> => {
    switch (event.type) {
      case "message_start": {
        const parts = closeStep()
        messageId = event.message.id
        streamed.add(messageId)
        tokens = event.message.usage
        reason = "other"
        open = true
        blocks.clear()
        return parts
      }
      case "content_block_start": {
        const block = event.content_block
        const type = block.type === "text" ? "text" : block.type === "thinking" ? "reasoning" : undefined
        if (type === undefined) return []
        const id = `${messageId}:${event.index}`
        blocks.set(event.index, { type, id })
        if (type === "text") written = true
        return [{ type: type === "text" ? "text-start" : "reasoning-start", id }]
      }
      case "content_block_delta": {
        const block = blocks.get(event.index)
        if (block === undefined) return []
        if (event.delta.type === "text_delta") return [{ type: "text-delta", id: block.id, delta: event.delta.text }]
        if (event.delta.type === "thinking_delta")
          return [{ type: "reasoning-delta", id: block.id, delta: event.delta.thinking }]
        if (event.delta.type === "signature_delta")
          blocks.set(event.index, { ...block, signature: event.delta.signature })
        return []
      }
      case "content_block_stop": {
        const block = blocks.get(event.index)
        if (block === undefined) return []
        blocks.delete(event.index)
        return [
          {
            type: block.type === "text" ? "text-end" : "reasoning-end",
            id: block.id,
            ...(block.signature === undefined ? {} : { metadata: { anthropic: { signature: block.signature } } })
          }
        ]
      }
      case "message_delta":
        tokens = {
          input_tokens: event.usage.input_tokens ?? tokens.input_tokens,
          output_tokens: event.usage.output_tokens,
          cache_read_input_tokens: event.usage.cache_read_input_tokens ?? tokens.cache_read_input_tokens,
          cache_creation_input_tokens: event.usage.cache_creation_input_tokens ?? tokens.cache_creation_input_tokens
        }
        reason = reasonOf(event.delta.stop_reason)
        return []
      case "message_stop":
        // The tool-result messages follow message_stop. End this step at the next response.
        return []
    }
  }
  const text = (id: string, value: string): Array<StreamPart.StreamPart> => [
    { type: "text-start", id },
    { type: "text-delta", id, delta: value },
    { type: "text-end", id }
  ]
  return {
    call,
    compact: (part) => [...closeStep(), part],
    consume: (message) => {
      if ("parent_tool_use_id" in message && message.parent_tool_use_id !== null) return []
      switch (message.type) {
        case "stream_event":
          return partial(message.event)
        case "assistant": {
          const parts: Array<StreamPart.StreamPart> = []
          if (!streamed.has(message.message.id)) {
            if (messageId !== message.message.id) parts.push(...closeStep())
            messageId = message.message.id
            open = true
            tokens = message.message.usage
            reason = reasonOf(message.message.stop_reason)
          }
          if (message.error !== undefined) {
            failed = true
            parts.push({ type: "error", error: { type: message.error } })
          }
          for (const [index, block] of message.message.content.entries()) {
            if (block.type === "tool_use") parts.push(...call(block.id, block.name, block.input))
            if (streamed.has(message.message.id)) continue
            const id = `${message.uuid}:${index}`
            if (block.type === "text") {
              written = true
              parts.push(...text(id, block.text))
            }
            if (block.type === "thinking")
              parts.push(
                { type: "reasoning-start", id },
                { type: "reasoning-delta", id, delta: block.thinking },
                { type: "reasoning-end", id, metadata: { anthropic: { signature: block.signature } } }
              )
          }
          return parts
        }
        case "user": {
          const parts: Array<StreamPart.StreamPart> = []
          if (typeof message.message.content === "string") return parts
          for (const block of message.message.content) {
            if (block.type !== "tool_result" || answered.has(block.tool_use_id)) continue
            const name = calls.get(block.tool_use_id)
            if (name === undefined || hostTools.has(name)) continue
            answered.add(block.tool_use_id)
            parts.push({
              type: "tool-result",
              id: block.tool_use_id,
              name,
              result: block.content ?? "",
              isFailure: block.is_error ?? false,
              providerExecuted: true
            })
          }
          return parts
        }
        case "result": {
          const parts: Array<StreamPart.StreamPart> = []
          const error = message.is_error || message.subtype !== "success"
          const finishReason = error ? "error" : reasonOf(message.stop_reason)
          if (error && !failed)
            parts.push({ type: "error", error: message.subtype === "success" ? message.result : message.errors })
          failed ||= error
          reason = finishReason
          parts.push(...closeStep())
          if (message.subtype === "success" && !error) {
            if (json) {
              if (message.structured_output === undefined) {
                failed = true
                parts.push({ type: "error", error: "Claude completed without the requested structured output" })
              } else {
                parts.push(...text("structured-output", JSON.stringify(message.structured_output)), {
                  type: "finish-step",
                  reason: "stop",
                  usage: usageOf({})
                })
              }
            } else if (!written && message.result !== "") {
              parts.push(...text("result", message.result), {
                type: "finish-step",
                reason: finishReason,
                usage: usageOf(message.usage)
              })
            }
          }
          parts.push({ type: "finish", reason: failed ? "error" : finishReason, usage: usageOf(message.usage) })
          return parts
        }
        default:
          return []
      }
    }
  }
}
