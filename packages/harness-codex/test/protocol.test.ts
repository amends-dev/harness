import { HarnessError } from "@amends-dev/harness"
import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Queue, Redacted, Schema, Stream } from "effect"
import { Prompt } from "effect/ai"
import * as TestClock from "effect/testing/TestClock"
import { historyOf, inputOf } from "../src/internal/bridge/prompt.ts"
import * as Rpc from "../src/internal/bridge/rpc.ts"
import { tomlOf } from "../src/internal/bridge/session.ts"
import * as Turn from "../src/internal/bridge/turn.ts"
import { modelsOf } from "../src/internal/models.ts"

it.effect("encodes endpoint credentials, headers, effort and context, rejecting unsupported protocols and caps", () =>
  Effect.gen(function* () {
    const model = {
      provider: "openai",
      model: "gpt-test",
      protocol: "openai-responses" as const,
      url: "https://example.test/v1/",
      apiKey: Redacted.make("secret"),
      headers: { "x-key": Redacted.make("header") },
      effort: "max" as const,
      contextWindow: 100000
    }
    const options = yield* modelsOf({ model })
    assert.strictEqual(options.env.AMENDS_CODEX_KEY_amends_0, "secret")
    assert.strictEqual(options.model.contextWindow, 100000)
    assert.deepStrictEqual(Bun.TOML.parse(yield* tomlOf(options.config)), {
      model_providers: {
        amends_0: {
          name: "amends_0",
          base_url: "https://example.test/v1",
          wire_api: "responses",
          requires_openai_auth: false,
          supports_websockets: false,
          env_key: "AMENDS_CODEX_KEY_amends_0",
          http_headers: { "x-key": "header" }
        }
      }
    })
    const protocol = yield* Effect.flip(modelsOf({ model: { ...model, protocol: "anthropic-messages" } }))
    assert.isTrue(Schema.is(HarnessError.UnsupportedError)(protocol.reason))
    const cap = yield* Effect.flip(modelsOf({ model: { ...model, maxOutputTokens: 1000 } }))
    assert.isTrue(Schema.is(HarnessError.UnsupportedError)(cap.reason))
  })
)

it.effect("imports conversation roles and tool outcomes and rejects unsupported attachments", () =>
  Effect.gen(function* () {
    const history = Prompt.make([
      { role: "system", content: "instructions" },
      { role: "user", content: "question" },
      { role: "assistant", content: [{ type: "tool-call", id: "call", name: "echo", params: { value: "hi" } }] },
      { role: "tool", content: [{ type: "tool-result", id: "call", name: "echo", result: "no", isFailure: true }] },
      { role: "assistant", content: "answer" }
    ])
    const imported = yield* historyOf(history)
    assert.deepStrictEqual(imported, [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "instructions" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "question" }] },
      { type: "function_call", name: "echo", call_id: "call", arguments: '{"value":"hi"}' },
      { type: "function_call_output", call_id: "call", output: '{"result":"no","isFailure":true}' },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }
    ])
    const image = Prompt.makeMessage("user", {
      content: [Prompt.makePart("file", { mediaType: "image/png", data: new Uint8Array([1, 2]) })]
    })
    assert.deepStrictEqual(yield* inputOf(image), [{ type: "image", url: "data:image/png;base64,AQI=" }])
    const invalid = yield* Effect.flip(
      inputOf(
        Prompt.makeMessage("user", {
          content: [Prompt.makePart("file", { mediaType: "application/pdf", data: "AA==" })]
        })
      )
    )
    assert.isTrue(Schema.is(HarnessError.UnsupportedError)(invalid.reason))
  })
)

it.effect("frames reasoning and native file changes and ignores user content", () =>
  Effect.gen(function* () {
    let state = Turn.initial()
    const parts = []
    for (const message of [
      {
        method: "item/started",
        params: { item: { type: "userMessage", id: "user", content: [{ type: "text", text: "hello" }] } }
      },
      { method: "item/reasoning/summaryTextDelta", params: { itemId: "reason", delta: "Thinking" } },
      {
        method: "item/completed",
        params: { item: { type: "reasoning", id: "reason", summary: ["Thinking"], content: [] } }
      },
      {
        method: "item/completed",
        params: {
          item: {
            type: "fileChange",
            id: "file",
            status: "completed",
            changes: [{ path: "README.md", kind: { type: "add" } }]
          }
        }
      }
    ]) {
      const [next, output] = yield* Turn.translate(state, message)
      state = next
      parts.push(...output)
    }
    assert.deepStrictEqual(parts.slice(0, 3), [
      { type: "reasoning-start", id: "reason" },
      { type: "reasoning-delta", id: "reason", delta: "Thinking" },
      { type: "reasoning-end", id: "reason" }
    ])
    assert.isTrue(
      parts.some((part) => part.type === "file-change" && part.event === "create" && part.path === "README.md")
    )
  })
)

it.effect("times out requests with the test clock and rejects invalid protocol output", () =>
  Effect.gen(function* () {
    const lines = yield* Queue.unbounded<string>()
    const sent = yield* Deferred.make<void>()
    const rpc = yield* Rpc.make(Stream.fromQueue(lines), () => Deferred.succeed(sent, undefined).pipe(Effect.asVoid))
    const request = yield* rpc.request("never").pipe(Effect.flip, Effect.forkChild)
    yield* Deferred.await(sent)
    yield* TestClock.adjust("61 seconds")
    assert.isTrue(Schema.is(HarnessError.UnavailableError)((yield* Fiber.join(request)).reason))
    const next = yield* rpc.request("next").pipe(Effect.flip, Effect.forkChild)
    yield* Queue.offer(lines, "not JSON")
    assert.isTrue(Schema.is(HarnessError.AgentContractError)((yield* Fiber.join(next)).reason))
  }).pipe(Effect.scoped)
)
