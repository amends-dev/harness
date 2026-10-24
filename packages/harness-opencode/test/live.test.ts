import {
  type Bridge,
  GenerateResult,
  Harness,
  HostToolRelay,
  type ModelEndpoint,
  type StreamPart
} from "@amends-dev/harness"
import { SessionId } from "@amends-dev/harness/Agent"
import type { Sandbox, Template } from "@amends-dev/sandbox"
import { DaytonaSandboxProvider } from "@amends-dev/sandbox-daytona"
import { BunHttpServer, BunServices, BunSocket } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, FileSystem, Layer, Path, Redacted, Result, Schema, type Scope, Stream } from "effect"
import { Prompt, Tool, Toolkit } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import * as Driver from "../src/internal/bridge/driver.ts"
import { makeCreateSession } from "../src/internal/bridge/v1/session.ts"
import { makeCreateSession as makeCreateSession2 } from "../src/internal/bridge/v2/session.ts"
import { modelsOf } from "../src/internal/models.ts"
import * as Opencode2Agent from "../src/Opencode2Agent.ts"
import * as OpencodeAgent from "../src/OpencodeAgent.ts"
import { makeSandbox } from "./fixtures.ts"

/**
 * These tests run real opencode, whose turns a model answers over the network, so they take
 * minutes and run only with `AMENDS_TEST_OPENCODE=1`. Each agent's driver, as its bridge runs it,
 * runs the opencode on the `PATH`: `opencode`, of opencode 1, and `opencode2`, of opencode 2, or the
 * command `AMENDS_TEST_OPENCODE2_COMMAND` names. The agents as hosts run them run the opencode their
 * template installs in this machine's home, under `~/.amends/opencode`, once for each version.
 * Their model is one of OpenCode Zen's free ones, which needs no key; `AMENDS_TEST_OPENCODE_MODEL`
 * names another of OpenCode Zen's models, and `AMENDS_TEST_OPENCODE_API_KEY` the key for it.
 */
const enabled = process.env.AMENDS_TEST_OPENCODE === "1"
const modelName = process.env.AMENDS_TEST_OPENCODE_MODEL ?? "space-bunny-free"
const apiKey = process.env.AMENDS_TEST_OPENCODE_API_KEY

const id = SessionId.make("live")
const timeout = 180_000

/** The relay through which opencode calls the host's tools, as its bridge program serves it. */
const RelayLayer = HostToolRelay.layer().pipe(
  Layer.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, idleTimeout: 0 })),
  Layer.provide(BunServices.layer)
)
const LiveLayer = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer, RelayLayer)
const HostLayer = Layer.merge(BunServices.layer, BunSocket.layerWebSocketConstructor)

/**
 * The version of opencode each agent runs, the command that runs it, the name of its tool that runs
 * commands, and how its driver creates sessions.
 */
interface Version {
  readonly version: 1 | 2
  readonly agent: string
  readonly command: string
  readonly shellTool: string
  readonly makeCreateSession: (relay: HostToolRelay.HostToolRelay["Service"]) => Driver.CreateSession

  /** opencode's configuration that has it ask permission before it runs a command. */
  readonly askBeforeCommands: Record<string, Schema.Json>
}

const opencode1: Version = {
  version: 1,
  agent: "opencode",
  command: "opencode",
  shellTool: "bash",
  makeCreateSession,
  askBeforeCommands: { permission: { bash: "ask" } }
}
const opencode2: Version = {
  version: 2,
  agent: "opencode2",
  command: process.env.AMENDS_TEST_OPENCODE2_COMMAND ?? "opencode2",
  shellTool: "shell",
  makeCreateSession: makeCreateSession2,
  askBeforeCommands: { permissions: [{ action: "shell", resource: "*", effect: "ask" }] }
}
const versions = [opencode1, opencode2]

