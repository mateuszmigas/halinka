import { defineConfig } from "@playwright/test";

export default defineConfig({
  fullyParallel: true,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "cli", testDir: "./tests/cli" },
    { name: "pack", testDir: "./tests/pack" },
    { name: "image", testDir: "./tests/image" },
    { name: "portal-build", testDir: "./tests/portal", testMatch: "portal.setup.ts" },
    {
      name: "portal",
      testDir: "./tests/portal",
      dependencies: ["portal-build"],
      use: { screenshot: "only-on-failure" },
    },
  ],
});
