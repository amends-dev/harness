import { Deferred, Effect, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export interface FakeServerProcesses {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]

  /** The commands spawned, in order. */
  readonly spawned: ReadonlyArray<ChildProcess.Command>

  /** Ends every server spawned so far, as when opencode's server crashes. */
  readonly exit: Effect.Effect<void>
}

/**
 * A process spawner whose every process is opencode's server, announcing that it listens at `url`,
 * where a fake opencode serves, and running until `exit` or until the scope that spawned it closes.
 * The first `failing` servers exit before they listen, as a server that fails to start does.
 */
export const makeFakeServerProcesses = (url: string, options: { readonly failing?: number } = {}) =>
  Effect.gen(function* () {
    const spawned: Array<ChildProcess.Command> = []
    const exited = yield* Deferred.make<void>()
    const exitCode = ChildProcessSpawner.ExitCode(1)
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        spawned.push(command)
        const fails = spawned.length <= (options.failing ?? 0)
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(spawned.length),
          exitCode: fails ? Effect.succeed(exitCode) : Effect.as(Deferred.await(exited), exitCode),
          isRunning: Effect.map(Deferred.isDone(exited), (done) => !fails && !done),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: fails ? Stream.empty : Stream.encodeText(Stream.make(`opencode server listening on ${url}\n`)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        })
      })
    )
    const processes: FakeServerProcesses = {
      spawner,
      spawned,
      exit: Effect.asVoid(Deferred.succeed(exited, undefined))
    }
    return processes
  })

export interface ScriptedCommands {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]

  /** Each command run, with its arguments, in order. */
  readonly ran: ReadonlyArray<ReadonlyArray<string>>
}

/**
 * A process spawner that runs nothing, but answers each command with the output and exit code
 * `answer` gives it: none and 0 unless it says otherwise.
 */
export const makeScriptedCommands = (
  answer: (command: string, args: ReadonlyArray<string>) => { readonly output?: string; readonly code?: number }
): ScriptedCommands => {
  const ran: Array<ReadonlyArray<string>> = []
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.suspend(() => {
      if (!ChildProcess.isStandardCommand(command)) return Effect.die("Scripted commands are not piped")
      ran.push([command.command, ...command.args])
      const { output = "", code = 0 } = answer(command.command, command.args)
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(ran.length),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.encodeText(Stream.make(output)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        })
      )
    })
  )
  return { spawner, ran }
}
