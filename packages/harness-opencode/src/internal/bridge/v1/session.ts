/**
 * A session of opencode 1's session API, as the driver runs it: an opencode session in the
 * session's directory. A turn is a prompt to it, with the turn's instructions as its system prompt,
 * the schema of an answer in JSON, the files of the prompt, and the turn's model; `Turn`
 * translates the events opencode publishes for the turn as they happen. A session that starts
 * with a conversation from another agent has it written into the session first, as `Prompt`
 * writes it.
 *
 * The host's tools reach opencode through the bridge's `HostToolRelay`, as `HostTools` lists them,
 * and opencode names them `host_<tool>`: the relay streams their calls, which the host answers with
 * `submitToolResult`. A tool of opencode's own that asks
 * permission waits for `approve`. `compact` asks opencode to summarize the conversation, which it
 * does without instructions.
 */

import { type Bridge, HarnessError, type HostToolRelay } from "@amends-dev/harness"
import type * as Prompt from "effect/ai/Prompt"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Ref from "effect/Ref"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type * as Driver from "../driver.ts"
import * as HostTools from "../hostTools.ts"
import * as Server from "../server.ts"
import * as Api from "./api.ts"
import { type AssistantMessage, isTextPart, type MessageModel } from "./event.ts"
import { conversationPartsOf, promptPartsOf } from "./prompt.ts"
import * as Turn from "./turn.ts"

/**
 * The name opencode gives the host's tool `name`: the MCP server's name and the tool's, each with
 * the characters MCP's names leave out replaced.
 */
export const hostToolName = (name: string) => `${HostTools.serverName}_${name.replace(/[^\w-]/g, "_")}`

/** What `state` returns, for `createSession` to take back. */
const State = Schema.Struct({ sessionID: Schema.String })

const StateJson = Schema.toCodecJson(State)

/**
 * The function that creates sessions as `Driver.CreateSession` does, each with a session of
 * `relay` for the host's tools: a new opencode session, or the one its `agentState` names, when
 * opencode still has it.
 */
export const makeCreateSession =
  (relay: HostToolRelay.HostToolRelay["Service"]): Driver.CreateSession =>
  (server, options, sessionOptions) =>
    Effect.gen(function* () {
      const api = Api.make(server, sessionOptions.directory)
      const harnessError = (reason: HarnessError.HarnessErrorReason, cause?: unknown) =>
        Server.harnessError(server.agent, reason, cause)
      // opencode may have lost the session, as when the sandbox lost its data, and then starts one
      // from the conversation.
      const saved = yield* readState(harnessError, sessionOptions.agentState)
      const kept = saved !== undefined && (yield* api.hasSession(saved.sessionID)) ? saved : undefined
      const sessionID =
        kept?.sessionID ?? (yield* createOpencodeSession(api, messageModelOf(options.model), sessionOptions.history))
      const relaySession = yield* relay.open(sessionOptions.id)
      const listHostTools = yield* HostTools.makeLister(relay.url, relaySession, {
        add: (mcpServer) => api.addMcpServer(HostTools.serverName, mcpServer),
        reconnect: api.reconnectMcpServer(HostTools.serverName),
        disconnect: api.disconnectMcpServer(HostTools.serverName)
      })
      // opencode reports the files a tool changed by their real paths.
      const fs = yield* FileSystem.FileSystem
      const realDirectory = yield* fs
        .realPath(sessionOptions.directory)
        .pipe(Effect.orElseSucceed(() => sessionOptions.directory))

      /** What opencode is prompted with for a turn with `turnOptions`. */
      const promptOptionsOf = Effect.fnUntraced(function* (turnOptions: Bridge.TurnOptions) {
        const model = yield* modelNamed(harnessError, options, turnOptions.model)
        const { responseFormat } = turnOptions
        const prompt: Api.PromptOptions = {
          model: messageModelOf(model),
          ...(model.variant === undefined ? {} : { variant: model.variant }),
          ...(turnOptions.instructions === undefined ? {} : { system: turnOptions.instructions }),
          ...(responseFormat.type === "json" ? { format: { type: "json_schema", schema: responseFormat.schema } } : {}),
          // A question to the user would wait for an answer no host gives.
          tools: { question: false },
          parts: promptPartsOf(turnOptions.prompt)
        }
        return prompt
      })

      /**
       * Runs a turn, streaming its parts until its `finish`, with the calls the relay streams of
       * the host's tools. A stream that ends before the turn finishes, as when the bridge aborts the
       * turn, aborts the turn in opencode.
       */
      const promptTurn = (turnOptions: Bridge.TurnOptions) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const prompt = yield* promptOptionsOf(turnOptions)
            const finished = yield* Ref.make(false)
            // Aborting a session that runs no turn does nothing, so this holds from before opencode
            // takes the prompt.
            yield* Effect.addFinalizer(() =>
              Effect.flatMap(Ref.get(finished), (done) => (done ? Effect.void : Effect.ignore(api.abort(sessionID))))
            )
            const hostCalls =
              turnOptions.tools.length === 0 ? Stream.empty : yield* relaySession.offerTools(turnOptions.tools)
            yield* listHostTools(turnOptions.tools)
            // The turn's events are published only to subscriptions made before them.
            const events = yield* api.subscribe
            yield* api.prompt(sessionID, prompt)
            const translated = yield* Ref.make(
              Turn.initial({
                sessionID,
                directory: realDirectory,
                hostTools: new Set(turnOptions.tools.map((tool) => hostToolName(tool.name)))
              })
            )
            const ended = harnessError(
              new HarnessError.UnavailableError({
                description: "opencode's events ended before the turn did"
              })
            )
            const turnParts = events.pipe(
              Stream.tap((event) =>
                event.type === "question.asked" ? Effect.ignore(api.rejectQuestion(event.properties.id)) : Effect.void
              ),
              Stream.concat(Stream.fail(ended)),
              Stream.mapEffect((event) =>
                Ref.modify(translated, (turn) => {
                  const [next, parts] = Turn.translate(turn, event)
                  return [parts, next] as const
                })
              ),
              Stream.flattenIterable,
              Stream.takeUntil((part) => part.type === "finish"),
              Stream.tap((part) => (part.type === "finish" ? Ref.set(finished, true) : Effect.void))
            )
            return Stream.merge(turnParts, hostCalls, { haltStrategy: "left" })
          })
        )

      /**
       * Asks opencode to summarize the conversation, on the model of its last step, and waits for
       * the summary it writes as a message of the session.
       */
      const compact = Effect.fnUntraced(function* (instructions?: string) {
        if (instructions !== undefined && instructions.trim() !== "") {
          return yield* harnessError(
            new HarnessError.UnsupportedError({
              description: "opencode 1 summarizes a conversation without instructions"
            })
          )
        }
        const before = yield* api.messages(sessionID)
        const lastStep = before.findLast(({ info }) => info.role === "assistant")?.info
        const model =
          lastStep?.role === "assistant"
            ? { providerID: lastStep.providerID, modelID: lastStep.modelID }
            : messageModelOf(options.model)
        const summariesBefore = before.filter(({ info }) => isSummary(info)).length
        yield* api.summarize(sessionID, model)
        const summary = yield* api.messages(sessionID).pipe(
          Effect.map((messages) => messages.filter(({ info }) => isSummary(info))[summariesBefore]),
          Effect.repeat({
            until: (written) =>
              written !== undefined && written.info.role === "assistant" && written.info.time.completed !== undefined,
            schedule: Schedule.spaced("1 second").pipe(Schedule.upTo({ duration: "10 minutes" }))
          })
        )
        if (summary === undefined || summary.info.role !== "assistant") {
          return yield* harnessError(
            new HarnessError.UnavailableError({
              description: "opencode did not summarize the conversation within 10 minutes"
            })
          )
        }
        if (summary.info.error !== undefined) {
          return yield* harnessError(
            new HarnessError.UnknownError({
              description: `opencode failed to summarize the conversation: ${
                summary.info.error.data?.message ?? summary.info.error.name
              }`
            })
          )
        }
        const text = summary.parts.flatMap((part) => (isTextPart(part) ? [part.text] : []))
        return {
          type: "compaction",
          trigger: "manual",
          summary: text.join("\n")
        } as const
      })

      const session: Bridge.DriverSession = {
        keptConversation: kept !== undefined,
        promptTurn,
        submitToolResult: relaySession.submitToolResult,
        approve: ({ approvalId, approved, reason }) =>
          api.replyPermission(approvalId, approved ? "once" : "reject", approved ? undefined : reason),
        compact,
        state: Effect.orDie(Schema.encodeEffect(StateJson)({ sessionID })),
        destroy: api.deleteSession(sessionID)
      }
      return session
    })

