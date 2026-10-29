/**
 * The agent `amends`: a loop over an Effect AI `LanguageModel` that runs in the host's process. Each
 * step streams the model's response to the conversation so far while Effect AI runs the tools the
 * model calls, and a turn takes steps until the model answers without calling a tool. With a sandbox
 * the agent works with the tools in `Tools`; without one, it answers from its model alone, calling
 * only the host's tools.
 *
 * It keeps nothing of its own between turns: a session it resumes goes on from the conversation the
 * session recorded, tool calls and results included. A turn does not outlive the process running
 * it: `continueTurn` goes on from the steps of a turn `suspendTurn` cut short that the session has,
 * and runs the step in flight again.
 *
 * Before each step, once the conversation fills most of the model's context window, the agent
 * compacts it: the model summarizes all but the latest messages, which the conversation keeps as
 * they were. `compact` summarizes all of it, between turns. A model whose endpoint does not know its
 * context window is compacted only on request.
 *
 * @since 0.1.0
 */

import { type Agent, HarnessError, type ModelEndpoint, type StreamPart } from "@amends-dev/harness"
import * as LanguageModel from "effect/ai/LanguageModel"
import * as Prompt from "effect/ai/Prompt"
import type * as Response from "effect/ai/Response"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Deferred from "effect/Deferred"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import { compactAt, compactMessages, keepUpTo, keptFromOf, tokensOf } from "./internal/compaction.ts"
import { errorPartOf, finishPartOf, streamPartsOf, turnFinishOf, unknownFinish } from "./internal/streamParts.ts"
import * as Models from "./Models.ts"
import * as Tools from "./Tools.ts"

/**
 * What the agent is made with: the endpoints its turns run on, as `Agent.Options` give them, and
 * what only this agent takes.
 *
 * @category options
 * @since 0.1.0
 */
export interface Options extends Agent.Options {
  /** The most steps a turn takes, ending it even while the model calls tools. Unlimited by default. */
  readonly maxSteps?: number

  /** How long a `bash` command runs before the agent kills it, 2 minutes by default. */
  readonly commandTimeout?: Duration.Duration
}

/**
 * The conversation a compaction during a turn left, as the model saw it, made before the turn's
 * step `step`, which went on from it.
 */
const TurnCompaction = Schema.Struct({ step: Schema.Int, conversation: Prompt.Prompt })

interface TurnCompaction extends Schema.Schema.Type<typeof TurnCompaction> {}

/**
 * What `suspendTurn` returns, for `createSession` to take back: the steps of the turn it cut short,
 * each as the messages that record it, as the model saw them, and the turn's latest compaction.
 */
const UnfinishedTurn = Schema.Struct({
  steps: Schema.Array(Prompt.Prompt),
  compaction: Schema.optionalKey(TurnCompaction)
})

interface UnfinishedTurn extends Schema.Schema.Type<typeof UnfinishedTurn> {}

const UnfinishedTurnJson = Schema.toCodecJson(UnfinishedTurn)

/**
 * A turn as far as it got: its prompt, the steps it finished, each as the messages that record it,
 * and its latest compaction.
 */
interface Turn extends UnfinishedTurn {
  readonly prompt: Prompt.UserMessage
}

/** A model a turn runs on, and its context window, when its endpoint knows it. */
interface TurnModel {
  readonly languageModel: LanguageModel.LanguageModel
  readonly contextWindow: number | undefined
}

/** A host's tool as the model sees it: through a stand-in that answers with the host's result. */
type HostTool = ReturnType<typeof standInFor>

/** The tools a turn offers the model: the agent's own, and stand-ins for the host's. */
type TurnTool = (typeof Tools.toolkit.tools)[keyof typeof Tools.toolkit.tools] | HostTool

type TurnTools = Toolkit.ToolsByName<ReadonlyArray<TurnTool>>

type JsonFormat = Extract<Agent.TurnOptions["responseFormat"], { readonly type: "json" }>

/** Delivers parts of the running turn to its stream. */
type Emit = (parts: ReadonlyArray<StreamPart.StreamPart>) => Effect.Effect<unknown>

/**
 * Stands in for a host's tool: the model sees the tool as the host declares it, and the stand-in
 * answers each call with the result the host submits, as it came. The session, which runs the
 * host's tool, checks the call's params. A provider sends the stand-in's JSON schema as it is,
 * without the changes its strict mode needs, so the stand-in is strict only when the host's tool
 * says so, as Effect's MCP tools are.
 */
