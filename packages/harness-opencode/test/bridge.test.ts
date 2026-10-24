import { Harness, type StreamPart } from "@amends-dev/harness"
import { SessionId } from "@amends-dev/harness/Agent"
import { type Sandbox, Template } from "@amends-dev/sandbox"
import { BunServices, BunSocket } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Option, Path, Redacted, Schedule, Schema, Stream } from "effect"
import { Prompt } from "effect/ai"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { isRunning, makeBridgedAgent, makeProxy, makeSandbox } from "./fixtures.ts"

/**
 * The bridge client launches `fake-bridge.ts`, a bridge over a stand-in agent, in a sandbox on this
 * machine, and reaches it over a WebSocket, as a host reaches an agent's bridge.
 */
const TestLayer = Layer.merge(BunServices.layer, BunSocket.layerWebSocketConstructor)

const id = SessionId.make("session-1")

/** The parts of a turn the stand-in agent answers `text` in. */
const answer = (text: string): ReadonlyArray<StreamPart.StreamPart> => [
  { type: "text-start", id: "answer" },
  { type: "text-delta", id: "answer", delta: text },
  { type: "text-end", id: "answer" },
  { type: "finish-step", reason: "stop", usage: { inputTokens: {}, outputTokens: {} } },
  { type: "finish", reason: "stop", usage: { inputTokens: {}, outputTokens: {} } }
]

/** The parts of a turn prompted to answer `text`: its start, then the answer. */
const prompted = (text: string) => [expect.objectContaining({ type: "turn-start" }), ...answer(text)]

/** A session state with the turn `prompt` unfinished, from its start `start`, nothing else run. */
const resumeFromStart = (prompt: string, start: StreamPart.TurnStartPart) => ({
  id,
  agent: "fake",
  history: Prompt.empty,
  unfinishedTurn: {
    prompt: Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: prompt })] }),
    responseFormat: { type: "text" } as const,
    steps: [],
    agentState: start.agentState
  }
})

/**
 * The fake bridge's template at `version`, which installs the bridge in the sandbox's working
 * directory as `bridge-<version>.ts`, a program that runs `fake-bridge.ts`.
 */
const templateOf = (version: string): Template.Template => ({
  name: Template.TemplateName.make("fake-bridge"),
  identity: version,
  prepare: Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const program = `import "${import.meta.dirname}/fake-bridge.ts";`
    yield* spawner.exitCode(
      ChildProcess.make("sh", ["-c", 'printf "%s\n" "$1" > "$2"', "sh", program, `bridge-${version}.ts`])
    )
  })
})

const secretOfHosts = "the hosts' secret"

/**
 * A harness over the fake bridge at `version`, whose agent greets with `greeting`, run by a host
 * that derives tokens from `secret`. Its bridge exits after `idleSeconds` without a host, if given.
 */
const makeHarness = ({
  secret = secretOfHosts,
  version = "1",
  greeting = "hello",
  idleSeconds
}: { secret?: string; version?: string; greeting?: string; idleSeconds?: number } = {}) =>
  Effect.map(
    makeBridgedAgent({
      id: "fake",
      template: templateOf(version),
      command: process.execPath,
      args: [`bridge-${version}.ts`],
      token: (sandboxId) => Redacted.make(`${secret}/${sandboxId}`),
      agentOptions: { greeting, ...(idleSeconds === undefined ? {} : { idleSeconds }) }
    }),
    Harness.make
  )

/** A sandbox, and a harness over the fake bridge there. */
const makeSetup = Effect.gen(function* () {
  const sandbox = yield* makeSandbox()
  return { sandbox, harness: yield* makeHarness() }
})

/** The lines of `file` in the sandbox's working directory, as JSON. */
const linesOf = (sandbox: Sandbox.Sandbox["Service"], file: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const text = yield* sandbox.fileSystem.readFileString(path.join(sandbox.workingDirectory, file))
    return text
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line))
  })

