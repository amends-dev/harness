# Contributing

Thank you for helping. These packages are in early development, and nothing in them is stable yet:
a change may break any interface when that makes the structure clearer, as long as it updates
everything that uses it in the same change. This guide covers setting up, the checks every change
passes, and how changes are made.

Report a vulnerability as [SECURITY.md](SECURITY.md) describes, not in a public issue.

## Set up

You need [Bun](https://bun.com) 1.3.14, the version CI uses, and Node 24 for `bun run dist check`.
Then, from the repository root:

```sh
bun install
```

Installing also patches the local TypeScript compiler with Effect's diagnostics and installs the
Git hooks, through the root manifest's `prepare` script.

In VS Code, the workspace settings select the repository's TypeScript and format on save with Oxc.
Install the recommended Oxc and Effect extensions, and pick the workspace TypeScript version when
asked.

## Before you change code

[AGENTS.md](AGENTS.md) is the project's guidance, for people and coding agents alike: what each
package is, which may depend on which, how code is named and structured, and how it is reviewed.

The packages are written with [Effect](https://effect.website) 4. Read
[Effect's guide for this source](repos/effect/LLMS.md) before writing Effect code, and check the
APIs you use against the vendored source in `repos/effect`, which matches the installed version.
Import from the installed packages, never from `repos/`.

## Checks

| Command                  | What it does                                                             |
| ------------------------ | ------------------------------------------------------------------------ |
| `bun run check`          | Package declarations, generated barrels, types, lint, and formatting     |
| `bun run test`           | Every test suite                                                         |
| `bun run test <path>`    | The tests under one path, such as `bun run test packages/harness`        |
| `bun run format`         | Format files with Oxfmt                                                  |
| `bun run lint:fix`       | Apply Oxlint's safe fixes                                                |
| `bun run typecheck`      | TypeScript 7 with Effect's diagnostics, across every package             |
| `bun run check:packages` | Which package may depend on what, and that they share one line           |
| `bun run barrels`        | Write every barrel, each `index.ts` marked `// @barrel`, from its folder |
| `bun run dist`           | Build or check a package as npm gets it                                  |
| `bun changeset`          | Describe a change to the packages for their next release                 |

The [justfile](justfile) runs the same commands with [just](https://just.systems), such as
`just check` and `just test`; `just` lists them.

Run `bun run check` after every change and the tests after any change in behavior.

Before each commit, [Lefthook](https://lefthook.dev) runs the package, generated-barrel, type,
lint, and formatting checks in parallel over the working tree. They change and stage nothing; a
failing check blocks the commit. Run them by hand, even with nothing staged, with:

```sh
bun run lefthook run pre-commit --force
```

The hook does not run tests, so run the suites of the packages you touched before committing. CI
runs the checks, the tests, and the distribution checks on every pull request.

The live suites run real agents and models, which need credentials and cost money, so they skip
unless enabled. Each adapter's README says how to run them:
[amends's agent](packages/harness-amends/README.md#development),
[opencode](packages/harness-opencode/README.md#development),
[Codex](packages/harness-codex/README.md#limitations-and-verification), and
[Claude](packages/harness-claude/README.md#verification).

## Making a change

1. Branch from `main`, and keep one concern per pull request.
2. Update every consumer of what you change, and the READMEs that describe it.
3. When a package's users would see the change, add a changeset with `bun changeset`: a patch for
   a fix, and a minor for a feature or, before 1.0, a breaking change, which moves every package
   to the next line.
4. Write commits that each say, in one sentence, what changed and why. Explain the reason in the
   body when it needs more than the subject.
5. Open a pull request that says what changed, why, and how you verified it.

Code is reviewed by how a newcomer reads it, as AGENTS.md's
[design and review](AGENTS.md#design-and-review) section describes: one word per concept, no layer
that only forwards, flows that read top to bottom, and names that say what things do.

## Adding an agent

An agent implements the harness contract in its own package under `packages/`, with its agent's
clients as its only dependencies besides the contract and the sandbox contract. The contract's
guide describes [writing an adapter](packages/harness/README.md#writing-an-adapter), for an agent in
the host's process or one in a sandbox behind the bridge, and the adapter's README records the model
endpoints and session operations it supports and how to run its live suites.

## Releases

Merging changesets to `main` keeps a release pull request open; merging that publishes each
package whose version npm does not have yet, through npm's trusted publishing, as
[the release workflow](.github/workflows/release.yml) describes.

What the workflow needs from GitHub is the Alchemy stack in [stacks/github.ts](stacks/github.ts):
the `npm` environment, which only `main` may use, with the token that opens the release pull
request, and the ruleset that lets `main` change only through pull requests whose checks pass.
Maintainers apply it with `just github`, which installs Alchemy in `stacks/` on its own, apart
from the packages.

## Updating Effect

The root manifest's `workspaces.catalog` gives every Effect package as a tilde range, such as
`~4.0.5`, which the packages publish as their own range: a minor release of Effect can remove a
module they import, as 4.1.0 removed `effect/Crypto`, so they take only the minor they are built
against. `repos/effect` holds the matching source as a squashed Git subtree of
[Effect-TS/effect](https://github.com/Effect-TS/effect), at tag `effect@4.0.5`. Upgrade both
together:

1. Set the new version as a tilde range, such as `~4.1.0`, for every Effect package in the catalog,
   and run `bun install`.
2. Commit, then pull the matching tag, replacing `<version>` with the version `bun.lock` installed:

   ```sh
   git subtree pull --prefix=repos/effect \
     https://github.com/Effect-TS/effect.git 'effect@<version>' --squash
   ```

3. Update the tag recorded above, run `bun run check` and `bun run test`, and recheck the APIs the
   upgrade touches.
4. Raise the packages to a new line with a changeset, since their `effect` range moves with the
   catalog. Move the catalog's sandbox packages to the line made for the same Effect first.

The weekly [Latest Effect](.github/workflows/latest-effect.yml) workflow checks the repository
against the newest Effect release the packages allow, and fails when one breaks them: the sign to
upgrade.

`@effect/tsgo` patches TypeScript with Effect's diagnostics. Its Oxlint integration does not support
the Oxlint version pinned here, so Effect's diagnostics run through TypeScript, and stock Oxlint runs
the type-aware lint rules. Check [the versions it supports](https://github.com/Effect-TS/tsgo#supported-package-versions)
before changing either pin.

## License

By contributing, you agree that your contributions are licensed under the
[MIT license](LICENSE).
