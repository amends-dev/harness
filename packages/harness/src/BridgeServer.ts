/**
 * The bridge's side of `Bridge.Rpcs`, which runs in the sandbox and serves a driver's sessions to
 * hosts. `serve` serves them over a WebSocket at `/`, refusing a host that does not present the
 * bridge's token, and `layerHandlers` is the same bridge without a transport. `readLaunchOptions`
 * reads what the host that launched the bridge gave it.
 *
 * Once it listens, the bridge writes the port to `Bridge.listeningFile` in its state directory,
 * where hosts find it. It exits once it runs no turn and either no host has started a session or a
 * turn there for its idle timeout, or the file names another port: another bridge of its id took
 * its place, as when two hosts launched one at once.
 *
 * Each session the bridge starts runs in a scope of its own until a host stops or destroys it. The
 * bridge runs the session's turns itself, one at a time, in that scope, so that a turn does not end
 * with the connection of the host that started it; a host that starts another turn has moved on
 * from the one running, as when the host that started it is gone, so the bridge aborts it rather
 * than refuse the new turn. It numbers a turn's parts as the turn streams them and keeps them in
 * memory and in a file in its state directory, a line each, followed by how the turn ended. A
 * session keeps only its latest turn, which hosts read from any number while it runs and after it
 * ends. A bridge started again reads a turn from its file. A turn whose file has no end, which the
 * bridge ran when it died, ended then, aborted. A turn the bridge aborted that a host starts again
 * continues, in the conversation the agent kept, from the steps it finished.
 *
 * @since 0.1.0
 */

import { Network } from "@amends-dev/sandbox"
import * as Prompt from "effect/ai/Prompt"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServer from "effect/http/HttpServer"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"
import * as NetAddress from "effect/net/NetAddress"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"
import type * as Agent from "./Agent.ts"
import * as Bridge from "./Bridge.ts"
import * as HarnessError from "./HarnessError.ts"
import { isPresented } from "./internal/bearer.ts"

/**
 * What `serve` serves a driver with: the bridge's token, its id, its state directory, as the
 * host's `Bridge.LaunchOptions` give them, and how long it waits idle before it exits.
 *
 * @category options
 * @since 0.1.0
 */
export interface Options {
  /** The token hosts present when they connect. */
  readonly token: Redacted.Redacted<string>

  /** The bridge's id, which `Hello` answers. */
  readonly bridge: Bridge.BridgeId

  /**
   * The absolute directory, outside every session's directory, that the bridge keeps its turns in
   * and writes `Bridge.listeningFile` to.
   */
  readonly stateDirectory: string

  /**
   * How long the bridge waits for a host while it runs no turn, before it exits; 10 minutes by
   * default.
   */
  readonly idleTimeout?: Duration.Input
}

/**
 * How busy a bridge is: how many turns it runs, and when a host last started a session or a turn
 * there, or a turn last ended, in milliseconds since the epoch.
 *
 * @category models
 * @since 0.1.0
 */
export interface Activity {
  readonly turns: number
  readonly lastActiveAt: number
}

/**
 * What the handlers take of `serve`'s options, with the activity they record.
 *
 * @category options
 * @since 0.1.0
 */
export interface HandlerOptions extends Pick<Options, "stateDirectory" | "bridge"> {
  /** Where the handlers record the turns they run and when a host was last active. */
  readonly activity?: Ref.Ref<Activity>
}

