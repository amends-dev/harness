---
"@amends-dev/harness-amends": patch
---

Redacted the credentials of a failed request in a turn's `error` part. Effect keeps a request's `authorization` and `x-api-key` headers as `Redacted` values, and encoding the `AiError` as JSON revealed them, so a failed turn on a bearer token streamed the token.
