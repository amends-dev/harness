# @amends-dev/harness-opencode

## 0.2.2

### Patch Changes

- [#3](https://github.com/amends-dev/harness/pull/3) [`d2d26c5`](https://github.com/amends-dev/harness/commit/d2d26c5b7e476d52267cbc358c8f4181bd0ca705) Thanks [@saribmah](https://github.com/saribmah)! - Required Effect 4.0 (`~4.0.5`) rather than any Effect 4 release (`^4.0.5`). Effect 4.1.0 removed `effect/Crypto`, which these packages import, so a new project that installed them got 4.1.0 and could not load them.
- Updated dependencies [[`d2d26c5`](https://github.com/amends-dev/harness/commit/d2d26c5b7e476d52267cbc358c8f4181bd0ca705)]:
  - @amends-dev/harness@0.2.2

## 0.2.1

### Patch Changes

- [#1](https://github.com/amends-dev/harness/pull/1) [`8c1b63e`](https://github.com/amends-dev/harness/commit/8c1b63ed4f0f755b93c739ba91d1f55a973ffcc2) Thanks [@saribmah](https://github.com/saribmah)! - Moved to its own repository, [amends-dev/harness](https://github.com/amends-dev/harness), which its links on npm and its provenance now name.
- Updated dependencies [[`8c1b63e`](https://github.com/amends-dev/harness/commit/8c1b63ed4f0f755b93c739ba91d1f55a973ffcc2)]:
  - @amends-dev/harness@0.2.1

## 0.2.0

### Minor Changes

- [#39](https://github.com/amends-dev/amends/pull/39) [`634644b`](https://github.com/amends-dev/amends/commit/634644bc76bb17e0de41a042f8e102b877beac7d) Thanks [@saribmah](https://github.com/saribmah)! - Requires Effect 4.0.5 or later.

### Patch Changes

- [#39](https://github.com/amends-dev/amends/pull/39) [`634644b`](https://github.com/amends-dev/amends/commit/634644bc76bb17e0de41a042f8e102b877beac7d) Thanks [@saribmah](https://github.com/saribmah)! - `OpencodeAgent` streams a `file-change` part for each file of a patch from opencode's `apply_patch`, the tool opencode gives OpenAI's models in place of `write` and `edit`; a moved file is the file it removed and the one it created.

- [#39](https://github.com/amends-dev/amends/pull/39) [`634644b`](https://github.com/amends-dev/amends/commit/634644bc76bb17e0de41a042f8e102b877beac7d) Thanks [@saribmah](https://github.com/saribmah)! - Works on Effect 4.0.3 and later, which made `Crypto.randomUUIDv4` a function: 0.1.0 failed there with `randomUUIDv4.pipe is not a function`.
- Updated dependencies [[`634644b`](https://github.com/amends-dev/amends/commit/634644bc76bb17e0de41a042f8e102b877beac7d), [`634644b`](https://github.com/amends-dev/amends/commit/634644bc76bb17e0de41a042f8e102b877beac7d)]:
  - @amends-dev/harness@0.2.0
  - @amends-dev/sandbox@0.2.0
