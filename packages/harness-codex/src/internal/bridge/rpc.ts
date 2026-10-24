/** Newline-delimited app-server RPC over a scoped child process. */

import { HarnessError } from "@amends-dev/harness"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as PubSub from "effect/PubSub"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { contractError, unavailable } from "../errors.ts"

export const Message = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Json),
  result: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.Int, message: Schema.String }))
})
export type Message = typeof Message.Type

export interface Rpc {
  readonly request: (method: string, params?: Schema.Json) => Effect.Effect<Schema.Json, HarnessError.HarnessError>
  readonly respond: (id: string | number, result: Schema.Json) => Effect.Effect<void, HarnessError.HarnessError>
  readonly reject: (id: string | number, message: string) => Effect.Effect<void, HarnessError.HarnessError>
  readonly subscribe: Effect.Effect<Stream.Stream<Message, HarnessError.HarnessError>, never, Scope.Scope>
}

export const start = Effect.fn("CodexRpc.start")(function* (options: {
  readonly command: string
  readonly args?: ReadonlyArray<string>
  readonly directory: string
  readonly env: Readonly<Record<string, string>>
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const outgoing = yield* Queue.unbounded<Uint8Array>()
  const process = yield* spawner
    .spawn(
      ChildProcess.make(options.command, options.args ?? ["app-server"], {
        cwd: options.directory,
        env: options.env,
        extendEnv: true,
        stdin: Stream.fromQueue(outgoing),
        forceKillAfter: "3 seconds"
      })
    )
    .pipe(Effect.mapError((cause) => unavailable("Could not start Codex app-server", cause)))
  yield* process.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped)
  const rpc = yield* make(Stream.decodeText(process.stdout).pipe(Stream.splitLines), (message) =>
    Queue.offer(outgoing, new TextEncoder().encode(`${JSON.stringify(message)}\n`)).pipe(Effect.asVoid)
  )
  yield* rpc.request("initialize", {
    clientInfo: { name: "amends", title: "Amends", version: "0.1.0" },
    capabilities: { experimentalApi: true }
  })
  yield* Queue.offer(outgoing, new TextEncoder().encode('{"method":"initialized"}\n'))
  return rpc
})

/** The protocol independent of the process, so tests exercise the actual framing and dispatch. */
export const make = Effect.fn("CodexRpc.make")(function* <E>(
  lines: Stream.Stream<string, E>,
  write: (message: Schema.Json) => Effect.Effect<void, HarnessError.HarnessError>
) {
  const pending = new Map<number, Deferred.Deferred<Schema.Json, HarnessError.HarnessError>>()
  const sequence = yield* Ref.make(0)
  const events = yield* PubSub.unbounded<Message>()
  const failed = yield* Deferred.make<never, HarnessError.HarnessError>()
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Message))
  const dispatch = Effect.fn("CodexRpc.dispatch")(function* (line: string) {
    if (line.trim() === "") return
    const message = yield* decode(line).pipe(
      Effect.mapError((cause) => contractError("Invalid Codex RPC message", cause))
    )
    if (message.method !== undefined) {
      yield* PubSub.publish(events, message)
    } else if (typeof message.id === "number") {
      const waiter = pending.get(message.id)
      if (waiter === undefined) return
      if (message.error !== undefined) {
        const { code, message: description } = message.error
        const reason = /no rollout found|thread .*not found|thread not found/i.test(description)
          ? new HarnessError.NotFoundError({ description })
          : code === -32602 || code === -32600 || code === -32601
            ? new HarnessError.AgentContractError({ description })
            : new HarnessError.UnknownError({ description })
        yield* Deferred.fail(waiter, new HarnessError.HarnessError({ agent: "codex", reason }))
      } else if (message.result !== undefined) {
        yield* Deferred.succeed(waiter, message.result)
      } else {
        yield* Deferred.fail(waiter, contractError("Codex RPC response has neither result nor error"))
      }
    } else {
      return yield* contractError("Codex RPC message has no method or numeric response id")
    }
  })
  yield* lines.pipe(
    Stream.mapError((cause) => unavailable("Codex app-server output failed", cause)),
    Stream.runForEach(dispatch),
    Effect.andThen(Effect.fail(unavailable("Codex app-server exited before the session closed"))),
    Effect.catch((error) => Deferred.fail(failed, error)),
    Effect.forkScoped
  )
  const send = (message: Schema.Json) => write(message).pipe(Effect.raceFirst(Deferred.await(failed)))
  const request: Rpc["request"] = Effect.fn("CodexRpc.request")(function* (method, params) {
    const id = yield* Ref.updateAndGet(sequence, (value) => value + 1)
    const result = yield* Deferred.make<Schema.Json, HarnessError.HarnessError>()
    pending.set(id, result)
    return yield* Effect.gen(function* () {
      yield* send({ id, method, ...(params === undefined ? {} : { params }) })
      return yield* Deferred.await(result).pipe(Effect.raceFirst(Deferred.await(failed)))
    }).pipe(
      Effect.timeoutOrElse({
        duration: "60 seconds",
        orElse: () => Effect.fail(unavailable(`Codex did not answer ${method}`))
      }),
      Effect.ensuring(Effect.sync(() => pending.delete(id)))
    )
  })
  const rpc: Rpc = {
    request,
    respond: (id, result) => send({ id, result }),
    reject: (id, message) => send({ id, error: { code: -32601, message } }),
    subscribe: Effect.map(PubSub.subscribe(events), (subscription) =>
      Stream.merge(Stream.fromSubscription(subscription), Stream.fromEffect(Deferred.await(failed)))
    )
  }
  return rpc
})