/** The endpoint of OpenCode Zen's model that `AMENDS_TEST_OPENCODE_MODEL` names. */
const endpoint = {
  provider: "opencode",
  model: modelName,
  protocol: "openai-chat",
  url: "https://opencode.ai/zen/v1",
  ...(apiKey === undefined ? {} : { apiKey: Redacted.make(apiKey) })
} satisfies ModelEndpoint.ModelEndpoint

/** opencode's configuration, which keeps opencode from updating itself. */
const config = { autoupdate: false }

/**
 * The environment of opencode, which keeps opencode's data in directories of its own, apart from
 * this machine's opencode; it shares only its cache.
 */
const makeOpencodeEnv = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* fs.makeTempDirectoryScoped()
  return {
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_STATE_HOME: path.join(home, "state")
  }
})

/**
 * The driver of `version` as a bridge runs it, on this machine, on `endpoints` or the model the
 * tests run on, with `extraConfig` beside its own, and a directory for its session. opencode's
 * server stops when the scope closes.
 */
const makeLiveDriver = (
  version: Version,
  endpoints?: Parameters<typeof modelsOf>[1],
  extraConfig: Record<string, Schema.Json> = {}
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const models = Result.getOrThrow(modelsOf(version.version, endpoints ?? { model: endpoint, models: {} }))
    const driver = yield* Driver.make(
      version.agent,
      {
        model: models.model,
        models: models.models,
        command: version.command,
        config: { ...config, ...extraConfig, ...models.config },
        env: { ...(yield* makeOpencodeEnv), ...models.env }
      },
      version.makeCreateSession(yield* HostToolRelay.HostToolRelay)
    )
    return { driver, directory }
  })

/** The sandboxes hosts run opencode in, and opencode's environment. */
interface Sandboxes {
  readonly env: Effect.Effect<Opencode2Agent.Options["env"], unknown, Scope.Scope | FileSystem.FileSystem | Path.Path>
  readonly create: (
    template: Template.Template | undefined
  ) => Effect.Effect<Sandbox.Sandbox["Service"], unknown, Scope.Scope | HostServices>
}

type HostServices = Layer.Success<typeof HostLayer>

/** Directories on this machine, where opencode keeps apart from this machine's own. */
const localSandboxes: Sandboxes = {
  env: makeOpencodeEnv,
  create: makeSandbox
}

/** Machines of their own in Daytona's cloud, where nothing listens on a port yet. */
const daytonaSandboxes: Sandboxes = {
  env: Effect.succeed({}),
  create: (template) =>
    Effect.gen(function* () {
      const provider = yield* DaytonaSandboxProvider.make({
        apiKey: Redacted.make(process.env.DAYTONA_API_KEY ?? "")
      })
      return yield* provider.createScoped(template === undefined ? {} : { template })
    })
}

/**
 * Harnesses over the agent of `version` as two hosts run it, which share the secret their bridge
 * tokens derive from, and a new sandbox of `sandboxes` prepared with the agent's template. The bridge and
 * opencode's server stop with the sandbox when the scope closes.
 */
const makeLiveHosts = (sandboxes: Sandboxes, version: Version) =>
  Effect.gen(function* () {
    const env = yield* sandboxes.env
    const options = {
      model: endpoint,
      token: (sandboxId: Sandbox.SandboxId) => Redacted.make(`the hosts' secret/${sandboxId}`),
      config,
      ...(env === undefined ? {} : { env })
    }
    const makeHarness = Effect.map(
      version.version === 1 ? OpencodeAgent.make(options) : Opencode2Agent.make(options),
      Harness.make
    )
    const harness = yield* makeHarness
    const nextHarness = yield* makeHarness
    const sandbox = yield* sandboxes.create(harness.agent.template)
    return { sandbox, harness, nextHarness }
  })

const turnOptions = (text: string, options: Partial<Bridge.TurnOptions> = {}) => ({
  prompt: Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text })] }),
  tools: [],
  responseFormat: { type: "text" } as const,
  ...options
})