/** The process ids of the bridges launched in the sandbox, in the order they launched. */
const launchedPids = (sandbox: Sandbox.Sandbox["Service"]) =>
  Effect.flatMap(linesOf(sandbox, "launches.jsonl"), (launches) =>
    Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ pid: Schema.Int })))(launches)
  ).pipe(Effect.map((launches) => launches.map(({ pid }) => pid)))

/** Waits until the process `pid` has exited, for up to 10 seconds. */
const awaitExit = (pid: number) =>
  Effect.repeat(isRunning(pid), {
    while: (running) => running,
    schedule: Schedule.spaced("50 millis")
  }).pipe(Effect.timeout("10 seconds"))

/** Kills the bridge launched last in the sandbox, as when it crashes, once it has exited. */
const killBridge = (sandbox: Sandbox.Sandbox["Service"]) =>
  Effect.gen(function* () {
    const pid = (yield* launchedPids(sandbox)).at(-1) ?? 0
    process.kill(pid, "SIGKILL")
    yield* awaitExit(pid)
  })

/** Where each bridge of the fake agent in the sandbox says it listens: its file, and the port. */
const listeningOf = (sandbox: Sandbox.Sandbox["Service"]) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const root = path.join(sandbox.workingDirectory, ".bridge", "fake")
    const bridges = yield* sandbox.fileSystem.readDirectory(root)
    const listed = yield* Effect.forEach(bridges, (bridge) => {
      const file = path.join(root, bridge, "listening.json")
      return sandbox.fileSystem.readFileString(file).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ port: Schema.Int })))),
        Effect.map(({ port }) => ({ file, port })),
        Effect.option
      )
    })
    return listed.flatMap((option) => (Option.isSome(option) ? [option.value] : []))
  })

/** Whether a WebSocket to `port` on this machine, presenting `token`, opens. */
const opens = (port: number, token: string) =>
  Effect.callback<boolean>((resume) => {
    let answered = false
    const answer = (opened: boolean) => {
      if (answered) return
      answered = true
      resume(Effect.succeed(opened))
    }
    const webSocket = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { authorization: `Bearer ${token}` }
    })
    webSocket.onopen = () => {
      answer(true)
      webSocket.close()
    }
    webSocket.onerror = () => answer(false)
    webSocket.onclose = () => answer(false)
  })

/** Lets the stand-in agent finish a `wait` turn of the session `id`. */
const release = (sandbox: Sandbox.Sandbox["Service"]) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    yield* sandbox.fileSystem.writeFileString(path.join(sandbox.workingDirectory, id, "release"), "")
  })

/**
 * Reads `turn` in the background, returning the collecting fiber once it read a part `reached`
 * accepts.
 */
const readUntil = <E, R>(
  turn: Stream.Stream<StreamPart.StreamPart, E, R>,
  reached: (part: StreamPart.StreamPart) => boolean
) =>
  Effect.gen(function* () {
    const read = yield* Deferred.make<void>()
    const reading = yield* turn.pipe(
      Stream.tap((part) => (reached(part) ? Deferred.succeed(read, undefined) : Effect.void)),
      Stream.runCollect,
      Effect.forkChild
    )
    yield* Deferred.await(read)
    return reading
  })

/**
 * Reads `turn` in the background, returning its start and the collecting fiber once it read the
 * agent's first part.
 */
const readFromFirstPart = <E, R>(turn: Stream.Stream<StreamPart.StreamPart, E, R>) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<StreamPart.TurnStartPart>()
    const reading = yield* readUntil(
      Stream.tap(turn, (part) => (part.type === "turn-start" ? Deferred.succeed(started, part) : Effect.void)),
      (part) => part.type !== "turn-start"
    )
    return { reading, start: yield* Deferred.await(started) }
  })

