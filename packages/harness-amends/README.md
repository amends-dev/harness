# @amends-dev/harness-amends

An agent in your own process for the [`@amends-dev/harness`](../harness) contract: a
loop over an Effect AI `LanguageModel`, with the model providers' clients, that runs where your
program runs. Each step streams the model's response while Effect AI runs the tools the model calls,
and a turn takes steps until the model answers without calling one. In a sandbox the agent works
with its own tools for files and the shell; without one it answers from its model alone, calling
only your tools. It is the agent to run when nothing is to be installed in the sandbox, and the
reference for what the contract asks of an agent in the host's process.

## Install

```sh
bun add @amends-dev/harness-amends @amends-dev/harness effect
```

The package brings Effect AI's clients for Anthropic's Messages API, OpenAI's Responses API, and
Chat Completions APIs, and needs an `HttpClient` for their requests, such as
`FetchHttpClient.layer`.

## Quick start

`AmendsAgent.make` makes the agent on a model endpoint, and `Harness.make` runs it. The agent makes
a language model of each endpoint with `Models.LanguageModels`, which `Models.layer` provides over
the `HttpClient` the requests go out through.

```ts
import { AmendsAgent, Models } from "@amends-dev/harness-amends"
import { Agent, Harness } from "@amends-dev/harness"
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"

const program = Effect.gen(function* () {
  const agent = yield* AmendsAgent.make({
    model: {
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      protocol: "anthropic-messages",
      url: "https://api.anthropic.com/v1",
      apiKey: yield* Config.Redacted("ANTHROPIC_API_KEY"),
      contextWindow: 200_000
    }
  })
  const harness = Harness.make(agent)
  const session = yield* harness.createSession({ id: Agent.SessionId.make("hello") })
  const answer = yield* session.generate({ prompt: "Say hello in one word." })
  return answer.text
}).pipe(Effect.provide(Models.layer.pipe(Layer.provide(FetchHttpClient.layer))))
```

The agent needs no sandbox and installs nothing in one. Given a sandbox, as `createSession`'s
`sandbox`, it works in the session's directory there with the tools in [Tools](#tools).
[`@amends-dev/harness`](../harness/README.md) says how sessions, turns, host tools, and
releasing a session work, which this agent does as any agent does.

## Models

A `ModelEndpoint` names a model and how to reach it, and `Models` makes an Effect AI language model
of each: a client for the endpoint's protocol, Anthropic Messages through `@effect/ai-anthropic`,
OpenAI Responses through `@effect/ai-openai`, or Chat Completions through
`@effect/ai-openai-compat`, at the endpoint's URL, which is the base the protocol's paths follow,
such as `https://api.anthropic.com/v1`, presenting its key and the headers it asks for; and the
endpoint's model on that client, asked for the endpoint's effort and output limit as the protocol
takes them. A turn runs on the agent's default endpoint, or on the named one it names.

A Chat Completions API that answers with a `service_tier` of null, as OpenRouter does, is read
without it: Effect's client refuses an answer that has one, and would lose the usage OpenRouter
streams in its last chunk.

## Tools

In a sandbox, the agent offers the model `read`, `write`, `edit`, and `bash`, named and taking
their inputs as Claude Code's and opencode's tools do, so a model meets the tools it knows whichever
agent runs it. `read` returns a file's `limit` lines from line `offset`, the first 2,000 by default,
saying how many follow; `edit` replaces a text where it appears once, or everywhere with
`replace_all`; searching goes through `bash`, with `grep` and `find`. File paths resolve against the
session's directory, and the tools refuse a path that names a place outside it, reading the path
alone, not where a symbolic link in it leads. `bash` runs `sh -c` in the directory, answers with the
exit code and the output, stdout and stderr interleaved, keeps the first and last 15,000 characters
of long output, and kills a command that outruns `commandTimeout`, 2 minutes by default. A tool that
cannot do what it was asked, such as an `edit` whose text is not in the file, answers the model with
why, so the model can try again. That keeps the model's work in its directory but confines nothing:
`bash` reaches anything the sandbox can.

The host's tools reach the model through stand-ins, which answer each call with the result the
host submits, and carry the tool's JSON schema as the host gave it; the session, which runs the
host's tool, checks the call's params. A provider sends that JSON schema as it is, without the
changes its strict mode needs, so a stand-in is strict only when the host's tool sets `Tool.Strict`
to `true`, and such a tool's schema must be one the provider takes in strict mode, such as
Anthropic's, which needs `additionalProperties: false` on every object. A host's tool named as
one of the agent's own fails the turn with `UnsupportedError`. `Tools.toolkit` and
`Tools.layer` give the tools to a program of your own.

## Turns

`maxSteps` ends a turn after that many steps even while the model calls tools; by default a turn
takes as many as the model needs. A turn asking for JSON ends with a step in which the model
answers the conversation so far, without tools, with the JSON the schema describes, through Effect
AI's `generateObject`; the session decodes the answer. A model's failure ends the turn with an
`error` part holding the `AiError` as JSON, and a `finish` whose reason is `error`. The headers and
URL parameters Effect redacts, such as `authorization` and `x-api-key`, read `<redacted>` there.

Before each step, once the conversation fills 80% of the model's context window, the agent
compacts it: the model summarizes all but the latest messages, which the conversation keeps as
they were, up to half the window, from a prompt or a step before which every tool call has its
result. The compaction streams as a `compaction` part. `compact` summarizes the whole
conversation, between turns. An endpoint that does not give its `contextWindow` is compacted only
on request.

The agent keeps nothing of its own between turns: a session resumed on any host goes on from the
conversation the session recorded, tool calls and results included. A turn does not outlive the
process running it: `suspendTurn` returns the steps of the turn it cut short, and `continueTurn`
goes on from those the session has, running the step in flight again.

## Errors

The agent's operations fail with `HarnessError`, naming the agent `amends`: `UnsupportedError` for
a turn that names a model the agent has none of, a host's tool named as one of the agent's, or an
approval, which the agent never asks for; `AgentContractError` for state it cannot read; and
`UnknownError` when the model fails to summarize the conversation.

## Development

Run the package's tests with `bun run test packages/harness-amends`: the agent over scripted
models, the tools in a sandbox on this machine, and the models' requests against a client that
answers as each API does; with `AMENDS_TEST_MODELS=1` and `OPENROUTER_API_KEY`, the live tests
reach real APIs. `bun run dist check packages/harness-amends`
builds the package as npm gets it and checks it as a consumer.
