import type { ModelEndpoint } from "@amends-dev/harness"
import { describe, expect, it } from "@effect/vitest"
import { Redacted, Result } from "effect"
import { modelsOf } from "../src/internal/models.ts"

const key = Redacted.make("secret-key")

const sonnet = {
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  protocol: "anthropic-messages",
  url: "https://api.anthropic.com/v1",
  apiKey: key
} satisfies ModelEndpoint.ModelEndpoint

const gpt = {
  provider: "openai",
  model: "gpt-5.6",
  protocol: "openai-responses",
  url: "https://api.openai.com/v1/",
  apiKey: Redacted.make("other-key"),
  effort: "xhigh"
} satisfies ModelEndpoint.ModelEndpoint

const gptOss = {
  provider: "openrouter",
  model: "openai/gpt-oss-120b",
  protocol: "openai-chat",
  url: "https://openrouter.ai/api/v1",
  effort: "low",
  maxOutputTokens: 8000,
  contextWindow: 131_072
} satisfies ModelEndpoint.ModelEndpoint

/** Why opencode cannot serve `endpoints`, or nothing when it can. */
const refusalOf = (endpoints: Parameters<typeof modelsOf>[1]) => {
  const models = modelsOf(1, endpoints)
  return Result.isFailure(models) ? models.failure : undefined
}

