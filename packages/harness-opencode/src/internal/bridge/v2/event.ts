/**
 * The events opencode 2 publishes for a session as it works, which the driver reads to stream a
 * turn: the session's executions, the steps of each, the text, reasoning, and tool calls of each
 * step, compactions, and the permissions its tools ask and the forms its model asks the user to
 * fill. opencode publishes every event of the server on one stream, live only: the deltas of text,
 * reasoning, and tool input as they come, and the whole of each when it ends.
 *
 * The schemas are opencode 2.0's, with only the fields this adapter reads, so that fields opencode
 * adds do not stop an event from decoding.
 */

import * as Schema from "effect/Schema"
import { ModelRef } from "../driver.ts"
import { Tokens } from "../steps.ts"

/** An error opencode reports, as its sessions record it. */
export const SessionError = Schema.Struct({ type: Schema.String, message: Schema.String })

export type SessionError = typeof SessionError.Type

/** What a tool returned to the model: text, or a file. */
export const ToolContent = Schema.Union([
  Schema.Struct({ type: Schema.tag("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.tag("file"),
    uri: Schema.String,
    mime: Schema.String,
    name: Schema.optionalKey(Schema.String)
  })
])

export type ToolContent = typeof ToolContent.Type

/** An event of the session `sessionID`, of the type `type`, with `data` besides its session's id. */
const sessionEvent = <Type extends string, Fields extends Schema.Struct.Fields>(type: Type, fields: Fields) =>
  Schema.Struct({
    type: Schema.tag(type),
    data: Schema.Struct({ sessionID: Schema.String, ...fields })
  })

/** Of the step that the assistant message `assistantMessageID` records. */
const inStep = { assistantMessageID: Schema.String }

/** Of the text or reasoning numbered `ordinal` in its step. */
const ordinal = { ...inStep, ordinal: Schema.Int }

/** Of the tool call `id`. */
const inCall = { ...inStep, id: Schema.String }

/** opencode started running the session: a prompt it took, and what follows until it is idle. */
export const ExecutionStarted = sessionEvent("session.execution.started", {})

/** opencode ran the session until it had nothing more to do. */
export const ExecutionSucceeded = sessionEvent("session.execution.succeeded", {})

export const ExecutionFailed = sessionEvent("session.execution.failed", { error: SessionError })

/** opencode stopped running the session, `reason` saying why. */
export const ExecutionInterrupted = sessionEvent("session.execution.interrupted", {
  reason: Schema.String
})

/** The session started work on the input `inboxID`, such as a prompt. */
export const InboxDelivered = sessionEvent("session.inbox.delivered", {
  inboxID: Schema.String
})

/** A step started: one response of `model`, which the assistant message records. */
export const StepStarted = sessionEvent("session.step.started", {
  ...inStep,
  model: ModelRef,
  /** When opencode sent the request, in milliseconds since the epoch. */
  started: Schema.Finite
})

/** A step ended, `finish` saying why. */
export const StepEnded = sessionEvent("session.step.ended", {
  ...inStep,
  finish: Schema.String,
  tokens: Tokens
})

/** A step failed, ending the session's execution. */
export const StepFailed = sessionEvent("session.step.failed", { ...inStep, error: SessionError })

export const TextStarted = sessionEvent("session.text.started", ordinal)

export const TextDelta = sessionEvent("session.text.delta", { ...ordinal, delta: Schema.String })

/** A text of the step ended, with the whole text. */
export const TextEnded = sessionEvent("session.text.ended", { ...ordinal, text: Schema.String })

export const ReasoningStarted = sessionEvent("session.reasoning.started", ordinal)

export const ReasoningDelta = sessionEvent("session.reasoning.delta", {
  ...ordinal,
  delta: Schema.String
})

/** A reasoning of the step ended, with the whole reasoning. */
export const ReasoningEnded = sessionEvent("session.reasoning.ended", {
  ...ordinal,
  text: Schema.String
})

/** The model started writing the input of a call to the tool `name`. */
export const ToolInputStarted = sessionEvent("session.tool.input.started", {
  ...inCall,
  name: Schema.String
})

export const ToolInputDelta = sessionEvent("session.tool.input.delta", {
  ...inCall,
  delta: Schema.String
})

/** The model finished writing a call's input, with the whole input as JSON text. */
export const ToolInputEnded = sessionEvent("session.tool.input.ended", {
  ...inCall,
  text: Schema.String
})

/** The model called a tool with `input`, which opencode runs. */
export const ToolCalled = sessionEvent("session.tool.called", {
  ...inCall,
  input: Schema.Record(Schema.String, Schema.Unknown)
})

/**
 * A call succeeded: `content` is what the model reads, and `metadata` what the tool reported
 * besides, such as the files an edit changed.
 */
export const ToolSucceeded = sessionEvent("session.tool.success", {
  ...inCall,
  content: Schema.Array(ToolContent),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
})

export const ToolFailed = sessionEvent("session.tool.failed", { ...inCall, error: SessionError })

/** The session replaced its conversation so far with the summary `text`. */
export const CompactionEnded = sessionEvent("session.compaction.ended", {
  reason: Schema.Literals(["auto", "manual"]),
  text: Schema.String
})

export const CompactionFailed = sessionEvent("session.compaction.failed", {
  reason: Schema.Literals(["auto", "manual"]),
  error: SessionError
})

/**
 * A tool asks permission to act on `resources`, waiting for a reply to the request `id`. `source`
 * names the call that asks.
 */
export const PermissionAsked = Schema.Struct({
  type: Schema.tag("permission.asked"),
  data: Schema.Struct({
    id: Schema.String,
    sessionID: Schema.String,
    source: Schema.optionalKey(Schema.Struct({ id: Schema.String }))
  })
})

/** The model asks the user to fill the form `id`, waiting for an answer. */
export const FormCreated = Schema.Struct({
  type: Schema.tag("form.created"),
  data: Schema.Struct({
    form: Schema.Struct({ id: Schema.String, sessionID: Schema.String })
  })
})

export const SessionEvent = Schema.Union([
  ExecutionStarted,
  ExecutionSucceeded,
  ExecutionFailed,
  ExecutionInterrupted,
  InboxDelivered,
  StepStarted,
  StepEnded,
  StepFailed,
  TextStarted,
  TextDelta,
  TextEnded,
  ReasoningStarted,
  ReasoningDelta,
  ReasoningEnded,
  ToolInputStarted,
  ToolInputDelta,
  ToolInputEnded,
  ToolCalled,
  ToolSucceeded,
  ToolFailed,
  CompactionEnded,
  CompactionFailed,
  PermissionAsked,
  FormCreated
]).pipe(Schema.toTaggedUnion("type"))

export type SessionEvent = typeof SessionEvent.Type

/** The session an event is of. */
export const sessionIdOf = (event: SessionEvent) =>
  event.type === "form.created" ? event.data.form.sessionID : event.data.sessionID
