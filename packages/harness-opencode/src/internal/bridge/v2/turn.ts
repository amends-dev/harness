/**
 * Translates the events of an opencode 2 turn into the parts a harness streams for it, one event at
 * a time, from what the turn has done so far. The translation is pure: the session feeds it the
 * events of its opencode session in order, from before the turn's prompt.
 *
 * The turn starts once opencode delivers its prompt to the session; what came before is earlier
 * work. Text, reasoning, and a tool's input stream as opencode streams them, and every tool runs
 * inside opencode, so its calls and results are `providerExecuted`, a result being what the model
 * read. A file that `write`, `edit`, or `patch` changed is a `file-change`. A tool that asks
 * permission streams a `tool-approval-request`, and a summary opencode writes of the conversation,
 * as when it outgrows the model's context, is a `compaction`.
 *
 * The turn finishes once opencode stops running the session: `finish` then reports the turn's
 * tokens, and the reason its last step ended, or `error` for a turn that failed, was stopped, or
 * took no step.
 */

import { HarnessError, type StreamPart } from "@amends-dev/harness"
import type * as Response from "effect/ai/Response"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { addTokens, finishReasonOf, noTokens, type Tokens, usageOf } from "../steps.ts"
import type { SessionError, SessionEvent, ToolContent } from "./event.ts"

/** A text, a reasoning, or a tool's input the turn is streaming, and what it has streamed. */
interface Writing {
  readonly written: string
  readonly ended: boolean
}

/** What a turn has done so far, as its events told. */
export interface Turn {
  /** The prompt that starts the turn, as the session queued it. */
  readonly inboxID: string

  /** The directory the session works in, which the paths of the files it changes are within. */
  readonly directory: string

  /** Whether opencode delivered the turn's prompt to the session. */
  readonly started: boolean

  /** The texts and reasonings of the turn's steps, by part id. */
  readonly writing: ReadonlyMap<string, Writing>

  /** The inputs of the turn's tool calls, by call id. */
  readonly inputs: ReadonlyMap<string, Writing>

  /** The tools the turn called, by call id; a call and its result name only the call. */
  readonly toolNames: ReadonlyMap<string, string>

  /** The tokens of the turn's ended steps, together. */
  readonly tokens: Tokens

  /** Why the turn's last ended step ended, before any step has. */
  readonly reason: Response.FinishReason | undefined

  /** Whether a step streamed an `error` part. */
  readonly failedStep: boolean

  /** Whether the turn streamed its `finish` part. Events after it stream nothing. */
  readonly finished: boolean
}

/** The turn that the prompt `inboxID` starts in `directory`, before any of its events. */
export const initial = (options: { readonly inboxID: string; readonly directory: string }): Turn => ({
  ...options,
  started: false,
  writing: new Map(),
  inputs: new Map(),
  toolNames: new Map(),
  tokens: noTokens,
  reason: undefined,
  failedStep: false,
  finished: false
})

type Translated = Result.Result<readonly [Turn, ReadonlyArray<StreamPart.StreamPart>], HarnessError.AgentContractError>

const unchanged = (turn: Turn): Translated => Result.succeed([turn, []])

/**
 * The turn after the next event of its session, and the parts that event streams. Fails with
 * `AgentContractError` for a call whose input the turn did not see start.
 */
