/**
 * What opencode 1 is prompted with: the parts of a turn's prompt, and a conversation started on
 * another agent, which opencode 1 has no way to record as its own steps. The conversation is
 * written instead as one message of the session that the model reads and does not answer: each
 * message as who wrote it and what it said, the tools called with their results, and the files
 * the user gave attached as they were.
 */

import type * as Prompt from "effect/ai/Prompt"
import * as Base64 from "effect/encoding/Base64"
import type { PromptPart } from "./api.ts"

/** The parts of a user message, as opencode 1 takes them: its texts, and its files by URL. */
export const promptPartsOf = (message: Prompt.UserMessage): ReadonlyArray<PromptPart> =>
  message.content.map((part) => (part.type === "text" ? { type: "text", text: part.text } : filePartOf(part)))

/**
 * The parts that record `conversation` in a session that has no record of it: its messages written
 * out as one text, which opencode marks as written for the model rather than by the user, and the
 * files of its user messages. Nothing for an empty conversation.
 */
export const conversationPartsOf = (conversation: Prompt.Prompt): ReadonlyArray<PromptPart> => {
  if (conversation.content.length === 0) return []
  const lines: Array<string> = []
  const files: Array<PromptPart> = []
  for (const message of conversation.content) {
    switch (message.role) {
      case "system":
        lines.push(`System: ${message.content}`)
        break
      case "user":
        for (const part of message.content) {
          if (part.type === "text") {
            lines.push(`User: ${part.text}`)
          } else {
            lines.push(`User attached ${nameOf(part)}.`)
            files.push(filePartOf(part))
          }
        }
        break
      case "assistant":
        for (const part of message.content) {
          switch (part.type) {
            case "text":
              lines.push(`Assistant: ${part.text}`)
              break
            case "file":
              lines.push(`Assistant wrote ${nameOf(part)}.`)
              break
            case "tool-call":
              lines.push(`Assistant called the tool ${part.name} with ${JSON.stringify(part.params)}.`)
              break
            case "tool-result":
              lines.push(resultLineOf(part))
              break
            // Reasoning was the model's own, and an approval request is answered by a result.
            case "reasoning":
            case "tool-approval-request":
              break
          }
        }
        break
      case "tool":
        for (const part of message.content) {
          if (part.type === "tool-result") lines.push(resultLineOf(part))
        }
        break
    }
  }
  const text = ["This conversation continues one held earlier, which went as follows.", "", ...lines].join("\n")
  return [{ type: "text", text, synthetic: true }, ...files]
}

const resultLineOf = (part: Prompt.ToolResultPart) =>
  `The tool ${part.name} ${part.isFailure ? "failed with" : "returned"} ${
    typeof part.result === "string" ? part.result : JSON.stringify(part.result)
  }.`

const nameOf = (part: Prompt.FilePart) =>
  part.fileName === undefined ? `a file of type ${part.mediaType}` : `the file ${part.fileName}`

/**
 * A file as opencode 1 takes it, by URL: a URL as it is, and data, or a string of data in base64,
 * as a `data:` URL.
 */
const filePartOf = (part: Prompt.FilePart): PromptPart => {
  const { data, mediaType } = part
  const url =
    data instanceof URL
      ? data.href
      : typeof data === "string"
        ? /^(data|https?):/.test(data)
          ? data
          : `data:${mediaType};base64,${data}`
        : `data:${mediaType};base64,${Base64.encode(data)}`
  return {
    type: "file",
    mime: mediaType,
    url,
    ...(part.fileName === undefined ? {} : { filename: part.fileName })
  }
}
