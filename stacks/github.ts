/**
 * What the repository's release workflow needs, as GitHub settings and an Actions secret:
 *
 * - The `npm` environment, which only main may use and which npm trusts to publish the packages,
 *   and in it the token that opens the release pull request. The workflow's own token cannot be
 *   used, since a pull request it opens starts no CI.
 * - A ruleset that lets main change only through pull requests whose checks pass, since what
 *   reaches main is what the packages publish.
 *
 * The release token is a fine-grained personal access token for this repository, with read and
 * write access to contents and pull requests, which this run reads as `RELEASE_GITHUB_TOKEN` from
 * the environment or the repository's `.env`. Deploy it with an Alchemy profile whose GitHub login
 * is the gh CLI and whose Cloudflare login keeps the stack's state, and deploy it again to rotate
 * the token or change the settings:
 *
 *   just alchemy profile create admin
 *   just github
 *
 * Each package's trusted publisher, which names this repository, `release.yml`, and the `npm`
 * environment, is set on npm.
 */

import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as GitHub from "alchemy/GitHub"
import { Config, Effect } from "effect"

const repository = { owner: "amends-dev", repository: "harness" }

export default Alchemy.Stack(
  "harness-github",
  {
    providers: GitHub.providers(),
    state: Cloudflare.state()
  },
  Effect.gen(function* () {
    const npmEnvironment = yield* GitHub.Environment("NpmEnvironment", {
      ...repository,
      name: "npm",
      deploymentBranchPolicy: { customBranchPolicies: ["main"] }
    })
    yield* GitHub.Secret("ReleaseGitHubToken", {
      ...repository,
      name: "RELEASE_GITHUB_TOKEN",
      environment: npmEnvironment,
      value: yield* Config.Redacted("RELEASE_GITHUB_TOKEN")
    })

    yield* GitHub.Ruleset("MainRuleset", {
      ...repository,
      name: "main",
      target: "branch",
      enforcement: "active",
      conditions: { include: ["~DEFAULT_BRANCH"] },
      // Administrators may merge a pull request whose checks fail, as when CI itself is broken.
      bypassActors: [{ actorType: "RepositoryRole", actorId: 5, bypassMode: "pull_request" }],
      rules: {
        requiredStatusChecks: { checks: [{ context: "Check" }] },
        nonFastForward: true,
        deletion: true
      }
    })
  })
)
