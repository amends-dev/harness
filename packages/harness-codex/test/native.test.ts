import { Agent, GenerateResult, HostToolRelay } from "@amends-dev/harness"
import { BunHttpServer, BunServices } from "@effect/platform-bun"
import { assert, it } from "@effect/vitest"
import { Effect, Exit, FileSystem, Layer, Schema, Scope, Stream } from "effect"
import { Prompt } from "effect/ai"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Session from "../src/internal/bridge/session.ts"

/** Optional protocol check against Codex 0.157.1 on PATH. Inference stays on a local scripted endpoint. */
const enabled = process.env.AMENDS_TEST_CODEX_NATIVE === "1"
const relayLayer = HostToolRelay.layer().pipe(
  Layer.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, idleTimeout: 0 }))
)
const services = relayLayer.pipe(Layer.provideMerge(BunServices.layer))

it.live.skipIf(!enabled)(
  "runs and restores a native Codex thread against a local Responses endpoint",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      assert.strictEqual((yield* spawner.string(ChildProcess.make("codex", ["--version"]))).trim(), "codex-cli 0.157.1")
      const directory = yield* fs.makeTempDirectoryScoped()
      const requests: Array<unknown> = []
      const providers: Array<string | null> = []
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: async (request) => {
              if (!new URL(request.url).pathname.endsWith("/responses"))
                return new Response("not found", { status: 404 })
              requests.push(await request.json())
              providers.push(request.headers.get("x-amends-provider"))
              const toolCall = requests.length === 2
              const commentary = {
                id: "commentary-1",
                type: "message",
                role: "assistant",
                phase: "commentary",
                content: [{ type: "output_text", text: "I'll use the host tool." }]
              }
              const item = toolCall
                ? {
                    id: "function-1",
                    type: "function_call",
                    call_id: "host-1",
                    name: "echo",
                    namespace: "mcp__host",
                    arguments: JSON.stringify({ value: "native tool" })
                  }
                : {
                    id: "message-1",
                    type: "message",
                    role: "assistant",
                    phase: "final_answer",
                    content: [{ type: "output_text", text: "Native response" }]
                  }
              const events = [
                { type: "response.created", response: { id: "response-1", status: "in_progress", output: [] } },
                ...(toolCall
                  ? [
                      { type: "response.output_item.added", output_index: 0, item: { ...commentary, content: [] } },
                      {
                        type: "response.output_text.delta",
                        output_index: 0,
                        item_id: commentary.id,
                        content_index: 0,
                        delta: "I'll use the host tool."
                      },
                      { type: "response.output_item.done", output_index: 0, item: commentary }
                    ]
                  : []),
                {
                  type: "response.output_item.added",
                  output_index: toolCall ? 1 : 0,
                  item: { ...item, ...(toolCall ? {} : { content: [] }) }
                },
                ...(toolCall
                  ? []
                  : [
                      {
                        type: "response.output_text.delta",
                        item_id: item.id,
                        output_index: 0,
                        content_index: 0,
                        delta: "Native response"
                      }
                    ]),
                { type: "response.output_item.done", output_index: toolCall ? 1 : 0, item },
                {
                  type: "response.completed",
                  response: {
                    id: "response-1",
                    status: "completed",
                    output: toolCall ? [commentary, item] : [item],
                    usage: {
                      input_tokens: 20,
                      output_tokens: 4,
                      total_tokens: 24,
                      input_tokens_details: { cached_tokens: 0 },
                      output_tokens_details: { reasoning_tokens: 0 }
                    }
                  }
                }
              ]
              return new Response(
                events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
                { headers: { "content-type": "text/event-stream" } }
              )
            }
          })
        ),
        (server) =>
          Effect.promise(async () => {
            await server.stop(true)
          })
      )
      const relay = yield* HostToolRelay.HostToolRelay
      const options = {
        command: "codex",
        model: { model: "gpt-5.4", provider: "local" },
        models: { other: { model: "gpt-5.4", provider: "other" } },
        config: {
          "model_providers.local": {
            name: "local",
            base_url: `http://127.0.0.1:${server.port}/v1`,
            wire_api: "responses",
            requires_openai_auth: false,
            supports_websockets: false
          },
          "model_providers.other": {
            name: "other",
            base_url: `http://127.0.0.1:${server.port}/v1`,
            wire_api: "responses",
            requires_openai_auth: false,
            supports_websockets: false,
            http_headers: { "x-amends-provider": "other" }
          }
        },
        env: {}
      }
      const firstScope = yield* Scope.fork(yield* Effect.scope)
      const first = yield* Session.create(options, directory, relay, {
        id: Agent.SessionId.make("native"),
        directory,
        history: Prompt.make([{ role: "user", content: "Remember imported history" }])
      }).pipe(Scope.provide(firstScope))
      const state = yield* Schema.decodeUnknownEffect(Schema.Struct({ threadId: Schema.String }))(yield* first.state)
      const parts = yield* Stream.runCollect(
        first.promptTurn({
          prompt: Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "Hello" })] }),
          tools: [],
          responseFormat: { type: "text" }
        })
      )
      assert.isTrue(parts.some((part) => part.type === "text-delta" && part.delta === "Native response"))
      assert.strictEqual(parts.at(-1)?.type, "finish")
      assert.isTrue(JSON.stringify(requests).includes("Remember imported history"))
      yield* Scope.close(firstScope, Exit.void)
      const resumed = yield* Session.create(options, directory, relay, {
        id: Agent.SessionId.make("native"),
        directory,
        history: Prompt.empty,
        agentState: state
      })
      assert.isTrue(resumed.keptConversation)
      const toolParts = yield* resumed
        .promptTurn({
          prompt: Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "Use echo" })] }),
          model: "other",
          tools: [
            {
              name: "echo",
              parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }
            }
          ],
          responseFormat: { type: "text" }
        })
        .pipe(
          Stream.tap((part) =>
            part.type === "tool-call" && !part.providerExecuted
              ? resumed.submitToolResult({ id: part.id, name: part.name, result: "relay result", isFailure: false })
              : Effect.void
          ),
          Stream.runCollect
        )
      assert.isTrue(toolParts.some((part) => part.type === "tool-call" && part.name === "echo"))
      const answer = new GenerateResult.GenerateResult(toolParts)
      assert.strictEqual(answer.text, "Native response")
      assert.strictEqual(answer.steps.length, 2)
      assert.isTrue(
        answer.steps[0]?.parts.some((part) => part.type === "text" && part.text === "I'll use the host tool.")
      )
      assert.strictEqual(answer.steps[0]?.finish?.usage.inputTokens.total, 20)
      assert.strictEqual(answer.steps[1]?.finish?.usage.inputTokens.total, 20)
      assert.isTrue(JSON.stringify(requests).includes("relay result"))
      assert.deepStrictEqual(providers, [null, "other", "other"])
      yield* resumed.destroy
    }).pipe(Effect.scoped, Effect.provide(services)),
  { timeout: 30000 }
)
