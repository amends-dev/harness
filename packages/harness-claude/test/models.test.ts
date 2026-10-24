import { expect, it } from "@effect/vitest"
import { Redacted, Result } from "effect"
import { modelsOf } from "../src/internal/models.ts"

const endpoint = {
  apiKey: Redacted.make("test-key"),
  provider: "anthropic",
  model: "claude-test",
  protocol: "anthropic-messages" as const,
  url: "https://example.test/proxy/v1///"
}
it("configures each endpoint with its own key, headers, output limit, and reasoning", () => {
  const models = Result.getOrThrow(
    modelsOf({
      model: {
        ...endpoint,
        apiKey: Redacted.make("secret"),
        headers: { "X-Tenant": Redacted.make("one") },
        effort: "none",
        maxOutputTokens: 8000,
        contextWindow: 200000
      },
      models: { deep: { ...endpoint, effort: "high" } }
    })
  )
  expect(models.model).toMatchObject({
    model: "claude-test",
    thinking: "disabled",
    env: {
      ANTHROPIC_BASE_URL: "https://example.test/proxy",
      ANTHROPIC_API_KEY: "secret",
      ANTHROPIC_CUSTOM_HEADERS: "X-Tenant: one",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000"
    }
  })
  expect(models.models.deep?.effort).toBe("high")
  expect(models.models.deep?.env.ANTHROPIC_API_KEY).toBe("test-key")
})
it("rejects unsupported protocols, efforts, paths and header injection", () => {
  for (const model of [
    { ...endpoint, protocol: "openai-responses" as const },
    { ...endpoint, effort: "minimal" as const },
    { ...endpoint, apiKey: Redacted.make("") },
    { ...endpoint, url: "https://example.test/messages" },
    { ...endpoint, headers: { Authorization: Redacted.make("secret\nX-Other: value") } }
  ]) {
    expect(Result.isFailure(modelsOf({ model }))).toBe(true)
  }
})
