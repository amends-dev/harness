/**
 * A bridge is the program through which hosts reach an agent that works in a sandbox, such as
 * opencode, Codex, or Claude Code. It is all the sandbox exposes of the agent: it listens on a port
 * of its own, behind a token that only hosts know, and runs the agent where nothing outside the
 * sandbox reaches it.
 *
 * A bridge is named by its `BridgeId`, which hosts derive from everything they launch it with, and
 * serves every session that hosts start with those settings. A host finds the bridge by its id, in
 * the `listening.json` the bridge writes in its state directory, and launches it when none answers
 * there; a host with other settings runs a bridge of its own beside it. A bridge exits once it has
 * been idle for a while, or once another bridge of its id has taken its place.
 *
 * The bridge runs each turn itself, so that a turn goes on when a host's connection drops or the
 * host releases the session, until it finishes or a host aborts it. It numbers each turn's parts
 * and keeps them, so that a host reads them from any number: again after its connection drops, or
 * to continue a turn that another host suspended. The agent behind it needs to do neither. A turn
 * the bridge did not finish, as one it ran when it died, it continues when a host starts it again,
 * by prompting the agent with `Continue.` in the conversation that holds the turn.
 *
 * An agent's adapter implements `Driver`, which drives the agent behind a bridge, and
 * `BridgeServer.serve` serves the driver in the sandbox. The adapter's `Agent.Agent`, which hosts
 * run, reaches it with `BridgeClient.createSession`. `Rpcs` is the protocol between them, over a
 * WebSocket whose host presents the token as `Authorization: Bearer <token>` when it connects.
 *
 * @since 0.1.0
 */

import { Network, Sandbox } from "@amends-dev/sandbox"
import * as Prompt from "effect/ai/Prompt"
import type * as Effect from "effect/Effect"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type * as Stream from "effect/Stream"
import * as Agent from "./Agent.ts"
import * as HarnessError from "./HarnessError.ts"
import * as StreamPart from "./StreamPart.ts"

/**
 * A tool the host runs, as the agent reads it: its name, what it does, and its parameters.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ToolDefinition = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),

  /** The tool's parameters, as a JSON Schema. */
  parameters: Schema.Json
})

/**
 * @category schemas
 * @since 0.1.0
 */
export interface ToolDefinition extends Schema.Schema.Type<typeof ToolDefinition> {}

/**
 * How a turn answers: in text, or in JSON that matches `schema`, a JSON Schema.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ResponseFormat = Schema.Union([
  Schema.Struct({ type: Schema.tag("text") }),
  Schema.Struct({ type: Schema.tag("json"), objectName: Schema.String, schema: Schema.Json })
])

/**
 * @category schemas
 * @since 0.1.0
 */
export type ResponseFormat = typeof ResponseFormat.Type

/**
 * A turn's settings, as `Agent.TurnOptions` gives them, with the host's tools and the answer's
 * schema as JSON Schemas, since only data crosses into the sandbox.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TurnOptions = Schema.Struct({
  prompt: Prompt.UserMessage,
  instructions: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  tools: Schema.Array(ToolDefinition),
  responseFormat: ResponseFormat
})

/**
 * @category schemas
 * @since 0.1.0
 */
export interface TurnOptions extends Schema.Schema.Type<typeof TurnOptions> {}

/**
 * What a driver starts a session from: its id, its directory in the sandbox, the conversation so
 * far, and the state the driver's session last returned.
 *
 * @category options
 * @since 0.1.0
 */
export interface CreateSessionOptions {
  readonly id: Agent.SessionId

  /** The absolute directory the session works in. It exists before `createSession`. */
  readonly directory: string

  /**
   * The conversation so far, empty for a new session. An agent given `agentState` has it already;
   * any other loads it before its first turn.
   */
  readonly history: Prompt.Prompt

  /** What the session's `state` returned when it last ran on this agent. */
  readonly agentState?: Schema.Json | undefined
}

/**
 * A session a driver started. The bridge runs one turn of it at a time, keeps its turns' parts,
 * and ends it by closing its scope.
 *
 * @category models
 * @since 0.1.0
 */
export interface DriverSession {
  /**
   * Whether the session started in the conversation the agent kept for it, which `agentState`
   * names, rather than from `history`, as it does when it lost that conversation or had none. The
   * bridge continues a turn it did not finish only in a conversation the agent kept.
   */
  readonly keptConversation: boolean

  /** Runs a turn, streaming its parts until `finish`. Interrupting the stream aborts the turn. */
  readonly promptTurn: (options: TurnOptions) => Stream.Stream<StreamPart.StreamPart, HarnessError.HarnessError>

  readonly submitToolResult: Agent.AgentSession["submitToolResult"]

  readonly approve: Agent.AgentSession["approve"]

  readonly compact: Agent.AgentSession["compact"]