/** Runs a turn asking `text` to its end, returning it whole. */
const runTurn = (session: Bridge.DriverSession, text: string, options?: Partial<Bridge.TurnOptions>) =>
  Effect.map(
    Stream.runCollect(session.promptTurn(turnOptions(text, options))),
    (parts: ReadonlyArray<StreamPart.StreamPart>) => new GenerateResult.GenerateResult(parts)
  )

/** A request a fake model API received. */
interface Received {
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown>
}

/**
 * A fake of model APIs on this machine, which records the requests it receives. It answers a Chat
 * Completions request with `pong`, streamed, and refuses every other. It stops when the scope
 * closes.
 */
const makeFakeModelApi = Effect.gen(function* () {
  const received: Array<Received> = []
  const chunk = (fields: object) =>
    `data: ${JSON.stringify({ id: "chat_1", object: "chat.completion.chunk", created: 0, model: "model", ...fields })}\n\n`
  const answer = [
    chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "pong" } }] }),
    chunk({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
    }),
    "data: [DONE]\n\n"
  ].join("")
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          const path = new URL(request.url).pathname
          received.push({
            path,
            headers: Object.fromEntries(request.headers),
            body: (await request.json()) as Record<string, unknown>
          })
          return path.endsWith("/chat/completions")
            ? new Response(answer, { headers: { "content-type": "text/event-stream" } })
            : Response.json(
                { error: { type: "invalid_request_error", message: "refused" } },
                {
                  status: 400
                }
              )
        }
      })
    ),
    (server) => Effect.promise(() => server.stop(true))
  )
  return { url: `http://127.0.0.1:${server.port}`, received }
})

/** The opencode session a session's state names. */
const OpencodeState = Schema.Struct({ sessionID: Schema.String })

