import { BunServices } from "@effect/platform-bun"
import { assert, it } from "@effect/vitest"
import { Effect, FileSystem, Path, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { makeInstallation, platformOf, versionIn } from "../src/internal/template.ts"

const scripted = (answer: (command: string, args: ReadonlyArray<string>) => string) => {
  const commands: Array<ReadonlyArray<string>> = []
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (!ChildProcess.isStandardCommand(command)) throw new Error("Unexpected pipeline")
      commands.push([command.command, ...command.args])
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(commands.length),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(answer(command.command, command.args))),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void)
      })
    })
  )
  return { commands, spawner }
}

it("identifies supported architectures and native version output", () => {
  assert.strictEqual(platformOf("Darwin arm64"), "darwin-arm64")
  assert.strictEqual(platformOf("Linux x86_64"), "linux-x64")
  assert.strictEqual(platformOf("Linux aarch64"), "linux-arm64")
  assert.isUndefined(platformOf("FreeBSD amd64"))
  assert.strictEqual(versionIn("codex-cli 0.157.1\n"), "0.157.1")
})

it.effect("bundles the bridge reproducibly and reuses installed programs", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = yield* fs.makeTempDirectoryScoped()
    const installation = yield* makeInstallation()
    const again = yield* makeInstallation()
    assert.strictEqual(installation.template.identity, again.template.identity)
    const [programs, bundle] = installation.template.identity.split("-")
    const directory = path.join(home, ".amends/codex", programs ?? "")
    yield* fs.makeDirectory(directory, { recursive: true })
    const fake = scripted(() => home)
    yield* installation.template.prepare.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner)
    )
    assert.strictEqual(fake.commands.length, 1)
    assert.isTrue((yield* fs.readFileString(path.join(directory, `bridge-${bundle}.js`))).includes("// @bun"))
    assert.strictEqual(
      installation.args[1],
      `exec "$HOME/.amends/codex/${programs}/bun" "$HOME/.amends/codex/${programs}/bridge-${bundle}.js"`
    )
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
)

it.effect("refuses corrupted downloads before extracting or publishing the installation", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = yield* fs.makeTempDirectoryScoped()
    const installation = yield* makeInstallation()
    const fake = scripted((command, args) =>
      command === "uname"
        ? "Linux x86_64"
        : command === "sh" && args[1] === 'printf %s "$HOME"'
          ? home
          : command === "sh"
            ? "0".repeat(128)
            : ""
    )
    const error = yield* Effect.flip(
      installation.template.prepare.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner))
    )
    assert.isTrue(error.message.includes("integrity"))
    assert.isFalse(fake.commands.some(([command]) => command === "tar"))
    assert.deepStrictEqual(yield* fs.readDirectory(path.join(home, ".amends/codex")), [])
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
)
