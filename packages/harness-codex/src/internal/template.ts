/** Installs integrity-pinned Bun and Codex, with a content-addressed bundle of the bridge. */

import { Template } from "@amends-dev/sandbox"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Base64 from "effect/encoding/Base64"
import * as Hex from "effect/encoding/Hex"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"

/** The platforms the bridge installs on, as `platformOf` names them. */
export type Platform = `${"darwin" | "linux"}-${"arm64" | "x64"}`

/**
 * A platform package and its published SHA-512 integrity.
 */
interface Package {
  readonly name: string
  readonly integrity: string
}

/** A program at a pinned version, from its package for each platform. */
interface Program {
  readonly version: string
  readonly packages: { readonly [platform in Platform]: Package }
}

/** Bun, which runs the bridge program. */
const bun: Program = {
  version: "1.3.14",
  packages: {
    "darwin-arm64": {
      name: "@oven/bun-darwin-aarch64",
      integrity: "sha512-Omj20SuiHBOUjUBIyqtkNjSUIjOtEOJwmbix/ZyFH4BaQ6OZTaaRWIR4TjHVz0yadHgli6lLTiAh1uarnvD49A=="
    },
    "darwin-x64": {
      name: "@oven/bun-darwin-x64",
      integrity: "sha512-FFj3QdU/OhlDyZOJ8CWfN5eWLpRlT4qjZg7lMQi7jA6GuoY5ajlO1zWLP/MuHYRSbXQUvV52RejNi8DVnAp13w=="
    },
    "linux-arm64": {
      name: "@oven/bun-linux-aarch64",
      integrity: "sha512-X5SsPZHs+iYO8R/efIcRtc7gT2Q2DgPfliCxEkx4cXBumwkw0c/EsHMNwH3EgGpCDaZ7IYVPhpCG/xBOQHEwZw=="
    },
    "linux-x64": {
      name: "@oven/bun-linux-x64",
      integrity: "sha512-7OVTAKvwfPmSbIV1HpdOoVVx5VRc427GuPPne93N6vk4eQBPId9nXmZDh9/zGaKPdbVjVtQSZafWQoUjx38Utw=="
    }
  }
}

/** Codex's native packages include the binary and its resources, which stay together. */
const codexVersion = "0.157.1"
const triples: Record<Platform, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl"
}
const codexPackages: Record<Platform, Package> = {
  "darwin-arm64": {
    name: "@openai/codex",
    integrity: "sha512-62/e4TZ34z93KK3FYIHmo/K88aH0JRPA8x7SAVBdK4iG9f9HPO2tsDrJcmOj9z6DrFpMvPEVymomCbYpqN+ylQ=="
  },
  "darwin-x64": {
    name: "@openai/codex",
    integrity: "sha512-PscZvqKD4zlaSw1nM5Sh4lU1M+01sr4b3qzGx8pf+4OLyULg1z1yAyTR1c35C3t62H8DXy/14y7oazTR3JMMKA=="
  },
  "linux-arm64": {
    name: "@openai/codex",
    integrity: "sha512-nEaBZT3ldrtqUNaBlvI+Y+fg+LbNCTsQjbUnl7Q45rl9vSSqHU2vRj1l6iJDwupZkrpeIJ/ClHIwxgMKv1SKHg=="
  },
  "linux-x64": {
    name: "@openai/codex",
    integrity: "sha512-Eac8XlC0nCXSeUjDU9l8yLJ6P9evv1mO+AnvILoNwlegBC7B3AVXqJ05QcMhQX7RcJ3Lk2618ykCb2X2ui8VAQ=="
  }
}
const programs = { bun, codex: { version: codexVersion, packages: codexPackages } }
const layoutVersion = 1

export interface Installation {
  /** Installs the bridge in a new sandbox. */
  readonly template: Template.Template

  /** The command that launches the installed bridge, and its arguments. */
  readonly command: string

  readonly args: ReadonlyArray<string>
}

