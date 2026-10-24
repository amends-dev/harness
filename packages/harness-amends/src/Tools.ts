/**
 * The tools the agent works with in a session's sandbox: reading, writing, and editing files, and
 * running shell commands. Their names and inputs are those of Claude Code's and opencode's tools,
 * so a model meets the tools it knows whichever agent runs it; searching goes through `bash`, with
 * `grep` and `find`.
 *
 * File paths resolve against the session's directory, and the tools refuse a path that names a place
 * outside it. That keeps the model's work in its directory but confines nothing: a symbolic link in
 * the directory can lead outside it, and `bash`, which runs a shell in the directory, can reach
 * anything the sandbox can. `bash` kills a command that outruns its timeout. A tool that cannot do
 * what it was asked, such as an `edit` whose text is not in the file, answers the model with why,
 * so the model can try again, instead of failing the turn.
 *
 * @since 0.1.0
 */

import type { Agent } from "@amends-dev/harness"
import { Sandbox } from "@amends-dev/sandbox"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

/**
 * Reads a text file in the session's directory, answering with its contents: all of it, or
 * `limit` lines from line `offset`, `defaultReadLimit` lines from the first by default, saying how
 * many lines follow.
 *
 * @category tools
 * @since 0.1.0
 */
export const Read = Tool.make("read", {
  description:
    "Reads a text file and returns its contents: `limit` lines from line `offset`, the first 2000 " +
    "lines by default, saying how many lines follow them.",
  parameters: Schema.Struct({
    file_path: Schema.String,
    offset: Schema.optionalKey(Schema.Int),
    limit: Schema.optionalKey(Schema.Int)
  }),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return"
})

/**
 * Writes a text file in the session's directory, replacing one that exists and creating the
 * directories it needs.
 *
 * @category tools
 * @since 0.1.0
 */
export const Write = Tool.make("write", {
  description: "Writes a text file, replacing it if it exists and creating its directories if not.",
  parameters: Schema.Struct({ file_path: Schema.String, content: Schema.String }),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return"
})

/**
 * Replaces a text in a file in the session's directory: the one place it appears, or every place
 * with `replace_all`, answering with why when the text is not there once.
 *
 * @category tools
 * @since 0.1.0
 */
export const Edit = Tool.make("edit", {
  description:
    "Replaces `old_string` in a text file with `new_string`. `old_string` must appear exactly once: " +
    "include enough of the text around it to pick out one place. With `replace_all`, every " +
    "occurrence is replaced instead.",
  parameters: Schema.Struct({
    file_path: Schema.String,
    old_string: Schema.String,
    new_string: Schema.String,
    replace_all: Schema.optionalKey(Schema.Boolean)
  }),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return"
})

/**
 * Runs a shell command in the session's directory, answering with its exit code and its output,
 * stdout and stderr interleaved, of which long output keeps its start and end.
 *
 * **Details**
 *
 * A command that outruns the timeout is killed.
 *
 * @category tools
 * @since 0.1.0
 */
export const Bash = Tool.make("bash", {
  description:
    "Runs a shell command in the session's directory and returns its exit code and its output, " +
    "with stdout and stderr interleaved. Long output keeps its start and end. A command that runs " +
    "too long is killed.",
  parameters: Schema.Struct({ command: Schema.String }),
  success: Schema.Struct({ exitCode: Schema.Int, output: Schema.String }),
  failure: Schema.String,
  failureMode: "return"
})

/**
 * The agent's tools, as the toolkit a turn offers the model with the handlers `layer` gives them.
 *
 * @category tools
 * @since 0.1.0
 */
export const toolkit = Toolkit.make(Read, Write, Edit, Bash)

/**
 * The most lines `read` returns unless asked for a `limit`.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultReadLimit = 2000

/**
 * How long a `bash` command runs before it is killed, unless the layer is given another.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultCommandTimeout = Duration.minutes(2)

/**
 * The most characters of a command's output `bash` returns: the start and end, half each.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxOutputLength = 30_000

/** How long a killed command has to exit before it is killed by force. */
const killGracePeriod = Duration.seconds(2)

