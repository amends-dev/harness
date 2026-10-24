import { describe, expect, it } from "@effect/vitest"
import { Crypto, Deferred, Effect, Fiber, Option, Redacted, type Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { SessionId } from "../src/Agent.ts"
import type { ToolDefinition } from "../src/Bridge.ts"
import * as HostToolRelay from "../src/HostToolRelay.ts"
import type { StreamPart } from "../src/StreamPart.ts"

const echo: ToolDefinition = {
  name: "echo",
  description: "Gives back its text",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"]
  }
}

const ping: ToolDefinition = { name: "ping", parameters: true }

/** Randomness that differs from one call to the next, so that no two tokens are alike. */
const makeCrypto = () => {
  let next = 0
  return Crypto.make({
    randomBytes: (size) => Uint8Array.from({ length: size }, () => next++ % 256),
    digest: (_algorithm, data) => Effect.succeed(data)
  })
}

const request = (id: number, method: string, params?: Schema.Json): Schema.Json => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params })
})

const notification = (method: string, params?: Schema.Json): Schema.Json => ({
  jsonrpc: "2.0",
  method,
  ...(params === undefined ? {} : { params })
})

const callOf = (name: string, args: Schema.Json = {}, progressToken?: string) =>
  request(7, "tools/call", {
    name,
    arguments: args,
    ...(progressToken === undefined ? {} : { _meta: { progressToken } })
  })

const bearer = (session: HostToolRelay.RelaySession) => `Bearer ${Redacted.value(session.token)}`

/** The relay with the options given, and a session of it that lasts as long as the test. */
const setUp = (options?: HostToolRelay.Options) =>
  Effect.gen(function* () {
    const relay = yield* HostToolRelay.make(options).pipe(Effect.provideService(Crypto.Crypto, makeCrypto()))
    const session = yield* relay.open(SessionId.make("session-one"))
    return { relay, session, authorization: bearer(session) }
  })

/** What the relay replies to a message that has one reply. */
const replyTo = (relay: HostToolRelay.Relay, authorization: string | undefined, message: Schema.Json) =>
  Effect.gen(function* () {
    const answer = yield* relay.answer(authorization, message)
    if (!HostToolRelay.Answer.$is("Reply")(answer)) return yield* Effect.die(`Expected a reply, got ${answer._tag}`)
    return answer.message
  })

/** The messages that the relay answers a call with, as they happen. */
const eventsOf = (relay: HostToolRelay.Relay, authorization: string, message: Schema.Json) =>
  Effect.gen(function* () {
    const answer = yield* relay.answer(authorization, message)
    if (!HostToolRelay.Answer.$is("Events")(answer)) return yield* Effect.die(`Expected events, got ${answer._tag}`)
    return answer.messages
  })

const textResult = (id: number, text: string, isError = false): Schema.Json => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) }
})

/** Offers `tools` for the rest of the test, when the test does not read the calls. */
const offerWithoutReading = (session: HostToolRelay.RelaySession, tools: ReadonlyArray<ToolDefinition>) =>
  Effect.asVoid(session.offerTools(tools))

/** Makes a call and waits for the part it streams, which the host would run. */
const callAndRead = (
  relay: HostToolRelay.Relay,
  authorization: string,
  parts: Stream.Stream<StreamPart>,
  message: Schema.Json
) =>
  Effect.gen(function* () {
    const messages = yield* eventsOf(relay, authorization, message)
    const answered = yield* Effect.forkChild(Stream.runCollect(messages))
    const part = yield* Stream.runHead(parts)
    return { answered, part }
  })

