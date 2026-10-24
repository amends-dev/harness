# Codex harness

`@amends-dev/harness-codex` runs Codex app-server in a sandbox behind the shared harness
bridge. It follows the same host, template, bridge, and tool relay boundaries as the
opencode adapter. Hosts run on Bun because `CodexAgent.make` bundles the bridge with
`Bun.build`.

```ts
import { CodexAgent } from "@amends-dev/harness-codex"
import { Harness } from "@amends-dev/harness"
import { Config, Effect, Redacted } from "effect"
import type { Sandbox } from "@amends-dev/sandbox"

declare const bridgeToken: (id: Sandbox.SandboxId) => Redacted.Redacted<string>

const makeHarness = Effect.gen(function* () {
  const agent = yield* CodexAgent.make({
    model: {
      provider: "openai",
      model: "gpt-5.4",
      protocol: "openai-responses",
      url: "https://api.openai.com/v1",
      apiKey: yield* Config.Redacted("OPENAI_API_KEY")
    },
    token: bridgeToken
  })
  return Harness.make(agent)
})
```

Provide `Crypto` and `Socket.WebSocketConstructor`, as with the opencode adapter.
The WebSocket constructor must support authorization headers. Hosts should derive the
bridge token from the sandbox id using a shared secret. Prepare a sandbox with
`agent.template`, then call the harness's `createSession` with that sandbox.

## Installation and lifecycle

The template installs **Codex 0.157.1** and **Bun 1.3.14** into a version-addressed
`~/.amends/codex` directory. Downloads come from platform npm packages, checked against
pinned SHA-512 integrity before extraction. Codex's companion executables and resources
remain together. The bridge bundle is addressed by its contents. Existing installations
are reused and new ones are staged before publication.

Supported installation targets are macOS and glibc Linux, on arm64 and x64. Installation
needs `curl`, `tar`, and either `sha512sum` or `shasum`. The host itself does not need Codex
installed. The sandbox provides the isolation for native tools; turns use Codex's
`externalSandbox` policy with network enabled.

Each session has its own app-server process and `CODEX_HOME` inside the bridge state
directory, outside the working directory. Unchanged turn settings reuse that process.
Changing a model endpoint, instructions, or tool catalog restarts the process and resumes
the persisted thread, so cached tools and provider configuration cannot leak into the next
turn. This also ends any native background terminal processes in that app-server.

The state records the native thread id. Codex history survives stop and resume while the
sandbox's files remain. If the thread is gone, the supplied portable conversation is
imported with `thread/inject_items`, preserving messages, tool calls, and tool outcomes.
An empty thread receives one neutral developer message before its id is returned, because
Codex does not persist an untouched thread. Destroy archives and deletes the native thread.

BridgeServer owns turn persistence, reconnection, and continuation after host loss. The
adapter interrupts native turns when their streams are interrupted, and scopes child
processes to sessions. RPC requests time out after 60 seconds. Native process/protocol
failure terminates pending requests and streams with typed errors.

## Models, tools, and output

Only `openai-responses` endpoints are supported. Each endpoint gets its own provider
configuration, with its base URL, key, headers, effort, and context window. Named endpoints
can differ in credentials and provider. Endpoint keys are placed in the child environment;
provider headers and the relay token are in the session's private configuration file.
As with other sandboxed harnesses, code running in the sandbox can read those credentials.
`config` accepts additional Codex configuration using dotted keys, and `env` supplies
additional child environment variables. Adapter-owned model and relay settings take
precedence. TOML cannot represent `null`, which is rejected explicitly.

Host tools use the shared loopback `HostToolRelay`. Their permissions remain with the host
harness; Codex's approval mode for these relay tools delegates to that host. Native command
and file approval requests are streamed and answered through the harness's approval API.
Unanswered user-question forms receive an empty answer and MCP elicitations are declined,
since the harness has no general interactive-question contract.

Text, reasoning, native tool calls/results, file changes, usage, and terminal errors stream
in the harness format. Completed text snapshots are not duplicated after deltas. Step boundaries keep interim commentary and completed tool work separate from the final
answer. Step usage follows Codex's response usage notifications; a boundary without such
a notification leaves that step's usage unknown. The turn reports aggregate usage. Host MCP events are not emitted twice. Prompts support text and
image attachments, and JSON responses use app-server's `outputSchema`.

## Limitations and verification

- Chat Completions and Anthropic Messages endpoints are rejected.
- `maxOutputTokens` is rejected: this app-server version has no configurable response token
  cap. Context window and reasoning effort are supported.
- Manual compaction is rejected: app-server exposes completion of compaction, but does not
  return the summary required by the harness contract. Codex can compact automatically;
  its native thread keeps that compacted history while portable harness history remains
  the full recorded conversation.
- Non-image attachments and assistant attachments in imported history are rejected. Private
  model reasoning and approval bookkeeping are omitted when importing portable history.
- Image generation, native subagent conversations, and other specialized Codex capabilities
  are not fully represented in the common output format.

Run the adapter tests with:

```sh
bun run --bun vitest run packages/harness-codex/test
```

The normal tests use scripted app-server subprocesses, a real MCP relay, and the real
bridge inside a local sandbox. They cover framing, errors/timeouts, prompt/history
translation, usage, tools, approvals, cancellation, model changes, persistence, destruction,
and template integrity checks.

An optional native protocol test requires **Codex 0.157.1 on PATH**:

```sh
AMENDS_TEST_CODEX_NATIVE=1 bun run --bun vitest run packages/harness-codex/test/native.test.ts
```

It runs native inference against a scripted local Responses endpoint, imports and resumes
history, executes a real MCP tool roundtrip, and deletes the native thread. It makes no
external model requests and needs no API key. No paid provider end-to-end run is claimed.

Protocol references: [Codex app-server](https://learn.chatgpt.com/docs/app-server) and
[Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference).
The pinned CLI's `app-server generate-ts --experimental` output was used to verify the
wire shapes implemented here.