describe("modelsOf", () => {
  it("names each endpoint's model, and its effort as a variant of it", () => {
    const models = Result.getOrThrow(modelsOf(1, { model: sonnet, models: { deep: gpt, open: gptOss } }))

    expect(models.model).toEqual({ providerID: "anthropic", id: "claude-sonnet-5-5" })
    expect(models.models).toEqual({
      deep: { providerID: "openai", id: "gpt-5.6", variant: "amends-xhigh" },
      open: { providerID: "openrouter", id: "openai/gpt-oss-120b", variant: "amends-low" }
    })
  })

  it("configures opencode 1's providers to serve each model through its protocol, at its URL, with its key", () => {
    const models = Result.getOrThrow(modelsOf(1, { model: sonnet, models: { deep: gpt, open: gptOss } }))

    expect(models.config).toEqual({
      provider: {
        anthropic: {
          options: { apiKey: "secret-key" },
          models: {
            "claude-sonnet-5-5": {
              provider: { npm: "@ai-sdk/anthropic", api: "https://api.anthropic.com/v1" }
            }
          }
        },
        openai: {
          options: { apiKey: "other-key" },
          models: {
            "gpt-5.6": {
              provider: { npm: "@ai-sdk/openai", api: "https://api.openai.com/v1" },
              variants: { "amends-xhigh": { reasoningEffort: "xhigh" } }
            }
          }
        },
        openrouter: {
          models: {
            "openai/gpt-oss-120b": {
              provider: {
                npm: "@ai-sdk/openai-compatible",
                api: "https://openrouter.ai/api/v1"
              },
              limit: { context: 131_072, output: 8000 },
              variants: { "amends-low": { reasoningEffort: "low" } }
            }
          }
        }
      }
    })
    expect(models.env).toEqual({})
  })

  it("configures opencode 2's providers to serve each model through its protocol, at its URL, with its key", () => {
    const models = Result.getOrThrow(modelsOf(2, { model: sonnet, models: { deep: gpt, open: gptOss } }))

    expect(models.config).toEqual({
      providers: {
        anthropic: {
          settings: { apiKey: "secret-key" },
          models: {
            "claude-sonnet-5-5": {
              package: "@ai-sdk/anthropic",
              settings: { baseURL: "https://api.anthropic.com/v1" }
            }
          }
        },
        openai: {
          settings: { apiKey: "other-key" },
          models: {
            "gpt-5.6": {
              package: "@ai-sdk/openai",
              settings: { baseURL: "https://api.openai.com/v1" },
              variants: [{ id: "amends-xhigh", settings: { reasoningEffort: "xhigh" } }]
            }
          }
        },
        openrouter: {
          models: {
            "openai/gpt-oss-120b": {
              package: "@ai-sdk/openai-compatible",
              settings: { baseURL: "https://openrouter.ai/api/v1" },
              limit: { output: 8000, context: 131_072 },
              variants: [{ id: "amends-low", settings: { reasoningEffort: "low" } }]
            }
          }
        }
      }
    })
    expect(models.env).toEqual({})
  })

  it("gives opencode 2 a model's limits apart, each over what models.dev says", () => {
    const { contextWindow: _, ...withoutWindow } = gptOss
    const models = Result.getOrThrow(
      modelsOf(2, {
        model: withoutWindow,
        models: { large: { ...sonnet, contextWindow: 200_000 } }
      })
    )

    expect(models.config).toMatchObject({
      providers: {
        openrouter: { models: { "openai/gpt-oss-120b": { limit: { output: 8000 } } } },
        anthropic: { models: { "claude-sonnet-5-5": { limit: { context: 200_000 } } } }
      }
    })
  })

  it("asks a model on the Messages API for an effort as each opencode takes it", () => {
    const endpoints = { model: { ...sonnet, effort: "max" }, models: {} } as const
    const opencode1 = Result.getOrThrow(modelsOf(1, endpoints))
    const opencode2 = Result.getOrThrow(modelsOf(2, endpoints))

    expect(opencode1.config).toMatchObject({
      provider: {
        anthropic: {
          models: { "claude-sonnet-5-5": { variants: { "amends-max": { effort: "max" } } } }
        }
      }
    })
    expect(opencode2.config).toMatchObject({
      providers: {
        anthropic: {
          models: {
            "claude-sonnet-5-5": { variants: [{ id: "amends-max", settings: { effort: "max" } }] }
          }
        }
      }
    })
    expect(opencode1.model.variant).toBe("amends-max")
  })

  it("names one model at several efforts as variants of it", () => {
    const models = Result.getOrThrow(
      modelsOf(1, {
        model: sonnet,
        models: {
          quick: { ...sonnet, effort: "low" },
          deep: { ...sonnet, effort: "high" },
          deeper: { ...sonnet, effort: "high" }
        }
      })
    )

    expect(models.config).toMatchObject({
      provider: {
        anthropic: {
          models: {
            "claude-sonnet-5-5": {
              variants: { "amends-low": { effort: "low" }, "amends-high": { effort: "high" } }
            }
          }
        }
      }
    })
    expect(models.model).toEqual({ providerID: "anthropic", id: "claude-sonnet-5-5" })
    expect(models.models["quick"]?.variant).toBe("amends-low")
    expect(models.models["deep"]).toEqual(models.models["deeper"])
  })

  it("gives opencode 1 a model's limits together, the context window unknown without one", () => {
    const { contextWindow: _, ...unknownWindow } = gptOss
    const models = Result.getOrThrow(
      modelsOf(1, {
        model: unknownWindow,
        models: { large: { ...sonnet, contextWindow: 200_000 } }
      })
    )

    expect(models.config).toMatchObject({
      provider: {
        openrouter: { models: { "openai/gpt-oss-120b": { limit: { context: 0, output: 8000 } } } }
      }
    })
    // Without an output limit, opencode knows the model's limits from models.dev.
    expect(models.config).not.toHaveProperty(["provider", "anthropic", "models", "claude-sonnet-5-5", "limit"])
  })

  it("raises the most tokens opencode 1 writes in a response to the highest output limit", () => {
    const opencode1 = Result.getOrThrow(
      modelsOf(1, {
        model: { ...sonnet, maxOutputTokens: 64_000 },
        models: { open: gptOss }
      })
    )
    const opencode2 = Result.getOrThrow(modelsOf(2, { model: { ...sonnet, maxOutputTokens: 64_000 }, models: {} }))

    expect(opencode1.env).toEqual({ OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "64000" })
    expect(opencode2.env).toEqual({})
  })

  it("serves the models of one provider at URLs of their own, under its key", () => {
    const models = Result.getOrThrow(
      modelsOf(1, {
        model: sonnet,
        models: {
          gateway: { ...sonnet, model: "claude-opus-5-5", url: "https://gateway.example/v1" }
        }
      })
    )

    expect(models.config).toMatchObject({
      provider: {
        anthropic: {
          options: { apiKey: "secret-key" },
          models: {
            "claude-sonnet-5-5": { provider: { api: "https://api.anthropic.com/v1" } },
            "claude-opus-5-5": { provider: { api: "https://gateway.example/v1" } }
          }
        }
      }
    })
  })

  it("sends a provider's requests with the headers its endpoints ask for", () => {
    const headers = { "cf-aig-authorization": Redacted.make("Bearer gateway-token") }
    const endpoints = { model: { ...sonnet, headers }, models: { other: { ...gptOss, headers } } }
    const opencode1 = Result.getOrThrow(modelsOf(1, endpoints))
    const opencode2 = Result.getOrThrow(modelsOf(2, endpoints))

    expect(opencode1.config).toMatchObject({
      provider: {
        anthropic: {
          options: {
            apiKey: "secret-key",
            headers: { "cf-aig-authorization": "Bearer gateway-token" }
          }
        },
        openrouter: { options: { headers: { "cf-aig-authorization": "Bearer gateway-token" } } }
      }
    })
    expect(opencode1.config).not.toHaveProperty(["provider", "openrouter", "options", "apiKey"])
    expect(opencode2.config).toMatchObject({
      providers: {
        anthropic: {
          settings: { apiKey: "secret-key" },
          headers: { "cf-aig-authorization": "Bearer gateway-token" }
        },
        openrouter: { headers: { "cf-aig-authorization": "Bearer gateway-token" } }
      }
    })
    expect(opencode2.config).not.toHaveProperty(["providers", "openrouter", "settings"])
  })

  it("refuses endpoints of one provider with different keys or headers", () => {
    const differences = [
      { apiKey: Redacted.make("another") },
      { headers: { "x-title": Redacted.make("amends") } }
    ] as const

    const refusals = differences.map((difference) =>
      refusalOf({
        model: sonnet,
        models: { other: { ...sonnet, model: "claude-opus-5-5", ...difference } }
      })
    )

    for (const refused of refusals) {
      expect(refused).toMatchObject({
        _tag: "UnsupportedError",
        description:
          "opencode presents one key, with one set of headers, for each provider, and the endpoints for anthropic differ in them"
      })
    }
  })

  it("refuses endpoints of one model that it is served differently for", () => {
    const differences = [
      { url: "https://gateway.example/v1" },
      { protocol: "openai-chat" },
      { maxOutputTokens: 4096 },
      { contextWindow: 100_000 }
    ] as const

    const refusals = differences.map((difference) =>
      refusalOf({ model: sonnet, models: { other: { ...sonnet, ...difference } } })
    )

    for (const refused of refusals) {
      expect(refused).toMatchObject({
        _tag: "UnsupportedError",
        description:
          "opencode serves a model through one protocol, at one URL, within one output limit and context window, and the endpoints for anthropic/claude-sonnet-5-5 differ in them"
      })
    }
  })

  it("takes a URL that ends in a slash as the one without it", () => {
    const models = Result.getOrThrow(
      modelsOf(1, {
        model: sonnet,
        models: { slashed: { ...sonnet, url: "https://api.anthropic.com/v1/" } }
      })
    )

    expect(models.models["slashed"]).toEqual(models.model)
  })
})
