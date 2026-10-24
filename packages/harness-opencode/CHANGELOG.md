# @amends-dev/harness-opencode

## 0.2.0

### Minor Changes

- [#39](https://github.com/amends-dev/amends/pull/39) [`634644b`](https://github.com/amends-dev/amends/commit/634644bc76bb17e0de41a042f8e102b877beac7d) Thanks [@saribmah](https://github.com/saribmah)! - Requires Effect 4.0.5 or later.

### Patch Changes

- [#39](https://github.com/amends-dev/amends/pull/39) [`634644b`](https://github.com/amends-dev/amends/commit/634644bc76bb17e0de41a042f8e102b877beac7d) Thanks [@saribmah](https://github.com/saribmah)! - `OpencodeAgent` streams a `file-change` part for each file of a patch from opencode's `apply_patch`, the tool opencode gives OpenAI's models in place of `write` and `edit`; a moved file is the file it removed and the one it created.

- [#39](https://github.com/amends-dev/amends/pull/39) [`634644b`](https://github.com/amends-dev/amends/commit/634644bc76bb17e0de41a042f8e102b877beac7d) Thanks [@saribmah](https://github.com/saribmah)! - Works on Effect 4.0.3 and later, which made `Crypto.randomUUIDv4` a function: 0.1.0 failed there with `randomUUIDv4.pipe is not a function`.
- Updated dependencies [[`634644b`](https://github.com/amends-dev/amends/commit/634644bc76bb17e0de41a042f8e102b877beac7d), [`634644b`](https://github.com/amends-dev/amends/commit/634644bc76bb17e0de41a042f8e102b877beac7d)]:
  - @amends-dev/harness@0.2.0
  - @amends-dev/sandbox@0.2.0
