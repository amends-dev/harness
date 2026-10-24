import { Network } from "@amends-dev/sandbox"
import { BunHttpServer } from "@effect/platform-bun"
import { Effect, Fiber, Schema, Stream, SubscriptionRef } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { NetAddress } from "effect/net"
import { SessionEvent } from "../../src/internal/bridge/v1/event.ts"
import { tokens } from "../fixtures.ts"

/** An event as opencode 1 publishes it, of any type. */
export interface RawEvent {
  readonly type: string
  readonly properties: Readonly<Record<string, unknown>>
}

/**
 * Makes the events opencode 1 publishes for the session `sessionID`, as a turn's steps write them.
 * Each step is an assistant message, whose parts belong to it.
 */
export const eventsOf = (sessionID: string) => {
  const inSession = { sessionID }
  const part = (messageID: string, fields: Record<string, unknown>): RawEvent => ({
    type: "message.part.updated",
    properties: { ...inSession, part: { ...inSession, messageID, ...fields } }
  })
  return {
    busy: (): RawEvent => ({
      type: "session.status",
      properties: { ...inSession, status: { type: "busy" } }
    }),
    idle: (): RawEvent => ({ type: "session.idle", properties: inSession }),
    prompted: (messageID: string): RawEvent => ({
      type: "message.updated",
      properties: { ...inSession, info: { id: messageID, sessionID, role: "user" } }
    }),
    stepStarted: (messageID: string, fields: Record<string, unknown> = {}): RawEvent => ({
      type: "message.updated",
      properties: {
        ...inSession,
        info: {
          id: messageID,
          sessionID,
          role: "assistant",
          providerID: "opencode",
          modelID: "default-model",
          time: { created: 1_791_073_617_000 },
          ...fields
        }
      }
    }),
    stepCompleted: (messageID: string, fields: Record<string, unknown> = {}): RawEvent => ({
      type: "message.updated",
      properties: {
        ...inSession,
        info: {
          id: messageID,
          sessionID,
          role: "assistant",
          providerID: "opencode",
          modelID: "default-model",
          time: { created: 1_791_073_617_000, completed: 1_791_073_618_000 },
          finish: "stop",
          tokens: tokens(10, 5),
          ...fields
        }
      }
    }),
    text: (messageID: string, id: string, text: string, ended = true): RawEvent =>
      part(messageID, {
        id,
        type: "text",
        text,
        time: ended ? { start: 1, end: 2 } : { start: 1 }
      }),
    reasoning: (messageID: string, id: string, text: string, ended = true): RawEvent =>
      part(messageID, {
        id,
        type: "reasoning",
        text,
        time: ended ? { start: 1, end: 2 } : { start: 1 }
      }),
    delta: (messageID: string, partID: string, delta: string): RawEvent => ({
      type: "message.part.delta",
      properties: { ...inSession, messageID, partID, field: "text", delta }
    }),
    tool: (messageID: string, callID: string, tool: string, state: Record<string, unknown>): RawEvent =>
      part(messageID, { id: `prt_${callID}`, type: "tool", callID, tool, state }),
    stepStart: (messageID: string): RawEvent => part(messageID, { id: `prt_start_${messageID}`, type: "step-start" }),
    error: (name: string, message: string): RawEvent => ({
      type: "session.error",
      properties: { ...inSession, error: { name, data: { message } } }
    }),
    permission: (id: string, callID: string): RawEvent => ({
      type: "permission.asked",
      properties: {
        ...inSession,
        id,
        permission: "bash",
        patterns: ["make"],
        metadata: {},
        always: [],
        tool: { messageID: "msg_step", callID }
      }
    }),
    question: (id: string): RawEvent => ({
      type: "question.asked",
      properties: { ...inSession, id, questions: [] }
    })
  }
}

/** `event` decoded as the adapter reads it. */
export const decode = (event: RawEvent) => Schema.decodeUnknownSync(SessionEvent)(event)

/** The parts of a turn that answers `text` in one step, as `eventsOf` makes them. */
export const answerEvents = (sessionID: string, text: string, messageID = "msg_answer") => {
  const event = eventsOf(sessionID)
  return [
    event.busy(),
    event.stepStarted(messageID),
    event.stepStart(messageID),
    event.text(messageID, "prt_text", "", false),
    event.delta(messageID, "prt_text", text),
    event.text(messageID, "prt_text", text),
    event.stepCompleted(messageID),
    event.idle()
  ]
}

/** A turn the fake server runs for a prompt it took. */
export interface FakeTurn {
  readonly sessionID: string

  /** The prompt's body, as opencode took it. */
  readonly body: Readonly<Record<string, unknown>>

  /** Publishes `events` to the subscriptions of the session's directory, in order. */
  readonly publish: (...events: ReadonlyArray<RawEvent>) => Effect.Effect<void>

