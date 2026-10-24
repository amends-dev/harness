import { type Bridge, GenerateResult, HostToolRelay, type StreamPart } from "@amends-dev/harness"
import { SessionId } from "@amends-dev/harness/Agent"
import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Deferred, Effect, Layer, Option, Schema, Stream } from "effect"
import { Prompt } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import * as Driver from "../../src/internal/bridge/driver.ts"
import { makeCreateSession } from "../../src/internal/bridge/v2/session.ts"
import { makeFakeServerProcesses } from "../fakes.ts"
import { answerEvents, eventsOf, type FakeOpencodeOptions, type FakeTurn, makeFakeOpencode } from "./fakes.ts"

const id = SessionId.make("session-one")
const directory = "/work/session-one"

/**
 * opencode's driver over opencode 2's session API, as a bridge runs it, whose server is a fake of
 * opencode 2 that runs each turn with `runTurn`, and whose host tools go through a relay without a
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
      "opencode2",
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
const answer = (text: string) => (turn: FakeTurn) => turn.publish(...answerEvents(turn.sessionID, turn.inboxID, text))

/** The bodies the fake took for requests to paths that end with `suffix`. */
const bodiesTo = (fake: { readonly bodies: ReadonlyArray<readonly [string, unknown]> }, suffix: string) =>
  fake.bodies.filter(([path]) => path.endsWith(suffix)).map(([, body]) => body)

const weather: Bridge.ToolDefinition = {
  name: "lookup_weather",
  description: "Looks up the weather in a city",
  parameters: { type: "object", properties: { city: { type: "string" } } }
}

const TestLayer = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)

