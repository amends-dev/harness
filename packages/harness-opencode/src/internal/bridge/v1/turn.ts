/**
 * Translates the events of an opencode 1 turn into the parts a harness streams for it, one event at
 * a time, from what the turn has done so far. The translation is pure: the session feeds it the
 * events of its directory in order, from before the turn's prompt, and it reads those of the
 * session's own steps.
 *
 * Each step is an assistant message that starts during the turn; messages that started before it
 * are not the turn's. Text and reasoning stream as opencode streams them, and a call of opencode's
 * own tools streams its input whole once it runs, `providerExecuted`, with the result the model
 * read. Calls of the host's tools are left out, as the relay streams them, and so are the tools
 * opencode answers in JSON or asks questions with. A step that answered in JSON writes the answer
 * as its text. A tool that asks permission streams a `tool-approval-request`. A summary opencode
 * writes of the conversation, as when it outgrows the model's context, is a `compaction`.
 *
 * The turn finishes once opencode stops working on the session, having started to: `finish` then
 * reports the turn's tokens, and the reason its last step ended, or `error` for a turn that failed
 * or took no step.
 */

import type { StreamPart } from "@amends-dev/harness"
import type * as Response from "effect/ai/Response"
import * as Schema from "effect/Schema"
import { addTokens, finishReasonOf, noTokens, type Tokens, usageOf } from "../steps.ts"
import {
  type AssistantMessage,
  type Failure,
  isReasoningPart,
  isTextPart,
  isToolPart,
  type Part,
  type SessionEvent,
  type ToolPart
} from "./event.ts"

/** A step of the turn: an assistant message that started during it. */
interface Step {
  /** Whether the step summarizes the conversation, rather than answering. */
  readonly summary: boolean

  readonly completed: boolean

  /** The texts of a summary, by part, which its compaction holds once it completes. */
  readonly summaryTexts: ReadonlyMap<string, string>
}

/** A text or a reasoning the turn is streaming. */
interface Writing {
  readonly kind: "text" | "reasoning"
  readonly messageID: string

  /** What the turn has streamed of it. */
  readonly written: string
  readonly ended: boolean
}

/** A call of one of opencode's own tools, and how much of it the turn has streamed. */
interface Call {
  readonly name: string
  readonly called: boolean
  readonly answered: boolean
}

/** What a turn has done so far, as its events told. */
export interface Turn {
  /** The opencode session the turn runs in. */
  readonly sessionID: string

  /** The directory the session works in, which the paths of the files it changes are within. */
  readonly directory: string

  /** The names opencode gives the host's tools, whose calls the relay streams instead. */
  readonly hostTools: ReadonlySet<string>

  /** Whether opencode started working on the turn. */
  readonly started: boolean

  /** The turn's steps, by message id. */
  readonly steps: ReadonlyMap<string, Step>

  /** The texts and reasonings of the turn's steps, by part id. */
  readonly writing: ReadonlyMap<string, Writing>

  /** The calls of opencode's own tools, by call id. */
  readonly calls: ReadonlyMap<string, Call>

  /** The tokens of the turn's completed steps, together. */
  readonly tokens: Tokens

  /** Why the turn's last completed step ended, before any step has. */
  readonly reason: Response.FinishReason | undefined

  /** Whether a step streamed an `error` part. */
  readonly failedStep: boolean

  /** What opencode reported when the turn failed, apart from any step. */
  readonly failure: Failure | undefined

  /** Whether the turn streamed its `finish` part. Events after it stream nothing. */
  readonly finished: boolean
}

/** A turn in the session `sessionID`, working in `directory`, before any of its events. */
export const initial = (options: {
  readonly sessionID: string
  readonly directory: string
  readonly hostTools: ReadonlySet<string>
}): Turn => ({
  ...options,
  started: false,
  steps: new Map(),
  writing: new Map(),
  calls: new Map(),
  tokens: noTokens,
  reason: undefined,
  failedStep: false,
  failure: undefined,
  finished: false
})

