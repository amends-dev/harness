import { dirname } from "node:path"
import { Harness } from "@amends-dev/harness"
import { SessionId } from "@amends-dev/harness/Agent"
import { Sandbox } from "@amends-dev/sandbox"
import { BunServices, BunSocket } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, Redacted } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { type Installation, makeInstallation, platformOf, versionIn } from "../src/internal/template.ts"
import { makeScriptedCommands } from "./fakes.ts"
import { makeBridgedAgent, makeSandbox } from "./fixtures.ts"

/**
 * `make` bundles the bridge program with the Bun running the tests. The template it gives runs on
 * this machine, in a home directory of the test's own, with the commands it runs answered as a
 * sandbox would answer them. Installing for real downloads Bun and opencode, so it runs only with
 * `AMENDS_TEST_OPENCODE=1`.
 */
const enabled = process.env.AMENDS_TEST_OPENCODE === "1"

const homeLookup = ["sh", "-c", 'printf %s "$HOME"']

/** Where `installation` launches Bun and the bridge program from, relative to the home directory. */
const launchedFrom = (installation: Installation) => {
  const [bun = "", bridge = ""] = [...(installation.args[1] ?? "").matchAll(/"\$HOME\/([^"]+)"/g)].map(
    ([, file]) => file
  )
  return { bun, bridge }
}

/**
 * Commands as a sandbox whose home is `home` answers them: the home lookup with `home`, and every
 * other command as `answer` says.
 */
const makeSandboxCommands = (
  home: string,
  answer: (
    command: string,
    args: ReadonlyArray<string>
  ) => { readonly output?: string; readonly code?: number } = () => ({})
) => {
  const commands = makeScriptedCommands((command, args) =>
    [command, ...args].join(" ") === homeLookup.join(" ") ? { output: home } : answer(command, args)
  )
  return {
    ran: commands.ran,
    /** Runs `effect`, such as a template's `prepare`, with these commands. */
    provide: Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, commands.spawner)
  }
}

/** `spawner`, running each command with `home` as its home directory, as in a sandbox of its own. */
const withHome = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"], home: string) =>
  ChildProcessSpawner.make((command) =>
    spawner.spawn(
      ChildProcess.isStandardCommand(command)
        ? ChildProcess.make(command.command, command.args, {
            ...command.options,
            env: { ...command.options.env, HOME: home },
            extendEnv: command.options.env === undefined || command.options.extendEnv
          })
        : command
    )
  )

