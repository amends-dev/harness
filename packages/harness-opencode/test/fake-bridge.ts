// A bridge over a stand-in driver, served as opencode's bridge program serves its driver, which
// `bridge.test.ts` has the bridge client launch, as the command that runs a bridge. A turn follows
// its prompt: `reply <text>` answers `text`, `wait <text>` starts to answer `text` and finishes
// once the session's directory has a file named `release`, `steps <text>` answers `text` in one
// step and then starts a second step that waits the same way, `greet` answers the `greeting` of
// the agent's options, and any other prompt, such as the bridge's `Continue.`, is answered with
// itself.
// A session's state counts the turns it has run, on from the state it started with, whose
// conversation the session keeps. Each launch adds a line to `launches.jsonl` in the bridge's
// working directory, with its process id, its agent's options, and whether its environment holds
// the token, and destroying a session writes `destroyed-<session>` there. The bridge exits after
// the agent options' `idleSeconds` without a host, 10 minutes when they give none.
import { type Bridge, BridgeServer, type StreamPart } from "@amends-dev/harness"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Option, Path, Ref, Schedule, Schema, Stream } from "effect"
import * as BunBridge from "../src/internal/bridge/bunBridge.ts"

/** A session's state: the turns it has run. */
const State = Schema.Struct({ turns: Schema.Int })

/** What the fake agent takes of its options. */
const AgentOptions = Schema.Struct({
  greeting: Schema.optional(Schema.String),
  idleSeconds: Schema.optional(Schema.Finite)
})

/** The parts of a turn that answers `text` in one step. */
const answer = (text: string): ReadonlyArray<StreamPart.StreamPart> => [
  { type: "text-start", id: "answer" },
  { type: "text-delta", id: "answer", delta: text },
  { type: "text-end", id: "answer" },
  { type: "finish-step", reason: "stop", usage: { inputTokens: {}, outputTokens: {} } },
  { type: "finish", reason: "stop", usage: { inputTokens: {}, outputTokens: {} } }
]

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const launch = yield* BridgeServer.readLaunchOptions
  const agentOptions = yield* Schema.decodeUnknownEffect(AgentOptions)(launch.agentOptions)
  yield* fs.writeFileString(
    "launches.jsonl",
    `${JSON.stringify({
      pid: process.pid,
      agentOptions: launch.agentOptions,
      tokenInEnvironment: Object.values(process.env).includes(launch.token)
    })}\n`,
    { flag: "a" }
  )

  const driver: Bridge.Driver = {
    id: "fake",
    createSession: (options) =>
      Effect.gen(function* () {
        const turns = yield* Ref.make(
          Option.match(Schema.decodeUnknownOption(State)(options.agentState), {
            onNone: () => 0,
            onSome: (state) => state.turns
          })
        )
        const session: Bridge.DriverSession = {
          keptConversation: options.agentState !== undefined,
          promptTurn: (turn) => {
            const text = turn.prompt.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
            const [command = "", ...words] = text.split(" ")
            const parts = answer(
              command === "reply" || command === "wait" || command === "steps"
                ? words.join(" ")
                : command === "greet"
                  ? (agentOptions.greeting ?? "")
                  : text
            )
            const released = fs.exists(path.join(options.directory, "release")).pipe(
              Effect.repeat({
                until: (exists) => exists,
                schedule: Schedule.spaced("20 millis")
              }),
              Effect.orDie
            )
            /** The first `count` parts, then, once released, the rest. */
            const releasedAfter = (count: number) =>
              Stream.concat(
                Stream.fromIterable(parts.slice(0, count)),
                Stream.unwrap(Effect.as(released, Stream.fromIterable(parts.slice(count))))
              )
            const turnParts =
              command === "wait"
                ? releasedAfter(1)
                : command === "steps"
                  ? Stream.concat(Stream.fromIterable(parts.slice(0, 4)), releasedAfter(1))
                  : Stream.fromIterable(parts)
            return Stream.unwrap(
              Effect.as(
                Ref.update(turns, (count) => count + 1),
                turnParts
              )
            )
          },
          submitToolResult: () => Effect.void,
          approve: () => Effect.void,
          compact: () => Effect.succeed({ type: "compaction", trigger: "manual", summary: "" }),
          state: Effect.map(Ref.get(turns), (count) => State.make({ turns: count })),
          destroy: Effect.orDie(fs.writeFileString(`destroyed-${options.id}`, ""))
        }
        return session
      })
  }

  return yield* BunBridge.serve(
    driver,
    launch,
    agentOptions.idleSeconds === undefined ? {} : { idleTimeout: `${agentOptions.idleSeconds} seconds` }
  )
})

BunRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(BunServices.layer)))
