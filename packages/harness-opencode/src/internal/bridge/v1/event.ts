/**
 * The events opencode publishes on its event stream in opencode 1's session API: a message of a
 * session being written, each of its parts as it changes, the deltas of a text as it streams, the
 * session's status, and what a tool asks of the session's user. opencode keeps a message's parts
 * as the latest state of each, not as events, and publishes each change to the instance of one
 * directory, live only.
 *
 * The schemas are opencode 1.18's, for the events this adapter reads, with the fields it reads of
 * them; other fields pass. Each step of a turn is an assistant message of its own, complete once
 * its `time.completed` is set. Text and reasoning stream as deltas of a part, whose update then
 * holds it whole; a call of a tool is a part that goes from `pending` to `running`, and then to
 * `completed` or `error`.
 */

import * as Schema from "effect/Schema"
import { Tokens } from "../steps.ts"

/** What opencode reports of a failure: its kind, such as `MessageAbortedError`, and its message. */
export const Failure = Schema.Struct({
  name: Schema.String,
  data: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.String) }))
})

export type Failure = typeof Failure.Type

const JsonObject = Schema.Record(Schema.String, Schema.Unknown)

/** Fields every part of a message has. */
const inMessage = {
  id: Schema.String,
  sessionID: Schema.String,
  messageID: Schema.String
}

/** When a part started and, once it has, ended. */
const Time = Schema.Struct({
  start: Schema.optional(Schema.Finite),
  end: Schema.optional(Schema.Finite)
})

/** A text of the message. Its `text` is whole once `time.end` is set. */
export const TextPart = Schema.Struct({
  ...inMessage,
  type: Schema.tag("text"),
  text: Schema.String,
  time: Schema.optional(Time)
})

/** A reasoning of the message, whole once `time.end` is set. */
export const ReasoningPart = Schema.Struct({
  ...inMessage,
  type: Schema.tag("reasoning"),
  text: Schema.String,
  time: Schema.optional(Time),
  metadata: Schema.optional(JsonObject)
})

/** The model is writing the call's input. */
const ToolPending = Schema.Struct({ status: Schema.tag("pending") })

/** opencode is running the call with `input`. */
const ToolRunning = Schema.Struct({ status: Schema.tag("running"), input: JsonObject })

/** The call succeeded, with `output` for the model to read, and what the tool reported. */
const ToolCompleted = Schema.Struct({
  status: Schema.tag("completed"),
  input: JsonObject,
  output: Schema.String,
  metadata: Schema.optional(JsonObject)
})

const ToolError = Schema.Struct({
  status: Schema.tag("error"),
  input: JsonObject,
  error: Schema.String
})

export const ToolState = Schema.Union([ToolPending, ToolRunning, ToolCompleted, ToolError]).pipe(
  Schema.toTaggedUnion("status")
)

export type ToolState = typeof ToolState.Type

/** A call of the tool `tool`, in the state `state`. */
export const ToolPart = Schema.Struct({
  ...inMessage,
  type: Schema.tag("tool"),
  callID: Schema.String,
  tool: Schema.String,
  state: ToolState
})

export type ToolPart = typeof ToolPart.Type

/** A part of a type the adapter does not read, such as a step's start, or a snapshot. */
export const OtherPart = Schema.Struct({
  ...inMessage,
  type: Schema.String.check(Schema.makeFilter((type: string) => !["text", "reasoning", "tool"].includes(type)))
})

export const Part = Schema.Union([TextPart, ReasoningPart, ToolPart, OtherPart])

export type Part = typeof Part.Type

export const isTextPart = Schema.is(TextPart)

export const isReasoningPart = Schema.is(ReasoningPart)

export const isToolPart = Schema.is(ToolPart)

/** A model, as opencode 1 names one in a prompt: its provider, and its id there. */
export const MessageModel = Schema.Struct({ providerID: Schema.String, modelID: Schema.String })