/**
 * Serves `driver`'s sessions over a WebSocket at `/`, on the `HttpServer` provided, and writes the
 * server's port to `Bridge.listeningFile`, until the bridge has been idle for its idle timeout or
 * another bridge of its id takes its place.
 *
 * **Details**
 *
 * The sessions end, aborting their turns, when the scope closes.
 *
 * **Example** (A bridge program on Bun)
 *
 * ```ts
 * import { Bridge, BridgeServer } from "@amends-dev/harness"
 * import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun"
 * import { Effect, Layer, Redacted, Schema } from "effect"
 *
 * // The adapter's driver, made from the agent options the host launched the bridge with.
 * declare const makeDriver: (agentOptions: Schema.Json) => Effect.Effect<Bridge.Driver>
 *
 * const program = Effect.gen(function* () {
 *   const launch = yield* BridgeServer.readLaunchOptions
 *   const driver = yield* makeDriver(launch.agentOptions)
 *   yield* BridgeServer.serve(driver, {
 *     token: Redacted.make(launch.token),
 *     bridge: launch.bridge,
 *     stateDirectory: launch.stateDirectory
 *   })
 * })
 *
 * // The sandbox picks the port; the bridge writes it where hosts look for it.
 * BunRuntime.runMain(
 *   program.pipe(
 *     Effect.scoped,
 *     Effect.provide(Layer.merge(BunHttpServer.layer({ hostname: "0.0.0.0", port: 0 }), BunServices.layer))
 *   )
 * )
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const serve = Effect.fnUntraced(function* (driver: Bridge.Driver, options: Options) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const activity = yield* Ref.make<Activity>({
    turns: 0,
    lastActiveAt: yield* Clock.currentTimeMillis
  })
  const handlers = layerHandlers(driver, {
    stateDirectory: options.stateDirectory,
    bridge: options.bridge,
    activity
  })
  yield* Layer.build(
    HttpRouter.serve(
      RpcServer.layer(Bridge.Rpcs).pipe(
        Layer.provide([handlers, layerProtocol(options.token)]),
        Layer.provide(RpcSerialization.layerJson)
      ),
      { disableLogger: true }
    )
  )
  const { address } = yield* HttpServer.HttpServer
  if (NetAddress.isUnixPathAddress(address)) {
    return yield* Effect.die(new Error("A bridge listens on a port, not on a Unix socket"))
  }
  const port = Network.Port.make(address.port)
  const file = path.join(options.stateDirectory, Bridge.listeningFile)
  /** Whether `Bridge.listeningFile` names this bridge's port. */
  const isListed = Effect.map(readListening(file), (listed) => listed?.port === port)
  yield* writeListening(file, { port })
  // A file naming a bridge that has exited would cost the next host a request to learn so.
  yield* Effect.addFinalizer(() =>
    Effect.flatMap(isListed, (listed) => (listed ? Effect.ignore(fs.remove(file)) : Effect.void))
  )
  const idleMillis = Duration.toMillis(options.idleTimeout ?? "10 minutes")
  yield* Effect.repeat(
    Effect.gen(function* () {
      const { turns, lastActiveAt } = yield* Ref.get(activity)
      const now = yield* Clock.currentTimeMillis
      return turns === 0 && (now - lastActiveAt >= idleMillis || !(yield* isListed))
    }),
    { until: (done) => done, schedule: Schedule.spaced("1 second") }
  )
})

/**
 * Handles `Bridge.Rpcs` for `driver`'s sessions, over whichever transport serves them, recording in
 * `activity` the turns they run and when a host was last active.
 *
 * **Details**
 *
 * `serve` provides it to an `RpcServer` over a WebSocket; a test, or a bridge with a transport of
 * its own, provides it to another.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerHandlers = (driver: Bridge.Driver, options: HandlerOptions) =>
  Bridge.Rpcs.toLayer(makeHandlers(driver, options))

/**
 * What the host that launched the bridge gave it on standard input, as one line of JSON. The bridge
 * reads no further, since a sandbox may never end a process's standard input, as Daytona does not.
 *
 * @category constructors
 * @since 0.1.0
 */
export const readLaunchOptions = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const line = yield* stdio.stdin.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead)
  return yield* Schema.decodeEffect(Schema.fromJsonString(Bridge.LaunchOptions))(Option.getOrElse(line, () => ""))
})

/**
 * How a turn ended: by itself, failing, or aborted, by a host or by its session or the bridge
 * ending.
 */
const TurnEnd = Schema.TaggedUnion({
  Finished: {},
  Failed: { error: HarnessError.HarnessError },
  Aborted: {}
})

type TurnEnd = typeof TurnEnd.Type

