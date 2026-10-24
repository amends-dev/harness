/**
 * An agent is what a harness runs: opencode, Codex, Claude Code, or an agent in the host's own
 * process over an Effect AI `LanguageModel`. Each agent's adapter implements `Agent`, and
 * `Harness.make` turns it into the `Harness` service callers use, which adds whole-turn results,
 * objects, the host's tools, and the record of the conversation that lets a session move from one
 * agent to another.
 *
 * An agent session is one conversation with the agent. An agent that runs in a sandbox, as most
 * do, `requiresSandbox`; one that runs in the host's process can also work without one, answering
 * from its model alone. Each turn streams `StreamPart`s until its `finish` part, and interrupting
 * the stream aborts the turn. The harness runs one turn of a session at a time, so an agent never
 * sees a turn start while another runs. A session outlives the process that started it: the agent
 * keeps running after `detach` or `suspendTurn`, and `createSession` picks the session up again
 * from what those returned.
 *
 * Every agent is made with `Options`, the models it runs on, which its adapter extends with what
 * only that agent takes.
 *
 * @since 0.1.0
 */

import { Sandbox, type Template } from "@amends-dev/sandbox"
import type * as LanguageModel from "effect/ai/LanguageModel"
import type * as Prompt from "effect/ai/Prompt"
import type * as Tool from "effect/ai/Tool"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as Stream from "effect/Stream"
import type * as HarnessError from "./HarnessError.ts"
import type * as ModelEndpoint from "./ModelEndpoint.ts"
import type * as StreamPart from "./StreamPart.ts"

/**
 * What every agent is made with: the model a turn runs on when it names none, and the models a turn
 * can name, by name.
 *
 * **Details**
 *
 * A turn that names another fails with `UnsupportedError`. An adapter's own options extend these
 * with what only its agent takes.
 *
 * @category options
 * @since 0.1.0
 */
export interface Options {
  readonly model: ModelEndpoint.ModelEndpoint
  readonly models?: Readonly<Record<string, ModelEndpoint.ModelEndpoint>>
}

/**
 * Names a session, as `Sandbox.isName` checks, so that it can name the session's directory in the
 * sandbox and the agent's own session.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SessionId = Schema.String.check(Sandbox.isName).pipe(Schema.brand("SessionId"))

/**
 * @category schemas
 * @since 0.1.0
 */
export type SessionId = typeof SessionId.Type

/**
 * Where an agent works for a session: a sandbox, and the session's directory in it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Workspace {
  /** The sandbox, prepared with the agent's `template`. The agent never stops or destroys it. */
  readonly sandbox: Sandbox.Sandbox["Service"]

  /** The absolute directory in the sandbox for this session. It exists before `createSession`. */
  readonly directory: string
}

/**
 * What `Agent.createSession` starts a session from: its id, where it works, the conversation so
 * far, and what the agent itself returned when the session last ran on it.
 *
 * @category options
 * @since 0.1.0
 */
export interface CreateSessionOptions {
  readonly id: SessionId

  /** Where the agent works. Absent only for an agent that does not require a sandbox. */
  readonly workspace?: Workspace | undefined

  /**
   * The conversation so far, empty for a new session. An agent that last ran this session, and is
   * given `agentState` or `unfinishedTurn`, has it already. Any other agent loads it before its
   * first turn, so that a session started on one agent can continue on another.
   */
  readonly history: Prompt.Prompt

  /** What this agent's `detach` or `stop` returned when the session last ran on this agent. */
  readonly agentState?: Schema.Json | undefined

  /**
   * What this agent's `suspendTurn` returned when the session's last turn was cut short on this
   * agent. The session starts ready for `continueTurn` instead of a new turn, if the agent still
   * has the turn.
   */
  readonly unfinishedTurn?: Schema.Json | undefined
}

/**
 * A turn's settings, as the session gives them to the agent: what the turn asks, its instructions,
 * its model, the host's tools, and how it answers.
 *
 * @category options
 * @since 0.1.0
 */
export interface TurnOptions {
  /** What the turn asks. Earlier turns are in the agent's own conversation and not sent again. */
  readonly prompt: Prompt.UserMessage

  /** Instructions for this turn, as system or developer instructions where the agent has them. */
  readonly instructions?: string | undefined

  /** The model for this turn, as the agent names models. The agent's default when omitted. */
  readonly model?: string | undefined

  /**
   * Tools the host runs. When the agent calls one, the turn streams a `tool-call` part that is not
   * `providerExecuted` and waits for `submitToolResult`. The host may ask for approval before it
   * runs a tool; the agent waits for the result either way, and gets `execution-denied` for a
   * refusal.
   */
  readonly tools: ReadonlyArray<Tool.Any>

  /** How the turn answers. JSON fails with `UnsupportedError` when the agent cannot answer so. */
  readonly responseFormat: LanguageModel.ProviderOptions["responseFormat"]
}

/**
 * One conversation with the agent, as its adapter runs it.
 *
 * **Details**
 *
 * The harness calls one operation at a time: it runs a turn to its `finish` before it starts
 * another, and releases the session with `suspendTurn`, `detach`, `stop`, or `destroy` once, after
 * which it calls nothing else.
 *
 * @category models
 * @since 0.1.0
 */