describe("Template", () => {
  it("names the platform `uname -sm` prints, and none the bridge does not install on", () => {
    expect(platformOf("Darwin arm64\n")).toBe("darwin-arm64")
    expect(platformOf("Darwin x86_64")).toBe("darwin-x64")
    expect(platformOf("Linux aarch64")).toBe("linux-arm64")
    expect(platformOf("Linux x86_64")).toBe("linux-x64")
    expect(platformOf("Linux armv7l")).toBeUndefined()
    expect(platformOf("FreeBSD amd64")).toBeUndefined()
  })

  it("reads the version a program prints, alone or after its name", () => {
    expect(versionIn("1.3.14\n")).toBe("1.3.14")
    expect(versionIn("opencode v2.0.26\n")).toBe("2.0.26")
  })

  it.effect("launches the bridge from where the template installs it, under the same identity", () =>
    Effect.gen(function* () {
      const installation = yield* makeInstallation(2)
      const again = yield* makeInstallation(2)
      const [programs, bundle] = installation.template.identity.split("-")

      expect(again.template.identity).toBe(installation.template.identity)
      expect(installation.command).toBe("sh")
      expect(launchedFrom(installation)).toEqual({
        bun: `.amends/opencode/${programs}/bun`,
        bridge: `.amends/opencode/${programs}/bridge-${bundle}.js`
      })
    }).pipe(Effect.provide(BunServices.layer))
  )

  it.effect("installs each agent's own programs and bridge program", () =>
    Effect.gen(function* () {
      const [one, two] = yield* Effect.all([makeInstallation(1), makeInstallation(2)])

      expect([one.template.name, two.template.name]).toEqual(["opencode", "opencode2"])
      expect(dirname(launchedFrom(one).bun)).not.toBe(dirname(launchedFrom(two).bun))
      expect(launchedFrom(one).bridge).not.toBe(launchedFrom(two).bridge)
      expect(one.template.identity).not.toBe(two.template.identity)
    }).pipe(Effect.provide(BunServices.layer))
  )

  it.effect("keeps the programs and the bridge program the sandbox has", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      const installation = yield* makeInstallation(2)
      const { bridge } = launchedFrom(installation)
      yield* fs.makeDirectory(path.join(home, path.dirname(bridge)), { recursive: true })
      yield* fs.writeFileString(path.join(home, bridge), "the bridge program")

      const commands = makeSandboxCommands(home)

      yield* installation.template.prepare.pipe(commands.provide)

      expect(commands.ran).toEqual([homeLookup])
      expect(yield* fs.readFileString(path.join(home, bridge))).toBe("the bridge program")
    }).pipe(Effect.provide(BunServices.layer))
  )

  it.effect("installs a new bridge program beside the programs the sandbox has", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      const installation = yield* makeInstallation(2)
      const { bridge } = launchedFrom(installation)
      yield* fs.makeDirectory(path.join(home, path.dirname(bridge)), { recursive: true })

      const commands = makeSandboxCommands(home)

      yield* installation.template.prepare.pipe(commands.provide)

      expect(commands.ran).toEqual([homeLookup])
      expect(yield* fs.readDirectory(path.join(home, path.dirname(bridge)))).toEqual([path.basename(bridge)])
      expect(yield* fs.readFileString(path.join(home, bridge))).toContain("// @bun")
    }).pipe(Effect.provide(BunServices.layer))
  )

  it.effect("installs nothing on a platform the bridge does not install on", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      const installation = yield* makeInstallation(2)

      const commands = makeSandboxCommands(home, (command) =>
        command === "uname" ? { output: "FreeBSD amd64\n" } : {}
      )

      const refused = yield* Effect.flip(installation.template.prepare.pipe(commands.provide))

      expect(refused.reason.description).toBe(
        "opencode's bridge installs on macOS and on Linux with glibc, on arm64 and x64, not on FreeBSD amd64"
      )
      expect(commands.ran).toEqual([homeLookup, ["uname", "-sm"]])
      expect(yield* fs.exists(path.join(home, ".amends"))).toBe(false)
    }).pipe(Effect.provide(BunServices.layer))
  )

  it.effect("installs nothing from a package that does not match its integrity", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      const installation = yield* makeInstallation(2)

      const commands = makeSandboxCommands(home, (command) =>
        command === "uname"
          ? { output: "Linux x86_64\n" }
          : command === "sh"
            ? { output: `${"0".repeat(128)}  bun.tgz\n` }
            : {}
      )

      const refused = yield* Effect.flip(installation.template.prepare.pipe(commands.provide))

      expect(refused.reason).toMatchObject({
        _tag: "InvalidData",
        description: "@oven/bun-linux-x64@1.3.14 does not match the integrity npm published for it"
      })
      expect(commands.ran.map(([command]) => command)).toEqual(["sh", "uname", "curl", "sh"])
      expect(commands.ran[2]).toContain("https://registry.npmjs.org/@oven/bun-linux-x64/-/bun-linux-x64-1.3.14.tgz")
      expect(yield* fs.readDirectory(path.join(home, ".amends", "opencode"))).toEqual([])
    }).pipe(Effect.provide(BunServices.layer))
  )
})

describe.skipIf(!enabled).each([1, 2] as const)("Template of opencode %i on this machine", (version) => {
  it.live(
    "installs Bun and opencode in the sandbox's home, from where the bridge launches and starts opencode",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* fs.makeTempDirectoryScoped()
        const local = yield* makeSandbox()
        const sandbox: Sandbox.Sandbox["Service"] = {
          ...local,
          childProcessSpawner: withHome(local.childProcessSpawner, home)
        }
        const installation = yield* makeInstallation(version)

        yield* installation.template.prepare.pipe(Effect.provide(Sandbox.layerServices(sandbox)))

        const { bun, bridge } = launchedFrom(installation)
        const installed = path.join(home, path.dirname(bun))
        expect((yield* fs.readDirectory(installed)).toSorted()).toEqual([path.basename(bridge), "bun", "opencode"])
        const harness = Harness.make(
          yield* makeBridgedAgent({
            id: version === 1 ? "opencode" : "opencode2",
            template: installation.template,
            command: installation.command,
            args: installation.args,
            token: (sandboxId) => Redacted.make(`the hosts' secret/${sandboxId}`),
            agentOptions: {
              model: { providerID: "opencode", id: "fledge-alpha-free" },
              models: {},
              command: path.join(installed, "opencode"),
              config: {},
              env: {}
            }
          })
        )
        const session = yield* harness.createSession({
          sandbox,
          id: SessionId.make("session-1")
        })
        yield* session.destroy
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, BunSocket.layerWebSocketConstructor))),
    180_000
  )
})