/** A line of a turn's file: one of its parts, or, last, how it ended. */
const TurnLine = Schema.Union([Bridge.NumberedPart, Schema.Struct({ end: TurnEnd })])

const TurnLineJson = Schema.fromJsonString(Schema.toCodecJson(TurnLine))

/** How far a turn has got: how many parts it has, and how it ended once it has. */
interface Progress {
  readonly count: number
  readonly end?: TurnEnd
}

interface Turn {
  readonly id: Bridge.TurnId

  /** The turn's parts so far, each at the place before its number. Only the turn appends to it. */
  readonly parts: Array<Bridge.NumberedPart>

  /** Changes after each part and when the turn ends, for its readers to follow. */
  readonly progress: SubscriptionRef.SubscriptionRef<Progress>
}

/** A session the bridge started. Its turn and fiber change only while the bridge's lock is held. */
interface StartedSession {
  readonly driverSession: Bridge.DriverSession

  /** Closes when the session ends, interrupting its turn. */
  readonly scope: Scope.Closeable

  /** The session's latest turn. */
  turn: Turn | undefined

  /** The fiber running `turn`; none for a turn read from its file. */
  fiber: Fiber.Fiber<void> | undefined
}

/** How the bridge starts a turn that a host asks it to start. */
type TurnStart = Data.TaggedEnum<{
  /** Not again: the bridge started the turn and did not abort it. */
  Started: { readonly turn: Turn }

  /** By prompting the agent to continue the turn, keeping the parts of the steps it finished. */
  Continue: { readonly parts: ReadonlyArray<Bridge.NumberedPart> }

  /** From its prompt, as a turn the bridge does not have. */
  New: {}
}>

const TurnStart = Data.taggedEnum<TurnStart>()

const isStarted = TurnStart.$is("Started")
const isContinue = TurnStart.$is("Continue")

/** What the bridge prompts an agent with to continue a turn it aborted. */
const continuePrompt = Prompt.makeMessage("user", {
  content: [Prompt.makePart("text", { text: "Continue." })]
})