  /**
   * What `createSession` takes as `agentState` to start the session again, as a restarted bridge
   * does.
   */
  readonly state: Effect.Effect<Schema.Json, HarnessError.HarnessError>

  /** Deletes what the agent keeps of the session. Its scope closes afterwards. */
  readonly destroy: Effect.Effect<void, HarnessError.HarnessError>
}

/**
 * What an adapter implements to run its agent behind a bridge: it drives the agent in the sandbox,
 * starting its sessions and running their turns, while the bridge keeps the turns, so that a driver
 * needs neither to suspend nor to continue one.
 *
 * **Details**
 *
 * `BridgeServer.serve` serves it.
 *
 * **Example** (A driver over an agent's own session API)
 *
 * ```ts
 * import { Bridge, StreamPart } from "@amends-dev/harness"
 * import { Effect, Stream } from "effect"
 *
 * // What the adapter has of its agent in the sandbox: a client of the agent's own API.
 * declare const agent: {
 *   readonly createSession: (directory: string) => Effect.Effect<string>
 *   readonly prompt: (sessionId: string, text: string) => Stream.Stream<StreamPart.StreamPart>
 *   readonly deleteSession: (sessionId: string) => Effect.Effect<void>
 * }
 *
 * const driver: Bridge.Driver = {
 *   id: "my-agent",
 *   createSession: (options) =>
 *     Effect.gen(function* () {
 *       // A session the bridge starts again finds the agent's own session in `agentState`.
 *       const kept = typeof options.agentState === "string" ? options.agentState : undefined
 *       const sessionId = kept ?? (yield* agent.createSession(options.directory))
 *       const session: Bridge.DriverSession = {
 *         keptConversation: kept !== undefined,
 *         promptTurn: ({ prompt }) => agent.prompt(sessionId, JSON.stringify(prompt.content)),
 *         submitToolResult: () => Effect.void,
 *         approve: () => Effect.void,
 *         compact: () => Effect.die("my-agent compacts only by itself"),
 *         state: Effect.succeed(sessionId),
 *         destroy: agent.deleteSession(sessionId)
 *       }
 *       return session
 *     })
 * }
 * ```
 *
 * @category models
 * @since 0.1.0
 */
export interface Driver {
  /** Names the agent it drives, such as `opencode`, as the agent's `Agent.Agent` for hosts does. */
  readonly id: string

  /**
   * Creates a session: a new one, or one created again from its `state`. The session runs until its
   * scope closes, when a host stops or destroys it, or the bridge exits.
   */
  readonly createSession: (
    options: CreateSessionOptions
  ) => Effect.Effect<DriverSession, HarnessError.HarnessError, Scope.Scope>
}

/**
 * Names a turn, as `Sandbox.isName` checks. The host picks it, so that a request to start the turn
 * that it sends again, not knowing whether the first arrived, starts it once.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TurnId = Schema.String.check(Sandbox.isName).pipe(Schema.brand("TurnId"))

/**
 * @category schemas
 * @since 0.1.0
 */
export type TurnId = typeof TurnId.Type

/**
 * A part of a turn, numbered from 1 in the order the turn streamed it.
 *
 * @category schemas
 * @since 0.1.0
 */
export const NumberedPart = Schema.Struct({ seq: Schema.Int, part: StreamPart.StreamPart })

/**
 * @category schemas
 * @since 0.1.0
 */
export interface NumberedPart extends Schema.Schema.Type<typeof NumberedPart> {}

/**
 * The version of `Rpcs` that this package speaks.
 *
 * **Details**
 *
 * Every bridge's id includes it, so a host only ever reaches a bridge of its own version. Bump it
 * when hosts or bridges of the version before could not read a change to the protocol.
 *
 * @category constants
 * @since 0.1.0
 */
export const protocolVersion = 2

/**
 * Names a bridge after everything a host launches it with, as `Sandbox.isName` checks, so that a
 * host that would launch the same bridge finds the one running, and a host with other settings
 * launches its own.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BridgeId = Schema.String.check(Sandbox.isName).pipe(Schema.brand("BridgeId"))

/**
 * @category schemas
 * @since 0.1.0
 */
export type BridgeId = typeof BridgeId.Type

/**
 * What a bridge writes to `listeningFile` in its state directory once it listens, for hosts to find
 * it: the port. It holds no token, as the agent can read every file in the sandbox.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Listening = Schema.Struct({ port: Network.Port })

/**
 * @category schemas
 * @since 0.1.0
 */
export interface Listening extends Schema.Schema.Type<typeof Listening> {}

/**
 * The name of the file in a bridge's state directory that `Listening` describes.
 *
 * @category constants
 * @since 0.1.0
 */
export const listeningFile = "listening.json"

/**
 * Answers which agent the bridge runs, and which bridge it is, for a host to check that it reached
 * the bridge it looked up: a port another bridge listened on may be another's since.
 *
 * @category protocols
 * @since 0.1.0
 */
