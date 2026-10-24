import { GenerateResult, HostToolRelay } from "@amends-dev/harness"
import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Deferred, Effect, Fiber, Queue, Stream } from "effect"
import { Prompt } from "effect/ai"
import { TestClock } from "effect/testing"
import { answer, assistant, createSession, makeFake, result, turnOptions, usage } from "./fixtures.ts"

layer(BunServices.layer)("Claude SDK sessions", (it) => {
  it.effect("resumes native state and starts from portable history when it is lost", () =>
    Effect.gen(function* () {
      const { fake, driver, session, sessionOptions } = yield* createSession()
      yield* session.promptTurn(turnOptions()).pipe(Stream.runDrain)
      const state = yield* session.state
      const resumed = yield* driver.createSession({ ...sessionOptions, agentState: state })
      expect(resumed.keptConversation).toBe(true)
      yield* resumed.promptTurn(turnOptions("next", { model: "other", instructions: "Be brief" })).pipe(Stream.runDrain)
      expect(fake.calls[1]?.options).toMatchObject({
        resume: fake.calls[0]?.options.sessionId,
        model: "other-model",
        effort: "high",
        systemPrompt: { append: "Be brief" },
        cwd: "/work/test",
        env: { CUSTOM: "yes" }
      })
      fake.sessions.clear()
      const history = Prompt.make([{ role: "user", content: "remember pears" }])
      const restored = yield* driver.createSession({ ...sessionOptions, history, agentState: state })
      expect(restored.keptConversation).toBe(false)
      yield* restored.promptTurn(turnOptions()).pipe(Stream.runDrain)
      const request = fake.calls[2]?.prompt
      if (request === undefined || typeof request === "string") throw new Error("Missing streamed prompt")
      const input = yield* Effect.promise(async () => {
        const messages = []
        for await (const message of request) messages.push(message)
        return messages
      })
      expect(JSON.stringify(input)).toContain("remember pears")
      expect(fake.closed()).toBe(3)
      yield* restored.destroy
      expect(fake.deleted).toHaveLength(1)
    })
  )
  it.effect("asks native approval, preserves denial, and closes the query", () =>
    Effect.gen(function* () {
      const fake = makeFake(async function* ({ options }) {
        const permission = await options.canUseTool?.(
          "Bash",
          { command: "rm file" },
          { signal: new AbortController().signal, toolUseID: "native", requestId: "permission-native" }
        )
        expect(permission).toEqual({ behavior: "deny", message: "keep it" })
        yield* answer("refused")
      })
      const { session } = yield* createSession(fake)
      const parts = yield* session.promptTurn(turnOptions()).pipe(
        Stream.tap((part) =>
          part.type === "tool-approval-request"
            ? session.approve({ approvalId: part.approvalId, approved: false, reason: "keep it" })
            : Effect.void
        ),
        Stream.runCollect
      )
      expect(parts.find((part) => part.type === "tool-call")).toMatchObject({ id: "native", providerExecuted: true })
      expect(new GenerateResult.GenerateResult(parts).text).toBe("refused")
      expect(fake.closed()).toBe(1)
    })
  )
  it.effect("configures host relay tools and JSON output for every query", () =>
    Effect.gen(function* () {
      const fake = makeFake(async function* ({ options }) {
        expect(options.allowedTools).toEqual(["mcp__host__lookup"])
        expect(options.mcpServers?.host).toMatchObject({ type: "http", url: "http://127.0.0.1:9000/mcp" })
        expect(options.outputFormat).toEqual({ type: "json_schema", schema: { type: "object" } })
        yield result({ structured_output: { answer: 42 } })
      })
      const { session } = yield* createSession(fake)
      const parts = yield* session
        .promptTurn(
          turnOptions("ask", {
            tools: [{ name: "lookup", parameters: { type: "object" } }],
            responseFormat: { type: "json", objectName: "Answer", schema: { type: "object" } }
          })
        )
        .pipe(Stream.runCollect)
      expect(new GenerateResult.GenerateResult(parts).text).toBe('{"answer":42}')
    })
  )
  it.effect("returns manual compaction summaries through the SDK hook", () =>
    Effect.gen(function* () {
      const fake = makeFake(async function* ({ prompt, options }) {
        if (typeof prompt === "string") {
          expect(prompt).toBe("/compact preserve filenames")
          await options.hooks?.PostCompact?.[0]?.hooks[0]?.(
            {
              hook_event_name: "PostCompact",
              trigger: "manual",
              compact_summary: "summary",
              session_id: "id",
              transcript_path: "/tmp/session",
              cwd: "/work/test"
            },
            undefined,
            { signal: new AbortController().signal }
          )
        }
        yield result({ usage })
      })
      const { session } = yield* createSession(fake)
      yield* session.promptTurn(turnOptions()).pipe(Stream.runDrain)
      expect(yield* session.compact("preserve filenames")).toMatchObject({ summary: "summary", trigger: "manual" })
    })
  )
  it.effect("emits automatic compaction summaries between steps and relative file changes", () =>
    Effect.gen(function* () {
      const fake = makeFake(async function* ({ options }) {
        yield assistant([{ type: "text", text: "before" }])
        const context = { session_id: "id", transcript_path: "/tmp/session", cwd: "/work/test" }
        const signal = new AbortController().signal
        await options.hooks?.PostCompact?.[0]?.hooks[0]?.(
          { ...context, hook_event_name: "PostCompact", trigger: "auto", compact_summary: "remember the plan" },
          undefined,
          { signal }
        )
        await options.hooks?.FileChanged?.[0]?.hooks[0]?.(
          { ...context, hook_event_name: "FileChanged", event: "add", file_path: "/work/test/result.txt" },
          undefined,
          { signal }
        )
        yield result()
      })
      const { session } = yield* createSession(fake)
      const parts = yield* session.promptTurn(turnOptions()).pipe(Stream.runCollect)
      const compact = parts.findIndex((part) => part.type === "compaction")
      expect(parts[compact - 1]?.type).toBe("finish-step")
      expect(parts[compact]).toMatchObject({ trigger: "auto", summary: "remember the plan" })
      expect(parts.find((part) => part.type === "file-change")).toMatchObject({ event: "create", path: "result.txt" })
    })
  )
  it.effect("rejects compaction that reports no summary", () =>
    Effect.gen(function* () {
      const { session } = yield* createSession()
      yield* session.promptTurn(turnOptions()).pipe(Stream.runDrain)
      const error = yield* session.compact().pipe(Effect.flip)
      expect(error.reason._tag).toBe("AgentContractError")
    })
  )
  it.effect("fails unknown models and malformed saved state before starting a query", () =>
    Effect.gen(function* () {
      const { session, driver, sessionOptions, fake } = yield* createSession()
      const model = yield* session
        .promptTurn(turnOptions("hello", { model: "missing" }))
        .pipe(Stream.runDrain, Effect.flip)
      expect(model.reason._tag).toBe("UnsupportedError")
      const state = yield* driver
        .createSession({ ...sessionOptions, agentState: { sessionId: "not-a-uuid" } })
        .pipe(Effect.flip)
      expect(state.reason._tag).toBe("AgentContractError")
      expect(fake.calls).toHaveLength(0)
    })
  )
  it.effect("interrupts and closes a query while a native approval waits", () =>
    Effect.gen(function* () {
      const asked = yield* Deferred.make<void>()
      const fake = makeFake(async function* ({ options }) {
        await options.canUseTool?.(
          "Bash",
          {},
          { signal: new AbortController().signal, toolUseID: "waiting", requestId: "permission-waiting" }
        )
        yield result()
      })
      const { session } = yield* createSession(fake)
      const fiber = yield* session.promptTurn(turnOptions()).pipe(
        Stream.runForEach((part) =>
          part.type === "tool-approval-request" ? Deferred.succeed(asked, undefined) : Effect.void
        ),
        Effect.forkScoped
      )
      yield* Deferred.await(asked)
      yield* Fiber.interrupt(fiber)
      expect(fake.interrupted()).toBe(1)
      expect(fake.closed()).toBe(1)
    })
  )

  it.effect("closes an unresponsive SDK query after the interrupt deadline", () =>
    Effect.gen(function* () {
      const asked = yield* Deferred.make<void>()
      const interruptStarted = yield* Queue.unbounded<void>()
      const fake = makeFake(async function* ({ options }) {
        await options.canUseTool?.(
          "Bash",
          {},
          { signal: new AbortController().signal, toolUseID: "waiting", requestId: "permission-waiting" }
        )
        yield result()
      })
      const originalQuery = fake.sdk.query
      const sdk = {
        ...fake.sdk,
        query: (invocation: Parameters<typeof originalQuery>[0]) => ({
          ...originalQuery(invocation),
          interrupt: () => {
            Queue.offerUnsafe(interruptStarted, undefined)
            return new Promise(() => {})
          }
        })
      }
      const { session } = yield* createSession({ ...fake, sdk })
      const running = yield* session.promptTurn(turnOptions()).pipe(
        Stream.runForEach((part) =>
          part.type === "tool-approval-request" ? Deferred.succeed(asked, undefined) : Effect.void
        ),
        Effect.forkScoped
      )
      yield* Deferred.await(asked)
      const stopping = yield* Fiber.interrupt(running).pipe(Effect.forkScoped)
      yield* Queue.take(interruptStarted)
      yield* TestClock.adjust("5 seconds")
      yield* Fiber.join(stopping)
      expect(fake.closed()).toBe(1)
    })
  )
  it.effect("interleaves native approvals and host MCP execution without provider echoes", () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const done = Promise.withResolvers<void>()
      const fake = makeFake(async function* ({ options }) {
        const permission = await options.canUseTool?.(
          "Read",
          { file_path: "README.md" },
          { signal: new AbortController().signal, toolUseID: "native-read", requestId: "read-request" }
        )
        expect(permission?.behavior).toBe("allow")
        yield assistant([
          { type: "text", text: "ready" },
          { type: "tool_use", id: "sdk-host-call", name: "mcp__host__lookup", input: { key: "a" } }
        ])
        await done.promise
        yield result()
      })
      const { relay, session } = yield* createSession(fake)
      // The existing session's MCP token is carried only in the SDK options.
      const running = yield* session
        .promptTurn(turnOptions("look up", { tools: [{ name: "lookup", parameters: { type: "object" } }] }))
        .pipe(
          Stream.tap((part) =>
            part.type === "tool-approval-request"
              ? session.approve({ approvalId: part.approvalId, approved: true })
              : part.type === "text-delta"
                ? Deferred.succeed(ready, undefined)
                : part.type === "tool-call" && !part.providerExecuted
                  ? session.submitToolResult({ id: part.id, name: part.name, result: { value: 42 }, isFailure: false })
                  : Effect.void
          ),
          Stream.runCollect,
          Effect.forkScoped
        )
      yield* Deferred.await(ready)
      const config = fake.calls[0]?.options.mcpServers?.host
      if (config === undefined || !("headers" in config)) throw new Error("Missing relay configuration")
      const response = yield* relay.answer(config.headers?.authorization, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "lookup", arguments: { key: "a" } }
      })
      if (!HostToolRelay.Answer.$is("Events")(response)) throw new Error("Expected MCP result stream")
      const replies = yield* response.messages.pipe(Stream.runCollect)
      expect(JSON.stringify(replies)).toContain("42")
      yield* Effect.sync(() => done.resolve())
      const parts = yield* Fiber.join(running)
      expect(parts.filter((part) => part.type === "tool-call").map((part) => part.name)).toEqual(["Read", "lookup"])
    })
  )
  it.effect("fails a truncated SDK stream instead of reporting successful completion", () =>
    Effect.gen(function* () {
      const { session } = yield* createSession(
        makeFake(async function* () {
          yield* []
        })
      )
      const error = yield* session.promptTurn(turnOptions()).pipe(Stream.runDrain, Effect.flip)
      expect(error.reason._tag).toBe("UnavailableError")
    })
  )
})
