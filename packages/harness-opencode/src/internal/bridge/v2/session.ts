/**
 * A session of opencode 2's session API, as the driver runs it: an opencode session in the
 * session's directory. A turn is a prompt to it, with the prompt's files, on the turn's model, the
 * turn's instructions given beside opencode's own; `Turn` translates the events opencode publishes
 * for the turn as they happen. A session that starts with a conversation from another agent is
 * created holding it, as opencode's own record, as `Prompt` writes it.
 *
 * The host's tools reach opencode through the bridge's `HostToolRelay`, as `HostTools` lists them:
 * opencode 2's model calls them from code it runs. A tool of opencode's own that asks permission
 * waits for `approve`, and `compact` asks opencode to summarize the conversation, which it does
 * without instructions. opencode 2 does not answer in JSON, which fails with `UnsupportedError`.
 */

import { type Bridge, HarnessError, type HostToolRelay } from "@amends-dev/harness"
import type * as AiPrompt from "effect/ai/Prompt"
import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Driver from "../driver.ts"
import * as HostTools from "../hostTools.ts"
import * as Server from "../server.ts"
import * as Api from "./api.ts"
import type { SessionEvent } from "./event.ts"
import * as Prompt from "./prompt.ts"
import * as Turn from "./turn.ts"

/** What `state` returns, for `createSession` to take back. */
const State = Schema.Struct({
  sessionID: Schema.String,

  /** The model the session runs its turns on. */
  model: Driver.ModelRef
})

const StateJson = Schema.toCodecJson(State)

/** The key a turn's instructions have among the session's. */
const instructionsKey = "amends"

/**
 * How long opencode 2 may take to give its turns an MCP server's tools once they change. It
 * registers them 100 milliseconds after they last changed and announces nothing when it has, so a
 * turn that starts sooner runs without them.
 */
const toolRegistrationTime = "500 millis"

/**
 * The function that creates sessions as `Driver.CreateSession` does, each with a session of
 * `relay` for the host's tools: a new opencode session, or the one its `agentState` names, when
 * opencode still has it.
 */