export interface MessageModel extends Schema.Schema.Type<typeof MessageModel> {}

/**
 * An assistant message: one step of a turn. It is complete once `time.completed` is set, having
 * ended as `finish` says, or failed with `error`. A step that answered in JSON holds the answer as
 * `structured`, and one that summarized the conversation is a `summary`.
 */
export const AssistantMessage = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  role: Schema.tag("assistant"),
  providerID: Schema.String,
  modelID: Schema.String,
  time: Schema.Struct({ created: Schema.Finite, completed: Schema.optional(Schema.Finite) }),
  error: Schema.optional(Failure),
  summary: Schema.optional(Schema.Boolean),
  tokens: Schema.optional(Tokens),
  structured: Schema.optional(Schema.Unknown),
  finish: Schema.optional(Schema.String)
})

export type AssistantMessage = typeof AssistantMessage.Type

/** A user message: a prompt the session took. */
export const UserMessage = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  role: Schema.tag("user")
})

export const Message = Schema.Union([AssistantMessage, UserMessage]).pipe(Schema.toTaggedUnion("role"))

export type Message = typeof Message.Type

/** A message was written, or changed: its latest state. */
export const MessageUpdated = Schema.Struct({
  type: Schema.tag("message.updated"),
  properties: Schema.Struct({ sessionID: Schema.String, info: Message })
})

/** A part of a message was written, or changed: its latest state. */
export const MessagePartUpdated = Schema.Struct({
  type: Schema.tag("message.part.updated"),
  properties: Schema.Struct({ sessionID: Schema.String, part: Part })
})

/**
 * The model wrote `delta` more of a part's `field`. opencode names the field `text` for a
 * reasoning's text too.
 */
export const MessagePartDelta = Schema.Struct({
  type: Schema.tag("message.part.delta"),
  properties: Schema.Struct({
    sessionID: Schema.String,
    messageID: Schema.String,
    partID: Schema.String,
    field: Schema.String,
    delta: Schema.String
  })
})

/**
 * The session is `busy` working on a turn, `idle`, or waiting to `retry` a request its model's
 * provider refused.
 */
export const SessionStatus = Schema.Struct({
  type: Schema.tag("session.status"),
  properties: Schema.Struct({
    sessionID: Schema.String,
    status: Schema.Struct({ type: Schema.String })
  })
})

/** The session stopped working on its turn, whether the turn ended or failed. */
export const SessionIdle = Schema.Struct({
  type: Schema.tag("session.idle"),
  properties: Schema.Struct({ sessionID: Schema.String })
})

/** The session's turn failed, as when its model's provider refused it, or it was aborted. */
export const SessionErrored = Schema.Struct({
  type: Schema.tag("session.error"),
  properties: Schema.Struct({
    sessionID: Schema.optional(Schema.String),
    error: Schema.optional(Failure)
  })
})

/**
 * A tool asks the user's permission before it goes on, for the action `permission` on `patterns`,
 * such as a command or a path. `tool` names the call that asks.
 */
export const PermissionAsked = Schema.Struct({
  type: Schema.tag("permission.asked"),
  properties: Schema.Struct({
    id: Schema.String,
    sessionID: Schema.String,
    permission: Schema.String,
    patterns: Schema.Array(Schema.String),
    tool: Schema.optional(Schema.Struct({ messageID: Schema.String, callID: Schema.String }))
  })
})

/** The model asks the user questions, with its `question` tool. */
export const QuestionAsked = Schema.Struct({
  type: Schema.tag("question.asked"),
  properties: Schema.Struct({ id: Schema.String, sessionID: Schema.String })
})

export const SessionEvent = Schema.Union([
  MessageUpdated,
  MessagePartUpdated,
  MessagePartDelta,
  SessionStatus,
  SessionIdle,
  SessionErrored,
  PermissionAsked,
  QuestionAsked
]).pipe(Schema.toTaggedUnion("type"))

export type SessionEvent = typeof SessionEvent.Type