describe.skipIf(!enabled).each(versions)("opencode $version as the bridge runs it", (version) => {
  it.live(
    "sends a turn to its model's endpoint, with the endpoint's key, effort, and output limit",
    () =>
      Effect.gen(function* () {
        const api = yield* makeFakeModelApi
        // Models that opencode knows from models.dev, at the fake's URL.
        const { driver, directory } = yield* makeLiveDriver(version, {
          model: {
            provider: "openrouter",
            model: "openai/gpt-oss-120b",
            protocol: "openai-chat",
            url: `${api.url}/chat/v1`,
            apiKey: Redacted.make("chat-key"),
            effort: "low"
          },
          models: {
            claude: {
              provider: "anthropic",
              model: "claude-sonnet-4-5",
              protocol: "anthropic-messages",
              url: `${api.url}/anthropic/v1`,
              apiKey: Redacted.make("anthropic-key"),
              effort: "high",
              maxOutputTokens: 2048,
              contextWindow: 200_000
            },
            gpt: {
              provider: "openai",
              model: "gpt-5",
              protocol: "openai-responses",
              url: `${api.url}/openai/v1`,
              apiKey: Redacted.make("openai-key"),
              effort: "medium"
            }
          }
        })
        const session = yield* driver.createSession({ id, directory, history: Prompt.empty })

        const answered = yield* runTurn(session, "Say pong.")
        const refused = [
          yield* runTurn(session, "Say pong.", { model: "claude" }),
          yield* runTurn(session, "Say pong.", { model: "gpt" })
        ]

        expect(answered.text).toBe("pong")
        expect(refused.map((result) => result.finishReason)).toEqual(["error", "error"])
        const sentTo = (path: string) => api.received.find((request) => request.path === path)
        expect(sentTo("/chat/v1/chat/completions")).toMatchObject({
          headers: { authorization: "Bearer chat-key" },
          body: { model: "openai/gpt-oss-120b", reasoning_effort: "low" }
        })
        expect(sentTo("/anthropic/v1/messages")).toMatchObject({
          headers: { "x-api-key": "anthropic-key" },
          body: { model: "claude-sonnet-4-5", max_tokens: 2048, output_config: { effort: "high" } }
        })
        expect(sentTo("/openai/v1/responses")).toMatchObject({
          headers: { authorization: "Bearer openai-key" },
          body: { model: "gpt-5", reasoning: { effort: "medium" } }
        })
      }).pipe(Effect.provide(LiveLayer)),
    timeout
  )

  it.live(
    "runs a turn in which opencode runs a command with its own tool",
    () =>
      Effect.gen(function* () {
        const { driver, directory } = yield* makeLiveDriver(version)
        const session = yield* driver.createSession({ id, directory, history: Prompt.empty })

        const result = yield* runTurn(
          session,
          "Run `echo live-opencode` in a shell with your tool, then reply with what it printed."
        )

        expect(result.parts.find((part) => part.type === "tool-call")).toEqual(
          expect.objectContaining({ name: version.shellTool, providerExecuted: true })
        )
        expect(
          result.parts.some(
            (part) => part.type === "tool-result" && JSON.stringify(part.result).includes("live-opencode")
          )
        ).toBe(true)
        expect(result.text).toContain("live-opencode")
      }).pipe(Effect.provide(LiveLayer)),
    timeout
  )

  it.live(
    "answers from another agent's conversation, the results of its tools included",
    () =>
      Effect.gen(function* () {
        const { driver, directory } = yield* makeLiveDriver(version)
        const history = Prompt.make([
          {
            role: "user",
            content: "Remember the codename BLUE-MARLIN-9, then check the weather in Lisbon."
          },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                id: "call_1",
                name: "lookup_weather",
                params: { city: "Lisbon" },
                providerExecuted: false
              }
            ]
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                id: "call_1",
                name: "lookup_weather",
                isFailure: false,
                result: { forecast: "foggy", celsius: 14 },
                providerExecuted: false
              }
            ]
          },
          { role: "assistant", content: [{ type: "text", text: "Noted." }] }
        ])
        const session = yield* driver.createSession({ id, directory, history })

        const result = yield* runTurn(
          session,
          "Without using any tools: what is the codename, and how many degrees Celsius did the weather tool return? Reply with both on one line."
        )

        expect(result.text).toContain("BLUE-MARLIN-9")
        expect(result.text).toContain("14")
      }).pipe(Effect.provide(LiveLayer)),
    timeout
  )

  it.live(
    "ends a turn on a model its provider does not serve with an error",
    () =>
      Effect.gen(function* () {
        const model = endpoint
        const { driver, directory } = yield* makeLiveDriver(version, {
          model,
          models: { missing: { ...model, model: "no-such-model" } }
        })
        const session = yield* driver.createSession({ id, directory, history: Prompt.empty })

        const result = yield* runTurn(session, "Say hi.", { model: "missing" })

        expect(result.finishReason).toBe("error")
      }).pipe(Effect.provide(LiveLayer)),
    timeout
  )

  it.live(
    "deletes the session in opencode when it is destroyed",
    () =>
      Effect.gen(function* () {
        const { driver, directory } = yield* makeLiveDriver(version)
        const session = yield* driver.createSession({ id, directory, history: Prompt.empty })
        const agentState = yield* session.state

        yield* session.destroy
        // opencode no longer has the session, so the driver starts another.
        const again = yield* driver.createSession({
          id,
          directory,
          history: Prompt.empty,
          agentState
        })

        const before = yield* Schema.decodeUnknownEffect(OpencodeState)(agentState)
        const after = yield* Schema.decodeUnknownEffect(OpencodeState)(yield* again.state)
        expect(after.sessionID).not.toBe(before.sessionID)
      }).pipe(Effect.provide(LiveLayer)),
    timeout
  )

  it.live(
    "stops the turn in opencode when its stream ends before the turn does",
    () =>
      Effect.gen(function* () {
        const { driver, directory } = yield* makeLiveDriver(version)
        const session = yield* driver.createSession({ id, directory, history: Prompt.empty })

        yield* session.promptTurn(turnOptions("Run `sleep 300` in a shell with your tool, then say done.")).pipe(
          Stream.takeUntil((part) => part.type === "tool-call"),
          Stream.runDrain
        )
        // A turn opencode still ran would keep the next waiting for five minutes.
        const next = yield* runTurn(session, "Reply with just the word: ready")

        expect(next.finishReason).not.toBe("error")
      }).pipe(Effect.provide(LiveLayer)),
    timeout
  )
})