/** The error the agent reports for `reason`, as `Server.harnessError` makes it for the agent. */
type HarnessErrorOf = (reason: HarnessError.HarnessErrorReason, cause?: unknown) => HarnessError.HarnessError

/**
 * A new opencode session holding `history`, which the model reads with the session's first
 * prompt. A session the history could not be written into is deleted.
 */
const createOpencodeSession = Effect.fnUntraced(function* (api: Api.Api, model: MessageModel, history: Prompt.Prompt) {
  const sessionID = yield* api.createSession
  const parts = conversationPartsOf(history)
  if (parts.length > 0) {
    yield* api
      .addMessage(sessionID, model, parts)
      .pipe(Effect.onError(() => Effect.ignore(api.deleteSession(sessionID))))
  }
  return sessionID
})

const isSummary = (info: AssistantMessage | { readonly role: "user" }) =>
  info.role === "assistant" && info.summary === true

/** A model as opencode 1's prompts name it, without the variant, which a prompt gives apart. */
const messageModelOf = (model: Driver.ModelRef): MessageModel => ({
  providerID: model.providerID,
  modelID: model.id
})

/** The model a turn that names `name` runs on, failing for a name the options do not give. */
const modelNamed = (
  harnessError: HarnessErrorOf,
  options: Pick<Driver.Options, "model" | "models">,
  name: string | undefined
) => {
  if (name === undefined) return Effect.succeed(options.model)
  const model = Object.hasOwn(options.models, name) ? options.models[name] : undefined
  if (model !== undefined) return Effect.succeed(model)
  const description = `The opencode agent has no model named ${name}`
  return Effect.fail(harnessError(new HarnessError.UnsupportedError({ description })))
}

/** The state `createSession` was given, if any, as the state `state` returned. */
const readState = (harnessError: HarnessErrorOf, json: Schema.Json | undefined) =>
  Schema.decodeEffect(Schema.UndefinedOr(StateJson))(json).pipe(
    Effect.mapError((cause) =>
      harnessError(
        new HarnessError.AgentContractError({
          description: `opencode cannot read the state it was given: ${cause.message}`
        }),
        cause
      )
    )
  )
