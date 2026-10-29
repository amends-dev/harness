---
"@amends-dev/harness": patch
"@amends-dev/harness-amends": patch
"@amends-dev/harness-claude": patch
"@amends-dev/harness-codex": patch
"@amends-dev/harness-opencode": patch
---

Required Effect 4.0 (`~4.0.5`) rather than any Effect 4 release (`^4.0.5`). Effect 4.1.0 removed `effect/Crypto`, which these packages import, so a new project that installed them got 4.1.0 and could not load them.