/** The tools opencode answers in JSON and asks questions with, which no turn streams. */
const hiddenTools = new Set(["StructuredOutput", "question"])

/** The failure opencode reports when a turn is aborted, which ends the turn without an error. */
const aborted = "MessageAbortedError"

type Translated = readonly [Turn, ReadonlyArray<StreamPart.StreamPart>]

/** The turn after the next event of its directory, and the parts that event streams. */
export const translate = (turn: Turn, event: SessionEvent): Translated => {
  if (turn.finished) return [turn, []]
  switch (event.type) {
    case "message.updated": {
      const { info } = event.properties
      if (info.sessionID !== turn.sessionID || info.role !== "assistant") return [turn, []]
      return messageUpdated(turn, info)
    }

    case "message.part.updated": {
      const { part } = event.properties
      const step = turn.steps.get(part.messageID)
      if (part.sessionID !== turn.sessionID || step === undefined) return [turn, []]
      return step.summary ? [summaryPartUpdated(turn, step, part), []] : partUpdated(turn, part)
    }

    case "message.part.delta": {
      const { sessionID, partID, field, delta } = event.properties
      const writing = turn.writing.get(partID)
      if (sessionID !== turn.sessionID || field !== "text" || writing === undefined) {
        return [turn, []]
      }
      if (writing.ended) return [turn, []]
      return [
        {
          ...turn,
          writing: withEntry(turn.writing, partID, {
            ...writing,
            written: writing.written + delta
          })
        },
        [{ type: `${writing.kind}-delta`, id: partID, delta }]
      ]
    }

    case "session.status": {
      const { sessionID, status } = event.properties
      return sessionID === turn.sessionID && status.type !== "idle" ? [{ ...turn, started: true }, []] : [turn, []]
    }

    case "session.error": {
      const { sessionID, error } = event.properties
      if (sessionID !== turn.sessionID || error === undefined || error.name === aborted) {
        return [turn, []]
      }
      return [{ ...turn, failure: turn.failure ?? error }, []]
    }

    case "session.idle":
      return event.properties.sessionID === turn.sessionID && turn.started ? finish(turn) : [turn, []]

    case "permission.asked": {
      const { id, tool } = event.properties
      return [turn, [{ type: "tool-approval-request", approvalId: id, toolCallId: tool?.callID ?? id }]]
    }

    case "question.asked":
      return [turn, []]
  }
}

/**
 * A step starting, as a message that starts during the turn, or completing: it ends the step with
 * its answer in JSON, if it gave one, its failure, and its `finish-step`, or, for a summary, with
 * the `compaction` it made.
 */
const messageUpdated = (turn: Turn, info: AssistantMessage): Translated => {
  const step = turn.steps.get(info.id)
  const completed = info.time.completed !== undefined
  if (step === undefined) {
    // A message completed when the turn first sees it is an earlier turn's.
    if (completed) return [turn, []]
    const started: Step = {
      summary: info.summary === true,
      completed: false,
      summaryTexts: new Map()
    }
    const steps = withEntry(turn.steps, info.id, started)
    return [
      { ...turn, steps },
      started.summary
        ? []
        : [
            {
              type: "response-metadata",
              id: info.id,
              modelId: `${info.providerID}/${info.modelID}`,
              timestamp: new Date(info.time.created).toISOString()
            }
          ]
    ]
  }
  if (!completed || step.completed) return [turn, []]
  const steps = withEntry(turn.steps, info.id, { ...step, completed: true })
  if (step.summary) {
    return [
      { ...turn, steps },
      info.error === undefined
        ? [
            {
              type: "compaction",
              trigger: "auto",
              summary: [...step.summaryTexts.values()].join("\n")
            }
          ]
        : []
    ]
  }

  const parts: Array<StreamPart.StreamPart> = []
  const writing = new Map(turn.writing)
  for (const [id, open] of turn.writing) {
    if (open.messageID === info.id && !open.ended) {
      parts.push({ type: `${open.kind}-end`, id })
      writing.set(id, { ...open, ended: true })
    }
  }
  if (info.structured !== undefined) {
    const id = `${info.id}-answer`
    parts.push(
      { type: "text-start", id },
      { type: "text-delta", id, delta: JSON.stringify(info.structured) },
      { type: "text-end", id }
    )
  }
  const failed = info.error !== undefined && info.error.name !== aborted
  if (failed) parts.push({ type: "error", error: info.error })
  const reason: Response.FinishReason = failed
    ? "error"
    : info.structured !== undefined
      ? "stop"
      : finishReasonOf(info.finish ?? "other")
  const tokens = info.tokens ?? noTokens
  parts.push({ type: "finish-step", reason, usage: usageOf(tokens) })
  return [
    {
      ...turn,
      steps,
      writing,
      tokens: addTokens(turn.tokens, tokens),
      reason,
      failedStep: turn.failedStep || failed
    },
    parts
  ]
}

