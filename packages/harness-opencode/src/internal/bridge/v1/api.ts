/**
 * The requests the driver makes of opencode's server over opencode 1's session API, for the
 * sessions of one directory: opencode 1 keeps an instance for each directory, which every request
 * names, and publishes the events of its sessions on one stream, live only. `make` gives them over
 * the client of a started server. A failed request fails with the `HarnessError` the driver
 * reports.
 */

import type { HarnessError } from "@amends-dev/harness"
import * as Effect from "effect/Effect"
import * as Sse from "effect/encoding/Sse"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type { RemoteMcpServer } from "../hostTools.ts"
import * as Server from "../server.ts"
import { type MessageModel, Message, Part, SessionEvent } from "./event.ts"

/** A part of a prompt: text, or a file the model reads, at a URL such as a `data:` URL. */
export type PromptPart =
  | { readonly type: "text"; readonly text: string; readonly synthetic?: boolean }
  | {
      readonly type: "file"
      readonly mime: string
      readonly url: string
      readonly filename?: string
    }

/** What a prompt gives the session, beside its parts. */
export interface PromptOptions {
  readonly model: MessageModel

  /** A variant of the model, such as one that asks for an effort. */
  readonly variant?: string

  /** Instructions for the turn, as the system prompt the model reads for it. */
  readonly system?: string

  /** Asks the model to answer in JSON that matches `schema`. */
  readonly format?: { readonly type: "json_schema"; readonly schema: Schema.Json }

  /** Enables or disables opencode's own tools by name for the turn. */
  readonly tools?: Readonly<Record<string, boolean>>

  readonly parts: ReadonlyArray<PromptPart>
}

/** How a tool goes on after asking the user's permission: this once, always, or not at all. */
export type PermissionReply = "once" | "always" | "reject"

/** A message of a session as opencode keeps it: its state and its parts. */
export const MessageWithParts = Schema.Struct({ info: Message, parts: Schema.Array(Part) })

export type MessageWithParts = typeof MessageWithParts.Type

export interface Api {
  /** Creates a session working in the directory, returning its id. */
  readonly createSession: Effect.Effect<string, HarnessError.HarnessError>

  /** Whether the server has the session, as it does unless the sandbox lost opencode's data. */
  readonly hasSession: (sessionID: string) => Effect.Effect<boolean, HarnessError.HarnessError>

  /** Deletes the session and its messages. Deleting a deleted session succeeds. */
  readonly deleteSession: (sessionID: string) => Effect.Effect<void, HarnessError.HarnessError>

  /**
   * Gives the session a prompt, which starts a turn, returning as soon as opencode has it. The
   * turn's events follow on the stream `subscribe` returns.
   */
  readonly prompt: (sessionID: string, options: PromptOptions) => Effect.Effect<void, HarnessError.HarnessError>

  /**
   * Adds a message of the user to the session that the model reads with the next prompt and does
   * not answer now, returning once the session has it.
   */
  readonly addMessage: (
    sessionID: string,
    model: MessageModel,
    parts: ReadonlyArray<PromptPart>
  ) => Effect.Effect<void, HarnessError.HarnessError>

  /** Ends the session's running turn. Aborting a session that runs none does nothing. */
  readonly abort: (sessionID: string) => Effect.Effect<void, HarnessError.HarnessError>

  /**
   * Asks the session to replace its conversation so far with a summary written by `model`. The
   * summary is a message of the session, and `session.compacted` follows it on `events`.
   */
  readonly summarize: (sessionID: string, model: MessageModel) => Effect.Effect<void, HarnessError.HarnessError>

  /** Whether opencode is working on a turn of the session. */
  readonly isRunning: (sessionID: string) => Effect.Effect<boolean, HarnessError.HarnessError>

  /** The session's messages, oldest first, each with its parts. */
  readonly messages: (sessionID: string) => Effect.Effect<ReadonlyArray<MessageWithParts>, HarnessError.HarnessError>

  /**
   * Subscribes to the events of the directory's sessions, returning once opencode publishes them to
   * the subscription, with the stream of them from then on, which ends when the scope closes. The
   * stream does not end by itself. Events of types the adapter does not read are left out.
   */
  readonly subscribe: Effect.Effect<
    Stream.Stream<SessionEvent, HarnessError.HarnessError>,
    HarnessError.HarnessError,
    Scope.Scope
  >

  /** Answers a tool's request for permission. */
  readonly replyPermission: (
    requestID: string,
    reply: PermissionReply,
    message?: string
  ) => Effect.Effect<void, HarnessError.HarnessError>

  /** Refuses the model's questions to the user, which the model reads as refused. */
  readonly rejectQuestion: (requestID: string) => Effect.Effect<void, HarnessError.HarnessError>

  /**
   * Adds the MCP server `name` to the directory's instance, connecting to it and listing its tools
   * for the model as `<name>_<tool>`. Adding a name again replaces the server.
   */
  readonly addMcpServer: (name: string, server: RemoteMcpServer) => Effect.Effect<void, HarnessError.HarnessError>

  /** Connects to the MCP server `name` again, listing its tools anew. */
  readonly reconnectMcpServer: (name: string) => Effect.Effect<void, HarnessError.HarnessError>

  /** Disconnects from the MCP server `name`, taking its tools from the model. */
  readonly disconnectMcpServer: (name: string) => Effect.Effect<void, HarnessError.HarnessError>
}

