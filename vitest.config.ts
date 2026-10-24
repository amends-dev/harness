import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Separate processes preserve Bun's native server APIs.
    pool: "forks",
    maxWorkers: 4,
    environment: "node",
    // Tests own fresh sandboxes and scoped resources; reuse workers and their module cache.
    isolate: false,
    // Bridge tests start servers and wait on processes; the 5 s default is too tight on CI.
    testTimeout: 20_000,
    include: ["packages/*/test/**/*.test.ts"]
  }
})
