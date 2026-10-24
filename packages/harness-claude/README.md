# @amends-dev/harness-claude

Claude Agent SDK as an [`@amends-dev/harness`](../harness) agent. Claude works inside a
sandbox behind the shared authenticated bridge. The host owns the sandbox and runs the tools it
supplies through the loopback MCP host-tool relay.

## Install and use

```sh
bun add @amends-dev/harness-claude @amends-dev/harness @amends-dev/sandbox effect
```

```ts
import { ClaudeAgent } from "@amends-dev/harness-claude"
import { Harness } from "@amends-dev/harness"
import { SessionId } from "@amends-dev/harness/Agent"
import { SandboxProvider } from "@amends-dev/sandbox"
import { Effect, Redacted } from "effect"

declare const apiKey: Redacted.Redacted<string>
declare const bridgeToken: ClaudeAgent.Options["token"]

const program = Effect.gen(function* () {
  const agent = yield* ClaudeAgent.make({
    model: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      protocol: "anthropic-messages",
      url: "https://api.anthropic.com/v1",
      apiKey
    },
    token: bridgeToken
  })
  const provider = yield* SandboxProvider.SandboxProvider
  const sandbox = yield* provider.create(agent.template === undefined ? {} : { template: agent.template })
  const session = yield* Harness.make(agent).createSession({ sandbox, id: SessionId.make("review") })
  const answer = yield* session.generate({ prompt: "Summarize README.md" })
  const state = yield* session.stop
  return { answer, state }
})
```

The Bun host supplies `Crypto` and `Socket.WebSocketConstructor`, as `BunServices.layer` and
`BunSocket.layerWebSocketConstructor` do. `token` must derive the same secret for a sandbox on every
host, for example an HMAC of its id. `make` bundles the bridge using Bun. A sandbox's template
installs Bun 1.3.14 and the native Claude executable from Claude Agent SDK 0.3.302 (Claude Code
2.1.302), checking npm's pinned SHA-512 integrity before extracting either executable. Supported
platforms are macOS and glibc Linux on arm64 and x64, with `curl`, `tar`, and `sha512sum` or `shasum`.
Installed programs and bridge bundles live under `~/.amends/claude`, outside session directories.
Preparation reuses complete installations and stages new downloads before renaming them into place.

## Models and configuration

`ClaudeAgent.Options` extends `Agent.Options` with `token` and optional `env`. Every turn selects
its explicit endpoint, including credentials, headers and model; unregistered model names fail.
Only `anthropic-messages` is supported. The endpoint URL must end in `/v1`; the adapter removes that
suffix because Claude adds `/v1/messages`. Custom proxy paths before `/v1` are preserved.

An explicit nonempty `apiKey` is required. Authless endpoints and implicit Claude subscription
credentials are unsupported. The bridge passes only its `HOME`, `PATH`, and `TMPDIR` plus explicit
`env` and model settings into Claude. Endpoint settings take precedence. Project/user settings and
external MCP discovery are disabled; the host manages provider routing. `HOME`, `CLAUDE_CONFIG_DIR`
and `CLAUDE_CODE_PROJECT_DIR_NAME` cannot be overridden because queries and the SDK's session
lookup/deletion APIs must address the same storage. The launcher clears those two Claude storage
overrides from its inherited environment as well. Credentials reach the sandbox and its tools;
host-tool credentials stay on the host.

`effort` maps to the SDK's `low`, `medium`, `high`, `xhigh` and `max` levels; `none` requests disabled
thinking. `minimal` fails with `UnsupportedError`. The chosen model may reject or constrain an
unsupported effort/thinking combination. `maxOutputTokens` sets `CLAUDE_CODE_MAX_OUTPUT_TOKENS`,
which Claude caps at the model's native maximum. `contextWindow` is catalog metadata: Claude owns
its native context capacity and compaction threshold; the adapter does not override them.

## Sessions and turns

Each turn owns one SDK query. A later query resumes the same native session. The adapter checks
native session availability when restoring saved state; if its transcript is gone, it starts a new
session and includes the portable history as labeled JSON context in the first prompt. Claude's
native transcript is not fabricated from another agent's records. The shared bridge retains
numbered parts and runs independently of a disconnected host, providing detach, suspend, reconnect,
stop and unfinished-turn recovery. Destroy removes the native transcript and subagent transcripts.

Text and thinking deltas, native tool calls/results, requested native approvals, SDK errors,
usage and step boundaries become harness parts. Nested subagent prose is not mixed into the main
answer; the parent tool call/result represents that work. Native tool results precede the step
boundary. The SDK's result usage reports the main agent loop; sidechain/subagent accounting is not
added to that usage. File-change hooks become file-change parts. Interrupting a turn interrupts and
closes its SDK query and resolves outstanding permission callbacks as denied.

Host tools are exposed as `mcp__host__<name>` and have at most 53 characters before the prefix. Their
provider echoes are suppressed: the shared relay emits the host call once and waits for the host's
result, including any host approval. Claude's own permission callbacks emit separate approval
requests that `session.approve` answers. `AskUserQuestion` is disabled because the harness has no
interactive question protocol.

Structured output uses the SDK's JSON Schema output format. Its final `structured_output` becomes
a separate last text step containing JSON, so `generateObject` decodes the actual structured
answer. A missing structured result fails. User prompts accept text, PNG/JPEG/GIF/WebP images and
PDFs, with binary/base64 or HTTP(S) data sources; other attachments fail before querying Claude.
Portable prior history is imported as JSON context rather than native messages.

Manual `compact(instructions)` sends `/compact` with those instructions, and returns the summary
from the SDK's `PostCompact` hook. Automatic compaction uses the same hook and emits its summary
between steps. A command that does not report a summary fails rather than emitting an empty
progress notification as a compaction.

## Verification

```sh
bun run test packages/harness-claude
```

Default tests exercise fake SDK queries, approvals, interruption, native resume/history fallback,
structured output, prompt conversion, model configuration, tool/usage translation and the real
host-tool relay. A subprocess integration bundles the production bridge and runs the real SDK
against a fake Claude stream-json executable over the actual local sandbox/WebSocket path; it
needs permission to listen on loopback, but no model key or external service.

The paid live test is opt-in and installs the pinned programs into a temporary home:

```sh
AMENDS_TEST_CLAUDE=1 ANTHROPIC_API_KEY=... bun run test packages/harness-claude/test/live.test.ts
```

`AMENDS_TEST_CLAUDE_MODEL` selects another Anthropic model (default `claude-sonnet-4-6`). This tests
an actual response, stop/resume, structured output and destruction. It is skipped without the gate;
fake protocol tests do not establish live-model behavior.

The implementation targets the [TypeScript SDK](https://code.claude.com/docs/en/agent-sdk/typescript),
[session API](https://code.claude.com/docs/en/agent-sdk/sessions),
[permissions API](https://code.claude.com/docs/en/agent-sdk/permissions), and
[documented environment settings](https://code.claude.com/docs/en/env-vars).
