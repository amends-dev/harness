---
"@amends-dev/harness-amends": patch
---

Offered a host's tool to the model as strict only when the host sets `Tool.Strict` to `true`. A provider sends a stand-in's JSON schema without the changes its strict mode needs, so Anthropic refused every turn whose host tools did not opt out of strict mode, with `'additionalProperties: true' is not supported`.