const makeHandlers = Effect.fnUntraced(function* (driver: Bridge.Driver, options: HandlerOptions) {
  const { stateDirectory, bridge } = options
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const activity =
    options.activity ?? (yield* Ref.make<Activity>({ turns: 0, lastActiveAt: yield* Clock.currentTimeMillis }))

  /** Records that a host or a turn was active now, as the bridge runs `change` more turns. */
  const recordActivity = (change: number) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Ref.update(activity, ({ turns }) => ({ turns: turns + change, lastActiveAt: now }))
    )
  /** The handlers' scope, which every session's is forked from, so that sessions end with it. */
  const bridgeScope = yield* Effect.scope
  const sessions = new Map<Agent.SessionId, StartedSession>()
  /**
   * Held while a session starts or ends, and while it starts or aborts a turn, so that none of
   * these sees another half done.
   */
  const lock = yield* Semaphore.make(1)

  const harnessError = (reason: HarnessError.HarnessErrorReason, cause?: unknown) =>
    new HarnessError.HarnessError({ agent: driver.id, reason, cause })

  /** The error for a failure of the bridge itself, such as one writing a turn's file. */
  const bridgeFailure = (cause: unknown) =>
    harnessError(
      new HarnessError.UnknownError({
        description: `The bridge failed: ${cause instanceof Error ? cause.message : "a defect"}`
      }),
      cause
    )

  const sessionDirectory = (id: Agent.SessionId) => path.join(stateDirectory, id)

  const turnFile = (id: Agent.SessionId, turn: Bridge.TurnId) => path.join(sessionDirectory(id), `${turn}.jsonl`)

  const appendLine = (file: string, line: typeof TurnLine.Type) =>
    Effect.flatMap(Schema.encodeEffect(TurnLineJson)(line), (json) =>
      fs.writeFileString(file, `${json}\n`, { flag: "a" })
    )

  /** The session `id`, which the bridge must have started. */
  const startedSession = (id: Agent.SessionId) =>
    Effect.suspend(() => {
      const started = sessions.get(id)
      return started === undefined
        ? Effect.fail(
            harnessError(
              new HarnessError.NotFoundError({
                description: `The bridge has not started the session ${id}`
              })
            )
          )
        : Effect.succeed(started)
    })

  /** Creates a session in a scope of its own, closed again if the driver fails to create it. */
  const createSession = Effect.fnUntraced(function* (options: Bridge.CreateSessionOptions) {
    const scope = yield* Scope.fork(bridgeScope)
    const driverSession = yield* driver.createSession(options).pipe(
      Scope.provide(scope),
      Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause)))
    )
    const started: StartedSession = { driverSession, scope, turn: undefined, fiber: undefined }
    sessions.set(options.id, started)
    return started
  })

  /** Ends a session the bridge started, interrupting its turn. */
  const endSession = (id: Agent.SessionId, started: StartedSession) =>
    Effect.andThen(
      Scope.close(started.scope, Exit.void),
      Effect.sync(() => sessions.delete(id))
    )

  /** Aborts the session's running turn, returning once the turn has ended. */
  const abortTurn = (started: StartedSession) =>
    started.fiber === undefined ? Effect.void : Fiber.interrupt(started.fiber)

  /**
   * Runs `turn` to its end, keeping each part as it streams, then how the turn ended. The bridge
   * counts it among its turns until it ends, and only then do its readers learn how it ended, so
   * that a host that read the end finds the bridge no longer running it.
   */
  const runTurn = (driverSession: Bridge.DriverSession, turn: Turn, options: Bridge.TurnOptions, file: string) =>
    Effect.acquireUseRelease(
      recordActivity(1),
      () =>
        driverSession.promptTurn(options).pipe(
          Stream.runForEach((part) => {
            const numbered: Bridge.NumberedPart = { seq: turn.parts.length + 1, part }
            return appendLine(file, numbered).pipe(
              Effect.andThen(Effect.sync(() => turn.parts.push(numbered))),
              Effect.andThen(SubscriptionRef.set(turn.progress, { count: numbered.seq }))
            )
          })
        ),
      (_, exit) => {
        const end = endOf(exit, bridgeFailure)
        // Should this fail, the file has no end, so a bridge started again treats the turn as lost.
        return Effect.ignore(appendLine(file, { end })).pipe(
          Effect.andThen(recordActivity(-1)),
          Effect.andThen(SubscriptionRef.set(turn.progress, { count: turn.parts.length, end }))
        )
      }
    ).pipe(
      // How the turn ended, failure included, is kept for its readers.
      Effect.ignore
    )

  /**
   * The turn `id` kept in `file`, if the bridge has its file. A turn the bridge was running when it
   * died has no end there, and ended then, aborted.
   */
  const readTurnFile = (id: Bridge.TurnId, file: string) =>
    Effect.gen(function* () {
      const text = yield* fs.readFileString(file)
      const lines = yield* Effect.forEach(
        text.split("\n").filter((line) => line.length > 0),
        (line) => Schema.decodeEffect(TurnLineJson)(line)
      )
      const last = lines.at(-1)
      const parts = lines.filter((line) => "seq" in line)
      const progress = yield* SubscriptionRef.make<Progress>({
        count: parts.length,
        end: last !== undefined && "end" in last ? last.end : TurnEnd.cases.Aborted.make({})
      })
      const turn: Turn = { id, parts, progress }
      return turn
    }).pipe(Effect.orElseSucceed(() => undefined))

  /**
   * How the bridge starts the session's turn `id` when a host asks it to, from the turn as the
   * bridge has it, in memory or else in the turn's file. A turn it aborted, as it aborts the turns
   * it runs when it exits or dies, continues in a conversation the agent kept, which holds it.
   */
  const turnStartOf = Effect.fnUntraced(function* (
    session: Agent.SessionId,
    started: StartedSession,
    id: Bridge.TurnId
  ) {
    const previous = started.turn?.id === id ? started.turn : yield* readTurnFile(id, turnFile(session, id))
    if (previous === undefined) return TurnStart.New()
    const { end } = yield* SubscriptionRef.get(previous.progress)
    if (end === undefined || !TurnEnd.isAnyOf(["Aborted"])(end)) return TurnStart.Started({ turn: previous })
    return started.driverSession.keptConversation
      ? TurnStart.Continue({ parts: finishedStepsOf(previous.parts) })
      : TurnStart.New()
  })

  return Bridge.Rpcs.of({
    Hello: () => Effect.succeed({ agent: driver.id, bridge }),

    StartSession: ({ session, directory, history, agentState, unfinishedTurn }) =>
      Semaphore.withPermit(
        lock,
        Effect.gen(function* () {
          // A host connecting starts its session again, whether the bridge has it or not.
          yield* recordActivity(0)
          const started =
            sessions.get(session) ?? (yield* createSession({ id: session, directory, history, agentState }))
          const state = yield* started.driverSession.state
          if (unfinishedTurn === undefined) return { hasUnfinishedTurn: false, agentState: state }
          const turnStart = yield* turnStartOf(session, started, unfinishedTurn)
          // A bridge started again has a turn that ended before it exited only in the turn's file.
          if (isStarted(turnStart)) started.turn = turnStart.turn
          return { hasUnfinishedTurn: !TurnStart.$is("New")(turnStart), agentState: state }
        })
      ),

    StartTurn: ({ session, turn: id, options }) =>
      Semaphore.withPermit(
        lock,
        Effect.gen(function* () {
          const started = yield* startedSession(session)
          const turnStart = yield* turnStartOf(session, started, id)
          if (isStarted(turnStart)) {
            started.turn = turnStart.turn
            return
          }
          // The host asking for another turn has moved on from the one running, as when the host
          // that started it is gone, so the bridge aborts it rather than refuse the new turn.
          if (started.turn !== undefined && (yield* SubscriptionRef.get(started.turn.progress)).end === undefined) {
            yield* abortTurn(started)
          }
          // A session keeps only its latest turn; a turn it continues keeps the steps it finished.
          const kept = isContinue(turnStart) ? turnStart.parts : []
          const directory = sessionDirectory(session)
          const file = turnFile(session, id)
          yield* fs.remove(directory, { recursive: true, force: true })
          yield* fs.makeDirectory(directory, { recursive: true })
          yield* Effect.forEach(kept, (part) => appendLine(file, part), { discard: true })
          const turn: Turn = {
            id,
            parts: [...kept],
            progress: yield* SubscriptionRef.make<Progress>({ count: kept.length })
          }
          const turnOptions = isContinue(turnStart) ? { ...options, prompt: continuePrompt } : options
          const fiber = yield* Effect.forkIn(runTurn(started.driverSession, turn, turnOptions, file), started.scope)
          started.turn = turn
          started.fiber = fiber
        }).pipe(Effect.catchTag(["PlatformError", "SchemaError"], (error) => Effect.fail(bridgeFailure(error))))
      ),

    ReadTurn: ({ session, turn: id, after }) =>
      Stream.unwrap(
        Effect.map(startedSession(session), ({ turn }) =>
          turn?.id === id
            ? readTurn(turn, after)
            : Stream.fail(harnessError(new HarnessError.NoTurnError({ description: `The session has no turn ${id}` })))
        )
      ),

    AbortTurn: ({ session, turn }) =>
      Semaphore.withPermit(
        lock,
        Effect.flatMap(startedSession(session), (started) =>
          started.turn?.id === turn ? abortTurn(started) : Effect.void
        )
      ),

    SubmitToolResult: ({ session, result }) =>
      Effect.flatMap(startedSession(session), ({ driverSession }) => driverSession.submitToolResult(result)),

    Approve: ({ session, response }) =>
      Effect.flatMap(startedSession(session), ({ driverSession }) => driverSession.approve(response)),

    Compact: ({ session, instructions }) =>
      Effect.flatMap(startedSession(session), ({ driverSession }) => driverSession.compact(instructions)),

    ReadState: ({ session }) => Effect.flatMap(startedSession(session), ({ driverSession }) => driverSession.state),

    StopSession: ({ session }) =>
      Semaphore.withPermit(
        lock,
        Effect.gen(function* () {
          const started = yield* startedSession(session)
          yield* abortTurn(started)
          const state = yield* started.driverSession.state
          yield* endSession(session, started)
          return state
        })
      ),

    DestroySession: ({ session }) =>
      Semaphore.withPermit(
        lock,
        Effect.gen(function* () {
          const started = yield* startedSession(session)
          yield* abortTurn(started)
          yield* started.driverSession.destroy
          yield* endSession(session, started)
          yield* fs
            .remove(sessionDirectory(session), { recursive: true, force: true })
            .pipe(Effect.mapError(bridgeFailure))
        })
      )
  })
})

