import { chmod, cp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { build } from "esbuild";

import { buildIdOf } from "./buildId";
import { bundleOptions } from "./bundleOptions";

const distFolder = join(import.meta.dirname, "dist");

const repoFolder = join(import.meta.dirname, "../..");

const fromRepo = (path: string) => join(repoFolder, path);

// A runner installs the npm packages with npm, by the ranges of package.json, not by the lockfile.
const listBuildFiles = async () => {
  const entries = await readdir(distFolder, { recursive: true, withFileTypes: true });
  const distFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(repoFolder, join(entry.parentPath, entry.name)));
  return [...distFiles, "apps/cli/package.json"];
};

const writeBuildId = async () => {
  const paths = await listBuildFiles();
  const files = await Promise.all(
    paths.map(async (path) => ({ path, content: await readFile(fromRepo(path)) })),
  );
  await writeFile(join(distFolder, "build.json"), JSON.stringify({ id: buildIdOf(files) }));
};

const runtimeFiles = [
  ["packages/server/src/db/migrations", "migrations"],
  ["packages/sandbox/src/egressProxy.mjs", "egressProxy.mjs"],
  ["packages/agents/src/fileReportChannel/reportResultServer.mjs", "reportResultServer.mjs"],
  ["apps/portal/dist", "portal"],
] as const;

await rm(distFolder, { recursive: true, force: true });
await build(bundleOptions);
await Promise.all(
  runtimeFiles.map(([from, to]) => cp(fromRepo(from), join(distFolder, to), { recursive: true })),
);
await chmod(join(distFolder, "main.js"), 0o755);
await writeBuildId();
