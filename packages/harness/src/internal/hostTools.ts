/**
 * How a session runs the host's tools for the agent. A tool starts on the host as soon as the agent
 * calls it, its results stream as it gives them, and its final result goes to the agent. A tool
 * that needs approval is asked about first: the turn streams a `tool-approval-request` and waits
 * for `approve`, and a refusal is answered as `execution-denied`. `makeSession` makes these for
 * each session; the package does not export this module.
 */

import type * as Prompt from "effect/ai/Prompt"
import type * as Response from "effect/ai/Response"
import type * as Tool from "effect/ai/Tool"
import type * as Toolkit from "effect/ai/Toolkit"
import type * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"
import type * as Agent from "../Agent.ts"
import * as HarnessError from "../HarnessError.ts"
import type * as Session from "../Session.ts"
import type * as StreamPart from "../StreamPart.ts"

/** What `approve` answers a request with. */
export type ApprovalResponse = Parameters<Agent.AgentSession["approve"]>[0]

/** The host's tools of one session, which answer the calls the agent makes of them. */
export interface HostTools {
  /**
   * The agent's parts, with the results of the host's tools it calls, and the requests to approve
   * them, as they come. A host's tool starts as soon as the agent calls it, so the tools of calls
   * the agent makes together run side by side, and a caller sees every request to approve them at
   * once. A step ends, as the turn does, only once the tools it called have answered.
   */
  readonly answerCalls: <Tools extends Record<string, Tool.Any>>(
    agentTurn: Stream.Stream<StreamPart.StreamPart, HarnessError.HarnessError>,
    toolkit: Toolkit.WithHandler<Tools> | undefined
  ) => Stream.Stream<StreamPart.StreamPart, Session.TurnError<Tools>, Session.TurnServices<Tools>>

  /**
   * Answers the request `response` names, if one of the host's tools waits on it, and says whether
   * one did. A request is answered once.
   */
  readonly answerRequest: (response: ApprovalResponse) => Effect.Effect<boolean>
}

export const makeHostTools = Effect.fnUntraced(function* (options: {
  /** Names the agent, as its errors do. */
  readonly agent: string

  /** Gives the agent a tool's final result. */
  readonly submitToolResult: Agent.AgentSession["submitToolResult"]

  /** The conversation as the session has recorded it, which a tool's `needsApproval` reads. */
  readonly conversation: Effect.Effect<ReadonlyArray<Prompt.Message>>
}) {
  const { agent, conversation } = options
  /**
   * The calls that wait for `approve`, each with the answer its request awaits, by the request's
   * id. A request lives only as long as the stream that made it.
   */
  const pendingApprovals = yield* Ref.make(HashMap.empty<string, Deferred.Deferred<ApprovalResponse>>())

  const harnessError = (reason: HarnessError.HarnessErrorReason, cause?: unknown) =>
    new HarnessError.HarnessError({ agent, reason, cause })

  const answerCalls = <Tools extends Record<string, Tool.Any>>(
    agentTurn: Stream.Stream<StreamPart.StreamPart, HarnessError.HarnessError>,
    toolkit: Toolkit.WithHandler<Tools> | undefined
  ): Stream.Stream<StreamPart.StreamPart, Session.TurnError<Tools>, Session.TurnServices<Tools>> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const scope = yield* Effect.scope
        /** The agent's parts and the tools' results, in the order they come. */
        const parts = yield* Queue.unbounded<StreamPart.StreamPart, Session.TurnError<Tools> | Cause.Done>()
        /** How many tools the agent called have not answered yet. */
        const answering = yield* SubscriptionRef.make(0)
        const allAnswered = Stream.runDrain(
          Stream.takeUntil(SubscriptionRef.changes(answering), (count) => count === 0)
        )

        /** Runs the tool `call` names beside the turn, its results into `parts`. */
        const startTool = (call: Response.ToolCallPartEncoded) =>
          runTool(toolkit, call).pipe(
            Stream.runForEach((part) => Queue.offer(parts, part)),
            Effect.tapCause((cause) => Queue.failCause(parts, cause)),
            Effect.ensuring(SubscriptionRef.update(answering, (count) => count - 1)),
            Effect.forkIn(scope)
          )

        // The agent's parts are read as they come, so that a tool starts as soon as the agent
        // calls it. A step ends, and the turn, only once the tools called have answered.
        yield* agentTurn.pipe(
          Stream.runForEach((part) =>
            Effect.gen(function* () {
              if (part.type === "tool-call" && part.providerExecuted !== true) {
                yield* SubscriptionRef.update(answering, (count) => count + 1)
                yield* startTool(part)
              }
              if (part.type === "finish-step" || part.type === "finish") yield* allAnswered
              yield* Queue.offer(parts, part)
            })
          ),
          Effect.andThen(allAnswered),
          Effect.andThen(Queue.end(parts)),
          Effect.tapCause((cause) => Queue.failCause(parts, cause)),
          Effect.forkIn(scope)
        )
        return Stream.fromQueue(parts)
      })
    )

  /**
   * Runs the tool `call` names, streaming its results and giving the final one to the agent. A tool
   * that needs approval first runs only once `approve` allows it, and is answered as denied when
   * `approve` refuses it.
   */
  const runTool = <Tools extends Record<string, Tool.Any>>(
    toolkit: Toolkit.WithHandler<Tools> | undefined,
    call: Response.ToolCallPartEncoded
  ): Stream.Stream<StreamPart.StreamPart, Session.TurnError<Tools>, Session.TurnServices<Tools>> => {
    const found = toolkit === undefined ? undefined : findTool(toolkit, call.name)
    if (toolkit === undefined || found === undefined) {
      const description = `The agent called ${call.name}, which is not one of the host's tools`
      return Stream.fail(harnessError(new HarnessError.AgentContractError({ description })))
    }
    const { name, tool } = found
    // `handle` decodes the params with the tool's schema and fails on a mismatch, so they need no
    // type of their own here.
    const params = call.params as Tool.ParametersEncoded<Tools[typeof name]>
    const callTool: Stream.Stream<
      StreamPart.StreamPart,
      Session.TurnError<Tools>,
      Session.TurnServices<Tools>
    > = Stream.unwrap(toolkit.handle(name, params, call.id)).pipe(
      Stream.mapEffect((handled) => {
        const part = {
          type: "tool-result",
          id: call.id,
          name,
          result: handled.encodedResult,
          isFailure: handled.isFailure,
          providerExecuted: false,
          preliminary: handled.preliminary
        } as const
        return handled.preliminary ? Effect.succeed(part) : submitResult(part)
      })
    )
    return Stream.unwrap(
      Effect.map(needsApproval(tool, call, conversation), (needed) => (needed ? askThenRun(call, callTool) : callTool))
    )
  }

  /**
   * Streams a `tool-approval-request` for `call`, and then `ifApproved`, or the call answered as
   * denied once `approve` refuses it. The request waits in `pendingApprovals` until the stream
   * ends, whether `approve` answered it or the turn was released.
   */
  const askThenRun = <E, R>(
    call: Response.ToolCallPartEncoded,
    ifApproved: Stream.Stream<StreamPart.StreamPart, E, R>
  ): Stream.Stream<StreamPart.StreamPart, E | HarnessError.HarnessError, R> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const approvalId = approvalIdOf(call)
        const answer = yield* Effect.acquireRelease(
          Effect.tap(Deferred.make<ApprovalResponse>(), (deferred) =>
            Ref.update(pendingApprovals, HashMap.set(approvalId, deferred))
          ),
          () => Ref.update(pendingApprovals, HashMap.remove(approvalId))
        )
        const request: StreamPart.StreamPart = {
          type: "tool-approval-request",
          approvalId,
          toolCallId: call.id
        }
        const decided = Stream.unwrap(
          Effect.map(
            Deferred.await(answer),
            (response): Stream.Stream<StreamPart.StreamPart, E | HarnessError.HarnessError, R> =>
              response.approved ? ifApproved : denyTool(call, response.reason)
          )
        )
        return Stream.concat(Stream.make(request), decided)
      })
    )

  /** Answers `call` as denied, without running the tool. The agent gets the denial as the result. */
  const denyTool = (
    call: Response.ToolCallPartEncoded,
    reason: string | undefined
  ): Stream.Stream<StreamPart.StreamPart, HarnessError.HarnessError> => {
    const part = {
      type: "tool-result",
      id: call.id,
      name: call.name,
      result: { type: "execution-denied", reason: reason ?? "The tool call was denied" },
      isFailure: true,
      providerExecuted: false
    } as const
    return Stream.fromEffect(submitResult(part))
  }

  /** Gives the agent `part`, a tool's final result, and returns it to stream. */
  const submitResult = <Part extends Parameters<Agent.AgentSession["submitToolResult"]>[0]>(part: Part) =>
    Effect.as(options.submitToolResult(part), part)

  const answerRequest = (response: ApprovalResponse) =>
    Effect.flatMap(
      Ref.modify(pendingApprovals, (current) => [
        HashMap.get(current, response.approvalId),
        HashMap.remove(current, response.approvalId)
      ]),
      (asked) =>
        Option.isNone(asked) ? Effect.succeed(false) : Effect.as(Deferred.succeed(asked.value, response), true)
    )

  const hostTools: HostTools = { answerCalls, answerRequest }
  return hostTools
})

