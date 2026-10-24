/** Prompts and portable conversation history as Codex's Responses items. */

import type * as Prompt from "effect/ai/Prompt"
import * as Effect from "effect/Effect"
import * as Base64 from "effect/encoding/Base64"
import type * as Schema from "effect/Schema"
import { unsupported } from "../errors.ts"

export const inputOf = Effect.fn("CodexPrompt.inputOf")(function* (message: Prompt.UserMessage) {
  const input: Array<Schema.Json> = []
  for (const part of message.content) {
    if (part.type === "text") {
      input.push({ type: "text", text: part.text, text_elements: [] })
    } else {
      if (!part.mediaType.startsWith("image/")) {
        return yield* unsupported(`Codex supports image attachments, not ${part.mediaType}`)
      }
      input.push({ type: "image", url: fileUrl(part) })
    }
  }
  return input
})

/** Tool calls are preserved in order; private model reasoning and approval bookkeeping are omitted. */
export const historyOf = Effect.fn("CodexPrompt.historyOf")(function* (history: Prompt.Prompt) {
  const items: Array<Schema.Json> = []
  for (const message of history.content) {
    if (message.role === "system") {
      items.push({ type: "message", role: "developer", content: [{ type: "input_text", text: message.content }] })
    } else {
      for (const part of message.content) {
        switch (part.type) {
          case "text":
            items.push({
              type: "message",
              role: message.role,
              content: [{ type: message.role === "assistant" ? "output_text" : "input_text", text: part.text }]
            })
            break
          case "file":
            if (message.role !== "user" || !part.mediaType.startsWith("image/")) {
              return yield* unsupported("Codex imports only user image attachments in history")
            }
            items.push({ type: "message", role: "user", content: [{ type: "input_image", image_url: fileUrl(part) }] })
            break
          case "tool-call":
            items.push({
              type: "function_call",
              name: part.name,
              call_id: part.id,
              arguments: JSON.stringify(part.params)
            })
            break
          case "tool-result":
            items.push({
              type: "function_call_output",
              call_id: part.id,
              output: JSON.stringify({ result: part.result, isFailure: part.isFailure })
            })
            break
          case "reasoning":
          case "tool-approval-request":
          case "tool-approval-response":
            break
        }
      }
    }
  }
  return items
})

const fileUrl = ({ data, mediaType }: Prompt.FilePart): string =>
  data instanceof URL
    ? data.href
    : typeof data === "string"
      ? /^(data|https?):/.test(data)
        ? data
        : `data:${mediaType};base64,${data}`
      : `data:${mediaType};base64,${Base64.encode(data)}`