/**
 * Bundles the Codex bridge program, giving the template that
 * installs it with the command that launches it. The template's identity changes with anything it
 * installs.
 */
export const makeInstallation = Effect.fnUntraced(function* () {
  const crypto = yield* Crypto.Crypto
  const hashOf = (text: string) =>
    Effect.map(crypto.digest("SHA-256", new TextEncoder().encode(text)), (digest) => Hex.encode(digest).slice(0, 16))
  const bundle = yield* bundleBridge()
  const programsHash = yield* hashOf(JSON.stringify([layoutVersion, programs]))
  const bundleHash = yield* hashOf(bundle)
  const directory = `.amends/codex/${programsHash}`
  const bridge = `bridge-${bundleHash}.js`
  const installation: Installation = {
    template: {
      name: Template.TemplateName.make("codex"),
      identity: `${programsHash}-${bundleHash}`,
      prepare: install(programs, directory, bridge, bundle)
    },
    command: "sh",
    args: ["-c", `exec "$HOME/${directory}/bun" "$HOME/${directory}/${bridge}"`]
  }
  return installation
})

/** The platform that `uname -sm` printed, or nothing for one the bridge does not install on. */
export const platformOf = (uname: string): Platform | undefined => {
  const [system, machine] = uname.trim().split(/\s+/)
  const architecture =
    machine === "arm64" || machine === "aarch64"
      ? "arm64"
      : machine === "x86_64" || machine === "amd64"
        ? "x64"
        : undefined
  if (architecture === undefined) return undefined
  return system === "Darwin" ? `darwin-${architecture}` : system === "Linux" ? `linux-${architecture}` : undefined
}

/**
 * The bridge program, `bridge/main.ts`, bundled with everything
 * it imports into one file for Bun. The program is beside this module, in this module's own form:
 * a source among the sources, a compiled file among the compiled ones of the distribution.
 */
const bundleBridge = () =>
  Effect.promise(async () => {
    const extension = import.meta.url.slice(import.meta.url.lastIndexOf("."))
    const { outputs } = await Bun.build({
      entrypoints: [`${import.meta.dirname}/bridge/main${extension}`],
      target: "bun",
      minify: true
    })
    const [bundle] = outputs
    if (bundle === undefined) throw new Error("Bun built the bridge program into no file")
    return bundle.text()
  })

/**
 * Installs `programs` in `directory` of the sandbox's home, and `bundle` beside them as `bridge`,
 * each unless the sandbox has it already. Each goes in under another name first, renamed into
 * place once whole, so that no bridge launches from half an installation.
 */
const install = (
  programs: { readonly [program: string]: Program },
  directory: string,
  bridge: string,
  bundle: string
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const installed = path.join(yield* homeDirectory, directory)
    if (!(yield* fs.exists(installed))) yield* installPrograms(programs, installed)
    const bridgeFile = path.join(installed, bridge)
    if (yield* fs.exists(bridgeFile)) return
    const staging = yield* fs.makeTempDirectory({ directory: installed, prefix: ".bridge-" })
    yield* fs
      .writeFileString(path.join(staging, bridge), bundle)
      .pipe(
        Effect.andThen(fs.rename(path.join(staging, bridge), bridgeFile)),
        Effect.ensuring(Effect.ignore(fs.remove(staging, { recursive: true, force: true })))
      )
  })

