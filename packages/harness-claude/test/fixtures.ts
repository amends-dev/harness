import { type Bridge, HostToolRelay } from "@amends-dev/harness"
import { SessionId } from "@amends-dev/harness/Agent"
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect } from "effect"
import { Prompt } from "effect/ai"
import * as Driver from "../src/internal/bridge/driver.ts"
import type { Sdk } from "../src/internal/bridge/sdk.ts"

export const message = (value: unknown) => value as SDKMessage
export const usage = { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 }
export const result = (fields: Record<string, unknown> = {}) =>
  message({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    stop_reason: "end_turn",
    usage,
    ...fields
  })
export const assistant = (content: ReadonlyArray<unknown>, fields: Record<string, unknown> = {}) =>
  message({
    type: "assistant",
    parent_tool_use_id: null,
    uuid: "message-uuid",
    message: { id: "m1", content, stop_reason: "end_turn", usage },
    ...fields
  })
export const partial = (event: unknown) => message({ type: "stream_event", parent_tool_use_id: null, event })
export const answer = (text: string) => [assistant([{ type: "text", text }]), result({ result: text })]
export const turnOptions = (text = "hello", options: Partial<Bridge.TurnOptions> = {}): Bridge.TurnOptions => ({
  prompt: Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text })] }),
  tools: [],
  responseFormat: { type: "text" },
  ...options
})
export interface Invocation {
  readonly prompt: string | AsyncIterable<SDKUserMessage>
  readonly options: Options
}
export const makeFake = (
  run: (invocation: Invocation) => AsyncIterable<SDKMessage> = async function* () {
    yield* answer("done")
  }
) => {
  const calls: Array<Invocation> = []
  const sessions = new Set<string>()
  const deleted: Array<string> = []
  let closed = 0
  let interrupted = 0
  const sdk: Sdk = {
    hasSession: async (id) => sessions.has(id),
    deleteSession: async (id) => {
      sessions.delete(id)
      deleted.push(id)
    },
    query: (invocation) => {
      calls.push(invocation)
      return {
        [Symbol.asyncIterator]: async function* () {
          const sessionId = invocation.options.sessionId ?? invocation.options.resume
          if (sessionId !== undefined) sessions.add(sessionId)
          yield message({ type: "system", subtype: "init", session_id: sessionId })
          yield* run(invocation)
        },
        interrupt: async () => {
          interrupted++
        },
        close: () => {
          closed++
        }
      }
    }
  }
  return { sdk, calls, sessions, deleted, closed: () => closed, interrupted: () => interrupted }
}
export const createSession = (fake = makeFake(), options: Partial<Bridge.CreateSessionOptions> = {}) =>
  Effect.gen(function* () {
    const relay = yield* HostToolRelay.make()
    const driver = yield* Driver.make(
      fake.sdk,
      {
        model: { model: "claude-test", env: { ANTHROPIC_API_KEY: "key" } },
        models: { other: { model: "other-model", env: {}, effort: "high" } },
        env: { CUSTOM: "yes" }
      },
      { url: "http://127.0.0.1:9000/mcp", open: relay.open },
      "/bin/claude",
      { HOME: "/home/test", PATH: "/bin" }
    )
    const sessionOptions: Bridge.CreateSessionOptions = {
      id: SessionId.make("test"),
      directory: "/work/test",
      history: Prompt.empty,
      ...options
    }
    return { driver, session: yield* driver.createSession(sessionOptions), relay, fake, sessionOptions }
  })
