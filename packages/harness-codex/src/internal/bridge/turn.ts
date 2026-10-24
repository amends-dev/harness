/** Translates Codex notifications into harness parts without duplicating completed text snapshots. */

import type { HarnessError, StreamPart } from "@amends-dev/harness"
import type * as Response from "effect/ai/Response"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { contractError } from "../errors.ts"
import type * as Rpc from "./rpc.ts"

const Item = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  text: Schema.optionalKey(Schema.String),
  phase: Schema.optionalKey(Schema.NullOr(Schema.Literals(["commentary", "final_answer"]))),
  summary: Schema.optionalKey(Schema.Array(Schema.String)),
  content: Schema.optionalKey(Schema.Array(Schema.String)),
  server: Schema.optionalKey(Schema.String),
  tool: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  arguments: Schema.optionalKey(Schema.Json),
  aggregatedOutput: Schema.optionalKey(Schema.NullOr(Schema.String)),
  status: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(Schema.Json),
  changes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        kind: Schema.Struct({ type: Schema.String, move_path: Schema.optionalKey(Schema.NullOr(Schema.String)) })
      })
    )
  )
})
type Item = typeof Item.Type
const ItemEvent = Schema.Struct({ item: Schema.Json })
const ItemHeader = Schema.Struct({ id: Schema.String, type: Schema.String })
const Delta = Schema.Struct({ itemId: Schema.String, delta: Schema.String })
const Completed = Schema.Struct({
  turn: Schema.Struct({ status: Schema.String, error: Schema.optionalKey(Schema.Json) })
})
const Tokens = Schema.Struct({
  inputTokens: Schema.Int,
  cachedInputTokens: Schema.Int,
  outputTokens: Schema.Int,
  reasoningOutputTokens: Schema.Int,
  cacheWriteInputTokens: Schema.optionalKey(Schema.Int)
})
type Tokens = typeof Tokens.Type
const Usage = Schema.Struct({ tokenUsage: Schema.Struct({ total: Tokens, last: Tokens }) })
const Approval = Schema.Struct({ itemId: Schema.String })

export interface State {
  readonly writing: ReadonlyMap<string, { readonly type: "text" | "reasoning"; readonly text: string }>
  readonly calls: ReadonlySet<string>
  readonly usage: typeof Response.Usage.Encoded
  readonly stepUsage: typeof Response.Usage.Encoded
  readonly messageId?: string | undefined
  readonly hasTools: boolean
  readonly responseComplete: boolean
  readonly lastTotal?: Tokens | undefined
}
export const initial = (): State => ({
  writing: new Map(),
  calls: new Set(),
  usage: { inputTokens: {}, outputTokens: {} },
  stepUsage: { inputTokens: {}, outputTokens: {} },
  hasTools: false,
  responseComplete: false
})

const decode = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) => contractError("Malformed Codex event", cause))
  )

