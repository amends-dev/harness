import { Network } from "@amends-dev/sandbox"
import { BunHttpServer } from "@effect/platform-bun"
import { Effect, Fiber, Schema, Stream, SubscriptionRef } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { NetAddress } from "effect/net"
import { SessionEvent } from "../../src/internal/bridge/v2/event.ts"
import { tokens } from "../fixtures.ts"

/** An event as opencode 2 publishes it, of any type. */
export interface RawEvent {
  readonly type: string
  readonly data: Readonly<Record<string, unknown>>
}

/**
 * Makes the events opencode 2 publishes for the session `sessionID` as it runs it. Each step is an
 * assistant message, which its texts, reasonings, and tool calls name.
 */
export const eventsOf = (sessionID: string) => {
  const event = (type: string, data: Record<string, unknown> = {}): RawEvent => ({
    type,
    data: { sessionID, ...data }
  })
  return {
    delivered: (inboxID: string) => event("session.inbox.delivered", { inboxID }),
    executionStarted: () => event("session.execution.started"),
    succeeded: () => event("session.execution.succeeded"),
    failed: (message: string) => event("session.execution.failed", { error: { type: "provider.error", message } }),
    interrupted: (reason: string) => event("session.execution.interrupted", { reason }),
    stepStarted: (assistantMessageID: string) =>
      event("session.step.started", {
        assistantMessageID,
        agent: "build",
        model: { providerID: "opencode", id: "default-model" },
        started: 1_791_073_617_000
      }),
    stepEnded: (assistantMessageID: string, finish = "stop") =>
      event("session.step.ended", {
        assistantMessageID,
        finish,
        cost: 0,
        tokens: tokens(10, 5)
      }),
    stepFailed: (assistantMessageID: string, message: string) =>
      event("session.step.failed", {
        assistantMessageID,
        error: { type: "provider.error", message }
      }),
    started: (kind: "text" | "reasoning", assistantMessageID: string, ordinal = 0) =>
      event(`session.${kind}.started`, { assistantMessageID, ordinal }),
    delta: (kind: "text" | "reasoning", assistantMessageID: string, delta: string, ordinal = 0) =>
      event(`session.${kind}.delta`, { assistantMessageID, ordinal, delta }),
    ended: (kind: "text" | "reasoning", assistantMessageID: string, text: string, ordinal = 0) =>
      event(`session.${kind}.ended`, { assistantMessageID, ordinal, text }),
    inputStarted: (assistantMessageID: string, id: string, name: string) =>
      event("session.tool.input.started", { assistantMessageID, id, name }),
    inputDelta: (assistantMessageID: string, id: string, delta: string) =>
      event("session.tool.input.delta", { assistantMessageID, id, delta }),
    inputEnded: (assistantMessageID: string, id: string, text: string) =>
      event("session.tool.input.ended", { assistantMessageID, id, text }),
    called: (assistantMessageID: string, id: string, input: Record<string, unknown>) =>
      event("session.tool.called", { assistantMessageID, id, input, executed: false }),
    succeededCall: (assistantMessageID: string, id: string, text: string, metadata?: Record<string, unknown>) =>
      event("session.tool.success", {
        assistantMessageID,
        id,
        content: [{ type: "text", text }],
        ...(metadata === undefined ? {} : { metadata }),
        executed: false
      }),
    failedCall: (assistantMessageID: string, id: string, message: string) =>
      event("session.tool.failed", {
        assistantMessageID,
        id,
        error: { type: "tool.error", message },
        executed: false
      }),
    compacted: (reason: "auto" | "manual", text: string) =>
      event("session.compaction.ended", { reason, text, recent: "" }),
    compactionFailed: (reason: "auto" | "manual", message: string) =>
      event("session.compaction.failed", { reason, error: { type: "unknown", message } }),
    permission: (id: string, callID: string): RawEvent => ({
      type: "permission.asked",
      data: {
        id,
        sessionID,
        action: "shell",
        resources: ["make"],
        source: { type: "tool", messageID: "msg_1", id: callID }
      }
    }),
    form: (id: string): RawEvent => ({
      type: "form.created",
      data: { form: { id, sessionID, title: "Which one?", fields: [] } }
    })
  }
}

/** `event` decoded as the adapter reads it. */
export const decode = (event: RawEvent) => Schema.decodeUnknownSync(SessionEvent)(event)

/** The events of a turn that the prompt `inboxID` starts and that answers `text` in one step. */
export const answerEvents = (sessionID: string, inboxID: string, text: string, messageID = "msg_answer") => {
  const event = eventsOf(sessionID)
  return [
    event.delivered(inboxID),
    event.executionStarted(),
    event.stepStarted(messageID),
    event.started("text", messageID),
    event.delta("text", messageID, text),
    event.ended("text", messageID, text),
    event.stepEnded(messageID),
    event.succeeded()
  ]
}

