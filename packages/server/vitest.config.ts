import { defineConfig } from "vitest/config";

// PGlite opens slowly at high machine load.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    unstubGlobals: true,
    unstubEnvs: true,
    restoreMocks: true,
  },
});