/** Names the request to approve `call` after the call: unique, and no counter. */
const approvalIdOf = (call: Response.ToolCallPartEncoded) => `approval-${call.id}`

/**
 * Whether `tool` needs approval before running `call`, as Effect AI decides it for a language
 * model: a boolean, or a function of the call's decoded params and the conversation, which is read
 * only for a function. Params that do not decode need none, since the tool's handler rejects them
 * without running.
 */
const needsApproval = Effect.fnUntraced(
  function* <T extends Tool.Any>(
    tool: T,
    call: Response.ToolCallPartEncoded,
    conversation: Effect.Effect<ReadonlyArray<Prompt.Message>>
  ): Effect.fn.Return<boolean, Schema.SchemaError, Tool.HandlerServices<T>> {
    const { needsApproval: needed } = tool
    if (typeof needed !== "function") return needed === true
    // Decoding needs the services `HandlerServices` names for the tool, which TypeScript cannot
    // relate to the schema of a tool it knows only as `Tool.Any`, as in Effect AI's own check.
    const decodeParams = Schema.decodeUnknownEffect(tool.parametersSchema) as (
      params: unknown
    ) => Effect.Effect<unknown, Schema.SchemaError, Tool.HandlerServices<T>>
    const params = yield* decodeParams(call.params)
    const answer = needed(params, { toolCallId: call.id, messages: yield* conversation })
    return Effect.isEffect(answer) ? yield* answer : answer
  },
  Effect.orElseSucceed(() => false)
)

/** The tool that `name` names, with the name as the toolkit declares it, or nothing when none. */
const findTool = <Tools extends Record<string, Tool.Any>>(toolkit: Toolkit.WithHandler<Tools>, name: string) => {
  if (!isToolName(toolkit, name)) return undefined
  const tool = toolkit.tools[name]
  return tool === undefined ? undefined : { name, tool }
}

const isToolName = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<Tools>,
  name: string
): name is Extract<keyof Tools, string> => Object.hasOwn(toolkit.tools, name)
