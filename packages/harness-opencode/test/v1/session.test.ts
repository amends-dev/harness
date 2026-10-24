import { type Bridge, GenerateResult, HostToolRelay, type StreamPart } from "@amends-dev/harness"
import { SessionId } from "@amends-dev/harness/Agent"
import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Deferred, Effect, Layer, Option, Schema, Stream } from "effect"
import { Prompt } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process"
import * as Driver from "../../src/internal/bridge/driver.ts"
import { makeCreateSession } from "../../src/internal/bridge/v1/session.ts"
import { makeFakeServerProcesses } from "../fakes.ts"
import { answerEvents, eventsOf, type FakeOpencodeOptions, type FakeTurn, makeFakeOpencode } from "./fakes.ts"

const id = SessionId.make("session-one")
const directory = "/work/session-one"

/**
 * opencode's driver over opencode 1's session API, as a bridge runs it, whose server is a fake of
 * opencode 1 that runs each turn with `runTurn`, and whose host tools go through a relay without a
 * transport, as the test answers its messages.
 */
const createSession = (
  runTurn: (turn: FakeTurn) => Effect.Effect<void>,
  options: FakeOpencodeOptions & {
    readonly history?: Prompt.Prompt
    readonly relay?: HostToolRelay.Relay
  } = {}
) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeOpencode(runTurn, options)
    const processes = yield* makeFakeServerProcesses(`http://127.0.0.1:${fake.port}`)
    const relay = options.relay ?? (yield* HostToolRelay.make())
    const relayService = { url: "http://127.0.0.1:1/mcp", open: relay.open }
    const driver = yield* Driver.make(
      "opencode",
      {
        model: { providerID: "opencode", id: "default-model" },
        models: {
          other: { providerID: "opencode", id: "other-model" },
          deep: { providerID: "opencode", id: "default-model", variant: "amends-high" }
        },
        command: "opencode",
        config: {},
        env: {}
      },
      makeCreateSession(relayService)
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, processes.spawner))
    const session = yield* driver.createSession({
      id,
      directory,
      history: options.history ?? Prompt.empty
    })
    return { fake, driver, relay, session }
  })

const turnOptions = (text: string, options: Partial<Bridge.TurnOptions> = {}): Bridge.TurnOptions => ({
  prompt: Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text })] }),
  tools: [],
  responseFormat: { type: "text" },
  ...options
})

const runTurn = (session: Bridge.DriverSession, text: string, options?: Partial<Bridge.TurnOptions>) =>
  Stream.runCollect(session.promptTurn(turnOptions(text, options)))

const textOf = (parts: ReadonlyArray<StreamPart.StreamPart>) => new GenerateResult.GenerateResult(parts).text

/** A turn that answers `text` in one step. */
const answer = (text: string) => (turn: FakeTurn) => turn.publish(...answerEvents(turn.sessionID, text))

/** The bodies the fake took for requests to paths that end with `suffix`. */
const bodiesTo = (fake: { readonly bodies: ReadonlyArray<readonly [string, unknown]> }, suffix: string) =>
  fake.bodies.filter(([path]) => path.endsWith(suffix)).map(([, body]) => body)

const weather: Bridge.ToolDefinition = {
  name: "lookup_weather",
  description: "Looks up the weather in a city",
  parameters: { type: "object", properties: { city: { type: "string" } } }
}

const TestLayer = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)

