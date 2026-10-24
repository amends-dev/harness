/**
 * How a `Session` runs a conversation: its state, which every operation changes in one step, the
 * delivery of each turn's parts, and the record of the conversation. `host-tools.ts` runs the
 * host's tools the agent calls. `Harness` makes sessions with `makeSession`; the package does not
 * export this module.
 */

import * as AiError from "effect/ai/AiError"
import * as Prompt from "effect/ai/Prompt"
import type * as Response from "effect/ai/Response"
import type * as Tool from "effect/ai/Tool"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type * as Agent from "../Agent.ts"
import * as GenerateResult from "../GenerateResult.ts"
import * as HarnessError from "../HarnessError.ts"
import * as Session from "../Session.ts"
import * as StreamPart from "../StreamPart.ts"
import { type ApprovalResponse, makeHostTools } from "./hostTools.ts"

/**
 * Where a session is, and its conversation so far. They change together, so that a turn that
 * finishes leaves the session idle with the turn in its conversation at once.
 */
interface State {
  readonly status: Status
  readonly history: Prompt.Prompt

  /**
   * The operation releasing the session, from when it takes hold until it marks the session
   * released. A running turn's stream then ends without its `finish`, and the operation ends the
   * turn itself.
   */
  readonly releasing: Release | undefined
}

/**
 * Where a session is: between turns, holding a turn `suspendTurn` cut short, running a turn,
 * compacting the conversation between turns, or released.
 */
type Status = Data.TaggedEnum<{
  Idle: {}
  Unfinished: { readonly turn: Session.UnfinishedTurn }
  Running: { readonly turn: RunningTurn }
  Compacting: {}
  Released: {
    /** Whether `stop` or `destroy` aborted a running turn, before its `finish`. */
    readonly abortedTurn: boolean
  }
}>

const Status = Data.taggedEnum<Status>()

const isUnfinished = Status.$is("Unfinished")
const isRunning = Status.$is("Running")
const isCompacting = Status.$is("Compacting")
const isReleased = Status.$is("Released")

/** A turn a session is running, as far as its stream has delivered it. */
interface RunningTurn {
  readonly prompt: Prompt.UserMessage

  /** How the turn answers, as the unfinished turn records it. */
  readonly responseFormat: Session.UnfinishedTurn["responseFormat"]

  /** The steps the turn finished, their parts added up, with those before `suspendTurn`. */
  readonly steps: ReadonlyArray<StreamPart.Step>

  /** The parts delivered of the step the turn is taking. */
  readonly stepParts: ReadonlyArray<StreamPart.StreamPart>
}

/** The operations that release a session. */
type Release = "suspendTurn" | "detach" | "stop" | "destroy"

/** The operations that continue the unfinished turn, each for turns that answer one way. */
type Continue = "continueStream" | "continueGenerate" | "continueGenerateObject"

type Operation = "stream" | "approve" | "compact" | Continue | Release

/** Why `operation` cannot run in a session in `state`, or nothing when it can. */
const refusal = ({ status, releasing }: State, operation: Operation): HarnessError.HarnessErrorReason | undefined => {
  // A session can be destroyed at any time, also once released, or while it is.
  if (operation === "destroy") return undefined
  if (isReleased(status)) return new HarnessError.SessionReleasedError({})
  if (releasing !== undefined) {
    return new HarnessError.SessionReleasedError({
      description: `The session is being released by ${releasing}`
    })
  }
  switch (operation) {
    case "stream":
    case "compact":
      if (isUnfinished(status)) {
        return new HarnessError.TurnInProgressError({
          description: "The session has an unfinished turn, which a continue operation finishes"
        })
      }
      if (isCompacting(status)) return compactingError()
      return isRunning(status) ? new HarnessError.TurnInProgressError({}) : undefined
    case "continueStream":
    case "continueGenerate":
    case "continueGenerateObject": {
      if (isRunning(status)) return new HarnessError.TurnInProgressError({})
      if (!isUnfinished(status)) {
        return new HarnessError.NoTurnError({ description: "The session has no unfinished turn" })
      }
      // A turn is finished the way it answers: whole and decoded for JSON, otherwise as text.
      const answersIn = status.turn.responseFormat.type
      const finishes = operation === "continueGenerateObject" ? "json" : "text"
      if (answersIn === finishes) return undefined
      return new HarnessError.NoTurnError({
        description:
          answersIn === "json"
            ? "The unfinished turn answers in JSON, which `continueGenerateObject` finishes"
            : "The unfinished turn answers in text, which `continueStream` or `continueGenerate` finishes"
      })
    }
    case "suspendTurn":
      return isRunning(status)
        ? undefined
        : new HarnessError.NoTurnError({ description: "The session is not running a turn" })
    case "detach":
      if (isCompacting(status)) return compactingError()
      return isRunning(status)
        ? new HarnessError.TurnInProgressError({
            description: "A running turn must be suspended before the session detaches"
          })
        : undefined
    case "approve":
    case "stop":
      return undefined
  }
}

