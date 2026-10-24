/**
 * The requests the driver makes of opencode's server over opencode 2's session API. opencode 2
 * keeps each session at a location, its directory, which the session's own requests need not name,
 * and publishes the events of every session on one stream, live only. `make` gives the requests
 * over the client of a started server. A failed request fails with the `HarnessError` the driver
 * reports.
 */

import { HarnessError } from "@amends-dev/harness"
import * as Effect from "effect/Effect"
import * as Sse from "effect/encoding/Sse"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type { ModelRef } from "../driver.ts"
import type { RemoteMcpServer } from "../hostTools.ts"
import * as Server from "../server.ts"
import { SessionEvent, sessionIdOf } from "./event.ts"
import type { Message, PromptInput } from "./prompt.ts"

/** How a tool goes on after asking the user's permission: this once, always, or not at all. */
export type PermissionDecision = "once" | "always" | "reject"

export interface Api {
  /** Creates a session working in `directory` on `model`, returning its id. */
  readonly createSession: (directory: string, model: ModelRef) => Effect.Effect<string, HarnessError.HarnessError>

  /**
   * Creates the session `sessionID` working in `directory` on `model`, as if it had recorded
   * `messages`, the conversation its model reads.
   */
  readonly importSession: (options: {
    readonly sessionID: string
    readonly directory: string
    readonly model: ModelRef
    readonly now: number
    readonly messages: ReadonlyArray<Message>
  }) => Effect.Effect<void, HarnessError.HarnessError>

  /** Whether the server has the session, as it does unless the sandbox lost opencode's data. */
  readonly hasSession: (sessionID: string) => Effect.Effect<boolean, HarnessError.HarnessError>

  /** Deletes the session and everything it recorded. Deleting a deleted session succeeds. */
  readonly deleteSession: (sessionID: string) => Effect.Effect<void, HarnessError.HarnessError>

  /** Runs the session's next steps on `model`. */
  readonly switchModel: (sessionID: string, model: ModelRef) => Effect.Effect<void, HarnessError.HarnessError>

  /**
   * Gives the session's model `text` as the instructions under `key`, which it reads beside its
   * own from the next step, until they are replaced or removed.
   */
  readonly putInstructions: (
    sessionID: string,
    key: string,
    text: string
  ) => Effect.Effect<void, HarnessError.HarnessError>

  readonly removeInstructions: (sessionID: string, key: string) => Effect.Effect<void, HarnessError.HarnessError>

  /**
   * Gives the session a prompt, after any work it has queued, returning the id of the input it
   * queued. opencode runs the session from it, and the session's events follow on the stream
   * `subscribe` returns.
   */
  readonly prompt: (sessionID: string, prompt: PromptInput) => Effect.Effect<string, HarnessError.HarnessError>

  /**
   * Asks the session to replace its conversation so far with a summary, at its next step, or now
   * when it is idle. `session.compaction.ended` follows on the stream `subscribe` returns.
   */
  readonly compact: (sessionID: string) => Effect.Effect<void, HarnessError.HarnessError>

  /** Stops running the session. Interrupting a session that runs nothing does nothing. */
  readonly interrupt: (sessionID: string) => Effect.Effect<void, HarnessError.HarnessError>

  /**
   * Subscribes to the events of the session, returning once opencode publishes them to the
   * subscription, with the stream of them from then on, which ends when the scope closes. The
   * stream does not end by itself. Events of types the adapter does not read are left out.
   */
  readonly subscribe: (
    sessionID: string
  ) => Effect.Effect<Stream.Stream<SessionEvent, HarnessError.HarnessError>, HarnessError.HarnessError, Scope.Scope>

  /** Answers a tool's request for permission, with `message` for the model when it refuses. */
  readonly replyPermission: (
    sessionID: string,
    requestID: string,
    decision: PermissionDecision,
    message?: string
  ) => Effect.Effect<void, HarnessError.HarnessError>