export const translate = Effect.fn("CodexTurn.translate")(function* (
  state: State,
  message: Rpc.Message
): Effect.fn.Return<readonly [State, ReadonlyArray<StreamPart.StreamPart>], HarnessError.HarnessError> {
  const parts: Array<StreamPart.StreamPart> = []
  const writing = new Map(state.writing)
  const calls = new Set(state.calls)
  let stepUsage = state.stepUsage
  let messageId = state.messageId
  let hasTools = state.hasTools
  let responseComplete = state.responseComplete
  const finishStep = () => {
    for (const [id, value] of writing) parts.push({ type: value.type === "text" ? "text-end" : "reasoning-end", id })
    writing.clear()
    parts.push({ type: "finish-step", reason: hasTools ? "tool-calls" : "other", usage: stepUsage })
    stepUsage = { inputTokens: {}, outputTokens: {} }
    messageId = undefined
    hasTools = false
    responseComplete = false
  }
  const begin = (id: string, type: "text" | "reasoning", phase?: "commentary" | "final_answer" | null) => {
    if (writing.has(id)) return
    // The next model output follows the preceding response and its tool execution. Explicit
    // final answers also separate interim text; legacy providers identify those by a new item id.
    if (
      (responseComplete && (hasTools || messageId !== undefined)) ||
      (type === "text" && ((messageId !== undefined && messageId !== id) || (phase === "final_answer" && hasTools)))
    )
      finishStep()
    if (type === "text") messageId = id
    writing.set(id, { type, text: "" })
    parts.push({ type: type === "text" ? "text-start" : "reasoning-start", id })
  }
  const delta = (id: string, type: "text" | "reasoning", text: string) => {
    begin(id, type)
    const previous = writing.get(id)
    writing.set(id, { type, text: (previous?.text ?? "") + text })
    if (text !== "") parts.push({ type: type === "text" ? "text-delta" : "reasoning-delta", id, delta: text })
  }
  switch (message.method) {
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta": {
      const event = yield* decode(Delta, message.params)
      const type = message.method.includes("reasoning/") ? "reasoning" : "text"
      delta(event.itemId, type, event.delta)
      break
    }
    case "item/started":
    case "item/completed": {
      const raw = yield* decode(ItemEvent, message.params)
      const header = yield* decode(ItemHeader, raw.item)
      if (
        ![
          "agentMessage",
          "plan",
          "reasoning",
          "fileChange",
          "commandExecution",
          "mcpToolCall",
          "webSearch",
          "imageView",
          "collabAgentToolCall"
        ].includes(header.type)
      )
        break
      const item = yield* decode(Item, raw.item)
      const completed = message.method === "item/completed"
      if (item.type === "agentMessage" || item.type === "plan" || item.type === "reasoning") {
        const type = item.type === "reasoning" ? "reasoning" : "text"
        begin(item.id, type, item.phase)
        if (completed) {
          const text = item.type === "reasoning" ? (item.summary ?? item.content ?? []).join("\n") : (item.text ?? "")
          const previous = writing.get(item.id)?.text ?? ""
          if (previous === "") delta(item.id, type, text)
          parts.push({ type: type === "text" ? "text-end" : "reasoning-end", id: item.id })
          writing.delete(item.id)
        }
      } else if (item.type === "fileChange") {
        hasTools = true
        toolParts(item, raw.item, completed, calls, parts)
        if (completed && item.status === "completed") {
          for (const change of item.changes ?? []) {
            const event = change.kind.type === "add" ? "create" : change.kind.type === "delete" ? "delete" : "modify"
            if (change.kind.move_path) {
              parts.push({ type: "file-change", event: "delete", path: change.path })
              parts.push({ type: "file-change", event: "create", path: change.kind.move_path })
            } else {
              parts.push({ type: "file-change", event, path: change.path })
            }
          }
        }
      } else if (
        ["commandExecution", "mcpToolCall", "webSearch", "imageView", "collabAgentToolCall"].includes(item.type)
      ) {
        hasTools = true
        // The relay already emits calls/results with the host's original names and ids.
        if (item.type !== "mcpToolCall" || item.server !== "host") toolParts(item, raw.item, completed, calls, parts)
      }
      break
    }
    case "item/commandExecution/outputDelta": {
      const event = yield* decode(Delta, message.params)
      parts.push({
        type: "tool-result",
        id: event.itemId,
        name: "commandExecution",
        result: event.delta,
        isFailure: false,
        providerExecuted: true,
        preliminary: true
      })
      break
    }
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval": {
      const event = yield* decode(Approval, message.params)
      if (message.id === undefined) return yield* contractError("Codex approval request has no request id")
      parts.push({ type: "tool-approval-request", approvalId: JSON.stringify(message.id), toolCallId: event.itemId })
      break
    }
    case "thread/tokenUsage/updated": {
      const { tokenUsage } = yield* decode(Usage, message.params)
      const count = state.lastTotal === undefined ? tokenUsage.last : subtract(tokenUsage.total, state.lastTotal)
      return [
        {
          ...state,
          lastTotal: tokenUsage.total,
          usage: addUsage(state.usage, count),
          stepUsage: addUsage(state.stepUsage, count),
          responseComplete: true
        },
        []
      ]
    }
    case "turn/completed": {
      const { turn } = yield* decode(Completed, message.params)
      for (const [id, value] of writing) parts.push({ type: value.type === "text" ? "text-end" : "reasoning-end", id })
      writing.clear()
      const reason = turn.status === "completed" ? "stop" : turn.status === "interrupted" ? "other" : "error"
      if (turn.status === "failed") parts.push({ type: "error", error: turn.error ?? { message: "Codex turn failed" } })
      if (!["completed", "interrupted", "failed"].includes(turn.status))
        return yield* contractError(`Unexpected Codex terminal status ${turn.status}`)
      parts.push({ type: "finish-step", reason, usage: stepUsage }, { type: "finish", reason, usage: state.usage })
      break
    }
    case "error": {
      const event = yield* decode(Schema.Struct({ error: Schema.Json, willRetry: Schema.Boolean }), message.params)
      if (!event.willRetry) parts.push({ type: "error", error: event.error })
      break
    }
  }
  return [{ ...state, writing, calls, stepUsage, messageId, hasTools, responseComplete }, parts]
})