/**
 * Streams `turn`'s parts numbered after `after`, then each new one, until its last. A turn that
 * failed fails the stream after its parts.
 */
const readTurn = (turn: Turn, after: number): Stream.Stream<Bridge.NumberedPart, HarnessError.HarnessError> =>
  SubscriptionRef.changes(turn.progress).pipe(
    Stream.takeUntil((progress) => progress.end !== undefined),
    Stream.mapAccum(
      () => after,
      (read, { count }) => [Math.max(read, count), turn.parts.slice(read, count)] as const
    ),
    Stream.concat(
      Stream.unwrap(
        Effect.map(SubscriptionRef.get(turn.progress), ({ end }) =>
          end !== undefined && TurnEnd.isAnyOf(["Failed"])(end) ? Stream.fail(end.error) : Stream.empty
        )
      )
    )
  )

/** The parts of the steps a turn finished: those up to its last `finish-step`. */
const finishedStepsOf = (parts: ReadonlyArray<Bridge.NumberedPart>) =>
  parts.slice(0, parts.findLastIndex(({ part }) => part.type === "finish-step") + 1)

const isHarnessError = Schema.is(HarnessError.HarnessError)

/**
 * How a turn whose run exited with `exit` ended. `bridgeFailure` gives the error for any failure
 * that is not the agent's, such as the bridge failing to keep a part.
 */
