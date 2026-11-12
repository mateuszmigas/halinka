import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { build } from "esbuild";
import { describe, expect, it } from "vitest";

import { bundleOptions } from "./bundleOptions";
import packageJson from "./package.json" with { type: "json" };

const { outputs } = (await build({ ...bundleOptions, write: false })).metafile;

const externalsOf = (output: string, seen = new Set<string>()): string[] => {
  if (seen.has(output)) return [];
  seen.add(output);
  return (outputs[output]?.imports ?? [])
    .filter(({ kind }) => kind !== "dynamic-import")
    .flatMap(({ external, path }) => (external ? [path] : externalsOf(path, seen)));
};

const npmPackageOf = (specifier: string) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");

const packagesFolder = join(import.meta.dirname, "../../packages");

const workspaceDependencies = readdirSync(packagesFolder).flatMap((name) => {
  const { dependencies = {} } = JSON.parse(
    readFileSync(join(packagesFolder, name, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  return Object.entries(dependencies);
});

describe("the bundle", () => {
  it("publishes the version range that the workspace packages use", () => {
    const published: Record<string, string> = packageJson.dependencies;

    const different = workspaceDependencies.filter(
      ([name, range]) => Object.hasOwn(published, name) && published[name] !== range,
    );

    expect(different).toEqual([]);
  });

  it("has a dependency for each npm package that it imports", () => {
    const imported = Object.values(outputs)
      .flatMap(({ imports }) => imports)
      .filter(({ external, path }) => external && !path.startsWith("node:"))
      .map(({ path }) => npmPackageOf(path));

    expect(imported.filter((name) => !Object.hasOwn(packageJson.dependencies, name))).toEqual([]);
  });

  // ssh starts this command at each connection.
  it("loads no database, auth or SSH server package for halinka ssh", () => {
    const ssh = Object.keys(outputs).find((output) => /\/ssh-[^/]+\.js$/.test(output))!;

    const loaded = externalsOf(ssh).map(npmPackageOf);

    const heavy = ["@electric-sql/pglite", "better-auth", "drizzle-orm", "hono", "pg", "ssh2"];
    expect(loaded).toContain("ws");
    expect(loaded.filter((name) => heavy.includes(name))).toEqual([]);
  });
});