export const translate = (turn: Turn, event: SessionEvent): Translated => {
  if (turn.finished) return unchanged(turn)
  if (!turn.started) {
    return event.type === "session.inbox.delivered" && event.data.inboxID === turn.inboxID
      ? Result.succeed([{ ...turn, started: true }, []])
      : unchanged(turn)
  }
  switch (event.type) {
    case "session.step.started":
      return Result.succeed([
        turn,
        [
          {
            type: "response-metadata",
            id: event.data.assistantMessageID,
            modelId: `${event.data.model.providerID}/${event.data.model.id}`,
            timestamp: new Date(event.data.started).toISOString()
          }
        ]
      ])

    case "session.text.started":
    case "session.reasoning.started": {
      const kind = event.type === "session.text.started" ? "text" : "reasoning"
      const id = writingId(kind, event.data)
      return Result.succeed([
        { ...turn, writing: withEntry(turn.writing, id, { written: "", ended: false }) },
        [{ type: `${kind}-start`, id }]
      ])
    }

    case "session.text.delta":
    case "session.reasoning.delta": {
      const kind = event.type === "session.text.delta" ? "text" : "reasoning"
      const id = writingId(kind, event.data)
      const [writing, parts] = writeOn(turn.writing.get(id), event.data.delta, (delta) => ({
        type: `${kind}-delta`,
        id,
        delta
      }))
      return Result.succeed([{ ...turn, writing: withEntry(turn.writing, id, writing) }, parts])
    }

    case "session.text.ended":
    case "session.reasoning.ended": {
      const kind = event.type === "session.text.ended" ? "text" : "reasoning"
      const id = writingId(kind, event.data)
      const [writing, parts] = endWith(
        turn.writing.get(id),
        event.data.text,
        (delta) => ({ type: `${kind}-delta`, id, delta }),
        { type: `${kind}-end`, id }
      )
      return Result.succeed([{ ...turn, writing: withEntry(turn.writing, id, writing) }, parts])
    }

    case "session.tool.input.started": {
      const { id, name } = event.data
      return Result.succeed([
        {
          ...turn,
          inputs: withEntry(turn.inputs, id, { written: "", ended: false }),
          toolNames: withEntry(turn.toolNames, id, name)
        },
        [{ type: "tool-params-start", id, name, providerExecuted: true }]
      ])
    }

    case "session.tool.input.delta": {
      const { id, delta } = event.data
      const [input, parts] = writeOn(turn.inputs.get(id), delta, (written) => ({
        type: "tool-params-delta",
        id,
        delta: written
      }))
      return Result.succeed([{ ...turn, inputs: withEntry(turn.inputs, id, input) }, parts])
    }

    case "session.tool.input.ended": {
      const { id, text } = event.data
      const [input, parts] = endWith(turn.inputs.get(id), text, (delta) => ({ type: "tool-params-delta", id, delta }), {
        type: "tool-params-end",
        id
      })
      return Result.succeed([{ ...turn, inputs: withEntry(turn.inputs, id, input) }, parts])
    }

    case "session.tool.called":
      return Result.map(nameOfCall(turn, event.data.id), (name) => [
        turn,
        [
          {
            type: "tool-call",
            id: event.data.id,
            name,
            params: event.data.input,
            providerExecuted: true
          }
        ]
      ])

    case "session.tool.success":
      return Result.map(nameOfCall(turn, event.data.id), (name) => [
        turn,
        [
          {
            type: "tool-result",
            id: event.data.id,
            name,
            result: event.data.content,
            isFailure: false,
            providerExecuted: true
          },
          ...fileChangesOf(turn.directory, name, event.data.content, event.data.metadata)
        ]
      ])

    case "session.tool.failed":
      return Result.map(nameOfCall(turn, event.data.id), (name) => [
        turn,
        [
          {
            type: "tool-result",
            id: event.data.id,
            name,
            result: event.data.error.message,
            isFailure: true,
            providerExecuted: true
          }
        ]
      ])

    case "session.step.ended": {
      const reason = finishReasonOf(event.data.finish)
      return Result.succeed([
        { ...turn, tokens: addTokens(turn.tokens, event.data.tokens), reason },
        [{ type: "finish-step", reason, usage: usageOf(event.data.tokens) }]
      ])
    }

    case "session.step.failed":
      return Result.succeed([
        { ...turn, reason: "error", failedStep: true },
        [
          { type: "error", error: event.data.error },
          { type: "finish-step", reason: "error", usage: usageOf(noTokens) }
        ]
      ])

    case "session.compaction.ended":
      return Result.succeed([turn, [{ type: "compaction", trigger: event.data.reason, summary: event.data.text }]])

    case "permission.asked":
      return Result.succeed([
        turn,
        [
          {
            type: "tool-approval-request",
            approvalId: event.data.id,
            toolCallId: event.data.source?.id ?? event.data.id
          }
        ]
      ])

    case "session.execution.succeeded":
      return Result.succeed(
        finish(
          turn,
          turn.reason === undefined ? { type: "unknown", message: "opencode ended the turn without a step" } : undefined
        )
      )

    case "session.execution.failed":
      return Result.succeed(finish(turn, event.data.error))

    case "session.execution.interrupted":
      return Result.succeed(
        finish(turn, {
          type: "interrupted",
          message: `opencode stopped the turn, interrupted by ${event.data.reason}`
        })
      )

    // A compaction fails the turn's execution, if it does, with an event of its own, and the
    // session answers forms itself.
    case "session.inbox.delivered":
    case "session.execution.started":
    case "session.compaction.failed":
    case "form.created":
      return unchanged(turn)
  }
}