const standInFor = (tool: Tool.Any) =>
  Tool.dynamic(tool.name, {
    description: Tool.getDescription(tool),
    parameters: Tool.getJsonSchema(tool),
    success: Schema.Unknown,
    failure: Schema.Unknown,
    failureMode: "return"
  }).annotate(Tool.Strict, Tool.getStrictMode(tool) ?? false)

/**
 * The agent, which makes the language model of each of its endpoints with `Models.LanguageModels`,
 * as `Models.layer` provides it over the `HttpClient` the requests go out through.
 *
 * **Example** (A turn on Anthropic's API, in the host's process)
 *
 * ```ts
 * import { Agent, Harness } from "@amends-dev/harness"
 * import { AmendsAgent, Models } from "@amends-dev/harness-amends"
 * import { Config, Effect, Layer } from "effect"
 * import { FetchHttpClient } from "effect/http"
 *
 * const program = Effect.gen(function* () {
 *   const agent = yield* AmendsAgent.make({
 *     model: {
 *       provider: "anthropic",
 *       model: "claude-sonnet-5-5",
 *       protocol: "anthropic-messages",
 *       url: "https://api.anthropic.com/v1",
 *       apiKey: yield* Config.Redacted("ANTHROPIC_API_KEY"),
 *       contextWindow: 200_000
 *     }
 *   })
 *   const harness = Harness.make(agent)
 *   const session = yield* harness.createSession({ id: Agent.SessionId.make("hello") })
 *   const answer = yield* session.generate({ prompt: "Say hello in one word." })
 *   return answer.text
 * }).pipe(Effect.provide(Models.layer.pipe(Layer.provide(FetchHttpClient.layer))))
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = Effect.fnUntraced(function* (options: Options) {
  const languageModels = yield* Models.LanguageModels
  const modelOf = (endpoint: ModelEndpoint.ModelEndpoint) =>
    Effect.map(languageModels.make(endpoint), (languageModel): TurnModel => ({
      languageModel,
      contextWindow: endpoint.contextWindow
    }))
  const model = yield* modelOf(options.model)
  const models = new Map(
    yield* Effect.forEach(Object.entries(options.models ?? {}), ([name, endpoint]) =>
      Effect.map(modelOf(endpoint), (turnModel) => [name, turnModel] as const)
    )
  )

  /** The model a turn names, or the agent's default. */
  const modelFor = (name: string | undefined) => {
    const named = name === undefined ? model : models.get(name)
    return named === undefined ? Effect.fail(unsupported(`amends has no model named ${name}`)) : Effect.succeed(named)
  }

  const agent: Agent.Agent = {
    id: "amends",
    requiresSandbox: false,
    createSession: (sessionOptions) => createSession(options, modelFor, sessionOptions)
  }
  return agent
})