/**
 * The tools' handlers, working in `workspace`: its sandbox's file system and processes, in its
 * directory.
 *
 * **Details**
 *
 * `commandTimeout` is how long a `bash` command runs before it is killed, `defaultCommandTimeout`
 * by default.
 *
 * **Example** (Running a command in a session's directory, as the model would)
 *
 * ```ts
 * import type { Agent } from "@amends-dev/harness"
 * import { Tools } from "@amends-dev/harness-amends"
 * import { Effect, Stream } from "effect"
 *
 * declare const workspace: Agent.Workspace // the session's sandbox and directory
 *
 * const program = Effect.gen(function* () {
 *   const toolkit = yield* Effect.provide(Tools.toolkit, Tools.layer(workspace))
 *   const handled = yield* toolkit.handle("bash", { command: "ls" })
 *   const [result] = yield* Stream.runCollect(handled)
 *   return result?.encodedResult
 * })
 * ```
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  workspace: Agent.Workspace,
  options: { readonly commandTimeout?: Duration.Duration | undefined } = {}
) =>
  toolkit.toLayer(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const commandTimeout = options.commandTimeout ?? defaultCommandTimeout

      /**
       * The absolute path `filePath` names, failing when it names a place outside the session's
       * directory. It reads the path alone, not where a symbolic link in it leads.
       */
      const resolve = (filePath: string) => {
        const resolved = path.resolve(workspace.directory, filePath)
        const relative = path.relative(workspace.directory, resolved)
        const outside = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
        return outside
          ? Effect.fail(`${filePath} is outside the session's directory, ${workspace.directory}`)
          : Effect.succeed(resolved)
      }

      return toolkit.of({
        read: Effect.fn("Tools.read")(function* ({ file_path, offset, limit }) {
          const resolved = yield* resolve(file_path)
          const text = yield* fs.readFileString(resolved).pipe(Effect.mapError((error) => error.message))
          return linesOf(text, offset ?? 1, limit ?? defaultReadLimit)
        }),

        write: Effect.fn("Tools.write")(function* ({ file_path, content }) {
          const resolved = yield* resolve(file_path)
          yield* Effect.andThen(
            fs.makeDirectory(path.dirname(resolved), { recursive: true }),
            fs.writeFileString(resolved, content)
          ).pipe(Effect.mapError((error) => error.message))
          return `Wrote ${file_path}`
        }),

        edit: Effect.fn("Tools.edit")(function* ({ file_path, old_string, new_string, replace_all = false }) {
          if (old_string === "") {
            return yield* Effect.fail("old_string is empty: give the text to replace")
          }
          const resolved = yield* resolve(file_path)
          const text = yield* fs.readFileString(resolved).pipe(Effect.mapError((error) => error.message))
          const pieces = text.split(old_string)
          const occurrences = pieces.length - 1
          if (occurrences === 0) return yield* Effect.fail(`old_string is not in ${file_path}`)
          if (occurrences > 1 && !replace_all) {
            return yield* Effect.fail(
              `old_string appears ${occurrences} times in ${file_path}: include more of the text ` +
                "around it, or replace them all with replace_all"
            )
          }
          yield* fs
            .writeFileString(
              resolved,
              replace_all ? pieces.join(new_string) : text.replace(old_string, () => new_string)
            )
            .pipe(Effect.mapError((error) => error.message))
          return occurrences === 1 ? `Edited ${file_path}` : `Edited ${file_path} in ${occurrences} places`
        }),

        bash: Effect.fn("Tools.bash")(function* ({ command }) {
          const output = yield* Ref.make(noOutput)
          // Closing the scope kills the command, with any processes it started, if it still runs.
          const exitCode = yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(
                ChildProcess.make("sh", ["-c", command], {
                  cwd: workspace.directory,
                  forceKillAfter: killGracePeriod
                })
              )
              const [, code] = yield* Effect.all(
                [
                  Stream.runForEach(Stream.decodeText(handle.all), (text) =>
                    Ref.update(output, (kept) => keepOutput(kept, text))
                  ),
                  handle.exitCode
                ],
                { concurrency: "unbounded" }
              )
              return code
            })
          ).pipe(
            Effect.mapError((error) => error.message),
            Effect.timeoutOption(commandTimeout)
          )
          const text = textOf(yield* Ref.get(output))
          if (Option.isNone(exitCode)) {
            return yield* Effect.fail(
              `The command did not finish within ${Duration.format(commandTimeout)} and was killed. ` +
                `Its output:\n${text}`
            )
          }
          return { exitCode: exitCode.value, output: text }
        })
      })
    }).pipe(Effect.provide(Sandbox.layerServices(workspace.sandbox)))
  )

/**
 * `count` lines of `text` from line `from`, as they are, with how many lines follow them. The
 * whole text, as it is, when the lines asked for hold it.
 */
const linesOf = (text: string, from: number, count: number) => {
  const lines = text.split("\n")
  // A text that ends with a newline ends there, not with an empty line after it.
  if (lines.at(-1) === "") lines.pop()
  const start = Math.max(from, 1) - 1
  if (start === 0 && lines.length <= count) return text
  const end = Math.min(start + Math.max(count, 0), lines.length)
  const page = lines
    .slice(start, end)
    .map((line) => `${line}\n`)
    .join("")
  const following = lines.length - end
  return following === 0 ? page : `${page}[${following} more lines after line ${end}]\n`
}

/**
 * The output of a command that `bash` keeps: its start, its end so far, and how many characters
 * between them it dropped.
 */
interface Output {
  readonly start: string
  readonly end: string
  readonly dropped: number
}

const noOutput: Output = { start: "", end: "", dropped: 0 }

/** `kept` followed by `text`, keeping at most half of `maxOutputLength` at each end. */
const keepOutput = (kept: Output, text: string): Output => {
  const half = maxOutputLength / 2
  const toStart = text.slice(0, Math.max(half - kept.start.length, 0))
  const end = kept.end + text.slice(toStart.length)
  const dropped = Math.max(end.length - half, 0)
  return { start: kept.start + toStart, end: end.slice(dropped), dropped: kept.dropped + dropped }
}

/** The output `bash` returns, saying where it dropped some. */
const textOf = ({ start, end, dropped }: Output) =>
  dropped === 0 ? start + end : `${start}\n[${dropped} characters of output dropped]\n${end}`
