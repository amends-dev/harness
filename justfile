# The repository's commands. Each runs a package script, which is what CI runs, except `github`,
# which applies the repository's GitHub settings from stacks/github.ts.

# List the recipes
[private]
default:
    @just --list --unsorted

# Install the dependencies
install:
    bun install

# Check package declarations, barrels, types, lint, and formatting
check:
    bun run check

# Run every test suite, or those under the paths given
test *paths:
    bun run test {{ paths }}

# Format, and apply lint's safe fixes
fix:
    bun run format
    bun run lint:fix

# Build every package as npm gets it, and check it as a consumer would
dist:
    bun run dist check

# Describe a change to the packages for their next release
changeset:
    bun changeset

# Install Alchemy, which stacks/ keeps apart from the packages
[private]
stacks:
    bun install --cwd stacks --frozen-lockfile

# Run Alchemy's CLI
alchemy *args: stacks
    bun stacks/node_modules/.bin/alchemy {{ args }}

# Apply the repository's GitHub settings, stacks/github.ts, with the Alchemy profile given
github profile="admin": stacks
    bun run tsc -p stacks
    bun stacks/node_modules/.bin/alchemy deploy --config stacks/github.ts --profile {{ profile }}