const createSession = Effect.fn("AmendsAgent.createSession")(function* (
  options: Options,
  modelFor: (name: string | undefined) => Effect.Effect<TurnModel, HarnessError.HarnessError>,
  sessionOptions: Agent.CreateSessionOptions
) {
  const { workspace } = sessionOptions
  const maxSteps = options.maxSteps ?? Number.POSITIVE_INFINITY
  const suspended = yield* readUnfinishedTurn(sessionOptions.unfinishedTurn)
  const conversation = yield* Ref.make(sessionOptions.history)
  /**
   * The running turn, or the one `suspendTurn` cut short. A turn joins the conversation once the
   * session takes its `finish`, so that a turn which finished before the session had all of it can
   * still be continued, or as far as it got when its stream ends early.
   */
  const turn = yield* Ref.make<Turn | undefined>(undefined)
  /** Held while a turn runs, so that `suspendTurn` and `stop` read the turn once it has stopped. */
  const turnPermit = yield* Semaphore.make(1)
  /** Whether `suspendTurn` released the session, keeping the running turn for `continueTurn`. */
  const keepsTurn = yield* Ref.make(false)
  /** Done once the session is suspended, stopped, or destroyed, stopping the running turn. */
  const closed = yield* Deferred.make<void>()
  /**
   * The results the host submits for calls of its tools in the running turn, by call id, until a
   * stand-in takes them. A turn starts with none, dropping any for calls no stand-in answered.
   */
  const hostResults = new Map<string, Deferred.Deferred<unknown, unknown>>()

  /** Where the host's result for the call `id` waits, until the call's stand-in takes it. */
  const hostResultOf = (id: string) =>
    Effect.sync(() => {
      const existing = hostResults.get(id)
      if (existing !== undefined) return existing
      const created = Deferred.makeUnsafe<unknown, unknown>()
      hostResults.set(id, created)
      return created
    })

  /** Answers a call of a host's tool with the result the host submits for it. */
  const awaitHostResult = (_params: unknown, context: Toolkit.HandlerContext<HostTool>) => {
    // `LanguageModel` gives each handler the id of the call it answers.
    const id = context.toolCallId ?? ""
    // A failed call's result is whatever the host's tool returned, which the model reads as it came.
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off
    return Effect.flatMap(hostResultOf(id), Deferred.await).pipe(
      Effect.ensuring(Effect.sync(() => hostResults.delete(id)))
    )
  }

  /**
   * The tools a turn offers the model, with their handlers: the agent's own when it works in a
   * sandbox, and stand-ins for the host's.
   */
  const toolkitFor = (hostTools: ReadonlyArray<Tool.Any>) => {
    const standIns = hostTools.map(standInFor)
    const hostHandlers = Toolkit.make(...standIns).toLayer(
      Object.fromEntries(standIns.map((tool) => [tool.name, awaitHostResult]))
    )
    if (workspace === undefined) {
      return Effect.provide(Toolkit.make<ReadonlyArray<TurnTool>>(...standIns), hostHandlers)
    }
    const clash = hostTools.find((tool) => Object.hasOwn(Tools.toolkit.tools, tool.name))
    if (clash !== undefined) {
      return Effect.fail(unsupported(`The host's tool ${clash.name} has the name of one of amends's own tools`))
    }
    return Effect.provide(
      Toolkit.make<ReadonlyArray<TurnTool>>(...Object.values(Tools.toolkit.tools), ...standIns),
      Layer.merge(Tools.layer(workspace, { commandTimeout: options.commandTimeout }), hostHandlers)
    )
  }

  /** Whether `name` is one of the agent's own tools, which it has only in a sandbox. */
  const isOwnTool = (name: string) => workspace !== undefined && Object.hasOwn(Tools.toolkit.tools, name)

  /** The prompt a step sends the model: the turn's instructions, the conversation, and the turn so far. */
  const promptFor = (instructions: string | undefined) =>
    Effect.map(conversationSoFar, (messages) =>
      Prompt.fromMessages([
        ...(instructions === undefined ? [] : [Prompt.makeMessage("system", { content: instructions })]),
        ...messages.content
      ])
    )

  /** The conversation with the running turn as far as it got. */
  const conversationSoFar = Effect.map(Effect.all([Ref.get(conversation), Ref.get(turn)]), ([finished, current]) =>
    conversationOf(finished, current)
  )

  /** Adds a finished step's messages to the running turn. */
  const recordStep = (step: Prompt.Prompt) =>
    Ref.update(turn, (current) => (current === undefined ? current : { ...current, steps: [...current.steps, step] }))

  /** Adds the turn, as far as it got, to the conversation. */
  const recordTurn = Effect.flatMap(Ref.getAndSet(turn, undefined), (ended) =>
    Ref.update(conversation, (current) => conversationOf(current, ended))
  )

  /**
   * Compacts the conversation before the turn's next step once it fills `compactAt` of the model's
   * context window: the model summarizes all but the latest messages, up to `keepUpTo` of the
   * window, and the compaction streams first in the step.
   */
  const compactWhenFull = Effect.fn("AmendsAgent.compactWhenFull")(function* (
    contextWindow: number | undefined,
    emit: Emit
  ) {
    if (contextWindow === undefined) return
    const messages = (yield* conversationSoFar).content
    if (tokensOf(messages) < contextWindow * compactAt) return
    const compacted = yield* compactMessages(messages, keptFromOf(messages, contextWindow * keepUpTo), "auto")
    yield* Ref.update(turn, (current) =>
      current === undefined
        ? current
        : {
            ...current,
            compaction: { step: current.steps.length, conversation: compacted.conversation }
          }
    )
    yield* emit([compacted.compaction])
  })

  /**
   * Runs one step: streams the model's response to the conversation so far while Effect AI runs the
   * tools the model calls, emitting the step's parts. Returns how the step finished.
   */
  const runStep = Effect.fn("AmendsAgent.runStep")(function* (
    instructions: string | undefined,
    toolkit: Toolkit.WithHandler<TurnTools>,
    emit: Emit
  ) {
    const prompt = yield* promptFor(instructions)
    const parts: Array<Response.StreamPart<TurnTools>> = []
    yield* LanguageModel.streamText({ prompt, toolkit }).pipe(
      Stream.runForEach((part) => {
        parts.push(part)
        // A step is recorded before its `finish-step` goes out, so that `continueTurn` can go on
        // after any step the session has. Effect AI streams `finish` after the step's tool results.
        const record = part.type === "finish" ? recordStep(Prompt.fromResponseParts(parts)) : Effect.void
        return Effect.andThen(record, Effect.flatMap(streamPartsOf(part, isOwnTool), emit))
      })
    )
    const finish = parts.findLast((part) => part.type === "finish")
    // A response that did not say how it finished ended no step, and is recorded as it stands.
    if (finish === undefined) yield* recordStep(Prompt.fromResponseParts(parts))
    return finish ?? unknownFinish
  })

  /**
   * Runs the step that answers a turn asking for JSON: the model answers the conversation so far,
   * without tools, with the JSON `format` describes. Emits the answer as text and returns how the
   * step finished.
   */
  const answerInJson = Effect.fn("AmendsAgent.answerInJson")(function* (
    instructions: string | undefined,
    format: JsonFormat,
    emit: Emit
  ) {
    const prompt = yield* promptFor(instructions)
    const answer = yield* LanguageModel.generateObject({
      prompt,
      objectName: format.objectName,
      schema: answerSchemaOf(format.schema)
    }).pipe(
      Effect.map((response) => ({ text: response.text, finish: finishPartOf(response) })),
      // The session decodes the answer with the schema itself, and reports one that does not match.
      Effect.catchReason("AiError", "StructuredOutputError", (reason) =>
        Effect.succeed({ text: reason.responseText, finish: unknownFinish })
      )
    )
    yield* emit([
      { type: "text-start", id: "json-answer" },
      { type: "text-delta", id: "json-answer", delta: answer.text },
      { type: "text-end", id: "json-answer" }
    ])
    yield* recordStep(
      Prompt.fromMessages([
        Prompt.makeMessage("assistant", {
          content: [Prompt.makePart("text", { text: answer.text })]
        })
      ])
    )
    yield* Effect.flatMap(streamPartsOf(answer.finish, isOwnTool), emit)
    return answer.finish
  })

  /**
   * Streams a turn after the steps it finished: steps until the model stops calling tools, a step
   * answering in JSON when the turn asks for JSON, and then the turn's `finish`. A failure of the
   * model ends the turn with an `error` part. The turn stops when the session closes.
   */
  const runTurn = (turnOptions: Agent.TurnOptions, finished: UnfinishedTurn) =>
    Stream.callback<StreamPart.StreamPart, HarnessError.HarnessError>((queue) =>
      Effect.gen(function* () {
        const emit: Emit = (parts) => Queue.offerAll(queue, parts)
        yield* Ref.set(turn, {
          prompt: turnOptions.prompt,
          steps: finished.steps,
          ...(finished.compaction === undefined ? {} : { compaction: finished.compaction })
        })
        yield* Effect.sync(() => hostResults.clear())
        const { languageModel, contextWindow } = yield* modelFor(turnOptions.model)
        const toolkit = yield* toolkitFor(turnOptions.tools)
        const { instructions, responseFormat } = turnOptions

        const steps: Array<Response.FinishPart> = []
        const runSteps = Effect.gen(function* () {
          do {
            yield* compactWhenFull(contextWindow, emit)
            steps.push(yield* runStep(instructions, toolkit, emit))
          } while (takesAnotherStep(steps, maxSteps))
          if (responseFormat.type === "json") {
            yield* compactWhenFull(contextWindow, emit)
            steps.push(yield* answerInJson(instructions, responseFormat, emit))
          }
        })
        const outcome = yield* Effect.result(
          Effect.provideService(runSteps, LanguageModel.LanguageModel, languageModel)
        )
        if (Result.isFailure(outcome)) yield* emit([yield* errorPartOf(outcome.failure)])
        yield* emit([yield* turnFinishOf(steps, Result.isFailure(outcome))])
      }).pipe(Effect.raceFirst(Deferred.await(closed)), Semaphore.withPermit(turnPermit), Queue.into(queue))
    ).pipe(
      Stream.tap((part) => (part.type === "finish" ? recordTurn : Effect.void)),
      Stream.ensuring(Effect.flatMap(Ref.get(keepsTurn), (keeps) => (keeps ? Effect.void : recordTurn)))
    )

  /** Runs `effect` once the running turn has stopped, after the session closed. */
  const onceStopped = <A, E>(effect: Effect.Effect<A, E>) => Semaphore.withPermit(turnPermit, effect)

  /**
   * What `suspendTurn` returns: the steps of the turn it cut short and its latest compaction, none
   * when the turn finished.
   */
  const saveUnfinishedTurn = Effect.flatMap(Ref.get(turn), (unfinished) =>
    Schema.encodeEffect(UnfinishedTurnJson)({
      steps: unfinished?.steps ?? [],
      ...(unfinished?.compaction === undefined ? {} : { compaction: unfinished.compaction })
    })
  ).pipe(Effect.orDie)

  const close = Deferred.succeed(closed, undefined)

  const session: Agent.AgentSession = {
    hasUnfinishedTurn: suspended !== undefined,

    promptTurn: (turnOptions) => runTurn(turnOptions, { steps: [] }),

    continueTurn: (turnOptions, finishedSteps) => runTurn(turnOptions, finishedPartOf(suspended, finishedSteps)),

    submitToolResult: ({ id, result, isFailure }) =>
      Effect.flatMap(hostResultOf(id), (deferred) =>
        isFailure ? Deferred.fail(deferred, result) : Deferred.succeed(deferred, result)
      ),

    approve: () => Effect.fail(unsupported("amends asks for no approvals")),

    compact: (instructions) =>
      Effect.gen(function* () {
        const { languageModel } = yield* modelFor(undefined)
        const messages = (yield* Ref.get(conversation)).content
        const compacted = yield* compactMessages(messages, messages.length, "manual", instructions).pipe(
          Effect.provideService(LanguageModel.LanguageModel, languageModel),
          Effect.mapError((error) =>
            harnessError(
              new HarnessError.UnknownError({
                description: `amends could not summarize the conversation: ${error.message}`
              }),
              error
            )
          )
        )
        yield* Ref.set(conversation, compacted.conversation)
        return compacted.compaction
      }),

    suspendTurn: Effect.andThen(Effect.andThen(Ref.set(keepsTurn, true), close), onceStopped(saveUnfinishedTurn)),

    // The session records the conversation, which it gives back when it resumes.
    detach: Effect.succeed(null),

    stop: Effect.andThen(close, onceStopped(Effect.as(recordTurn, null))),

    destroy: close
  }
  return session
})

