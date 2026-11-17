// Node loads this file for the Vite config, so it imports only `node:` modules.
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

type License = { name: string; id: string; text: string };

type PackageJson = {
  name: string;
  version: string;
  license?: string;
  licenses?: { type: string }[];
};

// The last `node_modules` of a path holds its package: a nested version sits below its parent.
const packageFolderPattern = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//;

const licenseFilePattern = /^(licen[cs]e|copying|notice|thirdpartynotices)/i;

const licenseFilesOf = async (folder: string, name: string, fallbackFolder: string) => {
  const entries = await readdir(folder, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && licenseFilePattern.test(entry.name))
    .map((entry) => join(folder, entry.name))
    .toSorted();
  if (files.length > 0) return files;
  const fallback = join(fallbackFolder, `${name.replace("/", "__")}.txt`);
  if ((await stat(fallback).catch(() => undefined))?.isFile()) return [fallback];
  throw new Error(`${name} ships no license file. Add its license text to ${fallbackFolder}.`);
};

const licenseOf = async (folder: string, fallbackFolder: string): Promise<License> => {
  const { name, version, license, licenses }: PackageJson = JSON.parse(
    await readFile(join(folder, "package.json"), "utf8"),
  );
  const id = `${name}@${version}`;
  const kind = license ?? licenses?.map(({ type }) => type).join(" OR ");
  const files = await licenseFilesOf(folder, name, fallbackFolder);
  const texts = await Promise.all(
    files.map(async (file) => (await readFile(file, "utf8")).trimEnd()),
  );
  return { name, id, text: [`${id} (${kind})`, ...texts].join("\n\n") };
};

// `fallbackLicensesFolder`: the license texts of packages that ship none.
export const licensesOfBundle = async (
  bundledFiles: string[],
  workingFolder: string,
  fallbackLicensesFolder: string,
) => {
  const folders = new Set(
    bundledFiles.flatMap((file) => packageFolderPattern.exec(file)?.[1] ?? []),
  );
  const licenses = await Promise.all(
    [...folders].map((folder) => licenseOf(resolve(workingFolder, folder), fallbackLicensesFolder)),
  );
  return [...new Map(licenses.map((license) => [license.id, license])).values()].toSorted((a, b) =>
    a.id.localeCompare(b.id),
  );
};

// MIT, BSD and Apache-2.0 need their notices in each copy of the code.
export const thirdPartyLicensesText = (licenses: License[]) =>
  `${licenses.map(({ text }) => text).join("\n\n---\n\n")}\n`;
