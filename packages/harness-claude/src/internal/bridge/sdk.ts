/** The SDK operations the driver uses; tests supply the same narrow boundary. */

import * as Claude from "@anthropic-ai/claude-agent-sdk"

export interface Query extends AsyncIterable<Claude.SDKMessage> {
  readonly interrupt: () => Promise<unknown>
  readonly close: () => void
}
export interface Sdk {
  readonly query: (params: { prompt: string | AsyncIterable<Claude.SDKUserMessage>; options: Claude.Options }) => Query
  readonly hasSession: (id: string, directory: string) => Promise<boolean>
  readonly deleteSession: (id: string, directory: string) => Promise<void>
}
export const sdk: Sdk = {
  query: Claude.query,
  hasSession: async (id, dir) => (await Claude.getSessionInfo(id, { dir })) !== undefined,
  deleteSession: (id, dir) => Claude.deleteSession(id, { dir })
}
