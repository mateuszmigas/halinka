import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { packageJsonText, tempFolderWith } from "@halinka/utils/testing";
import { describe, expect, it } from "vitest";

import { copyExternalPackage } from "./bundledPackages";

describe("bundledPackages", () => {
  it("refuses to copy a package that has dependencies", async () => {
    const folder = await tempFolderWith({
      "a/package.json": packageJsonText("a", { dependencies: { b: "^1.0.0" } }),
    });

    const copy = copyExternalPackage(join(folder, "a"), join(folder, "copy"));

    await expect(copy).rejects.toThrow("a has dependencies");
  });

  it("refuses to copy a package that has optional dependencies", async () => {
    const folder = await tempFolderWith({
      "a/package.json": packageJsonText("a", { optionalDependencies: { b: "^1.0.0" } }),
    });

    const copy = copyExternalPackage(join(folder, "a"), join(folder, "copy"));

    await expect(copy).rejects.toThrow("a has dependencies");
  });

  it("copies the package without the node_modules that pnpm adds", async () => {
    const folder = await tempFolderWith({
      "a/package.json": packageJsonText("a"),
      "a/index.js": "",
      "a/node_modules/.bin/a": "",
    });

    await copyExternalPackage(join(folder, "a"), join(folder, "copy"));

    expect((await readdir(join(folder, "copy"))).toSorted()).toEqual(["index.js", "package.json"]);
  });
});