/** A part of a summary changing: the summary keeps its texts, which no part streams. */
const summaryPartUpdated = (turn: Turn, step: Step, part: Part): Turn =>
  isTextPart(part)
    ? {
        ...turn,
        steps: withEntry(turn.steps, part.messageID, {
          ...step,
          summaryTexts: withEntry(step.summaryTexts, part.id, part.text)
        })
      }
    : turn

/** A part of a step changing: a text or a reasoning written on, or a call of a tool going on. */
const partUpdated = (turn: Turn, part: Part): Translated => {
  if (isTextPart(part) || isReasoningPart(part)) return writingUpdated(turn, part.type, part)
  if (isToolPart(part) && !turn.hostTools.has(part.tool) && !hiddenTools.has(part.tool)) {
    return callUpdated(turn, part)
  }
  return [turn, []]
}

/**
 * A text or a reasoning written on: started the first time the turn sees it, then written on with
 * what the deltas have not streamed, and ended once it is whole.
 */
const writingUpdated = (
  turn: Turn,
  kind: Writing["kind"],
  part: {
    readonly id: string
    readonly messageID: string
    readonly text: string
    readonly time?: { readonly end?: number | undefined } | undefined
  }
): Translated => {
  const parts: Array<StreamPart.StreamPart> = []
  const known = turn.writing.get(part.id)
  if (known?.ended === true) return [turn, []]
  if (known === undefined) parts.push({ type: `${kind}-start`, id: part.id })
  const written = known?.written ?? ""
  // A part's whole text follows the deltas streamed of it; what they missed streams now.
  if (part.text.length > written.length && part.text.startsWith(written)) {
    parts.push({ type: `${kind}-delta`, id: part.id, delta: part.text.slice(written.length) })
  }
  const ended = part.time?.end !== undefined
  if (ended) parts.push({ type: `${kind}-end`, id: part.id })
  const writing: Writing = {
    kind,
    messageID: part.messageID,
    written: part.text.startsWith(written) ? part.text : written,
    ended
  }
  return [{ ...turn, writing: withEntry(turn.writing, part.id, writing) }, parts]
}

/**
 * A call of one of opencode's own tools going on: its input starts once the model writes it, and
 * streams whole with the call once the tool runs; its result follows once the tool has answered,
 * with the file a write or an edit changed.
 */