describe("HostToolRelay", () => {
  describe("authorization", () => {
    it.effect("answers only a message that presents the token of a session it has", () =>
      Effect.gen(function* () {
        const { relay, authorization } = yield* setUp()
        const message = request(1, "ping")

        const withToken = yield* relay.answer(authorization, message)
        const withoutToken = yield* relay.answer(undefined, message)
        const withOtherToken = yield* relay.answer("Bearer nobody", message)
        const withoutScheme = yield* relay.answer(authorization.slice("Bearer ".length), message)

        expect(withToken._tag).toBe("Reply")
        expect(withoutToken._tag).toBe("Unauthorized")
        expect(withOtherToken._tag).toBe("Unauthorized")
        expect(withoutScheme._tag).toBe("Unauthorized")
      })
    )

    it.effect("gives each session a token of its own, which stops working when it ends", () =>
      Effect.gen(function* () {
        const { relay, session, authorization } = yield* setUp()
        const other = yield* relay.open(SessionId.make("session-two"))
        expect(Redacted.value(other.token)).not.toBe(Redacted.value(session.token))

        const { second, secondAuthorization } = yield* Effect.scoped(
          Effect.gen(function* () {
            const second = yield* relay.open(SessionId.make("session-three"))
            const secondAuthorization = bearer(second)
            const answer = yield* relay.answer(secondAuthorization, request(1, "ping"))
            expect(answer._tag).toBe("Reply")
            return { second, secondAuthorization }
          })
        )

        expect(Redacted.value(second.token)).toBeTruthy()
        expect((yield* relay.answer(secondAuthorization, request(2, "ping")))._tag).toBe("Unauthorized")
        expect((yield* relay.answer(authorization, request(3, "ping")))._tag).toBe("Reply")
      })
    )

    it.effect("never prints a token", () =>
      Effect.gen(function* () {
        const { session } = yield* setUp()
        expect(JSON.stringify(session.token)).not.toContain(Redacted.value(session.token))
      })
    )
  })

  describe("the protocol", () => {
    it.effect("initializes with the newest protocol version it shares with the agent", () =>
      Effect.gen(function* () {
        const { relay, authorization } = yield* setUp()

        const old = yield* replyTo(relay, authorization, request(1, "initialize", { protocolVersion: "2025-03-26" }))
        const unknown = yield* replyTo(
          relay,
          authorization,
          request(2, "initialize", { protocolVersion: "2099-01-01" })
        )

        expect(old).toMatchObject({ id: 1, result: { protocolVersion: "2025-03-26" } })
        expect(unknown).toMatchObject({ id: 2, result: { protocolVersion: "2025-11-25" } })
        expect(old).toMatchObject({
          result: { capabilities: { tools: { listChanged: false } } }
        })
      })
    )

    it.effect("accepts notifications without a reply, and answers a ping", () =>
      Effect.gen(function* () {
        const { relay, authorization } = yield* setUp()

        const initialized = yield* relay.answer(authorization, notification("notifications/initialized"))

        expect(initialized._tag).toBe("Accepted")
        expect(yield* replyTo(relay, authorization, request(4, "ping"))).toEqual({
          jsonrpc: "2.0",
          id: 4,
          result: {}
        })
      })
    )

    it.effect("refuses a method it does not have, and a message that is not a request", () =>
      Effect.gen(function* () {
        const { relay, authorization } = yield* setUp()

        const unknown = yield* replyTo(relay, authorization, request(5, "resources/list"))
        const malformed = yield* replyTo(relay, authorization, { hello: "world" })

        expect(unknown).toMatchObject({ id: 5, error: { code: -32601 } })
        expect(malformed).toMatchObject({ id: null, error: { code: -32600 } })
      })
    )
  })

  describe("listing tools", () => {
    it.effect("lists none before a turn offers some", () =>
      Effect.gen(function* () {
        const { relay, authorization } = yield* setUp()

        expect(yield* replyTo(relay, authorization, request(1, "tools/list"))).toEqual({
          jsonrpc: "2.0",
          id: 1,
          result: { tools: [] }
        })
      })
    )

    it.effect("lists the tools of the turn, which stay listed after it", () =>
      Effect.gen(function* () {
        const { relay, session, authorization } = yield* setUp()
        const expected = {
          jsonrpc: "2.0",
          id: 1,
          result: {
            tools: [
              { name: "echo", description: echo.description, inputSchema: echo.parameters },
              // A schema that is not an object is read as an object without properties.
              { name: "ping", inputSchema: { type: "object" } }
            ]
          }
        }

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* offerWithoutReading(session, [echo, ping])
            expect(yield* replyTo(relay, authorization, request(1, "tools/list"))).toEqual(expected)
          })
        )

        expect(yield* replyTo(relay, authorization, request(1, "tools/list"))).toEqual(expected)
      })
    )

    it.effect("lists what the latest turn offers", () =>
      Effect.gen(function* () {
        const { relay, session, authorization } = yield* setUp()
        yield* Effect.scoped(offerWithoutReading(session, [echo, ping]))

        yield* Effect.scoped(offerWithoutReading(session, [ping]))

        expect(yield* replyTo(relay, authorization, request(1, "tools/list"))).toMatchObject({
          result: { tools: [{ name: "ping" }] }
        })
      })
    )

    it.effect("lists a session's tools to that session alone", () =>
      Effect.gen(function* () {
        const { relay, session, authorization } = yield* setUp()
        const other = yield* relay.open(SessionId.make("session-two"))

        yield* offerWithoutReading(session, [echo])

        expect(yield* replyTo(relay, bearer(other), request(1, "tools/list"))).toMatchObject({
          result: { tools: [] }
        })
        expect(yield* replyTo(relay, authorization, request(1, "tools/list"))).toMatchObject({
          result: { tools: [{ name: "echo" }] }
        })
      })
    )
  })

  describe("calling tools", () => {
    it.effect("streams the call as a part, and answers the agent with the host's result", () =>
      Effect.gen(function* () {
        const { relay, session, authorization } = yield* setUp()
        const parts = yield* session.offerTools([echo])

        const { answered, part } = yield* callAndRead(relay, authorization, parts, callOf("echo", { text: "hello" }))

        expect(part).toMatchObject({
          _tag: "Some",
          value: { type: "tool-call", name: "echo", params: { text: "hello" } }
        })
        const id = Option.isSome(part) && part.value.type === "tool-call" ? part.value.id : ""
        // The agent's own tool call was the relay's to make, so the part is the host's to run.
        expect(part).not.toMatchObject({ value: { providerExecuted: true } })

        yield* session.submitToolResult({
          id,
          name: "echo",
          result: "hello",
          isFailure: false
        })

        expect(Array.from(yield* Fiber.join(answered))).toEqual([textResult(7, "hello")])
      })
    )

    it.effect("gives each call an id of its own", () =>
      Effect.gen(function* () {
        const { relay, session, authorization } = yield* setUp()
        const parts = yield* session.offerTools([echo])
        const first = yield* callAndRead(relay, authorization, parts, callOf("echo", { text: "a" }))
        const second = yield* callAndRead(relay, authorization, parts, callOf("echo", { text: "b" }))

        const idOf = (read: typeof first) =>
          Option.isSome(read.part) && read.part.value.type === "tool-call" ? read.part.value.id : ""

        expect(idOf(first)).not.toBe("")
        expect(idOf(first)).not.toBe(idOf(second))

        yield* session.submitToolResult({
          id: idOf(second),
          name: "echo",
          result: "b",
          isFailure: false
        })
        yield* session.submitToolResult({
          id: idOf(first),
          name: "echo",
          result: "a",
          isFailure: false
        })

        expect(Array.from(yield* Fiber.join(first.answered))).toEqual([textResult(7, "a")])
        expect(Array.from(yield* Fiber.join(second.answered))).toEqual([textResult(7, "b")])
      })
    )

    it.effect.each([
      ["a text", "plain words", false, "plain words"],
      ["a result that is not a text", { total: 3 }, false, '{"total":3}'],
      ["a failure that has a message", { code: "bad", message: "No such issue" }, true, "No such issue"],
      ["a call the host refused", { type: "execution-denied", reason: "Not allowed here" }, true, "Not allowed here"],
      ["a refusal with no reason", { type: "execution-denied" }, true, "The call was refused"],
      ["a failure that has neither", { code: 4 }, true, '{"code":4}']
    ] as const)("reads %s to the agent's model", ([, result, isFailure, text]) =>
      Effect.gen(function* () {
        const { relay, session, authorization } = yield* setUp()
        const parts = yield* session.offerTools([echo])
        const { answered, part } = yield* callAndRead(relay, authorization, parts, callOf("echo"))
        const id = Option.isSome(part) && part.value.type === "tool-call" ? part.value.id : ""

        yield* session.submitToolResult({ id, name: "echo", result, isFailure })

        expect(Array.from(yield* Fiber.join(answered))).toEqual([textResult(7, text, isFailure)])
      })
    )

    it.effect("fails a call when no turn runs, and one of a tool the turn did not offer", () =>
      Effect.gen(function* () {
        const { relay, session, authorization } = yield* setUp()

        const idle = yield* replyTo(relay, authorization, callOf("echo"))
        yield* offerWithoutReading(session, [echo])
        const unoffered = yield* replyTo(relay, authorization, callOf("delete"))

        expect(idle).toEqual(textResult(7, "No turn is running", true))
        expect(unoffered).toEqual(textResult(7, "The tool delete is not offered", true))
      })
    )

    it.effect("fails a call after its turn, though the tool stays listed", () =>
      Effect.gen(function* () {
        const { relay, session, authorization } = yield* setUp()
        yield* Effect.scoped(offerWithoutReading(session, [echo]))

        const reply = yield* replyTo(relay, authorization, callOf("echo"))

        expect(reply).toEqual(textResult(7, "No turn is running", true))
      })
    )

    it.effect("fails a call that has invalid parameters", () =>
      Effect.gen(function* () {
        const { relay, session, authorization } = yield* setUp()
        yield* offerWithoutReading(session, [echo])

        const reply = yield* replyTo(relay, authorization, request(3, "tools/call", { name: 4 }))

        expect(reply).toMatchObject({ id: 3, error: { code: -32602 } })
      })
    )

    it.effect("ends the stream of calls when the turn ends, after the calls it holds", () =>
      Effect.gen(function* () {
        const { relay, session, authorization } = yield* setUp()
        const answered = yield* Effect.scoped(
          Effect.gen(function* () {
            const parts = yield* session.offerTools([echo])
            const messages = yield* eventsOf(relay, authorization, callOf("echo"))
            return { parts, answered: yield* Effect.forkChild(Stream.runCollect(messages)) }
          })
        )

        const parts = Array.from(yield* Stream.runCollect(answered.parts))
        yield* Fiber.join(answered.answered)

        expect(parts).toMatchObject([{ type: "tool-call", name: "echo" }])
      })
    )

    it.effect("ends a call the turn ended before the host answered it", () =>
      Effect.gen(function* () {
        const { relay, session, authorization } = yield* setUp()
        const answered = yield* Effect.scoped(
          Effect.gen(function* () {
            const parts = yield* session.offerTools([echo])
            const read = yield* callAndRead(relay, authorization, parts, callOf("echo"))
            return read.answered
          })
        )

        expect(Array.from(yield* Fiber.join(answered))).toEqual([textResult(7, "The turn ended", true)])
      })
    )

    it.effect("drops the result of a call that nothing waits for", () =>
      Effect.gen(function* () {
        const { session } = yield* setUp()
        yield* offerWithoutReading(session, [echo])

        yield* session.submitToolResult({
          id: "no-such-call",
          name: "echo",
          result: "late",
          isFailure: false
        })
      })
    )

    it.effect("takes a result for a call of its own session only", () =>
      Effect.gen(function* () {
        const { relay, session, authorization } = yield* setUp()
        const other = yield* relay.open(SessionId.make("session-two"))
        const parts = yield* session.offerTools([echo])
        const { answered, part } = yield* callAndRead(relay, authorization, parts, callOf("echo"))
        const id = Option.isSome(part) && part.value.type === "tool-call" ? part.value.id : ""

        yield* other.submitToolResult({ id, name: "echo", result: "stolen", isFailure: false })
        yield* session.submitToolResult({ id, name: "echo", result: "mine", isFailure: false })

        expect(Array.from(yield* Fiber.join(answered))).toEqual([textResult(7, "mine")])
      })
    )

    it.effect("ends a call the agent cancelled", () =>
      Effect.gen(function* () {
        const { relay, session, authorization } = yield* setUp()
        const parts = yield* session.offerTools([echo])
        const { answered } = yield* callAndRead(relay, authorization, parts, callOf("echo"))

        const cancelled = yield* relay.answer(authorization, notification("notifications/cancelled", { requestId: 7 }))

        expect(cancelled._tag).toBe("Accepted")
        expect(Array.from(yield* Fiber.join(answered))).toEqual([textResult(7, "The call was cancelled", true)])
      })
    )

    it.effect("leaves a call running when another request is cancelled", () =>
      Effect.gen(function* () {
        const { relay, session, authorization } = yield* setUp()
        const parts = yield* session.offerTools([echo])
        const { answered, part } = yield* callAndRead(relay, authorization, parts, callOf("echo"))
        const id = Option.isSome(part) && part.value.type === "tool-call" ? part.value.id : ""

        yield* relay.answer(authorization, notification("notifications/cancelled", { requestId: 8 }))
        yield* session.submitToolResult({ id, name: "echo", result: "done", isFailure: false })

        expect(Array.from(yield* Fiber.join(answered))).toEqual([textResult(7, "done")])
      })
    )
  })

  describe("waiting for the host", () => {
    it.effect("sends progress while it waits, when the agent asked for it, and then the result", () =>
      Effect.gen(function* () {
        const { relay, session, authorization } = yield* setUp({ heartbeat: "10 seconds" })
        const parts = yield* session.offerTools([echo])
        const { answered, part } = yield* callAndRead(relay, authorization, parts, callOf("echo", {}, "token-1"))
        const id = Option.isSome(part) && part.value.type === "tool-call" ? part.value.id : ""

        yield* TestClock.adjust("10 seconds")
        yield* TestClock.adjust("10 seconds")
        yield* session.submitToolResult({ id, name: "echo", result: "done", isFailure: false })

        const messages = Array.from(yield* Fiber.join(answered))
        const progress = {
          jsonrpc: "2.0",
          method: "notifications/progress"
        }
        expect(messages).toEqual([
          { ...progress, params: { progressToken: "token-1", progress: 1 } },
          { ...progress, params: { progressToken: "token-1", progress: 2 } },
          textResult(7, "done")
        ])
      })
    )

    it.effect("sends no progress to an agent that did not ask for it", () =>
      Effect.gen(function* () {
        const { relay, session, authorization } = yield* setUp({ heartbeat: "10 seconds" })
        const parts = yield* session.offerTools([echo])
        const { answered, part } = yield* callAndRead(relay, authorization, parts, callOf("echo"))
        const id = Option.isSome(part) && part.value.type === "tool-call" ? part.value.id : ""

        yield* TestClock.adjust("30 seconds")
        yield* session.submitToolResult({ id, name: "echo", result: "done", isFailure: false })

        expect(Array.from(yield* Fiber.join(answered))).toEqual([textResult(7, "done")])
      })
    )

    it.effect("fails a call the host does not answer within the longest wait", () =>
      Effect.gen(function* () {
        const { relay, session, authorization } = yield* setUp({
          heartbeat: "10 seconds",
          maxWait: "1 minute"
        })
        const parts = yield* session.offerTools([echo])
        const { answered } = yield* callAndRead(relay, authorization, parts, callOf("echo"))

        yield* TestClock.adjust("1 minute")

        expect(Array.from(yield* Fiber.join(answered))).toEqual([
          textResult(7, "The host did not answer in time", true)
        ])
      })
    )

    it.effect("waits for the host, as for a person to approve, until the longest wait", () =>
      Effect.gen(function* () {
        const { relay, session, authorization } = yield* setUp({
          heartbeat: "10 seconds",
          maxWait: "1 hour"
        })
        const parts = yield* session.offerTools([echo])
        const { answered, part } = yield* callAndRead(relay, authorization, parts, callOf("echo", {}, "token-1"))
        const id = Option.isSome(part) && part.value.type === "tool-call" ? part.value.id : ""
        const approved = yield* Deferred.make<void>()
        yield* Effect.forkChild(
          Deferred.await(approved).pipe(
            Effect.andThen(session.submitToolResult({ id, name: "echo", result: "ok", isFailure: false }))
          )
        )

        yield* TestClock.adjust("50 minutes")
        yield* Deferred.succeed(approved, undefined)

        expect(Array.from(yield* Fiber.join(answered)).at(-1)).toEqual(textResult(7, "ok"))
      })
    )
  })
})
