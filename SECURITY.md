# Security policy

## Reporting a vulnerability

Report a vulnerability privately, through GitHub: on the repository's **Security** tab, choose
**Report a vulnerability**. Do not open a public issue or pull request for it.

Say what is affected, such as a package and its version, how to reproduce it, and what an attacker
could do with it. We will confirm we received it, keep you told as we investigate and fix it, and
publish a security advisory once a fix is released, crediting you if you would like.

## Supported versions

These packages are in early development. Fixes go into `main` and the next release of each
package; earlier releases do not receive them.

## Scope

Reports are welcome for every package in this repository: above all, a way for an agent in a
sandbox to reach the host beyond its session's tools, to run a tool its turn did not offer, or to
run one that needs approval without it.

Some behavior is by design, and is not a vulnerability:

- **Agents use their own tools without asking.** amends's agent reads, writes, edits, and runs
  commands in its sandbox unasked, and opencode, Codex, and Claude ask only about what their own
  permission settings say to ask.
- **A sandbox isolates as much as its provider does.** A local sandbox isolates nothing; give agents
  that run code you would not run yourself a sandbox that isolates them, such as Daytona's.

A vulnerability in Effect, an agent, a model provider's client, or another dependency belongs with
that project. Tell us too when it affects these packages in a way of its own.

## Running agents

- An agent in a sandbox is configured with the model endpoints it is made with, their keys among
  them, so code that runs in its sandbox can read those keys. Give it keys you would trust it with,
  such as ones limited to what it spends.
- Give agents sandboxes that isolate them when they run code you would not run on your own machine.
