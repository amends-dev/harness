import { GenerateResult } from "@amends-dev/harness"
import { expect, it } from "@effect/vitest"
import { make } from "../src/internal/bridge/turn.ts"
import { assistant, message, partial, result, usage } from "./fixtures.ts"

it("streams text once and defers the step boundary until native tools have answered", () => {
  const turn = make(new Set(), false)
  const events = [
    partial({ type: "message_start", message: { id: "m1", usage } }),
    partial({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    partial({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "reading" } }),
    partial({ type: "content_block_stop", index: 0 }),
    assistant([
      { type: "text", text: "reading" },
      { type: "tool_use", id: "call", name: "Read", input: { file_path: "README.md" } }
    ]),
    partial({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 7, input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null }
    }),
    partial({ type: "message_stop" }),
    message({
      type: "user",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "call", content: "contents" }] }
    }),
    partial({ type: "message_start", message: { id: "m2", usage } }),
    partial({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }),
    result()
  ]
  const parts = events.flatMap(turn.consume)
  expect(
    parts
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("")
  ).toBe("reading")
  const step = parts.findIndex((part) => part.type === "finish-step")
  expect(parts[step - 1]).toMatchObject({ type: "tool-result", id: "call", providerExecuted: true })
  expect(parts[step]).toMatchObject({
    reason: "tool-calls",
    usage: { inputTokens: { total: 13, cacheRead: 2, cacheWrite: 1 }, outputTokens: { total: 7 } }
  })
})
it("omits provider echoes of host tools and subagent prose", () => {
  const turn = make(new Set(["mcp__host__lookup"]), false)
  expect(turn.consume(assistant([{ type: "tool_use", id: "host", name: "mcp__host__lookup", input: {} }]))).toEqual([])
  expect(
    turn.consume(
      message({
        type: "user",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_result", tool_use_id: "host", content: "ok" }] }
      })
    )
  ).toEqual([])
  expect(turn.consume(assistant([{ type: "text", text: "nested" }], { parent_tool_use_id: "task" }))).toEqual([])
})
it("uses structured output as the last step and rejects missing output", () => {
  const turn = make(new Set(), true)
  const parts = [
    ...turn.consume(assistant([{ type: "text", text: "I checked it" }])),
    ...turn.consume(result({ structured_output: { ok: true } }))
  ]
  expect(new GenerateResult.GenerateResult(parts).text).toBe('{"ok":true}')
  expect(make(new Set(), true).consume(result()).at(-1)).toMatchObject({ type: "finish", reason: "error" })
})
it("marks provider failures and reasoning as such", () => {
  const turn = make(new Set(), false)
  const parts = [
    ...turn.consume(
      assistant([{ type: "thinking", thinking: "considering", signature: "sig" }], { error: "rate_limit" })
    ),
    ...turn.consume(result({ is_error: true, result: "limited" }))
  ]
  expect(parts.find((part) => part.type === "reasoning-end")).toMatchObject({
    metadata: { anthropic: { signature: "sig" } }
  })
  expect(parts.filter((part) => part.type === "error")).toHaveLength(1)
  expect(parts.at(-1)).toMatchObject({ reason: "error" })
})
