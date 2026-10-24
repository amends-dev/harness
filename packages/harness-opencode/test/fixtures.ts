import { type Agent, BridgeClient } from "@amends-dev/harness"
import { Network, type Template } from "@amends-dev/sandbox"
import { LocalSandboxProvider } from "@amends-dev/sandbox-local"
import { type Crypto, Effect, FileSystem, Path } from "effect"
import type { Socket } from "effect/socket"

/**
 * A new sandbox on this machine, prepared with `template` if given, and destroyed with the
 * processes it runs, such as opencode's server, when the scope closes.
 */
export const makeSandbox = (template?: Template.Template) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const provider = yield* LocalSandboxProvider.make({
      directory: yield* fs.makeTempDirectoryScoped()
    })
    return yield* provider.createScoped(template === undefined ? {} : { template })
  })

/**
 * An agent reached through the bridge that `bridge` describes, as opencode's agent reaches its own,
 * for tests that launch a bridge program of their choosing.
 */
export const makeBridgedAgent = (bridge: BridgeClient.Options) =>
  Effect.map(Effect.context<Socket.WebSocketConstructor | Crypto.Crypto>(), (services): Agent.Agent => ({
    id: bridge.id,
    requiresSandbox: true,
    template: bridge.template,
    createSession: (sessionOptions) => Effect.provide(BridgeClient.createSession(bridge, sessionOptions), services)
  }))

/**
 * The stand-in for `opencode serve` in `fake-opencode-server.js`, installed as a command that runs
 * on this Bun, in a directory of its own, where it records its starts.
 */
export const installStandIn = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped()
  const command = path.join(directory, "opencode")
  const source = yield* fs.readFileString(path.join(import.meta.dirname, "fake-opencode-server.js"))
  yield* fs.writeFileString(command, `#!${process.execPath}\n${source}`)
  yield* fs.chmod(command, 0o755)
  return { command, directory }
})

/** How the stand-in installed in `directory` was started, once for each start. */
export const startsIn = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const starts = yield* fs.readFileString(path.join(directory, "starts.jsonl"))
    return starts
      .trim()
      .split("\n")
      .map((line): { readonly pid: number; readonly configDirectory: string } => JSON.parse(line))
  })

/**
 * Whether a process with the id `pid` runs on this machine, or has exited without its parent
 * learning so yet.
 */
export const isRunning = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  })

/** The tokens of a step that used `input` and `output` tokens, none of them cached or reasoning. */
export const tokens = (input: number, output: number) => ({
  input,
  output,
  reasoning: 0,
  cache: { read: 0, write: 0 }
})

/** A proxy on this machine, whose connections a test can drop. */
export interface Proxy {
  /** The port the proxy listens on. */
  readonly port: Network.Port

  /** Closes every connection through the proxy, which takes new ones as before. */
  readonly drop: Effect.Effect<void>
}

/** A proxy to the port `upstream` names at each connection, stopped when the scope closes. */
export const makeProxy = (upstream: () => number) =>
  Effect.map(
    Effect.acquireRelease(
      Effect.sync(() => {
        /** A connection to the proxy, and the one it opened to `port` for it. */
        interface Pair {
          upstream: Bun.Socket<undefined> | undefined
          /** What arrived before the upstream connection opened. */
          pending: Array<Uint8Array>
        }
        const pairs = new Set<Bun.Socket<Pair>>()
        const listener = Bun.listen<Pair>({
          hostname: "127.0.0.1",
          port: 0,
          socket: {
            open: (client) => {
              const pair: Pair = { upstream: undefined, pending: [] }
              client.data = pair
              pairs.add(client)
              // A port nothing listens on yet refuses the connection, which then closes.
              Bun.connect({
                hostname: "127.0.0.1",
                port: upstream(),
                socket: {
                  open: (upstream) => {
                    pair.upstream = upstream
                    for (const chunk of pair.pending) upstream.write(chunk)
                    pair.pending = []
                  },
                  data: (_upstream, chunk) => void client.write(chunk),
                  close: () => void client.end(),
                  error: () => void client.end()
                }
              }).catch(() => client.end())
            },
            data: (client, chunk) => {
              const { upstream, pending } = client.data
              if (upstream === undefined) pending.push(chunk)
              else upstream.write(chunk)
            },
            close: (client) => {
              client.data.upstream?.end()
              pairs.delete(client)
            }
          }
        })
        const drop = Effect.sync(() => {
          for (const client of pairs) client.end()
        })
        return { listener, drop }
      }),
      ({ listener }) => Effect.sync(() => listener.stop(true))
    ),
    ({ listener, drop }): Proxy => ({ port: Network.Port.make(listener.port), drop })
  )
