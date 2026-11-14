import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { build } from "esbuild";
import { describe, expect, it } from "vitest";

import { licensesOfBundle } from "./bundledPackages";
import { bundleOptions } from "./bundleOptions";

const { inputs, outputs } = (await build({ ...bundleOptions, write: false })).metafile;

const staticChunksOf = (output: string, seen = new Set<string>()): string[] => {
  if (seen.has(output)) return [];
  seen.add(output);
  return [
    output,
    ...(outputs[output]?.imports ?? [])
      .filter(({ kind, external }) => kind !== "dynamic-import" && !external)
      .flatMap(({ path }) => staticChunksOf(path, seen)),
  ];
};

const npmPackageOf = (specifier: string) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");

const bundledPackagesOf = (inputPaths: string[]) =>
  inputPaths
    .filter((input) => input.includes("node_modules/"))
    .map((input) =>
      npmPackageOf(input.slice(input.lastIndexOf("node_modules/") + "node_modules/".length)),
    );

const packagesFolder = join(import.meta.dirname, "../../packages");

const workspaceRanges = [
  ...readdirSync(packagesFolder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => join(packagesFolder, name, "package.json")),
  join(import.meta.dirname, "package.json"),
].flatMap((path) => {
  const { dependencies = {}, devDependencies = {} } = JSON.parse(readFileSync(path, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return Object.entries({ ...dependencies, ...devDependencies }).filter(
    ([, range]) => !range.startsWith("workspace:"),
  );
});

describe("the bundle", () => {
  // So the bundle holds one version of each npm package that our code imports.
  it("uses one version range of each npm package in the workspace", () => {
    const rangesOf = Map.groupBy(workspaceRanges, ([name]) => name);

    const different = [...rangesOf].filter(
      ([, ranges]) => new Set(ranges.map(([, range]) => range)).size > 1,
    );

    expect(different).toEqual([]);
  });

  // ssh starts this command at each connection.
  it("loads no database, auth or SSH server package for halinka ssh", () => {
    const ssh = Object.keys(outputs).find((output) => /\/ssh-[^/]+\.js$/.test(output))!;

    const loaded = staticChunksOf(ssh).flatMap((chunk) => [
      ...bundledPackagesOf(Object.keys(outputs[chunk]?.inputs ?? {})),
      ...(outputs[chunk]?.imports ?? [])
        .filter(({ external, kind }) => external && kind === "import-statement")
        .map(({ path }) => npmPackageOf(path)),
    ]);

    const heavy = ["@electric-sql/pglite", "better-auth", "drizzle-orm", "hono", "pg", "ssh2"];
    expect(loaded).toContain("ws");
    expect(loaded.filter((name) => heavy.includes(name))).toEqual([]);
  });

  it("finds a license text for each bundled npm package", async () => {
    const bundled = new Set(bundledPackagesOf(Object.keys(inputs)));

    const licenses = await licensesOfBundle(Object.keys(inputs), import.meta.dirname);

    expect(new Set(licenses.map(({ name }) => name))).toEqual(bundled);
  });
});