/** A turn the fake server runs for a prompt it took. */
export interface FakeTurn {
  readonly sessionID: string

  /** The id of the input the prompt queued. */
  readonly inboxID: string

  /** The prompt's body, as opencode took it. */
  readonly body: Readonly<Record<string, unknown>>

  /** Publishes `events` to every subscription, in order. */
  readonly publish: (...events: ReadonlyArray<RawEvent>) => Effect.Effect<void>

  /** The bodies of the requests the server took so far, with the path each came to. */
  readonly bodies: ReadonlyArray<readonly [string, unknown]>
}

export interface FakeSession {
  readonly directory: string
}

export interface FakeOpencode {
  /** The port the server listens on, on this machine. */
  readonly port: Network.Port

  /** The requests the server took, in order, as `METHOD /path?query`. */
  readonly requests: ReadonlyArray<string>

  /** The bodies of the requests the server took, in order, with the path each came to. */
  readonly bodies: ReadonlyArray<readonly [string, unknown]>

  /** The sessions the server has now, by id, which a test deletes as when opencode loses them. */
  readonly sessions: Map<string, FakeSession>
}

export interface FakeOpencodeOptions {
  /**
   * The summary a compaction writes, published once the session is asked to compact. A summary
   * that says `failed` fails.
   */
  readonly summary?: string

  /** The status of an MCP server once it is added, `connected` unless this says otherwise. */
  readonly mcpStatus?: string
}

/**
 * A fake of opencode 2's server, with the requests of its session API that the agent makes, which
 * runs each prompt's turn with `runTurn`. It publishes every session's events on one stream, to
 * the subscriptions made before them, live only; an interrupt interrupts the session's turn. The
 * server stops when the scope closes.
 */