const compactingError = () =>
  new HarnessError.TurnInProgressError({
    description: "The session is compacting its conversation"
  })

/**
 * Whether a session in `state` delivers `part` of its running turn, and the session after it does.
 * A session that no longer runs the turn delivers nothing more. A `finish-step` adds the step it
 * ends to the turn's steps, and the turn's `finish` adds the turn to the conversation.
 */
const deliver = (state: State, part: StreamPart.StreamPart): [boolean, State] => {
  if (!isRunning(state.status)) return [false, state]
  const { turn } = state.status
  if (part.type === "finish") {
    const history = withTurn(state.history, turn.prompt, stepsSoFar(turn))
    return [true, { ...state, status: Status.Idle(), history }]
  }
  if (part.type === "finish-step") {
    const steps = [...turn.steps, ...StreamPart.stepsOf([...turn.stepParts, part])]
    const next = { ...turn, steps, stepParts: [] }
    return [true, { ...state, status: Status.Running({ turn: next }) }]
  }
  const next = { ...turn, stepParts: [...turn.stepParts, part] }
  return [true, { ...state, status: Status.Running({ turn: next }) }]
}

/** Whether `stop` or `destroy` aborted the turn a session ran, before its `finish`. */
const wasAborted = ({ status, releasing }: State) =>
  (isRunning(status) && (releasing === "stop" || releasing === "destroy")) || (isReleased(status) && status.abortedTurn)

/** How the stream of a turn `stop` or `destroy` aborted ends: as a turn that failed. */
const abortedEnding: ReadonlyArray<StreamPart.StreamPart> = [
  { type: "error", error: { type: "aborted", message: "The session was stopped during the turn" } },
  { type: "finish", reason: "error", usage: { inputTokens: {}, outputTokens: {} } }
]

/** The conversation with a turn after `history`: the turn's prompt, then each of its `steps`. */
const withTurn = (history: Prompt.Prompt, prompt: Prompt.UserMessage, steps: ReadonlyArray<StreamPart.Step>) =>
  steps.reduce(Session.recordStep, Prompt.concat(history, Prompt.fromMessages([prompt])))

/**
 * The conversation with a turn that ended without its `finish`, other than by `suspendTurn`, as far
 * as the session delivered it. A turn that delivered nothing, such as one the agent refused, is
 * left out.
 */
const withEndedTurn = (history: Prompt.Prompt, turn: RunningTurn) =>
  turn.steps.length === 0 && turn.stepParts.length === 0 ? history : withTurn(history, turn.prompt, stepsSoFar(turn))

/** The steps of a turn as far as the session delivered them, the one it is taking last. */
const stepsSoFar = (turn: RunningTurn) => [...turn.steps, ...StreamPart.stepsOf(turn.stepParts)]

/**
 * The conversation as the session has recorded it: the turns before, and the running turn's prompt
 * and finished steps. The session reads the agent's parts ahead of the caller, so a step the caller
 * has not read to its end yet may be missing.
 */