  /** The bodies of the requests the server took so far, with the path each came to. */
  readonly bodies: ReadonlyArray<readonly [string, unknown]>
}

/** A message of a session as the fake keeps it, which `GET /session/:id/message` lists. */
export interface FakeMessage {
  readonly info: Readonly<Record<string, unknown>>
  readonly parts: ReadonlyArray<Readonly<Record<string, unknown>>>
}

export interface FakeSession {
  readonly directory: string
  readonly messages: Array<FakeMessage>
}

export interface FakeOpencode {
  /** The port the server listens on, on this machine. */
  readonly port: Network.Port

  /** The requests the server took, in order, as `METHOD /path`. */
  readonly requests: ReadonlyArray<string>

  /** The bodies of the requests the server took, in order, with the request each came with. */
  readonly bodies: ReadonlyArray<readonly [string, unknown]>

  /** The sessions the server has now, by id, which a test deletes as when opencode loses them. */
  readonly sessions: Map<string, FakeSession>

  /** Publishes `events` to the subscriptions of `directory`, in order. */
  readonly publish: (directory: string, ...events: ReadonlyArray<RawEvent>) => Effect.Effect<void>
}

export interface FakeOpencodeOptions {
  /**
   * Writes the summary of the session `sessionID` when it is asked to summarize, which the fake
   * adds to the session's messages. A summary that says `failed` fails.
   */
  readonly summary?: string
}

/**
 * A fake of opencode 1's server, with the requests of its session API that the agent makes, which
 * runs each prompt's turn with `runTurn`. Each directory publishes its events to the subscriptions
 * made before them, live only; a session runs while its turn does, and an abort interrupts the
 * turn. The server stops when the scope closes.
 */