/** The requests of opencode 1's session API for the sessions of `directory`, made of `server`. */
export const make = (server: Server.Server, directory: string): Api => {
  const { client, clientOk } = server
  const fromRequestError = Server.requestError(server.agent)
  const urlParams = { directory }
  const sessionPath = (sessionID: string, rest = "") => `/session/${encodeURIComponent(sessionID)}${rest}`

  const send = (request: HttpClientRequest.HttpClientRequest) =>
    clientOk
      .execute(HttpClientRequest.appendUrlParams(request, urlParams))
      .pipe(Effect.asVoid, Effect.mapError(fromRequestError))

  /** Whether a request about something the server may not have answers 200 rather than 404. */
  const exists = (request: HttpClientRequest.HttpClientRequest) =>
    client.execute(HttpClientRequest.appendUrlParams(request, urlParams)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatus((status) => status === 200 || status === 404)),
      Effect.map((response) => response.status === 200),
      Effect.mapError(fromRequestError)
    )

  return {
    createSession: HttpClientRequest.post("/session").pipe(
      HttpClientRequest.appendUrlParams(urlParams),
      HttpClientRequest.bodyJsonUnsafe({}),
      clientOk.execute,
      Effect.flatMap(HttpClientResponse.schemaBodyJson(CreatedSession)),
      Effect.map((created) => created.id),
      Effect.mapError(fromRequestError)
    ),

    hasSession: (sessionID) => exists(HttpClientRequest.get(sessionPath(sessionID))),

    deleteSession: (sessionID) => Effect.asVoid(exists(HttpClientRequest.delete(sessionPath(sessionID)))),

    prompt: (sessionID, options) =>
      send(
        HttpClientRequest.post(sessionPath(sessionID, "/prompt_async")).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            model: options.model,
            ...(options.variant === undefined ? {} : { variant: options.variant }),
            ...(options.system === undefined ? {} : { system: options.system }),
            ...(options.format === undefined ? {} : { format: options.format }),
            ...(options.tools === undefined ? {} : { tools: options.tools }),
            parts: options.parts
          })
        )
      ),

    addMessage: (sessionID, model, parts) =>
      send(
        HttpClientRequest.post(sessionPath(sessionID, "/message")).pipe(
          HttpClientRequest.bodyJsonUnsafe({ model, noReply: true, parts })
        )
      ),

    abort: (sessionID) => send(HttpClientRequest.post(sessionPath(sessionID, "/abort"))),

    summarize: (sessionID, model) =>
      send(
        HttpClientRequest.post(sessionPath(sessionID, "/summarize")).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            providerID: model.providerID,
            modelID: model.modelID
          })
        )
      ),

    isRunning: (sessionID) =>
      clientOk.get("/session/status", { urlParams }).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(SessionStatuses)),
        Effect.map((statuses) => {
          const status = Object.hasOwn(statuses, sessionID) ? statuses[sessionID] : undefined
          return status !== undefined && status.type !== "idle"
        }),
        Effect.mapError(fromRequestError)
      ),

    messages: (sessionID) =>
      clientOk
        .get(sessionPath(sessionID, "/message"), { urlParams })
        .pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Array(MessageWithParts))),
          Effect.mapError(fromRequestError)
        ),

    subscribe: HttpClient.withScope(clientOk)
      .get("/event", { urlParams })
      .pipe(
        Effect.map((response) =>
          response.stream.pipe(
            Stream.decodeText(),
            Stream.pipeThroughChannel(Sse.decodeDataSchema(StreamedEvent)),
            Stream.map((event) => event.data),
            Stream.filter(Schema.is(SessionEvent)),
            Stream.mapError(fromRequestError)
          )
        ),
        Effect.mapError(fromRequestError)
      ),

    replyPermission: (requestID, reply, message) =>
      send(
        HttpClientRequest.post(`/permission/${encodeURIComponent(requestID)}/reply`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            reply,
            ...(message === undefined ? {} : { message })
          })
        )
      ),

    rejectQuestion: (requestID) => send(HttpClientRequest.post(`/question/${encodeURIComponent(requestID)}/reject`)),

    addMcpServer: (name, mcpServer) =>
      send(
        HttpClientRequest.post("/mcp").pipe(
          HttpClientRequest.bodyJsonUnsafe({
            name,
            config: { type: "remote", url: mcpServer.url, headers: mcpServer.headers }
          })
        )
      ),

    reconnectMcpServer: (name) => send(HttpClientRequest.post(`/mcp/${encodeURIComponent(name)}/connect`)),

    disconnectMcpServer: (name) => send(HttpClientRequest.post(`/mcp/${encodeURIComponent(name)}/disconnect`))
  }
}

const CreatedSession = Schema.Struct({ id: Schema.String })

/** The status of each session the server is working on, by id. */
const SessionStatuses = Schema.Record(Schema.String, Schema.Struct({ type: Schema.String }))

/** An event of a type the adapter does not read, which `events` leaves out. */
const OtherEvent = Schema.Struct({
  type: Schema.String.check(Schema.makeFilter((type: string) => !Object.hasOwn(SessionEvent.cases, type)))
})

/**
 * An event as the server streams it. A known type that does not decode fails, rather than being
 * left out as an event of another type.
 */
const StreamedEvent = Schema.Union([SessionEvent, OtherEvent])
