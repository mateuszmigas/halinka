import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { tempFolder, writeFiles } from "@halinka/utils/testing";
import { describe, expect, it } from "vitest";

import { copyExternalPackage, licensesOfBundle } from "./bundledPackages";

const packageJson = (name: string, fields: Record<string, unknown> = {}) =>
  JSON.stringify({ name, version: "1.0.0", license: "MIT", ...fields });

const setUp = async (files: Record<string, string>) => {
  const folder = await tempFolder();
  await writeFiles(folder, files);
  return folder;
};

describe("bundledPackages", () => {
  it("takes the license file of a bundled package", async () => {
    const folder = await setUp({
      "node_modules/a/package.json": packageJson("a"),
      "node_modules/a/LICENSE": "License of a",
    });

    const [license] = await licensesOfBundle(["node_modules/a/index.js"], folder);

    expect(license?.text).toBe("a@1.0.0 (MIT)\n\nLicense of a");
  });

  it("takes the committed license text of a package that ships none", async () => {
    const folder = await setUp({ "node_modules/pgpass/package.json": packageJson("pgpass") });

    const [license] = await licensesOfBundle(["node_modules/pgpass/lib/index.js"], folder);

    const committed = await readFile(
      join(import.meta.dirname, "third-party-licenses/pgpass.txt"),
      "utf8",
    );
    expect(license?.text).toContain(committed.trimEnd());
  });

  it("fails for a package with no license file and no committed text", async () => {
    const folder = await setUp({ "node_modules/a/package.json": packageJson("a") });

    const licenses = licensesOfBundle(["node_modules/a/index.js"], folder);

    await expect(licenses).rejects.toThrow("a ships no license file");
  });

  it("lists one license for each name and version", async () => {
    const folder = await setUp({
      "node_modules/a/package.json": packageJson("a"),
      "node_modules/a/LICENSE": "License of a",
      "node_modules/b/node_modules/a/package.json": packageJson("a"),
      "node_modules/b/node_modules/a/LICENSE": "License of a",
      "node_modules/c/node_modules/a/package.json": packageJson("a", { version: "2.0.0" }),
      "node_modules/c/node_modules/a/LICENSE": "License of a",
    });

    const licenses = await licensesOfBundle(
      [
        "node_modules/a/index.js",
        "node_modules/b/node_modules/a/index.js",
        "node_modules/c/node_modules/a/index.js",
      ],
      folder,
    );

    expect(licenses.map(({ id }) => id)).toEqual(["a@1.0.0", "a@2.0.0"]);
  });

  it("refuses to copy a package that has dependencies", async () => {
    const folder = await setUp({
      "a/package.json": packageJson("a", { dependencies: { b: "^1.0.0" } }),
    });

    const copy = copyExternalPackage(join(folder, "a"), join(folder, "copy"));

    await expect(copy).rejects.toThrow("a has dependencies");
  });

  it("refuses to copy a package that has optional dependencies", async () => {
    const folder = await setUp({
      "a/package.json": packageJson("a", { optionalDependencies: { b: "^1.0.0" } }),
    });

    const copy = copyExternalPackage(join(folder, "a"), join(folder, "copy"));

    await expect(copy).rejects.toThrow("a has dependencies");
  });

  it("copies the package without the node_modules that pnpm adds", async () => {
    const folder = await setUp({
      "a/package.json": packageJson("a"),
      "a/index.js": "",
      "a/node_modules/.bin/a": "",
    });

    await copyExternalPackage(join(folder, "a"), join(folder, "copy"));

    expect((await readdir(join(folder, "copy"))).toSorted()).toEqual(["index.js", "package.json"]);
  });
});