const callUpdated = (turn: Turn, part: ToolPart): Translated => {
  const { callID, tool: name, state } = part
  const parts: Array<StreamPart.StreamPart> = []
  const call = turn.calls.get(callID) ?? { name, called: false, answered: false }
  if (!turn.calls.has(callID)) {
    parts.push({ type: "tool-params-start", id: callID, name, providerExecuted: true })
  }
  if (state.status === "pending") {
    return [{ ...turn, calls: withEntry(turn.calls, callID, call) }, parts]
  }
  if (!call.called) {
    parts.push(
      { type: "tool-params-delta", id: callID, delta: JSON.stringify(state.input) },
      { type: "tool-params-end", id: callID },
      { type: "tool-call", id: callID, name, params: state.input, providerExecuted: true }
    )
  }
  const answered = state.status === "completed" || state.status === "error"
  if (answered && !call.answered) {
    parts.push({
      type: "tool-result",
      id: callID,
      name,
      ...(state.status === "completed"
        ? { result: state.output, isFailure: false }
        : { result: state.error, isFailure: true }),
      providerExecuted: true
    })
    if (state.status === "completed") parts.push(...fileChangesOf(turn.directory, name, state))
  }
  return [{ ...turn, calls: withEntry(turn.calls, callID, { name, called: true, answered }) }, parts]
}

/** The files a completed call of `apply_patch` reports in its metadata, by their absolute paths. */
const PatchedFiles = Schema.Array(
  Schema.Struct({
    filePath: Schema.String,
    type: Schema.Literals(["add", "update", "delete", "move"]),
    movePath: Schema.optional(Schema.String)
  })
)

/**
 * The files a completed call of `write`, `edit`, or `apply_patch` changed, by their paths within
 * `directory`, or as they are when outside it: `write` says whether the file existed before, and
 * `apply_patch`, which opencode gives OpenAI's models in place of the other two, reports each file
 * of the patch, a move as the file it removed and the one it created. Other tools, such as `bash`,
 * do not say which files they change.
 */
const fileChangesOf = (
  directory: string,
  tool: string,
  state: {
    readonly input: Readonly<Record<string, unknown>>
    readonly metadata?: Readonly<Record<string, unknown>> | undefined
  }
): ReadonlyArray<StreamPart.StreamPart> => {
  const pathOf = (file: string) => (file.startsWith(`${directory}/`) ? file.slice(directory.length + 1) : file)
  if (tool === "apply_patch") {
    const files = state.metadata?.["files"]
    if (!Schema.is(PatchedFiles)(files)) return []
    return files.flatMap(({ filePath, type, movePath }): ReadonlyArray<StreamPart.StreamPart> => {
      switch (type) {
        case "add":
          return [{ type: "file-change", event: "create", path: pathOf(filePath) }]
        case "update":
          return [{ type: "file-change", event: "modify", path: pathOf(filePath) }]
        case "delete":
          return [{ type: "file-change", event: "delete", path: pathOf(filePath) }]
        case "move":
          return movePath === undefined
            ? [{ type: "file-change", event: "modify", path: pathOf(filePath) }]
            : [
                { type: "file-change", event: "delete", path: pathOf(filePath) },
                { type: "file-change", event: "create", path: pathOf(movePath) }
              ]
      }
    })
  }
  const file = state.metadata?.["filepath"] ?? state.input["filePath"]
  if (typeof file !== "string") return []
  switch (tool) {
    case "write":
      return [
        {
          type: "file-change",
          event: state.metadata?.["exists"] === false ? "create" : "modify",
          path: pathOf(file)
        }
      ]
    case "edit":
      return [{ type: "file-change", event: "modify", path: pathOf(file) }]
    default:
      return []
  }
}

/**
 * Finishes the turn: with what opencode reported when it failed apart from any step, or for a turn
 * that took no step, then `finish`.
 */
const finish = (turn: Turn): Translated => {
  const parts: Array<StreamPart.StreamPart> = []
  const failure =
    turn.failure ??
    (turn.reason === undefined
      ? { name: "UnknownError", data: { message: "opencode ended the turn without a step" } }
      : undefined)
  if (failure !== undefined && !turn.failedStep) parts.push({ type: "error", error: failure })
  parts.push({
    type: "finish",
    reason: failure !== undefined || turn.failedStep ? "error" : (turn.reason ?? "other"),
    usage: usageOf(turn.tokens)
  })
  return [{ ...turn, finished: true }, parts]
}

const withEntry = <K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> => new Map(map).set(key, value)
