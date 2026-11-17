import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { licensesOfBundle } from "./licenses";
import { packageJsonText, tempFolderWith } from "./testing";

const licensesIn = (folder: string, bundledFiles: string[]) =>
  licensesOfBundle(bundledFiles, folder, join(folder, "fallback"));

describe("licensesOfBundle", () => {
  it("takes the license file of a bundled package", async () => {
    const folder = await tempFolderWith({
      "node_modules/a/package.json": packageJsonText("a"),
      "node_modules/a/LICENSE": "License of a",
    });

    const [license] = await licensesIn(folder, ["node_modules/a/index.js"]);

    expect(license?.text).toBe("a@1.0.0 (MIT)\n\nLicense of a");
  });

  it("takes the ThirdPartyNotices file of a bundled package", async () => {
    const folder = await tempFolderWith({
      "node_modules/a/package.json": packageJsonText("a"),
      "node_modules/a/ThirdPartyNotices.txt": "Notices of a",
    });

    const [license] = await licensesIn(folder, ["node_modules/a/index.js"]);

    expect(license?.text).toBe("a@1.0.0 (MIT)\n\nNotices of a");
  });

  it("takes the license text of the fallback folder for a package that ships none", async () => {
    const folder = await tempFolderWith({
      "node_modules/@a/b/package.json": packageJsonText("@a/b"),
      "fallback/@a__b.txt": "License of @a/b\n",
    });

    const [license] = await licensesIn(folder, ["node_modules/@a/b/lib/index.js"]);

    expect(license?.text).toBe("@a/b@1.0.0 (MIT)\n\nLicense of @a/b");
  });

  it("takes an absolute path of a bundled file", async () => {
    const folder = await tempFolderWith({
      "node_modules/a/package.json": packageJsonText("a"),
      "node_modules/a/LICENSE": "License of a",
    });

    const licenses = await licensesOfBundle(
      [join(folder, "node_modules/a/index.js")],
      "/",
      join(folder, "fallback"),
    );

    expect(licenses.map(({ id }) => id)).toEqual(["a@1.0.0"]);
  });

  it("fails for a package with no license file and no fallback text", async () => {
    const folder = await tempFolderWith({ "node_modules/a/package.json": packageJsonText("a") });

    const licenses = licensesIn(folder, ["node_modules/a/index.js"]);

    await expect(licenses).rejects.toThrow("a ships no license file");
  });

  it("lists one license for each name and version", async () => {
    const folder = await tempFolderWith({
      "node_modules/a/package.json": packageJsonText("a"),
      "node_modules/a/LICENSE": "License of a",
      "node_modules/b/node_modules/a/package.json": packageJsonText("a"),
      "node_modules/b/node_modules/a/LICENSE": "License of a",
      "node_modules/c/node_modules/a/package.json": packageJsonText("a", { version: "2.0.0" }),
      "node_modules/c/node_modules/a/LICENSE": "License of a",
    });

    const licenses = await licensesIn(folder, [
      "node_modules/a/index.js",
      "node_modules/b/node_modules/a/index.js",
      "node_modules/c/node_modules/a/index.js",
    ]);

    expect(licenses.map(({ id }) => id)).toEqual(["a@1.0.0", "a@2.0.0"]);
  });
});