/** The weather in a city, which the host's tool gives. */
const lookupWeather: Bridge.ToolDefinition = {
  name: "lookup_weather",
  description: "Looks up the weather in a city",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }
}

const lookupTime: Bridge.ToolDefinition = {
  name: "lookup_time",
  description: "Looks up the time in a city",
  parameters: lookupWeather.parameters
}

/** Whether `part` calls one of the host's tools, rather than one opencode runs itself. */
const isHostCall = (part: StreamPart.StreamPart) => part.type === "tool-call" && part.providerExecuted !== true

/**
 * Runs a turn asking `text` with the host's `tools`, answering each call of them with `result`, as
 * the host would.
 */
const runTurnWithTools = (
  session: Bridge.DriverSession,
  text: string,
  tools: ReadonlyArray<Bridge.ToolDefinition>,
  result: unknown
) =>
  session.promptTurn(turnOptions(text, { tools })).pipe(
    Stream.tap((part) =>
      part.type === "tool-call" && part.providerExecuted !== true
        ? session.submitToolResult({ id: part.id, name: part.name, result, isFailure: false })
        : Effect.void
    ),
    Stream.runCollect,
    Effect.map((parts) => new GenerateResult.GenerateResult(parts))
  )

describe.skipIf(!enabled).each(versions)("opencode $version as the bridge runs it, with more of a turn", (version) => {
  it.live(
    "gives the model the turn's instructions",
    () =>
      Effect.gen(function* () {
        const { driver, directory } = yield* makeLiveDriver(version)
        const session = yield* driver.createSession({ id, directory, history: Prompt.empty })

        const result = yield* runTurn(session, "Say hello.", {
          instructions: "End every answer with the word LIVE-INSTRUCTIONS-OK."
        })

        expect(result.text).toContain("LIVE-INSTRUCTIONS-OK")
      }).pipe(Effect.provide(LiveLayer)),
    timeout
  )

  it.live(
    "reads a file the prompt attaches",
    () =>
      Effect.gen(function* () {
        const { driver, directory } = yield* makeLiveDriver(version)
        const session = yield* driver.createSession({ id, directory, history: Prompt.empty })

        const parts = yield* Stream.runCollect(
          session.promptTurn({
            tools: [],
            responseFormat: { type: "text" },
            prompt: Prompt.makeMessage("user", {
              content: [
                Prompt.makePart("text", {
                  text: "Which container does the attached manifest list? Reply with just its id."
                }),
                Prompt.makePart("file", {
                  mediaType: "text/plain",
                  fileName: "manifest.txt",
                  data: btoa("Shipping manifest\nContainer: MARMALADE-77\nPorts: Lisbon, Porto\n")
                })
              ]
            })
          })
        )

        expect(new GenerateResult.GenerateResult(parts).text).toContain("MARMALADE-77")
      }).pipe(Effect.provide(LiveLayer)),
    timeout
  )

  it.live(
    "calls the host's tools, and those of a later turn when they change",
    () =>
      Effect.gen(function* () {
        const { driver, directory } = yield* makeLiveDriver(version)
        const session = yield* driver.createSession({ id, directory, history: Prompt.empty })

        const weather = yield* runTurnWithTools(
          session,
          "Use the lookup_weather tool for Lisbon, then tell me how many degrees it returned.",
          [lookupWeather],
          { forecast: "foggy", celsius: 14 }
        )
        const time = yield* runTurnWithTools(
          session,
          "Use the lookup_time tool for Lisbon, then tell me the time it returned.",
          [lookupTime],
          { time: "13:37" }
        )

        expect(weather.parts.find(isHostCall)).toMatchObject({
          name: "lookup_weather",
          params: { city: "Lisbon" }
        })
        expect(weather.text).toContain("14")
        expect(time.parts.find(isHostCall)).toMatchObject({
          name: "lookup_time"
        })
        expect(time.text).toContain("13:37")
      }).pipe(Effect.provide(LiveLayer)),
    timeout
  )

  it.live(
    "compacts on request, the conversation going on from the summary",
    () =>
      Effect.gen(function* () {
        const { driver, directory } = yield* makeLiveDriver(version)
        const session = yield* driver.createSession({ id, directory, history: Prompt.empty })
        yield* runTurn(session, "Remember the codename BLUE-MARLIN-9. Reply OK.")

        const compaction = yield* session.compact()
        const after = yield* runTurn(session, "What is the codename? Reply with just it.")

        expect(compaction).toMatchObject({ type: "compaction", trigger: "manual" })
        expect(compaction.summary).toContain("BLUE-MARLIN-9")
        expect(after.text).toContain("BLUE-MARLIN-9")
      }).pipe(Effect.provide(LiveLayer)),
    timeout
  )

  it.live(
    "asks for approval when a tool asks permission, and runs it once approved",
    () =>
      Effect.gen(function* () {
        const { driver, directory } = yield* makeLiveDriver(version, undefined, version.askBeforeCommands)
        const session = yield* driver.createSession({ id, directory, history: Prompt.empty })

        const parts = yield* session
          .promptTurn(
            turnOptions("Run `echo live-approved` in a shell with your tool, then reply with what it printed.")
          )
          .pipe(
            Stream.tap((part) =>
              part.type === "tool-approval-request"
                ? session.approve({ approvalId: part.approvalId, approved: true })
                : Effect.void
            ),
            Stream.runCollect
          )

        expect(parts.some((part) => part.type === "tool-approval-request")).toBe(true)
        expect(new GenerateResult.GenerateResult(parts).text).toContain("live-approved")
      }).pipe(Effect.provide(LiveLayer)),
    timeout
  )
})

