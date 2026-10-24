/**
 * What opencode 2 is prompted with: a turn's prompt, and a conversation started on another agent,
 * written as the messages opencode records for a session so that it goes on in opencode as its
 * own. Each user message is a prompt, each system message an update of the model's instructions,
 * and each assistant message a step, its tool calls with the results of the tool messages after
 * it. The tools need not be opencode's own. The steps name the model `amends/history`, because a
 * conversation does not say which model answered; opencode reads them whichever model they name.
 *
 * opencode 2 takes files as data, so a file given at a URL other than a `data:` or `file:` URL
 * fails with `UnsupportedError`.
 */

import { HarnessError } from "@amends-dev/harness"
import type * as Prompt from "effect/ai/Prompt"
import * as Base64 from "effect/encoding/Base64"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type { ModelRef } from "../driver.ts"
import { ToolContent } from "./event.ts"

/** A prompt as opencode 2 takes it: its text, and its files by URL. */
export interface PromptInput {
  readonly text: string
  readonly files?: ReadonlyArray<{ readonly uri: string; readonly name?: string }>
}

/** A file of a recorded prompt, its data in base64. */
interface RecordedFile {
  readonly data: string
  readonly mime: string
  readonly source: { readonly type: "inline" }
  readonly name?: string
}

type ToolState =
  | {
      readonly status: "completed"
      readonly input: Record<string, unknown>
      readonly content: ReadonlyArray<ToolContent>
    }
  | {
      readonly status: "error"
      readonly input: Record<string, unknown>
      readonly error: { readonly type: string; readonly message: string }
    }

type AssistantContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool"
      readonly id: string
      readonly name: string
      readonly executed: boolean
      readonly state: ToolState
      readonly time: { readonly created: number; readonly completed: number }
    }

/** A message as opencode 2 records it for a session. */
export type Message =
  | {
      readonly type: "user"
      readonly id: string
      readonly time: { readonly created: number }
      readonly text: string
      readonly files?: ReadonlyArray<RecordedFile>
    }
  | {
      readonly type: "system"
      readonly id: string
      readonly time: { readonly created: number }
      readonly text: string
    }
  | {
      readonly type: "assistant"
      readonly id: string
      readonly time: { readonly created: number; readonly completed: number }
      readonly agent: string
      readonly model: ModelRef
      readonly content: ReadonlyArray<AssistantContent>
      readonly finish: "stop" | "tool-calls"
    }

/**
 * The prompt of a user message, as opencode 2 takes it: its texts, and its files as `data:` URLs.
 * Fails with `UnsupportedError` for a file at another URL.
 */
export const promptOf = (message: Prompt.UserMessage): Result.Result<PromptInput, HarnessError.UnsupportedError> => {
  const files: Array<{ readonly uri: string; readonly name?: string }> = []
  for (const part of message.content) {
    if (part.type !== "file") continue
    const uri = uriOf(part)
    if (uri === undefined) return Result.fail(unsupportedFile(part))
    files.push({ uri, ...(part.fileName === undefined ? {} : { name: part.fileName }) })
  }
  return Result.succeed({
    text: textOf(message),
    ...(files.length === 0 ? {} : { files })
  })
}

/** What the messages of a written conversation are recorded with. */
export interface Recording {
  /** The session the messages are recorded for, whose id makes theirs unique to it. */
  readonly sessionID: string

  /** When the messages are written, in milliseconds since the epoch. */
  readonly now: number
}

/**
 * The messages that record `conversation` in a new session. Fails with `UnsupportedError` for a
 * conversation opencode cannot record.
 */
export const messagesOf = (
  conversation: Prompt.Prompt,
  recording: Recording
): Result.Result<ReadonlyArray<Message>, HarnessError.UnsupportedError> => {
  const unsupported = unsupportedIn(conversation)
  if (unsupported !== undefined) {
    return Result.fail(new HarnessError.UnsupportedError({ description: unsupported }))
  }
  const results = resultsOf(conversation)
  const time = { created: recording.now }
  const messages: Array<Message> = []
  for (const [index, message] of conversation.content.entries()) {
    const id = opencodeId("msg", recording, index + 1)
    switch (message.role) {
      case "system":
        messages.push({ type: "system", id, time, text: message.content })
        break
      case "user": {
        const files = message.content.flatMap((part) => {
          const file = part.type === "file" ? recordedFileOf(part) : undefined
          return file === undefined ? [] : [file]
        })
        messages.push({
          type: "user",
          id,
          time,
          text: textOf(message),
          ...(files.length === 0 ? {} : { files })
        })
        break
      }
      case "assistant": {
        const content = message.content.flatMap((part): ReadonlyArray<AssistantContent> => {
          switch (part.type) {
            case "text":
            case "reasoning":
              return [{ type: part.type, text: part.text }]
            case "tool-call":
              return [
                {
                  type: "tool",
                  id: part.id,
                  name: part.name,
                  // Whoever ran the call, opencode reads it as one it ran, not the provider.
                  executed: false,
                  state: stateOf(inputOf(part.params), results.get(part.id)),
                  time: { created: recording.now, completed: recording.now }
                }
              ]
            // A result is recorded with its call, and an approval changes what the model reads
            // only through the result that follows it. `unsupportedIn` refused files.
            case "tool-result":
            case "tool-approval-request":
            case "file":
              return []
          }
        })
        messages.push({
          type: "assistant",
          id,
          time: { created: recording.now, completed: recording.now },
          agent: "build",
          model: historyModel,
          content,
          finish: content.some((part) => part.type === "tool") ? "tool-calls" : "stop"
        })
        break
      }
      // Results are recorded with the calls of the assistant message before.
      case "tool":
        break
    }
  }
  return Result.succeed(messages)
}

