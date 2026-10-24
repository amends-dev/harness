import { Agent, HostToolRelay } from "@amends-dev/harness"
import { BunHttpServer, BunServices } from "@effect/platform-bun"
import { assert, it } from "@effect/vitest"
import { Effect, Exit, FileSystem, Layer, Path, Result, Scope, Stream } from "effect"
import { Prompt } from "effect/ai"
import * as Session from "../src/internal/bridge/session.ts"

const relayLayer = HostToolRelay.layer().pipe(
  Layer.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, idleTimeout: 0 }))
)
const services = relayLayer.pipe(Layer.provideMerge(BunServices.layer))
const makeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped()
  const command = path.join(root, "fake-command")
  const source = yield* fs.readFileString(path.join(import.meta.dirname, "fake-codex.js"))
  yield* fs.writeFileString(command, `#!${process.execPath}\n${source}`)
  yield* fs.chmod(command, 0o755)
  const relay = yield* HostToolRelay.HostToolRelay
  const options = {
    command,
    model: { model: "gpt-test", provider: "test" },
    models: { other: { model: "gpt-other", provider: "other", effort: "high" as const } },
    config: {},
    env: {}
  }
  const create = (agentState?: { readonly threadId: string }) =>
    Session.create(options, root, relay, {
      id: Agent.SessionId.make("session"),
      directory: root,
      history: Prompt.empty,
      agentState
    })
  const requests = fs.readFileString(path.join(root, "codex/session/requests.jsonl")).pipe(
    Effect.map((text) =>
      text
        .trim()
        .split("\n")
        .map(
          (
            line
          ): {
            method?: string
            params?: { input?: unknown; outputSchema?: unknown; collaborationMode?: unknown; modelProvider?: string }
            result?: { decision?: string }
            pid: number
          } => JSON.parse(line)
        )
    )
  )
  return { create, requests, root, fs, path }
})
const turn = (text: string) => ({
  prompt: Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text })] }),
  tools: [],
  responseFormat: { type: "text" as const }
})

it.live("streams a turn, avoids text duplication, counts tokens, and resumes native state", () =>
  Effect.gen(function* () {
    const { create, requests } = yield* makeFixture
    const session = yield* create()
    assert.isFalse(session.keptConversation)
    const parts = yield* Stream.runCollect(session.promptTurn(turn("hello")))
    assert.deepStrictEqual(
      parts.filter((part) => part.type === "text-delta").map((part) => part.delta),
      ["Hello from Codex"]
    )
    assert.deepStrictEqual(parts.at(-1), {
      type: "finish",
      reason: "stop",
      usage: {
        inputTokens: { total: 20, cacheRead: 5, cacheWrite: 0, uncached: 15 },
        outputTokens: { total: 6, reasoning: 2, text: 4 }
      }
    })
    assert.deepStrictEqual(yield* session.state, { threadId: "thread-1" })
    const resumedScope = yield* Scope.fork(yield* Effect.scope)
    const resumed = yield* create({ threadId: "thread-1" }).pipe(Scope.provide(resumedScope))
    assert.isTrue(resumed.keptConversation)
    yield* Scope.close(resumedScope, Exit.void)
    assert.strictEqual((yield* requests).filter((request) => request.method === "thread/inject_items").length, 1)
  }).pipe(Effect.scoped, Effect.provide(services))
)

it.live("refreshes tool catalogs and completes host tool calls through the shared relay", () =>
  Effect.gen(function* () {
    const { create } = yield* makeFixture
    const session = yield* create()
    const parts = yield* session
      .promptTurn({
        ...turn("tool"),
        tools: [{ name: "echo", parameters: { type: "object", properties: { value: { type: "string" } } } }]
      })
      .pipe(
        Stream.tap((part) =>
          part.type === "tool-call" && !part.providerExecuted
            ? session.submitToolResult({ id: part.id, name: part.name, result: "host result", isFailure: false })
            : Effect.void
        ),
        Stream.runCollect
      )
    assert.isTrue(
      parts.some((part) => part.type === "tool-call" && part.name === "echo" && part.providerExecuted !== true)
    )
    assert.isTrue(parts.some((part) => part.type === "text-delta" && part.delta === "host result"))
    const again = yield* Stream.runCollect(session.promptTurn(turn("hello")))
    assert.isTrue(again.some((part) => part.type === "finish"))
  }).pipe(Effect.scoped, Effect.provide(services))
)

it.live("forwards native approval decisions and interrupts abandoned turns", () =>
  Effect.gen(function* () {
    const { create, requests } = yield* makeFixture
    const session = yield* create()
    const parts = yield* session.promptTurn(turn("approve")).pipe(
      Stream.tap((part) =>
        part.type === "tool-approval-request"
          ? session.approve({ approvalId: part.approvalId, approved: false })
          : Effect.void
      ),
      Stream.runCollect
    )
    assert.isTrue(parts.some((part) => part.type === "tool-result" && part.isFailure))
    yield* session.promptTurn(turn("wait")).pipe(Stream.take(2), Stream.runDrain)
    assert.isTrue((yield* requests).some((request) => request.method === "turn/interrupt"))
  }).pipe(Effect.scoped, Effect.provide(services))
)

it.live("preserves explicit model failures, invalid output, and unsupported compaction", () =>
  Effect.gen(function* () {
    const { create } = yield* makeFixture
    const session = yield* create()
    const failed = yield* Stream.runCollect(session.promptTurn(turn("failed")))
    assert.isTrue(failed.some((part) => part.type === "finish" && part.reason === "error"))
    const malformed = yield* Stream.runCollect(session.promptTurn(turn("malformed"))).pipe(Effect.result)
    assert.isTrue(Result.isFailure(malformed))
    const compact = yield* session.compact().pipe(Effect.result)
    assert.isTrue(Result.isFailure(compact))
  }).pipe(Effect.scoped, Effect.provide(services))
)

it.live("restarts for changed provider/instructions, applies JSON schema, and deletes state", () =>
  Effect.gen(function* () {
    const { create, requests, root, fs, path } = yield* makeFixture
    const session = yield* create()
    yield* Stream.runDrain(
      session.promptTurn({
        ...turn("hello"),
        model: "other",
        instructions: "Be concise",
        responseFormat: { type: "json", objectName: "answer", schema: { type: "object" } }
      })
    )
    const recorded = yield* requests
    assert.isTrue(new Set(recorded.map((request) => request.pid)).size > 1)
    assert.isTrue(
      recorded.some((request) => request.method === "thread/resume" && request.params?.modelProvider === "other")
    )
    assert.deepStrictEqual(recorded.find((request) => request.method === "turn/start")?.params?.outputSchema, {
      type: "object"
    })
    yield* session.destroy
    assert.isFalse(yield* fs.exists(path.join(root, "codex/session/thread.json")))
  }).pipe(Effect.scoped, Effect.provide(services))
)