const toolParts = (
  item: Item,
  raw: Schema.Json,
  completed: boolean,
  calls: Set<string>,
  parts: Array<StreamPart.StreamPart>
) => {
  const name = item.type === "mcpToolCall" ? `${item.server ?? "mcp"}_${item.tool ?? "tool"}` : item.type
  if (!calls.has(item.id)) {
    calls.add(item.id)
    parts.push({
      type: "tool-call",
      id: item.id,
      name,
      params:
        item.arguments ??
        (item.command === undefined
          ? raw
          : { command: item.command, ...(item.cwd === undefined ? {} : { cwd: item.cwd }) }),
      providerExecuted: true
    })
  }
  if (completed)
    parts.push({
      type: "tool-result",
      id: item.id,
      name,
      result: item.error ?? item.result ?? item.aggregatedOutput ?? raw,
      isFailure: item.status === "failed" || item.status === "declined" || item.error != null,
      providerExecuted: true
    })
}

const subtract = (total: Tokens, previous: Tokens): Tokens => ({
  inputTokens: Math.max(0, total.inputTokens - previous.inputTokens),
  cachedInputTokens: Math.max(0, total.cachedInputTokens - previous.cachedInputTokens),
  cacheWriteInputTokens: Math.max(0, (total.cacheWriteInputTokens ?? 0) - (previous.cacheWriteInputTokens ?? 0)),
  outputTokens: Math.max(0, total.outputTokens - previous.outputTokens),
  reasoningOutputTokens: Math.max(0, total.reasoningOutputTokens - previous.reasoningOutputTokens)
})
const addUsage = (usage: typeof Response.Usage.Encoded, tokens: Tokens): typeof Response.Usage.Encoded => ({
  inputTokens: {
    total: (usage.inputTokens.total ?? 0) + tokens.inputTokens,
    cacheRead: (usage.inputTokens.cacheRead ?? 0) + tokens.cachedInputTokens,
    cacheWrite: (usage.inputTokens.cacheWrite ?? 0) + (tokens.cacheWriteInputTokens ?? 0),
    uncached:
      (usage.inputTokens.uncached ?? 0) +
      Math.max(0, tokens.inputTokens - tokens.cachedInputTokens - (tokens.cacheWriteInputTokens ?? 0))
  },
  outputTokens: {
    total: (usage.outputTokens.total ?? 0) + tokens.outputTokens,
    reasoning: (usage.outputTokens.reasoning ?? 0) + tokens.reasoningOutputTokens,
    text: (usage.outputTokens.text ?? 0) + Math.max(0, tokens.outputTokens - tokens.reasoningOutputTokens)
  }
})
