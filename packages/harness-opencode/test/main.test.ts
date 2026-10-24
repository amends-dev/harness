import { Harness } from "@amends-dev/harness"
import { SessionId } from "@amends-dev/harness/Agent"
import { Template } from "@amends-dev/sandbox"
import { BunServices, BunSocket } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Schedule } from "effect"
import { installStandIn, isRunning, makeBridgedAgent, makeSandbox, startsIn } from "./fixtures.ts"

/**
 * The bridge client launches each agent's bridge program, `v1/main.ts` and `v2/main.ts`, in a
 * sandbox on this machine, as a host does, with the stand-in for `opencode serve` as the command
 * that runs opencode.
 */
const TestLayer = Layer.merge(BunServices.layer, BunSocket.layerWebSocketConstructor)

const config = { autoupdate: false }

/** The agents, by the version of opencode each runs. */
const agents = [
  { version: 1, id: "opencode" },
  { version: 2, id: "opencode2" }
] as const

describe.each(agents)("the bridge program of opencode $version", ({ version, id }) => {
  /** A harness over the bridge program, which runs opencode as `command`. */
  const makeHarness = (command: string, env: Readonly<Record<string, string>> = {}) =>
    Effect.map(
      makeBridgedAgent({
        id,
        template: {
          name: Template.TemplateName.make(id),
          identity: "none",
          prepare: Effect.void
        },
        command: process.execPath,
        args: [`${import.meta.dirname}/../src/internal/bridge/v${version}/main.ts`],
        token: (sandboxId) => Redacted.make(`the hosts' secret/${sandboxId}`),
        agentOptions: {
          model: { providerID: "opencode", id: "default-model" },
          models: {},
          command,
          config,
          env: { GREETING: "hello", ...env }
        }
      }),
      Harness.make
    )

  it.live("starts opencode's server with the agent options when a session starts", () =>
    Effect.gen(function* () {
      const { command, directory } = yield* installStandIn
      const sandbox = yield* makeSandbox()
      const harness = yield* makeHarness(command)

      yield* harness.createSession({ sandbox, id: SessionId.make("session-1") })

      expect(yield* startsIn(directory)).toMatchObject([
        {
          args: ["serve", "--hostname=127.0.0.1", expect.stringMatching(/^--port=[1-9]\d*$/)],
          config,
          greeting: "hello"
        }
      ])
    }).pipe(Effect.provide(TestLayer))
  )

  it.live("exits when opencode's server exits by itself, for the next host to launch both", () =>
    Effect.gen(function* () {
      const { command, directory } = yield* installStandIn
      const sandbox = yield* makeSandbox()
      const harness = yield* makeHarness(command, { FAKE_OPENCODE_EXIT_AFTER: "200" })
      yield* harness.createSession({ sandbox, id: SessionId.make("session-1") })
      const [started] = yield* startsIn(directory)
      // The server runs until the bridge has learned that it exited.
      yield* isRunning(started?.pid ?? 0).pipe(
        Effect.repeat({ while: (running) => running, schedule: Schedule.spaced("50 millis") })
      )
      const nextHarness = yield* makeHarness(command)

      // A bridge still running would start no second server, but fail the session on the one that
      // exited, until it exits too; the bridge the next host launches then starts its own.
      yield* nextHarness
        .createSession({ sandbox, id: SessionId.make("session-2") })
        .pipe(Effect.retry(Schedule.spaced("200 millis").pipe(Schedule.upTo({ duration: "10 seconds" }))))

      expect(yield* startsIn(directory)).toHaveLength(2)
    }).pipe(Effect.provide(TestLayer))
  )
})
