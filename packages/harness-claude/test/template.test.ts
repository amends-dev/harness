import { BunServices } from "@effect/platform-bun"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { makeInstallation, platformOf, versionIn } from "../src/internal/template.ts"

it("recognizes supported platforms and native Claude version output", () => {
  expect(platformOf("Darwin arm64")).toBe("darwin-arm64")
  expect(platformOf("Linux x86_64")).toBe("linux-x64")
  expect(platformOf("FreeBSD amd64")).toBeUndefined()
  expect(versionIn("2.1.302 (Claude Code)")).toBe("2.1.302")
  expect(versionIn("1.3.14")).toBe("1.3.14")
})
it.effect("builds a content-addressed self-contained bridge installation", () =>
  Effect.gen(function* () {
    const installed = yield* makeInstallation()
    expect(installed.template.name).toBe("claude")
    expect(installed.template.identity).toMatch(/^[a-f0-9]{16}-[a-f0-9]{16}$/)
    expect(installed.command).toBe("sh")
    expect(installed.args[1]).toMatch(/exec "\$HOME\/\.amends\/claude\/[a-f0-9]{16}\/bun"/)
  }).pipe(Effect.provide(BunServices.layer))
)

const scripted = (answer: (command: string, args: ReadonlyArray<string>) => string) => {
  const ran: Array<ReadonlyArray<string>> = []
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (!ChildProcess.isStandardCommand(command)) throw new Error("Unexpected pipeline")
      ran.push([command.command, ...command.args])
      const output = answer(command.command, command.args)
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(ran.length),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
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
    })
  )
  return { ran, spawner }
}
it.effect("reuses a complete installation without downloads", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = yield* fs.makeTempDirectoryScoped()
    const installed = yield* makeInstallation()
    const matches = [...(installed.args[1] ?? "").matchAll(/"\$HOME\/([^"]+)"/g)]
    const bridge = matches[1]?.[1]
    if (bridge === undefined) throw new Error("Missing installed bridge path")
    yield* fs.makeDirectory(path.dirname(path.join(home, bridge)), { recursive: true })
    yield* fs.writeFileString(path.join(home, bridge), "kept")
    const commands = scripted(() => home)
    yield* installed.template.prepare.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, commands.spawner)
    )
    expect(commands.ran).toHaveLength(1)
    expect(yield* fs.readFileString(path.join(home, bridge))).toBe("kept")
  }).pipe(Effect.provide(BunServices.layer))
)
it.effect("rejects tampered package downloads before extraction and cleans staging", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const home = yield* fs.makeTempDirectoryScoped()
    const installed = yield* makeInstallation()
    const commands = scripted((command, args) =>
      command === "uname"
        ? "Linux x86_64"
        : command === "sh" && args[1]?.startsWith("printf")
          ? home
          : command === "sh"
            ? "0".repeat(128)
            : ""
    )
    const error = yield* installed.template.prepare.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, commands.spawner),
      Effect.flip
    )
    expect(error.reason).toMatchObject({ _tag: "InvalidData" })
    expect(commands.ran.some(([command]) => command === "tar")).toBe(false)
    expect(yield* fs.readDirectory(`${home}/.amends/claude`)).toEqual([])
  }).pipe(Effect.provide(BunServices.layer))
)
