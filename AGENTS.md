# Project guidance

Use Bun for dependency installation, scripts, and execution.
Use TypeScript 7 for type-checking, Oxlint for linting, and Oxfmt for formatting. Oxfmt formats as
Effect's dprint does: 120 columns, no semicolons, no trailing commas, and imports sorted. A
module's header is followed by a blank line, which keeps it first when the imports below it sort.
Run `bun run check` after changes and `bun run test` after changing behavior.
Tests use `@effect/vitest` through Vitest running on Bun. Use `it.effect` for Effect
programs, `it.live` only for integrations that need live clocks, and plain `it`
for synchronous assertions and Promise-based subprocess tests. Test helpers
return Effects; do not run them with `Effect.runPromise` or `Effect.runSync`.
Use `TestClock` and explicit concurrency signals, and scope acquired resources.
Use `bun run format` and `bun run lint:fix` to apply formatting and safe lint fixes.

`bun install` runs `effect-tsgo patch` and `lefthook install` through the `prepare`
script. This enables Effect diagnostics in the TypeScript compiler and workspace
language server, and installs the Git hooks. Before each commit, Lefthook runs
package declaration, generated-barrel, type, lint, and formatting checks in parallel
across the working tree.
The hook checks files without modifying or staging them. Fix failures before
committing; `bun run lefthook run pre-commit --force` runs the same checks manually,
even when no files are staged. CI runs these checks, the tests, and the distribution checks as
parallel jobs.
The `justfile` gives the package scripts as recipes, and `just github` applies
`stacks/github.ts`, an Alchemy stack of the repository's GitHub settings. `stacks/` has its own
manifest and lockfile, so Alchemy stays out of the root install and CI; `just github` typechecks
the stack before deploying it.
Keep these diagnostics enabled in `tsconfig.base.json`: the pinned Oxlint version is
newer than the versions supported by the Effect Oxlint patch, so Effect checks
currently run through TypeScript. Check compatibility before changing this setup.
`tsconfig.base.json` raises the language service's idiom rules, such as `Effect.void` over
`Effect.succeed(undefined)` or `Effect.catchTag` over a catch-all that re-fails, to warnings,
which fail `typecheck`; the few that only fit source, such as `deterministicKeys` for service
keys, are off in tests and scripts. `anyUnknownInErrorContext` keeps `unknown` and `any` out of
the packages' error channels. Source reaches the platform through Effect: `Config` rather than
`process.env`, the `Crypto` service rather than `crypto.randomUUID`, `Schema.is` rather than
`instanceof` on a schema class, and no `console` or timers; tests and scripts are exempt.
Converting a known time with `Date`, as Effect's own source does, is allowed; reading the clock
goes through `Clock` or `DateTime`.
`.oxlintrc.json` takes the rules of Effect's own Oxlint configuration
(`repos/effect/packages/tools/oxc/oxlintrc.json`), with its type-aware rules off as Effect
runs them, and keeps `console` to tests and scripts.

## Packages

Every package is published to npm, under `packages/`:

- `harness` is the contract every harness implements: an agent's sessions and turns, streamed in
  one format whichever agent runs them, and the bridge through which a host drives an agent inside
  a sandbox, with the relay through which that agent calls the host's tools. It depends on Effect
  and [`@amends-dev/sandbox`](https://github.com/amends-dev/sandbox) alone.
- `harness-amends` is amends's own agent, a loop over Effect AI's `LanguageModel` with the model
  providers' clients, in the host's process.
- `harness-opencode`, `harness-codex`, and `harness-claude` run opencode, Codex's app-server, and
  Claude Agent SDK behind the bridge in a sandbox. Each bundles its bridge program with `Bun.build`
  when its agent is made.

Each adapter depends on the contract, the sandbox contract, and its agent's own clients. The sandbox
packages come from npm through the catalog, as do the providers that tests run agents in. The live
suites need credentials or a real agent, so they run only when their package's README says to
enable them. [amends](https://github.com/amends-dev/amends) installs these packages from npm.

Each package has its own manifest, source exports, `tsconfig.json` extending `tsconfig.base.json`,
`tsconfig.build.json`, and `typecheck` script. Packages inherit no runtime-specific global types;
an adapter whose agent's clients or bridge need them opts in.
`tsconfig.base.json` takes Effect's strict flags: `exactOptionalPropertyTypes`, so an optional
field that may be given `undefined` says so as `readonly x?: X | undefined`; unused locals and
parameters; and erasable syntax only.
Root `tsconfig.json` checks repository scripts and the Vitest configuration; `bun run typecheck`
checks these and every package. Use declared package names for imports across packages, not
relative paths into another package.

Use the root Bun catalog for every external version, the sandbox packages among them, and
`workspace:^` for another package here,
which publishes as a caret range. Run `bun install` at the repository root after manifest changes.
`bun run check:packages` checks these declarations, that the contract depends on Effect and the
sandbox contract alone, and
that the packages share one line. A barrel, an `index.ts` marked `// @barrel`, is generated as
Effect's are: `bun run barrels` lists every module beside it, and `bun run check:barrels` fails
when one is out of date.

The packages release in lines with Changesets: they share a version's major and minor, so each
works with every other on its line, and a fix releases its own package alone. `bun run dist`
builds a package's distribution, what npm gets, and checks it as a consumer that installed it would.

## Design and review

Code is judged by how a newcomer reads it, not only by whether it works. Hold to these when
writing code, and when asked whether code is well structured:

- One word per concept in every layer. A second name for the same thing, or one name for two
  things, is a defect to fix.
- A layer, wrapper, or factory that only forwards is removed, not kept for symmetry with another.
- Small or closely related code goes into an existing package as a module or folder. Add a
  package only when dependency direction requires one, such as an agent's own clients, and say
  why.
- A flow reads top to bottom. Long work is a loop over named steps, and a decision is a pure
  function, separate from the code that performs it.
- Names say what things do, as [Effect](#effect) describes; names a letter apart that do
  different things, such as `expose` and `exposed`, are defects.
- When something needs a paragraph or a vocabulary table to explain, change the code so it does
  not.

When reviewing, first sketch how the part would look if built today from what it does, then list
how the current code differs. Walk its main flow as a newcomer and note every point that raises
"why is this here?". Guides and patterns already in the repository describe what exists; they are
not reasons to keep it.

## Documentation

The code is the source of truth. Each package's README describes its contract. Update affected
READMEs when changing commands, configuration, contracts, behavior, or test setup. Check claims
against implementation and tests; an agreed design or a passing round-trip test does not establish
an implemented feature or compatibility across dependency upgrades. Do not present a proposal as
current behavior. Check relative links and heading anchors after moving or renaming documentation.
`CLAUDE.md` is a symlink to this file; keep one guidance source.

## Effect

This project uses stable Effect v4. The root `package.json` workspace
catalog and `bun.lock` define the installed versions; keep Effect dependencies and the vendored source
on the same release when upgrading.

Before writing Effect code, read `repos/effect/LLMS.md`, then inspect the relevant
implementation, examples, and tests in `repos/effect`. Use this matching source
to verify APIs rather than guessing from prior versions or web snippets.

- Core modules and tests: `repos/effect/packages/effect/src` and
  `repos/effect/packages/effect/test`.
- Usage examples: `repos/effect/ai-docs/src`.
- Bun integration: `repos/effect/packages/platform/bun`.

Source imports Effect by module, `import * as Effect from "effect/Effect"`, as Effect's packages
do; tests, scripts, and documentation examples may use the `effect` barrel.

Tell which variant a tagged value is with the helpers its type gives, never by comparing `_tag`:
`X.isAnyOf(["A"])` for a value of a schema's tagged union, which checks the tag alone, and `X.match`
for a case per variant, or `Match.valueTags` when the cases return different types; `$is` and
`$match` for a `Data.TaggedEnum`; and the guards Effect's modules give their own types, such as
`Option.isSome`, `Exit.isSuccess`, and `ChildProcess.isPipedCommand`. A union's `guards` validate
the whole value, so keep them for input of unknown shape. Recover from one reason of an error with
`Effect.catchReason`. An error's reasons are `Schema.TaggedError` classes that say `isRetryable` and
give a default message, in a union piped through `Schema.toTaggedUnion("_tag")`, as
`HarnessError` shows. Reading `_tag` as data, such as the kind a record stores, is fine.

Build a variant in source with its constructor, `Union.cases.Member.make({ memberId })`, which
checks it as decoding would and throws when it does not hold. A value that something else checks
stays a literal, such as an agent's event before its decoder. Tests may write the values they
expect as literals.

Name a variable that holds a service after the service, so a call says who it calls:
`const sandboxProvider = yield* SandboxProvider.SandboxProvider`, and
`(session) => session.stop` for a callback given one. Effect's platform services keep the names
Effect gives them, such as `fs` and `spawner`. Name a function for what it does, so a reader needn't
open it: `findBridge`, `readUnfinishedTurn`, `collectDenyingApprovals`, not a bare word such as `begin`, `opening`, or
`load`.

## Vendored repositories

`repos/` contains upstream Git subtrees for reference. Treat their contents as
read-only unless explicitly asked to update them. Their own build commands and
contributor instructions apply to upstream development, not this repository.

Import code from installed packages such as `effect` and `@effect/platform-bun`, never from
`repos/`. Keep vendored repositories out of type-checking, test discovery, formatting, and linting.
When adding those tools, scope them to the packages and scripts.