/** Installs `programs` in `installed`, checking that each runs as its pinned version. */
const installPrograms = (programs: { readonly [program: string]: Program }, installed: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const uname = yield* run("uname", ["-sm"])
    const platform = platformOf(uname)
    if (platform === undefined) {
      return yield* failure(
        "Unknown",
        "codex's bridge installs on macOS and on Linux with glibc, on arm64 and x64, not on " + uname.trim()
      )
    }

    yield* fs.makeDirectory(path.dirname(installed), { recursive: true })
    const staging = yield* fs.makeTempDirectory({
      directory: path.dirname(installed),
      prefix: `.${path.basename(installed)}-`
    })
    yield* Effect.gen(function* () {
      for (const [program, { version, packages }] of Object.entries(programs)) {
        yield* installProgram(staging, program, version, packages[platform], platform)
      }
      // A sandbox sharing this home may have installed the same meanwhile, which serves as well.
      yield* fs
        .rename(staging, installed)
        .pipe(
          Effect.catch((error) =>
            Effect.flatMap(fs.exists(installed), (exists) => (exists ? Effect.void : Effect.fail(error)))
          )
        )
    }).pipe(Effect.ensuring(Effect.ignore(fs.remove(staging, { recursive: true, force: true }))))
  })

/**
 * Installs `program` from `pkg` in `directory`: downloads the package, checks it against the
 * integrity npm published for it, extracts the program, and checks that it runs as `version`.
 */
const installProgram = (directory: string, program: string, version: string, pkg: Package, platform: Platform) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const tarball = path.join(directory, `${program}.tgz`)
    yield* run("curl", [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--retry",
      "3",
      "--output",
      tarball,
      `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split("/").at(-1)}-${version}${program === "codex" ? `-${platform}` : ""}.tgz`
    ])
    // macOS has no `sha512sum`, and slim Linux images have no `shasum`.
    const [sha512] = (yield* run("sh", [
      "-c",
      'sha512sum "$1" 2>/dev/null || shasum -a 512 "$1"',
      "sh",
      tarball
    ])).split(/\s/)
    if (sha512 !== hexOf(pkg.integrity)) {
      return yield* failure("InvalidData", `${pkg.name}@${version} does not match the integrity npm published for it`)
    }
    if (program === "codex") {
      const target = path.join(directory, "codex-runtime")
      yield* fs.makeDirectory(target)
      yield* run("tar", ["-xzf", tarball, "-C", target, "--strip-components=3", `package/vendor/${triples[platform]}`])
    } else {
      yield* run("tar", ["-xzf", tarball, "-C", directory, "--strip-components=2", `package/bin/${program}`])
    }
    yield* fs.remove(tarball)
    const printed = (yield* run(path.join(directory, program === "codex" ? "codex-runtime/bin/codex" : program), [
      "--version"
    ])).trim()
    if (versionIn(printed) !== version) {
      return yield* failure("InvalidData", `${program} ${version} printed ${printed} as its version`)
    }
  })

/**
 * The version printed alone by Bun, or after `codex-cli` by Codex.
 */
export const versionIn = (printed: string) => printed.trim().split(/\s+/).at(-1)?.replace(/^v/, "")

/** Runs `command` in the sandbox for its output, failing with its error output when it fails. */
const run = (command: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const process = yield* spawner.spawn(ChildProcess.make(command, args, { stdin: "ignore" }))
    const [output, errorOutput, code] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(process.stdout)),
        Stream.mkString(Stream.decodeText(process.stderr)),
        process.exitCode
      ],
      { concurrency: "unbounded" }
    )
    if (code !== 0) {
      return yield* failure(
        "Unknown",
        `\`${[command, ...args].join(" ")}\` exited with code ${code}: ${errorOutput.trim()}`
      )
    }
    return output
  }).pipe(Effect.scoped)

/** The sandbox's home directory. */
const homeDirectory = run("sh", ["-c", 'printf %s "$HOME"']).pipe(
  Effect.filterOrFail(
    (home) => home.startsWith("/"),
    () => failure("NotFound", "The sandbox has no home directory")
  )
)

/** The SHA-512 digest in hex that an npm `integrity` names. */
const hexOf = (integrity: string) => Hex.encode(Result.getOrThrow(Base64.decode(integrity.slice("sha512-".length))))

const failure = (tag: PlatformError.SystemErrorTag, description: string) =>
  PlatformError.systemError({
    _tag: tag,
    module: "CodexAgent",
    method: "prepare",
    description
  })