const recordedConversation = ({ status, history }: State): ReadonlyArray<Prompt.Message> =>
  (isRunning(status) ? withTurn(history, status.turn.prompt, status.turn.steps) : history).content

/** Makes the session `Harness.createSession` hands out, over an agent session it started. */
export const makeSession = Effect.fnUntraced(function* (options: {
  readonly id: Agent.SessionId
  readonly agent: string
  readonly agentSession: Agent.AgentSession
  readonly history: Prompt.Prompt
  readonly unfinishedTurn: Session.UnfinishedTurn | undefined
}) {
  const { agentSession } = options
  // An agent that does not have the unfinished turn runs it again from its prompt, so the steps
  // the turn finished before are not part of it.
  const unfinishedTurn =
    options.unfinishedTurn !== undefined && !agentSession.hasUnfinishedTurn
      ? {
          prompt: options.unfinishedTurn.prompt,
          responseFormat: options.unfinishedTurn.responseFormat,
          steps: []
        }
      : options.unfinishedTurn
  const state = yield* Ref.make<State>({
    status: unfinishedTurn === undefined ? Status.Idle() : Status.Unfinished({ turn: unfinishedTurn }),
    history: options.history,
    releasing: undefined
  })

  const harnessError = (reason: HarnessError.HarnessErrorReason, cause?: unknown) =>
    new HarnessError.HarnessError({ agent: options.agent, reason, cause })

  const hostTools = yield* makeHostTools({
    agent: options.agent,
    submitToolResult: agentSession.submitToolResult,
    conversation: Effect.map(Ref.get(state), recordedConversation)
  })

  /** Fails when `operation` cannot run in the session now. */
  const checkStatus = (operation: Operation) =>
    Effect.flatMap(Ref.get(state), (current) => {
      const reason = refusal(current, operation)
      return reason === undefined ? Effect.void : Effect.fail(harnessError(reason))
    })

  /** Marks the session as running a new turn, failing when it cannot start one now. */
  const startTurn = (prompt: Prompt.UserMessage, responseFormat: RunningTurn["responseFormat"]) =>
    Effect.flatten(
      Ref.modify(state, (current): [Effect.Effect<void, HarnessError.HarnessError>, State] => {
        const reason = refusal(current, "stream")
        if (reason !== undefined) return [Effect.fail(harnessError(reason)), current]
        const turn = { prompt, responseFormat, steps: [], stepParts: [] }
        return [Effect.void, { ...current, status: Status.Running({ turn }) }]
      })
    )

  /**
   * Streams the parts of the running turn that `agentTurn` streams, with the results of the host's
   * tools it calls. A part is delivered only while the session runs the turn, so once `suspendTurn`
   * or `stop` released it, the session holds every part the caller has. The stream of a turn
   * `stop` or `destroy` aborted ends with an error, and a stream that ends otherwise without the
   * turn's `finish` ends the turn as far as it got.
   */
  const runTurn = <Tools extends Record<string, Tool.Any>>(
    agentTurn: Stream.Stream<StreamPart.StreamPart, HarnessError.HarnessError>,
    toolkit: Session.StreamOptions<Tools>["toolkit"]
  ) =>
    hostTools.answerCalls(agentTurn, toolkit).pipe(
      Stream.takeWhileEffect((part) => Ref.modify(state, (current) => deliver(current, part))),
      Stream.concat(
        Stream.unwrap(
          Effect.map(Ref.get(state), (current) =>
            wasAborted(current) ? Stream.fromIterable(abortedEnding) : Stream.empty
          )
        )
      ),
      Stream.ensuring(
        Ref.update(state, (current) =>
          isRunning(current.status) && current.releasing === undefined
            ? {
                ...current,
                status: Status.Idle(),
                history: withEndedTurn(current.history, current.status.turn)
              }
            : current
        )
      )
    )

  /** Runs a new turn with the caller's prompt, once the session can start one. */
  const promptTurn = <Tools extends Record<string, Tool.Any>>(
    options: Session.StreamOptions<Tools>,
    responseFormat: Agent.TurnOptions["responseFormat"]
  ) => {
    const prompt = userMessageOf(options.prompt)
    return Stream.unwrap(
      Effect.as(
        startTurn(prompt, recordedFormatOf(responseFormat)),
        runTurn(agentSession.promptTurn({ ...turnOptionsOf(options), prompt, responseFormat }), options.toolkit)
      )
    )
  }

  /** The whole turn, failing with `TurnFailedError` when the agent reported a failure. */
  const resultOf = (parts: ReadonlyArray<StreamPart.StreamPart>) => {
    const error = parts.find((part) => part.type === "error")
    return error === undefined
      ? Effect.succeed(new GenerateResult.GenerateResult(parts))
      : Effect.fail(harnessError(new HarnessError.TurnFailedError({ error: error.error })))
  }

  /**
   * The whole turn with its answer decoded with `schema`. An answer that does not match fails as
   * Effect AI's `generateObject` fails.
   */
  const objectResultOf = Effect.fnUntraced(function* <S extends Schema.Top>(
    schema: S,
    parts: ReadonlyArray<StreamPart.StreamPart>
  ) {
    const result = yield* resultOf(parts)
    const value = yield* Schema.decodeEffect(Schema.fromJsonString(schema))(result.text).pipe(
      Effect.mapError((error) =>
        AiError.make({
          module: "Harness",
          method: "generateObject",
          reason: new AiError.StructuredOutputError({
            description: error.message,
            responseText: result.text,
            usage: usageInfoOf(result.usage)
          })
        })
      )
    )
    return new GenerateResult.GenerateObjectResult(value, parts)
  })

  /**
   * Answers an approval request: one the session made for a host's tool, which it answers once, or
   * else one of the agent's own, which it passes on.
   */
  const approve = Effect.fn("Session.approve")(function* (response: ApprovalResponse) {
    yield* checkStatus("approve")
    const answered = yield* hostTools.answerRequest(response)
    if (!answered) yield* agentSession.approve(response)
  })

  /**
   * Collects a turn that is returned whole. Nothing can answer its approval requests before it
   * ends, so it denies each, and its tools that need approval do not run.
   */
  const collectDenyingApprovals = <E, R>(turn: Stream.Stream<StreamPart.StreamPart, E, R>) =>
    Stream.runCollect(
      Stream.tap(turn, (part) =>
        part.type === "tool-approval-request"
          ? approve({
              approvalId: part.approvalId,
              approved: false,
              reason: "The turn returns whole, so it cannot ask for approval"
            })
          : Effect.void
      )
    )

  /**
   * Marks the session as running its unfinished turn for `operation` and returns the turn, failing
   * when it has none that the operation finishes.
   */
  const resumeTurn = (operation: Continue) =>
    Effect.flatten(
      Ref.modify(state, (current): [Effect.Effect<Session.UnfinishedTurn, HarnessError.HarnessError>, State] => {
        const { status } = current
        const reason = refusal(current, operation)
        // `refusal` lets the session continue only an unfinished turn.
        if (reason !== undefined || !isUnfinished(status)) {
          return [Effect.fail(harnessError(reason ?? new HarnessError.NoTurnError({}))), current]
        }
        const turn = {
          prompt: status.turn.prompt,
          responseFormat: status.turn.responseFormat,
          steps: status.turn.steps,
          stepParts: []
        }
        return [Effect.succeed(status.turn), { ...current, status: Status.Running({ turn }) }]
      })
    )

  /**
   * Continues the unfinished turn with `operation`, the settings given again, and `schema` for a
   * turn that answers in JSON: on the agent that cut it short, after the steps it finished, or on
   * any other from its prompt.
   */
  const continueTurn = <Tools extends Record<string, Tool.Any>>(
    operation: Continue,
    options: Session.ContinueOptions<Tools>,
    schema?: Schema.Top
  ) =>
    Stream.unwrap(
      Effect.map(resumeTurn(operation), (turn) => {
        const turnOptions = {
          ...turnOptionsOf(options),
          prompt: turn.prompt,
          responseFormat: answerFormatOf(turn.responseFormat, schema)
        }
        const agentTurn = agentSession.hasUnfinishedTurn
          ? agentSession.continueTurn(turnOptions, turn.steps.length)
          : agentSession.promptTurn(turnOptions)
        return runTurn(agentTurn, options.toolkit)
      })
    )

  /**
   * Asks the agent to compact the conversation, holding the session meanwhile so that no turn
   * starts, and records the compaction once the agent made it.
   */
  const compact = Effect.fn("Session.compact")(function* (instructions?: string) {
    yield* Effect.flatten(
      Ref.modify(state, (current): [Effect.Effect<void, HarnessError.HarnessError>, State] => {
        const reason = refusal(current, "compact")
        if (reason !== undefined) return [Effect.fail(harnessError(reason)), current]
        return [Effect.void, { ...current, status: Status.Compacting() }]
      })
    )
    const compaction = yield* Effect.onError(agentSession.compact(instructions), () =>
      Ref.update(state, (current) => (isCompacting(current.status) ? { ...current, status: Status.Idle() } : current))
    )
    // A compaction between turns is recorded as a step that only compacts.
    yield* Ref.update(state, (current) =>
      isCompacting(current.status)
        ? {
            ...current,
            status: Status.Idle(),
            history: Session.recordStep(current.history, { parts: [compaction] })
          }
        : current
    )
    return compaction
  })

  /**
   * Releases the session with `operation`: takes hold of it, so that no turn starts and no other
   * operation releases it meanwhile, asks the agent with `agentCall`, and marks it released.
   * Returns what the agent answered and the session as it was when released. When `agentCall`
   * fails, the session releases its hold and stays open.
   */
  const release = Effect.fnUntraced(function* <A>(
    operation: Release,
    agentCall: Effect.Effect<A, HarnessError.HarnessError>
  ): Effect.fn.Return<readonly [A, State], HarnessError.HarnessError> {
    yield* Effect.flatten(
      Ref.modify(state, (current): [Effect.Effect<void, HarnessError.HarnessError>, State] => {
        const reason = refusal(current, operation)
        if (reason !== undefined) return [Effect.fail(harnessError(reason)), current]
        // `destroy` also runs once the session is released, or while it is.
        const holds = !isReleased(current.status) && current.releasing === undefined
        return [Effect.void, holds ? { ...current, releasing: operation } : current]
      })
    )
    const answer = yield* Effect.onError(agentCall, () =>
      Ref.update(state, (current) => (current.releasing === operation ? { ...current, releasing: undefined } : current))
    )
    const released = yield* markReleased
    return [answer, released] as const
  })

  /** Marks the session released, returning it as it was before. */
  const markReleased = Ref.getAndUpdate(state, (current) => ({
    ...current,
    status: Status.Released({ abortedTurn: wasAborted(current) }),
    releasing: undefined
  }))

  /** What `suspendTurn`, `detach`, and `stop` return. */
  const savedState = (
    history: Prompt.Prompt,
    agentState: Schema.Json | undefined,
    unfinishedTurn: Session.UnfinishedTurn | undefined
  ): Session.SessionState => ({
    id: options.id,
    agent: options.agent,
    history,
    ...(agentState === undefined ? {} : { agentState }),
    unfinishedTurn
  })

  const session: Session.Session = {
    id: options.id,

    hasUnfinishedTurn: unfinishedTurn !== undefined && agentSession.hasUnfinishedTurn,

    stream: (streamOptions) => promptTurn(streamOptions, { type: "text" }),

    generate: Effect.fn("Session.generate")(function* (generateOptions) {
      const parts = yield* collectDenyingApprovals(promptTurn(generateOptions, { type: "text" }))
      return yield* resultOf(parts)
    }),

    generateObject: Effect.fn("Session.generateObject")(function* (objectOptions) {
      const parts = yield* collectDenyingApprovals(
        promptTurn(objectOptions, {
          type: "json",
          objectName: objectOptions.objectName ?? "output",
          schema: objectOptions.schema
        })
      )
      return yield* objectResultOf(objectOptions.schema, parts)
    }),

    continueStream: (continueOptions) => continueTurn("continueStream", continueOptions),

    continueGenerate: Effect.fn("Session.continueGenerate")(function* (continueOptions) {
      const parts = yield* collectDenyingApprovals(continueTurn("continueGenerate", continueOptions))
      return yield* resultOf(parts)
    }),

    continueGenerateObject: Effect.fn("Session.continueGenerateObject")(function* <
      S extends Schema.Top,
      Tools extends Record<string, Tool.Any>
    >(objectOptions: Session.ContinueObjectOptions<S, Tools>) {
      const parts = yield* collectDenyingApprovals(
        continueTurn("continueGenerateObject", objectOptions, objectOptions.schema)
      )
      return yield* objectResultOf(objectOptions.schema, parts)
    }),

    approve,

    compact,

    suspendTurn: Effect.gen(function* () {
      const [agentState, { status, history }] = yield* release("suspendTurn", agentSession.suspendTurn)
      // A turn that finished while the agent released it is in the conversation already.
      const unfinishedTurn = isRunning(status)
        ? {
            prompt: status.turn.prompt,
            responseFormat: status.turn.responseFormat,
            steps: status.turn.steps,
            agentState
          }
        : undefined
      return savedState(history, undefined, unfinishedTurn)
    }),

    detach: Effect.gen(function* () {
      const [agentState, { status, history }] = yield* release("detach", agentSession.detach)
      return savedState(history, agentState, isUnfinished(status) ? status.turn : undefined)
    }),

    stop: Effect.gen(function* () {
      const [agentState, { status, history }] = yield* release("stop", agentSession.stop)
      return savedState(
        isRunning(status) ? withEndedTurn(history, status.turn) : history,
        agentState,
        isUnfinished(status) ? status.turn : undefined
      )
    }),

    destroy: Effect.asVoid(release("destroy", agentSession.destroy))
  }
  return session
})