describe.skipIf(!enabled)("opencode 1 as the bridge runs it, answering in JSON", () => {
  it.live(
    "answers in JSON that matches the turn's schema",
    () =>
      Effect.gen(function* () {
        const { driver, directory } = yield* makeLiveDriver(opencode1)
        const session = yield* driver.createSession({ id, directory, history: Prompt.empty })

        const result = yield* runTurn(session, "Give the city Lisbon and its country.", {
          responseFormat: {
            type: "json",
            objectName: "city",
            schema: {
              type: "object",
              properties: { city: { type: "string" }, country: { type: "string" } },
              required: ["city", "country"],
              additionalProperties: false
            }
          }
        })

        expect(result.finishReason).toBe("stop")
        expect(JSON.parse(result.text)).toMatchObject({ city: "Lisbon", country: "Portugal" })
      }).pipe(Effect.provide(LiveLayer)),
    timeout
  )
})

/** What hosts do with opencode through its bridge, on sandboxes of `sandboxes`. */
const describeHosts = (title: string, enabled: boolean, sandboxes: Sandboxes, timeout: number) =>
  describe.skipIf(!enabled).each(versions)(title, (version) => {
    it.live(
      "runs a turn in which opencode runs a command with its own tool",
      () =>
        Effect.gen(function* () {
          const { sandbox, harness } = yield* makeLiveHosts(sandboxes, version)
          const session = yield* harness.createSession({ sandbox, id })

          const result = yield* session.generate({
            prompt: "Run `echo live-opencode` in a shell with your tool, then reply with what it printed."
          })

          expect(result.parts.find((part) => part.type === "tool-call")).toEqual(
            expect.objectContaining({ name: version.shellTool, providerExecuted: true })
          )
          expect(result.text).toContain("live-opencode")
        }).pipe(Effect.provide(HostLayer)),
      timeout
    )

    it.live(
      "continues on another host a suspended turn, which opencode went on with, from the step it was in",
      () =>
        Effect.gen(function* () {
          const { sandbox, harness, nextHarness } = yield* makeLiveHosts(sandboxes, version)
          const session = yield* harness.createSession({ sandbox, id })
          const before: Array<StreamPart.StreamPart> = []
          const calledTool = yield* Deferred.make<void>()

          const reading = yield* session
            .stream({
              prompt: "Run `sleep 2; echo slept` in a shell with your tool, then reply with what it printed."
            })
            .pipe(
              Stream.runForEach((part) =>
                Effect.andThen(
                  Effect.sync(() => before.push(part)),
                  part.type === "tool-call" ? Deferred.succeed(calledTool, undefined) : Effect.void
                )
              ),
              Effect.forkChild
            )
          yield* Deferred.await(calledTool)
          const state = yield* session.suspendTurn
          yield* Fiber.join(reading)
          const resumed = yield* nextHarness.createSession({ sandbox, resumeFrom: state })
          const after = yield* Stream.runCollect(resumed.continueStream({}))
          const history = (yield* resumed.detach).history.content

          // The session had no step of the turn finished, so the step with the call comes again.
          expect(before.at(-1)?.type).toBe("tool-call")
          expect(after.filter((part) => part.type === "tool-call")).toHaveLength(1)
          expect(after.filter((part) => part.type === "tool-result")).toEqual([
            expect.objectContaining({ isFailure: false })
          ])
          expect(after.at(-1)?.type).toBe("finish")
          expect(
            history.flatMap((message) =>
              message.role === "assistant" ? message.content.filter((part) => part.type === "tool-call") : []
            )
          ).toHaveLength(1)
        }).pipe(Effect.provide(HostLayer)),
      timeout
    )
  })

