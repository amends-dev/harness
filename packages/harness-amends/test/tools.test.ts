import { BunServices } from "@effect/platform-bun"
import { expect, layer } from "@effect/vitest"
import { Duration, Effect, Path, Stream } from "effect"
import type { Tool } from "effect/ai"
import { TestClock } from "effect/testing"
import * as Tools from "../src/Tools.ts"
import { makeSandbox } from "./fixtures.ts"

type ToolsByName = typeof Tools.toolkit.tools

/**
 * The tools working in a session's directory in a new local sandbox, called as the model calls them:
 * by name, with encoded params, getting back the result the model reads.
 */
const makeTools = (options?: Parameters<typeof Tools.layer>[1]) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const sandbox = yield* makeSandbox
    const workspace = { sandbox, directory: path.join(sandbox.workingDirectory, "session-one") }
    yield* sandbox.fileSystem.makeDirectory(workspace.directory)
    const toolkit = yield* Effect.provide(Tools.toolkit, Tools.layer(workspace, options))

    const call = <Name extends keyof ToolsByName>(name: Name, params: Tool.ParametersEncoded<ToolsByName[Name]>) =>
      Effect.flatMap(toolkit.handle(name, params), Stream.runCollect).pipe(
        // The tools stream no preliminary results, only the one the model reads.
        Effect.map(([handled]) => ({
          isFailure: handled?.isFailure,
          result: handled?.encodedResult
        }))
      )

    return { call, workspace, fs: sandbox.fileSystem, path }
  })

