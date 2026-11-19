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

const licenseFilesOf = async (folder: string, name: string, addedFolder: string) => {
  const entries = await readdir(folder, { withFileTypes: true });
  const shipped = entries
    .filter((entry) => entry.isFile() && licenseFilePattern.test(entry.name))
    .map((entry) => join(folder, entry.name))
    .toSorted();
  const added = join(addedFolder, `${name.replace("/", "__")}.txt`);
  const isAdded = (await stat(added).catch(() => undefined))?.isFile();
  const files = isAdded ? [...shipped, added] : shipped;
  if (files.length > 0) return files;
  throw new Error(`${name} ships no license file. Add its license text to ${addedFolder}.`);
};

const licenseOf = async (folder: string, addedFolder: string): Promise<License> => {
  const { name, version, license, licenses }: PackageJson = JSON.parse(
    await readFile(join(folder, "package.json"), "utf8"),
  );
  const id = `${name}@${version}`;
  const kind = license ?? licenses?.map(({ type }) => type).join(" OR ");
  const files = await licenseFilesOf(folder, name, addedFolder);
  const texts = await Promise.all(
    files.map(async (file) => (await readFile(file, "utf8")).trimEnd()),
  );
  return { name, id, text: [`${id} (${kind})`, ...texts].join("\n\n") };
};

// `addedLicensesFolder`: `<name>.txt` adds to the license files of a package, or replaces them when it ships none.
export const licensesOfBundle = async (
  bundledFiles: string[],
  workingFolder: string,
  addedLicensesFolder: string,
) => {
  const folders = new Set(
    bundledFiles.flatMap((file) => packageFolderPattern.exec(file)?.[1] ?? []),
  );
  const licenses = await Promise.all(
    [...folders].map((folder) => licenseOf(resolve(workingFolder, folder), addedLicensesFolder)),
  );
  return [...new Map(licenses.map((license) => [license.id, license])).values()].toSorted((a, b) =>
    a.id.localeCompare(b.id),
  );
};

// MIT, BSD and Apache-2.0 need their notices in each copy of the code.
export const thirdPartyLicensesText = (licenses: License[]) =>
  `${licenses.map(({ text }) => text).join("\n\n---\n\n")}\n`;