export const Hello = Rpc.make("Hello", {
  success: Schema.Struct({ agent: Schema.String, bridge: BridgeId })
})

/** The session a request is about. Every request but `StartSession` needs it started. */
const inSession = { session: Agent.SessionId }

/**
 * The protocol between a host and a bridge: the requests a host sends over its WebSocket, which
 * `BridgeServer` handles and `BridgeClient` sends.
 *
 * @category protocols
 * @since 0.1.0
 */
export class Rpcs extends RpcGroup.make(
  Hello,

  /**
   * Starts the session, or takes up the one the bridge is running, which ignores `history` and
   * `agentState`. Answers whether the session can continue `unfinishedTurn`, as `StartTurn` does,
   * and the session's state, as `ReadState` does.
   */
  Rpc.make("StartSession", {
    payload: {
      ...inSession,
      directory: Schema.String,
      history: Prompt.Prompt,
      agentState: Schema.optionalKey(Schema.Json),
      unfinishedTurn: Schema.optional(TurnId)
    },
    success: Schema.Struct({ hasUnfinishedTurn: Schema.Boolean, agentState: Schema.Json }),
    error: HarnessError.HarnessError
  }),

  /**
   * Starts a turn, which runs until it finishes or `AbortTurn`, whoever reads it. Starting a turn
   * the session already started does nothing; starting one while another runs fails with
   * `TurnInProgressError`. Starting again a turn the bridge aborted, as it aborts the turns it runs
   * when it exits, or one it ran when it died, continues the turn after the steps it finished, by
   * prompting the agent to continue, when the agent kept the conversation that holds the turn.
   */
  Rpc.make("StartTurn", {
    payload: { ...inSession, turn: TurnId, options: TurnOptions },
    error: HarnessError.HarnessError
  }),

  /**
   * Streams the turn's parts numbered after `after`, then each new one, until the turn's last.
   * Fails with what the turn failed with, after its parts, and with `NoTurnError` for a turn the
   * bridge does not have.
   */
  Rpc.make("ReadTurn", {
    payload: { ...inSession, turn: TurnId, after: Schema.Int },
    success: NumberedPart,
    error: HarnessError.HarnessError,
    stream: true
  }),

  /** Aborts the turn. Aborting a turn that ended does nothing. */
  Rpc.make("AbortTurn", {
    payload: { ...inSession, turn: TurnId },
    error: HarnessError.HarnessError
  }),

  /** Gives the running turn the result of a host tool it called. */
  Rpc.make("SubmitToolResult", {
    payload: {
      ...inSession,
      result: Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        result: Schema.Json,
        isFailure: Schema.Boolean
      })
    },
    error: HarnessError.HarnessError
  }),

  /** Answers a `tool-approval-request` of the running turn. */
  Rpc.make("Approve", {
    payload: {
      ...inSession,
      response: Schema.Struct({
        approvalId: Schema.String,
        approved: Schema.Boolean,
        reason: Schema.optional(Schema.String)
      })
    },
    error: HarnessError.HarnessError
  }),

  /** Asks the agent to summarize the conversation so far, between turns, answering with it. */
  Rpc.make("Compact", {
    payload: { ...inSession, instructions: Schema.optional(Schema.String) },
    success: StreamPart.CompactionPart,
    error: HarnessError.HarnessError
  }),

  /** What `StartSession` takes as `agentState` to start the session again. */
  Rpc.make("ReadState", {
    payload: inSession,
    success: Schema.Json,
    error: HarnessError.HarnessError
  }),

  /** Aborts the running turn and ends the session, answering what `ReadState` would. */
  Rpc.make("StopSession", {
    payload: inSession,
    success: Schema.Json,
    error: HarnessError.HarnessError
  }),

  /** Aborts the running turn, deletes the session and its turns, and ends it. */
  Rpc.make("DestroySession", {
    payload: inSession,
    error: HarnessError.HarnessError
  })
) {}

/**
 * What a host gives the bridge it launches, on the bridge's standard input, so that neither the
 * agent nor anything else in the sandbox can read the token or the agent's credentials.
 *
 * @category schemas
 * @since 0.1.0
 */
export const LaunchOptions = Schema.Struct({
  /** The token hosts present when they connect. */
  token: Schema.String,

  /** The bridge's id, which `Hello` answers. */
  bridge: BridgeId,

  /**
   * The absolute directory, outside every session's directory, that the bridge keeps its turns in,
   * and writes `listeningFile` to.
   */
  stateDirectory: Schema.String,

  /** The adapter's own options, such as the agent's configuration and its model providers' keys. */
  agentOptions: Schema.Json
})

/**
 * @category schemas
 * @since 0.1.0
 */
export interface LaunchOptions extends Schema.Schema.Type<typeof LaunchOptions> {}
