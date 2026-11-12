import { execFileSync } from "node:child_process";

import { test as setup } from "@playwright/test";

setup("builds the portal", () => {
  setup.setTimeout(180_000);
  execFileSync("pnpm", ["turbo", "build", "--filter=@halinka/portal"], { stdio: "inherit" });
});
