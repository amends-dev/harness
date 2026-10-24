/**
 * A harness runs one agent: it starts sessions with the agent and resumes sessions that any agent
 * ran before, so callers do not depend on which agent works for them. `make` builds one from an
 * agent's adapter, as `LanguageModel.make` builds a language model from a provider's.
 *
 * The caller creates the sandbox a session works in, from the `template` of the harness's `agent`,
 * and owns it: a harness never stops or destroys a sandbox. Each session works in its own directory
 * there, named by its id, so that its files stay in place when the session moves from one agent to
 * another. A session needs no sandbox when its agent does not require one, such as for a plain
 * conversation.
 *
 * @since 0.1.0
 */

import { Sandbox } from "@amends-dev/sandbox"
import * as Prompt from "effect/ai/Prompt"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import type * as Agent from "./Agent.ts"
import * as HarnessError from "./HarnessError.ts"
import { makeSession } from "./internal/session.ts"
import type * as Session from "./Session.ts"

/**
 * What a session starts from: the `id` of a new session, with the conversation it starts with if
 * any, or what an earlier one returned.
 *
 * @category options
 * @since 0.1.0
 */
export type CreateSessionOptions = {
  /**
   * The sandbox the agent works in, created from the agent's `template`. Required when the agent
   * `requiresSandbox`. A sandbox other than the one a resumed session last ran in has the
   * conversation but not the files the session made.
   */
  readonly sandbox?: Sandbox.Sandbox["Service"]
} & (
  | {
      /** Names a new session. */
      readonly id: Agent.SessionId
      /**
       * The conversation the session starts with, as when the agent joins one already under way.
       * Empty when omitted.
       */
      readonly history?: Prompt.Prompt
      readonly resumeFrom?: never
    }
  | {
      /** What `suspendTurn`, `detach`, or `stop` returned, on this harness's agent or any other. */
      readonly resumeFrom: Session.SessionState
      readonly id?: never
      readonly history?: never
    }
)

/**
 * The service callers run an agent through. `make` builds one from an agent's adapter, and `layer`
 * provides it to a program that runs one agent.
 *
 * @category services
 * @since 0.1.0
 */
export class Harness extends Context.Service<
  Harness,
  {
    /**
     * The agent the harness runs, as its adapter describes it: its id, the sandbox it works in, and
     * the names of tools it takes. Only the harness starts its sessions. Starting one fails with
     * `UnsupportedError` without a sandbox when the agent `requiresSandbox`.
     */
    readonly agent: Omit<Agent.Agent, "createSession">

    /**
     * Creates a session: a new one, which loads the `history` it is given, or one that goes on
     * where `resumeFrom` left it. The agent that last ran the session resumes from its own state.
     * Any other agent loads the conversation instead, and runs an unfinished turn again.
     */
    readonly createSession: (options: CreateSessionOptions) => Effect.Effect<Session.Session, HarnessError.HarnessError>
  }
>()("@amends-dev/harness/Harness") {}

/**
 * The harness over `agent`, as its adapter implements it.
 *
 * **Example** (Running a turn, saving the session, and resuming it)
 *
 * ```ts
 * import { Agent, Harness, Session } from "@amends-dev/harness"
 * import { SandboxProvider } from "@amends-dev/sandbox"
 * import { Console, Effect, Schema, Stream } from "effect"
 *
 * declare const agent: Agent.Agent // from an adapter, such as @amends-dev/harness-opencode
 *
 * const SessionStateJson = Schema.fromJsonString(Schema.toCodecJson(Session.SessionState))
 *
 * const program = Effect.gen(function* () {
 *   const harness = Harness.make(agent)
 *   const sandboxes = yield* SandboxProvider.SandboxProvider
 *   const sandbox = yield* sandboxes.create({ template: harness.agent.template })
 *
 *   const session = yield* harness.createSession({ sandbox, id: Agent.SessionId.make("review") })
 *   yield* session
 *     .stream({ prompt: "Summarize README.md" })
 *     .pipe(Stream.runForEach((part) => (part.type === "text-delta" ? Console.log(part.delta) : Effect.void)))
 *
 *   // Store the session as JSON, and resume it later, on any host and any agent.
 *   const saved = yield* Schema.encodeEffect(SessionStateJson)(yield* session.detach)
 *   const resumed = yield* harness.createSession({
 *     sandbox,
 *     resumeFrom: yield* Schema.decodeEffect(SessionStateJson)(saved)
 *   })
 *   const answer = yield* resumed.generate({ prompt: "Now list its headings" })
 *   return answer.text
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (agent: Agent.Agent): Harness["Service"] => {
  /** Fails with `UnsupportedError` when the agent requires a sandbox and has none. */
  const checkSandbox = (sandbox: Sandbox.Sandbox["Service"] | undefined) =>
    sandbox === undefined && agent.requiresSandbox
      ? Effect.fail(
          new HarnessError.HarnessError({
            agent: agent.id,
            reason: new HarnessError.UnsupportedError({
              description: `${agent.id} works in a sandbox`
            })
          })
        )
      : Effect.void

  /** The session's workspace in `sandbox`, creating its directory if it does not exist yet. */
  const makeWorkspace = Effect.fnUntraced(
    function* (sandbox: Sandbox.Sandbox["Service"], id: Agent.SessionId) {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = path.join(sandbox.workingDirectory, id)
      yield* fs.makeDirectory(directory, { recursive: true })
      return { sandbox, directory } satisfies Agent.Workspace
    },
    (effect, sandbox) => Effect.provide(effect, Sandbox.layerServices(sandbox)),
    Effect.mapError(
      (cause) =>
        new HarnessError.HarnessError({
          agent: agent.id,
          reason: new HarnessError.UnknownError({ description: cause.message }),
          cause
        })
    )
  )

  return Harness.of({
    agent,

    createSession: Effect.fn("Harness.createSession")(function* (options) {
      const { sandbox, resumeFrom } = options
      const id = options.resumeFrom === undefined ? options.id : options.resumeFrom.id
      yield* checkSandbox(sandbox)
      const workspace = sandbox === undefined ? undefined : yield* makeWorkspace(sandbox, id)
      const history = resumeFrom?.history ?? options.history ?? Prompt.empty
      // An agent's own state means something only to the agent that wrote it. Any other agent
      // starts from the conversation, and the session runs an unfinished turn again on it.
      const own = resumeFrom !== undefined && resumeFrom.agent === agent.id
      const agentSession = yield* agent.createSession({
        id,
        workspace,
        history,
        agentState: own ? resumeFrom.agentState : undefined,
        unfinishedTurn: own ? resumeFrom.unfinishedTurn?.agentState : undefined
      })
      return yield* makeSession({
        id,
        agent: agent.id,
        agentSession,
        history,
        unfinishedTurn: resumeFrom?.unfinishedTurn
      })
    })
  })
}

/**
 * A harness over `agent`, for programs that run one agent.
 *
 * **Example** (Providing the harness to a program)
 *
 * ```ts
 * import { Agent, Harness } from "@amends-dev/harness"
 * import { Effect } from "effect"
 *
 * declare const agent: Agent.Agent
 *
 * const program = Effect.gen(function* () {
 *   const harness = yield* Harness.Harness
 *   const session = yield* harness.createSession({ id: Agent.SessionId.make("chat") })
 *   return yield* session.generate({ prompt: "Hello" })
 * })
 *
 * const main = program.pipe(Effect.provide(Harness.layer(agent)))
 * ```
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (agent: Agent.Agent): Layer.Layer<Harness> => Layer.succeed(Harness, make(agent))
