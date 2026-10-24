/**
 * Writes every barrel the way Effect's codegen does. A barrel is an `index.ts` holding the marker
 * `// @barrel: Auto-generated exports. Do not edit manually.`, or `// @barrel(Postgres*.ts): …`
 * to list only the modules a pattern matches. What comes before the marker stays as written; after
 * it, every module beside the barrel that the pattern matches is listed, in name order, as
 * `export * as Name from "./Name.ts"` under a doc carrying the module's `@since`. Folders, such as
 * `internal/`, are never listed. With `--check`, it changes nothing and fails if a barrel differs.
 *
 * Usage: bun run barrels [--check]
 */

import { basename, dirname, relative } from "node:path"

const root = `${import.meta.dir}/..`
const check = process.argv.includes("--check")
const marker = /^\/\/\s*@barrel(?:\((.+?)\))?/

/** A file pattern with `*` wildcards, such as `Postgres*.ts`, as a regular expression. */
const patternOf = (glob: string) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`)

/** The one `@since` of a module's header, the first doc comment in the file. */
const sinceOf = (path: string, text: string) => {
  const header = /^\s*\/\*\*([\s\S]*?)\*\//.exec(text)?.[1]
  const since = [...(header ?? "").matchAll(/^\s*\*\s*@since\s+(\S+)\s*$/gm)]
  if (since.length !== 1) throw new Error(`${relative(root, path)}: expected one @since in the module header`)
  return since[0]![1]!
}

/** The barrel as it should be, or undefined when the file holds no marker. */
const generate = async (path: string, text: string) => {
  const lines = text.split("\n")
  const at = lines.findIndex((line) => marker.test(line))
  if (at < 0) return undefined
  let end = at
  while (end + 1 < lines.length && lines[end + 1]!.trimStart().startsWith("//")) end++
  const pattern = patternOf(marker.exec(lines[at]!)![1] ?? "*.ts")
  const directory = dirname(path)
  const modules: Array<string> = []
  for await (const file of new Bun.Glob("*.ts").scan({ cwd: directory, onlyFiles: true }))
    if (file !== basename(path) && !file.endsWith(".d.ts") && pattern.test(file)) modules.push(file)
  const entries = await Promise.all(
    modules
      .toSorted((left, right) => left.localeCompare(right))
      .map(async (file) => {
        const since = sinceOf(`${directory}/${file}`, await Bun.file(`${directory}/${file}`).text())
        return `/**\n * @since ${since}\n */\nexport * as ${file.slice(0, -3)} from "./${file}"`
      })
  )
  return `${lines.slice(0, end + 1).join("\n")}\n\n${entries.join("\n\n")}\n`
}

const stale: Array<string> = []
for await (const path of new Bun.Glob("packages/*/src/**/index.ts").scan({ cwd: root })) {
  if (path.includes("/node_modules/")) continue
  const file = `${root}/${path}`
  const text = await Bun.file(file).text()
  const next = await generate(file, text)
  if (next === undefined || next === text) continue
  stale.push(path)
  if (!check) await Bun.write(file, next)
}

if (check && stale.length > 0) {
  console.error(`These barrels are out of date; run \`bun run barrels\`:\n  ${stale.join("\n  ")}`)
  process.exit(1)
}
console.log(check ? "Barrels are up to date." : `Wrote ${stale.length} barrels.`)