export const makeFakeOpencode = (runTurn: (turn: FakeTurn) => Effect.Effect<void>, options: FakeOpencodeOptions = {}) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const sessions = new Map<string, FakeSession>()
    const running = new Map<string, Fiber.Fiber<void>>()
    const requests: Array<string> = []
    const bodies: Array<readonly [string, unknown]> = []
    let created = 0
    let queued = 0
    const published = yield* SubscriptionRef.make<ReadonlyArray<RawEvent>>([])

    const publish = (...events: ReadonlyArray<RawEvent>) =>
      SubscriptionRef.update(published, (all) => [...all, ...events])

    const record = (path: string) =>
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
        Effect.map(request.json, (body) => {
          bodies.push([path, body])
          return body as Record<string, unknown>
        })
      )

    /** Answers a request about the session the path names, or 404 when the server has none. */
    const withSession = <E, R>(
      handle: (sessionID: string, session: FakeSession) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
    ) =>
      Effect.flatMap(HttpRouter.params, ({ sessionID = "" }) => {
        const session = sessions.get(sessionID)
        return session === undefined
          ? Effect.succeed(
              HttpServerResponse.jsonUnsafe(
                { _tag: "SessionNotFoundError", message: "Session not found" },
                { status: 404 }
              )
            )
          : handle(sessionID, session)
      })

    const noContent = HttpServerResponse.empty({ status: 204 })

    const routes = HttpRouter.use((router) =>
      router.addAll([
        HttpRouter.route(
          "POST",
          "/api/session",
          Effect.gen(function* () {
            const body = yield* record("/api/session")
            created += 1
            const sessionID = `ses_fake${created}`
            sessions.set(sessionID, { directory: directoryOf(body) })
            return HttpServerResponse.jsonUnsafe({ data: { id: sessionID } })
          })
        ),

        HttpRouter.route(
          "POST",
          "/api/experimental/session/import",
          Effect.gen(function* () {
            const body = yield* record("/api/experimental/session/import")
            const { id } = (body.info ?? {}) as { id?: string }
            if (id === undefined || sessions.has(id)) {
              return HttpServerResponse.jsonUnsafe({ _tag: "ConflictError" }, { status: 409 })
            }
            sessions.set(id, { directory: directoryOf(body) })
            return HttpServerResponse.jsonUnsafe({ data: { id } })
          })
        ),

        HttpRouter.route(
          "GET",
          "/api/session/:sessionID",
          withSession((sessionID) => Effect.succeed(HttpServerResponse.jsonUnsafe({ data: { id: sessionID } })))
        ),

        HttpRouter.route(
          "DELETE",
          "/api/session/:sessionID",
          withSession((sessionID) =>
            Effect.sync(() => {
              sessions.delete(sessionID)
              return noContent
            })
          )
        ),

        HttpRouter.route(
          "POST",
          "/api/session/:sessionID/model",
          withSession((sessionID) => Effect.as(record(`/api/session/${sessionID}/model`), noContent))
        ),

        HttpRouter.route(
          "PUT",
          "/api/experimental/session/:sessionID/instructions/entries/:key",
          withSession((sessionID) =>
            Effect.flatMap(HttpRouter.params, ({ key = "" }) =>
              Effect.as(record(`/api/session/${sessionID}/instructions/${key}`), noContent)
            )
          )
        ),

        HttpRouter.route(
          "DELETE",
          "/api/experimental/session/:sessionID/instructions/entries/:key",
          withSession(() => Effect.succeed(noContent))
        ),

        HttpRouter.route(
          "POST",
          "/api/session/:sessionID/prompt",
          withSession((sessionID) =>
            Effect.gen(function* () {
              const body = yield* record(`/api/session/${sessionID}/prompt`)
              queued += 1
              const inboxID = `msg_prompt${queued}`
              const turn = runTurn({ sessionID, inboxID, body, publish, bodies }).pipe(
                Effect.ensuring(Effect.sync(() => running.delete(sessionID)))
              )
              running.set(sessionID, yield* Effect.forkIn(turn, scope))
              return HttpServerResponse.jsonUnsafe({ data: { id: inboxID } })
            })
          )
        ),

        HttpRouter.route(
          "POST",
          "/api/session/:sessionID/compact",
          withSession((sessionID) =>
            Effect.gen(function* () {
              yield* record(`/api/session/${sessionID}/compact`)
              const event = eventsOf(sessionID)
              const summary = options.summary ?? "The summary."
              // The session subscribes to its events before it asks to compact.
              yield* publish(
                summary === "failed" ? event.compactionFailed("manual", "No model") : event.compacted("manual", summary)
              )
              return HttpServerResponse.jsonUnsafe({ data: { id: "msg_compaction" } })
            })
          )
        ),

        HttpRouter.route(
          "POST",
          "/api/session/:sessionID/interrupt",
          withSession((sessionID) => {
            const turn = running.get(sessionID)
            return Effect.as(
              turn === undefined ? Effect.void : Fiber.interrupt(turn),
              HttpServerResponse.jsonUnsafe({ interrupted: turn !== undefined })
            )
          })
        ),

        HttpRouter.route(
          "POST",
          "/api/session/:sessionID/permission/:requestID/reply",
          withSession((sessionID) =>
            Effect.flatMap(HttpRouter.params, ({ requestID = "" }) =>
              Effect.as(record(`/api/session/${sessionID}/permission/${requestID}`), noContent)
            )
          )
        ),

        HttpRouter.route(
          "DELETE",
          "/api/session/:sessionID/form/:formID",
          withSession(() => Effect.succeed(noContent))
        ),

        HttpRouter.route(
          "PUT",
          "/api/experimental/mcp/:name",
          Effect.flatMap(HttpRouter.params, ({ name = "" }) =>
            Effect.as(record(`/api/experimental/mcp/${name}`), noContent)
          )
        ),

        HttpRouter.route("POST", "/api/experimental/mcp/:name/connect", Effect.succeed(noContent)),

        HttpRouter.route(
          "GET",
          "/api/mcp",
          Effect.sync(() =>
            HttpServerResponse.jsonUnsafe({
              data: bodies
                .filter(([path]) => path.startsWith("/api/experimental/mcp/"))
                .map(([path]) => ({
                  name: path.slice("/api/experimental/mcp/".length),
                  status: { status: options.mcpStatus ?? "connected" }
                }))
            })
          )
        ),

        HttpRouter.route("POST", "/api/experimental/mcp/:name/disconnect", Effect.succeed(noContent)),

        HttpRouter.route(
          "GET",
          "/api/event",
          Effect.gen(function* () {
            // Only events published after the subscription reach it.
            const from = (yield* SubscriptionRef.get(published)).length
            return HttpServerResponse.stream(
              // opencode announces a subscription with an event of its own, as here.
              Stream.concat(
                Stream.make('data: {"type":"server.connected","data":{}}\n\n'),
                SubscriptionRef.changes(published).pipe(
                  Stream.mapAccum(
                    () => from,
                    (last, all) => [Math.max(last, all.length), all.slice(last)] as const
                  ),
                  Stream.map((event) =>
                    event.type === "fake.unreadable" ? "data: not an event\n\n" : `data: ${JSON.stringify(event)}\n\n`
                  )
                )
              ).pipe(Stream.encodeText),
              { contentType: "text/event-stream" }
            )
          })
        )
      ])
    )
    const app = yield* HttpRouter.toHttpEffect(routes)

    const server = yield* BunHttpServer.make({ hostname: "127.0.0.1", port: 0, idleTimeout: 0 })
    yield* server.serve(
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
        Effect.andThen(
          Effect.sync(() => {
            const url = new URL(request.url, "http://fake")
            requests.push(`${request.method} ${decodeURIComponent(url.pathname + url.search)}`)
          }),
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
      sessions
    }
    return fake
  })

const directoryOf = (body: Record<string, unknown>) => ((body.location ?? {}) as { directory?: string }).directory ?? ""