describe("BridgeClient", () => {
  describe("over a bridge it launches", () => {
    it.live("launches the bridge with its options on standard input, and runs a turn there", () =>
      Effect.gen(function* () {
        const { sandbox, harness } = yield* makeSetup
        const session = yield* harness.createSession({ sandbox, id })

        const parts = yield* Stream.runCollect(session.stream({ prompt: "reply hello" }))

        expect(parts).toEqual(prompted("hello"))
        // The turn starts with what `suspendTurn` would return: the state and the turn's bridge.
        expect(parts[0]).toEqual({
          type: "turn-start",
          agentState: {
            agentState: { turns: 1 },
            unfinishedTurn: { turn: expect.any(String), bridge: expect.any(String) }
          }
        })
        expect(yield* linesOf(sandbox, "launches.jsonl")).toEqual([
          {
            pid: expect.any(Number),
            agentOptions: { greeting: "hello" },
            tokenInEnvironment: false
          }
        ])
      }).pipe(Effect.provide(TestLayer))
    )

    it.live("installs its bridge before it launches it, in a sandbox prepared for another", () =>
      Effect.gen(function* () {
        const sandbox = yield* makeSandbox(templateOf("1"))
        const harness = yield* makeHarness({ version: "2" })

        const session = yield* harness.createSession({ sandbox, id })
        const parts = yield* Stream.runCollect(session.stream({ prompt: "reply hello" }))

        expect(parts).toEqual(prompted("hello"))
      }).pipe(Effect.provide(TestLayer))
    )

    it.live("connects to the bridge another host launched with the same options", () =>
      Effect.gen(function* () {
        const { sandbox, harness } = yield* makeSetup
        yield* harness.createSession({ sandbox, id })
        const otherHarness = yield* makeHarness()

        const session = yield* otherHarness.createSession({
          sandbox,
          id: SessionId.make("session-2")
        })
        const parts = yield* Stream.runCollect(session.stream({ prompt: "reply again" }))

        expect(parts).toEqual(prompted("again"))
        expect(yield* linesOf(sandbox, "launches.jsonl")).toHaveLength(1)
      }).pipe(Effect.provide(TestLayer))
    )

    it.live("runs a bridge of its own for a host with other options, or another secret", () =>
      Effect.gen(function* () {
        const { sandbox, harness } = yield* makeSetup
        const greet = (made: Harness.Harness["Service"], session: string) =>
          Effect.flatMap(made.createSession({ sandbox, id: SessionId.make(session) }), (started) =>
            Stream.runCollect(started.stream({ prompt: "greet" }))
          )

        const greetings = [
          yield* greet(harness, "session-1"),
          yield* greet(yield* makeHarness({ greeting: "hi" }), "session-2"),
          yield* greet(yield* makeHarness({ secret: "another secret" }), "session-3")
        ]

        expect(greetings).toEqual([prompted("hello"), prompted("hi"), prompted("hello")])
        expect(yield* linesOf(sandbox, "launches.jsonl")).toHaveLength(3)
        expect(yield* listeningOf(sandbox)).toHaveLength(3)
      }).pipe(Effect.provide(TestLayer))
    )

    it.live("refuses a connection that presents another token", () =>
      Effect.gen(function* () {
        const { sandbox, harness } = yield* makeSetup
        yield* harness.createSession({ sandbox, id })
        const [listening] = yield* listeningOf(sandbox)
        const port = listening?.port ?? 0

        expect(yield* opens(port, "another token")).toBe(false)
        expect(yield* opens(port, `${secretOfHosts}/${sandbox.id}`)).toBe(true)
      }).pipe(Effect.provide(TestLayer))
    )

    it.live("leaves a suspended turn running in the bridge, for another host to continue", () =>
      Effect.gen(function* () {
        const { sandbox, harness } = yield* makeSetup
        const session = yield* harness.createSession({ sandbox, id })
        const { reading } = yield* readFromFirstPart(session.stream({ prompt: "wait later" }))

        const state = yield* session.suspendTurn
        yield* Fiber.join(reading)
        yield* release(sandbox)
        const otherHarness = yield* makeHarness()
        const resumed = yield* otherHarness.createSession({ sandbox, resumeFrom: state })
        const parts = yield* Stream.runCollect(resumed.continueStream({}))

        expect(parts).toEqual(answer("later"))
      }).pipe(Effect.provide(TestLayer))
    )

    it.live("continues a turn from its start, for a host that is gone without suspending it", () =>
      Effect.gen(function* () {
        const { sandbox, harness } = yield* makeSetup
        const session = yield* harness.createSession({ sandbox, id })
        const { reading, start } = yield* readFromFirstPart(session.stream({ prompt: "wait later" }))

        // The host that ran the turn is gone, as when it crashed: it neither suspended the turn
        // nor aborted it, as this one reads on.
        const otherHarness = yield* makeHarness()
        const resumed = yield* otherHarness.createSession({
          sandbox,
          resumeFrom: resumeFromStart("wait later", start)
        })
        yield* release(sandbox)
        const parts = yield* Stream.runCollect(resumed.continueStream({}))

        expect(parts).toEqual(answer("later"))
        expect(yield* Fiber.join(reading)).toEqual(prompted("later"))
        expect(yield* linesOf(sandbox, "launches.jsonl")).toHaveLength(1)
      }).pipe(Effect.provide(TestLayer))
    )

    it.live(
      "continues a suspended turn in the bridge that runs it, for a host with other options, then goes on in its own",
      () =>
        Effect.gen(function* () {
          const { sandbox, harness } = yield* makeSetup
          const session = yield* harness.createSession({ sandbox, id })
          const { reading } = yield* readFromFirstPart(session.stream({ prompt: "wait later" }))

          const state = yield* session.suspendTurn
          yield* Fiber.join(reading)
          yield* release(sandbox)
          const otherHarness = yield* makeHarness({ greeting: "hi" })
          const resumed = yield* otherHarness.createSession({ sandbox, resumeFrom: state })
          const continued = yield* Stream.runCollect(resumed.continueStream({}))
          const next = yield* Stream.runCollect(resumed.stream({ prompt: "greet" }))
          const { agentState } = yield* resumed.detach

          expect(continued).toEqual(answer("later"))
          expect(next).toEqual(prompted("hi"))
          // The session's own bridge starts it from the state the other gave, of its first turn.
          expect(agentState).toEqual({ agentState: { turns: 2 } })
          expect(yield* linesOf(sandbox, "launches.jsonl")).toHaveLength(2)
        }).pipe(Effect.provide(TestLayer))
    )

    it.live("continues a suspended turn its bridge lost when it died, in the agent's conversation", () =>
      Effect.gen(function* () {
        const { sandbox, harness } = yield* makeSetup
        const session = yield* harness.createSession({ sandbox, id })
        const { reading } = yield* readFromFirstPart(session.stream({ prompt: "wait forever" }))

        const state = yield* session.suspendTurn
        yield* Fiber.join(reading)
        yield* killBridge(sandbox)
        const otherHarness = yield* makeHarness()
        const resumed = yield* otherHarness.createSession({ sandbox, resumeFrom: state })
        const parts = yield* Stream.runCollect(resumed.continueStream({}))
        const { history } = yield* resumed.detach

        // The agent continues the turn rather than run its prompt again, which would wait forever.
        expect(parts).toEqual(answer("Continue."))
        expect(history.content.map((message) => message.role)).toEqual(["user", "assistant"])
        expect(yield* linesOf(sandbox, "launches.jsonl")).toHaveLength(2)
      }).pipe(Effect.provide(TestLayer))
    )

    it.live("runs a suspended turn again in its own bridge, when the bridge that ran it is gone", () =>
      Effect.gen(function* () {
        const { sandbox, harness } = yield* makeSetup
        const session = yield* harness.createSession({ sandbox, id })
        const { reading } = yield* readFromFirstPart(session.stream({ prompt: "wait again" }))

        const state = yield* session.suspendTurn
        yield* Fiber.join(reading)
        yield* killBridge(sandbox)
        yield* release(sandbox)
        const otherHarness = yield* makeHarness({ greeting: "hi" })
        const resumed = yield* otherHarness.createSession({ sandbox, resumeFrom: state })
        const parts = yield* Stream.runCollect(resumed.continueStream({}))

        // Run again from its prompt, rather than continued, which would answer "Continue.".
        expect(parts).toEqual(prompted("again"))
      }).pipe(Effect.provide(TestLayer))
    )

    it.live("aborts a turn whose stream the caller ends", () =>
      Effect.gen(function* () {
        const { sandbox, harness } = yield* makeSetup
        const session = yield* harness.createSession({ sandbox, id })

        yield* session.stream({ prompt: "wait forever" }).pipe(Stream.take(1), Stream.runDrain)
        // The bridge runs one turn of a session at a time, so this one starts only once the first
        // was aborted.
        const parts = yield* Stream.runCollect(session.stream({ prompt: "reply next" }))

        expect(parts).toEqual(prompted("next"))
      }).pipe(Effect.provide(TestLayer))
    )

    it.live("reads on after the connection drops, from the last part read", () =>
      Effect.gen(function* () {
        const { sandbox, harness } = yield* makeSetup
        /** The port of the bridge, which the proxy forwards to once an endpoint names it. */
        let upstream = 0
        const proxy = yield* makeProxy(() => upstream)
        const throughProxy: Sandbox.Sandbox["Service"] = {
          ...sandbox,
          endpoint: (port) =>
            Effect.sync(() => {
              upstream = port
              return { url: `ws://127.0.0.1:${proxy.port}`, headers: {} }
            })
        }
        const session = yield* harness.createSession({ sandbox: throughProxy, id })
        const { reading } = yield* readFromFirstPart(session.stream({ prompt: "wait across" }))

        yield* proxy.drop
        yield* release(sandbox)
        const parts = yield* Fiber.join(reading)

        expect(parts).toEqual(prompted("across"))
      }).pipe(Effect.provide(TestLayer))
    )

    it.live("starts the session again, from its latest state, in the bridge launched after its own died", () =>
      Effect.gen(function* () {
        const { sandbox, harness } = yield* makeSetup
        const session = yield* harness.createSession({ sandbox, id })
        yield* Stream.runDrain(session.stream({ prompt: "reply first" }))

        yield* killBridge(sandbox)
        const parts = yield* Stream.runCollect(session.stream({ prompt: "reply second" }))
        const state = yield* session.stop

        expect(parts).toEqual(prompted("second"))
        expect(state.agentState).toEqual({ agentState: { turns: 2 } })
        expect(yield* linesOf(sandbox, "launches.jsonl")).toHaveLength(2)
      }).pipe(Effect.provide(TestLayer))
    )

    it.live(
      "continues a turn its bridge lost when it died, after the steps read, in the bridge launched after it",
      () =>
        Effect.gen(function* () {
          const { sandbox, harness } = yield* makeSetup
          const session = yield* harness.createSession({ sandbox, id })
          let finishedSteps = 0
          const reading = yield* readUntil(session.stream({ prompt: "steps first" }), (part) => {
            if (part.type === "finish-step") finishedSteps += 1
            return finishedSteps === 1 && part.type === "text-start"
          })

          yield* killBridge(sandbox)
          const parts = yield* Fiber.join(reading)
          const next = yield* Stream.runCollect(session.stream({ prompt: "reply next" }))

          // The bridge continues the turn after the step it kept, which the stream has, and the
          // step cut short starts over.
          expect(parts).toEqual([
            expect.objectContaining({ type: "turn-start" }),
            ...answer("first").slice(0, 4),
            { type: "text-start", id: "answer" },
            ...answer("Continue.")
          ])
          expect(next).toEqual(prompted("next"))
          expect(yield* linesOf(sandbox, "launches.jsonl")).toHaveLength(2)
        }).pipe(Effect.provide(TestLayer))
    )

    it.live("releases the session with the state its bridge last gave when its sandbox is gone", () =>
      Effect.gen(function* () {
        const { sandbox, harness } = yield* makeSetup
        const session = yield* harness.createSession({ sandbox, id })
        yield* Stream.runDrain(session.stream({ prompt: "reply first" }))

        yield* sandbox.destroy
        const state = yield* session.detach

        expect(state.agentState).toEqual({ agentState: { turns: 1 } })
      }).pipe(Effect.provide(TestLayer))
    )

    it.live("destroys a session it stopped, starting it again in the bridge to do so", () =>
      Effect.gen(function* () {
        const { sandbox, harness } = yield* makeSetup
        const path = yield* Path.Path
        const session = yield* harness.createSession({ sandbox, id })

        yield* session.stop
        yield* session.destroy

        expect(yield* sandbox.fileSystem.exists(path.join(sandbox.workingDirectory, `destroyed-${id}`))).toBe(true)
      }).pipe(Effect.provide(TestLayer))
    )
  })

  describe("over a bridge that exits", () => {
    it.live("exits once idle, removing where it listens, and is launched again for the next turn", () =>
      Effect.gen(function* () {
        const sandbox = yield* makeSandbox()
        const harness = yield* makeHarness({ idleSeconds: 1 })
        const session = yield* harness.createSession({ sandbox, id })
        yield* Stream.runDrain(session.stream({ prompt: "reply first" }))

        const [pid = 0] = yield* launchedPids(sandbox)
        yield* awaitExit(pid)
        const listedOnceIdle = yield* listeningOf(sandbox)
        const parts = yield* Stream.runCollect(session.stream({ prompt: "reply second" }))
        const state = yield* session.detach

        expect(listedOnceIdle).toEqual([])
        expect(parts).toEqual(prompted("second"))
        expect(state.agentState).toEqual({ agentState: { turns: 2 } })
        expect(yield* launchedPids(sandbox)).toHaveLength(2)
      }).pipe(Effect.provide(TestLayer))
    )

    it.live("exits once another bridge of its id takes its place, leaving that one listed", () =>
      Effect.gen(function* () {
        const { sandbox, harness } = yield* makeSetup
        yield* harness.createSession({ sandbox, id })
        const [listening] = yield* listeningOf(sandbox)
        const file = listening?.file ?? ""

        yield* sandbox.fileSystem.writeFileString(file, JSON.stringify({ port: 1 }))
        const [pid = 0] = yield* launchedPids(sandbox)
        yield* awaitExit(pid)

        expect(yield* listeningOf(sandbox)).toEqual([{ file, port: 1 }])
      }).pipe(Effect.provide(TestLayer))
    )

    it.live("ends with one bridge when two hosts launch it at once, serving both", () =>
      Effect.gen(function* () {
        const sandbox = yield* makeSandbox()
        const harnesses = [yield* makeHarness(), yield* makeHarness()]
        const sessions = yield* Effect.forEach(
          harnesses,
          (harness, index) => harness.createSession({ sandbox, id: SessionId.make(`session-${index + 1}`) }),
          { concurrency: "unbounded" }
        )

        const first = yield* Effect.forEach(sessions, (session) =>
          Stream.runCollect(session.stream({ prompt: "reply first" }))
        )
        // The bridge the other took the place of exits once it runs no turn.
        const running = yield* Effect.filter(yield* launchedPids(sandbox), isRunning).pipe(
          Effect.repeat({ until: (running) => running.length <= 1, schedule: Schedule.spaced("50 millis") }),
          Effect.timeout("10 seconds")
        )
        const second = yield* Effect.forEach(sessions, (session) =>
          Stream.runCollect(session.stream({ prompt: "reply second" }))
        )

        expect(first).toEqual([prompted("first"), prompted("first")])
        expect(running).toHaveLength(1)
        expect(second).toEqual([prompted("second"), prompted("second")])
      }).pipe(Effect.provide(TestLayer))
    )
  })
})