/** Why opencode cannot record `conversation`, or nothing when it can. */
const unsupportedIn = (conversation: Prompt.Prompt): string | undefined => {
  let answering = false
  for (const message of conversation.content) {
    if (message.role === "assistant" && message.content.some((part) => part.type === "file")) {
      return "opencode records no files that an assistant wrote"
    }
    if (message.role === "user") {
      const file = message.content.find(
        (part): part is Prompt.FilePart => part.type === "file" && recordedFileOf(part) === undefined
      )
      if (file !== undefined) return "opencode records the files of a conversation only as data"
    }
    if (message.role === "tool" && !answering) {
      return "opencode records tool results only after the assistant message that called them"
    }
    if (message.role !== "tool") answering = message.role === "assistant"
  }
  return undefined
}

/** The results of the conversation's tool calls, by call id. */
const resultsOf = (conversation: Prompt.Prompt) => {
  const results = new Map<string, Prompt.ToolResultPart>()
  for (const message of conversation.content) {
    if (message.role !== "assistant" && message.role !== "tool") continue
    for (const part of message.content) {
      if (part.type === "tool-result") results.set(part.id, part)
    }
  }
  return results
}

/**
 * The state of a call with `input` that ended with `result`. A call without one is recorded as
 * failed, since opencode reads every recorded call as ended.
 */
const stateOf = (input: Record<string, unknown>, result: Prompt.ToolResultPart | undefined): ToolState =>
  result === undefined
    ? {
        status: "error",
        input,
        error: { type: "unknown", message: "The conversation recorded no result of the call" }
      }
    : result.isFailure
      ? { status: "error", input, error: { type: "unknown", message: resultText(result.result) } }
      : { status: "completed", input, content: contentOf(result.result) }

/** The model the steps of a written conversation name. */
const historyModel: ModelRef = { providerID: "amends", id: "history" }

/**
 * An id as opencode makes one: a prefix, the low 48 bits of the time it was made with a count
 * within it, then a random part. The session's own random part keeps the ids written for it unique
 * to it.
 */
const opencodeId = (prefix: string, recording: Recording, count: number) => {
  const time = (BigInt(recording.now) * 0x1000n + BigInt(count)) & 0xffff_ffff_ffffn
  return `${prefix}_${time.toString(16).padStart(12, "0")}${recording.sessionID.slice(-14)}`
}

const textOf = (message: Prompt.UserMessage) =>
  message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")

/**
 * The URL opencode 2 reads a file at: a `data:` or `file:` URL as it is, and data, or a string of
 * data in base64, as a `data:` URL. Nothing for a file at another URL, which opencode does not read.
 */
const uriOf = (part: Prompt.FilePart): string | undefined => {
  const { data, mediaType } = part
  if (data instanceof URL) return /^(data|file):$/.test(data.protocol) ? data.href : undefined
  if (typeof data !== "string") return `data:${mediaType};base64,${Base64.encode(data)}`
  if (/^(data|file):/.test(data)) return data
  return /^[a-z][a-z0-9+.-]*:/i.test(data) ? undefined : `data:${mediaType};base64,${data}`
}

/** A file of a user message as opencode records it, its data in base64. */
const recordedFileOf = (part: Prompt.FilePart): RecordedFile | undefined => {
  const uri = uriOf(part)
  const data = uri?.startsWith("data:") ? /^data:[^,]*;base64,(.*)$/s.exec(uri)?.[1] : undefined
  if (data === undefined) return undefined
  return {
    data,
    mime: part.mediaType,
    source: { type: "inline" },
    ...(part.fileName === undefined ? {} : { name: part.fileName })
  }
}

const unsupportedFile = (part: Prompt.FilePart) =>
  new HarnessError.UnsupportedError({
    description: `opencode 2 reads files as data, not at ${
      part.data instanceof URL ? part.data.href : String(part.data).slice(0, 40)
    }`
  })

/** A tool's input as opencode keeps it: an object, wrapping any other value as opencode does. */
const inputOf = (params: unknown): Record<string, unknown> => (Predicate.isObject(params) ? params : { value: params })

/**
 * What the model reads of a tool's result: the content opencode returned, or the result as
 * text. opencode records at least one content of a result.
 */
const contentOf = (result: unknown): ReadonlyArray<ToolContent> =>
  Schema.is(Schema.NonEmptyArray(ToolContent))(result) ? result : [{ type: "text", text: resultText(result) }]

const resultText = (result: unknown) => (typeof result === "string" ? result : JSON.stringify(result))
