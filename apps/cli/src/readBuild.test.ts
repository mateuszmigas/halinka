import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { readBuild } from "./readBuild";

describe("readBuild", () => {
  it("gives the id source to code that runs from source", async () => {
    const { version } = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );

    expect(await readBuild()).toEqual({ version, id: "source" });
  });
});