layer(BunServices.layer)("Tools", (it) => {
  it.effect("writes a file, creating its directories, and reads it back", () =>
    Effect.gen(function* () {
      const { call } = yield* makeTools()

      const written = yield* call("write", { file_path: "notes/today.md", content: "# Today\n" })
      const read = yield* call("read", { file_path: "notes/today.md" })

      expect(written).toEqual({ isFailure: false, result: "Wrote notes/today.md" })
      expect(read).toEqual({ isFailure: false, result: "# Today\n" })
    })
  )

  it.effect("resolves paths against the session's directory, and takes absolute ones in it", () =>
    Effect.gen(function* () {
      const { call, workspace, fs, path } = yield* makeTools()

      yield* call("write", { file_path: "relative.txt", content: "relative" })
      const absolute = path.join(workspace.directory, "absolute.txt")
      yield* call("write", { file_path: absolute, content: "absolute" })

      expect(yield* fs.readFileString(path.join(workspace.directory, "relative.txt"))).toBe("relative")
      expect(yield* fs.readFileString(absolute)).toBe("absolute")
      expect(yield* fs.exists(path.join(workspace.sandbox.workingDirectory, "relative.txt"))).toBe(false)
    })
  )

  it.effect("answers the model that a path outside the session's directory is, without touching it", () =>
    Effect.gen(function* () {
      const { call, workspace, fs, path } = yield* makeTools()
      const outside = (file: string) => `${file} is outside the session's directory, ${workspace.directory}`

      const read = yield* call("read", { file_path: "../secret.txt" })
      const written = yield* call("write", { file_path: "../escaped.txt", content: "x" })
      const edited = yield* call("edit", {
        file_path: "/etc/hosts",
        old_string: "localhost",
        new_string: "elsewhere"
      })
      const named = yield* call("write", { file_path: "..notes", content: "inside" })

      expect(read).toEqual({ isFailure: true, result: outside("../secret.txt") })
      expect(written).toEqual({ isFailure: true, result: outside("../escaped.txt") })
      expect(edited).toEqual({ isFailure: true, result: outside("/etc/hosts") })
      expect(yield* fs.exists(path.join(workspace.sandbox.workingDirectory, "escaped.txt"))).toBe(false)
      // A name that starts with two dots is still inside.
      expect(named).toEqual({ isFailure: false, result: "Wrote ..notes" })
    })
  )

  it.effect("answers the model when a file cannot be read", () =>
    Effect.gen(function* () {
      const { call } = yield* makeTools()

      const read = yield* call("read", { file_path: "missing.txt" })

      expect(read.isFailure).toBe(true)
      expect(read.result).toEqual(expect.stringContaining("missing.txt"))
    })
  )

  it.effect("replaces text that appears once, taking the new text literally", () =>
    Effect.gen(function* () {
      const { call } = yield* makeTools()
      yield* call("write", { file_path: "greeting.txt", content: "hello world" })

      const edited = yield* call("edit", {
        file_path: "greeting.txt",
        old_string: "world",
        new_string: "$& and $1"
      })

      expect(edited).toEqual({ isFailure: false, result: "Edited greeting.txt" })
      expect(yield* call("read", { file_path: "greeting.txt" })).toEqual({
        isFailure: false,
        result: "hello $& and $1"
      })
    })
  )

  it.effect("reads the lines asked for, saying how many lines follow them", () =>
    Effect.gen(function* () {
      const { call } = yield* makeTools()
      const lines = Array.from({ length: 5 }, (_, index) => `line ${index + 1}`)
      yield* call("write", { file_path: "lines.txt", content: `${lines.join("\n")}\n` })

      const first = yield* call("read", { file_path: "lines.txt", limit: 2 })
      const middle = yield* call("read", { file_path: "lines.txt", offset: 2, limit: 2 })
      const last = yield* call("read", { file_path: "lines.txt", offset: 4 })
      const beyond = yield* call("read", { file_path: "lines.txt", offset: 9 })

      expect(first).toEqual({
        isFailure: false,
        result: "line 1\nline 2\n[3 more lines after line 2]\n"
      })
      expect(middle).toEqual({
        isFailure: false,
        result: "line 2\nline 3\n[2 more lines after line 3]\n"
      })
      expect(last).toEqual({ isFailure: false, result: "line 4\nline 5\n" })
      expect(beyond).toEqual({ isFailure: false, result: "" })
    })
  )

  it.effect("replaces every occurrence with replace_all", () =>
    Effect.gen(function* () {
      const { call } = yield* makeTools()
      yield* call("write", { file_path: "notes.txt", content: "one two one" })

      const edited = yield* call("edit", {
        file_path: "notes.txt",
        old_string: "one",
        new_string: "1",
        replace_all: true
      })

      expect(edited).toEqual({ isFailure: false, result: "Edited notes.txt in 2 places" })
      expect(yield* call("read", { file_path: "notes.txt" })).toEqual({
        isFailure: false,
        result: "1 two 1"
      })
    })
  )

  it.effect("refuses an edit whose text is empty, missing, or appears more than once, leaving the file", () =>
    Effect.gen(function* () {
      const { call } = yield* makeTools()
      yield* call("write", { file_path: "notes.txt", content: "one two one" })

      const empty = yield* call("edit", {
        file_path: "notes.txt",
        old_string: "",
        new_string: "0"
      })
      const missing = yield* call("edit", {
        file_path: "notes.txt",
        old_string: "three",
        new_string: "3"
      })
      const repeated = yield* call("edit", {
        file_path: "notes.txt",
        old_string: "one",
        new_string: "1"
      })

      expect(empty).toEqual({
        isFailure: true,
        result: "old_string is empty: give the text to replace"
      })
      expect(missing).toEqual({ isFailure: true, result: "old_string is not in notes.txt" })
      expect(repeated).toEqual({
        isFailure: true,
        result:
          "old_string appears 2 times in notes.txt: include more of the text around it, or " +
          "replace them all with replace_all"
      })
      expect(yield* call("read", { file_path: "notes.txt" })).toEqual({
        isFailure: false,
        result: "one two one"
      })
    })
  )

  it.effect("runs a command in the session's directory, returning its exit code and its output", () =>
    Effect.gen(function* () {
      const { call, workspace, fs } = yield* makeTools()

      const located = yield* call("bash", { command: "pwd -P" })
      const failed = yield* call("bash", { command: "echo failed >&2; exit 3" })

      expect(located).toEqual({
        isFailure: false,
        result: { exitCode: 0, output: `${yield* fs.realPath(workspace.directory)}\n` }
      })
      // A command that fails still answers the model, with its stderr in the output.
      expect(failed).toEqual({ isFailure: false, result: { exitCode: 3, output: "failed\n" } })
    })
  )

  it.effect("keeps the start and end of a command's long output, saying how much it dropped", () =>
    Effect.gen(function* () {
      const { call } = yield* makeTools()
      const half = Tools.maxOutputLength / 2

      const { result } = yield* call("bash", {
        command: `printf 'a%.0s' $(seq ${half}); printf 'b%.0s' $(seq 10); printf 'c%.0s' $(seq ${half})`
      })

      expect(result).toEqual({
        exitCode: 0,
        output: `${"a".repeat(half)}\n[10 characters of output dropped]\n${"c".repeat(half)}`
      })
    })
  )

  it.effect("kills a command that outruns its timeout, answering the model with its output", () =>
    Effect.gen(function* () {
      const { call } = yield* makeTools({ commandTimeout: Duration.millis(300) })

      // The command runs on this machine, so its timeout runs on the live clock.
      const timedOut = yield* TestClock.withLive(call("bash", { command: "echo started; sleep 30 & wait" }))

      expect(timedOut).toEqual({
        isFailure: true,
        result: "The command did not finish within 300ms and was killed. Its output:\nstarted\n"
      })
    })
  )
})