/** The id the turn streams a text or a reasoning by: its kind, step, and number within the step. */
const writingId = (
  kind: "text" | "reasoning",
  data: { readonly assistantMessageID: string; readonly ordinal: number }
) => `${data.assistantMessageID}-${kind}-${data.ordinal}`

/** `delta` written on `writing`, streamed as `partOf` makes it unless the writing has ended. */
const writeOn = (
  writing: Writing | undefined,
  delta: string,
  partOf: (delta: string) => StreamPart.StreamPart
): readonly [Writing, ReadonlyArray<StreamPart.StreamPart>] => {
  const known = writing ?? { written: "", ended: false }
  if (known.ended) return [known, []]
  return [{ ...known, written: known.written + delta }, [partOf(delta)]]
}

/**
 * `writing` ended as the whole `text`: what its deltas missed streams first, as `partOf` makes it,
 * then `end`.
 */
const endWith = (
  writing: Writing | undefined,
  text: string,
  partOf: (delta: string) => StreamPart.StreamPart,
  end: StreamPart.StreamPart
): readonly [Writing, ReadonlyArray<StreamPart.StreamPart>] => {
  const known = writing ?? { written: "", ended: false }
  if (known.ended) return [known, []]
  const missed =
    text.length > known.written.length && text.startsWith(known.written)
      ? [partOf(text.slice(known.written.length))]
      : []
  return [{ written: text, ended: true }, [...missed, end]]
}

const nameOfCall = (turn: Turn, id: string) => {
  const name = turn.toolNames.get(id)
  return name === undefined
    ? Result.fail(
        new HarnessError.AgentContractError({
          description: `opencode reported the call ${id}, whose input the turn did not see start`
        })
      )
    : Result.succeed(name)
}

/** The files of an edit or a patch, as their tools report them. */
const ChangedFiles = Schema.Array(
  Schema.Struct({ file: Schema.String, status: Schema.Literals(["added", "deleted", "modified"]) })
)

const events = { added: "create", deleted: "delete", modified: "modify" } as const

/**
 * The files a call of `name` changed, by their paths within `directory`, or as they are when
 * outside it: `edit` and `patch` report them in their metadata, and `write` in what it tells the
 * model. Other tools, such as `shell`, do not say which files they change.
 */
const fileChangesOf = (
  directory: string,
  name: string,
  content: ReadonlyArray<ToolContent>,
  metadata: Readonly<Record<string, unknown>> | undefined
): ReadonlyArray<StreamPart.StreamPart> => {
  const pathOf = (file: string) => (file.startsWith(`${directory}/`) ? file.slice(directory.length + 1) : file)
  const files = metadata?.["files"]
  if (Schema.is(ChangedFiles)(files)) {
    return files.map(({ file, status }) => ({
      type: "file-change",
      event: events[status],
      path: pathOf(file)
    }))
  }
  const [first] = content
  if (name !== "write" || first?.type !== "text") return []
  const written = /^(Created|Wrote) file successfully: (.+)$/.exec(first.text)
  if (written === null) return []
  return [
    {
      type: "file-change",
      event: written[1] === "Created" ? "create" : "modify",
      path: pathOf(written[2] ?? "")
    }
  ]
}

/** Finishes the turn: with `failure`, unless a step reported its own, then `finish`. */
const finish = (
  turn: Turn,
  failure: SessionError | undefined
): readonly [Turn, ReadonlyArray<StreamPart.StreamPart>] => {
  const parts: Array<StreamPart.StreamPart> = []
  if (failure !== undefined && !turn.failedStep) parts.push({ type: "error", error: failure })
  parts.push({
    type: "finish",
    reason: failure !== undefined || turn.failedStep ? "error" : (turn.reason ?? "other"),
    usage: usageOf(turn.tokens)
  })
  return [{ ...turn, finished: true }, parts]
}

const withEntry = <K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> => new Map(map).set(key, value)
