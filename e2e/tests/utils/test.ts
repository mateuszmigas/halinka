import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test as base } from "@playwright/test";

import { TestHalinka } from "./testHalinka";

export const test = base.extend<{ halinka: TestHalinka }>({
  halinka: async ({}, use) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "halinka-e2e-")));
    const halinka = new TestHalinka(root);
    await use(halinka);
    await halinka.dispose();
  },
});
