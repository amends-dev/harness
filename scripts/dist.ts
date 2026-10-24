/**
 * A package's distribution: what npm gets. The repository's manifests point at sources, which the
 * workspace consumes as they are. The distribution is `dist/`: the compiled JavaScript and
 * declarations, the README and the license, and a manifest of their own that points at them, with
 * `workspace:` and `catalog:` versions resolved to ranges, and without the scripts and development
 * dependencies. Changesets publishes it, from the directory each manifest's `publishConfig` names.
 *
 *   bun run dist build [package directory]
 *   bun run dist check [package directory]
 *
 * Without a directory, each command takes every published package. `check` builds the package and
 * the workspace packages it depends on, then typechecks and runs a consumer of the distribution,
 * as a project that installed it from npm would, with its other dependencies from npm, under both
 * of TypeScript's module resolutions and on Bun and Node.
 */

import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { $ } from "bun"

const root = resolve(import.meta.dir, "..")

type Exports = { readonly [key: string]: string | null | Exports }

interface Manifest {
  readonly name: string
  readonly version: string
  readonly private?: boolean
  readonly description?: string
  readonly license?: string
  readonly homepage?: string
  readonly repository?: unknown
  readonly bugs?: unknown
  readonly keywords?: unknown
  readonly type?: string
  readonly sideEffects?: unknown
  readonly exports?: Exports
  readonly dependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>
  readonly optionalDependencies?: Record<string, string>
  readonly engines?: unknown
  readonly publishConfig?: { readonly access?: string; readonly directory?: string }
}

/** The workspace: each package's directory by its name, and the root catalog of versions. */
interface Workspace {
  readonly directories: ReadonlyMap<string, string>
  readonly catalog: Readonly<Record<string, string>>
}

const readManifest = (directory: string): Promise<Manifest> => Bun.file(join(directory, "package.json")).json()

const readWorkspace = async (): Promise<Workspace> => {
  const manifest = await Bun.file(join(root, "package.json")).json()
  const directories = new Map<string, string>()
  for (const pattern of manifest.workspaces.packages as ReadonlyArray<string>) {
    for await (const path of new Bun.Glob(`${pattern}/package.json`).scan({ cwd: root })) {
      const directory = dirname(join(root, path))
      directories.set((await readManifest(directory)).name, directory)
    }
  }
  return { directories, catalog: manifest.workspaces.catalog }
}

/**
 * The range the distribution depends on `name` with, for `version` as the repository writes it: a
 * `workspace:` version as Bun publishes it, so `workspace:^` is a caret range of the package's
 * version and `workspace:*` the version itself, and a `catalog:` one as a caret range of the
 * catalog's version.
 */
const rangeOf = async (name: string, version: string, workspace: Workspace) => {
  if (version.startsWith("workspace:")) {
    const directory = workspace.directories.get(name)
    if (directory === undefined) throw new Error(`${name} is not a workspace package`)
    const current = (await readManifest(directory)).version
    const range = version.slice("workspace:".length)
    return range === "*" ? current : range === "^" || range === "~" ? `${range}${current}` : range
  }
  if (version === "catalog:") {
    const listed = workspace.catalog[name]
    if (listed === undefined) throw new Error(`${name} is not in the root catalog`)
    return /^\d/.test(listed) ? `^${listed}` : listed
  }
  return version
}

