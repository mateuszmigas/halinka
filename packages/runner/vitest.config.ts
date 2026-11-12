import { defineConfig } from "vitest/config";

// The tests start processes and git, which run slowly at high machine load.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 30_000, restoreMocks: true, unstubEnvs: true },
});
