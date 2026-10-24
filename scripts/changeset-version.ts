/**
 * Versions the published packages from the pending changesets, which the release pull request
 * then shows. The packages release in lines: they share a version's major and minor, so each works
 * with every other on its line, and a fix releases its own package alone. A changeset that starts
 * a line, a minor or major release of any published package, starts it for all of them, so this
 * first adds a changeset for the packages the pending ones would leave on the current line, then
 * lets Changesets write the versions and changelogs.
 *
 *   bun run changeset-version
 */

import { join, resolve } from "node:path"
import { readChangesets } from "@changesets/read"
import { $ } from "bun"

const root = resolve(import.meta.dir, "..")

type Bump = "none" | "patch" | "minor" | "major"

const ranks: Record<Bump, number> = { none: 0, patch: 1, minor: 2, major: 3 }

const larger = (a: Bump, b: Bump) => (ranks[b] > ranks[a] ? b : a)

interface Published {
  readonly name: string
  readonly version: string
}

interface Changeset {
  readonly releases: ReadonlyArray<{ readonly name: string; readonly type: Bump }>
}

const readPublished = async (): Promise<ReadonlyArray<Published>> => {
  const published: Array<Published> = []
  for await (const path of new Bun.Glob("packages/*/package.json").scan({ cwd: root })) {
    const manifest = await Bun.file(join(root, path)).json()
    if (manifest.private !== true) published.push({ name: manifest.name, version: manifest.version })
  }
  return published
}

/**
 * When the pending changesets start a line, the bump that starts it and the published packages
 * they would leave behind: those without a release of that bump.
 */
const findLeftBehind = (changesets: ReadonlyArray<Changeset>, published: ReadonlyArray<Published>) => {
  const bumps = new Map<string, Bump>()
  for (const { releases } of changesets) {
    for (const { name, type } of releases) bumps.set(name, larger(bumps.get(name) ?? "none", type))
  }
  const bumpOf = (name: string) => bumps.get(name) ?? "none"
  const line = published.map(({ name }) => bumpOf(name)).reduce(larger, "none")
  if (ranks[line] < ranks.minor) return undefined
  return { bump: line, packages: published.filter(({ name }) => ranks[bumpOf(name)] < ranks[line]) }
}

/** The line, such as `0.4`, that a minor or major `bump` starts from `version`, such as `0.3.2`. */
const nextLine = (version: string, bump: Bump) => {
  const [major = 0, minor = 0] = version.split(".").map(Number)
  return bump === "major" ? `${major + 1}.0` : `${major}.${minor + 1}`
}

const published = await readPublished()
const leftBehind = findLeftBehind(await readChangesets(root), published)
if (leftBehind !== undefined && leftBehind.packages.length > 0) {
  const line = nextLine(published[0]!.version, leftBehind.bump)
  const releases = leftBehind.packages.map(({ name }) => `"${name}": ${leftBehind.bump}`).join("\n")
  await Bun.write(
    join(root, ".changeset/next-line.md"),
    `---\n${releases}\n---\n\nMoves to ${line} with the other harness packages.\n`
  )
  console.log(`Moving ${leftBehind.packages.length} more packages to ${line}`)
}
await $`changeset version`.cwd(root)
