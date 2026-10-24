/**
 * opencode's server, which the bridge starts in its sandbox. One server serves every session in the
 * sandbox, each in its own directory. `start` runs the server until the scope closes, listening
 * only on 127.0.0.1, behind a password that `start` makes and gives the server in its environment.
 * `start` picks a free port for it, since opencode takes port 0 as its default port, 4096, where
 * the server of a bridge with other options may listen already. The bridge is the server's only
 * client and lives exactly as long as it, so the password is kept nowhere else. The requests the
 * bridge makes of the server are those of the API its version of opencode speaks, in `v1/api.ts`
 * and `v2/api.ts`, over the client `start` returns.
 *
 * opencode reads the configuration `start` is given from a directory that `start` makes for it and
 * removes when the scope closes, in place of the global configuration of the sandbox's user, which
 * opencode would read from under the home directory. A project's own configuration, in the
 * directory a session works in, applies over it.
 *
 * opencode's tools run with the server's environment, so the agent can read the password; it keeps
 * out everything else on the machine. A failed request fails with the `HarnessError` the driver
 * reports, naming the agent, as `requestError` maps it.
 */

import { HarnessError } from "@amends-dev/harness"
import * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Hex from "effect/encoding/Hex"
import type * as Sse from "effect/encoding/Sse"
import * as FileSystem from "effect/FileSystem"
import { flow } from "effect/Function"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as Match from "effect/Match"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import type * as Record from "effect/Record"
import * as Redacted from "effect/Redacted"
import type * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

export interface Options {
  /** The agent the server runs for, which its errors name, such as `opencode`. */
  readonly agent: string

  /** The command that runs opencode, such as `opencode`. */
  readonly command: string

  /** opencode's configuration, as its `opencode.json` takes it. */
  readonly config: { readonly [key: string]: Schema.Json }

  /** Environment variables opencode runs with. */
  readonly env: Record.ReadonlyRecord<string, string>
}

export interface Server {
  /** The agent the server runs for, which the errors of its requests name. */
  readonly agent: string

  /** Completes when the server exits, which it does before the scope closes only when it fails. */
  readonly exited: Effect.Effect<void>

  /** A client of the server, at its URL, presenting its password. It answers every status. */
  readonly client: HttpClient.HttpClient

  /** `client`, failing with the responses whose status is not a success. */
  readonly clientOk: HttpClient.HttpClient
}

/** Starts the server, which runs until the scope closes, and waits until it listens. */
export const start = Effect.fn("Server.start")(
  function* (options: Options) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const httpClient = yield* HttpClient.HttpClient
    const crypto = yield* Crypto.Crypto
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const password = Redacted.make(Hex.encode(yield* crypto.randomBytes(32)))
    // opencode reads its configuration from files alone, as here from the directory
    // `OPENCODE_CONFIG_DIR` names. The configuration holds the models' keys, so only the sandbox's
    // user can read it, as only they can read the directory.
    const configDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "opencode-config-" })
    yield* fs.writeFileString(path.join(configDirectory, "opencode.json"), JSON.stringify(options.config), {
      mode: 0o600
    })
    const port = yield* freePort
    const process = yield* spawner.spawn(
      ChildProcess.make(options.command, ["serve", "--hostname=127.0.0.1", `--port=${port}`], {
        extendEnv: true,
        env: {
          ...options.env,
          OPENCODE_CONFIG_DIR: configDirectory,
          OPENCODE_SERVER_PASSWORD: Redacted.value(password)
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "inherit",
        // opencode's server does not always stop when it is asked to, so one that has not stopped
        // soon after is killed.
        forceKillAfter: "3 seconds"
      })
    )
    const url = yield* awaitListening(options.agent, process)
    const client = httpClient.pipe(
      HttpClient.mapRequest(flow(HttpClientRequest.prependUrl(url), HttpClientRequest.basicAuth("opencode", password)))
    )
    const server: Server = {
      agent: options.agent,
      exited: Effect.ignore(process.exitCode),
      client,
      clientOk: HttpClient.filterStatusOk(client)
    }
    return server
  },
  (effect, options) =>
    effect.pipe(
      Effect.catchTag("PlatformError", (error) =>
        Effect.fail(harnessError(options.agent, new HarnessError.UnknownError({ description: error.message }), error))
      )
    )
)

/**
 * A port nothing listens on at 127.0.0.1 right now, which the server listens on next. Another
 * process taking it meanwhile leaves the server unable to listen, which fails the start.
 */
const freePort = Effect.sync(() => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => {} } })
  const { port } = listener
  listener.stop(true)
  return port
})

/**
 * The URL the server announces on its output once it listens. Fails when the server exits first,
 * or does not listen within 30 seconds. The output is read to its end, so that it never fills.
 */
const awaitListening = Effect.fnUntraced(function* (agent: string, process: ChildProcessSpawner.ChildProcessHandle) {
  const listening = yield* Deferred.make<string>()
  yield* process.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => {
      const url = /^(?:opencode )?server listening on (\S+)/.exec(line)?.[1]
      return url === undefined ? Effect.void : Deferred.succeed(listening, url)
    }),
    Effect.ignore,
    Effect.forkScoped
  )
  const unavailable = (description: string) => harnessError(agent, new HarnessError.UnavailableError({ description }))
  const exited = Effect.flatMap(process.exitCode, (code) =>
    Effect.fail(unavailable(`opencode's server exited with code ${code} before it listened`))
  )
  return yield* Deferred.await(listening).pipe(
    Effect.raceFirst(exited),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.fail(unavailable("opencode's server did not listen within 30 seconds"))
    })
  )
})

/** The error that `agent` reports for `reason`. */
export const harnessError = (agent: string, reason: HarnessError.HarnessErrorReason, cause?: unknown) =>
  new HarnessError.HarnessError({ agent, reason, cause })

/**
 * The error `agent` reports for a request that failed with `error`: `UnavailableError` for a server
 * it cannot reach, one that asks to be retried, or one that failed; `NotFoundError` for what the
 * server has no record of; `AgentContractError` for an answer the agent cannot read; and
 * `UnknownError` for the rest.
 */
export const requestError =
  (agent: string) => (error: HttpClientError.HttpClientError | Schema.SchemaError | Sse.SseError | Sse.Retry) =>
    Match.valueTags(error, {
      HttpClientError: (error) => {
        const { reason } = error
        const description = error.message
        if (Predicate.isTagged(reason, "TransportError")) {
          return harnessError(agent, new HarnessError.UnavailableError({ description }), error)
        }
        const status = Predicate.isTagged(reason, "StatusCodeError") ? reason.response.status : undefined
        return harnessError(
          agent,
          status === 404
            ? new HarnessError.NotFoundError({ description })
            : status === 429 || (status !== undefined && status >= 500)
              ? new HarnessError.UnavailableError({ description })
              : new HarnessError.UnknownError({ description }),
          error
        )
      },
      SchemaError: (error) =>
        harnessError(agent, new HarnessError.AgentContractError({ description: error.message }), error),
      SseError: (error) =>
        harnessError(agent, new HarnessError.AgentContractError({ description: error.message }), error),
      Retry: () =>
        harnessError(agent, new HarnessError.UnavailableError({ description: "opencode's server asked to be retried" }))
    })
