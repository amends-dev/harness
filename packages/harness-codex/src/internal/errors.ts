/** Errors at Codex's protocol boundary. */

import { HarnessError } from "@amends-dev/harness"

export const contractError = (description: string, cause?: unknown) =>
  new HarnessError.HarnessError({ agent: "codex", reason: new HarnessError.AgentContractError({ description }), cause })

export const unavailable = (description: string, cause?: unknown) =>
  new HarnessError.HarnessError({ agent: "codex", reason: new HarnessError.UnavailableError({ description }), cause })

export const unsupported = (description: string) =>
  new HarnessError.HarnessError({ agent: "codex", reason: new HarnessError.UnsupportedError({ description }) })