/** The host's tool the hosts' tests give opencode, with the weather it always gives. */
const Weather = Tool.make("lookup_weather", {
  description: "Looks up the weather in a city",
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.Struct({ forecast: Schema.String, celsius: Schema.Finite })
})
const WeatherToolkit = Toolkit.make(Weather)
const WeatherHandlers = WeatherToolkit.toLayer({
  lookup_weather: () => Effect.succeed({ forecast: "foggy", celsius: 14 })
})

describe.skipIf(!enabled).each(versions)("opencode $version as hosts run it, with the host's tools", (version) => {
  it.live(
    "calls the host's tool through the relay its bridge serves in the sandbox",
    () =>
      Effect.gen(function* () {
        const { sandbox, harness } = yield* makeLiveHosts(localSandboxes, version)
        const session = yield* harness.createSession({ sandbox, id })

        const result = yield* session.generate({
          prompt: "Use the lookup_weather tool for Lisbon, then tell me how many degrees it returned.",
          toolkit: yield* WeatherToolkit
        })

        expect(result.parts.find(isHostCall)).toMatchObject({ name: "lookup_weather" })
        expect(result.text).toContain("14")
      }).pipe(Effect.provide(Layer.merge(HostLayer, WeatherHandlers))),
    timeout
  )
})

describeHosts("opencode $version as hosts run it, through its bridge", enabled, localSandboxes, timeout)

// Daytona's sandboxes cost money, so hosts run opencode there only with `AMENDS_TEST_DAYTONA=1` too.
describeHosts(
  "opencode $version as hosts run it on Daytona, through its bridge",
  enabled && process.env.AMENDS_TEST_DAYTONA === "1" && process.env.DAYTONA_API_KEY !== undefined,
  daytonaSandboxes,
  300_000
)