const endOf = (
  exit: Exit.Exit<void, unknown>,
  bridgeFailure: (cause: unknown) => HarnessError.HarnessError
): TurnEnd => {
  if (Exit.isSuccess(exit)) return TurnEnd.cases.Finished.make({})
  if (Cause.hasInterruptsOnly(exit.cause)) return TurnEnd.cases.Aborted.make({})
  const error = Cause.findError(exit.cause)
  const cause = Result.isSuccess(error) ? error.success : Cause.squash(exit.cause)
  return TurnEnd.cases.Failed.make({
    error: isHarnessError(cause) ? cause : bridgeFailure(cause)
  })
}

/** What `file` says a bridge listens on, or nothing when it is missing or unreadable. */
const readListening = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(file)
    return yield* Schema.decodeEffect(Schema.fromJsonString(Bridge.Listening))(text)
  }).pipe(Effect.orElseSucceed(() => undefined))

/**
 * Writes `listening` to `file` whole, through a file of its own beside it, so that a host never
 * reads it half written. Another bridge of the same id writing at once leaves one of them listed.
 */
const writeListening = (file: string, listening: Bridge.Listening) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const text = yield* Schema.encodeEffect(Schema.fromJsonString(Bridge.Listening))(listening)
    const written = `${file}.${listening.port}`
    yield* fs.makeDirectory(path.dirname(file), { recursive: true })
    yield* fs.writeFileString(written, text)
    yield* fs.rename(written, file)
  })

/**
 * Serves the protocol over WebSockets at `/`, opened only by a host that presents `token` as
 * `Authorization: Bearer <token>`.
 */
const layerProtocol = (token: Redacted.Redacted<string>) =>
  Layer.effect(RpcServer.Protocol)(
    Effect.gen(function* () {
      const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket
      const router = yield* HttpRouter.HttpRouter
      const expected = `Bearer ${Redacted.value(token)}`
      yield* router.add("GET", "/", (request) =>
        isPresented(request.headers.authorization, expected)
          ? httpEffect
          : Effect.succeed(HttpServerResponse.empty({ status: 401 }))
      )
      return protocol
    })
  )
