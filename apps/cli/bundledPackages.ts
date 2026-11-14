import { cp, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { isFile } from "@halinka/utils/fs";

type License = { name: string; id: string; text: string };

type PackageJson = {
  name: string;
  version: string;
  license?: string;
  licenses?: { type: string }[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

// The last `node_modules` of a path holds its package: a nested version sits below its parent.
const packageFolderPattern = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//;

const licenseFilePattern = /^(licen[cs]e|copying|notice)/i;

const fallbackLicensesFolder = join(import.meta.dirname, "third-party-licenses");

const packageJsonOf = async (folder: string): Promise<PackageJson> =>
  JSON.parse(await readFile(join(folder, "package.json"), "utf8"));

const licenseFilesOf = async (folder: string, name: string) => {
  const entries = await readdir(folder, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && licenseFilePattern.test(entry.name))
    .map((entry) => join(folder, entry.name))
    .toSorted();
  if (files.length > 0) return files;
  const fallback = join(fallbackLicensesFolder, `${name.replace("/", "__")}.txt`);
  if (await isFile(fallback)) return [fallback];
  throw new Error(
    `${name} ships no license file. Add its license text to apps/cli/third-party-licenses/.`,
  );
};

const licenseOf = async (folder: string): Promise<License> => {
  const { name, version, license, licenses } = await packageJsonOf(folder);
  const id = `${name}@${version}`;
  const kind = license ?? licenses?.map(({ type }) => type).join(" OR ");
  const files = await licenseFilesOf(folder, name);
  const texts = await Promise.all(
    files.map(async (file) => (await readFile(file, "utf8")).trimEnd()),
  );
  return { name, id, text: [`${id} (${kind})`, ...texts].join("\n\n") };
};

// `inputs`: the input paths of the esbuild metafile, relative to `workingFolder`.
export const licensesOfBundle = async (inputs: string[], workingFolder: string) => {
  const folders = new Set(inputs.flatMap((input) => packageFolderPattern.exec(input)?.[1] ?? []));
  const licenses = await Promise.all(
    [...folders].map((folder) => licenseOf(join(workingFolder, folder))),
  );
  return [...new Map(licenses.map((license) => [license.id, license])).values()].toSorted((a, b) =>
    a.id.localeCompare(b.id),
  );
};

// The copy holds no dependency of the package, so the package must have none.
export const copyExternalPackage = async (from: string, to: string) => {
  const { name, dependencies = {}, optionalDependencies = {} } = await packageJsonOf(from);
  if (Object.keys({ ...dependencies, ...optionalDependencies }).length > 0) {
    throw new Error(`${name} has dependencies. Copy them to dist/node_modules too, or bundle it.`);
  }
  await cp(from, to, {
    recursive: true,
    dereference: true,
    // pnpm adds a `node_modules/.bin` with paths of this machine.
    filter: (source) => relative(from, source) !== "node_modules",
  });
};