const userMessageOf = (prompt: string | Prompt.UserMessage): Prompt.UserMessage =>
  typeof prompt === "string"
    ? Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: prompt })] })
    : prompt

/** The agent's settings for a turn, with the host's tools as the toolkit declares them. */
const turnOptionsOf = <Tools extends Record<string, Tool.Any>>(options: Session.ContinueOptions<Tools>) => ({
  instructions: options.instructions,
  model: options.model,
  tools: options.toolkit === undefined ? [] : Object.values<Tool.Any>(options.toolkit.tools)
})

/** How a turn answers, as the unfinished turn records it: without the schema, which is not data. */
const recordedFormatOf = (responseFormat: Agent.TurnOptions["responseFormat"]): RunningTurn["responseFormat"] =>
  responseFormat.type === "json" ? { type: "json", objectName: responseFormat.objectName } : { type: "text" }

/**
 * How the agent answers a turn it continues: as the turn answered, with `schema` for an answer in
 * JSON. `refusal` lets only `continueGenerateObject`, which gives the schema, continue a JSON turn.
 */
const answerFormatOf = (
  recorded: RunningTurn["responseFormat"],
  schema: Schema.Top | undefined
): Agent.TurnOptions["responseFormat"] =>
  recorded.type === "json" && schema !== undefined ? { ...recorded, schema } : { type: "text" }

/** A turn's usage as `AiError` reports it: the prompt's tokens and the completion's. */
const usageInfoOf = (usage: typeof Response.Usage.Encoded): typeof AiError.UsageInfo.Type => ({
  ...(usage.inputTokens.total === undefined ? {} : { promptTokens: usage.inputTokens.total }),
  ...(usage.outputTokens.total === undefined ? {} : { completionTokens: usage.outputTokens.total })
})