export interface AgentSession {
  /**
   * Whether the session started with the turn `suspendTurn` cut short, for `continueTurn` to
   * finish. An agent given an `unfinishedTurn` it no longer has, such as opencode in a sandbox
   * other than the one the turn ran in, has none, and the harness runs the turn again from its
   * prompt.
   */
  readonly hasUnfinishedTurn: boolean

  /** Runs a turn, streaming its parts until `finish`. Interrupting the stream aborts the turn. */
  readonly promptTurn: (options: TurnOptions) => Stream.Stream<StreamPart.StreamPart, HarnessError.HarnessError>

  /**
   * Streams the turn `suspendTurn` cut short from the step after its first `finishedSteps`, which
   * the harness already has, given the settings the turn started with again. The step that was in
   * flight starts over: an agent whose turn kept running streams its parts again as they were, and
   * one whose turn could not outlive its process runs the step again.
   */
  readonly continueTurn: (
    options: TurnOptions,
    finishedSteps: number
  ) => Stream.Stream<StreamPart.StreamPart, HarnessError.HarnessError>

  /** Gives the running turn the result of a host tool it called. */
  readonly submitToolResult: (
    result: Pick<Prompt.ToolResultPart, "id" | "name" | "result" | "isFailure">
  ) => Effect.Effect<void, HarnessError.HarnessError>

  /**
   * Answers a `tool-approval-request` of the running turn. Fails with `UnsupportedError` for an
   * agent that never asks.
   */
  readonly approve: (
    response: Pick<Prompt.ToolApprovalResponsePart, "approvalId" | "approved" | "reason">
  ) => Effect.Effect<void, HarnessError.HarnessError>

  /**
   * Replaces the conversation so far with a summary, guided by `instructions`, and returns the
   * compaction. The session asks only between turns. Fails with `UnsupportedError` when the agent
   * compacts only by itself.
   */
  readonly compact: (instructions?: string) => Effect.Effect<StreamPart.CompactionPart, HarnessError.HarnessError>

  /**
   * Ends the running turn's stream, while the agent keeps working where it can, and returns what
   * `createSession` takes as `unfinishedTurn` to continue the turn after any step whose
   * `finish-step` it delivered.
   */
  readonly suspendTurn: Effect.Effect<Schema.Json, HarnessError.HarnessError>

  /**
   * Releases the session between turns while the agent keeps running, returning what
   * `createSession` takes as `agentState`.
   */
  readonly detach: Effect.Effect<Schema.Json, HarnessError.HarnessError>

  /**
   * Stops the agent, returning what `createSession` takes as `agentState` to start it again with
   * its conversation.
   */
  readonly stop: Effect.Effect<Schema.Json, HarnessError.HarnessError>

  /**
   * Stops the agent for good, deleting what it keeps of the session. It also destroys a session
   * `suspendTurn`, `detach`, or `stop` released, and destroying it again succeeds.
   */
  readonly destroy: Effect.Effect<void, HarnessError.HarnessError>
}

/**
 * What an adapter implements for its agent: how the agent is named and installed, and how its
 * sessions start. `Harness.make` runs it.
 *
 * **Example** (An agent that answers from its model alone)
 *
 * ```ts
 * import { Agent, Harness, HarnessError } from "@amends-dev/harness"
 * import { Effect, Stream } from "effect"
 *
 * const echo: Agent.Agent = {
 *   id: "echo",
 *   requiresSandbox: false,
 *   createSession: (options) =>
 *     Effect.succeed<Agent.AgentSession>({
 *       hasUnfinishedTurn: false,
 *       promptTurn: ({ prompt }) =>
 *         Stream.make(
 *           { type: "text-start", id: "answer" },
 *           { type: "text-delta", id: "answer", delta: JSON.stringify(prompt.content) },
 *           { type: "text-end", id: "answer" },
 *           { type: "finish-step", reason: "stop", usage: { inputTokens: {}, outputTokens: {} } },
 *           { type: "finish", reason: "stop", usage: { inputTokens: {}, outputTokens: {} } }
 *         ),
 *       continueTurn: () => Stream.empty,
 *       submitToolResult: () => Effect.void,
 *       approve: () => unsupported("echo never asks for approval"),
 *       compact: () => unsupported("echo keeps no conversation to compact"),
 *       suspendTurn: Effect.succeed(null),
 *       detach: Effect.succeed(null),
 *       stop: Effect.succeed(null),
 *       destroy: Effect.void
 *     })
 * }
 *
 * const unsupported = (description: string) =>
 *   Effect.fail(
 *     new HarnessError.HarnessError({
 *       agent: "echo",
 *       reason: new HarnessError.UnsupportedError({ description })
 *     })
 *   )
 *
 * const harness = Harness.make(echo)
 * ```
 *
 * @category models
 * @since 0.1.0
 */
export interface Agent {
  /** Names the agent, such as `opencode`. Errors and saved sessions carry it. */
  readonly id: string

  /** Whether every session needs a sandbox. An agent that runs in the host's process may not. */
  readonly requiresSandbox: boolean

  /** Installs the agent in a sandbox. An agent that runs in the host's process has none. */
  readonly template?: Template.Template

  /**
   * The longest name of a host tool the agent takes, for an agent that adds to the names it is
   * given and so leaves a model API's 64 characters too few. A host names its tools to fit.
   */
  readonly maxToolNameLength?: number | undefined

  /** Creates a session: a new one, or one picked up again from what an earlier session returned. */
  readonly createSession: (options: CreateSessionOptions) => Effect.Effect<AgentSession, HarnessError.HarnessError>
}