/**
 * The conversation with `turn` after `finished`: the turn's prompt and steps, or, once the turn
 * compacted the conversation, what the compaction left and the steps after it.
 */
const conversationOf = (finished: Prompt.Prompt, turn: Turn | undefined): Prompt.Prompt => {
  if (turn === undefined) return finished
  const { compaction } = turn
  const steps = turn.steps.slice(compaction?.step ?? 0).flatMap((step) => step.content)
  return compaction === undefined
    ? Prompt.fromMessages([...finished.content, turn.prompt, ...steps])
    : Prompt.fromMessages([...compaction.conversation.content, ...steps])
}

/**
 * The part of the turn `suspended` that the session has: its first `finishedSteps` steps, and its
 * compaction when one of them made it. A compaction the step in flight made is made again, when the
 * step runs again.
 */
const finishedPartOf = (suspended: UnfinishedTurn | undefined, finishedSteps: number): UnfinishedTurn => {
  const compaction = suspended?.compaction
  return {
    steps: suspended?.steps.slice(0, finishedSteps) ?? [],
    ...(compaction !== undefined && compaction.step < finishedSteps ? { compaction } : {})
  }
}

/** Whether a turn takes another step after `steps`: while the model calls tools, up to `maxSteps`. */
const takesAnotherStep = (steps: ReadonlyArray<Response.FinishPart>, maxSteps: number) =>
  steps.at(-1)?.reason === "tool-calls" && steps.length < maxSteps

/**
 * The schema `generateObject` takes for a turn's JSON: `schema`'s encoded side, which describes the
 * JSON and decodes it as it came, needing no services, typed as the JSON object models answer with.
 * The session decodes the answer with `schema` itself.
 */
const answerSchemaOf = (schema: Schema.Top) =>
  Schema.make<Schema.Codec<Record<string, unknown>>>(Schema.toEncoded(schema).ast)

/** Reads what the agent's `suspendTurn` returned, failing when it is not that. */
const readUnfinishedTurn = (json: Schema.Json | undefined) =>
  Schema.decodeEffect(Schema.UndefinedOr(UnfinishedTurnJson))(json).pipe(
    Effect.mapError((cause) =>
      harnessError(
        new HarnessError.AgentContractError({
          description: `amends cannot read the state it was given: ${cause.message}`
        }),
        cause
      )
    )
  )

const unsupported = (description: string) => harnessError(new HarnessError.UnsupportedError({ description }))

const harnessError = (reason: HarnessError.HarnessErrorReason, cause?: unknown) =>
  new HarnessError.HarnessError({ agent: "amends", reason, cause })
