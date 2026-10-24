# harness

Runs agents for [Effect](https://effect.website), and streams every agent's turns in one format, so
your code does not depend on which agent works for it. It is to agents what Effect AI is to model
providers. An agent runs in your own process or in a
[sandbox](https://github.com/amends-dev/sandbox), behind a bridge the host drives it through.

| Package                                                     | What it is                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------- |
| [`@amends-dev/harness`](packages/harness)                   | The contract every agent's adapter implements, and the bridge |
| [`@amends-dev/harness-amends`](packages/harness-amends)     | amends's own agent, a loop over an Effect AI language model   |
| [`@amends-dev/harness-opencode`](packages/harness-opencode) | opencode, behind the bridge in a sandbox                      |
| [`@amends-dev/harness-codex`](packages/harness-codex)       | Codex's app-server, behind the bridge in a sandbox            |
| [`@amends-dev/harness-claude`](packages/harness-claude)     | Claude Agent SDK, behind the bridge in a sandbox              |

```sh
bun add @amends-dev/harness @amends-dev/harness-opencode @amends-dev/sandbox @amends-dev/sandbox-local effect
```

The [contract's guide](packages/harness/README.md) shows a session run in a sandbox, how a session
runs the host's tools, and how to [write an adapter](packages/harness/README.md#writing-an-adapter).
A session takes the toolkit that [`@amends-dev/toolkit`](https://github.com/amends-dev/toolkit)
assembles.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers setting up, the checks every change passes, and
releases. Report a vulnerability as [SECURITY.md](SECURITY.md) describes.

## License

[MIT](LICENSE)
