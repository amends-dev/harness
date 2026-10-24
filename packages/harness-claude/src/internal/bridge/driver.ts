/** Claude sessions, SDK query lifetimes, native approvals, and the shared host-tool relay. */

import { type Bridge, HarnessError, type HostToolRelay, type StreamPart } from "@amends-dev/harness"
import type {
  CanUseTool,
  HookCallback,
  Options as QueryOptions,
  PermissionResult
} from "@anthropic-ai/claude-agent-sdk"
import * as Prompt from "effect/ai/Prompt"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { Options } from "../models.ts"
import { invalid, unavailable, unsupported } from "./errors.ts"
import { promptOf, singleMessage } from "./prompt.ts"
import type { Sdk } from "./sdk.ts"
import * as Turn from "./turn.ts"

const State = Schema.Struct({ sessionId: Schema.String.check(Schema.isUUID()) })
const StateJson = Schema.toCodecJson(State)
const hostToolName = (name: string) => `mcp__host__${name}`

type Approval = (approved: boolean, reason: string | undefined) => void

/** Creates a driver with explicit SDK and process environment, without acquiring a query yet. */
export const make = Effect.fnUntraced(function* (
  sdk: Sdk,
  options: Options,
  relay: HostToolRelay.HostToolRelay["Service"],
  executable: string,
  environment: Readonly<Record<string, string>>
) {
  const crypto = yield* Crypto.Crypto
  const driver: Bridge.Driver = {
    id: "claude",
    createSession: Effect.fn("Claude.createSession")(function* (sessionOptions) {
      const saved = yield* Schema.decodeEffect(Schema.UndefinedOr(StateJson))(sessionOptions.agentState).pipe(
        Effect.mapError((cause) => invalid(`Claude cannot read its saved state: ${cause.message}`))
      )
      const kept =
        saved !== undefined &&
        (yield* Effect.tryPromise({
          try: () => sdk.hasSession(saved.sessionId, sessionOptions.directory),
          catch: unavailable
        }))
      const sessionId =
        kept && saved !== undefined ? saved.sessionId : yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable))
      let started = kept
      let history = kept ? Prompt.empty : sessionOptions.history
      const relaySession = yield* relay.open(sessionOptions.id)
      const approvals = new Map<string, Approval>()

      const runTurn = (turnOptions: Bridge.TurnOptions, compactPrompt?: string) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const model =
              turnOptions.model === undefined
                ? options.model
                : Object.hasOwn(options.models, turnOptions.model)
                  ? options.models[turnOptions.model]
                  : undefined
            if (model === undefined) return yield* unsupported(`Claude has no model named ${turnOptions.model}`)
            const userMessage = yield* promptOf(turnOptions.prompt, history)
            const hostTools = new Set(turnOptions.tools.map(({ name }) => hostToolName(name)))
            const hostCalls = yield* relaySession.offerTools(turnOptions.tools)
            const format = turnOptions.responseFormat
            const schema =
              format.type === "json"
                ? yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))(format.schema).pipe(
                    Effect.mapError(() => unsupported("Claude's structured output requires a JSON Schema object"))
                  )
                : undefined
            const translated = Turn.make(hostTools, format.type === "json")
            const parts = Stream.callback<StreamPart.StreamPart, HarnessError.HarnessError>(
              Effect.fnUntraced(function* (queue) {
                const emit = (values: ReadonlyArray<StreamPart.StreamPart>) => {
                  for (const part of values) Queue.offerUnsafe(queue, part)
                }
                const canUseTool = approvalHandler(approvals, hostTools, translated, emit)
                const hook: HookCallback = async (input) => {
                  if (input.hook_event_name === "PostCompact" && input.compact_summary.trim() !== "")
                    emit(
                      translated.compact({ type: "compaction", trigger: input.trigger, summary: input.compact_summary })
                    )
                  if (input.hook_event_name === "FileChanged")
                    emit([
                      {
                        type: "file-change",
                        path: input.file_path.startsWith(`${sessionOptions.directory}/`)
                          ? input.file_path.slice(sessionOptions.directory.length + 1)
                          : input.file_path,
                        event: input.event === "add" ? "create" : input.event === "unlink" ? "delete" : "modify"
                      }
                    ])
                  return {}
                }
                const queryOptions: QueryOptions = {
                  cwd: sessionOptions.directory,
                  pathToClaudeCodeExecutable: executable,
                  env: {
                    ...environment,
                    ...options.env,
                    ...model.env,
                    CLAUDE_AGENT_SDK_CLIENT_APP: "amends/0.1.0",
                    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
                    CLAUDE_CODE_USE_BEDROCK: "0",
                    CLAUDE_CODE_USE_VERTEX: "0",
                    CLAUDE_CODE_USE_FOUNDRY: "0",
                    CLAUDE_CODE_OAUTH_TOKEN: "",
                    ANTHROPIC_MODEL: model.model,
                    ENABLE_TOOL_SEARCH: "false"
                  },
                  model: model.model,
                  ...(model.effort === undefined ? {} : { effort: model.effort }),
                  ...(model.thinking === undefined ? {} : { thinking: { type: model.thinking } }),
                  ...(started ? { resume: sessionId } : { sessionId }),
                  ...(turnOptions.instructions === undefined
                    ? {}
                    : { systemPrompt: { type: "preset", preset: "claude_code", append: turnOptions.instructions } }),
                  ...(schema === undefined ? {} : { outputFormat: { type: "json_schema", schema } }),
                  includePartialMessages: true,
                  persistSession: true,
                  settingSources: [],
                  strictMcpConfig: true,
                  permissionMode: "default",
                  disallowedTools: ["AskUserQuestion"],
                  canUseTool,
                  hooks: { PostCompact: [{ hooks: [hook] }], FileChanged: [{ hooks: [hook] }] },
                  verbatimPrompts: compactPrompt === undefined,
                  mcpServers:
                    turnOptions.tools.length === 0
                      ? {}
                      : {
                          host: {
                            type: "http",
                            url: relay.url,
                            headers: { authorization: `Bearer ${Redacted.value(relaySession.token)}` }
                          }
                        },
                  allowedTools: [...hostTools]
                }
                let finished = false
                const query = yield* Effect.acquireRelease(
                  Effect.try({
                    try: () =>
                      sdk.query({ prompt: compactPrompt ?? singleMessage(userMessage), options: queryOptions }),
                    catch: unavailable
                  }),
                  (query) =>
                    Effect.sync(() => {
                      for (const resolve of approvals.values()) resolve(false, "The turn ended")
                      approvals.clear()
                      query.close()
                    })
                )
                yield* Effect.addFinalizer(() =>
                  finished
                    ? Effect.void
                    : Effect.tryPromise({ try: () => query.interrupt(), catch: unavailable }).pipe(
                        Effect.timeout("5 seconds"),
                        Effect.ignore
                      )
                )
                yield* Stream.fromAsyncIterable(query, unavailable).pipe(
                  Stream.runForEach((message) =>
                    Effect.sync(() => {
                      if (message.type === "system" && message.subtype === "init") {
                        started = true
                        history = Prompt.empty
                      }
                      if (message.type === "result") {
                        finished = true
                        started = true
                        history = Prompt.empty
                      }
                      emit(translated.consume(message))
                    })
                  ),
                  Effect.andThen(
                    Effect.suspend(() =>
                      finished
                        ? Queue.end(queue)
                        : Queue.fail(queue, unavailable("Claude's stream ended without a result"))
                    )
                  ),
                  Effect.catch((error) => Queue.fail(queue, error))
                )
              })
            )
            return Stream.merge(parts, hostCalls, { haltStrategy: "left" }).pipe(
              Stream.takeUntil((part) => part.type === "finish")
            )
          })
        )
      const session: Bridge.DriverSession = {
        keptConversation: kept,
        promptTurn: (turnOptions) => runTurn(turnOptions),
        submitToolResult: relaySession.submitToolResult,
        approve: Effect.fn("Claude.approve")(function* ({ approvalId, approved, reason }) {
          const resolve = approvals.get(approvalId)
          if (resolve === undefined)
            return yield* new HarnessError.HarnessError({
              agent: "claude",
              reason: new HarnessError.NotFoundError({ description: `Claude has no pending approval ${approvalId}` })
            })
          resolve(approved, reason)
        }),
        compact: Effect.fn("Claude.compact")(function* (instructions) {
          if (!started) return yield* unsupported("Claude cannot compact a session before its first turn")
          const parts = yield* runTurn(
            { prompt: Prompt.makeMessage("user", { content: [] }), tools: [], responseFormat: { type: "text" } },
            `/compact${instructions === undefined ? "" : ` ${instructions}`}`
          ).pipe(Stream.runCollect)
          if (parts.some((part) => part.type === "finish" && part.reason === "error"))
            return yield* new HarnessError.HarnessError({
              agent: "claude",
              reason: new HarnessError.TurnFailedError({
                description: "Claude failed to compact the conversation",
                error: parts.find((part) => part.type === "error")?.error
              })
            })
          const summary = parts.findLast((part) => part.type === "compaction")
          if (summary?.type !== "compaction")
            return yield* invalid("Claude completed /compact without a compaction summary")
          return summary
        }),
        state: Effect.sync(() => ({ sessionId })),
        destroy: Effect.gen(function* () {
          if (
            yield* Effect.tryPromise({
              try: () => sdk.hasSession(sessionId, sessionOptions.directory),
              catch: unavailable
            })
          ) {
            yield* Effect.tryPromise({
              try: () => sdk.deleteSession(sessionId, sessionOptions.directory),
              catch: unavailable
            })
          }
        })
      }
      return session
    })
  }
  return driver
})

/** SDK callback boundary: each pending promise is resolved by approve or its abort signal. */
const approvalHandler =
  (
    pending: Map<string, Approval>,
    hostTools: ReadonlySet<string>,
    translated: Turn.Turn,
    emit: (parts: ReadonlyArray<StreamPart.StreamPart>) => void
  ): CanUseTool =>
  (name, input, options) => {
    if (hostTools.has(name)) return Promise.resolve({ behavior: "allow", updatedInput: input })
    const id = options.requestId
    return new Promise<PermissionResult>((resolve) => {
      const settle: Approval = (approved, reason) => {
        pending.delete(id)
        options.signal.removeEventListener("abort", abort)
        resolve(
          approved
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: reason ?? "The host refused this tool call" }
        )
      }
      const abort = () => settle(false, "The tool call was interrupted")
      pending.set(id, settle)
      options.signal.addEventListener("abort", abort, { once: true })
      if (options.signal.aborted) {
        abort()
        return
      }
      emit([
        ...translated.call(options.toolUseID, name, input),
        { type: "tool-approval-request", approvalId: id, toolCallId: options.toolUseID }
      ])
    })
  }
