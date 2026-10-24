/**
 * Checks what each package declares. The contract depends only on Effect and the sandbox contract,
 * so code written against it needs nothing else; each agent's adapter adds its own clients. Every
 * version comes from the root catalog, and a package here depends on another with `workspace:^`,
 * which publishes as a caret range.
 *
 * Packages release in lines: they share a version's major and minor, so each works with every other
 * on its line, and a fix releases its own package alone. Changesets publishes their distribution,
 * which `bun run dist build` writes to `dist`.
 *
 *   bun run check:packages
 */

interface PackageManifest {
  name: string
  version: string
  private?: boolean
  publishConfig?: { directory?: string }
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

const root = `${import.meta.dir}/..`
const contract = "@amends-dev/harness"
const contractDependencies = ["effect", "@effect/vitest", "@amends-dev/sandbox"]
const packages: Array<{ path: string; manifest: PackageManifest }> = []

for await (const path of new Bun.Glob("packages/*/package.json").scan({ cwd: root })) {
  const manifest: PackageManifest = await Bun.file(`${root}/${path}`).json()
  packages.push({ path, manifest })
}

const names = new Set(packages.map(({ manifest }) => manifest.name))
const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const
const errors: Array<string> = []

for (const { path, manifest } of packages) {
  if (manifest.private === true) errors.push(`${path}: every package here is published; remove "private".`)
  if (manifest.publishConfig?.directory !== "dist") {
    errors.push(`${path}: publishConfig.directory must be "dist", the distribution Changesets publishes.`)
  }
  for (const section of sections) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (names.has(name)) {
        if (version !== "workspace:^") {
          errors.push(`${path}: ${section}.${name} must be workspace:^, which publishes as a caret range.`)
        }
      } else if (version !== "catalog:") {
        errors.push(`${path}: ${section}.${name} must use the root catalog (catalog:).`)
      }
      if (manifest.name === contract && section !== "devDependencies" && !contractDependencies.includes(name)) {
        errors.push(
          `${path}: the contract depends only on Effect and the sandbox contract; ${section}.${name} belongs in an adapter.`
        )
      }
    }
  }
}

const lineOf = (version: string) => version.split(".").slice(0, 2).join(".")
if (new Set(packages.map(({ manifest }) => lineOf(manifest.version))).size > 1) {
  errors.push(
    `Packages must share one line, a major and minor version: ${packages
      .map(({ manifest }) => `${manifest.name} is ${manifest.version}`)
      .join(", ")}.`
  )
}

if (errors.length > 0) {
  console.error(errors.join("\n"))
  process.exitCode = 1
} else {
  console.log(`Checked ${packages.length} packages' dependencies and line.`)
}