export const makeFakeOpencode = (runTurn: (turn: FakeTurn) => Effect.Effect<void>, options: FakeOpencodeOptions = {}) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const sessions = new Map<string, FakeSession>()
    const running = new Map<string, Fiber.Fiber<void>>()
    const requests: Array<string> = []
    const bodies: Array<readonly [string, unknown]> = []
    let created = 0
    /** Every event published, with the directory it was published to. */
    const published = yield* SubscriptionRef.make<ReadonlyArray<readonly [string, RawEvent]>>([])

    const publish = (directory: string, ...events: ReadonlyArray<RawEvent>) =>
      SubscriptionRef.update(published, (all) => [...all, ...events.map((event) => [directory, event] as const)])

    const record = (path: string) =>
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
        Effect.map(request.json, (body) => {
          bodies.push([path, body])
          return body as Record<string, unknown>
        })
      )

    const directoryOf = Effect.map(HttpServerRequest.schemaSearchParams(DirectoryParams), ({ directory }) => directory)

    /** Answers a request about the session the path names, or 404 when the server has none. */
    const withSession = <E, R>(
      handle: (sessionID: string, session: FakeSession) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
    ) =>
      Effect.flatMap(HttpRouter.params, ({ sessionID = "" }) => {
        const session = sessions.get(sessionID)
        return session === undefined
          ? Effect.succeed(
              HttpServerResponse.jsonUnsafe(
                { name: "NotFoundError", data: { message: "Session not found" } },
                { status: 404 }
              )
            )
          : handle(sessionID, session)
      })

    const routes = HttpRouter.use((router) =>
      router.addAll([
        HttpRouter.route(
          "POST",
          "/session",
          Effect.gen(function* () {
            const directory = yield* directoryOf
            created += 1
            const sessionID = `ses_fake${created}`
            sessions.set(sessionID, { directory, messages: [] })
            return HttpServerResponse.jsonUnsafe({ id: sessionID, directory })
          })
        ),

        HttpRouter.route(
          "GET",
          "/session/status",
          Effect.sync(() =>
            HttpServerResponse.jsonUnsafe(Object.fromEntries([...running.keys()].map((id) => [id, { type: "busy" }])))
          )
        ),

        HttpRouter.route(
          "GET",
          "/session/:sessionID",
          withSession((sessionID) => Effect.succeed(HttpServerResponse.jsonUnsafe({ id: sessionID })))
        ),

        HttpRouter.route(
          "DELETE",
          "/session/:sessionID",
          withSession((sessionID) =>
            Effect.sync(() => {
              sessions.delete(sessionID)
              return HttpServerResponse.jsonUnsafe(true)
            })
          )
        ),

        HttpRouter.route(
          "POST",
          "/session/:sessionID/prompt_async",
          withSession((sessionID, session) =>
            Effect.gen(function* () {
              const body = yield* record(`/session/${sessionID}/prompt_async`)
              const turn = runTurn({
                sessionID,
                body,
                publish: (...events) => publish(session.directory, ...events),
                bodies
              }).pipe(Effect.ensuring(Effect.sync(() => running.delete(sessionID))))
              running.set(sessionID, yield* Effect.forkIn(turn, scope))
              return HttpServerResponse.empty({ status: 204 })
            })
          )
        ),

        HttpRouter.route(
          "POST",
          "/session/:sessionID/message",
          withSession((sessionID, session) =>
            Effect.gen(function* () {
              const body = yield* record(`/session/${sessionID}/message`)
              const info = { id: `msg_user${session.messages.length}`, sessionID, role: "user" }
              session.messages.push({
                info,
                parts: (body.parts as Array<Record<string, unknown>>) ?? []
              })
              return HttpServerResponse.jsonUnsafe({ info, parts: body.parts })
            })
          )
        ),

        HttpRouter.route(
          "GET",
          "/session/:sessionID/message",
          withSession((_sessionID, session) => Effect.succeed(HttpServerResponse.jsonUnsafe(session.messages)))
        ),

        HttpRouter.route(
          "POST",
          "/session/:sessionID/abort",
          withSession((sessionID) => {
            const turn = running.get(sessionID)
            return Effect.as(
              turn === undefined ? Effect.void : Fiber.interrupt(turn),
              HttpServerResponse.jsonUnsafe(true)
            )
          })
        ),

        HttpRouter.route(
          "POST",
          "/session/:sessionID/summarize",
          withSession((sessionID, session) =>
            Effect.gen(function* () {
              yield* record(`/session/${sessionID}/summarize`)
              const summary = options.summary ?? "The summary."
              session.messages.push({
                info: {
                  id: `msg_summary${session.messages.length}`,
                  sessionID,
                  role: "assistant",
                  providerID: "opencode",
                  modelID: "default-model",
                  summary: true,
                  time: { created: 1, completed: 2 },
                  ...(summary === "failed" ? { error: { name: "UnknownError", data: { message: "No model" } } } : {})
                },
                parts: [
                  {
                    id: "prt_summary",
                    sessionID,
                    messageID: "msg_summary",
                    type: "text",
                    text: summary
                  }
                ]
              })
              return HttpServerResponse.jsonUnsafe(true)
            })
          )
        ),

        HttpRouter.route(
          "GET",
          "/event",
          Effect.gen(function* () {
            const directory = yield* directoryOf
            // Only events published after the subscription reach it.
            const from = (yield* SubscriptionRef.get(published)).length
            return HttpServerResponse.stream(
              // opencode announces a subscription with an event of its own, as here.
              Stream.concat(
                Stream.make('data: {"type":"server.connected","properties":{}}\n\n'),
                SubscriptionRef.changes(published).pipe(
                  Stream.mapAccum(
                    () => from,
                    (last, all) => [Math.max(last, all.length), all.slice(last)] as const
                  ),
                  Stream.filter(([to]) => to === directory),
                  Stream.map(([, event]) =>
                    event.type === "fake.unreadable" ? "data: not an event\n\n" : `data: ${JSON.stringify(event)}\n\n`
                  )
                )
              ).pipe(Stream.encodeText),
              { contentType: "text/event-stream" }
            )
          })
        ),

        HttpRouter.route(
          "POST",
          "/permission/:requestID/reply",
          Effect.flatMap(HttpRouter.params, ({ requestID = "" }) =>
            Effect.as(record(`/permission/${requestID}/reply`), HttpServerResponse.jsonUnsafe(true))
          )
        ),

        HttpRouter.route("POST", "/question/:requestID/reject", Effect.succeed(HttpServerResponse.jsonUnsafe(true))),

        HttpRouter.route(
          "POST",
          "/mcp",
          Effect.as(record("/mcp"), HttpServerResponse.jsonUnsafe({ host: { status: "connected" } }))
        ),

        HttpRouter.route("POST", "/mcp/:name/connect", Effect.succeed(HttpServerResponse.jsonUnsafe(true))),

        HttpRouter.route("POST", "/mcp/:name/disconnect", Effect.succeed(HttpServerResponse.jsonUnsafe(true)))
      ])
    )
    const app = yield* HttpRouter.toHttpEffect(routes)

    const server = yield* BunHttpServer.make({ hostname: "127.0.0.1", port: 0, idleTimeout: 0 })
    yield* server.serve(
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
        Effect.andThen(
          Effect.sync(() => requests.push(`${request.method} ${new URL(request.url, "http://fake").pathname}`)),
          app
        )
      )
    )
    if (NetAddress.isUnixPathAddress(server.address)) {
      return yield* Effect.die("The fake server listens on no port")
    }

    const fake: FakeOpencode = {
      port: Network.Port.make(server.address.port),
      requests,
      bodies,
      sessions,
      publish
    }
    return fake
  })

const DirectoryParams = Schema.Struct({ directory: Schema.String })