const distPath = (path: string) => path.replace(/^\.\/src\//, "./").replace(/\.ts$/, ".js")

/** `exports` with every path into `src` pointing at the compiled file beside the manifest. */
const distExports = (exports: Exports): Exports =>
  Object.fromEntries(
    Object.entries(exports).map(([key, value]) => [
      key,
      value === null ? null : typeof value === "string" ? distPath(value) : distExports(value)
    ])
  )

const distManifest = async (manifest: Manifest, workspace: Workspace) => {
  // `directory` tells Changesets where the distribution is; the distribution is that directory.
  const { directory: _directory, ...publishConfig } = manifest.publishConfig ?? {}
  const ranges = async (section: Record<string, string> | undefined) =>
    section === undefined
      ? undefined
      : Object.fromEntries(
          await Promise.all(
            Object.entries(section).map(
              async ([name, version]) => [name, await rangeOf(name, version, workspace)] as const
            )
          )
        )
  return {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    license: manifest.license,
    homepage: manifest.homepage,
    repository: manifest.repository,
    bugs: manifest.bugs,
    keywords: manifest.keywords,
    type: manifest.type,
    sideEffects: manifest.sideEffects,
    exports: manifest.exports === undefined ? undefined : distExports(manifest.exports),
    dependencies: await ranges(manifest.dependencies),
    peerDependencies: await ranges(manifest.peerDependencies),
    peerDependenciesMeta: manifest.peerDependenciesMeta,
    optionalDependencies: await ranges(manifest.optionalDependencies),
    engines: manifest.engines,
    publishConfig
  }
}

/** Builds `directory`'s distribution into its `dist/`, returning the package's manifest. */
const build = async (directory: string, workspace: Workspace) => {
  const manifest = await readManifest(directory)
  if (manifest.private === true) throw new Error(`${manifest.name} is private`)
  const dist = join(directory, "dist")
  await rm(dist, { recursive: true, force: true })
  await $`bun run tsc -p tsconfig.build.json`.cwd(directory)
  await Bun.write(join(dist, "package.json"), `${JSON.stringify(await distManifest(manifest, workspace), null, 2)}\n`)
  for (const file of ["README.md", "LICENSE"]) {
    if (!(await Bun.file(join(directory, file)).exists())) {
      throw new Error(`${manifest.name} has no ${file}`)
    }
    await cp(join(directory, file), join(dist, file))
  }
  console.log(`Built ${manifest.name}@${manifest.version} in ${dist}`)
  return manifest
}

/**
 * Builds the package and the workspace packages it depends on, then typechecks and runs a project
 * that depends on the distribution as one that installed it from npm would: the distributions copied
 * into its `node_modules`, and every other dependency, Effect among them, installed from npm at the
 * newest version the distributions allow, as a new project gets it.
 */
const check = async (directory: string, workspace: Workspace) => {
  const consumer = await mkdtemp(join(tmpdir(), "amends-dist-"))
  const distributions = new Map<string, string>()
  const dependencies: Record<string, string> = {}
  /** Builds the package's distribution and those of the workspace packages it depends on. */
  const collect = async (packageDirectory: string): Promise<Manifest> => {
    const manifest = await build(packageDirectory, workspace)
    if (distributions.has(manifest.name)) return manifest
    const dist = join(packageDirectory, "dist")
    distributions.set(manifest.name, dist)
    const distributed = await readManifest(dist)
    const requiredPeers = Object.entries(distributed.peerDependencies ?? {}).filter(
      ([name]) => distributed.peerDependenciesMeta?.[name]?.optional !== true
    )
    for (const [name, range] of [...Object.entries(distributed.dependencies ?? {}), ...requiredPeers]) {
      const workspaceDirectory = workspace.directories.get(name)
      if (workspaceDirectory !== undefined) {
        await collect(workspaceDirectory)
      } else if (dependencies[name] !== undefined && dependencies[name] !== range) {
        throw new Error(`${name} is required as both ${dependencies[name]} and ${range}`)
      } else {
        dependencies[name] = range
      }
    }
    return manifest
  }
  const { name } = await collect(directory)

  await Bun.write(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module", dependencies }))
  await $`bun install`.cwd(consumer).quiet()
  for (const [distributed, dist] of distributions) {
    await mkdir(dirname(join(consumer, "node_modules", distributed)), { recursive: true })
    await cp(dist, join(consumer, "node_modules", distributed), { recursive: true })
  }
  const effect = await readManifest(join(consumer, "node_modules", "effect"))
  console.log(`Installed ${Object.keys(dependencies).length} dependencies from npm, with effect@${effect.version}`)

  await Bun.write(
    join(consumer, "main.ts"),
    `import * as Package from "${name}";\n\nexport const exported: ReadonlyArray<string> = Object.keys(Package);\n`
  )
  await Bun.write(
    join(consumer, "main.mjs"),
    `import * as Package from "${name}";\n\nconsole.log(Object.keys(Package).join(" "));\n`
  )
  const tsc = join(root, "node_modules/.bin/tsc")
  for (const [module, moduleResolution] of [
    ["ESNext", "bundler"],
    ["NodeNext", "nodenext"]
  ]) {
    const compilerOptions = {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: "ESNext",
      lib: ["ESNext"],
      types: [],
      module,
      moduleResolution
    }
    await Bun.write(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions, include: ["main.ts"] }))
    await $`${tsc} -p tsconfig.json`.cwd(consumer)
    console.log(`Typechecks with moduleResolution ${moduleResolution}`)
  }
  await $`bun run main.mjs`.cwd(consumer)
  await $`node main.mjs`.cwd(consumer)
  await rm(consumer, { recursive: true, force: true })
  console.log(`Checked ${name}: a consumer typechecks and runs it on Bun and Node`)
}

/** The directories of every published package, or the one named. */
const directoriesOf = async (packagePath: string | undefined, workspace: Workspace) => {
  if (packagePath !== undefined) return [resolve(root, packagePath)]
  const directories: Array<string> = []
  for (const directory of workspace.directories.values()) {
    if ((await readManifest(directory)).private !== true) directories.push(directory)
  }
  return directories.sort()
}

const [command, packagePath] = process.argv.slice(2)
const workspace = await readWorkspace()
switch (command) {
  case "build":
    for (const directory of await directoriesOf(packagePath, workspace)) await build(directory, workspace)
    break
  case "check":
    for (const directory of await directoriesOf(packagePath, workspace)) await check(directory, workspace)
    break
  default:
    console.error("Usage: bun run dist <build|check> [package directory]")
    process.exit(1)
}
