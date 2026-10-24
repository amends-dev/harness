/** Persistent Codex threads, with a process isolated to each harness session. */

import type { Bridge, HostToolRelay } from "@amends-dev/harness"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { contractError, unavailable, unsupported } from "../errors.ts"
import type { Model, Options } from "../models.ts"
import { historyOf, inputOf } from "./prompt.ts"
import * as Rpc from "./rpc.ts"
import * as Turn from "./turn.ts"

const State = Schema.Struct({ threadId: Schema.String })
const ThreadResponse = Schema.Struct({ thread: Schema.Struct({ id: Schema.String }) })
const TurnResponse = Schema.Struct({ turn: Schema.Struct({ id: Schema.String }) })
const decode = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) => contractError("Codex returned an invalid response", cause))
  )

interface Running {
  readonly rpc: Rpc.Rpc
  readonly scope: Scope.Closeable
  readonly settings: string
}

export const create = Effect.fn("CodexSession.create")(function* (
  options: Options & { readonly command: string },
  root: string,
  relay: HostToolRelay.HostToolRelay["Service"],
  sessionOptions: Bridge.CreateSessionOptions
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const sessionScope = yield* Effect.scope
  const relaySession = yield* relay.open(sessionOptions.id)
  const home = path.join(root, "codex", sessionOptions.id)
  yield* fs
    .makeDirectory(home, { recursive: true })
    .pipe(Effect.mapError((cause) => unavailable("Could not prepare Codex home", cause)))
  const running = yield* Ref.make<Running | undefined>(undefined)
  yield* Effect.addFinalizer(() =>
    Effect.flatMap(Ref.get(running), (current) =>
      current === undefined ? Effect.void : Scope.close(current.scope, Exit.void)
    )
  )

  const threadOptions = (model: Model, instructions?: string) => ({
    cwd: sessionOptions.directory,
    model: model.model,
    modelProvider: model.provider,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "danger-full-access",
    developerInstructions: instructions ?? "",
    config: {
      ...(model.effort === undefined ? {} : { model_reasoning_effort: model.effort }),
      ...(model.contextWindow === undefined ? {} : { model_context_window: model.contextWindow })
    }
  })

  /** A changed tool catalog or provider gets a fresh process, so no cached MCP tools or provider leaks into a turn. */
  const start = Effect.fn("CodexSession.start")(function* (
    model: Model,
    tools: ReadonlyArray<Bridge.ToolDefinition>,
    instructions?: string
  ) {
    const settings = JSON.stringify([model, tools, instructions ?? ""])
    const current = yield* Ref.get(running)
    if (current?.settings === settings) return current.rpc
    if (current !== undefined) {
      yield* Scope.close(current.scope, Exit.void)
      yield* Ref.set(running, undefined)
    }
    const config = {
      ...options.config,
      model: model.model,
      model_provider: model.provider,
      ...(model.effort === undefined ? {} : { model_reasoning_effort: model.effort }),
      ...(model.contextWindow === undefined ? {} : { model_context_window: model.contextWindow }),
      mcp_servers:
        tools.length === 0
          ? {}
          : {
              host: {
                url: relay.url,
                http_headers: { authorization: `Bearer ${Redacted.value(relaySession.token)}` },
                required: true,
                tool_timeout_sec: 3600,
                // Host tool authorization happens in the harness after the relay emits its call.
                tools: Object.fromEntries(tools.map((tool) => [tool.name, { approval_mode: "approve" }]))
              }
            }
    }
    const toml = yield* tomlOf(config)
    yield* fs
      .writeFileString(path.join(home, "config.toml"), toml, { mode: 0o600 })
      .pipe(Effect.mapError((cause) => unavailable("Could not configure Codex", cause)))
    const scope = yield* Scope.fork(sessionScope)
    const rpc = yield* Rpc.start({
      command: options.command,
      directory: sessionOptions.directory,
      env: { ...options.env, CODEX_HOME: home }
    }).pipe(
      Scope.provide(scope),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause)))
    )
    yield* Ref.set(running, { rpc, scope, settings })
    return rpc
  })

  const saved = sessionOptions.agentState === undefined ? undefined : yield* decode(State, sessionOptions.agentState)
  const rpc = yield* start(options.model, [])
  const restored =
    saved === undefined
      ? undefined
      : yield* rpc
          .request("thread/resume", {
            threadId: saved.threadId,
            excludeTurns: true,
            ...threadOptions(options.model)
          })
          .pipe(
            Effect.map((result) => ({ result })),
            Effect.catchReason("HarnessError", "NotFoundError", () => Effect.void)
          )
  const keptConversation = restored !== undefined
  const created = restored?.result ?? (yield* rpc.request("thread/start", threadOptions(options.model)))
  const { thread } = yield* decode(ThreadResponse, created)
  if (!keptConversation) {
    const items = yield* historyOf(sessionOptions.history)
    // Codex does not persist a freshly created thread until it receives history or a turn.
    // This neutral item makes the id durable before BridgeServer records its first turn.
    yield* rpc.request("thread/inject_items", {
      threadId: thread.id,
      items:
        items.length === 0
          ? [
              {
                type: "message",
                role: "developer",
                content: [{ type: "input_text", text: "This conversation is managed by Amends." }]
              }
            ]
          : items
    })
  }
  const approvals = new Map<string, { readonly rpc: Rpc.Rpc; readonly id: string | number }>()

  const promptTurn: Bridge.DriverSession["promptTurn"] = (turn) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const model =
          turn.model === undefined
            ? options.model
            : Object.hasOwn(options.models, turn.model)
              ? options.models[turn.model]
              : undefined
        if (model === undefined) return yield* unsupported(`Codex has no model named ${turn.model}`)
        const input = yield* inputOf(turn.prompt)
        const hostCalls = yield* relaySession.offerTools(turn.tools)
        const before = yield* Ref.get(running)
        const rpc = yield* start(model, turn.tools, turn.instructions)
        if (before?.rpc !== rpc) {
          yield* rpc.request("thread/resume", {
            threadId: thread.id,
            excludeTurns: true,
            ...threadOptions(model, turn.instructions)
          })
        }
        const events = yield* rpc.subscribe
        const finished = yield* Ref.make(false)
        const turnId = yield* Ref.make<string | undefined>(undefined)
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            approvals.clear()
            if (yield* Ref.get(finished)) return
            const id = yield* Ref.get(turnId)
            if (id !== undefined)
              yield* rpc
                .request("turn/interrupt", { threadId: thread.id, turnId: id })
                .pipe(Effect.timeout("5 seconds"), Effect.ignore)
            // A cancelled start may have reached the server before its reply, and there is no safe turn id.
            // Closing the child also stops that turn and releases any pending native permission requests.
            const current = yield* Ref.get(running)
            if (current?.rpc === rpc) {
              yield* Ref.set(running, undefined)
              yield* Scope.close(current.scope, Exit.void)
            }
          })
        )
        const response = yield* rpc
          .request("turn/start", {
            threadId: thread.id,
            input,
            model: model.model,
            effort: model.effort ?? null,
            sandboxPolicy: { type: "externalSandbox", networkAccess: "enabled" },
            collaborationMode: {
              mode: "default",
              settings: {
                model: model.model,
                reasoning_effort: model.effort ?? null,
                developer_instructions: turn.instructions ?? ""
              }
            },
            ...(turn.responseFormat.type === "json" ? { outputSchema: turn.responseFormat.schema } : {})
          })
          .pipe(Effect.flatMap((response) => decode(TurnResponse, response)))
        yield* Ref.set(turnId, response.turn.id)
        const translated = yield* Ref.make(Turn.initial())
        const translate = Effect.fn("CodexSession.translate")(function* (event: Rpc.Message) {
          if (event.id !== undefined) {
            if (
              event.method === "item/commandExecution/requestApproval" ||
              event.method === "item/fileChange/requestApproval"
            ) {
              approvals.set(JSON.stringify(event.id), { rpc, id: event.id })
            } else if (event.method === "tool/requestUserInput") {
              yield* rpc.respond(event.id, { answers: {} })
            } else if (event.method === "mcpServer/elicitation/request") {
              yield* rpc.respond(event.id, { action: "decline", content: null })
            } else {
              yield* rpc.reject(event.id, `Amends does not handle ${event.method}`)
            }
          }
          const [state, parts] = yield* Turn.translate(yield* Ref.get(translated), event)
          yield* Ref.set(translated, state)
          return parts
        })
        const parts = events.pipe(
          Stream.filter((event) => belongsTo(event, thread.id, response.turn.id)),
          Stream.mapEffect(translate),
          Stream.flattenIterable,
          Stream.takeUntil((part) => part.type === "finish"),
          Stream.tap((part) => (part.type === "finish" ? Ref.set(finished, true) : Effect.void))
        )
        return Stream.merge(parts, hostCalls, { haltStrategy: "left" })
      })
    ).pipe(Stream.scoped)

  const session: Bridge.DriverSession = {
    keptConversation,
    promptTurn,
    submitToolResult: relaySession.submitToolResult,
    approve: ({ approvalId, approved }) => {
      const pending = approvals.get(approvalId)
      if (pending === undefined) return Effect.void
      return pending.rpc
        .respond(pending.id, { decision: approved ? "accept" : "decline" })
        .pipe(Effect.tap(() => Effect.sync(() => approvals.delete(approvalId))))
    },
    compact: () =>
      Effect.fail(unsupported("Codex compaction does not expose the summary required by the harness contract")),
    state: Effect.succeed({ threadId: thread.id }),
    destroy: Effect.gen(function* () {
      const current = yield* start(options.model, [])
      yield* current.request("thread/archive", { threadId: thread.id })
      yield* current.request("thread/delete", { threadId: thread.id })
    })
  }
  return session
})