export const makeCreateSession =
  (relay: HostToolRelay.HostToolRelay["Service"]): Driver.CreateSession =>
  (server, options, sessionOptions) =>
    Effect.gen(function* () {
      const api = Api.make(server)
      const { directory } = sessionOptions
      const harnessError = (reason: HarnessError.HarnessErrorReason, cause?: unknown) =>
        Server.harnessError(server.agent, reason, cause)
      // opencode may have lost the session, as when the sandbox lost its data, and then starts one
      // from the conversation.
      const saved = yield* readState(harnessError, sessionOptions.agentState)
      const kept = saved !== undefined && (yield* api.hasSession(saved.sessionID)) ? saved : undefined
      const state =
        kept ?? (yield* createOpencodeSession(api, harnessError, directory, options.model, sessionOptions.history))
      const { sessionID } = state
      const relaySession = yield* relay.open(sessionOptions.id)
      // opencode 2 connects to an MCP server after it answers, lists its tools once it has, and
      // registers them for its turns later still.
      const registered = Effect.andThen(
        api.awaitMcpServer(directory, HostTools.serverName),
        Effect.sleep(toolRegistrationTime)
      )
      const listHostTools = yield* HostTools.makeLister(relay.url, relaySession, {
        add: (mcpServer) => Effect.andThen(api.addMcpServer(directory, HostTools.serverName, mcpServer), registered),
        reconnect: Effect.andThen(api.reconnectMcpServer(directory, HostTools.serverName), registered),
        disconnect: Effect.andThen(
          api.disconnectMcpServer(directory, HostTools.serverName),
          Effect.sleep(toolRegistrationTime)
        )
      })
      // opencode reports the files a tool changed by their real paths.
      const fs = yield* FileSystem.FileSystem
      const realDirectory = yield* fs.realPath(directory).pipe(Effect.orElseSucceed(() => directory))

      /** The model the session runs its turns on, switched when a turn names another. */
      const sessionModel = yield* Ref.make(state.model)

      /**
       * The instructions the session's model reads beside opencode's own, or nothing while the
       * session does not know them, as for a session it kept.
       */
      const sessionInstructions = yield* Ref.make<{ readonly text?: string } | undefined>(
        kept === undefined ? {} : undefined
      )

      /** Gives the session the turn's model and instructions, before its prompt. */
      const prepareTurn = Effect.fnUntraced(function* (turnOptions: Bridge.TurnOptions) {
        if (turnOptions.responseFormat.type === "json") {
          return yield* harnessError(
            new HarnessError.UnsupportedError({
              description: "opencode 2's session API does not answer in JSON"
            })
          )
        }
        const model = yield* modelNamed(harnessError, options, turnOptions.model)
        if (!isSameModel(model, yield* Ref.get(sessionModel))) {
          yield* api.switchModel(sessionID, model)
          yield* Ref.set(sessionModel, model)
        }
        const { instructions } = turnOptions
        const known = yield* Ref.get(sessionInstructions)
        if (known === undefined || known.text !== instructions) {
          yield* instructions === undefined
            ? api.removeInstructions(sessionID, instructionsKey)
            : api.putInstructions(sessionID, instructionsKey, instructions)
          yield* Ref.set(sessionInstructions, instructions === undefined ? {} : { text: instructions })
        }
        yield* listHostTools(turnOptions.tools)
      })

      /**
       * Runs a turn, streaming its parts until its `finish`, with the calls the relay streams of the
       * host's tools. A stream that ends before the turn finishes, as when the bridge aborts the
       * turn, stops the session in opencode.
       */
      const promptTurn = (turnOptions: Bridge.TurnOptions) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const prompt = yield* Effect.fromResult(Prompt.promptOf(turnOptions.prompt)).pipe(
              Effect.mapError((reason) => harnessError(reason))
            )
            const finished = yield* Ref.make(false)
            // Interrupting a session that runs nothing does nothing, so this holds from before
            // opencode takes the prompt.
            yield* Effect.addFinalizer(() =>
              Effect.flatMap(Ref.get(finished), (done) =>
                done ? Effect.void : Effect.ignore(api.interrupt(sessionID))
              )
            )
            const hostCalls =
              turnOptions.tools.length === 0 ? Stream.empty : yield* relaySession.offerTools(turnOptions.tools)
            yield* prepareTurn(turnOptions)
            // The turn's events are published only to subscriptions made before them.
            const events = yield* api.subscribe(sessionID)
            const inboxID = yield* api.prompt(sessionID, prompt)
            const translated = yield* Ref.make(Turn.initial({ inboxID, directory: realDirectory }))
            const translate = (event: SessionEvent) =>
              Effect.flatMap(Ref.get(translated), (turn) => Effect.fromResult(Turn.translate(turn, event))).pipe(
                Effect.flatMap(([turn, parts]) => Effect.as(Ref.set(translated, turn), parts)),
                Effect.mapError((reason) => harnessError(reason))
              )
            const ended = harnessError(
              new HarnessError.UnavailableError({
                description: "opencode's events ended before the turn did"
              })
            )
            const turnParts = events.pipe(
              Stream.tap((event) =>
                event.type === "form.created"
                  ? Effect.ignore(api.cancelForm(sessionID, event.data.form.id, "No one answers forms here"))
                  : Effect.void
              ),
              Stream.concat(Stream.fail(ended)),
              Stream.mapEffect(translate),
              Stream.flattenIterable,
              Stream.takeUntil((part) => part.type === "finish"),
              Stream.tap((part) => (part.type === "finish" ? Ref.set(finished, true) : Effect.void))
            )
            return Stream.merge(turnParts, hostCalls, { haltStrategy: "left" })
          })
        )

      /** Asks opencode to summarize the conversation, and waits for the summary it writes. */
      const compact = Effect.fnUntraced(
        function* (instructions?: string) {
          if (instructions !== undefined && instructions.trim() !== "") {
            return yield* harnessError(
              new HarnessError.UnsupportedError({
                description: "opencode 2 summarizes a conversation without instructions"
              })
            )
          }
          const events = yield* api.subscribe(sessionID)
          yield* api.compact(sessionID)
          const outcome = yield* events.pipe(
            Stream.filter(
              (event) =>
                (event.type === "session.compaction.ended" || event.type === "session.compaction.failed") &&
                event.data.reason === "manual"
            ),
            Stream.runHead,
            Effect.timeoutOrElse({
              duration: "10 minutes",
              orElse: () =>
                Effect.fail(
                  harnessError(
                    new HarnessError.UnavailableError({
                      description: "opencode did not summarize the conversation within 10 minutes"
                    })
                  )
                )
            })
          )
          if (Option.isNone(outcome) || outcome.value.type !== "session.compaction.ended") {
            return yield* harnessError(
              new HarnessError.UnknownError({
                description: `opencode failed to summarize the conversation${
                  Option.isSome(outcome) && outcome.value.type === "session.compaction.failed"
                    ? `: ${outcome.value.data.error.message}`
                    : ""
                }`
              })
            )
          }
          return {
            type: "compaction",
            trigger: "manual",
            summary: outcome.value.data.text
          } as const
        },
        (effect) => Effect.scoped(effect)
      )

      const session: Bridge.DriverSession = {
        keptConversation: kept !== undefined,
        promptTurn,
        submitToolResult: relaySession.submitToolResult,
        approve: ({ approvalId, approved, reason }) =>
          api.replyPermission(sessionID, approvalId, approved ? "once" : "reject", approved ? undefined : reason),
        compact,
        state: Effect.flatMap(Ref.get(sessionModel), (model) =>
          Effect.orDie(Schema.encodeEffect(StateJson)({ sessionID, model }))
        ),
        destroy: api.deleteSession(sessionID)
      }
      return session
    })

/** The error the agent reports for `reason`, as `Server.harnessError` makes it for the agent. */
type HarnessErrorOf = (reason: HarnessError.HarnessErrorReason, cause?: unknown) => HarnessError.HarnessError

/** A new opencode session in `directory` on `model`, holding `history`. */
const createOpencodeSession = Effect.fnUntraced(function* (
  api: Api.Api,
  harnessError: HarnessErrorOf,
  directory: string,
  model: Driver.ModelRef,
  history: AiPrompt.Prompt
) {
  if (history.content.length === 0) {
    const created: typeof State.Type = {
      sessionID: yield* api.createSession(directory, model),
      model
    }
    return created
  }
  // opencode imports a session under the id it is given.
  const crypto = yield* Crypto.Crypto
  const sessionID = `ses_${(yield* Effect.orDie(crypto.randomUUIDv4())).replaceAll("-", "")}`
  const now = yield* Clock.currentTimeMillis
  const messages = yield* Effect.fromResult(Prompt.messagesOf(history, { sessionID, now })).pipe(
    Effect.mapError((reason) => harnessError(reason))
  )
  yield* api.importSession({ sessionID, directory, model, now, messages })
  const imported: typeof State.Type = { sessionID, model }
  return imported
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
  const description = `The opencode 2 agent has no model named ${name}`
  return Effect.fail(harnessError(new HarnessError.UnsupportedError({ description })))
}

const isSameModel = (one: Driver.ModelRef, other: Driver.ModelRef) =>
  one.providerID === other.providerID && one.id === other.id && one.variant === other.variant

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