  /** Cancels a form the model asked the user to fill, telling the model why. */
  readonly cancelForm: (
    sessionID: string,
    formID: string,
    message: string
  ) => Effect.Effect<void, HarnessError.HarnessError>

  /**
   * Adds the MCP server `name` for the sessions in `directory`, connecting to it and listing its
   * tools for the model. Adding a name again replaces the server.
   */
  readonly addMcpServer: (
    directory: string,
    name: string,
    server: RemoteMcpServer
  ) => Effect.Effect<void, HarnessError.HarnessError>

  /**
   * Waits until opencode has connected to the MCP server `name` for the sessions in `directory`,
   * whose tools the model sees only from then on, failing when it has not within 10 seconds or
   * failed to.
   */
  readonly awaitMcpServer: (directory: string, name: string) => Effect.Effect<void, HarnessError.HarnessError>

  /** Connects to the MCP server `name` again, listing its tools anew. */
  readonly reconnectMcpServer: (directory: string, name: string) => Effect.Effect<void, HarnessError.HarnessError>

  /** Disconnects from the MCP server `name`, taking its tools from the model. */
  readonly disconnectMcpServer: (directory: string, name: string) => Effect.Effect<void, HarnessError.HarnessError>
}

/** The requests of opencode 2's session API, made of `server`. */
export const make = (server: Server.Server): Api => {
  const { client, clientOk } = server
  const fromRequestError = Server.requestError(server.agent)
  const sessionPath = (sessionID: string, rest = "") => `/api/session/${encodeURIComponent(sessionID)}${rest}`
  /** A location's query, which names its directory as a deep object. */
  const location = (directory: string) => ({ "location[directory]": directory })
  const mcpPath = (name: string, rest = "") => `/api/experimental/mcp/${encodeURIComponent(name)}${rest}`

  const send = (request: HttpClientRequest.HttpClientRequest) =>
    clientOk.execute(request).pipe(Effect.asVoid, Effect.mapError(fromRequestError))

  /** Whether a request about something the server may not have answers 2xx rather than 404. */
  const exists = (request: HttpClientRequest.HttpClientRequest) =>
    client.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatus((status) => (status >= 200 && status < 300) || status === 404)),
      Effect.map((response) => response.status !== 404),
      Effect.mapError(fromRequestError)
    )

  /** Sends `request` with `body`, returning the id of what the server answers it made. */
  const createdId = (request: HttpClientRequest.HttpClientRequest, body: unknown) =>
    request.pipe(
      HttpClientRequest.bodyJsonUnsafe(body),
      clientOk.execute,
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Created)),
      Effect.map((created) => created.data.id),
      Effect.mapError(fromRequestError)
    )

  return {
    createSession: (directory, model) =>
      createdId(HttpClientRequest.post("/api/session"), { location: { directory }, model }),

    importSession: ({ sessionID, directory, model, now, messages }) =>
      Effect.asVoid(
        createdId(HttpClientRequest.post("/api/experimental/session/import"), {
          info: {
            id: sessionID,
            // opencode imports the session into the project of its directory, whatever this says.
            projectID: "global",
            model,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: now, updated: now },
            location: { directory }
          },
          messages,
          location: { directory }
        })
      ),

    hasSession: (sessionID) => exists(HttpClientRequest.get(sessionPath(sessionID))),

    deleteSession: (sessionID) => Effect.asVoid(exists(HttpClientRequest.delete(sessionPath(sessionID)))),

    switchModel: (sessionID, model) =>
      send(HttpClientRequest.post(sessionPath(sessionID, "/model")).pipe(HttpClientRequest.bodyJsonUnsafe({ model }))),

    putInstructions: (sessionID, key, text) =>
      send(
        HttpClientRequest.put(instructionsPath(sessionID, key)).pipe(HttpClientRequest.bodyJsonUnsafe({ value: text }))
      ),

    removeInstructions: (sessionID, key) =>
      Effect.asVoid(exists(HttpClientRequest.delete(instructionsPath(sessionID, key)))),

    // Queued, a prompt waits for work the session runs already, such as a turn the bridge left
    // running when it died, rather than joining it.
    prompt: (sessionID, prompt) =>
      createdId(HttpClientRequest.post(sessionPath(sessionID, "/prompt")), {
        ...prompt,
        delivery: "queue"
      }),

    compact: (sessionID) =>
      send(HttpClientRequest.post(sessionPath(sessionID, "/compact")).pipe(HttpClientRequest.bodyJsonUnsafe({}))),

    interrupt: (sessionID) => send(HttpClientRequest.post(sessionPath(sessionID, "/interrupt"))),

    subscribe: (sessionID) =>
      HttpClient.withScope(clientOk)
        .get("/api/event")
        .pipe(
          Effect.map((response) =>
            response.stream.pipe(
              Stream.decodeText(),
              Stream.pipeThroughChannel(Sse.decodeDataSchema(StreamedEvent)),
              Stream.map((event) => event.data),
              Stream.filter(Schema.is(SessionEvent)),
              Stream.filter((event) => sessionIdOf(event) === sessionID),
              Stream.mapError(fromRequestError)
            )
          ),
          Effect.mapError(fromRequestError)
        ),

    replyPermission: (sessionID, requestID, decision, message) =>
      send(
        HttpClientRequest.post(sessionPath(sessionID, `/permission/${encodeURIComponent(requestID)}/reply`)).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            decision,
            ...(message === undefined ? {} : { message })
          })
        )
      ),

    cancelForm: (sessionID, formID, message) =>
      send(
        HttpClientRequest.delete(sessionPath(sessionID, `/form/${encodeURIComponent(formID)}`), {
          urlParams: { message }
        })
      ),

    addMcpServer: (directory, name, mcpServer) =>
      send(
        HttpClientRequest.put(mcpPath(name), { urlParams: location(directory) }).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            config: { type: "remote", url: mcpServer.url, headers: mcpServer.headers }
          })
        )
      ),

    awaitMcpServer: (directory, name) =>
      clientOk.get("/api/mcp", { urlParams: location(directory) }).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(McpServers)),
        Effect.map(({ data }) => data.find((mcp) => mcp.name === name)?.status.status),
        Effect.mapError(fromRequestError),
        Effect.repeat({
          until: (status) => status !== undefined && status !== "pending",
          schedule: Schedule.spaced("100 millis")
        }),
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () => Effect.succeed("pending")
        }),
        Effect.flatMap((status) =>
          status === "connected"
            ? Effect.void
            : Effect.fail(
                Server.harnessError(
                  server.agent,
                  new HarnessError.UnavailableError({
                    description: `opencode did not connect to the host's tools: it reports them ${status}`
                  })
                )
              )
        )
      ),

    reconnectMcpServer: (directory, name) =>
      send(HttpClientRequest.post(mcpPath(name, "/connect"), { urlParams: location(directory) })),

    disconnectMcpServer: (directory, name) =>
      send(HttpClientRequest.post(mcpPath(name, "/disconnect"), { urlParams: location(directory) }))
  }
}

const instructionsPath = (sessionID: string, key: string) =>
  `/api/experimental/session/${encodeURIComponent(sessionID)}/instructions/entries/${encodeURIComponent(key)}`

/** The MCP servers of a location, each with its status, such as `pending` or `connected`. */
const McpServers = Schema.Struct({
  data: Schema.Array(Schema.Struct({ name: Schema.String, status: Schema.Struct({ status: Schema.String }) }))
})

/** What the server answers it made, such as a session or an input it queued. */
const Created = Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })

/** An event of a type the adapter does not read, which `subscribe` leaves out. */
const OtherEvent = Schema.Struct({
  type: Schema.String.check(Schema.makeFilter((type: string) => !Object.hasOwn(SessionEvent.cases, type)))
})

/**
 * An event as the server streams it. A known type that does not decode fails, rather than being
 * left out as an event of another type.
 */
const StreamedEvent = Schema.Union([SessionEvent, OtherEvent])