/** Notifications for another thread/turn cannot terminate or contaminate this one. */
const belongsTo = (message: Rpc.Message, threadId: string, turnId: string): boolean => {
  const params = message.params
  if (!Predicate.isReadonlyObject(params)) return false
  if (params.threadId !== undefined && params.threadId !== threadId) return false
  if (params.turnId !== undefined && params.turnId !== turnId) return false
  if (Predicate.isReadonlyObject(params.turn) && params.turn.id !== undefined && params.turn.id !== turnId) return false
  return true
}

/** TOML inline values keep config keys and secrets escaped without a shell. Null has no TOML representation. */
export const tomlOf = Effect.fn("CodexConfig.tomlOf")(function* (config: Readonly<Record<string, Schema.Json>>) {
  const encode = (value: unknown): string | undefined => {
    if (value === null) return undefined
    if (Array.isArray(value)) {
      const values = value.map(encode)
      return values.some((it) => it === undefined) ? undefined : `[${values.join(", ")}]`
    }
    if (Predicate.isReadonlyObject(value)) {
      const values = Object.entries(value).map(([key, value]) => {
        const encoded = encode(value)
        return encoded === undefined ? undefined : `${JSON.stringify(key)} = ${encoded}`
      })
      return values.some((it) => it === undefined) ? undefined : `{ ${values.join(", ")} }`
    }
    return JSON.stringify(value)
  }
  const lines: Array<string> = []
  for (const [key, value] of Object.entries(config)) {
    const encoded = encode(value)
    if (encoded === undefined)
      return yield* unsupported(`Codex config ${key} contains null, which TOML cannot represent`)
    lines.push(
      `${key
        .split(".")
        .map((segment) => JSON.stringify(segment))
        .join(".")} = ${encoded}`
    )
  }
  return lines.join("\n") + "\n"
})