layer(TestLayer)("opencode 2 sessions", (it) => {
  it.effect("runs a turn in the session's directory, streaming the events opencode publishes", () =>
    Effect.gen(function* () {
      const { fake, session } = yield* createSession(answer("hello"))

      const parts = yield* runTurn(session, "Say hello.")

      expect(textOf(parts)).toBe("hello")
      expect(parts.at(-1)).toMatchObject({ type: "finish", reason: "stop" })
      expect(bodiesTo(fake, "/api/session")).toEqual([
        {
          location: { directory },
          model: { providerID: "opencode", id: "default-model" }
        }
      ])
    })
  )

  it.effect("prompts with the turn's files, after giving the session its model and instructions", () =>
    Effect.gen(function* () {
      const { fake, session } = yield* createSession(answer("ok"))

      yield* Stream.runCollect(
        session.promptTurn({
          tools: [],
          prompt: Prompt.makeMessage("user", {
            content: [
              Prompt.makePart("text", { text: "Read this." }),
              Prompt.makePart("file", {
                mediaType: "text/plain",
                fileName: "a.txt",
                data: "aGk="
              })
            ]
          }),
          model: "deep",
          instructions: "Be brief.",
          responseFormat: { type: "text" }
        })
      )
      // The same instructions are given once, and a turn without any removes them.
      yield* runTurn(session, "Again.", { model: "deep", instructions: "Be brief." })
      yield* runTurn(session, "Without.", { model: "deep" })

      expect(bodiesTo(fake, "/model")).toEqual([
        { model: { providerID: "opencode", id: "default-model", variant: "amends-high" } }
      ])
      expect(bodiesTo(fake, "/instructions/amends")).toEqual([{ value: "Be brief." }])
      expect(fake.requests.filter((request) => request.includes("/instructions/entries/"))).toEqual([
        "PUT /api/experimental/session/ses_fake1/instructions/entries/amends",
        "DELETE /api/experimental/session/ses_fake1/instructions/entries/amends"
      ])
      expect(bodiesTo(fake, "/prompt")[0]).toEqual({
        text: "Read this.",
        files: [{ uri: "data:text/plain;base64,aGk=", name: "a.txt" }],
        delivery: "queue"
      })
    })
  )

  it.effect("refuses an answer in JSON, a model it has no name for, and a file at a URL", () =>
    Effect.gen(function* () {
      const { fake, session } = yield* createSession(answer("unused"))

      const json = yield* Effect.flip(
        runTurn(session, "Hi.", {
          responseFormat: { type: "json", objectName: "answer", schema: { type: "object" } }
        })
      )
      const model = yield* Effect.flip(runTurn(session, "Hi.", { model: "constructor" }))
      const file = yield* Effect.flip(
        Stream.runCollect(
          session.promptTurn(
            turnOptions("", {
              prompt: Prompt.makeMessage("user", {
                content: [
                  Prompt.makePart("file", {
                    mediaType: "application/pdf",
                    data: new URL("https://example.com/a.pdf")
                  })
                ]
              })
            })
          )
        )
      )

      expect([json.reason, model.reason, file.reason]).toEqual([
        expect.objectContaining({
          _tag: "UnsupportedError",
          description: "opencode 2's session API does not answer in JSON"
        }),
        expect.objectContaining({
          _tag: "UnsupportedError",
          description: "The opencode 2 agent has no model named constructor"
        }),
        expect.objectContaining({ _tag: "UnsupportedError" })
      ])
      expect(fake.requests.filter((request) => request.endsWith("/prompt"))).toEqual([])
    })
  )

  it.effect("stops the session in opencode when the turn's stream ends before the turn does", () =>
    Effect.gen(function* () {
      const { fake, session } = yield* createSession((turn) => {
        const event = eventsOf(turn.sessionID)
        return Effect.andThen(
          turn.publish(
            event.delivered(turn.inboxID),
            event.stepStarted("msg_1"),
            event.inputStarted("msg_1", "call_1", "shell"),
            event.inputEnded("msg_1", "call_1", "{}"),
            event.called("msg_1", "call_1", { command: "make" })
          ),
          Effect.never
        )
      })

      const read = yield* session.promptTurn(turnOptions("Build it.")).pipe(
        Stream.takeUntil((part) => part.type === "tool-call"),
        Stream.runCollect
      )

      expect(read.at(-1)?.type).toBe("tool-call")
      expect(fake.requests.filter((request) => request.endsWith("/interrupt"))).toHaveLength(1)
    })
  )

  it.effect("fails a turn whose events it cannot read, and stops it in opencode", () =>
    Effect.gen(function* () {
      const { fake, session } = yield* createSession((turn) =>
        Effect.andThen(
          turn.publish(eventsOf(turn.sessionID).delivered(turn.inboxID), {
            type: "fake.unreadable",
            data: {}
          }),
          Effect.never
        )
      )

      const failed = yield* Effect.flip(runTurn(session, "Build it."))

      expect(failed.reason._tag).toBe("AgentContractError")
      expect(fake.requests.filter((request) => request.endsWith("/interrupt"))).toHaveLength(1)
    })
  )

  it.effect("imports another agent's conversation as the new session's own", () =>
    Effect.gen(function* () {
      const history = Prompt.make([
        { role: "user", content: "Remember the codename BLUE-MARLIN-9." },
        { role: "assistant", content: [{ type: "text", text: "Noted." }] }
      ])
      const { fake, session } = yield* createSession(answer("BLUE-MARLIN-9"), { history })

      const parts = yield* runTurn(session, "What is the codename?")

      const [imported] = bodiesTo(fake, "/import") as Array<{
        info: { id: string; model: unknown; location: unknown }
        messages: Array<{ type: string }>
        location: unknown
      }>
      expect(imported?.info).toMatchObject({
        id: expect.stringMatching(/^ses_[0-9a-f]{32}$/),
        model: { providerID: "opencode", id: "default-model" },
        location: { directory }
      })
      expect(imported?.messages.map((message) => message.type)).toEqual(["user", "assistant"])
      expect(imported?.location).toEqual({ directory })
      expect(textOf(parts)).toBe("BLUE-MARLIN-9")
      expect(fake.requests.filter((request) => request === "POST /api/session")).toEqual([])
      expect(session.keptConversation).toBe(false)
    })
  )

  it.effect("picks its own opencode session up again from its state, or starts another when opencode lost it", () =>
    Effect.gen(function* () {
      const { fake, driver, session } = yield* createSession(answer("hello"))
      yield* runTurn(session, "Hi.", { model: "other" })
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

      const State = Schema.Struct({ sessionID: Schema.String, model: Schema.Unknown })
      expect(again.keptConversation).toBe(true)
      expect(yield* again.state).toEqual(agentState)
      expect((yield* Schema.decodeUnknownEffect(State)(agentState)).model).toEqual({
        providerID: "opencode",
        id: "other-model"
      })
      expect(lost.keptConversation).toBe(false)
      expect((yield* Schema.decodeUnknownEffect(State)(yield* lost.state)).sessionID).not.toBe(
        (yield* Schema.decodeUnknownEffect(State)(agentState)).sessionID
      )
    })
  )

  // The session waits on the live clock for opencode to register the host's tools.
  it.effect("offers the host's tools as an MCP server, connecting again when they change, streaming their calls", () =>
    Effect.gen(function* () {
      const called = yield* Deferred.make<void>()
      const answered = yield* Deferred.make<unknown>()
      const relay = yield* HostToolRelay.make()
      const { fake, session } = yield* createSession(
        (turn) =>
          Effect.gen(function* () {
            const event = eventsOf(turn.sessionID)
            if (turn.body.text !== "Check the weather.") {
              return yield* turn.publish(...answerEvents(turn.sessionID, turn.inboxID, "ok"))
            }
            // opencode 2's model calls the host's tools from code it runs, through the MCP
            // server, as its client does.
            yield* turn.publish(
              event.delivered(turn.inboxID),
              event.stepStarted("msg_1"),
              event.inputStarted("msg_1", "call_1", "code"),
              event.inputEnded("msg_1", "call_1", "{}"),
              event.called("msg_1", "call_1", { code: "return tools.host.lookup_weather()" })
            )
            const [, mcp] = turn.bodies.find(([path]) => path === "/api/experimental/mcp/host") ?? []
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
              event.succeededCall("msg_1", "call_1", "foggy"),
              event.stepEnded("msg_1", "tool-calls"),
              ...answerEvents(turn.sessionID, turn.inboxID, "It is foggy.", "msg_2").slice(2)
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
      expect(parts.filter((part) => part.type === "tool-call" && part.providerExecuted !== true)).toEqual([
        expect.objectContaining({ name: "lookup_weather", params: { city: "Lisbon" } })
      ])
      expect(textOf(parts)).toBe("It is foggy.")
      expect(yield* Deferred.await(answered)).toMatchObject({
        result: { content: [{ type: "text", text: "foggy" }] }
      })
      expect(bodiesTo(fake, "/mcp/host")).toEqual([
        {
          config: {
            type: "remote",
            url: "http://127.0.0.1:1/mcp",
            headers: { authorization: expect.stringMatching(/^Bearer \w+$/) }
          }
        }
      ])
      expect(fake.requests.filter((request) => request.includes("/mcp/"))).toEqual([
        `PUT /api/experimental/mcp/host?location[directory]=${directory}`,
        `POST /api/experimental/mcp/host/connect?location[directory]=${directory}`,
        `POST /api/experimental/mcp/host/disconnect?location[directory]=${directory}`
      ])
    }).pipe(TestClock.withLive)
  )

  it.effect("fails a turn with the host's tools when opencode cannot connect to them", () =>
    Effect.gen(function* () {
      const { fake, session } = yield* createSession(answer("unused"), { mcpStatus: "failed" })

      const failed = yield* Effect.flip(runTurn(session, "Hi.", { tools: [weather] }))

      expect(failed.reason).toMatchObject({
        _tag: "UnavailableError",
        description: "opencode did not connect to the host's tools: it reports them failed"
      })
      expect(fake.requests.filter((request) => request.endsWith("/prompt"))).toEqual([])
    })
  )

  it.effect("answers a tool's request for permission as the host approves or refuses it", () =>
    Effect.gen(function* () {
      const { fake, session } = yield* createSession(answer("unused"))

      yield* session.approve({ approvalId: "per_1", approved: true })
      yield* session.approve({ approvalId: "per_2", approved: false, reason: "Not now" })

      expect(fake.bodies.filter(([path]) => path.includes("/permission/"))).toEqual([
        ["/api/session/ses_fake1/permission/per_1", { decision: "once" }],
        ["/api/session/ses_fake1/permission/per_2", { decision: "reject", message: "Not now" }]
      ])
    })
  )

  it.effect("cancels the forms the model asks the user to fill, which no host answers", () =>
    Effect.gen(function* () {
      const { fake, session } = yield* createSession((turn) =>
        turn.publish(eventsOf(turn.sessionID).form("frm_1"), ...answerEvents(turn.sessionID, turn.inboxID, "ok"))
      )

      yield* runTurn(session, "Ask me.")

      expect(fake.requests.filter((request) => request.startsWith("DELETE /api/session/ses_fake1/form/"))).toEqual([
        "DELETE /api/session/ses_fake1/form/frm_1?message=No+one+answers+forms+here"
      ])
    })
  )

  it.effect("compacts, returning the summary opencode wrote", () =>
    Effect.gen(function* () {
      const { fake, session } = yield* createSession(answer("unused"), { summary: "We spoke." })

      const compaction = yield* session.compact()

      expect(compaction).toEqual({ type: "compaction", trigger: "manual", summary: "We spoke." })
      expect(fake.requests).toContain("POST /api/session/ses_fake1/compact")
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
