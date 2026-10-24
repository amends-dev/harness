/** Failures at the Claude SDK boundary. */

import { HarnessError } from "@amends-dev/harness"

export const unavailable = (cause: unknown) =>
  new HarnessError.HarnessError({
    agent: "claude",
    cause,
    reason: new HarnessError.UnavailableError({ description: "Claude Agent SDK failed" })
  })

export const unsupported = (description: string) =>
  new HarnessError.HarnessError({
    agent: "claude",
    reason: new HarnessError.UnsupportedError({ description })
  })

export const invalid = (description: string) =>
  new HarnessError.HarnessError({
    agent: "claude",
    reason: new HarnessError.AgentContractError({ description })
  })