layer(TestLayer)("opencode 1 sessions", (it) => {
  it.effect("runs a turn in the session's directory, streaming the events opencode publishes", () =>
    Effect.gen(function* () {
      const { fake, session } = yield* createSession(answer("hello"))

      const parts = yield* runTurn(session, "Say hello.")

      expect(textOf(parts)).toBe("hello")
      expect(parts.at(-1)).toMatchObject({ type: "finish", reason: "stop" })
      expect([...fake.sessions.values()].map((created) => created.directory)).toEqual([directory])
    })
  )

  it.effect("prompts with the turn's model, instructions, answer's schema, and files", () =>
    Effect.gen(function* () {
      const { fake, session } = yield* createSession(answer("{}"))
      const schema = { type: "object", properties: { city: { type: "string" } } }

      yield* Stream.runCollect(
        session.promptTurn({
          tools: [],
          prompt: Prompt.makeMessage("user", {
            content: [
              Prompt.makePart("text", { text: "Read this." }),
              Prompt.makePart("file", { mediaType: "text/plain", fileName: "a.txt", data: "aGk=" })
            ]
          }),
          model: "deep",
          instructions: "Be brief.",
          responseFormat: { type: "json", objectName: "city", schema }
        })
      )

      expect(bodiesTo(fake, "/prompt_async")).toEqual([
        {
          model: { providerID: "opencode", modelID: "default-model" },
          variant: "amends-high",
          system: "Be brief.",
          format: { type: "json_schema", schema },
          tools: { question: false },
          parts: [
            { type: "text", text: "Read this." },
            {
              type: "file",
              mime: "text/plain",
              url: "data:text/plain;base64,aGk=",
              filename: "a.txt"
            }
          ]
        }
      ])
    })
  )

  it.effect("refuses a model it has no name for, before prompting", () =>
    Effect.gen(function* () {
      const { fake, session } = yield* createSession(answer("unused"))

      const refused = yield* Effect.flip(runTurn(session, "Hi.", { model: "constructor" }))

      expect(refused.reason).toMatchObject({
        _tag: "UnsupportedError",
        description: "The opencode agent has no model named constructor"
      })
      expect(fake.requests.filter((request) => request.endsWith("/prompt_async"))).toEqual([])
    })
  )

  it.effect("aborts the turn in opencode when its stream ends before the turn does", () =>
    Effect.gen(function* () {
      const { fake, session } = yield* createSession((turn) => {
        const event = eventsOf(turn.sessionID)
        return Effect.andThen(
          turn.publish(
            event.busy(),
            event.stepStarted("msg_1"),
            event.tool("msg_1", "call_1", "bash", {
              status: "running",
              input: { command: "make" }
            })
          ),
          Effect.never
        )
      })

      const read = yield* session.promptTurn(turnOptions("Build it.")).pipe(
        Stream.takeUntil((part) => part.type === "tool-call"),
        Stream.runCollect
      )

      expect(read.at(-1)?.type).toBe("tool-call")
      expect(fake.requests.filter((request) => request.endsWith("/abort"))).toHaveLength(1)
    })
  )

  it.effect("fails a turn whose events it cannot read, and aborts it in opencode", () =>
    Effect.gen(function* () {
      const { fake, session } = yield* createSession((turn) =>
        Effect.andThen(
          turn.publish(eventsOf(turn.sessionID).busy(), {
            type: "fake.unreadable",
            properties: {}
          }),
          Effect.never
        )
      )

      const failed = yield* Effect.flip(runTurn(session, "Build it."))

      expect(failed.reason._tag).toBe("AgentContractError")
      expect(fake.requests.filter((request) => request.endsWith("/abort"))).toHaveLength(1)
    })
  )

  it.effect("writes another agent's conversation into the new session as one message", () =>
    Effect.gen(function* () {
      const history = Prompt.make([
        { role: "user", content: "Remember the codename BLUE-MARLIN-9." },
        { role: "assistant", content: [{ type: "text", text: "Noted." }] }
      ])
      const { fake, session } = yield* createSession(answer("BLUE-MARLIN-9"), { history })

      yield* runTurn(session, "What is the codename?")

      expect(bodiesTo(fake, "/message")).toEqual([
        {
          model: { providerID: "opencode", modelID: "default-model" },
          noReply: true,
          parts: [
            {
              type: "text",
              synthetic: true,
              text: [
                "This conversation continues one held earlier, which went as follows.",
                "",
                "User: Remember the codename BLUE-MARLIN-9.",
                "Assistant: Noted."
              ].join("\n")
            }
          ]
        }
      ])
      expect(session.keptConversation).toBe(false)
    })
  )

  it.effect("picks its own opencode session up again from its state, or starts another when opencode lost it", () =>
    Effect.gen(function* () {
      const { fake, driver, session } = yield* createSession(answer("hello"))
      const agentState = yield* session.state

      const again = yield* driver.createSession({
        id,
        directory,
        history: Prompt.empty,
        agentState
      })
      fake.sessions.clear()
      const lost = yield* driver.createSession({
        id,
        directory,
        history: Prompt.empty,
        agentState
      })

      const State = Schema.Struct({ sessionID: Schema.String })
      expect(again.keptConversation).toBe(true)
      expect(yield* again.state).toEqual(agentState)
      expect(lost.keptConversation).toBe(false)
      expect((yield* Schema.decodeUnknownEffect(State)(yield* lost.state)).sessionID).not.toBe(
        (yield* Schema.decodeUnknownEffect(State)(agentState)).sessionID
      )
    })
  )

  it.effect("offers the host's tools as an MCP server, connecting again when they change, streaming their calls", () =>
    Effect.gen(function* () {
      const called = yield* Deferred.make<void>()
      const answered = yield* Deferred.make<unknown>()
      const relay = yield* HostToolRelay.make()
      const { fake, session } = yield* createSession(
        (turn) =>
          Effect.gen(function* () {
            const event = eventsOf(turn.sessionID)
            if (turn.body.parts === undefined) return
            const [{ text } = { text: "" }] = turn.body.parts as Array<{ text: string }>
            if (text !== "Check the weather.") return yield* turn.publish(...answerEvents(turn.sessionID, "ok"))
            yield* turn.publish(
              event.busy(),
              event.stepStarted("msg_1"),
              event.tool("msg_1", "call_1", "host_lookup_weather", {
                status: "running",
                input: {}
              })
            )
            // opencode calls the tool through the MCP server, as its client does.
            const [, mcp] = turn.bodies.find(([path]) => path === "/mcp") ?? []
            const authorization = (mcp as { config: { headers: { authorization: string } } }).config.headers
              .authorization
            const reply = yield* relay.answer(authorization, {
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "lookup_weather", arguments: { city: "Lisbon" } }
            })
            yield* Deferred.succeed(called, undefined)
            if (HostToolRelay.Answer.$is("Events")(reply)) {
              const last = yield* Stream.runLast(reply.messages)
              yield* Deferred.succeed(answered, Option.getOrUndefined(last))
            }
            yield* turn.publish(
              event.tool("msg_1", "call_1", "host_lookup_weather", {
                status: "completed",
                input: {},
                output: "foggy",
                metadata: {}
              }),
              event.stepCompleted("msg_1", { finish: "tool-calls" }),
              ...answerEvents(turn.sessionID, "It is foggy.", "msg_2").slice(1)
            )
          }),
        { relay }
      )

      const parts = yield* session.promptTurn(turnOptions("Check the weather.", { tools: [weather] })).pipe(
        Stream.tap((part) =>
          part.type === "tool-call" && part.providerExecuted !== true
            ? session.submitToolResult({
                id: part.id,
                name: part.name,
                result: "foggy",
                isFailure: false
              })
            : Effect.void
        ),
        Stream.runCollect
      )
      yield* runTurn(session, "Again.", { tools: [weather] })
      yield* runTurn(session, "Other tools.", {
        tools: [{ name: "lookup_time", parameters: weather.parameters }]
      })
      yield* runTurn(session, "No tools.")

      yield* Deferred.await(called)
      expect(parts.filter((part) => part.type === "tool-call")).toEqual([
        expect.objectContaining({ name: "lookup_weather", params: { city: "Lisbon" } })
      ])
      expect(textOf(parts)).toBe("It is foggy.")
      expect(yield* Deferred.await(answered)).toMatchObject({
        result: { content: [{ type: "text", text: "foggy" }] }
      })
      expect(bodiesTo(fake, "/mcp")).toEqual([
        {
          name: "host",
          config: {
            type: "remote",
            url: "http://127.0.0.1:1/mcp",
            headers: { authorization: expect.stringMatching(/^Bearer \w+$/) }
          }
        }
      ])
      expect(fake.requests.filter((request) => request.startsWith("POST /mcp"))).toEqual([
        "POST /mcp",
        "POST /mcp/host/connect",
        "POST /mcp/host/disconnect"
      ])
    })
  )

  it.effect("answers a tool's request for permission as the host approves or refuses it", () =>
    Effect.gen(function* () {
      const { fake, session } = yield* createSession(answer("unused"))

      yield* session.approve({ approvalId: "per_1", approved: true })
      yield* session.approve({ approvalId: "per_2", approved: false, reason: "Not now" })

      expect(fake.bodies.filter(([path]) => path.startsWith("/permission"))).toEqual([
        ["/permission/per_1/reply", { reply: "once" }],
        ["/permission/per_2/reply", { reply: "reject", message: "Not now" }]
      ])
    })
  )

  it.effect("refuses the model's questions to the user, which no host answers", () =>
    Effect.gen(function* () {
      const { fake, session } = yield* createSession((turn) =>
        turn.publish(eventsOf(turn.sessionID).question("que_1"), ...answerEvents(turn.sessionID, "ok"))
      )

      yield* runTurn(session, "Ask me.")

      expect(fake.requests).toContain("POST /question/que_1/reject")
    })
  )

  it.effect("compacts with the model of the last step, returning the summary opencode wrote", () =>
    Effect.gen(function* () {
      const { fake, session } = yield* createSession(answer("unused"), { summary: "We spoke." })
      const [opencodeSession] = fake.sessions.values()
      opencodeSession?.messages.push({
        info: {
          id: "msg_1",
          sessionID: "ses_fake1",
          role: "assistant",
          providerID: "opencode",
          modelID: "other-model",
          time: { created: 1, completed: 2 }
        },
        parts: []
      })

      const compaction = yield* session.compact()

      expect(compaction).toEqual({ type: "compaction", trigger: "manual", summary: "We spoke." })
      expect(bodiesTo(fake, "/summarize")).toEqual([{ providerID: "opencode", modelID: "other-model" }])
    })
  )

  it.effect("refuses to compact with instructions, and fails when opencode fails to summarize", () =>
    Effect.gen(function* () {
      const { session } = yield* createSession(answer("unused"), { summary: "failed" })

      const withInstructions = yield* Effect.flip(session.compact("Keep the codename."))
      const failed = yield* Effect.flip(session.compact())

      expect(withInstructions.reason._tag).toBe("UnsupportedError")
      expect(failed.reason).toMatchObject({
        _tag: "UnknownError",
        description: "opencode failed to summarize the conversation: No model"
      })
    })
  )

  it.effect("deletes the session in opencode when destroyed", () =>
    Effect.gen(function* () {
      const { fake, session } = yield* createSession(answer("hello"))

      yield* session.destroy
      yield* session.destroy

      expect(fake.sessions.size).toBe(0)
    })
  )
})
